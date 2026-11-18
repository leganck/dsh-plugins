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

## 关键行为

- **只服务同一会话**：按 `session.id` 找对应日志、按 `<sessionId>` 分目录；**不做跨会话记忆**。
- **改配置热生效，改代码必须重启**（Host 插件，ESM 模块缓存）。
- `announce: true` 时每段落盘后注入一次指针；没有指针，归档大概率没人读。
- 超过 `maxSegmentBytes` 的段会截断并标注，不会写坏。
- 归档文件是生成物：**不要手改**；升级关键词提取器后跑 `tools/reindex.mjs` 重算索引。
- 会话日志里已被 prune 且归档前就找不到的事件，只在 `evicted.jsonl` 记缺口，不假装归档成功。

## 自测

```bash
node test.mjs
```

## 深入

- [INSTALL.md](./INSTALL.md)：完整安装前提、卸载、故障处理。
- [CHANGELOG.md](./CHANGELOG.md)：版本变更与踩过的坑。
