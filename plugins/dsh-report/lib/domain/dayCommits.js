/**
 * dayCommits.js —— 「某天提交」领域纯函数（对齐 workbench upstream `internal/report/gather.go:174-277`）。
 *
 * 背景：统计页点开某一天时，需要当天的提交明细（时间/标题/仓库/分支/行数/标记），
 * 与 `gatherCommits`（给 LLM 的分页瘦投影）不同：这里**不排除** merge / cherry-pick，
 * 而是打上标记，保证条数能对上当天的统计数字（Go 注释：gather.go:174）。
 *
 * 对齐要点（逐条对应 Go）：
 *   - 日期过滤：`String(authoredDate).slice(0, 10) === date`，长度不足 10 直接跳过（gather.go:183）；
 *   - 仓库过滤：`repoKey` trim + 小写后与 `repoPath(commit)` 小写**精确**比较；空 = 全部（gather.go:246-252）；
 *   - 上限 200 条：`total` 是截断前总数，`truncated = total > 200`，commits 取前 200（gather.go:191-195）；
 *   - commits 顺序与输入一致（Go 不排序）；
 *   - `time` 本地时区 HH:mm（解析 RFC3339/RFC3339Nano → 无时区两种格式 → 截取退化，gather.go:254-277）；
 *   - `branch` 为 `未归属 refs` 时置空（omitempty）；`title` 空则回退 `message` 首行，再空则 `（没有标题）`；
 *   - `commitId` trim 后截 8 位；`merge`/`cherryPick` 仅 true 时输出（Go `omitempty`）。
 *
 * 已知环境级偏差（接受，不追）：远早于当前时期的日期（如 1900 年前），Go 在 Windows 上读注册表
 * 固定偏移、JS 用 IANA 历史规则（如 Asia/Singapore 曾为 +06:55），`time` 的 HH:mm 可能不同；
 * GitLab 实际提交日期（近十余年）两者一致，故不影响该功能。
 *
 * @typedef {Object} DayCommit 当天的单条提交（Go `report.DayCommit`，gather.go:15-25）
 * @property {string} time 本地时区 HH:mm（解析失败时可能为 `''`）
 * @property {string} title 标题（回退链见 commitTitle）
 * @property {string} repo `repoPath()` 结果
 * @property {string} [branch] 空时不出现（omitempty）
 * @property {number} additions
 * @property {number} deletions
 * @property {string} commitId 前 8 位（不足则原样）
 * @property {boolean} [merge] 仅 true 时出现（omitempty）
 * @property {boolean} [cherryPick] 仅 true 时出现（omitempty）
 *
 * @typedef {Object} DayCommitPage 某一天的提交页（Go `report.DayCommitPage`，gather.go:28-34）
 * @property {string} date 原样回显入参 date
 * @property {string} [repo] trim 后的 repoKey；空则不出现（omitempty）
 * @property {number} total 截断前的匹配总数
 * @property {boolean} truncated total > 200
 * @property {DayCommit[]} commits 前 200 条（输入顺序）
 */
import {
  currentRefsBranch,
  isCherryPickCommit,
  isMergeCommit,
  repoPath,
} from './classify.js'
import { firstLine, toInt, toStr, trimSpace } from './text.js'

/** 单日提交上限（Go `maxDayCommits`，gather.go:11）。 */
export const MAX_DAY_COMMITS = 200

/**
 * RFC3339 / RFC3339Nano：
 *   - 秒必填；
 *   - 小数秒分隔符 Go 同时接受 `.` 与 `,`（`time.parseNanoseconds` 的 `commaOrPeriod`），位数不限（>9 位按纳秒截断）；
 *   - 时区 `Z`（大写）或 `±hh:mm`，Go 对 offset 的校验是 `hh <= 24`、`mm <= 59`（`+24:00` 合法）。
 */
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(Z|[+-]\d{2}:\d{2})$/

/** 无时区格式（Go `"2006-01-02 15:04:05"` / `"2006-01-02T15:04:05"`，秒必填、不带小数秒）。 */
const LOCAL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/

/**
 * 日期分量范围校验（复刻 Go `time.Parse` 的严格性：月/日/时/分/秒越界即视为解析失败）。
 * 关键：`2026-02-30T10:11:12Z` 在 Go 里解析失败并落入截取退化分支，这里也必须失败。
 * @param {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} parts
 * @returns {boolean}
 */
function isValidDateTimeParts(parts) {
  if (parts.month < 1 || parts.month > 12) return false
  if (parts.day < 1 || parts.day > 31) return false
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) return false
  // 用 UTC 往返校验日是否落在当月（含闰年）；setUTCFullYear 避免 0–99 年被映射到 1900+
  const probe = new Date(0)
  probe.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  probe.setUTCHours(0, 0, 0, 0)
  return (
    probe.getUTCFullYear() === parts.year &&
    probe.getUTCMonth() === parts.month - 1 &&
    probe.getUTCDate() === parts.day
  )
}

/**
 * 解析带时区的 RFC3339/RFC3339Nano 字符串为 epoch 毫秒；失败返回 null。
 * @param {string} text
 * @returns {number | null}
 */
function parseRfc3339(text) {
  const match = RFC3339_PATTERN.exec(text)
  if (!match) return null
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  }
  if (!isValidDateTimeParts(parts)) return null
  let offsetMinutes = 0
  const zone = match[7]
  if (zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1
    const offsetHours = Number(zone.slice(1, 3))
    const offsetMins = Number(zone.slice(4, 6))
    // Go 的 range 判定是 `hr > 24` / `mm > 60` 才算错（源码注释：有人写 24 小时或 60 分钟），
    // 因此 +24:00、+24:60 都合法；+25:00、+24:61 非法。
    if (offsetHours > 24 || offsetMins > 60) return null
    offsetMinutes = sign * (offsetHours * 60 + offsetMins)
  }
  const instant = new Date(0)
  instant.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  instant.setUTCHours(parts.hour, parts.minute, parts.second, 0)
  return instant.getTime() - offsetMinutes * 60_000
}

/**
 * 本地时区 HH:mm（Go `parsed.In(time.Local).Format("15:04")`）。
 * @param {Date} date
 * @returns {string}
 */
function formatLocalClock(date) {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * 提交时间 → 本地时区 `HH:mm`（Go `commitClock`，gather.go:254-277）。
 *
 * 解析/退化顺序（必须与 Go 一致）：
 *   1. RFC3339Nano / RFC3339（带时区）→ 转本地时区 HH:mm；
 *   2. `YYYY-MM-DD HH:mm:ss` / `YYYY-MM-DDTHH:mm:ss`（按本地时间）→ 直接取 HH:mm；
 *   3. 含 `T` 且 `len >= index+6` → 取 T 之后 5 位；
 *   4. `len >= 16` 且第 11 位是空格 → 取第 12–16 位（0-based [11,16)）；
 *   5. 其它 → `''`。
 * 空串（trim 后）→ `''`。
 *
 * Go 的解析细节（已用 Go 实机逐例对拍验证）：
 *   - 日期分量严格校验：`2026-02-30T10:11:12Z` / `2026-13-45…` / 秒=60 都解析失败 → 走截取退化；
 *   - 小数秒分隔符 `.` 与 `,` 都接受，位数不限（Go `parseNanoseconds`）；
 *   - offset 范围：`hr > 24` 或 `mm > 60` 才判错 → `+24:00`、`+24:60` 合法，`+25:00`、`+24:61` 非法。
 *
 * 已知环境级偏差见文件头注释（远古日期时区数据差异；GitLab 实际数据不会出现）。
 * @param {unknown} raw
 * @returns {string}
 */
export function commitClock(raw) {
  const text = trimSpace(raw)
  if (text === '') return ''

  const instant = parseRfc3339(text)
  if (instant !== null) return formatLocalClock(new Date(instant))

  const localMatch = LOCAL_CLOCK_PATTERN.exec(text)
  if (localMatch) {
    const parts = {
      year: Number(localMatch[1]),
      month: Number(localMatch[2]),
      day: Number(localMatch[3]),
      hour: Number(localMatch[4]),
      minute: Number(localMatch[5]),
      second: Number(localMatch[6]),
    }
    if (isValidDateTimeParts(parts)) return `${localMatch[4]}:${localMatch[5]}`
  }

  const tIndex = text.indexOf('T')
  if (tIndex >= 0 && text.length >= tIndex + 6) return text.slice(tIndex + 1, tIndex + 6)
  if (text.length >= 16 && text[10] === ' ') return text.slice(11, 16)
  return ''
}

/**
 * 提交标题（Go `commitTitle`，gather.go:227-236）：
 * trim(title) → 空则 firstLine(message) → 仍空则 `（没有标题）`。
 * @param {import('./model.js').CommitView} commit
 * @returns {string}
 */
function commitTitle(commit) {
  let title = trimSpace(commit?.title)
  if (title === '') title = firstLine(commit?.message)
  if (title === '') return '（没有标题）'
  return title
}

/**
 * 短 commit id（Go `shortCommitID`）：trim 后超过 8 位截前 8 位。
 * @param {unknown} commitID
 * @returns {string}
 */
function shortCommitID(commitID) {
  const value = trimSpace(commitID)
  return value.length > 8 ? value.slice(0, 8) : value
}

/**
 * 仓库键匹配（Go `sameRepoKey`）：`repoKey` 为空/空白 = 全部仓库；
 * 否则 `lower(trim(repoKey)) === lower(repoPath(commit))`（精确匹配，不做子串）。
 * @param {import('./model.js').CommitView} commit
 * @param {unknown} repoKey
 * @returns {boolean}
 */
function sameRepoKey(commit, repoKey) {
  const key = trimSpace(repoKey).toLowerCase()
  if (key === '') return true
  return repoPath(commit).toLowerCase() === key
}

/**
 * 单条提交 → `DayCommit`（Go `dayCommit`，gather.go:209-225）。
 * 注意 omitempty：`branch` 为空、`merge`/`cherryPick` 为 false 时**整键不出现**。
 * @param {import('./model.js').CommitView} commit
 * @returns {DayCommit}
 */
function dayCommit(commit) {
  const branch = currentRefsBranch(commit)
  const outputBranch = branch === '未归属 refs' ? '' : branch
  const merge = isMergeCommit(commit)
  const cherryPick = isCherryPickCommit(commit)
  return {
    time: commitClock(commit?.authoredDate),
    title: commitTitle(commit),
    repo: repoPath(commit),
    ...(outputBranch !== '' ? { branch: outputBranch } : {}),
    additions: toInt(commit?.additions),
    deletions: toInt(commit?.deletions),
    commitId: shortCommitID(commit?.commitId),
    ...(merge ? { merge: true } : {}),
    ...(cherryPick ? { cherryPick: true } : {}),
  }
}

/**
 * 某一天的提交列表（Go `Service.dayCommits`，gather.go:174-207）。
 *
 * 与 Go 的差异仅在取数方式：Go 内部先 `GetCommitsInPeriod(date, date)` 查库，
 * 本移植把提交列表作为入参（纯函数、零 IO），由 tools/api 层先用 `listCommitsInPeriod` 取数。
 *
 * @param {import('./model.js').CommitView[]} commits 周期内提交（调用方已按 date 取过数，这里仍严格复筛）
 * @param {string} date `YYYY-MM-DD`（与 Go 一样**原样**用于比较与回显，不做 trim）
 * @param {string} [repoKey] 仓库键；空/未传 = 全部仓库
 * @returns {DayCommitPage}
 */
export function dayCommits(commits, date, repoKey) {
  const list = Array.isArray(commits) ? commits : []
  const day = toStr(date)
  /** @type {import('./model.js').CommitView[]} */
  const matched = []
  for (const commit of list) {
    const authoredDate = toStr(commit?.authoredDate)
    // Go: len < 10 || AuthoredDate[:10] != date → skip
    if (authoredDate.length < 10 || authoredDate.slice(0, 10) !== day) continue
    if (!sameRepoKey(commit, repoKey)) continue
    matched.push(commit)
  }

  const total = matched.length
  const truncated = total > MAX_DAY_COMMITS
  const rows = (truncated ? matched.slice(0, MAX_DAY_COMMITS) : matched).map((commit) =>
    dayCommit(commit),
  )
  const repo = trimSpace(repoKey)
  return {
    date: day,
    ...(repo !== '' ? { repo } : {}),
    total,
    truncated,
    commits: rows,
  }
}
