/**
 * goSource.mjs —— 从 workbench Go 源码中提取「领域文案字面量」的测试辅助工具。
 *
 * 为什么需要它：
 *   模板 / guidance / HOST_INSTRUCTIONS / 分页 hint 都是**逐字节**契约（07 分册 §6.4），
 *   手抄极易错（全角标点、`–` 区间号、`……`）。本文件用最小实现解析 Go 源码里的
 *   字符串字面量表达式（`"" + "..." + Ident`），供两处使用：
 *     1. 生成 `lib/domain/briefDefaults.js`（生成脚本 import 本文件）；
 *     2. `test/domain/sourceParity.test.mjs` 断言 JS 常量与 Go 源码逐字节相等。
 *
 * 边界：
 *   - 只支持本仓库这几处的形态：字符串字面量 + 包内 const 标识符、以 `+` 连接；
 *   - 不做 Go 语法树解析，遇到不认识的形态会抛错（测试里表现为失败，不会静默放过）；
 *   - 插件目录若被移出 workbench 仓库（找不到 Go 源码），调用方应捕获并 skip。
 *
 * 该文件只用于测试 / 生成，不进入 `lib/domain/` 的运行时依赖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 插件根目录（test/domain 的上两级）。 */
export function pluginRoot() {
  return path.resolve(HERE, '..', '..')
}

/**
 * workbench 仓库根目录（插件目录的上一级）。
 * @returns {string}
 */
export function repoRoot() {
  return path.resolve(pluginRoot(), '..')
}

/**
 * Go 源码是否可用（插件被移出 workbench 仓库时为 false）。
 * @returns {boolean}
 */
export function goSourceAvailable() {
  const root = repoRoot()
  return (
    fs.existsSync(path.join(root, 'go.mod')) &&
    fs.existsSync(path.join(root, 'internal', 'report', 'templates.go'))
  )
}

/**
 * 把 Go 源码切成行数组（保留行尾无 \r）。
 * @param {string} file
 * @returns {string[]}
 */
function readLines(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
}

/**
 * 把字符串表达式按顶层 `+` 切开。字符串里的 `+` 不参与切分。
 * @param {string} expr
 * @returns {string[]} 已 trim 且丢弃空项
 */
export function splitGoTerms(expr) {
  /** @type {string[]} */
  const terms = []
  let current = ''
  let inString = false
  let escaped = false
  for (const ch of expr) {
    if (inString) {
      current += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      current += ch
      continue
    }
    if (ch === '+') {
      terms.push(current)
      current = ''
      continue
    }
    current += ch
  }
  terms.push(current)
  return terms.map((term) => term.trim()).filter((term) => term.length > 0)
}

/**
 * 把 Go 双引号字面量转成 JS 字符串。
 * 本仓库这几处只用到 `\n` / `\"` / `\\`，与 JSON 转义兼容，故直接用 JSON.parse。
 * @param {string} literal 形如 `"abc\n"`
 * @returns {string}
 */
export function unquoteGoString(literal) {
  return JSON.parse(literal)
}

/**
 * 求值一个「字符串表达式 + 标识符」组合。
 * @param {string} expr
 * @param {Record<string, string>} consts 包内 const 表
 * @returns {string}
 */
export function evalGoStringExpr(expr, consts) {
  const terms = splitGoTerms(expr)
  if (terms.length === 0) throw new Error(`空的字符串表达式：${JSON.stringify(expr)}`)
  let out = ''
  for (const term of terms) {
    if (term.startsWith('"')) {
      if (!term.endsWith('"') || term.length < 2) {
        throw new Error(`无法解析的 Go 字符串字面量：${JSON.stringify(term)}`)
      }
      out += unquoteGoString(term)
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(term)) {
      if (!Object.prototype.hasOwnProperty.call(consts, term)) {
        throw new Error(`未知的 Go 常量标识符：${term}`)
      }
      out += consts[term]
      continue
    }
    throw new Error(`无法求值的 Go 表达式片段：${JSON.stringify(term)}`)
  }
  return out
}

/**
 * 从「第一行 + 后续行」收集一个以 `+` 续行的表达式。
 * @param {string[]} lines
 * @param {number} startLine 第一行的下标
 * @param {string} firstLineExpr 第一行里截出来的表达式部分
 * @returns {{ expr: string, endLine: number }}
 */
function collectContinuation(lines, startLine, firstLineExpr) {
  let expr = firstLineExpr
  let endLine = startLine
  while (expr.trimEnd().endsWith('+')) {
    endLine += 1
    if (endLine >= lines.length) throw new Error('表达式在文件末尾仍未结束')
    expr += '\n' + lines[endLine]
  }
  return { expr, endLine }
}

/**
 * 提取包级 const 的字符串值。
 * @param {string} file
 * @param {string} name
 * @param {Record<string, string>} [known] 之前已解析的常量（允许前置依赖）
 * @returns {string}
 */
export function extractGoConst(file, name, known = {}) {
  const lines = readLines(file)
  const pattern = new RegExp(`^const\\s+${name}\\s*=\\s*(.*)$`)
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(pattern)
    if (!match) continue
    const { expr } = collectContinuation(lines, i, match[1])
    return evalGoStringExpr(expr, known)
  }
  throw new Error(`${file} 中找不到 const ${name}`)
}

/**
 * 提取函数体里 `return <字符串表达式>` 的值（支持多行 `+` 续行）。
 * @param {string} file
 * @param {string} funcName
 * @param {Record<string, string>} consts
 * @returns {string}
 */
export function extractGoStringFunc(file, funcName, consts = {}) {
  const lines = readLines(file)
  const head = new RegExp(`^func\\s+${funcName}\\s*\\(`)
  for (let i = 0; i < lines.length; i += 1) {
    if (!head.test(lines[i])) continue
    // 单行写法（如 `func X() string { return y() }`）不在本工具的处理范围内：
    // 需要“调函数”的包装器请直接提取被调用的那个函数。
    for (let j = i + 1; j < lines.length; j += 1) {
      const match = lines[j].match(/^\s*return\s+(.*)$/)
      if (!match) continue
      const { expr } = collectContinuation(lines, j, match[1])
      return evalGoStringExpr(expr, consts)
    }
    throw new Error(`${file} 的函数 ${funcName} 没有可解析的 return 字符串`)
  }
  throw new Error(`${file} 中找不到函数 ${funcName}`)
}

/**
 * 提取结构体字段的字符串表达式（用于 `HostInstructions: "..." +`）。
 * @param {string} file
 * @param {string} fieldName
 * @param {Record<string, string>} consts
 * @returns {string}
 */
export function extractGoStringField(file, fieldName, consts = {}) {
  const lines = readLines(file)
  const pattern = new RegExp(`^\\s*${fieldName}:\\s*(.*)$`)
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(pattern)
    if (!match) continue
    const { expr } = collectContinuation(lines, i, match[1])
    // 字段表达式末尾通常带逗号（结构体字面量）
    const cleaned = expr.trim().replace(/,$/, '')
    return evalGoStringExpr(cleaned, consts)
  }
  throw new Error(`${file} 中找不到字段 ${fieldName}`)
}

/**
 * 提取文件中所有双引号字符串字面量（用于按前缀挑选 hint 文案）。
 * @param {string} file
 * @returns {string[]}
 */
export function extractAllGoStrings(file) {
  const source = fs.readFileSync(file, 'utf8')
  /** @type {string[]} */
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let match
  while ((match = re.exec(source))) out.push(unquoteGoString(`"${match[1]}"`))
  return out
}

/**
 * 读取全部需要的 Go 领域文案。
 *
 * @returns {{
 *   templates: Record<'week'|'month'|'quarter'|'year', string>,
 *   guidance: Record<'week'|'month'|'quarter'|'year', string>,
 *   settingsTemplates: Record<'week'|'month'|'quarter'|'year', string>,
 *   settingsGuidance: Record<'week'|'month'|'quarter'|'year', string>,
 *   hostInstructions: string,
 *   gatherHints: { more: string, complete: string },
 * }}
 */
export function readGoDomainStrings() {
  if (!goSourceAvailable()) {
    throw new Error(`找不到 workbench Go 源码：${repoRoot()}`)
  }
  const root = repoRoot()
  const reportDir = path.join(root, 'internal', 'report')
  const settingsDir = path.join(root, 'internal', 'settings')
  const templatesFile = path.join(reportDir, 'templates.go')
  const settingsTemplatesFile = path.join(settingsDir, 'config_templates.go')
  const settingsConfigFile = path.join(settingsDir, 'config.go')
  const persistFile = path.join(reportDir, 'persist.go')
  const gatherFile = path.join(reportDir, 'gather.go')

  // internal/report/templates.go：自有 reportGuidanceCommon + 8 个 Default*
  const reportConsts = {
    reportGuidanceCommon: extractGoConst(templatesFile, 'reportGuidanceCommon'),
  }
  const templates = {
    week: extractGoStringFunc(templatesFile, 'DefaultWeekReportTemplate', reportConsts),
    month: extractGoStringFunc(templatesFile, 'DefaultMonthReportTemplate', reportConsts),
    quarter: extractGoStringFunc(templatesFile, 'DefaultQuarterReportTemplate', reportConsts),
    year: extractGoStringFunc(templatesFile, 'DefaultYearReportTemplate', reportConsts),
  }
  const guidance = {
    week: extractGoStringFunc(templatesFile, 'DefaultWeekReportGuidance', reportConsts),
    month: extractGoStringFunc(templatesFile, 'DefaultMonthReportGuidance', reportConsts),
    quarter: extractGoStringFunc(templatesFile, 'DefaultQuarterReportGuidance', reportConsts),
    year: extractGoStringFunc(templatesFile, 'DefaultYearReportGuidance', reportConsts),
  }

  // internal/settings/config_templates.go：另一份重复副本（其 common 在 config.go）
  const settingsConsts = {
    reportGuidanceCommon: extractGoConst(settingsConfigFile, 'reportGuidanceCommon'),
  }
  const settingsTemplates = {
    week: extractGoStringFunc(settingsTemplatesFile, 'weekTemplate', settingsConsts),
    month: extractGoStringFunc(settingsTemplatesFile, 'monthTemplate', settingsConsts),
    quarter: extractGoStringFunc(settingsTemplatesFile, 'quarterTemplate', settingsConsts),
    year: extractGoStringFunc(settingsTemplatesFile, 'yearTemplate', settingsConsts),
  }
  const settingsGuidance = {
    week: extractGoStringFunc(settingsTemplatesFile, 'weekGuidance', settingsConsts),
    month: extractGoStringFunc(settingsTemplatesFile, 'monthGuidance', settingsConsts),
    quarter: extractGoStringFunc(settingsTemplatesFile, 'quarterGuidance', settingsConsts),
    year: extractGoStringFunc(settingsTemplatesFile, 'yearGuidance', settingsConsts),
  }

  // persist.go：HostInstructions（写死的常量，不由 settings 配置）
  const hostInstructions = extractGoStringField(persistFile, 'HostInstructions', reportConsts)

  // gather.go：两句分页 hint（LLM 可读文案，必须逐字节一致）
  const gatherStrings = extractAllGoStrings(gatherFile)
  const more = gatherStrings.find((value) => value.startsWith('More commits remain.'))
  const complete = gatherStrings.find((value) => value.startsWith('Page complete.'))
  if (!more || !complete) throw new Error('gather.go 中找不到分页 hint 文案')

  return {
    templates,
    guidance,
    settingsTemplates,
    settingsGuidance,
    hostInstructions,
    gatherHints: { more, complete },
  }
}
