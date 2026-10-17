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

/**
 * 默认嵌入模型（**bge-base-zh-v1.5**，103 题实测 hit@3 比 bge-small 高 11 个百分点：43% → 54%）。
 *
 * 为什么默认选 base 而不是 small：
 *  - 排序明显更准（@1 27%→35%、@3 43%→54%、@10 71%→79%），查询只慢 12 ms（22 → 34 ms）
 *  - 代价是索引慢约 7 倍（CPU 456 ms/块）→ 一次性成本，可用"打包模型 + 只对需要的仓库建索引"控制
 * 注意：它的 fp16 曾**一次**在 DirectML 上报 `DML GPU readback failed 0x887A0006`（DXGI_ERROR_DEVICE_REMOVED），
 * 复测正常（13 ms/查询，快于 CPU 的 17 ms）→ 判断是**瞬时 TDR**（当时机器上并发跑着多个 GPU 任务），
 * 所以随包提供的只有 int8；若用户自行换成 fp16/DML，下面的**运行期降级**会兜住。
 */
export const DEFAULT_MODEL = 'bge-base-zh-v1.5'
/** 已知模型的向量维度（仅用于诊断；真正的维度在首次推理后从输出张量得到） */
export const KNOWN_DIMS = { 'bge-small-zh-v1.5': 512, 'bge-base-zh-v1.5': 768, 'bge-large-zh-v1.5': 1024 }
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

/** 模型文件指纹的进程内记忆化（读 45 MB 模型文件只做一次） */
const fingerprintMemo = new Map()

/**
 * 模型指纹 = 模型文件 + 分词器 + 分词器配置的**内容哈希**（前 8 位十六进制）。
 *
 * 为什么用内容哈希而不是文件名/mtime/size：
 *  - 跨机器时 mtime 必然不同（复制会改），size 也可能巧合相同 → 只有内容哈希能证明"同一份模型"
 *  - 分词器换了同样会改变向量 → 必须一起纳入
 * 代价：每个进程读一次模型文件（约 45 MB，几十毫秒），结果记忆化。
 */
export function modelFingerprint(modelDir, modelFile) {
  const key = `${modelDir}|${modelFile}`
  if (fingerprintMemo.has(key)) return fingerprintMemo.get(key)
  const h = crypto.createHash('sha256')
  for (const f of [modelFile, 'tokenizer.json', 'tokenizer_config.json']) {
    try {
      h.update(fs.readFileSync(path.join(modelDir, f)))
    } catch {
      /* 文件缺失则跳过（例如没有 tokenizer_config.json） */
    }
  }
  const out = h.digest('hex').slice(0, 8)
  fingerprintMemo.set(key, out)
  return out
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
  pluginDir,
  log = () => {},
} = {}) {
  // 模型查找顺序：显式配置 → **随包提供的** `<插件目录>/model`（打包形态，装上就能用）
  // → 用户目录 `~/.dsh/models/<默认模型>`（fetch-model.mjs 下载的位置）
  const bundledDir = pluginDir ? path.join(pluginDir, 'model') : null
  const dir =
    modelDir ??
    (bundledDir && fs.existsSync(path.join(bundledDir, 'tokenizer.json'))
      ? bundledDir
      : path.join(os.homedir(), '.dsh', 'models', DEFAULT_MODEL))
  const modelName = path.basename(dir) === 'model' ? DEFAULT_MODEL : path.basename(dir)

  // 两个前置条件**必须一起检查、一起报告**。
  // 早前的实现先 return"缺分词器"，于是在**全新机器**上（既没模型也没依赖）只报模型问题——
  // 用户补完模型，再跑一次才被告知还缺依赖，白白多一轮往返。
  // 这是跑"干净机器"场景时实测发现的，不是推测。
  const tokenizerPath = path.join(dir, 'tokenizer.json')
  const hasTokenizer = fs.existsSync(tokenizerPath)

  // 依赖**按需安装**在受管目录，不写进 package.json（理由见 lib/deps.js 顶部注释）。
  // 解析顺序：受管目录 → 调用方给的兜底目录（通常是插件自身的 node_modules，兼容旧安装形态）。
  const resolvedDepsDir = depsDir ?? defaultDepsDir()
  const resolvers = makeResolvers({ depsDir: resolvedDepsDir, alsoDirs: depsFallbackDirs })
  let ort
  let AutoTokenizer
  let env
  let depsProblem = null
  try {
    const ortMod = loadFrom(resolvers, 'onnxruntime-node')
    ort = ortMod?.default ?? ortMod // createRequire 拿到的是 module.exports，没有 ESM 的 .default 包装
    const tfMod = loadFrom(resolvers, '@huggingface/transformers')
    const tf = tfMod?.default ?? tfMod
    AutoTokenizer = tf.AutoTokenizer
    env = tf.env
  } catch (e) {
    const st = depsStatus({ depsDir: resolvedDepsDir, alsoDirs: depsFallbackDirs })
    // 区分三种失败：**缺包**（要按需安装）、**版本不符**（tree-sitter 那类 ABI 配对问题也在这里暴露）、
    // **包在但对、却加载失败**（多半是传递依赖缺失）。早前把后两者也说成"缺 xxx"，会把人指错方向。
    depsProblem =
      st.missing.length > 0 || st.mismatched.length > 0
        ? [
            st.missing.length ? `缺 ${st.missing.join(' / ')}` : '',
            st.mismatched.length ? `版本不符 ${st.mismatched.join('；')}` : '',
          ]
            .filter(Boolean)
            .join('；') + `（安装：code_index_deps action=install group=embed，约 240 MB，不执行依赖脚本）`
        : `依赖已在 ${st.dir} 但加载失败：${String(e?.message ?? e).slice(0, 140)}（可试 code_index_deps action=repair）`
    if (hasTokenizer) {
      return { ok: false, reason: `嵌入不可用：${depsProblem}`, deps: st, cause: String(e?.message ?? e).slice(0, 160) }
    }
    return {
      ok: false,
      reason: `嵌入不可用：① 缺模型文件 ${tokenizerPath}（跑 tools/fetch-model.mjs --model ${DEFAULT_MODEL}，或改配置 modelDir）；② ${depsProblem}`,
      deps: st,
      cause: String(e?.message ?? e).slice(0, 160),
    }
  }
  if (!hasTokenizer) {
    return {
      ok: false,
      reason: `嵌入不可用：缺模型文件 ${tokenizerPath}（跑 tools/fetch-model.mjs --model ${DEFAULT_MODEL}，或改配置 modelDir）；依赖已就绪`,
    }
  }

  let resolved = backend
  const hasFp16 = fs.existsSync(path.join(dir, 'model_fp16.onnx'))
  const hasInt8 = fs.existsSync(path.join(dir, 'model_int8.onnx'))
  if (resolved === 'auto') resolved = hasFp16 && process.platform === 'win32' ? 'gpu' : 'cpu'
  if (resolved === 'gpu' && !hasFp16) resolved = 'cpu'
  let modelFile = resolved === 'gpu' ? 'model_fp16.onnx' : 'model_int8.onnx'
  if (!fs.existsSync(path.join(dir, modelFile))) {
    // 需要的那个精度不在时**不要直接失败**，换成目录里现有的那个：
    //   gpu 档要 fp16 但只有 int8 → 用 int8/CPU
    //   cpu 档默认要 int8 但只有 fp16（随包形态就是这种）→ 用 fp16/CPU（fp16 在 CPU 上可跑）
    if (hasInt8) {
      modelFile = 'model_int8.onnx'
      resolved = 'cpu'
    } else if (hasFp16) {
      modelFile = 'model_fp16.onnx'
    } else {
      return { ok: false, reason: `未找到模型文件 ${modelFile}（目录 ${dir}）` }
    }
  }

  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = path.dirname(dir) + path.sep

  const base = { graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1 }
  let session
  let usedBackend = resolved
  let cpuMoved = false
  const openSession = async (eps) => {
    session = await ort.InferenceSession.create(path.join(dir, modelFile), { ...base, executionProviders: eps })
    const first = Array.isArray(eps) ? eps[0] : eps
    usedBackend = first === 'cpu' || (first && typeof first === 'object' && first.name === 'cpu') ? 'cpu' : 'gpu'
  }
  const attempts = resolved === 'gpu' ? [[{ name: 'dml', deviceId }, 'cpu'], ['dml', 'cpu'], ['cpu']] : [['cpu']]
  let lastErr
  for (const eps of attempts) {
    try {
      await openSession(eps)
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

  /**
   * **建会话成功 ≠ 能推理。** 实测 bge-base 的 fp16 在 DirectML 上：会话建得出来，
   * 但第一次 `session.run` 可能崩（曾见 `DML GPU readback failed 0x887A0006` = DXGI_ERROR_DEVICE_REMOVED，属瞬时 TDR）。
   * 只在"建会话失败"时回退兜不住这种情况 —— 表现会是**每条查询的向量通道都失败、静默退化成纯关键词**
   * （质量腰斩却只有一个 note）。所以这里用一次极小推理（8 token）在**使用前**探测，
   * 崩了就重建到 CPU，模型标签也在**任何嵌入发生之前**就确定下来（避免同一索引里混两种精度）。
   */
  const probe = async () => {
    // 探测必须**接近真实负载**：8 token 的探测太弱 —— 实测 bge-base fp16 在 DML 上
    // 小块能跑、真实长度的批量才崩（`DML GPU readback failed`）。这里用约 256 token × 4 条。
    const filler = 'public void handleRefundLimitCheck(Map<String, Object> params) { log.info("退款超限校验 {}", params); } '
    const enc = tokenizer([filler.repeat(4), filler.repeat(4), filler.repeat(3), filler.repeat(3)], { padding: true, truncation: true, max_length: 256 })
    const feeds = {}
    for (const name of session.inputNames) {
      if (enc[name]) feeds[name] = new ort.Tensor('int64', BigInt64Array.from(Array.from(enc[name].data, (x) => BigInt(x))), enc[name].dims)
    }
    await session.run(feeds)
  }
  try {
    await probe()
  } catch (e) {
    if (usedBackend !== 'gpu') return { ok: false, reason: `模型推理探测失败（CPU）：${String(e?.message ?? e).slice(0, 140)}` }
    log(`GPU 探测推理失败（${String(e?.message ?? e).slice(0, 100)}），改用 CPU 重建会话`)
    modelFile = hasInt8 ? 'model_int8.onnx' : modelFile
    try {
      await openSession(['cpu'])
      await probe()
    } catch (e2) {
      return { ok: false, reason: `GPU 与 CPU 均无法推理：${String(e2?.message ?? e2).slice(0, 140)}` }
    }
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
    /**
     * 模型标签 = 名字 + **模型文件内容的哈希** + 精度。
     *
     * 为什么必须含内容哈希（而不只是名字+精度）：
     *  - **跨机器共享**：两台机器都自称 "bge-small-zh-v1.5"，但模型文件是被替换过/微调过的不同版本时，
     *    只按名字分 tag 会让两边的向量混进同一个 key 空间，检索结果悄悄变差且无任何信号。
     *  - **本机换代**：模型文件换了但 tag 不变，则旧向量被当成有效向量继续使用。
     * 内容哈希让"同 tag ⇔ 同一份模型（含分词器）"，是跨机器一致性的唯一可靠依据。
     * （不能用 mtime/size 代替：文件在机器之间复制时 mtime 必然变。）
     */
    // 精度取**文件名**而不是后端：同一份文件无论跑 DML 还是 CPU 都是同一批向量，
    // 若按后端取精度，一旦运行期从 GPU 迁到 CPU，tag 就会变 → 同一索引里混两种 tag（而它们其实是同源向量）。
    modelTag: `${modelName}-${modelFingerprint(dir, modelFile)}-${modelFile.includes('fp16') ? 'fp16' : 'int8'}`,
    dim: KNOWN_DIMS[modelName] ?? null,
    /**
     * 批大小。GPU 分支从 12 降到 **8**：实测 GTX 960(2 GB) 上 batch=12/24 会在 DML 上
     * **必崩**（`DML GPU readback failed 0x887A0006` = DXGI_ERROR_DEVICE_REMOVED，TDR），
     * batch≤8 稳定；而 bge 的序列长度差异大，padding 会让「大批」反而更慢
     * （实测每块：b=2 34 ms / b=4 87 ms / b=8 104 ms，b=1 46 ms）。
     * 更小的显存只会更早崩，所以默认取安全区；显存大的机器可用配置调高。
     * 运行期若仍崩，`runBatch` 会自动折半并把 `this.batch` 永久调小（见下）。
     */
    batch: batch ?? (usedBackend === 'gpu' ? 8 : 48),
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
        // 折半重试成功后把批大小永久调小：否则每一批都要先撞一次 TDR 再折半，
        // 在真实建库（几百批）上等于把 GPU 白烧一遍。只记录一次。
        let shrunkLogged = false
        const onShrink = () => {
          if (this.batch <= 1) return
          const next = Math.max(1, Math.floor(this.batch / 2))
          if (!shrunkLogged) {
            shrunkLogged = true
            log(`GPU 批次过大导致推理失败，批大小 ${this.batch} → ${next} 后继续（后续批次不再重试）`)
          }
          this.batch = next
        }
        for (let i = 0; i < order.length; i += this.batch) {
          const idx = order.slice(i, i + this.batch)
          const batchTexts = idx.map((j) => input[j])
          let vecs
          try {
            vecs = await runBatch(session, tokenizer, ort, batchTexts, { onShrink })
          } catch (e) {
            // DML 在真实负载（长序列/大批）下会崩（实测 `DML GPU readback failed` / DEVICE_REMOVED），
            // 而启动时的探测（小批短序列）未必能提前发现 —— 曾经因此让整轮建库第 0 块就中断、把索引向量清成 0。
            // 折半也救不回来时才迁到 CPU，对**同一批**重试一次，保证建库/检索能跑完。
            if (usedBackend !== 'gpu' || cpuMoved) throw e
            cpuMoved = true
            log(`GPU 推理失败（${String(e?.message ?? e).slice(0, 90)}），迁到 CPU 继续`)
            modelFile = hasInt8 ? 'model_int8.onnx' : 'model_fp16.onnx'
            await openSession(['cpu'])
            vecs = await runBatch(session, tokenizer, ort, batchTexts)
          }
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

/**
 * 跑一批；失败自动折半（并把调用方的批大小永久调小），单条仍失败时把**真实错误**抛给调用方。
 *
 * 历史 bug（0.6.2 及以前）：这里曾引用 `usedBackend` / `cpuMoved` / `modelFile` / `hasInt8` /
 * `openSession` / `log` —— 它们全是 `createEmbedder` 的内部变量，在模块级函数里并不存在。
 * 后果：任何一次真实推理失败都被替换成 `ReferenceError: usedBackend is not defined`，
 * 真正的 DML 错误被吞掉，降级动作也没执行（只白做了 6 层折半重试）。
 * 现在：本函数**不读写任何外部状态**，降级（GPU→CPU）只由 `embed()` 的 catch 负责。
 */
async function runBatch(session, tokenizer, ort, texts, { depth = 0, maxDepth = 4, onShrink } = {}) {
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
    if (texts.length > 1 && depth < maxDepth) {
      onShrink?.()
      const half = Math.max(1, Math.floor(texts.length / 2))
      const opts = { depth: depth + 1, maxDepth, onShrink }
      return [
        ...(await runBatch(session, tokenizer, ort, texts.slice(0, half), opts)),
        ...(await runBatch(session, tokenizer, ort, texts.slice(half), opts)),
      ]
    }
    throw e
  }
}
