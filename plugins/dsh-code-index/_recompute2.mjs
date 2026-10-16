/**
 * 用存盘的 3 组文档向量重算 103 题名次 → CSV + 失败模式分析（瞬时，不重新嵌入）。
 * 注意：Qwen3 是带 KV-cache 的 CausalLM 导出，查询编码必须走 transformers.js 的 pipeline。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const DEPS = path.join(process.env.LOCALAPPDATA, 'dsh-code-index', 'embed-deps')
const MODELS = path.join(os.homedir(), '.dsh', 'models')
const INDEX = path.join(os.homedir(), '.dsh', 'code-index', 'billing-service-b2006596', 'index.db')
const VEC = path.join(os.tmpdir(), 'dsh-embed-ab-vecs')
const CASES = JSON.parse(fs.readFileSync('tools/cases/oss-mall-30.json', 'utf8'))

const req = createRequire(path.join(DEPS, 'noop.js'))
const ort = req('onnxruntime-node')
const ns = await import(pathToFileURL(req.resolve('@huggingface/transformers')).href)
const tf = ns.default ?? ns
tf.env.allowRemoteModels = false
tf.env.allowLocalModels = true

const db = new DatabaseSync(INDEX, { readOnly: true })
const names = db.prepare('select path, start_line from chunks order by path, start_line').all().map((r) => `${r.path}:${r.start_line}`)
db.close()

const load = (key, dim) => {
  const buf = fs.readFileSync(path.join(VEC, `${key}.f32`))
  if (buf.length !== names.length * dim * 4) throw new Error(`${key}: ${buf.length} 与 ${names.length}×${dim}×4 不匹配`)
  return Array.from({ length: names.length }, (_, i) => {
    const v = new Float32Array(dim)
    for (let d = 0; d < dim; d++) v[d] = buf.readFloatLE((i * dim + d) * 4)
    return v
  })
}

const ZH = '为这个句子生成表示以用于检索相关文章：'
const QWEN = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:'

async function queries(texts, m) {
  if (m.kind === 'pipeline') {
    const ex = await tf.pipeline('feature-extraction', m.dir, { dtype: 'int8', pooling: 'last_token', normalize: true, device: 'cpu' })
    const out = []
    for (let i = 0; i < texts.length; i += 4) {
      const t = await ex(texts.slice(i, i + 4), { pooling: 'last_token', normalize: true })
      const [, d0] = t.dims
      for (let b = 0; b < (t.dims[0] ?? 1); b++) {
        const v = new Float32Array(d0)
        for (let d = 0; d < d0; d++) v[d] = t.data[b * d0 + d]
        out.push(v)
      }
    }
    return out
  }
  const s = await ort.InferenceSession.create(path.join(m.dir, m.file), { executionProviders: m.ep })
  const tk = await tf.AutoTokenizer.from_pretrained(m.dir)
  const out = []
  for (let i = 0; i < texts.length; i += m.batch) {
    const part = texts.slice(i, i + m.batch)
    const enc = tk(part, { padding: true, truncation: true, max_length: 512 })
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

const CFG = [
  { key: 'bge-small-zh-v1.5-fp16', label: 'bge-small', dim: 512, prefix: ZH, dir: path.join(MODELS, 'bge-small-zh-v1.5'), file: 'model_fp16.onnx', ep: ['dml', 'cpu'], batch: 12, kind: 'raw' },
  { key: 'bge-base-zh-v1.5-fp16', label: 'bge-base', dim: 768, prefix: ZH, dir: path.join(MODELS, 'bge-base-zh-v1.5'), file: 'model_fp16.onnx', ep: ['cpu'], batch: 8, kind: 'raw' },
  { key: 'qwen3-embedding-0.6b-int8', label: 'qwen3', dim: 1024, prefix: QWEN, dir: path.join(MODELS, 'qwen3-embedding-0.6b'), kind: 'pipeline' },
]

const RANKS = {}
for (const m of CFG) {
  const dv = load(m.key, m.dim)
  const qv = await queries(CASES.map(([q]) => m.prefix + q), m)
  RANKS[m.label] = CASES.map(([, expect], k) => {
    const q0 = qv[k]
    const scored = dv.map((d, i) => {
      let s = 0
      for (let x = 0; x < m.dim; x++) s += d[x] * q0[x]
      return [i, s]
    })
    scored.sort((a, b) => b[1] - a[1])
    return scored.findIndex(([i]) => names[i].includes(expect)) + 1 || Infinity
  })
  console.log(`${m.label} 完成`)
}

const csv = ['question,expect,' + CFG.map((m) => m.label).join(',')]
CASES.forEach(([q, expect], i) => {
  csv.push([`"${q.replace(/"/g, '""')}"`, expect, ...CFG.map((m) => (RANKS[m.label][i] === Infinity ? 'NA' : RANKS[m.label][i]))].join(','))
})
const csvPath = path.join(os.tmpdir(), 'ab100-ranks.csv')
fs.writeFileSync(csvPath, csv.join('\n'), 'utf8')
console.log(`CSV → ${csvPath}\n`)

const labels = CFG.map((m) => m.label)
const fmt = (r) => (r === Infinity ? 'NA' : String(r))
console.log('════ hit@k ════')
console.log('模型        ' + [1, 3, 5, 10, 20, 40].map((k) => `@${k}`.padStart(9)).join(''))
for (const L of labels) {
  console.log(L.padEnd(12) + [1, 3, 5, 10, 20, 40].map((k) => `${RANKS[L].filter((r) => r <= k).length}/${CASES.length}`.padStart(9)).join(''))
}

const allDeep = CASES.filter((_, i) => labels.every((L) => RANKS[L][i] > 10))
console.log(`\n三模型都进不了前 10：${allDeep.length} 题（= 换模型也救不了，得靠别的办法）`)
allDeep.slice(0, 12).forEach(([q]) => {
  const i = CASES.findIndex((c) => c[0] === q)
  console.log(`   ${labels.map((L) => fmt(RANKS[L][i]).padStart(4)).join('')}   ${q}`)
})

const allGood = CASES.filter((_, i) => labels.every((L) => RANKS[L][i] <= 3))
console.log(`\n三模型都进前 3：${allGood.length} 题`)
