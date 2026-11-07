/**
 * gather.test.mjs —— 瘦投影与分页边界（Go `internal/report/gather.go`）。
 *
 * 覆盖任务要求的 ④：limit 0/-1/80/500、offset 越界、repo 子串、>80 多页；
 * 同时锁定 hint 文案与 `omitempty` 键消失规则（07 分册 §3.10）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GATHER_HINT_COMPLETE,
  GATHER_HINT_MORE,
  MAX_GATHER_COMMIT_LIMIT,
  gatherCommits,
} from '../../lib/domain/gather.js'
import { makeCommit, manyCommits } from './fixtures.mjs'

test('gatherCommits：默认 limit=40，hasMore/nextOffset/truncated/hint 联动', () => {
  const page = gatherCommits(manyCommits(100), '2026-08-03', '2026-08-09', {})
  assert.equal(page.startDate, '2026-08-03')
  assert.equal(page.endDate, '2026-08-09')
  assert.equal(page.limit, 40)
  assert.equal(page.offset, 0)
  assert.equal(page.total, 100)
  assert.equal(page.count, 40)
  assert.equal(page.hasMore, true)
  assert.equal(page.nextOffset, 40)
  assert.equal(page.truncated, true)
  assert.equal(page.hint, GATHER_HINT_MORE)
  assert.equal('repo' in page, false) // omitempty：无 repo 过滤时整键消失
})

test('gatherCommits：limit 0/-1 回落 40，limit 500 夹到 80', () => {
  const commits = manyCommits(100)
  for (const limit of [0, -1]) {
    const page = gatherCommits(commits, '2026-08-03', '2026-08-09', { limit })
    assert.equal(page.limit, 40)
    assert.equal(page.count, 40)
  }
  const capped = gatherCommits(commits, '2026-08-03', '2026-08-09', { limit: 500 })
  assert.equal(capped.limit, MAX_GATHER_COMMIT_LIMIT)
  assert.equal(capped.limit, 80)
  assert.equal(capped.count, 80)
  assert.equal(capped.hasMore, true)
  assert.equal(capped.nextOffset, 80)
})

test('gatherCommits：>80 多页可翻完（第二页 offset=nextOffset）', () => {
  const commits = manyCommits(85)
  const first = gatherCommits(commits, '2026-08-03', '2026-08-09', { limit: 80 })
  assert.equal(first.nextOffset, 80)
  const second = gatherCommits(commits, '2026-08-03', '2026-08-09', {
    limit: 80,
    offset: first.nextOffset,
  })
  assert.equal(second.offset, 80)
  assert.equal(second.count, 5)
  assert.equal(second.hasMore, false)
  assert.equal(second.truncated, false)
  assert.equal('nextOffset' in second, false) // omitempty：0 时整键消失
  assert.equal(second.hint, GATHER_HINT_COMPLETE)
})

test('gatherCommits：offset 越界夹到 total，返回空页但 total 不变', () => {
  const commits = manyCommits(5)
  const page = gatherCommits(commits, '2026-08-03', '2026-08-09', { limit: 10, offset: 999 })
  assert.equal(page.offset, 5)
  assert.equal(page.count, 0)
  assert.equal(page.total, 5)
  assert.equal(page.hasMore, false)
  assert.equal(page.hint, GATHER_HINT_COMPLETE) // total>0 且未按 repo 过滤
  // 负数 offset 按 0
  const negative = gatherCommits(commits, '2026-08-03', '2026-08-09', { limit: 2, offset: -3 })
  assert.equal(negative.offset, 0)
  assert.equal(negative.count, 2)
})

test('gatherCommits：空集合不产出 hint', () => {
  const page = gatherCommits([], '2026-08-03', '2026-08-09', {})
  assert.equal(page.total, 0)
  assert.equal(page.count, 0)
  assert.equal(page.hasMore, false)
  assert.equal('hint' in page, false)
  assert.deepEqual(page.commits, [])
})

test('gatherCommits：repo 子串过滤（大小写不敏感 + 三项候选 + trim 回填）', () => {
  const commits = [
    makeCommit({ commitId: 'a1', pathWithNamespace: 'group/erp-eai', repoName: 'erp-eai', title: 'feat: a' }),
    makeCommit({ commitId: 'a2', pathWithNamespace: 'group/erp-eai', repoName: 'erp-eai', title: 'fix: b' }),
    makeCommit({ commitId: 'b1', pathWithNamespace: 'group/site-web', repoName: 'site-web', title: 'feat: c' }),
    makeCommit({ commitId: 'b2', pathWithNamespace: 'group/other', repoName: 'other', title: 'feat: d' }),
  ]
  const page = gatherCommits(commits, '2026-08-03', '2026-08-09', { repo: ' ERP ' })
  assert.equal(page.repo, 'ERP') // Go 回填 TrimSpace(opts.Repo)
  assert.equal(page.total, 2)
  assert.equal(page.count, 2)
  assert.equal(page.hasMore, false)
  assert.deepEqual(
    page.commits.map((commit) => commit.repo),
    ['group/erp-eai', 'group/erp-eai'],
  )
  // repo 命名空间参与匹配
  const byNamespace = gatherCommits(commits, '2026-08-03', '2026-08-09', { repo: 'group/other' })
  assert.equal(byNamespace.total, 1)
  // 过滤后无数据 → 不产出 hint（Go: repoFilter!="" 不进 else-if）
  const empty = gatherCommits(commits, '2026-08-03', '2026-08-09', { repo: 'no-such-repo' })
  assert.equal(empty.total, 0)
  assert.equal('hint' in empty, false)
})

test('gatherCommits：默认排除 merge 与 cherry-pick，includeMerge=true 才含两者', () => {
  const commits = [
    makeCommit({ commitId: 'n1', title: 'feat: normal' }),
    makeCommit({ commitId: 'm1', title: "Merge branch 'x'" }),
    makeCommit({ commitId: 'f1', title: 'feat: flagged merge', isMergeCommit: 1 }),
    makeCommit({ commitId: 'c1', title: 'fix: cherry', isCherryPickCommit: 1 }),
    makeCommit({ commitId: 'c2', title: 'fix: source cherry', cherryPickSourceCommit: 'abc' }),
  ]
  const excluded = gatherCommits(commits, '2026-08-03', '2026-08-09', {})
  assert.equal(excluded.total, 1)
  assert.deepEqual(
    excluded.commits.map((commit) => commit.title),
    ['feat: normal'],
  )
  const included = gatherCommits(commits, '2026-08-03', '2026-08-09', { includeMerge: true })
  assert.equal(included.total, 5)
  assert.equal(included.includeMerge, true)
})

test('gatherCommits：SlimCommit 投影（日期前 10 位 / 标题回退 / commitID 截 8 / omitempty 键）', () => {
  const commits = [
    makeCommit({
      commitId: '0123456789abcdef',
      title: '',
      message: 'fix: fallback title\n\nlong body',
      authoredDate: '2026-08-03T10:00:00+08:00',
      additions: 7,
      deletions: 3,
      total: 10,
    }),
    makeCommit({
      commitId: 'short',
      title: 'feat: short date',
      authoredDate: '2026-08-0', // 9 位 → date 为空串
      isMergeCommit: 1,
      isCherryPickCommit: 1,
      additions: 100,
      deletions: 50,
      total: 150,
    }),
  ]
  const page = gatherCommits(commits, '2026-08-03', '2026-08-09', { includeMerge: true })
  const [normal, special] = page.commits
  assert.deepEqual(normal, {
    date: '2026-08-03',
    title: 'fix: fallback title',
    repo: 'group/erp-eai',
    domain: '其他业务',
    branch: 'main',
    additions: 7,
    deletions: 3,
    commit_id: '01234567',
  })
  assert.equal('merge' in normal, false) // false → 整键消失
  assert.equal('cherry_pick' in normal, false)
  assert.deepEqual(special, {
    date: '',
    title: 'feat: short date',
    repo: 'group/erp-eai',
    domain: '其他业务',
    branch: 'main',
    additions: 100,
    deletions: 50,
    merge: true,
    cherry_pick: true,
    commit_id: 'short',
  })
})

test('gatherCommits：空 title 且 message 为空时标题为空串（Go 不兜底）', () => {
  const page = gatherCommits(
    [makeCommit({ commitId: 'x', title: '', message: '' })],
    '2026-08-03',
    '2026-08-09',
    {},
  )
  assert.equal(page.commits[0].title, '')
})
