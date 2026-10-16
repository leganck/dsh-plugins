/**
 * 嵌入模型对照工具：**同一批块、同一批问题，只换嵌入模型**，比检索效果与代价。
 *
 * 用途：决定"要不要换更强的嵌入模型"时，用数据而不是印象回答。
 * 目前清单内的候选（`tools/fetch-model.mjs --list`）：
 *   bge-small-zh-v1.5（默认） / qwen3-embedding-0.6b / bge-m3
 *
 * ## 用法
 *   node tools/ab-embedding-models.mjs --index <index.db 路径> [--label <名字>] [--reuse]
 *
 * `--index`：**要拿哪个索引库里的块正文**当语料。用线上索引可以保证与生产用的是同一批块、
 *            同一批边界（不是脚本自己重切），这样比较才可信。
 * `--reuse`：复用上次存盘的文档向量（`%TEMP%/dsh-embed-ab-vecs/<模型>.f32`）→ 改措辞、换题、
 *            加模型时**不用再花十分钟重算文档向量**。
 *
 * ## 每个模型必须按**它自己的约定**编码（弄错就会把模型测成废物）
 *   bge-small  → 根目录 model_fp16.onnx + DirectML，**CLS** pooling，查询加中文指令前缀
 *   Qwen3-0.6B → onnx/model_int8.onnx + CPU，pipeline(last_token, normalize)，查询加 Instruct 前缀
 *   bge-m3     → onnx/model_int8.onnx + CPU，**CLS** pooling，无指令
 *
 * ## 自检（很重要）
 * bge-small 这一组的名次应当复现此前对同一范围的实测；复现不了就说明脚本或约定错了，
 * 后面的数字也不能信。本机实测（一个 361 块的 Java 业务模块）：**1 / 7 / 6 / 2** → hit@3 = 2/4、hit@8 = 4/4。
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
const has = (k) => process.argv.includes(k)

const DEPS = path.join(process.env.LOCALAPPDATA, 'dsh-code-index', 'embed-deps')
const MODELS_DIR = path.join(os.homedir(), '.dsh', 'models')
const VECDIR = path.join(os.tmpdir(), 'dsh-embed-ab-vecs')

const indexPath = arg('--index')
if (!indexPath || !fs.existsSync(indexPath)) {
  console.error('用法：node tools/ab-embedding-models.mjs --index <index.db 路径> [--label <名字>] [--reuse]')
  process.exit(1)
}
const reuse = has('--reuse')

/** 参考题目（来自真实排查场景；换仓库时按需替换） */
const CASES = [
  ['一天里定时任务重复执行，怎么保证同一天账单不被入库两次', 'DemoBillDownloadServiceImpl'],
  ['运营改了字段配置后，记录是谁改的', 'DemoBillFieldServiceImpl'],
  ['旧数据缺少后来新加的列，怎么把值补回来', 'DemoBillBackfillMerge'],
  ['不认识的 CSV 表头怎么处理', 'DemoBillField'],
]

const req = createRequire(path.join(DEPS, 'noop.js'))
const ort = req('onnxruntime-node')
const ns = await import(pathToFileURL(req.resolve('@huggingface/transformers')).href)
const tf = ns.default ?? ns
tf.env.allowRemoteModels = false
tf.env.allowLocalModels = true

const db = new DatabaseSync(indexPath, { readOnly: true })
const rows = db.prepare('select path, start_line, body from chunks order by path, start_line').all()
db.close()
const docs = rows.map((r) => bodyForEmbedding(r.body))
const names = rows.map((r) => `${r.path}:${r.start_line}`)
console.log(`语料：${arg('--label', indexPath)} —— ${rows.length} 块 / ${new Set(rows.map((r) => r.path)).size} 文件\n`)

const l2 = (v) => {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const inv = 1 / (Math.sqrt(s) || 1e-9)
  const o = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) o[i] = v[i] * inv
  return o
}
const loadVecs = (key) => {
  const f = path.join(VECDIR, `${key}.f32`)
  const m = path.join(VECDIR, `${key}.json`)
  if (!fs.existsSync(f) || !fs.existsSync(m)) return null
  const meta = JSON.parse(fs.readFileSync(m, 'utf8'))
  const buf = fs.readFileSync(f)
  const out = []
  for (let i = 0; i < meta.n; i++) {
    const v = new Float32Array(meta.dim)
    for (let d = 0; d < meta.dim; d++) v[d] = buf.readFloatLE((i * meta.dim + d) * 4)
    out.push(v)
  }
  return { vecs: out, names: meta.names }
}
const saveVecs = (key, vecs) => {
  fs.mkdirSync(VECDIR, { recursive: true })
  const buf = Buffer.alloc(vecs.length * vecs[0].length * 4)
  vecs.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, i * v.byteLength))
  fs.writeFileSync(path.join(VECDIR, `${key}.f32`), buf)
  fs.writeFileSync(path.join(VECDIR, `${key}.json`), JSON.stringify({ dim: vecs[0].length, n: vecs.length, names }))
}
const rankAll = (docVec, qVecs) => {
  const ranks = []
  for (let k = 0; k < CASES.length; k++) {
    const qv = qVecs[k]
    const scored = docVec.map((dv, i) => {
      let s = 0
      for (let d = 0; d < qv.length; d++) s += dv[d] * qv[d]
      return [i, s]
    })
    scored.sort((a, b) => b[1] - a[1])
    ranks.push(scored.findIndex(([i]) => names[i].includes(CASES[k][1])) + 1 || Infinity)
  }
  return ranks
}
const report = (label, dim, docMs, qMs, ranks) => {
  const hit = (n) => ranks.filter((x) => x <= n).length
  console.log(`──── ${label} ────`)
  console.log(`  维度 ${dim}；文档 ${docs.length} 条 ${(docMs / 1000).toFixed(1)} s（${(docMs / docs.length).toFixed(0)} ms/块）；查询 ${qMs} ms`)
  console.log(`  名次：${ranks.map((x) => (x === Infinity ? '未命中' : `第 ${x}`)).join(' / ')}`)
  console.log(`  hit@3 = ${hit(3)}/${CASES.length}    hit@8 = ${hit(8)}/${CASES.length}    hit@40 = ${hit(40)}/${CASES.length}\n`)
}

// ---------- 当前模型：走生产同款路径（raw session + DirectML + CLS + 中文指令前缀）----------
{
  const DIR = path.join(MODELS_DIR, 'bge-small-zh-v1.5')
  const cached = reuse ? loadVecs('bge-small') : null
  if (cached) {
    const session = await ort.InferenceSession.create(path.join(DIR, 'model_fp16.onnx'), { executionProviders: ['dml', 'cpu'] })
    const tokenizer = await tf.AutoTokenizer.from_pretrained(DIR)
    const encode = async (texts) => {
      const enc = tokenizer(texts, { padding: true, truncation: true, max_length: 512 })
      const feeds = {}
      for (const n of session.inputNames) if (enc[n]) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(Array.from(enc[n].data, (x) => BigInt(x))), enc[n].dims)
      const res = await session.run(feeds)
      const h = res[session.outputNames[0]]
      const [, seq, dim] = h.dims
      return texts.map((_, b) => {
        const v = new Float32Array(dim)
        for (let d = 0; d < dim; d++) v[d] = h.data[b * seq * dim + d]
        return l2(v)
      })
    }
    const t = Date.now()
    const qv = await encode(CASES.map(([q]) => `为这个句子生成表示以用于检索相关文章：${q}`))
    report('bge-small-zh-v1.5（现在，DML/fp16，CLS）　[文档向量复用存盘]', cached.vecs[0].length, 0, Date.now() - t, rankAll(cached.vecs, qv))
  } else {
    const session = await ort.InferenceSession.create(path.join(DIR, 'model_fp16.onnx'), { executionProviders: ['dml', 'cpu'] })
    const tokenizer = await tf.AutoTokenizer.from_pretrained(DIR)
    const encode = async (texts) => {
      const out = []
      for (let i = 0; i < texts.length; i += 12) {
        const part = texts.slice(i, i + 12)
        const enc = tokenizer(part, { padding: true, truncation: true, max_length: 512 })
        const feeds = {}
        for (const n of session.inputNames) if (enc[n]) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(Array.from(enc[n].data, (x) => BigInt(x))), enc[n].dims)
        const res = await session.run(feeds)
        const h = res[session.outputNames[0]]
        const [, seq, dim] = h.dims
        for (let b = 0; b < part.length; b++) {
          const v = new Float32Array(dim)
          for (let d = 0; d < dim; d++) v[d] = h.data[b * seq * dim + d]
          out.push(l2(v))
        }
      }
      return out
    }
    const t1 = Date.now()
    const dv = await encode(docs)
    const docMs = Date.now() - t1
    saveVecs('bge-small', dv)
    const t2 = Date.now()
    const qv = await encode(CASES.map(([q]) => `为这个句子生成表示以用于检索相关文章：${q}`))
    report('bge-small-zh-v1.5（现在，DML/fp16，CLS）', dv[0].length, docMs, Date.now() - t2, rankAll(dv, qv))
  }
}

// ---------- 候选：Qwen3-Embedding-0.6B（按模型卡的正规路径）----------
{
  const DIR = path.join(MODELS_DIR, 'qwen3-embedding-0.6b')
  const onnx = ['onnx/model_int8.onnx', 'onnx/model_q4f16.onnx', 'onnx/model_fp16.onnx'].find((f) => fs.existsSync(path.join(DIR, f)))
  if (!onnx) {
    console.log('──── Qwen3-Embedding-0.6B ────  未就绪（tools/fetch-model.mjs --model qwen3-embedding-0.6b）\n')
  } else {
    const cached = reuse ? loadVecs('qwen3') : null
    const dtype = onnx.includes('q4f16') ? 'q4f16' : onnx.includes('fp16') ? 'fp16' : 'int8'
    const ex = await tf.pipeline('feature-extraction', DIR, { dtype, pooling: 'last_token', normalize: true, device: 'cpu' })
    const encode = async (texts) => {
      const out = []
      for (let i = 0; i < texts.length; i += 4) {
        const t = await ex(texts.slice(i, i + 4), { pooling: 'last_token', normalize: true })
        const [, dim] = t.dims
        for (let b = 0; b < (t.dims[0] ?? 1); b++) {
          const v = new Float32Array(dim)
          for (let d = 0; d < dim; d++) v[d] = t.data[b * dim + d]
          out.push(v)
        }
      }
      return out
    }
    const QUERIES = CASES.map(([q]) => `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:${q}`)
    if (cached) {
      const tq = Date.now()
      const qv = await encode(QUERIES)
      report(`Qwen3-Embedding-0.6B（${dtype}，last_token，Instruct 前缀）　[文档向量复用存盘]`, cached.vecs[0].length, 0, Date.now() - tq, rankAll(cached.vecs, qv))
    } else {
      const t1 = Date.now()
      const dv = await encode(docs)
      const docMs = Date.now() - t1
      saveVecs('qwen3', dv)
      const tq = Date.now()
      const qv = await encode(QUERIES)
      report(`Qwen3-Embedding-0.6B（${dtype}，last_token，Instruct 前缀）`, dv[0].length, docMs, Date.now() - tq, rankAll(dv, qv))
    }
  }
}
