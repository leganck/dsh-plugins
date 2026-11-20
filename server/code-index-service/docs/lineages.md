# lineages：向量 CAS 化、血统合并与一次性清洗

> T-261120-dedup 交付文档。背景：同一仓库因 repoId 推导裂缝（客户端读不到 origin 时回退
> 路径哈希派生 repoId）裂成多个 lineage，chunks/vectors 各存一份——实测 vectors 23730 行
> 里 2049 行纯冗余。本方案把向量存储改成内容寻址，并给出血统合并 / 重复检测 / 一次性
> 清洗的完整链路。设计依据：`docs/research-mature-solutions-and-mnemon.md` §三
> （CAS / alias 观察期 / pg-ripple 事务合并）。

## 1. 向量 CAS（vectors_v2）

### 1.1 表结构与主键取舍

```sql
create table vectors_v2 (
  tag        text not null,   -- embedding 模型指纹
  hash       text not null,   -- 块内容哈希
  dim        integer not null,
  v          blob   not null,
  updated_at integer not null,
  primary key (tag, hash)
);
```

**主键用 `(tag, hash)` 复合而不是 hash 单列**：tag 参与唯一性——同一内容哈希在不同
模型下是**不同向量**（维度、语义空间都不同），单列 hash 主键会让换模型期间的新向量把
旧向量挤掉（`insert or replace` 直接覆盖），热切换回退就没得退了。代价是按 hash 单列的
检索吃不到主键前缀——实际不存在这种查询路径：所有读写都带 tag（kNN 按当前模型 tag 查，
purge 按 tag 清）。任务描述里的 `vectors_v2(hash pk, tag, ...)` 单列写法在本库的实际
查询负载下是更差的选择，故按 `(tag, hash)` 落地。

### 1.2 旧 vectors 表去哪了（兼容读的关键）

迁移后**旧表保留**，但降级为「血统→(tag,hash) 成员表」：

- `v` 列清空——向量负载唯一份在 v2，旧表不再重复存字节（这正是去重的收益来源）；
- 行保留 `(lineage_id, tag, hash)` 成员关系——所有按血统的既有读路径
  （`_missing` / `counts` 覆盖率 / `adopt` 成员判断 / `gc` / `ensure_capacity`）
  **语义不变**，全套回归（selftest 274 / test_bodies 31）零改动通过。

kNN 查询路径（`IndexStore.matrix`）改为「namespace 的 chunks → hash 集 → v2」，
不再连血统；同内容跨血统直接共享同一份向量，不再重复嵌入、不再重复存储。

### 1.3 迁移（部署时显式执行 + 幂等）

**2026-11-20 授权：改造时历史数据可清理，不做运行时静默迁移。** 服务启动只认 v2：

- `IndexStore` 打开时做 **schema gate**：旧 schema（`vectors` 表带真负载且 meta 未记
  `vectors_schema=cas`）→ 直接 `RuntimeError`，提示先跑迁移脚本（`/health` 会把这条
  报错带出来）；空库/新库直接落 cas 标记。
- 一次性迁移由部署脚本显式执行：

  ```bash
  # 部署序：停写 → 迁移 → 起服务（幂等，可重复跑）
  python scripts/cleanup-lineages.py --db /data/index.db --migrate-cas --vacuum
  ```

  单事务 `BEGIN IMMEDIATE`：旧表 `(lineage,tag,hash)` 行按 `(tag,hash)` 去重搬进 v2
  （同键多血统重复行只留一份，`updated_at` 新者胜）→ 旧表 `v` 列清空 → meta 记
  `vectors_schema=cas`。`--vacuum` 顺带 VACUUM + checkpoint，把释放的页真正还给文件
  系统（不做时页进 freelist，逻辑占用已下降、文件体积暂不缩小）。

幂等：`meta` 已是 `cas` → 只做建表兜底，跑两次结果一致（`tests/test_lineages.py`
①层断言"第二次不再搬/不再清"）。程序入口：模块级 `index_store.cas_migrate_db(path)`
（脚本用），`IndexStore.cas_migrate()`（已开 store 上重跑，诊断/测试用）。

## 2. merge 契约

```
POST /v1/admin/lineages/merge     body: {"from": ["<repoId|lineageId|namespace>", ...],
                                          "into": "<repoId|lineageId|namespace>"}
→ 200 {"merged": [{"from","into","namespaces"} | {"from","skipped","into"}],
       "from": [...], "into": "<lineageId>",
       "droppedChunks": N, "droppedVectors": N, "droppedBlobs": N,
       "freedBytes": N, "freedMb": M,
       // snake_case 别名（同值）：dropped_chunks / dropped_vectors / dropped_blobs / freed_bytes
       }
→ 400 {"error": "bad-lineage", "detail": ...}   # from 空数组 / into 解析不到
```

- **鉴权**：admin（`_admin_ok()`：后台 Basic 或 admin Bearer），与其它 `/v1/admin/*` 一致；
- **解析**：`from`/`into` 每项依次尝试 lineages.id → repos.repo_id（一个 repoId 裂成的
  多个血统全算 from）→ repos.namespace；`into` 必须唯一解析成一个血统，否则 400；
- **事务**：单事务 `BEGIN IMMEDIATE`，任一步失败整体回滚；
- **from 含 into 自身 / 已合并过的血统**：自动跳过（幂等），不报错；
- 对每个源血统依次执行：
  1. **repos 行改挂靠**：`lineage_id` 改成目标（**namespace 不动**——旧 namespace
     继续有效，客户端照常同步/检索，只是血统归一）；
  2. **chunks 按 (lineage_id, hash) 去重**：源 namespace 里 hash 已在目标侧存在的行
     直接删（保留目标行的 path/start/end）；源独有的块保留；
  3. **blobs 归并**：目标缺的正文补上（insert-or-ignore），源血统行全删
     （同 hash 同内容纯冗余）；
  4. **vectors 旧成员表**：源血统成员行搬进目标后删除源行；**v2 不动**
     （全局内容寻址，本来就不带血统）；
  5. **merged_into 软标记**：`lineages.merged_into = 目标, merged_at = now`
     ——旧血统行不物理删，进观察期。
- `freedBytes` = 删除的 blob 正文字节 + 旧成员表 v 列字节（迁移后为 0）+ 删除 chunk 行
  的 path 字节；文件实际回收需 VACUUM（见上）。

### 2.1 merged_into：墓碑与重定向（非观察期）

**merge 即生效**：重复数据（chunks/blobs/成员表行）在 merge 事务里**当场物理删除**，
无需等待。`lineages.merged_into` 保留的唯一作用是**墓碑 + 重定向**：

1. **防复活**：旧客户端（读不到 origin、回退 repoId 派生）再 sync 时 `ensure_lineage`
   沿 `merged_into` 链（≤8 跳防环）回退到目标血统——不会把旧血统复活成新行；
2. **兼容读**：旧 namespace 自己的 chunks 被 merge 去重清空后，检索自动按血统回退
   （`matrix()`：namespace 自身 0 行且 repos 行 revision>0 → 按目标血统的块查）；
3. **可审计**：谁合进了谁、什么时候，`lineages` 表一行记录。

用户已确认历史数据可清理（2026-11-20），**没有强制的保留期**；需要安全网请先备份
`index.db`。墓碑行可以随时用可选的清理端点删掉：

```
POST /v1/admin/lineages/hard-clean   {minAgeDays?: 7, force?: false}
→ {"removed": ["<lineageId>", ...], "removedCount": N}
```

- 默认只删 `merged_at` 距今超过 `minAgeDays`（默认 7 天）的墓碑——这是给运维留的
  防手滑缓冲，不是数据保留期；`force=true` 立即删全部墓碑；
- merge 正常不产生残留数据行；hard-clean 会防御性清掉仍挂在该血统上的
  chunks/blobs/成员表行；
- `cleanup-lineages.py --hard` 走同一条路（`--force` 透传）。

## 3. duplicates 检测（UI 分组视图数据源）

```
GET /v1/admin/lineages/duplicates
→ 200 {"groups": [{
      "repoName": "...",
      "lineages": [{"id","repoId","repoIds","namespaces","chunks","last_seen","chunk_fps"}],
      "suggest": "merge into <lineageId>",   # chunks 最大的那个（并列取 last_seen 新者）
      "suggestId": "<lineageId>",
      "same_chunk_fp": true|false,            # 组内共享同一 chunk 指纹 → 合并收益最大
      "chunkFps": [...],
      "estimates": {"droppedChunks","droppedVectors","droppedBlobs",
                    "freedBytes","freedMb"}   # 按建议对精确数行 / blob 平均大小估字节
    }], "generatedAt": ...}
```

- 纯 SQL 聚合 + 内存分组，**只读**；
- 分组键：`repo_name`（缺省回退 `repo_id`）；组内 ≥2 个**未合并**血统才算重复组
  （`merged_into` 已置的血统退出建议）；
- `same_chunk_fp=false` 的组（同 repoName 但内容指纹不同，如 bug-analysis 的 2 个
  chunkFp）**是疑似而非确定**：合并前请人工确认两边的块内容是否同源。

## 4. 一次性清洗脚本

`scripts/cleanup-lineages.py`（容器内跑，两种连法二选一）：

```bash
# ① 干跑（默认，绝不写）：打印每组「将删除 N 行 / 释放 M MB」
python scripts/cleanup-lineages.py --db /data/index.db --dry-run
python scripts/cleanup-lineages.py --url http://127.0.0.1:8080 --token <admin-key>

# ② 按建议逐组执行合并（写操作！建议先 dry-run 核对）
python scripts/cleanup-lineages.py --db /data/index.db --apply
python scripts/cleanup-lineages.py --url http://127.0.0.1:8080 --token <admin-key> --apply

# ③ 观察期满的物理清理（--min-age-days 默认 7）
python scripts/cleanup-lineages.py --db /data/index.db --apply --hard
# ④ （可选）VACUUM 把释放的页真正还给文件系统（仅 --db 模式）
python scripts/cleanup-lineages.py --db /data/index.db --vacuum
```

- `--url` 模式走 HTTP（`--token` Bearer 或 `--user/--password` Basic，也可用环境变量
  `CLEANUP_TOKEN` / `CLEANUP_USER` / `CLEANUP_PASSWORD`）；`--db` 模式直连 SQLite
  （旧 schema 库先跑 `--migrate-cas`，见 §1.3；服务进程同时在线也可用，
  WAL + BEGIN IMMEDIATE，但迁移/合并建议停写后执行）。
- `--only <子串>` 只处理 repoName 含该子串的组；`--json` 原样输出 duplicates 结果。
- 不带 `--apply`/`--hard` 时脚本只读。

## 5. 上线操作序（Lead 在预览/正式部署时执行）

历史数据已授权清理（2026-11-20）。容器内连 `--db` 直跑（在线也可 `--url`，但迁移/合并
建议停写后执行）：

```bash
DB=/data/index.db   # 容器内库路径，按实际部署调整

# ① 停写（暂停插件同步 / 停服务均可）
# ② 一次性 CAS 迁移 + 立即回收文件体积（幂等；不带 --vacuum 则页进 freelist，体积后补）
python scripts/cleanup-lineages.py --db $DB --migrate-cas --vacuum

# ③ 起新版本服务（旧 schema 的库会拒绝启动并提示本脚本；起不来=迁移没跑）
# ④ 干跑核对 4 组重复（期望：smartpos-erp-pos / dsh-plugins / svc-center / bug-analysis）
python scripts/cleanup-lineages.py --db $DB --dry-run
#    ↑ bug-analysis 组 same_chunk_fp=false（同 repoName 但两个 chunkFp），
#      合并前人工确认两边内容是否同源；确认不了就 --only 跳过它先清其余三组

# ⑤ 按建议执行合并（重复数据当场物理删除）
python scripts/cleanup-lineages.py --db $DB --apply
#    或逐组：python scripts/cleanup-lineages.py --db $DB --apply --only smartpos-erp-pos

# ⑥ 墓碑清理（可选，不急；默认 merged_at 满 7 天才删，--force 立即）
python scripts/cleanup-lineages.py --db $DB --hard
```

预期数字（对照 2026-11-20 直查）：merge 后 chunks 净删约 **461 行**、旧成员表 vectors
净删约 **2049 行**（v2 负载本来就是全局一份、merge 前后不变）、blobs 按组归并
（smartpos-erp-pos 单组 ≈ 9467 行正文）。`--url` 等价命令（服务在线、有 admin key 时）：

```bash
python scripts/cleanup-lineages.py --url http://127.0.0.1:8080 --token <admin-key> --dry-run
python scripts/cleanup-lineages.py --url http://127.0.0.1:8080 --token <admin-key> --apply
```
