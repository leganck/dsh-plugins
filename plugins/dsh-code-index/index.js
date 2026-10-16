/**
 * @local/dsh-code-index —— 本地代码库混合检索插件（纯 JS）
 *
 * 四个工具：
 *   code_index         建库 / 增量刷新（写操作，串行）
 *   code_search        混合检索：FTS5(BM25) + 向量 → RRF（只读，可并行）
 *   code_index_status  索引覆盖与新鲜度（只读，可并行）
 *   code_index_deps    可选嵌入依赖的按需安装/修剪（默认只报状态）
 *
 * 为什么值得做（本机 40 个真实检索事件 + 14 个仓库实测口径）：
 *   grep 循环（4KB 预算）10% → 纯 FTS5 32.5% → 纯向量 37.5% → **混合 55%（@10）**
 *   建索引成本：FTS5 0.84 s / 仓库；向量 17 分钟（GPU/fp16，14 个仓库全量）
 *   查询成本：分词后 1 ms（FTS5）+ 嵌入 ~10 ms + kNN ~1 ms
 *
 * 依赖是可选的**且是按需的**：装插件不下载任何重依赖（纯 JS 即可加载），
 * 需要向量时才用 code_index_deps action=install 下到自管目录；
 * 缺依赖/缺模型文件时自动退化为纯关键词检索并说明原因，不会让插件加载失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from './lib/store.js'
import { createEmbedder } from './lib/embedder.js'
import { createReranker, RERANK_TIERS } from './lib/reranker.js'
import { depsStatus, installDeps, repairDeps, removeDeps, pruneForeignPlatforms, defaultDepsDir, EMBED_PACKAGES, GROUP_NAMES, DEP_GROUPS } from './lib/deps.js'
import { isValidStrategy, strategyTable, resolveChunkConfig } from './lib/strategies.js'
import { search as hybridSearch } from './lib/search.js'
import { buildIndex, scanStatus, indexDbPath, dropIndex } from './lib/indexer.js'
import { normalizeRelPrefix } from './lib/scan.js'

/** 行为变更时递增，写入索引 meta 便于判断库是新是老 */
export const BUILD = '2026-10-17.11'
export const SCHEMA_VERSION = 1

/**
 * cordis 依赖注入声明 —— **没有它，`ctx.tools` 根本读不到**。
 *
 * 2026-10-16 实测报错（由下面的记录仪抓到，这是它上线后第一次派上用场）：
 *   Error: cannot get property "tools" without inject
 *     at applyInner (.../index.js:185)   ← 第一处 ctx.tools.register
 *
 * cordis 只在插件声明了 inject 之后才把服务挂到 ctx 上；未声明就访问会抛出上述错误，
 * 表现为**插件行整行不生效**（工具不出现、无日志）。`ctx.logger` 是 cordis 内建，
 * 不需要声明。官方参考：dsh-tool-todo → `const inject = ["tools", "sessionProjections"]`；
 * 契约见技能 cordis-plugin-development/references/host-plugin.md。
 */
export const inject = ['tools']

/**
 * 插件在 cordis 里的名字（与补丁行的 id 对应）。参考 dsh-ops / dsh-tool-todo 的
 * `export const name`。
 */
export const name = 'code-index'

// ------------------------------------------------------------------ 加载记录仪
/**
 * 为什么需要它：如果插件行在【模块导入期】就失败（例如某个顶层 import 在宿主运行时
 * 不可用 —— `node:sqlite` 就曾是这样），现象是**完全静默**的：不注册工具、不写任何
 * 日志、什么都不发生。2026-10-15 的安装就卡在这里，靠翻 asar 与进程时间线才定位。
 *
 * 因此：模块被导入时留一行、apply() 进入/结束/抛错各留一行，抛错连堆栈一起写文件。
 * 记录落在 <DSH_HOME>/code-index/_boot.log（默认 ~/.dsh/code-index/_boot.log）。
 * 记录仪自身绝不允许影响插件加载。
 */
function bootDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'code-index')
}

export function bootLog(phase, detail) {
  try {
    const dir = bootDir()
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString()
    const tail = detail === undefined ? '' : ' ' + JSON.stringify(detail)
    fs.appendFileSync(path.join(dir, '_boot.log'), `${stamp} pid=${process.pid} node=${process.version} ${phase}${tail}\n`)
  } catch {
    /* 记录失败不影响插件 */
  }
}

bootLog('module-imported', { build: BUILD })

/** 本插件自己的目录（用于把"包内 node_modules"作为依赖解析的兜底位置） */
const PLUGIN_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/**
 * 扫描选项。**建库与状态检查必须用同一份**——否则 `code_index_status` 会把被排除的文件
 * 当成"库里缺失的文件"而永远报告"过期"。
 */
function scanOptsOf(config) {
  return {
    windowLines: config.windowLines,
    maxFileBytes: config.maxFileBytes,
    excludeDirs: config.excludeDirs,
    excludePaths: config.excludePaths.map(normalizeRelPrefix).filter(Boolean),
  }
}

const DEFAULTS = {
  /** 索引基目录：<base>/<仓库名>-<路径哈希>/index.db，每仓库一库且不落在代码仓库里 */
  indexDirBase: null,
  /** 单仓库模式：直接把 index.db 放这个目录（多仓库共用一库，慎用） */
  indexDir: null,
  roots: [],
  maxFileBytes: 2 * 1024 * 1024,
  windowLines: 40,
  /**
   * 排除**目录名**（任意深度），与内置默认（node_modules/build/.git…）**合并**而非法替换。
   * 例如 `excludeDirs: ['tools-bin']`。
   */
  excludeDirs: [],
  /**
   * 排除**仓库相对路径**（或其前缀），用于"名字正常、但在本仓库里是遗留/生成物"的目录。
   * 只靠排除目录名做不到 —— 会误伤别处同名的正常目录。
   *
   * 典型场景：仓库里并存 `legacy-grails-service`（遗留 Grails，876 文件）与
   * `billing-service`（现役 Java 模块），两者只差 `svc-`，必须按路径精确排除，
   * 否则遗留目录的中文界面文案会把中文语义检索的结果整体带偏（实测命中 0/4 → 2/4）。
   *
   * 例：`excludePaths: ['legacy-grails-service', 'docs/2-technical']`
   */
  excludePaths: [],
  /**
   * 嵌入依赖（onnxruntime-node + @huggingface/transformers）**不写在 package.json 里**，
   * 而是在真正需要向量时才按需安装到 `embedding.depsDir`（默认 %LOCALAPPDATA%/dsh-code-index/embed-deps）。
   *
   * 理由见 lib/deps.js：实测那两包解压 463 MB、会触发构建脚本审批、还可能撞上安装超时；
   * 而 onnxruntime-node 的 npm 包自带各平台二进制，`--ignore-scripts` 装完照样可用（dml 后端也在）。
   */
  embedding: { backend: 'auto', modelDir: null, threads: 6, batch: null, cachePath: null, depsDir: null },
  /**
   * 切块策略（表见 lib/strategies.js，对应 Cursor 的 `GetAvailableChunkingStrategies`）：
   *   `strategy`：`auto`（按扩展名查内置表）| `ast` | `heuristic` | `window`
   *   `byExt`：按扩展名覆盖内置表的字段，例如 `{ ".vue": { "strategy": "heuristic" } }`
   * 缺 parser 依赖、或某文件解析失败时会**降级**并在建库结果里报告原因，绝不静默换策略。
   */
  chunking: { strategy: 'auto', byExt: {} },
  defaultTopK: 10,
  /**
   * 单次最多补算多少块的向量。**默认 0 = 不自动补算**：建库只做 FTS5（秒级）。
   *
   * 改成 0 的理由（2026-10-16 实测）：原先默认 20000，任何人建任何新仓库的索引都会
   * 自动跑一次可能数十分钟的重负载且事前不打招呼；用显示 GPU 跑推理时会整机卡顿
   * （实测 8227 块把机器卡了数分钟）。重活必须先说出来、由调用方显式决定。
   */
  maxEmbedPerRun: 0,
  /**
   * 交叉编码器重排（**默认关**）。取值：
   *   `off`（默认）| `fast`（top-10 候选，约 +474 ms/查询）| `quality`（top-20，约 +939 ms）
   * 实测（103 题、bge-small + bge-reranker-base fp16/DirectML）：hit@3 **42.7% → 59.2%**（quality）
   * / **57.3%**（fast）。它**不需要重建索引**（在现有向量之上重排），这是它相对"换嵌入模型"的核心优势。
   * 需要另下模型：`code_index_deps action=install group=rerank`（约 531 MB，不执行依赖脚本）。
   * 模型缺失/依赖缺失/DML 不可用时**自动降级为不重排**，只在结果里报告原因，绝不因此让搜索失败。
   */
  rerank: 'off',
  rerankModelDir: null,
}

/**
 * 配置错误。策略与 dsh-ops 一致：**不导出 Schemastery `Config`，改为显式校验并大声失败**。
 *
 * 原因（dsh-ops 的 config.js 写得很清楚，与本插件实测一致）：宿主这一半必须做到
 * **不 import 任何 `@deepseek-ai/*` 值**——那些名字由 profile 加载器提供，每多一个
 * 就多一条让插件加载失败的路（本插件就曾因缺 `inject` 而整行不生效）。
 * 所以配置校验自己做：指明是哪个键、允许什么，这正是加载器自带 schema 本来会做的事。
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

const EMBEDDING_KEYS = Object.keys(DEFAULTS.embedding)
const BACKENDS = ['auto', 'cpu', 'gpu', 'off']

function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`config 必须是对象，收到 ${Array.isArray(raw) ? 'array' : typeof raw}`)
  }
  const unknown = Object.keys(raw).filter((k) => !(k in DEFAULTS))
  if (unknown.length) {
    throw new ConfigError(`未知配置项：${unknown.join(', ')}；可用：${Object.keys(DEFAULTS).join(', ')}`)
  }
  const rawEmb = raw.embedding ?? {}
  if (rawEmb === null || typeof rawEmb !== 'object' || Array.isArray(rawEmb)) {
    throw new ConfigError(`config.embedding 必须是对象，收到 ${Array.isArray(rawEmb) ? 'array' : typeof rawEmb}`)
  }
  const unknownEmb = Object.keys(rawEmb).filter((k) => !EMBEDDING_KEYS.includes(k))
  if (unknownEmb.length) {
    throw new ConfigError(
      `未知配置项：${unknownEmb.map((k) => `embedding.${k}`).join(', ')}；可用：${EMBEDDING_KEYS.map((k) => `embedding.${k}`).join(', ')}`,
    )
  }

  const cfg = { ...DEFAULTS, ...raw, embedding: { ...DEFAULTS.embedding, ...rawEmb } }

  const intAtLeast1 = (value, key) => {
    if (!Number.isInteger(value) || value < 1) {
      throw new ConfigError(`config.${key} 必须是 >= 1 的整数，收到 ${JSON.stringify(value)}`)
    }
  }
  intAtLeast1(cfg.defaultTopK, 'defaultTopK')
  intAtLeast1(cfg.windowLines, 'windowLines')
  intAtLeast1(cfg.embedding.threads, 'embedding.threads')
  // maxEmbedPerRun 允许 0（= 不自动补算向量），这是默认值；只拒绝负数与小数
  if (!Number.isInteger(cfg.maxEmbedPerRun) || cfg.maxEmbedPerRun < 0) {
    throw new ConfigError(
      `config.maxEmbedPerRun 必须是 >= 0 的整数（0 = 建库时不补算向量），收到 ${JSON.stringify(cfg.maxEmbedPerRun)}`,
    )
  }
  if (typeof cfg.maxFileBytes !== 'number' || cfg.maxFileBytes <= 0) {
    throw new ConfigError(`config.maxFileBytes 必须是正数，收到 ${JSON.stringify(cfg.maxFileBytes)}`)
  }
  // 重排必须是三个已知取值之一：**不做"未知值就当 off"的宽容**，
  // 否则拼错（rerank: 'quality2'）会静默退化成不重排，而使用者以为已开启。
  if (!RERANK_TIERS[cfg.rerank] && cfg.rerank !== 'off') {
    throw new ConfigError(`config.rerank 必须是 'off' / ${Object.keys(RERANK_TIERS).join(' / ')} 之一，收到 ${JSON.stringify(cfg.rerank)}`)
  }
  // ---- 扫描排除（两种语义不同，都要校验）----
  for (const key of ['excludeDirs', 'excludePaths']) {
    if (!Array.isArray(cfg[key])) {
      throw new ConfigError(`config.${key} 必须是字符串数组，收到 ${Array.isArray(cfg[key]) ? 'array' : typeof cfg[key]}`)
    }
    for (const item of cfg[key]) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new ConfigError(`config.${key} 的元素必须是非空字符串，收到 ${JSON.stringify(item)}`)
      }
      if (path.isAbsolute(item)) {
        throw new ConfigError(`config.${key} 只能是仓库相对路径/目录名，不能是绝对路径：${JSON.stringify(item)}`)
      }
    }
  }
  // excludePaths 里出现 `..` 会指到仓库外，属于配置意图不明 → 直接拒绝（避免"以为排除了其实没排除"）
  for (const item of cfg.excludePaths) {
    if (normalizeRelPrefix(item).split('/').includes('..')) {
      throw new ConfigError(`config.excludePaths 不能包含 '..'：${JSON.stringify(item)}`)
    }
  }
  if (cfg.embedding.batch !== undefined && cfg.embedding.batch !== null && !Number.isInteger(cfg.embedding.batch)) {
    // null 表示自动挑 batch
    throw new ConfigError(`config.embedding.batch 必须是整数或 null，收到 ${JSON.stringify(rawEmb.batch)}`)
  }
  if (cfg.indexDirBase !== null && typeof cfg.indexDirBase !== 'string') {
    throw new ConfigError(`config.indexDirBase 必须是字符串或 null，收到 ${typeof cfg.indexDirBase}`)
  }
  if (cfg.indexDir !== null && typeof cfg.indexDir !== 'string') {
    throw new ConfigError(`config.indexDir 必须是字符串或 null，收到 ${typeof cfg.indexDir}`)
  }
  if (cfg.embedding.depsDir !== null && cfg.embedding.depsDir !== undefined && typeof cfg.embedding.depsDir !== 'string') {
    throw new ConfigError(`config.embedding.depsDir 必须是字符串或 null，收到 ${typeof cfg.embedding.depsDir}`)
  }
  if (cfg.embedding.modelDir !== null && cfg.embedding.modelDir !== undefined && typeof cfg.embedding.modelDir !== 'string') {
    throw new ConfigError(`config.embedding.modelDir 必须是字符串或 null，收到 ${typeof cfg.embedding.modelDir}`)
  }
  if (cfg.embedding.cachePath !== null && cfg.embedding.cachePath !== undefined && typeof cfg.embedding.cachePath !== 'string') {
    throw new ConfigError(`config.embedding.cachePath 必须是字符串或 null，收到 ${typeof cfg.embedding.cachePath}`)
  }
  // ---- 切块策略 ----
  const ch = cfg.chunking ?? {}
  if (typeof ch !== 'object' || Array.isArray(ch)) throw new ConfigError(`config.chunking 必须是对象，收到 ${Array.isArray(ch) ? 'array' : typeof ch}`)
  if (!isValidStrategy(ch.strategy ?? 'auto')) {
    throw new ConfigError(`config.chunking.strategy 必须是 auto|ast|heuristic|window 之一，收到 ${JSON.stringify(ch.strategy)}`)
  }
  if (ch.byExt !== undefined && (ch.byExt === null || typeof ch.byExt !== 'object' || Array.isArray(ch.byExt))) {
    throw new ConfigError(`config.chunking.byExt 必须是对象（扩展名 → 覆盖项），收到 ${JSON.stringify(ch.byExt)}`)
  }
  for (const [ext, ov] of Object.entries(ch.byExt ?? {})) {
    if (!/^\.[A-Za-z0-9._-]+$/.test(ext)) throw new ConfigError(`config.chunking.byExt 的键必须是扩展名（如 ".java"），收到 ${JSON.stringify(ext)}`)
    if (ov === null || typeof ov !== 'object' || Array.isArray(ov)) throw new ConfigError(`config.chunking.byExt["${ext}"] 必须是对象`)
    if (ov.strategy !== undefined && !isValidStrategy(ov.strategy)) {
      throw new ConfigError(`config.chunking.byExt["${ext}"].strategy 非法：${JSON.stringify(ov.strategy)}（可用 auto|ast|heuristic|window）`)
    }
  }
  if (!Array.isArray(cfg.roots)) throw new ConfigError(`config.roots 必须是数组，收到 ${typeof cfg.roots}`)
  if (!BACKENDS.includes(cfg.embedding.backend)) {
    throw new ConfigError(`config.embedding.backend 必须是 ${BACKENDS.join(' | ')}，收到 ${JSON.stringify(cfg.embedding.backend)}`)
  }
  cfg.allowedRoots = cfg.roots.map((r) => path.resolve(String(r).replace(/^~(?=[\\/]|$)/, os.homedir())))
  return cfg
}

function expandPath(p) {
  if (typeof p !== 'string' || !p) return p
  return p.replace(/^~(?=[\\/]|$)/, os.homedir()).replace(/\$\{?DSH_HOME\}?/g, process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

const textResult = (value, text) => ({ content: [{ type: 'text', text }], structuredContent: value })
const fail = (message) => ({ content: [{ type: 'text', text: `错误：${message}` }] })

export function apply(ctx, rawConfig = {}) {
  bootLog('apply-entered', { configKeys: Object.keys(rawConfig ?? {}) })
  try {
    const r = applyInner(ctx, rawConfig)
    bootLog('apply-completed')
    return r
  } catch (e) {
    // 抛错也要留下证据：应用层只会把它当成"这一行没加载"，不会告诉你原因
    bootLog('apply-THREW', { message: e?.message ?? String(e), stack: String(e?.stack ?? '').slice(0, 1500) })
    throw e
  }
}

function applyInner(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)

  // 加载标记：尽早写。写在这里而不是函数末尾 —— 之后任何一步（尤其工具注册）
  // 抛错时，标记仍能证明"apply() 确实被调用过"，从而把故障范围一分为二。
  //
  // **位置必须与 _boot.log 一致（都走 bootDir() = <DSH_HOME>/code-index）**。
  // 早前这里是从 indexDirBase/indexDir 推导的，于是同一个进程的不同 apply 调用会
  // 写到不同位置；更要命的是没给 indexDir 的调用会回落到**真实** ~/.dsh/code-index，
  // 使得 `DSH_HOME` 隔离对它无效——实测就是"跑一次测试，线上加载标记被测试数据覆盖"
  // （标记显示源码目录、backend: off、只列 3 个工具），而"重启后到底加载了哪个版本"
  // 就再也说不清了。标记回答的是"这个进程加载了哪个构建"，这是 DSH 层面的事实，
  // 与索引放哪里无关。
  try {
    const markerDir = bootDir()
    fs.mkdirSync(markerDir, { recursive: true })
    fs.writeFileSync(
      path.join(markerDir, '_loaded.json'),
      JSON.stringify(
        {
          build: BUILD,
          schemaVersion: SCHEMA_VERSION,
          loadedAt: new Date().toISOString(),
          pid: process.pid,
          node: process.version,
          pluginDir: path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
          tools: ['code_index', 'code_search', 'code_index_status', 'code_index_deps'],
          config: {
            indexDirBase: config.indexDirBase,
            roots: config.allowedRoots,
            embedding: { backend: config.embedding.backend, modelDir: expandPath(config.embedding.modelDir) ?? null },
            rerank: { tier: config.rerank, modelDir: expandPath(config.rerankModelDir) ?? null },
            chunking: { strategy: config.chunking?.strategy ?? 'auto', byExt: Object.keys(config.chunking?.byExt ?? {}) },
            // 扫描范围与预算也要记：否则"加载时到底排除了哪些目录"无法回答 ——
            // 这个坑真的踩过：profile 的 config 覆盖条目**替换整份 config**，
            // 写漏了不会报错、只是静默失效，而标记里看不到就没法确认。
            scan: {
              excludeDirs: config.excludeDirs ?? [],
              excludePaths: config.excludePaths ?? [],
              maxFileBytes: config.maxFileBytes,
              windowLines: config.windowLines,
              defaultTopK: config.defaultTopK,
              maxEmbedPerRun: config.maxEmbedPerRun,
            },
          },
          markerFile: path.join(markerDir, '_loaded.json'),
        },
        null,
        2,
      ),
    )
  } catch (e) {
    bootLog('marker-failed', { message: String(e?.message).slice(0, 200) })
  }

  const stores = new Map()
  let embedderPromise = null

  // ---------------------------------------------------------------- 工具注册
  // practices.md：「Register every resource inside `apply` with `ctx.effect` or `ctx.on`
  // and return its cleanup.」注册属于 context 拥有的 effect：插件卸载 / profile 补丁
  // 变更时，cordis 依据这个 effect 回收我们注册的工具，不需要外部追踪。
  const toolDisposers = []
  const registerTool = (def) => {
    const dispose = ctx.tools.register(def)
    if (typeof dispose === 'function') toolDisposers.push(dispose)
    else if (dispose && typeof dispose.dispose === 'function') toolDisposers.push(() => dispose.dispose())
    return dispose
  }
  ctx.effect(
    () => () => {
      for (const dispose of toolDisposers.splice(0)) {
        try {
          dispose()
        } catch (e) {
          bootLog('tool-dispose-failed', { message: String(e?.message).slice(0, 200) })
        }
      }
    },
    'dsh-code-index: tools',
  )

  // 会话工作目录（工具未显式给 path 时用）；取不到就退回进程 cwd
  const sessionCwd = (exec) => {
    try {
      return exec?.agent?.session?.cwd ?? process.cwd()
    } catch {
      return process.cwd()
    }
  }

  function storeFor(repoRoot) {
    const dbPath = indexDbPath(repoRoot, { indexDir: config.indexDir, indexDirBase: config.indexDirBase })
    let s = stores.get(dbPath)
    if (!s) {
      s = Store.open(dbPath)
      stores.set(dbPath, s)
    }
    return { store: s, dbPath }
  }

  function assertAllowed(repoRoot) {
    if (!config.allowedRoots.length) return
    const ok = config.allowedRoots.some((r) => repoRoot === r || repoRoot.startsWith(r + path.sep))
    if (!ok) throw new Error(`路径不在允许的 roots 白名单内：${repoRoot}\n已配置：${config.allowedRoots.join(', ')}`)
  }

  async function getEmbedder() {
    if (config.embedding.backend === 'off') return { ok: false, reason: '配置 embedding.backend = off' }
    if (!embedderPromise) {
      embedderPromise = createEmbedder({
        modelDir: expandPath(config.embedding.modelDir) ?? undefined,
        backend: config.embedding.backend,
        threads: config.embedding.threads,
        batch: config.embedding.batch,
        cachePath: expandPath(config.embedding.cachePath) ?? undefined,
        // 依赖按需安装在受管目录；插件自身目录作为兜底（兼容把依赖装在包内的旧形态）
        depsDir: expandPath(config.embedding.depsDir) ?? undefined,
        depsFallbackDirs: [PLUGIN_DIR],
        log: (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`),
      })
    }
    return embedderPromise
  }

  /**
   * 重排器（**懒加载**）：只在配置开启且真的用到时才建会话（531 MB 模型 + DML 会话不该在启动时付）。
   * 失败不抛错 —— 返回 {ok:false, reason}，由 search 走"不重排"的分支并把原因写进结果。
   */
  let rerankerPromise = null
  async function getReranker() {
    if (config.rerank === 'off') return { ok: false, reason: '配置 rerank = off' }
    if (!rerankerPromise) {
      rerankerPromise = createReranker({
        modelDir: expandPath(config.rerankModelDir) ?? undefined,
        backend: config.embedding.backend === 'cpu' ? 'cpu' : 'auto',
        threads: config.embedding.threads,
        depsDir: expandPath(config.embedding.depsDir) ?? undefined,
        depsFallbackDirs: [PLUGIN_DIR],
        log: (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`),
      })
    }
    return rerankerPromise
  }

  // ---------------------------------------------------------------- code_index
  registerTool({
    name: 'code_index',
    description:
      '建立或增量刷新某个代码仓库的检索索引（本地 SQLite：FTS5 全文 + 可选向量）。首次较慢（向量部分按仓库大小，实测 GPU 约 4–17 分钟/仓库），之后只处理变化的文件，通常秒级。'
      + '用 status_only=true 只查看将会有多少文件变化而不写入。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库根目录（绝对路径）。省略则用当前会话工作目录。' },
        mode: { type: 'string', enum: ['incremental', 'full'], description: 'full = 先清空再重建；默认 incremental。' },
        status_only: { type: 'boolean', description: '只统计变化数量，不写入索引。' },
        max_embed: {
          type: 'integer',
          description:
            '本轮最多补算多少块的向量。**默认 0 = 不补算**，建库只做全文索引（秒级）。要启用语义检索就显式给一个正整数（建议 500~2000 分批跑，可续算）；补算是重负载，可能占满 GPU/CPU 数分钟并让整机变卡。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v.content?.[0]?.text ?? '' }] },
    async execute(args, exec) {
      try {
        const repoRoot = path.resolve(expandPath(args.path) ?? sessionCwd(exec))
        if (!fs.existsSync(repoRoot)) return fail(`目录不存在：${repoRoot}`)
        assertAllowed(repoRoot)
        const { store, dbPath } = storeFor(repoRoot)

        if (args.status_only) {
          const st = scanStatus(store, repoRoot, scanOptsOf(config))
          const s = store.stats()
          return textResult(
            { repoRoot, dbPath, status: st, stats: s },
            `索引状态 ${repoRoot}\n` +
              `  已入库：${s.files} 文件 / ${s.chunks} 块 / ${s.vectors} 向量\n` +
              `  仓库当前：${st.scanned} 个候选文件\n` +
              `  待更新：${st.changed} 改 / ${st.removed} 删；未变 ${st.unchanged}\n` +
              `  ${st.stale ? '索引已过期，运行 code_index 刷新' : '索引是最新的'}`,
          )
        }

        const embedder = await getEmbedder()
        const r = await buildIndex({
          store,
          repoRoot,
          opts: scanOptsOf(config),
          embedder,
          budget: { maxEmbedPerRun: args.max_embed ?? config.maxEmbedPerRun, mode: args.mode ?? 'incremental' },
          chunking: { ...config.chunking, windowLines: config.windowLines },
          depsDir: expandPath(config.embedding.depsDir) ?? undefined,
          depsFallbackDirs: [PLUGIN_DIR],
        })
        const lines = [
          `索引完成（${r.mode}）${repoRoot}`,
          `  扫描 ${r.scanned} 文件；变更 ${r.changed} / 删除 ${r.removed}；写入 ${r.chunksWritten} 块`,
          `  切块策略：${Object.entries(r.strategies ?? {}).map(([s, n]) => `${s} ${n} 文件`).join('；') || '（本轮无变更文件）'}`,
          `  向量：${r.vectorsBefore} → ${r.vectorsAfter}（本轮补算 ${r.embedded}）`,
          `  ${r.embedNote}`,
          `  用时 ${(r.elapsedMs / 1000).toFixed(1)}s；库 ${dbPath}`,
        ]
        // 降级必须显式可见：以为在用 AST、实际在跑启发式，是"检索质量悄悄变化"的典型来源
        if (r.strategyChanged) {
          lines.push('  ⚠️ 切块策略指纹变了 → 已自动全量重建（否则库里会混着新旧两种粒度的块）')
        }
        if (r.embedChanged) {
          lines.push('  ⚠️ 嵌入模型变了 → 已自动全量重建（否则旧模型的向量会被当成有效向量继续参与点积）')
        }
        if (r.embeddingTag) lines.push(`  向量模型：${r.embeddingTag}`)
        for (const why of r.chunkFallbacks ?? []) lines.push(`  ⚠️ ${why}`)
        if (r.fileErrors.length) lines.push(`  读取失败 ${r.fileErrors.length} 个：${r.fileErrors.join('; ')}`)
        if (!embedder.ok) lines.push(`  ⚠️ 向量通道未启用，当前是纯关键词检索：${embedder.reason}`)
        else if (r.stats.vectors < r.stats.chunks) {
          // 让"向量没补完"显式可见：8227 块 / 0 向量这种人眼容易划过去，
          // 而它直接决定语义召回是否存在（实测曾有会话因此以为配置关了向量）
          lines.push(
            `  ⚠️ 向量不完整：${r.stats.vectors}/${r.stats.chunks} 块有向量 —— 语义召回只覆盖一部分；传 max_embed 再跑一次可续算`,
          )
        }
        return textResult({ repoRoot, dbPath, ...r }, lines.join('\n'))
      } catch (e) {
        return fail(String(e.message))
      }
    },
  })

  // ---------------------------------------------------------------- code_search
  registerTool({
    name: 'code_search',
    description:
      '在本仓库的代码索引里做混合检索（关键词 BM25 + 语义向量，RRF 融合），返回排好序的「文件:行 + 片段」。'
      + '第一次查询前需要先跑 code_index。适合“XX 逻辑在哪实现 / 哪个文件处理了 YY”这类问题；'
      + '查找确切字符串（日志、错误码原文）用 grep 更快。',
    isConcurrencySafe: () => true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言问题或关键词组合。' },
        path: { type: 'string', description: '仓库根目录。省略则用当前会话工作目录。' },
        top_k: { type: 'integer', description: '返回条数，默认 10。' },
        mode: { type: 'string', enum: ['auto', 'fts', 'vector'], description: '检索通道，默认 auto（混合）。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v.content?.[0]?.text ?? '' }] },
    async execute(args, exec) {
      try {
        const repoRoot = path.resolve(expandPath(args.path) ?? sessionCwd(exec))
        // 白名单必须在打开/创建索引库之前校验，否则会在任意路径下建出 .dsh-index
        assertAllowed(repoRoot)
        const { store, dbPath } = storeFor(repoRoot)
        const s = store.stats()
        if (s.chunks === 0) {
          return fail(`该目录还没有索引：${repoRoot}\n先运行 code_index（path=${repoRoot}）。索引位于 ${dbPath}`)
        }
        const embedder = await getEmbedder()
        const reranker = await getReranker()
        const tier = RERANK_TIERS[config.rerank]
        const r = await hybridSearch(store, embedder, args.query, {
          topK: args.top_k ?? config.defaultTopK,
          mode: args.mode ?? 'auto',
          reranker: tier ? reranker : null,
          rerankCandidates: tier?.candidates ?? 0,
        })
        if (!r.results.length) {
          return textResult(
            { repoRoot, mode: r.mode, terms: r.terms, results: [], rerank: r.rerank },
            `没有命中（通道 ${r.mode}，词项 ${r.terms.join(' / ') || '无'}）。${r.note}\n`
              + `建议：换更具体的标识符（类名/方法名/错误码），或先用 grep 找确切字符串。`,
          )
        }
        const lines = [`命中 ${r.results.length} 条（通道 ${r.mode}；词项 ${r.terms.join(' / ')}）`]
        if (r.note) lines.push(`  ${r.note}`)
        // 重排状态必须显式报告：开了没生效（缺模型/降级）与"本来就没开"是两件事，
        // 不写清楚就会让人以为在享受重排的收益。
        if (r.rerank?.applied) {
          lines.push(`  重排：${config.rerank}（${r.rerank.candidates} 个候选，${r.rerank.ms} ms，${r.rerank.backend}/${r.rerank.modelFile}）`)
        } else if (r.rerank) {
          lines.push(`  重排未生效：${r.rerank.reason ?? '未知原因'}`)
        }
        for (const hit of r.results) {
          const rs = hit.rerankScore === undefined ? '' : ` / rerank ${hit.rerankScore}`
          lines.push(`\n[${hit.rank}] ${hit.path}:${hit.startLine}-${hit.endLine}  (fts ${hit.ftsRank ?? '-'} / vec ${hit.vecRank ?? '-'}${rs})`)
          lines.push(hit.snippet.split('\n').map((l) => '    ' + l).join('\n'))
        }
        return textResult({ repoRoot, mode: r.mode, terms: r.terms, results: r.results, rerank: r.rerank }, lines.join('\n'))
      } catch (e) {
        return fail(String(e.message))
      }
    },
  })

  // ---------------------------------------------------------------- code_index_status
  registerTool({
    name: 'code_index_status',
    description: '查看代码索引的覆盖情况与新鲜度（文件/块/向量数量、有多少文件变了、库文件大小）。',
    isConcurrencySafe: () => true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库根目录。省略则用当前会话工作目录。' },
        scan: { type: 'boolean', description: '是否扫描仓库比对新鲜度（默认 true；大仓库约 0.1–1s）。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v.content?.[0]?.text ?? '' }] },
    async execute(args, exec) {
      try {
        const repoRoot = path.resolve(expandPath(args.path) ?? sessionCwd(exec))
        assertAllowed(repoRoot)
        const { store, dbPath } = storeFor(repoRoot)
        const s = store.stats()
        const embedder = await getEmbedder()
        const lines = [
          `索引：${repoRoot}`,
          `  库文件 ${dbPath}（${(s.dbBytes / 1048576).toFixed(1)} MB）`,
          `  覆盖 ${s.files} 文件 / ${s.chunks} 块 / ${s.vectors} 向量`,
          `  最后建库：${store.getMeta('last_build_at') ? new Date(Number(store.getMeta('last_build_at'))).toLocaleString() : '从未'}`,
          `  嵌入器：${embedder.ok ? `${embedder.backend}/${embedder.modelFile}（缓存 ${embedder.cacheEntries} 条）` : `未启用 —— ${embedder.reason}`}`,
          // 索引里的向量由哪个模型产出：与当前模型不一致时向量通道会被闸门挡住（见 lib/search.js）
          `  索引向量模型：${store.getMeta('embedding_tag') ?? '未记录（旧版本建的库）'}${embedder.ok ? `　当前模型：${embedder.modelTag}` : ''}`,
        ]
        let st = null
        if (args.scan !== false) {
          st = scanStatus(store, repoRoot, scanOptsOf(config))
          lines.push(`  新鲜度：${st.stale ? `过期（${st.changed} 改 / ${st.removed} 删）` : '最新'}；候选文件 ${st.scanned}`)
        }
        // 重排状态：只报"配置值"，**不在这里加载模型**（status 必须是轻量的，不该为了显示去建 531 MB 会话）
        if (RERANK_TIERS[config.rerank]) {
          lines.push(`  重排：${config.rerank}（候选 ${RERANK_TIERS[config.rerank].candidates} 个，实测约 +${config.rerank === 'fast' ? 474 : 939} ms/查询，首次用到时才加载模型）`)
        } else {
          lines.push('  重排：off')
        }
        // 排除规则要可见：用户改完配置最需要确认的就是"到底排掉了没有"
        const excl = [...config.excludePaths.map((p) => `路径 ${normalizeRelPrefix(p)}`), ...config.excludeDirs.map((d) => `目录名 ${d}`)]
        if (excl.length) lines.push(`  已排除：${excl.join('、')}（另有内置 ${'node_modules/build/.git 等'}）`)
        // 向量完整性显式提示：这一行决定了"语义召回到底有没有在工作"
        if (embedder.ok && s.chunks > 0 && s.vectors < s.chunks) {
          lines.push(
            `  ⚠️ 向量不完整：${s.vectors}/${s.chunks} 块有向量（${((s.vectors / s.chunks) * 100).toFixed(0)}%）—— 当前检索只有关键词 + 部分语义，传 max_embed=<正整数> 跑 code_index 可补算`,
          )
        }
        return textResult({ repoRoot, dbPath, stats: s, scan: st, embedder: embedder.ok ? { backend: embedder.backend, model: embedder.modelFile, cacheEntries: embedder.cacheEntries } : { ok: false, reason: embedder.reason } }, lines.join('\n'))
      } catch (e) {
        return fail(String(e.message))
      }
    },
  })

  registerTool({
    name: 'code_index_deps',
    description:
      '管理代码索引插件的**可选嵌入依赖**（onnxruntime-node + @huggingface/transformers；解压约 240–460 MB）。'
      + '这两个依赖**不随插件安装**——插件装好即可用（纯关键词检索），只有真正需要向量检索时才用本工具按需下载。'
      + 'action：status（默认，只看状态）/ install（下载安装；用 --ignore-scripts，**不执行任何依赖脚本**，因此不需要构建审批）/ '
      + 'prune（修剪非本平台的二进制，实测省约 223 MB）/ repair（删掉重装）/ remove（删除）。'
      + '只安装到插件自管的受管目录，不改 profile、不改 package.json。install/repair 需要网络，可能耗时数分钟。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'prune', 'repair', 'remove'], description: '默认 status。' },
        group: {
          type: 'string',
          enum: [...GROUP_NAMES, 'all'],
          description: `依赖组：embed（向量嵌入，约 661 MB 未修剪 / 264 MB 修剪后）| parser（tree-sitter 语法解析，约 41 MB）| all。默认 embed。`,
        },
        registry: { type: 'string', description: '可选的 npm registry（省略则沿用本机 npm 配置）。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v.content?.[0]?.text ?? '' }] },
    async execute(args) {
      try {
        const action = args.action ?? 'status'
        const group = args.group ?? 'embed'
        if (group !== 'all' && !GROUP_NAMES.includes(group)) {
          return fail(`未知依赖组：${group}（可用：${GROUP_NAMES.join(', ')}, all）`)
        }
        const depsDir = expandPath(config.embedding.depsDir) ?? defaultDepsDir()
        const lines = [`依赖目录：${depsDir}`, `依赖组：${Object.entries(DEP_GROUPS).map(([g, l]) => `${g}(${l.length} 包)`).join('、')}`]
        let detail = {}
        if (action === 'install' || action === 'repair') {
          const log = (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`)
          const fn = action === 'install' ? installDeps : repairDeps
          const r = await fn({ depsDir, registry: args.registry, group, log })
          lines.push(r.note)
          if (r.stdout) {
            const tail = String(r.stdout).trim().split('\n').filter(Boolean).slice(-3)
            if (tail.length) lines.push(`npm 输出尾部：${tail.join(' | ')}`)
          }
          detail = { action, group, ok: r.ok }
        } else if (action === 'prune') {
          const p = pruneForeignPlatforms(depsDir)
          lines.push(`已移除 ${p.removed.length} 个非本平台目录（保留 ${p.kept}），回收 ${(p.freedBytes / 1048576).toFixed(1)} MB`)
          detail = { action, removed: p.removed.length, freedBytes: p.freedBytes }
        } else if (action === 'remove') {
          const r = removeDeps(depsDir)
          lines.push(r.note)
          detail = { action, removed: r.removed }
        }
        const st = depsStatus({ depsDir, alsoDirs: [PLUGIN_DIR], group })
        lines.push(`\n各组状态（体积合计 ${(st.sizeBytes / 1048576).toFixed(1)} MB）：`)
        for (const [g, gs] of Object.entries(st.groups)) {
          const why = [
            gs.missing.length ? `缺 ${gs.missing.join(', ')}` : '',
            gs.mismatched.length ? `版本不符：${gs.mismatched.join('；')}` : '',
            gs.broken.length ? `加载失败 ${gs.broken.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('；')
          lines.push(`  [${g}] ${gs.installed ? '就绪' : `未就绪（${why}）`}`)
          for (const p of gs.packages) {
            lines.push(
              `      ${p.name}@${p.wanted}：受管目录 ${p.installedInManagedDir ?? '无'}${p.installedInManagedDir && !p.versionMatches ? ' ⚠️ 版本不符' : ''}；可解析 ${p.resolvable ? '是' : '否'}`,
            )
          }
        }
        const missing = GROUP_NAMES.filter((g) => !st.groups[g]?.installed)
        lines.push('')
        lines.push(
          missing.length
            ? `下一步：code_index_deps action=install group=${missing.join('|')} —— ` +
                missing.map((g) => `${g}: ${DEP_GROUPS[g].map((p) => `${p.name}@${p.version}`).join(', ')}`).join('；')
            : '两组依赖都已就绪：code_index 传 max_embed=<正整数> 可补算向量；AST 切块（策略 ast）可直接使用。',
        )
        // 重排模型是**模型**不是 npm 依赖（与嵌入模型同一约定：模型由 tools/fetch-model.mjs 下）。
        // 这里只如实报告它是否就位 —— 因为"开了 rerank 但模型没下"会静默降级成不重排。
        const rrDir = expandPath(config.rerankModelDir) ?? path.join(os.homedir(), '.dsh', 'models', 'bge-reranker-base')
        const rrHas = (f) => fs.existsSync(path.join(rrDir, f))
        lines.push('')
        lines.push(`重排模型（${rrDir}）：`)
        if (rrHas('model_fp16.onnx')) lines.push('  ✅ model_fp16.onnx（DirectML 推荐，实测每候选 47 ms）')
        if (rrHas('model_int8.onnx')) lines.push('  ✅ model_int8.onnx（仅 CPU，实测每候选 250 ms）')
        if (!rrHas('model_fp16.onnx') && !rrHas('model_int8.onnx')) {
          lines.push(`  ❌ 未下载 —— 下载：node tools/fetch-model.mjs --model bge-reranker-base --quant fp16（531 MB）`)
        }
        if (rrHas('tokenizer.json')) lines.push('  ✅ tokenizer.json')
        return textResult({ depsDir, rerankModelDir: rrDir, ...detail, status: st }, lines.join('\n'))
      } catch (e) {
        return fail(String(e.message))
      }
    },
  })

  // 策略表快照：让"每种文件会用哪种切块器"是可查的，而不是埋在代码里
  const sample = ['.java', '.ts', '.vue', '.xml', '.md', '(.其它)']
    .map((ext) => {
      const c = resolveChunkConfig(ext === '(.其它)' ? 'x.unknown' : `x${ext}`, { strategy: 'auto' })
      return ext === '(.其它)' ? `其它→${c.strategy}` : `${ext}→${c.strategy}`
    })
    .join(' ')

  ctx.logger?.info?.(
    `dsh-code-index ${BUILD} 已加载（roots=${config.allowedRoots.length || '任意'}，embedding=${config.embedding.backend}，` +
      `chunking=${config.chunking.strategy}，deps=${expandPath(config.embedding.depsDir) ?? defaultDepsDir()}）`,
  )
  ctx.logger?.info?.(`dsh-code-index 切块策略表：${sample}（表见 lib/strategies.js，可用 config.chunking.byExt 覆盖）`)
  bootLog('tools-registered', { tools: ['code_index', 'code_search', 'code_index_status', 'code_index_deps'] })
}
