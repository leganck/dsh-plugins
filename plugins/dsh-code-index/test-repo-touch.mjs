/**
 * 触及式仓库识别自测：路径抽取、git 根查找、worktree 归并到主仓。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractPaths, resolveRepoRoot, reposFromPaths, looksLikePath, pathsInText } from './lib/repo-touch.js'

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-touch-'))
const main = path.join(tmp, 'main-repo')
fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt1'), { recursive: true })
fs.mkdirSync(path.join(main, 'src', 'deep'), { recursive: true })
fs.writeFileSync(path.join(main, 'src', 'deep', 'A.java'), 'class A {}')

const wt = path.join(tmp, 'wt-1')
fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt1')}`)
fs.writeFileSync(path.join(wt, 'src', 'B.java'), 'class B {}')

const plain = path.join(tmp, 'plain-dir')
fs.mkdirSync(plain, { recursive: true })

console.log('\n[1] 路径识别')
check('盘符路径', looksLikePath('D:\\Code\\x'))
check('斜杠路径', looksLikePath('D:/Code/x'))
check('UNC 路径', looksLikePath('\\\\server\\share\\x'))
check('相对路径不算', !looksLikePath('src/main.js'))
check('命令里抠路径', pathsInText('git -C "D:/Code/x" status').length === 1, JSON.stringify(pathsInText('git -C "D:/Code/x" status')))

console.log('\n[2] 从工具参数抽路径')
const args = {
  path: 'D:/Code/a',
  cwd: 'D:\\Code\\b',
  command: 'cd /d/Code/c && ls',
  nested: { file_path: 'D:/Code/d/src/X.java' },
  count: 3,
}
const found = extractPaths(args)
check('抽出 path/cwd', found.includes('D:/Code/a') && found.includes('D:\\Code\\b'), JSON.stringify(found))
check('抽出 file_path', found.some((p) => p.includes('D:/Code/d')), JSON.stringify(found))

console.log('\n[3] git 根查找')
const cache = new Map()
const nested = resolveRepoRoot(path.join(main, 'src', 'deep', 'A.java'), { cache })
check('文件路径 → 仓库根', nested?.root === main, JSON.stringify(nested))
check('普通目录 → null', resolveRepoRoot(plain, { cache }) === null)
const again1 = resolveRepoRoot(path.join(main, 'src'), { cache })
const again2 = resolveRepoRoot(path.join(main, 'src'), { cache })
check('缓存命中（同一目录返回同一对象）', again1 === again2 && again1?.root === main, String(again1?.root))

console.log('\n[4] worktree 归并主仓')
const wtResolved = resolveRepoRoot(path.join(wt, 'src', 'B.java'), { cache })
check('识别为 worktree', wtResolved?.worktree === true, JSON.stringify(wtResolved))
check('归并到主仓根', wtResolved?.root === main, String(wtResolved?.root))
check('保留 checkout 路径', wtResolved?.checkout === wt, String(wtResolved?.checkout))

console.log('\n[5] 批量去重')
const repos = reposFromPaths([path.join(main, 'src'), path.join(wt, 'src')], { cache })
check('同一仓库只出现一次', repos.length === 1, JSON.stringify(repos))

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
