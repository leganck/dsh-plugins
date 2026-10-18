/**
 * 生成 DSH 插件源索引（plugin market index, **format 1**）。
 *
 * 插件源 = 一个 http(s) 上的单文件 JSON，由 `@deepseek-ai/dsh-plugin-market-index` 校验；
 * 用户在 Discover 里填 URL，Host 直接 fetch（不跟随重定向）。
 *
 * 设计要点：**自动发现**。扫描 `plugins/*`，不再维护硬编码的插件清单 ——
 * 新增插件只需建目录 + 在 package.json 写 `dsh.market`（缺省也能收录，只是文案退化）。
 *
 * 用法：
 *   node market/build-index.mjs            # 写 market/index.json
 *   node market/build-index.mjs --check    # 与仓库里的 index.json 比对，不一致退出 1（CI 用）
 *   node market/build-index.mjs --print    # 只打印生成结果
 *
 * format 1 的硬约束（生成器负责满足）：
 *   version 精确 SemVer · commit 小写 40 位 · source.url 为 https canonical 仓库地址
 *   · icon 相对索引 URL 解析且同源 · 引用的 category/labels/sortKeys 必须先声明 · 插件名唯一
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'market', 'index.json')
const REPO_URL = 'https://github.com/leganck/dsh-plugins.git'
const REPO_HTTP = 'https://github.com/leganck/dsh-plugins'

const sh = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

/** 已知分类的中英文名；插件声明了未知 id 也不失败，自动补一份 { en: id } */
const CATEGORY_TITLES = {
  retrieval: { en: 'Retrieval', zh: '检索' },
  context: { en: 'Context', zh: '上下文' },
  workspace: { en: 'Workspace', zh: '工作空间' },
}
const LABEL_TITLES = {
  'keyword-search': { en: 'Keyword search', zh: '关键词检索' },
  'semantic-search': { en: 'Semantic search', zh: '语义检索' },
  ast: { en: 'AST chunking', zh: 'AST 切块' },
  compaction: { en: 'Compaction', zh: '压缩' },
  archive: { en: 'Archive', zh: '归档' },
  'multi-root': { en: 'Multi-root', zh: '多根目录' },
  scaffold: { en: 'Scaffold', zh: '脚手架' },
}

const isLocalized = (v) => typeof v === 'object' && v !== null && typeof v.en === 'string'

/** 把 package.json 里的展示信息规范化成 format 1 要的样子（缺啥补啥，不静默丢插件） */
function presentationOf(pkg, dir) {
  const m = pkg.dsh?.market ?? {}
  const warned = []
  const title = isLocalized(m.title) ? m.title : { en: m.title ?? pkg.name.split('/').at(-1) }
  if (!isLocalized(m.title)) warned.push('dsh.market.title')
  const description = isLocalized(m.description)
    ? m.description
    : { en: m.description ?? pkg.description ?? pkg.name }
  if (!isLocalized(m.description)) warned.push('dsh.market.description')
  const category = typeof m.category === 'string' && m.category ? m.category : 'misc'
  if (!m.category) warned.push('dsh.market.category')
  const labels = Array.isArray(m.labels) ? m.labels.filter((l) => typeof l === 'string') : []
  const iconRel = typeof m.icon === 'string' ? m.icon : fs.existsSync(path.join(ROOT, dir, 'icon.svg')) ? './icon.svg' : null
  // format 1：icon 相对**索引 URL** 解析 → 索引在 market/，插件在其兄弟目录
  const icon = iconRel ? path.posix.join('..', dir, iconRel.replace(/^\.\//, '')) : undefined
  return {
    title,
    description,
    category,
    labels,
    ...(icon ? { icon } : {}),
    ...(Array.isArray(pkg.keywords) ? { keywords: pkg.keywords } : {}),
    warned,
  }
}

function build() {
  const pluginsDir = path.join(ROOT, 'plugins')
  const dirs = fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  const commit = sh(['rev-parse', 'HEAD'])
  const commitTime = Number(sh(['show', '-s', '--format=%ct', 'HEAD']))
  const dirty = sh(['status', '--porcelain']) !== ''

  const categories = new Map()
  const labels = new Map()
  const plugins = []

  for (const name of dirs) {
    const dir = `plugins/${name}`
    const pkgPath = path.join(ROOT, dir, 'package.json')
    if (!fs.existsSync(pkgPath)) {
      console.warn(`⚠️  跳过 ${dir}：没有 package.json`)
      continue
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    if (!pkg.dsh?.bundle?.patch) {
      console.warn(`⚠️  跳过 ${dir}：package.json 没有 dsh.bundle.patch（装上也挂不起来）`)
      continue
    }
    const pres = presentationOf(pkg, dir)
    if (pres.warned.length) console.warn(`⚠️  ${pkg.name} 缺 ${pres.warned.join(' / ')}，已退化补齐`)

    // format 1 的声明形如 { <id>: { title: {en,zh} } } —— title 必须是**本地化对象**，不是裸字符串
    categories.set(pres.category, { title: CATEGORY_TITLES[pres.category] ?? { en: pres.category } })
    for (const l of pres.labels) labels.set(l, { title: LABEL_TITLES[l] ?? { en: l } })

    const engines = pkg.peerDependencies?.['@deepseek-ai/dsh']
    plugins.push({
      name: pkg.name,
      title: pres.title,
      description: pres.description,
      ...(pres.icon ? { icon: pres.icon } : {}),
      ...(pkg.author ? { author: typeof pkg.author === 'string' ? pkg.author : pkg.author.name } : {}),
      homepage: `${REPO_HTTP}/tree/main/${dir}`,
      repository: { url: REPO_HTTP, directory: dir },
      metadata: {
        category: pres.category,
        keywords: pres.keywords ?? [],
        labels: pres.labels,
        sortKeys: { published: commitTime },
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: commitTime,
          source: { type: 'git', url: REPO_URL, commit, path: dir },
          ...(engines ? { engines: { dsh: engines } } : {}),
        },
      ],
    })
  }

  const sortedObj = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
  const index = {
    format: 1,
    title: { en: 'leganck DSH plugins', zh: 'leganck 的 DSH 插件' },
    description: {
      en: 'Local-first DSH bundles: repository retrieval, verbatim session archive, multi-root workspace.',
      zh: '本地优先的 DSH 插件集合：代码库检索、会话逐字归档、多根工作空间。',
    },
    metadata: {
      categories: sortedObj(categories),
      labels: sortedObj(labels),
      sortKeys: { published: { title: { en: 'Published', zh: '发布时间' }, order: 'desc' } },
    },
    plugins,
  }
  return { index, commit, commitTime, dirty }
}

const { index, commit, dirty } = build()
const text = JSON.stringify(index, null, 2) + '\n'
const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
const summary = `plugins=${index.plugins.length} commit=${commit.slice(0, 8)} sha256:${digest}`

if (process.argv.includes('--print')) {
  process.stdout.write(text)
  process.exit(0)
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : ''
  if (current === text) {
    console.log(`✅ market/index.json 与 plugins/* 一致（${summary}）`)
    process.exit(0)
  }
  console.error('❌ market/index.json 已过期（或被手改过）—— 运行 `pnpm market` 重新生成')
  const a = current.split('\n')
  const b = text.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`   首个差异在第 ${i + 1} 行：`)
      console.error(`   仓库: ${a[i] ?? '(缺行)'}`)
      console.error(`   生成: ${b[i] ?? '(缺行)'}`)
      break
    }
  }
  process.exit(1)
}

if (dirty) console.warn('⚠️  工作区有未提交改动：索引仍指向 HEAD（git 源按 commit 取文件）')
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, text)
console.log(`✅ ${path.relative(ROOT, OUT)}  ${summary}`)
for (const p of index.plugins) {
  console.log(`   ${p.name}@${p.versions[0].version}  ← git+${REPO_URL}#${commit.slice(0, 8)}&path:/${p.repository.directory}`)
}
