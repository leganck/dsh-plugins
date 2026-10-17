/**
 * 配置矩阵评测：**在同一批题上跑遍所有检索配置**，用一张表回答"该开什么"。
 *
 * ## 覆盖的配置
 *   ① 不启用模型（纯 FTS5/BM25）
 *   ②③④⑤⑥⑦ 每种嵌入模型 × 是否加重排
 * 全部走 **lib/search.js 的真实实现**（含 RRF 融合、两道一致性闸门、重排接入），
 * 不是脚本自己拼的排序 —— 这样测出来的才是插件真实行为。
 *
 * ## 本机实测（103 题中文自然语言题库；语料 = 一个 129 文件 / 361 块的 Java 业务模块）
 * | 配置 | @1 | @3 | @5 | @10 | @20 | 延迟 p50 |
 * |---|---|---|---|---|---|---|
 * | 不启用模型（纯 BM25） | 22% | **27%** | 31% | 34% | 38% | **1 ms** |
 * | bge-small-zh-v1.5 | 27% | 43% | 59% | 71% | 87% | 22 ms |
 * | bge-small + 重排 | 41% | **57%** | 71% | 78% | 87% | 1125 ms |
 * | bge-base-zh-v1.5 | 35% | **54%** | 69% | 79% | 86% | **34 ms** |
 * | bge-base + 重排 | 38% | 57% | 68% | 76% | 86% | 1118 ms |
 * | Qwen3-Embedding-0.6B | 34% | **56%** | 71% | **83%** | **96%** | 87 ms |
 * | **Qwen3 + 重排** | **44%** | **63%** | **74%** | **86%** | **96%** | 1292 ms |
 *
 * 两个非直觉结论：
 *  - **重排对弱模型增益最大**（bge-small +14pt），对强模型收益递减甚至略降（bge-base +2~3pt）→ 不是无脑加；
 *  - **不用模型时连召回都不够**（@20 仅 38%），而模型把 @20 拉到 86~96% → 模型的主要价值在**召回**，不在排序。
 *
 * ## 用法
 *   node tools/config-matrix.mjs [--cases tools/cases/oss-mall-30.json] [--index <index.db>] [--topk 20]
 * 依赖：三个嵌入模型 + 重排模型已下载（见 INSTALL.md）；缺哪个会自动跳过对应行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const DEPS = path.join(process.env.LOCALAPPDATA, 'dsh-code-index', 'embed-deps')
const MODELS = path.join(os.homedir(), '.dsh', 'models')
const INSTALLED = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
// `--index <index.db>`：**必须支持**。早前这里写死了一个本机索引路径，`--index` 被静默忽略，
// 于是"拿 A 语料的题库去查 B 语料的索引"会直接得到全 0 且没有任何提示（真踩过：换了新题库后 30 题全 0/30，
// 排查半天才发现根本没打开指定索引）。默认值留空 → 报错要求显式传，避免再次静默跑错语料。
const SRC_INDEX = (() => {
  const i = process.argv.indexOf('--index')
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1])
  return null
})()
if (!SRC_INDEX) {
  console.error('用法: node tools/config-matrix.mjs --index <index.db> [--cases <cases.json>] [--topk 20]')
  console.error('必须显式指定 --index：题库与索引必须来自同一语料，否则结果无意义（且会静默为 0）。')
  process.exit(2)
}
// 缓存按「语料」分开存：早前只按模型名存，换一个仓库做评测时会读到上一个语料的向量，
// 表现为尺寸不符（或更糟：尺寸恰好相同、结果全错）。用索引目录名做语料标识。
const CORPUS = path.basename(path.dirname(SRC_INDEX))
const VECDIR = path.join(os.tmpdir(), 'dsh-embed-ab-vecs')
const CASES_FILE = (() => { const i = process.argv.indexOf('--cases'); return i >= 0 ? process.argv[i + 1] : path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'cases', 'oss-mall-30.json') })()
const CASES_ALL = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'))
// --limit N：只跑前 N 题（冒烟测试用，正式结论请跑全量）
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Number(process.argv[i + 1]) : 0 })()
const CASES = LIMIT > 0 ? CASES_ALL.slice(0, LIMIT) : CASES_ALL
const WORK = path.join(os.tmpdir(), 'dsh-matrix')
fs.mkdirSync(WORK, { recursive: true })

const req = createRequire(path.join(DEPS, 'noop.js'))
const ort = req('onnxruntime-node')
const ns = await import(pathToFileURL(req.resolve('@huggingface/transformers')).href)
const tf = ns.default ?? ns
tf.env.allowRemoteModels = false
tf.env.allowLocalModels = true

// 用已安装包里的模块（真代码路径）
const LIB = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'lib')
const { Store } = await import(pathToFileURL(path.join(LIB, 'store.js')).href)
const { search } = await import(pathToFileURL(path.join(LIB, 'search.js')).href)
const { createReranker } = await import(pathToFileURL(path.join(LIB, 'reranker.js')).href)

const ZH = '为这个句子生成表示以用于检索相关文章：'
const QWEN = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:'

/** 三个模型的查询编码器（raw 路径 / pipeline 路径）+ 文档向量来源 */
const ARMS = [
  { key: 'bge-small', label: 'bge-small-zh-v1.5', vec: 'bge-small-zh-v1.5-fp16', dim: 512, dir: path.join(MODELS, 'bge-small-zh-v1.5'), file: 'model_fp16.onnx', ep: ['dml', 'cpu'], batch: 12, prefix: ZH, kind: 'raw' },
  { key: 'bge-base', label: 'bge-base-zh-v1.5', vec: 'bge-base-zh-v1.5-fp16', dim: 768, dir: path.join(MODELS, 'bge-base-zh-v1.5'), file: 'model_fp16.onnx', ep: ['cpu'], batch: 8, prefix: ZH, kind: 'raw' },
  { key: 'qwen3', label: 'Qwen3-Embedding-0.6B', vec: 'qwen3-embedding-0.6b-int8', dim: 1024, dir: path.join(MODELS, 'qwen3-embedding-0.6b'), kind: 'pipeline', prefix: QWEN },
]

/** 为某模型准备一个索引副本：换掉 vectors 表 + embedding_tag（语料块保持原样） */
function prepIndex(arm) {
  const dbPath = path.join(WORK, `${arm.key}.db`)
  fs.copyFileSync(SRC_INDEX, dbPath)
  const buf = fs.readFileSync(path.join(VECDIR, `${arm.vec}-${CORPUS}.f32`))
  const db = new DatabaseSync(dbPath)
  const ids = db.prepare('select id from chunks order by path, start_line').all().map((r) => r.id)
  const n = ids.length
  if (buf.length !== n * arm.dim * 4) throw new Error(`${arm.key}: 向量 ${buf.length} ≠ ${n}×${arm.dim}×4`)
  db.exec('delete from vectors')
  const ins = db.prepare('insert or replace into vectors(chunk_id, dim, v) values (?,?,?)')
  db.exec('begin')
  for (let i = 0; i < n; i++) {
    const v = Buffer.from(buf.subarray(i * arm.dim * 4, (i + 1) * arm.dim * 4))
    ins.run(ids[i], arm.dim, v)
  }
  db.exec('commit')
  // meta 的实际列名是 k/v（不是 key/value）—— 看 schema 才知道
  db.prepare('insert or replace into meta(k, v) values (?,?)').run('embedding_tag', `matrix-${arm.key}-${arm.dim}`)
  db.close()
  return dbPath
}

/** 查询编码器（返回与模型一致的 Float32Array[]） */
async function makeQueryEncoder(arm) {
  if (arm.kind === 'pipeline') {
    const ex = await tf.pipeline('feature-extraction', arm.dir, { dtype: 'int8', pooling: 'last_token', normalize: true, device: 'cpu' })
    return async (texts) => {
      const out = []
      for (let i = 0; i < texts.length; i += 4) {
        const t = await ex(texts.slice(i, i + 4), { pooling: 'last_token', normalize: true })
        const [, d] = t.dims
        for (let b = 0; b < (t.dims[0] ?? 1); b++) {
          const v = new Float32Array(d)
          for (let x = 0; x < d; x++) v[x] = t.data[b * d + x]
          out.push(v)
        }
      }
      return out
    }
  }
  const s = await ort.InferenceSession.create(path.join(arm.dir, arm.file), { executionProviders: arm.ep })
  const tk = await tf.AutoTokenizer.from_pretrained(arm.dir)
  return async (texts) => {
    const out = []
    for (let i = 0; i < texts.length; i += arm.batch) {
      const part = texts.slice(i, i + arm.batch)
      const enc = tk(part, { padding: true, truncation: true, max_length: 512 })
      const feeds = {}
      for (const n of s.inputNames) if (enc[n]) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(Array.from(enc[n].data, (x) => BigInt(x))), enc[n].dims)
      const h = (await s.run(feeds))[s.outputNames[0]]
      const [, seq, d] = h.dims
      for (let b = 0; b < part.length; b++) {
        const v = new Float32Array(d)
        for (let x = 0; x < d; x++) v[x] = h.data[b * seq * d + x]
        let sum = 0
        for (let x = 0; x < d; x++) sum += v[x] * v[x]
        const inv = 1 / (Math.sqrt(sum) || 1e-9)
        for (let x = 0; x < d; x++) v[x] *= inv
        out.push(v)
      }
    }
    return out
  }
}

const hit = (ranks, n) => ranks.filter((r) => r !== null && r <= n).length
const p50 = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)]

async function runArm({ label, store, embedder, reranker, topN }) {
  const ranks = []
  const lat = []
  for (const [q, expect] of CASES) {
    const t = Date.now()
    const r = await search(store, embedder, q, { topK: topN ?? 20, reranker, rerankCandidates: reranker ? 20 : 0 })
    lat.push(Date.now() - t)
    const idx = r.results.findIndex((x) => x.path.includes(expect))
    ranks.push(idx >= 0 ? idx + 1 : null)
    if (reranker) if (!r.rerank?.applied) throw new Error(`${label}: 重排未生效 ${JSON.stringify(r.rerank)}`)
  }
  return { label, ranks, lat }
}

const ROWS = []
// ---- ① 不启用模型 ----
{
  const store = Store.open(SRC_INDEX)
  const arm = await runArm({ label: '① 不启用模型（纯关键词 BM25）', store, embedder: { ok: false, reason: 'matrix: 关闭向量通道' } })
  ROWS.push(arm)
}
// ---- ②③④⑤⑥⑦ 三个模型 × 是否重排 ----
const reranker = await createReranker({ modelDir: path.join(MODELS, 'bge-reranker-base'), backend: 'auto', log: () => {} })
if (!reranker.ok) throw new Error(`重排器不可用：${reranker.reason}`)
for (const arm of ARMS) {
  const dbPath = prepIndex(arm)
  const enc = await makeQueryEncoder(arm)
  const store = Store.open(dbPath)
  const embedder = {
    ok: true,
    modelTag: `matrix-${arm.key}-${arm.dim}`,
    dim: arm.dim,
    async embed(texts, { isQuery } = {}) {
      return enc(texts.map((t) => (isQuery ? arm.prefix + t : t)))
    },
  }
  ROWS.push(await runArm({ label: `② ${arm.label}`, store, embedder }))
  ROWS.push(await runArm({ label: `③ ${arm.label} + 重排`, store, embedder, reranker }))
  store.db.close()
  fs.rmSync(dbPath, { force: true })
}

console.log('\n════ 配置矩阵（103 题，命中 = 正确答案出现在前 k 条）════')
console.log('配置'.padEnd(38) + ['@1', '@3', '@5', '@10', '@20', '延迟p50'].map((h) => h.padStart(9)).join(''))
for (const r of ROWS) {
  const cells = [1, 3, 5, 10, 20].map((n) => `${hit(r.ranks, n)}/${CASES.length}`.padStart(9))
  console.log(r.label.padEnd(38) + cells.join('') + `${p50(r.lat)} ms`.padStart(11))
}
