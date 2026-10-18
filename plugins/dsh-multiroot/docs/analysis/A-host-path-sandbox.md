# A. Host 侧：路径解析与会话 cwd 的单根假设盘点

> 任务：task-1（只读调研）。目标：查清 DSH Host「一个会话只有一个工作目录」的硬落点，判断「类 Cursor 多目录工作空间」能否只靠插件做到，必须改本体时改哪些包。
>
> 结论标注约定：**可插件化** / **必须改本体** / **有风险** / **未确认**。

## 0. 给 Lead 的结论速览

1. **执行层（真正拦写入权限的那层）不是最硬的墙**：`SandboxExecutionPolicy = { mode, workspaceRoot: string, sessionId? }` 只有**一个** root，但它是由**调用方**（工具）逐次自报的普通对象；`fs.writeText(..., sandboxPolicy)` 和 `ctx.shell.execute({ sandboxPolicy })` 都按传入对象推导授权根（`writableRoots(policy)` = `[workspaceRoot, /tmp, tmpdir()]`）。所以一个插件**自己发起**的读写/命令，可以把 `workspaceRoot` 报成任意根，从而在 `workspace-write` 下写任意目录——**不需要改本体**。反过来说：插件一旦被安装，就等价于能自报任意写根，这是既有的信任模型（`有风险`，见 §8.6）。
2. **最硬的墙是「单根管线」而不是「单根沙箱」**：会话 cwd 在创建时冻结进 `session.header.cwd`（不可变），`workingDirectory` 只在其上追加一条 `working-directory/change` 事件与投影；`sandboxPolicy.resolve()` 读的是 **header.cwd**（不是投影，所以 `cd` 不改变沙箱边界）；复用已有会话时 `header.cwd` 必须与请求 cwd **字符串相等**，否则 `ApiSessionCwdConflict`（`必须改本体`，§2.4）。
3. **内置工具不可被插件透明改造**：`tools/execute` 只允许改 `exec.signal`（事件契约明说 call identity immutable），`tools/pre-execute` 的 `PreToolDecision` 只有 allow/deny/cancel/ask（不能改写参数），`ctx.tools.guard()` 只能拒绝。想改 `read/write/edit/grep/glob/pwsh` 的「相对谁解析」，唯一插件手段是在 `agent.ctx` 注册**同名工具 shadow 掉内置工具**（重实现），`有风险`。
4. **Service 不可运行时替换**：Cordis 同注入域内重复 provide 直接抛错（`service "x" has been registered at <...>`），`ctx.set` 只能由提供方自己的 fiber 调用。所以「自有 Service 替换 `workingDirectory`/`sandboxPolicy`/`fs`/`shell`」**不是插件 API**；只有两条路：composition 层 patch 行 `disabled` + 插自己的 provider（版本强耦合），或 `ctx.isolate(name)` 隔离域 + 只让自己注册的工具消费（对内置工具无效）。
5. **worktrees 不是「多根」先例**：它不扩沙箱根，而是把新 checkout 建在 `repositoryRoot\.agents\worktrees\<branch>`——即原 workspace root 之内；策略仍是会话原来的 `header.cwd`，新目录因为落在同一根下才可写（§7 逐行）。真正跨根的现成先例**不存在**。
6. **可插件化的最小 MVP 成立但很重**：自持根清单（storage）+ 每个 agent 作用域内 shadow 6 个文件/命令工具 + 自算 per-call policy + 追加一条 runtime-context 行，能做到「模型层面多根读写/执行」；但会话日志、会话头、`@` 引用、文件树、变更 diff、工作区注册表仍全是单根（后者见 task-2）。要让多根成为一等公民，必须改 §9 列出的本体包。

## 1. 证据口径与路径约定

- DSH 安装：`C:\Users\legan\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\`（app.asar）。**只有 `read` 工具能打开 asar 内文件**（pwsh/glob/grep 不行）。本文所有源码引用均来自 `read` 到的 `lib/index.js`（包内带完整 JSDoc），未安装、未改 profile、未改本体。
- 包版本：`@deepseek-ai/*` 均为 `0.2.1-rc.2`；`@deepseek-ai/cordis` `4.0.5`（`%M%\@deepseek-ai\dsh-working-directory\package.json:3`、`%M%\@deepseek-ai\cordis\package.json:5`）。
- 为节省篇幅，下文用前缀常量表示绝对路径：
  - `%M%` = `C:\Users\legan\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules`
  - `%ASAR%` = `C:\Users\legan\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh`
  - 例如 `%M%\@deepseek-ai\dsh-sandbox-policy\lib\index.js:145` 即 `C:\Users\legan\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-sandbox-policy\lib\index.js:145`。
- 运行时契约以 `cordis_inspect_query` 为准（Host `Service`/`Event`/`Config`），源码行号用于定位实现。

## 2. workingDirectory 服务（会话 cwd 的唯一持有者）

### 2.1 契约（Host Service）

| 成员 | 签名 / 含义 | 证据 |
| --- | --- | --- |
| `defaultDirectory` | `readonly string`：没有记录原目录时的部署兜底 | `%M%\@deepseek-ai\dsh-working-directory\lib\index.js:20`、`:26-28`（Service 契约同） |
| `get(session)` | 同步读投影，无 IO | `%M%\@deepseek-ai\dsh-working-directory\lib\index.js:76-78` |
| `ensure(agent, signal?)` | 校验当前目录存在，原项目消失则恢复并提交 | 同上 `:87-103` |
| `set(agent, path, signal?)` | 切目录（绝对或相对当前），必须是已存在目录 | 同上 `:113-120` |

### 2.2 实现要点（逐行）

| 行 | 事实 |
| --- | --- |
| `:12-17` | `class WorkingDirectoryService extends Service`，`static inject = ["fs","sessionProjections","systemPrompt"]` |
| `:18` | `static Config = z.object({ defaultDirectory: z.string() })` → **可注入（Config）**，但只影响兜底值 |
| `:26-28` | `config.defaultDirectory ?? process.cwd()`，且必须绝对路径 |
| `:29-40` | 注册 session projection `key: "workingDirectory"`，`stateVersion: 1`，`stateSchema = string().min(1).nullable()`，`init: header.cwd ?? null`，`apply: event.type === "working-directory/change" ? event.data.cwd : state` → **状态是单个可空字符串** |
| `:41-47` | 注册 systemPrompt context `working-directory:current`（`order = WORKING_DIRECTORY`，`required: true`，`interpolate: false`） |
| `:48-65` | 在 `system-prompt/assemble` 上**prepend** 监听：先 `ensure(agent)`，再 `next()`，然后把该 context 的 text 重算并强制写回（缺了就 unshift） |
| `:76-78` | `get(session) = stateOf(...) ?? defaultDirectory` |
| `:87-103` | `ensure`：`fs.resolve(current)` + `fs.stat`；若不是目录 → 取 `header.cwd ?? defaultDirectory` 恢复并 `commit(..., recovered=true)` |
| `:95` | 投影为 `null`（新会话首次）时补一条 `working-directory/change` |
| `:115-117` | `set`：`directory(path, this.get(session))` 后 `commit` |
| `:121-123` | `contextText(session)` → 正是模型看到的 **`Current working directory: "<abs>".`** 这一行 |
| `:124-133` | `directory()`：`fs.resolve(path,{cwd})` → `fs.stat` → 必须 `type === "directory"` → `fs.processPath(target)` |
| `:134-152` | `commit`：**`agent.session.append("working-directory/change", { cwd })`**（`:139`），随后 `agent.inject(createUserMessage(...))` 给模型一条“目录已变更”的用户消息（`:140-148`） |

### 2.3 持久化

- 冻结字段：`SessionHeader.cwd?: string`（`dsh-session` 类型；`CreateAgentOptions.meta` 里是 `readonly cwd?: string`，见 `agents` Service 契约）。
- 可变目录：**日志事件** `working-directory/change { cwd }`（log-only，被上面 projection 折叠）；不是配置，也不是独立存储。
- 注意：插件**不能**新增自己的事件类型持久化根清单（`appendPluginRecord` 只留给 DSH 实验包；未知事件类型只有 `ignorable: true` 才能重开）——见 `%ASAR%\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\practices.md:21`。多根清单只能进 storage 服务或投影派生。

### 2.4 会话创建 / 复用：cwd 是「一会话一根」的身份

| 行 | 事实 |
| --- | --- |
| `%M%\@deepseek-ai\dsh-api-session-controller\lib\index.js:97-108` | `class ApiSessionCwdConflict`：`session "X" belongs to "Y", not "Z"` / 无记录 cwd 时不能收养 |
| `:421` | 活会话复用：`if (live.session.header.cwd !== request.cwd) throw new ApiSessionCwdConflict(...)` |
| `:442` | 冷会话复用：`if (observed.header.cwd !== request.cwd) throw new ApiSessionCwdConflict(...)` |
| `:393` | resume 前要求 `header.cwd !== undefined`，否则 `ApiSessionNotFound` |
| `:508-526` | `createMinted(cwd)` → `createAgent`：`mkdir(cwd,{recursive:true})` 后 `agents.create({..., meta:{ cwd }})` |

判定：**必须改本体**（若要「一个会话挂 N 个根并在 UI 里切换/保存」，这段一一绑定与字符串相等校验是硬约束；插件只能选择其一：给每个根开一个会话，或把根清单放在会话之外的自有存储里并自定义工具）。

## 3. sandboxPolicy 与 SandboxExecutionPolicy

### 3.1 类型原文（Host Service 契约）

```ts
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export interface SandboxExecutionPolicy {
  mode: SandboxMode;
  workspaceRoot: string;      // ← 单根，字符串
  sessionId?: SessionId;
}
export interface SandboxPolicy extends SandboxExecutionPolicy {
  mode: Exclude<SandboxMode, 'danger-full-access'>;
}
export interface SandboxPolicyRequest { session?: Session; mode?: SandboxMode; }
```

判定：**必须改本体**（要表达多根，`@deepseek-ai/dsh-sandbox` 的类型与 `writableRoots()` 得改；否则只能「一次一个根」，由调用方轮流自报）。

### 3.2 实现（逐行）

| 行 | 事实 |
| --- | --- |
| `%M%\@deepseek-ai\dsh-sandbox-policy\lib\index.js:97-104` | `Config = { mode: read-only | workspace-write | danger-full-access (默认 read-only), workspaceRoot: string }` → **mode 与兜底根可注入** |
| `:110-113` | `defaultMode = config.mode`；`workspaceRoot = config.workspaceRoot ?? process.cwd()`（必须绝对） |
| `:114-120` | 注册 projection `sandboxMode`，`apply: event.type === "sandbox/mode" ? event.data.mode : state` → **只折叠 mode，没有 root 事件** |
| `:40-42` | `setSandboxMode(session, mode)` 追加唯一事件 `sandbox/mode` |
| `:121-130` | 注册 systemPrompt context `sandbox:policy`（`order = SANDBOX_POLICY`，非 required） |
| `:72-83` | `renderPolicyContext`：`workspace-write` 时渲染 ``Current DSH file policy: workspace-write. ... under the session workspace: "<root>".``（`:75`）→ **一行只报一个根** |
| `:141-148` | `resolve(request = {})`：`mode = request.mode ?? overrideOf(session) ?? defaultMode`；**`workspaceRoot = session?.header.cwd ?? this.workspaceRoot`（`:145`）**；附带 `sessionId` |
| `:154-156` | `overrideOf` 读 projection |

**关键点**：沙箱边界取自 **`session.header.cwd`（创建时冻结）**，不是 `workingDirectory.get()` 的投影。所以 `working_directory cd` 到别的目录后：相对路径解析基准变了，**写权限边界没变**。`ensure()` 的原目录消失恢复也不会改 header。

### 3.3 workspaceRoot 的下游消费者

| 消费者 | 用法 | 证据 |
| --- | --- | --- |
| `fs` 围栏（进程内） | `writableRoots(policy)` 逐根 `isPathUnder` | `%M%\@deepseek-ai\dsh-fs-sandbox\lib\index.js:153-166` |
| `writableRoots` 唯一真源 | `policy.mode !== "workspace-write" → []`；否则 `[policy.workspaceRoot, "/tmp", tmpdir()]` 去重+realpath | `%M%\@deepseek-ai\dsh-sandbox\lib\index.js:166-173` |
| bwrap profile | `--bind policy.workspaceRoot policy.workspaceRoot` | `%M%\@deepseek-ai\dsh-sandbox-local\lib\index.js:34-37` |
| Landlock profile | `readWrite = ["/dev/null", "/tmp", policy.workspaceRoot]` | 同上 `:45-52` |
| Seatbelt profile | `writableRoots(policy)` 生成 `(allow file-write* (subpath ...))` | 同上 `:65-75` |
| Windows ACL（本机实际生效） | `canonicalPath(policy.workspaceRoot)`（`:307-310`）→ `workspaceWriteSid(policy.workspaceRoot)`（`:378`、`:398`）、私有 temp 按 `JSON.stringify([sessionId, workspaceRoot])` 缓存（`:413`）；`AclWriteGrant.create(writeSid).add(root, true)`（`:400-412`） | `%M%\@deepseek-ai\dsh-sandbox-local\lib\index.js:357-444` |
| `sandbox.confine` 契约 | `confine(argv, policy: SandboxPolicy, signal?)` | `%M%\@deepseek-ai\dsh-sandbox\lib\index.js:282-287`（抽象服务注册为 `sandbox`） |

判定：**单根硬编码在类型与 provider 方言里**；但「哪个根」由调用方逐次传入（`有风险`：policy 是调用方自报，不是服务端从会话身份重新推导）。

## 4. fs 服务（`ctx.fs`）

### 4.1 契约（Host Service `fs`）

| 方法 | 签名（节选） |
| --- | --- |
| `resolve` | `resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>` —— `cwd` 只是**相对路径基准** |
| `processPath` | `processPath(target: FsTarget): string` —— 给子进程用的绝对路径 |
| `contains` | `contains(parent: FsTarget, child: FsTarget): boolean` —— **单个 parent/child 对** |
| `writeText` | `writeText(target, content, expected?: FsWriteIntent, signal?, sandboxPolicy?: SandboxExecutionPolicy)` |
| `editText` | `editText(target, edit, expected?: { version }, signal?, sandboxPolicy?: SandboxExecutionPolicy)` |
| 读取方法 | `readText/streamText/readBytes/readByteRange/listDir` 都**没有** sandboxPolicy 参数 |

### 4.2 实现

| 行 | 事实 |
| --- | --- |
| `%M%\@deepseek-ai\dsh-fs-local\lib\index.js:751-754` | `Config = { cwd: process.cwd(), diffBasisMaxBytes }`：provider 自己的相对基准（**不是边界**，注释 `:720-724` 明说 “a resolution default, NOT a containment boundary”） |
| `:780-788` | `resolve(path, opts)` → `resolveLocalTarget(opts?.cwd ?? this.config.cwd, path)` |
| `:789-794` | `processPath` 返回 `targetKey`（realpath 身份）；`processPathFromHostPath` 只接受绝对路径 |
| `:798-801` | `contains(parent, child)`：`path.relative(processPath(parent), processPath(child))` 判断在不在内 |
| `:864-882` / `:883-900` | `writeText`/`editText`：**忽略**第 5 个 `sandboxPolicy`（本地后端不围栏），只做原子写/版本校验/`FS_NOT_OBSERVED` |

### 4.3 围栏实现（`@deepseek-ai/dsh-fs-sandbox`）

| 行 | 事实 |
| --- | --- |
| `:103-109` | `class SandboxedFileSystem extends LocalFileSystem`，`inject = ["sandboxPolicy"]`，注册为 `ctx.fs`（**替换** `dsh-fs-local` 才算装上围栏） |
| `:125-127` / `:139-141` | 只有 `writeText`/`editText` 走 `checkedTarget`；读一律放行（`:73-76` 注释：*Reads pass through untouched: every mode permits reading*） |
| `:153-166` | `checkedTarget`：`policy = sandboxPolicy ?? ctx.sandboxPolicy.resolve()`（`:154`）；`danger-full-access` 直接放行（`:156`）；`read-only` 抛 `FS_SANDBOX_DENIED`（`:157`）；否则 `fresh = resolve(target.displayPath)` 重新 realpath（`:158`），**循环 `writableRoots(policy)` 做 `isPathUnder`**（`:160-163`），不在任何根下 → 拒绝（`:164`） |
| `:53-65` | `isPathUnder`：先词法前缀（Windows 大小写不敏感），再逐级 ancestor 用 `dev/ino` 比对，兼容 8.3 短名/大小写别名 |

判定：**单根来自 policy 类型；围栏本身已经是「按根的 allow-list 循环」**（多根语义天然兼容，只需 policy 带多根）。插件要授予第二个根，只能自己把 `sandboxPolicy` 参数填成那个根（§8.5）。

## 5. 工具层：cwd 从哪来、能否换 workdir、沙箱策略从哪来

| 工具 / 插件包 | 取 cwd | 是否支持 workdir / 多根 | 沙箱策略来源 | 证据 |
| --- | --- | --- | --- | --- |
| `read` / `read_image` (`@deepseek-ai/dsh-tool-fs`) | `workingDirectory.ensure(agent)`（`sessionResolveOptions`） | 否，只有 `file_path`（绝对路径可用，读不受围栏） | 无（读不围栏） | `%M%\@deepseek-ai\dsh-tool-fs\lib\index.js:171-177`、`:192`、`:337` |
| `write`（同上） | 同上 | 否 | `FsSandboxController.resolvePolicy("write",...)` → `ctx.sandboxPolicy.resolve({session})`（`:1136`）；升级只改 `mode`（`:1152-1155`） | 同上 `:605-610`、`:1088-1156` |
| `edit`（同上） | 同上 | 否 | 同上（`edit`） | 同上 `:749-758` |
| 写入意图 guard | — | — | `ctx.waterfall("fs/write-intent"/"fs/edit-intent")` 提供 `FsWriteIntent`/`version`（**只能收紧，不能换 target**） | 同上 `:607`、`:753` |
| `glob` / `grep` (`@deepseek-ai/dsh-tool-fs-search`) | `runRipgrep`: `workingDirectory.ensure(agent)`，否则 `process.cwd()` | 否；`path` 只是**一个**搜索根，相对 workdir 解析 | **完全没有**（直接 `ctx.subprocess.spawn` ripgrep，不经过 `ctx.sandbox`） | `%M%\@deepseek-ai\dsh-tool-fs-search\lib\index.js:166-207`（`:168`、`:171-185`）、`:584-595`、`:933-938` |
| `pwsh` (`@deepseek-ai/dsh-tool-pwsh`) | `workingDirectory.ensure(agent)`（`:636`） | **是**：`workdir` 参数，绝对路径原样、相对按 session cwd（`resolveWorkdir`，`:260-265`） | `resolveSandboxPolicy(exec) = ctx.sandboxPolicy.resolve({session})`（`:321`）；升级只改 mode（`:334-349`） | `%M%\@deepseek-ai\dsh-tool-pwsh\lib\index.js:636-643`、`:676` |
| `ctx.shell` 执行器 (`@deepseek-ai/dsh-pwsh-sandbox`) | 由调用方给 `workdir` | 契约上支持任意 workdir | `resolve(request)`：`request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`（`:145-150`）；`execute(spec)` 用 `spec.sandboxPolicy` 调 `confine`（`:151-205`、`:247-249`） | `%M%\@deepseek-ai\dsh-pwsh-sandbox\lib\index.js` |
| `working_directory` (`@deepseek-ai/dsh-tool-working-directory`) | — | 只切换**唯一** cwd | — | `%M%\@deepseek-ai\dsh-tool-working-directory\lib\index.js:38-41` |
| `terminal_open` / 其余 terminal 工具 (`@deepseek-ai/dsh-tool-terminal`) | `workingDirectory.ensure(owner)`；`cwd` 参数 `resolve(cwd, args.cwd)`（绝对路径生效） | 可进任意绝对目录 | **没有**：`TerminalSpawnRequest = { type, name?, cwd? }`，不携带 `sandboxPolicy` | `%M%\@deepseek-ai\dsh-tool-terminal\lib\index.js:300-308`；Service `terminals` 契约 |

判定：**必须改本体**（若要求「内置工具按根解析相对路径 / 记住根前缀」）；**可插件化（重实现）**（shadow 同名工具）；`有风险`（`grep/glob/terminal` 本身不围栏，多根设计里它们天然可跨根）。

`ctx.shell`/`ctx.terminals` 都是**单实现 Service**：`%M%\@deepseek-ai\dsh-shell\lib\index.js:55-59` 明说 “one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior”。

## 6. system prompt 里的 runtime context（cwd 那行）

| 谁 | 产出 | 证据 |
| --- | --- | --- |
| `@deepseek-ai/dsh-system-prompt` | 外层包装 **`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`** + 各 context 以 `\n\n` 连接；`CONTEXT_ORDERS` 固定排序（`WORKING_DIRECTORY:100, SANDBOX_POLICY:110, APPROVAL_POLICY:115, SUBAGENT_DELEGATION:120, TEAM_IDENTITY:125, HARNESS_SOURCE:200, WEB_SURFACE:210`） | `%M%\@deepseek-ai\dsh-system-prompt\lib\index.js:44-52`、`:125-140`（`:139` 是那行包装文本）、`:356-406` |
| `@deepseek-ai/dsh-working-directory` | **`Current working directory: "<abs>".`**（`context name = working-directory:current`，`required: true`，在 `system-prompt/assemble` 里被强制刷新） | `%M%\@deepseek-ai\dsh-working-directory\lib\index.js:41-47`、`:48-65`、`:121-123` |
| `@deepseek-ai/dsh-sandbox-policy` | **`Current DSH file policy: workspace-write ... under the session workspace: "<root>".`**（`context name = sandbox:policy`） | `%M%\@deepseek-ai\dsh-sandbox-policy\lib\index.js:72-83`、`:121-130` |
| `@deepseek-ai/dsh-system-prompt` 的 Config | `includeRuntimeContext`（默认 true）可整体抑制可选 context；`suppressRuntimeContext()` 是作用域级开关 | 同上 `:213-220`、`:243`、`:289-291`、`:324-346` |
| 其他 context | 批准策略、subagent 深度、团队身份、harness 源码位置等，由各自包注册 | `CONTEXT_ORDERS` 见上 |

判定：**可插件化**（插件可 `ctx.systemPrompt.context({name, order, text})` 追加自己的「工作空间根清单 / 当前根」行；也可在 `system-prompt/assemble` waterfall 里改 `assembly.contexts`，`working-directory` 自己就是这么做的）。但**内置那两行的单根语义改不了**（除非抑制/替换或改本体）。

## 7. worktrees 服务：现成的「cwd 之外目录」先例，但不是多根

`@deepseek-ai/dsh-experimental-worktree`（服务 `worktrees`，工具 `create_worktree` 在 `@deepseek-ai/dsh-experimental-tool-worktree`）。

| 行 | 机制 |
| --- | --- |
| `:186-192` | `inject = ["workingDirectory","fs","subprocess","sandbox","sandboxPolicy"]` —— 它确实是「目录 + 沙箱」的交汇点 |
| `:193-201` | `Config.directory = ".agents/worktrees"`（**相对**、禁止 `..`/盘符）、`namePrefix`、git/node 命令、超时/输出上限 |
| `:258` | `cwd = await ctx.workingDirectory.ensure(agent, signal)` —— 起点是会话当前目录 |
| `:259` | `policy = ctx.sandboxPolicy.resolve({ session: agent.session })` —— **策略取会话原策略（root = header.cwd）**，此后所有命令都用它 |
| `:268-286` | `git check-ref-format` → `git rev-parse --show-toplevel` → `repositoryRoot` → `rev-parse --verify <rev>^{commit}` → 拒绝已存在分支 |
| `:287-291` | `pool = fs.resolve(config.directory, { cwd: repositoryRoot })` → `poolPath`（即 **`<repositoryRoot>\.agents\worktrees`**） |
| `:292-297` | `destination = fs.resolve(branch, { cwd: poolPath })` → `path`；`lstat` 已存在则失败 |
| `:299-306` | 用 `node -e PREPARE_DIRECTORY`（静态脚本 `:11-29`）**在 confinement 下**创建 pool 与 destination（`runCommand` 里 `sandbox.confine(argv, policy)`，`:131-134`） |
| `:307-318` | `git worktree add --no-checkout -b <branch> -- <path> <baseCommit>`（再 confined） |
| `:319-355` | 读取并禁用 filter 驱动（clean/smudge/process/required），`git reset --hard --no-recurse-submodules` |
| `:356-361` | 成功后 **`path: await ctx.workingDirectory.set(agent, path, signal)`** → 追加 `working-directory/change` 并注入 notice；返回 `{path, branch, baseCommit, repositoryRoot}` |
| `:131-134` | `runCommand`：`policy.mode === "danger-full-access"` 直跑，否则 `sandbox.confine(command, policy)` —— **policy 从头到尾没换过** |

**机制解读（关键）**：

1. worktree **没有扩大**沙箱根，也没有给 `sandboxPolicy` 增加根。它把新 checkout 建在 `repositoryRoot\.agents\worktrees\<branch>`，也就是**源仓库根之下**；在 `header.cwd == repositoryRoot` 的常见情形下，新目录仍落在 `workspaceRoot` 内，Windows ACL 的 `workspaceWriteSid(root)` 同样覆盖它，因此可写。
2. 它只改「当前目录」（`workingDirectory.set`），进而改变**相对路径基准**与系统提示那一行；`sandboxPolicy.resolve()` 仍读 `header.cwd`，所以安全边界没变。
3. 边界情形（**代码推断，未实测**）：若会话 `header.cwd` 是仓库的**子目录**，则 `repositoryRoot` 在授权根之外，`PREPARE_DIRECTORY`/`git worktree add` 在该 root 外的写操作会被围栏拒绝（Windows ACL 只 grant `header.cwd`）。这正说明 worktree 是「嵌套目录」方案，不是「多根授权」方案。

判定：**不可复用为多根机制**。可作为「新根必须内置在原根之下」这种折中设计的先例（`有风险`：用户无法把两个不相干目录当同一个工作空间）。

## 8. 插件能用的正规手段（按强弱 / 按是否真能改行为）

> 依据：`references/practices.md`（`:10` 强度阶梯、`:16-19` waterfall/guard 规则、`:21` 不允许新事件类型）与 Host Service/Event 契约。

| 手段 | 能力 | 对多根是否有用 | 证据 |
| --- | --- | --- | --- |
| `ctx.tools.restrict()` | 只能**移除**工具 | 仅用于隐藏内置工具后换自己的 | practices.md:17 |
| `ctx.tools.guard()` | 同步**拒绝**，不能放行也**不能改参数** | 只能做「根白名单」式收紧 | `ToolGuard = (execution) => string \| undefined`（Service `tools` 契约） |
| `tools/pre-execute` waterfall | allow/deny/cancel/ask；`PreToolDecision` **没有 rewrite 变体** | ❌ 不能把 `path` 重写成另一根的绝对路径 | Event 契约 |
| `tools/execute` waterfall | **只允许改 `exec.signal`**；call identity 不可变 | ❌ | Event 契约原文：“wrappers may change only `exec.signal`, while call identity remains immutable” |
| `tools/post-execute` | 接受/替换/补充/拦截结果 | 只能改**结果**，改不了实际写到哪 | Event 契约 |
| `systemPrompt.context/section` | 追加 prompt 行（可 per-agent：`agent.ctx`） | ✅ 让模型知道多个根与当前根 | Service `systemPrompt` 契约；`working-directory` 实现即范例 |
| `system-prompt/assemble` waterfall | 可整体重写 assembly（含 contexts） | ✅（但必须保留别人贡献；`有风险`） | Event 契约；working-directory `:48-65` |
| `agent/pre-step` / `agent/inject` | 每步前注入提醒/校验收敛 | ✅ 强迫模型带根前缀/纠正相对路径 | Event 契约 |
| `fs/write-intent` / `fs/edit-intent` / `fs/observed` | 只能给**意图/版本**，target 已定 | ❌ 不能换 target；只能做路径策略记录 | Event 契约；`@deepseek-ai/dsh-fs-observation-policy` 全文（`:85-95`）是插件级 fs 策略先例 |
| `ctx.tools.register` 在 **`agent.ctx`** 注册**同名工具** | **shadow 全局工具**（同层重复才报错） | ✅ 唯一能改变「相对谁解析」的正规插件手段（代价：重实现） | Service `tools.register`：“Scoped tools shadow globals; duplicates within one layer … fail” |
| 自算 `sandboxPolicy` 传给 `fs.writeText`/`shell.execute` | 任意根可写（§8.5） | ✅ 执行层多根 | 见下 |
| 替换 Service（`workingDirectory`/`sandboxPolicy`/`fs`/`shell`） | ❌ **不是插件 API** | — | `%M%\@deepseek-ai\cordis\lib\index.js:813`（重复 provide 抛错）、`:786-787`（`ctx.set` 只能提供方 fiber 调用）；`dsh-shell` 注释 `:55-59` |
| `ctx.isolate(name, label)` | 在子域提供**另一个**同名服务实例，只影响该域消费者 | ⚠️ 只对自己的工具/插件有效；内置工具在根域，看不到 | `%M%\@deepseek-ai\cordis\lib\index.js:1723-1727`；composition reference 的 `isolate` 行字段说明 |
| composition patch 行覆盖 | `id` 命中已有行即替换字段，可 `disabled: true`，再 `insert` 自己的 provider | ⚠️ 等于替换出厂组合（版本强耦合，需实测优先级） | `cordis-composition-reference` skill 的 Loader patch 方言；"A patch with an `id` and no `insert` targets the existing row… Supplied fields replace the row's fields" |
| 新增会话事件类型持久化根清单 | ❌ 会被拒绝重开 | — | practices.md:21 |

### 8.5 为什么「执行层多根」能纯插件做到

- `fs`：`writeText(target, content, intent, signal, sandboxPolicy)` 的第 5 参就是**调用方传入**的策略；`SandboxedFileSystem.checkedTarget(target, sandboxPolicy)` 只看这个对象（`%M%\@deepseek-ai\dsh-fs-sandbox\lib\index.js:125-127,153-166`）。插件自带工具把 `workspaceRoot` 填成根 B，则 `writableRoots(policy)` 含根 B（`%M%\@deepseek-ai\dsh-sandbox\lib\index.js:166-173`），写根 B 通过。
- `shell`：`SandboxPwshExecutor.resolve()` 优先用 `request.sandboxPolicy`（`%M%\@deepseek-ai\dsh-pwsh-sandbox\lib\index.js:145-150`），`execute()` 用 `spec.sandboxPolicy` 围栏（`:151-205`）；Windows ACL 会为「新 root + sessionId」现场建 grant（`%M%\@deepseek-ai\dsh-sandbox-local\lib\index.js:396-444`）。插件自带 pwsh 工具即可在根 B 下执行可写命令。
- 读与搜索本来就不围栏（`fs-sandbox:73-76`；`tool-fs-search` 直接 spawn ripgrep）。

### 8.6 风险（必须写进设计文档）

1. **policy 自报 = 信任边界在工具里**：任何插件都能给 `writeText`/`shell.execute` 传 `mode: 'danger-full-access'` 或任意 `workspaceRoot`。多根插件若要「尊重会话的 workspace-write」，必须自己实现根白名单，不能指望 provider 兜底。
2. **shadow 同名工具会与上游演进脱钩**：schema、`presentCall/presentResult`、`presentationMeta` 卡片、`fs/observed` 协议、`sandbox_permissions` + `justification` 升级流、`[sandbox: …]` 拒绝标记、`job`/background 语义都要复制；升级 DSH 后容易漂移。
3. **权限预设/审批按工具名匹配**（`dsh-permission-presets`）与 PTC 呈现可能按名字找工具；shadow 后语义变化需复核。
4. **会话日志只记录一次 cwd**：多根清单若只在 storage，会与 session 日志脱钩（fork/resume 后需要重新解析/对账；投影缓存不覆盖它）。
5. **`grep/glob/terminal` 不受围栏**意味着「多根」虽然可行，但沙箱承诺与文件工具不一致（既有问题，不是多根引入；多根设计会放大它）。

## 9. 结论表（层 → 现状 → 是否硬编码 → 插件手段 → 风险）

| 层 | 现状机制 | 单根是硬编码还是可注入 | 插件可用改造手段 | 判定 / 风险 |
| --- | --- | --- | --- | --- |
| `session.header.cwd` | 创建时写入，不可变；resume/复用要求字符串相等 | **硬编码**（`ApiSessionCwdConflict`） | 无（只能一会话一根，或绕过这套 API 自建） | **必须改本体**（`dsh-api-session-controller:421,442`） |
| `workingDirectory` | 单字符串投影 + `working-directory/change` + prompt 行 | 值可变、**形状硬编码**；`defaultDirectory` 可注入 | `set()` 切换唯一 cwd；自有 storage 存多根但服务不认 | **必须改本体** 才能一等公民多根 |
| system prompt（cwd 行 / file policy 行） | 各包注册一个 context | 文本生成硬编码 | 追加自己的 context；`system-prompt/assemble` 重写；`suppressRuntimeContext()` | **可插件化**（补一行根清单）；替换内置语义需本体 |
| `sandboxPolicy`（resolve） | `workspaceRoot = session.header.cwd`；mode 来自事件 | mode 可注入/可切；**root 单值硬编码** | 用 patch 行替换服务（版本耦合）；`isolate` 只对自己域有效 | **必须改本体**（类型 + resolve） |
| `SandboxExecutionPolicy` | `{mode, workspaceRoot, sessionId?}` | **硬编码单值** | 插件可自造对象（含任意 root/mode）逐次传入 | **必须改本体**（要类型级多根）；`有风险`（自报即越权） |
| `ctx.fs` 围栏（fs-sandbox） | 写/改时按 `writableRoots(policy)` 循环 | 循环已支持多根；策略单根来自调用方 | 装饰/替换 ❌（Cordis 单提供）；插件自带工具传 policy ✅ | **可插件化**（对插件自己的写路径） |
| `ctx.fs` 解析（fs-local） | `resolve(path,{cwd})`，默认 `config.cwd` | base 可配置，但一次一个 | 插件调用时传任意 `cwd` ✅ | **可插件化** |
| sandbox provider（本机 Windows ACL） | 按 `workspaceRoot` 的 SID + 每 session root 私有 temp 授权 | 单 root 授权（多根需多 SID/grant） | 无 | **必须改本体**（若要求「服务端权威多根」） |
| 内置工具 `read/write/edit` | `workingDirectory.ensure` 单 cwd；写策略自解 | 参数里没有 root/workdir | shadow 同名工具 ✅（重实现）；pre/execute 改参数 ❌ | **必须改本体**（内置） / **可插件化**（自有工具） |
| 内置工具 `grep/glob` | 单 workdir、单 `path`、无围栏 | 硬编码单根 | shadow 同名工具 ✅；`rg` 本身支持多根 | **可插件化**（重实现） |
| `pwsh` / `ctx.shell` | `workdir` 可绝对；policy 由调用方给 | workdir 已支持；root 单值 | shadow `pwsh` + 自算 policy ✅ | **可插件化**（重实现） |
| `working_directory` 工具 | 切唯一 cwd | 硬编码 | shadow 或新增工具 | **可插件化**（重实现） |
| `terminal_*` | `cwd` 任意绝对；无 sandboxPolicy | cwd 可注入；无围栏 | 直接用即可跨根 | 现成可跨根；`有风险`（无围栏） |
| worktrees | 新 checkout 建在原根内 + 切 cwd | 不扩根 | 不可改造成跨根 | 不是先例；跨根场景不适用 |
| 工作区注册表 / UI / `@` 引用 / 文件树 / diff | 单 `path` 概念 | — | 见 task-2 | **必须改本体**（task-2 定） |

## 10. 建议路线

### 路线 A：纯插件 MVP（不改本体，代价是重实现）

1. 新 bundle `dsh-multi-root`（Host 半）：
   - `Config` 声明默认根清单；每个会话的根清单存 `storageDomain`/`storage-json`（**不能**用新 session 事件类型）。
   - `agent/created` 里在 `agent.ctx` 上：`systemPrompt.context` 追加「Workspace roots: [...] / active root: ...」；注册同名工具 shadow（`read`/`write`/`edit`/`glob`/`grep`/`pwsh`，按需加 `working_directory`）。
   - 工具内部：`ctx.fs.resolve(path, { cwd: activeRoot })`；写时 `sandboxPolicy = {...ctx.sandboxPolicy.resolve({session}), workspaceRoot: chooseRoot(path)}`；`pwsh` 传 `workdir` + 同款 policy；保留 `fs/write-intent`、`FS_STALE_VERSION`、`sandbox_permissions` 升级与 `[sandbox: …]` 标记的等价语义。
   - 路径→根的判定规则（绝对路径落在哪根 / 相对路径归属）必须自己定义并写进 prompt。
2. 验收要点：写第二个根内的文件成功；`workspace-write` 下写根外仍被拒；`cd` 与 policy 不一致时的行为要显式定义。
3. 代价：6 个工具重实现 + 卡片/渲染/并发/超时/后台作业语义；会话日志仍单根。

### 路线 B：本体改造（要真正「Cursor 式」体验时的最小改动集）

| 包 | 要改什么 |
| --- | --- |
| `@deepseek-ai/dsh-sandbox` | `SandboxExecutionPolicy.workspaceRoot: string` → 多根（如 `workspaceRoots: readonly string[]`）；`writableRoots()` 相应多根；升级流仍只改 mode |
| `@deepseek-ai/dsh-sandbox-policy` | 会话多根的事件/投影（新增 log-only 事件 + projection）；`resolve()` 返回多根；`renderPolicyContext` 渲染多根 |
| `@deepseek-ai/dsh-fs-sandbox` | 只需跟随新类型（循环已具备） |
| `@deepseek-ai/dsh-sandbox-local` | bwrap/Landlock/Seatbelt 逐根 grant；Windows ACL 多 SID / 多 grant + temp 键改多根；清理语义 |
| `@deepseek-ai/dsh-tool-fs` / `-fs-search` / `-pwsh` / `-working-directory` | 路径到根的解析（`root` 参数或根前缀寻址）、默认根、错误文案；`working_directory` 支持切根 |
| `@deepseek-ai/dsh-working-directory` | 多根模型 + 当前根 + prompt 行（或新增 `workspaces` 服务） |
| `@deepseek-ai/dsh-api-session-controller` | 会话 ↔ 根集合（替代 `header.cwd` 字符串相等校验） |
| `@deepseek-ai/dsh-workspace*` / `dsh-api-workspace-*` / `dsh-file-reference-local` | 工作区多 `path`、文件树/`@` 引用/变更 diff 多根（细节见 task-2） |

## 11. 未确认 / 未实测

- worktree 在「`header.cwd` 为仓库子目录」时是否真的被 ACL 拒绝：**代码推断，未实测**（依据 `sandbox-local:357-444` + `sandbox-policy:145`）。
- profile patch 层能否成功 `disabled` 掉 `include:sandbox-policy` 等出厂行并让新 provider 生效：**patch 方言允许，但未在本 profile 实测**。
- `include:fs-observation-policy` 在 `Config.listConfigs` 里显示 `absent`，但读前写守卫确实生效（系统提示与 `fs/write-intent` 行为可见）——它可能由 agent preset 作用域加载，**未确认**其确切装配位置。
- `dsh-workspace` / `workspaceRegistry` 的 `Workspace` 具体字段与 `workspaceFiles` 的 scope 类型：留给 task-2 给原文。
