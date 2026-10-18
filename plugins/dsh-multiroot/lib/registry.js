/**
 * 根注册表：发现 → 校验 → 规范化 → 缓存。
 *
 * 语义按 `docs/analysis/plugin-multiroot-design.md` §2 落地（**不静默降级**）：
 *   1. 配置 `definitionFile`（绝对路径）→ 直接用；
 *   2. 否则从会话当前目录向上找 `.dshworkspace.json`（最多 `maxUpLevels` 层，首个即停）；
 *   3. 否则用配置里的内联 `roots`（`primary` 取配置项）；
 *   4. 都没有 → 单根退化：`{ id: basename(cwd), path: cwd }`。
 *
 * 为什么用文件而不是插件 Config：跨机器可复现、可 code review（同 Cursor 的 `.code-workspace`）；
 * 而 profile 补丁层对 config 是**整份替换**语义，写漏一项就静默失效，不适合当项目级数据。
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFINITION_NAME = '.dshworkspace.json'
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

export class RegistryError extends Error {
  constructor(message, { file = null, field = null } = {}) {
    super(message)
    this.name = 'RegistryError'
    this.file = file
    this.field = field
  }
}

/** 从 `startDir` 向上找定义文件（含自身），最多 `levels` 层 */
export function findDefinition(startDir, levels = 12) {
  let dir = path.resolve(startDir)
  for (let i = 0; i <= levels; i++) {
    const candidate = path.join(dir, DEFINITION_NAME)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 校验并规范化一份定义（对象形态）。
 * @returns {{roots: Array<{id:string,path:string,label?:string,readonly?:boolean}>, primary: string}}
 */
export function normalizeDefinition(raw, { baseDir, file = null }) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistryError('定义文件必须是一个 JSON 对象', { file })
  }
  if (raw.version !== undefined && raw.version !== 1) {
    throw new RegistryError(`不认识的 version=${JSON.stringify(raw.version)}（只支持 1）`, { file, field: 'version' })
  }
  if (!Array.isArray(raw.roots) || raw.roots.length === 0) {
    throw new RegistryError('roots 必须是非空数组', { file, field: 'roots' })
  }

  const seen = new Set()
  const roots = raw.roots.map((entry, i) => {
    const at = `roots[${i}]`
    if (typeof entry !== 'object' || entry === null) throw new RegistryError(`${at} 必须是对象`, { file, field: at })
    const id = entry.id
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new RegistryError(`${at}.id 必须是 ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$，收到 ${JSON.stringify(id)}`, { file, field: `${at}.id` })
    }
    if (seen.has(id)) throw new RegistryError(`${at}.id 重复：${id}`, { file, field: `${at}.id` })
    seen.add(id)

    const rawPath = entry.path
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      throw new RegistryError(`${at}.path 必须是非空字符串`, { file, field: `${at}.path` })
    }
    // 绝对路径直接用；相对路径**相对定义文件所在目录**（"." = 锚点自身）
    const abs = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(baseDir, rawPath)
    if (!isDir(abs)) throw new RegistryError(`${at}.path 不是存在的目录：${abs}`, { file, field: `${at}.path` })
    if (entry.readonly !== undefined && typeof entry.readonly !== 'boolean') {
      throw new RegistryError(`${at}.readonly 必须是 true/false`, { file, field: `${at}.readonly` })
    }
    if (entry.label !== undefined && typeof entry.label !== 'string') {
      throw new RegistryError(`${at}.label 必须是字符串`, { file, field: `${at}.label` })
    }

    return {
      id,
      path: abs,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.readonly === undefined ? {} : { readonly: entry.readonly }),
    }
  })

  const primary = raw.primary ?? roots[0].id
  if (typeof primary !== 'string' || !seen.has(primary)) {
    throw new RegistryError(`primary 必须是某个根的 id，收到 ${JSON.stringify(raw.primary)}`, { file, field: 'primary' })
  }
  return { roots, primary }
}

/**
 * 解析出本次会话该用的根集合。
 * @param {object} p
 * @param {string} p.cwd 会话当前目录
 * @param {{definitionFile?: string|null, roots?: Array, primary?: string|null, maxUpLevels?: number}} p.config
 */
export function resolveRoots({ cwd, config = {} }) {
  const startDir = path.resolve(cwd)
  const maxUpLevels = Number.isInteger(config.maxUpLevels) ? config.maxUpLevels : 12

  let file = null
  if (config.definitionFile) {
    const abs = path.isAbsolute(config.definitionFile) ? config.definitionFile : path.resolve(startDir, config.definitionFile)
    if (!fs.existsSync(abs)) throw new RegistryError(`definitionFile 不存在：${abs}`, { file: abs })
    file = abs
  } else {
    file = findDefinition(startDir, maxUpLevels)
  }

  if (file) {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      throw new RegistryError(`定义文件解析失败（${e.message}）`, { file })
    }
    const normalized = normalizeDefinition(raw, { baseDir: path.dirname(file), file })
    return { source: 'file', definitionFile: file, ...normalized }
  }

  if (Array.isArray(config.roots) && config.roots.length > 0) {
    const normalized = normalizeDefinition({ roots: config.roots, ...(config.primary ? { primary: config.primary } : {}) }, {
      baseDir: startDir,
      file: null,
    })
    return { source: 'config', definitionFile: null, ...normalized }
  }

  // 单根退化：不注入提示词，工具仍可用（只有一个可选值）
  return {
    source: 'fallback',
    definitionFile: null,
    roots: [{ id: safeId(path.basename(startDir) || 'root'), path: startDir }],
    primary: safeId(path.basename(startDir) || 'root'),
  }
}

/** 目录名不一定符合 id 规则（中文、空格、超长）→ 规范化成合法 id */
function safeId(name) {
  const cleaned = String(name)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `root-${cleaned || 'workspace'}`
}
