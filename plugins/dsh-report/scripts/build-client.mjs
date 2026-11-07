/**
 * 客户端构建脚本：把 client-src/*.js 按文件名排序拼成 lib/client.js。
 *
 * - 00-header.js 打开 `window.__ModuleLoader__.load({ id, factory(require){...} })`
 * - 99-apply.js 关闭 wrapper
 * - 中间文件共享同一个 factory 作用域（可直接互相引用函数/常量）
 *
 * 用法：node scripts/build-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const srcDir = path.join(root, 'client-src')
const outFile = path.join(root, 'lib', 'client.js')

const files = fs
  .readdirSync(srcDir)
  .filter((name) => name.endsWith('.js'))
  .sort()

if (!files.length) {
  console.error('client-src 目录为空')
  process.exit(1)
}

const parts = []
parts.push(`/* 由 scripts/build-client.mjs 生成，勿手改；源文件在 client-src/ */`)
for (const name of files) {
  const text = fs.readFileSync(path.join(srcDir, name), 'utf8')
  parts.push(`\n/* ==== client-src/${name} ==== */\n${text.trimEnd()}\n`)
}

const output = parts.join('\n')
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, output)
console.log(`built ${outFile} (${output.length} bytes, ${files.length} files)`)
