# storage-hub 表设计 v2（不兼容历史数据，全量重设计）

> 前提：用户已确认「历史数据可不兼容清理」。因此去掉所有兼容层（CAS 双表、merged_into 墓碑、
> synthesized timeline、status 三态混用），按**单一职责 + 外键 + STRICT** 重画。
> 目标：一张表只干一件事，查询靠索引而不靠 JOIN 猜，删除靠 cascade 而不靠手工清。

---

## 0. 设计原则

| 原则 | 落法 |
|---|---|
| 一种数据只存一份 | 正文进 `blobs(hash)`、向量进 `vectors(tag,hash)`（CAS），`chunks` 只存"谁有哪些块" |
| 整数主键 + 外键 + cascade | 不再用 `namespace` 这种复合字符串当主键；删除自动级联 |
| `STRICT` 表 | 类型错误插不进去（旧库最大的隐患是 `'123'` 与 `123` 混存） |
| 状态用「表」不用「列值」 | 冲突独立成 `memory_conflicts`，不再用 `status='conflicting'` 复用 memories |
| 幂等键显式化 | `memories.fingerprint` 唯一索引，upsert 靠它，不靠 `(repo,lens,what)` 长文本比对 |
| 事件全部留痕 | `memory_events` 只追加；不再"存量合成 timeline" |
| 索引跟着查询走 | 每个索引都写明它服务哪个查询（§4） |

---

## 1. 表清单

```text
代码资产（4 张）
  lineages   仓库血统（跨克隆同一性）
  scopes     一次快照：main/branch/pr/worktree + 切块指纹 + 子目录
  chunks     快照 → 块清单（path/start/end + hash）
  blobs      块正文（hash 全局唯一）
  vectors    块向量（tag+hash 全局唯一）

经验资产（6 张）
  memories          经验条目（含 category/lens/workflow/audit）
  memory_vectors    经验向量（1:1）
  excerpts          证据片段（CAS，sha256 唯一）
  memory_excerpts   经验 ↔ 证据 关联（多对多）
  memory_conflicts  冲突（一等公民，含人工裁决理由）
  memory_events     事件流（created/hit/adopted/conflicted/resolved/retired）

任务与统计（3 张）
  exp_jobs    抽取任务（每次会话段落一条）
  api_calls   调用统计（替代现在按端点散落的计数）
  meta        库元数据（schema_version / 当前 embedding tag）

FTS（2 个虚拟表）
  chunks_fts   代码块全文（服务端只在需要时用；主检索在客户端）
  memories_fts 经验全文（trigram，中文子串可命中）
```

---

## 2. 完整 DDL

```sql
-- ---------------------------------------------------------------- 基础
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;          -- 每个连接都要设

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- 必需键：schema_version='2' / embed_tag / chunk_schema

-- ---------------------------------------------------------------- 代码资产
-- 血统：一个来源仓库（跨克隆/跨机器同一性）
CREATE TABLE lineages (
  id          INTEGER PRIMARY KEY,
  repo_name   TEXT NOT NULL,              -- 逻辑仓库名（smartpos-erp-pos），展示与分组用
  url_norm    TEXT,                       -- 归一化 origin URL；无 remote 时为 NULL
  root_hint   TEXT,                       -- 无 remote 时的兜底识别（目录名 + 首个 commit）
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX lineages_url  ON lineages(url_norm) WHERE url_norm IS NOT NULL;
CREATE UNIQUE INDEX lineages_root ON lineages(root_hint) WHERE root_hint IS NOT NULL;
CREATE INDEX        lineages_name ON lineages(repo_name);

-- 快照：一个 lineage 的一次具体视图（分支/PR/worktree/子目录）
CREATE TABLE scopes (
  id            INTEGER PRIMARY KEY,
  lineage_id    INTEGER NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,            -- main | branch | pr | worktree
  ref           TEXT NOT NULL DEFAULT 'default',
  root_rel      TEXT,                     -- 子目录索引时相对仓库根的路径；整库为 NULL
  chunk_fp      TEXT NOT NULL,            -- 切块指纹（策略+窗口+代码版本共同决定）
  namespace     TEXT NOT NULL,            -- 对外协议字符串 <repoId>@<chunkFp>#<kind>:<token>
  tag           TEXT,                     -- 当前 embedding 模型 tag
  revision      INTEGER NOT NULL DEFAULT 0,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  vector_count  INTEGER NOT NULL DEFAULT 0,
  repo_state    TEXT,                     -- 内容态指纹（判定"真的变了没"）
  commit_sha    TEXT,
  simhash_path     TEXT,                  -- 跨血统复用的相似度指纹
  simhash_content  TEXT,
  simhash_algo     TEXT,
  simhash_files    INTEGER,
  simhash_at       INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX scopes_namespace ON scopes(namespace);
CREATE UNIQUE INDEX scopes_ident ON scopes(lineage_id, kind, ref, COALESCE(root_rel,''), chunk_fp);
CREATE INDEX scopes_lineage ON scopes(lineage_id, updated_at DESC);

-- 块清单：这个快照里有哪些块（正文/向量都在别处，按 hash 引用）
CREATE TABLE chunks (
  scope_id   INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  PRIMARY KEY (scope_id, path, start_line)
) STRICT;
CREATE INDEX chunks_hash  ON chunks(hash);
CREATE INDEX chunks_scope_path ON chunks(scope_id, path);

-- 块正文：内容寻址，全局唯一（同内容多快照只存一份）
CREATE TABLE blobs (
  hash       TEXT PRIMARY KEY,
  body       BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- 块向量：内容寻址（同 hash 同 tag 只算一次）
CREATE TABLE vectors (
  tag        TEXT NOT NULL,
  hash       TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tag, hash)
) STRICT;

-- ---------------------------------------------------------------- 经验资产
CREATE TABLE memories (
  id          INTEGER PRIMARY KEY,           -- 对外 id = 'exp-' || printf('%06d', id)
  fingerprint TEXT NOT NULL,                 -- sha1(category|workflow|lens|what)，upsert 幂等键
  category    TEXT NOT NULL,                 -- business|debug|repo|tool   （process 不入库）
  lens        TEXT NOT NULL,                 -- jargon|index|logic
  workflow    TEXT,                          -- erp-bug|pay-bug|release|erp-req|ops|ledger|local-dev|...
  repo        TEXT,                          -- 主仓库名；跨仓/全局为 NULL
  what        TEXT NOT NULL,
  when_expr   TEXT NOT NULL,
  why         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',-- active|retired      （无可疑三态）
  source      TEXT NOT NULL,                 -- seed|manual|llm:<job_id>
  audit       TEXT,                          -- json {reusable_because, exclusions, prompt_version}
  exp_job_id  INTEGER REFERENCES exp_jobs(id) ON DELETE SET NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  adopted     INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX memories_fp     ON memories(fingerprint);
CREATE INDEX        memories_cat    ON memories(category, status);
CREATE INDEX        memories_wf     ON memories(workflow, status);
CREATE INDEX        memories_lens   ON memories(lens, status);
CREATE INDEX        memories_hit_at ON memories(last_hit_at);      -- 陈旧筛选
CREATE INDEX        memories_created ON memories(created_at DESC); -- 列表分页

-- 经验向量（1:1，独立表而不是塞进 memories：重建向量不动行）
CREATE TABLE memory_vectors (
  memory_id  INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- 证据片段：CAS（同片段被多条经验引用只存一份）
CREATE TABLE excerpts (
  id          INTEGER PRIMARY KEY,
  sha256      TEXT NOT NULL UNIQUE,
  text        TEXT NOT NULL,               -- 已裁剪 + 已脱敏，≤2KB
  kind        TEXT NOT NULL DEFAULT 'quote',-- quote|context|command|log|sql
  archive_ref TEXT,                        -- 本机归档指针 segment_NNN.md#seq（可选）
  captured_at INTEGER NOT NULL,
  expires_at  INTEGER                      -- 到期只保留 text 前 200 字
) STRICT;

CREATE TABLE memory_excerpts (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  excerpt_id INTEGER NOT NULL REFERENCES excerpts(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, excerpt_id)
) STRICT;
CREATE INDEX memory_excerpts_ev ON memory_excerpts(excerpt_id);

-- 冲突：一等公民。双方都是 active（Memanto 模型：冲突未决仍可召回）
CREATE TABLE memory_conflicts (
  id          INTEGER PRIMARY KEY,
  memory_a    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_b    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  trigger_words TEXT,                      -- json 数组
  status      TEXT NOT NULL DEFAULT 'open',-- open|keep_a|keep_b|keep_both|merged
  resolution  TEXT,                        -- 人工裁决理由（文章要求留痕）
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (memory_a, memory_b)
) STRICT;
CREATE INDEX memory_conflicts_open ON memory_conflicts(status, created_at DESC);

-- 事件流：只追加，用于条目 timeline 与漏斗统计
CREATE TABLE memory_events (
  id        INTEGER PRIMARY KEY,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  at        INTEGER NOT NULL,
  event     TEXT NOT NULL,                 -- created|updated|hit|adopted|conflicted|resolved|retired|restored
  detail    TEXT                           -- json
) STRICT;
CREATE INDEX memory_events_mid ON memory_events(memory_id, at DESC);
CREATE INDEX memory_events_at  ON memory_events(at DESC);

-- ---------------------------------------------------------------- 任务与统计
CREATE TABLE exp_jobs (
  id             INTEGER PRIMARY KEY,
  session_id     TEXT,
  segment_no     INTEGER,
  workflow       TEXT,
  mode           TEXT NOT NULL,            -- server|client
  status         TEXT NOT NULL,            -- queued|running|done|failed|skipped
  model          TEXT,
  prompt_version TEXT,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  ms             INTEGER,
  candidates     INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,
  created_n      INTEGER NOT NULL DEFAULT 0,
  updated_n      INTEGER NOT NULL DEFAULT 0,
  skipped_n      INTEGER NOT NULL DEFAULT 0,
  contradicted_n INTEGER NOT NULL DEFAULT 0,
  reasons        TEXT,                     -- json 各类垃圾拦截计数
  error          TEXT,
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER
) STRICT;
CREATE INDEX exp_jobs_created ON exp_jobs(created_at DESC);
CREATE INDEX exp_jobs_seg     ON exp_jobs(session_id, segment_no);

CREATE TABLE api_calls (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  group_   TEXT NOT NULL,                  -- search|sync|bodies|memories|admin|exp
  key_id   TEXT,
  ms       INTEGER,
  status   INTEGER,
  err      TEXT
) STRICT;
CREATE INDEX api_calls_at    ON api_calls(at DESC);
CREATE INDEX api_calls_group ON api_calls(group_, at DESC);

-- ---------------------------------------------------------------- FTS
-- 经验全文：外部内容表 + 触发器同步（不再手工维护两份文本）
CREATE VIRTUAL TABLE memories_fts USING fts5(
  what, when_expr, why,
  content   = 'memories',
  content_rowid = 'id',
  tokenize  = 'trigram'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, what, when_expr, why)
  VALUES (new.id, new.what, new.when_expr, new.why);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, what, when_expr, why)
  VALUES ('delete', old.id, old.what, old.when_expr, old.why);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF what, when_expr, why ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, what, when_expr, why)
  VALUES ('delete', old.id, old.what, old.when_expr, old.why);
  INSERT INTO memories_fts(rowid, what, when_expr, why)
  VALUES (new.id, new.what, new.when_expr, new.why);
END;

-- 代码块全文（trigram；服务端仅在 fts 模式或管理端搜索时用）
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  body,
  content   = 'blobs',
  content_rowid = 'rowid',
  tokenize  = 'trigram'
);
```

---

## 3. 与旧库的关键改动（逐条说为什么）

| 旧 | 新 | 原因 |
|---|---|---|
| `repos` 表（namespace 当主键，23 列混装） | `lineages` + `scopes` 两表 | 血统（跨克隆身份）与快照（分支/指纹）是两件事；旧表一列 `namespace` 编码了三层语义 |
| `vectors`（成员表，v 已清空）+ `vectors_v2`（CAS） | **单表 `vectors(tag,hash)`** | 双表是 CAS 迁移的过渡态，查询要 JOIN 两次；成员关系由 `chunks.hash` 推出 |
| `blobs(lineage_id, hash)` | `blobs(hash)` | 正文本来内容唯一，挂 lineage 纯冗余（实测多存 461 行 chunk / 2049 行向量） |
| `lineages.merged_into` 墓碑 | 无 | 不兼容历史 → 合并直接改写 lineage_id 并删空血统，不留墓碑 |
| `memories.status` 三态（active/retired/conflicting） | 两态 + `memory_conflicts` 表 | 冲突是"两条经验的关系"，不是一条经验的状态；旧设计导致双写 against_id 且检索要特判 |
| `memories_fts` 手工双写 | 外部内容 FTS + 触发器 | 手工维护必然漂移（旧库靠 upsert 里两处 insert 保证，漏一处就不同步） |
| `memories_vec(mid, ...)` rowid 关联 | `memory_vectors(memory_id)` | rowid 是隐式契约，换表/换存储就断 |
| `memory_events` + "存量合成 timeline" | `memory_events` 只追加真实事件 | 不兼容历史 → 没有"存量"，合成逻辑整段删掉 |
| `pipeline_runs`（跑批） | `exp_jobs`（每次抽取一段） | 粒度从"一批"到"一段"，才能显示 §10 的进度条 |
| 无统计表（server 内存/日志统计） | `api_calls` | 重启不掉统计；admin 趋势图有源 |
| 无 `excerpts` | `excerpts` + 关联表 | §11 证据可复核；sha256 CAS 避免重复存 |

---

## 4. 索引 ↔ 查询对照

| 索引 | 服务的查询 |
|---|---|
| `scopes_namespace` | sync/search 按 namespace 定位快照（最热路径） |
| `scopes_ident` | 同 lineage 同 kind/ref/root 是否已有快照（去重） |
| `chunks(scope_id, path, start_line)` PK | 增量同步比对（按文件取块） |
| `chunks_hash` | 正文/向量可达性检查、GC 引用计数 |
| `vectors(tag, hash)` PK | kNN 取样（先按 scope 的 hash 集合过滤） |
| `memories_cat` / `memories_wf` / `memories_lens` | admin 类型分布卡与筛选（§10.1） |
| `memories_hit_at` | 「可退役」筛选（stale_days=90） |
| `memory_conflicts_open` | 收件箱「待裁决 N」 |
| `exp_jobs_created` | 治理流水时间线 |
| `api_calls_group` | 统计 tab 按端点趋势 |

**GC（删除快照后清孤儿）**：
```sql
DELETE FROM chunks WHERE scope_id = ?;                       -- cascade 已做
DELETE FROM blobs  WHERE hash NOT IN (SELECT hash FROM chunks);
DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM chunks) ;
```
（`vectors.hash` 有外键指向 `blobs`，blobs 被删则级联删向量）

---

## 5. 落地方式：**重置重建**（不写迁移代码，向量清空重算）

用户已确认：不写兼容代码、可以清空向量重新计算。于是整条迁移路径消失，只剩"重置 + 客户端重推"。

### 5.1 为什么不迁移了

| 原计划 | 现在 | 理由 |
|---|---|---|
| 写 `tools/migrate-v1-to-v2.py` 转换 40k 块 / 23k 向量 | **不写** | 迁移代码本身就是"兼容层"，且要维护两套字段映射、三重校验 |
| 保留代码向量省 4 小时重嵌 | **清空重算** | 用户接受重算；换来 schema 干净 + 一次免费换精度窗口（§5.4） |
| 经验 223 条转换 | **随库清空** | 本来就是要重抽的废料，顺带把"旧 200 条如何处置"这个问题消解掉 |

### 5.2 执行单（部署窗口内，约 10 分钟 + 后台重嵌）

```text
① 备份（回滚用，保留 30 天）
   docker exec dsh-embed cp /data/index.db /data/index.db.bak-$(date +%Y%m%d%H%M)

② 停服务 → 起新版本（新镜像自带新 SCHEMA，检测到旧库直接拒绝启动）
   —— 不做"启动自动迁移"，旧库就是不能开，避免半迁移状态

③ 重置
   docker run --rm -v dsh-embed-data:/data --entrypoint sh dsh-embed:new -c \
     'rm -f /data/index.db /data/index.db-wal /data/index.db-shm'
   （或：起服务时带 SERVER_DB_RESET=1 只在新 schema 空库时生效）

④ 起服务 → 健康检查
   /health  ready=true；/v1/admin/stats 里 scopes=0

⑤ 客户端重推（代码资产）
   本机跑预索引脚本覆盖常用仓：node scripts/preindex-common-repos.mjs
   或在各仓跑一次 code_index（插件会重传 manifest + 正文）
   观察：/v1/scopes 逐个出现；chunks 计数上涨

⑥ 后台重嵌（服务自己干）
   governor 自动排队；/v1/namespaces/{ns}/status 看 pending / speed / etaSeconds
   期间检索仍可用：覆盖率 <20% 时闸门自动退纯关键词（已有逻辑）

⑦ 经验重抽（与⑤⑥并行）
   POST /v1/admin/exp/replay {all:true, apply:true} 从本机归档重抽入库
```

### 5.3 重算成本（实测基线）

| 项 | 数量 | 速率 | 耗时 |
|---|---|---|---|
| 块正文重传 | 40,175 行 / 64 MB | LAN 十几 MB/s | 1~2 分钟 |
| 待嵌块（CAS 去重后） | ≈21,700 条 × 768 维 | 当前 fp16 实测 **≈1.6 块/s**（2× 优化后） | **≈3.8 小时** |
| 同上，若换 fp32/int8 | 同上 | 预估 5~20× | **15~45 分钟** |

### 5.4 顺带解决：这是唯一免费的"换精度"窗口

反正要重算全部向量，**现在换精度不额外付出任何代价**（平时换模型 tag 意味着全量重嵌，所以一直没做）。
建议流程：

```text
1. 用 20 条真实查询做 A/B：fp16（现状）vs fp32（或 int8）
   指标：top-10 与人工判断的重合度、检索延迟、嵌入吞吐
2. 若 fp32 质量不降（预期不降，fp16 只是精度损失）→ 直接上 fp32：
   重嵌时间 3.8h → 约 40min，且以后每块都更快
3. 结论记进 docs/embed-throughput.md，tag 一次性定为 bge-base-zh-v1.5-...-fp32
```

### 5.5 回滚

```text
mv /data/index.db.bak-<ts> /data/index.db && 起旧镜像
（旧库与新 schema 不兼容，回滚必须同时回滚镜像版本）
```


---

## 6. 代码改动面

| 文件 | 改动 |
|---|---|
| `index_store.py` | 重写 DDL（SCHEMA 常量）+ 去掉 `cas_migrate_*`/`vectors_v2`/`merged_*` 全部兼容代码；`MemoryStore` 拆成 `MemoryStore`（memories/excerpts/conflicts/events）与 `JobsStore`（exp_jobs/api_calls） |
| `server.py` | 路由不变（对外契约保持 `exp-XXXXXX` 与 namespace 字符串）；payload 层改用新表；`/v1/memories/{id}` 接受 `exp-000123` 解析为整数 |
| `knn.py` | 取样路径：`scopes → chunks.hash 集合 → vectors(tag,hash)` |
| `governor.py` | 写入路径改 `vectors(tag,hash)` upsert（无成员表） |
| tests | 三套测试改为新 schema 基线；新增 `test_schema.py`（约束/级联/触发器/FTS 同步） |

**对外契约保持不变**：namespace 字符串格式、`exp-000123` ID、`/v1/*` 响应字段名（额外加 `lensLabel`/`categoryLabel`）。
所以插件与 exp-pipeline **不需要改**。

---

## 7. 风险

| 风险 | 对策 |
|---|---|
| 重置后要重嵌 ~21.7k 块（fp16 约 3.8h） | 换 fp32/int8 压到 15~45min（§5.4）；期间闸门自动退纯关键词，检索不中断 |
| 重置后客户端不重推，库长期空 | 部署后立刻跑 `preindex-common-repos.mjs` 覆盖常用仓；`/v1/admin/stats` 的 scopes 数作为验收项 |
| 重推期间覆盖率低导致检索质量下降 | 覆盖率闸门（<20% 退纯关键词）已在线上；`coverageGateNote` 会告诉调用方原因 |
| 新 schema 性能回退 | 新库起来后跑同一组基准（search/sync/status 各 100 次），对比新旧 P95；不一致就回滚镜像 |
| FTS 触发器写放大 | 只对 `what/when_expr/why` 挂触发器；经验写入频率极低（每天几条） |
| STRICT 表拒绝隐式类型 | 写入层显式 int()/str()；这本身是收益（旧库里 `'123'` 与 `123` 混存是隐患） |
| 停服窗口 | 停服 → 删库 → 起服务 ≈ 30 秒，可与下次镜像部署合并 |

