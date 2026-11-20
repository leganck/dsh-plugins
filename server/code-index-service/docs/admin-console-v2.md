# admin 控制台 v2 设计（对齐 storage-hub 架构）

> 状态：设计稿（2026-11-20）。基于 docs/architecture-storage-hub.svg 的两类资产架构，
> 重排现有 /admin 页面的信息架构。现有页面 133 KB 内联 HTML+JS 保留骨架，本设计以
> **增量改造**为主：新增两个 tab（经验 / 检索测试扩容），概览页加资产卡片，不推倒重来。

## 0. 设计原则

| 原则 | 落法 |
|---|---|
| 信息架构对齐架构图 | tab 分组 = 「概览 / **代码资产** / **经验资产** / 模型 / Key / 统计 / 日志」 |
| 资产并列可见 | 概览页放两张资产卡（代码 scopes / 经验 memories），一眼看到双资产规模与增长率 |
| 治理闭环可见 | 经验 tab = 列表 + conflicts 人工裁决队列 + 打点统计（hit/adopted/命中率）|
| 操作留痕 | conflicts 的 resolve 动作、批量导入，都写进服务日志（现有 /log tab 已有）|
| 检索测试升级 | 现有「检索测试」扩成双资产：代码块检索 + 经验检索，都能试查询 |

## 1. 导航结构（tab 变化）

```text
现有：概览 | 模型 | API Key | 统计 | 作用域 | 日志
新增：概览(改) | 代码资产(改自"作用域") | 经验(新) | 模型 | API Key | 统计 | 日志
```

「作用域」改名「代码资产」：内容不变（scopes 列表/检索测试），标题与架构图术语对齐。

## 2. 概览页（tab-overview）

现有卡片：运行时 / 系统负载 / 嵌入治理 / 存储与限额 / 向量标签 / 鉴权状态。

**新增两张并排资产卡**（放在「运行时」下方，grid 2 列）：

### 卡片 A：📦 代码资产
```text
┌──────────────────────────────────────┐
│ 📦 代码资产              [管理 →]    │
│ 19 个作用域 · 12 血统 · 41,230 块    │
│ 向量覆盖 99.2% · 待嵌 312 块         │
│ 今日：sync 1,205 · search 47         │
│ [sparkline: 7 天块数增长]            │
└──────────────────────────────────────┘
```
数据源：现有 `/v1/scopes?limit=100`（total/chunks/vectors 汇总）+ `/v1/admin/stats`（当日 endpoint 计数）。

### 卡片 B：💡 经验资产
```text
┌──────────────────────────────────────┐
│ 💡 经验资产              [管理 →]    │
│ 223 条 · active 218 / conflicting 3  │
│ 命中 47 次 · 采纳 31 次（采纳率 66%）│
│ 近 7 天新增 12 条 · 退役 2 条        │
│ [冲突待裁决 3 →]（红点，>0 时显示）  │
└──────────────────────────────────────┘
```
数据源：`GET /v1/memories?limit=1`（total）+ `/v1/memories/conflicts?limit=1`（队列长度）
+ admin stats 的 memories 块（hits/adopted）。红点徽标直接链到经验 tab 的冲突队列。

## 3. 经验 tab（新，tab-memories）

四个区块，纵向排列：

### 3.1 顶部工具条
```text
[搜索框 what/when/why 全文____] [lens ▾] [repo ▾] [status ▾] | +新建 | ⤒ 批量导入(JSON) | 导出 CSV
```

### 3.2 列表（主表格）
| 列 | 内容 |
|---|---|
| id | exp-000123（点击展开详情抽屉）|
| lens | 色标 chip：蓝=index / 紫=jargon / 橙=logic |
| what | 截断 80 字符 |
| repo | global / smartpos-erp-pos … |
| 状态 | active✓ / retired / conflicting⚠ |
| 命中/采纳 | 47/31（悬停看 last_hit_at）|
| 操作 | [hit+1] [编辑] [退役] |

分页（服务端 limit/offset 已支持）；行点击展开**详情抽屉**：what/when/why 全文、evidence 列表
（archive_ref 可链到会话段路径文案、issue 显示单号）、source、created/updated。

### 3.3 冲突裁决队列（conflicts 区块，有条目时高亮）
```text
┌─ ⚠ 冲突待裁决（3）──────────────────────────────────────┐
│ ── 新候选 ─────────────────── vs ── 既有条目 ──────────  │
│ what: 直接 push 到 main       │ what: 403 时改推 fork   │
│ when: 发版时                 │ when: 推送被拒时         │
│ evidence: SPLAT-1234 …       │ evidence: CHGJ-3891 …   │
│        [保留新（退役旧）] [保留旧（退役新）] [都保留]      │
└──────────────────────────────────────────────────────────┘
```
操作语义 = 现有 `POST /v1/memories/{id}/resolve`（active|retired）：「保留新」= 旧条目 resolve
retired + 新条目 resolve active；「都保留」= 两条都 active（人工判定非真冲突）。
每条操作写日志。这是腾讯方法论里「contradict 不自动决断，走人工裁决通道」的界面落点。

### 3.4 打点与生命周期统计（底部小卡行）
```text
[总命中 47] [采纳率 66%] [近7天 hit 12] [90天未命中 8 条 → 待退役]
```
「待退役」点击 → 过滤列表 status=active 且 last_hit_at<90d（前端算，列出来供人工批量退役）。

## 4. 代码资产 tab（原「作用域」改名）

内容保持现有（scopes 表格 / 检索测试），只做两处增强：

1. **检索测试区加「资产切换」**：`[代码块] [经验]` 两个 seg 按钮——代码块走现有 `/v1/search`
   （namespace 选择器不变）；经验走 `/v1/memories/search`，返回 hits 表格复用同一渲染器，
   列换成 id/lens/what/score。这样 admin 页内就能对照试「同一个问题两类资产各返回什么」。
2. scopes 表格每行加「块均向量」列（vectors/chunks），覆盖率 <100% 的行黄色高亮（已有数据，纯前端）。

## 5. 统计 tab（现有增强）

stats 的 categories 四类里 retrieval 现在含 bodies/memories 端点。加一个小修正：
「按端点」表里 bodies/memories 单列出来（服务端 _endpoint_group 已分组，前端目前合并显示）。
经验打点（hit/adopt）不进 stats（它们不是 HTTP 语义的调用），在经验 tab 的 3.4 区块看。

## 6. 实现拆分（不推倒 133KB 现有页面）

| 步骤 | 内容 | 端点依赖 | 状态 |
|---|---|---|---|
| A | 概览页两张资产卡 + 红点徽标 | 已上线（scopes/memories/stats） | 可立即做 |
| B | 经验 tab 四区块（列表/抽屉/冲突队列/统计） | 已上线（memories 8 端点） | 可立即做 |
| C | 代码资产 tab 改名 + 检索测试双资产切换 + 覆盖率高亮 | 已上线 | 可立即做 |
| D | 统计 tab 端点细分显示 | 已上线 | 可立即做 |
| E（后置） | 90 天未命中批量退役按钮 | 需服务端加 `GET /v1/memories?stale_days=90` | 随下版 |

全部为 server.py 内联 HTML/JS 的增量（新 tab ≈ 新增 8-10 KB），不动后端逻辑——
memories 的 8 端点在 0.16.0 已全部上线，纯前端消费。

## 7. 不做的（明确排除）

- 不做经验条目的富文本编辑器（textarea 足够，编辑低频）
- 不做实时 WebSocket 推送（沿用现有自动刷新轮询）
- 不做暗色/亮色主题切换（现有暗色即唯一主题）
- 不把 admin 拆独立前端工程（内联单文件的「打开就能用」是特性，不是负债）
