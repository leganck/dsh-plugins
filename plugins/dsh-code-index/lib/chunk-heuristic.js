/**
 * 纯 JS 语法感知切块器（**零依赖**，永远可用）。
 *
 * 它不建语法树，只用一个"够用就好"的信号：**括号深度 + 成员边界**。
 * 目的不是精确，而是把"块从方法中间开始"这个最常见的病态压下去：
 *
 *   实测（saas-business-5.0，532 个括号类文件、185k 行，以"成员层"为基准）
 *   | 切块器 | 块首行落在成员内部 | 块内括号不平衡 |
 *   |---|---|---|
 *   | 固定 40 行窗口（`window`） | 79.7% | 73.3% |
 *   | 本模块（`heuristic`）      | **48.3%** | 61.2% |
 *   | tree-sitter（`ast`）       | *(构造性保证，仅超长成员被强制拆分)* | — |
 *
 * 两个必须处理的细节：
 * 1. **引号/注释里的括号不能计数**。实测 70/528 个文件里存在 `"{"` 或注释中的括号；
 *    朴素计数一旦在某处偏一次，**之后每一行的深度都错位**（那 28.9% 的"受影响行"就是这么来的）。
 * 2. **成员边界要认行首样貌**（注解、修饰符、关键字），而不是"空行即切"——
 *    后者会在长方法体内部的空行处乱切（实测反而更差）。
 */
import { sha256 } from './hash.js'

/** 成员声明行首的样貌：注解 / 注释开头 / 修饰符或声明关键字 */
const MEMBER_START =
  /^\s*(@|\/\/|\/\*|(public|private|protected|static|final|synchronized|abstract|native|transient|volatile|default|sealed|override|open|suspend|internal|companion|fun|val|var|class|interface|enum|record|struct|impl|fn|async|export|function|const|let|var|def|type|module)\b)/

/**
 * 逐行计算"行首处的括号深度"，**跳过字符串与注释里的括号**。
 * 极简状态机：不追求完整词法（不处理模板字符串插值、字符字面量边界等边角），
 * 只为让深度计数不被最常见的干扰带偏。
 */
export function braceDepths(lines) {
  const d = new Array(lines.length)
  let cur = 0
  let inBlockComment = false
  for (let i = 0; i < lines.length; i++) {
    d[i] = cur
    const s = lines[i]
    let inStr = null
    for (let j = 0; j < s.length; j++) {
      const c = s[j]
      const n = s[j + 1]
      if (inBlockComment) {
        if (c === '*' && n === '/') {
          inBlockComment = false
          j++
        }
        continue
      }
      if (inStr) {
        if (c === '\\') {
          j++
          continue
        }
        if (c === inStr) inStr = null
        continue
      }
      if (c === '/' && n === '*') {
        inBlockComment = true
        j++
        continue
      }
      if (c === '/' && n === '/') break // 行注释：后面全忽略
      if (c === '"' || c === "'" || c === '`') {
        inStr = c
        continue
      }
      if (c === '{') cur++
      else if (c === '}') cur--
    }
    if (cur < 0) cur = 0
  }
  return d
}

/**
 * 启发式切块。
 *
 * 收口规则与 AST 版本一致（`targetLines` / `maxLines` / `minLines`）——**这点很重要**：
 * 只在"每个成员边界"都切会得到平均 15 行的碎块（实测 48,372 块 vs AST 的 13,156 块），
 * 块太小既缺上下文、又让向量计算量翻几倍。所以要在成员边界处"够了才切"。
 *
 * @param {string} text
 * @param {{minLines?:number, maxLines?:number, targetLines?:number}} opts
 * @returns {{startLine:number,endLine:number,hash:string,body:string,kind:string}[]}
 */
export function heuristicChunks(text, { minLines = 8, maxLines = 120, targetLines = 40 } = {}) {
  const lines = text.split(/\r?\n/)
  if (!lines.length) return []
  const d = braceDepths(lines)
  // 文件基线 = 深度最小值（通常是 0）。成员层 = 基线（顶层成员）或基线+1（类体成员），
  // 两种都接受，避免为不同语言写两套规则。
  const base = Math.min(...d.slice(0, Math.min(d.length, 5000)))

  const out = []
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    const len = i - start + 1
    if (len < minLines) continue
    const cur = d[i]
    const nextDepth = i + 1 < d.length ? d[i + 1] : base
    let nextNonEmpty = ''
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k].trim()) {
        nextNonEmpty = lines[k]
        break
      }
    }
    const atMemberLevel = cur === base || cur === base + 1
    // "下一行/这一行看起来是成员声明"。**必须两种都认**：
    //  - 认下一行：成员之间有空行时（最常见的 Java 风格），切在空行处；
    //  - 认这一行：成员紧贴无空行时（`}` 下一行直接是 `public void b()`），切在成员起始行前。
    // 只认 cur === base 是错的——Java 的成员全在 class 体里（深度 base+1），那样等于永不切分。
    const memberStart = atMemberLevel && (MEMBER_START.test(nextNonEmpty) || (cur === base + 1 && MEMBER_START.test(lines[i])))
    const afterClosing = cur === base + 1 && lines[i].trim() === '}'
    // 到了目标量级才在成员边界收口；超过上限则无条件切
    const atBoundary = atMemberLevel && (memberStart || afterClosing)
    if (len >= maxLines || (atBoundary && len >= targetLines)) {
      out.push({ start, end: i + 1 })
      start = i + 1
    }
  }
  if (start < lines.length) out.push({ start, end: lines.length })

  // 尾部碎片合并：文件末尾常留下 `}` + 空行这种 2 行块，单独成块毫无检索价值，
  // 直接并回上一块（不影响边界"落在成员层"这个不变量）。
  while (out.length >= 2 && out[out.length - 1].end - out[out.length - 1].start < minLines) {
    const tail = out.pop()
    out[out.length - 1].end = tail.end
  }

  return out
    .filter((c) => lines.slice(c.start, c.end).join('\n').trim())
    .map((c) => {
      const body = lines.slice(c.start, c.end).join('\n')
      return {
        startLine: c.start + 1,
        endLine: Math.min(c.end, lines.length),
        hash: sha256(body),
        body,
        kind: 'heuristic',
      }
    })
}
