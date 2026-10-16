/**
 * 交叉编码器重排（**可选，默认关**）。
 *
 * ## 为什么值得做（103 题实测，一个 361 块的 Java 业务模块，候选池 = bge-small 向量 top-20）
 * | 配置 | hit@3 | 每查询延迟 |
 * |---|---|---|
 * | 不重排 | 42.7% | ~40 ms |
 * | **fp16 + DirectML，top-20（quality）** | **59.2%（+16.5pt）** | **939 ms** |
 * | **fp16 + DirectML，top-10（fast）** | **57.3%（+14.6pt）** | **474 ms** |
 * | int8 + CPU，top-20 | 62.1%（+19.4pt） | 4934 ms ✗ |
 *
 * ## 为什么用 fp16 而不是 int8
 * 本机实测：int8 的量化算子在 DirectML 上支持差 → 只能 CPU → 每候选 250 ms（20 个候选 5.0 s ✗）。
 * 换成**纯 fp16** 后 DML 能全速跑（每候选 47 ms，快 5.3×），质量只差 2.9pt。
 * 所以默认优先 `model_fp16.onnx`，缺失时退回 `model_int8.onnx`（CPU）。
 *
 * ## 设计：可选 + 懒加载 + **失败降级**
 * 缺模型 / 缺依赖 / DML 建会话失败 → 返回 `{ok:false, reason}`，
 * 调用方**照常返回不重排的结果**，并把原因写进 note。
 * 绝不允许"重排器不可用"变成"搜索失败"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeResolvers, loadFrom, depsStatus, defaultDepsDir } from './deps.js'

/** 两档：候选数与延迟成正比（实测每候选约 47 ms） */
export const RERANK_TIERS = {
  fast: { candidates: 10, label: '快档' },
  quality: { candidates: 20, label: '常规档' },
}

/** 重排输入的截断长度：实测 256 相对 512 质量只差 2.9pt、耗时减半 */
export const RERANK_MAX_TOKENS = 256

const DEFAULT_DIR = () => path.join(os.homedir(), '.dsh', 'models', 'bge-reranker-base')

/**
 * 创建重排器。任何一步失败都返回 `{ok:false, reason}`。
 * @returns {Promise<{ok:boolean, reason?:string, score?:Function, backend?:string, modelFile?:string}>}
 */
export async function createReranker({
  modelDir,
  backend = 'auto',
  maxTokens = RERANK_MAX_TOKENS,
  deviceId = 0,
  threads = 6,
  depsDir,
  depsFallbackDirs = [],
  log = () => {},
} = {}) {
  const dir = modelDir ?? DEFAULT_DIR()
  if (!fs.existsSync(path.join(dir, 'tokenizer.json'))) {
    return { ok: false, reason: `重排不可用：缺模型文件 ${path.join(dir, 'tokenizer.json')}（下载：code_index_deps action=install group=rerank）` }
  }

  const resolvedDepsDir = depsDir ?? defaultDepsDir()
  const resolvers = makeResolvers({ depsDir: resolvedDepsDir, alsoDirs: depsFallbackDirs })
  let ort
  let AutoTokenizer
  let env
  try {
    const ortMod = loadFrom(resolvers, 'onnxruntime-node')
    ort = ortMod?.default ?? ortMod
    const tfMod = loadFrom(resolvers, '@huggingface/transformers')
    const tf = tfMod?.default ?? tfMod
    AutoTokenizer = tf.AutoTokenizer
    env = tf.env
  } catch (e) {
    const st = depsStatus({ depsDir: resolvedDepsDir, alsoDirs: depsFallbackDirs })
    const detail =
      st.missing.length > 0 || st.mismatched.length > 0
        ? `缺/版本不符：${[...st.missing, ...st.mismatched].join(' / ')}`
        : `依赖已在 ${st.dir} 但加载失败：${String(e?.message ?? e).slice(0, 120)}`
    return { ok: false, reason: `重排不可用：${detail}（安装：code_index_deps action=install group=embed）` }
  }

  // 优先 fp16（DML 上快 5.3×），否则 int8（CPU）
  const hasFp16 = fs.existsSync(path.join(dir, 'model_fp16.onnx'))
  const hasInt8 = fs.existsSync(path.join(dir, 'model_int8.onnx'))
  if (!hasFp16 && !hasInt8) {
    return { ok: false, reason: `重排不可用：${dir} 下没有 model_fp16.onnx 或 model_int8.onnx` }
  }
  let resolved = backend
  if (resolved === 'auto') resolved = hasFp16 && process.platform === 'win32' ? 'gpu' : 'cpu'
  if (resolved === 'gpu' && !hasFp16) resolved = 'cpu'
  const modelFile = resolved === 'gpu' ? 'model_fp16.onnx' : 'model_int8.onnx'

  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = path.dirname(dir) + path.sep

  const base = { graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1 }
  let session
  let usedBackend = resolved
  let lastErr
  const attempts = resolved === 'gpu' ? [[{ name: 'dml', deviceId }, 'cpu'], ['dml', 'cpu'], ['cpu']] : [['cpu']]
  for (const eps of attempts) {
    try {
      session = await ort.InferenceSession.create(path.join(dir, modelFile), { ...base, executionProviders: eps })
      const first = Array.isArray(eps) ? eps[0] : eps
      usedBackend = first === 'cpu' || first?.name === 'cpu' ? 'cpu' : 'gpu'
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!session) return { ok: false, reason: `重排不可用：创建 ONNX 会话失败：${String(lastErr?.message).slice(0, 140)}` }

  let tokenizer
  try {
    tokenizer = await AutoTokenizer.from_pretrained(path.basename(dir), { local_files_only: true })
  } catch (e) {
    return { ok: false, reason: `重排不可用：加载分词器失败：${String(e.message).slice(0, 120)}` }
  }

  const batch = usedBackend === 'gpu' ? 8 : 16
  log(`重排器就绪：${modelFile} @ ${usedBackend}（maxTokens=${maxTokens}）`)

  return {
    ok: true,
    backend: usedBackend,
    modelFile,
    maxTokens,
    /**
     * 给 (query, 每个候选正文) 打相关性分。分数越大越相关（bge-reranker 输出单 logit）。
     * 失败时抛错 —— 由 search.js 捕获并**退回不重排的结果**。
     */
    async score(query, texts) {
      const out = new Float32Array(texts.length)
      for (let i = 0; i < texts.length; i += batch) {
        const part = texts.slice(i, i + batch)
        const enc = tokenizer(part.map(() => query), {
          text_pair: part,
          padding: true,
          truncation: true,
          max_length: maxTokens,
        })
        const feeds = {}
        for (const n of session.inputNames) {
          if (enc[n]) feeds[n] = new ort.Tensor('int64', BigInt64Array.from(Array.from(enc[n].data, (x) => BigInt(x))), enc[n].dims)
        }
        const res = await session.run(feeds)
        const t = res[session.outputNames[0]]
        // 形状可能是 [batch, 1] 或 [batch]
        const stride = t.dims.length > 1 ? t.dims[t.dims.length - 1] : 1
        for (let b = 0; b < part.length; b++) out[i + b] = t.data[b * stride]
      }
      return out
    },
  }
}
