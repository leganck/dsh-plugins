# 诊断报告：Admin UI 信息架构 + 经验治理可见性 + 索引指纹重复（2026-11-20）

三个问题逐一诊断，每个都给出「现状证据 → 根因 → 修复方案」。

---

## 问题一：UI 看不到重点

### 现状证据（线上 157 KB 页面实测）

```text
7 个 tab：概览 | 模型 | API Key | 统计 | 代码资产 | 经验 | 日志
概览页 8 张卡片：运行时 / 代码资产 / 经验资产 / 系统负载 / 嵌入治理 / 存储与限额 / 向量标签 / 鉴权状态
```

### 根因分析

| # | 病灶 | 证据 |
|---|---|---|
| 1 | **平铺无层级**：8 张卡片同权重堆叠，「运行时/鉴权/向量标签」这类低频运维信息和「双资产」核心价值抢同一屏 | 概览页卡片顺序：运行时在最上，双资产卡第二 |
| 2 | **数字没有锚点**：经验卡显示「223 条 · 命中 0 · 采纳 0」——0 是因为刚灌完种子还没人用，但页面不解释，看起来像坏掉了 | `memories: {total:223, hits:0, adopted:0}` |
| 3 | **tab 顺序违背使用频率**：日常高频是「经验裁决 + 检索测试」，但 tab 顺序是概览→模型→Key→统计→代码资产→经验 | 7 tab 排列 |
| 4 | **统计与打点两套口径**：stats tab 是 HTTP 调用维度（retrieval 456 次），经验 tab 是业务维度（hits 0）——用户要自己脑内拼接 | 两个 tab 数字互不相干 |

### 修复方案：概览页改「驾驶舱」式三层结构

```text
第一层（首屏核心，占 60% 高度）
┌─────────────────────┬─────────────────────┐
│ 📦 代码资产          │ 💡 经验资产          │
│ 19 作用域·40175 块   │ 223 条 · 3 待裁决     │
│ 覆盖 99.2% ▓▓▓▓░    │ 本周新增 0 · 命中 0   │
│ [异常] svc-center    │ [行动] 3 条冲突待裁决  │
│   cov 91% 待补嵌 60  │   → 点击直达裁决队列   │
└─────────────────────┴─────────────────────┘
  关键变化：①数字旁边必须有状态（正常绿/需行动橙/异常红）
          ②"待裁决 3 条"这类**需要人动手的事**用行动色，比"命中 0"重要

第二层（一句话健康度）
  ● 服务正常 · 嵌入运行 10 块/s · 磁盘 64MB/20GB · 7 天零错误

第三层（折叠，默认收起）
  <details> 运行时详情 | 系统负载 | 鉴权 | 向量标签 </details>
```

tab 重排为使用频率序：`概览 | 经验 | 代码资产 | 统计 | 模型 | Key | 日志`。

---

## 问题二：三层治理完全看不到

### 现状证据（关键词计数实测）

```text
全页扫描：Review 0 次 · Dedup 0 次 · Merge 0 次 · 拦截 0 次 · 垃圾率 0 次
有出现：冲突 3 · 裁决 7 · 采纳 4 · 待退役 2
```

经验 tab 只有三个区块（冲突裁决 / 经验条目 / 打点统计），**全是「结果态」**。

### 根因分析

三层治理（Review → Dedup → Merge）发生在 **exp-pipeline 离线跑批时**，跑完只留最终条目入库——
admin 只能看到治理的「产物」，看不到「过程」。具体缺失：

1. **管道运行记录不存在**：pipeline.py 跑完输出到 stdout 就没了，没有落库。跑了多少候选、
   拦截多少、为什么拦截、Dedup 合并几对、Merge 判定 create/update/skip/contradict 各多少——全不可查。
2. **conflicts 队列是唯一过程残迹**：但 UI 只显示「新 vs 旧」两列，不显示**触发原因**（哪条规则判的 contradict）。
3. **无管道入口**：想跑一次治理得 SSH 到机器上敲 python 命令，admin 页没有触发按钮。

### 修复方案：治理三件套

**A. 服务端加 `pipeline_runs` 表**（一行一次跑批）：

```sql
pipeline_runs(id, started_at, finished_at, trigger,  -- manual|schedule
  sessions_scanned, candidates,                       -- Stage A/B 产出
  review_blocked, review_block_reasons json,          -- Review 拦截明细
  dedup_merged,                                       -- Dedup 合并数
  merge_created, merge_updated, merge_skipped, merge_contradicted,
  errors json)
```

管道每跑一次写一行（pipeline.py 在 client.py 加 `report_run()` 调用）。

**B. 经验 tab 加「治理流水」区块**（放在冲突裁决上方）：

```text
┌─ 治理流水（最近 5 次）───────────────────────────────┐
│ 11-20 09:24  seed 灌入    223 候选 → 223 created      │
│              ·0 拦截 ·0 合并 ·0 冲突     [明细 ▾]      │
│ 11-19 20:00  会话跑批×3  2388 候选 → 2215 create      │
│              ·5 拦截(证据空3/what过短2) ·168 合并      │
│              ·0 冲突                      [明细 ▾]    │
└──────────────────────────────────────────────────────┘
  明细展开：拦截原因分布饼图 + 被拦条目原文（可单条强制入库）
```

**C. 冲突卡补「判定依据」**：每条 conflict 显示触发词对（如 `直接 push` vs `403 改推 fork`），
服务端 conflicts 端点扩展 `against` 字段（配对的原条目全文）。

---

## 问题三：代码索引重复指纹

### 现状证据（服务端库直查）

```text
19 个 scope 里，同名仓库出现多份「平行宇宙」：

dsh-plugins        → 3 个 repoId（02fa1d9/36862c/e32c23）、2 个 lineage
smartpos-erp-pos   → 2 个 repoId（75ddf60/effe338）同 chunkFp dff7d385 完全相同
smartpos-crm-order → 3 个 repoId（bdfd9b/557f4a）+ 2 个 chunkFp
smartpos-svc-center→ 3 个 repoId
bug-analysis       → 2 个 chunkFp（4619 块 + 1542 块）

实际浪费（量化）：
  chunks 表 40175 行中，跨血统重复 hash 414 个 → 多存 461 行
  vectors 表 23730 行中，跨血统重复 1971 个 hash → 多存 2049 行（≈8.6% 浪费）
  erp-pos 最典型：9467 块 × 2 份（两个 repoId 各存一份，chunkFp/内容完全一致）
```

### 根因分析（代码级定位）

`lib/repo.js:98 repoIdOf()`：

```js
const url = normalizeRemoteUrl(gitOriginUrl(repoRoot))   // git remote URL
const seed = url || `local:${path.resolve(repoRoot)}`     // ← 病灶
return sha1(seed).slice(0, 12)
```

repoId = **git remote URL 的哈希**。同一仓库出现多个 repoId 的三条路径：

| 场景 | 实例 | 结果 |
|---|---|---|
| ① 无 git remote 时退化到 `local:绝对路径` | dsh-plugins 的 worktree（`D:\Code\_tmp\rewrite2` 无 origin） | 路径不同 → repoId 不同 → 新 lineage |
| ② remote URL 写法不同（https/ssh、带不带 .git） | normalize 只处理了部分形态 | 同仓两 ID |
| ③ 真·多 clone 位置（D:\Code\xxx 和别处各一份） | erp-pos 在 erp\ 和 erp2\ 各一份 | 各自建库 |

且 **lineage = repoId 派生**，repoId 一变 → 新 lineage → 新 namespace → 同一批 chunk 重传重嵌。
服务端有 simhash 跨血统复用（reuse=suggest），但只建议不自动执行。

### 修复方案（三层：止血 → 合并 → 防再犯）

**第 1 层·止血（客户端，立即可做）**：`repoIdOf` 的本地退化种子改为「目录内容指纹」而非绝对路径——

```js
// 旧：local:D:\Code\_tmp\rewrite2（搬家/克隆即变）
// 新：读 .git/config 的 remote；真没有 remote 时用 git rev-parse HEAD（同仓库任意 clone 同 commit 同 ID）
const seed = url || `commit:${gitHeadCommit(repoRoot)}` || `local:${path.resolve(repoRoot)}`
```

无 remote 仓库按 HEAD commit 认亲：同仓库的两个克隆（同 commit）→ 同 repoId → 同 lineage，不再裂。

**第 2 层·合并（服务端，一次性清洗）**：新增管理端点 `POST /v1/admin/lineages/merge`：

```json
{ "from": ["effe33807689", "36862c245cda", "9f01a8a53941"], "into": "75ddf6063c15" }
```

服务端事务内：repos 行改 lineage_id → chunks/vectors 按 (lineage_id,hash) 去重删重 → 统计刷新。
配 admin UI 的「作用域」页一个合并按钮（下拉选 from/into，显示将释放的空间预估）。

**第 3 层·防再犯（UI 可见性）**：admin「代码资产」页加**同名仓库分组视图**：

```text
smartpos-erp-pos（2 个血统 ⚠️）
  ├ 75ddf6063c15  9467 块 · deploy/plat · 3 天前
  └ effe33807689  9467 块 · deploy/plat · 5 天前   [与上行同指纹]
                                          [合并到 ↑] [删除]
```

同 repoName 多 lineage 的组自动标 ⚠️，同 chunkFp 的自动给「合并」建议。

---

## 实施排期建议

| 批次 | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| 1 | UI 重排（驾驶舱概览 + tab 序 + 治理流水区块骨架）+ repoId 止血 | 0.5 天 | 无 |
| 2 | 服务端 pipeline_runs 表 + 管道上报 + conflicts 带 against | 0.5 天 | 批次 1 的 UI 骨架 |
| 3 | lineages/merge 端点 + 数据清洗（把 4 组重复合一）+ UI 分组视图 | 1 天 | 批次 2 |
| 4 | 经验卡行动色 + 异常徽标 + 待退役清理 | 0.5 天 | 无 |

总计约 2.5 天。批次 1+4 纯前端可立即做；批次 2+3 需服务端发版（走同一 CI 流程）。
