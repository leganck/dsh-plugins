/**
 * Independently recompute every tool statistic from the raw session log and
 * compare it against the rendered segments. Deliberately re-implements the
 * counting from the log instead of importing the plugin, so a bug in the
 * plugin cannot validate itself.
 *
 * Structural parsing is fence-aware. Archived text legitimately quotes the
 * plugin's own vocabulary -- a span can contain the literal line
 * "### seq 3 -- Tool response (callId call_1, answers seq 2)" inside a fenced
 * block, and "Tools used: (none)" as prose. Counting those as structure
 * produces false failures (and, earlier in this project, false successes).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SEG_DIR = process.argv[2]
if (!SEG_DIR) throw new Error('usage: verify-segments.mjs <segment-dir> [sessionsRoot]')
// The session id is the archive directory's name, and the log is located by id so
// no workspace slug has to be reproduced here.
const SESSION_ID = path.basename(SEG_DIR)
const SESSIONS_ROOT = process.argv[3] ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')

function findSessionLog(root, id) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, id, 'session.v4.jsonl.zstd')
    if (fs.existsSync(file)) return file
  }
  return null
}

const LOG = findSessionLog(SESSIONS_ROOT, SESSION_ID)
if (LOG === null) throw new Error(`no session log for ${SESSION_ID} under ${SESSIONS_ROOT}`)
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g

function decodeMultiFrameZstd(file) {
  const buf = fs.readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offs = []
  let i = 0
  for (;;) {
    const k = buf.indexOf(MAGIC, i)
    if (k === -1) break
    offs.push(k)
    i = k + 4
  }
  const parts = []
  for (let k = 0; k < offs.length; k++) {
    parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)))
  }
  return Buffer.concat(parts).toString('utf8')
}

const events = decodeMultiFrameZstd(LOG)
  .split('\n').filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
  .map((row) => ({ seq: row.seq, type: row.type, data: row.data }))
const bySeq = new Map(events.map((event) => [event.seq, event]))

const contentOf = (event) => {
  const content = event.type === 'user/message' ? event.data?.content : event.data?.message?.content
  return Array.isArray(content) ? content : []
}
const TARGET_KEYS = ['file_path', 'path', 'target_directory', 'target_file', 'directory']

/** Split a segment into its header block and its verbatim lines, fence-aware. */
function parseSegment(text) {
  const lines = text.split('\n')
  const fenced = new Array(lines.length).fill(false) // true when this line is fence or fence content
  let open = 0
  for (let k = 0; k < lines.length; k += 1) {
    const body = lines[k]
    if (open === 0) {
      const m = /^(`{3,})([A-Za-z0-9]*)\s*$/.exec(body)
      if (m) { fenced[k] = true; open = m[1].length; continue }
      continue
    }
    fenced[k] = true
    if (new RegExp(`^\`{${open},}\\s*$`).test(body)) open = 0
  }
  const headerEnd = lines.findIndex((line, k) => !fenced[k] && line === '## Summary (curated by the compaction backend)')
  let verbatimAt = -1
  for (let k = 0; k < lines.length; k += 1) if (!fenced[k] && lines[k] === '## Verbatim turns') verbatimAt = k
  return {
    headerLines: lines.slice(0, headerEnd === -1 ? lines.length : headerEnd),
    verbatimLines: lines.slice(verbatimAt + 1),
    fenced: fenced.slice(verbatimAt + 1),
  }
}

/**
 * Blocks are `### seq N -- title` headers outside fences; annotations follow.
 * `content` is every line up to the next header, fences included, because a
 * rendered tool request lives inside the block's ```text fence.
 */
function parseVerbatim(lines, fenced) {
  const heads = []
  for (let k = 0; k < lines.length; k += 1) {
    if (fenced[k]) continue
    const m = /^### seq (\d+) -- (.+)$/.exec(lines[k])
    if (m) heads.push({ at: k, seq: Number(m[1]), title: m[2] })
  }
  return heads.map((head, i) => {
    const stop = i + 1 < heads.length ? heads[i + 1].at : lines.length
    const outside = []
    for (let j = head.at + 1; j < stop; j += 1) {
      if (fenced[j]) continue
      if (/^> .*maxEventsPerSegment/.test(lines[j])) break
      outside.push(lines[j])
    }
    return { seq: head.seq, title: head.title, outside, content: lines.slice(head.at + 1, stop) }
  })
}

/**
 * The exact line `renderBlocks` emits for one tool call. The plugin writes the
 * arguments string verbatim (no truncation) and JSON-stringifies anything that
 * is not already a string, so equality is an exact-match test.
 */
function renderedCallLine(call) {
  let args = call.arguments
  if (typeof args !== 'string') {
    try { args = JSON.stringify(args) } catch { args = String(args) }
  }
  return `[tool-call: ${call.name}] ${args ?? ''}`.trimEnd()
}

const REDACTION = /\*{3}[A-Z_]*\*{3}/g
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `mask()` runs over the whole rendered event before it is written, so tool
 * arguments are redacted too. Measured: three calls in this archive render
 * shorter than the log by exactly the length of the secrets they carried. An
 * exact comparison would therefore report a real-looking failure; when a
 * placeholder is present, it is allowed to stand for a non-empty run of the
 * original, and the literal frame around it must still match.
 */
function renderedMatchesLog(rendered, want) {
  const placeholders = rendered.match(REDACTION)
  if (placeholders === null) return rendered === want
  const parts = rendered.split(REDACTION)
  return new RegExp(`^${parts.map(escapeRe).join('[\\s\\S]+?')}$`).test(want)
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ${detail}`}`)
}

const indexPath = path.join(SEG_DIR, 'index.jsonl')
if (!fs.existsSync(indexPath)) {
  // A session that never compacted legitimately has no segment ledger at all.
  console.log('no index.jsonl: this session has no compaction segments (only evicted events, if any)')
  console.log('\nALL SEGMENT CHECKS PASSED (0 segments)')
  process.exit(0)
}
const rows = fs.readFileSync(indexPath, 'utf8')
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

for (const row of rows) {
  const summary = events.find((e) => e.type === 'compaction/summary' && e.data?.compactionId === row.compactionId)
  const shadowedSeqs = summary.data.shadowedSeqs ?? []
  const spanEvents = shadowedSeqs.map((seq) => bySeq.get(seq)).filter(Boolean)

  const calls = []
  for (const event of spanEvents) {
    for (const block of contentOf(event)) {
      if (block?.type === 'tool-call' || block?.type === 'tool_call') {
        calls.push({ seq: event.seq, id: block.id, name: block.name, arguments: block.arguments })
      }
    }
  }
  const resultCallIds = new Set(spanEvents.filter((e) => e.type === 'tool/result').map((e) => e.data?.message?.toolCallId))
  const callSeqById = new Map(calls.map((c) => [c.id, c.seq]))
  const answeredResults = spanEvents.filter((e) => e.type === 'tool/result' && callSeqById.has(e.data?.message?.toolCallId))
  const answeredCalls = calls.filter((c) => resultCallIds.has(c.id))
  const unanswered = calls.length - answeredCalls.length

  const targets = new Set()
  for (const call of calls) {
    if (typeof call.arguments !== 'string') continue
    let args
    try { args = JSON.parse(call.arguments) } catch { continue }
    for (const key of TARGET_KEYS) if (typeof args?.[key] === 'string' && args[key].trim() !== '') targets.add(args[key].trim())
  }

  const text = fs.readFileSync(path.join(SEG_DIR, row.file), 'utf8')
  const { headerLines, verbatimLines, fenced } = parseSegment(text)
  const header = headerLines.join('\n')
  const blocks = parseVerbatim(verbatimLines, fenced)
  const blockSeqs = new Set(blocks.map((b) => b.seq))
  const missing = shadowedSeqs.filter((seq) => !blockSeqs.has(seq))
  const extra = [...blockSeqs].filter((seq) => !shadowedSeqs.includes(seq))

  const meta = (label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(`^\\| ${escaped} \\| (.+?) \\|$`, 'm').exec(header)
    return m ? m[1] : null
  }
  const stat = (prefix) => {
    const m = new RegExp(`^- ${prefix}(.*)$`, 'm').exec(header)
    return m ? m[0] : null
  }

  const forward = blocks.flatMap((b) => b.outside.filter((l) => /^_\(tool call .+ answered at seq \d+\)_$/.test(l)))
  const unansweredMarks = blocks.flatMap((b) => b.outside.filter((l) => /^_\(tool call .+ has no response in this span\)_$/.test(l)))
  const reverse = blocks.filter((b) => /^Tool response \(callId .*answers seq \d+/.test(b.title))
  const callSeqs = new Set(calls.map((c) => c.seq))
  const requestTitles = blocks.filter((b) => /\(tool calls?: /.test(b.title))
  const titleBySeq = new Map(requestTitles.map((b) => [b.seq, b.title]))
  const titlesCorrect = [...callSeqs].every((seq) => {
    const names = calls.filter((c) => c.seq === seq).map((c) => c.name)
    const want = `(tool call${names.length > 1 ? 's' : ''}: ${names.join(', ')})`
    return (titleBySeq.get(seq) ?? '').endsWith(want)
  })

  console.log(`\n===== ${row.file} (${row.compactionId}) =====`)
  check('seq coverage is exact', missing.length === 0 && extra.length === 0, `missing=${missing.length} extra=${extra.length} ${extra.slice(0, 5)}`)
  check('reported shadowed count matches the log', meta('Shadowed surface events') === String(shadowedSeqs.length))
  // `shadowedRange` is not min/max and can be inverted, so the reported value is
  // copied verbatim while the effective span is recomputed from shadowedSeqs.
  const sorted = [...shadowedSeqs].sort((a, b) => a - b)
  check('effective range line is recomputed from shadowedSeqs',
    meta('Shadowed range (effective)') === `${sorted[0]} - ${sorted[sorted.length - 1]} (${sorted.length} seqs)`,
    `got "${meta('Shadowed range (effective)')}"`)
  check('reported range line is the log value, verbatim',
    meta('Shadowed range (reported)') === `${summary.data.shadowedRange?.start} - ${summary.data.shadowedRange?.end}`,
    `got "${meta('Shadowed range (reported)')}"`)
  check('reported archived count matches the log', meta('Buffered events archived') === String(shadowedSeqs.length))
  check('reported tool-call count matches the log', meta('Tool calls issued') === String(calls.length), `${meta('Tool calls issued')} vs ${calls.length}`)
  // A global count of `^[tool-call: ` lines is NOT a valid check: archived text
  // legitimately quotes one of those lines -- a tool result that printed a
  // segment, or an assistant message that pasted an excerpt -- and that produced
  // a false failure on segment_004 (282 counted vs 278 real). Each line is
  // instead matched against the exact request of the block that owns it, which
  // is exact in both directions and ignores quoted text.
  const renderedOk = (() => {
    const wantBySeq = new Map()
    for (const call of calls) {
      if (!wantBySeq.has(call.seq)) wantBySeq.set(call.seq, [])
      wantBySeq.get(call.seq).push(renderedCallLine(call))
    }
    const problems = []
    let matched = 0
    for (const block of blocks) {
      const expected = wantBySeq.get(block.seq) ?? []
      if (!/^Assistant \(tool calls?: /.test(block.title)) {
        if (expected.length > 0) problems.push(`seq ${block.seq}: ${expected.length} call(s) but block is "${block.title}"`)
        continue
      }
      const pool = [...expected]
      let spurious = 0
      for (const line of block.content) {
        if (!/^\[tool-call: /.test(line)) continue
        const at = pool.findIndex((want) => renderedMatchesLog(line, want))
        if (at === -1) {
          // Not owed by this block. A quoted excerpt is expected and harmless
          // (a tool result that printed a segment, a pasted fragment); a second
          // exact copy of one of this block's own requests is not.
          if (expected.some((want) => renderedMatchesLog(line, want))) spurious += 1
          continue
        }
        pool.splice(at, 1)
        matched += 1
      }
      if (pool.length > 0) problems.push(`seq ${block.seq}: ${pool.length} call(s) not rendered`)
      if (spurious > 0) problems.push(`seq ${block.seq}: ${spurious} duplicated render(s)`)
    }
    const blockSeqs = new Set(blocks.map((b) => b.seq))
    for (const seq of wantBySeq.keys()) if (!blockSeqs.has(seq)) problems.push(`seq ${seq}: no block rendered`)
    return { ok: problems.length === 0 && matched === calls.length, detail: problems.length > 0 ? `${problems.length} problem(s): ${problems.slice(0, 3).join('; ')}` : `${matched}/${calls.length} rendered` }
  })()
  check('rendered tool requests equal the log (per owning block)', renderedOk.ok, renderedOk.detail)
  check('each tool-requesting message is titled with its tools', requestTitles.length === callSeqs.size && titlesCorrect,
    `${requestTitles.length} vs ${callSeqs.size} distinct requesting seqs`)
  // Must mirror the documented ordering rule exactly: count desc, then codepoint.
  // (An earlier version of this verifier assumed a localeCompare tiebreak that the
  // plugin did not have, which produced a false failure.)
  const expectedTools = [...calls.reduce((m, c) => m.set(c.name, (m.get(c.name) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([n, c]) => `${n} (${c})`).join(', ')
  check('per-tool counts match the log', stat('Tools used: ') === `- Tools used: ${expectedTools}`, `got "${stat('Tools used: ')}"`)
  check('forward pairing annotations equal the answered requests', forward.length === answeredCalls.length, `${forward.length} vs ${answeredCalls.length}`)
  check('unanswered requests are marked', unansweredMarks.length === unanswered, `${unansweredMarks.length} vs ${unanswered}`)
  check('reverse pairing annotations equal the answerable results', reverse.length === answeredResults.length, `${reverse.length} vs ${answeredResults.length}`)
  check('unanswered count matches the log', stat('Tool calls without a response in this span: ') === `- Tool calls without a response in this span: ${unanswered}`)
  const targetStat = stat('Unique target files ')
  check('target-file count matches the log', targetStat?.startsWith(`- Unique target files (${targets.size})`), `got "${targetStat}"`)
  check('target-file list is populated when the log has targets', targets.size === 0 || !/\(none\)$/.test(targetStat ?? ''))
  check('no JWT-shaped secret survived redaction', (text.match(JWT) ?? []).length === 0, `${(text.match(JWT) ?? []).length} found`)
}

console.log(failures === 0 ? `\nALL SEGMENT CHECKS PASSED (${rows.length} segments)` : `\n${failures} SEGMENT CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
