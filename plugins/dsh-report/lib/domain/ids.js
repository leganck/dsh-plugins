/**
 * ids.js —— 报告 ID / 类型文案（Go `internal/report/persist.go:22,185-196` + 前端 `storedReportId.ts:1-7`）。
 *
 * 报告 ID 是**业务主键**：`<type>:<startDate>:<endDate>`，同 ID 重存即覆盖（CONTRACTS §1）。
 * Go 侧 `fmt.Sprintf("%s:%s:%s", ...)` 不校验任何字段；前端正则只接受
 * `^(week|month|quarter|year):\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$`。
 * 插件写法：**生成**保持 Go 的宽容（只做字符串拼接），**解析/校验**用前端的严格正则 ——
 * 非法 type 仍可入库是 Go 的已知行为，是否拒绝由工具层决定（07 分册 §3.1）。
 */
import { toStr, trimSpace } from './text.js'

/** 4 种报告类型（顺序即 UI 展示顺序）。 */
export const REPORT_TYPES = Object.freeze(['week', 'month', 'quarter', 'year'])

/** 严格 ID 正则（与前端 `storedReportId.ts` 一致）。 */
const REPORT_ID_PATTERN = /^(week|month|quarter|year):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/

/**
 * 拼接报告 ID（Go `fmt.Sprintf("%s:%s:%s", reportType, startDate, endDate)`）。
 * 不做校验：与 Go 一样宽容（空/非法 type 也会拼出字符串）。
 * @param {string} type
 * @param {string} startDate
 * @param {string} endDate
 * @returns {string}
 */
export function buildReportId(type, startDate, endDate) {
  return `${toStr(type)}:${toStr(startDate)}:${toStr(endDate)}`
}

/**
 * 解析报告 ID。
 * @param {string} reportId
 * @returns {{ type: string, startDate: string, endDate: string } | null} 非法返回 null（不抛错）
 */
export function parseReportId(reportId) {
  const match = trimSpace(reportId).match(REPORT_ID_PATTERN)
  if (!match) return null
  return { type: match[1], startDate: match[2], endDate: match[3] }
}

/**
 * 报告类型中文名（Go `formatReportType`）：`month→月报`、`quarter→季报`、`year→年报`，
 * **其它一律 `周报`**（default 分支，包含 `week` 与非法值）。
 * @param {string} type
 * @returns {string}
 */
export function formatReportType(type) {
  switch (type) {
    case 'month':
      return '月报'
    case 'quarter':
      return '季报'
    case 'year':
      return '年报'
    default:
      return '周报'
  }
}
