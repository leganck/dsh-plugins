/**
 * 归档检索工具：在 compaction 归档里按关键词/标识符查找**原始工具输出**。
 *
 * ## 为什么有它
 * `index.js` 的压缩指针已能告诉模型"该 grep 什么"，但真正去查还得自己拼
 * `grep` + 多个 `read`。这个脚本把这件事压成**一次调用**，形状对齐 Cursor 的
 * 实际行为：Cursor 会用**精确标识符**（状态常量、工单号、SQL 片段）grep 自己的
 * `segment_*.md`，而不是靠自然语言。
 *
 * ## 用法
 *   node tools/memory-search.mjs <关键词或正则> [--session <id>] [--dir <归档根>]
 *       [--limit 5] [--context 3] [--json]
 *
 * - 默认在 `~/.dsh/archive/session-<id>/` 的 `segment_*.md` + `evicted.md` 里搜
 * - 多词用空格分隔 = AND（每个词都要出现）；`--re` 时按正则处理
 * - 输出：命中文件 + 行号 + 命中行与上下文（`--json` 给机器读）
 *
 * 例：
 *   node tools/memory-search.mjs PENDING_PAYMENT
 *   node tools/memory-search.mjs "20 ms" retry        # 两个词都要在
 *   node tools/memory-search.mjs "\b0x887A0006" --re --context 5
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const has = (k) => argv.includes(k)
const terms = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !argv[i - 1].startsWith('--no')))
const query = terms[0]
if (!query) {
  console.error('用法：node tools/memory-search.mjs <关键词或正则> [--session <id>] [--dir <根>] [--limit 5] [--context 3] [--json] [--re]')
  process.exit(1)
}
const root = path.resolve(arg('--dir', path.join(os.homedir(), '.dsh', 'archive')))
const onlySession = arg('--session')
const limit = Number(arg('--limit', 5))
const context = Number(arg('--context', 3))
const useRe = has('--re')
const asJson = has('--json')

/** 多词 AND；`--re` 时整体当正则 */
function matcher(text) {
  if (useRe) {
    const re = new RegExp(query, 'i')
    return re.test(text)
  }
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => text.toLowerCase().includes(t.toLowerCase()))
}

function sessionDirs() {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('session-'))
    .filter((d) => !onlySession || d.name.includes(onlySession))
    .map((d) => path.join(root, d.name))
}

const hits = []
for (const dir of sessionDirs()) {
  let files = []
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^segment_\d+\.md$/.test(f) || f === 'evicted.md')
      .sort()
  } catch {
    continue
  }
  for (const f of files) {
    const full = path.join(dir, f)
    let lines
    try {
      lines = fs.readFileSync(full, 'utf8').split('\n')
    } catch {
      continue
    }
    // INDEX 行里的关键词也能命中（让"先找到哪一段"更快）
    for (let i = 0; i < lines.length; i++) {
      if (!matcher(lines[i])) continue
      const from = Math.max(0, i - context)
      const to = Math.min(lines.length, i + context + 1)
      hits.push({
        session: path.basename(dir),
        file: f,
        line: i + 1,
        bytes: Buffer.byteLength(lines.slice(from, to).join('\n'), 'utf8'),
        snippet: lines.slice(from, to).map((l, n) => `${String(from + n + 1).padStart(6)}| ${l.slice(0, 240)}`),
      })
      if (hits.length >= limit) break
    }
    if (hits.length >= limit) break
  }
  if (hits.length >= limit) break
}

if (asJson) {
  console.log(JSON.stringify(hits, null, 2))
} else if (!hits.length) {
  console.log(`未命中：${query}\n根目录 ${root}${onlySession ? `（会话过滤 ${onlySession}）` : ''}`)
  console.log('提示：多词默认 AND；要正则请加 --re；先看 INDEX.md 的 Keywords 拿候选词。')
} else {
  console.log(`命中 ${hits.length} 处（${query}）\n`)
  for (const h of hits) {
    console.log(`── ${h.file}:${h.line}  [${h.session}]`)
    for (const l of h.snippet) console.log(`   ${l}`)
    console.log()
  }
}
