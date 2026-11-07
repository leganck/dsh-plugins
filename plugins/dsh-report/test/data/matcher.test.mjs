/**
 * lib/matcher.js 单测：照 workbench `buildCommitMatcher` 的规则表驱动。
 * 规则来源：internal/repository/commitimport/service.go:594-727（见 05 分册 §③）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CO_AUTHOR_TRAILER_PATTERN,
  buildCommitMatcher,
  normalizeIdentity,
  parseAliasList,
} from '../../lib/matcher.js'

const USER = {
  id: 7,
  name: 'Current User',
  username: 'current-user',
  email: 'primary@example.com',
  public_email: 'public@example.com',
  commit_email: 'commit@example.com',
}

const USER_EMAILS = [{ id: 1, email: 'verified@example.com' }, { id: 2, email: ' SECOND@example.com ' }]

/** 构造 matcher（默认用户 + 已验证邮箱 + 别名）。 */
function matcherWith(aliases = ['legacy@example.com', 'legacy-name']) {
  return buildCommitMatcher({ user: USER, userEmails: USER_EMAILS, aliases })
}

test('normalizeIdentity 只做 lower + trim', () => {
  assert.equal(normalizeIdentity('  Foo BAR  '), 'foo bar')
  assert.equal(normalizeIdentity(null), '')
  assert.equal(normalizeIdentity(undefined), '')
  // 不折叠中间空格、不做 Unicode 归一（业务定制口径）
  assert.equal(normalizeIdentity('foo  bar'), 'foo  bar')
})

test('parseAliasList 按 \\n , ; 切分并去重前规范化', () => {
  assert.deepEqual(parseAliasList(['a@x.com, b-name', 'c@x.com;d-name']), ['a@x.com', 'b-name', 'c@x.com', 'd-name'])
  assert.deepEqual(parseAliasList('one\ntwo,three;four'), ['one', 'two', 'three', 'four'])
  assert.deepEqual(parseAliasList([]), [])
  assert.deepEqual(parseAliasList(['', '  ', ',']), [])
})

test('归属规则表（全量）', () => {
  const cases = [
    {
      name: 'profile commit_email 命中 author_email',
      commit: { author_email: 'commit@example.com' },
      expected: { matched: true, evidence: 'commit_email', identity: 'commit@example.com' },
    },
    {
      name: 'profile email（大小写/空白归一后）命中',
      commit: { author_email: '  PRIMARY@Example.com ' },
      expected: { matched: true, evidence: 'commit_email', identity: 'primary@example.com' },
    },
    {
      name: 'profile public_email 命中 committer_email',
      commit: { committer_email: 'public@example.com' },
      expected: { matched: true, evidence: 'commit_email', identity: 'public@example.com' },
    },
    {
      name: '/user/emails 命中 author_email',
      commit: { author_email: 'verified@example.com' },
      expected: { matched: true, evidence: 'verified_email', identity: 'verified@example.com' },
    },
    {
      name: '/user/emails 大小写归一命中',
      commit: { author_email: 'second@example.com' },
      expected: { matched: true, evidence: 'verified_email', identity: 'second@example.com' },
    },
    {
      name: '含 @ 的别名命中 author_email',
      commit: { author_email: 'legacy@example.com' },
      expected: { matched: true, evidence: 'verified_email', identity: 'legacy@example.com' },
    },
    {
      name: 'author_name 等于 name（identity）',
      commit: { author_name: 'Current User' },
      expected: { matched: true, evidence: 'identity', identity: 'current user' },
    },
    {
      name: 'author_name 等于 username（identity）',
      commit: { author_name: 'current-user' },
      expected: { matched: true, evidence: 'identity', identity: 'current-user' },
    },
    {
      name: 'committer_name 等于别名（identity）',
      commit: { committer_name: 'Legacy-Name' },
      expected: { matched: true, evidence: 'identity', identity: 'legacy-name' },
    },
    {
      name: 'author_email 等于别名（不含 @ 的别名进 identity 层）',
      commit: { author_email: 'legacy-name' },
      expected: { matched: true, evidence: 'identity', identity: 'legacy-name' },
    },
    {
      name: 'Co-authored-by 邮箱命中（<...> 形式）',
      commit: { message: 'feat: pair work\n\nCo-authored-by: Other <verified@example.com>' },
      expected: { matched: true, evidence: 'coauthor', identity: 'verified@example.com' },
    },
    {
      name: 'Co-authored-by 名字命中（无邮箱形式）',
      commit: { message: 'feat\n\nco-authored-by: Current User' },
      expected: { matched: true, evidence: 'coauthor', identity: 'current user' },
    },
    {
      name: 'Co-authored-by 别名命中（大小写不敏感）',
      commit: { message: 'x\n\nCo-Authored-By: LEGACY-NAME <nobody@example.com>' },
      expected: { matched: true, evidence: 'coauthor', identity: 'legacy-name' },
    },
    {
      name: '完全无关的提交不命中',
      commit: { author_email: 'other@example.com', author_name: 'Other User', committer_email: 'x@y.com' },
      expected: { matched: false },
    },
    {
      name: '正文提到但不含 trailer 不命中',
      commit: { message: 'see @current-user and legacy-name in docs' },
      expected: { matched: false },
    },
    {
      name: '空提交不报错、不命中',
      commit: {},
      expected: { matched: false },
    },
  ]

  const matcher = matcherWith()
  for (const item of cases) {
    const actual = matcher(item.commit)
    if (item.expected.matched) {
      assert.equal(actual.matched, true, `${item.name}：应命中`)
      assert.equal(actual.evidence, item.expected.evidence, `${item.name}：evidence`)
      assert.equal(actual.identity, item.expected.identity, `${item.name}：identity`)
    } else {
      assert.equal(actual.matched, false, `${item.name}：不应命中`)
      assert.equal(actual.evidence, undefined)
    }
  }
})

test('evidence 只可能是 4 种标签之一', () => {
  const allowed = new Set(['commit_email', 'verified_email', 'identity', 'coauthor'])
  const matcher = matcherWith()
  const samples = [
    { author_email: 'commit@example.com' },
    { author_email: 'verified@example.com' },
    { author_name: 'current user' },
    { message: 'x\n\nCo-authored-by: Current User' },
    { author_email: 'nobody@example.com' },
  ]
  for (const commit of samples) {
    const result = matcher(commit)
    if (result.matched) assert.ok(allowed.has(result.evidence), `非法 evidence：${result.evidence}`)
  }
})

test('verified 邮箱优先于 identity（同一提交两者都命中时）', () => {
  const matcher = buildCommitMatcher({
    user: { name: 'Dev Name', username: 'dev', email: 'dev@example.com' },
    userEmails: [],
    aliases: ['dev name'],
  })
  // author_name 命中 identity、author_email 命中 profile 邮箱 → 应返回 commit_email
  const result = matcher({ author_email: 'dev@example.com', author_name: 'Dev Name' })
  assert.equal(result.evidence, 'commit_email')
})

test('author 优先于 committer（Go 顺序）', () => {
  const matcher = buildCommitMatcher({
    user: { email: 'me@example.com' },
    userEmails: [],
    aliases: [],
  })
  const result = matcher({ author_email: 'me@example.com', committer_email: 'me@example.com' })
  assert.equal(result.evidence, 'commit_email')
  assert.equal(result.identity, 'me@example.com')
})

test('别名兼容字符串输入（换行/逗号/分号）', () => {
  const matcher = buildCommitMatcher({
    user: { username: 'u1' },
    aliases: 'a@example.com\nb-name,c@example.com;d-name',
  })
  assert.equal(matcher({ author_email: 'a@example.com' }).evidence, 'verified_email')
  assert.equal(matcher({ author_name: 'b-name' }).evidence, 'identity')
  assert.equal(matcher({ author_email: 'c@example.com' }).evidence, 'verified_email')
  assert.equal(matcher({ author_name: 'd-name' }).evidence, 'identity')
})

test('Co-authored-by 正则支持多行与复数 trailer', () => {
  const message = 'feat: pair\n\nCo-authored-by: A <a@example.com>\nCo-authored-by: Current User <nobody@example.com>'
  const matches = [...message.matchAll(CO_AUTHOR_TRAILER_PATTERN)]
  assert.equal(matches.length, 2)
  assert.equal(matches[1][1].trim(), 'Current User')
  assert.equal(matches[1][2], 'nobody@example.com')
})

test('userEmails 支持字符串数组与空值（静默降级）', () => {
  const matcher = buildCommitMatcher({ user: USER, userEmails: ['solo@example.com', null], aliases: [] })
  assert.equal(matcher({ author_email: 'solo@example.com' }).evidence, 'verified_email')
  assert.equal(matcher({ author_email: 'commit@example.com' }).evidence, 'commit_email')
  // 空 userEmails：profile 邮箱仍生效
  const degraded = buildCommitMatcher({ user: USER, userEmails: [], aliases: [] })
  assert.equal(degraded({ author_email: 'commit@example.com' }).matched, true)
})
