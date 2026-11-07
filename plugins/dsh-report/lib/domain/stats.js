/**
 * stats.js —— 确定性统计投影（行数口径 / 仓库分支 / 仓库卡片 / 实时分析）。
 *
 * 逐函数对应 workbench：
 *   - `internal/report/analytics.go:9-59`   `Aggregate`
 *   - `internal/report/analytics.go:61-100` `BuildLineStats`
 *   - `internal/report/analytics.go:102-143` `BuildRepoBranchStats`
 *   - `internal/report/analytics.go:145-153` `BuildRepoCards`
 *   - `internal/report/topics.go:105-136,138-206` 排序 helper 与 `buildRepoCardList`
 *   - `internal/report/analytics.go:155-219` `BuildRealtimeAnalytics`
 *   - `internal/report/analytics.go:228-273` `SlimRealtimeAnalytics`
 *
 * 三种行数口径（07 分册 §3.2，最易混）：
 *   ① 全部提交（含 merge + cherry-pick）        → LineStat{includeMerge:true}
 *   ② 排除 merge 与 cherry-pick（报告概览口径） → LineStat{includeMerge:false} 与 aggregate.total*
 *   ③ 提交计数差：nonMergeCommitCount = total - merge - cherry（可能为负）
 * 不存在「含 cherry-pick 但排除 merge」的口径；`includeMerge=true` 不等于「只多算 merge」。
 *
 * 排序口径（07 分册 §3.9）：
 *   Go 的 `sort.Slice` 不稳定、遍历源是 map，计数并列时顺序不定；
 *   本实现用 `Array.prototype.sort`（稳定）+ `Map` 插入序，**并列顺序可能与 Go 不同**（允许差异）。
 */
import {
  currentRefsBranch,
  inferDomain,
  isCherryPickCommit,
  isMergeCommit,
  repoPath,
} from './classify.js'
import { toInt, toStr } from './text.js'

/** 协议常量（Go `analytics.go:181`，逐字节一致，前端/日志可能直接展示）。 */
export const BRANCH_MODE = 'current_refs_first_auxiliary'
/** 协议常量（Go `analytics.go:182`）。 */
export const BRANCH_ASSIGNMENT_RULE =
  'repository stats are grouped by repo; current refs first branch is auxiliary only'

/**
 * map 计数 +1。
 * @param {Map<string, number>} map
 * @param {string} key
 */
function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * 计数降序（Go `sortNamedCount` / `sortRepoCount` 的排序键；并列顺序见文件头）。
 * @param {Map<string, number>} map
 * @returns {import('./model.js').NamedCount[]}
 */
function sortNamedCount(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)
}

/**
 * 日期字符串升序（Go `sortDateCount`）。
 * @param {Map<string, number>} map
 * @returns {import('./model.js').DateCount[]}
 */
function sortDateCount(map) {
  return [...map.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0))
}

/**
 * 仓库计数降序（Go `sortRepoCount`）。
 * @param {Map<string, number>} map
 * @returns {import('./model.js').RepoCount[]}
 */
function sortRepoCount(map) {
  return [...map.entries()]
    .map(([repo, count]) => ({ repo, count }))
    .sort((left, right) => right.count - left.count)
}

/**
 * 取提交行数（DB 缺失统计列时按 0，对应 Go SQL 的 COALESCE(...,0)）。
 * @param {import('./model.js').CommitView} commit
 * @returns {{ additions: number, deletions: number, total: number }}
 */
function lineCounts(commit) {
  return {
    additions: toInt(commit?.additions),
    deletions: toInt(commit?.deletions),
    total: toInt(commit?.total),
  }
}

/**
 * 聚合统计（Go `Aggregate`）。
 *
 * 单次遍历：行数只累计「非 merge 且非 cherry-pick」；`repoCount` 用 Set 去重；
 * `dateDistribution` 仅在 `authoredDate.length >= 10` 时取前 10 位计数
 * （长度不足的提交仍计入 totalCommits 与其它三个分布）。
 * @param {import('./model.js').CommitView[]} commits
 * @returns {import('./model.js').AggregateStats}
 */
export function aggregate(commits) {
  const list = Array.isArray(commits) ? commits : []
  let additions = 0
  let deletions = 0
  let totalLines = 0
  let mergeCommitCount = 0
  let cherryPickCommitCount = 0
  /** @type {Set<string>} */
  const repoSet = new Set()
  /** @type {Map<string, number>} */
  const branchDistribution = new Map()
  /** @type {Map<string, number>} */
  const dateDistribution = new Map()
  /** @type {Map<string, number>} */
  const repoDistribution = new Map()
  /** @type {Map<string, number>} */
  const domainDistribution = new Map()

  for (const commit of list) {
    const isMerge = isMergeCommit(commit)
    const isCherryPick = isCherryPickCommit(commit)
    if (!isMerge && !isCherryPick) {
      const counts = lineCounts(commit)
      additions += counts.additions
      deletions += counts.deletions
      totalLines += counts.total
    }
    const repo = repoPath(commit)
    repoSet.add(repo)
    if (isMerge) mergeCommitCount += 1
    if (isCherryPick) cherryPickCommitCount += 1
    const authoredDate = toStr(commit?.authoredDate)
    if (authoredDate.length >= 10) increment(dateDistribution, authoredDate.slice(0, 10))
    increment(branchDistribution, currentRefsBranch(commit))
    increment(repoDistribution, repo)
    increment(domainDistribution, inferDomain(commit))
  }

  return {
    totalCommits: list.length,
    totalAdditions: additions,
    totalDeletions: deletions,
    totalLines,
    mergeCommitCount,
    cherryPickCommitCount,
    // Go 直接减，不 clamp：一条提交同时是 merge 与 cherry-pick 时可能为负（保留负值）
    nonMergeCommitCount: list.length - mergeCommitCount - cherryPickCommitCount,
    repoCount: repoSet.size,
    branchDistribution: sortNamedCount(branchDistribution),
    dateDistribution: sortDateCount(dateDistribution),
    repoDistribution: sortRepoCount(repoDistribution),
    domainDistribution: sortNamedCount(domainDistribution),
  }
}

/**
 * 两行行数口径（Go `BuildLineStats`），顺序固定 `[includeMerge=true, includeMerge=false]`。
 * @param {import('./model.js').CommitView[]} commits
 * @returns {import('./model.js').LineStat[]}
 */
export function buildLineStats(commits) {
  const list = Array.isArray(commits) ? commits : []
  let allAdditions = 0
  let allDeletions = 0
  let allTotal = 0
  let allCount = 0
  let nonMergeAdditions = 0
  let nonMergeDeletions = 0
  let nonMergeTotal = 0
  let nonMergeCount = 0
  for (const commit of list) {
    const counts = lineCounts(commit)
    allCount += 1
    allAdditions += counts.additions
    allDeletions += counts.deletions
    allTotal += counts.total
    if (!isMergeCommit(commit) && !isCherryPickCommit(commit)) {
      nonMergeCount += 1
      nonMergeAdditions += counts.additions
      nonMergeDeletions += counts.deletions
      nonMergeTotal += counts.total
    }
  }
  return [
    {
      includeMerge: true,
      commits: allCount,
      additions: allAdditions,
      deletions: allDeletions,
      total: allTotal,
      pureAdditions: allAdditions - allDeletions,
    },
    {
      includeMerge: false,
      commits: nonMergeCount,
      additions: nonMergeAdditions,
      deletions: nonMergeDeletions,
      total: nonMergeTotal,
      pureAdditions: nonMergeAdditions - nonMergeDeletions,
    },
  ]
}

/**
 * 仓库×分支统计（Go `BuildRepoBranchStats`）。
 *
 * 恒有 `includeMerge=true` 组；`includeMerge=false` 组仅当该 (repo, branch) 出现过
 * 非 merge/cherry-pick 提交时才创建。排序：total 降 → commitCount 降。
 *
 * 偏差：Go 用 `"%t__%s__%s"` 拼分组键（repo/branch 含 `__` 时理论可碰撞）；
 * 本实现用 `\u0000` 分隔，行为更正确 —— 已记录为 deviation（07 分册 §3.12）。
 * @param {import('./model.js').CommitView[]} commits
 * @returns {import('./model.js').RepoBranchStat[]}
 */
export function buildRepoBranchStats(commits) {
  const list = Array.isArray(commits) ? commits : []
  /** @type {Map<string, import('./model.js').RepoBranchStat>} */
  const groups = new Map()

  /**
   * @param {boolean} includeMerge
   * @param {string} repoKey
   * @param {string} branchName
   * @returns {import('./model.js').RepoBranchStat}
   */
  const group = (includeMerge, repoKey, branchName) => {
    const key = `${includeMerge ? 1 : 0}\u0000${repoKey}\u0000${branchName}`
    let stat = groups.get(key)
    if (!stat) {
      stat = {
        includeMerge,
        repoKey,
        branchName,
        commitCount: 0,
        additions: 0,
        deletions: 0,
        total: 0,
      }
      groups.set(key, stat)
    }
    return stat
  }

  for (const commit of list) {
    const repoKey = repoPath(commit)
    const branchName = currentRefsBranch(commit)
    const counts = lineCounts(commit)
    const all = group(true, repoKey, branchName)
    all.commitCount += 1
    all.additions += counts.additions
    all.deletions += counts.deletions
    all.total += counts.total

    if (!isMergeCommit(commit) && !isCherryPickCommit(commit)) {
      const excluded = group(false, repoKey, branchName)
      excluded.commitCount += 1
      excluded.additions += counts.additions
      excluded.deletions += counts.deletions
      excluded.total += counts.total
    }
  }

  return [...groups.values()].sort((left, right) => {
    if (left.total === right.total) return right.commitCount - left.commitCount
    return right.total - left.total
  })
}

/**
 * 单口径的仓库卡片列表（Go `buildRepoCardList`，不导出）。
 * @param {import('./model.js').CommitView[]} commits
 * @param {boolean} includeMerge true = 全部提交；false = 跳过 merge/cherry-pick
 * @returns {import('./model.js').RepoCard[]}
 */
function buildRepoCardList(commits, includeMerge) {
  /** @type {Map<string, import('./model.js').RepoCard>} */
  const repos = new Map()
  /** @type {Map<string, Map<string, import('./model.js').RepoBranchCard>>} */
  const branches = new Map()
  /** @type {Map<string, Map<string, number>>} */
  const contributions = new Map()

  for (const commit of commits) {
    if (!includeMerge && (isMergeCommit(commit) || isCherryPickCommit(commit))) continue
    const repoKey = repoPath(commit)
    let card = repos.get(repoKey)
    if (!card) {
      card = {
        includeMerge,
        repoKey,
        commitCount: 0,
        additions: 0,
        deletions: 0,
        total: 0,
        pureAdditions: 0,
        branchCount: 0,
        branches: [],
        contributionDays: [],
      }
      repos.set(repoKey, card)
      branches.set(repoKey, new Map())
      contributions.set(repoKey, new Map())
    }
    const counts = lineCounts(commit)
    card.commitCount += 1
    card.additions += counts.additions
    card.deletions += counts.deletions
    card.total += counts.total

    const authoredDate = toStr(commit?.authoredDate)
    if (authoredDate.length >= 10) {
      const byDate = contributions.get(repoKey)
      const date = authoredDate.slice(0, 10)
      byDate.set(date, (byDate.get(date) ?? 0) + 1)
    }

    const branchName = currentRefsBranch(commit)
    const branchMap = branches.get(repoKey)
    let branchCard = branchMap.get(branchName)
    if (!branchCard) {
      branchCard = { branchName, commitCount: 0, additions: 0, deletions: 0, total: 0, pureAdditions: 0 }
      branchMap.set(branchName, branchCard)
    }
    branchCard.commitCount += 1
    branchCard.additions += counts.additions
    branchCard.deletions += counts.deletions
    branchCard.total += counts.total
  }

  /** @type {import('./model.js').RepoCard[]} */
  const cards = []
  for (const card of repos.values()) {
    card.pureAdditions = card.additions - card.deletions
    const branchMap = branches.get(card.repoKey)
    for (const branchCard of branchMap.values()) {
      branchCard.pureAdditions = branchCard.additions - branchCard.deletions
      card.branches.push(branchCard)
    }
    const contributionMap = contributions.get(card.repoKey)
    for (const [date, count] of contributionMap.entries()) {
      card.contributionDays.push({ date, count })
    }
    card.branchCount = card.branches.length
    card.contributionDays.sort((left, right) =>
      left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
    )
    card.branches.sort((left, right) => {
      if (left.total === right.total) return right.commitCount - left.commitCount
      return right.total - left.total
    })
    cards.push(card)
  }
  cards.sort((left, right) => {
    if (left.total === right.total) return right.commitCount - left.commitCount
    return right.total - left.total
  })
  return cards
}

/**
 * 双口径仓库卡片（Go `BuildRepoCards`）。
 *
 * 返回对象的 `items` 与 `excludeMerge` 是**同一个数组引用**（Go 里是同一个 slice，
 * JSON 序列化会重复输出）——移植时不能深拷贝，否则 parity 判定会认为「多了一份」。
 * @param {import('./model.js').CommitView[]} commits
 * @returns {import('./model.js').RepoCardsResult}
 */
export function buildRepoCards(commits) {
  const list = Array.isArray(commits) ? commits : []
  const includeCards = buildRepoCardList(list, true)
  const excludeCards = buildRepoCardList(list, false)
  return { includeMerge: includeCards, excludeMerge: excludeCards, items: excludeCards }
}

/**
 * 空行数行（对应 Go 的 `LineStat{}` 零值：includeMerge=false）。
 * @param {boolean} includeMerge
 * @returns {import('./model.js').LineStat}
 */
function blankLineStat(includeMerge) {
  return {
    includeMerge,
    commits: 0,
    additions: 0,
    deletions: 0,
    total: 0,
    pureAdditions: 0,
  }
}

/**
 * 字段白名单归一（Go HTTP 层 `strings.Split(fields, ",")` + trim + 去空）。
 * @param {string[] | string | undefined | null} fields
 * @returns {Set<string>}
 */
function normalizeFields(fields) {
  if (Array.isArray(fields)) {
    return new Set(fields.map((field) => toStr(field).trim()).filter((field) => field !== ''))
  }
  const text = toStr(fields)
  if (text === '') return new Set()
  return new Set(
    text
      .split(',')
      .map((field) => field.trim())
      .filter((field) => field !== ''),
  )
}

/**
 * 实时统计全量对象（Go `BuildRealtimeAnalytics`）。
 *
 * `opts` 有裁剪参数时等价于先全量再 `slimRealtimeAnalytics`（CONTRACTS §3 把两者合成一个入口，
 * 同时本模块仍单独导出 `slimRealtimeAnalytics` 供 HTTP 层直接使用）：
 *   - 不传 opts            → 全量（≈ Go 的 `report_stats` 工具返回，未被裁剪）；
 *   - opts 传任何键        → 裁剪（≈ Go HTTP `/line-stats` 行为）；
 *   - opts.slim === false  → 强制全量；opts.slim === true → 强制裁剪。
 * @param {string} startDate
 * @param {string} endDate
 * @param {import('./model.js').CommitView[]} commits
 * @param {import('./model.js').AnalyticsViewQuery & { slim?: boolean }} [opts]
 * @returns {import('./model.js').RealtimeAnalytics}
 */
export function buildRealtimeAnalytics(startDate, endDate, commits, opts) {
  const list = Array.isArray(commits) ? commits : []
  const aggregateStats = aggregate(list)
  const lineStats = buildLineStats(list)
  const repoCards = buildRepoCards(list)

  let excludeMerge = blankLineStat(false)
  let includeMerge = blankLineStat(true)
  for (const item of lineStats) {
    if (item.includeMerge) includeMerge = item
    else excludeMerge = item
  }

  /** @type {Set<string>} */
  const branchSet = new Set()
  for (const commit of list) {
    if (isMergeCommit(commit) || isCherryPickCommit(commit)) continue
    // 分隔符与 Go 一致的不可见字符 \x00
    branchSet.add(`${repoPath(commit)}\u0000${currentRefsBranch(commit)}`)
  }

  /** @type {import('./model.js').RealtimeAnalytics} */
  const result = {
    range: { startDate: toStr(startDate), endDate: toStr(endDate) },
    branchMode: BRANCH_MODE,
    branchAssignmentRule: BRANCH_ASSIGNMENT_RULE,
    summary: {
      totalCommits: includeMerge.commits,
      repoCount: aggregateStats.repoCount,
      branchCount: branchSet.size,
      mergeCommits: aggregateStats.mergeCommitCount,
      cherryPickCommits: aggregateStats.cherryPickCommitCount,
      additions: excludeMerge.additions,
      deletions: excludeMerge.deletions,
      total: excludeMerge.total,
      // Go 里 net 与 pureAdditions 恒等（analytics.go:197-198）
      net: excludeMerge.additions - excludeMerge.deletions,
      pureAdditions: excludeMerge.additions - excludeMerge.deletions,
    },
    lineStats,
    // Go 恒返回空数组（analytics.go:184），属历史字段，勿填！
    repoBranchStats: [],
    repoCards,
    dateDistribution: aggregateStats.dateDistribution,
    repoDistribution: aggregateStats.repoDistribution,
    scriptLike: {
      total_commits: includeMerge.commits,
      merge_commits: aggregateStats.mergeCommitCount,
      cherry_pick_commits: aggregateStats.cherryPickCommitCount,
      totals_including_merges: {
        additions: includeMerge.additions,
        deletions: includeMerge.deletions,
        total: includeMerge.total,
      },
      totals_excluding_merges: {
        additions: excludeMerge.additions,
        deletions: excludeMerge.deletions,
        total: excludeMerge.total,
      },
    },
  }

  if (opts === null || opts === undefined) return result
  if (opts.slim === false) return result
  if (opts.slim === true) return slimRealtimeAnalytics(result, opts)
  return Object.keys(opts).length > 0 ? slimRealtimeAnalytics(result, opts) : result
}

/**
 * 实时统计裁剪（Go `SlimRealtimeAnalytics`）。
 *
 * 逐条复刻的行为：
 *   - `include` 空 → `'excludeMerge'`；
 *   - `fields` 为空 → 除 `scriptLike` 外全留；`fields` 指定时按白名单保留；
 *   - `repoCards` 被裁掉时直接返回（其余字段已置 null）；
 *   - 保留 `repoCards` 时只输出**单键**（`excludeMerge` 或 `includeMerge`），并按 `limit` 截断。
 *
 * 偏差：Go 是**就地修改**入参（值拷贝但内层 map/slice 共享）；本实现返回新对象，不改入参。
 * `bucket` 接受但不参与计算（Go 现状，见 07 分册 §3.12）。
 * @param {import('./model.js').RealtimeAnalytics} result
 * @param {import('./model.js').AnalyticsViewQuery} [query]
 * @returns {import('./model.js').RealtimeAnalytics}
 */
export function slimRealtimeAnalytics(result, query) {
  const include = toStr(query?.include).trim() || 'excludeMerge'
  const fields = normalizeFields(query?.fields)
  const want = (name) => (fields.size === 0 ? name !== 'scriptLike' : fields.has(name))

  const out = { ...result }
  if (!want('scriptLike')) out.scriptLike = null
  if (!want('lineStats')) out.lineStats = null
  if (!want('dateDistribution')) out.dateDistribution = null
  if (!want('repoDistribution')) out.repoDistribution = null
  if (!want('repoCards')) {
    out.repoCards = null
    return out
  }

  const sourceCards = result.repoCards
  if (sourceCards === null || sourceCards === undefined) {
    out.repoCards = include === 'includeMerge' ? { includeMerge: null } : { excludeMerge: null }
    return out
  }

  let cards = include === 'includeMerge' ? sourceCards.includeMerge : sourceCards.excludeMerge
  if (!Array.isArray(cards)) cards = []
  const limit = toInt(query?.limit)
  if (limit > 0 && cards.length > limit) cards = cards.slice(0, limit)
  out.repoCards = include === 'includeMerge' ? { includeMerge: cards } : { excludeMerge: cards }
  return out
}
