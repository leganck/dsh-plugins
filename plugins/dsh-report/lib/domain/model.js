/**
 * model.js —— 报告领域的 JSDoc 类型合集（无运行时导出）。
 *
 * 对应 workbench Go 的：
 *   - `internal/report/model.go:3-104`（AggregateStats / LineStat / RepoBranchStat / ReportTopic / CommitRecord / Stored*）
 *   - `internal/report/service.go:21-25,66-69,114-175`（DateRange / CommitView / RepoCard / RealtimeAnalytics / ReportResult / ReportBrief）
 *   - `internal/report/reports.go:6-62`（ListItem / Detail / Topic / StatsResult）
 *   - `internal/report/gather.go:15-51`（SlimCommit / GatherCommitsOpts / GatherCommitsResult）
 *
 * 命名约定（与 CONTRACTS.md §3 及 07 分册 §1.2 一致）：
 *   - **领域层一律 camelCase**；snake_case 只出现在 wire（HTTP/DB 行）边界。
 *   - `includeMerge` 的语义统一为「true = 全部提交（含 merge 与 cherry-pick）」，
 *     不是「只多算 merge」；false = 排除 merge 且排除 cherry-pick。
 *   - 空数组与 null 是两种不同结果（Go 侧 `make(...,0,n)` → `[]`；`var x []T` → `null`），
 *     领域函数返回 `[]`，wire 层负责映射 null。
 *
 * 本文件只有注释与 `export {}`，因为它只提供编辑器/测试可用的类型信息。
 */
export {}

/**
 * 周期区间（Go: `service.DateRange`）。
 * `period` 用 `" ~ "` 连接——注意与报告记录的 `" 至 "` 不一致，属 Go 现状，勿统一。
 * @typedef {Object} DateRange
 * @property {string} start `YYYY-MM-DD`
 * @property {string} end `YYYY-MM-DD`
 * @property {string} period `start + " ~ " + end`
 */

/**
 * 单条提交的库表投影（Go: `model.CommitRecord`，来自 commits ⨝ commit_stats ⨝ repositories ⨝ commit_branch_refs）。
 * @typedef {Object} CommitRecord
 * @property {string} connectionId
 * @property {string} commitId
 * @property {number} projectId
 * @property {string} message 提交正文（可多行）
 * @property {string} authoredDate 原始字符串（GitLab 返回值，**不做时区归一**）
 * @property {string} committedDate
 * @property {string} authorName
 * @property {string} authorEmail
 * @property {string} title 提交标题
 * @property {number} isMergeCommit 0/1
 * @property {number} isCherryPickCommit 0/1
 * @property {string} cherryPickSourceCommit 非空即视为 cherry-pick
 * @property {number} additions
 * @property {number} deletions
 * @property {number} total
 * @property {string} repoName
 * @property {string} repoNamespace
 * @property {string} pathWithNamespace 仓库全路径（repoPath 的首选键）
 * @property {string} primaryBranch `branch_order` 最小的分支
 * @property {string} branchNamesJson 分支名 JSON 数组字符串（DB 原样）
 */

/**
 * 领域计算使用的提交视图（Go: `service.CommitView` = CommitRecord + BranchNames）。
 * @typedef {CommitRecord & { branchNames: string[] }} CommitView
 */

/** @typedef {{ name: string, count: number }} NamedCount */
/** @typedef {{ date: string, count: number }} DateCount */
/** @typedef {{ repo: string, count: number }} RepoCount */

/**
 * 周期（含）内的聚合统计（Go: `model.AggregateStats`）。
 * - `totalCommits` **含** merge 与 cherry-pick；
 * - `totalAdditions/deletions/totalLines` 只累计「非 merge 且非 cherry-pick」；
 * - `nonMergeCommitCount = totalCommits - mergeCommitCount - cherryPickCommitCount`，可能为负（Go 无防御）。
 * @typedef {Object} AggregateStats
 * @property {number} totalCommits
 * @property {number} totalAdditions
 * @property {number} totalDeletions
 * @property {number} totalLines
 * @property {number} mergeCommitCount
 * @property {number} cherryPickCommitCount
 * @property {number} nonMergeCommitCount
 * @property {number} repoCount
 * @property {NamedCount[]} branchDistribution 计数降序
 * @property {DateCount[]} dateDistribution 日期字符串升序
 * @property {RepoCount[]} repoDistribution 计数降序
 * @property {NamedCount[]} domainDistribution 计数降序
 */

/**
 * 行数口径的一行（Go: `model.LineStat`，恒 2 行，顺序 [true, false]）。
 * `includeMerge=true` 行 = 全部提交（含 cherry-pick）；`false` 行 = 排除 merge 与 cherry-pick。
 * `pureAdditions = additions - deletions`，可为负。
 * @typedef {Object} LineStat
 * @property {boolean} includeMerge
 * @property {number} commits
 * @property {number} additions
 * @property {number} deletions
 * @property {number} total
 * @property {number} pureAdditions
 */

/**
 * 仓库×分支统计（Go: `model.RepoBranchStat`）。
 * 恒有 includeMerge=true 组；includeMerge=false 组仅在该组合存在非 merge/cherry 提交时生成。
 * @typedef {Object} RepoBranchStat
 * @property {boolean} includeMerge
 * @property {string} repoKey `repoPath(commit)`
 * @property {string} branchName `currentRefsBranch(commit)`
 * @property {number} commitCount
 * @property {number} additions
 * @property {number} deletions
 * @property {number} total
 */

/**
 * 落库/展示用的主题候选（Go: `model.ReportTopic` / `reports.Topic`）。
 * summary 是固定文案「{n} 次提交」，**不是** LLM 摘要。
 * @typedef {Object} ReportTopic
 * @property {string} domain
 * @property {string} topicTitle
 * @property {string} summary
 * @property {number} sortOrder 从 1 开始（按桶内提交数降序）
 */

/**
 * 仓库卡片里的分支行（Go: `service.RepoBranchCard`）。
 * @typedef {Object} RepoBranchCard
 * @property {string} branchName
 * @property {number} commitCount
 * @property {number} additions
 * @property {number} deletions
 * @property {number} total
 * @property {number} pureAdditions
 */

/**
 * 仓库卡片里的按日贡献（Go: `service.RepoContributionDay`；仅 authored_date 长度 >= 10 的提交进入）。
 * @typedef {Object} RepoContributionDay
 * @property {string} date
 * @property {number} count
 */

/**
 * 仓库卡片（Go: `service.RepoCard`）。
 * `includeMerge` 回写的是**入参**口径，不是「这张卡里是否真有 merge 提交」。
 * @typedef {Object} RepoCard
 * @property {boolean} includeMerge
 * @property {string} repoKey
 * @property {number} commitCount
 * @property {number} additions
 * @property {number} deletions
 * @property {number} total
 * @property {number} pureAdditions
 * @property {number} branchCount = branches.length
 * @property {RepoBranchCard[]} branches total 降 → commitCount 降
 * @property {RepoContributionDay[]} contributionDays 日期升序
 */

/**
 * `buildRepoCards` 的返回形状（Go: `BuildRepoCards` 的 map）。
 * `items` 与 `excludeMerge` 是**同一个数组引用**（Go 里也是同一个 slice），序列化时会重复输出。
 * @typedef {Object} RepoCardsResult
 * @property {RepoCard[]} includeMerge
 * @property {RepoCard[]} excludeMerge
 * @property {RepoCard[]} items 与 excludeMerge 同一引用
 */

/**
 * 实时统计（Go: `service.RealtimeAnalytics`）。
 * 注意：`repoBranchStats` 恒为 `[]`（Go 也如此，属历史字段）。
 * @typedef {Object} RealtimeAnalytics
 * @property {{ startDate: string, endDate: string }} range
 * @property {string} branchMode 协议常量
 * @property {string} branchAssignmentRule 协议常量
 * @property {Record<string, number>} summary
 * @property {LineStat[] | null} lineStats
 * @property {RepoBranchStat[]} repoBranchStats
 * @property {RepoCardsResult | Record<string, RepoCard[]> | null} repoCards
 * @property {DateCount[] | null} dateDistribution
 * @property {RepoCount[] | null} repoDistribution
 * @property {Record<string, unknown> | null} scriptLike 仅在显式请求 fields=scriptLike 时保留
 */

/**
 * 实时统计的裁剪参数（对应 Go `SlimRealtimeAnalytics` 的 `AnalyticsViewQuery`）。
 * @typedef {Object} AnalyticsViewQuery
 * @property {string} [include] `'excludeMerge'`（默认）或 `'includeMerge'`
 * @property {string[] | string} [fields] 白名单；空/未传 = 除 scriptLike 外全留
 * @property {number} [limit] repo 卡片截断条数；<=0 不截断
 * @property {string} [bucket] 仅接受、不参与计算（Go 现状，保留以对齐 wire）
 */

/**
 * 分页取数的选项（Go: `gather.GatherCommitsOpts`）。
 * @typedef {Object} GatherCommitsOpts
 * @property {string} [repo] 仓库子串过滤（path_with_namespace / repo_name / namespace）
 * @property {number} [limit] 默认 40，上限 80
 * @property {number} [offset] 负数按 0 处理
 * @property {boolean} [includeMerge] 默认 false = 排除 merge 与 cherry-pick
 */

/**
 * 瘦投影后的单条提交（Go: `gather.SlimCommit`）。
 * Go 用 `omitempty`：`merge`/`cherry_pick` 为 false、`commit_id` 为空、`branch` 为空时**整键消失**。
 * @typedef {Object} SlimCommit
 * @property {string} date authoredDate 前 10 位；不足 10 位为 `""`
 * @property {string} title 空标题时回退 message 首行
 * @property {string} repo
 * @property {string} domain
 * @property {string} [branch] 可能因 omitempty 缺键
 * @property {number} additions
 * @property {number} deletions
 * @property {boolean} [merge] 仅 true 时存在
 * @property {boolean} [cherry_pick] 仅 true 时存在
 * @property {string} [commit_id] 前 8 位；为空时缺键
 */

/**
 * 一页瘦投影（Go: `gather.GatherCommitsResult`）。
 * `repo`/`nextOffset`/`hint` 为零值时整键消失（Go `omitempty`）。
 * @typedef {Object} GatherCommitsResult
 * @property {string} startDate
 * @property {string} endDate
 * @property {string} [repo]
 * @property {boolean} includeMerge
 * @property {number} offset
 * @property {number} limit
 * @property {number} total 过滤后的总条数
 * @property {number} count 本页条数
 * @property {boolean} hasMore
 * @property {number} [nextOffset] 仅 hasMore 时存在
 * @property {boolean} truncated 恒等于 hasMore
 * @property {string} [hint]
 * @property {SlimCommit[]} commits
 */

/**
 * 写作契约（Go: `service.ReportBrief`）。
 * @typedef {Object} ReportBrief
 * @property {string} reportType
 * @property {string} reportTypeLabel 周报/月报/季报/年报
 * @property {string} startDate
 * @property {string} endDate
 * @property {string} period `startDate + " 至 " + endDate`
 * @property {string} template 已把占位符替换为实际周期
 * @property {string} guidance
 * @property {string} hostInstructions
 */

/**
 * `upsertReport` 的入参（Go: `Service.UpsertReport(reportType, startDate, endDate, content)`）。
 * @typedef {Object} UpsertReportInput
 * @property {string} type `week|month|quarter|year`
 * @property {string} startDate `YYYY-MM-DD`
 * @property {string} endDate `YYYY-MM-DD`
 * @property {string} content 报告正文 Markdown（落库前 trim；空 → status=empty）
 * @property {string} [status] 显式覆盖状态（默认由 content 是否为空推导）
 */

/**
 * `upsertReport` 的返回值（CONTRACTS.md §3：只回这 5 个键）。
 * @typedef {Object} UpsertReportResult
 * @property {string} reportId `type:startDate:endDate`
 * @property {AggregateStats} aggregates
 * @property {LineStat[]} lineStats
 * @property {RepoBranchStat[]} repoBranchStats
 * @property {ReportTopic[]} topics
 */

/**
 * `lib/db.js` 中本领域模块会用到的函数子集（CONTRACTS.md §2）。
 * 用鸭子类型注入，测试可传 fake；真实实现由数据域提供。
 * @typedef {Object} ReportDbApi
 * @property {(db: unknown, query: { startDate: string, endDate: string }) => Array<Record<string, unknown>>} listCommitsInPeriod
 * @property {(db: unknown, row: Record<string, unknown>) => void} upsertReportRow
 * @property {(db: unknown, reportId: string, rows: LineStat[]) => void} replaceLineStats
 * @property {(db: unknown, reportId: string, rows: RepoBranchStat[]) => void} replaceRepoBranchStats
 * @property {(db: unknown, reportId: string, rows: ReportTopic[]) => void} replaceTopics
 * @property {(db: unknown, fn: () => void) => unknown} [withTransaction]
 * @property {(db: unknown, reportId: string, aggregates: AggregateStats) => void} [upsertReportAggregates]
 */
