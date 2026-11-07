/**
 * ids.test.mjs —— 报告 ID 与类型文案（Go `persist.go:22,185-196` + 前端 `storedReportId.ts`）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REPORT_TYPES, buildReportId, formatReportType, parseReportId } from '../../lib/domain/ids.js'

test('buildReportId：type:startDate:endDate（与 Go Sprintf 一致，不做校验）', () => {
  assert.equal(buildReportId('week', '2026-07-27', '2026-08-02'), 'week:2026-07-27:2026-08-02')
  assert.equal(buildReportId('month', '2026-08-01', '2026-08-31'), 'month:2026-08-01:2026-08-31')
  // Go 不校验 → 空/非法值也照样拼（宽容生成）
  assert.equal(buildReportId('', '2026-01-01', '2026-01-02'), ':2026-01-01:2026-01-02')
})

test('parseReportId：严格正则（4 种类型 + 两个 YYYY-MM-DD）', () => {
  assert.deepEqual(parseReportId('week:2026-07-27:2026-08-02'), {
    type: 'week',
    startDate: '2026-07-27',
    endDate: '2026-08-02',
  })
  assert.deepEqual(parseReportId('  quarter:2026-07-01:2026-09-30  '), {
    type: 'quarter',
    startDate: '2026-07-01',
    endDate: '2026-09-30',
  })
  assert.equal(parseReportId('weekly:2026-07-27:2026-08-02'), null) // 非法 type
  assert.equal(parseReportId('week:2026-7-27:2026-08-02'), null) // 非零填充日期
  assert.equal(parseReportId('week:2026-07-27'), null) // 缺段
  assert.equal(parseReportId(''), null)
  assert.equal(parseReportId(undefined), null)
})

test('REPORT_TYPES：4 种且被冻结', () => {
  assert.deepEqual([...REPORT_TYPES], ['week', 'month', 'quarter', 'year'])
  assert.equal(Object.isFrozen(REPORT_TYPES), true)
})

test('formatReportType：month/quarter/year 映射；其余（含 week/非法值）回落周报', () => {
  assert.equal(formatReportType('week'), '周报')
  assert.equal(formatReportType('month'), '月报')
  assert.equal(formatReportType('quarter'), '季报')
  assert.equal(formatReportType('year'), '年报')
  assert.equal(formatReportType('unknown'), '周报') // Go default 分支
  assert.equal(formatReportType(''), '周报')
})
