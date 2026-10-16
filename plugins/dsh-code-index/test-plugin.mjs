/**
 * 插件接口层测试：不启动 DSH，用假 ctx 验证 apply() 注册了哪些工具、
 * 参数声明是否正确、三个工具能否真的跑通，以及错误路径是否给出可读信息。
 *
 * 用法：node test-plugin.mjs [--repo <path>] [--no-embed]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from './index.js'
import { walkRepo } from './lib/scan.js'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const repo = arg('--repo') ?? ['D:\\Code\\your-repo', 'D:\\Code\\sample-repo'].find((p) => fs.existsSync(p))
if (!repo || !fs.existsSync(repo)) {
  console.error('找不到可测仓库，请用 --repo 指定')
  process.exit(1)
}
const modelDir = path.join(os.homedir(), '.dsh', 'models', 'bge-small-zh-v1.5')

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? '  — ' + extra : ''}`)
  }
}

/**
 * 忠实模拟 cordis 的 ctx：**只有插件在 `inject` 里声明过的服务才挂得上**，
 * 未声明就访问会抛出与 cordis 同款的错误。
 *
 * 为什么必须这样：2026-10-16 的真实故障是插件缺少 `export const inject = ['tools']`，
 * 在 app 里报 `cannot get property "tools" without inject` 而整行不生效；而此前这个
 * 测试用的是"什么都给"的宽容假 ctx，该类错误 **100% 逃过测试**。假 ctx 越宽容，
 * 测试越没用。
 */
function cordisLikeCtx(mod) {
  const declared = new Set(mod.inject ?? [])
  const registry = new Map()
  const logs = []
  const effects = []
  // 需要 inject 才能访问的服务名（cordis 内建的 logger / effect / on 不在其中）
  const SERVICES = ['tools']
  const BUILTINS = ['logger', 'effect', 'on', 'inject', 'scope', 'isolate']
  const impl = {
    tools: {
      register(def) {
        if (registry.has(def.name)) throw new Error(`already registered: ${def.name}`)
        registry.set(def.name, def)
        return () => registry.delete(def.name)
      },
    },
    // cordis 内建：立即执行回调，把它的返回值当作该 effect 的清理函数
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose, disposed: false })
      return () => {
        const entry = effects.find((e) => e.dispose === dispose)
        if (entry && !entry.disposed) {
          entry.disposed = true
          if (typeof dispose === 'function') dispose()
        }
      }
    },
  }
  const ctx = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === 'string' && BUILTINS.includes(prop)) {
        if (prop === 'logger') {
          return { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) }
        }
        return target[prop]
      }
      // 关键：按【是否声明】判定，而不是按"实现里有没有"——
      // 之前写成 !(prop in target) 导致夹具其实很宽容，测不出缺 inject 的插件
      if (typeof prop === 'string' && SERVICES.includes(prop) && !declared.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return target[prop]
    },
  })
  return { ctx, registry, logs, effects, declared }
}

const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-plugin-'))
// 依赖目录也隔离：测试绝不能碰真实的受管目录（%LOCALAPPDATA%/dsh-code-index/embed-deps）
const testDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-deps-'))
const { ctx, registry, logs, effects, declared } = cordisLikeCtx(plugin)
plugin.apply(ctx, {
  indexDir,
  roots: [repo],
  embedding: process.argv.includes('--no-embed')
    ? { backend: 'off', depsDir: testDepsDir }
    : { backend: 'auto', modelDir, depsDir: testDepsDir },
  maxEmbedPerRun: 400,
})

console.log(`仓库: ${repo}\n索引目录: ${indexDir}\n`)

// ---------- bundle 契约（按 skill cordis-plugin-development）----------
console.log('[0] bundle 契约（cordis-plugin-development）')
const pkgDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
check('manifest 声明 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(pkg.dsh))
check('导出 name', plugin.name === 'code-index', String(plugin.name))
check('导出 inject 含 tools', plugin.inject?.includes('tools') === true, JSON.stringify(plugin.inject))

const patchText = fs.readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8')
check('bundle 补丁插入 id=code-index 的行', /-\s*id:\s*code-index/.test(patchText))
check('补丁的 name 用包名（而非 file:// 路径）', patchText.includes(`name: '${pkg.name}'`), patchText.match(/name:.*/)?.[0] ?? '')

check('exports 暴露 package.json 与 locale', Boolean(pkg.exports?.['./package.json'] && pkg.exports?.['./locale/*.json']))
check('files 白名单含 cordis.patch.yml 与 locale', (pkg.files ?? []).includes('cordis.patch.yml') && (pkg.files ?? []).includes('locale/*.json'))

const zh = JSON.parse(fs.readFileSync(path.join(pkgDir, 'locale/zh.json'), 'utf8'))
const en = JSON.parse(fs.readFileSync(path.join(pkgDir, 'locale/en.json'), 'utf8'))
check('locale/zh.json 与 en.json 均含 meta.title/description', Boolean(zh.meta?.title && zh.meta?.description && en.meta?.title && en.meta?.description))
const icon = fs.statSync(path.join(pkgDir, pkg.icon ?? 'icon.svg'))
check('icon 存在且 ≤ 256 KiB', icon.size > 0 && icon.size <= 256 * 1024, `${icon.size} B`)

// dsh-ops 的硬教训：宿主这一半不能 import 任何 @deepseek-ai/* 值——
// 那些名字由 profile 加载器提供，每多一个就多一条加载期失败的路。
const SOURCE_FILES = ['index.js', ...fs.readdirSync(path.join(pkgDir, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)]
const dshImports = SOURCE_FILES.flatMap((rel) => {
  const text = fs.readFileSync(path.join(pkgDir, rel), 'utf8')
  return [...text.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)].map((m) => `${rel}: ${m[1]}`)
})
check('源码不 import 任何 @deepseek-ai/* 值', dshImports.length === 0, dshImports.join(', '))

check('注册落在 ctx.effect 里', effects.length >= 1, `${effects.length} 个 effect`)
check('effect 带可读标签', effects.every((e) => typeof e.label === 'string' && e.label.startsWith('dsh-code-index')), effects.map((e) => e.label).join(','))

// ---------- 配置校验（fail loud，与 dsh-ops 同策略）----------
console.log('\n[0b] 配置校验')
const cases = [
  ['未知顶层键', { nope: 1 }, /未知配置项/],
  ['未知 embedding 键', { embedding: { nope: 1 } }, /未知配置项/],
  ['非法 backend', { embedding: { backend: 'quantum' } }, /backend/],
  ['负数 maxEmbedPerRun', { maxEmbedPerRun: -1 }, /maxEmbedPerRun/],
  ['非法 roots', { roots: 'D:/Code' }, /roots/],
]
for (const [label, cfg, pattern] of cases) {
  let msg = ''
  try {
    plugin.apply(cordisLikeCtx({ inject: ['tools'] }).ctx, cfg)
  } catch (e) {
    msg = String(e.message)
  }
  check(`拒绝${label}并指明原因`, pattern.test(msg), msg.slice(0, 90))
}
// maxEmbedPerRun = 0 是**默认值**（建库不自动补算向量），必须被接受
let zeroAccepted = true
try {
  plugin.apply(cordisLikeCtx({ inject: ['tools'] }).ctx, { maxEmbedPerRun: 0, embedding: { backend: 'off' } })
} catch {
  zeroAccepted = false
}
check('接受 maxEmbedPerRun = 0（默认不补算向量）', zeroAccepted)

// ---------- 注册面 ----------
console.log('\n[1] 工具注册面')
check('声明了 inject: tools（否则 cordis 上读不到 ctx.tools）', plugin.inject?.includes('tools') === true, JSON.stringify(plugin.inject))
check('测试夹具自身会拒绝未声明的服务访问', (() => {
  try {
    void cordisLikeCtx({}).ctx.tools
    return false
  } catch (e) {
    return /without inject/.test(e.message)
  }
})())
check('未声明 inject 时 apply 会抛错（回归保护）', (() => {
  try {
    plugin.apply(cordisLikeCtx({ inject: [] }).ctx, { indexDir, roots: [repo], embedding: { backend: 'off' } })
    return false
  } catch (e) {
    return /without inject/.test(e.message)
  }
})())
check('注册了 4 个工具', registry.size === 4, [...registry.keys()].join(','))
for (const name of ['code_index', 'code_search', 'code_index_status', 'code_index_deps']) {
  check(`包含 ${name}`, registry.has(name))
}
const search = registry.get('code_search')
const index = registry.get('code_index')
const status = registry.get('code_index_status')
const deps = registry.get('code_index_deps')
check('code_search 声明为并发安全', search?.isConcurrencySafe?.() === true)
check('code_index_status 声明为并发安全', status?.isConcurrencySafe?.() === true)
check('code_index 未声明并发安全（写操作应串行）', index?.isConcurrencySafe === undefined)
check('code_search 的 query 是必填参数', search?.parameters?.required?.includes('query') === true, JSON.stringify(search?.parameters?.required))
check('四个工具都提供了 render', [search, index, status, deps].every((t) => typeof t.output?.render === 'function'))
check('code_index_deps 只允许固定的 action 枚举', JSON.stringify(deps?.parameters?.properties?.action?.enum) === JSON.stringify(['status', 'install', 'prune', 'repair', 'remove']), JSON.stringify(deps?.parameters?.properties?.action?.enum))
check('code_index_deps 描述里说明"不随插件安装"', /不随插件安装/.test(String(deps?.description ?? '')))
check('插件写入了加载日志', logs.some((l) => l.includes('dsh-code-index')), JSON.stringify(logs))

// 依赖工具：默认只**报**状态，绝不擅自下载（下载必须由显式 action 触发）
const depsStatusOut = await deps.execute({}, {})
const depsText = depsStatusOut.content[0].text
check('code_index_deps 默认只报状态', /依赖目录/.test(depsText) && /各组状态/.test(depsText), depsText.split('\n')[0])
check('code_index_deps 列出两个依赖组', /\[embed\]/.test(depsText) && /\[parser\]/.test(depsText))
check('code_index_deps 给出可执行的下一步', /code_index_deps action=install group=/.test(depsText), depsText.split('\n').slice(-1)[0])
check('code_index_deps 默认不动手（没创建 node_modules）', !fs.existsSync(path.join(testDepsDir, 'node_modules')))
check(
  'code_index_deps 的 group 只允许已登记的组',
  JSON.stringify(deps?.parameters?.properties?.group?.enum) === JSON.stringify(['embed', 'parser', 'all']),
  JSON.stringify(deps?.parameters?.properties?.group?.enum),
)
const badGroup = await deps.execute({ action: 'install', group: 'nope' }, {})
check('未知 group 被拒绝且不下载', /未知依赖组/.test(badGroup.content[0].text), badGroup.content[0].text.slice(0, 60))
const depsPruneOut = await deps.execute({ action: 'prune' }, {})
check('code_index_deps prune 在空目录上安全', /已移除 0 个/.test(depsPruneOut.content[0].text), depsPruneOut.content[0].text.split('\n')[1])

// ---------- 错误路径 ----------
console.log('\n[2] 错误路径')
const badPath = await search.execute({ query: 'x', path: 'Z:\\definitely\\missing' }, {})
check('不存在的仓库给出错误文本', /错误|还没有索引/.test(badPath.content[0].text), badPath.content[0].text.slice(0, 60))
const noIndex = await search.execute({ query: 'x', path: repo }, {})
check('未建库时提示先建索引', /还没有索引/.test(noIndex.content[0].text), noIndex.content[0].text.slice(0, 80))
const outside = await search.execute({ query: 'x', path: os.homedir() }, {})
check('白名单外的路径被拒绝', /白名单/.test(outside.content[0].text), outside.content[0].text.slice(0, 80))

// ---------- status_only ----------
console.log('\n[3] code_index（status_only）')
const st = await index.execute({ path: repo, status_only: true }, {})
check('返回状态文本', /索引状态/.test(st.content[0].text), st.content[0].text.slice(0, 60))
check('报告待更新数量', /待更新/.test(st.content[0].text))

// ---------- 真实建库 ----------
console.log('\n[4] code_index（真实建库）')
const built = await index.execute({ path: repo }, {})
const builtText = built.content[0].text
check('建库成功', /索引完成/.test(builtText), builtText.slice(0, 80))
check('报告了块数', /写入 \d+ 块/.test(builtText))
console.log(builtText.split('\n').map((l) => '    ' + l).join('\n'))

// ---------- 检索 ----------
console.log('\n[5] code_search')
const sample = walkRepo(repo)[0]
const text = fs.readFileSync(path.join(repo, sample.rel), 'utf8')
const probe = [...text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{9,}\b/g)].map((m) => m[0]).sort((a, b) => b.length - a.length)[0]
const found = await search.execute({ query: probe, path: repo, top_k: 5 }, {})
const foundText = found.content[0].text
check('返回命中', /命中 \d+ 条/.test(foundText), foundText.slice(0, 80))
check('结果含 文件:行', /\[\d+\] .+:\d+-\d+/.test(foundText))
check('命中里含样本文件', foundText.includes(sample.rel), `probe=${probe}`)
check('渲染出的文本非空', foundText.length > 100)
console.log(foundText.split('\n').slice(0, 6).map((l) => '    ' + l).join('\n'))

// ---------- 状态 ----------
console.log('\n[6] code_index_status')
const s2 = await status.execute({ path: repo }, {})
const s2Text = s2.content[0].text
check('报告库文件大小', /\d+(\.\d+)?\s*MB[)）]/.test(s2Text), s2Text.slice(0, 120))
check('报告覆盖情况', /覆盖 \d+ 文件/.test(s2Text))
check('报告嵌入器状态', /嵌入器：/.test(s2Text))
console.log(s2Text.split('\n').map((l) => '    ' + l).join('\n'))

// ---------- 卸载契约 ----------
console.log('\n[7] 卸载契约（effect 清理）')
const beforeSize = registry.size
for (const e of effects) e.dispose?.()
check('effect 清理会摘掉注册的工具', registry.size === 0, `before=${beforeSize} after=${registry.size}`)

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
