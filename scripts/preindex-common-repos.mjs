#!/usr/bin/env node
/**
 * scripts/preindex-common-repos.mjs
 *
 * 用途
 *   一次性看清「本机业务仓有哪些、各自建没建 code-index 索引」，并把建库命令直接打出来。
 *   解决消费侧最常见的问题：会话 cwd 不是 git 仓库 → 没人知道该给 code_index 传哪个 path。
 *
 * 做什么
 *   1. 递归扫描 --root（默认 D:/Code/smartpos）下的所有 git 仓库：`.git` 是目录或文件（worktree）都算。
 *   2. 读每个仓库的当前分支（直接读 HEAD / worktree 的 gitdir，不调 git 命令）。
 *   3. 判断有没有可用索引：在索引库根下按插件同一算法定位 `<仓库名>-<路径sha1前8位>/index.db`，
 *      读 chunks 行数；找不到同名目录时退化为「前缀同名库」兜底。
 *   4. 打印表格：# / 仓库名 / 绝对路径 / 当前分支 / 已建索引 / 建议命令。
 *
 * 用法
 *   node scripts/preindex-common-repos.mjs                     # 表格（按一级目录分组）
 *   node scripts/preindex-common-repos.mjs --json              # 机器可读（仅 JSON 到 stdout）
 *   node scripts/preindex-common-repos.mjs --json --compact    # 单行 JSON（便于 jq / head 管道）
 *   node scripts/preindex-common-repos.mjs --only erp-pos,pay   # 按仓库名过滤（精确名优先，否则子串）
 *   node scripts/preindex-common-repos.mjs --common            # 只看 8 个常用仓
 *   node scripts/preindex-common-repos.mjs --common --commands  # 只输出该建的 code_index 命令
 *   node scripts/preindex-common-repos.mjs --root D:/Code/smartpos --depth 5
 *
 * 纪律
 *   - 只读：只读目录项与 index.db（readOnly 打开）；不建目录、不改文件、不联网、不调 DSH。
 *   - 零依赖：只用 node: 内置模块。node >= 22.5 才有 node:sqlite；更老的 node 降级为「已建索引=?」。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

/** 同步 require（本文件是 ESM；node:sqlite 是内置模块，两种加载方式都行） */
const require0 = createRequire(import.meta.url)

/* ------------------------------------------------------------------ 常量 */

/** 默认扫描根（只是默认值，可用 --root / PREINDEX_ROOT 覆盖；仓库清单永远靠扫，不硬编码） */
const DEFAULT_ROOT = process.env.PREINDEX_ROOT || 'D:/Code/smartpos'

/** 索引库根：插件 advanced.indexDirBase 的默认值 */
const DEFAULT_INDEX_DIR =
  process.env.DSH_CODE_INDEX_DIR || path.join(os.homedir(), '.dsh', 'code-index')

/** 扫描时要跳过的目录（构建产物/依赖，里面不会有独立业务仓） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.dsh-index',
  'target', 'build', 'out', 'dist', 'bin', 'obj', 'coverage', 'vendor',
  '.gradle', '.mvn', '.idea', '.vscode', '.next', '.nuxt', '.venv', 'venv', '__pycache__',
])

/**
 * 常用仓（按仓库**名**匹配，不含任何路径）。
 * 列表来自交付侧的常用仓清单；`want` 是清单里的叫法，`alias` 是实际目录名不一致时的兜底。
 */
const COMMON_REPOS = [
  { want: 'smartpos-erp-pos', label: 'ERP POS 主仓' },
  { want: 'smartpos-crm-order', label: 'CRM 订单' },
  { want: 'smartpos-crm-policy', label: 'CRM 政策' },
  { want: 'smartpos-svc-pay', label: '支付服务' },
  { want: 'smartpos-svc-center', label: '中心服务' },
  { want: 'smartpos-erp-eai', label: 'ERP 接口' },
  { want: 'smartpos-erp-chain', alias: 'smartpos-svc-erp-chain', label: 'ERP 链路' },
  { want: 'smartpos-svc-saas-business', label: 'SaaS 业务' },
]

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const opts = {
    json: false,
    compact: false,
    only: '',
    common: false,
    commands: false,
    root: DEFAULT_ROOT,
    indexDir: DEFAULT_INDEX_DIR,
    depth: 5,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = (name) => {
      const v = argv[i + 1]
      if (v == null || v.startsWith('--')) throw new Error(`${name} 需要一个值`)
      i++
      return v
    }
    switch (a) {
      case '--json': opts.json = true; break
      case '--compact': opts.compact = true; break
      case '--common': opts.common = true; break
      case '--commands': opts.commands = true; break
      case '--help': case '-h': opts.help = true; break
      case '--only': opts.only = take('--only'); break
      case '--root': opts.root = take('--root'); break
      case '--index-dir': opts.indexDir = take('--index-dir'); break
      case '--depth': {
        const n = Number(take('--depth'))
        if (!Number.isFinite(n) || n < 1 || n > 12) throw new Error('--depth 需要 1..12 的整数')
        opts.depth = Math.floor(n)
        break
      }
      default:
        if (a.startsWith('--')) throw new Error(`未知参数：${a}（--help 看用法）`)
    }
  }
  return opts
}

/* ------------------------------------------------------------------ 索引库探测 */

let DatabaseSync = null
let sqliteChecked = false

/** 懒加载 node:sqlite；老 node 没有这个模块时返回 null（后续标记为「未知」） */
function openDbCtor() {
  if (sqliteChecked) return DatabaseSync
  sqliteChecked = true
  try {
    DatabaseSync = require0('node:sqlite').DatabaseSync
  } catch {
    DatabaseSync = null
  }
  return DatabaseSync
}

/** 读 index.db 的行数；只读打开，失败返回 null */
function readDbStats(dbPath) {
  const Ctor = openDbCtor()
  if (!Ctor) return { files: null, chunks: null, error: 'node:sqlite 不可用（node < 22.5）' }
  let db
  try {
    db = new Ctor(dbPath, { readOnly: true })
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    )
    const count = (t) => (tables.has(t) ? Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c) : 0)
    // WAL 还在 = 有进程正在写（或上次没 checkpoint）。0 块 + 有大 WAL 时不要当成「空壳库」。
    let walBytes = 0
    try { walBytes = fs.statSync(`${dbPath}-wal`).size } catch { /* 没有 wal */ }
    return { files: count('files'), chunks: count('chunks'), walBytes, error: null }
  } catch (e) {
    return { files: null, chunks: null, walBytes: 0, error: String(e?.message ?? e).slice(0, 200) }
  } finally {
    try { db?.close() } catch { /* 关不掉也只是一次只读 */ }
  }
}

const dbStatsCache = new Map()
function dbStats(dbPath) {
  if (!dbStatsCache.has(dbPath)) dbStatsCache.set(dbPath, readDbStats(dbPath))
  return dbStatsCache.get(dbPath)
}

/** 插件 lib/indexer.js 的同一算法：<仓库名>-<sha1(仓库绝对路径)前8位> */
function slugOf(repoRoot) {
  const base = path.basename(repoRoot).replace(/[^\w.-]+/g, '_')
  const h = crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)
  return `${base}-${h}`
}

/**
 * 定位某个仓库的索引库。
 * 先按插件的 slug 精确算（最可靠）；算不出来再按同名目录兜底。
 *
 * 兜底必须**严格**：目录名要正好是 `<仓库名>-<8位hex>`。
 * 只按前缀 `startsWith('<仓库名>-')` 会把派生仓的库认成本仓的库
 * （实测：smartpos-svc-saas-business 会错误认领 smartpos-svc-saas-business-5.0-xxxxxxxx）。
 * 多个同名候选一律不认，只列出来交给人确认。
 */
function locateIndex(repoRoot, indexDirBase) {
  const base = path.basename(repoRoot).replace(/[^\w.-]+/g, '_')
  const variants = new Set([repoRoot, repoRoot.replace(/\\/g, '/'), repoRoot.replace(/\//g, '\\')])
  for (const v of variants) {
    const dir = path.join(indexDirBase, slugOf(v))
    const dbPath = path.join(dir, 'index.db')
    if (fs.existsSync(dbPath)) {
      return { dbPath, dbDir: path.basename(dir), matchedBy: 'slug', ambiguous: [] }
    }
  }
  // 兜底：同名前缀且形如 `<base>-<8位hex>` 的目录（跨盘符写法/大小写差异时用）
  let names = []
  try {
    names = fs.readdirSync(indexDirBase, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(`${base}-`))
      .map((e) => e.name)
  } catch {
    return { dbPath: null, dbDir: null, matchedBy: 'none', ambiguous: [] }
  }
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const strictRe = new RegExp(`^${esc}-[0-9a-f]{8}$`)
  const strict = names.filter((n) => strictRe.test(n) && fs.existsSync(path.join(indexDirBase, n, 'index.db')))
  if (strict.length === 1) {
    return {
      dbPath: path.join(indexDirBase, strict[0], 'index.db'),
      dbDir: strict[0],
      matchedBy: 'name+hash8',
      ambiguous: [],
    }
  }
  if (names.length || strict.length > 1) {
    return {
      dbPath: null,
      dbDir: null,
      matchedBy: 'ambiguous',
      ambiguous: strict.length > 1 ? strict : names,
    }
  }
  return { dbPath: null, dbDir: null, matchedBy: 'none', ambiguous: [] }
}

/* ------------------------------------------------------------------ 仓库扫描 */

/** 读当前分支：`.git` 目录直接读 HEAD；worktree 的 `.git` 文件先解 gitdir。不调 git。 */
function readBranch(repoRoot, gitPath) {
  try {
    let gitDir = gitPath
    let worktree = false
    if (!fs.statSync(gitPath).isDirectory()) {
      worktree = true
      const txt = fs.readFileSync(gitPath, 'utf8')
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(txt)
      if (!m) return { branch: '?', worktree: true, detail: '无法解析 .git 文件' }
      gitDir = path.resolve(repoRoot, m[1].replace(/^["']|["']$/g, ''))
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim()
      return { branch: ref.replace(/^refs\/heads\//, ''), worktree, ref }
    }
    return { branch: `${head.slice(0, 7)}(detached)`, worktree, detached: true }
  } catch (e) {
    return { branch: '?', worktree: false, detail: String(e?.message ?? e).slice(0, 120) }
  }
}

/** 递归扫 git 仓库（`.git` 目录或文件都算），深度有界、构建产物剪枝 */
function scanRepos(root, maxDepth) {
  const found = []
  const walk = (dir, depth) => {
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const gitEntry = ents.find((e) => e.name === '.git')
    if (gitEntry) {
      const abs = path.resolve(dir)
      const rel = path.relative(root, abs)
      const group = rel.includes(path.sep) ? rel.split(path.sep)[0] : '.'
      const br = readBranch(abs, path.join(abs, '.git'))
      found.push({
        name: path.basename(abs),
        path: abs,
        rel: rel.split(path.sep).join('/'),
        group,
        branch: br.branch,
        worktree: Boolean(br.worktree),
        branchDetail: br.detail ?? null,
      })
    }
    if (depth <= 0) return
    for (const e of ents) {
      if (!e.isDirectory()) continue
      if (e.name === '.git' || SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), depth - 1)
    }
  }
  walk(root, maxDepth)
  found.sort((a, b) => (a.group + '/' + a.name).localeCompare(b.group + '/' + b.name, 'en'))
  return found
}

/* ------------------------------------------------------------------ 组装结果 */

function buildReport(opts) {
  const root = path.resolve(opts.root)
  const indexDirBase = path.resolve(opts.indexDir)
  const notes = []

  if (!fs.existsSync(root)) {
    throw new Error(`扫描根不存在：${root}\n用 --root <目录> 指定（默认 ${DEFAULT_ROOT}）`)
  }

  const repos = scanRepos(root, opts.depth).map((r) => {
    const idx = locateIndex(r.path, indexDirBase)
    const stats = idx.dbPath ? dbStats(idx.dbPath) : { files: null, chunks: null, error: null }
    const chunks = stats.chunks
    const state =
      !idx.dbPath ? 'missing'
        : chunks == null ? 'unknown'
          : chunks > 0 ? 'indexed' : 'empty'
    return {
      ...r,
      indexState: state,
      dbPath: idx.dbPath,
      dbDir: idx.dbDir,
      dbMatchedBy: idx.matchedBy,
      dbAmbiguous: idx.ambiguous,
      files: stats.files,
      chunks: stats.chunks,
      dbError: stats.error,
      walBytes: stats.walBytes ?? 0,
      suggestedCommand: `code_index path=${r.path}`,
      common: false,
      commonLabel: null,
    }
  })

  // 常用仓：按仓库名精确匹配（别名兜底），一个常用项认领所有同名仓库
  const commonNames = []
  const pendingNotes = [] // 与「选中的仓库」相关的提示，等过滤完再决定要不要说
  for (const c of COMMON_REPOS) {
    const hit = repos.filter((r) => r.name === c.want || r.name === c.alias)
    if (!hit.length) {
      pendingNotes.push({ scope: 'always', text: `常用仓清单里的 ${c.want} 未在 ${root} 下扫到（可能是别的目录/已改名）` })
      continue
    }
    if (c.alias) {
      pendingNotes.push({
        scope: 'hit',
        names: hit.map((r) => r.name),
        text: `常用仓 ${c.want} 实际目录名是 ${c.alias}（已按实际目录名认领）`,
      })
    }
    commonNames.push(c.want)
    for (const r of hit) {
      r.common = true
      r.commonLabel = c.label
    }
  }

  // --only：精确名优先，其次子串（子串会连带匹配 -5.0 之类派生目录，故精确优先）
  let selected = repos
  if (opts.only.trim()) {
    const toks = opts.only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const exact = repos.filter((r) => toks.includes(r.name.toLowerCase()))
    selected = exact.length
      ? exact
      : repos.filter((r) => toks.some((t) => r.name.toLowerCase().includes(t) || r.rel.toLowerCase().includes(t)))
    if (!selected.length) notes.push(`--only ${opts.only} 没有匹配到任何仓库`)
  }
  if (opts.common) selected = selected.filter((r) => r.common)

  // 选中集合定了，再把提示说清楚（--only 过滤后不相关的话不打扰）
  for (const p of pendingNotes) {
    if (p.scope === 'always') notes.push(p.text)
    else if (p.names.some((n) => selected.some((r) => r.name === n))) notes.push(p.text)
  }
  for (const r of selected) {
    if (r.dbMatchedBy === 'ambiguous') {
      notes.push(`同名索引库有多个候选、无法判定：${r.path} → ${r.dbAmbiguous.join(', ')}`
        + '（用 code_index_status path=... 确认；别把派生仓的库当成本仓的库）')
    }
  }
  const byGroup = {}
  for (const r of selected) (byGroup[r.group] ??= []).push(r)
  const counts = {
    total: selected.length,
    indexed: selected.filter((r) => r.indexState === 'indexed').length,
    empty: selected.filter((r) => r.indexState === 'empty').length,
    missing: selected.filter((r) => r.indexState === 'missing').length,
    unknown: selected.filter((r) => r.indexState === 'unknown').length,
  }
  counts.coveragePct = counts.total ? Math.round((counts.indexed / counts.total) * 1000) / 10 : 0
  const hot = selected.filter((r) => r.common)
  counts.common = hot.length
  counts.commonIndexed = hot.filter((r) => r.indexState === 'indexed').length
  counts.commonMissing = hot.filter((r) => r.indexState !== 'indexed').length

  return {
    generatedAt: new Date().toISOString(),
    root,
    indexDirBase,
    depth: opts.depth,
    counts,
    commonNames,
    groups: Object.fromEntries(Object.entries(byGroup).map(([g, list]) => [g, list.length])),
    repos: selected.map((r, i) => ({ no: i + 1, ...r })),
    notes,
  }
}

/* ------------------------------------------------------------------ 输出 */

/** 全角字符按 2 列算，保证表格在终端里对齐 */
function displayWidth(s) {
  let w = 0
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6)) ? 2 : 1
  }
  return w
}
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - displayWidth(s)))
const padL = (s, n) => ' '.repeat(Math.max(0, n - displayWidth(s))) + String(s)

function indexCell(r) {
  if (r.indexState === 'indexed') return `✓ ${r.chunks}块`
  if (r.indexState === 'empty') return r.walBytes > 0 ? '空库(在建)' : '空库 0块'
  if (r.indexState === 'unknown') return `? (${r.dbError ? '读库失败' : '未知'})`
  if (r.dbMatchedBy === 'ambiguous') return '? 同名库多个'
  return '—'
}

function renderTable(report) {
  const out = []
  const { counts } = report
  out.push(`扫描根　：${report.root}（深度 ${report.depth}）`)
  out.push(`索引库根：${report.indexDirBase}`)
  out.push('图例　　：✓ <n>块 = 已建库且 chunks>0；空库 = 有 index.db 但 0 块（(在建) = 同目录有 index.db-wal，'
    + '可能正被建库）；— = 没建过；★ = 常用仓；分支后的 ⟲ = git worktree（.git 是文件）')
  out.push('')

  const wName = Math.max(6, ...report.repos.map((r) => displayWidth(r.name) + (r.common ? 1 : 0)))
  const wPath = Math.max(8, ...report.repos.map((r) => displayWidth(r.path)))
  const wBranch = Math.max(6, ...report.repos.map((r) => displayWidth(r.branch) + (r.worktree ? 2 : 0)))
  const wIdx = Math.max(8, ...report.repos.map((r) => displayWidth(indexCell(r))))

  for (const [group, list] of Object.entries(
    report.repos.reduce((acc, r) => ((acc[r.group] ??= []).push(r), acc), {}),
  )) {
    out.push(`── ${group}/ ── ${list.length} 个仓库 ${'─'.repeat(40)}`)
    out.push(
      pad('#', 4) + pad('仓库名', wName + 2) + pad('绝对路径', wPath + 2)
      + pad('当前分支', wBranch + 2) + pad('已建索引', wIdx + 2) + '建议命令',
    )
    for (const r of list) {
      out.push(
        padL(r.no, 3) + ' ' + pad((r.common ? '★' : '') + r.name, wName + 2)
        + pad(r.path, wPath + 2) + pad(r.branch + (r.worktree ? ' ⟲' : ''), wBranch + 2)
        + pad(indexCell(r), wIdx + 2) + r.suggestedCommand,
      )
    }
    out.push('')
  }

  out.push(
    `合计：${counts.total} 个 git 仓库 | 已建索引 ${counts.indexed}（覆盖率 ${counts.coveragePct}%）`
    + ` | 空库 ${counts.empty} | 未建 ${counts.missing}${counts.unknown ? ` | 未知 ${counts.unknown}` : ''}`,
  )
  if (counts.common) {
    out.push(`常用仓（★）：${counts.common} 个 | 已建索引 ${counts.commonIndexed} | 待建 ${counts.commonMissing}`)
  }
  const todo = report.repos.filter((r) => r.common && r.indexState !== 'indexed')
  if (todo.length) {
    out.push('', '先把这几个建起来（复制即用）：')
    for (const r of todo) out.push(`  ${r.suggestedCommand}`)
  }
  if (report.notes.length) {
    out.push('', '注意：')
    for (const n of report.notes) out.push(`  - ${n}`)
  }
  if (counts.indexed === 0) {
    out.push('', '提示：这批仓库一个可用的库都没有。索引在 ~/.dsh/code-index/<仓库名>-<hash8>/index.db，'
      + '删除/迁移过仓库后旧库会留下空壳，见 docs/report-empty-indexes.md。')
  }
  return out.join('\n')
}

function renderCommands(report, { onlyMissing }) {
  const list = report.repos.filter((r) => (onlyMissing ? r.indexState !== 'indexed' : true))
  if (!list.length) return '# 没有需要建的仓库（全部已有索引）'
  return list.map((r) => r.suggestedCommand).join('\n')
}

function renderHelp() {
  return [
    'preindex-common-repos.mjs —— 扫出本机业务仓 + 索引覆盖情况 + 该跑的命令',
    '',
    '用法：',
    '  node scripts/preindex-common-repos.mjs                     表格（默认扫 D:/Code/smartpos）',
    '  node scripts/preindex-common-repos.mjs --json              机器可读 JSON（stdout 只有 JSON）',
    '  node scripts/preindex-common-repos.mjs --json --compact    单行 JSON',
    '  node scripts/preindex-common-repos.mjs --only erp-pos,pay  按仓库名过滤（精确名优先，否则子串）',
    '  node scripts/preindex-common-repos.mjs --common            只看常用仓',
    '  node scripts/preindex-common-repos.mjs --common --commands  只输出待建的 code_index 命令',
    '',
    '参数：',
    '  --root <dir>       扫描根，默认 D:/Code/smartpos（也可用环境变量 PREINDEX_ROOT）',
    '  --index-dir <dir>  索引库根，默认 ~/.dsh/code-index（也可用 DSH_CODE_INDEX_DIR）',
    '  --depth <n>        递归深度，默认 5',
    '  --only <a,b>       过滤：先按仓库名精确匹配，没有精确命中再按子串',
    '  --common           只保留常用仓（★）',
    '  --commands         只打印建议命令（配合 --common 即「该建哪几个」）',
    '  --json / --compact JSON 输出（--compact 单行）',
    '  --help             本帮助',
    '',
    '只读脚本：不写文件、不联网、不调 DSH；index.db 一律 readOnly 打开。',
  ].join('\n')
}

/* ------------------------------------------------------------------ main */

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`参数错误：${e.message}`)
    process.exit(2)
  }
  if (opts.help) {
    console.log(renderHelp())
    return
  }

  let report
  try {
    report = buildReport(opts)
  } catch (e) {
    console.error(`失败：${e?.message ?? e}`)
    process.exit(1)
  }

  if (opts.commands) {
    console.log(renderCommands(report, { onlyMissing: true }))
    return
  }
  if (opts.json) {
    const payload = {
      generatedAt: report.generatedAt,
      root: report.root,
      indexDirBase: report.indexDirBase,
      depth: report.depth,
      counts: report.counts,
      commonNames: report.commonNames,
      groups: report.groups,
      repos: report.repos,
      notes: report.notes,
    }
    console.log(opts.compact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2))
    // JSON 模式：提示类信息走 stderr，保证 stdout 可被 JSON.parse
    for (const n of report.notes) console.error(`note: ${n}`)
    return
  }
  console.log(renderTable(report))
}

main()
