#!/usr/bin/env node
/**
 * 仓库身份（血统 repoId）测试：
 *   1. `.git/config` 直读兜底（不依赖 git 二进制）
 *   2. worktree 的 `.git` 文件 + commondir 间接寻址
 *   3. 同一仓库不同克隆 → 同一个 repoId（这正是历史上出"重复血统"的地方）
 *   4. 无 git origin → 明确标记 source='path'（调用方据此告警/拒绝）
 *   5. remote.repoId 覆盖优先级最高
 *
 * 运行：node test-repo-id.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import {
  normalizeRemoteUrl,
  originUrlFromGitConfig,
  repoIdentity,
  repoIdOf,
} from './lib/repo.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ' :: ' + JSON.stringify(detail) : ''}`)
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-id-'))
const sha12 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)

function mkRepo(dir, { origin = null, git = true } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  if (!git) return dir
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const cfg = ['[core]', '\trepositoryformatversion = 0', '[remote "origin"]']
  if (origin) cfg.push(`\turl = ${origin}`, '\tfetch = +refs/heads/*:refs/remotes/origin/*')
  fs.writeFileSync(path.join(dir, '.git', 'config'), cfg.join('\n') + '\n')
  return dir
}

console.log('\n[1] normalizeRemoteUrl：ssh/https/凭证/.git 归一')
check('https + .git', normalizeRemoteUrl('https://git.example.com/team/app.git') === 'git.example.com/team/app')
check('ssh scp 形式', normalizeRemoteUrl('git@git.example.com:team/app.git') === 'git.example.com/team/app')
check('去凭证', normalizeRemoteUrl('https://user:tok@git.example.com/team/app.git') === 'git.example.com/team/app')
check('host 小写', normalizeRemoteUrl('https://Git.Example.COM/team/app') === 'git.example.com/team/app')

console.log('\n[2] originUrlFromGitConfig：不依赖 git 二进制')
const repoA = mkRepo(path.join(TMP, 'clone-a'), { origin: 'https://git.example.com/team/app.git' })
check('读到 origin url', originUrlFromGitConfig(repoA) === 'https://git.example.com/team/app.git', originUrlFromGitConfig(repoA))

const noOrigin = mkRepo(path.join(TMP, 'no-origin'), { origin: null })
check('没有 remote.origin → 空串', originUrlFromGitConfig(noOrigin) === '')

const notGit = path.join(TMP, 'plain-dir')
fs.mkdirSync(notGit, { recursive: true })
check('不是 git 仓库 → 空串', originUrlFromGitConfig(notGit) === '')

// 同名 remote 但不是 origin，不能被误读
const otherRemote = path.join(TMP, 'other-remote')
fs.mkdirSync(path.join(otherRemote, '.git'), { recursive: true })
fs.writeFileSync(path.join(otherRemote, '.git', 'config'), '[remote "upstream"]\n\turl = https://git.example.com/team/upstream.git\n')
check('忽略非 origin remote', originUrlFromGitConfig(otherRemote) === '')

console.log('\n[3] 同一仓库不同目录/克隆 → 同一个 repoId（历史重复血统的根因）')
const repoB = mkRepo(path.join(TMP, 'clone-b-deeper', 'app'), { origin: 'git@git.example.com:team/app.git' })
const idA = repoIdentity(repoA)
const idB = repoIdentity(repoB)
check('两个克隆 repoId 一致', idA.repoId === idB.repoId, { a: idA.repoId, b: idB.repoId })
check('repoId = sha1(归一化 URL)[:12]', idA.repoId === sha12('git.example.com/team/app'), idA.repoId)
check('source=git（git CLI 可用时）', ['git', 'config'].includes(idA.source), idA.source)
check('normalizedUrl 已归一化', idA.normalizedUrl === 'git.example.com/team/app', idA.normalizedUrl)

console.log('\n[4] 无 origin → source=path，且 repoId 与路径相关')
const plain = path.join(TMP, 'no-git-repo')
fs.mkdirSync(plain, { recursive: true })
const idPlain = repoIdentity(plain)
check('source=path', idPlain.source === 'path', idPlain)
check('repoId = sha1(local:<abs>)[:12]', idPlain.repoId === sha12('local:' + path.resolve(plain)))
check('url 为空（服务端会落 local: 血统）', idPlain.url === '')
check('同样内容换目录 → repoId 不同', repoIdentity(path.join(TMP, 'no-git-repo-2') || plain).repoId !== idPlain.repoId)

console.log('\n[5] worktree：.git 文件 + commondir 间接寻址')
const mainRepo = mkRepo(path.join(TMP, 'wt-main'), { origin: 'https://git.example.com/team/wt-app.git' })
const wt = path.join(TMP, 'wt-checkout')
const wtGitDir = path.join(mainRepo, '.git', 'worktrees', 'wt-checkout')
fs.mkdirSync(wt, { recursive: true })
fs.mkdirSync(wtGitDir, { recursive: true })
fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.relative(wt, wtGitDir)}\n`)
fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n')
fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/feat\n')
check('worktree 能从 commondir 找到 config', originUrlFromGitConfig(wt) === 'https://git.example.com/team/wt-app.git', originUrlFromGitConfig(wt))
check('worktree 与主仓 repoId 一致', repoIdentity(wt).repoId === repoIdentity(mainRepo).repoId, {
  wt: repoIdentity(wt).repoId,
  main: repoIdentity(mainRepo).repoId,
})

console.log('\n[6] 显式覆盖 remote.repoId 优先级最高')
check('override 生效', repoIdentity(repoA, 'fixedid123456').repoId === 'fixedid123456')
check('override 时 source=override', repoIdentity(repoA, 'fixedid123456').source === 'override')
check('override 也能让无 git 目录共享血统', repoIdentity(plain, 'fixedid123456').repoId === 'fixedid123456')
check('repoIdOf 保持旧签名', repoIdOf(repoA) === idA.repoId)

console.log('\n[7] git CLI 缺失时的兜底（PATH 置空模拟）')
const oldPath = process.env.PATH
try {
  process.env.PATH = ''
  // 用子进程更真实：SPAWN 一个 node 脚本，PATH 为空
  const probe = path.join(TMP, 'probe.mjs')
  fs.writeFileSync(
    probe,
    `import { repoIdentity } from ${JSON.stringify(new URL('./lib/repo.js', import.meta.url).href)}\n`
      + `const id = repoIdentity(${JSON.stringify(repoA)})\n`
      + `console.log(JSON.stringify(id))\n`,
  )
  const out = execFileSync(process.execPath, [probe], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  }).trim()
  const parsed = JSON.parse(out)
  check('PATH 无 git 时仍解析出 URL（config 兜底）', parsed.source === 'config', parsed)
  check('兜底算出的 repoId 与 git CLI 一致', parsed.repoId === idA.repoId, {
    fallback: parsed.repoId,
    git: idA.repoId,
  })
} finally {
  process.env.PATH = oldPath
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
