/**
 * **用快机器预热远端索引**：本机算向量 → 灌给服务端，服务端不再重复嵌入。
 *
 * 为什么需要：NAS 的 P4 建库 26.8 块/s，本机 RX 6750 XT 33.05 块/s（实测）。
 * 对一个 16 万块的大仓，这差 20 分钟。更实际的价值是——**首次初始化不用等 NAS**：
 * 你手上这台机器有 GPU 就先算掉，NAS 只负责存与查。
 *
 * 流程：
 *   ① 本地建 BM25（切块 + FTS）
 *   ② 清单同步（noEmbed：明确告诉服务端"别自己嵌"）
 *   ③ 上传缺失块的正文（服务端 rerank 要用）
 *   ④ 本机分批算向量 → 每 256 条推给 /v1/repos/{ns}/vectors
 *
 * 用法：
 *   node tools/seed-vectors.mjs --repo D:/oss/elasticsearch --url https://dsh-embed.taek.site \
 *        --model-dir D:/dsh-models/bge-base-zh-v1.5 --deps-dir D:/dsh-code-index/embed-deps \
 *        --index-base D:/dsh-bench-tmp/remote-index [--limit 2000] [--batch 8]
 */
import fs from 'node:fs'
import path from 'node:path'
import { Store } from '../lib/store.js'
import { buildIndex, indexDbPath } from '../lib/indexer.js'
import { createEmbedder } from '../lib/embedder.js'
import { createRemoteIndex } from '../lib/remote.js'
import { repoIdOf, gitOriginUrl } from '../lib/repo.js'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const repoRoot = path.resolve(arg('--repo', ''))
const url = arg('--url', 'https://dsh-embed.taek.site')
const modelDir = arg('--model-dir', 'D:/dsh-models/bge-base-zh-v1.5')
const depsDir = arg('--deps-dir', 'D:/dsh-code-index/embed-deps')
const indexBase = arg('--index-base', 'D:/dsh-bench-tmp/remote-index')
const limit = arg('--limit') ? Number(arg('--limit')) : Infinity
const batch = Number(arg('--batch', '8'))
const pushBatch = Number(arg('--push', '256'))
const backend = arg('--backend', 'auto')
const reset = argv.includes('--reset')

if (!repoRoot || !fs.existsSync(repoRoot)) {
  console.error('请用 --repo 指定仓库')
  process.exit(1)
}

const client = createRemoteIndex({ url, timeoutMs: 60000 })
const health = await client.health()
const serverTag = health.tag
const dbPath = indexDbPath(repoRoot, { indexDirBase: indexBase })
const store = Store.open(dbPath)
if (reset) {
  // 服务端被重置过、或本地记着"已同步"但远端其实是空的：清掉本地同步态，逼它下次发全量清单
  for (const k of ['remote_revision', 'remote_repo_state', 'remote_namespace']) {
    store.db.prepare('delete from meta where k = ?').run(k)
  }
  console.log('已清除本地同步状态（--reset）：本次会发全量清单')
}
console.log(`仓库：${repoRoot}`)
console.log(`本地库：${dbPath}`)
console.log(`服务端：${url}（tag ${serverTag}，限速 ${health.governor?.rate ?? '?'} 块/s）`)

// ① + ② + ③：同步清单与正文，明确 noEmbed（向量由本机算）
const t0 = Date.now()
const r = await buildIndex({
  store,
  repoRoot,
  opts: { windowLines: 40, maxFileBytes: 2 * 1024 * 1024, excludeDirs: [], excludePaths: [] },
  embedder: { ok: false, reason: 'seed：向量由本机算好再灌' },
  budget: { maxEmbedPerRun: 0, mode: 'incremental' },
  chunking: { strategy: 'auto', byExt: {}, windowLines: 40 },
  remote: { client, repoId: repoIdOf(repoRoot), url: gitOriginUrl(repoRoot), noEmbed: true, uploadBatch: 256 },
})
const ns = r.remote.namespace
console.log(`\n同步：revision ${r.remote.revision}；缺向量 ${r.remote.missing} 块；上传正文 ${r.remote.uploaded} 条；用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(`命名空间：${ns}`)

let missing = r.remote.missingHashes ?? []
if (!missing.length) {
  console.log('服务端已有全部向量，无需预热')
  process.exit(0)
}
if (missing.length > limit) missing = missing.slice(0, limit)

// ④ 本机算向量
const emb = await createEmbedder({
  modelDir,
  backend,
  depsDir,
  depsFallbackDirs: [],
  cachePath: path.join(indexBase, 'seed-vectors.db'),
  log: (m) => console.log('  [embed]', m),
})
if (!emb.ok) {
  console.error('本机嵌入器不可用：' + emb.reason)
  process.exit(1)
}
if (emb.modelTag !== serverTag) {
  console.error(`标签不一致，拒绝灌入：本机 ${emb.modelTag} ≠ 服务端 ${serverTag}`)
  process.exit(1)
}
console.log(`本机嵌入：${emb.backend}/${emb.modelFile}，标签 ${emb.modelTag}（与服务端一致 ✓）`)
console.log(`本轮预热 ${missing.length} 块（批 ${batch}，每 ${pushBatch} 条推一次）…`)

let pushed = 0
let done = 0
const tStart = Date.now()
const CHUNK = 2000
for (let i = 0; i < missing.length; i += CHUNK) {
  const slice = missing.slice(i, i + CHUNK)
  const bodies = store.bodiesByHashes(slice)
  const texts = []
  const hashes = []
  for (const h of slice) {
    const b = bodies.get(h)
    if (b) {
      hashes.push(h)
      texts.push(b)
    }
  }
  // 本机按批算（排序减少 padding）
  const order = texts.map((t, idx) => idx).sort((a, b) => texts[a].length - texts[b].length)
  const vecs = new Array(texts.length)
  // 这里直接复用 embedder.embed 的分批逻辑（它内部按 batch 推进并排序）
  const out = await emb.embed(texts, { isQuery: false, useCache: false })
  out.forEach((v, idx) => {
    vecs[idx] = v
  })
  // 推向量
  for (let j = 0; j < hashes.length; j += pushBatch) {
    const part = []
    for (let k = j; k < Math.min(j + pushBatch, hashes.length); k++) {
      part.push({ hash: hashes[k], v_b64: Buffer.from(vecs[k].buffer, vecs[k].byteOffset, vecs[k].byteLength).toString('base64') })
    }
    const res = await client.uploadVectors(ns, part, serverTag)
    pushed += res.accepted ?? 0
  }
  done += hashes.length
  const rate = done / ((Date.now() - tStart) / 1000)
  const eta = (missing.length - done) / Math.max(rate, 1e-9)
  process.stdout.write(
    `\r  已推 ${pushed}/${missing.length} 块，${rate.toFixed(1)} 块/s，剩余约 ${(eta / 60).toFixed(1)} 分钟   `,
  )
}
console.log('')
const st = await client.status(ns)
console.log(
  `\n完成：服务端 ${st.vectors}/${st.chunks} 向量（覆盖 ${((st.coverage ?? 0) * 100).toFixed(0)}%），` +
    `总用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`,
)
store.close?.()
