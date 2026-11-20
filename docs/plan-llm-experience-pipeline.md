# 计划：容器内 LLM 经验提纯 + 经验类型分类（2026-11-20）

> 目标：把「人工 18 条的质量标准」规模化，并让 **storage-hub 容器自己具备 LLM 提纯能力**；
> 会话被 `dsh-memory-archive` 压缩落盘后，自动产出**带类型**的经验入库。

---

## 0. 现状与目标

| 项 | 现状 | 目标 |
|---|---|---|
| 经验来源 | digest 直灌（规则版） | 会话压缩段自动提纯（LLM） |
| 质量 | what≈why 100%、空 when 85% | 按人工 18 条标准：三镜头 + 九类垃圾 + 可审计三维 |
| 分类 | 只有 lens（认知障碍） | 两轴：`lens`（黑话/索引/逻辑）× `category`（业务/调试/仓库联动/工具/流程） |
| 执行位置 | 本机离线脚本 | **容器内管道**，可被 API 触发、可批量重跑、进度可见 |

---

## 1. 两轴分类体系（核心设计）

### 1.1 两轴正交，各管一件事

```text
lens（认知障碍轴）—— 回答「Agent 为什么自己发现不了」
  jargon 语义不可发现 / index 位置不可发现 / logic 行为不可发现

category（工作域轴）—— 回答「这条经验属于哪类工作，该在什么场景召回」
  business  业务知识：业务口径、字段语义、状态机、结算规则、内部黑话映射
  debug     调试经验：现象 → 定位手段 → 根因 → 验证方式
  repo      仓库联动：跨仓依赖、分支/版本线、构建产物、发布顺序、数据表联动
  tool      工具环境：CLI 命令形态、环境变量、平台坑（MSYS/redis/devops）
  process   交付流程：审批、台账、发版规则 —— **默认拒收**（已由 sp-rules / sp-delivery-ledger 等 skill 覆盖）
```

为什么必须两轴：`lens=logic` 的"库存五张表"是 **business**，`lens=logic` 的"重放前删防重日志"是 **debug/技术**；
只用一个维度会把"业务口径"和"排查手法"混在一起，召回时无法按场景加权。

### 1.2 `process` 默认拒收的理由

文章 §四要求「不容易直接发现」，而审批流程、台账命令这类内容**已经在 skill 里**——
重复入库只会稀释库里高价值条目，且 skill 是"每次进场必读"，经验库是"按需召回"，两者定位不同。
（实现上：识别到 category=process 直接拦截，日志记 `skill-covered`，不进垃圾率统计。）

### 1.3 分类分布要可视

admin 经验页加「类型分布」小卡：每类条数 + 近 30 天新增 + 采纳率。
某类长期 0 采纳 → 该类的 prompt 或召回权重需要调，这是文章说的"用数据驱动 prompt 迭代"。

---

## 2. 架构：容器内 LLM 提纯

### 2.1 触发链（三段）

```text
① dsh-memory-archive（本机 DSH 插件）
   压缩发生 → 写 segment_NNN.md（已有能力）
   → 新增：POST {STORAGE_HUB}/v1/exp/extract
      body: {session_id, segment_no, summary, verbatim, model?}
      失败绝不阻塞压缩（fire-and-forget + 本地重试队列）

② storage-hub 容器（新增 exp 管道）
   接文本（**不落盘原文**，内存处理完即丢，只存经验 + 证据指针）
   → 主题切分（按 verbatim 内的事件序列，不附大纲 —— 文章 §五 的对照结论）
   → LLM 抽取（三镜头 + 九类垃圾 + 可审计三维，prompt 固化自人工 18 条标准）
   → Review（文本规则 + 源码探索事实校验，用本容器已有的 chunks/symbols 表）
   → Dedup（宁严勿宽、禁桥接）→ Merge（唯一目标前置、默认 create）
   → 写 memories（带 lens + category + audit）

③ admin / 观察
   /v1/exp/jobs 看每次抽取的漏斗（候选/拦截/入库/耗时/token）
   经验页按 category 分组 + 类型分布卡
```

### 2.2 为什么放容器而不是放插件

| 维度 | 容器内（推荐） | 插件内 |
|---|---|---|
| 批量重跑历史 | ✅ 一条 API + admin 按钮 | ❌ 要本机脚本 |
| 与 Review 的源码探索联动 | ✅ 同容器有 chunks/symbols 表 | ❌ 跨服务调用 |
| 漏斗/进度可见 | ✅ 复用 pipeline_runs + admin | ❌ 只有本机日志 |
| LLM 凭据 | 需网络打通（见 §3） | 本机现成 |

---

## 3. LLM 接入：**不做端口转发**，端点由设置页自填

已确认不走"本机端口转发"方案。改为：**LLM 端点完全由 admin 设置页填写**，
填什么就调什么——唯一硬约束是「**该地址必须能从 112 的容器内访问到**」。

```text
设置页填写 → 容器内 HTTP 调用 → 抽取 → 入库
                  ↑
      关键前置：点「测试连通」按钮，从**容器侧**发起请求
      再保存；本地 curl 通 ≠ 容器内通（实测过 magpie 只听 127.0.0.1）
```

因此 `测试连通` 必须是**服务端代理执行**（`POST /v1/admin/settings/llm-test` 由容器发请求），
不能由浏览器发——浏览器能通不代表容器能通，这是这类配置最常见的假阳性。

### 3.1 三种填法都能用（取决于你手上的端点）

| 你填的地址 | 容器可达性 | 说明 |
|---|---|---|
| 公司内网 LLM 网关（112 能访问） | ✅ | 最省事，配置即用 |
| 公网 OpenAI 兼容端点（容器有出网） | ✅ | 需确认 112 容器能出公网 |
| magpie（127.0.0.1:3425） | ❌ | 容器访问不到宿主回环；要它可用只能改监听或转发，本轮不做 |

> 若你最终只有 magpie 一个端点，就走 §3.2 的**插件侧抽取**——那条路不需要容器出网。

### 3.2 插件侧抽取（无网络依赖的备选路径，同时是降级方案）

```text
dsh-memory-archive（本机，能访问 127.0.0.1:3425）
  → 自己完成「主题切分 + LLM 抽取」
  → POST /v1/exp/import 把**已抽好的候选**交给容器
  → 容器只做 Review / Dedup / Merge / 入库（这一步不需要 LLM）
```

优点：容器零出网要求，magpie 直接可用；缺点：批量重跑历史要靠本机脚本、漏斗不在容器里。
**两条路径共用同一套 Review/Dedup/Merge 与同一份 prompt**，切换只改一个开关（`EXP_MODE=server|client`）。

### 3.3 模型选择（实测）


| 模型 | 实测 | 结论 |
|---|---|---|
| `auto/glm-5.3` | 429 限流；推理型，800 token 全烧 reasoning，content 为空 | ❌ 不适合批量 |
| `auto/deepseek-v4.1-flash` | 1 秒返回，content 直接可用 | ✅ **默认** |
| `auto/glm-5.3-flash` | 1 秒返回可用 | ✅ 备选 |

配置项：`EXP_LLM_URL / EXP_LLM_KEY / EXP_LLM_MODEL / EXP_LLM_MAX_TOKENS=2000 / EXP_LLM_TIMEOUT=60`
（单段超时 60s，失败重试 2 次，仍失败则跳过该段并记账，不阻塞管道）

---

## 4. 数据模型与 API 变更

### 4.1 表结构（一次性迁移，用户已授权历史可清理）

```sql
alter table memories add column category text default 'business';   -- business|debug|repo|tool|process
alter table memories add column audit text;                         -- json: reusable_because/exclusions/evidence_quote
alter table memories add column extract_run text;                   -- 哪次抽取产出（追责与回滚用）
create index memories_category on memories(category, status);

create table exp_jobs (            -- 抽取任务（每次插件调用一条）
  id text primary key, session_id text, segment_no int,
  status text,                     -- queued|running|done|failed|skipped
  model text, tokens_in int, tokens_out int, ms int,
  candidates int, blocked int, merged int, created int, updated int, skipped int, contradicted int,
  reasons text,                    -- json：各垃圾类别的拦截计数
  error text, created_at int, finished_at int
);
```

### 4.2 API

| 端点 | 用途 |
|---|---|
| `POST /v1/exp/extract` | 插件调用：传一段会话，同步跑管道，返回漏斗摘要（`?apply=0` 只出候选不入库） |
| `POST /v1/exp/import` | 降级通道：插件自己抽好的候选直接提交治理流水 |
| `GET /v1/exp/jobs?limit=N` | 抽取任务列表（admin 治理流水区数据源，与 pipeline_runs 合并展示） |
| `POST /v1/admin/exp/replay` | 批量重跑：`{session_ids|all, since, apply}` → 后台任务（进度看 /v1/exp/jobs） |
| `GET /v1/memories?category=debug` | 按类型过滤（含 admin 分组视图） |

### 4.3 鉴权与隐私

- 全部走现有 API_KEY（插件与服务同一把，或发一把 `exp:write` 专用 key）
- **原文不落盘**：`/v1/exp/extract` 只在内存里处理，日志与 DB 都不保存 verbatim；只存
  `evidence_quote`（≤80 字）与 `archive_ref`（segment 路径指针，本机可查）
- 可配置 `EXP_KEEP_RAW=1` 才落盘（默认关，给排障用）

---

## 5. 分阶段落地

### P0 · 设置页 LLM 配置 + prompt 固化（0.6 天）
- **设置页**（模型 tab 下「经验抽取」卡）：Base URL / API Key（只写不读，响应回掩码）/ 模型 /
  单段 token 预算 / 超时 / 日预算 / 并发 + 「测试连通」按钮
- **测试连通必须服务端代理**（`POST /v1/admin/settings/llm-test` 由容器发请求）：
  浏览器能通 ≠ 容器能通，这是本类配置最典型的假阳性
- 顺手识别推理型模型：`content` 空而 `reasoning_content` 有内容 → 提示"建议换 *-flash"
- 把人工 18 条标准固化成 prompt 模板（三镜头 + 九类垃圾 + 可审计三维 + category 判定 + process 拒收）
- **验收**：容器内对 1 段素材跑通，产出符合 schema 的候选；设置页填错地址时测试连通明确报"容器不可达"

### P1 · 表设计 v2 + 抽取端点（1 天）
- 按 `docs/schema-v2.md` 重写 SCHEMA（13 表 + 2 FTS + STRICT + 外键 cascade）：
  **不写迁移脚本**——重置重建，旧库直接拒绝启动
- `POST /v1/exp/extract`（主题切分→抽取→Review→Dedup→Merge 全链，`apply` 开关）
- Review 的源码探索：用容器内 chunks/symbols 表做符号存在性校验（跨仓符号标"未验证"不拦）
- **验收**：`test_exp.py` ≥ 20 项（含 process 拒收、process 不进垃圾率、跨仓符号不误杀、
  what≈why 拦截、apply=0 不写库）；既有回归全绿

### P2 · 插件接线（1 天）
- `dsh-memory-archive` 在 `writeSegment` 之后调用 `/v1/exp/extract`
  （fire-and-forget、超时 15s、失败入本地队列，**绝不阻塞压缩**）
- 配置项：`exp.enabled / exp.url / exp.key / exp.model / exp.minutesPerSegment`
- **验收**：真实压缩一次 → 容器内 `/v1/exp/jobs` 出现任务且 done；
  断网/容器停机时压缩仍成功且队列留痕（有测试钉住）

### P3 · 评测与调优（1 天，文章 §6.1 的三指标）
- **gold set**：人工 18 条（正例）+ 8 条拒收候选（负例）
- 对 33 段全量跑，统计：Recall（人工 18 条被抽中几条）、Precision、**Garbage Rate**（负例被误收几条）
- 迭代 2~3 轮 prompt，每轮记录指标变化（评测集固定，防过拟合）
- **验收**：Garbage Rate < 15%、Recall > 60%（首版目标，非终值）；报告写入 `docs/exp-eval.md`

### P4 · 历史重跑（0.5 天）
- **重置重建**（用户已确认：不写兼容代码、向量可清空重算）：停服 → 删 `index.db` → 起新版本
  （新 SCHEMA 空库）→ 客户端重推代码资产 → governor 后台重嵌 → 经验随库清空后重抽
- `POST /v1/admin/exp/replay {all, apply}` 重跑 33 段 → 预计 60~120 条
- **"旧 200 条如何处置"这个问题随之消解**：它们随重置一起消失，不需要 retired 流程
- **验收**：库里每条都有 `category` + `audit`；process 类为 0；类型分布四类均非空；
  重嵌进度可从 `status.speed/etaSeconds` 观测


### P5 · admin 呈现（0.5 天）
- 经验页：类型分布卡 + 按 category 分组/筛选 + 每条显示 `[category] [lens]` 双标签 + audit 折叠
- 治理流水区：抽取任务与跑批合并成一条时间线（都带 token/耗时）
- **验收**：冒烟锚点；窄屏不破

**合计 ≈ 4.5 天**（P0–P2 是可用的最小闭环，约 2.5 天）

---

## 6. 评测方法（照文章 §6.1，不放水）

```text
固定样本：33 段归档（同一 session）
正例集：人工 18 条（含证据位置）
负例集：8 条垃圾候选（多试几次 / 通用建议 / 调大超时 …）

每轮输出：Recall = 人工 18 条里被抽中且判定为保留的比例
          Precision = 抽出的条目中非垃圾比例
          Garbage Rate = 负例集被误收比例
          Category Acc = category 判定与人工标注一致率

判据：只看 Precision 会过度保守，只看 Recall 垃圾暴涨 —— 三个一起看，且不许用评测集调参
```

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 端点不可达/限流 | 插件侧降级自抽 + 本地重试队列；单段超时 60s 跳过不阻塞 |
| 原文进容器 | 默认不落盘（内存处理）；`EXP_KEEP_RAW` 开关；日志不含正文 |
| 抽到事实性错误 | Review 的源码探索（容器内 symbols 表）拦"不存在的类/方法"；跨仓符号标未验证 |
| 批量重跑把库改乱 | `replay` 只写新条目（source=`llm:<run>`），旧条目不删只 retired；可按 run 回滚 |
| 分类漂移 | category 枚举固定 5 类；process 直接拒收；每轮评测看 Category Acc |
| 成本失控 | 每段 1 次调用（≤2k token 输出）；单段失败不重试超过 2 次；日预算上限 `EXP_DAILY_TOKENS` |

---

## 8. 待你拍板的 2 件事

1. **证据片段落容器**：≤2KB 已脱敏（`EXP_EVIDENCE_MODE=excerpt`）／只要 80 字 quote／都不要？
   附：保留期 180 天后降级为 quote-only，够不够？
2. **向量精度**：重置要重嵌 ~21.7k 块，这是唯一免费的换精度窗口——
   维持 fp16（约 3.8h）还是先做 20 条 A/B 再决定换 fp32/int8（约 15~45min）？

> 已定：不写兼容代码、重置重建、旧 200 条随库清空（问题消解）。
> LLM 端点/Key/模型由你在设置页自填；唯一定死的是「该地址必须容器可达」，用服务端发起的
> 「测试连通」当场验证。

## 9. 显示层命名（已定，纯展示不改存储）

三镜头与五类知识在**所有给人看的地方用中文**，库内仍存稳定 code（避免迁移线上 200 条 + 18 条样本 + prompt）：

| code | 中文名 | 释义（悬停显示） |
|---|---|---|
| `jargon` | 黑话镜头 | 语义不可发现：内部黑话，字面推不出含义 |
| `index` | 索引镜头 | 位置不可发现：知道要什么，不知道去哪找 |
| `logic` | 逻辑镜头 | 行为不可发现：反直觉约束，常规推理推不出来 |
| `business` | 业务知识 | 业务口径、字段语义、状态机、结算规则 |
| `debug` | 调试经验 | 现象 → 定位手段 → 根因 → 验证方式 |
| `repo` | 仓库联动 | 跨仓依赖、分支版本线、构建产物、发布顺序 |
| `tool` | 工具环境 | CLI 命令形态、环境变量、平台坑 |
| `process` | 交付流程（默认拒收） | 审批/台账/发版规则，已由 skill 覆盖 |

约定：界面永不单独出现「索引」二字（避免与 `code_index` 撞词），一律写「索引镜头」四字整体。
API 同时返回 code 与 `lensLabel`/`categoryLabel`，前端直接用 label。


---

## 10. 经验显示：从「一张大表」到「进度可见」

现状问题：225 条挤在一张 6 列表格里，**只能"查"，看不出"进展"与"有没有用"**。
进度有三个层次，现在一个都没有：

| 层次 | 回答的问题 | 现状 | 目标形态 |
|---|---|---|---|
| ① 抽取任务进度 | 这批 33 段处理到哪了？ | 无 | 顶部进度条 + 实时漏斗数字 |
| ② 单条经验生命周期 | 这条经验处于哪一阶段？有用吗？ | 只有 status 列 | 卡片上的阶段徽标 + 采纳进度条 |
| ③ 库整体质量水位 | 治理有没有效果？哪类在退化？ | 只有 total/hits | 漏斗图 + 类型分布 + 采纳率趋势 |

### 10.1 布局（替换现有「经验条目」表格区）

```text
┌─ 本轮抽取 ────────────────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓░░░░░░  段 12/33 · 候选 84 · 拦截 11 · 入库 68       │
│ 用时 3m12s · in 41k / out 6.7k tokens · 当前 segment_012      │
└───────────────────────────────────────────────────────────────┘
┌─ 待办收件箱（原样保留，加类型分布） ───────────────────────────┐
│ 待裁决 3 · 待退役 52 · 待补向量 0 │ 业务 68 调试 71 联动 45 工具 33 │
└───────────────────────────────────────────────────────────────┘
┌─ 经验卡片流（默认视图，替代表格） ─────────────────────────────┐
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ 上传流水查不到时先比同机相邻流水的落库分区        [卡片]   │ │
│ │ [业务知识][逻辑镜头]  debug 系 · CHGJ-3943                │ │
│ │ ▓▓▓▓▓▓▓░░░ 采纳 7/9 · 2 天前命中 · 证据 ▸                │ │
│ └───────────────────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ 重放库存消息前先删 bas_interface_log 防重记录              │ │
│ │ [调试经验][逻辑镜头]  从未命中 ⚠ 待退役                    │ │
│ └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
        [卡片视图 | 表格视图]  [按类型 ▾] [按状态 ▾] [排序:采纳率 ▾]
```

### 10.2 单条进度的判定（服务端算好，前端不算）

```text
阶段 = 由 status + stats 派生，不新增状态机：
  待裁决   status=conflicting
  未召回   status=active 且 stats_hits=0 且 age<30d
  已召回   status=active 且 stats_hits>0 且 stats_adopted=0
  已采纳   status=active 且 stats_adopted>0
  可退役   status=active 且 (last_hit_at 为空或 >90d)      ← stale_days=90
  已归档   status=retired

采纳率 = stats_adopted / max(stats_hits,1)；卡片上画成 10 格进度条
```

新增 `GET /v1/memories/stats` 返回三类聚合，供 §10.1 第二、三块直接渲染：
`{funnel:{candidates,blocked_in_review,merged,created}, byCategory:{...}, byStage:{...}, adoptRate7d, trend:[...]}`

### 10.3 为什么卡片优于表格（不是审美问题）

| 维度 | 表格（现状） | 卡片（建议） |
|---|---|---|
| 一眼看出"这条有没有用" | ❌ 要看 5 列数字脑内换算 | ✅ 采纳进度条 |
| 双标签（类型×镜头） | ❌ 只有一列 lens 色标 | ✅ 两个 chip |
| 长文本可读性 | ❌ 截断成 80 字单行 | ✅ 标题两行 + 详情抽屉 |
| 390px 窄屏 | ❌ 横向滚动 | ✅ 单列堆叠 |
| 批量操作 | ✅ 复选框好用 | ⚠️ 需专门的"批量模式"开关 |

结论：**卡片为默认，表格保留为可选视图**（批量退役/导出时用表格）。切换状态存 localStorage。

---

## 11. 原文与证据：要不要落容器

先把"原文"拆成三样东西，它们该有不同待遇：

| 类别 | 内容 | 体积/条 | 该不该落容器 |
|---|---|---|---|
| **a. 会话原文**（segment verbatim） | 整段对话（含客户名、单号、命令、日志） | 10~50 KB/段 | ❌ 不落（隐私 + 无必要） |
| **b. 证据片段**（evidence excerpt） | 支撑某条经验的那 3~5 轮 / 一行命令 / 一段日志 | ≤2 KB | ✅ **建议落** |
| **c. 证据摘要**（quote） | 提炼时引用的原句 | ≤80 字 | ✅ 落（已在做） |

### 11.1 结论：推荐「b 落、a 不落」

只存 80 字 quote 的问题（你现在直觉里担心的）：

```text
· 换机器 / 归档被清理 → 证据永久丢失，经验变成无源之说
· 别人（同事/CI/未来的你）看到一条经验，无法验证它是不是编的
· 无法回溯上下文：「为什么当时这么判断」全靠猜
```

但整段原文落容器又违背 v2 决定（原文不上传）。**证据片段是两者之间唯一合理的落点**：
只挑"支撑这条经验的那几行"，体积可控（1000 条 × 2KB = 2 MB），可复核，且天然不含无关隐私。

### 11.2 存储设计

```sql
create table memory_evidence (
  id integer primary key,
  memory_id text not null,          -- memories.id
  sha256 text not null,             -- 片段哈希（同片段被多条经验引用只存一份）
  text text not null,               -- 裁剪+脱敏后的证据片段（≤2KB）
  kind text,                        -- quote|context|command|log|sql
  archive_ref text,                 -- 本机归档指针 segment_NNN.md#seq（可选，换机后失效）
  captured_at integer not null,
  expires_at integer                -- 默认 +180 天；到期只保留 quote
);
create unique index memory_evidence_sha on memory_evidence(sha256);
create index memory_evidence_mid on memory_evidence(memory_id);
```

- **落点**：与 memories 同库（storage-hub 的 index.db），复用现有备份/迁移链路，不新增服务
- **去重**：按 `sha256` 唯一，同一段证据被 3 条经验引用只存 1 份
- **脱敏**（入库前必做）：`sk-[A-Za-z0-9]{20,}`、`Bearer …`、`password=`、手机号、身份证 → `***`；
  租户名/工单号**保留**（它们是溯源关键，不是隐私）
- **裁剪**：只留命中行 ± 2 行上下文；命令类只留命令本身；日志留首尾各 3 行
- **保留策略**：180 天后降级为 quote-only（自动清理 text，保留 sha256 与 archive_ref 指针）
- **可关闭**：`EXP_EVIDENCE_MODE = off|quote|excerpt`（默认 `excerpt`）；`off` 时退化为只存 quote

### 11.3 收益（不只是"能看"）

1. **可复核**：点开经验详情 → 证据片段并排显示，判断"这条可不可信"从猜变成看
2. **可重抽取**：原文丢了也能用证据片段重建/校验经验（本机归档被清也不怕）
3. **可迁移**：换机器后经验库自洽，不依赖某台机器的 `~/.dsh/archive`
4. **可审计**：与文章 §6.1 的"可审计路径"对齐——每条经验都能回答"对话证据是什么"
5. **成本极低**：1000 条经验约 2 MB，占现有库（222 MB）的 1% 不到

### 11.4 需要你确认

- 证据片段（≤2KB，已脱敏）落容器 —— **同意 / 只要 quote / 都不要**？
- 保留期 180 天够吗？（到期只留 quote 与指针）

---

## 12. 经验检索要不要上向量加速（实测后的结论）

### 12.1 先说结论

| 问题 | 结论 |
|---|---|
| 经验库现在用 embed 吗？ | **已经在用**：`memories_vec` 223/223 条全覆盖，768 维，与 FTS5(trigram) 做 RRF 融合 |
| 要用 embed 做**查询加速**（ANN/HNSW/IVF）吗？ | **不需要**。全量点积 0.02 ms，而端到端 207 ms —— 瓶颈 100% 不在检索算法 |
| 现在该优化什么？ | **查询侧编码（~200 ms，占 97%）**，不是索引结构 |

### 12.2 实测数据（112 容器内，2026-11-20）

```text
向量矩阵          223 条 × 768 维 = 0.65 MB
全量点积          0.02 ms/次
取 top5           0.05 ms
FTS5 trigram 查询 0.01 ms/次
──────────────────────────────────────
端到端 /memories/search  207 ms  ← 其中 ~200 ms 是 query 编码（bge 推理）
```

**97% 的时间花在"把问题变成向量"，而不是"比对向量"。**

### 12.3 什么时候才需要 ANN（量化阈值）

| 经验条数 | 矩阵体积 | 全量点积 | 是否需要 ANN |
|---|---|---|---|
| 1,000 | 2.9 MB | ~0.05 ms | 否 |
| 5,000 | 15 MB | ~0.3 ms | 否 |
| 50,000 | 147 MB | ~3 ms | 边界（内存吃紧才考虑） |
| 200,000+ | 590 MB | ~12 ms | 是 |

经验库的天花板：腾讯 50 人团队跑下来才 **789 条**；我们按每段产出 2~4 条算，33 段 ≈ 100 条，
全年所有会话估计 **1,000~3,000 条**。**永远到不了需要 ANN 的量级。**

引入 ANN 的代价不小：新依赖（faiss/hnswlib）、内存常驻、ANN 有召回损失（经验库"宁缺勿滥"，
漏召回比慢 5ms 严重）、增运维面。**收益 0.02ms → 0.005ms，无意义。**

### 12.4 真正值得做的三件优化（按性价比排序）

| # | 优化 | 预期收益 | 成本 |
|---|---|---|---|
| 1 | **query 向量缓存**（同 query 60s 内复用；admin 反复点、召回同一问题命中） | 207 ms → **~5 ms**（命中时） | 20 行 |
| 2 | **两段式检索**：先 FTS（0.01 ms），命中条数够且分数好就不 embed；只有"中文同义改写"场景才走向量 | 常见查询 207 ms → **~2 ms** | 40 行 |
| 3 | **批量写入走 batch encode**：现在 upsert 逐条同步 embed（~200 ms/条），P4 重灌 120 条 ≈ 24 s；若一次灌 1,000 条就是 3.3 分钟 | 批量快 8~15× | 60 行 |

### 12.5 比 ANN 更有用的：结构性索引

经验查询的实际形态是「**筛选 + 语义**」组合（按类型/工作流/状态过滤后再排），
所以复合索引的收益远大于任何近似最近邻结构：

```sql
create index memories_cat_status on memories(category, status);
create index memories_wf_status  on memories(workflow, status);
create index memories_hit_at     on memories(last_hit_at desc);   -- 陈旧筛选
```

### 12.6 一句话给未来的自己

> 「经验库慢」永远不会是检索算法的问题，是**编码模型与查询次数**的问题。
> 先缓存、再两段式、最后才谈更快的模型；上 ANN 之前先数一遍条目数。
