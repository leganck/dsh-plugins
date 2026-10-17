/**
 * 端到端检索基准：**同一个索引，只换查询侧后端**。
 *
 * 量的是 `code_search` 一次调用的真实耗时，拆成四档：
 *   ① 纯关键词（不加载模型）        ② 混合（本机 DML 算查询向量）
 *   ③ 混合（本机 CPU 算查询向量）    ④ 混合 + 重排
 *
 * 为什么必须用**同一个索引**：向量标签一致时，索引里的存量向量对两档后端都有效，
 * 于是差异只来自"查询向量怎么算"，这正是唯一要区分的变量。
 * （索引里已有向量，所以本脚本不再重新嵌入文档；用 --rebuild 才会重建。）
 *
 * 用法：
 *   node tools/bench-search.mjs --repo D:/Projects/GolandProjects/energy \
 *        --model-dir D:/dsh-models/bge-base-zh-v1.5 --cpu-model-dir D:/dsh-models/bge-base-fp16-only \
 *        --deps-dir D:/dsh-code-index/embed-deps --max-embed 800 \
 *        --rerank-model-dir D:/dsh-models/bge-reranker-base
 */
import fs from 'node:fs'
import path from 'node:path'
import { Store } from '../lib/store.js'
import { buildIndex, indexDbPath, scanStatus } from '../lib/indexer.js'
import { createEmbedder } from '../lib/embedder.js'
import { createReranker } from '../lib/reranker.js'
import { search } from '../lib/search.js'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const repoRoot = path.resolve(arg('--repo', '.'))
const modelDir = arg('--model-dir', 'D:/dsh-models/bge-base-zh-v1.5')
const cpuModelDir = arg('--cpu-model-dir', null)
const depsDir = arg('--deps-dir', 'D:/dsh-code-index/embed-deps')
const indexBase = arg('--index-base', 'D:/dsh-bench-tmp/index')
const rerankModelDir = arg('--rerank-model-dir', null)
const maxEmbed = Number(arg('--max-embed', '800'))
const rebuild = argv.includes('--rebuild')
const topK = Number(arg('--topk', '10'))
const qRuns = Number(arg('--runs', '3'))

const QUESTIONS = [
  '退款的超限校验是在哪个方法里做的，超限之后会抛什么异常',
  '这个项目里配置文件和命令行参数是怎么合并的',
  '数据库连接池在哪里初始化，最大连接数从哪读',
  '接口返回 401 的时候前端会跳到哪个页面',
  '订单号生成规则是什么，有没有用雪花算法',
  '日志里出现 payment timeout 之后会怎么重试',
  '缓存失效以后是从哪里重新加载的',
  '定时任务是怎么注册的，多久跑一次',
  '用户权限校验是在拦截器里做的吗',
  '导出 Excel 的分页逻辑在哪，一次最多导多少行',
  '消息队列的消费者在哪里定义，失败了怎么补偿',
  '这个仓库的单元测试是怎么组织的，用的是什么框架',
]

const scanOpts = { windowLines: 40, maxFileBytes: 2 * 1024 * 1024, excludeDirs: [], excludePaths: [] }
fs.mkdirSync(indexBase, { recursive: true })
const dbPath = indexDbPath(repoRoot, { indexDirBase: indexBase })
const store = Store.open(dbPath)

const pct = (arr, p) => {
  const a = arr.slice().sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))]
}
const r1 = (v) => Number(v.toFixed(1))

function summarize(label, times) {
  return { label, n: times.length, p50: r1(pct(times, 0.5)), p90: r1(pct(times, 0.9)), min: r1(Math.min(...times)), max: r1(Math.max(...times)), times: times.map(r1) }
}

console.log(`仓库：${repoRoot}`)
const before = store.stats()
console.log(`索引：${dbPath}（${before.files} 文件 / ${before.chunks} 块 / ${before.vectors} 向量，标签 ${store.getMeta('embedding_tag') ?? '无'}）`)

// ---------------------------------------------------------------- 建库
let buildInfo = null
if (rebuild || before.chunks === 0 || before.vectors < before.chunks) {
  const emb = await createEmbedder({ modelDir, backend: 'auto', depsDir, depsFallbackDirs: [], cachePath: path.join(indexBase, 'vectors.db'), log: () => {} })
  if (!emb.ok) {
    console.error('嵌入器不可用：' + emb.reason)
    process.exit(1)
  }
  const budget = Math.max(0, Math.min(maxEmbed, 4000))
  console.log(`建库中（backend=${emb.backend}/${emb.modelFile}，max_embed=${budget}）…`)
  const t0 = Date.now()
  const r = await buildIndex({
    store,
    repoRoot,
    opts: scanOpts,
    embedder: emb,
    budget: { maxEmbedPerRun: budget, mode: rebuild ? 'full' : 'incremental' },
    chunking: { strategy: 'auto', byExt: {}, windowLines: 40 },
    depsDir,
    depsFallbackDirs: [],
  })
  const ms = Date.now() - t0
  buildInfo = {
    scanned: r.scanned,
    chunksWritten: r.chunksWritten,
    embedded: r.embedded,
    vectors: r.vectorsAfter,
    chunks: r.stats.chunks,
    totalMs: ms,
    blocksPerSec: r.embedded ? r1((r.embedded / ms) * 1000) : null,
    backend: emb.backend,
    modelFile: emb.modelFile,
    embedNote: r.embedNote,
    strategies: r.strategies,
    tag: store.getMeta('embedding_tag'),
  }
  console.log(
    `建库完成：扫描 ${r.scanned} 文件、写入 ${r.chunksWritten} 块、补算 ${r.embedded} 个向量，用时 ${(ms / 1000).toFixed(1)} s` +
      (buildInfo.blocksPerSec ? `（${buildInfo.blocksPerSec} 块/s）` : ''),
  )
  if (r.embedNote) console.log('  ' + r.embedNote)
} else {
  console.log('索引已完整，跳过建库（--rebuild 可强制重建）')
}
const st = store.stats()
const tag = store.getMeta('embedding_tag')
console.log(`库里：${st.files} 文件 / ${st.chunks} 块 / ${st.vectors} 向量；向量标签 ${tag ?? '无'}`)

// ---------------------------------------------------------------- 查询
const arms = []

// ① 纯关键词
{
  const t = []
  for (let i = 0; i < qRuns; i++) for (const q of QUESTIONS) {
    const t0 = performance.now()
    await search(store, { ok: false, reason: 'bench: 关键词档' }, q, { topK, mode: 'fts' })
    t.push(performance.now() - t0)
  }
  arms.push({ ...summarize('① 纯关键词（BM25）', t), kind: 'fts' })
}

// ②③ 混合：同一索引、只换查询向量后端
//
// **必须关掉向量缓存**：同一个问题问第二遍时 `VectorCache` 直接命中（~0.1 ms），
// 于是"重复 12 个问题 3 轮"的中位数会变成缓存命中时间（实测把 45 ms 报成 13 ms）。
// 这里包一层强制 `useCache:false`，量的才是真实计算；缓存命中的情况单独提一句即可。
const noCache = (emb) => ({
  ...emb,
  embed: (texts, opts = {}) => emb.embed(texts, { ...opts, useCache: false }),
})
const hybridArms = [
  ['② 混合 · DML 查询向量', modelDir, 'auto'],
  ...(cpuModelDir ? [['③ 混合 · CPU 查询向量', cpuModelDir, 'cpu']] : []),
]
for (const [label, dir, backend] of hybridArms) {
  const emb = await createEmbedder({ modelDir: dir, backend, depsDir, depsFallbackDirs: [], cachePath: path.join(indexBase, `q-${backend}.db`), log: () => {} })
  if (!emb.ok) {
    arms.push({ label, error: emb.reason })
    continue
  }
  if (emb.modelTag !== tag) {
    // 标签不一致时向量通道会被闸门挡住，量出来的"混合"其实是纯关键词 → 必须挡住这个假象
    arms.push({ label, error: `向量标签不一致（索引 ${tag} ≠ 当前 ${emb.modelTag}），该档无意义` })
    continue
  }
  await search(store, emb, QUESTIONS[0], { topK, mode: 'auto' }) // 预热：首次会载入向量矩阵
  const t = []
  for (let i = 0; i < qRuns; i++) for (const q of QUESTIONS) {
    const t0 = performance.now()
    const r = await search(store, noCache(emb), q, { topK, mode: 'auto' })
    t.push(performance.now() - t0)
    if (i === 0 && q === QUESTIONS[0]) console.log(`  ${label} 通道=${r.mode} 命中=${r.results.length}`)
  }
  const rr = await search(store, emb, QUESTIONS[0], { topK, mode: 'auto' })
  arms.push({ ...summarize(label, t), kind: 'hybrid', backend: emb.backend, modelFile: emb.modelFile, mode: rr.mode })
}

// ④ 混合 + 重排
if (rerankModelDir && fs.existsSync(path.join(rerankModelDir, 'tokenizer.json'))) {
  const emb = await createEmbedder({ modelDir, backend: 'auto', depsDir, depsFallbackDirs: [], cachePath: path.join(indexBase, 'q-auto.db'), log: () => {} })
  const rr = await createReranker({ modelDir: rerankModelDir, backend: 'auto', depsDir, depsFallbackDirs: [], log: () => {} })
  if (emb.ok && rr.ok) {
    await search(store, emb, QUESTIONS[0], { topK, mode: 'auto', reranker: rr, rerankCandidates: 20 })
    const t = []
    let cand = 0
    let applied = 0
    for (let i = 0; i < qRuns; i++) for (const q of QUESTIONS) {
      const t0 = performance.now()
      const r = await search(store, emb, q, { topK, mode: 'auto', reranker: rr, rerankCandidates: 20 })
      t.push(performance.now() - t0)
      if (r.rerank?.applied) {
        applied++
        cand = r.rerank.candidates
      }
    }
    arms.push({ ...summarize(`④ 混合 + 重排 top-20 @ ${rr.backend}/${rr.modelFile}`, t), kind: 'rerank', candidates: cand, applied, rerankBackend: rr.backend })
  } else {
    arms.push({ label: '④ 混合 + 重排', error: emb.ok ? rr.reason : emb.reason })
  }
}

console.log('\n════════ 端到端检索延迟（毫秒，' + QUESTIONS.length * qRuns + ' 次查询）════════')
console.log('档位                                  p50      p90      范围')
for (const a of arms) {
  if (a.error) {
    console.log(`${a.label.padEnd(36)} 跳过：${a.error}`)
    continue
  }
  console.log(`${a.label.padEnd(36)} ${String(a.p50).padEnd(8)} ${String(a.p90).padEnd(8)} ${a.min}–${a.max}`)
}

const out = path.join(indexBase, `bench-search-${Date.now()}.json`)
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), repoRoot, dbPath, stats: st, tag, build: buildInfo, arms }, null, 2))
console.log(`\nJSON：${out}`)
store.close?.()
