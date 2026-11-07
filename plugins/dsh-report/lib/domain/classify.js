/**
 * classify.js —— 提交判定与业务域/主题标题推断。
 *
 * 逐函数对应 workbench `internal/report/topics.go:48-103,208-217`。
 * 这些判定是**报告口径**的一部分，必须与 Go 逐字节/逐分支一致，
 * 尤其是「标题以 merge 开头也算 merge」这种会被误认为 bug 的行为（07 分册 §3.4）。
 */
import { toFlag, toStr, trimSpace } from './text.js'

/**
 * 是否 merge 提交（Go `isMergeCommit`）。
 * 规则：`is_merge_commit === 1` **或** `lower(trim(title))` 以 `merge` 开头。
 *
 * 已知误判（必须保留）：`merge-fix: ...`、`Mergeable ...` 都会被判成 merge。
 * @param {import('./model.js').CommitView} commit
 * @returns {boolean}
 */
export function isMergeCommit(commit) {
  if (toFlag(commit?.isMergeCommit) === 1) return true
  return trimSpace(commit?.title).toLowerCase().startsWith('merge')
}

/**
 * 是否 cherry-pick 提交（Go `isCherryPickCommit`）。
 * 规则：`is_cherry_pick_commit === 1` **或** `cherry_pick_source_commit !== ""`。
 * 与 merge **可同时为真**（两个 if 独立，不是 else-if）→ 见 aggregate 的 nonMergeCommitCount 负值用例。
 * @param {import('./model.js').CommitView} commit
 * @returns {boolean}
 */
export function isCherryPickCommit(commit) {
  if (toFlag(commit?.isCherryPickCommit) === 1) return true
  return toStr(commit?.cherryPickSourceCommit) !== ''
}

/**
 * 业务域推断（Go `inferDomain`，6 条**顺序敏感**的硬编码 contains 规则）。
 *
 * `source = lower(path_with_namespace + " " + repo_name + " " + title)`（Go 用单空格 Join，不 trim）。
 * 注意：title 也参与匹配 —— 标题里出现 `site` 就会归到 `SaaS-站点`。
 * @param {import('./model.js').CommitView} commit
 * @returns {string}
 */
export function inferDomain(commit) {
  const source = [
    toStr(commit?.pathWithNamespace),
    toStr(commit?.repoName),
    toStr(commit?.title),
  ]
    .join(' ')
    .toLowerCase()
  if (source.includes('crm') && source.includes('order')) return 'CRM-订单'
  if (source.includes('crm') && source.includes('member')) return 'CRM-会员'
  if (source.includes('erp') && source.includes('pos')) return 'ERP-POS'
  if (source.includes('erp') && source.includes('print')) return 'ERP-打印'
  if (source.includes('site') || source.includes('saas')) return 'SaaS-站点'
  if (source.includes('payment')) return '支付'
  return '其他业务'
}

/**
 * 主题标题推断（Go `inferTopicTitle`）：
 *   - trim 后为空 → `提交更新`；
 *   - 按 `:` 切分，取**最后一段**再 trim；
 *   - 最后一段为空 → 返回**原 title**（例如 `"feat: a:"` 原样返回，含冒号）。
 * @param {import('./model.js').CommitView} commit
 * @returns {string}
 */
export function inferTopicTitle(commit) {
  const title = trimSpace(commit?.title)
  if (title === '') return '提交更新'
  const parts = title.split(':')
  const last = trimSpace(parts[parts.length - 1])
  if (last === '') return title
  return last
}

/**
 * 仓库键（Go `repoPath`）：`path_with_namespace` → `repo_name` → `未知仓库`。
 * 这是**唯一**的仓库键：RepoDistribution / RepoCard.repoKey / RepoBranchStat.repoKey
 * / branchCount 的 (repo, branch) 去重都用它。
 * @param {import('./model.js').CommitView} commit
 * @returns {string}
 */
export function repoPath(commit) {
  const path = toStr(commit?.pathWithNamespace)
  if (path !== '') return path
  const name = toStr(commit?.repoName)
  if (name !== '') return name
  return '未知仓库'
}

/**
 * 「当前 refs 分支」（Go `currentRefsBranch`）：
 *   - `branchNames.length > 0` → `branchNames[0]`（SQL 里按 branch_order 升序的第一个）；
 *   - 否则 → `primaryBranch`；
 *   - 结果为空串 → `未归属 refs`。
 *
 * 坑：`branchNames[0] === ""` 时会**忽略** primaryBranch 直接落到 `未归属 refs`（Go 行为，保留）。
 * @param {import('./model.js').CommitView} commit
 * @returns {string}
 */
export function currentRefsBranch(commit) {
  const names = commit?.branchNames
  let branch = toStr(commit?.primaryBranch)
  if (Array.isArray(names) && names.length > 0) branch = toStr(names[0])
  if (branch === '') return '未归属 refs'
  return branch
}
