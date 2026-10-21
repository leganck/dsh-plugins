# P0 验证报告（评审服务 v4 计划）

> 时间：2026-10-20。全部数字为本机/容器实测；估算值单独标注。
> 结论先行：P0 的四个关键假设 **全部成立**，可以进入 P1。

## 1. tree-sitter（Python 侧）可用性 ✅

| 项 | 实测 |
|---|---|
| 依赖 | `tree-sitter==0.26.0` + `tree-sitter-language-pack==1.22.1`（pip 安装，无编译） |
| 导入 | `from tree_sitter_language_pack import get_parser, get_language` |
| 语言覆盖 | **8/8**：python / javascript / typescript / tsx / java / go / rust / groovy |
| 解析吞吐（Go 仓库） | 456 文件 / 1.7 MB → **175 ms，2607 文件/s**，解析错误 0，峰值内存 **51 MB** |
| 解析吞吐（混合 JS+PY） | 18 文件 → 22 ms，**816 文件/s**，错误 0，峰值 18 MB |
| 计划门槛 | ≥500 文件/s → **达标 5 倍** |

**踩坑记录**：tree-sitter 0.26 移除了 `Language.query()`，必须用 `Query(language, src)` + `QueryCursor(q).captures(node)`（返回 `{捕获名: [节点]}`）。`app/chunker.py` / `app/graph.py` 必须按新 API 写。

**Windows 注意**：`tree-sitter-language-pack` 没有 cp312-win_amd64 wheel（只有 Linux/macOS），所以**开发与 CI 必须跑在 Linux 容器里**——这与生产部署形态一致，不是问题。

## 2. 语法图原型 ✅（含一个重要发现）

用 tree-sitter query 抽取 defs / imports / calls，写入 SQLite，再按名字消歧（同文件 → 全仓唯一 → 多候选）：

| 仓库 | 文件 | 符号 | import 边 | call 边 | 建图耗时 | 峰值内存 |
|---|---|---|---|---|---|---|
| energy（Go 为主） | 456 | 5,717 | 1,393 | 22,394 | **390 ms** | 29 MB |
| 混合（JS+PY） | 18 | 132 | 68 | 1,434 | 47 ms | 22 MB |

**消歧结果（Go 仓库）**：解析成功 6,303 / 多候选 3,309 / 未解析 14,175（≈63%，主要是标准库与第三方调用），消歧耗时 134 ms。

→ **重要结论**：纯语法图对"仓库内调用"的解析率只有约 26% + 14% 多候选。这**验证了计划里的门控规则**：低置信边只能用于扩展上下文，**不能作为 critical/major 结论的依据**；P2 再给主力语言接 jedi/gopls 提精度。

| 查询 | 实测 |
|---|---|
| callers（按被调符号 id，join 调用点路径） | **p50 < 0.01 ms，p95 < 0.01 ms**（100 次抽样） |
| 计划门槛 | p95 < 50 ms → **达标 5000 倍** |

## 3. 镜像仓 + worktree ✅

在 WSL 上对 14.6 MB 的 Go 仓库（源码在 9p 挂载上，属于**悲观**测法）：

| 操作 | 实测 |
|---|---|
| `git clone --mirror --no-local`（一次性） | **1,038 ms**（镜像 7.0 MB） |
| `git fetch origin`（无变更） | **83 ms** |
| `git fetch origin <ref>`（有更新） | **45 ms** |
| `git worktree add --detach`（525 文件） | **135 ms** |
| `git diff base...HEAD` | **2 ms** |

→ 单 MR 的 git 侧开销约 **200–300 ms**（fetch + worktree + diff），远小于 3 min 的端到端预算。

## 4. chunker golden 夹具 ✅（P1 parity 的基准）

用插件（JS）chunker 对本地仓库采样生成：

| 项 | 实测 |
|---|---|
| 文件 | **41 个**（JS 13 / Python 18 / Go 10） |
| 块 | **122 个**，全部走 **AST** 策略（无 heuristic 降级） |
| 夹具 | `tests/fixtures/chunk-golden.json`，29.4 KB |
| 生成器 | `spikes/make_chunk_golden.mjs`（可重跑） |

说明：本地插件依赖目录已装 `tree-sitter@0.21.1` + java/js/ts/groovy/go/python 语法包（60.6 MB），所以 golden 是多语言 AST 结果，可直接用于 Python 版 chunker 的 parity 测试（块数一致、块边界 ≥95% 相同）。

## 5. 未完成项（不阻塞 P1）

| 项 | 原因 | 处理 |
|---|---|---|
| 并行 429 实测 | 需要模型 API key 与真实 GitLab | 放到 P1 影子模式一起测（用真实流量统计 429 比例） |
| 真实 GitLab 克隆/同步 | 内网地址与 token 未提供（第 10 节待确认项） | P1 开始前需要你提供 |
| Java/TS 大仓库样本 | 本机只有 Go/JS/PY 仓库 | P1 用真实仓库补 |

## 6. P1 默认参数（按 P0 数据定，可在 P1 调）

| 参数 | 取值 | 依据 |
|---|---|---|
| `REVIEW_CONCURRENCY` | 4 | 建图 390 ms/454 文件，4 并发仍有富余 |
| `MAX_WORKTREES` | 6 | worktree 135 ms/525 文件，磁盘按并发×检出大小估 |
| 索引同步频率 | 每项目 ≥10 min 一次 | fetch 45–83 ms，足够便宜但没必要每次 MR 都同步 |
| 图谱构建 | 每次分支变更后增量 | 390 ms 全量，增量更省 |
| chunker parity 阈值 | 块数一致 + 边界 ≥95% | golden 已备好 |

## 7. 下一步（P1）

1. `app/chunker.py`：按 0.26 API 移植 AST 切块，跑 parity（目标 122 块、41 文件全过）；
2. `app/index_sync.py`：Python 同步客户端（repoState → manifest → 上传）；
3. `app/graph.py`：把 `spikes/probe_graph.py` 原型产品化（多语言 query + 增量）；
4. `app/repo.py` / `app/gitdiff.py`：镜像 + worktree + 本地 diff；
5. 接真实 GitLab 影子模式（需你提供内网地址与 token）。

## 8. P1 进展（2026-10-20 晚）

**chunker 移植完成，parity 通过。**

| 项 | 结果 |
|---|---|
| `app/chunker.py` | 280 行，tree-sitter 0.26 API；策略表/打包参数/降级链与插件一致 |
| parity（`tests/parity_chunker.py`） | **41 文件 / 122 块全过，块边界一致率 100%**（JS 13 / Python 18 / Go 10） |
| 掉块/降级 | 0（全部走 AST 策略，无 heuristic 降级） |
| 离线自测 | **82 项全过**（新增 9 项 chunker 用例：window/heuristic/策略表/降级原因/截断） |

**注意**：parity 必须在 Linux 容器里跑（`tree-sitter-language-pack` 无 Windows wheel）：

```bash
docker run --rm -v "$PWD":/work -w /work python:3.11-slim \
  sh -c "pip install -q tree-sitter==0.26.0 tree-sitter-language-pack==1.22.1 && python tests/parity_chunker.py --repo dsh-plugins=/work"
```

下一步：`app/graph.py`（把 `spikes/probe_graph.py` 产品化：补 ts/tsx/groovy query、import→文件映射、增量、图谱 golden）。

## 9. P1 进展（2）：代码图谱完成

| 项 | 结果 |
|---|---|
| `app/graph.py` | ~520 行：8 语言 query + import 解析 + 置信度消歧 + 增量 + 查询 API |
| 验收（`tests/test_graph.py`） | **20 项全过**（1.0/0.9/0.6/0.3 四档置信度、importers、tests_for、tsx、groovy 兜底、增量、prune、大文件跳过、importance） |
| 真实仓库（energy 456 文件） | 符号 6,173 / 边 10,295；建图 **719 ms**；callers+callees p50 **0.27 ms**、p95 **0.67 ms**；内存 42 MB；未变更二次 build **14 ms** |
| 计划门槛 | 建图 ≤1.5 s、查询 p95 <50 ms、内存 ≤150 MB —— 全部达标 |
| 文档 | `docs/GRAPH.md`（schema、置信度规则、语言矩阵、实测、限制） |

> 注意：graph 测试同样必须在 Linux 容器里跑；命令见 `docs/GRAPH.md` §9。

## 10. P1 完成：全部模块落地（2026-10-21）

| 模块 | 行数 | 内容 |
|---|---|---|
| `app/chunker.py` | 370 | tree-sitter 切块（参数/策略表与插件一致）+ heuristic/window 兜底 |
| `app/graph.py` | ~560 | 语法图：8 语言 query、import 映射、置信度消歧、增量、查询 API |
| `app/sync.py` | ~230 | 索引同步客户端（repoState/manifest/missing/chunks/embed，含 revision 冲突自愈） |
| `app/repo.py` | ~200 | 镜像仓 + worktree（项目锁、LFS/submodule 关闭、prune/GC） |
| `app/gitdiff.py` | ~110 | 本地 `git diff` → FileDiff（重命名/二进制/新文件） |
| `app/context.py` | ~200 | 三路上下文（语义/图谱/grep）+ 去重 + 预算 |
| `app/parallel.py` | ~60 | 线程池 + deadline + 顺序稳定 + `raise_on` 冒泡 |
| `app/index_state.py` | ~80 | `project_state` 表（namespace/revision/repo_state） |
| `app/worker.py` | ~330 | clone/api 双策略、索引同步、图谱、并行流水线、worktree 生命周期 |

**验收（容器内，python:3.11-slim + git + tree-sitter）**

| 套件 | 结果 |
|---|---|
| `python -m app.selftest` | **82/82** |
| `tests/test_repo_gitdiff.py` | **13/13**（镜像、fetch、worktree、重命名/二进制 diff） |
| `tests/test_sync.py` | **8/8**（全量/增量/冲突自愈/正文上传） |
| `tests/test_context_parallel.py` | **12/12**（三路来源、去重、预算、并行/异常/deadline） |
| `tests/test_graph.py` | **20/20** |
| `tests/parity_chunker.py` | **41 文件 / 130 块，100% 边界一致** |
| energy 基准 | 456 文件建图 **861 ms**，查询 p95 **0.53 ms**，内存 42 MB |
| 镜像 | **231 MB**（git + tree-sitter，无 node/GPU） |

**新增打包/运维**：`Dockerfile`（apt git + pip tree-sitter）、`.env.example`（取数/索引/图谱/并行）、
`compose.yaml` 校验通过、`.github/workflows/publish-review-image.yml`（tag `review-v*` → 自测通过才推）。

**仍未做（P2/P3）**：静态工具（ruff/semgrep/gitleaks）、jedi/gopls 精确引用、@bot 命令、learnings、
合并门禁、100 条人工标注评测与噪声调优。

## 11. 影子模式报表（补齐）

`app/report.py`：只读 SQLite，把 dry-run 数据导出成 Markdown 报表 + CSV 标注表。

```bash
python -m app.report --days 14 --out shadow.md --csv findings.csv
```

| 产出 | 内容 |
|---|---|
| 概览 | 任务数、dry-run/已发布、每 MR 评论数（均值/中位/p90）、延迟 p50/p95、tokens 与估算成本 |
| 噪声 | 丢弃原因分布、未评审文件原因、降级记录 |
| 待标注清单 | 每条"本该发的评论"（MR、文件:行、严重度、正文），CSV 带空 label 列 |
| 验收 | `tests/test_report.py` **13/13**（本地 Windows 也能跑，无 tree-sitter 依赖） |

## 12. P1 收尾完成（2026-10-21）

| 项 | 状态 |
|---|---|
| **发布前 supersede 检查（D8 欠账）** | ✅ `worker.is_superseded()`：发布前重取 head_sha，变化则标 `skipped/superseded` 不发过期评论；查询失败时宁发不漏 |
| **镜像/worktree 定时 GC** | ✅ 空闲时按 `GC_INTERVAL_S`（默认 1 h）跑 `prune + gc(MIRROR_TTL_DAYS)` |
| **CI 覆盖 review-service** | ✅ `.github/workflows/ci.yml` 新增 job：selftest + 5 套验收 + 语法图 + chunker parity（仓库内文件） |
| **根 README** | ✅ 目录树与服务端章节加入 review-service 与发布流程 |
| **chunker golden** | ✅ 重新生成（41 文件 / 130 块），parity 在 CI 中对仓库内 31 个文件 100% 通过 |
| supersede 单测 | ✅ selftest 85/85（+3 项） |
| GC 单测 | ✅ test_repo_gitdiff 14/14（+1 项过期镜像删除） |

**P1 全部完成**。剩余只有两类：① 需要你点头的提交/打 tag（`review-v*` 触发镜像发布）；
② 需要外部信息的真实 GitLab 影子模式（30 MR）。P2/P3 功能仍按计划等影子数据后再做。
