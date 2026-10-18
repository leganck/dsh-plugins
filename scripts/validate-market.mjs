/**
 * 用 DSH 官方的校验器验证 `market/index.json`（format 1）。
 *
 * 为什么单独一个脚本：校验器 `@deepseek-ai/dsh-plugin-market-index` 是**可选依赖**
 * （仓库不 vendor 它，避免给不需要的人下载），CI 里显式装一次再跑本脚本。
 *
 * 用法：
 *   node scripts/validate-market.mjs
 *   node scripts/validate-market.mjs --url https://example.com/market/index.json
 *
 * 退出码：0 = 通过；1 = 校验失败；2 = 缺校验器（本地跳过，不当失败）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null
// 索引 URL 决定图标相对路径的解析基准，必须是**真实发布地址**
const INDEX_URL = urlArg ?? 'https://raw.githubusercontent.com/leganck/dsh-plugins/main/market/index.json'

let validator
try {
  validator = await import('@deepseek-ai/dsh-plugin-market-index')
} catch {
  console.error('· 未安装 @deepseek-ai/dsh-plugin-market-index，跳过 format 1 校验')
  console.error('  安装：npm i --no-save @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2')
  process.exit(2)
}

const indexPath = path.join(ROOT, 'market', 'index.json')
if (!fs.existsSync(indexPath)) {
  console.error(`✗ 找不到 ${indexPath}`)
  process.exit(1)
}

try {
  const index = validator.parseMarketIndex(JSON.parse(fs.readFileSync(indexPath, 'utf8')), INDEX_URL)
  console.log(`✅ format 1 校验通过：${index.plugins.length} 个插件，基准 URL ${INDEX_URL}`)
  for (const plugin of index.plugins) {
    const version = plugin.versions[0]
    const target = validator.marketInstallTarget(plugin.name, version)
    console.log(`   ${plugin.name}@${version.version}`)
    console.log(`     install: ${target.spec}${target.registry ? `（registry ${target.registry}）` : ''}`)
    if (plugin.icon) console.log(`     icon:    ${plugin.icon}`)
  }
} catch (e) {
  if (e?.name === 'MarketIndexError') {
    console.error(`✗ format 1 校验失败：${e.path} ${e.reason}`)
  } else {
    console.error(`✗ 校验异常：${e?.stack ?? e}`)
  }
  process.exit(1)
}
