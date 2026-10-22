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
import { createIgnoreChain, DEFAULT_IGNORE_FILES } from './ignore.js'

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

function newStats() {
  return {
    ignored: 0,
    ignoredDirs: 0,
    binarySkipped: 0,
    sizeSkipped: 0,
    bySource: { gitignore: 0, cursorignore: 0, cursorindexingignore: 0, exclude: 0, default: 0 },
  }
}

function bump(stats, decision) {
  const source = decision?.source
  if (source && stats.bySource[source] !== undefined) stats.bySource[source] += 1
  else stats.bySource.default += 1
}

/** 读取文件头，避免把扩展名伪装成文本的二进制文件送进 FTS/embedding。 */
function looksBinary(abs) {
  let fd
  try {
    fd = fs.openSync(abs, 'r')
    const buf = Buffer.alloc(4096)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
    return false
  } catch {
    return true
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 遍历仓库，返回候选文件及其 mtime/size。
 *
 * 排除规则：
 *  - 内置目录名；
 *  - `opts.excludeDirs`：目录名（任意深度）；
 *  - `opts.excludePaths`：仓库相对路径/前缀；
 *  - `.gitignore` / `.cursorignore` / `.cursorindexingignore`（见 lib/ignore.js）。
 *
 * 被排除的文件不会出现在结果里，因此 `diffFiles` 会把它们判为 `removed` → 旧块自动清理。
 * @returns {{rel: string, abs: string, mtime: number, size: number}[]}
 */
export function walkRepo(root, opts = {}) {
  const include = new Set(opts.include ?? DEFAULT_INCLUDE)
  const excludeDirs = new Set([...DEFAULT_EXCLUDE_DIRS, ...(opts.excludeDirs ?? [])])
  const excludePaths = (opts.excludePaths ?? []).map(normalizeRelPrefix).filter(Boolean)
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const stats = opts.stats ?? newStats()
  const ignoreFiles = opts.ignoreFiles ?? DEFAULT_IGNORE_FILES
  const chain = opts.ignoreChain ?? createIgnoreChain(root, {
    ignoreFiles,
    hierarchicalGitignore: opts.hierarchicalGitignore !== false,
    hierarchicalCursorIgnore: opts.hierarchicalCursorIgnore === true,
  })
  const isExcludedPath = (rel) => excludePaths.some((p) => rel === p || rel.startsWith(p + '/'))
  const out = []
  const stack = [{ dir: root, chain }]
  while (stack.length) {
    const { dir, chain: dirChain } = stack.pop()
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
        if (excludeDirs.has(e.name)) {
          stats.ignoredDirs += 1
          stats.bySource.default += 1
          continue
        }
        if (isExcludedPath(rel)) {
          stats.ignoredDirs += 1
          stats.bySource.exclude += 1
          continue
        }
        const decision = dirChain.test(rel, true)
        if (decision.ignored) {
          stats.ignoredDirs += 1
          bump(stats, decision)
          continue
        }
        const nextChain = opts.hierarchicalGitignore === false && !opts.hierarchicalCursorIgnore
          ? dirChain
          : dirChain.enter(abs, rel, {
              hierarchicalGitignore: opts.hierarchicalGitignore !== false,
              hierarchicalCursorIgnore: opts.hierarchicalCursorIgnore === true,
            })
        stack.push({ dir: abs, chain: nextChain })
        continue
      }
      if (!e.isFile()) continue
      if (isExcludedPath(rel)) {
        stats.ignored += 1
        stats.bySource.exclude += 1
        continue
      }
      const decision = dirChain.test(rel, false)
      if (decision.ignored) {
        stats.ignored += 1
        bump(stats, decision)
        continue
      }
      const ext = path.extname(e.name).toLowerCase()
      if (!include.has(ext)) continue
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (st.size === 0 || st.size > maxBytes) {
        stats.sizeSkipped += 1
        continue
      }
      if (opts.binarySniff !== false && looksBinary(abs)) {
        stats.binarySkipped += 1
        continue
      }
      out.push({ rel, abs, mtime: Math.floor(st.mtimeMs), size: st.size })
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  // 保留数组契约；统计作为不可枚举属性，避免旧调用方把 stats 当文件。
  Object.defineProperty(out, 'scanStats', { value: stats, enumerable: false })
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
