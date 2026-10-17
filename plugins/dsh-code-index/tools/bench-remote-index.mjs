/**
 * 端到端：远端索引模式的延迟拆分与一致性检查。
 *
 * 量三件事（同一批问题、同一个仓库）：
 *   ① 本地 BM25 单独耗时
 *   ② 远端 kNN 单独耗时（含局域网往返；服务端自报 embed/knn 分解）
 *   ③ 客户端 RRF 融合后的总耗时，以及有多少远端命中在本地 join 不到（staleHits）
 *
 * 用法：
 *   node tools/bench-remote-index.mjs --repo D:/Projects/GolandProjects/energy \
 *        --url https://dsh-embed.taek.site --index-base D:/dsh-bench-tmp/remote-index --runs 2
 */
import fs from 'node:fs'
import path from 'node:path'
import { Store } from '../lib/store.js'
import { indexDbPath } from '../lib/indexer.js'
import { createRemoteIndex } from '../lib/remote.js'
import { repoIdOf } from '../lib/repo.js'
import { searchFusedRemote } from '../lib/search.js'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const repoRoot = path.resolve(arg('--repo', ''))
const url = arg('--url', 'https://dsh-embed.taek.site')
const indexBase = arg('--index-base', 'D:/dsh-bench-tmp/remote-index')
const runs = Number(arg('--runs', '2'))
const rerankCandidates = Number(arg('--rerank-candidates', '0'))

const QUESTIONS = [
  '退款的超限校验是在哪个方法里做的，超限之后会抛什么异常',
  '这个项目里配置文件和命令行参数是怎么合并的',
  '数据库连接池在哪里初始化，最大连接数从哪读',
  '定时任务是怎么注册的，多久跑一次',
  '用户权限校验是在拦截器里做的吗',
  '日志里出现 timeout 之后会怎么重试',
  '缓存失效以后是从哪里重新加载的',
  '这个仓库的单元测试是怎么组织的',
]

const dbPath = indexDbPath(repoRoot, { indexDirBase: indexBase })
if (!fs.existsSync(dbPath)) {
  console.error(`本地库不存在（先跑 tools/remote-index-sync.mjs）：${dbPath}`)
  process.exit(1)
}
const store = Store.open(dbPath)
const client = createRemoteIndex({ url })
const namespace = `${repoIdOf(repoRoot)}@${store.getMeta('chunk_fingerprint') ?? 'default'}`
const st = await client.status(namespace)
console.log(`仓库：${repoRoot}`)
console.log(`命名空间：${namespace}`)
console.log(`服务端：revision ${st.revision}；${st.chunks} 块 / ${st.vectors} 向量（覆盖 ${((st.coverage ?? 0) * 100).toFixed(0)}%）；限速 ${st.rate}/s`)

const pct = (a, p) => {
  const s = a.slice().sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}
const r1 = (v) => Number(v.toFixed(1))
const ftsTimes = []
const remoteTimes = []
const fusedTimes = []
const serverMs = { embed: [], knn: [], rerank: [] }
let stale = 0
let hits = 0

for (let i = 0; i < runs; i++) {
  for (const q of QUESTIONS) {
    const t0 = performance.now()
    const res = await client.search(namespace, q, { k: 40, rerankCandidates })
    remoteTimes.push(performance.now() - t0)
    if (res.ms) for (const k of Object.keys(serverMs)) if (res.ms[k] !== undefined) serverMs[k].push(res.ms[k])
    const remoteHits = (res.hits ?? []).map((h) => ({ hash: h.hash, score: h.score, rerankScore: h.rerankScore }))
    const t1 = performance.now()
    const fused = await searchFusedRemote(store, q, { topK: 10, remoteHits })
    fusedTimes.push(performance.now() - t1)
    stale += fused.staleHits ?? 0
    hits += fused.results.length
    if (i === 0 && q === QUESTIONS[0]) {
      console.log(`  首条：通道 ${fused.mode}，命中 ${fused.results.length}；服务端分解 ${JSON.stringify(res.ms)}`)
    }
  }
}

// 纯本地 BM25 基线（同一批问题）
for (let i = 0; i < runs; i++) {
  for (const q of QUESTIONS) {
    const t0 = performance.now()
    await searchFusedRemote(store, q, { topK: 10, remoteHits: [] })
    ftsTimes.push(performance.now() - t0)
  }
}

console.log(`\n════════ 延迟（${QUESTIONS.length * runs} 次查询）════════`)
console.log(`① 纯本地 BM25            p50 ${r1(pct(ftsTimes, 0.5))} ms / p90 ${r1(pct(ftsTimes, 0.9))} ms`)
console.log(`② 远端 kNN（含往返）      p50 ${r1(pct(remoteTimes, 0.5))} ms / p90 ${r1(pct(remoteTimes, 0.9))} ms`)
console.log(`   服务端自报：embed ${r1(pct(serverMs.embed, 0.5))} / knn ${r1(pct(serverMs.knn, 0.5))} / rerank ${r1(pct(serverMs.rerank, 0.5))} ms（p50）`)
console.log(`③ 客户端融合总耗时        p50 ${r1(pct(fusedTimes, 0.5))} ms / p90 ${r1(pct(fusedTimes, 0.9))} ms`)
console.log(`   命中合计 ${hits}，join 不到（stale）${stale}`)
store.close?.()
