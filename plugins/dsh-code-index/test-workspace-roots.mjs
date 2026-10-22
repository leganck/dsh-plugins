/**
 * workspace roots 自动推导自测：无 roots 配置，从 workspace/cwd/.dshworkspace.json 推导。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveAllowedRoots,
  isInsideRoots,
  findWorkspaceDefinition,
  normalizeWorkspaceDefinition,
} from './lib/workspace-roots.js'

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

console.log('\n[1] 无定义文件：workspace + cwd')
const base = resolveAllowedRoots({ workspaceRoot: workspace, sessionCwd: repo })
check('包含 workspace root', base.roots.includes(path.resolve(workspace)), JSON.stringify(base.roots))
check('包含 session cwd', base.roots.includes(path.resolve(repo)), JSON.stringify(base.roots))
check('仓库内通过', isInsideRoots(repo, base.roots))
check('workspace 外拒绝', !isInsideRoots(outside, base.roots))
check('前缀相似目录不误匹配', !isInsideRoots(prefixTrap, base.roots))
check('无定义文件 source 为 workspace/cwd', base.sources.includes('workspace') && base.sources.includes('cwd'), JSON.stringify(base.sources))

console.log('\n[2] .dshworkspace.json 多根')
const def = path.join(workspace, '.dshworkspace.json')
fs.writeFileSync(def, JSON.stringify({ version: 1, roots: [{ id: 'main', path: 'repo' }, { id: 'other', path: other }], primary: 'main' }))
const multi = resolveAllowedRoots({ workspaceRoot: workspace, sessionCwd: repo })
check('找到定义文件', multi.definitionFile === def, String(multi.definitionFile))
check('多根包含 repo', isInsideRoots(repo, multi.roots))
check('多根包含 other', isInsideRoots(other, multi.roots))
check('多根 source 标记', multi.sources.includes('multiroot'), JSON.stringify(multi.sources))
check('findWorkspaceDefinition 找到', findWorkspaceDefinition(repo) === def)

console.log('\n[3] 损坏定义文件回退')
fs.writeFileSync(def, '{not json')
const broken = resolveAllowedRoots({ workspaceRoot: workspace, sessionCwd: repo })
check('损坏文件仍保留 workspace 边界', isInsideRoots(repo, broken.roots))
check('损坏文件不放开 outside', !isInsideRoots(outside, broken.roots))
check('损坏文件产生 warning', broken.warnings.length > 0, JSON.stringify(broken.warnings))

console.log('\n[4] 相对路径与非法定义')
fs.writeFileSync(def, JSON.stringify({ roots: [{ id: 'a', path: 'repo' }] }))
const rel = normalizeWorkspaceDefinition(JSON.parse(fs.readFileSync(def, 'utf8')), { baseDir: workspace, file: def })
check('相对路径按定义文件目录解析', rel.roots[0] === path.resolve(repo), rel.roots[0])
let threw = false
try {
  normalizeWorkspaceDefinition({ roots: [] }, { baseDir: workspace })
} catch {
  threw = true
}
check('空 roots 拒绝', threw)
let threw2 = false
try {
  normalizeWorkspaceDefinition({ roots: [{ id: 'x', path: 'missing' }] }, { baseDir: workspace })
} catch {
  threw2 = true
}
check('不存在目录拒绝', threw2)

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
