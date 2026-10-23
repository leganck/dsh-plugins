/**
 * CI 诊断预载：用于定位 dsh-code-index 的 test.mjs 在 GitHub runner 上无输出挂起。
 *
 * 用法：
 *   node --import ../../scripts/ci-test-trace.mjs test.mjs
 *
 * 它不改变测试行为，只做两件事：
 *   1. 启动时打印 Node/cwd，确认进程已经进入 test.mjs；
 *   2. 45s 后如果事件循环还活着，打印 active handles/requests 并退出 124。
 *
 * 注意：只用于 CI 失败后的诊断步骤，不进入正常测试命令；本地也不要依赖它。
 */
const started = Date.now()
console.error(`[trace] preload node=${process.version} cwd=${process.cwd()}`)

const timer = setTimeout(() => {
  console.error(`[trace] WATCHDOG after ${Date.now() - started}ms`)
  try {
    const handles = process._getActiveHandles?.() || []
    for (const h of handles) {
      const name = h?.constructor?.name || typeof h
      const fd = h?.fd ?? h?._handle?.fd ?? ''
      console.error(`[trace] handle ${name} fd=${fd}`)
    }
    const requests = process._getActiveRequests?.() || []
    for (const r of requests) console.error(`[trace] request ${r?.constructor?.name || typeof r}`)
  } catch (e) {
    console.error(`[trace] dump failed: ${e?.message || e}`)
  }
  process.exit(124)
}, 45000)
timer.unref?.()

process.on('exit', (code) => {
  console.error(`[trace] exit code=${code} after ${Date.now() - started}ms`)
})
