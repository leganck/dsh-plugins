/**
 * lib/sync.js 单测：同步编排（分页/二次过滤/取消/prune/并发/覆盖度/范围）。
 * 用 fetchImpl 同一层的假 GitLab 客户端（不发任何网络请求）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  closeDatabase,
  getSyncJob,
  listCommitsInPeriod,
  openDatabase,
  replaceCommitRefs,
  replaceCommitStats,
  saveSelectedProjects,
  upsertCommits,
  upsertRepositories,
} from '../../lib/db.js'
import { createSyncService, extractCherryPickSource, extractStats, localBoundary } from '../../lib/sync.js'

const CONN = 'conn-1'
const PROJECT = 11

/** 临时库（每个用例独立）。 */
function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-sync-'))
  const db = openDatabase(path.join(dir, 'report.db'))
  t.after(() => {
    closeDatabase(db)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return db
}

/** 选一个项目作为同步范围。 */
function selectProject(db, projectId = PROJECT, connectionId = CONN) {
  saveSelectedProjects(db, connectionId, [
    { projectId, pathWithNamespace: `group/proj-${projectId}`, name: `proj-${projectId}` },
  ])
}

/** GitLab 提交（list 接口形状，snake_case）。 */
function gitlabCommit(overrides = {}) {
  return {
    id: 'sha-1',
    title: 'feat: x',
    message: 'feat: x',
    author_name: 'Dev',
    author_email: 'dev@example.com',
    committer_name: 'Dev',
    committer_email: 'dev@example.com',
    authored_date: '2026-10-21T10:00:00+08:00',
    committed_date: '2026-10-21T10:00:00+08:00',
    ...overrides,
  }
}

/**
 * 假 GitLab 客户端。
 * @param {{projects?: Record<string, Array<Array<object>>>, paginationless?: boolean,
 *   failPage?: Function, failDetail?: Set<string>, detailDelayMs?: number,
 *   refsBySha?: Record<string, string[]>, statsBySha?: Record<string, object>,
 *   membershipPages?: Array<Array<object>>, userGate?: Promise<void>, hooks?: object,
 *   user?: object, emails?: object[]}} options
 */
function stubClient(options = {}) {
  const state = {
    listCalls: [],
    detailCalls: 0,
    concurrency: 0,
    maxConcurrency: 0,
    membershipCalls: 0,
  }
  const projects = options.projects ?? {}
  const user =
    options.user ?? {
      id: 1,
      name: 'Dev',
      username: 'dev',
      email: 'dev@example.com',
      commit_email: 'dev@example.com',
    }

  async function withDetailSlot(fn) {
    state.detailCalls += 1
    state.concurrency += 1
    state.maxConcurrency = Math.max(state.maxConcurrency, state.concurrency)
    try {
      if (options.detailDelayMs) await new Promise((resolve) => setTimeout(resolve, options.detailDelayMs))
      return await fn()
    } finally {
      state.concurrency -= 1
    }
  }

  const client = {
    baseUrl: 'https://gitlab.example.com',
    async getCurrentUser() {
      if (options.userGate) await options.userGate
      return user
    },
    async getUserEmails() {
      return options.emails ?? []
    },
    async listCommits(projectId, opts = {}) {
      state.listCalls.push({ projectId: Number(projectId), page: opts.page, since: opts.since, until: opts.until })
      options.hooks?.onListCommits?.(projectId, opts, state)
      const key = String(projectId)
      if (options.failPage && options.failPage(Number(projectId), opts.page)) {
        throw new Error(`upstream 503 on page ${opts.page}`)
      }
      const pages = projects[key] ?? []
      const items = pages[opts.page - 1] ?? []
      const paginationless = Boolean(options.paginationless)
      const nextPage = !paginationless && opts.page < pages.length ? opts.page + 1 : null
      return {
        items,
        page: opts.page,
        perPage: 100,
        total: pages.reduce((sum, page) => sum + page.length, 0),
        totalPages: pages.length,
        nextPage,
        hasPagination: !paginationless,
      }
    },
    async getCommit(projectId, sha) {
      return withDetailSlot(async () => {
        if (options.failDetail?.has(sha)) throw new Error(`detail 500 for ${sha}`)
        return { id: sha, stats: options.statsBySha?.[sha] ?? { additions: 10, deletions: 2, total: 12 } }
      })
    },
    async getCommitRefs(projectId, sha) {
      const names = options.refsBySha?.[sha] ?? ['main']
      return names.map((name) => ({ type: 'branch', name }))
    },
    async listMembershipProjects({ page = 1 } = {}) {
      state.membershipCalls += 1
      const pages = options.membershipPages ?? [[]]
      const items = pages[page - 1] ?? []
      return {
        items,
        page,
        perPage: 50,
        total: pages.reduce((sum, item) => sum + item.length, 0),
        totalPages: pages.length,
        nextPage: page < pages.length ? page + 1 : null,
        hasPagination: true,
      }
    },
  }
  return { client, state }
}

/** 建服务（默认不打印日志）。 */
function makeService(db, client, config = {}) {
  return createSyncService({
    db,
    config,
    gitlabForConnection: () => client,
    logger: null,
  })
}

const WINDOW = { startDate: '2026-10-19', endDate: '2026-10-25' }

test('完整同步：分页拉取 → matcher 过滤 → detail/refs → 落库 → succeeded', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  const { client, state } = stubClient({
    projects: {
      [PROJECT]: [
        [
          gitlabCommit({ id: 'sha-a', title: 'feat: a' }),
          gitlabCommit({
            id: 'sha-other',
            author_email: 'other@example.com',
            author_name: 'Other',
            committer_name: 'Other',
            committer_email: 'other@example.com',
          }),
        ],
        [gitlabCommit({ id: 'sha-c', title: 'fix: c', authored_date: '2026-10-22T09:00:00+08:00' })],
      ],
    },
    refsBySha: { 'sha-a': ['release/1.0', 'main'] },
  })
  const svc = makeService(db, client)
  const { jobId, totalProjects } = await svc.start({ connectionId: CONN, ...WINDOW })
  assert.equal(totalProjects, 1)

  const job = await svc.waitForJob(jobId)
  assert.equal(job.status, 'succeeded')
  assert.equal(job.progress.totalProjects, 1)
  assert.equal(job.progress.syncedProjects, 1)
  assert.equal(job.progress.totalCommits, 2, '只落库 matcher 命中的 2 条')
  assert.equal(job.progress.percent, 100)
  assert.equal(job.progress.partial, false, '完全成功不应标 partial')
  assert.equal(job.errors.length, 0)

  const rows = listCommitsInPeriod(db, WINDOW)
  assert.deepEqual(
    rows.map((row) => row.commitId).sort(),
    ['sha-a', 'sha-c'],
    '非本人提交不应落库',
  )
  const a = rows.find((row) => row.commitId === 'sha-a')
  assert.equal(a.additions, 10)
  assert.equal(a.total, 12)
  assert.equal(a.pathWithNamespace, `group/proj-${PROJECT}`)
  assert.equal(a.primaryBranch, 'release/1.0', 'refs 数组序 → branch_order')
  assert.equal(a.branchNamesJson, '["release/1.0","main"]')

  // 分页顺序 + 窗口边界格式（本机时区 RFC3339）
  assert.deepEqual(
    state.listCalls.map((call) => call.page),
    [1, 2],
  )
  assert.match(state.listCalls[0].since, /^2026-10-19T00:00:00[+-]\d{2}:\d{2}$/)
  assert.match(state.listCalls[0].until, /^2026-10-25T23:59:59[+-]\d{2}:\d{2}$/)
})

test('窗口二次过滤：authored_date 前 10 位不在区间的一律丢弃', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  const { client } = stubClient({
    projects: {
      [PROJECT]: [
        [
          gitlabCommit({ id: 'in-window', authored_date: '2026-10-20T23:30:00+08:00' }),
          gitlabCommit({ id: 'before', authored_date: '2026-10-18T23:59:59+08:00' }),
          gitlabCommit({ id: 'after', authored_date: '2026-10-26T00:00:00+08:00' }),
          gitlabCommit({
            id: 'authored-out-committed-in',
            authored_date: '2026-10-18T10:00:00+08:00',
            committed_date: '2026-10-21T10:00:00+08:00',
          }),
        ],
      ],
    },
  })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  await svc.waitForJob(jobId)

  const rows = listCommitsInPeriod(db, WINDOW)
  assert.deepEqual(rows.map((row) => row.commitId), ['in-window'], '只保留 authored 日期在窗口内的提交')
})

test('分页头缺失 → 项目 incomplete：终态 succeeded+partial，且不 prune 历史（05 分册 R4）', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  // 上次同步留下的窗口内提交
  upsertCommits(db, [
    {
      connectionId: CONN,
      projectId: PROJECT,
      commitId: 'historic',
      title: 'old',
      authoredDate: '2026-10-20T10:00:00+08:00',
      committedDate: '2026-10-20T10:00:00+08:00',
    },
  ])
  const { client } = stubClient({
    paginationless: true,
    projects: { [PROJECT]: [[gitlabCommit({ id: 'fresh', authored_date: '2026-10-21T10:00:00+08:00' })]] },
  })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  const job = await svc.waitForJob(jobId)

  assert.equal(job.status, 'succeeded', '有成功落库时终态不应是 failed（仅 partial）')
  assert.equal(job.progress.partial, true, '分页信息缺失应标记 partial')
  assert.equal(job.progress.incompleteProjects, 1)
  const rows = listCommitsInPeriod(db, WINDOW)
  assert.deepEqual(rows.map((row) => row.commitId).sort(), ['fresh', 'historic'], '历史提交不得被清理')
})

test('完整翻页 → prune 掉窗口内远端已不存在的提交', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  upsertCommits(db, [
    {
      connectionId: CONN,
      projectId: PROJECT,
      commitId: 'stale',
      title: 'stale',
      authoredDate: '2026-10-20T10:00:00+08:00',
      committedDate: '2026-10-20T10:00:00+08:00',
    },
  ])
  replaceCommitStats(db, [{ connectionId: CONN, projectId: PROJECT, commitId: 'stale', additions: 1, deletions: 0, total: 1 }])
  replaceCommitRefs(db, [{ connectionId: CONN, projectId: PROJECT, commitId: 'stale', branches: ['main'] }])
  const { client } = stubClient({
    projects: { [PROJECT]: [[gitlabCommit({ id: 'fresh', authored_date: '2026-10-21T10:00:00+08:00' })]] },
  })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  const job = await svc.waitForJob(jobId)

  assert.equal(job.status, 'succeeded')
  const rows = listCommitsInPeriod(db, WINDOW)
  assert.deepEqual(rows.map((row) => row.commitId), ['fresh'])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commit_stats').get().n, 1, 'stale 的 stats 应级联删除')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM commit_branch_refs WHERE commit_id='stale'").get().n, 0)
})

test('取消：运行中 cancel → 终态 cancelled，且不再继续翻页/写入', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  const controller = {}
  const { client, state } = stubClient({
    projects: {
      [PROJECT]: [
        [gitlabCommit({ id: 'sha-a' })],
        [gitlabCommit({ id: 'sha-b' })],
      ],
    },
    hooks: {
      onListCommits(projectId, opts) {
        if (opts.page === 1) {
          // 模拟用户在运行中点击取消
          void controller.svc.cancel().catch(() => {})
        }
      },
    },
  })
  const svc = makeService(db, client)
  controller.svc = svc
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  const job = await svc.waitForJob(jobId)

  assert.equal(job.status, 'cancelled')
  assert.equal(job.progress.cancelRequested, true)
  assert.equal(state.listCalls.length, 1, '取消后不应再请求第 2 页')
  assert.equal(listCommitsInPeriod(db, WINDOW).length, 0, '取消点之前不应有半批写入')
})

test('取消：pending 任务直接置 cancelled（cancel(jobId) 返回 boolean）', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { client } = stubClient({ userGate: gate, projects: { [PROJECT]: [[]] } })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  const accepted = await svc.cancel(jobId)
  assert.equal(accepted, true)
  release()
  const job = await svc.waitForJob(jobId)
  assert.equal(job.status, 'cancelled')
})

test('提交 detail 失败 → succeeded+partial + sync_job_errors(commit_sync) + 不 prune', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  upsertCommits(db, [
    {
      connectionId: CONN,
      projectId: PROJECT,
      commitId: 'historic',
      title: 'old',
      authoredDate: '2026-10-20T10:00:00+08:00',
      committedDate: '2026-10-20T10:00:00+08:00',
    },
  ])
  const { client } = stubClient({
    projects: {
      [PROJECT]: [[gitlabCommit({ id: 'ok' }), gitlabCommit({ id: 'bad', title: 'feat: bad' })]],
    },
    failDetail: new Set(['bad']),
  })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  const job = await svc.waitForJob(jobId)

  assert.equal(job.status, 'succeeded', '有提交成功落库 → succeeded')
  assert.equal(job.progress.partial, true, '存在失败提交 → partial')
  assert.equal(job.errors.length, 1)
  assert.equal(job.errors[0].stage, 'commit_sync')
  assert.equal(job.errors[0].commitId, 'bad')
  const ids = listCommitsInPeriod(db, WINDOW).map((row) => row.commitId).sort()
  assert.deepEqual(ids, ['historic', 'ok'], '失败项目不 prune，且成功的提交仍落库')
})

test('零成功 + 有错误 → failed（partial）', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  const { client } = stubClient({
    projects: { [PROJECT]: [[gitlabCommit({ id: 'bad-1' }), gitlabCommit({ id: 'bad-2' })]] },
    failDetail: new Set(['bad-1', 'bad-2']),
  })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  const job = await svc.waitForJob(jobId)

  assert.equal(job.status, 'failed', '零成功且有错误才 failed')
  assert.equal(job.progress.partial, true)
  assert.equal(job.progress.totalCommits, 0)
  assert.equal(job.progress.incompleteProjects, 1)
  assert.equal(job.errors.length, 2)
  assert.equal(listCommitsInPeriod(db, WINDOW).length, 0)
})

test('第 2 页拉取失败 → succeeded+partial，project_sync 错误，第 1 页数据保留', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  const { client } = stubClient({
    projects: {
      [PROJECT]: [[gitlabCommit({ id: 'page-1' })], [gitlabCommit({ id: 'page-2' })]],
    },
    failPage: (projectId, page) => page === 2,
  })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  const job = await svc.waitForJob(jobId)

  assert.equal(job.status, 'succeeded', '第 1 页已成功落库 → succeeded')
  assert.equal(job.progress.partial, true)
  assert.equal(job.errors.length, 1)
  assert.equal(job.errors[0].stage, 'project_sync')
  assert.deepEqual(
    listCommitsInPeriod(db, WINDOW).map((row) => row.commitId),
    ['page-1'],
  )
})

test('多项目：项目串行、页串行（顺序断言）', async (t) => {
  const db = tempDb(t)
  saveSelectedProjects(db, CONN, [
    { projectId: 11, pathWithNamespace: 'g/a', name: 'a' },
    { projectId: 22, pathWithNamespace: 'g/b', name: 'b' },
  ])
  const { client, state } = stubClient({
    projects: {
      11: [[gitlabCommit({ id: 'a-1' })], [gitlabCommit({ id: 'a-2' })]],
      22: [[gitlabCommit({ id: 'b-1' })], [gitlabCommit({ id: 'b-2' })]],
    },
  })
  const svc = makeService(db, client)
  const { jobId, totalProjects } = await svc.start({ connectionId: CONN, ...WINDOW })
  assert.equal(totalProjects, 2)
  const job = await svc.waitForJob(jobId)
  assert.equal(job.status, 'succeeded')
  assert.deepEqual(
    state.listCalls.map((call) => `${call.projectId}:${call.page}`),
    ['11:1', '11:2', '22:1', '22:2'],
  )
  assert.equal(job.progress.syncedProjects, 2)
  assert.equal(job.progress.totalCommits, 4)
})

test('页内并发 ≤8，且 30 条提交按批写入', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  const commits = Array.from({ length: 30 }, (_, index) =>
    gitlabCommit({
      id: `sha-${String(index).padStart(2, '0')}`,
      title: `feat: ${index}`,
      message: `feat: ${index}`,
    }),
  )
  const { client, state } = stubClient({
    projects: { [PROJECT]: [commits] },
    detailDelayMs: 5,
  })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  const job = await svc.waitForJob(jobId)

  assert.equal(job.status, 'succeeded')
  assert.equal(job.progress.totalCommits, 30)
  assert.equal(listCommitsInPeriod(db, WINDOW).length, 30)
  assert.ok(state.maxConcurrency > 1, '应该并发拉 detail')
  assert.ok(state.maxConcurrency <= 8, `并发数应 ≤8，实际 ${state.maxConcurrency}`)
})

test('落库派生列：merge / cherry-pick 判定与源提交', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  const { client } = stubClient({
    projects: {
      [PROJECT]: [
        [
          gitlabCommit({ id: 'merge-1', title: 'Merge branch "dev" into main', message: 'Merge branch "dev" into main' }),
          gitlabCommit({
            id: 'cherry-1',
            title: 'fix: backport',
            message: 'fix: backport\n\n(cherry picked from commit abc123)',
          }),
        ],
      ],
    },
  })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  await svc.waitForJob(jobId)

  const rows = listCommitsInPeriod(db, WINDOW)
  const merge = rows.find((row) => row.commitId === 'merge-1')
  const cherry = rows.find((row) => row.commitId === 'cherry-1')
  assert.equal(merge.isMergeCommit, 1)
  assert.equal(cherry.isCherryPickCommit, 1)
  assert.equal(cherry.cherryPickSourceCommit, 'abc123')
})

test('listCandidates：membership 分页 + q 过滤（返回数组，供 api/tools 直接消费）', async (t) => {
  const db = tempDb(t)
  const { client, state } = stubClient({
    membershipPages: [
      [
        { id: 1, name: 'alpha-api', path_with_namespace: 'g/alpha-api' },
        { id: 2, name: 'beta-web', path_with_namespace: 'g/beta-web' },
      ],
      [{ id: 3, name: 'gamma-api', path_with_namespace: 'g/sub/gamma-api' }],
    ],
  })
  const svc = makeService(db, client)
  const all = await svc.listCandidates({ connectionId: CONN })
  assert.ok(Array.isArray(all), 'listCandidates 必须返回数组')
  assert.equal(state.membershipCalls, 2, '应翻完 2 页')
  assert.equal(all.length, 3)
  assert.equal(all[0].pathWithNamespace, 'g/alpha-api')

  const detailed = await svc.listCandidatesDetailed({ connectionId: CONN })
  assert.equal(detailed.complete, true)
  assert.equal(detailed.total, 3)

  const filtered = await svc.listCandidates({ connectionId: CONN, q: 'API' })
  assert.deepEqual(filtered.map((project) => project.id), [1, 3], 'q 大小写不敏感且匹配路径')
})

test('getSelection / saveSelection：全量替换与校验', async (t) => {
  const db = tempDb(t)
  const svc = makeService(db, stubClient().client)
  const saved = await svc.saveSelection(CONN, [
    { id: 5, pathWithNamespace: 'g/five', name: 'five' },
    { id: 6, pathWithNamespace: 'g/six', name: 'six' },
  ])
  assert.equal(saved.saved, 2)
  assert.deepEqual((await svc.getSelection(CONN)).map((row) => row.projectId), [5, 6])

  await svc.saveSelection(CONN, [{ id: 7, pathWithNamespace: 'g/seven', name: 'seven' }])
  assert.deepEqual((await svc.getSelection(CONN)).map((row) => row.projectId), [7])
  assert.equal((await svc.getSelection()).length, 1, '不传连接 = 全部')

  await assert.rejects(() => svc.saveSelection(CONN, [{ id: 0 }]), /projectId/)
  await assert.rejects(() => svc.saveSelection('', []), /connectionId/)
})

test('配置形状兼容：函数 / 管理器 / 快照都能提供作者别名', async (t) => {
  // 1) 纯函数读取配置
  const db = tempDb(t)
  selectProject(db)
  const { client } = stubClient({
    projects: {
      [PROJECT]: [
        [
          gitlabCommit({
            id: 'alias-hit',
            author_name: 'Legacy-Name',
            author_email: 'legacy@corp.example',
            committer_name: 'Other',
            committer_email: 'other@example.com',
          }),
        ],
      ],
    },
  })
  const svc = createSyncService({
    db,
    config: { getConfig: () => ({ gitlabAuthorAliases: 'legacy-name\nlegacy@corp.example' }) },
    gitlabForConnection: () => client,
    logger: null,
  })
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  const job = await svc.waitForJob(jobId)
  assert.equal(job.status, 'succeeded')
  assert.deepEqual(
    listCommitsInPeriod(db, WINDOW).map((row) => row.commitId),
    ['alias-hit'],
    '管理器形态的配置也能提供别名',
  )

  // 2) 函数形态
  const db2 = tempDb(t)
  selectProject(db2)
  const svc2 = createSyncService({
    db: db2,
    config: () => ({ aliases: ['legacy-name'] }),
    gitlabForConnection: () => stubClient({
      projects: {
        [PROJECT]: [[gitlabCommit({ id: 'alias-hit-2', author_name: 'Legacy-Name', author_email: 'l@x.test' })]],
      },
    }).client,
    logger: null,
  })
  const second = await svc2.start({ connectionId: CONN, ...WINDOW })
  const secondJob = await svc2.waitForJob(second.jobId)
  assert.equal(secondJob.status, 'succeeded')
  assert.equal(listCommitsInPeriod(db2, WINDOW).length, 1)
})

test('coverage：summary / 每仓明细 / 日期分布 / 区间过滤', async (t) => {
  const db = tempDb(t)
  const base = { connectionId: CONN, authorName: 'Dev', authorEmail: 'dev@example.com' }
  upsertCommits(db, [
    { ...base, projectId: 1, commitId: 'a1', authoredDate: '2026-10-20T09:00:00+08:00' },
    { ...base, projectId: 1, commitId: 'a2', authoredDate: '2026-10-21T09:00:00+08:00' },
    { ...base, projectId: 2, commitId: 'b1', authoredDate: '2026-10-21T11:00:00+08:00' },
    { ...base, projectId: 2, commitId: 'b2', authoredDate: '2026-09-01T11:00:00+08:00' },
  ])
  upsertRepositories(db, [
    { connectionId: CONN, projectId: 1, pathWithNamespace: 'g/one', name: 'one' },
    { connectionId: CONN, projectId: 2, pathWithNamespace: 'g/two', name: 'two' },
  ])
  const svc = makeService(db, stubClient().client)

  const all = await svc.coverage({})
  assert.equal(all.summary.repoCount, 2)
  assert.equal(all.summary.commitCount, 4)
  assert.equal(all.summary.firstCommitDate, '2026-09-01')
  assert.equal(all.summary.lastCommitDate, '2026-10-21')
  assert.equal(all.summary.activeDayCount, 3, '不同日期：09-01 / 10-20 / 10-21')
  assert.equal(all.repos.length, 2)
  assert.equal(all.repos[0].pathWithNamespace, 'g/two', '按 latestCommitDate DESC')
  const two = all.repos.find((repo) => repo.projectId === 2)
  assert.equal(two.commitCount, 2)
  assert.deepEqual(two.contributionDays, [
    { date: '2026-09-01', count: 1 },
    { date: '2026-10-21', count: 1 },
  ])
  assert.equal(all.dateDistribution[0].date, '2026-10-21', '日期分布倒序')
  assert.equal(all.dateDistribution[0].count, 2)

  const ranged = await svc.coverage({ startDate: '2026-10-01', endDate: '2026-10-25' })
  assert.equal(ranged.summary.commitCount, 3)
  assert.equal(ranged.summary.repoCount, 2)
})

test('start 校验：日期格式 / 顺序 / 无选择 / 活动任务复用', async (t) => {
  const db = tempDb(t)
  const svc = makeService(db, stubClient({ projects: {} }).client)

  await assert.rejects(() => svc.start({ connectionId: CONN, startDate: '2026/10/19', endDate: '2026-10-25' }), /YYYY-MM-DD/)
  await assert.rejects(
    () => svc.start({ connectionId: CONN, startDate: '2026-10-26', endDate: '2026-10-25' }),
    /不能晚于/,
  )
  await assert.rejects(() => svc.start({ connectionId: CONN, ...WINDOW }), /没有已选择/)

  // 活动任务复用：用 gate 卡住 runner，第二次 start 返回 reused
  selectProject(db)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { client } = stubClient({ userGate: gate, projects: { [PROJECT]: [[]] } })
  const gatedSvc = makeService(db, client)
  const first = await gatedSvc.start({ connectionId: CONN, ...WINDOW })
  assert.equal(first.reused, false)
  const second = await gatedSvc.start({ connectionId: CONN, ...WINDOW })
  assert.equal(second.reused, true)
  assert.equal(second.jobId, first.jobId)
  release()
  await gatedSvc.waitForJob(first.jobId)
})

test('status / listJobs / 取消不存在任务', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  const { client } = stubClient({ projects: { [PROJECT]: [[gitlabCommit({ id: 'sha-a' })]] } })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  await svc.waitForJob(jobId)

  const job = await svc.status(jobId)
  assert.equal(job.jobId, jobId)
  assert.equal(job.terminal, true)
  const latest = await svc.status()
  assert.equal(latest.jobId, jobId, '无活动任务时返回最近一次')
  assert.equal((await svc.listJobs(5)).length, 1)
  assert.equal(await svc.status('missing'), null)

  const missing = await svc.cancel('missing')
  assert.equal(missing, false, '不存在任务返回 false')
  // 已结束任务不可再取消
  assert.equal(await svc.cancel(jobId), false)
})

test('sync_job_errors 与 progress 在任务视图中可见', async (t) => {
  const db = tempDb(t)
  selectProject(db)
  const { client } = stubClient({
    projects: { [PROJECT]: [[gitlabCommit({ id: 'bad' })]] },
    failDetail: new Set(['bad']),
  })
  const svc = makeService(db, client)
  const { jobId } = await svc.start({ connectionId: CONN, ...WINDOW })
  await svc.waitForJob(jobId)
  const job = getSyncJob(db, jobId)
  assert.equal(job.progress.partial, true)
  assert.equal(job.progress.errors, 1)
  assert.equal(job.errors.length, 1)
})

test('辅助函数：localBoundary / extractStats / extractCherryPickSource', () => {
  assert.match(localBoundary('2026-10-19', '00:00:00'), /^2026-10-19T00:00:00[+-]\d{2}:\d{2}$/)
  assert.match(localBoundary('2026-10-25', '23:59:59'), /^2026-10-25T23:59:59[+-]\d{2}:\d{2}$/)
  assert.equal(localBoundary('bad', '00:00:00'), '')

  assert.deepEqual(extractStats({ stats: { additions: 3, deletions: 2, total: 5 } }), {
    additions: 3,
    deletions: 2,
    total: 5,
  })
  assert.deepEqual(extractStats({ stats: { additions: 3, deletions: 2 } }), {
    additions: 3,
    deletions: 2,
    total: 5,
  })
  assert.deepEqual(extractStats({}), { additions: 0, deletions: 0, total: 0 })

  assert.equal(extractCherryPickSource('fix\n\n(cherry picked from commit abc123)'), 'abc123')
  assert.equal(extractCherryPickSource('fix\n\ncherry-picked from commit def456'), 'def456')
  assert.equal(extractCherryPickSource('fix\n\ncherry picked from commit ghi789'), 'ghi789')
  assert.equal(extractCherryPickSource('fix: nothing'), '')
})

test('多连接：一次任务同步多个 GitLab 连接', async (t) => {
  const db = tempDb(t)
  const CONN2 = 'conn-2'
  const PROJECT2 = 22
  selectProject(db, PROJECT, CONN)
  selectProject(db, PROJECT2, CONN2)
  const { client } = stubClient({
    projects: {
      [PROJECT]: [[gitlabCommit({ id: 'sha-a', authored_date: '2026-10-21T10:00:00+08:00', committed_date: '2026-10-21T10:00:00+08:00' })]],
      [PROJECT2]: [[gitlabCommit({ id: 'sha-b', authored_date: '2026-10-22T10:00:00+08:00', committed_date: '2026-10-22T10:00:00+08:00' })]],
    },
  })
  const svc = makeService(db, client)
  const started = await svc.start({ connectionIds: [CONN, CONN2], ...WINDOW })
  assert.equal(started.totalProjects, 2)
  const job = await svc.waitForJob(started.jobId)
  assert.equal(job.status, 'succeeded')
  assert.equal(job.progress.syncedProjects, 2)
  assert.equal(listCommitsInPeriod(db, WINDOW).length, 2)
  assert.equal(job.scope.connectionIds.length, 2)
})
