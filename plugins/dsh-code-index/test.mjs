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

// ---------- 7. 清理 ----------
console.log('\n[7] 清空索引')
dropIndex(store)
check('清空后块数为 0', store.stats().chunks === 0)
check('清空后向量为 0', store.stats().vectors === 0)
check('清空后文件数为 0', store.stats().files === 0)
dropIndex(storeFts)

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
