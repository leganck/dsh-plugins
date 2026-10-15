/**
 * 插件接口层测试：不启动 DSH，用假 ctx 验证 apply() 注册了哪些工具、
 * 参数声明是否正确、三个工具能否真的跑通，以及错误路径是否给出可读信息。
 *
 * 用法：node test-plugin.mjs [--repo <path>] [--no-embed]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from './index.js'
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

// ---- 假 ctx：只实现插件真正用到的那两件事 ----
const registry = new Map()
const logs = []
const ctx = {
  tools: {
    register(def) {
      if (registry.has(def.name)) throw new Error(`already registered: ${def.name}`)
      registry.set(def.name, def)
      return () => registry.delete(def.name)
    },
  },
  logger: { info: (m) => logs.push(String(m)) },
}

const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-plugin-'))
apply(ctx, {
  indexDir,
  roots: [repo],
  embedding: process.argv.includes('--no-embed') ? { backend: 'off' } : { backend: 'auto', modelDir },
  maxEmbedPerRun: 400,
})

console.log(`仓库: ${repo}\n索引目录: ${indexDir}\n`)

// ---------- 注册面 ----------
console.log('[1] 工具注册面')
check('注册了 3 个工具', registry.size === 3, [...registry.keys()].join(','))
for (const name of ['code_index', 'code_search', 'code_index_status']) {
  check(`包含 ${name}`, registry.has(name))
}
const search = registry.get('code_search')
const index = registry.get('code_index')
const status = registry.get('code_index_status')
check('code_search 声明为并发安全', search?.isConcurrencySafe?.() === true)
check('code_index_status 声明为并发安全', status?.isConcurrencySafe?.() === true)
check('code_index 未声明并发安全（写操作应串行）', index?.isConcurrencySafe === undefined)
check('code_search 的 query 是必填参数', search?.parameters?.required?.includes('query') === true, JSON.stringify(search?.parameters?.required))
check('三个工具都提供了 render', [search, index, status].every((t) => typeof t.output?.render === 'function'))
check('插件写入了加载日志', logs.some((l) => l.includes('dsh-code-index')), JSON.stringify(logs))

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

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
