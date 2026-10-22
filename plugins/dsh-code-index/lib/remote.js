/**
 * 远端服务客户端（0.10.0 remote-only）：索引同步 / 重排都走同一个服务。
 *
 * ## 背景
 * 本机不再计算向量、也不再跑本地重排器；`vectors: remote`（或 `auto` + `remote.url`）时：
 *   - 建库把块清单/正文推给服务端，由服务端嵌入并持有 kNN 索引；
 *   - 查询 = 本地 BM25 + 远端 kNN，客户端 RRF 融合；
 *   - `rerank: fast|quality` 时把候选交给远端交叉编码器重排。
 *
 * ## 协议（与 deploy/nas-dsh-embed/server.py 一致）
 * ```
 * GET  <base>/            -> {ready, model, model_bytes, tag?, used_providers, rerank_ready?, rerank_model?}
 * POST <base>/rerank      -> {query, texts:[...], max_tokens?:int}
 *                            <- {ok, scores:[float...] | scores_b64, ms, providers}
 * POST <base>/v1/...      -> 索引同步 / kNN（见 createRemoteIndex）
 * ```
 *
 * ## 硬规则
 * 1. **远端不可用绝不让检索失败**：向量通道降级为纯关键词，重排降级为不重排，原因写进结果。
 * 2. **向量标签必须对得上**：服务端在 `GET /` 自述 `tag`；对不上时客户端只报原因，
 *    不会偷偷换模型（那会把两种来源的向量混进一个索引）。
 * 3. **超时必须短**：查询路径默认 8 s，只用来兜住"那台机器睡了"。
 */
import zlib from 'node:zlib'

/** 远端默认参数（与 lib 注释里的取舍保持一致） */
export const REMOTE_DEFAULTS = {
  /** 单次请求超时。查询路径要短；建库路径可按批放大（见 timeoutMsPerKb） */
  timeoutMs: 8000,
  /** 可选的 Bearer token（放在 Authorization 头里） */
  apiKey: null,
  /** 远端失败时是否回退本机（0.10.0 起插件恒为 false：本地模型已移除） */
  fallbackLocal: false,
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
// 远端索引（kNN 在服务端）：本机只保留 BM25，查询时客户端 RRF 融合。
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
  // namespace 是单个 URL segment；服务端负责 canonical 计算，sync 走无 namespace 入口。
  const namespaceUrl = (namespace, action) => `${base}/v1/namespaces/${NS_ENC(namespace)}${action ? `/${action}` : ''}`

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
    /**
     * 同步入口：不要求客户端先知道 namespace。
     * payload 必须带 repoId / chunkFp / scope（或显式 namespace）；服务端返回 canonical namespace。
     */
    async sync(payload) {
      const enc = encoded(payload)
      try {
        return await client.request('POST', `${base}/v1/namespaces/sync`, enc.body, {
          headers: enc.headers,
          rawBody: enc.rawBody,
          timeoutMs: Math.max(timeoutMs, 15000),
        })
      } catch (e) {
        rethrow(e)
      }
    },
    /** 恢复/诊断：服务端按输入算 canonical namespace。 */
    async resolve(payload) {
      try {
        return await client.request('POST', `${base}/v1/namespaces/resolve`, payload, {
          timeoutMs: Math.max(timeoutMs, 5000),
        })
      } catch (e) {
        rethrow(e)
      }
    },
    /** 上传缺失正文（调用方按批切好） */
    async uploadChunks(namespace, bodies) {
      const enc = encoded({ bodies })
      try {
        return await client.request('POST', namespaceUrl(namespace, 'chunks'), enc.body, {
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
        return await client.request('POST', namespaceUrl(namespace, 'vectors'), { vectors, tag }, { timeoutMs: Math.max(timeoutMs, 60000) })
      } catch (e) {
        rethrow(e)
      }
    },
    /** 触发后台嵌入（服务端会自动限流；rate 可选地覆盖） */
    async kickEmbed(namespace, { rate } = {}) {
      try {
        return await client.request('POST', namespaceUrl(namespace, 'embed'), rate === undefined ? {} : { rate })
      } catch (e) {
        rethrow(e)
      }
    },
    async status(namespace) {
      try {
        return await client.request('GET', namespaceUrl(namespace, 'status'), undefined, { timeoutMs: Math.max(timeoutMs, 15000) })
      } catch (e) {
        rethrow(e)
      }
    },
    /**
     * 服务端 kNN（可选在同一请求里做重排）。
     *
     * 0.11.0 起支持一次检索**多个作用域**（写作用域 + readScopes）：
     *   - 传字符串 / 长度 1 的数组 → 仍发旧协议 `{namespace}`（旧服务端零回归；
     *     且单作用域没有理由走新形态）；
     *   - 传长度 > 1 的数组 → 发 `{namespaces:[{namespace},...]}`（§4.2）。
     * 返回体的 `hits[].namespace` 原样保留；单作用域时服务端不回 namespace，
     * 这里按请求值补齐，保证调用方拿到的每条命中都知道来源。
     *
     * 旧服务端遇到 `namespaces` 会 400/404 —— **回退重试不在这里做**：
     * 那是调用方（index.js 的 code_search）的协议兼容策略，客户端层只把 status 带出去。
     */
    async search(namespacesOrOne, query, { k = 10, tag = null, rerankCandidates = 0, embedText = null } = {}) {
      const namespaces = (Array.isArray(namespacesOrOne) ? namespacesOrOne : [namespacesOrOne])
        .map((ns) => (typeof ns === 'string' ? ns.trim() : ''))
        .filter(Boolean)
      if (!namespaces.length) {
        throw new RemoteError('检索需要一个非空 namespace', { code: 'bad-request' })
      }
      const body = {
        query,
        k,
        tag,
        embedText: embedText ?? undefined,
        rerank: rerankCandidates ? { candidates: rerankCandidates } : undefined,
      }
      if (namespaces.length > 1) body.namespaces = namespaces.map((namespace) => ({ namespace }))
      else body.namespace = namespaces[0]
      try {
        const res = await client.request('POST', `${base}/v1/search`, body, { timeoutMs: Math.max(timeoutMs, 15000) })
        // 命中项带来源是"多作用域"的验收点之一：单作用域时服务端可能省略，客户端补齐
        if (Array.isArray(res?.hits)) {
          for (const hit of res.hits) {
            if (!hit.namespace && namespaces.length === 1) hit.namespace = namespaces[0]
          }
        }
        return res
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
