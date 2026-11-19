# storage-hub v2 — M1/M2 验收核对表

对照 `docs/plan-storage-hub.md` §5 里程碑表逐条核对。实测日期 2026-11-19；证据：`server/exp-pipeline/e2e_demo.md`（端到端演示）、`seed.py`（种子脚本）、`pipeline.py`（task-6 管道，本任务只读复用）、`server/code-index-service/docs/memories.md`（task-5 契约）。

## M1 经验闭环（验收标准：3 个历史会话跑批——垃圾率 <30%，contradict 进队列）

| # | 验收标准 | 实测结果（数字） | 达成 | 说明 / 未达成原因 |
|---|---|---|---|---|
| 1 | memories 表 + CRUD/search/hit | 8 端点全部真实 HTTP 实测通过：upsert（幂等：223 条首次全 `created`，重放全 `updated`，库 `total` 223→223 不增行）、list（`total:223`）、get（含 404 口径）、search（6 组查询，4 组 top-3 命中）、hit（`{"stats_hits":1,"stats_adopted":1}`）、delete/resolve（retired 软删，检索随即不可见）、conflicts 队列（入队 total:1 → resolve → total:0） | **达成** | 契约 `docs/memories.md`（task-5 已冻结）；实测见 e2e_demo.md §2–§5 |
| 2 | exp-pipeline（A 本地清洗分层 → B 三层治理） | `pipeline.py` 对 3 个历史会话 dry-run 全部 exit=0（会话与数字见第 3 行）；三层治理完整执行：Review/Dedup/Merge 判定 + 汇总行 | **达成** | Review 拦截、Dedup 合并计数见下；管道为 task-6 交付，本任务只读复用 |
| 3 | 3 个历史会话跑批（`~/.dsh/archive/`） | 会话①`session-4ff93b80…`（36 文件）：候选 **1339**，Review 拦截 **4**，垃圾率 **0.30%**；会话②`session-70d60128…`（21 文件）：候选 **545**，拦截 **0**，垃圾率 **0%**；会话③`session-138826a5…`（13 文件）：候选 **504**，拦截 **1**，垃圾率 **0.20%**。合计候选 **2388**，拦截 **5**，**垃圾率 0.21%（5/2388）** | **达成**（<30%） | 跑批命令：`pipeline.py --dry-run --explore --no-verify --session <id>`（--explore 连本地已灌种子的服务做 Merge 同向只读查询；--no-verify 跳过源码符号证伪——本地服务无代码索引，开了会因 0 hits 误拦，非生产口径）。另附全量（22 会话）dry-run：候选 **4155**、拦截 **5**（垃圾率 **0.12%**）、Dedup 合并 578、动作全部 create |
| 4 | contradict 进队列 | **未达成（演示口径 0 判定）**。3 会话跑批 contradict 判定 **0 条**（动作分布全部 `{'create': N}`），故队列未因跑批进条目；conflicts 队列机制本身已单独实测可用（造 conflicting 条目 → 队列 total:1 → resolve retired → total:0，见 e2e_demo.md §5） | **未达成** | 根因：3 个所选会话的经验与 223 条种子库（来自会话①同源 digest）之间无「同主题反向」对——会话①的候选与种子本就同源（Digest 已提炼），②③是交付类会话，主题（Jenkins/部署/工单流转）与种子不重叠为反向关系。`decide_merge` 的 contradict 判定逻辑存在且被单测覆盖（test_pipeline.py Merge 四判用例），本验收缺的是「真实跑批恰好出现反向对」，属数据覆盖问题而非链路缺陷。**补救口径**：全量 22 会话跑批同样 0 contradict；建议后续用含明确反向经验的会话（如「必须直接 push」vs 种子「403 改推 fork」）复跑 |
| 5 | 223 条种子灌入 | `seed.py --dry-run` 解析 **223** 条（lens: logic 15 / index 164 / jargon 44）；正式灌入 **223 created / 0 failed**（1.0 s），重放 **223 updated**（1.3 s），库内 `total: 223` | **达成** | 幂等口径 `(repo, lens, what)`（服务端 upsert 契约），取舍说明见 seed.py docstring |

**M1 结论**：5 条标准 4 达成 1 未达成（contradict 跑批 0 判定，机制已验证、判定覆盖待补真实反向数据）。

## M2 消费接入（验收标准：MR 报告出现「依据经验 exp-xxx」；影子对比）

| # | 验收标准 | 实测结果（数字） | 达成 | 说明 / 未达成原因 |
|---|---|---|---|---|
| 1 | review-service 注入经验（/v1/memories/search） | 检索端点实测 6 组查询：4 组 top-3 命中（含任务指定「分支 清理 main」），2 组空命中（主题不在 223 条种子里：orderCompletePost/云打印旧快照仅存在于 biz-context.txt 素材）；平均响应 1.1 ms（0.2–2.4 ms）。但 **review-service 侧未接入**（本任务范围仅 exp-pipeline + 验收，review-service 注入属后续 review 批次，见 plan §4 客户端改动表） | **未达成** | 缺的是消费方代码接入，不是 memories 检索能力。检索服务本身已按 review-service 所需契约（top-k hits + ms + vectorNote）就绪 |
| 2 | bodies 直读（/v1/code/.../bodies） | `server/code-index-service/tests/test_bodies.py` **31 通过 / 0 失败**（纯逻辑层 + 真实 HTTP 层：命中/缺失/有界/去重/200 上限/未知 ns 404/URL 解码） | **达成** | 只读复跑服务端自带测试作证据，零改动 |
| 3 | MR 报告出现「依据经验 exp-xxx」 | **0 份** MR 报告带经验引用 | **未达成** | 依赖标准 1（review-service 注入）先行；本任务授权范围不含 review-service 改动 |
| 4 | 影子对比 | 未执行（0 组对比） | **未达成** | 同上：影子对比需要注入链路在线，属 review 批次工作 |

**M2 结论**：4 条标准 1 达成 3 未达成——memories 检索与 bodies 直读的服务端能力已实测就绪，但 M2 的主体验收对象（review-service 注入 → MR 报告引用 → 影子对比）属后续批次，未在本任务（task-7）授权范围内启动。

## 附：跑批原始汇总行

```
session-4ff93b80-…：候选 1339 | Review 通过 1335 / 拦截 4 | Dedup 保留 1227 / 合并 108 | 动作 {'create': 1227} | dry_run=True
session-70d60128-…：候选  545 | Review 通过  545 / 拦截 0 | Dedup 保留  511 / 合并  34 | 动作 {'create': 511}  | dry_run=True
session-138826a5-…：候选  504 | Review 通过  503 / 拦截 1 | Dedup 保留  477 / 合并  26 | 动作 {'create': 477}  | dry_run=True
全量（22 会话）   ：候选 4155 | Review 通过 4150 / 拦截 5 | Dedup 保留 3572 / 合并 578 | 动作 {'create': 3572} | dry_run=True
```

垃圾率口径：Review 拦截数 / 候选数（拦截原因：what<8 字 / 缺 when / 证据空）。
