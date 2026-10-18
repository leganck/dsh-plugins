# 插件式多根工作空间（`dsh-multiroot`）实现设计

> 目标读者：要真正动手写这个插件的人。本文只讲**插件式**路线（不改 DSH 本体）。
> 事实基线：DSH `0.2.1-rc.2`（`resources/app.asar/dsh`）。带 `文件:行号` 的结论都来自源码或 live 契约；标「未确认」的是没取到证据的地方。
> 关联：总报告 [multi-root-workspace.md](multi-root-workspace.md)、Host 证据 [A-host-path-sandbox.md](A-host-path-sandbox.md)、UI 证据 [B-client-ui.md](B-client-ui.md)、本仓约定 [C-plugin-impact.md](C-plugin-impact.md)、**工具/观测/审批/shell 契约细读** [design/host-tools-contract.md](design/host-tools-contract.md)。

---

## 0. 目标与边界

**要解决的真实问题**（按优先级）：

1. 模型能**写**第二个根（今天读/搜/终端可以，`write`/`edit`/`pwsh` 不行）。
2. 模型知道**有几个根、当前在哪个根、路径怎么表达**（否则每次绝对路径靠猜）。
3. 用户能看见"这次改的是哪个根"（工具卡上的根徽标），并能审计。
4. 索引（code-index）使用同一份根定义。

**明确不做**（做了会跟官方升级打架）：

| 不做 | 原因 |
|---|---|
| 改 `session.header.cwd` / 伪造会话目录 | 会话复用要求 cwd 字符串相等（`ApiSessionCwdConflict`），且写入边界冻结在 header |
| 加新的 session 事件类型存根清单 | 未知事件必须 `ignorable: true`，live `append()` 设不了 → Session 打不开 |
| 扩展 `Workspace` 实体（给它加 roots） | 牵动存储域迁移 + 侧栏 attach 语义；插件阶段不该碰 |
| 替换 `sandboxPolicy`/`fs`/`shell` Service | Cordis 同域重复 provide 直接抛错；`ctx.set` 只允许提供方 fiber 调用（A 报告 §8） |
| shadow 内置 `write`/`edit`/`pwsh` | 要复制 schema、卡片、`sandbox_permissions` 升级流、`[sandbox: …]` 标记、后台作业语义；升级必漂移。**只在 P2 作为可选增强** |
| 把 `danger-full-access` 当实现手段 | 那是拆围栏，不是多根 |

---

## 1. 总体架构

```
                            ┌─────────────────────────────┐
   .dshworkspace.json ─────▶│  RootRegistry（Host 插件内） │
   (随仓库走/也可配置)        │  发现→校验→规范化→缓存      │
                            └──────────┬──────────────────┘
                                       │ roots / defaultRoot
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
 systemPrompt.context           工具族（4 个）                  code-index 桥
 "Workspace roots: …"     workspace_roots / root_write /        roots 从同一份
                           root_edit / root_run                定义读（可选）
                                       │
                                       │ 每次调用：
                                       │ root → 绝对路径 → 越界检查 →
                                       │ sandboxPolicy{workspaceRoot: root} →
                                       │ fs.writeText / shell.execute →
                                       │ emit fs/observed → 审计行
                                       ▼
                           DSH 沙箱（fs-sandbox / sandbox-local）
```

三个关键事实（这决定了架构为什么成立）：

1. **沙箱策略是按调用传入的**：`fs.writeText(target, content, expected, signal, sandboxPolicy)`、`shell.resolve({ …, sandboxPolicy })`——内置工具自己就是每次 `resolve({session})` 后再传（`dsh-tool-fs/lib/index.js:1134-1156`、`dsh-pwsh-sandbox/lib/index.js:145-150`）。
2. **读不设围栏**：`fs-sandbox` 只围栏 `writeText`/`editText`（`lib/index.js:73-76, 125-166`）；`grep`/`glob` 直接 spawn ripgrep。所以**读侧不需要任何插件代码**，绝对路径本来就能用。
3. **插件在 Host 进程里跑，用 node:fs 没有围栏**。因此"注册表文件"由插件自己读写是安全的；围栏只约束 **模型发起的工具调用**。

---

## 2. 根注册表

### 2.1 定义文件：`.dshworkspace.json`

放在「工作空间锚点」目录（通常就是你会话打开的那个目录），随仓库提交：

```json
{
  "version": 1,
  "primary": "app",
  "roots": [
    { "id": "app",  "path": ".",                          "label": "本仓" },
    { "id": "oss",  "path": "D:/oss/microservice-a" },
    { "id": "spec", "path": "C:/Users/legan/Documents/spec", "readonly": true }
  ]
}
```

字段语义：

| 字段 | 必填 | 规则 |
|---|---|---|
| `version` | 否 | 缺省 1；不认识的值 → 报错（不要静默降级） |
| `primary` | 否 | 必须是某个 `id`；缺省 = 第一个根 |
| `roots[].id` | 是 | `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`，全局唯一；这是模型唯一该记住的名字 |
| `roots[].path` | 是 | 绝对路径，或**相对定义文件所在目录**（`"."` 表示锚点自身）；必须存在且是目录 |
| `roots[].label` | 否 | 人类可读名，只用于 UI/审计，不喂给模型 |
| `roots[].readonly` | 否 | `true` = `root_write`/`root_edit`/`root_run` 一律拒绝（服务端硬拒，不靠提示词） |

**为什么用文件而不是插件 Config**：跨机器可复现、可 code review、和 Cursor 的 `.code-workspace` 同构；且 Config 在 profile 补丁层是**整份替换**语义（写漏一项就静默失效），不适合当"项目级数据"。

### 2.2 发现顺序（从具体到通用）

1. 配置 `definitionFile`（绝对路径）→ 直接用；
2. 从**会话当前目录**向上找 `.dshworkspace.json`（最多 12 层，找到第一个即停）；
3. 配置 `roots`（数组，等价于内联定义；`primary` 用配置项）；
4. 都没有 → **单根退化**：`{ roots: [{ id: basename(cwd), path: cwd }], primary: 同 }`，此时不注入提示词、工具仍可用（`root` 参数只有一个可选值）。

> 用「会话当前目录」而不是 `header.cwd` 找文件：`working_directory cd` 之后仍能发现新目录下的定义。默认根也按当前目录算（见 2.4）。

### 2.3 校验与规范化

每条都要**大声失败并点名**（配置类错误静默降级的代价最高）：

```
1. 文件 JSON 解析失败 → 报路径 + 行号（JSON.parse 的 position）
2. roots 为空 / 超过 maxRoots(默认 8) → 报数量
3. id 非法或重复 → 报 id
4. path 规范化：
   raw → (相对则 join(dirname(file), raw)) → 必须 path.isAbsolute
       → realpathSync.native()（失败=不存在/无权限，报原始 spelling）
       → statSync().isDirectory() 必须为真
5. 规范化后路径去重（win32 上 toLowerCase 比较）→ 报重复的两个 id
6. primary 必须在 roots 里 → 报 primary id 与可用 id 列表
```

规范化后的内部结构：

```js
{ key: '<canonical file path>', primaryId, roots: [
  { id, label, readonly, path /* canonical */, compare /* win32 小写 */ }
] }
```

### 2.4 会话 → 默认根

```js
defaultRootId(ws, cwd) {
  const here = canonical(cwd)
  let best = null
  for (const r of ws.roots) if (isUnder(r.compare, here)) {
    if (!best || r.compare.length > best.compare.length) best = r
  }
  return best?.id ?? ws.primaryId        // 最长前缀匹配，退化到 primary
}
```

- **用 live cwd（`ctx.workingDirectory.get`），不用 `header.cwd`**：`cd` 进另一个根之后，`root_write` 的默认目标应该是"我现在在哪"，而不是"会话最初在哪"。
- 但**权限**仍然按目标根算（`workspaceRoot = 目标根`），所以 `cd` 到根 B 后写 B 是合法的——这正好绕开"`cd` 不改权限"的坑，方向是正确的。

### 2.5 缓存与失效

- 缓存键：定义文件 canonical 路径（无文件时用 `cfg:<锚点>`）。
- 每次取用时 `statSync(file).mtimeMs + size` 对比，变了就重载（一次 `stat`，微秒级；比 `fs.watch` 简单可靠）。
- `workspace_roots` 的写操作（若启用）写完立即失效缓存。
- 定义文件**读失败**（权限/被删）：报错并**保留上一次成功的内存快照**，同时在提示词里标注 `(stale)`——不要静默退回单根。

---

## 3. 工具族

### 3.1 命名与清单（4 个）

| 工具 | 作用 | 为什么需要 |
|---|---|---|
| `workspace_roots` | 列出根、标出默认根/只读/是否存在 | 模型自检与纠错；也是"根不存在"时的自解释入口 |
| `root_write` | 在指定根整文件写入 | 唯一能让**写**跨根的通道 |
| `root_edit` | 在指定根做字面替换 | 同上，且保留 read-before-edit 语义 |
| `root_run` | 在指定根执行一条命令（Windows=PowerShell） | 让"在根 B 里跑测试/构建"变成一次调用，而不是终端绕路 |

**为什么不在 `read`/`grep`/`glob` 上加同类工具**：读与搜本来就不围栏，绝对路径直接可用；再加一套只会增加模型的选择成本和 token。提示词里说明"读用绝对路径"即可。

**为什么不用 `multi_` 前缀**：`multi_*` 容易被理解成"多文件/批量"，而这里的关键维度是**根**。`root_*` 与参数 `root` 同名，模型一次就懂。

### 3.2 公共执行管线

四个工具（除 `workspace_roots`）共用同一条管线，任何一步失败都给出可行动的下一步：

```
① 取 workspace（按会话当前目录发现/缓存）
② 解析 root       ：args.root ? byId : defaultRootId；未知 → 列出可用 id
③ 解析目标路径     ：ctx.fs.resolve(path, { cwd: root.path })   ← 相对按根、绝对原样，并 canonicalize
④ 越界检查         ：ctx.fs.contains(rootTarget, target) 必须为真（落在别的根 → 报"该路径属于根 X，请用 root=X"）
⑤ 只读/模式检查     ：root.readonly → 拒；写/编辑再查 session mode=read-only（执行交给沙箱）
⑥ 构造 policy      ：{ ...sandboxPolicy.resolve({session}), workspaceRoot: root.path }
⑦ 执行            ：writeText / editText / shell.execute（见下）
⑧ 观测回写         ：ctx.emit('fs/observed', target, {kind:'present', version}, exec)
⑨ 审计            ：appendFileSync 一行 JSONL
⑩ 返回            ：{ root: id, path: 绝对路径, … } —— 结果里必须带 root
```

**④ 越界检查是插件自己的授权实现**，不能省：沙箱只知道"这次 policy 的根是 B"，它不会判断"B 是不是用户声明的根"。做法是 `ctx.fs.resolve(path, { cwd: root.path })` 拿到 canonical target，再用 **`ctx.fs.contains(rootTarget, target)`** 判定（`rootTarget` 只需解析一次并缓存）——**不要**自己做字符串前缀比较（canonicalize/大小写/8.3 短名都会出错，见 [host-tools-contract §1.3](design/host-tools-contract.md)）。

### 3.3 `workspace_roots`

```js
{
  name: 'workspace_roots',
  description: 'List the workspace roots visible to this session and which one is current.',
  parameters: {                       // 普通 JSON Schema（不是 schemastery DSL）
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional path; report which root contains it.' }
    },
    required: [],
    additionalProperties: false
  },
  output: {
    schema: { type: 'object', properties: { roots: { type: 'array' } }, required: ['roots'] },
    render: (_a, v) => [{ type: 'text', text: v.roots.map(r =>
      `- ${r.id}${r.current?' (current)':''}${r.primary?' (primary)':''}${r.readonly?' [read-only]':''}: ${r.path}${r.exists?'':' (missing)'}`
    ).join('\n') }]
  },
  isConcurrencySafe: () => true,
  async execute(args, exec) { /* 见上管线 ①②④ */ }
}
```

- 输出**只给根列表**，不 dump 目录内容（bounded output）。
- 不提供 `add/remove`：根定义是用户资产，让模型改它等于把授权交给模型。若确实要工具化，必须 `ctx.approval.request` 一次并写审计（P2）。

### 3.4 `root_write`

```js
async execute(args, exec) {
  if (exec.agent === undefined) throw new Error('root_write: no agent scope')   // exec.agent 可选！
  const ws = registry.forSession(exec.agent.session)
  const root = pickRoot(ctx, ws, args.root, exec)         // ②
  assertWritable(ctx, exec, root)                          // ⑤
  const target = await resolveInside(ctx, ws, root, args.path, exec.signal)  // ③④（contains 判定）
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)  // ← actor 必须是 exec
  let outcome
  try {
    outcome = await ctx.fs.writeText(target, args.content, intent, exec.signal, policyFor(ctx, exec, root))
  } catch (e) { throw remediate(e) }                      // FS_NOT_OBSERVED / FS_STALE_VERSION / FS_SANDBOX_DENIED
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)  // ⑧
  audit(exec, 'root_write', root, target, args.content.length)                          // ⑨
  return { root: root.id, path: ctx.fs.processPath(target), operation: outcome.operation }
}
```

三个必须照抄的细节：

1. **actor 必须是 `exec` 本身**：观测策略按 `actor?.agent?.session` 存观测（`dsh-fs-observation-policy/lib/index.js:29-31`）。传 `{}`/`undefined` → 永远 `createIfAbsent` → 覆盖已存在文件必被拒。
2. **intent 必须来自 `fs/write-intent` waterfall**：`fs-local` 的语义是无观测且文件已存在 → `createIfAbsent` → `FS_NOT_OBSERVED`（`dsh-fs-local/lib/index.js:868-871`）。
3. **成功后必须 `emit('fs/observed')`**，否则本会话紧接着的 `root_edit` 立刻被 `FS_NOT_OBSERVED` 拒（`mutationResult` 就是这么做的，`dsh-tool-fs/lib/index.js:492-502`）。

错误映射（模型可执行）：

| 错误码 | 面向模型的话 |
|---|---|
| `FS_NOT_OBSERVED` | `cannot modify "<abs>": file has not been read — read the file (absolute path), then retry` |
| `FS_STALE_VERSION` | `"<abs>" changed since it was read — re-read it, then retry` |
| `FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT` | `old_string not found / matched more than once; pass replace_all or a larger unique snippet` |
| `FS_SANDBOX_DENIED` | `[sandbox: file access denied under <mode> mode]` + 提示检查 `root`/只读/会话模式（**不要**提示升级） |
| 越界 | `"<abs>" is outside workspace root "<id>" (roots: app, oss, spec)` |
| 未知根 | `unknown workspace root "<x>"; available: app (current), oss, spec` |

> **结构化错误码会丢**：`dsh-tools` 的 `error.info` 只对 `HarnessError` 实例生效，插件 `throw new Error()` 时模型只看到 `Error: <message>`（`dsh-tools:2709-2718, 3712-3726`）。因此自造错误码要写进消息文本；上游 `FsError`（`FS_STALE_VERSION` 等）**不要 new**，而是原地改 message 后 rethrow（保留实例与 code）——message 可写性未确认，见 [host-tools-contract §1.4](design/host-tools-contract.md)。

### 3.5 `root_edit`

与 `root_write` 同构，替换为：

```js
const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
outcome = await ctx.fs.editText(target,
  { oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all ?? false },
  intent, exec.signal, policyFor(ctx, exec, root))
```

- `fs/edit-intent` 在"没读过"时**直接抛** `FS_NOT_OBSERVED`（`dsh-fs-observation-policy/lib/index.js:64-70`）；所以**先 `read`（绝对路径）再 `root_edit`** 是硬流程。工具描述里写一次即可（不要和提示词重复）。
- provider 侧：`oldString` 找不到 → `FS_EDIT_NOT_FOUND`；多处命中且 `replaceAll:false` → `FS_AMBIGUOUS_EDIT`；`replaceAll:true` 全替换（`dsh-fs-local/lib/index.js:883-900`）。
- 报错时**把绝对路径写进消息**（`<abs>`），模型可以直接拿它去 `read`，不需要自己拼路径。

### 3.6 `root_run`

```js
async execute(args, exec) {
  const ws = registry.forSession(exec.agent.session)
  const root = pickRoot(ctx, ws, args.root, exec.agent)
  assertRunnable(root)                                  // 只读根不允许执行（可能写）
  const cwdTarget = await resolveInside(ctx, ws, root, args.workdir ?? '.', exec.signal)
  const shellEnv = ctx.get('shellEnv')                  // 可选服务
  const request = {
    command: args.command,
    workdir: ctx.fs.processPath(cwdTarget),
    ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
    ...(shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {}),
    sandboxPolicy: policyFor(ctx, exec, root),          // ← 唯一关键差异
    onExpiry: 'kill',
    signal: exec.signal
  }
  const spec = ctx.shell.resolve(request)               // shell 是两段式
  const result = await (await ctx.shell.execute(spec)).result()
  // 截断：头 8KB + 尾 8KB，中间标 (truncated)
  return { root: root.id, cwd: spec.workdir, exitCode: result.exitCode, timedOut: result.timedOut,
           stdout: clip(result.stdout.text), stderr: clip(result.stderr.text), sandbox: result.sandbox }
}
```

- **不要**用 `ctx.subprocess.spawn` + 自己 `confine`：那样要自己处理 Windows ACL 的 grant 生命周期、denial 分类、runner 失败规则；`ctx.shell` 已经把这些封装好（`dsh-pwsh-sandbox`/`dsh-bash-sandbox`）。**唯一要改的是 `sandboxPolicy`**。
- `ctx.shell.resolve` 会补齐默认值（超时、输出上限、onExpiry）；直接传 `{command, workdir, sandboxPolicy, signal}` 也可用，但显式给 `onExpiry` 更稳。
- 后台执行（job）**不在 MVP**：语义多（job 注册、超时提升、输出环），先只做前台 + 超时 kill。
- 在 Windows 上这是 PowerShell；工具描述按 `process.platform` 生成（与 host 的 `pwshDescription(windowsSandbox)` 同法，`dsh-tool-pwsh/lib/index.js:255-259`）。

### 3.7 防误用 guard（P2，强烈建议做）

问题：模型遇到跨根路径时，第一反应是用内置 `write`，得到 `[sandbox: …]` + **"可以用 `sandbox_permissions` 升级"** 的提示——这会把用户推向 `danger-full-access`，而不是 `root_write`。

正规拦截手段是 `ctx.tools.guard()`（同步、只能拒、不能改参数）：

```js
ctx.tools.guard((exec) => {
  const name = exec.name
  if (name !== 'write' && name !== 'edit' && name !== 'pwsh') return
  const session = exec.agent?.session
  if (!session) return
  const ws = registry.forSession(session)
  if (ws.roots.length < 2) return
  const raw = exec.arguments?.file_path ?? exec.arguments?.workdir
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) return
  const target = canonical(raw)
  const ownerRoot = ws.roots.find((r) => isUnder(r.compare, target))
  const currentId = defaultRootId(ws, sessionCwd(ctx, session))
  if (ownerRoot && ownerRoot.id !== currentId) {
    return `"${raw}" is inside workspace root "${ownerRoot.id}"; this session's sandbox root is "${currentId}". Use root_write/root_edit/root_run with root="${ownerRoot.id}" instead, or change the session's working directory.`
  }
})
```

- `ToolGuard = (execution) => string | undefined`，`execution` 里有 `name` / `arguments` / `agent` / `signal`（Host Service `tools` 的 `ToolGuard` 原文）。
- 只处理**绝对路径**（相对路径属于默认根，不拦）；不碰 `read`/`grep`/`glob`。
- 这条 guard 把"沙箱拒绝 + 升级诱导"变成"指路到正确工具"，是**体验差异最大的一处小改动**。

### 3.8 工具定义措辞（按 agent-experience 规则）

- 描述**说行为不说实现**，不写内部机制（"sandboxPolicy"、"fs-sandbox" 都不该出现在描述里）。
- 规则放**参数描述**里，且只说一次：`root` 参数写"alias from the workspace roots list; defaults to the current root"；`path` 写"relative paths resolve against that root"。
- 不重复：根清单在 context 里（§5），工具描述不再列根。
- 输出有界：`root_run` 截断输出；`root_write` 不回显文件内容（与内置 `write` 一致）。

---

## 4. 沙箱与权限语义

### 4.1 `policyFor`

```js
function policyFor(ctx, exec, root) {
  const base = ctx.sandboxPolicy.resolve({ session: exec.agent.session })   // mode 与 sessionId 都保留
  return { ...base, workspaceRoot: root.path }                              // 只换根
}
```

- **只替换 `workspaceRoot`**：`mode` 来自会话（`read-only` 仍只读；`danger-full-access` 本来就不围栏）。
- 保留 `sessionId`：Windows ACL 的私有 temp 授权是按 `(sessionId, workspaceRoot)` 键的（`dsh-sandbox-local/lib/index.js:413-415`），丢掉会退化成 agentless 路径。
- 根路径用 canonical spelling：provider 内部会再 canonicalize（`dsh-sandbox-local:307-310`），提前规范化可避免 8.3 短名/大小写差异导致 grant 与检查对不上。

### 4.2 只读与模式

| 条件 | 行为 |
|---|---|
| `root.readonly` | 写/编辑/执行一律拒，错误里给 `readonly: true` 与根 id（**必须插件自己拒**：policy 的根就是这个目录，沙箱会放行） |
| 会话 `mode === 'read-only'` | `root_write`/`root_edit` 提前拒（文案清楚）；`root_run` **允许**，交给沙箱按 read-only 执行（与内置 `pwsh` 行为一致，写操作会得到 `[sandbox: …]`） |
| 目标绝对路径在**别的**根 | 拒，并告诉模型正确的 `root` |
| 目标不在任何根 | 拒，给出根列表 |

### 4.3 与内置工具的边界（要写进 README，避免用户误解）

- 内置 `write`/`edit`/`pwsh`：仍只写 `session.header.cwd` 之下的内容 —— **这是刻意保留的**，它保证"AI 改不到会话根外"的基线不变。
- `root_write`/`root_edit`/`root_run`：可写**用户显式声明的根集合**，每个根一次写入都有审计。
- 读/`grep`/`glob`/`terminal`：本来就不在围栏里（既有事实，不是本插件引入）。

### 4.4 已知不对称（必须告知）

`grep`/`glob`/终端不受围栏，因此"插件式多根"并不能给用户一个统一的安全承诺；它只是把**结构化写**扩展到了声明的根。要统一，只能走本体改造（M2）。

---

## 5. 提示词

用 **runtime context**（不是 system section）：根清单随会话变化，且与 `Current working directory` / `Current DSH file policy` 同属运行时快照；`systemPrompt.context` 的回调能拿到 `context.agent`（`dsh-working-directory/lib/index.js:41-47` 就是范例）。

```js
ctx.systemPrompt.context({
  name: 'multiroot:roots',
  order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
  text: (context) => {
    const agent = context.agent
    if (agent === undefined) return ''
    const ws = registry.forSession(agent.session)
    if (ws.roots.length < 2) return ''
    const cur = defaultRootId(ws, sessionCwd(ctx, agent.session))
    return 'Workspace roots: ' + ws.roots.map((r) =>
      `${r.id}${r.id === cur ? ' (current)' : ''}=${r.path}${r.readonly ? ' [read-only]' : ''}`
    ).join('; ') + '.'
  }
})
```

设计要点：

- **单根时不输出**（不污染上下文、不破坏缓存）。
- 只列 id/路径/只读/当前，**不写用法**——用法在各工具的参数描述里（"say each fact once"）。
- 顺序紧跟 `SANDBOX_POLICY`（110），让"权限边界"和"边界集合"相邻，模型更容易同时读到。
- 不要动 `Current working directory:` 那行：`dsh-working-directory` 在 `system-prompt/assemble` 里会强制刷新它（`lib/index.js:48-65`）。

---

## 6. 生命周期、状态与审计

| 事项 | 做法 |
|---|---|
| 注册 | `apply(ctx, config)` 里 `ctx.tools.register` + `ctx.systemPrompt.context`，全部挂 `ctx.effect` 回收 |
| 可选依赖 | `shell`/`shellEnv` 用 `ctx.inject([...], scope => …)` 注册 `root_run`；缺了就不注册该工具 |
| 状态 | **无 per-session 状态**：默认根由"当前目录 + 注册表"推导；不需要持久化 |
| 缓存 | `Map<定义文件路径, {mtimeMs, size, ws}>`；每次 `stat` 比对 |
| 审计 | `$DSH_HOME/dsh-multiroot/audit.jsonl`，一行 `{time,sessionId,tool,root,path,bytes,ok}`；写失败只 warn，不影响结果 |
| 重启/升级 | 插件重载即重读定义；已发生的历史操作在会话日志里（工具结果带绝对路径与 root） |
| fork/resume | 无需特殊处理：新会话按它自己的 cwd 重新发现定义 |

**审计为什么写文件而不是会话事件**：会话事件类型封闭；文件审计还能覆盖"模型没看到"的内部操作（如注册表重载失败）。

---

## 7. Client 半（UI）

先给结论：**多根"能用"不依赖 UI**；UI 的真实价值是"让人看见并管理根"。按投入从小到大四档，每档都标了它**不能**做什么（详见 [design/client-ui-contract.md](design/client-ui-contract.md)）：

| 档位 | 做什么 | 还需要本体/通道吗 | 人日 |
|---|---|---|---|
| **L0** | 不写 Client 半：定义文件 + 工具 + 提示词 | 不需要 | 0 |
| **L0.5** | 只读根页 + "在编辑器打开定义文件" | 不需要（用 `remote.workspaceFiles.read` 越根读 + `tab.actions.openResource`） | 1–1.5 |
| **L1** | 根 CRUD（增删改 primary） | 需要把根放进插件 **Config**（`configForms.get(ns)` + `settings.mutate`）；`ns` 匹配待验证 | 2–2.5 |
| **L2** | 右栏多根树（展开第 2..N 根的文件） | 需要自定义 Host↔Client 通道（列表接口） | 0.5–1（`src-json` codec 可用）／3.5–6（否则） |

### L0 —— 零 UI（先发这个）

根定义就是仓库里的 `.dshworkspace.json`，用户在编辑器里改；模型通过 context 看到根，通过 `workspace_roots` 自检。写/编辑/执行/索引全部可用。

### L0.5 —— 只读根页（性价比最高）

- 挂点：`settings.section`（list/root，"One settings page per list entry"），注册 `{ id, order, label }`。
- 数据：Client 侧用 `ctx.inject(['remote.workspaceFiles'])` 调 `read(scope, path)`。**`workspaceFiles.read` 允许读根外文件**（Host 契约原文 "files outside it are allowed"），所以直接读 `<workspaceRoot>/.dshworkspace.json` 即可；`scope = { sessionId, workspaceRoot }`（`workspaceRoot` 取会话 cwd）。
- 交互：解析 JSON → 渲染根列表（id / 路径 / 只读 / 当前）；"打开定义文件"用 `tab.actions.openResource(fileAddressFor(sessionId, cwd, absPath))`。
- **不能做**：编辑（写文件没有 Remote）；定义文件在会话根之上时 Client 算不出绝对路径（给提示让用户手改）。
- 依赖：`client.js` 手写、`dsh.client = { platform:'web', immediately:true, inject:[…] }`、样式只用 `--dsw-alias-*`（不能 require primitives）。

### L1 —— 根 CRUD（Config 路线）

- 把"全局根注册表"放进插件 Config（例如 `workspaces: [{ anchor, primary, roots: [...] }]`），Client 用 `ctx.configForms.get(entryId)` 读写；`get()` 返回的是**普通服务对象**（`getSnapshot/subscribe/set/unset/mutate(ops, rev)`），可以配手写 `<input>`，**不需要 primitives**（`dsh-client-ui-settings/lib/client.js:1121-1301`）。
- 删除数组元素用 `{ op: 'unset', path: ['roots', i] }`（契约："unsetting an array index removes its element"）。
- **代价**：根定义落到 profile Config → 失去"随仓库走"；所以更合理的定位是"**全局默认根**"，项目级仍用 `.dshworkspace.json` 覆盖（Host 侧发现顺序：文件 > 全局）。
- **待验证（10 分钟）**：插件 Config 是**普通对象**（无 schemastery），`settings.describe/mutate` 是否仍接受该 entry、`mutate` 是否按 schema 校验。若不接受 → L1 退回 L0.5。

### L2 —— 右栏多根树

- 外壳：`ctx.sidebarRightTabs.register({ id, kind, priority:'builtin', title:()=>t(…) })` + 体注册到 `sidebar.right.pane.tab`（`key` = 类型 id，keyed/session）；`dsh-client-ui-sidebar-files` 是完整先例（`lib/client.js:996, 1003-1017`）。
- 数据：必须自定义通道——内置 `workspaceFiles.list` 的 scope 是 `{sessionId, workspaceRoot: string}`，`list`/`changes` 都限根；`remote.directoryPicker.list` 只列目录、`DirectoryEntry = {name,path,hidden}` 无 type/size，不能当树。
- 通道选型（client-contract 的结论）：
  | 方案 | 成本 | 风险 |
  |---|---|---|
  | `ctx.typert.register()` 手写最小面 + Client `ctx.remote.$mount(...)` | **若 `TypertCodec` 的 `{mode:'src-json'}` 可用：0.5–1 天**；否则 3.5–6 天（要写 zod 工厂/codec） | rc 版本契约可能变 |
  | Host `ctx.webServer.register({ kind, path, handler })` + Client `fetch` | 2–3 天 | **签名里没有鉴权**，不经 Remote access-control → 必须自己限根、只读、只给本会话 |
  | 复用 `remote.workspaceFiles.*` | 0 | 只能单根，**做不了树** |
- 隐藏成本：图标/路径标签/Tooltip 都在 primitives 里，需手绘手写，**+1 人日**。

**建议**：L0 → L0.5 先上；L2 等本体把 `WorkspaceFileScope` 改成根集合（M2）后再做，那时不需要自定义通道。若坚持现在做树：先花 30 分钟验证 `src-json` codec，成立就走 typert，不成立再评估 `webServer`。

---

## 8. code-index 接入（可选，但收益大）

现状：`plugins/dsh-code-index` 的 `roots` 是**白名单**（`index.js:631-635`），不是成员集合；存储层已天然多根（每根一库，`lib/indexer.js:55-61`）。接法：

1. 插件 Config 增加 `definitionFile`（与 multiroot 同一个 `.dshworkspace.json`）；
2. 加载时若配置了该文件，则 `roots = definition.roots.map(r => r.path)`，并 `primary` 作为相对路径基准；
3. 工具层按 C 报告修：`path.resolve(sessionCwd, args.path)`、新增 `root` 参数、跨根融合、删根清理（≈1.0–1.6 人日）。

这样"工作空间根"只有**一份真相**，索引和写工具不会漂移。

---

## 9. 测试计划

### 9.1 单元（假 ctx，不启动 DSH）

| 用例 | 断言 |
|---|---|
| 定义文件校验 | 缺 id / 重复 id / 路径不存在 / primary 不存在 / 超 maxRoots → 各自报错且点名 |
| 相对路径根 | `"path": "."` 解析到定义文件目录；`"../x"` 解析正确 |
| 默认根 | cwd 在根 B 子目录 → 默认 B；cwd 在所有根外 → primary |
| 越界 | 绝对路径在根 A 时用 `root=B` → 拒绝；绝对路径不在任何根 → 拒绝并列出 |
| policy | `policyFor` 保留 mode/sessionId，只换 workspaceRoot |
| 写流程 | `writeText` 收到正确 intent/policy；成功后 `emit('fs/observed')` 一次；审计写一行 |
| 只读根 | `root_write/root_edit/root_run` 全部拒绝 |
| 会话只读 | mode=read-only 时拒绝写 |
| shell | `shell.resolve` 收到 `workspaceRoot=根`、`workdir` 在根内 |

### 9.2 契约（`test-plugin.mjs` 风格）

- 导出的 `name`/`inject`/`apply` 正确；
- `ctx.tools.register` 收到的 4 个定义满足 `ToolDefinition`（有 `output.schema`/`render`）；
- 卸载后注册面归零（disposer 生效）；
- **不 import 任何 `@deepseek-ai/*`**（本仓硬规则）。

### 9.3 手工集成（装进 profile 后）

| 步骤 | 期望 |
|---|---|
| 会话 cwd = 根 A，`root_write(root=B)` | 成功；结果带 `root=B` 与绝对路径 |
| 同会话内置 `write` 写 B | 仍被拒（边界未被破坏） |
| 内置 `write` 写 B（guard 生效后） | 被 guard 拒，文案指向 `root_write(root=B)` |
| `root_run(root=B, "echo hi")` | 成功；`pwsh` 原生仍不能在 B 写 |
| `read(<B 绝对路径>)` 后 `root_edit(root=B)` | 成功；未读时先报 `FS_NOT_OBSERVED` |
| 会话 `read-only` 下 `root_write` | 拒绝 |
| 删除定义文件后新会话 | 退化为单根，提示词无根清单，工具仍可用 |
| 重启 DSH | 无需重配，定义文件自动生效 |

---

## 10. 实施阶段（建议按提交粒度切）

| 阶段 | 内容 | 产出 | 人日 |
|---|---|---|---|
| P0 | 仓库骨架（package.json/locale/icon/patch/test 夹具） | 可安装空插件 | 0.5 |
| P1 | RootRegistry（发现/校验/缓存/默认根） | 单测通过 | 1.0 |
| P2 | `workspace_roots` + 提示词 context | 模型能看到根 | 0.5 |
| P3 | `root_write`/`root_edit`（含观测/版本/错误映射） | 跨根写可用 | 1.0 |
| P4 | `root_run`（shell + policy + 截断） | 跨根执行可用 | 0.5 |
| P5 | 防误用 guard + 审计 | 体验与可追溯 | 0.5 |
| P6 | code-index 接入同一份定义 | 索引与写口径一致 | 1.0–1.6 |
| P7a | （可选）L0.5 只读根页 | 看得见根 + 一键打开定义文件 | 1.0–1.5 |
| P7b | （可选）L2 右栏多根树 | 图形化浏览/编辑 | 0.5–6（取决于通道验证） |
| — | 测试与联调 | — | 1.0 |
| **合计** | 不含 P7 | | **≈6–7 人日** |

---

## 11. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户把根定义写得太宽（如 `D:/`） | 等于放开整盘 | `maxRoots` + 拒绝盘符根/主目录根（可配置）；README 明示 |
| 模型用 `root_write` 覆盖未读文件 | 数据丢失 | 依赖 `FS_NOT_OBSERVED`（provider 强制），不绕过 |
| 模型误用内置 `write` 并接受升级提示 | 用户被诱导给 `danger-full-access` | P5 的 guard；README 说明 |
| 定义文件在根外 | 插件用 node:fs 仍能读，但 `workspaceFiles.read` 读不到 | 定义文件建议放锚点根内；文档说明 |
| DSH 升级改 `ToolDefinition`/`ShellExecRequest` | 插件失效 | 只用公开字段；`test-plugin.mjs` 契约断言；锁定 0.2.x |
| 多根下 code-index 结果混淆 | 同名相对路径无法区分 | 接 C 报告的"结果带 root 前缀"改造 |
| Windows ACL 多次 grant 根 B | 首次执行的延迟/ACL 变更 | 一次性预热：`root_run(root=B, "exit 0")`；失败时提示 |
| 自定义 UI 通道无鉴权（若选 `webServer`） | 任何页面可读任意路径 | 只读 + 限根 + 只服务本会话；优先 typert RPC 而非裸路由 |
| 插件 Config 无 schema 时 `settings.mutate` 可能不可用 | L1 根 CRUD 做不了 | 先做 10 分钟验证；不行就退回 L0.5 |

**回退**：删掉 profile 补丁层的 insert 行（或 `disabled: true`）即可；定义文件保留无害。

---

## 附录 A：Host 半骨架（示意，未运行）

> 目的：让实现者看到"每一行该调什么"。真实实现还需本仓的 `test.mjs`/`test-plugin.mjs`/`verify-install.mjs`。
> 约束：单文件、零 `@deepseek-ai/*` import、所有注册挂 `ctx.effect`。

```js
// plugins/dsh-multiroot/index.js
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-multiroot'
export const inject = ['tools', 'fs', 'systemPrompt', 'sandboxPolicy', 'workingDirectory']

const DEFAULTS = { definitionFile: null, roots: [], primary: null, maxRoots: 8, audit: true }

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const registry = new RootRegistry(ctx, cfg)
  const disposers = []
  const register = (def) => {
    const d = ctx.tools.register(def)
    disposers.push(typeof d === 'function' ? d : () => d?.dispose?.())
  }
  ctx.effect(() => () => { for (const d of disposers.splice(0)) { try { d() } catch {} } })

  register(rootsTool(ctx, registry))
  register(writeTool(ctx, registry, cfg))
  register(editTool(ctx, registry, cfg))

  ctx.inject(['shell'], (scope) => {
    const d = scope.tools.register(runTool(scope, registry, cfg))
    disposers.push(typeof d === 'function' ? d : () => d?.dispose?.())
  })

  ctx.systemPrompt.context({
    name: 'multiroot:roots',
    order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const ws = registry.forSession(agent.session)
      if (ws.roots.length < 2) return ''
      const cur = defaultRootId(ws, sessionCwd(ctx, agent.session))
      return 'Workspace roots: ' + ws.roots.map((r) =>
        `${r.id}${r.id === cur ? ' (current)' : ''}=${r.path}${r.readonly ? ' [read-only]' : ''}`
      ).join('; ') + '.'
    }
  })

  // P5：防误用 guard（可选）
  ctx.tools.guard((exec) => guardBuiltin(ctx, exec, registry))
}

/* ---------------- 注册表 ---------------- */

class RootRegistry {
  constructor(ctx, cfg) { this.ctx = ctx; this.cfg = cfg; this.cache = new Map() }

  forSession(session) {
    const cwd = sessionCwd(this.ctx, session)
    const file = this.findDefinitionFile(cwd)
    const key = file ?? `cfg:${path.dirname(cwd)}`
    const hit = this.cache.get(key)
    const stat = file ? safeStat(file) : undefined
    if (hit && hit.mtimeMs === stat?.mtimeMs && hit.size === stat?.size) return hit.ws
    const ws = this.load(file, cwd)
    this.cache.set(key, { ws, mtimeMs: stat?.mtimeMs, size: stat?.size })
    return ws
  }

  findDefinitionFile(cwd) {
    if (this.cfg.definitionFile) return path.resolve(expandHome(this.cfg.definitionFile))
    let dir = path.resolve(cwd)
    for (let i = 0; i < 12; i += 1) {
      const candidate = path.join(dir, '.dshworkspace.json')
      if (fs.existsSync(candidate)) return candidate
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return undefined
  }

  load(file, cwd) {
    const raw = file
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : this.cfg.roots.length > 0
        ? { version: 1, primary: this.cfg.primary, roots: this.cfg.roots }
        : undefined
    if (raw === undefined) {
      const base = path.resolve(cwd)
      return finalizeWorkspace({ primary: 'root', roots: [{ id: 'root', path: base }] }, path.dirname(base), this.cfg)
    }
    return finalizeWorkspace(raw, file ? path.dirname(file) : path.resolve(cwd), this.cfg)
  }
}

/* ---------------- 路径与策略 ---------------- */

const sessionCwd = (ctx, session) => {
  try { return ctx.workingDirectory.get(session) ?? session.header.cwd } catch { return session.header.cwd }
}

function policyFor(ctx, exec, root) {
  const base = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
  return { ...base, workspaceRoot: root.path }
}

async function resolveInside(ctx, ws, root, rawPath, signal) {
  const target = await ctx.fs.resolve(rawPath, { cwd: root.path, signal })   // 相对路径按根解析
  const rootTarget = await rootTargetOf(ctx, root)
  if (!ctx.fs.contains(rootTarget, target)) {                                // ← canonical 判定，不用字符串前缀
    const resolved = ctx.fs.processPath(target)
    const owner = ws.roots.find((r) => isUnderPath(r.path, resolved))        // 仅用于错误提示
    const available = ws.roots.map((r) => r.id).join(', ')
    throw new Error(owner
      ? `"${rawPath}" is inside workspace root "${owner.id}", not "${root.id}"; use root="${owner.id}".`
      : `"${rawPath}" is outside every workspace root (${available}).`)
  }
  return target
}

async function rootTargetOf(ctx, root) {
  if (root.target === undefined) root.target = await ctx.fs.resolve(root.path)
  return root.target
}

function pickRoot(ctx, ws, id, agent) {
  const wanted = id ?? defaultRootId(ws, sessionCwd(ctx, agent.session))
  const root = ws.roots.find((r) => r.id === wanted)
  if (!root) throw new Error(`unknown workspace root "${wanted}"; available: ${ws.roots.map((r) => r.id).join(', ')}`)
  return root
}

function assertWritable(ctx, exec, root) {
  if (root.readonly) throw new Error(`workspace root "${root.id}" is read-only.`)
  if (ctx.sandboxPolicy.resolve({ session: exec.agent.session }).mode === 'read-only') {
    throw new Error('the session is in read-only mode; no file mutations are allowed.')
  }
}

function assertRunnable(root) {
  if (root.readonly) throw new Error(`workspace root "${root.id}" is read-only.`)
}

/* ---------------- 工具：写 / 编辑 / 执行 ---------------- */

function writeTool(ctx, registry, cfg) {
  return {
    name: 'root_write',
    description: 'Create or fully replace a UTF-8 text file inside one workspace root.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Root alias from the workspace roots list. Defaults to the current root.' },
        path: { type: 'string', description: 'File path inside that root; a relative path resolves against the root.' },
        content: { type: 'string', description: 'Full UTF-8 file content.' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object', properties: { root: { type: 'string' }, path: { type: 'string' }, operation: { type: 'string' } }, required: ['root', 'path', 'operation'] },
      render: (_a, v) => [{ type: 'text', text: `${v.operation === 'create' ? 'Created' : 'Updated'} ${v.path} (root: ${v.root})` }]
    },
    presentCall: (a) => ({ card: 'diff', title: `Write ${a.path} (${a.root ?? 'current root'})`, diffs: [{ path: a.path, oldText: null, newText: a.content }] }),
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('root_write: no agent scope')
      const ws = registry.forSession(exec.agent.session)
      const root = pickRoot(ctx, ws, args.root, exec.agent)
      assertWritable(ctx, exec, root)
      const target = await resolveInside(ctx, ws, root, args.path, exec.signal)
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      let outcome
      try {
        outcome = await ctx.fs.writeText(target, args.content, intent, exec.signal, policyFor(ctx, exec, root))
      } catch (error) {
        throw remediate(error, ctx.fs.processPath(target))
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      audit(cfg, exec, 'root_write', root, ctx.fs.processPath(target), args.content.length)
      return { root: root.id, path: ctx.fs.processPath(target), operation: outcome.operation }
    }
  }
}

function editTool(ctx, registry, cfg) {
  return {
    name: 'root_edit',
    description: 'Edit an existing UTF-8 text file inside one workspace root by replacing literal text. Read the file first.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Root alias from the workspace roots list. Defaults to the current root.' },
        path: { type: 'string', description: 'File path inside that root; a relative path resolves against the root.' },
        old_string: { type: 'string', description: 'Literal text to replace.' },
        new_string: { type: 'string', description: 'Literal replacement; empty string deletes the match.' },
        replace_all: { type: 'boolean', description: 'Replace every match. Defaults to false, where old_string must appear exactly once.' }
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object', properties: { root: { type: 'string' }, path: { type: 'string' } }, required: ['root', 'path'] },
      render: (_a, v) => [{ type: 'text', text: `Updated ${v.path} (root: ${v.root})` }]
    },
    presentCall: (a) => ({ card: 'diff', title: `Edit ${a.path} (${a.root ?? 'current root'})`, diffs: [{ path: a.path, oldText: a.old_string, newText: a.new_string }] }),
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('root_edit: no agent scope')
      const ws = registry.forSession(exec.agent.session)
      const root = pickRoot(ctx, ws, args.root, exec.agent)
      assertWritable(ctx, exec, root)
      const target = await resolveInside(ctx, ws, root, args.path, exec.signal)
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        outcome = await ctx.fs.editText(target, {
          oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all ?? false
        }, intent, exec.signal, policyFor(ctx, exec, root))
      } catch (error) {
        throw remediate(error, ctx.fs.processPath(target))
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      audit(cfg, exec, 'root_edit', root, ctx.fs.processPath(target), 0)
      return { root: root.id, path: ctx.fs.processPath(target) }
    }
  }
}

function runTool(ctx, registry, cfg) {
  const windows = process.platform === 'win32'
  return {
    name: 'root_run',
    description: `Run ${windows ? 'a PowerShell command' : 'a shell command'} inside one workspace root and return its output.`,
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Root alias from the workspace roots list. Defaults to the current root.' },
        command: { type: 'string', description: 'Command to execute.' },
        workdir: { type: 'string', description: 'Directory inside that root; defaults to the root itself.' },
        timeout_ms: { type: 'number', description: 'Kill the command after this many milliseconds.' }
      },
      required: ['command'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object', properties: { root: { type: 'string' }, cwd: { type: 'string' }, exitCode: { type: 'integer' } }, required: ['root', 'cwd'] },
      render: (_a, v) => [{ type: 'text', text: `[root ${v.root} · ${v.cwd}] exit ${v.exitCode}\n${v.stdout ?? ''}${v.stderr ? '\n[stderr]\n' + v.stderr : ''}` }]
    },
    presentCall: (a) => ({ card: 'terminal', title: `${a.command} (${a.root ?? 'current root'})`, cwd: a.workdir }),
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('root_run: no agent scope')
      const ws = registry.forSession(exec.agent.session)
      const root = pickRoot(ctx, ws, args.root, exec.agent)
      assertRunnable(root)
      const cwd = await resolveInside(ctx, ws, root, args.workdir ?? '.', exec.signal)
      const shellEnv = ctx.get('shellEnv')
      const request = {
        command: args.command,
        workdir: ctx.fs.processPath(cwd),
        ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
        ...(shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {}),
        sandboxPolicy: policyFor(ctx, exec, root),
        onExpiry: 'kill',
        signal: exec.signal
      }
      const spec = ctx.shell.resolve(request)
      const result = await (await ctx.shell.execute(spec)).result()
      audit(cfg, exec, 'root_run', root, spec.workdir, 0)
      return { root: root.id, cwd: spec.workdir, exitCode: result.exitCode, timedOut: result.timedOut, stdout: clip(result.stdout.text), stderr: clip(result.stderr.text) }
    }
  }
}

/* ---------------- 工具：根清单 ---------------- */

function rootsTool(ctx, registry) {
  return {
    name: 'workspace_roots',
    description: 'List the workspace roots visible to this session and which one is current.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Optional path; report which root contains it.' } }, required: [], additionalProperties: false },
    output: { schema: { type: 'object', properties: { roots: { type: 'array' } }, required: ['roots'] }, render: (_a, v) => [{ type: 'text', text: v.roots.map((r) => `- ${r.id}${r.current ? ' (current)' : ''}=${r.path}${r.readonly ? ' [read-only]' : ''}${r.exists ? '' : ' (missing)'}`).join('\n') }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('workspace_roots: no agent scope')
      const ws = registry.forSession(exec.agent.session)
      const cur = defaultRootId(ws, sessionCwd(ctx, exec.agent.session))
      const roots = ws.roots.map((r) => ({ id: r.id, path: r.path, readonly: !!r.readonly, current: r.id === cur, primary: r.id === ws.primaryId, exists: fs.existsSync(r.path) }))
      return { roots }
    }
  }
}

/* ---------------- 小工具 ---------------- */

function normalizeConfig(config) {
  const cfg = { ...DEFAULTS, ...config }
  if (cfg.definitionFile != null && typeof cfg.definitionFile !== 'string') throw new Error('dsh-multiroot: definitionFile must be a string')
  if (!Array.isArray(cfg.roots)) throw new Error('dsh-multiroot: roots must be an array')
  if (!Number.isInteger(cfg.maxRoots) || cfg.maxRoots < 1 || cfg.maxRoots > 32) throw new Error('dsh-multiroot: maxRoots must be an integer in 1..32')
  return cfg
}

function finalizeWorkspace(raw, baseDir, cfg) {
  const roots = (raw.roots ?? []).map((r, i) => {
    const spec = typeof r === 'string' ? { id: `root${i}`, path: r } : r
    if (!spec || typeof spec.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(spec.id)) throw new Error(`dsh-multiroot: invalid root id at index ${i}`)
    const abs = path.isAbsolute(spec.path) ? spec.path : path.resolve(baseDir, spec.path)
    const canonical = fs.realpathSync.native(abs)
    if (!fs.statSync(canonical).isDirectory()) throw new Error(`dsh-multiroot: root "${spec.id}" is not a directory: ${abs}`)
    return { id: spec.id, label: spec.label, readonly: spec.readonly === true, path: canonical, compare: process.platform === 'win32' ? canonical.toLowerCase() : canonical }
  })
  if (roots.length === 0) throw new Error('dsh-multiroot: workspace has no roots')
  if (roots.length > cfg.maxRoots) throw new Error(`dsh-multiroot: too many roots (${roots.length} > ${cfg.maxRoots})`)
  const ids = new Set()
  for (const r of roots) { if (ids.has(r.id)) throw new Error(`dsh-multiroot: duplicate root id "${r.id}"`); ids.add(r.id) }
  const primaryId = raw.primary ?? roots[0].id
  if (!ids.has(primaryId)) throw new Error(`dsh-multiroot: primary "${primaryId}" is not a root (roots: ${[...ids].join(', ')})`)
  return { primaryId, roots }
}

function defaultRootId(ws, cwd) {
  const here = canonical(cwd ?? process.cwd())
  let best
  for (const r of ws.roots) if (isUnderPath(r.path, here) && (!best || r.path.length > best.path.length)) best = r
  return best?.id ?? ws.primaryId
}

const canonical = (p) => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
const isUnderPath = (root, target) => {
  const a = process.platform === 'win32' ? root.toLowerCase() : root
  const b = process.platform === 'win32' ? target.toLowerCase() : target
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep)
}
const expandHome = (p) => p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
const safeStat = (f) => { try { return fs.statSync(f) } catch { return undefined } }
const clip = (s) => { const t = s ?? ''; return t.length <= 16_000 ? t : t.slice(0, 8_000) + '\n…(truncated)…\n' + t.slice(-8_000) }

// 保留上游 FsError 的结构化 code：原地改 message 再 rethrow（不要 new 一个普通 Error）
function remediate(error, displayPath) {
  const code = error && typeof error === 'object' ? error.code : undefined
  const suffix = code === 'FS_NOT_OBSERVED' ? ' — read the file (absolute path), then retry'
    : code === 'FS_STALE_VERSION' ? ' — re-read the file, then retry'
    : code === 'FS_EDIT_NOT_FOUND' ? ' — old_string was not found; use a larger unique snippet'
    : code === 'FS_AMBIGUOUS_EDIT' ? ' — old_string matched more than once; pass replace_all or a larger unique snippet'
    : code === 'FS_SANDBOX_DENIED' ? ' [sandbox] — check root.readonly, the target root, and the session permission mode (do not escalate)'
    : undefined
  if (suffix !== undefined) {
    try { error.message = `${error.message}${suffix}` } catch { /* message 只读时退回原错误 */ }
  }
  return error
}

function audit(cfg, exec, tool, root, targetPath, bytes) {
  if (!cfg.audit) return
  try {
    const dir = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'dsh-multiroot')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), JSON.stringify({ time: new Date().toISOString(), sessionId: String(exec.agent?.session?.id ?? ''), tool, root: root.id, path: targetPath, bytes }) + '\n')
  } catch { /* 审计失败不影响结果 */ }
}
```

> 骨架里没有写 `guardBuiltin` 的实现，见 §3.7；它是独立函数，可按需加。

---

## 附录 B：一个真实可用的定义文件（本机）

```json
{
  "version": 1,
  "primary": "plugins",
  "roots": [
    { "id": "plugins", "path": "D:/Projects/GolandProjects/dsh-plugins", "label": "DSH 插件仓" },
    { "id": "oss",     "path": "D:/oss" },
    { "id": "spec",    "path": "C:/Users/legan/Documents/spec", "readonly": true }
  ]
}
```

放在 `D:\Projects\GolandProjects\dsh-plugins\.dshworkspace.json`；从任一子目录开会话都能发现（向上查找）。

---

## 附：落地前必须做的 6 个小验证（按优先级）

| # | 验什么 | 怎么验 | 不成立的退路 |
|---|---|---|---|
| 1 | `ctx.fs.writeText` + 自造 policy 能否写到根 B | 装一个 20 行实验插件，暴露一个 `probe_write` 工具调 `writeText(target, 'x', undefined, signal, {mode:'workspace-write', workspaceRoot:'D:/oss'})` | 退到"写前 cd + danger-full-access"？（不可接受）→ 只能改本体 |
| 2 | `ctx.shell.resolve/execute` + 自造 policy 能否在根 B 执行 | 同上，`probe_run` 用 `sandboxPolicy.workspaceRoot='D:/oss'` 跑 `echo hi` | 改用 `ctx.subprocess.spawn + sandbox.confine`（约 200 行） |
| 3 | `ctx.tools.guard` 是否拦得住内置 `write` | 注册一个 unconditional deny guard，调内置 `write` 看是否被拒 | 放弃 guard，只靠提示词与沙箱拒绝 |
| 4 | `ctx.workingDirectory.get()` 在新会话是否可用 | `console.log(ctx.workingDirectory.get(session))` in a tool | 退回 `session.header.cwd` |
| 5 | `ctx.configForms.get(ns)` 对**无 schemastery 的插件 Config** 是否可用（L1 前提） | Client 半打印 `remote.settings.describe()` 里有没有本插件 ns | 放弃 L1，只做 L0.5 |
| 6 | `TypertCodec` 的 `{mode:'src-json'}` 分支是否免 zod 工厂（L2 前提） | 读 `dsh-typert-protocol` 的 codec 分支 + 手写一个 method 试挂 | L2 改用 `webServer.register`（+2 天，自己限根） |

> 1–4 决定 Host 半能不能成立（预计 30 分钟）；5–6 只影响 UI 档位。

---

## 附录 C：如果改沙箱本体，到底要改多少

> 结论先行：**不大**。多根在沙箱层的语义只需要"一个字段 + 一个函数"，而且下游有一半是免费的；真正的工作量集中在 **Windows ACL 的接线（2–3 人日，纯 JS，不用写原生代码）**，以及"根从哪来"的会话状态（严格说不属于沙箱）。

### C.1 为什么小：`workspace-write` 的语义只有一个定义处

```
writableRoots(policy)  ← 唯一真源（dsh-sandbox/lib/index.js:166-173）
   ├─ dsh-fs-sandbox   写围栏：已经 for 循环逐个 isPathUnder（:160-164）→ 免费
   ├─ Seatbelt 方言    已按 writableRoots 拼 subpath（sandbox-local:65-75）→ 免费
   ├─ bwrap 方言       --bind policy.workspaceRoot（:22-39）→ 加个循环
   ├─ Landlock 方言    readWrite.push(policy.workspaceRoot)（:41-52）→ 加个循环
   └─ Windows ACL      单 workspace + 单 write-sid（:357-382）→ 接线活
```

所以"改成多根"在类型上就是：

```ts
interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string            // 保留 = roots[0]，兼容旧 provider
  workspaceRoots?: readonly string[]   // 新增：可选的额外根
  sessionId?: SessionId
}
function writableRoots(policy) {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, ...(policy.workspaceRoots ?? []), '/tmp', tmpdir()].map(canonicalPath))]
}
```

### C.2 逐包改动与工作量

| 包 | 改什么 | 证据 | 人日 |
|---|---|---|---|
| `dsh-sandbox` | 类型加可选字段；`writableRoots` 合并 | `lib/index.js:166-173` | 0.5 |
| `dsh-fs-sandbox` | **零**（已循环 writableRoots） | `lib/index.js:160-164` | 0 |
| `dsh-sandbox-policy` | `resolve()` 产出多根；提示词渲染多根 | `lib/index.js:141-148, 72-83` | 1–1.5（含根的来源） |
| `dsh-sandbox-local` | bwrap/Landlock 循环（各几行）；Windows 相关见下 | `:22-52` | 0.5 |
| `dsh-sandbox-local`（Windows） | `windowsAclRunnerArgv` 发多对 `--workspace/--write-sid`；`materializeAclGrant` 每根一条 grant；temp 键改多根签名 | `:357-444` | 2–3 |
| `dsh-sandbox-windows-acl` | runner 解析重复参数；`AclSandbox` 的 `writeSid` → `writeSids[]`；`createRestrictedToken` **本来就收数组** | `runner.js:16-19, 59-109, 143-150`；`types-*.js:1290, 1277-1286` | （含上） |
| 测试 | 围栏多根、runner 多根、provider 一致性 | — | 1–2 |
| **合计（完整多根）** | | | **5–7 人日** |

关键证据：`createRestrictedToken(api, token, logonSid, [writeSidPtr, tempWriteSidPtr].filter(Boolean), …)` 已经接受 **SID 数组**（`types-Cl_DXjhk.js:1290`），`AclWriteGrant.add(path, standing)` 本来就按路径逐条 grant（`:983-986`）。所以 Windows 不是"重写沙箱"，而是"把单元素数组改成 N 元素、把单对 CLI 参数改成多对"。

### C.3 三种改造深度（按投入排）

| 深度 | 改什么 | 得到什么 | 代价 |
|---|---|---|---|
| **C（= 插件路线）** | 沙箱**零改动** | 插件工具可跨根（自报 policy）；内置工具仍单根 | 0 人日 |
| **A（最小本体改动）** | `dsh-sandbox` 类型 + `writableRoots` + `sandbox-policy` 从配置读 `additionalRoots` | **内置 `write`/`edit` 直接支持多个根**（fs 围栏免费）；`pwsh` 仍单根（provider 只认 `workspaceRoot`，安全地失败关闭） | **1.5–2 人日** |
| **B（完整本体多根）** | A + bwrap/landlock/Windows 方言 + 会话根状态 | fs 与 shell 全多根；所有 provider 一致 | **5–7 人日** |

A 的语义是"**写工具多根、命令单根**"——不完美但不撒谎：shell 写根外仍会被 ACL 拒。对"AI 主要用 read/write/edit、偶尔跑命令"的场景，A 的性价比很高。

### C.4 真正的成本不在沙箱，在"根从哪来"和"怎么发版"

1. **根的来源**：`resolve()` 现在只读 `session.header.cwd`（`dsh-sandbox-policy:145`）。要让它返回多个根，必须有"会话根集合"——这就要动 `dsh-working-directory` 的投影 + 事件 + 迁移（1–1.5 人日），或者先用部署级配置 `additionalRoots`（0.5 人日，但没有"每个项目不同根"）。
2. **发版**：DSH 桌面版是 `app.asar` 打包。改本体包要么走上游 PR，要么从源码构建，要么直接 patch asar 做验证——**每次应用升级都会覆盖**。代码 5 天 ≠ 上线 5 天，这条要单独评估。
3. **兼容性**：把字段设计成**可选**（`workspaceRoots?`），旧 provider 只认 `workspaceRoot` → 行为退化为单根（fail-closed），不会变成安全漏洞；`resolve()` 继续返回 `workspaceRoot = roots[0]`，第三方插件不用改。

### C.5 建议

- **想立刻可用**：保持插件路线（C），零本体改动。
- **想让内置工具也跨根、又不想大动**：先做 A（1.5–2 天），把 `additionalRoots` 接到现有 profile 配置；shell 仍单根，文档写清楚。
- **想做到 Cursor 级一致**：做 B + 会话根集合 + UI（后者才是大头，见总报告 M2 的 ≈22 人日）。

---

## 附录 D：低成本替代方案——跨仓变更台账（推荐先做这个）

> 触发场景：需求横跨多个仓库（依赖库、前端、服务），**多轮会话后忘了改过哪些仓库**。
> 关键判断：这个痛点的主因是"**没有可信的跨仓变更记录**"，而不是"不能跨仓写"。前者 1–2 人日可解，后者才是 6–22 人日。

### D.1 问题拆开看

| 子问题 | 真实需求强度 | 最便宜的解 |
|---|---|---|
| 多轮后忘了改过哪些仓库/文件 | **每次都痛** | **变更台账**（git 为事实源 + 每轮注入一行摘要） |
| 需要在依赖库/前端里**写**代码 | 偶尔 | 每仓库一个 subagent（内置 `subagent({cwd})`），或公共父目录，或终端 |
| 跨仓读/搜 | 有 | 已经免费（绝对路径 + code-index `roots[]`） |
| Cursor 式多根树/每根终端/跨根 @ | 弱 | 不做，或等本体 |

### D.2 台账插件（`dsh-repo-ledger`）设计

**目标**：任何时刻，模型和你都能看到"这次需求/这个会话树里，哪些仓库被改过、改了多少、基于哪个 commit"。

数据源（双保险）：

| 源 | 覆盖 | 成本 |
|---|---|---|
| `fs/observed` 事件（`target` + `actor`） | 所有走 `write`/`edit`/插件写工具的改动 | 0（插件监听） |
| `git -C <repo> status --porcelain=v1 -z`（去抖后刷新） | **包括 shell/终端/外部改动**，最权威 | 每个仓库几 ms |
| `git log --oneline <base>..HEAD` | 代理自己提交的 commit | 同上 |
| 会话开始时的基线快照 | 区分"本来就脏"和"这次改的" | 一次 |

作用域聚合（这是关键设计）：利用 `SessionHeader.parentSession` 把 **subagent 会话自动归到 root 会话**，台账按 root session 聚合——委托出去的子任务改了哪个仓库，主会话也看得见。

注入（bounded）：

```
Cross-repo changes (root session): api 2 files (+18/-4); web 3 files (+120/-8); sdk 1 file (+6/-0).
Untouched roots: infra, docs.
```

- 放在 `systemPrompt.context`，紧跟 `WORKING_DIRECTORY`；**无改动时不输出**。
- 只给 repo 级别 + 文件计数 + 行数，细节用工具查（避免每轮灌 diff）。

工具（只读）：

```js
repo_ledger({ action: 'list' | 'report', repo?, feature? })
// list:  每个仓库 { id, path, branch, baseCommit, headCommit, dirtyFiles, added, deleted, lastTouchedAt }
// report: markdown 摘要（含 per-repo git diff --stat），可直接贴给用户/写进 memory-archive
```

存储：`$DSH_HOME/repo-ledger/<rootSession>.json`（不进 session 日志）。仓库集合来源：`.dshworkspace.json` 的 `roots`，或插件 Config `repos: [{id,path}]`，或扫描 `D:/Projects`、`D:/oss` 下 depth≤2 的 `.git`。

与现有插件的关系：`memory-archive` 负责"压缩后逐字内容可查"，台账负责"跨仓事实可查"；`code-index` 负责"代码在哪"。三者互补，不需要改任何一个。

工作量：**1–2 人日**（git 解析 0.3 + 事件/去抖 0.3 + 注入 0.2 + 工具 0.3 + 基线/提交 0.3 + 测试 0.4）。

### D.3 跨仓执行的三条零改造路径

| 路径 | 怎么做 | 能力 | 代价 |
|---|---|---|---|
| **每仓库 subagent**（推荐） | 协调者会话用 `subagent({ cwd: 'D:/oss/api', prompt: '…' })`；子会话的 `header.cwd` 就是那个仓库 → 自己的写边界 | 子代理在各自仓库读写；协调者汇总；台账自动归并 | prompt 纪律；不能实时看子代理中间过程 |
| 公共父目录 | 会话开在 `D:/Projects` | 读写全部子项目 | 权限过宽；跨盘无解；@/diff 噪声 |
| 终端 | `terminal_open({ cwd: 'D:/oss/api' })` | 任意命令 | 无围栏，不建议长期 |

### D.4 为什么这比多根插件更对

1. **事实源是 git，不是模型记忆**：模型可能忘，`git status` 不会。
2. **跨会话/跨压缩存活**：台账在插件存储里，压缩只影响消息，不影响事实。
3. **零权限扩张**：只读 git + 注入文本；不改变写边界，不需要碰沙箱。
4. **与 subagent 天然协作**：`parentSession` 让"委托出去的改动"自动回到主台账。

### D.5 验收（模拟真实需求）

1. 在 `api`、`web`、`sdk` 三个仓库各改一处（其中一处用 subagent 完成）；
2. 跑 30 轮后问"这个需求改了哪些仓库"；
3. 期望：即使会话被压缩过，`Cross-repo changes` 那行仍在，`repo_ledger report` 能给出三仓的 file/±/base commit 与 commit 列表。
