/**
 * lib/gitlab.js 单测：URL/头部/分页解析/重试/超时/错误映射。
 * 全部用 fetchImpl 桩，不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GitLabError,
  createGitLabClient,
  paginationFromHeaders,
  retryAfterMs,
} from '../../lib/gitlab.js'

/** 构造 Response 桩。 */
function response({ status = 200, body = {}, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    headers: new Headers(headers),
    text: async () => text,
  }
}

/**
 * 构造 fetch 桩：handlers 为函数队列（每次调用取一个）。
 * @returns {{fetchImpl: Function, calls: Array<{url: string, init: object}>}}
 */
function queueFetch(handlers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)]
    return handler(url, init)
  }
  return { fetchImpl, calls }
}

const BASE = 'https://gitlab.example.com/'

test('getCurrentUser：URL/头部正确，baseUrl 处理尾部斜杠', async () => {
  const { fetchImpl, calls } = queueFetch([() => response({ body: { id: 1, username: 'dev' } })])
  const client = createGitLabClient({ baseUrl: BASE, token: 'glpat-123', fetchImpl })
  const user = await client.getCurrentUser()
  assert.equal(user.username, 'dev')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://gitlab.example.com/api/v4/user')
  assert.equal(calls[0].init.headers['PRIVATE-TOKEN'], 'glpat-123')
  assert.equal(calls[0].init.headers.Accept, 'application/json')
  assert.equal(client.baseUrl, 'https://gitlab.example.com', 'baseUrl 去掉尾部斜杠')
})

test('getUserEmails：返回数组；空响应归一为 []', async () => {
  const { fetchImpl } = queueFetch([
    () => response({ body: [{ id: 1, email: 'a@example.com' }] }),
    () => response({ body: null }),
  ])
  const client = createGitLabClient({ baseUrl: BASE, token: 't', fetchImpl })
  assert.deepEqual(await client.getUserEmails(), [{ id: 1, email: 'a@example.com' }])
  assert.deepEqual(await client.getUserEmails(), [])
})

test('listCommits：默认参数与分页头解析', async () => {
  const { fetchImpl, calls } = queueFetch([
    () =>
      response({
        body: [{ id: 'sha-1', title: 'feat' }],
        headers: {
          'x-page': '1',
          'x-per-page': '100',
          'x-total': '250',
          'x-total-pages': '3',
          'x-next-page': '2',
        },
      }),
  ])
  const client = createGitLabClient({ baseUrl: BASE, token: 't', fetchImpl })
  const result = await client.listCommits(42, { since: '2026-10-19T00:00:00+08:00', until: '2026-10-25T23:59:59+08:00' })
  assert.equal(result.items.length, 1)
  assert.equal(result.page, 1)
  assert.equal(result.perPage, 100)
  assert.equal(result.total, 250)
  assert.equal(result.totalPages, 3)
  assert.equal(result.nextPage, 2)
  assert.equal(result.hasPagination, true)

  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/api/v4/projects/42/repository/commits')
  assert.equal(url.searchParams.get('page'), '1')
  assert.equal(url.searchParams.get('per_page'), '100')
  assert.equal(url.searchParams.get('all'), 'true')
  assert.equal(url.searchParams.get('order_by'), 'created_at')
  assert.equal(url.searchParams.get('sort'), 'desc')
  assert.equal(url.searchParams.get('since'), '2026-10-19T00:00:00+08:00')
  assert.equal(url.searchParams.get('until'), '2026-10-25T23:59:59+08:00')
})

test('listCommits：末页 x-next-page 空 → nextPage=null 但 hasPagination=true', async () => {
  const { fetchImpl } = queueFetch([
    () => response({ body: [], headers: { 'x-page': '3', 'x-per-page': '100', 'x-next-page': '' } }),
  ])
  const client = createGitLabClient({ baseUrl: BASE, token: 't', fetchImpl })
  const result = await client.listCommits(1, { page: 3 })
  assert.equal(result.nextPage, null)
  assert.equal(result.hasPagination, true, '有 x-page 头即视为有分页信息')
})

test('listCommits：完全没有分页头 → hasPagination=false（同步引擎据此判 incomplete）', async () => {
  const { fetchImpl } = queueFetch([() => response({ body: [{ id: 'sha-1' }] })])
  const client = createGitLabClient({ baseUrl: BASE, token: 't', fetchImpl })
  const result = await client.listCommits(1)
  assert.equal(result.hasPagination, false)
  assert.equal(result.nextPage, null)
})

test('429 重试：尊重 Retry-After（注入 sleep 断言等待毫秒）', async () => {
  const sleeps = []
  const { fetchImpl, calls } = queueFetch([
    () => response({ status: 429, body: { message: '429 Too Many Requests' }, headers: { 'retry-after': '1' } }),
    () => response({ body: { id: 7, username: 'dev' }, headers: {} }),
  ])
  const client = createGitLabClient({
    baseUrl: BASE,
    token: 't',
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  const user = await client.getCurrentUser()
  assert.equal(user.id, 7)
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [1000], 'Retry-After: 1 → 等待 1000ms')
})

test('5xx 指数退避：最多 3 次重试后抛错（并带 GitLab message）', async () => {
  const sleeps = []
  const { fetchImpl, calls } = queueFetch([
    () => response({ status: 500, body: { message: 'internal error' }, headers: {} }),
  ])
  const client = createGitLabClient({
    baseUrl: BASE,
    token: 't',
    fetchImpl,
    backoffMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  await assert.rejects(
    () => client.getCurrentUser(),
    (error) => {
      assert.ok(error instanceof GitLabError)
      assert.equal(error.status, 500)
      assert.match(error.message, /internal error/)
      return true
    },
  )
  assert.equal(calls.length, 4, '首次 + 3 次重试')
  assert.deepEqual(sleeps, [10, 20, 40], '指数退避 10/20/40ms')
})

test('404 不重试，错误保留状态码与 GitLab message', async () => {
  const { fetchImpl, calls } = queueFetch([
    () => response({ status: 404, body: { message: '404 Project Not Found' }, headers: {} }),
  ])
  const client = createGitLabClient({ baseUrl: BASE, token: 't', fetchImpl, sleep: async () => {} })
  await assert.rejects(
    () => client.getCommit(99, 'deadbeef'),
    (error) => {
      assert.equal(error.status, 404)
      assert.equal(error.code, 'http')
      assert.match(error.message, /404 Project Not Found/)
      assert.match(error.message, /\/projects\/99\/repository\/commits\/deadbeef/)
      return true
    },
  )
  assert.equal(calls.length, 1, '404 不应重试')
})

test('getCommit / getCommitRefs：路径与查询参数', async () => {
  const { fetchImpl, calls } = queueFetch([
    () => response({ body: { id: 'sha-1', stats: { additions: 3, deletions: 1, total: 4 } } }),
    () => response({ body: [{ type: 'branch', name: 'main' }, { type: 'branch', name: 'dev' }] }),
    () => response({ body: { not: 'array' } }),
  ])
  const client = createGitLabClient({ baseUrl: BASE, token: 't', fetchImpl })
  const detail = await client.getCommit(42, 'sha-1')
  assert.equal(detail.stats.additions, 3)
  const refs = await client.getCommitRefs(42, 'sha-1')
  assert.deepEqual(refs.map((item) => item.name), ['main', 'dev'])

  const refsUrl = new URL(calls[1].url)
  assert.equal(refsUrl.pathname, '/api/v4/projects/42/repository/commits/sha-1/refs')
  assert.equal(refsUrl.searchParams.get('type'), 'branch')

  // 非数组响应归一为 []
  assert.deepEqual(await client.getCommitRefs(42, 'sha-1'), [])
})

test('listMembershipProjects：membership/per_page/page/order_by/sort', async () => {
  const { fetchImpl, calls } = queueFetch([
    () => response({ body: [{ id: 1, name: 'p' }], headers: { 'x-next-page': '' } }),
  ])
  const client = createGitLabClient({ baseUrl: BASE, token: 't', fetchImpl })
  const result = await client.listMembershipProjects({ page: 2, perPage: 50 })
  assert.equal(result.items.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/api/v4/projects')
  assert.equal(url.searchParams.get('membership'), 'true')
  assert.equal(url.searchParams.get('page'), '2')
  assert.equal(url.searchParams.get('per_page'), '50')
  assert.equal(url.searchParams.get('order_by'), 'name')
  assert.equal(url.searchParams.get('sort'), 'asc')
})

test('超时：不响应时按 timeoutMs 抛 timeout 错误', async () => {
  const fetchImpl = () => new Promise(() => {})
  const client = createGitLabClient({ baseUrl: BASE, token: 't', fetchImpl, timeoutMs: 20 })
  await assert.rejects(
    () => client.getCurrentUser(),
    (error) => {
      assert.equal(error.code, 'timeout')
      assert.match(error.message, /超时/)
      return true
    },
  )
})

test('非 JSON 响应 → parse 错误', async () => {
  const { fetchImpl } = queueFetch([() => response({ body: '<html>bad gateway</html>' })])
  const client = createGitLabClient({ baseUrl: BASE, token: 't', fetchImpl })
  await assert.rejects(
    () => client.getCurrentUser(),
    (error) => {
      assert.equal(error.code, 'parse')
      return true
    },
  )
})

test('缺少 baseUrl / token 时构造期报 config 错误', () => {
  assert.throws(
    () => createGitLabClient({ baseUrl: '', token: 't', fetchImpl: async () => response() }),
    (error) => error.code === 'config',
  )
  assert.throws(
    () => createGitLabClient({ baseUrl: BASE, token: '  ', fetchImpl: async () => response() }),
    (error) => error.code === 'config',
  )
})

test('paginationFromHeaders / retryAfterMs 纯函数边界', () => {
  assert.deepEqual(paginationFromHeaders(new Headers({ 'x-next-page': '3' })), {
    page: 0,
    perPage: 0,
    total: 0,
    totalPages: 0,
    nextPage: 3,
    hasPagination: true,
  })
  const empty = paginationFromHeaders(new Headers())
  assert.equal(empty.hasPagination, false)
  assert.equal(empty.nextPage, null)

  assert.equal(retryAfterMs(new Headers({ 'retry-after': '2' })), 2000)
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '0' })), 0)
  assert.equal(retryAfterMs(new Headers()), 0)
  const future = new Date(Date.now() + 5000).toUTCString()
  const ms = retryAfterMs(new Headers({ 'retry-after': future }))
  assert.ok(ms > 1000 && ms <= 6000, `HTTP 日期应换算为毫秒，实际 ${ms}`)
  // 普通对象头也支持
  assert.equal(retryAfterMs({ 'Retry-After': '3' }), 3000)
})
