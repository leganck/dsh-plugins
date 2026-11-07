/**
 * fixtures.mjs —— 领域单测共用的提交夹具。
 *
 * 夹具刻意覆盖 Go 单测里锁定的边界（aggregate_test.go / gather_test.go）：
 *   - `is_merge_commit=1` 但标题无 merge；
 *   - 标题 `Merge branch ...` 但 flag=0；
 *   - 标题 `merge-fix:`（误判用例，必须与 Go 一样算 merge）；
 *   - cherry-pick 的 flag 型与 source 字段型；
 *   - 同一条提交同时 merge + cherry（NonMergeCommitCount 会为负）。
 */

/**
 * 生成一条默认「普通提交」，可用 overrides 覆盖任意字段。
 * @param {Record<string, unknown>} [overrides]
 * @returns {import('../../lib/domain/model.js').CommitView}
 */
export function makeCommit(overrides = {}) {
  return {
    connectionId: 'conn-1',
    commitId: 'aaaaaaaaaaaaaaaa',
    projectId: 1,
    message: 'feat: baseline\n\nbody',
    authoredDate: '2026-08-03T10:00:00+08:00',
    committedDate: '2026-08-03T10:00:00+08:00',
    authorName: 'dev',
    authorEmail: 'dev@example.com',
    title: 'feat: baseline',
    isMergeCommit: 0,
    isCherryPickCommit: 0,
    cherryPickSourceCommit: '',
    additions: 10,
    deletions: 2,
    total: 12,
    repoName: 'erp-eai',
    repoNamespace: 'group',
    pathWithNamespace: 'group/erp-eai',
    primaryBranch: 'main',
    branchNamesJson: '["main"]',
    branchNames: ['main'],
    ...overrides,
  }
}

/**
 * 「三种口径 + 误判」混合夹具（与 stats.test.mjs 的数字断言对应）。
 *
 * | id | 形态 | additions | deletions | total | 计入非 merge 行数 |
 * |----|------|-----------|-----------|-------|------------------|
 * | c1 | 普通 | 100 | 20 | 120 | ✅ |
 * | c2 | flag merge（标题无 merge） | 40 | 10 | 50 | ❌ |
 * | c3 | 标题 merge（flag=0） | 500 | 400 | 900 | ❌ |
 * | c4 | flag cherry | 10 | 5 | 15 | ❌ |
 * | c5 | source cherry | 7 | 3 | 10 | ❌ |
 * | c6 | merge + cherry | 30 | 30 | 60 | ❌ |
 * @returns {import('../../lib/domain/model.js').CommitView[]}
 */
export function mixedCommits() {
  return [
    makeCommit({
      commitId: 'c1',
      title: 'feat: add order export',
      authoredDate: '2026-08-03T10:00:00+08:00',
      additions: 100,
      deletions: 20,
      total: 120,
    }),
    makeCommit({
      commitId: 'c2',
      title: 'feat: land helper',
      isMergeCommit: 1,
      authoredDate: '2026-08-03T11:00:00+08:00',
      additions: 40,
      deletions: 10,
      total: 50,
    }),
    makeCommit({
      commitId: 'c3',
      title: "Merge branch 'release' into main",
      isMergeCommit: 0,
      authoredDate: '2026-08-04T09:00:00+08:00',
      additions: 500,
      deletions: 400,
      total: 900,
    }),
    makeCommit({
      commitId: 'c4',
      title: 'fix: pick flag cherry',
      isCherryPickCommit: 1,
      authoredDate: '2026-08-04T10:00:00+08:00',
      additions: 10,
      deletions: 5,
      total: 15,
    }),
    makeCommit({
      commitId: 'c5',
      title: 'fix: pick source cherry',
      cherryPickSourceCommit: 'deadbeefdeadbeef',
      authoredDate: '2026-08-05T10:00:00+08:00',
      additions: 7,
      deletions: 3,
      total: 10,
    }),
    makeCommit({
      commitId: 'c6',
      title: 'chore: merge then cherry',
      isMergeCommit: 1,
      isCherryPickCommit: 1,
      authoredDate: '2026-08-05T11:00:00+08:00',
      additions: 30,
      deletions: 30,
      total: 60,
    }),
  ]
}

/**
 * 生成 N 条同仓库普通提交（分页边界用；commitId 递增且唯一）。
 * @param {number} count
 * @param {Record<string, unknown>} [overrides]
 * @returns {import('../../lib/domain/model.js').CommitView[]}
 */
export function manyCommits(count, overrides = {}) {
  const list = []
  for (let index = 0; index < count; index += 1) {
    const commitId = `sha${String(index).padStart(13, '0')}`
    list.push(
      makeCommit({
        commitId,
        title: `feat: bulk ${index}`,
        additions: 1,
        deletions: 0,
        total: 1,
        ...overrides,
      }),
    )
  }
  return list
}

/**
 * snake_case 库行（模拟 `lib/db.js` 的 `listCommitsInPeriod` 返回值），用于验证 commitView 归一。
 * 注意：这里**不**调用 `toCommitView`，保持库行原貌（否则测不到归一逻辑）。
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
export function makeDbRow(overrides = {}) {
  return {
    connection_id: 'conn-1',
    commit_id: 'row-1',
    project_id: 9,
    message: 'feat: row\n\nbody',
    authored_date: '2026-08-03 10:00:00',
    committed_date: '2026-08-03 10:00:00',
    author_name: 'dev',
    author_email: 'dev@example.com',
    title: 'feat: row',
    is_merge_commit: 0,
    is_cherry_pick_commit: 0,
    cherry_pick_source_commit: '',
    additions: 5,
    deletions: 1,
    total: 6,
    repo_name: 'erp-eai',
    repo_namespace: 'group',
    path_with_namespace: 'group/erp-eai',
    primary_branch: 'main',
    branch_names_json: '["main"]',
    ...overrides,
  }
}
