/**
 * 嵌入层（可选）：onnxruntime-node + DirectML，与独立实验版共用同一个向量缓存库。
 *
 * 设计取舍：
 *  - **可选依赖**：onnxruntime-node 是 ~60 MB 原生包，@huggingface/transformers 也不小。
 *    插件必须在缺任何一个、或缺模型文件时**仍能工作**（退化为纯 FTS5 关键词检索），
 *    并把"为什么没启用向量"如实报告给调用方。
 *  - **缓存共用**：key = `${modelTag}:${sha256(文本)}`，与 Python 实验版逐字节一致，
 *    两边共用 ~/.dsh/index/vectors.db —— 任何一侧算过的向量另一侧直接命中。
 *  - 实测：GPU(fp16/DML) 47 块/s、CPU 占用 0.25 核；CPU(int8) 22 块/s、5.9 核。
 *    batch 甜点 8~16（32 会掉到 10.8 块/s，更大直接崩）→ 失败减半重试。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
// node:sqlite 延迟加载（理由见 lib/store.js）：顶层 import 会让整个插件在缺该内置模块时静默不加载
import { sqliteDriver } from './store.js'
import { makeResolvers, loadFrom, depsStatus, defaultDepsDir } from './deps.js'

export const DIM = 512
export const MAX_TOKENS = 512
export const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'
const SEP_ID = 102n
const DEFAULT_CACHE = path.join(os.homedir(), '.dsh', 'index', 'vectors.db')

/** 全局内容寻址向量缓存（与 Python 版共用同一文件与 key 格式） */
export class VectorCache {
  constructor(dbPath = DEFAULT_CACHE) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new (sqliteDriver())(dbPath)
    this.db.exec('create table if not exists vec (key text primary key, dim integer, v blob)')
  }

  static keyOf(tag, text) {
    return `${tag}:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`
  }

  getMany(keys) {
    const out = new Map()
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500)
      const rows = this.db.prepare(`select key, v from vec where key in (${chunk.map(() => '?').join(',')})`).all(...chunk)
      for (const r of rows) out.set(r.key, new Float32Array(r.v.buffer, r.v.byteOffset, r.v.byteLength / 4).slice())
    }
    return out
  }

  put(pairs) {
    const stmt = this.db.prepare('insert or replace into vec(key, dim, v) values (?,?,?)')
    this.db.exec('begin')
    try {
      for (const [k, v] of pairs) stmt.run(k, v.length, Buffer.from(v.buffer, v.byteOffset, v.byteLength))
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
  }

  count() {
    return Number(this.db.prepare('select count(*) as n from vec').get().n)
  }
}

function l2(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const inv = 1 / (Math.sqrt(s) || 1e-9)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}

/**
 * 创建嵌入器；任何一步失败都返回 {ok:false, reason}，由调用方决定是否继续纯关键词模式。
 */
export async function createEmbedder({
  modelDir,
  backend = 'auto',
  batch,
  deviceId = 0,
  threads = 6,
  cachePath,
  depsDir,
  depsFallbackDirs = [],
  log = () => {},
} = {}) {
  const dir = modelDir ?? path.join(os.homedir(), '.dsh', 'models', 'bge-small-zh-v1.5')
  if (!fs.existsSync(path.join(dir, 'tokenizer.json'))) {
    return { ok: false, reason: `未找到分词器：${dir}\\tokenizer.json（把 bge-small-zh-v1.5 的 onnx 版放这里，或改配置 modelDir）` }
  }
  // 依赖**按需安装**在受管目录，不再写进 package.json（理由见 lib/deps.js 顶部注释）。
  // 解析顺序：受管目录 → 调用方给的兜底目录（通常是插件自身的 node_modules，兼容旧安装形态）。
  const resolvedDepsDir = depsDir ?? defaultDepsDir()
  const resolvers = makeResolvers({ depsDir: resolvedDepsDir, alsoDirs: depsFallbackDirs })
  let ort
  let AutoTokenizer
  let env
  try {
    const ortMod = loadFrom(resolvers, 'onnxruntime-node')
    ort = ortMod?.default ?? ortMod // createRequire 拿到的是 module.exports，没有 ESM 的 .default 包装
    const tfMod = loadFrom(resolvers, '@huggingface/transformers')
    const tf = tfMod?.default ?? tfMod
    AutoTokenizer = tf.AutoTokenizer
    env = tf.env
  } catch (e) {
    const st = depsStatus({ depsDir: resolvedDepsDir, alsoDirs: depsFallbackDirs })
    // 区分两种失败：**缺包**（要按需安装）vs **包在但加载失败**（多半是传递依赖缺失或版本不匹配）。
    // 早前把后者也说成"缺 xxx"，会把人指错方向。
    const hint =
      st.missing.length > 0 || st.mismatched.length > 0
        ? [
            st.missing.length ? `缺：${st.missing.join(' / ')}` : '',
            st.mismatched.length ? `版本不符：${st.mismatched.join('；')}` : '',
          ]
            .filter(Boolean)
            .join('；') + `——按需安装请用 code_index_deps action=install group=embed（约 240 MB，不执行任何依赖脚本）`
        : `包已在受管目录（${st.dir}）但加载失败：${String(e?.message ?? e).slice(0, 160)}` +
          `——多为传递依赖缺失或版本不匹配，可试 code_index_deps action=repair`
    return { ok: false, reason: `嵌入依赖不可用：${hint}`, deps: st, cause: String(e?.message ?? e).slice(0, 160) }
  }

  let resolved = backend
  const hasFp16 = fs.existsSync(path.join(dir, 'model_fp16.onnx'))
  if (resolved === 'auto') resolved = hasFp16 && process.platform === 'win32' ? 'gpu' : 'cpu'
  if (resolved === 'gpu' && !hasFp16) resolved = 'cpu'
  const modelFile = resolved === 'gpu' ? 'model_fp16.onnx' : 'model_int8.onnx'
  if (!fs.existsSync(path.join(dir, modelFile))) {
    return { ok: false, reason: `未找到模型文件 ${modelFile}（目录 ${dir}）` }
  }

  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = path.dirname(dir) + path.sep

  const base = { graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1 }
  let session
  let usedBackend = resolved
  const attempts =
    resolved === 'gpu'
      ? [[{ name: 'dml', deviceId }, 'cpu'], ['dml', 'cpu'], ['cpu']]
      : [['cpu']]
  let lastErr
  for (const eps of attempts) {
    try {
      session = await ort.InferenceSession.create(path.join(dir, modelFile), { ...base, executionProviders: eps })
      // eps[0] 可能是 'cpu' 字符串，也可能是 { name: 'dml', ... } 对象
      const first = Array.isArray(eps) ? eps[0] : eps
      usedBackend = first === 'cpu' || (first && typeof first === 'object' && first.name === 'cpu') ? 'cpu' : 'gpu'
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!session) return { ok: false, reason: `创建 ONNX 会话失败：${String(lastErr?.message).slice(0, 140)}` }

  let tokenizer
  try {
    tokenizer = await AutoTokenizer.from_pretrained(path.basename(dir), { local_files_only: true })
  } catch (e) {
    return { ok: false, reason: `加载分词器失败（可能需要 tokenizer_config.json）：${String(e.message).slice(0, 120)}` }
  }

  let cache = null
  try {
    cache = new VectorCache(cachePath ?? DEFAULT_CACHE)
  } catch (e) {
    log(`向量缓存不可用，将不使用缓存：${String(e.message).slice(0, 100)}`)
  }

  return {
    ok: true,
    backend: usedBackend,
    modelFile,
    modelTag: `bge-small-zh-v1.5-${usedBackend === 'gpu' ? 'fp16' : 'int8'}`,
    batch: batch ?? (usedBackend === 'gpu' ? 12 : 48),
    cache,
    cacheEntries: cache ? cache.count() : 0,
    /** 嵌入文本；返回 Float32Array[]，顺序与输入一致 */
    async embed(texts, { isQuery = false, useCache = true } = {}) {
      const input = isQuery ? texts.map((t) => QUERY_PREFIX + t) : [...texts]
      const out = new Array(input.length).fill(null)
      let keys = null
      if (cache && useCache) {
        keys = input.map((t) => VectorCache.keyOf(this.modelTag, t))
        const found = cache.getMany(keys)
        for (let i = 0; i < keys.length; i++) if (found.has(keys[i])) out[i] = found.get(keys[i])
      }
      const todo = []
      for (let i = 0; i < out.length; i++) if (out[i] === null) todo.push(i)
      if (todo.length) {
        const order = todo.slice().sort((a, b) => input[a].length - input[b].length)
        for (let i = 0; i < order.length; i += this.batch) {
          const idx = order.slice(i, i + this.batch)
          const vecs = await runBatch(session, tokenizer, ort, idx.map((j) => input[j]))
          if (cache && useCache && keys) cache.put(idx.map((j, n) => [keys[j], vecs[n]]))
          idx.forEach((j, n) => {
            out[j] = vecs[n]
          })
        }
      }
      return out
    },
  }
}

/** 跑一批；失败自动减半，单条仍失败抛错（由调用方降级） */
async function runBatch(session, tokenizer, ort, texts, depth = 0) {
  try {
    const enc = await tokenizer(texts, { padding: true, truncation: true, max_length: MAX_TOKENS })
    const ids = enc.input_ids
    const L = ids.dims[1]
    // 截断策略对齐（见实验记录）：transformers.js 会把 512 位全填内容 token，
    // Rust tokenizers 会为结尾 [SEP] 留位 —— 差 1 token 会让向量与 Python 版不一致。
    if (L === MAX_TOKENS) {
      const t = ids.data
      const mask = enc.attention_mask.data
      for (let i = 0; i < ids.dims[0]; i++) {
        const last = i * L + (L - 1)
        if (mask[last] === 1n && t[last] !== SEP_ID) t[last] = SEP_ID
      }
    }
    const feeds = {}
    for (const name of session.inputNames) {
      if (name === 'input_ids') feeds[name] = new ort.Tensor('int64', ids.data, ids.dims)
      else if (name === 'attention_mask') feeds[name] = new ort.Tensor('int64', enc.attention_mask.data, enc.attention_mask.dims)
      else if (name === 'token_type_ids' && enc.token_type_ids)
        feeds[name] = new ort.Tensor('int64', enc.token_type_ids.data, enc.token_type_ids.dims)
    }
    const res = await session.run(feeds)
    const t = res.last_hidden_state ?? res[Object.keys(res)[0]]
    const [, seq, dim] = t.dims
    const vecs = []
    for (let i = 0; i < texts.length; i++) {
      const off = i * seq * dim
      vecs.push(l2(new Float32Array(t.data.buffer, t.data.byteOffset + off * 4, dim).slice()))
    }
    return vecs
  } catch (e) {
    if (texts.length > 1 && depth < 6) {
      const half = Math.max(1, Math.floor(texts.length / 2))
      return [...(await runBatch(session, tokenizer, ort, texts.slice(0, half), depth + 1)),
              ...(await runBatch(session, tokenizer, ort, texts.slice(half), depth + 1))]
    }
    throw e
  }
}
