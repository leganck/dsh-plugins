# 血统与作用域（v2）

> 版本：2026-11-20 起为 **schema v2**。不兼容 v1 数据：旧库启动直接拒绝，
> 处理方式见 `docs/schema-v2.md §5`（重置重建，向量清空重算）。
> 本文只描述 v2 的合并/去重语义；表结构以此文引用的 DDL 为准。

## 0. 三个概念

```text
lineage   仓库血统：一个来源仓库（按归一化 origin URL 或 root_hint 识别）
scope     作用域：一次具体视图 = kind(main|branch|pr|worktree) + ref + root_rel + chunk_fp
namespace 对外协议串：<repoId>@<chunkFp>#<kind>:<token>（客户端用它定位 scope，格式不变）
```

v1 里 namespace 同时承担"身份 + 定位 + 分桶"三重角色；v2 把它降级为**对外别名**，
真实主键是 `scopes.id`（整数），所以不再需要靠字符串拼装做 JOIN。

## 1. 内容寻址：合并与去重为什么变简单了

| 数据 | v1 | v2 |
|---|---|---|
| 块正文 `blobs` | `(lineage_id, hash)` 主键 → 同内容按血统重复存 | `hash` 主键，**全局一份** |
| 块向量 `vectors` | 成员表 + `vectors_v2` 双表 | `(tag, hash)` 主键，**全局一份** |
| 块清单 `chunks` | `(namespace, path, start)`，另存 lineage_id | `(scope_id, path, start_line)`，只存清单 |

推论：**合并血统不搬运也不删除任何正文/向量**——它们本来就按内容唯一，
血统只决定"哪些 scope 存在、这些 scope 有哪些块"。

## 2. 合并血统（`POST /v1/admin/lineages/merge`）

```json
{ "from": ["<repoId|lineageId|namespace>", "..."], "into": "<目标>" }
```

语义（单事务 `BEGIN IMMEDIATE`）：

```text
① resolve：repoId / lineageId / namespace 三种写法都能解析（一个 repoId 可能裂成多个血统）
② 逐个源血统：把它的 scopes 改挂到目标血统（scope 的 namespace 不变，客户端无需重新同步）
③ 若源血统已无 scope → 物理删除 lineages 行（v2 不留墓碑）
④ 若某个源 scope 与目标血统下已有 scope 身份相同（lineage+kind+ref+root+chunk_fp）
   → 折叠：目标侧 (path,start_line) 优先，源侧重复块丢弃，计入 droppedChunks
```

返回：`{merged, from, into, droppedChunks, droppedVectors, droppedBlobs, freedBytes, droppedScopes}`

- v2 下 `droppedVectors` / `droppedBlobs` **恒为 0**（内容全局唯一，合并不涉及它们）；
  字段保留是为了响应契约稳定
- `droppedScopes` 是 v2 新增：被折叠掉的作用域数

## 3. 空血统清理（`POST /v1/admin/lineages/hard-clean`）

v1 里这个端点是"观察期到期后物理删除墓碑血统"；**v2 没有墓碑，语义变为：
删除没有任何 scope 的空血统**（合并后的残留、客户端换 URL 后的孤儿）。

```json
{ "minAgeDays": 7 }   // 只清理创建超过 N 天的空血统，默认 7
```

## 4. 重复检测（`GET /v1/admin/lineages/duplicates`）

按 `lineages.repo_name` 分组，组内 ≥2 个血统即为重复组；再按 `scopes.chunk_fp` 聚类：

- `same_chunk_fp = true` → 同一批内容裂成多个血统，合并收益最大（可直接合）
- `same_chunk_fp = false` → 同仓库名但内容不同（不同分支线/不同切块策略），**合并前需人工确认**

`suggest` = scope 数最多的血统（并列取 `last_seen` 更新者）。

## 5. 为什么还会裂血统（防范）

血统 id 默认 = `sha1(归一化 origin URL)`；无 remote 时退化为 `root_hint`（目录名 + 首个 commit）。
以下情况仍会产生新血统：

```text
· 同一仓库在无 remote 的 worktree/副本里索引（root_hint 不同）
· origin URL 写法变化（https ↔ ssh、带不带 .git，归一化已覆盖大部分）
· 真的两份不同内容的克隆
```

处理：用 duplicates 端点发现 → merge 合并到主血统 → 之后该 URL 的索引都落在同一血统下。
**不要靠改 repoId 强行对齐**（客户端 repoId 由 URL 推导，改配置易与真实来源不一致）。
