/**
 * 仓库身份（血统 repoId）：决定"同一项目"的边界。
 *
 * 为什么需要它：向量按内容哈希存储，**复用本身与仓库身份无关**（fork / vendor 也命中）；
 * 身份只回答"这次查询在哪些块上做 kNN"，以及"GC 时哪些块还有引用"。
 * 实测：无关项目间块重合 0.00%，同项目跨分支 ~98% —— 所以命名空间按项目分、存储按内容去重。
 *
 * 归一化规则必须与服务端 `index_store.normalize_url()` **逐条一致**：
 * 两边算不出同一个 id，同一仓库在两台机器上就成了两个血统（各存一份向量）。
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** 归一化 git remote URL：去凭证、统一 ssh/https、小写 host、去 .git 与尾斜杠 */
export function normalizeRemoteUrl(url) {
  if (!url) return ''
  let s = String(url).trim()
  if (!s) return ''
  if (s.includes('://') && s.includes('@')) s = s.split('@').pop()
  if (s.startsWith('ssh://')) s = s.slice('ssh://'.length)
  else if (s.startsWith('git@')) s = s.slice('git@'.length).replace(':', '/')
  else if (s.startsWith('ssh:')) s = s.slice('ssh:'.length).replace(/^\/+/, '')
  else if (s.includes('://')) s = s.split('://')[1]
  if (s.includes('@')) s = s.split('@').pop()
  s = s.replace(/\/+$/, '')
  if (s.endsWith('.git')) s = s.slice(0, -4)
  const slash = s.indexOf('/')
  return slash === -1 ? s.toLowerCase() : s.slice(0, slash).toLowerCase() + '/' + s.slice(slash + 1).replace(/^\/+|\/+$/g, '')
}

/** 读 git origin URL；不是 git 仓库（或没有 origin）时返回 '' */
export function gitOriginUrl(repoRoot) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return String(out).trim()
  } catch {
    return ''
  }
}

/**
 * 血统标识：默认 = sha1(归一化 origin URL) 前 12 位（同一仓库的不同克隆/机器算出同一个值）；
 * 无 git 时用绝对路径哈希（仅本机血统）。
 */
/** 当前分支：{name, detached}；不是 git 仓库时 {name: '', detached: false}。 */
export function gitBranch(repoRoot) {
  const git = (args) =>
    execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  try {
    const name = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (name && name !== 'HEAD') return { name, detached: false }
    const sha = git(['rev-parse', '--short', 'HEAD'])
    return { name: sha, detached: true }
  } catch {
    return { name: '', detached: false }
  }
}

export function repoIdOf(repoRoot, override = null) {
  if (override) return override
  const url = normalizeRemoteUrl(gitOriginUrl(repoRoot))
  const seed = url || `local:${path.resolve(repoRoot)}`
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12)
}
