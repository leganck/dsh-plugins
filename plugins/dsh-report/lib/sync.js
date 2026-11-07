/**
 * @local/dsh-report · GitLab 提交同步引擎
 *
 * 职责（CONTRACTS.md §4）：`coverage / getSelection / listCandidates / saveSelection / status / start / cancel`。
 *
 * 同步语义（复刻 workbench，外加两条已确认的修正）：
 *   1. 拉取窗口 `since=startDate 00:00:00`、`until=endDate 23:59:59`（**本机时区**，RFC3339）；
 *   2. 拉回后按 `authored_date` 前 10 位**二次过滤**到区间（Go 侧只信 GitLab since/until，见 05 分册 R1）；
 *   3. 分页 `per_page=100&all=true&order_by=created_at&sort=desc`，终止条件 `x-next-page` 为空；
 *      缺少分页头 → 该项目 `complete=false` → 不参与 prune（05 分册 R4）；
 *   4. 每个命中提交：detail 取 `stats`，refs 取分支数组（数组序 → `branch_order`）；
 *   5. 并发：项目串行、页串行、页内 ≤8 worker、每 20 条批量写 + 每 20 条刷进度（§4）；
 *   6. 取消：三处检查（项目前 / 页前 / 每批前）+ 收尾前；终态 `cancelled` 不被覆盖；
 *   7. 状态机：`pending → running → succeeded | failed | cancelled`。部分失败语义（实现偏差，
 *      见 CONTRACTS §4「实现偏差登记」）：有任意项目/提交成功落库时终态仍为 `succeeded`
 *      且 `progress.partial=true` / `progress.errors>0`；只有「零成功 + 有错误」才 `failed`；
 *   8. 错误写 `sync_job_errors`（`stage=project_sync|commit_sync`）；
 *   9. prune：仅对「本次完整翻页」的项目，删除窗口内本地不再存在的提交（复刻 Go `DeleteStaleSyncedDataInRange`）。
 *
 * @module lib/sync
 */

import {
  appendSyncJobError,
  createSyncJob,
  getActiveSyncJob,
  getConnection,
  getSyncJob,
  listCoverageRows,
  listSyncJobs,
  nowIso,
  pruneCommits,
  selectedProjects,
  saveSelectedProjects,
  updateSyncJob,
  upsertCommits,
  upsertConnection,
  upsertRepositories,
  withTransaction,
  replaceCommitStats,
  replaceCommitRefs,
  commitKey,
} from './db.js'
import { buildCommitMatcher } from './matcher.js'

/** 任务状态常量（CONTRACTS §4）。 */
export const SYNC_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

/** 终态集合。 */
const TERMINAL_STATUSES = new Set([SYNC_STATUS.SUCCEEDED, SYNC_STATUS.FAILED, SYNC_STATUS.CANCELLED])

/** 页大小（固定 100，复刻 Go `proxy.go:185-188`）。 */
const PAGE_SIZE = 100

/** 页内并发上限（复刻 Go `min(8, max(2, NumCPU))`，这里固定 8）。 */
const WORKER_LIMIT = 8

/** 批写/进度粒度。 */
const BATCH_SIZE = 20

/** 单项目最大页数（防御未知分页头导致的死循环；1000 页 = 10 万提交）。 */
const MAX_PAGES = 1000

/** 候选仓库最大页数（50 × 50 = 2500 个项目）。 */
const MAX_CANDIDATE_PAGES = 50

/** 日期校验。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 默认空 logger。 */
const NOOP = () => {}

/** 异步/同步统一取值。 */
async function maybeAwait(value) {
  return value && typeof value.then === 'function' ? await value : value
}

/** `lower(trim(v)).startsWith('merge')`（Go `isMerge`，`commit_import_repository.go:585-587`）。 */
function isMergeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .startsWith('merge')
}

/** 从 message 提取 cherry-pick 源提交（Go `extractCherryPickSource`，`:603-618`）。 */
export function extractCherryPickSource(message) {
  const normalized = String(message ?? '').replace(/\r\n/g, '\n')
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim()
    const lower = trimmed.toLowerCase()
    if (lower.startsWith('(cherry picked from commit ')) {
      return trimmed.replace(/^\(cherry picked from commit /i, '').replace(/\)$/, '')
    }
    if (lower.startsWith('cherry-picked from commit ')) {
      return trimmed.slice('cherry-picked from commit '.length).trim()
    }
    if (lower.startsWith('cherry picked from commit ')) {
      return trimmed.slice('cherry picked from commit '.length).trim()
    }
  }
  return ''
}

/** detail.stats → additions/deletions/total（Go `extractStats`，`service.go:729-741`）。 */
export function extractStats(detail) {
  const stats = detail && typeof detail === 'object' ? detail.stats : null
  const additions = Number(stats?.additions ?? 0) || 0
  const deletions = Number(stats?.deletions ?? 0) || 0
  let total = Number(stats?.total ?? 0) || 0
  if (!total) total = additions + deletions
  return { additions, deletions, total }
}

/** 本机时区偏移字符串（`+08:00` / `-05:00` / `+00:00`）。 */
function localOffset(date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  const minutes = String(abs % 60).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

/**
 * 把 `YYYY-MM-DD` + 本地时刻格式化为 RFC3339（带本机偏移）。
 * Go 侧 `normalizeGitLabBoundary` 写死 UTC+8（`proxy.go:222-239`），插件改为跟随本机时区（05 分册 R2）。
 * @param {string} dateStr `YYYY-MM-DD`
 * @param {string} timeStr `HH:mm:ss`
 * @returns {string}
 */
export function localBoundary(dateStr, timeStr) {
  const date = new Date(`${dateStr}T${timeStr}`)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    localOffset(date)
  )
}

/** 取 `authored_date` 前 10 位（缺失时回退 committed_date）。 */
function commitDate(commit) {
  const authored = String(commit?.authored_date ?? commit?.authoredDate ?? '')
  if (authored.length >= 10) return authored.slice(0, 10)
  const committed = String(commit?.committed_date ?? commit?.committedDate ?? '')
  return committed.length >= 10 ? committed.slice(0, 10) : ''
}

/** 从配置里读作者别名（兼容 Lead 的 config 形状）。 */
export function aliasesFromConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return []
  const candidates = [
    cfg.gitlabAuthorAliases,
    cfg.gitlab_author_aliases,
    cfg.aliases,
    cfg.gitlab?.authorAliases,
    cfg.gitlab?.author_aliases,
  ]
  for (const value of candidates) {
    if (value !== undefined && value !== null) return value
  }
  return []
}

/** 并发受限的 map（保序返回）。 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** 生成任务 ID（无外部依赖）。 */
function newJobId() {
  const random = Math.random().toString(36).slice(2, 10)
  return `sync-${Date.now().toString(36)}-${random}`
}

/**
 * 创建同步服务。
 *
 * @param {{db: any,
 *          config?: object|(() => object|Promise<object>),
 *          gitlabForConnection: (connectionId: string) => any|Promise<any>,
 *          logger?: Function|{info?: Function, warn?: Function, error?: Function, debug?: Function}}} deps
 * @returns {{
 *   coverage: (q: {connectionId?: string, startDate?: string, endDate?: string}) => Promise<object>,
 *   getSelection: (connectionId?: string) => Promise<object[]>,
 *   listCandidates: (q: {connectionId: string, q?: string, refresh?: boolean}) => Promise<object[]>,
 *   listCandidatesDetailed: (q: {connectionId: string, q?: string}) => Promise<{projects: object[], complete: boolean, total: number}>,
 *   saveSelection: (connectionId: string, projects: object[]) => Promise<{saved: number, projects: object[]}>,
 *   status: (jobId?: string) => Promise<object|null>,
 *   start: (q: {connectionId: string, startDate: string, endDate: string, projectIds?: Array<number|string>})
 *     => Promise<{jobId: string, reused: boolean, totalProjects: number}>,
 *   cancel: (jobId?: string) => Promise<boolean>,
 *   waitForJob: (jobId: string) => Promise<object|null>,
 *   listJobs: (limit?: number) => Promise<object[]>,
 * }}
 */
export function createSyncService({ db, config, gitlabForConnection, logger } = {}) {
  if (!db) throw new Error('createSyncService 需要 db（openDatabase 返回值）')
  if (typeof gitlabForConnection !== 'function') {
    throw new Error('createSyncService 需要 gitlabForConnection(connectionId)')
  }

  const log =
    typeof logger === 'function'
      ? logger
      : logger && typeof logger === 'object'
        ? (event, extra) => {
            const fn = logger.debug ?? logger.info ?? logger.log ?? NOOP
            try {
              fn.call(logger, event, extra)
            } catch {
              /* 日志不影响同步 */
            }
          }
        : NOOP

  /** jobId → 运行中的 Promise（供 waitForJob / 测试等待）。 */
  const running = new Map()

  /**
   * 读配置快照。兼容 Lead 侧 `lib/config.js` 可能的几种形态：
   *   - 纯对象快照；
   *   - `() => snapshot`（同步或异步）；
   *   - `{ getConfig() / snapshot() / current() / get() }` 管理器。
   * 解析不到对象时返回 `{}`（别名等配置缺省 → 仅按 profile 邮箱匹配）。
   */
  async function readConfig() {
    const source = config
    if (typeof source === 'function') return (await maybeAwait(source())) ?? {}
    if (source && typeof source === 'object') {
      for (const key of ['getConfig', 'snapshot', 'current', 'get']) {
        if (typeof source[key] !== 'function') continue
        try {
          const value = await maybeAwait(source[key]())
          if (value && typeof value === 'object' && !Array.isArray(value)) return value
        } catch {
          /* 该方法不是配置读取入口，继续尝试下一个 */
        }
      }
      return source
    }
    return {}
  }

  /** 取连接对应的 GitLab 客户端（每次调用都重新解析，凭据热更新）。 */
  async function clientFor(connectionId) {
    const client = await maybeAwait(gitlabForConnection(connectionId))
    if (!client) throw new Error(`GITLAB_CONNECTION_NOT_FOUND：${connectionId}`)
    return client
  }

  /** 读任务并判定是否已取消（终态或 cancelRequested）。 */
  function isCancelled(jobId) {
    const job = getSyncJob(db, jobId)
    if (!job) return true
    if (job.status === SYNC_STATUS.CANCELLED) return true
    return job.progress?.cancelRequested === true
  }

  /** 写进度 + 状态（只传要改的字段）。 */
  function flushProgress(jobId, progress, extra = {}) {
    const current = getSyncJob(db, jobId)
    const cancelRequested = current?.progress?.cancelRequested === true || progress?.cancelRequested === true
    updateSyncJob(db, jobId, { progress: { ...progress, cancelRequested }, ...extra })
  }

  // ------------------------------------------------------------ 同步范围

  /** 读已选项目（按连接）。 */
  async function getSelection(connectionId) {
    return selectedProjects(db, connectionId)
  }

  /** 全量保存已选项目。 */
  async function saveSelection(connectionId, projects) {
    const id = String(connectionId ?? '').trim()
    if (!id) throw new Error('saveSelection 需要 connectionId')
    const rows = (Array.isArray(projects) ? projects : []).map((item) => ({
      projectId: item?.projectId ?? item?.project_id ?? item?.id,
      pathWithNamespace: item?.pathWithNamespace ?? item?.path_with_namespace ?? '',
      name: item?.name ?? '',
      enabled: item?.enabled === undefined ? 1 : item.enabled,
    }))
    const invalid = rows.find((row) => !Number.isFinite(Number(row.projectId)) || Number(row.projectId) <= 0)
    if (invalid) throw new Error('saveSelection 的 projects 每项都需要正整数 projectId')
    saveSelectedProjects(db, id, rows)
    return { saved: rows.length, projects: selectedProjects(db, id) }
  }

  /**
   * 列候选仓库（GitLab membership，逐页拉取后按关键字过滤）。
   * 返回数组（调用方 api/tools 都按数组消费）；附带信息通过 `listCandidatesDetailed` 提供。
   * @param {{connectionId: string, q?: string, refresh?: boolean}} query
   * @returns {Promise<Array<{id: number, projectId: number, connectionId: string, name: string,
   *   pathWithNamespace: string, webUrl: string, visibility: string}>>}
   */
  async function listCandidates({ connectionId, q } = {}) {
    const detail = await listCandidatesDetailed({ connectionId, q })
    return detail.projects
  }

  /**
   * 同 listCandidates，但额外返回 `{complete, total}`（工具诊断用）。
   * @param {{connectionId: string, q?: string, refresh?: boolean}} query
   */
  async function listCandidatesDetailed({ connectionId, q } = {}) {
    const id = String(connectionId ?? '').trim()
    if (!id) throw new Error('listCandidates 需要 connectionId')
    const client = await clientFor(id)
    const keyword = String(q ?? '').trim().toLowerCase()
    const projects = []
    let complete = false
    for (let page = 1; page <= MAX_CANDIDATE_PAGES; page += 1) {
      const result = await client.listMembershipProjects({ page, perPage: 50 })
      const items = Array.isArray(result?.items) ? result.items : []
      for (const item of items) {
        const projectId = Number(item?.id ?? 0)
        if (!projectId) continue
        projects.push({
          id: projectId,
          projectId,
          connectionId: id,
          name: String(item?.name ?? ''),
          pathWithNamespace: String(item?.path_with_namespace ?? item?.pathWithNamespace ?? ''),
          webUrl: String(item?.web_url ?? ''),
          visibility: String(item?.visibility ?? ''),
        })
      }
      if (!result?.hasPagination) {
        complete = false
        break
      }
      if (!result.nextPage) {
        complete = true
        break
      }
    }
    const filtered = keyword
      ? projects.filter(
          (project) =>
            project.name.toLowerCase().includes(keyword) ||
            project.pathWithNamespace.toLowerCase().includes(keyword),
        )
      : projects
    return { projects: filtered, complete, total: projects.length }
  }

  // ------------------------------------------------------------ 覆盖度

  /**
   * 覆盖度聚合（对应 `internal/repository/sqlite/sync_coverage.go:8-154`，但支持日期区间）。
   * @param {{connectionId?: string, startDate?: string, endDate?: string}} query
   */
  async function coverage({ connectionId, startDate, endDate } = {}) {
    const rows = listCoverageRows(db, { connectionIds: connectionId, startDate, endDate })
    const summaryDates = new Set()
    let firstCommitDate = ''
    let lastCommitDate = ''
    const repoMap = new Map()
    const dateMap = new Map()

    for (const row of rows) {
      const date = String(row.authoredDate ?? '').slice(0, 10)
      if (!date) continue
      summaryDates.add(date)
      if (!firstCommitDate || date < firstCommitDate) firstCommitDate = date
      if (!lastCommitDate || date > lastCommitDate) lastCommitDate = date

      const key = `${row.connectionId}\u0000${row.projectId}`
      let repo = repoMap.get(key)
      if (!repo) {
        repo = {
          connectionId: row.connectionId,
          projectId: row.projectId,
          pathWithNamespace: row.pathWithNamespace || String(row.projectId),
          commitCount: 0,
          firstCommitDate: '',
          lastCommitDate: '',
          activeDays: new Set(),
          latestCommitDate: '',
          days: new Map(),
          additions: 0,
          deletions: 0,
        }
        repoMap.set(key, repo)
      }
      repo.commitCount += 1
      repo.additions += Number(row.additions ?? 0) || 0
      repo.deletions += Number(row.deletions ?? 0) || 0
      if (!repo.firstCommitDate || date < repo.firstCommitDate) repo.firstCommitDate = date
      if (!repo.lastCommitDate || date > repo.lastCommitDate) repo.lastCommitDate = date
      repo.activeDays.add(date)
      if (row.authoredDate > repo.latestCommitDate) repo.latestCommitDate = row.authoredDate
      repo.days.set(date, (repo.days.get(date) ?? 0) + 1)
      dateMap.set(date, (dateMap.get(date) ?? 0) + 1)
    }

    const repos = [...repoMap.values()]
      .map((repo) => ({
        connectionId: repo.connectionId,
        projectId: repo.projectId,
        pathWithNamespace: repo.pathWithNamespace,
        commitCount: repo.commitCount,
        firstCommitDate: repo.firstCommitDate,
        lastCommitDate: repo.lastCommitDate,
        activeDayCount: repo.activeDays.size,
        latestCommitDate: repo.latestCommitDate,
        additions: repo.additions,
        deletions: repo.deletions,
        contributionDays: [...repo.days.entries()]
          .map(([date, count]) => ({ date, count }))
          .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0)),
      }))
      .sort(
        (left, right) =>
          (left.latestCommitDate < right.latestCommitDate
            ? 1
            : left.latestCommitDate > right.latestCommitDate
              ? -1
              : 0) ||
          right.commitCount - left.commitCount ||
          left.pathWithNamespace.localeCompare(right.pathWithNamespace),
      )

    const datedCount = [...repoMap.values()].reduce((sum, repo) => sum + repo.commitCount, 0)
    const totalAdditions = [...repoMap.values()].reduce((sum, repo) => sum + repo.additions, 0)
    const totalDeletions = [...repoMap.values()].reduce((sum, repo) => sum + repo.deletions, 0)
    const dateDistribution = [...dateMap.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))

    return {
      connectionId: connectionId ?? '',
      range: { startDate: startDate ?? '', endDate: endDate ?? '' },
      summary: {
        repoCount: repos.length,
        commitCount: datedCount,
        firstCommitDate,
        lastCommitDate,
        activeDayCount: summaryDates.size,
        additions: totalAdditions,
        deletions: totalDeletions,
      },
      repos,
      dateDistribution,
    }
  }

  // ------------------------------------------------------------ 任务查询

  /** 任务视图（附带派生进度百分比）。 */
  function jobView(job) {
    if (!job) return null
    const progress = job.progress ?? {}
    const total = Number(progress.totalProjects ?? 0)
    const synced = Number(progress.syncedProjects ?? 0)
    return {
      ...job,
      progress: {
        ...progress,
        percent: total > 0 ? Math.min(100, Math.round((synced / total) * 100)) : 0,
      },
      terminal: TERMINAL_STATUSES.has(job.status),
    }
  }

  /** `status(jobId?)`：给了 jobId 查该任务；没给返回当前活动任务（无则最近一次）。 */
  async function status(jobId) {
    const id = String(jobId ?? '').trim()
    if (id) return jobView(getSyncJob(db, id))
    const active = getActiveSyncJob(db)
    if (active) return jobView(active)
    const recent = listSyncJobs(db, 1)
    return recent.length ? jobView(recent[0]) : null
  }

  /** 任务历史。 */
  async function listJobs(limit) {
    return listSyncJobs(db, limit).map(jobView)
  }

  // ------------------------------------------------------------ 启动/取消

  /** 校验窗口。 */
  function validateWindow(startDate, endDate) {
    if (!DATE_RE.test(String(startDate ?? ''))) throw new Error('startDate 必须是 YYYY-MM-DD')
    if (!DATE_RE.test(String(endDate ?? ''))) throw new Error('endDate 必须是 YYYY-MM-DD')
    if (String(startDate) > String(endDate)) throw new Error('startDate 不能晚于 endDate')
  }

  /** 启动同步任务（立即返回 jobId，后台异步执行）。支持多个 GitLab 连接一起同步。 */
  async function start({ connectionId, connectionIds, startDate, endDate, projectIds } = {}) {
    const ids = Array.isArray(connectionIds)
      ? [...new Set(connectionIds.map((value) => String(value ?? '').trim()).filter(Boolean))]
      : [String(connectionId ?? '').trim()].filter(Boolean)
    if (!ids.length) throw new Error('start 需要 connectionId 或 connectionIds')
    validateWindow(startDate, endDate)

    const active = getActiveSyncJob(db)
    if (active) return { jobId: active.jobId, reused: true, totalProjects: active.progress?.totalProjects ?? 0 }

    const wanted = Array.isArray(projectIds) ? new Set(projectIds.map((value) => Number(value))) : null
    const usedConnections = []
    const projects = []
    for (const id of ids) {
      const selection = selectedProjects(db, id).filter((item) => Number(item.enabled ?? 1) !== 0)
      const picked = wanted ? selection.filter((item) => wanted.has(Number(item.projectId))) : selection
      if (!picked.length) continue
      usedConnections.push(id)
      for (const item of picked) {
        projects.push({
          connectionId: id,
          projectId: Number(item.projectId),
          pathWithNamespace: item.pathWithNamespace,
          name: item.name,
        })
      }
    }
    if (!projects.length) {
      throw new Error('没有已选择（或匹配 projectIds 的）GitLab 项目，请先保存同步范围')
    }

    const jobId = newJobId()
    const progress = {
      totalProjects: projects.length,
      syncedProjects: 0,
      totalCommits: 0,
      currentProjectId: null,
      currentProjectName: '',
      currentProjectPath: '',
      currentProjectIndex: 0,
      currentProjectCommitCount: 0,
      cancelRequested: false,
      partial: false,
      errors: 0,
    }
    createSyncJob(db, {
      jobId,
      connectionId: usedConnections[0] ?? ids[0],
      status: SYNC_STATUS.PENDING,
      startedAt: nowIso(),
      progress,
      scope: { connectionId: usedConnections[0] ?? ids[0], connectionIds: usedConnections, startDate, endDate, projects },
    })
    log('sync-start', { jobId, connectionIds: usedConnections, projects: projects.length, startDate, endDate })

    const promise = Promise.resolve()
      .then(() => runJob(jobId))
      .catch((error) => {
        log('sync-run-crashed', { jobId, message: String(error?.message ?? error) })
        finalize(jobId, SYNC_STATUS.FAILED, { errorMessage: String(error?.message ?? error) })
      })
      .finally(() => {
        running.delete(jobId)
      })
    running.set(jobId, promise)
    return { jobId, reused: false, totalProjects: projects.length }
  }

  /**
   * 取消任务：pending 直接置 cancelled；running 打标记由 runner 收尾。
   * @param {string} [jobId] 省略 = 取消当前活动任务
   * @returns {Promise<boolean>} 是否受理了取消（已结束/不存在 → false）
   */
  async function cancel(jobId) {
    const id = String(jobId ?? '').trim() || getActiveSyncJob(db)?.jobId || ''
    if (!id) return false
    const job = getSyncJob(db, id)
    if (!job) return false
    if (TERMINAL_STATUSES.has(job.status)) return false
    const progress = { ...(job.progress ?? {}), cancelRequested: true }
    if (job.status === SYNC_STATUS.PENDING) {
      updateSyncJob(db, id, {
        status: SYNC_STATUS.CANCELLED,
        finishedAt: nowIso(),
        progress,
        error: '任务已取消（运行前）',
      })
      return true
    }
    flushProgress(id, progress)
    log('sync-cancel-requested', { jobId: id })
    return true
  }

  /** 等待某任务结束（测试/工具用；无该任务 → null）。 */
  async function waitForJob(jobId) {
    const pending = running.get(String(jobId ?? ''))
    if (pending) await pending
    return jobView(getSyncJob(db, jobId))
  }

  // ------------------------------------------------------------ runner

  /**
   * 统一收尾：写终态 + finishedAt + progress。
   *
   * `partial` 语义（Lead 确认的实现偏差，见 CONTRACTS §4「实现偏差登记」）：
   *   - 有部分成功但存在错误/未完整项目 → `succeeded` + `progress.partial=true`；
   *   - 零成功且有错误 → `failed`（partial 默认 true）；
   *   - 完全成功 → `succeeded` + `partial=false`。
   *
   * @param {string} jobId
   * @param {string} status
   * @param {{errorMessage?: string|null, partial?: boolean}} [options]
   */
  function finalize(jobId, status, options = {}) {
    const job = getSyncJob(db, jobId)
    // 已取消的任务不能被 runner 的收尾覆盖（取消可能发生在 run 启动前/收尾竞态里）。
    if (job && job.status === SYNC_STATUS.CANCELLED && status !== SYNC_STATUS.CANCELLED) return jobView(job)
    // options.progress 优先：runner 收尾时携带内存里的最新计数（incompleteProjects 等未落盘）
    const progress = { ...(options.progress ?? job?.progress ?? {}) }
    if (status === SYNC_STATUS.CANCELLED) progress.cancelRequested = true
    const partial =
      options.partial !== undefined ? Boolean(options.partial) : status === SYNC_STATUS.FAILED
    progress.partial = partial
    const errorCount = Number(progress.errors ?? 0)
    const defaultError =
      status === SYNC_STATUS.FAILED
        ? `同步失败：${errorCount} 个错误且无任何成功落库${progress.incompleteProjects ? ` / ${progress.incompleteProjects} 个项目未完成` : ''}`
        : status === SYNC_STATUS.CANCELLED
          ? '任务已取消'
          : null
    updateSyncJob(db, jobId, {
      status,
      finishedAt: nowIso(),
      progress,
      error: options.errorMessage ?? defaultError,
    })
    log('sync-finish', {
      jobId,
      status,
      partial,
      totalCommits: progress.totalCommits ?? 0,
      errors: errorCount,
    })
    return jobView(getSyncJob(db, jobId))
  }

  /** 记录一条同步错误并累加计数。 */
  function recordError(jobId, progress, { projectId, commitId, stage, message }) {
    appendSyncJobError(db, { jobId, projectId, commitId, stage, message })
    progress.errors = Number(progress.errors ?? 0) + 1
    log('sync-error', { jobId, stage, projectId, commitId, message })
  }

  /** 取（并缓存）某连接的 matcher；顺带写 connections 表。 */
  async function matcherFor(connectionId, cache) {
    if (cache.has(connectionId)) return cache.get(connectionId)
    const client = await clientFor(connectionId)
    const user = await client.getCurrentUser()
    let emails = []
    try {
      emails = await client.getUserEmails()
    } catch (error) {
      // Go 侧同样静默降级（缺少 read_user scope 时仍可同步）
      log('sync-user-emails-failed', { connectionId, message: String(error?.message ?? error) })
    }
    const cfg = await readConfig()
    const matcher = buildCommitMatcher({ user, userEmails: emails, aliases: aliasesFromConfig(cfg) })
    const known = getConnection(db, connectionId)
    if (!known || !known.baseUrl) {
      upsertConnection(db, {
        connectionId,
        baseUrl: client.baseUrl ?? cfg?.gitlab?.baseUrl ?? '',
        displayName: user?.name ?? '',
        username: user?.username ?? '',
      })
    }
    cache.set(connectionId, matcher)
    return matcher
  }

  /** 拉一个提交的 detail + refs，并组装落库记录。 */
  async function fetchCommitPayload(client, project, commit) {
    const commitId = String(commit?.id ?? commit?.commit_id ?? '')
    const detail = await client.getCommit(project.projectId, commitId)
    const refs = await client.getCommitRefs(project.projectId, commitId)
    const { additions, deletions, total } = extractStats(detail)
    const message = String(commit?.message ?? '')
    const title = String(commit?.title ?? '')
    const cherryPickSource = extractCherryPickSource(message)
    return {
      record: {
        connectionId: project.connectionId,
        projectId: project.projectId,
        commitId,
        message,
        authoredDate: String(commit?.authored_date ?? ''),
        committedDate: String(commit?.committed_date ?? ''),
        authorName: String(commit?.author_name ?? ''),
        authorEmail: String(commit?.author_email ?? ''),
        title,
        isMergeCommit: isMergeText(title) || isMergeText(message) ? 1 : 0,
        isCherryPickCommit: cherryPickSource ? 1 : 0,
        cherryPickSourceCommit: cherryPickSource,
        createdAt: nowIso(),
      },
      stats: { connectionId: project.connectionId, projectId: project.projectId, commitId, additions, deletions, total },
      refs: {
        connectionId: project.connectionId,
        projectId: project.projectId,
        commitId,
        branches: Array.isArray(refs) ? refs.map((ref) => ref?.name ?? ref).filter(Boolean) : [],
      },
    }
  }

  /**
   * 同步单个项目（逐页 → 逐批 → 逐提交）。
   * @returns {Promise<{complete: boolean, commitCount: number}>}
   */
  async function syncProject({ jobId, client, project, matcher, scope, progress, keep }) {
    const since = localBoundary(scope.startDate, '00:00:00')
    const until = localBoundary(scope.endDate, '23:59:59')
    let complete = true
    let commitCount = 0
    let page = 1

    for (; page <= MAX_PAGES; page += 1) {
      if (isCancelled(jobId)) return { complete: false, cancelled: true, commitCount }

      let result
      try {
        result = await client.listCommits(project.projectId, { since, until, page, perPage: PAGE_SIZE })
      } catch (error) {
        recordError(jobId, progress, {
          projectId: project.projectId,
          stage: 'project_sync',
          message: `第 ${page} 页拉取失败：${String(error?.message ?? error)}`,
        })
        complete = false
        break
      }

      const items = Array.isArray(result?.items) ? result.items : []
      if (!result?.hasPagination) {
        // 分页头缺失：剩余页数未知 → 绝不 prune（05 分册 R4）
        complete = false
      }

      // 窗口二次过滤（按规则 1/2：先按 authored_date 前 10 位，再走 matcher）
      const inWindow = items.filter((commit) => {
        const date = commitDate(commit)
        return date >= scope.startDate && date <= scope.endDate
      })
      const matched = inWindow
        .map((commit) => ({ commit, attribution: matcher(commit) }))
        .filter((item) => item.attribution.matched)
      progress.currentProjectCommitCount = commitCount
      progress.totalCommits = Number(progress.totalCommits ?? 0)

      for (let offset = 0; offset < matched.length; offset += BATCH_SIZE) {
        if (isCancelled(jobId)) return { complete: false, cancelled: true, commitCount }
        const batch = matched.slice(offset, offset + BATCH_SIZE)
        const payloads = await mapLimit(batch, WORKER_LIMIT, async (item) => {
          try {
            return { ok: true, payload: await fetchCommitPayload(client, project, item.commit) }
          } catch (error) {
            return { ok: false, commitId: String(item.commit?.id ?? ''), error }
          }
        })

        const records = []
        const stats = []
        const refs = []
        for (const payload of payloads) {
          if (!payload.ok) {
            recordError(jobId, progress, {
              projectId: project.projectId,
              commitId: payload.commitId,
              stage: 'commit_sync',
              message: `提交补全失败：${String(payload.error?.message ?? payload.error)}`,
            })
            complete = false
            continue
          }
          records.push(payload.payload.record)
          stats.push(payload.payload.stats)
          refs.push(payload.payload.refs)
          keep.add(commitKey(project.connectionId, project.projectId, payload.payload.record.commitId))
        }
        if (records.length) {
          withTransaction(db, () => {
            upsertCommits(db, records)
            replaceCommitStats(db, stats)
            replaceCommitRefs(db, refs)
          })
          commitCount += records.length
          progress.currentProjectCommitCount = commitCount
          progress.totalCommits = Number(progress.totalCommits ?? 0) + records.length
        }
        // 每 20 条刷一次进度（含错误计数）
        flushProgress(jobId, progress)
      }

      if (!result?.hasPagination) break
      if (!result.nextPage) break
    }
    if (page > MAX_PAGES) complete = false
    return { complete, commitCount }
  }

  /** 执行任务主流程。 */
  async function runJob(jobId) {
    const job = getSyncJob(db, jobId)
    if (!job) return null
    if (TERMINAL_STATUSES.has(job.status)) return jobView(job)
    const scope = job.scope ?? {}
    const progress = { ...(job.progress ?? {}) }
    if (progress.cancelRequested) {
      return finalize(jobId, SYNC_STATUS.CANCELLED, { progress })
    }
    updateSyncJob(db, jobId, { status: SYNC_STATUS.RUNNING })
    flushProgress(jobId, progress)

    const jobConnectionId = String(scope.connectionId ?? job.connectionId ?? '')
    const matcherCache = new Map()
    const clientCache = new Map()
    const keep = new Set()
    const completeByConnection = new Map()
    const projects = Array.isArray(scope.projects) ? scope.projects : []

    try {
      for (let index = 0; index < projects.length; index += 1) {
        if (isCancelled(jobId)) return finalize(jobId, SYNC_STATUS.CANCELLED, { progress })
        const connectionId = String(projects[index].connectionId || jobConnectionId)
        const project = { ...projects[index], connectionId }
        if (!clientCache.has(connectionId)) clientCache.set(connectionId, await clientFor(connectionId))
        const client = clientCache.get(connectionId)
        const matcher = await matcherFor(connectionId, matcherCache)

        progress.currentProjectId = project.projectId
        progress.currentProjectName = project.name ?? ''
        progress.currentProjectPath = project.pathWithNamespace ?? ''
        progress.currentProjectIndex = index + 1
        progress.currentProjectCommitCount = 0
        flushProgress(jobId, progress)

        upsertRepositories(db, [
          {
            connectionId,
            projectId: project.projectId,
            pathWithNamespace: project.pathWithNamespace,
            name: project.name,
          },
        ])

        const result = await syncProject({ jobId, client, project, matcher, scope, progress, keep })
        if (result.cancelled) return finalize(jobId, SYNC_STATUS.CANCELLED, { progress })
        if (result.complete) {
          progress.syncedProjects = Number(progress.syncedProjects ?? 0) + 1
          if (!completeByConnection.has(connectionId)) completeByConnection.set(connectionId, [])
          completeByConnection.get(connectionId).push({ connectionId, projectId: project.projectId })
        }
        progress.currentProjectCommitCount = result.commitCount
        flushProgress(jobId, progress)
      }

      if (isCancelled(jobId)) return finalize(jobId, SYNC_STATUS.CANCELLED, { progress })

      let completedCount = 0
      for (const [connectionId, completeProjects] of completeByConnection) {
        completedCount += completeProjects.length
        try {
          pruneCommits(db, {
            connectionIds: [connectionId],
            keepWindow: { startDate: scope.startDate, endDate: scope.endDate },
            projects: completeProjects,
            keep,
          })
        } catch (error) {
          recordError(jobId, progress, {
            stage: 'project_sync',
            message: `清理过期提交失败：${String(error?.message ?? error)}`,
          })
        }
      }

      const errorCount = Number(progress.errors ?? 0)
      const incompleteProjects = Math.max(0, projects.length - completedCount)
      progress.incompleteProjects = incompleteProjects
      const hadTrouble = errorCount > 0 || incompleteProjects > 0
      const anySuccess = Number(progress.totalCommits ?? 0) > 0 || completedCount > 0

      // 终态：完全成功 → succeeded；部分成功（有错误/未完整项目）→ succeeded + partial；
      // 零成功且有错误 → failed（见 CONTRACTS §4「实现偏差登记」）。
      if (!hadTrouble) return finalize(jobId, SYNC_STATUS.SUCCEEDED, { partial: false, progress })
      if (anySuccess) return finalize(jobId, SYNC_STATUS.SUCCEEDED, { partial: true, progress })
      return finalize(jobId, SYNC_STATUS.FAILED, { partial: true, progress })
    } catch (error) {
      recordError(jobId, progress, { stage: 'job', message: String(error?.message ?? error) })
      return finalize(jobId, SYNC_STATUS.FAILED, {
        partial: true,
        progress,
        errorMessage: String(error?.message ?? error),
      })
    }
  }

  return {
    coverage,
    getSelection,
    listCandidates,
    listCandidatesDetailed,
    saveSelection,
    status,
    start,
    cancel,
    waitForJob,
    listJobs,
  }
}
