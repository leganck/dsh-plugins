/**
 * 分支/根目录探测自测：detached HEAD（rebase 等）不能把 short sha 当分支名。
 *
 * 为什么值得单独测：作用域现在是**永久**的，`#branch:<sha8>` 这种一次性作用域会一直
 * 堆在控制台列表里（2026-11-05 实际出现过两条 `#branch:c2e3de7` 垃圾作用域）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitBranch, gitToplevel } from './lib/repo.js'

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

const git = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-branch-'))
const repo = path.join(tmp, 'repo')
fs.mkdirSync(repo, { recursive: true })
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
git(repo, ['init', '-q', '-b', 'main'])
git(repo, ['config', 'user.email', 't@t'])
git(repo, ['config', 'user.name', 't'])
git(repo, ['add', '.'])
git(repo, ['commit', '-q', '-m', 'first'])

console.log('\n[1] 正常分支')
const b1 = gitBranch(repo)
check('分支名是 main', b1.name === 'main', JSON.stringify(b1))
check('detached=false', b1.detached === false, JSON.stringify(b1))

console.log('\n[2] detached HEAD，但 main 指向 HEAD（rebase 期间的真实形态）')
const sha = git(repo, ['rev-parse', 'HEAD'])
git(repo, ['checkout', '-q', '--detach', sha])
const b2 = gitBranch(repo)
check('detached=true', b2.detached === true, JSON.stringify(b2))
check('不会把 sha 当分支名', b2.name !== sha.slice(0, 7) && b2.name !== sha, JSON.stringify(b2))
check('解析回 main', b2.name === 'main', JSON.stringify(b2))

console.log('\n[3] detached 且没有任何分支指向 HEAD')
fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
git(repo, ['add', '.'])
git(repo, ['commit', '-q', '-m', 'second'])
const sha2 = git(repo, ['rev-parse', 'HEAD'])
git(repo, ['checkout', '-q', '--detach', sha2])
const b3 = gitBranch(repo)
check('detached=true', b3.detached === true, JSON.stringify(b3))
check('未知分支返回空名（交给 autoScope 回退 main）', b3.name === '', JSON.stringify(b3))

console.log('\n[4] 子目录识别')
const sub = path.join(repo, 'pkg', 'mod')
fs.mkdirSync(sub, { recursive: true })
check('gitToplevel 返回仓库根', path.resolve(gitToplevel(sub)) === path.resolve(repo), gitToplevel(sub))
check('非 git 目录返回空', gitToplevel(tmp) === '', gitToplevel(tmp))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
