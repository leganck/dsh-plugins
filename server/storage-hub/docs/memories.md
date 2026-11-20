# 经验资产（memories）存储与 API

经验（memory）= 「在什么仓库 / 什么镜头（lens）下、何时、做什么、为什么」的可复用结论，
由 pipeline 从会话与交付记录里沉淀（`source`），供检索时注入上下文。它与代码块索引是
两种资产：不随作用域快照删除（scope 删了经验仍在），量级小（千级），生命周期由
`status` 驱动。设计背景见 storage-hub v2 规划 §2.3。

## 表结构（与 IndexStore 同一个 SQLite 文件）

```sql
create table if not exists memories (
  id text primary key,          -- 'exp-' + 6 位十进制自增（首个 exp-000001；超 999999 续位）
  repo text not null,
  lens text not null,           -- 经验镜头：code-style / release / deploy / ...（调用方定义）
  what text not null,           -- 经验本体（必填）
  when_expr text,               -- 适用时机/条件（可空；参与嵌入与 FTS）
  why text,                     -- 原因（可空；参与 FTS）
  evidence text,                -- JSON 数组 [{archive_ref|issue|mr}]（至少一项带任一键）
  status text not null default 'active',   -- active | retired | conflicting
  source text not null default 'pipeline',
  stats_hits integer not null default 0,
  stats_adopted integer not null default 0,
  last_hit_at integer,
  created_at integer not null,
  updated_at integer not null,
  against_id text,              -- 冲突配对：与本条冲突的另一条 id（可空）
  trigger_words text            -- 冲突触发词对 json（["必须","无需"]；存 conflicting 行）
);
create virtual table if not exists memories_fts using fts5(
  what, when_expr, why, tokenize='trigram'   -- rowid = memories.rowid（mid）
);
create table if not exists memories_vec (
  mid integer primary key,      -- = memories.rowid
  dim integer not null,
  v blob not null,              -- float32 little-endian
  updated_at integer not null
);
create table if not exists memory_events (
  id integer primary key autoincrement,
  memory_id text not null,
  at integer not null,
  event text not null,          -- created|updated|hit|adopted|conflicted|resolved|retired
  detail text                   -- JSON（触发词/裁决方向等；可空）
);
create table if not exists pipeline_runs (
  id integer primary key autoincrement,
  run_id text not null unique,  -- 重放幂等键（重复上报覆盖）
  started_at integer not null,
  finished_at integer not null,
  engine text not null,         -- rules | llm | digest
  dry_run integer not null default 0,
  candidates integer not null default 0,
  review_passed integer not null default 0,
  review_blocked integer not null default 0,
  dedup_kept integer not null default 0,
  dedup_merged integer not null default 0,
  actions text not null,        -- JSON：{create,update,skip,contradict} 计数
  details text                  -- JSON：拦截/合并/冲突明细摘要（可空）
);
```

- 表由 `index_store.SCHEMA`（`create table if not exists`，migrate 风格）建在现有库上；
  读写走 `index_store.MemoryStore`（与 IndexStore 共用连接与 WAL）。旧库启动时
  自动补 `against_id` / `trigger_words` 列（幂等 alter）。
- `memories_fts` 用 **trigram** 分词：ASCII 与连续中文都按「原文子串」匹配，
  免去自写 CJK 分词；查询侧统一短语化（`"token"`）杜绝 MATCH 语法注入。
- 建库即同步维护 FTS 行（update 不改 what → FTS 不动；what 是幂等键的一部分）。

## API（11 个端点；鉴权与其它 /v1 端点一致：Bearer Key 或后台会话/Basic）

| 方法 & 路径 | 语义 |
| --- | --- |
| `POST /v1/memories` | upsert（幂等）：同一 `(repo, lens, what)` 二次提交 → 同 id + `action:"updated"`，不产生新行 |
| `GET /v1/memories/{id}` | 单条（含 stats_* 与 `timeline` 事件流，见下）；未知 id → 404 `{"error":"unknown-memory"}` |
| `GET /v1/memories?repo=&lens=&status=&q=&stale_days=&limit=&offset=` | 过滤 + 分页（q 为 what/when_expr/why 的 LIKE 子串；limit clamp [1,200]，默认 50）→ `{items,total}` |
| `POST /v1/memories/search` | `{q, repo?, lens?, top_k?=5}` → `{hits:[{id,what,when_expr,why,lens,repo,score}], ms}`（conflicting 命中带 `conflictWarning:true`） |
| `POST /v1/memories/{id}/hit` | `{adopted?:bool}` → `{stats_hits, stats_adopted}`（adopted=true 时采纳数 +1） |
| `DELETE /v1/memories/{id}` | 软删：status=retired（FTS/向量检索随即不可见；列表按 status=retired 仍可查） |
| `GET /v1/memories/conflicts` | status=conflicting 的待裁决队列 `{items,total}`；每条可带 `against`（配对原条目全文）与 `trigger_words` |
| `POST /v1/memories/{id}/resolve` | `{status:"active"|"retired"}` → 裁决冲突条目 |
| `POST /v1/memories/link-conflict` | `{conflicting_id, origin_id, trigger_words?:[]}` → 冲突配对双写（管道 stage_c 调用） |
| `POST /v1/admin/pipeline-runs` | 管道跑批上报（admin 鉴权）：`{run_id, started_at, finished_at, engine, dry_run, candidates, review_passed, review_blocked, dedup_kept, dedup_merged, actions:{}, details:{}}`；run_id 重复覆盖 |
| `GET /v1/admin/pipeline-runs?limit=N` | 跑批列表（admin 鉴权），按 started_at 倒序 → `{items,total}` |

### upsert 请求体

```json
{
  "repo": "erp-eai", "lens": "release",
  "what": "发版前必须跑 selftest 274 项",
  "when_expr": "release/* 分支合并前",
  "why": "曾因漏跑在 3.207 炸过测试",
  "evidence": [{"issue": "CHGJ-3745"}, {"mr": "!892"}],
  "source": "pipeline",
  "status": "active"
}
```

响应 `{"id":"exp-000123","action":"created"|"updated"}`；`status` 可缺省（active）。
校验失败 → 400 `{"error":"bad-memory","detail":...}`；`evidence` 每项必须带
`archive_ref` / `issue` / `mr` 之一。

### 路由顺序（勿改）

`_do_GET`：`/v1/memories/conflicts` → `/v1/memories`（列表）→ `/v1/memories/{id}`；
`_do_POST`：`/v1/memories` → `/v1/memories/search` → `/v1/memories/link-conflict` →
`/v1/memories/{id}/hit` → `/v1/memories/{id}/resolve`。字面路径（search/conflicts/
link-conflict）必须先于 `{id}` 通配判断，否则会被当成 id 吞掉。

## 治理可见性（against / trigger_words / timeline / stale_days / conflictWarning）

- **冲突配对（against）**：conflicting 条目在 upsert 时并不知道对手是谁（只有
  `status=conflicting`）。管道 stage_c 判 contradict 后调
  `POST /v1/memories/link-conflict`：双方 `against_id` 互指，触发词对
  （如 `["必须","无需"]`）存 conflicting 行的 `trigger_words`（json 列）。
  `GET /v1/memories/conflicts` 响应时 join 出 `against`（配对原条目的
  id/what/when_expr/why 全文）与 `trigger_words`。
- **事件时间线（timeline）**：新表 `memory_events(memory_id, at, event, detail json)`；
  upsert（created/updated）、hit/adopted、resolve、软删、冲突配对各写一行。
  `GET /v1/memories/{id}` 组装倒序 `timeline` 返回。**存量数据没有事件**：用
  created_at / stats_* 推一条合成 timeline（created + last-hit/adopted，detail 带
  `synthesized:true`），老条目 timeline 不为空。
- **陈旧过滤（stale_days）**：`GET /v1/memories?stale_days=90` → WHERE
  `status='active' and (last_hit_at is null or last_hit_at < now - N*86400)`，
  用于 admin 盘点长期没人用的经验（该复盘/退役）。
- **冲突召回（conflictWarning）**：search 的检索口径为 **active + conflicting 都参与**
  （Memanto 模型：冲突未决双方保持可召回，不带偏见地同时给出）；conflicting 命中
  在 hit 对象上带 `conflictWarning:true`，调用方自行决定是否采纳/提示。retired 永不出现。
- **跑批留痕（pipeline_runs）**：管道每跑一次向 `POST /v1/admin/pipeline-runs` 上报
  候选/Review 拦截/Dedup 合并/四判计数与明细摘要；admin UI「经验治理」据此从
  "只有结果"变成"有过程"。run_id 重复覆盖（重放幂等）。

## 向量策略

- **入库**：upsert 成功后同步嵌入 `what + "\n" + when_expr`（**非 query 侧**，不加
  QUERY_PREFIX）；经验量小，不走 governor。向量写 `memories_vec`（float32 blob）。
- **查询**：search 用现有 embedder 以 **query 侧**编码（自动加 QUERY_PREFIX，与
  `/v1/search` 同一约定），随后暴力点积（L2 归一化后即 cosine）——条目量小，无需 ANN。
- **降级**：embedder 不可用（模型缺失/异常）时向量缺省，upsert 与 search 均不失败；
  search 退化为纯 FTS，并在响应加 `vectorNote` 说明原因。模型热切换后库内混维向量
  按查询维度过滤（异维行跳过，不崩 vstack）。

## 检索融合（与代码检索同法）

FTS5 与向量两通道各取名次列表，RRF 融合：`score = Σ 1/(20 + rank)`（`rank` 从 1 起，
k=20 与 `server.RRF_K`、插件 `lib/search.js` 一致）。双通道都命中的条目分数自然更高。
排序键 `(-rrf, -vec_score, id)`；命中字段裁剪为契约的 7 个键（conflicting 命中
额外带 `conflictWarning:true`，见「治理可见性」节）。
检索看 `status in ('active','conflicting')`（冲突未决也参与召回，带标；retired 不出）。

## 统计

- `_endpoint_group`：`/v1/memories*` → `memories` 分组；统计上该端点组计入
  **retrieval** 类（经验检索也是检索），业务/系统四类口径不变。
- `/v1/admin/stats` 响应新增 `memories: {total, hits, adopted}`（条目总数 / 命中与
  采纳总数；采集失败不影响统计接口）。

## 测试

`python tests/test_memories.py`（embedder 用 `FakeEmbedder` stub，不需要 onnxruntime）：
upsert 幂等、FTS 命中（中文 trigram 子串）、RRF 融合、hit/adopt 计数、软删后检索不可见、
conflicts 队列与 resolve、分页过滤、embedder 缺席降级（vectorNote）、路由不互吞、
鉴权与 admin stats 盘点；治理可见性：pipeline_runs 上报/列表/覆盖、link-conflict
双写 against+trigger_words、timeline 组装（真实事件 + 存量合成 synthesized）、
stale_days 过滤、conflicting 参与 search 且带 conflictWarning。
