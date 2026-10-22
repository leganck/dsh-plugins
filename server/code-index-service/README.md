# code-index-service —— 远端索引服务（/v1 索引层 + /embed + /rerank）

`dsh-code-index` 插件默认**全在本机**。这个服务是可选的一台"算力/存储都放外面"的机器：

- **0.7.0 的用法**：只借算力 —— `POST /embed`（算向量）、`POST /rerank`（重排），索引仍在本地。
- **0.8.0 的用法**：整个向量索引搬过来 —— 插件只留 BM25，本服务负责同步、嵌入、kNN、重排。

两者共存，同一份模型、同一套向量标签。

## 实测（本机 RX 6750 XT / DirectML ↔ NAS Tesla P4 / CUDA 12 + ORT 1.19.2）

| 动作 | 本机 | 这台服务 | 说明 |
|---|---|---|---|
| 建库向量（512 token 长块） | **33.05 块/s** | 26.8 块/s | 本机更快（750 W vs 75 W 的卡，不意外） |
| 单条查询嵌入 | 45 ms（DML）/ 26 ms（CPU） | **15.8 ms**（含局域网） | 远端赢在"没有每次调用的 45 ms 固定开销" |
| 重排每候选 | 36 ms | **4.8 ms** | 远端快 7.5× |
| 服务端 kNN（16 万块 × 768 维，fp32） | — | **14.3 ms** | 470 MB 常驻内存；np16 会慢 30 倍，别用 |
| 端到端混合检索（1,503 块） | 40–68 ms | **≈19 ms**（含往返） | 服务端拆分：embed 7.4 + knn 0.1 |
| 端到端混合检索（**160,507 块**） | — | **p50 30 ms / p90 37.5 ms** | embed 7.7 + kNN 14.6；矩阵 493 MB |
| 冷启（第一次查询建 493 MB 矩阵 + 首次计数） | — | **25 ms**（已挪到启动期预热，日志 warmup: knn … 1752 ms） | 之前是 2.4 s；WARMUP=0 可还原 |
| 单仓占用（16 万块） | — | 800 MB | 正文 332 MB + fp32 向量 468 MB |

> 结论：**建库搬过来不划算（慢 23%），查询与重排划算**。默认让插件全本机，按需把
> `vectorStore` / `rerankBackend` 切到 remote。

## 目录

```
code-index-service/
├── server.py        # HTTP 路由（单次 write + 关 Nagle；小响应少 40 ms）
├── index_store.py   # 血统 / 命名空间 / blobs / chunks / vectors；sync、GC、adopt
├── knn.py           # 内存矩阵 + revision 失效 + 总字节 LRU
├── governor.py      # 后台嵌入：限流、暂停、优先级、进度
├── embedder.py      # ONNX 嵌入会话 + 向量标签（tag）
├── reranker.py      # 交叉编码器重排
├── selftest.py      # 不需要模型的自测（FAKE_EMBED=1），81 项
├── Dockerfile       # 一个文件出 4 种镜像：base / nomodel / embed / embed-rerank
├── docker-entrypoint.sh  # 拼 CUDA 路径、查设备、校验模型、/data 权限；能降级就降级
├── scripts/fetch-models.mjs  # 拉模型 → models/model、models/model-rerank（也支持 --check）
├── compose.yaml     # 默认部署：GHCR latest-cpu，镜像自带嵌入模型
├── compose.gpu.yaml # GPU 覆盖层：设备预留 + CUDA providers
├── compose.build.yaml  # 本地自建（模型走 --build-context，不进主上下文）
├── .env.example     # HOST_PORT / API_KEY / ORT_THREADS …
├── deploy/legacy/   # 历史非容器路径（start.sh + 旧 compose），仅参考
├── models/          # 构建用模型（.gitignore；embed 194 MB + rerank 531 MB）
└── /data            # 容器卷：index.db 与 server.log（运行时生成）
```

## 数据模型：为什么按"血统"存

```sql
lineages(id, url_norm, created_at, last_seen)
repos   (namespace, lineage_id, repo_id, chunk_fp, revision, tag, repo_state,
         scope_kind, scope_ref, commit_sha, ttl_days, expires_at, pinned, created_at)  -- 档 3
blobs   (lineage_id, hash, body)                     -- 正文，血统内按内容哈希去重
chunks  (namespace, lineage_id, path, start, end, hash)
vectors (lineage_id, tag, hash, dim, v)              -- 向量，血统内按内容哈希去重
```

**实测依据**（4 个无关仓库两两比对）：跨项目块重合 **0.00%**，同仓库跨分支 **~98%**、同仓库内重复块 0.1–0.4%。

所以：

- **存储边界是血统**（= 归一化后的 git remote URL）。10 个分支的同一仓库只占 **235 MB**；
  按分支各存一份就是 **2.35 GB**；全局存无关项目则是纯累积（0% 收益）。
- **去重按内容哈希**：改文件只有变化的块需要重嵌；第二个克隆 **0 块新嵌入**（实测）。
- 跨血统只留显式口子：`POST /v1/lineages/{id}/adopt {from, hashes?}`（fork / vendor 借用）。
- 上界：`MAX_VECTORS_PER_LINEAGE`（默认 50 万块）、`MAX_TOTAL_GB`（默认 20 GB）→ 超限 **507 + 可清理清单**，
  不静默丢数据。`RETENTION_DAYS`（默认 30）控制"没人引用的 blob/vector 什么时候删"。

## 端点

| 端点 | 说明 |
|---|---|
| `POST /v1/repos/{ns}/sync` | 清单差分。`{repoState, revision?, mode:'diff'|'full', tag, url, repoId, chunkFp, lineage?, scope?{kind,ref,commit?,ttlDays?}, upsert[], remove[]}` → `{revision, unchanged, missing[], chunks, vectors, coverage, namespace}` |
| `POST /v1/repos/{ns}/chunks` | 上传缺失正文（gzip、批量、幂等）→ `{accepted, deduped}` |
| `POST /v1/repos/{ns}/embed` | 触发后台嵌入（可带 `rate`） |
| `GET /v1/repos/{ns}/status` | `{revision, chunks, vectors, coverage, pending, rate, paused, totalBytes, scope{kind,ref,commit,createdAt,expiresAt,pinned}, limits}` |
| `POST /v1/search` | `{namespace}` 或 `{namespaces:[{namespace,weight?}]}, query, k, tag?, rerank:{candidates}}` → `{hits[{hash,path,start,end,score,namespace,scope,rrf,rerankScore?}], ms{embed,knn,rerank}, coverage, byScope[]}` |
| `GET /v1/scopes?repoId=&kind=` | 作用域清单：`{namespace, kind, ref, repoId, chunkFp, revision, commit, chunks, vectors, coverage, createdAt, expiresAt, pinned, ttlRemaining}` |
| `POST /v1/scopes/resolve` | `{repoId, chunkFp, kind, ref, commit?}` → `{namespace, exists, revision?}`；非法 → `400 {error:'bad-scope', reason}` |
| `POST /v1/scopes/{ns}/pin` | `{pinned, ttlDays?}` → `{namespace, pinned, expiresAt}`（`ttlDays:null` = 永久） |
| `DELETE /v1/scopes/{ns}` | 删 scope + 对血统做 retention GC → `{deleted, chunks}`（幂等；未知 ns → `{deleted:false}`） |
| `POST /v1/admin/pause` `/resume` `/rate` `/gc` `/sweep` | 治理 / `sweep` 立即跑一遍 janitor → `{deleted:[ns], lineages:[...], gc?}` |
| `GET /v1/admin/models`、`POST /v1/admin/models/{name}/download` `/cancel` | **模型下载**：进度/速度、取消、失败重试、强制重传、断点续传、sha256 校验 |
| `POST /v1/admin/models/activate`、`POST /v1/admin/models/deactivate` | **模型热切换**：`{kind:'embed'|'rerank', dir|name}` 动态加载，无需重启（见下文） |
| `POST /v1/admin/reset-index` | **清空索引**：`{confirm:'RESET'}` 删除全部作用域/块/向量/正文并 VACUUM（Key/统计保留）；客户端下次同步自动全量重建 |
| `GET /v1/admin/keys`、`POST /v1/admin/keys`、`POST /v1/admin/keys/{id}/enable|disable`、`DELETE /v1/admin/keys/{id}` | **API Key 管理**（明文只返回一次，服务端只存 sha256） |
| `GET /v1/admin/stats?days=7` | **调用统计**：按天/按 Key/按端点（请求、错误、embed/search/rerank、延迟、**P50/P95**、**上期对比**）；`days=1/7/30` |
| `POST /admin/login` `/admin/logout` `/admin/setup` | 控制台会话（HttpOnly Cookie，12h）/ 首次初始化管理员密码 |
| `POST /v1/lineages/{id}/adopt` | 显式跨血统借用 |
| `POST /embed` `POST /rerank` | 0.7.0 兼容：只借算力 |
| `GET /` `/v1/status` `/health` `/log` | 自述（模型、tag、重排状态、治理状态、作用域概览）。`/health` 免鉴权但**无人认领时只返回最小探活字段**；`/` 对浏览器（`Accept: text/html`）302 到 `/admin`，对 API 客户端仍返回 JSON（插件 `describe` 契约） |
| `GET /admin` | **控制台**（单文件 HTML，无外部依赖）：登录页 + 6 个 Tab（概览 / 模型 / API Key / 统计 / 作用域 / 日志）；支持暂停嵌入、清扫、热切换模型、Key 管理、调用统计 |

### 鉴权：API Key（可多把）+ 控制台会话

索引客户端和控制台是两套入口，但共用「Key」这一套凭据：

| 用途 | 凭据 | 方式 |
|---|---|---|
| 索引 / 检索客户端（插件、review-service） | API Key（`role=index`，可建多把） | `Authorization: Bearer <key>` |
| 控制台 | 管理员密码登录（会话 Cookie）/ HTTP Basic / `role=admin` 的 Key | 登录页 → HttpOnly Cookie（12h） |
| 兼容旧部署 | 环境变量 `API_KEY`（legacy，`id=0`，admin 角色，只读不可删） | `Authorization: Bearer <API_KEY>` |

- 控制台打开 `https://<host>/admin`：未登录显示登录页（不再弹浏览器 Basic 框）；登录后进入控制台，
  右上角「退出」清 Cookie。
- **Key 管理**：控制台「API Key」页新建/禁用/删除、按名称/前缀筛选。明文只在创建时显示一次；
  服务端只存 `sha256(key)`，列表只显示前 6 位。
  - **页面新建固定为 `index` 角色**（可调索引/检索全部接口：`sync`/`chunks`/`vectors`/`search`/`repos/.../status`/`scopes` 等，不能进后台管理）；
  - `admin` 角色仅保留给环境变量 legacy `API_KEY`（`id=0`）和既有 Key，页面不再提供该选项；
    后端 `POST /v1/admin/keys` 仍兼容 `role=admin`（给脚本/自动化用，普通用户不需要）。
  新建后可直接点「测试访问索引服务」验证（会分别测 `/v1/status` 与 `/v1/admin/session`，前者 200、后者对 index Key 为 401）。
- **强制策略**：只要存在任一 Key（env `API_KEY` 或控制台创建），所有索引/检索接口都必须带 Bearer；
  一个都没有时为开放模式（仅建议隔离内网），控制台顶部会红字提示。
- 免鉴权只剩 `GET /health`（无人认领时只返回 `ready/tag/providers/...`，不含 `spaces`/`limits`）。
- 首次部署没有管理员密码时，控制台「概览」会显示初始化表单（`POST /admin/setup`，密码 ≥8 位，
  pbkdf2 存 `/data/admin.db`）；也可以继续用环境变量 `ADMIN_PASSWORD`。
- 创建 Key 前必须已有管理员凭据（密码 / env `API_KEY` / admin Key），避免"建了 Key 却进不了后台"。

### 控制台能做什么

- **概览**：运行时 / 治理 / 存储限额 / 向量标签 / 鉴权状态；暂停/恢复嵌入、立即清扫、清理旧 tag。
- **模型**：当前嵌入/重排、已安装模型（本机 `/models` 与 `/data/models` 自动发现）、一键**热切换**、
  可下载模型（进度/取消/重试/重传）、重排启用/关闭。
- **API Key**：新建（固定 index 角色）、启用/禁用、删除、一次性明文展示、一键测试访问索引服务。
- **统计**：今日 / 近 7 天 / 近 30 天；8 个 KPI（请求、错误率、平均延迟、P95、embed/search/rerank、活跃 Key，带环比）；
  每日请求/错误柱状图、每日延迟趋势、请求构成；按端点与按 Key 明细（占比条、错误率、每 Key 平均延迟、最后使用）；
  运行状态卡（模型、限速、作用域覆盖率、**嵌入积压**）；自动刷新与 CSV 导出。
  延迟分位为桶上界近似（`usage_latency` 表按天累加，最多保留 90 天，即"≤X ms"）。
- **作用域**：快照表（块/向量/覆盖率/占用/TTL/命名空间）+ 检索测试。
- **日志**：服务日志尾部。

### 模型下载与热切换（无需重启）

下载：控制台「模型」页或 `POST /v1/admin/models/{name}/download`。预置 `bge-base-zh` /
`bge-reranker-base` / `jina-v2-base-code`，多源（ModelScope 优先、HF 回退）、逐文件 sha256 校验，
支持取消、失败重试、**强制重传**、断点续传；文件落在 `/data/models/`（`/data` 卷，重启不丢）。

切换：下载完成后，在「已安装模型」里点 **切换为嵌入 / 启用重排**（或
`POST /v1/admin/models/activate {kind, dir}`）。服务端会：

1. `governor.pause()` + `wait_idle()` 排空当前嵌入批次；
2. 加载新 ONNX 会话（失败自动保留原模型，返回 400/500）；
3. 交换全局 embedder / governor / `/health` 的模型信息（`tag` 立即变化）；
4. `repos.tag` 批量改为新 tag + kNN 缓存失效；
5. 恢复 governor 原状态。

> 切换后旧 tag 的向量仍在库里（可点「清理旧 tag」回收），但**立即检索不到**：插件下次
> `GET /` 看到新 tag 会按新 tag 全量重嵌（覆盖率从 0 恢复）。控制台切换前会弹确认，
> 切换后会显示"等待客户端重嵌"提示。
>
> 每个模型自带 profile（query 前缀 / 池化 / SEP / PAD），bge 与 jina 自动使用各自参数；
> 自定义目录名不在内置 profile 里时沿用环境变量默认（`QUERY_PREFIX` 等）。
> 目录白名单由 `MODEL_ROOTS`（默认 `/models,/data/models`）与 `MODEL_EXTRA_DIRS` 控制。

### 清空索引并重建

控制台「作用域」页底部有危险操作：输入 `RESET` 后点「清空所有作用域」（或
`POST /v1/admin/reset-index {"confirm":"RESET"}`）。行为：

1. 暂停嵌入并等当前批次结束；
2. `DELETE` 掉 `chunks / vectors / blobs / repos / lineages`（**API Key、调用统计、模型设置保留**）；
3. `VACUUM` + `PRAGMA wal_checkpoint(TRUNCATE)` 回收空间（实测 1.5 GB → 60 KB）；
4. 清 kNN 缓存、恢复 governor。

清空后检索暂时为空，客户端（插件 / review-service）下次同步会自动全量重建；若想立刻补回，
可让本机插件重新跑一次 `code_index`。重建时服务端按 `EMBED_RATE` 后台嵌入，可临时
`POST /v1/admin/rate {rate:40}` 加速，完成后记得调回。

### 换模型后还是同一个数据库吗？

是，还是同一个 `/data/index.db`。但向量的主键是 `(lineage_id, tag, hash)`：

- `tag` = 模型指纹（如 `bge-base-zh-v1.5-c4fa1e57-fp16`）。换模型/换精度 → tag 变；
- 服务端同步时把 `repos.tag` 更新成新 tag，kNN 矩阵按 `(namespace, tag)` 构建，**新旧向量不会混用**；
- 新 tag 的向量会重新嵌入（按内容哈希，只有正文变了的块才要新算）；**旧 tag 的向量仍留在库里占空间**，
  因为正文块还被引用，普通 GC 不会删它们；
- 需要回收就点后台「清理非当前 tag 的向量」，或 `POST /v1/admin/purge-tags`（不带参数 = 删所有非当前 tag）；
- `/health` 的 `tags` 字段会列出每个 tag 的 `vectors/bytes`，迁移前可以先看一眼占用。

**`sync` 的三个分支**：`repoState` 与库中一致 → 直接 `unchanged`（1 个 RTT、0 字节正文）；
`mode:'diff'` 且 `revision` 不是服务端当前值 → `409 {needFull:true}`（客户端改发全量自愈）；
`chunkFp` 不同 → `400`（切块配置不同的客户端不能混写同一命名空间）。
带 `scope` 时**服务端返回的 `namespace` 为准**（客户端后续 chunks/embed/status 都用它）。

> ⚠️ namespace 里的路径参数要做 percent-encode（canonical namespace 含 `#`、`@`、`:`）：
> `DELETE /v1/scopes/{encodeURIComponent(ns)}`、`GET /v1/repos/{encodeURIComponent(ns)}/status`。

## 档 3：快照作用域（scope）与多作用域检索

`main / branch / pr / worktree` 各用独立 namespace（快照），**内容层仍全库共享**：
`blobs`/`vectors` 按 `(lineage, tag, 内容哈希)` 存，跨快照 0 重嵌；只有 `chunks`/`repos` 按 namespace 隔离。

namespace 规范（`index_store.canonical_namespace()`，与 `scope_format.json` 夹具一致）：

```
"{repoId}@{chunkFp}#{kind}:{refToken}"
main → default ; branch → safe(ref)-sha1(ref)[:6] ; pr → int(ref) ; worktree → sha1(ref)[:8]
legacy（不含 #）原样保留，scope_kind='legacy'、pinned=1、expires_at=null
```

### TTL 与 janitor

| scope kind | 默认 TTL | 环境变量 |
|---|---|---|
| `main` / `legacy` | 永久（`expires_at=null`） | — |
| `branch` | 30 天 | `SCOPE_TTL_BRANCH` |
| `pr` | 14 天 | `SCOPE_TTL_PR` |
| `worktree` | 1 天 | `SCOPE_TTL_WORKTREE` |

`build()` 启动 daemon janitor：启动后延迟 30 s 先扫一次（避开 warmup），此后每 `SCOPE_SWEEP_INTERVAL`（默认 3600 s）扫一次；
`SCOPE_SWEEP=0` 关闭。每次只删 `pinned=0 and expires_at is not null and expires_at <= now` 的 scope，
删完 `knn.invalidate(ns)` 并对受影响 lineage 跑 `gc(lineage, RETENTION_DAYS)` ——
**仍被其他 scope 引用的 blob/vector 不会被误删**（gc 按"血统内是否还有 chunks 引用"判定）。
`pinned=1` 的 scope 永不被 janitor 删（legacy 迁移行默认 pinned）。

### 多作用域检索（`/v1/search`）

1. 查询向量只 embed 一次；
2. 每个 ns 取 `topk(max(k, rerank_candidates) * 2)`；未知 ns 记进 `byScope[].error` 跳过；
3. 合并：key=hash，同 hash 只保留一条（`score` 取最高、来源保留首个 ns），
   `rrf = Σ weight/(20 + rank)`（k=20、rank 从 1 起、weight 默认 1）；
4. 按 rrf 降序取 k；启用重排时对候选按 hash 取正文重排一次，附 `rerankScore`；
5. 命中项带 `namespace` / `scope{kind,ref}`；`byScope[]` 给每个作用域自己的 hits/coverage/ms。

只传 `namespace` 的旧请求等价于单元素 `namespaces`（走同一实现，旧字段全部保留）；
`namespaces` 长度 > `MAX_SEARCH_SCOPES`（默认 4）→ `400 {error:'too-many-namespaces'}`。
新建 scope 数超过 `MAX_SCOPES`（默认 200）→ `507 {error:'scope-cap', count, limit}`。

### 升级 / 回滚

- **升级零手工步骤**：`IndexStore.__init__` 对旧 `repos` 表做幂等 `alter table` 补 7 列 + 建 `repos_scope` 索引；
  老行回填 `scope_kind='legacy'`、`pinned=1`、`expires_at=null`、`created_at=updated_at`。
  二次启动不会再把管理员显式 unpin 的 legacy 行重新钉住。
- **回滚**：换回旧镜像/旧插件即可 —— 多出的列旧代码不读不写；旧 DB 删列需要手工（SQLite 不支持 drop column 的旧版本，
  一般没必要回滚数据结构）。
- 老客户端（0.10.1）继续只传 `namespace`：同步/检索/状态行为不变；janitor 只碰带 `expires_at` 的 scope，不会动 legacy 行。

## 热路径上别做聚合查询（实测踩坑）

`coverage` 需要"有向量的块 / 总块数"，最直接的写法是 JOIN 计数 —— 在 16 万块上实测 **401 ms**，
而它是 **每次 `/v1/search` 都要返回**的字段。同理 `sum(length(...))` 算占用要 **0.5 s**，
`/health` 与 `/status` 都会碰到。修法是给 `counts()` / `lineage_bytes()` 加**变更失效**的缓存
（sync / put_chunks / put_vectors / gc / adopt 之后清空）：

| | 修前 | 修后 |
|---|---|---|
| `/v1/search` 端到端（16 万块） | 485–533 ms | **29–46 ms**（冷启首查 2.4 s 建矩阵） |
| `/health` | 1151 ms | 首次之后 O(1) |

## kNN：为什么用精确解、不用二值量化（实测对照）

`bench_knn_modes.py` 在同一份 16 万块向量、同一批 40 条查询上对照（查询用服务自己的 `/embed` 编码）：

| 方案 | 常驻内存 | p50 | R@10 | R@40 |
|---|---|---|---|---|
| **① 精确（fp32 全量比对）** | 470 MB | **14.3 ms** | **100%** | **100%** |
| ② 二值（仅中心化）纯粗筛 | 15 MB | 9.5 ms | 22.0% | 26.1% |
| ② + fp32 重排 top-200 | 15 MB | 9.5 ms | 71.2% | 54.9% |
| ② + fp32 重排 top-1000 | 15 MB | 10.0 ms | 89.2% | 82.1% |
| ③ 二值（中心化 + 随机旋转）纯粗筛 | 15 MB | 10.4 ms | 24.2% | 26.7% |
| ③ + fp32 重排 top-200 | 15 MB | 10.5 ms | 76.5% | 57.0% |
| ③ + fp32 重排 top-1000 | 15 MB | 11.0 ms | 92.0% | 83.2% |

结论：**不划算**。内存省 32×，但 1 bit/维对 bge-base（768 维、强各向异性）损失太大 ——
即使重排到 top-1000 也只有 92% 的 R@10，而延迟只从 14.3 ms 降到 11.0 ms（省 23%）。
**在 16 万块这个量级，精确解又快又准，没有替代动机。**

两个实现教训（脚本注释里也写了）：
- **必须中心化 + 随机旋转**再做符号位：直接取符号 → 几乎每位相同、Hamming 退化成常数
  （不处理时 R@10 只有 22%）；`np.bitwise_count`（numpy≥2.0）比查表 popcount 快 2 倍以上。
- 真要上 ANN（单命名空间 >40 万块），应该用 **faiss HNSW / IVF-Flat** 而不是二值量化，
  并且同样要拿题库量 R@10 再上线 —— 这里的数据说明"省内存"和"保召回"不能两头都要。

## 初始化：别把 GPU 打满

实测瓶颈是 **GPU 而不是网络**（1000 块：服务端计算 35–39 s，网络 0.7 s）。所以限流在嵌入侧：

| 手段 | 默认 | 说明 |
|---|---|---|
| `EMBED_RATE` | **10 块/s**（P4 峰值 37%） | 16 万块 ≈ 4.5 h；`POST /v1/admin/rate {rate: 26}` 可打满 |
| `POST /v1/admin/pause` | — | 立即让出 GPU，进度保留 |
| 优先级 | `spread`（按 hash） | 先嵌的块在全仓均匀分布 → 部分索引立刻可检索 |
| 覆盖率 | `/status.coverage` | 查询结果里也会带上；初始化期间 BM25 照常可用 |

## 部署（容器，**开箱即用**）

镜像自带嵌入模型 `bge-base-zh-v1.5`（fp16），**不需要预先准备任何模型文件**：

```bash
docker run -d --name dsh-embed -p 127.0.0.1:18000:8000 \
  -v dsh-embed-data:/data ghcr.io/leganck/dsh-embed:latest-cpu
curl -s http://127.0.0.1:18000/health | head -c 300      # ready=true 即可用
```

第一次拉取约 **267 MB**（压缩层），之后升级只增量拉模型/代码层。

### 镜像变体（体积都是实测）

| 标签 | 内容 | 拉取（压缩） | docker 显示（未压缩） | 什么时候用 |
|---|---|---|---|---|
| `latest-cpu` | cpu 底座 + 嵌入模型 | **≈267 MB** | 485 MB | **默认推荐**：查询为主、局域网、没显卡 |
| `latest-gpu` | gpu 底座 + 嵌入模型 | ≈1.7 GB | 3.06 GB | 大规模建库、高并发 |
| `latest-cpu-rerank` / `latest-gpu-rerank` | + 重排模型 | ≈759 MB / ≈2.0 GB | 1.06 / 3.63 GB | **deprecated**：重排改为挂载 `model-rerank`（保留 1 个版本周期） |
| `base-cpu` / `base-gpu` | 只有运行时（无模型） | ≈0.09 / 1.5 GB | 281 MB / 2.86 GB | **推荐**：配合模型挂载（jina / 重排 / 自定义） |

> 标签策略见 [`docs/image-matrix.md`](docs/image-matrix.md)：模型（bge / jina / 重排）**不进镜像矩阵**，
> 统一用 Release 资产 + 挂载；`sha-*` 与 `jina-*` 别名已停止发布（旧标签冻结、仍可拉取）。

> 为什么默认不带重排模型：服务端 `rerank` 默认就是 `off`，缺模型时 `/health` 报
> `rerank_ready=false`、客户端**自动回退本机重排**。需要远端重排再拉 `-rerank` 变体即可。
> 体积怎么压下来的、为什么不量化：见仓库根 README 的「镜像体积」一节。

### 三种用法

1. **直接拉 GHCR（推荐）**：上面那段 `docker run`。
2. **compose**（cpu）：`cp .env.example .env && docker compose up -d`；
   有 NVIDIA 卡就叠加覆盖层：`docker compose -f compose.yaml -f compose.gpu.yaml up -d`。
3. **模型挂载**（推荐：同一个镜像，换模型不重新构建）：

   ```bash
   node scripts/fetch-models.mjs                  # → models/model、models/model-rerank（bge + 重排）
   node scripts/fetch-jina-model.mjs              # → models/model-jina（jina，可选）

   # bge + 重排（都从宿主机挂载）
   IMAGE=ghcr.io/leganck/dsh-embed:base-gpu \
     docker compose -f compose.yaml -f compose.gpu.yaml -f compose.models.yaml up -d

   # jina（同一镜像，只换挂载与几个环境变量）
   IMAGE=ghcr.io/leganck/dsh-embed:base-gpu \
     docker compose -f compose.yaml -f compose.gpu.yaml -f compose.jina.yaml up -d
   ```

4. **自建**（改代码 / 想自己出镜像）：

   ```bash
   node scripts/fetch-models.mjs                 # → models/model、models/model-rerank
   docker compose -f compose.build.yaml up -d --build
   # 只出"不含模型"的小镜像：
   MODEL_TARGET=nomodel docker compose -f compose.build.yaml up -d --build
   # 离线/内网需要"模型内置"镜像时（embed-jina 仅保留给离线场景，不再发布到 GHCR）：
   MODEL_TARGET=embed-jina docker compose -f compose.build.yaml up -d --build
   ```

### GPU 的前置与降级行为

- 宿主机需要 `nvidia-container-toolkit`（`docker run --gpus all nvidia/cuda nvidia-smi` 能跑）；
  compose 里用 `deploy.resources.reservations.devices`（fnOS 的容器 API 没有 GPU 开关，只能走这个）。
- 入口脚本先看**设备**（`/dev/nvidia0`）再看**库**（`libcublasLt.so.12` / `libcudnn.so.9`）：
  - 没有设备 → 打印"没做 GPU 设备预留"并**退回 CPU**（ORT 1.19.2 缺设备时直接调 CUDA 会段错误，实测踩到过）；
  - 设备有但库缺 → 同样退回 CPU 并点名缺哪个；
  - 两者都有 → `/health.providers` 显示 `CUDAExecutionProvider`。

### 反向代理

服务只绑 `127.0.0.1`，对外用反代。Traefik 示例（放 `compose.override.yaml`）：

```yaml
services:
  dsh-embed:
    networks: [gateway]
    labels:
      - traefik.enable=true
      - traefik.http.routers.dsh-embed.rule=Host(`dsh-embed.example.com`)
      - traefik.http.services.dsh-embed.loadbalancer.server.port=8000
networks:
  gateway: { external: true }
```

### 数据、备份与升级

- 索引库与日志都在 **`/data` 卷**（`index.db` + `server.log`）。升级镜像只换 tag，索引不动。
- 备份：`docker compose stop` 后
  `docker run --rm -v dsh-embed-data:/data -v "$PWD:/backup" busybox tar czf /backup/index.tgz -C /data .`
- 卷属主必须是 uid **10001**（容器非 root）。老数据卷若是 root：
  `docker run --rm -v dsh-embed-data:/data busybox chown -R 10001:10001 /data`

### 模型与许可

- 嵌入 `Xenova/bge-base-zh-v1.5`（fp16，194 MB）、重排 `Xenova/bge-reranker-base`（fp16，531 MB），
  均 **MIT**；镜像内 `/models/LICENSE.md` 记录来源、下载时间与每个文件的 sha256。
- **目录名必须是 `model` / `model-rerank`**：`embedder.py` 用 `basename(model_dir)=='model'` 推导模型名，
  拼出的向量标签会跟着变 —— 变了客户端就认为"模型换了" → 全量重嵌。
  实测本镜像的 tag 与现网一致：`bge-base-zh-v1.5-c4fa1e57-fp16`。
- **代码检索变体**：`embed-jina` target 用 `jina-embeddings-v2-base-code`（Apache-2.0，768 维，8k 上下文）。
  模型不进 git：由 `scripts/fetch-jina-model.mjs` 从 GitHub Release 下载并做 sha256 校验；
  来源、修改说明（ONNX 导出 + mean pooling 烘焙 + fp16）与实测数据见 [docs/jina-v2.md](docs/jina-v2.md)。

### 排错

| 现象 | 原因 / 处置 |
|---|---|
| gpu 镜像的 `/health.providers` 只有 CPU | 没做设备预留或宿主机缺 nvidia-container-toolkit；看 `docker logs` 里的 `[entrypoint]` 告警 |
| 容器起不来，exit 78 | 缺嵌入模型（用了 `nomodel` 却没挂载）或 `/data` 不可写；入口脚本会打印具体修复命令 |
| `/health` 里 `ready=false` | 模型加载失败，`err` 字段有原因（多半是模型文件不全） |
| `rerank_ready=false` | **正常**：这是 embed 变体。要远端重排就用 `-rerank` 变体 |
| 写入返回 507 | 存储上界（`MAX_TOTAL_GB`，默认 20） |
| 拉镜像慢 | 换 `latest-cpu`（267 MB），或用 `base-*` + 挂载模型 |

### 发布镜像

```bash
git tag server-v0.1.0 && git push origin server-v0.1.0   # 触发 .github/workflows/publish-image.yml
```

流水线：先构建并推 `base-{cpu,gpu}`（层复用）→ 再叠模型出 4 个变体 → **每个变体先在容器里跑
`selftest.py` 与"模型文件在位"检查，通过才推**。首次发布后要在 GitHub → Packages 把
`dsh-embed` 设为 **public**（否则拉取需要 `docker login ghcr.io`）。

### 附录：非容器历史路径

`deploy/legacy/start.sh` + `deploy/legacy/compose.legacy.yaml` 是容器化之前的做法
（`python:3.11-slim` + 启动时 pip 装依赖 + 手工拷 `cuda12/` 的 28 个 `.so`）。
现在只作参考保留：它的 CUDA 版本约束（ORT 1.19.2 + CUDA 12.4 + cuDNN 9.1，Pascal 才跑得起来）
已经搬进 `Dockerfile` 的 pip wheel 里。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MODEL_DIR` / `MODEL_NAME` | `/app/model` / 目录名推断 | 启动时嵌入模型；控制台热切换后以切换结果为准（不重启），`MODEL_NAME` 参与 tag 计算 |
| `MODELS_DIR` | `/data/models` | 后台「模型下载」的落盘根目录（在 `/data` 卷内，重启不丢） |
| `MODEL_CATALOG` | 空 | 可选 JSON：扩展/覆盖预置模型目录（字段见 `model_downloader.DEFAULT_CATALOG`） |
| `MODEL_ROOTS` / `MODEL_EXTRA_DIRS` | `/models,/data/models` / 空 | 模型热切换的目录白名单（`/models` 镜像内置，`/data/models` 下载目录） |
| `SERVER_ADMIN_DB` | `/data/admin.db` | Key / 调用统计 / 管理员密码 / 会话的独立库（不碰 1.6 GB 的 index.db） |
| `SESSION_TTL` | `43200` | 控制台登录会话有效期（秒，默认 12 小时） |
| `RERANK_MODEL_DIR` | `/app/model-rerank` | 重排模型；缺文件 → `rerank_ready=false`（客户端直接回退本机） |
| `SERVER_DB` | `<app>/out/index.db` | 索引库 |
| `EMBED_RATE` / `EMBED_BATCH` | `10` / `8` | 后台嵌入限流与批大小 |
| `RERANK_BATCH` / `RERANK_MAX_TOKENS` | `8` / `256` | 重排批与截断 |
| `KNN_MAX_BYTES` | `2 GiB` | 内存矩阵 LRU 上限 |
| `MAX_VECTORS_PER_LINEAGE` / `MAX_TOTAL_GB` | `500000` / `20` | 存储上界（超限 507） |
| `RETENTION_DAYS` | `30` | 无人引用的 blob/vector 保留期（scope 删除/过期后的 GC 也用它） |
| `SCOPE_TTL_BRANCH` / `SCOPE_TTL_PR` / `SCOPE_TTL_WORKTREE` | `30` / `14` / `1` | 快照 TTL（天）；`main`/`legacy` 永久 |
| `SCOPE_SWEEP` / `SCOPE_SWEEP_INTERVAL` | `1` / `3600` | janitor 开关与周期（秒）；`SCOPE_SWEEP=0` 关闭 |
| `MAX_SCOPES` | `200` | 全新 scope 配额，超限 507 |
| `MAX_SEARCH_SCOPES` | `4` | 单次检索最多作用域数，超限 400 |
| `WARMUP` | `1` | 启动后台预热（嵌入会话、重排内核、最大命名空间的 kNN 矩阵与计数）：把"重启后第一个查询"从 2.4 s 降到 **25 ms**；`0` 关闭 |
| `ORT_THREADS` / `ORT_PROVIDERS` | `6` / `CUDA,CPU` | 执行提供者 |
| `API_KEY` | 空 | **legacy** Bearer key（admin 角色，id=0，不可在控制台删除）；新部署建议用控制台「API Key」页建 Key（插件 `remote.apiKey`） |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / 空 | 控制台登录与 HTTP Basic 凭据；为空时首次打开控制台可初始化管理员密码（存 `/data/admin.db`） |
| `FAKE_EMBED` | 空 | `1` = 不加载模型（自测用） |
| `HOST_PORT` | `18000` | **compose 专用**：宿主机端口（只绑 127.0.0.1） |
| `FLAVOR` | `cpu` | **构建参数**：`cpu` / `gpu`（gpu 装 CUDA 12 的 cublas/cudnn/curand/cufft） |
| `MODEL_TARGET` | `embed` | **构建参数**：`nomodel` / `embed` / `embed-rerank` |
| `VERSION` | `dev` | **构建参数**：写进 OCI label 的版本号 |

## 自测

```bash
python selftest.py     # 81 项：同步/未变更/缺向量/幂等/嵌入/kNN/增量/GC/409/400/血统隔离/adopt/上限/暂停/gzip
                       # + 档 3：namespace 夹具、scope 注册/resolve/列表、legacy pinned 不被 sweep、
                       #   TTL 过期删除、DELETE 后 GC 不误删共享内容、多 scope 去重/来源/权重/等价、配额 507、旧 DB 迁移

# 容器里跑（不需要模型，发布门禁就是这条）
docker run --rm -e FAKE_EMBED=1 ghcr.io/leganck/dsh-embed:latest-cpu python /app/selftest.py
```

> 发布门禁注意：`selftest.py` 会读同目录的 `scope_format.json`（namespace 规范夹具）。
> **Dockerfile 的 `COPY server.py index_store.py …` 那行必须把它一起拷进 /app**，否则自测 [15] 会显式失败
> （这是刻意的：夹具没进镜像 = 两端规范可能漂移）。

## 安全

- 默认按"局域网 / 内网可信"设计。生产建议 `API_KEY`（索引）与 `ADMIN_USER`/`ADMIN_PASSWORD`（后台）都配。
- 暴露到公网请在 Traefik/Nginx 上再加一层认证或 IP 白名单，不要只靠服务自身的凭据。
- 服务端**存源码正文**（`blobs`），这是 rerank 与片段返回的前提；请把它当成代码仓库同等敏感。
