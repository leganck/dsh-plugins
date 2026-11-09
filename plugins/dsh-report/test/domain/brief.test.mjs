/**
 * brief.test.mjs —— 写作契约拼装（Go `GetReportBrief` / `templateAndGuidance`）。
 *
 * 逐字节部分（模板/guidance/HOST_INSTRUCTIONS）由 `sourceParity.test.mjs` 直接对 Go 源码断言；
 * 本文件只测**拼装与回落逻辑**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HOST_INSTRUCTIONS,
  TEMPLATE_PERIOD_PLACEHOLDER,
  getReportBrief,
  templateAndGuidance,
} from '../../lib/domain/brief.js'
import { DEFAULT_GUIDANCE, DEFAULT_TEMPLATES, GUIDANCE_COMMON } from '../../lib/domain/briefDefaults.js'

test('getReportBrief：默认模板 + 占位符替换 + period 用 " 至 "', () => {
  const brief = getReportBrief({ type: 'week', startDate: '2026-08-03', endDate: '2026-08-09' })
  assert.equal(brief.reportType, 'week')
  assert.equal(brief.reportTypeLabel, '周报')
  assert.equal(brief.startDate, '2026-08-03')
  assert.equal(brief.endDate, '2026-08-09')
  assert.equal(brief.period, '2026-08-03 至 2026-08-09')
  assert.equal(brief.template.includes(TEMPLATE_PERIOD_PLACEHOLDER), false)
  assert.equal(brief.template.startsWith('# 周报（2026-08-03 至 2026-08-09）'), true)
  assert.equal(brief.guidance, DEFAULT_GUIDANCE.week)
  assert.equal(brief.hostInstructions, HOST_INSTRUCTIONS)
})

test('getReportBrief：月/季/年类型文案与模板', () => {
  const cases = [
    ['month', '月报', '# 月报（2026-08-01 至 2026-08-31）'],
    ['quarter', '季报', '# 季报（2026-07-01 至 2026-09-30）'],
    ['year', '年报', '# 年报（2026-01-01 至 2026-12-31）'],
  ]
  const ranges = [
    ['2026-08-01', '2026-08-31'],
    ['2026-07-01', '2026-09-30'],
    ['2026-01-01', '2026-12-31'],
  ]
  cases.forEach(([type, label, firstLine], index) => {
    const [startDate, endDate] = ranges[index]
    const brief = getReportBrief({ type, startDate, endDate })
    assert.equal(brief.reportTypeLabel, label)
    assert.equal(brief.guidance, DEFAULT_GUIDANCE[type])
    assert.equal(brief.template.startsWith(firstLine), true)
  })
})

test('getReportBrief：type 空 → week；非法/带空格值保留原样（Go 只判空）', () => {
  const fallback = getReportBrief({ type: '   ', startDate: '2026-08-03', endDate: '2026-08-09' })
  assert.equal(fallback.reportType, 'week')
  assert.equal(fallback.guidance, DEFAULT_GUIDANCE.week)

  const spaced = getReportBrief({ type: ' Week ', startDate: '2026-08-03', endDate: '2026-08-09' })
  assert.equal(spaced.reportType, ' Week ') // 原样回显（Go 不 trim 回显值）
  assert.equal(spaced.reportTypeLabel, '周报') // formatReportType default 分支

  const unknown = getReportBrief({ type: 'sprint', startDate: '2026-08-03', endDate: '2026-08-09' })
  assert.equal(unknown.reportType, 'sprint')
  assert.equal(unknown.template, DEFAULT_TEMPLATES.week.split(TEMPLATE_PERIOD_PLACEHOLDER).join('2026-08-03 至 2026-08-09'))
})

test('getReportBrief：缺日期抛错（错误文案与 Go 一致）', () => {
  assert.throws(
    () => getReportBrief({ type: 'week', startDate: '', endDate: '2026-08-09' }),
    /startDate and endDate are required/,
  )
  assert.throws(
    () => getReportBrief({ type: 'week', startDate: '   ', endDate: '2026-08-09' }),
    /startDate and endDate are required/,
  )
  assert.throws(() => getReportBrief({}), /startDate and endDate are required/)
})

test('templateAndGuidance：为空的字段逐个回落到默认（互不影响）', () => {
  const byDefault = templateAndGuidance('month', '', '  ')
  assert.equal(byDefault.template, DEFAULT_TEMPLATES.month)
  assert.equal(byDefault.guidance, DEFAULT_GUIDANCE.month)

  const customTemplate = templateAndGuidance('month', '自定义模板：YYYY-MM-DD 至 YYYY-MM-DD', '')
  assert.equal(customTemplate.template, '自定义模板：YYYY-MM-DD 至 YYYY-MM-DD')
  assert.equal(customTemplate.guidance, DEFAULT_GUIDANCE.month)

  const customGuidance = templateAndGuidance('month', '', '只写三条')
  assert.equal(customGuidance.template, DEFAULT_TEMPLATES.month)
  assert.equal(customGuidance.guidance, '只写三条')

  // 非法类型走 week 默认分支
  assert.equal(templateAndGuidance('sprint', '', '').template, DEFAULT_TEMPLATES.week)
})

test('getReportBrief：配置模板/guidance 优先，模板占位符照常替换', () => {
  const brief = getReportBrief({
    type: 'week',
    startDate: '2026-08-03',
    endDate: '2026-08-09',
    template: '# 自定义周报（YYYY-MM-DD 至 YYYY-MM-DD）\n\n## 我的小节',
    guidance: '自定义引导',
  })
  assert.equal(brief.template, '# 自定义周报（2026-08-03 至 2026-08-09）\n\n## 我的小节')
  assert.equal(brief.guidance, '自定义引导')
  // 不含占位符的模板原样保留
  const noPlaceholder = getReportBrief({
    type: 'week',
    startDate: '2026-08-03',
    endDate: '2026-08-09',
    template: '无占位符模板',
  })
  assert.equal(noPlaceholder.template, '无占位符模板')
})

test('HOST_INSTRUCTIONS：包含 4 条行为约束的关键措辞', () => {
  assert.equal(GUIDANCE_COMMON.length > 0, true)
  for (const keyword of ['report_commits', 'report_stats', 'hasMore/truncated=true', '不要编造业务背景']) {
    assert.equal(HOST_INSTRUCTIONS.includes(keyword), true, `HOST_INSTRUCTIONS 缺少 ${keyword}`)
  }
  // 公共段是月/季/年 guidance 的前缀；周报使用独立的编号清单 guidance。
  for (const type of ['month', 'quarter', 'year']) {
    assert.equal(DEFAULT_GUIDANCE[type].startsWith(GUIDANCE_COMMON), true)
  }
})
