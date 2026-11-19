# 作用域永久化与分页（0.15.0）

状态：已实现。关联版本：服务端 `server-v0.15.0`、插件 `code-index-v0.15.0`、review-service `0.2.0`。

## 目标

删除作用域生命周期和硬上限，改为显式管理；作用域列表支持分页/搜索/筛选/排序和批量删除。

## 行为变化

- 删除 `MAX_SCOPES=200`，不再返回 `507 scope-cap`。
- 删除 scope TTL（branch 30 天 / PR 14 天 / worktree 1 天）、janitor 自动删除和 pin。
- 删除 `RETENTION_DAYS` 宽限期；显式删除作用域后立即回收无引用的 blob/vector，共享内容仍保留。
- 所有 kind（main/branch/pr/worktree/legacy）永久保留，只能手动删除。
- 数据库历史列 `ttl_days` / `expires_at` / `pinned` 保留但不读写，避免破坏性迁移。

## API

```text
GET  /v1/scopes?limit=50&offset=0&q=&repoId=&kind=&sort=updated_at&order=desc
     -> {scopes, total, offset, limit, hasMore, facets}

POST /v1/scopes/bulk-delete
     {namespaces:[...]} -> {deleted, failed, lineages, chunks}

DELETE /v1/scopes/{ns}
```

`scopes[]` 新增：`files`（文件数）、`updatedAt`（最近同步）、`variantCount`（同 repo/kind/ref 的索引指纹数量）。

`/health` 增加全库聚合：

```json
"scopes": {"total": 250, "chunks": 12345, "vectors": 12000, "coverage": 0.97, "totalBytes": 123}
```

控制台概览/统计不再从最多 50/200 条记录求和。

## 控制台

- 作用域表：仓库优先，列包含块 / 文件、向量、覆盖率、占用、最近同步、命名空间、操作。
- 分页（25/50/100）、服务端搜索、仓库/类型筛选、排序。
- 行内“用于检索 / 删除”；当前页勾选批量删除。
- 删除后立即回收孤儿内容；当前页为空时自动回退到最后一页。
- 概览页只请求 `/health`；作用域页单独请求当前页 `/v1/scopes`。

## 验证

- 服务端 selftest：246 通过 / 0 失败
- 插件测试：83 通过 / 0 失败
- review-service：146 / 8 / 13 通过
- 本地 60 条作用域页面：分页、筛选、选中、用于检索均验证通过
- 部署：50.112 CPU、生产 GPU `server-v0.15.0`（随发布）
