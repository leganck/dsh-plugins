/**
 * dsh-report · GitLab REST 客户端
 *
 * 复刻 workbench 的调用面（`docs/plugin-extraction/05-route-b-data-acquisition.md` §①）：
 *   GET /user
 *   GET /user/emails
 *   GET /projects?membership=true&per_page&page&order_by=name&sort=asc
 *   GET /projects/:id/repository/commits?page&per_page=100&all=true&order_by=created_at&sort=desc&since&until
 *   GET /projects/:id/repository/commits/:sha
 *   GET /projects/:id/repository/commits/:sha/refs?type=branch
 *
 * 与 Go 侧的差异（有意改进，见 05 分册 §⑥/§⑦）：
 *   - 429/5xx 指数退避（默认最多 3 次重试，尊重 `Retry-After`），Go 侧完全不重试；
 *   - 超时 60s（AbortController + 竞速，桩 fetch 忽略 signal 也能超时）；
 *   - 错误统一 `GitLabError`（含 status / message / body / url），不吞 GitLab 的 message。
 *
 * 分页契约（05 分册 §1.2）：分页信息只取自响应头 `x-page` / `x-per-page` / `x-total` /
 * `x-total-pages` / `x-next-page`；**没有分页头 = `hasPagination=false`**，同步引擎据此
 * 判定本次翻页不完整（不 prune）。
 *
 * 结构：
 *   {items, page, perPage, total, totalPages, nextPage, hasPagination}
 *
 * @module lib/gitlab
 */

/** GitLab API 版本前缀。 */
const API_PREFIX = '/api/v4'

/** 默认超时（Go 侧同为 60s，`internal/integrations/gitlab/client.go:30-33`）。 */
const DEFAULT_TIMEOUT_MS = 60_000

/** 默认重试次数（指“重试”而非“总请求”）。 */
const DEFAULT_MAX_RETRIES = 3

/** 默认退避基数（毫秒；测试可调小）。 */
const DEFAULT_BACKOFF_MS = 500

/** 退避上限（毫秒）。 */
const MAX_BACKOFF_MS = 8_000

/**
 * GitLab 调用错误。
 * @property {number|null} status HTTP 状态码（网络/超时错误为 null）
 * @property {string} code `http` | `timeout` | `network` | `parse`
 * @property {unknown} [body] 解析后的响应体（或原文）
 * @property {string} url 请求地址
 */
export class GitLabError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number|null, code?: string, body?: unknown, url?: string, cause?: unknown}} [info]
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'GitLabError'
    this.status = info.status ?? null
    this.code = info.code ?? 'http'
    this.body = info.body
    this.url = info.url ?? ''
    if (info.cause !== undefined) this.cause = info.cause
  }
}

/** 读取响应头（兼容 Headers 实例与普通对象 / 小写键）。 */
function readHeader(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    if (value !== null && value !== undefined) return String(value)
  }
  const lower = name.toLowerCase()
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lower && value !== undefined && value !== null) return String(value)
    }
  }
  return ''
}

/** 安全整数解析（空/非法 → 0）。 */
function toInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 从响应头构造分页对象。 */
export function paginationFromHeaders(headers) {
  const page = toInt(readHeader(headers, 'x-page'))
  const perPage = toInt(readHeader(headers, 'x-per-page'))
  const total = toInt(readHeader(headers, 'x-total'))
  const totalPages = toInt(readHeader(headers, 'x-total-pages'))
  const nextPageRaw = readHeader(headers, 'x-next-page')
  const nextPage = toInt(nextPageRaw)
  const hasPagination = Boolean(
    readHeader(headers, 'x-page') ||
      readHeader(headers, 'x-per-page') ||
      readHeader(headers, 'x-total') ||
      readHeader(headers, 'x-total-pages') ||
      nextPageRaw,
  )
  return {
    page,
    perPage,
    total,
    totalPages,
    nextPage: nextPage > 0 ? nextPage : null,
    hasPagination,
  }
}

/** `Retry-After` 解析：秒数或 HTTP 日期 → 毫秒（非法 → 0）。 */
export function retryAfterMs(headers) {
  const raw = readHeader(headers, 'retry-after').trim()
  if (!raw) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return 0
}

/** 把 GitLab 错误体压成一行可读消息。 */
function errorMessageFromBody(body, status) {
  if (body && typeof body === 'object') {
    const message = body.message ?? body.error ?? body.error_description
    if (typeof message === 'string' && message.trim()) return message.trim()
    if (message && typeof message === 'object') {
      try {
        return JSON.stringify(message)
      } catch {
        /* 兜底走默认文案 */
      }
    }
  }
  if (typeof body === 'string' && body.trim()) {
    return body.trim().slice(0, 500)
  }
  return `GitLab 请求失败（HTTP ${status}）`
}

/** 默认 sleep（可被测试注入）。 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 创建 GitLab 客户端。
 *
 * @param {{baseUrl: string, token: string, fetchImpl?: Function,
 *          timeoutMs?: number, maxRetries?: number, backoffMs?: number, sleep?: Function}} options
 *        `timeoutMs` / `maxRetries` / `backoffMs` / `sleep` 是测试钩子（生产用默认值即可）。
 * @returns {{
 *   baseUrl: string,
 *   getCurrentUser: () => Promise<object>,
 *   getUserEmails: () => Promise<object[]>,
 *   listMembershipProjects: (opts?: {page?: number, perPage?: number, orderBy?: string, sort?: string}) => Promise<object>,
 *   listCommits: (projectId: number|string, opts?: {since?: string, until?: string, page?: number,
 *     perPage?: number, all?: boolean, orderBy?: string, sort?: string}) => Promise<object>,
 *   getCommit: (projectId: number|string, sha: string) => Promise<object>,
 *   getCommitRefs: (projectId: number|string, sha: string) => Promise<object[]>,
 * }}
 */
export function createGitLabClient(options = {}) {
  const baseUrl = String(options.baseUrl ?? '').trim().replace(/\/+$/, '')
  const token = String(options.token ?? '').trim()
  if (!baseUrl) throw new GitLabError('GitLab baseUrl 未配置', { code: 'config' })
  if (!token) throw new GitLabError('GitLab token 未配置（请先在插件设置里保存 Personal Access Token）', {
    code: 'config',
  })
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new GitLabError('当前运行时没有 fetch，请注入 fetchImpl', { code: 'config' })
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const maxRetries = Number.isFinite(Number(options.maxRetries))
    ? Math.max(0, Number(options.maxRetries))
    : DEFAULT_MAX_RETRIES
  const backoffMs = Number(options.backoffMs) > 0 ? Number(options.backoffMs) : DEFAULT_BACKOFF_MS
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep

  /** 拼接 URL 与 query。 */
  function buildUrl(pathname, query) {
    const url = new URL(`${baseUrl}${API_PREFIX}${pathname}`)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  /** 单次 fetch + 超时竞速。 */
  async function fetchOnce(url, init) {
    const controller = new AbortController()
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new GitLabError(`GitLab 请求超时（>${timeoutMs}ms）：${url}`, { code: 'timeout', url }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeout])
    } catch (error) {
      if (error instanceof GitLabError) throw error
      throw new GitLabError(`GitLab 网络错误：${error?.message ?? error}`, {
        code: 'network',
        url,
        cause: error,
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 发一个带重试的请求。
   * @returns {Promise<{body: any, headers: any, status: number}>}
   */
  async function request(pathname, { query, method = 'GET', body } = {}) {
    const url = buildUrl(pathname, query)
    const headers = {
      'PRIVATE-TOKEN': token,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const init = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }

    let attempt = 0
    for (;;) {
      const response = await fetchOnce(url, init)
      const status = Number(response.status ?? 0)
      const responseHeaders = response.headers
      if (status >= 200 && status < 300) {
        if (status === 204) return { body: null, headers: responseHeaders, status }
        const text = typeof response.text === 'function' ? await response.text() : ''
        if (!text) return { body: null, headers: responseHeaders, status }
        try {
          return { body: JSON.parse(text), headers: responseHeaders, status }
        } catch (error) {
          throw new GitLabError(`GitLab 响应不是合法 JSON：${url}`, {
            code: 'parse',
            status,
            url,
            body: text.slice(0, 500),
            cause: error,
          })
        }
      }

      // 读错误体（尽量解析 JSON，拿 GitLab 的 message）
      let errorBody = null
      if (typeof response.text === 'function') {
        const text = await response.text()
        try {
          errorBody = text ? JSON.parse(text) : null
        } catch {
          errorBody = text
        }
      }
      const retriable = status === 429 || status >= 500
      if (retriable && attempt < maxRetries) {
        const retryAfter = retryAfterMs(responseHeaders)
        const backoff = Math.min(backoffMs * 2 ** attempt, MAX_BACKOFF_MS)
        attempt += 1
        await sleep(retryAfter > 0 ? Math.min(retryAfter, 30_000) : backoff)
        continue
      }

      const message = errorMessageFromBody(errorBody, status)
      throw new GitLabError(`GitLab ${method} ${pathname} → HTTP ${status}：${message}`, {
        status,
        code: 'http',
        url,
        body: errorBody,
      })
    }
  }

  /** GET 并返回 `{items, ...pagination}`（列表端点）。 */
  async function requestList(pathname, query) {
    const { body, headers } = await request(pathname, { query })
    const items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : []
    return { items, ...paginationFromHeaders(headers) }
  }

  /** 项目路径片段（数字或字符串 id）。 */
  function projectPath(projectId) {
    const id = String(projectId ?? '').trim()
    if (!id) throw new GitLabError('projectId 不能为空', { code: 'config' })
    return `/projects/${encodeURIComponent(id)}`
  }

  return {
    baseUrl,

    /** GET /user */
    async getCurrentUser() {
      const { body } = await request('/user')
      if (!body || typeof body !== 'object') {
        throw new GitLabError('GitLab /user 返回空响应', { code: 'parse' })
      }
      return body
    },

    /** GET /user/emails（需要 read_user scope；失败由调用方决定是否降级） */
    async getUserEmails() {
      const { body } = await request('/user/emails')
      return Array.isArray(body) ? body : []
    },

    /** GET /events?action=pushed（最近 push 事件，用于推断提交作者别名） */
    async listEvents(listOptions = {}) {
      const { items } = await requestList('/events', {
        per_page: listOptions.perPage ?? 50,
        page: listOptions.page ?? 1,
        action: listOptions.action ?? 'pushed',
      })
      return Array.isArray(items) ? items : []
    },

    /** GET /projects?membership=true（候选仓库） */
    async listMembershipProjects(listOptions = {}) {
      return requestList('/projects', {
        membership: 'true',
        per_page: listOptions.perPage ?? 50,
        page: listOptions.page ?? 1,
        order_by: listOptions.orderBy ?? 'name',
        sort: listOptions.sort ?? 'asc',
      })
    },

    /** GET /projects/:id/repository/commits（提交分页） */
    async listCommits(projectId, listOptions = {}) {
      return requestList(`${projectPath(projectId)}/repository/commits`, {
        page: listOptions.page ?? 1,
        per_page: listOptions.perPage ?? 100,
        all: listOptions.all === false ? 'false' : 'true',
        order_by: listOptions.orderBy ?? 'created_at',
        sort: listOptions.sort ?? 'desc',
        since: listOptions.since,
        until: listOptions.until,
      })
    },

    /** GET /projects/:id/repository/commits/:sha（detail，含 stats） */
    async getCommit(projectId, sha) {
      const id = String(sha ?? '').trim()
      if (!id) throw new GitLabError('commit sha 不能为空', { code: 'config' })
      const { body } = await request(`${projectPath(projectId)}/repository/commits/${encodeURIComponent(id)}`)
      if (!body || typeof body !== 'object') {
        throw new GitLabError('GitLab commit detail 返回空响应', { code: 'parse' })
      }
      return body
    },

    /** GET /projects/:id/repository/commits/:sha/refs?type=branch（数组顺序即 branch_order） */
    async getCommitRefs(projectId, sha) {
      const id = String(sha ?? '').trim()
      if (!id) throw new GitLabError('commit sha 不能为空', { code: 'config' })
      const { body } = await request(
        `${projectPath(projectId)}/repository/commits/${encodeURIComponent(id)}/refs`,
        { query: { type: 'branch' } },
      )
      return Array.isArray(body) ? body : []
    },
  }
}
