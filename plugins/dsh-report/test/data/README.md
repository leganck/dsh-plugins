# test/data —— 数据层单测（SQLite / GitLab / matcher / sync）

零网络、零外部依赖：SQLite 用临时目录建真实库（`node:sqlite`），GitLab 全部用 `fetchImpl` 桩。

## 运行

```bash
# 推荐（Node 22.19 / 24.x 也可用目录参数）
node --test test/data

# Node 26.x 起 `--test` 的位置参数按 glob 解析，传目录会被当模块加载；
# 用下面这条等价命令：
node --test "test/data/**/*.test.mjs"
```

单文件跑：

```bash
node --test test/data/matcher.test.mjs
```

## 覆盖矩阵

| 文件 | 覆盖点 |
|---|---|
| `db.test.mjs` | 建表/PRAGMA/schema 版本；`upsertCommits` 幂等；`replaceCommitStats/Refs` 替换语义与 `branch_order`；`listCommitsInPeriod` 区间/双键/JOIN/顺序；`saveSelectedProjects` 全量替换与连接隔离；`pruneCommits`（含"不传 keep 不删"安全默认）；报告 upsert/聚合/子表/删除；`sync_jobs` 状态机；`withTransaction` 回滚与嵌套；`listCoverageRows` |
| `matcher.test.mjs` | workbench `buildCommitMatcher` 全规则表驱动（profile 邮箱 → `/user/emails` → identity → Co-authored-by）；4 种 evidence 标签；lower+trim 口径；别名字符串切分；author 优先于 committer |
| `gitlab.test.mjs` | URL/`PRIVATE-TOKEN`/query 参数；`x-next-page` 分页解析与"无分页头"；429 尊重 `Retry-After`；5xx 指数退避最多 3 次；404 不重试；60s 超时；非 JSON；config 错误 |
| `sync.test.mjs` | 完整同步落库 + 派生列（merge/cherry-pick）；窗口 `authored_date` 二次过滤；分页头缺失 → incomplete 不 prune（终态 `succeeded`+`partial`）；完整翻页 → prune；运行中取消 → `cancelled`；detail/页错误 → `succeeded`+`partial`+`sync_job_errors`；零成功+有错误 → `failed`；多项目/页串行顺序；页内并发 ≤8；`listCandidates` 分页与 q；`saveSelection`；`coverage` 聚合；`start` 校验与活动任务复用；`status/listJobs` |

## 与 Go 侧的对照

口径来源：`docs/plugin-extraction/05-route-b-data-acquisition.md`（REST 清单/分页/匹配规则）、
`06-route-b-storage-runtime.md`（SQLite 方案）；Go 代码 `internal/repository/commitimport/service.go`、
`internal/repository/sqlite/commit_import_repository.go`。

有意差异（已在实现注释里标注，并在 CONTRACTS §4.1「实现偏差登记」登记）：

1. 时间窗口按**本机时区**生成（Go 写死 UTC+8，见 05 分册 R2）；
2. 拉回后按 `authored_date` 前 10 位**二次过滤**（Go 只信 GitLab `since/until`，见 05 分册 R1）；
3. 429/5xx 重试（Go 无重试）；
4. 分页头缺失 → `incomplete`，不 prune（Go 只看 `x-next-page`，见 05 分册 R4）；
5. 部分失败终态 = `succeeded` + `progress.partial=true` + `progress.errors>0`（Go 是 `completed_with_errors`），仅「零成功 + 有错误」才 `failed`；
6. matcher `evidence` 固定 4 种标签（Go 6 种，仅内部枚举差异，命中集合一致）；
7. `listCandidates` 返回数组、`cancel` 返回 boolean（与 api/tools 消费形状对齐）。
