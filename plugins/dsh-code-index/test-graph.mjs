/**
 * 图扩展自测：
 *  - 0.17 建图层：symbols/edges 落库、mapper_stmt 三角、有界 expand、删除级联（[1]-[7]）
 *  - 0.18 查询端：expand 语义模式/渲染裁剪、code_graph 的符号与邻居定位、buildIndex 自动建图（[8]-[10]）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './lib/store.js'
import {
  rebuildGraph,
  expandFromChunk,
  scanChunk,
  EDGE_TYPES,
  EXPAND_MAX_CHARS,
  findSymbols,
  similarSymbolNames,
  findChunksByHint,
  chunkIdsForHits,
  collectNeighbors,
  expandHits,
  renderExpandBlock,
  graphStats,
  firstLineOf,
  GRAPH_VERSION,
} from './lib/graph.js'
import { buildIndex } from './lib/indexer.js'

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'))
const s = Store.open(path.join(dir, 'index.db'))

console.log('\n[1] scanChunk 提取')
const dao = scanChunk('public interface PayBookDao {\n  int insertPayBook();\n  void deleteById(String id);\n}')
check('接口方法声明', dao.declared.includes('insertPayBook') && dao.declared.includes('deleteById'), JSON.stringify(dao.declared))
const svc = scanChunk('public class PayBookService {\n  public void save() {\n    payBookDao.insertPayBook();\n  }\n}')
check('调用提取', svc.calls.includes('insertPayBook'), JSON.stringify(svc.calls))
check('类型声明', svc.declared.includes('PayBookService'), JSON.stringify(svc.declared))
const xml = scanChunk('<select id="insertPayBook">\n  select * from hzf_pay_book\n</select>')
check('mapper statement id', xml.mapperStatements.includes('insertPayBook'), JSON.stringify(xml.mapperStatements))
check('SQL 表引用', xml.tableRefs.includes('hzf_pay_book'), JSON.stringify(xml.tableRefs))

console.log('\n[2] 建库 + rebuildGraph')
const cSvc = s.replaceChunks('svc/PayBookService.java', [{ startLine: 1, endLine: 10, hash: 'h1', body: 'public class PayBookService {\n  public void save() { dao.insertPayBook(); }\n}' }])
s.upsertFile('svc/PayBookService.java', 1, 10, 'h1')
const cDao = s.replaceChunks('dao/PayBookDao.java', [{ startLine: 1, endLine: 5, hash: 'h2', body: 'public interface PayBookDao {\n  int insertPayBook();\n}' }])
s.upsertFile('dao/PayBookDao.java', 1, 5, 'h2')
const cXml = s.replaceChunks('mapper/PayBookMapper.xml', [{ startLine: 1, endLine: 8, hash: 'h3', body: '<select id="insertPayBook">insert into hzf_pay_book</select>' }])
s.upsertFile('mapper/PayBookMapper.xml', 1, 8, 'h3')
const r = rebuildGraph(s)
check('rebuild 无错误', r.errors === 0, JSON.stringify(r))
check('符号入库', r.symbols >= 4, `symbols=${r.symbols}`)
check('边入库', r.edges >= 2, `edges=${r.edges}`)

console.log('\n[3] 边类型正确性')
const edges = s.db.prepare('select src_chunk, dst_chunk, type, weight from edges').all()
const hasType = (t) => edges.some((e) => e.type === t)
check('calls 边', hasType(EDGE_TYPES.calls))
check('mapper_stmt 边', hasType(EDGE_TYPES.mapper_stmt))

console.log('\n[4] mapper 三角：xml → dao（1 跳）→ svc（2 跳，经 dao）')
const expXml = expandFromChunk(s, { chunkId: cXml[0].id })
const xmlTargets = expXml.filter((e) => e.type === EDGE_TYPES.mapper_stmt).map((e) => e.other.path)
check('xml 能到达 dao', xmlTargets.some((p) => p.includes('PayBookDao')), JSON.stringify(xmlTargets))
const expXml2 = expandFromChunk(s, { chunkId: cXml[0].id, maxHops: 2 })
const allPaths = expXml2.map((e) => e.other.path)
check('2 跳到达 svc（xml→dao←svc 的 calls 边反向）', allPaths.some((p) => p.includes('PayBookService')), JSON.stringify(allPaths))

console.log('\n[5] 有界遍历（perTypeLimit）')
const expDao = expandFromChunk(s, { chunkId: cDao[0].id, perTypeLimit: 1 })
check('perTypeLimit 生效', expDao.length <= 2, `got ${expDao.length}`)
check('maxHops 默认 1 不越跳', expDao.every((e) => e.other), 'all edges have chunk meta')

console.log('\n[6] 类型过滤')
const onlyMapper = expandFromChunk(s, { chunkId: cXml[0].id, types: [EDGE_TYPES.mapper_stmt] })
// 必须同时断言"非空"：只检查 every() 的话，过滤实现坏掉返回空数组也会绿（曾如此）
check('types 过滤', onlyMapper.length > 0 && onlyMapper.every((e) => e.type === EDGE_TYPES.mapper_stmt), JSON.stringify(onlyMapper.map((e) => e.type)))

console.log('\n[7] 删除级联')
s.dropFile('svc/PayBookService.java')
const leftEdges = s.db.prepare('select count(*) n from edges').get().n
const deadEdges = s.db
  .prepare('select count(*) n from edges where src_chunk not in (select id from chunks) or dst_chunk not in (select id from chunks)')
  .get().n
check('无死边', deadEdges === 0, `dead=${deadEdges}`)
check('文件符号已清', s.db.prepare('select count(*) n from symbols where path=?').get('svc/PayBookService.java').n === 0)
check('其余边保留', leftEdges >= 1, `left=${leftEdges}`)

// ---------------------------------------------------------------------------
// 0.18 查询端：链路 ctl → svc → dao，mapper XML 再连 dao（一张最小的「支付单据」三角图）
// ---------------------------------------------------------------------------
console.log('\n[8] 查询端：符号/块定位与邻居方向')
// 独立开一个库：[7] 已经把 svc 删了，在同一份库上继续测会互相干扰
const g = Store.open(path.join(dir, 'graph2.db'))
const putFile = (rel, body) => {
  const lines = body.split('\n').length
  g.replaceChunks(rel, [{ startLine: 1, endLine: lines, hash: rel, body }])
  g.upsertFile(rel, 1, lines, rel)
}
putFile('ctl/PayCtl.java', `public class PayCtl {
  public void handle() { payService.save(); }
}`)
putFile('svc/PayService.java', `public class PayService {
  public void save() { payDao.insertPayBook(); }
}`)
putFile('dao/PayDao.java', `public interface PayDao {
  int insertPayBook();
}`)
putFile('mapper/PayMapper.xml', `<select id="insertPayBook">insert into hzf_pay_book</select>`)
// markerword 是给 chunk_hint（FTS）用的纯 ASCII 单词：camelCase/下划线在不同分词器下行为不同
putFile('lonely/Lonely.java', `public class Lonely {
  public void nothing() { } // markerword
}`)
const gr = rebuildGraph(g)
check('第二份库建图成功', gr.errors === 0 && gr.edges >= 3, JSON.stringify(gr))

const daoChunk = g.chunksForPath('dao/PayDao.java')[0]
const svcChunk = g.chunksForPath('svc/PayService.java')[0]
const daoDecls = findSymbols(g, 'insertPayBook')
check('findSymbols 精确命中并带 chunk_id', daoDecls.length >= 1 && daoDecls[0].chunkId === daoChunk.id, JSON.stringify(daoDecls))
check('findSymbols 不做模糊匹配', findSymbols(g, 'insertPayBookX').length === 0)
check('similarSymbolNames 给出改名候选', similarSymbolNames(g, 'insertPay').includes('insertPayBook'), JSON.stringify(similarSymbolNames(g, 'insertPay')))
const hintHits = findChunksByHint(g, 'markerword', 5)
check('chunk_hint 走 FTS 找到块', hintHits.length >= 1 && hintHits.some((c) => c.path.includes('Lonely')), JSON.stringify(hintHits.map((c) => c.path)))
const hitIds = chunkIdsForHits(g, [
  { path: 'svc/PayService.java', startLine: 1 },
  { path: 'svc/PayService.java', startLine: 999 },
])
check('命中坐标 → chunk_id', hitIds[0].chunkId === svcChunk.id, JSON.stringify(hitIds[0]))
check('坐标失配时留 null（调用方跳过）', hitIds[1].chunkId === null, JSON.stringify(hitIds[1]))
check('首行摘要跳过空行并截断', firstLineOf('\n\n   public void x() ').startsWith('public void x()') && firstLineOf('y'.repeat(200)).length === 100)

const daoIn = collectNeighbors(g, { chunkId: daoChunk.id, types: ['calls'], direction: 'in' })
check('入向邻居=调用方', daoIn.some((n) => n.other.path.includes('PayService')), JSON.stringify(daoIn.map((n) => [n.type, n.direction, n.other.path])))
check('入向过滤不混出边', daoIn.every((n) => n.direction === 'in'))
const svcOut = collectNeighbors(g, { chunkId: svcChunk.id, types: ['calls'], direction: 'out' })
check('出向邻居=被调用方', svcOut.some((n) => n.other.path.includes('PayDao')), JSON.stringify(svcOut.map((n) => n.other.path)))
const impact2 = collectNeighbors(g, { chunkId: daoChunk.id, direction: 'in', hops: 2 })
check('2 跳能到调用链上游', impact2.some((n) => n.other.path.includes('PayCtl') && n.hop === 2), JSON.stringify(impact2.map((n) => [n.other.path, n.hop])))

console.log('\n[9] expand 语义模式与渲染裁剪')
const svcHits = chunkIdsForHits(g, [{ path: 'svc/PayService.java', startLine: 1 }])
const callees = expandHits(g, svcHits, { mode: 'callees' })
check('callees 只用出向边', callees.items.some((n) => n.other.path.includes('PayDao') && n.direction === 'out'), JSON.stringify(callees.items.map((n) => [n.type, n.direction, n.other.path])))
const callers = expandHits(g, chunkIdsForHits(g, [{ path: 'dao/PayDao.java', startLine: 1 }]), { mode: 'callers' })
check('callers 只用入向边', callers.items.some((n) => n.other.path.includes('PayService') && n.direction === 'in'))
check('callers 归并 mapper_stmt（XML 也算调用方）', callers.items.some((n) => n.other.path.includes('PayMapper')), JSON.stringify(callers.items.map((n) => [n.type, n.other.path])))
const impact = expandHits(g, chunkIdsForHits(g, [{ path: 'dao/PayDao.java', startLine: 1 }]), { mode: 'impact' })
check('impact 走 2 跳', impact.items.some((n) => n.hop === 2 && n.other.path.includes('PayCtl')), JSON.stringify(impact.items.map((n) => [n.other.path, n.hop])))
const block = renderExpandBlock(callers)
check('渲染含【关联代码】表头', block.startsWith('【关联代码】callers'), block.split('\n')[0])
check('渲染格式：类型 + 箭头 + 文件:行 + 置信度', /calls ← .+:\d+-\d+（置信度 0\.50）/.test(block), block)
check('渲染含首行摘要', block.includes('interface') || block.includes('public'), block)
check('渲染长度 ≤1500', block.length <= EXPAND_MAX_CHARS, `len=${block.length}`)
const noRel = expandHits(g, chunkIdsForHits(g, [{ path: 'lonely/Lonely.java', startLine: 1 }]), { mode: 'callers' })
check('无关联时不渲染区块', renderExpandBlock(noRel) === '', `total=${noRel.total}`)
// 裁剪：40 条超长摘要必须被预算截断，且不留半行
const many = {
  mode: 'impact',
  roots: [{ path: 'a.js', startLine: 1 }],
  total: 40,
  items: Array.from({ length: 40 }, (_, i) => ({
    type: 'calls',
    direction: i % 2 ? 'in' : 'out',
    weight: 0.5,
    hop: 1,
    other: { path: `pkg/file${i}.js`, startLine: i + 1, endLine: i + 2, body: `function fn${i}() { ${'x'.repeat(200)} }` },
  })),
}
const trimmed = renderExpandBlock(many, { maxChars: EXPAND_MAX_CHARS })
check('超预算时裁剪到 ≤1500', trimmed.length <= EXPAND_MAX_CHARS, `len=${trimmed.length}`)
check('裁剪后有「未显示」提示', /还有 \d+ 条未显示/.test(trimmed), trimmed.split('\n').at(-1))

console.log('\n[10] buildIndex 自动建图')
const buildRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-build-'))
fs.mkdirSync(path.join(buildRepo, 'src'), { recursive: true })
fs.mkdirSync(path.join(buildRepo, 'mapper'), { recursive: true })
fs.writeFileSync(path.join(buildRepo, 'src/OrderService.java'), `public class OrderService {
  public void submit() { orderDao.insertOrder(); }
}`)
fs.writeFileSync(path.join(buildRepo, 'src/OrderDao.java'), `public interface OrderDao {
  int insertOrder();
}`)
fs.writeFileSync(path.join(buildRepo, 'mapper/OrderMapper.xml'), `<select id="insertOrder">insert into hzf_order</select>`)
const buildStore = Store.open(path.join(dir, 'build.db'))
const b1 = await buildIndex({ store: buildStore, repoRoot: buildRepo, embedder: { ok: false, reason: 'test' } })
check('建库返回 graph.symbols/edges/ms', !!b1.graph && typeof b1.graph.symbols === 'number' && typeof b1.graph.edges === 'number' && typeof b1.graph.ms === 'number', JSON.stringify(b1.graph))
check('自动建图产生了符号与边', b1.graph.symbols > 0 && b1.graph.edges > 0, JSON.stringify(b1.graph))
check('graph_built_at 落库', !!buildStore.getMeta('graph_built_at'))
check('graphStats 与建库结果一致', graphStats(buildStore).symbols === b1.graph.symbols, JSON.stringify(graphStats(buildStore)))
const b2 = await buildIndex({ store: buildStore, repoRoot: buildRepo, embedder: { ok: false, reason: 'test' } })
check('无变更时图沿用上次结果', b2.graph?.skipped === true && b2.graph.symbols === b1.graph.symbols, JSON.stringify(b2.graph))
const offStore = Store.open(path.join(dir, 'build-off.db'))
const bOff = await buildIndex({ store: offStore, repoRoot: buildRepo, embedder: { ok: false, reason: 'test' }, graph: { enabled: false } })
check('graph.enabled=false 时跳过建图', bOff.graph === null && graphStats(offStore).symbols === 0, JSON.stringify(bOff.graph))
const warnLogs = []
const brokenStore = Store.open(path.join(dir, 'build-broken.db'))
const origClear = brokenStore.clearGraph.bind(brokenStore)
brokenStore.clearGraph = () => { throw new Error('boom: graph 坏了') }
const bBroken = await buildIndex({
  store: brokenStore,
  repoRoot: buildRepo,
  embedder: { ok: false, reason: 'test' },
  graph: { enabled: true, logger: (m) => warnLogs.push(m) },
})
brokenStore.clearGraph = origClear
check('图失败不影响建库成功', bBroken.chunksWritten > 0 && bBroken.graph === null, `chunks=${bBroken.chunksWritten}`)
check('图失败记 warning 并带原因', /boom/.test(bBroken.graphError ?? '') && warnLogs.some((m) => m.includes('boom')), JSON.stringify({ err: bBroken.graphError, logs: warnLogs }))

// ---------------------------------------------------------------------------
// 8) 解构参数（JS/TS 常见形态）必须被识别为声明
//    早先 `\([^;{]*\)` 排除了 `{`，导致 `function buildIndex({ store })` 整条漏抓
//    → code_graph 查不到入口（本插件自己的入口函数就踩中过）
// ---------------------------------------------------------------------------
const destructured = scanChunk(
  'export async function buildIndex({\n  store,\n  repoRoot,\n}) {\n  const x = 1\n}\n',
)
check('解构参数（多行）识别为声明', destructured.declared.includes('buildIndex'), JSON.stringify(destructured.declared))
const nestedCall = scanChunk('  const r = await foo({ a: 1 })\n')
check('嵌套调用里的对象字面量不误判为声明', !nestedCall.declared.includes('foo'), JSON.stringify(nestedCall.declared))
check(
  '控制流关键字不因允许 { 而误判',
  scanChunk('  if (a) {\n  for (i) {\n').declared.length === 0,
  JSON.stringify(scanChunk('  if (a) {\n  for (i) {\n').declared),
)

// ---------------------------------------------------------------------------
// 9) 图构建版本：规则变更后必须强制重扫（否则升级插件后旧图赖着不走）
// ---------------------------------------------------------------------------
const verStore = Store.open(path.join(dir, 'graph-ver.db'))
const gv1 = await buildIndex({ store: verStore, repoRoot: buildRepo, embedder: { ok: false, reason: 't' }, graph: {} })
check('首建图写入 graph_version', graphStats(verStore).version === GRAPH_VERSION, `v=${graphStats(verStore).version}`)
const gv2 = await buildIndex({ store: verStore, repoRoot: buildRepo, embedder: { ok: false, reason: 't' }, graph: {} })
check('版本一致且无变更 → 跳过重建', gv2.graph?.skipped === true, JSON.stringify(gv2.graph))
verStore.setMeta('graph_version', String(GRAPH_VERSION - 1))
const gv3 = await buildIndex({ store: verStore, repoRoot: buildRepo, embedder: { ok: false, reason: 't' }, graph: {} })
check('版本不一致 → 强制重建（不跳过）', gv3.graph?.skipped === false, JSON.stringify(gv3.graph))
check('重建后版本回到当前', graphStats(verStore).version === GRAPH_VERSION, `v=${graphStats(verStore).version}`)

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)