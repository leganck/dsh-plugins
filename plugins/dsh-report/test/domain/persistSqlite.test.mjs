/**
 * persistSqlite.test.mjs —— 端到端（L3）接线测试：真实 `lib/db.js` + 临时 SQLite + `upsertReport`。
 *
 * 数据域的 `lib/db.js` 已落地（CONTRACTS §2），本测试验证：
 *   种子提交 → `upsertReport`（单事务 5 步写）→ 用 db.js 读回 reports / line_stats /
 *   repo_branch_stats / topics → 与领域计算结果一致；覆盖写幂等。
 *
 * 只依赖临时目录，不写用户数据目录；每个用例结束关闭并删除临时库。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import * as db from '../../lib/db.js'
import { upsertReport } from '../../lib/domain/persist.js'

/** 打开一个临时报告库。 */
function openTempDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-domain-'))
  const file = path.join(dir, 'report.db')
  const database = db.openDatabase(file)
  return {
    database,
    dir,
    file,
    cleanup() {
      try {
        db.closeDatabase(database)
      } catch {
        /* 关闭失败不掩盖断言失败 */
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 种子：crm-order 仓库下 3 条提交（普通 / merge / cherry-pick）。 */
function seedCommits(database) {
  db.upsertRepositories(database, [
    { connectionId: 'conn-1', projectId: 1, pathWithNamespace: 'group/crm-order', name: 'crm-order' },
  ])
  db.upsertCommits(database, [
    {
      connectionId: 'conn-1',
      projectId: 1,
      commitId: 'c1',
      title: 'feat: add order export',
      message: 'feat: add order export\n\nbody',
      authoredDate: '2026-08-03T10:00:00+08:00',
      committedDate: '2026-08-03T10:00:00+08:00',
      authorName: 'dev',
      authorEmail: 'dev@example.com',
      isMergeCommit: 0,
      isCherryPickCommit: 0,
    },
    {
      connectionId: 'conn-1',
      projectId: 1,
      commitId: 'c2',
      title: 'feat: land helper',
      message: 'feat: land helper',
      authoredDate: '2026-08-04T10:00:00+08:00',
      committedDate: '2026-08-04T10:00:00+08:00',
      isMergeCommit: 1,
    },
    {
      connectionId: 'conn-1',
      projectId: 1,
      commitId: 'c3',
      title: 'fix: cherry picked',
      message: 'fix: cherry picked',
      authoredDate: '2026-08-05T10:00:00+08:00',
      committedDate: '2026-08-05T10:00:00+08:00',
      isCherryPickCommit: 1,
    },
  ])
  db.replaceCommitStats(database, [
    { connectionId: 'conn-1', projectId: 1, commitId: 'c1', additions: 100, deletions: 20, total: 120 },
    { connectionId: 'conn-1', projectId: 1, commitId: 'c2', additions: 40, deletions: 10, total: 50 },
    { connectionId: 'conn-1', projectId: 1, commitId: 'c3', additions: 7, deletions: 3, total: 10 },
  ])
  db.replaceCommitRefs(database, [
    { connectionId: 'conn-1', projectId: 1, commitId: 'c1', branches: ['main', 'dev'] },
    { connectionId: 'conn-1', projectId: 1, commitId: 'c2', branches: ['main'] },
    { connectionId: 'conn-1', projectId: 1, commitId: 'c3', branches: ['dev'] },
  ])
}

test('upsertReport：真实 SQLite 写入 → 读回与领域计算一致', () => {
  const context = openTempDatabase()
  try {
    seedCommits(context.database)
    const result = upsertReport(context.database, {
      type: 'week',
      startDate: '2026-08-03',
      endDate: '2026-08-09',
      content: '  # 周报正文\n\n内容  ',
    })
    assert.equal(result.reportId, 'week:2026-08-03:2026-08-09')
    assert.equal(result.aggregates.totalCommits, 3)
    assert.equal(result.aggregates.mergeCommitCount, 1)
    assert.equal(result.aggregates.cherryPickCommitCount, 1)
    assert.equal(result.aggregates.totalAdditions, 100)

    const row = db.getReportRow(context.database, result.reportId)
    assert.equal(row.reportType, 'week')
    assert.equal(row.periodStart, '2026-08-03')
    assert.equal(row.periodEnd, '2026-08-09')
    assert.equal(row.status, 'generated')
    assert.equal(row.content, '# 周报正文\n\n内容')
    // 聚合统计随行/独立函数落库（db.js 两种实现都应可读回）
    assert.deepEqual(row.aggregates, result.aggregates)

    const lineStats = db.listLineStats(context.database, result.reportId)
    assert.equal(lineStats.length, 2)
    assert.equal(lineStats[0].include_merge, 1)
    assert.equal(lineStats[0].additions, 147)
    assert.equal(lineStats[1].include_merge, 0)
    assert.equal(lineStats[1].additions, 100)
    assert.equal(lineStats[1].pure_additions, 80)

    const repoBranchStats = db.listRepoBranchStats(context.database, result.reportId)
    // include_merge=true 组：main(c1,c2) + dev(c1,c3)；false 组：main(c1) + dev(c1)
    assert.equal(repoBranchStats.some((item) => item.include_merge === 1), true)
    assert.equal(repoBranchStats.some((item) => item.include_merge === 0), true)

    const topics = db.listTopics(context.database, result.reportId)
    assert.equal(topics.length, 3) // 三个不同 topicTitle
    assert.deepEqual(
      topics.map((topic) => topic.sort_order),
      [1, 2, 3],
    )
    assert.equal(topics[0].domain, 'CRM-订单')

    // 列表可见
    const rows = db.listReportRows(context.database)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].reportId, result.reportId)
  } finally {
    context.cleanup()
  }
})

test('upsertReport：同周期覆盖（不产生重复行 / 不重复子表行）', () => {
  const context = openTempDatabase()
  try {
    seedCommits(context.database)
    const first = upsertReport(context.database, {
      type: 'week',
      startDate: '2026-08-03',
      endDate: '2026-08-09',
      content: 'v1',
    })
    const second = upsertReport(context.database, {
      type: 'week',
      startDate: '2026-08-03',
      endDate: '2026-08-09',
      content: 'v2',
    })
    assert.equal(first.reportId, second.reportId)
    const rows = db.listReportRows(context.database)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].content, 'v2')
    assert.equal(db.listLineStats(context.database, second.reportId).length, 2)
  } finally {
    context.cleanup()
  }
})

test('upsertReport：空正文 → status=empty 且 content=null', () => {
  const context = openTempDatabase()
  try {
    seedCommits(context.database)
    const result = upsertReport(context.database, {
      type: 'week',
      startDate: '2026-08-03',
      endDate: '2026-08-09',
      content: '   ',
    })
    const row = db.getReportRow(context.database, result.reportId)
    assert.equal(row.status, 'empty')
    assert.equal(row.content, null)
  } finally {
    context.cleanup()
  }
})

test('upsertReport：周期内无提交 → 空投影但不报错', () => {
  const context = openTempDatabase()
  try {
    seedCommits(context.database)
    const result = upsertReport(context.database, {
      type: 'month',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      content: '# 空月报',
    })
    assert.equal(result.aggregates.totalCommits, 0)
    assert.deepEqual(db.listLineStats(context.database, result.reportId), [
      {
        report_id: result.reportId,
        include_merge: 1,
        additions: 0,
        deletions: 0,
        total: 0,
        pure_additions: 0,
        includeMerge: 1,
        pureAdditions: 0,
      },
      {
        report_id: result.reportId,
        include_merge: 0,
        additions: 0,
        deletions: 0,
        total: 0,
        pure_additions: 0,
        includeMerge: 0,
        pureAdditions: 0,
      },
    ])
    assert.deepEqual(db.listTopics(context.database, result.reportId), [])
  } finally {
    context.cleanup()
  }
})
