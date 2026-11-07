/**
 * stats.test.mjs —— 统计/实时分析口径断言（这是 parity 的核心）。
 *
 * 覆盖任务要求的 ③（authored_date 长度/时区混排/同刻不同日）与 ⑥（3 种行数口径数字断言），
 * 以及 ①（同一条提交同时 merge+cherry → nonMergeCommitCount 为负，照 Go 行为不 clamp）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BRANCH_ASSIGNMENT_RULE,
  BRANCH_MODE,
  aggregate,
  buildLineStats,
  buildRealtimeAnalytics,
  buildRepoBranchStats,
  buildRepoCards,
  slimRealtimeAnalytics,
} from '../../lib/domain/stats.js'
import { makeCommit, mixedCommits } from './fixtures.mjs'

test('aggregate：三种口径的数字（行数排除 merge/cherry，计数各自独立）', () => {
  const stats = aggregate(mixedCommits())
  assert.equal(stats.totalCommits, 6)
  assert.equal(stats.mergeCommitCount, 3) // c2 flag / c3 标题 / c6 两者
  assert.equal(stats.cherryPickCommitCount, 3) // c4 flag / c5 source / c6 两者
  assert.equal(stats.nonMergeCommitCount, 0) // 6 - 3 - 3
  // 行数只累计非 merge 且非 cherry-pick → 仅 c1
  assert.equal(stats.totalAdditions, 100)
  assert.equal(stats.totalDeletions, 20)
  assert.equal(stats.totalLines, 120)
  assert.equal(stats.repoCount, 1)
  assert.deepEqual(stats.branchDistribution, [{ name: 'main', count: 6 }])
  assert.deepEqual(stats.repoDistribution, [{ repo: 'group/erp-eai', count: 6 }])
  assert.deepEqual(stats.domainDistribution, [{ name: '其他业务', count: 6 }])
  assert.deepEqual(stats.dateDistribution, [
    { date: '2026-08-03', count: 2 },
    { date: '2026-08-04', count: 2 },
    { date: '2026-08-05', count: 2 },
  ])
})

test('aggregate：同一条提交同时 merge+cherry → nonMergeCommitCount 为负（不得 clamp）', () => {
  const commits = [
    makeCommit({ commitId: 'both', isMergeCommit: 1, isCherryPickCommit: 1 }),
    makeCommit({ commitId: 'merge', isMergeCommit: 1 }),
  ]
  const stats = aggregate(commits)
  assert.equal(stats.totalCommits, 2)
  assert.equal(stats.mergeCommitCount, 2)
  assert.equal(stats.cherryPickCommitCount, 1)
  assert.equal(stats.nonMergeCommitCount, -1) // Go 代码无防御，负值必须保留
  assert.equal(stats.totalAdditions, 0) // 两条都被排除
})

test('aggregate：authored_date 取原串前 10 位，不做时区归一', () => {
  const commits = [
    // 同一时刻，两种时区写法 → 原串日期不同（07 分册 §3.7 关键证据）
    makeCommit({ commitId: 'a', authoredDate: '2026-08-03T00:30:00+08:00' }),
    makeCommit({ commitId: 'b', authoredDate: '2026-08-02T16:30:00Z' }),
    // 9 位日期：不进日期分布，但仍计入 totalCommits / 其它分布
    makeCommit({ commitId: 'c', authoredDate: '2026-08-0' }),
    makeCommit({ commitId: 'd', authoredDate: '' }),
  ]
  const stats = aggregate(commits)
  assert.equal(stats.totalCommits, 4)
  assert.deepEqual(stats.dateDistribution, [
    { date: '2026-08-02', count: 1 },
    { date: '2026-08-03', count: 1 },
  ])
  assert.deepEqual(stats.branchDistribution, [{ name: 'main', count: 4 }])
})

test('buildLineStats：恒 2 行，顺序 [includeMerge=true, false]', () => {
  const rows = buildLineStats(mixedCommits())
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    includeMerge: true,
    commits: 6,
    additions: 687,
    deletions: 468,
    total: 1155,
    pureAdditions: 219,
  })
  assert.deepEqual(rows[1], {
    includeMerge: false,
    commits: 1,
    additions: 100,
    deletions: 20,
    total: 120,
    pureAdditions: 80,
  })
  // 与 aggregate 的非 merge 行数口径一致（Go aggregate_test.go:23-37 的断言）
  const stats = aggregate(mixedCommits())
  assert.equal(stats.totalAdditions, rows[1].additions)
  assert.equal(stats.totalDeletions, rows[1].deletions)
  assert.equal(stats.totalLines, rows[1].total)
})

test('buildRepoBranchStats：双口径分组 + 排序（total↓ → commitCount↓）', () => {
  const rows = buildRepoBranchStats(mixedCommits())
  assert.deepEqual(rows, [
    {
      includeMerge: true,
      repoKey: 'group/erp-eai',
      branchName: 'main',
      commitCount: 6,
      additions: 687,
      deletions: 468,
      total: 1155,
    },
    {
      includeMerge: false,
      repoKey: 'group/erp-eai',
      branchName: 'main',
      commitCount: 1,
      additions: 100,
      deletions: 20,
      total: 120,
    },
  ])
})

test('buildRepoBranchStats：false 组仅在该组合存在非 merge/cherry 提交时创建', () => {
  const commits = [
    makeCommit({ commitId: 'm1', repoName: 'only-merge', pathWithNamespace: 'g/only-merge', isMergeCommit: 1 }),
    makeCommit({ commitId: 'm2', repoName: 'only-merge', pathWithNamespace: 'g/only-merge', title: "Merge branch 'x'" }),
  ]
  const rows = buildRepoBranchStats(commits)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].includeMerge, true)
  assert.equal(rows[0].commitCount, 2)
  assert.equal(rows[0].additions, 20) // 全部提交口径包含 merge 行数
})

test('buildRepoCards：items 与 excludeMerge 同引用；卡片/分支排序与按日贡献', () => {
  const cards = buildRepoCards(mixedCommits())
  assert.equal(cards.items, cards.excludeMerge) // 必须是同一个数组引用（Go 同一 slice）
  assert.equal(cards.includeMerge.length, 1)
  assert.equal(cards.excludeMerge.length, 1)

  const all = cards.includeMerge[0]
  assert.deepEqual(all, {
    includeMerge: true,
    repoKey: 'group/erp-eai',
    commitCount: 6,
    additions: 687,
    deletions: 468,
    total: 1155,
    pureAdditions: 219,
    branchCount: 1,
    branches: [
      { branchName: 'main', commitCount: 6, additions: 687, deletions: 468, total: 1155, pureAdditions: 219 },
    ],
    contributionDays: [
      { date: '2026-08-03', count: 2 },
      { date: '2026-08-04', count: 2 },
      { date: '2026-08-05', count: 2 },
    ],
  })
  const excluded = cards.excludeMerge[0]
  assert.equal(excluded.includeMerge, false)
  assert.equal(excluded.commitCount, 1)
  assert.equal(excluded.pureAdditions, 80)
  assert.deepEqual(excluded.contributionDays, [{ date: '2026-08-03', count: 1 }])
})

test('buildRepoCards：多仓库时按 total 降序；only-merge 仓库不出现在 excludeMerge', () => {
  const commits = [
    makeCommit({ commitId: 'a', repoName: 'big', pathWithNamespace: 'g/big', additions: 100, deletions: 0, total: 100 }),
    makeCommit({ commitId: 'b', repoName: 'small', pathWithNamespace: 'g/small', additions: 5, deletions: 1, total: 6 }),
    makeCommit({ commitId: 'c', repoName: 'merge-only', pathWithNamespace: 'g/merge-only', isMergeCommit: 1 }),
  ]
  const cards = buildRepoCards(commits)
  // total 降序：big=100、merge-only=12（默认 10+2）、small=6
  assert.deepEqual(
    cards.includeMerge.map((card) => card.repoKey),
    ['g/big', 'g/merge-only', 'g/small'],
  )
  assert.deepEqual(
    cards.excludeMerge.map((card) => card.repoKey),
    ['g/big', 'g/small'],
  )
})

test('buildRealtimeAnalytics：全量字段与协议常量（不传 opts）', () => {
  const result = buildRealtimeAnalytics('2026-08-03', '2026-08-09', mixedCommits())
  assert.deepEqual(result.range, { startDate: '2026-08-03', endDate: '2026-08-09' })
  assert.equal(result.branchMode, BRANCH_MODE)
  assert.equal(result.branchMode, 'current_refs_first_auxiliary')
  assert.equal(result.branchAssignmentRule, BRANCH_ASSIGNMENT_RULE)
  assert.equal(
    result.branchAssignmentRule,
    'repository stats are grouped by repo; current refs first branch is auxiliary only',
  )
  assert.deepEqual(result.summary, {
    totalCommits: 6,
    repoCount: 1,
    branchCount: 1, // 仅 c1 这条非 merge/cherry 参与 (repo,branch) 去重
    mergeCommits: 3,
    cherryPickCommits: 3,
    additions: 100,
    deletions: 20,
    total: 120,
    net: 80,
    pureAdditions: 80,
  })
  assert.equal(result.lineStats.length, 2)
  assert.deepEqual(result.repoBranchStats, []) // Go 恒空，历史字段
  assert.equal(result.dateDistribution.length, 3)
  assert.equal(result.repoDistribution.length, 1)
  assert.deepEqual(result.scriptLike, {
    total_commits: 6,
    merge_commits: 3,
    cherry_pick_commits: 3,
    totals_including_merges: { additions: 687, deletions: 468, total: 1155 },
    totals_excluding_merges: { additions: 100, deletions: 20, total: 120 },
  })
})

test('buildRealtimeAnalytics：branchCount 用 repo+branch 去重（跨仓库同分支名算 2）', () => {
  const commits = [
    makeCommit({ commitId: 'a', pathWithNamespace: 'g/one', primaryBranch: 'main', branchNames: ['main'] }),
    makeCommit({ commitId: 'b', pathWithNamespace: 'g/two', primaryBranch: 'main', branchNames: ['main'] }),
  ]
  const result = buildRealtimeAnalytics('2026-08-03', '2026-08-09', commits)
  assert.equal(result.summary.branchCount, 2)
})

test('slimRealtimeAnalytics：默认裁剪掉 scriptLike，只保留单键 repoCards', () => {
  const full = buildRealtimeAnalytics('2026-08-03', '2026-08-09', mixedCommits())
  const slim = slimRealtimeAnalytics(full, {})
  assert.equal(slim.scriptLike, null)
  assert.notEqual(slim.lineStats, null)
  assert.notEqual(slim.dateDistribution, null)
  assert.deepEqual(Object.keys(slim.repoCards), ['excludeMerge'])
  // 入参不被就地修改（Go 是就地改，本实现返回新对象 —— 已记录偏差）
  assert.notEqual(full.scriptLike, null)
  assert.deepEqual(Object.keys(full.repoCards), ['includeMerge', 'excludeMerge', 'items'])
})

test('slimRealtimeAnalytics：fields 白名单 / limit 截断 / include 选择口径 / bucket 被忽略', () => {
  const full = buildRealtimeAnalytics('2026-08-03', '2026-08-09', mixedCommits())
  const slim = slimRealtimeAnalytics(full, {
    include: 'includeMerge',
    fields: 'repoCards,lineStats',
    limit: 1,
    bucket: 'week', // 接受但不生效
  })
  assert.equal(slim.scriptLike, null)
  assert.equal(slim.dateDistribution, null)
  assert.equal(slim.repoDistribution, null)
  assert.equal(slim.lineStats.length, 2)
  assert.deepEqual(Object.keys(slim.repoCards), ['includeMerge'])
  assert.equal(slim.repoCards.includeMerge.length, 1)
  // 只请求 lineStats 时 repoCards 直接为 null（Go 的提前 return 分支）
  const onlyLines = slimRealtimeAnalytics(full, { fields: ['lineStats'] })
  assert.equal(onlyLines.repoCards, null)
  assert.equal(onlyLines.lineStats.length, 2)
})

test('buildRealtimeAnalytics：opts 有键即裁剪；slim:false 强制全量', () => {
  const slimmed = buildRealtimeAnalytics('2026-08-03', '2026-08-09', mixedCommits(), { fields: 'lineStats' })
  assert.equal(slimmed.repoCards, null)
  const forcedFull = buildRealtimeAnalytics('2026-08-03', '2026-08-09', mixedCommits(), {
    fields: 'lineStats',
    slim: false,
  })
  assert.notEqual(forcedFull.repoCards, null)
  assert.notEqual(forcedFull.scriptLike, null)
})
