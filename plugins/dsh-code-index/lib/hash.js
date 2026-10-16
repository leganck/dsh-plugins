/**
 * 内容哈希工具。
 *
 * 单独成模块是为了**避免循环依赖**：`chunker.js`（策略分发）要用 `chunk-ast.js`，
 * 而 `chunk-ast.js` 也要算块哈希——两者都从这里取，就没有环。
 */
import crypto from 'node:crypto'

/** sha256 十六进制（块内容寻址的基础） */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}
