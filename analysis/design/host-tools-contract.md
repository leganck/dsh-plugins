# Host 半契约与骨架：插件式多根工作空间（task-4）

> 只读调研产物。**未安装任何东西、未改 profile、未改本体**。
> 本文只写「可直接照抄的契约 + 行号 + 骨架」，方案层的取舍见 `analysis/multi-root-workspace.md` §4，单根假设盘点见 `analysis/A-host-path-sandbox.md`，本仓插件打包约定见 `analysis/C-plugin-impact.md`。本文不重复那些结论，只在需要时引用。

## 0. 取证口径

| 记号 | 含义 |
| --- | --- |
| `%M%` | `C:\Users\legan\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules`（app.asar 内，**只有 `read` 工具能读**；`pwsh`/`glob`/`grep` 一律读不到，实测 `glob` 报 `os error 3`） |
| `X:12-34` | `%M%\@deepseek-ai\X\lib\index.js` 的第 12–34 行，已逐行读过 |
| 【Service】 | 用 `cordis_inspect_query(platform="host", provider="Service", method="listService", input={"service":"..."})` 取得的**活契约**。这类结论没有文件行号——它就是运行时类型声明本身；包名/版本以 `package.json` 为准（本机全部 `0.2.1-rc.2`） |
| 【Event】 | 同上，`provider="Event", method="listEvents"` |
| 【未确认】 | 拿不准的，附「下一步怎么验」 |

一条贯穿全文的硬约束（本仓既有断言）：**插件 Host 半不能 import 任何 `@deepseek-ai/*` 值**。
证据：`plugins/dsh-code-index/test-plugin.mjs:141-148`

```js
// dsh-ops 的硬教训：宿主这一半不能 import 任何 @deepseek-ai/* 值——
const dshImports = () => { ... /from\s+['"](@deepseek-ai\/[^'"]+)['"]/g ... }
check('源码不 import 任何 @deepseek-ai/* 值', dshImports.length === 0, dshImports.join(', '))
```

原因不是洁癖：Host 半以 `file:///.../index.js` 由 Loader 直接挂载，**不在 profile 的 node_modules 解析链里**，所以 `@deepseek-ai/dsh-tools` 的 `defineTool`、`@deepseek-ai/dsh-fs` 的 `FsError`、`@deepseek-ai/dsh-sandbox` 的 `approveEscalation` / `sandboxDenialMarker` **全都拿不到**。本文所有代码片段的写法都以这条为前提：**只用普通对象、手写校验、字符串错误码**。

---

## 1. 工具注册契约：`ToolDefinition` 全集与 schema 写法

### 1.1 契约原文（【Service】`tools`）

```ts
export interface ToolSchema {
    deferLoading?: true;
    name: string;
    description: string;
    parameters: Record<string, unknown>;      // ← 注意：任意 JSON，不是 JsonSchemaNode
}
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
export interface ToolRunContext extends ToolExecution {
    deferContext(context: UserMessage): void;
    concludeTurn(): void;
}
export interface ToolExecution extends ToolExecutionInput {
    readonly rootCallId: ToolCallId;
    readonly token: ToolExecutionToken;
}
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    readonly schema?: ToolSchema;
    readonly arguments: unknown;
    readonly agent?: Agent;          // ← 可选！
    readonly parent?: ToolExecutionToken;
    readonly signal: AbortSignal;
}
```

`register` 的**全部**校验（`dsh-tools:2974-2983`）：

```js
register(definition) {
  const name = definition.name;
  const output = definition.output;
  if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function")
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  assertSupportedJsonSchema(output.schema);
  const timeoutMs = definition.timeoutMs;
  if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(...);
  if (name === "run_code") throw new Error(`tool name "run_code" is reserved ...`);
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
}
```

**结论（关键三条）**

1. `output` 是**必填**，且 `render` 必须是函数；`output.schema` 必须落在强约束 JSON Schema 子集内（`dsh-tools:34-58`）：
   - 约束关键字只有 `type / oneOf / properties / required / additionalProperties / items / enum / const`；
   - 注解关键字只有 `description / title / default / examples`；
   - `type` 只能是 `object|array|string|number|integer|boolean|null`。
   - 越界直接在 `register()` 抛 `UNSUPPORTED_SCHEMA`（`dsh-tools:25-33`）。
2. `parameters` **在 register 阶段完全不校验、不改写**，`schemaOf` 原样透传给模型（`dsh-tools:3135-3145`）：

```js
schemaOf(definition, detachParameters) {
  const { name, description, parameters, deferLoading } = definition;
  const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
  if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
  return { name, description, parameters: detached, ...deferLoading === true ? { deferLoading } : {} };
}
```

   唯一硬要求是「lossless JSON」（不能塞函数、Symbol、undefined 值）。
3. `execute(args, exec)` 的 `exec` 就是 `ToolRunContext`，运行时构造见 `dsh-tools:3239-3254`：

```js
const base = {
  token, callId, rootCallId, name, signal,
  ...agent !== void 0 ? { agent } : {},       // agent 可选
  ...parent !== void 0 ? { parent } : {},
  ...exec.schema !== void 0 ? { schema: exec.schema } : {},
  deferContext(context) { deferredContexts.push(context); },
  concludeTurn() { concludingExecutions.add(this); }
};
```

### 1.2 schema DSL → 普通对象：**不要用 `defineTool` 的 spec DSL**

上游工具包写的是 `defineTool({ parameters: { file_path: { type: 'string', required: true } } })`（`dsh-tool-fs:250-267`、`dsh-tool-pwsh:465-502`），那是**需要 import 的** spec DSL。插件拿不到 `defineTool`，因此**必须直接写标准 JSON Schema**（`required` 提到对象级数组）。本仓 `plugins/dsh-code-index/index.js` 的 5 个工具全是这么干的，实测可注册、可调用、模型侧可见。

### 1.3 可直接照抄：插件注册一个工具的完整范式

摘自 `plugins/dsh-code-index/index.js:592-610`（注册与清理）与 `:769-790`（定义体），一字未改语义：

```js
// 注册即 effect：插件卸载 / profile patch 变更时由 cordis 回收，不需外部追踪
const toolDisposers = []
const registerTool = (def) => {
  const dispose = ctx.tools.register(def)
  if (typeof dispose === 'function') toolDisposers.push(dispose)
  else if (dispose && typeof dispose.dispose === 'function') toolDisposers.push(() => dispose.dispose())
  return dispose
}
ctx.effect(() => () => { for (const dispose of toolDisposers.splice(0)) try { dispose() } catch {} }, 'dsh-code-index: tools')

registerTool({
  name: 'code_index',
  description: '……',
  parameters: {                       // ← 标准 JSON Schema，不是 defineTool 的 spec DSL
    type: 'object',
    properties: {
      path: { type: 'string', description: '仓库根目录（绝对路径）。省略则用当前会话工作目录。' },
      mode: { type: 'string', enum: ['incremental', 'full'], description: '…' },
      status_only: { type: 'boolean', description: '只统计变化数量，不写入索引。' },
    },
    required: [],
    additionalProperties: false,
  },
  output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v.content?.[0]?.text ?? '' }] },
  async execute(args, exec) { /* 全部手写校验，返回 lossless JSON */ },
})
```

**多根插件要照抄的校验手法**（同一文件 `:613-619`、`:631-635`）：

```js
const sessionCwd = (exec) => {                       // exec.agent 可能不存在
  try { return exec?.agent?.session?.cwd ?? process.cwd() } catch { return process.cwd() }
}
function assertAllowed(repoRoot) {                    // 白名单：自己实现，别指望 provider
  if (!config.allowedRoots.length) return
  const ok = config.allowedRoots.some((r) => repoRoot === r || repoRoot.startsWith(r + path.sep))
  if (!ok) throw new Error(`路径不在允许的 roots 白名单内：${repoRoot}\n已配置：${config.allowedRoots.join(', ')}`)
}
```

> ⚠️ 上面 `startsWith(r + path.sep)` 的字符串前缀判定**不要在多根插件里复用**——它不做 canonicalize。多根场景一律用 `ctx.fs.contains(rootTarget, fileTarget)`（见 §3.3）。

### 1.4 错误如何让模型看见（结构化 code 会丢，必须写进文案）

`dsh-tools:3712-3726` + `:2709-2718`：

```js
function toolErrorResult(error) {
  const info = errorInfo(error);      // 只有 HarnessError 才产出 { name, code }
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true, error: { message, ...info ? { info } : {} } };
}
function errorInfo(error) { return error instanceof HarnessError ? { name: error.name, code: error.code } : void 0; }
```

插件 `throw new Error(...)` → 模型只看到 `Error: <message>`，`result.error.info.code` 为空。所以：
- 自造错误码必须**写进消息文本**（如 `"multi_write: ROOT_NOT_FOUND …"`）；
- 想要保留上游 `FsError` 的 `FS_STALE_VERSION` / `FS_NOT_OBSERVED` 结构化码：**不要 new 一个**（`FsError` 类拿不到），而是**原地改 `error.message` 再 rethrow**——它仍是 `HarnessError` 实例，`instanceof` 判定不变，code 保留。见 §3.4 片段。【未确认：`FsError.message` 运行时是否可写（TS 侧是 readonly 字段）。验法：在 `multi_write` 的 catch 里 `console.log(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'message'))`，或直接 `e.message = '...'` 后看 `result.error.info.code` 是否仍为 `FS_STALE_VERSION`。】

---

## 2. 工具作用域与拦截

### 2.1 契约原文（【Service】`tools`）

| 方法 | 原文摘要 |
| --- | --- |
| `register(definition)` | "Register globally or in the calling agent scope. **Scoped tools shadow globals**; duplicates within one layer and the reserved `run_code` name fail." |
| `restrict(filter)` | "Restrict global tools for the calling agent scope. Empty filters, unknown names, scope-local names, and reserved transport names fail. Restrictions intersect; scoped registrations remain visible." |
| `guard(guard)` | "Register a **monotonic** guard after the extensible `tools/pre-execute` waterfall. A plain-context guard applies globally; one registered through `agent.ctx` applies only to that agent. Any matching guard may deny by returning a reason, while **no guard can force-allow** a call another guard denied." |
| `get(name, scope?)` | "Look up a tool as one scope sees it (scoped shadows global; a restricted-away global reads as absent)." |

`ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`；`ToolRestriction = { allow?: readonly string[]; deny?: readonly string[] }`。

### 2.2 实现（逐行）

- 同层重复 → 抛错，且**错误文案直接告诉你去 `agent.ctx`**（`dsh-tools:2731`）：

```js
this.tools = new NamedEntries((name) => new Error(scope === void 0
  ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
  : `tool "${name}" is already registered in this scope`));
```

- shadow 的实现就是这个 `view()`（`dsh-tools:3055-3075`）：先铺 global，再铺祖先层，**最后铺自己这一层**，自己层无条件覆盖同名；restrictions 只过滤「继承来的」，不影响自己层注册的。

- `restrict` 必须在 scoped ctx 上调用（`dsh-tools:2991-2996`）：`scope === undefined` 直接抛 `tools.restrict() requires a scoped context (agent.ctx)`。

- `guard` 可以全局（普通 ctx）也可以 per-agent；判定顺序 global 优先，然后 scope 链 farthest-first（`:3024-3032`）。

### 2.3 结论（对多根插件）

1. **`exec.agent` 不是总存在**（`ToolExecutionInput.agent?`，且 `createExecution` 用条件展开）。任何用到 `agent.session` / `ctx.workingDirectory` 的地方都要 `exec.agent === void 0` 分支——上游就是这么写的（`dsh-tool-fs:171-177`）。
2. **`tools/pre-execute` 不能改参数**（`PreToolDecision` 只有 `allow|deny|cancel|ask`），`tools/execute` 只能改 `exec.signal`。所以「让内置 `write` 认 `root` 参数」**没有正规插件手段**，只能 shadow 同名工具（要重实现 schema/卡片/观测/审批，代价见 C 报告 §6.3）。MVP 走「新工具名 + 提示词约束」。
3. `guard` 是**收紧**工具：可以用来做「根白名单」式的最后一道闸（例如只允许 `multi_*` 在 `readonly: false` 的根上跑），但它拿不到「打算写哪个根」这种语义，只能在参数里 grep——不建议作为主防线。
4. **`agent.ctx` 从插件里怎么拿**：`agent/created` 的 `this` 被声明成 `Scoped<Agent>`（【Event】`agent/created` 签名 `'agent/created'(this: Scoped<Agent>, payload: …)`），`Scoped<T>` 是不透明品牌类型（`dsh-scope` 契约 `export type Scoped<T> = object & { readonly [ScopedBrand]: T }`），背后是 `createScope()` 造出来的、带 scope tag 的真 Context（`dsh-scope:296-306`），它 "owns every registration made through it"。**推论**：在 `agent/created` 监听器里 `this.tools.register(...)` 会落到该 agent 层，天然 shadow 全局。**但【未确认】**：`this` 运行时是否完整暴露 `tools`/`effect`/`inject`（类型上不可见）。验法：插件里 `ctx.on('agent/created', function (p) { console.log(Object.keys(this)) })` 打一次，确认 `tools`/`effect` 在不在；不在就退回全局注册。

```js
// 兜底方案 B（不需要 agent.ctx）：全局注册新工具名 + 自己按 session 存默认根（§7.3）
// 只有当「必须让模型沿用 write/edit 这两个名字」时才需要 shadow，且必须按 §2.3-4 先验证 this。
```

---

## 3. fs 观测策略：read-before-write 到底怎么触发

### 3.1 三条 `fs/*` 事件的契约原文（【Event】）

```
'fs/write-intent'(target: FsTarget, actor: object | undefined,
                  next: () => FsWriteIntent | undefined | Promise<…>): Promise<FsWriteIntent | undefined>
  mode: waterfall
  "Single-slot decision for the next FileSystem.writeText. Calling `next()` yields the bare provider's
   unconditional write; the first listener that returns an intent owns the decision rather than composing with peers."

'fs/edit-intent'(…同上…)   mode: waterfall

'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
  mode: emit
  "Record an authoritative positive or negative observation. Listeners must be synchronous recorders:
   throws fail the tool call and returned promises are not awaited."

export type FsObservation = { readonly kind: 'present'; readonly version: FsVersion } | { readonly kind: 'absent' };
export type FsWriteIntent = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion };
```

### 3.2 策略插件全文（`dsh-fs-observation-policy:15-95`，一共 97 行，没有 service）

```js
owner(actor) { return actor?.agent?.session; }                       // :29-31 观测状态按「会话对象」弱引用

writeIntent(target, actor) {                                          // :51-58
  const owner = this.owner(actor);
  const prior = owner ? this.get(owner, target.targetKey) : void 0;
  return prior?.kind === "present"
    ? { kind: "replaceIfVersion", version: prior.version }
    : { kind: "createIfAbsent" };                                     // 没见过 ⇒ 尝试「创建」
}

editIntent(target, actor) {                                           // :64-70
  const owner = this.owner(actor);
  const prior = owner ? this.get(owner, target.targetKey) : void 0;
  if (!owner || prior === void 0) throw new FsError(`edit requires reading "${target.displayPath}" first`, "FS_NOT_OBSERVED");
  if (prior.kind === "absent")   throw new FsError(`cannot edit "${target.displayPath}": not found`, "FS_NOT_FOUND");
  return { version: prior.version };
}

function apply(ctx) {                                                 // :85-95
  ctx.on("fs/write-intent", (target, actor) => Promise.resolve().then(() => gate.writeIntent(target, actor)));
  ctx.on("fs/edit-intent",  (target, actor) => Promise.resolve().then(() => gate.editIntent(target, actor)));
  ctx.on("fs/observed",     (target, observation, actor) => { gate.observe(target, observation, actor); });
}
```

**注意 `:23-28` 的注释**：`owner` 是「通常 agent session」；`undefined` 时"such calls **read freely but cannot satisfy the write/edit prior-observation policy**"。

### 3.3 谁抛什么：provider 侧的最后一刀（`dsh-fs-local:864-882`）

```js
async writeText(target, content, expected, signal) {
  return this.withLock(target.targetKey, async () => {
    const existing = await probe(target.targetKey);
    if (existing && existing.type !== "file") throw new FsError(…, "FS_NOT_REGULAR_FILE");
    if (expected?.kind === "replaceIfVersion") {
      if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, "FS_STALE_VERSION");
      if (existing.version !== expected.version) throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
    } else if (expected?.kind === "createIfAbsent" && existing)
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED");   // ← 这就是 read-before-write
    …
  });
}
```

`editText` 同文件 `:883-900`：文件不在 → `FS_STALE_VERSION`；`expected.version` 不等 → `FS_STALE_VERSION`；`oldString` 找不到 → `FS_EDIT_NOT_FOUND`；多次命中且 `replaceAll === false` → `FS_AMBIGUOUS_EDIT`（`:698-709`）。

### 3.4 结论：`multi_write` 要满足的**六个前置条件**

| # | 条件 | 不满足时 |
| --- | --- | --- |
| 1 | 必须把 **`exec` 本身**（而不是 `{}`、`undefined`）作为 `actor` 传给 `ctx.waterfall("fs/write-intent", target, exec, …)` | `owner` 取不到 → 永远 `createIfAbsent` → 覆盖已存在文件必被 `FS_NOT_OBSERVED` 拒（`dsh-fs-observation-policy:29-31` + `dsh-fs-local:871`） |
| 2 | 覆盖已有文件前，**必须先让会话「看过」这个文件**：用原生 `read`，或自己的 `multi_read` 在返回前 `ctx.emit("fs/observed", target, {kind:'present', version: info.version}, exec)` | 同上 |
| 3 | `multi_read` 必须**先 `stat` 再 `readText`**，并把**同一个** `info.version` 写进 `fs/observed` | 版本写错 → 之后 `replaceIfVersion` 版本不匹配 → `FS_STALE_VERSION` |
| 4 | `multi_write` 成功后**必须自己 emit `fs/observed({kind:'present', version: outcome.version})`**，否则本会话后续 `multi_edit` 立刻被 `FS_NOT_OBSERVED` 拒 | 连续编辑第二处失败 |
| 5 | `edit` 必须走 `ctx.waterfall("fs/edit-intent", …)` 拿 `{version}` 传第 3 参 | 不传 → 无 CAS（provider 允许无条件改，等于把护栏关掉） |
| 6 | 任何 `stat === undefined` 的判定都要先 emit `{kind:'absent'}` 再抛 `FS_NOT_FOUND`（照 `dsh-tool-fs:191-203` 的做法） | 之后想创建该文件时，状态是「没见过」→ 语义虽同 `createIfAbsent`，但错误文案不区分 |

**可直接照抄的方向**：`dsh-tool-fs` 的 read/write/edit 三处就是标准答案，行号分别为
`191-203`（读目标 + absent 观测）、`335-355`（read 成功后的 present 观测）、`603-615`（write）、`747-762`（edit）、`492-502`（`mutationResult`：剥掉 `version` 再 emit）。

```js
// dsh-tool-fs:492-502 —— 写成功后把 version 塞进观测，结果里不带 version
function mutationResult(ctx, target, outcome, exec) {
  const { version, ...result } = outcome;
  ctx.emit("fs/observed", target, { kind: "present", version }, exec);
  return { path: ctx.fs.processPath(target), ...result };
}
```

### 3.5 `multi_write` 骨架（40 行内，含围栏 + 观测 + 错误码保留）

```js
const FsErrorLike = (e) => e && typeof e === 'object' && typeof e.code === 'string' && e.code.startsWith('FS_')

async function writeOne(ctx, roots, exec, args) {
  const { root, file, content } = validateWriteArgs(args)          // ← 手写校验，见 §8.4
  const r = roots.require(root, exec)                              // { id, path, readonly, target }
  if (r.readonly) throw new Error(`multi_write: root "${r.id}" is read-only`)
  const policy = { ...ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {}),
                   workspaceRoot: r.path }                          // ← §4.3：只换 root，不动 mode
  if (policy.mode === 'read-only') throw new Error(`multi_write: session file policy is read-only`)

  const target = await ctx.fs.resolve(file, { cwd: r.path, signal: exec.signal })
  if (!ctx.fs.contains(r.target, target)) throw new Error(`multi_write: "${file}" escapes root "${r.id}"`)
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)

  let outcome
  try {
    outcome = await ctx.fs.writeText(target, content, intent, exec.signal, policy)
  } catch (e) {
    if (FsErrorLike(e) && (e.code === 'FS_NOT_OBSERVED' || e.code === 'FS_STALE_VERSION')) {
      try { e.message = `${e.message} — multi_read this file first, then retry` } catch {}
      throw e
    }
    throw e
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return { root: r.id, path: ctx.fs.processPath(target), operation: outcome.operation }
}
```

---

## 4. 写入 / 编辑 API 的精确形状

### 4.1 契约原文（【Service】`fs`）

```ts
abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal,
                   sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
abstract editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal,
                  sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>

export interface FsTarget   { targetKey: FsTargetKey; displayPath: string; }
export type      FsVersion  = Branded<'FsVersion'>;                 // 不透明，别自己 string 化
export type      FsWriteIntent = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion };
export interface FsWriteOutcome { operation: 'create' | 'update'; version: FsVersion; before: string | null; after: string; }
export interface FsEditRequest  { oldString: string; newString: string; replaceAll: boolean; }   // replaceAll 必填 boolean
export interface FsEditOutcome  { version: FsVersion; before: string; after: string; }
export interface FsInfo { version: FsVersion; type: 'file' | 'directory' | 'other'; size?: number; }
export interface SandboxExecutionPolicy { mode: SandboxMode; workspaceRoot: string; sessionId?: SessionId; }
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
```

`resolve(path, opts?)` 的 `opts = { cwd?, signal? }`；`contains(parent, child): boolean`；`processPath(target): string`（拿绝对路径回显给模型）。

### 4.2 结论

- `FsEditRequest.replaceAll` **不是可选**，必须显式 `true/false`；支持「多处替换」，靠的就是这个布尔。
- `edit` 的版本守卫是 `{ version }`（不是 `FsWriteIntent`），和 write 的 intent 形状**不同**——两者不能混用。
- 两个 mutation 的第 5 参 `sandboxPolicy` 就是「按目标根授权」的**唯一入口**（§6.3、§4.4）。
- `FsTarget` 不透明：只能 `ctx.fs.processPath()` 得到可读路径，**不要在插件里 `String(target.targetKey)` 硬算**（本机 local backend 恰好 `return String(target.targetKey)`（`dsh-fs-local:789-791`），但这是实现细节）。

### 4.3 tool-fs 的 edit 参数如何映射（照抄依据，`dsh-tool-fs:658-668` + `:747-758`）

```js
function parseEditArgs(args) {
  if (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
  if (args.old_string.length === 0) throw new Error("old_string must be a non-empty string");
  if (args.old_string === args.new_string) throw new Error("old_string and new_string must differ");
  return { filePath: args.file_path, oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all ?? false };
}
…
async execute(args, exec) {
  const input = parseEditArgs(args);
  const sandboxPolicy = await sandbox.resolvePolicy("edit", args, exec);     // ctx.sandboxPolicy.resolve({session}) 或批准后的更宽 mode
  const target = await ctx.fs.resolve(input.filePath, await sessionResolveOptions(ctx, exec));
  try {
    const intent = await ctx.waterfall("fs/edit-intent", target, exec, () => void 0);   // 传 exec 当 actor
    outcome = await ctx.fs.editText(target, { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
                                    intent, exec.signal, sandboxPolicy);
  } catch (error) { throw remediateFsError(sandbox.mapError(error, sandboxPolicy), target.displayPath); }
  return mutationResult(ctx, target, outcome, exec);
}
```

### 4.4 `workspaceRoot` 怎么换成目标根（`dsh-sandbox-policy:141-148`）

```js
resolve(request = {}) {
  const { session } = request;
  return {
    mode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,
    workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),   // ← 永远单值，且来自 header.cwd
    ...session === void 0 ? {} : { sessionId: session.id }
  };
}
```

**结论**：服务本身**没有**多根能力，插件必须自己覆盖 `workspaceRoot`，并且**只覆盖这一个字段**——`mode` 保持会话原值（`read-only` 仍只读、`danger-full-access` 不被收窄），`sessionId` 保留（下游 ACL/temp 授权可能用）。`dsh-tool-fs:1134-1156` 的 `resolvePolicy` 也只改 `mode`、不动 root，两者正好互补。

围栏消费侧（`dsh-fs-sandbox:153-166`）：

```js
async checkedTarget(target, sandboxPolicy) {
  const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
  if (policy.mode === "danger-full-access") return target;
  if (policy.mode === "read-only") throw new FsError(`… denied under read-only mode`, "FS_SANDBOX_DENIED");
  const fresh = await this.resolve(target.displayPath);
  let contained = false;
  for (const root of writableRoots(policy)) if (await isPathUnder(fresh.targetKey, root)) { contained = true; break; }
  if (!contained) throw new FsError(`… denied under workspace-write mode`, "FS_SANDBOX_DENIED");
  return fresh;
}
```

`writableRoots(policy)`（`dsh-sandbox:166-173`）= `[policy.workspaceRoot, "/tmp", os.tmpdir()]` 去重后的 canonical 列表。**所以「根 B 可写」= 把 `workspaceRoot` 填成根 B，仅此一法**。

---

## 5. 审批：`workspace_roots add` 的一次性授权

### 5.1 契约原文（【Service】`approval`）

```ts
async request(req: ApprovalRequest): Promise<ApprovalOutcome>
setPolicy(agent: Agent, policy: ApprovalPolicy): void
overrideOf(session: Session): ApprovalPolicy | undefined

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export type ApprovalPolicy  = 'ask' | 'never';
export interface ApprovalRequest {
    readonly agent: Agent;
    readonly toolName: string;
    readonly callId?: ToolCallId;
    readonly reason?: string;
    readonly displayReason?: { readonly en: string; readonly [locale: string]: string };
    readonly signal?: AbortSignal;
}
```

原文要点：
- "`'allowed-once'` is the only grant."
- "The request **requires an open turn** because the audit pair must be enclosed by the durable log's commit/replay boundary; **an idle ask rejects before appending anything**."
- 失败闭包：`aborted → 'cancelled'`、缺/抛异常 answerer → `'unavailable'`、非法返回值 → 归一为 `'unavailable'`。

### 5.2 上游是怎么用它的（`dsh-sandbox:99-123`）

```js
async function approveEscalation(request, approval) {
  const { requestedMode: mode, effectiveMode, justification, subject } = request;
  if (mode === effectiveMode) return effectiveMode;                                   // 重复当前模式：不问
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider …`);
  if (approval.approver === void 0) throw new Error(`… no approval service is composed`);
  if (approval.agent === void 0)    throw new Error(`… the call has no agent to route it through`);
  const outcome = await approval.approver.request({
    agent: approval.agent, toolName: approval.toolName, callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    displayReason: { en: `Allow this operation with ${mode} permissions: ${justification}`,
                     zh: `允许本次操作使用 ${mode} 权限：${justification}` },
    ...approval.signal ? { signal: approval.signal } : {}
  });
  switch (outcome) {
    case "allowed-once": return mode;
    case "rejected":    throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`);
    case "cancelled":   throw new Error(`approval for escalating to "${mode}" was cancelled`);
    case "unavailable": throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`);
  }
}
```

`WIDER_MODES`（`dsh-sandbox:30-33`）：`read-only → [workspace-write, danger-full-access]`，`workspace-write → [danger-full-access]`。
`ESCALATION_TARGETS = ["workspace-write", "danger-full-access"]`（`:42`）。
文案常量（插件**必须在源码里内联**，因为拿不到 import）：
- `sandboxDenialMarker(mode)` = `` `[sandbox: file access denied under ${mode} mode]` ``（`:64-66`）
- `escalationHintMarker(subject)` = `` `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]` ``（`:76-78`）
- `sandboxPermissionsDescription(subject)` = `` `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.` ``（`:86-88`）
- `validateEscalationArgs` 三条报错原文（`:51-55`）：`invalid escalation: sandbox_permissions requires a justification` / `invalid escalation: justification is only valid together with sandbox_permissions` / `invalid justification: expected a non-empty sentence`。

### 5.3 结论：`workspace_roots add` 的授权怎么写

- 用 `ctx.approval.request({ agent: exec.agent, toolName: 'workspace_roots', callId: exec.callId, reason, displayReason: { en, zh }, signal: exec.signal })`，**只认 `'allowed-once'`**，其余全部拒绝并给出可读原因。
- **`exec.agent` 必须有**（否则 `approval.request` 也路由不出去）——`workspace_roots add` 应显式 `if (!exec.agent) throw …`。
- **只在 turn 内可用**：`add` 是模型发起的工具调用，turn 一定是开着的，安全。
- 插件**不要**去 `setPolicy`；那是给用户命令用的。多根插件只需要「一次性授权 + 落盘」。

```js
async function askAdd(exec, id, absPath) {
  if (exec.agent === void 0) throw new Error('workspace_roots add: no agent on this call — cannot route an approval')
  const outcome = await ctx.approval.request({
    agent: exec.agent,
    toolName: 'workspace_roots',
    callId: exec.callId,
    reason: `add workspace root "${id}" -> ${absPath}`,
    displayReason: {
      en: `Allow adding "${absPath}" as workspace root "${id}"? Tools using this root can read and (unless marked read-only) write there.`,
      zh: `允许把 "${absPath}" 加为工作空间根 "${id}"？使用该根的工具可以读写该目录（除非标记 read-only）。`,
    },
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') throw new Error(`workspace_roots add: approval ${outcome}; root "${id}" was not added`)
}
```

---

## 6. shell：`ctx.shell.resolve` → `execute`，还是自己 `spawn + confine`

### 6.1 契约原文（【Service】`shell` / `sandbox`）

```ts
// shell
abstract resolve(request: ShellExecRequest): ShellExecSpec;
abstract execute(spec: ShellExecSpec): Promise<ShellExecution>;

export interface ShellExecRequest {
    command: string; workdir?: string; timeoutMs?: number; onExpiry?: ShellExpiryPolicy;
    stdoutMaxBytes?: number; signal?: AbortSignal; stdin?: string; env?: Record<string, string>;
    dshEnv?: DshEnvironment; sandboxPolicy?: SandboxExecutionPolicy;
}
export interface ShellExecSpec {                      // resolve 后全部字段必填（默认/cap 已应用）
    command: string; workdir: string; timeoutMs: number; onExpiry: ShellExpiryPolicy;
    stdoutMaxBytes: number; signal?: AbortSignal; stdin?: string; env?: Record<string, string>;
    dshEnv?: DshEnvironment; sandboxPolicy: SandboxExecutionPolicy | undefined;
}
export interface ShellExecution extends ShellProcess { result(): Promise<ShellRunResult>; }
export interface ShellRunResult {
    exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean;
    timeoutMs: number; stdout: CollectedOutput; stderr: CollectedOutput; sandbox?: ShellSandboxInfo;
}
export interface ShellSandboxInfo { mode: SandboxMode; denied: boolean; enforcement?: 'full'|'partial'; runnerFailed?: boolean; }
// 另有能力字段（不在 methods 表里，但上游工具读它）：ctx.shell.sandboxMode、ctx.fs.sandboxMode

// sandbox
abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>;
export interface SandboxPolicy extends SandboxExecutionPolicy { mode: ConfinedSandboxMode; }   // 不含 danger-full-access
export interface ConfinedArgv { argv: string[]; enforcement: SandboxEnforcement;
                                denialSignatures: readonly string[]; runnerFailureRules: readonly RunnerFailureRule[]; }
```

### 6.2 本 profile（Windows/pwsh）下上游怎么构造命令（`dsh-tool-pwsh:628-678`）

```js
const standingPolicy = resolveSandboxPolicy(exec);        // :321  sandboxPolicy?.resolve(exec.agent ? {session} : {})
const cwd      = exec.agent === void 0 ? void 0 : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
const workdir  = resolveWorkdir(args.workdir, cwd);        // :261-265 相对 workdir 按 session cwd 解析
const request  = {                                        // :638-644
  command: args.command,
  ...workdir !== void 0 ? { workdir } : {},
  ...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {},
  dshEnv: ctx.shellEnv.collect(exec),
  ...policy !== void 0 ? { sandboxPolicy: policy } : {},   // ← 根在这里就定了
};
const spec   = ctx.shell.resolve({ ...request, signal: exec.signal });   // :672-675
const result = await (await ctx.shell.execute(spec)).result();           // :676
```

`sandboxPolicy` 生效的地方在**执行器**里（`dsh-pwsh-sandbox:145-150` + `:151-205`）：

```js
resolve(request) {
  return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() };
}
async execute(spec) {
  const policy = spec.sandboxPolicy; const { mode } = policy;
  if (mode === "danger-full-access") return …直接跑，标 { mode, denied: false }…;   // :154-160
  let confined;
  const ex = await this.executeArgv(spec, async (signal) => {
    const prepared = await this.confine(spec, { ...policy, mode }, signal);       // ← 真正的围栏
    confined = prepared; return prepared.argv;
  }, …);
  return SandboxPwshExecutor.decorateResult(ex, (result) => ({ ...result, sandbox: { mode, denied: classifyDenial(result, confined.denialSignatures), enforcement } }), …);
}
get sandboxMode() { return this.mode; }                                           // :136-139 capability fact
```

**结论**：`request.sandboxPolicy` 是**唯一**的根决策点；执行器优先用它，只在缺失时回落到 `ctx.sandboxPolicy.resolve()`（部署级，**不是会话级**）。所以 `multi_sh` **必须显式传 policy**，且 `workdir` 也要落在同一根（否则 ACL 里 workdir 可进、写入被拒，报 `FS_SANDBOX_DENIED` 风格的 marker）。

### 6.3 两种实现对比与推荐

| 维度 | A. `ctx.shell.resolve/execute`（推荐） | B. `ctx.subprocess.spawn` + `ctx.sandbox.confine` |
| --- | --- | --- |
| 围栏 | 执行器内部调 `confine`，含 `denialSignatures` 分类 | 自己调 `confine(argv, policy)`；`SandboxPolicy.mode` **不含** `danger-full-access`，必须自己特判直跑（照 `dsh-pwsh-sandbox:154-160`） |
| 命令形态 | 只能给 `command` 字符串（本机执行器就是 `pwsh -Command`） | 任意 argv，可完全绕开 shell |
| 输出 | `CollectedOutput{text,truncated,spillPath}` 已做 tail 截断 + 溢出落盘 | 自己实现读取/截断/spill（`ShellProcess.readOutput` 那套） |
| 超时/取消 | `timeoutMs`+`onExpiry:'kill'|'none'`+`signal`，非零退出**不** reject（只基础设施失败才 reject） | 自己 kill 与等待，易漏 |
| Windows ACL | 已与 `dsh-sandbox-local` 对齐（新 root + sessionId 现场建 grant，见 A 报告 §8.5） | 同一 `confine`，理论一致，但要自己传对 `SandboxPolicy` |
| 代码量 | ~30 行 | ~200 行（等于重写 `executeArgv` + 分类 + 渲染） |
| 上游漂移风险 | 低（复用执行器） | 高（复制内部实现） |

**推荐 A**。只有在「必须精确控制 argv、不经 shell」时才考虑 B，且必须以 `%M%\@deepseek-ai\dsh-pwsh-sandbox\lib\index.js:151-205` 为蓝本逐行对齐。
无论哪种，**`danger-full-access` 都要单独分支**：A 里执行器自己处理；B 里必须跳过 `confine`（`SandboxPolicy.mode` 类型上根本不含它）。

```js
// multi_sh（方案 A）：root 决定 workdir 与 policy，二者必须同一根
async function runOne(ctx, roots, exec, args) {
  const { root, command, workdir, timeout_ms } = validateShArgs(args)
  const r = roots.require(root, exec)
  const policy = { ...ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {}), workspaceRoot: r.path }
  if (r.readonly && policy.mode !== 'read-only') throw new Error(`multi_sh: root "${r.id}" is read-only`)
  const cwd = workdir === undefined ? r.path
    : path.isAbsolute(workdir) ? workdir : path.resolve(r.path, workdir)
  if (!cwd.startsWith(r.path)) throw new Error(`multi_sh: workdir escapes root "${r.id}"`)
  const spec = ctx.shell.resolve({ command, workdir: cwd, ...(timeout_ms ? { timeoutMs: timeout_ms } : {}),
                                   signal: exec.signal, sandboxPolicy: { ...policy, workspaceRoot: r.path } })
  const res = await (await ctx.shell.execute(spec)).result()
  const notes = res.sandbox?.runnerFailed ? [`[sandbox: the sandbox runner itself failed under ${res.sandbox.mode} mode — the command did not run]`]
              : res.sandbox?.denied       ? [`[sandbox: file access denied under ${res.sandbox.mode} mode]`]
              : []
  return { root: r.id, cwd: spec.workdir, exit_code: res.exitCode, timed_out: res.timedOut,
           stdout: res.stdout.text, stderr: res.stderr.text, notes,
           ...(res.stdout.truncated && res.stdout.spillPath ? { stdout_spill: res.stdout.spillPath } : {}) }
}
```

> `dshEnv` 与 `ctx.shellEnv.collect(exec)` 建议**一起带上**（`dsh-tool-pwsh:642`）：它给子进程注入 `DSH_*` 环境事实，跳过它会让 `pwsh` 里的 `$env:DSH_*` 与原生工具不一致。`shellEnv` 是可选服务，取不到就省略该字段。

---

## 7. 会话 / Agent 生命周期与「按会话存默认根」

### 7.1 事件契约（【Event】）

```
'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined>
  mode: serial
  "An entered agent is ready for per-agent initialization after factory setup. Listeners run in order and are
   awaited before creation resolves. AgentLoop holds queued input until all listeners finish. A throw or rejection
   fails creation and skips later listeners. Disposal retains the scope and session until dispatch settles;
   listeners must not await agent.whenIdle() or their own owner's disposal."

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';
'agent/pre-step'(this: Scoped<Agent>, payload: { agent, messages, turn, step, signal }, next)  mode: waterfall
```

`Session`（【Service】`approval`/`sandboxPolicy` 的 referencedTypes 原文）关键成员：
`readonly header: SessionHeader`（含 `cwd?: string`、`id`、`agentPreset?`、`parentSession?`）、`get id(): SessionId`、`append()`、`deriveMessages()`。`Agent` 的**公开**形状只有 `{ readonly id: SessionId }`；`session` 是运行时字段（上游到处用 `exec.agent.session`，例：`dsh-tool-fs:172`、`dsh-tool-pwsh:321`、`dsh-sandbox-policy:127`）。

### 7.2 `agent.ctx` 的清理方式（`dsh-scope:282-306`）

```js
async function quiesceFiber(fiber) { await Promise.resolve(fiber.dispose()); while (fiber.inertia !== void 0) await fiber.inertia; }

function createScope(ctx, key, options) {
  if (options?.parent !== void 0) bindScopeParent(key, options.parent);
  const fiber = ctx.plugin(scope);
  const scoped = fiber.ctx.extend({ [kScope]: key });
  let disposing;
  return { ctx: scoped, rawDispose: fiber.dispose, dispose: () => disposing ??= quiesceFiber(fiber) };
}
```

**结论**：通过 `agent.ctx` 做的注册由**agent 的 scope fiber** 拥有，agent scope 销毁时随 fiber 一起回收（`quiesceFiber` 等 inertia 排空）。插件**不需要**自己追踪 disposer。反之，通过插件根 ctx 注册的全局工具由插件 fiber 回收（即 `plugins/dsh-code-index/index.js:599-610` 那套 `ctx.effect` 的用武之地——它其实是给「不能在 ctx.effect 里直接写注册」的场景兜底）。

### 7.3 按 session 存「当前默认根」——三种落法

| 方案 | 生命周期 | 适不适合 |
| --- | --- | --- |
| `Map<SessionId, rootId>` 模块级 | 进程内，DSH 重启即失忆 | MVP 够用（默认根多数情况就是 primary） |
| 同上 + `$DSH_HOME/dsh-multiroot/sessions/<id>.json` 落盘 | 跨重启 | ✅ 推荐：`resume` 后能续上 |
| 写进 session 事件 | ❌ **不可行**：Session 事件类型封闭，live `append()` 设不了 `ignorable: true`（这条在 `multi-root-workspace.md:151` 已有结论） | 禁止 |

会话来源：`ctx.on("session/created", (session) => …)` + `ctx.sessions.list()` 补齐存量（`dsh-permission-presets:202-205` 就是这个写法）。**注意**：`session/created` 给的是 `Session`，能直接读 `session.id` / `session.header.cwd`，比 `agent/created` 更好用；`agent.created` 才有 `Agent`（审批、`workingDirectory` 需要它）。

```js
// 会话 → 当前默认根；纯文件落盘，不进 session log
const KEY = (id) => path.join(dshHome(), 'dsh-multiroot', 'sessions', `${sanitize(id)}.json`)

function sessionRoot(session) {
  const id = String(session.id)
  const cached = sessionRoots.get(id)
  if (cached !== undefined) return cached
  const def = readJson(KEY(id))
  const picked = def && registry.has(def.root) ? def.root : registry.primary
  sessionRoots.set(id, picked)
  return picked
}
function setSessionRoot(session, rootId) {
  registry.require(rootId)                                  // 不存在直接抛
  sessionRoots.set(String(session.id), rootId)
  writeJsonAtomic(KEY(session.id), { version: 1, root: rootId, at: Date.now() })
}

ctx.on('session/created', (session) => { sessionRoot(session) })        // 预热 + 兜底解析
ctx.effect(() => () => { sessionRoots.clear() }, 'dsh-multiroot: session map')
```

`DefaultRoot` 的**权威起点**是 `session.header.cwd`：根清单里没有它时，退化为「单根 = header.cwd」并在提示词里明说（`multi-root-workspace.md:223` 已有同结论）。

---

## 8. Host 半骨架清单

### 8.1 文件与导出

| 文件 | 内容 |
| --- | --- |
| `plugins/dsh-multiroot/index.js` | **单文件 Host 半**，`export const name = 'multiroot'`、`export const inject = [...]`、**可选** `export const Config = {...}`（见 8.6）、`export function apply(ctx, config)`。**零 import `@deepseek-ai/*`**；只允许 `node:fs` / `node:path` / `node:os` 与 `crypto`。 |
| `plugins/dsh-multiroot/cordis.patch.yml` | `file:///.../index.js` 挂载行（照抄 `plugins/dsh-code-index/cordis.patch.yml`）。 |
| `plugins/dsh-multiroot/test-plugin.mjs` | 直接复用 `plugins/dsh-code-index/test-plugin.mjs:141-148` 的「不 import @deepseek-ai/*」断言 + 「工具注册成功」冒烟。 |
| `analysis/design/host-tools-contract.md` | 本文。 |

### 8.2 注入

```js
export const inject = ['tools', 'fs', 'systemPrompt', 'sandboxPolicy']   // 硬依赖
// 可选（用 ctx.get() 取，取不到降级）：
//   'workingDirectory'  取会话 cwd（否则退 session.header.cwd）
//   'shell'             multi_sh；没有就不注册该工具
//   'shellEnv'          dshEnv
//   'approval'          workspace_roots add
//   'subagents'         【未确认】给 subagent_fork 继承根（先不做）
```

`ctx.get('x')` 对可选服务返回 `undefined`（【Service】access 表：`optional.expression = ctx.get("x")`，`requiresUndefinedCheck: true`）；硬依赖缺了插件不挂载。

### 8.3 函数签名与职责

```js
// —— 根注册表（纯内存 + 落盘，无 ctx） ——
function dshHome(): string                                   // process.env.DSH_HOME ?? ~/.dsh
function loadRegistry(primaryCwd: string): Registry           // 读 .dshworkspace.json，失败回落 $DSH_HOME 副本，再失败退化成单根
function normalizeRootPath(p: string): string                 // path.resolve + realpath.native 尝试；失败保留原串并标 unverified
function saveRegistry(reg: Registry): void                    // 原子写（先 .tmp 再 rename），写 $DSH_HOME/dsh-multiroot/<hash>.json

class Registry {
  primary: string                                            // root id，必须存在
  require(id: string, exec?): RootEntry                       // 未知名 → 抛 ROOT_UNKNOWN（列出可用 id）
  resolveTarget(id): Promise<FsTarget>                       // ctx.fs.resolve(root.path) 一次，缓存到 root.target
  assertWritable(r: RootEntry, policy): void                 // r.readonly || policy.mode === 'read-only' → 抛 ROOT_READONLY
}

// —— 工具 ——
multi_read(ctx, exec, args)                                  // root? file_path offset limit → {root,path,total_lines,lines}
multi_write(ctx, exec, args)                                 // §3.5
multi_edit(ctx, exec, args)                                  // waterfall('fs/edit-intent') + editText + emit observed
multi_grep(ctx, exec, args)                                  // roots?[] pattern include → 逐根 spawn rg（不过 ctx.sandbox，见 A 报告 §5）
multi_sh(ctx, exec, args)                                    // §6.3
workspace_roots(ctx, exec, args)                             // action=list|add|remove|use

// —— 提示词 ——
applyRootsSection(ctx, registry)                             // ctx.systemPrompt.section({name:'multiroot:roots', order: …, text})
```

每个工具都是 `{ name, description, parameters: <标准 JSON Schema>, output: { schema, render }, isConcurrencySafe?, execute, presentCall? }` 的普通对象（§1.3 范式）。

### 8.4 手写校验约定（schema DSL 表达不了的部分）

| 工具 | 校验 | 报错文案（写进 message，模型可见） |
| --- | --- | --- |
| 全部 | `root` 缺省 → 用 `sessionRoot(session)`；给了一定要在注册表里 | `multi_x: unknown root "oss"; known: app, docs` |
| `multi_read/write/edit` | `file_path` 非空且非空白 | `multi_x: file_path must be a non-empty string` |
| `multi_edit` | `old_string` 非空；`old_string !== new_string` | `multi_edit: old_string and new_string must differ` |
| `multi_write` | `content` 允许空串（就是写空文件） | — |
| 写/改 | `root.readonly` | `multi_write: root "docs" is read-only` |
| 写/改/执行 | `policy.mode === 'read-only'` | `multi_write: session file policy is read-only` |
| 写/改 | `ctx.fs.contains(rootTarget, target)` | `multi_write: "\\..\\etc\\x" escapes root "app"` |
| `multi_sh` | `workdir` 落在根内（绝对或相对） | `multi_sh: workdir escapes root "app"` |
| `workspace_roots add` | 绝对路径、存在、是目录、未重复、id 合法（`^[a-z0-9][a-z0-9_-]{0,31}$`） | `workspace_roots: path is not an existing directory: …` |

**统一错误码前缀**（写进 message 首段，因为结构化 code 会丢，§1.4）：
`ROOT_UNKNOWN` / `ROOT_READONLY` / `ROOT_ESCAPE` / `ROOT_EXISTS` / `ARGS_INVALID` / `POLICY_READONLY` / `APPROVAL_DENIED` / `REGISTRY_INVALID`。

### 8.5 落盘格式

```json
// <primaryRoot>/.dshworkspace.json   （随仓库走；不存在时用 $DSH_HOME 兜底副本）
{ "version": 1,
  "primary": "app",
  "roots": [
    { "id": "app",  "path": "D:/Projects/GolandProjects/dsh-plugins", "label": "DSH 插件" },
    { "id": "docs", "path": "C:/Users/legan/Documents/spec", "readonly": true }
  ] }
```

`$DSH_HOME/dsh-multiroot/<sha1(absolutePrimary)>.json` 存同一份 + 每会话的默认根（§7.3）。
**永远不写 session 事件**。

### 8.6 Config（可选，但建议给）

上游 `Config` 用 `@deepseek-ai/schemastery`（`dsh-tool-fs:1194-1203`），插件可以用普通对象描述（Loader 只在给了 schema 时校验；不给 schema 就是 `config` 原样透传——【未确认：Loader 对 `export const Config` 为非 schemastery 对象时的行为。验法：先不导出 `Config`，把参数放 `cordis.patch.yml` 的 config 段，读 `config?.xxx ?? 默认值`；这条路线 100% 安全，code-index 就是这么做的】）。

建议字段：`rootsFile`（相对主根的路径，默认 `.dshworkspace.json`）、`maxRoots`（默认 8）、`grepMaxResults`、`shTimeoutMs`、`injectPrompt`（默认 true）。

### 8.7 与上游的一致性清单（评审时逐条打勾）

- [ ] `parameters` 是标准 JSON Schema（`type:'object'` + 对象级 `required`），不是 spec DSL（§1.2）
- [ ] `output.render` 是函数；`output.schema` 只用 §1.1 的白名单关键字
- [ ] `execute` 返回 lossless JSON（无 `undefined` 值、无函数）
- [ ] 每次 `writeText`/`editText` 都传 **第 5 参** `sandboxPolicy`，且 `workspaceRoot` = 目标根、`mode` 来自会话（§4.4）
- [ ] `fs/write-intent` / `fs/edit-intent` 的 `actor` 传的是 `exec`（§3.4 #1）
- [ ] 每个 `multi_*` 读/写成功后都 `ctx.emit('fs/observed', …)`（§3.4 #2 #4）
- [ ] `danger-full-access` 在 shell 路径上不被插件收窄、也不被插件主动使用（§6.3）
- [ ] 所有注册都在 `apply` 内、由 `ctx.effect` 或插件 fiber 拥有（§1.3）
- [ ] 无 `@deepseek-ai/*` import（`test-plugin.mjs` 断言）
- [ ] 根定义来自文件/审批，**不接受模型凭空给的新路径**（`multi_*` 只认已注册 id）

---

## 9. 未确认项与验证步骤

| # | 待确认 | 影响 | 怎么验 |
| --- | --- | --- | --- |
| 1 | `agent/created` 监听器里的 `this` 是否运行时暴露 `tools`/`effect`/`inject` | 决定 shadow 同名工具可不可行（MVP 不依赖） | 插件里 `ctx.on('agent/created', function (p) { ctx.logger.info(Object.keys(this).join(',')) })` |
| 2 | `FsError.message` 是否可原地改写且保留 `error.code` | §1.4 的「保留结构化码」技巧 | `e.message = 'x'` 后看 `tool/result` 事件的 `error.code` |
| 3 | `export const Config` 传普通对象（非 schemastery）时 Loader 行为 | 影响能否用 Config 声明默认值 | 见 §8.6，先走「不导出 Config」路线 |
| 4 | `deferLoading: true` 的加载语义 | 只在工具数很多时才关心 | `dsh-tools:3143` 只做投影；语义需读 `dsh-llm`/agent-loop 的 tool loading 逻辑 |
| 5 | `ctx.shellEnv.collect(exec)` 的具体产出与可用性 | `multi_sh` 的 `dshEnv` | `ctx.get('shellEnv')` 打一次 `collect` 结果 |
| 6 | `@deepseek-ai/dsh-subprocess` 的 `SubprocessSpawnSpec` 字段（若走方案 B） | §6.3 方案 B 是否可行 | `cordis_inspect_query(Service, {"service":"subprocess"})` 的 referencedTypes，或读 `dsh-subprocess-local` |
| 7 | Windows ACL 对新 root + sessionId 的现场授权时机 | 「根 B 第一次写入」会不会晚一步失败 | A 报告 §8.5 已推断可行；建议实测：`sandboxPolicy.workspaceRoot` 指向 `D:\` 之外的目录写一次 |
