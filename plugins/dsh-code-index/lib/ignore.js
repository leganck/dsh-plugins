/**
 * 扫描期 ignore 规则：`.gitignore` / `.cursorignore` / `.cursorindexingignore`。
 *
 * 设计取舍：
 * - 用 `ignore` 包处理 gitignore 语法，避免自己实现 `!` / `**` / 目录规则的边角；
 * - 根目录的多个 ignore 文件按顺序叠加；嵌套 `.gitignore` 通过 chain 逐目录加载；
 * - 根 `.cursorignore` 默认只读一次；嵌套 `.cursorignore` 可选（Cursor 的层级 ignore
 *   是设置项，不是所有版本都默认开启）；
 * - 只负责“是否索引”，不改变 DSH 的 grep/read 工具——与 Cursor 的 terminal/MCP
 *   不受 `.cursorignore` 限制的边界一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'

export const DEFAULT_IGNORE_FILES = ['.gitignore', '.cursorignore', '.cursorindexingignore']

function readPatterns(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

function sourceOf(file) {
  const base = path.basename(file)
  return base === '.cursorindexingignore' ? 'cursorindexingignore' : base === '.cursorignore' ? 'cursorignore' : 'gitignore'
}

function makeNode(dirRel, file, patterns) {
  if (!patterns.length) return null
  const matcher = ignore().add(patterns)
  // ignore 对空 pattern 序列也会生成 matcher；只有真正有规则时才保留来源。
  if (!patterns.some((line) => String(line).trim() && !String(line).trim().startsWith('#'))) return null
  return { dirRel, file, source: sourceOf(file), matcher }
}

function nodesForFiles(dirAbs, dirRel, files, sources) {
  const nodes = []
  for (const name of files) {
    const file = path.join(dirAbs, name)
    const patterns = readPatterns(file)
    const node = makeNode(dirRel, file, patterns)
    if (node) {
      // 嵌套 `.cursorignore` 只在显式开启时加载；根目录由调用方传入 files。
      if (dirRel && node.source === 'cursorignore' && !sources.hierarchicalCursorIgnore) continue
      nodes.push(node)
    }
  }
  return nodes
}

class IgnoreChain {
  constructor(root, nodes) {
    this.root = root
    this.nodes = nodes
  }

  test(rel, isDir = false) {
    const normalized = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!normalized) return { ignored: false }
    for (let i = this.nodes.length - 1; i >= 0; i -= 1) {
      const node = this.nodes[i]
      let local = normalized
      if (node.dirRel) {
        if (normalized !== node.dirRel && !normalized.startsWith(node.dirRel + '/')) continue
        local = normalized.slice(node.dirRel.length + 1)
      }
      let result
      try {
        result = node.matcher.test(local)
      } catch {
        // 某个 pattern 写法异常时不影响整体扫描；保守地继续看更上层规则。
        continue
      }
      if (result.ignored) {
        return { ignored: true, source: node.source, file: node.file, pattern: result.rule?.pattern ?? null }
      }
      if (result.unignored) {
        return { ignored: false, source: node.source, file: node.file, pattern: result.rule?.pattern ?? null }
      }
    }
    return { ignored: false }
  }

  /** 进入子目录：加载该目录的 `.gitignore`，可选加载 `.cursorignore`。 */
  enter(dirAbs, dirRel, options) {
    const files = []
    if (options.hierarchicalGitignore !== false) files.push('.gitignore')
    if (options.hierarchicalCursorIgnore) files.push('.cursorignore')
    if (!files.length) return this
    const nodes = nodesForFiles(dirAbs, dirRel, files, options)
    if (!nodes.length) return this
    return new IgnoreChain(this.root, [...this.nodes, ...nodes])
  }
}

/**
 * @param {string} root 仓库根目录
 * @param {object} [opts]
 * @param {string[]} [opts.ignoreFiles] 根目录要读取的 ignore 文件名
 * @param {boolean} [opts.hierarchicalGitignore] 是否读取子目录 `.gitignore`
 * @param {boolean} [opts.hierarchicalCursorIgnore] 是否读取子目录 `.cursorignore`
 * @returns {{test: Function, enter: Function, root: string, sources: string[]}}
 */
export function createIgnoreChain(root, opts = {}) {
  const options = {
    ignoreFiles: opts.ignoreFiles ?? DEFAULT_IGNORE_FILES,
    hierarchicalGitignore: opts.hierarchicalGitignore !== false,
    hierarchicalCursorIgnore: opts.hierarchicalCursorIgnore === true,
  }
  const rootNodes = nodesForFiles(root, '', options.ignoreFiles, options)
  return new IgnoreChain(root, rootNodes)
}

export function isIgnored(chain, rel, isDir = false) {
  return chain?.test(rel, isDir) ?? { ignored: false }
}
