/**
 * 重排评测工具：在**固定候选池**上量交叉编码器的净收益与延迟。
 *
 * 为什么要这个工具：重排的结论翻过两次 —— 4 题时测出"净负"（top-3 2/4 → 1/4）✗，
 * 103 题时测出"+19.4pt"✓。同一套题库在 4/20/103 题上给出三次互相矛盾的结论，
 * 所以**必须用 ≥100 题、并把候选池固定住**，结果才可信。
 *
 * ## 用法
 *   node tools/rerank-eval.mjs --index <index.db> --cases <题库.json> \
 *        --emb <嵌入模型目录> --emb-file <onnx 文件名> --dim <维度> \
 *        [--rerank <reranker 目录>] [--topn 20] [--maxlen 512] [--device dml|cpu]
 *
 * - `--emb` / `--emb-file`：决定**候选池**（与生产同款编码路径；用 dml 时给 `--device dml`）
 * - `--dim`：嵌入维度（bge-small 512 / bge-base 768 / Qwen3 1024）
 * - 查询前缀按模型族自动选（`bge-*-zh*` 用中文指令；`qwen3` 用 Instruct；其它不加）
 * - 不给 `--rerank` 时只打印候选池口径的 hit@k（= 重排前的基线）
 *
 * 报告口径：**候选池命中率**（= 完美重排的上限）、重排前/后 hit@1/3/5/10、每题名次变化数、
 * 以及"重排 N 个候选"的延迟中位数（这决定它能不能在线用）。
 *
 * ## 本机实测参考（一个 361 块的 Java 业务模块 / 103 题 / bge-small 候选池 top-20）
 *   候选池上限 85.4% ｜ hit@3 42.7% → **62.1%**（+19.4pt）｜ 63/103 题名次被改动
 *   延迟：中位 **5008 ms/查询**（278M 交叉编码器 int8/CPU，512 token）→ 所以它**不是首选**，
 *   同样 +19pt 换 bge-base-zh 只需一次性索引代价。详见 COMPARISON-CURSOR.md 5.7.3
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { bodyForEmbedding } from '../lib/chunker.js'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const DEPS = path.join(process.env.LOCALAPPDATA, 'dsh-code-index', 'embed-deps')
const INDEX = arg('--index')
const CASES_FILE = arg('--cases')
const EMB = arg('--emb')
const EMB_FILE = arg('--emb-file', 'model_fp16.onnx')
const RERANK = arg('--rerank')
const RERANK_FILE = arg('--rerank-file', 'model_int8.onnx')
const RERANK_DEVICE = arg('--rerank-device', 'cpu')
const TOPN = Number(arg('--topn', 20))
const MAXLEN = Number(arg('--maxlen', 512))
/**
 * 嵌入侧的截断长度，**与重排侧分开**（默认跟 `--maxlen` 一致）。
 * 为什么必须分开：`--maxlen` 同时影响两侧会让结论没法归因 ——
 * 实测把嵌入也截到 256 会让候选池的 hit@3 从 42.7% 涨到 51.5%（更短 = 噪声更少 ✓），
 * 那是**嵌入侧**的收益，和"重排器用 256 更快"是两件事。
 */
const EMB_MAXLEN = Number(arg('--emb-maxlen', MAXLEN))
const DEVICE = arg('--device', 'cpu')
if (!INDEX || !CASES_FILE || !EMB) {
  console.error('用法：node tools/rerank-eval.mjs --index <index.db> --cases <题库.json> --emb <模型目录> [--emb-file f.onnx] [--dim 512] [--rerank <模型目录>] [--topn 20] [--maxlen 512] [--device dml|cpu]')
  process.exit(1)
}
const CASES_ALL = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'))
const LIMIT = Number(arg('--limit', 0))
const CASES = LIMIT > 0 ? CASES_ALL.slice(0, LIMIT) : CASES_ALL
const DIM = Number(arg('--dim', 0)) || null

const req = createRequire(path.join(DEPS, 'noop.js'))
const ort = req('onnxruntime-node')
const ns = await import(pathToFileURL(req.resolve('@huggingface/transformers')).href)
const tf = ns.default ?? ns
tf.env.allowRemoteModels = false
tf.env.allowLocalModels = true

const db = new DatabaseSync(INDEX, { readOnly: true })
const rows = db.prepare('select path, start_line, body from chunks order by path, start_line').all()
db.close()
const names = rows.map((r) => `${r.path}:${r.start_line}`)
const docs = rows.map((r) => bodyForEmbedding(r.body))
console.log(`语料 ${rows.length} 块；题库 ${CASES.length} 题；候选取 top-${TOPN}；maxlen ${MAXLEN}`)

/** 各模型族的查询前缀约定（用错会显著拉低成绩） */
function prefixFor(dir) {
  const d = dir.toLowerCase()
  if (d.includes('qwen3')) return 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:'
  if (/bge-(small|base|large)-zh/.test(d) || d.includes('bge-small-zh')) return '为这个句子生成表示以用于检索相关文章：'
  return ''
}

async function encodeWith(dir, file, texts, batch, maxlen = EMB_MAXLEN) {
  const s = await ort.InferenceSession.create(path.join(dir, file), { executionProviders: [DEVICE, 'cpu'] })
  const tk = await tf.AutoTokenizer.from_pretrained(dir)
  const out = []
  for (let i = 0; i < texts.length; i += batch) {
    const part = texts.slice(i, i + batch)
    const enc = tk(part, { padding: true, truncation: true, max_length: maxlen })
    const feeds = {}
    for (const n of s.inputNames) if (enc[n]) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(Array.from(enc[n].data, (x) => BigInt(x))), enc[n].dims)
    const h = (await s.run(feeds))[s.outputNames[0]]
    const [, seq, d0] = h.dims
    for (let b = 0; b < part.length; b++) {
      const v = new Float32Array(d0)
      for (let d = 0; d < d0; d++) v[d] = h.data[b * seq * d0 + d]
      let sum = 0
      for (let d = 0; d < d0; d++) sum += v[d] * v[d]
      const inv = 1 / (Math.sqrt(sum) || 1e-9)
      for (let d = 0; d < d0; d++) v[d] *= inv
      out.push(v)
    }
  }
  return out
}

// ---- 1) 文档向量（不进全局缓存，纯评测）----
const t0 = Date.now()
const docVec = await encodeWith(EMB, EMB_FILE, docs, 8)
const dim = DIM ?? docVec[0].length
const docMs = Date.now() - t0
console.log(`文档嵌入：${(docMs / 1000).toFixed(1)} s（${(docMs / rows.length).toFixed(0)} ms/块，维度 ${dim}）`)

// ---- 2) 查询向量 + 候选池 ----
const pf = prefixFor(EMB)
const qVec = await encodeWith(EMB, EMB_FILE, CASES.map(([q]) => pf + q), 8)
const pools = CASES.map(([, expect], k) => {
  const qv = qVec[k]
  const scored = docVec.map((d, i) => {
    let s = 0
    for (let x = 0; x < dim; x++) s += d[x] * qv[x]
    return [i, s]
  })
  scored.sort((a, b) => b[1] - a[1])
  return scored.slice(0, TOPN).map(([i]) => i)
})
const rankIn = (ids, expect) => ids.findIndex((i) => names[i].includes(expect)) + 1
let ceiling = 0
const before = { 1: 0, 3: 0, 5: 0, 10: 0 }
CASES.forEach(([, expect], k) => {
  const r = rankIn(pools[k], expect)
  if (r) ceiling++
  for (const n of [1, 3, 5, 10]) if (r && r <= n) before[n]++
})
console.log(`\n候选池命中率（完美重排的上限）：${ceiling}/${CASES.length} = ${((ceiling / CASES.length) * 100).toFixed(1)}%`)
console.log('重排前：' + [1, 3, 5, 10].map((k) => `@${k} ${((before[k] / CASES.length) * 100).toFixed(1)}%`).join('  '))

if (!RERANK) {
  console.log('\n（未给 --rerank：以上即基线）')
  process.exit(0)
}

// ---- 3) 交叉编码器重排 ----
// int8 的量化算子在 DML 上支持差 → 只能 CPU（每候选 250 ms ✗）；fp16 + DML 是把它压下来的希望
const rr = await ort.InferenceSession.create(path.join(RERANK, RERANK_FILE), { executionProviders: [RERANK_DEVICE, 'cpu'] })
console.log(`重排器：${RERANK_FILE} @ ${RERANK_DEVICE}`)
const rrTok = await tf.AutoTokenizer.from_pretrained(RERANK)
const after = { 1: 0, 3: 0, 5: 0, 10: 0 }
const lat = []
let changed = 0
for (let k = 0; k < CASES.length; k++) {
  const [, expect] = CASES[k]
  const ids = pools[k]
  const t = Date.now()
  const pairTexts = ids.map((i) => docs[i])
  const enc = rrTok(ids.map(() => CASES[k][0]), { text_pair: pairTexts, padding: true, truncation: true, max_length: MAXLEN })
  const feeds = {}
  for (const n of rr.inputNames) if (enc[n]) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(Array.from(enc[n].data, (x) => BigInt(x))), enc[n].dims)
  const out = await rr.run(feeds)
  const scores = Array.from(out[rr.outputNames[0]].data)
  lat.push(Date.now() - t)
  const order = ids.map((i, j) => [i, scores[j]]).sort((a, b) => b[1] - a[1]).map(([i]) => i)
  const r = rankIn(order, expect)
  if (r) changed++
  for (const n of [1, 3, 5, 10]) if (r && r <= n) after[n]++
  if ((k + 1) % 25 === 0) console.log(`  …${k + 1}/${CASES.length}`)
}
lat.sort((a, b) => a - b)
console.log('\n重排后：' + [1, 3, 5, 10].map((k) => `@${k} ${((after[k] / CASES.length) * 100).toFixed(1)}%`).join('  '))
console.log(`\nhit@k    重排前    重排后    变化`)
for (const n of [1, 3, 5, 10]) {
  const b = (before[n] / CASES.length) * 100
  const a = (after[n] / CASES.length) * 100
  console.log(`@${String(n).padEnd(3)}   ${b.toFixed(1)}%   ${a.toFixed(1)}%   ${a - b >= 0 ? '+' : ''}${(a - b).toFixed(1)}pt`)
}
const total = lat.reduce((a, b) => a + b, 0)
console.log(`\n延迟：中位 ${lat[Math.floor(lat.length / 2)]} ms，min ${lat[0]} / max ${lat[lat.length - 1]}`)
console.log(`平均 ${(total / lat.length).toFixed(0)} ms/查询 → 每候选 ${(total / lat.length / TOPN).toFixed(0)} ms`)
