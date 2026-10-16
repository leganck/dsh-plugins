/**
 * 索引存储：node:sqlite（Node 24 内置）单文件库，含 FTS5 全文表。
 *
 * 表结构设计要点：
 *  - `files`    文件指纹（mtime/size/sha256），决定哪些文件需要重新切块
 *  - `chunks`   块本体（40 行窗口）+ 块内容哈希 —— 哈希是跨版本复用的钥匙
 *  - `chunks_fts` FTS5 倒排表，rowid == chunks.id，直接用 bm25() 排序
 *  - `vectors`  块向量（512 维 float32），与 chunks.id 一一对应
 *  - `meta`     schema 版本 / 模型标签 / 建库时间等
 *
 * bm25() 在 SQLite 中返回负值，**越小越相关**，因此 order by 升序。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

export const SCHEMA_VERSION = 1

/**
 * `node:sqlite` 必须**延迟加载**。
 *
 * 之前写成顶层 `import { DatabaseSync } from 'node:sqlite'`：只要宿主环境里这个内置
 * 模块不可用（某些 Electron 运行时形态、或换了 Node 版本），整条 ESM 导入链就会失败，
 * 插件行会被静默跳过 —— 不注册工具、不留日志、什么都没发生，排查代价极高。
 *
 * 改成首次用到时才 require，并抛出可读的错误：模块能加载、apply() 能跑完、
 * 工具能注册，真正缺能力时由工具调用报出明确原因。
 */
let _DatabaseSync = null
export function sqliteDriver() {
  if (_DatabaseSync) return _DatabaseSync
  try {
    _DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync
  } catch (e) {
    throw new Error(
      `当前运行时没有可用的 node:sqlite（Node >= 22.5 内置，Electron 需其内嵌 Node 版本支持）：${e.message}`,
    )
  }
  if (typeof _DatabaseSync !== 'function') throw new Error('node:sqlite 存在但没有导出 DatabaseSync')
  return _DatabaseSync
}

export class Store {
  static open(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new (sqliteDriver())(dbPath)
    db.exec('pragma journal_mode = wal')
    db.exec('pragma synchronous = normal')
    const s = new Store(db)
    s.dbPath = dbPath
    s.migrate()
    return s
  }

  constructor(db) {
    this.db = db
  }

  migrate() {
    this.db.exec(`
      create table if not exists meta (k text primary key, v text);
      create table if not exists files (
        path text primary key, mtime integer, size integer, sha text, indexed_at integer
      );
      create table if not exists chunks (
        id integer primary key autoincrement, path text, start_line integer, end_line integer,
        hash text, body text
      );
      create index if not exists chunks_path_idx on chunks(path);
      create index if not exists chunks_hash_idx on chunks(hash);
      create table if not exists vectors (chunk_id integer primary key, dim integer, v blob);
      create virtual table if not exists chunks_fts using fts5(path unindexed, body, tokenize='unicode61');
    `)
    this.setMeta('schema_version', String(SCHEMA_VERSION))
  }

  // ---- meta ----
  getMeta(k) {
    return this.db.prepare('select v from meta where k = ?').get(k)?.v
  }

  setMeta(k, v) {
    this.db.prepare('insert or replace into meta(k, v) values (?, ?)').run(k, String(v))
  }

  // ---- 文件指纹 ----
  fileState() {
    const m = new Map()
    for (const r of this.db.prepare('select path, mtime, size, sha from files').all()) {
      m.set(r.path, { mtime: Number(r.mtime), size: Number(r.size), sha: r.sha })
    }
    return m
  }

  upsertFile(relPath, mtime, size, sha) {
    this.db.prepare('insert or replace into files(path, mtime, size, sha, indexed_at) values (?,?,?,?,?)')
      .run(relPath, mtime, size, sha, Date.now())
  }

  dropFile(relPath) {
    const ids = this.db.prepare('select id from chunks where path = ?').all(relPath).map((r) => Number(r.id))
    if (ids.length) {
      const ph = ids.map(() => '?').join(',')
      this.db.prepare(`delete from chunks_fts where rowid in (${ph})`).run(...ids)
      this.db.prepare(`delete from vectors where chunk_id in (${ph})`).run(...ids)
      this.db.prepare(`delete from chunks where id in (${ph})`).run(...ids)
    }
    this.db.prepare('delete from files where path = ?').run(relPath)
    return ids.length
  }

  // ---- 块 ----
  /** 写入一个文件的块；返回新块 {id, hash, body, startLine, endLine}[] */
  replaceChunks(relPath, chunks) {
    this.dropFile(relPath)
    const insChunk = this.db.prepare(
      'insert into chunks(path, start_line, end_line, hash, body) values (?,?,?,?,?)',
    )
    const insFts = this.db.prepare('insert into chunks_fts(rowid, path, body) values (?,?,?)')
    const out = []
    this.db.exec('begin')
    try {
      for (const c of chunks) {
        const r = insChunk.run(relPath, c.startLine, c.endLine, c.hash, c.body)
        const id = Number(r.lastInsertRowid)
        insFts.run(id, relPath, c.body)
        out.push({ id, ...c })
      }
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
    return out
  }

  /** 找出比给定 hash 更需要重建的块（用于跨版本复用判定） */
  chunkHashes(relPath) {
    return new Map(this.db.prepare('select hash, id from chunks where path = ?').all(relPath).map((r) => [r.hash, Number(r.id)]))
  }

  // ---- 向量 ----
  putVectors(pairs) {
    const stmt = this.db.prepare('insert or replace into vectors(chunk_id, dim, v) values (?,?,?)')
    this.db.exec('begin')
    try {
      for (const [id, vec] of pairs) stmt.run(id, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength))
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
  }

  /** 取全部向量（用于暴力 kNN）；返回 {ids, mat(Float32Array 连续), dim} */
  allVectors() {
    const rows = this.db.prepare('select chunk_id, dim, v from vectors').all()
    if (!rows.length) return { ids: [], mat: new Float32Array(0), dim: 0 }
    const dim = Number(rows[0].dim)
    const ids = new Int32Array(rows.length)
    const mat = new Float32Array(rows.length * dim)
    rows.forEach((r, i) => {
      ids[i] = Number(r.chunk_id)
      const src = new Float32Array(r.v.buffer, r.v.byteOffset, r.v.byteLength / 4)
      mat.set(src, i * dim)
    })
    return { ids, mat, dim }
  }

  chunksByIds(ids) {
    if (!ids.length) return []
    const ph = ids.map(() => '?').join(',')
    return this.db.prepare(`select id, path, start_line, end_line, body from chunks where id in (${ph})`).all(...ids)
      .map((r) => ({ id: Number(r.id), path: r.path, startLine: Number(r.start_line), endLine: Number(r.end_line), body: r.body }))
  }

  /** 缺向量的块（供增量补算） */
  chunksWithoutVectors(limit = 100000) {
    return this.db.prepare(
      `select c.id, c.path, c.start_line, c.body from chunks c
       left join vectors v on v.chunk_id = c.id
       where v.chunk_id is null limit ?`,
    ).all(limit).map((r) => ({ id: Number(r.id), path: r.path, startLine: Number(r.start_line), body: r.body }))
  }

  // ---- 检索 ----
  ftsSearch(query, limit) {
    return this.db.prepare(
      `select f.rowid as id, c.path as path, c.start_line as start_line, c.end_line as end_line,
              c.body as body, bm25(chunks_fts) as score
       from chunks_fts f join chunks c on c.id = f.rowid
       where chunks_fts match ? order by score limit ?`,
    ).all(query, limit).map((r) => ({
      id: Number(r.id), path: r.path, startLine: Number(r.start_line), endLine: Number(r.end_line),
      body: r.body, score: r.score,
    }))
  }

  // ---- 统计 ----
  stats() {
    const one = (sql) => Number(Object.values(this.db.prepare(sql).get())[0])
    return {
      files: one('select count(*) from files'),
      chunks: one('select count(*) from chunks'),
      vectors: one('select count(*) from vectors'),
      dbBytes: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0,
    }
  }
}
