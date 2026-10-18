/**
 * 自测：根注册表的发现/校验/规范化，以及 `workspace_roots` 工具的真实调用。
 *
 * 设计文档要求"配置类错误大声失败并点名"，所以这里大量断言 **错误信息里带字段路径**，
 * 而不只是"抛了错"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findDefinition, normalizeDefinition, resolveRoots, RegistryError, DEFINITION_NAME } from './lib/registry.js'
import { apply } from './index.js'

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? `  — ${extra}` : ''}`)
  }
}
const throwsWith = (fn, re) => {
  try {
    fn()
    return null
  } catch (e) {
    return re.test(e.message) ? e : null
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multiroot-test-'))
const anchor = path.join(tmp, 'anchor')
const nested = path.join(anchor, 'packages', 'app')
const rootA = path.join(tmp, 'repo-a')
const rootB = path.join(tmp, 'repo-b')
for (const d of [nested, rootA, rootB]) fs.mkdirSync(d, { recursive: true })

console.log('\n[1] 发现定义文件')
fs.writeFileSync(
  path.join(anchor, DEFINITION_NAME),
  JSON.stringify({ version: 1, primary: 'app', roots: [{ id: 'app', path: '.' }, { id: 'a', path: rootA }] }),
)
check('从嵌套目录向上找到锚点的定义文件', findDefinition(nested) === path.join(anchor, DEFINITION_NAME))
check('找不到时返回 null', findDefinition(rootB) === null)
check('maxUpLevels=0 只查自身', findDefinition(nested, 0) === null)

console.log('\n[2] 规范化与校验（错误必须点名字段）')
const good = normalizeDefinition({ version: 1, roots: [{ id: 'app', path: '.' }, { id: 'a', path: rootA, readonly: true }] }, {
  baseDir: anchor,
})
check('相对路径按定义文件目录解析', good.roots[0].path === anchor)
check('绝对路径原样保留且规范化', good.roots[1].path === path.normalize(rootA))
check('缺省 primary = 第一个根', good.primary === 'app')
check('readonly 透传', good.roots[1].readonly === true)
check('不认识的 version → 报错', !!throwsWith(() => normalizeDefinition({ version: 2, roots: [{ id: 'a', path: '.' }] }, { baseDir: anchor }), /version/))
check('非法 id → 点名 roots[0].id', !!throwsWith(() => normalizeDefinition({ roots: [{ id: '-bad', path: '.' }] }, { baseDir: anchor }), /roots\[0\]\.id/))
check('重复 id → 报错', !!throwsWith(() => normalizeDefinition({ roots: [{ id: 'a', path: '.' }, { id: 'a', path: '.' }] }, { baseDir: anchor }), /重复/))
check('路径不存在 → 点名 roots[0].path', !!throwsWith(() => normalizeDefinition({ roots: [{ id: 'a', path: './nope' }] }, { baseDir: anchor }), /roots\[0\]\.path/))
check('primary 不是已声明的 id → 报错', !!throwsWith(() => normalizeDefinition({ primary: 'zzz', roots: [{ id: 'a', path: '.' }] }, { baseDir: anchor }), /primary/))
check('readonly 非布尔 → 报错', !!throwsWith(() => normalizeDefinition({ roots: [{ id: 'a', path: '.', readonly: 'yes' }] }, { baseDir: anchor }), /readonly/))

console.log('\n[3] 解析优先级')
const fromFile = resolveRoots({ cwd: nested, config: {} })
check('文件优先（source=file）', fromFile.source === 'file' && fromFile.roots.length === 2, fromFile.source)
check('主根为 app', fromFile.primary === 'app')
const fromCfg = resolveRoots({ cwd: rootB, config: { roots: [{ id: 'x', path: rootA }, { id: 'y', path: rootB }], primary: 'y' } })
check('没有定义文件时用内联 roots', fromCfg.source === 'config' && fromCfg.primary === 'y')
const fallback = resolveRoots({ cwd: rootB, config: {} })
check('都没有 → 单根退化', fallback.source === 'fallback' && fallback.roots.length === 1 && fallback.roots[0].path === rootB)
const explicit = resolveRoots({ cwd: rootB, config: { definitionFile: path.join(anchor, DEFINITION_NAME) } })
check('显式 definitionFile 生效', explicit.source === 'file' && explicit.definitionFile === path.join(anchor, DEFINITION_NAME))
check('显式 definitionFile 不存在 → 报错', !!throwsWith(() => resolveRoots({ cwd: rootB, config: { definitionFile: path.join(tmp, 'nope.json') } }), /definitionFile/))

console.log('\n[4] 插件装载与工具调用')
const registry = new Map()
const ctx = {
  tools: { register: (def) => { registry.set(def.name, def); return () => registry.delete(def.name) } },
  logger: { info() {}, warn() {} },
  effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
}
apply(ctx, {})
check('注册了 workspace_roots', registry.has('workspace_roots'), [...registry.keys()].join(','))
const tool = registry.get('workspace_roots')
const r1 = await tool.execute({}, { cwd: nested })
const text1 = r1.content[0].text
check('多根：文本里出现两个根 id', /app/.test(text1) && /\ba\b/.test(text1), text1.split('\n')[0])
check('多根：报出主根', /主根 app/.test(text1))
const r2 = await tool.execute({}, { cwd: rootB })
check('单根退化：提示放定义文件', /单根退化/.test(r2.content[0].text) && /dshworkspace\.json/.test(r2.content[0].text))
const badCtx = {
  tools: { register: (def) => registry.set(def.name, def), logger: { info() {}, warn() {} }, effect: () => () => {} },
}
apply(badCtx, { roots: [{ id: 'ok', path: rootA }, { id: 'bad id!', path: rootB }] })
const r3 = await registry.get('workspace_roots').execute({}, { cwd: rootB })
check('配置错误时工具报错并点名字段', /roots\[1\]\.id/.test(r3.content[0].text), r3.content[0].text.slice(0, 80))
check('未知配置项 → 装载即报错', !!throwsWith(() => apply(badCtx, { bogus: 1 }), /未知配置项/))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
