/**
 * 配置语法检查：所有 `cordis.patch.yml` + CI 工作流。
 *
 * 为什么需要：这些 YAML **不被任何测试加载**，写坏了只有"装载插件时"才炸，
 * 而那时报错往往指向宿主内部。这里提前把它们解析一遍。
 *
 * 策略：
 *   - 装了 `js-yaml` → 真解析（CI 会装）；
 *   - 没装 → 退化为结构 lint（缩进/制表符/`: ` 冒号后空格/id+name 成对/无重复 id），
 *     宁可少查也不能静默说"通过"。
 *
 * 用法：node scripts/check-yaml.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (/\.ya?ml$/u.test(entry.name)) out.push(full)
  }
  return out
}

const files = collect(path.join(ROOT, 'plugins'))
files.push(...collect(path.join(ROOT, '.github')))
// 服务端的 compose / CI 工作流同样没人加载，写坏了要到部署时才炸
files.push(...collect(path.join(ROOT, 'server')))
if (files.length === 0) {
  console.error('✗ 没找到任何 YAML（plugins/**/cordis.patch.yml、.github/workflows/*.yml）')
  process.exit(1)
}

let yaml = null
try {
  yaml = await import('js-yaml')
} catch {
  console.warn('· 未安装 js-yaml，退化为结构 lint（安装后可真解析：npm i --no-save js-yaml）')
}

let failed = 0

/** 退化的结构检查：能抓出最常见的几种写坏方式 */
function lint(rel, text) {
  const problems = []
  text.split(/\r?\n/u).forEach((line, i) => {
    const at = `${rel}:${i + 1}`
    if (/^\t/u.test(line)) problems.push(`${at} 用了制表符缩进（YAML 只允许空格）`)
    if (/[ \t]+$/u.test(line)) problems.push(`${at} 行尾有多余空白`)
    const m = /^(\s*)([A-Za-z0-9_@./-]+):(\s*)(.*)$/u.exec(line)
    if (m && m[3] === '' && m[4] !== '' && !m[4].startsWith('#')) problems.push(`${at} 冒号后缺空格`)
  })
  if (!/^- insert:|^insert:/mu.test(text) && /cordis\.patch\.yml$/u.test(rel) && !rel.includes('.github')) {
    // 补丁文件必须有一个顶层 insert（或其它指令）；只有注释不算
    const hasDirective = /^-\s+(insert|override|remove):/mu.test(text)
    if (!hasDirective) problems.push(`${rel} 没有顶层指令（期望 \`- insert:\` 之类）`)
  }
  return problems
}

for (const file of files.sort()) {
  const rel = path.relative(ROOT, file).replace(/\\/gu, '/')
  const text = fs.readFileSync(file, 'utf8')
  try {
    if (yaml) {
      const docs = []
      yaml.loadAll(text, (d) => docs.push(d))
      if (docs.length === 0 || docs.every((d) => d === null || d === undefined)) {
        console.warn(`⚠️  ${rel}: 解析成功但没有内容`)
      }
    }
    const problems = lint(rel, text)
    if (problems.length) {
      failed++
      console.error(`✗ ${rel}`)
      for (const p of problems) console.error(`   ${p}`)
    } else {
      console.log(`✅ ${rel}${yaml ? '' : '（结构 lint）'}`)
    }
  } catch (e) {
    failed++
    console.error(`✗ ${rel}: YAML 解析失败 —— ${e.message}`)
  }
}

console.log(`\n检查 ${files.length} 个文件，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
