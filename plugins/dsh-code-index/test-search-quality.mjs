/**
 * 检索质量改进自测：文档降权（0.35 默认）。
 *
 * 复现的现场：erp-pos 里 CHANGELOG.md / .trae/skills/*.md 反复出现业务词，
 * BM25 词频把它们顶到实现文件前面（实测 2026-11-18）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './lib/store.js'
import { search, isDocPath, DEFAULT_DOC_WEIGHT } from './lib/search.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-quality-'))
const store = Store.open(path.join(dir, 'index.db'))

// 代码文件只提一次关键词；文档文件刷多次（BM25 词频高）
const javaBody = [
  'public class PrepackPrintService {',
  '  // 预包装打印记录上传',
  '  public void uploadPrepackPrintRecord() {',
  '    mapper.save(record);',
  '  }',
  '}',
].join('\n')
const mdBody = [
  '# 预包装打印记录',
  '预包装打印记录 上传 预包装打印记录 预包装打印记录',
  '预包装打印记录 预包装打印记录 上传 预包装打印记录',
  '预包装打印记录 预包装打印记录 预包装打印记录',
].join('\n')

const javaChunks = store.replaceChunks('src/main/java/PrepackPrintService.java', [
  { startLine: 1, endLine: 6, hash: 'h-java', body: javaBody },
])
store.upsertFile('src/main/java/PrepackPrintService.java', 1, javaBody.length, 'h-java')
const mdChunks = store.replaceChunks('CHANGELOG.md', [
  { startLine: 1, endLine: 4, hash: 'h-md', body: mdBody },
])
store.upsertFile('CHANGELOG.md', 1, mdBody.length, 'h-md')

const query = '预包装打印记录'

console.log('\n[1] 基础判定')
check('isDocPath 识别 md', isDocPath('CHANGELOG.md') === true)
check('isDocPath 不误判 java', isDocPath('src/A.java') === false)
check('默认权重 0.35', DEFAULT_DOC_WEIGHT === 0.35)

console.log('\n[2] 不降权时文档靠词频领先（复现原问题）')
const raw = await search(store, null, query, { mode: 'fts', topK: 5, docWeight: 1 })
check('命中了 2 条', raw.results.length === 2, JSON.stringify(raw.results.map((r) => r.path)))
check('原顺序：文档第一', raw.results[0]?.path === 'CHANGELOG.md', JSON.stringify(raw.results.map((r) => r.path)))

console.log('\n[3] 默认降权后代码文件上位')
const weighed = await search(store, null, query, { mode: 'fts', topK: 5 })
check('仍是 2 条（降权不删结果）', weighed.results.length === 2, JSON.stringify(weighed.results.map((r) => r.path)))
check('代码文件排第一', weighed.results[0]?.path.endsWith('PrepackPrintService.java'), JSON.stringify(weighed.results.map((r) => r.path)))

console.log('\n[4] 分数确实被乘了权重')
const mdRaw = raw.results.find((r) => r.path === 'CHANGELOG.md')
const mdWeighed = weighed.results.find((r) => r.path === 'CHANGELOG.md')
const ratio = mdWeighed.score / mdRaw.score
check('文档分数约为原来 ×0.35', Math.abs(ratio - 0.35) < 0.02, `ratio=${ratio.toFixed(4)}`)

console.log('\n[5] docWeight=1 完全恢复旧行为，代码不受影响')
const javaRaw = raw.results.find((r) => r.path.endsWith('.java'))
const javaWeighed = weighed.results.find((r) => r.path.endsWith('.java'))
check('代码分数不变', Math.abs(javaRaw.score - javaWeighed.score) < 1e-9, `${javaRaw.score} vs ${javaWeighed.score}`)

console.log('\n[6] 无文档命中时行为不变')
const only = await search(store, null, 'uploadPrepackPrintRecord', { mode: 'fts', topK: 5 })
check('单条命中仍是代码', only.results.length >= 1 && only.results[0].path.endsWith('.java'), JSON.stringify(only.results.map((r) => r.path)))

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
