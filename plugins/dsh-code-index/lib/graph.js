/**
 * 符号与关系边存储 —— code-index 的「图扩展」（0.17）。
 *
 * 设计目标（对应 mnemon 的启示，但用的是**代码自己的边**）：
 *  - `symbols`：AST 切块时已经拿到的声明符号（方法/类/接口），落库供图边引用与
 *    `code_graph` 定位；mnemon 的"实体"思想在这里落地为「代码实体表」。
 *  - `edges`：类型化边（imports / calls / overrides / mapper_stmt / table_ref），
 *    带 weight 表示置信度 —— mnemon 用模型判断边（不可靠），代码域从语法确定性提取
 *    （可靠可重建），所以 weight 只是排序提示，不做硬过滤。
 *
 * 有界遍历原则（借 mnemon related 的深度上限思想）：
 *  - 查询端 expand 最多 2 跳、每类边最多 N 条、按 weight desc 截断 —— 图永远不整图扫；
 *  - 0.18 起查询端（code_search 的 expand / code_graph）的语义模式与渲染也放在本文件：
 *    「语义模式 → 边类型」必须和提取口径一起演进，散到两处必然漂移。
 *
 * 与现有机制的关系：
 *  - 块删除（dropFile）必须级联清理 symbols/edges，否则边指向失效 chunk_id；
 *  - 边提取失败**永不阻塞建库**：图是补充不是门槛，extraction 阶段抛错只记数跳过；
 *  - 增量重建复用现有两级指纹：文件变了 replaceChunks → 重新提取该文件的符号与边。
 */

import { extractTerms, buildMatch } from './query.js'

/** 支持的边类型。新增类型必须同步 extractEdges 的实现与这里。 */
export const EDGE_TYPES = Object.freeze({
  imports: 'imports',       // 文件 → 文件（import 语句）
  calls: 'calls',           // 符号 → 符号（方法调用，按名字匹配，低置信度也保留）
  overrides: 'overrides',   // 符号 → 符号（同签名方法覆盖）
  mapper_stmt: 'mapper_stmt', // MyBatis XML statement id → DAO 接口方法
  table_ref: 'table_ref',   // mapper XML / SQL 块 → 表名（entity 形态）
})

const EDGE_TYPE_SET = new Set(Object.values(EDGE_TYPES))

/** 从 MyBatis mapper XML 提取 statement id 与表名引用。 */
const MAPPER_XML_RE = /<(?:select|insert|update|delete)\b[^>]*\bid\s*=\s*"([^"]+)"/gi
const TABLE_RE = /(?:\b(?:from|join|into|update)\s+)([`[\]]?)([A-Za-z_][\w$]*)\1/gi

/**
 * 从一个块的正文提取「引用了哪些标识符」与「声明了什么」。
 * 语法级、零依赖（不要求 tree-sitter 可用）：正则 + 行扫描，宁可漏不要错。
 * 返回：
 *   declared: string[]                  声明的方法/类名（进入 symbols）
 *   imported: { file: string }[]        import 的相对目标（按常见约定猜测，尽力而为）
 *   calls:    string[]                  调用的方法名
 *   mapperStatements: string[]          XML statement id（mapper XML 里）
 *   tableRefs:   string[]               SQL 里引用的表名
 */
export function scanChunk(body) {
  const text = String(body ?? '')
  const declared = []
  const calls = []
  const imported = []
  const mapperStatements = []
  const tableRefs = []
  const NOT_DECL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'this', 'function', 'def', 'fn', 'synchronized', 'print'])

  // ---- 声明（宽松版；多语言通用。接口/抽象方法以 `;` 结尾也算声明）----
  // 方法声明：修饰符 + 可选泛型/返回类型 + 名字 + (  —— 结尾是 { 或 ; 都行
  //
  // 参数段用 `\([^;)]*\)`（允许 `{`/`}`，禁止 `;` 与嵌套 `)`）：
  // JS/TS 里**解构参数**极常见（`function buildIndex({ store, repoRoot })`），
  // 早先的 `[^;{]*` 会把 `{` 排除掉 → 这类声明整条漏抓（实测：本插件自己的
  // buildIndex/rebuildGraph 都抓不到，code_graph 查不到入口）。允许 `{` 后仍
  // 保守：`;` 与 `)` 不进参数段，所以不会跨语句，也不会跨嵌套调用。
  const METHOD_RE = /(?:^|\n)\s*(?:(?:public|private|protected|internal|static|final|abstract|override|suspend|default|native|synchronized)\s+)*[\w<>,.[\]\s]*?\b([A-Za-z_$][\w$]*)\s*\([^;)]*\)\s*(?:\{|;)/g
  let m
  while ((m = METHOD_RE.exec(text))) {
    const name = m[1]
    if (name && !NOT_DECL.has(name) && !declared.includes(name)) declared.push(name)
  }
  // 类型声明：class/interface/enum/record/struct/trait
  const TYPE_RE = /\b(?:class|interface|enum|record|struct|trait)\s+([A-Za-z_$][\w$]*)/g
  while ((m = TYPE_RE.exec(text))) {
    if (!declared.includes(m[1])) declared.push(m[1])
  }

  // ---- 方法调用（保守：仅 Name( 形态，排除 new/if/for 等关键字）----
  const CALL_RE = /\b([a-z_$][\w$]*)\s*\(/g
  const NOT_CALL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'this', 'switch', 'function', 'def', 'fn', 'and', 'or', 'not', 'in', 'is', 'print', 'len', 'range'])
  while ((m = CALL_RE.exec(text))) {
    const name = m[1]
    if (name.length < 3 || NOT_CALL.has(name)) continue
    if (!calls.includes(name)) calls.push(name)
  }

  // ---- import（Java/JS/Python/Go 通用首行形态，只记目标串）----
  const IMPORT_RE = /^\s*(?:import|from)\s+['"]?([\w./$]+)['"]?/gm
  while ((m = IMPORT_RE.exec(text))) imported.push({ file: m[1] })

  // ---- MyBatis statement id ----
  while ((m = MAPPER_XML_RE.exec(text))) mapperStatements.push(m[1])

  // ---- SQL 表引用（含 MyBatis XML 里的 SQL 与 .sql 文件）----
  while ((m = TABLE_RE.exec(text))) {
    const t = m[2]
    if (t && !/^(select|where|on|set|values|as|left|right|inner|outer|order|group|by|limit|dual)$/i.test(t)) {
      if (!tableRefs.includes(t)) tableRefs.push(t)
    }
  }

  return { declared, calls, imported, mapperStatements, tableRefs }
}

/**
 * 批量重算一个仓库（一个库）的 symbols + edges。
 * 策略：全量重建（成本远低于切块本身，且边是文件级派生物，无需增量维护复杂性）。
 *
 * @param {import('./store.js').Store} store
 * @param {{logger?: (m:string)=>void}} [p]
 * @returns {{symbols:number, edges:number, files:number, errors:number}}
 */
/**
 * 图构建算法版本。**改了 scanChunk 的提取规则就 +1**：
 * 建库时的"没变更就跳过重建"会沿用旧结果（0 ms），旧规则抽出来的符号/边
 * 会一直留在库里，直到用户下次改文件才刷新。有了这个版本号，升级插件后
 * 第一次建库会因版本不匹配强制重扫一次。
 */
export const GRAPH_VERSION = 2

export function rebuildGraph(store, { logger = () => {} } = {}) {
  const t0 = Date.now()
  store.clearGraph()
  const files = [...store.fileState().keys()]

  // ---- pass 1：symbols + mapper statements + table refs ----
  /** file → { declared, calls, imported, mapperStatements, tableRefs, chunkIds } */
  const perFile = new Map()
  /** name → [{file, chunkId}]（声明索引，跨文件连 calls/overrides 用） */
  const declIndex = new Map()
  /** mapperStatement id → [{file, chunkId}]（连 mapper_stmt 用） */
  const stmtIndex = new Map()

  let errors = 0
  for (const rel of files) {
    const chunks = store.chunksForPath(rel)
    const info = { declared: [], calls: [], imported: [], mapperStatements: [], tableRefs: [], chunkIds: [] }
    for (const c of chunks) {
      info.chunkIds.push(c.id)
      try {
        const s = scanChunk(c.body)
        for (const d of s.declared) {
          info.declared.push(d)
          if (!declIndex.has(d)) declIndex.set(d, [])
          declIndex.get(d).push({ file: rel, chunkId: c.id })
        }
        for (const st of s.mapperStatements) {
          info.mapperStatements.push(st)
          if (!stmtIndex.has(st)) stmtIndex.set(st, [])
          stmtIndex.get(st).push({ file: rel, chunkId: c.id })
        }
        info.calls.push(...s.calls)
        info.imported.push(...s.imported)
        info.tableRefs.push(...s.tableRefs)
      } catch {
        errors += 1
      }
    }
    perFile.set(rel, info)
  }

  const symbols = store.insertSymbols(perFile)
  const edges = store.insertEdges({ perFile, declIndex, stmtIndex })
  store.setMeta('graph_built_at', String(Date.now()))
  store.setMeta('graph_version', String(GRAPH_VERSION))
  logger(`图重建完成：${symbols} 符号 / ${edges} 边 / ${files.length} 文件，耗时 ${Date.now() - t0} ms，坏块 ${errors}`)
  return { symbols, edges, files: files.length, errors }
}

/**
 * 供查询端使用：带界扩展。所有遍历都被 limit 截断 —— 一次查询最多看几十条边。
 *
 * direction 是 0.18 加的：callers / impact 只要入向、callees 只要出向，
 * 必须**逐边**过滤而不是"先全收再筛"——2 跳时方向是相对中间块的，
 * 事后筛会把"中间块出边 + 目标块入边"混在一起（同一个邻居只保留第一次见到的那条）。
 */
export function expandFromChunk(store, { chunkId, types, perTypeLimit = 5, maxHops = 1, direction = 'both' }) {
  const hop = maxHops <= 0 ? 1 : Math.min(maxHops, 2)
  const seenChunks = new Set([chunkId])
  let frontier = [{ chunkId, hopLeft: hop }]
  const out = []
  const typeFilter = types?.length ? new Set(types.filter((t) => EDGE_TYPE_SET.has(t))) : null

  while (frontier.length) {
    const next = []
    for (const { chunkId: cid, hopLeft } of frontier) {
      // 不把 types 传给 store.edgesOfChunk：它的 SQL 里有 `and type in (?)` 占位却只 bind 了
      // chunkId（见 lib/store.js），传了会**静默得到空结果**——那正是"图明明有边却查不出来"。
      // store.js 不在本次改动范围，所以在这层过滤：语义等价，每类边仍受 perTypeLimit 约束。
      const rel = store.edgesOfChunk(cid, { perTypeLimit })
      for (const e of rel) {
        if (typeFilter && !typeFilter.has(e.type)) continue
        if (direction !== 'both' && e.direction !== direction) continue
        const other = e.direction === 'out' ? e.dst_chunk : e.src_chunk
        if (other == null || seenChunks.has(other)) continue
        seenChunks.add(other)
        out.push({ ...e, hop: hop - hopLeft + 1 })
        if (hopLeft > 1) next.push({ chunkId: other, hopLeft: hopLeft - 1 })
      }
    }
    frontier = next
  }
  // 带 chunk 元数据返回
  const ids = out.map((e) => (e.direction === 'out' ? e.dst_chunk : e.src_chunk)).filter((x) => x != null)
  const meta = new Map(store.chunksByIds(ids).map((c) => [c.id, c]))
  return out
    .map((e) => {
      const otherId = e.direction === 'out' ? e.dst_chunk : e.src_chunk
      return { ...e, other: meta.get(otherId) ?? null }
    })
    .filter((e) => e.other)
}

// ---------------------------------------------------------------------------
// 查询端（0.18）：expand 语义模式、符号/块定位、渲染
//
// 分工：上面的 scanChunk/rebuildGraph 负责**产出**图，这一层负责把边翻译成
// 「模型能直接引用的一行结果」（谁调用我 / 我调用谁 / 改这里会波及谁）。
// 语义 → 边的映射只放在 EXPAND_MODES 一处：将来提取实现变了（例如 tree-sitter
// 精确解析、边类型增删），查询端与工具参数都不用跟着改。
// ---------------------------------------------------------------------------

/** expand 渲染的硬上限：区块正文 ≤1500 字符（再多就会挤掉命中正文本身） */
export const EXPAND_MAX_CHARS = 1500
/** expand 单次最多渲染多少条关联（有界纪律：图只做提示，不做整图遍历） */
export const EXPAND_MAX_ITEMS = 20

/**
 * `expand` 的四个语义模式 → 边类型 / 方向 / 跳数。
 *
 * - callers：谁引用我（入向）。mapper_stmt 也算"调用方"——XML statement 引用 DAO 方法
 *   是同一件事的另一种写法的关系。
 * - callees：我引用谁（出向）。
 * - mapper：mapper 三角（statement id ↔ DAO 方法 ↔ 表名），两个方向都要看。
 * - impact：变更影响面 = 入向调用链（谁会被我影响），2 跳封顶，最终仍由渲染截断。
 */
export const EXPAND_MODES = Object.freeze({
  callers: { types: ['calls', 'overrides', 'mapper_stmt'], direction: 'in', hops: 1 },
  callees: { types: ['calls', 'overrides'], direction: 'out', hops: 1 },
  mapper: { types: ['mapper_stmt', 'table_ref'], direction: 'both', hops: 1 },
  impact: { types: null, direction: 'in', hops: 2 },
})

/**
 * 类型渲染优先级：按**确定性强度**排（mapper_stmt 0.9 > calls 0.5 > overrides 0.3 > table_ref 0.4 的实体弱边）。
 * 用固定顺序而不是"按条数排"，是为了同一份图两次渲染结果稳定 —— 测试与 diff 都要可比。
 */
const TYPE_ORDER = ['mapper_stmt', 'calls', 'overrides', 'table_ref', 'imports']
const typeRank = (t) => {
  const i = TYPE_ORDER.indexOf(t)
  return i < 0 ? TYPE_ORDER.length : i
}

/** 邻居统一排序：置信度 → 类型确定性 → 路径/行号（同样输入两次输出必须一致） */
export function sortNeighbors(a, b) {
  return (
    b.weight - a.weight
    || typeRank(a.type) - typeRank(b.type)
    || String(a.other?.path ?? '').localeCompare(String(b.other?.path ?? ''))
    || (a.other?.startLine ?? 0) - (b.other?.startLine ?? 0)
    || String(a.type).localeCompare(String(b.type))
  )
}

/**
 * 正文首行摘要：给「这条边连到了什么」一个不花钱的上下文。
 * 跳过空行（很多文件首块以空行/import 开头），截断到 maxChars 防止单行超长把渲染预算吃光。
 */
export function firstLineOf(body, maxChars = 100) {
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line
  }
  return ''
}

/** 图规模快照：code_index / code_index_status 的展示面与"旧库无图"提示都靠它 */
export function graphStats(store) {
  const one = (sql) => Number(Object.values(store.db.prepare(sql).get())[0])
  return {
    symbols: one('select count(*) from symbols'),
    edges: one('select count(*) from edges'),
    builtAt: Number(store.getMeta('graph_built_at') ?? 0) || null,
    version: Number(store.getMeta('graph_version') ?? 0) || 0,
  }
}

/**
 * 按名字精确查符号声明（可能多处：接口/实现、重载、同名工具方法）。
 * 用 symbols 表而不是重跑 AST：声明索引在建库时已经落库，查询端零成本。
 * 这里直接读表（而不是给 Store 加方法）：symbols/edges 是 graph.js 建的表，
 * 读写口径放在同一文件里，才不会出现"建的时候一套、查的时候另一套"。
 */
export function findSymbols(store, name) {
  const key = String(name ?? '').trim()
  if (!key) return []
  return store.db
    .prepare('select path, name, chunk_id as chunkId, kind from symbols where name = ? order by path, chunk_id')
    .all(key)
    .map((r) => ({ path: r.path, name: r.name, chunkId: r.chunkId == null ? null : Number(r.chunkId), kind: r.kind }))
}

/** 找不到符号时的候选（包含匹配）：把"查不到"变成可以直接改名的下一步 */
export function similarSymbolNames(store, name, limit = 5) {
  const key = String(name ?? '').trim()
  if (!key) return []
  return store.db
    .prepare('select distinct name from symbols where name like ? order by length(name), name limit ?')
    .all(`%${key}%`, Math.max(1, limit))
    .map((r) => r.name)
}

/**
 * 命中项 → chunk_id。
 * code_search 的结果刻意只回 path:startLine（远端命中的 id 在本地未必存在），
 * 所以这里按「路径 + 起始行」这一对稳定坐标回查；查不到就留 null 由调用方跳过
 * （索引刚被刷新、命中来自旧远端快照时属于正常情况）。
 */
export function chunkIdsForHits(store, hits) {
  const byKey = new Map()
  const seenPaths = new Set()
  for (const hit of hits ?? []) {
    const p = hit?.path
    if (!p || seenPaths.has(p)) continue
    seenPaths.add(p)
    for (const c of store.chunksForPath(p)) byKey.set(`${p}:${c.startLine}`, c.id)
  }
  return (hits ?? []).map((h) => ({ ...h, chunkId: byKey.get(`${h.path}:${h.startLine}`) ?? null }))
}

/** chunk_hint → 块（FTS）：code_graph 在没有符号名时的定位方式，复用同一套词项抽取 */
export function findChunksByHint(store, hint, limit = 5) {
  const match = buildMatch(extractTerms(String(hint ?? ''), 6))
  if (!match) return []
  return store.ftsSearch(match, Math.max(1, limit)).map((c) => ({
    id: c.id, path: c.path, startLine: c.startLine, endLine: c.endLine, body: c.body,
  }))
}

/** 邻居收集（code_graph 用）：在 expandFromChunk 的带上界遍历之上统一排序口径 */
export function collectNeighbors(store, { chunkId, types = null, direction = 'both', hops = 1, perTypeLimit = 50 } = {}) {
  return expandFromChunk(store, { chunkId, types, direction, maxHops: hops, perTypeLimit }).sort(sortNeighbors)
}

/**
 * code_search 的 expand：把 top-N 命中块各自的有界邻居归并成一份列表。
 * 归并时按 (type, 邻居块) 去重 —— 同一个文件常有多块命中，不去重的话
 * 「关联代码」区块会被同一个调用方刷满，真正的新信息全被挤掉。
 */
export function expandHits(store, hits, { mode = 'callers', maxHits = 5, perTypeLimit = 5, totalLimit = EXPAND_MAX_ITEMS } = {}) {
  const cfg = EXPAND_MODES[mode] ?? EXPAND_MODES.callers
  const roots = []
  const items = []
  const seen = new Set()
  for (const hit of (hits ?? []).slice(0, Math.max(1, maxHits))) {
    const chunkId = hit?.chunkId ?? null
    if (chunkId == null) continue
    roots.push({ path: hit.path, startLine: hit.startLine, endLine: hit.endLine })
    for (const n of expandFromChunk(store, {
      chunkId, types: cfg.types, direction: cfg.direction, maxHops: cfg.hops, perTypeLimit,
    })) {
      const key = `${n.type}\u0000${n.other.path}\u0000${n.other.startLine}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ ...n, from: { path: hit.path, startLine: hit.startLine } })
    }
  }
  items.sort(sortNeighbors)
  return { mode, roots, items: items.slice(0, Math.max(1, totalLimit)), total: items.length }
}

/**
 * 渲染「【关联代码】」区块。
 * 长度预算按**整块**算（含表头与"还有 N 条"尾巴）：超了宁可少给一条，
 * 也不要让模型拿到被硬截断的半行——那比没有更误导。
 * 无关联时返回空串，调用方据此决定"不出这个区块"。
 */
export function renderExpandBlock(expansion, { maxChars = EXPAND_MAX_CHARS } = {}) {
  const items = expansion?.items ?? []
  if (!items.length) return ''
  const hiddenTotal = Math.max(0, (expansion.total ?? items.length) - items.length)
  const header = `【关联代码】${expansion.mode}（${expansion.roots?.length ?? 0} 个命中块 → ${expansion.total ?? items.length} 条关联${
    hiddenTotal > 0 ? `，只显示前 ${items.length} 条` : ''
  }）`
  const lines = [header]
  let shown = 0
  for (const it of items) {
    const arrow = it.direction === 'in' ? '←' : '→'
    const where = `${it.other.path}:${it.other.startLine}-${it.other.endLine}`
    const block = [`  ${it.type} ${arrow} ${where}（置信度 ${Number(it.weight ?? 0).toFixed(2)}）`]
    const summary = firstLineOf(it.other.body)
    if (summary) block.push(`    ${summary}`)
    if ([...lines, ...block].join('\n').length > maxChars) break
    lines.push(...block)
    shown += 1
  }
  if (!shown) return ''
  const hidden = items.length - shown
  const tail = hidden > 0 ? `  …（还有 ${hidden} 条未显示，换更具体的 query 或缩小范围）` : ''
  if (tail && [...lines, tail].join('\n').length <= maxChars) lines.push(tail)
  return lines.join('\n')
}
