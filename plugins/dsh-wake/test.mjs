import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COALESCE_MS,
  POLL_MS,
  buildWakeText,
  compilePattern,
  createWakeHost,
  matchLine,
  stripTerminalControls,
} from './index.js'

function fakeClock() {
  let current = 1_000_000
  /** @type {Array<{ id: number, at: number, fn: () => unknown }>} */
  const timers = []
  let nextId = 1
  return {
    now: () => current,
    schedule(fn, ms) {
      const id = nextId++
      timers.push({ id, at: current + ms, fn })
      return id
    },
    clearSchedule(id) {
      const index = timers.findIndex((item) => item.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    async advance(ms) {
      current += ms
      const due = timers.filter((item) => item.at <= current).sort((a, b) => a.at - b.at)
      for (const item of due) {
        const index = timers.indexOf(item)
        if (index < 0) continue
        timers.splice(index, 1)
        await item.fn()
      }
    },
  }
}

function fakeProcess() {
  let done
  const finished = new Promise((resolve) => {
    done = resolve
  })
  const streams = {
    stdout: { text: '', offset: 0 },
    stderr: { text: '', offset: 0 },
  }
  return {
    terminated: false,
    done: finished,
    collected: {
      stdout: reader('stdout'),
      stderr: reader('stderr'),
    },
    terminate() {
      this.terminated = true
    },
    push(which, text) {
      streams[which].text += text
    },
    exit(outcome) {
      done(outcome)
    },
  }

  function reader(which) {
    return {
      readFrom(from) {
        const text = streams[which].text.slice(from - streams[which].offset)
        const next = from + text.length
        streams[which].text = ''
        streams[which].offset = next
        return { text, nextOffset: next }
      },
    }
  }
}

function harness(options = {}) {
  const clock = fakeClock()
  const spawned = []
  const prompts = []
  const host = createWakeHost({
    spawn(spec) {
      const proc = fakeProcess()
      spawned.push({ spec, proc })
      return proc
    },
    async prompt(request) {
      prompts.push(request)
      if (options.failPrompt) throw new Error('session gone')
    },
    resolveCwd: (requested) => requested || 'D:\\work',
    now: clock.now,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
  })
  return { clock, spawned, prompts, host }
}

async function drain(clock) {
  await clock.advance(POLL_MS)
  await clock.advance(COALESCE_MS)
}

test('终端控制符不会拆开唤醒行', () => {
  const cleaned = stripTerminalControls('\u001b[32mDSH_WAKE: 已合并\u001b[0m\r\n')
  const { re } = compilePattern()
  assert.equal(matchLine(re, cleaned.trim()), '已合并')
})

test('默认正则取 DSH_WAKE 后面的文本', () => {
  const { re } = compilePattern()
  assert.equal(matchLine(re, 'DSH_WAKE: 已合并'), '已合并')
  assert.equal(matchLine(re, 'noise'), null)
})

test('非法正则不启动进程', () => {
  const { spawned, host } = harness()
  assert.throws(
    () => host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'], pattern: '(' }),
    /无效正则/,
  )
  assert.equal(spawned.length, 0)
})

test('空 argv 不启动进程', () => {
  const { spawned, host } = harness()
  assert.throws(() => host.start({ sessionId: 'session-a', argv: [] }), /argv 不能为空/)
  assert.equal(spawned.length, 0)
})

test('没有标记行不投递', async () => {
  const { clock, spawned, prompts, host } = harness()
  host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'] })
  spawned[0].proc.push('stdout', 'still waiting\n')
  await drain(clock)
  assert.equal(prompts.length, 0)
})

test('DSH_WAKE 投递捕获文本、会话和 queue', async () => {
  const { clock, spawned, prompts, host } = harness()
  const run = host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'], label: '等合并' })
  spawned[0].proc.push('stdout', 'noise\nDSH_WAKE: 3 个 MR 已合并\n')
  await drain(clock)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'session-a')
  assert.equal(prompts[0].mode, 'queue')
  assert.deepEqual(prompts[0].content, [{
    type: 'text',
    text: buildWakeText('等合并', '3 个 MR 已合并'),
  }])
  assert.equal(host.status({ sessionId: 'session-a', runId: run.id })[0].wakeCount, 1)
})

test('1 秒内多行只投递最后一行', async () => {
  const { clock, spawned, prompts, host } = harness()
  host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'] })
  spawned[0].proc.push('stdout', 'DSH_WAKE: 第一条\nDSH_WAKE: 第二条\n')
  await drain(clock)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, /第二条/)
  assert.doesNotMatch(prompts[0].content[0].text, /第一条/)
})

test('stderr 不触发', async () => {
  const { clock, spawned, prompts, host } = harness()
  host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'] })
  spawned[0].proc.push('stderr', 'DSH_WAKE: 不该唤醒\n')
  await drain(clock)
  assert.equal(prompts.length, 0)
})

test('非 0 退出唤醒一次并带 stderr', async () => {
  const { clock, spawned, prompts, host } = harness()
  const run = host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'] })
  spawned[0].proc.push('stderr', 'boom\n')
  await clock.advance(POLL_MS)
  spawned[0].proc.exit({ exitCode: 2, signal: null })
  await run.finished
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, /退出码 2/)
  assert.match(prompts[0].content[0].text, /boom/)
})

test('退出时还没轮询到的标记行也算命中', async () => {
  const { spawned, prompts, host } = harness()
  const run = host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'], label: '等合并' })
  spawned[0].proc.push('stdout', 'DSH_WAKE: 已经合并\n')
  spawned[0].proc.exit({ exitCode: 0, signal: null })
  await run.finished
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, /已经合并/)
  assert.doesNotMatch(prompts[0].content[0].text, /没有打出唤醒行/)
})

test('终端正常退出没有退出码时，匹配过就不再补发', async () => {
  const { spawned, prompts, host } = harness()
  const run = host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'], label: '自检' })
  spawned[0].proc.push('stdout', 'DSH_WAKE: 已合并\n')
  spawned[0].proc.exit({ exitCode: null, signal: null })
  await run.finished
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, /已合并/)
  assert.doesNotMatch(prompts[0].content[0].text, /信号/)
})

test('0 退出且没有标记行也唤醒一次', async () => {
  const { spawned, prompts, host } = harness()
  const run = host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'] })
  spawned[0].proc.exit({ exitCode: 0, signal: null })
  await run.finished
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, /没有打出唤醒行/)
})

test('wake_stop 终止进程且不再投递', async () => {
  const { clock, spawned, prompts, host } = harness()
  const run = host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'] })
  host.stop({ sessionId: 'session-a', runId: run.id })
  assert.equal(spawned[0].proc.terminated, true)
  spawned[0].proc.push('stdout', 'DSH_WAKE: 太晚了\n')
  spawned[0].proc.exit({ exitCode: null, signal: 'SIGTERM' })
  await run.finished
  await clock.advance(POLL_MS + COALESCE_MS)
  assert.equal(prompts.length, 0)
  assert.equal(host.status({ runId: run.id })[0].status, 'stopped')
})

test('同一会话超过 8 个进行中任务时拒绝', () => {
  const { spawned, host } = harness()
  for (let index = 0; index < 8; index += 1) {
    host.start({ sessionId: 'session-a', argv: ['node', `watch-${index}.mjs`] })
  }
  assert.throws(
    () => host.start({ sessionId: 'session-a', argv: ['node', 'watch-extra.mjs'] }),
    /最多 8/,
  )
  assert.equal(spawned.length, 8)
})

test('投递失败记在状态里，不改投别的会话', async () => {
  const { clock, spawned, prompts, host } = harness({ failPrompt: true })
  const run = host.start({ sessionId: 'session-a', argv: ['node', 'watch.mjs'] })
  spawned[0].proc.push('stdout', 'DSH_WAKE: 失败\n')
  await drain(clock)
  assert.equal(prompts[0].sessionId, 'session-a')
  assert.match(host.status({ runId: run.id })[0].lastError, /session gone/)
})

