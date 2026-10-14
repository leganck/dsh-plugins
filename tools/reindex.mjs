/**
 * Rebuild the `keywords` of archives written by an older extractor.
 *
 * A row's keywords are final once written, so improving the extractor does not
 * reach archives that already exist. Everything needed to recompute them is still on
 * disk: the segment file holds the curated summary plus the masked verbatim turns,
 * which is exactly the source the live write path feeds to the extractor.
 *
 * Only `index.jsonl` and `INDEX.md` are rewritten. Segment files are read only, no
 * other file in the archive is touched, and the first rewrite of each output keeps a
 * `.bak` copy beside it.
 *
 * Rows already stamped with the current `keywordsVersion` are skipped, so a repeat
 * run is a no-op; `--force` recomputes them anyway.
 *
 * Usage: node reindex.mjs [--archive <dir>] [--session <id>] [--dry-run] [--force]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'index.js')

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)

const defaultArchive = () => {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'archive')
}
const archiveRoot = path.resolve(argOf('archive', defaultArchive()))
const onlySession = argOf('session', null)
const dryRun = flag('dry-run')
const force = flag('force')

const {
  KEYWORDS_VERSION, keywordsOf, keywordNoiseForArchived, renderIndex,
} = await import(pathToFileURL(PLUGIN).href)

/**
 * The keyword source inside a written segment.
 *
 * A segment is a header (metadata and turn statistics), then the curated summary,
 * then the verbatim turns. Only the latter two are tokenized, matching the live path,
 * which also excludes its own metadata: the header names tool counts and absolute
 * paths, and those would otherwise outrank real content. The section headings
 * themselves are dropped too, so `summary` cannot take a slot just for being a
 * heading the plugin wrote.
 */
const SUMMARY_HEADING = '## Summary (curated by the compaction backend)'
const VERBATIM_HEADING = '## Verbatim turns'
const keywordSourceOf = (text) => {
  const at = text.indexOf(SUMMARY_HEADING)
  if (at === -1) return text
  return text.slice(at + SUMMARY_HEADING.length).replace(VERBATIM_HEADING, '\n')
}

const readJsonl = (file) => {
  if (!fs.existsSync(file)) return []
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { rows.push(JSON.parse(line)) } catch { /* a damaged line cannot be reindexed */ }
  }
  return rows
}

/** Write once per run, keeping the pre-reindex content beside it. */
function writeWithBackup(file, text) {
  if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`)
  fs.writeFileSync(file, text, 'utf8')
}

const show = (list) => (list.length === 0 ? '(none)' : list.join(', '))

if (!fs.existsSync(archiveRoot)) throw new Error(`no archive root at ${archiveRoot}`)
const sessions = fs.readdirSync(archiveRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => onlySession === null || name === onlySession)
  .sort()

console.log(`archive root : ${archiveRoot}`)
console.log(`plugin       : ${PLUGIN}`)
console.log(`keywords v${KEYWORDS_VERSION}${dryRun ? '   (dry run: nothing is written)' : ''}${force ? '   (force: recomputing current rows)' : ''}`)
console.log(`sessions     : ${sessions.length}${onlySession === null ? '' : ` (filtered to ${onlySession})`}`)

let rewritten = 0
let changedRows = 0
let currentRows = 0
let skippedRows = 0
let withoutLog = 0

for (const sessionId of sessions) {
  const dir = path.join(archiveRoot, sessionId)
  const indexFile = path.join(dir, 'index.jsonl')
  const rows = readJsonl(indexFile)
  if (rows.length === 0) continue

  const { noise, cwd, log } = keywordNoiseForArchived(sessionId)
  if (log === null) withoutLog += 1
  let touched = false

  for (const row of rows) {
    if (row.keywordsVersion === KEYWORDS_VERSION && !force) {
      currentRows += 1
      continue
    }
    const file = path.join(dir, String(row.file ?? ''))
    if (!fs.existsSync(file)) {
      console.log(`  ! ${sessionId}/${row.file}: segment file missing, row left as is`)
      skippedRows += 1
      continue
    }
    const next = keywordsOf(keywordSourceOf(fs.readFileSync(file, 'utf8')), undefined, noise)
    const before = Array.isArray(row.keywords) ? row.keywords : []
    if (before.join('\u0000') === next.join('\u0000')) {
      currentRows += 1
      touched = true // still needs the version stamp
      row.keywords = next
      row.keywordsVersion = KEYWORDS_VERSION
      continue
    }
    row.keywords = next
    row.keywordsVersion = KEYWORDS_VERSION
    row.keywordsAt = new Date().toISOString()
    changedRows += 1
    touched = true
    console.log(`\n  ${sessionId}/${row.file}`)
    console.log(`    before: ${show(before)}`)
    console.log(`    after : ${show(next)}`)
  }

  if (!touched) continue
  console.log(`\n  ${sessionId}: ${rows.length} row(s), cwd ${cwd === '' ? '(log unavailable, home-directory noise only)' : `\`${cwd}\``}`)
  if (dryRun) {
    rewritten += 1
    continue
  }
  // A live session may have appended a segment while this run was reading. Re-read
  // and keep every row the snapshot does not know about, so reindexing a session that
  // is still being written can never drop a segment. Such a row keeps its old
  // keywords and version stamp, and one more run brings it up to date.
  const latest = readJsonl(indexFile)
  const seen = new Set(rows.map((row) => row.index))
  writeWithBackup(indexFile, `${[...rows, ...latest.filter((row) => !seen.has(row.index))]
    .map((row) => JSON.stringify(row)).join('\n')}\n`)
  writeWithBackup(path.join(dir, 'INDEX.md'), renderIndex(
    [...rows, ...latest.filter((row) => !seen.has(row.index))].sort((left, right) => left.index - right.index),
    readJsonl(path.join(dir, 'evicted.jsonl')),
  ))
  rewritten += 1
}

console.log(`\n${dryRun ? 'would rewrite' : 'rewrote'} ${rewritten} archive(s); ${changedRows} row(s) changed, ${currentRows} already current, ${skippedRows} skipped`)
if (withoutLog > 0) console.log(`${withoutLog} session(s) have no readable log; their rows used home-directory noise only`)
if (rewritten > 0 && !dryRun) console.log('each rewritten file kept a `.bak` copy of its previous content')
