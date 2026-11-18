/**
 * 自动建库队列：把「哪个仓库需要首次建索引」排队串行执行。
 *
 * 设计目标是 Cursor 那种「打开就建、无感可用」：
 * - 并发 1，避免和对话抢 IO；
 * - 同一仓库只排一次；
 * - 会话启动可延迟（delayMs），触及式（lazy/touch）立即可排；
 * - 每会话最多自动建 maxPerSession 个，防止一次跨仓会话把十几个仓全建了；
 * - 失败按指数退避重试，最终失败只记录不阻塞。
 *
 * 不负责「怎么建」——建库动作由调用方注入（index(root)），本模块只管排队与节流。
 */

export const AUTO_INDEX_DEFAULTS = {
  enabled: true,
  delayMs: 8000,
  maxFiles: 20000,
  maxPerSession: 3,
  attempts: 3,
  retryBackoffMs: 5000,
  concurrency: 1,
}

/**
 * @param {object} deps
 * @param {(root: string) => Promise<unknown>} deps.index 实际建库动作
 * @param {(root: string) => boolean} [deps.isIndexed] 已有索引则跳过
 * @param {(root: string) => number} [deps.countFiles] 超限保护（返回文件数，未知返回 0）
 * @param {object} [deps.config] 覆盖 AUTO_INDEX_DEFAULTS
 * @param {(msg: string) => void} [deps.logger]
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => unknown} [deps.schedule]
 * @param {(timer: unknown) => void} [deps.clearSchedule]
 */
export function createAutoIndexQueue(deps) {
  const cfg = { ...AUTO_INDEX_DEFAULTS, ...(deps.config ?? {}) }
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const clearSchedule = deps.clearSchedule ?? ((t) => clearTimeout(t))
  const logger = deps.logger ?? (() => {})
  const isIndexed = deps.isIndexed ?? (() => false)
  const countFiles = deps.countFiles ?? (() => 0)

  /** @type {Map<string, any>} */
  const entries = new Map()
  const perSession = new Map()
  const finished = []
  let running = 0
  let disposed = false
  let current = null

  function normalize(root) { return String(root ?? '') }
  function key(root) { return normalize(root).toLowerCase() }

  function sessionCount(sessionId) {
    if (!sessionId) return 0
    return perSession.get(sessionId) ?? 0
  }

  function enqueue(root, { reason = 'touch', sessionId = null, priority = 2, force = false } = {}) {
    const abs = normalize(root)
    if (!abs || disposed) return { accepted: false, why: 'invalid' }
    if (!cfg.enabled) return { accepted: false, why: 'disabled' }
    const k = key(abs)
    if (entries.has(k)) return { accepted: false, why: 'queued' }
    if (!force && isIndexed(abs)) return { accepted: false, why: 'indexed' }
    if (sessionId && sessionCount(sessionId) >= cfg.maxPerSession && !force) {
      return { accepted: false, why: 'session-limit' }
    }
    const files = Number(countFiles(abs)) || 0
    if (!force && files > cfg.maxFiles) return { accepted: false, why: 'too-large', files }

    const entry = {
      root: abs,
      reason,
      sessionId,
      priority,
      attempts: 0,
      timer: null,
      createdAt: now(),
    }
    entries.set(k, entry)
    if (sessionId) perSession.set(sessionId, sessionCount(sessionId) + 1)

    const wait = priority <= 1 ? 0 : cfg.delayMs
    if (wait > 0) {
      entry.timer = schedule(() => {
        entry.timer = null
        void pump()
      }, wait)
      entry.timer?.unref?.()
    } else {
      void pump()
    }
    return { accepted: true, reason }
  }

  async function pump() {
    if (disposed || running >= cfg.concurrency) return
    const next = [...entries.values()]
      .filter((e) => !e.timer)
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)[0]
    if (!next) return
    entries.delete(key(next.root))
    running += 1
    current = next.root
    try {
      await deps.index(next.root)
      finished.push({ root: next.root, ok: true, at: now(), reason: next.reason })
    } catch (error) {
      next.attempts += 1
      const message = String(error?.message ?? error)
      logger(`自动建库失败 ${next.root}（第 ${next.attempts} 次）：${message}`)
      if (next.attempts < cfg.attempts) {
        next.priority = 0
        next.createdAt = now()
        entries.set(key(next.root), next)
        next.timer = schedule(() => {
          next.timer = null
          void pump()
        }, cfg.retryBackoffMs * 2 ** (next.attempts - 1))
        next.timer?.unref?.()
      } else {
        finished.push({ root: next.root, ok: false, at: now(), error: message })
      }
    } finally {
      running -= 1
      current = null
      if (finished.length > 50) finished.splice(0, finished.length - 50)
    }
    void pump()
  }

  function stats() {
    const list = [...entries.values()]
    return {
      enabled: cfg.enabled,
      queued: list.length,
      running,
      current,
      pending: list.map((e) => ({ root: e.root, reason: e.reason, waiting: Boolean(e.timer) })),
      recent: finished.slice(-10),
    }
  }

  function dispose() {
    disposed = true
    for (const entry of entries.values()) {
      if (entry.timer) clearSchedule(entry.timer)
    }
    entries.clear()
  }

  return { enqueue, stats, dispose, config: cfg }
}
