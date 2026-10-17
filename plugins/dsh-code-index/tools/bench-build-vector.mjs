/**
 * 向量创建速度对照：**同一批块、同一份模型**，只换算力位置（本机 GPU / 本机 CPU / 远端 GPU）。
 *
 * 为什么不是"各建一遍索引再比耗时"：那样会把扫描、切块、SQLite 写入、缓存命中全混进来，
 * 得到的差值无法归因。这里先建 **纯 FTS5 索引**（秒级，不嵌向量）拿到与生产完全一致的块，
 * 再把这些块的正文按各档后端算一遍，只计"算向量"的时间。
 *
 * 用法：
 *   node tools/bench-build-vector.mjs --repo D:/oss/elasticsearch --n 6000 \
 *        --model-dir D:/dsh-models/bge-base-zh-v1.5 --deps-dir D:/dsh-code-index/embed-deps \
 *        --remote https://dsh-embed.taek.site --tag bge-base-zh-v1.5-c4fa1e57-fp16 \
 *        --arms local-gpu,remote --batch-local 8 --batch-remote 16
 *
 * 关键细节：
 *  - **每档用独立的一次性缓存**：本机与远端向量标签相同，共用缓存会让第二档全命中，
 *    测出来是 0.1 ms/块（这个坑在本项目里已经踩过一次）。
 *  - **用 bodyForEmbedding() 截断**：与 indexer 真实送进模型的文本逐字节一致。
 *  - 远端另报**服务端自报的计算耗时**，与客户端实测相减≈网络+传输。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Store } from '../lib/store.js'
import { buildIndex, indexDbPath } from '../lib/indexer.js'
import { bodyForEmbedding } from '../lib/chunker.js'
import { createEmbedder } from '../lib/embedder.js'
import { createRemoteEmbedder, describeStatus } from '../lib/remote.js'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const repoRoot = path.resolve(arg('--repo', ''))
const n = Number(arg('--n', '6000'))
const modelDir = arg('--model-dir', 'D:/dsh-models/bge-base-zh-v1.5')
const cpuModelDir = arg('--cpu-model-dir', 'D:/dsh-models/fp16only/bge-base-zh-v1.5')
const depsDir = arg('--deps-dir', 'D:/dsh-code-index/embed-deps')
const indexBase = arg('--index-base', 'D:/dsh-bench-tmp/index-oss')
const tmp = arg('--tmp', 'D:/dsh-bench-tmp')
const remoteUrl = arg('--remote', '')
const remoteTag = arg('--tag', null)
const arms = String(arg('--arms', 'local-gpu,remote')).split(',').map((s) => s.trim()).filter(Boolean)
const batchLocal = Number(arg('--batch-local', '8'))
const batchCpu = Number(arg('--batch-cpu', '16'))
const batchRemote = Number(arg('--batch-remote', '16'))

if (!repoRoot || !fs.existsSync(repoRoot)) {
  console.error('请用 --repo 指定仓库')
  process.exit(1)
}
fs.mkdirSync(tmp, { recursive: true })

const r2 = (v) => Number(v.toFixed(2))

// ---------------------------------------------------------------- 1. 纯 FTS5 索引（拿块）
fs.mkdirSync(indexBase, { recursive: true })
const dbPath = indexDbPath(repoRoot, { indexDirBase: indexBase })
const store = Store.open(dbPath)
const before = store.stats()
if (before.chunks === 0) {
  console.log(`建 FTS5 索引（不嵌向量）：${repoRoot}`)
  const t0 = Date.now()
  const r = await buildIndex({
    store,
    repoRoot,
    opts: { windowLines: 40, maxFileBytes: 2 * 1024 * 1024, excludeDirs: [], excludePaths: [] },
    embedder: { ok: false, reason: '本次只建关键词索引' },
    budget: { maxEmbedPerRun: 0, mode: 'incremental' },
    chunking: { strategy: 'auto', byExt: {}, windowLines: 40 },
    depsDir,
    depsFallbackDirs: [],
  })
  console.log(`  扫描 ${r.scanned} 文件 → ${r.stats.chunks} 块，用时 ${((Date.now() - t0) / 1000).toFixed(1)} s（切块分布：${JSON.stringify(r.strategies)}）`)
} else {
  console.log(`复用已有索引：${before.chunks} 块`)
}

const total = store.stats().chunks
const take = Math.min(n, total)
const chunks = store.chunksWithoutVectors(take)
if (!chunks.length) {
  console.error('库里没有可用的块')
  process.exit(1)
}
const texts = chunks.map((c) => bodyForEmbedding(c.body))
const totalChars = texts.reduce((s, t) => s + t.length, 0)
console.log(`本轮取 ${texts.length} 块（全库 ${total} 块），正文合计 ${(totalChars / 1048576).toFixed(1)} MB，平均 ${Math.round(totalChars / texts.length)} 字符/块`)

// ---------------------------------------------------------------- 2. 各档跑一遍
const results = []

async function runArm(label, embedder, { batch, loadMs, extra = {} }) {
  // 预热：第一次调用含 session/连接建立
  await embedder.embed(texts.slice(0, Math.min(batch, texts.length)), { isQuery: false, useCache: false })
  const batches = []
  const t0 = performance.now()
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch)
    const tb = performance.now()
    await embedder.embed(slice, { isQuery: false, useCache: false })
    batches.push(performance.now() - tb)
    if (batches.length % 25 === 0) {
      const done = Math.min(i + batch, texts.length)
      const rate = done / ((performance.now() - t0) / 1000)
      process.stdout.write(`  ${label}: ${done}/${texts.length} 块，${rate.toFixed(1)} 块/s\n`)
    }
  }
  const totalMs = performance.now() - t0
  const sorted = batches.slice().sort((a, b) => a - b)
  const arm = {
    label,
    ok: true,
    batch,
    chunks: texts.length,
    totalMs: Math.round(totalMs),
    chunksPerSec: r2((texts.length / totalMs) * 1000),
    perChunkMs: r2(totalMs / texts.length),
    batchP50: r2(sorted[Math.floor(sorted.length / 2)]),
    loadMs: Math.round(loadMs ?? 0),
    ...extra,
  }
  results.push(arm)
  return arm
}

for (const arm of arms) {
  if (arm === 'local-gpu' || arm === 'local-cpu') {
    const backend = arm === 'local-gpu' ? 'auto' : 'cpu'
    const dir = arm === 'local-gpu' ? modelDir : cpuModelDir
    const t0 = Date.now()
    const emb = await createEmbedder({
      modelDir: dir,
      backend,
      depsDir,
      depsFallbackDirs: [],
      cachePath: path.join(tmp, `bench-build-${arm}-${Date.now()}.db`),
      log: () => {},
    })
    const loadMs = Date.now() - t0
    if (!emb.ok) {
      results.push({ label: arm, ok: false, error: emb.reason })
      continue
    }
    await runArm(`${arm} (${emb.backend}/${emb.modelFile})`, emb, { batch: arm === 'local-gpu' ? batchLocal : batchCpu, loadMs })
    if (store.getMeta('embedding_tag') && store.getMeta('embedding_tag') !== emb.modelTag) {
      console.log(`  ⚠️ 标签不一致：索引 ${store.getMeta('embedding_tag')} vs 本档 ${emb.modelTag}`)
    }
  } else if (arm === 'remote') {
    if (!remoteUrl) {
      results.push({ label: 'remote', ok: false, error: '未给 --remote' })
      continue
    }
    const t0 = Date.now()
    const emb = await createRemoteEmbedder({
      url: remoteUrl,
      tag: remoteTag,
      fallbackLocal: false,
      cachePath: path.join(tmp, `bench-build-remote-${Date.now()}.db`),
      log: () => {},
    })
    const loadMs = Date.now() - t0
    if (!emb.ok) {
      results.push({ label: 'remote', ok: false, error: emb.reason })
      continue
    }
    console.log(`  远端：${emb.remote.url}（${describeStatus(emb.remote.status)}），标签来源=${emb.remote.tagSource}，tag=${emb.modelTag}`)
    const preCalls = emb.remote.calls
    const preServer = emb.remote.serverMs ?? 0
    const armRes = await runArm(`remote (${describeStatus(emb.remote.status)})`, emb, {
      batch: batchRemote,
      loadMs,
      extra: { url: emb.remote.url, providers: emb.remote.providers, tag: emb.modelTag, tagSource: emb.remote.tagSource },
    })
    const calls = emb.remote.calls - preCalls
    const serverMs = (emb.remote.serverMs ?? 0) - preServer
    armRes.serverMs = Math.round(serverMs)
    armRes.networkMs = Math.round(armRes.totalMs - serverMs)
    armRes.httpCalls = calls
  }
}

// ---------------------------------------------------------------- 3. 报告
const lines = []
lines.push('')
lines.push('════════ 向量创建速度对照 ════════')
lines.push(`仓库：${repoRoot}`)
lines.push(`全库 ${total} 块；本轮样本 ${texts.length} 块；模型 ${path.basename(modelDir)}`)
lines.push('')
lines.push('档位                                 批次   块/秒    每块 ms   批次 p50   总耗时      加载')
for (const r of results) {
  if (!r.ok) {
    lines.push(`${r.label.padEnd(36)} 失败：${r.error}`)
    continue
  }
  lines.push(
    `${r.label.padEnd(36)} ${String(r.batch).padEnd(6)} ${String(r.chunksPerSec).padEnd(8)} ${String(r.perChunkMs).padEnd(10)} ` +
      `${String(r.batchP50 + ' ms').padEnd(10)} ${String((r.totalMs / 1000).toFixed(0) + ' s').padEnd(11)} ${r.loadMs} ms`,
  )
  if (r.serverMs !== undefined) {
    lines.push(`     └ 服务端自报计算 ${r.serverMs} ms，客户端总耗时 ${r.totalMs} ms → 网络/传输约 ${r.networkMs} ms（${r.httpCalls} 次 HTTP）`)
  }
}
const okArms = results.filter((r) => r.ok)
if (okArms.length > 1) {
  const best = okArms.slice().sort((a, b) => b.chunksPerSec - a.chunksPerSec)[0]
  lines.push('')
  lines.push(`最快：${best.label}（${best.chunksPerSec} 块/s）`)
  for (const r of okArms) {
    if (r === best) continue
    lines.push(`  ${r.label} 是它的 ${(r.chunksPerSec / best.chunksPerSec).toFixed(2)}×`)
  }
}
lines.push('')
lines.push('外推到全库（同一个块集合，只算向量时间）：')
for (const r of okArms) lines.push(`  ${r.label.padEnd(36)} ${((total / r.chunksPerSec) / 60).toFixed(1)} 分钟（${total} 块）`)
console.log(lines.join('\n'))

const out = path.join(tmp, `bench-build-vector-${Date.now()}.json`)
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), repoRoot, total, sample: texts.length, totalChars, results }, null, 2))
console.log(`\nJSON：${out}`)
store.close?.()
