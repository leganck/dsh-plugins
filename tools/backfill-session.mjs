/**
 * Retro-archive any DSH session from its on-disk log.
 *
 * This is the "the plugin was not installed yet" path, and it doubles as the
 * end-to-end test of the disk reader: only the *control* events (compaction
 * summaries and prunes) are fed to the plugin, so every archived body must be
 * recovered from the session log. No `snapshotEvents` is provided at all.
 *
 * Usage: node backfill-session.mjs [--session <id>] [--out <dir>] [--sessions <root>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'index.js')

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const sessionsRoot = argOf('sessions', path.join(os.homedir(), '.dsh', 'sessions'))

/**
 * Newest session log under `<root>/<slug>/<id>/`, so the tool is usable without
 * knowing or hardcoding a session id.
 */
function newestSession(root) {
  let best = null
  for (const slug of fs.readdirSync(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue
    for (const entry of fs.readdirSync(path.join(root, slug.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(root, slug.name, entry.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      const mtime = fs.statSync(file).mtimeMs
      if (best === null || mtime > best.mtime) best = { id: entry.name, mtime }
    }
  }
  return best
}

let sessionId = argOf('session', null)
if (sessionId === null) {
  const newest = newestSession(sessionsRoot)
  if (newest === null) throw new Error(`no session logs under ${sessionsRoot}; pass --session <id>`)
  sessionId = newest.id
  console.log(`no --session given; using the most recently written session: ${sessionId}`)
}
const outRoot = argOf('out', null)

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

const logFile = findLog(sessionsRoot, sessionId)
if (logFile === null) throw new Error(`no session log for ${sessionId} under ${sessionsRoot}`)
const rows = decodeSessionLog(logFile).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
console.log(`session ${sessionId}`)
console.log(`  log: ${logFile}  (${fs.statSync(logFile).size} B compressed, ${rows.length} events)`)

const control = rows.filter((r) => r.type === 'compaction/summary' || r.type === 'compaction/prune')
const expectedSegments = control.filter((r) => r.type === 'compaction/summary').length
const expectedEvicted = control.filter((r) => r.type === 'compaction/prune')
  .flatMap((r) => r.data?.shadowedSeqs ?? []).length
console.log(`  control events: ${control.length} (${expectedSegments} compactions, ${expectedEvicted} pruned events)`)

const stem = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backfill-'))
const out = outRoot === null ? path.join(stem, 'archive') : outRoot
fs.copyFileSync(PLUGIN, path.join(stem, 'index.js'))

const session = { id: sessionId, header: { cwd: stem }, seq: rows[rows.length - 1].seq + 1 }
const handlers = new Map()
const { apply } = await import(pathToFileURL(path.join(stem, 'index.js')).href)
apply({ on: (name, fn) => { handlers.set(name, fn) } }, {
  archiveDir: out, sessionRoot: sessionsRoot, includeToolResults: true, redact: true, announce: false,
})
handlers.get('session/created')(session)
for (const event of control) handlers.get('session/event')(session, event)

const dir = path.join(out, sessionId)
const count = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0)
for (let waited = 0; waited < 30000; waited += 250) {
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (count(path.join(dir, 'index.jsonl')) >= expectedSegments && count(path.join(dir, 'evicted.jsonl')) >= expectedEvicted) break
}

console.log(`\n  wrote to ${dir}`)
for (const name of fs.readdirSync(dir).sort()) {
  console.log(`    ${name.padEnd(16)} ${String(fs.statSync(path.join(dir, name)).size).padStart(9)} B`)
}
const segments = count(path.join(dir, 'index.jsonl'))
const evicted = count(path.join(dir, 'evicted.jsonl'))
console.log(`\n  segments=${segments}/${expectedSegments}  evicted=${evicted}/${expectedEvicted}`)
console.log(`  marker pollution: ${fs.existsSync(path.join(stem, '_loaded.json')) ? 'temp only (expected)' : 'NONE (unexpected)'}`)
console.log(`\nBACKFILL_DIR=${dir}`)
