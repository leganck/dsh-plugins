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
import { chunkFile, bodyForEmbedding } from './chunker.js'
import { sha256 } from './hash.js'
import { walkRepo, diffFiles, readForIndex, DEFAULT_INCLUDE, DEFAULT_EXCLUDE_DIRS, DEFAULT_MAX_FILE_BYTES } from './scan.js'
import { resolveChunkConfig } from './strategies.js'
import { getParser } from './chunk-ast.js'

/**
 * 本仓库**实际会用到、且确实加载成功**的 AST 语法（用于切块指纹）。
 *
 * 按扩展名去重：一个仓库几千个文件，扩展名通常只有几十种。
 * 加载不到的语法**不计入** —— 那种情况下该文件仍旧走 heuristic，指纹应保持原样，
 * 不要因为"这台机器缺依赖"就把命名空间换掉。
 */
function usedAstGrammars(scanned, chunking, depsDir, depsFallbackDirs) {
  const needed = new Set()
  const seen = new Set()
  for (const f of scanned) {
    const ext = path.extname(f.rel).toLowerCase()
    if (seen.has(ext)) continue
    seen.add(ext)
    const cfg = resolveChunkConfig(f.rel, chunking)
    if (cfg.strategy === 'ast' && cfg.grammar) needed.add(cfg.grammar)
  }
  const ok = []
  for (const grammar of [...needed].sort()) {
    if (getParser({ depsDir, depsFallbackDirs, grammar }).ok) ok.push(grammar)
  }
  return ok
}

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
 * @param {object} [p.chunking] - 切块策略配置（见 lib/strategies.js）
 * @param {string} [p.depsDir] - 按需安装的依赖目录（parser 依赖从这里解析）
 * @param {string[]} [p.depsFallbackDirs]
 */
export async function buildIndex({
  store,
  repoRoot,
  opts = {},
  embedder = null,
  budget = {},
  chunking = {},
  depsDir,
  depsFallbackDirs = [],
  /**
   * 远端索引（`vectorStore: 'remote'` 时传入）：
   *   { client, repoId, url, tag, uploadBatch? }
   * 传了就**不做本地嵌入**，改为把块清单/正文推给服务端、由服务端算向量。
   */
  remote = null,
  onProgress = null,
}) {
  const t0 = Date.now()
  const requestedMode = budget.mode ?? 'incremental'
  // 默认 0：**不自动补算向量**。建库只做 FTS5（秒级）；要向量必须显式给 max_embed。
  // 理由（2026-10-16 实测）：默认 20000 意味着任何人建任何新仓库的索引都会自动跑一次
  // 可能数十分钟的重负载，且事前不打招呼；用显示 GPU 跑推理时整机会卡。
  // 重活要先说出来、由调用方决定，不能默认替人做。
  const maxEmbed = budget.maxEmbedPerRun ?? 0

  /**
   * 切块策略指纹 → 不一致就必须**全量重建**。
   *
   * 不这么做的后果：换策略（例如默认从固定窗口切到 AST）后跑增量，
   * 只有**变动过的文件**会被重新切块，于是库里同时存在"旧的窗口块"和"新的 AST 块"——
   * 检索结果里两种粒度的块混在一起，而且**没有任何信号提示这件事发生了**。
   *
   * **"库里没有指纹记录"也必须算不一致**：在指纹机制引入之前建的索引就是这个状态，
   * 它们的切块策略未知。早期写成 `Boolean(prev) && prev !== fp`，于是这类库被判成
   * "没变化"→ 只重切少数变动文件 → 直接落进上面那个混合状态。
   * 这是实测踩到的：对三个既有索引做迁移重建时，最大的那个只重切了 14 个文件。
   */
  // 扫描先做：切块能力要从"这个仓库有哪些扩展名"推，而不是从"这台机器装了什么"推。
  // 否则给一个 Go 仓库装 tree-sitter 也会改指纹 → 换命名空间 → 白白重嵌全部向量。
  const scanned = walkRepo(repoRoot, opts)
  const astCapability = usedAstGrammars(scanned, chunking ?? {}, depsDir, depsFallbackDirs)
  /**
   * 切块指纹 = 配置 **+ 本仓库实际会用到的可用语法**。
   *
   * 为什么要带上语法：装了 tree-sitter 之后同一个文件会切出**不同的块边界**；只哈希配置
   * （`strategy:'auto'`）的话，装依赖前后指纹不变 → 库里以及服务端同一个命名空间里混进
   * 两种粒度的块（旧 heuristic + 新 ast），而且没有任何信号。这正是上面那段注释在防的事，
   * 只是原先漏了"能力"这一维。
   *
   * 为什么不是"全部可用语法"：Go 项目用不到 AST，装个依赖就把命名空间换掉是纯浪费。
   * 所以只写"本仓库有对应扩展名、且该语法确实加载成功"的那些；用不到时为 undefined，
   * JSON.stringify 会丢掉字段 → 与旧指纹完全一致，老索引不受影响。
   */
  const fingerprint = sha256(
    JSON.stringify({ ...chunking, ast: astCapability.length ? astCapability : undefined }),
  )
  const prevFingerprint = store.getMeta('chunk_fingerprint')
  const hasIndexedFiles = store.stats().files > 0
  const strategyChanged = hasIndexedFiles && prevFingerprint !== fingerprint

  /**
   * **嵌入模型一致性**：库里已有向量、但那些向量不是当前模型产出的 → 必须全量重建。
   *
   * 为什么单独管这一条（与切块指纹同理，但更隐蔽）：
   * `vectors(chunk_id, dim, v)` 里**没有模型标识**，而查询时的 kNN 直接做点积
   * （`search.js`：`mat[base+d] * qv[d]`，既不查维度也不查模型）。于是换模型后：
   *   - 维度不同 → 越界读到 undefined → 分数变 NaN
   *   - 维度相同（如 fp16 ↔ int8）→ **完全静默**：分数看着正常、排名却是垃圾
   * 若再叠加增量建库（只重嵌变动文件），库里会变成"旧模型向量 + 新模型向量"混装。
   * 所以只要 tag 不一致且库里已有向量，就清库重建。
   */
  const embeddingTag = embedder?.ok ? embedder.modelTag : null
  const prevEmbeddingTag = store.getMeta('embedding_tag')
  const embedChanged = Boolean(embeddingTag) && store.stats().vectors > 0 && prevEmbeddingTag !== embeddingTag

  const mode = strategyChanged || embedChanged ? 'full' : requestedMode

  if (mode === 'full') {
    store.db.exec('delete from chunks; delete from chunks_fts; delete from vectors; delete from files;')
  }
  store.setMeta('chunk_fingerprint', fingerprint)
  // 记录产出这批向量的模型；没有可用嵌入器时**不写**（写 null 会让下次误判成"换过模型"）
  if (embeddingTag) store.setMeta('embedding_tag', embeddingTag)

  const known = store.fileState()
  const { changed, removed } = diffFiles(scanned, known)

  let chunksWritten = 0
  const fileErrors = []
  /** 实际用到的策略 → 文件数（如实报告，方便发现"以为在用 AST 其实在降级"） */
  const strategyFiles = new Map()
  const fallbackReasons = []
  /** 远端模式下要推给服务端的变更文件清单（只含变更文件，不是整库） */
  const remoteChanged = []
  for (const f of changed) {
    try {
      const { text, sha } = readForIndex(f.abs)
      const r = chunkFile({ relPath: f.rel, text, chunking, depsDir, depsFallbackDirs })
      store.replaceChunks(f.rel, r.chunks)
      store.upsertFile(f.rel, f.mtime, f.size, sha)
      chunksWritten += r.chunks.length
      if (remote) {
        remoteChanged.push({
          path: f.rel,
          hash: sha,
          chunks: r.chunks.map((c) => ({ hash: c.hash, start: c.startLine, end: c.endLine })),
        })
      }
      strategyFiles.set(r.strategy, (strategyFiles.get(r.strategy) ?? 0) + 1)
      if (r.fellBack && r.reason && fallbackReasons.length < 5 && !fallbackReasons.includes(r.reason)) {
        fallbackReasons.push(r.reason)
      }
    } catch (e) {
      fileErrors.push(`${f.rel}: ${String(e.message).slice(0, 80)}`)
    }
  }
  for (const rel of removed) store.dropFile(rel)

  // ---- 远端索引：推清单 → 只传缺失正文 → 服务端后台嵌入 ----
  let remoteInfo = null
  if (remote) {
    remoteInfo = await syncRemote({
      store,
      client: remote.client,
      repoId: remote.repoId,
      url: remote.url,
      tag: remote.tag,
      lineage: remote.lineage ?? null,
      noEmbed: !!remote.noEmbed,
      rateLimit: remote.rateLimit ?? null,
      fingerprint,
      changedFiles: remoteChanged,
      removed,
      uploadBatch: remote.uploadBatch ?? 256,
      log: onProgress ?? (() => {}),
    })
  }

  // ---- 向量补算（只算缺的）----
  let embedded = 0
  let embedNote = ''
  const stats0 = store.stats()
  // 待补总量用 stats 差分算出（O(1)），不复用 chunksWithoutVectors —— 后者要按 limit 取行
  const pendingTotal = Math.max(0, stats0.chunks - stats0.vectors)
  if (remote) {
    const r = remoteInfo ?? {}
    embedNote = r.unchanged
      ? `远端索引已是最新（revision ${r.revision}）：清单指纹一致，未上传任何正文`
      : `已同步到远端（revision ${r.revision}）：缺向量 ${r.missing} 块，本轮上传正文 ${r.uploaded} 条；` +
        `服务端后台嵌入中，覆盖率 ${((r.coverage ?? 0) * 100).toFixed(0)}%（再跑 code_index 可查看进度）`
  } else if (!embedder?.ok) {
    embedNote = `向量未生成：${embedder?.reason ?? 'embedder 未配置'}`
  } else if (maxEmbed <= 0) {
    // 预算为 0 时此前会说"向量已是最新"，把"压根没尝试"说成"已经完整" —— 如实报告，
    // 并给出可执行的下一步（默认值就是 0，所以要显式传参，不能只说"再跑一次"）
    embedNote = `本轮向量补算预算为 0（默认不补算），未做补算；仍有 ${pendingTotal} 块待补（要补算请显式传 max_embed=<正整数>）`
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
    /** 远端索引同步结果（vectorStore='remote' 时有值） */
    remote: remoteInfo,
    /** 实际使用的切块策略 → 文件数；以及降级原因（最多 5 条去重） */
    strategies: Object.fromEntries(strategyFiles),
    chunkFallbacks: fallbackReasons,
    /** 是否因为切块策略变化而强制全量重建（调用方应当如实告知用户） */
    strategyChanged,
    /** 是否因为**嵌入模型变化**而强制全量重建；以及本库向量由哪个模型产出 */
    embedChanged,
    embeddingTag: embeddingTag ?? prevEmbeddingTag ?? null,
    fileErrors: fileErrors.slice(0, 10),
    elapsedMs: Date.now() - t0,
    stats: s,
  }
}

/** 清理索引目录（供 code_index action=drop 使用） */
export function dropIndex(store) {
  store.db.exec('delete from chunks; delete from chunks_fts; delete from vectors; delete from files;')
}

// ---------------------------------------------------------------------------
// 远端索引同步（vectorStore: 'remote'）
//
// 与 Cursor 的差别：它用 Merkle 树省"整棵树上云"的流量；我们本来就只发变更，
// 所以用**一个仓库指纹 + 变更清单**就够了（实测全量核对 703 ms/2088 文件，
// 未变更时 2 ms；建 Merkle 树 117 ms/4 万文件，收益换不来协议复杂度）。
//
// 流程：指纹一致 → 只发 {repoState, revision}（1 个 RTT、0 字节正文）
//       指纹不一致 → 发变更文件的块清单 → 服务端回"我缺哪些 hash" → 只传这些正文
//       revision 冲突 → 改发全量清单（客户端丢了本地状态时的自愈路径）
// ---------------------------------------------------------------------------

/** 仓库指纹：排序后的 "path\0sha" 汇总。任何文件增删改都会改变它。 */
export function computeRepoState(store) {
  const rows = [...store.fileState().entries()]
    .map(([p, v]) => `${p}\u0000${v.sha ?? ''}`)
    .sort()
  return sha256(rows.join('\n'))
}

/**
 * @param {object} o
 * @param {import('./store.js').Store} o.store
 * @param {object} o.client createRemoteIndex() 的返回值
 */
export async function syncRemote({ store, client, repoId, url, tag, lineage = null, noEmbed = false, rateLimit = null, fingerprint, changedFiles, removed, uploadBatch = 256, log = () => {} }) {
  const namespace = `${repoId}@${fingerprint}`
  const state = computeRepoState(store)
  const lastState = store.getMeta('remote_repo_state')
  const lastRev = store.getMeta('remote_revision')
  const base = {
    repoId,
    chunkFp: fingerprint,
    url,
    tag,
    repoState: state,
    lineage: lineage ?? undefined,
    noEmbed,
    // 指纹必须**连块数一起**交给服务端：只有指纹一致、块数也一致，才算"内容确实一样"。
    // 否则"本地早已建好、本轮 0 变更"的空清单会让服务端记下指纹却没有内容（实测踩过）。
    chunkCount: store.stats().chunks,
  }

  let res
  const firstContact = lastRev === undefined || lastRev === null
  const skipManifest = lastState === state && !firstContact
  if (skipManifest) {
    // 指纹一致：只发指纹 + revision，服务端直接回 unchanged（连清单都不用比对）
    res = await client.sync(namespace, { ...base, mode: 'diff', revision: Number(lastRev) })
  } else if (firstContact) {
    // **首次连这台服务端：状态未知**，必须发全量清单。
    // 否则"本地索引早就建好、本轮 0 变更"会发一份空清单，服务端据此认为库里没有块，
    // 于是 missing=0 —— 表现是"同步成功但一个向量都没算"（ES 16 万块那次就是这么踩到的）。
    res = await client.sync(namespace, { ...base, mode: 'full', upsert: store.manifest(), remove: [] })
  } else {
    try {
      res = await client.sync(namespace, { ...base, mode: 'diff', revision: Number(lastRev), upsert: changedFiles, remove: removed })
    } catch (e) {
      if (e.code !== 'revision-conflict') throw e
      // 服务端的 revision 与本地记录不一致（多客户端/服务端重置）→ 全量自愈
      log(`远端 revision 冲突（服务端 ${e.revision}），改走全量清单`)
      res = await client.sync(namespace, { ...base, mode: 'full', upsert: store.manifest(), remove: [] })
    }
  }
  // 自愈：服务端报告 0 块但本地确有块 → 它被重置过，补一次全量。
  // 注意**必须也覆盖 unchanged 分支**：本地 meta 记着"已同步"，服务端却空了，短路会一直骗自己。
  if ((res.chunks ?? 0) === 0 && store.stats().chunks > 0) {
    log('服务端报告 0 块但本地有索引 → 补发全量清单')
    res = await client.sync(namespace, { ...base, mode: 'full', upsert: store.manifest(), remove: [] })
  }

  // 只上传服务端缺向量的那些块的正文（幂等：已存在的会被服务端计入 deduped）
  const missing = res.missing ?? []
  let uploaded = 0
  for (let i = 0; i < missing.length; i += uploadBatch) {
    const part = missing.slice(i, i + uploadBatch)
    const bodies = store.bodiesByHashes(part)
    const payload = [...bodies.entries()].map(([hash, body]) => ({ hash, body }))
    if (payload.length) {
      const r = await client.uploadChunks(namespace, payload)
      uploaded += r.accepted ?? 0
    }
  }
  if (missing.length && !noEmbed) await client.kickEmbed(namespace, rateLimit ? { rate: rateLimit } : {})

  store.setMeta('remote_repo_state', state)
  store.setMeta('remote_revision', String(res.revision))
  store.setMeta('remote_namespace', namespace)

  return {
    namespace,
    revision: res.revision,
    unchanged: !!res.unchanged,
    missing: missing.length,
    /** 缺向量的块 hash 列表（seed 工具要按它算/灌向量） */
    missingHashes: missing,
    uploaded,
    coverage: res.coverage ?? null,
    chunks: res.chunks ?? null,
    vectors: res.vectors ?? null,
  }
}
