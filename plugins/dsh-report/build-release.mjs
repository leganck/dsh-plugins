/**
 * 打发布产物：npm pack --ignore-scripts → release/local-dsh-report-<version>.tgz。
 *
 * release/*.tgz 是构建产物、不进 git；只保留 release/SHA256SUMS.txt 作为版本与校验记录。
 * 用法：node build-release.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const releaseDir = path.join(PLUGIN_DIR, 'release')
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))
const baseName = `local-dsh-report-${pkg.version}`

fs.mkdirSync(releaseDir, { recursive: true })
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const out = path.join(PLUGIN_DIR, `${baseName}.tgz`)
fs.rmSync(out, { force: true })
execFileSync('npm pack --ignore-scripts', { cwd: PLUGIN_DIR, stdio: ['ignore', 'ignore', 'inherit'], shell: true })
if (!fs.existsSync(out)) throw new Error(`npm pack 没有产出 ${out}`)

const dst = path.join(releaseDir, `${baseName}.tgz`)
fs.renameSync(out, dst)
console.log(`  ✅ ${path.basename(dst)}  ${(fs.statSync(dst).size / 1024).toFixed(0)} KB`)

const lines = []
for (const file of fs.readdirSync(releaseDir).filter((name) => name.endsWith('.tgz')).sort()) {
  const full = path.join(releaseDir, file)
  lines.push(`${sha256(full)}  ${file}  ${fs.statSync(full).size}`)
}
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
