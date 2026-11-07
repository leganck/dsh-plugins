/**
 * 配置与凭据（Host 半）。
 *
 * 配置来源：cordis.patch.yml 的 row config（dataDir / gitlab.baseUrl / timezone / defaultReportType）。
 * 运行时写入：configEditor.edit(ctx.fiber.entry, ...) —— 由 Config editor 负责校验与持久化；
 *            不可用时只更新内存并记录警告，不冒充"已保存"。
 * GitLab token：存 DSH credentials 记录（ApiKeyRecord），不落明文配置；
 *            credentials 不可用时降级到 <dataDir>/token.json（0600），并在日志里标注。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

export const TOKEN_RECORD_KEY = 'dsh-report/gitlab-token'

/** 单个连接的 token 记录键：一个连接一条 credentials 记录。 */
export function tokenRecordKey(connectionId) {
  const id = String(connectionId ?? '').trim()
  return id ? `${TOKEN_RECORD_KEY}/${id}` : TOKEN_RECORD_KEY
}

/** 旧版单连接 token 对应的连接 id（按 config.gitlab.baseUrl 派生）。 */
export function legacyConnectionId(baseUrl) {
  const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!normalized) return ''
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24)
}

/** 递归解包 volatile 配置引用。 */
export function unwrapConfig(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') return unwrapConfig(value.get())
  if (Array.isArray(value)) return value.map(unwrapConfig)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      const unwrapped = unwrapConfig(child)
      if (unwrapped !== undefined) out[key] = unwrapped
    }
    return out
  }
  return value
}

export function resolveDataDir(config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  if (!configured) return path.join(home, 'dsh-report')
  return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()))
}

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

/**
 * @param {object} options
 * @param {import('cordis').Context} options.ctx
 * @param {object} options.rawConfig  patch row 的 config（未经解包）
 * @param {(event: string, extra?: object) => void} options.log
 */
export function createConfigService({ ctx, rawConfig, log }) {
  let config = unwrapConfig(rawConfig) ?? {}
  const dataDir = resolveDataDir(config)
  let tokenCache = null
  let tokenCacheAt = 0
  const TOKEN_CACHE_MS = 5000
  const tokenCacheById = new Map()

  const configEditor = ctx.get('configEditor')
  const credentials = ctx.get('credentials')

  function getConfig() {
    const overrides = readOverrides()
    return {
      dataDir,
      timezone: config.timezone || 'Asia/Shanghai',
      defaultReportType: config.defaultReportType || 'week',
      gitlab: {
        baseUrl: normalizeBaseUrl(config.gitlab?.baseUrl),
        tokenRef: config.gitlab?.tokenRef || TOKEN_RECORD_KEY,
        hasToken: Boolean(tokenCache),
        authorAliases: readAuthorAliases(),
      },
      // 覆盖值（不含内置默认；api 层负责与 domain 默认值合并）
      templates: { ...overrides.templates },
      guidance: { ...overrides.guidance },
    }
  }

  /** 同步读取的配置视图（不含异步 token 态）。 */
  function get() {
    const overrides = readOverrides()
    return {
      ...config,
      dataDir,
      templates: { ...overrides.templates },
      guidance: { ...overrides.guidance },
      timezone: config.timezone || 'Asia/Shanghai',
      defaultReportType: config.defaultReportType || 'week',
      gitlab: {
        baseUrl: normalizeBaseUrl(config.gitlab?.baseUrl),
        tokenRef: config.gitlab?.tokenRef || TOKEN_RECORD_KEY,
        authorAliases: readAuthorAliases(),
      },
    }
  }

  function getGitLab() {
    return {
      baseUrl: normalizeBaseUrl(config.gitlab?.baseUrl),
      tokenRef: config.gitlab?.tokenRef || TOKEN_RECORD_KEY,
    }
  }

  function fileTokenPath() {
    return path.join(dataDir, 'token.json')
  }

  function tokensFilePath() {
    return path.join(dataDir, 'tokens.json')
  }

  async function readTokenFromFile() {
    try {
      const raw = fs.readFileSync(fileTokenPath(), 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed?.token === 'string' && parsed.token ? parsed.token : null
    } catch {
      return null
    }
  }

  async function writeTokenToFile(token) {
    const file = fileTokenPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ token, savedAt: new Date().toISOString() }), { mode: 0o600 })
  }

  function readTokenMapFile() {
    try {
      const parsed = JSON.parse(fs.readFileSync(tokensFilePath(), 'utf8'))
      return parsed && typeof parsed.tokens === 'object' && parsed.tokens ? parsed.tokens : {}
    } catch {
      return {}
    }
  }

  function writeTokenMapFile(map) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(tokensFilePath(), JSON.stringify({ tokens: map, savedAt: new Date().toISOString() }, null, 2), {
        mode: 0o600,
      })
    } catch (error) {
      log('tokens-file-write-failed', { message: String(error?.message ?? error) })
    }
  }

  /** 旧版单 token（credentials 记录 / token.json）。 */
  async function readLegacyToken() {
    let token = null
    if (credentials && typeof credentials.readRecord === 'function') {
      try {
        const record = await credentials.readRecord(TOKEN_RECORD_KEY)
        if (record && record.kind === 'api-key' && typeof record.key === 'string') token = record.key
      } catch (error) {
        log('token-read-failed', { message: String(error?.message ?? error) })
      }
    }
    if (!token) token = await readTokenFromFile()
    return token || null
  }

  async function resolveToken(options = {}) {
    const opts = typeof options === 'string' ? { connectionId: options } : options || {}
    const connectionId = String(opts.connectionId ?? '').trim()
    const force = Boolean(opts.force)
    if (!connectionId) {
      if (!force && tokenCache && Date.now() - tokenCacheAt < TOKEN_CACHE_MS) return tokenCache
      tokenCache = await readLegacyToken()
      tokenCacheAt = Date.now()
      return tokenCache
    }
    if (!force && tokenCacheById.has(connectionId) && Date.now() - tokenCacheAt < TOKEN_CACHE_MS) {
      return tokenCacheById.get(connectionId)
    }
    let token = null
    const recordKey = tokenRecordKey(connectionId)
    if (credentials && typeof credentials.readRecord === 'function') {
      try {
        const record = await credentials.readRecord(recordKey)
        if (record && record.kind === 'api-key' && typeof record.key === 'string') token = record.key
      } catch (error) {
        log('token-read-failed', { connectionId, message: String(error?.message ?? error) })
      }
    }
    if (!token) {
      const map = readTokenMapFile()
      if (typeof map[connectionId] === 'string' && map[connectionId]) token = map[connectionId]
    }
    // 旧版单 token 只回退给「旧配置 baseUrl 对应的那个连接」，避免新连接误用别人的 token。
    if (!token && connectionId === legacyConnectionId(config.gitlab?.baseUrl)) {
      token = await readLegacyToken()
    }
    token = token || null
    tokenCacheById.set(connectionId, token)
    tokenCacheAt = Date.now()
    return token
  }

  async function setToken(token, connectionId) {
    const value = String(token ?? '').trim()
    if (!value) return false
    const id = String(connectionId ?? '').trim()
    if (!id) {
      if (credentials && typeof credentials.modifyRecord === 'function') {
        try {
          await credentials.modifyRecord(TOKEN_RECORD_KEY, async () => ({ kind: 'api-key', key: value }))
          tokenCache = value
          tokenCacheAt = Date.now()
          return true
        } catch (error) {
          log('token-write-credentials-failed', { message: String(error?.message ?? error) })
        }
      }
      await writeTokenToFile(value)
      tokenCache = value
      tokenCacheAt = Date.now()
      log('token-write-fallback-file', { file: fileTokenPath() })
      return true
    }

    if (credentials && typeof credentials.modifyRecord === 'function') {
      try {
        await credentials.modifyRecord(tokenRecordKey(id), async () => ({ kind: 'api-key', key: value }))
        tokenCacheById.set(id, value)
        tokenCacheAt = Date.now()
        return true
      } catch (error) {
        log('token-write-credentials-failed', { connectionId: id, message: String(error?.message ?? error) })
      }
    }
    const map = readTokenMapFile()
    map[id] = value
    writeTokenMapFile(map)
    tokenCacheById.set(id, value)
    tokenCacheAt = Date.now()
    log('token-write-fallback-file', { file: tokensFilePath() })
    return true
  }

  async function clearToken(connectionId) {
    const id = String(connectionId ?? '').trim()
    if (!id) {
      if (credentials && typeof credentials.deleteRecord === 'function') {
        try {
          await credentials.deleteRecord(TOKEN_RECORD_KEY)
        } catch {
          /* 忽略 */
        }
      }
      try {
        fs.rmSync(fileTokenPath(), { force: true })
      } catch {
        /* 忽略 */
      }
      tokenCache = null
      tokenCacheAt = Date.now()
      return
    }
    if (credentials && typeof credentials.deleteRecord === 'function') {
      try {
        await credentials.deleteRecord(tokenRecordKey(id))
      } catch {
        /* 忽略 */
      }
    }
    const map = readTokenMapFile()
    if (map[id]) {
      delete map[id]
      writeTokenMapFile(map)
    }
    tokenCacheById.delete(id)
    tokenCacheAt = Date.now()
  }

  // ------------------------------------------------------------ 模板与写作指引
  // 覆盖值存 <dataDir>/prompts.json；空字符串 = 删除覆盖（回退内置默认）。

  function promptsFilePath() {
    return path.join(dataDir, 'prompts.json')
  }

  // ------------------------------------------------------------ 提交作者别名
  // 存 <dataDir>/author-aliases.json（与 prompts.json 同目录，跨插件升级保留）。
  function authorAliasesFilePath() {
    return path.join(dataDir, 'author-aliases.json')
  }

  function readAuthorAliases() {
    try {
      const parsed = JSON.parse(fs.readFileSync(authorAliasesFilePath(), 'utf8'))
      const list = Array.isArray(parsed?.aliases) ? parsed.aliases : []
      const seen = new Set()
      const out = []
      for (const item of list) {
        const value = String(item ?? '').trim()
        const key = value.toLowerCase()
        if (!value || seen.has(key)) continue
        seen.add(key)
        out.push(value)
      }
      return out
    } catch {
      return []
    }
  }

  function writeAuthorAliases(list) {
    const next = Array.isArray(list) ? list : []
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(authorAliasesFilePath(), JSON.stringify({ aliases: next }, null, 2))
    return next
  }

  function getAuthorAliases() {
    return readAuthorAliases()
  }

  function setAuthorAliases(list) {
    return writeAuthorAliases(Array.isArray(list) ? list : [])
  }

  function readOverrides() {
    try {
      const parsed = JSON.parse(fs.readFileSync(promptsFilePath(), 'utf8'))
      return {
        templates: parsed?.templates && typeof parsed.templates === 'object' ? parsed.templates : {},
        guidance: parsed?.guidance && typeof parsed.guidance === 'object' ? parsed.guidance : {},
      }
    } catch {
      return { templates: {}, guidance: {} }
    }
  }

  function writeOverrides(overrides) {
    const file = promptsFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(overrides, null, 2))
  }

  async function loadDefaults() {
    const module = await import('./domain/briefDefaults.js')
    return {
      templates: { ...(module.DEFAULT_TEMPLATES || {}) },
      guidance: { ...(module.DEFAULT_GUIDANCE || {}) },
    }
  }

  async function getTemplates() {
    const defaults = await loadDefaults()
    const overrides = readOverrides()
    return {
      templates: { ...defaults.templates, ...overrides.templates },
      guidance: { ...defaults.guidance, ...overrides.guidance },
    }
  }

  /** 部分更新：出现的键覆盖；空字符串删除覆盖。 */
  async function updateTemplates(patch) {
    const overrides = readOverrides()
    for (const section of ['templates', 'guidance']) {
      const values = patch?.[section]
      if (!values || typeof values !== 'object') continue
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string') continue
        if (value.trim() === '') delete overrides[section][key]
        else overrides[section][key] = value
      }
    }
    writeOverrides(overrides)
    return getTemplates()
  }

  /** 合并 patch 并尽力持久化到 profile 的 cordis.patch.yml（失败返回 persisted:false）。 */
  async function update(patch) {
    const next = {
      ...config,
      ...('timezone' in (patch || {}) ? { timezone: patch.timezone } : {}),
      ...('defaultReportType' in (patch || {}) ? { defaultReportType: patch.defaultReportType } : {}),
      ...('dataDir' in (patch || {}) ? { dataDir: patch.dataDir } : {}),
      gitlab: {
        ...(config.gitlab || {}),
        ...(patch?.gitlab?.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(patch.gitlab.baseUrl) } : {}),
        ...(patch?.gitlab?.tokenRef !== undefined ? { tokenRef: patch.gitlab.tokenRef } : {}),
      },
    }
    if (Array.isArray(patch?.gitlab?.authorAliases)) writeAuthorAliases(patch.gitlab.authorAliases)
    if (patch?.gitlab?.token) await setToken(patch.gitlab.token)
    if (patch?.templates || patch?.guidance) await updateTemplates({ templates: patch.templates, guidance: patch.guidance })
    let persisted = false
    if (configEditor && typeof configEditor.edit === 'function' && ctx.fiber?.entry) {
      try {
        await configEditor.edit(ctx.fiber.entry, (current) => ({
          ...current,
          timezone: next.timezone,
          defaultReportType: next.defaultReportType,
          dataDir: next.dataDir ?? '',
          gitlab: { ...(current.gitlab || {}), baseUrl: next.gitlab.baseUrl, tokenRef: next.gitlab.tokenRef },
        }))
        persisted = true
      } catch (error) {
        log('config-persist-failed', { message: String(error?.message ?? error) })
      }
    }
    config = next
    return { config: get(), persisted }
  }

  return {
    getConfig,
    get,
    getGitLab,
    resolveToken,
    setToken,
    clearToken,
    getTemplates,
    updateTemplates,
    getAuthorAliases,
    setAuthorAliases,
    update,
    // tools.js / api.js 的 createRuntime 期望的别名
    updateConfig: update,
    saveToken: setToken,
    dataDir,
  }
}
