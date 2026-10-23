/**
 * 作用域（scope）命名规范 —— 档 3 的快照命名空间。
 *
 * ## 为什么需要它
 * 0.10.x 的命名空间只有 `<repoId>@<切块指纹>` 一个：同一个仓库的 main / 分支 / PR /
 * worktree 会写进**同一个**空间，谁后同步谁覆盖谁。档 3 给每种作用域一个独立快照：
 *
 *   canonical_namespace(repoId, chunkFp, kind, ref) = `<repoId>@<chunkFp>#<nsKind>:<refToken>`
 *
 *   kind ∈ main | branch | pr | worktree
 *     main     -> "default"                          （ref 忽略）
 *     branch   -> safe(ref) + "-" + sha1(ref)[:6]
 *     pr       -> str(int(ref))                      （ref 必须是纯数字）
 *     worktree -> sha1(ref)[:8]
 *
 *   nsKind：worktree 在命名空间里写作 **`wt`**（夹具 `r1234@fp1#wt:e4f91dd3` 钉死了这一点；
 *   对外 API / 配置 / DB 的 scope_kind 仍是 `worktree`，只有命名空间这一段缩写）。
 *
 * ## 硬约束
 * 1. **规则必须与服务端逐条一致**（`server/code-index-service/scope_format.json` 夹具两端都跑）：
 *    JS 与 Python 任何一边漂移，同一个分支就会在两个作用域里各存一份向量。
 * 2. **legacy 命名空间（不含 `#`）原样保留**，不做规范化 —— 旧库升级后 `scope_kind='legacy'`，
 *    客户端继续用原来的 `repo@fp` 就能找到它，零迁移步骤。
 * 3. 校验失败抛出带 `reason` 的 `ScopeError`：调用方（配置校验）要把键路径翻译成 ConfigError，
 *    测试也要能按 reason 断言（夹具的 invalid_cases 就是这么用的）。
 * 4. 作用域没有 TTL/pin：服务端永久保留，只能显式删除。
 */
import crypto from 'node:crypto'

/** 合法的作用域类型（与 §2 契约一致，追加值必须先改服务端与服务端夹具） */
export const SCOPE_KINDS = ['main', 'branch', 'pr', 'worktree']

/** 用户可写的作用域配置键 */
export const SCOPE_CONFIG_KEYS = ['kind', 'ref']

/** ref 里的合法字符（其余连续字符压成 "-"） */
const REF_SAFE_RE = /[^A-Za-z0-9._-]+/g

/**
 * 作用域错误：`reason` 是稳定标识（夹具 invalid_cases 按它断言），`message` 给人看。
 */
export class ScopeError extends Error {
  constructor(message, { reason = 'bad-scope', kind = null, ref = null } = {}) {
    super(message)
    this.name = 'ScopeError'
    /** 稳定原因码：unknown-kind / empty-ref / pr-ref-not-numeric / invalid-repo-id / invalid-chunk-fp ... */
    this.reason = reason
    this.code = reason
    this.kind = kind
    this.ref = ref
  }
}

/** sha1 十六进制；null/undefined 当空串（校验会先挡掉空 ref） */
function sha1Hex(value) {
  return crypto.createHash('sha1').update(String(value ?? ''), 'utf8').digest('hex')
}

/**
 * 把分支/工作树名压成命名空间里可用的片段：
 * 非 `[A-Za-z0-9._-]` 的**连续**字符压成 `-`，再去首尾 `-`；结果为空则用 `"x"`。
 *
 * 例：`feat/x` → `feat-x`；`中文分支` → `x`；`--a!!b--` → `a-b`。
 * @param {unknown} value
 * @returns {string}
 */
export function safeRef(value) {
  const out = String(value ?? '').replace(REF_SAFE_RE, '-').replace(/^-+|-+$/g, '')
  return out || 'x'
}

/**
 * 取出并校验非 main 作用域的 ref，返回**原始**（去首尾空白后）的 ref。
 * 为什么不直接返回 token：branch 的 token 是 `safe(ref)-sha1(ref)`，
 * 而配置/API 里该传原始分支名，token 只出现在命名空间里。
 * @param {string} kind
 * @param {unknown} ref
 * @returns {string}
 */
function requireRef(kind, ref) {
  const text = String(ref ?? '').trim()
  if (!text) {
    throw new ScopeError(`${kind} 作用域的 ref 不能为空`, { reason: 'empty-ref', kind, ref })
  }
  // pr：ref 必须是纯数字；`str(int(ref))` 与 Python 的 int() 对齐（去掉前导零）
  if (kind === 'pr' && !/^\d+$/.test(text)) {
    throw new ScopeError(`pr 作用域的 ref 必须是纯数字（合并请求号），收到 ${JSON.stringify(text)}`, {
      reason: 'pr-ref-not-numeric',
      kind,
      ref,
    })
  }
  return text
}

/**
 * 计算 `kind:ref` 里的 refToken（**不含** kind 前缀）。
 *
 * 注意 `main` 返回的 `"default"` 是**固定值**：main 的 ref 被刻意忽略 ——
 * 主干永远只有一个快照，写 `main:master` 还是 `main:main` 都指向同一份。
 * @param {string} kind
 * @param {unknown} ref
 * @returns {string}
 */
export function refToken(kind, ref) {
  if (!SCOPE_KINDS.includes(kind)) {
    throw new ScopeError(`未知作用域类型：${JSON.stringify(kind)}（可用：${SCOPE_KINDS.join(' / ')}）`, {
      reason: 'unknown-kind',
      kind,
      ref,
    })
  }
  if (kind === 'main') return 'default'
  const text = requireRef(kind, ref)
  if (kind === 'branch') return `${safeRef(text)}-${sha1Hex(text).slice(0, 6)}`
  if (kind === 'worktree') return sha1Hex(text).slice(0, 8)
  return String(Number(text))
}

/** legacy 命名空间 = 不含 `#` 的旧格式（`repo@fp`），原样保留、不做规范化 */
export function isLegacyNamespace(namespace) {
  return typeof namespace === 'string' && namespace.length > 0 && !namespace.includes('#')
}

/**
 * 规范化一个**已有**命名空间字符串（只做最小校验，不重新推导）。
 *
 * 为什么不能"一律 canonical 化"：legacy 命名空间（`repo@fp`）在服务端升级后仍以原字符串
 * 存在（`scope_kind='legacy'`），客户端若把它重塑成 `#legacy:...` 就再也找不到旧库了。
 * @param {unknown} namespace
 * @returns {string}
 */
export function normalizeNamespace(namespace) {
  if (typeof namespace !== 'string' || !namespace.trim()) {
    throw new ScopeError(`命名空间必须是非空字符串，收到 ${JSON.stringify(namespace)}`, {
      reason: 'empty-namespace',
    })
  }
  // legacy 原样保留（仅去首尾空白，避免配置里无意的空格变成另一个空间）
  return namespace.trim()
}

/**
 * 校验并规范化用户配置里的 `remote.scope`。
 *
 * 返回 `{kind, ref}`：main 的 ref 固定为 `"default"`；pr 的 ref 归一成数字串。
 * @param {unknown} input
 * @returns {{kind:string, ref:string}}
 */
export function validateScope(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ScopeError(`作用域配置必须是对象（{kind, ref}），收到 ${Array.isArray(input) ? 'array' : typeof input}`, {
      reason: 'bad-scope',
    })
  }
  const unknown = Object.keys(input).filter((k) => !SCOPE_CONFIG_KEYS.includes(k))
  if (unknown.length) {
    throw new ScopeError(`未知作用域配置项：${unknown.join(', ')}；可用：${SCOPE_CONFIG_KEYS.join(', ')}`, {
      reason: 'unknown-key',
    })
  }
  const kind = input.kind
  if (!SCOPE_KINDS.includes(kind)) {
    throw new ScopeError(`未知作用域类型：${JSON.stringify(kind)}（可用：${SCOPE_KINDS.join(' / ')}）`, {
      reason: 'unknown-kind',
      kind,
    })
  }
  // main 的 ref 被忽略（传什么都指向同一份快照）；其余 kind 必须有 ref。
  // 返回**原始** ref：服务端按同一规范自己算 token，客户端只把它带到 sync payload/展示里。
  let ref = 'default'
  if (kind !== 'main') {
    const text = requireRef(kind, input.ref)
    ref = kind === 'pr' ? String(Number(text)) : text
  }
  return { kind, ref }
}

/**
 * 一句话展示作用域（日志/工具输出用）：`branch:feat/x`、`pr:1234`。
 * @param {{kind:string, ref:string}} scope
 */
export function describeScope(scope) {
  if (!scope || !scope.kind) return '（无作用域）'
  return `${scope.kind}:${scope.ref}`
}
