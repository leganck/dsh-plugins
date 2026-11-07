/**
 * @local/dsh-report —— DSH 报告工作台插件（Host 半，完整实现）
 *
 * 组成：
 *   - lib/db.js        SQLite（commits/report 投影/sync jobs）
 *   - lib/domain/**    纯函数领域逻辑（stats/topics/gather/brief/persist）
 *   - lib/gitlab.js    GitLab REST 客户端
 *   - lib/matcher.js   提交归属匹配
 *   - lib/sync.js      同步编排（分页/并发/取消/进度/覆盖度）
 *   - lib/tools.js     9 个 Agent 工具
 *   - lib/api.js       Client JSON API（/plugins/dsh-report/api/*）
 *   - lib/services.js  组合：DB + 配置 + 同步 + 生成编排
 *   - lib/client.js    浏览器半（由 scripts/build-client.mjs 生成）
 *
 * 本文件只做接线：初始化配置/服务 → 注册工具与 HTTP → 生成端点拦截。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { createConfigService, unwrapConfig, resolveDataDir } from './lib/config.js'
import { createServices } from './lib/services.js'
import { registerTools } from './lib/tools.js'
import { createApiHandler, API_PREFIX } from './lib/api.js'
import * as domain from './lib/domain/index.js'
import * as store from './lib/db.js'
import { createGitLabClient } from './lib/gitlab.js'

export const name = 'dsh-report'
export const inject = ['tools', 'webServer']

const BUILD = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()
const GENERATE_PATH = `${API_PREFIX}/reports/generate`

function sendJSON(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大（>4MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function connectionIdOf(baseUrl) {
  return crypto.createHash('sha256').update(String(baseUrl)).digest('hex').slice(0, 24)
}

export function apply(ctx, rawConfig = {}) {
  const raw = unwrapConfig(rawConfig) ?? {}
  const dataDir = resolveDataDir(raw)
  fs.mkdirSync(dataDir, { recursive: true })
  const logFile = path.join(dataDir, '_boot.log')
  const log = (event, extra) => {
    try {
      fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...(extra ?? {}) })}\n`)
    } catch {
      /* 记录仪自身不影响插件 */
    }
  }
  log('apply-entered', { dataDir, build: BUILD })

  const config = createConfigService({ ctx, rawConfig, log })
  let services
  try {
    services = createServices({ ctx, config, log })
  } catch (error) {
    log('services-failed', { message: String(error?.message ?? error) })
    throw error
  }

  // ---------------------------------------------------------------- 连接端口
  // POST /gitlab/connections：幂等 upsert + 校验（CONTRACTS §5.3.2）
  const connections = {
    async list() {
      const rows = store.listConnections(services.db) ?? []
      return Promise.all(
        rows.map(async (row) => ({
          id: row.connection_id,
          baseUrl: row.base_url,
          displayName: row.display_name,
          username: row.username,
          hasToken: Boolean(await config.resolveToken({ connectionId: row.connection_id })),
        })),
      )
    },
    async create({ baseUrl, token, displayName }) {
      const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '')
      if (!normalized) throw new Error('GitLab 地址不能为空')
      if (!/^https?:\/\//i.test(normalized)) throw new Error('GitLab 地址必须以 http:// 或 https:// 开头')
      const connectionId = connectionIdOf(normalized)
      let username = ''
      let name = displayName || ''
      if (token) {
        const client = createGitLabClient({ baseUrl: normalized, token: String(token).trim() })
        const user = await client.getCurrentUser()
        username = String(user?.username ?? '')
        name = name || String(user?.name ?? '')
        await config.setToken(String(token).trim(), connectionId)
      }
      // 多连接：config.gitlab.baseUrl 只作为旧版单连接兼容值；仅首条连接写入，避免覆盖已有连接。
      const existingConnections = store.listConnections(services.db) ?? []
      if (!existingConnections.some((row) => row.connection_id !== connectionId)) {
        await config.update({ gitlab: { baseUrl: normalized } })
      }
      store.upsertConnection(services.db, {
        connectionId,
        baseUrl: normalized,
        displayName: name,
        username,
        createdAt: new Date().toISOString(),
      })
      const hasToken = Boolean(await config.resolveToken({ connectionId }))
      return { id: connectionId, baseUrl: normalized, displayName: name, username, hasToken }
    },
    async remove(connectionId) {
      const id = String(connectionId ?? '').trim()
      if (!id) throw new Error('connectionId 必填')
      const result = store.deleteConnection(services.db, id)
      await config.clearToken(id)
      log('connection-removed', { connectionId: id, removed: Boolean(result && result.removed) })
      return { removed: Boolean(result && result.removed) }
    },
  }

  // ---------------------------------------------------------------- 工具与 API
  const deps = {
    db: services.db,
    store,
    domain,
    syncService: services.syncService,
    connections,
    getConfig: () => config.getConfig(),
    updateConfig: (patch) => config.update(patch),
    resolveToken: (options) => config.resolveToken(options),
    saveToken: (token, connectionId) => config.setToken(token, connectionId),
    clearToken: (connectionId) => config.clearToken(connectionId),
    getTemplates: () => config.getTemplates(),
    updateTemplates: (patch) => config.updateTemplates(patch),
    getAuthorAliases: () => config.getAuthorAliases(),
    setAuthorAliases: (aliases) => config.setAuthorAliases(aliases),
    suggestAuthorAliases: (input) => services.suggestAuthorAliases(input),
    generateReport: (input) => services.generateReport(input),
    // api.js 的 POST /reports/generate 会调用它（返回 { sessionId, reportId }）
    createReportSession: (input) => services.generateReport(input),
    // api.js 的 /gitlab/connections 校验走它
    createGitLabClient: (options) => createGitLabClient(options),
    logger: log,
    build: BUILD,
    dbPath: services.dbPath,
    dataDir: services.dataDir,
    node: process.version,
  }

  ctx.effect(() => registerTools(ctx, deps), 'dsh-report: tools')

  const clientBundle = (() => {
    try {
      const stat = fs.statSync(new URL('./lib/client.js', import.meta.url))
      return { bytes: stat.size, mtime: Math.round(stat.mtimeMs) }
    } catch {
      return { bytes: 0, mtime: 0 }
    }
  })()
  const apiHandler = createApiHandler(deps)
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === `${API_PREFIX}/client-hello`) {
        log('client-hello', {
          build: url.searchParams.get('build') ?? '',
          clientBytes: clientBundle.bytes,
          clientMtime: clientBundle.mtime,
          ua: String(req.headers?.['user-agent'] ?? '').slice(0, 80),
        })
        sendJSON(res, 200, { ok: true, build: BUILD, client: clientBundle })
        return
      }
      await apiHandler(req, res)
    } catch (error) {
      log('http-failed', { message: String(error?.message ?? error), url: req?.url })
      if (!res.headersSent) sendJSON(res, 500, { error: 'internal', message: String(error?.message ?? error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
    'dsh-report: api routes',
  )

  log('apply-finished', { dbPath: services.dbPath, reports: safeCount(services) })
}

function safeCount(services) {
  try {
    return store.listReportRows(services.db).length
  } catch {
    return 0
  }
}
