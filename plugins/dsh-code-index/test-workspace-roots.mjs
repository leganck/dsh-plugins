/**
 * workspace roots 自测：只从 workspaceRoot + 会话 cwd 推导。
 * 多根工作区（`.dshworkspace.json`）已下线，不再支持。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveAllowedRoots, isInsideRoots } from './lib/workspace-roots.js'

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-workspace-'))
const workspace = path.join(tmp, 'workspace')
const repo = path.join(workspace, 'repo')
const other = path.join(tmp, 'other-repo')
const outside = path.join(tmp, 'outside')
fs.mkdirSync(repo, { recursive: true })
fs.mkdirSync(other, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
const prefixTrap = path.join(tmp, 'workspace2')
fs.mkdirSync(prefixTrap, { recursive: true })

console.log('\n[1] workspace + cwd')
const base = resolveAllowedRoots({ workspaceRoot: workspace, sessionCwd: repo })
check('包含 workspace root', base.roots.includes(path.resolve(workspace)), JSON.stringify(base.roots))
check('包含 session cwd', base.roots.includes(path.resolve(repo)), JSON.stringify(base.roots))
check('仓库内通过', isInsideRoots(repo, base.roots))
check('workspace 外拒绝', !isInsideRoots(outside, base.roots))
check('前缀相似目录不误匹配', !isInsideRoots(prefixTrap, base.roots))
check('source 为 workspace/cwd', base.sources.includes('workspace') && base.sources.includes('cwd'), JSON.stringify(base.sources))

console.log('\n[2] 多根定义已下线：即使目录里有 .dshworkspace.json 也不生效')
const def = path.join(workspace, '.dshworkspace.json')
fs.writeFileSync(def, JSON.stringify({ version: 1, roots: [{ path: other }] }))
const multi = resolveAllowedRoots({ workspaceRoot: workspace, sessionCwd: repo })
check('不再产生 definitionFile', multi.definitionFile === null, String(multi.definitionFile))
check('不再包含 multiroot source', !multi.sources.includes('multiroot'), JSON.stringify(multi.sources))
check('定义文件里的 other 不被放行', !isInsideRoots(other, multi.roots))
check('workspace 边界仍有效', isInsideRoots(repo, multi.roots))

console.log('\n[3] 只有 cwd 时不会放开任意路径')
const cwdOnly = resolveAllowedRoots({ workspaceRoot: null, sessionCwd: repo })
check('roots 只含 cwd', cwdOnly.roots.length === 1 && cwdOnly.roots[0] === path.resolve(repo), JSON.stringify(cwdOnly.roots))
check('外部仍拒绝', !isInsideRoots(outside, cwdOnly.roots))
check('没有回退到 process.cwd', !cwdOnly.roots.includes(path.resolve(process.cwd())) || path.resolve(process.cwd()) === path.resolve(repo))

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
