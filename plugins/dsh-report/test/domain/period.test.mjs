/**
 * period.test.mjs —— 周期区间（Go `service.go:27-64` 语义，本地时区、周一为周首日）。
 *
 * 这里用 `new Date(year, monthIndex, day)` 构造本地日期，因此断言不依赖运行机器的 TZ。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getMonthRange,
  getQuarterRange,
  getWeekRange,
  getYearRange,
  makeRange,
  periodValue,
} from '../../lib/domain/period.js'

test('getWeekRange：周三 → 本周一 ~ 本周日', () => {
  const wednesday = new Date(2026, 7, 5) // 2026-08-05 是周三
  assert.deepEqual(getWeekRange(wednesday), {
    start: '2026-08-03',
    end: '2026-08-09',
    period: '2026-08-03 ~ 2026-08-09',
  })
})

test('getWeekRange：周日归属上一周（周日映射为 7）', () => {
  const sunday = new Date(2026, 7, 9)
  assert.deepEqual(getWeekRange(sunday), {
    start: '2026-08-03',
    end: '2026-08-09',
    period: '2026-08-03 ~ 2026-08-09',
  })
})

test('getWeekRange：跨月/跨年周（周一在上一月）', () => {
  const tuesday = new Date(2026, 8, 1) // 2026-09-01 是周二
  assert.equal(getWeekRange(tuesday).start, '2026-08-31')
  assert.equal(getWeekRange(tuesday).end, '2026-09-06')
  const janFirst = new Date(2026, 0, 1) // 2026-01-01 是周四
  assert.equal(getWeekRange(janFirst).start, '2025-12-29')
  assert.equal(getWeekRange(janFirst).end, '2026-01-04')
})

test('getMonthRange：当月首日 ~ 当月末日（含闰年 2 月）', () => {
  assert.deepEqual(getMonthRange(new Date(2026, 7, 5)), {
    start: '2026-08-01',
    end: '2026-08-31',
    period: '2026-08-01 ~ 2026-08-31',
  })
  assert.equal(getMonthRange(new Date(2028, 1, 15)).end, '2028-02-29')
  assert.equal(getMonthRange(new Date(2026, 1, 15)).end, '2026-02-28')
  assert.equal(getMonthRange(new Date(2026, 11, 31)).end, '2026-12-31')
})

test('getQuarterRange：Q1~Q4 边界（整数除法）', () => {
  assert.deepEqual(getQuarterRange(new Date(2026, 7, 5)), {
    start: '2026-07-01',
    end: '2026-09-30',
    period: '2026-07-01 ~ 2026-09-30',
  })
  assert.deepEqual(getQuarterRange(new Date(2026, 0, 1)), {
    start: '2026-01-01',
    end: '2026-03-31',
    period: '2026-01-01 ~ 2026-03-31',
  })
  assert.equal(getQuarterRange(new Date(2026, 2, 31)).start, '2026-01-01') // 3 月仍属 Q1
  assert.equal(getQuarterRange(new Date(2026, 3, 1)).start, '2026-04-01') // 4 月起 Q2
  assert.equal(getQuarterRange(new Date(2026, 11, 31)).end, '2026-12-31')
})

test('getYearRange：01-01 ~ 12-31', () => {
  assert.deepEqual(getYearRange(new Date(2026, 7, 5)), {
    start: '2026-01-01',
    end: '2026-12-31',
    period: '2026-01-01 ~ 2026-12-31',
  })
})

test('makeRange：接受 Date 与 YYYY-MM-DD；period 用 " ~ " 连接（勿统一成 " 至 "）', () => {
  assert.deepEqual(makeRange(new Date(2026, 0, 1), new Date(2026, 0, 31)), {
    start: '2026-01-01',
    end: '2026-01-31',
    period: '2026-01-01 ~ 2026-01-31',
  })
  assert.deepEqual(makeRange('2026-01-01', '2026-01-31'), {
    start: '2026-01-01',
    end: '2026-01-31',
    period: '2026-01-01 ~ 2026-01-31',
  })
  assert.equal(periodValue(makeRange('2026-01-01', '2026-01-31')), '2026-01-01|2026-01-31')
})
