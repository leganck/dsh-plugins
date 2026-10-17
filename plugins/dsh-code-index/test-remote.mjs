/**
 * 远端推理的**行为**测试：不发真网络、不需要模型，用本地 HTTP 桩验证协议与降级。
 *
 * 为什么必须有这一层：远端的失败模式几乎都是**静默**的 —— 连不上、超时、服务端没就绪、
 * 向量标签对不上。它们都不该让检索失败，但也都不该被当成"正常"。这里逐条钉住：
 *   ① 地址解析（base / 带 /embed 后缀 / 非法 URL）
 *   ② 握手：服务端自述的 tag / providers / rerank_ready 被正确采用
 *   ③ 响应解码：vectors_b64 与 vectors 两种形态都要能吃
 *   ④ 超时与 5xx → 报出**哪种**失败，不吞
 *   ⑤ 降级：标签一致才回退本机；标签不一致**必须拒绝**（否则两种向量混进一个索引）
 *   ⑥ 配置校验：选远端却没给地址、未知键、rerankRemote 复用 embedding.remote 地址
 *
 * 用法：node test-remote.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

// 必须在动态 import 插件之前隔离 DSH_HOME（插件在模块导入时写加载标记）
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-remote-home-'))

const { endpointsOf, createRemoteEmbedder, createRemoteReranker, RemoteError } = await import('./lib/remote.js')
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
  return { url, state, close: () => new Promise((r) => server.close(r)) }
}

/** 本机嵌入器替身：只记录调用、给可预测的向量，不加载模型 */
function fakeLocal(tag, { ok = true, reason = 'fake' } = {}) {
  const calls = []
  return {
    calls,
    get ok() {
      return ok
    },
    reason,
    modelTag: tag,
    dim: 4,
    backend: 'fake-local',
    modelFile: 'fake.onnx',
    cacheEntries: 0,
    async embed(texts) {
      calls.push(texts.length)
      return texts.map((_, i) => vecFor(100 + i))
    },
  }
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

// ---------------------------------------------------------------- ②③ 握手与解码
console.log('\n[2] 握手与响应解码')
{
  const stub = await makeStub()
  const emb = await createRemoteEmbedder({ url: stub.url, fallbackLocal: false, log: () => {} })
  check('握手成功', emb.ok === true, emb.reason)
  check('采用服务端自述的 tag', emb.modelTag === 'bge-base-zh-v1.5-deadbeef-fp16', emb.modelTag)
  check('tag 来源标记为 server', emb.remote.tagSource === 'server', emb.remote.tagSource)
  const vecs = await emb.embed(['a', 'b', 'c'], { useCache: false })
  check('解出 3 条向量', vecs.length === 3)
  check('维度来自 dim 字段（4）', vecs[0].length === 4, String(vecs[0]?.length))
  check('第一条向量内容正确', near(vecs[0][0], 0) && near(vecs[0][1], 0.1), Array.from(vecs[0]).join(','))
  check('顺序与输入一致（第 2 条 = 1.x）', near(vecs[1][0], 1), Array.from(vecs[1]).join(','))
  await stub.close()

  const stub2 = await makeStub({ arrayVectors: true })
  const emb2 = await createRemoteEmbedder({ url: stub2.url, fallbackLocal: false, log: () => {} })
  const v2 = await emb2.embed(['x'], { useCache: false })
  check('vectors 数组形态也能吃', v2.length === 1 && near(v2[0][0], 0))
  await stub2.close()

  const stub3 = await makeStub({ noTag: true })
  const emb3 = await createRemoteEmbedder({ url: stub3.url, fallbackLocal: false, log: () => {} })
  check('服务端无 tag 且未配置 → 明确拒绝（不猜标签）', emb3.ok === false && /tag/.test(emb3.reason ?? ''), emb3.reason)
  const emb4 = await createRemoteEmbedder({ url: stub3.url, tag: 'explicit-tag', fallbackLocal: false, log: () => {} })
  check('显式配置 tag 时可继续', emb4.ok === true && emb4.modelTag === 'explicit-tag', emb4.reason)
  await stub3.close()
}

// ---------------------------------------------------------------- ④ 失败可见
console.log('\n[3] 失败必须说清是哪种')
{
  const stub = await makeStub({ embed500: true })
  const emb = await createRemoteEmbedder({ url: stub.url, fallbackLocal: false, log: () => {} })
  let err = null
  try {
    await emb.embed(['a'], { useCache: false })
  } catch (e) {
    err = e
  }
  check('embed 500 → 抛 RemoteError 并带 http-error', err instanceof RemoteError && err.code === 'http-error', String(err?.code))
  await stub.close()

  const stubSlow = await makeStub({ slowGet: true })
  const t0 = Date.now()
  const embSlow = await createRemoteEmbedder({ url: stubSlow.url, timeoutMs: 400, fallbackLocal: false, log: () => {} })
  const ms = Date.now() - t0
  check('探活超时 → 不 ok，且理由含"连不上"', embSlow.ok === false && /连不上/.test(embSlow.reason), embSlow.reason)
  check('超时按配置生效（<3 s）', ms < 3000, `${ms} ms`)
  await stubSlow.close()

  const embDead = await createRemoteEmbedder({ url: 'http://127.0.0.1:9', timeoutMs: 500, fallbackLocal: false, log: () => {} })
  check('端口不通 → 不 ok 且给出地址', embDead.ok === false && String(embDead.reason).includes('127.0.0.1:9'), embDead.reason)
}

// ---------------------------------------------------------------- ⑤ 降级规则
console.log('\n[4] 降级只在标签一致时发生')
{
  const stub = await makeStub()
  const sameTag = 'bge-base-zh-v1.5-deadbeef-fp16'
  const localOk = fakeLocal(sameTag)
  const emb = await createRemoteEmbedder({ url: stub.url, fallbackLocal: true, localFactory: async () => localOk, log: () => {} })
  // 让远端 embed 失败
  const stubBroken = await makeStub({ embed500: true })
  const embB = await createRemoteEmbedder({ url: stubBroken.url, fallbackLocal: true, localFactory: async () => fakeLocal('different-tag'), log: () => {} })
  const okVecs = await emb.embed(['a', 'b'], { useCache: false })
  check('标签一致时正常走远端（未触发回退）', okVecs.length === 2 && emb.remote.fallbackUsed === 0)
  let refused = null
  try {
    await embB.embed(['a'], { useCache: false })
  } catch (e) {
    refused = e
  }
  check('标签不一致 → 拒绝回退（抛错而不是偷偷用本机）', refused instanceof RemoteError && /标签/.test(refused.message), String(refused?.message))
  await stub.close()
  await stubBroken.close()

  // 远端探活就失败 + 标签一致 → 直接用本机
  const localSame = fakeLocal(sameTag)
  const embDown = await createRemoteEmbedder({ url: 'http://127.0.0.1:9', timeoutMs: 300, tag: sameTag, fallbackLocal: true, localFactory: async () => localSame, log: () => {} })
  check('连不上但标签一致 → 回退本机', embDown.ok === true && embDown.backend === 'fake-local', String(embDown.reason))
  check('回退时记下原因', typeof embDown.fallbackReason === 'string' && embDown.fallbackReason.length > 0)
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
  const e1 = tryApply({ embedding: { backend: 'remote' } })
  check('backend=remote 缺 url → 拒绝并点名 embedding.remote.url', e1 && /embedding\.remote\.url/.test(e1.message), e1?.message)
  const e2 = tryApply({ embedding: { remote: { url: 'https://h.example', bogus: 1 } } })
  check('未知远端键 → 拒绝并点名', e2 && /embedding\.remote\.bogus/.test(e2.message), e2?.message)
  const e3 = tryApply({ rerank: 'fast', rerankBackend: 'remote' })
  check('rerankBackend=remote 但两个地址都没有 → 拒绝', e3 && /rerankRemote\.url/.test(e3.message), e3?.message)
  const e4 = tryApply({ rerank: 'fast', rerankBackend: 'remote', embedding: { remote: { url: 'https://h.example' } } })
  check('rerankRemote 缺地址时复用 embedding.remote.url → 通过', e4 === null, e4?.message)
  const e5 = tryApply({ embedding: { backend: 'remote', remote: { url: 'ftp://nope' } } })
  check('非法协议 → 拒绝', e5 && /只支持 http\/https|不可用/.test(e5.message), e5?.message)
  const e6 = tryApply({ embedding: { backend: 'remote', queryBackend: 'remote', remote: { url: 'https://h.example' } } })
  check('queryBackend=remote 组合合法', e6 === null, e6?.message)
  const e7 = tryApply({ embedding: { queryBackend: 'nope' } })
  check('未知 queryBackend → 拒绝', e7 && /queryBackend/.test(e7.message), e7?.message)
  // 默认值必须保持"全本机"
  const e8 = tryApply({})
  check('空配置可加载（默认全本机）', e8 === null, e8?.message)
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
