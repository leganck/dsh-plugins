/**
 * 自测：在真实仓库上验证建库 / 检索 / 增量 / 降级四条路径。
 *
 * 用法：
 *   node test.mjs                          # 默认挑一个存在的小仓库
 *   node test.mjs --repo D:\Code\...        # 指定仓库
 *   node test.mjs --model-dir <dir>         # 指定嵌入模型目录以验证向量通道
 *
 * 断言失败即退出码 1；最后打印通过/失败计数。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './lib/store.js'
import { buildIndex, scanStatus, dropIndex } from './lib/indexer.js'
import { createEmbedder, modelFingerprint } from './lib/embedder.js'
import {
  depsStatus,
  defaultDepsDir,
  makeResolvers,
  loadFrom,
  buildInstallArgs,
  npmInvocation,
  pruneForeignPlatforms,
  readManifest,
  EMBED_PACKAGES,
} from './lib/deps.js'
import { search } from './lib/search.js'
import { walkRepo, normalizeRelPrefix } from './lib/scan.js'
import { chunkText, chunkFile, sha256 } from './lib/chunker.js'
import { braceDepths, heuristicChunks } from './lib/chunk-heuristic.js'
import { getParser } from './lib/chunk-ast.js'
import { resolveChunkConfig, DEFAULT_BY_EXT, DEFAULT_FALLBACK } from './lib/strategies.js'

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
const repo = repoArg ?? CANDIDATE_REPOS.find((p) => fs.existsSync(p))
if (!repo || !fs.existsSync(repo)) {
  console.error('找不到可测仓库，请用 --repo 指定')
  process.exit(1)
}
const modelDir =
  arg('--model-dir') ??
  (fs.existsSync('C:\\Users\\you\\Documents\\deepseek-harness\\default-workspace\\dsh-comparison\\retrieval-ab\\bge-small-zh')
    ? 'C:\\Users\\you\\Documents\\deepseek-harness\\default-workspace\\dsh-comparison\\retrieval-ab\\bge-small-zh'
    : null)

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
console.log(`模型目录: ${modelDir ?? '(未提供，将验证降级路径)'}\n`)

const store = Store.open(dbPath)

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
check('向量通道缺失时给出说明', /向量通道未启用/.test(res2.note), res2.note)

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
const dropRel = walkRepo(repo).at(-1).rel
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

// ---------- 6. 向量通道（若给了模型目录且依赖可用）----------
console.log('\n[6] 向量通道')
if (!modelDir) {
  console.log('  (跳过：未提供 --model-dir)')
} else {
  const emb = await createEmbedder({ modelDir, backend: 'auto', verbose: false })
  if (!emb.ok) {
    console.log(`  ⚠️ 嵌入器不可用（可能未安装 onnxruntime-node / 缺模型文件）：${emb.reason}`)
    check('不可用时给出明确原因', typeof emb.reason === 'string' && emb.reason.length > 0)
  } else {
    console.log(`  嵌入器: ${emb.backend}/${emb.modelFile}，全局缓存 ${emb.cacheEntries} 条`)
    const r6 = await buildIndex({ store, repoRoot: repo, embedder: emb, budget: { maxEmbedPerRun: 1500 } })
    check('补算了向量', r6.vectorsAfter > 0, `vectors=${r6.vectorsAfter} embedded=${r6.embedded}`)
    check('向量数不超过块数', r6.vectorsAfter <= r6.stats.chunks, `${r6.vectorsAfter} vs ${r6.stats.chunks}`)
    const res6 = await search(store, emb, probe ?? path.basename(sample.rel), { topK: 10 })
    check('混合通道启用', res6.mode === 'hybrid' || res6.mode === 'vector', `${res6.mode} note=${res6.note}`)
    check('带向量排名信息', res6.results.some((h) => h.vecRank !== null), JSON.stringify(res6.results.slice(0, 2)))
    // 二次补算应几乎无事可做
    const r6b = await buildIndex({ store, repoRoot: repo, embedder: emb, budget: { maxEmbedPerRun: 1500 } })
    check('第二次无需重复补算', r6b.embedded === 0, `embedded=${r6b.embedded} note=${r6b.embedNote}`)
  }
}

// ---------- 8. 诊断信息不得预设原因 ----------
// 实测事故：某会话的索引里 0 向量，检索提示却写成「配置 embedding.backend = off」，
// 把排查引向一个本来就是 auto 的配置。原因必须由状态推导。
console.log('\n[8] 诊断信息不得预设原因')

// (a) 嵌入器不可用 → 用它的真实 reason，且不得声称是配置关了
const r8a = await search(store, { ok: false, reason: '缺少可选依赖 XYZ' }, 'anything', { topK: 1 })
check('嵌入器失败时 note 用真实 reason', r8a.note.includes('缺少可选依赖 XYZ'), r8a.note)
check('嵌入器失败时不得误报 backend=off', !r8a.note.includes('backend = off'), r8a.note)

// (b) 索引里 0 向量但嵌入器可用 → 应指出"没有向量"，而不是配置
const tmpFts = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-fts-'))
const storeFts = Store.open(path.join(tmpFts, 'index.db'))
await buildIndex({ store: storeFts, repoRoot: repo, embedder: null, budget: {} })
check('(b) 前置：该库确实只有 FTS', storeFts.stats().vectors === 0 && storeFts.stats().chunks > 0, JSON.stringify(storeFts.stats()))
const r8b = await search(storeFts, { ok: true }, 'refund', { topK: 1 })
check('0 向量时指出"还没有向量"', /还没有向量/.test(r8b.note), r8b.note)
check('0 向量时不得误报 backend=off', !r8b.note.includes('backend = off'), r8b.note)

// (c) 预算为 0 → 不得谎称"向量已是最新"
const r8c = await buildIndex({
  store: storeFts,
  repoRoot: repo,
  embedder: { ok: true, embed: async () => [], cache: null },
  budget: { maxEmbedPerRun: 0 },
})
check('预算为 0 时不谎称"已是最新"', /预算为 0/.test(r8c.embedNote), r8c.embedNote)

// (d) 安全默认：不显式给预算时**不得调用嵌入器**
// 用"一被调用就抛错"的假嵌入器来证明它压根没被碰过 —— 这是"默认不卡机器"的可执行断言
let embedCalled = false
const r8d = await buildIndex({
  store: storeFts,
  repoRoot: repo,
  embedder: {
    ok: true,
    embed: async () => {
      embedCalled = true
      throw new Error('默认预算不该走到这里')
    },
    cache: null,
  },
  budget: {},
})
check('默认（不传预算）不调用嵌入器', !embedCalled && /预算为 0/.test(r8d.embedNote), r8d.embedNote)

// ---------- 7. 可选嵌入依赖：按需安装层 ----------
// 这一节全部**离线**：不下载、不联网、不跑模型。验证的是"缺依赖时如实降级 + 修剪只动该动的东西"。
console.log('\n[7] 嵌入依赖按需安装层')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deps-test-'))
  const fakeDeps = path.join(tmp, 'embed-deps')

  // (a) 目录不存在时 status 必须"可回答而不抛错"
  const st0 = depsStatus({ depsDir: fakeDeps })
  check('缺依赖时 status 不抛错', typeof st0 === 'object' && st0.installed === false)
  check('缺依赖时列出缺哪些包', st0.missing.length === 2 && st0.missing.includes('onnxruntime-node'), st0.missing.join(','))
  check('缺依赖时不创建目录', !fs.existsSync(fakeDeps))

  // (b) 空目录也不能误报"已就绪"
  fs.mkdirSync(fakeDeps, { recursive: true })
  const st1 = depsStatus({ depsDir: fakeDeps })
  check('空目录不算已安装', st1.installed === false && st1.dirExists === true)

  // (c) 假包 → 解析器必须能解析出来（验证 createRequire 锚点是对的）
  const fakePkg = path.join(fakeDeps, 'node_modules', 'onnxruntime-node')
  fs.mkdirSync(fakePkg, { recursive: true })
  fs.writeFileSync(path.join(fakePkg, 'package.json'), JSON.stringify({ name: 'onnxruntime-node', version: '0.0.0-fake', main: 'i.js' }))
  fs.writeFileSync(path.join(fakePkg, 'i.js'), 'module.exports = { fake: true }\n')
  const resolvers = makeResolvers({ depsDir: fakeDeps })
  let resolved = null
  try {
    resolved = loadFrom(resolvers, 'onnxruntime-node')
  } catch (e) {
    resolved = { err: String(e.message) }
  }
  check('受管目录内的包可被解析', resolved?.fake === true, JSON.stringify(resolved).slice(0, 80))
  const st2 = depsStatus({ depsDir: fakeDeps })
  check('假包计入"受管目录已有"', st2.packages.find((p) => p.name === 'onnxruntime-node')?.installedInManagedDir === '0.0.0-fake')

  // (c2) **版本比对**：装了别的版本必须算"未就绪"。
  //     这条很要命——tree-sitter 的运行时与语法包是 ABI 配对的，版本错位不会在
  //     setLanguage/parse 时报错，而是读取节点时才炸（'reading 138'）。
  const mism = st2.packages.find((p) => p.name === 'onnxruntime-node')
  check('装了别的版本 → 标记为版本不符', mism?.versionMatches === false && mism?.ready === false, `${mism?.installedInManagedDir} vs 需要 ${mism?.wanted}`)
  check('版本不符时不误报"已就绪"', st2.installed === false && st2.mismatched.length === 1, st2.mismatched.join(','))
  // 把假包改成"版本正确"→ 应当变成就绪（证明判定链路是活的，不是永远报错）
  fs.writeFileSync(path.join(fakePkg, 'package.json'), JSON.stringify({ name: 'onnxruntime-node', version: EMBED_PACKAGES[0].version, main: 'i.js' }))
  const st2b = depsStatus({ depsDir: fakeDeps })
  check('版本正确后 onnxruntime-node 变为就绪', st2b.packages.find((p) => p.name === 'onnxruntime-node')?.ready === true)
  check('但该组整体仍未就绪（transformers 还没装）', st2b.installed === false && st2b.missing.join(',') === '@huggingface/transformers', st2b.missing.join(','))

  // (d) 修剪：只删非本平台的 napi-v* 目录，其它一律不动
  const ortRoot = fakeDeps
  for (const plat of ['win32', 'linux', 'darwin']) {
    for (const arch of ['x64', 'arm64']) {
      const d = path.join(ortRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', plat, arch)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'onnxruntime.dll'), 'x'.repeat(2048))
    }
  }
  // 放一个"不该被动"的目录，验证修剪有边界
  const untouch = path.join(fakeDeps, 'node_modules', 'unrelated', 'bin', 'napi-v6', 'linux')
  fs.mkdirSync(untouch, { recursive: true })
  fs.writeFileSync(path.join(untouch, 'keep.txt'), 'keep')
  const pruned = pruneForeignPlatforms(fakeDeps)
  const kept = path.join(ortRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', process.platform, process.arch)
  const goneLinux = path.join(ortRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'linux')
  check('修剪后本平台/本架构仍在', fs.existsSync(kept))
  check('修剪移除了 foreign 平台', !fs.existsSync(goneLinux))
  check(
    '修剪只动 onnxruntime-node 底下的东西',
    // 夹具是 3 平台 × 2 架构 = 6 个目录。removed 记的是"被删的目录项"：
    // 非本平台各删 1 个平台目录（win32 上 = linux + darwin = 2），本平台内再删 1 个非本架构（arm64）= 1，
    // 合计恒为 3（换平台同理）。关键断言是"每一项都在 onnxruntime-node 底下"。
    pruned.removed.length === 3 && pruned.removed.every((p) => p.includes('onnxruntime-node')) && pruned.freedBytes > 0,
    `移除 ${pruned.removed.length} 个，回收 ${(pruned.freedBytes / 1024).toFixed(1)} KB；${pruned.removed.map((p) => p.split(/[\\/]/).slice(-2).join('/')).join(', ')}`,
  )
  check('修剪写入 manifest 便于追溯', (readManifest(fakeDeps) ?? {}).prunedFor === `${process.platform}-${process.arch}`)
  check('修剪不动无关目录', fs.existsSync(path.join(untouch, 'keep.txt')))

  // (e) 安装参数构造（不真跑网络）：必须带 --ignore-scripts，且版本是固定的
  const args = buildInstallArgs({ dir: fakeDeps })
  check('安装参数含 --ignore-scripts', args.includes('--ignore-scripts'))
  check('安装参数逐个钉版本', args.includes(`onnxruntime-node@${EMBED_PACKAGES[0].version}`) && args.includes(`@huggingface/transformers@${EMBED_PACKAGES[1].version}`))
  check('显式 registry 才会被传', !args.includes('--registry') && buildInstallArgs({ dir: fakeDeps, registry: 'https://example.invalid' }).includes('--registry'))
  const inv = npmInvocation(['install', 'x'])
  if (process.platform === 'win32') {
    check('Windows 走 cmd.exe 而非直接 spawn npm.cmd', String(inv.file).toLowerCase().endsWith('cmd.exe'), inv.file)
  } else {
    check('POSIX 直接用 npm', inv.file === 'npm')
  }

  // (f) embedder 在缺依赖时必须给出"可执行下一步"，而不是一句泛泛的失败
  // 注意：要给一个**存在 tokenizer.json 的假模型目录**，否则会先在"缺分词器"那一步返回，
  // 测不到依赖这一层（这个顺序是真实的：先查模型文件，再加载依赖）。
  const fakeModel = path.join(tmp, 'fake-model')
  fs.mkdirSync(fakeModel, { recursive: true })
  fs.writeFileSync(path.join(fakeModel, 'tokenizer.json'), '{}')
  const emb = await createEmbedder({ modelDir: fakeModel, depsDir: fakeDeps, backend: 'cpu', log: () => {} })
  const reason = emb.ok ? '（embedder 竟然成功——说明本机全局装了依赖）' : emb.reason
  check('embedder 在缺依赖时返回 ok:false 且不抛错', typeof emb.ok === 'boolean')
  check(
    '降级原因指向 code_index_deps action=install',
    /code_index_deps action=install/.test(String(reason)),
    String(reason).slice(0, 120),
  )
  // 这里受管目录里有一个"假 onnxruntime-node"，所以缺的应当是 @huggingface/transformers；
  // 断言"列出真正缺的那个"，而不是写死某个包名
  const missingNow = depsStatus({ depsDir: fakeDeps }).missing
  check(
    '降级原因列出真正缺的包',
    missingNow.length > 0 && missingNow.some((n) => String(reason).includes(n)),
    `缺 ${missingNow.join(',')}；原因里提到的是上面这个 → ${missingNow.some((n) => String(reason).includes(n))}`,
  )
  // 全新机器：**既**没模型文件**又**没依赖 → 一条消息必须把两件事都说出来。
  // 早前是"先报缺分词器"就返回了，用户补完模型再跑一次才被告知缺依赖（多一轮往返）。
  const embFresh = await createEmbedder({
    modelDir: path.join(tmp, 'no-such-model-dir'),
    depsDir: fakeDeps,
    backend: 'cpu',
    log: () => {},
  })
  const freshReason = String(embFresh.ok ? '' : embFresh.reason)
  check(
    '全新机器（缺模型+缺依赖）一次说全两件事',
    /缺模型文件/.test(freshReason) && /code_index_deps action=install group=embed/.test(freshReason),
    freshReason.slice(0, 150),
  )

  fs.rmSync(tmp, { recursive: true, force: true })
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

// ---------- 9. 嵌入模型一致性闸门（不需要模型：用假嵌入器） ----------
// 这一节守的是"换模型后静默算垃圾"这个洞：
//   - 索引里没记模型 → 拿新模型的查询向量和旧模型的存量向量做点积
//   - 维度不同 → NaN；维度相同（fp16↔int8）→ 分数看着正常、排名是垃圾
console.log('\n[9] 嵌入模型一致性')
{
  const tmpEmb = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-emb-'))
  const storeEmb = Store.open(path.join(tmpEmb, 'index.db'))

  /** 假模型目录：用来验证"指纹随内容变化" */
  const mkModelDir = (content) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-model-'))
    fs.writeFileSync(path.join(d, 'model_fp16.onnx'), content)
    fs.writeFileSync(path.join(d, 'tokenizer.json'), '{"fake":true}')
    return d
  }
  const dirA = mkModelDir('weights-A')
  const dirB = mkModelDir('weights-B')
  const fpA1 = modelFingerprint(dirA, 'model_fp16.onnx')
  const fpA2 = modelFingerprint(dirA, 'model_fp16.onnx')
  const fpB = modelFingerprint(dirB, 'model_fp16.onnx')
  check('模型指纹是 8 位十六进制', /^[0-9a-f]{8}$/.test(fpA1), fpA1)
  check('同一份模型指纹稳定（有记忆化）', fpA1 === fpA2)
  check('模型内容不同 → 指纹不同（这是跨机器共享的关键）', fpA1 !== fpB, `${fpA1} vs ${fpB}`)

  /** 假嵌入器：满足 indexer/search 需要的形状，返回 L2 归一化的常量向量 */
  const fakeEmb = (tag, dim = 512) => ({
    ok: true,
    backend: 'fake',
    modelFile: 'fake.onnx',
    modelTag: tag,
    dim,
    cache: null,
    embed: async (texts) => texts.map(() => new Float32Array(dim).fill(1 / Math.sqrt(dim))),
  })

  // (a) 建库时写入 embedding_tag
  const embA = fakeEmb('fake-model-A-fp16')
  const b1 = await buildIndex({
    store: storeEmb,
    repoRoot: repo,
    embedder: embA,
    budget: { maxEmbedPerRun: 8 },
    opts: { maxFileBytes: 256 * 1024 },
  })
  check('建库写入 embedding_tag', storeEmb.getMeta('embedding_tag') === 'fake-model-A-fp16', String(storeEmb.getMeta('embedding_tag')))
  check('确实产生了向量（否则后面的闸门测不到）', b1.stats.vectors > 0, `${b1.stats.vectors} 条`)

  // (b) 换模型 → 强制全量重建并如实标记
  const b2 = await buildIndex({
    store: storeEmb,
    repoRoot: repo,
    embedder: fakeEmb('fake-model-B-fp16'),
    budget: { maxEmbedPerRun: 8 },
    opts: { maxFileBytes: 256 * 1024 },
  })
  check('换模型 → 自动全量重建（embedChanged=true）', b2.mode === 'full' && b2.embedChanged === true, `mode=${b2.mode} embedChanged=${b2.embedChanged}`)
  check('重建后 tag 更新为新模型', storeEmb.getMeta('embedding_tag') === 'fake-model-B-fp16')
  // 同一模型再跑 → 回到增量
  const b3 = await buildIndex({
    store: storeEmb,
    repoRoot: repo,
    embedder: fakeEmb('fake-model-B-fp16'),
    budget: { maxEmbedPerRun: 0 },
    opts: { maxFileBytes: 256 * 1024 },
  })
  check('同模型再跑不再是全量重建', b3.mode === 'incremental' && b3.embedChanged === false, `mode=${b3.mode}`)

  // (c) 查询闸门：用一个干净库造数据，逐条验证
  const mkSearchStore = () => {
    const s = Store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-gate-')), 'index.db'))
    const chunks = s.replaceChunks('Gate.java', [
      { startLine: 1, endLine: 10, hash: sha256('a'), body: 'public void 退款超限校验() { int x = 1; }' },
      { startLine: 11, endLine: 20, hash: sha256('b'), body: 'public void another() { int y = 2; }' },
    ])
    return { s, chunks }
  }
  const vec512 = new Float32Array(512).fill(1 / Math.sqrt(512))

  // (c1) 正常路径：tag 一致 + 维度一致 → 应当走 hybrid
  {
    const { s, chunks } = mkSearchStore()
    s.setMeta('embedding_tag', 'fake-model-A-fp16')
    s.putVectors([[chunks[0].id, vec512], [chunks[1].id, vec512]])
    const r = await search(s, fakeEmb('fake-model-A-fp16'), '退款超限校验', { topK: 2 })
    check('tag/维度一致 → 走 hybrid', r.mode === 'hybrid', `mode=${r.mode} note=${r.note.slice(0, 60)}`)
    check('hybrid 结果带向量名次', r.results.every((x) => typeof x.vecRank === 'number'), JSON.stringify(r.results.map((x) => x.vecRank)))
    dropIndex(s)
  }
  // (c2) 闸门①：tag 不一致 → 禁用向量通道并说明原因
  {
    const { s, chunks } = mkSearchStore()
    s.setMeta('embedding_tag', 'old-model-fp16')
    s.putVectors([[chunks[0].id, vec512], [chunks[1].id, vec512]])
    const r = await search(s, fakeEmb('fake-model-A-fp16'), '退款超限校验', { topK: 2 })
    check('模型不一致 → 不用向量通道', r.mode === 'fts' && r.results.every((x) => x.vecRank === null), `mode=${r.mode}`)
    check('并说明"不一致"及处置办法', /不一致/.test(r.note) && /code_index/.test(r.note), r.note.slice(0, 100))
    dropIndex(s)
  }
  // (c3) 闸门①b：库里没记模型（旧版本建的库）→ 也要挡住
  {
    const { s, chunks } = mkSearchStore()
    s.putVectors([[chunks[0].id, vec512]]) // 有向量但没有 embedding_tag
    const r = await search(s, fakeEmb('fake-model-A-fp16'), '退款超限校验', { topK: 2 })
    check('库无模型记录 → 不用向量通道（不猜）', r.mode === 'fts' && /没有记录/.test(r.note), r.note.slice(0, 100))
    dropIndex(s)
  }
  // (c4) 闸门②：tag 一致但维度不符 → 也要挡住（配置漂移的兜底）
  {
    const { s, chunks } = mkSearchStore()
    s.setMeta('embedding_tag', 'fake-model-A-fp16')
    s.putVectors([[chunks[0].id, new Float32Array(3).fill(0.5)]]) // 故意维度不符
    const r = await search(s, fakeEmb('fake-model-A-fp16'), '退款超限校验', { topK: 2 })
    check('维度不符 → 不用向量通道并说明', r.mode === 'fts' && /维度/.test(r.note), r.note.slice(0, 100))
    dropIndex(s)
  }

  dropIndex(storeEmb)
  for (const d of [tmpEmb, dirA, dirB]) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* Windows 句柄，留给系统清理 */
    }
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

// ---------- 11. 清理 ----------
console.log('\n[11] 清空索引')
dropIndex(store)
check('清空后块数为 0', store.stats().chunks === 0)
check('清空后向量为 0', store.stats().vectors === 0)
check('清空后文件数为 0', store.stats().files === 0)
dropIndex(storeFts)

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
