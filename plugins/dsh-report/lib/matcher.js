/**
 * dsh-report · 提交归属匹配器（author matcher）
 *
 * 逐条复刻 workbench `buildCommitMatcher`（`internal/repository/commitimport/service.go:594-673`），
 * 用于「只收本人的提交」。**规则是业务定制，不要“优化”**：
 *
 *   1) verifiedEmails：当前用户 `commit_email` / `email` / `public_email`（要求含 `@`）
 *                       + `GET /user/emails` 返回值 + **含 `@` 的别名**；
 *   2) identities    ：verifiedEmails + 当前用户 `name` / `username` + 全部别名；
 *   3) 匹配顺序（命中即返回）：
 *        a. author_email ∈ verifiedEmails
 *        b. committer_email ∈ verifiedEmails
 *        c. 依次 author_email / author_name / committer_email / committer_name ∈ identities
 *        d. 提交 message 里的 `Co-authored-by:` trailer：
 *             - 邮箱 ∈ verifiedEmails → 命中
 *             - 名字 ∈ identities     → 命中
 *   4) 规范化只有 `lower + trim`（`strings.ToLower(strings.TrimSpace(v))`）；
 *      **不做**空格折叠、Unicode 归一、`+tag` 去除、noreply 还原。
 *
 * evidence 标签（CONTRACTS.md §4 锁定的 4 种）与 Go 6 种标签的映射：
 *   - `commit_email`   ← Go `verified_author_email` / `verified_committer_email` 中来自 profile 邮箱的命中
 *   - `verified_email` ← 来自 `/user/emails` 或含 `@` 别名的「已验证邮箱」命中
 *   - `identity`       ← 来自 name/username/别名 的 identity 命中（Go `author_alias` / `committer_alias`）
 *   - `coauthor`       ← Co-authored-by trailer 命中（Go `co_author_verified_email` / `co_author_alias`）
 *
 * @module lib/matcher
 */

/** Co-authored-by trailer 正则（与 Go 的 `coAuthorTrailerPattern` 等价）。 */
export const CO_AUTHOR_TRAILER_PATTERN = /^co-authored-by:\s*([^<\r\n]+?)(?:\s*<([^>\r\n]+)>)?\s*$/gim

/** 规范化：仅 lower + trim（Go `normalizeValue`，`service.go:710-712`）。 */
export function normalizeIdentity(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim().toLowerCase()
}

/**
 * 解析别名列表（Go `parseAliases`，`service.go:714-727`）：
 * 每个元素按 `\n` / `,` / `;` 再切分，规范化后去空。
 * @param {string[]|string|undefined|null} values
 * @returns {string[]}
 */
export function parseAliasList(values) {
  if (values === undefined || values === null) return []
  const raw = Array.isArray(values) ? values : [values]
  const out = []
  for (const item of raw) {
    if (item === undefined || item === null) continue
    for (const part of String(item).split(/[\n,;]/)) {
      const normalized = normalizeIdentity(part)
      if (normalized) out.push(normalized)
    }
  }
  return out
}

/** 读取用户字段，兼容 snake_case（GitLab /user 原样）与 camelCase。 */
function userField(user, snake, camel) {
  if (!user || typeof user !== 'object') return ''
  const value = user[snake] !== undefined && user[snake] !== null ? user[snake] : user[camel]
  return value === undefined || value === null ? '' : String(value)
}

/** 从 `/user/emails` 的响应里取邮箱（元素可能是对象或字符串）。 */
function emailOf(item) {
  if (typeof item === 'string') return item
  if (item && typeof item === 'object') return item.email ?? item.value ?? ''
  return ''
}

/** 提交字段读取（兼容 camelCase / snake_case）。 */
function commitField(commit, snake, camel) {
  if (!commit || typeof commit !== 'object') return ''
  const value = commit[snake] !== undefined && commit[snake] !== null ? commit[snake] : commit[camel]
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 构建提交归属匹配器。
 *
 * @param {{user?: object, userEmails?: Array<object|string>, aliases?: string[]|string}} input
 * @returns {(commit: object) => {matched: boolean, evidence?: string, identity?: string}}
 */
export function buildCommitMatcher({ user = {}, userEmails = [], aliases = [] } = {}) {
  /** @type {Map<string, string>} 邮箱 → evidence 标签 */
  const verifiedEmails = new Map()
  /** @type {Set<string>} identity 集合 */
  const identities = new Set()

  // 1) profile 邮箱：commit_email / email / public_email（含 @ 才算邮箱层）
  for (const raw of [
    userField(user, 'commit_email', 'commitEmail'),
    userField(user, 'email', 'email'),
    userField(user, 'public_email', 'publicEmail'),
  ]) {
    const value = normalizeIdentity(raw)
    if (!value || !value.includes('@')) continue
    if (!verifiedEmails.has(value)) verifiedEmails.set(value, 'commit_email')
    identities.add(value)
  }

  // 2) name / username → identity（不含 @ 要求，与 Go 一致）
  for (const raw of [userField(user, 'name', 'displayName'), userField(user, 'username', 'userName')]) {
    const value = normalizeIdentity(raw)
    if (value) identities.add(value)
  }

  // 3) /user/emails → 已验证邮箱（失败时调用方传空数组，静默降级）
  const emailList = Array.isArray(userEmails) ? userEmails : []
  for (const item of emailList) {
    const value = normalizeIdentity(emailOf(item))
    if (!value) continue
    if (!verifiedEmails.has(value)) verifiedEmails.set(value, 'verified_email')
    identities.add(value)
  }

  // 4) 别名：全部进 identities；含 @ 的同时进已验证邮箱
  for (const alias of parseAliasList(aliases)) {
    identities.add(alias)
    if (alias.includes('@') && !verifiedEmails.has(alias)) verifiedEmails.set(alias, 'verified_email')
  }

  /**
   * @param {object} commit
   * @returns {{matched: boolean, evidence?: string, identity?: string}}
   */
  return function matchCommit(commit) {
    const authorEmail = normalizeIdentity(commitField(commit, 'author_email', 'authorEmail'))
    const committerEmail = normalizeIdentity(commitField(commit, 'committer_email', 'committerEmail'))
    const authorName = normalizeIdentity(commitField(commit, 'author_name', 'authorName'))
    const committerName = normalizeIdentity(commitField(commit, 'committer_name', 'committerName'))

    // a/b) 已验证邮箱优先（author 先于 committer，与 Go 顺序一致）
    if (authorEmail && verifiedEmails.has(authorEmail)) {
      return { matched: true, evidence: verifiedEmails.get(authorEmail), identity: authorEmail }
    }
    if (committerEmail && verifiedEmails.has(committerEmail)) {
      return { matched: true, evidence: verifiedEmails.get(committerEmail), identity: committerEmail }
    }

    // c) identity 层：依次试 4 个字段（顺序与 Go 完全一致）
    for (const [value, kind] of [
      [authorEmail, 'author'],
      [authorName, 'author'],
      [committerEmail, 'committer'],
      [committerName, 'committer'],
    ]) {
      if (value && identities.has(value)) {
        return {
          matched: true,
          evidence: 'identity',
          identity: value,
          // 便于诊断：命中字段来源（不影响 evidence 契约）
          field: `${kind}_${value === authorEmail || value === committerEmail ? 'email' : 'name'}`,
        }
      }
    }

    // d) Co-authored-by trailer
    const message = commitField(commit, 'message', 'message')
    if (message) {
      CO_AUTHOR_TRAILER_PATTERN.lastIndex = 0
      for (const match of message.matchAll(CO_AUTHOR_TRAILER_PATTERN)) {
        const name = normalizeIdentity(match[1])
        const email = normalizeIdentity(match[2])
        if (email && verifiedEmails.has(email)) {
          return { matched: true, evidence: 'coauthor', identity: email }
        }
        if (name && identities.has(name)) {
          return { matched: true, evidence: 'coauthor', identity: name }
        }
      }
    }

    return { matched: false }
  }
}
