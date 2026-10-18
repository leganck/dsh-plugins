# 插件式多根 · Client 半契约与页面/通道方案

> 只读调研 + 设计。写入范围：仅本文件。
> 安装版本：`@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.2**。行号口径：
> - `nmod:` = `…\DeepSeek Harness\resources\app.asar\dsh\node_modules\`
> - `skill:` = `nmod:@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\`
> - Host 契约（服务方法/类型原文）一律来自本轮 `cordis_inspect_query(platform="host", provider="Service", …)`。

---

## 0. 取证边界（先说哪些是"未确认"）

| 手段 | 本轮结果 |
|---|---|
| `read` 读 asar 内文件 | ✅ 可用（唯一可用方式） |
| Host `Service.listService` | ✅ settings / typert / webServer / directoryPickerController / directoryPicker / workspaceFiles 全部取到契约原文 |
| **Client `Slots.listSubTree`** | ❌ **本轮 2 次 10s 超时**（`settings.section` root、全量）；`Builtin.listBuiltins` 也超时 1 次。**Client 侧 live Slot 目录本轮不可用** |
| `pwsh`/`glob`/`grep` 读 asar | ❌ 全部 `os error 3`，无法全仓检索 → 下文 slot 结论全部来自**源码注册点**（有 file:line），不是 inspect 快照 |

因此：凡是"这个 slot 存在/字段是什么"，一律给**真实包的 `ctx.slots.register(...)` 原文行号**；没有源码证据的一律标 **未确认**。

**本轮新增的三条关键结论（后面各节展开）**

1. **零自定义通道能到的位置比上一版报告（`analysis/B-client-ui.md`）以为的更远**：设置整页 + 根 CRUD + 读写自己的 Config + 任意目录**选择/浏览** + **按绝对路径读文件**，全部不需要写任何 Remote。
2. **但"列文件"这一格没有任何零成本解**：`workspaceFiles.list` 被限制在会话 `workspaceRoot` 内，`directoryPicker.list` 只给 `{name, path, hidden}` 的目录条目。→ 右栏多根树必须自带通道。
3. **Client 半写配置不需要 `@deepseek-ai/dsh-client-ui-primitives`**：`ctx.configForms.get(entryId)` 返回的是**普通服务对象**（`set/unset/mutate/subscribe`），可以配手写 `<input>` 用；只有官方包用的 `SettingsFormModel` / `SettingsValueField` 是 primitives 的东西（第三方不能用）。这条把 L0 的成本从"必须抄表单组件"降到"写几个受控 input"。

---

## 1. Client 插件骨架：`window.__ModuleLoader__.load({ id, factory })` 的精确约定

### 1.1 契约原文

`skill:references\ui-plugin.md:9`

```
The browser artifact registers a lazy factory whose id equals the package name.
React comes from the browser module table; no duplicate React installation, CDN
script, or UMD search is needed. For compiled sources, use the deployment's
Client build tooling to emit this format; declare non-baseline runtime imports in
`dsh.client.external`.
```

`skill:references\ui-plugin.md:3`

```
… its `package.json` adds a `dsh.client` section (`platform`, `immediately`, `inject`)
and a `./client` export beside the bundle patch.
```

模板（**可以直接抄的最小形状**）`skill:templates\decoration\client.js:1-22`：

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() { /* … */ }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

真实包对照（编译产物，形状等价）`nmod:@deepseek-ai\dsh-client-ui-settings-general\lib\client.js:1-3,1321-1324`：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-settings-general",
  factory: (require) => {
    …
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

### 1.2 结论

| 项 | 结论 | 依据 |
|---|---|---|
| `id` | **必须严格等于包名**（loader 用它做模块 key，与 `dsh.client` 清单对齐） | ui-plugin.md:9；每个真实包 id ≡ package name |
| `factory(require)` 返回值 | 一个带 `inject` + `apply` 的**模块对象**；返回字面量或 `module.exports` 均可 | 模板 :13-20 vs settings-general :1321-1324 |
| `inject` | cordis fiber 的**服务依赖数组**（字符串键，形如 `"slots"` / `"remote.workspaceFiles"`） | ui-plugin.md:3；settings-general :1063-1072；sidebar-files :934-941（引 B 报告） |
| `apply(ctx)` | 注册入口；**所有注册必须在 `ctx.effect(...)` 或 `ctx.slots.inject(...)` 里**，返回值即清理函数 | ui-plugin.md:13；practices.md:36 |
| `require` 能拿到什么 | 浏览器模块表：`react`、`react/jsx-runtime`、`react-dom`、`zod`…（`nmod:@deepseek-ai\dsh-api-remotes\lib\client.js:7` 就 `require("zod")`） | —— |
| **不能** require 什么 | **任何 `@deepseek-ai/dsh-client-*` 包**（含 primitives / store / slots） | **practices.md:35 原文**：`Do not require('@deepseek-ai/dsh-client-ui-primitives') or load any other Harness Client package as a module; dsh.client.inject entries only order activation and stay allowed.` |
| `dsh.client.inject` | 只做**激活顺序**，不等于可 require；可安全写 `["@deepseek-ai/dsh-client-ui-sidebar-right"]` 之类 | 同上 |
| 样式 | 只能用 `--dsw-alias-*`（`--dsh-*` 尺寸/滚动条变量可读）；类名自带前缀，照抄官方组件 CSS 时**必须改名** | practices.md:34-35 |

`package.json` 的 `dsh.client` 段（模板 `skill:templates\decoration\package.json:6-20`）：

```json
{
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

真实包的 `dsh.client` 对照：`nmod:@deepseek-ai\dsh-api-remotes\package.json:33-41`（`inject:["@deepseek-ai/dsh-api-gateway"]`、`platform:"web"`、`immediately:true`）、`nmod:@deepseek-ai\dsh-client-ui-plugin-manager\package.json:37-47`（`platform:"web"` 无 `immediately`）。

> 另注意 `plugin-manager` 的 `exports`（:16-36）里有 **`"./typert"`（host 面）与 `"./remote"`（client 面，`lib/typert.remote-client.js`）** 两个高级导出——这就是 §3.a 讨论的 codegen 产物位置。第三方插件**不需要**这两个导出也能跑。

### 1.3 slot props 到底从哪来（最容易踩坑的一节）

`ctx.slots.register(options, Component)` 的 options 字段（全部有真实用例）：

| 字段 | 含义 | 真实用例 |
|---|---|---|
| `name` | 目标 slot 名（必填） | 所有 |
| `id` | list 型 slot 的条目 id | `settings.section` id `"plugins"`（settings-plugins :203） |
| `key` | **keyed 型** slot 的键（右栏 tab 体必须等于 tab 类型 id） | sidebar-files :1005 `key: FILES_ID` |
| `order` | list 排序 | settings-plugins :204 `order: 15` |
| `label` | nav/卡片文案（`() => t(...)`，惰性） | settings-general :1297；settings-shell :186 |
| `locale` | 该条目的字典命名空间，决定组件收到的 `t` | 全部 |
| `store` | 组件 `useStore` 读的 store 句柄 | sidebar-files :1007 |
| `inject` | **返回面（face）**：函数 → 其返回值逐项变成组件 props | settings-shell :188 `inject: () => ({hooks:{…}, …form.actions()})` |
| `children` | 本条目往下再开的子 slot 声明（`{name: {kind, scope}}`） | settings-general :1299-1302；sidebar-files :1009-1012 |

组件 props = **父 slot 声明的 inject 面** ∪ **自己 `inject()` 的返回** ∪ **框架标准 props**。证据：

- 只取 `renderSlot`：`nmod:@deepseek-ai\dsh-client-ui-settings-general\lib\client.js:635`
  ```js
  function GeneralSection({ renderSlot }) {
    return jsx("div", { className: …, children: renderSlot("settings.general.item", {}) });
  }
  ```
- 一大串（含 hooks/store/actions/sessionId/useSessions）：`nmod:@deepseek-ai\dsh-client-ui-settings-files …sidebar-files\lib\client.js:595`
  ```js
  function FilesBody({ useTabInfo, sessionId, useSessions, useStore, actions, start,
                        refresh, setAutoRefresh, toggle, t, renderSlot }) { … }
  ```

**`hooks` 从哪来**：父 slot 在 `children` 声明里写 `inject: { hooks: { tabInfo: tabInfoFactory } }`（sidebar-right :4929-4937），于是 tab 体拿到 `props.useTabInfo`。

**`t` 从哪来**：`ctx.locale.bind(NS)`（apply 里）+ 注册时 `locale: NS` → 组件 props 里就是 `t`。字典注册：`ctx.effect(() => ctx.locale.register(NS, { zh, en }), "…")`（settings-shell :172-175）。

---

## 2. `settings.section` 页面 + 只靠 Host Config 能到什么程度（L0 核心）

### 2.1 注册契约

**声明**（kind/scope）：`settings.section` 是 `list / root`，由 settings-general 在注册 `sidebar.settings` 时通过 `children` 声明——`nmod:@deepseek-ai\dsh-client-ui-settings-general\lib\client.js:1258-1261`

```js
"settings.section": { kind: "list", scope: "root" },
```

**注册**（真实整页用例）：同一文件 `:1293-1303`

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "general",
  order: 0,
  label: () => t("general.nav"),
  locale: NS,
  children: { "settings.general.item": { kind: "list", scope: "root" } }
}, GeneralSection));
```

第二个整页用例（"插件"页）：`nmod:@deepseek-ai\dsh-client-ui-settings-plugins\lib\client.js:201-212`（`id:"plugins"`, `order:15`, `children:{"settings.plugins.tab":{kind:"list",scope:"root"}}`）。

**左栏怎么渲染**：`settings-general`（`SettingsPanel`）:305-317 + 1138-1162

```js
rows = ctx.slots.entries("settings.section").map((e) => ({
  id: e.options.id ?? "",
  order: e.options.order ?? 0,
  label: resolveSlotLabel(e.options.label) ?? "",
})).sort((a, b) => a.order - b.order);          // :1145-1150
…
rows.map((row) => button({ className: …navCell, children: [navIcon(row.id), span(row.label)] }))  // :305-317
```

**页面组件收到的 props**：同一文件 `:335-338`

```js
jsx("div", { className: SettingsRoot_module_css_default.options,
  children: active !== void 0 && renderSlot("settings.section", { close: onClose }, { only: active }) })
```

→ **`props.close()`** 可关设置框；其余是常规 slot props（`t`、`renderSlot`、你 `inject()` 的 `hooks/actions`）。

**结论**

| 问题 | 结论 |
|---|---|
| 注册选项 | `{ name, id, order?, label?, locale, inject?, children? }`；**没有 icon 字段** |
| 图标 | `navIcon(id)` 只认 5 个内置 id（`account`/`models`/`agent-presets`/`plugins`/`archived-sessions`），**其它一律齿轮**（`:244-269`）→ 插件页只能得到齿轮图标；想自定义图标只能在页内自己画 |
| 多页并存 | 是；`settings.section` 是 list，任何插件都能加一条 |
| 「整页」而不是「一张卡」 | ✅ 已确认；`plugins.item` 才是"卡" |

### 2.2 读写插件自己的配置：`ctx.configForms`（不需要 primitives）

**服务契约**（源码）：`nmod:@deepseek-ai\dsh-client-ui-settings\lib\client.js:1245-1335`

```js
var ConfigForms = class extends Service {
  /** @param entryId Unique Host plugin entry id. */
  get(entryId) {                       // :1294-1301
    … new ConfigFormController(this.owner, { namespace: entryId }, this.mirror, this.schema);
  }
  describe() { return this.mirror; }   // :1287-1289  （跨命名空间只读面：schema 自省/已服务清单）
  whileServed(namespaces, register) {  // :1315-1334  （Host 服务了该 ns 才挂页面）
    const served = new Set(this.mirror.getSnapshot().view?.namespaces.map((v) => v.ns) ?? []);
    …
  }
};
```

**单个命名空间表单控制器**（公开方法齐全，且**不依赖 primitives**）：同文件 `:1121-1199`

```js
getSnapshot()                              // { status, value, base, user, revision, writable }
subscribe(listener)                        // 返回取消订阅
set(field, value)                          // 单字段写入        → mutate([{op:'set', path:[field], value}])
unset(field)                               // 单字段清除
mutate(ops, expectedRevision?)             // 原子多字段写入
async dispose()
// 底层落到：this.ctx.remote.settings.mutate(namespace, ops, revision)   :1170
```

**Host 侧契约原文**（本轮 inspect `settings`）：

```ts
export interface SettingsDescriptor {
    ns: SettingsNamespace; autoGenerate: boolean; schema: unknown; value: unknown;
    revision: number; base?: unknown; user?: unknown; applies: 'live';
    secrets?: RedactedSecret[];
}
// describe(options?) / update(ns, patch, expectedRevision?) /
// replace(ns, section, expectedRevision?) / mutate(ns, ops, expectedRevision?)
// configure(presentation: { auto?: boolean }, owner?): () => void
```

`configure` 的原文描述：**"Register the calling plugin instance's page policy without changing its Config."**，参数 `auto` —— "Automatic-page policy for this instance; `auto` defaults to true."

**真实用法（官方"终端"设置页，含 `whileServed` + `plugins.item`）** `nmod:@deepseek-ai\dsh-client-ui-settings-shell\lib\client.js:161-189`：

```js
const inject = ["slots", "locale", "configForms"];
function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-settings-shell: dictionaries");
  const bash = new ShellCardController(ctx.configForms.get(BASH_NS));   // ← 只靠服务就能拿到表单
  const pwsh = new ShellCardController(ctx.configForms.get(PWSH_NS));
  ctx.effect(() => () => { bash.dispose(); pwsh.dispose(); }, "ui-settings-shell: form subscriptions");
  ctx.effect(() => ctx.configForms.whileServed([BASH_NS, PWSH_NS], (served) =>
    ctx.slots.inject("plugins.item", () => ctx.slots.register({
      name: "plugins.item", id: "shell", order: 40,
      label: () => t("title"), locale: NS,
      inject: () => (served.has("pwsh-sandbox") ? pwsh : bash).inject(),
    }, ShellCard))), "ui-settings-shell: page");
}
```

**关键分裂点（决定了 L0 的成本）**：官方那个 `ShellCardController` 用的是 primitives 里的 `SettingsFormModel` / `settingsNumberField`（`:124`）与 `SettingsForm` / `SettingsValueField`（`:71,76,92`）。第三方插件**不能 require primitives**（practices.md:35）→ **必须自己写受控输入**，但写入用 `ctx.configForms.get(ns).mutate(...)` 就够了，**不需要**官方的表单机。

手写等价的骨架（可直接用）：

```js
function RootRow({ useForm, update, t }) {
  const snap = useForm((s) => s);                       // 来自 inject: () => ({ hooks: { form: controller.storeBinding } })
  // snap.value.roots / snap.revision / snap.writable
  const save = (roots) => update([{ op: "set", path: ["roots"], value: roots }]);
  return h("div", { className: "mr_row" }, /* 手写 input/button，token 见 §6 */);
}
```

> 注意 `mutate` 的 `ops.path` 是**命名空间内相对路径**（`["roots"]`、`["roots", 0, "label"]` 之类），Host 端 `SettingsPathOp = {op:'set', path: readonly string[], value} | {op:'unset', path}`，**unset 一个数组下标即删除该元素**（inspect 原文："unsetting an array index removes its element"）——根列表的"删除第 N 个根"可以用它。

### 2.3 「自动生成的设置表单」到底自动到什么程度（重要，别被 `autoGenerate` 误导）

- Host 确实给每个有 Config schema 的插件条目生成一个 `SettingsDescriptor`，带 `autoGenerate: boolean` 与 `schema`。
- **但 UI 侧没有任何"看到 schema 就自动画表单"的通用渲染器**。本轮读到的唯一配置渲染入口是两个 slot：
  - `plugins.bundle.config` / `plugins.row.config` / `plugins.item` 三张账本 —— `nmod:@deepseek-ai\dsh-client-ui-plugin-manager\lib\client.js:30-34`，key 形如 `` `${bundle}#${rowId}` ``（`:27-29`）
  - 页面渲染：`:2961-2965` `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })`；"配置"入口按钮只在账本里有这个 key 时才出现（`:2414-2420`）
- `settings-plugins` 的注释把这件事说得最直白（`lib\client.js:150-158`）：

  ```
  The configuration pages of the host-plane plugins live in their own companion
  packages, which register into the Plugins page; this section owns the Settings
  navigation entry and the tab chrome only.
  ```

**结论（L0 的准确边界）**

| L0 能交付 | 依据 |
|---|---|
| 一个完整的"工作空间根"设置页（`settings.section`，独立左栏条目） | §2.1 |
| 根列表增删改查 + primary 标记 + 校验错误回显 | §2.2（`configForms.get(ns).mutate`） |
| 配置存进插件自己的 Config（`cordis.patch.yml`），**升级不丢** | practices.md:22；`SettingsDescriptor.applies:'live'` |
| "添加根"用系统原生选择框 / 内置目录浏览器 | `remote.directoryPicker.pick()` / `.list()`（§3.c） |
| 目录树（**只有目录**） | `remote.directoryPicker.list(path)` |
| 按**绝对路径**读文件内容 / 打开文件预览 | `remote.workspaceFiles.read/stat`（允许越根）+ `tab.actions.openResource`（§4） |
| 只读部署下正确禁用 | `SettingsDescriptor` 的 `writable`（mirror view 级，`ConfigFormController:1213-1219`） |

| L0 **做不到** | 原因 |
|---|---|
| 列出第 2..N 个根里的**文件** | `workspaceFiles.list` 被限制在会话 `workspaceRoot`（inspect 原文 + §3.c 表） |
| 监听（自动刷新）第 2..N 个根 | `workspaceFiles.changes` 同样限根，越界抛 `RemoteError` |
| 在会话里显示"这次改的是哪个根"的**行内**提示 | 需要 `tool.call.toolview` 之类另外的 slot（低成本，另计） |
| 零 Client 代码就出现配置表单 | **未确认**：`autoGenerate` 的 UI 消费方本轮没逐行定位；但 §2.3 三处证据都指向"必须由某个 client 注册槽贡献 UI"。**验证方法（5 分钟）**：装一个只有 Host Config、无 client 半的插件，打开"插件"页看是否出现"配置"入口 |

---

## 3. 需要自定义数据通道时的三条路

### 3.a `./typert` / `ctx.typert.register()` + `ctx.remote.$mount(contribution)`

#### Host 半（两条，任选）

**(1) 包导出 `./typert`，自动注册**（`nmod:@deepseek-ai\dsh-typert-loader\lib\index.js`）

```
:6-18   When a loader entry mounts, this plugin resolves the entry's package.json;
        a package exporting `./typert` has its host face imported and its
        `TYPERT` manifest registered into `ctx.typert`, and the registration is
        withdrawn when the entry unmounts.
:27-29  Manual `ctx.typert.register()` remains available for contributions that
        do not use a `./typert` artifact (hand-written wire schemas, tests,
        non-loader compositions).
:39-40  const TYPERT_HOST_EXPORT = "./typert";
:78-119 validateTypertManifest(): manifest.package === pkgName；face === "host"；
        schemas[].name + create()；model.services/events/objects 需 key/exportName/
        members/types；invocations[] 逐项
```

**(2) 手工 `ctx.typert.register(contribution)`（推荐给插件）** —— Host 契约原文（本轮 inspect `typert`）：

```ts
register(contribution: TypertContribution): TypertDisposer   // () => Promise<void>

export interface TypertContribution {
    readonly package: string;
    readonly face: TypertFace;
    readonly schemas: readonly TypertSchemaFactory[];
    readonly model: TypertPackageModel;        // { services, events, objects }
    readonly invocations: readonly InvocationDescriptor[];
}
export interface InvocationDescriptor {
    readonly id: string;
    readonly service: string;        // 提供方法的 Host 服务键，如 "multiRoot"
    readonly namespace: string;      // 线上命名空间，如 "multiRoot"
    readonly method: string;         // 如 "listFiles"
    readonly implementation?: string;
    readonly mode?: 'stream';
    readonly invocation: { readonly kind: 'direct' } | { readonly kind: 'context'; … };
    readonly scope?: { readonly context: string; readonly wire: string };
    readonly parameters: readonly InvocationParameterDescriptor[];   // left 见下
    readonly uplink?: { readonly codec: TypertCodec };
    readonly cancellation?: { readonly parameter: 'signal' };
    readonly result: TypertCodec;
    readonly description?: string;
    readonly sourceLocation?: InvocationSourceLocation;
}
export interface InvocationParameterDescriptor {
    readonly name: string; readonly description?: string; readonly wire: string;
    readonly source: 'json' | 'lookup'; readonly lookup?: string;
    readonly codec: TypertCodec; readonly acceptsUndefined?: true;
}
export type TypertCodec<Value = unknown> = TypertRemoteValue<Value> & {
    readonly mode: 'strict';
    readonly typeSymbol: string;
    readonly decode?: (value: unknown) => unknown;
    readonly encode?: (value: unknown, writeBytes: (bytes: Uint8Array, path: readonly (string|number)[]) => null) => unknown;
} | { readonly mode: 'src-json' };          // ← 只带 mode，没有别的字段
```

`TypertRemoteValue` = `{ create: () => TypertSchema; description?; jsonSchema?; jsonSchemaError? }`，`TypertSchema` 只有 `parse(value)`。

> `{ mode: 'src-json' }` 是唯一一个**免 zod 工厂**的 codec 分支，看起来正是给"手写 contribution"留的后门。它的确切语义**未确认**（没有实现可读），**这是 §3.a 最值得先花 30 分钟验证的一点**：如果它表示"沿用实现方 JSON schema / 不做严格编解码"，那 L2 的通道成本会从"2–4 人日"掉到"0.5–1 人日"。

#### Client 半（这是唯一有行号的公开用法）

`nmod:@deepseek-ai\dsh-api-remotes\lib\client.js`

```
:7         let zod = require("zod");                       // ← 浏览器模块表里有 zod
:8-20      createTypertRemoteInfo(spec, zod) → new RemoteInfo(spec, zod)   （region 注释：
           ../../typert/protocol/lib/types/remote-info.js）
:21-82     class RemoteInfo { get package() / get descriptors() / get methods() }
:23137-23634  const TYPERT_REMOTE = createTypertRemoteInfo({ package: "@deepseek-ai/dsh-api-workspace-files",
              methods: { "workspaceFiles/list": { … }, … } }, zod.z);
:23639     const inject = ["remote"];
:23645-23683  for (const contribution of [ … ]) disposers.push(await ctx.remote.$mount(contribution));
```

**一个真实 method 对象的完整形状**（`workspaceFiles/list`，`:23194-23286`，可直接照抄改写）：

```js
"workspaceFiles/list": {
  service: "workspaceFiles",
  description: "List the direct children of one directory inside the Session's workspace.",
  invocation: { kind: "direct" },
  parameters: [
    { name: "workspaceFileScope", wire: "workspaceFileScopeId",
      description: "header-derived workspace root for the Session identity on the wire.",
      source: "lookup", lookup: "workspaceFileScope",
      codec:       { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
                     create: …, jsonSchema: { type: "string" } },
      strictCodec: { mode: "strict", typeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
                     create: …, jsonSchema: { type: "string" } } },
    { name: "path", description: "workspace path, absolute or relative to the workspace root.",
      source: "json",
      codec:       { mode: "strict", typeSymbol: "…#workspaceFiles/list:path", create: …, jsonSchema: { type: "string" } },
      strictCodec: { … } }
  ],
  cancellation: { parameter: "signal" },
  result: {
    mode: "strict",
    typeSymbol: "@deepseek-ai/dsh-api-workspace-files/types#WorkspaceDirectoryListing",
    create: …,
    description: "the directory's children in the backend's stable name order, bounded by the entry cap.",
    jsonSchema: { type: "object", properties: { … }, required: ["path","entries","truncated"],
                  additionalProperties: true }
  },
  sourceLocation: { file: "packages/api/workspace-files/src/index.ts", line: 304, column: 9 }
}
```

注意这里 `parameters[].codec` **与** `strictCodec` 成对出现；但 host 契约里 `InvocationParameterDescriptor` 只有一个 `codec` —— 说明 `strictCodec` 是**客户端生成的产物**（`createTypertRemoteInfo` 只读 `parameter.codec` / `parameter.strictCodec`，`:97-99`）。

#### 结论 / 代码量 / 风险

| 项 | 结论 |
|---|---|
| 可行性 | Host 侧**可行且有类型契约**（`ctx.typert.register` 是公开方法，[keep] 装了 `./typert` 的包会被自动注册）；Client 侧 `$mount` 是公开 API（api-remotes 就这么用） |
| 一个方法的最小面 | 1 个 Host 服务（`ctx.reflect.provide("multiRoot", impl)` 或 `super(ctx,"multiRoot")`）+ 1 个 `InvocationDescriptor` + 2 个参数 codec + 1 个 result codec + Client 1 个 `methods` 对象 + `$mount` |
| codegen | **没有随包发布**（ui-plugin.md:9 只说"用部署自带的 Client 构建工具产出这个格式"）→ 必须手写 |
| 风险 1 | `createTypertRemoteInfo` 来自 `@deepseek-ai/dsh-typert-protocol`（region 注释 `../../typert/protocol/lib/types/remote-info.js`），**它是否在浏览器模块表里未确认**。若不：`RemoteInfo` 的对外面只有 `package`/`descriptors`/`methods` 三个 getter（`:29-37`），可手写等价对象；但 `$mount` 是否做品牌/instanceof 校验**未确认** |
| 风险 2 | result `jsonSchema` 对 `Uint8Array` 之类会退化（`jsonSchemaError`，`:23552`）→ 只传 JSON 数据就绕开了 |
| 风险 3 | 与上游 codegen 格式耦合；DSH 升级若改 `RemoteInfo` 契约会断（private API 边界） |
| 代码量 | **2–4 人日**（单方法面：list + stat；含调试）。若 `{mode:"src-json"}` 可用 → **0.5–1 人日** |

---

### 3.b Host 半 `ctx.webServer.register(route)` + Client `fetch`

**Host 契约原文**（本轮 inspect `webServer`）：

```ts
export interface WebRoute {
    kind: WebRouteKind;                 // 'exact' | 'prefix'
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
register(route: WebRoute): () => void;          // 重复 (kind,path) 抛错
getOrigin(): string;                            // 例如 http://127.0.0.1:3080
registerFallback(handler): () => void;          // 已被 SPA dist server 占用（唯一）
tapIndex(transform: (html:string)=>string): () => void;
```

**结论**

| 项 | 结论 |
|---|---|
| 可行性 | ✅ 可行且简单：Host 半 `ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/multiroot/", handler }), "…")`；Client 半 `fetch("/multiroot/list?root=" + encodeURIComponent(abs))` |
| URL | **页面与路由同源**（SPA 由同一个 `webServer` 的 fallback 提供），Client 用相对路径即可；`getOrigin()` 是给"本机其他客户端"用的，页面里不必用 |
| 鉴权 | ⚠️ **`register(route)` 的签名里没有任何鉴权/访问控制参数**；Remote 层的 access-control（`dsh-api-remote-access` 这个包的 `access` 概念）**不覆盖自定义路由**。→ 插件必须自己：①只做只读、②路径白名单（根集合内）、③拒绝 `..` 与 UNC/盘符越界，④不要把 `secret`/token 放 URL |
| 校验 | 没有 schema 校验、没有类型；二进制/流式要自己处理 |
| 生命周期 | `register` 返回 disposer，**必须放进 `ctx.effect`**；否则插件卸载后路由悬空 |
| 官方口径 | practices.md:33 只禁止"Host 出 HTML 页 + iframe 嵌入"，**JSON 路由不在禁止之列**；但这是"逃生通道"而非常规面 |
| 代码量 | **0.5–1 人日** + 安全自查 0.5 人日 |
| 推荐度 | **中**：适合"只在插件自己的面板里读目录"这种内部小面；不要用它替代 Remote 做写操作（写操作要走既有 `fs` 围栏语义，那套只在 Host 插件内可用） |

示例（Host 半，只读列目录）：

```js
// index.js（Host）
export const inject = ["webServer"];
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix", path: "/multiroot/",
    async handler(req, res) {
      const url = new URL(req.url, "http://x");
      if (url.pathname !== "/multiroot/list") { res.writeHead(404).end(); return; }
      const dir = url.searchParams.get("dir") ?? "";
      if (!inRoots(dir)) { res.writeHead(403).end(JSON.stringify({ code: "outside-root" })); return; }
      const entries = await ctx.fs.listDir(dir);                 // 读侧无围栏（A/B 报告 §2.4）
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ entries: entries.map((e) => ({ name: e.name, type: e.kind })) }));
    },
  }), "multiroot: list route");
}
```

---

### 3.c 直接复用现有 `remote.*`：能力边界（**这一节决定了 L0/L1 的上限**）

Host 契约原文（本轮 inspect；三处互证）：

| Remote | 签名要点 | 能否越出会话 `workspaceRoot` |
|---|---|---|
| `workspaceFiles.read(scope, path, range, signal)` | path 原文：**"absolute path or path relative to the workspace root; files outside it are allowed."** | ✅ **允许** |
| `workspaceFiles.stat(scope, path, signal)` | 同上，"files outside it are allowed" | ✅ **允许** |
| `workspaceFiles.readBytes(scope, path, options, signal)` | 同上（+ `baseFile`） | ✅ 允许 |
| **`workspaceFiles.list(scope, path, signal)`** | 原文："List the direct children of **one directory inside the Session's workspace**." | ❌ **限根** |
| **`workspaceFiles.changes(scope, path, signal)`**（stream） | 原文："directories remain workspace-scoped"；越界抛 `RemoteError` | ❌ 限根 |
| `directoryPicker.pick(signal)` | "Open the host's OS chooser" → 绝对路径或 null | ✅ 任意目录 |
| `directoryPicker.list(path?, signal)` | "List one directory level for a Remote caller's in-app browser" → `DirectoryListing` | ✅ 任意绝对目录 |
| `directoryPicker.createDirectory(path, name)` | 建子目录 | ✅（需权限） |
| `settings.describe/update/replace/mutate` | 只管 Config，不碰文件系统 | — |

`WorkspaceFileScope` 仍是单值（inspect 原文）：

```ts
export interface WorkspaceFileScope { readonly sessionId: SessionId; readonly workspaceRoot: string; }
```

`DirectoryListing`（inspect 原文）：

```ts
export interface DirectoryEntry { name: string; path: string; hidden: boolean; }
export interface DirectoryListing { path: string; home: string; crumbs: DirectoryEntry[]; entries: DirectoryEntry[]; truncated: boolean; }
```

**结论**

1. **"读文件"早就是多根的**（`read`/`stat`/`readBytes` 允许绝对路径越根）→ L0/L1 能"点到哪个文件就开哪个文件"。
2. **"列文件"是唯一的硬缺口**：`list`/`changes` 限根；`directoryPicker.list` 只给 `{name, path, hidden}`，**没有 `type`/`size`**（`DirectoryEntry` 原文），且从名字与用途看是"目录选择器"层（是否会把文件也列出来 = **未确认**，需 30 秒实测：打开"添加根"的浏览面板看有没有文件名）。即便它列了文件，也**拿不到 size/type**，画不出带图标的树。
3 . Client 侧错误码可直接用：`workspace-file/outside-workspace`（真实包已渲染：`nmod:@deepseek-ai\dsh-client-ui-sidebar-files\lib\client.js:486` + 文案 `:751`）。

**代码量**：复用面 0（已有）；把"目录树 + 按路径开文件"接起来 **0.5 人日**。

---

## 4. 右栏 tab：从注册到"点树节点开文件预览"

### 4.1 tab 类型定义

`nmod:@deepseek-ai\dsh-client-ui-sidebar-files\lib\client.js:12-37`

```js
const FILES_KIND = "files";
const FILES_ID = "@deepseek-ai/dsh-client-ui-sidebar-files";
function filesDefinition(t) {
  return {
    id: FILES_ID,                      // 类型身份，同时是 tab 体的 register key
    kind: FILES_KIND,                  // tab 的 kind 字符串
    priority: "builtin",
    title: () => t("type.label"),
    guide: [{ id: "workspace", commandId: "workspace.files", order: 10,
              title: () => t("guide.title"), description: () => t("guide.description"),
              icon: GuideArtworkFiles }],
  };
}
// 注册：ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), "…");   :996
```

最简定义（无 guide）见官方 guide 类型 `nmod:@deepseek-ai\dsh-client-ui-sidebar-right\lib\client.js:4711-4730`：

```js
function guideDefinition(t) {
  return { id: GUIDE_ID, kind: GUIDE_KIND, priority: "builtin", title: () => t("tab.guide.title") };
}
```

**字段结论**：`{ id, kind, priority, title(), guide?[] }`；`guide` 每项 `{ id, commandId, order, title(), description(), icon }`（要复用官方 `GuideArtworkFiles` 之类的图标 → 不可用，因为那是 primitives，得自绘）。

服务来源：`ctx.reflect.provide("sidebarRightTabs", tabs)` / `ctx.reflect.provide("sidebarRight", controller)`（`sidebar-right:4848-4849`）。

### 4.2 面板体与标题注册

`nmod:@deepseek-ai\dsh-client-ui-sidebar-files\lib\client.js:1003-1017`

```js
ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
  name: "sidebar.right.pane.tab",
  key: FILES_ID,                                   // ← keyed slot，key = 类型 id
  locale: NS, store, inject,
  children: { "sidebar.right.tab.files.actions": { kind: "list", scope: "session" } },
}, FilesBody)), "ui-sidebar-files: files tab body");

ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
  name: "sidebar.right.pane.tab.title", key: FILES_ID,
}, FilesTitle)), "ui-sidebar-files: files tab title");
```

slot 声明（父侧）：`sidebar-right:4929-4938` —— `sidebar.right.pane.tab` 与 `.title` 都是 **`keyed / session`**，且声明时 `inject: { hooks: { tabInfo: tabInfoFactory } }`。

**tab 体拿到的 props**（`FilesBody`，:595 + `tabInfo` 形状 :4739-4776）：

```js
function FilesBody({ useTabInfo, sessionId, useSessions, useStore, actions, start,
                     refresh, setAutoRefresh, toggle, t, renderSlot }) { … }

// useTabInfo() 返回（:4749-4763）：
// { sidebar: { expanded, fullscreen },
//   panel:   { id },
//   tab: { ...tab, visible, navigation, signal, actions, refreshShortcut } }
```

`sidebar-right:1186-1191` 的官方注释把边界说清楚：

```
Tab bodies do not live here. Each one is a registration under its type's kind,
dispatched through the keyed `sidebar.right.pane.tab` seat (and a live chip
title through `sidebar.right.pane.tab.title`), so a new tab type needs no edit
to this file. What a body receives beyond the record — navigation, lifetime
signal, actions — is read through the slot-owned useTabInfo hook.
```

### 4.3 从代码打开一个 tab

| 入口 | 签名 / 用法 | 出处 |
|---|---|---|
| `ctx.sidebarRight.openTabFromTarget(kind, target)` | `ctx.sidebarRight.openTabFromTarget("files", ctx.sidebarRight.commandTarget(element))` | sidebar-files:982,990 |
| `ctx.sidebarRight.openTab(kind, options)` | `options = { paneId?, revealIfOpened? }` | sidebar-right:4901-4903, 1216-1219 |
| `ctx.sidebarRight.commandTarget(el)` | 从 DOM 元素推出 `{ sessionId, … }` 目标；`undefined` 表示当前没有会话 | sidebar-files:982-986 |
| slot 内 `openTab` prop | 同 `openTab`，通过 `sidebar.right.pane.tab` 的 inject 面下发 | sidebar-right:4901, 4945-4946 |

> 插件若要"点了某个按钮就在右栏打开多根树"，最稳的是 `ctx.sidebarRight.openTab(kind, { revealIfOpened: true })`；`openTabFromTarget` 需要先拿到 target（从会话头按钮那类 DOM 上下文才有）。

### 4.4 「树节点点击 → 打开文件预览」走什么

**证据链**（全在 `nmod:@deepseek-ai\dsh-client-ui-sidebar-files\lib\client.js`）：

```js
// 1) 地址构造
const FILE_ADDRESS_PREFIX = "dsh-resource://file/";                         // :363
function sessionFileAddress(sessionId, path) {                             // :378-381
  const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
}
function fileAddressFor(sessionId, cwd, path) {                            // :410-417
  const normalized = path.replace(/\\/g, "/");
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== "" && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
  return sessionFileAddress(sessionId, normalized);        // ← 根外的绝对路径：原样塞进 session 地址
}

// 2) 点击 = 交给 owner 的 tabActions
const { signal, actions: tabActions } = tab;               // :604
onOpen: (path) => { tabActions.openResource(fileAddressFor(sessionId, state.root, path)); }  // :649-651
```

`:400-409` 的 JSDoc 明确写了根外绝对路径的处理：

```
The address for a path as a caller holds it: a relative path, or an absolute
path inside the Session's workspace, becomes a `session`-scoped address; an
absolute path outside it, or one whose workspace root is unknown, keeps its
absolute path in that Session's address.
```

`workspaceFiles.stat` 的 `absolutePath` 字段说明（api-remotes client.js:23612）也印证了两种地址形态：

```
… What a `dsh-resource://file/absolute/…` address carries, and what a
`dsh-resource://file/session/<sessionId>/…` address's workspace-relative path
resolves to against that Session's root.
```

**结论**

| 问题 | 结论 |
|---|---|
| 打开文件预览的 API | `tab.actions.openResource(<dsh-resource://file/… 地址>)`（`tab` 来自 `useTabInfo()`） |
| 跨根文件的地址 | `fileAddressFor(sessionId, cwd, "D:/other/root/a.ts")` → `dsh-resource://file/session/<sid>/D:/other/root/a.ts`（`:` 保留，`encodeSegment:365-367`） |
| 端到端能否显示 | **设计上支持**（地址构造 + `read` 越根）；**端到端未实测** → 列为 P0 验证项（10 分钟：在一个会话里 `openResource` 一个根外绝对路径，看 viewer 是否渲染） |
| 其它 tab 能力 | `tab.actions.bindCommands({ refresh: () => … })`（:597-603）让重启快捷键指向你的刷新；`tab.signal` 是生命周期取消信号，**必须**在 async 里传下去 |
| tab 是否按会话 | 是（`keyed/session`）→ 多根树是"每个会话一份"，不共享 |

---

## 5. 「插件式多根」UI 分三档建议

> 量级按"熟练 1 人 / 已有 DSH 插件骨架"估；含 locale、错误态、空态，不含视觉打磨。

### L0 —— 仅设置页（**0 自定义通道**）

```
settings.section  (id:"multiroot", order:20, label:"工作空间根")
└── 手写表单
    ├── 根列表：每行 [label 输入] [path 只读] [只读开关] [设为 primary] [删除]
    ├── "添加根" → remote.directoryPicker.pick()  （原生选择框）
    ├── 保存 → ctx.configForms.get(ROW_ID).mutate([{op:"set",path:["roots"],value:[…]}], revision)
    └── 错误/只读态：snapshot.writable / snapshot.status
```

- **数据来源**：插件自己的 Config（Host 侧 Config schema + `cordis.patch.yml`）；`ctx.configForms.get(ns)` 读写。
- **代码量**：**1.0–1.5 人日**
  - 0.3 页面骨架 + locale
  - 0.5 手写表单（受控 input / 删除 / primary / 校验）
  - 0.2 `directoryPicker.pick` 接线
  - 0.3 空态/只读/错误
- **风险**：低。唯一"看不见"的是 `autoGenerate` 是否会让 Plugins 页也冒出一份（§2.3 未确认项，无害）。
- **交付观感**：设置里能管根，但**对话界面完全看不到多根**。

### L1 —— 设置页 + 目录选择器 + （可选）目录级树（**仍 0 自定义通道**）

```
settings.section
├── 根列表 / 增删 / primary                              （同 L0）
├── 浏览：remote.directoryPicker.list(path) 的面包屑 + 目录列表（只有目录）
└── 每根"打开" → 按绝对路径 remote.workspaceFiles.stat/read 预览首屏

（可选）conversation.input.left：显示"当前默认根" + 快速切换
（可选）tool.call.toolview：给 multi_write/multi_sh 画"根徽标"卡
```

- **数据来源**：`directoryPicker.list`（任意绝对目录）+ `workspaceFiles.read/stat`（越根只读）+ `tab.actions.openResource`。
- **代码量**：**2.0–2.5 人日**（+1.0 若做 toolview 徽标）
- **风险**：
  - ⚠️ `directoryPicker.list` 是否包含**文件**、能否给出 `type` **未确认**（`DirectoryEntry` 只有 `{name,path,hidden}`）→ 若只列目录，L1 的"树"只是**目录导航器**，不是文件树。
  - 无语义化 `icon`/`size`，画不出 `FileTypeIcon` 那种观感（需自绘）。
  - 大量目录时没有 `changes` 流 → 只能手动刷新。

### L2 —— 右栏多根树（**必须自定义通道**）

```
sidebarRightTabs.register({ id:"@local/dsh-multiroot", kind:"multiroot", priority:"builtin", title })
sidebar.right.pane.tab        (key = 你的 id)      → MultiRootBody
sidebar.right.pane.tab.title  (key = 你的 id)      → 标题 + 根数 chip
sidebar.right.tab.multiroot.actions (list/session) → 头部动作（刷新/折叠/加根）
```

```
MultiRootBody
├── 根选择段（primary 高亮；展开态本地 store，按 tab.id 存）
├── RootNode × N
│   └── 目录/文件行（自己画：folder / file 图标用内联 svg + --dsw-alias-* 着色）
├── 点击文件 → tab.actions.openResource(fileAddressFor(sessionId, primaryCwd, absPath))
└── 右键/头部动作 → renderSlot("sidebar.right.tab.multiroot.actions", { absolutePath })
```

三条通道选型（同一 UI，不同数据面）：

| 方案 | 数据来源 | 代码量 | 判定 |
|---|---|---|---|
| **L2-a `ctx.typert.register()` 手写最小面** | Host 服务 `multiRoot.listFiles(root, relPath)` + `stat` | **2–4 人日**（若 `{mode:'src-json'}` 可用：**0.5–1**） | ✅ **推荐**：有类型契约、随插件卸载自动撤销（`TypertDisposer`）、走 Remote 访问控制；代价是手写 codec 与上游格式耦合 |
| **L2-b `webServer.register` + `fetch`** | Host 路由 `/multiroot/list` | **0.5–1 人日** + 0.5 安全 | ⚠️ 兜底：最省事，但**无鉴权/无 schema/无访问控制**，要自己做根白名单；不要用它做写操作 |
| **L2-c 纯复用现有 remote** | `directoryPicker.list` | 0.5 人日 | ❌ 只能得**目录树**，列不出文件（§3.c） |

- **风险（L2 共性）**
  1. `sidebarRightTabs.register` 的**完整校验规则未确认**（本轮没定位到 registry 类；两个真实 definition 的字段已确认）。
  2. tab 体是 `keyed/session`：多根树每会话一份；跨会话共享根集合要靠 Config（而不是 tab store）。
  3. 官方文件树的图标/`PathLabel`/`Tooltip` 都在 primitives 里 → **全部手绘/手写**（practices.md:35），这是 0.5–1 人日的隐性成本。
  4. 与 `@` 引用 / Web 终端 / diff 的单根语义**不会因为你做了树而变**（B 报告 G5/G6/G7 结论不变）→ UI 必须明确告知用户这个边界，否则是"看起来支持多根"的误导。
- **代码量合计**：L2-a **3.5–6 人日**；L2-b **2.0–3.0 人日**；两者都要 +1 人日做"文件树观感 + 空/错态 + 键盘可达"。

### 分档建议（给 Lead 的决策句）

1. **先发 L0**（1–1.5 人日，0 自定义通道，风险最低）：用户能在设置里管根、能选目录、能按路径开文件——这已经把"根从哪来"这件事解决并固化了数据结构。
2. **L1 只在验证 §3.c 的 `directoryPicker.list` 确实只给目录之后再做**——否则它的"树"没有产品价值。
3. **要做真树就选 L2-a**：优先花 30 分钟验证 `{mode:'src-json'}` codec；能通就 0.5–1 人日做出 `multiRoot.listFiles` 一个方法，整档 L2 成本从 5 天级降到 2 天级。验不通再退 L2-b（明确写进文档：这是无鉴权内部路由）。
4. **不要**尝试替换 `sidebar.workspaces` 或原生 `files` tab 类型（B 报告 §4.5 风险 5、`shadows-shipped-ui`）。

---

## 6. Client 半骨架清单（可直接照抄）

### 6.1 文件与导出

```
plugins/dsh-multiroot/
├── package.json            ← 见 6.2
├── cordis.patch.yml        ← 插 Host 行（row id 与 Config schema）
├── index.js                ← Host 半：export const inject / export function apply
├── client.js               ← Client 半（手写，无构建）：window.__ModuleLoader__.load(...)
└── locale/{zh,en}.json     ← 可选（也可在 client.js 里内联字典）
```

```js
// index.js —— Host 半最小形态（模板同形）
export function apply() {}          // 无 Host 逻辑时留空；有 Config 时用 Config 声明 schema
export const inject = [];           // 需要 settings/webServer/typert 时在此声明
```

### 6.2 `package.json` 的 `dsh` 段（照 1.2 抄）

```json
{
  "name": "@local/dsh-multiroot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-ui-settings"]
    }
  }
}
```

> `dsh.client.inject` 只用于**激活顺序**（practices.md:35 原文），不要理解成"可以 require"。

### 6.3 `client.js` 骨架（L0 版：设置整页 + 手写表单 + configForms）

```js
window.__ModuleLoader__.load({
  id: "@local/dsh-multiroot",                     // ← 必须严格等于 package.json 的 name
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "multiroot";                        // 字典命名空间 = 注册时的 locale
    const ENTRY_ID = "multiroot";                  // ← Host 侧 Loader 行 id（cordis.patch.yml 里那一行的 id）
    const zh = { nav: "工作空间根", add: "添加根", remove: "删除", primary: "主根", empty: "还没有根" };
    const en = { nav: "Workspace roots", add: "Add root", remove: "Remove", primary: "Primary", empty: "No roots yet" };

    function Row(props) {
      const { t, root, index, onRemove, onPrimary } = props;
      return h("div", {
        className: "mr_row",
        style: { display: "flex", gap: 8, alignItems: "center", padding: "8px 0",
                 borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
                 color: "var(--dsw-alias-label-primary)" },
      }, [
        h("code", { key: "p", style: { color: "var(--dsw-alias-label-secondary)" } }, root.path),
        root.primary ? h("span", { key: "b", style: { color: "var(--dsw-alias-brand-primary-new-colorprimary-new-color)" } }, t("primary")) : null,
        h("button", { key: "r", type: "button", onClick: () => onRemove(index) }, t("remove")),
      ]);
    }

    function RootsPage(props) {
      const { t, useForm, saveRoots, pick } = props;
      const snap = useForm((s) => s);              // { value, revision, writable, status }
      const roots = (snap.value && snap.value.roots) || [];
      if (!snap.writable) return h("p", { style: { color: "var(--dsw-alias-label-tertiary)" } }, t("readonly"));
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, [
        roots.length === 0 ? h("p", { key: "e", style: { color: "var(--dsw-alias-label-tertiary)" } }, t("empty")) : null,
        ...roots.map((root, i) => h(Row, { key: root.path, t, root, index: i,
          onRemove: (idx) => saveRoots(roots.filter((_, j) => j !== idx)),
          onPrimary: (idx) => saveRoots(roots.map((r, j) => ({ ...r, primary: j === idx }))) })),
        h("button", { key: "a", type: "button", onClick: async () => {
          const path = await pick();               // remote.directoryPicker.pick()
          if (!path || roots.some((r) => r.path === path)) return;
          saveRoots([...roots, { path, label: path.split(/[\\/]/).pop() || path, readonly: false }]);
        } }, t("add")),
      ]);
    }

    return {
      inject: ["slots", "locale", "configForms", "remote", "remote.directoryPicker"],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "multiroot: dictionaries");

        // ---- 配置表单：只靠 configForms 服务，不 require primitives ----
        const form = ctx.configForms.get(ENTRY_ID);            // ConfigFormController
        ctx.effect(() => () => form.dispose(), "multiroot: config form");
        const useForm = (selector) => {                        // 手写最小选择器（避免依赖 dsh-client-store）
          const [value, setValue] = React.useState(() => selector(form.getSnapshot()));
          React.useEffect(() => {
            const off = form.subscribe(() => setValue(selector(form.getSnapshot())));
            return off;
          }, []);
          return value;
        };

        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "multiroot",
          order: 20,
          label: () => t("nav"),
          locale: NS,
          inject: () => ({
            hooks: { form: useForm },
            saveRoots: (roots) => form.mutate([{ op: "set", path: ["roots"], value: roots }]),
            pick: () => ctx.remote.directoryPicker.pick(new AbortController().signal)
              .then((r) => (r.ok ? r.value : null)),
          }),
        }, RootsPage));
      },
    };
  },
});
```

> 三个容易踩的坑（都来自本轮证据）：
> 1. `ctx.configForms.get(ENTRY_ID)` 的 `ENTRY_ID` 是 **Host 侧 Loader 行 id**，不是包名（`settings.describe` 的 `ns` = profile entry id，见 §2.2）。
> 2. `remote.*` 的返回值是 `RemoteResult`（`{ok,value}|{ok:false,error}`），**不是直接值**（`@deepseek-ai/dsh-api-remotes` 的 `RemoteError`/`RemoteResult` 形状见 sidebar-files :39-60）。
> 3. 所有注册都必须在 `ctx.effect(...)` 或 `ctx.slots.inject(...)` 内；`form.dispose()` 也要挂在 effect 上。

### 6.4 slot 注册一览（三档分别需要什么）

| 档 | Slot | 注册选项要点 |
|---|---|---|
| L0 | `settings.section` | `{ id, order, label, locale, inject }`（`children` 可选） |
| L1 | 同上 + `conversation.input.left`（显示当前根） | `{ id, order, locale, inject }` |
| L1+ | `tool.call.toolview` | keyed/session，keyDomain 开放（B 报告 §8 补记） |
| L2 | `sidebarRightTabs.register` + `sidebar.right.pane.tab` / `.title` | 类型 `{id,kind,priority,title,guide?}`；体的 `key` = 类型 id |
| L2 | `sidebar.right.tab.multiroot.actions`（自建 children） | `{ kind:"list", scope:"session" }` |
| 通用 | `shell.overlay` | 模态浮层（`shell.overlay` 已由 workspace 包声明） |

### 6.5 样式与资源注意（全部有出处）

| 注意 | 依据 |
|---|---|
| 只用 `--dsw-alias-*`（`--dsh-*` 只读用）；字面色仅限美术资源 | practices.md:34 |
| 不能 require primitives / client-store / slots / dockkit；要复用的控件**照抄 markup+CSS 并改类名前缀** | practices.md:35 |
| 组件样式可渲染成 React `<style>` 元素，卸载即消失；资源/监听/定时器一律在 `apply` 里用 `ctx.effect`/`ctx.on` 注册并返回清理 | ui-plugin.md:13 |
| 不要替换应用根、不要往 `document.body` 追加第二个应用 | ui-plugin.md:13 |
| 可见文案走 locale 服务（`ctx.locale.register` + `locale: NS`） | ui-plugin.md:13；settings-shell:171-175 |
| 生成的 tab/页面要能"卸载干净"（provider dispose: `controller.tabDomain.dispose()` 等） | sidebar-right:4850-4854 |

---

## 7. 未确认清单（别当结论用）

| # | 项 | 影响 | 建议验证（分钟） |
|---|---|---|---|
| 1 | Client `Slots.listSubTree` / `Builtin.listBuiltins` 本轮**全部超时** | 无 live slot 快照；本文 slot 结论全部来自源码注册点 | 重连页面后再查一次 `Slots.listSubTree(root:"settings.section")`（5） |
| 2 | `SettingsDescriptor.autoGenerate` / `settings.configure({auto})` 的**UI 消费方** | 决定"零 Client 代码能否自动出表单"；本文倾向"不能" | 装一个只有 Host Config 的插件，看"插件"页是否有配置入口（10） |
| 3 | `{ mode: "src-json" }` codec 的确切语义 | **L2 成本 4 人日 vs 0.5 人日的分水岭** | 读 `dsh-typert-protocol` 实现 / 写一个最小 `ctx.typert.register` 试验（30） |
| 4 | `createTypertRemoteInfo`（`@deepseek-ai/dsh-typert-protocol`）**是否在浏览器模块表**；`$mount` 是否做品牌校验 | 决定能不能手写 contribution 对象 | 页面 console 试 `require` 一下（5） |
| 5 | `directoryPicker.list` 是否列出**文件**、能否给类型 | 决定 L1 的树是"目录导航器"还是"文件树" | 打开"添加根"浏览面板看有没有文件名（2） |
| 6 | `sidebarRightTabs.register` 的 registry 校验规则（priority 合法值、kind 冲突、guide 必填性） | L2 注册失败时的排查 | 读 registry 类（本轮未定位到行号）（15） |
| 7 | 跨根绝对路径 `openResource` 端到端是否渲染 | 决定 L0/L1 的"点文件预览"是否成立 | 会话内 open 一个根外路径（10） |
| 8 | `workspaceFiles.read` 在 `workspaceRoot` 外是否有二次校验（"roots 集合"） | 文档说允许，实现未逐行确认 | 沿用 B 报告 §9#2 |

---

## 8. 一句话总结

**L0（0 自定义通道）能交付一个真正可用的"工作空间根"设置页 + 选目录 + 按路径开文件，成本 1–1.5 人日；右栏多根树唯一的硬缺口是"列文件"，最小自定义通道推荐 `ctx.typert.register()` 手写单方法面（先验 `{mode:'src-json'}`），退路是 `webServer.register` 的只读内部路由。**
