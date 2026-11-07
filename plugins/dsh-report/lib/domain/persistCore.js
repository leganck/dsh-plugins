/**
 * persistCore.js —— 报告写入编排（Go `internal/report/persist.go:12-67` 的 `UpsertReport`）。
 *
 * 为什么与 `persist.js` 拆开：
 *   `persist.js` 需要静态 `import '../db.js'`（另一并行队员的文件，契约见 CONTRACTS §2），
 *   在 db.js 尚未落地时会让任何 import 它的测试直接失败。本文件把编排逻辑做成
 *   **可注入 db API** 的纯函数，测试用 fake 全覆盖；`persist.js` 只负责绑定真实 db.js。
 *
 * Go 的 7 步写 → 插件 5 步写（表结构见 CONTRACTS §2，属已确认的简化）：
 *   Go                                   插件
 *   ① UpsertReportGroup                  → `upsertReportRow`（reports 单行：group + content + status）
 *   ② ReplaceReportCommits               → （插件无 report_group_commits 表，**不落**提交 ID 成员）
 *   ③ SaveReportAggregates               → `upsertReportAggregates`（若 db.js 提供）
 *                                          否则随 ① 以 `aggregatesJson` 字段交给 `upsertReportRow`
 *   ④ ReplaceReportLineStats             → `replaceLineStats`
 *   ⑤ ReplaceReportRepoBranchStats       → `replaceRepoBranchStats`
 *   ⑥ ReplaceReportTopics                → `replaceTopics`
 *   ⑦ SaveReportContent                  → 合并进 ①（content / status / error_message 列）
 *
 * 事务：Go 侧 7 次写**没有外层事务**（已知缺陷）；插件侧若 db.js 提供 `withTransaction`，
 * 则整体包一个事务 —— 失败语义从「库里半更新」变为「全无」，属**有意的改进**（07 分册 §3.11）。
 *
 * 时间戳：`generated_at` / `updated_at` 由 db.js 负责（SQLite CURRENT_TIMESTAMP，UTC），
 * 领域层不生成时间，避免纯函数引入时钟依赖。
 */
import { toCommitViews } from './commitView.js'
import { buildReportId } from './ids.js'
import { aggregate, buildLineStats, buildRepoBranchStats } from './stats.js'
import { buildTopics } from './topics.js'
import { toStr, trimSpace } from './text.js'

/** 编排必需的最小 db API 面（CONTRACTS §2 的函数名，缺一个就明确报错）。 */
const REQUIRED_DB_API = Object.freeze([
  'listCommitsInPeriod',
  'upsertReportRow',
  'replaceLineStats',
  'replaceRepoBranchStats',
  'replaceTopics',
])

/**
 * 校验注入的 db API 是否满足契约（缺函数时给出可操作的错误，而不是 undefined is not a function）。
 * @param {Record<string, unknown>} dbApi
 * @returns {void}
 */
function assertDbApi(dbApi) {
  if (!dbApi || typeof dbApi !== 'object') {
    throw new Error('upsertReport: 缺少 db API（应为 lib/db.js 的模块命名空间）')
  }
  const missing = REQUIRED_DB_API.filter((name) => typeof dbApi[name] !== 'function')
  if (missing.length > 0) {
    throw new Error(`upsertReport: lib/db.js 缺少契约函数：${missing.join(', ')}`)
  }
}

/**
 * 编排一次「保存/覆盖报告」。
 *
 * 行为（逐条对齐 Go）：
 *   - 取周期内全部提交（含 merge/cherry-pick）→ 算 aggregates/lineStats/repoBranchStats/topics；
 *   - `reportId = type:startDate:endDate`；
 *   - `content` 落库前 **trim**，trim 后为空 → `null`，status 推导为 `empty`，否则 `generated`；
 *   - 与 Go 相同：**任何输入都不校验 type 枚举 / 日期格式**（校验在工具层）。
 * @param {import('./model.js').ReportDbApi} dbApi
 * @param {unknown} db 数据库句柄（node:sqlite DatabaseSync 等，领域层不关心）
 * @param {import('./model.js').UpsertReportInput} input
 * @returns {import('./model.js').UpsertReportResult}
 */
export function upsertReportCore(dbApi, db, input) {
  assertDbApi(dbApi)
  const source = input ?? {}
  const reportType = toStr(source.type)
  const startDate = toStr(source.startDate)
  const endDate = toStr(source.endDate)
  const trimmedStart = trimSpace(startDate)
  const trimmedEnd = trimSpace(endDate)
  // 与 Go 一样：只判空，不校验格式/枚举（工具层负责 400）
  if (trimmedStart === '' || trimmedEnd === '') {
    throw new Error('startDate and endDate are required')
  }

  const rows = dbApi.listCommitsInPeriod(db, { startDate, endDate })
  const commits = toCommitViews(rows)
  const aggregates = aggregate(commits)
  const lineStats = buildLineStats(commits)
  const repoBranchStats = buildRepoBranchStats(commits)
  const topics = buildTopics(commits)

  const reportId = buildReportId(reportType, startDate, endDate)
  const contentText = trimSpace(source.content)
  const content = contentText === '' ? null : contentText
  const explicitStatus = trimSpace(source.status)
  const status = explicitStatus !== '' ? explicitStatus : content === null ? 'empty' : 'generated'

  const write = () => {
    const aggregatesWriter =
      typeof dbApi.upsertReportAggregates === 'function' ? dbApi.upsertReportAggregates : null
    /** @type {Record<string, unknown>} */
    const row = {
      reportId,
      reportType,
      periodStart: startDate,
      periodEnd: endDate,
      status,
      content,
      errorMessage: null,
    }
    if (aggregatesWriter === null) {
      // db.js 未提供独立聚合写入函数时：把统计一起交给 reports 行写入方（契约兼容两版实现）
      row.aggregatesJson = JSON.stringify(aggregates)
    }
    dbApi.upsertReportRow(db, row)
    if (aggregatesWriter !== null) aggregatesWriter(db, reportId, aggregates)
    dbApi.replaceLineStats(db, reportId, lineStats)
    dbApi.replaceRepoBranchStats(db, reportId, repoBranchStats)
    dbApi.replaceTopics(db, reportId, topics)
  }

  if (typeof dbApi.withTransaction === 'function') dbApi.withTransaction(db, write)
  else write()

  return { reportId, aggregates, lineStats, repoBranchStats, topics }
}

export { REQUIRED_DB_API }
