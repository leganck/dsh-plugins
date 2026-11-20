# 业界成熟方案调研 + Mnemon UI 借鉴分析（2026-11-20）

> 承接 `diagnosis-admin-ui-governance-duplicates.md` 的三个问题。本文回答：成熟产品怎么解、哪些可直接搬、Mnemon 的 UI 设计哪些值得抄。

---

## 一、问题一「看不到重点」——业界成熟解法：信息层级 + 渐进披露

### 1.1 LangSmith / GlassBox RAG：观测台的「漏斗式首屏」

LangSmith 的 trace 视图、[GlassBox RAG 的 Dashboard](https://pypi.org/project/glassbox-rag/1.0.0/#1) 都是同一套路：

```text
首屏 = 四个带状态色的大数字卡（请求量 / 成功率 / 延迟 / 成本）
     + 一条随时间的趋势线
往下 = Pipeline 交互图（点击任一节点看该阶段指标）
再往下 = Debugger（单条 trace 逐层展开）
```

**核心原则**：数字必须带**状态**（好/坏/需行动），而不是裸数值。我们的「命中 0」之所以像坏了，就是因为它是裸的。

### 1.2 Grafana 最佳实践：层级 ≤3-4 层

[Grafana 嵌套可视化最佳实践](https://github.com/Compile-N-Run/Compile-N-Run/blob/main/docs/observability/grafana/5-grafana-visualizations/15-nested-visualizations.mdx)明确：**从一般到具体的逻辑层级**、**嵌套不超过 3-4 层**、面包屑导航、时间范围全局一致。[AWS 的 Grafana 指南](https://docs.aws.amazon.com/es_es/grafana/latest/userguide/service-guide.pdf.pdf)同样强调「一个面板讲一个故事，数据从大到小排」。

我们概览页 8 张平铺卡片正是反例——没有故事线，只有卡片堆。

### 1.3 可直接搬的三条

| 原则 | 搬到我们的 admin |
|---|---|
| 状态色数字卡 | 双资产卡：`223 条` → `223 条 · ✦ 3 条待裁决`（橙）；`cov 99.2%` → 绿；`cov 91%` → 红点+「待补嵌 60」 |
| 漏斗次序 | 概览页三段：**资产状态 → 一句话健康度 → 折叠的运维细节**（运行时/负载/鉴权全部收进 `<details>`） |
| 一个面板一个故事 | 「嵌入治理」卡和「存储与限额」卡合并为「一句话健康度」行；「向量标签」「鉴权状态」降级为折叠项 |

---

## 二、问题二「三层治理不可见」——业界成熟解法：Run 级观测 + 审阅收件箱

### 2.1 LangSmith 的 run/trace 模型

每次管道执行 = 一条 **run**，含子 span（我们的 Review/Dedup/Merge 正好是三个 span）。查询时可以看任意一次 run 的完整漏斗：输入 → 每阶段过滤数 → 输出。**这就是 `pipeline_runs` 表该有的形状**——业界验证过的最小充分集。

### 2.2 审阅收件箱（Review Inbox）：human-in-the-loop 的标准形态

调研中两个直接对口的实现：

- [knowns 的 Memory Decision Review UI 规范](https://github.com/knowns-dev/knowns/blob/b92030089eab2d53584dcc9aed87014b46e61147/.knowns/docs/specs/2026-06-18/memory-decision-review-ui.md)：**Memory 首屏必须是 Review Inbox，按可行动原因分组**（proposed / duplicate review / stale TTL / missing source / superseded）。
- [Humanloop 的标注队列](https://inferensys.com/differences/synthetic-evaluation-data-platforms/llm-as-judge-evaluation-platforms/braintrust-vs-humanloop)：以 annotation queue 为中心的平台，审阅者只看到「需要我判定的队列」，别的不出现在首屏。
- [memoryops 的 phase-06 human-in-the-loop](https://github.com/agent-memory-atlas-archive/patibandlavenkatamanideep--memoryops-ai/blob/64328a1b70c73e7c333e641caaa2a473896aef13/docs/phase-gates/phase-06-human-in-the-loop.md)：view/filter memories、**per-memory audit timeline**（每条记忆的操作历史时间线）、approve/reject 都留痕。

**我们经验 tab 的问题**：它是一个「表格」（所有条目平铺），而成熟方案是「**收件箱**」（只有需要人的东西进首屏）。223 条里 220 条是 active 无需人看，3 条 conflicting 才需要人——但现在它们混在同一张表。

### 2.3 [Memanto 的冲突模型](https://github.com/neoneye/agent-memory-atlas/blob/0e8db5c6b45c16fa4c6e1decf3696105999760c5/docs/systems/memanto/index.html)（值得整段借鉴）

> "A memory is active until an expiry policy, a conflict resolution, or an explicit expire stamps it expired. So **while a conflict sits unresolved, both sides stay active and both keep being recalled**... manual, letting a person author the reconciliation."

两个设计决策直接可抄：
1. **冲突未决期间双方都保持 active 且都被召回**——真相交给使用现场，而不是悄悄丢一边（我们现在是 conflicting 状态直接不进检索，用户无感知地丢了一条经验）。
2. **冲突卡给出「人工撰写的和解文本」选项**——不只二选一（保留新/保留旧），允许人写第三条融合结论。

### 2.4 可直接搬的四条

| 原则 | 搬法 |
|---|---|
| Run 级观测 | `pipeline_runs` 表 + 治理流水区块（一次跑批一行：候选→各阶段过滤数→产出，点开看明细） |
| Review Inbox | 经验 tab 顶部改为**待办收件箱**：`待裁决 N · 待退役 M · 待补向量 K`，列表页降级为「浏览」入口 |
| audit timeline | 每条经验的详情抽屉加时间线：created → hit×n → adopted → conflicted → resolved（服务端已有 stats/last_hit_at，只差事件记录） |
| 冲突双方保留 | conflicting 状态也参与检索（标注「⚠️ 有冲突待裁决」）；裁决选项加「融合」：弹 textarea 人工写和解条目 |

---

## 三、问题三「重复指纹」——业界成熟解法：内容寻址 + 别名 + 原子合并

### 3.1 内容寻址存储（CAS）：从根上消重

[Hashtree 论文](https://zenodo.net/records/22761375/files/Hashtree_Content-AddressedStorage_AcademicPaper_2026-09-15.pdf?download=1)阐述 CAS 原则：**以内容哈希为地址，两个相同对象自然坍缩到同一地址**。我们的 blobs 表其实已经是这样（24565 blobs 按 hash 去重存 64MB）——**但 chunks 和 vectors 表把 lineage_id 放进了主键**，等于在 CAS 之上又按血统分了家，白白存了 2049 份重复向量。

成熟做法：**身份层（lineage）与数据层（chunks/vectors）分离**。数据按 hash 全局唯一，lineage 只持有一个 hash 清单（引用计数）。这就是 git 对象库的模型——commit 树随便分叉，blob 永远只有一份。

### 3.2 别名（alias）+ 原子切换：合并的安全形态

[Elasticsearch 的 alias/rollover](https://github.com/elastic/elasticsearch/blob/20d61e90f8f845d749b87b9ee457772ea5d8e/docs/reference/indices/rollover-index.asciidoc) 与 [Artesian 的 Qdrant 迁移](https://github.com/agent-memory-atlas-archive/aquifer-labs--artesian/blob/main/docs/upgrades.md)是同一套路：

```text
1. 建新集合 → 2. 灌数据 → 3. 验证 → 4. alias 原子切到新集合 → 5. 旧集合保留观察期 → 6. 再删
```

关键点：**切换是原子的、可回滚的、旧数据保留观察期后才删**。我们的 lineages/merge 端点应该照这个节奏：merge 后旧 lineage 不真删，标记 `merged_into`，TTL 后清理——万一合并错了还能救回。

### 3.3 [pg-ripple 的合并期去重](https://github.com/trickle-labs/pg-ripple/blob/29ffdaf3d7c5e11cf01abede2c4c946ee8dd9b47/docs/src/user-guide/sql-reference/admin.md)

`dedup_on_merge` GUC + `compact()`——**去重发生在 compaction 时，事务内原子完成**。对应到我们：merge 端点在单个 SQLite 事务里做「改挂靠 → 删重复行 → 刷统计」，失败整体回滚。

### 3.4 可直接搬的三条

| 原则 | 搬法 |
|---|---|
| CAS 到底 | vectors 表主键从 (lineage_id,hash) 改为 (hash)——向量全局一份，lineage 靠 chunk 清单引用。**2049 份重复立消，未来不再产生**（迁移脚本一次性搬） |
| 别名+观察期 | merge 端点：事务内改挂靠 + 旧 lineage 标 `merged_into=<id>` 不删；admin 显示「已合并（保留至 X 日）」；7 天后再物理清理 |
| 分组视图 | 代码资产页按 repoName 分组，同 chunkFp 的行给「合并」建议按钮（就是 3.2 的 UI 面） |

---

## 四、Mnemon UI 设计：哪些值得借鉴

通读 [dsh-mnemon UI guide](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/ui-guide.md)（v0.5.32/0.5.34 真实截图的文档），它和我们的 admin 面对的竟是同一类问题域（记忆资产的浏览/治理/置信）。可借鉴度分三档：

### 4.1 直接抄（结构性优点）

| Mnemon 设计 | 我们的对应 | 搬法 |
|---|---|---|
| **Turn memory bar**：每轮对话末尾一行「读了什么、写了什么」，点条目直达存储处 | 治理流水只有表格没有「来源叙事」 | 经验详情抽屉加「来源轨迹」：从哪个 session 的哪个 segment 提炼（evidence 已有 archive_ref，只差渲染成可点链接） |
| **收据（receipt）文化**：每次写操作都回执——结果（Saved/Skipped/Failed）+ 去了哪 + 直达链接 | 我们的 hit/resolve 操作无反馈闭环 | 裁决/退役/hit 操作后弹 toast 回执：「已退役 exp-000142（腾出 1 条）；撤销」 |
| **Status 页「一张卡一个组件」+ 异常才出现的 notice** | 概览页卡片永远全量平铺 | 「需要注意的 notice 只在需要时出现」（notices 折叠区），正常时页面是干净的 |
| **"Names over identifiers"**：一切以标题/内容/空间名指代，Copy ID 只放在卡片角落 | 我们的表格以 exp-000123 开头 | 列表首列改 what 摘要，id 缩为角落 mono 小字 |
| **Refresh 全局化**：页头一个刷新，页内不再有各自刷新按钮 | 各区块自己拉数据刷新 | 统一轮询节奏 + 页头 Refresh |
| **保存对话框的「去哪」选择器**（Auto=任务Agent决定 / 指定空间） | 批量导入 JSON 是黑盒 | 导入时逐条显示判定（create/update/skip + 原因），像 Mnemon 的 receipt 一样可审计 |

### 4.2 选择性借鉴（需适配）

| Mnemon 设计 | 适配理由 |
|---|---|
| 实体图（Entities graph，2D/3D 可切换） | 我们的符号图（25k 符号/76k 边）画全图无意义；但**单符号的局部邻域图**（code_graph 的可视化）值得做——点击符号显示 1-2 跳邻居的力导向小图 |
| 双栏「 inspected workspace vs effective workspace」 | 我们没有多工作区问题，跳过 |
| 皮肤变量（--mn-* CSS custom properties） | 单文件内联页暂不需要，但如果将来 admin 要嵌 DSH 侧栏，这个契约设计值得学 |

### 4.3 不借鉴（场景不同）

- **对话内嵌条（turn bar/save 按钮）**：那是「用户日常对话」界面，我们的 admin 是「运维台」——使用频率和角色都不同。
- **Skills 五页签**：我们没有技能进化需求。

---

## 五、综合结论：一张对照表

| 我们的问题 | 业界标准解 | Mnemon 可借鉴 | 落地批次 |
|---|---|---|---|
| 看不到重点 | LangSmith/Grafana 的状态色漏斗首屏 + ≤4 层 | notice 只在异常时出现；Refresh 全局化 | 批次1（纯前端） |
| 三层治理不可见 | LangSmith run 观测 + Review Inbox + audit timeline | receipt 文化；evidence 来源轨迹渲染 | 批次2（服务端+UI） |
| 重复指纹 | CAS（数据按 hash 全局唯一）+ alias 原子合并 + 观察期 | —（数据层问题，UI 无对应） | 批次3（服务端+清洗） |
| 冲突裁决体验 | Memanto：双方保留+召回、人工和解选项 | 写操作 receipt + Undo | 批次2/4 |

**修订后的批次计划**（比上一版多了 Mnemon 借鉴项）：

1. **批次1**（0.5 天，纯前端）：驾驶舱三层概览 + tab 频率序 + notice 异常才显示 + 操作 receipt toast + repoId 止血（commit:HEAD 种子）
2. **批次2**（1 天，服务端+UI）：pipeline_runs 表 + 治理流水区块 + Review Inbox 化（待办收件箱置顶）+ 冲突卡加「融合」选项与触发词对 + evidence 来源轨迹 + audit timeline
3. **批次3**（1 天，服务端+清洗）：vectors 表 CAS 化（主键去 lineage 化）+ lineages/merge 端点（事务+merged_into 观察期）+ 4 组重复清洗 + 分组视图与合并按钮
4. **批次4**（0.5 天）：经验卡行动色 + 待退役清理（stale_days 参数）+ 冲突未决也召回的标注

总计 3 天，其中批次 2 吸收了 Mnemon 的 receipt/来源轨迹两项最划算的借鉴——零数据模型成本，纯渲染层。
