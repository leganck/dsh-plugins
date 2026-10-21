/**
 * 远端服务的行为测试：不发真网络，用本地 HTTP 桩验证地址解析、重排、配置校验，
 * 以及 0.11.0 新增的**作用域**（档 3）：
 *   - namespace 规范：逐条跑 server/code-index-service/scope_format.json 夹具（JS/Python 防漂移）；
 *   - 多作用域检索请求体：{namespaces:[{namespace},...]}，单作用域仍发旧协议 {namespace}；
 *   - 旧服务端兼容：400/404 时 code_search 回退单作用域重试一次（回退事实写进输出）；
 *   - 插件级：scope 推导 → sync payload.scope → 服务端命名空间；命中项来源 scope。
 *
 * 0.10.0 remote-only：向量嵌入与 kNN 都在服务端，客户端不再有远端嵌入器；
 * 这里守住的仍是：
 *   ① 地址解析（base / 带 /embed 后缀 / 非法 URL）
 *   ② 重排握手与失败可见（rerank_ready=false 时不发无谓请求）
 *   ③ 配置校验：vectors=auto/remote/off、缺地址、未知键、已移除键的迁移提示
 *
 * 用法：node test-remote.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

// 必须在动态 import 插件之前隔离 DSH_HOME（插件在模块导入时写加载标记）
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-remote-home-'))

const { endpointsOf, createRemoteReranker, createRemoteIndex, RemoteError } = await import('./lib/remote.js')
const { canonicalNamespace, normalizeNamespace, refToken, safeRef, validateScope } = await import('./lib/scope.js')
const { apply } = await import('./index.js')

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? '  — ' + extra : ''}`)
  }
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol

/** 测试用向量：dim=4，逐条可区分（第 0 维 = 序号，其余递推） */
function vecFor(i, dim = 4) {
  const v = new Float32Array(dim)
  for (let d = 0; d < dim; d++) v[d] = i + d / 10
  return v
}
const b64 = (floats) => Buffer.from(Float32Array.from(floats).buffer).toString('base64')

/**
 * 桩服务：可以按需切行为（正常 / 无 tag / embed 500 / rerank 未就绪 / 慢响应 / 数组形态向量）。
 */
async function makeStub(opts = {}) {
  const state = { embedCalls: 0, rerankCalls: 0 }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const send = (code, obj) => {
        const body = JSON.stringify(obj)
        res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        res.end(body)
      }
      if (req.method === 'GET') {
        if (opts.slowGet) return // 永不响应 → 触发客户端超时
        return send(200, {
          ready: true,
          model: 'model_fp16.onnx',
          model_bytes: 123,
          used_providers: ['CPUExecutionProvider'],
          rerank_ready: opts.rerankReady ?? true,
          ...(opts.noTag ? {} : { tag: 'bge-base-zh-v1.5-deadbeef-fp16' }),
        })
      }
      const body = JSON.parse(chunks.join('') || '{}')
      if (req.url === '/embed') {
        state.embedCalls++
        if (opts.embed500) return send(500, { error: 'boom' })
        const texts = body.texts ?? []
        if (opts.arrayVectors) return send(200, { ok: true, dim: 4, count: texts.length, vectors: texts.map((_, i) => Array.from(vecFor(i))) })
        const flat = []
        texts.forEach((_, i) => flat.push(...vecFor(i)))
        return send(200, { ok: true, dim: 4, count: texts.length, ms: 1.5, providers: ['CPUExecutionProvider'], vectors_b64: b64(flat) })
      }
      if (req.url === '/rerank') {
        state.rerankCalls++
        if (opts.rerank500) return send(500, { error: 'boom' })
        return send(200, { ok: true, scores: (body.texts ?? []).map((_, i) => 10 - i), ms: 2, providers: ['CPUExecutionProvider'] })
      }
      send(404, { error: 'not found' })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}

/**
 * 索引/检索桩（0.11.0 作用域测试）：
 *   POST /v1/repos/{ns}/sync -> 记下路径 & payload，返回一个最小可用的同步结果
 *   POST /v1/search          -> 按 state.mode 决定是否接受 `namespaces`：
 *     'multi'      新服务端：接受；
 *     'legacy400'  旧服务端：带 namespaces → 400（参数不被认）；
 *     'legacy404'  旧服务端：带 namespaces → 404（路由没有）。
 * 这样同一套桩既能验证新协议请求体，也能验证客户端的回退策略。
 */
async function makeIndexStub({ mode = 'multi' } = {}) {
  const state = { mode, syncCalls: [], searchCalls: [], hits: [] }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const send = (code, obj) => {
        const body = JSON.stringify(obj)
        res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        res.end(body)
      }
      const raw = chunks.join('')
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        /* 非 JSON 请求体（不会发生；保守处理） */
      }
      if (req.method === 'GET') return send(200, { ready: true, rerank_ready: false })
      if (req.url.endsWith('/sync')) {
        const namespace = decodeURIComponent(req.url.replace(/^\/v1\/repos\//, '').replace(/\/sync$/, ''))
        state.syncCalls.push({ url: req.url, namespace, body })
        return send(200, { revision: 1, chunks: 1, vectors: 0, missing: [], unchanged: false, coverage: 1 })
      }
      if (req.url === '/v1/search') {
        state.searchCalls.push({ body })
        const multi = Array.isArray(body.namespaces)
        if (multi && state.mode === 'legacy400') return send(400, { error: 'bad-request', detail: 'unknown field: namespaces' })
        if (multi && state.mode === 'legacy404') return send(404, { error: 'not found' })
        return send(200, { hits: state.hits, ms: { embed: 1, knn: 1, rerank: 0 }, coverage: 1, byScope: [] })
      }
      send(404, { error: 'not found' })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}

// ---------------------------------------------------------------- ① 地址解析
console.log('\n[1] 地址解析')
{
  const a = endpointsOf('https://h.example')
  check('裸域名 → 拼出三个端点', a.base === 'https://h.example' && a.embed === 'https://h.example/embed' && a.rerank === 'https://h.example/rerank')
  const b = endpointsOf('https://h.example/base/')
  check('带路径前缀且尾斜杠 → 前缀保留', b.embed === 'https://h.example/base/embed' && b.status === 'https://h.example/base/')
  const c = endpointsOf('https://h.example/base/embed')
  check('直接给 /embed 全路径 → 剥掉后缀当基址', c.base === 'https://h.example/base' && c.rerank === 'https://h.example/base/rerank')
  check('给 /rerank 全路径也能剥', endpointsOf('https://h.example/base/rerank').embed === 'https://h.example/base/embed')
  for (const bad of ['', '   ', 'not a url', 'ftp://h.example', 'file:///tmp/x']) {
    let threw = null
    try {
      endpointsOf(bad)
    } catch (e) {
      threw = e
    }
    check(`拒绝非法地址 ${JSON.stringify(bad)}`, threw instanceof RemoteError, String(threw))
  }
}

// ---------------------------------------------------------------- ② 作用域命名规范（夹具）
// 夹具是 JS 与 Python 两端共同的**唯一真相**：这里逐条跑，防止两边规则漂移。
console.log('\n[2] 作用域命名规范（scope_format.json 夹具）')
{
  const fixturePath = fileURLToPath(new URL('../../server/code-index-service/scope_format.json', import.meta.url))
  let fixture = null
  try {
    fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  } catch (e) {
    check(`读取夹具 ${fixturePath}`, false, `本测试需要在 monorepo 里跑：${e.message}`)
  }
  if (fixture) {
    for (const c of fixture.cases) {
      const got = canonicalNamespace(c.repoId, c.chunkFp, c.kind, c.ref)
      check(`${c.kind} ${JSON.stringify(c.ref)} → ${c.expect}`, got === c.expect, `实际 ${got}`)
    }
    for (const c of fixture.legacy_cases) {
      const got = normalizeNamespace(c.namespace)
      check(`legacy 命名空间原样保留（${c.namespace.slice(0, 22)}…）`, got === c.expect, `实际 ${got}`)
    }
    for (const c of fixture.invalid_cases) {
      let err = null
      try {
        canonicalNamespace(c.repoId, c.chunkFp, c.kind, c.ref)
      } catch (e) {
        err = e
      }
      check(`非法输入按 reason 拒绝：${c.reason}`, err?.reason === c.reason, String(err?.reason ?? err))
    }
  }
  check('safeRef 把连续非法字符压成一个 -', safeRef('feat//x!!y') === 'feat-x-y', safeRef('feat//x!!y'))
  check('safeRef 结果为空 → x', safeRef('中文分支') === 'x' && safeRef('%%%') === 'x')
  check('safeRef 保留 . _ -（分支名里的合法字符）', safeRef('release/5.0-rc_1') === 'release-5.0-rc_1')
  check('main 的 ref 被忽略（固定 default）', refToken('main', 'whatever') === 'default')
  check('pr 的 ref 按 int 归一（去前导零）', refToken('pr', '007') === '7')
  check(
    'validateScope 返回原始分支名（token 只出现在命名空间里）',
    validateScope({ kind: 'branch', ref: ' feat/x ', ttlDays: 14 }).ref === 'feat/x',
    JSON.stringify(validateScope({ kind: 'branch', ref: ' feat/x ', ttlDays: 14 })),
  )
}

// ---------------------------------------------------------------- ③ 多作用域检索请求体
console.log('\n[3] 多作用域检索请求体（remote.js + HTTP 桩）')
{
  const stub = await makeIndexStub()
  const ri = createRemoteIndex({ url: stub.url, timeoutMs: 3000 })

  await ri.search(['r1@fp#main:default', 'r1@fp#branch:x-abc'], 'q')
  let body = stub.state.searchCalls.at(-1).body
  check(
    '多命名空间 → 发 {namespaces:[{namespace},...]}',
    Array.isArray(body.namespaces) && body.namespaces.length === 2 && body.namespaces[0].namespace === 'r1@fp#main:default',
    JSON.stringify(body.namespaces),
  )
  check('多命名空间请求不再带单 namespace 字段', !('namespace' in body), JSON.stringify(body))

  await ri.search(['only-one'], 'q')
  body = stub.state.searchCalls.at(-1).body
  check('长度 1 的数组 → 旧协议 {namespace}（单作用域零回归）', body.namespace === 'only-one' && !('namespaces' in body), JSON.stringify(body))

  await ri.search('plain-ns', 'q')
  body = stub.state.searchCalls.at(-1).body
  check('字符串 → 旧协议 {namespace}', body.namespace === 'plain-ns', JSON.stringify(body))

  stub.state.hits = [{ hash: 'h1', score: 0.5, namespace: 'ns-from-server', scope: { kind: 'main', ref: 'default' } }]
  const res = await ri.search(['a', 'b'], 'q')
  check('解析 hits[].namespace 与 scope', res.hits[0].namespace === 'ns-from-server' && res.hits[0].scope?.kind === 'main', JSON.stringify(res.hits[0]))

  stub.state.hits = [{ hash: 'h2', score: 0.1 }]
  const resSingle = await ri.search('solo', 'q')
  check('单作用域命中缺 namespace 时按请求值补齐', resSingle.hits[0].namespace === 'solo', JSON.stringify(resSingle.hits[0]))
  await stub.close()

  const legacy = await makeIndexStub({ mode: 'legacy400' })
  const riLegacy = createRemoteIndex({ url: legacy.url, timeoutMs: 3000 })
  let err = null
  try {
    await riLegacy.search(['a', 'b'], 'q')
  } catch (e) {
    err = e
  }
  check('旧服务端 400 在 remote.js 层如实抛出（回退策略属于 code_search）', err?.status === 400, String(err?.message))
  await legacy.close()
}

// ---------------------------------------------------------------- ④ 插件作用域：推导 / 同步 / 回退
console.log('\n[4] 插件作用域：推导 / sync payload / 多作用域回退')
{
  const { makeFixtureRepo } = await import('../../scripts/ci-fixture.mjs')
  const repo = makeFixtureRepo()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-scope-'))
  /** 最小 cordis 假 ctx：只要 apply() 能注册工具、能拿到工具定义即可 */
  const fakeCtx = () => {
    const registry = new Map()
    return {
      registry,
      ctx: {
        tools: {
          register(def) {
            registry.set(def.name, def)
            return () => registry.delete(def.name)
          },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        effect: (cb) => {
          const d = cb()
          return typeof d === 'function' ? d : () => {}
        },
      },
    }
  }
  const cfgOf = (extra) => ({
    roots: [repo],
    vectors: 'remote',
    advanced: { indexDirBase: path.join(tmp, `idx-${Math.random().toString(16).slice(2)}`), depsDir: path.join(tmp, 'deps') },
    ...extra,
  })

  // ---- 4a. scope 推导 → 路径/ payload ----
  const stub = await makeIndexStub({ mode: 'legacy400' })
  const a = fakeCtx()
  apply(a.ctx, cfgOf({ remote: { url: stub.url, scope: { kind: 'branch', ref: 'feat/x', ttlDays: 14 }, readScopes: ['r-main@fp#main:default'] } }))
  const indexTool = a.registry.get('code_index')
  const searchTool = a.registry.get('code_search')
  const built = await indexTool.execute({ path: repo }, {})
  const builtText = built.content[0].text
  check('code_index 成功', /索引完成/.test(builtText), builtText.slice(0, 100))
  const sync1 = stub.state.syncCalls.at(-1)
  check('同步路径用推导出的分支命名空间（#branch:feat-x-d6e256）', /#branch:feat-x-d6e256$/.test(sync1.namespace), sync1.namespace)
  check(
    'sync payload 带 scope（kind/ref/ttlDays）',
    sync1.body.scope?.kind === 'branch' && sync1.body.scope.ref === 'feat/x' && sync1.body.scope.ttlDays === 14,
    JSON.stringify(sync1.body.scope),
  )
  check('code_index 输出带作用域与 TTL（写作用域 branch:feat/x，TTL 14 天）', /作用域：写作用域 branch:feat\/x/.test(builtText) && /TTL 14 天/.test(builtText), builtText.slice(0, 300))
  check('code_index structuredContent 带 scope.namespaces（写 + 读）', built.structuredContent?.scope?.namespaces?.length === 2, JSON.stringify(built.structuredContent?.scope))

  // ---- 4b. 旧服务端 400 → 回退单作用域（只重试一次） ----
  const found = await searchTool.execute({ query: 'ZEPHYRQUARTZ', path: repo, top_k: 5 }, {})
  const foundText = found.content[0].text
  check('旧服务端上检索仍成功（本地 BM25 不受影响）', /命中 \d+ 条/.test(foundText), foundText.slice(0, 120))
  const calls400 = stub.state.searchCalls
  check(
    '400 回退：先发多作用域、再发单作用域（共 2 次）',
    calls400.length === 2 && Array.isArray(calls400[0].body.namespaces) && calls400[0].body.namespaces.length === 2 && !('namespaces' in calls400[1].body),
    JSON.stringify(calls400.map((c) => Object.keys(c.body))),
  )
  check('回退到写作用域', calls400[1]?.body?.namespace === sync1.namespace, `${calls400[1]?.body?.namespace}`)
  check('回退事实写进结果（不静默）', /旧服务端不支持多作用域/.test(foundText), foundText.slice(0, 200))

  // ---- 4c. 新服务端：多作用域 + 命中来源 + 头部提示 ----
  stub.state.mode = 'multi'
  stub.state.searchCalls.length = 0
  const { chunkFile } = await import('./lib/chunker.js')
  const mdText = fs.readFileSync(path.join(repo, 'docs/note.md'), 'utf8')
  const chunkHash = chunkFile({ relPath: 'docs/note.md', text: mdText, chunking: { strategy: 'auto', byExt: {}, windowLines: 40 } }).chunks[0]?.hash
  stub.state.hits = [
    { hash: chunkHash, score: 0.9, namespace: 'r-main@fp#main:default', scope: { kind: 'main', ref: 'default' } },
  ]
  const found2 = await searchTool.execute({ query: 'ZEPHYRQUARTZ', path: repo, top_k: 5 }, {})
  const found2Text = found2.content[0].text
  check('新服务端：一次请求发 2 个作用域（写 + 读）', stub.state.searchCalls[0]?.body?.namespaces?.length === 2, JSON.stringify(stub.state.searchCalls[0]?.body?.namespaces))
  check('code_search 头部提示多作用域', /只读 1 个/.test(found2Text) && /作用域：写作用域 branch:feat\/x/.test(found2Text), found2Text.slice(0, 240))
  const scopedHit = found2.structuredContent?.results?.find((h) => h.path === 'docs/note.md')
  check(
    '命中项带来源 scope（namespace/kind/ref）',
    scopedHit?.scope?.namespace === 'r-main@fp#main:default' && scopedHit?.scope?.kind === 'main' && scopedHit?.scope?.ref === 'default',
    JSON.stringify(scopedHit?.scope),
  )

  // ---- 4d. 旧服务端 404 同样回退 ----
  stub.state.mode = 'legacy404'
  stub.state.searchCalls.length = 0
  const found3 = await searchTool.execute({ query: 'ZEPHYRQUARTZ', path: repo, top_k: 5 }, {})
  check(
    '404 回退：同样只重试一次并如实报告',
    /旧服务端不支持多作用域/.test(found3.content[0].text) && stub.state.searchCalls.length === 2,
    `calls=${stub.state.searchCalls.length}`,
  )

  // ---- 4e. 优先级与向后兼容 ----
  stub.state.syncCalls.length = 0
  const b = fakeCtx()
  apply(b.ctx, cfgOf({ remote: { url: stub.url, namespace: 'explicit-ns', scope: { kind: 'branch', ref: 'other' } } }))
  await b.registry.get('code_index').execute({ path: repo }, {})
  check('remote.namespace 显式覆盖优先于 scope 推导', stub.state.syncCalls.at(-1).namespace === 'explicit-ns', stub.state.syncCalls.at(-1).namespace)
  check(
    '显式 namespace 时不发 scope（否则服务端会按 scope 重新推导、顶掉覆盖）',
    !('scope' in stub.state.syncCalls.at(-1).body),
    JSON.stringify(Object.keys(stub.state.syncCalls.at(-1).body)),
  )

  stub.state.syncCalls.length = 0
  const c = fakeCtx()
  apply(c.ctx, cfgOf({ remote: { url: stub.url } }))
  await c.registry.get('code_index').execute({ path: repo }, {})
  const defaultNs = stub.state.syncCalls.at(-1).namespace
  check('默认（未配 scope）自动落到 #main:default，不再产生 legacy 命名空间',
    /^[0-9a-f]{12}@[0-9a-f]{64}#main:default$/.test(defaultNs), defaultNs)
  const defaultBody = stub.state.syncCalls.at(-1).body
  check('默认配置 sync payload 带自动作用域（main:default）',
    defaultBody.scope?.kind === 'main' && defaultBody.scope?.ref === 'default', JSON.stringify(defaultBody.scope))
  await stub.close()
}

// ---------------------------------------------------------------- ⑥ 重排
console.log('\n[5] 远端重排')
{
  const stub = await makeStub()
  const rr = await createRemoteReranker({ url: stub.url, fallbackLocal: false, log: () => {} })
  check('重排握手成功', rr.ok === true, rr.reason)
  const scores = await rr.score('q', ['a', 'b', 'c'])
  check('拿到 3 个分数且按返回顺序', scores.length === 3 && near(scores[0], 10) && near(scores[2], 8), Array.from(scores).join(','))
  await stub.close()

  const stubNo = await makeStub({ rerankReady: false })
  const rr2 = await createRemoteReranker({ url: stubNo.url, fallbackLocal: false, log: () => {} })
  check('服务端 rerank_ready=false → 直接报不可用（不发无谓请求）', rr2.ok === false && /未装重排模型/.test(rr2.reason), rr2.reason)
  check('没有发出 /rerank 请求', stubNo.state.rerankCalls === 0, String(stubNo.state.rerankCalls))
  await stubNo.close()
}

// ---------------------------------------------------------------- ⑦ 配置校验
console.log('\n[6] 配置校验（apply 会大声失败）')
{
  const fakeCtx = () => ({
    tools: { register: () => () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (cb) => {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
  })
  const tryApply = (cfg) => {
    try {
      apply(fakeCtx(), cfg)
      return null
    } catch (e) {
      return e
    }
  }
  const e1 = tryApply({ vectors: 'remote' })
  check('vectors=remote 缺 url → 拒绝并点名 remote.url', e1 && /remote\.url/.test(e1.message), e1?.message)
  const e2 = tryApply({ embedding: { backend: 'remote' } })
  check('embedding 已移除 → 点名迁移到 vectors', e2 && /已移除/.test(e2.message) && /vectors/.test(e2.message), e2?.message)
  const e3 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', bogus: 1 } })
  check('未知远端键 → 拒绝并点名', e3 && /remote\.bogus/.test(e3.message), e3?.message)
  const e4 = tryApply({ vectors: 'remote', rerank: 'fast' })
  check('rerank 缺 remote.url → 拒绝', e4 && /remote\.url/.test(e4.message), e4?.message)
  const e5 = tryApply({ vectors: 'remote', rerank: 'fast', remote: { url: 'https://h.example' } })
  check('rerank 复用 remote.url → 通过', e5 === null, e5?.message)
  const e6 = tryApply({ vectors: 'remote', remote: { url: 'ftp://nope' } })
  check('非法协议 → 拒绝', e6 && /只支持 http\/https|不可用/.test(e6.message), e6?.message)
  const e7 = tryApply({ vectors: 'off' })
  check('vectors=off 不需要远端地址 → 通过（纯关键词）', e7 === null, e7?.message)
  const e7b = tryApply({ vectors: 'auto' })
  check('vectors=auto 无地址 → 自动纯关键词通过', e7b === null, e7b?.message)
  const e7c = tryApply({ vectors: 'auto', remote: { url: 'https://h.example' } })
  check('vectors=auto 有地址 → 自动走远端通过', e7c === null, e7c?.message)
  const e8 = tryApply({})
  check('空配置可加载（默认 vectors=auto，无地址即纯关键词）', e8 === null, e8?.message)
  const e9 = tryApply({ vectors: 'cloud' })
  check('未知 vectors → 拒绝', e9 && /vectors/.test(e9.message), e9?.message)
  const e10 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', apiKey: 42 } })
  check('apiKey 非字符串 → 拒绝', e10 && /apiKey/.test(e10.message), e10?.message)
  const e11 = tryApply({ advanced: { sync: { debounceMs: 10 } } })
  check('debounceMs 过小 → 拒绝（防抖下限 1 s）', e11 && /debounceMs/.test(e11.message), e11?.message)
  const e12 = tryApply({ advanced: { sync: { watch: 'yes' } } })
  check('watch 非布尔 → 拒绝', e12 && /sync\.watch/.test(e12.message), e12?.message)
  const e13 = tryApply({ advanced: { chunking: { strategy: 'nope' } } })
  check('未知切块策略 → 拒绝', e13 && /strategy/.test(e13.message), e13?.message)
  const e14 = tryApply({ vectors: 'off', rerank: 'quality' })
  check('纯关键词模式不允许重排 → 拒绝', e14 && /vectors/.test(e14.message), e14?.message)
  const e15 = tryApply({ advanced: { remoteTimeoutMs: 10 } })
  check('remoteTimeoutMs 过小 → 拒绝', e15 && /remoteTimeoutMs/.test(e15.message), e15?.message)
  // ---- 档 3 作用域配置（remote.namespace / remote.scope / remote.readScopes）----
  const e16 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', scope: { kind: 'branch', ref: 'feat/x', ttlDays: 14 } } })
  check('合法 remote.scope → 通过', e16 === null, e16?.message)
  const e17 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', scope: { kind: 'nope', ref: 'x' } } })
  check('未知 scope.kind → 拒绝并点名作用域类型', e17 && /未知作用域类型/.test(e17.message), e17?.message)
  const e18 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', scope: { kind: 'branch', ref: '' } } })
  check('branch 缺 ref → 拒绝', e18 && /ref 不能为空/.test(e18.message), e18?.message)
  const e19 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', scope: { kind: 'pr', ref: 'abc' } } })
  check('pr 非数字 ref → 拒绝', e19 && /纯数字/.test(e19.message), e19?.message)
  const e20 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', scope: { kind: 'main', bogus: 1 } } })
  check('scope 未知键 → 拒绝并点名 remote.scope.bogus', e20 && /remote\.scope\.bogus/.test(e20.message), e20?.message)
  const e21 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', scope: { kind: 'main', ttlDays: 0 } } })
  check('ttlDays 非正整数 → 拒绝', e21 && /ttlDays/.test(e21.message), e21?.message)
  const e22 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', readScopes: 'main' } })
  check('readScopes 非数组 → 拒绝', e22 && /readScopes/.test(e22.message), e22?.message)
  const e23 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', readScopes: [''] } })
  check('readScopes 空元素 → 拒绝', e23 && /readScopes/.test(e23.message), e23?.message)
  const e24 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', namespace: '' } })
  check('namespace 空串 → 拒绝（否则会静默落回推导）', e24 && /namespace/.test(e24.message), e24?.message)
  const e25 = tryApply({ vectors: 'remote', remote: { url: 'https://h.example', scope: { kind: 'main' }, readScopes: ['legacy-ns'] } })
  check('main 可省 ref、readScopes 接受 legacy 命名空间 → 通过', e25 === null, e25?.message)
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exitCode = fail === 0 ? 0 : 1
