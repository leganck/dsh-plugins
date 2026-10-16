/**
 * AST 切块器（tree-sitter）。按语法树把文件切成"成员级"单元再打包成块。
 *
 * 两个**实测踩过的坑**，都在这里处理：
 *
 * 1. **必须显式传 `bufferSize`**。tree-sitter 的 JS 包装默认 32 KB，字符串输入超过它就抛
 *    `Invalid argument`（二分实测：32,767 字符通过、32,768 失败）。小仓库全过、大仓库
 *    第一个大文件就崩——只在真实仓库上才会暴露。这里统一传 `text.length + 4096`。
 * 2. **`setLanguage` 不做校验**。传错对象（例如把 `tree-sitter-typescript` 的模块对象
 *    当成 language）不会当场报错，而是后续**读取节点时**炸出
 *    `Cannot read properties of undefined (reading '138')`（那个数字是节点类型 id）。
 *    所以这里严格按各包的导出形状取 language，并对**每个文件**单独 try/catch。
 *
 * 版本必须同年代配对（运行时 `tree-sitter@0.21.1` + 0.21.x 语法包）——见 lib/deps.js 顶部注释。
 */
import { makeResolvers, loadFrom, defaultDepsDir } from './deps.js'
import { GRAMMARS } from './strategies.js'
import { sha256 } from './hash.js'

/** 进程内缓存：<depsDir>|<grammar> → { ok, parser } 或 { ok:false, reason } */
const parserCache = new Map()

const cacheKeyOf = (depsDir, grammar) => `${depsDir ?? ''}|${grammar}`

/**
 * 取出要传给 `setLanguage` 的对象。
 *
 * **必须传语法包的"元数据对象"，不能传它的 `.language` 子对象。**
 * 实测（tree-sitter 0.21.1 + java 0.21.0，本机复现）：
 *
 * | 传什么 | 结果 |
 * |---|---|
 * | `require('tree-sitter-java')`（整个模块） | ✅ root=program |
 * | `require('tree-sitter-typescript').typescript` / `.tsx` | ✅ |
 * | 上面任一者的 `.language` | ❌ `Cannot read properties of undefined (reading '138')` |
 * | `{...language, name, nodeTypeInfo}` | ❌ `Invalid language object` |
 *
 * 原因在 tree-sitter 自己的实现里：`setLanguage(arg)` 把 arg 原样存成 `tree.language`，
 * 之后 `unmarshalNode()` 会读 `tree.language.nodeSubclasses[nodeTypeId]`。
 * 元数据对象上才有 `nodeSubclasses`（由语法包的 `nodeTypeInfo` 派生）；
 * 裸语言对象上没有，于是**报错发生在读取节点时、而不是 setLanguage 时**——
 * 这就是这个坑特别难查的原因（栈顶指向 `index.js:771`，与调用点无关）。
 */
function languageOf(mod, pick) {
  if (pick) {
    if (!mod || !mod[pick]) {
      throw new Error(`语法包缺少变体 "${pick}"（导出：${Object.keys(mod ?? {}).join(', ')}）`)
    }
    return mod[pick]
  }
  return mod
}

/**
 * 取得（并缓存）某语法的 parser。任何失败都返回 {ok:false, reason}，由调用方决定降级。
 */
export function getParser({ depsDir, depsFallbackDirs = [], grammar }) {
  // **必须兜底到受管目录**：插件的 `embedding.depsDir` 默认是 null，传下来就是 undefined；
  // 不兜底的话解析器链为空 → 永远解析不到 → AST 策略会**静默退化成启发式**
  // （功能看起来"能用"，实际全是降级结果）。
  const dir = depsDir ?? defaultDepsDir()
  const key = cacheKeyOf(dir, grammar)
  if (parserCache.has(key)) return parserCache.get(key)

  const spec = GRAMMARS[grammar]
  let result
  if (!spec) {
    result = { ok: false, reason: `未登记的语法：${grammar}` }
  } else {
    try {
      const resolvers = makeResolvers({ depsDir: dir, alsoDirs: depsFallbackDirs })
      const TSParser = loadFrom(resolvers, 'tree-sitter')
      const Parser = TSParser?.default ?? TSParser
      const gram = loadFrom(resolvers, spec.pkg)
      const parser = new Parser()
      parser.setLanguage(languageOf(gram, spec.pick))
      result = { ok: true, parser, depsDir: dir }
    } catch (e) {
      result = {
        ok: false,
        reason:
          `语法解析依赖不可用（${spec?.pkg ?? grammar}）: ${String(e?.message ?? e).slice(0, 140)}` +
          `——按需安装请用 code_index_deps action=install group=parser`,
      }
    }
  }
  parserCache.set(key, result)
  return result
}

/** 测试/配置变更时清缓存 */
export function resetParserCache() {
  parserCache.clear()
}

/**
 * 把一个节点拆成"成员级单元"。
 *
 * 关键点：遇到容器（class/interface/enum 等，特征是带 `_body` 字段）时，
 * **要迭代 body 的子节点，而不是容器自己的子节点**——
 * 后者会得到 `identifier` 和整个 `class_body`，于是"一个块 = 整个类"，
 * 方法名也取不到（本函数的测试抓到过这个 bug：块首行是 `class Fixture {`）。
 *
 * `export class X {}` 这类包装节点则穿透到它的 `declaration`。
 */
function pushUnit(node, out, depth = 0) {
  if (node.type === 'comment' || node.type === 'line_comment' || node.type === 'block_comment') return
  if (depth > 4) {
    out.push(node)
    return
  }
  const body = node.childForFieldName?.('body')
  if (body && /_body$/.test(body.type)) {
    for (const m of body.namedChildren ?? []) pushUnit(m, out, depth + 1)
    return
  }
  const decl = node.childForFieldName?.('declaration')
  if (decl && decl !== node) {
    pushUnit(decl, out, depth)
    return
  }
  out.push(node)
}

function collectUnits(root, out) {
  for (const ch of root.namedChildren ?? []) pushUnit(ch, out)
}

function nameOf(node) {
  for (const f of ['name', 'declarator']) {
    const n = node.childForFieldName?.(f)
    if (n) return n.text.slice(0, 60)
  }
  return null
}

/**
 * AST 切块。返回 `{startLine, endLine, hash, body, kind, symbol, nodeType}[]`；
 * 解析失败**抛错**，由调用方降级。
 *
 * 打包规则（三个阈值，缺一不可）：
 * - `minLines`：短于此的单元（字段、单行 import）并入当前块，不单独成块；
 * - `targetLines`：**累计到这个量级就在下一个成员边界收口**。只按 `maxLines` 收口是错的——
 *   一个 91 行的类会被打包成 1 个块（3 个方法挤在一起，向量被平均掉，检索精度下降）；
 * - `maxLines`：单个成员超过它就**强制拆分**（`kind: 'forced'`），这是唯一会产生
 *   "块不从成员开头开始"的情况，也是"AST 切块质量"的可量化指标。
 *
 * @param {string} text 文件全文（字符串；不要传 Buffer —— tree-sitter 会把它当回调）
 * @param {{parser:object, minLines?:number, maxLines?:number, targetLines?:number}} p
 */
export function astChunks(text, { parser, minLines = 8, maxLines = 120, targetLines = 40 }) {
  // 坑 1：必须给 bufferSize，否则 >32KB 的文件抛 Invalid argument。
  // 单位取"字符数与 UTF-8 字节数里的较大者"——中文注释会让字节数远大于字符数，
  // 而 bufferSize 只是输入读取的缓冲上限，给大不有害。
  const bufferSize = Math.max(text.length, Buffer.byteLength(text, 'utf8')) + 4096
  const tree = parser.parse(text, undefined, { bufferSize })
  const lines = text.split(/\r?\n/)
  const units = []
  collectUnits(tree.rootNode, units)

  const out = []
  let cur = null
  for (const u of units) {
    const s = u.startPosition.row
    const e = u.endPosition.row
    const len = e - s + 1
    if (len < minLines) {
      // 太短的单元并入当前块（不要为一行 import 单独建块）
      if (cur) {
        cur.end = e
        cur.units += 1
        cur.kind = 'packed'
        cur.symbol = null // 打包块没有单一符号，不假装有
      } else {
        cur = { start: s, end: e, units: 1, kind: 'member', symbol: nameOf(u), type: u.type }
      }
      continue
    }
    if (len > maxLines) {
      if (cur) {
        out.push(cur)
        cur = null
      }
      for (let a = s; a <= e; a += maxLines) {
        out.push({ start: a, end: Math.min(a + maxLines - 1, e), units: 1, kind: 'forced', symbol: nameOf(u), type: u.type })
      }
      continue
    }
    // 到了目标量级 + 当前在成员边界 → 收口，而不是硬塞到 maxLines
    if (cur && cur.end - cur.start + 1 >= targetLines) {
      out.push(cur)
      cur = null
    }
    if (!cur) {
      cur = { start: s, end: e, units: 1, kind: 'member', symbol: nameOf(u), type: u.type }
    } else {
      cur.end = e
      cur.units += 1
      cur.kind = 'packed'
      cur.symbol = null
    }
  }
  if (cur) out.push(cur)

  return out
    .filter((c) => lines.slice(c.start, c.end + 1).join('\n').trim())
    .map((c) => {
      const body = lines.slice(c.start, c.end + 1).join('\n')
      return {
        startLine: c.start + 1,
        endLine: Math.min(c.end + 1, lines.length),
        hash: sha256(body),
        body,
        kind: c.kind,
        symbol: c.symbol ?? null,
        nodeType: c.type ?? null,
      }
    })
}
