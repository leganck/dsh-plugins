/**
 * 自测：在真实仓库上验证建库 / 检索 / 增量 / 切块 / 排除（0.10.0 remote-only：无本地模型）。
 *
 * 用法：
 *   node test.mjs                          # 默认挑一个存在的小仓库
 *   node test.mjs --repo D:\Code\...        # 指定仓库
 *
 * 断言失败即退出码 1；最后打印通过/失败计数。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './lib/store.js'
import { buildIndex, scanStatus, dropIndex } from './lib/indexer.js'
import { search } from './lib/search.js'
import { walkRepo, normalizeRelPrefix } from './lib/scan.js'
import { chunkText, chunkFile, sha256 } from './lib/chunker.js'
import { braceDepths, heuristicChunks } from './lib/chunk-heuristic.js'
import { getParser } from './lib/chunk-ast.js'
import { resolveChunkConfig, DEFAULT_BY_EXT, DEFAULT_FALLBACK } from './lib/strategies.js'
import { defaultDepsDir } from './lib/deps.js'

/**
 * Java 夹具：`methods` 个方法、每个方法体 `bodyLines` 行。
 * 用途是构造一个"固定 40 行窗口必然切在方法中间"的场景——
 * 第 1 个方法占第 4..33 行，于是第 40 行会落在第 2 个方法体内。
 */
function mkJavaFixture(methods = 3, bodyLines = 28) {
  const names = ['one', 'two', 'three']
  const lines = ['class Fixture {', '    private int a = 1;', '']
  for (let m = 0; m < methods; m++) {
    lines.push(`    public void ${names[m] ?? 'm' + m}() {`)
    for (let i = 0; i < bodyLines; i++) lines.push(`        int v${i} = ${i};`)
    lines.push('    }', '')
  }
  lines.push('}')
  return lines.join('\n')
}

/** Groovy 夹具（Grails 项目的主力语言；Groovy 不需要分号） */
function mkGroovyFixture(methods = 3, bodyLines = 20) {
  const lines = ['class Fixture {', '    String payNo', '']
  for (let m = 0; m < methods; m++) {
    lines.push(`    def m${m}() {`)
    for (let i = 0; i < bodyLines; i++) lines.push(`        def v${i} = ${i}`)
    lines.push('    }', '')
  }
  lines.push('}')
  return lines.join('\n')
}

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}

const CANDIDATE_REPOS = [
  'D:\\Code\\demo\\go-devops',
  'D:\\Code\\demo\\svc\\legacy-java-service',
  'D:\\Code\\your-repo',
  'D:\\Code\\sample-repo',
]
const repoArg = arg('--repo')
/**
 * 仓库来源三级：显式 `--repo` → 本机常见路径 → **自动建确定性夹具**。
 * 最后这一级是为 CI 和"换台机器"准备的：以前缺 repo 直接 exit(1)，测试就只能在本机跑。
 */
let repo = repoArg ?? CANDIDATE_REPOS.find((p) => fs.existsSync(p))
const repoFromFixture = !(repo && fs.existsSync(repo))
if (repoFromFixture) {
  const { makeFixtureRepo } = await import('../../scripts/ci-fixture.mjs')
  repo = makeFixtureRepo()
  console.log('· 没给 --repo，使用自动夹具仓库：' + repo)
}

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? '  — ' + extra : ''}`)
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-code-index-test-'))
const dbPath = path.join(tmpDir, 'index.db')
console.log(`仓库: ${repo}`)
console.log(`临时索引: ${dbPath}`)

const store = Store.open(dbPath)

// ---------- 0. 作用域规范（档 3 夹具）+ 配置校验 ----------
// 夹具是 JS 与 Python 两端共同的唯一真相（server/code-index-service/scope_format.json）。
console.log('[0] 作用域规范')
{
  const { canonicalNamespace, normalizeNamespace, safeRef, refToken, validateScope } = await import('./lib/scope.js')
  const fixture = JSON.parse(fs.readFileSync(new URL('../../server/code-index-service/scope_format.json', import.meta.url), 'utf8'))
  for (const c of fixture.cases) {
    const got = canonicalNamespace(c.repoId, c.chunkFp, c.kind, c.ref)
    check(`夹具 ${c.kind} ${JSON.stringify(c.ref)} → ${c.expect}`, got === c.expect, `实际 ${got}`)
  }
  for (const c of fixture.legacy_cases) {
    check('legacy 命名空间原样保留（不重新规范化）', normalizeNamespace(c.namespace) === c.expect)
  }
  for (const c of fixture.invalid_cases) {
    let err = null
    try {
      canonicalNamespace(c.repoId, c.chunkFp, c.kind, c.ref)
    } catch (e) {
      err = e
    }
    check(`非法输入按 reason 拒绝：${c.reason}`, err?.reason === c.reason, String(err?.reason ?? err))
  }
  check('safeRef 把非法字符压成 -、空结果用 x', safeRef('feat/x') === 'feat-x' && safeRef('中文分支') === 'x')
  check('main 的 ref 被忽略（固定 default）', refToken('main', 'dev') === 'default')
  check('validateScope 保留原始分支名（token 只用于命名空间）', validateScope({ kind: 'branch', ref: 'feat/x', ttlDays: 7 }).ref === 'feat/x')

  // 配置校验：DSH_HOME 必须先隔离 —— apply() 会写加载标记，不能碰真实 ~/.dsh
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-test-home-'))
  const plugin = await import('./index.js')
  const fakeCtx = () => ({
    tools: { register: () => () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (cb) => {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
  })
  const tryApply = (cfg) => {
    try {
      plugin.apply(fakeCtx(), cfg)
      return null
    } catch (e) {
      return e
    }
  }
  const ok = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', scope: { kind: 'pr', ref: '01234', ttlDays: 7 }, readScopes: ['main-ns'] } })
  check('合法 remote.scope / readScopes → 通过', ok === null, ok?.message)
  check(
    '兼容写法：remote.namespace 与 scope 同时给（namespace 优先）→ 通过',
    tryApply({ vectors: 'remote', remote: { url: 'https://h.example', namespace: 'explicit-ns', scope: { kind: 'main' } } }) === null,
  )
  const e1 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', scope: { kind: 'nope', ref: 'x' } } })
  check('未知 scope.kind → ConfigError 且点名作用域', e1 instanceof plugin.ConfigError && /作用域/.test(e1.message), e1?.message)
  const e2 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', readScopes: [42] } })
  check('readScopes 元素非字符串 → ConfigError', e2 instanceof plugin.ConfigError && /readScopes/.test(e2.message), e2?.message)
}

// ---------- 1. 建库（纯关键词）----------
console.log('[1] 建库（不启用向量）')
const r1 = await buildIndex({ store, repoRoot: repo, embedder: { ok: false, reason: 'test: 故意不启用' } })
check('扫描到文件', r1.scanned > 0, `scanned=${r1.scanned}`)
check('写入块', r1.chunksWritten > 0, `chunks=${r1.chunksWritten}`)
check('统计里文件数等于扫描数', r1.stats.files === r1.scanned, `${r1.stats.files} vs ${r1.scanned}`)
check('未生成向量', r1.stats.vectors === 0)
check('报告降级原因', /故意不启用/.test(r1.embedNote), r1.embedNote)

// ---------- 2. 纯关键词检索 ----------
console.log('\n[2] 关键词检索（FTS5）')
const sample = walkRepo(repo)[0]
check('拿到样本文件', !!sample, sample?.rel)
// 契约：给了 --repo 就必须用它，不许偷偷换成夹具（否则本地测真实语料会被静默替换）
check('显式 --repo 优先于夹具', !repoArg || !repoFromFixture)

/** 从样本文件里挑一个足够独特的标识符（长 ASCII token），用它做检索基准 */
function distinctiveTerm(abs) {
  const text = fs.readFileSync(abs, 'utf8')
  const counts = new Map()
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{9,}\b/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1)
  // 取出现次数少但足够长的（越长越可能有辨识度）
  const cands = [...counts.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b))
  return cands[0] ?? null
}
const probe = distinctiveTerm(path.join(repo, sample.rel))
check('样本文件里有可用标识符', !!probe, probe ?? '(没找到 ≥10 字符的标识符)')
const res2 = await search(store, { ok: false, reason: 'test' }, probe ?? path.basename(sample.rel), { topK: 10 })
check('有命中', res2.results.length > 0, `hits=${res2.results.length}`)
check('通道标记为 fts', res2.mode === 'fts', res2.mode)
check('命中里含样本文件自身', res2.results.some((h) => h.path === sample.rel), `probe=${probe} 命中=${res2.results.slice(0, 3).map((h) => h.path).join(',')}`)
check('结果按 rank 递增', res2.results.every((h, i) => h.rank === i + 1))
check('条目带片段', res2.results.every((h) => typeof h.snippet === 'string' && h.snippet.length > 0))
// 契约调整：缺嵌入能力是默认形态，auto 模式**静默**降级到关键词
check('缺嵌入能力时 auto 模式静默走关键词', res2.note === '', res2.note)

// ---------- 3. 增量：未改动时零变更 ----------
console.log('\n[3] 增量刷新（未改动）')
const st3 = scanStatus(store, repo)
check('新鲜度=最新', st3.stale === false, JSON.stringify(st3))
const r3 = await buildIndex({ store, repoRoot: repo, embedder: { ok: false, reason: 'test' } })
check('变更文件数 0', r3.changed === 0, `changed=${r3.changed}`)
check('未写入新块', r3.chunksWritten === 0, `chunksWritten=${r3.chunksWritten}`)

// ---------- 4. 增量：改动一个文件 ----------
console.log('\n[4] 增量刷新（改动 1 个文件）')
const target = path.join(repo, sample.rel)
const original = fs.readFileSync(target, 'utf8')
const backup = original
try {
  fs.appendFileSync(target, `\n// dsh-code-index test marker ${Date.now()}\n`)
  const st4 = scanStatus(store, repo)
  check('新鲜度=过期', st4.stale === true, JSON.stringify(st4))
  check('恰好 1 个文件变化', st4.changed === 1, `changed=${st4.changed}`)
  const r4 = await buildIndex({ store, repoRoot: repo, embedder: { ok: false, reason: 'test' } })
  check('只为该文件写入块', r4.changed === 1 && r4.chunksWritten > 0, `changed=${r4.changed} chunks=${r4.chunksWritten}`)
  const res4 = await search(store, { ok: false, reason: 'test' }, 'dsh-code-index test marker', { topK: 5 })
  check('能检索到新内容', res4.results.some((h) => h.path === sample.rel), `hits=${res4.results.length}`)
} finally {
  fs.writeFileSync(target, backup)
}
await buildIndex({ store, repoRoot: repo, embedder: { ok: false, reason: 'test' } })

// ---------- 5. 删除一个文件 ----------
console.log('\n[5] 删除文件的清理')
// 扫描到的文件**不一定都有块**（太短的文件会被切块策略跳过），所以要删一个确实进了索引的文件。
// 以前直接取 walkRepo 的最后一个，在"最后一个文件恰好被跳过"的仓库上会假失败（夹具仓库就踩到了）。
const dropRel = [...store.fileState().keys()].at(-1) ?? walkRepo(repo).at(-1).rel
const dropAbs = path.join(repo, dropRel)
// 同盘重命名（跨盘 rename 会 EXDEV），索引对扩展名有过滤，改成 .bak 即等于"文件消失"
const movedTo = dropAbs + '.dsh-test-bak'
fs.renameSync(dropAbs, movedTo)
try {
  const st5 = scanStatus(store, repo)
  check('检测到删除', st5.removed >= 1, `removed=${st5.removed}`)
  const r5 = await buildIndex({ store, repoRoot: repo, embedder: { ok: false, reason: 'test' } })
  check('删除后有清理动作', r5.removed >= 1, `removed=${r5.removed}`)
  const left = store.chunksByIds([]).length
  check('清理接口可用', left === 0)
  const gone = store.fileState().has(dropRel)
  check('该文件已从索引移除', gone === false)
} finally {
  fs.renameSync(movedTo, dropAbs)
  await buildIndex({ store, repoRoot: repo, embedder: { ok: false, reason: 'test' } })
}


// ---------- 8. 切块策略（Cursor 风格策略表 + ast/heuristic/window） ----------
// 这一段全部离线、不跑模型。核心断言是**不变量**而不是"某个具体块长什么样"：
// 块的**起始行**不应落在方法体内部（depth > 成员层）——这是"半截方法"的可执行定义。
console.log('\n[8] 切块策略')
{
  const D = defaultDepsDir()

  // (a) 策略表按扩展名解析
  for (const [f, want] of [
    ['A.java', 'ast'],
    ['a.ts', 'ast'],
    ['a.tsx', 'ast'],
    ['a.jsx', 'ast'],
    ['a.vue', 'window'],
    ['a.xml', 'window'],
    ['a.sql', 'window'],
    ['a.md', 'window'],
    ['a.groovy', 'ast'],
    ['a.gradle', 'ast'],
    ['a.kt', 'heuristic'],
    ['no-extension', 'heuristic'],
  ]) {
    const c = resolveChunkConfig(f, {})
    check(`${f.padEnd(14)} → ${want}`, c.strategy === want, `实际 ${c.strategy}`)
  }
  check('Groovy 用 groovy 语法且 maxLines 调大到 200', resolveChunkConfig('a.groovy', {}).grammar === 'groovy' && resolveChunkConfig('a.groovy', {}).maxLines === 200, `grammar=${resolveChunkConfig('a.groovy', {}).grammar} maxLines=${resolveChunkConfig('a.groovy', {}).maxLines}`)
  check('TS 取 typescript 变体', resolveChunkConfig('a.ts', {}).grammar === 'typescript')
  check('TSX 取 tsx 变体（实测该包导出 {typescript,tsx}，没有 .language）', resolveChunkConfig('a.tsx', {}).grammar === 'tsx')
  check('策略表有内容且含兜底默认', Object.keys(DEFAULT_BY_EXT).length >= 10 && DEFAULT_FALLBACK.strategy === 'heuristic')

  // (b) 配置覆盖优先级：byExt 覆盖表 > 表 > 兜底
  const ov = resolveChunkConfig('a.vue', { byExt: { '.vue': { windowLines: 20 } } })
  check('byExt 覆盖生效且标记为"被配置改过"', ov.windowLines === 20 && ov.forcedByConfig === true)
  check('全局 strategy 强制覆盖策略表', resolveChunkConfig('a.java', { strategy: 'window' }).strategy === 'window')

  // (c) 不变量：启发式切块的起始行不落在方法体内部；固定窗口则会
  const java = mkJavaFixture()
  const jlines = java.split(/\r?\n/)
  const depths = braceDepths(jlines)
  const base = Math.min(...depths)
  const insideMethod = (chunks) => chunks.filter((c) => depths[c.startLine - 1] > base + 1).length
  const winChunks = chunkText(java, { windowLines: 40 })
  const heurChunks = heuristicChunks(java, { minLines: 8, maxLines: 120 })
  check('固定窗口确实会从方法中间开始（基线，证明这个不变量有区分度）', insideMethod(winChunks) > 0, `${insideMethod(winChunks)}/${winChunks.length} 块`)
  check('启发式切块：没有任何块从方法中间开始', insideMethod(heurChunks) === 0, `${insideMethod(heurChunks)}/${heurChunks.length} 块`)
  // 断言**性质**而不是写死位置：切点全部落在成员层（<= base+1），且与固定窗口的任意切点不同。
  check(
    '启发式切点全部落在成员层，且不同于固定窗口的任意切点',
    heurChunks.every((c) => depths[c.startLine - 1] <= base + 1) &&
      heurChunks.map((c) => c.startLine).join(',') !== winChunks.map((c) => c.startLine).join(','),
    `启发式 ${heurChunks.map((c) => c.startLine).join(',')}（成员层）vs 固定窗口 ${winChunks.map((c) => c.startLine).join(',')}（任意位置）`,
  )
  check('启发式块都不为空', heurChunks.every((c) => c.body.trim()))
  check('启发式块首尾行号自洽', heurChunks.every((c) => c.startLine >= 1 && c.endLine >= c.startLine))

  // (d) 引号/注释里的括号不计数（朴素计数会由此**整体错位**）
  const tricky = ['class T {', '  String s = "{ 不是括号 }";', '  // } 注释里的括号', '  void m() {', '    int i = 0;', '  }', '}'].join('\n')
  const td = braceDepths(tricky.split('\n'))
  check('字符串里的花括号不改变深度', td[3] === 1, `void m() 行首深度 = ${td[3]}（应为 1）`)
  check('行注释里的花括号不改变深度', td[3] === 1)
  check('方法体内部深度仍是 2（说明计数没被带偏）', td[4] === 2, `实际 ${td[4]}`)

  // (e) AST 切块：依赖就绪则验质量，未就绪则验"如实降级"
  const parserReady = getParser({ depsDir: D, grammar: 'java' }).ok
  const r = chunkFile({ relPath: 'Fixture.java', text: java, chunking: { strategy: 'auto' }, depsDir: D })
  if (parserReady) {
    check('ast 策略真的跑起来了（没静默降级）', r.strategy === 'ast' && r.fellBack === false, r.reason ?? '')
    check('AST 切块没有"强制拆分"（正常长度方法）', r.chunks.every((c) => c.kind !== 'forced'), r.chunks.map((c) => c.kind).join(','))
    check('AST 块取到了方法名（符号信息）', r.chunks.some((c) => ['one', 'two', 'three'].includes(c.symbol ?? '')), r.chunks.map((c) => c.symbol).join(','))
    check(
      'AST 块是完整方法（首行签名、末行闭括号）',
      r.chunks.some((c) => /public void \w+\(\) \{/.test(c.body.split('\n')[0]) && c.body.trim().endsWith('}')),
      r.chunks.map((c) => c.body.split('\n')[0].trim()).join(' | ').slice(0, 90),
    )
    // bufferSize 回归：默认 32KB 缓冲区会让大文件抛 Invalid argument（实测 32767 通过 / 32768 失败）
    const big = mkJavaFixture(60, 40)
    const rBig = chunkFile({ relPath: 'Big.java', text: big, chunking: { strategy: 'ast' }, depsDir: D })
    check(`大文件（${(big.length / 1024).toFixed(0)} KB，>32KB）不触发 bufferSize 崩溃`, rBig.strategy === 'ast' && rBig.chunks.length > 0, `策略 ${rBig.strategy}；块 ${rBig.chunks.length}；${String(rBig.reason ?? '').slice(0, 60)}`)
  } else {
    check(
      '缺 parser 依赖时降级为 heuristic，并给出可执行原因（不静默）',
      r.strategy === 'heuristic' && r.fellBack === true && /code_index_deps action=install group=parser/.test(String(r.reason)),
      String(r.reason).slice(0, 120),
    )
  }

  // (e2) Groovy（Grails 项目主力语言）：真值口径实测 heuristic 31.6% → ast 12.2%，且
  //      ast 的**非强制块**是 0/313（残差全来自超长成员，故 groovy 的 maxLines 设为 200）
  {
    const groovy = mkGroovyFixture()
    const rg = chunkFile({ relPath: 'Fixture.groovy', text: groovy, chunking: {}, depsDir: D })
    const groovyReady = getParser({ depsDir: D, grammar: 'groovy' }).ok
    if (groovyReady) {
      check('Groovy 走 ast 且无降级', rg.strategy === 'ast' && rg.fellBack === false, rg.reason ?? `策略 ${rg.strategy}`)
      check(
        'Groovy 块是完整方法（首行 def、末行闭括号）',
        rg.chunks.some((c) => /^\s*def m\d\(\) \{/.test(c.body.split('\n')[0]) && c.body.trim().endsWith('}')),
        rg.chunks.map((c) => c.body.split('\n')[0].trim()).join(' | ').slice(0, 80),
      )
      check('Groovy 无强制拆分（普通长度方法）', rg.chunks.every((c) => c.kind !== 'forced'), rg.chunks.map((c) => c.kind).join(','))
    } else {
      check('缺 groovy 语法包时降级并给出原因', rg.strategy === 'heuristic' && rg.fellBack === true && /group=parser/.test(String(rg.reason)), String(rg.reason).slice(0, 110))
    }
  }

  // (e3) **块尺寸不变量**：任何块都不得超过 maxLines。
  //      曾漏掉这条（短单元并入分支没查上限）→ 实测跑出 1214 行的块（上限本应 120）：
  //      一长串各自 < minLines 的小成员会无限并进同一块。而"首行是否对齐成员"那种指标
  //      只看起头、看不到结尾，抓不到它——所以要单独断言尺寸。
  {
    const rows = ['class Tiny {']
    for (let i = 0; i < 300; i++) rows.push(`    int f${i} = ${i};`) // 每个仅 1 行（< minLines 8）
    rows.push('}')
    const tiny = rows.join('\n')
    const rt = chunkFile({ relPath: 'Tiny.java', text: tiny, chunking: {}, depsDir: D })
    const lens = rt.chunks.map((c) => c.endLine - c.startLine + 1)
    const maxLen = Math.max(...lens)
    check(`AST 块不超过 maxLines（小成员连成一串也要切）`, maxLen <= 120, `最大 ${maxLen} 行；共 ${rt.chunks.length} 块`)
    check('AST 没有把 300 个字段并成一块', rt.chunks.length >= 3, `${rt.chunks.length} 块，长度 ${lens.slice(0, 6).join(',')}…`)
    check('AST 块首尾自洽', rt.chunks.every((c) => c.startLine >= 1 && c.endLine >= c.startLine))
  }

  // (f) 策略分发：window / heuristic / 无语法文件
  check('window 策略可强制（.java 也走固定窗口）', chunkFile({ relPath: 'A.java', text: java, chunking: { strategy: 'window', windowLines: 40 } }).strategy === 'window')
  check('heuristic 策略可强制', chunkFile({ relPath: 'A.java', text: java, chunking: { strategy: 'heuristic' } }).strategy === 'heuristic')
  check('表里指定 window 的文件不会去碰 parser', chunkFile({ relPath: 'a.vue', text: java, chunking: {} }).strategy === 'window')

  // (g) 策略指纹：换策略必须强制全量重建，否则库里会混着新旧两种粒度的块（而且没有信号）
  const tmpFp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-fp-'))
  const storeFp = Store.open(path.join(tmpFp, 'index.db'))
  const r1 = await buildIndex({ store: storeFp, repoRoot: repo, chunking: { strategy: 'window' }, opts: { maxFileBytes: 256 * 1024 } })
  check('首次建库记为 incremental', r1.mode === 'incremental' && r1.strategyChanged === false, `mode=${r1.mode}`)
  const r2 = await buildIndex({ store: storeFp, repoRoot: repo, chunking: { strategy: 'window' }, opts: { maxFileBytes: 256 * 1024 } })
  check('同一策略再跑仍是增量', r2.mode === 'incremental' && r2.changed === 0, `mode=${r2.mode} changed=${r2.changed}`)
  const r3 = await buildIndex({ store: storeFp, repoRoot: repo, chunking: { strategy: 'heuristic' }, opts: { maxFileBytes: 256 * 1024 } })
  check('换策略自动全量重建（并如实标记）', r3.mode === 'full' && r3.strategyChanged === true, `mode=${r3.mode} strategyChanged=${r3.strategyChanged}`)
  check('全量重建后策略统计是启发式', Object.keys(r3.strategies ?? {}).includes('heuristic'), JSON.stringify(r3.strategies))
  // **库里没有指纹记录**（= 指纹机制引入之前建的索引）也必须触发重建。
  // 早期写成 `Boolean(prev) && prev !== fp`，于是这类库被判成"没变化"→ 只重切少数变动文件 →
  // 直接落进"新旧两种粒度的块混在一起"的状态。实测踩过：迁移重建时最大的库只重切了 14 个文件。
  storeFp.db.exec("delete from meta where k = 'chunk_fingerprint'")
  const r4 = await buildIndex({ store: storeFp, repoRoot: repo, chunking: { strategy: 'heuristic' }, opts: { maxFileBytes: 256 * 1024 } })
  check('库里没有指纹记录 → 同样强制全量重建', r4.mode === 'full' && r4.strategyChanged === true, `mode=${r4.mode} strategyChanged=${r4.strategyChanged}`)
  const r5 = await buildIndex({ store: storeFp, repoRoot: repo, chunking: { strategy: 'heuristic' }, opts: { maxFileBytes: 256 * 1024 } })
  check('重建后指纹已记录 → 回到增量', r5.mode === 'incremental' && r5.strategyChanged === false, `mode=${r5.mode}`)
  dropIndex(storeFp)
  // Windows 上 SQLite 句柄未必立刻释放，清理临时目录是**尽力而为**（不该让清理失败掩盖测试结果）
  try {
    fs.rmSync(tmpFp, { recursive: true, force: true })
  } catch {
    /* 留给系统清理临时目录 */
  }
}

// ---------- 10. 扫描排除（excludeDirs / excludePaths） ----------
// 这一段守的是"中文语义检索被遗留目录带偏"那个真实问题：仓库里常有名字正常、
// 但在本仓库里是遗留/生成物的目录（例：legacy-grails-service 与 billing-service 只差 svc-）。
console.log('\n[10] 扫描排除')
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-excl-'))
  const JAVA = 'class A {\n  void m() {\n    int x = 1;\n  }\n}\n'
  const put = (rel) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, JAVA)
  }
  put('legacy-grails-service/Legacy.java') // 遗留目录（按路径排除）
  put('sub/legacy-grails-service/Normal.java') // 子目录里的同名目录 → 不该被路径规则误伤
  put('custom_bin/A.java') // 按目录名排除
  put('node_modules/B.java') // 内置默认排除
  put('src/Keep.java')
  put('src/Drop.java')

  const rels = (opts) => walkRepo(root, opts).map((f) => f.rel)
  const base = rels({})
  check('默认扫描：内置排除生效（node_modules 不在）', !base.includes('node_modules/B.java'))
  check('默认扫描：遗留目录会被索引（正是问题来源）', base.includes('legacy-grails-service/Legacy.java'), base.join(', '))

  const byPath = rels({ excludePaths: ['legacy-grails-service'] })
  check('excludePaths 排除顶层遗留目录', !byPath.includes('legacy-grails-service/Legacy.java'))
  check('excludePaths 不误伤子目录里的同名目录（比按名排除精确）', byPath.includes('sub/legacy-grails-service/Normal.java'))

  const byName = rels({ excludeDirs: ['legacy-grails-service'] })
  check(
    'excludeDirs 按目录名排除（两处同名都排掉）',
    !byName.includes('legacy-grails-service/Legacy.java') && !byName.includes('sub/legacy-grails-service/Normal.java'),
  )
  check('excludeDirs 与内置默认**合并**而非替换（node_modules 仍被排除）', !byName.includes('node_modules/B.java'))

  const custom = rels({ excludeDirs: ['custom_bin'] })
  check('自定义目录名可排除', !custom.includes('custom_bin/A.java'))
  check('未排除的正常文件保留', custom.includes('src/Keep.java'))

  check('excludePaths 可排除单个文件', !rels({ excludePaths: ['src/Drop.java'] }).includes('src/Drop.java'))
  check('excludePaths 容忍反斜杠与结尾斜杠', !rels({ excludePaths: ['legacy-grails-service\\'] }).includes('legacy-grails-service/Legacy.java'))
  check('excludePaths 前缀语义（a/b 也排除 a/b/c）', !rels({ excludePaths: ['legacy-grails-service'] }).some((r) => r.startsWith('legacy-grails-service/')))
  check('normalizeRelPrefix 归一化 .\\ 结尾/ 反斜杠', normalizeRelPrefix('.\\a\\b\\') === 'a/b', normalizeRelPrefix('.\\a\\b\\'))

  // 索引层：加上排除后重跑，旧块应被移除（diffFiles 的 removed 路径），无需全量重建
  const tmpEx = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-excl-db-'))
  const sEx = Store.open(path.join(tmpEx, 'index.db'))
  const scanOpts = { maxFileBytes: 256 * 1024 }
  await buildIndex({ store: sEx, repoRoot: root, opts: scanOpts })
  check('建库时包含遗留目录的文件', sEx.fileState().has('legacy-grails-service/Legacy.java'))
  const chunksBefore = sEx.stats().chunks
  const b2 = await buildIndex({ store: sEx, repoRoot: root, opts: { ...scanOpts, excludePaths: ['legacy-grails-service'] } })
  check(
    '加排除后重跑：该文件被移除，且没有触发全量重建',
    !sEx.fileState().has('legacy-grails-service/Legacy.java') && b2.removed === 1 && b2.mode === 'incremental',
    `removed=${b2.removed} mode=${b2.mode}`,
  )
  check('库中对应块也被删除（不是只删了文件记录）', sEx.stats().chunks === chunksBefore - 1, `${chunksBefore} → ${sEx.stats().chunks} 块`)
  // 状态检查必须用同一份排除规则，否则会把被排除的文件永远报成"缺失/过期"
  const stEx = scanStatus(sEx, root, { ...scanOpts, excludePaths: ['legacy-grails-service'] })
  check('状态检查共用排除规则 → 报"最新"而不是"过期"', stEx.stale === false, `stale=${stEx.stale} removed=${stEx.removed}`)
  const stBad = scanStatus(sEx, root, scanOpts)
  check('对照：不传排除规则时会误报过期（证明这条链必须一致）', stBad.stale === true, `stale=${stBad.stale}`)
  dropIndex(sEx)
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* Windows 句柄 */
  }
}

// ---------- 11a. 远端作用域同步（syncRemote） ----------
// 这里不连网络：用一个记录调用的假 client 验证 namespace / payload.scope / 服务端返回值三件事。
console.log('\n[11a] 远端作用域同步（syncRemote）')
{
  const { syncRemote } = await import('./lib/indexer.js')
  const tmpSc = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-syncscope-'))
  const scStore = Store.open(path.join(tmpSc, 'index.db'))
  const mkClient = (resp = {}) => ({
    calls: [],
    async sync(ns, payload) {
      this.calls.push({ ns, payload })
      return { revision: 7, chunks: 1, missing: [], unchanged: false, coverage: 1, ...resp }
    },
    async uploadChunks() {
      return { accepted: 0 }
    },
    async kickEmbed() {
      return { ok: true }
    },
  })

  const client = mkClient()
  const r = await syncRemote({
    store: scStore,
    client,
    repoId: 'r1',
    url: '',
    tag: null,
    fingerprint: 'fp-test',
    namespace: 'r1@fp-test#branch:feat-x-d6e256',
    scope: { kind: 'branch', ref: 'feat/x', ttlDays: 14 },
    changedFiles: [],
    removed: [],
  })
  check('使用传入的写作用域命名空间', client.calls[0]?.ns === 'r1@fp-test#branch:feat-x-d6e256', client.calls[0]?.ns)
  check(
    'sync payload 带 scope（kind/ref/ttlDays）',
    client.calls[0]?.payload?.scope?.kind === 'branch' && client.calls[0]?.payload?.scope?.ttlDays === 14,
    JSON.stringify(client.calls[0]?.payload?.scope),
  )
  check('服务端没回 namespace 时用本地推导值', r.namespace === 'r1@fp-test#branch:feat-x-d6e256', r.namespace)

  const client2 = mkClient({ namespace: 'server-side-ns' })
  const r2 = await syncRemote({ store: scStore, client: client2, repoId: 'r1', url: '', tag: null, fingerprint: 'fp-test', namespace: 'local-ns', changedFiles: [], removed: [] })
  check('以服务端返回的 namespace 为准（并落库 remote_namespace）', r2.namespace === 'server-side-ns' && scStore.getMeta('remote_namespace') === 'server-side-ns', r2.namespace)

  const client3 = mkClient()
  const r3 = await syncRemote({ store: scStore, client: client3, repoId: 'r1', url: '', tag: null, fingerprint: 'fp-test', changedFiles: [], removed: [] })
  check('旧默认命名空间 = repoId@fingerprint', client3.calls[0]?.ns === 'r1@fp-test', client3.calls[0]?.ns)
  check('无 scope 配置时 payload 不带 scope 字段', !('scope' in (client3.calls[0]?.payload ?? {})), JSON.stringify(Object.keys(client3.calls[0]?.payload ?? {})))
  check('无 namespace 返回时退回本地推导值', r3.namespace === 'r1@fp-test', r3.namespace)
}

// ---------- 11b. 语言扩展开装提示（parser hints） ----------
console.log('\n[11b] 语言扩展安装提示')
const { detectMissingGrammars, renderParserHint } = await import('./lib/parser-hints.js')
const hintScan = Array.from({ length: 10 }, (_, i) => ({ rel: 'pkg/a' + i + '.go' })).concat([{ rel: 'web/b.js' }])
const missAll = detectMissingGrammars(hintScan, { strategy: 'auto' }, {}, () => false)
check('全缺时按文件数排序（go 在前）', missAll[0]?.grammar === 'go' && missAll[0].files === 10, missAll.map((m) => m.grammar + 'x' + m.files).join(','))
check('同一包的多扩展名会合并', detectMissingGrammars([{ rel: 'a.py' }, { rel: 'b.pyi' }], { strategy: 'auto' }, {}, () => false)[0]?.exts.join(',') === '.py,.pyi')
const missSome = detectMissingGrammars(hintScan, { strategy: 'auto' }, {}, (gr) => gr === 'javascript')
check('已装的语法不提示', missSome.length === 1 && missSome[0].grammar === 'go', JSON.stringify(missSome.map((m) => m.grammar)))
check('全装时无提示', detectMissingGrammars(hintScan, { strategy: 'auto' }, {}, () => true).length === 0)
check('渲染含安装命令', renderParserHint(missAll, { totalFiles: 11 }).join('\n').includes('code_index_deps action=install group=parser'))

// ---------- 12. 清理 ----------
console.log('\n[12] 清空索引')
dropIndex(store)
check('清空后块数为 0', store.stats().chunks === 0)
check('清空后向量为 0', store.stats().vectors === 0)
check('清空后文件数为 0', store.stats().files === 0)


console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1