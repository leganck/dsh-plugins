> 历史文档：0.15.0 起作用域永久保留，已移除 scope TTL、janitor 自动删除、pin 和 MAX_SCOPES 配额；
> 下文涉及 TTL/pin/配额/过期删除的段落仅为旧设计记录，以当前 README 为准。

# 档 3 实施契约：快照作用域 + 多作用域检索 + 生命周期

> 本文件是 `feat/scope-snapshots` 分支的**实现契约**（Lead 与各子系统共同遵守）。
> 所有 namespace 规则以 `server/code-index-service/scope_format.json` 夹具为准，JS/Python 两端都必须读它做断言。

## 1. 目标（成功标准）

1. `main / branch / pr / worktree` 各用独立 namespace（快照），写者互不覆盖。
2. 内容层不变：`blobs`/`vectors` 仍按 `(lineage, tag, 内容哈希)` 全库共享，跨快照 0 重嵌。
3. 一次查询可检索多个作用域，结果按 hash 去重并带来源（`namespace`/`scope`）。
4. scope 有 TTL：PR 关闭触发删除、janitor 周期清扫、内容按 retention GC，不误删仍被引用的内容。
5. 向后兼容：只传 `namespace` 的旧客户端行为不变；旧 DB 升级为 `legacy` 且 `pinned`。

## 2. namespace / scope 规范（硬契约）

```
canonical_namespace(repoId, chunkFp, kind, ref) =
  "{repoId}@{chunkFp}#{kind}:{refToken}"

kind ∈ {main, branch, pr, worktree}
refToken:
  main      -> "default"                     （ref 忽略）
  branch    -> safe(ref) + "-" + sha1(ref)[:6]
  pr        -> str(int(ref))                 （ref 必须是纯数字）
  worktree  -> sha1(ref)[:8]

safe(s) = 非 [A-Za-z0-9._-] 的连续字符压成 "-"，再去首尾 "-"；结果为空则用 "x"
校验：repoId / chunkFp 必须匹配 ^[A-Za-z0-9._-]+$，否则报错（invalid-repo-id / invalid-chunk-fp）
```

示例：`r1234@fp1#branch:feat-x-d6e256`、`r1234@fp1#pr:1234`、`r1234@fp1#main:default`、`r1234@fp1#wt:e4f91dd3`。
`legacy` 命名空间（不含 `#`）**原样保留**，不做规范化；迁移后 `scope_kind='legacy'`、`pinned=1`、`expires_at=null`。

夹具 `scope_format.json` 的 `cases` / `legacy_cases` / `invalid_cases` 必须两端全过。

## 3. 服务端数据模型（`index_store.py`）

`repos` 增列（幂等迁移，写法同现有 `repo_state_chunks`）：

```sql
scope_kind  text not null default 'legacy'   -- legacy|main|branch|pr|worktree
scope_ref   text                             -- main:default / branch 原名 / pr:<iid> / wt:<sha8>
commit_sha  text
ttl_days    integer                          -- null = 用默认
expires_at  integer                          -- null = 不回收
pinned      integer not null default 0
created_at  integer
create index if not exists repos_scope on repos(scope_kind, expires_at);
```

迁移规则：补列；`legacy` 行 `pinned=1`、`expires_at=null`；`created_at` 空则回填 `updated_at`。

新增方法（`IndexStore`）：

- `canonical_namespace(repo_id, chunk_fp, kind, ref)`（模块级函数也可，供测试直接 import）
- `register_scope(ns, kind, ref, commit_sha=None, ttl_days=None)`：写/更新元数据，`expires_at = now + (ttl_days ?? default_for(kind))`；kind=main/legacy 默认 `expires_at=null`
- `delete_scope(ns) -> {deleted, chunks}`：删 `chunks where namespace=?` + `repos where namespace=?`，`_invalidate()`；幂等
- `expired_scopes(now) -> [{namespace, lineage_id}]`
- `sweep_scopes(now) -> {deleted:[ns...], lineages:[...]}`：只删 `pinned=0 and expires_at is not null and expires_at <= now`
- `scope_overview()`：`overview()` 每项加 scope 字段与 `ttlRemaining`
- `count_scopes() -> int`
- `gc(lineage, retention_days)` 保持现有语义（无 chunks 引用 + 超过 retention）

默认 TTL（服务端环境变量）：`SCOPE_TTL_BRANCH=30`、`SCOPE_TTL_PR=14`、`SCOPE_TTL_WORKTREE=1`；`main`/`legacy` 永久。

## 4. 服务端 API（`server.py`）

### 4.1 新增

```
GET  /v1/scopes?repoId=&kind=
  -> {scopes:[{namespace, kind, ref, repoId, chunkFp, revision, chunks, vectors, coverage,
               createdAt, expiresAt, pinned}]}

POST /v1/scopes/resolve
  body {repoId, chunkFp, kind, ref, commit?}
  -> 200 {namespace, exists, revision?}
  -> 400 {error:'bad-scope', reason}   （kind/ref 非法）

POST /v1/scopes/{ns}/pin
  body {pinned: bool, ttlDays?: int|null}
  -> 200 {namespace, pinned, expiresAt}

DELETE /v1/scopes/{ns}
  -> 200 {deleted: true, chunks: n} / 200 {deleted: false}

POST /v1/admin/sweep
  -> 200 {deleted:[ns...], lineages:[...]}
```

### 4.2 扩展

- `POST /v1/namespaces/sync`：可选 `scope:{kind, ref, commit?, ttlDays?}`。新建 `repos` 行时 `register_scope`；已存在则只更新 `commit_sha`、`updated_at`，**不覆盖** `pinned/expires_at`（除非 `ttlDays` 显式给出）。创建新行前查 `count_scopes()`，超过 `MAX_SCOPES`（默认 200）返回 `507 {error:'scope-cap', count, limit}`。
- `POST /v1/search`：新增可选 `namespaces:[{namespace, weight?}]`；保留 `namespace` 字符串（等价于单元素）。`len(namespaces) > MAX_SEARCH_SCOPES`（默认 4）→ `400 {error:'too-many-namespaces'}`。
- `GET /v1/namespaces/{ns}/status`：响应增加 `scope:{kind, ref, commit, createdAt, expiresAt, pinned}`。
- `GET /health`：`spaces[]` 每项加 scope 字段；顶层加 `scopes:{total, byKind:{...}}`。

### 4.3 多作用域检索语义

`search(namespaces: list[ns], ...)`：

1. 查询向量只 embed 一次；
2. 每个 ns 取 `knn.get(ns, tag)` → `topk(max(k, rerank_candidates) * 2)`；未知 ns 记入 `byScope[].error` 并跳过；
3. 合并：key=hash；同一 hash 多条时保留最高 `score` 与首个来源 ns；
   `rrf = Σ weight/(20 + rank_i)`（k=20，weight 默认 1）；
4. 依 `rrf` 降序取 `k`；若启用 rerank，对候选按 hash 取正文（`store.bodies(lineage, hashes)`）重排一次，结果附 `rerankScore`；
5. 返回：

```json
{
  "hits": [{"hash":"..","path":"..","start":1,"end":9,"score":0.12,"namespace":"..","scope":{"kind":"branch","ref":"feat/x"}}],
  "ms": {"embed": 7.4, "knn": 6.2, "rerank": 0},
  "coverage": 0.97,
  "byScope": [{"namespace":"..","hits":40,"coverage":0.97,"ms":{...}}]
}
```

单 `namespace` 请求走同一实现（数组长度 1），结果必须与旧实现等价（旧字段全部保留，新字段只增）。

## 5. janitor / 生命周期

- `build()` 启动 daemon 线程：每 `SCOPE_SWEEP_INTERVAL`（默认 3600s）跑 `store.sweep_scopes(now)`；`SCOPE_SWEEP=0` 关闭；
- 每删一个 scope 后 `knn.invalidate(ns)`；对受影响 lineage 调 `store.gc(lineage, RETENTION_DAYS)`；
- 启动时先跑一次 sweep（延迟 30s，避开 warmup）；
- 所有删除写日志（`log()`），`/v1/admin/sweep` 返回同样结果。

## 6. 插件（`plugins/dsh-code-index/`，0.10.1 → 0.11.0）

配置面（仅新增可选键，旧配置不破坏）：

```yaml
remote:
  url: "http://192.168.50.112:18000"
  apiKey: null
  namespace: null            # 显式写作用域（优先）
  scope:                     # 未给 namespace 时按规范推导
    kind: branch             # main|branch|pr|worktree
    ref: "feat/x"
    ttlDays: 14              # 可选
  readScopes: []             # 额外读取的 namespace 列表（如主干）
```

- 新文件 `lib/scope.js`：`canonicalNamespace(repoId, chunkFp, kind, ref)`、`refToken`、校验；读 `scope_format.json` 的测试在 `test-remote.mjs` 里做；
- `namespaceFor()`：`remote.namespace` > 由 `remote.scope` 推导 > 旧默认 `repoId@fp`；
- `lib/indexer.js syncRemote()`：payload 增加 `scope`（有配置时）；以服务端返回的 `namespace` 为准（没有则用本地推导）；
- `lib/remote.js search()`：支持 `search(namespacesOrOne, ...)`；数组时发 `{namespaces:[{namespace},...]}`；`code_search` 传 `[写作用域, ...readScopes]`（去重）；
- 兼容：服务端返回 400/404 时回退单 namespace 重试一次（旧服务端）；
- 命中项若带 `namespace`，结果对象补 `scope` 字段；`code_index_status` 文本展示 scope/TTL；`code_search` 头部提示多作用域；
- 版本号、README（配置项 + 迁移说明）、`node build-release.mjs` 产物。

## 7. review-service（`server/review-service/`）

配置（`app/config.py`）：

```
INDEX_SCOPE_MODE = repo | branch | pr       默认 repo（行为不变）
INDEX_PR_HEAD    = 0                         pr 模式下是否把 MR head 建临时 scope
INDEX_PR_TTL_DAYS = 14                       （传给服务端 scope.ttlDays）
```

- `app/sync.py`：`sync_worktree(..., namespace=None, scope=None)`；发 `scope:{kind, ref, ttlDays}`；返回体里的 `namespace` 为准；
- `app/worker.py`：
  - `repo`：现状不变；
  - `branch`：base 工作树 → `kind=branch, ref=target_branch`；
  - `pr`：base → `branch:<target>`；若 `INDEX_PR_HEAD=1`，head 工作树 → `kind=pr, ref=<iid>`；
  - 检索调用传 `namespaces=[baseNs]` 或 `[baseNs, prNs]`；
- `app/clients.py` / `context.py` / `pipeline.py`：`namespace: str` → `namespaces: list[str]`（单值兼容），命中项带 `scope` 进 evidence；
- `app/server.py` webhook：接受 `action in ("merge","close")`，best-effort `DELETE /v1/scopes/{prNs}`（2s 超时，失败仅记日志），返回 200/202；
- `app/index_state.py`：`project_state` 加 `scope_json text`（记录 base/pr namespace），迁移用 `alter table` 幂等；
- 自测（`python -m app.selftest`）补 scope 用例。

## 8. 文件归属（write scope，禁止越界）

| 负责人 | 文件 |
|---|---|
| Lead | `server/code-index-service/scope_format.json`、`server/code-index-service/docs/scope-tier3.md`、发布/E2E |
| server-core | `server/code-index-service/{index_store.py,server.py,selftest.py,README.md}` |
| plugin-client | `plugins/dsh-code-index/{lib/scope.js,index.js,lib/remote.js,lib/indexer.js,test-remote.mjs,test.mjs,package.json,README.md}` |
| review-integration | `server/review-service/app/{config,sync,worker,clients,context,pipeline,server,index_state,selftest}.py`、`server/review-service/README.md` |

## 9. 测试命令（本机可跑）

```bash
# 服务端（本机已装 numpy）
cd server/code-index-service && python selftest.py            # 基线 43 → 目标 ~60+

# 插件
cd plugins/dsh-code-index && node test-remote.mjs && node test.mjs && node test-plugin.mjs

# review-service（本机有 fastapi）
cd server/review-service && python -m app.selftest            # 基线 85 → 目标 ~90+
```

## 10. 兼容与验收

兼容：旧客户端只传 `namespace` 照旧；旧服务端收到 `namespaces` 会 400/404，新客户端自动回退；旧 DB 升级零手工步骤；回滚只需换回旧镜像/旧插件。

验收：

- [ ] 夹具三组 cases 两端全过；`python selftest.py`、三个 node 测试、`python -m app.selftest` 全绿；
- [ ] 两分支交替索引互不覆盖；默认主作用域查询无分支内容；
- [ ] 合并后重建 main：`missing=0`、`coverage=100%`、0 重嵌；
- [ ] `DELETE scope` 后 `/health.spaces` 消失；GC 不误删仍被其他 scope 引用的内容；
- [ ] 旧插件 0.10.1 对新服务端无回归（同步/检索/状态）。
