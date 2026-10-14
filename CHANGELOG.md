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
