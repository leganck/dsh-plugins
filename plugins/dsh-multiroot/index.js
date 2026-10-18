/**
 * dsh-multiroot —— Cursor 式「多目录工作空间」的**骨架**。
 *
 * 当前只落地了设计文档里的第一层：**根注册表 + 只读列举工具**。
 * 写/改/跑（root_write / root_edit / root_run）需要"每次调用把 sandboxPolicy 换到目标根"
 * 的沙箱语义，见 `docs/analysis/plugin-multiroot-design.md` §3–§4，尚未实现。
 *
 * 为什么先做这一层：模型必须先知道"有哪些根、叫什么名字"，才谈得上按根读写；
 * 而且这一层纯读、零沙箱改造，能先把配置/发现/校验的正确性钉住（有测试）。
 */
import path from 'node:path'
import { resolveRoots, RegistryError, DEFINITION_NAME } from './lib/registry.js'

export const name = 'dsh-multiroot'

/** 需要 tools 服务才注册工具；没有它插件也能加载（只是没有工具） */
export const inject = ['tools']

export const BUILD = '2026-10-18.1'

const DEFAULTS = {
  /** 显式指定定义文件（绝对路径或相对会话目录）；null = 按 §2.2 向上查找 */
  definitionFile: null,
  /** 内联根定义（等价于文件里的 roots），文件优先 */
  roots: [],
  /** 内联主根 id；缺省 = 第一个 */
  primary: null,
  /** 向上找定义文件的最大层数 */
  maxUpLevels: 12,
}

class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function normalizeConfig(raw = {}) {
  const unknown = Object.keys(raw).filter((k) => !(k in DEFAULTS))
  if (unknown.length) {
    throw new ConfigError(`未知配置项：${unknown.join(', ')}；可用：${Object.keys(DEFAULTS).join(', ')}`)
  }
  const cfg = { ...DEFAULTS, ...raw }
  if (cfg.definitionFile !== null && typeof cfg.definitionFile !== 'string') {
    throw new ConfigError(`config.definitionFile 必须是字符串或 null，收到 ${typeof cfg.definitionFile}`)
  }
  if (!Array.isArray(cfg.roots)) throw new ConfigError(`config.roots 必须是数组，收到 ${typeof cfg.roots}`)
  if (cfg.primary !== null && typeof cfg.primary !== 'string') {
    throw new ConfigError(`config.primary 必须是字符串或 null，收到 ${typeof cfg.primary}`)
  }
  if (!Number.isInteger(cfg.maxUpLevels) || cfg.maxUpLevels < 0 || cfg.maxUpLevels > 64) {
    throw new ConfigError(`config.maxUpLevels 必须是 0..64 的整数，收到 ${JSON.stringify(cfg.maxUpLevels)}`)
  }
  return cfg
}

const textResult = (value, text) => ({ content: [{ type: 'text', text }], structuredContent: value })
const fail = (message) => ({ content: [{ type: 'text', text: `错误：${message}` }] })

/** 会话当前目录：优先 exec 给的 cwd，其次进程 cwd */
function sessionCwd(exec) {
  return exec?.cwd ?? exec?.session?.cwd ?? process.cwd()
}

function describeRoots(resolved) {
  const { roots, primary, source, definitionFile } = resolved
  const where =
    source === 'file'
      ? `定义文件 ${definitionFile}`
      : source === 'config'
        ? '内联配置 roots'
        : `单根退化（没找到 ${DEFINITION_NAME}，也没配 roots）`
  const lines = [`工作空间根（${where}）：主根 ${primary}，共 ${roots.length} 个`]
  for (const r of roots) {
    const marks = [r.id === primary ? '主' : null, r.readonly ? '只读' : null].filter(Boolean).join('，')
    lines.push(`  ${r.id.padEnd(12)} ${r.path}${marks ? `（${marks}）` : ''}${r.label ? ` — ${r.label}` : ''}`)
  }
  if (source === 'fallback') lines.push(`  提示：在锚点目录放一个 ${DEFINITION_NAME} 就能声明多个根（见 docs/analysis/）`)
  return lines.join('\n')
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const log = (m) => ctx.logger?.info?.(`dsh-multiroot: ${m}`)

  ctx.tools.register({
    name: 'workspace_roots',
    description:
      '列出当前工作空间的**多个根目录**（id / 绝对路径 / 是否只读 / 哪个是主根），以及这份定义从哪来。'
      + '多根场景下先用它确认根 id，再按根行动。没有任何定义文件时退化为单根（会话当前目录）。',
    isConcurrencySafe: () => true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v.content?.[0]?.text ?? '' }] },
    async execute(_args, exec) {
      try {
        const resolved = resolveRoots({ cwd: sessionCwd(exec), config })
        return textResult({ cwd: sessionCwd(exec), ...resolved }, describeRoots(resolved))
      } catch (e) {
        // 配置类错误**大声失败并点名**（静默降级的代价最高）
        if (e instanceof RegistryError) return fail(`${e.message}${e.file ? `\n文件：${e.file}` : ''}`)
        return fail(String(e?.message ?? e))
      }
    },
  })

  ctx.effect?.(() => () => {}, 'dsh-multiroot: tools')

  try {
    const resolved = resolveRoots({ cwd: process.cwd(), config })
    log(`根注册表就绪：${resolved.roots.length} 个根（主根 ${resolved.primary}，来源 ${resolved.source}）`)
  } catch (e) {
    // 加载期不因配置错误挡住插件（工具调用时再报，且报得更完整）
    log(`根注册表暂不可用：${String(e?.message ?? e).slice(0, 120)}`)
  }

  return { config }
}
