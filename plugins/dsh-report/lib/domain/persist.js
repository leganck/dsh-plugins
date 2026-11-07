/**
 * persist.js —— 报告写入编排的「真实 db 绑定层」（CONTRACTS §3 的 `upsertReport`）。
 *
 * 本文件是 `lib/domain/**` 中**唯一**依赖 `lib/db.js` 的模块：
 *   `import * as dbApi from '../db.js'` —— 数据域按 CONTRACTS §2 提供函数（名单见 persistCore.js）。
 *
 * 为什么把编排放在 persistCore.js：
 *   db.js 由并行队员实现，落地前任何静态 import 它的模块都无法被单测加载；
 *   把纯逻辑放 persistCore 并允许注入 fake，是让「领域测试」与「数据层进度」解耦的手段。
 *   工具/API 层只需 `import { upsertReport } from './domain/persist.js'`，签名与 CONTRACTS 一致。
 *
 * 依赖的 db.js 函数（CONTRACTS §2）：
 *   - `listCommitsInPeriod(db, { startDate, endDate })`
 *   - `upsertReportRow(db, row)`（reports 单行：reportId/reportType/periodStart/periodEnd/status/content/errorMessage）
 *   - `upsertReportAggregates(db, reportId, aggregates)`（可选；缺省时统计以 `aggregatesJson` 随行写入）
 *   - `replaceLineStats` / `replaceRepoBranchStats` / `replaceTopics`
 *   - `withTransaction(db, fn)`（可选；提供时 5 步写收敛为单事务）
 */
import * as sqliteDbApi from '../db.js'
import { upsertReportCore } from './persistCore.js'

/**
 * 保存/覆盖一份报告（同周期覆盖，reportId = `type:startDate:endDate`）。
 * @param {unknown} db 由 `lib/db.js` 的 `openDatabase()` 返回的数据库句柄
 * @param {import('./model.js').UpsertReportInput} input
 * @returns {import('./model.js').UpsertReportResult}
 */
export function upsertReport(db, input) {
  return upsertReportCore(sqliteDbApi, db, input)
}

export { REQUIRED_DB_API, upsertReportCore } from './persistCore.js'
