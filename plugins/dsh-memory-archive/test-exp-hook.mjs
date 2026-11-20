/**
 * dsh-memory-archive × 经验抽取（exp v2）接线的行为测试。
 *
 * 用法：node test-exp-hook.mjs
 *
 * 分两层：
 *   A. **单元**：直接驱动 `exp-hook.mjs`，注入假 fetch —— 配置归一 / workflow slug /
 *      200KB 截断 / prompt 的三镜头·九类垃圾·五类 category / client 模式 /
 *      失败计数与退避，全部确定性、不碰网络。
 *   B. **集成**：假 Cordis ctx + 真 HTTP stub 走 `writeSegment()` 的完整路径 ——
 *      断言「落盘后触发一次 POST，字段齐全」，以及**最重要的一条**：抽取端点
 *      超时 / 500 / 连接被拒绝时，`writeSegment` 仍然成功、落盘内容与没开 exp 时
 *      逐字节一致（时间戳归一后），指针也照发。
 *
 * 为什么不用 `node --test`：本机沙箱里 node:test 的 worker 会 EPERM，仓库里其它插件
 * 的自测一律是这种 `node test-xxx.mjs` 的直跑脚本。
 */
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 触发器的 `fire()` 在 `writeSegment` 的同步路径上，这里先证明它绝不 throw；
// 任何一个用例抛异常都会让整套静默失真，所以顶层的 fire 调用都包了 try/catch。
process.env.DSH_MEMORY_ARCHIVE_MARKER = join(
  mkdtempSync(join(tmpdir(), 'dsh-exp-marker-')),
  '_loaded.json',
)

const hook = await import('./exp-hook.mjs')
const {
  EXP_DEFAULTS,
  EXP_PROMPT_VERSION,
  MAX_CONSECUTIVE_FAILURES,
  PROMPT_CATEGORIES,
  PROMPT_GARBAGE,
  PROMPT_LENSES,
  PROMPT_REJECTED_CATEGORY,
  buildExtractPayload,
  buildPrompt,
  chatEndpoint,
  createExperienceTrigger,
  expEndpoint,
  normalizeExpConfig,
  parseCandidates,
  parseCandidatesReport,
  truncateUtf8,
  workflowSlug,
} = hook
const { apply } = await import(pathToFileURL(join(import.meta.dirname, 'index.js')).href)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const next = async () => ({ kind: 'enter', messages: [] })

/** 轮询到条件成立（异步写盘/网络收尾没有回调可用，只能观测副作用）。 */
async function waitFor(predicate, { timeout = 5000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(interval)
  }
  return false
}

const readOrEmpty = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
/** 归档里有 `Written` 时间戳；比对"内容是否一致"时必须先归一它。 */
const normalizeTimestamps = (text) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<ts>')
/** 不一致时给出第一处差异，避免只看到一条 FAIL 却无从下手。 */
function diffHint(left, right) {
  const a = String(left ?? '').split('\n')
  const b = String(right ?? '').split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return `line ${i}: ${JSON.stringify(a[i])} != ${JSON.stringify(b[i])}`
  }
  return `equal-lines-but-bytes: ${String(left).length} vs ${String(right).length}`
}
const sameText = (left, right) => String(left) === String(right)

// ================================================================ A. 单元
// --- 配置：默认值就是 schema --------------------------------------------
check(
  '默认关闭，且默认走服务端抽取（exp.enabled=false / mode=server / apply=false）',
  EXP_DEFAULTS.enabled === false &&
    EXP_DEFAULTS.mode === 'server' &&
    EXP_DEFAULTS.apply === false &&
    EXP_DEFAULTS.timeoutMs === 15000 &&
    EXP_DEFAULTS.minSegmentBytes === 2000 &&
    EXP_DEFAULTS.maxVerbatimBytes === 200 * 1024,
)

{
  const config = normalizeExpConfig({ enabled: 'true', timeoutMs: '250' })
  check(
    '配置归一：字符串布尔/数字吃得下，没写的键保留默认（嵌套块不被浅合并吃掉）',
    config.enabled === true &&
      config.timeoutMs === 250 &&
      config.minSegmentBytes === 2000 &&
      config.maxVerbatimBytes === 204800 &&
      config.mode === 'server',
    JSON.stringify(config),
  )
  check(
    '配置归一：mode 只认 client，其它值一律回落 server；url 去掉尾斜杠',
    normalizeExpConfig({ mode: 'weird', url: 'http://h:8000/' }).mode === 'server' &&
      normalizeExpConfig({ url: 'http://h:8000//' }).url === 'http://h:8000' &&
      normalizeExpConfig({ mode: 'CLIENT' }).mode === 'client',
  )
}

// --- workflow slug --------------------------------------------------------
check('workflow slug：空格转 - 并小写（erp bug → erp-bug）', workflowSlug('erp bug') === 'erp-bug', workflowSlug('erp bug'))
check(
  'workflow slug：全角标点/斜杠也当分隔符，CJK 原样保留',
  workflowSlug('ERP Bug：订单/退款') === 'erp-bug-订单-退款',
  workflowSlug('ERP Bug：订单/退款'),
)
check(
  'workflow slug：标题推不出东西时退回 cwd 的 basename（兼容 Windows 分隔符）',
  workflowSlug('  ：  ', 'D:\\Code\\my-project\\') === 'my-project',
  workflowSlug('  ：  ', 'D:\\Code\\my-project\\'),
)
check('workflow slug：连续分隔符折叠、首尾不留 -', workflowSlug('  a   b  c ') === 'a-b-c', workflowSlug('  a   b  c '))
check('workflow slug：没有标题也没有 cwd 时给空串，不编造 workflow', workflowSlug('', '') === '', workflowSlug('', ''))

// --- 端点 ----------------------------------------------------------------
check('端点：base 不带 /v1 时补 /v1（契约是 ${exp.url}/v1/exp/extract）', expEndpoint('http://h:8000', 'extract') === 'http://h:8000/v1/exp/extract')
check(
  '端点：base 已带 /v1 时不叠成 /v1/v1，import 路径正确',
  expEndpoint('http://h:8000/v1/', 'import') === 'http://h:8000/v1/exp/import' &&
    expEndpoint('http://h:8000/v1', 'extract') === 'http://h:8000/v1/exp/extract',
)
check(
  '端点：llmUrl 的根地址 / .../v1 / 完整端点三种写法都归一到 /chat/completions',
  chatEndpoint('http://127.0.0.1:3425') === 'http://127.0.0.1:3425/v1/chat/completions' &&
    chatEndpoint('http://127.0.0.1:3425/v1') === 'http://127.0.0.1:3425/v1/chat/completions' &&
    chatEndpoint('http://127.0.0.1:3425/v1/chat/completions') === 'http://127.0.0.1:3425/v1/chat/completions',
)

// --- 请求体 ---------------------------------------------------------------
{
  const built = buildExtractPayload({
    sessionId: 's1',
    segmentNo: 7,
    workflow: 'erp-bug',
    summary: '  ## Primary Request  ',
    verbatim: '  ### seq 1 -- Human\n修一下  ',
    apply: false,
  })
  check(
    '请求体字段与契约同名且齐全（session_id/segment_no/workflow/summary/verbatim/apply）',
    JSON.stringify(Object.keys(built.payload).sort()) ===
      JSON.stringify(['apply', 'segment_no', 'session_id', 'summary', 'verbatim', 'workflow']),
    Object.keys(built.payload).join(','),
  )
  check(
    '请求体：segment_no 是数字、summary/verbatim 去掉首尾空白、apply 是布尔',
    built.payload.segment_no === 7 &&
      built.payload.summary === '## Primary Request' &&
      built.payload.verbatim.startsWith('### seq 1 -- Human') &&
      built.payload.apply === false &&
      built.truncated === false,
  )
}

// --- 200KB 截断 -----------------------------------------------------------
{
  const huge = 'x'.repeat(300 * 1024)
  const cut = truncateUtf8(huge, 200 * 1024)
  check(
    '200KB 上限：超长 verbatim 被截断且不超过上限，原文字节数单独记',
    cut.truncated === true && cut.bytes <= 200 * 1024 && cut.originalBytes === 300 * 1024 && cut.text.length === cut.bytes,
    `bytes=${cut.bytes} original=${cut.originalBytes}`,
  )
  const cjk = '行'.repeat(100000) // 300 KB
  const cutCjk = truncateUtf8(cjk, 10 * 1024)
  check(
    '截断不切坏多字节字符（不出现 U+FFFD）',
    cutCjk.truncated === true && !cutCjk.text.includes('\uFFFD') && Buffer.byteLength(cutCjk.text, 'utf8') === cutCjk.bytes,
  )
  const built = buildExtractPayload({
    sessionId: 's',
    segmentNo: 1,
    workflow: 'w',
    summary: '',
    verbatim: huge,
    apply: true,
    maxVerbatimBytes: 4096,
  })
  check(
    'buildExtractPayload 按 maxVerbatimBytes 截断并标记 truncated',
    built.truncated === true && Buffer.byteLength(built.payload.verbatim, 'utf8') <= 4096,
  )
}

// --- prompt：三镜头 + 九类垃圾 + 五类 category -----------------------------
{
  const prompt = buildPrompt('素材正文')
  const lensCodes = PROMPT_LENSES.map(([code]) => code)
  const categoryCodes = PROMPT_CATEGORIES.map(([code]) => code).concat(PROMPT_REJECTED_CATEGORY[0])
  check(
    'prompt 三镜头齐全（jargon / index / logic）',
    lensCodes.join(',') === 'jargon,index,logic' && lensCodes.every((code) => prompt.includes(`\`${code}\``)),
    lensCodes.join(','),
  )
  check(
    'prompt 九类垃圾逐条编号齐全（1..9）',
    PROMPT_GARBAGE.length === 9 &&
      PROMPT_GARBAGE.every(([no, name]) => prompt.includes(`${no} ${name}`)) &&
      PROMPT_GARBAGE.every(([no]) => new RegExp(`^${no} `, 'm').test(prompt)),
    PROMPT_GARBAGE.map(([no]) => no).join(','),
  )
  check(
    'prompt 五类 category 齐全（business/debug/repo/tool + process 拒收）',
    categoryCodes.join(',') === 'business,debug,repo,tool,process' &&
      categoryCodes.every((code) => prompt.includes(`\`${code}\``)) &&
      prompt.includes('不是有效 category') &&
      prompt.includes('拒收'),
    categoryCodes.join(','),
  )
  check(
    'prompt 带可审计三维（reusable_because / exclusions / evidence_quote）且末段是素材',
    ['reusable_because', 'exclusions', 'evidence_quote'].every((key) => prompt.includes(`\`${key}\``)) &&
      prompt.endsWith('素材正文'),
  )
  check('prompt 带版本号常量（便于审计"当时按什么标准抽的"）', EXP_PROMPT_VERSION === 'exp-v2.0-js.1')
}

// --- 解析模型输出 ---------------------------------------------------------
check('解析：裸 JSON 数组可用', parseCandidates('[{"what":"w1","lens":"logic"}]').length === 1)
check(
  '解析：```json 代码块 + 前后解释文字都能剥掉',
  parseCandidates('说明如下：\n```json\n[{"what":"w2","category":"debug"}]\n```\n以上。')[0]?.what === 'w2',
)
check(
  '解析：脏输入返回 []，不抛（client 模式解析失败=没抽到，不该记成故障）',
  parseCandidates('完全不是 JSON').length === 0 &&
    parseCandidates('').length === 0 &&
    parseCandidates('[{"nothing":"x"}]').length === 0 &&
    parseCandidates('{"what":"object-not-array"}').length === 0,
)
{
  const [candidate] = parseCandidates(
    '[{"what":"W","when_expr":"WHEN","why":"WHY","lens":"JARGON","category":"BUSINESS","evidence_issue":"DEMO-1","audit":{"reusable_because":"R","exclusions":"1,2","evidence_quote":"Q"}}]',
  )
  check(
    '解析：候选按服务端契约归一（lens/category 小写、audit 三项齐全）',
    candidate?.lens === 'jargon' &&
      candidate?.category === 'business' &&
      candidate?.when_expr === 'WHEN' &&
      candidate?.audit?.reusable_because === 'R' &&
      candidate?.audit?.evidence_quote === 'Q',
  )
}

{
  const reasons = [
    parseCandidatesReport('[]').reason,
    parseCandidatesReport('完全不是 JSON').reason,
    parseCandidatesReport('[{"what":"x"},]').reason,
    parseCandidatesReport('').reason,
    parseCandidatesReport('[{"what":"x"}]').reason,
  ]
  check(
    "解析报告：区分 `[]`（模型说没有经验）与没给 JSON / 坏 JSON / 空 content",
    reasons.join(',') === 'empty-array,no-array,bad-json,empty-content,ok',
    reasons.join(','),
  )
}

// --- 触发器：假 fetch 注入 ------------------------------------------------
function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const record = {
      url: String(url),
      headers: { ...(init?.headers ?? {}) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    }
    calls.push(record)
    return handler(record, calls.length)
  }
  return { fetchImpl, calls }
}
const okJson = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
const errJson = (status, payload = { error: 'boom' }) => ({ ok: false, status, text: async () => JSON.stringify(payload) })
/** 永远不该被调用时的 fetch。 */
const noFetch = async () => {
  throw new Error('this test must not send any request')
}

// 默认关闭：不抽、不发请求
{
  const { fetchImpl, calls } = fakeFetch(() => okJson({ status: 'done' }))
  const trigger = createExperienceTrigger({ exp: { enabled: false }, fetchImpl })
  const outcome = trigger.fire({ sessionId: 's', verbatim: 'x'.repeat(5000) })
  await trigger.whenIdle()
  check(
    'enabled=false 时 fire 立即返回 disabled，一个请求都不发',
    outcome.started === false && outcome.skipped === 'disabled' && calls.length === 0,
  )
}

// 太短不抽
{
  const trigger = createExperienceTrigger({
    exp: { enabled: true, url: 'http://exp.local', minSegmentBytes: 2000 },
    fetchImpl: noFetch,
  })
  const outcome = trigger.fire({ sessionId: 's', verbatim: '短' })
  await trigger.whenIdle()
  check(
    'verbatim 小于 minSegmentBytes 时不抽（too-small）',
    outcome.started === false && outcome.skipped === 'too-small' && outcome.verbatimBytes < 2000,
  )
}

// 配置不完整：只 warn 一次，不抽
{
  const warns = []
  const trigger = createExperienceTrigger({
    exp: { enabled: true },
    fetchImpl: noFetch,
    logger: { warn: (message) => warns.push(message) },
  })
  trigger.fire({ sessionId: 's', verbatim: 'x'.repeat(3000) })
  trigger.fire({ sessionId: 's2', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    '缺 exp.url 时只 warn 一次、不发请求（配置错误不刷屏）',
    warns.length === 1 && warns[0].includes('exp.url'),
    warns.join(' | '),
  )
}

// 500 连续 3 次 → 本会话退避
{
  const { fetchImpl, calls } = fakeFetch(() => errJson(500))
  const warns = []
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'server', url: 'http://exp.local', minSegmentBytes: 0 },
    fetchImpl,
    logger: { warn: (message) => warns.push(message) },
  })
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
    trigger.fire({ sessionId: 's-backoff', segmentNo: i, verbatim: 'x'.repeat(3000) })
    await trigger.whenIdle()
  }
  const before = calls.length
  const fourth = trigger.fire({ sessionId: 's-backoff', segmentNo: 3, verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    `连续失败 ${MAX_CONSECUTIVE_FAILURES} 次后本会话不再尝试（第 4 次不发请求）`,
    before === 3 && calls.length === 3 && fourth.started === false && fourth.skipped === 'backoff',
    `calls=${calls.length} fourth=${fourth.skipped}`,
  )
  check('退避后仍留一条 warn 说明本会话不再尝试', warns.some((message) => message.includes('不再尝试')))
  check('退避是按 session 的：换一个会话照样抽', (() => {
    const outcome = trigger.fire({ sessionId: 's-other', verbatim: 'x'.repeat(3000) })
    return outcome.started === true
  })())
  await trigger.whenIdle()
  check('换会话后请求总数 +1（共 4 次）', calls.length === 4)
}

// 成功一次就清零（"连续"失败语义）
{
  let shouldFail = true
  const { fetchImpl, calls } = fakeFetch(() =>
    shouldFail ? errJson(500) : okJson({ status: 'done', funnel: { candidates: 1 } }),
  )
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'server', url: 'http://exp.local', minSegmentBytes: 0 },
    fetchImpl,
  })
  trigger.fire({ sessionId: 's-reset', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  trigger.fire({ sessionId: 's-reset', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  const failedTwice = trigger.failuresOf('s-reset')
  shouldFail = false
  trigger.fire({ sessionId: 's-reset', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  shouldFail = true
  trigger.fire({ sessionId: 's-reset', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    '成功一次即清零：失败 2 → 成功 → 再失败只算第 1 次',
    failedTwice === 2 && trigger.failuresOf('s-reset') === 1 && calls.length === 4,
    `twice=${failedTwice} after=${trigger.failuresOf('s-reset')} calls=${calls.length}`,
  )
}

// 200 + skipped 不是失败
{
  const { fetchImpl } = fakeFetch(() => okJson({ status: 'skipped', reason: 'llm-not-configured', funnel: {} }))
  const warns = []
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'server', url: 'http://exp.local', minSegmentBytes: 0 },
    fetchImpl,
    logger: { warn: (message) => warns.push(message) },
  })
  trigger.fire({ sessionId: 's-skip', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  trigger.fire({ sessionId: 's-skip', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    '服务端 200 + status=skipped（未配置 LLM）不算失败、不 warn',
    trigger.failuresOf('s-skip') === 0 && warns.length === 0,
    warns.join(' | '),
  )
}

// 200 + status=failed 算失败
{
  const { fetchImpl } = fakeFetch(() => okJson({ status: 'failed', error: 'pipeline exploded', funnel: {} }))
  const warns = []
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'server', url: 'http://exp.local', minSegmentBytes: 0 },
    fetchImpl,
    logger: { warn: (message) => warns.push(message) },
  })
  trigger.fire({ sessionId: 's-failed', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    '服务端 200 + status=failed 按失败计数（管道异常不该静默）',
    trigger.failuresOf('s-failed') === 1 && warns.some((message) => message.includes('服务端任务失败')),
    warns.join(' | '),
  )
}

// 超时 / 连接拒绝都算失败
{
  const timeoutFetch = async () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  }
  const warns = []
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'server', url: 'http://exp.local', minSegmentBytes: 0 },
    fetchImpl: timeoutFetch,
    logger: { warn: (message) => warns.push(message) },
  })
  trigger.fire({ sessionId: 's-timeout', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    '超时按失败计数，warn 里能看出是超时',
    trigger.failuresOf('s-timeout') === 1 && warns.some((message) => message.includes('请求超时')),
    warns.join(' | '),
  )
}
{
  const refusedFetch = async () => {
    const error = new TypeError('fetch failed')
    error.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' }
    throw error
  }
  const warns = []
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'server', url: 'http://exp.local', minSegmentBytes: 0 },
    fetchImpl: refusedFetch,
    logger: { warn: (message) => warns.push(message) },
  })
  trigger.fire({ sessionId: 's-refused', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    '连接被拒绝按失败计数，warn 带 errno',
    trigger.failuresOf('s-refused') === 1 && warns.some((message) => message.includes('ECONNREFUSED')),
    warns.join(' | '),
  )
}

// verbatim 超上限：截断并 warn
{
  const { fetchImpl, calls } = fakeFetch(() => okJson({ status: 'done', funnel: {} }))
  const warns = []
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'server', url: 'http://exp.local', minSegmentBytes: 0, maxVerbatimBytes: 2048 },
    fetchImpl,
    logger: { warn: (message) => warns.push(message) },
  })
  trigger.fire({ sessionId: 's-cut', verbatim: 'x'.repeat(9000) })
  await trigger.whenIdle()
  check(
    'verbatim 超上限时截断到上限并发 warn',
    calls[0]?.body?.verbatim?.length === 2048 && warns.some((message) => message.includes('截断')),
    `len=${calls[0]?.body?.verbatim?.length}`,
  )
}

// 脏输入不抛（它在 writeSegment 的同步路径上）
{
  const { fetchImpl } = fakeFetch(() => okJson({ status: 'done', funnel: {} }))
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'server', url: 'http://exp.local', minSegmentBytes: 0 },
    fetchImpl,
  })
  let threw = false
  try {
    trigger.fire(null)
    trigger.fire(undefined)
    trigger.fire({ verbatim: 12345 })
  } catch {
    threw = true
  }
  await trigger.whenIdle()
  check('fire 对脏输入不抛（同步路径上不能把归档带崩）', threw === false)
}

// --- client 模式：自己调本机 LLM，只交候选 ---------------------------------
{
  const candidates = [
    {
      what: '上传流水查不到时先比对同机相邻流水的落库分区',
      when_expr: '客户报上传成功但后台查不到流水',
      why: '分区路由错时数据写进其他租户库，只查本租户永远查不到',
      lens: 'logic',
      category: 'debug',
      evidence_issue: 'CHGJ-3943',
      audit: { reusable_because: '把排查起点从本租户库改成跨分区比对', exclusions: '1,2,3,4,6,8', evidence_quote: '三笔上传被路由到 zb1' },
    },
  ]
  const { fetchImpl, calls } = fakeFetch((record) => {
    if (record.url.endsWith('/chat/completions')) {
      return okJson({ choices: [{ message: { content: '```json\n' + JSON.stringify(candidates) + '\n```' } }] })
    }
    return okJson({ job_id: 'job-1', status: 'done', funnel: { candidates: 1, created: 1 } })
  })
  const trigger = createExperienceTrigger({
    exp: {
      enabled: true,
      mode: 'client',
      url: 'http://exp.local',
      key: 'exp-key',
      apply: true,
      minSegmentBytes: 0,
      llmUrl: 'http://127.0.0.1:3425/v1',
      llmKey: 'llm-key',
      llmModel: 'auto/deepseek-v4.1-flash',
    },
    fetchImpl,
  })
  trigger.fire({ sessionId: 's-client', segmentNo: 2, title: 'erp bug', summary: '摘要', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    'client 模式先调本机 LLM（/chat/completions），再 POST /v1/exp/import',
    calls.length === 2 &&
      calls[0].url === 'http://127.0.0.1:3425/v1/chat/completions' &&
      calls[1].url === 'http://exp.local/v1/exp/import',
    calls.map((call) => call.url).join(' → '),
  )
  check(
    'client 模式 import 只交 candidates（带 session_id/segment_no/workflow/apply，不带 summary/verbatim）',
    Array.isArray(calls[1]?.body?.candidates) &&
      calls[1].body.candidates.length === 1 &&
      calls[1].body.candidates[0].what === candidates[0].what &&
      calls[1].body.session_id === 's-client' &&
      calls[1].body.segment_no === 2 &&
      calls[1].body.workflow === 'erp-bug' &&
      calls[1].body.apply === true &&
      !('summary' in calls[1].body) &&
      !('verbatim' in calls[1].body),
    JSON.stringify(Object.keys(calls[1]?.body ?? {})),
  )
  check(
    'client 模式两段请求分别用 exp.llmKey / exp.key 做 Bearer',
    calls[0]?.headers?.authorization === 'Bearer llm-key' && calls[1]?.headers?.authorization === 'Bearer exp-key',
    `${calls[0]?.headers?.authorization} / ${calls[1]?.headers?.authorization}`,
  )
  check(
    'client 模式请求本机 LLM 时带上 model 与整理过的 prompt（含三镜头/九类垃圾/五类 category）',
    calls[0]?.body?.model === 'auto/deepseek-v4.1-flash' &&
      calls[0].body.messages?.[0]?.role === 'user' &&
      ['jargon', 'index', 'logic'].every((code) => calls[0].body.messages[0].content.includes(code)) &&
      ['business', 'debug', 'repo', 'tool', 'process'].every((code) => calls[0].body.messages[0].content.includes(code)) &&
      calls[0].body.messages[0].content.includes('事实性错误'),
  )
  check('client 模式成功后失败计数清零', trigger.failuresOf('s-client') === 0)
}
{
  // LLM 不可达：只 warn，不发 import
  const { fetchImpl, calls } = fakeFetch(() => {
    throw new TypeError('fetch failed')
  })
  const warns = []
  const trigger = createExperienceTrigger({
    exp: {
      enabled: true,
      mode: 'client',
      url: 'http://exp.local',
      minSegmentBytes: 0,
      llmUrl: 'http://127.0.0.1:3425/v1',
      llmModel: 'm',
    },
    fetchImpl,
    logger: { warn: (message) => warns.push(message) },
  })
  trigger.fire({ sessionId: 's-client-down', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    'client 模式 LLM 不可达时只 warn、不发 import，并计一次失败',
    calls.length === 1 && warns.some((message) => message.includes('失败')) && trigger.failuresOf('s-client-down') === 1,
    `calls=${calls.length}`,
  )
}
{
  // 0 候选：不发 import，也不算失败
  const { fetchImpl, calls } = fakeFetch((record) =>
    record.url.endsWith('/chat/completions')
      ? okJson({ choices: [{ message: { content: '[]' } }] })
      : okJson({ status: 'done' }),
  )
  const trigger = createExperienceTrigger({
    exp: {
      enabled: true,
      mode: 'client',
      url: 'http://exp.local',
      minSegmentBytes: 0,
      llmUrl: 'http://127.0.0.1:3425/v1',
      llmModel: 'm',
    },
    fetchImpl,
  })
  trigger.fire({ sessionId: 's-client-empty', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    'client 模式 0 条候选时不发 import，也不算失败',
    calls.length === 1 && trigger.failuresOf('s-client-empty') === 0,
    `calls=${calls.length}`,
  )
}

{
  // 模型输出不是 JSON 数组：只 warn，不发 import，也不算失败
  const { fetchImpl, calls } = fakeFetch((record) =>
    record.url.endsWith('/chat/completions')
      ? okJson({ choices: [{ message: { content: '抱歉，我无法给出 JSON。' }, finish_reason: 'stop' }] })
      : okJson({ status: 'done' }),
  )
  const warns = []
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'client', url: 'http://exp.local', minSegmentBytes: 0, llmUrl: 'http://127.0.0.1:3425/v1', llmModel: 'm' },
    fetchImpl,
    logger: { warn: (message) => warns.push(message) },
  })
  trigger.fire({ sessionId: 's-client-junk', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    'client 模式模型输出不是 JSON 数组时只 warn、不发 import、不计失败',
    calls.length === 1 && trigger.failuresOf('s-client-junk') === 0 && warns.some((message) => message.includes('不是 JSON 数组')),
    warns.join(' | '),
  )
}
{
  // 推理型模型把预算花在 reasoning 上：content 空，要 warn 出 max_tokens 这条可执行的建议
  const { fetchImpl, calls } = fakeFetch((record) =>
    record.url.endsWith('/chat/completions')
      ? okJson({ choices: [{ message: { content: '', reasoning_content: '想'.repeat(500) }, finish_reason: 'length' }] })
      : okJson({ status: 'done' }),
  )
  const warns = []
  const trigger = createExperienceTrigger({
    exp: { enabled: true, mode: 'client', url: 'http://exp.local', minSegmentBytes: 0, llmUrl: 'http://127.0.0.1:3425/v1', llmModel: 'm', llmMaxTokens: 4000 },
    fetchImpl,
    logger: { warn: (message) => warns.push(message) },
  })
  trigger.fire({ sessionId: 's-client-reasoning', verbatim: 'x'.repeat(3000) })
  await trigger.whenIdle()
  check(
    'client 模式 reasoning 吃光预算（content 空）时 warn 出 exp.llmMaxTokens 这条建议',
    calls.length === 1 && trigger.failuresOf('s-client-reasoning') === 0 && warns.some((message) => message.includes('llmMaxTokens')),
    warns.join(' | '),
  )
}

// ================================================================ B. 集成
// 假 Cordis ctx + 真 HTTP stub，走 writeSegment() 的完整路径。
const FIXTURE = [
  ['system/message', { message: { content: [{ type: 'text', text: 'You are DSH.' }] } }, 0],
  ['user/message', { content: [{ type: 'text', text: '分析 bug DEMO-7001：退款接口 refundOverLimit' }] }, 1],
  [
    'assistant/message',
    {
      message: {
        content: [
          { type: 'text', text: '先查工单与日志。' },
          {
            type: 'tool-call',
            id: 'call_e1',
            name: 'grep',
            arguments: JSON.stringify({ pattern: 'refundOverLimit', path: 'D:\\Code\\demo-svc-pay' }),
          },
        ],
      },
    },
    2,
  ],
  [
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'call_e1' },
        toolCallId: 'call_e1',
        content: [{ type: 'text', text: 'DemoRefundServiceImpl.java:88: refundOverLimit' }],
      },
    },
    3,
  ],
  ['assistant/message', { message: { content: [{ type: 'text', text: '阈值在 refund.max-limit，默认 500。' }] } }, 4],
]
const SUMMARY = '## Primary Request and Intent\n- 分析 DEMO-7001 退款超额\n\n## Files and Code\n- DemoRefundServiceImpl.java'

/**
 * 所有集成用例共用**同一个工作目录与会话 id**，每次用例前清掉归档目录。
 *
 * 为什么必须共用：段文件里有 `| Session | <id> |`，INDEX 的关键词又按会话 cwd 推导
 * 噪声词（临时目录名每次都不同）。换目录/换 id 比对就永远不相等，那样"落盘内容与未开
 * exp 时一致"这条最关键的断言会退化成自欺。
 */
const SHARED_WORKDIR = mkdtempSync(join(tmpdir(), 'dsh-exp-shared-'))
const SHARED_SESSION_ID = 'session-exp-1'

function newArchive(expConfig) {
  rmSync(join(SHARED_WORKDIR, '.dsh-archive'), { recursive: true, force: true })
  const handlers = new Map()
  const logger = { warn: [], info: [] }
  const ctx = {
    on: (name, fn) => handlers.set(name, fn),
    logger: { warn: (message) => logger.warn.push(String(message)), info: (message) => logger.info.push(String(message)) },
  }
  const config = { archiveDir: '.dsh-archive' }
  if (expConfig !== undefined) config.exp = expConfig
  apply(ctx, config)
  const session = { id: SHARED_SESSION_ID, title: 'ERP Bug：订单/退款', header: { cwd: SHARED_WORKDIR } }
  handlers.get('session/created')(session)
  const emit = (type, data, seq) => handlers.get('session/event')(session, { seq, type, data })
  return {
    workdir: SHARED_WORKDIR,
    session,
    handlers,
    logger,
    emit,
    dir: join(SHARED_WORKDIR, '.dsh-archive', SHARED_SESSION_ID),
  }
}

function emitFixture(archive) {
  for (const [type, data, seq] of FIXTURE) archive.emit(type, data, seq)
}

function compact(archive, { compactionId, seq }) {
  archive.emit(
    'compaction/summary',
    {
      compactionId,
      summary: [{ type: 'text', text: SUMMARY }],
      shadowedRange: { start: 0, end: 4 },
      shadowedSeqs: [0, 1, 2, 3, 4],
      shadowedTokenCount: 321,
      provider: 'company',
      model: 'deepseek-flash',
    },
    seq,
  )
}

async function makeStub(onRequest) {
  const received = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        body = raw
      }
      const record = { method: request.method, url: request.url, headers: request.headers, body }
      received.push(record)
      onRequest(request, response, record)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    received,
    close: async () => {
      // 挂住不回的 stub 会留着 keep-alive 连接：先强断，否则 close 永远等不到。
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const sendJson = (response, status, payload) => {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/**
 * 「失败不改变落盘内容」这组用例共用的 compaction id。
 *
 * 段文件的元数据里有 `| Compaction id | ... |`，INDEX 的 Bytes 列也随之变化；如果每个
 * 用例用各自的 id，比对必然不等，这条最关键的断言就会变成摆设。因此这组用例统一用它，
 * 只有 exp 配置（正常 / 500 / 超时 / 拒绝连接 / 关闭）不同。
 */
const CTRL_COMPACTION_ID = 'cmp-identity'

/** 一个归档的落盘内容（时间戳归一后），用来逐字节比对。 */
function archiveSnapshot(dir) {
  return {
    segment: normalizeTimestamps(readOrEmpty(join(dir, 'segment_000.md'))),
    index: readOrEmpty(join(dir, 'INDEX.md')),
    indexRows: normalizeTimestamps(readOrEmpty(join(dir, 'index.jsonl'))),
  }
}

const noticeOf = async (archive) => {
  const inbox = []
  await archive.handlers.get('agent/pre-step')(
    { agent: { session: archive.session, inbox: { prepend: (target, message) => inbox.push(message) } }, messages: [] },
    next,
  )
  return inbox
}

// --- baseline：没开 exp 时的落盘内容 --------------------------------------
const baseline = newArchive()
emitFixture(baseline)
compact(baseline, { compactionId: CTRL_COMPACTION_ID, seq: 9 })
await waitFor(() => existsSync(join(baseline.dir, 'segment_000.md')))
const baselineSnapshot = archiveSnapshot(baseline.dir)
check('baseline（未开 exp）确实写出了 segment_000.md', baselineSnapshot.segment.includes('## Verbatim turns'))

// --- ① 落盘后触发一次 POST，字段齐全 --------------------------------------
{
  const stub = await makeStub((request, response) => sendJson(response, 200, { job_id: 'job-1', status: 'done', funnel: { candidates: 2, created: 0 } }))
  const archive = newArchive({ enabled: true, url: stub.url, key: 'secret-key', minSegmentBytes: 0, apply: false })
  emitFixture(archive)
  compact(archive, { compactionId: 'cmp-post-1', seq: 9 })
  const posted = await waitFor(() => stub.received.length >= 1)
  const record = stub.received[0] ?? {}
  const body = record.body ?? {}
  check(
    '压缩落盘后触发了一次 POST /v1/exp/extract',
    posted && stub.received.length === 1 && record.method === 'POST' && record.url === '/v1/exp/extract',
    `${record.method} ${record.url} ×${stub.received.length}`,
  )
  check(
    '请求体字段齐全：session_id / segment_no / workflow / summary / verbatim / apply',
    body.session_id === 'session-exp-1' &&
      body.segment_no === 0 &&
      typeof body.workflow === 'string' &&
      body.workflow !== '' &&
      typeof body.summary === 'string' &&
      body.summary.includes('Primary Request') &&
      typeof body.verbatim === 'string' &&
      body.verbatim.includes('DEMO-7001') &&
      body.verbatim.includes('refundOverLimit') &&
      body.apply === false,
    JSON.stringify({ session_id: body.session_id, segment_no: body.segment_no, apply: body.apply }),
  )
  check('workflow 由会话标题推导成 slug（ERP Bug：订单/退款 → erp-bug-订单-退款）', body.workflow === 'erp-bug-订单-退款', body.workflow)
  check('鉴权用 exp.key：Authorization: Bearer <key>', record.headers?.authorization === 'Bearer secret-key', record.headers?.authorization)
  check('exp.apply 透传到请求体（默认 false = 只跑漏斗不写库）', body.apply === false)
  await sleep(300)
  check('一段只触发一次（不会重复发）', stub.received.length === 1, `×${stub.received.length}`)
  await stub.close()
}

// --- ② 抽取端点 500：writeSegment 照常成功，落盘与 baseline 一致 ----------
{
  const stub = await makeStub((request, response) => sendJson(response, 500, { error: 'boom' }))
  const archive = newArchive({ enabled: true, url: stub.url, minSegmentBytes: 0, timeoutMs: 1000 })
  emitFixture(archive)
  compact(archive, { compactionId: CTRL_COMPACTION_ID, seq: 9 })
  await waitFor(() => existsSync(join(archive.dir, 'segment_000.md')))
  const snapshot = archiveSnapshot(archive.dir)
  check(
    '500：segment_000.md 与未开 exp 时逐字节一致（时间戳归一后）',
    sameText(snapshot.segment, baselineSnapshot.segment),
    diffHint(snapshot.segment, baselineSnapshot.segment),
  )
  check('500：INDEX.md 与未开 exp 时完全一致', sameText(snapshot.index, baselineSnapshot.index), diffHint(snapshot.index, baselineSnapshot.index))
  check(
    '500：index.jsonl 与未开 exp 时一致（除时间戳）',
    sameText(snapshot.indexRows, baselineSnapshot.indexRows),
    diffHint(snapshot.indexRows, baselineSnapshot.indexRows),
  )
  const inbox = await noticeOf(archive)
  check('500：writeSegment 仍成功返回（指针照发）', inbox.length === 1)
  check('500：只 warn，不抛给会话事件路径', archive.logger.warn.some((message) => message.includes('HTTP 500')), archive.logger.warn.join(' | '))
  await waitFor(() => stub.received.length >= 1)
  check('500：确实发过一次请求（失败路径被真的走到了）', stub.received.length === 1, `×${stub.received.length}`)
  await stub.close()
}

// --- ③ 抽取端点超时：writeSegment 照常成功 -------------------------------
{
  const stub = await makeStub(() => {
    /* 永不响应 → 客户端 150ms 后超时 */
  })
  const archive = newArchive({ enabled: true, url: stub.url, minSegmentBytes: 0, timeoutMs: 150 })
  emitFixture(archive)
  compact(archive, { compactionId: CTRL_COMPACTION_ID, seq: 9 })
  await waitFor(() => existsSync(join(archive.dir, 'segment_000.md')))
  const snapshot = archiveSnapshot(archive.dir)
  check('超时：segment_000.md 与未开 exp 时逐字节一致', sameText(snapshot.segment, baselineSnapshot.segment), diffHint(snapshot.segment, baselineSnapshot.segment))
  check('超时：INDEX.md 与未开 exp 时完全一致', sameText(snapshot.index, baselineSnapshot.index), diffHint(snapshot.index, baselineSnapshot.index))
  const inbox = await noticeOf(archive)
  check('超时：writeSegment 仍成功返回（指针照发）', inbox.length === 1)
  await waitFor(() => stub.received.length >= 1 && archive.logger.warn.some((message) => message.includes('超时')), { timeout: 3000 })
  check('超时：请求真的发出去过，且 warn 说明是超时', stub.received.length === 1 && archive.logger.warn.some((message) => message.includes('请求超时')), archive.logger.warn.join(' | '))
  await stub.close()
}

// --- ④ 连接被拒绝：writeSegment 照常成功 ---------------------------------
{
  // 先起再关一个 stub，拿一个确定没人监听的端口
  const probe = await makeStub(() => {})
  const deadPort = probe.port
  await probe.close()
  const archive = newArchive({ enabled: true, url: `http://127.0.0.1:${deadPort}`, minSegmentBytes: 0, timeoutMs: 1000 })
  emitFixture(archive)
  compact(archive, { compactionId: CTRL_COMPACTION_ID, seq: 9 })
  await waitFor(() => existsSync(join(archive.dir, 'segment_000.md')))
  const snapshot = archiveSnapshot(archive.dir)
  check('连接拒绝：segment_000.md 与未开 exp 时逐字节一致', sameText(snapshot.segment, baselineSnapshot.segment), diffHint(snapshot.segment, baselineSnapshot.segment))
  check('连接拒绝：INDEX.md 与未开 exp 时完全一致', sameText(snapshot.index, baselineSnapshot.index), diffHint(snapshot.index, baselineSnapshot.index))
  const inbox = await noticeOf(archive)
  check('连接拒绝：writeSegment 仍成功返回（指针照发）', inbox.length === 1)
  await waitFor(() => archive.logger.warn.some((message) => message.includes('连不上')), { timeout: 3000 })
  check('连接拒绝：warn 里能看出是连不上（不是静默丢）', archive.logger.warn.some((message) => message.includes('连不上')), archive.logger.warn.join(' | '))
}

// --- ⑤ 抽取挂住时压缩不被阻塞 --------------------------------------------
{
  const stub = await makeStub(() => {
    /* 永不响应 */
  })
  const archive = newArchive({ enabled: true, url: stub.url, minSegmentBytes: 0, timeoutMs: 5000 })
  emitFixture(archive)
  compact(archive, { compactionId: 'cmp-block-1', seq: 9 })
  await waitFor(() => stub.received.length >= 1)
  const startedAt = Date.now()
  compact(archive, { compactionId: 'cmp-block-2', seq: 10 })
  const secondWritten = await waitFor(() => existsSync(join(archive.dir, 'segment_001.md')), { timeout: 2000 })
  const elapsed = Date.now() - startedAt
  check(
    '抽取请求还挂着时，下一段压缩照常落盘（fire-and-forget 不阻塞队列）',
    secondWritten && elapsed < 1500,
    `written=${secondWritten} elapsed=${elapsed}ms`,
  )
  await stub.close()
}

// --- ⑥ enabled=false：一个请求都不发 -------------------------------------
{
  const stub = await makeStub((request, response) => sendJson(response, 200, { status: 'done', funnel: {} }))
  const archive = newArchive({ enabled: false, url: stub.url, minSegmentBytes: 0 })
  emitFixture(archive)
  compact(archive, { compactionId: CTRL_COMPACTION_ID, seq: 9 })
  await waitFor(() => existsSync(join(archive.dir, 'segment_000.md')))
  await sleep(300)
  check('exp.enabled=false 时一个请求都不发，落盘照旧', stub.received.length === 0 && archiveSnapshot(archive.dir).index === baselineSnapshot.index)
  await stub.close()
}

// --- ⑦ 集成：连续 3 次 500 后本会话不再尝试 -------------------------------
{
  const stub = await makeStub((request, response) => sendJson(response, 500, { error: 'boom' }))
  const archive = newArchive({ enabled: true, url: stub.url, minSegmentBytes: 0, timeoutMs: 300 })
  emitFixture(archive)
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 1; i += 1) {
    compact(archive, { compactionId: `cmp-backoff-${i}`, seq: 20 + i })
    await waitFor(() => existsSync(join(archive.dir, `segment_00${i}.md`)))
    if (i < MAX_CONSECUTIVE_FAILURES) await waitFor(() => stub.received.length >= i + 1)
    else await sleep(300)
  }
  check(
    `集成：连续 ${MAX_CONSECUTIVE_FAILURES} 次 500 后第 4 段不再尝试（共 3 次 POST）`,
    stub.received.length === MAX_CONSECUTIVE_FAILURES,
    `×${stub.received.length}`,
  )
  check('集成：退避期间每一段都照常落盘', [0, 1, 2, 3].every((i) => existsSync(join(archive.dir, `segment_00${i}.md`))))
  check('集成：warn 里明确说了本会话不再尝试', archive.logger.warn.some((message) => message.includes('不再尝试')), archive.logger.warn.join(' | '))
  await stub.close()
}

// --- ⑧ 没有标题时 workflow 退回 cwd basename ------------------------------
{
  const stub = await makeStub((request, response) => sendJson(response, 200, { status: 'done', funnel: {} }))
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-exp-notitle-'))
  const handlers = new Map()
  const logger = { warn: [], info: [] }
  apply(
    { on: (name, fn) => handlers.set(name, fn), logger: { warn: (message) => logger.warn.push(String(message)) } },
    { archiveDir: '.dsh-archive', exp: { enabled: true, url: stub.url, minSegmentBytes: 0 } },
  )
  const session = { id: 'session-no-title', header: { cwd: workdir } }
  handlers.get('session/created')(session)
  const emit = (type, data, seq) => handlers.get('session/event')(session, { seq, type, data })
  for (const [type, data, seq] of FIXTURE) emit(type, data, seq)
  emit(
    'compaction/summary',
    {
      compactionId: 'cmp-no-title',
      summary: [{ type: 'text', text: SUMMARY }],
      shadowedSeqs: [0, 1, 2, 3, 4],
      shadowedRange: { start: 0, end: 4 },
      shadowedTokenCount: 12,
    },
    9,
  )
  await waitFor(() => stub.received.length >= 1)
  const expected = workdir.split(/[\\/]+/).filter(Boolean).pop().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  check(
    '没有 session.title 时 workflow 退回 cwd basename（slug 化）',
    stub.received[0]?.body?.workflow === expected,
    `got=${stub.received[0]?.body?.workflow} want=${expected}`,
  )
  await stub.close()
}

// --- ⑨ 配置面：cordis.patch.yml 与激活标记都带上 exp ---------------------
{
  const patch = readOrEmpty(join(import.meta.dirname, 'cordis.patch.yml'))
  check(
    'cordis.patch.yml 带上 exp 配置块（默认 enabled: false，注释说明失败只 warn）',
    /^\s+exp:\s*$/m.test(patch) && /^\s+enabled:\s*false\s*$/m.test(patch) && patch.includes('不影响归档'),
  )
  // 激活标记是全进程共用的单文件，读取前先用默认配置 apply 一次，
  // 这样断言的是"装上之后默认长什么样"，而不是上一个用例的残留。
  apply({ on: () => {}, logger: { warn: () => {} } }, { archiveDir: '.dsh-archive' })
  const markerFile = process.env.DSH_MEMORY_ARCHIVE_MARKER
  const marker = existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, 'utf8')) : null
  check(
    '激活标记记录 exp 接线状态（enabled/mode），可判定运行中的是这份代码',
    marker?.exp?.enabled === false && marker?.exp?.mode === 'server' && marker?.build === '2026-11-20.1',
    JSON.stringify(marker?.exp),
  )
}

// ================================================================ 汇总
const failed = results.filter((result) => !result.ok)
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `  ${result.detail}`}`)
console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length}/${results.length} CHECKS FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
