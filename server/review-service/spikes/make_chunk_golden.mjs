/**
 * P0 spike：用插件（JS）的 chunker 生成 golden 夹具，供 Python 版 chunker 做 parity 测试。
 *
 * 用法：
 *   node spikes/make_chunk_golden.mjs --deps "%LOCALAPPDATA%\dsh-code-index\embed-deps" \
 *        --out tests/fixtures/chunk-golden.json
 *
 * 采样策略（保证多语言，且文件不超过 256 KB）：
 *   JS/TS  : 插件自身 lib/*.js
 *   Python : review-service/app/*.py
 *   Go     : 指定仓库里前 N 个 .go（--go <dir>）
 * 每个文件记录：策略（ast/heuristic）、块数、每块起止行与 hash —— parity 只比边界与块数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { chunkFile } from '../../../plugins/dsh-code-index/lib/chunker.js'

const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}

const depsDir = arg('--deps')
const outPath = arg('--out', 'tests/fixtures/chunk-golden.json')
const goDir = arg('--go')
const maxBytes = Number(arg('--max-bytes', 256 * 1024))
const perLang = Number(arg('--per-lang', 10))

if (!depsDir) {
  console.error('缺少 --deps <tree-sitter 依赖目录>')
  process.exit(2)
}

const LANG_BY_EXT = { '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'tsx', '.py': 'python', '.go': 'go', '.java': 'java' }

const list = (dir, ext) => {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (ext.includes(path.extname(e.name))) out.push(p)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out.sort()
}

const picks = []
const root = 'D:/Projects/GolandProjects/dsh-plugins'
// 每个采样点带上"逻辑仓库名 + 仓库内相对路径"，parity 时按仓库映射回真实路径
const add = (repoName, repoRoot, candidates) => {
  for (const abs of candidates) picks.push({ repo: repoName, root: repoRoot, abs })
}
add('dsh-plugins', root, list(path.join(root, 'plugins/dsh-code-index/lib'), ['.js', '.mjs']).slice(0, perLang))
add('dsh-plugins', root, list(path.join(root, 'plugins/dsh-multiroot'), ['.js', '.mjs']).slice(0, perLang))
add('dsh-plugins', root, list(path.join(root, 'server/review-service/app'), ['.py']).slice(0, perLang))
add('dsh-plugins', root, list(path.join(root, 'server/code-index-service'), ['.py']).slice(0, perLang))
if (goDir) add('energy', path.resolve(goDir), list(goDir, ['.go']).slice(0, perLang))

const files = []
const skipped = []
for (const pick of picks) {
  const { repo, root: repoRoot, abs } = pick
  const rel = abs.replace(/\\/g, '/').slice(repoRoot.replace(/\\/g, '/').length + 1)
  const ext = path.extname(abs).toLowerCase()
  const lang = LANG_BY_EXT[ext] || 'unknown'
  let text
  try {
    const st = fs.statSync(abs)
    if (st.size > maxBytes) {
      skipped.push({ path: rel, reason: `>${Math.round(maxBytes / 1024)}KB` })
      continue
    }
    text = fs.readFileSync(abs, 'utf8')
  } catch (e) {
    skipped.push({ path: rel, reason: String(e.message) })
    continue
  }
  const crypto = await import('node:crypto')
  const textHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
  const r = chunkFile({ relPath: rel, text, chunking: {}, depsDir })
  files.push({
    path: rel,
    repo,
    language: lang,
    bytes: Buffer.byteLength(text),
    lines: text.split('\n').length,
    textHash,
    strategy: r.strategy,
    fellBack: r.fellBack,
    fallbackReason: r.reason ?? null,
    chunkCount: r.chunks.length,
    chunks: r.chunks.map((c) => ({ start: c.startLine, end: c.endLine, hash: c.hash })),
  })
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    generator: 'spikes/make_chunk_golden.mjs',
    depsDir,
    node: process.version,
    note: 'golden 由插件（JS）chunker 生成；Python 版 chunker 的 parity 目标：块数一致、块边界 ≥95% 相同',
  },
  totals: {
    files: files.length,
    chunks: files.reduce((a, f) => a + f.chunkCount, 0),
    byStrategy: files.reduce((a, f) => ((a[f.strategy] = (a[f.strategy] || 0) + 1), a), {}),
    byLanguage: files.reduce((a, f) => ((a[f.language] = (a[f.language] || 0) + 1), a), {}),
  },
  skipped,
  files,
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n')
console.log(
  `golden 写出：${outPath}  文件 ${payload.totals.files}，块 ${payload.totals.chunks}，` +
    `策略 ${JSON.stringify(payload.totals.byStrategy)}，语言 ${JSON.stringify(payload.totals.byLanguage)}，跳过 ${skipped.length}`,
)
