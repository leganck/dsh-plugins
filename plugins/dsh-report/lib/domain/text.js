/**
 * text.js —— 从 Go `internal/report/topics.go:219-257` 迁移的字符串/数字小工具。
 *
 * 口径提醒（勿「顺手修正」）：
 *   - Go 的 `strings.TrimSpace` 与 JS `String.prototype.trim()` 都按 Unicode 空白裁剪；
 *     JS 额外裁 BOM（U+FEFF），Go 不裁——仅影响含 BOM 的异常数据，领域用例中不可见。
 *   - Go 的零值 `""` 在 JS 里可能是 `undefined`/`null`（DB 列可空），统一用 `toStr` 归一。
 */

/**
 * Go `strings.TrimSpace(s)` 的等价实现（非字符串入参先转字符串，null/undefined → `""`）。
 * @param {unknown} value
 * @returns {string}
 */
export function trimSpace(value) {
  return toStr(value).trim()
}

/**
 * 归一成字符串：`null`/`undefined` → `""`（对应 Go 零值）。
 * 注意不能用 `String(value)` 直接拼，否则 `undefined` 会变成字面量 "undefined"。
 * @param {unknown} value
 * @returns {string}
 */
export function toStr(value) {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 归一成整数（对应 Go `int` 列；SQLite 可能给 `null`/浮点/字符串）。
 * @param {unknown} value
 * @returns {number}
 */
export function toInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.trunc(n)
}

/**
 * 归一成 0/1 标记（Go 的 `is_merge_commit` / `is_cherry_pick_commit` 列）。
 * 兼容 DB 返回 0/1、true/false、'0'/'1' 的情形。
 * @param {unknown} value
 * @returns {number} 0 或 1
 */
export function toFlag(value) {
  if (typeof value === 'boolean') return value ? 1 : 0
  const n = Number(value)
  return Number.isFinite(n) && n !== 0 ? 1 : 0
}

/**
 * Go `firstLine`：按 `\n` 取首行并 trim（`\r` 会被 trim 掉）。
 * @param {unknown} value
 * @returns {string}
 */
export function firstLine(value) {
  const lines = toStr(value).split('\n')
  return trimSpace(lines[0])
}

/**
 * Go `fallbackText`：trim 后非空则返回 trim 结果，否则返回 fallback（fallback 不再 trim）。
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function fallbackText(value, fallback) {
  const text = trimSpace(value)
  return text === '' ? fallback : text
}

/**
 * Go `fallbackJoin`：空数组返回 fallback，否则 `join(sep)`。
 * @param {string[]} values
 * @param {string} sep
 * @param {string} fallback
 * @returns {string}
 */
export function fallbackJoin(values, sep, fallback) {
  if (!Array.isArray(values) || values.length === 0) return fallback
  return values.join(sep)
}

/**
 * 包内 min（Go 侧自定义 min 遮蔽内置；这里等价实现，保留以防负数量场景）。
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function min(a, b) {
  return a < b ? a : b
}

/**
 * Go `parseJSONArray`（topics.go:219-228）：
 *   - 空串 → `[]`；
 *   - 非法 JSON → `[]`；
 *   - 非字符串数组（含数字元素）→ `[]`（Go `json.Unmarshal` 进 `[]string` 会报错）；
 *   - JSON 字面量 `null` → Go 得到 nil；本实现归成 `[]`（两者在 `currentRefsBranch` 里行为一致），
 *     属已记录的可接受偏差。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseJSONArray(raw) {
  const text = toStr(raw)
  if (text === '') return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (parsed === null) return []
  if (!Array.isArray(parsed)) return []
  for (const item of parsed) {
    if (typeof item !== 'string') return []
  }
  return parsed
}
