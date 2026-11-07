/**
 * classify.test.mjs —— 判定/分类函数的 Go 口径断言。
 *
 * 对应 Go 测试：`internal/report/aggregate_test.go:40-52`（flag 优先），
 * 以及 07 分册 §3.4 的「必须保留的误判」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  currentRefsBranch,
  inferDomain,
  inferTopicTitle,
  isCherryPickCommit,
  isMergeCommit,
  repoPath,
} from '../../lib/domain/classify.js'
import { makeCommit } from './fixtures.mjs'

test('isMergeCommit：stored flag 优先于标题', () => {
  // Go aggregate_test.go:40-52：flag=1 但标题无 merge，仍算 merge
  assert.equal(isMergeCommit(makeCommit({ isMergeCommit: 1, title: 'feat: land helper' })), true)
  assert.equal(isMergeCommit(makeCommit({ isMergeCommit: 0, title: 'feat: land helper' })), false)
  assert.equal(isMergeCommit(makeCommit({ isMergeCommit: true, title: 'feat: x' })), true)
  assert.equal(isMergeCommit(makeCommit({ isMergeCommit: '1', title: 'feat: x' })), true)
})

test('isMergeCommit：标题以 merge 开头也算（含误判用例，必须保留）', () => {
  assert.equal(isMergeCommit(makeCommit({ title: "Merge branch 'x'" })), true)
  assert.equal(isMergeCommit(makeCommit({ title: 'MERGE release' })), true)
  assert.equal(isMergeCommit(makeCommit({ title: '  merge: sync  ' })), true)
  // 07 分册 §3.4：merge-fix / mergeable 都会被判成 merge —— 不得“修好”
  assert.equal(isMergeCommit(makeCommit({ title: 'merge-fix: something' })), true)
  assert.equal(isMergeCommit(makeCommit({ title: 'Mergeable cleanup' })), true)
  // 反例：merging 并不以 "merge" 为前缀（merg-ing），Go HasPrefix 同样为 false
  assert.equal(isMergeCommit(makeCommit({ title: 'merging branch' })), false)
  assert.equal(isMergeCommit(makeCommit({ title: 'feat: merge helper' })), false)
})

test('isCherryPickCommit：flag 或 source 字段任一成立', () => {
  assert.equal(isCherryPickCommit(makeCommit({ isCherryPickCommit: 1 })), true)
  assert.equal(isCherryPickCommit(makeCommit({ cherryPickSourceCommit: 'abc123' })), true)
  assert.equal(
    isCherryPickCommit(makeCommit({ isCherryPickCommit: 0, cherryPickSourceCommit: '' })),
    false,
  )
  // 与 merge 可同时为真（两个独立 if，不是 else-if）
  const both = makeCommit({ isMergeCommit: 1, isCherryPickCommit: 1 })
  assert.equal(isMergeCommit(both) && isCherryPickCommit(both), true)
})

test('inferDomain：6 条规则 + 顺序敏感 + 标题参与匹配', () => {
  const domainOf = (pathWithNamespace, title) =>
    inferDomain(makeCommit({ pathWithNamespace, repoName: '', title }))
  assert.equal(domainOf('group/crm-order', 'feat: x'), 'CRM-订单')
  assert.equal(domainOf('group/crm-member', 'feat: x'), 'CRM-会员')
  assert.equal(domainOf('group/erp-pos', 'feat: x'), 'ERP-POS')
  assert.equal(domainOf('group/erp-print', 'feat: x'), 'ERP-打印')
  assert.equal(domainOf('group/site-web', 'feat: x'), 'SaaS-站点')
  assert.equal(domainOf('group/erp-saas', 'feat: x'), 'SaaS-站点')
  assert.equal(domainOf('group/payment-gw', 'feat: x'), '支付')
  assert.equal(domainOf('group/misc', 'feat: x'), '其他业务')
  // 标题参与匹配：仓库里没有 site，但标题含 site
  assert.equal(domainOf('group/misc', 'feat: site banner'), 'SaaS-站点')
  // 顺序敏感：同时含 crm+order+member 命中第一条
  assert.equal(domainOf('group/crm-order-member', 'feat: x'), 'CRM-订单')
})

test('inferTopicTitle：冒号后段 / 空回退原 title / 末段空回退原串', () => {
  assert.equal(inferTopicTitle(makeCommit({ title: 'feat: add login' })), 'add login')
  assert.equal(inferTopicTitle(makeCommit({ title: 'a:b:c' })), 'c')
  assert.equal(inferTopicTitle(makeCommit({ title: '  no colon  ' })), 'no colon')
  // 末段为空 → 返回原 title（含冒号）
  assert.equal(inferTopicTitle(makeCommit({ title: 'feat: a:' })), 'feat: a:')
  assert.equal(inferTopicTitle(makeCommit({ title: '' })), '提交更新')
  assert.equal(inferTopicTitle(makeCommit({ title: '   ' })), '提交更新')
})

test('repoPath：path_with_namespace → repo_name → 未知仓库', () => {
  assert.equal(repoPath(makeCommit({ pathWithNamespace: 'g/a', repoName: 'a' })), 'g/a')
  assert.equal(repoPath(makeCommit({ pathWithNamespace: '', repoName: 'a' })), 'a')
  assert.equal(repoPath(makeCommit({ pathWithNamespace: '', repoName: '' })), '未知仓库')
})

test('currentRefsBranch：branchNames[0] 优先，空串抢位落到未归属 refs', () => {
  assert.equal(
    currentRefsBranch(makeCommit({ branchNames: ['dev'], primaryBranch: 'main' })),
    'dev',
  )
  assert.equal(currentRefsBranch(makeCommit({ branchNames: [], primaryBranch: 'main' })), 'main')
  assert.equal(currentRefsBranch(makeCommit({ branchNames: [''], primaryBranch: 'main' })), '未归属 refs')
  assert.equal(currentRefsBranch(makeCommit({ branchNames: [], primaryBranch: '' })), '未归属 refs')
})
