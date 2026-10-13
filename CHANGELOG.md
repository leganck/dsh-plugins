# Changelog

归档产物的**格式**未变；1.1.0 是打包与健壮性版本。

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
