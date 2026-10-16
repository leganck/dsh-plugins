# DSH 插件仓（记忆 + 索引加速）

本仓库收录两个本地 DSH 插件，都是**纯 Node、无外部服务依赖**（索引插件的向量模型本地推理）。

| 插件 | 版本 | 作用 | 依赖 |
|---|---|---|---|
| [`plugins/dsh-memory-archive`](plugins/dsh-memory-archive/) | 1.1.1 | **记忆**：每次压缩（compaction）把被折叠的**逐字**轮次写成 `segment_NNN.md`，并维护 `INDEX.md`，同时向会话注入指针，让早期工具输出在长会话里可被重新检索 | 无（纯 node 内置模块） |
| [`plugins/dsh-code-index`](plugins/dsh-code-index/) | 0.1.0 | **索引加速**：本地代码库混合检索（SQLite FTS5/BM25 + 本地 ONNX 向量 → RRF 融合），三个工具 `code_index` / `code_search` / `code_index_status` | `onnxruntime-node`、`@huggingface/transformers`（可选，缺失则退化为纯关键词） |

## 为什么这两个放一起

它们解决的是同一个问题的两面：**长会话里"信息在但找不到"**。

- 记忆插件负责**会话历史**：压缩会丢逐字内容，它把逐字内容重新变成可 grep 的档案。
- 索引插件负责**代码库**：grep 循环找代码慢，它用关键词+语义两路召回并排序。

两个插件都是"把一次性成本换成可复用资产"：记忆插件写归档，索引插件写向量缓存（内容寻址，跨版本复用）。

## 快速开始

安装按官方技能 `cordis-plugin-development` 的路径走：`plugin_manager` 的
`install_bundle`，target 传**包目录的绝对路径**。`install.ps1` 默认就是这个流程——
它检查前置条件并打印应当交给 agent 执行的调用（脚本无法调用工具）：

```powershell
# 官方路径（默认）：前置检查 + 打印 install_bundle 调用
pwsh -File install.ps1

# 退路：复制到 bundle 目录 + 手写 file:// 补丁行（非官方，仅在 plugin_manager 不可用时）
pwsh -File install.ps1 -Mode Legacy -SkipNpm

# 只看会做什么，不落盘
pwsh -File install.ps1 -DryRun
```

**前置条件**：profile 里 `tool-plugin-manager` 被 shipped patch 置为 `disabled: true`，
需要在 profile 补丁层按 id 覆盖成 `disabled: false` 并重启应用，`plugin_manager` 才可用。
另外本 profile 由应用独占管理，`dsh plugin --profile …` CLI 那条路不可用。

装完**需要重启 DSH 应用**（cordis 不会重新 import 已加载的模块）。

验证：

```powershell
# 官方路径：读 install_bundle 返回的 application / warnings，并用 cordis_inspect_query 确认
# 退路（手写行）：看插件自己写的加载标记
Get-Content "$env:USERPROFILE\.dsh\archive\_loaded.json" -Raw      # 记忆插件
Get-Content "$env:USERPROFILE\.dsh\code-index\_loaded.json" -Raw   # 索引插件
```

## 目录结构

```
install.ps1                     仓库级安装入口（bundle 目录 + 幂等补丁）
plugins/
  dsh-memory-archive/
    index.js                    插件入口（apply(ctx, config)）
    build-plugin-dist.ps1       打包：npm pack → tgz/zip/sha256 → release/
    release/                    随 tag 分发的静态产物（v1.1.1）
    tools/                      reindex / verify-segments / verify-evicted / backfill-session
    test.mjs                    自测（106 项）
  dsh-code-index/
    index.js                    插件入口 + 三个工具
    lib/                        store / chunker / scan / query / search / indexer / embedder
    test.mjs                    核心自测（32 项）
    test-plugin.mjs             插件接口自测（24 项）
```

## 自测

```powershell
# 记忆插件
cd plugins/dsh-memory-archive; node test.mjs

# 索引插件（--repo 指定一个真实仓库）
cd plugins/dsh-code-index
node test.mjs --repo D:\Code\your-repo
node test-plugin.mjs --repo D:\Code\your-repo
```

## 版本与 tag 约定

历史 tag `v1.1.0` / `v1.1.1` 指的是**记忆插件**（当时本仓库只有它），保持不动。

本仓库变为多插件后，新版本请用**带插件前缀**的 tag：

```
memory-archive-v1.2.0
code-index-v0.1.0
```

分发产物仍在插件自身的 `release/` 目录（`/-/raw/<tag>/plugins/<plugin>/release/<file>`），旧 tag 继续按其原本路径提供服务。

## 索引插件的能力实测（本机口径）

40 个真实检索事件、14 个仓库、同一批 grep 基线：

| 通道 | hit@10 |
|---|---|
| grep 循环（4 KB 预算） | 10% |
| 纯 FTS5（BM25） | 32.5% |
| 纯向量 | 37.5% |
| **混合（RRF k=20）** | **55%** |

成本：FTS5 建索引亚秒级/仓库；向量 GPU(fp16/DirectML) 约 47 块/s、CPU 占用 0.25 核；查询约 12 ms。
