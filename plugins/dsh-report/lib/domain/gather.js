/**
 * gather.js —— LLM 侧「精简分页提交页」（Go `internal/report/gather.go:54-162`）。
 *
 * 与 Go 的差异：Go 的 `GatherCommits` 自己查库（`GetCommitsInPeriod` 在方法内），
 * 本移植把提交列表作为入参（CONTRACTS §3：`gatherCommits(commits, startDate, endDate, opts)`），
 * 让领域层保持**纯函数、零 IO**；「每次翻页都全量重查」的调用方行为由 tools/api 层负责。
 *
 * 逐字节契约（07 分册 §3.10）：
 *   - `hint` 两句英文文案是 LLM 可读契约，必须与 Go 完全一致（本文件导出常量供 parity 测试）；
 *   - Go 的 `omitempty`：结果里的 `repo`/`nextOffset`/`hint`，以及提交里的
 *     `branch`/`merge`/`cherry_pick`/`commit_id` 在零值时**整键消失**（不是 false/0/""）。
 */
import {
  currentRefsBranch,
  inferDomain,
  isCherryPickCommit,
  isMergeCommit,
  repoPath,
} from './classify.js'
import { firstLine, toInt, toStr, trimSpace } from './text.js'

/** 默认页大小（Go `defaultGatherCommitLimit`）。 */
export const DEFAULT_GATHER_COMMIT_LIMIT = 40
/** 页大小硬上限（Go `maxGatherCommitLimit`）。 */
export const MAX_GATHER_COMMIT_LIMIT = 80

/** 还有下一页时的 hint（Go gather.go:102，逐字节一致）。 */
export const GATHER_HINT_MORE =
  'More commits remain. Call report_commits again with the same period and offset=nextOffset (optionally repo=...) until hasMore is false.'
/** 本页取完且未按仓库过滤时的 hint（Go gather.go:104，逐字节一致）。 */
export const GATHER_HINT_COMPLETE =
  'Page complete. For large repos, pass repo=<path or name substring> to inspect one repository at a time.'

/**
 * 仓库匹配（Go `repoMatches`）：三项候选逐个 lower + contains(filter)。
 * `filter` 在入口已 lower + trim；空候选直接跳过。
 * @param {import('./model.js').CommitView} commit
 * @param {string} filter 已小写化的过滤串
 * @returns {boolean}
 */
function repoMatches(commit, filter) {
  const candidates = [
    toStr(commit?.pathWithNamespace).toLowerCase(),
    toStr(commit?.repoName).toLowerCase(),
    toStr(commit?.repoNamespace).toLowerCase(),
  ]
  for (const candidate of candidates) {
    if (candidate !== '' && candidate.includes(filter)) return true
  }
  return false
}

/**
 * 单条提交的瘦投影（Go `slimCommit`）。
 *
 * - `date` = `authoredDate.slice(0, 10)`（不足 10 位 → `""`，**不做时区归一**）；
 * - `commitId` trim 后截前 8 位；
 * - `title` trim 后为空则回退 `firstLine(message)`；
 * - `merge`/`cherry_pick` 仅 true 时写键；`commit_id` 仅非空时写键。
 * @param {import('./model.js').CommitView} commit
 * @returns {import('./model.js').SlimCommit}
 */
export function toSlimCommit(commit) {
  const authoredDate = toStr(commit?.authoredDate)
  const date = authoredDate.length >= 10 ? authoredDate.slice(0, 10) : ''
  let commitId = trimSpace(commit?.commitId)
  if (commitId.length > 8) commitId = commitId.slice(0, 8)
  let title = trimSpace(commit?.title)
  if (title === '') title = firstLine(commit?.message)
  const branch = currentRefsBranch(commit)
  const merge = isMergeCommit(commit)
  const cherryPick = isCherryPickCommit(commit)
  return {
    date,
    title,
    repo: repoPath(commit),
    domain: inferDomain(commit),
    ...(branch !== '' ? { branch } : {}),
    additions: toInt(commit?.additions),
    deletions: toInt(commit?.deletions),
    ...(merge ? { merge: true } : {}),
    ...(cherryPick ? { cherry_pick: true } : {}),
    ...(commitId !== '' ? { commit_id: commitId } : {}),
  }
}

/**
 * 一页瘦投影（Go `GatherCommits`，提交列表改为入参）。
 *
 * 过滤顺序与 Go 一致：先按 merge/cherry-pick 过滤，再按 repo 子串过滤，然后分页。
 * @param {import('./model.js').CommitView[]} commits 周期内全部提交（顺序保持 store 返回序）
 * @param {string} startDate `YYYY-MM-DD`（只回填到结果，不参与过滤）
 * @param {string} endDate `YYYY-MM-DD`（同上）
 * @param {import('./model.js').GatherCommitsOpts} [opts]
 * @returns {import('./model.js').GatherCommitsResult}
 */
export function gatherCommits(commits, startDate, endDate, opts) {
  const list = Array.isArray(commits) ? commits : []
  const options = opts ?? {}
  const includeMerge = Boolean(options.includeMerge)
  const repoValue = trimSpace(options.repo)
  const repoFilter = repoValue.toLowerCase()

  /** @type {import('./model.js').CommitView[]} */
  const filtered = []
  for (const commit of list) {
    if (!includeMerge && (isMergeCommit(commit) || isCherryPickCommit(commit))) continue
    if (repoFilter !== '' && !repoMatches(commit, repoFilter)) continue
    filtered.push(commit)
  }

  let limit = toInt(options.limit)
  if (limit <= 0) limit = DEFAULT_GATHER_COMMIT_LIMIT
  if (limit > MAX_GATHER_COMMIT_LIMIT) limit = MAX_GATHER_COMMIT_LIMIT

  let offset = toInt(options.offset)
  if (offset < 0) offset = 0
  const total = filtered.length
  if (offset > total) offset = total
  let end = offset + limit
  if (end > total) end = total

  const page = filtered.slice(offset, end)
  const slim = page.map((commit) => toSlimCommit(commit))
  const hasMore = end < total
  const nextOffset = hasMore ? end : 0

  let hint = ''
  if (hasMore) hint = GATHER_HINT_MORE
  else if (repoFilter === '' && total > 0) hint = GATHER_HINT_COMPLETE

  return {
    startDate: toStr(startDate),
    endDate: toStr(endDate),
    ...(repoValue !== '' ? { repo: repoValue } : {}),
    includeMerge,
    offset,
    limit,
    total,
    count: slim.length,
    hasMore,
    ...(nextOffset !== 0 ? { nextOffset } : {}),
    truncated: hasMore,
    ...(hint !== '' ? { hint } : {}),
    commits: slim,
  }
}
