import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALIAS_MAX_TIP_COMMITS,
  formatAuthorAliasSuggestMessage,
  mergeAliases,
  normalizeIdentity,
  parseAliasList,
  suggestAuthorAliasesForConnection,
} from '../../lib/authorAliases.js'

function fakeClient({ user, emails, events, commits }) {
  return {
    async getCurrentUser() {
      return user
    },
    async getUserEmails() {
      return emails
    },
    async listEvents({ page }) {
      return page === 1 ? events : []
    },
    async getCommit(projectId, sha) {
      const key = `${projectId}:${sha}`
      if (!(key in commits)) throw new Error(`missing ${key}`)
      return commits[key]
    },
  }
}

test('parseAliasList accepts text/array and dedupes case-insensitively', () => {
  assert.deepEqual(parseAliasList('a@x.com\nB@x.com\n a@x.com '), ['a@x.com', 'B@x.com'])
  assert.deepEqual(parseAliasList(['a', 'A', ' b ']), ['a', 'b'])
  assert.deepEqual(parseAliasList(''), [])
})

test('mergeAliases keeps existing order and appends new suggestions', () => {
  assert.deepEqual(mergeAliases(['a@x.com'], ['b@x.com', 'A@x.com']), ['a@x.com', 'b@x.com'])
})

test('normalizeIdentity trims and lowercases', () => {
  assert.equal(normalizeIdentity('  Foo@Bar.COM '), 'foo@bar.com')
  assert.equal(normalizeIdentity(null), '')
})

test('suggestAuthorAliasesForConnection filters known identities and ranks candidates', async () => {
  const events = [
    { author_id: 7, project_id: 11, push_data: { commit_to: 'aaaaaaa1' } },
    { author_id: 7, project_id: 11, push_data: { commit_to: 'aaaaaaa2' } },
    { author_id: 7, project_id: 12, push_data: { commit_to: 'bbbbbbb1' } },
    { author_id: 7, project_id: 12, push_data: { commit_to: 'bbbbbbb2' } },
    { author_id: 7, project_id: 12, push_data: { commit_to: 'bbbbbbb3' } },
    { author_id: 9, project_id: 12, push_data: { commit_to: 'ccccccc1' } },
  ]
  const commits = {
    '11:aaaaaaa1': { author_email: 'me@corp.com', author_name: 'Me', committer_email: 'me@corp.com', committer_name: 'Me' },
    '11:aaaaaaa2': { author_email: 'me@corp.com', author_name: 'Me', committer_email: 'me@corp.com', committer_name: 'Me' },
    '12:bbbbbbb1': { author_email: 'old@corp.com', author_name: 'Old Name', committer_email: 'me@corp.com', committer_name: 'Me' },
    '12:bbbbbbb2': { author_email: 'old@corp.com', author_name: 'Old Name', committer_email: 'me@corp.com', committer_name: 'Me' },
    '12:bbbbbbb3': { author_email: 'old@corp.com', author_name: 'Old Name', committer_email: 'me@corp.com', committer_name: 'Me' },
    '12:ccccccc1': { author_email: 'other@corp.com', author_name: 'Other', committer_email: 'other@corp.com', committer_name: 'Other' },
  }
  const result = await suggestAuthorAliasesForConnection({
    client: fakeClient({
      user: { id: 7, username: 'me', name: 'Me', email: 'me@corp.com', commit_email: 'me@corp.com' },
      emails: [{ email: 'me@corp.com' }],
      events,
      commits,
    }),
    existingAliases: [],
  })
  assert.equal(result.username, 'me')
  assert.equal(result.sampledEvents, 5)
  assert.equal(result.sampledCommits, 5)
  assert.deepEqual(
    result.candidates.map((item) => [item.value, item.kind, item.count]),
    [
      ['old@corp.com', 'email', 3],
      ['old name', 'name', 3],
    ],
  )
  assert.deepEqual(result.suggestedAliases, ['old@corp.com', 'old name'])
  assert.ok(result.knownIdentities.includes('me@corp.com'))
  assert.ok(!result.knownIdentities.includes('old@corp.com'))
})

test('suggestAuthorAliasesForConnection applies relative cutoff and existing aliases', async () => {
  const events = [1, 2, 3, 4].map((index) => ({
    author_id: 7,
    project_id: 20,
    push_data: { commit_to: `sha0000${index}` },
  }))
  const commits = {}
  for (let index = 1; index <= 4; index += 1) {
    commits[`20:sha0000${index}`] = {
      author_email: 'old@corp.com',
      author_name: 'Old Name',
      committer_email: 'old@corp.com',
      committer_name: 'Old Name',
    }
  }
  const result = await suggestAuthorAliasesForConnection({
    client: fakeClient({
      user: { id: 7, username: 'me', name: 'Me', email: 'me@corp.com', commit_email: 'me@corp.com' },
      emails: [],
      events,
      commits,
    }),
    existingAliases: ['old@corp.com'],
  })
  assert.ok(!result.suggestedAliases.includes('old@corp.com'))
  assert.ok(result.suggestedAliases.includes('old name'))
})

test('suggestAuthorAliasesForConnection tolerates missing commit details', async () => {
  const events = [{ author_id: 7, project_id: 11, push_data: { commit_to: 'missing1' } }]
  const result = await suggestAuthorAliasesForConnection({
    client: {
      async getCurrentUser() {
        return { id: 7, username: 'me', name: 'Me' }
      },
      async getUserEmails() {
        throw new Error('no scope')
      },
      async listEvents() {
        return events
      },
      async getCommit() {
        throw new Error('boom')
      },
    },
    existingAliases: [],
  })
  assert.equal(result.sampledCommits, 0)
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.suggestedAliases, [])
})

test('ALIAS_MAX_TIP_COMMITS is bounded for big event pages', () => {
  assert.equal(typeof ALIAS_MAX_TIP_COMMITS, 'number')
  assert.ok(ALIAS_MAX_TIP_COMMITS > 0)
})

test('formatAuthorAliasSuggestMessage summarizes or stays empty', () => {
  assert.equal(formatAuthorAliasSuggestMessage([]), '未发现可新增别名')
  assert.match(formatAuthorAliasSuggestMessage(['a@x.com', 'b']), /已推断 a@x\.com、b/)
})
