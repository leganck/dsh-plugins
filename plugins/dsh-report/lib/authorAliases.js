/**
 * authorAliases.js —— 「提交作者别名」推断（对齐 workbench internal/repository/gitlab/author_aliases.go）
 *
 * 背景：本地 git 作者与 GitLab 账号（邮箱/用户名）不一致时，同步无法把提交认到本人头上；
 * 别名用来补充身份：每行一个邮箱或作者名。这里从最近 push 事件的头提交里采样作者身份，
 * 过滤掉 GitLab 账号已知身份后按出现次数排序，给出候选别名。
 *
 * 纯函数 + 一个 GitLab client 依赖，便于单测（test/data/author-aliases.test.mjs）。
 */

export const ALIAS_EVENT_PAGES = 3
export const ALIAS_EVENTS_PER_PAGE = 50
export const ALIAS_MAX_TIP_COMMITS = 120
export const ALIAS_MIN_TIP_COUNT = 3
export const ALIAS_RELATIVE_CUTOFF = 0.5

/** 归一化身份：去空白、小写。 */
export function normalizeIdentity(value) {
  return String(value ?? '').trim().toLowerCase()
}

/** 接受数组或按行/逗号分隔的文本，返回归一化后的去重列表。 */
export function parseAliasList(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\n,，;；]+/)
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const value = String(item ?? '').trim()
    const normalized = normalizeIdentity(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(value)
  }
  return out
}

/** 合并两组别名（保序去重）。 */
export function mergeAliases(existing, suggested) {
  const seen = new Set()
  const out = []
  for (const item of [...parseAliasList(existing), ...parseAliasList(suggested)]) {
    const normalized = normalizeIdentity(item)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(item)
  }
  return out
}

function authorIdOf(event) {
  const value = event?.author_id ?? event?.author?.id
  return value === undefined || value === null ? '' : String(value)
}

function pushTipOf(event) {
  const projectId = Number(event?.project_id ?? event?.project?.id)
  const sha = String(event?.push_data?.commit_to ?? '').trim()
  if (!Number.isFinite(projectId) || projectId <= 0 || !sha) return null
  return { projectId, sha }
}

function countCandidate(counts, known, value, kind) {
  const normalized = normalizeIdentity(value)
  if (!normalized || known.has(normalized)) return
  const entry = counts.get(normalized) || { value: normalized, kind, count: 0 }
  entry.count += 1
  counts.set(normalized, entry)
}

/**
 * 采样一个连接的最近 push 头提交，返回候选别名。
 * @param {{ client: any, existingAliases?: string[] }} options
 */
export async function suggestAuthorAliasesForConnection({ client, existingAliases = [] }) {
  const existing = new Set(parseAliasList(existingAliases).map(normalizeIdentity))
  const known = new Set()
  const addKnown = (value) => {
    const normalized = normalizeIdentity(value)
    if (normalized) known.add(normalized)
  }

  const user = await client.getCurrentUser()
  for (const key of ['commit_email', 'email', 'public_email', 'username', 'name']) addKnown(user?.[key])
  try {
    const emails = await client.getUserEmails()
    for (const item of Array.isArray(emails) ? emails : []) addKnown(item?.email)
  } catch {
    /* emails 需要 read_user scope；失败时只用 /user 里的身份 */
  }

  const userId = String(user?.id ?? '')
  const events = []
  for (let page = 1; page <= ALIAS_EVENT_PAGES; page += 1) {
    const rows = await client.listEvents({ page, perPage: ALIAS_EVENTS_PER_PAGE, action: 'pushed' })
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      if (userId && authorIdOf(row)) {
        if (authorIdOf(row) === userId) events.push(row)
        continue
      }
      events.push(row)
    }
    if (rows.length < ALIAS_EVENTS_PER_PAGE) break
  }

  const tips = []
  const seenTip = new Set()
  for (const event of events) {
    const tip = pushTipOf(event)
    if (!tip) continue
    const key = `${tip.projectId}:${tip.sha}`
    if (seenTip.has(key)) continue
    seenTip.add(key)
    tips.push(tip)
    if (tips.length >= ALIAS_MAX_TIP_COMMITS) break
  }

  const counts = new Map()
  let sampledCommits = 0
  for (const tip of tips) {
    let commit
    try {
      commit = await client.getCommit(tip.projectId, tip.sha)
    } catch {
      continue
    }
    if (!commit || typeof commit !== 'object') continue
    sampledCommits += 1
    countCandidate(counts, known, commit.author_email, 'email')
    countCandidate(counts, known, commit.author_name, 'name')
    countCandidate(counts, known, commit.committer_email, 'email')
    countCandidate(counts, known, commit.committer_name, 'name')
  }

  const candidates = [...counts.values()].sort((a, b) => b.count - a.count)
  const maxCount = candidates.length ? candidates[0].count : 0
  const threshold = Math.max(ALIAS_MIN_TIP_COUNT, Math.ceil(maxCount * ALIAS_RELATIVE_CUTOFF))
  const kept = candidates.filter((item) => item.count >= threshold)
  const suggestedAliases = kept.filter((item) => !existing.has(normalizeIdentity(item.value))).map((item) => item.value)

  return {
    connectionId: '',
    connectionName: '',
    username: String(user?.username ?? '').trim(),
    displayName: String(user?.name ?? '').trim(),
    knownIdentities: [...known],
    candidates: kept,
    suggestedAliases,
    sampledEvents: events.length,
    sampledCommits,
    error: '',
  }
}

/** 「已推断 a、b，可写入别名后保存」/「未发现可新增别名」。 */
export function formatAuthorAliasSuggestMessage(suggestedAliases) {
  const list = parseAliasList(suggestedAliases)
  if (!list.length) return '未发现可新增别名'
  return `已推断 ${list.join('、')}，可写入别名后保存`
}
