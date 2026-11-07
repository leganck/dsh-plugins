/**
 * text.test.mjs —— 字符串/数字小工具与 DB 行归一（Go `topics.go:219-257` + `service.go:99-112` 的组装逻辑）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toCommitView, toCommitViews } from '../../lib/domain/commitView.js'
import {
  fallbackJoin,
  fallbackText,
  firstLine,
  min,
  parseJSONArray,
  toFlag,
  toInt,
  toStr,
  trimSpace,
} from '../../lib/domain/text.js'

test('parseJSONArray：空/非法/非字符串数组 → []，正常数组原样返回', () => {
  assert.deepEqual(parseJSONArray(''), [])
  assert.deepEqual(parseJSONArray('null'), []) // Go 得到 nil，两者在调用处等价
  assert.deepEqual(parseJSONArray('not-json'), [])
  assert.deepEqual(parseJSONArray('{"a":1}'), [])
  assert.deepEqual(parseJSONArray('[1,2]'), [])
  assert.deepEqual(parseJSONArray('["a",1]'), [])
  assert.deepEqual(parseJSONArray('["main","dev"]'), ['main', 'dev'])
  assert.deepEqual(parseJSONArray('[]'), [])
  assert.deepEqual(parseJSONArray(null), [])
})

test('firstLine / trimSpace / toStr：对齐 Go 的 TrimSpace + 首行', () => {
  assert.equal(firstLine('a\nb'), 'a')
  assert.equal(firstLine('  a  \n\nb'), 'a')
  assert.equal(firstLine('\r\nb'), '') // \r 被 trim
  assert.equal(firstLine(''), '')
  assert.equal(trimSpace('  x  '), 'x')
  assert.equal(trimSpace(undefined), '')
  assert.equal(toStr(null), '')
  assert.equal(toStr(12), '12')
})

test('fallbackText / fallbackJoin / min', () => {
  assert.equal(fallbackText('  ', '默认'), '默认')
  assert.equal(fallbackText('  x ', '默认'), 'x') // 返回 trim 后的值
  assert.equal(fallbackJoin([], '\n', '无'), '无')
  assert.equal(fallbackJoin(['a', 'b'], '\n', '无'), 'a\nb')
  assert.equal(min(3, 5), 3)
  assert.equal(min(-1, 2), -1)
})

test('toInt / toFlag：库列归一', () => {
  assert.equal(toInt(null), 0)
  assert.equal(toInt('12'), 12)
  assert.equal(toInt(1.9), 1)
  assert.equal(toInt('abc'), 0)
  assert.equal(toFlag(true), 1)
  assert.equal(toFlag(false), 0)
  assert.equal(toFlag('1'), 1)
  assert.equal(toFlag('0'), 0)
  assert.equal(toFlag(2), 1)
  assert.equal(toFlag(null), 0)
})

test('toCommitView：snake_case 行 → CommitView（含 JSON 分支解析、stats 平铺）', () => {
  const view = toCommitView({
    connection_id: 'c1',
    commit_id: 'abc',
    project_id: 7,
    message: 'feat: x\n\nbody',
    authored_date: '2026-08-03 10:00:00',
    committed_date: '2026-08-03 11:00:00',
    author_name: 'dev',
    author_email: 'dev@example.com',
    title: 'feat: x',
    is_merge_commit: 1,
    is_cherry_pick_commit: 0,
    cherry_pick_source_commit: '',
    additions: 10,
    deletions: 2,
    total: 12,
    repo_name: 'erp-eai',
    repo_namespace: 'group',
    path_with_namespace: 'group/erp-eai',
    primary_branch: 'main',
    branch_names_json: '["dev","main"]',
  })
  assert.equal(view.connectionId, 'c1')
  assert.equal(view.commitId, 'abc')
  assert.equal(view.projectId, 7)
  assert.equal(view.authoredDate, '2026-08-03 10:00:00')
  assert.equal(view.isMergeCommit, 1)
  assert.equal(view.isCherryPickCommit, 0)
  assert.equal(view.additions, 10)
  assert.equal(view.pathWithNamespace, 'group/erp-eai')
  assert.deepEqual(view.branchNames, ['dev', 'main'])
})

test('toCommitView：stats 嵌套 / branch_names 直接给数组 / 缺省值兜底', () => {
  const nested = toCommitView({
    commit_id: 'x',
    stats: { additions: 3, deletions: 4, total: 7 },
    branch_names: ['feature'],
  })
  assert.equal(nested.additions, 3)
  assert.equal(nested.deletions, 4)
  assert.equal(nested.total, 7)
  assert.deepEqual(nested.branchNames, ['feature'])
  assert.equal(nested.pathWithNamespace, '')
  assert.equal(nested.isMergeCommit, 0)

  const empty = toCommitView({})
  assert.equal(empty.title, '')
  assert.equal(empty.branchNamesJson, '')
  assert.deepEqual(empty.branchNames, [])
})

test('toCommitView：camelCase 行原样可用（幂等）', () => {
  const source = toCommitView({ commit_id: 'a', branch_names_json: '["main"]', additions: 1 })
  const again = toCommitView(source)
  assert.deepEqual(again, source)
})

test('toCommitViews：非数组输入返回 []', () => {
  assert.deepEqual(toCommitViews(undefined), [])
  assert.deepEqual(toCommitViews(null), [])
  assert.equal(toCommitViews([{}, {}]).length, 2)
})
