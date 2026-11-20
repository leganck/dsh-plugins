## 1.3.0 — 2026-11-20

### 为什么改：归档在写，经验没被抽
归档把每次压缩的逐字轮次写成了可 grep 的段落，但**经验管道只能靠人手动重放归档**才拿得到素材
（`server/storage-hub` 的 `POST /v1/admin/exp/replay`）。真实工作记录是经验抽取的唯一原料，
它就在磁盘上，却要另一个人记得去跑一次——这是接线问题，不是能力问题。

### 改动
1. **压缩落盘后自动触发一次经验抽取**：`writeSegment()` 写完 `segment_NNN.md` / `index.jsonl` /
   `INDEX.md` 之后，把该段的 `summary` + 被 shadow 的原文 `POST {exp.url}/v1/exp/extract`
   （body 契约：`session_id / segment_no / workflow / summary / verbatim / apply`）。
2. **fire-and-forget，绝不阻塞压缩**：`fire()` 同步返回，`writeSegment()` 不 await、
   不依赖返回结果。端点**超时 / 500 / 连接被拒绝**时，落盘内容与没开 exp 时**逐字节一致**
   （`test-exp-hook.mjs` 用同一个 compaction id 逐字节比对钉死），指针照发；
   失败只 `logger.warn`。
3. **同会话连续失败 3 次退避**：避免容器不可达时每段都白等一次 `exp.timeoutMs`（默认 15s）；
   成功一次清零。服务端 `200 + skipped`（未配置 LLM）不算失败。
4. **`mode=client` 本机降级**：容器不可达时插件自己调本机 OpenAI 兼容 LLM，抽完只把候选
   `POST /v1/exp/import`。JS 侧 prompt 自维护（三镜头 / 九类垃圾 / 五类 category 含 process 拒收齐全）。
5. **`workflow` slug**：会话标题优先、否则 cwd basename；`ERP Bug：订单/退款` → `erp-bug-订单-退款`。
6. **200KB 上限**：`verbatim` 超过 `exp.maxVerbatimBytes`（默认 204800）按 UTF-8 边界截断并 warn。
7. 新增配置块 `exp.*`（默认**关闭**）：`cordis.patch.yml` 与 `DEFAULTS` 同步；
   激活标记 `_loaded.json` 记录 `exp.enabled/mode`，可判定运行中的是这份代码。
8. 新增 `exp-hook.mjs`（触发器、payload、prompt、client 模式、退避）与 `test-exp-hook.mjs`；
   `package.json` 的 `files` 带上 `exp-hook.mjs`（`index.js` 依赖它，漏了会装不起来）。

### 测试
`node test.mjs` → **109 项全过**（既有行为未变）
`node test-exp-hook.mjs` → **78 项全过**（新增：触发一次且字段齐全、三种失败下落盘一致、
`enabled=false`/`minSegmentBytes` 不触发、连续 3 次失败退避、workflow slug、200KB 截断、
prompt 三镜头/九类垃圾/五类 category、client 模式 import 路径）


## 1.2.0 — 2026-10-17

### 为什么改：写得多、读得少
本会话归档了 **12 段 / 5,253 事件 / 2,442 次工具调用（8.05 MB）**，但**被读取 0 次**。
旧指针的门槛是「when the checkpoint summary above is insufficient」—— 它要求模型**自评"摘要够不够"**，
而摘要通常已经写得很完整，于是这个条件几乎永不成立。

### 依据：对 Cursor 的取证
本机 Cursor 的 `…/agent-transcripts/<id>/compaction/` 与历史取证文件显示：它会 `read` 自己的 `INDEX.md`，
并用**精确标识符**（`PENDING_PAYMENT`、工单号 `10060`、`demoOrderQuery`）grep 自己的 `segment_*.md`。
即真实触发条件是「**要精确回忆某个标识符/数值/原始输出**」，而不是"摘要不够"。

### 改动
1. **指针改成任务式触发条件**：明确列出"issue id / 状态常量 / SQL 结果 / 测得的数字 / 文件路径 / diff"，
   并直接写 "grep these files first"
2. **关键词内联**：新段与最近 4 段的关键词直接列在指针里（省掉"先读 INDEX 才知道 grep 什么"）
3. **累计规模可见**：`Archived so far: N segments, X events, Y tool calls — none of it is in your context now`
4. **新增 `tools/memory-search.mjs`**：一次调用完成归档检索
   - 多词默认 AND · `--re` 正则 · `--session/--dir/--limit/--context/--json`
   - 实测：`node tools/memory-search.mjs "净负 重排"` 一秒定位到被推翻的旧结论所在段行

### 测试
`node test.mjs` → **109 项全过**（新增：任务式触发条件、grep-first、关键词内联、累计规模四项断言）

# Changelog

归档产物的**结构**未变（`segment_*.md` 照旧）；1.1.1 重做了 INDEX 关键词并新增补齐工具，
1.1.0 是打包与健壮性版本。

## 1.1.1 — 2026-10-14

- **INDEX 关键词重做**（`KEYWORDS_VERSION = 2`）。旧版只取词频最高的 8 个词，实测结果是
  一串路径与运行时噪声：`Users`、`you`、`node_modules`、`Line`、`json`、`tool`、
  `call`、`session`——读者无法据此判断该打开哪一段。现在：
  - **大小写折叠**：`cursor` 与 `Cursor` 不再各占一格；平局按**码点**排序而不是
    `localeCompare`，同一段文本在任何 host locale 下产出同一份列表。
  - **三层噪声过滤**：英语虚词（补上了此前漏掉的 `the`/`and`）、通用代码与转写词汇
    （`json`、`const`、`callId`、`seq`……）、路径与主机片段。用户目录名与 cwd 路径段
    **按会话动态推导**，不硬编码机器名；`***JWT***`/`***REDACTED***` 等占位符永不成词。
  - **按形态加权**：工单号（`DEMO-3459`、`DEMOPRD-5170`）、文件名（`index.jsonl`）、
    `CONSTANT_CASE`、`CamelCase`、连字符复合词（`demo-crm-order-5`）优先于普通小写词；
    UUID 片段不会被误判成工单号。
  - **中文短语**按虚词切分后原样保留（2–8 字），因此可直接 grep；互相包含的短语只留一个。
  - 实测同一批归档：`demo, null, java, Line, order, main, Code, false` →
    `demo-3459, demo, POS, demoPayBook, order, pay, orderInfo, demo-svc-pay`。
- **`index.jsonl` 新增 `keywordsVersion`**：使"哪些行由旧版提取器生成"可判定，重复补齐为幂等。
- **新增 `tools/reindex.mjs`**：从已有 segment 文件重算关键词，只重写 `index.jsonl` 与
  `INDEX.md`（各自保留一份 `.bak`）；支持 `--dry-run`、`--session`、`--force`。会话 cwd 从
  会话日志首行恢复（无日志时退化为只用 home 目录噪声），因此补齐结果与在线写入一致。
- `INDEX.md` 顶部说明 `Keywords` 回答的是"哪一段里有这个"，以及它的选取口径。
- 新增导出 `KEYWORDS_VERSION`、`keywordsOf`、`keywordNoiseFor`、`keywordNoiseForArchived`、
  `renderIndex`，供校验与补齐工具复用。
- 自测从 **88 项增至 104 项**（+3 索引断言，+13 提取器行为）。
- **一个明确取舍**：转义序列与路径分隔符在渲染文本里同形——实测同一段里既有
  `…\Temp\node_modules\…` 也有 `…$js=@'\nconst`，单反斜杠 `\n` 838 处、单反斜杠 `\Users`
  82 处。插件只吞掉无歧义的转义（其后是空白/引号/反斜杠/行尾），宁可偶尔留下 `nconst`
  这种**原文可见、可 grep** 的粘读词，也不产生 `ode_modules` 这种**原文里不存在、
  grep 不到**的碎片——后者是坏索引项。

## 1.1.0 — 2026-10-13

- **激活标记可配置**：新增 `markerFile` 配置项，以及优先级更高的
  `DSH_MEMORY_ARCHIVE_MARKER` 环境变量。
  - 之前自测会写入并**删除**安装目录里的 `_loaded.json`——在已安装的 bundle 里跑
    `node test.mjs` 会删掉正在运行的 app 的标记，使人无法判断插件是否加载。现已修复：
    自测把标记重定向到临时目录，并断言安装目录**不被触碰**。
  - 只有只读或包管理（`node_modules`）安装位才需要覆盖；默认仍是模块旁边的
    `_loaded.json`。相对路径按**模块所在目录**解析，不按会话 cwd。
  - 断言用的不变量是「测试运行**未创建也未修改**模块旁的标记」，而不是「标记不存在」——
    因为在**已安装的 bundle 里**跑自测时，运行中的 app 本来就写了一个标记，那时它必须原样保留。
- 标记内容新增 `markerFile`（自描述写到了哪里）；`markerFile` 的父目录不存在会自动创建。
- 导出 `BUILD` 常量，便于外部校验器核对已加载版本。
- `package.json`：版本、`license`、`repository`、`homepage`、`bugs`、`keywords`、
  `engines`（>= 20）、`files`、`scripts.test`。
- 新增 `LICENSE`、`CHANGELOG.md`、`INSTALL.md`、`install.ps1`。
- 自测从 **83 项增至 88 项**（新增 5 项全部针对激活标记行为）。
- 文档：补全三条安装路径；验证脚本的引用改为「位于源码仓库，不在发布包内」，不再指空。

## 1.0.0 — 2026-10-13

首个纳入版本管理的版本。此前的开发过程（同日）修复了三个实机缺陷：
挂载前历史只归档 5/436、`[tool-call]` 占位符丢失工具名与参数、`shadowedRange` 被照抄导致
范围误导；并新增 `compaction/prune` 的 `evicted.md` / `evicted.jsonl` 落盘通道。
