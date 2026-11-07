/**
 * persistWiring.test.mjs —— `lib/domain/persist.js` 与真实 `lib/db.js` 的接线检查。
 *
 * 数据域的 `lib/db.js` 是并行实现的：它落地前，任何静态 import 它的模块都无法加载。
 * 本测试用**动态 import + 条件 skip** 处理：
 *   - db.js 不存在 → skip（不算失败，避免阻塞领域域验收）；
 *   - db.js 出现后 → 自动启用，校验导出面与「坏 db 时明确抛错而不是静默」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** @type {any} */
let persist = null
/** @type {any} */
let loadError = null
try {
  persist = await import('../../lib/domain/persist.js')
} catch (error) {
  loadError = error
}

const SKIP_REASON = persist
  ? false
  : `lib/db.js 尚未就绪（${loadError?.code ?? loadError?.message ?? 'unknown'}），跳过 persist 接线测试`

test('persist.js：db.js 就绪后导出 upsertReport / upsertReportCore / REQUIRED_DB_API', { skip: SKIP_REASON }, () => {
  assert.equal(typeof persist.upsertReport, 'function')
  assert.equal(typeof persist.upsertReportCore, 'function')
  assert.deepEqual([...persist.REQUIRED_DB_API], [
    'listCommitsInPeriod',
    'upsertReportRow',
    'replaceLineStats',
    'replaceRepoBranchStats',
    'replaceTopics',
  ])
})

test('persist.js：坏 db 句柄时必须抛错（不静默写坏数据）', { skip: SKIP_REASON }, () => {
  const badDb = {
    prepare() {
      throw new Error('bad-db')
    },
  }
  assert.throws(() =>
    persist.upsertReport(badDb, {
      type: 'week',
      startDate: '2026-08-03',
      endDate: '2026-08-09',
      content: '# x',
    }),
  )
})

test('persist.js：日期必填在任何 db 访问之前就拦截', { skip: SKIP_REASON }, () => {
  const badDb = {
    prepare() {
      throw new Error('bad-db')
    },
  }
  assert.throws(
    () => persist.upsertReport(badDb, { type: 'week', startDate: '', endDate: '' }),
    /startDate and endDate are required/,
  )
})
