/**
 * 多 GitLab 连接：每个连接一条 token 记录；旧版单 token 只回退给旧配置 baseUrl 对应的连接。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createConfigService, legacyConnectionId, tokenRecordKey } from '../../lib/config.js'

function makeCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) {
      return records.get(key) ?? null
    },
    async modifyRecord(key, updater) {
      records.set(key, await updater(records.get(key) ?? null))
      return records.get(key)
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  }
}

function harness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-config-'))
  const credentials = makeCredentials()
  const service = createConfigService({
    ctx: { get: (name) => (name === 'credentials' ? credentials : undefined) },
    rawConfig: { dataDir, gitlab: { baseUrl: 'https://old.example.com' } },
    log: () => {},
  })
  return {
    service,
    credentials,
    dataDir,
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  }
}

test('不同连接各存各的 token，互不覆盖', async () => {
  const h = harness()
  try {
    await h.service.setToken('token-a', 'conn-a')
    await h.service.setToken('token-b', 'conn-b')
    assert.equal(await h.service.resolveToken({ connectionId: 'conn-a' }), 'token-a')
    assert.equal(await h.service.resolveToken({ connectionId: 'conn-b' }), 'token-b')
    assert.ok(h.credentials.records.has(tokenRecordKey('conn-a')))
    assert.ok(h.credentials.records.has(tokenRecordKey('conn-b')))
  } finally {
    h.cleanup()
  }
})

test('清掉一个连接的 token 不影响其它连接', async () => {
  const h = harness()
  try {
    await h.service.setToken('token-a', 'conn-a')
    await h.service.setToken('token-b', 'conn-b')
    await h.service.clearToken('conn-a')
    assert.equal(await h.service.resolveToken({ connectionId: 'conn-a' }), null)
    assert.equal(await h.service.resolveToken({ connectionId: 'conn-b' }), 'token-b')
  } finally {
    h.cleanup()
  }
})

test('旧版全局 token 只回退给旧配置 baseUrl 对应的连接', async () => {
  const h = harness()
  try {
    await h.service.setToken('legacy-token')
    const legacyId = legacyConnectionId('https://old.example.com')
    assert.equal(await h.service.resolveToken({ connectionId: legacyId }), 'legacy-token')
    assert.equal(await h.service.resolveToken({ connectionId: 'another-connection' }), null)
  } finally {
    h.cleanup()
  }
})

test('credentials 不可用时降级到 tokens.json，仍按连接隔离', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-config-noCred-'))
  try {
    const service = createConfigService({
      ctx: { get: () => undefined },
      rawConfig: { dataDir, gitlab: { baseUrl: '' } },
      log: () => {},
    })
    await service.setToken('file-token-a', 'conn-a')
    await service.setToken('file-token-b', 'conn-b')
    assert.equal(await service.resolveToken({ connectionId: 'conn-a' }), 'file-token-a')
    assert.equal(await service.resolveToken({ connectionId: 'conn-b' }), 'file-token-b')
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8'))
    assert.equal(file.tokens['conn-a'], 'file-token-a')
    assert.equal(file.tokens['conn-b'], 'file-token-b')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
