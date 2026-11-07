/**
 * @local/dsh-report · Server 侧 JSON API（Client 页面唯一数据来源）
 *
 * 契约来源：`CONTRACTS.md` §5（HTTP 端点表）。路径前缀 `/plugins/dsh-report/api`，
 * 由 index.js 以 `ctx.webServer.register({ kind:'prefix', path, handler })` 挂载；
 * 本文件只负责路由 + 参数校验 + JSON 投影，不持有任何 HTTP 框架依赖。
 *
 * 约定：
 *   - 成功：JSON（`content-type: application/json; charset=utf-8`），字段一律 camelCase
 *     （DB 的 snake_case 在本层完成映射，CONTRACTS §5）。
 *   - 失败：`{ error: <机器码>, message: <中文说明> }` + 4xx/5xx；
 *     机器码 ∈ `validation | not-found | permission | internal | method-not-allowed`。
 *   - 导出例外：`/reports/:id/export` 返回 `text/markdown`（与 workbench 一致）。
 *
 * deps（index.js 接线；缺省项有回退）：
 * ```js
 * {
 *   db, store, domain, syncService,          // 见 lib/tools.js 文件头
 *   getConfig, updateConfig, resolveToken, saveToken,
 *   connections?,   // 可选连接端口 { list(), create({baseUrl,token,displayName}) }
 *   gitlab?,        // 可选 GitLab 客户端（POST /gitlab/connections 时校验 /user）
 *   logger, build, dbPath, dataDir, node,
 * }
 * ```
 *
 * @module @local/dsh-report/lib/api
 */

import { createHash } from 'node:crypto'

import {
  REPORT_TYPES,
  ReportError,
  createRuntime,
  loadReportDetail,
  loadReportList,
  loadReportStats,
  parsePeriodArgs,
  readCommits,
  storeCall,
  syncCall,
  toCamelRow,
} from './tools.js'

/** 与 index.js 共用的路由前缀。 */
export const API_PREFIX = '/plugins/dsh-report/api'

/** JSON 请求体上限（防止误发大文件）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** sync jobs 列表缺省条数。 */
const DEFAULT_JOB_LIMIT = 30

/* ---------------------------------------------------------------- 基础输出 */

/**
 * @param {any} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function sendJSON(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * @param {any} res
 * @param {number} status
 * @param {string} body
 * @param {Record<string, string>} [headers]
 */
function sendText(res, status, body, headers = {}) {
  res.statusCode = status
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.end(body)
}

/**
 * 错误 → { status, code } 映射（与 lib/tools.js 的 ReportErrorCode 对齐）。
 *
 * @param {unknown} error
 * @returns {{ status: number, code: string }}
 */
function mapError(error) {
  const code = error instanceof ReportError ? error.code : 'INTERNAL'
  switch (code) {
    case 'VALIDATION':
      return { status: 400, code: 'validation' }
    case 'NOT_FOUND':
      return { status: 404, code: 'not-found' }
    case 'PERMISSION':
      return { status: 403, code: 'permission' }
    default:
      return { status: 500, code: 'internal' }
  }
}

/* ---------------------------------------------------------------- 入参读取 */

/**
 * 读取 JSON body。支持宿主预解析的 `req.body`（便于测试与非 Node 载体）。
 *
 * @param {any} req
 * @returns {Promise<Record<string, any>>}
 */
function readJSONBody(req) {
  if (req && req.body !== undefined) {
    if (req.body === null || req.body === '') return Promise.resolve({})
    if (typeof req.body === 'object') return Promise.resolve(req.body)
    try {
      const parsed = JSON.parse(String(req.body))
      return Promise.resolve(parsed && typeof parsed === 'object' ? parsed : {})
    } catch (error) {
      return Promise.reject(new ReportError(`JSON 解析失败：${error.message}`, 'VALIDATION'))
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ReportError('请求体过大（>8MB）', 'VALIDATION'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new ReportError(`JSON 解析失败：${error.message}`, 'VALIDATION'))
      }
    })
    req.on('error', (error) => reject(new ReportError(String(error?.message ?? error), 'INTERNAL')))
  })
}

/**
 * 字符串取值（trim，非字符串转换）。
 *
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 从对象里按顺序取第一个非空字符串。
 *
 * @param {Record<string, any> | null | undefined} row
 * @param {...string} keys
 * @returns {string}
 */
function pickText(row, ...keys) {
  if (!row || typeof row !== 'object') return ''
  for (const key of keys) {
    const value = text(row[key])
    if (value) return value
  }
  return ''
}

/**
 * 整数 query 参数。
 *
 * @param {URLSearchParams} params
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function intParam(params, key, fallback) {
  const raw = params.get(key)
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

/** `YYYY-MM-DD`。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 校验 query 里的日期（可空）。空值返回 ''。
 *
 * @param {URLSearchParams} params
 * @param {string} key
 * @returns {string}
 */
function dateParam(params, key) {
  const raw = (params.get(key) ?? '').trim()
  if (!raw) return ''
  if (!DATE_RE.test(raw)) throw new ReportError(`${key} 必须是 YYYY-MM-DD 格式`, 'VALIDATION')
  return raw
}

/* ------------------------------------------------------------------ 视图 */

/**
 * 已选项目行 → `{ id, pathWithNamespace, name, enabled }`（CONTRACTS §5.1）。
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function toSelectedProject(row) {
  const camel = toCamelRow(row ?? {})
  const enabled = camel.enabled
  return {
    id: camel.projectId ?? camel.id ?? camel.remoteId ?? null,
    pathWithNamespace: camel.pathWithNamespace ?? '',
    name: camel.name ?? '',
    enabled: enabled === undefined || enabled === null ? 1 : Number(enabled),
  }
}

/**
 * GitLab 候选项目 → `{ id, pathWithNamespace, name }`。
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function toProjectView(row) {
  const camel = toCamelRow(row ?? {})
  return {
    id: camel.id ?? camel.projectId ?? camel.remoteId ?? null,
    pathWithNamespace: camel.pathWithNamespace ?? '',
    name: camel.name ?? '',
    ...(camel.namespace ? { namespace: camel.namespace } : {}),
    ...(camel.webUrl ? { webUrl: camel.webUrl } : {}),
  }
}

/**
 * 同步任务行 → SyncJobView（CONTRACTS §5.1 + §5.3.1）。
 *
 * 投影规则：
 *   - `progress` 统一成 `{ projectsDone, projectsTotal, commitsSynced, currentProject? }`
 *     （db 层字段是 syncedProjects / totalProjects / commitsSynced / currentProject）；
 *   - `startDate`/`endDate` 从 `scope_json` 解析（可能缺失 → 省略，UI 回退 connectionId）；
 *   - 保持 camelCase 输出，保留 connectionId。
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function toJobView(row) {
  const camel = toCamelRow(row ?? {})
  const progressRaw = asObject(parseMaybeJSON(camel.progress ?? camel.progressJson))
  const scopeRaw = asObject(parseMaybeJSON(camel.scope ?? camel.scopeJson))

  /** @type {Record<string, any>} */
  const progress = {
    projectsDone: numberOrZero(progressRaw.syncedProjects ?? progressRaw.projectsDone),
    projectsTotal: numberOrZero(progressRaw.totalProjects ?? progressRaw.projectsTotal),
    commitsSynced: numberOrZero(progressRaw.commitsSynced ?? progressRaw.totalCommits),
  }
  const currentProject = progressRaw.currentProject ?? camel.currentProjectName
  if (currentProject !== undefined && currentProject !== null && currentProject !== '') {
    progress.currentProject = currentProject
  }
  // 可选：部分失败标记（来自 progress.partial 或 incompleteProjects 任一；无值不输出）。
  /** @type {boolean | undefined} */
  let partial
  if (typeof progressRaw.partial === 'boolean') partial = progressRaw.partial
  else if (progressRaw.incompleteProjects !== undefined && progressRaw.incompleteProjects !== null) {
    partial = numberOrZero(progressRaw.incompleteProjects) > 0
  }
  if (partial !== undefined) progress.partial = partial
  // 可选：错误条数（来自 progress.errors / errorCount，或 job 的错误明细条数；无值不输出）。
  /** @type {number | undefined} */
  let errors
  if (progressRaw.errors !== undefined && progressRaw.errors !== null) errors = numberOrZero(progressRaw.errors)
  else if (Array.isArray(camel.errors)) errors = camel.errors.length
  else if (progressRaw.errorCount !== undefined && progressRaw.errorCount !== null) {
    errors = numberOrZero(progressRaw.errorCount)
  }
  if (errors !== undefined && Number.isFinite(errors)) progress.errors = errors

  /** @type {Record<string, any>} */
  const view = {
    jobId: camel.jobId ?? null,
    connectionId: camel.connectionId ?? '',
    status: camel.status ?? '',
    startedAt: camel.startedAt ?? null,
    finishedAt: camel.finishedAt ?? null,
    progress,
    error: camel.error ?? null,
  }
  const startDate = typeof scopeRaw.startDate === 'string' ? scopeRaw.startDate : ''
  const endDate = typeof scopeRaw.endDate === 'string' ? scopeRaw.endDate : ''
  if (startDate) view.startDate = startDate
  if (endDate) view.endDate = endDate
  return view
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOrZero(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function parseMaybeJSON(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/* --------------------------------------------------------------- 各端点 */

/**
 * GET /ping
 *
 * @param {import('./tools.js').ReportRuntime} rt
 */
async function handlePing(rt) {
  let reportCount = 0
  try {
    reportCount = (await loadReportList(rt)).length
  } catch {
    reportCount = 0
  }
  return {
    ok: true,
    build: rt.build,
    node: rt.node,
    dbPath: rt.dbPath,
    dbAvailable: rt.dbAvailable,
    reports: reportCount,
    timezone: rt.config().timezone ?? null,
  }
}

/**
 * 配置 → GET /config 视图（token 只暴露 hasToken）。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @returns {Promise<Record<string, any>>}
 */
async function configPayload(rt) {
  const cfg = rt.config()
  const gitlab = cfg.gitlab && typeof cfg.gitlab === 'object' ? cfg.gitlab : {}
  let hasToken = false
  try {
    const rows = await listConnectionRows(rt)
    if (rows && rows.length) {
      for (const row of rows) {
        const id = String(toCamelRow(row).connectionId ?? toCamelRow(row).connection_id ?? '')
        if (id && (await tokenPresent(rt, id))) {
          hasToken = true
          break
        }
      }
    } else {
      hasToken = await tokenPresent(rt)
    }
  } catch {
    hasToken = false
  }
  return {
    gitlab: {
      baseUrl: text(gitlab.baseUrl),
      tokenRef: text(gitlab.tokenRef),
      hasToken,
      authorAliases: Array.isArray(gitlab.authorAliases) ? gitlab.authorAliases : [],
    },
    timezone: text(cfg.timezone) || 'Asia/Shanghai',
    defaultReportType: REPORT_TYPES.includes(text(cfg.defaultReportType)) ? text(cfg.defaultReportType) : 'week',
    dataDir: text(cfg.dataDir) || rt.dataDir,
  }
}

/**
 * PUT /config：只更新请求里出现的字段；token 走 saveToken（不落明文配置）。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} body
 */
async function saveConfig(rt, body) {
  /** @type {Record<string, any>} */
  const patch = {}
  if (body.timezone !== undefined) {
    const timezone = text(body.timezone)
    if (!timezone) throw new ReportError('timezone 不能为空字符串', 'VALIDATION')
    patch.timezone = timezone
  }
  if (body.defaultReportType !== undefined) {
    const type = text(body.defaultReportType)
    if (!REPORT_TYPES.includes(type)) {
      throw new ReportError(`defaultReportType 必须是 ${REPORT_TYPES.join(' / ')}`, 'VALIDATION')
    }
    patch.defaultReportType = type
  }
  let token = ''
  if (body.gitlab !== undefined) {
    if (!body.gitlab || typeof body.gitlab !== 'object') {
      throw new ReportError('gitlab 必须是对象', 'VALIDATION')
    }
    /** @type {Record<string, any>} */
    const gitlab = {}
    if (body.gitlab.baseUrl !== undefined) {
      const baseUrl = text(body.gitlab.baseUrl)
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
        throw new ReportError('gitlab.baseUrl 需要 http(s):// 前缀', 'VALIDATION')
      }
      gitlab.baseUrl = baseUrl
    }
    if (body.gitlab.displayName !== undefined) gitlab.displayName = text(body.gitlab.displayName)
    if (Object.keys(gitlab).length > 0) patch.gitlab = gitlab
    if (body.gitlab.token !== undefined) token = text(body.gitlab.token)
  }
  if (Object.keys(patch).length === 0 && !token) {
    throw new ReportError('没有可更新的字段（gitlab / timezone / defaultReportType）', 'VALIDATION')
  }
  if (Object.keys(patch).length > 0) await rt.updateConfig(patch)
  if (token) await rt.saveToken(token)
  return configPayload(rt)
}

/**
 * GET /reports
 *
 * @param {import('./tools.js').ReportRuntime} rt
 */
async function handleListReports(rt) {
  return { reports: await loadReportList(rt) }
}

/**
 * GET /reports/:id
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {string} reportId
 * @param {URLSearchParams} params
 */
async function handleGetReport(rt, reportId, params) {
  const raw = params.get('includeContent')
  const includeContent = !(raw === '0' || /^false$/i.test(raw ?? ''))
  const detail = await loadReportDetail(rt, reportId, { includeContent })
  if (!detail) throw new ReportError(`报告不存在：${reportId}`, 'NOT_FOUND')
  return detail
}

/**
 * GET /reports/:id/stats
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {string} reportId
 */
async function handleReportStats(rt, reportId) {
  const found = await loadReportStats(rt, reportId)
  if (!found) throw new ReportError(`报告不存在：${reportId}`, 'NOT_FOUND')
  return found
}

/**
 * DELETE /reports/:id
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {string} reportId
 */
async function handleDeleteReport(rt, reportId) {
  const deleted = Boolean(await storeCall(rt, 'deleteReportRow', reportId))
  if (!deleted) throw new ReportError(`报告不存在：${reportId}`, 'NOT_FOUND')
  return { deleted: true, reportId }
}

/**
 * GET /reports/:id/export（text/markdown，不走 JSON）
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {string} reportId
 * @param {URLSearchParams} params
 * @param {any} res
 */
async function handleExport(rt, reportId, params, res) {
  const format = (params.get('format') ?? 'markdown').toLowerCase()
  if (format !== 'markdown' && format !== 'md') {
    throw new ReportError('只支持 markdown 导出（format=markdown）', 'VALIDATION')
  }
  const detail = await loadReportDetail(rt, reportId, { includeContent: true })
  if (!detail) throw new ReportError(`报告不存在：${reportId}`, 'NOT_FOUND')
  const body = typeof detail.content === 'string' ? detail.content : ''
  if (!body.trim()) throw new ReportError('报告正文为空，无法导出', 'VALIDATION')
  const filename = `${detail.type}-${detail.periodStart}-${detail.periodEnd}.md`
  sendText(res, 200, body, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename*=UTF-8''${filename}`,
    'cache-control': 'no-store',
  })
}

/**
 * POST /reports/generate（CONTRACTS §5.2）：创建/复用一个 Agent 会话去写报告。
 *
 * 本文件不直接依赖 DSH 会话 API：由 index.js 注入 `createReportSession`
 * （async ({ type, startDate, endDate, guidance }) => ({ sessionId })）。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} deps
 * @param {Record<string, any>} body
 */
async function generateReport(rt, deps, body) {
  const period = parsePeriodArgs(body)
  const guidance = text(body.guidance)
  const create = deps.createReportSession ?? deps.createSession
  if (typeof create !== 'function') {
    throw new ReportError('生成会话不可用：index.js 未注入 createReportSession', 'INTERNAL')
  }
  const created = (await create({ ...period, guidance })) ?? {}
  const sessionId = pickText(created, 'sessionId', 'session_id', 'id')
  if (!sessionId) throw new ReportError('createReportSession 未返回 sessionId', 'INTERNAL')
  const reportId = pickText(created, 'reportId') || `${period.type}:${period.startDate}:${period.endDate}`
  rt.log('report-generate', { reportId, sessionId })
  return { reportId, sessionId }
}

/**
 * GET /reports/day-commits?date=YYYY-MM-DD&repo=（CONTRACTS §5 + §5.1 的 DayCommitPage）
 *
 * 统计页点开某一天：读当天的提交（listCommitsInPeriod 同日起止）→ 交给
 * `domain.dayCommits(commits, date, repoKey)` 做时区/排序/200 条上限/仓库过滤。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {URLSearchParams} params
 */
async function handleDayCommits(rt, params) {
  const date = (params.get('date') ?? '').trim()
  if (!DATE_RE.test(date)) {
    throw new ReportError('date 必须是 YYYY-MM-DD 格式（例：2026-11-05）', 'VALIDATION')
  }
  const repo = (params.get('repo') ?? '').trim()
  const build = rt.domain && rt.domain.dayCommits
  if (typeof build !== 'function') {
    throw new ReportError('domain.dayCommits 不可用（lib/domain/dayCommits.js 未实现或未注入）', 'INTERNAL')
  }
  const commits = await readCommits(rt, date, date)
  const page = (await build(commits, date, repo)) ?? {}
  const list = Array.isArray(page.commits) ? page.commits : []
  const total = Number(page.total)
  return {
    date: typeof page.date === 'string' && page.date ? page.date : date,
    repo: typeof page.repo === 'string' ? page.repo : repo,
    total: Number.isFinite(total) ? total : list.length,
    truncated: Boolean(page.truncated),
    commits: list,
  }
}

/**
 * GET /line-stats（实时统计；可选 include/fields/limit 裁剪，裁剪由 domain 负责）
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {URLSearchParams} params
 */
async function handleLineStats(rt, params) {
  const startDate = (params.get('startDate') ?? '').trim()
  const endDate = (params.get('endDate') ?? '').trim()
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new ReportError('startDate 与 endDate 必须是 YYYY-MM-DD 格式', 'VALIDATION')
  }
  if (startDate > endDate) throw new ReportError('startDate 不能晚于 endDate', 'VALIDATION')
  const build = rt.domain && rt.domain.buildRealtimeAnalytics
  if (typeof build !== 'function') throw new ReportError('domain.buildRealtimeAnalytics 不可用', 'INTERNAL')
  const commits = await readCommits(rt, startDate, endDate)
  const fields = (params.get('fields') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return build(startDate, endDate, commits, {
    include: (params.get('include') ?? '').trim() || 'excludeMerge',
    fields,
    limit: intParam(params, 'limit', 0),
  })
}

/**
 * GET /templates：配置覆盖 + domain 默认值。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 */
function templatesPayload(rt) {
  const cfg = rt.config()
  const overrides = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : {}
  const guidance = cfg.guidance && typeof cfg.guidance === 'object' ? cfg.guidance : {}
  const defaults = rt.domain && typeof rt.domain === 'object' ? rt.domain : {}
  /** @type {Record<string, string>} */
  const templates = {}
  /** @type {Record<string, string>} */
  const guidances = {}
  for (const type of REPORT_TYPES) {
    templates[type] = text(overrides[type]) || text(defaults.DEFAULT_TEMPLATES?.[type])
    guidances[type] = text(guidance[type]) || text(defaults.DEFAULT_GUIDANCE?.[type])
  }
  return { templates, guidance: guidances }
}

/**
 * PUT /templates：**部分更新**（CONTRACTS §5.3.3）。
 *
 *   - 只覆盖请求里出现的键；省略键保持原覆盖值；
 *   - `''`（空字符串）表示清除该类型的覆盖，回退内置默认；
 *   - 响应返回生效后的完整 `{ templates, guidance }`。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} body
 */
async function saveTemplates(rt, body) {
  const cfg = rt.config()
  /** @type {Record<string, string>} */
  const templates = { ...(asObject(cfg.templates)) }
  /** @type {Record<string, string>} */
  const guidance = { ...(asObject(cfg.guidance)) }
  let touched = false
  for (const [field, target] of [
    ['templates', templates],
    ['guidance', guidance],
  ]) {
    const incoming = body[field]
    if (incoming === undefined) continue
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new ReportError(`${field} 必须是对象：{ week, month, quarter, year }`, 'VALIDATION')
    }
    for (const type of REPORT_TYPES) {
      if (incoming[type] === undefined) continue
      if (typeof incoming[type] !== 'string') {
        throw new ReportError(`${field}.${type} 必须是字符串`, 'VALIDATION')
      }
      touched = true
      // 空字符串 = 清除覆盖（回退内置默认）；否则写入新覆盖。
      if (incoming[type].trim() === '') delete target[type]
      else target[type] = incoming[type]
    }
  }
  if (!touched) throw new ReportError('templates / guidance 至少给一个', 'VALIDATION')
  await rt.updateConfig({ templates, guidance })
  return templatesPayload(rt)
}

/**
 * 规范化 GitLab baseUrl：trim + 去掉尾部斜杠（同一 URL 必须得到同一个 id）。
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBaseUrl(value) {
  return text(value).replace(/\/+$/, '')
}

/**
 * 连接 ID 派生规则（CONTRACTS §5.3.2）：`sha256(baseUrl)` 前 24 位十六进制。
 *
 * @param {string} baseUrl 已规范化的 baseUrl
 * @returns {string}
 */
export function deriveConnectionId(baseUrl) {
  return createHash('sha256').update(String(baseUrl)).digest('hex').slice(0, 24)
}

/**
 * 当前进程是否已持有 GitLab token（credentials 记录 `dsh-report/gitlab-token`）。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @returns {Promise<boolean>}
 */
async function tokenPresent(rt, connectionId) {
  try {
    return Boolean(await rt.resolveToken(connectionId ? { connectionId } : undefined))
  } catch {
    return false
  }
}

/**
 * 读 connections 表（db.js 未提供时返回 null，调用方回退到配置派生）。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @returns {Promise<Array<Record<string, any>> | null>}
 */
async function listConnectionRows(rt) {
  const fn = rt.store && rt.store.listConnections
  if (typeof fn !== 'function') return null
  try {
    const rows = await fn(rt.handle)
    return Array.isArray(rows) ? rows : []
  } catch (error) {
    rt.log('connections-list-failed', { message: String(error?.message ?? error) })
    return null
  }
}

/**
 * 读单条连接记录。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {string} connectionId
 * @returns {Promise<Record<string, any> | null>}
 */
async function readConnectionRow(rt, connectionId) {
  const fn = rt.store && rt.store.getConnection
  if (typeof fn !== 'function') return null
  try {
    return (await fn(rt.handle, connectionId)) ?? null
  } catch {
    return null
  }
}

/**
 * upsert connections 表。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {{ connectionId: string, baseUrl: string, displayName: string, username: string }} row
 */
async function upsertConnectionRow(rt, row) {
  const fn = rt.store && rt.store.upsertConnection
  if (typeof fn !== 'function') {
    throw new ReportError('db.upsertConnection 不可用（lib/db.js 未实现或未注入）', 'INTERNAL')
  }
  await fn(rt.handle, row)
}

/**
 * 取一个 GitLab 客户端：优先注入（实例或工厂），否则动态加载同目录 gitlab.js。
 *
 * @param {Record<string, any>} deps
 * @param {{ baseUrl: string, token: string }} credentials
 * @returns {Promise<{ getCurrentUser: () => Promise<Record<string, any>> }>}
 */
async function resolveGitLabClient(deps, credentials) {
  const injected = deps.gitlab
  if (injected && typeof injected.getCurrentUser === 'function') return injected
  if (typeof injected === 'function') return injected(credentials)
  if (typeof deps.createGitLabClient === 'function') return deps.createGitLabClient(credentials)
  try {
    const module = await import('./gitlab.js')
    if (typeof module.createGitLabClient === 'function') return module.createGitLabClient(credentials)
  } catch (error) {
    throw new ReportError(
      `GitLab 客户端加载失败：${error?.message ?? error}（index.js 需注入 gitlab 或 createGitLabClient）`,
      'INTERNAL',
    )
  }
  throw new ReportError('没有可用的 GitLab 客户端（index.js 需注入 gitlab 或 createGitLabClient）', 'INTERNAL')
}

/**
 * GET /gitlab/connections：优先读 connections 表，其次按配置派生单连接。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} deps
 */
async function listConnections(rt, deps) {
  const port = deps.connections
  if (port && typeof port.list === 'function') {
    const items = (await port.list()) ?? []
    return {
      connections: (Array.isArray(items) ? items : []).map((item) => {
        const camel = toCamelRow(item ?? {})
        return {
          id: String(camel.id ?? camel.connectionId ?? 'default'),
          baseUrl: camel.baseUrl ?? '',
          displayName: camel.displayName ?? '',
          username: camel.username ?? '',
          hasToken: Boolean(camel.hasToken),
        }
      }),
    }
  }

  const rows = await listConnectionRows(rt)
  if (rows && rows.length > 0) {
    return {
      connections: await Promise.all(
        rows.map(async (row) => {
          const camel = toCamelRow(row)
          const id = String(camel.connectionId ?? camel.connection_id ?? 'default')
          return {
            id,
            baseUrl: camel.baseUrl ?? '',
            displayName: camel.displayName ?? '',
            username: camel.username ?? '',
            hasToken: await tokenPresent(rt, id),
          }
        }),
      ),
    }
  }
  const hasToken = await tokenPresent(rt)

  const cfg = rt.config()
  const gitlab = asObject(cfg.gitlab)
  const baseUrl = text(gitlab.baseUrl)
  if (!baseUrl) return { connections: [] }
  return {
    connections: [
      {
        id: text(gitlab.connectionId) || deriveConnectionId(normalizeBaseUrl(baseUrl)),
        baseUrl,
        displayName: text(gitlab.displayName) || baseUrl,
        username: text(gitlab.username),
        hasToken,
      },
    ],
  }
}

/**
 * POST /gitlab/connections：**幂等 upsert + 校验**（CONTRACTS §5.3.2）。
 *
 *   - 有 token：先 `GET /user` 验证，再按 `sha256(baseUrl)[:24]` upsert connections 表；
 *   - 无 token：只回读已有记录（不写库、不联网），`hasToken=false`；
 *   - 响应固定 `{ connection: { id, baseUrl, username, hasToken } }`。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} deps
 * @param {Record<string, any>} body
 */
async function createConnection(rt, deps, body) {
  const baseUrl = normalizeBaseUrl(body.baseUrl)
  if (!baseUrl) throw new ReportError('baseUrl 必填', 'VALIDATION')
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ReportError('baseUrl 需要 http(s):// 前缀', 'VALIDATION')
  }
  const token = text(body.token)
  const displayName = text(body.displayName)
  const connectionId = deriveConnectionId(baseUrl)

  // 无 token：只返回已有记录，hasToken=false（不写库、不联网）。
  if (!token) {
    const existing = await readConnectionRow(rt, connectionId)
    const camel = toCamelRow(existing ?? {})
    return {
      connection: {
        id: String(camel.connectionId ?? connectionId),
        baseUrl: camel.baseUrl || baseUrl,
        username: camel.username ?? '',
        hasToken: false,
      },
    }
  }

  // 有 token：先验证 /user，验证失败不得写库。
  const client = await resolveGitLabClient(deps, { baseUrl, token })
  let user
  try {
    user = await client.getCurrentUser()
  } catch (error) {
    throw new ReportError(`GitLab /user 校验失败：${error?.message ?? error}`, 'VALIDATION')
  }
  const username = pickText(user, 'username', 'login', 'name')

  // token 先落 credentials（失败即中止，避免写了连接却没有凭据）。
  try {
    await rt.saveToken(token, connectionId)
  } catch (error) {
    throw new ReportError(`token 保存失败：${error?.message ?? error}`, 'INTERNAL')
  }
  await upsertConnectionRow(rt, {
    connectionId,
    baseUrl,
    displayName: displayName || username || baseUrl,
    username,
  })
  // 配置里的 gitlab.baseUrl 只是展示/兼容用途；写失败不影响连接本身。
  try {
    await rt.updateConfig({ gitlab: { baseUrl, ...(displayName ? { displayName } : {}) } })
  } catch (error) {
    rt.log('config-sync-failed', { message: String(error?.message ?? error) })
  }

  return {
    connection: { id: connectionId, baseUrl, username, hasToken: true },
  }
}

/**
 * GET /gitlab/projects
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {URLSearchParams} params
 */
async function listProjects(rt, params) {
  const connectionId = (params.get('connectionId') ?? '').trim()
  const q = (params.get('q') ?? '').trim()
  const refresh = (params.get('refresh') ?? '').toLowerCase()
  const rows = await syncCall(rt, 'listCandidates', {
    connectionId,
    q,
    refresh: refresh === '1' || refresh === 'true',
  })
  return { projects: (Array.isArray(rows) ? rows : []).map(toProjectView) }
}

/**
 * GET /gitlab/selection
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {URLSearchParams} params
 */
async function getSelection(rt, params) {
  const connectionId = (params.get('connectionId') ?? '').trim()
  const rows = await syncCall(rt, 'getSelection', connectionId)
  return { projects: (Array.isArray(rows) ? rows : []).map(toSelectedProject) }
}

/**
 * PUT /gitlab/selection
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} body
 */
async function putSelection(rt, body) {
  const connectionId = text(body.connectionId)
  if (!Array.isArray(body.projects)) {
    throw new ReportError('projects 必须是数组', 'VALIDATION')
  }
  const projects = body.projects.map((item) => {
    if (!item || typeof item !== 'object') throw new ReportError('projects 的每一项必须是对象', 'VALIDATION')
    const id = item.id ?? item.projectId ?? item.project_id
    const projectId = Number(id)
    if (!Number.isFinite(projectId) || projectId <= 0) {
      throw new ReportError('每个 project 需要正整数 id', 'VALIDATION')
    }
    const pathWithNamespace = text(item.pathWithNamespace) || text(item.path_with_namespace)
    const name = text(item.name)
    // 同时给出 camelCase 与 snake_case：lib/sync.js 的 saveSelection 无论按哪种 casing 读都能取到。
    return {
      projectId,
      project_id: projectId,
      id: projectId,
      pathWithNamespace,
      path_with_namespace: pathWithNamespace,
      name,
    }
  })
  await syncCall(rt, 'saveSelection', connectionId, projects)
  return { saved: true, count: projects.length }
}

/**
 * DELETE /gitlab/token：清掉本机凭据库里的 GitLab token。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 */
/**
 * DELETE /gitlab/connections/:id：删除连接与仓库范围，并清掉该连接的 token。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} deps
 * @param {string} connectionId
 */
async function removeConnection(rt, deps, connectionId) {
  const id = text(connectionId)
  if (!id) throw new ReportError('connectionId 必填', 'VALIDATION')
  const port = deps.connections
  if (port && typeof port.remove === 'function') {
    return { connection: await port.remove(id) }
  }
  const fn = rt.store && rt.store.deleteConnection
  if (typeof fn !== 'function') {
    throw new ReportError('db.deleteConnection 不可用（无法删除连接）', 'INTERNAL')
  }
  const result = await fn(rt.handle, id)
  if (typeof rt.clearToken === 'function') await rt.clearToken(id)
  return { connection: { removed: Boolean(result && result.removed) } }
}

async function clearGitlabToken(rt, params) {
  const connectionId = text(params && params.get ? params.get('connectionId') : '')
  if (typeof rt.clearToken === 'function') await rt.clearToken(connectionId || undefined)
  return { cleared: true, connectionId }
}

/**
 * GET /gitlab/author-aliases：已保存的「提交作者别名」。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 */
async function getAuthorAliases(rt) {
  const aliases = typeof rt.getAuthorAliases === 'function' ? await rt.getAuthorAliases() : []
  return { aliases: Array.isArray(aliases) ? aliases : [] }
}

function parseAliasesBody(body) {
  const raw = Array.isArray(body?.aliases) ? body.aliases : String(body?.aliases ?? '').split(/[\n,，;；]+/)
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const value = String(item ?? '').trim()
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/**
 * PUT /gitlab/author-aliases：保存别名列表。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} body
 */
async function putAuthorAliases(rt, body) {
  if (typeof rt.setAuthorAliases !== 'function') throw new ReportError('当前 profile 不支持保存作者别名', 'VALIDATION')
  const saved = await rt.setAuthorAliases(parseAliasesBody(body))
  return { aliases: Array.isArray(saved) ? saved : [], saved: true }
}

/**
 * POST /gitlab/suggest-author-aliases：从最近 push 头提交推断作者别名。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} body
 */
async function suggestAuthorAliases(rt, body) {
  if (typeof rt.suggestAuthorAliases !== 'function') throw new ReportError('当前 profile 不支持推断作者别名', 'VALIDATION')
  const connectionIds = Array.isArray(body?.connectionIds)
    ? body.connectionIds
    : Array.isArray(body?.connection_ids)
      ? body.connection_ids
      : []
  const existingAliases = Array.isArray(body?.existingAliases)
    ? body.existingAliases
    : Array.isArray(body?.existing_aliases)
      ? body.existing_aliases
      : []
  try {
    return await rt.suggestAuthorAliases({ connectionIds, existingAliases })
  } catch (error) {
    throw new ReportError(String(error?.message ?? error), 'VALIDATION')
  }
}

/**
 * GET /sync/coverage（CONTRACTS §5.1）
 *
 * sync.js 的原始形状是 `summary.repoCount/commitCount/activeDayCount/firstCommitDate/
 * lastCommitDate`、`repos[].pathWithNamespace`，而 Client 同步页按约定读
 * `summary.{commits,additions,deletions,days,repos}` 与 `repos[].{repoKey,commitCount,
 * additions,deletions}`。这里做一层**兼容映射**：原字段原样保留，只追加约定键。
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {URLSearchParams} params
 */
async function getCoverage(rt, params) {
  const connectionId = (params.get('connectionId') ?? '').trim()
  const startDate = dateParam(params, 'startDate')
  const endDate = dateParam(params, 'endDate')
  if (startDate && endDate && startDate > endDate) {
    throw new ReportError('startDate 不能晚于 endDate', 'VALIDATION')
  }
  const coverage = (await syncCall(rt, 'coverage', { connectionId, startDate, endDate })) ?? {}
  const summary = toCamelRow(asObject(coverage.summary ?? coverage.Summary))
  const repoRows = coverage.repos ?? coverage.Repos
  const repos = (Array.isArray(repoRows) ? repoRows : []).map(toCamelRow)
  const distribution = coverage.dateDistribution ?? coverage.date_distribution

  // summary：原字段 + 约定键（缺失一律 0，不伪造/不推算其它数字）。
  const mappedSummary = {
    ...summary,
    commits: numberOrZero(summary.commitCount ?? summary.commits),
    days: numberOrZero(summary.activeDayCount ?? summary.days),
    repos: numberOrZero(summary.repoCount ?? summary.repos),
    additions: numberOrZero(summary.additions),
    deletions: numberOrZero(summary.deletions),
  }
  // repos：repoKey = pathWithNamespace || projectId；additions/deletions 缺失记 0。
  const mappedRepos = repos.map((repo) => ({
    ...repo,
    repoKey:
      pickText(repo, 'pathWithNamespace', 'repoKey') ||
      (repo.projectId !== undefined && repo.projectId !== null ? String(repo.projectId) : ''),
    commitCount: numberOrZero(repo.commitCount),
    additions: numberOrZero(repo.additions),
    deletions: numberOrZero(repo.deletions),
  }))

  /** @type {Record<string, any>} */
  const payload = {
    summary: mappedSummary,
    repos: mappedRepos,
    dateDistribution: (Array.isArray(distribution) ? distribution : []).map(toCamelRow),
  }
  // 其余原字段原样保留（不参与约定，但别的消费方可能在用）。
  if (coverage.connectionId !== undefined) payload.connectionId = coverage.connectionId
  if (coverage.range !== undefined) payload.range = toCamelRow(asObject(coverage.range))
  return payload
}

/**
 * GET /sync/jobs
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {URLSearchParams} params
 */
async function listJobs(rt, params) {
  const limit = Math.min(Math.max(intParam(params, 'limit', DEFAULT_JOB_LIMIT), 1), 200)
  const rows = (await storeCall(rt, 'listSyncJobs', limit)) ?? []
  return { jobs: (Array.isArray(rows) ? rows : []).map(toJobView) }
}

/**
 * POST /sync/start
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} body
 */
async function startSync(rt, body) {
  const startDate = text(body.startDate) || text(body.since)
  const endDate = text(body.endDate) || text(body.until)
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new ReportError('startDate 与 endDate 必须是 YYYY-MM-DD 格式', 'VALIDATION')
  }
  if (startDate > endDate) throw new ReportError('startDate 不能晚于 endDate', 'VALIDATION')
  let projectIds
  if (body.projectIds !== undefined) {
    if (!Array.isArray(body.projectIds)) throw new ReportError('projectIds 必须是数组', 'VALIDATION')
    projectIds = body.projectIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
  }
  const job = await syncCall(rt, 'start', {
    connectionId: text(body.connectionId),
    startDate,
    endDate,
    ...(projectIds ? { projectIds } : {}),
  })
  const camel = toCamelRow(job ?? {})
  const jobId = camel.jobId ?? camel.job_id ?? camel.id ?? (typeof job === 'string' ? job : '')
  return { jobId: jobId ? String(jobId) : null, status: camel.status ?? null }
}

/**
 * POST /sync/cancel
 *
 * @param {import('./tools.js').ReportRuntime} rt
 * @param {Record<string, any>} body
 */
async function cancelSync(rt, body) {
  const jobId = text(body.jobId) || text(body.job_id)
  if (!jobId) throw new ReportError('jobId 必填', 'VALIDATION')
  const cancelled = await syncCall(rt, 'cancel', jobId)
  return { cancelled: cancelled === undefined ? true : Boolean(cancelled), jobId }
}

/* ------------------------------------------------------------------ 路由 */

/**
 * 路由表。pattern 匹配 `/api` 之后的相对路径（尾部斜杠已规范化）。
 *
 * @typedef {{ method: string, pattern: RegExp, handle: (ctx: RouteContext) => Promise<any> | any }} Route
 */

/**
 * @typedef {object} RouteContext
 * @property {import('./tools.js').ReportRuntime} rt
 * @property {Record<string, any>} deps
 * @property {URLSearchParams} params
 * @property {(index: number) => string} capture
 * @property {any} req
 * @property {any} res
 * @property {() => Promise<Record<string, any>>} body
 */

/** @type {Route[]} */
const ROUTES = [
  { method: 'GET', pattern: /^\/ping\/?$/, handle: ({ rt }) => handlePing(rt) },
  { method: 'GET', pattern: /^\/config\/?$/, handle: ({ rt }) => configPayload(rt) },
  { method: 'PUT', pattern: /^\/config\/?$/, handle: async ({ rt, body }) => saveConfig(rt, await body()) },
  { method: 'POST', pattern: /^\/config\/?$/, handle: async ({ rt, body }) => saveConfig(rt, await body()) },
  { method: 'GET', pattern: /^\/reports\/?$/, handle: ({ rt }) => handleListReports(rt) },
  {
    method: 'POST',
    pattern: /^\/reports\/generate\/?$/,
    handle: async ({ rt, deps, body }) => generateReport(rt, deps, await body()),
  },
  // 必须排在 `/reports/:id` 之前：否则 day-commits 会被当成 id。
  {
    method: 'GET',
    pattern: /^\/reports\/day-commits\/?$/,
    handle: ({ rt, params }) => handleDayCommits(rt, params),
  },
  {
    method: 'GET',
    pattern: /^\/reports\/([^/]+)\/?$/,
    handle: ({ rt, params, capture }) => handleGetReport(rt, capture(1), params),
  },
  {
    method: 'GET',
    pattern: /^\/reports\/([^/]+)\/stats\/?$/,
    handle: ({ rt, capture }) => handleReportStats(rt, capture(1)),
  },
  {
    method: 'GET',
    pattern: /^\/reports\/([^/]+)\/export\/?$/,
    handle: ({ rt, params, capture, res }) => handleExport(rt, capture(1), params, res),
  },
  {
    method: 'DELETE',
    pattern: /^\/reports\/([^/]+)\/?$/,
    handle: ({ rt, capture }) => handleDeleteReport(rt, capture(1)),
  },
  { method: 'GET', pattern: /^\/line-stats\/?$/, handle: ({ rt, params }) => handleLineStats(rt, params) },
  {
    method: 'GET',
    pattern: /^\/gitlab\/connections\/?$/,
    handle: ({ rt, deps }) => listConnections(rt, deps),
  },
  {
    method: 'POST',
    pattern: /^\/gitlab\/connections\/?$/,
    handle: async ({ rt, deps, body }) => createConnection(rt, deps, await body()),
  },
  {
    method: 'GET',
    pattern: /^\/gitlab\/projects\/?$/,
    handle: ({ rt, params }) => listProjects(rt, params),
  },
  {
    method: 'GET',
    pattern: /^\/gitlab\/selection\/?$/,
    handle: ({ rt, params }) => getSelection(rt, params),
  },
  {
    method: 'PUT',
    pattern: /^\/gitlab\/selection\/?$/,
    handle: async ({ rt, body }) => putSelection(rt, await body()),
  },
  {
    method: 'DELETE',
    pattern: /^\/gitlab\/connections\/([^/]+)\/?$/,
    handle: async ({ rt, deps, capture }) => removeConnection(rt, deps, capture(1)),
  },
  {
    method: 'DELETE',
    pattern: /^\/gitlab\/token\/?$/,
    handle: ({ rt, params }) => clearGitlabToken(rt, params),
  },
  {
    method: 'GET',
    pattern: /^\/gitlab\/author-aliases\/?$/,
    handle: ({ rt }) => getAuthorAliases(rt),
  },
  {
    method: 'PUT',
    pattern: /^\/gitlab\/author-aliases\/?$/,
    handle: async ({ rt, body }) => putAuthorAliases(rt, await body()),
  },
  {
    method: 'POST',
    pattern: /^\/gitlab\/suggest-author-aliases\/?$/,
    handle: async ({ rt, body }) => suggestAuthorAliases(rt, await body()),
  },
  {
    method: 'GET',
    pattern: /^\/sync\/coverage\/?$/,
    handle: ({ rt, params }) => getCoverage(rt, params),
  },
  { method: 'GET', pattern: /^\/sync\/jobs\/?$/, handle: ({ rt, params }) => listJobs(rt, params) },
  {
    method: 'POST',
    pattern: /^\/sync\/start\/?$/,
    handle: async ({ rt, body }) => startSync(rt, await body()),
  },
  {
    method: 'POST',
    pattern: /^\/sync\/cancel\/?$/,
    handle: async ({ rt, body }) => cancelSync(rt, await body()),
  },
  { method: 'GET', pattern: /^\/templates\/?$/, handle: ({ rt }) => templatesPayload(rt) },
  {
    method: 'PUT',
    pattern: /^\/templates\/?$/,
    handle: async ({ rt, body }) => saveTemplates(rt, await body()),
  },
]

/**
 * 从 `req.url` 解析出 API 相对路径。不属于本前缀返回 null。
 *
 * @param {any} req
 * @returns {{ relative: string, params: URLSearchParams } | null}
 */
function parseRequestUrl(req) {
  const raw = typeof req?.url === 'string' && req.url ? req.url : '/'
  const url = new URL(raw, 'http://127.0.0.1')
  if (!url.pathname.startsWith(API_PREFIX)) return null
  let relative = url.pathname.slice(API_PREFIX.length)
  if (!relative) relative = '/'
  if (relative.length > 1) relative = relative.replace(/\/+$/, '')
  return { relative, params: url.searchParams }
}

/**
 * 创建 API handler。
 *
 * @param {Record<string, any>} [deps] 见文件头
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createApiHandler(deps = {}) {
  const rt = createRuntime(deps)
  /** @type {Record<string, any>} */
  const resolvedDeps = deps

  return async function handleApi(req, res) {
    const method = String(req?.method ?? 'GET').toUpperCase()
    try {
      const parsed = parseRequestUrl(req)
      if (!parsed) {
        sendJSON(res, 404, { error: 'not-found', message: `未知路径：${req?.url ?? ''}` })
        return
      }
      const { relative, params } = parsed

      /** @type {RegExpExecArray | null} */
      let match = null
      let route = ROUTES.find((candidate) => {
        match = candidate.pattern.exec(relative)
        return Boolean(match) && candidate.method === method
      })
      if (!route) {
        const pathMatched = ROUTES.some((candidate) => candidate.pattern.test(relative))
        if (pathMatched) {
          sendJSON(res, 405, { error: 'method-not-allowed', message: `${method} 不支持 ${relative}` })
        } else {
          sendJSON(res, 404, { error: 'not-found', message: `未知接口：${relative}` })
        }
        return
      }
      // 重新匹配一次，保证 match 属于命中的 route（find 回调里的 match 可能被后者覆盖）。
      match = route.pattern.exec(relative)
      const ctx = {
        rt,
        deps: resolvedDeps,
        params,
        req,
        res,
        capture: (index) => {
          const value = match?.[index] ?? ''
          try {
            return decodeURIComponent(value)
          } catch {
            return value
          }
        },
        body: () => readJSONBody(req),
      }
      const payload = await route.handle(ctx)
      if (res.writableEnded || res.headersSent) return
      if (payload === undefined) {
        sendJSON(res, 200, { ok: true })
        return
      }
      sendJSON(res, 200, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      rt.log('api-failed', { method, url: req?.url, message })
      if (res.writableEnded || res.headersSent) return
      const { status, code } = mapError(error)
      sendJSON(res, status, { error: code, message })
    }
  }
}
