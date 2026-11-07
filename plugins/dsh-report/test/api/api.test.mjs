/**
 * lib/api.js 契约测试：`/plugins/dsh-report/api` 下的全部端点
 *
 * 覆盖（CONTRACTS §5）：ping / config 读写 / reports 列表·详情·统计·导出·删除 /
 * line-stats 参数校验 / gitlab 连接·项目·选择范围 / sync coverage·jobs·start·cancel /
 * templates 读写 / 错误信封 / 404·405 / 流式 body。
 *
 * 依赖 test/api/helpers.mjs 的测试替身；不触碰 SQLite / GitLab / 网络。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { API_PREFIX, createApiHandler, deriveConnectionId } from '../../lib/api.js'
import {
  PERIOD,
  PERIOD_ID,
  callApi,
  createFakeDomain,
  createFakeStore,
  createFakeSync,
  createGitLabFactory,
  makeDeps,
  makeRes,
  makeStreamReq,
  seedReport,
} from './helpers.mjs'

/** 创建 handler + 夹具。 */
function boot(overrides = {}) {
  const built = makeDeps(overrides)
  const handler = createApiHandler(built.deps)
  return { handler, ...built }
}

/** 拼 API URL。 */
function api(path) {
  return `${API_PREFIX}${path}`
}

/** 断言错误信封。 */
function assertError(response, status, code) {
  assert.equal(response.status, status, `期望 HTTP ${status}，实际 ${response.status}：${response.body}`)
  assert.equal(response.json?.error, code)
  assert.equal(typeof response.json?.message, 'string')
  assert.ok(response.json.message.length > 0)
}

/* ------------------------------------------------------------------ /ping */

test('GET /ping 返回构建信息、db 状态与报告数量', async () => {
  const store = createFakeStore()
  seedReport(store)
  const { handler } = boot({ store })
  const response = await callApi(handler, { url: api('/ping') })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.build, '0.2.0-test')
  assert.equal(response.json.node, 'v26.0.0')
  assert.equal(response.json.dbPath, '/tmp/report.db')
  assert.equal(response.json.dbAvailable, true)
  assert.equal(response.json.reports, 1)
  assert.equal(response.json.timezone, 'Asia/Shanghai')
  assert.match(response.headers['content-type'], /application\/json/)
})

/* ----------------------------------------------------------------- /config */

test('GET /config 只暴露 tokenRef 与 hasToken，不返回明文 token', async () => {
  const { handler } = boot({
    config: {
      gitlab: { baseUrl: 'https://gitlab.example.com', tokenRef: 'dsh-report/gitlab-token' },
      timezone: 'UTC',
      defaultReportType: 'month',
    },
    token: 'super-secret',
  })
  const response = await callApi(handler, { url: api('/config') })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.gitlab, {
    baseUrl: 'https://gitlab.example.com',
    tokenRef: 'dsh-report/gitlab-token',
    hasToken: true,
    authorAliases: [],
  })
  assert.equal(response.json.timezone, 'UTC')
  assert.equal(response.json.defaultReportType, 'month')
  assert.doesNotMatch(response.body, /super-secret/)
})

test('PUT /config 写配置与 token（token 不进配置补丁）', async () => {
  const { handler, calls } = boot()
  const response = await callApi(handler, {
    method: 'PUT',
    url: api('/config'),
    body: {
      timezone: 'Asia/Tokyo',
      defaultReportType: 'quarter',
      gitlab: { baseUrl: 'https://gitlab.example.com', token: 'tkn-1' },
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(calls.updateConfig, [
    { timezone: 'Asia/Tokyo', defaultReportType: 'quarter', gitlab: { baseUrl: 'https://gitlab.example.com' } },
  ])
  assert.deepEqual(calls.saveToken, ['tkn-1'])
  assert.equal(response.json.timezone, 'Asia/Tokyo')
})

test('PUT /config 校验：空补丁 / 非法类型 / 非法 baseUrl', async () => {
  const { handler } = boot()
  assertError(await callApi(handler, { method: 'PUT', url: api('/config'), body: {} }), 400, 'validation')
  assertError(
    await callApi(handler, { method: 'PUT', url: api('/config'), body: { defaultReportType: 'day' } }),
    400,
    'validation',
  )
  assertError(
    await callApi(handler, {
      method: 'PUT',
      url: api('/config'),
      body: { gitlab: { baseUrl: 'gitlab.example.com' } },
    }),
    400,
    'validation',
  )
})

test('PUT /config 支持流式请求体（走 data/end 分支）', async () => {
  const { handler, calls } = boot()
  const res = makeRes()
  await handler(makeStreamReq({ method: 'PUT', url: api('/config'), body: { timezone: 'UTC' } }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls.updateConfig, [{ timezone: 'UTC' }])
})

test('PUT /config 非法 JSON 返回 400', async () => {
  const { handler } = boot()
  const res = makeRes()
  const { Readable } = await import('node:stream')
  const req = Readable.from([Buffer.from('{not json', 'utf8')])
  req.method = 'PUT'
  req.url = api('/config')
  await handler(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error, 'validation')
})

/* ---------------------------------------------------------------- /reports */

test('GET /reports 返回 camelCase 列表', async () => {
  const store = createFakeStore()
  seedReport(store)
  const { handler } = boot({ store })
  const response = await callApi(handler, { url: api('/reports') })
  assert.equal(response.status, 200)
  assert.equal(response.json.reports.length, 1)
  assert.deepEqual(response.json.reports[0], {
    id: PERIOD_ID,
    type: 'week',
    periodStart: '2026-10-20',
    periodEnd: '2026-10-26',
    status: 'generated',
    totalCommits: 12,
    generatedAt: '2026-10-27 09:00:00',
  })
})

test('GET /reports/:id 默认含 content，includeContent=0 时置 null', async () => {
  const store = createFakeStore()
  seedReport(store)
  const { handler } = boot({ store })
  const full = await callApi(handler, { url: api(`/reports/${encodeURIComponent(PERIOD_ID)}`) })
  assert.equal(full.status, 200)
  assert.match(full.json.content, /支付链路联调/)
  assert.equal(full.json.totalCommits, 12)
  assert.equal(full.json.cherryPickCommitCount, 1)
  assert.equal(full.json.typeLabel, '周报')
  assert.equal(full.json.topics.length, 1)
  assert.equal(full.json.topics[0].topicTitle, '支付联调')

  const slim = await callApi(handler, {
    url: api(`/reports/${encodeURIComponent(PERIOD_ID)}?includeContent=0`),
  })
  assert.equal(slim.json.content, null)
  assert.equal(slim.json.totalCommits, 12)
})

test('GET /reports/:id 不存在返回 404 信封', async () => {
  const { handler } = boot()
  const response = await callApi(handler, { url: api('/reports/week%3A2026-01-01%3A2026-01-07') })
  assertError(response, 404, 'not-found')
})

test('GET /reports/:id/stats 返回 { stats, lineStats, repoBranchStats }', async () => {
  const store = createFakeStore()
  seedReport(store)
  const { handler } = boot({ store })
  const response = await callApi(handler, { url: api(`/reports/${encodeURIComponent(PERIOD_ID)}/stats`) })
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(response.json).sort(), ['lineStats', 'repoBranchStats', 'stats'])
  assert.equal(response.json.stats.cherryPickCommitCount, 1)
  assert.equal(response.json.stats.totalLines, 428)
  assert.equal(response.json.lineStats.length, 2)
  assert.equal(response.json.lineStats[0].includeMerge, 1, 'snake_case 行需要映射成 camelCase')
  assert.equal(response.json.repoBranchStats[0].repoKey, 'team/erp-pos')
})

test('GET /reports/:id/export 返回 text/markdown + 附件名', async () => {
  const store = createFakeStore()
  seedReport(store)
  const { handler } = boot({ store })
  const response = await callApi(handler, {
    url: api(`/reports/${encodeURIComponent(PERIOD_ID)}/export?format=markdown`),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /text\/markdown/)
  assert.equal(
    response.headers['content-disposition'],
    "attachment; filename*=UTF-8''week-2026-10-20-2026-10-26.md",
  )
  assert.match(response.body, /# 周报/)
  assert.equal(response.json, null, '导出不应是 JSON 信封')
})

test('GET /reports/:id/export 校验 format 与空正文', async () => {
  const store = createFakeStore()
  seedReport(store)
  const { handler } = boot({ store })
  assertError(
    await callApi(handler, { url: api(`/reports/${encodeURIComponent(PERIOD_ID)}/export?format=json`) }),
    400,
    'validation',
  )
  const emptyStore = createFakeStore()
  seedReport(emptyStore, { row: { content: '' } })
  const second = boot({ store: emptyStore })
  assertError(
    await callApi(second.handler, { url: api(`/reports/${encodeURIComponent(PERIOD_ID)}/export`) }),
    400,
    'validation',
  )
})

test('DELETE /reports/:id 删除成功，再次删除 404', async () => {
  const store = createFakeStore()
  seedReport(store)
  const { handler } = boot({ store })
  const url = api(`/reports/${encodeURIComponent(PERIOD_ID)}`)
  const first = await callApi(handler, { method: 'DELETE', url })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json, { deleted: true, reportId: PERIOD_ID })
  assertError(await callApi(handler, { method: 'DELETE', url }), 404, 'not-found')
})

/* --------------------------------------------------------- /reports/day-commits */

test('GET /reports/day-commits 返回当天提交页（含 repo 过滤参数透传）', async () => {
  const store = createFakeStore({
    commits: [
      {
        connection_id: 'c1',
        project_id: 1,
        commit_id: 'a1b2c3d4e5',
        authored_date: '2026-11-05 09:42:00',
        title: '修复订单导出',
        path_with_namespace: 'crm/order',
        repo_name: 'crm-order',
        additions: 12,
        deletions: 3,
        is_merge_commit: 0,
        is_cherry_pick_commit: 0,
      },
      {
        connection_id: 'c1',
        project_id: 2,
        commit_id: 'b2c3d4e5f6',
        authored_date: '2026-11-05 14:10:00',
        title: 'POS 打印修复',
        path_with_namespace: 'erp/pos',
        repo_name: 'erp-pos',
        additions: 4,
        deletions: 1,
        is_merge_commit: 1,
        is_cherry_pick_commit: 0,
      },
      {
        connection_id: 'c1',
        project_id: 1,
        commit_id: 'c3d4e5f6a7',
        authored_date: '2026-11-06 08:00:00',
        title: '次日提交',
        path_with_namespace: 'crm/order',
        repo_name: 'crm-order',
      },
    ],
  })
  const { handler } = boot({ store })
  const response = await callApi(handler, { url: api('/reports/day-commits?date=2026-11-05') })
  assert.equal(response.status, 200)
  assert.equal(response.json.date, '2026-11-05')
  assert.equal(response.json.repo, '')
  assert.equal(response.json.total, 2, '只统计当天（000-11-06 的提交不计入）')
  assert.equal(response.json.truncated, false)
  assert.deepEqual(response.json.commits[0], {
    time: '09:42',
    title: '修复订单导出',
    repo: 'crm/order',
    branch: '',
    additions: 12,
    deletions: 3,
    commitId: 'a1b2c3d4',
    merge: false,
    cherryPick: false,
  })
})

test('GET /reports/day-commits 支持 repo 过滤并透传给 domain', async () => {
  const store = createFakeStore({
    commits: [
      { connection_id: 'c1', project_id: 1, commit_id: 'a1', authored_date: '2026-11-05 09:42:00', title: 'a', path_with_namespace: 'crm/order' },
      { connection_id: 'c1', project_id: 2, commit_id: 'a2', authored_date: '2026-11-05 10:00:00', title: 'b', path_with_namespace: 'erp/pos' },
    ],
  })
  const { handler } = boot({ store })
  const response = await callApi(handler, {
    url: api('/reports/day-commits?date=2026-11-05&repo=crm'),
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.repo, 'crm')
  assert.equal(response.json.total, 1)
  assert.equal(response.json.commits[0].repo, 'crm/order')
})

test('GET /reports/day-commits 非法 date 返回 400 validation', async () => {
  const { handler } = boot()
  assertError(await callApi(handler, { url: api('/reports/day-commits') }), 400, 'validation')
  assertError(await callApi(handler, { url: api('/reports/day-commits?date=2026/11/05') }), 400, 'validation')
  assertError(
    await callApi(handler, { url: api('/reports/day-commits?date=20261105') }),
    400,
    'validation',
  )
})

test('GET /reports/day-commits 在 domain.dayCommits 缺失时返回 500 internal', async () => {
  const domain = { ...createFakeDomain() }
  delete domain.dayCommits
  const { handler } = boot({ domain })
  assertError(await callApi(handler, { url: api('/reports/day-commits?date=2026-11-05') }), 500, 'internal')
})

/* -------------------------------------------------------------- /line-stats */

test('GET /line-stats 返回实时分析并透传裁剪参数', async () => {
  const store = createFakeStore({
    commits: [
      {
        connection_id: 'c1',
        project_id: 1,
        commit_id: 'a1',
        authored_date: '2026-10-20 10:00:00',
        title: 'feat: a',
        is_merge_commit: 0,
        is_cherry_pick_commit: 0,
      },
    ],
  })
  const { handler } = boot({ store })
  const response = await callApi(handler, {
    url: api(
      `/line-stats?startDate=${PERIOD.startDate}&endDate=${PERIOD.endDate}&include=excludeMerge&fields=lineStats,summary&limit=5`,
    ),
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.range.startDate, PERIOD.startDate)
  assert.equal(response.json.summary.totalCommits, 1)
  assert.equal(response.json.view.include, 'excludeMerge')
  assert.deepEqual(response.json.view.fields, ['lineStats', 'summary'])
  assert.equal(response.json.view.limit, 5)
})

test('GET /line-stats 参数校验：格式与顺序', async () => {
  const { handler } = boot()
  assertError(await callApi(handler, { url: api('/line-stats') }), 400, 'validation')
  assertError(
    await callApi(handler, { url: api('/line-stats?startDate=2026-10-01&endDate=2026/10/07') }),
    400,
    'validation',
  )
  assertError(
    await callApi(handler, { url: api('/line-stats?startDate=2026-10-07&endDate=2026-10-01') }),
    400,
    'validation',
  )
})

/* ------------------------------------------------------- /gitlab/* 与连接 */

test('GET /gitlab/connections 未配置 baseUrl 时为空', async () => {
  const { handler } = boot()
  const response = await callApi(handler, { url: api('/gitlab/connections') })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { connections: [] })
})

test('GET /gitlab/connections 无表记录时从配置派生单连接（含 hasToken）', async () => {
  const baseUrl = 'https://gitlab.example.com'
  const { handler } = boot({
    config: { gitlab: { baseUrl, tokenRef: 'ref' }, timezone: 'UTC' },
    token: 'tkn',
  })
  const response = await callApi(handler, { url: api('/gitlab/connections') })
  assert.equal(response.json.connections.length, 1)
  assert.deepEqual(response.json.connections[0], {
    id: deriveConnectionId(baseUrl),
    baseUrl,
    displayName: baseUrl,
    username: '',
    hasToken: true,
  })
})

test('POST /gitlab/connections 有 token：校验 /user 后幂等 upsert', async () => {
  const baseUrl = 'https://gitlab.example.com'
  const gitlab = createGitLabFactory()
  const store = createFakeStore()
  const { handler, calls } = boot({ store, gitlab, config: {} })
  const body = { baseUrl: `${baseUrl}/`, token: 'good-token', displayName: '公司 GitLab' }

  const first = await callApi(handler, { method: 'POST', url: api('/gitlab/connections'), body })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json, {
    connection: { id: deriveConnectionId(baseUrl), baseUrl, username: 'tester', hasToken: true },
  })
  assert.equal(store.state.connectionUpserts.length, 1)
  assert.deepEqual(store.state.connectionUpserts[0], {
    connectionId: deriveConnectionId(baseUrl),
    baseUrl,
    displayName: '公司 GitLab',
    username: 'tester',
  })
  assert.deepEqual(calls.saveToken, ['good-token'])

  // 幂等：同一 baseUrl 再 POST 一次仍是同一条记录、同一条 token 写入轨迹
  const second = await callApi(handler, { method: 'POST', url: api('/gitlab/connections'), body })
  assert.equal(second.status, 200)
  assert.equal(store.state.connectionUpserts.length, 2)
  assert.equal(store.state.connectionUpserts[1].connectionId, store.state.connectionUpserts[0].connectionId)
  assert.equal(store.state.connections.size, 1)

  // 写入后 GET 列表应读到 connections 表
  const listed = await callApi(handler, { url: api('/gitlab/connections') })
  assert.equal(listed.json.connections.length, 1)
  assert.equal(listed.json.connections[0].username, 'tester')
  assert.equal(listed.json.connections[0].hasToken, true)
})

test('POST /gitlab/connections /user 校验失败返回 400 且不写库', async () => {
  const store = createFakeStore()
  const { handler, calls } = boot({ store, gitlab: createGitLabFactory(), config: {} })
  const response = await callApi(handler, {
    method: 'POST',
    url: api('/gitlab/connections'),
    body: { baseUrl: 'https://gitlab.example.com', token: 'bad-token' },
  })
  assertError(response, 400, 'validation')
  assert.match(response.json.message, /\/user/)
  assert.equal(store.state.connectionUpserts.length, 0)
  assert.deepEqual(calls.saveToken, [])
})

test('POST /gitlab/connections 无 token：只回读已有记录，hasToken=false', async () => {
  const baseUrl = 'https://gitlab.example.com'
  const connectionId = deriveConnectionId(baseUrl)
  const store = createFakeStore()
  store.state.connections.set(connectionId, {
    connection_id: connectionId,
    base_url: baseUrl,
    display_name: '公司 GitLab',
    username: 'tester',
  })
  const { handler, calls } = boot({ store, config: {} })
  const response = await callApi(handler, {
    method: 'POST',
    url: api('/gitlab/connections'),
    body: { baseUrl },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, {
    connection: { id: connectionId, baseUrl, username: 'tester', hasToken: false },
  })
  assert.equal(store.state.connectionUpserts.length, 0, '无 token 分支不得写库')
  assert.deepEqual(calls.saveToken, [])
})

test('POST /gitlab/connections 校验 baseUrl', async () => {
  const { handler } = boot()
  assertError(await callApi(handler, { method: 'POST', url: api('/gitlab/connections'), body: {} }), 400, 'validation')
  assertError(
    await callApi(handler, {
      method: 'POST',
      url: api('/gitlab/connections'),
      body: { baseUrl: 'ftp://gitlab' },
    }),
    400,
    'validation',
  )
})

test('GET /gitlab/projects 映射候选项目', async () => {
  const syncService = createFakeSync({
    candidates: [
      { connection_id: 'c1', project_id: 7, path_with_namespace: 'team/erp-pos', name: 'erp-pos', namespace: 'team' },
    ],
  })
  const { handler } = boot({ syncService })
  const response = await callApi(handler, { url: api('/gitlab/projects?connectionId=c1&q=erp') })
  assert.equal(response.status, 200)
  assert.equal(response.json.projects.length, 1)
  assert.deepEqual(response.json.projects[0], {
    id: 7,
    pathWithNamespace: 'team/erp-pos',
    name: 'erp-pos',
    namespace: 'team',
  })
})

test('GET/PUT /gitlab/selection 读写已选项目', async () => {
  const syncService = createFakeSync({
    selection: [{ connection_id: 'c1', project_id: 3, path_with_namespace: 'team/a', name: 'a', enabled: 1 }],
  })
  const { handler } = boot({ syncService })
  const before = await callApi(handler, { url: api('/gitlab/selection?connectionId=c1') })
  assert.deepEqual(before.json.projects, [{ id: 3, pathWithNamespace: 'team/a', name: 'a', enabled: 1 }])

  const saved = await callApi(handler, {
    method: 'PUT',
    url: api('/gitlab/selection'),
    body: { connectionId: 'c1', projects: [{ id: 4, pathWithNamespace: 'team/b', name: 'b' }] },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.json, { saved: true, count: 1 })
  assert.equal(syncService.state.savedCalls[0].projects[0].projectId, 4)
})

test('PUT /gitlab/selection 校验 projects', async () => {
  const { handler } = boot()
  assertError(
    await callApi(handler, { method: 'PUT', url: api('/gitlab/selection'), body: { connectionId: 'c1' } }),
    400,
    'validation',
  )
  assertError(
    await callApi(handler, {
      method: 'PUT',
      url: api('/gitlab/selection'),
      body: { connectionId: 'c1', projects: [{ id: 0 }] },
    }),
    400,
    'validation',
  )
})

/* ------------------------------------------------------------------- /sync */

test('GET /sync/coverage 兼容映射：追加约定键且保留 sync.js 原字段', async () => {
  const { handler } = boot()
  const response = await callApi(handler, {
    url: api(`/sync/coverage?connectionId=c1&startDate=${PERIOD.startDate}&endDate=${PERIOD.endDate}`),
  })
  assert.equal(response.status, 200)
  // 约定键（CONTRACTS §5.1）
  assert.deepEqual(response.json.summary, {
    // 原字段（保持不变）
    repoCount: 2,
    commitCount: 9,
    activeDayCount: 4,
    // 追加的约定键
    commits: 9,
    days: 4,
    repos: 2,
    additions: 0,
    deletions: 0,
  })
  assert.equal(response.json.repos[0].repoKey, 'team/erp-pos')
  assert.equal(response.json.repos[0].commitCount, 9)
  assert.equal(response.json.repos[0].additions, 0, 'coverage 行没有统计时给 0')
  assert.equal(response.json.repos[0].deletions, 0)
  assert.equal(response.json.repos[0].pathWithNamespace, 'team/erp-pos', '原字段必须保留')
  assert.deepEqual(response.json.repos[0].contributionDays, [{ date: '2026-10-20', count: 9 }])
  assert.equal(response.json.dateDistribution[0].commitCount, 9)
  assert.equal(response.json.connectionId, 'c1', 'coverage 的其它原字段原样保留')
})

test('GET /sync/coverage 已有 additions/deletions 时取原值；repoKey 缺路径时回退 projectId', async () => {
  const syncService = {
    async coverage() {
      return {
        connectionId: 'c1',
        range: { startDate: PERIOD.startDate, endDate: PERIOD.endDate },
        summary: { repoCount: 1, commitCount: 5, activeDayCount: 2, additions: 120, deletions: 30 },
        repos: [
          { projectId: 42, commitCount: 5, additions: 120, deletions: 30 },
          { projectId: 7, pathWithNamespace: 'team/erp-pos', commitCount: 2 },
        ],
        dateDistribution: [{ date: '2026-10-20', count: 5 }],
      }
    },
  }
  const { handler } = boot({ syncService })
  const response = await callApi(handler, { url: api('/sync/coverage') })
  assert.equal(response.status, 200)
  assert.equal(response.json.summary.additions, 120)
  assert.equal(response.json.summary.deletions, 30)
  assert.equal(response.json.summary.commits, 5)
  assert.equal(response.json.repos[0].repoKey, '42', '无 pathWithNamespace 时用 projectId 兜底')
  assert.equal(response.json.repos[1].repoKey, 'team/erp-pos')
  assert.deepEqual(response.json.range, { startDate: PERIOD.startDate, endDate: PERIOD.endDate })
})

test('GET /sync/coverage 日期倒置返回 400', async () => {
  const { handler } = boot()
  assertError(
    await callApi(handler, { url: api('/sync/coverage?startDate=2026-10-07&endDate=2026-10-01') }),
    400,
    'validation',
  )
})

test('GET /sync/jobs 投影 progress 与 scope 窗口（CONTRACTS §5.3.1）', async () => {
  const { handler } = boot({
    store: createFakeStore({
      jobs: [
        {
          job_id: 'job-1',
          connection_id: 'c1',
          status: 'running',
          started_at: '2026-10-27 10:00:00',
          finished_at: null,
          progress_json: JSON.stringify({
            totalProjects: 3,
            syncedProjects: 1,
            commitsSynced: 12,
            currentProject: 'team/erp-pos',
            incompleteProjects: 1,
            errors: 2,
          }),
          scope_json: JSON.stringify({ startDate: PERIOD.startDate, endDate: PERIOD.endDate, projects: [] }),
          error: null,
        },
      ],
    }),
  })
  const response = await callApi(handler, { url: api('/sync/jobs?limit=10') })
  assert.equal(response.status, 200)
  assert.equal(response.json.jobs.length, 1)
  const job = response.json.jobs[0]
  assert.equal(job.jobId, 'job-1')
  assert.equal(job.connectionId, 'c1')
  assert.equal(job.startDate, PERIOD.startDate)
  assert.equal(job.endDate, PERIOD.endDate)
  assert.deepEqual(job.progress, {
    projectsDone: 1,
    projectsTotal: 3,
    commitsSynced: 12,
    currentProject: 'team/erp-pos',
    partial: true,
    errors: 2,
  })
  assert.equal(job.error, null)
})

test('GET /sync/jobs 在 scope_json 缺失/损坏时省略日期字段而不报错', async () => {
  const { handler } = boot({
    store: createFakeStore({
      jobs: [
        { job_id: 'job-1', connection_id: 'c1', status: 'completed', progress_json: 'not-json', scope_json: '{oops' },
      ],
    }),
  })
  const response = await callApi(handler, { url: api('/sync/jobs') })
  assert.equal(response.status, 200)
  const job = response.json.jobs[0]
  assert.equal(job.startDate, undefined)
  assert.equal(job.endDate, undefined)
  assert.deepEqual(job.progress, { projectsDone: 0, projectsTotal: 0, commitsSynced: 0 })
  assert.equal('partial' in job.progress, false, '无值时不输出 partial')
  assert.equal('errors' in job.progress, false, '无值时不输出 errors')
})

test('GET /sync/jobs 的 partial 可由 incompleteProjects 推导、errors 可由错误明细条数推导', async () => {
  const { handler } = boot({
    store: createFakeStore({
      jobs: [
        {
          job_id: 'job-1',
          connection_id: 'c1',
          status: 'failed',
          progress_json: JSON.stringify({ totalProjects: 2, syncedProjects: 2, incompleteProjects: 0 }),
          scope_json: JSON.stringify({ startDate: '2026-11-01', endDate: '2026-11-02' }),
        },
        {
          job_id: 'job-2',
          connection_id: 'c1',
          status: 'failed',
          progress: { totalProjects: 1, syncedProjects: 1 },
          scope: { startDate: '2026-11-03', endDate: '2026-11-04' },
          errors: [{ stage: 'project_sync', message: 'boom' }],
          error: 'failed',
        },
      ],
    }),
  })
  const response = await callApi(handler, { url: api('/sync/jobs') })
  const [first, second] = response.json.jobs
  assert.equal(first.progress.partial, false, 'incompleteProjects=0 应推导出 partial=false')
  assert.equal('errors' in first.progress, false)
  assert.equal(second.progress.partial, undefined)
  assert.equal(second.progress.errors, 1, 'job 错误明细条数应投影成 errors')
})

test('POST /sync/start 转发到 syncService 并返回 jobId', async () => {
  const syncService = createFakeSync()
  const { handler } = boot({ syncService })
  const response = await callApi(handler, {
    method: 'POST',
    url: api('/sync/start'),
    body: { connectionId: 'c1', startDate: PERIOD.startDate, endDate: PERIOD.endDate, projectIds: [1] },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.jobId, 'job-1')
  assert.deepEqual(syncService.state.startCalls[0], {
    connectionId: 'c1',
    startDate: PERIOD.startDate,
    endDate: PERIOD.endDate,
    projectIds: [1],
  })
})

test('POST /sync/start 日期校验', async () => {
  const { handler } = boot()
  assertError(await callApi(handler, { method: 'POST', url: api('/sync/start'), body: {} }), 400, 'validation')
  assertError(
    await callApi(handler, {
      method: 'POST',
      url: api('/sync/start'),
      body: { startDate: '2026-10-07', endDate: '2026-10-01' },
    }),
    400,
    'validation',
  )
  assertError(
    await callApi(handler, {
      method: 'POST',
      url: api('/sync/start'),
      body: { startDate: PERIOD.startDate, endDate: PERIOD.endDate, projectIds: 'nope' },
    }),
    400,
    'validation',
  )
})

test('POST /sync/cancel 转发取消并校验 jobId', async () => {
  const syncService = createFakeSync({ jobs: [{ job_id: 'job-1', status: 'running' }] })
  const { handler } = boot({ syncService })
  const response = await callApi(handler, {
    method: 'POST',
    url: api('/sync/cancel'),
    body: { jobId: 'job-1' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { cancelled: true, jobId: 'job-1' })
  assert.deepEqual(syncService.state.cancelCalls, ['job-1'])
  assertError(await callApi(handler, { method: 'POST', url: api('/sync/cancel'), body: {} }), 400, 'validation')
})

/* -------------------------------------------------------------- /templates */

test('GET /templates 返回 domain 默认模板与指引', async () => {
  const { handler } = boot()
  const response = await callApi(handler, { url: api('/templates') })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.templates, {
    week: 'WEEK-TPL',
    month: 'MONTH-TPL',
    quarter: 'QUARTER-TPL',
    year: 'YEAR-TPL',
  })
  assert.equal(response.json.guidance.week, 'WEEK-GUIDE')
})

test('PUT /templates 部分更新：只改出现的键，并返回生效后的完整模板', async () => {
  const { handler, calls } = boot({ config: { templates: { month: 'CUSTOM-M' }, guidance: {} } })
  const response = await callApi(handler, {
    method: 'PUT',
    url: api('/templates'),
    body: { templates: { week: 'CUSTOM-W' } },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, {
    templates: { week: 'CUSTOM-W', month: 'CUSTOM-M', quarter: 'QUARTER-TPL', year: 'YEAR-TPL' },
    guidance: { week: 'WEEK-GUIDE', month: 'MONTH-GUIDE', quarter: 'QUARTER-GUIDE', year: 'YEAR-GUIDE' },
  })
  const patch = calls.updateConfig[0]
  assert.deepEqual(patch.templates, { month: 'CUSTOM-M', week: 'CUSTOM-W' }, '只写覆盖值，不写展开后的默认值')
})

test('PUT /templates 空字符串清除覆盖并回退内置默认', async () => {
  const { handler, calls } = boot({
    config: { templates: { week: 'CUSTOM-W', month: 'CUSTOM-M' }, guidance: {} },
  })
  const response = await callApi(handler, {
    method: 'PUT',
    url: api('/templates'),
    body: { templates: { week: '' } },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.templates.week, 'WEEK-TPL', '清除覆盖后应回退 domain 默认模板')
  assert.equal(response.json.templates.month, 'CUSTOM-M', '未出现的键保持原覆盖')
  assert.deepEqual(calls.updateConfig[0].templates, { month: 'CUSTOM-M' })
})

test('PUT /templates 校验空请求与类型', async () => {
  const { handler } = boot()
  assertError(await callApi(handler, { method: 'PUT', url: api('/templates'), body: {} }), 400, 'validation')
  assertError(
    await callApi(handler, { method: 'PUT', url: api('/templates'), body: { templates: { week: 1 } } }),
    400,
    'validation',
  )
})

/* ------------------------------------------------------- /reports/generate */

test('POST /reports/generate 通过注入的 createReportSession 建会话', async () => {
  const created = []
  const { handler } = boot({
    createReportSession: async (input) => {
      created.push(input)
      return { sessionId: 'sess-1' }
    },
  })
  const response = await callApi(handler, {
    method: 'POST',
    url: api('/reports/generate'),
    body: { ...PERIOD, guidance: '重点写支付' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { reportId: PERIOD_ID, sessionId: 'sess-1' })
  assert.deepEqual(created[0], {
    type: PERIOD.type,
    startDate: PERIOD.startDate,
    endDate: PERIOD.endDate,
    period: `${PERIOD.startDate} 至 ${PERIOD.endDate}`,
    guidance: '重点写支付',
  })
})

test('POST /reports/generate 未注入会话端口返回 500 internal；参数非法 400', async () => {
  const { handler } = boot()
  assertError(
    await callApi(handler, { method: 'POST', url: api('/reports/generate'), body: { ...PERIOD } }),
    500,
    'internal',
  )
  assertError(
    await callApi(handler, { method: 'POST', url: api('/reports/generate'), body: { startDate: '2026-10-20' } }),
    400,
    'validation',
  )
})

/* ----------------------------------------------------------- 路由与错误信封 */

test('未知路径返回 404 信封', async () => {
  const { handler } = boot()
  assertError(await callApi(handler, { url: api('/nope') }), 404, 'not-found')
  assertError(await callApi(handler, { url: '/api/other' }), 404, 'not-found')
})

test('方法不匹配返回 405', async () => {
  const { handler } = boot()
  const response = await callApi(handler, { method: 'POST', url: api('/reports'), body: {} })
  assertError(response, 405, 'method-not-allowed')
})

test('依赖缺失时错误信封为 500 internal（不抛未捕获异常）', async () => {
  const handler = createApiHandler({})
  const response = await callApi(handler, { url: api('/reports') })
  assertError(response, 500, 'internal')
})

test('导出路径不被 JSON 信封覆盖（headers 已发出后不再写第二次）', async () => {
  const store = createFakeStore()
  seedReport(store)
  const { handler } = boot({ store })
  const res = makeRes()
  await handler({ method: 'GET', url: api(`/reports/${encodeURIComponent(PERIOD_ID)}/export`) }, res)
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/markdown/)
  assert.doesNotMatch(res.body, /^\{"error"/)
})

/* ------------------------------------------------------- 多 GitLab 连接 */

test('多连接：GET /gitlab/connections 每行 hasToken 按连接解析', async () => {
  const store = createFakeStore()
  store.state.connections.set('conn-a', {
    connection_id: 'conn-a',
    base_url: 'https://a.example.com',
    display_name: 'A',
    username: 'user-a',
  })
  store.state.connections.set('conn-b', {
    connection_id: 'conn-b',
    base_url: 'https://b.example.com',
    display_name: 'B',
    username: 'user-b',
  })
  const { handler } = boot({
    store,
    deps: {
      resolveToken: async (options) => (options && options.connectionId === 'conn-b' ? 'token-b' : null),
    },
  })
  const response = await callApi(handler, { url: api('/gitlab/connections') })
  assert.equal(response.status, 200)
  const byId = Object.fromEntries(response.json.connections.map((item) => [item.id, item]))
  assert.equal(byId['conn-a'].hasToken, false)
  assert.equal(byId['conn-b'].hasToken, true)
})

test('多连接：POST /gitlab/connections 把 token 保存到对应 connectionId', async () => {
  const baseUrl = 'https://gitlab.example.com'
  const gitlab = createGitLabFactory()
  const store = createFakeStore()
  const saved = []
  const { handler } = boot({
    store,
    gitlab,
    deps: {
      saveToken: async (token, connectionId) => {
        saved.push({ token, connectionId })
      },
    },
  })
  const response = await callApi(handler, {
    method: 'POST',
    url: api('/gitlab/connections'),
    body: { baseUrl, token: 'good-token' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(saved, [{ token: 'good-token', connectionId: deriveConnectionId(baseUrl) }])
})

test('多连接：DELETE /gitlab/connections/:id 转发到 connections.remove', async () => {
  const removed = []
  const { handler } = boot({
    connections: {
      list: async () => [],
      create: async () => ({}),
      remove: async (id) => {
        removed.push(id)
        return { removed: true }
      },
    },
  })
  const response = await callApi(handler, { method: 'DELETE', url: api('/gitlab/connections/conn-b') })
  assert.equal(response.status, 200)
  assert.deepEqual(removed, ['conn-b'])
})

test('多连接：DELETE /gitlab/token?connectionId= 只清对应连接', async () => {
  const cleared = []
  const { handler } = boot({
    deps: {
      clearToken: async (connectionId) => {
        cleared.push(connectionId)
      },
    },
  })
  const response = await callApi(handler, { method: 'DELETE', url: api('/gitlab/token?connectionId=conn-b') })
  assert.equal(response.status, 200)
  assert.deepEqual(cleared, ['conn-b'])
})
