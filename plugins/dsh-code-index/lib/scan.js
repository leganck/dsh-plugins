/**
 * 仓库扫描与增量判定。
 *
 * 本机实测（2088 文件 / 105 MB 的 Java 仓库）：
 *   全量遍历 120 ms、全量 sha256 703 ms、增量核对（mtime+size 未变则跳过）2 ms
 * 所以这里不实现 Merkle 树——那是为十万级文件与跨网同步设计的，本地用不上。
 * 采用两级判定：先比 mtime+size（近乎免费），只有变了才读文件算 sha256。
 */
import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from './chunker.js'

/** 默认索引的扩展名（按你实际技术栈裁剪） */
export const DEFAULT_INCLUDE = [
  '.java', '.kt', '.groovy', '.scala',
  '.xml', '.yml', '.yaml', '.properties', '.gradle', '.sql',
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.py', '.go', '.rs', '.cs', '.php', '.rb',
  '.md', '.sh',
]

/** 默认排除的目录名（构建产物、依赖、缓存） */
export const DEFAULT_EXCLUDE_DIRS = [
  '.git', 'node_modules', 'build', 'dist', 'out', 'bin', 'obj', 'target',
  '.gradle', '.idea', '.vscode', 'vendor', '__pycache__', '.venv', 'venv',
  '.next', '.nuxt', '.cache', 'logs', 'tmp', 'temp', '.mvn', 'coverage',
  '.pytest_cache', '.mypy_cache', 'site-packages', '.dsh-index',
]

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * 归一化"要排除的相对路径"：去前导 `./`、去结尾 `/`、反斜杠转正斜杠。
 * 返回空串表示无效（调用方应过滤掉）。
 */
export function normalizeRelPrefix(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim()
}

/**
 * 遍历仓库，返回候选文件及其 mtime/size。
 *
 * 排除规则（两种，互不替代）：
 *  - `opts.excludeDirs`：**目录名**，任意深度都排除；与内置 `DEFAULT_EXCLUDE_DIRS` **合并**
 *    （不是替换 —— 只加一个自定义目录不应把 node_modules 之类重新暴露出来）。
 *  - `opts.excludePaths`：**仓库相对路径**（或其前缀），例如 `legacy-grails-service`
 *    或 `docs/2-technical`。用于排除那些"名字本身很正常、但在这个仓库里是遗留/生成物"的目录
 *    —— 只靠目录名做不到这件事（会误伤别处同名的正常目录）。若匹配到具体文件，则该文件单独排除。
 *
 * 被排除的文件不会出现在结果里，因此 `diffFiles` 会把它们判为 `removed` → 旧块自动清理。
 * @returns {{rel: string, abs: string, mtime: number, size: number}[]}
 */
export function walkRepo(root, opts = {}) {
  const include = new Set(opts.include ?? DEFAULT_INCLUDE)
  const excludeDirs = new Set([...DEFAULT_EXCLUDE_DIRS, ...(opts.excludeDirs ?? [])])
  const excludePaths = (opts.excludePaths ?? []).map(normalizeRelPrefix).filter(Boolean)
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const isExcludedPath = (rel) => excludePaths.some((p) => rel === p || rel.startsWith(p + '/'))
  const out = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const rel = path.relative(root, abs).replace(/\\/g, '/')
      if (e.isDirectory()) {
        if (excludeDirs.has(e.name) || isExcludedPath(rel)) continue
        stack.push(abs)
        continue
      }
      if (!e.isFile()) continue
      if (isExcludedPath(rel)) continue
      const ext = path.extname(e.name).toLowerCase()
      if (!include.has(ext)) continue
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (st.size === 0 || st.size > maxBytes) continue
      out.push({ rel, abs, mtime: Math.floor(st.mtimeMs), size: st.size })
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  return out
}

/**
 * 与索引中的指纹比对，分出新增/修改/删除。
 * @param {{rel: string, mtime: number, size: number}[]} scanned
 * @param {Map<string, {mtime: number, size: number, sha: string}>} known
 */
export function diffFiles(scanned, known) {
  const changed = []
  const unchanged = []
  const seen = new Set()
  for (const f of scanned) {
    seen.add(f.rel)
    const prev = known.get(f.rel)
    if (prev && prev.mtime === f.mtime && prev.size === f.size) unchanged.push(f)
    else changed.push(f)
  }
  const removed = [...known.keys()].filter((rel) => !seen.has(rel))
  return { changed, unchanged, removed }
}

/** 读文件并按需计算 sha256（mtime+size 已变时才读） */
export function readForIndex(abs) {
  const text = fs.readFileSync(abs, 'utf8')
  return { text, sha: sha256(text) }
}
