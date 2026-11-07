/**
 * dayCommits.test.mjs —— 「某天提交」纯函数（对齐 upstream `internal/report/gather.go:174-277`）。
 *
 * 覆盖任务清单 ①-⑦：
 *   ① 跨时区同一 authored_date 只命中该日；② repoKey 大小写/空格/部分路径；
 *   ③ Time 各格式与退化分支；④ branch='未归属 refs' 置空；⑤ title 回退链；
 *   ⑥ 201 条 → total=201/truncated/200 条；⑦ merge+cherry 同条标记。
 *
 * 时区无关写法：无时区格式（`YYYY-MM-DD HH:mm:ss`）输出恒等于输入 HH:mm；
 * 带时区格式用「本机偏移构造 RSC3339」或「用 Date 反推本地钟点」断言，避免依赖运行机器 TZ。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_DAY_COMMITS, commitClock, dayCommits } from '../../lib/domain/dayCommits.js'
import { makeCommit, manyCommits } from './fixtures.mjs'

/** 本机相对 UTC 的 offset 后缀（+08:00 这类）。 */
function localOffsetSuffix(date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  const minutes = String(abs % 60).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

/** 用 Date 直接反推本地 HH:mm（独立于被测实现）。 */
function expectedLocalClock(instant) {
  return `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`
}

test('① dayCommits：只命中 authoredDate 前 10 位等于 date 的提交（不做时区归一）', () => {
  const commits = [
    // 同一时刻的两种写法：前 10 位不同 → 分别归到 08-03 / 08-02
    makeCommit({ commitId: 'a', authoredDate: '2026-08-03T00:30:00+08:00' }),
    makeCommit({ commitId: 'b', authoredDate: '2026-08-02T16:30:00Z' }),
    // 前 10 位是 08-03，但换算 UTC 已是次日 08-04 —— 仍按原串归 08-03
    makeCommit({ commitId: 'c', authoredDate: '2026-08-03T23:59:59-05:00' }),
    // 9 位日期：不满足 len>=10 → 任何一天都不命中
    makeCommit({ commitId: 'd', authoredDate: '2026-08-0' }),
    makeCommit({ commitId: 'e', authoredDate: '' }),
  ]
  const page = dayCommits(commits, '2026-08-03')
  assert.equal(page.date, '2026-08-03')
  assert.equal(page.total, 2)
  assert.equal(page.truncated, false)
  assert.deepEqual(
    page.commits.map((commit) => commit.commitId),
    ['a', 'c'],
  )
  assert.equal('repo' in page, false) // repoKey 未传 → omitempty

  // date 原样比较（Go 不 trim 入参）：带前导空格时一条都不命中
  const unstripped = dayCommits(commits, ' 2026-08-03')
  assert.equal(unstripped.total, 0)
  assert.equal(unstripped.date, ' 2026-08-03')
})

test('② dayCommits：repoKey trim + 大小写不敏感 + 精确匹配（非子串）', () => {
  const commits = [
    makeCommit({ commitId: 'a', pathWithNamespace: 'group/erp-eai', repoName: 'erp-eai' }),
    makeCommit({ commitId: 'b', pathWithNamespace: 'group/ERP-EAI', repoName: 'x' }),
    makeCommit({ commitId: 'c', pathWithNamespace: 'group/erp-eai-web', repoName: 'y' }),
    makeCommit({ commitId: 'd', pathWithNamespace: '', repoName: '' }),
  ]
  // 前后空格 + 大小写混写：a 与 b 都命中（都 lower 成 group/erp-eai）
  const filtered = dayCommits(commits, '2026-08-03', ' GROUP/erp-EAI ')
  assert.equal(filtered.total, 2)
  assert.equal(filtered.repo, 'GROUP/erp-EAI') // 回填 trim 后的入参（保留原大小写）
  assert.deepEqual(
    filtered.commits.map((commit) => commit.commitId),
    ['a', 'b'],
  )
  // 部分路径不命中（精确匹配）
  assert.equal(dayCommits(commits, '2026-08-03', 'erp').total, 0)
  assert.equal(dayCommits(commits, '2026-08-03', 'group/erp-eai-web').total, 1)
  // 空白 repoKey = 全部仓库，且 repo 键不出现
  const all = dayCommits(commits, '2026-08-03', '   ')
  assert.equal(all.total, 4)
  assert.equal('repo' in all, false)
  // 兜底仓库键也参与精确匹配
  assert.equal(dayCommits(commits, '2026-08-03', '未知仓库').total, 1)
})

test('③ commitClock：无时区格式直接取 HH:mm', () => {
  assert.equal(commitClock('2026-08-03 10:15:30'), '10:15')
  assert.equal(commitClock('2026-08-03T10:15:30'), '10:15')
  assert.equal(commitClock('  2026-08-03 00:05:00  '), '00:05')
  assert.equal(commitClock(''), '')
  assert.equal(commitClock('   '), '')
})

test('③ commitClock：RFC3339/RFC3339Nano 转本机时区', () => {
  // 用本机偏移构造 RFC3339 → 输出的本地钟点必然等于构造时的本地钟点
  const local = new Date(2026, 7, 3, 10, 15, 30)
  const suffix = localOffsetSuffix(local)
  assert.equal(commitClock(`2026-08-03T10:15:30${suffix}`), '10:15')
  assert.equal(commitClock(`2026-08-03T10:15:30.123456789${suffix}`), '10:15')
  // Z 写法：用 Date 反推本地钟点
  const utcInstant = new Date(Date.UTC(2026, 7, 3, 2, 30, 0))
  assert.equal(commitClock('2026-08-03T02:30:00Z'), expectedLocalClock(utcInstant))
})

test('③ commitClock：RFC3339 宽松边界（Go 实测：逗号小数秒、offset 上限 24h/60min）', () => {
  // 逗号小数秒 + 超过 9 位小数：Go 都能解析为同一时刻 → 转本地钟点
  const base = new Date(Date.UTC(2026, 7, 3, 2, 30, 0))
  assert.equal(commitClock('2026-08-03T02:30:00,5Z'), expectedLocalClock(base))
  assert.equal(commitClock('2026-08-03T02:30:00.1234567899Z'), expectedLocalClock(base))
  // Go 的 offset 校验是 hr > 24 / mm > 60 才判错 → +24:00、+24:60、+00:60 都合法
  assert.equal(
    commitClock('2026-08-03T02:30:00+24:00'),
    expectedLocalClock(new Date(Date.UTC(2026, 7, 2, 2, 30, 0))),
  )
  assert.equal(
    commitClock('2026-08-03T02:30:00+24:60'),
    expectedLocalClock(new Date(Date.UTC(2026, 7, 2, 1, 30, 0))),
  )
  assert.equal(
    commitClock('2026-08-03T02:30:00+00:60'),
    expectedLocalClock(new Date(Date.UTC(2026, 7, 3, 1, 30, 0))),
  )
  // 超界 offset 解析失败 → 走 T 截取退化
  assert.equal(commitClock('2026-08-03T02:30:00+25:00'), '02:30')
  assert.equal(commitClock('2026-08-03T02:30:00+24:61'), '02:30')
})

test('③ commitClock：解析失败后的截取退化分支与空串', () => {
  // 有 T 且长度足够 → T 之后 5 位
  assert.equal(commitClock('2026-08-03T10:15'), '10:15')
  assert.equal(commitClock('2026-08-03T10:11Z'), '10:11')
  // 有空格且长度 >= 16 → 第 12–16 位
  assert.equal(commitClock('2026-08-03 10:15'), '10:15')
  // Go time.Parse 严格校验日期范围 → 非法月/日/秒解析失败，走 T 截取
  assert.equal(commitClock('2026-02-30T10:11:12Z'), '10:11')
  assert.equal(commitClock('2026-13-45T10:11:12Z'), '10:11')
  assert.equal(commitClock('2026-08-03T10:11:60Z'), '10:11')
  // 其它无法识别 → ''
  assert.equal(commitClock('2026-08-03T10'), '')
  assert.equal(commitClock('2026-08-03X10:15:00'), '')
  assert.equal(commitClock('2026-08-03t10:11:12Z'), '') // Go 只认大写 T
  assert.equal(commitClock('not-a-date'), '')
})

test('③ dayCommits：Time 字段来自 authoredDate（各种格式）', () => {
  const commits = [
    makeCommit({ commitId: 'a', authoredDate: '2026-08-03 09:05:00' }),
    makeCommit({ commitId: 'b', authoredDate: '2026-08-03T09:06:07' }),
    makeCommit({ commitId: 'c', authoredDate: '2026-08-03T09:07' }),
    // 前 10 位是合法日期（能进当天），但时间部分无法解析 → time = ''
    makeCommit({ commitId: 'd', authoredDate: '2026-08-03Xgarbage' }),
  ]
  const page = dayCommits(commits, '2026-08-03')
  assert.deepEqual(
    page.commits.map((commit) => commit.time),
    ['09:05', '09:06', '09:07', ''],
  )
})

test('④ dayCommits：branch 为未归属 refs 时置空（omitempty）', () => {
  const commits = [
    makeCommit({ commitId: 'a', branchNames: ['dev'], primaryBranch: 'main', authoredDate: '2026-08-03T10:00:00' }),
    makeCommit({ commitId: 'b', branchNames: [], primaryBranch: '', authoredDate: '2026-08-03T10:01:00' }),
  ]
  const page = dayCommits(commits, '2026-08-03')
  assert.equal(page.commits[0].branch, 'dev')
  assert.equal('branch' in page.commits[1], false)
})

test('⑤ dayCommits：title 回退链（title → message 首行 → （没有标题））', () => {
  const commits = [
    makeCommit({ commitId: 'a', title: '  feat: real title  ', message: 'body', authoredDate: '2026-08-03T10:00:00' }),
    makeCommit({ commitId: 'b', title: '   ', message: 'fix: fallback\n\nbody', authoredDate: '2026-08-03T10:01:00' }),
    makeCommit({ commitId: 'c', title: '', message: '', authoredDate: '2026-08-03T10:02:00' }),
  ]
  const page = dayCommits(commits, '2026-08-03')
  assert.deepEqual(
    page.commits.map((commit) => commit.title),
    ['feat: real title', 'fix: fallback', '（没有标题）'],
  )
})

test('⑥ dayCommits：上限 200 条（total 为截断前数量）', () => {
  const commits201 = manyCommits(201).map((commit, index) => ({
    ...commit,
    commitId: `id${index}`,
    authoredDate: '2026-08-03T10:00:00',
  }))
  const page = dayCommits(commits201, '2026-08-03')
  assert.equal(MAX_DAY_COMMITS, 200)
  assert.equal(page.total, 201)
  assert.equal(page.truncated, true)
  assert.equal(page.commits.length, 200)
  // 截断保留输入顺序的前 200 条
  assert.equal(page.commits[0].commitId, 'id0')
  assert.equal(page.commits[199].commitId, 'id199')

  const boundary = dayCommits(commits201.slice(0, 200), '2026-08-03')
  assert.equal(boundary.total, 200)
  assert.equal(boundary.truncated, false)
  assert.equal(boundary.commits.length, 200)
})

test('⑦ dayCommits：同条 merge+cherry 两个标记都输出；普通提交不出现标记键', () => {
  const commits = [
    makeCommit({
      commitId: 'a',
      authoredDate: '2026-08-03T10:00:00',
      isMergeCommit: 1,
      isCherryPickCommit: 1,
    }),
    makeCommit({ commitId: 'b', authoredDate: '2026-08-03T10:01:00', title: "Merge branch 'x'" }),
    makeCommit({ commitId: 'c', authoredDate: '2026-08-03T10:02:00', cherryPickSourceCommit: 'abc123' }),
    makeCommit({ commitId: 'd', authoredDate: '2026-08-03T10:03:00', title: 'feat: normal' }),
  ]
  const page = dayCommits(commits, '2026-08-03')
  assert.equal(page.commits[0].merge, true)
  assert.equal(page.commits[0].cherryPick, true)
  assert.equal(page.commits[1].merge, true)
  assert.equal('cherryPick' in page.commits[1], false)
  assert.equal('merge' in page.commits[2], false)
  assert.equal(page.commits[2].cherryPick, true)
  assert.equal('merge' in page.commits[3], false)
  assert.equal('cherryPick' in page.commits[3], false)
})

test('dayCommits：字段口径（commitId 截 8 / 行数缺失当 0 / 顺序保持输入序）', () => {
  const commits = [
    makeCommit({ commitId: '0123456789abcdef', authoredDate: '2026-08-03T10:00:00', additions: 7, deletions: 3 }),
    makeCommit({ commitId: '  abc  ', authoredDate: '2026-08-03T10:01:00', additions: undefined, deletions: null }),
    makeCommit({ commitId: 'abcdefgh', authoredDate: '2026-08-03T10:02:00', additions: 0, deletions: 0 }),
  ]
  const page = dayCommits(commits, '2026-08-03')
  assert.equal(page.commits[0].commitId, '01234567')
  assert.equal(page.commits[0].additions, 7)
  assert.equal(page.commits[0].deletions, 3)
  assert.equal(page.commits[1].commitId, 'abc')
  assert.equal(page.commits[1].additions, 0)
  assert.equal(page.commits[1].deletions, 0)
  assert.equal(page.commits[2].commitId, 'abcdefgh') // 恰好 8 位不截
  // 顺序与输入一致（Go 不排序）
  assert.deepEqual(
    page.commits.map((commit) => commit.commitId),
    ['01234567', 'abc', 'abcdefgh'],
  )
})

test('dayCommits：空输入/非数组返回空页（commits 恒为数组）', () => {
  for (const input of [[], undefined, null]) {
    const page = dayCommits(input, '2026-08-03')
    assert.equal(page.date, '2026-08-03')
    assert.equal(page.total, 0)
    assert.equal(page.truncated, false)
    assert.deepEqual(page.commits, [])
  }
})
