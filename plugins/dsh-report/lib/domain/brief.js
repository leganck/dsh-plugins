/**
 * brief.js —— 报告写作契约（Go `internal/report/persist.go:70-97,169-183`）。
 *
 * 契约来源链（Go）：`GetReportBrief` → `config.Current()` → `templateAndGuidance` →
 * 配置值 trim 后为空则回落 `templates.go` 的 `Default*`。插件侧把「取配置」外置为入参
 * （`template` / `guidance` 由调用方从插件 Config / DB 模板表读出后传入），本模块只负责拼装。
 *
 * 逐字节契约：
 *   - 模板占位符是**精确串** `YYYY-MM-DD 至 YYYY-MM-DD`（ReplaceAll）；
 *   - `period = startDate + " 至 " + endDate`（注意与 `period.js` 的 `" ~ "` 不同，勿统一）；
 *   - `hostInstructions` 是写死常量，不由用户配置（Go persist.go:92-95）。
 */
import { DEFAULT_GUIDANCE, DEFAULT_TEMPLATES } from './briefDefaults.js'
import { formatReportType } from './ids.js'
import { fallbackText, toStr, trimSpace } from './text.js'

/** 模板里的周期占位符（Go `strings.ReplaceAll(template, "YYYY-MM-DD 至 YYYY-MM-DD", period)`）。 */
export const TEMPLATE_PERIOD_PLACEHOLDER = 'YYYY-MM-DD 至 YYYY-MM-DD'

/**
 * 写作约束（Go `persist.go:92-95` 的硬编码常量，逐字节一致）。
 * 这段文案会作为 Host/Agent 的行为约束，改动等于改生成质量契约。
 */
export const HOST_INSTRUCTIONS =
  '只基于本 brief 与 report_commits / report_stats（及用户显式提供的素材/旧稿）撰写 Markdown；' +
  '先用 report_stats 看汇总，再用 report_commits 按页拉取精简明细（limit/offset，大仓可传 repo=名称子串）；' +
  '若返回 hasMore/truncated=true，必须继续分页直到取完，不要假定一次返回全量；' +
  '不要编造业务背景，不要输出仓库 URL 或密钥。'

/** 合法模板键（Go `switch` 的 4 个 case；其余走 default=week）。 @type {Set<string>} */
const REPORT_TEMPLATE_KEYS = new Set(['week', 'month', 'quarter', 'year'])

/**
 * 取「模板 + guidance」（Go `templateAndGuidance`）。
 *
 * 类型归一：只认 4 种类型；其它值（含空串）走 `week` 的默认分支（与 Go `switch default` 一致）。
 * 回落规则：**逐字段独立**——模板空只回落默认模板，guidance 仍可用配置值。
 * @param {string} reportType
 * @param {string} [template] 配置里的模板；空/空白 → 默认模板
 * @param {string} [guidance] 配置里的 guidance；空/空白 → 默认 guidance
 * @returns {{ template: string, guidance: string }}
 */
export function templateAndGuidance(reportType, template, guidance) {
  const key = REPORT_TEMPLATE_KEYS.has(reportType) ? reportType : 'week'
  return {
    template: fallbackText(template, DEFAULT_TEMPLATES[key]),
    guidance: fallbackText(guidance, DEFAULT_GUIDANCE[key]),
  }
}

/**
 * 拼装写作契约（Go `GetReportBrief`）。
 *
 * 校验语义与 Go 一致：
 *   - `type` trim 后为空 → `week`；非空但非法的值**保留原样**（Go 只判空，不校验枚举）；
 *   - `startDate`/`endDate` trim 后为空 → 抛 `startDate and endDate are required`；
 *   - 其它字段原样回显（不 trim），`period` 用原始值拼接。
 * @param {{
 *   type?: string,
 *   startDate?: string,
 *   endDate?: string,
 *   template?: string,
 *   guidance?: string,
 * }} input
 * @returns {import('./model.js').ReportBrief}
 */
export function getReportBrief(input) {
  const source = input ?? {}
  const rawType = toStr(source.type)
  const reportType = trimSpace(rawType) === '' ? 'week' : rawType
  const startDate = toStr(source.startDate)
  const endDate = toStr(source.endDate)
  if (trimSpace(startDate) === '' || trimSpace(endDate) === '') {
    throw new Error('startDate and endDate are required')
  }
  const { template, guidance } = templateAndGuidance(reportType, source.template, source.guidance)
  const period = `${startDate} 至 ${endDate}`
  return {
    reportType,
    reportTypeLabel: formatReportType(reportType),
    startDate,
    endDate,
    period,
    template: template.split(TEMPLATE_PERIOD_PLACEHOLDER).join(period),
    guidance,
    hostInstructions: HOST_INSTRUCTIONS,
  }
}
