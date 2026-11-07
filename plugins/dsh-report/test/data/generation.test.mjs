/**
 * 生成编排：会话复用 + 无数据自动同步 + 未设置范围的提示。
 *
 * 不触网：auto-sync 用例替换 syncService.start/waitForJob，并在 waitForJob 里写入提交。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createServices } from '../../lib/services.js'
import * as store from '../../lib/db.js'

const PERIOD = { type: 'week', startDate: '2026-11-02', endDate: '2026-11-08' }

function makeHarness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-gen-'))
  const events = []
  const sessions = new Set()
  let createCount = 0
  const prompts = []
  const controller = {
    async create() {
      createCount += 1
      const sessionId = `session-${createCount}`
      sessions.add(sessionId)
      return { sessionId }
    },
    async prompt(request) {
      if (!sessions.has(request.sessionId)) throw new Error(`unknown session: ${request.sessionId}`)
      prompts.push(request)
    },
  }
  const config = {
    dataDir,
    getConfig: () => ({}),
    getGitLab: () => ({ baseUrl: 'https://gitlab.example.com' }),
    resolveToken: async () => 'token',
    getTemplates: async () => ({ templates: {}, guidance: {} }),
    getAuthorAliases: () => [],
    update: async () => ({}),
  }
  const services = createServices({
    ctx: { get: (name) => (name === 'sessionController' ? controller : undefined) },
    config,
    log: (event, extra) => events.push({ event, extra }),
  })
  const cleanup = () => {
    try {
      services.db.close?.()
    } catch {
      /* ignore */
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  return { dataDir, events, config, services, controller, prompts, cleanup, createCount: () => createCount }
}

function commitRecord(overrides = {}) {
  return {
    connectionId: 'conn-1',
    projectId: 1,
    commitId: 'abc123',
    message: 'feat: demo',
    title: 'feat: demo',
    authoredDate: '2026-11-03T10:00:00+08:00',
    committedDate: '2026-11-03T10:00:00+08:00',
    authorName: 'leganck',
    authorEmail: 'leganck@outlook.com',
    ...overrides,
  }
}

function addConnection(services, id = 'conn-1') {
  store.upsertConnection(services.db, {
    connectionId: id,
    baseUrl: 'https://gitlab.example.com',
    displayName: 'gitlab',
    username: 'leganck',
    createdAt: new Date().toISOString(),
  })
}

test('没有 GitLab 连接时，生成前提示先去配置连接', async () => {
  const harness = makeHarness()
  try {
    await assert.rejects(
      () => harness.services.generateReport(PERIOD),
      /尚未配置 GitLab 连接/,
    )
  } finally {
    harness.cleanup()
  }
})

test('有连接但没有保存同步仓库范围时，提示去设置范围', async () => {
  const harness = makeHarness()
  try {
    addConnection(harness.services)
    await assert.rejects(
      () => harness.services.generateReport(PERIOD),
      /还没有设置同步仓库范围/,
    )
  } finally {
    harness.cleanup()
  }
})

test('同一份数据范围内连续生成复用同一个 Agent 会话', async () => {
  const harness = makeHarness()
  try {
    addConnection(harness.services)
    store.upsertCommits(harness.services.db, [commitRecord()])
    const first = await harness.services.generateReport(PERIOD)
    const second = await harness.services.generateReport({ ...PERIOD, type: 'month' })
    assert.equal(harness.createCount(), 1)
    assert.equal(harness.prompts.length, 2)
    assert.equal(first.sessionId, second.sessionId)
    const saved = JSON.parse(fs.readFileSync(path.join(harness.dataDir, 'generation-session.json'), 'utf8'))
    assert.equal(saved.sessionId, first.sessionId)
  } finally {
    harness.cleanup()
  }
})

test('范围内没有数据且已设置范围时，自动同步该窗口后再生成', async () => {
  const harness = makeHarness()
  try {
    addConnection(harness.services)
    store.saveSelectedProjects(harness.services.db, 'conn-1', [
      { projectId: 1, pathWithNamespace: 'group/repo', name: 'repo', enabled: 1 },
    ])
    const calls = []
    harness.services.syncService.getSelection = async () => [{ projectId: 1, enabled: 1 }]
    harness.services.syncService.start = async (input) => {
      calls.push(input)
      return { jobId: 'job-1', reused: false, totalProjects: 1 }
    }
    harness.services.syncService.waitForJob = async (jobId) => {
      assert.equal(jobId, 'job-1')
      store.upsertCommits(harness.services.db, [commitRecord()])
      return { status: 'succeeded' }
    }
    const result = await harness.services.generateReport(PERIOD)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { connectionIds: ['conn-1'], startDate: PERIOD.startDate, endDate: PERIOD.endDate })
    assert.equal(harness.prompts.length, 1)
    assert.equal(result.reportId, 'week:2026-11-02:2026-11-08')
    assert.ok(harness.events.some((item) => item.event === 'generate-auto-sync-finish'))
  } finally {
    harness.cleanup()
  }
})

test('保存的会话失效时新建会话并覆盖 generation-session.json', async () => {
  const harness = makeHarness()
  try {
    addConnection(harness.services)
    store.upsertCommits(harness.services.db, [commitRecord()])
    fs.writeFileSync(
      path.join(harness.dataDir, 'generation-session.json'),
      JSON.stringify({ sessionId: 'session-dead' }),
    )
    const result = await harness.services.generateReport(PERIOD)
    assert.equal(harness.createCount(), 1)
    assert.equal(result.sessionId, 'session-1')
    const saved = JSON.parse(fs.readFileSync(path.join(harness.dataDir, 'generation-session.json'), 'utf8'))
    assert.equal(saved.sessionId, 'session-1')
  } finally {
    harness.cleanup()
  }
})
