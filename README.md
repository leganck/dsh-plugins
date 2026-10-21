# DSH 插件仓（记忆 + 索引加速 + 多根工作空间）

本仓库是一个**多插件仓库**：三个 DSH 插件 + 一个可选的远端检索服务。
所有插件零运行时依赖，版本以各自的 `package.json` 为准（下表不再写死版本号，避免漂移）。

| 插件 | 作用 | 依赖 |
|---|---|---|
| [`plugins/dsh-memory-archive`](plugins/dsh-memory-archive/) | **记忆**：每次压缩（compaction）把被折叠的**逐字**轮次写成 `segment_NNN.md`，并维护 `INDEX.md`，同时向会话注入指针，让早期工具输出在长会话里可被重新检索 | 无（纯 node 内置模块） |
| [`plugins/dsh-code-index`](plugins/dsh-code-index/) | **索引加速**：本地 SQLite FTS5/BM25 + 可选**远端**语义检索/重排（RRF 融合），五个工具 `code_index` / `code_search` / `code_map` / `code_index_status` / `code_index_deps` | 无（parser 组为可选增强，按需装） |
| [`plugins/dsh-multiroot`](plugins/dsh-multiroot/) | **多根工作空间**（脚手架）：`.dshworkspace.json` 声明多个根目录，`workspace_roots` 工具列出根 id/路径/只读/主根 | 无 |

> 0.10.0 起 code-index 为 **remote-only**：本地不再有嵌入模型与重排模型，
> 向量与重排都交给 [`server/code-index-service`](server/code-index-service/)；
> 不连服务端时用 `vectors: off` 做纯关键词检索（本地 FTS5，零模型）。
> 远端不可用会自动退化 + 60 秒冷却后重试，不需要重启。

## 为什么这些放一起

它们解决的是同一个问题的两面：**长会话里"信息在但找不到"**。

- 记忆插件负责**会话历史**：压缩会丢逐字内容，它把逐字内容重新变成可 grep 的档案。
- 索引插件负责**代码库**：grep 循环找代码慢，它用关键词+语义两路召回并排序。

前两个插件都是"把一次性成本换成可复用资产"：记忆插件写归档，索引插件把向量与索引交给远端服务长期复用（本机只留 FTS5）；多根插件则把"一个会话只能看一个目录"这件事变成可声明的注册表。

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

**安装期依赖**：三个插件都没有 `dependencies`（code-index 的 parser 组是运行期按需装，记忆插件与多根插件只用 node 内置模块），
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
package.json                    仓库根：workspaces + 统一脚本（test / market / release）
pnpm-workspace.yaml             工作区：只收 plugins/*（server 是 Python，不纳入）
.npmrc                          关掉 peer 自动安装（否则 install 会去拉一整份 DSH）
LICENSE / .nvmrc                授权与 Node 版本
scripts/
  ci-fixture.mjs                确定性夹具仓库（测试没给 --repo 时自动用它）
  release-all.mjs               遍历插件、跑各自的 scripts.release
  validate-market.mjs           用官方校验器验 market/index.json（format 1）
  check-yaml.mjs                所有 cordis.patch.yml + CI 工作流的语法检查
.github/workflows/ci.yml        矩阵：三插件自测 + 插件源一致 + 配置语法
market/                         插件源（Discover 索引）：index.json + 生成器（自动发现 plugins/*）
plugins/
  dsh-memory-archive/
    index.js                    插件入口（apply(ctx, config)）
    build-plugin-dist.ps1       打包：npm pack → tgz/zip/sha256 → release/
    release/                    SHA256SUMS.txt 进 git；tgz/zip 是构建产物、不进 git
    tools/                      reindex / verify-segments / verify-evicted / backfill-session
    test.mjs                    自测
  dsh-code-index/
    index.js                    插件入口 + 五个工具
    lib/                        store / chunker / scan / query / search / indexer / remote / repo
    tools/                      远端同步与题库校验（remote-index-sync / build-oss-index / verify-cases）
    release/                    发布校验记录（SHA256SUMS.txt；tgz 是构建产物、不进 git）
    verify-install.mjs          装后验证：包加载 + 五工具注册 + roots 白名单 + parser 状态
    test.mjs                    核心自测（FTS/切块/扫描排除/增量；缺 --repo 时用夹具）
    test-plugin.mjs             插件接口自测（缺 --repo 时用夹具）
    test-remote.mjs             远端地址/重排/配置校验（不需模型/网络）
  dsh-multiroot/
    index.js                    插件入口：配置校验 + 注册 workspace_roots
    lib/registry.js             根注册表（发现 / 校验 / 规范化）
    docs/analysis/              多根工作空间调研与实现设计（从仓库根 docs/analysis 迁入）
    test.mjs                    自测
server/
  review-service/               自研 GitLab MR AI 评审（Python）：webhook + 镜像仓 + 语法图 + 并行流水线
    Dockerfile                  镜像含 git + tree-sitter（231 MB）
    compose.yaml                单容器部署（/data 卷：任务库/镜像仓/工作树）
    docs/                       P0 验证报告、图谱说明
  code-index-service/           远端索引服务（Python）：/v1 索引层 + /embed + /rerank
    Dockerfile                  一个文件出 4 种镜像：base / nomodel / embed / embed-rerank
    compose.yaml (+.gpu/.build) 开箱即用部署（镜像自带嵌入模型）
    scripts/fetch-models.mjs    拉模型到 models/（构建用，不进 git）
    selftest.py                 服务端自测（43 项；FAKE_EMBED 模式不需要模型）
    deploy/legacy/              容器化之前的非容器路径，仅参考
```

## 多插件仓库约定（新增插件照做即可）

1. 建目录 `plugins/<name>/`，至少含：`package.json`（`name` 用 `@local/dsh-*`、`dsh.bundle.patch`、
   `repository.directory`、`engines.node`、`license`）、`cordis.patch.yml`、`index.js`、`README.md`、`test.mjs`；
2. `package.json` 补 `dsh.market`（`title` / `description` 用本地化对象、`category`、`labels`、`icon`）——
   插件源与 Discover 直接读它，**不用改生成器**；
3. `scripts.test` 不许依赖机器路径：需要仓库就用 `scripts/ci-fixture.mjs` 兜底（`--repo` 仍优先）；
4. 有发布物就声明 `scripts.release`；没有就留空（`pnpm release` 会 skipped，不算失败）；
5. `pnpm test` 与 `pnpm market:check` 通过即可提交 —— CI 会自动把新插件纳入矩阵。

## 自测

```bash
pnpm test                                  # 三个插件全部自测（推荐）
pnpm market:check                          # 插件源是否与 plugins/* 一致
node scripts/check-yaml.mjs                # 配置/工作流语法
node scripts/validate-market.mjs           # 官方 format 1 校验（需先装校验器，见下）
```

索引插件的测试需要一个仓库来扫描，**不传 `--repo` 时会自动建一个确定性夹具仓库**
（`scripts/ci-fixture.mjs`），所以本机与 CI 都能直接跑：

```bash
cd plugins/dsh-code-index
node test.mjs                              # 自动夹具
node test.mjs --repo D:/Code/your-repo     # 指定真实仓库（显式优先，不会偷偷换夹具）
```

## 插件源（market）

仓库自带一个 DSH「插件源」，用户在 **Plugins → Discover → 添加源** 填：

```
https://raw.githubusercontent.com/leganck/dsh-plugins/main/market/index.json
```

生成器**自动发现** `plugins/*`：版本取各自 `package.json`、commit 取 HEAD、
展示文案取 `package.json` 里的 `dsh.market`（缺省也能收录，只是文案退化并给出警告）。
所以**新增插件不需要改生成器**。

```bash
pnpm market          # 重新生成 market/index.json
pnpm market:check    # 与仓库里的文件比对，漂移则退出 1（CI 用）
```

官方校验（与 DSH 本体同一个包）：

```bash
npm i --no-save @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2
node scripts/validate-market.mjs
```

详见 [`market/README.md`](market/README.md)。

## 服务端镜像（GHCR）

服务端 [`server/code-index-service`](server/code-index-service/) 已容器化，**模型内置、开箱即用**：

```bash
docker run -d --name dsh-embed -p 127.0.0.1:18000:8000 \
  -v dsh-embed-data:/data ghcr.io/leganck/dsh-embed:latest-cpu
```

| 变体 | 拉取（压缩） | 未压缩 | 内容 / 用途 |
|---|---|---|---|
| `latest-cpu` | **≈267 MB** | 485 MB | cpu 底座 + 嵌入模型，**默认推荐** |
| `latest-gpu` | ≈1.7 GB | 3.06 GB | gpu 底座（CUDA 12 + ORT 1.19.2，Pascal 可用）+ 嵌入模型 |
| `latest-cpu-rerank` / `latest-gpu-rerank` | ≈759 MB / ≈2.0 GB | 1.06 / 3.63 GB | 再加重排模型（默认不需要：服务端 `rerank` 默认 off） |
| `base-cpu` / `base-gpu` | ≈0.09 / 1.5 GB | 281 MB / 2.86 GB | 只有运行时，模型自己挂载 |
| ~~`jina-cpu` / `jina-gpu`~~ | 已停止发布 | — | 代码检索改为**挂载模型**：`fetch-jina-model.mjs` + `compose.jina.yaml`（不再占镜像矩阵）。见 [jina-v2.md](server/code-index-service/docs/jina-v2.md) / [image-matrix.md](server/code-index-service/docs/image-matrix.md) |

### 镜像体积怎么控制的

1. **默认只内置嵌入模型**（194 MB），重排模型（531 MB）单独出 `-rerank` 变体 ——
   服务端 `rerank` 默认 `off`，缺模型时 `/health` 报 `rerank_ready=false`、客户端自动回退，功能不缺。
2. **底座与应用分层**：`base-{cpu,gpu}` 单独构建，模型/代码更新只推上层，用户增量拉取小。
3. **做体积审计而不是拍脑袋**：`tokenizers --no-deps`（省掉 huggingface_hub 全家桶 ≈40 MB）、
   装完卸 `sympy/mpmath`（85 MB，实测不影响出向量）——cpu 底座从 388 MB 降到 281 MB。
4. **不用量化模型**：bge-base 的 int8 导出实测**向量塌缩**；rerank int8 在 CUDA 上算子支持差、
   CPU 上每候选 250 ms。省下的体积换不来可用性。
5. **不做"首启自动下载模型"**：破坏离线可用、把网络故障变成启动失败。要小镜像就 `base-*` + 挂载。

发布：`git tag server-v0.1.0 && git push origin server-v0.1.0` → `.github/workflows/publish-image.yml`
先推 base 再叠模型出 4 个变体，**每个变体都先在容器里跑 `selftest.py`（43 项）通过才推**。

## 评审服务（review-service，P1 已完成）

自研 GitLab MR AI 评审，参考 CodeRabbit 的评审主链路：

```bash
cp server/review-service/.env.example server/review-service/.env   # 填 GitLab/LLM
cd server/review-service && docker compose up -d
```

- 取数：镜像仓 + worktree + 本地 `git diff`（可回退 API 模式）；
- 上下文：语义检索（code-index-service）+ 语法图（tree-sitter，带置信度）+ `git grep`；
- 评审：Planner → 并行 Reviewer → 并行 Verifier → 降噪/去重 → 行内评论 + 汇总；
- 影子模式：`DRY_RUN=1` 只记录不发布，`python -m app.report` 导出噪声/成本/待标注清单；
- 测试：`app.selftest` 85 项 + 6 套验收（详见 `server/review-service/README.md`）。

镜像由 `.github/workflows/publish-review-image.yml` 在 `review-v*` tag 时构建并推送（容器内自测通过才推）。

## 版本与 tag 约定

历史 tag `v1.1.0` / `v1.1.1` 指的是**记忆插件**（当时本仓库只有它），保持不动。

本仓库变为多插件后，新版本请用**带插件前缀**的 tag：

```
memory-archive-v1.2.0
code-index-v0.10.1
```

打 tag 即发布：[.github/workflows/release.yml](.github/workflows/release.yml) 会
**解析 tag → 校验版本 → 打包 → 核对 SHA256SUMS → `gh release create` 上传资产**。
两条硬护栏：tag 里的版本必须**等于**该插件 `package.json` 的 `version`；产物名里必须带这个版本号。

### 三种安装/分发方式（都不依赖把 tgz 提交进 git）

| 方式 | 适合 | 做法 |
|---|---|---|
| **插件源（推荐）** | 日常安装、想随时升级 | Plugins → Discover 添加源 `https://raw.githubusercontent.com/leganck/dsh-plugins/main/market/index.json`；索引里的 git 源钉死 commit，装到的就是那个 commit 的目录 |
| **GitHub Release 资产** | 固定某个版本、离线/内网、不想让它跟着分支变 | 下面这条命令，target 换成对应 tag 的资产 URL |
| **本地构建** | 自己改代码后试装 | `pnpm release`（遍历插件跑各自的 `scripts.release`），产物在插件 `release/`，git 里只有 `SHA256SUMS.txt` |

```text
# GitHub Release 资产直接安装（install_bundle 支持 http(s) 的 .tgz）
plugin_manager(action: "install_bundle",
  target: "https://github.com/leganck/dsh-plugins/releases/download/code-index-v0.10.1/local-dsh-code-index-0.10.1.tgz")
```

> ⚠️ 两者的边界别搞混：**插件源（market index）只接受 `npm` 与 `git` 两种 source**，
> Release 资产 URL 不能写进 `market/index.json`；它只能作为 `install_bundle` 的 target
> （或手工下载）。反过来，git 源也不需要上传任何产物。

校验下载到的资产：

```powershell
Get-FileHash .\local-dsh-code-index-0.10.1.tgz -Algorithm SHA256   # 与 SHA256SUMS.txt 对比
```

新 tag 一律带插件前缀（见上）；历史 tag 保持不动。

## 索引插件的能力实测（历史口径）

40 个真实检索事件、14 个仓库、同一批 grep 基线（向量由服务端计算，指标与本地模型时代同口径）：

| 通道 | hit@10 |
|---|---|
| grep 循环（4 KB 预算） | 10% |
| 纯 FTS5（BM25） | 32.5% |
| 纯向量 | 37.5% |
| **混合（RRF k=20）** | **55%** |

成本：FTS5 建索引亚秒级/仓库；远端向量约 26.8 块/s（限速可调）、查询端到端约 19–30 ms。
