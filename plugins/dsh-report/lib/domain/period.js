/**
 * period.js —— 周期区间计算（Go `internal/report/service.go:27-64`，改成真实实现）。
 *
 * Go 侧现状：`GetWeekRange` 等四个函数**在生产代码里没有调用方**（死代码），
 * 周期实际由前端 `useReportGenerate.ts:29-71` 用本地时区计算。插件里把周期计算收回后端/领域层，
 * 语义取前端版：**本地时区、周一为周首日**；`DateRange.period` 仍用 Go 的 `" ~ "` 连接（勿统一成 `" 至 "`）。
 *
 * 注意：Go 实现用 `time.Date(..., time.UTC)` 只负责“构造日期”，年/月/日的取值仍来自 `now` 自身时区
 * （service.go:27-35）；本实现直接用本地日历字段，等价且不踩 UTC 跨日边界。
 */
import { toStr } from './text.js'

/**
 * 把 Date 或 `YYYY-MM-DD` 字符串格式化为本地日历日期串。
 * 用 `getFullYear/getMonth/getDate`，**不能用** `toISOString()`（会按 UTC 偏移跨日）。
 * @param {Date | string} value
 * @returns {string}
 */
function formatLocalDate(value) {
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
    return formatLocalDate(new Date(text))
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`无法格式化的日期：${String(value)}`)
  }
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 构造周期区间（Go `makeRange`）。
 * `period` 用 `" ~ "` 连接 —— 与报告记录的 `" 至 "` 不同，这是 Go 现状，别顺手统一。
 * @param {Date | string} start
 * @param {Date | string} end
 * @returns {import('./model.js').DateRange}
 */
export function makeRange(start, end) {
  const startText = formatLocalDate(start)
  const endText = formatLocalDate(end)
  return {
    start: startText,
    end: endText,
    period: `${startText} ~ ${endText}`,
  }
}

/**
 * 本地日期构造（避免 `new Date(y, m, d)` 受原始 Date 的时分秒/时区影响）。
 * @param {number} year
 * @param {number} month 0-based
 * @param {number} day
 * @returns {Date}
 */
function localDate(year, month, day) {
  return new Date(year, month, day, 0, 0, 0, 0)
}

/**
 * 周区间：周一起始、周日结束（Go `GetWeekRange`；周日映射为 7）。
 * @param {Date} [now]
 * @returns {import('./model.js').DateRange}
 */
export function getWeekRange(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now)
  const year = current.getFullYear()
  const month = current.getMonth()
  const day = current.getDate()
  const weekday = current.getDay() === 0 ? 7 : current.getDay()
  const monday = localDate(year, month, day - weekday + 1)
  const sunday = localDate(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  return makeRange(monday, sunday)
}

/**
 * 月区间：当月 1 日 ~ 当月最后一日（Go `GetMonthRange`）。
 * @param {Date} [now]
 * @returns {import('./model.js').DateRange}
 */
export function getMonthRange(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now)
  const year = current.getFullYear()
  const month = current.getMonth()
  const first = localDate(year, month, 1)
  const last = localDate(year, month + 1, 0)
  return makeRange(first, last)
}

/**
 * 季区间：`month = floor((M-1)/3)*3` 为季度首月（Go 整数除法），首月 1 日 ~ `+3 月 -1 天`。
 * @param {Date} [now]
 * @returns {import('./model.js').DateRange}
 */
export function getQuarterRange(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now)
  const year = current.getFullYear()
  const month = Math.floor(current.getMonth() / 3) * 3
  const first = localDate(year, month, 1)
  const last = localDate(year, month + 3, 0)
  return makeRange(first, last)
}

/**
 * 年区间：01-01 ~ 12-31（Go `GetYearRange`）。
 * @param {Date} [now]
 * @returns {import('./model.js').DateRange}
 */
export function getYearRange(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now)
  const year = current.getFullYear()
  return makeRange(localDate(year, 0, 1), localDate(year, 11, 31))
}

/**
 * 当前周期的字符串形式（`start|end`，与前端 `ReportPeriodOption.value` 一致）。
 * 便利函数，不属 Go 契约。
 * @param {import('./model.js').DateRange} range
 * @returns {string}
 */
export function periodValue(range) {
  return `${toStr(range?.start)}|${toStr(range?.end)}`
}
