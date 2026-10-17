/**
 * 把某个仓库同步到远端索引服务（`vectorStore: 'remote'` 的命令行版本）。
 *
 * 与 `code_index` 工具做的是同一件事，但不依赖 DSH：
 *   ① 本地建 BM25 索引（切块 + FTS5，秒级）
 *   ② 清单差分同步 → 服务端回"缺哪些块的向量"
 *   ③ 只上传这些块的正文（幂等）
 *   ④ 服务端后台嵌入（限流），本工具可选地等待并打印覆盖率
 *
 * 用法：
 *   node tools/remote-index-sync.mjs --repo D:/Projects/GolandProjects/energy \
 *        --url https://dsh-embed.taek.site [--wait] [--rate 10] [--index-base D:/dsh-bench-tmp/remote-index]
 */
import fs from 'node:fs'
import path from 'node:path'
import { Store } from '../lib/store.js'
import { buildIndex, indexDbPath } from '../lib/indexer.js'
import { createRemoteIndex } from '../lib/remote.js'
import { repoIdOf, gitOriginUrl } from '../lib/repo.js'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const repoRoot = path.resolve(arg('--repo', ''))
const url = arg('--url', 'https://dsh-embed.taek.site')
const indexBase = arg('--index-base', 'D:/dsh-bench-tmp/remote-index')
const wait = argv.includes('--wait')
const rate = arg('--rate') ? Number(arg('--rate')) : null
const repoIdOverride = arg('--repo-id', null)

if (!repoRoot || !fs.existsSync(repoRoot)) {
  console.error('请用 --repo 指定仓库')
  process.exit(1)
}

const client = createRemoteIndex({ url })
const dbPath = indexDbPath(repoRoot, { indexDirBase: indexBase })
const store = Store.open(dbPath)
console.log(`仓库：${repoRoot}`)
console.log(`本地库：${dbPath}`)
console.log(`远端：${url}（${JSON.stringify((await client.health()).tag)}）`)

const repoId = repoIdOverride ?? repoIdOf(repoRoot)
const t0 = Date.now()
const r = await buildIndex({
  store,
  repoRoot,
  opts: { windowLines: 40, maxFileBytes: 2 * 1024 * 1024, excludeDirs: [], excludePaths: [] },
  embedder: { ok: false, reason: 'remote store：向量在服务端' },
  budget: { maxEmbedPerRun: 0, mode: 'incremental' },
  chunking: { strategy: 'auto', byExt: {}, windowLines: 40 },
  remote: { client, repoId, url: gitOriginUrl(repoRoot), uploadBatch: 256 },
})
console.log(`\n同步完成：revision ${r.remote?.revision}；本轮上传正文 ${r.remote?.uploaded} 条；缺向量 ${r.remote?.missing} 块`)
console.log(`  扫描 ${r.scanned} 文件 / 变更 ${r.changed} / 删除 ${r.removed} / 写入 ${r.chunksWritten} 块，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(`  ${r.embedNote}`)

const ns = r.remote.namespace
if (rate !== null) {
  await client.setRate(rate)
  console.log(`  已把服务端限速设为 ${rate} 块/s`)
}

if (wait) {
  const t1 = Date.now()
  let last = -1
  for (;;) {
    const st = await client.status(ns)
    const pct = Math.round((st.coverage ?? 0) * 100)
    if (pct !== last) {
      console.log(`  覆盖率 ${pct}%（${st.vectors}/${st.chunks}），待嵌 ${st.pending}，${((Date.now() - t1) / 1000).toFixed(0)}s`)
      last = pct
    }
    if ((st.pending ?? 0) === 0) break
    if (Date.now() - t1 > 6 * 3600 * 1000) {
      console.log('  等待超时（6h），退出（服务端会继续在后台嵌入）')
      break
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
}
store.close?.()
