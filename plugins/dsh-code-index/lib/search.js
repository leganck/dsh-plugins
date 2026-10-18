/**
 * 混合检索：FTS5(BM25) + 向量(kNN) → RRF 融合。
 *
 * 口径来自本机实测（40 个真实检索事件、14 个仓库）：
 *   grep 循环（4KB 预算）10% → 纯 FTS5 32.5% → 纯向量 37.5% → **混合 55%（@10）**
 * 融合参数调参结果：RRF k=20 在 @5/@10 最好（40% / 52%），比默认 k=60 好；
 * 但 @1 精度反而纯通道更好（向量 18% > FTS5 15% > RRF 5%），
 * 所以这里**默认返回 top-10 而不是 top-1**，并把两路各自的排名一并返回，便于排查。
 */
import { extractTerms, buildMatch, snippet } from './query.js'

const RRF_K = 20
const FTS_CANDIDATES = 40
const VEC_CANDIDATES = 40

/** 向量矩阵缓存：避免每次查询都从 SQLite 读几十 MB（键含条数，索引一变自动失效） */
const matrixCache = new Map()

function loadMatrix(store) {
  const count = store.stats().vectors
  const key = `${store.dbPath}:${count}`
  let hit = matrixCache.get(key)
  if (!hit) {
    hit = store.allVectors()
    matrixCache.clear() // 只保留当前索引的矩阵
    matrixCache.set(key, hit)
  }
  return hit
}

/**
 * 「当前文件锚定」的后处理：排除正在编辑的文件自身 + 同目录候选加权。
 *
 * 对应 Cursor 请求里的 `CurrentFileInfo{contents, sha256, top_chunks}`。它那边由服务端
 * 在重排时考虑"用户眼前是什么"；我们这里做两件能直接验证的事：
 *   ① 排除当前文件 —— 问"哪儿实现了 X"时，答案不该是用户正在看的那个文件；
 *   ② 同目录加权 —— 相关实现通常落在同一个 package 下（实测 energy 里 window/ 的窗口逻辑
 *      彼此相邻），加一点点权重即可把邻居顶上来，不至于压过明显更相关的命中。
 */
function curate(entries, pathOf, { excludePaths = [], boostPrefix = null, boostWeight = 0.004 } = {}) {
  let out = entries
  if (excludePaths?.length) {
    const ex = new Set(excludePaths)
    out = out.filter((e) => !ex.has(pathOf(e)))
  }
  let neighbors = 0
  if (boostPrefix) {
    for (const e of out) {
      const p = pathOf(e)
      if (p && p.startsWith(boostPrefix)) {
        e.score += boostWeight
        e.neighbor = true
        neighbors++
      }
    }
    out.sort((a, b) => b.score - a.score)
  }
  return { entries: out, neighbors }
}

/**
 * 执行一次混合检索。
 *
 * `reranker` / `rerankCandidates` 是**可选的重排**（默认不传 = 不重排）：
 * 传入后，在 RRF 融合结果上取 `rerankCandidates` 个候选交给交叉编码器打分，再截到 topK。
 * 实测（103 题、bge-small + bge-reranker-base fp16/DML）hit@3 **42.7% → 59.2%**，
 * 代价是每查询 +939 ms（快档 top-10 约 +474 ms）。重排失败时**退回原顺序**，不让搜索失败。
 * @returns {{mode: string, note: string, results: Array<object>, rerank?: object}}
 */
export async function search(
  store,
  embedder,
  question,
  {
    topK = 10,
    mode = 'auto',
    reranker = null,
    rerankCandidates = 0,
    embedText = null,
    excludePaths = [],
    boostPrefix = null,
    boostWeight = 0.004,
  } = {},
) {
  const terms = extractTerms(question)
  const match = buildMatch(terms)

  let fts = []
  if (match) {
    try {
      fts = store.ftsSearch(match, FTS_CANDIDATES)
    } catch {
      // FTS5 语法错误（极端词项）时退回单关键词逐个试
      for (const t of terms.slice(0, 3)) {
        try {
          const m = buildMatch([t])
          if (m) {
            fts = store.ftsSearch(m, FTS_CANDIDATES)
            if (fts.length) break
          }
        } catch {
          /* 忽略单个词项的语法错误 */
        }
      }
    }
  }

  let vec = []
  let vecNote = ''
  const { vectors } = store.stats()
  const wantVector = mode === 'vector' || (mode === 'auto' && embedder?.ok && vectors > 0)
  if (wantVector) {
    // ---- 一致性闸门 ①：索引里的向量必须与当前模型**同源** ----
    // 没有这道闸门时，换模型后会拿新模型的查询向量去和旧模型的存量向量做点积：
    // 维度不同 → NaN；维度相同（fp16↔int8）→ **完全静默的垃圾排名**。
    const storedTag = store.getMeta('embedding_tag')
    if (!embedder?.ok) {
      // auto 模式：没有嵌入能力是**默认形态**（没装依赖 / 没模型）→ 静默走关键词，不报警；
      // 但用户**显式要求** vector 时必须说明做不到的原因（诊断信息不能丢）。
      vecNote = mode === 'vector' ? `向量通道未启用：${embedder?.reason ?? '嵌入器不可用'}` : ''
    } else if (vectors === 0) {
      vecNote = '向量通道未启用：索引里还没有向量（code_index 建库时未嵌入）'
    } else if (storedTag !== embedder.modelTag) {
      vecNote = storedTag
        ? `向量通道未启用：索引里的向量由「${storedTag}」产出，与当前模型「${embedder.modelTag}」不一致 —— 跑 code_index 会自动全量重嵌`
        : '向量通道未启用：索引没有记录产出向量的模型（旧版本建的库）—— 跑 code_index 重建即可启用'
    } else {
      try {
        const [qv] = await embedder.embed([embedText ?? question], { isQuery: true })
        const { ids, mat, dim } = loadMatrix(store)
        // ---- 一致性闸门 ②：维度兜底（即使 tag 相同，配置漂移也可能造成维度不一致）----
        if (qv.length !== dim) {
          vecNote = `向量通道未启用：查询向量维度 ${qv.length} 与索引里的 ${dim} 不一致 —— 跑 code_index 重建`
        } else {
          const n = ids.length
          const scored = new Float32Array(n)
          for (let i = 0; i < n; i++) {
            let s = 0
            const base = i * dim
            for (let d = 0; d < dim; d++) s += mat[base + d] * qv[d]
            scored[i] = s
          }
          const order = Array.from({ length: n }, (_, i) => i)
            .sort((a, b) => scored[b] - scored[a])
            .slice(0, VEC_CANDIDATES)
          const chunkIds = order.map((i) => ids[i])
          const meta = new Map(store.chunksByIds(chunkIds).map((c) => [c.id, c]))
          vec = chunkIds.map((id, i) => ({ ...meta.get(id), score: scored[order[i]] })).filter((r) => r.path)
        }
      } catch (e) {
        vecNote = `向量检索失败：${String(e.message).slice(0, 120)}`
      }
    }
  } else if (mode !== 'vector') {
    // 如实反映"为什么没走向量"。此前这里硬编码成「配置 embedding.backend = off」，
    // 而这条分支其实覆盖三种不同状态——实测曾把「索引里 0 向量」误报成配置问题，
    // 把人引去改一个本来就是 auto 的配置。原因必须由状态推导，不能预设。
    if (!embedder?.ok) {
      // 没有嵌入能力是**默认形态**（没装依赖/没模型）：静默走关键词，不解释也不报警
      vecNote = ''
    } else if (vectors === 0) {
      vecNote = '向量通道未启用：索引里还没有向量（建库默认不补算）——跑 code_index 并传 max_embed=<正整数> 可补算'
    } else {
      vecNote = `向量通道未启用：当前 mode=${mode}`
    }
  }

  // RRF 融合
  const acc = new Map()
  const note = (id, channel, rank) => {
    let e = acc.get(id)
    if (!e) {
      e = { id, score: 0, fts: null, vec: null }
      acc.set(id, e)
    }
    e[channel] = rank
    e.score += 1 / (RRF_K + rank)
  }
  fts.forEach((r, i) => note(r.id, 'fts', i + 1))
  vec.forEach((r, i) => note(r.id, 'vec', i + 1))

  let ranked = [...acc.values()]
  if (mode === 'fts') ranked = ranked.filter((e) => e.fts !== null)
  else if (mode === 'vector') ranked = ranked.filter((e) => e.vec !== null)
  ranked.sort((a, b) => b.score - a.score)

  // 当前文件锚定（排除自身 + 同目录加权）：只在调用方给了 current_file 时生效
  let neighborCount = 0
  if (excludePaths.length || boostPrefix) {
    const pathById = new Map(store.chunksByIds(ranked.map((e) => e.id)).map((c) => [c.id, c.path]))
    const cur = curate(ranked, (e) => pathById.get(e.id), { excludePaths, boostPrefix, boostWeight })
    ranked = cur.entries
    neighborCount = cur.neighbors
  }

  // ---- 可选重排：在融合结果上取候选池 → 交叉编码器打分 → 重排序 ----
  // 候选池要比 topK 大才有意义（重排只能在池内重排）；池子里没有的东西谁也救不回来。
  const pool = Math.max(topK, rerankCandidates || 0)
  const poolEntries = ranked.slice(0, pool)
  const meta0 = new Map(store.chunksByIds(poolEntries.map((e) => e.id)).map((c) => [c.id, c]))
  let rerankInfo = null
  let rerankScores = null
  if (reranker?.ok && rerankCandidates > 0 && poolEntries.length > 1) {
    const t0 = Date.now()
    try {
      const bodies = poolEntries.map((e) => meta0.get(e.id)?.body ?? '')
      rerankScores = await reranker.score(question, bodies)
      const ms = Date.now() - t0
      const order = poolEntries.map((e, i) => [e, rerankScores[i]]).sort((a, b) => b[1] - a[1])
      ranked = order.map(([e]) => e)
      rerankInfo = { applied: true, candidates: poolEntries.length, ms, backend: reranker.backend, modelFile: reranker.modelFile }
    } catch (e) {
      // 重排失败**不影响结果**：退回 RRF 顺序，只把原因记录下来
      rerankInfo = { applied: false, candidates: poolEntries.length, reason: String(e?.message ?? e).slice(0, 140) }
    }
  }
  ranked = ranked.slice(0, topK)
  const scoreById = rerankScores ? new Map(poolEntries.map((e, i) => [e.id, rerankScores[i]])) : null

  const meta = new Map(store.chunksByIds(ranked.map((e) => e.id)).map((c) => [c.id, c]))
  const results = ranked
    .map((e, i) => {
      const c = meta.get(e.id)
      if (!c) return null
      const r = {
        rank: i + 1,
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        score: Number(e.score.toFixed(6)),
        ftsRank: e.fts,
        vecRank: e.vec,
        snippet: snippet(c.body, terms),
      }
      // 重排生效时附上交叉编码器分数：没有它，就分不清"排名变了"是重排的功劳还是没人动过
      if (scoreById?.has(e.id)) r.rerankScore = Number(scoreById.get(e.id).toFixed(4))
      if (e.neighbor) r.neighbor = true
      return r
    })
    .filter(Boolean)

  return {
    mode: wantVector && fts.length && vec.length ? 'hybrid' : vec.length ? 'vector' : 'fts',
    terms,
    note: vecNote,
    results,
    boosted: neighborCount,
    rerank: rerankInfo,
  }
}

// ---------------------------------------------------------------------------
// 远端索引模式：本地 BM25 + 远端 kNN（可选远端重排）→ 客户端 RRF 融合
//
// 为什么融合仍在客户端：远端只是"第二路召回"。它挂了就退化成纯关键词，
// 不需要在服务端实现 BM25、也不需要把查询语义外包出去。
// 身份用**内容哈希**（服务端只回 hash + 坐标），而不是本地 chunk id——
// 这样两边对"同一个块"的定义完全一致，也不会因为删建索引导致 id 漂移。
// ---------------------------------------------------------------------------

/**
 * @param {object} store 本地索引（提供 BM25 与正文）
 * @param {string} question
 * @param {object} o
 * @param {number} [o.topK]
 * @param {Array<{hash:string,score:number,rerankScore?:number}>} o.remoteHits 远端召回（已按相关性排好）
 * @param {object} [o.remoteMeta] 远端自述：{ms, coverage, rerank}
 * @param {number} [o.remoteCandidates]
 */
export async function searchFusedRemote(
  store,
  question,
  {
    topK = 10,
    remoteHits = [],
    remoteMeta = null,
    reranker = null,
    rerankCandidates = 0,
    excludePaths = [],
    boostPrefix = null,
    boostWeight = 0.004,
  } = {},
) {
  const terms = extractTerms(question)
  const match = buildMatch(terms)
  let fts = []
  if (match) {
    try {
      fts = store.ftsSearch(match, FTS_CANDIDATES)
    } catch {
      for (const t of terms.slice(0, 3)) {
        try {
          const m = buildMatch([t])
          if (m) {
            fts = store.ftsSearch(m, FTS_CANDIDATES)
            if (fts.length) break
          }
        } catch {
          /* 单关键词语法错误忽略 */
        }
      }
    }
  }

  const acc = new Map()
  fts.forEach((r, i) => {
    acc.set(r.hash, { hash: r.hash, ftsRank: i + 1, vecRank: null, score: 1 / (RRF_K + i + 1) })
  })
  remoteHits.forEach((h, i) => {
    const e = acc.get(h.hash) ?? { hash: h.hash, ftsRank: null, vecRank: null, score: 0 }
    e.vecRank = i + 1
    e.score += 1 / (RRF_K + i + 1)
    if (h.rerankScore !== undefined) e.rerankScore = h.rerankScore
    acc.set(h.hash, e)
  })

  let ranked = [...acc.values()]
  ranked.sort((a, b) => b.score - a.score)
  let byHash = store.chunksByHashes(ranked.map((e) => e.hash))

  // 当前文件锚定：排除正在编辑的文件 + 同目录加权（与本地模式共用同一套规则）
  let neighborCount = 0
  if (excludePaths.length || boostPrefix) {
    const cur = curate(ranked, (e) => byHash.get(e.hash)?.path, { excludePaths, boostPrefix, boostWeight })
    ranked = cur.entries
    neighborCount = cur.neighbors
  }

  // 远端做过重排：带分的项按重排分排序，未参与重排的（纯 BM25 命中）排在后面
  const scored = ranked.filter((e) => e.rerankScore !== undefined)
  if (scored.length) {
    scored.sort((a, b) => b.rerankScore - a.rerankScore)
    ranked = [...scored, ...ranked.filter((e) => e.rerankScore === undefined)]
  }

  const pool = ranked.slice(0, Math.max(topK, 40, rerankCandidates || 0))

  // 可选：**本机**重排（rerankBackend: local）。远端做过重排时不会走到这里。
  let rerankInfo = remoteMeta?.rerank ?? null
  if (reranker?.ok && rerankCandidates > 0 && pool.length > 1 && !pool.some((e) => e.rerankScore !== undefined)) {
    const t0 = Date.now()
    try {
      const bodies = pool.map((e) => byHash.get(e.hash)?.body ?? '')
      const scores = await reranker.score(question, bodies)
      rerankInfo = { applied: true, candidates: pool.length, ms: Date.now() - t0, backend: reranker.backend, modelFile: reranker.modelFile, where: 'local' }
      const order = pool.map((e, i) => [e, scores[i]]).sort((a, b) => b[1] - a[1])
      pool.splice(0, pool.length, ...order.map(([e]) => e))
      order.forEach(([e, s]) => {
        e.rerankScore = Number(s.toFixed(4))
      })
    } catch (e) {
      rerankInfo = { applied: false, candidates: pool.length, reason: String(e?.message ?? e).slice(0, 140) }
    }
  }
  const results = []
  let stale = 0
  for (const e of pool) {
    const c = byHash.get(e.hash)
    if (!c) {
      stale++
      continue
    }
    const r = {
      rank: results.length + 1,
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      score: Number(e.score.toFixed(6)),
      ftsRank: e.ftsRank,
      vecRank: e.vecRank,
      snippet: snippet(c.body, terms),
    }
    if (e.rerankScore !== undefined) r.rerankScore = Number(e.rerankScore.toFixed(4))
    if (e.neighbor) r.neighbor = true
    results.push(r)
    if (results.length >= topK) break
  }

  const notes = []
  if (!remoteHits.length) notes.push('远端向量通道没有返回结果（可能服务端还没嵌入完该仓库）')
  if (stale) notes.push(`${stale} 条远端命中的块在本地已不存在（本地索引比远端新，跑一次 code_index 可对齐）`)
  // 阈值取 0.999 而不是 1：99.67% 会被 toFixed(0) 显示成「100%」，却还提示「仍在嵌入」，自相矛盾
  if (remoteMeta?.coverage !== undefined && remoteMeta.coverage < 0.999) {
    notes.push(`远端向量覆盖 ${(remoteMeta.coverage * 100).toFixed(1)}%（服务端后台仍在嵌入）`)
  }

  return {
    mode: remoteHits.length && fts.length ? 'hybrid-remote' : remoteHits.length ? 'vector-remote' : 'fts',
    terms,
    note: notes.join('；'),
    results,
    boosted: neighborCount,
    rerank: rerankInfo,
    remote: remoteMeta ?? null,
    staleHits: stale,
  }
}
