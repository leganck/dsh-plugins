/**
 * @local/dsh-memory-archive — Host plugin.
 *
 * Purpose: DSH's compaction replaces an older conversation span with one summary
 * message and keeps only that summary text on the surface. The raw events stay in
 * the session log, but nothing renders them into a browsable, greppable artifact,
 * so early tool output becomes expensive to recover in a long session.
 *
 * This plugin listens to the public `session/created` / `session/event` events and,
 * whenever a `compaction/summary` is recorded, writes one Markdown segment holding
 *   1. the checkpoint summary written by the compaction backend, and
 *   2. the verbatim turns of the span that compaction just shadowed
 *      (human messages, assistant text including tool requests, tool responses).
 * It also maintains an `INDEX.md` with one grep-able row per segment.
 *
 * DSH shadows only message-surface events, so `shadowedSeqs` lists `user/message`,
 * `assistant/message`, and `tool/result` nodes; a tool request is archived from the
 * `tool-call` content block inside its assistant message, not from a `tool/call`
 * event. `tool/result` names no tool either, so tool names, tool counts, target
 * files, and call/response pairing are all derived from those content blocks,
 * keyed by `block.id` == `tool/result.message.toolCallId`. Because seed/restore
 * events never reach `session/event`, the plugin adopts pre-existing history
 * through `session.snapshotEvents()` when it first sees a session, so a compaction
 * over an earlier span still archives that whole span.
 *
 * Nothing here mutates the session: the plugin only reads events the session
 * already publishes and writes files under its own archive directory.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

/** Directory holding this module, so activation can be observed from disk. */
const SELF_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Bump when the behaviour changes. It is written into `_loaded.json` so the
 * running app can be shown to hold *this* code, not a stale module cache.
 */
export const BUILD = '2026-10-13.5'

/** Config defaults; a row may override any field through the bundle patch. */
const DEFAULTS = {
  /**
   * Archive root. `~`, `$DSH_HOME`/`${DSH_HOME}`, `$HOME`, and `%USERPROFILE%`
   * are expanded; a relative path resolves against the session working
   * directory. The default lives in the user's DSH home rather than in the
   * project being recorded -- segments are verbatim tool output and do not
   * belong in a repository.
   */
  archiveDir: '~/.dsh/archive',
  /**
   * Root of DSH's own session logs, used to recover history the plugin never
   * witnessed. Reading the log beats `session.snapshotEvents()`: it is complete,
   * append-only, and depends on no API that upstream can deprecate.
   */
  sessionRoot: '$DSH_HOME/sessions',
  /** Set false to fall back to the in-memory readers only. */
  readSessionLog: true,
  /** Include verbatim tool responses in each segment. */
  includeToolResults: true,
  /** Mask token-like strings before writing. */
  redact: true,
  /** Per-session cap on buffered events (oldest dropped first). */
  maxEventsPerSession: 20000,
  /** Refuse to write a segment larger than this; the tail is elided instead. */
  maxSegmentBytes: 1500000,
  /** Keep at most this many events for one segment's verbatim section. */
  maxEventsPerSegment: 4000,
  /** Announce each archived segment to the model so the archive actually gets used. */
  announce: true,
  /**
   * Where to write the activation marker. `null` (the default) writes
   * `_loaded.json` next to this module. Set it — or the
   * `DSH_MEMORY_ARCHIVE_MARKER` env var, which wins — when the install
   * directory is read-only (a package-managed `node_modules`, for instance) or
   * to keep a self-test from touching a live install. A relative value resolves
   * against this module's own directory, never the session cwd.
   */
  markerFile: null,
}

/** Event types buffered for the verbatim section, in the order they appear. */
const ARCHIVED_TYPES = new Set([
  'user/message',
  'assistant/message',
  'system/message',
  'developer/message',
  'tool/call',
  'tool/result',
])

const ROLE_LABEL = {
  'user/message': 'Human',
  'assistant/message': 'Assistant',
  'system/message': 'System',
  'developer/message': 'Developer',
  'tool/call': 'Tool call',
  'tool/result': 'Tool response',
}

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'your', 'what', 'when', 'then',
  'there', 'their', 'which', 'would', 'could', 'should', 'about', 'these', 'those',
  'into', 'over', 'than', 'them', 'they', 'been', 'were', 'also', 'only', 'some',
  'more', 'most', 'such', 'because', 'while', 'where', 'after', 'before', 'using',
  'used', 'does', 'each', 'other', 'same', 'make', 'made', 'must', 'need',
])

/** Mask JWT-like and bearer-like strings so archives do not retain credentials. */
const REDACTIONS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '***JWT***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1***TOKEN***'],
  [/((?:"|')?(?:api[_-]?key|access[_-]?token|password|passwd|secret)(?:"|')?\s*[:=]\s*)(?:"|')?[A-Za-z0-9._~+/=-]{12,}/gi, '$1***REDACTED***'],
]

const DSH_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode a DSH session log.
 *
 * The file is a concatenation of zstd frames and `zstdDecompressSync` decodes only
 * the first one, so the stream is split on the frame magic and decoded frame by
 * frame. A magic sequence can also occur *inside* compressed data, so a frame that
 * fails to decode is retried merged with the following one rather than abandoned.
 */
function decodeSessionLog(buffer) {
  const offsets = []
  let at = 0
  for (;;) {
    const found = buffer.indexOf(DSH_FRAME_MAGIC, at)
    if (found === -1) break
    offsets.push(found)
    at = found + DSH_FRAME_MAGIC.length
  }
  if (offsets.length === 0) throw new Error('no zstd frame found')
  const chunks = []
  let index = 0
  while (index < offsets.length) {
    let end = index + 1
    let decoded
    for (;;) {
      const stop = end < offsets.length ? offsets[end] : buffer.length
      try {
        decoded = zlib.zstdDecompressSync(buffer.subarray(offsets[index], stop))
        break
      } catch (error) {
        if (end >= offsets.length) throw error
        end += 1
      }
    }
    chunks.push(decoded)
    index = end
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Parse a decoded log into events, optionally keeping only the wanted seqs.
 *
 * The log is append-only and therefore *complete*: it still holds the events DSH
 * has already removed from the live message surface. That is why it can replace
 * the deprecated in-memory reader.
 */
function parseSessionLog(text, wanted) {
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row === null || typeof row !== 'object') continue
    const seq = Number(row.seq)
    if (!Number.isFinite(seq)) continue
    if (wanted !== undefined && !wanted.has(seq)) continue
    events.push({ seq, type: row.type, data: row.data })
  }
  return events
}

/**
 * Locate a session's log without reverse-engineering the workspace slug.
 *
 * A slug encodes the cwd with escapes such as `~0020` for a space, which is not
 * worth reproducing. The session id is unique, so the sessions root is scanned
 * and the answer is cached.
 */
function findSessionLog(root, sessionId) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(root, entry.name, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(file)) return file
  }
  return null
}

const pluginConfig = (raw) => ({ ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) })

/**
 * Expand `~`, `$DSH_HOME`, `$HOME` and `%VAR%` in a configured path.
 *
 * `~` means the OS home; `$DSH_HOME` means the DSH home (`<home>/.dsh` when the
 * variable is unset). Both are expanded so a config row can name the user's DSH
 * directory without hardcoding one machine's absolute path.
 */
function expandPath(value) {
  const home = homedir()
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(home, '.dsh')
  return String(value)
    .replace(/\$\{?DSH_HOME\}?/g, dshHome)
    .replace(/\$\{?(?:USERPROFILE|HOME)\}?/g, home)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
      const found = process.env[name]
      return typeof found === 'string' && found !== '' ? found : whole
    })
    .replace(/^~(?=$|[\\/])/, home)
}

function mask(text, enabled) {
  if (!enabled || typeof text !== 'string') return text
  let out = text
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

/** Flatten a content-block array into plain text without losing text fidelity. */
function blocksToText(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text': parts.push(String(block.text ?? '')); break
      case 'image': parts.push('[image]'); break
      case 'file': parts.push(`[file${block.name ? ` ${block.name}` : ''}]`); break
      // A tool request lives inside the assistant message as a content block, not
      // as a `tool/call` event: DSH only ever shadows message-surface events, so
      // the name and arguments are recoverable here or nowhere.
      case 'tool-call':
      case 'tool_call': {
        let args = block.arguments
        if (typeof args !== 'string') {
          try { args = JSON.stringify(args) } catch { args = String(args) }
        }
        const name = String(block.name ?? 'unknown')
        parts.push(`[tool-call: ${name}] ${args ?? ''}`.trimEnd())
        break
      }
      default: parts.push(`[${String(block.type ?? 'block')}]`)
    }
  }
  return parts.join('\n')
}

/** Pull the model-visible text out of one buffered event, using its real shape. */
function renderEvent(event) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'user/message':
      return blocksToText(data.content)
    case 'assistant/message':
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
      return blocksToText(data.message?.content)
    case 'tool/call': {
      let args = data.arguments
      if (typeof args !== 'string') {
        try { args = JSON.stringify(args) } catch { args = String(args) }
      }
      return `${String(data.name ?? 'unknown')}(${args ?? ''})`
    }
    default:
      return ''
  }
}

/** The content-block array of one buffered event, using its real shape. */
function contentOf(event) {
  const content = event.type === 'user/message' ? event.data?.content : event.data?.message?.content
  return Array.isArray(content) ? content : []
}

/** Tool arguments are a JSON *string* on the wire, but an object after a hand-built event. */
function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Every tool request in this span, in order.
 *
 * Measured against a real session: `tool/result.message.source` is
 * `{kind:'tool', callId}` and carries NO tool name, and `tool/call` events are
 * never shadowed (DSH only shadows message-surface nodes). The name and the
 * arguments therefore exist in exactly one place -- the `tool-call` content
 * block of the assistant message that requested them -- and the block `id`
 * pairs 1:1 with `tool/result.message.toolCallId`. Reading `tool/call` events
 * instead (as this plugin first did) silently reports zero tools forever.
 */
function toolCallsOf(shadowed) {
  const calls = []
  for (const event of shadowed) {
    if (event.type === 'tool/call') {
      // Not produced by DSH today; kept so a third-party or future session shape
      // that does publish tool calls still yields a tool list.
      calls.push({
        seq: event.seq,
        id: String(event.data?.callId ?? ''),
        name: String(event.data?.name ?? 'unknown'),
        arguments: event.data?.arguments,
      })
      continue
    }
    for (const block of contentOf(event)) {
      if (!block || typeof block !== 'object') continue
      if (block.type !== 'tool-call' && block.type !== 'tool_call') continue
      calls.push({
        seq: event.seq,
        id: String(block.id ?? block.callId ?? ''),
        name: String(block.name ?? 'unknown'),
        arguments: block.arguments,
      })
    }
  }
  return calls
}

/** A filesystem-safe single path segment. */
const safeSegment = (value) => String(value ?? 'session').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)

/** Top keywords for the index row, derived from the segment text. */
function keywordsOf(text, limit = 8) {
  const counts = new Map()
  for (const token of String(text).match(/[A-Za-z_][A-Za-z0-9_]{3,}|[0-9]{5,}/g) ?? []) {
    const key = token.length > 40 ? token.slice(0, 40) : token
    if (STOPWORDS.has(key.toLowerCase())) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token)
}

/**
 * Count occurrences, most frequent first, ties broken by codepoint order.
 *
 * The tiebreak is explicit instead of being left to `Map` insertion order, and it
 * uses codepoint comparison instead of `localeCompare` so the rendered statistics
 * are byte-reproducible regardless of the host locale or of which tool happened
 * to be called first.
 */
function countBy(list) {
  const counts = new Map()
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/**
 * Read one compaction's shadowed span out of the buffer.
 * `shadowedSeqs` is authoritative when present; the recorded range is the fallback.
 */
function selectShadowed(buffer, summaryData) {
  const bySeq = (a, b) => a.seq - b.seq
  const seqs = Array.isArray(summaryData.shadowedSeqs) ? summaryData.shadowedSeqs : null
  if (seqs && seqs.length > 0) {
    const wanted = new Set(seqs.map(Number))
    // Sorted by seq: events recovered from disk are appended after live ones, and
    // the verbatim section must still read in conversation order.
    return buffer.filter((event) => wanted.has(event.seq)).sort(bySeq)
  }
  const start = Number(summaryData.shadowedRange?.start)
  const end = Number(summaryData.shadowedRange?.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return []
  return buffer.filter((event) => event.seq >= start && event.seq <= end).sort(bySeq)
}

/**
 * Append a fenced text block, or the empty placeholder when there is no text.
 *
 * The fence is made longer than any backtick run inside the text. Archived turns
 * routinely contain their own ``` code fences, and a fixed three-backtick fence
 * would both break the reader's Markdown and desynchronize any fence-aware
 * tooling that walks the file structure.
 */
function pushFenced(out, text, emptyLabel) {
  if (text === '') { out.push(emptyLabel); return }
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  out.push(`${fence}text`, text, fence)
}

/** Tool-argument keys that name the file or directory a call touched. */
const TARGET_ARG_KEYS = ['file_path', 'path', 'target_directory', 'target_file', 'directory']

/** Distinct target paths named by this span's tool calls, in first-seen order. */
function targetFilesOf(calls) {
  const ordered = []
  const seen = new Set()
  for (const call of calls) {
    const args = parseArguments(call.arguments)
    if (args === null) continue
    for (const key of TARGET_ARG_KEYS) {
      const value = args[key]
      if (typeof value !== 'string' || value.trim() === '') continue
      const normalized = value.trim()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      ordered.push(normalized)
    }
  }
  return ordered
}

/** Last assistant text in the span, one line and bounded, mirroring Cursor's excerpt field. */
function lastAssistantExcerpt(shadowed, limit = 200) {
  for (let i = shadowed.length - 1; i >= 0; i -= 1) {
    const event = shadowed[i]
    if (event.type !== 'assistant/message') continue
    const text = blocksToText(event.data?.message?.content).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  }
  return ''
}

/**
 * The call id a `tool/result` answers.
 *
 * `message.toolCallId` is the canonical field; the session validator additionally
 * pins `message.toolCallId === message.source.callId`, so the source is a safe
 * fallback for events recorded before either field is normalized.
 */
function resultCallId(event) {
  const message = event.data?.message
  const direct = message?.toolCallId
  if (typeof direct === 'string' && direct !== '') return direct
  const fromSource = message?.source?.callId
  return typeof fromSource === 'string' ? fromSource : ''
}

/** Index this span's tool results by call id so each call can pair with its response. */
function indexToolPairs(shadowed) {
  const resultByCallId = new Map()
  for (const event of shadowed) {
    if (event.type !== 'tool/result') continue
    const callId = resultCallId(event)
    if (callId !== '') resultByCallId.set(callId, event)
  }
  return { resultByCallId }
}

/** Build one segment document. Pure string work; never touches the session. */
function buildSegment({ sessionId, index, summaryEvent, shadowed, config, now }) {
  const data = summaryEvent.data ?? {}
  const summaryText = mask(blocksToText(data.summary), config.redact)
  const types = countBy(shadowed.map((event) => event.type))
  const calls = toolCallsOf(shadowed)
  const toolNames = countBy(calls.map((call) => call.name))
  const toolErrors = shadowed.filter(
    (event) => event.type === 'tool/result' && (event.data?.message?.isError === true || event.data?.error !== undefined),
  ).length
  const { resultByCallId } = indexToolPairs(shadowed)
  const targetFiles = targetFilesOf(calls)

  // Computed over the whole span, not just the rendered slice: a tail dropped by
  // `maxEventsPerSegment` must not turn a lost response into an answered one.
  const unanswered = calls.filter((call) => call.id === '' || !resultByCallId.has(call.id)).length
  const callsBySeq = new Map()
  const callSeqById = new Map()
  for (const call of calls) {
    if (!callsBySeq.has(call.seq)) callsBySeq.set(call.seq, [])
    callsBySeq.get(call.seq).push(call)
    if (call.id !== '') callSeqById.set(call.id, call.seq)
  }
  const excerpt = mask(lastAssistantExcerpt(shadowed), config.redact)

  // Redact once per event: the rendered body and the keyword source must agree,
  // otherwise a masked secret could still leak into INDEX.md keywords.
  const maskedBodies = new Map()
  const maskedBodyOf = (event) => {
    let cached = maskedBodies.get(event.seq)
    if (cached === undefined) {
      cached = mask(renderEvent(event), config.redact)
      maskedBodies.set(event.seq, cached)
    }
    return cached
  }

  // `shadowedRange` is NOT the min/max of the shadowed seqs and may not even be a
  // superset of them; measured on this session it can be inverted as well
  // (`{start:539,end:447}` for a span whose seqs run 342..539). `shadowedSeqs` is
  // authoritative, so the effective span is derived from it and both are printed:
  // copying the reported range alone silently misleads every reader.
  const shadowedSeqList = Array.isArray(data.shadowedSeqs)
    ? data.shadowedSeqs.map(Number).filter((n) => Number.isFinite(n))
    : []
  const effectiveRange = shadowedSeqList.length === 0
    ? '(none)'
    : `${Math.min(...shadowedSeqList)} - ${Math.max(...shadowedSeqList)} (${shadowedSeqList.length} seqs)`

  let omitted = 0
  let rendered = shadowed
  if (rendered.length > config.maxEventsPerSegment) {
    omitted = rendered.length - config.maxEventsPerSegment
    rendered = rendered.slice(-config.maxEventsPerSegment)
  }

  // Render the verbatim section first: its byte size is one of the reported statistics.
  const verbatim = []

  if (!config.includeToolResults) {
    verbatim.push('_Verbatim section limited to human and assistant messages (`includeToolResults: false`)._')
    verbatim.push('')
  }

  for (const event of rendered) {
    if (!config.includeToolResults && (event.type === 'tool/call' || event.type === 'tool/result')) continue
    const body = maskedBodyOf(event).trim()

    // Every event keeps its own seq-addressed block so the section stays greppable
    // and ordered; pairing is annotated in both directions instead of nesting.
    if (event.type === 'tool/call') {
      const callId = String(event.data?.callId ?? '')
      const name = String(event.data?.name ?? 'unknown')
      verbatim.push(`### seq ${event.seq} -- Tool call: ${name}${callId === '' ? '' : ` (callId ${callId})`}`)
      pushFenced(verbatim, body, '_(no arguments)_')
      const result = callId === '' ? undefined : resultByCallId.get(callId)
      verbatim.push(result === undefined ? '_(no matching tool response in this span)_' : `_(answered at seq ${result.seq})_`)
      verbatim.push('')
      continue
    }

    if (event.type === 'tool/result') {
      const callId = resultCallId(event)
      const failed = event.data?.message?.isError === true || event.data?.error !== undefined
      const callsBack = callId === '' ? undefined : callSeqById.get(callId)
      const annotations = [
        ...callId === '' ? [] : [`callId ${callId}`],
        ...callsBack === undefined ? [] : [`answers seq ${callsBack}`],
        ...failed ? ['error'] : [],
      ]
      verbatim.push(`### seq ${event.seq} -- Tool response${annotations.length === 0 ? '' : ` (${annotations.join(', ')})`}`)
      pushFenced(verbatim, body, '_(no text)_')
      verbatim.push('')
      continue
    }

    // A message-surface event carries its tool requests inline, so the request
    // never gets a block of its own: annotate both directions on this block.
    const ownCalls = callsBySeq.get(event.seq) ?? []
    const callSuffix = ownCalls.length === 0
      ? ''
      : ` (tool call${ownCalls.length > 1 ? 's' : ''}: ${ownCalls.map((call) => call.name).join(', ')})`
    verbatim.push(`### seq ${event.seq} -- ${ROLE_LABEL[event.type] ?? event.type}${callSuffix}`)
    pushFenced(verbatim, body, '_(no text)_')
    for (const call of ownCalls) {
      const result = call.id === '' ? undefined : resultByCallId.get(call.id)
      verbatim.push(result === undefined
        ? `_(tool call ${call.name} has no response in this span)_`
        : `_(tool call ${call.name} answered at seq ${result.seq})_`)
    }
    verbatim.push('')
  }
  if (omitted > 0) verbatim.push(`> ${omitted} earlier event(s) in this span were dropped by \`maxEventsPerSegment\`.`)

  const verbatimText = verbatim.join('\n')
  const verbatimBytes = Buffer.byteLength(verbatimText, 'utf8')

  const lines = []
  lines.push(`# HISTORICAL -- GENERATED, DO NOT EDIT`)
  lines.push(`# Record of compaction segment ${String(index).padStart(3, '0')} from this same task.`)
  lines.push(`# Use read or grep to look up details, but do not modify.`)
  lines.push('')
  lines.push('## Segment metadata')
  lines.push('')
  lines.push('| Field | Value |')
  lines.push('|---|---|')
  lines.push(`| Session | \`${sessionId}\` |`)
  lines.push(`| Segment index | ${String(index).padStart(3, '0')} |`)
  lines.push(`| Written | ${now} |`)
  lines.push(`| Compaction id | \`${String(data.compactionId ?? '')}\` |`)
  lines.push(`| Summary event seq | ${summaryEvent.seq} |`)
  lines.push(`| Shadowed range (reported) | ${String(data.shadowedRange?.start ?? '?')} - ${String(data.shadowedRange?.end ?? '?')} |`)
  lines.push(`| Shadowed range (effective) | ${effectiveRange} |`)
  lines.push(`| Shadowed surface events | ${Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : shadowed.length} |`)
  lines.push(`| Shadowed tokens (reported) | ${String(data.shadowedTokenCount ?? '?')} |`)
  lines.push(`| Summarizer | ${String(data.provider ?? '?')} / ${String(data.model ?? '?')} |`)
  lines.push(`| Buffered events archived | ${shadowed.length} |`)
  lines.push(`| Tool calls issued | ${calls.length} |`)
  lines.push('')
  lines.push('## Turn statistics')
  lines.push('')
  lines.push(`- Events by type: ${types.map(([type, count]) => `${type} (${count})`).join(', ') || '(none)'}`)
  lines.push(`- Tools used: ${toolNames.map(([name, count]) => `${name} (${count})`).join(', ') || '(none)'}`)
  lines.push(`- Tool calls without a response in this span: ${unanswered}`)
  lines.push(`- Tool results marked as error: ${toolErrors}`)
  const shown = targetFiles.slice(0, 5)
  const more = targetFiles.length - shown.length
  lines.push(
    `- Unique target files (${targetFiles.length}): ${targetFiles.length === 0 ? '(none)' : `${shown.join(', ')}${more > 0 ? `, ... and ${more} more` : ''}`}`,
  )
  lines.push(`- Verbatim-render size estimate: ${verbatimBytes.toLocaleString('en-US')} B`)
  lines.push(`- Last assistant response excerpt: ${excerpt === '' ? '(none)' : `"${excerpt}"`}`)
  lines.push('')
  lines.push('## Summary (curated by the compaction backend)')
  lines.push('')
  lines.push(summaryText.trim() || '(empty)')
  lines.push('')
  lines.push('## Verbatim turns')
  lines.push('')
  lines.push(verbatimText)
  lines.push('')

  const keywordSource = [summaryText, ...shadowed.map(maskedBodyOf)].join('\n')
  return {
    text: lines.join('\n'),
    types,
    toolNames,
    toolCount: calls.length,
    toolErrors,
    unanswered,
    targetFiles,
    keywords: keywordsOf(keywordSource),
  }
}

function renderIndex(rows, evictedRows = []) {
  const lines = []
  lines.push('# Compaction Archive Index')
  lines.push('')
  lines.push('Generated by `@local/dsh-memory-archive`. One row per compaction; open or grep the segment file for the full text.')
  lines.push('')
  lines.push('| Segment | File | Compaction | Shadowed seqs | Events | Tool calls | Bytes | Keywords |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const row of rows) {
    const keywords = row.keywords.map((word) => `"${word}"`).join(', ')
    lines.push(
      `| ${String(row.index).padStart(3, '0')} | \`${row.file}\` | \`${row.compactionId}\` | ${row.shadowedCount} | ${row.eventCount} | ${row.toolCount} | ${row.bytes} | ${keywords} |`,
    )
  }
  if (evictedRows.length > 0) {
    const tokens = evictedRows.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0)
    const missing = evictedRows.filter((row) => row.missing === true).length
    lines.push('')
    lines.push('## Evicted events')
    lines.push('')
    lines.push(`\`evicted.md\` holds ${evictedRows.length} event(s) that \`compaction/prune\` removed from the live`)
    lines.push(`context before any compaction could shadow them (${tokens} tokens reported). A later`)
    lines.push("compaction's `shadowedSeqs` never lists them, so no segment can contain them.")
    if (missing > 0) lines.push(`\n${missing} of them could not be recovered from the session log.`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * The pointer the model needs; without it the archive is written but never read.
 *
 * This mirrors the Cursor design, whose compaction checkpoint ends with the
 * archive glob, the INDEX path, an instruction to use read_file/grep for exact
 * code, file paths, and tool outputs, and a do-not-modify rule.
 */
function noticeText(notice) {
  const index = join(notice.dir, 'INDEX.md')
  const lines = [
    '<system-reminder>',
    'A compaction checkpoint was archived to disk together with its verbatim turns.',
    '',
    `- Index (one row per segment): ${index}`,
    `- New segment: ${join(notice.dir, notice.file)} (compaction ${notice.compactionId}, ${notice.eventCount} events, ${notice.toolCount} tool call${notice.toolCount === 1 ? '' : 's'})`,
    `- Every segment: ${join(notice.dir, 'segment_*.md')}`,
  ]
  if (notice.evictedCount > 0) {
    lines.push(`- Evicted events (removed from context by compaction/prune, in no segment): ${join(notice.dir, 'evicted.md')} (${notice.evictedCount} recovered)`)
  }
  lines.push(
    '',
    'When the checkpoint summary above is insufficient, use grep or read on those files to recover exact',
    'code, file paths, and tool outputs from the summarized span. Do not modify these files.',
    '</system-reminder>',
  )
  return lines.join('\n')
}

/** Reuse the shipped message factory when it resolves; otherwise build the same shape. */
let messageFactory
async function buildNoticeMessage(notice) {
  const content = [{ type: 'text', text: noticeText(notice) }]
  const source = { kind: 'memory-archive', form: 'notice', compactionId: notice.compactionId }
  try {
    messageFactory ??= import('@deepseek-ai/dsh-llm')
    const { createUserMessage } = await messageFactory
    if (typeof createUserMessage === 'function') return createUserMessage({ content, source })
  } catch { /* shipped package not resolvable here: fall through to the equivalent literal */ }
  // `user/message` validation requires only a non-empty id, role 'user',
  // an array content, and a source whose `kind` is a non-empty string.
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(content),
    source: Object.freeze(source),
  })
}

/**
 * Resolve the activation-marker path.
 *
 * Precedence: `DSH_MEMORY_ARCHIVE_MARKER` (tests/CI) > `config.markerFile` >
 * `_loaded.json` next to this module. The default exists because the marker is
 * the only disk evidence that *this* build is loaded; the overrides exist
 * because an installed bundle may sit in a read-only or package-managed
 * directory, and because a self-test must never delete a live install's marker.
 * An absolute value is used as-is; a relative one resolves against this module's
 * directory so it cannot depend on the session's cwd.
 */
function resolveMarkerFile(config) {
  const fromEnv = process.env.DSH_MEMORY_ARCHIVE_MARKER
  const chosen = (typeof fromEnv === 'string' && fromEnv.trim() !== '')
    ? fromEnv
    : (typeof config.markerFile === 'string' ? config.markerFile : null)
  if (chosen === null || chosen.trim() === '') return join(SELF_DIR, '_loaded.json')
  const expanded = expandPath(chosen)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(SELF_DIR, expanded)
}

export function apply(ctx, rawConfig) {
  const config = pluginConfig(rawConfig)

  // Activation marker: the plugin has no other side effect until a compaction
  // happens, so without this there is no way to tell "loaded" from "not loaded".
  //
  // `build` and `archiveDirResolved` exist to answer a question the plain marker
  // could not: the profile patch layer can re-apply this plugin without an app
  // restart, and `apply` receives its config from the loader either way. Only the
  // resolved path proves the *code* that computed it is the code on disk, so a
  // stale module cache is detectable instead of assumed away.
  try {
    const markerFile = resolveMarkerFile(config)
    mkdirSync(dirname(markerFile), { recursive: true })
    writeFileSync(
      markerFile,
      `${JSON.stringify({
        loadedAt: new Date().toISOString(),
        pid: process.pid,
        dshProfile: process.env.DSH_PROFILE ?? null,
        sessionId: process.env.DSH_SESSION_ID ?? null,
        archiveDir: config.archiveDir,
        archiveDirResolved: expandPath(config.archiveDir),
        build: BUILD,
        // Whether this runtime can actually decode a session log. zstd landed in
        // Node 22.15/23.2 and the host is Electron's own Node, so this is measured
        // rather than assumed: false means disk backfill silently degrades to the
        // deprecated in-memory reader.
        capabilities: { zstd: typeof zlib.zstdDecompressSync === 'function' },
        announce: config.announce,
        // Where this file was written, so a redirected marker is self-describing.
        markerFile,
      }, null, 2)}\n`,
      'utf8',
    )
  } catch { /* a read-only install location must not break activation */ }

  /** session id -> { buffer: event[], archived: Set<string>, pendingNotice?: object } */
  const sessions = new Map()
  /** session id -> agent, learned from tool executions (the pre-step payload may omit it). */
  const agentBySession = new Map()
  /** Serializes writes so two compactions cannot interleave one INDEX.md. */
  let queue = Promise.resolve()
  /** session id -> resolved session-log path (null when not found). */
  const sessionLogPaths = new Map()

  function archiveRoot(session) {
    const cwd = typeof session?.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : process.cwd()
    // An expanded absolute archiveDir wins over the session cwd inside `resolve`.
    return resolve(cwd, expandPath(config.archiveDir))
  }

  function loadArchived(dir) {
    const archived = new Set()
    const indexFile = join(dir, 'index.jsonl')
    if (!existsSync(indexFile)) return archived
    try {
      for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          const row = JSON.parse(line)
          if (row?.compactionId) archived.add(String(row.compactionId))
        } catch { /* ignore a torn line */ }
      }
    } catch { /* unreadable index: start fresh rather than fail the session */ }
    return archived
  }

  /** One session's archive state: the live buffer, its seq index, and its notice slot. */
  function newState(session) {
    const id = String(session?.id ?? 'session')
    const dir = join(archiveRoot(session), safeSegment(id))
    return {
      buffer: [],
      seenSeqs: new Set(),
      archived: loadArchived(dir),
      evictedSeqs: loadEvictedSeqs(dir),
      pendingNotice: undefined,
      snapshotRead: false,
    }
  }

  /** Resolve (and cache) the on-disk log for a session. */
  function resolveSessionLog(session) {
    const id = String(session?.id ?? '')
    if (id === '') return null
    if (sessionLogPaths.has(id)) return sessionLogPaths.get(id)
    const root = resolve(process.cwd(), expandPath(config.sessionRoot))
    const found = findSessionLog(root, id)
    sessionLogPaths.set(id, found)
    return found
  }

  /**
   * Make sure the buffer holds the events a segment is about to render.
   *
   * Preference order:
   *   1. the session log on disk -- complete, append-only, holds events that have
   *      already left the model's context, and depends on no API at all;
   *   2. `session.snapshotEvents()`, which DSH marks deprecated for production use;
   *   3. live-only buffering, which loses whatever predates the mount.
   *
   * This is deliberately lazy: nothing is read unless a segment actually needs a
   * seq the buffer never saw, so a normal boot with an unbroken feed costs no IO.
   */
  function ensureLoaded(state, session, wanted) {
    const stillMissing = () => {
      for (const seq of wanted) if (!state.seenSeqs.has(seq)) return true
      return false
    }
    if (wanted.size === 0 || !stillMissing()) return

    if (config.readSessionLog === true) {
      const file = resolveSessionLog(session)
      if (file !== null) {
        try {
          const text = decodeSessionLog(readFileSync(file))
          for (const event of parseSessionLog(text, wanted)) {
            if (ARCHIVED_TYPES.has(event.type)) pushBuffered(state, event)
          }
        } catch { /* unreadable log: fall back to the in-memory readers */ }
        if (!stillMissing()) return
      }
    }

    if (!state.snapshotRead) {
      state.snapshotRead = true
      if (typeof session?.snapshotEvents === 'function') {
        try {
          const snapshot = session.snapshotEvents(0, session.seq)
          if (Array.isArray(snapshot)) {
            for (const event of snapshot) {
              if (event !== null && event !== undefined && ARCHIVED_TYPES.has(event.type)) pushBuffered(state, event)
            }
          }
        } catch { /* degrade to live-only buffering rather than break the session */ }
      }
    }
  }

  /** Buffer one event, dropping exact seq duplicates and trimming to the cap. */
  function pushBuffered(state, event) {
    const seq = event?.seq
    if (seq !== undefined && seq !== null) {
      if (state.seenSeqs.has(seq)) return
      state.seenSeqs.add(seq)
    }
    state.buffer.push({ seq, type: event.type, data: event.data })
    const overflow = state.buffer.length - config.maxEventsPerSession
    if (overflow > 0) {
      for (const dropped of state.buffer.splice(0, overflow)) {
        if (dropped.seq !== undefined && dropped.seq !== null) state.seenSeqs.delete(dropped.seq)
      }
    }
  }

  /** Read a JSONL state file, tolerating torn lines. */
  function readJsonlRows(file) {
    const rows = []
    if (!existsSync(file)) return rows
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try { rows.push(JSON.parse(line)) } catch { /* ignore a torn line */ }
      }
    } catch { /* unreadable state: treat as empty rather than break the session */ }
    return rows
  }

  /** Every seq already written to `evicted.md`, per its own `evicted.jsonl` ledger. */
  function loadEvictedSeqs(dir) {
    const seen = new Set()
    for (const row of readJsonlRows(join(dir, 'evicted.jsonl'))) {
      const seq = Number(row?.seq)
      if (Number.isFinite(seq)) seen.add(seq)
    }
    return seen
  }

  const EVICTED_HEADER = [
    '# HISTORICAL -- GENERATED, DO NOT EDIT',
    '# Events DSH removed from the live context with `compaction/prune`.',
    '# A later compaction\'s `shadowedSeqs` never lists them (they are already off the',
    '# surface when it runs), so no segment can contain them. This file is the only',
    '# archive of what the model actually saw.',
    '# Use read or grep to look up details, but do not modify.',
    '',
    '## Evicted events',
    '',
  ].join('\n')

  /**
   * Append the events `compaction/prune` evicted to `evicted.md`.
   *
   * Folding them into the next segment would be tidier, but measured on this
   * machine one of the four sessions that prune has *no compaction at all*, so its
   * evicted content would never be written anywhere. A dedicated append-only
   * ledger has no such dependency.
   */
  function writeEvicted(session, state, pruneEvent, seqs) {
    const dir = join(archiveRoot(session), safeSegment(String(session?.id ?? 'session')))
    const pending = seqs.filter((seq) => !state.evictedSeqs.has(seq))
    if (pending.length === 0) return 0
    mkdirSync(dir, { recursive: true })
    ensureLoaded(state, session, new Set(pending))

    const bySeq = new Map()
    for (const event of state.buffer) bySeq.set(event.seq, event)

    // A prune carries one seq in practice; with several, the reported token count
    // cannot be split, so it is attributed only when it is unambiguous.
    const reported = Number(pruneEvent.data?.shadowedTokenCount) || 0
    const perEvent = pending.length === 1 ? reported : 0
    const now = new Date().toISOString()
    const ledger = readJsonlRows(join(dir, 'evicted.jsonl'))
    const blocks = []
    let written = 0

    for (const seq of pending) {
      state.evictedSeqs.add(seq)
      const event = bySeq.get(seq)
      if (event === undefined) {
        // Record the gap instead of quietly implying the content was archived.
        ledger.push({ seq, atSeq: pruneEvent.seq, tokens: perEvent, bytes: 0, writtenAt: now, missing: true })
        blocks.push(`### seq ${seq} -- (not recoverable)`)
        blocks.push(`_(evicted by \`compaction/prune\` at seq ${pruneEvent.seq}, but absent from the session log)_`)
        blocks.push('')
        continue
      }
      const body = mask(renderEvent(event), config.redact).trim()
      const label = ROLE_LABEL[event.type] ?? event.type
      blocks.push(`### seq ${seq} -- ${label} (evicted by compaction/prune at seq ${pruneEvent.seq}${perEvent > 0 ? `, ${perEvent} tokens` : ''})`)
      pushFenced(blocks, body, '_(no text)_')
      blocks.push('')
      ledger.push({ seq, atSeq: pruneEvent.seq, tokens: perEvent, bytes: Buffer.byteLength(body, 'utf8'), writtenAt: now })
      written += 1
    }

    const file = join(dir, 'evicted.md')
    const chunk = `${blocks.join('\n')}\n`
    writeFileSync(file, existsSync(file) ? readFileSync(file, 'utf8') + chunk : `${EVICTED_HEADER}${chunk}`, 'utf8')
    writeFileSync(join(dir, 'evicted.jsonl'), `${ledger.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    writeFileSync(join(dir, 'INDEX.md'), renderIndex(readJsonlRows(join(dir, 'index.jsonl')), ledger), 'utf8')
    return written
  }

  function writeSegment(session, state, summaryEvent) {
    const sessionId = String(session?.id ?? 'session')
    const dir = join(archiveRoot(session), safeSegment(sessionId))
    mkdirSync(dir, { recursive: true })

    const indexFile = join(dir, 'index.jsonl')
    const rows = []
    if (existsSync(indexFile)) {
      for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try { rows.push(JSON.parse(line)) } catch { /* ignore */ }
      }
    }

    const index = rows.length
    const wanted = new Set(
      Array.isArray(summaryEvent.data?.shadowedSeqs) ? summaryEvent.data.shadowedSeqs.map(Number) : [],
    )
    ensureLoaded(state, session, wanted)
    const shadowed = selectShadowed(state.buffer, summaryEvent.data ?? {})
    const built = buildSegment({
      sessionId,
      index,
      summaryEvent,
      shadowed,
      config,
      now: new Date().toISOString(),
    })

    let text = built.text
    let bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > config.maxSegmentBytes) {
      text = `${text.slice(0, config.maxSegmentBytes)}\n\n> TRUNCATED at maxSegmentBytes=${config.maxSegmentBytes}.\n`
      bytes = Buffer.byteLength(text, 'utf8')
    }

    const file = `segment_${String(index).padStart(3, '0')}.md`
    writeFileSync(join(dir, file), text, 'utf8')

    rows.push({
      index,
      file,
      compactionId: String(summaryEvent.data?.compactionId ?? ''),
      shadowedCount: Array.isArray(summaryEvent.data?.shadowedSeqs) ? summaryEvent.data.shadowedSeqs.length : shadowed.length,
      eventCount: shadowed.length,
      toolCount: built.toolCount,
      bytes,
      toolErrors: built.toolErrors,
      keywords: built.keywords,
      writtenAt: new Date().toISOString(),
    })
    writeFileSync(indexFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    const evictedRows = readJsonlRows(join(dir, 'evicted.jsonl'))
    writeFileSync(join(dir, 'INDEX.md'), renderIndex(rows, evictedRows), 'utf8')
    return {
      dir,
      file,
      compactionId: String(summaryEvent.data?.compactionId ?? ''),
      eventCount: shadowed.length,
      toolCount: built.toolCount,
      evictedCount: evictedRows.filter((row) => row.missing !== true).length,
    }
  }

  function enqueue(work) {
    queue = queue.then(work).catch(() => { /* containment: never break the session event path */ })
    return queue
  }

  ctx.on('session/created', (session) => {
    try {
      const id = String(session?.id ?? 'session')
      sessions.set(id, newState(session))
    } catch { /* ignore */ }
  }, { global: true })

  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const id = String(session.id ?? 'session')
      let state = sessions.get(id)
      if (!state) {
        state = newState(session)
        sessions.set(id, state)
      }
      // History the plugin never witnessed needs no eager adoption: every writer
      // lazily pulls only the seqs it is about to render (see `ensureLoaded`).

      if (ARCHIVED_TYPES.has(event.type)) {
        pushBuffered(state, event)
        return
      }

      // `compaction/prune` is a second way content leaves the live context, and the
      // only way to lose it for good: it removes the event *before* any compaction
      // can list it in `shadowedSeqs`. Measured here: 84 such events across 4
      // sessions, none of them in any segment, one session never compacting at all.
      if (event.type === 'compaction/prune') {
        const seqs = Array.isArray(event.data?.shadowedSeqs) ? event.data.shadowedSeqs.map(Number) : []
        if (seqs.length === 0) return
        // No notice here on purpose: the pointer only makes sense next to a new
        // segment, and the next segment's notice reports the evicted count.
        enqueue(() => { writeEvicted(session, state, event, seqs) })
        return
      }

      if (event.type !== 'compaction/summary') return
      const compactionId = String(event.data?.compactionId ?? '')
      if (compactionId !== '' && state.archived.has(compactionId)) return
      if (compactionId !== '') state.archived.add(compactionId)

      enqueue(() => {
        const written = writeSegment(session, state, event)
        if (config.announce && written) state.pendingNotice = written
      })
    } catch { /* ignore */ }
  }, { global: true })

  // Tool executions carry the agent; the `agent/pre-step` payload may omit it.
  ctx.on('tools/result', (exec) => {
    try {
      const agent = exec?.agent
      if (agent?.session) agentBySession.set(String(agent.session.id), agent)
    } catch { /* ignore */ }
  }, { global: true })

  /**
   * Deliver the pointer at the next step boundary.
   *
   * Preferred delivery is the durable inbox, which records an
   * `agent/inbox/spliced` event and is claimed at the next boundary. When the
   * inbox is unavailable the message is spliced into the entering batch
   * instead, which still reaches the model from the same step.
   */
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (!config.announce) return decision
      if (!decision || decision.kind !== 'enter') return decision

      let agent = payload?.agent
      let state
      if (agent?.session) state = sessions.get(String(agent.session.id))
      let sessionId
      if (state === undefined) {
        // The payload carried no agent: fall back to the single outstanding notice.
        const outstanding = [...sessions.entries()].filter(([, value]) => value.pendingNotice)
        if (outstanding.length !== 1) return decision
        sessionId = outstanding[0][0]
        state = outstanding[0][1]
      }
      const notice = state?.pendingNotice
      if (!notice) return decision

      agent ??= sessionId === undefined ? undefined : agentBySession.get(sessionId)
      const message = await buildNoticeMessage(notice)
      state.pendingNotice = undefined
      if (typeof agent?.inbox?.prepend === 'function') {
        agent.inbox.prepend('next-step', message)
        return decision
      }
      return { ...decision, messages: [message, ...decision.messages] }
    } catch {
      return decision
    }
  })
}
