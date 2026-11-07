/**
 * index.js —— `lib/domain/**` 的统一出口（任务可选交付，方便工具/API 层一次 import）。
 *
 * 关于 `persist.js`：它静态 `import '../db.js'`。`lib/db.js` 已由数据域落地，
 * 因此这里显式 re-export `upsertReport`（工具层 `report_update` 通过 `domain.upsertReport` 调用）。
 * 注意用**显式命名**而不是 `export *`：`persistCore.js` 与 `persist.js` 都导出
 * `upsertReportCore` / `REQUIRED_DB_API`，两个 star export 会形成歧义而双双消失。
 *
 * 已导出的能力分组：
 *   - 判定/分类：isMergeCommit / isCherryPickCommit / inferDomain / inferTopicTitle / repoPath / currentRefsBranch
 *   - 统计：aggregate / buildLineStats / buildRepoBranchStats / buildRepoCards / buildRealtimeAnalytics / slimRealtimeAnalytics
 *   - 主题：buildTopics
 *   - 取数：gatherCommits / toSlimCommit / 分页常量与 hint；某天明细：dayCommits / commitClock / MAX_DAY_COMMITS
 *   - 周期：getWeekRange / getMonthRange / getQuarterRange / getYearRange / makeRange
 *   - ID：REPORT_TYPES / buildReportId / parseReportId / formatReportType
 *   - 写作契约：getReportBrief / templateAndGuidance / HOST_INSTRUCTIONS / DEFAULT_TEMPLATES / DEFAULT_GUIDANCE
 *   - 边界归一：toCommitView / toCommitViews / text 工具
 *   - 写入：upsertReport（真实 db.js 绑定） / upsertReportCore（可注入 db API）
 */
export * from './brief.js'
export * from './briefDefaults.js'
export * from './classify.js'
export * from './commitView.js'
export * from './dayCommits.js'
export * from './gather.js'
export * from './ids.js'
export * from './period.js'
export * from './persistCore.js'
export * from './stats.js'
export * from './text.js'
export * from './topics.js'
export { upsertReport } from './persist.js'
