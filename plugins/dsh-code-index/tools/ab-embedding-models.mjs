/**
 * 嵌入模型对照工具：**同一批块、同一批问题，只换嵌入模型**，比检索效果与代价。
 *
 * 用途：决定"要不要换更强的嵌入模型"时用数据说话，而不是靠印象。
 *
 * ## 用法
 *   node tools/ab-embedding-models.mjs --index <index.db> [--label <名字>] [--reuse]
 *
 * - `--index`：**拿哪个索引库里的块正文**当语料。用线上索引可保证与生产是同一批块、同一批边界
 *   （不是脚本自己重切），比较才可信。
 * - `--reuse`：复用上次存盘的文档向量（`%TEMP%/dsh-embed-ab-vecs/<臂>.f32`）→ 改措辞/换题
 *   **零成本重排**，不用再等十几分钟。
 *
 * ## 两条编码路径（都不能混用，否则会把模型测成废物）
 * - `raw`：直接用 onnxruntime-node 建会话（**与生产 `lib/embedder.js` 同款**，可用 DirectML）。
 *   适合 BERT 系（bge-*）：单文件、**CLS** pooling、无 KV cache。
 * - `pipeline`：走 transformers.js 的 `feature-extraction`（**它会自己处理 `position_ids` 与 KV cache**）。
 *   适合 Qwen3-Embedding 这类**带 KV-cache 的 CausalLM 导出**：**last_token** pooling。
 *
 * ## 自检（很重要）
 * `bge-small` 这一臂的名次必须复现此前对同范围的实测（一个 361 块的 Java 业务模块 → **1 / 7 / 6 / 2**）；
 * 复现不了就说明脚本或约定错了，后面的数字也不可信。
 *
 * ## ⚠️ 样本量：**别用 4 道题下结论**（真踩过）
 * 4 道题时曾得出"bge-base 大一档并不更准（hit@3 持平 2/4）"——**换成 20 道题后结论完全相反**：
 * bge-base hit@3 = **8/20**，bge-small = **4/20**（差 2 倍）。4 题那批恰好落在 bge-small 碰巧答对的那一档。
 * 所以：**≥20 道题**再说结论，题库见 `tools/cases/oss-mall-30.json`（每题的标准答案都用索引内容核验过）。
 * 20 题实测（一个 361 块的 Java 业务模块）：
 *   bge-small hit@3 4/20 · bge-base 8/20 · Qwen3-0.6B **13/20**；三者 hit@20 都是 16~18/20
 *   → 召回池基本够用 ⇒ 剩下的差距要靠**重排**（小交叉编码器 + 只看 top-20）
 *
 * ## 已知坑（实测踩过，留档）
 * 1. `pipeline()` 只认 `<dir>/onnx/<file>.onnx`；下载器用 `linkOnnxSubdir` 补硬链接。
 * 2. `pipeline()` 用的 ORT 是 transformers.js **精确钉死**的 1.21.0（嵌套副本），
 *    加载不了新版 IR 的导出（如 Qwen3 的 fp16，报 `API version [30] is not available`）✗。
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
const MODELS = path.join(os.homedir(), '.dsh', 'models')
const VECDIR = path.join(os.tmpdir(), 'dsh-embed-ab-vecs')

const indexPath = arg('--index')
if (!indexPath || !fs.existsSync(indexPath)) {
  console.error('用法：node tools/ab-embedding-models.mjs --index <index.db 路径> [--label <名字>] [--reuse]')
  process.exit(1)
}

const ZH_INSTRUCT = '为这个句子生成表示以用于检索相关文章：'
const QWEN3_INSTRUCT = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:'

/** 对照的"臂"。要加模型就在这里加一行（并先用 tools/fetch-model.mjs 下好）。 */
const ARMS = [
  {
    key: 'bge-small-zh-v1.5',
    label: 'bge-small-zh-v1.5（现在）',
    kind: 'raw',
    dir: path.join(MODELS, 'bge-small-zh-v1.5'),
    file: 'model_fp16.onnx',
    ep: ['dml', 'cpu'],
    batch: 12,
    pooling: 'cls',
    queryPrefix: () => ZH_INSTRUCT,
  },
  {
    key: 'bge-base-zh-v1.5',
    label: 'bge-base-zh-v1.5（中文同族大一档）',
    kind: 'raw',
    dir: path.join(MODELS, 'bge-base-zh-v1.5'),
    // 注 1：该模型 **fp16 在 DirectML 上会崩**（DML GPU readback failed, DXGI_ERROR_DEVICE_REMOVED），
    //       而同样代码路径下 bge-small 的 fp16 正常 → 本臂用 CPU
    // 注 2：int8 版实测**质量崩坏**（名次 111~226）→ 怀疑该 int8 导出有问题，故用 fp16/CPU
    file: 'model_fp16.onnx',
    ep: ['cpu'],
    batch: 8,
    pooling: 'cls',
    // bge-*-zh-v1.5 系列（含 base/large）在 s2p 检索时**都要加同一句中文指令**；
    // 早前给它设空前缀导致名次崩到 111/203（同族 base 不会远差于 small）→ 属用法错误，已修
    queryPrefix: () => ZH_INSTRUCT,
  },
  {
    key: 'bge-large-zh-v1.5',
    label: 'bge-large-zh-v1.5（中文同族最大档）',
    kind: 'raw',
    dir: path.join(MODELS, 'bge-large-zh-v1.5'),
    file: 'model_fp16.onnx',
    ep: ['dml', 'cpu'],
    batch: 4,
    pooling: 'cls',
    queryPrefix: () => '',
  },
  {
    key: 'bge-m3',
    label: 'bge-m3',
    kind: 'raw',
    dir: path.join(MODELS, 'bge-m3'),
    file: 'model_int8.onnx',
    ep: ['cpu'],
    batch: 4,
    pooling: 'cls',
    queryPrefix: () => '',
  },
  {
    key: 'qwen3-embedding-0.6b',
    label: 'Qwen3-Embedding-0.6B',
    kind: 'pipeline',
    dir: path.join(MODELS, 'qwen3-embedding-0.6b'),
    device: arg('--device', 'cpu'),
    variant: arg('--variant'),
    queryPrefix: () => QWEN3_INSTRUCT,
  },
]

/**
 * 参考题目（来自真实排查场景）。可用 `--cases <json>` 换成更大的题库，
 * 例：`--cases tools/cases/oss-mall-30.json`（20 道，标准答案均已用索引内容核验过）。
 * JSON 形状：`[[问题, 期望文件子串, 说明], ...]`
 */
const CASES = (() => {
  const f = arg('--cases')
  if (!f) return [
    ['一天里定时任务重复执行，怎么保证同一天账单不被入库两次', 'DemoBillDownloadServiceImpl'],
    ['运营改了字段配置后，记录是谁改的', 'DemoBillFieldServiceImpl'],
    ['旧数据缺少后来新加的列，怎么把值补回来', 'DemoBillBackfillMerge'],
    ['不认识的 CSV 表头怎么处理', 'DemoBillField'],
  ]
  const arr = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (!Array.isArray(arr) || !arr.length || !Array.isArray(arr[0])) throw new Error(`题库格式不对（应为 [[问题, 期望子串], ...]）：${f}`)
  console.log(`题库：${f}（${arr.length} 题）`)
  return arr
})()

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
  if (meta.n !== rows.length) return null // 语料变了 → 存盘失效
  const buf = fs.readFileSync(f)
  const out = []
  for (let i = 0; i < meta.n; i++) {
    const v = new Float32Array(meta.dim)
    for (let d = 0; d < meta.dim; d++) v[d] = buf.readFloatLE((i * meta.dim + d) * 4)
    out.push(v)
  }
  return out
}
const saveVecs = (key, vecs) => {
  fs.mkdirSync(VECDIR, { recursive: true })
  const buf = Buffer.alloc(vecs.length * vecs[0].length * 4)
  vecs.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, i * v.byteLength))
  fs.writeFileSync(path.join(VECDIR, `${key}.f32`), buf)
  fs.writeFileSync(path.join(VECDIR, `${key}.json`), JSON.stringify({ dim: vecs[0].length, n: vecs.length }))
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
const report = (label, dim, docMs, qMs, ranks, extra = '') => {
  const hit = (n) => ranks.filter((x) => x <= n).length
  console.log(`──── ${label} ────`)
  console.log(`  维度 ${dim}；文档 ${docMs ? `${(docMs / 1000).toFixed(1)} s（${(docMs / rows.length).toFixed(0)} ms/块）` : '复用存盘'}；查询 ${qMs} ms${extra}`)
  console.log(`  名次：${ranks.map((x) => (x === Infinity ? '未命中' : `第 ${x}`)).join(' / ')}`)
  console.log(`  hit@3 = ${hit(3)}/${CASES.length}    hit@8 = ${hit(8)}/${CASES.length}    hit@40 = ${hit(40)}/${CASES.length}\n`)
}

/** raw：与生产 embedder.js 同款（裸会话 + 可选 DirectML） */
async function makeRawEncoder(arm) {
  const session = await ort.InferenceSession.create(path.join(arm.dir, arm.file), { executionProviders: arm.ep })
  const tokenizer = await tf.AutoTokenizer.from_pretrained(arm.dir)
  return async (texts) => {
    const out = []
    for (let i = 0; i < texts.length; i += arm.batch) {
      const part = texts.slice(i, i + arm.batch)
      const enc = tokenizer(part, { padding: true, truncation: true, max_length: 512 })
      const feeds = {}
      for (const n of session.inputNames) if (enc[n]) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(Array.from(enc[n].data, (x) => BigInt(x))), enc[n].dims)
      const res = await session.run(feeds)
      const h = res[session.outputNames[0]]
      const [, seq, dim] = h.dims
      const mask = enc.attention_mask?.data
      for (let b = 0; b < part.length; b++) {
        let idx = 0
        if (arm.pooling === 'cls') idx = 0
        else if (mask) {
          for (let s = seq - 1; s >= 0; s--) if (Number(mask[b * seq + s]) === 1) { idx = s; break }
        } else idx = seq - 1
        const v = new Float32Array(dim)
        for (let d = 0; d < dim; d++) v[d] = h.data[b * seq * dim + idx * dim + d]
        out.push(l2(v))
      }
    }
    return out
  }
}

/** pipeline：交给 transformers.js 处理 position_ids / KV cache（CausalLM 导出必须走这条） */
async function makePipelineEncoder(arm) {
  const order = arm.variant ? [`onnx/model_${arm.variant}.onnx`] : ['onnx/model_int8.onnx', 'onnx/model_q4f16.onnx', 'onnx/model_fp16.onnx']
  const onnx = order.find((f) => fs.existsSync(path.join(arm.dir, f)))
  if (!onnx) return null
  const variant = onnx.replace('onnx/model_', '').replace('.onnx', '')
  const dtype = variant === 'quantized' ? 'q8' : variant
  arm._variant = variant
  let ex
  try {
    ex = await tf.pipeline('feature-extraction', arm.dir, { dtype, pooling: 'last_token', normalize: true, device: arm.device })
  } catch (e) {
    console.log(`  ⚠️ device=${arm.device} 建 pipeline 失败，退回 cpu：${String(e.message).slice(0, 90)}`)
    ex = await tf.pipeline('feature-extraction', arm.dir, { dtype, pooling: 'last_token', normalize: true, device: 'cpu' })
  }
  return async (texts) => {
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
}

const RESULTS = []
for (const arm of ARMS) {
  if (!fs.existsSync(arm.dir)) {
    console.log(`──── ${arm.label} ────  模型目录不存在，跳过（tools/fetch-model.mjs --model ${arm.key}）\n`)
    continue
  }
  let encode
  try {
    encode = arm.kind === 'raw' ? await makeRawEncoder(arm) : await makePipelineEncoder(arm)
  } catch (e) {
    console.log(`──── ${arm.label} ────  加载失败：${String(e.message).slice(0, 140)}\n`)
    continue
  }
  if (!encode) {
    console.log(`──── ${arm.label} ────  没有可用的 ONNX 变体，跳过\n`)
    continue
  }
  // 存盘键必须含**用的哪个变体/文件**：否则 int8 ↔ fp16 换变体时会拿旧文档向量配新查询向量，
  // 等于把两个模型混用，名次变垃圾（这个坑真踩到过）
  const fileWord = (arm.file ?? arm._variant ?? 'auto').replace(/^model_?/, '').replace('.onnx', '') || 'auto'
  const cacheKey = `${arm.key}-${fileWord}`
  const variantInfo = (arm._variant ?? fileWord) !== 'auto' ? `/${arm._variant ?? fileWord}` : ''
  const deviceInfo = arm.kind === 'raw' ? `/${arm.ep[0]}` : `/${arm.device}`
  const cached = has('--reuse') ? loadVecs(cacheKey) : null
  const tq0 = Date.now()
  const qv = await encode(CASES.map(([q]) => arm.queryPrefix() + q))
  const qMs = Date.now() - tq0
  let dv = cached
  let docMs = 0
  if (!dv) {
    const t1 = Date.now()
    dv = await encode(docs)
    docMs = Date.now() - t1
    saveVecs(cacheKey, dv)
  }
  const ranks = rankAll(dv, qv)
  RESULTS.push({ label: `${arm.label}${variantInfo}${deviceInfo}`, dim: dv[0].length, docMs, qMs, ranks })
  report(`${arm.label}${variantInfo}${deviceInfo}${cached ? '　[文档向量复用存盘]' : ''}`, dv[0].length, docMs, qMs, ranks)
}

// 逐题矩阵：哪个模型在第几名找到答案（多题时最有信息量）
if (RESULTS.length > 1) {
  console.log('════ 逐题对照（名次；❌ = 未进前 40）════')
  console.log('  问题'.padEnd(50) + RESULTS.map((r) => r.label.split('（')[0].slice(0, 12).padStart(13)).join(''))
  CASES.forEach(([q, expect], i) => {
    const cells = RESULTS.map((r) => {
      const v = r.ranks[i]
      return (v === Infinity ? '❌' : String(v)).padStart(13)
    })
    console.log(`  ${q.slice(0, 24).padEnd(50)}${cells.join('')}`)
  })
  console.log()
  console.log('════ 汇总 ════')
  for (const r of RESULTS) {
    const hit = (n) => r.ranks.filter((x) => x <= n).length
    console.log(`  ${r.label}`)
    console.log(`     hit@1=${hit(1)}/${CASES.length}  hit@3=${hit(3)}/${CASES.length}  hit@5=${hit(5)}/${CASES.length}  hit@10=${hit(10)}/${CASES.length}  hit@20=${hit(20)}/${CASES.length}  hit@40=${hit(40)}/${CASES.length}`)
  }
}
