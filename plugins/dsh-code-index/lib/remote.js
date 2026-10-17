/**
 * 远端推理客户端（**可选**）：把嵌入 / 重排放到另一台机器上的 HTTP 服务里算。
 *
 * ## 为什么要有它
 * 本机（笔记本 / 集显）跑 bge-base fp16 一查询约 34 ms、重排 20 个候选约 939 ms；
 * 一台带独显的机器（实测 GTX P4 档 + CUDA，ORT 1.19 + `CUDAExecutionProvider`）算同样的
 * 活只要 ~6 ms（嵌入）/ ~66 ms（重排）。开发机上"先把查询算力借出去"是纯赚的。
 *
 * 但**默认仍然全本机**：远端要多一个故障点（网络、另一台机器开机、证书），
 * 而且本机已经够快（30–60 ms）。所以这是一项**显式开启**的能力：
 *   - `embedding.backend: 'remote'` + `embedding.remote.url`
 *   - `rerankBackend: 'remote'` + `rerankRemote.url`
 * 关掉就是原来的行为，一个字节都不差。
 *
 * ## 协议（与 deploy/nas-dsh-embed/server.py 一致）
 * ```
 * GET  <base>/            -> {ready, model, model_bytes, tag?, used_providers, rerank_ready?, rerank_model?}
 * POST <base>/embed       -> {texts:[...], is_query?:bool}
 *                            <- {ok, dim, count, ms, providers, vectors_b64 | vectors}
 * POST <base>/rerank      -> {query, texts:[...], max_tokens?:int}
 *                            <- {ok, scores:[float...] | scores_b64, ms, providers}
 * ```
 * `vectors_b64` = base64 的 float32 小端、按行连续存放（N×dim）。
 *
 * ## 三条硬规则
 * 1. **远端不可用绝不让检索失败**：向量通道降级为纯关键词，重排降级为不重排，原因写进结果。
 * 2. **向量标签必须对得上**：远端算出来的向量与索引里的向量只有同源才能比。服务端在
 *    `GET /` 里报 `tag`（与本地 `modelTag` 同一算法：模型名 + 模型文件内容哈希 + 精度），
 *    本地据此确认"远端和本机是同一份模型"，从而**切过去不用重建索引**；对不上时**不做
 *    回退**（回退等于把两种来源的向量混进一个索引），只报原因。
 * 3. **超时必须短**：查询路径上的超时是 8 s 默认值 —— 它只用来兜住"那台机器睡了"，
 *    不该让用户等出体感。
 */
import zlib from 'node:zlib'
import { VectorCache, QUERY_PREFIX } from './embedder.js'

/** 远端默认参数（与 lib 注释里的取舍保持一致） */
export const REMOTE_DEFAULTS = {
  /** 单次请求超时。查询路径要短；建库路径可按批放大（见 timeoutMsPerKb） */
  timeoutMs: 8000,
  /** 可选的 Bearer token（放在 Authorization 头里） */
  apiKey: null,
  /** 远端失败时是否回退本机（仅当两边向量标签一致时才真的回退，见文件头规则 2） */
  fallbackLocal: true,
}

/** 远端推理失败：带上"哪种失败"，好让上层把原因写成人话 */
export class RemoteError extends Error {
  constructor(message, { code = 'remote-error', status = null, endpoint = null } = {}) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.status = status
    this.endpoint = endpoint
  }
}

/**
 * 把用户填的 URL 拆成端点。
 *
 * 允许三种写法（都指向同一批端点）：
 *   `https://host`            → /  /embed  /rerank
 *   `https://host/base`       → /base  /base/embed  /base/rerank
 *   `https://host/base/embed` → 同上（把结尾的 /embed 或 /rerank 剥掉当基址）
 * @param {string} rawUrl
 * @returns {{base:string,status:string,embed:string,rerank:string}}
 */
export function endpointsOf(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new RemoteError('远端地址为空：请配置 url（例如 https://dsh-embed.example.com）', { code: 'no-url' })
  }
  let u
  try {
    u = new URL(rawUrl.trim())
  } catch {
    throw new RemoteError(`远端地址不是合法 URL：${rawUrl}`, { code: 'bad-url' })
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new RemoteError(`远端地址只支持 http/https，收到 ${u.protocol}`, { code: 'bad-url' })
  }
  let path = u.pathname.replace(/\/+$/, '')
  path = path.replace(/\/(embed|rerank|health)$/, '')
  const base = `${u.protocol}//${u.host}${path}`
  return { base, status: `${base}/`, embed: `${base}/embed`, rerank: `${base}/rerank` }
}

const b64ToF32 = (b64) => {
  const buf = Buffer.from(b64, 'base64')
  // 复制一份：Buffer 的内存归 undici/底层，直接建视图容易踩到偏移与对齐问题
  const bytes = new Uint8Array(buf.byteLength)
  bytes.set(buf)
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4)
}

/**
 * 一个最小的 HTTP JSON 客户端：带超时、可选鉴权、把错误钉到具体端点。
 * 用全局 `fetch`（Node 22+ 自带，连接自动复用），不引入任何依赖。
 */
export class RemoteClient {
  constructor({ url, timeoutMs = REMOTE_DEFAULTS.timeoutMs, apiKey = null, log = () => {} } = {}) {
    this.endpoints = endpointsOf(url)
    this.timeoutMs = timeoutMs
    this.apiKey = apiKey
    this.log = log
    this.stats = { calls: 0, failures: 0, ms: 0 }
  }

  headers() {
    const h = { 'content-type': 'application/json' }
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`
    return h
  }

  async request(method, endpoint, body, { timeoutMs = this.timeoutMs, headers = null, rawBody = null } = {}) {
    const t0 = Date.now()
    let res
    try {
      res = await fetch(endpoint, {
        method,
        headers: { ...this.headers(), ...(headers ?? {}) },
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      this.stats.failures++
      const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `超时 ${timeoutMs} ms` : String(e?.cause?.code ?? e?.message ?? e)
      throw new RemoteError(`连不上远端（${endpoint}）：${why}`, { code: 'unreachable', endpoint })
    }
    this.stats.calls++
    this.stats.ms += Date.now() - t0
    const text = await res.text()
    if (!res.ok) {
      this.stats.failures++
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch {
        /* 非 JSON 错误体：保留原文在 message 里 */
      }
      const err = new RemoteError(`远端返回 HTTP ${res.status}（${endpoint}）：${text.slice(0, 200)}`, {
        code: 'http-error',
        status: res.status,
        endpoint,
      })
      // 上层要按业务错误码分支（409 冲突 / 507 超限 / 401 鉴权），所以把解析后的载荷带出来
      err.payload = payload
      throw err
    }
    try {
      return JSON.parse(text)
    } catch {
      this.stats.failures++
      throw new RemoteError(`远端返回的不是 JSON（${endpoint}）：${text.slice(0, 120)}`, { code: 'bad-json', endpoint })
    }
  }

  /** GET 基址拿服务端自述（模型、providers、tag、重排是否就绪） */
  status(opts) {
    return this.request('GET', this.endpoints.status, undefined, opts)
  }
}

/**
 * 服务端自述的一句话摘要，用于日志/状态输出。
 * @param {object} st GET / 的返回
 */
export function describeStatus(st) {
  if (!st || typeof st !== 'object') return '（无自述）'
  const p = Array.isArray(st.used_providers) ? st.used_providers.join(',') : st.used_providers
  return [st.model, p, st.ort ? `ort ${st.ort}` : ''].filter(Boolean).join(' / ')
}

/**
 * 远端嵌入器。
 *
 * 返回对象与 `createEmbedder()` **同形**（`ok/backend/modelTag/dim/embed()`），
 * 所以 `lib/search.js` 与 `lib/indexer.js` 完全不需要知道向量是本地算的还是远端算的。
 *
 * @param {object} opts
 * @param {string} opts.url 远端基址（或 /embed 全路径）
 * @param {(texts:string[], o?:object)=>Promise<Float32Array[]>} [opts.localFactory]
 *        回退用：返回本机嵌入器（懒加载）。只在**向量标签一致**时才真的用它。
 * @param {string} [opts.tag] 显式指定向量标签（覆盖服务端自述）
 * @param {string} [opts.model] 服务端没有 `tag` 时的兜底模型名（默认 bge-base-zh-v1.5）
 * @param {string} [opts.cachePath] 向量缓存文件（与本地共用即可，标签一致时互相命中）
 */
export async function createRemoteEmbedder({
  url,
  timeoutMs = REMOTE_DEFAULTS.timeoutMs,
  apiKey = null,
  tag = null,
  model = null,
  fallbackLocal = REMOTE_DEFAULTS.fallbackLocal,
  localFactory = null,
  cachePath,
  log = () => {},
} = {}) {
  const client = new RemoteClient({ url, timeoutMs, apiKey, log })
  const ep = client.endpoints

  let st = null
  let probeError = null
  try {
    st = await client.status({ timeoutMs: Math.min(timeoutMs, 5000) })
  } catch (e) {
    probeError = e
  }

  // 服务端连不上：能不能回退本机由**标签可判定性**决定 —— 探测阶段我们还不知道远端标签，
  // 所以这里只在显式配置了 tag 且本地能证明一致时才回退（见下面 embed() 的二次判断）。
  if (probeError) {
    if (fallbackLocal && localFactory) {
      const local = await localFactory()
      if (local?.ok && tag && local.modelTag === tag) {
        log(`远端不可用（${probeError.message}），已回退本机嵌入器（标签一致：${tag}）`)
        return { ...local, backend: local.backend, fallbackFrom: ep.base, fallbackReason: probeError.message }
      }
      return {
        ok: false,
        reason:
          `嵌入不可用：远端 ${ep.base} 连不上（${probeError.message}）` +
          (local?.ok ? `；本机嵌入器可用但向量标签不同（本机 ${local.modelTag} ≠ 远端 ${tag ?? '未配置'}），不能混用` : `；本机嵌入器也不可用（${local?.reason ?? '未知'}）`),
        remote: { url: ep.base, error: probeError.message },
      }
    }
    return { ok: false, reason: `嵌入不可用：远端 ${ep.base} 连不上（${probeError.message}）`, remote: { url: ep.base, error: probeError.message } }
  }
  if (st && st.ready === false) {
    return { ok: false, reason: `嵌入不可用：远端 ${ep.base} 未就绪（${st.err ?? 'ready=false'}）`, remote: { url: ep.base, status: st } }
  }

  // 向量标签：显式配置 > 服务端自述 > 用模型名+精度兜底。
  // 服务端自述的 tag 与本地 `modelFingerprint` 用同一算法（模型文件内容哈希），
  // 所以"本机建立的索引"和"远端算的查询向量"能对得上，切换后端**不需要重建索引**。
  const modelFile = String(st?.model ?? '')
  const precision = modelFile.includes('fp16') ? 'fp16' : modelFile.includes('int8') ? 'int8' : null
  const resolvedTag =
    tag ??
    (typeof st?.tag === 'string' && st.tag ? st.tag : null) ??
    (model ? `${model}-remote${precision ? `-${precision}` : ''}` : null)
  if (!resolvedTag) {
    return {
      ok: false,
      reason:
        `嵌入不可用：远端 ${ep.base} 没有自述 tag，也无法推导向量标签。` +
        `请升级服务端（deploy/nas-dsh-embed/server.py 会返回 tag），或显式配置 embedding.remote.tag。`,
      remote: { url: ep.base, status: st },
    }
  }

  let cache = null
  try {
    cache = new VectorCache(cachePath ?? undefined)
  } catch (e) {
    log(`向量缓存不可用，远端模式不使用缓存：${String(e?.message ?? e).slice(0, 100)}`)
  }

  const info = {
    url: ep.base,
    tagSource: tag ? 'config' : typeof st?.tag === 'string' && st.tag ? 'server' : 'derived',
    status: st,
    providers: st?.used_providers,
    model: modelFile || st?.model || null,
    callMs: 0,
    calls: 0,
    fallbackUsed: 0,
  }

  const self = {
    ok: true,
    backend: 'remote',
    remote: info,
    modelTag: resolvedTag,
    dim: null,
    cache,
    cacheEntries: cache ? cache.count() : 0,
    /** 远端是否可用（探活结果），供状态输出 */
    async ping() {
      try {
        const again = await client.status({ timeoutMs: Math.min(timeoutMs, 5000) })
        return { ok: true, status: again }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },
    /**
     * 嵌入文本；与本地嵌入器同签名。
     * 远端失败时：`fallbackLocal` 且**本地标签与远端标签一致**才回退，否则把原因抛给调用方
     * （调用方会把向量通道降级为纯关键词，并把这个原因写进 note）。
     */
    async embed(texts, { isQuery = false, useCache = true } = {}) {
      const out = new Array(texts.length).fill(null)
      let keys = null
      if (cache && useCache) {
        keys = texts.map((t) => VectorCache.keyOf(self.modelTag, isQuery ? QUERY_PREFIX + t : t))
        const found = cache.getMany(keys)
        for (let i = 0; i < keys.length; i++) if (found.has(keys[i])) out[i] = found.get(keys[i])
      }
      const todo = []
      for (let i = 0; i < out.length; i++) if (out[i] === null) todo.push(i)
      if (!todo.length) return out

      const t0 = Date.now()
      let payload
      try {
        payload = await client.request(
          'POST',
          ep.embed,
          { texts: todo.map((j) => texts[j]), is_query: isQuery },
          // 建库时一批可能很大：超时按条数放大，避免长批被误杀
          { timeoutMs: Math.max(timeoutMs, 2000 + todo.length * 400) },
        )
        info.calls++
        info.callMs += Date.now() - t0
        // 服务端自报的**纯计算**耗时：与客户端实测相减≈网络+序列化，
        // 排查"远端慢还是网络慢"时这两个数必须都在
        if (typeof payload.ms === 'number') info.serverMs = (info.serverMs ?? 0) + payload.ms
        info.providers = payload.providers ?? info.providers
      } catch (e) {
        info.lastError = e.message
        if (fallbackLocal && localFactory) {
          const local = await localFactory()
          if (local?.ok && local.modelTag === self.modelTag) {
            info.fallbackUsed++
            log(`远端嵌入失败（${e.message}），回退本机（标签一致：${self.modelTag}）`)
            const vecs = await local.embed(
              todo.map((j) => texts[j]),
              { isQuery, useCache: false },
            )
            todo.forEach((j, n) => {
              out[j] = vecs[n]
            })
            if (cache && useCache && keys) cache.put(todo.map((j, n) => [keys[j], vecs[n]]))
            if (self.dim === null) self.dim = vecs[0]?.length ?? null
            return out
          }
          const why = local?.ok
            ? `本机标签 ${local.modelTag} 与远端 ${self.modelTag} 不一致`
            : `本机嵌入器不可用（${local?.reason ?? '未知'}）`
          throw new RemoteError(`${e.message}；且不能回退本机：${why}`, { code: e.code, endpoint: e.endpoint })
        }
        throw e
      }

      let vecs
      if (typeof payload.vectors_b64 === 'string') {
        const flat = b64ToF32(payload.vectors_b64)
        const dim = payload.dim ?? flat.length / payload.count
        vecs = []
        for (let i = 0; i < (payload.count ?? todo.length); i++) vecs.push(flat.slice(i * dim, (i + 1) * dim))
      } else if (Array.isArray(payload.vectors)) {
        vecs = payload.vectors.map((v) => Float32Array.from(v))
      } else {
        throw new RemoteError(`远端 /embed 返回里既没有 vectors_b64 也没有 vectors`, { code: 'bad-response', endpoint: ep.embed })
      }
      if (vecs.length !== todo.length) {
        throw new RemoteError(`远端返回 ${vecs.length} 条向量，但请求了 ${todo.length} 条`, { code: 'bad-response', endpoint: ep.embed })
      }
      if (self.dim === null) self.dim = vecs[0]?.length ?? null
      todo.forEach((j, n) => {
        out[j] = vecs[n]
      })
      if (cache && useCache && keys) cache.put(todo.map((j, n) => [keys[j], vecs[n]]))
      return out
    },
  }
  return self
}

/**
 * 远端重排器。与 `createReranker()` 同形（`ok/backend/modelFile/score()`），
 * 失败由 `lib/search.js` 兜住：退回 RRF 顺序，绝不因此让搜索失败。
 */
export async function createRemoteReranker({
  url,
  timeoutMs = REMOTE_DEFAULTS.timeoutMs,
  apiKey = null,
  maxTokens = 256,
  fallbackLocal = REMOTE_DEFAULTS.fallbackLocal,
  localFactory = null,
  log = () => {},
} = {}) {
  const client = new RemoteClient({ url, timeoutMs, apiKey, log })
  const ep = client.endpoints

  let st = null
  let probeError = null
  try {
    st = await client.status({ timeoutMs: Math.min(timeoutMs, 5000) })
  } catch (e) {
    probeError = e
  }
  if (probeError) {
    if (fallbackLocal && localFactory) {
      const local = await localFactory()
      if (local?.ok) {
        log(`远端重排不可用（${probeError.message}），已回退本机重排器`)
        return { ...local, fallbackFrom: ep.base, fallbackReason: probeError.message }
      }
    }
    return { ok: false, reason: `重排不可用：远端 ${ep.base} 连不上（${probeError.message}）` }
  }
  if (st?.rerank_ready === false) {
    // 服务端明确说重排模型没装：不要"试一下再看"，直接如实报告（省一次 500 与 30 s 超时）
    const why = st.rerank_err ? `（${st.rerank_err}）` : ''
    if (fallbackLocal && localFactory) {
      const local = await localFactory()
      if (local?.ok) {
        log(`远端未装重排模型${why}，已回退本机重排器`)
        return { ...local, fallbackFrom: ep.base, fallbackReason: `远端未装重排模型${why}` }
      }
    }
    return { ok: false, reason: `重排不可用：远端 ${ep.base} 未装重排模型${why}` }
  }

  const info = { url: ep.base, status: st, providers: st?.used_providers, model: st?.rerank_model ?? null, callMs: 0, calls: 0 }
  return {
    ok: true,
    backend: 'remote',
    modelFile: st?.rerank_model ?? 'remote',
    remote: info,
    async score(query, texts) {
      const t0 = Date.now()
      let payload
      try {
        payload = await client.request(
          'POST',
          ep.rerank,
          { query, texts, max_tokens: maxTokens },
          { timeoutMs: Math.max(timeoutMs, 2000 + texts.length * 250) },
        )
        info.calls++
        info.callMs += Date.now() - t0
        // 服务端自报的**纯计算**耗时：与客户端实测相减≈网络+序列化，
        // 排查"远端慢还是网络慢"时这两个数必须都在
        if (typeof payload.ms === 'number') info.serverMs = (info.serverMs ?? 0) + payload.ms
        info.providers = payload.providers ?? info.providers
      } catch (e) {
        info.lastError = e.message
        if (fallbackLocal && localFactory) {
          const local = await localFactory()
          if (local?.ok) {
            log(`远端重排失败（${e.message}），回退本机重排`)
            return local.score(query, texts)
          }
        }
        throw e
      }
      if (typeof payload.scores_b64 === 'string') return b64ToF32(payload.scores_b64)
      if (Array.isArray(payload.scores)) return Float32Array.from(payload.scores)
      throw new RemoteError('远端 /rerank 返回里没有 scores', { code: 'bad-response', endpoint: ep.rerank })
    },
  }
}

// ---------------------------------------------------------------------------
// 远端索引客户端（vectorStore: 'remote'）
//
// 与 createRemoteEmbedder 的区别：那个只借"算向量"，索引仍在本地；
// 这个把**索引本身**放到服务端 —— 块清单、向量、kNN、（可选）重排都在那边，
// 本地只保留 BM25。融合仍在客户端做（RRF），这样"远端挂了"只是语义召回消失，
// 关键词检索照常可用。
// ---------------------------------------------------------------------------

const NS_ENC = (namespace) => encodeURIComponent(namespace)

/**
 * @param {object} opts
 * @param {string} opts.url 服务端基址
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.apiKey]
 */
export function createRemoteIndex({ url, timeoutMs = REMOTE_DEFAULTS.timeoutMs, apiKey = null, log = () => {} } = {}) {
  const client = new RemoteClient({ url, timeoutMs, apiKey, log })
  const base = client.endpoints.base
  const repoUrl = (namespace, action) => `${base}/v1/repos/${NS_ENC(namespace)}${action ? `/${action}` : ''}`

  /** 大载荷走 gzip（16 万块的清单 ≈ 10 MB → 压完 2–3 MB）；返回 {rawBody, headers} */
  function encoded(body) {
    const text = JSON.stringify(body ?? {})
    if (text.length < 64 * 1024) return { body, headers: null, rawBody: null }
    return { body: null, headers: { 'content-encoding': 'gzip' }, rawBody: zlib.gzipSync(Buffer.from(text, 'utf8')) }
  }

  function rethrow(e) {
    const p = e?.payload
    if (e?.status === 409) {
      const err = new RemoteError(`同步冲突：服务端 revision=${p?.revision}，需要改走全量清单`, { code: 'revision-conflict', status: 409 })
      err.revision = p?.revision ?? null
      throw err
    }
    if (e?.status === 507) {
      const err = new RemoteError(`服务端容量不足：${p?.detail ?? '存储上界'}`, { code: 'quota', status: 507 })
      err.payload = p
      throw err
    }
    if (e?.status === 401) {
      throw new RemoteError('服务端拒绝：鉴权失败（检查 remote.apiKey）', { code: 'unauthorized', status: 401 })
    }
    if (e?.status === 400) {
      const err = new RemoteError(`服务端拒绝了请求：${p?.detail ?? p?.error ?? '参数错误'}`, { code: 'rejected', status: 400 })
      err.payload = p
      throw err
    }
    throw e
  }

  return {
    url: base,
    client,
    /** 命名空间清单差分（payload 见 server.py 的 /sync 文档） */
    async sync(namespace, payload) {
      const enc = encoded(payload)
      try {
        return await client.request('POST', repoUrl(namespace, 'sync'), enc.body, {
          headers: enc.headers,
          rawBody: enc.rawBody,
          timeoutMs: Math.max(timeoutMs, 15000),
        })
      } catch (e) {
        rethrow(e)
      }
    },
    /** 上传缺失正文（调用方按批切好） */
    async uploadChunks(namespace, bodies) {
      const enc = encoded({ bodies })
      try {
        return await client.request('POST', repoUrl(namespace, 'chunks'), enc.body, {
          headers: enc.headers,
          rawBody: enc.rawBody,
          timeoutMs: Math.max(timeoutMs, 20000),
        })
      } catch (e) {
        rethrow(e)
      }
    },
    /**
     * 直接把**本机算好的向量**灌进服务端（"用快机器预热"路径）。
     * @param {string} namespace
     * @param {Array<{hash:string, v_b64:string}>} vectors
     * @param {string} [tag] 必须与服务端当前模型一致，否则 409
     */
    async uploadVectors(namespace, vectors, tag) {
      try {
        return await client.request('POST', repoUrl(namespace, 'vectors'), { vectors, tag }, { timeoutMs: Math.max(timeoutMs, 60000) })
      } catch (e) {
        rethrow(e)
      }
    },
    /** 触发后台嵌入（服务端会自动限流；rate 可选地覆盖） */
    async kickEmbed(namespace, { rate } = {}) {
      try {
        return await client.request('POST', repoUrl(namespace, 'embed'), rate === undefined ? {} : { rate })
      } catch (e) {
        rethrow(e)
      }
    },
    async status(namespace) {
      try {
        return await client.request('GET', repoUrl(namespace, 'status'), undefined, { timeoutMs: Math.max(timeoutMs, 15000) })
      } catch (e) {
        rethrow(e)
      }
    },
    /** 服务端 kNN（可选在同一请求里做重排） */
    async search(namespace, query, { k = 10, tag = null, rerankCandidates = 0 } = {}) {
      try {
        return await client.request(
          'POST',
          `${base}/v1/search`,
          { namespace, query, k, tag, rerank: rerankCandidates ? { candidates: rerankCandidates } : undefined },
          { timeoutMs: Math.max(timeoutMs, 15000) },
        )
      } catch (e) {
        rethrow(e)
      }
    },
    async pause() {
      return client.request('POST', `${base}/v1/admin/pause`, {})
    },
    async resume() {
      return client.request('POST', `${base}/v1/admin/resume`, {})
    },
    async setRate(rate) {
      return client.request('POST', `${base}/v1/admin/rate`, { rate })
    },
    async adopt(toLineage, fromLineage, hashes) {
      return client.request('POST', `${base}/v1/lineages/${NS_ENC(toLineage)}/adopt`, { from: fromLineage, hashes })
    },
    async health() {
      return client.request('GET', `${base}/`, undefined, { timeoutMs: Math.min(timeoutMs, 8000) })
    },
  }
}
