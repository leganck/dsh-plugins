/**
 * @local/dsh-report · 数据层（SQLite）
 *
 * 职责：建表 / PRAGMA / 事务 / 全部读写函数（CONTRACTS.md §2）。
 * 运行时：`node:sqlite` 的 `DatabaseSync`（宿主 Node 24.21 免 flag；Node 26 本机同样可用）。
 * 零依赖：只用 `node:sqlite` / `node:fs` / `node:path` / `node:module`。
 *
 * 口径纪律（照抄 workbench，勿“顺手修正”）：
 *   - 日期一律 TEXT；分日取 `authored_date` 前 10 位（`substr(authored_date,1,10)`）。
 *   - 区间比较用 'YYYY-MM-DD' 前缀比较（CONTRACTS §1），不要 `date()`（`date()` 会按 UTC 归一）。
 *   - 提交唯一键 `(connection_id, project_id, commit_id)`，重复同步 upsert。
 *   - `commit_branch_refs.branch_order` = GitLab refs 数组下标（报告侧 primary branch = 最小 order）。
 *
 * 行形状兼容约定（跨模块集成防呆）：
 *   - 写入函数同时接受 camelCase 与 snake_case 字段（`projectId` / `project_id`）。
 *   - `listCommitsInPeriod` 返回 **双键**（camelCase + snake_case），因为 domain 分册用
 *     camelCase（07 分册 §1.2 CommitRecord），而 workbench wire 是 snake_case（report/model.go:60-81）。
 *   - `listLineStats` / `listRepoBranchStats` / `listTopics` 以 snake_case 为主（对齐 Go wire），
 *     同时带 camelCase 别名，避免上层二选一踩空。
 *
 * @module lib/db
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const requireBuiltin = createRequire(import.meta.url)

/** 插件库 schema 版本（写 `PRAGMA user_version` + `meta.schema_version`）。 */
export const SCHEMA_VERSION = 1

/** @type {new (path: string) => any} */
let DatabaseSyncCtor = null

/** 懒加载 `node:sqlite`，缺失时给出可读错误（Node < 22.5 场景）。 */
function resolveDatabaseSync() {
  if (DatabaseSyncCtor) return DatabaseSyncCtor
  try {
    const mod = requireBuiltin('node:sqlite')
    if (typeof mod.DatabaseSync !== 'function') {
      throw new Error('node:sqlite 未导出 DatabaseSync')
    }
    DatabaseSyncCtor = mod.DatabaseSync
    return DatabaseSyncCtor
  } catch (error) {
    throw new Error(`当前 Node 运行时没有 node:sqlite（需 ^22.5 || >=24）：${error.message}`)
  }
}

/** 当前时间：ISO8601 字符串（秒级足够，报告域不要求毫秒）。 */
export function nowIso() {
  return new Date().toISOString()
}

// ---------------------------------------------------------------- 表结构

/**
 * CONTRACTS.md §2 的 DDL（列名、类型、主键逐字对齐）。
 * 额外只加索引与 `IF NOT EXISTS`，不改列。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS connections (
  connection_id TEXT PRIMARY KEY,
  base_url      TEXT,
  display_name  TEXT,
  username      TEXT,
  created_at    TEXT
);

CREATE TABLE IF NOT EXISTS repositories (
  connection_id       TEXT NOT NULL,
  project_id          INTEGER NOT NULL,
  path_with_namespace TEXT,
  name                TEXT,
  PRIMARY KEY (connection_id, project_id)
);

CREATE TABLE IF NOT EXISTS commits (
  connection_id   TEXT NOT NULL,
  project_id      INTEGER NOT NULL,
  commit_id       TEXT NOT NULL,
  message         TEXT,
  authored_date   TEXT,
  committed_date  TEXT,
  author_name     TEXT,
  author_email    TEXT,
  title           TEXT,
  is_merge_commit        INTEGER DEFAULT 0,
  is_cherry_pick_commit  INTEGER DEFAULT 0,
  cherry_pick_source_commit TEXT,
  created_at      TEXT,
  PRIMARY KEY (connection_id, project_id, commit_id)
);

CREATE INDEX IF NOT EXISTS idx_commits_authored
  ON commits(authored_date DESC);
CREATE INDEX IF NOT EXISTS idx_commits_proj_authored
  ON commits(connection_id, project_id, authored_date DESC);

CREATE TABLE IF NOT EXISTS commit_stats (
  connection_id TEXT NOT NULL,
  project_id    INTEGER NOT NULL,
  commit_id     TEXT NOT NULL,
  additions     INTEGER DEFAULT 0,
  deletions     INTEGER DEFAULT 0,
  total         INTEGER DEFAULT 0,
  PRIMARY KEY (connection_id, project_id, commit_id)
);

CREATE TABLE IF NOT EXISTS commit_branch_refs (
  connection_id TEXT NOT NULL,
  project_id    INTEGER NOT NULL,
  commit_id     TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  branch_order  INTEGER DEFAULT 0,
  PRIMARY KEY (connection_id, project_id, commit_id, branch_name)
);

CREATE INDEX IF NOT EXISTS idx_commit_refs_commit
  ON commit_branch_refs(connection_id, project_id, commit_id, branch_order);

CREATE TABLE IF NOT EXISTS selected_projects (
  connection_id       TEXT NOT NULL,
  project_id          INTEGER NOT NULL,
  path_with_namespace TEXT,
  name                TEXT,
  enabled             INTEGER DEFAULT 1,
  PRIMARY KEY (connection_id, project_id)
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id        TEXT PRIMARY KEY,
  connection_id TEXT,
  status        TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  progress_json TEXT,
  scope_json    TEXT,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_started
  ON sync_jobs(started_at DESC);

CREATE TABLE IF NOT EXISTS sync_job_errors (
  job_id     TEXT,
  project_id INTEGER,
  commit_id  TEXT,
  stage      TEXT,
  message    TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_job_errors_job
  ON sync_job_errors(job_id, created_at);

CREATE TABLE IF NOT EXISTS reports (
  report_id     TEXT PRIMARY KEY,
  report_type   TEXT,
  period_start  TEXT,
  period_end    TEXT,
  status        TEXT,
  content       TEXT,
  error_message TEXT,
  generated_at  TEXT,
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_period
  ON reports(period_start DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS report_aggregates (
  report_id  TEXT PRIMARY KEY,
  stats_json TEXT
);

CREATE TABLE IF NOT EXISTS report_line_stats (
  report_id     TEXT NOT NULL,
  include_merge INTEGER NOT NULL,
  additions     INTEGER,
  deletions     INTEGER,
  total         INTEGER,
  pure_additions INTEGER,
  PRIMARY KEY (report_id, include_merge)
);

CREATE TABLE IF NOT EXISTS report_repo_branch_stats (
  report_id     TEXT NOT NULL,
  include_merge INTEGER NOT NULL,
  repo_key      TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  commit_count  INTEGER,
  additions     INTEGER,
  deletions     INTEGER,
  total         INTEGER,
  PRIMARY KEY (report_id, include_merge, repo_key, branch_name)
);

CREATE TABLE IF NOT EXISTS report_topics (
  report_id   TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  domain      TEXT,
  topic_title TEXT,
  summary     TEXT,
  PRIMARY KEY (report_id, sort_order)
);
`

// ---------------------------------------------------------------- 值处理

/** 语句缓存：WeakMap<db, Map<sql, stmt>>，避免每次 prepare 的开销。 */
const statementCache = new WeakMap()

/** 取（或编译）一条 prepared statement。 */
function stmt(db, sql) {
  let bySql = statementCache.get(db)
  if (!bySql) {
    bySql = new Map()
    statementCache.set(db, bySql)
  }
  let prepared = bySql.get(sql)
  if (!prepared) {
    prepared = db.prepare(sql)
    bySql.set(sql, prepared)
  }
  return prepared
}

/** 取第一个非 undefined/null 的字段（兼容 camelCase / snake_case 输入）。 */
function pick(source, ...keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key]
  }
  return undefined
}

/** 字符串化（undefined/null → ''），兼容数字。 */
function str(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

/** 整数化（无法解析 → 0），只接受安全范围内数字。 */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 0/1 布尔整数。 */
function boolInt(value) {
  if (value === true || value === 1 || value === '1') return 1
  return 0
}

/** JSON 序列化（对象直接 stringify；字符串原样返回；空值 → null）。 */
function jsonText(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/** JSON 反序列化（失败 → fallback）。 */
function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** 提交三键：用于 keep 集合与批量删除。 */
export function commitKey(connectionId, projectId, commitId) {
  return `${str(connectionId)}\u0000${num(projectId)}\u0000${str(commitId)}`
}

// ---------------------------------------------------------------- 事务

/** @type {WeakMap<any, number>} 每库事务深度，用于嵌套复用外层事务。 */
const transactionDepth = new WeakMap()

/**
 * 在事务中执行同步函数（BEGIN IMMEDIATE / COMMIT / ROLLBACK）。
 * 嵌套调用复用最外层事务（不做 savepoint，保持简单）。
 * @template T
 * @param {any} db openDatabase 返回的 DatabaseSync
 * @param {() => T} fn 同步函数（返回 Promise 视为误用，会回滚并抛错）
 * @returns {T}
 */
export function withTransaction(db, fn) {
  const depth = transactionDepth.get(db) ?? 0
  if (depth > 0) return fn()
  db.exec('BEGIN IMMEDIATE')
  transactionDepth.set(db, 1)
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      throw new Error('withTransaction 只接受同步函数（node:sqlite 为同步驱动）')
    }
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw error
  } finally {
    transactionDepth.set(db, 0)
  }
}

// ---------------------------------------------------------------- 打开/建库

/**
 * 打开（并初始化）插件报告库。
 * - 自动创建父目录；
 * - `PRAGMA journal_mode=WAL` / `synchronous=FULL` / `foreign_keys=ON` / `busy_timeout=5000`；
 * - 建 CONTRACTS §2 全部表；写 `PRAGMA user_version=1` 与 `meta.schema_version/build`。
 * @param {string} dbPath 数据库文件路径
 * @returns {any} DatabaseSync 实例
 */
export function openDatabase(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') throw new Error('openDatabase(dbPath) 需要数据库文件路径')
  const dir = path.dirname(path.resolve(dbPath))
  fs.mkdirSync(dir, { recursive: true })

  const DatabaseSync = resolveDatabaseSync()
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = FULL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  db.exec(SCHEMA_SQL)
  setMeta(db, 'schema_version', String(SCHEMA_VERSION))
  return db
}

// ---------------------------------------------------------------- meta

/** 读 meta 值（不存在 → null）。 */
export function getMeta(db, key) {
  const row = stmt(db, 'SELECT value FROM meta WHERE key = ?').get(str(key))
  return row ? String(row.value) : null
}

/** 写 meta 值（upsert）。 */
export function setMeta(db, key, value) {
  stmt(
    db,
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(str(key), str(value))
  return null
}

// ---------------------------------------------------------------- connections

/**
 * upsert 一条 GitLab 连接元数据（同步时顺带写入，覆盖 baseUrl/显示名/用户名）。
 * @param {any} db
 * @param {{connectionId?: string, connection_id?: string, baseUrl?: string, base_url?: string,
 *          displayName?: string, display_name?: string, username?: string, createdAt?: string,
 *          created_at?: string}} row
 */
export function upsertConnection(db, row) {
  const connectionId = str(pick(row, 'connectionId', 'connection_id'))
  if (!connectionId) throw new Error('upsertConnection 需要 connectionId')
  stmt(
    db,
    `INSERT INTO connections(connection_id, base_url, display_name, username, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(connection_id) DO UPDATE SET
       base_url = excluded.base_url,
       display_name = excluded.display_name,
       username = excluded.username`,
  ).run(
    connectionId,
    str(pick(row, 'baseUrl', 'base_url')),
    str(pick(row, 'displayName', 'display_name')),
    str(pick(row, 'username')),
    str(pick(row, 'createdAt', 'created_at')) || nowIso(),
  )
  return null
}

/** 读一条连接（不存在 → null）。字段 camelCase + snake_case 双写。 */
export function getConnection(db, connectionId) {
  const row = stmt(
    db,
    'SELECT connection_id, base_url, display_name, username, created_at FROM connections WHERE connection_id = ?',
  ).get(str(connectionId))
  if (!row) return null
  return {
    connectionId: str(row.connection_id),
    connection_id: str(row.connection_id),
    baseUrl: str(row.base_url),
    base_url: str(row.base_url),
    displayName: str(row.display_name),
    display_name: str(row.display_name),
    username: str(row.username),
    createdAt: str(row.created_at),
    created_at: str(row.created_at),
  }
}

/** 列出全部连接。 */
/**
 * 删除连接及其仓库范围（提交/任务历史保留，避免误删数据）。
 * @param {any} db
 * @param {string} connectionId
 */
export function deleteConnection(db, connectionId) {
  const id = str(connectionId)
  if (!id) return { removed: false }
  return withTransaction(db, () => {
    stmt(db, 'DELETE FROM selected_projects WHERE connection_id = ?').run(id)
    const result = stmt(db, 'DELETE FROM connections WHERE connection_id = ?').run(id)
    return { removed: Number(result.changes ?? 0) > 0 }
  })
}

export function listConnections(db) {
  const rows = stmt(db, 'SELECT connection_id FROM connections ORDER BY created_at, connection_id').all()
  return rows.map((row) => getConnection(db, row.connection_id))
}

// ---------------------------------------------------------------- commits 写入

/**
 * 批量 upsert 提交（单事务）。重复导入同键 = 覆盖，天然幂等。
 * @param {any} db
 * @param {Array<object>} records 每项字段（camelCase 或 snake_case 均可）：
 *   connectionId/projectId/commitId/message/authoredDate/committedDate/authorName/authorEmail/title/
 *   isMergeCommit/isCherryPickCommit/cherryPickSourceCommit/createdAt
 * @returns {{written: number}}
 */
export function upsertCommits(db, records) {
  const items = Array.isArray(records) ? records : []
  if (!items.length) return { written: 0 }
  const sql = `INSERT INTO commits(
      connection_id, project_id, commit_id, message, authored_date, committed_date,
      author_name, author_email, title, is_merge_commit, is_cherry_pick_commit,
      cherry_pick_source_commit, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(connection_id, project_id, commit_id) DO UPDATE SET
      message = excluded.message,
      authored_date = excluded.authored_date,
      committed_date = excluded.committed_date,
      author_name = excluded.author_name,
      author_email = excluded.author_email,
      title = excluded.title,
      is_merge_commit = excluded.is_merge_commit,
      is_cherry_pick_commit = excluded.is_cherry_pick_commit,
      cherry_pick_source_commit = excluded.cherry_pick_source_commit`
  const statement = stmt(db, sql)
  const now = nowIso()
  withTransaction(db, () => {
    for (const item of items) {
      statement.run(
        str(pick(item, 'connectionId', 'connection_id')),
        num(pick(item, 'projectId', 'project_id')),
        str(pick(item, 'commitId', 'commit_id', 'id')),
        str(pick(item, 'message')),
        str(pick(item, 'authoredDate', 'authored_date')),
        str(pick(item, 'committedDate', 'committed_date')),
        str(pick(item, 'authorName', 'author_name')),
        str(pick(item, 'authorEmail', 'author_email')),
        str(pick(item, 'title')),
        boolInt(pick(item, 'isMergeCommit', 'is_merge_commit')),
        boolInt(pick(item, 'isCherryPickCommit', 'is_cherry_pick_commit')),
        str(pick(item, 'cherryPickSourceCommit', 'cherry_pick_source_commit')),
        str(pick(item, 'createdAt', 'created_at')) || now,
      )
    }
  })
  return { written: items.length }
}

/**
 * 批量替换提交行数统计（先删同键再插，单事务）。
 * @param {any} db
 * @param {Array<object>} records {connectionId, projectId, commitId, additions, deletions, total}
 * @returns {{written: number}}
 */
export function replaceCommitStats(db, records) {
  const items = Array.isArray(records) ? records : []
  if (!items.length) return { written: 0 }
  const del = stmt(
    db,
    'DELETE FROM commit_stats WHERE connection_id = ? AND project_id = ? AND commit_id = ?',
  )
  const ins = stmt(
    db,
    `INSERT OR REPLACE INTO commit_stats(connection_id, project_id, commit_id, additions, deletions, total)
     VALUES (?,?,?,?,?,?)`,
  )
  withTransaction(db, () => {
    for (const item of items) {
      const connectionId = str(pick(item, 'connectionId', 'connection_id'))
      const projectId = num(pick(item, 'projectId', 'project_id'))
      const commitId = str(pick(item, 'commitId', 'commit_id', 'id'))
      del.run(connectionId, projectId, commitId)
      ins.run(
        connectionId,
        projectId,
        commitId,
        num(pick(item, 'additions')),
        num(pick(item, 'deletions')),
        num(pick(item, 'total')),
      )
    }
  })
  return { written: items.length }
}

/**
 * 批量替换提交的分支引用（先删该提交全部 refs 再按数组序插，单事务）。
 * `branchOrder` 缺省 = 数组下标（对应 GitLab refs 返回顺序）。
 * @param {any} db
 * @param {Array<{connectionId?: string, projectId?: number, commitId?: string, branches: Array<string|{name?: string}>}>} records
 * @returns {{written: number}}
 */
export function replaceCommitRefs(db, records) {
  const items = Array.isArray(records) ? records : []
  if (!items.length) return { written: 0 }
  const del = stmt(
    db,
    'DELETE FROM commit_branch_refs WHERE connection_id = ? AND project_id = ? AND commit_id = ?',
  )
  const ins = stmt(
    db,
    `INSERT OR REPLACE INTO commit_branch_refs(connection_id, project_id, commit_id, branch_name, branch_order)
     VALUES (?,?,?,?,?)`,
  )
  withTransaction(db, () => {
    for (const item of items) {
      const connectionId = str(pick(item, 'connectionId', 'connection_id'))
      const projectId = num(pick(item, 'projectId', 'project_id'))
      const commitId = str(pick(item, 'commitId', 'commit_id', 'id'))
      del.run(connectionId, projectId, commitId)
      const branches = Array.isArray(item.branches) ? item.branches : Array.isArray(item.refs) ? item.refs : []
      branches.forEach((branch, index) => {
        const name = str(typeof branch === 'string' ? branch : pick(branch, 'name', 'branchName', 'branch_name'))
        if (!name) return
        ins.run(connectionId, projectId, commitId, name, index)
      })
    }
  })
  return { written: items.length }
}

/**
 * 批量 upsert 仓库（同步时写入 name/path_with_namespace）。
 * @param {any} db
 * @param {Array<object>} records {connectionId, projectId, pathWithNamespace, name}
 */
export function upsertRepositories(db, records) {
  const items = Array.isArray(records) ? records : []
  if (!items.length) return { written: 0 }
  const statement = stmt(
    db,
    `INSERT INTO repositories(connection_id, project_id, path_with_namespace, name)
     VALUES (?,?,?,?)
     ON CONFLICT(connection_id, project_id) DO UPDATE SET
       path_with_namespace = excluded.path_with_namespace,
       name = excluded.name`,
  )
  withTransaction(db, () => {
    for (const item of items) {
      statement.run(
        str(pick(item, 'connectionId', 'connection_id')),
        num(pick(item, 'projectId', 'project_id')),
        str(pick(item, 'pathWithNamespace', 'path_with_namespace')),
        str(pick(item, 'name')),
      )
    }
  })
  return { written: items.length }
}

// ---------------------------------------------------------------- commits 读取

/**
 * 读区间内提交（JOIN 行数统计 / 仓库 / 分支 refs），口径复刻 Go `GetCommitsInPeriod`
 * （`internal/report/sqlite/repository.go:19-78`）：按 `authored_date` 前 10 位区间过滤，
 * ORDER BY authored_date DESC（与 Go 一致，不加 tie-break）。
 *
 * @param {any} db
 * @param {{connectionIds?: string[]|string, startDate: string, endDate: string}} query
 * @returns {Array<object>} 每行同时含 camelCase 与 snake_case 键（见模块头注释）
 */
export function listCommitsInPeriod(db, query) {
  const startDate = str(query?.startDate)
  const endDate = str(query?.endDate)
  if (!startDate || !endDate) throw new Error('listCommitsInPeriod 需要 startDate 与 endDate')
  const ids = normalizeIds(query?.connectionIds)
  const filter = ids.length ? ` AND c.connection_id IN (${ids.map(() => '?').join(',')})` : ''
  const sql = `
    SELECT c.connection_id, c.project_id, c.commit_id, COALESCE(c.message,'') AS message,
           COALESCE(c.authored_date,'') AS authored_date, COALESCE(c.committed_date,'') AS committed_date,
           COALESCE(c.author_name,'') AS author_name, COALESCE(c.author_email,'') AS author_email,
           COALESCE(c.title,'') AS title,
           COALESCE(c.is_merge_commit,0) AS is_merge_commit,
           COALESCE(c.is_cherry_pick_commit,0) AS is_cherry_pick_commit,
           COALESCE(c.cherry_pick_source_commit,'') AS cherry_pick_source_commit,
           COALESCE(s.additions,0) AS additions, COALESCE(s.deletions,0) AS deletions,
           COALESCE(s.total,0) AS total,
           COALESCE(r.name,'') AS repo_name,
           COALESCE(r.path_with_namespace,'') AS path_with_namespace,
           COALESCE((
             SELECT br.branch_name FROM commit_branch_refs br
             WHERE br.connection_id = c.connection_id AND br.project_id = c.project_id
               AND br.commit_id = c.commit_id
             ORDER BY br.branch_order ASC, br.branch_name ASC LIMIT 1
           ), '') AS primary_branch,
           COALESCE((
             SELECT json_group_array(branch_name) FROM (
               SELECT br.branch_name FROM commit_branch_refs br
               WHERE br.connection_id = c.connection_id AND br.project_id = c.project_id
                 AND br.commit_id = c.commit_id
               ORDER BY br.branch_order ASC, br.branch_name ASC
             )
           ), '[]') AS branch_names_json
    FROM commits c
    LEFT JOIN commit_stats s
      ON s.connection_id = c.connection_id AND s.project_id = c.project_id AND s.commit_id = c.commit_id
    LEFT JOIN repositories r
      ON r.connection_id = c.connection_id AND r.project_id = c.project_id
    WHERE substr(c.authored_date, 1, 10) >= ? AND substr(c.authored_date, 1, 10) <= ?${filter}
    ORDER BY c.authored_date DESC`
  const rows = stmt(db, sql).all(startDate, endDate, ...ids)
  return rows.map((row) => {
    const branchNames = parseJson(row.branch_names_json, [])
    return {
      // camelCase（domain 分册 07 口径）
      connectionId: str(row.connection_id),
      projectId: num(row.project_id),
      commitId: str(row.commit_id),
      message: str(row.message),
      authoredDate: str(row.authored_date),
      committedDate: str(row.committed_date),
      authorName: str(row.author_name),
      authorEmail: str(row.author_email),
      title: str(row.title),
      isMergeCommit: num(row.is_merge_commit),
      isCherryPickCommit: num(row.is_cherry_pick_commit),
      cherryPickSourceCommit: str(row.cherry_pick_source_commit),
      additions: num(row.additions),
      deletions: num(row.deletions),
      total: num(row.total),
      repoName: str(row.repo_name),
      repoNamespace: '',
      pathWithNamespace: str(row.path_with_namespace),
      primaryBranch: str(row.primary_branch),
      branchNamesJson: str(row.branch_names_json),
      branchNames: Array.isArray(branchNames) ? branchNames.map(str) : [],
      // snake_case（workbench wire 口径，report/model.go:60-81）
      connection_id: str(row.connection_id),
      project_id: num(row.project_id),
      commit_id: str(row.commit_id),
      authored_date: str(row.authored_date),
      committed_date: str(row.committed_date),
      author_name: str(row.author_name),
      author_email: str(row.author_email),
      is_merge_commit: num(row.is_merge_commit),
      is_cherry_pick_commit: num(row.is_cherry_pick_commit),
      cherry_pick_source_commit: str(row.cherry_pick_source_commit),
      repo_name: str(row.repo_name),
      path_with_namespace: str(row.path_with_namespace),
      primary_branch: str(row.primary_branch),
      branch_names_json: str(row.branch_names_json),
    }
  })
}

/**
 * 覆盖度使用的轻量行（只取聚合需要的列，不 JOIN stats/refs）。
 * 供 `lib/sync.js#coverage` 使用；不传区间 = 全量。
 *
 * @param {any} db
 * @param {{connectionIds?: string[]|string, startDate?: string, endDate?: string}} query
 * @returns {Array<{connectionId: string, projectId: number, pathWithNamespace: string,
 *   authoredDate: string}>}
 */
export function listCoverageRows(db, query) {
  const ids = normalizeIds(query?.connectionIds)
  const startDate = str(query?.startDate)
  const endDate = str(query?.endDate)
  const clauses = []
  const args = []
  if (startDate) {
    clauses.push('substr(c.authored_date, 1, 10) >= ?')
    args.push(startDate)
  }
  if (endDate) {
    clauses.push('substr(c.authored_date, 1, 10) <= ?')
    args.push(endDate)
  }
  if (ids.length) {
    clauses.push(`c.connection_id IN (${ids.map(() => '?').join(',')})`)
    args.push(...ids)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = stmt(
    db,
    `SELECT c.connection_id, c.project_id, c.authored_date,
            COALESCE(r.path_with_namespace, CAST(c.project_id AS TEXT)) AS path_with_namespace,
            COALESCE(s.additions, 0) AS additions, COALESCE(s.deletions, 0) AS deletions
     FROM commits c
     LEFT JOIN repositories r
       ON r.connection_id = c.connection_id AND r.project_id = c.project_id
     LEFT JOIN commit_stats s
       ON s.connection_id = c.connection_id AND s.project_id = c.project_id AND s.commit_id = c.commit_id
     ${where}
     ORDER BY c.authored_date ASC`,
  ).all(...args)
  return rows.map((row) => ({
    connectionId: str(row.connection_id),
    projectId: num(row.project_id),
    pathWithNamespace: str(row.path_with_namespace),
    authoredDate: str(row.authored_date),
    additions: num(row.additions),
    deletions: num(row.deletions),
  }))
}

/** connectionIds 归一化为字符串数组（去空、去重）。 */
function normalizeIds(value) {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  const out = []
  const seen = new Set()
  for (const item of list) {
    const id = str(item).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

// ---------------------------------------------------------------- selected_projects

/**
 * 读同步范围（按连接；不传 connectionId = 全部）。
 * @returns {Array<{connectionId: string, projectId: number, pathWithNamespace: string, name: string, enabled: number}>}
 */
export function selectedProjects(db, connectionId) {
  const id = str(connectionId)
  const rows = id
    ? stmt(
        db,
        `SELECT connection_id, project_id, path_with_namespace, name, COALESCE(enabled,1) AS enabled
         FROM selected_projects WHERE connection_id = ? ORDER BY path_with_namespace, project_id`,
      ).all(id)
    : stmt(
        db,
        `SELECT connection_id, project_id, path_with_namespace, name, COALESCE(enabled,1) AS enabled
         FROM selected_projects ORDER BY connection_id, path_with_namespace, project_id`,
      ).all()
  return rows.map((row) => ({
    connectionId: str(row.connection_id),
    connection_id: str(row.connection_id),
    projectId: num(row.project_id),
    project_id: num(row.project_id),
    pathWithNamespace: str(row.path_with_namespace),
    path_with_namespace: str(row.path_with_namespace),
    name: str(row.name),
    enabled: num(row.enabled),
  }))
}

/**
 * 全量替换某连接的同步范围（先 DELETE 该连接再逐行插入，单事务）。
 * @param {any} db
 * @param {string} connectionId
 * @param {Array<object>} rows {projectId|id, pathWithNamespace, name, enabled?}
 * @returns {{saved: number}}
 */
export function saveSelectedProjects(db, connectionId, rows) {
  const id = str(connectionId)
  if (!id) throw new Error('saveSelectedProjects 需要 connectionId')
  const items = Array.isArray(rows) ? rows : []
  const del = stmt(db, 'DELETE FROM selected_projects WHERE connection_id = ?')
  const ins = stmt(
    db,
    `INSERT OR REPLACE INTO selected_projects(connection_id, project_id, path_with_namespace, name, enabled)
     VALUES (?,?,?,?,?)`,
  )
  withTransaction(db, () => {
    del.run(id)
    for (const item of items) {
      ins.run(
        id,
        num(pick(item, 'projectId', 'project_id', 'id')),
        str(pick(item, 'pathWithNamespace', 'path_with_namespace')),
        str(pick(item, 'name')),
        pick(item, 'enabled') === undefined ? 1 : boolInt(pick(item, 'enabled')),
      )
    }
  })
  return { saved: items.length }
}

// ---------------------------------------------------------------- prune（P2）

/**
 * 删除窗口内「本次同步没再见到」的提交（P2；同步引擎仅在项目完整翻页时调用）。
 *
 * 复刻 Go `DeleteStaleSyncedDataInRange`（`commit_import_repository.go:58-118`）的语义：
 * 只处理 `projects` 指定范围、`substr(authored_date,1,10)` 落在 `keepWindow` 内的本地行，
 * 不在 `keep` 集合中的级联删除（refs/stats/commits）。
 *
 * @param {any} db
 * @param {{connectionIds?: string[]|string,
 *          keepWindow?: {startDate: string, endDate: string},
 *          projects?: Array<{connectionId?: string, projectId?: number}>,
 *          keep?: Set<string>|string[]|((key: string) => boolean)}} options
 *        `keep` 元素为 `commitKey(connectionId, projectId, commitId)`；不传 = 不删除任何行（安全默认）。
 * @returns {{deleted: number}}
 */
export function pruneCommits(db, options) {
  const opts = options ?? {}
  const connectionIds = normalizeIds(opts.connectionIds)
  const windowStart = str(opts.keepWindow?.startDate ?? opts.startDate)
  const windowEnd = str(opts.keepWindow?.endDate ?? opts.endDate)
  const projects = Array.isArray(opts.projects) ? opts.projects : []
  if (!windowStart || !windowEnd) return { deleted: 0 }

  const isKept = toKeepPredicate(opts.keep)
  if (!isKept) return { deleted: 0 } // 没有 keep 集合时绝不删除（防止误清历史）

  const clauses = []
  const args = []
  if (connectionIds.length) {
    clauses.push(`connection_id IN (${connectionIds.map(() => '?').join(',')})`)
    args.push(...connectionIds)
  }
  if (projects.length) {
    const projectClauses = projects.map(() => '(connection_id = ? AND project_id = ?)')
    clauses.push(`(${projectClauses.join(' OR ')})`)
    for (const project of projects) {
      args.push(str(pick(project, 'connectionId', 'connection_id')), num(pick(project, 'projectId', 'project_id')))
    }
  }
  const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
  const candidates = stmt(
    db,
    `SELECT connection_id, project_id, commit_id FROM commits
     WHERE substr(authored_date, 1, 10) >= ? AND substr(authored_date, 1, 10) <= ?${where}`,
  ).all(windowStart, windowEnd, ...args)

  const stale = candidates.filter(
    (row) => !isKept(commitKey(row.connection_id, row.project_id, row.commit_id)),
  )
  if (!stale.length) return { deleted: 0 }

  const delRefs = stmt(
    db,
    'DELETE FROM commit_branch_refs WHERE connection_id = ? AND project_id = ? AND commit_id = ?',
  )
  const delStats = stmt(
    db,
    'DELETE FROM commit_stats WHERE connection_id = ? AND project_id = ? AND commit_id = ?',
  )
  const delCommit = stmt(
    db,
    'DELETE FROM commits WHERE connection_id = ? AND project_id = ? AND commit_id = ?',
  )
  withTransaction(db, () => {
    for (const row of stale) {
      delRefs.run(row.connection_id, row.project_id, row.commit_id)
      delStats.run(row.connection_id, row.project_id, row.commit_id)
      delCommit.run(row.connection_id, row.project_id, row.commit_id)
    }
  })
  return { deleted: stale.length }
}

/** 把 keep 描述归一成判定函数；未提供 → null（调用方据此跳过删除）。 */
function toKeepPredicate(keep) {
  if (!keep) return null
  if (typeof keep === 'function') return (key) => Boolean(keep(key))
  if (keep instanceof Set) return (key) => keep.has(key)
  if (Array.isArray(keep)) {
    const set = new Set(keep.map((item) => str(item)))
    return (key) => set.has(key)
  }
  return null
}

// ---------------------------------------------------------------- reports

/** ISO 时间或空串。 */
function textOrNull(value) {
  const text = str(value).trim()
  return text === '' ? null : text
}

/**
 * upsert 报告主行（同 report_id 覆盖）。可选同时写 aggregates（`statsJson` 字符串或对象）。
 *
 * @param {any} db
 * @param {{reportId?: string, report_id?: string, reportType?: string, report_type?: string,
 *          periodStart?: string, period_start?: string, periodEnd?: string, period_end?: string,
 *          status?: string, content?: string|null, errorMessage?: string|null, error_message?: string|null,
 *          generatedAt?: string|null, generated_at?: string|null, updatedAt?: string, updated_at?: string,
 *          statsJson?: string|object, stats_json?: string|object, aggregates?: object}} row
 * @returns {{reportId: string}}
 */
export function upsertReportRow(db, row) {
  const reportId = str(pick(row, 'reportId', 'report_id'))
  if (!reportId) throw new Error('upsertReportRow 需要 reportId')
  const updatedAt = str(pick(row, 'updatedAt', 'updated_at')) || nowIso()
  const generatedAt = textOrNull(pick(row, 'generatedAt', 'generated_at'))
  const content = pick(row, 'content')
  const aggregates = pick(row, 'statsJson', 'stats_json', 'aggregates', 'aggregatesJson', 'aggregates_json')
  withTransaction(db, () => {
    stmt(
      db,
      `INSERT INTO reports(report_id, report_type, period_start, period_end, status, content,
                           error_message, generated_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(report_id) DO UPDATE SET
         report_type = excluded.report_type,
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         status = excluded.status,
         content = excluded.content,
         error_message = excluded.error_message,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at`,
    ).run(
      reportId,
      str(pick(row, 'reportType', 'report_type')) || '',
      str(pick(row, 'periodStart', 'period_start')) || '',
      str(pick(row, 'periodEnd', 'period_end')) || '',
      str(pick(row, 'status')) || 'pending',
      content === undefined || content === null ? null : String(content),
      textOrNull(pick(row, 'errorMessage', 'error_message')),
      generatedAt,
      updatedAt,
    )
    if (aggregates !== undefined && aggregates !== null) {
      stmt(
        db,
        `INSERT INTO report_aggregates(report_id, stats_json) VALUES (?,?)
         ON CONFLICT(report_id) DO UPDATE SET stats_json = excluded.stats_json`,
      ).run(reportId, jsonText(aggregates) ?? '{}')
    }
  })
  return { reportId }
}

/**
 * 单独写报告聚合统计（供 domain 的 persistCore 在有此函数时优先调用）。
 * @param {any} db
 * @param {string} reportId
 * @param {object|string} aggregates AggregateStats 对象或 stats_json 字符串
 * @returns {{reportId: string}}
 */
export function upsertReportAggregates(db, reportId, aggregates) {
  const id = str(reportId)
  if (!id) throw new Error('upsertReportAggregates 需要 reportId')
  stmt(
    db,
    `INSERT INTO report_aggregates(report_id, stats_json) VALUES (?,?)
     ON CONFLICT(report_id) DO UPDATE SET stats_json = excluded.stats_json`,
  ).run(id, jsonText(aggregates) ?? '{}')
  return { reportId: id }
}

/** reports + aggregates 行 → 统一视图（getReportRow / listReportRows 共用）。 */
function mapReportRow(row) {
  const statsJson = str(row.stats_json)
  return {
    reportId: str(row.report_id),
    report_id: str(row.report_id),
    reportType: str(row.report_type),
    report_type: str(row.report_type),
    periodStart: str(row.period_start),
    period_start: str(row.period_start),
    periodEnd: str(row.period_end),
    period_end: str(row.period_end),
    status: str(row.status),
    content: row.content === null || row.content === undefined ? null : String(row.content),
    errorMessage: textOrNull(row.error_message),
    error_message: textOrNull(row.error_message),
    generatedAt: textOrNull(row.generated_at),
    generated_at: textOrNull(row.generated_at),
    updatedAt: str(row.updated_at),
    updated_at: str(row.updated_at),
    statsJson,
    stats_json: statsJson,
    aggregates: parseJson(statsJson, null),
  }
}

/**
 * 读报告主行（含 aggregates 解析结果；不存在 → null）。
 * @returns {null | {reportId: string, reportType: string, periodStart: string, periodEnd: string,
 *   status: string, content: string|null, errorMessage: string|null, generatedAt: string|null,
 *   updatedAt: string, statsJson: string, aggregates: object|null}}
 */
export function getReportRow(db, reportId) {
  const row = stmt(
    db,
    `SELECT r.report_id, r.report_type, r.period_start, r.period_end, r.status, r.content,
            r.error_message, r.generated_at, r.updated_at, a.stats_json
     FROM reports r
     LEFT JOIN report_aggregates a ON a.report_id = r.report_id
     WHERE r.report_id = ?`,
  ).get(str(reportId))
  if (!row) return null
  return mapReportRow(row)
}

/**
 * 列出报告主行（按 period_start DESC, updated_at DESC；与 Go ListReports 一致）。
 * 单条 JOIN 查询（避免逐行 N+1），行形状与 getReportRow 相同。
 * @returns {ReturnType<typeof getReportRow>[]}
 */
export function listReportRows(db) {
  const rows = stmt(
    db,
    `SELECT r.report_id, r.report_type, r.period_start, r.period_end, r.status, r.content,
            r.error_message, r.generated_at, r.updated_at, a.stats_json
     FROM reports r
     LEFT JOIN report_aggregates a ON a.report_id = r.report_id
     ORDER BY r.period_start DESC, r.updated_at DESC, r.report_id DESC`,
  ).all()
  return rows.map((row) => mapReportRow(row))
}

/**
 * 删除报告及其全部子投影（单事务；替代 Go 的 6 次 DELETE + 无事务）。
 * @returns {boolean} 是否删到了主行
 */
export function deleteReportRow(db, reportId) {
  const id = str(reportId)
  return withTransaction(db, () => {
    stmt(db, 'DELETE FROM report_line_stats WHERE report_id = ?').run(id)
    stmt(db, 'DELETE FROM report_repo_branch_stats WHERE report_id = ?').run(id)
    stmt(db, 'DELETE FROM report_topics WHERE report_id = ?').run(id)
    stmt(db, 'DELETE FROM report_aggregates WHERE report_id = ?').run(id)
    const result = stmt(db, 'DELETE FROM reports WHERE report_id = ?').run(id)
    return Number(result.changes ?? 0) > 0
  })
}

/**
 * 全量替换行数统计（2 行/报告：include_merge=1/0；单事务）。
 * 接受 domain 的 camelCase `LineStat` 或 storage 的 snake_case 行。
 * @param {any} db
 * @param {string} reportId
 * @param {Array<object>} rows {includeMerge|include_merge, additions, deletions, total, pureAdditions|pure_additions}
 * @returns {{written: number}}
 */
export function replaceLineStats(db, reportId, rows) {
  const id = str(reportId)
  const items = Array.isArray(rows) ? rows : []
  const del = stmt(db, 'DELETE FROM report_line_stats WHERE report_id = ?')
  const ins = stmt(
    db,
    `INSERT OR REPLACE INTO report_line_stats(report_id, include_merge, additions, deletions, total, pure_additions)
     VALUES (?,?,?,?,?,?)`,
  )
  withTransaction(db, () => {
    del.run(id)
    for (const item of items) {
      ins.run(
        id,
        boolInt(pick(item, 'includeMerge', 'include_merge')),
        num(pick(item, 'additions')),
        num(pick(item, 'deletions')),
        num(pick(item, 'total')),
        num(pick(item, 'pureAdditions', 'pure_additions')),
      )
    }
  })
  return { written: items.length }
}

/**
 * 读行数统计（2 行；snake_case 为主 + camelCase 别名）。
 * @returns {Array<{include_merge: number, additions: number, deletions: number, total: number,
 *   pure_additions: number, report_id: string, includeMerge: number, pureAdditions: number}>}
 */
export function listLineStats(db, reportId) {
  const rows = stmt(
    db,
    `SELECT report_id, include_merge, COALESCE(additions,0) AS additions, COALESCE(deletions,0) AS deletions,
            COALESCE(total,0) AS total, COALESCE(pure_additions,0) AS pure_additions
     FROM report_line_stats WHERE report_id = ? ORDER BY include_merge DESC`,
  ).all(str(reportId))
  return rows.map((row) => ({
    report_id: str(row.report_id),
    include_merge: num(row.include_merge),
    additions: num(row.additions),
    deletions: num(row.deletions),
    total: num(row.total),
    pure_additions: num(row.pure_additions),
    includeMerge: num(row.include_merge),
    pureAdditions: num(row.pure_additions),
  }))
}

/**
 * 全量替换仓库×分支统计（单事务）。
 * @param {Array<object>} rows {includeMerge|include_merge, repoKey|repo_key, branchName|branch_name,
 *   commitCount|commit_count, additions, deletions, total}
 */
export function replaceRepoBranchStats(db, reportId, rows) {
  const id = str(reportId)
  const items = Array.isArray(rows) ? rows : []
  const del = stmt(db, 'DELETE FROM report_repo_branch_stats WHERE report_id = ?')
  const ins = stmt(
    db,
    `INSERT OR REPLACE INTO report_repo_branch_stats(
       report_id, include_merge, repo_key, branch_name, commit_count, additions, deletions, total)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
  withTransaction(db, () => {
    del.run(id)
    for (const item of items) {
      ins.run(
        id,
        boolInt(pick(item, 'includeMerge', 'include_merge')),
        str(pick(item, 'repoKey', 'repo_key')),
        str(pick(item, 'branchName', 'branch_name')),
        num(pick(item, 'commitCount', 'commit_count')),
        num(pick(item, 'additions')),
        num(pick(item, 'deletions')),
        num(pick(item, 'total')),
      )
    }
  })
  return { written: items.length }
}

/**
 * 读仓库×分支统计（snake_case 为主 + camelCase 别名）。
 * 排序：include_merge DESC, total DESC, repo_key, branch_name（与 Go 索引/data 顺序一致）。
 */
export function listRepoBranchStats(db, reportId) {
  const rows = stmt(
    db,
    `SELECT report_id, include_merge, repo_key, branch_name, COALESCE(commit_count,0) AS commit_count,
            COALESCE(additions,0) AS additions, COALESCE(deletions,0) AS deletions, COALESCE(total,0) AS total
     FROM report_repo_branch_stats WHERE report_id = ?
     ORDER BY include_merge DESC, total DESC, repo_key ASC, branch_name ASC`,
  ).all(str(reportId))
  return rows.map((row) => ({
    report_id: str(row.report_id),
    include_merge: num(row.include_merge),
    repo_key: str(row.repo_key),
    branch_name: str(row.branch_name),
    commit_count: num(row.commit_count),
    additions: num(row.additions),
    deletions: num(row.deletions),
    total: num(row.total),
    includeMerge: num(row.include_merge),
    repoKey: str(row.repo_key),
    branchName: str(row.branch_name),
    commitCount: num(row.commit_count),
  }))
}

/**
 * 全量替换主题（单事务，按数组序写 sort_order；数组项自带 sortOrder 时优先用它）。
 * @param {Array<object>} rows {domain, topicTitle|topic_title, summary, sortOrder|sort_order?}
 */
export function replaceTopics(db, reportId, rows) {
  const id = str(reportId)
  const items = Array.isArray(rows) ? rows : []
  const del = stmt(db, 'DELETE FROM report_topics WHERE report_id = ?')
  const ins = stmt(
    db,
    `INSERT OR REPLACE INTO report_topics(report_id, sort_order, domain, topic_title, summary)
     VALUES (?,?,?,?,?)`,
  )
  withTransaction(db, () => {
    del.run(id)
    items.forEach((item, index) => {
      ins.run(
        id,
        num(pick(item, 'sortOrder', 'sort_order', 'sort_order_index')) || index + 1,
        str(pick(item, 'domain')),
        str(pick(item, 'topicTitle', 'topic_title')),
        str(pick(item, 'summary')),
      )
    })
  })
  return { written: items.length }
}

/**
 * 读主题（snake_case 为主 + camelCase 别名；ORDER BY sort_order）。
 */
export function listTopics(db, reportId) {
  const rows = stmt(
    db,
    `SELECT report_id, sort_order, COALESCE(domain,'') AS domain,
            COALESCE(topic_title,'') AS topic_title, COALESCE(summary,'') AS summary
     FROM report_topics WHERE report_id = ? ORDER BY sort_order ASC`,
  ).all(str(reportId))
  return rows.map((row) => ({
    report_id: str(row.report_id),
    sort_order: num(row.sort_order),
    domain: str(row.domain),
    topic_title: str(row.topic_title),
    summary: str(row.summary),
    sortOrder: num(row.sort_order),
    topicTitle: str(row.topic_title),
  }))
}

// ---------------------------------------------------------------- sync jobs

/** 解析 progress/scope JSON 为对象（失败 → 默认值）。 */
function parseObject(value, fallback) {
  const parsed = parseJson(value, null)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
}

/** 把 sync_jobs 行投影成统一视图（camelCase；JSON 字段已解析）。 */
function mapSyncJob(row, errors) {
  if (!row) return null
  return {
    jobId: str(row.job_id),
    job_id: str(row.job_id),
    connectionId: str(row.connection_id),
    connection_id: str(row.connection_id),
    status: str(row.status),
    startedAt: str(row.started_at),
    started_at: str(row.started_at),
    finishedAt: str(row.finished_at),
    finished_at: str(row.finished_at),
    progress: parseObject(row.progress_json, {}),
    progressJson: str(row.progress_json),
    scope: parseObject(row.scope_json, { projects: [], startDate: '', endDate: '' }),
    scopeJson: str(row.scope_json),
    error: str(row.error),
    errors: errors ?? [],
  }
}

/**
 * 创建同步任务（初始 pending）。
 * @param {any} db
 * @param {{jobId: string, connectionId?: string, status?: string, startedAt?: string,
 *          progress?: object, scope?: object|Array, error?: string}} row
 */
export function createSyncJob(db, row) {
  const jobId = str(pick(row, 'jobId', 'job_id'))
  if (!jobId) throw new Error('createSyncJob 需要 jobId')
  stmt(
    db,
    `INSERT INTO sync_jobs(job_id, connection_id, status, started_at, finished_at,
                           progress_json, scope_json, error)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    jobId,
    str(pick(row, 'connectionId', 'connection_id')),
    str(pick(row, 'status')) || 'pending',
    str(pick(row, 'startedAt', 'started_at')) || nowIso(),
    textOrNull(pick(row, 'finishedAt', 'finished_at')),
    jsonText(pick(row, 'progress')) ?? '{}',
    jsonText(pick(row, 'scope')) ?? '{}',
    textOrNull(pick(row, 'error')),
  )
  return { jobId }
}

/**
 * 局部更新同步任务（只写传入字段；finishedAt/status/error 可显式置空）。
 * @param {any} db
 * @param {string} jobId
 * @param {{status?: string, finishedAt?: string|null, progress?: object, scope?: object,
 *          error?: string|null, connectionId?: string}} patch
 */
export function updateSyncJob(db, jobId, patch) {
  const id = str(jobId)
  const sets = []
  const args = []
  const data = patch ?? {}
  if (data.connectionId !== undefined || data.connection_id !== undefined) {
    sets.push('connection_id = ?')
    args.push(str(pick(data, 'connectionId', 'connection_id')))
  }
  if (data.status !== undefined) {
    sets.push('status = ?')
    args.push(str(data.status))
  }
  if (data.startedAt !== undefined || data.started_at !== undefined) {
    sets.push('started_at = ?')
    args.push(str(pick(data, 'startedAt', 'started_at')))
  }
  if (data.finishedAt !== undefined || data.finished_at !== undefined) {
    sets.push('finished_at = ?')
    args.push(textOrNull(pick(data, 'finishedAt', 'finished_at')))
  }
  if (data.progress !== undefined) {
    sets.push('progress_json = ?')
    args.push(jsonText(data.progress) ?? '{}')
  }
  if (data.scope !== undefined) {
    sets.push('scope_json = ?')
    args.push(jsonText(data.scope) ?? '{}')
  }
  if (data.error !== undefined) {
    sets.push('error = ?')
    args.push(textOrNull(data.error))
  }
  if (!sets.length) return { updated: false }
  args.push(id)
  const result = stmt(db, `UPDATE sync_jobs SET ${sets.join(', ')} WHERE job_id = ?`).run(...args)
  return { updated: Number(result.changes ?? 0) > 0 }
}

/**
 * 读同步任务（含错误明细；不存在 → null）。
 * @returns {null | ReturnType<typeof mapSyncJob>}
 */
export function getSyncJob(db, jobId) {
  const row = stmt(db, 'SELECT * FROM sync_jobs WHERE job_id = ?').get(str(jobId))
  if (!row) return null
  return mapSyncJob(row, listSyncJobErrors(db, jobId))
}

/** 读某任务的错误明细（按创建时间）。 */
export function listSyncJobErrors(db, jobId) {
  const rows = stmt(
    db,
    `SELECT job_id, project_id, commit_id, stage, message, created_at
     FROM sync_job_errors WHERE job_id = ? ORDER BY created_at ASC, rowid ASC`,
  ).all(str(jobId))
  return rows.map((row) => ({
    jobId: str(row.job_id),
    job_id: str(row.job_id),
    projectId: row.project_id === null ? null : num(row.project_id),
    project_id: row.project_id === null ? null : num(row.project_id),
    commitId: row.commit_id === null ? null : str(row.commit_id),
    commit_id: row.commit_id === null ? null : str(row.commit_id),
    stage: str(row.stage),
    message: str(row.message),
    createdAt: str(row.created_at),
    created_at: str(row.created_at),
  }))
}

/**
 * 追加一条同步错误（stage: project_sync | commit_sync | job）。
 * @param {any} db
 * @param {{jobId: string, projectId?: number|null, commitId?: string|null, stage: string,
 *          message: string, createdAt?: string}} row
 */
export function appendSyncJobError(db, row) {
  stmt(
    db,
    `INSERT INTO sync_job_errors(job_id, project_id, commit_id, stage, message, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    str(pick(row, 'jobId', 'job_id')),
    pick(row, 'projectId', 'project_id') === undefined ? null : num(pick(row, 'projectId', 'project_id')),
    (() => {
      const commitId = pick(row, 'commitId', 'commit_id')
      return commitId === undefined || commitId === null || commitId === '' ? null : str(commitId)
    })(),
    str(pick(row, 'stage')) || 'job',
    str(pick(row, 'message')),
    str(pick(row, 'createdAt', 'created_at')) || nowIso(),
  )
  return null
}

/**
 * 列出同步任务（按 started_at DESC；limit 默认 20，上限 200）。
 * @returns {ReturnType<typeof mapSyncJob>[]}
 */
export function listSyncJobs(db, limit) {
  const size = Math.min(Math.max(num(limit) || 20, 1), 200)
  const rows = stmt(db, 'SELECT * FROM sync_jobs ORDER BY started_at DESC, job_id DESC LIMIT ?').all(size)
  return rows.map((row) => mapSyncJob(row, listSyncJobErrors(db, row.job_id)))
}

/**
 * 读当前活动任务（pending|running；多任务时取最新）。不存在 → null。
 * @returns {null | ReturnType<typeof mapSyncJob>}
 */
export function getActiveSyncJob(db) {
  const row = stmt(
    db,
    `SELECT * FROM sync_jobs WHERE status IN ('pending','running')
     ORDER BY started_at DESC, job_id DESC LIMIT 1`,
  ).get()
  if (!row) return null
  return mapSyncJob(row, listSyncJobErrors(db, row.job_id))
}

/** 关闭数据库（幂等；测试清理用）。 */
export function closeDatabase(db) {
  if (!db) return
  try {
    db.close()
  } catch {
    /* 已关闭 */
  }
}
