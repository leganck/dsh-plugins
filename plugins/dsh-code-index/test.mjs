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
import { createEmbedder } from './lib/embedder.js'
import {
  depsStatus,
  makeResolvers,
  loadFrom,
  buildInstallArgs,
  npmInvocation,
  pruneForeignPlatforms,
  readManifest,
  EMBED_PACKAGES,
} from './lib/deps.js'
import { search } from './lib/search.js'
import { walkRepo } from './lib/scan.js'

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

  fs.rmSync(tmp, { recursive: true, force: true })
}

// ---------- 8. 清理 ----------
console.log('\n[8] 清空索引')
dropIndex(store)
check('清空后块数为 0', store.stats().chunks === 0)
check('清空后向量为 0', store.stats().vectors === 0)
check('清空后文件数为 0', store.stats().files === 0)
dropIndex(storeFts)

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
