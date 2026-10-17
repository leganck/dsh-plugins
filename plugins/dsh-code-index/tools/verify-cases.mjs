import fs from 'node:fs'
import path from 'node:path'

const casesFile = process.argv[2]
const repoRoot = process.argv[3]
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'))

const files = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else files.push(p.replace(/\\/g, '/'))
  }
})(repoRoot)

const missing = cases.filter(([, exp]) => !files.some((f) => f.includes(exp)))
const dup = cases.map(([, exp]) => exp).filter((v, i, a) => a.indexOf(v) !== i)
console.log(JSON.stringify({ cases: cases.length, repo_files: files.length, missing: missing.map((m) => m[1]), duplicates: dup }, null, 1))
