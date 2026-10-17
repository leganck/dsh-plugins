/**
 * Local self-test for @local/dsh-memory-archive.
 * Does NOT need a DSH profile: it drives the plugin through a fake Cordis ctx
 * and feeds it the exact session-event shapes observed in dsh-session /
 * dsh-agent-loop / dsh-compaction-basic sources.
 */
import { mkdtempSync, readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const pluginPath = pathToFileURL(join(import.meta.dirname, 'index.js')).href
const { apply, BUILD, KEYWORDS_VERSION, keywordsOf } = await import(pluginPath)

const handlers = new Map()
const fakeCtx = { on: (name, fn) => { handlers.set(name, fn) } }

// The plugin writes an activation marker on apply(), and it defaults to
// `_loaded.json` next to the module. A test run that used to delete that file
// could destroy a live install's marker (or, in a package-managed node_modules,
// fail to write at all), so the marker is redirected into a temp dir for the
// whole run and asserted at the end.
const markerPath = join(mkdtempSync(join(tmpdir(), 'dsh-archive-marker-')), '_loaded.json')
process.env.DSH_MEMORY_ARCHIVE_MARKER = markerPath

// A marker next to the module may legitimately already exist when this runs
// inside a live install (the running app wrote it). The invariant is therefore
// "the test neither creates nor modifies it" -- not "it must not exist".
const selfMarker = join(import.meta.dirname, '_loaded.json')
const fingerprint = (file) => (existsSync(file) ? `${statSync(file).mtimeMs}:${statSync(file).size}` : 'absent')
const selfMarkerBefore = fingerprint(selfMarker)

const workdir = mkdtempSync(join(tmpdir(), 'dsh-archive-test-'))
apply(fakeCtx, { archiveDir: '.dsh-archive', redact: true })

const session = { id: 'session-abc-123', header: { cwd: workdir } }
const emit = (type, data, seq) => handlers.get('session/event')(session, { seq, type, data })

handlers.get('session/created')(session)

// --- a realistic span that compaction is about to shadow -------------------
// Shapes below are copied from a real session log (2026-10-13). The fixture used
// to emit synthetic `tool/call` events carrying `name` and an object `arguments`,
// a shape DSH never produces -- which is exactly why the suite stayed green while
// the live archive reported "Tools used: (none)" for a span with 62 tool calls:
//   * a tool request is a `tool-call` content block inside an assistant message,
//     `arguments` is a JSON *string*, and `block.id` is the call id;
//   * a `tool/result` names no tool: `message.source` is `{kind:'tool', callId}`;
//   * `tool/call` events are never shadowed at all.
emit('system/message', { message: { content: [{ type: 'text', text: 'You are DSH.' }] } }, 0)
emit('user/message', { content: [{ type: 'text', text: '分析 bug DEMO-3459' }] }, 1)
emit('assistant/message', {
  message: {
    content: [
      { type: 'reasoning', text: '先查工单' },
      { type: 'text', text: '先查工单再查日志。' },
      { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: JSON.stringify({ command: 'go-devops logs query --query "DEMO-3459"' }) },
    ],
  },
}, 2)
emit('tool/result', {
  turn: 1, step: 1,
  message: {
    source: { kind: 'tool', callId: 'call_1' },
    toolCallId: 'call_1',
    content: [{ type: 'text', text: 'Exit code: 0\n\n{"count":0,"projectName":"default-aa-demo-erp-demo"}' }],
  },
}, 3)
emit('assistant/message', {
  turn: 1, step: 2,
  message: {
    content: [
      { type: 'tool-call', id: 'call_2', name: 'grep', arguments: JSON.stringify({ pattern: 'order/complete', path: 'D:\\Code\\demo' }) },
    ],
  },
}, 4)
emit('tool/result', {
  turn: 1, step: 2, error: { kind: 'timeout' },
  message: {
    source: { kind: 'tool', callId: 'call_2' },
    toolCallId: 'call_2',
    content: [{ type: 'text', text: 'grep timed out; token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij' }],
    isError: true,
  },
}, 5)
emit('assistant/message', {
  turn: 1, step: 3,
  message: {
    content: [
      { type: 'tool-call', id: 'call_3', name: 'read', arguments: JSON.stringify({ file_path: 'D:\\Code\\demo\\DemoOrderServiceImpl.java' }) },
    ],
  },
}, 6)
emit('assistant/message', { message: { content: [{ type: 'text', text: '日志为空，改查 19:27 窗口。' }] } }, 7)

// --- the compaction record the plugin reacts to ----------------------------
emit('compaction/start', { compactionId: 'cmp-1', turn: 2 }, 8)
emit('compaction/summary', {
  compactionId: 'cmp-1',
  summary: [{ type: 'text', text: '## Primary Request and Intent\n- 分析 DEMO-3459\n\n## Files and Code\n- C:\\Users\\you\\tmp\\demo-3459.log' }],
  shadowedRange: { start: 0, end: 7 },
  shadowedSeqs: [0, 1, 2, 3, 4, 5, 6, 7],
  shadowedTokenCount: 12345,
  provider: 'company',
  model: 'deepseek-flash',
}, 9)
emit('compaction/end', { compactionId: 'cmp-1', turn: 2 }, 10)

// the queue is a promise chain: let it drain
await new Promise((resolve) => setTimeout(resolve, 300))

const dir = join(workdir, '.dsh-archive', 'session-abc-123')
const segment = join(dir, 'segment_000.md')
const index = join(dir, 'INDEX.md')
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
/** Read a produced artifact, or '' when it is missing, so a check reports FAIL
 *  instead of the whole suite dying on ENOENT (which hides every other check). */
const safeRead = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')

check('segment file exists', existsSync(segment), segment)
check('INDEX.md exists', existsSync(index), index)

const text = existsSync(segment) ? readFileSync(segment, 'utf8') : ''
check('has fixed generated header', text.includes('# HISTORICAL -- GENERATED, DO NOT EDIT'))
check('records the source task in the header', /# Record of compaction segment 000 from this same task\./.test(text))
check('file header tells the reader to grep/read and not modify', text.includes('# Use read or grep to look up details, but do not modify.'))
check('records compaction id', text.includes('cmp-1'))
check('records the reported shadowed range', text.includes('| Shadowed range (reported) | 0 - 7 |'))
check('records the effective shadowed range from shadowedSeqs', text.includes('| Shadowed range (effective) | 0 - 7 (8 seqs) |'))
check('records summarizer', text.includes('company / deepseek-flash'))
check('includes checkpoint summary', text.includes('## Primary Request and Intent'))
check('includes verbatim tool response', text.includes('"count":0,"projectName"'))
check('includes verbatim tool call args', text.includes('go-devops logs query'))
check('includes human turn', text.includes('分析 bug DEMO-3459'))
check('labels tool response turn', text.includes('-- Tool response'))
check('counts tool calls by name, from the assistant content blocks', text.includes('pwsh (1)') && text.includes('grep (1)') && text.includes('read (1)'))
// pwsh is used first, so insertion order would be pwsh, grep, read; the rendered
// order must be the specified one (count desc, then codepoint) instead.
check('ties are ordered by codepoint, not by first use', text.includes('Tools used: grep (1), pwsh (1), read (1)'))
check('never reports a span with tool calls as having no tools', !text.includes('Tools used: (none)'))
check('reports the tool-call total in the metadata', /\| Tool calls issued \| 3 \|/.test(text))
check('counts tool errors', text.includes('Tool results marked as error: 1'))
check('JWT is redacted', text.includes('***JWT***') && !text.includes('eyJhbGciOiJIUzI1NiJ9'))
check('error flag surfaced in stats', !text.includes('eyJzdWIiOiIxIn0'))

// ② tool call / result pairing, derived from content-block ids
check('an assistant tool request is labelled with its tool name', text.includes('### seq 2 -- Assistant (tool call: pwsh)'))
check('a paired request points at its response', text.includes('_(tool call pwsh answered at seq 3)_'))
check('a tool response names the call it answers', text.includes('-- Tool response (callId call_1, answers seq 2)'))
check('a failing response is marked as an error', text.includes('-- Tool response (callId call_2, answers seq 4, error)'))
check('each event keeps its own seq-addressed block', text.includes('### seq 3 --') && text.includes('### seq 5 --'))
check('an unanswered request is called out', text.includes('### seq 6 -- Assistant (tool call: read)') && text.includes('_(tool call read has no response in this span)_'))
check('stats count the unanswered call', text.includes('Tool calls without a response in this span: 1'))

// ③ the three extra statistics Cursor reports
check('stats list unique target files from JSON-string arguments', text.includes('Unique target files (2)') && text.includes('DemoOrderServiceImpl.java'))
check('stats report a verbatim size estimate', /Verbatim-render size estimate: [\d,]+ B/.test(text))
check('stats report the last assistant excerpt', text.includes('Last assistant response excerpt: "日志为空，改查 19:27 窗口。"'))

const indexText = existsSync(index) ? readFileSync(index, 'utf8') : ''
check('index has a row per segment', indexText.includes('segment_000.md') && indexText.includes('| 000 |'))
check('index carries keywords', /\| `?segment_000\.md`? \|/.test(indexText))
check('index column is labelled Tool calls', indexText.includes('| Tool calls |'))
check('index reports the real tool-call count', /\| 000 \| `segment_000\.md` \| `cmp-1` \| 8 \| 8 \| 3 \|/.test(indexText))
check('index keywords never expose a masked secret fragment', !indexText.includes('abcdefghij'))

const indexRows = readFileSync(join(dir, 'index.jsonl'), 'utf8')
  .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
check('index stamps the keyword extractor version so stale rows can be found',
  indexRows.length > 0 && indexRows.every((row) => row.keywordsVersion === KEYWORDS_VERSION),
  `got ${indexRows.map((row) => row.keywordsVersion).join(',')}`)
check('every index row carries at least one keyword',
  indexRows.every((row) => Array.isArray(row.keywords) && row.keywords.length > 0))
check('INDEX.md explains what the keyword column answers',
  indexText.includes('which segment has this?'))

// --- keyword extractor -----------------------------------------------------
// The index exists so a reader can pick one segment out of the archive, so these
// cases pin the properties that make a keyword usable. Each one reproduces a real
// failure measured on this machine's archives: eight slots filled by host paths
// (`Users`, `you`, `node_modules`), by `the`/`and`/`seq`, by UUID halves boosted
// as issue ids (`a2b0-487`), and by `nconsole` glued out of a literal `\n`.
// A mixed sample: CJK prose, a Windows path, an issue id, a UUID, a payment number,
// and transcript noise. The determinism check runs the extractor on it twice.
const SAMPLE_TEXT = [
  '退款接口返回 refundOverLimit，商户 61528500 门店 POS 001。',
  'C:\\Users\\you\\Documents\\deepseek-harness\\default-workspace\\index.js',
  'DEMO-3459 splat-5511 a2b0-487e-40fc-8d18 0012609291623110034',
  'const x = "\\nconsole.log"; tool-call callId seq the and',
].join('\n')

const kw = (text, limit = 8, noise = null) => keywordsOf(text, limit, noise)

check('keywords: an issue id outranks a word that merely repeats',
  kw('DEMO-3459 DEMO-3459 order order order order order')[0] === 'DEMO-3459',
  `got ${kw('DEMO-3459 DEMO-3459 order order order order order')[0]}`)
check('keywords: case variants fold into the most frequent spelling',
  kw('Cursor Cursor cursor').filter((word) => word.toLowerCase() === 'cursor').length === 1
  && kw('Cursor Cursor cursor').includes('Cursor'),
  `got ${kw('Cursor Cursor cursor').join(',')}`)
check('keywords: host path fragments never take a slot',
  kw('C:\\Users\\you\\AppData\\Local\\Temp\\node_modules\\demo_core', 8, new Set(['you'])).join(',') === 'demo_core',
  `got ${kw('C:\\Users\\you\\AppData\\Local\\Temp\\node_modules\\demo_core', 8, new Set(['you'])).join(',')}`)
check('keywords: english function words and transcript noise are dropped',
  kw('the and for seq callId tool-call').length === 0,
  `got ${kw('the and for seq callId tool-call').join(',')}`)
check('keywords: backslash-separated path words are never cut short',
  ['target', 'new_folder'].every((word) => kw('a\\temp\\target\\new_folder').includes(word)),
  `got ${kw('a\\temp\\target\\new_folder').join(',')}`)
check('keywords: a path segment after a drive colon keeps its first letter',
  kw('C:\\temp\\newfolder').includes('newfolder'),
  `got ${kw('C:\\temp\\newfolder').join(',')}`)
check('keywords: an escape after a quote is read as a newline, not as a word',
  !kw("$js=@'\\nconst_total 1").some((word) => /^nconst/.test(word)),
  `got ${kw("$js=@'\\nconst_total 1").join(',')}`)
check('keywords: redaction placeholders are never keywords',
  kw('***JWT*** ***REDACTED*** token secret').length === 0,
  `got ${kw('***JWT*** ***REDACTED*** token secret').join(',')}`)
check('keywords: a uuid is never split into id-shaped fragments',
  kw('6787a2b0-487e-40fc-8d18-828eb4878ac6')
    .every((word) => !/^[A-Za-z0-9_]{2,12}-[A-Za-z]?\d{2,}$/.test(word)),
  `got ${kw('6787a2b0-487e-40fc-8d18-828eb4878ac6').join(',')}`)
check('keywords: file names survive as single tokens',
  kw('edited index.jsonl then index.jsonl').includes('index.jsonl'),
  `got ${kw('edited index.jsonl then index.jsonl').join(',')}`)
check('keywords: CJK phrases are kept verbatim so they stay greppable',
  kw('POS 在退历史支付时把当前未完成销售单的 saleCode 带进了退款接口。')
    .some((word) => /^[\u4e00-\u9fff]{2,8}$/.test(word)),
  `got ${kw('POS 在退历史支付时把当前未完成销售单的 saleCode 带进了退款接口。').join(',')}`)
check('keywords: nested CJK phrases collapse to one entry',
  kw('退款接口 退款接口 退款接口').length === 1,
  `got ${kw('退款接口 退款接口 退款接口').join(',')}`)
check('keywords: equal counts break ties on the folded key, in codepoint order',
  kw('Zeta alpha Zeta alpha', 2).join(',') === 'alpha,Zeta',
  `got ${kw('Zeta alpha Zeta alpha', 2).join(',')}`)
check('keywords: extraction is deterministic across runs',
  JSON.stringify(kw(SAMPLE_TEXT)) === JSON.stringify(kw(SAMPLE_TEXT)))
check('keywords: the limit is honoured',
  kw('alpha beta gamma delta epsilon zeta eta theta', 3).length === 3)

// --- duplicate compaction id must not create a second segment --------------
emit('compaction/summary', {
  compactionId: 'cmp-1',
  summary: [{ type: 'text', text: 'duplicate' }],
  shadowedSeqs: [0],
  shadowedRange: { start: 0, end: 0 },
  shadowedTokenCount: 1,
}, 11)
await new Promise((resolve) => setTimeout(resolve, 200))
check('duplicate compaction id is skipped', !existsSync(join(dir, 'segment_001.md')))

// --- resume: a fresh ctx over the same workdir must not re-archive ---------
const handlers2 = new Map()
const fakeCtx2 = { on: (name, fn) => { handlers2.set(name, fn) } }
const { apply: apply2 } = await import(`${pluginPath}?v=2`)
apply2(fakeCtx2, { archiveDir: '.dsh-archive' })
handlers2.get('session/created')(session)
handlers2.get('session/event')(session, { seq: 12, type: 'compaction/summary', data: { compactionId: 'cmp-1', summary: [], shadowedSeqs: [] } })
await new Promise((resolve) => setTimeout(resolve, 200))
check('resume does not duplicate an archived segment', !existsSync(join(dir, 'segment_001.md')))

// --- malformed events must not throw --------------------------------------
let threw = false
try {
  handlers.get('session/event')(session, { seq: 13, type: 'compaction/summary', data: { compactionId: 'cmp-2' } })
  handlers.get('session/event')(session, { seq: 14, type: 'tool/result', data: {} })
  handlers.get('session/event')(session, { seq: 15, type: 'user/message', data: { content: null } })
} catch { threw = true }
await new Promise((resolve) => setTimeout(resolve, 200))
check('malformed payloads do not throw', !threw)

// --- pointer injection: the archive is useless unless the model is told ------
const prepended = []
const agentWithInbox = { session, inbox: { prepend: (target, message) => prepended.push({ target, message }) } }
const next = async () => ({ kind: 'enter', messages: [] })

emit('compaction/start', { compactionId: 'cmp-3', turn: 3 }, 20)
emit('compaction/summary', {
  compactionId: 'cmp-3',
  summary: [{ type: 'text', text: 'checkpoint three' }],
  shadowedRange: { start: 11, end: 19 },
  shadowedSeqs: [11, 12],
  shadowedTokenCount: 10,
  provider: 'company',
  model: 'deepseek-flash',
}, 21)
await new Promise((resolve) => setTimeout(resolve, 200))

const preStep = handlers.get('agent/pre-step')
check('agent/pre-step handler is registered', typeof preStep === 'function')

const d1 = await preStep({ agent: agentWithInbox, messages: [], turn: 3, step: 1 }, next)
check('notice delivered through the durable inbox', prepended.length === 1 && prepended[0].target === 'next-step')
check('pre-step decision is unchanged on the inbox path', d1?.kind === 'enter' && d1.messages.length === 0)

const noticeMessage = prepended[0]?.message
const noticeBody = noticeMessage?.content?.[0]?.text ?? ''
check('notice names the INDEX file', noticeBody.includes('INDEX.md'))
check('notice names the segment glob', noticeBody.includes('segment_*.md'))
// 触发条件必须是**可判定的任务类型**，而不是"摘要够不够"这种自我评估。
// 旧文案 `when the checkpoint summary above is insufficient` 实测永不触发
// （本会话归档 12 段 / 5253 事件 / 0 次读取）；改为"要精确回忆标识符/数值/原始输出时先 grep"，
// 依据是 Cursor 的取证行为：它用**精确标识符**（PENDING_PAYMENT、工单号）grep 自己的 segment。
check(
  'notice states a task-type trigger (exact identifier/value/output), not "summary insufficient"',
  /exact identifier, value, or raw tool output/i.test(noticeBody) && !/summary above is insufficient/i.test(noticeBody),
)
check('notice tells the model to grep these files first', /grep these files first/i.test(noticeBody))
check('notice carries the do-not-modify rule', noticeBody.includes('Do not modify these files'))
// 关键词直接内联：读者不必先读 INDEX 才知道该 grep 什么
check(
  'notice inlines keywords (new segment or earlier segments)',
  /Keywords of the new segment/.test(noticeBody) || /Keywords of earlier segments/.test(noticeBody),
)
check('notice reports the accumulated archive size', /Archived so far in this session/.test(noticeBody))
check('notice is a user message with a source', noticeMessage?.role === 'user' && typeof noticeMessage?.source?.kind === 'string')

const d2 = await preStep({ agent: agentWithInbox, messages: [], turn: 3, step: 2 }, next)
check('the notice is delivered exactly once', prepended.length === 1 && d2.messages.length === 0)

// fallback: an agent whose inbox is unavailable still receives the pointer
emit('compaction/summary', {
  compactionId: 'cmp-4',
  summary: [{ type: 'text', text: 'checkpoint four' }],
  shadowedSeqs: [],
  shadowedRange: { start: 0, end: 0 },
  shadowedTokenCount: 1,
}, 22)
await new Promise((resolve) => setTimeout(resolve, 200))
const d3 = await preStep({ agent: { session }, messages: [], turn: 3, step: 3 }, next)
check('falls back to splicing into the entering batch', d3.messages.length === 1 && /system-reminder/.test(d3.messages[0]?.content?.[0]?.text ?? ''))

// announce: false disables the pointer
const handlers3 = new Map()
const fakeCtx3 = { on: (name, fn) => { handlers3.set(name, fn) } }
const { apply: apply3 } = await import(`${pluginPath}?v=3`)
apply3(fakeCtx3, { archiveDir: '.dsh-archive', announce: false })
handlers3.get('session/created')(session)
handlers3.get('session/event')(session, { seq: 30, type: 'compaction/summary', data: { compactionId: 'cmp-5', summary: [], shadowedSeqs: [] } })
await new Promise((resolve) => setTimeout(resolve, 150))
const inbox3 = []
const d4 = await handlers3.get('agent/pre-step')({ agent: { session, inbox: { prepend: () => inbox3.push(1) } }, messages: [] }, next)
check('announce: false suppresses the pointer', inbox3.length === 0 && d4.messages.length === 0)

// --- backfill: a plugin mounted mid-session must still archive the whole span --
// Reproduces the real failure observed on 2026-10-13: the app restarted, the
// plugin mounted at boot, and a compaction over an earlier span archived 5 of
// 436 shadowed events. DSH keeps seed/restore events off `session/event`, so the
// pre-existing history has to be adopted from `session.snapshotEvents()`.
const workdir2 = mkdtempSync(join(tmpdir(), 'dsh-archive-backfill-'))
const history = [
  { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'PRE-EXISTING human turn' }] } },
  {
    seq: 1,
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: 'chain of thought that must not leak' },
          { type: 'text', text: 'PRE-EXISTING assistant text' },
          { type: 'tool-call', id: 'call_h1', name: 'pwsh', arguments: '{"command":"go-devops db query --env prod"}' },
        ],
      },
    },
  },
  { seq: 2, type: 'tool/call', data: { callId: 'call_h1', name: 'pwsh', arguments: '{"command":"NOT SHADOWED"}' } },
  {
    seq: 3,
    type: 'tool/result',
    data: {
      message: {
        toolCallId: 'call_h1',
        source: { kind: 'tool', callId: 'call_h1' },
        content: [{ type: 'text', text: 'PRE-EXISTING tool output: 421 rows' }],
      },
    },
  },
  { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: 'LIVE turn also present in the snapshot' }] } },
]
const resumedSession = {
  id: 'session-resumed-9',
  header: { cwd: workdir2 },
  seq: 5,
  snapshotEvents: (from = 0, to = 5) => history.filter((event) => event.seq >= from && event.seq < to),
}
const handlers4 = new Map()
const { apply: apply4 } = await import(`${pluginPath}?v=4`)
apply4({ on: (name, fn) => { handlers4.set(name, fn) } }, { archiveDir: '.dsh-archive', redact: true })
handlers4.get('session/created')(resumedSession)

// The first live event is already inside the snapshot: it must not be buffered twice.
handlers4.get('session/event')(resumedSession, { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: 'LIVE turn also present in the snapshot' }] } })
handlers4.get('session/event')(resumedSession, {
  seq: 5,
  type: 'compaction/summary',
  data: {
    compactionId: 'cmp-backfill',
    summary: [{ type: 'text', text: 'checkpoint for the resumed span' }],
    // Deliberately inverted and wrong: the real backend emits ranges that are not
    // the min/max of shadowedSeqs, and one measured range was inverted outright.
    // `shadowedSeqs` must win for both coverage and the reported effective span.
    shadowedRange: { start: 9, end: 2 },
    shadowedSeqs: [0, 1, 3, 4],
    shadowedTokenCount: 99,
  },
})
await new Promise((resolve) => setTimeout(resolve, 250))

const backfillPath = join(workdir2, '.dsh-archive', 'session-resumed-9', 'segment_000.md')
const backfilled = existsSync(backfillPath) ? readFileSync(backfillPath, 'utf8') : ''
check('backfill: pre-existing tool output is archived', backfilled.includes('PRE-EXISTING tool output: 421 rows'))
check('backfill: pre-existing human turn is archived', backfilled.includes('PRE-EXISTING human turn'))
check(
  'tool request inside an assistant message keeps its name and arguments',
  backfilled.includes('[tool-call: pwsh]') && backfilled.includes('go-devops db query --env prod'),
)
check('an event outside shadowedSeqs stays out of the segment', !backfilled.includes('NOT SHADOWED'))
check('backfilled count matches the shadowed span', /\| Buffered events archived \| 4 \|/.test(backfilled))
check('a lying reported range is kept verbatim', backfilled.includes('| Shadowed range (reported) | 9 - 2 |'))
check('a lying reported range does not change the effective span',
  backfilled.includes('| Shadowed range (effective) | 0 - 4 (4 seqs) |'))
check('a lying reported range does not change coverage',
  ['### seq 0 --', '### seq 1 --', '### seq 3 --', '### seq 4 --'].every((h) => backfilled.includes(h)))
check('an event seen live and in the snapshot is recorded once', (backfilled.match(/### seq 4 --/g) ?? []).length === 1)
check('reasoning text is not dumped into the archive', !backfilled.includes('chain of thought that must not leak'))

// --- archive location: the root must be able to sit outside the project ------
// Verbatim tool output does not belong in a repository, so the default root is
// the user's DSH home and the configured path understands `~` / `$DSH_HOME`.
const savedEnv = { DSH_HOME: process.env.DSH_HOME, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
const homeDir = mkdtempSync(join(tmpdir(), 'dsh-archive-home-'))
const projectDir = mkdtempSync(join(tmpdir(), 'dsh-archive-project-'))
process.env.DSH_HOME = homeDir
process.env.USERPROFILE = homeDir
process.env.HOME = homeDir

const homeCase = async (name, config, sessionId) => {
  const map = new Map()
  const { apply: applyCase } = await import(`${pluginPath}?v=${name}`)
  applyCase({ on: (n, fn) => { map.set(n, fn) } }, config)
  const session = { id: sessionId, header: { cwd: projectDir } }
  map.get('session/created')(session)
  map.get('session/event')(session, { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: `${name} turn` }] } })
  map.get('session/event')(session, {
    seq: 1,
    type: 'compaction/summary',
    data: { compactionId: `cmp-${name}`, summary: [{ type: 'text', text: name }], shadowedSeqs: [0], shadowedRange: { start: 0, end: 0 }, shadowedTokenCount: 1 },
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  return session.id
}

await homeCase('homeenv', { archiveDir: '$DSH_HOME/mem-archive', announce: false }, 'session-home-1')
check('$DSH_HOME in archiveDir resolves outside the project', existsSync(join(homeDir, 'mem-archive', 'session-home-1', 'segment_000.md')))
check('an out-of-project archive writes nothing into the session cwd',
  !existsSync(join(projectDir, '$DSH_HOME')) && !existsSync(join(projectDir, 'mem-archive')) && !existsSync(join(projectDir, '.dsh-archive')))

await homeCase('homede', {}, 'session-default-1')
check('the default archive root is ~/.dsh/archive, not the project', existsSync(join(homeDir, '.dsh', 'archive', 'session-default-1', 'segment_000.md')))
check('the default root leaves the project clean', !existsSync(join(projectDir, '.dsh-archive')))
const defaultNotice = join(homeDir, '.dsh', 'archive', 'session-default-1', 'INDEX.md')
check('an INDEX.md is written next to the segments', existsSync(defaultNotice))

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

// --- back-compat: a session shape that DOES publish `tool/call` events -------
// DSH does not produce this shape today; the legacy read path is kept so an
// older or third-party session still yields a tool list instead of silence.
const workdir3 = mkdtempSync(join(tmpdir(), 'dsh-archive-legacy-'))
const legacySession = { id: 'session-legacy-1', header: { cwd: workdir3 } }
const handlers5 = new Map()
const { apply: apply5 } = await import(`${pluginPath}?v=5`)
apply5({ on: (name, fn) => { handlers5.set(name, fn) } }, { archiveDir: '.dsh-archive', redact: true })
handlers5.get('session/created')(legacySession)
handlers5.get('session/event')(legacySession, { seq: 0, type: 'tool/call', data: { callId: 'call_L1', name: 'legacy_tool', arguments: { file_path: 'D:\\legacy\\A.java' } } })
handlers5.get('session/event')(legacySession, {
  seq: 1,
  type: 'tool/result',
  data: { message: { toolCallId: 'call_L1', source: { kind: 'tool', callId: 'call_L1' }, content: [{ type: 'text', text: 'legacy output' }] } },
})
handlers5.get('session/event')(legacySession, {
  seq: 2,
  type: 'compaction/summary',
  data: { compactionId: 'cmp-legacy', summary: [{ type: 'text', text: 'legacy checkpoint' }], shadowedSeqs: [0, 1], shadowedRange: { start: 0, end: 1 }, shadowedTokenCount: 3 },
})
await new Promise((resolve) => setTimeout(resolve, 250))
const legacy = readFileSync(join(workdir3, '.dsh-archive', 'session-legacy-1', 'segment_000.md'), 'utf8')
check('legacy tool/call events still render as their own block', legacy.includes('### seq 0 -- Tool call: legacy_tool (callId call_L1)'))
check('legacy tool calls still count', /\| Tool calls issued \| 1 \|/.test(legacy))
check('legacy object arguments are still parsed for target files', legacy.includes('Unique target files (1)') && legacy.includes('A.java'))

const legacyInbox = []
await handlers5.get('agent/pre-step')(
  { agent: { session: legacySession, inbox: { prepend: (target, message) => legacyInbox.push(message) } }, messages: [] },
  next,
)
check('the notice reports the real tool-call count, in agreement with the segment', (legacyInbox[0]?.content?.[0]?.text ?? '').includes('2 events, 1 tool call)'))

// --- ① disk-log backfill: no snapshotEvents, multi-frame zstd, late mount -----
// The plugin's history recovery must not depend on `session.snapshotEvents()`,
// which DSH marks deprecated for production callers. The session log on disk is
// complete and append-only, so it is the primary source.
const diskWorkdir = mkdtempSync(join(tmpdir(), 'dsh-archive-disk-'))
const sessionsRoot = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
const diskSessionId = 'session-disk-1'
const slugDir = join(sessionsRoot, '--C-fake-workspace--', diskSessionId)
mkdirSync(slugDir, { recursive: true })
const diskHistory = [
  { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'DISK pre-existing human turn' }] } },
  {
    seq: 1,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', id: 'call_d1', name: 'pwsh', arguments: JSON.stringify({ command: 'go-devops logs query --query "DEMO-9001"' }) }] } },
  },
  {
    seq: 2,
    type: 'tool/result',
    data: { message: { toolCallId: 'call_d1', source: { kind: 'tool', callId: 'call_d1' }, content: [{ type: 'text', text: 'DISK tool output: 7 rows' }] } },
  },
]
// Two frames on purpose: Node's zstdDecompressSync decodes only the first, so a
// naive decoder would silently lose the tail and this suite would notice.
const asLine = (row) => `${JSON.stringify(row)}\n`
const diskLog = Buffer.concat([
  zstdCompressSync(Buffer.from(asLine(diskHistory[0]) + asLine(diskHistory[1]))),
  zstdCompressSync(Buffer.from(asLine(diskHistory[2]))),
])
writeFileSync(join(slugDir, 'session.v4.jsonl.zstd'), diskLog)

const diskSession = { id: diskSessionId, header: { cwd: diskWorkdir }, seq: 3 } // deliberately no snapshotEvents
const mapDisk = new Map()
const { apply: applyDisk } = await import(`${pluginPath}?v=disk`)
applyDisk({ on: (name, fn) => { mapDisk.set(name, fn) } }, { archiveDir: '.dsh-archive', sessionRoot: sessionsRoot, announce: false })
mapDisk.get('session/created')(diskSession)
// The plugin mounts late. The tail it sees live is deliberately OUTSIDE the
// shadowed span, so every seq the segment needs must come from the disk log --
// otherwise a single-frame decoder would still pass (that was a real fixture bug:
// feeding the tail live made the second frame unnecessary).
mapDisk.get('session/event')(diskSession, { seq: 9, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'LIVE tail the plugin saw' }] } } })
mapDisk.get('session/event')(diskSession, {
  seq: 10,
  type: 'compaction/summary',
  data: { compactionId: 'cmp-disk', summary: [{ type: 'text', text: 'disk checkpoint' }], shadowedRange: { start: 0, end: 2 }, shadowedSeqs: [0, 1, 2], shadowedTokenCount: 42 },
})
await new Promise((resolve) => setTimeout(resolve, 300))

const diskSeg = safeRead(join(diskWorkdir, '.dsh-archive', diskSessionId, 'segment_000.md'))
const diskBlocks = [...diskSeg.matchAll(/^### seq (\d+) -- /gm)].map((m) => Number(m[1]))
check('disk backfill: recovers a span the plugin never saw live', diskSeg.includes('DISK pre-existing human turn') && diskSeg.includes('DISK tool output: 7 rows'))
check('disk backfill: decodes every zstd frame, not only the first', diskSeg.includes('DISK tool output: 7 rows'))
check('disk backfill: needs no snapshotEvents at all', typeof diskSession.snapshotEvents === 'undefined' && /\| Buffered events archived \| 3 \|/.test(diskSeg))
check('disk backfill: recovered events are rendered in seq order', diskBlocks.join(',') === '0,1,2')
check('disk backfill: events outside the shadowed span stay out', !diskSeg.includes('LIVE tail the plugin saw'))
check('disk backfill: reported and archived counts agree', /\| Shadowed surface events \| 3 \|/.test(diskSeg) && /\| Buffered events archived \| 3 \|/.test(diskSeg))

// A session with no on-disk log and no snapshotEvents must degrade to live-only
// instead of throwing, and must say so through its counts rather than pretend.
const nologWorkdir = mkdtempSync(join(tmpdir(), 'dsh-archive-nolog-'))
const nologSession = { id: 'session-nolog-1', header: { cwd: nologWorkdir }, seq: 2 }
const mapNoLog = new Map()
const { apply: applyNoLog } = await import(`${pluginPath}?v=nolog`)
applyNoLog({ on: (name, fn) => { mapNoLog.set(name, fn) } }, { archiveDir: '.dsh-archive', sessionRoot: sessionsRoot, announce: false })
mapNoLog.get('session/created')(nologSession)
mapNoLog.get('session/event')(nologSession, { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'NO-LOG live turn' }] } })
mapNoLog.get('session/event')(nologSession, {
  seq: 2,
  type: 'compaction/summary',
  data: { compactionId: 'cmp-nolog', summary: [{ type: 'text', text: 's' }], shadowedSeqs: [0, 1], shadowedRange: { start: 0, end: 1 }, shadowedTokenCount: 1 },
})
await new Promise((resolve) => setTimeout(resolve, 250))
const nologSeg = safeRead(join(nologWorkdir, '.dsh-archive', 'session-nolog-1', 'segment_000.md'))
check('a missing session log degrades to live-only instead of failing',
  nologSeg.includes('NO-LOG live turn') && /\| Shadowed surface events \| 2 \|/.test(nologSeg) && /\| Buffered events archived \| 1 \|/.test(nologSeg))

// --- ② compaction/prune: content no segment can ever contain ------------------
// Measured on this machine: 84 events across 4 sessions were evicted by prune and
// appear in no compaction's shadowedSeqs, one of those sessions never compacting.
const pruneWorkdir = mkdtempSync(join(tmpdir(), 'dsh-archive-prune-'))
const pruneSession = { id: 'session-prune-1', header: { cwd: pruneWorkdir } }
const mapPrune = new Map()
const { apply: applyPrune } = await import(`${pluginPath}?v=prune`)
applyPrune({ on: (name, fn) => { mapPrune.set(name, fn) } }, { archiveDir: '.dsh-archive', sessionRoot: sessionsRoot, announce: true })
mapPrune.get('session/created')(pruneSession)
const emitPrune = (type, data, seq) => mapPrune.get('session/event')(pruneSession, { seq, type, data })

emitPrune('tool/result', {
  message: { toolCallId: 'call_p1', source: { kind: 'tool', callId: 'call_p1' }, content: [{ type: 'text', text: 'EVICTED big log output\nline 2 of the log' }] },
}, 10)
emitPrune('compaction/prune', { shadowedRange: { start: 10, end: 10 }, shadowedSeqs: [10], shadowedTokenCount: 4321 }, 11)
await new Promise((resolve) => setTimeout(resolve, 250))

const pruneDir = join(pruneWorkdir, '.dsh-archive', 'session-prune-1')
const evicted = safeRead(join(pruneDir, 'evicted.md'))
check('prune: the evicted event is archived verbatim', evicted.includes('EVICTED big log output') && evicted.includes('line 2 of the log'))
check('prune: the block records why it is here and how big', evicted.includes('### seq 10 -- Tool response (evicted by compaction/prune at seq 11, 4321 tokens)'))
check('prune: the ledger carries a machine-readable row', (() => { const raw = safeRead(join(pruneDir, 'evicted.jsonl')).trim(); return raw !== '' && JSON.parse(raw).seq === 10 })())
check('prune: INDEX.md explains that no segment can hold these', safeRead(join(pruneDir, 'INDEX.md')).includes('## Evicted events'))
check('prune: an evicted-only session still gets an INDEX.md', existsSync(join(pruneDir, 'INDEX.md')))

emitPrune('compaction/prune', { shadowedRange: { start: 10, end: 10 }, shadowedSeqs: [10], shadowedTokenCount: 4321 }, 12)
await new Promise((resolve) => setTimeout(resolve, 200))
check('prune: replaying the same prune does not duplicate the block',
  (safeRead(join(pruneDir, 'evicted.md')).match(/^### seq 10 -- /gm) ?? []).length === 1)

emitPrune('compaction/summary', {
  compactionId: 'cmp-prune',
  summary: [{ type: 'text', text: 'checkpoint after eviction' }],
  shadowedSeqs: [],
  shadowedRange: { start: 0, end: 0 },
  shadowedTokenCount: 1,
}, 13)
await new Promise((resolve) => setTimeout(resolve, 250))
const pruneInbox = []
await mapPrune.get('agent/pre-step')(
  { agent: { session: pruneSession, inbox: { prepend: (target, message) => pruneInbox.push(message) } }, messages: [] },
  next,
)
check('prune: the pointer tells the model the evicted file exists',
  (pruneInbox[0]?.content?.[0]?.text ?? '').includes('evicted.md'))

// --- activation marker: the only disk side effect of apply() ----------------
// Distributable behaviour, in two parts: a redirected marker must be honoured
// (read-only or package-managed install dirs, and this very test), and a test
// run must leave a live install untouched.
const envMarker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null
check('activation: marker honours DSH_MEMORY_ARCHIVE_MARKER', envMarker !== null)
check('activation: marker reports the build and where it was written',
  envMarker?.build === BUILD && envMarker?.markerFile === markerPath && envMarker?.pid === process.pid,
  `build=${envMarker?.build} markerFile=${envMarker?.markerFile}`)
check('activation: self-test neither created nor modified a marker next to the module',
  fingerprint(selfMarker) === selfMarkerBefore, `before=${selfMarkerBefore} after=${fingerprint(selfMarker)}`)
{
  // Second branch: config.markerFile, with the env override removed, into a
  // directory that does not exist yet (the plugin must create it).
  const cfgMarker = join(mkdtempSync(join(tmpdir(), 'dsh-archive-marker-cfg-')), 'nested', 'marker.json')
  const saved = process.env.DSH_MEMORY_ARCHIVE_MARKER
  delete process.env.DSH_MEMORY_ARCHIVE_MARKER
  apply({ on: () => {} }, { archiveDir: '.dsh-archive', markerFile: cfgMarker })
  process.env.DSH_MEMORY_ARCHIVE_MARKER = saved
  const cfg = existsSync(cfgMarker) ? JSON.parse(readFileSync(cfgMarker, 'utf8')) : null
  check('activation: config.markerFile is honoured and its parent dir created',
    cfg?.markerFile === resolve(cfgMarker), `got ${cfg?.markerFile}`)
  check('activation: env override wins over config.markerFile',
    fingerprint(selfMarker) === selfMarkerBefore)
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  ${r.detail}`}`)
console.log(`\n--- injected notice (verbatim) ---\n${noticeBody}`)
console.log(`\narchive dir: ${dir}`)

console.log(`\nactivation marker written to: ${markerPath}`)
console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length}/${results.length} CHECKS FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
