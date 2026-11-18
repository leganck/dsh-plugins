/**
 * 计算“允许索引的根”。
 *
 * DSH 已不再提供多根工作区（`.dshworkspace.json` 机制随之下线），
 * 所以这里只保留两个来源：
 * - DSH sandboxPolicy 解析出的 workspaceRoot；
 * - 当前会话 cwd。
 *
 * 工作区外的仓库不再靠额外的定义文件放行，而是由调用方**显式传 path**
 * （见 index.js 的 assertAllowed：显式点名即授权，并记入仓库注册表）。
 *
 * 安全原则：
 * - 没有 workspace 信息时只允许当前 cwd，绝不回退到“任意路径”；
 * - 路径判断使用 path.resolve + path.relative，避免 `D:/Projects2` 误匹配 `D:/Projects`。
 */
import fs from 'node:fs'
import path from 'node:path'

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
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
 * @returns {{roots:string[], sources:string[], definitionFile:null, warnings:string[]}}
 */
export function resolveAllowedRoots({ workspaceRoot = null, sessionCwd = process.cwd() } = {}) {
  const byKey = new Map()
  const sources = []
  const warnings = []
  addRoot(byKey, workspaceRoot)
  if (workspaceRoot) sources.push('workspace')
  addRoot(byKey, sessionCwd)
  if (sessionCwd) sources.push('cwd')

  if (!byKey.size) {
    addRoot(byKey, process.cwd())
    if (byKey.size) sources.push('process-cwd')
  }
  return {
    roots: [...byKey.values()],
    sources: [...new Set(sources)],
    // 多根工作区已下线；保留字段避免调用方读取时崩，值恒为 null。
    definitionFile: null,
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
