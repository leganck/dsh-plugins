/**
 * commitView.js —— DB 行 → 领域 `CommitView` 的归一化（边界适配，非算法）。
 *
 * 为什么需要：`lib/db.js` 的 `listCommitsInPeriod` 返回的是库行（可能是 snake_case，
 * 也可能已经是 camelCase），而领域函数一律吃 `CommitView`（camelCase + `branchNames: string[]`）。
 * Go 侧的对应物是 `Service.GetCommitsInPeriod` 里对 `BranchNamesJSON` 的 `parseJSONArray`
 * 与 `CommitView{CommitRecord, BranchNames}` 组装（`internal/report/service.go:99-112`）。
 *
 * 该模块只做「形状/类型」归一，不改变任何业务语义；顺序保持入参顺序（store 返回序）。
 */
import { parseJSONArray, toFlag, toInt, toStr } from './text.js'

/**
 * 从行对象中按 camelCase/snake_case 两种命名取第一个存在的值。
 * @param {Record<string, unknown>} row
 * @param {string[]} keys
 * @returns {unknown}
 */
function pickValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key]
  }
  return undefined
}

/**
 * 分支名归一：数组直接用；JSON 字符串解析；缺省回落 `branchNamesJson`。
 * @param {Record<string, unknown>} row
 * @param {string} branchNamesJson
 * @returns {string[]}
 */
function resolveBranchNames(row, branchNamesJson) {
  const raw = pickValue(row, ['branchNames', 'branch_names'])
  if (Array.isArray(raw)) return raw.map((item) => toStr(item))
  if (typeof raw === 'string' && raw !== '') return parseJSONArray(raw)
  return parseJSONArray(branchNamesJson)
}

/**
 * 单行 → CommitView。
 * 兼容：
 *   - snake_case 库行（`authored_date` …）与 camelCase 领域对象；
 *   - stats 平铺在行上，或嵌在 `stats` 对象里（两种 DB join 结果都接受）；
 *   - `is_merge_commit` 为 0/1、true/false、'0'/'1'。
 * @param {Record<string, unknown>} row
 * @returns {import('./model.js').CommitView}
 */
export function toCommitView(row) {
  const source = row ?? {}
  const stats = source.stats && typeof source.stats === 'object' ? source.stats : source
  const branchNamesJson = toStr(pickValue(source, ['branchNamesJson', 'branch_names_json']))
  return {
    connectionId: toStr(pickValue(source, ['connectionId', 'connection_id'])),
    commitId: toStr(pickValue(source, ['commitId', 'commit_id'])),
    projectId: toInt(pickValue(source, ['projectId', 'project_id'])),
    message: toStr(pickValue(source, ['message'])),
    authoredDate: toStr(pickValue(source, ['authoredDate', 'authored_date'])),
    committedDate: toStr(pickValue(source, ['committedDate', 'committed_date'])),
    authorName: toStr(pickValue(source, ['authorName', 'author_name'])),
    authorEmail: toStr(pickValue(source, ['authorEmail', 'author_email'])),
    title: toStr(pickValue(source, ['title'])),
    isMergeCommit: toFlag(pickValue(source, ['isMergeCommit', 'is_merge_commit'])),
    isCherryPickCommit: toFlag(pickValue(source, ['isCherryPickCommit', 'is_cherry_pick_commit'])),
    cherryPickSourceCommit: toStr(
      pickValue(source, ['cherryPickSourceCommit', 'cherry_pick_source_commit']),
    ),
    additions: toInt(pickValue(stats, ['additions'])),
    deletions: toInt(pickValue(stats, ['deletions'])),
    total: toInt(pickValue(stats, ['total'])),
    repoName: toStr(pickValue(source, ['repoName', 'repo_name'])),
    repoNamespace: toStr(pickValue(source, ['repoNamespace', 'repo_namespace'])),
    pathWithNamespace: toStr(pickValue(source, ['pathWithNamespace', 'path_with_namespace'])),
    primaryBranch: toStr(pickValue(source, ['primaryBranch', 'primary_branch'])),
    branchNamesJson,
    branchNames: resolveBranchNames(source, branchNamesJson),
  }
}

/**
 * 批量归一。
 * @param {Array<Record<string, unknown>>} rows
 * @returns {import('./model.js').CommitView[]}
 */
export function toCommitViews(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => toCommitView(row))
}
