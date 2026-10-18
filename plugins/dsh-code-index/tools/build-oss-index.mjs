/**
 * 给任意仓库建一份纯全文索引（不补算向量）——用于在**开源语料**上做题库评测。
 *
 * 用法：
 *   node tools/build-oss-index.mjs <repoRoot> [indexDirBase]
 *
 * 输出最后一行是索引路径，便于后续远端同步脚本使用。
 */
import path from 'node:path'
import { Store } from '../lib/store.js'
import { buildIndex, indexDbPath } from '../lib/indexer.js'

const repoRoot = process.argv[2]
const indexDirBase = process.argv[3] || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'code-index-oss')

if (!repoRoot) {
  console.error('usage: node tools/build-oss-index.mjs <repoRoot> [indexDirBase]')
  process.exit(2)
}

const dbPath = indexDbPath(repoRoot, { indexDirBase })
const store = Store.open(dbPath)
const t0 = Date.now()
const r = await buildIndex({ store, repoRoot, budget: { mode: 'full', maxEmbedPerRun: 0 } })
const ms = Date.now() - t0
const stats = store.stats()
console.log(
  JSON.stringify(
    {
      repo: repoRoot,
      db: dbPath,
      ms,
      ...stats,
      files_indexed: r?.files ?? r?.indexed ?? null,
      chunks: r?.chunks ?? null,
    },
    null,
    1
  )
)
store.db.close?.()
