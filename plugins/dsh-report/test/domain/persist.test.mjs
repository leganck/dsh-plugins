/**
 * persist.test.mjs —— 写入编排（Go `UpsertReport` 的 5 步插件版）用 fake db API 全覆盖。
 *
 * 为什么用 fake：`lib/db.js` 由数据域并行实现，领域测试不应等它；
 * 真实绑定由 `persistWiring.test.mjs` 在 db.js 出现后自动启用。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REQUIRED_DB_API, upsertReportCore } from '../../lib/domain/persistCore.js'
import { makeCommit, makeDbRow } from './fixtures.mjs'

/**
 * 造一个记录调用序列的 fake db API。
 * @param {{ rows?: Array<Record<string, unknown>>, aggregatesWriter?: boolean, transaction?: boolean }} [options]
 */
function createFakeDbApi(options = {}) {
  const rows = options.rows ?? []
  const aggregatesWriter = options.aggregatesWriter ?? true
  const transaction = options.transaction ?? true
  /** @type {Array<Record<string, unknown>>} */
  const calls = []
  /** @type {Record<string, any>} */
  const api = {
    listCommitsInPeriod(db, query) {
      calls.push({ op: 'listCommitsInPeriod', db, query })
      return rows
    },
    upsertReportRow(db, row) {
      calls.push({ op: 'upsertReportRow', db, row })
    },
    replaceLineStats(db, reportId, items) {
      calls.push({ op: 'replaceLineStats', db, reportId, items })
    },
    replaceRepoBranchStats(db, reportId, items) {
      calls.push({ op: 'replaceRepoBranchStats', db, reportId, items })
    },
    replaceTopics(db, reportId, items) {
      calls.push({ op: 'replaceTopics', db, reportId, items })
    },
  }
  if (aggregatesWriter) {
    api.upsertReportAggregates = (db, reportId, aggregates) => {
      calls.push({ op: 'upsertReportAggregates', db, reportId, aggregates })
    }
  }
  if (transaction) {
    api.withTransaction = (db, fn) => {
      calls.push({ op: 'BEGIN', db })
      const result = fn()
      calls.push({ op: 'COMMIT', db })
      return result
    }
  }
  return { api, calls, db: { name: 'fake-db' } }
}

test('upsertReportCore：读提交在事务外，5 步写在同一事务内（顺序固定）', () => {
  const { api, calls, db } = createFakeDbApi({ rows: [makeDbRow()] })
  const result = upsertReportCore(api, db, {
    type: 'week',
    startDate: '2026-08-03',
    endDate: '2026-08-09',
    content: '# 周报',
  })
  assert.deepEqual(
    calls.map((call) => call.op),
    [
      'listCommitsInPeriod',
      'BEGIN',
      'upsertReportRow',
      'upsertReportAggregates',
      'replaceLineStats',
      'replaceRepoBranchStats',
      'replaceTopics',
      'COMMIT',
    ],
  )
  assert.deepEqual(result.reportId, 'week:2026-08-03:2026-08-09')
  assert.deepEqual(Object.keys(result).sort(), [
    'aggregates',
    'lineStats',
    'repoBranchStats',
    'reportId',
    'topics',
  ])
  // 读提交的查询参数与 reportId 同源
  assert.deepEqual(calls[0].query, { startDate: '2026-08-03', endDate: '2026-08-09' })
})

test('upsertReportCore：reports 行字段与 content 落库口径（trim / status）', () => {
  const { api, calls, db } = createFakeDbApi({ rows: [makeDbRow()] })
  upsertReportCore(api, db, {
    type: 'month',
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    content: '  # 月报正文  \n\n  末尾\n',
  })
  const row = calls.find((call) => call.op === 'upsertReportRow').row
  assert.deepEqual(row, {
    reportId: 'month:2026-08-01:2026-08-31',
    reportType: 'month',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    status: 'generated',
    content: '# 月报正文  \n\n  末尾', // 只裁首尾空白，不动中间
    errorMessage: null,
  })
})

test('upsertReportCore：空 content → status=empty、content=null；显式 status 可覆盖', () => {
  const { api, calls, db } = createFakeDbApi({ rows: [] })
  upsertReportCore(api, db, { type: 'week', startDate: '2026-08-03', endDate: '2026-08-09', content: '   ' })
  let row = calls.find((call) => call.op === 'upsertReportRow').row
  assert.equal(row.status, 'empty')
  assert.equal(row.content, null)

  const second = createFakeDbApi({ rows: [] })
  upsertReportCore(second.api, second.db, {
    type: 'week',
    startDate: '2026-08-03',
    endDate: '2026-08-09',
    content: '正文',
    status: 'pending',
  })
  row = second.calls.find((call) => call.op === 'upsertReportRow').row
  assert.equal(row.status, 'pending')
  assert.equal(row.content, '正文')
})

test('upsertReportCore：snake_case 库行经 commitView 归一后参与统计', () => {
  const rows = [
    makeDbRow({ commit_id: 'n1', title: 'feat: normal', additions: 100, deletions: 20, total: 120 }),
    makeDbRow({ commit_id: 'm1', title: 'feat: flagged merge', is_merge_commit: 1, additions: 999 }),
    makeDbRow({ commit_id: 'c1', title: 'fix: cherry', is_cherry_pick_commit: 1, additions: 50 }),
    makeDbRow({ commit_id: 'c2', title: 'fix: source cherry', cherry_pick_source_commit: 'abc' }),
  ]
  const { api, calls, db } = createFakeDbApi({ rows })
  const result = upsertReportCore(api, db, {
    type: 'week',
    startDate: '2026-08-03',
    endDate: '2026-08-09',
    content: '# x',
  })
  assert.equal(result.aggregates.totalCommits, 4)
  assert.equal(result.aggregates.mergeCommitCount, 1)
  assert.equal(result.aggregates.cherryPickCommitCount, 2)
  assert.equal(result.aggregates.totalAdditions, 100) // 只有 n1 计入
  assert.equal(result.aggregates.totalDeletions, 20)
  const lineStats = calls.find((call) => call.op === 'replaceLineStats').items
  assert.equal(lineStats.length, 2)
  assert.equal(lineStats[1].additions, 100)
  const topics = calls.find((call) => call.op === 'replaceTopics').items
  assert.equal(Array.isArray(topics), true)
})

test('upsertReportCore：db.js 无 upsertReportAggregates 时，统计随 reports 行以 aggregatesJson 落库', () => {
  const { api, calls, db } = createFakeDbApi({ rows: [makeDbRow()], aggregatesWriter: false })
  const result = upsertReportCore(api, db, {
    type: 'week',
    startDate: '2026-08-03',
    endDate: '2026-08-09',
    content: '# x',
  })
  const row = calls.find((call) => call.op === 'upsertReportRow').row
  assert.equal(typeof row.aggregatesJson, 'string')
  assert.deepEqual(JSON.parse(row.aggregatesJson), result.aggregates)
  assert.equal(
    calls.some((call) => call.op === 'upsertReportAggregates'),
    false,
  )
})

test('upsertReportCore：db.js 无 withTransaction 时退化为顺序写（不抛错）', () => {
  const { api, calls, db } = createFakeDbApi({ rows: [makeDbRow()], transaction: false })
  upsertReportCore(api, db, { type: 'week', startDate: '2026-08-03', endDate: '2026-08-09', content: '# x' })
  assert.deepEqual(
    calls.map((call) => call.op),
    ['listCommitsInPeriod', 'upsertReportRow', 'upsertReportAggregates', 'replaceLineStats', 'replaceRepoBranchStats', 'replaceTopics'],
  )
})

test('upsertReportCore：db.js 缺契约函数时报可操作的错误（列出缺哪几个）', () => {
  const { api, db } = createFakeDbApi()
  delete api.replaceTopics
  delete api.replaceRepoBranchStats
  assert.throws(
    () => upsertReportCore(api, db, { type: 'week', startDate: '2026-08-03', endDate: '2026-08-09', content: 'x' }),
    /lib\/db\.js 缺少契约函数：replaceRepoBranchStats, replaceTopics/,
  )
  assert.throws(() => upsertReportCore(null, db, {}), /缺少 db API/)
})

test('upsertReportCore：日期必填（与 Go 同错误文案）；不校验 type 枚举', () => {
  const { api, db } = createFakeDbApi({ rows: [] })
  assert.throws(
    () => upsertReportCore(api, db, { type: 'week', startDate: '', endDate: '2026-08-09', content: 'x' }),
    /startDate and endDate are required/,
  )
  const result = upsertReportCore(api, db, {
    type: 'sprint',
    startDate: '2026-08-03',
    endDate: '2026-08-09',
    content: 'x',
  })
  assert.equal(result.reportId, 'sprint:2026-08-03:2026-08-09')
})

test('upsertReportCore：aggregates / topics 与返回值同源（同一引用，不复制）', () => {
  const rows = [
    makeDbRow({ title: 'feat: login', path_with_namespace: 'group/crm-order' }),
    makeDbRow({ title: 'fix: login', path_with_namespace: 'group/crm-order' }),
  ]
  const { api, calls, db } = createFakeDbApi({ rows })
  const result = upsertReportCore(api, db, {
    type: 'week',
    startDate: '2026-08-03',
    endDate: '2026-08-09',
    content: '# x',
  })
  const aggregatesCall = calls.find((call) => call.op === 'upsertReportAggregates')
  assert.equal(aggregatesCall.aggregates, result.aggregates)
  const topicsCall = calls.find((call) => call.op === 'replaceTopics')
  assert.equal(topicsCall.items, result.topics)
  assert.equal(result.topics.length, 1)
  assert.equal(result.topics[0].summary, '2 次提交')
})

test('REQUIRED_DB_API：契约函数名单固定（与 CONTRACTS §2 对齐）', () => {
  assert.deepEqual([...REQUIRED_DB_API], [
    'listCommitsInPeriod',
    'upsertReportRow',
    'replaceLineStats',
    'replaceRepoBranchStats',
    'replaceTopics',
  ])
})

test('并发/重复保存同一周期：reportId 相同即覆盖（同 ID 两次调用都写同一行）', () => {
  const { api, calls, db } = createFakeDbApi({ rows: [makeCommit()] })
  upsertReportCore(api, db, { type: 'week', startDate: '2026-08-03', endDate: '2026-08-09', content: 'v1' })
  upsertReportCore(api, db, { type: 'week', startDate: '2026-08-03', endDate: '2026-08-09', content: 'v2' })
  const rows = calls.filter((call) => call.op === 'upsertReportRow').map((call) => call.row)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].reportId, rows[1].reportId)
  assert.equal(rows[0].content, 'v1')
  assert.equal(rows[1].content, 'v2')
})
