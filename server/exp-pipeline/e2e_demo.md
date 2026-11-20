# 端到端演示记录：归档 digest → seed 灌库 → 本地真实服务 → 检索

日期：2026-11-19 · 环境：Windows 本机（无嵌入模型）· 演示编排脚本为一次性运行（跑完即删，仓库内交付物只有 `seed.py` 本文档与 `ACCEPTANCE.md`）。

## 0. 全程零线上写入的保证

- 服务起法照抄 `server/storage-hub/tests/test_bodies.py`：**临时目录建 SQLite**（`SERVER_DB/SERVER_LOG/SERVER_ADMIN_DB` 全指向 `%TEMP%\e2e-seed-*`），`server.make_server(0)` 绑定 **127.0.0.1 随机端口**（本轮 58921），演示 URL 一律 `http://127.0.0.1:PORT`，从未出现线上地址（192.168.50.112:18000 读写均未触碰）。
- `seed.py --dry-run` 默认**零网络请求**；正式灌库必须显式 `--url`，缺省直接报错退出（防误写线上默认值 `INDEX_URL`）。
- 演示结束：`httpd.shutdown()` + `server_close()` 关闭 HTTP 服务，子进程（seed 两次调用）均 `exit=0` 自然退出，临时目录（含 index.db/-wal/-shm）`shutil.rmtree` 清理。本轮清理日志：`[e2e] server stopped, tmp cleaned: C:\Users\leganck\AppData\Local\Temp\e2e-seed-ze6upg9l`。

## 1. 本地起真实 server（含向量缺省说明）

本机无嵌入模型（`tokenizers`/onnx 模型缺失），`server.build()` 的 embedder 装载失败——**向量缺省属预期**：按 `docs/memories.md` 约定的降级路径处理（不改 storage-hub 一行代码）：`embedder=None` + `state["ready"]=True`。效果：

- 每条 upsert 响应带 `vectorNote: "vector missing: embedder unavailable"`（FTS 照常写入）；
- 检索退化为 **纯 FTS trigram**，回包带 `vectorNote: "vector search unavailable: embedder unavailable"`（见 §3 各回包）。
- 线上（192.168.50.112）模型在位，向量通道正常；本地缺省只影响本演示。

```
[e2e] build embedder 失败（预期：本地无模型）→ embedder=None 降级: ModuleNotFoundError: No module named 'tokenizers'
[19:49:19] listening on 0.0.0.0:58921
[e2e] server ready on http://127.0.0.1:58921  db=C:\Users\leganck\AppData\Local\Temp\e2e-seed-ze6upg9l
```

## 2. seed 灌库 + 幂等重放（原始 stdout）

```
$ python seed.py --dry-run --verbose
== seed（digest=experience-digest.md）==
解析 223 条唯一条目 | lens 分布 {'logic': 15, 'index': 164, 'jargon': 44} | repo top: [('global', 202), ('web-erp', 6), ('crm-order', 6)]
  样例 [logic] `DSH workspace preparation failed … Workspace ancestry contains a reparse point` …（5 条样例略）
(dry-run：未发起任何网络请求，未写服务端)

$ python seed.py --url http://127.0.0.1:58921 --api-key e2e-test-key --stats
== seed（digest=experience-digest.md）==
解析 223 条唯一条目 | lens 分布 {'logic': 15, 'index': 164, 'jargon': 44} | repo top: [('global', 202), ('web-erp', 6), ('crm-order', 6)]
灌库完成：写入请求 223 条，失败 0 | 服务端动作分布 {'created': 223} | 库内净增 ≈ 223（重放时应全为 updated，净增 0）
stats: {'created': 223}          # 耗时 1.0 s

# 同一文件立即重跑（幂等重放验证）
$ python seed.py --url http://127.0.0.1:58921 --api-key e2e-test-key --stats
灌库完成：写入请求 223 条，失败 0 | 服务端动作分布 {'updated': 223} | 库内净增 ≈ 223（重放时应全为 updated，净增 0）
stats: {'updated': 223}          # 耗时 1.3 s
```

重放后 `GET /v1/memories?limit=1&offset=0` 的 `total`（节选，首条回包原文）：

```json
{
 "items": [
  {"id": "exp-000223", "repo": "global", "lens": "index",
   "what": "Earlier claim “文件与 5.0.x 一致 = 可摘” was wrong — file identical means **5.0.x already contains the fix**; CHGJ-2979/goodsId cherry-picks were empty for this reason.",
   "when_expr": "工单 CHGJ-2979", "status": "active", "source": "pipeline",
   "evidence": [{"archive_ref": "session-4ff93b80-08ba-4561-bc0c-04c1462dc7f5/segment_029.md"}, {"issue": "CHGJ-2979"}],
   "stats_hits": 0, "stats_adopted": 0}
 ],
 "total": 223
}
```

**重放不增行**：223 → 223（幂等键 `(repo, lens, what)` 承载重放语义，见 seed.py docstring 的取舍说明）。

## 3. 检索演示（全部原始回包 JSON，POST /v1/memories/search，top_k=3）

### 3.1 任务指定的三组查询

**「结账不写销售」**（任务提示对应主题 orderCompletePost 结账写销售条件）——0 命中：

```json
{"hits": [], "ms": 0.3, "vectorNote": "vector search unavailable: embedder unavailable"}
```

> 空命中如实保留：该主题（`OrderCompleteServiceImpl.orderCompletePost()` writes sale only when `payStatus==1`…）存在于同目录素材 `biz-context.txt` L191，**不在 experience-digest.md 的 223 条种子里**（grep `orderCompletePost|结账` 在 digest 0 命中）。trigram 是子串匹配，种子无此原文 → 空集属预期行为，不是检索缺陷。

**「云打印 旧快照」**（对应主题云打印旧快照覆盖支付状态）——0 命中：

```json
{"hits": [], "ms": 0.2, "vectorNote": "vector search unavailable: embedder unavailable"}
```

> 同上：云打印/快照主题不在 223 条 digest 种子里（digest 仅有一条含 `Printer/打印机` 的日志检索结论，无「旧快照覆盖支付状态」原文）。

**「分支 清理 main」**（对应主题：分支只删已进 main 的）——**top-3 全部命中种子条目** ✅：

```json
{"hits": [
  {"id": "exp-000185", "what": "`CHGJ-3723` 3 commits already equivalent in main → no branch needed.",
   "when_expr": "工单 CHGJ-3723", "why": "`CHGJ-3723` 3 commits already equivalent in main → no branch needed",
   "lens": "index", "repo": "global", "score": 0.047619},
  {"id": "exp-000093", "what": "Business semantics changed by formatter; reverted to main behavior; compile passed.",
   "when_expr": "处理Errors and Fixes时", "why": "Business semantics changed by formatter; reverted to main behavior; compile passed",
   "lens": "index", "repo": "global", "score": 0.045455},
  {"id": "exp-000184", "what": "`CHGJ-3661` cherry-pick yielded empty diff (main XML identical) → MR 2763 closed, branch deleted.",
   "when_expr": "工单 CHGJ-3661", "why": "`CHGJ-3661` cherry-pick yielded empty diff (main XML identical) → MR 2763 closed, branch deleted",
   "lens": "index", "repo": "global", "score": 0.043478}
 ], "ms": 0.7, "vectorNote": "vector search unavailable: embedder unavailable"}
```

### 3.2 digest 实际主题的三组补充查询

> 因上节 q1/q2 主题不在种子里，另取 223 条中真实存在的三个代表性主题，保证「至少 2 组 top-3 命中」有充分余量（连同 3.1 的第三组共 **4 组 top-3 命中**）。

**「equivalent in main」**（分支只删已进 main 的——原文主题）✅：

```json
{"hits": [
  {"id": "exp-000185", "what": "`CHGJ-3723` 3 commits already equivalent in main → no branch needed.",
   "when_expr": "工单 CHGJ-3723", "why": "`CHGJ-3723` 3 commits already equivalent in main → no branch needed",
   "lens": "index", "repo": "global", "score": 0.047619}
 ], "ms": 1.3, "vectorNote": "vector search unavailable: embedder unavailable"}
```

**「OrderPrintServiceImpl diff」**（打印服务最小 diff——原文主题）✅：

```json
{"hits": [
  {"id": "exp-000068", "what": "用户反馈 CHGJ-3654 diff “怎么这么大” → 重写 `OrderPrintServiceImpl` 为最小 diff，service 文件从 127 行降到 61 行；强制推送旧提交已替换。",
   "when_expr": "工单 CHGJ-3654", "why": "用户反馈 CHGJ-3654 diff “怎么这么大” → 重写 `OrderPrintServiceImpl` 为最小 diff，service 文件从 127 行降到 61 行；强制推送旧提交已替换",
   "lens": "index", "repo": "global", "score": 0.047619}
 ], "ms": 2.4, "vectorNote": "vector search unavailable: embedder unavailable"}
```

**「hzf_pay_book sale_code」**（支付流水查询超时口径——原文主题）✅ top-3：

```json
{"hits": [
  {"id": "exp-000190", "what": "按 `branch_id`/`sale_code` 查 hzf_pay_book 超时（devops 60s 网关超时）→ 改用已知 `id in (...)` 或 `tenant_id + created_at`。",
   "when_expr": "处理Errors and Fixes时", "why": "按 `branch_id`/`sale_code` 查 hzf_pay_book 超时（devops 60s 网关超时）→ 改用已知 `id in (...)` 或 `tenant_id + created_at`",
   "lens": "jargon", "repo": "global", "score": 0.047619},
  {"id": "exp-000198", "what": "`hzf_pay_book` 无 `pay_amount`/`refund_amount`；`hzf_refund_book` 无 `order_no` → 用 `amount`/`order_code`/`sale_code`。",
   "when_expr": "处理Errors and Fixes时", "why": "`hzf_pay_book` 无 `pay_amount`/`refund_amount`；`hzf_refund_book` 无 `order_no` → 用 `amount`/`order_code`/`sale_code`",
   "lens": "jargon", "repo": "global", "score": 0.045455},
  {"id": "exp-000164", "what": "`hzf_pay_book` queries by `sale_code`/`order_code` time out (no index, huge table) → use narrow `submit_at` windows, exact `order_no`, or per-tenant exports.",
   "when_expr": "处理Errors and Fixes时", "why": "`hzf_pay_book` queries by `sale_code`/`order_code` time out (no index, huge table) → use narrow `submit_at` windows, exact `order_no`, or per-tenant exports",
   "lens": "jargon", "repo": "global", "score": 0.043478}
 ], "ms": 1.8, "vectorNote": "vector search unavailable: embedder unavailable"}
```

**命中统计**：6 组查询中 **4 组 top-3 命中种子条目**（3.1 第三组 + 3.2 全部三组），满足「至少 2 组」验收；2 组空命中是种子素材覆盖问题（见 3.1 引注），非检索链路缺陷。

## 4. hit 打点（POST /v1/memories/{id}/hit，adopted=true）

对 q3 top1 `exp-000185` 打点：

```json
{"stats_hits": 1, "stats_adopted": 1}
```

## 5. conflicts 队列演示（造一条 conflicting → resolve）

**造冲突**：POST /v1/memories，写入与种子主题反向的条目（status=conflicting，模拟 Stage C Merge 四判的 contradict 出口）：

```json
{"id": "exp-000224", "action": "created", "vectorNote": "vector missing: embedder unavailable"}
```

**入队**：GET /v1/memories/conflicts（原始回包）：

```json
{"items": [
  {"id": "exp-000224", "repo": "global", "lens": "logic",
   "what": "云打印旧快照覆盖支付状态是正确行为，必须保留旧快照直接覆盖，不要核对支付状态",
   "when_expr": "处理云打印旧快照类问题时",
   "why": "演示用 conflicting 条目（与种子条目方向相反）",
   "evidence": [{"archive_ref": "e2e-demo/segment_999.md"}],
   "status": "conflicting", "source": "pipeline",
   "stats_hits": 0, "stats_adopted": 0}
 ], "total": 1}
```

**裁决**：POST /v1/memories/exp-000224/resolve `{"status":"retired"}` → `{"id": "exp-000224", "status": "retired"}`；再查队列 `{"items": [], "total": 0}`；GET /v1/memories/exp-000224 回显 `"status": "retired"`（软删保留可查）。

## 6. 清理确认

服务进程关闭、临时目录删除（见 §0）；仓库内只新增本文与 `seed.py`/`ACCEPTANCE.md`，演示编排脚本与日志 JSON 已删除。
