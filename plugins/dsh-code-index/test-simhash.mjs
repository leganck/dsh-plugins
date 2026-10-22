/**
 * simhash 算法自测：确定性、相似/无关距离、两种变体。
 */
import { computeSimhash, hammingHex } from './lib/simhash.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

function files(prefix, count, { salt = '', size = 100 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    path: `${prefix}/f${i}.java`,
    sha: `${salt}sha-${prefix}-${i}`,
    size,
  }))
}

const a = computeSimhash(files('src/a', 50))
const b = computeSimhash(files('src/a', 50))
const changedFiles = files('src/a', 50)
changedFiles[0].sha += '-changed'
changedFiles[1].sha += '-changed'
changedFiles[2].sha += '-changed'
const c = computeSimhash(changedFiles)
const unrelated = computeSimhash(files('other/module', 50, { salt: 'other-' }))
const sameContent = computeSimhash(files('moved/path', 50))

console.log('\n[1] 确定性')
check('相同输入完全一致', JSON.stringify(a) === JSON.stringify(b))
check('path/content 都是 16 hex', /^[0-9a-f]{16}$/.test(a.path) && /^[0-9a-f]{16}$/.test(a.content), JSON.stringify(a))

console.log('\n[2] 距离')
check('完全相同距离 0', hammingHex(a.path, b.path) === 0)
check('少量内容变化距离较小', hammingHex(a.path, c.path) < 24, String(hammingHex(a.path, c.path)))
check('无关仓库距离更大', hammingHex(a.path, unrelated.path) > hammingHex(a.path, c.path), `${hammingHex(a.path, c.path)} vs ${hammingHex(a.path, unrelated.path)}`)
const moved = files('moved/path', 50)
check('content 变体对路径不敏感（同一内容不同路径）', sameContent.content === computeSimhash(moved).content)
check('path 变体对路径敏感', a.path !== sameContent.path)

console.log('\n[3] 边界')
const empty = computeSimhash([])
check('空仓库不崩', empty.files === 0 && /^[0-9a-f]{16}$/.test(empty.path))
const one = computeSimhash([{ path: 'a.java', sha: 'x', size: 1 }])
check('单文件不崩', one.files === 1 && hammingHex(one.path, one.path) === 0)
const malformed = hammingHex('not-hex', one.path)
check('非法 hash 返回最大距离', malformed === 64, String(malformed))

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
