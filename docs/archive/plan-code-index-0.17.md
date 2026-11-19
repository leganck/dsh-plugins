# code-index 0.17 改进计划（评审导向的双存架构）

> 状态：规划稿 v2（2026-11-18）。**范围裁剪：本轮只做 code-index 插件 + index-server 本体；
> review-service 的改动全部移出（登记为后续独立批次），但其需求仍作为服务端能力的验收场景。**
> 上游决策：本地+远端双存（哈希为通用键）；NAS index-server 定位为「向量 + 图 + 正文 + 经验」
> 四合一的评审事实源；本地 index.db 保会话检索与断网兜底。
> 前序：docs/plan-experience-system.md（经验层复用本服务的 exp 命名空间）。

## 0. 核心判断（为什么这么改）

1. **图（symbols/edges）已落地本地**（lib/graph.js，892 块 → 3325 边 / 167ms），缺查询端与远端同步。
2. **blobs 正文已在 NAS**，但没有任何调用方读它——正文直读端点先建好，
   review-service 怎么接（降级链、开关、影子对比）是它自己的批次，不在本计划内。
3. **检索用不起来**的根因不在索引端（sync 4380 次/周），在消费端：erp-pos 等常用仓没索引、
   无触发时机提示。改进必须「供给侧 + 消费侧」一起动。

## 1. 架构终态

```text
                    ┌─ NAS index-server（共享事实源）──────────────────┐
                    │ chunks/blobs/vectors（已有）                      │
                    │ + symbols/edges（哈希键，P2）                     │
                    │ + memories（exp 经验，经验系统 P0）               │
                    │ + GET .../bodies（正文直读，P1.5）                │
                    │ + search 返回 expand（图邻居，P2）                │
                    └──────────────▲───────────────▲──────────────────┘
                                   │ sync（块+图+经验）│ search/bodies/graph
会话端（本机）─────────────────────┘               │
  index.db：files/chunks/FTS5/symbols/edges        │
  code_search（本地 FTS+远端向量 RRF；expand 本地图）│
  code_graph / exp_recall（P3）                    │

review-service：本轮不动。等 P1.5/P2 端点就绪后另开批次接入
（bodies 直读、graph expand、经验注入都在那一批做）。
```

双存原则：
- **哈希是通用键**：chunk_id 不出本机；远端一切以 (lineage_id, hash) 挂靠，跨分支/跨仓/跨机复用。
- **本地永远可查**：FTS5+本地图 = 断网/容器宕机时的完整降级（keywordOnly 路径已有，图同理）。
- **远端是共享底座**：图与经验放远端，评审/其他机器零成本复用（接入在 review-service 批次）。

## 2. 分期（P1.5 插队，其余沿用原计划）

### P1.5 bodies 直读端点（新插入，0.5 天）

| # | 改动 | 端 | 验收 |
|---|---|---|---|
| 1 | `GET /v1/namespaces/{ns}/bodies?hashes=&max_bytes=`（blobs 直读，批量，上限保护，未命中 hash 如实标注） | server | 现有 namespace 一次取回 ≥50 hash 正文 <200ms |
| 2 | 文档：端点契约 + 降级约定（谁该在什么条件下降级到 worktree/api——留给 review-service 批次执行） | docs | 契约写入 docs/scope-tier3.md 或独立 md |

> review-service 侧的 `_read_range` 改造、`INDEX_BODIES` 开关、影子对比 → 全部移入后续
> review-service 批次，本计划只交付端点与契约。

### P1 收尾（本地图消费端，1 天）

| # | 改动 | 验收 |
|---|---|---|
| 3 | `code_search` 加 `expand?: "callers"\|"callees"\|"mapper"\|"impact"`：命中块 → 本地 `expandFromChunk`，结果带「关联代码」区块（每类 ≤5 条，标注边类型/置信度） | 查 "insertPayBook" 能看到 mapper/dao/service 三角 |
| 4 | 新工具 `code_graph`：`{path, symbol | chunkHint, direction, type?, hops≤2}` 纯图查询 | 影响面查询一次调用返回调用方清单 |
| 5 | `buildIndex` 尾部挂 `rebuildGraph`（全量重建 167ms 量级，先不增量）；`code_index` 返回加 `graph: {symbols, edges, builtAt}` | 建库即出图；status 显示图规模 |
| 6 | 真仓实测：erp-pos mapper 三角 + svc-pay 支付链路影响面 | 人工判定 top-5 命中 ≥3 个真实相关 |

### P2 图上远端（1-2 天）

| # | 改动 | 端 |
|---|---|---|
| 7 | server：`symbols(lineage_id,hash,name,kind,path,start)` / `edges(lineage_id,src_hash,dst_hash,type,weight)`；sync payload 加 `graph` 段（幂等 upsert）；gc 级联 | server |
| 8 | 客户端 sync 时按哈希翻译本地图上报；`vectors: remote` 默认查远端 expand，本地作降级 | plugin |
| 9 | （登记，不在本轮）review-service 用远端 expand 注入调用方/mapper | review |

### P2.5 消费侧修复（从「为什么没用起来」清单落地，0.5 天）

| # | 改动 |
|---|---|
| 10 | 预建 8 个常用仓索引（erp-pos/crm-policy/svc-pay/erp-eai/erp-chain/svc-center/crm-order/svc-saas-business），一次性脚本 |
| 11 | 新 skill `code-index-usage`：触发时机（实现定位/调用链/影响面/跨仓）、expand 用法、path 显式点名约定 |
| 12 | cwd 非 git 仓库时不索引 cwd，报错列出注册表最接近仓库；清理 6 个空库 |
| 13 | profile 依赖 commit 更新为历史重写后的 06ba0fe（重装前必改） |

### P3（经验系统沿用 plan-experience-system.md）

exp 命名空间 + memories CRUD + review 注入经验 top-k（review-service 部分移入该批次）；
`exp_recall` 工具；memories 实体边（借 mnemon entity 思想）与代码图共用 edges 表结构。

## 3. 关键设计约束（实现时不许破）

1. **图是派生数据**：任何机器对同一库可重算 → 远端丢图不丢数据，sync 幂等，无迁移焦虑。
2. **weight 只排序不过滤**：calls 按名字匹配有错边，检索端加权即可，绝不 hard-filter。
3. **遍历有界**：expand ≤2 跳、每类 ≤5 条、总量 ≤20 —— 防上下文洪水（mnemon related 同款纪律）。
4. **降级链完整**：远端图→本地图→无 expand；远端 bodies→worktree→GitLab API。每级降级写进返回注释。
5. **契约先冻结再优化**：calls 提取先用正则（已知不准），tree-sitter 精确化放 P3+，避免边改边迁。
6. **远端 schema 走 blobs/vectors 同款**：(lineage_id, hash) 键 + 幂等 upsert + gc 级联，不发明新机制。

## 4. 验收与度量（P1.5+P1 完成时）

### 4.0 实测基线：erp-pos（2026-11-18，deploy/plat）

| 指标 | 实测 |
|---|---|
| 建库 | 2060 文件 → 9467 块（java 7468 / xml 1823 / md 126 / 其它 50），**19.6s**，AST 1758 文件 |
| 远端同步 | revision 1，上传正文 9408 条，服务端后台嵌入 |
| 嵌入吞吐 | **0.8 块/秒**（rate 配 10，CPU 受限）→ 全量 9467 块约 **3 小时** |
| 检索延迟 | 0.32–0.46s（正常）；嵌入高峰出现 1 次 9.6s |
| 关键词质量 | 带标识符的查询 3–4/5 相关；纯中文查询 0–3/5 |
| 语义质量 | **未评估**（覆盖 <3%，此时 vec-only 命中全是噪声） |
| 噪音 | `*.md` 仅占 1.3% 却因 BM25 词频挤进 top 命中（CHANGELOG/SKILL.md） |

结论：**关键词通道可用，语义通道被嵌入吞吐卡住；低覆盖时的向量融合会引入噪声**。

### 4.1 由此产生的三项必做改进（插入 P1.5 之后）

| # | 改进 | 依据 |
|---|---|---|
| A | **覆盖率闸门**：远端 coverage < 0.2 时按纯关键词检索（跳过向量通道），并在结果里说明 | 覆盖率 3% 时 vec-only 命中 0 相关 |
| B | **文档降权**：`*.md` 在 code_search 里降权或 `mode=code` 时排除 | CHANGELOG/SKILL.md 挤占 top 命中 |
| C | **嵌入吞吐**：服务端加线程/批大小，或首建按预算分批（夜间），并在 `code_index` 结果里给出 ETA | 0.8 块/s → 3 小时，交互式建库不可接受 |

### 4.2 原定度量

| 指标 | 现状基线 | 目标 |
|---|---|---|
| 检索调用/周（服务端 search） | 5 | ≥30（触发 skill + 常用仓就位后自然增长） |
| bodies 端点（P1.5） | 无 | 契约冻结 + 50 hash <200ms；**调用方接入在 review-service 批次度量** |
| 影响面查询「改 X 影响谁」 | 人工 grep 轮次 | code_graph 一次返回 |
| mapper 三角命中 | 0（无此能力） | erp-pos 实测 top-5 ≥3 相关 |
| 空索引库 | 6 | 0 |
| 图覆盖 | 本仓 1 个 | ≥8 常用仓 |

## 5. 风险

| 风险 | 对策 |
|---|---|
| bodies 直读被滥用放大流量 | max_bytes 批量上限 + 仅 hash 命中返回；降级约定写进契约 |
| calls 同名错边误导下游 | weight 排序 + 结果标注「置信度低（同名匹配）」；P3 tree-sitter 精确化 |
| expand 注入上下文膨胀 | 有界遍历 + 「关联代码」区块独立截断（≤1500 字符） |
| 双存漂移（本地图 ≠ 远端图） | 图是派生物：以远端为准对账；本地 rebuild 成本 167ms/仓，可随时重算 |
| 范围蔓延（顺手改 review-service） | 明确边界：本轮交付端点与契约，接入方批次单开 |
