/**
 * 「触及式」仓库识别：从工具调用参数里抽路径，向上找到 git 仓库根。
 *
 * 用途：一个会话可能跨多个仓库（ERP/POS/CRM），不能只按会话 cwd 建索引。
 * 这里把「这次调用碰到的路径」翻译成「需要索引的仓库根」。
 *
 * worktree 特判：`.git` 是文件时读 `gitdir:`，指向
 * `<主仓>/.git/worktrees/<name>` 的算 worktree，返回**主仓**根，
 * 避免每个 worktree 都建一份索引（会显著放大存储，也会制造重复作用域）。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_UP = 15
const CACHE_LIMIT = 512
const PATH_KEYS = new Set([
  'path', 'file_path', 'filePath', 'filepath', 'cwd', 'dir', 'directory',
  'root', 'repo', 'workdir', 'workdirpath', 'target', 'source',
])

/** 看起来像绝对路径（Windows 盘符 / UNC / POSIX）。 */
export function looksLikePath(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  const s = value.trim()
  if (/^[A-Za-z]:[\\/]/.test(s)) return true
  if (/^\\\\[^\\]+\\/.test(s)) return true
  if (s.startsWith('/') && s.length > 1) return true
  return false
}

/** 从一段字符串里抠出路径片段（用于 shell 命令里的 `git -C X`、`cd X`）。 */
export function pathsInText(text) {
  if (typeof text !== 'string' || !text) return []
  const out = []
  const re = /(?:[A-Za-z]:[\\/][^\s"'`;|&<>]*)|(?:\\\\[^\s"'`;|&<>]+)/g
  let m
  while ((m = re.exec(text))) out.push(m[0])
  return out
}

/** 递归抽取参数里的候选路径。 */
export function extractPaths(value, out = [], depth = 0) {
  if (value == null || depth > 4) return out
  if (typeof value === 'string') {
    if (looksLikePath(value)) out.push(value.trim())
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) extractPaths(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') {
        if (PATH_KEYS.has(k.toLowerCase())) {
          if (looksLikePath(v)) out.push(v.trim())
        } else {
          for (const p of pathsInText(v)) out.push(p)
        }
      } else {
        extractPaths(v, out, depth + 1)
      }
    }
  }
  return out
}

function readGitFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const m = /^gitdir:\s*(.+)$/m.exec(text)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/**
 * 从任意目录向上找 git 仓库根；worktree 归并到主仓。
 * @param {string} startDir
 * @param {{cache?: Map<string, object|null>, maxUp?: number}} [options]
 * @returns {{root: string, worktree: boolean, checkout: string, mainRoot: string} | null}
 */
export function resolveRepoRoot(startDir, options = {}) {
  const cache = options.cache
  const maxUp = options.maxUp ?? MAX_UP
  let input = String(startDir)
  // MSYS 风格 /d/Code/x → D:/Code/x（Windows 上 path.resolve 会把它当成盘符下的 d 目录）
  const msys = /^\/([A-Za-z])\/(.*)$/.exec(input)
  if (msys) input = `${msys[1].toUpperCase()}:/${msys[2]}`
  let dir
  try {
    dir = path.resolve(input)
  } catch {
    return null
  }
  // 文件路径先退到所在目录
  try {
    if (fs.statSync(dir).isFile()) dir = path.dirname(dir)
  } catch {
    /* 不存在：继续按目录处理，向上找仍然可能命中 */
  }
  const cacheKey = dir.toLowerCase()
  if (cache?.has(cacheKey)) return cache.get(cacheKey)

  let cursor = dir
  for (let i = 0; i <= maxUp; i += 1) {
    const dot = path.join(cursor, '.git')
    let stat = null
    try {
      stat = fs.statSync(dot)
    } catch {
      /* 继续向上 */
    }
    if (stat) {
      let result
      if (stat.isDirectory()) {
        result = { root: cursor, worktree: false, checkout: cursor, mainRoot: cursor }
      } else {
        const gitdir = readGitFile(dot)
        const normalized = gitdir ? gitdir.replace(/\\/g, '/') : ''
        const wt = /\/\.git\/worktrees\/[^/]+$/i.test(normalized)
        if (wt) {
          const mainRoot = normalized.slice(0, normalized.indexOf('/.git/worktrees/'))
          result = { root: mainRoot, worktree: true, checkout: cursor, mainRoot }
        } else {
          // submodule 或其它形式：仓库根就是当前目录
          result = { root: cursor, worktree: false, checkout: cursor, mainRoot: cursor }
        }
      }
      result.root = path.resolve(result.root)
      if (cache) {
        cache.set(cacheKey, result)
        if (cache.size > CACHE_LIMIT) {
          const first = cache.keys().next().value
          if (first !== undefined) cache.delete(first)
        }
      }
      return result
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (cache) cache.set(cacheKey, null)
  return null
}

/** 把一批路径翻译成去重后的仓库根（worktree 已归并到主仓）。 */
export function reposFromPaths(paths, { cache } = {}) {
  const seen = new Map()
  for (const p of paths ?? []) {
    const resolved = resolveRepoRoot(p, { cache })
    if (!resolved) continue
    seen.set(resolved.root.toLowerCase(), resolved)
  }
  return [...seen.values()]
}
