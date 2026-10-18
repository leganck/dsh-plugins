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
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { Store } from './lib/store.js'
import { createEmbedder } from './lib/embedder.js'
import { createReranker, RERANK_TIERS, RERANK_MAX_TOKENS } from './lib/reranker.js'
import { createRemoteEmbedder, createRemoteReranker, createRemoteIndex, endpointsOf, describeStatus } from './lib/remote.js'
import { depsStatus, installDeps, repairDeps, removeDeps, pruneForeignPlatforms, defaultDepsDir, EMBED_PACKAGES, GROUP_NAMES, DEP_GROUPS } from './lib/deps.js'
import { isValidStrategy, strategyTable, resolveChunkConfig } from './lib/strategies.js'
import { search as hybridSearch, searchFusedRemote } from './lib/search.js'
import { buildIndex, scanStatus, indexDbPath, dropIndex } from './lib/indexer.js'
import { normalizeRelPrefix } from './lib/scan.js'
import { normalizeRemoteUrl, gitOriginUrl, repoIdOf } from './lib/repo.js'
import { renderParserHint } from './lib/parser-hints.js'

/** 0.10.0 remote-only：本地只保留 parser（切块）依赖组，embed 组不再安装 */
const PARSER_GROUPS = GROUP_NAMES.filter((g) => g.startsWith('parser'))

/** 行为变更时递增，写入索引 meta 便于判断库是新是老 */
export const BUILD = '2026-10-18.8'
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

const REMOTE_DEFAULTS = {
  url: null,
  timeoutMs: 8000,
  apiKey: null,
  /** 向量标签显式覆盖（服务端自述优先；旧服务端不会自述时才需要） */
  tag: null,
  /** 服务端没有 tag 时的兜底模型名 */
  model: null,
  fallbackLocal: true,
  /** ---- 以下只对 vectorStore: 'remote' 有意义 ---- */
  /** 血统标识覆盖（默认由 git origin URL 推导；fork/镜像想共用一份向量时用它或 lineage） */
  repoId: null,
  /** 命名空间覆盖（默认 `<repoId>@<切块指纹>`） */
  namespace: null,
  /** 显式指定服务端血统 id（fork / 镜像共用同一份向量时用） */
  lineage: null,
  /** 服务端嵌入限速（块/秒）；null = 用服务端默认 */
  rateLimit: null,
  /** 每批上传的正文条数 */
  uploadBatch: 256,
}

/**
 * 用户配置面（0.10.0，remote-only）：只保留 6 个键。
 * 其余由默认值推导；确需调整的放 advanced.*。
 * 本地模型/本地重排已移除：向量与重排都走远端，关键词检索用本地 FTS5（不需要模型）。
 */
const USER_DEFAULTS = {
  roots: [],
  remote: { url: null, apiKey: null },
  vectors: 'auto', // auto（有 remote.url 就用远端）| remote（强制，缺地址报错）| off（纯关键词）
  rerank: 'off', // off | fast | quality（远端）
  exclude: [], // 目录名，或含 "/" 的仓库相对路径前缀
  advanced: {
    indexDirBase: null,
    maxFileBytes: 2 * 1024 * 1024,
    windowLines: 40,
    depsDir: null, // parser 依赖的受管目录（嵌入式依赖已移除）
    chunking: { strategy: 'auto', byExt: {} },
    sync: { watch: false, debounceMs: 30000 },
    remoteTimeoutMs: 8000,
    remoteRateLimit: null,
  },
}
const USER_TOP_KEYS = Object.keys(USER_DEFAULTS)
const USER_REMOTE_KEYS = ['url', 'apiKey']
const USER_ADVANCED_KEYS = Object.keys(USER_DEFAULTS.advanced)

/** 0.10.0 移除的键 → 迁移提示（不要用一句"未知配置项"打发） */
const REMOVED_KEYS = {
  embedding: '本地模型已移除；用 vectors: remote|off',
  preset: '由 vectors 取代（remote|off）',
  vectorStore: '由 vectors 取代（remote|off）',
  rerankBackend: '重排固定走远端',
  rerankRemote: '复用 remote.url / remote.apiKey',
  rerankModelDir: '本地重排已移除',
  indexDirBase: '移到 advanced.indexDirBase',
  maxFileBytes: '移到 advanced.maxFileBytes',
  windowLines: '移到 advanced.windowLines',
  chunking: '移到 advanced.chunking',
  sync: '移到 advanced.sync',
  excludeDirs: '合并进 exclude（目录名）',
  excludePaths: '合并进 exclude（含 / 的仓库相对路径）',
  defaultTopK: '改用 code_search 的 top_k',
  maxEmbedPerRun: '改用 code_index 的 max_embed',
  indexDir: '改用 advanced.indexDirBase',
}

const DEFAULTS = {
  /** 索引基目录：<base>/<仓库名>-<路径哈希>/index.db，每仓库一库且不落在代码仓库里 */
  indexDirBase: null,
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
  embedding: {
    backend: 'auto',
    /**
     * **查询侧**单独指定后端（`null` = 跟 `backend` 一样）。
     *
     * 为什么要分开（本机实测，同一份 bge-base fp16、同一个标签）：
     *  - 建库是**长批**：DML 27.5 块/s vs CPU 3.4 块/s → 建库必须用 GPU
     *  - 查询是 **batch=1**：DML 每次调用有 ~45 ms 固定开销（提交+同步+回读），
     *    所以本机 40 行文本 DML 68 ms、CPU 40 ms → 查询反而 CPU 更快
     * 两者向量标签一致（同一模型文件），所以"建库用 GPU、查询用 CPU"是安全的，
     * 也是这台机器上不动任何远端就能拿到的最大收益。
     */
    queryBackend: null,
    modelDir: null,
    threads: 6,
    batch: null,
    cachePath: null,
    depsDir: null,
  },
  /**
   * 切块策略（表见 lib/strategies.js，对应 Cursor 的 `GetAvailableChunkingStrategies`）：
   *   `strategy`：`auto`（按扩展名查内置表）| `ast` | `heuristic` | `window`
   *   `byExt`：按扩展名覆盖内置表的字段，例如 `{ ".vue": { "strategy": "heuristic" } }`
   * 缺 parser 依赖、或某文件解析失败时会**降级**并在建库结果里报告原因，绝不静默换策略。
   */
  chunking: {
    strategy: 'auto',
    byExt: {},
    /** `auto`：检测到仓库里有用得上、但没装的语法就提示；`off`：静默 */
    parserHint: 'auto',
  },
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
  /**
   * 重排**在哪算**：`local`（默认，本机 ONNX）| `remote`（远端 HTTP）。
   * 与 `rerank` 分开的理由：`rerank` 是"开不开、候选多少"，这是"谁来算"，
   * 两个维度正交 —— 想从 quality 换成 fast、或从本机换到远端，互不牵连。
   */
  /**
   * **向量索引放哪**：`local`（默认，本机 SQLite）| `remote`（服务端持有索引）。
   *
   * remote 时本机只保留 BM25：块清单/正文推给服务端，kNN 与重排都在那边，
   * 查询时本地 BM25 + 远端 kNN 在客户端 RRF 融合 —— 服务端挂了只是语义召回消失。
   * 实测取舍见 README：建库速度本机更快（33 vs 26.8 块/s），但远端换来"多人共享 + 本机零重依赖"。
   */
  /**
   * 服务端地址与远端相关配置（0.9.0 起只接受顶层 `remote`，`embedding.remote` 已移除）。
   */
  remote: REMOTE_DEFAULTS,
  vectorStore: 'local',
  /**
   * **变更上报的触发方式**（默认关）。
   *
   * 主触发仍是 `code_index`（agent 驱动），上报用"仓库指纹 + 变更清单"，已经是增量的。
   * `watch: true` 时额外用 `fs.watch` 监听上次建过库的仓库：保存后静默聚合到
   * `debounceMs`，再在后台跑一次增量同步 —— 对应 Cursor 的 watcher + 周期性 doUpdate
   * （它默认 ≥60 s 且有自我抑制，这里同理：一次只跑一轮，跑的过程中不重入）。
   */
  sync: { watch: false, debounceMs: 30000 },
  rerankBackend: 'local',
  /** `rerankBackend: 'remote'` 时的远端地址与超时（与 remote 同构） */
  rerankRemote: { url: null, timeoutMs: 8000, apiKey: null, fallbackLocal: true },
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
const BACKENDS = ['auto', 'cpu', 'gpu', 'remote', 'off']
/** `code_search` 未显式给 top_k 时的默认返回条数（原 `defaultTopK` 配置项已并入工具参数） */
const DEFAULT_TOP_K = 10

/**
 * 把用户配置（6 个键 + advanced）翻译成内部规范形状。
 * 内部形状沿用历史字段名，避免改动下游 build/search/status 的大量代码。
 */
function userConfigToInternal(raw) {
  const userRemote = raw.remote ?? {}
  if (userRemote === null || typeof userRemote !== 'object' || Array.isArray(userRemote)) {
    throw new ConfigError(`config.remote 必须是对象，收到 ${Array.isArray(userRemote) ? 'array' : typeof userRemote}`)
  }
  const unknownRemote = Object.keys(userRemote).filter((k) => !USER_REMOTE_KEYS.includes(k))
  if (unknownRemote.length) {
    throw new ConfigError(`未知远端配置：${unknownRemote.map((k) => `remote.${k}`).join(', ')}；可用：remote.url, remote.apiKey`)
  }
  if (userRemote.url !== undefined && userRemote.url !== null && typeof userRemote.url !== 'string') {
    throw new ConfigError(`config.remote.url 必须是字符串或 null，收到 ${typeof userRemote.url}`)
  }
  if (userRemote.apiKey !== undefined && userRemote.apiKey !== null && typeof userRemote.apiKey !== 'string') {
    throw new ConfigError(`config.remote.apiKey 必须是字符串或 null，收到 ${typeof userRemote.apiKey}`)
  }

  const advRaw = raw.advanced ?? {}
  if (advRaw === null || typeof advRaw !== 'object' || Array.isArray(advRaw)) {
    throw new ConfigError(`config.advanced 必须是对象，收到 ${Array.isArray(advRaw) ? 'array' : typeof advRaw}`)
  }
  const unknownAdv = Object.keys(advRaw).filter((k) => !USER_ADVANCED_KEYS.includes(k))
  if (unknownAdv.length) {
    throw new ConfigError(`未知 advanced 配置：${unknownAdv.map((k) => `advanced.${k}`).join(', ')}；可用：advanced.${USER_ADVANCED_KEYS.join(', advanced.')}`)
  }
  const adv = {
    ...USER_DEFAULTS.advanced,
    ...advRaw,
    chunking: { ...USER_DEFAULTS.advanced.chunking, ...(advRaw.chunking ?? {}) },
    sync: { ...USER_DEFAULTS.advanced.sync, ...(advRaw.sync ?? {}) },
  }

  const requestedVectors = raw.vectors ?? 'auto'
  if (requestedVectors !== 'auto' && requestedVectors !== 'remote' && requestedVectors !== 'off') {
    throw new ConfigError(`config.vectors 必须是 'auto' / 'remote' / 'off'，收到 ${JSON.stringify(requestedVectors)}`)
  }
  const hasRemoteUrl = Boolean(String(userRemote.url ?? '').trim())
  // auto：有地址就走远端，没有就纯关键词；remote：强制远端（缺地址大声失败）
  const vectors = requestedVectors === 'off' ? 'off' : requestedVectors === 'remote' ? 'remote' : hasRemoteUrl ? 'remote' : 'off'
  if (requestedVectors === 'remote' && !hasRemoteUrl) {
    throw new ConfigError('config.vectors = remote 时必须给 remote.url（不想连远端就用 auto 或 off）')
  }
  const rerank = raw.rerank ?? 'off'

  const exclude = raw.exclude ?? []
  if (!Array.isArray(exclude)) {
    throw new ConfigError(`config.exclude 必须是字符串数组，收到 ${Array.isArray(exclude) ? 'array' : typeof exclude}`)
  }
  const excludeDirs = []
  const excludePaths = []
  for (const item of exclude) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new ConfigError(`config.exclude 的元素必须是非空字符串，收到 ${JSON.stringify(item)}`)
    }
    if (path.isAbsolute(item)) {
      throw new ConfigError(`config.exclude 只能是目录名或仓库相对路径，不能是绝对路径：${JSON.stringify(item)}`)
    }
    const rel = normalizeRelPrefix(item)
    if (rel.split('/').includes('..')) {
      throw new ConfigError(`config.exclude 不能包含 '..'：${JSON.stringify(item)}`)
    }
    if (/[\\/]/.test(item)) excludePaths.push(rel)
    else excludeDirs.push(item)
  }

  return {
    roots: raw.roots ?? [],
    vectors,
    vectorsMode: requestedVectors,
    indexDirBase: adv.indexDirBase,
    maxFileBytes: adv.maxFileBytes,
    windowLines: adv.windowLines,
    excludeDirs,
    excludePaths,
    chunking: adv.chunking,
    sync: adv.sync,
    embedding: { backend: 'off', depsDir: adv.depsDir },
    vectorStore: vectors === 'remote' ? 'remote' : 'local',
    rerank,
    rerankBackend: 'remote',
    rerankRemote: {
      url: userRemote.url ?? null,
      timeoutMs: adv.remoteTimeoutMs,
      apiKey: userRemote.apiKey ?? null,
      fallbackLocal: false,
    },
    remote: {
      url: userRemote.url ?? null,
      apiKey: userRemote.apiKey ?? null,
      timeoutMs: adv.remoteTimeoutMs,
      rateLimit: adv.remoteRateLimit,
      fallbackLocal: false,
    },
  }
}

function normalizeConfig(userRaw = {}) {
  if (userRaw === null || typeof userRaw !== 'object' || Array.isArray(userRaw)) {
    throw new ConfigError(`config 必须是对象，收到 ${Array.isArray(userRaw) ? 'array' : typeof userRaw}`)
  }
  const removed = Object.keys(userRaw).filter((k) => k in REMOVED_KEYS)
  if (removed.length) {
    throw new ConfigError(`配置项已移除：${removed.map((k) => `${k}（${REMOVED_KEYS[k]}）`).join('；')}`)
  }
  const unknownUser = Object.keys(userRaw).filter((k) => !USER_TOP_KEYS.includes(k))
  if (unknownUser.length) {
    throw new ConfigError(`未知配置项：${unknownUser.join(', ')}；可用：${USER_TOP_KEYS.join(', ')}`)
  }
  const raw = userConfigToInternal(userRaw)
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
  // 嵌套对象必须单独深合一层（浅合并会把默认值整块顶掉）
  cfg.remote = { ...REMOTE_DEFAULTS, ...(raw.remote ?? {}) }
  cfg.sync = { ...DEFAULTS.sync, ...(raw.sync ?? {}) }
  cfg.rerankRemote = { ...DEFAULTS.rerankRemote, ...(raw.rerankRemote ?? {}) }

  const intAtLeast1 = (value, key) => {
    if (!Number.isInteger(value) || value < 1) {
      throw new ConfigError(`config.${key} 必须是 >= 1 的整数，收到 ${JSON.stringify(value)}`)
    }
  }
  intAtLeast1(cfg.windowLines, 'windowLines')
  intAtLeast1(cfg.embedding.threads, 'embedding.threads')
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
  // 查询侧覆盖：null 表示跟 backend 走；给了就必须是已知后端
  if (cfg.embedding.queryBackend !== null && !BACKENDS.includes(cfg.embedding.queryBackend)) {
    throw new ConfigError(
      `config.embedding.queryBackend 必须是 null 或 ${BACKENDS.join(' | ')}，收到 ${JSON.stringify(cfg.embedding.queryBackend)}`,
    )
  }

  // ---- 远端推理（remote / rerankRemote）----
  // 这两块的错误信息必须**点名键路径**：远端配置错一个字段的表现是"一直降级成本机"，
  // 不点名就会让人以为是网络问题（本插件在 excludePaths 上就吃过这种亏）。
  const checkRemote = (block, label, allowedKeys) => {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      throw new ConfigError(`config.${label} 必须是对象，收到 ${Array.isArray(block) ? 'array' : typeof block}`)
    }
    const unknown = Object.keys(block).filter((k) => !allowedKeys.includes(k))
    if (unknown.length) {
      throw new ConfigError(`未知配置项：${unknown.map((k) => `${label}.${k}`).join(', ')}；可用：${allowedKeys.map((k) => `${label}.${k}`).join(', ')}`)
    }
    if (block.url !== null && typeof block.url !== 'string') {
      throw new ConfigError(`config.${label}.url 必须是字符串或 null，收到 ${typeof block.url}`)
    }
    if (typeof block.url === 'string' && block.url.trim()) {
      try {
        endpointsOf(block.url)
      } catch (e) {
        throw new ConfigError(`config.${label}.url 不可用：${e.message}`)
      }
    }
    if (!Number.isInteger(block.timeoutMs) || block.timeoutMs < 100) {
      // 用户面只有一个超时开关 advanced.remoteTimeoutMs（remote / rerankRemote 都由它映射）
      throw new ConfigError(`config.advanced.remoteTimeoutMs 必须是 >= 100 的整数（毫秒），收到 ${JSON.stringify(block.timeoutMs)}`)
    }
    if (block.apiKey !== null && typeof block.apiKey !== 'string') {
      throw new ConfigError(`config.${label}.apiKey 必须是字符串或 null，收到 ${typeof block.apiKey}`)
    }
    if (typeof block.fallbackLocal !== 'boolean') {
      throw new ConfigError(`config.${label}.fallbackLocal 必须是 true/false，收到 ${JSON.stringify(block.fallbackLocal)}`)
    }
    for (const key of ['tag', 'model']) {
      if (key in block && block[key] !== null && typeof block[key] !== 'string') {
        throw new ConfigError(`config.${label}.${key} 必须是字符串或 null，收到 ${typeof block[key]}`)
      }
    }
  }
  checkRemote(cfg.remote, 'remote', Object.keys(REMOTE_DEFAULTS))
  checkRemote(cfg.rerankRemote, 'rerankRemote', Object.keys(DEFAULTS.rerankRemote))
  // 0.8.0 新增字段的类型校验（checkRemote 只覆盖通用字段）
  if (cfg.remote.repoId !== null && typeof cfg.remote.repoId !== 'string') {
    throw new ConfigError(`config.remote.repoId 必须是字符串或 null，收到 ${typeof cfg.remote.repoId}`)
  }
  if (cfg.remote.namespace !== null && typeof cfg.remote.namespace !== 'string') {
    throw new ConfigError(`config.remote.namespace 必须是字符串或 null，收到 ${typeof cfg.remote.namespace}`)
  }
  if (cfg.remote.lineage !== null && typeof cfg.remote.lineage !== 'string') {
    throw new ConfigError(`config.remote.lineage 必须是字符串或 null，收到 ${typeof cfg.remote.lineage}`)
  }
  if (cfg.remote.rateLimit !== null && (typeof cfg.remote.rateLimit !== 'number' || !(cfg.remote.rateLimit >= 0))) {
    throw new ConfigError(`config.remote.rateLimit 必须是 >= 0 的数字或 null，收到 ${JSON.stringify(cfg.remote.rateLimit)}`)
  }
  if (!Number.isInteger(cfg.remote.uploadBatch) || cfg.remote.uploadBatch < 1) {
    throw new ConfigError(`config.remote.uploadBatch 必须是 >= 1 的整数，收到 ${JSON.stringify(cfg.remote.uploadBatch)}`)
  }
  if (typeof cfg.sync.watch !== 'boolean') {
    throw new ConfigError(`config.sync.watch 必须是 true/false，收到 ${JSON.stringify(cfg.sync.watch)}`)
  }
  if (!Number.isInteger(cfg.sync.debounceMs) || cfg.sync.debounceMs < 1000) {
    throw new ConfigError(`config.sync.debounceMs 必须是 >= 1000 的整数（毫秒），收到 ${JSON.stringify(cfg.sync.debounceMs)}`)
  }
  // 0.10.0：vectorStore 由 vectors 推导（remote|local），不再暴露给用户
  if (cfg.vectors === 'remote' && !String(cfg.remote.url ?? '').trim()) {
    throw new ConfigError('config.vectors = remote 时必须给 remote.url（服务端地址）')
  }
  if (cfg.rerank !== 'off' && cfg.vectors !== 'remote') {
    throw new ConfigError('config.rerank 需要 vectors: remote（纯关键词模式没有候选集可重排）')
  }
  if (cfg.rerank !== 'off' && !String(cfg.rerankRemote.url ?? '').trim()) {
    throw new ConfigError('config.rerank 需要 remote.url（重排与向量共用同一个服务地址）')
  }
  cfg.allowedRoots = cfg.roots.map((r) => path.resolve(String(r).replace(/^~(?=[\\/]|$)/, os.homedir())))
  return cfg
}

function expandPath(p) {
  if (typeof p !== 'string' || !p) return p
  return p.replace(/^~(?=[\\/]|$)/, os.homedir()).replace(/\$\{?DSH_HOME\}?/g, process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}



/**
 * 把 `current_file` 解析成 `{ rel, excerpt, dirPrefix }`。
 *
 * 只接受**仓库内真实存在**的文件：超出仓库、不存在、太大都返回 null ——
 * 锚定是可选增强，任何异常都不该让整次搜索失败（这条与"远端挂了只丢语义召回"同一原则）。
 */
function resolveCurrentFile(repoRoot, file) {
  if (!file) return null
  try {
    const abs = path.resolve(repoRoot, expandPath(file))
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > 1024 * 1024) return null
    const excerpt = fs.readFileSync(abs, 'utf8').split('\n').slice(0, 120).join('\n').slice(0, 6000)
    const dir = path.posix.dirname(rel)
    return { rel, excerpt, dirPrefix: dir === '.' ? null : `${dir}/` }
  } catch {
    return null
  }
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
          tools: ['code_index', 'code_search', 'code_map', 'code_index_status', 'code_index_deps'],
          config: {
            vectors: config.vectors,
            vectorsMode: config.vectorsMode,
            indexDirBase: config.indexDirBase,
            roots: config.allowedRoots,
            // 远端只记**地址与开关**，绝不记 apiKey（标记文件是明文的，会被归档/分享）
            remote:
              config.vectors === 'remote'
                ? { url: config.remote.url, timeoutMs: config.remote.timeoutMs, rateLimit: config.remote.rateLimit, apiKeySet: Boolean(config.remote.apiKey) }
                : null,
            rerank: {
              tier: config.rerank,
              remote: config.rerank !== 'off' ? { url: config.rerankRemote.url, apiKeySet: Boolean(config.rerankRemote.apiKey) } : null,
            },
            chunking: { strategy: config.chunking?.strategy ?? 'auto', byExt: Object.keys(config.chunking?.byExt ?? {}) },
            // 扫描范围与预算也要记：否则"加载时到底排除了哪些目录"无法回答 ——
            // 这个坑真的踩过：profile 的 config 覆盖条目**替换整份 config**，
            // 写漏了不会报错、只是静默失效，而标记里看不到就没法确认。
            scan: {
              excludeDirs: config.excludeDirs ?? [],
              excludePaths: config.excludePaths ?? [],
              maxFileBytes: config.maxFileBytes,
              windowLines: config.windowLines,
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

  // ---- 远端可用性闸门（自动切换）----
  // 连不上一次后，60 秒内不再尝试：否则服务端关机时**每次查询都要先等满 8 s 超时**，
  // 关键词检索明明本地就有，却被人为拖慢。冷却期过后自动重试，不需要重启插件。
  const REMOTE_COOLDOWN_MS = 60_000
  let remoteDownUntil = 0
  let remoteDownReason = ''
  const remoteGateOpen = () => Date.now() >= remoteDownUntil
  const markRemoteDown = (e) => {
    remoteDownUntil = Date.now() + REMOTE_COOLDOWN_MS
    remoteDownReason = String(e?.message ?? e).slice(0, 160)
  }
  const markRemoteUp = () => {
    remoteDownUntil = 0
    remoteDownReason = ''
  }
  const remoteCooldownNote = () => {
    const left = Math.max(0, Math.ceil((remoteDownUntil - Date.now()) / 1000))
    return `远端暂时不可用（${remoteDownReason || '连接失败'}），${left}s 内跳过重试、先用纯关键词；冷却后自动恢复`
  }

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
    const dbPath = indexDbPath(repoRoot, { indexDirBase: config.indexDirBase })
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

  /**
   * 本机嵌入器（**懒加载 + 按后端记忆化**）：远端模式下它同时充当"标签一致的兜底"，
   * 所以必须只建一次 —— 每次回退都重新建会话，等于把 GPU 反复烧一遍。
   *
   * 键是**具体后端**（cpu/gpu/auto/...）而不是"本机"：查询侧可能被单独指定成 cpu
   * （实测本机 batch=1 查询 CPU 比 DML 快 1.7×），这时会并存两个本机实例，
   * 它们共享同一个模型文件 → 同一个向量标签 → 索引里的向量对两边都有效。
   */
  const localEmbedders = new Map()
  const localEmbedder = (backend) => {
    const key = backend === 'remote' ? 'auto' : backend
    if (!localEmbedders.has(key)) {
      localEmbedders.set(
        key,
        createEmbedder({
          modelDir: expandPath(config.embedding.modelDir) ?? undefined,
          backend: key,
          threads: config.embedding.threads,
          batch: config.embedding.batch,
          cachePath: expandPath(config.embedding.cachePath) ?? undefined,
          // 依赖按需安装在受管目录；插件自身目录作为兜底（兼容把依赖装在包内的旧形态）
          depsDir: expandPath(config.embedding.depsDir) ?? undefined,
          depsFallbackDirs: [PLUGIN_DIR],
          // 让嵌入器优先用**随包提供的模型**（<插件目录>/model）→ 装上即用，不必另下 194 MB
          pluginDir: PLUGIN_DIR,
          log: (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`),
        }),
      )
    }
    return localEmbedders.get(key)
  }

  /** 某个用途（建库 / 查询）实际该用哪个后端 */
  const backendFor = (kind) =>
    (kind === 'query' ? config.embedding.queryBackend : null) ?? config.embedding.backend

  /** 建库/索引侧嵌入器；`getQueryEmbedder()` 是查询侧（默认同一个实例） */
  async function embedderFor(kind) {
    const backend = backendFor(kind)
    if (backend === 'off') {
      return { ok: false, reason: `配置 embedding.${kind === 'query' ? 'queryBackend' : 'backend'} = off` }
    }
    if (!embedderCache.has(kind)) {
      let p
      if (backend === 'remote') {
        const rem = config.remote
        p = createRemoteEmbedder({
          url: rem.url,
          timeoutMs: rem.timeoutMs,
          apiKey: rem.apiKey,
          tag: rem.tag,
          model: rem.model ?? undefined,
          fallbackLocal: rem.fallbackLocal,
          // 只有允许回退时才把本机嵌入器交出去（否则远端失败就是失败，别偷偷换模型）
          localFactory: rem.fallbackLocal ? () => localEmbedder('auto') : null,
          cachePath: expandPath(config.embedding.cachePath) ?? undefined,
          log: (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`),
        })
      } else {
        p = localEmbedder(backend)
      }
      embedderCache.set(kind, p)
    }
    return embedderCache.get(kind)
  }
  const embedderCache = new Map()
  const getEmbedder = () => embedderFor('index')
  const getQueryEmbedder = () => embedderFor('query')

  /**
   * 远端索引客户端（`vectorStore: 'remote'`）：懒创建、全插件共用一个。
   * 与 `embedding.backend='remote'` 是两件事：
   *   - backend=remote：只把"算向量"借出去，索引仍在本机；
   *   - vectorStore=remote：索引本身在服务端（本机只留 BM25）。
   */
  let remoteIndexPromise = null
  const getRemoteIndex = () => {
    if (!remoteIndexPromise) {
      remoteIndexPromise = createRemoteIndex({
        url: config.remote.url,
        timeoutMs: config.remote.timeoutMs,
        apiKey: config.remote.apiKey,
        log: (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`),
      })
    }
    return remoteIndexPromise
  }
  /** 命名空间 = 血统 + 切块指纹（切块配置不同就换空间，避免两端 (path,start) 互相覆盖） */
  const namespaceFor = (repoRoot, store) =>
    config.remote.namespace || `${repoIdOf(repoRoot, config.remote.repoId)}@${store.getMeta('chunk_fingerprint') ?? 'default'}`

  /**
   * 重排器（**懒加载**）：只在配置开启且真的用到时才建会话（531 MB 模型 + DML 会话不该在启动时付）。
   * 失败不抛错 —— 返回 {ok:false, reason}，由 search 走"不重排"的分支并把原因写进结果。
   */
  let rerankerPromise = null
  let localRerankerPromise = null
  const localReranker = () => {
    if (!localRerankerPromise) {
      localRerankerPromise = createReranker({
        modelDir: expandPath(config.rerankModelDir) ?? undefined,
        backend: config.embedding.backend === 'cpu' ? 'cpu' : 'auto',
        threads: config.embedding.threads,
        depsDir: expandPath(config.embedding.depsDir) ?? undefined,
        depsFallbackDirs: [PLUGIN_DIR],
        log: (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`),
      })
    }
    return localRerankerPromise
  }
  async function getReranker() {
    if (config.rerank === 'off') return { ok: false, reason: '配置 rerank = off' }
    if (!rerankerPromise) {
      if (config.rerankBackend === 'remote') {
        const rem = config.rerankRemote
        rerankerPromise = createRemoteReranker({
          url: rem.url,
          timeoutMs: rem.timeoutMs,
          apiKey: rem.apiKey,
          maxTokens: RERANK_MAX_TOKENS,
          fallbackLocal: rem.fallbackLocal,
          localFactory: rem.fallbackLocal ? localReranker : null,
          log: (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`),
        })
      } else {
        rerankerPromise = localReranker()
      }
    }
    return rerankerPromise
  }

  // ---------------------------------------------------------------- code_index
  const codeIndexTool = {
    name: 'code_index',
    description:
      '建立或增量刷新某个代码仓库的检索索引（本地 SQLite FTS5 全文 + 可选远端向量）。首次较慢（向量部分由服务端按仓库大小计算），之后只处理变化的文件，通常秒级。'
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
            '本轮最多让服务端补算多少块的向量。**默认 0 = 不补算**，建库只做全文索引（秒级）。要启用语义检索就显式给一个正整数（建议按服务端算力分批跑，可续算）。',
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

        const remoteMode = config.vectorStore === 'remote'
        // 0.10.0 remote-only：本地不再计算向量。vectors=off 时退化为纯关键词（本地 FTS5）。
        const embedder = null
        const keywordOnly = !remoteMode
        const keywordReason = ''
        const r = await buildIndex({
          store,
          repoRoot,
          opts: scanOptsOf(config),
          embedder,
          budget: { maxEmbedPerRun: args.max_embed ?? 0, mode: args.mode ?? 'incremental' },
          // **只放真正影响切块的字段**：`parserHint` 这类展示用配置一旦混进来，
          // 切块指纹会跟着变 → 命名空间莫名换新（实测踩到：energy 因此白换了一次）。
          chunking: {
            strategy: config.chunking.strategy,
            byExt: config.chunking.byExt,
            windowLines: config.windowLines,
          },
          depsDir: expandPath(config.embedding.depsDir) ?? undefined,
          depsFallbackDirs: [PLUGIN_DIR],
          remote: remoteMode
            ? {
                client: getRemoteIndex(),
                repoId: repoIdOf(repoRoot, config.remote.repoId),
                url: gitOriginUrl(repoRoot),
                lineage: config.remote.lineage,
                rateLimit: config.remote.rateLimit,
                uploadBatch: config.remote.uploadBatch,
              }
            : null,
        })
        if (remoteMode) {
          // 远端是否真的可达，以本轮同步结果为准：失败进入冷却，成功则解除
          if (r.remoteError) markRemoteDown(new Error(r.remoteError))
          else markRemoteUp()
        }
        const lines = [
          `索引完成（${r.mode}）${repoRoot}`,
          `  扫描 ${r.scanned} 文件；变更 ${r.changed} / 删除 ${r.removed}；写入 ${r.chunksWritten} 块`,
          `  切块策略：${Object.entries(r.strategies ?? {}).map(([s, n]) => `${s} ${n} 文件`).join('；') || '（本轮无变更文件）'}`,
          ...(config.chunking?.parserHint === 'off' || !r.parserMissing?.length
            ? []
            : renderParserHint(r.parserMissing, {
                totalFiles: r.scannedFiles ?? r.scanned,
                vectorStore: config.vectorStore,
                embeddings: !keywordOnly,
              })),
          // 没有嵌入能力时（未配置 / 缺依赖 / 缺模型 / 后端 off）默认就走关键词：
          // **这不是故障，是默认形态** —— 不要拿"缺 onnxruntime、缺模型"刷屏。
          keywordOnly
            ? `  模式：纯关键词（关键词检索；本机未启用嵌入${keywordReason}）`
            : remoteMode
              ? `  向量位置：远端 ${config.remote.url}（命名空间 ${r.remote?.namespace ?? '-'}）`
              : `  向量：${r.vectorsBefore} → ${r.vectorsAfter}（本轮补算 ${r.embedded}）`,
          keywordOnly ? null : `  ${r.embedNote}`,
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
        // 上面已有一行「模式：纯关键词」，这里不重复报（缺依赖/缺模型是默认形态，不是故障）
        else if (!remoteMode && r.stats.vectors < r.stats.chunks) {
          // 让"向量没补完"显式可见：8227 块 / 0 向量这种人眼容易划过去，
          // 而它直接决定语义召回是否存在（实测曾有会话因此以为配置关了向量）
          lines.push(
            keywordOnly || r.stats.vectors === 0 ? '' : `  ⚠️ 向量不完整：${r.stats.vectors}/${r.stats.chunks} 块有向量 —— 语义召回只覆盖一部分；传 max_embed 再跑一次可续算`,
          )
        }
        ensureWatch(repoRoot)
        return textResult({ repoRoot, dbPath, ...r }, lines.filter((l) => l !== null).join('\n'))
      } catch (e) {
        return fail(String(e.message))
      }
    },
  }
  registerTool(codeIndexTool)

  // ---------------------------------------------------------------- 文件变更监听（sync.watch）
  // 与 Cursor 的对应关系：它用 watcher 标记 + 周期性 doUpdate（≥60 s、有自我抑制），
  // 我们同样是"防抖聚合 + 跑的时候不重入"，区别是默认**关**：主触发仍是显式 code_index。
  const watchers = new Map()
  const WATCH_IGNORE = /(^|\/)(\.git|node_modules|dist|target|build|\.dsh-index|__pycache__)(\/|$)/
  async function runWatchSync(repoRoot, entry) {
    if (entry.running) return
    entry.running = true
    const t0 = Date.now()
    try {
      const r = await codeIndexTool.execute({ path: repoRoot }, {})
      const head = (r?.content?.[0]?.text ?? '').split('\n').find((l) => l.startsWith('索引完成'))
      ctx.logger?.info?.(`dsh-code-index: 自动同步完成（${Date.now() - t0} ms）${head ? '：' + head : ''}`)
    } catch (e) {
      ctx.logger?.warn?.(`dsh-code-index: 自动同步失败：${String(e?.message ?? e).slice(0, 160)}`)
    } finally {
      entry.running = false
    }
  }
  function ensureWatch(repoRoot) {
    if (!config.sync.watch || watchers.has(repoRoot)) return
    const entry = { watcher: null, timer: null, running: false }
    try {
      entry.watcher = fs.watch(repoRoot, { recursive: true }, (_evt, filename) => {
        if (!filename) return
        const rel = String(filename).replace(/\\/g, '/')
        if (WATCH_IGNORE.test(rel)) return
        if (entry.timer) return // 防抖窗口内的后续事件合并掉
        entry.timer = setTimeout(() => {
          entry.timer = null
          void runWatchSync(repoRoot, entry)
        }, config.sync.debounceMs)
        entry.timer.unref?.()
      })
      entry.watcher.on?.('error', (e) => ctx.logger?.warn?.(`dsh-code-index: watcher 出错：${e?.message}`))
    } catch (e) {
      ctx.logger?.warn?.(`dsh-code-index: 无法监听 ${repoRoot}：${e?.message}`)
      return
    }
    watchers.set(repoRoot, entry)
    ctx.logger?.info?.(`dsh-code-index: 已监听 ${repoRoot}（防抖 ${config.sync.debounceMs} ms）`)
  }
  ctx.effect(
    () => () => {
      for (const entry of watchers.values()) {
        try {
          entry.watcher?.close()
        } catch {
          /* 已关闭 */
        }
        if (entry.timer) clearTimeout(entry.timer)
      }
      watchers.clear()
    },
    'dsh-code-index: watchers',
  )

  // ---------------------------------------------------------------- code_search
  registerTool({
    name: 'code_search',
    description:
      '在本仓库的代码索引里做混合检索（本地关键词 BM25 + 远端语义向量，RRF 融合），返回排好序的「文件:行 + 片段」。'
      + '第一次查询前需要先跑 code_index。适合“XX 逻辑在哪实现 / 哪个文件处理了 YY”这类问题；'
      + '查找确切字符串（日志、错误码原文）用 grep 更快。vectors=off 时退化为纯关键词。',
    isConcurrencySafe: () => true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言问题或关键词组合。' },
        path: { type: 'string', description: '仓库根目录。省略则用当前会话工作目录。' },
        top_k: { type: 'integer', description: '返回条数，默认 10。' },
        mode: { type: 'string', enum: ['auto', 'fts', 'vector'], description: '检索通道，默认 auto（混合）。' },
        current_file: {
          type: 'string',
          description:
            '正在编辑的文件（仓库内相对路径或绝对路径）。给了它就做「当前文件锚定」：'
            + '文件前 120 行的片段一起参与查询向量，结果默认排除该文件本身、同目录候选加一点权重。'
            + '适合“在这个文件附近，还有哪儿是类似实现”。',
        },
        exclude_current: { type: 'boolean', description: '给了 current_file 时是否排除该文件自身，默认 true。' },
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
        const tier = RERANK_TIERS[config.rerank]
        // 「当前文件锚定」（对应 Cursor 请求里的 CurrentFileInfo）：
        // 片段参与查询向量 + 默认排除自身 + 同目录加权。cf 为 null 时三个参数都不生效。
        const cf = resolveCurrentFile(repoRoot, args.current_file)
        const embedText = cf ? `${args.query}\n\n[当前文件 ${cf.rel}]\n${cf.excerpt}` : null
        const excludePaths = cf && (args.exclude_current ?? true) ? [cf.rel] : []
        const boostPrefix = cf?.dirPrefix ?? null
        let r
        if (config.vectorStore === 'remote') {
          // 远端索引模式：本地 BM25 + 远端 kNN（可选远端重排）→ 客户端 RRF 融合。
          // 远端失败**只丢语义召回**，绝不抛错 —— 这条是硬规则，有测试钉住。
          const namespace = namespaceFor(repoRoot, store)
          const remoteRerank = tier && config.rerankBackend === 'remote' ? tier.candidates : 0
          let remoteHits = []
          let remoteMeta = null
          let remoteError = null
          const t0 = Date.now()
          if (!remoteGateOpen()) {
            // 冷却期内直接跳过：省掉必然超时的等待
            remoteError = remoteCooldownNote()
          } else try {
            const res = await getRemoteIndex().search(namespace, args.query, {
              k: 40,
              rerankCandidates: remoteRerank,
              embedText,
            })
            remoteHits = (res.hits ?? []).map((h) => ({ hash: h.hash, score: h.score, rerankScore: h.rerankScore }))
            remoteMeta = {
              namespace,
              ms: res.ms ?? null,
              coverage: res.coverage ?? null,
              elapsedMs: Date.now() - t0,
              rerank: remoteRerank
                ? {
                    applied: (res.hits ?? []).some((h) => h.rerankScore !== undefined),
                    candidates: remoteRerank,
                    where: 'remote',
                    ms: res.ms?.rerank ?? null,
                  }
                : null,
              reason: res.reason ?? null,
            }
            markRemoteUp()
          } catch (e) {
            remoteError = String(e?.message ?? e).slice(0, 200)
            markRemoteDown(e)
          }
          const localReranker = tier && config.rerankBackend === 'local' ? await getReranker() : null
          r = await searchFusedRemote(store, args.query, {
            topK: args.top_k ?? DEFAULT_TOP_K,
            remoteHits,
            remoteMeta,
            reranker: localReranker,
            rerankCandidates: tier?.candidates ?? 0,
            excludePaths,
            boostPrefix,
          })
          if (remoteError) r.note = [r.note, `远端不可用，已退化为纯关键词：${remoteError}`].filter(Boolean).join('；')
        } else {
          // vectors=off：纯关键词（本地 FTS5），不需要任何模型
          const embedder = null
          const reranker = await getReranker()
          r = await hybridSearch(store, embedder, args.query, {
            topK: args.top_k ?? DEFAULT_TOP_K,
            mode: args.mode ?? 'auto',
            reranker: tier ? reranker : null,
            rerankCandidates: tier?.candidates ?? 0,
            embedText,
            excludePaths,
            boostPrefix,
          })
        }
        // 纯关键词模式下的 note 必然是「向量通道未启用」这类说明 —— 那是设计如此，不是故障。
        // 远端模式的降级 note 必须保留（否则"服务端挂了"会被悄悄吞掉）。
        if (config.vectorStore !== 'remote') r.note = ''
        if (!r.results.length) {
          return textResult(
            { repoRoot, mode: r.mode, terms: r.terms, results: [], rerank: r.rerank },
            `没有命中（通道 ${r.mode}，词项 ${r.terms.join(' / ') || '无'}）。${r.note}\n`
              + `建议：换更具体的标识符（类名/方法名/错误码），或先用 grep 找确切字符串。`,
          )
        }
        const lines = [`命中 ${r.results.length} 条（通道 ${r.mode}；词项 ${r.terms.join(' / ')}）`]
        if (cf) {
          const ex = r.boosted ? `，同目录 ${r.boosted} 条加权` : ''
          const keepSelf = (args.exclude_current ?? true) ? '已排除自身' : '保留自身'
          lines.push(`  当前文件锚定：${cf.rel}（${cf.excerpt.split('\n').length} 行片段参与查询向量；${keepSelf}${ex}）`)
        }
        if (r.note) lines.push(`  ${r.note}`)
        // 重排状态必须显式报告：开了没生效（缺模型/降级）与"本来就没开"是两件事，
        // 不写清楚就会让人以为在享受重排的收益。
        if (r.rerank?.applied) {
          const where = r.rerank.where ? `，${r.rerank.where}` : ''
          const model = r.rerank.modelFile ? `，${r.rerank.backend}/${r.rerank.modelFile}` : ''
          lines.push(`  重排：${config.rerank}（${r.rerank.candidates} 个候选，${r.rerank.ms} ms${model}${where}）`)
        } else if (r.rerank) {
          lines.push(`  重排未生效：${r.rerank.reason ?? '未知原因'}`)
        }
        if (r.remote?.ms) {
          const m = r.remote.ms
          lines.push(`  远端耗时：embed ${m.embed ?? '-'} ms / kNN ${m.knn ?? '-'} ms / rerank ${m.rerank ?? '-'} ms（往返 ${r.remote.elapsedMs ?? '-'} ms）`)
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
        const remoteMode = config.vectorStore === 'remote'
        // 0.10.0 remote-only：vectors=off 就是纯关键词（本地 FTS5），不涉及任何模型
        const keywordOnly = !remoteMode
        const lines = [
          `索引：${repoRoot}`,
          `  库文件 ${dbPath}（${(s.dbBytes / 1048576).toFixed(1)} MB）`,
          `  覆盖 ${s.files} 文件 / ${s.chunks} 块`,
          `  最后建库：${store.getMeta('last_build_at') ? new Date(Number(store.getMeta('last_build_at'))).toLocaleString() : '从未'}`,
          remoteMode
            ? store.stats().chunks === 0
              ? `  向量位置：远端 ${config.remote.url}（本机只保留 BM25；命名空间在建库后由切块指纹确定）`
              : `  向量位置：远端 ${config.remote.url}（命名空间 ${namespaceFor(repoRoot, store)}；本机只保留 BM25）`
            : `  模式：纯关键词（本地 FTS5；vectors=${config.vectorsMode}${config.vectorsMode === 'auto' ? ' → 未配 remote.url' : ''}）`,
        ]
        if (remoteMode) {
          // 远端状态是"索引到底建了多少"的唯一真相来源：本地只知道清单，不知道向量进度。
          // 但**本机还没建库时命名空间是 `@default`（没有 chunkFp）**，去问服务端必然 404 ——
          // 那不是"远端坏了"，而是"还没开始"。直接给出下一步，别报错吓人。
          if (store.stats().chunks === 0) {
            lines.push('  远端索引：本机尚未建库（先跑 code_index，命名空间由切块配置的指纹决定）')
          } else if (!remoteGateOpen()) {
            lines.push(`  ${remoteCooldownNote()}`)
          } else try {
            const rs = await getRemoteIndex().status(namespaceFor(repoRoot, store))
            markRemoteUp()
            lines.push(
              `  远端索引：revision ${rs.revision}；${rs.chunks} 块 / ${rs.vectors} 向量（覆盖 ${((rs.coverage ?? 0) * 100).toFixed(0)}%）；待嵌 ${rs.pending ?? '?'}`,
              `  远端嵌入：${rs.paused ? '已暂停' : '运行中'}（${rs.rate} 块/s）；血统占用 ${((rs.totalBytes ?? 0) / 1048576).toFixed(0)} MB（向量上限 ${rs.limits?.maxVectorsPerLineage ?? '-'} / 血统）`,
            )
            if (rs.repoId) lines.push(`  血统：${rs.repoId}（追踪的远端：${normalizeRemoteUrl(gitOriginUrl(repoRoot)) || '无 git（本机血统）'}）`)
          } catch (e) {
            markRemoteDown(e)
            lines.push(`  ⚠️ 远端不可用：${String(e?.message ?? e).slice(0, 160)}（${Math.ceil(REMOTE_COOLDOWN_MS / 1000)}s 内跳过重试）`)
          }
        }
        let st = null
        if (args.scan !== false) {
          st = scanStatus(store, repoRoot, scanOptsOf(config))
          lines.push(`  新鲜度：${st.stale ? `过期（${st.changed} 改 / ${st.removed} 删）` : '最新'}；候选文件 ${st.scanned}`)
        }
        // 重排状态：只报"配置值"，不在这里连接远端
        if (RERANK_TIERS[config.rerank]) {
          lines.push(
            `  重排：${config.rerank}（候选 ${RERANK_TIERS[config.rerank].candidates} 个，远端 ${config.rerankRemote.url}，不降级到本机）`,
          )
        } else {
          lines.push('  重排：off')
        }
        // 排除规则要可见：用户改完配置最需要确认的就是"到底排掉了没有"
        const excl = [...config.excludePaths.map((p) => `路径 ${normalizeRelPrefix(p)}`), ...config.excludeDirs.map((d) => `目录名 ${d}`)]
        if (excl.length) lines.push(`  已排除：${excl.join('、')}（另有内置 ${'node_modules/build/.git 等'}）`)
        return textResult(
          {
            repoRoot,
            dbPath,
            stats: s,
            scan: st,
            vectors: config.vectorStore,
          },
          lines.join('\n'),
        )
      } catch (e) {
        return fail(String(e.message))
      }
    },
  })

  // ---------------------------------------------------------------- code_map
  registerTool({
    name: 'code_map',
    description:
      '仓库的**目录地图**：每个目录多少文件、什么语言为主、多少块、有哪些代表符号（函数/类）。'
      + '冷启动或不知道代码在哪时先用它定位目录，再针对性 code_search，省一次盲搜来回。'
      + '只读本地索引，不做模型推理。需要先跑过 code_index。',
    isConcurrencySafe: () => true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库根目录。省略则用当前会话工作目录。' },
        depth: { type: 'integer', description: '目录层级，默认 2（如 platform/win32/）。' },
        limit: { type: 'integer', description: '最多列多少个目录，默认 24，按块数排序。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v.content?.[0]?.text ?? '' }] },
    async execute(args, exec) {
      try {
        const repoRoot = path.resolve(expandPath(args.path) ?? sessionCwd(exec))
        assertAllowed(repoRoot)
        const { store } = storeFor(repoRoot)
        const s = store.stats()
        if (s.files === 0) {
          return fail(`该目录还没有索引：${repoRoot}\n先运行 code_index（path=${repoRoot}）。`)
        }
        const depth = Math.max(1, Math.min(6, args.depth ?? 2))
        const dirs = store.dirMap({ depth, dirs: Math.max(1, Math.min(200, args.limit ?? 24)) })
        const lines = [`目录地图：${repoRoot}（${s.files} 文件 / ${s.chunks} 块，深度 ${depth}）`]
        for (const d of dirs) {
          const exts = d.exts.map(([e, n]) => `${e}×${n}`).join(' ')
          lines.push(`  ${d.dir.padEnd(24)} ${String(d.files).padStart(4)} 文件 · ${String(d.chunks).padStart(5)} 块 · ${exts}`)
          if (d.top.length) {
            lines.push(`      ${d.top.map((t) => `${t.symbol ? t.symbol + ' ' : ''}${t.path}`).join(' | ')}`)
          }
        }
        return textResult({ repoRoot, depth, dirs, files: s.files, chunks: s.chunks }, lines.join('\n'))
      } catch (e) {
        return fail(String(e.message))
      }
    },
  })


  registerTool({
    name: 'code_index_deps',
    description:
      '管理**可选的语法解析依赖**（tree-sitter + 各语言语法，约 41 MB；不随插件安装）。'
      + '不装也能用：切块会降级为 heuristic/window；装了 `code_index` 才会按 AST 切块。'
      + 'action：status（默认，只看状态）/ install（下载安装；用 --ignore-scripts，**不执行任何依赖脚本**）/ '
      + 'prune（修剪非本平台的二进制）/ repair（删掉重装）/ remove（删除）。'
      + '只安装到插件自管的受管目录，不改 profile、不改 package.json。install/repair 需要网络，可能耗时数分钟。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'prune', 'repair', 'remove'], description: '默认 status。' },
        group: {
          type: 'string',
          enum: [...PARSER_GROUPS, 'all'],
          description: `依赖组：parser（Java/JS/TS/Groovy，约 41 MB）| parser-go | parser-python | parser-rust | parser-extra（go+python+rust）| all。默认 parser。`,
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
        const group = args.group ?? 'parser'
        if (group !== 'all' && !PARSER_GROUPS.includes(group)) {
          return fail(`未知依赖组：${group}（可用：${PARSER_GROUPS.join(', ')}, all）`)
        }
        const depsDir = expandPath(config.embedding.depsDir) ?? defaultDepsDir()
        const lines = [`依赖目录：${depsDir}`, `依赖组：${PARSER_GROUPS.map((g) => `${g}(${DEP_GROUPS[g].length} 包)`).join('、')}`]
        let detail = {}
        if (action === 'install' || action === 'repair') {
          const log = (m) => ctx.logger?.info?.(`dsh-code-index: ${m}`)
          const fn = action === 'install' ? installDeps : repairDeps
          const targets = group === 'all' ? ['parser', 'parser-extra'] : [group]
          let ok = true
          for (const g of targets) {
            const r = await fn({ depsDir, registry: args.registry, group: g, log })
            lines.push(r.note)
            if (r.stdout) {
              const tail = String(r.stdout).trim().split('\n').filter(Boolean).slice(-3)
              if (tail.length) lines.push(`npm 输出尾部：${tail.join(' | ')}`)
            }
            ok = ok && r.ok
          }
          detail = { action, group, ok }
          // 装完立刻让**本进程**也能用上：chunk-ast 会缓存"解析器加载失败"的结果，
          // 不清的话本次会话里仍然一直在走 heuristic，看起来像"装了没用"（实测踩到）。
          if (ok) {
            const { resetParserCache } = await import('./lib/chunk-ast.js')
            resetParserCache()
            lines.push('已重置解析器缓存：后续建库立即按 AST 切块（无需重启）')
          }
        } else if (action === 'prune') {
          const p = pruneForeignPlatforms(depsDir)
          lines.push(`已移除 ${p.removed.length} 个非本平台目录（保留 ${p.kept}），回收 ${(p.freedBytes / 1048576).toFixed(1)} MB`)
          detail = { action, removed: p.removed.length, freedBytes: p.freedBytes }
        } else if (action === 'remove') {
          const r = removeDeps(depsDir)
          lines.push(r.note)
          detail = { action, removed: r.removed }
        }
        const st = depsStatus({ depsDir, alsoDirs: [PLUGIN_DIR], group: group === 'all' ? 'parser' : group })
        lines.push(`\n各组状态（依赖目录合计 ${(st.sizeBytes / 1048576).toFixed(1)} MB）：`)
        for (const g of PARSER_GROUPS) {
          const gs = st.groups[g]
          if (!gs) continue
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
        const missing = PARSER_GROUPS.filter((g) => !st.groups[g]?.installed)
        lines.push('')
        lines.push(
          missing.length
            ? `下一步：code_index_deps action=install group=${missing.join('|')} —— ` +
                missing.map((g) => `${g}: ${DEP_GROUPS[g].map((p) => `${p.name}@${p.version}`).join(', ')}`).join('；')
            : '语法解析依赖已就绪：code_index 会按 AST 切块（切块策略见 code_index_status）。',
        )
        return textResult({ depsDir, ...detail, status: st }, lines.join('\n'))
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
    `dsh-code-index ${BUILD} 已加载（remote-only：vectors=${config.vectorsMode}${config.vectors === 'remote' ? `@${config.remote.url}` : ''}，roots=${config.allowedRoots.length || '任意'}，` +
      `rerank=${config.rerank}${config.rerank !== 'off' ? `@远端` : ''}，` +
      `chunking=${config.chunking.strategy}，deps=${expandPath(config.embedding.depsDir) ?? defaultDepsDir()}）`,
  )
  ctx.logger?.info?.(`dsh-code-index 切块策略表：${sample}（表见 lib/strategies.js，可用 advanced.chunking.byExt 覆盖）`)
  bootLog('tools-registered', { tools: ['code_index', 'code_search', 'code_map', 'code_index_status', 'code_index_deps'] })
}