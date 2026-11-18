/**
 * 自动建库队列自测：去重、会话配额、延迟、失败重试、已索引跳过。
 */
import { createAutoIndexQueue } from './lib/auto-index.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

function fakeClock() {
  let current = 1_000_000
  const timers = []
  let nextId = 1
  return {
    now: () => current,
    schedule(fn, ms) {
      const id = nextId++
      timers.push({ id, at: current + ms, fn })
      return { unref() {}, id }
    },
    clearSchedule(t) {
      const index = timers.findIndex((x) => x.id === t?.id)
      if (index >= 0) timers.splice(index, 1)
    },
    async advance(ms) {
      current += ms
      const due = timers.filter((t) => t.at <= current).sort((a, b) => a.at - b.at)
      for (const t of due) {
        const i = timers.indexOf(t)
        if (i < 0) continue
        timers.splice(i, 1)
        t.fn()
      }
      await flush()
    },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

const clock = fakeClock()
const indexed = new Set()
const calls = []
let failNext = 0
const queue = createAutoIndexQueue({
  config: { maxPerSession: 2, delayMs: 5000, attempts: 2, retryBackoffMs: 100 },
  isIndexed: (root) => indexed.has(root),
  index: async (root) => {
    calls.push(root)
    if (failNext > 0) {
      failNext -= 1
      throw new Error('boom')
    }
    indexed.add(root)
  },
  now: clock.now,
  schedule: clock.schedule,
  clearSchedule: clock.clearSchedule,
})

console.log('\n[1] 触及式（priority 1）立即执行')
const r1 = queue.enqueue('D:/repo/a', { reason: 'touch', sessionId: 's1', priority: 1 })
check('入队成功', r1.accepted === true, JSON.stringify(r1))
await flush()
check('立即建库', calls.includes('D:/repo/a'), JSON.stringify(calls))

console.log('\n[2] 已建过的仓库跳过 / 重复入队去重')
check('已索引跳过', queue.enqueue('D:/repo/a', { reason: 'touch' }).why === 'indexed')
queue.enqueue('D:/repo/b', { reason: 'touch', priority: 2 })
check('重复入队去重', queue.enqueue('D:/repo/b', { reason: 'touch', priority: 2 }).why === 'queued')

console.log('\n[3] 会话配额')
const c1 = queue.enqueue('D:/repo/c', { reason: 'touch', sessionId: 's3', priority: 0 })
const c2 = queue.enqueue('D:/repo/d', { reason: 'touch', sessionId: 's3', priority: 0 })
const c3 = queue.enqueue('D:/repo/f', { reason: 'touch', sessionId: 's3', priority: 0 })
check('配额内前两个接受', c1.accepted && c2.accepted, JSON.stringify([c1, c2]))
check('超过 maxPerSession 拒绝', c3.why === 'session-limit', JSON.stringify(c3))

console.log('\n[4] 延迟（priority 2）')
await clock.advance(1000)
check('延迟窗口内未执行 b', !calls.includes('D:/repo/b'))
await clock.advance(5000)
check('延迟到点后执行 b', calls.includes('D:/repo/b'))

console.log('\n[5] 失败重试')
failNext = 1
queue.enqueue('D:/repo/e', { reason: 'touch', priority: 0 })
await flush()
check('第一次失败后重排', queue.stats().queued >= 1 || calls.filter((c) => c === 'D:/repo/e').length === 1)
await clock.advance(200)
check('重试后成功建库', indexed.has('D:/repo/e'), JSON.stringify(calls))

console.log('\n[6] 关闭后不再接受')
const off = createAutoIndexQueue({ config: { enabled: false }, index: async () => {} })
check('enabled=false 拒绝', off.enqueue('D:/repo/z').why === 'disabled')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
