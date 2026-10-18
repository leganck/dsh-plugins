/**
 * 「打开新目录时提示安装语言扩展」的检测逻辑。
 *
 * 设计取向：**不偷偷装**。原生依赖几十 MB、且会改变切块结果（进而改变命名空间），
 * 所以先算清"装了能得到什么"，把选择权交回用户：
 *
 *   这个仓库有 454 个 .go 文件，目前走 heuristic（缺 tree-sitter-go，2.7 MB）
 *   装：code_index_deps action=install group=parser
 *
 * 为什么不是弹窗：插件没有 UI 通道，DSH 的交互面就是工具结果 —— 把结论写进
 * `code_index` 的输出，模型会转述给用户，用户同意后由模型调用安装工具。
 */
import path from 'node:path'
import { resolveChunkConfig } from './strategies.js'
import { getParser } from './chunk-ast.js'

/**
 * 每个语法对应的 npm 包与体积（与运行时 0.21.x 同年代的版本）。
 * `approxBytes` 只用于提示，不作为正确性依据。
 */
export const GRAMMAR_PACKAGES = {
  java: { pkg: 'tree-sitter-java', version: '0.21.0', approxBytes: 4.9e6, group: 'parser' },
  javascript: { pkg: 'tree-sitter-javascript', version: '0.21.4', approxBytes: 4.3e6, group: 'parser' },
  typescript: { pkg: 'tree-sitter-typescript', version: '0.21.2', approxBytes: 29.3e6, group: 'parser' },
  tsx: { pkg: 'tree-sitter-typescript', version: '0.21.2', approxBytes: 0, group: 'parser' },
  groovy: { pkg: 'tree-sitter-groovy', version: '0.1.2', approxBytes: 19.3e6, group: 'parser' },
  go: { pkg: 'tree-sitter-go', version: '0.21.2', approxBytes: 2.7e6, group: 'parser-go' },
  python: { pkg: 'tree-sitter-python', version: '0.21.0', approxBytes: 5.8e6, group: 'parser-python' },
  rust: { pkg: 'tree-sitter-rust', version: '0.21.0', approxBytes: 10.8e6, group: 'parser-rust' },
}

/**
 * 统计"本仓库需要、但当前装不上"的语法。
 *
 * @param {Array<{rel:string}>} scanned 扫描结果（只需要 rel）
 * @param {object} chunking 切块配置
 * @param {object} deps `{ depsDir, depsFallbackDirs }`
 * @param {(g:string)=>boolean} [isAvailable] 可注入，便于测试
 * @returns {Array<{grammar, pkg, version, approxBytes, files, exts}>} 按文件数降序
 */
export function detectMissingGrammars(scanned, chunking = {}, deps = {}, isAvailable = null) {
  const probe =
    isAvailable ??
    ((grammar) => {
      try {
        return getParser({ depsDir: deps.depsDir, depsFallbackDirs: deps.depsFallbackDirs ?? [], grammar }).ok
      } catch {
        return false
      }
    })

  const byGrammar = new Map()
  for (const f of scanned) {
    const cfg = resolveChunkConfig(f.rel, chunking)
    if (cfg.strategy !== 'ast' || !cfg.grammar) continue
    const ext = path.extname(f.rel).toLowerCase()
    let e = byGrammar.get(cfg.grammar)
    if (!e) {
      e = { grammar: cfg.grammar, files: 0, exts: new Set() }
      byGrammar.set(cfg.grammar, e)
    }
    e.files++
    e.exts.add(ext)
  }

  const out = []
  for (const e of byGrammar.values()) {
    if (probe(e.grammar)) continue // 已装，不需要提示
    const meta = GRAMMAR_PACKAGES[e.grammar] ?? { pkg: `tree-sitter-${e.grammar}`, version: '?', approxBytes: 0 }
    out.push({ ...meta, grammar: e.grammar, files: e.files, exts: [...e.exts].sort() })
  }
  return out.sort((a, b) => b.files - a.files)
}

/**
 * 把检测结果渲染成给模型/用户看的几行。
 * 文案刻意包含"影响什么、要下多大、装完会怎样"，否则用户无法判断该不该点。
 */
export function renderParserHint(missing, { totalFiles = 0, vectorStore = 'local' } = {}) {
  if (!missing.length) return []
  const files = missing.reduce((n, m) => n + m.files, 0)
  const mb = missing.reduce((n, m) => n + (m.approxBytes || 0), 0) / 1048576
  const list = missing
    .map((m) => `${m.exts.join('/')} × ${m.files} 个文件 → 缺 ${m.pkg}@${m.version}（约 ${((m.approxBytes || 0) / 1048576).toFixed(1)} MB）`)
    .join('；')
  // 每个语言一个安装组：只装自己需要的，不把 python/rust 一起拖下来
  const installLines = missing.map(
    (m) =>
      `   装 ${m.grammar}：code_index_deps action=install group=${m.group ?? 'parser'}`
      + `（约 ${((m.approxBytes || 0) / 1048576).toFixed(1)} MB，不执行依赖脚本，装完当次生效）`,
  )
  if (missing.length > 1) {
    installLines.push(`   一次装齐：code_index_deps action=install group=parser-extra（约 ${mb.toFixed(1)} MB）`)
  }
  return [
    `💡 有 ${files}/${totalFiles} 个文件本可以按语法切块：${list}`,
    ...installLines,
    '   影响：切块边界更整齐（块首落在函数中间的比例：heuristic 7.5% → ast 0.1%）。',
    // 两种模式都会因为"切块指纹变了"而重建索引，但代价不同，措辞必须分开 ——
    // 本地用户看到"命名空间换新"只会困惑（那是远端存储的概念）。
    vectorStore === 'remote'
      ? '   代价：切块指纹变了 → 服务端命名空间换新；向量按内容哈希去重，只有正文真的变了的块需要重嵌。'
      : '   代价：切块指纹变了 → 索引会全量重建；向量按内容哈希命中缓存，只有正文真的变了的块需要重算。',
  ]
}
