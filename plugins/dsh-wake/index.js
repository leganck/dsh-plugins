/**
 * dsh-wake — 后台脚本打出一行标记后唤醒发起会话。
 *
 * Agent 调 wake_run 后可以结束本轮。脚本必须由本插件启动；stdout 命中正则时，
 * 用 sessionController.prompt({ mode: 'queue' }) 把这一行投进发起会话。
 */
import crypto from 'node:crypto'
import path from 'node:path'

export const name = 'dsh-wake'
export const inject = ['tools', 'subprocess', 'sessionController']

export const DEFAULT_PATTERN = '^DSH_WAKE:[ \\t]*(.*)$'
export const MAX_RUNS_PER_SESSION = 8
export const COALESCE_MS = 1000
export const POLL_MS = 200
export const MESSAGE_LIMIT = 16 * 1024
export const STDERR_TAIL = 4 * 1024
export const GRACE_MS = 5000
export const COLLECT_BYTES = 1024 * 1024

const CONTINUE = '请按这段消息继续；不要在本轮里 sleep 等待。'

export function apply(ctx) {
  const host = createWakeHost({
    spawn: (spec) => spawnScript(ctx, spec),
    prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
    resolveCwd: (requested, sessionId) => resolveCwd(ctx, requested, sessionId),
  })
  ctx.effect(() => {
    const disposeTools = registerTools(ctx, host)
    return () => {
      host.dispose()
      disposeTools()
    }
  }, 'dsh-wake')
}

export function compilePattern(source) {
  const text = source === undefined || source === null || source === '' ? DEFAULT_PATTERN : String(source)
  try {
    return { pattern: text, re: new RegExp(text) }
  } catch (error) {
    throw new Error(`无效正则：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 有捕获组用第一个捕获；没有就用整行。未命中返回 null。 */
export function matchLine(re, line) {
  re.lastIndex = 0
  const found = re.exec(line)
  if (!found) return null
  return found.length > 1 && found[1] !== undefined ? found[1] : found[0]
}

export function buildWakeText(label, body) {
  return clipBytes(`监控触发：${label}\n\n${body}\n\n${CONTINUE}`, MESSAGE_LIMIT)
}

export function clipBytes(text, max) {
  const value = String(text ?? '')
  const buf = Buffer.from(value)
  if (buf.length <= max) return value
  let end = max
  while (end > 0 && (buf[end] & 0b11000000) === 0b10000000) end -= 1
  return `${buf.subarray(0, end).toString('utf8')}…`
}

/** 去掉终端转义、回车覆盖和退格，只留脚本实际打印的文本。 */
export function stripTerminalControls(text) {
  let value = String(text ?? '')
  value = value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
  value = value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
  value = value.replace(/\u001b[()][0-9A-Za-z]/g, '')
  value = value.replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f]/g, '')
  const lines = value.split('\n')
  return lines.map((line) => {
    let out = ''
    for (const char of line) {
      if (char === '\r') out = ''
      else if (char === '\b') out = out.slice(0, -1)
      else out += char
    }
    return out
  }).join('\n')
}

export function tailBytes(text, max) {
  const value = String(text ?? '')
  const buf = Buffer.from(value)
  if (buf.length <= max) return value
  let start = buf.length - max
  while (start < buf.length && (buf[start] & 0b11000000) === 0b10000000) start += 1
  return buf.subarray(start).toString('utf8')
}

/**
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn
 * @param {(request: object, signal: AbortSignal) => Promise<unknown>} deps.prompt
 * @param {(requested: string | undefined, sessionId: string) => string} [deps.resolveCwd]
 * @param {() => number} [deps.now]
 * @param {(fn: () => void | Promise<void>, ms: number) => unknown} [deps.schedule]
 * @param {(timer: unknown) => void} [deps.clearSchedule]
 */
export function createWakeHost(deps) {
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const clearSchedule = deps.clearSchedule ?? ((timer) => clearTimeout(timer))
  const resolveDirectory = deps.resolveCwd ?? (() => process.cwd())
  /** @type {Map<string, any>} */
  const runs = new Map()

  function runningCount(sessionId) {
    let count = 0
    for (const run of runs.values()) {
      if (run.sessionId === sessionId && run.status === 'running') count += 1
    }
    return count
  }

  function start(input) {
    const sessionId = String(input?.sessionId ?? '').trim()
    if (!sessionId) throw new Error('无法确定发起会话')
    const argv = normalizeArgv(input?.argv)
    const { re } = compilePattern(input?.pattern)
    if (runningCount(sessionId) >= MAX_RUNS_PER_SESSION) {
      throw new Error(`同一会话同时最多 ${MAX_RUNS_PER_SESSION} 个后台脚本`)
    }
    const cwd = resolveDirectory(input?.cwd, sessionId)
    if (!path.isAbsolute(cwd)) throw new Error('cwd 必须是绝对路径')
    const label = String(input?.label ?? '').trim() || path.basename(argv[0])
    const abort = new AbortController()
    const handle = deps.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: COLLECT_BYTES },
        stderr: { maxBytes: COLLECT_BYTES },
      },
      graceMs: GRACE_MS,
      signal: abort.signal,
    })
    const id = `wake_${Math.floor(now()).toString(36)}_${crypto.randomBytes(3).toString('hex')}`
    let finish = () => {}
    const finished = new Promise((resolve) => {
      finish = resolve
    })
    const run = {
      id,
      sessionId,
      argv,
      cwd,
      label,
      re,
      handle,
      abort,
      status: 'running',
      startedAt: new Date(now()).toISOString(),
      stdoutOffset: 0,
      stderrOffset: 0,
      stdoutBuffer: '',
      stderrText: '',
      wakeCount: 0,
      matched: false,
      lastMatch: '',
      lastError: '',
      exitCode: null,
      signal: null,
      stopped: false,
      closed: false,
      pendingText: null,
      coalesceTimer: null,
      pollTimer: null,
      finished,
      _finish: finish,
    }
    runs.set(id, run)
    armPoll(run)
    handle.done.then(
      (outcome) => settle(run, outcome),
      (error) => settle(run, { exitCode: null, signal: null, error }),
    )
    return publicRun(run)
  }

  function armPoll(run) {
    if (run.closed || run.pollTimer) return
    run.pollTimer = schedule(() => {
      run.pollTimer = null
      poll(run)
    }, POLL_MS)
  }

  function poll(run) {
    if (run.closed) return
    readStream(run, 'stdout')
    readStream(run, 'stderr')
    armPoll(run)
  }

  function readStream(run, which) {
    const reader = run.handle?.collected?.[which]
    if (!reader || typeof reader.readFrom !== 'function') return
    const offsetKey = which === 'stdout' ? 'stdoutOffset' : 'stderrOffset'
    const read = reader.readFrom(run[offsetKey])
    const text = String(read?.text ?? '')
    run[offsetKey] = Number(read?.nextOffset ?? run[offsetKey] + text.length)
    if (!text) return
    if (which === 'stderr') {
      run.stderrText = tailBytes(run.stderrText + text, STDERR_TAIL)
      return
    }
    run.stdoutBuffer += stripTerminalControls(text)
    const parts = run.stdoutBuffer.split(/\r?\n/)
    run.stdoutBuffer = parts.pop() ?? ''
    for (const line of parts) onLine(run, line)
  }

  function onLine(run, line) {
    const text = matchLine(run.re, line)
    if (text === null || run.stopped || run.closed) return
    run.pendingText = text
    if (run.coalesceTimer) return
    run.coalesceTimer = schedule(() => {
      run.coalesceTimer = null
      const pending = run.pendingText
      run.pendingText = null
      if (pending === null || run.stopped) return
      deliver(run, buildWakeText(run.label, pending), pending)
    }, COALESCE_MS)
  }

  async function deliver(run, text, match) {
    const request = {
      requestId: `${run.id}-${run.wakeCount + 1}`,
      sessionId: run.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }
    try {
      await deps.prompt(request, AbortSignal.timeout(20_000))
      run.wakeCount += 1
      if (match !== undefined) {
        run.matched = true
        run.lastMatch = match
      }
      run.lastError = ''
    } catch (error) {
      run.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  async function settle(run, outcome) {
    if (run.closed) return
    if (run.pollTimer) clearSchedule(run.pollTimer)
    run.pollTimer = null
    // 先读完已经到达的输出。closed 置位后 onLine 会丢掉标记行。
    readStream(run, 'stdout')
    readStream(run, 'stderr')
    flushPartial(run)
    run.closed = true
    if (run.coalesceTimer) {
      clearSchedule(run.coalesceTimer)
      run.coalesceTimer = null
    }
    run.exitCode = outcome?.exitCode ?? null
    run.signal = outcome?.signal ?? null
    if (outcome?.error) run.lastError = String(outcome.error?.message ?? outcome.error)
    if (!run.stopped) {
      if (run.pendingText !== null) {
        const pending = run.pendingText
        run.pendingText = null
        await deliver(run, buildWakeText(run.label, pending), pending)
      }
      const cleanExit = run.exitCode === 0 || (run.exitCode === null && !run.signal && !outcome?.error)
      if (cleanExit) {
        if (!run.matched) {
          await deliver(run, buildWakeText(run.label, '脚本已结束，没有打出唤醒行。'))
        }
      } else {
        const reason = run.exitCode === null
          ? `脚本已退出，信号 ${run.signal || '未知'}。`
          : `脚本已退出，退出码 ${run.exitCode}。`
        const stderr = run.stderrText.trim()
        const body = stderr ? `${reason}\n${stderr}` : reason
        await deliver(run, buildWakeText(run.label, body))
      }
    }
    run.status = run.stopped ? 'stopped' : 'exited'
    run._finish(publicRun(run))
  }

  function flushPartial(run) {
    if (!run.stdoutBuffer) return
    const line = run.stdoutBuffer
    run.stdoutBuffer = ''
    onLine(run, line)
  }

  function stop(input) {
    const sessionId = String(input?.sessionId ?? '').trim()
    const runId = String(input?.runId ?? '').trim()
    const targets = []
    for (const run of runs.values()) {
      if (sessionId && run.sessionId !== sessionId) continue
      if (runId && run.id !== runId) continue
      if (run.status !== 'running') continue
      targets.push(run)
    }
    if (runId && targets.length === 0) throw new Error(`没有进行中的任务：${runId}`)
    for (const run of targets) stopRun(run)
    return targets.map((run) => run.id)
  }

  function stopRun(run) {
    run.stopped = true
    run.pendingText = null
    if (run.coalesceTimer) clearSchedule(run.coalesceTimer)
    run.coalesceTimer = null
    try {
      run.abort.abort()
    } catch {
      /* 已经取消 */
    }
    try {
      run.handle?.terminate?.()
    } catch (error) {
      run.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  function status(input) {
    const sessionId = String(input?.sessionId ?? '').trim()
    const runId = String(input?.runId ?? '').trim()
    const items = []
    for (const run of runs.values()) {
      if (sessionId && run.sessionId !== sessionId) continue
      if (runId && run.id !== runId) continue
      items.push(publicRun(run))
    }
    if (runId && items.length === 0) throw new Error(`没有找到任务：${runId}`)
    return items
  }

  function dispose() {
    for (const run of runs.values()) {
      if (run.status === 'running') stopRun(run)
    }
  }

  return {
    start,
    stop,
    status,
    dispose,
    /** 测试用：立刻读一次已经到点的输出，不等轮询。 */
    poll(id) {
      const run = runs.get(id)
      if (!run) throw new Error(`没有找到任务：${id}`)
      poll(run)
    },
  }
}

function publicRun(run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    argv: [...run.argv],
    cwd: run.cwd,
    label: run.label,
    startedAt: run.startedAt,
    wakeCount: run.wakeCount,
    lastMatch: run.lastMatch,
    lastError: run.lastError,
    exitCode: run.exitCode,
    signal: run.signal,
    finished: run.finished,
  }
}

function normalizeArgv(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('argv 不能为空')
  const argv = value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error('argv 的每一项都必须是非空字符串')
    return item
  })
  return argv
}

/**
 * 优先用终端启动。管道在 Windows 上会缓冲整段输出，进程退出前读不到唤醒行。
 * 没有 spawnTerminal 时退回管道，测试用的 spawn 不受影响。
 */
function spawnScript(ctx, spec) {
  const subprocess = ctx.subprocess
  if (typeof subprocess.spawnTerminal !== 'function') return subprocess.spawn(spec)
  let terminal
  const ready = subprocess.spawnTerminal({
    argv: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    rows: 24,
    cols: 120,
    terminalType: 'dumb',
    graceMs: spec.graceMs,
    signal: spec.signal,
  }).then((handle) => {
    terminal = handle
  })
  const chunks = []
  let offset = 0
  ready.then(() => {
    terminal.output.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    })
  }).catch(() => {})
  return {
    collected: {
      stdout: {
        readFrom(from) {
          const all = Buffer.concat(chunks)
          const start = Math.max(0, from)
          const text = all.subarray(start).toString('utf8')
          offset = all.length
          return { text, nextOffset: offset }
        },
      },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0 }) },
    },
    done: ready.then(() => terminal.done),
    terminate() {
      ready.then(() => terminal?.terminate()).catch(() => {})
    },
  }
}

function resolveCwd(ctx, requested, sessionId) {
  if (requested !== undefined && requested !== null && String(requested).trim()) {
    const cwd = String(requested)
    if (!path.isAbsolute(cwd)) throw new Error('cwd 必须是绝对路径')
    return cwd
  }
  const directories = ctx.get?.('workingDirectory')
  const sessions = ctx.get?.('sessions')
  if (directories && sessions && typeof directories.get === 'function' && typeof sessions.get === 'function') {
    const session = sessions.get(sessionId)
    if (session) {
      const cwd = directories.get(session)
      if (typeof cwd === 'string' && cwd) return cwd
    }
  }
  return process.cwd()
}

function registerTools(ctx, host) {
  const disposers = []
  const register = (definition) => {
    const dispose = ctx.tools.register(definition)
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  const sessionIdOf = (exec) => {
    const id = exec?.agent?.id
    if (!id) throw new Error('只能在 Agent 会话里调用')
    return String(id)
  }

  register({
    name: 'wake_run',
    description:
      '后台跑一个脚本。stdout 打出匹配行（默认 DSH_WAKE: 后面的文本）时，把这一行投进当前会话并唤醒 Agent。立刻返回，不等脚本结束；调完可以结束本轮。脚本必须由本工具启动。',
    parameters: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: '可执行文件和参数，不经过 shell。例如 ["node", "watch.mjs"]',
        },
        cwd: { type: 'string', description: '工作目录，必须是绝对路径；省略则用当前会话工作目录' },
        pattern: {
          type: 'string',
          description: '可选正则。默认 ^DSH_WAKE:[ \\t]*(.*)$。有捕获组时用第一个捕获作为消息',
        },
        label: { type: 'string', description: '唤醒消息里的任务名' },
      },
      required: ['argv'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderResult },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const run = host.start({
        sessionId: sessionIdOf(exec),
        argv: input.argv,
        cwd: input.cwd,
        pattern: input.pattern,
        label: input.label,
      })
      return { summary: `已后台启动 ${run.label} (${run.id})`, run: withoutFinished(run) }
    },
  })

  register({
    name: 'wake_status',
    description: '查看当前会话的后台脚本：状态、已唤醒次数、最近匹配、退出码和最后一次投递错误。',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '任务 ID；不传则列出当前会话全部任务' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          runs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                status: { type: 'string' },
                wakeCount: { type: 'number' },
                exitCode: { description: '退出码；进程还没退出或终端路径拿不到时省略' },
                lastMatch: { type: 'string' },
                lastError: { type: 'string' },
              },
              required: ['id', 'status', 'wakeCount', 'lastMatch', 'lastError'],
            },
          },
        },
        required: ['runs'],
      },
      render: renderResult,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const runs = host.status({ sessionId: sessionIdOf(exec), runId: args?.runId }).map(withoutFinished)
      const summary = runs.length
        ? runs.map((run) => {
            const exit = run.exitCode === null ? ' 无退出码' : ` 退出码 ${run.exitCode}`
            const signal = run.signal ? ` 信号 ${run.signal}` : ''
            const match = run.lastMatch ? ` 最近匹配：${run.lastMatch}` : ' 无匹配'
            const error = run.lastError ? ` 错误：${run.lastError}` : ''
            return `${run.id} ${run.status} 已唤醒 ${run.wakeCount} 次${exit}${signal}${match}${error}`
          }).join('\n')
        : '当前会话没有后台脚本'
      return { summary, runs }
    },
  })

  register({
    name: 'wake_stop',
    description: '终止一个或当前会话全部后台脚本。只终止，不唤醒会话。',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '任务 ID；不传则终止当前会话全部进行中的任务' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderResult },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const stopped = host.stop({ sessionId: sessionIdOf(exec), runId: args?.runId })
      return { summary: `已终止 ${stopped.length} 个后台脚本`, stopped }
    },
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 释放失败不影响其余工具 */
      }
    }
  }
}

function withoutFinished(run) {
  const { finished, ...rest } = run
  return rest
}

function renderResult(_args, value) {
  if (value && typeof value.summary === 'string') return [{ type: 'text', text: value.summary }]
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}
