# code-index vs Cursor 的代码库索引：逐层对比

> 历史来源：本仓库会话归档 `~/.dsh/archive/session-e91b731c-…/segment_007.md`
> （2026-10-16 那次分析，标题《Cursor 的代码库索引：算法、证据、以及 DSH 能借鉴什么》）。
> Cursor 侧的证据是**已发布客户端 bundle 的 protobuf 定义** + 官方博客，**不是运行时观测**。
> 本文补上对照侧：本插件的**实际实现**与**实测数字**。

---

## 一、先讲清一个前提：两者形态不同的根源

Cursor 的索引跑在**服务端**（本机 `~/.cursor` 下没有任何索引文件——实测确认）。
所以它那套 Merkle 同步协议、路径加密（`pathEncryptionScheme` + `orthogonalTransformSeed`）、
上传限流（`GetUploadLimits{soft,hard}`）、simhash 索引复用，**是多租户云产品逼出来的**，
不是算法本身的必需品。本插件是**本地进程**，这些层可以直接不存在。

**真正值得对齐的只有四层：切块、缓存键、增量、查询排序。**

---

## 二、逐层对照

| 层 | Cursor | code-index（本插件） | 差距评价 |
|---|---|---|---|
| **新鲜度/同步** | Merkle 树：文件哈希 + **目录聚合哈希**；握手只发 `root_hash`；`SyncMerkleSubtreeV2` 只走哈希不同的分支；`max_sync_merkle_batch_size` 分批 | `files(path, mtime, size, sha256)` 表 + 全量 `walkRepo` + `diffFiles`（mtime+size 快筛，内容 sha256 定稿）。**实测**：遍历 120 ms / 2,088 文件；全量核对 703 ms；未变时 ~2 ms | **不需要对齐**。Merkle 省的是**网络传输**；本地遍历已经在毫秒级，2 ms 与"剪枝"无差别 |
| **切块** | **AST/语法切块**：客户端原生模块 `@anysphere/tree-chunk-napi`（tree-sitter），服务端可下发策略 `GetAvailableChunkingStrategies`；块带 `language_identifier` / `summarization_strategy` / `intent` / **`is_first_version`、`is_final_version`**（草稿→定稿生命周期） | **固定 40 行窗口**（`lib/chunker.js`），哈希 = `sha256(完整块文本)` | ⚠️ **最大的质量差距**。见下面第三节的实测 |
| **内容缓存** | 向量按**块内容哈希**缓存；"大多数编辑不改动大多数块 → 命中缓存" | 全局**内容寻址**缓存 `~/.dsh/index/vectors.db → vec(key, dim, v)`，`key = ${模型标签}:sha256(送模型的文本)`；**跨仓库、跨版本共用** | ✅ **同构，而且我们的更细**（逐块精确复用 vs 服务端按仓库组织） |
| **关键词通道** | `BM25Chunk { content, range, score, relative_path }` | FTS5（`chunks_fts`，unicode61）+ `bm25()` 排序 | ✅ 同构（FTS5 的底层就是 BM25） |
| **向量通道** | 自研 embedding（训练数据来自 agent 会话轨迹） | 可选：bge-small-zh-v1.5（fp16/DirectML 或 int8/CPU），512 维，L2 归一化 | 模型档次不同，接口同构 |
| **融合与重排** | 向量 kNN + BM25 → **`use_reranker` 重排**；两档延迟入口 `SemSearch` / `SemSearchFast`；请求带 `CurrentFileInfo{contents, sha_256_hash, top_chunks}` | BM25 + kNN → **RRF(k=20) 融合**；**无重排** | ⚠️ **第二差距**：我们只做了"融合"，没做"重排" |
| **请求上下文** | 搜索请求自带当前文件内容 + 其 sha256 + top_chunks | 无（`code_search` 只接查询串与仓库路径） | 中等：缺"以当前文件为锚"的检索 |
| **目录地图** | `GetHighLevelFolderDescription`（目录级摘要） | 无 | 中等：冷启动时不知道去哪儿找 |
| **变更流程** | watcher 只标记 → 周期 `doUpdate`（`indexing_period_seconds` **≥60 s**，且有自我抑制：有 job 在跑或处于超时窗口就跳过本轮）→ 子树剪枝 → `FastUpdateFileV2{MODIFY, ancestor_spline}` → spline 不一致得 **`EXPECTED_FAILURE` → 重同步该子树（不是重试）** → 重新分块 → 未变块命中缓存 → **只嵌入变化的块**（后台异步） | 按需触发建库/刷新，无后台周期；改文件 → **整文件**重新切块并重写 chunks + FTS；向量层因缓存内容寻址，未变的块**自然命中** | ✅ 语义接近。差别只在**切块边界稳不稳**（见第三节），不在"有没有块缓存" |
| **删除** | `deleteFastUpdateFileWithRetry{DELETE}`（并发 10，超额 `setTimeout(300)` 让拍）；整库 `RemoveRepositoryV2` | `dropFile(rel)` 一次事务删 chunks / FTS / `vectors` | ✅ 等价（本地无需祖先证明与并发限流） |
| **状态机** | `RepositoryCodebaseInfo.status ∈ {UP_TO_DATE, OUT_OF_SYNC, EMPTY, EMPTY_WITH_COPY_AVAILABLE, COPY_IN_PROGRESS}` | `code_index_status` 报 changed / unchanged / removed / stale + 块数与向量数 | 我们的更简单，本地单实例够用 |
| **冷启动复用** | **simhash**：把整棵树哈希压成一个值 → 服务端在团队已有索引里检索相似度 → **整份索引复用**（"小时级→秒级"） | 无"整份复用"；但**逐块复用已覆盖大部分收益**——实测同一仓库相邻分支的块重合 **~98%**（见第四节） | ⚠️ 优先级低（论证见第四节） |
| **索引位置** | 服务端（本地无索引文件） | `~/.dsh/code-index/<仓库名>-<路径哈希前8>/index.db`，**不落在代码仓库里**（不污染 `git status`） | ✅ 本地化后天然更好 |

---

## 三、切块差距的**实测**（今天补测）

用 git 两个版本对比，只统计**内容有差异的文件**（这才衡量切块边界稳不稳），
仓库 `legacy-grails-service-5.0`：

| 场景 | 差异文件数 | 固定 40 行窗口：新版本块**命中率** | CDC（内容定义边界） |
|---|---|---|---|
| 同分支差 20 提交 | 10 | **9.1%** | 45.2% |
| 5.0 ↔ feat/plat/3.45.0 | 36 | **26.0%** | 75.6% |
| 5.0 ↔ master | 35 | **26.4%** | 76.2% |
| 5.0 ↔ your-org/3.35（大分歧） | 30 | **15.8%** | 64.5% |

**读法**：固定窗口下，改动一个文件后**该文件里 74%–91% 的块哈希都变了**（插入一行会平移后面所有窗口），
所以这些块必须**重新嵌入**；换成内容定义边界后只剩 24%–55% 要重算。

**但是**（重要）：把"内容完全相同的文件"算进来后，**整个仓库层面的复用率三种场景都是 ~98%**
（因为一次分支分歧通常只动几十个文件）——**两种切块器在仓库层面差别很小**。

> 结论要分场景说：**跨分支共享**场景下固定窗口已经够用（~98%）；
> **单仓库内反复编辑**（活跃开发，同一文件被反复改）才是 CDC/AST 真正省算力的地方。

**Cursor 用 AST 边界**，天然比 CDC 更稳（块边界落在语法单元上，改一行不动其它块），
代价是引入 tree-sitter 原生依赖——与本插件"纯 JS、可缺依赖降级"的取向冲突，
所以**若要对齐，纯 JS 的 CDC 是折中方案**。

---

## 四、不要照抄的两处（当时就说了，现在有数据支撑）

1. **Merkle 同步协议**：它省的是网络传输。本地全量核对 703 ms（2,088 文件），
   未变时 2 ms —— 加一层目录聚合哈希换不来可感知的收益，却引入"树不一致怎么办"的复杂度
   （Cursor 自己都要处理 `EXPECTED_FAILURE` 与 `hackyGetSplineWhenYouCantRelyOnTree` 兜底）。
2. **simhash 整份索引复用**：对"一个仓库五个版本"的收益，**我们的逐块内容寻址已经拿到大半**——
   实测相邻分支仓库级复用 ~98%，跨版本线也有 97.6%。整份复用的额外收益很小，
   而代价是"整份索引复制的正确性"（状态机 `EMPTY_WITH_COPY_AVAILABLE` / `COPY_IN_PROGRESS` 就是在处理这个）。

---

## 五、按性价比排序：本插件可以往 Cursor 靠的三件事

> ⚠️ **本节 2026-10-16 晚修正过**：早前把「CDC 切块」列为第 1 项是错的。
> 补测（`dsh-comparison/chunk-quality.mjs`，仓库 `legacy-grails-service-5.0`，532 个括号类文件、
> 185 k 行、纯 JS 无模型）显示：**CDC 不改善块边界质量，甚至更差**——它按行内容哈希定界，压根不看语法。

| 切块器 | 块数 | **首行落在方法/类内部** | **块内括号不平衡** |
|---|---|---|---|
| 固定 40 行窗口（现状） | 4,893 | **87.7%** | **73.3%** |
| CDC（内容定义边界） | 9,163 | **90.6%**（更差） | 62.8% |
| brace（纯 JS 深度感知） | 3,046 | 62.7% | 55.3% |
| **ast-ish（深度 + 空行 + 注解）** | 2,996 | **40.6%** | **38.1%** |

读法：**现状下 87.7% 的块从某个方法/类中间开始**（"半截方法"成了嵌入单元）。
CDC 修不了这个（它是**成本**工具：改善跨版本缓存命中，与语义完整性无关 —— 见 `VECTOR-SHARING.md`）。
**纯 JS 的语法感知切块能把它降到 40.6%**（余下的是超长方法被 max 行数强制截断的下限），
**不需要 tree-sitter**——这一点很重要，因为原生依赖的安装代价我们刚在 `onnxruntime-node` 上付过一次。

**修正后的排序**：

| # | 改动 | 成本 | 预期收益 | 依据 |
|---|---|---|---|---|
| 1 | **测召回上限**（recall@50 / @100，用现有索引 + `ground-truth.json` 的 1,964 个真实事件） | 极低（索引已建好；查询向量每个只有 1 条） | **它决定第 4 项值不值**：重排救不了没被召回的 | 混合检索 55% @10 的天花板在哪里，目前未知 |
| 2 | **融合从纯 RRF 改为归一化分数加权** | 低 | RRF 只用 rank、**丢掉分数信息**；加权可调、可 A/B、不引入模型 | 现状是 `lib/search.js` 的 RRF(k=20) |
| 3 | **语法感知切块（纯 JS）** + A/B 验证 | 中：块哈希全变 → 缓存/索引重建一次（22–47 分钟） | 块从"半截方法"变成自包含单元；**代码片段的往返成本**可能一起降 | 上表 87.7% → 40.6% |
| 4 | **reranker**（本地小交叉编码器 int8） | 中：多一个模型文件（复用现有 onnxruntime-node，**无新依赖**） | 取决于第 1 项结果 | Cursor 用它；我们是"融合完了就返回" |
| 5 | CDC 分块 | 低 | **与检索质量无关**；只改善跨分支共享时的缓存命中 | `VECTOR-SHARING.md` 实测：仓库级复用本就 ~98% |

**不建议做的**（不变）：Merkle 协议、路径加密、上传限流、simhash 整份复用、`FileSystemWatcherService`。


---

## 六、遗留的两个真实问题（当时发现，今天仍未解决）

1. `.cursor/rules/codegraph.mdc` 是 `alwaysApply: true`，写着 *"Trust codegraph results … Do NOT
   re-verify them with grep"*，但 `codegraph` 不在 PATH、16 个仓库的 `.codegraph/` 里没有索引数据。
   **规则在让 AI 信任一个不存在的数据源。**
2. Cursor 的 `state.vscdb` 当时 58.6 GB，**今天实测 63.1 GB**（另有 8.6 GB `.backup`），
   持续增长，值得单独处理。
