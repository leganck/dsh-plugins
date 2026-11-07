/**
 * Host 服务组合：DB、配置、GitLab 同步、报告生成编排。
 *
 * 由 index.js 调用 createServices({ctx, config, log})，返回 deps 供 lib/tools.js 与 lib/api.js 使用。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { openDatabase, listCommitsInPeriod, getConnection, listConnections } from './db.js'
import { createGitLabClient } from './gitlab.js'
import { createSyncService } from './sync.js'
import { buildReportId, formatReportType } from './domain/ids.js'
import { getReportBrief } from './domain/brief.js'
import {
  suggestAuthorAliasesForConnection,
  formatAuthorAliasSuggestMessage,
  mergeAliases,
  parseAliasList,
} from './authorAliases.js'

/**
 * 生成报告的系统提示：要求模型按 workbench 的 brief → stats → commits → update 链路工作。
 * 说明：不把整篇正文塞回聊天，只回摘要。
 */
function buildGenerationPrompt({ brief, type, startDate, endDate, reportId }) {
  const typeLabel = formatReportType(type)
  return [
    `你是「报告助手」。请为 ${typeLabel} ${startDate} ~ ${endDate}（reportId=${reportId}）生成一份 Markdown 报告。`,
    '',
    '工作步骤（必须按顺序）：',
    '1. 调用 report_brief 读取模板、写作指引与 hostInstructions；严格按模板结构与写作要求。',
    '2. 调用 report_stats 查看该周期的确定性统计（行数三口径、仓库分布、业务域、topic）。',
    '3. 调用 report_commits 分页拉取精简提交明细（limit/offset；hasMore=true 时继续翻页；大仓库可传 repo 子串）。',
    '4. 基于以上数据撰写 Markdown 正文；不要编造数据，不要输出仓库 URL 或密钥。',
    `5. 调用 report_update 保存：type=${type}、startDate=${startDate}、endDate=${endDate}、content=正文。`,
    '',
    '完成后只回复一段简短摘要（报告类型/周期/关键数字），不要把正文再贴一遍。',
    '',
    '—— 报告契约（report_brief 的等价内容，供参考）——',
    `报告类型：${typeLabel}`,
    `周期：${brief.period}`,
    '',
    '【模板】',
    brief.template || '（无模板，按通用周报结构撰写）',
    '',
    '【写作指引】',
    brief.guidance || '（无额外指引）',
    '',
    '【硬性要求】',
    brief.hostInstructions || '',
  ].join('\n')
}

/**
 * @param {object} options
 * @param {import('cordis').Context} options.ctx
 * @param {{ get: Function, getConfig: Function, getGitLab: Function, resolveToken: Function,
 *           getTemplates: Function, updateTemplates: Function, update: Function, dataDir: string }} options.config
 * @param {(event: string, extra?: object) => void} options.log
 */
export function createServices({ ctx, config, log }) {
  const dataDir = config.dataDir
  const dbPath = path.join(dataDir, 'report.db')
  const db = openDatabase(dbPath)
  log('db-open', { dbPath })

  /** 每个连接一个 GitLab 客户端（当前仅支持单连接：baseUrl + token 来自 config/credentials）。 */
  async function gitlabForConnection(connectionId) {
    // 多连接：优先取 connections 表里该连接的 base_url；config 只作为单连接回退。
    let rowBaseUrl = ''
    const id = String(connectionId ?? '').trim()
    if (id) {
      try {
        const row = getConnection(db, id)
        rowBaseUrl = String(row?.baseUrl ?? row?.base_url ?? '').trim()
      } catch {
        rowBaseUrl = ''
      }
    }
    const { baseUrl: configBaseUrl } = config.getGitLab()
    const baseUrl = rowBaseUrl || configBaseUrl
    if (!baseUrl) throw new Error('尚未配置 GitLab 地址（设置 → GitLab 连接）')
    const token = await config.resolveToken()
    if (!token) throw new Error('尚未配置 GitLab Access Token（设置 → GitLab 连接）')
    return createGitLabClient({ baseUrl, token })
  }

  const syncService = createSyncService({ db, config, gitlabForConnection, logger: log })

  /** 读取区间提交（供工具/API/统计使用）。 */
  function getCommitsInPeriod(startDate, endDate) {
    return listCommitsInPeriod(db, { startDate, endDate })
  }

  /**
   * 触发报告生成：创建 DSH 会话 + 发送指令；页面轮询 /reports 等待 report_update 落库。
   */
  /**
   * 推断「提交作者别名」：对给定连接采样最近 push 头提交的作者身份。
   * @param {{ connectionIds?: string[], existingAliases?: string[] }} options
   */
  async function suggestAuthorAliases({ connectionIds = [], existingAliases = [] } = {}) {
    const rows = listConnections(db)
    if (!rows.length) throw new Error('还没有 GitLab 连接，请先在设置里保存连接')
    const wanted = new Set((Array.isArray(connectionIds) ? connectionIds : []).map((id) => String(id || '').trim()).filter(Boolean))
    const existing = parseAliasList(existingAliases)
    const connections = []
    const suggested = []
    for (const row of rows) {
      const connectionId = String(row.connection_id ?? row.connectionId ?? '')
      if (wanted.size && !wanted.has(connectionId)) continue
      const item = {
        connectionId,
        connectionName: String(row.display_name ?? row.displayName ?? ''),
        username: '',
        displayName: '',
        knownIdentities: [],
        candidates: [],
        suggestedAliases: [],
        sampledEvents: 0,
        sampledCommits: 0,
        error: '',
      }
      try {
        const client = await gitlabForConnection(connectionId)
        const result = await suggestAuthorAliasesForConnection({ client, existingAliases: existing })
        Object.assign(item, result, { connectionId, connectionName: item.connectionName })
      } catch (error) {
        item.error = String(error?.message ?? error)
      }
      connections.push(item)
      for (const alias of item.suggestedAliases) {
        if (!parseAliasList(suggested).some((value) => value.toLowerCase() === String(alias).toLowerCase())) suggested.push(alias)
      }
    }
    const suggestedAliases = mergeAliases(suggested, [])
    const mergedAliases = mergeAliases(existing, suggestedAliases)
    return {
      success: true,
      connections,
      suggestedAliases,
      mergedAliases,
      message: formatAuthorAliasSuggestMessage(suggestedAliases),
    }
  }

  // ---------------------------------------------------------------- 生成会话（所有报告共用一个）
  const SESSION_FILE = path.join(dataDir, 'generation-session.json')

  function readStoredSessionId() {
    try {
      const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
      return String(parsed && parsed.sessionId ? parsed.sessionId : '')
    } catch {
      return ''
    }
  }

  function writeStoredSessionId(sessionId) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(
        SESSION_FILE,
        JSON.stringify({ sessionId: String(sessionId), updatedAt: new Date().toISOString() }, null, 2),
      )
    } catch (error) {
      log('generation-session-persist-failed', { message: String(error && error.message ? error.message : error) })
    }
  }

  function isMissingSessionError(error) {
    const message = String((error && (error.message || error.code)) || '')
    return /unknown session|session not found|not found|不存在|已删除|does not exist|invalid session/i.test(message)
  }

  /**
   * 生成前确保范围内有数据：
   *   - 有数据 → 直接生成；
   *   - 没数据 → 用设置里的连接 + 已保存仓库范围自动同步该窗口；
   *   - 没有连接/没有范围 → 抛可读错误，前端提示去设置。
   */
  async function ensureCommitsForRange(startDate, endDate) {
    const existing = getCommitsInPeriod(startDate, endDate)
    if (existing.length) return { autoSynced: false, commits: existing.length }

    const connections = listConnections(db)
    if (!connections.length) {
      throw new Error('该日期范围内还没有提交数据，且尚未配置 GitLab 连接：请先到 设置 → 报告与统计 保存连接并设置同步仓库范围。')
    }
    let target = null
    for (const connection of connections) {
      let selection = []
      try {
        selection = await syncService.getSelection(connection.connectionId)
      } catch (error) {
        log('generate-scope-read-failed', { connectionId: connection.connectionId, message: String(error && error.message ? error.message : error) })
      }
      if (selection.some((item) => Number(item.enabled ?? 1) !== 0)) {
        target = connection
        break
      }
    }
    if (!target) {
      throw new Error('该日期范围内还没有提交数据，且还没有设置同步仓库范围：请先到 设置 → 报告与统计 → 同步仓库范围 选择仓库。')
    }

    log('generate-auto-sync-start', { connectionId: target.connectionId, startDate, endDate })
    const job = await syncService.start({
      connectionId: target.connectionId,
      startDate,
      endDate,
    })
    const done = await syncService.waitForJob(job.jobId)
    const status = String((done && done.status) || '')
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`该范围内没有数据，自动同步未成功（${status}）：${(done && done.error) || '请到任务历史查看原因'}`)
    }
    const after = getCommitsInPeriod(startDate, endDate)
    if (!after.length) {
      throw new Error('自动同步已完成，但该范围内仍然没有提交：请确认同步仓库范围是否包含有提交的仓库。')
    }
    log('generate-auto-sync-finish', { jobId: job.jobId, commits: after.length })
    return { autoSynced: true, commits: after.length, jobId: job.jobId }
  }

  async function generateReport({ type, startDate, endDate, guidance }) {
    if (!type || !startDate || !endDate) throw new Error('type/startDate/endDate 必填')
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.create !== 'function') {
      throw new Error('当前 profile 没有 sessionController，无法创建生成会话')
    }
    await ensureCommitsForRange(startDate, endDate)

    const templates = await config.getTemplates()
    const brief = getReportBrief({
      type,
      startDate,
      endDate,
      template: templates.templates?.[type],
      guidance: guidance && String(guidance).trim() ? String(guidance) : templates.guidance?.[type],
    })
    const reportId = buildReportId(type, startDate, endDate)
    let text = buildGenerationPrompt({ brief, type, startDate, endDate, reportId })
    const authorAliases = typeof config.getAuthorAliases === 'function' ? config.getAuthorAliases() : []
    if (authorAliases.length) {
      text += '\n\n【本人提交作者别名】\n' + authorAliases.join('、') + '\n（这些作者身份提交的提交也算本人的工作。）'
    }

    const storedSessionId = readStoredSessionId()
    const promptInto = (sessionId) => {
      // DSH 0.2.2 的 sessionController.prompt(request, signal) 需要 AbortSignal（缺少时内部 throwIfAborted 会报错）
      const abort = new AbortController()
      return controller.prompt(
        {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        abort.signal,
      )
    }

    let sessionId = storedSessionId
    if (sessionId) {
      try {
        await promptInto(sessionId)
        log('generate-session-reused', { sessionId, reportId })
        return { reportId, sessionId }
      } catch (error) {
        if (!isMissingSessionError(error)) throw error
        log('generate-session-stale', { sessionId, message: String(error && error.message ? error.message : error) })
        sessionId = ''
      }
    }

    const created = await controller.create({})
    sessionId = created.sessionId
    await promptInto(sessionId)
    writeStoredSessionId(sessionId)
    log('generate-session-created', { sessionId, reportId })
    return { reportId, sessionId }
  }

  return {
    ctx,
    config,
    db,
    dbPath,
    dataDir,
    syncService,
    gitlabForConnection,
    getCommitsInPeriod,
    generateReport,
    suggestAuthorAliases,
    log,
  }
}
