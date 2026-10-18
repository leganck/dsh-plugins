# DSH 插件仓（记忆 + 索引加速）

本仓库收录两个 DSH 插件，外加一个可选的远端检索服务：

| 插件 | 版本 | 作用 | 依赖 |
|---|---|---|---|
| [`plugins/dsh-memory-archive`](plugins/dsh-memory-archive/) | 1.2.0 | **记忆**：每次压缩（compaction）把被折叠的**逐字**轮次写成 `segment_NNN.md`，并维护 `INDEX.md`，同时向会话注入指针，让早期工具输出在长会话里可被重新检索 | 无（纯 node 内置模块） |
| [`plugins/dsh-code-index`](plugins/dsh-code-index/) | 0.10.1 | **索引加速**：本地 SQLite FTS5/BM25 + 可选**远端**语义检索/重排（RRF 融合），五个工具 `code_index` / `code_search` / `code_map` / `code_index_status` / `code_index_deps` | 无（parser 组为可选增强，按需装） |

> 0.10.0 起 code-index 为 **remote-only**：本地不再有嵌入模型与重排模型，
> 向量与重排都交给 [`server/code-index-service`](server/code-index-service/)；
> 不连服务端时用 `vectors: off` 做纯关键词检索（本地 FTS5，零模型）。
> 远端不可用会自动退化 + 60 秒冷却后重试，不需要重启。

## 为什么这两个放一起

它们解决的是同一个问题的两面：**长会话里"信息在但找不到"**。

- 记忆插件负责**会话历史**：压缩会丢逐字内容，它把逐字内容重新变成可 grep 的档案。
- 索引插件负责**代码库**：grep 循环找代码慢，它用关键词+语义两路召回并排序。

两个插件都是"把一次性成本换成可复用资产"：记忆插件写归档，索引插件把向量与索引交给远端服务长期复用（本机只留 FTS5）。

## 快速开始

安装按官方技能 `cordis-plugin-development` 的路径走：`plugin_manager` 的 `install_bundle`。

```text
plugin_manager(action: "install_bundle", target: "<release/*.tgz 或包目录的绝对路径>")
```

**target 优先传 `release/` 里的 `.tgz`**（tarball 形式）而不是包目录——pnpm 对**目录**用
`link:`（软链），源码目录会成为**运行时依赖**，删/移/`git clean` 就静默失效；对 `.tgz` 则解包成
**实体安装**，源码目录与运行时解耦。没有现成 `.tgz` 时先在插件目录跑 `node build-release.mjs`。

**前置条件**：profile 里 `tool-plugin-manager` 被 shipped patch 置为 `disabled: true`，
需要在 profile 补丁层按 id 覆盖成 `disabled: false` 并重启应用，`plugin_manager` 才可用。
另外本 profile 由应用独占管理，`dsh plugin --profile …` CLI 那条路不可用。

**安装期依赖**：两个插件都没有 `dependencies`（code-index 的 parser 组、记忆插件的依赖都不在安装期拉取），
所以安装是纯 JS、秒级，不会触发 `pendingBuilds`。code-index 需要 AST 切块时再
`code_index_deps action=install group=parser`（约 61 MB，按需）。

### 生效时机（实测，别搞混）

| 动作 | 结果 |
|---|---|
| 装**新** bundle | `application: "applied"` —— **HMR 热生效，不用重启** |
| **替换**已安装包（换 target 路径 / 目录↔tarball） | `application: "restart-required"` —— 要重启才加载新一代模块 |
| 改已加载插件的**代码** | 必须重启（cordis 不会重新 import 已加载模块） |
| 改 profile 补丁层（加/改行） | 补丁层本身热加载；**新增行**的插件通常要重启 |

### 本机踩过的坑（写在这里省时间）

1. **`approvedBuilds` 只在"待决定"时传。** 授权按包名**持久**保存在 profile 的
   `pnpm-workspace.yaml`（`allowBuilds`）。已经批准过的名字再传一次 → 服务端直接拒绝
   `<1s` 返回 `error.code: "stale-approval"`（`packageResult` 键整体缺失，pnpm 根本没跑）。
   正确做法：**重试时不带 `approvedBuilds`**。
2. **service 侧安装有空闲超时上界。** `plugin-manager` 的 `idleTimeoutMs` 默认 **600000 ms**：
   600 秒内没有任何捕获输出即被终止，`kind: "timeout"`、`application: "failed"`，并回滚
   manifest 与 lockfile。带生命周期脚本的重依赖包会撞上它（历史上 `onnxruntime-node` 的
   `postinstall` 就这样把安装拖到超时）。**缓解**：让它先跑一次，把构建产物落进 pnpm store；
   命中缓存的脚本不再执行，第二次重试通常 2 秒内干净退出。该值可在补丁层给 `plugin-manager` 行调大。
3. **重依赖不该写进 `package.json`（前两条的根治办法）。** 上面 1、2 两条都是"插件带着
   几百 MB 原生依赖"派生出来的。code-index **0.10.0 起直接把本地模型整个删掉**：
   `dependencies` 为空，安装期零下载、零审批；需要 AST 切块时只按需装 parser 组（约 61 MB）。
   **新增重依赖时请先问"它能不能按需装，或者干脆放到服务端"。**

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
market/                         插件源（Discover 索引）：index.json + 生成器
plugins/
  dsh-memory-archive/
    index.js                    插件入口（apply(ctx, config)）
    build-plugin-dist.ps1       打包：npm pack → tgz/zip/sha256 → release/
    release/                    随 tag 分发的静态产物（1.2.0）
    tools/                      reindex / verify-segments / verify-evicted / backfill-session
    test.mjs                    自测（106 项）
  dsh-code-index/
    index.js                    插件入口 + 五个工具
    lib/                        store / chunker / scan / query / search / indexer / remote / repo
    tools/                      远端同步与题库校验（remote-index-sync / build-oss-index / verify-cases）
    release/                    发布校验记录（SHA256SUMS.txt；tgz 是构建产物、不进 git）
    verify-install.mjs          装后验证：包加载 + 五工具注册 + roots 白名单 + parser 状态
    test.mjs                    核心自测（95 项：FTS/切块/扫描排除/增量）
    test-plugin.mjs             插件接口自测（74 项）
    test-remote.mjs             远端地址/重排/配置校验（30 项，不需模型/网络）
server/
  code-index-service/           远端索引服务（Python）：/v1 索引层 + /embed + /rerank
    selftest.py                 服务端自测（41 项，FAKE_EMBED 模式不需要模型）
    start.sh / compose.yaml     部署（CUDA 12 + onnxruntime 1.19.2，兼容 Pascal GPU）
docs/
  analysis/                     多根工作空间调研存档（未实施）
  rollback/                     install_bundle 之前的手写补丁回滚备注
```


## 自测

```powershell
# 记忆插件
cd plugins/dsh-memory-archive; node test.mjs

# 索引插件（--repo 指定一个真实仓库）
cd plugins/dsh-code-index
node test.mjs --repo D:\Code\your-repo
node test-plugin.mjs --repo D:\Code\your-repo
node test-remote.mjs
```

## 插件源（market）

仓库自带一个 DSH「插件源」，用户在 **Plugins → Discover → 添加源** 填：

```
https://raw.githubusercontent.com/leganck/dsh-plugins/main/market/index.json
```

发版流程：改插件 → 提交 → `node market/build-index.mjs`（版本取各插件 `package.json`、commit 取 HEAD）→ 提交并推送 `market/index.json`。
详见 [`market/README.md`](market/README.md)。

## 版本与 tag 约定

历史 tag `v1.1.0` / `v1.1.1` 指的是**记忆插件**（当时本仓库只有它），保持不动。

本仓库变为多插件后，新版本请用**带插件前缀**的 tag：

```
memory-archive-v1.2.0
code-index-v0.10.1
```

分发产物仍在插件自身的 `release/` 目录（`/-/raw/<tag>/plugins/<plugin>/release/<file>`），旧 tag 继续按其原本路径提供服务。

## 索引插件的能力实测（历史口径）

40 个真实检索事件、14 个仓库、同一批 grep 基线（向量由服务端计算，指标与本地模型时代同口径）：

| 通道 | hit@10 |
|---|---|
| grep 循环（4 KB 预算） | 10% |
| 纯 FTS5（BM25） | 32.5% |
| 纯向量 | 37.5% |
| **混合（RRF k=20）** | **55%** |

成本：FTS5 建索引亚秒级/仓库；远端向量约 26.8 块/s（限速可调）、查询端到端约 19–30 ms。
