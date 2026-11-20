# 经验提取 v2：session-4ff93b80（按腾讯《AI Coding 的下一站》方法论）

> 素材：`~/.dsh/archive/session-4ff93b80-08ba-4561-bc0c-04c1462dc7f5/`（33 段，INDEX.md 关键词定位）
> 产出：`server/exp-pipeline/experiences-v2-session-4ff93b80.jsonl`（18 条，人工按方法论写，不用 LLM API）
> 对照：线上现有 200 条（规则版，digest 直灌）

---

## 零、先看旧版问题有多大（量化，不是感觉）

| 指标 | 现有 200 条（规则版） |
|---|---|
| **what 与 why 相似 >0.75**（同一句复制两遍） | **199 条 = 100%** |
| when 为空或空条件（"处理X时"） | 170 条 = 85% |
| what 以工单号/审计语气/"定位入口："开头 | 95 条 = 48% |
| lens 分布 | index 149 / jargon 40 / logic 11（逻辑镜头只占 5.5%） |

典型样本（what 与 why 逐字相同）：

```text
exp-000223  what: Earlier claim “文件与 5.0.x 一致 = 可摘” was wrong — file identical means...
            why : Earlier claim “文件与 5.0.x 一致 = 可摘” was wrong — file identical means...
```

根因（机制层，不是态度问题）：规则版 `stage_b_rules` 里
`what = 正则从修正句式抠出来的一段`、`why = 同一句截 300 字` —— 结构上就是同句复制，
且 lens 在无修正句式时一律落 index。**规则版能保证"有东西"，保证不了"是经验"。**

---

## 一、方法论映射（文章 §四~§六 → 本次怎么落地）

| 文章原则 | 本次执行 |
|---|---|
| 经验标准 = 被召回后 Agent 行为能否正向改变 | 每条都写 `reusable_because`，写不出就不收 |
| 三镜头（黑话/索引/逻辑） | 18 条分布：logic 9 / index 7 / jargon 2 —— 逻辑镜头是这次的主要增量 |
| 九类垃圾排除 | 拒收 8 条候选，逐条记原因（见 §四） |
| 可审计三维 | 每条带 `reusable_because` + `exclusions`（核对过哪几类垃圾）+ `evidence_quote`（原文） |
| Review 用源码探索做事实校验 | 用本机 code-index 符号表核验类/方法是否存在（见 §五） |
| Dedup 宁严勿宽、禁止桥接 | 18 条里 3 组主题邻近但场景不同，按规则**不合并**（见 §六） |
| Merge 唯一目标前置、默认 create | 本批全为 create（旧库无同向条目） |

---

## 二、18 条经验

### A. 线上故障取证（logic，最高复用价值）

**1. 上传流水后台查不到时，先比对同机同收银员相邻流水的落库分区，不要只查客户自己的库**
- when：客户报上传成功但后台查不到流水
- why：分区路由错时数据写进其他租户库，客户端仍收到 SUCCESS，只查本租户永远查不到
- evidence：`segment_032.md`｜"分区 za4 正常；三笔上传被路由到 zb1，落进 tenant_id=140709"
- audit：把排查起点从本租户库改成跨分区比对，是一步可执行的定位动作｜排除 1,2,3,4,6,8

**2. 确认错写分区后，在该分区的 pos 表按 posId 查真实归属租户与门店号**
- when：怀疑流水被写到别的分区
- why：posId 在不同分区属不同租户门店，撞号会掩盖真实归属，误判成数据丢失
- evidence：`segment_032.md`｜"zb1 库 pos 66112 → tenant 140709/门店 9016/机号 012；ti4 库同 id → 431912/55285/003"
- lens：index

**3. 跨租户错写的修复同时准备源库软删与目标库按原 payload 补录，一次提审批**
- when：确认流水被写进其他租户库
- why：只删不补客户数据永久缺失；只补不删造成两库重复记账
- evidence：CHGJ-3943｜"zb1 软删 10 行 + za4 补录 10 行，预期 20 行"

**4. 客户报有销售但库存没扣时，按 tenant_id 查 store_account 的 branch_id 分布，而不是按门店号查**
- when：有销售流水但库存未扣减
- why：销售按 posId 解析归属、库存任务沿用请求里的 branchId，两者不一致时流水记到别的门店
- evidence：`segment_027.md`｜"11-13 全天 branchId=30840，11-12/11-14 都是 37219；30840 属另一租户 264828"

**5. 改库存台账归属后按 (goods_id, occur_at, id) 顺序重算 5 个结余列，不能只改 branch_id**
- when：修复 store_account 的门店归属
- why：结余是写库那刻的快照（上笔结余+本次发生），跳链后会出现负数结余夹在正数之间
- evidence：CHGJ-3955｜"30840 链结余 -1/-2/-3，37219 链 8→6；只改 branch_id 会让两链交错"

**6. 评估库存数据修复范围前先读 StoreComputeImpl，确认它写的是五张表**
- when：评估库存相关数据修复范围
- why：只处理 store 与 store_account 会留下负批次与进销存缺口，商品进销存少记销量
- evidence：`segment_003.md` + 代码｜store / store_account / store_batch_in / store_batch_out / goods_invoicing
- lens：index

**7. 重放库存消息前先删除 bas_interface_log 中对应的防重记录**
- when：用 Redis 重放 goods:stock 消息
- why：消费端按 saleDetailId 查接口日志判重，日志还在则消息全被当作重复数据丢弃
- evidence：`segment_001/008/009.md`｜"接口日志 452 条、status 全 1，必须先清理"

**8. 手工投递 Redis Stream 后，用 XINFO STREAM 的 last-generated-id 判断，不要看 XLEN**
- when：手工 XADD 投递 stream 后确认是否成功
- why：消费成功会 XDEL，XLEN 不增长是常态，据此判断会把已投递误判成没投进去
- evidence：`segment_004/005.md` goods:stock 消费链｜"XLEN 不增长正常，看 entries-added / last-delivered-id"
- lens：index

**9. 批量重放前先投 1 条并核对台账与余量，确认后再放量**
- when：批量重放或批量数据修复前
- why：连错实例、DB index 错、key 名错、引号泄漏都会静默失败，批量投等于全白投
- evidence：CHGJ-3955｜"先只投这 1 条，30 秒内可看到结果；对了再投剩下 451 条"

### B. 跨线代码移植（logic）

**10. 两条产品线各自新建了同名类时，按已发版修复逐个 cherry-pick，禁止全分支 merge**
- when：把 master-5.0.x 合进 5.2.3 这类跨线移植
- why：两线独立在相同路径新建同类，全量 merge 后约 200 处找不到符号，且无法短期收敛
- evidence：`segment_028.md` SPLAT-5627｜"9 文件 16 冲突解决后 ~200 编译错误"

**11. 需要让分支成为祖先但代码逐字节不变时，用 git merge -s ours**
- when：要求标记已合并但无可变更代码
- why：普通 merge 会带回整条分支变更；ours 只记录合并关系，tree 保持不变
- evidence：`31a34cff`｜"merge -s ours origin/master-5.0.x，tree 逐字节一致，5.0.x 成为祖先"
- lens：index

**12. cherry-pick 冲突解决后要确认真的产生了提交，没有就手工重贴该次意图**
- when：cherry-pick --continue 前解决冲突
- why：解决结果与 HEAD 相同时会提示 nothing to commit，该次 pick 被静默丢弃
- evidence：`segment_028.md`｜"resolve 等于 HEAD 时 nothing to commit，pick 被静默丢弃"

### C. 工具与环境（index，省时间最多）

**13. 查 POS/ERP 生产业务日志用 devops 的 default 环境，不要用 www_ali**
- when：查 POS 或 ERP 线上业务日志
- why：www_ali 下 pos 主题只剩 Redis 心跳，按库名找环境会误判成日志不可用
- evidence：`segment_002/003.md`｜"日志在 default 环境（44 主题）：default-<group>-smartpos-svc-erp-pos"

**14. 在 Git Bash 里构建用 JAVA_HOME 下的 java 直调 gradle-wrapper.jar**
- when：在 MSYS/Git Bash 执行 gradle 构建
- why：./gradlew 返回 126；sh ./gradlew 会把路径改写成 D;/Code/... 而失败
- evidence：`segment_030.md`｜"\"$JAVA_HOME/bin/java\" -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain <task> --offline"

**15. 用 sp-devops 执行 SQL 时库名一律走 -d 参数，语句里不要带库名前缀**
- when：通过 sp-devops 查库
- why：带 db. 前缀会触发越权校验被直接拒绝；SHOW COLUMNS 也不支持
- evidence：`segment_002.md`｜"执行 sql 越权…请不要带数据库前缀"

### D. 发布与黑话（logic + jargon）

**16. 发布清单里判断工单能否进补丁版本，先确认它属于哪条版本线、目标线是否已含该修复**
- when：编制或审批补丁版本变更清单
- why：仅属别的版本线、或目标线已含修复的工单混入，会让发布清单失真并造成重复发版
- evidence：CHGJ-3735 / CHGJ-2979｜"CHGJ-3735/SPLAT-5584 只属 5.2 线且 5.0.x 已含修复，必须剔除"

**17. 看到「可摘/不可摘」理解为「该工单能否移植到目标补丁线」**
- when：发布清单或评论里出现可摘字样
- why：团队内部黑话，字面推不出含义，直接按字面理解会把版本判断做反
- evidence：`segment_021.md`｜"文件与 5.0.x 一致 = 可摘"
- lens：jargon

**18. 现场查库前先确认目标表是否有 is_deleted，软删与物理删的选择由它决定**
- when：准备清理生产数据的审批语句
- why：有软删标记的表按 is_deleted=1 处理可回滚；没有该列的表只能物理删，必须单列说明
- evidence：CHGJ-3955｜"bas_interface_log 无 is_deleted，只能物理 DELETE 452 行"
- lens：logic

---

## 三、与旧版的逐项差异（同样素材）

| 维度 | 旧（规则版 exp-000222 为例） | 新（v2 第 1 条） |
|---|---|---|
| what | `CHGJ-3735/SPLAT-5584 were wrongly included in the first approval draft...` | `上传流水后台查不到时，先比对同机相邻流水的落库分区` |
| why | 与 what **完全相同** | `分区路由错时数据写进其他租户库，客户端仍收到 SUCCESS` |
| when | `工单 CHGJ-3735/SPLAT-5584`（工单号当条件） | `客户报上传成功但后台查不到流水`（可判定） |
| 可直接执行？ | 否（是事后叙事） | 是（下一步动作明确） |
| lens | index（兜底） | logic（认知障碍判定） |

---

## 四、被拒的 8 条候选（九类垃圾逐条对照）

| 候选（来自素材） | 拒收原因（垃圾类别） |
|---|---|
| "多试几次就好了" | 2 通用常识 + 4 一次性 case（碰运气，非判断） |
| "遇到复杂问题多收集上下文" | 2 通用常识 + 8 不可执行（永远对，无法指导动作） |
| "超时就调大超时参数" | **1 事实性错误**（根因不在参数，是错误引导） |
| "先沟通再动手" | 5 用户主观偏好 |
| "本次改了 7 个文件、跑了 3 次测试" | 3 对话摘要（过程录像） |
| "已经部署到 dev1 了" | 4 一次性 case（临时状态） |
| "CHGJ-3735 涉及 3 笔共 34 元" | 7 粒度混用（金额细节降为 evidence，不进 what） |
| "只推个人 fork、不直推 origin" | 已由 sp-rules skill 覆盖 → **不算垃圾，但重复入库无收益**（这条要单独说明：团队规范类应留在 skill，不进经验库） |

---

## 五、源码探索事实校验（文章 §6.2 的落地）

用本机 code-index 符号表核验经验里提到的类/方法是否真实存在：

| 声称的符号 | 校验结果 |
|---|---|
| `DataService` / `DataController` / `StoreComputeImpl` / `ReportService` / `cashierSummary` / `findAreaBranchs` | ✓ 存在于 erp-pos 索引 |
| `StorePersistenceComputeImpl` | ✗ 不在 erp-pos（属 **smartpos-erp-stock** 仓，需该仓索引才能验） |
| `OrderPrintTicketAssembler` / `SpecDescFormatter` | ✗ 不在 erp-pos（属 **crm-order** 仓） |
| `attachToQBListView`（文章里的反例） | ✗ 不存在 —— 与文章一致的验证行为 |

**结论**：事实校验必须指向**正确的仓库索引**，否则"不存在"是假阴性。本次对跨仓符号标注为未验证，不据此判垃圾——这条本身也是方法论落地时的一个坑（值得进经验库）。

---

## 六、Dedup 判定（宁严勿宽 + 禁止桥接）

三组"看起来像"但**不合并**的例子：

| 组 | 两条 | 不合并理由 |
|---|---|---|
| 排查起点 | 第 1 条（先比分区） vs 第 2 条（查 pos 表归属） | When 不同：一个是"查不到"，一个是"已怀疑错分区" |
| 库存修复 | 第 5 条（重算结余） vs 第 6 条（五张表范围） | 主结论类型不同：数据一致性 vs 修复范围 |
| 重放 | 第 7 条（先删防重日志） vs 第 8 条（验证看 XINFO） | 一个前置条件、一个验证手段，不可互相替代 |

**禁止桥接**：第 1 条（分区错）→ 第 4 条（branchId 错）→ 第 5 条（结余滚动）语义都在"归属错"，
但适用场景与动作完全不同，**不得串联归并**——一旦合并，三条的边界条件全部丢失。

---

## 七、下一步（可选）

1. **入库**：这 18 条走 `POST /v1/memories`（source=`session-4ff93b80:manual-v2`），旧的 200 条按
   `stale_days` + 人工抽检后批量退役（用户已授权历史可清理）
2. **规模化**：把本次人工标准固化成 prompt（`extract_v2_llm.py` 已备好三镜头+九类垃圾+可审计三维），
   换 `auto/deepseek-v4.1-flash`（非推理型，content 直接返回）分批跑剩余 33 段
3. **召回打点**：入库后靠 `hit/adopted` 观测哪几条真被用上——文章的核心标准是"被召回后行为改变"，
   没有采纳数据就无法验证质量
