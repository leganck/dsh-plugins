/**
 * 打出**两个**发布产物（默认包 + 自带模型的包）。
 *
 * 为什么要两个：
 *  - `local-dsh-code-index-<v>.tgz`：**不含模型**（约 150 KB）。向量位置在本机时它需要用户自己
 *    放模型或让插件去向远端要；`vectorStore: remote` 的用户（比如接 NAS 的那台）不需要 194 MB 的模型。
 *  - `local-dsh-code-index-<v>-local-model.tgz`：**随包带 fp16 模型**（约 178 MB）。装完即用、不联网。
 *
 * 为什么用 `npm pack --ignore-scripts`：
 *  package.json 的 prepack 会自动 `pack-model.mjs stage`（拷入模型）。要打"不带模型"的那个包，
 *  必须跳过生命周期脚本 —— 否则两个包都一样大。
 *
 * 产物落在 `release/`；`release/*.tgz` 已被 .gitignore 忽略（构建产物不进 git），
 * 只把 `release/SHA256SUMS.txt` 当作版本与校验记录提交。
 *
 * 用法：
 *   node build-release.mjs                 # 两个都打
 *   node build-release.mjs --no-model      # 只打不带模型的
 *   node build-release.mjs --from D:/dsh-models/bge-base-zh-v1.5
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const withModel = !argv.includes('--no-model')
const fromIdx = argv.indexOf('--from')
const fromModel = fromIdx >= 0 ? argv[fromIdx + 1] : 'D:/dsh-models/bge-base-zh-v1.5'
const releaseDir = path.join(PLUGIN_DIR, 'release')
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))
const version = pkg.version
const baseName = `local-dsh-code-index-${version}`

fs.mkdirSync(releaseDir, { recursive: true })
// 临时目录必须与产物同卷（C: 的 temp 与 D: 的仓库会 EXDEV），也顺便少拷一次 178 MB
const tmp = fs.mkdtempSync(path.join(PLUGIN_DIR, '.pack-tmp-'))
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function pack() {
  // 不用 --pack-destination（Windows 上引号/反斜杠容易被 shell 吃掉，实测产 0 文件）。
  // 直接在插件目录里 pack，再把生成的 tgz 搬走 —— 产物名是确定的 `<name>-<version>.tgz`。
  const out = path.join(PLUGIN_DIR, `${baseName}.tgz`)
  fs.rmSync(out, { force: true })
  execFileSync(`npm pack --ignore-scripts`, { cwd: PLUGIN_DIR, stdio: ['ignore', 'ignore', 'inherit'], shell: true })
  if (!fs.existsSync(out)) throw new Error(`npm pack 没有产出 ${out}`)
  const dst = path.join(tmp, `${Date.now()}-${built.length}.tgz`)
  fs.renameSync(out, dst)
  return dst
}
/** 包里是否真的带了模型（用 tar 列表判断，别信文件名） */
function hasModel(tgz) {
  try {
    const out = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1048576 })
    return /package\/model\/model_fp16\.onnx/.test(out)
  } catch {
    // tar 不可用时退化为"比体积"
    return fs.statSync(tgz).size > 50 * 1048576
  }
}

const built = []
try {
  // ① 不带模型
  const small = pack()
  const smallDst = path.join(releaseDir, `${baseName}.tgz`)
  fs.copyFileSync(small, smallDst)
  built.push({ file: smallDst, model: hasModel(smallDst) })
  console.log(`  ✅ ${path.basename(smallDst)}  ${mb(fs.statSync(smallDst).size)}  含模型=${hasModel(smallDst)}`)

  // ② 带模型：显式 stage 一次（不依赖 prepack，行为更可控）
  if (withModel) {
    execFileSync(process.execPath, [path.join(PLUGIN_DIR, 'tools', 'pack-model.mjs'), 'stage', '--from', fromModel], {
      cwd: PLUGIN_DIR,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    const big = pack()
    const bigDst = path.join(releaseDir, `${baseName}-local-model.tgz`)
    fs.copyFileSync(big, bigDst)
    const ok = hasModel(bigDst)
    built.push({ file: bigDst, model: ok })
    console.log(`  ${ok ? '✅' : '❌'} ${path.basename(bigDst)}  ${mb(fs.statSync(bigDst).size)}  含模型=${ok}`)
    if (!ok) throw new Error('带模型的包里没有 model/model_fp16.onnx')
  }
} finally {
  execFileSync(process.execPath, [path.join(PLUGIN_DIR, 'tools', 'pack-model.mjs'), 'clean'], { cwd: PLUGIN_DIR, stdio: 'ignore' })
  fs.rmSync(tmp, { recursive: true, force: true })
}

// 校验和（只记录本版本的两个产物 + 历史保留）
const lines = []
for (const file of fs.readdirSync(releaseDir).filter((f) => f.endsWith('.tgz')).sort()) {
  const full = path.join(releaseDir, file)
  lines.push(`${sha256(full)}  ${file}  ${fs.statSync(full).size}`)
}
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
console.log(`\n校验和写入 release/SHA256SUMS.txt（${lines.length} 个产物）`)
for (const b of built) console.log(`  ${path.basename(b.file)}  ${b.model ? '带模型' : '不带模型'}`)
