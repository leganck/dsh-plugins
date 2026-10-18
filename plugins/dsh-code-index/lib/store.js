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

/**
 * 从块正文里抽一个"签名"用来在目录地图里指路：
 * 优先 `func/fn/function/class/interface/def/type/struct` 后面的名字，
 * 抽不到就退回第一行有内容的代码（注释与空行跳过）。
 */
function signatureOf(body) {
  const lines = String(body ?? '').split('\n')
  const pat = /(?:^|\s)(?:func\s+(?:\([^)]*\)\s*)?|fn\s+|function\s+|class\s+|interface\s+|def\s+|type\s+|struct\s+)([A-Za-z_$][\w$]*)/ 
  for (const line of lines.slice(0, 40)) {
    const m = line.match(pat)
    if (m) return m[1]
  }
  for (const line of lines) {
    const s = line.trim()
    // package xxx 这类行信息量太低，指路时不如再往下找一行
    if (s && !s.startsWith('//') && !s.startsWith('#') && !s.startsWith('*') && !s.startsWith('/*') && !s.startsWith('package ') && !s.startsWith('import ') && !s.startsWith('#include') && !s.startsWith('using ')) return s.slice(0, 48)
  }
  return ''
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
              c.hash as hash, c.body as body, bm25(chunks_fts) as score
       from chunks_fts f join chunks c on c.id = f.rowid
       where chunks_fts match ? order by score limit ?`,
    ).all(query, limit).map((r) => ({
      id: Number(r.id), path: r.path, startLine: Number(r.start_line), endLine: Number(r.end_line),
      hash: r.hash, body: r.body, score: r.score,
    }))
  }

  /** 按内容哈希取块（远端命中只回 hash + 坐标，正文以本地为准） */
  chunksByHashes(hashes) {
    if (!hashes.length) return new Map()
    const out = new Map()
    for (let i = 0; i < hashes.length; i += 400) {
      const part = hashes.slice(i, i + 400)
      const ph = part.map(() => '?').join(',')
      for (const r of this.db.prepare(
        `select id, path, start_line, end_line, hash, body from chunks where hash in (${ph})`,
      ).all(...part)) {
        out.set(r.hash, {
          id: Number(r.id), path: r.path, startLine: Number(r.start_line), endLine: Number(r.end_line),
          hash: r.hash, body: r.body,
        })
      }
    }
    return out
  }

  /** 整份清单（供远端全量同步用）：按文件分组，(path, sha, [{hash,start,end}]) */
  manifest() {
    const files = this.db.prepare('select path, sha from files').all()
    const byPath = new Map(files.map((f) => [f.path, { path: f.path, hash: f.sha, chunks: [] }]))
    for (const r of this.db.prepare('select path, start_line, end_line, hash from chunks order by path, start_line').all()) {
      const f = byPath.get(r.path)
      if (f) f.chunks.push({ hash: r.hash, start: Number(r.start_line), end: Number(r.end_line) })
    }
    return [...byPath.values()]
  }

  /** 正文（按 hash）——远端要嵌的块只在本地有一份正文 */
  bodiesByHashes(hashes) {
    if (!hashes.length) return new Map()
    const out = new Map()
    for (let i = 0; i < hashes.length; i += 400) {
      const part = hashes.slice(i, i + 400)
      const ph = part.map(() => '?').join(',')
      for (const r of this.db.prepare(`select hash, body from chunks where hash in (${ph})`).all(...part)) {
        out.set(r.hash, r.body)
      }
    }
    return out
  }

  // ---- 统计 ----
  /**
   * 目录地图：回答"这个仓库大概是怎么组织的、该去哪个目录找"。
   *
   * 对应 Cursor 的 `GetHighLevelFolderDescription`。它那边用模型生成目录摘要；
   * 这里**纯结构化推导**（文件数 + 语言构成 + 块数 + 代表符号），不花推理成本、也不会编造。
   * 一次全扫（files + chunks 聚合），16 万块实测百毫秒级，属于"冷启动用一次"的量级。
   */
  dirMap({ depth = 2, dirs = 24, perDir = 2 } = {}) {
    const files = this.db.prepare('select path from files').all()
    const perPath = new Map(
      this.db.prepare('select path, count(*) as n from chunks group by path').all().map((r) => [r.path, Number(r.n)]),
    )
    const agg = new Map()
    for (const { path: p } of files) {
      const parts = p.split('/')
      const dir = parts.length > depth ? `${parts.slice(0, depth).join('/')}/` : parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : './'
      let a = agg.get(dir)
      if (!a) {
        a = { dir, files: 0, exts: new Map(), chunks: 0, top: [] }
        agg.set(dir, a)
      }
      a.files++
      const dot = p.lastIndexOf('.')
      const ext = dot > p.lastIndexOf('/') ? p.slice(dot) : '(无扩展名)'
      a.exts.set(ext, (a.exts.get(ext) ?? 0) + 1)
      const n = perPath.get(p) ?? 0
      a.chunks += n
      if (n > 0) a.top.push({ path: p, chunks: n })
    }
    const out = [...agg.values()]
      .sort((a, b) => b.chunks - a.chunks || b.files - a.files)
      .slice(0, dirs)
      .map((a) => ({ dir: a.dir, files: a.files, chunks: a.chunks, exts: [...a.exts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3), top: a.top.sort((x, y) => y.chunks - x.chunks).slice(0, perDir) }))

    // 代表符号：每个目录取 top 文件的第一块，抽出函数/类/接口名（抽不到就退回第一行有效代码）
    const wanted = out.flatMap((d) => d.top.map((t) => t.path))
    if (wanted.length) {
      const ph = wanted.map(() => '?').join(',')
      const rows = this.db.prepare(`select path, body from chunks where path in (${ph}) order by path, start_line`).all(...wanted)
      const first = new Map()
      for (const r of rows) if (!first.has(r.path)) first.set(r.path, r.body)
      for (const d of out) {
        for (const t of d.top) {
          t.symbol = signatureOf(first.get(t.path) ?? '')
        }
      }
    }
    return out
  }

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
