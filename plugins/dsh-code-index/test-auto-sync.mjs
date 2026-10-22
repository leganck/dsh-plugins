/**
 * 自动同步调度器 / 注册表 / 跨进程锁自测。无仓库、无网络。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { RepoRegistry } from './lib/repo-registry.js'
import { AutoSyncEntry, acquireRepoLock } from './lib/auto-sync.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? `（${detail}）` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('\n[1] 注册表')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-auto-'))
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-repo-'))
const db = path.join(home, 'repo.db')
fs.writeFileSync(db, '')
const reg = new RepoRegistry(home)
reg.upsert(repo, { dbPath: db, lastIndexedAt: 123, lastSyncAt: 456 })
const reg2 = new RepoRegistry(home)
check('重启后读回仓库', reg2.get(repo)?.dbPath === db, JSON.stringify(reg2.list()))
reg2.upsert(repo, { lastIndexedAt: 789 })
check('upsert 保留上次索引时间', new RepoRegistry(home).get(repo)?.lastIndexedAt === 789)
fs.rmSync(db, { force: true })
check('prune 删除索引库已不存在的记录', new RepoRegistry(home).get(repo) === null)

console.log('\n[2] 锁')
const db2 = path.join(home, 'lock.db')
fs.writeFileSync(db2, '')
const l1 = acquireRepoLock(db2, { ttlMs: 60000 })
const l2 = acquireRepoLock(db2, { ttlMs: 60000 })
check('第一个锁成功', l1.ok === true)
check('第二个锁被拒绝', l2.ok === false, l2.reason)
l1.release()
const l3 = acquireRepoLock(db2, { ttlMs: 60000 })
check('释放后可重新获取', l3.ok === true)
l3.release()
fs.writeFileSync(`${db2}.auto-sync.lock`, '{broken')
const l4 = acquireRepoLock(db2, { ttlMs: 60000 })
check('损坏锁按过期处理', l4.ok === true, l4.reason)
l4.release()

console.log('\n[3] dirty 合并 / 运行中不丢事件')
let runs = 0
let firstResolve
const firstRun = new Promise((res) => (firstResolve = res))
const watcher = new EventEmitter()
watcher.close = () => {}
const entry = new AutoSyncEntry({
  repoRoot: repo,
  debounceMs: 1000,
  maxDelayMs: 3000,
  watchFactory: () => watcher,
  onRun: async () => {
    runs += 1
    if (runs === 1) await firstRun
  },
})
entry.start()
entry.noteEvent()
await sleep(1150)
check('防抖后只跑一次', runs === 1, `runs=${runs}`)
entry.noteEvent()
entry.noteEvent()
firstResolve()
await sleep(1200)
check('运行中的事件会在结束后补跑，不丢', runs >= 2, `runs=${runs}`)
entry.stop()
check('stop 后不再监听', entry.state().watching === false)

console.log('\n[4] 失败退避')
let attempts = 0
const bad = new AutoSyncEntry({
  repoRoot: repo,
  debounceMs: 1000,
  maxDelayMs: 2000,
  watchFactory: () => {
    const w = new EventEmitter()
    w.close = () => {}
    return w
  },
  onRun: async () => {
    attempts += 1
    throw new Error('boom')
  },
})
bad.start()
bad.noteEvent()
await sleep(1200)
check('失败后保持 dirty', bad.state().dirty === true, JSON.stringify(bad.state()))
check('失败后记录错误', /boom/.test(String(bad.state().lastError)), JSON.stringify(bad.state()))
bad.stop()

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
