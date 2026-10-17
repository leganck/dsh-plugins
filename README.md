# DSH 插件仓（记忆 + 索引加速）

本仓库收录两个本地 DSH 插件，都是**纯 Node、无外部服务依赖**（索引插件的向量模型本地推理）。

| 插件 | 版本 | 作用 | 依赖 |
|---|---|---|---|
| [`plugins/dsh-memory-archive`](plugins/dsh-memory-archive/) | 1.1.1 | **记忆**：每次压缩（compaction）把被折叠的**逐字**轮次写成 `segment_NNN.md`，并维护 `INDEX.md`，同时向会话注入指针，让早期工具输出在长会话里可被重新检索 | 无（纯 node 内置模块） |
| [`plugins/dsh-code-index`](plugins/dsh-code-index/) | 0.8.0 | **索引加速**：本地代码库混合检索（SQLite FTS5/BM25 + ONNX 向量 → RRF 融合），四个工具 `code_index` / `code_search` / `code_index_status` / `code_index_deps`；算力与索引位置可配（本机 GPU/CPU，或远端 [`server/`](server/code-index-service/)：`/v1` 索引层 + `/embed` + `/rerank`） | `onnxruntime-node`、`@huggingface/transformers`（可选，按需装；缺失则退化为纯关键词） |

## 为什么这两个放一起

它们解决的是同一个问题的两面：**长会话里"信息在但找不到"**。

- 记忆插件负责**会话历史**：压缩会丢逐字内容，它把逐字内容重新变成可 grep 的档案。
- 索引插件负责**代码库**：grep 循环找代码慢，它用关键词+语义两路召回并排序。

两个插件都是"把一次性成本换成可复用资产"：记忆插件写归档，索引插件写向量缓存（内容寻址，跨版本复用）。

## 快速开始

安装按官方技能 `cordis-plugin-development` 的路径走：`plugin_manager` 的 `install_bundle`。
**target 优先传 `release/` 里的 `.tgz`**（tarball 形式）而不是包目录——pnpm 对**目录**用
`link:`（软链），源码目录会成为**运行时依赖**，删/移/`git clean` 就静默失效；对 `.tgz` 则解包成
**实体安装**，源码目录与运行时解耦。`install.ps1` 默认就是这个流程——它检查前置条件并打印
应当交给 agent 执行的调用（脚本无法调用工具）：

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

### 生效时机（实测，别搞混）

| 动作 | 结果 |
|---|---|
| 装**新** bundle | `application: "applied"` —— **HMR 热生效，不用重启** |
| **替换**已安装包（换 target 路径 / 目录↔tarball） | `application: "restart-required"` —— 要重启才加载新一代模块 |
| 改已加载插件的**代码** | 必须重启（cordis 不会重新 import 已加载模块） |
| 改 profile 补丁层（加/改行） | 补丁层本身热加载；**新增行**的插件通常要重启 |

### 本机踩过的三个坑（写在这里省时间）

1. **`approvedBuilds` 只在"待决定"时传。** 授权按包名**持久**保存在 profile 的
   `pnpm-workspace.yaml`（`allowBuilds`）。已经批准过的名字再传一次 → 服务端直接拒绝
   `<1s` 返回 `error.code: "stale-approval"`（`packageResult` 键整体缺失，pnpm 根本没跑）。
   正确做法：**重试时不带 `approvedBuilds`**。
2. **service 侧安装有空闲超时上界。** `plugin-manager` 的 `idleTimeoutMs` 默认 **600000 ms**：
   600 秒内没有任何捕获输出即被终止，`kind: "timeout"`、`application: "failed"`，并回滚
   manifest 与 lockfile。带生命周期脚本的重依赖包会撞上它——`onnxruntime-node` 的
   `postinstall` 会 bootstrap `global-agent` 走代理，脚本结束后 pnpm 迟迟不退出，于是
   pnpm 自己打印 `Done in 2s` 却仍被判超时。**缓解**：让它先跑一次，把构建产物落进 pnpm store；
   命中缓存的脚本不再执行，第二次重试通常 2 秒内干净退出。
   该值可在补丁层给 `plugin-manager` 行调大。
3. **重依赖不该写进 `package.json`（前两条的根治办法）。** 上面 1、2 两条都是"插件带着
   几百 MB 原生依赖"派生出来的。`dsh-code-index` 从 **0.3.0** 起把
   `onnxruntime-node` / `@huggingface/transformers` 改成**运行时按需安装**到自管目录
   （`code_index_deps` 工具，`npm install --ignore-scripts`），于是：
   装插件 **1.6 秒、`pendingBuilds` 无此键、零审批**；需要向量时再下 46 秒 / 661 MB，
   修剪非本平台二进制后 264 MB。**新增重依赖时请先问"它能不能按需装"。**

   实测对照（同一次安装动作）：

   | | 0.2.1（把依赖写进 package.json） | 0.3.0（按需安装） |
   |---|---|---|
   | `pendingBuilds` | `["onnxruntime-node","protobufjs","sharp"]` → 需人类批准 | **无此键** |
   | 安装耗时 | 287+208 MB 下载；曾撞 10 分钟超时并回滚两次 | **`Done in 1.6s`** |
   | 包变动 | `+61` | **`+1 -85`**（顺带清掉旧依赖树） |

4. **同一个版本号装了不同内容 → `error.code: "ambiguous-install"`。** 实测：改了 tarball 内容
   但 `package.json` 里版本仍是 `0.3.0`，pnpm 判定 `Already up to date`（什么都没重装），
   管理器随即报 `ambiguous-install`、`changed: false` 并**保护性地拒绝**（什么都没被破坏）。
   正确做法：**改了内容就升版本号**（`0.3.0 → 0.3.1`）。这个报错是对的——同版本号本该同内容。

装完**用返回字段判定**，不要只看插件自己的标记：

```
install_bundle → application / warnings / pendingBuilds   （机器可读回执）
```

补充验证（本 profile **没有** `cordis_*` 工具，所以拿不到 `cordis_inspect_query`）：

```powershell
# 装载与激活状态
plugin_manager(action: "list_bundles")   # installed / enabled / version
plugin_manager(action: "list_plugins")   # moduleName 是包名还是 file:// ；fiberPhase 是否 active

# 插件自己写的加载记录（含宿主 pid 与 node 版本，用来区分 app 与测试进程）
Get-Content "$env:USERPROFILE\.dsh\code-index\_boot.log"           # 索引插件
Get-Content "$env:USERPROFILE\.dsh\archive\_loaded.json" -Raw      # 记忆插件

# 索引插件的端到端验证（从安装后的包路径跑，含 roots 白名单断言，不跑模型）
node plugins/dsh-code-index/verify-install.mjs
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
    index.js                    插件入口 + 四个工具
    lib/                        store / chunker / scan / query / search / indexer / embedder / remote / repo
    tools/                      模型下载、评测、基准、远端同步（bench-* / remote-index-sync）
    release/                    随 tag 分发的静态产物（.tgz + SHA256SUMS.txt）
    verify-install.mjs          装后验证：从**安装后的包路径**加载 + roots 白名单断言 + 依赖解析
    test.mjs                    核心自测（147 项；带模型 150 项）
    test-plugin.mjs             插件接口自测（65 项）
    test-remote.mjs             远端客户端与配置校验（45 项，不需要模型/网络）
server/
  code-index-service/           远端索引服务（Python）：/v1 索引层 + /embed + /rerank
    selftest.py                 服务端自测（41 项，FAKE_EMBED 模式不需要模型）
    start.sh / compose.yaml     部署（CUDA 12 + onnxruntime 1.19.2，兼容 Pascal GPU）
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
