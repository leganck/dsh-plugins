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
export const BUILD = '2026-10-15.1'
export const SCHEMA_VERSION = 1

const DEFAULTS = {
  /** 索引基目录：<base>/<仓库名>-<路径哈希>/index.db，每仓库一库且不落在代码仓库里 */
  indexDirBase: null,
  /** 单仓库模式：直接把 index.db 放这个目录（多仓库共用一库，慎用） */
  indexDir: null,
  roots: [],
  maxFileBytes: 2 * 1024 * 1024,
  windowLines: 40,
  embedding: { backend: 'auto', modelDir: null, threads: 6 },
  defaultTopK: 10,
  maxEmbedPerRun: 20000,
}

function normalizeConfig(raw = {}) {
  const cfg = {
    ...DEFAULTS,
    ...raw,
    embedding: { ...DEFAULTS.embedding, ...(raw.embedding ?? {}) },
  }
  if (typeof cfg.maxEmbedPerRun !== 'number' || cfg.maxEmbedPerRun < 1) cfg.maxEmbedPerRun = DEFAULTS.maxEmbedPerRun
  if (typeof cfg.defaultTopK !== 'number' || cfg.defaultTopK < 1) cfg.defaultTopK = DEFAULTS.defaultTopK
  cfg.allowedRoots = (cfg.roots ?? []).map((r) => path.resolve(String(r).replace(/^~(?=[\\/]|$)/, os.homedir())))
  return cfg
}

function expandPath(p) {
  if (typeof p !== 'string' || !p) return p
  return p.replace(/^~(?=[\\/]|$)/, os.homedir()).replace(/\$\{?DSH_HOME\}?/g, process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

const textResult = (value, text) => ({ content: [{ type: 'text', text }], structuredContent: value })
const fail = (message) => ({ content: [{ type: 'text', text: `错误：${message}` }] })

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const stores = new Map()
  let embedderPromise = null

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
  ctx.tools.register({
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
        max_embed: { type: 'integer', description: '本轮最多补算多少块的向量（默认 20000）。向量量大时可分多次跑。' },
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
        return textResult({ repoRoot, dbPath, ...r }, lines.join('\n'))
      } catch (e) {
        return fail(String(e.message))
      }
    },
  })

  // ---------------------------------------------------------------- code_search
  ctx.tools.register({
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
  ctx.tools.register({
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
        return textResult({ repoRoot, dbPath, stats: s, scan: st, embedder: embedder.ok ? { backend: embedder.backend, model: embedder.modelFile, cacheEntries: embedder.cacheEntries } : { ok: false, reason: embedder.reason } }, lines.join('\n'))
      } catch (e) {
        return fail(String(e.message))
      }
    },
  })

  ctx.logger?.info?.(
    `dsh-code-index ${BUILD} 已加载（roots=${config.allowedRoots.length || '任意'}，embedding=${config.embedding.backend}）`,
  )

  // 加载标记：与 memory-archive 同一套做法 —— 否则"插件到底加载没有"在运行中不可观测。
  // 位置取 indexDirBase（配置里给的是 ~/.dsh/code-index），没配就退回 ~/.dsh/code-index。
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
    ctx.logger?.warn?.(`dsh-code-index: 写加载标记失败：${String(e.message).slice(0, 120)}`)
  }
}
