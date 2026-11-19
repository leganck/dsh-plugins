# 后台嵌入吞吐：0.8 块/秒 的定位与改动（T-261118-perf）

> 范围：只改 `server/code-index-service/` 内代码（`governor.py` / `embedder.py` / `server.py`），
> 未改 `plugins/`，未 `git add/commit`，**未重启、未部署容器**（线上 192.168.50.112 仍是旧进程）。
> 本文所有「本机实测」都用**合成库 + stub embedder**（不需要 onnxruntime / 真实模型），
> 复现命令：`python tests/bench_embed_governor.py`。
> 本机是开发机（后台有别的任务在跑），ms 级数字有 ±50% 抖动，所以 §2.2 给的是区间；
> 决定性结论（调度+DB 只占 10 s/批 的 0.02%）不受抖动影响。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 0.8 块/秒 是调度器/DB/锁造成的吗？ | **不是**。每批固定开销实测 0.9–1.8 ms；零模型耗时下调度器上界 4.7k–11.6k 块/秒。 |
| 那时间花在哪？ | **模型调用**：0.8 块/秒 ⇔ 一批 8 块 ≈ **10 s**（1.25 s/块）。 |
| `rate: 10.0` 是真的吗？ | `rate` 只是配置上限，**从来没生效**：一批要 10 s，而限速只要求 0.8 s/批 → `sleep` 分支永远不执行。旧 status 没有 `speed` 字段，所以「rate=10」看起来像实测值 —— 这正是本次要加 `speed/etaSeconds` 的原因。 |
| 模型为什么这么慢？ | 两个代码级放大器叠在 fp16-CPU 上：**① padding 到批内最长**（hash 顺序取块 → 批内长度随机，token 成本 ×2.38）；**② fp16 ONNX 跑 CPU EP**（`model_bytes≈203MB` = fp16 模型；CPU EP 上 fp16 算子退化为 Cast，比 fp32/int8 慢 5–20×，属强怀疑，需真实模型复测）。 |
| 本次改了什么 | 候选窗口 + 长度分桶（默认 `EMBED_WINDOW=3`）、同批正文去重、限速改为截止时间分片等待、`status` 新增 `speed/etaSeconds`、启动期 fp16-on-CPU 告警。 |
| 预期效果 | **0.8 → 1.5 块/秒（仅分桶）/ 1.8 块/秒（含 20% 重复正文）**，即 ≈2×；erp-pos 的 9280 pending 从 ~3.2 h 降到 ~1.5 h。要真正接近 `rate=10` 必须换模型精度或上 GPU（不在本次改动内，见 §6）。 |
| 何时生效 | **必须重启容器**；不重启 = 线上行为完全不变（§7）。 |

## 1. 现场数据（lead 实测，本文直接采信，不重测生产）

| 项 | 值 |
|---|---|
| 命名空间 | `erp-pos`，9467 块 |
| 后台嵌入实测 | 20 秒前进 16 块 = **0.8 块/秒**（batch=8 ⇒ 10 s/批） |
| `GET /v1/namespaces/erp-pos/status` | `rate: 10.0`、`pending: 9280`、`coverage: 0.03` |
| 运行时 | 容器 4 线程，`bge-base-zh-v1.5` fp16，ORT **1.19.2**，`providers: [CPUExecutionProvider]`，`model_bytes ≈ 203MB` |

## 2. 诊断：把一批的时间拆成「调度」+「模型」

### 2.1 代码路径（行号 = **改动前** `git show HEAD:` 的版本，便于对照）

| 位置 | 行为 | 判断 |
|---|---|---|
| `governor.py:119-139` | 主循环：`_next_namespace()` → `_tick()` → 异常兜底 | 正常 |
| `governor.py:166` | `pending(namespace, tag, self.batch, self.order)`，`batch=8`，`order='spread'`（按 hash） | 每批只取 8 块 + 批内长度随机 → 见 §2.3① |
| `governor.py:171-172` | `texts = [body...]` → `embedder.embed(texts)` | 主开销 |
| `governor.py:173` | `put_vectors(...)`（8 行 insert + commit） | 0.2–0.5 ms，可忽略 |
| `governor.py:174` | `knn.invalidate(namespace)` | 只清缓存，微秒级 |
| `governor.py:181-184` | `need = len(items)/rate`；`dt < need` 才 `sleep(need-dt)` | 10 s ≫ 0.8 s ⇒ **从不睡眠**，`rate` 形同虚设 |
| `embedder.py:104-114` | 构造期 `Tokenizer.from_file` + `make_session` **各一次**；会话/分词器实例复用 | 「每批重建 session」**不成立** |
| `embedder.py:132-167` | `embed()`：`encode_batch` **每批只调一次**，一次 `session.run` | 「重复 tokenize」**不成立** |
| `embedder.py:106-107` | `enable_truncation(512)` + `enable_padding(...)`（补到**批内最长**） | token 成本放大器 ① |
| `embedder.py:76-81` | `pick_model()` 固定优先 `model_fp16.onnx`，**与 provider 无关** | token 成本放大器 ② |
| `server.py:79-80` | `EMBED_RATE=10`、`EMBED_BATCH=8`（deploy/compose 只注入 `EMBED_RATE`，batch 用默认 8） | 配置无误 |
| `server.py:2861` | `EmbedGovernor(store, embedder, knn, EMBED_RATE, EMBED_BATCH, "spread", log)` | 装配正确 |

### 2.2 逐项排除（本机实测，`tests/bench_embed_governor.py` 实验 1、2）

合成库：9467 块 / 已嵌 284 块 / pending 9183（长度分布 120–2400 字符，接近真实 chunk）。

| 假设 | 实测（本机） | 结论 |
|---|---|---|
| `pending()` 的 `NOT EXISTS + ORDER BY hash` 慢 | limit=8：**0.30–0.38 ms**；limit=32：**0.40–0.47 ms** | 排除（`chunks_ns_hash` 索引供了排序，`vectors` 主键供了探测） |
| `put_vectors` + commit 慢 | 8 行含 commit：**0.18–0.49 ms** | 排除 |
| 锁竞争（HTTP 轮询 vs 后台线程） | 单批固定开销合计（含 repo/pending/put/knn/主循环）**0.9–1.8 ms** | 排除（占 10 s/批 的 0.02%） |
| 主循环空转 `sleep` 把速率压死 | `need=0.8 s < dt≈10 s` ⇒ 睡眠分支从不进入 | 排除（但暴露了「rate 会误导人」） |
| **模型调用** | 0.8 块/秒 ⇔ **10 s / 8 块** | **就是它** |

零模型耗时（stub）下的调度器上界：

```
batch=  8:  4674–11561 块/秒上界   每批固定开销 0.7–1.8 ms
batch= 32:  2074–20710 块/秒上界   每批固定开销 1.6–13.3 ms
```

### 2.3 模型慢的两个**代码级**放大器

**① padding 到批内最长**（`embedder.py:106-107` + `governor.py:166` 的 `order='spread'`）

`order='spread'` 按 hash 取块 ⇒ 一批 8 块的正文长度是**随机**的，而 tokenizer 把整批补齐到批内最长
序列：8 块里只要有 1 块是长块，整批 8 条都按长块付算力。用 token 成本模型（`chars/4`，≤512 截断）
在 5600 块上量：

```
窗口×批   模型调用   受 padding 影响的 token  相对理想(不补 padding)  相对旧行为
1×8        700        2 523 208               2.38x                  1.00x
3×8        700        1 483 496               1.40x                  1.70x
4×8        700        1 364 616               1.29x                  1.85x
6×8        700        1 254 496               1.18x                  2.01x
```

即：**同一个模型、同一批数据，光把「长度相近的放一批」就少算 41% 的 token（1.70×）**。
（`3×16`/`3×32` 没有额外收益 —— 收益只来自「批内长度同质」，不来自加大批。）

**② fp16 图跑 CPU EP**（`embedder.py:76-81` + 镜像选择）

`/health` 的 `providers` 只有 `CPUExecutionProvider`，`model_bytes≈203MB` 与 README「嵌入
`bge-base-zh-v1.5`（fp16，194 MB）」一致 ⇒ 线上跑的是 **fp16 图**。ORT 的 CPU EP 对 fp16
MatMul 只在特定指令集上有原生 kernel，通用 CPU 上大量算子退化成「前后插 Cast」，
**同结构同线程下比 fp32/int8 慢 5–20×**（这与 kNN 那篇笔记里「numpy fp16 matmul 比 fp32 慢 30 倍」
是同一类现象）。

交叉验证：4 线程 CPU 跑 BERT-base 级模型，batch 8 × 512 token 的合理量级是 **0.5–1 s/批**
（README 自己也测到「单条查询嵌入 26 ms（CPU）」），而线上是 **10 s/批** —— 比 fp32 的合理值低
10–20×，正好落在 fp16-on-CPU 的惩罚区间。**这条是强怀疑，需用真实模型复测确认**，本次没有改
模型选择（换精度会改 `tag`，等于全量重嵌，属 §6 的评审项），只把它做成启动告警：
`embedder.warnings()` → 日志 `警告：模型 model_fp16.onnx 是 fp16，但执行提供者只有 CPU…`
以及 `/health.model...warnings`。

## 3. 改动点（全部在 `server/code-index-service/`）

### 3.1 候选窗口 + 长度分桶（`governor.py`）

- `EmbedGovernor.__init__(..., window=3, dedupe=True, clock=time.monotonic)`
  （`governor.py:66`）：`window × batch` = 每轮候选数。
- `_plan()`（`governor.py:272`）：候选正文按长度排序，`_balanced_groups(order, batch)`
  （`governor.py:45`）切成**尽量等大**的子批（不足批就一个批）。为什么等大：25 个按 8 切尾批只剩
  1 个（8,8,8,1），GEMM 批量优势丢掉；等大（7,6,6,6）多一次调用但总 token 更省。
- `_tick()`（`governor.py:296`，取块在 `:307`）：一次 `pending(limit=batch*window)`，逐子批 `embed`，
  向量散播回每个 hash，**一次 `put_vectors` + 一次 `knn.invalidate`**（子批不额外碰 DB）。
- `server.py:84`：`EMBED_WINDOW`（默认 3）；`server.py:2880` 传入。
  `EMBED_WINDOW=1` 即回到改动前的「取多少嵌多少」节拍。

### 3.2 同批正文去重（`governor.py` `_plan`）

代码库里「复制粘贴的样板块」很常见，逐块送模型是纯浪费。同一轮候选里正文完全相同的只算一次，
向量散播给所有 hash（`dedupe=True`，`server.py:86` `EMBED_DEDUPE`）。去重只在**当前这一轮**内
生效（不跨轮缓存、无内存增长、无失效问题）。

### 3.3 限速：截止时间分片等待（`governor.py:342` `_throttle`）

旧写法「算完 `sleep(need - dt)` 到底」有两个毛病：`dt` 已经超过 `need` 时完全不睡（rate 不生效，
本次现场就是这种情形）；`rate` 低时一次睡很久，`pause()` / `set_rate()` / `stop()` 要等睡完
（如 `rate=0.5`、`batch=64` 时是 **128 s**）。改为：

- 目标时刻 = `t_start + chunks/rate`，**每轮重算剩余时间** → `set_rate` 立即反映；
- 每片最多等 `50 ms`（`THROTTLE_SLICE`）→ `pause/set_rate/stop` **≤50 ms 生效**；
- `pause()` / `set_rate()` / `set_batch()` 都 `_wake.set()`，把等待线程立刻叫醒；
- 子批之间检查 `paused/stopping`（`governor.py:316-318`）：一轮有 3 个子批时，
  热切换的 `wait_idle()` 只需等**当前子批**，不会被整轮 3 批拖到超时。
- `rate=0` 仍表示不限速（语义不变）。

### 3.4 运行时可调批大小（`governor.py:108` + `server.py:4351-4356`）

`POST /v1/admin/rate` 的 `rate` 语义不变；**新增可选** `batch` / `window`：

```bash
curl -X POST .../v1/admin/rate -d '{"rate": 10}'                    # 老用法，行为不变
curl -X POST .../v1/admin/rate -d '{"window": 6}'                    # 只调窗口（更省 token）
curl -X POST .../v1/admin/rate -d '{"batch": 16, "window": 3}'       # 调模型批大小
```

`/health.governor` 与 `governor.status()` 增加 `window`（新增字段，老字段不动）。
`window` 被 `governor.MAX_WINDOW`（64）夹住，避免 `EMBED_WINDOW` 传离谱值时一次读几万条正文。

### 3.5 `status` 新增 `speed` / `etaSeconds`（`governor.py:194`）

`GET /v1/namespaces/{ns}/status` 是 `repo_status()`（`server.py:3130`）里
`out.update(governor.status(namespace))`（`server.py:3153`），所以新字段直接出现在该响应顶层：

| 字段 | 含义 | 边界 |
|---|---|---|
| `speed` | 该命名空间的**实测**吞吐（块/秒，30 s 滑动窗口：窗口内完成的块数 ÷ 窗口覆盖时间） | 暂停 / 窗口内无样本 → `0.0`；只有一两批时用最小分母 1 s，避免「1 ms 嵌 8 块」算出 8000 块/秒；积压清完后样本随窗口（30 s）自然衰减到 0 |
| `etaSeconds` | `pending / speed`（秒，1 位小数） | `speed <= 0` → `null`；`pending = 0` → `0.0` |
| `rate` / `paused` / `coverage` / `pending` | **原义不变**（`rate` 仍是配置上限，`pending` 仍来自 `store.pending_count()`） | — |

顺带：`/v1/admin/stats/summary` 的 `runtime` 也加了 `speed`（`server.py:3698`，新增字段，
`etaSeconds` 在那个接口仍按配置 rate 估算，语义未动）。

## 4. 实验数据（本机，合成库 9467 块 + stub embedder）

### 4.1 每批固定开销 → 反推模型耗时

```
模型    100 ms/批 →  78.6 块/秒（固定开销占比 1.8%）
模型   1000 ms/批 →   8.0 块/秒（0.2%）
模型   5000 ms/批 →   1.6 块/秒（0.0%）
模型  10000 ms/批 →   0.8 块/秒（0.0%）   ← 与线上实测 0.8 块/秒 完全吻合
```

### 4.2 padding（token 成本模型，见 §2.3①）

见上面的表：`1×8` = 2.38× 理想；`3×8` = 1.40×（**1.70×** 提速）；`4×8` = 1.85×；`6×8` = 2.01×。

### 4.3 端到端预估（虚拟时钟跑**真实 governor**）

方法：模型耗时 = `padding 后 token 数 × k`，`k` 用线上实测标定（首个 batch=8 的 padding token =
4096，10 s/批 ⇒ 2.441 ms/token）；DB 用真实 `IndexStore`（9467 块），时钟是虚拟的，所以不受本机
CPU 快慢影响。跑完整 9183 个 pending：

| 配置 | 轮数 | 模型调用 | padding token | 预估块/秒 | 相对旧 |
|---|---|---|---|---|---|
| `window=1`（旧行为） | 1148 | 1148 | 4 081 256 | **0.92** | 1.00× |
| `window=3`（新默认） | 383 | 1148 | 2 424 776 | **1.55** | 1.68× |
| `window=4` | 287 | 1148 | 2 225 552 | **1.69** | 1.83× |
| `window=6` | 192 | 1148 | 2 049 544 | **1.84** | 1.99× |

旧行为的模型预估是 0.92，比线上实测 0.8 高约 15%（标定用的首批全是长块，平均批短一点），
所以下表按「实测 0.8 = 基线」等比缩放。

### 4.4 正文去重收益（20% 的块是重复正文）

| 配置 | 模型调用 | padding token | 预估块/秒 |
|---|---|---|---|
| `dedupe=off` | 1148 | 2 333 872 | 1.61 |
| `dedupe=on` | 1148 | 1 985 436 | 1.89 |

去重单独 **1.18×**（重复率 20%）；`window=3 + dedupe` 合计 **1.96×**。

## 5. 改动前 / 改动后 预估吞吐

以线上实测 **0.8 块/秒** 为基线，按 §4.3–4.4 的比例外推（都是「模型成本 ∝ padding token」的
线性模型，误差 ±15–20%）：

| 场景 | 改动前（实测） | 改动后（预估） | 9280 pending 的 ETA |
|---|---|---|---|
| 仅长度分桶（`EMBED_WINDOW=3`） | 0.8 块/秒 | **≈1.4 块/秒** | 3.2 h → **1.8 h** |
| 分桶 + 去重（默认配置，重复正文 20%） | 0.8 块/秒 | **≈1.6–1.8 块/秒** | 3.2 h → **1.5 h** |
| 再加 `window=6`（`POST /v1/admin/rate {"window":6}`） | 0.8 块/秒 | **≈1.6–1.9 块/秒** | 3.2 h → **1.4 h** |

**不要指望**改这里就能到 `rate=10`：现在 `rate` 根本不是约束（模型 10 s/批 ≈ 0.8 块/秒）。
`POST /v1/admin/rate {"rate": 100}` **不会**变快，只会让 `status.rate` 这个数字更离谱 ——
真正卡住吞吐的是「每块多少 token」×「每 token 多少秒」，见 §6。

## 6. 要真正接近 `rate=10` 还差什么（**未做，需评审**）

1. **别在 CPU 上跑 fp16 图**：换 `model.onnx`（fp32）或 int8 —— 预期 **5–20×**，但 `tag` 会变
   （`bge-base-zh-v1.5-<fp>-fp16` → `-fp32`/`-int8`）⇒ **全部命名空间重新嵌入**，
   且插件侧 `embedding_tag` 也要跟着换。这是本次最大的一根杠杆，但属于「改语义 + 重嵌」，
   必须产品/运维确认后单独做（可先只对 erp-pos 试点）。
2. **上 GPU**：`latest-gpu` 镜像 + `deploy.resources.reservations.devices`（README「GPU 的前置与
   降级行为」）；P4 上历史实测 batch32 ≈ 25.6 块/秒，是当前 CPU 的 ~30×。
3. **ORT 会话参数**（未改，收益小、需实测）：cgroup 配额 4 线程与 `ORT_THREADS` 对齐（`/health`
   现在报 `threads: 4`，已经对齐）；`session.intra_op.allow_spinning=0` 在配额受限容器里通常能省
   5–10% 的 CPU 时间片。
4. **多 session 并行**：CPU 上 `<20%` 收益、内存翻倍（203 MB × N），不建议。
5. 长度分桶还能再进一步（`window=6` → 2.01×），但一轮 6 个子批会让 pause/ETA 的粒度变粗；
   `window=3/4` 是折中，运行时可用 `POST /v1/admin/rate {"window": 4}` 试。

## 7. 生效方式：**必须重启容器**

- 本次**只改了代码**，没有重启、没有部署：线上 192.168.50.112 的进程还在跑旧代码，
  **现在去测仍然是 0.8 块/秒**，`status` 也还没有 `speed`。
- 生效步骤（运维另行执行，不在本次范围内）：
  1. 用新代码重建/更新镜像（或按部署方式挂载代码目录）；
  2. 重启容器（`docker restart dsh-embed` 或 compose 重建）；
  3. 看启动日志应出现
     `index store ready: db=... rate=10.0/s batch=8 window=3 dedupe=True ...`，
     若仍跑 fp16 模型还会多一行
     `警告：模型 model_fp16.onnx 是 fp16，但执行提供者只有 CPU…`；
  4. `curl -s .../v1/namespaces/erp-pos/status` 应出现 `speed`（≈0.8 起步，随窗口爬升）与
     `etaSeconds`；`GET /health` 的 `governor` 里多一个 `window`。
- **不需要重建索引**：向量格式、`tag` 算法、`order='spread'` 的覆盖语义、`rate/paused/coverage/pending`
  的语义都没变，已嵌入的向量继续有效；新代码只是在取块与限速上换了实现。
- **回滚**：容器加 `EMBED_WINDOW=1 EMBED_DEDUPE=0` 即回到改动前的取块节奏；或回退代码。

## 8. 验证（本机，全部通过）

| 命令 | 结果 |
|---|---|
| `python tests/test_embed_throughput.py` | **53 项检查 / 0 失败**（batch 调度、去重、限速与打断、speed 窗口、eta 边界、既有字段语义、status JSON 可序列化、空命名空间出队） |
| `python tests/test_bodies.py` | 31 通过 / 0 失败（既有用例回归） |
| `python tests/selftest.py` | **274 通过 / 0 失败**（`FAKE_EMBED=1` 起真服务，接口语义回归，含 pause/rate/hot-swap） |
| `python tests/bench_embed_governor.py` | 本文全部数字 |
| `python -c "import ast; ast.parse(open('server.py',encoding='utf-8').read())"` | 通过 |

测试不依赖 onnxruntime / tokenizers / 真实模型：`tests/test_embed_throughput.py` 用
`FakeStore + StubEmbedder + 可注入时钟`，`tests/bench_embed_governor.py` 用合成 `IndexStore`
（只依赖 numpy/sqlite3）。
