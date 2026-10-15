/**
 * 切块：按固定行窗口切（40 行），每块带内容哈希。
 *
 * 为什么是固定窗口而不是 AST：本机实测 40 行窗口在标识符检索上 12/12 命中，
 * 而引入 tree-sitter 会带来原生依赖。窗口大小是配置项，后续可换 AST 切块器，
 * 只要 `body`/`hash` 语义不变，索引与缓存都不用重建。
 *
 * 块哈希是**跨版本复用的钥匙**：同一段代码在 5 个 crm 版本里内容相同 → 同一哈希
 * → 向量缓存直接命中，不必重算（实测 int8/fp16 都按内容寻址）。
 */
import crypto from 'node:crypto'

export const DEFAULT_WINDOW_LINES = 40
/** 送入嵌入模型的字符上限（约 500 token，模型上限 512） */
export const EMBED_CHAR_CAP = 1500

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 把一个文件切成块。
 * @param {string} text - 文件全文
 * @param {{windowLines?: number}} opts
 * @returns {{startLine: number, endLine: number, hash: string, body: string}[]}
 */
export function chunkText(text, { windowLines = DEFAULT_WINDOW_LINES } = {}) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i += windowLines) {
    const seg = lines.slice(i, i + windowLines)
    const body = seg.join('\n')
    if (!body.trim()) continue // 纯空白块不入库
    out.push({
      startLine: i + 1,
      endLine: Math.min(i + windowLines, lines.length),
      hash: sha256(body),
      body,
    })
  }
  return out
}

/** 送入嵌入模型前的截断（存库仍保留完整 body） */
export function bodyForEmbedding(body) {
  return body.length > EMBED_CHAR_CAP ? body.slice(0, EMBED_CHAR_CAP) : body
}
