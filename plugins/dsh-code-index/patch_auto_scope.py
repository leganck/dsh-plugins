#!/usr/bin/env python3
"""一次性补丁：remote.scope: "auto" —— 按当前 git 分支自动推导作用域（0.11.3）。"""
import io

# ---------------- lib/repo.js ----------------
p = "lib/repo.js"
s = io.open(p, encoding="utf-8", newline="").read().replace("\r\n", "\n")
add = '''
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
'''
anchor = "/** 血统标识：默认 = sha1(归一化 origin URL) 前 12 位"
assert anchor in s
s = s.replace(anchor, add + "\n" + anchor, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s.replace("\n", "\r\n"))
print("patched lib/repo.js")

# ---------------- index.js ----------------
p = "index.js"
s = io.open(p, encoding="utf-8", newline="").read().replace("\r\n", "\n")

old_imp = "import { normalizeRemoteUrl, gitOriginUrl, repoIdOf } from './lib/repo.js'"
new_imp = "import { normalizeRemoteUrl, gitOriginUrl, repoIdOf, gitBranch } from './lib/repo.js'"
assert old_imp in s
s = s.replace(old_imp, new_imp, 1)

old_val = """  if (cfg.remote.scope !== null) {
    if (typeof cfg.remote.scope !== 'object' || Array.isArray(cfg.remote.scope)) {
      throw new ConfigError(`config.remote.scope 必须是对象（{kind, ref, ttlDays}）或 null，收到 ${Array.isArray(cfg.remote.scope) ? 'array' : typeof cfg.remote.scope}`)
    }"""
new_val = """  if (cfg.remote.scope === 'auto') {
    // 自动作用域：按当前 git 分支推导（main/master → #main:default，其余 → #branch:<name>）。
    // 这样不同分支各自一个快照，不需要每个 checkout 手写 scope.ref。
  } else if (cfg.remote.scope !== null) {
    if (typeof cfg.remote.scope !== 'object' || Array.isArray(cfg.remote.scope)) {
      throw new ConfigError(`config.remote.scope 必须是对象（{kind, ref, ttlDays}）、字符串 "auto" 或 null，收到 ${Array.isArray(cfg.remote.scope) ? 'array' : typeof cfg.remote.scope}`)
    }"""
assert old_val in s
s = s.replace(old_val, new_val, 1)

old_resolve = """  const resolveNamespace = (repoRoot, chunkFp) => {
    if (config.remote.namespace) return config.remote.namespace
    const repoId = repoIdOf(repoRoot, config.remote.repoId)
    const scope = config.remote.scope
    if (scope) return canonicalNamespace(repoId, chunkFp, scope.kind, scope.ref)
    return `${repoId}@${chunkFp}`
  }"""
new_resolve = """  /** `remote.scope: "auto"`：按当前 git 分支推导；无 git 时返回 null（退回 legacy 命名空间） */
  const autoScopeFor = (repoRoot) => {
    const b = gitBranch(repoRoot)
    if (!b.name) return null
    if (!b.detached && (b.name === 'main' || b.name === 'master')) return { kind: 'main', ref: 'default' }
    return { kind: 'branch', ref: b.name }
  }
  const effectiveScopeFor = (repoRoot) =>
    config.remote.scope === 'auto' ? autoScopeFor(repoRoot) : config.remote.scope
  const resolveNamespace = (repoRoot, chunkFp) => {
    if (config.remote.namespace) return config.remote.namespace
    const repoId = repoIdOf(repoRoot, config.remote.repoId)
    const scope = effectiveScopeFor(repoRoot)
    if (scope) return canonicalNamespace(repoId, chunkFp, scope.kind, scope.ref)
    return `${repoId}@${chunkFp}`
  }"""
assert old_resolve in s
s = s.replace(old_resolve, new_resolve, 1)

old_info = """  const scopeInfoFor = (repoRoot, store) => {
    const namespace = namespaceFor(repoRoot, store)
    return {
      namespace,
      namespaces: namespacesFor(namespace),
      scope: config.remote.scope ? { ...config.remote.scope } : null,
      readScopes: [...config.remote.readScopes],
      source: config.remote.namespace ? 'namespace' : config.remote.scope ? 'scope' : 'legacy',
    }
  }"""
new_info = """  const scopeInfoFor = (repoRoot, store) => {
    const namespace = namespaceFor(repoRoot, store)
    const scope = effectiveScopeFor(repoRoot)
    return {
      namespace,
      namespaces: namespacesFor(namespace),
      scope: scope ? { ...scope } : null,
      readScopes: [...config.remote.readScopes],
      source: config.remote.namespace
        ? 'namespace'
        : config.remote.scope === 'auto'
          ? 'auto'
          : scope
            ? 'scope'
            : 'legacy',
    }
  }"""
assert old_info in s
s = s.replace(old_info, new_info, 1)

old_build = "                scope: config.remote.namespace ? null : config.remote.scope,"
new_build = "                scope: config.remote.namespace ? null : effectiveScopeFor(repoRoot),"
assert old_build in s
s = s.replace(old_build, new_build, 1)

old_desc = "    config.vectors === 'remote' && config.remote.scope\n      ? `，scope=${describeScope(config.remote.scope)}${config.remote.scope.ttlDays ? `(TTL ${config.remote.scope.ttlDays}d)` : ''}`"
new_desc = "    config.vectors === 'remote' && config.remote.scope && config.remote.scope !== 'auto'\n      ? `，scope=${describeScope(config.remote.scope)}${config.remote.scope.ttlDays ? `(TTL ${config.remote.scope.ttlDays}d)` : ''}`"
assert old_desc in s
s = s.replace(old_desc, new_desc, 1)

io.open(p, "w", encoding="utf-8", newline="").write(s.replace("\n", "\r\n"))
print("patched index.js")

# ---------------- package.json ----------------
p = "package.json"
s = io.open(p, encoding="utf-8", newline="").read()
s = s.replace('"version": "0.11.2"', '"version": "0.11.3"', 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("bumped -> 0.11.3")
