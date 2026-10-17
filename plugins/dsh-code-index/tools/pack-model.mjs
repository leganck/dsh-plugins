/**
 * 把默认嵌入模型**随包提供**（但**不进 git**）。
 *
 * 为什么这样设计：
 *  - 用户要的"默认打包"= 装好插件就能用，不用再下 194 MB ✓
 *  - 但把二进制提交进 git 会让仓库永久膨胀 ✗（且不可逆）→ 所以：**打包时临时拷入 `<plugin>/model`，
 *    打包后立刻删除**；`.gitignore` 忽略 `model/`，仓库里始终只有源码 ✓
 *
 * 为什么放 **fp16**（194 MB）而不是 int8（97.7 MB）：
 *  - **int8 实测不合格**：这颗 `Xenova/bge-base-zh-v1.5` 的 int8 导出会让向量**塌缩** ——
 *    4 段互不相关文本两两余弦平均 **0.806**（健康应 ≤0.5），而同一模型的 fp16 是 **0.464**，
 *    bge-small-zh 的 fp16 是 0.450。塌缩的直接后果：通用块（DTO 类头、AGENTS.md）成了所有中文提问的
 *    最近邻，语义召回全面失效（这件事在真实仓库上复现过，与题量无关）。
 *  - 所以随包提供 **fp16**（194 MB）。它在 CPU 与 DirectML 上都能跑（实测 34 ms / 13 ms 每查询），
 *    `lib/embedder.js` 用"探测推理 + 失败重建到 CPU"兜住 GPU 的瞬时 TDR。
 *
 * 用法：
 *   node tools/pack-model.mjs stage   # 拷入 <plugin>/model（npm prepack 自动调用）
 *   node tools/pack-model.mjs clean   # 删除 <plugin>/model（npm postpack 自动调用）
 *   node tools/pack-model.mjs status  # 看当前是否已 stage、体积多大
 * 参数：`--from <模型目录>`（默认 ~/.dsh/models/bge-base-zh-v1.5）、`--quant int8|fp16`
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const PLUGIN_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const MODEL_DIR = path.join(PLUGIN_DIR, 'model')
const FROM = arg('--from', path.join(os.homedir(), '.dsh', 'models', 'bge-base-zh-v1.5'))
const QUANT = arg('--quant', 'fp16')
const action = process.argv[2] ?? 'status'

const NEEDED = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json']
const ONNX = `model_${QUANT}.onnx`

const sizeOf = (dir) => {
  if (!fs.existsSync(dir)) return 0
  let n = 0
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) n += sizeOf(p)
    else n += fs.statSync(p).size
  }
  return n
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`

if (action === 'stage') {
  if (!fs.existsSync(path.join(FROM, ONNX))) {
    console.error(`  ❌ 源模型缺 ${ONNX}（目录 ${FROM}）—— 先跑 tools/fetch-model.mjs --model bge-base-zh-v1.5 --quant ${QUANT}`)
    process.exit(1)
  }
  fs.rmSync(MODEL_DIR, { recursive: true, force: true })
  fs.mkdirSync(MODEL_DIR, { recursive: true })
  for (const f of [...NEEDED, ONNX]) {
    const src = path.join(FROM, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(MODEL_DIR, f))
  }
  console.log(`  ✅ 已把模型拷入 ${MODEL_DIR}（${mb(sizeOf(MODEL_DIR))}，${QUANT}）`)
} else if (action === 'clean') {
  fs.rmSync(MODEL_DIR, { recursive: true, force: true })
  console.log(`  ✅ 已清理 ${MODEL_DIR}（仓库里不留二进制）`)
} else {
  const exists = fs.existsSync(path.join(MODEL_DIR, ONNX))
  console.log(`  打包目录：${MODEL_DIR}`)
  console.log(`  状态：${exists ? `已 stage（${mb(sizeOf(MODEL_DIR))}）` : '未 stage（npm pack 时会自动拷入）'}`)
  console.log(`  源：${FROM}（${QUANT}）`)
}
