# 会话记忆归档（dsh-memory-archive）

给 DSH 补上 Cursor 式「压缩归档 + 指针注入」：每次 compaction 把被压缩区间的**原始轮次**落成可 grep 的 Markdown，并在下一个 step 边界告诉模型「归档在哪、怎么查」。

DSH 自带的 compaction 只把旧区间换成一条摘要；本插件补的是**可检索的落盘**和**模型知道去看**这两块。

## 产物

```text
~/.dsh/archive/<sessionId>/          # 默认；可配置
├── INDEX.md          # 每段一行：段号/文件/compaction id/事件数/工具数/字节/关键词
├── index.jsonl       # INDEX 的机器可读镜像（也用于去重与段号计数）
├── segment_NNN.md    # checkpoint 摘要 + 被压缩区间的原始轮次
├── evicted.md        # compaction/prune 摘掉、任何 segment 都不含的事件
└── evicted.jsonl     # evicted 账本（seq/atSeq/tokens/bytes；日志里找不到的标 missing）
```

`INDEX.md` 的 Keywords 是「哪一段里有这个词」——按工单号 / 文件名 / 标识符优先挑选，可直接 `grep`。

## 安装

| 路径 | 适用 | 做法 |
|---|---|---|
| A. 插件源（推荐） | 能打开 Plugins → Discover | 添加源后装 `dsh-memory-archive`（market 里版本与 commit 钉死） |
| B. `install_bundle` | 含被应用独占管理的 `desktop` | `target` 用 `release/*.tgz` 的**绝对路径**（目录会变成 `link:` 源码依赖） |
| C. 离线兜底 | 不能装源、不能用 plugin_manager | `pwsh -File install.ps1 -Profile desktop`（`-DryRun` 预演，`-Uninstall` 回滚） |

前提、卸载与排错见 **[INSTALL.md](./INSTALL.md)**。

## 配置

`cordis.patch.yml` 里的 row config，**全部可选**，未写的取 `index.js` 的 `DEFAULTS`：

| 键 | 默认 | 说明 |
|---|---|---|
| `archiveDir` | `~/.dsh/archive` | 归档根；支持 `~` / `$DSH_HOME` / `$HOME` / `%VAR%` |
| `sessionRoot` | `$DSH_HOME/sessions` | DSH 会话日志根，用于补挂载前的事件 |
| `readSessionLog` | `true` | 关掉只用内存事件 |
| `includeToolResults` | `true` | 原始轮次里是否含工具返回 |
| `redact` | `true` | 落盘前脱敏 token 形态字符串 |
| `maxEventsPerSession` | `20000` | 每会话缓冲上限（超出丢最旧） |
| `maxSegmentBytes` | `1500000` | 单段上限，超出截断并标注 |
| `maxEventsPerSegment` | `4000` | 单段原文事件数上限 |
| `announce` | `true` | 注入指针；关掉模型就不知道归档存在 |
| `markerFile` | `null` | 激活标记位置（安装目录只读时改它，或用 `DSH_MEMORY_ARCHIVE_MARKER`） |
| `exp.enabled` | `false` | 经验抽取总开关；**默认关闭**，详见下一节 |
| `exp.url` / `exp.key` | `""` | 经验容器根地址 + 服务端 API_KEY（Bearer） |
| `exp.mode` | `server` | `server` = 服务端调 LLM；`client` = 插件调本机 LLM 只交候选 |
| `exp.apply` | `false` | `false` 只跑漏斗不写库（先看质量再开） |
| `exp.timeoutMs` | `15000` | 单次 HTTP 超时 |
| `exp.minSegmentBytes` | `2000` | 被 shadow 原文小于这个字节数就不抽 |
| `exp.maxVerbatimBytes` | `204800` | verbatim 上限（200KB），超出截断并 warn |
| `exp.llmUrl` / `exp.llmKey` / `exp.llmModel` | `""` | `mode=client` 用的本机 OpenAI 兼容 LLM |

## 经验抽取接线

每次压缩**落盘完成之后**，插件可以把这个段的 `summary` + 被 shadow 的原文交给经验管道
（`server/storage-hub` 的 `/v1/exp/extract`），由它抽成可复用的团队经验（黑话 / 索引 / 逻辑三镜头）。

**默认关闭**，需要显式打开：

```yaml
# cordis.patch.yml 的 row config
exp:
  enabled: true
  mode: "server"                    # 服务端抽（推荐）
  url: "http://192.168.1.10:8000"    # 容器根地址；已带 /v1 也接受
  key: "<服务端 API_KEY>"            # Authorization: Bearer
  apply: false                      # 先只跑漏斗；质量满意再改 true 落库
  timeoutMs: 15000
  minSegmentBytes: 2000
```

`mode: "client"` 是容器不可达时的降级路径：插件自己调本机 OpenAI 兼容 LLM
（`exp.llmUrl` / `exp.llmKey` / `exp.llmModel`，prompt 见 `exp-hook.mjs`），
抽完只把候选 `POST /v1/exp/import` 交给容器做 Review/Dedup/Merge：

```yaml
exp:
  enabled: true
  mode: "client"
  url: "http://192.168.1.10:8000"    # import 仍然打容器
  llmUrl: "http://127.0.0.1:3425/v1"
  llmModel: "auto/deepseek-v4.1-flash"
```

### 失败语义（这条是硬约束）

- **抽取绝不影响归档**：触发是 fire-and-forget，`writeSegment()` 不 await、不依赖它的结果。
  端点**超时 / 500 / 连接被拒绝**时，段落文件、`INDEX.md`、`index.jsonl` 的内容与没开 exp
  时**逐字节一致**，指针照发。`test-exp-hook.mjs` 把三种失败都钉死了。
- 失败只 `logger.warn` 一行（带原因：超时 / HTTP 状态 / errno），不抛给会话事件路径。
- **同一会话连续失败 3 次即不再尝试**（避免每段都白等一次 15s 超时）；成功一次清零。
- 服务端 `200 + status:"skipped"`（未配置 LLM）不算失败，不会触发退避。
- `verbatim` 超过 `exp.maxVerbatimBytes`（默认 200KB）会按 UTF-8 边界截断并 warn。
- `exp.enabled: false` 或 `exp.url` 为空时：一个请求都不发（缺 url 只 warn 一次）。

### 关闭方法

把 `exp.enabled` 改回 `false`（改配置热生效，改代码才要重启）；或整段删掉 `exp`，取默认值（关闭）。

### 服务端契约

```text
POST {exp.url}/v1/exp/extract
  body: {session_id, segment_no, workflow, summary, verbatim, apply}
  → 200 {job_id, status, funnel:{candidates,blocked,created,updated,skipped,contradicted}, reasons, ms, warnings}
  → 未配置 LLM 时 200 {status:"skipped", reason:"llm-not-configured"}（不是 5xx）

POST {exp.url}/v1/exp/import     # mode=client 用
  body: {session_id, segment_no, workflow, apply, candidates:[...]}
```

- `segment_no` 与磁盘上的段号一致（`segment_000.md` → `0`）。
- `workflow` 由会话标题推导（没有标题用 cwd 的 basename），slug 化：`ERP Bug：订单/退款` → `erp-bug-订单-退款`。

## 关键行为

- **只服务同一会话**：按 `session.id` 找对应日志、按 `<sessionId>` 分目录；**不做跨会话记忆**。
- **改配置热生效，改代码必须重启**（Host 插件，ESM 模块缓存）。
- `announce: true` 时每段落盘后注入一次指针；没有指针，归档大概率没人读。
- 超过 `maxSegmentBytes` 的段会截断并标注，不会写坏。
- 归档文件是生成物：**不要手改**；升级关键词提取器后跑 `tools/reindex.mjs` 重算索引。
- 会话日志里已被 prune 且归档前就找不到的事件，只在 `evicted.jsonl` 记缺口，不假装归档成功。

## 自测

```bash
node test.mjs           # 归档本体（109 项）
node test-exp-hook.mjs  # 经验抽取接线（78 项，含超时/500/拒绝连接三种失败下的落盘一致性）
# 或一次跑完：npm test
```

## 深入

- [INSTALL.md](./INSTALL.md)：完整安装前提、卸载、故障处理。
- [CHANGELOG.md](./CHANGELOG.md)：版本变更与踩过的坑。
