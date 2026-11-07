/**
 * @local/dsh-report · Host 工具面：9 个 report_* Agent 工具
 *
 * 契约来源：`CONTRACTS.md` §6（9 个工具）+ `docs/plugin-extraction/03-agent-flow.md` §1
 * （参数 / 返回 / 分页 / 截断 / 审批矩阵的逐条证据）。
 *
 * 设计要点（与 workbench Go 版对齐的部分）：
 *   - 工具名、参数名、required、分页/截断/hint 文案与 Go 版一致；额外接受 snake_case 别名
 *     （Go 的 `ArgString` 兼容层，见 03 分册 §1.5）。
 *   - 只读工具 6 个 + 写工具 3 个（update / delete / sync）；本文件**不做审批**：
 *     DSH 宿主的策略 / approval 服务负责，工具只声明 `isConcurrencySafe`。
 *   - 返回 `{ content:[{type:'text',text}], structuredContent:{...} }`；
 *     `output.render` 输出文本摘要（有 content 时直接复用）。
 *
 * deps 形状（由 index.js 接线，缺省项都有回退）：
 * ```js
 * {
 *   db,            // node:sqlite DatabaseSync（或其 getter getDb()）
 *   store,         // lib/db.js 模块命名空间（CONTRACTS §2，函数首参为 db）
 *   domain,        // lib/domain/* 汇总对象（CONTRACTS §3）
 *   syncService,   // lib/sync.js 的 createSyncService(...) 返回值（CONTRACTS §4）
 *   getConfig, updateConfig, resolveToken, saveToken,   // config.js
 *   logger, build, dbPath, dataDir, node,
 * }
 * ```
 *
 * 本文件同时导出 api.js 复用的只读 helper（`createRuntime` / `parsePeriodArgs` /
 * `loadReportDetail` / `loadReportList` / `readStats` / `readCommits` 等）。
 * 它们不是对外稳定 API，只保证插件内两个文件之间一致。
 *
 * @module @local/dsh-report/lib/tools
 */

/** 报告类型（顺序即 UI 顺序）。 */
export const REPORT_TYPES = ['week', 'month', 'quarter', 'year']

/** report_export 正文截断上限（复刻 Go `clipReportText(..., 32000)`）。 */
export const EXPORT_CLIP = 32000

/** Go 版 `report_update` 保存后的固定提示。 */
export const UPDATE_HINT =
  'Report saved. Reply with a short summary only; do not call report_export or paste the full Markdown into chat.'

/** 报告类型 → 中文标签（domain.formatReportType 缺失时的回退）。 */
const TYPE_LABEL = { week: '周报', month: '月报', quarter: '季报', year: '年报' }

/** `YYYY-MM-DD`（与 Go `httputil.IsValidDate` 同口径）。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** sync_job 处于这些状态时视为「进行中」。 */
const ACTIVE_JOB_STATUS = new Set(['pending', 'running', 'cancel_requested'])

/** GitLab 同步工具的 7 个 action（顺序即报错文案）。 */
const SYNC_ACTIONS = [
  'coverage',
  'get_selection',
  'list_candidates',
  'save_selection',
  'status',
  'start',
  'cancel',
]

/* ------------------------------------------------------------------ 错误 */

/**
 * 工具/接口的统一错误。code 与 Go 的 capability 错误码对齐，api.js 据此映射 HTTP 状态。
 *
 * @typedef {'VALIDATION'|'NOT_FOUND'|'PERMISSION'|'INTERNAL'} ReportErrorCode
 */
export class ReportError extends Error {
  /**
   * @param {string} message 面向模型/用户的中文消息
   * @param {ReportErrorCode} [code]
   */
  constructor(message, code = 'VALIDATION') {
    super(message)
    this.name = 'ReportError'
    this.code = code
  }
}

/**
 * @param {string} message
 * @returns {ReportError}
 */
function validation(message) {
  return new ReportError(message, 'VALIDATION')
}

/**
 * @param {string} message
 * @returns {ReportError}
 */
function notFound(message) {
  return new ReportError(message, 'NOT_FOUND')
}

/**
 * @param {string} message
 * @returns {ReportError}
 */
function internal(message) {
  return new ReportError(message, 'INTERNAL')
}

/* ------------------------------------------------- 参数读取（复刻 Arg* 兼容层） */

/**
 * 依次尝试多个 key，返回第一个非空字符串（去首尾空白）。
 *
 * @param {Record<string, unknown>} args
 * @param {...string} keys
 * @returns {string}
 */
export function argString(args, ...keys) {
  if (!args || typeof args !== 'object') return ''
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/**
 * 布尔参数。只认 JSON boolean（Go `ArgBool` 不做字符串转换），缺省 false。
 *
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @param {string} [alias]
 * @returns {boolean}
 */
export function argBool(args, key, alias) {
  if (!args || typeof args !== 'object') return false
  if (args[key] === true) return true
  if (alias && args[alias] === true) return true
  return false
}

/**
 * 整数参数。接受 number / 数字字符串，无法解析时回退。
 *
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @param {number} [fallback]
 * @returns {number}
 */
export function argInt(args, key, fallback = 0) {
  if (!args || typeof args !== 'object') return fallback
  const raw = args[key]
  if (raw === undefined || raw === null) return fallback
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

/**
 * 校验 `YYYY-MM-DD`，非法即抛 VALIDATION。
 *
 * @param {string} value
 * @param {string} field
 * @returns {string}
 */
export function assertDate(value, field) {
  if (!DATE_RE.test(value)) throw validation(`${field} 必须是 YYYY-MM-DD 格式`)
  return value
}

/**
 * 解析报告周期参数（复刻 Go `periodArgs`）。
 *
 * 规则：`type` 缺省 week，且必须是四种之一；`startDate`/`endDate` 必填、格式合法、
 * 且 `startDate <= endDate`（ISO 日期可直接做字符串比较）。
 *
 * @param {Record<string, unknown>} args
 * @param {{ requireType?: boolean }} [options] requireType=true 时 type 必须显式给出
 * @returns {{ type: string, startDate: string, endDate: string, period: string }}
 */
export function parsePeriodArgs(args, options = {}) {
  let type = argString(args, 'type', 'reportType', 'report_type')
  if (!type) {
    if (options.requireType) throw validation('type 必填：week / month / quarter / year')
    type = 'week'
  }
  if (!REPORT_TYPES.includes(type)) {
    throw validation(`type 必须是 ${REPORT_TYPES.join(' / ')}，收到：${type}`)
  }
  const startDate = assertDate(argString(args, 'startDate', 'start_date'), 'startDate')
  const endDate = assertDate(argString(args, 'endDate', 'end_date'), 'endDate')
  if (startDate > endDate) throw validation('startDate 不能晚于 endDate')
  return { type, startDate, endDate, period: `${startDate} 至 ${endDate}` }
}

/* --------------------------------------------------------------- 小工具函数 */

/**
 * @param {unknown} value
 * @returns {any}
 */
function parseJSON(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 取第一个有值的 key（`undefined`/`null` 视为无值）。
 *
 * @param {Record<string, unknown> | null | undefined} row
 * @param {string[]} keys
 * @returns {unknown}
 */
function pick(row, keys) {
  if (!row || typeof row !== 'object') return undefined
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * 取第一个可用的字符串字段。
 *
 * @param {Record<string, unknown> | null | undefined} row
 * @param {string[]} keys
 * @param {string} [fallback]
 * @returns {string}
 */
function pickString(row, keys, fallback = '') {
  const value = pick(row, keys)
  if (value === undefined) return fallback
  return typeof value === 'string' ? value : String(value)
}

/**
 * 取第一个可用数字字段。
 *
 * @param {Record<string, unknown> | null | undefined} row
 * @param {string[]} keys
 * @param {number} [fallback]
 * @returns {number}
 */
function pickNumber(row, keys, fallback = 0) {
  const value = pick(row, keys)
  if (value === undefined) return fallback
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

/**
 * snake_case → camelCase（浅层）。用于把 db 行直接投影成 API 视图。
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function toCamelRow(row) {
  if (!row || typeof row !== 'object') return {}
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase())] = value
  }
  return out
}

/**
 * 复刻 Go `clipReportText`：超出 limit 时截断并追加 `\n[truncated]`。
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {{ content: string, truncated: boolean }}
 */
export function clipReportText(text, limit = EXPORT_CLIP) {
  const source = typeof text === 'string' ? text : ''
  const max = limit > 0 ? limit : EXPORT_CLIP
  if (source.length <= max) return { content: source, truncated: false }
  return { content: `${source.slice(0, max)}\n[truncated]`, truncated: true }
}

/**
 * 把工具结果包成 `{ content, structuredContent }`（M0 起沿用的返回形状）。
 *
 * @param {Record<string, unknown>} structured
 * @param {string} [text]
 * @returns {{ content: Array<{ type: 'text', text: string }>, structuredContent: Record<string, unknown> }}
 */
export function textResult(structured, text) {
  return {
    content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

/**
 * `output.render` 的通用实现：优先复用 content，其次 summary，最后结构化文本。
 *
 * @param {unknown} _args
 * @param {any} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
function renderResult(_args, value) {
  if (value && Array.isArray(value.content) && value.content.length > 0) return value.content
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (value && typeof value === 'object') {
    if (typeof value.summary === 'string') return [{ type: 'text', text: value.summary }]
    const structured = value.structuredContent ?? value
    return [{ type: 'text', text: JSON.stringify(structured, null, 2) }]
  }
  return [{ type: 'text', text: String(value ?? '') }]
}

/* ----------------------------------------------------------------- 运行时 */

/**
 * @typedef {object} ReportRuntime
 * @property {any} handle node:sqlite DatabaseSync（可能为 null：库不可用）
 * @property {any} store lib/db.js 模块命名空间（可能为 null）
 * @property {any} domain lib/domain/* 汇总（可能为 null）
 * @property {any} sync sync.js 服务（可能为 null）
 * @property {boolean} dbAvailable
 * @property {string} build
 * @property {string} dbPath
 * @property {string} dataDir
 * @property {string} node
 * @property {(event: string, extra?: Record<string, unknown>) => void} log
 * @property {() => Promise<Record<string, any>>} config
 * @property {(patch: Record<string, any>) => Promise<void>} updateConfig
 * @property {() => Promise<string>} resolveToken
 * @property {((token: string) => Promise<void>) | null} saveToken
 */

/**
 * 归一化 deps：容忍 `db` 是 handle 还是 db.js 模块、`store` 缺失、config 打平或嵌套。
 *
 * @param {Record<string, any>} deps
 * @returns {ReportRuntime}
 */
export function createRuntime(deps = {}) {
  const dbArg = deps.db
  const handle =
    deps.handle ??
    (dbArg && typeof dbArg.prepare === 'function' ? dbArg : undefined) ??
    (typeof deps.getDb === 'function' ? deps.getDb() : undefined) ??
    null
  const store = deps.store ?? (dbArg && !(typeof dbArg.prepare === 'function') ? dbArg : null)
  const configModule = deps.config && typeof deps.config === 'object' ? deps.config : null

  const getConfig =
    deps.getConfig ??
    (configModule && typeof configModule.getConfig === 'function' ? () => configModule.getConfig() : null)
  const updateConfig =
    deps.updateConfig ??
    (configModule && typeof configModule.updateConfig === 'function' ? (patch) => configModule.updateConfig(patch) : null)
  const resolveToken =
    deps.resolveToken ??
    (configModule && typeof configModule.resolveToken === 'function' ? () => configModule.resolveToken() : null)
  const saveToken =
    deps.saveToken ??
    deps.setToken ??
    (configModule && typeof configModule.saveToken === 'function' ? (token) => configModule.saveToken(token) : null)

  const logger = typeof deps.logger === 'function' ? deps.logger : () => {}
  const getAuthorAliases = typeof deps.getAuthorAliases === 'function' ? deps.getAuthorAliases : null
  const setAuthorAliases = typeof deps.setAuthorAliases === 'function' ? deps.setAuthorAliases : null
  const suggestAuthorAliases = typeof deps.suggestAuthorAliases === 'function' ? deps.suggestAuthorAliases : null
  const clearTokenDep = typeof deps.clearToken === 'function' ? deps.clearToken : null

  return {
    handle: handle ?? null,
    store: store ?? null,
    domain: deps.domain ?? null,
    sync: deps.syncService ?? deps.sync ?? null,
    dbAvailable: Boolean(handle ?? store),
    build: typeof deps.build === 'string' ? deps.build : '0.1.0',
    dbPath: typeof deps.dbPath === 'string' ? deps.dbPath : '',
    dataDir: typeof deps.dataDir === 'string' ? deps.dataDir : '',
    node: typeof deps.node === 'string' ? deps.node : process.version,
    log: logger,
    /** 当前配置快照（同步返回；config.js 若无 getConfig 则为空对象）。 */
    config() {
      if (!getConfig) return {}
      const value = getConfig()
      return value && typeof value === 'object' ? value : {}
    },
    /** 写配置（无 updateConfig 时抛 INTERNAL）。 */
    async updateConfig(patch) {
      if (!updateConfig) throw internal('配置写回不可用：index.js 未注入 updateConfig')
      await updateConfig(patch)
    },
    /** 读 GitLab token（可选按连接；无 resolveToken 时返回空串）。 */
    async resolveToken(options) {
      if (!resolveToken) return ''
      try {
        const token = await resolveToken(options)
        return typeof token === 'string' ? token : ''
      } catch {
        return ''
      }
    },
    /** 清掉 GitLab token（可选按连接；未注入时静默成功）。 */
    async clearToken(connectionId) {
      if (!clearTokenDep) return
      await clearTokenDep(connectionId)
    },
    /** 写 GitLab token（可选按连接；无 saveToken 时抛 INTERNAL）。 */
    async saveToken(token, connectionId) {
      if (!saveToken) throw internal('token 保存不可用：index.js 未注入 saveToken')
      await saveToken(token, connectionId)
    },
    /** 读「提交作者别名」（未注入时返回空数组）。 */
    async getAuthorAliases() {
      if (!getAuthorAliases) return []
      try {
        const list = await getAuthorAliases()
        return Array.isArray(list) ? list : []
      } catch {
        return []
      }
    },
    /** 写「提交作者别名」（未注入时抛 INTERNAL）。 */
    async setAuthorAliases(list) {
      if (!setAuthorAliases) throw internal('作者别名保存不可用：index.js 未注入 setAuthorAliases')
      return setAuthorAliases(list)
    },
    /** 推断「提交作者别名」（未注入时抛 INTERNAL）。 */
    async suggestAuthorAliases(input) {
      if (!suggestAuthorAliases) throw internal('作者别名推断不可用：index.js 未注入 suggestAuthorAliases')
      return suggestAuthorAliases(input)
    },
  }
}

/**
 * 调用 db.js 的某个函数（首参固定 db）。
 *
 * @param {ReportRuntime} rt
 * @param {string} name
 * @param {...any} args
 * @returns {any}
 */
export function storeCall(rt, name, ...args) {
  const fn = rt.store && rt.store[name]
  if (typeof fn !== 'function') throw internal(`db.${name} 不可用（lib/db.js 未实现或未注入）`)
  return fn(rt.handle, ...args)
}

/**
 * 调用 sync.js 服务的某个方法。
 *
 * @param {ReportRuntime} rt
 * @param {string} name
 * @param {...any} args
 * @returns {any}
 */
export async function syncCall(rt, name, ...args) {
  const fn = rt.sync && rt.sync[name]
  if (typeof fn !== 'function') throw internal(`syncService.${name} 不可用（lib/sync.js 未实现或未注入）`)
  return fn.call(rt.sync, ...args)
}

/**
 * 同 syncCall，但方法缺失时返回 undefined 而不是抛错（可选能力）。
 *
 * @param {ReportRuntime} rt
 * @param {string} name
 * @param {...any} args
 * @returns {Promise<any>}
 */
export async function trySyncCall(rt, name, ...args) {
  const fn = rt.sync && rt.sync[name]
  if (typeof fn !== 'function') return undefined
  return fn.call(rt.sync, ...args)
}

/**
 * 调用 domain 的某个函数。
 *
 * @param {ReportRuntime} rt
 * @param {string} name
 * @param {...any} args
 * @returns {any}
 */
function domainCall(rt, name, ...args) {
  const fn = rt.domain && rt.domain[name]
  if (typeof fn !== 'function') throw internal(`domain.${name} 不可用（lib/domain/* 未实现或未注入）`)
  return fn(...args)
}

/* --------------------------------------------------------------- 读模型 */

/** 聚合里始终存在的数值字段（缺失补 0）。 */
const AGG_NUMERIC = [
  'totalCommits',
  'totalAdditions',
  'totalDeletions',
  'totalLines',
  'mergeCommitCount',
  'cherryPickCommitCount',
  'nonMergeCommitCount',
  'repoCount',
]

/** 聚合里的分布数组（缺失补 []）。 */
const AGG_ARRAYS = ['branchDistribution', 'dateDistribution', 'domainDistribution']

/**
 * 规范化 AggregateStats：数值字段补 0、分布字段补 []。
 *
 * @param {Record<string, any> | null | undefined} raw
 * @returns {Record<string, any>}
 */
export function normalizeStats(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  /** @type {Record<string, any>} */
  const out = {}
  for (const key of AGG_NUMERIC) {
    const value = source[key]
    const num = typeof value === 'number' ? value : Number(value)
    out[key] = Number.isFinite(num) ? num : 0
  }
  for (const key of AGG_ARRAYS) {
    const value = source[key]
    out[key] = Array.isArray(value) ? value : []
  }
  return out
}

/**
 * 读取某份报告的聚合统计。
 *
 * 依次尝试：① 报告行自带 stats（db.js 若已 JOIN 聚合表）② store 提供的聚合读取器
 * ③ 直接用 db handle 查 `report_aggregates.stats_json`（CONTRACTS §2 表结构）。
 *
 * @param {ReportRuntime} rt
 * @param {string} reportId
 * @param {Record<string, any>} [row]
 * @returns {Promise<Record<string, any>>}
 */
export async function readStats(rt, reportId, row) {
  const inline = pick(row, ['stats', 'stats_json', 'statsJson', 'aggregates', 'aggregates_json'])
  if (inline !== undefined) {
    const parsed = parseJSON(inline)
    if (parsed) return normalizeStats(parsed)
  }
  for (const name of ['getReportAggregate', 'getReportStats']) {
    const fn = rt.store && rt.store[name]
    if (typeof fn !== 'function') continue
    try {
      const value = await fn(rt.handle, reportId)
      const parsed = parseJSON(value) ?? (value && typeof value === 'object' ? value : undefined)
      if (parsed) return normalizeStats(parsed)
    } catch {
      /* 该读取器不可用，继续下一条 */
    }
  }
  if (rt.handle && typeof rt.handle.prepare === 'function') {
    try {
      const found = rt.handle
        .prepare('SELECT stats_json FROM report_aggregates WHERE report_id = ?')
        .get(reportId)
      const parsed = parseJSON(found?.stats_json ?? found?.statsJson)
      if (parsed) return normalizeStats(parsed)
    } catch {
      /* 库或表不可用：退化为零值统计 */
    }
  }
  return normalizeStats(null)
}

/**
 * topic 行 → API 视图（camelCase）。
 *
 * @param {Record<string, any>} row
 * @returns {{ domain: string, topicTitle: string, summary: string, sortOrder: number }}
 */
function toTopicView(row) {
  return {
    domain: pickString(row, ['domain']),
    topicTitle: pickString(row, ['topicTitle', 'topic_title']),
    summary: pickString(row, ['summary']),
    sortOrder: pickNumber(row, ['sortOrder', 'sort_order']),
  }
}

/**
 * 报告行 → `ReportListItem`（CONTRACTS §5）。
 *
 * @param {ReportRuntime} rt
 * @param {Record<string, any>} row
 * @returns {Promise<Record<string, any>>}
 */
async function toListItem(rt, row) {
  const id = pickString(row, ['reportId', 'report_id', 'id'])
  const stats = await readStats(rt, id, row)
  return {
    id,
    type: pickString(row, ['reportType', 'report_type', 'type']),
    periodStart: pickString(row, ['periodStart', 'period_start']),
    periodEnd: pickString(row, ['periodEnd', 'period_end']),
    status: pickString(row, ['status']),
    totalCommits: stats.totalCommits,
    generatedAt: pickString(row, ['generatedAt', 'generated_at']),
  }
}

/**
 * 读取报告列表（按 periodEnd / id 倒序，稳定输出）。
 *
 * @param {ReportRuntime} rt
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function loadReportList(rt) {
  const rows = (await storeCall(rt, 'listReportRows')) ?? []
  const items = []
  for (const row of Array.isArray(rows) ? rows : []) items.push(await toListItem(rt, row))
  items.sort((left, right) => {
    const byPeriod = String(right.periodEnd).localeCompare(String(left.periodEnd))
    return byPeriod !== 0 ? byPeriod : String(right.id).localeCompare(String(left.id))
  })
  return items
}

/**
 * 读取一份报告详情（含 topics）。不存在返回 null。
 *
 * @param {ReportRuntime} rt
 * @param {string} reportId
 * @param {{ includeContent?: boolean }} [options] includeContent=false 时 content 置 null
 * @returns {Promise<Record<string, any> | null>}
 */
export async function loadReportDetail(rt, reportId, options = {}) {
  const includeContent = options.includeContent !== false
  const row = await storeCall(rt, 'getReportRow', reportId)
  if (!row) return null
  const id = pickString(row, ['reportId', 'report_id', 'id'], reportId)
  const type = pickString(row, ['reportType', 'report_type', 'type'])
  const stats = await readStats(rt, id, row)
  const topicRows = (await storeCall(rt, 'listTopics', id)) ?? []
  const content = pickString(row, ['content'])
  return {
    id,
    type,
    typeLabel: typeLabelOf(rt, type),
    periodStart: pickString(row, ['periodStart', 'period_start']),
    periodEnd: pickString(row, ['periodEnd', 'period_end']),
    status: pickString(row, ['status']),
    content: includeContent ? content || null : null,
    generatedAt: pickString(row, ['generatedAt', 'generated_at']) || null,
    errorMessage: pickString(row, ['errorMessage', 'error_message']) || null,
    ...stats,
    topics: (Array.isArray(topicRows) ? topicRows : []).map(toTopicView),
  }
}

/**
 * 报告类型 → 中文标签。
 *
 * @param {ReportRuntime} rt
 * @param {string} type
 * @returns {string}
 */
function typeLabelOf(rt, type) {
  const fn = rt.domain && rt.domain.formatReportType
  if (typeof fn === 'function') {
    try {
      const label = fn(type)
      if (typeof label === 'string' && label) return label
    } catch {
      /* 回退本地映射 */
    }
  }
  return TYPE_LABEL[type] ?? TYPE_LABEL.week
}

/**
 * 某份报告的统计视图：`{ stats, lineStats, repoBranchStats }`。
 * `stats` 用 Detail 的统计字段（含 cherryPickCommitCount）。
 *
 * @param {ReportRuntime} rt
 * @param {string} reportId
 * @returns {Promise<{ stats: Record<string, any>, lineStats: any[], repoBranchStats: any[] } | null>}
 */
export async function loadReportStats(rt, reportId) {
  const detail = await loadReportDetail(rt, reportId, { includeContent: false })
  if (!detail) return null
  const lineStats = (await storeCall(rt, 'listLineStats', reportId)) ?? []
  const repoBranchStats = (await storeCall(rt, 'listRepoBranchStats', reportId)) ?? []
  return {
    stats: {
      totalCommits: detail.totalCommits,
      totalAdditions: detail.totalAdditions,
      totalDeletions: detail.totalDeletions,
      totalLines: detail.totalLines,
      mergeCommitCount: detail.mergeCommitCount,
      cherryPickCommitCount: detail.cherryPickCommitCount,
      nonMergeCommitCount: detail.nonMergeCommitCount,
      repoCount: detail.repoCount,
      branchDistribution: detail.branchDistribution,
      dateDistribution: detail.dateDistribution,
      domainDistribution: detail.domainDistribution,
    },
    lineStats: (Array.isArray(lineStats) ? lineStats : []).map(toCamelRow),
    repoBranchStats: (Array.isArray(repoBranchStats) ? repoBranchStats : []).map(toCamelRow),
  }
}

/**
 * 提交行 → CommitView（供 domain 纯函数消费）。
 *
 * DB 行是 snake_case，domain 契约是 camelCase（CONTRACTS §3）；这里同时保留两种 key，
 * 并且**不改变数值语义**（`isMergeCommit` 仍是 0/1，truthy 判断在两处都成立）。
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function toCommitView(row) {
  if (!row || typeof row !== 'object') return {}
  const rawBranches = pick(row, ['branchNames', 'branch_names', 'branchNamesJson', 'branch_names_json'])
  let branchNames = parseJSON(rawBranches)
  if (!Array.isArray(branchNames)) {
    const text = pickString(row, ['branchNames', 'branch_names'])
    branchNames = text ? text.split(',').map((item) => item.trim()).filter(Boolean) : []
  }
  return {
    ...row,
    connectionId: pick(row, ['connectionId', 'connection_id']),
    projectId: pick(row, ['projectId', 'project_id']),
    commitId: pick(row, ['commitId', 'commit_id']),
    message: pickString(row, ['message']),
    authoredDate: pickString(row, ['authoredDate', 'authored_date']),
    committedDate: pickString(row, ['committedDate', 'committed_date']),
    authorName: pickString(row, ['authorName', 'author_name']),
    authorEmail: pickString(row, ['authorEmail', 'author_email']),
    title: pickString(row, ['title']),
    isMergeCommit: pick(row, ['isMergeCommit', 'is_merge_commit']) ?? 0,
    isCherryPickCommit: pick(row, ['isCherryPickCommit', 'is_cherry_pick_commit']) ?? 0,
    cherryPickSourceCommit: pickString(row, ['cherryPickSourceCommit', 'cherry_pick_source_commit']),
    additions: pickNumber(row, ['additions']),
    deletions: pickNumber(row, ['deletions']),
    total: pickNumber(row, ['total']),
    repoName: pickString(row, ['repoName', 'repo_name']),
    namespace: pickString(row, ['namespace', 'repoNamespace', 'repo_namespace']),
    pathWithNamespace: pickString(row, ['pathWithNamespace', 'path_with_namespace', 'repoPath']),
    primaryBranch: pickString(row, ['primaryBranch', 'primary_branch', 'branch']),
    branchNames: Array.isArray(branchNames) ? branchNames : [],
  }
}

/**
 * 读取区间内的提交（供统计/明细/导出使用）。
 *
 * @param {ReportRuntime} rt
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function readCommits(rt, startDate, endDate) {
  const rows = (await storeCall(rt, 'listCommitsInPeriod', { startDate, endDate })) ?? []
  return (Array.isArray(rows) ? rows : []).map(toCommitView)
}

/* ------------------------------------------------------------ 工具 handler */

/**
 * 取当前配置里的报告模板 / 写作指引（用户可改 → 回退 domain 默认值）。
 *
 * @param {ReportRuntime} rt
 * @param {string} type
 * @returns {{ template: string, guidance: string }}
 */
function templateAndGuidance(rt, type) {
  const cfg = rt.config()
  const template =
    pickString(cfg.templates ?? cfg.template, [type]) ||
    pickString(rt.domain?.DEFAULT_TEMPLATES, [type])
  const guidance =
    pickString(cfg.guidance ?? cfg.guidances, [type]) ||
    pickString(rt.domain?.DEFAULT_GUIDANCE, [type])
  return { template, guidance }
}

/**
 * 文本摘要：brief 内容较长且是模型主要输入，用分段中文文本而不是 JSON。
 *
 * @param {Record<string, any>} brief
 * @returns {string}
 */
function briefText(brief) {
  const lines = [
    `${brief.reportTypeLabel ?? brief.reportType}（${brief.reportType}） 周期 ${brief.period}`,
    '',
    '[模板]',
    brief.template ?? '',
    '',
    '[写作指引]',
    brief.guidance ?? '',
    '',
    '[Host 指令]',
    brief.hostInstructions ?? '',
  ]
  return lines.join('\n')
}

/**
 * `report_brief`
 *
 * @param {ReportRuntime} rt
 * @param {Record<string, unknown>} args
 */
function handleBrief(rt, args) {
  const { type, startDate, endDate } = parsePeriodArgs(args)
  const { template, guidance } = templateAndGuidance(rt, type)
  const brief = domainCall(rt, 'getReportBrief', {
    type,
    startDate,
    endDate,
    ...(template ? { template } : {}),
    ...(guidance ? { guidance } : {}),
  })
  return textResult(brief, briefText(brief))
}

/**
 * 分页 hint 的本地回退（domain 未提供时照抄 Go `gather.go:100-119`）。
 *
 * @param {{ hasMore?: boolean, total?: number, repo?: string }} result
 * @returns {string}
 */
function fallbackGatherHint(result) {
  if (result.hasMore) {
    return 'More commits remain. Call report_commits again with the same period and offset=nextOffset (optionally repo=...) until hasMore is false.'
  }
  if (!result.repo && Number(result.total ?? 0) > 0) {
    return 'Page complete. For large repos, pass repo=<path or name substring> to inspect one repository at a time.'
  }
  return ''
}

/**
 * `report_commits`
 *
 * @param {ReportRuntime} rt
 * @param {Record<string, unknown>} args
 */
async function handleCommits(rt, args) {
  const { startDate, endDate } = parsePeriodArgs(args)
  const commits = await readCommits(rt, startDate, endDate)
  const result = domainCall(rt, 'gatherCommits', commits, startDate, endDate, {
    repo: argString(args, 'repo', 'repository', 'path'),
    limit: argInt(args, 'limit'),
    offset: argInt(args, 'offset'),
    includeMerge: argBool(args, 'includeMerge', 'include_merge'),
  })
  const shaped = { ...result }
  if (!shaped.hint) shaped.hint = fallbackGatherHint(shaped)
  return textResult(shaped)
}

/**
 * `report_stats`
 *
 * @param {ReportRuntime} rt
 * @param {Record<string, unknown>} args
 */
async function handleStats(rt, args) {
  const reportId = argString(args, 'reportId', 'report_id', 'id')
  if (reportId) {
    const found = await loadReportStats(rt, reportId)
    if (!found) throw notFound(`报告不存在：${reportId}`)
    return textResult({ report: found.stats, lineStats: found.lineStats, repoBranchStats: found.repoBranchStats })
  }
  const { startDate, endDate } = parsePeriodArgs(args)
  const commits = await readCommits(rt, startDate, endDate)
  const analytics = domainCall(rt, 'buildRealtimeAnalytics', startDate, endDate, commits)
  return textResult(analytics)
}

/**
 * `report_update`（唯一写库入口；同周期覆盖）
 *
 * @param {ReportRuntime} rt
 * @param {Record<string, unknown>} args
 */
async function handleUpdate(rt, args) {
  const { type, startDate, endDate, period } = parsePeriodArgs(args, { requireType: true })
  const content = argString(args, 'content', 'markdown')
  if (!content) throw validation('content 不能为空（需要完整 Markdown 正文）')
  const saved = await domainCall(rt, 'upsertReport', rt.handle, { type, startDate, endDate, content, status: 'generated' })
  const reportId = pickString(saved, ['reportId', 'report_id'], `${type}:${startDate}:${endDate}`)
  const stats = normalizeStats(saved?.aggregates)
  const status = pickString(saved, ['status'], 'generated')
  return textResult({
    reportId,
    saved: true,
    period,
    status,
    hint: UPDATE_HINT,
    report: { reportId, period, status, stats, content },
  })
}

/**
 * `report_list`
 *
 * @param {ReportRuntime} rt
 */
async function handleList(rt) {
  const reports = await loadReportList(rt)
  return textResult({ reports })
}

/**
 * `report_get`
 *
 * @param {ReportRuntime} rt
 * @param {Record<string, unknown>} args
 */
async function handleGet(rt, args) {
  const reportId = argString(args, 'reportId', 'report_id', 'id')
  if (!reportId) throw validation('reportId 必填')
  const detail = await loadReportDetail(rt, reportId, { includeContent: true })
  if (!detail) throw notFound(`报告不存在：${reportId}`)
  const { topics, ...report } = detail
  return textResult({ report, topics })
}

/**
 * `report_export`（正文 32k 截断）
 *
 * @param {ReportRuntime} rt
 * @param {Record<string, unknown>} args
 */
async function handleExport(rt, args) {
  const reportId = argString(args, 'reportId', 'report_id', 'id')
  if (!reportId) throw validation('reportId 必填')
  const detail = await loadReportDetail(rt, reportId, { includeContent: true })
  if (!detail) throw notFound(`报告不存在：${reportId}`)
  const body = typeof detail.content === 'string' ? detail.content : ''
  if (!body.trim()) throw validation('报告正文为空，无法导出')
  const { content, truncated } = clipReportText(body)
  const filename = `${detail.type}-${detail.periodStart}-${detail.periodEnd}.md`
  return textResult({ reportId, format: 'markdown', filename, content, truncated }, content)
}

/**
 * `report_delete`
 *
 * @param {ReportRuntime} rt
 * @param {Record<string, unknown>} args
 */
async function handleDelete(rt, args) {
  const reportId = argString(args, 'reportId', 'report_id', 'id')
  if (!reportId) throw validation('reportId 必填')
  const deleted = await storeCall(rt, 'deleteReportRow', reportId)
  if (!deleted) throw notFound(`报告不存在：${reportId}`)
  return textResult({ deleted: true, reportId })
}

/* ---------------------------------------------------- report_sync（7 action） */

/**
 * 同步项目视图（只保留契约字段）。
 *
 * @param {Record<string, any>} project
 * @returns {{ connectionId: string, projectId: number, name: string, pathWithNamespace: string, namespace: string, webUrl: string }}
 */
function toScopeProject(project) {
  const enabled = pick(project, ['enabled'])
  return {
    connectionId: pickString(project, ['connectionId', 'connection_id']),
    projectId: pickNumber(project, ['projectId', 'project_id', 'id']),
    name: pickString(project, ['name']),
    pathWithNamespace: pickString(project, ['pathWithNamespace', 'path_with_namespace', 'path']),
    namespace: pickString(project, ['namespace']),
    webUrl: pickString(project, ['webUrl', 'web_url']),
    enabled: enabled === undefined || enabled === null ? 1 : Number(enabled) === 0 ? 0 : 1,
  }
}

/**
 * 按 connection / 关键字过滤（复刻 Go `filterScopeProjects`）。
 *
 * @param {Array<Record<string, any>>} projects
 * @param {string} connectionId
 * @param {string} query
 * @returns {Array<Record<string, any>>}
 */
function filterScopeProjects(projects, connectionId, query) {
  const byConnection = connectionId.trim()
  const needle = query.trim().toLowerCase()
  if (!byConnection && !needle) return projects
  return projects.filter((project) => {
    if (byConnection && project.connectionId.trim() !== byConnection) return false
    if (!needle) return true
    const haystack = `${project.name} ${project.pathWithNamespace} ${project.namespace}`.toLowerCase()
    return haystack.includes(needle)
  })
}

/**
 * 解析 `projects` 入参（复刻 Go `parseSyncScopeProjects`）。
 *
 * @param {Record<string, unknown>} args
 * @returns {Array<{ connectionId: string, projectId: number, name: string, pathWithNamespace: string }>}
 */
function parseScopeProjects(args) {
  const raw = args?.projects
  if (!Array.isArray(raw)) throw validation('save_selection 需要 projects 数组')
  const defaultConnection = argString(args, 'connection_id', 'connectionId')
  /** @type {Array<{ connectionId: string, projectId: number, name: string, pathWithNamespace: string }>} */
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw validation('projects 的每一项必须是对象')
    const projectId = pickNumber(item, ['project_id', 'projectId', 'id'])
    if (projectId <= 0) throw validation('每个 project 需要正整数 project_id')
    const connectionId = pickString(item, ['connection_id', 'connectionId']) || defaultConnection
    if (!connectionId) throw validation('每个 project 需要 connection_id（或在顶层给出）')
    const key = `${connectionId}:${projectId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      connectionId,
      projectId,
      name: pickString(item, ['name']),
      pathWithNamespace: pickString(item, ['path_with_namespace', 'pathWithNamespace', 'path']),
      enabled: pickNumber(item, ['enabled'], 1) === 0 ? 0 : 1,
    })
  }
  return out
}

/**
 * 指定 connection 时「只替换该 connection，保留其它 connection」（复刻 Go `mergeSyncScopeProjects`）。
 *
 * @param {Array<Record<string, any>>} existing
 * @param {Array<Record<string, any>>} incoming
 * @param {string} connectionId
 * @returns {Array<Record<string, any>>}
 */
function mergeScopeProjects(existing, incoming, connectionId) {
  const target = connectionId.trim()
  if (!target) return incoming
  const merged = existing.filter((project) => (project.connectionId ?? '').trim() !== target)
  for (const project of incoming) {
    const owner = (project.connectionId ?? '').trim() || target
    if (owner !== target) continue
    merged.push({ ...project, connectionId: owner })
  }
  return merged
}

/**
 * sync job 视图（camelCase；兼容 snake_case 行）。
 *
 * @param {Record<string, any> | null | undefined} job
 * @returns {Record<string, any> | null}
 */
function toJobView(job) {
  if (!job || typeof job !== 'object') return null
  const view = toCamelRow(job)
  const jobId = pickString(job, ['jobId', 'job_id'])
  return {
    jobId,
    connectionId: pickString(job, ['connectionId', 'connection_id']),
    status: pickString(job, ['status']),
    startedAt: pickString(job, ['startedAt', 'started_at']) || null,
    finishedAt: pickString(job, ['finishedAt', 'finished_at']) || null,
    progress: parseJSON(pick(job, ['progress', 'progress_json'])) ?? null,
    scope: parseJSON(pick(job, ['scope', 'scope_json'])) ?? null,
    error: pickString(job, ['error']) || null,
    ...view,
  }
}

/**
 * 统一 job 结果（复刻 Go `commitSyncJobResult`，key 名照抄 Go）。
 *
 * @param {string} action
 * @param {Record<string, any> | null} job
 * @param {boolean} reused
 * @returns {Record<string, any>}
 */
function jobResult(action, job, reused) {
  const view = toJobView(job)
  /** @type {Record<string, any>} */
  const out = { action, reused, job: view }
  if (view && view.jobId) {
    out.sync_job_id = view.jobId
    out.status = view.status
    out.cancel_requested = Boolean(view.cancelRequested ?? view.cancel_requested ?? 0)
    out.job_ref = { kind: 'sync_job', id: `gitlab/${view.jobId}` }
  }
  return out
}

/**
 * @param {Record<string, any> | null | undefined} job
 * @returns {boolean}
 */
function isActiveJob(job) {
  const status = pickString(job, ['status']).toLowerCase()
  return ACTIVE_JOB_STATUS.has(status)
}

/**
 * `report_sync`
 *
 * @param {ReportRuntime} rt
 * @param {Record<string, unknown>} args
 */
async function handleSync(rt, args) {
  const action = (argString(args, 'action') || 'coverage').toLowerCase()
  const jobId = argString(args, 'jobId', 'job_id')
  const connectionId = argString(args, 'connection_id', 'connectionId')

  switch (action) {
    case 'coverage': {
      const coverage = await syncCall(rt, 'coverage', { connectionId, startDate: '', endDate: '' })
      return textResult({ action, coverage })
    }
    case 'get_selection': {
      const projects = (await syncCall(rt, 'getSelection', connectionId)) ?? []
      const filtered = filterScopeProjects((Array.isArray(projects) ? projects : []).map(toScopeProject), connectionId, '')
      return textResult({ action, projects: filtered, count: filtered.length })
    }
    case 'list_candidates': {
      const query = argString(args, 'q', 'query')
      const refresh = argBool(args, 'refresh')
      const projects = await syncCall(rt, 'listCandidates', { connectionId, q: query, refresh })
      const filtered = filterScopeProjects((Array.isArray(projects) ? projects : []).map(toScopeProject), connectionId, query)
      return textResult({ action, connection_id: connectionId, projects: filtered, count: filtered.length })
    }
    case 'save_selection': {
      const incoming = parseScopeProjects(args)
      // 读全量（不按 connection 过滤）：Go 版 save_selection 只替换目标 connection、保留其它 connection。
      const existingRaw = (await syncCall(rt, 'getSelection', '')) ?? []
      const existing = (Array.isArray(existingRaw) ? existingRaw : []).map(toScopeProject)
      const saved = mergeScopeProjects(existing, incoming, connectionId)
      // sync.js 的 saveSelection 是「按 connection 全量替换」，因此按 connection 分组写；
      // 未出现在请求里的 connection 保持原样（不重写，避免影响其它连接的 enabled 状态）。
      const targets = new Set(incoming.map((project) => project.connectionId).filter(Boolean))
      const explicit = connectionId.trim()
      if (explicit) targets.add(explicit)
      if (targets.size === 0) {
        throw validation('connection_id 必填（或让每个 project 指明 connection_id）')
      }
      for (const owner of targets) {
        await syncCall(rt, 'saveSelection', owner, saved.filter((project) => project.connectionId === owner))
      }
      return textResult({ action, saved: true, count: saved.length, projects: saved })
    }
    case 'status': {
      let job = jobId ? await syncCall(rt, 'status', jobId) : await syncCall(rt, 'status')
      if (jobId && !job) throw notFound(`同步任务不存在：${jobId}`)
      return textResult(jobResult(action, job ?? null, false))
    }
    case 'start': {
      if (!argBool(args, 'all_selected_projects', 'allSelectedProjects')) {
        throw validation(
          'all_selected_projects=true 必填：start 会同步所有已选 GitLab 项目，需显式确认',
        )
      }
      const since = assertDate(argString(args, 'since', 'startDate', 'start_date'), 'since')
      const until = assertDate(argString(args, 'until', 'endDate', 'end_date'), 'until')
      if (since > until) throw validation('since 不能晚于 until')

      const active = await trySyncCall(rt, 'status')
      if (active && isActiveJob(active)) return textResult(jobResult(action, active, true))

      const selection = (await syncCall(rt, 'getSelection', connectionId)) ?? []
      const selectedCount = Array.isArray(selection)
        ? selection.filter((p) => Number(pickNumber(p, ['enabled'], 1)) !== 0).length
        : 0
      if (selectedCount === 0) {
        throw validation('请先选择至少一个 GitLab 项目（report_sync action=save_selection）')
      }
      const started = await syncCall(rt, 'start', { connectionId, startDate: since, endDate: until })
      const startedId = pickString(started, ['jobId', 'job_id', 'id'])
      const job = startedId ? ((await trySyncCall(rt, 'status', startedId)) ?? started) : started
      return textResult(jobResult(action, job ?? null, false))
    }
    case 'cancel': {
      const job = jobId ? await syncCall(rt, 'status', jobId) : await syncCall(rt, 'status')
      if (!job) throw notFound(jobId ? `同步任务不存在：${jobId}` : '当前没有进行中的同步任务')
      const id = pickString(job, ['jobId', 'job_id'])
      await syncCall(rt, 'cancel', id)
      const updated = (await trySyncCall(rt, 'status', id)) ?? job
      return textResult(jobResult(action, updated, false))
    }
    default:
      throw validation(`action 必须是 ${SYNC_ACTIONS.join(' / ')}，收到：${action}`)
  }
}

/* -------------------------------------------------------------- Schema 构造 */

/**
 * @param {Record<string, any>} properties
 * @param {string[]} [required]
 * @returns {Record<string, any>}
 */
function objectSchema(properties, required) {
  /** @type {Record<string, any>} */
  const schema = { type: 'object', properties }
  if (required && required.length) schema.required = required
  return schema
}

/**
 * 周期参数 schema（对应 Go `periodSchema`，`report_tools.go:492-498`）。
 *
 * @returns {Record<string, any>}
 */
function periodSchema() {
  return objectSchema({
    type: {
      type: 'string',
      enum: REPORT_TYPES,
      description: '报告类型：week（周报）/ month（月报）/ quarter（季报）/ year（年报），缺省 week。',
    },
    startDate: { type: 'string', description: '周期起始日（含），YYYY-MM-DD。' },
    endDate: { type: 'string', description: '周期结束日（含），YYYY-MM-DD。' },
  })
}

/**
 * `report_brief` schema：周期 + 必填起止日（Go 的 required 来自 `Meta.Required`）。
 *
 * @returns {Record<string, any>}
 */
function briefSchema() {
  const schema = periodSchema()
  schema.required = ['startDate', 'endDate']
  return schema
}

/**
 * `report_commits` schema（Go `gatherCommitsSchema`，`:500-520`）。
 *
 * @returns {Record<string, any>}
 */
function gatherCommitsSchema() {
  const schema = periodSchema()
  Object.assign(schema.properties, {
    repo: {
      type: 'string',
      description: '可选仓库过滤：path_with_namespace 或仓库名子串，例如 erp-eai。',
    },
    limit: { type: 'integer', description: '每页条数（默认 40，上限 80）。' },
    offset: { type: 'integer', description: '在当前过滤结果里的 0 基偏移。' },
    includeMerge: { type: 'boolean', description: '是否包含 merge / cherry-pick 提交（默认 false）。' },
  })
  schema.required = ['startDate', 'endDate']
  return schema
}

/**
 * @returns {Record<string, any>}
 */
function reportStatsSchema() {
  const schema = periodSchema()
  schema.properties.reportId = { type: 'string', description: '给出时读取已存报告的统计，不再按周期实时计算。' }
  return schema
}

/**
 * @returns {Record<string, any>}
 */
function upsertSchema() {
  const schema = periodSchema()
  schema.properties.content = { type: 'string', description: '完整 Markdown 报告正文。' }
  schema.required = ['type', 'startDate', 'endDate', 'content']
  return schema
}

/**
 * @returns {Record<string, any>}
 */
function idSchema() {
  return objectSchema({ reportId: { type: 'string', description: '报告 ID，形如 week:2026-10-20:2026-10-26。' } }, ['reportId'])
}

/**
 * `report_sync` schema（Go `commitSyncSchema`，`:572-588`）。
 *
 * @returns {Record<string, any>}
 */
function commitSyncSchema() {
  return objectSchema({
    action: {
      type: 'string',
      enum: SYNC_ACTIONS,
      description:
        '缺省 coverage。get_selection / list_candidates / save_selection 配置同步范围；start 同步全部已选项目（需 all_selected_projects=true）；cancel 停止当前任务。',
    },
    jobId: { type: 'string', description: 'status / cancel 指定的同步任务 ID；缺省操作当前活动任务。' },
    connection_id: {
      type: 'string',
      description: '可选连接过滤；save_selection 时只替换该连接的仓库，其它连接保留。',
    },
    q: { type: 'string', description: 'list_candidates 的名称/路径子串过滤。' },
    refresh: { type: 'boolean', description: 'list_candidates 是否先刷新 GitLab membership 缓存。' },
    projects: {
      type: 'array',
      description: 'save_selection 的仓库列表（每项至少需要 project_id）。',
      items: {
        type: 'object',
        properties: {
          connection_id: { type: 'string' },
          project_id: { type: 'integer' },
          name: { type: 'string' },
          path_with_namespace: { type: 'string' },
        },
        required: ['project_id'],
      },
    },
    since: { type: 'string', description: 'start 的起始日（含），YYYY-MM-DD。' },
    until: { type: 'string', description: 'start 的结束日（含），YYYY-MM-DD。' },
    all_selected_projects: {
      type: 'boolean',
      description: 'start 必须为 true：确认同步所有已选 GitLab 项目。',
    },
  })
}

/* ---------------------------------------------------------------- 工具表 */

/**
 * @typedef {object} ToolSpec
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} parameters
 * @property {boolean} readOnly
 * @property {(rt: ReportRuntime, args: Record<string, unknown>) => any} run
 */

/** 9 个工具的静态描述（顺序与 Go 注册顺序一致）。 @type {ToolSpec[]} */
const TOOL_SPECS = [
  {
    name: 'report_brief',
    description: '读取当前周期配置的报告模板与写作指引（template / guidance / hostInstructions）。写报告前先调用。',
    parameters: briefSchema(),
    readOnly: true,
    run: handleBrief,
  },
  {
    name: 'report_commits',
    description:
      '拉取一个报告周期的精简提交页（大周期用 repo/limit/offset 分页；默认省略 merge/cherry-pick）。汇总总量请优先用 report_stats。',
    parameters: gatherCommitsSchema(),
    readOnly: true,
    run: handleCommits,
  },
  {
    name: 'report_stats',
    description: '确定性统计：给 reportId 读已存统计，否则按周期计算实时分析（提交数/增删/行数口径/仓库分支/业务域）。',
    parameters: reportStatsSchema(),
    readOnly: true,
    run: handleStats,
  },
  {
    name: 'report_update',
    description:
      '保存 Agent 撰写的 Markdown 并刷新全部确定性投影。会写入本地报告库；同一周期重复调用即覆盖。保存后只回短摘要，不要再调 report_export，也不要把全文贴进对话。',
    parameters: upsertSchema(),
    readOnly: false,
    run: handleUpdate,
  },
  {
    name: 'report_list',
    description: '列出已存报告（ID / 类型 / 周期 / 状态 / 提交数）。',
    parameters: objectSchema({}),
    readOnly: true,
    run: handleList,
  },
  {
    name: 'report_get',
    description: '读取一份已存报告：统计字段、正文与 topics。',
    parameters: idSchema(),
    readOnly: true,
    run: handleGet,
  },
  {
    name: 'report_export',
    description: '导出一份已存报告的 Markdown 正文（超过 32000 字符会截断并标记 truncated）。',
    parameters: idSchema(),
    readOnly: true,
    run: handleExport,
  },
  {
    name: 'report_delete',
    description: '永久删除一份已存报告（会写本地报告库，不可恢复）。',
    parameters: idSchema(),
    readOnly: false,
    run: handleDelete,
  },
  {
    name: 'report_sync',
    description:
      '管理 GitLab 提交同步：覆盖度、已选范围、候选项、任务状态、启动与取消。start 会同步全部已选项目，必须 all_selected_projects=true。',
    parameters: commitSyncSchema(),
    readOnly: false,
    run: handleSync,
  },
]

/**
 * 9 个工具的静态元数据（测试与文档用；不含执行逻辑）。
 *
 * @returns {Array<{ name: string, parameters: Record<string, any>, readOnly: boolean }>}
 */
export function toolCatalog() {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    parameters: spec.parameters,
    readOnly: spec.readOnly,
  }))
}

/**
 * 把一个 spec 包成 DSH `ToolDefinition`（宿主契约见 cordis `tools.register`）。
 *
 * @param {ToolSpec} spec
 * @param {ReportRuntime} rt
 * @returns {Record<string, any>}
 */
function defineTool(spec, rt) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'object' },
      render: renderResult,
    },
    /** 只读工具允许宿主并发批处理；写工具必须串行。 */
    isConcurrencySafe: () => spec.readOnly,
    /**
     * @param {unknown} args
     * @returns {Promise<Record<string, any>>}
     */
    async execute(args) {
      const input = args && typeof args === 'object' ? /** @type {Record<string, unknown>} */ (args) : {}
      try {
        return await spec.run(rt, input)
      } catch (error) {
        const message = error instanceof ReportError ? error.message : String(error?.message ?? error)
        rt.log('tool-failed', { tool: spec.name, message })
        throw error instanceof ReportError ? error : new ReportError(message, 'INTERNAL')
      }
    },
  }
}

/**
 * 注册 9 个报告工具。
 *
 * @param {{ tools: { register: (definition: Record<string, any>, options?: Record<string, any>) => () => void } }} ctx DSH Host 上下文
 * @param {Record<string, any>} deps 见文件头
 * @returns {() => void} 一次性释放全部注册
 */
export function registerTools(ctx, deps = {}) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('registerTools 需要 ctx.tools.register（index.js 的 inject 是否包含 "tools"？）')
  }
  const rt = createRuntime(deps)
  /** @type {Array<() => void>} */
  const disposers = []
  for (const spec of TOOL_SPECS) {
    const dispose = ctx.tools.register(defineTool(spec, rt))
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  rt.log('tools-registered', { count: TOOL_SPECS.length })
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 释放失败不影响其余工具 */
      }
    }
  }
}
