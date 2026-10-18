/**
 * 统一的发布入口：遍历 `plugins/*`，跑各插件声明的 `scripts.release`。
 *
 * 为什么要它：原来每个插件的打包方式都不一样（code-index 是 `build-release.mjs`，
 * memory-archive 是 PowerShell 脚本），发版要靠记忆挑脚本、还得记住哪个先跑。
 *
 * 约定：
 *   - 插件在 package.json 的 `scripts.release` 里声明自己的打包命令；
 *   - 没声明 = 该插件暂不产出发布物（如脚手架阶段的 multiroot），报 skipped 而不是失败；
 *   - 声明了 `pwsh` 的脚本在非 Windows 上自动跳过（CI 只跑测试，不跑发布）。
 *
 * 用法：
 *   node scripts/release-all.mjs             # 全部
 *   node scripts/release-all.mjs code-index  # 只跑名字匹配的插件
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = path.join(ROOT, 'plugins')
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'))

const dirs = fs
  .readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))

if (dirs.length === 0) {
  console.error(`没有匹配的插件（过滤条件：${filters.join(', ')}）`)
  process.exit(1)
}

let ran = 0
let skipped = 0
let failed = 0

for (const name of dirs) {
  const dir = path.join(pluginsDir, name)
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) continue
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const script = pkg.scripts?.release
  if (!script) {
    console.log(`· ${name}: skipped（没有声明 scripts.release，无发布物）`)
    skipped++
    continue
  }
  if (/pwsh|powershell/i.test(script) && process.platform !== 'win32') {
    console.log(`· ${name}: skipped（打包脚本需要 PowerShell，当前平台 ${process.platform}）`)
    skipped++
    continue
  }
  console.log(`\n=== ${name}: ${script}`)
  try {
    execFileSync(script, { cwd: dir, stdio: 'inherit', shell: true })
    ran++
  } catch (e) {
    console.error(`✗ ${name} 打包失败：${e.message}`)
    failed++
  }
}

console.log(`\n发布完成：执行 ${ran}，跳过 ${skipped}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
