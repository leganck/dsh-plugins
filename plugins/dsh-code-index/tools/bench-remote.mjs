/**
 * 远端服务基准：直接打 `/embed` 与 `/rerank`，量"真网络下的端到端延迟"。
 *
 * 为什么不用 curl：curl 每次新建连接，实测 0.45–5.5 s 全是 TLS 握手的固定成本；
 * 产品形态会复用连接，这里用插件自己的 `lib/remote.js`（fetch + 连接复用）打，
 * 量出来的才是一次查询真正要付的钱。
 *
 * 用法：
 *   node tools/bench-remote.mjs --url https://dsh-embed.example.com --tag bge-base-zh-v1.5-xxxxxxxx-fp16
 *   node tools/bench-remote.mjs --url https://… --runs 20 --batch 8 --skip-rerank
 */
import { createRemoteEmbedder, createRemoteReranker, endpointsOf } from '../lib/remote.js'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const url = arg('--url', '')
const tag = arg('--tag', null)
const runs = Number(arg('--runs', '10'))
const batch = Number(arg('--batch', '8'))
const skipRerank = argv.includes('--skip-rerank')

if (!url) {
  console.error('用法：node tools/bench-remote.mjs --url https://… [--tag …] [--runs 10] [--batch 8]')
  process.exit(1)
}

const pct = (arr, p) => {
  const a = arr.slice().sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))]
}
const r1 = (v) => Number(v.toFixed(1))

// 一、纯网络：GET 基址（服务端自述，最小响应体）—— 这是 RTT 的近似值
const ep = endpointsOf(url)
const rtt = []
for (let i = 0; i < runs; i++) {
  const t = performance.now()
  const res = await fetch(ep.status, { signal: AbortSignal.timeout(15000) })
  await res.text()
  rtt.push(performance.now() - t)
}
const st = await (await fetch(ep.status, { signal: AbortSignal.timeout(15000) })).json()
console.log(`服务端：${ep.base}`)
console.log(`  自述：${JSON.stringify({ model: st.model, model_bytes: st.model_bytes, ort: st.ort, providers: st.used_providers, ready: st.ready, tag: st.tag ?? '(未提供)' })}`)
console.log(`  HTTP RTT：p50 ${r1(pct(rtt, 0.5))} ms / p90 ${r1(pct(rtt, 0.9))} ms / min ${r1(Math.min(...rtt))} ms`)

// 二、查询嵌入（batch=1，is_query=true）—— 查询路径的真实成本
const emb = await createRemoteEmbedder({ url, tag, fallbackLocal: false, log: () => {} })
if (!emb.ok) {
  console.error('远端嵌入不可用：' + emb.reason)
  process.exit(1)
}
const Q = '退款超限校验是在哪个方法里做的，超限之后会抛什么异常'
await emb.embed([Q], { isQuery: true, useCache: false })
const q = []
for (let i = 0; i < runs; i++) {
  const t = performance.now()
  await emb.embed([Q], { isQuery: true, useCache: false })
  q.push(performance.now() - t)
}
console.log(`\n/embed 单条查询：p50 ${r1(pct(q, 0.5))} ms / p90 ${r1(pct(q, 0.9))} ms / min ${r1(Math.min(...q))} ms（含网络）`)

// 三、批量（用于建库）—— 响应体 = batch × dim × 4 字节，是这条链路真正吃的带宽
const body = Array.from({ length: batch }, (_, i) => `public void handleRefundLimitCheck${i}(Map<String, Object> params) { log.info("退款超限校验 {}", params); }`)
await emb.embed(body, { isQuery: false, useCache: false })
const b = []
for (let i = 0; i < Math.max(3, Math.floor(runs / 2)); i++) {
  const t = performance.now()
  await emb.embed(body, { isQuery: false, useCache: false })
  b.push(performance.now() - t)
}
const dim = emb.dim ?? 768
console.log(
  `/embed 批量 ${batch} 条：p50 ${r1(pct(b, 0.5))} ms（${r1(pct(b, 0.5) / batch)} ms/条；回包 ${r1((batch * dim * 4) / 1024)} KB，等效 ${r1((batch * dim * 4) / 1024 / (pct(b, 0.5) / 1000))} KB/s）`,
)

// 四、重排（服务端装了模型才有）
if (!skipRerank) {
  const rr = await createRemoteReranker({ url, fallbackLocal: false, log: () => {} })
  if (!rr.ok) {
    console.log(`\n/rerank：不可用 —— ${rr.reason}`)
  } else {
    const cands = body
    await rr.score(Q, cands)
    const t = []
    for (let i = 0; i < Math.max(3, Math.floor(runs / 2)); i++) {
      const t0 = performance.now()
      await rr.score(Q, cands)
      t.push(performance.now() - t0)
    }
    console.log(`/rerank ${cands.length} 个候选：p50 ${r1(pct(t, 0.5))} ms（${r1(pct(t, 0.5) / cands.length)} ms/候选，含网络）`)
  }
}
