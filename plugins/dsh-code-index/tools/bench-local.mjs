/**
 * 本机推理性能基准（**只读**，不写任何索引）。
 *
 * 回答三个问题，每个都用本机实测数字：
 *   1. 单条查询的嵌入要多久（DML / CPU 各多少）—— 这是 `code_search` 查询路径的固定成本
 *   2. 建库吞吐是多少块/秒 —— 决定一个仓库首次建索引要等多久
 *   3. 交叉编码器重排每个候选多少 ms —— 重排档位（fast=10 / quality=20 个候选）的成本是它的倍数
 *
 * 用法：
 *   node tools/bench-local.mjs --model-dir D:/dsh-models/bge-base-zh-v1.5 \
 *        --deps-dir D:/dsh-code-index/embed-deps --blocks 200
 *   node tools/bench-local.mjs --rerank-model-dir D:/dsh-models/bge-reranker-base
 *
 * 设计要点（都是踩过的坑）：
 *  - **必须绕过向量缓存**：默认缓存 ~/.dsh/index/vectors.db 按文本哈希命中，重复跑会给出
 *    "17 ms 嵌入 676 块"这种假数字。这里给一次性 cachePath，且测量时 useCache:false。
 *  - **文本用真实代码**：合成 filler 的 token 分布和真代码差很远，量出来的吞吐会偏乐观。
 *  - **int8 要验塌陷**：bge-base 的 int8 导出曾出现"无关文本余弦 0.806"（健康值 ~0.46），
 *    即向量空间被压扁 —— 那种模型再快也不能用。这里顺手算一遍，别让快数字骗了决策。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEmbedder } from '../lib/embedder.js'
import { createReranker } from '../lib/reranker.js'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const flag = (k) => argv.includes(k)

const modelDir = arg('--model-dir', path.join(os.homedir(), '.dsh', 'models', 'bge-base-zh-v1.5'))
const depsDir = arg('--deps-dir', undefined)
const blocks = Number(arg('--blocks', '200'))
const queryRuns = Number(arg('--queries', '20'))
const batch = arg('--batch') ? Number(arg('--batch')) : null
const backends = String(arg('--backends', 'gpu,cpu')).split(',').map((s) => s.trim()).filter(Boolean)
const rerankModelDir = arg('--rerank-model-dir', null)
const tmpBase = arg('--tmp', 'D:/dsh-bench-tmp')

if (!fs.existsSync(path.join(modelDir, 'tokenizer.json'))) {
  console.error(`模型目录不完整（缺 tokenizer.json）：${modelDir}`)
  process.exit(1)
}
fs.mkdirSync(tmpBase, { recursive: true })

/** 一次性缓存文件：既不命中别人的向量，也不污染 ~/.dsh/index/vectors.db */
const freshCache = path.join(tmpBase, `bench-cache-${Date.now()}.db`)

const pct = (arr, p) => {
  const a = arr.slice().sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))]
}
const round = (v, n = 1) => Number(v.toFixed(n))

/**
 * 取真实代码块：从指定目录树里按 40 行切，凑够 N 块。
 * 优先用本次仓库自己的源码（就是被测插件的真实输入形态）。
 */
function realBlocks(n) {
  const roots = [arg('--corpus', path.resolve(import.meta.dirname, '..'))]
  const out = []
  const walk = (dir, depth = 0) => {
    if (out.length >= n || depth > 6) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= n) return
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'model' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.(js|mjs|md|json|py|java|ts)$/.test(e.name)) {
        let text
        try {
          text = fs.readFileSync(p, 'utf8')
        } catch {
          continue
        }
        const lines = text.split(/\r?\n/)
        for (let i = 0; i + 40 <= lines.length && out.length < n; i += 40) {
          const body = lines.slice(i, i + 40).join('\n')
          if (body.trim().length > 200) out.push(body)
        }
      }
    }
  }
  for (const r of roots) walk(r)
  return out
}

const QUESTION = '退款超限校验是在哪个方法里做的，超限之后会抛什么异常'
const UNRELATED = [
  'public void handleRefundLimitCheck(Map<String, Object> params) { log.info("退款超限校验 {}", params); }',
  '本周的天气预报显示江南地区将出现持续降雨，气温下降六度左右。',
  'SELECT order_no, pay_at FROM erp_chain_order WHERE status = 11 AND pay_at > ?',
  'The mitochondria is the powerhouse of the cell and produces ATP through respiration.',
]

async function benchOne(backend) {
  const cachePath = path.join(tmpBase, `bench-cache-${backend}-${Date.now()}.db`)
  const t0 = Date.now()
  const emb = await createEmbedder({
    modelDir,
    backend,
    batch,
    cachePath,
    depsDir,
    depsFallbackDirs: [],
    log: () => {},
  })
  const loadMs = Date.now() - t0
  if (!emb.ok) return { backend, ok: false, reason: emb.reason }

  // 预热一次（首次 session.run 会做图优化/内核编译，计入测量会把 p50 拉偏）
  await emb.embed([QUESTION], { isQuery: true, useCache: false })

  const qLat = []
  for (let i = 0; i < queryRuns; i++) {
    const t = performance.now()
    await emb.embed([QUESTION], { isQuery: true, useCache: false })
    qLat.push(performance.now() - t)
  }

  const texts = realBlocks(blocks)
  const tBuild = performance.now()
  await emb.embed(texts, { isQuery: false, useCache: false })
  const buildMs = performance.now() - tBuild

  // 塌陷检查：无关文本之间应当"不像"（健康 bge ≈ 0.45–0.49，塌陷 ≈ 0.8）
  const vecs = await emb.embed(UNRELATED, { isQuery: false, useCache: false })
  let sum = 0
  let cnt = 0
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      let s = 0
      for (let d = 0; d < vecs[i].length; d++) s += vecs[i][d] * vecs[j][d]
      sum += s
      cnt++
    }
  }

  return {
    backend: emb.backend,
    ok: true,
    modelFile: emb.modelFile,
    modelTag: emb.modelTag,
    dim: vecs[0].length,
    batch: emb.batch,
    loadMs,
    query: { p50: round(pct(qLat, 0.5), 2), p90: round(pct(qLat, 0.9), 2), min: round(Math.min(...qLat), 2), max: round(Math.max(...qLat), 2) },
    build: { blocks: texts.length, totalMs: round(buildMs, 0), msPerBlock: round(buildMs / texts.length, 1), blocksPerSec: round((texts.length / buildMs) * 1000, 2) },
    unrelatedCosine: round(sum / cnt, 3),
    collapsed: sum / cnt > 0.7,
  }
}

const results = []
for (const b of backends) {
  process.stdout.write(`测量 backend=${b} … `)
  try {
    const r = await benchOne(b)
    results.push(r)
    console.log(r.ok ? `${r.query.p50} ms/查询，${r.build.blocksPerSec} 块/s` : `不可用：${r.reason}`)
  } catch (e) {
    console.log(`失败：${e.message}`)
    results.push({ backend: b, ok: false, reason: String(e?.message ?? e) })
  }
}

let rerank = null
if (rerankModelDir) {
  const t0 = Date.now()
  const rr = await createReranker({ modelDir: rerankModelDir, backend: 'auto', depsDir, depsFallbackDirs: [], log: () => {} })
  const loadMs = Date.now() - t0
  if (!rr.ok) {
    rerank = { ok: false, reason: rr.reason }
  } else {
    const cands = realBlocks(20)
    const t = performance.now()
    const scores = await rr.score(QUESTION, cands)
    const total = performance.now() - t
    // 再跑两轮取稳定值（首轮含内核预热）
    const again = []
    for (let i = 0; i < 2; i++) {
      const t2 = performance.now()
      await rr.score(QUESTION, cands)
      again.push(performance.now() - t2)
    }
    rerank = {
      ok: true,
      backend: rr.backend,
      modelFile: rr.modelFile,
      loadMs,
      candidates: cands.length,
      firstMs: round(total, 0),
      steadyMs: round(Math.min(...again), 0),
      msPerCandidate: round(Math.min(...again) / cands.length, 1),
      topScore: round(Math.max(...scores), 3),
    }
  }
}

const lines = []
lines.push('')
lines.push('════════ 本机嵌入 / 重排基准 ════════')
lines.push(`模型目录：${modelDir}`)
lines.push(`依赖目录：${depsDir ?? '（默认受管目录）'}`)
lines.push(`机器：${os.cpus()[0]?.model?.trim()} × ${os.cpus().length} 线程，内存 ${round(os.totalmem() / 1024 ** 3, 0)} GB，node ${process.version}`)
lines.push('')
lines.push('后端     模型文件            加载    查询 p50 / p90     建库吞吐        无关文本余弦')
for (const r of results) {
  if (!r.ok) {
    lines.push(`${String(r.backend).padEnd(8)} 不可用：${r.reason}`)
    continue
  }
  lines.push(
    `${String(r.backend).padEnd(8)} ${String(r.modelFile).padEnd(17)} ${String(r.loadMs + ' ms').padEnd(7)} ` +
      `${String(r.query.p50 + ' / ' + r.query.p90 + ' ms').padEnd(17)} ` +
      `${String(r.build.blocksPerSec + ' 块/s').padEnd(15)} ${r.unrelatedCosine}${r.collapsed ? ' ⚠️ 塌陷（不可用）' : ''}`,
  )
}
if (rerank) {
  lines.push('')
  if (!rerank.ok) lines.push(`重排：不可用 —— ${rerank.reason}`)
  else
    lines.push(
      `重排：${rerank.modelFile} @ ${rerank.backend}，${rerank.candidates} 个候选 ${rerank.steadyMs} ms（${rerank.msPerCandidate} ms/候选，加载 ${rerank.loadMs} ms）`,
    )
}
lines.push('')
lines.push(`（每次运行都用一次性缓存，文本为真实代码块 ${blocks} 个；查询 ${queryRuns} 次取分位数）`)
console.log(lines.join('\n'))

const outFile = path.join(tmpBase, `bench-local-${Date.now()}.json`)
fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), modelDir, depsDir, blocks, queryRuns, results, rerank }, null, 2))
console.log(`\nJSON：${outFile}`)
