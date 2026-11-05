/**
 * 仓库身份（血统 repoId）：决定"同一项目"的边界。
 *
 * 为什么需要它：向量按内容哈希存储，**复用本身与仓库身份无关**（fork / vendor 也命中）；
 * 身份只回答"这次查询在哪些块上做 kNN"，以及"GC 时哪些块还有引用"。
 * 实测：无关项目间块重合 0.00%，同项目跨分支 ~98% —— 所以命名空间按项目分、存储按内容去重。
 *
 * 归一化规则必须与服务端 `index_store.normalize_url()` **逐条一致**：
 * 两边算不出同一个 id，同一仓库在两台机器上就成了两个血统（各存一份向量）。
 *
 * 身份来源优先级（0.14.1）：
 *   1. 显式配置 `remote.repoId`（人工兜底，优先级最高）
 *   2. `git` CLI 读 `remote.origin.url`
 *   3. **直接解析 `.git/config`**（git 二进制不在 PATH / 写入受限时的兜底；支持 worktree 的
 *      `.git` 文件 + `commondir` 间接寻址）
 *   4. 以上都拿不到 → 回退 `sha1(绝对路径)`（本机血统，**跨机器无法共享**，必须告警）
 *
 * 历史教训：旧实现只有 1~2 步，且第 2 步失败时**静默**回退到路径哈希，导致同一仓库在不同目录 /
 * 不同机器上算出不同 repoId → 服务端出现"同一仓库多个血统"，内容重复存储。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
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

/** 读 git origin URL（git CLI）；不是 git 仓库（或没有 origin）时返回 '' */
export function gitOriginUrl(repoRoot) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const url = String(out).trim()
    if (url) return url
  } catch {
    // 继续走 .git/config 直读兜底
  }
  return originUrlFromGitConfig(repoRoot)
}

/**
 * 定位可读的 git config：
 *   - 普通仓库：`<root>/.git/config`
 *   - worktree / submodule：`<root>/.git` 是文本文件 `gitdir: <path>`；
 *     worktree 的 gitdir 下没有 config，需要再读 `commondir` → `<common>/config`
 * 返回 null 表示不是 git 仓库。
 */
function gitConfigPath(repoRoot) {
  const dotGit = path.join(repoRoot, '.git')
  let st
  try {
    st = fs.statSync(dotGit)
  } catch {
    return null
  }
  if (st.isDirectory()) {
    const p = path.join(dotGit, 'config')
    return fs.existsSync(p) ? p : null
  }
  if (!st.isFile()) return null
  let txt
  try {
    txt = fs.readFileSync(dotGit, 'utf8')
  } catch {
    return null
  }
  const m = txt.match(/^gitdir:\s*(.+)$/m)
  if (!m) return null
  const gitdir = path.resolve(repoRoot, m[1].trim())
  const direct = path.join(gitdir, 'config')
  if (fs.existsSync(direct)) return direct
  try {
    const common = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()
    if (common) {
      const p = path.join(path.resolve(gitdir, common), 'config')
      if (fs.existsSync(p)) return p
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 不依赖 git 二进制，直接解析 `.git/config` 里的 `[remote "origin"] url`。
 * 拿到空串说明：不是 git 仓库 / 没有 origin / 配置不可读。
 */
export function originUrlFromGitConfig(repoRoot) {
  const cfg = gitConfigPath(repoRoot)
  if (!cfg) return ''
  let txt
  try {
    txt = fs.readFileSync(cfg, 'utf8')
  } catch {
    return ''
  }
  let inOrigin = false
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) {
      const name = sec[1].trim().replace(/\s+/g, ' ').toLowerCase()
      inOrigin = name === 'remote "origin"'
      continue
    }
    if (!inOrigin) continue
    const kv = line.match(/^([A-Za-z][\w.-]*)\s*=\s*(.*)$/)
    if (kv && kv[1].toLowerCase() === 'url' && kv[2]) return kv[2].trim()
  }
  return ''
}

/** 当前分支：{name, detached}；不是 git 仓库时 {name: '', detached: false}。 */
export function gitBranch(repoRoot) {
  const git = (args) =>
    execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
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

function sha1_12(seed) {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12)
}

/**
 * 解析仓库身份，并显式告知来源，供调用方告警/拒绝。
 * 返回 {repoId, url, normalizedUrl, source: 'override' | 'git' | 'config' | 'path'}
 *   - url 保留原始（写进 sync payload，服务端自己归一化）
 *   - normalizedUrl 是归一化结果（repoId 的哈希输入）
 *   - source='path' 表示**没有可用的远端身份**，repoId 只在本机有效
 */
export function repoIdentity(repoRoot, override = null) {
  const root = path.resolve(repoRoot)
  const rawFromGit = (() => {
    try {
      const out = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return String(out).trim()
    } catch {
      return ''
    }
  })()
  const fromConfig = rawFromGit ? '' : originUrlFromGitConfig(repoRoot)
  const rawUrl = rawFromGit || fromConfig
  const normalizedUrl = normalizeRemoteUrl(rawUrl)

  if (override) {
    return { repoId: override, url: rawUrl, normalizedUrl, source: 'override' }
  }
  if (normalizedUrl) {
    return {
      repoId: sha1_12(normalizedUrl),
      url: rawUrl,
      normalizedUrl,
      source: rawFromGit ? 'git' : 'config',
    }
  }
  return { repoId: sha1_12(`local:${root}`), url: '', normalizedUrl: '', source: 'path' }
}

/** 血统标识：默认 = sha1(归一化 origin URL) 前 12 位（同一仓库的不同克隆/机器算出同一个值）。 */
export function repoIdOf(repoRoot, override = null) {
  return repoIdentity(repoRoot, override).repoId
}
