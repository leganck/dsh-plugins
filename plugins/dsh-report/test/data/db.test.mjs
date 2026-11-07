/**
 * lib/db.js 单测：建表/幂等/替换/区间查询/prune/报告/任务。
 * 用临时目录建真实 SQLite（node:sqlite），不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  SCHEMA_VERSION,
  appendSyncJobError,
  commitKey,
  createSyncJob,
  deleteReportRow,
  getActiveSyncJob,
  getMeta,
  getReportRow,
  getSyncJob,
  listCommitsInPeriod,
  listCoverageRows,
  listLineStats,
  listReportRows,
  listRepoBranchStats,
  listSyncJobs,
  listTopics,
  openDatabase,
  closeDatabase,
  pruneCommits,
  replaceCommitRefs,
  replaceCommitStats,
  replaceLineStats,
  replaceRepoBranchStats,
  replaceTopics,
  saveSelectedProjects,
  selectedProjects,
  upsertCommits,
  upsertConnection,
  upsertRepositories,
  upsertReportRow,
  upsertReportAggregates,
  updateSyncJob,
  withTransaction,
} from '../../lib/db.js'

/** 建一个临时库（每个用例独立，结束删除目录）。 */
function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-db-'))
  const db = openDatabase(path.join(dir, 'report.db'))
  t.after(() => {
    closeDatabase(db)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir }
}

/** 提交种子。 */
function seedCommit(overrides = {}) {
  return {
    connectionId: 'conn-1',
    projectId: 11,
    commitId: 'sha-1',
    message: 'feat: a',
    title: 'feat: a',
    authoredDate: '2026-10-20T10:00:00+08:00',
    committedDate: '2026-10-20T10:00:00+08:00',
    authorName: 'Dev',
    authorEmail: 'dev@example.com',
    ...overrides,
  }
}

test('openDatabase 建全部表并写 schema 版本', (t) => {
  const { db } = tempDb(t)
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name)
  for (const expected of [
    'meta',
    'connections',
    'repositories',
    'commits',
    'commit_stats',
    'commit_branch_refs',
    'selected_projects',
    'sync_jobs',
    'sync_job_errors',
    'reports',
    'report_aggregates',
    'report_line_stats',
    'report_repo_branch_stats',
    'report_topics',
  ]) {
    assert.ok(tables.includes(expected), `缺少表 ${expected}（实际：${tables.join(',')}）`)
  }
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
  assert.equal(getMeta(db, 'schema_version'), String(SCHEMA_VERSION))
  // WAL 生效（内存库或某些文件系统可能回退，这里只断言不为空）
  const mode = db.prepare('PRAGMA journal_mode').get().journal_mode
  assert.ok(['wal', 'memory'].includes(String(mode).toLowerCase()))
})

test('upsertCommits 幂等：同键覆盖、不同键并存', (t) => {
  const { db } = tempDb(t)
  upsertCommits(db, [seedCommit()])
  upsertCommits(db, [seedCommit({ title: 'feat: a (rebased)', message: 'feat: a\n\nchange' })])
  upsertCommits(db, [seedCommit({ commitId: 'sha-2', title: 'fix: b' })])

  const rows = db.prepare('SELECT commit_id, title, message FROM commits ORDER BY commit_id').all()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].commit_id, 'sha-1')
  assert.equal(rows[0].title, 'feat: a (rebased)', '同键重复导入应覆盖为新值')
  assert.equal(rows[0].message, 'feat: a\n\nchange')
  assert.equal(rows[1].commit_id, 'sha-2')
})

test('replaceCommitStats / replaceCommitRefs 为替换式写入', (t) => {
  const { db } = tempDb(t)
  upsertCommits(db, [seedCommit()])
  replaceCommitStats(db, [{ connectionId: 'conn-1', projectId: 11, commitId: 'sha-1', additions: 10, deletions: 2, total: 12 }])
  replaceCommitStats(db, [{ connectionId: 'conn-1', projectId: 11, commitId: 'sha-1', additions: 7, deletions: 1, total: 8 }])
  let stats = db.prepare('SELECT * FROM commit_stats').all()
  assert.equal(stats.length, 1, '同键替换不应产生第二行')
  assert.equal(stats[0].additions, 7)
  assert.equal(stats[0].total, 8)

  replaceCommitRefs(db, [
    { connectionId: 'conn-1', projectId: 11, commitId: 'sha-1', branches: [{ name: 'main' }, { name: 'release/1.0' }] },
  ])
  let refs = db
    .prepare('SELECT branch_name, branch_order FROM commit_branch_refs ORDER BY branch_order')
    .all()
  assert.deepEqual(
    refs.map((row) => [row.branch_name, row.branch_order]),
    [
      ['main', 0],
      ['release/1.0', 1],
    ],
    'branch_order 应取数组下标',
  )

  // 再写更少的 refs：旧行必须消失
  replaceCommitRefs(db, [{ connectionId: 'conn-1', projectId: 11, commitId: 'sha-1', branches: ['develop'] }])
  refs = db.prepare('SELECT branch_name, branch_order FROM commit_branch_refs').all()
  assert.deepEqual(refs.map((row) => [row.branch_name, row.branch_order]), [['develop', 0]])
})

test('listCommitsInPeriod：区间过滤 / JOIN / 双键 / 顺序', (t) => {
  const { db } = tempDb(t)
  upsertCommits(db, [
    seedCommit({ commitId: 'in-start', authoredDate: '2026-10-19T00:00:00+08:00' }),
    seedCommit({ commitId: 'in-mid', authoredDate: '2026-10-21T23:59:59+08:00' }),
    seedCommit({ commitId: 'in-end', authoredDate: '2026-10-25T23:59:59+08:00' }),
    seedCommit({ commitId: 'out-before', authoredDate: '2026-10-18T23:59:59+08:00' }),
    seedCommit({ commitId: 'out-after', authoredDate: '2026-10-26T00:00:00+08:00' }),
  ])
  replaceCommitStats(db, [{ connectionId: 'conn-1', projectId: 11, commitId: 'in-mid', additions: 5, deletions: 1, total: 6 }])
  replaceCommitRefs(db, [
    { connectionId: 'conn-1', projectId: 11, commitId: 'in-mid', branches: ['release/1.0', 'main'] },
  ])
  upsertRepositories(db, [{ connectionId: 'conn-1', projectId: 11, pathWithNamespace: 'group/proj', name: 'proj' }])

  const rows = listCommitsInPeriod(db, { startDate: '2026-10-19', endDate: '2026-10-25' })
  assert.deepEqual(
    rows.map((row) => row.commitId),
    ['in-end', 'in-mid', 'in-start'],
    '区间应含首尾两天，且按 authored_date DESC',
  )
  const mid = rows.find((row) => row.commitId === 'in-mid')
  assert.equal(mid.additions, 5)
  assert.equal(mid.total, 6)
  assert.equal(mid.repoName, 'proj')
  assert.equal(mid.pathWithNamespace, 'group/proj')
  assert.equal(mid.primaryBranch, 'release/1.0', 'primary branch = branch_order 最小者')
  assert.equal(mid.branchNamesJson, '["release/1.0","main"]')
  // 双键兼容
  assert.equal(mid.connection_id, 'conn-1')
  assert.equal(mid.path_with_namespace, 'group/proj')
  assert.equal(mid.authored_date, '2026-10-21T23:59:59+08:00')

  const scoped = listCommitsInPeriod(db, { connectionIds: ['other'], startDate: '2026-10-19', endDate: '2026-10-25' })
  assert.equal(scoped.length, 0)
})

test('listCommitsInPeriod 缺 stats/repo 时用默认值（LEFT JOIN）', (t) => {
  const { db } = tempDb(t)
  upsertCommits(db, [seedCommit({ commitId: 'bare' })])
  const [row] = listCommitsInPeriod(db, { startDate: '2026-10-19', endDate: '2026-10-25' })
  assert.equal(row.additions, 0)
  assert.equal(row.total, 0)
  assert.equal(row.repoName, '')
  assert.equal(row.primaryBranch, '')
  assert.equal(row.branchNamesJson, '[]')
})

test('saveSelectedProjects 全量替换且按连接隔离', (t) => {
  const { db } = tempDb(t)
  saveSelectedProjects(db, 'conn-1', [
    { projectId: 1, pathWithNamespace: 'a/one', name: 'one' },
    { projectId: 2, pathWithNamespace: 'a/two', name: 'two' },
  ])
  saveSelectedProjects(db, 'conn-2', [{ projectId: 9, pathWithNamespace: 'b/nine', name: 'nine' }])
  saveSelectedProjects(db, 'conn-1', [{ projectId: 3, pathWithNamespace: 'a/three', name: 'three' }])

  const conn1 = selectedProjects(db, 'conn-1')
  assert.deepEqual(conn1.map((row) => row.projectId), [3], 'conn-1 应被全量替换')
  const conn2 = selectedProjects(db, 'conn-2')
  assert.deepEqual(conn2.map((row) => row.projectId), [9], '其它连接不受影响')
  assert.equal(conn1[0].pathWithNamespace, 'a/three')
  assert.equal(conn1[0].path_with_namespace, 'a/three')
  assert.equal(selectedProjects(db).length, 2)
})

test('pruneCommits：只删窗口内 keep 之外的提交（含子表级联）', (t) => {
  const { db } = tempDb(t)
  upsertCommits(db, [
    seedCommit({ commitId: 'keep-1' }),
    seedCommit({ commitId: 'stale-1' }),
    seedCommit({ commitId: 'stale-old', authoredDate: '2026-01-01T10:00:00+08:00' }),
  ])
  replaceCommitStats(db, [
    { connectionId: 'conn-1', projectId: 11, commitId: 'stale-1', additions: 1, deletions: 0, total: 1 },
  ])
  replaceCommitRefs(db, [{ connectionId: 'conn-1', projectId: 11, commitId: 'stale-1', branches: ['main'] }])

  const keep = new Set([commitKey('conn-1', 11, 'keep-1')])
  const result = pruneCommits(db, {
    connectionIds: ['conn-1'],
    keepWindow: { startDate: '2026-10-19', endDate: '2026-10-25' },
    projects: [{ connectionId: 'conn-1', projectId: 11 }],
    keep,
  })
  assert.equal(result.deleted, 1)
  const remaining = db.prepare('SELECT commit_id FROM commits ORDER BY commit_id').all().map((row) => row.commit_id)
  assert.deepEqual(remaining, ['keep-1', 'stale-old'], '窗口外的旧提交不应被清理')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commit_stats').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commit_branch_refs').get().n, 0)

  // 安全默认：不传 keep → 不删任何行
  const noKeep = pruneCommits(db, { keepWindow: { startDate: '2026-10-19', endDate: '2026-10-25' } })
  assert.equal(noKeep.deleted, 0)
})

test('reports：upsert / 聚合 / 子表替换 / 删除', (t) => {
  const { db } = tempDb(t)
  const reportId = 'week:2026-10-19:2026-10-25'
  upsertReportRow(db, {
    reportId,
    reportType: 'week',
    periodStart: '2026-10-19',
    periodEnd: '2026-10-25',
    status: 'generated',
    content: '# 周报',
    generatedAt: '2026-10-26T10:00:00.000Z',
    statsJson: { totalCommits: 12, totalAdditions: 100 },
  })
  replaceLineStats(db, reportId, [
    { includeMerge: true, commits: 12, additions: 120, deletions: 20, total: 140, pureAdditions: 100 },
    { includeMerge: false, commits: 8, additions: 90, deletions: 10, total: 100, pureAdditions: 80 },
  ])
  replaceRepoBranchStats(db, reportId, [
    { includeMerge: true, repoKey: 'group/proj', branchName: 'main', commitCount: 8, additions: 80, deletions: 10, total: 90 },
  ])
  replaceTopics(db, reportId, [{ domain: 'CRM-订单', topicTitle: '订单优化', summary: '3 次提交' }])

  const row = getReportRow(db, reportId)
  assert.equal(row.status, 'generated')
  assert.equal(row.content, '# 周报')
  assert.deepEqual(row.aggregates, { totalCommits: 12, totalAdditions: 100 })
  assert.equal(listLineStats(db, reportId).length, 2)
  assert.equal(listLineStats(db, reportId)[0].include_merge, 1, '按 include_merge DESC')
  assert.equal(listLineStats(db, reportId)[0].pure_additions, 100)
  assert.equal(listRepoBranchStats(db, reportId)[0].repo_key, 'group/proj')
  assert.equal(listTopics(db, reportId)[0].topic_title, '订单优化')
  assert.equal(listReportRows(db).length, 1)

  // 重存 = 覆盖，子表替换不残留
  replaceTopics(db, reportId, [{ domain: 'ERP-POS', topicTitle: 'POS 优化', summary: '2 次提交' }])
  assert.equal(listTopics(db, reportId).length, 1)
  upsertReportRow(db, { reportId, status: 'empty', content: null })
  assert.equal(getReportRow(db, reportId).content, null)
  assert.equal(getReportRow(db, reportId).aggregates.totalCommits, 12, '未传 aggregates 时保留旧值')

  assert.equal(deleteReportRow(db, reportId), true)
  assert.equal(getReportRow(db, reportId), null)
  assert.equal(listLineStats(db, reportId).length, 0)
  assert.equal(listTopics(db, reportId).length, 0)
  assert.equal(deleteReportRow(db, reportId), false, '重复删除返回 false')
})

test('upsertReportAggregates：独立写聚合（domain persistCore 优先调用路径）', (t) => {
  const { db } = tempDb(t)
  const reportId = 'month:2026-10-01:2026-10-31'
  upsertReportRow(db, { reportId, reportType: 'month', status: 'generated', content: 'x' })
  upsertReportAggregates(db, reportId, { totalCommits: 5, repoDistribution: [{ repo: 'g/a', count: 5 }] })
  const row = getReportRow(db, reportId)
  assert.equal(row.aggregates.totalCommits, 5)
  assert.equal(row.aggregates.repoDistribution[0].repo, 'g/a')
  // 覆盖写
  upsertReportAggregates(db, reportId, { totalCommits: 7 })
  assert.equal(getReportRow(db, reportId).aggregates.totalCommits, 7)
  // upsertReportRow 也接受 aggregatesJson（无独立写入函数时的兼容路径）
  const secondId = 'month:2026-11-01:2026-11-30'
  upsertReportRow(db, { reportId: secondId, status: 'empty', aggregatesJson: JSON.stringify({ totalCommits: 9 }) })
  assert.equal(getReportRow(db, secondId).aggregates.totalCommits, 9)
  assert.equal(getReportRow(db, secondId).content, null)
})

test('sync_jobs：创建/更新/查询/错误/活动任务', (t) => {
  const { db } = tempDb(t)
  createSyncJob(db, {
    jobId: 'job-1',
    connectionId: 'conn-1',
    progress: { totalProjects: 2, syncedProjects: 0 },
    scope: { projects: [{ projectId: 1 }], startDate: '2026-10-19', endDate: '2026-10-25' },
  })
  const created = getSyncJob(db, 'job-1')
  assert.equal(created.status, 'pending')
  assert.equal(created.progress.totalProjects, 2)
  assert.equal(created.scope.startDate, '2026-10-19')
  assert.equal(getActiveSyncJob(db).jobId, 'job-1')

  updateSyncJob(db, 'job-1', { status: 'running', progress: { totalProjects: 2, syncedProjects: 1 } })
  appendSyncJobError(db, { jobId: 'job-1', projectId: 1, commitId: 'sha-9', stage: 'commit_sync', message: 'boom' })
  const running = getSyncJob(db, 'job-1')
  assert.equal(running.status, 'running')
  assert.equal(running.errors.length, 1)
  assert.equal(running.errors[0].stage, 'commit_sync')
  assert.equal(running.errors[0].commitId, 'sha-9')

  updateSyncJob(db, 'job-1', { status: 'succeeded', finishedAt: '2026-10-26T00:00:00.000Z', progress: { totalProjects: 2, syncedProjects: 2 } })
  assert.equal(getActiveSyncJob(db), null)
  const done = getSyncJob(db, 'job-1')
  assert.equal(done.status, 'succeeded')
  assert.equal(done.finishedAt, '2026-10-26T00:00:00.000Z')
  assert.equal(listSyncJobs(db, 10).length, 1)
  assert.equal(getSyncJob(db, 'nope'), null)

  createSyncJob(db, { jobId: 'job-2', connectionId: 'conn-1' })
  const jobs = listSyncJobs(db, 10)
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].jobId, 'job-2', '按 started_at DESC 时新任务在前（或同秒则 job_id 排序）')
})

test('withTransaction：异常回滚，嵌套复用外层', (t) => {
  const { db } = tempDb(t)
  assert.throws(() =>
    withTransaction(db, () => {
      upsertCommits(db, [seedCommit({ commitId: 'rolled-back' })])
      throw new Error('boom')
    }),
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commits').get().n, 0, '回滚后不应留下数据')

  withTransaction(db, () => {
    upsertCommits(db, [seedCommit({ commitId: 'outer' })])
    withTransaction(db, () => {
      upsertCommits(db, [seedCommit({ commitId: 'inner' })])
    })
  })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commits').get().n, 2, '嵌套应复用外层事务并一次提交')
})

test('listCoverageRows：只取覆盖度需要的列，支持区间与连接过滤', (t) => {
  const { db } = tempDb(t)
  upsertCommits(db, [
    seedCommit({ commitId: 'a', authoredDate: '2026-10-20T09:00:00+08:00' }),
    seedCommit({ commitId: 'b', authoredDate: '2026-10-26T09:00:00+08:00' }),
  ])
  upsertRepositories(db, [{ connectionId: 'conn-1', projectId: 11, pathWithNamespace: 'group/proj', name: 'proj' }])
  const all = listCoverageRows(db, { connectionIds: 'conn-1' })
  assert.equal(all.length, 2)
  assert.equal(all[0].pathWithNamespace, 'group/proj')
  assert.equal(all[0].connectionId, 'conn-1')
  const ranged = listCoverageRows(db, { connectionIds: ['conn-1'], startDate: '2026-10-19', endDate: '2026-10-25' })
  assert.deepEqual(ranged.map((row) => row.commitId ?? row.authoredDate), ['2026-10-20T09:00:00+08:00'])
})

test('upsertConnection 覆盖显示名/用户名，可读回', (t) => {
  const { db } = tempDb(t)
  upsertConnection(db, { connectionId: 'conn-1', baseUrl: 'https://gitlab.example.com', displayName: 'Dev', username: 'dev' })
  upsertConnection(db, { connectionId: 'conn-1', baseUrl: 'https://gitlab.example.com', displayName: 'Dev Renamed', username: 'dev' })
  const row = db.prepare('SELECT COUNT(*) AS n FROM connections').get()
  assert.equal(row.n, 1)
  const stored = db.prepare('SELECT display_name FROM connections').get()
  assert.equal(stored.display_name, 'Dev Renamed')
})
