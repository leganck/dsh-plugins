// 测试入口：递归 import test/**/*.test.mjs，让 node:test 自行收集用例。
// 不用 `node --test test/`：Node 26 对目录参数的行为与 Node 24 不同；
// 用显式 import 与运行时版本解耦。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const testDir = path.join(root, 'test')

function collect(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collect(full))
    } else if (entry.name.endsWith('.test.mjs')) {
      out.push(full)
    }
  }
  return out
}

const files = collect(testDir).sort()
if (!files.length) {
  console.error('test/ 下没有找到 *.test.mjs')
  process.exit(1)
}
for (const file of files) {
  await import(pathToFileURL(file).href)
}
