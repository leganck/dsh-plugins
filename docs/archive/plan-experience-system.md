# 团队经验系统规划（experience-system）

> 状态：规划稿 v1（2026-11-18）。目标：让 code-index / code-review / 会话历史三件事闭环——
> 会话沉淀经验 → 经验入库（code-index-service 底座）→ 评审引用经验 → 评审纠偏再回流经验。

## 0. 一句话

把「日常会话里反复纠正、反复踩坑得到的判断」变成**可治理、可检索、可被评审引用**的资产，
存储底座复用已建好的 code-index-service（bge-base-zh + FTS5 + scopes + admin/stats），
提纯链路参考腾讯经验系统方法论（三层治理），分层思想借鉴 dsh-mnemon，但**不引入 mnemon 本体**。

## 1. 已有资产盘点（全部复用，不重造）

| 资产 | 现状 | 在本系统中的角色 |
|---|---|---|
| `dsh-code-index` 插件 0.16.0 | 已装，自动索引+显式 path 授权 | 代码检索；**Review 层源码探索的执行器** |
| `code-index-service` | 已部署（192.168.50.112:18000，bge-base-zh-v1.5，FTS5+kNN+RRF，scopes API，admin/stats） | **记忆存储底座**：新增 exp 命名空间 + 记忆 CRUD |
| `dsh-memory-archive` 插件 | 已装，compaction 段落落盘 `~/.dsh/archive/<sid>/segment_*.md` + INDEX | **采集器**：经验管道直接读归档文本（不碰 zstd 原始日志） |
| `review-service` | 已建（GitLab MR 评审，GUIDELINES_PATHS，INDEX_SCOPE_MODE，影子模式） | **消费端**：评审时检索经验注入 prompt；**生产端**：评审纠偏回流候选 |
| 223 条业务经验 bullets + 5 条高价值候选 | 已从 session-4ff93b80 提取，未入库 | **种子数据 + 评测集起点** |
| sp-* skills / 台账 | git 事实源 | 硬规则层（与经验层的分界见 §4.6） |
| magpie | 纯 API（127.0.0.1:3425/v1） | 提纯管道的 LLM 出口 |

## 2. 总体架构

```text
┌─ 生产端 ──────────────────────────────────────────────┐
│ DSH 会话 → dsh-memory-archive 落盘 segment_*.md         │
│ review-service 评审记录 + 人工纠偏                        │
│ 手动沉淀（knowledge/experience/*.md，git）                │
└──────────────┬────────────────────────────────────────┘
               ↓ 离线批量 + 增量监听（新 segment → 队列）
┌─ 提纯管道 exp-pipeline（新）────────────────────────────┐
│ 主题分组 → 经验抽取（三镜头+九类垃圾）                      │
│   → Review（文本四步 + 源码探索事实校验※）                 │
│   → Dedup（候选集内，宁严勿宽，禁桥接合并）                 │
│   → Merge（对历史库：create/update/skip/contradict）      │
│ ※源码探索 = code-index /v1/search 验证类/方法存在性        │
└──────────────┬────────────────────────────────────────┘
               ↓ 入库
┌─ 存储底座 code-index-service（扩展）────────────────────┐
│ namespace kind=exp：`<repoId|global>@exp`                │
│ 新增 /v1/memories CRUD + 生命周期字段 + 冲突队列           │
└──────┬─────────────────────────────┬───────────────────┘
       ↓ 召回                        ↓ 评审引用
┌─ 消费端 ──────────────────────────────────────────────┐
│ DSH：exp_recall 工具（P2，按需检索注入）                   │
│ review-service：EXPERIENCE_URL 检索 top-k 注入 prompt，   │
│   报告标注引用了哪些经验（可见性）                          │
└───────────────────────────────────────────────────────┘
```

闭环（文章结语的三环）：**生产决定基线 → 使用暴露问题 → 维护反哺生产**。

## 3. 存储设计（code-index-service 扩展）

### 3.1 经验条目 schema

```yaml
id: exp-000123
repo: smartpos-erp-pos          # 或 global
lens: logic                     # jargon(黑话) | index(索引) | logic(逻辑)
what: 结账仅在 orderCompletePost 写销售，且 payStatus==1 && payWay in (1,2,4)
when: 排查「订单支付完成但无销售记录」时
why: payWay=3 挂账不写销售；已被当 bug 报过 ≥3 次
evidence:
  - {session: 4ff93b80, segment: "003", seq: "1204-1230"}
  - {issue: CHGJ-3905}
status: active                  # active | retired | conflicting
source: pipeline | manual | review-feedback
stats: {hits: 0, adopted: 0, last_hit_at: null}
created_at: …
updated_at: …
```

三镜头分类（文章 §4）：**判定标准 = Agent 能否自己发现**。
黑话（语义不可发现）/ 索引（位置不可发现）/ 逻辑（行为不可发现）。

### 3.2 服务端改动（最小集）

1. 新 namespace kind `exp`：`canonical = <repoId>@exp`（全局经验 `global@exp`），
   复用现有 scopes 解析/检索/统计链路；**注意修复已知 tag-null 坑**（经验条目必须带默认 tag）。
2. `/v1/memories` CRUD：
   - `POST /v1/memories`（Upsert by id；带 merge 动作审计）
   - `GET /v1/memories?repo=&q=&status=`（列表/检索）
   - `POST /v1/memories/search`（= /v1/search 的 exp 专用包装，返回完整条目而非 chunk 片段）
   - `DELETE /v1/memories/{id}`（软删 → retired）
   - `POST /v1/memories/{id}/hit`（召回打点，供 stats 与退役判定）
3. 生命周期字段进 SQLite（复用 index_store 加表 `memories`，与 chunk 向量共存，
   正文向量化走现有 embedder，查询前缀沿用）。
4. admin 页加「经验」标签页：条目数、命中率、contradict 队列（P3 再做 UI）。

### 3.3 为什么不用 mnemon-native / 新造 SQLite

- code-index-service 已有：向量+FTS+RRF、scopes、stats、admin、部署与运维；
  mnemon-native 是私有 SQLite+CLI，review-service（Python）读不到，违背「共享底座」目标。
- 事实源双轨：**硬规则走 git（sp-rules / knowledge/experience/*.md），证据型经验走 exp 库**；
  git 文件可导出灌库（单向同步），保证审计与迁移（文章：经验系统是认知管道，资产要能导出）。

## 4. 提纯管道（exp-pipeline，新脚本/服务）

### 4.1 采集

- **读 `~/.dsh/archive/*/segment_*.md` + INDEX.md**（memory-archive 产物，纯文本，含原始轮次）。
  不读 session zstd（attic 的 session-index 仅作补充取证）。
- 增量：监听 archive 目录新 segment（debounce 5 分钟）；批量：`exp-pipeline build --since <date>`。
- 评审回流（P2）：review-service 导出「被人工纠正的评审结论」为候选片段文件，同一管道处理。

### 4.2 主题分组

按 segment 内事件序列切主题片段（一次会话可能含多个工单/多个模块）。
**不附 session 大纲**（文章实测：大纲引导泛化，反而放大垃圾）。

### 4.3 抽取（九类垃圾特征内嵌 prompt）

垃圾特征（文章 §6.1）：事实性错误 / 通用常识 / 对话摘要 / 一次性 case / 个人偏好 /
缺上下文 / 粒度混用 / 不可执行 / 证据不足。

可审计三维度输出：①为什么是经验（解决什么可复用问题、是否项目特有）②命中哪些排除规则
③证据轮次（segment+seq）。SmartPOS 语料额外偏置：分区映射、状态枚举、支付链路、构建/JDK。

### 4.4 Review（含源码探索）

文本四步：事实性/偏好 → 缺上下文 → 粒度混用 → 无经验兜底。
**源码探索**：从 what/when 提取类名/方法名/表名标识符 → `code-index /v1/search`
（namespace 指向对应仓库）→ 验证存在性；不存在 → 标记 S1_FACTUAL_ERROR 拦截
（文章 FastScrollBar 案例）。默认保留、定向过滤（误杀代价 > 放行代价）。

### 4.5 Dedup / Merge

- Dedup（候选集内）：宁严勿宽；When 不同不合、主结论类型不同不合、粒度不同不合、
  用途不同不合；**禁止桥接合并**（A~B、B~C ⇏ A~C）。
- Merge（对历史库，检索 exp namespace top-k 相似）：
  - **唯一目标判定前置**：无唯一合适目标 → 默认 create（防强行匹配污染边界）
  - update 必须自检：When 不过度泛化、What 保留最具体可执行建议、不引入无证据新结论
  - contradict 只标记不决断 → 人工裁决队列（admin 页 / md 报表）

### 4.6 经验层 vs 规则层分界（防漂移，承前对话结论）

| 内容 | 去处 | 例 |
|---|---|---|
| 可强制执行的硬规则 | git（sp-rules） | 每单一评论；fork 只合 deploy/plat |
| 带场景约束的判断型知识 | exp 库 | payWay=3 挂账不写销售（排查口径） |
| 单点事故背景 | exp 库 evidence | 云打印旧快照（带单号） |
| 个人偏好 | DSH runtime memory | 不入团队库 |

### 4.7 评测集

种子：已提取的 223 bullets + 5 条高价值候选人工标注（高价值/低价值/垃圾）。
指标三件套：Recall / Precision / Garbage Rate（只看 Precision 会过度保守）。
固定样本 → 迭代 prompt → 对齐标注 → 错例归因 → 再评测（文章 §6.1 流程）。

## 5. 消费端

### 5.1 review-service（P0 先做）

1. 新配置 `EXPERIENCE_URL`（+ `EXPERIENCE_API_KEY`、`EXPERIENCE_TOPK=3`）。
2. 评审流程插入一步：diff 文件路径 + 关键词 → `POST /v1/memories/search`（限定 repo namespace，
   fallback global）→ top-k 经验拼入 reviewer prompt（预算内，带 evidence 溯源）。
3. 报告可见性：每个发现标注「依据经验 exp-000123（what 摘要）」——等价 mnemon 的 turn memory bar。
4. 打点：注入即 `hit`；Verifier 采纳该依据则 `adopted+1`（使用效率度量）。
5. 影子模式先行：`DRY_RUN=1` 跑 1-2 周，看注入经验后的发现差异再放开。

### 5.2 DSH 会话（P2）

新插件或并入 code-index：`exp_recall` 工具（Agent 主动查经验）；
可选每会话一次注入提示（对标 mnemon recallMode=guided，默认不开自动注入）。

## 6. 借鉴 mnemon 的什么（思想，不装本体）

| mnemon 机制 | 采纳方式 |
|---|---|
| 三层记忆（runtime/documents/spaces） | 分层保留：runtime=现有 skills+runtime memory；documents=git 事实源；spaces=exp namespace |
| 召回预算 + 按需检索 | review-service TOPK+token 预算；DSH 侧按需工具而非全量注入 |
| 回合可见性（turn memory bar） | 评审报告/回复标注引用的经验 id+摘要 |
| 能力门控（capabilities） | /v1/memories 按角色（pipeline/agent/admin）限写 |
| 主动记录（auto-capture） | **不采纳**（文章已证：自动提取=垃圾放大器；走三层治理管道） |
| 技能自进化 | 不采纳（sp-* 是生产流程，草案必须人工采纳） |
| 私有 SQLite + CLI | 不采纳（底座换成 code-index-service，跨系统可读） |

## 7. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| **P0**（1-2 天） | 服务端 exp namespace + /v1/memories 最小 CRUD + hit 打点；灌入 5 条种子经验；review-service EXPERIENCE_URL 注入（影子） | MR 评审报告出现「依据经验」标注；影子报表可看注入差异 |
| **P1**（3-5 天） | exp-pipeline（读 archive → 分组 → 抽取 → Review 源码探索 → Dedup → Merge）；评测集 ≥30 条标注 | 对 3 个历史会话跑批：垃圾率 <30%（首期），contradict 进队列 |
| **P2**（3-5 天） | DSH exp_recall 工具；评审纠偏回流；stats 仪表（admin 页） | 会话内可检索经验；回流闭环演示 |
| **P3**（按需） | 生命周期（90 天未命中→retired 候选、仓库重构→批量复核）；contradict 人工裁决 UI | 库规模稳定，无静默膨胀 |

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 抽取垃圾率高（文章初版 90%） | 三层治理从第一天就上；评测集先建；默认保留+定向过滤 |
| 经验与 git 规则漂移 | §4.6 分界表；exp 库不存「必须/禁止」类规则；git→exp 单向同步 |
| code-index-service 单点 | 已部署；P0 顺带修 tag-null 已知坑；经验可整库导出 md |
| LLM 判断不稳定（batch 波动，文章 batch_004 只中 1/6） | 评测集固定样本多轮验证；Merge 唯一目标前置默认 create |
| 事实性错误入库（Agent 会怀疑自己而非经验） | Review 源码探索硬校验；contradict 永远人工 |
| 内网/网络环境 | 管道本地跑，LLM 走 magpie API，检索走内网 18000 |

## 9. 待定决策

1. 提取 LLM 用哪个（magpie 网关里的哪个模型；分层用不同模型？）
2. 经验空间粒度：per-repo + global 双层，还是只 global（SmartPOS 36 仓共享业务语义）？
   建议：per-repo 为主 + global 兜底（分区内唯一 ID 这类跨仓经验进 global）。
3. pipeline 形态：先脚本（`server/exp-pipeline/`，手动/定时跑）还是直接常驻服务？
   建议先脚本，P2 后视量再常驻。
4. 评审纠偏回流的判定信号（哪些评论算「人工纠正」）——P2 定。
