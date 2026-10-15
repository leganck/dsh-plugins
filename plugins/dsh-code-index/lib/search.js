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
 * 执行一次混合检索。
 * @returns {{mode: string, note: string, results: Array<object>}}
 */
export async function search(store, embedder, question, { topK = 10, mode = 'auto' } = {}) {
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
    if (!embedder?.ok) {
      vecNote = `向量通道未启用：${embedder?.reason ?? '嵌入器不可用'}`
    } else if (vectors === 0) {
      vecNote = '向量通道未启用：索引里还没有向量（code_index 建库时未嵌入）'
    } else {
      try {
        const [qv] = await embedder.embed([question], { isQuery: true })
        const { ids, mat, dim } = loadMatrix(store)
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
      } catch (e) {
        vecNote = `向量检索失败：${String(e.message).slice(0, 120)}`
      }
    }
  } else if (mode !== 'vector') {
    vecNote = '向量通道未启用（配置 embedding.backend = off）'
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
  ranked = ranked.slice(0, topK)

  const meta = new Map(store.chunksByIds(ranked.map((e) => e.id)).map((c) => [c.id, c]))
  const results = ranked
    .map((e, i) => {
      const c = meta.get(e.id)
      if (!c) return null
      return {
        rank: i + 1,
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        score: Number(e.score.toFixed(6)),
        ftsRank: e.fts,
        vecRank: e.vec,
        snippet: snippet(c.body, terms),
      }
    })
    .filter(Boolean)

  return {
    mode: wantVector && fts.length && vec.length ? 'hybrid' : vec.length ? 'vector' : 'fts',
    terms,
    note: vecNote,
    results,
  }
}
