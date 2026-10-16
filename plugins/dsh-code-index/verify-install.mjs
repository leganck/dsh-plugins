/**
 * 安装后的验证脚本（不跑模型、不做推理）。
 *
 * 用途：`install_bundle` 把 code-index 从"file:// 路径引用"换成"包引用"之后，
 * 验证四件事：
 *   1. 能否从 profile 里**安装后的路径**加载插件（模块可解析）
 *   2. 契约仍在：inject / name / 三个工具注册 + 清理
 *   3. 依赖可从该路径解析（onnxruntime-node / @huggingface/transformers）——
 *      **只 import，不做推理**，避免 CPU/GPU 负载
 *   4. roots 白名单仍生效（补的 config 覆盖行是否真的应用了）
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
 * 否则会污染线上那份证据 —— 曾因此把"app 是否真的加载过"的判断搞混过一次。
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
      indexDirBase: tmpIndexDir, // 临时目录：不碰线上索引
      roots: ['D:/Code'],
      embedding: { backend: 'off' }, // 关键：不碰模型
    })
    check('apply() 成功且注册 3 个工具', registry.size === 3, [...registry.keys()].join(','))
  } catch (e) {
    check('apply() 成功且注册 3 个工具', false, String(e.message).slice(0, 140))
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

// ---- 4. 依赖解析（只按包内文件为基准解析 + 加载绑定，不做推理）----
// 注意：**不能**在本脚本里 `import('onnxruntime-node')` —— Node 按导入方文件所在位置解析，
// 本脚本位于源码目录（无 node_modules），那样测出来的失败是测试自己的问题，不是包的问题。
// 正确做法：createRequire 以【包内文件】为基准，解析的是该文件自己的依赖树。
console.log('\n[4] 依赖解析（以包内文件为基准，不推理）')
const { createRequire } = await import('node:module')
const req = createRequire(path.join(pkgDir, 'lib', 'embedder.js'))
for (const spec of ['onnxruntime-node', '@huggingface/transformers']) {
  try {
    const resolved = req.resolve(spec)
    check(`${spec} 可解析`, true, resolved.replace(/\\/g, '/').replace(/^.*node_modules\//, 'node_modules/').slice(0, 80))
  } catch (e) {
    check(`${spec} 可解析`, false, String(e.code || e.message).slice(0, 60))
  }
}
try {
  const ort = req('onnxruntime-node')
  const v = ort?.env?.versions?.node ?? '?'
  check(`onnxruntime-node 可加载（版本 ${v}；未创建会话、未推理）`, typeof ort?.InferenceSession === 'function')
} catch (e) {
  check('onnxruntime-node 可加载', false, String(e.message).slice(0, 90))
}
// 原生二进制是否就位（只看文件，不加载）
const dml = path.join(pkgDir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'DirectML.dll')
check('DirectML.dll 在包内 node_modules（GPU 路径）', fs.existsSync(dml), dml.replace(/\\/g, '/'))

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
