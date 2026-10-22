/**
 * 从 DSH workspace / 会话 cwd / 多根工作区定义推导“允许索引的根”。
 *
 * 取代用户配置里的 `roots`。安全原则：
 * - 没有 workspace 信息时只允许当前 cwd，绝不回退到“任意路径”；
 * - `.dshworkspace.json` 损坏/非法时只警告，并保留 workspace/cwd 边界；
 * - 路径判断使用 path.resolve + path.relative，避免 `D:/Projects2` 误匹配 `D:/Projects`。
 *
 * `.dshworkspace.json` 与 dsh-multiroot 插件使用同一格式，但这里不 import 该插件
 * （它不一定安装/加载），只实现所需的最小只读解析。
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFINITION_NAME = '.dshworkspace.json'
const MAX_UP_LEVELS = 12

export function findWorkspaceDefinition(startDir, maxUpLevels = MAX_UP_LEVELS) {
  let dir
  try {
    dir = path.resolve(String(startDir ?? process.cwd()))
  } catch {
    return null
  }
  for (let i = 0; i <= maxUpLevels; i += 1) {
    const candidate = path.join(dir, DEFINITION_NAME)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* keep walking */
    }
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
 * 解析 `.dshworkspace.json`。相对路径相对定义文件所在目录。
 * 返回 `{roots, primary}`；格式错误抛 Error（调用方负责 fallback）。
 */
export function normalizeWorkspaceDefinition(raw, { baseDir, file = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('定义文件必须是 JSON 对象')
  }
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`只支持 version=1，收到 ${JSON.stringify(raw.version)}`)
  }
  if (!Array.isArray(raw.roots) || raw.roots.length === 0) {
    throw new Error('roots 必须是非空数组')
  }
  const seen = new Set()
  const roots = []
  for (let i = 0; i < raw.roots.length; i += 1) {
    const entry = raw.roots[i]
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path.trim()) {
      throw new Error(`roots[${i}].path 必须是非空字符串`)
    }
    const abs = path.isAbsolute(entry.path) ? path.normalize(entry.path) : path.resolve(baseDir ?? '.', entry.path)
    if (!isDir(abs)) throw new Error(`roots[${i}].path 不是存在的目录：${abs}`)
    const key = abs.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(abs)
  }
  return { roots, primary: raw.primary ?? null, file }
}

function addRoot(set, root) {
  if (!root) return
  try {
    const abs = path.resolve(String(root))
    if (isDir(abs)) set.set(abs.toLowerCase(), abs)
  } catch {
    /* ignore invalid path */
  }
}

/**
 * 当前调用允许的根。
 * @param {object} p
 * @param {string|null} p.workspaceRoot DSH sandboxPolicy.workspaceRoot
 * @param {string} p.sessionCwd 当前会话 cwd
 * @returns {{roots:string[], sources:string[], definitionFile:string|null, warnings:string[]}}
 */
export function resolveAllowedRoots({ workspaceRoot = null, sessionCwd = process.cwd() } = {}) {
  const byKey = new Map()
  const sources = []
  const warnings = []
  addRoot(byKey, workspaceRoot)
  if (workspaceRoot) sources.push('workspace')
  addRoot(byKey, sessionCwd)
  if (sessionCwd) sources.push('cwd')

  let definitionFile = null
  try {
    definitionFile = findWorkspaceDefinition(sessionCwd)
  } catch {
    /* ignore */
  }
  if (definitionFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(definitionFile, 'utf8'))
      const def = normalizeWorkspaceDefinition(raw, { baseDir: path.dirname(definitionFile), file: definitionFile })
      for (const r of def.roots) addRoot(byKey, r)
      sources.push('multiroot')
    } catch (e) {
      warnings.push(`${definitionFile} 解析失败：${String(e?.message ?? e)}`)
    }
  }
  if (!byKey.size) {
    addRoot(byKey, process.cwd())
    if (byKey.size) sources.push('process-cwd')
  }
  return {
    roots: [...byKey.values()],
    sources: [...new Set(sources)],
    definitionFile,
    warnings,
  }
}

/** 目标是否在任一允许根内（按路径段判断，避免前缀误匹配）。 */
export function isInsideRoots(target, roots) {
  let abs
  try {
    abs = path.resolve(String(target))
  } catch {
    return false
  }
  for (const root of roots ?? []) {
    let r
    try {
      r = path.resolve(String(root))
    } catch {
      continue
    }
    if (abs === r) return true
    const rel = path.relative(r, abs)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
  }
  return false
}
