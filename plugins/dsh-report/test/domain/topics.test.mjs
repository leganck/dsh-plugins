/**
 * topics.test.mjs —— 主题候选聚合（Go `buildTopics`）断言：归属桶、计数降序、sortOrder、固定摘要文案。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTopics } from '../../lib/domain/topics.js'
import { makeCommit } from './fixtures.mjs'

test('buildTopics：按 (domain, topicTitle) 分桶，计数降序编号，摘要为固定文案', () => {
  const commits = [
    // CRM-订单 / login ×2
    makeCommit({ commitId: '1', pathWithNamespace: 'group/crm-order', title: 'feat: login' }),
    makeCommit({ commitId: '2', pathWithNamespace: 'group/crm-order', title: 'fix: login' }),
    // 支付 / payment callback
    makeCommit({ commitId: '3', pathWithNamespace: 'group/payment-svc', title: 'feat: payment callback' }),
    // SaaS-站点 / dashboard
    makeCommit({ commitId: '4', pathWithNamespace: 'group/site-web', title: 'feat: dashboard' }),
    // 其他业务 / 提交更新（无标题）
    makeCommit({ commitId: '5', pathWithNamespace: 'group/misc', title: '', message: 'fix: x\n\nbody' }),
  ]
  const topics = buildTopics(commits)
  assert.deepEqual(topics, [
    { domain: 'CRM-订单', topicTitle: 'login', summary: '2 次提交', sortOrder: 1 },
    { domain: '支付', topicTitle: 'payment callback', summary: '1 次提交', sortOrder: 2 },
    { domain: 'SaaS-站点', topicTitle: 'dashboard', summary: '1 次提交', sortOrder: 3 },
    { domain: '其他业务', topicTitle: '提交更新', summary: '1 次提交', sortOrder: 4 },
  ])
})

test('buildTopics：同 topicTitle 不同 domain 不合并；同一 domain 不同标题也不合并', () => {
  const commits = [
    makeCommit({ commitId: '1', pathWithNamespace: 'group/crm-order', title: 'feat: sync' }),
    makeCommit({ commitId: '2', pathWithNamespace: 'group/payment-svc', title: 'feat: sync' }),
    makeCommit({ commitId: '3', pathWithNamespace: 'group/crm-order', title: 'feat: export' }),
  ]
  const topics = buildTopics(commits)
  assert.equal(topics.length, 3)
  assert.deepEqual(
    topics.map((topic) => `${topic.domain}/${topic.topicTitle}`),
    ['CRM-订单/sync', '支付/sync', 'CRM-订单/export'],
  )
  // sortOrder 恒为 1..N
  assert.deepEqual(
    topics.map((topic) => topic.sortOrder),
    [1, 2, 3],
  )
})

test('buildTopics：空输入返回空数组（不是 null）', () => {
  assert.deepEqual(buildTopics([]), [])
  assert.deepEqual(buildTopics(undefined), [])
})
