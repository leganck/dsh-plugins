/**
 * 建库 / 增量刷新编排。
 *
 * 流程（每一段都有实测依据）：
 *   1. 扫描仓库（全量遍历 120 ms / 2088 文件）
 *   2. 与库中指纹比对 → 只处理变化文件（未变时整轮 2 ms 量级）
 *   3. 变化文件：读 → 40 行切块 → 写 chunks + FTS5
 *   4. 删除文件：清理 chunks/FTS5/vectors
 *   5. 补向量：只对"缺向量"的块调用嵌入器（受 budget.maxEmbedPerRun 限制，可断点续跑）
 *
 * 为什么不用 Merkle 树：本机实测遍历只要 120 ms，Merkle 的价值（十万级文件 + 跨网）
 * 在这里不存在；两级指纹（mtime+size → sha256）已经足够且更简单。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { chunkText, bodyForEmbedding } from './chunker.js'
import { walkRepo, diffFiles, readForIndex, DEFAULT_INCLUDE, DEFAULT_EXCLUDE_DIRS, DEFAULT_MAX_FILE_BYTES } from './scan.js'

/**
 * 索引库路径。
 *
 *  - 配了 `indexDirBase`：`<base>/<仓库名>-<路径哈希前8位>/index.db`
 *    —— **每个仓库一个库**，且不落在代码仓库里（不会污染 git status）。
 *  - 只配了 `indexDir`：直接用该目录下的 index.db（多个仓库会共用一个库，仅适合单仓库场景）
 *  - 都没配：`<repo>/.dsh-index/index.db`
 */
export function indexDbPath(repoRoot, { indexDir, indexDirBase } = {}) {
  if (indexDirBase) {
    const slug = `${path.basename(repoRoot).replace(/[^\w.-]+/g, '_')}-${crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)}`
    return path.join(indexDirBase, slug, 'index.db')
  }
  return path.join(indexDir ?? path.join(repoRoot, '.dsh-index'), 'index.db')
}

/** 只扫描比对，不写入。用于 code_index_status 判断新鲜度 */
export function scanStatus(store, repoRoot, opts = {}) {
  const scanned = walkRepo(repoRoot, opts)
  const known = store.fileState()
  const { changed, unchanged, removed } = diffFiles(scanned, known)
  return { scanned: scanned.length, changed: changed.length, unchanged: unchanged.length, removed: removed.length, stale: changed.length + removed.length > 0 }
}

/**
 * 建库或增量刷新。
 * @param {object} p
 * @param {import('./store.js').Store} p.store
 * @param {string} p.repoRoot
 * @param {object} [p.opts] - 扫描选项（include/excludeDirs/maxFileBytes）
 * @param {object|null} [p.embedder] - createEmbedder() 的结果；null/不可用时跳过向量
 * @param {{maxEmbedPerRun?: number, mode?: 'incremental'|'full'}} [p.budget]
 */
export async function buildIndex({ store, repoRoot, opts = {}, embedder = null, budget = {} }) {
  const t0 = Date.now()
  const mode = budget.mode ?? 'incremental'
  const maxEmbed = budget.maxEmbedPerRun ?? 20000

  if (mode === 'full') {
    store.db.exec('delete from chunks; delete from chunks_fts; delete from vectors; delete from files;')
  }

  const scanned = walkRepo(repoRoot, opts)
  const known = store.fileState()
  const { changed, removed } = diffFiles(scanned, known)

  let chunksWritten = 0
  const fileErrors = []
  for (const f of changed) {
    try {
      const { text, sha } = readForIndex(f.abs)
      const chunks = chunkText(text, { windowLines: opts.windowLines })
      store.replaceChunks(f.rel, chunks)
      store.upsertFile(f.rel, f.mtime, f.size, sha)
      chunksWritten += chunks.length
    } catch (e) {
      fileErrors.push(`${f.rel}: ${String(e.message).slice(0, 80)}`)
    }
  }
  for (const rel of removed) store.dropFile(rel)

  // ---- 向量补算（只算缺的）----
  let embedded = 0
  let embedNote = ''
  const stats0 = store.stats()
  // 待补总量用 stats 差分算出（O(1)），不复用 chunksWithoutVectors —— 后者要按 limit 取行
  const pendingTotal = Math.max(0, stats0.chunks - stats0.vectors)
  if (!embedder?.ok) {
    embedNote = `向量未生成：${embedder?.reason ?? 'embedder 未配置'}`
  } else if (maxEmbed <= 0) {
    // 预算为 0 时此前会说"向量已是最新"，把"压根没尝试"说成"已经完整" —— 如实报告
    embedNote = `本轮向量补算预算为 0（max_embed=0），未做补算；仍有 ${pendingTotal} 块待补（不传 max_embed 即可按默认上限补算）`
  } else {
    const pending = store.chunksWithoutVectors(maxEmbed)
    if (pending.length) {
      const tEmbed = Date.now()
      // 按批推进，避免一次吃满内存；每批落库，可断点续跑
      const BATCH = 256
      for (let i = 0; i < pending.length; i += BATCH) {
        const slice = pending.slice(i, i + BATCH)
        try {
          const vecs = await embedder.embed(slice.map((c) => bodyForEmbedding(c.body)))
          store.putVectors(slice.map((c, n) => [c.id, vecs[n]]))
          embedded += slice.length
        } catch (e) {
          embedNote = `向量补算中断于第 ${i} 块：${String(e.message).slice(0, 120)}（已落库的部分保留，可重跑续算）`
          break
        }
      }
      if (!embedNote) {
        embedNote = `本轮补算 ${embedded} 块，用时 ${((Date.now() - tEmbed) / 1000).toFixed(1)}s`
        if (embedded < pendingTotal) embedNote += `；仍有 ${pendingTotal - embedded} 块待补（再跑一次即可续算）`
      }
    } else {
      embedNote = '向量已是最新，无需补算'
    }
  }

  const s = store.stats()
  store.setMeta('repo_root', repoRoot)
  store.setMeta('last_build_at', String(Date.now()))
  store.setMeta('last_build_ms', String(Date.now() - t0))

  return {
    mode,
    repoRoot,
    scanned: scanned.length,
    changed: changed.length,
    removed: removed.length,
    chunksWritten,
    embedded,
    vectorsBefore: stats0.vectors,
    vectorsAfter: s.vectors,
    cacheEntries: embedder?.cache ? embedder.cache.count() : null,
    embedNote,
    fileErrors: fileErrors.slice(0, 10),
    elapsedMs: Date.now() - t0,
    stats: s,
  }
}

/** 清理索引目录（供 code_index action=drop 使用） */
export function dropIndex(store) {
  store.db.exec('delete from chunks; delete from chunks_fts; delete from vectors; delete from files;')
}
