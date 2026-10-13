# @local/dsh-memory-archive

给 DSH 补上 Cursor 式「压缩归档 + 指针注入」两件套：

1. **落盘**：每次 compaction 写一份可 grep 的 `segment_NNN.md`（checkpoint 摘要 + 被压缩区间的**原始轮次**），并维护 `INDEX.md`。
2. **注入**：在下个 step 边界把「归档在哪、怎么查、查什么」作为一条 `<system-reminder>` 交给模型。

DSH 自带的 `dsh-compaction-basic` 只把旧区间换成**一条摘要消息**，原始事件留在会话 JSONL
里但不落成可检索产物，也不提示模型存档存在。本插件补的正是这两块。

## 范围：只管**同一会话内**，不做跨会话

本插件解决的是「一个会话经历多次压缩后不丢历史」。它读会话日志，是为了回填**本会话自己**
在插件挂载之前产生的事件——`resolveSessionLog` 只按 `session.id` 查找对应那一个日志文件，
不会去读别的会话。归档目录也按 `<sessionId>` 分目录。

**跨会话记忆不属于本插件**：那是一个独立的会话索引 + 检索 CLI，与本插件零耦合，
**也从未接线到运行时**（模型不会自动用它）。该工具已于 2026-10-13 从本仓库移出到
`~/.dsh/attic/`（附 `RESTORE.json` 还原清单）。本仓库现在只保留会话内这一层。

## 为什么必须要有第 2 件

实测 Cursor 同款设计：它的压缩 checkpoint 消息末尾固定附上一段指针，明确给出
`segment_*.md` 通配路径、`INDEX.md` 目录、`Use read_file or grep to recover specific
details (exact code, file paths, tool outputs)`，以及 `Do NOT modify these files`。
该会话里模型据此显式检索归档 7 次（Grep 4 + Read 3，全部只读）。

**光落盘不给指针，档案大概率一直没人读。** 所以 `announce` 默认为 `true`。

## 产物

```text
~/.dsh/archive/<sessionId>/          # 默认；可配置，见「配置」
├── INDEX.md          # 每段一行：段号/文件/compactionId/影子事件数/事件数/工具数/字节/关键词
│                     # 末尾另有一段说明 evicted.md 覆盖了多少条（若有）
├── index.jsonl       # INDEX 的机器可读镜像（也用于段号计数、resume 去重）
├── segment_000.md
├── segment_001.md
├── evicted.md        # compaction/prune 摘掉的事件（任何 segment 都不可能有它们）
└── evicted.jsonl     # evicted 账本：{seq, atSeq, tokens, bytes, writtenAt}
```

单个 segment 的字段（按下表实测内容）：

````text
# HISTORICAL -- GENERATED, DO NOT EDIT
# Record of compaction segment 004 from this same task.
# Use read or grep to look up details, but do not modify.

## Segment metadata   # Session / Segment index / Written / Compaction id /
                      # Summary event seq / Shadowed range (reported) / Shadowed range (effective) /
                      # Shadowed surface events / Shadowed tokens (reported) / Summarizer /
                      # Buffered events archived / Tool calls issued
## Turn statistics    # Events by type / Tools used / Tool calls without a response in this span /
                      # Tool results marked as error / Unique target files (N) /
                      # Verbatim-render size estimate / Last assistant response excerpt
## Summary            # compaction 后端写的 checkpoint 摘要原文
## Verbatim turns     # 每个事件一个 `### seq N -- ...` 块，工具调用与返回双向标注配对
````

渲染（2026-10-13 实测形状；每个事件仍保留自己的 seq 块，便于按 seq grep）：

````text
### seq 1977 -- Assistant (tool call: pwsh)
```text
[reasoning]
[tool-call: pwsh] {"command":"Get-ChildItem \"C:\\...\" -Filter _loaded.json"}
```
_(tool call pwsh answered at seq 1979)_

### seq 1979 -- Tool response (callId call_00_xY917XmIjEWZbTm25xZL5298, answers seq 1977)
```text
Name           Length LastWriteTime
----           ------ -------------
index.jsonl       596 2026/10/13 18:26:16
```
````

要点：

- 块标题是 `Assistant (tool call: <名>)`；**一条消息多个调用**时用复数并把名字并列，如
  `Assistant (tool calls: pwsh, pwsh)`。
- 工具名与完整参数在正文里逐条一行 `[tool-call: <名>] <arguments 原文>`；`arguments` 是 JSON
  字符串，**不截断**（Redis 风格的长参数也是整行）。
- 无返回时标注为 `_(tool call <名> has no response in this span)_`。
- 工具返回正文包在动态长度的围栏里（见「已知限制」第 6 条）。

## 与 Cursor 的对齐状态

| 维度 | Cursor | 本插件 | 状态 |
|---|---|---|---|
| 归档时机 / 段编号 | 每次 compaction，`segment_NNN.md` 递增 | 同 | ✅ |
| 指针四要素 + `if insufficient` 条件 | 有 | 有；存在被 prune 的事件时再多一行指向 `evicted.md` | ✅ |
| 文件头“去查别改”提示 | 每个 segment 第 3 行 | 同（`Use read or grep to look up details, but do not modify.`） | ✅ |
| 工具调用↔返回配对 | 每 turn 独立块 | 每 seq 独立块 + 双向标注（`answered at` / `answers seq` / `error` / 无返回标记） | ✅ |
| 段统计字段 | Turns / Tools used / Unique target files / Tool errors / size estimate / last assistant excerpt | 事件分布 / Tools used / Unique target files / 报错数 / 无返回数 / size estimate / last assistant excerpt | ✅ |
| 脱敏 | **无**（实测 13 段含 92 处 JWT 原文） | 默认脱敏，覆盖工具返回**与工具参数**；INDEX 关键词同源 | ✅ 有意优于 |
| 归档位置 | 工作区**外** | 工作区**外**（`~/.dsh/archive`） | ✅ 2026-10-13 已对齐（原先是工作区内） |
| 段内容范围 | **完整 rollout**（含注入摘要、todo、系统提示、恢复指令） | **证据子集**：仅 6 类消息事件 | ❌ 未对齐 |
| 指针位置 | 与摘要**同一条** checkpoint 消息 | 独立 user 消息，下个 step 边界投递 | ❌ 未对齐（受限于 `dsh-compaction-basic` 构造该消息） |
| 摘要段数 | 9 段 | 原样复制 DSH 后端摘要 | ❌ 未对齐（属 summarizer，不属归档器） |

**归档放在工作区外不影响检索**（实测）：`read` 与 `grep` 都能直接吃工作区外的绝对路径——本机
`grep` 在 `C:\Users\you\.dsh\archive\...\INDEX.md` 命中，`read` 直接读了 `segment_004.md`。
指针给的就是绝对路径，所以不需要把档案搬进工作区。

## 注入的指针（逐字）

```text
<system-reminder>
A compaction checkpoint was archived to disk together with its verbatim turns.

- Index (one row per segment): <archiveDir>/<sessionId>/INDEX.md
- New segment: <archiveDir>/<sessionId>/segment_004.md (compaction <id>, 586 events, 278 tool calls)
- Every segment: <archiveDir>/<sessionId>/segment_*.md
- Evicted events (removed from context by compaction/prune, in no segment): <archiveDir>/<sessionId>/evicted.md (18 recovered)

When the checkpoint summary above is insufficient, use grep or read on those files to recover exact
code, file paths, and tool outputs from the summarized span. Do not modify these files.
</system-reminder>
```

第 4 行**只在有被 prune 的事件时才出现**（`evictedCount > 0`）；`N tool call(s)` 按实际数量单复数。
投放方式（优先顺序）：

| 路径 | 机制 | 特点 |
|---|---|---|
| 首选 | `agent.inbox.prepend('next-step', message)` | 持久化（`agent/inbox/spliced` 事件），下个边界被 claim |
| 回退 | 插入 `agent/pre-step` 瀑布返回的 `decision.messages` | 同一步就到模型，但仅在本次进程内有效 |
| `announce: false` | 不注入 | 只手写归档 |

指针在每个 compaction 之后投递一次，并用 `pendingNotice` 清空保证**不重复**。`compaction/prune`
只写 `evicted.md` / `evicted.jsonl`，**不投递指针**。

## 安装

三条路径的完整说明、前提、卸载与排错见 **[INSTALL.md](./INSTALL.md)**。速览：

| 路径 | 适用 | 做法 |
|---|---|---|
| A. 原生 bundle | `dsh plugin` 可用的 profile | `dsh plugin --profile <p> add <包/tarball/git-url>`，再把包名加进 `dsh.profile.bundles` |
| B. 一键脚本 | `desktop` 等被应用独占管理的 profile | `pwsh -File install.ps1 -Profile desktop`（`-DryRun` 预演，`-Uninstall` 回滚） |
| C. 手工 | 任意 | 复制包到工作区外 + 在 profile 补丁末尾插入 `memory-archive` 行 + 重启 |

要点：

- 本包**已经是 DSH bundle**：`package.json` 声明了 `dsh.bundle.patch`，`cordis.patch.yml` 插入一行
  `memory-archive`，走 A 时 `name` 用包名 `@local/dsh-memory-archive`（loader 按 Node ESM 解析）。
- 走 B/C 时 `name` 必须解析到 **`index.js` 本身**（`file:///<绝对路径>/index.js`），
  **不需要** pnpm、**不要**改 profile 的 `package.json`。
- `desktop` profile 被 Electron 应用**独占管理**：`dsh plugin --profile desktop` 与
  `dsh --dump-config --profile desktop` 都会直接失败（`profile "desktop" is managed exclusively
  by the Electron application`），Web 侧栏没有插件页，`plugin_manager` 工具的对应行在 base bundle
  里默认 disabled —— 所以该 profile 只能走 B/C。
- **改配置热生效，改代码必须重启**（见下节）。新装或升级后都要重启。
- 首次安装 `archiveDir` 建议写**绝对路径且用正斜杠**（`install.ps1` 默认就是这么写的）：旧代码
  不展开 `~`，会在会话 cwd 下建出字面量 `~` 目录。升级并重启后才可安全用 `~/.dsh/archive`。

## 改配置不用重启，改代码必须重启（实测，别再猜）

2026-10-13 在同一个 app 进程（pid 63252，18:24:56 启动）上实测：

| 动作 | 标记变化 | 结论 |
|---|---|---|
| 编辑 profile 补丁里的 `archiveDir` | `loadedAt` 被刷新、新值出现 | 配置**热生效**（数秒内）；触发条件是**配置树发生变化**，只改注释不会触发 |
| 编辑 `index.js`（换了代码） | 无任何变化 | 模块**不会重新 import**，进程一直持有启动时那份代码 |

判别方法：`_loaded.json`（写在 bundle 目录里）除配置回显外，还有几个**只有新代码才会写**的字段。
当前真实内容（2026-10-13 19:11 重启后）：

```json
{ "loadedAt": "2026-10-13T11:11:09.120Z",
  "pid": 40256,
  "dshProfile": null,
  "sessionId": null,
  "archiveDir": "C:/Users/you/.dsh/archive",
  "archiveDirResolved": "C:/Users/you/.dsh/archive",   // 由插件计算：代码版本指纹
  "build": "2026-10-13.4",                                  // 同上
  "capabilities": { "zstd": true },                         // 运行时能力探测
  "announce": true }
```

`archiveDir` 与 `archiveDirResolved` 的差别本身就是证据：前者是原样回显的配置，**任何版本都会写**；
后者只有带展开逻辑的版本才写得出来。所以“标记被刷新”不等于“新代码已加载”。

第二次实测（同日 19:11 重启）：进程启动时间晚于 bundle 里 `index.js` 的 mtime，marker 随即出现
`build 2026-10-13.4`、`archiveDirResolved` 与 `capabilities.zstd: true` —— 这三项组合起来才是
“新代码已加载”的可用判据。`dshProfile` / `sessionId` 取自环境变量，Electron 宿主里通常为 `null`，
不是故障。

推论（踩过的坑）：配置里写 `~/.dsh/archive` 而线上仍是旧代码时，`~` 不会被展开，会在会话 cwd 下
建出**字面量 `~` 目录**。改配置前先确认代码版本，或直接写绝对路径。

## 验证

### 手工过一遍

1. 触发一次压缩：`/compact`，或让长会话自动触发。
2. 检查 `~/.dsh/archive/<sessionId>/`（或你配置的 `archiveDir`）：`INDEX.md` 有对应行，
   `segment_NNN.md` 的 `## Verbatim turns` 里有原始 `Tool response` 文本。
3. **确认指针真的到了模型**：下一次 step 后会收到一条 `<system-reminder>`；会话里也可查
   `source.kind = memory-archive` 的 user 消息，或直接看 `agent/inbox/spliced` 事件。
4. 反向确认：`index.jsonl` 里同一 `compactionId` 只出现一次，且指针只出现一次。
5. 还原测试期间改过的任何用户设置。

### 线上实测（2026-10-13，重启后 build `2026-10-13.4`）

`_loaded.json` 的 `capabilities.zstd: true` 说明 Electron 宿主的 Node 能解 zstd，所以
`readSessionLog` 的磁盘回填在真实 app 里可用（此前只做过离线验证）。

一次真实 `/compact`（compactionId `bd9761d9-…`）写出 `segment_004.md`：586 个被遮蔽事件，
而插件是压缩前约 1 分钟才挂载的 —— **`Buffered events archived` 能等于 586，只可能来自磁盘日志解码**。
同段确认：`Shadowed range (reported)` / `(effective)` 两行都在（1965-3462 / 1959-3462，不相同，
说明 effective 是独立算的），`Tool calls issued: 278`，注入的指针里带 `278 tool calls` 与
`evicted.md (18 recovered)`。

**仍未线上触发**：`compaction/prune` 的落盘（37 个会话里只有 4 个发生过 prune，低频）。
它由 `verify-evicted.mjs` 和回放真实 prune 事件离线覆盖，线上尚未见到真实触发。

### 独立复算（不 import 插件）

脚本在本包的 **`tools/`** 目录（随包分发；**不 import 插件**，所以插件的 bug 不能给自己背书）：

1. `tools/verify-segments.mjs <归档目录> [sessionsRoot]`：从原始会话日志重算每段的事件覆盖、事件数、
   工具调用总数与按名计数、配对标注、目标文件数、脱敏，逐条对比 segment 文本。
   当前 4 个归档 / 9 个段全部通过。
2. `tools/verify-evicted.mjs <归档目录>`：prune 账本与 `evicted.md` 的结构与文本切片校验。
3. `tools/backfill-session.mjs [--session <id>] [--out <dir>]`：只喂控制事件、正文全部从日志恢复的
   端到端回填。省略 `--session` 时自动取**最近写入**的会话。产出的文件与线上归档**逐字节相同**，
   唯一差异是 `Written` / `writtenAt` 时间戳。

### 验证器自己的两个坑（都曾造成误判，已修）

1. **不要整篇数 `^[tool-call: `**。归档正文会合法引用这个字面量（工具输出打印过 segment、
   assistant 回复里贴过截断摘录）。旧写法在 segment_004 上数出 282 而日志只有 278，报了假 FAIL。
   现在按“该块自己的调用”逐条精确配对，且块内重复渲染单独判错。
2. **脱敏也作用在工具参数上**（`mask()` 跑在整条渲染文本之后），所以渲染行可能比日志原文短。
   比对规则：无占位符要求逐字节相等；有 `***JWT***` 一类占位符时按字面骨架匹配，占位符处
   容许非空原文。

突变检验（干净套件不算证据）：删一条渲染 → FAIL 并定位到具体 seq；改工具名 → FAIL；
把它移到别的块 → FAIL；块内重复渲染 → FAIL；换入另一条真实参数 → FAIL；
无损往返（只读写不改内容）→ PASS。每个突变只挂 1 项检查，无连带误伤。

激活标记同样量过（1.1.0 新增）：**改回「总写模块旁」的旧行为 → 5 项 FAIL**；
忽略 `DSH_MEMORY_ARCHIVE_MARKER` → 4 项 FAIL；去掉标记父目录创建 → **正好 1 项 FAIL**。
其中第一条正是「在已安装的 bundle 里跑自测会删掉 app 的标记」这个缺陷的可复现证据。

## 配置

`cordis.patch.yml` 里的 row config，全部可选：

| 字段 | 默认 | 含义 |
|---|---|---|
| `archiveDir` | `~/.dsh/archive` | 归档根目录。`~`、`$DSH_HOME`/`${DSH_HOME}`、`$HOME`、`%USERPROFILE%` 会被展开；相对路径基于会话 cwd，展开后的绝对路径直接使用。**默认放用户 DSH 目录而非工作区**：segment 是逐字工具输出，不该进代码仓库，也不该被工作区清理波及 |
| `sessionRoot` | `$DSH_HOME/sessions` | DSH 自己的会话日志根目录，用于回填插件没见到的历史。按 sessionId 在子目录里查找，**不反推 cwd slug**（slug 用 `~0020` 这类转义，不值得复刻） |
| `readSessionLog` | `true` | 是否允许读原始会话日志。设 `false` 则退回内存读取器 |
| `includeToolResults` | `true` | 是否把工具返回原文写进 segment |
| `redact` | `true` | 落盘前掩码 JWT / Bearer / 常见 `token`、`password` 赋值（含工具参数） |
| `announce` | `true` | 是否把归档指针注入对话 |
| `maxEventsPerSession` | `20000` | 每会话缓冲事件上限（超出丢最旧） |
| `maxEventsPerSegment` | `4000` | 单段 verbatim 最多渲染多少条 |
| `maxSegmentBytes` | `1500000` | 单段字节上限，超出截断并标注 |
| `markerFile` | `null` | 激活标记写到哪里。默认＝模块旁的 `_loaded.json`。设它（或环境变量 `DSH_MEMORY_ARCHIVE_MARKER`，优先级更高）用于**只读／包管理安装位**，或让自测不碰线上安装目录。相对路径按**模块所在目录**解析，父目录会自动创建 |

## 已知限制（实测）

1. **历史回填的三个优先级**：DSH 刻意不把 seed/restore 事件重新发到 `session/event`，所以插件
   看不到挂载前的历史。回填顺序是
   **① 磁盘上的会话日志 → ② `session.snapshotEvents()` → ③ 只见实时事件**。
   ① 是首选：日志**完整且 append-only**，包含已经离开模型上下文的事件，而且不依赖任何运行时
   API。② 被上游标记为 deprecated（"new production calls are prohibited"），留作降级路径；
   ③ 是最坏情况，会漏掉挂载前的一切。读取是**惰性**的：只有某个 segment 需要缓冲里没有的
   seq 时才读盘，正常启动不产生任何 IO。
   **2026-10-13 实机踩过的坑**：app 重启后插件随启动挂载，被压缩的区间在挂载之前，436 条只
   归档了 5 条。修好后同一区间回放 436/436；**同一次运行内**分别用磁盘日志与
   `snapshotEvents` 渲染同样的 4 个 segment，SHA256 全部相同，互为交叉验证。
   ✅ **Electron 宿主的 zstd 已实测可用**（原先是未验证项）：插件把
   `capabilities.zstd` 写进 `_loaded.json`，2026-10-13 19:11 重启后实测为 `true`；同日的真实
   `/compact` 随即写出 586 事件的 `segment_004.md`——**线上磁盘回填成立**。若该字段为 `false`，
   插件会自动降级到 ②，不会更差。
2. **`compaction/prune` 是第二条、也是唯一真正会丢数据的通道**：它把事件从消息面摘掉，
   **发生在任何压缩之前**，因此之后的 `compaction/shadowedSeqs` 永远不会列出它们——没有
   任何 segment 能包含这些内容。实测本机 4 个会话共 **84 条被摘事件（419,421 token）**，
   **84/84 不在任何 segment 里**；其中 **1 个会话根本没有压缩过**，所以“折进下一段”的方案
   救不了它。因此这些事件立即写入独立的 `evicted.md`（append-only 账本 + `evicted.jsonl`
   去重），不依赖后续是否压缩。
3. **工具信息只有一个来源**：实测某 436 条的区间 = `user/message` 33 + `assistant/message` 174
   + `tool/result` 229，**不含 `tool/call`**；而 `tool/result.message.source` 只有
   `{ kind: 'tool', callId }`，**不带工具名**。所以工具名、工具数、目标文件、以及调用/响应
   配对，全部来自 assistant 消息里的 `tool-call` 内容块（`{ type, id, name, arguments }`，
   `arguments` 是 JSON **字符串**），用 `block.id` == `tool/result.message.toolCallId` 配对
   （实测 412/412 全部配上）。`arguments` 是字符串这点很关键：按对象读会静默得到空列表。
   **这是 2026-10-13 实机踩过的第二个坑**：先前按 `tool/call` 事件统计，于是
   `Tools used`、INDEX 的 `Tools` 列、`Unique target files` 三处恒为空，而 62 次调用的区间
   被写成 `0 tool calls`。修后同上区间为 62/62。
4. **`shadowedRange` 不可信，`shadowedSeqs` 才是权威**（实测 4 次压缩全部不一致）：
   它既不是影子集的 min/max，也不包含影子集，甚至**会倒置**。本会话实测
   `{start:539,end:447}`（终点小于起点）对应影子集 342–539；另一次
   `{start:16,end:339}` 对应 16–523。因此段元数据同时记录两行——`(reported)` 原样保留
   日志值，`(effective)` 由 `shadowedSeqs` 现算——**照抄 reported 会主动误导读者**。
   覆盖范围（写进 Verbatim 段的事件）始终只由 `shadowedSeqs` 决定。
5. **统计排序是规范，不依赖插入顺序**：`countBy` 按“次数降序，并列按码点升序”排。
   用 `localeCompare` 会随宿主 locale 变（本机默认 `zh-CN`），用 Map 插入顺序则会让
   结果取决于“哪个工具恰好先被调用”——两者都会让同一区间的产物不可复现。
6. **围栏长度是动态的**：归档的轮次里经常自带 ``` 代码块，固定三反引号会破坏 Markdown 结构，
   也会让任何按围栏解析文件的工具错位。所以包裹层用“比内容里最长反引号串再长一档”的围栏。
7. **归档内容本身可能含 `### seq` 行**：如果被压缩的工具输出里引用了另一个 segment，
   归档后 `grep '^### seq '` 会多出命中。**判定规则：块头在围栏之外，且前面必有一个空行。**
   只按“前置空行”判会误判（实测 segment_000 误得 9 条多余块），必须同时排除围栏内文本。
   2026-10-13 复测的量级：`segment_004.md` 原始正则命中 589 个块头，围栏感知后 **586**（与
   `shadowedSeqs` 精确相等，多出的 3 个是被引用的）；`segment_002.md` 原始 457、围栏感知 **436**。
   另外**同一 seq 可能在引文里出现多次**（segment_004 的 seq 17 出现 3 次），所以“按 seq 建索引”
   必须用围栏感知的结果，并且要容忍引文里的重复块头。
8. **指针依赖下个 step**：压缩后若会话直接结束，没有下一次 `agent/pre-step`，则指针不投递
   （文件仍已落盘，手动 grep 可用）。实测还有约 1 个 step 的延迟：落盘是异步队列，
   若下一次 `agent/pre-step` 早于写盘完成，指针会顺延到再下一个边界。
9. **已投递的指针不能撤回**：`announce` 消息里带的是写入那一刻的统计数（如 `N tool calls`）。
   若之后重算历史 segment，文件会更新，但已经发出去的指针文本不会变。
   **补档会让已有段号整体后移**，所以按段号找旧指针会错位——用 `compactionId` 定位才是稳的
   （每条指针都带它，INDEX 每行也有它）。
10. **归档默认在工作区外**（`~/.dsh/archive`），不需要 `.gitignore`。若你把 `archiveDir` 改回
    工作区内，记得自行忽略它。
11. **归档是原文**：默认脱敏只覆盖 JWT / Bearer / 常见凭据赋值（含工具参数），不能保证覆盖
    所有敏感串；分享或导出前请自行检查。
12. **不做会话改写**：不改会话日志内容，只追加一条 sourced user 消息（与
    `dsh-agent-instructions` 注入 AGENTS.md 的做法一致）。

## 本地自测

不需要 DSH profile：

```powershell
node test.mjs
```

`test.mjs` 用假 ctx / 假 agent 驱动真实的 `session/event`、`agent/pre-step`、
`agent.inbox`、`tool/result` 消息形状（含 `message.toolCallId` 与
`source: { kind: 'tool', callId }`，取自 `dsh-session`、`dsh-agent-loop`、
`dsh-compaction-basic`、`dsh-agent-instructions` 源码），覆盖 **88 项断言**：

产物结构、固定文件头（含“去查别改”提示）、verbatim 工具返回、工具调用↔返回**双向配对**、
无返回调用的标记与计数、三项 Cursor 同款统计（unique target files / size estimate /
last assistant excerpt）、JWT 脱敏（含 INDEX 关键词不泄漏）、compactionId 去重、
resume 不重复归档、畸形 payload 不抛异常、指针经 inbox 投递、指针只投递一次、
指针文案含 INDEX 路径 / segment 通配 / grep-or-read 指令 / 只读约束、
无 inbox 时回退到 `decision.messages`、`announce: false` 抑制指针、
assistant 消息里的 `tool-call` 块渲染出 name 与 arguments、不在 `shadowedSeqs` 的事件不入段、
reasoning 文本不倾倒进归档、**工具名/工具数/每消息工具标题/target files 全部按实测形状
（JSON 字符串 arguments + `block.id` 配对）计算**、`Tool calls` 列计数、围栏长度随内容自适应、
以及“会话形态确实发布 `tool/call` 事件”时的旧路径兼容、
**磁盘日志回填（多帧 zstd 必须逐帧解、无 `snapshotEvents`、按 seq 排序、范围外事件不入段、
日志缺失时降级为只见实时）**、**`compaction/prune` 落盘与重复投递去重**、
**激活标记可重定向（`DSH_MEMORY_ARCHIVE_MARKER` / `markerFile`，父目录自动创建，
且自测不再触碰安装目录）**
—— 共 **88 项断言**。

> **测试价值的自证**：断言不是“跑绿了”就算数，逐个用**突变检验**量过：
> 把磁盘读取关掉 → 4 项 FAIL；把多帧解码换成单帧 → 5 项 FAIL；去掉 prune 分支 → 7 项 FAIL；
> 去掉 prune 去重 → 正好 1 项 FAIL；改回照抄 `(reported)` 范围 → 4 项 FAIL；
> 去掉排序兜底 → 正好 1 项 FAIL。
>
> 教训一：旧 fixture 自己伪造了 `tool/call` 事件带 `name` 和对象型 `arguments` 的形状，
> 一个 DSH 从不产生的形状，于是测试把错误假设固化成了绿灯。**fixture 必须抄实测数据。**
> 教训二：磁盘回填的 fixture 一开始**把尾部事件也喂成实时事件**，于是第二帧根本不需要读，
> 单帧解码照样全绿——“能通过”和“能发现”是两件事，突变检验才分得清。
> 教训三：校验器自己崩了（`readFileSync` 撞 ENOENT）会**掩盖其余所有断言**，
> 所以产物读取一律走 `safeRead`，缺失应报 FAIL 而不是抛异常终止。
> 教训四：突变装置本身也会有 bug——用 `WriteAllLines` 把 LF 换成 CRLF、把辅助函数命名成
> `Rd`（撞上 PowerShell 别名 `rd` = `Remove-Item`）都会让“突变”变成空操作或把文件删空，
> 从而**伪造出一片绿色**。突变跑完要确认它真的改动了目标字节，并留一个“无损往返”的中性对照。

## 依据的 API（源码级）

| 用途 | 依据 |
|---|---|
| 订阅会话事件 | `ctx.on('session/created' \| 'session/event', (session, event) => …, { global: true })` |
| 压缩记录 | `compaction/summary`：`{ compactionId, summary, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model }`（`dsh-compaction-basic/lib/index.js:634`）。**实测 `shadowedRange` 不可信**（非 min/max、不含影子集、可倒置），一律以 `shadowedSeqs` 为准，两者都写进段元数据 |
| prune 记录 | `compaction/prune`：`{ shadowedRange, shadowedSeqs, shadowedTokenCount }`，一次一个 seq（`dsh-compaction-basic`）。实测本机 4 个会话 84 条，全是 `tool/result`，**84/84 不在任何 segment 里** |
| 工具事件 | `tool/call`：`{ turn, step, callId, name, arguments }`；`tool/result`：`{ turn, step, message, error? }`（`dsh-agent-loop/lib/index.js:682,697`）。**实测：`tool/call` 从不进 `shadowedSeqs`，且 `tool/result.message.source` 只有 `{kind, callId}` 没有工具名**，故工具信息实际取自 assistant 消息的 `tool-call` 内容块（`{type, id, name, arguments}`，`arguments` 为 JSON 字符串；`id` 与 `message.toolCallId` 配对，实测 412/412） |
| 消息取文 | `user/message` → `data.content`；`assistant/message`、`system/message`、`developer/message`、`tool/result` → `data.message.content` |
| 会话日志 | `$DSH_HOME/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd`；**多帧 zstd**，`zlib.zstdDecompressSync` 只解第一帧，须按魔数 `28 b5 2f fd` 切分后逐帧解再拼接。文件首行是带 `cwd` 的 `session` 头事件（无 `seq`/`time`），所以按 sessionId 扫目录即可，**不必反推 cwd slug** |
| 注入点 | `ctx.on('agent/pre-step', async (payload, next) => …)`，payload 为 `{ messages, turn, step, signal }`，返回 `{ kind: 'enter', messages }`（`dsh-agent-loop/lib/index.js:911`） |
| 持久投放 | `agent.inbox.prepend('next-step', message)`（`dsh-agent-loop/lib/index.js:125`） |
| agent 获取 | `agent/pre-step` payload 的 `agent`；缺失时回退用 `tools/result` 的 `exec.agent` |
| 消息合法性 | 运行时只校验 `user/message` 的 `id` 非空、`role === 'user'`、`content` 是数组、`source.kind` 是非空字符串（`dsh-session/lib/index.js:1191-1215`），因此自定义 `kind` 合法 |
| 消息工厂 | 惰性 `import('@deepseek-ai/dsh-llm')` 取 `createUserMessage`；不可解析时按同一形状构造并冻结 |
