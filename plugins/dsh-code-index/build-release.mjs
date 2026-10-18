/**
 * 打发布产物（0.10.0 起只有一个：不含任何本地模型）。
 *
 * 本地嵌入/重排已移除，包体只有纯 JS + 文档/测试，约 150 KB；向量与重排都走远端。
 *
 * 为什么用 `npm pack --ignore-scripts`：不执行任何生命周期脚本，避免历史遗留的
 * prepack/postpack 把模型目录再拉进来。
 *
 * 产物落在 `release/`；`release/*.tgz` 已被 .gitignore 忽略（构建产物不进 git），
 * 只把 `release/SHA256SUMS.txt` 当作版本与校验记录提交。
 *
 * 用法：
 *   node build-release.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const releaseDir = path.join(PLUGIN_DIR, 'release')
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))
const baseName = `local-dsh-code-index-${pkg.version}`

fs.mkdirSync(releaseDir, { recursive: true })
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// 直接插件目录里 pack，再把产物搬进 release/（Windows 上 --pack-destination 容易被 shell 吃引号）
const out = path.join(PLUGIN_DIR, `${baseName}.tgz`)
fs.rmSync(out, { force: true })
execFileSync('npm pack --ignore-scripts', { cwd: PLUGIN_DIR, stdio: ['ignore', 'ignore', 'inherit'], shell: true })
if (!fs.existsSync(out)) throw new Error(`npm pack 没有产出 ${out}`)

const dst = path.join(releaseDir, `${baseName}.tgz`)
fs.renameSync(out, dst)
console.log(`  ✅ ${path.basename(dst)}  ${mb(fs.statSync(dst).size)}`)

// 校验和：只记 release/ 里**实际存在**的产物（正常情况下就是当前版本）；
// 历史版本不在这里累积 —— 它们靠自己的 tag / GitHub Release 资产。
const lines = []
for (const file of fs.readdirSync(releaseDir).filter((f) => f.endsWith('.tgz')).sort()) {
  const full = path.join(releaseDir, file)
  lines.push(`${sha256(full)}  ${file}  ${fs.statSync(full).size}`)
}
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
