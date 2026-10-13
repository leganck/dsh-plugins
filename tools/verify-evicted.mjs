/**
 * Independently verify `evicted.md` against the raw session log.
 *
 * Re-implements the counting from the log rather than trusting the plugin, and
 * judges coverage twice: structurally (a `### seq N` block outside any fence) and
 * textually (a distinctive middle slice of the body), because substring probes
 * have produced false results repeatedly in this project.
 *
 * Usage: node verify-evicted.mjs <archiveSessionDir> [sessionsRoot]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SEG_DIR = process.argv[2]
if (!SEG_DIR) throw new Error('usage: verify-evicted.mjs <archiveSessionDir> [sessionsRoot]')
const SESSION_ID = path.basename(SEG_DIR)
const SESSIONS_ROOT = process.argv[3] ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeSessionLog(file) {
  const buf = fs.readFileSync(file)
  const offsets = []
  let at = 0
  for (;;) {
    const found = buf.indexOf(MAGIC, at)
    if (found === -1) break
    offsets.push(found)
    at = found + MAGIC.length
  }
  const chunks = []
  let index = 0
  while (index < offsets.length) {
    let end = index + 1
    let decoded
    for (;;) {
      const stop = end < offsets.length ? offsets[end] : buf.length
      try { decoded = zlib.zstdDecompressSync(buf.subarray(offsets[index], stop)); break } catch (error) {
        if (end >= offsets.length) throw error
        end += 1
      }
    }
    chunks.push(decoded)
    index = end
  }
  return Buffer.concat(chunks).toString('utf8')
}

function findLog(root, id) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, id, 'session.v4.jsonl.zstd')
    if (fs.existsSync(file)) return file
  }
  return null
}

/** true for every line that is a fence delimiter or fence content. */
function fenceMap(lines) {
  const fenced = new Array(lines.length).fill(false)
  let open = 0
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k]
    if (open === 0) {
      const m = /^(`{3,})([A-Za-z0-9]*)\s*$/.exec(line)
      if (m) { fenced[k] = true; open = m[1].length }
      continue
    }
    fenced[k] = true
    if (new RegExp(`^\`{${open},}\\s*$`).test(line)) open = 0
  }
  return fenced
}

const logFile = findLog(SESSIONS_ROOT, SESSION_ID)
if (logFile === null) throw new Error(`no log for ${SESSION_ID} under ${SESSIONS_ROOT}`)
const rows = decodeSessionLog(logFile).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
const bySeq = new Map(rows.map((r) => [r.seq, r]))
const bodyOf = (row) => {
  const c = row.type === 'user/message' ? row.data?.content : row.data?.message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.filter((b) => b?.type === 'text' || b?.type === 'tool-call').map((b) => b.text ?? '').join('\n')
}

const pruneEvents = rows.filter((r) => r.type === 'compaction/prune')
const expected = pruneEvents.flatMap((r) => r.data?.shadowedSeqs ?? []).map(Number)
const expectedTokens = pruneEvents.reduce((sum, r) => sum + (r.data?.shadowedTokenCount ?? 0), 0)

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ${detail}`}`)
}

console.log(`session ${SESSION_ID}`)
console.log(`log prunes=${pruneEvents.length}  pruned events=${expected.length}  reported tokens=${expectedTokens}`)

const evictedFile = path.join(SEG_DIR, 'evicted.md')
const ledgerFile = path.join(SEG_DIR, 'evicted.jsonl')
const indexFile = path.join(SEG_DIR, 'INDEX.md')

if (expected.length === 0) {
  check('a session with no prunes has no evicted.md', !fs.existsSync(evictedFile))
  console.log(failures === 0 ? '\nALL EVICTED CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

const text = fs.existsSync(evictedFile) ? fs.readFileSync(evictedFile, 'utf8') : ''
const lines = text.split('\n')
const fenced = fenceMap(lines)
const blocks = new Map()
for (let k = 0; k < lines.length; k += 1) {
  if (fenced[k]) continue
  const m = /^### seq (\d+) -- (.+)$/.exec(lines[k])
  if (m) blocks.set(Number(m[1]), m[2])
}

const missing = expected.filter((seq) => !blocks.has(seq))
const extra = [...blocks.keys()].filter((seq) => !expected.includes(seq))
check('every pruned event has a block in evicted.md', missing.length === 0, `missing=${missing.length} ${missing.slice(0, 10)}`)
check('evicted.md holds no block that is not a pruned event', extra.length === 0, `extra=${extra.slice(0, 10)}`)

// Compare with whitespace runs collapsed on BOTH sides: the log body is raw while
// the archive may have been re-wrapped, and an earlier version of this check
// normalised only one side, which reported misses for any slice spanning a newline.
//
// Several slices per event, because a single mid-slice can legitimately differ:
// the archive is redacted, so a slice that overlaps a masked secret will not match
// (measured: one such miss, whose slice began inside `5nKEYG-...`).
const normalize = (s) => String(s).replace(/\s+/g, ' ').trim()
const normalizedText = normalize(text)
let textMisses = 0
const missDetail = []
for (const seq of expected) {
  const row = bySeq.get(seq)
  const body = normalize(bodyOf(row))
  if (body.length < 60) continue
  const at = [0.2, 0.35, 0.5, 0.65, 0.8].map((f) => Math.floor(body.length * f) - 25)
  const hit = at.some((start) => {
    const slice = body.slice(Math.max(0, start), Math.max(0, start) + 50)
    return slice.length >= 30 && normalizedText.includes(slice)
  })
  if (hit) continue
  textMisses += 1
  missDetail.push(`seq ${seq}: "${body.slice(Math.floor(body.length / 2) - 25, Math.floor(body.length / 2) + 25)}"`)
}
check('bodies are recoverable verbatim (multiple slices sampled)', textMisses === 0, `${textMisses} miss\n      ${missDetail.join('\n      ')}`)

const masks = (text.match(/\*\*\*(?:JWT|TOKEN|REDACTED)\*\*\*/g) ?? []).length
console.log(`\nredaction markers in evicted.md: ${masks}  (redaction is applied to archived bodies)`)

const ledger = fs.existsSync(ledgerFile)
  ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
  : []
check('evicted.jsonl has one row per pruned event', ledger.length === expected.length, `${ledger.length} vs ${expected.length}`)
check('every ledger seq is a pruned seq', ledger.every((row) => expected.includes(Number(row.seq))))
const covered = ledger.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0)
console.log(`\nevicted.md ${fs.statSync(evictedFile).size} B   verbatim body bytes=${covered}   reported pruned tokens=${expectedTokens}`)
check('INDEX.md documents the evicted set', fs.existsSync(indexFile) && fs.readFileSync(indexFile, 'utf8').includes('## Evicted events'))
const sampleSeq = expected[0]
check('the first block names the prune that evicted it', /\{2,}/.test(String(blocks.get(sampleSeq))) || /evicted by compaction\/prune at seq \d+/.test(String(blocks.get(sampleSeq))))

console.log(failures === 0 ? '\nALL EVICTED CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
