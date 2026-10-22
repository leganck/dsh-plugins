/**
 * 自动同步调度器 + 跨进程锁。
 *
 * 只负责“什么时候跑”，不负责索引内容：`onRun` 由 index.js 注入，
 * 通常就是一次 `code_index` 增量刷新。
 */
import fs from 'node:fs'
import path from 'node:path'

const IGNORE_EVENT = /(^|\/)(\.git|node_modules|dist|target|build|\.dsh-index|__pycache__)(\/|$)/

function lockPathFor(dbPath) {
  return dbPath ? `${dbPath}.auto-sync.lock` : null
}

function readLock(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * 尝试获取仓库级锁。返回 `{ok, release, reason}`；锁已存在且未过期时 ok=false。
 * 只用于“自动同步/手动刷新”的互斥，不是安全边界。
 */
export function acquireRepoLock(dbPath, { ttlMs = 900000, pid = process.pid } = {}) {
  const file = lockPathFor(dbPath)
  if (!file) return { ok: true, release: () => {} }
  const now = Date.now()
  const existing = readLock(file)
  if (existing) {
    const age = now - (Number(existing.heartbeatAt) || Number(existing.startedAt) || 0)
    if (age < ttlMs) {
      return { ok: false, reason: `仓库正在被另一个进程同步（pid ${existing.pid ?? '?'}）` }
    }
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
  } else {
    // 上次进程崩在写 JSON 的中间态：无法解析的锁按过期处理，否则会永久卡住自动同步。
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ pid, startedAt: now, heartbeatAt: now }), { flag: 'wx' })
  } catch (e) {
    return { ok: false, reason: `无法创建同步锁：${e?.message ?? e}` }
  }
  let heartbeat = null
  const touch = () => {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, startedAt: now, heartbeatAt: Date.now() }), 'utf8')
    } catch {
      /* ignore */
    }
  }
  heartbeat = setInterval(touch, Math.max(5000, Math.floor(ttlMs / 4)))
  heartbeat.unref?.()
  const release = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    try {
      const cur = readLock(file)
      if (!cur || Number(cur.pid) === Number(pid)) fs.rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
  }
  return { ok: true, release, file }
}

/**
 * 单个仓库的自动同步调度。一个实例对应一个仓库；index.js 用 Map 管理。
 */
export class AutoSyncEntry {
  constructor({
    repoRoot,
    debounceMs = 5000,
    maxDelayMs = 30000,
    onRun,
    logger = () => {},
    watchFactory = (root, opts, cb) => fs.watch(root, opts, cb),
  }) {
    this.repoRoot = repoRoot
    this.debounceMs = Math.max(1000, Number(debounceMs) || 5000)
    this.maxDelayMs = Math.max(this.debounceMs, Number(maxDelayMs) || 30000)
    this.onRun = onRun
    this.logger = logger
    this.watchFactory = watchFactory
    this.watcher = null
    this.timer = null
    this.running = false
    this.dirty = false
    this.firstDirtyAt = 0
    this.lastEventAt = 0
    this.lastSyncAt = 0
    this.lastError = null
    this.failures = 0
    this.stopped = false
  }

  start() {
    if (this.watcher || this.stopped) return this
    try {
      this.watcher = this.watchFactory(this.repoRoot, { recursive: true }, (_evt, filename) => {
        if (!filename) return
        const rel = String(filename).replace(/\\/g, '/')
        if (IGNORE_EVENT.test(rel)) return
        this.noteEvent()
      })
      // 监听本身不应阻止 Node/DSH 进程退出；DSH 卸载时仍由 stop() 显式关闭。
      this.watcher.unref?.()
      this.watcher.on?.('error', (e) => {
        this.lastError = String(e?.message ?? e)
        this.logger(`watcher 出错：${this.lastError}`)
      })
    } catch (e) {
      this.lastError = String(e?.message ?? e)
      this.logger(`无法监听 ${this.repoRoot}：${this.lastError}`)
    }
    return this
  }

  noteEvent() {
    if (this.stopped) return
    this.dirty = true
    this.lastEventAt = Date.now()
    if (!this.firstDirtyAt) this.firstDirtyAt = this.lastEventAt
    this.schedule()
  }

  schedule(delay) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const elapsed = Date.now() - this.firstDirtyAt
    const remaining = Math.max(0, this.maxDelayMs - elapsed)
    const wait = delay ?? Math.min(this.debounceMs, remaining)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, wait)
    this.timer.unref?.()
  }

  async tick() {
    if (this.stopped) return
    if (this.running) {
      this.dirty = true
      return
    }
    if (!this.dirty) return
    this.running = true
    this.dirty = false
    this.firstDirtyAt = 0
    try {
      await this.onRun()
      this.lastSyncAt = Date.now()
      this.lastError = null
      this.failures = 0
    } catch (e) {
      this.lastError = String(e?.message ?? e).slice(0, 200)
      this.failures += 1
      this.dirty = true
      const delay = Math.min(60000, 5000 * 2 ** Math.min(3, this.failures - 1))
      this.logger(`自动同步失败（${this.failures}）：${this.lastError}`)
      this.running = false
      this.schedule(delay)
      return
    } finally {
      this.running = false
    }
    if (this.dirty) this.schedule()
  }

  state() {
    return {
      repoRoot: this.repoRoot,
      watching: Boolean(this.watcher),
      running: this.running,
      dirty: this.dirty,
      lastEventAt: this.lastEventAt || null,
      lastSyncAt: this.lastSyncAt || null,
      lastError: this.lastError,
    }
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      this.watcher?.close()
    } catch {
      /* ignore */
    }
    this.watcher = null
  }
}
