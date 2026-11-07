# dsh-report 插件 · 模块契约与并行开发边界

> 所有并行开发都以本文件为准。模块之间只通过这里声明的接口交互；任何偏差先改本文件再改代码。

## 0. 写入边界（避免互相覆盖）

| 角色 | 唯一可写目录/文件 |
|---|---|
| Lead | `index.js`、`lib/services.js`、`lib/config.js`、`client-src/00-*.js`、`client-src/99-*.js`、`scripts/`、`package.json`、`locale/**`、`README.md` |
| domain | `lib/domain/**`、`test/domain/**` |
| data | `lib/db.js`、`lib/gitlab.js`、`lib/matcher.js`、`lib/sync.js`、`test/data/**` |
| tools-api | `lib/tools.js`、`lib/api.js`、`test/api/**` |
| ui | `client-src/10-*.js` 至 `client-src/90-*.js` |

客户端多文件最终由 `scripts/build-client.mjs` 按文件名排序拼成 `lib/client.js`（生成物，勿手改）。
禁止修改 `lib/client.js`；改 `client-src/`。

## 1. 运行时与数据

- Host：ESM，Node 24.21（桌面 host 实测）。数据目录 `<DSH_HOME>/dsh-report/`，DB `report.db`（`node:sqlite`，WAL）。
- 报告 ID：`<type>:<startDate>:<endDate>`，type ∈ `week|month|quarter|year`。同 ID 重存 = 覆盖。
- 日期口径（复刻 workbench，勿"顺手修正"）：分日取 `authored_date` 字符串前 10 位；区间比较用 `'YYYY-MM-DD'` 前缀比较；时区配置只用于**显示与周期计算**，不改已存日期。
- 行数口径：`includeMerge=false` 时排除 merge 与 cherry-pick；`includeMerge=true` 表示"全部提交（含 cherry-pick）"。

## 2. SQLite 表（`lib/db.js` 负责建表与读写）

```sql
meta(key TEXT PRIMARY KEY, value TEXT)
connections(connection_id TEXT PRIMARY KEY, base_url TEXT, display_name TEXT, username TEXT, created_at TEXT)
repositories(connection_id TEXT, project_id INTEGER, path_with_namespace TEXT, name TEXT, PRIMARY KEY(connection_id, project_id))
commits(connection_id TEXT, project_id INTEGER, commit_id TEXT, message TEXT, authored_date TEXT,
        committed_date TEXT, author_name TEXT, author_email TEXT, title TEXT,
        is_merge_commit INTEGER DEFAULT 0, is_cherry_pick_commit INTEGER DEFAULT 0,
        cherry_pick_source_commit TEXT, created_at TEXT,
        PRIMARY KEY(connection_id, project_id, commit_id))
commit_stats(connection_id TEXT, project_id INTEGER, commit_id TEXT, additions INTEGER, deletions INTEGER, total INTEGER,
             PRIMARY KEY(connection_id, project_id, commit_id))
commit_branch_refs(connection_id TEXT, project_id INTEGER, commit_id TEXT, branch_name TEXT, branch_order INTEGER,
                   PRIMARY KEY(connection_id, project_id, commit_id, branch_name))
selected_projects(connection_id TEXT, project_id INTEGER, path_with_namespace TEXT, name TEXT, enabled INTEGER DEFAULT 1,
                  PRIMARY KEY(connection_id, project_id))
sync_jobs(job_id TEXT PRIMARY KEY, connection_id TEXT, status TEXT, started_at TEXT, finished_at TEXT,
          progress_json TEXT, scope_json TEXT, error TEXT)
sync_job_errors(job_id TEXT, project_id INTEGER, commit_id TEXT, stage TEXT, message TEXT, created_at TEXT)
reports(report_id TEXT PRIMARY KEY, report_type TEXT, period_start TEXT, period_end TEXT, status TEXT,
        content TEXT, error_message TEXT, generated_at TEXT, updated_at TEXT)
report_aggregates(report_id TEXT PRIMARY KEY, stats_json TEXT)
report_line_stats(report_id TEXT, include_merge INTEGER, additions INTEGER, deletions INTEGER, total INTEGER,
                  pure_additions INTEGER, PRIMARY KEY(report_id, include_merge))
report_repo_branch_stats(report_id TEXT, include_merge INTEGER, repo_key TEXT, branch_name TEXT, commit_count INTEGER,
                         additions INTEGER, deletions INTEGER, total INTEGER,
                         PRIMARY KEY(report_id, include_merge, repo_key, branch_name))
report_topics(report_id TEXT, sort_order INTEGER, domain TEXT, topic_title TEXT, summary TEXT,
              PRIMARY KEY(report_id, sort_order))
```

`lib/db.js` 导出：
```js
export function openDatabase(dbPath): Database        // 建表 + PRAGMA + user_version
export function withTransaction(db, fn): T            // BEGIN IMMEDIATE / COMMIT / ROLLBACK
// commits
export function upsertCommits(db, records): void      // 批量，事务内
export function replaceCommitStats(db, records): void
export function replaceCommitRefs(db, records): void
export function upsertRepositories(db, records): void
export function listCommitsInPeriod(db, { connectionIds?, startDate, endDate }): CommitRow[]
export function selectedProjects(db, connectionId): SelectedProjectRow[]
export function saveSelectedProjects(db, connectionId, rows): void
export function pruneCommits(db, { connectionIds, keepWindow, projects }): void   // P2
// reports
export function upsertReportRow(db, row): void
export function getReportRow(db, reportId): ReportRow | null
export function listReportRows(db): ReportRow[]
export function deleteReportRow(db, reportId): boolean
export function replaceLineStats(db, reportId, rows): void
export function listLineStats(db, reportId): LineStatRow[]
export function replaceRepoBranchStats(db, reportId, rows): void
export function listRepoBranchStats(db, reportId): RepoBranchStatRow[]
export function replaceTopics(db, reportId, rows): void
export function listTopics(db, reportId): TopicRow[]
// sync jobs
export function createSyncJob(db, row): void
export function updateSyncJob(db, jobId, patch): void
export function getSyncJob(db, jobId): SyncJobRow | null
export function appendSyncJobError(db, row): void
export function listSyncJobs(db, limit): SyncJobRow[]
```

## 3. 领域模块（`lib/domain/**`，纯函数、零 IO）

输入/输出字段名与 workbench Go JSON 一致（camelCase，见 01/07 分册）。必须导出：

```js
// model.js —— 仅 JSDoc 类型，不导出运行时值（可空文件）
// classify.js
export function isMergeCommit(commit): boolean
export function isCherryPickCommit(commit): boolean
export function inferDomain(commit): string            // 6 条硬编码规则；默认 '其他业务'
export function inferTopicTitle(commit): string        // 冒号后段，回退 title
export function repoPath(commit): string               // path_with_namespace || repo_name
export function currentRefsBranch(commit): string
// stats.js
export function aggregate(commits): AggregateStats
export function buildLineStats(commits): LineStat[]     // 3 口径
export function buildRepoBranchStats(commits): RepoBranchStat[]
export function buildRepoCards(commits): Record<string, RepoCard>
export function buildRealtimeAnalytics(startDate, endDate, commits, opts?): RealtimeAnalytics
// topics.js
export function buildTopics(commits): ReportTopic[]
// gather.js
export function gatherCommits(commits, startDate, endDate, opts): GatherCommitsResult
// period.js（前端口径：本地时区，周一为周首日）
export function getWeekRange(now): DateRange
export function getMonthRange(now): DateRange
export function getQuarterRange(now): DateRange
export function getYearRange(now): DateRange
export function makeRange(start, end): DateRange
// ids.js
export function buildReportId(type, startDate, endDate): string
export function parseReportId(reportId): { type, startDate, endDate } | null
export const REPORT_TYPES
export function formatReportType(type): string          // 周报/月报/季报/年报
// brief.js
export function getReportBrief({ type, startDate, endDate, template, guidance }): ReportBrief
export const HOST_INSTRUCTIONS
// briefDefaults.js
export const DEFAULT_TEMPLATES   // { week, month, quarter, year }
export const DEFAULT_GUIDANCE
// persist.js
export function upsertReport(db, { type, startDate, endDate, content, status? }): { reportId, aggregates, lineStats, repoBranchStats, topics }
// dayCommits.js（对齐 upstream 2026-11 新增：统计页点开某一天）
export function dayCommits(commits, date, repoKey): DayCommitPage
//   date: 'YYYY-MM-DD'；repoKey 空串/未传 = 全部仓库，否则按 repoPath() 小写精确匹配
//   Time 用本地时区 HH:mm（解析 RFC3339/RFC3339Nano/'YYYY-MM-DD HH:mm:ss'，失败再退化截取）
//   上限 200 条；truncated=total>200；merge/cherry 标记保留
```

移植参考：`docs/plugin-extraction/01-domain-core.md`、`07-route-b-domain-port.md`（含逐函数表与 `file:line`），原始 Go 代码在 `internal/report/`。

## 4. GitLab / 同步（`lib/gitlab.js`、`lib/matcher.js`、`lib/sync.js`）

```js
// gitlab.js
export function createGitLabClient({ baseUrl, token, fetchImpl? }): {
  getCurrentUser(), getUserEmails(), listMembershipProjects({ page, perPage }),
  listCommits(projectId, { since, until, page, perPage, all, orderBy, sort }),
  getCommit(projectId, sha), getCommitRefs(projectId, sha),
}
// matcher.js
export function buildCommitMatcher({ user, userEmails, aliases }): (commit) => { matched: boolean, evidence?: string }
// sync.js
export function createSyncService({ db, config, gitlabForConnection, logger }): {
  coverage({ connectionId, startDate, endDate }), getSelection(connectionId),
  listCandidates({ connectionId, q }), saveSelection(connectionId, projects),
  status(jobId?), start({ connectionId, startDate, endDate, projectIds? }), cancel(jobId),
}
```

同步语义（复刻 workbench，简化项已确认）：
- 拉取窗口：`since=startDate 00:00`、`until=endDate 23:59:59`（本机时区字符串，GitLab 接口约定）；拉回后按 `authored_date` 前 10 位二次过滤到区间。
- 分页：`per_page=100`，`all=true`，`order_by=created_at`，`sort=desc`；终止条件 `x-next-page` 空且本页非空；**分页头缺失视为 incomplete（不 prune）**。
- 每个命中提交：detail 取 stats；refs 取 branch 列表（按数组序写 `branch_order`）。
- 并发：项目串行、页串行、页内 ≤8 worker、每 20 条批量写 + 每 20 条刷新进度。
- 唯一键 `(connection_id, project_id, commit_id)`；重复同步 upsert。
- `matcher` 规则见 `docs/plugin-extraction/05-route-b-data-acquisition.md` §③，evidence 标签固定为 4 种（`commit_email`、`verified_email`、`identity`、`coauthor`）。

### 4.1 实现偏差登记（Lead 已确认，2026-11-06）

数据层实现（`lib/db.js` / `lib/gitlab.js` / `lib/matcher.js` / `lib/sync.js`）与 workbench Go 的**有意差异**；实现与测试以此为准，parity 对比时不要按 Go 行为“修正”：

| # | 项目 | 本实现 | workbench Go 原行为 | 理由 / 影响 |
|---|---|---|---|---|
| D1 | matcher 的 `evidence` 标签 | 4 种：`commit_email`（命中 profile 的 commit_email/email/public_email）、`verified_email`（命中 `/user/emails` 或含 `@` 的别名）、`identity`（命中 name/username/别名）、`coauthor`（Co-authored-by trailer） | 6 种：`verified_author_email` / `verified_committer_email` / `author_alias` / `committer_alias` / `co_author_verified_email` / `co_author_alias` | parity 关注「命中/未命中」与最终落库集合，不关注内部标签枚举；4 种按身份来源归类，更稳定、可读。**匹配顺序、lower+trim 口径与 Go 完全一致**。 |
| D2 | 部分失败的终态 | 有任意项目/提交成功落库时：`succeeded` + `progress.partial=true` + `progress.errors>0`（另带 `progress.incompleteProjects`）；只有「零成功 + 有错误」才 `failed` | `completed_with_errors` | 契约状态机只有 `succeeded/failed/cancelled` 三态；`failed` 语义过重会让 UI 误判整次同步失败。覆盖度/UI 按 `partial` 显示警告。**prune 仍只对完整翻页的项目生效**。 |
| D3 | 两个返回形状 + 超集导出 | `sync.listCandidates(...)` 返回**项目数组**（不是 `{projects}`）；`sync.cancel(jobId)` 返回 **boolean**（是否受理取消）；`lib/db.js` 在 §2 名单之外额外导出 `upsertReportAggregates`、`upsertConnection`、`getConnection`、`listConnections`、`getActiveSyncJob`、`listSyncJobErrors`、`commitKey`、`closeDatabase`、`getMeta`、`setMeta`、`listCoverageRows`、`nowIso`、`SCHEMA_VERSION` | Go 侧对应能力分别是 `[]map[string]any` 与 `error` | 与 `lib/api.js` / `lib/tools.js` 的实际消费形状对齐（它们按数组取候选、按 `Boolean()` 取取消结果）；超集导出供 `index.js` 接线与测试使用，不改变 §2 已登记函数的语义。 |

## 5. HTTP API（`lib/api.js`，Server 侧；路径前缀 `/plugins/dsh-report/api`）

全部返回 JSON（`content-type: application/json`），错误统一 `{ error: string, message?: string }` + 4xx/5xx。

| Method | Path | Query/Body | Response |
|---|---|---|---|
| GET | `/ping` | — | `{ ok, build, node, dbPath, dbAvailable, reports, timezone }` |
| GET | `/config` | — | `{ gitlab: { baseUrl, tokenRef, hasToken }, timezone, defaultReportType, dataDir }` |
| PUT | `/config` | `{ gitlab?: { baseUrl, token? }, timezone?, defaultReportType? }` | 同 GET；token 走 credentials 记录，非明文 |
| GET | `/reports` | — | `{ reports: ReportListItem[] }` |
| GET | `/reports/:id` | `includeContent=0` | `ReportDetail`（含 topics） |
| GET | `/reports/:id/stats` | — | `{ stats, lineStats, repoBranchStats }` |
| GET | `/reports/:id/export` | `format=markdown` | `text/markdown` 正文 |
| DELETE | `/reports/:id` | — | `{ deleted: boolean }` |
| GET | `/line-stats` | `startDate,endDate,include,fields?,limit?` | `RealtimeAnalytics` |
| GET | `/reports/day-commits` | `date=YYYY-MM-DD&repo?` | `DayCommitPage`（见 §5.1） |
| GET | `/gitlab/connections` | — | `{ connections: [{ id, baseUrl, displayName, username, hasToken }] }` |
| POST | `/gitlab/connections` | `{ baseUrl, token, displayName? }` | 连接；验证 `/user` |
| GET | `/gitlab/projects` | `connectionId, q?, refresh?` | `{ projects: [{ id, pathWithNamespace, name }] }` |
| GET | `/gitlab/selection` | `connectionId` | `{ projects: SelectedProject[] }` |
| PUT | `/gitlab/selection` | `{ connectionId, projects: [{ id, pathWithNamespace, name }] }` | `{ saved: true }` |
| GET | `/sync/coverage` | `connectionId, startDate, endDate` | `{ summary: {...}, repos: [...], dateDistribution: [...] }` |
| GET | `/sync/jobs` | `limit?` | `{ jobs: SyncJobView[] }` |
| POST | `/sync/start` | `{ connectionId, startDate, endDate, projectIds? }` | `{ jobId }` |
| POST | `/sync/cancel` | `{ jobId }` | `{ cancelled: boolean }` |
| GET | `/templates` | — | `{ templates: { week, month, quarter, year }, guidance: {...} }` |
| PUT | `/templates` | 同上 | `{ saved: true }` |

`ReportListItem`：`{ id, type, periodStart, periodEnd, status, totalCommits, generatedAt }`（camelCase；与 01 分册的 Go JSON 映射在 api 层完成）。
`ReportDetail`：`{ id, type, periodStart, periodEnd, status, content, generatedAt, errorMessage, totalCommits, totalAdditions, totalDeletions, totalLines, mergeCommitCount, cherryPickCommitCount, nonMergeCommitCount, repoCount, branchDistribution, dateDistribution, domainDistribution, topics }`。
其中三个 distribution 在 API 层已 `JSON.parse` 成数组：`branchDistribution: [{name,count}]`、`dateDistribution: [{date,count}]`、`domainDistribution: [{name,count}]`。

### 5.1 其它响应形状（页面按此渲染）

```js
// GET /reports/:id/stats
{ stats: ReportDetail, lineStats: [{ includeMerge, additions, deletions, total, pureAdditions }],
  repoBranchStats: [{ includeMerge, repoKey, branchName, commitCount, additions, deletions, total }] }

// GET /line-stats?startDate&endDate&include
{ range: { startDate, endDate }, branchMode, branchAssignmentRule,
  summary: { totalCommits, repoCount, branchCount, mergeCommits, cherryPickCommits,
             additions, deletions, total, net, pureAdditions },
  lineStats: LineStat[], repoBranchStats: [] /* Go 恒空，勿填 */,
  repoCards: { excludeMerge: [...], includeMerge: [...] },
  dateDistribution: [{date,count}], repoDistribution: [{repo,count}], scriptLike: {...},
  view: { include, fields, limit } }

// GET /gitlab/connections → { connections: [{ id, baseUrl, displayName, username, hasToken }] }
// GET /gitlab/projects?connectionId&q → { projects: [{ id, pathWithNamespace, name }] }
// GET /gitlab/selection?connectionId → { projects: [{ id, pathWithNamespace, name, enabled }] }
// GET /sync/coverage?connectionId&startDate&endDate
// 兼容形状（api 层映射）：summary 同时有约定键与原字段
{ summary: { commits, additions, deletions, days, repos,
             repoCount, commitCount, activeDayCount, firstCommitDate, lastCommitDate },
  repos: [{ repoKey, pathWithNamespace, commitCount, additions, deletions }],
  dateDistribution: [{date,count}] }
// GET /sync/jobs → { jobs: [{ jobId, connectionId, status, startDate?, endDate?, startedAt, finishedAt,
//   progress: { projectsDone, projectsTotal, commitsSynced, currentProject?,
//               partial?, errors?, incompleteProjects? }, error }] }
//   partial/errors/incompleteProjects 仅在存在时输出（部分失败 = status:succeeded + partial:true）。
// GET /templates → { templates: { week, month, quarter, year }, guidance: { week, month, quarter, year } }
// GET /config → { dataDir, timezone, defaultReportType, gitlab: { baseUrl, tokenRef, hasToken } }

// GET /reports/day-commits?date=2026-11-05&repo=crm/order
{ date: '2026-11-05', repo: 'crm/order', total: 37, truncated: false,
  commits: [{ time: '09:42', title: '修复订单导出', repo: 'crm/order', branch: 'dev',
              additions: 12, deletions: 3, commitId: 'a1b2c3d4', merge: false, cherryPick: false }] }

### 5.2 生成端点（UI 触发）

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/reports/generate` | `{ type, startDate, endDate, guidance? }` | `{ reportId, sessionId }` |

Host 侧实现：创建/复用 DSH 会话（`ctx.sessionController.create` + `prompt`），prompt 文案要求模型调用
`report_brief → report_stats → report_commits → report_update`；页面通过轮询 `/reports` 等待落库。

### 5.3 三处语义（已确认，api/UI 按此实现）

1. `GET /sync/jobs` 的每项必须投影 `startDate`/`endDate`（从 `sync_jobs.scope_json` 解析），
   并保留 `connectionId`。UI 任务历史表用它显示窗口；缺字段时回退 connectionId。
2. `POST /gitlab/connections`：**幂等 upsert + 校验**。请求 `{ baseUrl, token?, displayName? }`：
   有 token 时先 `GET /user` 验证，再按 `connection_id = sha256(baseUrl)[:24]` upsert 到 `connections` 表；
   无 token 时只校验已有记录并返回 `hasToken=false`。返回 `{ connection: { id, baseUrl, username, hasToken } }`。
3. `PUT /templates`：**部分更新**。只覆盖请求中出现的键；`templates[type]` / `guidance[type]` 为空字符串表示
   "清除覆盖、回退内置默认"；省略键保持不变。响应返回生效后的全部模板与 guidance。

### 5.4 连接解析与内部诊断端点

- `GET /gitlab/*` 与同步使用 `connections` 表里该连接的 `base_url`（多连接）；配置里的 `gitlab.baseUrl` 只作为单连接回退。
- GitLab token 仍是单个全局凭据（`dsh-report/gitlab-token`），连接之间共享；这是当前实现与 workbench 多连接 token 的已知差异。
- `GET /plugins/dsh-report/api/client-hello?build=`：内部诊断端点（非公开契约），客户端挂载后上报一次，用于确认页面已加载最新客户端；host 启动日志会记录 `client-hello`。

## 6. 工具（`lib/tools.js`，9 个）

与 workbench 同名同参（见 03 分册），实现改为插件内部：

| 工具 | 参数要点 |
|---|---|
| `report_brief` | `type`, `startDate`, `endDate`（后两者必填） |
| `report_stats` | `type?`, `startDate?`, `endDate?`, `reportId?` |
| `report_commits` | `startDate`, `endDate`, `repo?`, `limit?`(40/80), `offset?`, `includeMerge?` |
| `report_update` | `type`, `startDate`, `endDate`, `content` |
| `report_list` | 无参 |
| `report_get` | `reportId` |
| `report_export` | `reportId`（32k 截断） |
| `report_delete` | `reportId` |
| `report_sync` | `action` ∈ coverage/get_selection/list_candidates/save_selection/status/start/cancel；`all_selected_projects` 二次确认；`sandbox_permissions` 不适用于本插件 |

结果统一 `{ content: [{type:'text', text}], structuredContent: {...} }`；`output.render` 用 text 摘要。

## 7. 客户端（`client-src/**` → `lib/client.js`）

构建：`node scripts/build-client.mjs`：按文件名排序拼接，外层由 `00-header.js` 打开
`window.__ModuleLoader__.load({ id:'@local/dsh-report', factory(require){ ... React ... }})`，
`99-apply.js` 负责 `apply(ctx)` 与两处 slot（`sidebar.footer.action`、`shell.overlay`）。

已有基础（Lead 维护，勿改）：`10-store.js`（state/actions/api/格式化/useStore/useOpen/showToast/bootstrap）、
`20-icons.js`（图标）、`30-primitives.js`（Button/IconButton/Input/Textarea/Select/Field/Tabs/Badge/Dialog/Spinner/EmptyState/Toast）、
`40-markdown.js`（`Markdown({text})`、`renderMarkdown(text)`）、`99-apply.js`（外壳与文案字典）。

### 7.1 组件契约（DSH 框架集成）

插件不再自绘全屏窗口，按 DSH 插槽集成（与 `@local/smartpos-delivery` 一致）：

| 插槽 | 注册 | 组件 | 职责 |
|---|---|---|---|
| `sidebar.panellist` | id=`dsh-report`, order=40 | `PanelIcon` | 左侧栏「报告与统计」图标（props: size/active） |
| `main` | key=`dsh-report`, inject→{t} | `ReportsPanel` | 整页面板：标题行 + 「报告/统计」页签 + 左右分栏；报告页签挂 `ReportRail`+`ReportMain`，统计页签挂 `StatsAside`+`StatsMain` |
| `settings.section` | id=`dsh-report`, order=50 | `ReportSettings` | DSH 设置页分区，复用 `SettingsPage`（连接/时区/模板） |

组件文件职责不变：`50-tree.js`（ReportRail/ReportGenerateDialog）、`60-report.js`（ReportMain）、
`70-stats.js`（StatsAside/StatsMain/StatsPanel）、`80-sync.js`（SyncPage/SettingsPage）、
`99-apply.js`（插槽注册、页面骨架、视觉层、语言包）。

## 8. 配置（`cordis.patch.yml` 行 config）

```yaml
dataDir: ''                 # 空 = <DSH_HOME>/dsh-report
gitlab:
  baseUrl: ''
  tokenRef: 'dsh-report/gitlab-token'
timezone: 'Asia/Shanghai'
defaultReportType: 'week'
```
运行时写配置走 `ctx.configEditor.edit(entry, ...)`（Host），失败要显式报错。

## 9. 验收

- `node scripts/build-client.mjs` 无语法错误；`node --check lib/client.js` 通过。
- Host：`report_status` 可用；9 个工具出现在 Tool 列表。
- API：上表端点用 curl/Invoke-WebRequest 逐一验证 200/4xx。
- 页面：DSH Web UI 侧栏「报告」按钮打开工作台；列表/详情/统计/同步可用。
- 领域：`test/domain/` 至少覆盖 merge/cherry-pick 叠加、跨时区日期、分页边界、topic 归属；与 Go 侧口径逐字段对比（fixture）。


### 5.5 提交作者别名

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/gitlab/author-aliases` | 返回 `{ aliases: string[] }`；来源 `<数据目录>/author-aliases.json` |
| PUT | `/gitlab/author-aliases` | body `{ aliases: string[] | string }`（换行/逗号分隔也可），去重后落盘 |
| POST | `/gitlab/suggest-author-aliases` | body `{ connectionIds?, existingAliases? }`；返回 `{ success, connections[], suggestedAliases, mergedAliases, message }`，每个连接含 `username/displayName/knownIdentities/candidates[{value,kind,count}]/sampledEvents/sampledCommits/error` |

推断规则与 workbench `internal/repository/gitlab/author_aliases.go` 一致：
采样最近 3 页 push 事件（每页 50）的头提交，最多 120 个；已知身份取 `/user` 的
commit_email/email/public_email/username/name + `/user/emails`；候选出现次数需 ≥3 且 ≥最高频的 50%。
`/config` 的 `gitlab.authorAliases` 同步暴露当前别名。
