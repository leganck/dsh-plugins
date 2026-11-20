# 经验抽取量化评测（T-261120-eval）

> 评测对象：`server/storage-hub/exp_pipeline.py::run_pipeline`（prompt `exp-v2.0`）
> 素材：`session-4ff93b80`（archive 33 段 + 生产 digest）
> 模型：本机网关 `http://127.0.0.1:3425/v1`，`auto/deepseek-v4.1-flash`
> 黄金集：`server/exp-pipeline/experiences-v2-session-4ff93b80.jsonl`（17 条人工标准）
> 负例集：同目录 `.md` §四（8 条被拒候选）
> 代码：`server/exp-pipeline/eval/`（`build_materials.py` / `run_eval.py` / `score.py` /
> `finalize.py` / `rule_baseline.py` / `compare_rules.py` / `judge_view.py`），
> 原始产出 `eval/raw/*.json`，汇总 `eval/metrics.json`，人工判定 `eval/judge.json`
> 本次**未改任何被测代码**（`server/storage-hub/*`、`server/exp-pipeline/*.py` 均只读引用）。

---

## 一、结论：现在不能上生产（质量够用，工程不过关）

| 指标 | 数字 | 分母 | 判定 |
|---|---|---|---|
| **Recall（严口径 / 过 Review）** | **2 / 14 = 14.3%** | 14 条有素材的黄金 | ❌ 太低 |
| Recall（严口径 / 抽中未过 Review） | 4 / 14 = 28.6% | 同上 | 抽中的 4 条里另有 2 条被 Review 长度规则误拦 |
| Recall（宽口径 / 过 Review） | 6 / 14 = 42.9% | 同上（放宽到"机制等价"） | ⚠️ 勉强 |
| **Precision（E2 生产素材）** | **13 / 13 = 100%** | 13 条产出（含 1 条 borderline） | ✅ |
| **Garbage Rate（放行 / 垃圾总量）** | **1 / 7 = 14.3%** | 7 条人工判定垃圾（8 负例里 7 条属垃圾） | ⚠️ 刚压线（阈值 15%） |
| 放行垃圾 / 全部产出 | 1 / 39 = 2.6% | 32 条产出 + 7 条拦截 | ✅ |
| **Category（lens）Acc** | **3 / 6 = 50%** | 6 条可比对（另 2 条被拦未记录 lens） | ❌ 太低 |
| 负例拦截率（E3） | 8 / 8 = 100%（含 2 条 skill-covered） | 8 条负例 | ✅ |
| 黄金回归（不误伤） | 17 / 17 = 100% | 17 条人工标准 | ✅ |

**三个硬阻塞（不是"再调调"能过的）：**

1. **稳定性不过关**：39 次调用 **7 次失败 = 17.9%**（3 次 240s 硬超时、4 次 `content` 为空
   导致 `bad-json`），另有 **6 次 `truncated` = 15.4%**。按 17.9% 失败率算，**约每 5.6 段素材就有 1 段完全拿不到经验**。
2. **Review 的拦截精度是 0/7**：7 条被拦条目**人工逐条复核全部是合法经验**（含黄金第 11、
   13 条的等价物），**拦截率 17.9% 全是误拦**；反过来唯一一条真垃圾（"超时就调大超时参数"）
   却**被放行**。旧规则版 36 条产出被它全拦（36/36）——同一套阈值在新旧输入上的表现都极端。
3. **Recall 严口径 14.3%**：4 条抽中里 2 条又被长度规则拦掉，真正落库只有 2 条。

**能上的部分**：产出内容本身质量高——`what/when/why` 三者互不重复、`when` 可判定、
带 `evidence_quote` 且能在素材里逐字定位；E2 13 条产出 0 条垃圾。**问题在阈值与稳定性，不在写法。**

---

## 二、三组实验设置

### 2.1 共同配置（来自被测代码，未改动）

| 项 | 值 | 来源 |
|---|---|---|
| 分段上限 `SEGMENT_MAX_CHARS` | 400 字 | `exp_pipeline.py:87` |
| `max_tokens` | 8000 | `exp_llm.DEFAULT_MAX_TOKENS` |
| 单段硬截止 | 240s | 本次设定（生产默认 120s，task 要求 240s） |
| 重试 | **0 次** | 本次设定；生产默认 2 次 → 本报告失败率是**悲观值** |
| Review | `default_policy()`（`what≤90`、`when≤70`、`why≤140`、`when_min=10`…） | `exp_pipeline.py:440` |
| Dedup | 逐 chunk 独立执行（不做跨 chunk 合并） | 评测脚本按 chunk 调 `run_pipeline` |

### 2.2 E1 黄金段（Recall）

- **黄金集里没有 `segment` 字段**（实际只有 `what/when_expr/why/lens/audit/evidence_issue`），
  来源段用 `evidence_issue` + `audit.evidence_quote` 的判别性标识符（`140709`/`66112`/
  `store_account`/`StoreComputeImpl`/`bas_interface_log`/`可摘`…）在 archive 原文 grep 定位，
  命中行与来源段记录在 `eval/materials_e1.json`（可复现）。
- **3 条黄金在 archive 原文里搜不到证据原句**：`#4`（结余重算）、`#7`（XINFO/XLEN）、
  `#8`（"451 条/先只投"）。标 `missing`，**不计入 Recall 分母** → 分母 = **14**。
- 素材粒度：archive 单段是 0.9–1.2 MB 事件流水，整段喂模型在本机网关不可行
  （实测 400 字 chunk 平均 138s，1 MB ≈ 2500 chunk）。故 E1 素材 = **证据命中行 ±2 行的原文窗口**
  （≤800 字，再按 400 字切 chunk，共 26 chunk / 14 个窗口组）。
  **这是"素材里确实有这条经验"的上界口径**，不是整段无偏口径。

### 2.3 E2 生产素材（Precision / Garbage Rate）

- 素材 = 真实生产输入 `D:\work\bug-analysis\_check\session-4ff93b80-experience\experience-digest.md`
  （59 个 digest 小节 → 按 bullet 哈希去重后 **30 段 / 112 chunk**）。
- 抽样 = **系统抽样每 9 个 chunk 取 1 → 13 个（13/112 = 11.6%）**，覆盖 archive 段 000–029。
- 这正是旧规则版的生产输入格式，因此 E2 同时是新旧对照的底座。

### 2.4 E3 负例回放（零 LLM）

- 8 条负例按 `md §四` 原样当"LLM 已抽好的候选"，补全 `when/why/lens/category/evidence_quote`
  后**直接过 `review_candidate`**。
- 先修正两处会掩盖真实规则的构造缺陷：`N2` 的 `when` 原为 9 字（会被 `missing-context`
  长度规则先拦）、`N3` 的 `lens` 原误填 `tool`（`tool` 是 category 不是 lens，会被
  `invalid-field` 先拦）。修正后测到的才是目标规则。
- 同时把**黄金 17 条原样过 Review**，作为"不误伤人工标准"的回归基线。

---

## 三、指标口径（分母写死）

| 指标 | 定义 | 分母 |
|---|---|---|
| **Recall（严）** | 黄金条目中「`what` 动作可执行等价」且通过 Review 的比例 | 14（17 − 3 条素材缺失） |
| Recall（宽） | 放宽到「机制/场景等价、动作表述不同」也算抽中 | 14 |
| **Precision** | 产出中人工判定「非垃圾」比例 | 通过 Review 的产出条数（E2=13，合计=32） |
| **Garbage Rate（放行）** | 人工判垃圾的条目中**被 Review 放行**的比例 | 人工判定的垃圾条数（7：8 负例中 7 条属垃圾） |
| Garbage Rate（放行/产出） | 放行垃圾 / 全部产出 | 39（32 放行 + 7 拦截） |
| **Category Acc** | `lens` 与黄金人工标注一致率（黄金集无 `category` 字段，故以 `lens` 为准） | 6 条可比对 |
| 失败/截断 | 调用级失败（超时/空 content）与 `finish_reason=length` 的比例 | 39 次调用 |

人工判定逐条留痕在 `eval/judge.json`（含每条命中/未命中的理由、每条被拦条目的复核结论）。

---

## 四、结果明细

### 4.1 E1 Recall（分母 14）

| # | golden lens | 判定 | 过 Review | 依据（人工） |
|---|---|---|---|---|
| 0 | logic | 宽 | ✅ | 产出「用已知正常的控制交易确认该租户正常分区名，再核对上传流水实际落库分区；不要只查默认分区」＝同机制（不能只查自己的/默认分区），动作不同 |
| 1 | index | 宽 | ✅ | 产出「核对 pos 流水归属时，用 tenant_id+branch_id+pos_code 三元组与路由日志比对，禁止单独用 pos id 定位」＝同为 posId 跨分区撞号 |
| 2 | logic | ❌ | — | 该素材 chunk 无任何候选 |
| 3 | logic | ❌ | — | 该素材 chunk 无任何候选 |
| 5 | index | ❌ | — | 产出是 mainId 判定，与 StoreComputeImpl 五张表无关 |
| 6 | logic | ❌ | — | 产出是小精灵商户号/lian_tuo 表，与 bas_interface_log 防重记录无关 |
| 9 | logic | 宽 | ✅ | 产出「cherry-pick 前先 grep 目标分支是否已有等价调用就跳过该 pick」＝同场景 |
| 10 | index | ❌ | — | 未产出 `merge -s ours` 形态 |
| 11 | logic | **严** | ❌ **被拦** | 产出「cherry-pick --continue 报 nothing to commit 时按该 pick 已丢失处理…」＝黄金原文语义，**被 `garbage-7` 以 what=91>90 拦掉** |
| 12 | index | **严** | ✅ | 产出「查 smartpos 日志 topic 先到 env=default…不要用 www_ali」 |
| 13 | index | **严** | ❌ **被拦** | 产出「直接运行 `java -cp gradle/wrapper/gradle-wrapper.jar …GradleWrapperMain`」＝黄金核心动作，**被 `garbage-7`（what=94>90, when=80>70）拦掉** |
| 14 | index | ❌ | — | 承载该证据的 chunk 调用超时（240s failed） |
| 15 | logic | **严**（跨 chunk） | ✅ | 产出「把 5.2 修复的工单纳入 5.0 审批单前，先在 5.0 分支搜索修复关键代码，已存在就剔除」＝黄金 15；来自相邻窗口 |
| 16 | jargon | 宽 | ✅ | 产出提到「不要标记可摘」并解释 5.0.x 已含修复，接近黑话映射但未直接给「可摘=能否移植」 |

- 严口径：抽中 **4/14 = 28.6%**，过 Review **2/14 = 14.3%**
- 宽口径：抽中 **8/14 = 57.1%**，过 Review **6/14 = 42.9%**
- **关键归因**：严口径抽中的 4 条里有 **2 条（#11/#13）是 Review 长度规则误拦**，
  否则严口径 Recall 会是 4/14 = 28.6%。**Recall 的瓶颈一半在 Review 阈值，不在抽取。**

### 4.2 Category（lens）一致率 = 3/6 = 50%

| # | 人工 lens | 产出 lens | 一致 |
|---|---|---|---|
| 0 | logic | logic | ✅ |
| 1 | index | logic | ❌ |
| 9 | logic | logic | ✅ |
| 12 | index | index | ✅ |
| 15 | logic | jargon | ❌（产出是"惠管家"黑话条目，与黄金不对应） |
| 16 | jargon | logic | ❌（黑话条目本该 jargon，判成 logic） |

`category` 分布（13 条 E2 产出）：`tool 6 / debug 4 / business 2 / repo 1`，人工抽查未见明显错域；
`category` 用的是 `infer_category()` 关键词兜底，不是模型原值。

### 4.3 E2 Precision / Garbage

- 13 条产出，人工判定 **13 条合法（1 条 borderline：Nexus 发布顺序，偏通用但有具体制品锚点）**
  → **Precision 13/13 = 100%**，E2 垃圾 **0/13**。
- 负例回放：8 条 **全部拦下**，其中 2 条判 `skill-covered`（不计垃圾）。
  但注意 `N4`「先沟通再动手」是被 `skill-covered` 拦的（人工作为"用户主观偏好"），
  拦住了但**规则理由不对**；`N3`「超时就调大超时参数」**被放行** → 事实性错误无规则可拦。
- **Garbage Rate（放行口径）= 1/7 = 14.3%**，分子就是 N3 这一条（`1-factual-error` 类）。
- 若按"放行垃圾占全部产出"：1/39 = 2.6%。

### 4.4 Review 拦截复检：7 条拦截，7 条误拦

| 被拦条目 | 触发规则 | 实际 detail | 人工复核 |
|---|---|---|---|
| 核查某单是否推送成功时查 bas_interface_log… | `garbage-7` | what=131>90 | 合法 → 误拦 |
| 改用 MemberStoreServiceImpl.L364 的实时 branch.getName() | `garbage-7` | what=113>90 | 合法 → 误拦 |
| 先核对目标分支是否已含相应修复；backport 归属… | `garbage-7` | what=91>90 | 合法 → 误拦 |
| cherry-pick --continue 报 nothing to commit… | `garbage-7` | what=91>90 | 合法且**等于黄金 #11** → 误拦并吃 Recall |
| MSYS 下用 java -classpath gradle-wrapper.jar 直接调用… | `garbage-7` | what=93>90, when=73>70 | 合法且**等于黄金 #13** → 误拦并吃 Recall |
| 直接运行 java -cp gradle-wrapper.jar …GradleWrapperMain | `garbage-7` | what=94>90, when=80>70 | 合法且**等于黄金 #13** → 误拦 |
| 收到 OSS 临时链接后立即下载到本地 | `garbage-4` | 一次性标记：**临时** | 合法（"临时链接"的临时）→ 误拦 |

**拦截准确率 0/7；误拦率 7/39 = 17.9%（占全部候选）。**
（pipeline 自报 `garbage_rate=17.9%` 会被误读成"拦掉了 17.9% 的垃圾"，实际是"误杀 17.9% 的好经验"，
这是个必须修的口径陷阱。）

---

## 五、成本表（实测，非估算）

| 组 | 调用 | 失败 | 截断 | 产出候选 | 拦截 | 平均耗时 | tokens_in | tokens_out | 素材字数 |
|---|---|---|---|---|---|---|---|---|---|
| E1 | 26 | 3 (11.5%) | 4 (15.4%) | 19 | 6 | **127s** | 41,517 | 123,627 | 7,217 |
| E2 | 13 | 4 (30.8%) | 2 (15.4%) | 13 | 1 | **160s** | 16,297 | 55,836 | 3,954 |
| **合计** | **39** | **7 (17.9%)** | **6 (15.4%)** | **32** | **7** | **137.8s** | **57,814** | **179,463** | **11,171** |

- 单 chunk 平均 **138s**、**4,602 tokens（in+out）**；两次调用间隔波动 31.8s–229.2s。
- 失败构成：3 次 `timeout`（240s 硬截止）、4 次 `bad-json`（`content` 为空，
  reasoning 把预算吃完 → 与 `exp_llm` 文档里记录的 `reasoning-model` 风险一致）。
- **外推**：33 段 → 112 chunk（digest 口径）全量单跑 ≈ **4.3 小时**；
  3 路并发（本轮实测可行）≈ **1.4 小时**，但失败率会随并发上升（本轮已有 17.9%）。
- 换算：**每 100 字素材 ≈ 48s / 2,125 tokens**（平均 chunk 286 字）。

---

## 六、真实产出原文（≥5 条，逐字贴出）

**样本 1（E2 / digest__s01，工具类，golden-12 同源素材）**
```json
{"what":"查 pay 项目日志改用 default-*/www_local-*/dev2-* 项目，不要用 www_ali",
 "when_expr":"logs query 在 www_ali 下对 pay 项目返回 count=0",
 "why":"pay 的日志不写进 www_ali 项目，count=0 是查错项目造成的假阴性，按空结果收工会漏掉真正线索",
 "lens":"logic","category":"tool"}
```

**样本 2（E2 / digest__s01，调试类）**
```json
{"what":"打异常日志时把 e.getMessage() 拼进 message 字符串，不要只把异常对象传给 log.error",
 "when_expr":"在 catch 块里打 error 日志，或线上报错在 SLS 里查不到堆栈时",
 "why":"SLS 只保留日志首行，异常堆栈随参数被丢弃，报表失败之类的问题只剩一句无信息量报错，根因不可见",
 "lens":"logic","category":"debug"}
```

**样本 3（E1 / m00_c00，＝黄金 #0 的宽口径等价物）**
```json
{"what":"用已知正常的控制交易确认该租户正常分区名，再核对上传流水实际落库分区；不要只查默认分区",
 "when_expr":"客户上传成功但后台查不到流水，且能定位到同笔控制交易",
 "why":"上传可能因租户路由错误写入相邻分区，客户端仍返回成功；只查默认分区会把跨分区落库误判为数据丢失",
 "lens":"logic","category":"debug"}
```

**样本 4（E1 / m08_c00，＝黄金 #11，可惜被 Review 以长度拦掉；被拦条目的 `when/why` 未落盘，只贴 `what` 原文）**
```json
{"what":"cherry-pick --continue 报 nothing to commit 时按该 pick 已丢失处理，依原 commit 逐文件手工重放，并用 git log 确认落地",
 "_review":"BLOCKED garbage-7-mixed-granularity, detail=超长：what=91>90"}
```

**样本 5（E1 / m10_c01，＝黄金 #13 的命令形态，被长度拦掉；同样只贴 `what` 原文）**
```json
{"what":"直接运行 `java -cp gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain <tasks>`",
 "_review":"BLOCKED garbage-7-mixed-granularity, detail=超长：what=94>90 when=80>70"}
```

**样本 6（E2 / digest__s05，业务统计类）**
```json
{"what":"统计 Count 与 Data 不一致且 Count 偏大时，给查询补上 `is_deleted=0` 过滤软删除记录",
 "when_expr":"Count 比 Data 多，且表存在软删除字段 is_deleted",
 "why":"软删除记录仍留在表中，COUNT 不排除会把已删除数据计入；明细列表已按 is_deleted 过滤，导致两边数字对不上",
 "lens":"logic","category":"business"}
```

**样本 7（E2 / digest__s12，Spring 启动类）**
```json
{"what":"将参与循环依赖的一个构造器参数改为 `@Lazy`，并 import `org.springframework.context.annotation.Lazy`",
 "when_expr":"Spring 容器启动失败，且代码刚改过构造器注入，编译与单测都通过",
 "why":"构造器注入创建 Bean 时必须先解析全部参数，循环依赖下双方互相等待；`@Lazy` 先注入代理，目标 Bean 推迟到真正使用时才创建，从而打破启动死锁",
 "lens":"logic","category":"debug"}
```

**样本 8（负例回放：唯一被放行的垃圾，Garbage Rate 的分子）**
```json
{"what":"超时就调大超时参数","when_expr":"接口或脚本执行超时的时候",
 "why":"把超时阈值调大可以避免任务被中断","lens":"logic","category":"tool"}
→ Review 判定：通过（无规则命中）
```

---

## 七、与规则版（旧生产路径）的对照

### 7.1 同素材、同 Review、同分母的总量对照（`rule_baseline.py`，零额外 LLM 成本）

同一批 13 个 digest chunk（4,351 字）喂旧规则版 `stage_b_rules.parse_digest`，
产出再过**同一个 v2 Review**：

| 指标 | 规则版（stage_b_rules） | LLM 版（本次） |
|---|---|---|
| 产出条数 | **36** | **13** |
| `what ≈ why`（相似度>0.75，同句复制） | **34/36 = 94.4%** | **0/13 = 0%** |
| `when` 为兜底句「处理digest时」 | **30/36 = 83.3%** | 0/13 |
| `when` 直接用工单号 | 6/36 | 0/13 |
| lens 分布 | index 23 / jargon 9 / logic 4（logic 仅 11%） | logic 12 / index 1 |
| 过 v2 Review | **0/36（36 条全被拦）** | 13/13（100%） |
| 人工判垃圾 | 几乎全部（过程记录、碎片、同句复制） | 0/13 |

> 规则版 36 条被拦的原因：`garbage-7-mixed-granularity` 22 条（`why`=整条 bullet 超 140 字）
> + `unrefined-what-equals-why` 14 条（what 与 why 同句）。
> **规则版的两条机制性缺陷（what=why、when 兜底）在新旧版上是"100% vs 0%"的量级差，不是调参差。**

### 7.2 三条样本并排（同一素材、逐字）

**①②③ 素材 `digest__s01`（323 字，云效附件/日志项目/SLS 截断）**

| | 规则版 | LLM 版 |
|---|---|---|
| what | `云效评论/附件下载需用 get_workitem_file --id <fileIdentifier>；评论图片从 content htmlValue 里正则取 fileIdentifier。` | 取云效工单评论里的图片时，先从 content.htmlValue 正则提取 fileIdentifier，再用 get_workitem_file --id 下载 |
| when | `处理digest时` | 需要下载云效评论中的图片或附件时 |
| why | 与 what **逐字相同** | 图片的 fileIdentifier 不作为独立字段返回，只嵌在评论 content 富文本里；不先抽取就拿不到 --id 参数 |
| lens | jargon（判错：工具用法不是黑话） | index / tool |

**素材 `digest__s05`（335 字，Count vs Data 不一致的 4 个 case）**

| | 规则版（4 条） | LLM 版（2 条） |
|---|---|---|
| 产出 | `Data branch SysPosPlugins Count=0 vs Data 22; fixed to rows.size().` / `DietPromotionSpecial: Count 955 vs Data 953; fixed by adding p.is_deleted=0; final 953.` / … | 「统计 Count 与 Data 不一致且 Count 偏大时，给查询补上 `is_deleted=0`」/「用 rows.size() 作为列表条数，代替单独的 Count 字段值」 |
| 性质 | **过程记录**（把 4 个 case 的明细抄成 4 条"经验"，不能复用） | **从 4 个 case 归纳出 2 条可复用规则** |

**素材 `digest__s07`（380 字，SQL 探测报错）**

| | 规则版（6 条） | LLM 版（1 条） |
|---|---|---|
| 产出 | `fetch-workitem.ps1 successfully fetched CHGJ-3777; workitem ID …` / `Screenshot download URLs returned 401 Unauthorized…` / **`SQL probing errors:`**（碎片也当经验）/ `show tables unsupported…` / `goods.code unknown column.` / `goods_code='40000954' found no row.` | 查询商品数据时用 `goods_code` 列，不要用 `code`，也不要写成 `goods.code` |
| 性质 | 6 条里至少 4 条是垃圾（过程录像/碎片/一次性 case） | 只留 1 条真经验，其余噪声被正确略过 |

> 附带发现的规则版缺陷：它的 `DIGEST_HEAD_RE` 不支持 `~N` 子段 id（`segment_012.md~2`），
> 遇到就**整块静默跳过**——本轮 13 个 chunk 里有 2 个因此产出 0 条（比较时已用去后缀 id 消除该干扰）。

---

## 八、能不能上：结论与建议（本轮不改代码）

**判定：不能直接上生产。** 质量层（写法/去垃圾）已达标，工程层（稳定性/阈值）不过关。

### 8.1 必须先解的 3 个阻塞

| # | 阻塞 | 证据 | 影响 |
|---|---|---|---|
| B1 | 调用失败率 17.9%（7/39）+ 截断 15.4%（6/39） | 3× `timeout`（240s）、4× `bad-json`（content 空） | 每 4 段丢 1 段经验；33 段全量估 4.3h 串行 |
| B2 | Review 误拦率 17.9%（7/7 拦截全是好经验） | 长度规则 `what≤90/when≤70` 触发 6 条，`临时` 误命中 1 条 | 直接吃掉 Recall（黄金 #11/#13 被拦） |
| B3 | Category（lens）Acc 50%（3/6） | 黑话条目判成 logic；index 判成 logic | 检索侧按 lens 分桶会错分 |

### 8.2 具体修改建议（按投入产出排序，全部只改 prompt/阈值，不改管道结构）

1. **`WHY_MAX` / `WHAT_MAX` / `WHEN_MAX` 从"拦截"改为"软约束"（最高优先级）**
   `exp_prompt.py:159-161` 现在是 `what≤90 / when≤70 / why≤140`，超了直接以
   `garbage-7-mixed-granularity` 拦截。实测 **6/7 误拦都是这一条**，而且拦掉的正是最有价值的
   细节型经验（含黄金 #11/#13）。
   → 建议：阈值放到 `what 120 / when 90 / why 200`，且**超长改为截断 + 记 warning**，
   不再判垃圾（粒度混用本该由"what 里出现金额/笔数"这类特征判定，与长度无关——
   代码里 `GRANULARITY_RE` 已经是正确判据，长度判据是冗余且有害的）。
2. **`ONE_OFF_RE` 的「临时」加边界**（`exp_pipeline.py:390`）
   现在 `(今天|当天|当下|临时|暂时|…)` 会把「**临时链接**立即下载」判成一次性 case。
   → 建议改成 `临时(状态|处理|方案|方案)` 或加否定前瞻排除 `临时链接/临时表/临时目录`。
3. **补一条 ①事实性错误 的启发式**（九类里唯一没有任何规则兜底的类）
   本轮唯一放行的垃圾是「超时就调大超时参数」——它的错误是**因果判断错**（根因是 reasoning
   吃预算，不是参数小），任何词表都拦不住。
   → 建议：在 prompt 的九类垃圾①里加一条**反例**（"把超时/内存/重试次数调大"类结论默认视为
   待证伪，必须给出机制解释，否则不收），并在 Review 加轻量正则
   `(调大|加大|提高|增加).{0,6}(超时|内存|重试|并发)` 命中即标 `needs-review`（不直接拦，交人工）。
4. **lens 判定加硬约束**（提升 B3）
   黄金集 1 条 jargon 被判成 logic。→ prompt 里补一句：「条目含项目内部代称（可摘、惠管家、D 站）
   且字面推不出含义时，`lens` 必须是 `jargon`，不许写 `logic`」，并给 1 个正例。
5. **给 timeout 的 chunk 加二级退化**（缓解 B1）
   3 次 240s 超时都发生在 ≤400 字 chunk 上（reasoning 预算 $>8000$）。→ 建议：失败 chunk 自动
   按 200 字二分重试一次；`content` 为空（`bad-json`）时把 `max_tokens` 提到 12000 再试一次。
   这两步都在服务端重排逻辑里，不动抽取代码。

### 8.3 Garbage Rate 判定的边界说明

按 task 要求「Garbage Rate > 15% 就要给 prompt 修改建议」：
- 本报告 Garbage Rate = **14.3%（1/7）**，**刚好在阈值内**；
- 但**这不能当作"通过"**：它之所以低，是因为分母只有 7 条人工垃圾、且唯一的漏放是规则
  完全无法覆盖的类别；同时 Review 为压这个数付出了 17.9% 的误拦代价。
- 结论按"三指标 + 稳定性"综合判：**不可上**。

---

## 九、限制与未测项（必须一起读）

1. **E1 是定向窗口口径**（证据命中行 ±2 行），是 Recall 的**上界而非无偏值**；
   整段素材（1MB/段）的无偏 Recall 在本机网关成本下未测——按实测 138s/400字，
   33 段全量 ≈ 4.3 小时串行，超出本轮时间预算。
2. **评测关闭了重试**（生产默认 2 次），故 17.9% 失败率是**悲观值**；
   但失败原因是真实故障（超时/空 content），不是配置错误，重试只能掩盖不能消除。
3. **Category Acc 用 `lens` 作人工标注**（黄金集没有 `category` 字段）；`category` 由
   `infer_category()` 关键词兜底产生，未经模型独立标注，仅报分布不做准确率结论。
4. **E2 只抽样 13/112 chunk（11.6%）**，垃圾率分母是这 13 个 chunk 的产出，不是全量 33 段。
5. **逐 chunk 调用意味着 Dedup 只在 chunk 内生效**，跨 chunk 重复未合并；真实流水线条目会更少、
   Precision 会略降（重复不算垃圾，但会摊薄）。
6. 有 2 条 E1 被拦候选只落盘了 `what`（`run_eval.py` 早期的 blocked 字段缺项），
   故 lens 分母为 6 而非 8；已在该文件补齐 `when/why/lens/category` 落盘，后续复跑可补全。
7. 本轮**未改任何被测代码**（`server/storage-hub/`、`server/exp-pipeline/*.py` 只读），
   第 8 节的建议均为下一轮改动项。

---

## 十、复现方式

```bash
cd /d/Code/dsh-plugins-github
python server/exp-pipeline/eval/build_materials.py        # E1 定位黄金素材（写 materials_e1.json）
python server/exp-pipeline/eval/run_eval.py --dry-run     # 只看计划与调用数（不调 LLM）
python server/exp-pipeline/eval/run_eval.py --exp all --resume   # 真跑（--resume 断点续跑）
python server/exp-pipeline/eval/score.py                  # 成本 + Recall 初筛 + 候选清单
python server/exp-pipeline/eval/finalize.py               # 三指标（读 judge.json 人工判定）
python server/exp-pipeline/eval/rule_baseline.py          # 规则版同素材基线（零 LLM）
python server/exp-pipeline/eval/compare_rules.py          # 新旧并排 3 样本
python server/exp-pipeline/eval/judge_view.py             # 人工判定视图
```

- 输入固定：黄金集 / 负例集 / digest / archive 路径全部硬编码在脚本顶部常量里。
- 断点续跑：每 chunk 落 `eval/raw/<key>.json`，`--resume` 跳过已存在。
- 并发：`--shard i/n` 可拆多进程（本轮用 4 进程把 39 次调用压到约 40 分钟）。
