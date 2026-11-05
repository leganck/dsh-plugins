/**
 * 已索引仓库注册表：让 DSH 重启后还能恢复 `sync.watch` 监听。
 *
 * 只记录“这个仓库已经建过索引”，不记录 API Key/块内容；文件放在
 * `<DSH_HOME>/code-index/repos.json`，与 `_loaded.json` 同目录。
 */
import fs from 'node:fs'
import path from 'node:path'

const VERSION = 1
const MAX_REPOS = 200

function norm(p) {
  return path.resolve(String(p ?? ''))
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, file)
  } catch {
    // Windows 上 rename 覆盖已存在文件可能失败；退化为“删了再换”，够用且不丢旧文件。
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
    fs.renameSync(tmp, file)
  }
}

export class RepoRegistry {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'repos.json')
    this.repos = new Map()
    this.load()
  }

  load() {
    this.repos.clear()
    let data
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return this
    }
    if (!data || data.version !== VERSION || typeof data.repos !== 'object') return this
    for (const [key, value] of Object.entries(data.repos)) {
      if (!key || !value || typeof value !== 'object') continue
      const root = norm(key)
      this.repos.set(root, {
        root,
        dbPath: typeof value.dbPath === 'string' ? value.dbPath : null,
        lastIndexedAt: Number(value.lastIndexedAt) || 0,
        lastSyncAt: Number(value.lastSyncAt) || 0,
        watch: value.watch !== false,
      })
    }
    this.prune()
    return this
  }

  save() {
    const repos = Object.fromEntries(
      [...this.repos.values()]
        .sort((a, b) => b.lastIndexedAt - a.lastIndexedAt)
        .slice(0, MAX_REPOS)
        .map((r) => [r.root, { dbPath: r.dbPath, lastIndexedAt: r.lastIndexedAt, lastSyncAt: r.lastSyncAt, watch: r.watch }]),
    )
    atomicWrite(this.file, JSON.stringify({ version: VERSION, repos }, null, 2))
  }

  prune() {
    let changed = false
    for (const [root, value] of [...this.repos]) {
      if (!fs.existsSync(root)) {
        this.repos.delete(root)
        changed = true
        continue
      }
      if (value.dbPath && !fs.existsSync(value.dbPath)) {
        // 索引库被删了：保留“曾索引”的记录没意义，watch 会一直空转。
        this.repos.delete(root)
        changed = true
      }
    }
    if (changed) this.save()
    return [...this.repos.values()]
  }

  list() {
    return [...this.repos.values()]
  }

  get(root) {
    return this.repos.get(norm(root)) ?? null
  }

  upsert(root, patch = {}) {
    const key = norm(root)
    const old = this.repos.get(key) ?? { root: key, dbPath: null, lastIndexedAt: 0, lastSyncAt: 0, watch: true }
    this.repos.set(key, { ...old, ...patch, root: key })
    // 超出上限时淘汰最久未建库的，但保留刚写入的。
    if (this.repos.size > MAX_REPOS) {
      const doomed = [...this.repos.values()]
        .filter((r) => r.root !== key)
        .sort((a, b) => a.lastIndexedAt - b.lastIndexedAt)
        .slice(0, this.repos.size - MAX_REPOS)
      for (const r of doomed) this.repos.delete(r.root)
    }
    this.save()
    return this.repos.get(key)
  }

  remove(root) {
    const changed = this.repos.delete(norm(root))
    if (changed) this.save()
    return changed
  }
}

/**
 * 删除"git 顶层已在注册表里"的子目录条目。
 *
 * 为什么需要：同一仓库被"仓库根"和"子目录"各注册一次时，两者共用 (repoId, kind, ref)、
 * 只有 chunkFp 不同 → 服务端出现两行同名作用域（2026-11-05 实际出现过）。
 * 子目录内容本来就被根索引覆盖，保留条目只会制造重复。
 * @param {RepoRegistry} registry
 * @param {(root: string) => string} toplevelOf 返回 git 顶层（非 git 返回 ''）
 * @returns {string[]} 被删除的 root
 */
export function pruneNestedRepos(registry, toplevelOf) {
  const entries = registry.list()
  if (entries.length < 2) return []
  const byRoot = new Map(entries.map((r) => [path.resolve(r.root), r]))
  const drop = []
  for (const r of entries) {
    const top = toplevelOf(r.root)
    if (!top) continue
    const absTop = path.resolve(top)
    if (absTop === path.resolve(r.root)) continue
    if (byRoot.has(absTop)) drop.push(r.root)
  }
  for (const root of drop) registry.remove(root)
  return drop
}
