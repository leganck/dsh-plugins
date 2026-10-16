/**
 * @local/dsh-code-index —— 本地代码库混合检索插件（纯 JS）
 *
 * 三个工具：
 *   code_index         建库 / 增量刷新（写操作，串行）
 *   code_search        混合检索：FTS5(BM25) + 向量 → RRF（只读，可并行）
 *   code_index_status  索引覆盖与新鲜度（只读，可并行）
 *
 * 为什么值得做（本机 40 个真实检索事件 + 14 个仓库实测口径）：
 *   grep 循环（4KB 预算）10% → 纯 FTS5 32.5% → 纯向量 37.5% → **混合 55%（@10）**
 *   建索引成本：FTS5 0.84 s / 仓库；向量 17 分钟（GPU/fp16，14 个仓库全量）
 *   查询成本：分词后 1 ms（FTS5）+ 嵌入 ~10 ms + kNN ~1 ms
 *
 * 依赖是可选的：缺 onnxruntime-node / 缺模型文件时自动退化为纯关键词检索，
 * 并在结果里说明原因，不会让插件加载失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from './lib/store.js'
import { createEmbedder } from './lib/embedder.js'
import { search as hybridSearch } from './lib/search.js'
import { buildIndex, scanStatus, indexDbPath, dropIndex } from './lib/indexer.js'

/** 行为变更时递增，写入索引 meta 便于判断库是新是老 */
export const BUILD = '2026-10-16.4'
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

const DEFAULTS = {
  /** 索引基目录：<base>/<仓库名>-<路径哈希>/index.db，每仓库一库且不落在代码仓库里 */
  indexDirBase: null,
  /** 单仓库模式：直接把 index.db 放这个目录（多仓库共用一库，慎用） */
  indexDir: null,
  roots: [],
  maxFileBytes: 2 * 1024 * 1024,
  windowLines: 40,
  embedding: { backend: 'auto', modelDir: null, threads: 6, batch: null, cachePath: null },
  defaultTopK: 10,
  /**
   * 单次最多补算多少块的向量。**默认 0 = 不自动补算**：建库只做 FTS5（秒级）。
   *
   * 改成 0 的理由（2026-10-16 实测）：原先默认 20000，任何人建任何新仓库的索引都会
   * 自动跑一次可能数十分钟的重负载且事前不打招呼；用显示 GPU 跑推理时会整机卡顿
   * （实测 8227 块把机器卡了数分钟）。重活必须先说出来、由调用方显式决定。
   */
  maxEmbedPerRun: 0,
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
  // 位置取 indexDirBase（配置给的是 ~/.dsh/code-index），没配就退回同一处。
  try {
    const markerDir = path.resolve(
      expandPath(config.indexDirBase) ?? (expandPath(config.indexDir) ?? path.join(os.homedir(), '.dsh', 'code-index')),
    )
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
          tools: ['code_index', 'code_search', 'code_index_status'],
          config: {
            indexDirBase: config.indexDirBase,
            roots: config.allowedRoots,
            embedding: { backend: config.embedding.backend, modelDir: expandPath(config.embedding.modelDir) ?? null },
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
        log: (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`),
      })
    }
    return embedderPromise
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
          const st = scanStatus(store, repoRoot, { windowLines: config.windowLines, maxFileBytes: config.maxFileBytes })
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
          opts: { windowLines: config.windowLines, maxFileBytes: config.maxFileBytes },
          embedder,
          budget: { maxEmbedPerRun: args.max_embed ?? config.maxEmbedPerRun, mode: args.mode ?? 'incremental' },
        })
        const lines = [
          `索引完成（${r.mode}）${repoRoot}`,
          `  扫描 ${r.scanned} 文件；变更 ${r.changed} / 删除 ${r.removed}；写入 ${r.chunksWritten} 块`,
          `  向量：${r.vectorsBefore} → ${r.vectorsAfter}（本轮补算 ${r.embedded}）`,
          `  ${r.embedNote}`,
          `  用时 ${(r.elapsedMs / 1000).toFixed(1)}s；库 ${dbPath}`,
        ]
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
        const r = await hybridSearch(store, embedder, args.query, {
          topK: args.top_k ?? config.defaultTopK,
          mode: args.mode ?? 'auto',
        })
        if (!r.results.length) {
          return textResult(
            { repoRoot, mode: r.mode, terms: r.terms, results: [] },
            `没有命中（通道 ${r.mode}，词项 ${r.terms.join(' / ') || '无'}）。${r.note}\n`
              + `建议：换更具体的标识符（类名/方法名/错误码），或先用 grep 找确切字符串。`,
          )
        }
        const lines = [`命中 ${r.results.length} 条（通道 ${r.mode}；词项 ${r.terms.join(' / ')}）`]
        if (r.note) lines.push(`  ${r.note}`)
        for (const hit of r.results) {
          lines.push(`\n[${hit.rank}] ${hit.path}:${hit.startLine}-${hit.endLine}  (fts ${hit.ftsRank ?? '-'} / vec ${hit.vecRank ?? '-'})`)
          lines.push(hit.snippet.split('\n').map((l) => '    ' + l).join('\n'))
        }
        return textResult({ repoRoot, mode: r.mode, terms: r.terms, results: r.results }, lines.join('\n'))
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
        ]
        let st = null
        if (args.scan !== false) {
          st = scanStatus(store, repoRoot, { windowLines: config.windowLines, maxFileBytes: config.maxFileBytes })
          lines.push(`  新鲜度：${st.stale ? `过期（${st.changed} 改 / ${st.removed} 删）` : '最新'}；候选文件 ${st.scanned}`)
        }
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

  ctx.logger?.info?.(
    `dsh-code-index ${BUILD} 已加载（roots=${config.allowedRoots.length || '任意'}，embedding=${config.embedding.backend}）`,
  )
  bootLog('tools-registered', { tools: ['code_index', 'code_search', 'code_index_status'] })
}
