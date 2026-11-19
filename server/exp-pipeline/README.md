# exp-pipeline：经验提纯管道（离线脚本，不常驻）

读本地 DSH 归档（`~/.dsh/archive/<sessionId>/segment_*.md`）或既有经验 digest，
经 **Stage A 清洗 → Stage B 抽取 → Stage C 三层治理**，把清洗后的经验写入
index-server `/v1/memories`。设计依据：`docs/plan-storage-hub.md` §2.2（腾讯方法论）。

```
原始 segment（md，含 verbatim 轮次）                    experience-digest.md
        │                                                      │
        ▼                                                      ▼
┌─ Stage A 清洗（stage_a.py）──────────────┐    ┌─ digest 解析（stage_b_rules.parse_digest）
│ 主题分组（事件序列切题，不附大纲）        │    │  bullet → 候选（跳过 Stage A）
│ 噪声剥离（信封/过程指令/无结论轮次）      │    └──────────────┬───────────────
│ 事实锚定（工单号/路径/类名方法/SQL 表）   │                   │
└───────────────┬─────────────────────────┘                   │
                ▼                                               │
┌─ Stage B 抽取 ────────────────────────────────────────────── ▼ ─┐
│ 规则版（默认，stage_b_rules.py）：修正句式+锚定事实 → 候选        │
│   {what, when_expr, why, lens(jargon|index|logic), evidence}     │
│ LLM 版（--llm 可选，stage_b_llm.py）：九类垃圾特征内嵌 prompt，    │
│   缺 PIPE_LLM_URL/KEY/MODEL → 优雅降级规则版（提示，不报错）      │
└───────────────┬─────────────────────────────────────────────────┘
                ▼
┌─ Stage C 治理（stage_c.py）──────────────────────────────────────┐
│ Review：缺 when / what<8字 / 证据空 → 拦截；                      │
│   源码探索：类名/方法名 POST {INDEX_URL}/v1/search 验证存在，     │
│   查不到 → factual_error 拦截（服务不可用不拦）                   │
│ Dedup：what+when 相似 >0.90 合并，禁桥接                          │
│ Merge：POST /v1/memories/search 找同向 →                           │
│   create（默认）/ update / skip / contradict（→ conflicting 队列）│
└───────────────┬──────────────────────────────────────────────────┘
                ▼ （非 --dry-run 时经 client.py 写入）
        index-server memories（task-5 契约：POST /v1/memories 幂等 upsert）
```

## 用法

```bash
# 真实归档 dry-run（默认零网络请求；只输出候选与治理判定）
python pipeline.py --dry-run --session <sessionId> --limit 3

# dry-run + 只读源码探索（POST /v1/search 验证类名/方法名存在）
python pipeline.py --dry-run --explore --session <sessionId>

# 正式灌库（写 index-server /v1/memories）
INDEX_URL=http://192.168.50.112:18000 INDEX_API_KEY=... \
  python pipeline.py --session <sessionId>

# 223 条种子 digest
python pipeline.py --from-digest experience-digest.md --dry-run

# LLM 抽取（OpenAI 兼容；缺 env 自动回退规则版）
PIPE_LLM_URL=http://llm:8000/v1 PIPE_LLM_KEY=... PIPE_LLM_MODEL=... \
  python pipeline.py --llm --session <sessionId>

# 全部参数
python pipeline.py [--archive-dir DIR] [--since YYYY-MM-DD] [--session ID]
                   [--dry-run] [--llm] [--limit N] [--from-digest FILE]
                   [--explore] [--no-verify] [--top-k N] [--verbose]
```

环境变量：`INDEX_URL`（默认 `http://192.168.50.112:18000`）、`INDEX_API_KEY`；
LLM：`PIPE_LLM_URL/PIPE_LLM_KEY/PIPE_LLM_MODEL`。中文输出建议
`PYTHONIOENCODING=utf-8`（Windows 控制台 GBK）。

依赖：Python ≥3.10 标准库（numpy 都不需要；LLM 走 urllib）。

## 三层治理的默认方向（重要）

| 层 | 默认方向 | 含义 |
|---|---|---|
| **Review** | **默认保留、定向过滤** | 只拦「可判定为垃圾」的候选：缺 `when` / `what`<8 字 / 证据为空 / 源码探索**明确 0 命中**证伪。探索服务不可用**不拦**（放行），宁漏勿错杀——历史会话里沉默的大多数是好经验。 |
| **Dedup** | **宁严勿宽** | 仅当 `what+when` 相似度 **>0.90** 才合并，且**禁桥接**：只与已保留代表项两两比较，不通过被合并项传递相似（A~B、B~C 合并不代表 A~C 合并）。合并时证据取并集。 |
| **Merge** | **唯一目标前置、默认 create** | 先查 `/v1/memories/search` 确定同向条目是否存在：无命中 → **create**（upsert 幂等）；同向几乎一致（>0.9）且证据已覆盖 → skip（不重复写）；同向但有新信息/证据 → update（幂等 upsert）；同主题但指令方向相反（禁令 vs 要求、改用 X vs 直接 Y）→ contradict，写入 `status=conflicting` 进人工队列（`GET /v1/memories/conflicts`）。 |

三个默认共同的目标：**入库的每条经验可追溯（evidence→archive_ref/工单号）、
不重复、不自相矛盾**；拿不准的一律不上（create 是唯一"新增"出口，且受 Review 前置约束）。

## lens 三镜头

| lens | 判定 | 例子 |
|---|---|---|
| `logic` | 修正/约束/根因句式（"改成 X 才对/应该 Y/不要 Z/根因是…"） | "推送上游 403 需要改用 fork 推送才成功" |
| `index` | 路径/模块/类名/表名指向（定位入口） | "hzf_pay_book 无 pay_amount，用 amount/order_code" |
| `jargon` | 专有名词词典未命中的行话 | "pay 3.x 不部署 dev2（dotenv 覆盖 ENV）" |

## 测试

```bash
python test_pipeline.py   # 59 checks 全绿；不依赖真实服务/模型
```

覆盖：Stage A（真实归档裁剪夹具 + 真实归档本体）、规则抽取、digest 223 条解析、
LLM 无 env 降级、Review 四类拦截 + 源码探索 stub（类名不存在→factual_error）、
Dedup 相似合并 + 禁桥接、Merge 四判（含 contradict→conflicting 队列）、
HTTP 客户端（本地 stub server 走真实 urllib 路径 + Bearer 鉴权头）。

## 边界

- 只读归档、只写 `/v1/memories*`（经 task-5 冻结契约），不直连库。
- `--dry-run` 默认**零网络**；`--explore` 只读；写操作只在不带 `--dry-run` 时发生。
- 归档原文不上传（服务端只收 evidence 引用：archive_ref / 工单号）。
- 不常驻：一次性跑批脚本，无后台进程。
