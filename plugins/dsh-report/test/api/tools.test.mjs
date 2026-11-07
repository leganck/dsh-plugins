/**
 * lib/tools.js 契约测试：9 个 Agent 工具
 *
 * 覆盖：注册集合 / schema / required / 并发安全标记；9 个工具的成功路径与关键错误路径
 * （周期校验、分页 hint、32k 截断、同周期覆盖、删除 404、7 个 sync action）。
 *
 * 依赖全部为 test/api/helpers.mjs 的测试替身，不触碰 SQLite / GitLab / 网络。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ReportError, registerTools, toolCatalog } from '../../lib/tools.js'
import {
  PERIOD,
  PERIOD_ID,
  createFakeCtx,
  createFakeDomain,
  createFakeHandle,
  createFakeStore,
  createFakeSync,
  makeCommitRows,
  makeDeps,
  makeSpecialCommitRows,
  seedReport,
} from './helpers.mjs'

/** 与 workbench Go 版一致的 9 个工具名（顺序无关）。 */
const EXPECTED_TOOLS = [
  'report_brief',
  'report_commits',
  'report_stats',
  'report_update',
  'report_list',
  'report_get',
  'report_export',
  'report_delete',
  'report_sync',
]

/** 各工具 required（对齐 Go `Meta.Required`）。 */
const EXPECTED_REQUIRED = {
  report_brief: ['startDate', 'endDate'],
  report_commits: ['startDate', 'endDate'],
  report_stats: undefined,
  report_update: ['type', 'startDate', 'endDate', 'content'],
  report_list: undefined,
  report_get: ['reportId'],
  report_export: ['reportId'],
  report_delete: ['reportId'],
  report_sync: undefined,
}

/** 写工具（其余为只读）。 */
const WRITE_TOOLS = new Set(['report_update', 'report_delete', 'report_sync'])

/** 注册工具并返回 name → definition 的 Map。 */
function bootTools(overrides = {}) {
  const ctx = createFakeCtx()
  const built = makeDeps(overrides)
  const dispose = registerTools(ctx, built.deps)
  return { ctx, dispose, ...built }
}

/** 执行一个工具，返回其 `{ content, structuredContent }` 结果。 */
async function runTool(name, args, overrides = {}) {
  const { ctx } = bootTools(overrides)
  const definition = ctx.registered.get(name)
  assert.ok(definition, `工具未注册：${name}`)
  return definition.execute(args)
}

/** 断言工具以指定错误码失败。 */
async function expectToolError(name, args, code, overrides = {}) {
  const { ctx } = bootTools(overrides)
  const definition = ctx.registered.get(name)
  await assert.rejects(
    () => definition.execute(args),
    (error) => {
      assert.ok(error instanceof ReportError, `期望 ReportError，实际 ${error?.name}`)
      assert.equal(error.code, code)
      return true
    },
  )
}

/* ------------------------------------------------------------ 注册与 schema */

test('registerTools 注册 9 个工具，名称与 Go 版一致', () => {
  const { ctx, dispose } = bootTools()
  assert.deepEqual([...ctx.registered.keys()].sort(), [...EXPECTED_TOOLS].sort())
  dispose()
  assert.equal(ctx.registered.size, 0, 'disposer 需要移除全部工具')
})

test('每个工具都有 object schema、非空描述与 render', () => {
  const { ctx } = bootTools()
  for (const [name, definition] of ctx.registered) {
    assert.equal(typeof definition.description, 'string', `${name} 缺少 description`)
    assert.ok(definition.description.length > 10, `${name} description 过短`)
    assert.equal(definition.parameters?.type, 'object', `${name} parameters 必须是 object`)
    assert.equal(typeof definition.output?.render, 'function', `${name} 缺少 output.render`)
    assert.equal(typeof definition.execute, 'function', `${name} 缺少 execute`)
  }
})

test('required 与 Go 版一致（report_stats / report_list / report_sync 无必填）', () => {
  const catalog = new Map(toolCatalog().map((item) => [item.name, item]))
  assert.equal(catalog.size, 9)
  for (const [name, required] of Object.entries(EXPECTED_REQUIRED)) {
    const entry = catalog.get(name)
    assert.ok(entry, `toolCatalog 缺少 ${name}`)
    assert.deepEqual(entry.parameters.required, required, `${name}.required 不一致`)
  }
})

test('report_brief / report_commits 的 type 枚举为四种报告类型', () => {
  const catalog = new Map(toolCatalog().map((item) => [item.name, item]))
  for (const name of ['report_brief', 'report_commits']) {
    assert.deepEqual(catalog.get(name).parameters.properties.type.enum, ['week', 'month', 'quarter', 'year'])
  }
  assert.deepEqual(catalog.get('report_sync').parameters.properties.action.enum, [
    'coverage',
    'get_selection',
    'list_candidates',
    'save_selection',
    'status',
    'start',
    'cancel',
  ])
})

test('并发安全标记：只读 true，写工具 false', () => {
  const { ctx } = bootTools()
  for (const [name, definition] of ctx.registered) {
    assert.equal(definition.isConcurrencySafe(), !WRITE_TOOLS.has(name), `${name} 并发标记不一致`)
  }
})

test('缺少 ctx.tools.register 时给出明确错误', () => {
  assert.throws(() => registerTools({}, {}), /ctx\.tools\.register/)
})

/* ------------------------------------------------------------- report_brief */

test('report_brief 返回模板/指引/hostInstructions，并渲染为可读文本', async () => {
  const result = await runTool('report_brief', { startDate: PERIOD.startDate, endDate: PERIOD.endDate })
  const brief = result.structuredContent
  assert.equal(brief.reportType, 'week')
  assert.equal(brief.startDate, PERIOD.startDate)
  assert.equal(brief.period, `${PERIOD.startDate} 至 ${PERIOD.endDate}`)
  assert.equal(brief.template, 'WEEK-TPL')
  assert.equal(brief.guidance, 'WEEK-GUIDE')
  assert.equal(brief.hostInstructions, 'HOST-INS')
  const text = result.content[0].text
  assert.match(text, /WEEK-TPL/)
  assert.match(text, /HOST-INS/)
})

test('report_brief 优先使用配置里的模板与指引', async () => {
  const result = await runTool(
    'report_brief',
    { startDate: PERIOD.startDate, endDate: PERIOD.endDate },
    { config: { templates: { week: 'CUSTOM-TPL' }, guidance: { week: 'CUSTOM-GUIDE' } } },
  )
  assert.equal(result.structuredContent.template, 'CUSTOM-TPL')
  assert.equal(result.structuredContent.guidance, 'CUSTOM-GUIDE')
})

test('report_brief 周期校验：缺日期 / 非法格式 / 起止倒置 / 非法类型', async () => {
  await expectToolError('report_brief', {}, 'VALIDATION')
  await expectToolError('report_brief', { startDate: '2026/10/20', endDate: PERIOD.endDate }, 'VALIDATION')
  await expectToolError(
    'report_brief',
    { startDate: PERIOD.endDate, endDate: PERIOD.startDate },
    'VALIDATION',
  )
  await expectToolError(
    'report_brief',
    { type: 'day', startDate: PERIOD.startDate, endDate: PERIOD.endDate },
    'VALIDATION',
  )
})

/* ----------------------------------------------------------- report_commits */

test('report_commits 默认排除 merge / cherry-pick，并给出下一页 hint', async () => {
  const commits = [...makeCommitRows(5), ...makeSpecialCommitRows()]
  const store = createFakeStore({ commits })
  const result = await runTool(
    'report_commits',
    { startDate: PERIOD.startDate, endDate: PERIOD.endDate, limit: 2 },
    { store },
  )
  const page = result.structuredContent
  assert.equal(page.total, 5, '默认应排除 merge 与 cherry-pick')
  assert.equal(page.count, 2)
  assert.equal(page.hasMore, true)
  assert.equal(page.nextOffset, 2)
  assert.equal(page.truncated, true)
  assert.equal(
    page.hint,
    'More commits remain. Call report_commits again with the same period and offset=nextOffset (optionally repo=...) until hasMore is false.',
  )
})

test('report_commits 的 include_merge 别名可用，且末页无 hasMore', async () => {
  const commits = [...makeCommitRows(3), ...makeSpecialCommitRows()]
  const store = createFakeStore({ commits })
  const result = await runTool(
    'report_commits',
    { startDate: PERIOD.startDate, endDate: PERIOD.endDate, include_merge: true, limit: 80 },
    { store },
  )
  assert.equal(result.structuredContent.includeMerge, true)
  assert.equal(result.structuredContent.total, 5)
  assert.equal(result.structuredContent.hasMore, false)
  assert.equal(
    result.structuredContent.hint,
    'Page complete. For large repos, pass repo=<path or name substring> to inspect one repository at a time.',
  )
})

test('report_commits 的 repo 过滤与瘦身投影（不泄漏完整 message）', async () => {
  const commits = [
    ...makeCommitRows(2, { path_with_namespace: 'team/erp-pos', repo_name: 'erp-pos' }),
    ...makeCommitRows(2, { path_with_namespace: 'team/crm-order', repo_name: 'crm-order', commit_id: 'crm1' }),
  ]
  const store = createFakeStore({ commits })
  const result = await runTool(
    'report_commits',
    { startDate: PERIOD.startDate, endDate: PERIOD.endDate, repo: 'crm' },
    { store },
  )
  assert.equal(result.structuredContent.total, 2)
  assert.ok(result.structuredContent.commits.every((commit) => commit.repo.includes('crm')))
  assert.doesNotMatch(JSON.stringify(result.structuredContent), /secret body/)
})

test('domain 自带 hint 时不被覆盖', async () => {
  const commits = makeCommitRows(1)
  const store = createFakeStore({ commits })
  const domain = createFakeDomain({
    gatherCommits: () => ({ total: 1, count: 1, hasMore: false, hint: 'DOMAIN-HINT', commits: [] }),
  })
  const result = await runTool(
    'report_commits',
    { startDate: PERIOD.startDate, endDate: PERIOD.endDate },
    { store, domain },
  )
  assert.equal(result.structuredContent.hint, 'DOMAIN-HINT')
})

/* ------------------------------------------------------------- report_stats */

test('report_stats（reportId）返回已存统计，含 cherryPickCommitCount', async () => {
  const store = createFakeStore()
  seedReport(store)
  const result = await runTool('report_stats', { reportId: PERIOD_ID }, { store })
  const payload = result.structuredContent
  assert.equal(payload.report.cherryPickCommitCount, 1)
  assert.equal(payload.report.totalCommits, 12)
  assert.equal(payload.lineStats.length, 2)
  assert.equal(payload.repoBranchStats[0].repoKey, 'team/erp-pos')
})

test('report_stats（reportId）不存在时报 NOT_FOUND', async () => {
  await expectToolError('report_stats', { reportId: 'week:2026-01-01:2026-01-07' }, 'NOT_FOUND')
})

test('report_stats（周期）返回实时分析', async () => {
  const store = createFakeStore({ commits: makeCommitRows(4) })
  const result = await runTool('report_stats', { ...PERIOD }, { store })
  assert.equal(result.structuredContent.range.startDate, PERIOD.startDate)
  assert.equal(result.structuredContent.summary.totalCommits, 4)
})

test('report_stats 既无 reportId 也无合法周期时校验失败', async () => {
  await expectToolError('report_stats', {}, 'VALIDATION')
})

/* ------------------------------------------------------------ report_update */

test('report_update 保存并返回 reportId / hint / 统计', async () => {
  const result = await runTool('report_update', { ...PERIOD, content: '# 周报\n内容' })
  const payload = result.structuredContent
  assert.equal(payload.reportId, PERIOD_ID)
  assert.equal(payload.saved, true)
  assert.equal(payload.status, 'generated')
  assert.equal(
    payload.hint,
    'Report saved. Reply with a short summary only; do not call report_export or paste the full Markdown into chat.',
  )
  assert.equal(payload.report.stats.totalCommits, 12)
  assert.equal(payload.report.content, '# 周报\n内容')
})

test('report_update 同周期重复保存得到同一 reportId（覆盖语义）', async () => {
  const first = await runTool('report_update', { ...PERIOD, content: 'v1' })
  const second = await runTool('report_update', { ...PERIOD, content: 'v2' })
  assert.equal(first.structuredContent.reportId, second.structuredContent.reportId)
})

test('report_update 校验：type 必填 / content 必填', async () => {
  await expectToolError(
    'report_update',
    { startDate: PERIOD.startDate, endDate: PERIOD.endDate, content: 'x' },
    'VALIDATION',
  )
  await expectToolError('report_update', { ...PERIOD }, 'VALIDATION')
  await expectToolError('report_update', { ...PERIOD, content: '   ' }, 'VALIDATION')
})

/* -------------------------------------------------------------- report_list */

test('report_list 返回 camelCase 列表并按 periodEnd 倒序', async () => {
  const store = createFakeStore()
  seedReport(store, { id: 'week:2026-10-13:2026-10-19', row: { period_start: '2026-10-13', period_end: '2026-10-19' } })
  seedReport(store)
  const result = await runTool('report_list', {}, { store })
  const reports = result.structuredContent.reports
  assert.equal(reports.length, 2)
  assert.equal(reports[0].id, PERIOD_ID)
  assert.equal(reports[0].periodStart, '2026-10-20')
  assert.equal(reports[0].totalCommits, 12)
  assert.deepEqual(Object.keys(reports[0]).sort(), [
    'generatedAt',
    'id',
    'periodEnd',
    'periodStart',
    'status',
    'totalCommits',
    'type',
  ])
})

test('report_list 在 store 无聚合读取器时回退到 report_aggregates 查询', async () => {
  const store = createFakeStore({ withAggregateReader: false })
  seedReport(store)
  const handle = createFakeHandle({ [PERIOD_ID]: { totalCommits: 7 } })
  const result = await runTool('report_list', {}, { store, handle })
  assert.equal(result.structuredContent.reports[0].totalCommits, 7)
})

/* --------------------------------------------------------------- report_get */

test('report_get 返回正文与 camelCase topics', async () => {
  const store = createFakeStore()
  seedReport(store)
  const result = await runTool('report_get', { reportId: PERIOD_ID }, { store })
  const { report, topics } = result.structuredContent
  assert.match(report.content, /支付链路联调/)
  assert.equal(report.typeLabel, '周报')
  assert.equal(topics.length, 1)
  assert.deepEqual(topics[0], {
    domain: 'ERP-POS',
    topicTitle: '支付联调',
    summary: '联调通过',
    sortOrder: 1,
  })
})

test('report_get 支持 report_id 别名；缺参/不存在分别校验', async () => {
  const store = createFakeStore()
  seedReport(store)
  const result = await runTool('report_get', { report_id: PERIOD_ID }, { store })
  assert.equal(result.structuredContent.report.id, PERIOD_ID)
  await expectToolError('report_get', {}, 'VALIDATION', { store })
  await expectToolError('report_get', { reportId: 'nope' }, 'NOT_FOUND', { store })
})

/* ------------------------------------------------------------ report_export */

test('report_export 截断到 32000 字符并标记 truncated', async () => {
  const store = createFakeStore()
  seedReport(store, { row: { content: 'x'.repeat(40000) } })
  const result = await runTool('report_export', { reportId: PERIOD_ID }, { store })
  const payload = result.structuredContent
  assert.equal(payload.truncated, true)
  assert.equal(payload.content.length, 32000 + '\n[truncated]'.length)
  assert.ok(payload.content.endsWith('[truncated]'))
  assert.equal(payload.format, 'markdown')
  assert.equal(payload.filename, 'week-2026-10-20-2026-10-26.md')
  assert.equal(result.content[0].text, payload.content, 'render 文本应是 Markdown 正文')
})

test('report_export 短正文不截断', async () => {
  const store = createFakeStore()
  seedReport(store)
  const result = await runTool('report_export', { reportId: PERIOD_ID }, { store })
  assert.equal(result.structuredContent.truncated, false)
})

test('report_export 空正文与不存在分别报错', async () => {
  const store = createFakeStore()
  seedReport(store, { row: { content: '' } })
  await expectToolError('report_export', { reportId: PERIOD_ID }, 'VALIDATION', { store })
  await expectToolError('report_export', { reportId: 'nope' }, 'NOT_FOUND', { store })
})

/* ------------------------------------------------------------ report_delete */

test('report_delete 删除成功，第二次报 NOT_FOUND', async () => {
  const store = createFakeStore()
  seedReport(store)
  const result = await runTool('report_delete', { reportId: PERIOD_ID }, { store })
  assert.deepEqual(result.structuredContent, { deleted: true, reportId: PERIOD_ID })
  assert.deepEqual(store.state.deleteCalls, [PERIOD_ID])
  await expectToolError('report_delete', { reportId: PERIOD_ID }, 'NOT_FOUND', { store })
})

/* -------------------------------------------------------------- report_sync */

test('report_sync coverage 返回覆盖度', async () => {
  const result = await runTool('report_sync', { action: 'coverage' })
  assert.equal(result.structuredContent.action, 'coverage')
  assert.equal(result.structuredContent.coverage.summary.commitCount, 9)
})

test('report_sync get_selection 按 connection 过滤', async () => {
  const syncService = createFakeSync({
    selection: [
      { connection_id: 'c1', project_id: 1, path_with_namespace: 'team/a', name: 'a', enabled: 1 },
      { connection_id: 'c2', project_id: 2, path_with_namespace: 'team/b', name: 'b', enabled: 1 },
    ],
  })
  const result = await runTool('report_sync', { action: 'get_selection', connection_id: 'c1' }, { syncService })
  assert.equal(result.structuredContent.count, 1)
  assert.equal(result.structuredContent.projects[0].projectId, 1)
})

test('report_sync list_candidates 支持 q 过滤', async () => {
  const syncService = createFakeSync({
    candidates: [
      { connection_id: 'c1', project_id: 1, path_with_namespace: 'team/erp-pos', name: 'erp-pos' },
      { connection_id: 'c1', project_id: 2, path_with_namespace: 'team/crm-order', name: 'crm-order' },
    ],
  })
  const result = await runTool('report_sync', { action: 'list_candidates', q: 'erp' }, { syncService })
  assert.equal(result.structuredContent.count, 1)
  assert.equal(result.structuredContent.projects[0].name, 'erp-pos')
})

test('report_sync save_selection 只替换指定 connection 并去重', async () => {
  const syncService = createFakeSync({
    selection: [
      { connection_id: 'c1', project_id: 1, path_with_namespace: 'team/a', name: 'a', enabled: 1 },
      { connection_id: 'c2', project_id: 9, path_with_namespace: 'team/z', name: 'z', enabled: 1 },
    ],
  })
  const result = await runTool(
    'report_sync',
    {
      action: 'save_selection',
      connection_id: 'c1',
      projects: [
        { project_id: 1, name: 'a', path_with_namespace: 'team/a' },
        { project_id: 2, name: 'b', path_with_namespace: 'team/b' },
        { project_id: 2, name: 'b', path_with_namespace: 'team/b' },
      ],
    },
    { syncService },
  )
  assert.equal(result.structuredContent.saved, true)
  assert.equal(result.structuredContent.count, 3, 'c2 保留 + c1 两条（去重后）')
  // sync.js 的 saveSelection 按 connection 全量替换：只写目标 connection，不重写 c2。
  assert.equal(syncService.state.savedCalls.length, 1)
  assert.equal(syncService.state.savedCalls[0].connectionId, 'c1')
  assert.deepEqual(
    syncService.state.savedCalls[0].projects.map((project) => `${project.connectionId}:${project.projectId}`).sort(),
    ['c1:1', 'c1:2'],
  )
  assert.deepEqual(
    syncService.state.selection.map((project) => `${project.connection_id}:${project.project_id}`).sort(),
    ['c1:1', 'c1:2', 'c2:9'],
    '其它 connection 的选择范围不得丢失',
  )
})

test('report_sync save_selection 在所有位置都缺 connection 时报错', async () => {
  await expectToolError(
    'report_sync',
    { action: 'save_selection', projects: [{ project_id: 1, name: 'a' }] },
    'VALIDATION',
  )
})

test('report_sync save_selection 参数校验', async () => {
  await expectToolError('report_sync', { action: 'save_selection' }, 'VALIDATION')
  await expectToolError(
    'report_sync',
    { action: 'save_selection', projects: [{ project_id: 0 }] },
    'VALIDATION',
  )
  await expectToolError(
    'report_sync',
    { action: 'save_selection', projects: [{ name: 'no-id' }] },
    'VALIDATION',
  )
})

test('report_sync status：活动任务 / 指定任务 / 不存在', async () => {
  const syncService = createFakeSync({
    jobs: [{ job_id: 'job-1', status: 'running', cancel_requested: 0 }],
  })
  const active = await runTool('report_sync', { action: 'status' }, { syncService })
  assert.equal(active.structuredContent.sync_job_id, 'job-1')
  assert.deepEqual(active.structuredContent.job_ref, { kind: 'sync_job', id: 'gitlab/job-1' })
  assert.equal(active.structuredContent.cancel_requested, false)

  const byId = await runTool('report_sync', { action: 'status', jobId: 'job-1' }, { syncService })
  assert.equal(byId.structuredContent.status, 'running')

  await expectToolError('report_sync', { action: 'status', jobId: 'missing' }, 'NOT_FOUND', { syncService })
})

test('report_sync start：必须 all_selected_projects=true', async () => {
  await expectToolError(
    'report_sync',
    { action: 'start', since: PERIOD.startDate, until: PERIOD.endDate },
    'VALIDATION',
  )
})

test('report_sync start：日期校验与「未选仓库」校验', async () => {
  await expectToolError(
    'report_sync',
    { action: 'start', all_selected_projects: true, since: '2026/10/20', until: PERIOD.endDate },
    'VALIDATION',
  )
  await expectToolError(
    'report_sync',
    { action: 'start', all_selected_projects: true, since: PERIOD.endDate, until: PERIOD.startDate },
    'VALIDATION',
  )
  await expectToolError(
    'report_sync',
    { action: 'start', all_selected_projects: true, since: PERIOD.startDate, until: PERIOD.endDate },
    'VALIDATION',
  )
})

test('report_sync start：正常创建任务并回读 job', async () => {
  const syncService = createFakeSync({
    selection: [{ connection_id: 'c1', project_id: 1, path_with_namespace: 'team/a', name: 'a', enabled: 1 }],
  })
  const result = await runTool(
    'report_sync',
    {
      action: 'start',
      all_selected_projects: true,
      since: PERIOD.startDate,
      until: PERIOD.endDate,
      connection_id: 'c1',
    },
    { syncService },
  )
  assert.equal(result.structuredContent.action, 'start')
  assert.equal(result.structuredContent.reused, false)
  assert.equal(result.structuredContent.sync_job_id, 'job-1')
  assert.deepEqual(syncService.state.startCalls[0], {
    connectionId: 'c1',
    startDate: PERIOD.startDate,
    endDate: PERIOD.endDate,
  })
})

test('report_sync start：已有活动任务时复用并标记 reused', async () => {
  const syncService = createFakeSync({
    jobs: [{ job_id: 'job-9', status: 'running' }],
    selection: [{ connection_id: 'c1', project_id: 1, path_with_namespace: 'team/a', name: 'a', enabled: 1 }],
  })
  const result = await runTool(
    'report_sync',
    { action: 'start', all_selected_projects: true, since: PERIOD.startDate, until: PERIOD.endDate },
    { syncService },
  )
  assert.equal(result.structuredContent.reused, true)
  assert.equal(result.structuredContent.sync_job_id, 'job-9')
  assert.equal(syncService.state.startCalls.length, 0)
})

test('report_sync cancel：无任务报 NOT_FOUND，有任务则取消', async () => {
  await expectToolError('report_sync', { action: 'cancel' }, 'NOT_FOUND')
  const syncService = createFakeSync({ jobs: [{ job_id: 'job-1', status: 'running' }] })
  const result = await runTool('report_sync', { action: 'cancel' }, { syncService })
  assert.equal(result.structuredContent.action, 'cancel')
  assert.equal(result.structuredContent.status, 'cancelled')
  assert.deepEqual(syncService.state.cancelCalls, ['job-1'])
})

test('report_sync 非法 action 报错并列出 7 个合法值', async () => {
  await expectToolError('report_sync', { action: 'wat' }, 'VALIDATION')
  const { ctx } = bootTools()
  await assert.rejects(
    () => ctx.registered.get('report_sync').execute({ action: 'wat' }),
    (error) => {
      assert.match(error.message, /coverage/)
      assert.match(error.message, /cancel/)
      return true
    },
  )
})

test('report_sync 未注入 syncService 时报 INTERNAL', async () => {
  await expectToolError('report_sync', { action: 'coverage' }, 'INTERNAL', { syncService: null })
})
