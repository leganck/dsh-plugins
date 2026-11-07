/**
 * index.test.mjs —— 统一出口的完整性检查。
 *
 * 目的：
 *   - 保证 `lib/domain/index.js` 在**没有** `lib/db.js` 时也能被 import（所以不 re-export persist.js）；
 *   - 保证 CONTRACTS §3 要求的函数都从统一出口可见。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as domain from '../../lib/domain/index.js'

const REQUIRED_EXPORTS = [
  // CONTRACTS §3 必需
  'isMergeCommit',
  'isCherryPickCommit',
  'inferDomain',
  'inferTopicTitle',
  'repoPath',
  'currentRefsBranch',
  'aggregate',
  'buildLineStats',
  'buildRepoBranchStats',
  'buildRepoCards',
  'buildRealtimeAnalytics',
  'buildTopics',
  'gatherCommits',
  'getWeekRange',
  'getMonthRange',
  'getQuarterRange',
  'getYearRange',
  'makeRange',
  'buildReportId',
  'parseReportId',
  'REPORT_TYPES',
  'formatReportType',
  'getReportBrief',
  'HOST_INSTRUCTIONS',
  'DEFAULT_TEMPLATES',
  'DEFAULT_GUIDANCE',
  'upsertReportCore',
  'upsertReport',
]

test('index.js：CONTRACTS §3 的函数全部可见', () => {
  for (const name of REQUIRED_EXPORTS) {
    assert.notEqual(domain[name], undefined, `index.js 缺少导出：${name}`)
  }
  assert.equal(typeof domain.gatherCommits, 'function')
  assert.deepEqual([...domain.REPORT_TYPES], ['week', 'month', 'quarter', 'year'])
})

test('index.js：显式 re-export upsertReport（工具层 report_update 走 domain.upsertReport）', () => {
  assert.equal(typeof domain.upsertReport, 'function')
  // persistCore 的导出不能被 persist.js 的 star export 歧义吞掉
  assert.equal(typeof domain.upsertReportCore, 'function')
  assert.deepEqual([...domain.REQUIRED_DB_API], [
    'listCommitsInPeriod',
    'upsertReportRow',
    'replaceLineStats',
    'replaceRepoBranchStats',
    'replaceTopics',
  ])
})

test('index.js：协议常量与 hint 文案可见', () => {
  assert.equal(domain.BRANCH_MODE, 'current_refs_first_auxiliary')
  assert.equal(domain.GATHER_HINT_MORE.startsWith('More commits remain.'), true)
  assert.equal(domain.GATHER_HINT_COMPLETE.startsWith('Page complete.'), true)
  assert.equal(domain.DEFAULT_GATHER_COMMIT_LIMIT, 40)
  assert.equal(domain.MAX_GATHER_COMMIT_LIMIT, 80)
})
