/**
 * topics.js —— 主题候选聚合（Go `internal/report/topics.go:10-46` 的 `buildTopics`）。
 *
 * 语义提醒：
 *   - 分桶键 = `domain + "__" + topicTitle`（Go 用 `__` 拼接；本实现改用 `\u0000` 分隔，
 *     避免 repo/title 含 `__` 时理论碰撞 —— 与 `buildRepoBranchStats` 的 deviation 一致）；
 *   - 排序 = 桶内提交数降序；`sortOrder = index + 1`（并列顺序在 Go 里不确定，见 07 §3.9）；
 *   - `summary` 是固定文案 `"{n} 次提交"`，**不是** LLM 摘要 —— 真正的主题归纳由模型完成。
 */
import { inferDomain, inferTopicTitle } from './classify.js'

/**
 * @param {import('./model.js').CommitView[]} commits
 * @returns {import('./model.js').ReportTopic[]}
 */
export function buildTopics(commits) {
  const list = Array.isArray(commits) ? commits : []
  /** @type {Map<string, { domain: string, topicTitle: string, count: number }>} */
  const groups = new Map()

  for (const commit of list) {
    const domain = inferDomain(commit)
    const topicTitle = inferTopicTitle(commit)
    const key = `${domain}\u0000${topicTitle}`
    let bucket = groups.get(key)
    if (!bucket) {
      bucket = { domain, topicTitle, count: 0 }
      groups.set(key, bucket)
    }
    bucket.count += 1
  }

  const buckets = [...groups.values()].sort((left, right) => right.count - left.count)
  return buckets.map((bucket, index) => ({
    domain: bucket.domain,
    topicTitle: bucket.topicTitle,
    summary: `${bucket.count} 次提交`,
    sortOrder: index + 1,
  }))
}
