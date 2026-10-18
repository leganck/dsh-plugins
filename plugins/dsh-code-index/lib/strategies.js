/**
 * 切块策略表 —— 对应 Cursor 的 `GetAvailableChunkingStrategies`（服务端按文件类型下发切块策略）。
 *
 * Cursor 那套是"服务端决定、客户端执行"，我们本地没有服务端，所以换成：
 * **内置策略表（按扩展名）+ 配置覆盖 + 依赖缺失时自动降级**。语义上等价：
 * 决定"每种文件用哪种切块器"这件事，是**集中配置**的，而不是散落在切块代码里。
 *
 * 三种策略（按优先级）：
 *
 * | id | 实现 | 依赖 | 实测（saas-business-5.0，532 个 Java 文件） |
 * |---|---|---|---|
 * | `ast` | tree-sitter 语法树，块边界落在成员声明上 | parser 依赖组（约 41 MB，按需装） | 块切在成员内部 **3.5%**；块数 627（约少 29%） |
 * | `heuristic` | 纯 JS：括号深度 + 成员边界 + 引号/注释感知 | **无**（永远可用） | 块首行落在成员内 48.3%（现状固定窗口是 79.7%） |
 * | `window` | 固定行窗口（本插件最早实现，保守兜底） | 无 | 块首行在成员内 79.7%、括号不平衡 73.3% |
 *
 * 降级链：`ast` 失败（依赖缺失 / 该文件解析抛错）→ `heuristic` → `window`。
 * 每一步降级都要被**记录并如实报告**——不能静默换策略（那等于悄悄改变检索质量）。
 */
import path from 'node:path'

export const STRATEGY_IDS = ['auto', 'ast', 'heuristic', 'window']
export const CONCRETE_STRATEGIES = ['ast', 'heuristic', 'window']

/** 语法包与导出变体（实测：tree-sitter-typescript 导出的是 {typescript, tsx}，没有 .language） */
export const GRAMMARS = {
  java: { pkg: 'tree-sitter-java', pick: null },
  javascript: { pkg: 'tree-sitter-javascript', pick: null },
  typescript: { pkg: 'tree-sitter-typescript', pick: 'typescript' },
  tsx: { pkg: 'tree-sitter-typescript', pick: 'tsx' },
  groovy: { pkg: 'tree-sitter-groovy', pick: null },
  go: { pkg: 'tree-sitter-go', pick: null },
  python: { pkg: 'tree-sitter-python', pick: null },
  rust: { pkg: 'tree-sitter-rust', pick: null },
}

/** 默认参数（可被配置逐项覆盖）
 *  - `minLines`：短于此的单元并入相邻块（字段、单行 import 不单独成块）
 *  - `targetLines`：累计到这个量级就在下一个成员边界收口（**不要拖到 maxLines**）
 *  - `maxLines`：单个成员超过它就强制拆分（唯一会产生"半截成员"的情况）
 */
const P = { minLines: 8, maxLines: 120, targetLines: 40 }

/**
 * 内置策略表。**顺序即优先级**：先按扩展名精确匹配，再退到 DEFAULT_FALLBACK。
 *
 * 为什么有些语言故意用 `window` 而不是 `heuristic`：
 * `heuristic` 依赖"括号深度"这个信号，它在语言内部混排（Vue SFC：template + script + style）
 * 或非括号语言（XML/SQL/Markdown）上无意义，硬用只会产生"看起来像切对了"的假象。
 * 这类文件用固定窗口更诚实。
 */
export const DEFAULT_BY_EXT = {
  // ── 有语法包：AST 切块 ──
  '.java': { strategy: 'ast', grammar: 'java', ...P },
  '.js': { strategy: 'ast', grammar: 'javascript', ...P },
  '.mjs': { strategy: 'ast', grammar: 'javascript', ...P },
  '.cjs': { strategy: 'ast', grammar: 'javascript', ...P },
  '.jsx': { strategy: 'ast', grammar: 'javascript', ...P },
  '.ts': { strategy: 'ast', grammar: 'typescript', ...P },
  '.tsx': { strategy: 'ast', grammar: 'tsx', ...P },
  /**
   * Groovy 单独给更大的 `maxLines`：Grails 的 domain/controller 里成员本身很长，
   * 实测 legacy-java-service（144 个 .groovy）：
   *   heuristic        块首行落在成员内部 31.6%（160/506）
   *   ast maxLines=120 12.2%，但**非强制块是 0/313**（即残差 100% 来自超长成员）
   *   ast maxLines=200  7.5%，强制拆分从 56 降到 33，非强制块仍是 0/315
   * 结论：AST 的对齐是完备的，残差只反映"成员比阈值长"，所以这里把阈值调大而不是接受半截。
   */
  '.groovy': { strategy: 'ast', grammar: 'groovy', ...P, maxLines: 200 },
  '.gradle': { strategy: 'ast', grammar: 'groovy', ...P, maxLines: 200 },
  /**
   * Go / Python / Rust：语法包存在（与运行时 0.21.x 同年代），但我们**默认不装**，
   * 由 `code_index` 检测到就提示，用户点了才下（见 lib/parser-hints.js）。
   * 没装时这些扩展名照样能建库 —— chunker 会降级 heuristic 并如实报告原因。
   */
  '.go': { strategy: 'ast', grammar: 'go', ...P },
  '.py': { strategy: 'ast', grammar: 'python', ...P },
  '.pyi': { strategy: 'ast', grammar: 'python', ...P },
  '.rs': { strategy: 'ast', grammar: 'rust', ...P },
  // ── 语言内部混排 / 非括号语言：固定窗口（保守） ──
  '.vue': { strategy: 'window', windowLines: 60 },
  '.xml': { strategy: 'window', windowLines: 60 },
  '.html': { strategy: 'window', windowLines: 60 },
  '.sql': { strategy: 'window', windowLines: 60 },
  '.md': { strategy: 'window', windowLines: 60 },
  '.json': { strategy: 'window', windowLines: 60 },
  '.yml': { strategy: 'window', windowLines: 60 },
  '.yaml': { strategy: 'window', windowLines: 60 },
  '.properties': { strategy: 'window', windowLines: 60 },
}

/** 表里没有的扩展名走这里：纯 JS 语法感知（对括号类语言有效，其它自动退化为按上限切） */
export const DEFAULT_FALLBACK = { strategy: 'heuristic', ...P }

/** 策略表快照（供状态输出/文档用） */
export function strategyTable() {
  return Object.entries(DEFAULT_BY_EXT).map(([ext, v]) => ({ ext, ...v }))
}

/**
 * 解析某个文件该用哪种策略。
 * @param {string} relPath 文件相对路径（只用扩展名）
 * @param {{strategy?:string, byExt?:Record<string,object>, windowLines?:number}} chunking 配置
 */
export function resolveChunkConfig(relPath, chunking = {}) {
  const ext = path.extname(relPath).toLowerCase()
  const base = DEFAULT_BY_EXT[ext] ?? DEFAULT_FALLBACK
  const override = (chunking.byExt ?? {})[ext] ?? {}
  const forced = chunking.strategy && chunking.strategy !== 'auto' ? chunking.strategy : null
  const merged = { ...base, ...override }
  const strategy = forced ?? merged.strategy
  return {
    ext,
    strategy,
    grammar: merged.grammar ?? null,
    minLines: merged.minLines ?? P.minLines,
    maxLines: merged.maxLines ?? P.maxLines,
    targetLines: merged.targetLines ?? P.targetLines,
    windowLines: merged.windowLines ?? chunking.windowLines ?? 40,
    // 供报告用：这个文件的策略是"表里指定的"还是"兜底默认的"
    fromTable: Boolean(DEFAULT_BY_EXT[ext]),
    forcedByConfig: Boolean(forced || Object.keys(override).length),
  }
}

/** 校验配置里的策略名 */
export function isValidStrategy(s) {
  return STRATEGY_IDS.includes(s)
}
