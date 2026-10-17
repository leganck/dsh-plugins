/**
 * 探针：把"每条成本"和"每批固定开销"分开量。
 *
 * 动机：基准里 DML 单条查询 48 ms、建库 27.6 块/s（≈36 ms/块），而几十条一批时理应更快。
 * 若 t(N) 曲线近似 t(N) ≈ a + b·N，则 a = 每次调用的固定开销（提交/回读/同步），
 * b = 每条的边际成本。查询路径永远是 batch=1，所以 **a 才是查询延迟的主项**；
 * 建库是长批，看 b。这两个数决定"远端是否真的更快"，不能混在一起看。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createEmbedder } from '../lib/embedder.js'

const DEPS = 'D:/dsh-code-index/embed-deps'
const FULL = 'D:/dsh-models/bge-base-zh-v1.5'
const FP16ONLY = 'D:/dsh-models/bge-base-fp16-only'

// 造一个只有 fp16 的目录：本机 CPU 分支默认挑 int8（已验塌陷），要量"能用的 CPU 基线"必须绕开它
if (!fs.existsSync(FP16ONLY)) {
  fs.mkdirSync(FP16ONLY, { recursive: true })
  for (const f of fs.readdirSync(FULL)) {
    const src = path.join(FULL, f)
    const dst = path.join(FP16ONLY, f)
    if (f === 'model_int8.onnx' || fs.existsSync(dst)) continue
    try {
      fs.linkSync(src, dst)
    } catch {
      fs.copyFileSync(src, dst)
    }
  }
}

const TEXT = 'public void handleRefundLimitCheck(Map<String, Object> params) { log.info("退款超限校验 {}", params); }'

async function probe(label, { modelDir, backend, threads = 6 }) {
  const emb = await createEmbedder({
    modelDir,
    backend,
    threads,
    depsDir: DEPS,
    cachePath: path.join('D:/dsh-bench-tmp', `probe-${label}-${Date.now()}.db`),
    log: () => {},
  })
  if (!emb.ok) return { label, ok: false, reason: emb.reason }
  const rows = []
  for (const n of [1, 2, 4, 8, 16, 32]) {
    const texts = Array.from({ length: n }, () => TEXT)
    await emb.embed(texts, { isQuery: false, useCache: false }) // 预热
    const runs = []
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      await emb.embed(texts, { isQuery: false, useCache: false })
      runs.push(performance.now() - t)
    }
    const best = Math.min(...runs)
    rows.push({ n, best, perItem: best / n })
  }
  // 拟合 a + b·N（用最小二乘，n>=2 的点）
  const pts = rows.filter((r) => r.n >= 2)
  const N = pts.length
  const sx = pts.reduce((s, r) => s + r.n, 0)
  const sy = pts.reduce((s, r) => s + r.best, 0)
  const sxx = pts.reduce((s, r) => s + r.n * r.n, 0)
  const sxy = pts.reduce((s, r) => s + r.n * r.best, 0)
  const b = (N * sxy - sx * sy) / (N * sxx - sx * sx)
  const a = (sy - b * sx) / N
  return { label, ok: true, backend: emb.backend, modelFile: emb.modelFile, rows, interceptMs: Number(a.toFixed(1)), perItemMs: Number(b.toFixed(2)) }
}

const out = []
out.push(await probe('dml-fp16', { modelDir: FULL, backend: 'gpu' }))
out.push(await probe('cpu-fp16', { modelDir: FP16ONLY, backend: 'cpu' }))
out.push(await probe('cpu-fp16-16t', { modelDir: FP16ONLY, backend: 'cpu', threads: 16 }))

for (const r of out) {
  console.log(`\n── ${r.label}${r.ok ? ` (${r.backend}/${r.modelFile})` : ''}`)
  if (!r.ok) {
    console.log('   不可用：' + r.reason)
    continue
  }
  console.log('   N   总耗时      每条')
  for (const row of r.rows) console.log(`   ${String(row.n).padEnd(4)}${String(row.best.toFixed(1) + ' ms').padEnd(12)}${row.perItem.toFixed(1)} ms`)
  console.log(`   拟合：固定开销 ${r.interceptMs} ms/次，边际 ${r.perItemMs} ms/条`)
}
fs.writeFileSync('D:/dsh-bench-tmp/probe.json', JSON.stringify(out, null, 2))
