# C — 本仓现有插件与打包约定：多目录工作空间（multi-root workspace）改造影响面

调研范围：仓库 `D:\Projects\GolandProjects\dsh-plugins`（普通磁盘，read/grep/glob 均可）。
只读调研，未修改任何现有文件、未运行 install/pack/测试脚本。所有结论来自源码阅读，给出 `文件:行号`。

> 重要口径提醒：任务描述里说 code-index 有「四个工具」，**实际注册的是 5 个**（多出 `code_map`）。
> 这条不只是文案问题，已经造成本仓一处**当前就会失败**的验证断言（见 §8）。

---

## 0. 结论速览

| 问题 | 结论 | 依据 |
|---|---|---|
| code-index 的 `roots` 是不是"多根工作空间"？ | **不是。它是白名单（授权边界），不是成员集合（枚举来源）** | `plugins/dsh-code-index/index.js:109,364,454,631-635,1330` |
| code-index 支持多根到什么程度？ | **存储层天然多根**（每根一库），**工具层是单根**（每次调用一个 path） | `lib/indexer.js:55-61`；`index.js:792,958,1088,1193` |
| 不改 code-index 能否接多目录工作空间？ | **能，但降级**：每个工具调用显式传 `path`；无"列根/批量建库/批量状态/删除根"能力 | `index.js` 工具 schema 无 roots 参数 |
| 改造成本（不含 UI） | **≈0.5–1.5 人日**；最大的两块是"跨根结果融合"和"输出里带根前缀"，其余是配置/校验/清理的小改 | §2.8 |
| 新增 `dsh-workspace` 插件 | 骨架可 100% 照抄本仓两个插件（Host 半）+ skill 的 `templates/decoration`（Client 半）；**本仓无 Client 半先例** | §5、§6 |
| 本仓对新插件最大的"坑" | `install.ps1` 的 `-Plugin` ValidateSet 与 `$plugins` 表是**硬编码两项**，必须改；`verify-install.mjs` 里"注册 4 个工具"一类**数量断言**会随工具增减而碎 | `install.ps1:56-58,71-75`；`verify-install.mjs:134` |

---

## 1. dsh-code-index 的 roots：现状机制全景

### 1.1 数据流（config → allowedRoots → 工具入口校验）

```
config.roots（string[]，默认 []）
  └─ normalizeConfig            index.js:364   只校验"必须是数组"
  └─ cfg.allowedRoots = roots.map(path.resolve, ~ 展开)   index.js:454
        └─ assertAllowed(repoRoot)                index.js:631-635
              repoRoot === root || repoRoot.startsWith(root + path.sep)
              └─ 4 个工具入口各调用一次：index.js:794, 960, 1089, 1194
        └─ 写入加载标记 _loaded.json（可审计配置是否真生效） index.js:531
        └─ 加载日志 "roots=N|任意"                       index.js:1330
```

关键细节（全部来自源码，非推测）：

| # | 事实 | 位置 | 对多根的含义 |
|---|---|---|---|
| 1 | `roots` 默认 `[]`，**空数组 = 允许任意路径**（`assertAllowed` 首行直接 return） | `index.js:109`, `index.js:632` | 白名单是"可选加固"，不是"根列表"。多根工作空间不能指望它提供成员信息 |
| 2 | 校验是**前缀匹配 + 大小写敏感**：`repoRoot.startsWith(r + path.sep)` | `index.js:633` | Windows 上 `D:\Code\x` 与 `d:\code\x` 判不相等 → 目录选择器/工作空间持久化若不做大小写归一，会**误拒** |
| 3 | 未做 `realpath`/junction 归一 | 同上 | `D:\Code\web` 与 `D:\Code\link-to-web` 视为两根；反向也可用短名/junction 绕过白名单（安全小缺口） |
| 4 | 校验发生在**开库之前**（注释明确写过理由） | `index.js:959-960` | 保留这条顺序，批量模式要改成"全部根先校验、再逐个开库" |
| 5 | 白名单只作用于 `code_index/_search/_status/_map` 的 `path`；`code_index_deps` 与根无关 | `index.js:1218-1319` | 依赖管理天然全局，不需要多根改造 |
| 6 | `roots` 在 `index.js` 里只出现 6 次：默认值(109)、类型校验(364)、归一化(454)、标记(531)、错误文案(634)、加载日志(1330)；**没有任何"遍历 roots 建库/检索"的代码** | grep `roots` 全仓：`index.js` 6 处，其余文件只在测试/工具脚本里 | 这是"白名单 ≠ 工作空间"最硬的证据 |

### 1.2 每根一库（状态目录）：多根的最大现成红利

`lib/indexer.js:55-61`：

```js
export function indexDbPath(repoRoot, { indexDir, indexDirBase } = {}) {
  if (indexDirBase) {
    const slug = `${basename(repoRoot)}-${sha1(repoRoot).slice(0,8)}`
    return path.join(indexDirBase, slug, 'index.db')     // 每仓库一库
  }
  return path.join(indexDir ?? path.join(repoRoot, '.dsh-index'), 'index.db')
}
```

- bundle 默认 `indexDirBase: ~/.dsh/code-index`（`cordis.patch.yml:13`）→ **每根目录独立一个 SQLite 库，且不落在代码仓库里**（不污染 git status）。
- 反例：`indexDir`（单目录模式，`INSTALL.md:272` 自己写了"多仓库共用一个库，慎用"）——共用库时 `store.setMeta('repo_root', repoRoot)`（`lib/indexer.js:266`）会被后建的根覆盖，状态查询会张冠李戴。**多根场景应直接拒绝 `indexDir`**（加一条配置校验即可）。

### 1.3 已支持多根到什么程度

| 能力 | 现状 | 判定 |
|---|---|---|
| 多根共存（互不干扰的索引库） | ✅ `indexDbPath` 每根一库 | 现成可用 |
| 单根内增量扫描 | ✅ `walkRepo` + `diffFiles`（`lib/scan.js:56-96,103-115`），两级指纹 mtime+size → sha256 | 现成可用，纯函数，按根调用即可 |
| 每根独立 watcher | ✅ `watchers` 以 `repoRoot` 为键（`index.js:874-912`），`sync.watch` 默认关 | 现成可用（注意 N 根 = N 个 `fs.watch(recursive)`） |
| 每根独立切块指纹/嵌入标签/远端命名空间 | ✅ 都写在各自库里（`lib/indexer.js:136-166`，`namespaceFor` `index.js:725-726`） | 现成可用 |
| 枚举根 / 批量建库 / 批量状态 | ❌ 无 | 需新增 |
| 跨根检索与融合 | ❌ `search()` 只吃一个 `store`（`lib/search.js:70-84`） | 需新增 |
| 结果里区分根 | ❌ 命中路径是**仓库相对路径**（`lib/search.js:224`、`store.js` 表结构 `chunks.path`） | 需新增（前缀） |
| 删除/移除一个根的索引 | ❌ `dropIndex` 被 import 但**从未调用**（`index.js:31` vs 全仓无调用点）；`stores` Map 无淘汰、`Store` **没有 close()** | 需新增 |
| 白名单归一化（大小写/realpath） | ❌ 见 §1.1 #2/#3 | 建议新增 |

---

## 2. code-index 接入多目录工作空间要改什么（逐项 + 成本）

### 2.1 config 形状

现状：`roots: string[]`（`index.js:109`，校验 `index.js:364`）。多根工作空间需要**别名**（结果前缀、工具参数、UI 显示都要它），建议：

```yaml
roots:
  - { id: web, path: D:/Code/web }
  - { id: api, path: D:/Code/api, label: 后端 }
```

| 改造点 | 位置 | 内容 | 成本 |
|---|---|---|---|
| 元素形状兼容 | `index.js:364` | 数组元素接受 `string`（视为 `{id: basename, path}`）与 `{id,path}`；非法 id（含 `/`、空、重名）拒绝 | ~20 行 |
| 归一化 | `index.js:454` | 生成 `allowedRoots: [{id, abs}]`，并在 win32 上 `toLowerCase()` 比较、`fs.realpathSync.native` 兜底 | ~15 行 |
| 标记/日志 | `index.js:531,1330` | 标记里记 `[{id,path}]`（不含 token），日志打 `roots=2` | ~5 行 |
| 拒绝共用库 | `normalizeConfig` 尾部 | `indexDir && roots.length > 1` → ConfigError | ~5 行 |

### 2.2 工具参数与"path 相对谁"的歧义（当前就有 bug）

四个读/写工具都是这行（`index.js:792, 958, 1088, 1193`，逐字一致）：

```js
const repoRoot = path.resolve(expandPath(args.path) ?? sessionCwd(exec))
```

- `sessionCwd(exec)` = `exec?.agent?.session?.cwd ?? process.cwd()`（`index.js:612-619`）。
- 于是：**省略 `path` → 会话 cwd；给了相对 `path` → 相对 `process.cwd()`**（宿主进程启动目录），而不是相对会话 cwd。文档写的"省略则用当前会话工作目录"只对"省略"成立。
- 多根下这条歧义会被放大：用户/模型很自然想写 `path: "web/src"`（意为"根 web 下"），实际会被解析到宿主进程目录下的 `web/src`。

建议：改成 `path.resolve(sessionCwd(exec), expandPath(args.path))`，并新增 `root`（别名）参数：`root: "web"` + 可选 `path`（相对该根）。同时**明确拒绝** `root` 与 `path` 冲突。

### 2.3 状态目录 / 每根一库

见 §1.2：存储层无需改。但两处要盯：

1. `stores` Map（`index.js:586,621-629`）以 dbPath 为键、**只增不删、无 close**（`Store` 类 `lib/store.js:62-322` 无 `close()`）。多根（尤其 + UI 反复切换）会持续占用 SQLite 句柄与 WAL 文件。
2. `matrixCache`（`lib/search.js:16-29`）**全局只保留一个矩阵**：键变化就 `matrixCache.clear()`。多根交替查询 = 每次换根都全量重读该根全部向量（几十 MB 级，`allVectors` 走一遍 `select * from vectors`）。**这是多根下最容易被忽略的性能陷阱**，改成 3–5 条的 LRU 即可（~15 行）。

### 2.4 增量扫描与 watcher

- `walkRepo`/`diffFiles` 是纯函数（`lib/scan.js:56,103`），按根循环调用即可，**无需改**。
- `sync.watch` 的 `ensureWatch(repoRoot)`（`index.js:890-912`）按根建 watcher、`ctx.effect` 统一清理（`index.js:913-926`），多根可复用；注意 Windows 上 `fs.watch(recursive)` 对每个根铺一层句柄，10+ 根时建议默认关。

### 2.5 删除仓库的清理（当前是能力空洞）

需要新增一个动作（例如 `code_index action=drop path=<root>`）：

| 要清理的东西 | 现状 |
|---|---|
| 索引库文件 | `indexDbPath(...)` 给出的 `<base>/<slug>/index.db` 目录（含 `-wal`/`-shm`）；`dropIndex(store)`（`lib/indexer.js:299-301`）只清表、不删库 |
| 打开的 Store | `stores.delete(dbPath)` + **需要先给 Store 加 `close()`**（`lib/store.js` 现在没有） |
| watcher | `watchers.get(repoRoot)?.watcher.close()` + `clearTimeout(entry.timer)` |
| 远端命名空间 | `store.getMeta('remote_namespace')` 指向的服务端数据；`lib/remote.js:588` 有 `lineages/:id/adopt`，但**没有 delete 端点** |

成本：~30–50 行（含 `Store.close`、`dropIndex` 接线、watcher 清理）。**删除**在多根 UI 里是高频操作，不做会出现"删了根但索引还在、下次同名根直接命中旧数据"的错觉。

### 2.6 跨根检索与融合（最大工作量）

`search(store, embedder, question, opts)`（`lib/search.js:70-84`）与 `searchFusedRemote`（`lib/search.js:267`）都以单 `store` 为单位，RRF 在函数内部用 `chunk id` 做累加（`lib/search.js:166-177`）。跨根直接复用会**撞 id**（每库自增），因此必须：

1. 每根各跑一次 `search`（或共享一个 embedder 实例，避免 N 次模型会话 —— `embedders` 已有按 kind 记忆化，`index.js:645-704`，可直接复用）；
2. 把每根结果标成 `(rootId, chunkId)` 再二次融合（按排名做 RRF，或先按每根归一化分数）；
3. 重排（`rerank`）只在融合后的候选池上跑一次，否则 N 根各重排一次会让延迟 ×N。

成本：~60–100 行 + 一组新测试。**这是"多根检索好不好用"的核心**，不做的退路是"agent 自己并发调 N 次 code_search"，代价是 token 与延迟。

### 2.7 输出与结构化返回

命中行现在是 `[rank] path:start-end`（`index.js:1061`），`path` 是仓库相对路径（`lib/search.js:224`）。多根下必须变成 `rootId/path` 或同时返回 `{root, path}` 结构化字段；涉及 `code_search`、`code_map`（`index.js:1202-1209`）、`code_index_status`、建库回执（`index.js:834-863`），以及至少 6 处测试断言。

### 2.8 成本小结

| 改造项 | 工作量 | 不做会怎样 |
|---|---|---|
| config 形状（id/path）+ 校验 + 归一化 | 0.3 人日 | 无法引用根别名，只能靠绝对路径 |
| 修 `path.resolve` 基准 + 新增 `root` 参数 | 0.1 人日 | 相对路径静默解析到错误位置 |
| `matrixCache` LRU / `stores` 淘汰 | 0.1 人日 | 多根切换时反复全量读向量 |
| 新增 `code_workspace`（列根/批量建库/批量状态） | 0.3 人日 | 每根一次工具调用，token 与轮次成本高 |
| 跨根融合检索 | 0.3–0.5 人日 | 只能"手挑一个根搜" |
| 删除根的清理（含 `Store.close`） | 0.2 人日 | 删根后脏索引残留 |
| 输出带根前缀 + 测试同步 | 0.2 人日 | 同相对路径两根无法区分 |
| **合计** | **≈1.0–1.6 人日** | 见右 |

---

## 3. 工具签名（5 个）与 Config 默认值

### 3.1 工具 schema（逐字摘要）

| 工具 | 参数（`required`） | 关键行为 | 位置 |
|---|---|---|---|
| `code_index` | `path?`(string,"仓库根目录（绝对路径）。省略则用当前会话工作目录")、`mode?`(`incremental|full`)、`status_only?`(bool)、`max_embed?`(int,默认 0) `[]` | 建库/增量；返回 `repoRoot/dbPath/...` | `index.js:769-868` |
| `code_search` | `query`(**必填**)、`path?`、`top_k?`、`mode?`(`auto|fts|vector`)、`current_file?`、`exclude_current?` | 混合检索；`isConcurrencySafe:()=>true` | `index.js:929-1069` |
| `code_index_status` | `path?`、`scan?`(默认 true) | 覆盖/新鲜度；并发安全 | `index.js:1072-1171` |
| `code_map` | `path?`、`depth?`(默认 2)、`limit?`(默认 24) | 目录地图（无 IPC、纯本地聚合） | `index.js:1174-1215` |
| `code_index_deps` | `action?`(`status|install|prune|repair|remove`)、`group?`(`embed|parser|all`)、`registry?` | 与根无关；只装到自管目录 | `index.js:1218-1319` |

四个与根相关的工具的 `path` 描述都写着"省略则用当前会话工作目录"（`index.js:777,940,1079,1184`），实现见 §2.2。

### 3.2 Config 默认值（多根相关部分）

| 键 | 默认 | 位置 | 多根影响 |
|---|---|---|---|
| `roots` | `[]` | `index.js:109` | 白名单；空 = 任意。多根场景**必须**填，否则白名单形同虚设 |
| `indexDirBase` | `null`（bundle 里写 `~/.dsh/code-index`） | `index.js:106`、`cordis.patch.yml:13` | 每根一库的关键 |
| `indexDir` | `null` | `index.js:108` | 与多根冲突，建议拒绝 |
| `maxFileBytes` | 2 MiB | `index.js:110` | 无关 |
| `windowLines` / `defaultTopK` | 40 / 10 | `index.js:111,191` | 无关 |
| `excludeDirs` / `excludePaths` | `[]` / `[]` | `index.js:116,127` | **全是"仓库相对"语义**（校验还拒绝绝对路径与 `..`：`index.js:318,324-328`）→ 多根下无法"仅排除 B 根的某目录"，除非改成按根分组 |
| `maxEmbedPerRun` | 0 | `index.js:199` | 无关 |
| `rerank` | `off` | `index.js:208` | 无关 |
| `sync.watch` | `false` / 30000 ms | `index.js:236` | 每根一个 watcher |
| `vectorStore` / `remote.*` | `local` / 略 | `index.js:226-227` | 远端命名空间含 `repoIdOf(repoRoot)`（`index.js:726`、`lib/repo.js:50-55`）→ 天然按根隔离 |

**歧义结论**：`path` 语义 = "某个仓库根"，没有"默认根"概念；`excludePaths` 语义 = "相对某个根"但配置层面无根维度。多根接入时，第一件该定的事是**"谁是默认根"**（建议 = 会话 cwd 所属的那个根，或工作空间里 `order: 0` 的根），否则模型每次都要猜。

---

## 4. dsh-memory-archive：cwd 依赖审计

| 关注点 | 现状 | 位置 | 多根判定 |
|---|---|---|---|
| 归档目录 | `archiveDir: '~/.dsh/archive'`；**相对值**用 `resolve(session.header.cwd, …)` | `index.js:70`、`index.js:1112-1116` | ✅ 默认绝对路径 → 多根无影响；⚠️ 若用户配成相对路径，则"哪个根"不确定 → 建议直接把相对值当配置错误 |
| 会话日志根 | `sessionRoot: '$DSH_HOME/sessions'`（`resolve(process.cwd(), …)` 后为绝对） | `index.js:76`、`index.js:556,1153` | ✅ 无影响 |
| 日志定位方式 | `findSessionLog` **扫描 sessions 根下所有 workspace 目录**找 `<sessionId>/session.v4.jsonl.zstd`，注释明确"不去复刻 cwd slug" | `index.js:271-287` | ✅ **多根友好**：不依赖 slug/cwd |
| 关键词噪声（去主机路径） | `keywordNoiseFor` 只用 `[homedir(), session.header.cwd]` | `index.js:535-538`、`index.js:554-570` | ⚠️ 只剔除**主根**路径；其它根的路径片段（如 `D:\Code\api`）不会被剔除，会当成有区分度的关键词进入 INDEX（噪声，不是错误）。多根下建议改为遍历工作空间全部根 |
| 归档归属 | 按 `sessionId` 分目录，**不按根分** | `index.js:1104`、`index.js:1399` | ✅ 合理（会话级记忆）；但"这段归档属于哪个根"无法回答，多根下若想做"按根检索记忆"需新增字段 |
| marker | `resolveMarkerFile`：env > config > 模块同目录，相对值相对**模块目录** | `index.js:1056-1064` | ✅ 与 cwd 无关（注释专门写了这条） |

**结论**：`dsh-memory-archive` **不需要为多根做结构性改造**；唯一建议是把"主页路径噪声"从"单个 cwd"扩展到"工作空间全部根"（~10 行）。

---

## 5. 打包 / 安装约定

### 5.1 `package.json`（本仓两个插件的实际字段对比）

| 字段 | code-index | memory-archive | 新插件建议 |
|---|---|---|---|
| `name` | `@local/dsh-code-index` | `@local/dsh-memory-archive` | `@local/dsh-workspace`（scope `@local/` 是本地私有的标志） |
| `version` | `0.8.4` | `1.2.0` | `0.1.0` 起 |
| `private` / `type` | `true` / `module` | `true` / `module` | 同 |
| `main` | `index.js` | —（走 `exports`） | `index.js` |
| `exports` | `"."` / `"./package.json"` / `"./locale/*.json"` | 同 | 再加 `"./client"` 与 `"./icon"`（见 §5.3） |
| `icon` | `"./icon.svg"`（顶层字段） | 无 | 照 code-index，但**同时**加 `exports["./icon"]`（template 用法） |
| `files` | 白名单：`index.js, lib, tools, cordis.patch.yml, locale/*.json, icon.svg, README.md, INSTALL.md, verify-install.mjs, test*.mjs, model` | 白名单：`index.js, cordis.patch.yml, locale/*.json, README/INSTALL/CHANGELOG/LICENSE, install.ps1, test.mjs, tools/*.mjs` | 用白名单（`npm pack` 只打列出的东西） |
| `dsh` | `{ bundle: { patch: "./cordis.patch.yml" } }` | 同 | 加 `client`（见 §5.3） |
| `peerDependencies` | `@deepseek-ai/cordis ^4.0.4` + `@deepseek-ai/dsh ^0.2.0-rc.2`，均 optional | 无 | 同 code-index（optional 是关键：缺失不阻塞加载） |
| `engines.node` | `^22.19 || >=24`（用了 `node:sqlite`） | `>=20.0.0` | `>=20` 足够 |
| `scripts` | `test` / `prepack` / `postpack` 等 | `test` | 至少 `test` |

### 5.2 `cordis.patch.yml` 结构

两个插件都是**最小 insert 一行**（`plugins/dsh-code-index/cordis.patch.yml:9-13`、`dsh-memory-archive/cordis.patch.yml:3-15`）：

```yaml
- insert:
    - id: code-index                     # 与 export const name 对应
      name: '@local/dsh-code-index'      # 用**包名**，不要写 file:// 路径
      config:
        indexDirBase: ~/.dsh/code-index  # 只放可移植默认值
```

硬规则（三处源码都写了理由）：
1. `name` 用包名 —— bundle 经 `install_bundle` 安装后从 profile 的 `node_modules` 解析（`cordis.patch.yml:3-4`）。
2. **机器/团队相关配置不要进 bundle**：roots、模型目录、索引位置、远端地址应由 profile 用户补丁层按 id 覆盖（`cordis.patch.yml:5-8`；`install.ps1:144-145` 也强调"roots 默认空 = 白名单静默消失"）。
3. 用户补丁层的覆盖条目**替换整份 config**（不是深合并）—— `index.js:564-566` 的注释记录了这个坑（写漏一项就静默失效）。

### 5.3 Client 半入口（本仓无先例，按 skill 模板）

**本仓两个插件都是 Host-only**：没有任何 `dsh.client`、没有 `./client` export、没有 typert 生成物（全仓 grep `client|typert` 只命中"远端 HTTP client"语义）。
多目录工作空间几乎一定要 UI，因此 Client 半必须照 skill 模板写（已核对模板实物，路径在 asar 内，read 工具可读）：

`…\dsh-agent-preset\skills\cordis-plugin-development\templates\decoration\package.json`：

```json
{
  "name": "@local/my-decoration",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js","client.js","cordis.patch.yml","locale/*.json","icon.svg"],
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

`templates/decoration/client.js`（22 行，**手写 JS、无需打包**）：

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',            // id == 包名
  factory(require) {
    const React = require('react')       // React 来自浏览器模块表，不要自己的副本
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Component))
      },
    }
  },
})
```

Host 半对应 `templates/decoration/index.js` 只有 `export function apply() {}`（Client 半负责渲染）。
更完整的 Client 字段（`inject` 依赖别家 Client 包、typert `./remote` 导出）可参考装好的 `@deepseek-ai/dsh-client-product-analytics` 的 `package.json`（`exports["./client"]`、`exports["./typert"]`、`exports["./remote"]`、`dsh.client.inject/platform`）。
**slot 选择与 props 不在本报告范围**（见 B 报告）。

### 5.4 locale / icon

- `locale/zh.json`、`locale/en.json` 都是 `{ "meta": { "title", "description" } }`（`plugins/dsh-code-index/locale/zh.json:1-6`）。
- 断言：两者都含 `meta.title/description`（`test-plugin.mjs:135-137`）；`icon` 存在且 ≤ 256 KiB（`test-plugin.mjs:138-139`）。
- 注意 code-index 的 locale 文案**已经过时**（写着"三个工具"，`locale/zh.json:4`）——新插件别照抄文案结构里的"数量"。

### 5.5 `release/` 产物与校验和

| 约定 | 实证 |
|---|---|
| 产物名 = `local-<scope 展平>-<version>.tgz`（`@local/dsh-code-index` → `local-dsh-code-index-0.8.1.tgz`） | `plugins/dsh-code-index/release/SHA256SUMS.txt:2` |
| 同一版本可有多个变体（带/不带模型） | `…-0.8.1-local-model.tgz`（186 MB）与 `…-0.8.1.tgz`（167 KB） |
| 产物**不进 git**，只提交 `SHA256SUMS.txt` | `.gitignore:8`（`release/*.tgz`）、`plugins/dsh-code-index/.gitignore:8` |
| `SHA256SUMS.txt` 行格式：`<sha256>  <file>  <size>` | `build-release.mjs:96-100` |
| 构建脚本要先跑测试、再校验补丁、最后才 pack | `plugins/dsh-memory-archive/build-plugin-dist.ps1:6-21,55-67` |
| `release/` 是**镜像**不是累积：旧版本靠 tag 继续可下载 | `build-plugin-dist.ps1:173-179` |
| **当前状态**：`package.json` 0.8.4 / 1.2.0，`release/` 里却是 0.8.1 / 1.1.1（另有未登记进 SHA256SUMS 的 `local-dsh-memory-archive-1.2.0.tgz`） | `plugins/*/package.json` vs `plugins/*/release/` |

⚠️ 后果：`install.ps1` 挑 `release/*.tgz` 里**名字排序最大**的那个（`install.ps1:115-117`），于是会装到与源码版本不一致的包。新插件请把"改内容必须升版本 + 重新 build-release"当作发布闸门（理由见下条）。

### 5.6 `install.ps1` 流程（根目录那个，223 行）

| 阶段 | 行为 | 位置 |
|---|---|---|
| 前置检查 | 扫 profile 补丁层，确认 `tool-plugin-manager` 行被覆盖成 `disabled: false`；否则**只打印**修复建议 | `install.ps1:78-107` |
| 官方路径（默认 `-Mode Official`） | 对每个插件：优先取 `release/*.tgz`，否则回落包目录；**打印**应该交给 agent 执行的 `plugin_manager(action:"install_bundle", target:"…")` | `install.ps1:110-147` |
| Legacy 退路 | `robocopy` 源码到 bundle 目录 + 手写 `file://` insert 行（明确标注非官方） | `install.ps1:150-222` |
| 依赖/模型 | 仅 code-index：`npm install` + DirectML 校验 + `-FetchModel` 下载 | `install.ps1:161-195` |
| 硬编码 | `-Plugin` 的 `ValidateSet('all','memory-archive','code-index')`；`$plugins` 表两项 | `install.ps1:56-58,71-74` |

脚本**不能自己完成安装**（`install_bundle` 是 agent 工具，且 desktop profile 由应用独占管理：`install.ps1:20-30`）。

### 5.7 版本 / tag 约定

- 历史 tag `v1.1.0` / `v1.1.1` 只指记忆插件，保持不动；多插件后用**带插件前缀**的 tag：`memory-archive-v1.2.0`、`code-index-v0.1.0`（`README.md:145-157`）。新插件 → `workspace-v0.1.0`。
- 分发产物仍在插件自己的 `release/`（`/-/raw/<tag>/plugins/<plugin>/release/<file>`）。
- **同版本号装了不同内容 → `ambiguous-install`，管理器保护性拒绝**；正确做法是升版本（`README.md:79-82`）。

### 5.8 生效时机（实测，`README.md:42-49`）

| 动作 | 结果 |
|---|---|
| 装**新** bundle | `applied`（热生效，不用重启） |
| **替换**已安装包（换 target 或目录↔tarball） | `restart-required` |
| 改**已加载**插件的代码 | 必须重启（cordis 不会重新 import） |
| 改 profile 补丁层新增行 | 补丁层热加载，但新行通常要重启 |
| 改 **Client 半**（client.js） | 需重建该插件的 Client 产物并刷新页面；只有在本 checkout 跑着 `pnpm run dev:web` 时才是"免刷新热更" |

---

## 6. 新增 `dsh-workspace` 插件：骨架清单

### 6.1 照抄（本仓现成）

| 文件 | 抄自 | 必须保留的东西 |
|---|---|---|
| `package.json` | `plugins/dsh-code-index/package.json` + `dsh-memory-archive/package.json` | `@local/` scope、`private:true`、`type:"module"`、`exports`（+`./client`/`./icon`）、`files` 白名单、`dsh.bundle.patch`、optional peerDeps、`engines` |
| `cordis.patch.yml` | code-index 版 | `- insert: - id/name/config`；只放可移植默认值 |
| `index.js`（Host 半） | code-index 的骨架 | `export const name` / `export const inject` / `export function apply(ctx, config)`；注册与清理都进 `ctx.effect`（`index.js:592-610`） |
| `locale/{zh,en}.json` | 任一 | `meta.title` / `meta.description` |
| `icon.svg` | code-index | ≤ 256 KiB |
| `test.mjs` | memory-archive（fake `ctx.on` 夹具）或 code-index | 假 ctx **必须按 `inject` 声明**决定可访问服务（`test-plugin.mjs:57-103`） |
| `test-plugin.mjs` | code-index | bundle 契约断言（`dsh.bundle.patch`、name、inject、patch 用包名、exports、files、locale、icon、**不 import `@deepseek-ai/*`**）、配置校验用例、注册面、卸载归零 |
| `verify-install.mjs` | code-index | 从**安装后的包路径** `import` + `apply` + 断言，并隔离 `DSH_HOME`（`verify-install.mjs:27-33`） |
| `build-release.mjs` / `build-plugin-dist.ps1` | 任一 | `npm pack` → `release/` + `SHA256SUMS.txt`；先跑测试 |
| `README.md` / `INSTALL.md` / `CHANGELOG.md` | 两个都有 | 装/验/回滚三段 |
| `.gitignore` | 插件级 | `release/*.tgz`、`dist/`、`node_modules/` |

### 6.2 本仓没有、必须新写

| 文件 | 依据 | 说明 |
|---|---|---|
| `client.js` | skill `templates/decoration/client.js` | `window.__ModuleLoader__.load({id:包名, factory(require){…}})`；`ctx.slots.inject` + `ctx.slots.register`；样式/监听器放 `ctx.effect`，返回清理函数 |
| `dsh.client` 段 | skill 模板 + `dsh-client-product-analytics` | `{ platform:"web", immediately:true, inject:[…client 包名] }` |
| Host↔Client 通道（若 UI 要读写工作空间状态） | 两条路：① Host 提供 Service + Client 走既有 RPC；② typert 生成 `./typert` + `./remote` 导出（`dsh-client-product-analytics` 用法） | **具体可用 Remote 命名空间见 B 报告**；本报告不臆造 API 名 |
| 根集合的持久化载体 | 需与 A 报告对齐（`workingDirectory` 服务是否可扩展/覆盖） | 最小可用版可自己存 `<DSH_HOME>/workspace/roots.json`（本仓已有 `_dsh-index`/`archive`/`code-index` 的同类先例） |

### 6.3 照抄会踩的坑（本仓现状）

1. `install.ps1` 的 `-Plugin` ValidateSet 与 `$plugins` 表**硬编码两项**（`install.ps1:56-58,71-75`）→ 必须加 `'workspace'` 条目，否则根目录安装入口对新插件完全无效。
2. `verify-install.mjs:134` 的 `registry.size === 4` 这类**数量断言**已与实际（5 个工具）不符 → 新插件写断言时用"逐个断言工具名存在"，不要断言总数。
3. `_loaded.json` 的 `tools` 清单（`index.js:528`）与 `bootLog('tools-registered')`（`index.js:1336`）都还写着 4 个 → 标记/日志**列清单**而不是数量，且要随注册表一起维护。
4. Host 半**不能 import 任何 `@deepseek-ai/*` 值**（`test-plugin.mjs:143-148` 有断言；理由见 `index.js:243-249`）→ 配置校验自己写（`ConfigError` 模式，`index.js:250-255`），不要引 schemastery。
5. 配置校验要"大声失败并点名键"（未知键直接抛，`index.js:264-267`）——多根配置项多，静默失效的代价更高。
6. 重依赖不要写进 `package.json`（`README.md:64-69`：`pendingBuilds`/审批/600s 超时三条坑）→ 需要时走"按需安装到自管目录"（`lib/deps.js` 模式）。

---

## 7. 测试方式：可复用模板

| 脚本 | 形态 | 关键手法（可直接复用） | 位置 |
|---|---|---|---|
| code-index `test.mjs` | 核心自测（177 KB / 773 行，README 记 147 项） | 直接跑 `lib/*` 纯函数；`--repo` 指定真实仓库。**未逐行通读**（本报告只按入口与 README 口径记录） | `plugins/dsh-code-index/test.mjs` |
| code-index `test-plugin.mjs` | 接口/契约测试（306 行） | ① 第一条语句隔离 `DSH_HOME`（`test-plugin.mjs:20`），否则覆盖线上 `_loaded.json`；② `cordisLikeCtx` 用 Proxy **按 inject 声明**决定可访问服务（`57-103`）；③ bundle 契约断言（`121-151`）；④ 配置失败用例表（`154-166`）；⑤ 注册面与 `isConcurrencySafe`（`186-218`）；⑥ 卸载归零（`300-303`） | 同上 |
| code-index `verify-install.mjs` | 装后验证（205 行） | 从安装路径 `import` → 真 `apply` 到夹具 → 断言 `name/inject/BUILD` → 断言白名单行为 → 断言重依赖**不在包内**且可从受管目录解析 | `verify-install.mjs:77-202` |
| memory-archive `test.mjs` | 自测（606 行 / 109 项） | 用假 `ctx.on` 收集 handler，喂**真实事件形状**（注释记录了"合成形状导致测试假绿"的事故）；marker 重定向到临时目录且断言"测试不改动线上 marker" | `plugins/dsh-memory-archive/test.mjs:16-38` |

对新插件的建议组合：`test.mjs`（纯逻辑）+ `test-plugin.mjs`（契约/配置/注册/卸载）+ `verify-install.mjs`（装后真实路径）。三者都不需要起 DSH，秒级可跑。

---

## 8. 已知债务（会影响"照抄"与验收）

| # | 事实 | 证据 | 影响 |
|---|---|---|---|
| 1 | `verify-install.mjs` 断言"注册 4 个工具"，实际 5 个 → **当前跑就会失败** | `verify-install.mjs:134`；`index.js:1174`（`code_map` 无条件注册） | 装后验证会给假红灯；新插件别抄数量断言 |
| 2 | `_loaded.json.tools` 与 `bootLog` 仍列 4 个工具 | `index.js:528,1336` | 诊断信息失真 |
| 3 | locale 文案仍写"三个工具" | `locale/zh.json:4`（en 同） | 商店/设置页显示过时 |
| 4 | `dropIndex` 死导入；`Store` 无 `close()`；`stores` 只增不减 | `index.js:31`、`lib/store.js`（无 close）、`index.js:586` | 多根 + UI 反复切根会积累句柄 |
| 5 | `matrixCache` 全局单条 | `lib/search.js:16-29` | 多根交替查询 = 反复全量读向量 |
| 6 | `path.resolve` 相对路径基准是 `process.cwd()` 而非会话 cwd | `index.js:792,958,1088,1193` | 文档与实现不一致；多根下更易误判 |
| 7 | `release/` 产物版本落后于 `package.json`；`SHA256SUMS.txt` 未覆盖新 tgz | §5.5 | `install.ps1` 会装到旧包 |
| 8 | 白名单匹配大小写敏感、未 `realpath` | `index.js:633` | 多根场景误拒/绕过 |
| 9 | `indexDir` 共用库与多根冲突 | `lib/indexer.js:55-61`；`lib/indexer.js:266` | 状态张冠李戴 |

---

## 附录：本报告引用到的关键位置

```
plugins/dsh-code-index/index.js
  31        dropIndex 导入（未使用）
  104-240   DEFAULTS（roots:109 / indexDirBase:106 / indexDir:108 / sync:236）
  260-456   normalizeConfig（roots 校验:364；excludePaths 校验:310-328；allowedRoots:454）
  489-500   apply 包裹（bootLog）
  502-584   applyInner 入口 + _loaded.json 标记（tools:528，config.roots:531）
  586-635   stores / sessionCwd(612) / storeFor(621) / assertAllowed(631)
  769-868   code_index 工具（schema 769-789；repoRoot 解析 792）
  871-926   sync.watch watchers（874-912）
  929-1069  code_search 工具（schema 936-954；repoRoot 958；结果渲染 1059-1063）
  1072-1171 code_index_status（schema 1076-1084；repoRoot 1088）
  1174-1215 code_map（schema 1181-1189；repoRoot 1193）
  1218-1319 code_index_deps
  1329-1336 加载日志 + tools-registered(4 个)
plugins/dsh-code-index/lib/indexer.js
  55-61     indexDbPath（每根一库）
  64-69     scanStatus
  83-296    buildIndex（指纹 136-166、full 清库 160-162、repo_root 266）
  299-301   dropIndex（只清表）
plugins/dsh-code-index/lib/scan.js      56-96 walkRepo；103-115 diffFiles
plugins/dsh-code-index/lib/store.js     62-72 Store.open（无 close）；84-92 表结构（path 为仓库相对）
plugins/dsh-code-index/lib/search.js    16-29 matrixCache；70-84 search 签名；218-237 结果（path 相对）
plugins/dsh-code-index/lib/repo.js      50-55 repoIdOf
plugins/dsh-memory-archive/index.js     70/76 默认目录；278-287 findSessionLog；535-538/554-570 噪声；1056-1064 marker；1112-1116 archiveRoot；1389-1457 ctx.on 注册
install.ps1                             56-58 ValidateSet；71-75 $plugins；78-107 前置检查；110-147 官方路径；150-222 Legacy
plugins/dsh-code-index/{package.json,cordis.patch.yml,verify-install.mjs,test-plugin.mjs,build-release.mjs}
plugins/dsh-memory-archive/{package.json,cordis.patch.yml,test.mjs,build-plugin-dist.ps1,install.ps1}
README.md                               42-49 生效时机；64-69 重依赖；79-82 ambiguous-install；145-157 tag 约定
skill 模板（asar 内，需 read 工具）
  …/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/{package.json,index.js,client.js}
  …/dsh-agent-preset/skills/cordis-plugin-development/references/ui-plugin.md
```
