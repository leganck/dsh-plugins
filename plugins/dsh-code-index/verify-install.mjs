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
check('含 tools/fetch-model.mjs（模型下载器）', fs.existsSync(path.join(pkgDir, 'tools', 'fetch-model.mjs')))
check('含 tools/migrate-embedding-tag.mjs（缓存 key 迁移）', fs.existsSync(path.join(pkgDir, 'tools', 'migrate-embedding-tag.mjs')))
{
  // 工具脚本要能真的被加载（打包漏文件时这里立刻暴露），且清单里两个模型都在
  const toolUrl = 'file:///' + pkgDir.replace(/\\/g, '/') + '/tools/fetch-model.mjs'
  try {
    const t = await import(toolUrl)
    const names = Object.keys(t.MODELS ?? {})
    check('fetch-model 可加载且清单完整', names.includes('bge-small-zh-v1.5') && names.includes('bge-reranker-base'), names.join(','))
    check(
      'fetch-model 的每个文件都配了体积下限（防"0 字节当成功"）',
      Object.values(t.MODELS).every((m) => Object.values(m.onnx).every((f) => Number(m.minBytes?.[f]) > 0)),
    )
  } catch (e) {
    check('fetch-model 可加载且清单完整', false, String(e.message).slice(0, 100))
    check('fetch-model 的每个文件都配了体积下限（防"0 字节当成功"）', false, '未加载')
  }
}

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
    check('apply() 成功且注册 4 个工具', registry.size === 4, [...registry.keys()].join(','))
  } catch (e) {
    check('apply() 成功且注册 4 个工具', false, String(e.message).slice(0, 140))
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

// ---- 4. 嵌入依赖（按需安装在受管目录；不在包内，也不该在包内）----
//
// 两条必须守住的边界：
//   ① 装插件**不该**带来任何重依赖（包里不该再出现 onnxruntime-node）
//   ② 依赖的解析要落在**受管目录**上（%LOCALAPPDATA%/dsh-code-index/embed-deps），
//      用 createRequire 以该目录的 package.json 为锚点——不能靠 ESM 裸标识符解析
//      （那是以导入方文件为基准的，装到别处就找不到）
console.log('\n[4] 嵌入依赖：按需安装在受管目录')
const depsMod = await import('file:///' + pkgDir.replace(/\\/g, '/') + '/lib/deps.js')
const dstat = depsMod.depsStatus({ depsDir: depsMod.defaultDepsDir(), alsoDirs: [pkgDir] })
console.log(`  受管目录：${dstat.dir}`)
console.log(`  体积 ${(dstat.sizeBytes / 1048576).toFixed(1)} MB；${dstat.installed ? '已就绪' : `缺 ${dstat.missing.join(', ')}`}`)

const pkgLocal = path.join(pkgDir, 'node_modules', 'onnxruntime-node')
check('包里**没有**再捆 onnxruntime-node（装插件不该带 287 MB）', !fs.existsSync(pkgLocal), pkgLocal)
check('安装未执行依赖脚本（无构建产物残留）', !fs.existsSync(path.join(pkgDir, 'node_modules', 'onnxruntime-node', 'build')))

if (dstat.installed) {
  for (const spec of ['onnxruntime-node', '@huggingface/transformers']) {
    const req = (await import('node:module')).createRequire(path.join(dstat.dir, 'package.json'))
    try {
      const resolved = req.resolve(spec)
      check(`${spec} 从受管目录可解析`, true, resolved.replace(/\\/g, '/').replace(/^.*node_modules\//, 'node_modules/').slice(0, 70))
    } catch (e) {
      check(`${spec} 从受管目录可解析`, false, String(e.code || e.message).slice(0, 70))
    }
  }
  try {
    const req = (await import('node:module')).createRequire(path.join(dstat.dir, 'package.json'))
    const ort = req('onnxruntime-node')
    const v = ort?.env?.versions?.node ?? '?'
    check(`onnxruntime-node 可加载（版本 ${v}；未创建会话、未推理）`, typeof ort?.InferenceSession === 'function')
  } catch (e) {
    check('onnxruntime-node 可加载', false, String(e.message).slice(0, 90))
  }
  const dml = path.join(dstat.dir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'DirectML.dll')
  check('DirectML.dll 在受管目录（GPU 路径）', fs.existsSync(dml), dml.replace(/\\/g, '/'))
} else {
  console.log('  （未按需安装 → 跳过解析检查；这是**正常状态**，插件此时走纯 FTS5 降级）')
  const emb = await (await import('file:///' + pkgDir.replace(/\\/g, '/') + '/lib/embedder.js')).createEmbedder({
    depsDir: dstat.dir,
    backend: 'cpu',
    log: () => {},
  })
  check('缺依赖时嵌入器如实降级且指出下一步', emb.ok === false && /code_index_deps/.test(String(emb.reason)), String(emb.reason).slice(0, 110))
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
