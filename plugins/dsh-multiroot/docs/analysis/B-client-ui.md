# B. Client / Web UI 侧盘点：把「多目录工作空间」做成 Cursor 式侧栏树 / 设置页，能挂什么、缺什么

> 只读调研。目标：回答「UI 侧今天能不能做（不改本体）、缺哪个 hook、每个缺口多大量级」。
> 安装版本：`@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.2**（`...\app.asar\dsh\package.json:4`）。
> 量级统一用三档：**0.5 天 / 2 天 / 1 周**。

---

## 0. 结论速览（先看这张）

| # | 能力 | 插件今天能做吗 | 缺的 hook | 量级 |
|---|---|---|---|---|
| 1 | 右栏新增一个「多根文件树」面板（tab 类型 + 标题 + 体） | **能**（完整 tab 注册链路已公开） | 无（外壳层面） | 0.5 天 |
| 2 | 树里**列出第 2..N 个根**的目录 | **不能**（`workspaceFiles.list` 被限制在会话根内） | Host 面缺「按任意根列目录」 | 本体改 2 天 / 插件自带 Remote 2 天～1 周 |
| 3 | 「添加根」目录选择（浏览 / 原生弹窗） | **能**（`remote.directoryPicker.pick()/list()` 现成） | 无 | 0.5 天 |
| 4 | 设置页 / 设置项里管多根 | **能**（`plugins.item` slot + `ctx.configForms`） | 无（配置项级别） | 0.5 天 |
| 5 | 左栏工作空间列表里「每个根一行 / 行内菜单」 | **不能** | 没有 `workspace.row.*` 类 slot（只有 session 行有 3 个 list slot） | 本体改 2 天 |
| 6 | 多根存进 Workspace 实体（随会话持久化） | **不能** | `Workspace.path: string` 单值，无 roots | 本体改 1 周（存储域 + 迁移 + Remote 兼容） |
| 7 | `@` 文件引用跨根候选 | **不能** | `fileReferences.list()` 以 session cwd 为边界 | 本体改 2 天 / 服务替换式插件 ~1 周（高风险） |
| 8 | 终端按根打开（Cursor 的「每个根一个终端」） | **不能** | `TerminalCreateRequest` 无 `cwd` 字段 | 本体改 2 天 |
| 9 | 变更 diff 覆盖多根 | **不能** | `WorkspaceChangesSummary.cwd` 单个 | 本体改 2 天 |

一句话：**"多根工作空间"的 UI 外壳（面板、设置、选目录、读文件）插件今天就能拼出来；真正卡住的是三个数据面——列目录只有单根、Workspace 实体只有单 path、@/终端/diff 三条链路都以 session cwd 为唯一边界。**

---

## 1. 取证方式与限制（先声明哪些是"未确认"）

| 取证手段 | 结果 |
|---|---|
| `cordis_inspect_query(host, Service / Config)` | ✅ 可用，本文所有 Host 类型原文来自 `Service.listService` 的 `referencedTypes` |
| `cordis_inspect_query(client, Slots / Service, …)` | ❌ **连续 2 次 10s 超时**（`Slots.listSubTree`、`Service.listService`）→ Client 侧 live Slot 全量目录 **未确认** |
| `read` 读 `app.asar` 内文件 | ✅ 唯一可用的 asar 读取方式 |
| `glob` / `grep` / `pwsh` 读 asar | ❌ 全部失败（`os error 3`），因此无法做全仓检索 |
| 包内 `lib/types/**/*.d.ts` | ❌ 安装包里 **未随包发布**（`dsh-workspace/lib/types/*.d.ts`、`lib/types/index.d.ts` 均 not found）；类型原文只能取 Host Inspect 或从 `lib/index.js` 的打包后 JSDoc 读取 |

因此下文 Slot 清单来自**客户端插件源码里真实的 `ctx.slots.register/inject` 调用**（含 file:line），不是 inspect 快照；没有源码证据的挂点一律标 **未确认**。

---

## 2. Client Slots 现状

### 2.1 Slot 机制（源码可证）

挂载方式统一为两段式：

```js
ctx.slots.inject(ownerKey, () => ctx.slots.register({ name, key?, id?, order?, locale, store, inject, children }, Component))
```

- `children` 声明自己往下开哪些子 slot，形如 `{ "sidebar.right.tab.files.actions": { kind: "list", scope: "session" } }`；`kind` 见 `list` / `keyed` / `single` / `chain`，`scope` 见 `session` / `root`。
- 参考文档口径：`ui-plugin.md:11`「follow the selected slot's props and options from `Slots.listSubTree`」；`practices.md:36`「Contribute through slots: `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`」。
- **重要限制**：`practices.md:35` 明确「**不要 `require('@deepseek-ai/dsh-client-ui-primitives')`**，也不要加载任何其他 Harness Client 包」——也就是说 `PathLabel`、`FileTypeIcon`、DockKit、`dsh-client-store` 这些现成组件/库，插件不能复用，只能照抄 markup+CSS 并只用 `--dsw-alias-*` token。**这条直接决定了"像 Cursor 的文件树"是纯手写成本。**

### 2.2 已由源码确认的 slot 清单（UI 相关）

| Slot | kind / scope | 声明者（file:line） | props / inject 摘要 | 对多根的适配度 |
|---|---|---|---|---|
| `rightbar` | 根节点 | `dsh-client-ui-sidebar-right/lib/client.js:4913-4924` | `hooks.views`、`mountView` | 可用但不该占 |
| `rightbar.session` | `single` / `session` | 同上 `:4925-4960` | `hooks.tabInfo`、`openTab`、`splitPane`、`closeTab` | 中 |
| **`sidebar.right.pane.tab`** | `keyed` / `session` | 同上 `:4929-4933` | `hooks.tabInfo`、`store`、`locale`、`inject` | **高：右栏 tab 体的正位** |
| **`sidebar.right.pane.tab.title`** | `keyed` / `session` | 同上 `:4934-4938` | `hooks.tabInfo` | 高（标题/Chip） |
| `sidebar.right.tab.menu.item` | `list` / `session` | 同上 `:4939-4942` | — | 高（tab 右键菜单） |
| `sidebar.right.tab.guide` / `.guide.entry` | `chain` / `keyed` | 同上 `:4979-4988` | `hooks.tabInfo`、`guideEntries` | 中（首页引导卡） |
| `sidebar.right.tab.files.actions` | `list` / `session` | `dsh-client-ui-sidebar-files/lib/client.js:1009-1012` | `{ absolutePath }` | **高：文件树头部的动作位（"加根"按钮可挂这里）** |
| `conversation.session.header.corner` | — | `dsh-client-ui-sidebar-right/lib/client.js:4962-4967` | `hooks.shortcuts` | 中（会话头按钮） |
| **`sidebar.workspaces`** | — | `dsh-client-ui-workspace/lib/client.js:5220-5251` | `hooks.directoryFlow`、`hostInfo`、`workspaceShortcuts`、`createWorkspace` | **高：左栏工作空间树本体** |
| `sidebar.workspaces.directoryFlow` | `single` / `root` | 同上 `:5223-5226` | — | 高（目录流 UI） |
| `sidebar.workspaces.session.menu.item` | `list` / `root` | 同上 `:5227-5234` | `hooks.menuOpenState`、`shortcuts` | 高（session 行菜单项） |
| `sidebar.workspaces.session.row.action` | `list` / `root` | 同上 `:5235-5238` | — | 高（session 行动作） |
| `sidebar.session.row.leading` / `.hover` | `list` / `root` | 同上 `:5239-5246` | — | 中 |
| `conversation.hero.workspace` | — | 同上 `:5328-5336` | `createWorkspace`、`hooks.directoryFlow` | 中（空态选目录） |
| **`shell.overlay`** | — | 同上 `:5305-5327`（另有 `ui-plugin.md:5`） | `inject` 自定义 | **高：模态/浮层通用位** |
| **`plugins.item`** | — | `dsh-client-ui-settings-shell/lib/client.js:182-189` | `label`、`locale`、`inject` | **最高：设置页里的"一张卡"** |

> `Slots.listSubTree` 全量目录（含 `conversation.composer.dock`、`conversation.chat.node` 等）**未确认**，因为 Client Inspect 超时。上表只覆盖"侧栏 / 会话头 / 文件树 / 面板 / 设置页"这条线，正好是本任务范围。

### 2.3 关键结论：插件能不能自己造一个右栏 tab（Cursor 那种树面板）

**能，而且是官方预留的公开扩展点。** 证据链：

1. `dsh-client-ui-sidebar-files` 自己就是一个"外来" tab 类型的完整范例（它也是普通 npm 包，非本体硬编码）：
   - 声明类型：`ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), "ui-sidebar-files: files type")` —— `lib/client.js:996`
   - 类型定义对象：`{ id, kind: "files", priority: "builtin", title: () => t("type.label"), guide: [...] }` —— `:22-37`
   - 注册体：`ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name, key: FILES_ID, locale, store, inject, children }, FilesBody))` —— `:1003-1013`
   - 注册标题：`sidebar.right.pane.tab.title` —— `:1014-1017`
   - 快捷键指向：`ctx.sidebarRight.openTabFromTarget("files", target)` —— `:990`
2. 本体侧源码注释原话（`dsh-client-ui-sidebar-right/lib/client.js:1186-1189`）：
   > "Tab bodies do not live here. Each one is a registration under its type's kind, dispatched through the keyed `sidebar.right.pane.tab` seat … **so a new tab type needs no edit to this file**."
3. 服务由本体 `provide`：`ctx.reflect.provide("sidebarRightTabs", tabs)` / `ctx.reflect.provide("sidebarRight", controller)` —— `:4848-4849`。

→ **外壳成本 0.5 天**（注册类型 + 面板 + 标题 + 一个"添加根"按钮）。

### 2.4 卡点：这个面板拿不到"第二个根"的目录内容

现有文件树的根是**硬编码取会话 cwd**：

```js
// dsh-client-ui-sidebar-files/lib/client.js:605
const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
// :627
if (state !== void 0 || cwd === void 0 || signal.aborted) return;
start(tab.id, cwd, signal);          // 根 = 会话 cwd，一棵树一个根
```

而列目录的 Host 面是单根受限的（见 §3.3），失败码也是现成的：
`"error.outsideWorkspace": "这个目录在工作区之外，侧栏不会读取它。"` —— `:751`（对应 Host 错误 `workspace-file/outside-workspace`，见 `:486`）。

两条可行的补法（量级见 §6）：
- **A. 本体改** `WorkspaceFileScope` 增加 `roots: readonly string[]`（或允许 `workspaceRoot` 为集合），`list`/`changes` 按集合判越界 → 2 天。
- **B. 插件自带 Remote**（Host 半用自己的 `ctx.fs.listDir()` 实现 `multiRoot.list`，Client 半 `ctx.remote.$mount(...)`）→ 2 天（能手写 contribution 时）～1 周（若必须自建 codegen，见 §4）。

### 2.5 设置页：插件今天能加"一张卡"，但"独立整页"未确认

- 设置页的卡片位是 `plugins.item`，真实用法（`dsh-client-ui-settings-shell/lib/client.js:182-189`）：

```js
ctx.configForms.whileServed([BASH_NS, PWSH_NS], (served) =>
  ctx.slots.inject("plugins.item", () => ctx.slots.register({
    name: "plugins.item",
    id: "shell",
    order: 40,
    label: () => t("title"),
    locale: NS,
    inject: () => (served.has("pwsh-sandbox") ? pwsh : bash).inject(),
  }, ShellCard))
)
```

- 表单能力由 `ctx.configForms` 提供（inject 见 `:161-165` 的 `["slots","locale","configForms"]`）：`ctx.configForms.get(ns)`、`whileServed(ns[], cb)`、`SettingsFormModel(scope, [...fields])`、`settingsNumberField(...)`（`:124`）、`.actions()`、`.field()`、`.resetField()`。
- 配置真相源在 Host：`SettingsDescribeMirror` 调 `ctx.remote.settings.describe()`（`dsh-client-ui-settings/lib/client.js:1447`，inject `["remote","remote.settings"]` —— `:1481`）。
- Host 侧任何插件的 **Config schema 会自动变成一个设置表单**：`SettingsDescriptor { ns, autoGenerate, schema, value, revision, base?, user?, applies:'live', secrets? }`，`ns` 就是 profile entry id，且可用 `settings.configure({ auto })` 控制是否自动出页（`settings` 服务 `describe` / `configure` 契约）。

→ **"多根列表"作为插件自己的 Config 项 + 一张 `plugins.item` 卡片，0.5 天可交付**；点"添加根"直接调 `remote.directoryPicker.pick()`。
→ 若要做成 Cursor 那种**左右分栏的独立设置页**（而非"Plugins 页里的一张卡"），需要设置侧栏的 `settings.nav` / `settings.page` 类 slot —— **未确认**（Client Inspect 超时 + 未读 `dsh-client-ui-settings-*` 全部包）。若确无此 slot，则必须改本体（2 天）。

---

## 3. Host 侧给 UI 用的 Remote 面（类型原文）

### 3.1 `workspaceRegistry` / `workspaceController`：**Workspace 只有一个 path**

```ts
export interface Workspace {
    readonly id: WorkspaceId;
    readonly path: string;          // ← 单根，硬事实
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly sessionIds: readonly SessionId[];
    setTitle(title: string): Promise<void>;
    attachSession(sessionId: SessionId): Promise<void>;
    insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>;
    detachSession(sessionId: SessionId): Promise<void>;
    status(): Promise<'ok' | 'missing-dir'>;
}
```

```ts
export interface WorkspaceView {
    readonly workspaceId: WorkspaceId;
    readonly path: string;          // ← 单根
    readonly title: string;
    readonly sessionIds: readonly SessionId[];
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface WorkspaceCreateRequest { readonly path: string; }
export interface WorkspaceCreateValue { readonly workspace: WorkspaceView; readonly created: boolean; }
export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
  | WorkspaceFollowIncrement;
export interface WorkspaceBaseline {
    readonly items: readonly WorkspaceView[];
    readonly archivedSessionIds: readonly SessionId[];
    readonly pinnedSessionIds: readonly SessionId[];
}
```

**语义澄清（很重要）**：DSH 里的 "Workspace" 不是"一个项目/多根目录"，而是**会话分组 + 一个归属目录**（`workspaceRegistry` 描述："durable workspace records with validated session attachment"）。所以「多根」不是给 Workspace 加字段那么简单，它同时牵动 attach 时的 cwd 校验（`dsh-workspace/lib/index.js:20-51` 的 `fullyQualifiedWorkspacePath` / `realpathNormalize` 单值规范化与去重）。

`workspaceController` 全部 Remote 动词：`create / initializeDefault / rename / delete / insertBefore / insertSessionBefore / archiveSession / unarchiveSession / pinSession / unpinSession / follow(stream)` —— **没有一个是关于目录集合的**。

### 3.2 `workspaceFiles`：scope 是**单个** `workspaceRoot`

```ts
export interface WorkspaceFileScope {
    readonly sessionId: SessionId;
    readonly workspaceRoot: string;   // ← 单根
}
export interface WorkspaceDirectoryListing {
    readonly path: string;
    readonly entries: readonly WorkspaceDirectoryEntry[];
    readonly truncated: boolean;
}
export interface WorkspaceDirectoryEntry {
    readonly name: string;
    readonly type: 'file' | 'directory' | 'other';
    readonly size?: number;
}
export interface WorkspaceFileText extends WorkspaceFileStat {
    readonly offset: number; readonly text: string;
    readonly lines: number; readonly eof: boolean;
}
export interface WorkspaceFileStat {
    readonly absolutePath: string; readonly version: string; readonly bytes?: number;
}
```

**关键的不对称（对多根极其重要）**：

| 动词 | 参数说明（Host 原文） | 能否越出 `workspaceRoot` |
|---|---|---|
| `read` | "absolute path or path relative to the workspace root; **files outside it are allowed**" | ✅ 允许 |
| `stat` | 同上，「files outside it are allowed」 | ✅ 允许 |
| `list` | "List the direct children of **one directory inside the Session's workspace**" | ❌ 限制在根内 |
| `changes` | "a directory is outside the workspace" 时抛 `RemoteError` | ❌ 限制在根内 |

→ **读文件早就是多根的，列目录/监听不是。** 这就是"多根树"的唯一硬缺口。
（Client 侧一致：错误码 `workspace-file/outside-workspace` 在 `dsh-client-ui-sidebar-files/lib/client.js:486` 被专门渲染。）

### 3.3 `directoryPickerController`：现成的「任意目录浏览」，但只列目录

```ts
export interface DirectoryEntry { name: string; path: string; hidden: boolean; }
export interface DirectoryListing {
    readonly path: string;
    readonly home: string;
    readonly crumbs: DirectoryEntry[];
    readonly entries: DirectoryEntry[];
    readonly truncated: boolean;
}
```

Remote 动词：`pick(signal) → string | null`（开系统原生选择框）、`list(path|undefined) → DirectoryListing`（undefined = home）、`createDirectory(path, name)`。

→ **"添加一个根"今天插件就能做**（`remote.directoryPicker.pick()` 或自带 `list` 浏览器），0.5 天。
→ 但它 `entries` 只有目录、无 `type`/`size`，**不能当文件树用**。

### 3.4 `fileReferences`：**@ 引用被 session cwd 圈死**

```ts
export interface FileReferenceCandidate {
    path: string;
    kind: 'file' | 'directory';
}
```

方法原文：`abstract list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>`，参数说明 —— `agent`: "target agent **whose session cwd bounds discovery**"。
→ 多根下 `@` 只能出主根的候选；**没有 roots 入参、没有 provider 注册点**（此服务是 abstract 单实现 `dsh-file-reference-local`）。
→ 另：**Host Service 目录里没有 `sessionFileReferences` 这个服务**（`Service.listService` 全量目录已核对，只有 `fileReferences`）。该名字可能存在于 Client 侧，**未确认**。

### 3.5 `workspaceChanges`：diff 的 cwd 是单值

```ts
export interface WorkspaceChangesSummary {
    turn: number;
    cwd: string;                    // ← 单根
    files: WorkspaceChangedFile[];
    total: number; added: number; deleted: number;
    snapshot?: { before: string; after: string };
}
export interface WorkspaceChangedFile {
    path: string; display: string; added: number; deleted: number;
    binary?: true; oversized?: true;
}
```

→ 一次 turn 只快照一个 cwd；第 2..N 个根的改动**不会进 diff**。

### 3.6 终端：`TerminalCreateRequest` 没有 `cwd`

```ts
export interface TerminalCreateRequest {
    readonly shellPath?: string;
    readonly id: WebTerminalId;
    readonly cols: number;
    readonly rows: number;
}
export interface TerminalEnvironment {
    readonly cwd: string;           // ← 来自会话日志的"当前目录"
    readonly maxInputBytes: number; readonly maxBufferedBytes: number;
    readonly maxCols: number; readonly maxRows: number;
    readonly scrollback: number;
}
export interface WebTerminalInfo {
    readonly id: WebTerminalId; readonly title: string;
    readonly shell: TerminalShell; readonly cwd: string;
    readonly cols: number; readonly rows: number;
    readonly state: 'running' | 'exited' | 'failed';
    readonly exitCode: number | null; readonly error?: string;
}
```

`terminalController.environment()` 说明：「Read the Session's **current directory** … retained terminals keep their own process directories」。
→ 建终端时**无法指定根**，只能跟随会话的单一 cwd；Cursor 的"每个根一个终端"必须改本体（加 `cwd` 到 create 请求 + `attachedRoot` 校验）。

---

## 4. 插件 Client 半能否调用 / 定义 Host 自定义 Remote

**能——而且两条路都有源码证据。**

### 4.1 消费已有的命名空间（0 成本）

客户端注入的是"服务键"，形如：

```js
const inject = ["slots","locale","sidebarRightTabs","sidebarRight","remote","remote.workspaceFiles"];  // sidebar-files :934-941
const inject = ["resources","remote","remote.workspaceFiles"];                                        // api-workspace-files :453-457
const inject = ["remote","remote.settings"];                                                          // ui-settings :1481
```

→ 插件 Client 半直接 `ctx.inject(["remote.directoryPicker"], …)` 就能调 `pick/list/createDirectory`；同理 `remote.workspace / remote.workspaceFiles / remote.terminalController / remote.settings`。

### 4.2 定义**自己的** Remote 命名空间

- **Host 半**：任何被 Loader 挂载的包，只要 `package.json` 导出 `"./typert"`，`dsh-typert-loader` 就会自动把它注册进 `ctx.typert`：
  - `const TYPERT_HOST_EXPORT = "./typert";` —— `dsh-typert-loader/lib/index.js:40`
  - 描述原文（`:8-18`）：「When a loader entry mounts, this plugin resolves the entry's package.json; **a package exporting `./typert` has its host face imported and its `TYPERT` manifest registered into `ctx.typert`**, and the registration is withdrawn when the entry unmounts.」
  - 校验要求：`manifest.package === pkgName`、`manifest.face === "host"`、`schemas[]` 每项需 `name` + `create()` 工厂、`model.services/events/objects` 需 `key/exportName/members/types`、`invocations[]` —— `:78-119`。
- **Client 半**：`ctx.remote.$mount(contribution)` 是公开 API。
  - `@deepseek-ai/dsh-api-remotes`（"Remote BFF assembly for application-selected Host capabilities"）的全部内容就是硬编码挂 26 个 contribution：
    ```js
    const inject = ["remote"];                                        // :23639
    async function apply(ctx) { for (const c of [TYPERT_REMOTE$25, …, TYPERT_REMOTE]) disposers.push(await ctx.remote.$mount(c)); }  // :23645-23683
    ```
  - 一个 contribution 的数据形状可见（例：`workspaceFiles/stat` 的 `service / description / invocation / parameters[{name, source:'lookup'|'json', codec, strictCodec}] / cancellation / result{mode,typeSymbol,create,jsonSchema?,decode,encode} / sourceLocation`）—— `:23562-23632`。
- **代价**：**没有随包发布 codegen 工具**（根 package.json 只有 `dsh-typert-protocol` / `-registry` / `-loader`，无 codegen）；`ui-plugin.md:9` 只说"For compiled sources, use **the deployment's Client build tooling** to emit this format"。→ 自己写 contribution **要手写 codec 描述**，2 天（小面）～1 周（面大或要处理二进制/Uint8Array 这类 `jsonSchemaError` 分支，见 `:23552`）。

### 4.3 状态该放哪（正规做法）

| 需求 | 正规做法 | 证据 |
|---|---|---|
| 用户可改的多根列表 | 插件自己的 **Config**（`cordis.patch.yml`），并配 Host 侧 `settings` 自动表单 | `practices.md:22`；`SettingsDescriptor` |
| 自定义设置卡 | `plugins.item` + `ctx.configForms` | settings-shell `:182-189` |
| 会话/全局派生状态 | Host `wire.view` 投影（Client 不自行 fold 会话事件） | `practices.md:38` |
| UI 临时状态 | `ctx.slots.register({ store })`（Slot 标准 exclusive store，每 session 一份） | sidebar-files `:808-925` |
| 业务数据 | **不要**新加 session event type；用 storage 服务 | `practices.md:21` |

---

## 5. 缺口清单（逐条给出"缺哪个 hook"）

| 缺口 | 现象 | 缺的 hook（最小改动） | 归属 |
|---|---|---|---|
| G1 列目录只能单根 | `workspaceFiles.list` 把 path 限制在 `workspaceRoot` 内 → 第二根报 `outside-workspace` | `WorkspaceFileScope` 加 `roots`；`list`/`changes` 按集合判越界 | 本体（或插件自带 Remote 绕过） |
| G2 Workspace 只有一个 path | 无法"一个工作区多个根"，创建时只能 `{ path }` | `WorkspaceCreateRequest { roots: string[] }` + 存储域升级 + `status()` 多根检查 | 本体（含数据迁移） |
| G3 左栏没有 workspace 行 slot | 有 `sidebar.workspaces.session.*` 三个 list slot，**没有** `sidebar.workspaces.row.*` / `workspace.row.menu.item` | 新增 workspace 级 list slot（在 `WorkspaceBrowser` 里开 children） | 本体 |
| G4 树根写死会话 cwd | `useSessions(s => s.byId[sessionId]?.cwd)` | 面板可绕开；但"替换默认文件树根"需要本体给 `files` 类型加"根集合"概念 | 本体 |
| G5 `@` 引用单根 | `fileReferences.list` 以 session cwd 为边界 | 加 `roots` 入参，或把该服务的 provider 变成可注册表 | 本体（服务替换式插件风险高） |
| G6 终端不能选根 | `TerminalCreateRequest` 无 `cwd` | 加 `cwd?: string` + 校验在允许根集合内 | 本体 |
| G7 diff 只有单 cwd | `WorkspaceChangesSummary.cwd: string` | `cwd → roots: string[]` + 录制器多根快照 | 本体 |
| G8 独立设置页 slot | 只有 `plugins.item`（卡），未见 `settings.nav` / `settings.page` | **未确认是否存在**；若无非加 slot | 待确认 / 本体 |
| G9 组件不能复用 | 不能 require `dsh-client-ui-primitives`/`dsh-client-store`/DockKit | 无（设计如此，需照抄 markup+CSS+token） | 成本项，非 hook |

---

## 6. 结论表（UI 能力 → 现状 → 单根限制 → 可插件化？ → 量级）

| UI 能力 | 现状机制 | 单根限制 | 结论 | 量级 |
|---|---|---|---|---|
| 右栏新增「多根」面板（tab 类型 + 体 + 标题 + 快捷键） | `sidebarRightTabs.register` + `sidebar.right.pane.tab(.title)` | 无 | **可插件化** | **0.5 天** |
| 面板内"添加根" | `remote.directoryPicker.pick()/list()` | 无 | **可插件化** | **0.5 天** |
| 面板内展开第 2..N 根目录 | `workspaceFiles.list` 限根 | **有**（`workspace-file/outside-workspace`） | 本体改 `WorkspaceFileScope.roots` → **必须改本体**（2 天）；插件自带 Remote 用 `ctx.fs.listDir` → 2 天～1 周 | **2 天 / 1 周** |
| 树根跟随"当前根"切换 | `cwd` 写死在 `FilesBody` | 有 | 插件自建面板可取自身状态；改默认树 **必须改本体** | **2 天** |
| 设置项（多根列表 / 增删） | Config schema + `plugins.item` + `ctx.configForms` | 无 | **可插件化** | **0.5 天** |
| 独立的"工作空间设置"整页 | 设置页由 Host `settings.describe` 生成 | 无 | 卡片形式可做；**整页 slot 未确认** | **0.5 天 / 待确认** |
| 左栏每个根一行 + 行内菜单 | `sidebar.workspaces.*` 只有 session 级 slot | 无 workspace 行 slot | **必须改本体** | **2 天** |
| 多根持久化进 Workspace | `Workspace.path` 单值 + 存储域 | 有 | **必须改本体**（含迁移） | **1 周** |
| `@` 引用跨根 | `fileReferences.list` 边界 = session cwd | 有 | **必须改本体**；服务替换插件 **有风险** | **2 天 / 1 周** |
| 终端按根打开 | `TerminalCreateRequest` 无 cwd | 有 | **必须改本体** | **2 天** |
| 变更 diff 覆盖多根 | `WorkspaceChangesSummary.cwd` 单值 | 有 | **必须改本体** | **2 天** |
| 点文件打开预览 | `dsh-resource://file/session/<sid>/<path>` 地址 | 读文件**允许越根** | **可插件化**（自己发地址 / 用 `tabActions.openResource`） | **0.5 天** |

### 6.1 建议的最小可行路线（给 Lead 决策用）

1. **第一版（1～1.5 天，纯插件）**：`dsh-workspace-roots` 插件 = 右栏新 tab 类型（多根树外壳）+ `plugins.item` 设置卡 + `directoryPicker` 选根 + 用 `workspaceFiles.stat/read` 读任意绝对路径文件。
   → 交付"Cursor 观感"，但**第二个根只能显示根节点、不能展开**。
2. **第二版（+2 天，仍纯插件）**：插件自带 Host Remote（`multiRoot.list/changes` 基于 `ctx.fs`），补齐展开与监听；代价是手写 typert contribution。
3. **要真正"多根是一等公民"**：必须实现 G1/G2/G5/G6/G7（本体）≈ **2 周**（1 周存储与 Workspace 模型 + 2 天文件面 + 2 天 @/终端/diff + 缓冲）。

---

## 7. 未确认清单（不要当成结论用）

1. **Client slot 全量目录**：`Slots.listSubTree` 两次 10s 超时；上表 slot 全部来自源码 `ctx.slots.register/inject`，可能有其它可挂点未发现。
2. **`sessionFileReferences`**：Host Service 目录中**不存在**该服务；Client 侧同名服务是否存在未确认。
3. **独立设置页 slot**（`settings.nav` / `settings.page` 之类）：未在已读源码中见到，未确认。
4. **`workspaceFiles.list` 的越界判定实现行号**：由服务文档（"inside the Session's workspace"）+ 客户端错误码 `workspace-file/outside-workspace` 两处互证，未逐行读 Host `lib/index.js`。
5. **插件自带 typert contribution 的可行边界**：`$mount` 是公开 API 且 `dsh-api-remotes` 就是这么用的，但**无 codegen 随包发布**，手写 codec 的稳定性未验证。
6. `rightbar` 之外是否还有"底部面板 / 第二侧栏"类容器 slot：未确认。

---

## 8. Lead 补记（live Slot 目录已拿到，修正 §2.5 / §6 的两处「未确认」）

> 取证方式：`cordis_inspect_query(platform="client", provider="Slots", method="listSubTree")` **一次成功**（约 100 个 slot，完整响应已落盘）。B 报告的超时是瞬时故障，不代表该 Inspect 不可用。

| 结论 | 依据（live 目录原文） |
|---|---|
| **独立设置页可以做**：`settings.section` 是 `list/root` slot，purpose = "One settings page per list entry"，注册字段 `{ id, order?, label? }` | 不再是"未确认"；`plugins.item` 只是"设置页里的一张卡"，整页用 `settings.section` |
| **独立大页也可以做**：`main` 是 `keyed/root` slot，"Central panel selected by sidebar entry id"，`keyDomain` 已占用 `conversation`（插件用自己的 key 即可）；配 `sidebar.panellist`（"Global panel icons"）放图标入口 | Cursor 那种"左图标 → 中间大页"的工作空间管理器因此可做，不必占右栏 tab |
| 右栏 tab 体：`sidebar.right.pane.tab` 是 `keyed/session`，"One tab's body, dispatched with the `id` of the type in force for `tab.kind`"；标题 `sidebar.right.pane.tab.title` | 与 B 报告 §2.3 一致 |
| 工具调用卡可定制：`tool.call.toolview` 是 `keyed/session`，keyDomain **开放**（"open: any string the owner dispatches"），已占用的是内置工具名 | 插件可以给 `multi_write`/`multi_sh` 画"根徽标"卡片 |
| 其它可能有用的 seat | `sidebar.workspaces`（session 级子 slot 只有 `.session.*`，**仍无 workspace/根行 slot**——G3 结论不变）、`conversation.hero.workspace`、`conversation.input.left`、`shell.bottom`、`shell.leading`、`workspace.toast` |

**未变的结论**：G1（`workspaceFiles.list` 单根）、G2（`Workspace.path` 单值）、G5/G6/G7（`@`/终端/diff 单根）全部成立——UI 外壳可插件化，数据面仍要本体。
