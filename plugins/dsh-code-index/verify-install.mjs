/**
 * 安装后的验证脚本（不跑模型、不做推理）。
 *
 * 用途：`install_bundle` 把 code-index 从"file:// 路径引用"换成"包引用"之后，
 * 验证三件事：
 *   1. 能否从 profile 里**安装后的路径**加载插件（模块可解析）
 *   2. 契约仍在：inject / name / 五个工具注册 + 清理
 *   3. roots 白名单仍生效（补的 config 覆盖行是否真的应用了）
 *
 * 0.10.0 remote-only：本地嵌入/重排已移除，这里不再检查 onnxruntime / 模型文件；
 * parser 依赖是可选增强，只报告状态。
 *
 * 用法：node verify-install.mjs [--pkg <安装后的包目录>]
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}

const pkgDir =
  arg('--pkg') ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@local', 'dsh-code-index')

/**
 * 隔离运行环境：本脚本会调用 apply()，而插件在 apply() 里会写加载记录（`_boot.log`）
 * 与加载标记（`_loaded.json`）。**必须**把 DSH_HOME 与索引目录都指到临时目录，
 * 否则会污染线上那份证据。
 */
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-home-'))
const tmpIndexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-idx-'))

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? '  — ' + extra : ''}`)
  }
}

console.log(`包目录: ${pkgDir}\n`)
check('安装后的包目录存在', fs.existsSync(pkgDir))
if (!fs.existsSync(pkgDir)) {
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(1)
}
check('含 index.js', fs.existsSync(path.join(pkgDir, 'index.js')))
check('含 cordis.patch.yml（bundle 必备）', fs.existsSync(path.join(pkgDir, 'cordis.patch.yml')))
check('含 lib/ 与 locale/ 与 icon', fs.existsSync(path.join(pkgDir, 'lib')) && fs.existsSync(path.join(pkgDir, 'locale')))
check('不再包含本地模型下载/打包脚本', !fs.existsSync(path.join(pkgDir, 'tools', 'fetch-model.mjs')) && !fs.existsSync(path.join(pkgDir, 'tools', 'pack-model.mjs')))
check('不再包含 lib/embedder.js（本地模型已移除）', !fs.existsSync(path.join(pkgDir, 'lib', 'embedder.js')))

// ---- 1. 模块可加载 ----
console.log('\n[1] 模块加载（真实宿主运行时路径）')
const url = 'file:///' + pkgDir.replace(/\\/g, '/') + '/index.js'
let mod = null
try {
  mod = await import(url)
  check('import 成功', true)
} catch (e) {
  check('import 成功', false, String(e.message).slice(0, 120))
}
if (mod) {
  check('导出 name', mod.name === 'code-index', String(mod.name))
  check('导出 inject 含 tools', mod.inject?.includes('tools') === true, JSON.stringify(mod.inject))
  check('BUILD 已更新', typeof mod.BUILD === 'string', String(mod.BUILD))
}

// ---- 2. 忠实 cordis 夹具：注册与清理 ----
console.log('\n[2] 工具注册与卸载')
const registry = new Map()
const effects = []
const SERVICES = ['tools']
const BUILTINS = ['logger', 'effect', 'on', 'inject']
function makeCtx(injectList) {
  const declared = new Set(injectList ?? [])
  const impl = {
    tools: {
      register(d) {
        if (registry.has(d.name)) throw new Error(`already registered: ${d.name}`)
        registry.set(d.name, d)
        return () => registry.delete(d.name)
      },
    },
    effect(cb) {
      const dispose = cb()
      effects.push(dispose)
      return () => {}
    },
  }
  return new Proxy(impl, {
    get(t, p) {
      if (typeof p === 'string' && BUILTINS.includes(p)) {
        return p === 'logger' ? { info() {}, warn() {} } : t[p]
      }
      if (typeof p === 'string' && SERVICES.includes(p) && !declared.has(p)) {
        throw new Error(`cannot get property "${p}" without inject`)
      }
      return t[p]
    },
  })
}
if (mod) {
  try {
    mod.apply(makeCtx(mod.inject), {
      roots: ['D:/Code'],
      vectors: 'off', // 纯关键词：不连远端、也不需要任何模型
      advanced: { indexDirBase: tmpIndexDir }, // 临时目录：不碰线上索引
    })
    const expected = ['code_index', 'code_search', 'code_map', 'code_index_status', 'code_index_deps']
    const missing = expected.filter((name) => !registry.has(name))
    check('apply() 成功且注册 5 个工具', registry.size === expected.length && missing.length === 0, missing.length ? `缺少 ${missing.join(',')}` : [...registry.keys()].join(','))
  } catch (e) {
    check('apply() 成功且注册 5 个工具', false, String(e.message).slice(0, 140))
  }

  // ---- 3. roots 白名单（验证 config 覆盖行是否应用）----
  console.log('\n[3] roots 白名单（验证 profile 里补的 config 覆盖行生效）')
  const status = registry.get('code_index_status')
  if (status) {
    const outside = await status.execute({ path: 'C:/Users/you', scan: false }, {})
    const inside = await status.execute({ path: 'D:/Code/your-repo', scan: false }, {})
    const outText = outside.content[0].text
    const inText = inside.content[0].text
    check('白名单外的路径被拒', /白名单/.test(outText), outText.split('\n')[0].slice(0, 90))
    check('白名单内的路径通过', !/错误/.test(inText), inText.split('\n')[0].slice(0, 90))
  } else {
    check('拿到 code_index_status', false, '未注册')
  }

  for (const d of effects) if (typeof d === 'function') d()
  check('卸载后注册归零', registry.size === 0, `剩余 ${registry.size}`)
}

// ---- 4. parser 依赖（可选增强，只报告状态）----
console.log('\n[4] 语法解析依赖（可选，仅报告）')
const depsMod = await import('file:///' + pkgDir.replace(/\\/g, '/') + '/lib/deps.js')
const dstat = depsMod.depsStatus({ depsDir: depsMod.defaultDepsDir(), alsoDirs: [pkgDir] })
console.log(`  受管目录：${dstat.dir}`)
console.log(`  体积 ${(dstat.sizeBytes / 1048576).toFixed(1)} MB；${dstat.installed ? '已就绪' : `缺 ${dstat.missing.join(', ') || '未安装'}`}`)
check('依赖组只剩 parser 系（embed 组已移除）', Object.keys(depsMod.DEP_GROUPS).every((g) => g.startsWith('parser')), Object.keys(depsMod.DEP_GROUPS).join(','))
check('包里没有捆 onnxruntime-node', !fs.existsSync(path.join(pkgDir, 'node_modules', 'onnxruntime-node')))

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
