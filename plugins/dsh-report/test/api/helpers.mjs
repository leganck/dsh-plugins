/**
 * test/api 共用的测试替身（无副作用，可被当作「无测试文件」加载）。
 *
 * 这些替身严格按 `dsh-report-plugin/CONTRACTS.md` 的签名实现：
 *   - lib/db.js 导出函数首参为 db（§2）
 *   - lib/domain/* 为纯函数 / `upsertReport(db, {...})`（§3）
 *   - lib/sync.js 服务方法（§4）
 * 测试用它们验证 lib/tools.js 与 lib/api.js 的契约，不依赖真实 SQLite / 网络。
 *
 * @module test/api/helpers
 */

import { Readable } from 'node:stream'

/** 报告 ID 构造（与 domain.ids 契约一致）。 */
export function reportId(type, startDate, endDate) {
  return `${type}:${startDate}:${endDate}`
}

/** 固定周期，便于断言。 */
export const PERIOD = { type: 'week', startDate: '2026-10-20', endDate: '2026-10-26' }

/** 报告 ID。 */
export const PERIOD_ID = reportId(PERIOD.type, PERIOD.startDate, PERIOD.endDate)

/** 生成 n 条提交行（snake_case，模拟 DB 行）。 */
export function makeCommitRows(n, overrides = {}) {
  const rows = []
  for (let index = 0; index < n; index += 1) {
    rows.push({
      connection_id: 'c1',
      project_id: 1,
      commit_id: `sha${String(index).padStart(4, '0')}`,
      message: `feat: item ${index}\n\nsecret body`,
      authored_date: `2026-10-2${index % 7} 10:00:00 +0800`,
      committed_date: `2026-10-2${index % 7} 10:00:00 +0800`,
      author_name: 'Tester',
      author_email: 'tester@example.com',
      title: `feat: item ${index}`,
      is_merge_commit: 0,
      is_cherry_pick_commit: 0,
      cherry_pick_source_commit: '',
      additions: 3,
      deletions: 1,
      total: 4,
      repo_name: 'erp-pos',
      namespace: 'team',
      path_with_namespace: 'team/erp-pos',
      branch_names: '["main","release"]',
      ...overrides,
    })
  }
  return rows
}

/** 一条 merge 提交 + 一条 cherry-pick 提交（用于口径测试）。 */
export function makeSpecialCommitRows() {
  return [
    ...makeCommitRows(1, { commit_id: 'merge1', title: 'Merge branch main', is_merge_commit: 1 }),
    ...makeCommitRows(1, {
      commit_id: 'cherry1',
      title: 'cherry picked',
      is_cherry_pick_commit: 1,
      cherry_pick_source_commit: 'src1',
    }),
  ]
}

/**
 * 假 db.js 模块（CONTRACTS §2 签名：首参 db）。
 *
 * @param {Record<string, any>} [seed]
 */
export function createFakeStore(seed = {}) {
  const state = {
    reports: [],
    aggregates: {},
    lineStats: {},
    repoBranchStats: {},
    topics: {},
    commits: [],
    jobs: [],
    selection: [],
    connections: new Map(),
    connectionUpserts: [],
    deleteCalls: [],
    ...seed,
  }
  /** @type {Record<string, any>} */
  const store = {
    state,
    listReportRows: () => state.reports,
    getReportRow: (_db, id) => state.reports.find((row) => row.report_id === id) ?? null,
    deleteReportRow: (_db, id) => {
      state.deleteCalls.push(id)
      const index = state.reports.findIndex((row) => row.report_id === id)
      if (index < 0) return false
      state.reports.splice(index, 1)
      return true
    },
    listLineStats: (_db, id) => state.lineStats[id] ?? [],
    listRepoBranchStats: (_db, id) => state.repoBranchStats[id] ?? [],
    listTopics: (_db, id) => state.topics[id] ?? [],
    listCommitsInPeriod: (_db, { startDate, endDate }) =>
      state.commits.filter((row) => {
        const date = String(row.authored_date ?? '').slice(0, 10)
        return date >= startDate && date <= endDate
      }),
    listSyncJobs: (_db, limit) => state.jobs.slice(0, limit),
    // connections 表（CONTRACTS §2 / §5.3.2）
    getConnection: (_db, id) => state.connections.get(String(id)) ?? null,
    listConnections: () => [...state.connections.values()],
    upsertConnection: (_db, row) => {
      state.connectionUpserts.push(row)
      state.connections.set(String(row.connectionId ?? row.connection_id), {
        connection_id: row.connectionId ?? row.connection_id,
        base_url: row.baseUrl ?? row.base_url ?? '',
        display_name: row.displayName ?? row.display_name ?? '',
        username: row.username ?? '',
      })
    },
  }
  // 聚合读取器：CONTRACTS §2 没有列这条导出，插件在缺失时会回退到直接查 report_aggregates。
  // 这里默认提供，用于覆盖「store 提供读取器」分支；需要覆盖 SQL 分支的用例传 { withAggregateReader: false }。
  if (seed.withAggregateReader !== false) {
    store.getReportAggregate = (_db, id) => state.aggregates[id] ?? null
  }
  delete state.withAggregateReader
  return store
}

/** 假 db handle：只支持插件 readStats 用到的 `report_aggregates.stats_json` 查询。 */
export function createFakeHandle(aggregates = {}) {
  return {
    prepare(sql) {
      return {
        get(...args) {
          if (!/report_aggregates/.test(String(sql))) return undefined
          const stats = aggregates[args[0]]
          return stats ? { stats_json: JSON.stringify(stats) } : undefined
        },
      }
    },
  }
}

/** 一份完整的报告行 + 聚合/行数/仓库/主题投影。 */
export function seedReport(store, overrides = {}) {
  const id = overrides.id ?? PERIOD_ID
  const row = {
    report_id: id,
    report_type: 'week',
    period_start: '2026-10-20',
    period_end: '2026-10-26',
    status: 'generated',
    content: '# 周报\n\n本周完成支付链路联调。',
    error_message: null,
    generated_at: '2026-10-27 09:00:00',
    updated_at: '2026-10-27 09:00:00',
    ...overrides.row,
  }
  store.state.reports.push(row)
  store.state.aggregates[id] = overrides.aggregates ?? {
    totalCommits: 12,
    totalAdditions: 340,
    totalDeletions: 88,
    totalLines: 428,
    mergeCommitCount: 2,
    cherryPickCommitCount: 1,
    nonMergeCommitCount: 9,
    repoCount: 3,
    branchDistribution: [{ name: 'main', count: 10 }],
    dateDistribution: [{ date: '2026-10-20', count: 5 }],
    domainDistribution: [{ name: 'ERP-POS', count: 8 }],
  }
  store.state.lineStats[id] = [
    { include_merge: 1, additions: 400, deletions: 100, total: 500, pure_additions: 300 },
    { include_merge: 0, additions: 340, deletions: 88, total: 428, pure_additions: 252 },
  ]
  store.state.repoBranchStats[id] = [
    { include_merge: 0, repo_key: 'team/erp-pos', branch_name: 'main', commit_count: 10, additions: 300, deletions: 80, total: 380 },
  ]
  store.state.topics[id] = [
    { report_id: id, sort_order: 1, domain: 'ERP-POS', topic_title: '支付联调', summary: '联调通过' },
  ]
  return row
}

/** 假 domain（CONTRACTS §3）。 */
export function createFakeDomain(overrides = {}) {
  const domain = {
    DEFAULT_TEMPLATES: { week: 'WEEK-TPL', month: 'MONTH-TPL', quarter: 'QUARTER-TPL', year: 'YEAR-TPL' },
    DEFAULT_GUIDANCE: { week: 'WEEK-GUIDE', month: 'MONTH-GUIDE', quarter: 'QUARTER-GUIDE', year: 'YEAR-GUIDE' },
    formatReportType: (type) => ({ week: '周报', month: '月报', quarter: '季报', year: '年报' })[type] ?? '周报',
    getReportBrief: ({ type, startDate, endDate, template, guidance }) => ({
      reportType: type,
      reportTypeLabel: '周报',
      startDate,
      endDate,
      period: `${startDate} 至 ${endDate}`,
      template: template ?? 'WEEK-TPL',
      guidance: guidance ?? 'WEEK-GUIDE',
      hostInstructions: 'HOST-INS',
    }),
    /** 复刻 Go gather 的分页/过滤/hint 口径（不含 hint，让插件回退逻辑生效）。 */
    gatherCommits: (commits, startDate, endDate, opts = {}) => {
      const includeMerge = Boolean(opts.includeMerge)
      const repo = String(opts.repo ?? '').trim()
      const needle = repo.toLowerCase()
      const filtered = commits.filter((commit) => {
        if (!includeMerge && (Number(commit.isMergeCommit) === 1 || Number(commit.isCherryPickCommit) === 1)) {
          return false
        }
        if (!needle) return true
        const haystack = `${commit.pathWithNamespace} ${commit.repoName} ${commit.namespace}`.toLowerCase()
        return haystack.includes(needle)
      })
      let limit = Number(opts.limit) > 0 ? Number(opts.limit) : 40
      if (limit > 80) limit = 80
      let offset = Math.max(0, Number(opts.offset) || 0)
      if (offset > filtered.length) offset = filtered.length
      const end = Math.min(offset + limit, filtered.length)
      const page = filtered.slice(offset, end)
      const hasMore = end < filtered.length
      return {
        startDate,
        endDate,
        repo,
        includeMerge,
        offset,
        limit,
        total: filtered.length,
        count: page.length,
        hasMore,
        nextOffset: hasMore ? end : 0,
        truncated: hasMore,
        commits: page.map((commit) => ({
          date: String(commit.authoredDate ?? '').slice(0, 10),
          title: commit.title,
          repo: commit.pathWithNamespace,
        })),
      }
    },
    buildRealtimeAnalytics: (startDate, endDate, commits, opts = {}) => ({
      range: { startDate, endDate },
      branchMode: 'current_refs_first_auxiliary',
      summary: { totalCommits: commits.length },
      lineStats: [{ include_merge: 0, additions: 1, deletions: 0, total: 1, pure_additions: 1 }],
      repoCards: {},
      dateDistribution: [],
      repoDistribution: [],
      scriptLike: {},
      view: opts,
    }),
    buildReportId: reportId,
    /** 复刻 domain.dayCommits 的对外形状（时区/排序细节由 domain 测试覆盖）。 */
    dayCommits: (commits, date, repoKey) => {
      const repoFilter = String(repoKey ?? '').trim().toLowerCase()
      const list = Array.isArray(commits) ? commits : []
      const filtered = repoFilter
        ? list.filter((commit) =>
            String(commit.pathWithNamespace ?? commit.repoName ?? '')
              .toLowerCase()
              .includes(repoFilter),
          )
        : list
      const capped = filtered.slice(0, 200)
      return {
        date,
        repo: String(repoKey ?? '').trim(),
        total: filtered.length,
        truncated: filtered.length > 200,
        commits: capped.map((commit) => ({
          time: String(commit.authoredDate ?? '').slice(11, 16) || '09:42',
          title: commit.title ?? '',
          repo: commit.pathWithNamespace ?? commit.repoName ?? '',
          branch: commit.primaryBranch ?? '',
          additions: Number(commit.additions ?? 0),
          deletions: Number(commit.deletions ?? 0),
          commitId: String(commit.commitId ?? '').slice(0, 8),
          merge: Number(commit.isMergeCommit) === 1,
          cherryPick: Number(commit.isCherryPickCommit) === 1,
        })),
      }
    },
    upsertReport: (db, { type, startDate, endDate, content }) => ({
      reportId: reportId(type, startDate, endDate),
      aggregates: {
        totalCommits: 12,
        totalAdditions: 340,
        totalDeletions: 88,
        totalLines: 428,
        mergeCommitCount: 2,
        cherryPickCommitCount: 1,
        nonMergeCommitCount: 9,
        repoCount: 3,
        branchDistribution: [],
        dateDistribution: [],
        domainDistribution: [],
      },
      lineStats: [],
      repoBranchStats: [],
      topics: [],
      content,
      db,
    }),
    ...overrides,
  }
  return domain
}

/** 假 sync.js 服务（CONTRACTS §4）。 */
export function createFakeSync(seed = {}) {
  const state = {
    selection: [],
    jobs: [],
    candidates: [],
    savedCalls: [],
    cancelCalls: [],
    startCalls: [],
    ...seed,
  }
  const service = {
    state,
    async coverage({ connectionId }) {
      return {
        summary: { repoCount: 2, commitCount: 9, activeDayCount: 4 },
        repos: [
          { projectId: 1, pathWithNamespace: 'team/erp-pos', commitCount: 9, contributionDays: [{ date: '2026-10-20', count: 9 }] },
        ],
        dateDistribution: [{ date: '2026-10-20', commitCount: 9 }],
        connectionId,
      }
    },
    async getSelection(connectionId) {
      if (!connectionId) return state.selection
      return state.selection.filter((project) => project.connection_id === connectionId)
    },
    async listCandidates({ connectionId, q, refresh }) {
      return state.candidates.filter((project) => {
        if (connectionId && project.connection_id && project.connection_id !== connectionId) return false
        if (!q) return true
        return `${project.name} ${project.path_with_namespace}`.toLowerCase().includes(String(q).toLowerCase())
      })
    },
    async saveSelection(connectionId, projects) {
      state.savedCalls.push({ connectionId, projects })
      // 与 db.js 同语义：按 connection 全量替换，其它 connection 不动。
      const others = state.selection.filter((project) => project.connection_id !== connectionId)
      const rows = projects.map((project) => ({
        connection_id: project.connectionId ?? project.connection_id ?? connectionId,
        project_id: project.projectId ?? project.project_id ?? project.id,
        path_with_namespace: project.pathWithNamespace ?? project.path_with_namespace ?? '',
        name: project.name ?? '',
        enabled: project.enabled ?? 1,
      }))
      state.selection = [...others, ...rows]
      return state.selection
    },
    async status(jobId) {
      if (jobId) return state.jobs.find((job) => job.job_id === jobId) ?? null
      return state.jobs.find((job) => ['pending', 'running', 'cancel_requested'].includes(job.status)) ?? null
    },
    async start(request) {
      state.startCalls.push(request)
      const job = {
        job_id: `job-${state.jobs.length + 1}`,
        connection_id: request.connectionId ?? '',
        status: 'running',
        started_at: '2026-10-27 10:00:00',
        progress_json: JSON.stringify({ totalProjects: 2, syncedProjects: 0 }),
        scope_json: JSON.stringify({ startDate: request.startDate, endDate: request.endDate }),
      }
      state.jobs.unshift(job)
      return job
    },
    async cancel(jobId) {
      state.cancelCalls.push(jobId)
      const job = state.jobs.find((item) => item.job_id === jobId)
      if (job) job.status = 'cancelled'
      return true
    },
  }
  return service
}

/** 假 Host ctx（只实现 tools.register）。 */
export function createFakeCtx() {
  /** @type {Map<string, any>} */
  const registered = new Map()
  return {
    registered,
    tools: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
  }
}

/** 假 res（记录 status/headers/body）。 */
export function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    headersSent: false,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
      this.writableEnded = true
      this.headersSent = true
    },
  }
}

/**
 * 假 req（预解析 body 分支）。
 *
 * @param {{ method?: string, url?: string, body?: unknown }} input
 */
export function makeReq(input = {}) {
  return {
    method: input.method ?? 'GET',
    url: input.url ?? '/',
    ...(input.body === undefined ? {} : { body: input.body }),
  }
}

/**
 * 调用 API handler，返回 `{ status, headers, body, json }`。
 *
 * @param {(req: any, res: any) => Promise<void>} handler
 * @param {{ method?: string, url: string, body?: unknown }} input
 */
export async function callApi(handler, input) {
  const res = makeRes()
  await handler(makeReq(input), res)
  /** @type {any} */
  let json = null
  try {
    json = res.body ? JSON.parse(res.body) : null
  } catch {
    json = null
  }
  return { status: res.statusCode, headers: res.headers, body: res.body, json }
}

/**
 * 假 GitLab 客户端工厂：`(credentials) => client`（GET /user 校验用）。
 *
 * @param {{ tokens?: Record<string, Record<string, any>> }} [seed]
 */
export function createGitLabFactory(seed = {}) {
  const tokens = seed.tokens ?? {
    'good-token': { username: 'tester', name: 'Tester', id: 42 },
  }
  /** @type {Array<{ baseUrl: string, token: string }>} */
  const calls = []
  const factory = ({ baseUrl, token }) => {
    calls.push({ baseUrl, token })
    return {
      baseUrl,
      token,
      async getCurrentUser() {
        const user = tokens[token]
        if (!user) throw new Error('401 Unauthorized')
        return user
      },
    }
  }
  factory.calls = calls
  return factory
}

/** 常用 deps 组装。 */
export function makeDeps(overrides = {}) {
  const store = 'store' in overrides ? overrides.store : createFakeStore()
  const domain = 'domain' in overrides ? overrides.domain : createFakeDomain()
  const syncService = 'syncService' in overrides ? overrides.syncService : createFakeSync()
  /** 可写配置快照：updateConfig 生效后 GET /config 能读到新值（与 config.js 行为一致）。 */
  const state = {
    config: {
      timezone: 'Asia/Shanghai',
      defaultReportType: 'week',
      gitlab: { baseUrl: '', tokenRef: 'dsh-report/gitlab-token' },
      ...(overrides.config ?? {}),
    },
  }
  const calls = { updateConfig: [], saveToken: [] }
  /** token 状态：saveToken 之后 resolveToken 能读到（与 credentials 记录行为一致）。 */
  let currentToken = overrides.token ?? ''
  return {
    calls,
    store,
    domain,
    syncService,
    deps: {
      db: overrides.handle ?? null,
      store,
      domain,
      syncService,
      getConfig: () => state.config,
      updateConfig: async (patch) => {
        calls.updateConfig.push(patch)
        // 按 top-level key 整体替换（templates 这类「全量覆盖图」语义依赖此行为）。
        for (const [key, value] of Object.entries(patch ?? {})) {
          state.config[key] = value
        }
      },
      resolveToken: async () => currentToken,
      saveToken: async (token) => {
        calls.saveToken.push(token)
        currentToken = token
      },
      logger: () => {},
      build: '0.2.0-test',
      dbPath: '/tmp/report.db',
      dataDir: '/tmp/dsh-report',
      node: 'v26.0.0',
      ...(overrides.gitlab === undefined ? {} : { gitlab: overrides.gitlab }),
      ...(overrides.connections === undefined ? {} : { connections: overrides.connections }),
      ...(overrides.createReportSession === undefined ? {} : { createReportSession: overrides.createReportSession }),
      ...overrides.deps,
    },
  }
}

/**
 * 假 req 的流式变体：真正走 `readJSONBody` 的 `data/end` 分支。
 *
 * @param {{ method?: string, url: string, body?: unknown }} input
 */
export function makeStreamReq(input) {
  const payload = input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body), 'utf8')]
  const req = Readable.from(payload)
  req.method = input.method ?? 'POST'
  req.url = input.url
  return req
}
