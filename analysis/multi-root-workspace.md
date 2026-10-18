# 做一个 Cursor 式「多目录工作空间」DSH 插件：需要改造什么

> 分析对象：DSH 桌面版 `DeepSeek Harness 0.2.1-rc.2`（`resources/app.asar/dsh`），profile `desktop`。
> 结论口径：**「插件今天能做到什么」与「必须改本体什么」分开写**；凡未逐行取证的都标「未确认」。
> 配套证据：本文所有事实都能在本目录的三份报告里找到更细的 `文件:行号`——[A-host-path-sandbox.md](A-host-path-sandbox.md)（Host 路径与沙箱）、[B-client-ui.md](B-client-ui.md)（UI/Remote 面）、[C-plugin-impact.md](C-plugin-impact.md)（本仓插件与打包）。

---

## 0. 一句话结论

DSH 现在的模型是**「一个会话 = 一个目录 = 一条写入权限边界」**，三件事被绑死在一起：`session.header.cwd`（不可变的沙箱根）、`working-directory` 投影（可变的相对路径基准）、`Workspace` 实体（侧栏分组 + 单路径）。

因此「Cursor 式多根」不是加一个 UI，而是**把这三处的一张单值变成集合**：

| 路线 | 改什么 | 工作量 | 能做到什么 |
|---|---|---|---|
| **零改造（今天）** | 把会话开在多个根的**公共父目录** | 0 | 读写都能跨根，但权限过宽、侧栏不分组、`@`/diff 噪声大；**跨盘符（C: + D:）无解** |
| **插件式（不改本体）** | 自建「根注册表」+ 自建带 `root` 参数的工具，按目标根**逐次传沙箱策略** | **5–10 人日**（无树 ≈5，含树 ≈7–10） | 模型能跨根读写、跨根跑命令、跨根索引；UI 只能做成**插件自己的面板**，原生文件树/`@`/Web 终端/diff 保持单根 |
| **本体改造（一等公民）** | `SandboxPolicy` 单根 → 根集合；会话记录根集合；`Workspace.roots[]`；`workspaceFiles`/`fileReferences`/`workspaceChanges`/`terminal` 逐条多根；UI 多根树 | **≈22 人日（4–5 周）**（Windows ACL 是最大块） | Cursor 级体验：多根树、跨根 @、每根一终端、跨根 diff |

**推荐路线**：先做**零改造可用的 M0（配置层，0 天）→ 插件式 MVP（M1，约 1 周，覆盖 90% 实际需求）**；把「本体多根」作为上游提案（M2），插件与本体共用同一份根定义文件，将来平滑上移。

---

## 1. 先对齐术语：DSH 的 "Workspace" 不是 Cursor 的 "workspace"

这是最容易做错方向的地方。

| 概念 | Cursor/VSCode | DSH 现状 | 证据 |
|---|---|---|---|
| workspace | 一个 `.code-workspace` 文件，含 N 个 folder | **侧栏里的会话分组，绑定 1 个目录** | `@deepseek-ai/dsh-workspace`：记录 `{path, title, sessionIds, createdAt, updatedAt}`（`lib/index.js:648-654`）；`attachSession` 要求**会话 header.cwd 规范化后 === workspace.path**（`lib/index.js:111-129`）；`resolveByPath` 精确匹配（`:637-640`） |
| 根 | workspace 里的一个 folder | 不存在「根」这个概念（只有 cwd） | `workingDirectory` 服务只有 `get/ensure/set`，单值（`dsh-working-directory/lib/index.js:76-120`） |
| 权限边界 | 一般按 folder 授权 | **`session.header.cwd`，会话生命周期内不可变** | `sandboxPolicy.resolve()` 用 `session.header.cwd`（`dsh-sandbox-policy/lib/index.js:141-148`） |

所以做插件时**不要**去扩展 `Workspace` 实体（那会牵动存储域迁移和侧栏语义），而是**另立一个「根注册表」**（下文 §4），名字建议避开 `workspace`：`roots` / `multi-root project`。

---

## 2. 现状：单根假设的五个落点（含实测）

### 2.1 五层结构

| 层 | 机制 | 单根落点 | 单根是硬编码吗 |
|---|---|---|---|
| L1 会话状态 | `working-directory` 服务：`working-directory/change` 事件 → `sessionProjections` 投影 `workingDirectory`（`dsh-working-directory/lib/index.js:30-40`），提示词一行 `Current working directory: "<cwd>".`（`:121-123`） | 投影 state 是 `string \| null`；复用会话还要求 `header.cwd` **字符串相等**，否则 `ApiSessionCwdConflict`（`dsh-api-session-controller/lib/index.js:421,442`） | 会话事件类型是封闭集合，**插件不能加新事件类型**（只能改本体） |
| L2 写入权限 | `sandboxPolicy.resolve()` → `SandboxExecutionPolicy { mode, workspaceRoot, sessionId? }`（`dsh-sandbox-policy/lib/index.js:141-148`） | `workspaceRoot = session.header.cwd ?? 配置 fallback` | **单值是类型层面写死的**；但 `resolve` 的结果可由**调用方**逐次替换（见 §2.3），而 Service 本身**不能在运行时被插件替换**（Cordis 同域重复 provide 直接抛错，`ctx.set` 只允许提供方 fiber 调用——A 报告 §8） |
| L3 文件围栏 | `SandboxedFileSystem.checkedTarget()`：`writableRoots(policy)` 只能是「workspaceRoot + 临时目录」（`dsh-fs-sandbox/lib/index.js:153-166`；`dsh-sandbox/lib/index.js:166-173`） | `writableRoots` 返回单根数组 | **一个函数**（改它 = 改整个 workspace-write 语义） |
| L4 进程围栏 | `sandbox.confine(argv, policy)` → Windows ACL / Seatbelt / bwrap / Landlock 各说各话（`dsh-sandbox-local/lib/index.js:305-344`） | Seatbelt 已按 `writableRoots` 循环（`:65-75`）；bwrap/Landlock 只吃 `policy.workspaceRoot`（`:22-52`）；**Windows 是「每 workspace 一个 SID + 一条常驻 ACE」**（`:357-444`） | Windows 需要多 SID/多 ACE，**改动最大** |
| L5 UI 面 | 文件树、`@` 引用、终端、diff 各自取一个 cwd | `WorkspaceFileScope.workspaceRoot: string`；`fileReferences.list(agent,…)` 以 session cwd 为界；`TerminalCreateRequest` 无 `cwd`；`WorkspaceChangesSummary.cwd: string` | 逐条硬编码 |

### 2.2 一个容易误解的点：`working_directory` 改不了权限

`dsh-working-directory` 的 `set()` 注释写得很直白：**"Change one Session's directory without changing existing processes or permissions."**（`lib/index.js:104-112`）。

原因在 `sandboxPolicy.resolve()` 读的是 **`session.header.cwd`**（会话创建时定死），不是可变的 `workingDirectory` 投影。推论：

- `cd` 到别的目录后，**相对路径基准变了、提示词变了，但可写范围没变**。
- 想靠「先 cd 再写」实现多根：**行不通**（这是最容易被浪费掉半天的地方）。
- 想跨根写，原生工具只剩一条路：`sandbox_permissions: danger-full-access` 升级——那是**拆掉围栏**，不是多根支持。

### 2.3 好消息：沙箱策略是「按调用传入」的，不是进程级

两处公开契约都把 policy 当参数：

```ts
// @deepseek-ai/dsh-fs      （dsh-fs-sandbox 同签名）
abstract writeText(target, content, expected?, signal?, sandboxPolicy?: SandboxExecutionPolicy)
abstract editText (target, edit,    expected?, signal?, sandboxPolicy?: SandboxExecutionPolicy)

// @deepseek-ai/dsh-shell
interface ShellExecRequest { command; workdir?; …; sandboxPolicy?: SandboxExecutionPolicy }
```

内置工具自己就是这么用的：`dsh-tool-fs` 的 `FsSandboxController.resolvePolicy()` 每次调用 `this.policy.resolve({session})` 再传给 `fs.writeText`（`dsh-tool-fs/lib/index.js:1134-1156, 1224-1228`）；shell 执行器更直接——`dsh-pwsh-sandbox` 的 `resolve()` 用 `request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`，`execute()` 用 `spec.sandboxPolicy` 去 `confine`（`dsh-pwsh-sandbox/lib/index.js:145-150, 151-205`）。

**推论（整套插件方案的地基）**：插件自己的工具可以传 `{ mode, workspaceRoot: 目标根 }`，围栏会按目标根判越界。这**不是**漏洞——是把「哪个目录是这个操作的工作区」变成调用方参数，和内置工具走的是同一条官方路径；区别只在授权来源（内置=会话，插件=根注册表）。

### 2.4 实测（本机，profile `desktop`，workspace-write）

| 探针 | 结果 | 含义 |
|---|---|---|
| `read` 读工作区外文件（`C:\Users\legan\.dsh\profiles\desktop\cordis.patch.yml`） | ✅ 成功 | 读贯穿 |
| `grep`/`glob` 以工作区外目录为目标 | ✅ 成功 | **搜索工具其实已经是多根的**（绝对路径即可） |
| `pwsh` 读 `D:\Projects` 目录列表 | ✅ 成功 | 进程围栏只禁写 |
| `pwsh` 写 `D:\Projects\_probe.txt` | ❌ `UnauthorizedAccessException` | **shell 写入被单根围栏挡住** |
| `write`/`edit` 写工作区外（代码证据） | ❌ `FS_SANDBOX_DENIED`（`dsh-fs-sandbox/lib/index.js:157-164`） | 文件写入同样被挡 |
| `terminal_open` 指定 `cwd: D:/Projects` 再写文件（代码证据） | ⚠️ 能跨根且**不受围栏**：`terminal_open` 的 `cwd` 参数按 `resolve(cwd, args.cwd)` 处理、绝对路径直通（`dsh-tool-terminal/lib/index.js:300-308`），而 `TerminalSpawnRequest` 不携带 `sandboxPolicy` | **今天就能用的逃生通道**（也是既有安全缺口）；本机 PTY 启动失败，**未实测** |

一句话：**读侧、搜索和终端今天就能跨根；结构化写入（`write`/`edit`）和一次性命令（`pwsh`）不能。** 这决定了插件 MVP 的优先级——先把「结构化写 + 命令」补上；读几乎不用做，终端可以作为 M0 的临时手段。

---

## 3. Cursor 能力 → DSH 缺口矩阵

| # | Cursor 能力 | DSH 现状 | 缺口 | 归属 |
|---|---|---|---|---|
| 1 | `.code-workspace` 文件定义多根 | 无（profile 的 `config.roots` 只有 code-index 自己在用） | 自定义定义文件 + 注册表 | 插件 |
| 2 | 侧栏多根文件树 | 右侧 tab 类型可扩展（`sidebarRightTabs.register` + `sidebar.right.pane.tab`），但树根写死会话 cwd（`dsh-client-ui-sidebar-files/lib/client.js:605,627`） | `workspaceFiles.list` 只允许根内；`WorkspaceFileScope.workspaceRoot` 单值 | **本体 2 天**，或插件自带 Remote（2 天–1 周） |
| 3 | 左栏「每个根一行 + 行内菜单」 | 只有 `sidebar.workspaces.session.*` 三个 session 级 slot | 无 workspace/根行级 slot | **本体 2 天** |
| 4 | 跨根全局搜索 | `grep`/`glob` 传绝对路径即可；`code_index` 已按根建库（每根一库） | 只缺「枚举根 / 跨根融合」 | **插件**（code-index 约 1.0–1.6 人日） |
| 5 | 跨根写入 | 围栏单根 | 新工具 + 按根传 policy | **插件可用**（§4） |
| 6 | 每根一个终端 | **agent 侧已可传 cwd**：`terminal_open` 支持绝对 `cwd`（`dsh-tool-terminal/lib/index.js:300-308`），但 `TerminalSpawnRequest` 无 `sandboxPolicy`（终端本来就不在围栏里）；**Web UI 的 `terminalController.create` 没有 cwd**（`TerminalCreateRequest` 只有 shellPath/cols/rows） | agent 侧几乎为零；Web UI 侧要加 `cwd` 字段 | agent 侧现成 / UI 侧**本体 2 天** |
| 7 | `@` 引用跨根 | `fileReferences.list` 边界 = session cwd | 入参/可注册 provider | **本体 2 天**（插件替换服务=高风险） |
| 8 | 跨根 diff / 变更 | `WorkspaceChangesSummary.cwd` 单值，一次 turn 只快照一个 cwd | 快照按根 + 路径前缀 | **本体 2 天** |
| 9 | 工作空间设置页 | `settings.section`（list，「One settings page per list entry」）与 `plugins.item`（设置卡）都在 | 无（插件可注册整页） | **插件 0.5 天** |
| 10 | 多根持久化进 Workspace 实体 | `Workspace.path` 单值 + attach 校验 cwd 相等 | 存储域升级 + 迁移 | **本体 1 周** |
| 11 | LSP 跨根 | `lsp.query({filePath, workspaceRoot})` **每次查询自带 workspaceRoot** | 上层按文件选根即可 | 插件/本体都轻 |
| 12 | 一次任务跨项目重构 | 提示词只告知一个 cwd | 注入根清单 + 工具带 `root` | **插件** |

> 说明：第 2、4、9 条我做过实测或 live 校验；第 6 条同时有 A 报告的源码证据；第 3、7、8、10 条来自 B 报告的 Host 契约原文，未逐行读实现。

---

## 4. 方案 A：插件式多根（不改本体）

### 4.1 架构

```
.dshworkspace.json （放在主根，随仓库走；或 $DSH_HOME/dsh-workspace/roots.json 兜底）
        │
        ▼
dsh-multiroot (Host 插件)                     dsh-multiroot (Client 插件)
 ├─ 根注册表：解析/校验/别名/primary            ├─ settings.section 页面 或 plugins.item 卡片
 ├─ 提示词注入：根清单 + 路径规则                ├─ 自建右栏 tab（多根树）
 ├─ 工具：multi_read / multi_write /            └─ （可选）main + sidebar.panellist 独立大页
 │        multi_edit / multi_grep / multi_sh /
 │        workspace_roots
 ├─ 每次调用按 root 传 sandboxPolicy  ─────────── 关键：fs.writeText / shell.execute 都接受 policy
 └─ 审计：结果里回显 root + 绝对路径
```

### 4.2 根定义（建议形状）

```json
{
  "version": 1,
  "primary": "app",
  "roots": [
    { "id": "app", "path": "D:/Projects/GolandProjects/dsh-plugins", "label": "DSH 插件" },
    { "id": "oss", "path": "D:/oss/microservice-a", "readonly": false },
    { "id": "docs", "path": "C:/Users/legan/Documents/spec", "readonly": true }
  ]
}
```

约束（都来自实测/代码事实，别省）：

- **`path` 必须绝对且存在**；Windows 上要做 `realpath` + 盘符大小写归一（`dsh-workspace` 的规范就是 realpath 单值去重，`lib/index.js:20-51`）。
- `id` 唯一、不含 `/`；**primary 必须存在**——它是"没写 root 时"的唯一答案，否则模型每次都要猜。
- 定义文件放主根 → 跨机器可复现；但**主根没了就退化为单根**，所以要有 `$DSH_HOME` 兜底副本。
- **不要**把根定义塞进会话事件：新事件类型会让 Session 打不开（DSH 只接受带 `ignorable: true` 的未知事件，而 live `append()` 设不了这个标记）。

### 4.3 工具契约（最省心的写法）

不要新造一套 `read/write` 语义，**只在需要跨根的能力上加 `root` 参数**：

| 工具 | 参数 | 实现要点 |
|---|---|---|
| `workspace_roots` | `action: list\|add\|remove\|use`、`id?`、`path?` | 读写注册表；`use` 只改「默认根」，**不动会话 cwd**（动 cwd 会把会话从侧栏工作区里踢出去，见 §1） |
| `multi_read` | `root?`, `file_path`, `offset?`, `limit?` | `ctx.fs.resolve(path, { cwd: rootPath })`；其实原生 `read` 传绝对路径就行，这个工具主要是给模型省 token |
| `multi_write` | `root?`, `file_path`, `content` | `ctx.fs.writeText(target, content, undefined, signal, { mode: sessionMode, workspaceRoot: root })` |
| `multi_edit` | `root?`, `file_path`, `old_string`, `new_string` | 同上走 `editText`；保留 read-before-write 观察（`fs/observed`） |
| `multi_sh` | `root?`, `command`, `workdir?` | shell 是两段式：`ctx.shell.resolve(request)` → `execute(spec)`；**在 request 里就带** `sandboxPolicy: { mode, workspaceRoot: root }`（`dsh-pwsh-sandbox` 优先用 `request.sandboxPolicy`），别依赖会话默认 |
| `multi_grep` | `roots?[]`, `pattern`, `include?` | 循环 `ctx.fs.listDir` / 复用原生 `grep` 逐根；或直接告诉模型「原生 grep 传绝对路径」——实测可用 |

要点：
- `sessionMode` 用 `ctx.sandboxPolicy.resolve({session}).mode` 取**当前模式**，只替换 `workspaceRoot`——这样 `read-only` 会话仍然是只读，`danger-full-access` 也不会被插件收窄。
- 所有写工具都要 `readonly` 根拒绝 + 越界拒绝（`fs.resolve` 先 canonicalize 再判 containment，别自己做字符串前缀）。
- 结果里回显 `root` 与绝对路径，模型下一轮才不会把两个 `src/index.ts` 搞混。

**为什么是「新增工具名」而不是「改造内置工具」**：`tools/execute` 只允许改 `exec.signal`（call identity 不可变），`tools/pre-execute` 的决策只有 allow/deny/cancel/ask（**不能改写参数**），`ctx.tools.guard()` 只能拒绝（A 报告 §8）。想让内置 `write` 支持 `root`，唯一插件手段是在 `agent.ctx` 注册**同名工具**把它 shadow 掉——但那样要重实现 schema、卡片渲染、`fs/write-intent`/`FS_STALE_VERSION`、`sandbox_permissions` 升级流、`[sandbox: …]` 拒绝标记，与上游版本强耦合。所以 MVP 用**新工具名 + 提示词约束**，shadow 只作为兜底选项（风险见 §8 #13）。

同理，`grep`/`glob` 直接 spawn ripgrep（`dsh-tool-fs-search/lib/index.js:166-207`，**不经过 `ctx.sandbox`**），所以「多根搜索」不需要任何改造：传绝对路径即可。

### 4.4 提示词注入

```js
ctx.systemPrompt.section({
  name: 'multiroot:roots',
  order: ctx.systemPrompt.getSectionOrder('TOOL_READ'), // 落在工具说明附近
  text: () => roots.length <= 1 ? '' : [
    'Workspace roots (alias -> path):',
    ...roots.map(r => `- ${r.id}${r.id===primary?' (primary)':''}: ${r.path}${r.readonly?' [read-only]':''}`),
    'Relative paths resolve against the primary root. To touch another root, call the multi_* tool with root="<alias>". Reading with an absolute path works with the normal read tool.',
  ].join('\n'),
})
```

- 用 `ctx.systemPrompt.section()`（不是 `agent.inject`）：根清单是**稳定**的上下文，进 system prompt 才不会破坏 prompt cache；`agent.inject` 只用于「根集合刚变了」这种一次性通知。
- 不要动 `Current working directory:` 那行（`dsh-working-directory` 会覆盖它，`lib/index.js:48-65` 有 prepend 的 assemble 监听）。

### 4.5 UI（插件今天能做的部分）

用 live 的 Slot 目录（`cordis_inspect_query(client, Slots, listSubTree)`）确认过的挂点：

| 挂点 | kind/scope | 用途 | 备注 |
|---|---|---|---|
| `settings.section` | list / root（"One settings page per list entry"） | **整页**工作空间设置（根列表、增删、设 primary） | 正规路子，比 `plugins.item` 卡片更像 Cursor |
| `settings.general.item` | list / root | 只放一行开关时用 | — |
| `plugins.item` | 卡 | 设置页里的一张卡 | 更轻 |
| `main`（keyed，已占用 key: `conversation`） | keyed / root | 独立「工作空间」大页（管理器视角） | 配 `sidebar.panellist` 的图标进入 |
| `sidebar.panellist` | list / root（"Global panel icons"） | 侧栏图标入口 | 与 `main` 成对使用 |
| `sidebar.right.pane.tab` + `.title` | keyed / session | 右栏**多根文件树 tab** | 需要插件自带 `list` Remote（见下） |
| `tool.call.toolview`（keyed，开放 key） | keyed / session | 给 `multi_write`/`multi_sh` 的调用卡画「根徽标」 | 让用户在对话里看见「这次改的是哪个根」 |
| `conversation.input.left` | list / session | 输入框左侧显示当前默认根 + 快速切换 | 轻量、有效 |

**关键缺口**：右栏树要展开第 2..N 个根，必须自己列目录——

- 原生 `workspaceFiles.list` 的 scope 是 `{ sessionId, workspaceRoot: string }`，`list`/`changes` 被限制在根内（B 报告 §3.2，Host 文档原文 "inside the Session's workspace"）；`read`/`stat` **允许**越根。
- 两条补法：① 本体把 `WorkspaceFileScope` 改成根集合（2 天）；② 插件自带 Host Remote：Host 半用 `ctx.fs.listDir()`（读不设围栏）实现 `multiroot.list`，Client 半 `ctx.remote.$mount(contribution)` 挂进来。②可行但**没有 codegen 随包发布**，contribution 要手写 codec（2 天～1 周，依面大小）。

**不建议**做的：不要去 replace `sidebar.workspaces`（`shadows-shipped-ui`）——那是整套会话浏览/对话框，替换等于 fork 官方 UI，升级必炸。

### 4.6 持久化与会话恢复

| 数据 | 放哪 | 理由 |
|---|---|---|
| 根定义 | 主根 `.dshworkspace.json` + `$DSH_HOME/dsh-workspace/<hash>.json` 兜底 | 不进会话日志；跨机器可复现 |
| 每会话的 primary/启用根 | 插件自管文件（按 `session.id` 键） | 会话事件类型封闭，不能新加；也不该污染 session log |
| 根目录内容 | **不缓存**（或短 TTL） | 文件系统是真相源 |
| 审计（跨根写） | 插件日志文件 + 工具结果回显 | 不进会话日志也能被用户查到 |

会话 fork/resume 时：按主根重新解析定义文件；**解析失败就退化为单根并在提示词里说明**（不要静默）。

### 4.7 权限模型（必须写清楚，否则会被当成后门）

- 插件工具**扩展**了可写范围：原生工具仍受 `header.cwd` 约束，插件工具受「根集合」约束。这是**有意的授权扩张**，等价于「用户显式声明了这个 worker 的信任边界」。
- 因此：根集合只能来自**用户可审计的定义文件/设置页**，不能来自模型输入——`workspace_roots add` 要 `ask` 一次审批（`ctx.approval.request`）或干脆只允许人工维护。
- `read-only` 会话里，插件写工具必须**先看 `resolve({session}).mode`** 再决定是否允许（默认全部拒绝）。
- 不要把 `danger-full-access` 当实现手段。那会同时放开原生工具，用户失去边界。

### 4.8 工作量（不含 UI 打磨）

| 项 | 人日 |
|---|---|
| 根注册表 + 定义文件 + 校验/归一化 | 1.0 |
| `multi_write`/`multi_edit`（含 fs 围栏 + read-before-write 观测） | 1.0 |
| `multi_sh`（shell spec + 围栏 + 工作目录校验） | 0.5 |
| `workspace_roots` + 审批 + 审计 | 0.5 |
| 提示词注入 + 工具描述 + 端到端联调 | 0.5 |
| Client：设置页（`settings.section`） | 0.5 |
| Client：右栏多根树（含自带 Remote 手写 contribution） | 2–5 |
| 测试（围栏负例、跨根、模式保持、恢复） | 1.0 |
| **合计（无树 UI）** | **≈5 人日** |
| **合计（含树 UI，自写 Remote）** | **≈7–10 人日** |

---

## 5. 方案 B：本体改造（一等公民）

如果目标是「Cursor 级」而不是「模型能用」，必须改本体。按依赖顺序：

| # | 包 | 改什么 | 工作量 |
|---|---|---|---|
| 1 | `dsh-sandbox` | `SandboxExecutionPolicy` 增加 `workspaceRoots?: readonly string[]`（保留 `workspaceRoot` 作为兼容）；`writableRoots(policy)` 合并全部根 + 临时目录（`lib/index.js:166-173`） | 0.5 天 |
| 2 | `dsh-fs-sandbox` | **免费**：`checkedTarget` 已经循环 `writableRoots`（`lib/index.js:160-164`） | 0 |
| 3 | `dsh-sandbox-policy` | 根来源改为「会话根集合」；新增 `rootsOf(session)`；Config 支持 `extraRoots`；提示词渲染多根（`:72-83`） | 1 天 |
| 4 | `dsh-working-directory` | 投影 state 从 `string` 升级为 `{ cwd, roots[] }`（`stateVersion` 2 + 迁移）；新增 `working-directory/roots` 事件与 `roots()/setRoots()`；`ensure()` 校验每个根（`:30-47, 76-120`） | 1.5 天 |
| 5 | `dsh-sandbox-local` | Seatbelt 免费（`:65-75` 已循环）；bwrap/Landlock 循环（`:22-52`）；**Windows ACL：每根一条常驻 ACE + 多个 `--write-sid`，`windows-acl-run` 也要改**（`:357-444`） | 0.5 + **2–3 天** |
| 6 | `dsh-tool-fs` / `dsh-tool-fs-search` / `dsh-tool-pwsh` | 逻辑不动（policy 仍来自 `resolve()`）；若要「相对路径可按根解析」，加 `root` 参数 | 0.5 天 |
| 7 | `dsh-api-workspace-files` | `WorkspaceFileScope.roots`，`list`/`changes` 按集合判越界 | 1 天 |
| 8 | `dsh-workspace` + `dsh-api-workspace-controller` | `Workspace` 记录 `roots[]`；`attachSession` 从「cwd === path」改成「cwd ∈ roots」；存储域 version + 迁移 + Remote 契约 | 3–4 天 |
| 9 | `dsh-workspace-changes` | 快照按根录制，`WorkspaceChangesSummary.cwd` → `roots`，diff 路径带根前缀 | 1.5 天 |
| 10 | `dsh-file-reference-local` | `@` 候选遍历全部根 + 前缀显示 | 1 天 |
| 11 | `dsh-api-terminal-controller` | `TerminalCreateRequest.cwd?` + 根集合校验 | 1 天 |
| 12 | `dsh-api-session-controller` | 会话↔根集合关系，替代「`header.cwd` 字符串相等」的 `ApiSessionCwdConflict`（`:421,442`）；`createMinted(cwd)` 要能带根集合 | 1–2 天 |
| 13 | `lsp` | 已带 `workspaceRoot`，只需调用方按文件选根 | 0 |
| 14 | Client：`dsh-client-ui-workspace`（左栏根行/目录流）、`dsh-client-ui-sidebar-files`（多根树）、`dsh-client-ui-sidebar-right`（tab） | 新增 slot + 多根树组件（不能复用 `ui-primitives`，照抄 markup+CSS） | 3–5 天 |
| 15 | 测试 | 围栏负例、runner 多根、replay/fork、UI e2e | 2 天 |

**合计 ≈ 22 人日（4–5 周，1 人）**；其中 Windows ACL（2.5 天）与 `Workspace` 存储迁移（3.5 天）是两块硬骨头。

### 5.1 兼容性/版本风险

- DSH 现在是 `0.2.1-rc.2`，契约仍在动。`SandboxPolicy` 加**可选**字段是运行时兼容的，但类型层面是 breaking：内置工具、`sandbox-local`、`fs-sandbox`、任何第三方 enforcing 插件都要能容忍 `workspaceRoots` 缺失（回退 `[workspaceRoot]`）。
- 会话事件新增 `working-directory/roots` 需考虑旧 reader：**只加可选字段**（复用 `working-directory/change` 的可选 `roots`）比新事件类型安全。
- `Workspace` 记录升级必须做存储域 version bump + 旧记录迁移（`{path}` → `{roots:[path]}`），并且 `resolveByPath` 语义要从「精确匹配」改成「匹配任一成员根」——这会改变侧栏分组行为，需要产品确认。

---

## 6. 推荐路线（分三段落地）

### M0 —— 零改造应急（0 人日，今天可用）

1. 把会话开在**公共父目录**（如 `D:\Projects`）：`workspaceRoot` 变成父目录，读写都能覆盖子项目。
2. 只对「同一盘符下的多个子目录」有效；C:/D: 跨盘无解。
3. 索引侧继续用 `code-index` 的 `roots: ["D:/Projects","D:/oss"]` 白名单（现状就是这么配的，见 profile 补丁层 `cordis.patch.yml:456`）。
4. 临时手段：`terminal_open` 传绝对 `cwd` 可进任意根且**不受围栏**（代码级确认；本机 PTY 启动失败未实测）——能救急，但它是既有安全缺口，别当长期方案。
5. 代价：权限过宽、`@` 候选噪音大、diff 里会混进无关仓库。

### M1 —— 插件式多根（≈5 人日，覆盖 90% 需求）

> 详细实现设计（根定义、工具契约、执行管线、代码骨架、测试计划）见 [plugin-multiroot-design.md](plugin-multiroot-design.md)，配套契约细读见 [design/host-tools-contract.md](design/host-tools-contract.md) 与 [design/client-ui-contract.md](design/client-ui-contract.md)。

1. `roots` 定义文件 + 注册表（§4.2）。
2. `multi_write` / `multi_edit` / `multi_sh` + `workspace_roots`（§4.3）。
3. 提示词注入（§4.4）。
4. `settings.section` 设置页 + 根徽标（`tool.call.toolview`）。
5. code-index 接同一份定义（按 C 报告，≈1.0–1.6 人日）：`roots` 从 string[] 升级为 `{id,path}[]`、修 `path.resolve` 基准、跨根 RRF 融合、删除根清理。
6. **不做**原生树/`@`/终端改造；UI 用插件自己的面板，明确告知用户边界。

### M2 —— 上游提案（≈22 人日 / 4–5 周）

按 §5 的顺序提交；插件在 M2 落地后**改读本体根集合**（定义文件保留，双写过渡），M1 的工具可以退化成薄封装或直接删除。

---

## 7. 验收清单（可直接照做）

| 用例 | 期望 | 对应层 |
|---|---|---|
| 会话 cwd = 根 A，用 `multi_write(root=B)` 写 B 下文件 | 成功，且结果回显 `B:<绝对路径>` | 插件工具 + fs 围栏 |
| 同一会话原生 `write` 写 B 下文件 | 仍被 `FS_SANDBOX_DENIED` 拦住（说明边界没被破坏） | 隔离性 |
| `multi_sh(root=B, "touch x")` | 成功；`pwsh` 原生仍不能在 B 写 | shell 围栏 |
| `read-only` 会话下调用 `multi_write(root=B)` | 拒绝（模式优先） | 模式保持 |
| 定义文件里 `roots[1].path` 不存在 | 启动时明确报错并列出该根，不静默降级 | 校验 |
| 删除定义文件后 resume 会话 | 退化为单根 + 提示词说明，不崩 | 恢复 |
| 两个根下同名文件 `src/index.ts`，`multi_read` 分别读 | 内容不串；结果显示根别名 | 歧义消除 |
| 跨盘（C: + D:） | 插件工具正常；原生工具仍限于 A | 覆盖最痛场景 |
| `workspace_roots add` 一个新根 | 触发一次审批（或按配置禁止） | 授权 |

---

## 8. 风险与坑（含本仓现状债）

| # | 风险 | 说明 |
|---|---|---|
| 1 | **把「插件能写别的根」当成安全边界** | 它不是内核隔离，是插件自定的授权集合。定义文件必须由人维护，模型不能自己加根。 |
| 2 | **试图用 `sandbox_permissions` 让原生工具跨根** | 那只会升到 `danger-full-access`，等于关掉围栏；用户会失去所有边界。 |
| 3 | **去扩展 `Workspace` 实体** | 牵动存储域迁移 + attach 语义；插件阶段不要碰，否则会和官方升级冲突。 |
| 4 | **在会话日志里加新事件类型** | Session 会拒绝重新打开（只接受 `ignorable: true` 的未知事件）。根状态放插件文件。 |
| 5 | **在 main 之外替换 `sidebar.workspaces`** | `shadows-shipped-ui`，等于 fork 官方侧栏。 |
| 6 | code-index 现状 bug：`path.resolve(args.path ?? sessionCwd)` 让**相对 path 落到 `process.cwd()`** 而不是会话 cwd（`plugins/dsh-code-index/index.js:792,958,1088,1193`） | 多根下会被放大成「静默读错根」 |
| 7 | code-index `matrixCache` 全局单条（`lib/search.js:16-29`） | 切换根 = 每次全量重读向量 |
| 8 | code-index `roots` 匹配大小写敏感、无 realpath（`index.js:633`） | 多根误拒/绕过 |
| 9 | 本仓 `verify-install.mjs:134` 断言「注册 4 个工具」而实际 5 个 | 新插件别抄数量断言 |
| 10 | 本仓 `release/` 产物版本落后 `package.json`，`install.ps1` 按文件名倒序挑 tgz | 会装到旧包；改内容必须升版本（否则 `ambiguous-install`） |
| 11 | 根 `install.ps1` 的 `-Plugin` ValidateSet 与 `$plugins` 表硬编码两项（`install.ps1:56-58,71-75`） | 新插件要加条目，否则根入口无效 |
| 12 | 插件 Client 半**不能** `require('@deepseek-ai/dsh-client-ui-primitives')` | 文件树要手写 markup+CSS，只用 `--dsw-alias-*` token |
| 13 | **shadow 同名工具会与上游脱钩** | 要复制 schema、卡片渲染、`fs/write-intent`/`FS_STALE_VERSION`、`sandbox_permissions` 升级流、`[sandbox: …]` 标记、并发/后台语义；升级 DSH 后容易漂移（A 报告 §8.6） |
| 14 | **policy 是调用方自报** | 任何插件都能给 `writeText`/`shell.execute` 传任意 `workspaceRoot` 甚至 `danger-full-access`；多根插件必须自己实现根白名单，不能指望 provider 兜底（A 报告 §8.6） |
| 15 | **`grep`/`glob`/终端不在围栏内** | 多根下这三个的"能写/能读范围"与文件工具不一致——这是既有缺口，多根设计会把它放大，必须在文档里向用户说清 |

---

## 9. 未确认项（别当结论用）

1. `workspaceFiles.list` 的越界判定实现行号：由 Host 文档与客户端错误码 `workspace-file/outside-workspace` 互证，**未逐行读**。
2. `workspaceFiles` 在 `workspaceRoot` 外的 `stat`/`read` 是否会做「根是否在 roots 里」的二次校验：文档说允许，实现未逐行确认。
3. 插件自带 typert contribution 的稳定性：`ctx.remote.$mount` 是公开 API（`dsh-api-remotes` 就这么用），但**没有 codegen 随包发布**，手写 codec 未做端到端验证。
4. Client 侧是否存在 `sessionFileReferences` 服务：Host Service 目录里没有，Client 侧未确认。
5. Windows ACL 多根的 runner 参数扩展面（`windows-acl-run` 是否支持多个 `--write-sid`）：未读该原生 launcher。
6. `terminal_open` 跨根**未实测**：本机 `terminal_open` 报 `PTY shell exited during startup`（可能是受限环境/Bash 后端未就绪），结论来自源码（`dsh-tool-terminal/lib/index.js:300-308` + `TerminalSpawnRequest` 无 policy）。
7. profile patch 层能否成功 `disabled` 掉出厂行（如 `sandbox-policy`）再插自己的 provider：patch 方言允许，本 profile 未实测（A 报告 §11）。

---

## 10. 证据索引

| 主题 | 位置 |
|---|---|
| 会话目录投影/事件/提示词 | `@deepseek-ai/dsh-working-directory/lib/index.js:30-47, 104-123, 134-152` |
| 沙箱策略 resolve（用 `header.cwd`） | `@deepseek-ai/dsh-sandbox-policy/lib/index.js:96-104, 141-148` |
| workspace-write 的根语义（唯一出处） | `@deepseek-ai/dsh-sandbox/lib/index.js:166-173` |
| 文件围栏（读贯穿、写按 policy） | `@deepseek-ai/dsh-fs-sandbox/lib/index.js:74-91, 125-166` |
| 进程围栏各方言 | `@deepseek-ai/dsh-sandbox-local/lib/index.js:22-75, 305-344, 357-444` |
| 工具如何传 policy | `@deepseek-ai/dsh-tool-fs/lib/index.js:171-177, 1134-1156, 1224-1228`；`dsh-pwsh-sandbox/lib/index.js:145-150, 151-205` |
| 内置工具不可透明改参 / 工具 shadow | `tools/execute` 契约（只能改 `exec.signal`）、`PreToolDecision`（无 rewrite）、`ctx.tools.guard`（只能拒）——A 报告 §8 |
| 会话复用要求 cwd 相等 | `@deepseek-ai/dsh-api-session-controller/lib/index.js:421, 442`（`ApiSessionCwdConflict`） |
| 搜索/终端不受围栏 | `dsh-tool-fs-search/lib/index.js:166-207`（直接 spawn ripgrep）；`dsh-tool-terminal/lib/index.js:300-308`（cwd 可绝对，无 policy） |
| worktrees 不是多根先例 | `dsh-experimental-worktree/lib/index.js:259, 287-296, 356-361`（A 报告 §7） |
| Workspace 实体（单 path + attach 校验） | `@deepseek-ai/dsh-workspace/lib/index.js:111-129, 637-654` |
| 文件树根写死会话 cwd | `dsh-client-ui-sidebar-files/lib/client.js:605, 627`（转引自 B 报告） |
| UI 挂点（live 校验） | `cordis_inspect_query(client, Slots, listSubTree)`：`settings.section`、`main`(keyed)、`sidebar.panellist`、`sidebar.right.pane.tab`、`tool.call.toolview` |
| 本仓 code-index / 打包 / 测试 | 见 [C-plugin-impact.md](C-plugin-impact.md) §2–§7 |
| Host 面契约（terminal/fileReferences/changes/workspaceFiles） | 见 [B-client-ui.md](B-client-ui.md) §3 |

> 所有 `@deepseek-ai/*` 路径实际位于安装目录 `…\DeepSeek Harness\resources\app.asar\dsh\node_modules\` 下；只有 `read` 工具能读 asar，`pwsh`/`grep`/`glob` 不行。
