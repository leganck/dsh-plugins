/**
 * 切块策略分发器。
 *
 * 三种策略（详见 lib/strategies.js 的策略表）：
 *   `ast`       —— tree-sitter 语法树切块（需要按需安装的 parser 依赖组）
 *   `heuristic` —— 纯 JS 语法感知（零依赖，永远可用）
 *   `window`    —— 固定行窗口（最早的实现，保守兜底）
 *
 * **降级链**：ast 不可用（依赖缺失/解析抛错）→ heuristic → window。
 * 每次降级都带回 `reason`，由调用方如实报告——静默换策略等于悄悄改变检索质量。
 *
 * 为什么保留 `window`：它不是"旧代码没删"，而是策略表里**明确指定给某些文件类型**的
 * （Vue SFC、XML、SQL、Markdown 这些"括号深度无意义"的文件）——见 strategies.js 的注释。
 */
import { sha256 } from './hash.js'
import { resolveChunkConfig } from './strategies.js'
import { heuristicChunks } from './chunk-heuristic.js'
import { getParser, astChunks } from './chunk-ast.js'

export { sha256 }

export const DEFAULT_WINDOW_LINES = 40
/** 送入嵌入模型的字符上限（约 500 token，模型上限 512） */
export const EMBED_CHAR_CAP = 1500

/**
 * 固定行窗口切块（`window` 策略）。
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
      kind: 'window',
    })
  }
  return out
}

/**
 * 按策略表为一个文件切块。
 *
 * @param {object} p
 * @param {string} p.relPath 仓库内相对路径（只用扩展名决定策略）
 * @param {string} p.text 文件全文
 * @param {object} [p.chunking] 配置：`{strategy:'auto'|'ast'|'heuristic'|'window', byExt:{}, windowLines}`
 * @param {string} [p.depsDir] parser 依赖所在目录（按需安装的受管目录）
 * @param {string[]} [p.depsFallbackDirs] 兜底解析目录（通常是插件自身目录）
 * @returns {{chunks: object[], strategy: string, wanted: string, fellBack: boolean, reason: string|null}}
 */
export function chunkFile({ relPath, text, chunking = {}, depsDir, depsFallbackDirs = [] }) {
  const cfg = resolveChunkConfig(relPath, chunking)
  const done = (chunks, strategy, fellBack = false, reason = null) => ({
    chunks,
    wanted: cfg.strategy,
    strategy,
    fellBack,
    reason,
  })

  if (cfg.strategy === 'window') {
    return done(chunkText(text, { windowLines: cfg.windowLines }), 'window')
  }

  if (cfg.strategy === 'heuristic') {
    return done(
      heuristicChunks(text, { minLines: cfg.minLines, maxLines: cfg.maxLines, targetLines: cfg.targetLines }),
      'heuristic',
    )
  }

  // ast：先确保 parser 可用（缺依赖时降级，并把原因带回去）
  const grammar = cfg.grammar ?? 'java'
  const got = getParser({ depsDir, depsFallbackDirs, grammar })
  if (!got.ok) {
    return done(
      heuristicChunks(text, { minLines: cfg.minLines, maxLines: cfg.maxLines, targetLines: cfg.targetLines }),
      'heuristic',
      true,
      `ast 不可用 → 降级 heuristic：${got.reason}`,
    )
  }
  try {
    const chunks = astChunks(text, {
      parser: got.parser,
      minLines: cfg.minLines,
      maxLines: cfg.maxLines,
      targetLines: cfg.targetLines,
    })
    // 解析成功但一个块都没产出（空文件/全被过滤）时不算失败，但也没有降级
    return done(chunks, 'ast')
  } catch (e) {
    return done(
      heuristicChunks(text, { minLines: cfg.minLines, maxLines: cfg.maxLines, targetLines: cfg.targetLines }),
      'heuristic',
      true,
      `ast 解析失败 → 降级 heuristic：${String(e?.message ?? e).slice(0, 120)}`,
    )
  }
}

/** 送入嵌入模型前的截断（存库仍保留完整 body） */
export function bodyForEmbedding(body) {
  return body.length > EMBED_CHAR_CAP ? body.slice(0, EMBED_CHAR_CAP) : body
}
