/**
 * 查询解析：把自然语言问题变成 FTS5 能用的词项。
 *
 * 词项来源（优先级从高到低，移植自已验证的 Python 版抽取器）：
 *   1. 带点/下划线/驼峰的标识符（refundOverLimit、sale_code、AbnormalPayMapper）—— 权重 2
 *   2. 8 位以上数字串（单号、时间戳、错误码）—— 权重 2
 *   3. 中文 4/3/2 元组 —— 权重 1
 *
 * FTS5 分词器是 unicode61：ASCII 按词切分（标识符能被精确匹配），
 * **中文连续文本会被切成一个整词**，所以中文词项要用前缀查询（`退款*`）才可能命中，
 * 中间词命中不了 —— 这部分交给向量通道。
 */
const EN_STOP = new Set(`the and for not all any are was were has had its can but you our who how why get set new old run
use see one two out off per via yet way day end top far did say his her him put let own may while still back down next
last this that with from have will your what when then there their which would could should about these those into over
than them they been also only some more most such because where after before using used does each other same make made
must need here just like want very well even much many both file files path paths line lines code type name value args`.split(/\s+/))

const CJK_STOP_PAIR = new Set(`可以 如果 因为 所以 这个 那个 什么 时候 需要 应该 可能 已经 还是 就是 一个 我们 你们 他们
现在 这里 那里 这样 那样 以及 并且 但是 然后 而且 或者 不过 只是 同时 全部 所有 一下 一些 进行 使用 通过 关于 对于
由于 为了 根据 按照 包括 例如 比如 表示 认为 发现 看到 注意 问题 内容 方式 情况 结果 地方 东西 一般 默认 实际 具体
当前 本次 之前 之后 怎么 为什么 是否 有没有 哪里 哪个`.split(/\s+/))

/**
 * 从问题里抽词项。
 * @param {string} question
 * @param {number} limit
 * @returns {string[]}
 */
export function extractTerms(question, limit = 8) {
  const scored = []
  for (const m of question.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}(?:[._][A-Za-z0-9_]+)*/g)) {
    const t = m[0]
    if (EN_STOP.has(t.toLowerCase())) continue
    const special = t.includes('.') || t.includes('_') || /[a-z][A-Z]/.test(t) || /^[A-Z][a-z]/.test(t)
    scored.push([special ? 2 : 1, t])
  }
  for (const m of question.matchAll(/\d{8,}/g)) scored.push([2, m[0]])
  for (const m of question.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0]
    for (const n of [4, 3, 2]) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n)
        if (CJK_STOP_PAIR.has(g)) continue
        scored.push([1, g])
      }
    }
  }
  scored.sort((a, b) => b[0] - a[0])
  const out = []
  const seen = new Set()
  for (const [, t] of scored) {
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= limit) break
  }
  return out
}

const isCjk = (t) => /[\u4e00-\u9fff]/.test(t)

/** 单个词项 → FTS5 片段：ASCII 用引号（防特殊字符），中文用前缀查询 */
function termExpr(t) {
  if (isCjk(t)) return `${t}*`
  return `"${t.replace(/"/g, '""')}"`
}

/**
 * 词项 → FTS5 MATCH 表达式（OR 连接）。
 * @returns {string|null} null 表示没有可用词项
 */
export function buildMatch(terms) {
  const parts = terms.filter((t) => t.trim().length >= 2).map(termExpr)
  return parts.length ? parts.join(' OR ') : null
}

/** 结果里取一小段上下文（命中行附近），供模型直接读 */
export function snippet(body, terms, maxChars = 320) {
  const lines = body.split('\n')
  let hitIdx = -1
  outer: for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase()
    for (const t of terms) {
      if (low.includes(t.toLowerCase())) {
        hitIdx = i
        break outer
      }
    }
  }
  if (hitIdx === -1) hitIdx = 0
  const from = Math.max(0, hitIdx - 2)
  const picked = lines.slice(from, from + 8).join('\n')
  return picked.length > maxChars ? picked.slice(0, maxChars) + '…' : picked
}
