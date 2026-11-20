/**
 * exp-hook — 压缩落盘之后自动触发一次经验抽取（经验管道 v2）。
 *
 * 为什么单独成文件：`index.js` 已经 1.5k 行、只关心「把被压缩的区间写成可 grep 的
 * Markdown」；经验抽取是**另一件事**（网络 IO + 一个 30 行的 prompt + 失败退避），
 * 塞进去会把归档逻辑和外部服务可用性搅在一起。这里只做三件事：
 *   1. 把一段归档变成抽取请求体（`buildExtractPayload`）；
 *   2. 发出请求（`createExperienceTrigger`），带超时、失败退避、只 warn 不上抛；
 *   3. `mode=client` 时自己调本机 OpenAI 兼容 LLM 抽候选，再 `POST /v1/exp/import`。
 *
 * ## 硬约束：抽取是**可选增强**，绝不影响归档
 * 调用方在 `writeSegment()` 里**同步**调 `fire()`，而 `fire()` 只做参数检查就把 Promise
 * 挂到后台，从不 await、从不 throw。因此：端点超时 / 500 / 连接被拒绝，归档文件与
 * `writeSegment` 的返回值都和不装这个钩子时一模一样（`test-exp-hook.mjs` 用文件逐字节
 * 比对钉死了这条）。
 *
 * ## 连续失败退避
 * 同一个 session 连续失败 `MAX_CONSECUTIVE_FAILURES`(3) 次后本会话不再尝试：一次压缩
 * 一段，若容器不可达，每段都要等满 `exp.timeoutMs`（默认 15s）——不设上限就是每段
 * 平白多挂 15s 的资源。成功一次即清零（"连续"语义，不是终身拉黑）。
 *
 * ## 服务端契约（server/storage-hub/server.py）
 *   POST {exp.url}/v1/exp/extract
 *     body {session_id, segment_no, workflow, summary, verbatim, apply}
 *     → 200 {job_id, status, funnel:{candidates,blocked,created,updated,skipped,contradicted},
 *            reasons, ms, warnings}
 *     → 未配置 LLM 时也是 **200 + {status:"skipped", reason:"llm-not-configured"}**（不是 5xx）
 *   POST {exp.url}/v1/exp/import
 *     body {...同上但用 candidates:[...] 代替 LLM 抽取}
 *   鉴权：Authorization: Bearer {exp.key}（服务端 API_KEY）
 *
 * ## mode=client 的 prompt
 * 服务端 `exp_prompt.py` 是唯一口径来源；这里维护一份 JS 版常量，**不追求逐字一致**，
 * 但三镜头 / 九类垃圾 / 五类 category（含 process 拒收）必须齐全（`PROMPT_SECTIONS`
 * 由测试逐条核对，改 prompt 时漏一类会红）。
 */

/** 与 exp_prompt.py 的 PROMPT_VERSION 同口径；`-js.N` 表示这是插件侧那一份文本。 */
export const EXP_PROMPT_VERSION = 'exp-v2.0-js.1'

/** 同一 session 连续失败这么多次后不再尝试（避免每段都等一次超时）。 */
export const MAX_CONSECUTIVE_FAILURES = 3

/** 被 shadow 原文超过这个字节数就截断（默认 200KB，可用 exp.maxVerbatimBytes 覆盖）。 */
export const DEFAULT_MAX_VERBATIM_BYTES = 200 * 1024

/** 服务端契约路径（相对 exp.url；exp.url 允许已经带上 /v1）。 */
const EXTRACT_PATH = 'extract'
const IMPORT_PATH = 'import'

/**
 * `exp` 配置块的 schema（默认值即文档）。
 *
 * 这个插件没有 schemastery 依赖，配置 schema 就是这份默认值 + `normalizeExpConfig`；
 * 未写的键取默认，写错的类型在这里被纠正而不是让运行时炸掉。
 */
export const EXP_DEFAULTS = Object.freeze({
  /** 总开关。默认 false：归档插件不该因为一次安装就开始往外发数据。 */
  enabled: false,
  /** `server` = 服务端抽（推荐）；`client` = 插件自己调本机 LLM，只交候选。 */
  mode: 'server',
  /** 经验容器根地址，如 `http://192.168.1.10:8000`；允许已带 `/v1`。 */
  url: '',
  /** 服务端 API_KEY（`Authorization: Bearer`）。本地网关可留空。 */
  key: '',
  /** 抽取结果是否真正落库。默认 false = 只跑漏斗、不写库（先看质量再开）。 */
  apply: false,
  /** 单次 HTTP 请求超时。 */
  timeoutMs: 15000,
  /** 被 shadow 原文小于这个字节数就不抽（太短的段抽不出可复用经验）。 */
  minSegmentBytes: 2000,
  /** verbatim 上限，超过截断并 warn。 */
  maxVerbatimBytes: DEFAULT_MAX_VERBATIM_BYTES,
  /** `mode=client` 用的本机 LLM（OpenAI 兼容）。 */
  llmUrl: '',
  llmKey: '',
  llmModel: '',
  /** 本机 LLM 单次超时：实测单条经验要 28s+，15s 会把正常请求全判超时。 */
  llmTimeoutMs: 120000,
  /** 本机 LLM 单次 max_tokens：推理型模型预算不够会返回空 content。 */
  llmMaxTokens: 4000,
})

/** 一个可判定的失败类型，`reason` 进日志。 */
class ExpError extends Error {
  constructor(message, reason = 'error') {
    super(message)
    this.name = 'ExpError'
    this.reason = reason
  }
}

const messageOf = (error) => {
  if (error === null || error === undefined) return 'unknown'
  if (typeof error === 'string') return error
  const base = String(error.message ?? error)
  const cause = error.cause
  if (cause === undefined || cause === null) return base
  const code = cause.code ?? cause.errno ?? ''
  const detail = String(cause.message ?? cause)
  return code === '' ? `${base}（${detail}）` : `${base}（${code}: ${detail}）`
}

// ---------------------------------------------------------------- 配置归一
const TRUE_STRINGS = new Set(['1', 'true', 'yes', 'on'])

function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (TRUE_STRINGS.has(text)) return true
    if (text === '' || text === '0' || text === 'false' || text === 'no' || text === 'off') return false
  }
  return fallback
}

function asInt(value, fallback, min) {
  // `Number('')` 与 `Number(undefined)` 都是 0，会把"没写"误判成一个合法数字；
  // 空值必须先落到 fallback，否则每个默认值都会变成 min。
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  const number = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.trunc(number)
  return rounded < min ? min : rounded
}

function asText(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  return value.trim()
}

/**
 * 把 `config.exp` 归一成一份确定的配置。
 *
 * 为什么要单独归一：`pluginConfig` 是浅合并，用户只写 `exp: {enabled: true}` 时其它
 * 默认值必须还在；而宿主可能把 YAML 里的 `"false"` 当字符串给人，这里也要吃得住。
 */
export function normalizeExpConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = asText(source.mode).toLowerCase() === 'client' ? 'client' : 'server'
  return {
    enabled: asBool(source.enabled, EXP_DEFAULTS.enabled),
    mode,
    url: asText(source.url).replace(/\/+$/, ''),
    key: asText(source.key),
    apply: asBool(source.apply, EXP_DEFAULTS.apply),
    timeoutMs: asInt(source.timeoutMs, EXP_DEFAULTS.timeoutMs, 1),
    minSegmentBytes: asInt(source.minSegmentBytes, EXP_DEFAULTS.minSegmentBytes, 0),
    maxVerbatimBytes: asInt(source.maxVerbatimBytes, EXP_DEFAULTS.maxVerbatimBytes, 1024),
    llmUrl: asText(source.llmUrl).replace(/\/+$/, ''),
    llmKey: asText(source.llmKey),
    llmModel: asText(source.llmModel),
    llmTimeoutMs: asInt(source.llmTimeoutMs, EXP_DEFAULTS.llmTimeoutMs, 1),
    llmMaxTokens: asInt(source.llmMaxTokens, EXP_DEFAULTS.llmMaxTokens, 1),
  }
}

// ---------------------------------------------------------------- 地址
/**
 * 服务端端点。契约是 `${exp.url}/v1/exp/extract`，但用户把 `/v1` 写进 url 是常见手误，
 * 这里两种都接受（已经以 `/v1` 结尾就不再补一层）。
 */
export function expEndpoint(base, sub) {
  const root = String(base ?? '').trim().replace(/\/+$/, '')
  if (root === '') return ''
  const prefix = root.endsWith('/v1') ? '' : '/v1'
  return `${root}${prefix}/exp/${String(sub ?? '').replace(/^\/+/, '')}`
}

/** 本机 LLM 的 chat/completions 端点：接受根地址、`.../v1`、或完整端点三种写法。 */
export function chatEndpoint(base) {
  const root = String(base ?? '').trim().replace(/\/+$/, '')
  if (root === '') return ''
  if (root.endsWith('/chat/completions')) return root
  if (root.endsWith('/v1')) return `${root}/chat/completions`
  return `${root}/v1/chat/completions`
}

// ---------------------------------------------------------------- workflow slug
/**
 * 会话标题 / 工作区目录名 → 短标签（如 `erp bug` → `erp-bug`）。
 *
 * 规则：ASCII 小写；任何非字母数字的连续片段（空格、中英文标点、路径分隔符）折成
 * 一个 `-`；首尾与重复分隔符去掉；CJK 保留（`ERP Bug：订单/退款` → `erp-bug-订单-退款`）。
 * 服务端把 workflow 截到 64 字符，这里先截好，免得同一个 workflow 在两边不一致。
 *
 * @param {unknown} title 会话标题（没有就传空）
 * @param {unknown} cwd   会话工作目录（标题推不出东西时取 basename）
 */
export function workflowSlug(title, cwd = '') {
  const fromTitle = slugify(title)
  if (fromTitle !== '') return fromTitle
  const parts = String(cwd ?? '').split(/[\\/]+/).filter((part) => part.trim() !== '')
  return slugify(parts.length === 0 ? '' : parts[parts.length - 1])
}

function slugify(value) {
  const text = String(value ?? '')
    .toLowerCase()
    // `\p{L}` 覆盖汉字/假名，`\p{N}` 覆盖数字；其余一律当分隔符。
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
  return text.replace(/-+$/, '')
}

// ---------------------------------------------------------------- verbatim 截断
/**
 * 按 UTF-8 字节数截断，且不切断多字节字符。
 *
 * 切点优先落在换行上（保留的行仍是完整的一轮对话，而不是半行），其次才是硬截断；
 * 返回的 `bytes` 是**截断后**的字节数，`originalBytes` 是原文的。
 */
export function truncateUtf8(text, maxBytes = DEFAULT_MAX_VERBATIM_BYTES) {
  const source = String(text ?? '')
  const buffer = Buffer.from(source, 'utf8')
  if (buffer.length <= maxBytes) {
    return { text: source, bytes: buffer.length, originalBytes: buffer.length, truncated: false }
  }
  let kept = buffer.subarray(0, maxBytes).toString('utf8')
  // 切在多字节字符中间时，尾部会解出一个 U+FFFD：去掉它，别写半个字符进请求体。
  while (kept.endsWith('\uFFFD')) kept = kept.slice(0, -1)
  // 换行优先：只在「切掉的不超过 2KB」时上移，避免为了对齐行首白丢一大截。
  const lastNewline = kept.lastIndexOf('\n')
  if (lastNewline > 0 && kept.length - lastNewline <= 2048) kept = kept.slice(0, lastNewline)
  const bytes = Buffer.byteLength(kept, 'utf8')
  return { text: kept, bytes, originalBytes: buffer.length, truncated: true }
}

// ---------------------------------------------------------------- 请求体
/**
 * 组装 `/v1/exp/extract` 的请求体。
 *
 * `segment_no` 用归档文件的段号（`segment_NNN.md` 的 NNN，0 基），这样服务端上的
 * `exp_jobs.segment_no` 能和磁盘上的文件名直接对上。
 */
export function buildExtractPayload({
  sessionId,
  segmentNo,
  workflow,
  summary,
  verbatim,
  apply,
  maxVerbatimBytes = DEFAULT_MAX_VERBATIM_BYTES,
}) {
  const summaryText = String(summary ?? '').trim()
  const cut = truncateUtf8(String(verbatim ?? '').trim(), maxVerbatimBytes)
  return {
    payload: {
      session_id: String(sessionId ?? ''),
      segment_no: Number.isFinite(Number(segmentNo)) ? Number(segmentNo) : 0,
      workflow: String(workflow ?? ''),
      summary: summaryText,
      verbatim: cut.text,
      apply: apply === true,
    },
    truncated: cut.truncated,
    verbatimBytes: cut.bytes,
    originalVerbatimBytes: cut.originalBytes,
  }
}

// ---------------------------------------------------------------- prompt（client 模式）
/**
 * 三镜头（认知障碍轴）。服务端 `exp_prompt.LENSES` 同口径。
 */
export const PROMPT_LENSES = Object.freeze([
  ['jargon', '黑话镜头·语义不可发现：项目内部黑话、缩写、代称，字面推不出含义（如「可摘」「惠管家」「D 站」）'],
  ['index', '索引镜头·位置不可发现：某个能力/入口/表/工具在哪，读代码或按目录名都找不到'],
  ['logic', '逻辑镜头·行为不可发现：反直觉的工程约束、隐式机制、踩过的坑（如「XLEN 不增长是常态」）'],
])

/**
 * 五类 category：四类有效 + 一类（`process` 交付流程）命中即拒收。
 * 这是「五类齐全」的地方：`business/debug/repo/tool/process`。
 */
export const PROMPT_CATEGORIES = Object.freeze([
  ['business', '业务知识（业务规则、口径、单据与数据模型）'],
  ['debug', '调试经验（线上故障、数据异常的定位与修复动作）'],
  ['repo', '仓库联动（跨仓/分支/移植/发版等代码资产关系）'],
  ['tool', '工具环境（构建、查库、查日志、部署命令等工具用法）'],
])

/** 第五类：不是有效 category，命中即拒收（reason=skill-covered）。 */
export const PROMPT_REJECTED_CATEGORY = Object.freeze([
  'process',
  '交付流程：**不是有效 category，命中即拒收**（不入库）。凡「只推个人 fork」「先沟通再动手」「提交前跑测试」这类已由 skill 覆盖的规范，一律不要输出。',
])

/** 九类垃圾（排除清单），编号与服务端 GARBAGE_CLASSES 一一对应。 */
export const PROMPT_GARBAGE = Object.freeze([
  [1, '事实性错误', '编造约束、把临时说法当规则、类名/方法名/表名不存在'],
  [2, '通用常识', '任何项目都适用（多收集上下文、仔细检查、多看日志、注意边界）'],
  [3, '对话摘要', '只复述过程（本次改了 N 个文件、已经部署到 dev1、接着我又跑了测试）'],
  [4, '一次性 case', '只对当前任务有效（今天、临时、这一次），换场景不成立'],
  [5, '用户主观偏好', '个人口味或习惯（我觉得、我习惯、建议你、最好先沟通）'],
  [6, '缺少上下文', 'when 为空或无法判定、指代不明（这一块、那个地方），不知对应哪个模块/接口'],
  [7, '粒度混用', '通用规则与 case 细节混成一条（金额/工单明细/行数写进 what），或单条超长'],
  [8, '不可执行', '抽象建议，看了也不知道下一步做什么'],
  [9, '证据不足', '素材里没有依据、全靠推断，或写不出 evidence_quote'],
])

/** 可审计三维：写不出 reusable_because 就不是经验；缺 evidence_quote 直接无效。 */
export const PROMPT_AUDIT = Object.freeze([
  ['reusable_because', '这条为什么能改变后续行为（≤40 字，写不出就不要这条）'],
  ['exclusions', '你核对掉了哪几类垃圾（写编号，如 "1,2,3,4,6,8"）'],
  ['evidence_quote', '**逐字**引自素材的原文片段（≤80 字）；工单号/租户名可以只放这里，不要写进 what'],
])

const SYSTEM_PROMPT_LINES = [
  '你是 SmartPOS 交付团队的资深工程师。任务：从一段真实工作记录里提炼**可复用的团队经验**。',
  '',
  '## 什么算经验（唯一标准）',
  '被召回后，另一个 Agent 面对相似场景时**行为会正向改变**。凡是从素材里推得出来的常识、',
  '或者换个项目也照说的道理，都不算。',
  '',
  '## 一、三镜头 lens（按「Agent 缺什么」选，三选一必填）',
]
for (const [code, description] of PROMPT_LENSES) SYSTEM_PROMPT_LINES.push(`- \`${code}\` ${description}`)
SYSTEM_PROMPT_LINES.push(
  '不要按主题分类，要按「光看代码/文档会缺什么」分类。无把握时选 `logic`。',
  '',
  '## 二、五类 category（内容领域，四类有效 + 一类拒收）',
)
for (const [code, description] of PROMPT_CATEGORIES) SYSTEM_PROMPT_LINES.push(`- \`${code}\` ${description}`)
SYSTEM_PROMPT_LINES.push(`- \`${PROMPT_REJECTED_CATEGORY[0]}\` ${PROMPT_REJECTED_CATEGORY[1]}`)
SYSTEM_PROMPT_LINES.push('', '## 三、九类垃圾（命中任一即**不要输出**这条）')
for (const [no, name, description] of PROMPT_GARBAGE) SYSTEM_PROMPT_LINES.push(`${no} ${name}：${description}`)
SYSTEM_PROMPT_LINES.push(
  '',
  '## 四、三个字段怎么写（这是质量的全部）',
  '- `what`：**祈使句动作**，≤90 字。说清改什么/查什么/用什么参数，下一步能直接照做。',
  '  反例：`CHGJ-3735 涉及 3 笔共 34 元`（叙事+细节混杂）、`注意多收集上下文`（不可执行）、',
  '  `Earlier claim 该文件与 5.0.x 一致 was wrong`（审计语气，且 what 与 why 重复）。',
  '- `when_expr`：**可判定的触发条件**，≤70 字。收窄到「看到什么现象/处在什么场景」就能对上；',
  '  禁止「处理问题时」「遇到复杂情况」这类永远为真的空条件。',
  '- `why`：**机制或后果**，≤140 字。讲清「不这么做会发生什么」，要解释机理，不要复述动作。',
  '- **三者必须互不相同**：what 讲动作、when_expr 讲触发、why 讲机制；what 与 why 语义重复即视为没提炼，不要输出。',
  '',
  '## 五、可审计三维（每条必填，缺 evidence_quote 直接算无效）',
  '`audit`：',
)
for (const [key, description] of PROMPT_AUDIT) SYSTEM_PROMPT_LINES.push(`- \`${key}\`：${description}`)
SYSTEM_PROMPT_LINES.push(
  '',
  '## 六、其它硬要求',
  '- 一条只讲一件事；同一素材有多条独立经验就输出多条。',
  '- 剥离审计语气（Earlier claim / was wrong / first attempt / 已验证）与工单号细节。',
  '- 数量不设下限：全部不合格就输出 `[]`（宁缺勿滥，输出垃圾比少输出代价大得多）。',
  '',
  '## 七、输出格式（**只输出 JSON 数组**，不要解释、不要代码块、不要前后缀）',
  '[{"what":"...","when_expr":"...","why":"...","lens":"jargon|index|logic",',
  '  "category":"business|debug|repo|tool",',
  '  "evidence_issue":"工单号或空字符串",',
  '  "audit":{"reusable_because":"...","exclusions":"1,2,3,4,6,8","evidence_quote":"..."}}]',
  '',
  '## 八、照这个质量对齐（示例，不要照抄内容）',
  '{"what":"上传流水后台查不到时，先比对同机同收银员相邻流水的落库分区，不要只查客户自己的库","when_expr":"客户报上传成功但后台查不到流水","why":"分区路由错时数据写进其他租户库，客户端仍收到 SUCCESS，只查本租户永远查不到","lens":"logic","category":"debug","evidence_issue":"CHGJ-3943","audit":{"reusable_because":"把排查起点从本租户库改成跨分区比对，是一步可执行的定位动作","exclusions":"1,2,3,4,6,8","evidence_quote":"分区 za4 正常；三笔上传被路由到 zb1，落进 tenant_id=140709"}}',
  '{"what":"两条产品线各自新建了同名类时，按已发版修复逐个 cherry-pick，禁止全分支 merge","when_expr":"把 master-5.0.x 合进 5.2.3 这类跨线移植","why":"两线独立在相同路径新建同类，全量 merge 后约 200 处找不到符号，且无法短期收敛","lens":"logic","category":"repo","evidence_issue":"SPLAT-5627","audit":{"reusable_because":"阻止一次会把分支编译全废的常规操作（merge 才是默认直觉）","exclusions":"2,3,6,8","evidence_quote":"9 文件 16 冲突解决后 ~200 编译错误"}}',
  '{"what":"看到「可摘/不可摘」理解为「该工单能否移植到目标补丁线」","when_expr":"发布清单或评论里出现可摘字样","why":"团队内部黑话，字面推不出含义，直接按字面理解会把版本判断做反","lens":"jargon","category":"business","evidence_issue":"CHGJ-2979","audit":{"reusable_because":"给黑话建立唯一映射，消除语义盲区","exclusions":"2,6","evidence_quote":"文件与 5.0.x 一致 = 可摘"}}',
  '',
)

const SYSTEM_PROMPT = SYSTEM_PROMPT_LINES.join('\n')

/** 完整 prompt = 系统段 + 素材。 */
export function buildPrompt(material) {
  return `${SYSTEM_PROMPT}\n## 九、待提炼素材\n${String(material ?? '')}`
}

/** prompt 文本（导出给测试核对三镜头/九类垃圾/五类 category 齐全）。 */
export const EXP_SYSTEM_PROMPT = SYSTEM_PROMPT

/** 抽取素材 = summary + verbatim（与服务端 `_exp_material` 同序）。 */
export function buildMaterial({ summary, verbatim }) {
  return [String(summary ?? '').trim(), String(verbatim ?? '').trim()]
    .filter((part) => part !== '')
    .join('\n\n')
}

// ---------------------------------------------------------------- 解析 LLM 输出
/**
 * 从模型回复里抽出候选数组，并说明"为什么是空的"。
 *
 * 模型常见三种脏输出：包了 ```json 代码块、前后带解释文字、直接输出 `[]`。三种都吃得住。
 * 之所以把失败原因一起返回：`[]`（模型判断没有经验）和"根本没给出 JSON"是两件事，
 * 前者正常、后者要 warn —— 否则 `max_tokens` 给小了会长期静默丢光候选。
 *
 * @returns {{candidates: object[], reason: 'ok'|'empty-array'|'empty-content'|'no-array'|'bad-json'}}
 */
export function parseCandidatesReport(content) {
  let body = String(content ?? '').trim()
  if (body === '') return { candidates: [], reason: 'empty-content' }
  if (body.startsWith('```')) {
    const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced !== null) body = fenced[1].trim()
  }
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end <= start) return { candidates: [], reason: 'no-array' }
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return { candidates: [], reason: 'bad-json' }
  }
  if (!Array.isArray(parsed)) return { candidates: [], reason: 'no-array' }
  const candidates = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const what = String(item.what ?? '').trim()
    if (what === '') continue
    const audit = item.audit !== null && typeof item.audit === 'object' ? item.audit : {}
    candidates.push({
      what,
      when_expr: String(item.when_expr ?? item.when ?? '').trim(),
      why: String(item.why ?? '').trim(),
      lens: String(item.lens ?? '').trim().toLowerCase(),
      category: String(item.category ?? '').trim().toLowerCase(),
      evidence_issue: String(item.evidence_issue ?? '').trim(),
      audit: {
        reusable_because: String(audit.reusable_because ?? '').trim(),
        exclusions: String(audit.exclusions ?? '').trim(),
        evidence_quote: String(audit.evidence_quote ?? '').trim(),
      },
    })
  }
  return { candidates, reason: candidates.length === 0 && parsed.length === 0 ? 'empty-array' : 'ok' }
}

/**
 * 只要候选数组（脏输入返回 `[]`，永不抛）。
 *
 * client 模式下解析失败等价于"没抽到经验"，不是一次请求失败，所以不进退避。
 */
export function parseCandidates(content) {
  return parseCandidatesReport(content).candidates
}

// ---------------------------------------------------------------- HTTP
/**
 * 发一次 JSON POST。
 *
 * 用 `AbortSignal.timeout` 而不是自己 setTimeout+abort：超时要覆盖**整个**请求（含
 * 服务端慢慢吐字节），而不是只覆盖单次读。所有失败（超时、网络、非 2xx、非 JSON）
 * 统一抛 `ExpError`，调用方只按一条路径计数退避。
 */
async function postJson(fetchImpl, url, body, { timeoutMs, key = '', label = 'request' }) {
  if (typeof fetchImpl !== 'function') throw new ExpError(`${label}: 运行时没有 fetch，无法请求 ${url}`, 'no-fetch')
  const headers = { 'content-type': 'application/json' }
  if (key !== '') headers.authorization = `Bearer ${key}`
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    })
  } catch (error) {
    const name = String(error?.name ?? '')
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ExpError(`${label}: 请求超时（${timeoutMs} ms）→ ${url}`, 'timeout')
    }
    throw new ExpError(`${label}: 连不上 ${url}：${messageOf(error)}`, 'network')
  }
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  if (!response.ok) {
    throw new ExpError(`${label}: ${url} → HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`, 'http')
  }
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ExpError(`${label}: ${url} 返回的不是 JSON：${text.slice(0, 120)}`, 'bad-json')
  }
}

// ---------------------------------------------------------------- 触发器
/**
 * 造一个 fire-and-forget 的经验抽取触发器。
 *
 * @param {object} options
 * @param {object} [options.exp]        配置（`config.exp`，原始形态即可，这里做归一）
 * @param {object} [options.logger]     `{ warn, info }`，缺省无声（宿主里的 `ctx.logger`）
 * @param {Function} [options.fetchImpl] 注入 fetch（测试用），默认全局 fetch
 */
export function createExperienceTrigger(options = {}) {
  const config = normalizeExpConfig(options.exp)
  const logger = options.logger !== null && typeof options.logger === 'object' ? options.logger : {}
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  /** session id -> 连续失败次数 */
  const failures = new Map()
  /** 在飞的请求（只为可观测性与测试收尾，不参与任何等待） */
  const inflight = new Set()
  const warned = new Set()

  const text = (value) => String(value ?? '').trim()

  const info = (message) => {
    try {
      logger.info?.(`dsh-memory-archive: exp: ${message}`)
    } catch { /* 日志失败不影响任何事 */ }
  }
  const warn = (message) => {
    try {
      logger.warn?.(`dsh-memory-archive: exp: ${message}`)
    } catch { /* 日志失败不影响任何事 */ }
  }
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  function configProblems() {
    const problems = []
    if (config.url === '') problems.push('exp.url')
    if (config.mode === 'client') {
      if (config.llmUrl === '') problems.push('exp.llmUrl')
      if (config.llmModel === '') problems.push('exp.llmModel')
    }
    return problems
  }

  async function runServerExtract(payload, label) {
    const url = expEndpoint(config.url, EXTRACT_PATH)
    const result = await postJson(fetchImpl, url, payload, { timeoutMs: config.timeoutMs, key: config.key, label })
    if (String(result?.status ?? '') === 'failed') {
      throw new ExpError(`${label}: 服务端任务失败：${String(result?.error ?? 'unknown').slice(0, 200)}`, 'server-failed')
    }
    return result
  }

  async function runClientExtract(payload, label) {
    const material = buildMaterial({ summary: payload.summary, verbatim: payload.verbatim })
    const chat = await postJson(
      fetchImpl,
      chatEndpoint(config.llmUrl),
      {
        model: config.llmModel,
        messages: [{ role: 'user', content: buildPrompt(material) }],
        max_tokens: config.llmMaxTokens,
        temperature: 0.2,
      },
      { timeoutMs: config.llmTimeoutMs, key: config.llmKey, label: `${label} 本机 LLM` },
    )
    const choice = chat?.choices?.[0]
    const content = choice?.message?.content ?? ''
    const reasoning = choice?.message?.reasoning_content ?? ''
    const finish = String(choice?.finish_reason ?? '')
    const report = parseCandidatesReport(content)
    if (report.candidates.length === 0) {
      // 三种"空"要分开说：模型判断没有经验 = 正常；没给出 JSON / 被截断 = 配置或模型问题。
      if (report.reason === 'empty-array') {
        return { candidates: 0 }
      }
      if (report.reason === 'empty-content') {
        warnOnce(
          'llm-empty-content',
          reasoning === ''
            ? `${label}：本机 LLM 返回的 content 为空（finish=${finish || '?'}），本段没有候选`
            : `${label}：本机 LLM 把预算花在 reasoning 上（${String(reasoning).length} 字符，finish=${finish || '?'}），content 为空；` +
              `调大 exp.llmMaxTokens（当前 ${config.llmMaxTokens}）或换非推理模型`,
        )
        return { candidates: 0, reason: 'empty-content' }
      }
      warnOnce(
        'llm-unparsable',
        `${label}：本机 LLM 输出不是 JSON 数组（${report.reason}），本段没有候选：${String(content).slice(0, 160)}`,
      )
      return { candidates: 0, reason: report.reason }
    }
    if (finish === 'length') {
      warnOnce(
        'llm-truncated',
        `${label}：本机 LLM 输出被 max_tokens=${config.llmMaxTokens} 截断（finish=length），本段候选可能不完整`,
      )
    }
    const imported = await postJson(
      fetchImpl,
      expEndpoint(config.url, IMPORT_PATH),
      {
        session_id: payload.session_id,
        segment_no: payload.segment_no,
        workflow: payload.workflow,
        apply: payload.apply,
        candidates: report.candidates,
      },
      { timeoutMs: config.timeoutMs, key: config.key, label: `${label} import` },
    )
    if (String(imported?.status ?? '') === 'failed') {
      throw new ExpError(`${label}: import 任务失败：${String(imported?.error ?? 'unknown').slice(0, 200)}`, 'server-failed')
    }
    return { candidates: report.candidates.length, result: imported }
  }

  /**
   * 真正干活：**永远不 reject**。
   *
   * 失败只做两件事：warn + 记一次连续失败计数。到达上限后本会话不再尝试。
   */
  async function runOnce(input, sessionId) {
    const segmentNo = Number.isFinite(Number(input.segmentNo)) ? Number(input.segmentNo) : 0
    const compactionId = text(input.compactionId)
    // 日志里带上 compaction id：服务端的 exp_jobs 与磁盘上的段文件因此能对上。
    const label = `session ${sessionId} segment ${String(segmentNo).padStart(3, '0')}${compactionId === '' ? '' : ` (compaction ${compactionId})`}`
    try {
      const workflowRaw = input.workflow !== undefined && text(input.workflow) !== ''
        ? input.workflow
        : workflowSlug(input.title, input.cwd)
      const built = buildExtractPayload({
        sessionId,
        segmentNo,
        workflow: workflowRaw,
        summary: input.summary,
        verbatim: input.verbatim,
        apply: config.apply,
        maxVerbatimBytes: config.maxVerbatimBytes,
      })
      if (built.truncated) {
        warn(`${label}：verbatim ${built.originalVerbatimBytes} B 超过上限 ${config.maxVerbatimBytes} B，已截断到 ${built.verbatimBytes} B`)
      }
      if (built.payload.summary === '' && built.payload.verbatim === '') {
        throw new ExpError(`${label}: summary 与 verbatim 都是空，跳过`, 'empty-material')
      }
      let summaryText
      if (config.mode === 'client') {
        const out = await runClientExtract(built.payload, label)
        summaryText = out.candidates === 0
          ? '本机 LLM 未产出候选（0 条），没有 import'
          : `本机 LLM 产出 ${out.candidates} 条候选，已提交 import（funnel=${JSON.stringify(out.result?.funnel ?? {})}）`
      } else {
        const result = await runServerExtract(built.payload, label)
        summaryText = String(result?.status ?? '') === 'skipped'
          ? `服务端跳过（${String(result?.reason ?? 'skipped')}）`
          : `服务端完成（status=${String(result?.status ?? '?')}, funnel=${JSON.stringify(result?.funnel ?? {})}, ${String(result?.ms ?? '?')} ms）`
      }
      failures.set(sessionId, 0)
      info(`${label}：${summaryText}`)
      return { ok: true }
    } catch (error) {
      const count = (failures.get(sessionId) ?? 0) + 1
      failures.set(sessionId, count)
      const detail = messageOf(error)
      if (count >= MAX_CONSECUTIVE_FAILURES) {
        warn(`${label}：抽取失败（第 ${count} 次，已达上限 ${MAX_CONSECUTIVE_FAILURES}）：${detail}；本会话不再尝试`)
      } else {
        warn(`${label}：抽取失败（第 ${count}/${MAX_CONSECUTIVE_FAILURES} 次）：${detail}`)
      }
      return { ok: false, error: detail }
    }
  }

  /**
   * 触发一次抽取。**同步返回、从不 throw、从不 await**。
   *
   * @returns {{started: boolean, skipped?: string}}
   */
  function fire(input) {
    try {
      if (!config.enabled) return { started: false, skipped: 'disabled' }
      const info0 = input !== null && typeof input === 'object' ? input : {}
      const sessionId = text(info0.sessionId)
      const attempts = failures.get(sessionId) ?? 0
      if (attempts >= MAX_CONSECUTIVE_FAILURES) return { started: false, skipped: 'backoff' }
      const verbatimBytes = Buffer.byteLength(String(info0.verbatim ?? ''), 'utf8')
      if (verbatimBytes < config.minSegmentBytes) {
        return { started: false, skipped: 'too-small', verbatimBytes }
      }
      const problems = configProblems()
      if (problems.length > 0) {
        warnOnce(`config:${problems.join(',')}`, `配置不完整（缺 ${problems.join(' / ')}），本段不抽取`)
        return { started: false, skipped: 'no-config' }
      }
      const job = runOnce(info0, sessionId)
      inflight.add(job)
      // 收尾只做集合清理；runOnce 本身不会 reject，但 catch 仍然保留以策万全。
      job.then(() => inflight.delete(job), () => inflight.delete(job))
      return { started: true }
    } catch (error) {
      // fire() 在 writeSegment 的同步路径上：任何异常都必须在这里被吞掉。
      warn(`触发失败（已忽略，不影响归档）：${messageOf(error)}`)
      return { started: false, skipped: 'error' }
    }
  }

  return {
    config,
    fire,
    /** 该会话的连续失败次数（测试与排障用）。 */
    failuresOf: (sessionId) => failures.get(text(sessionId)) ?? 0,
    /** 当前在飞的请求数（测试用；正常路径不需要等它）。 */
    inflightCount: () => inflight.size,
    /** 等所有在飞请求收尾（只给测试用；生产路径永不调用）。 */
    async whenIdle() {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight])
      }
    },
  }
}
