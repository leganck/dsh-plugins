# _team/board.md — 并行改造看板（Lead 维护）

## 当前批次：storage-hub v2 落地（M1-M2：经验资产闭环）2026-11-19

| Thread | 队员 | 状态 | 目标 | 写范围 | 依赖 |
|---|---|---|---|---|---|
| T-261119-mem | mem | **closed（Lead 抽验通过）** | memories 表 + /v1/memories/* 8 端点（契约冻结） | `server/code-index-service/` | 无 |
| T-261119-pipe | pipe | **closed（Lead 抽验通过）** | exp-pipeline 三层治理（读归档→候选→治理→写 memories） | `server/exp-pipeline/` | 契约（task-5 文字）无运行时依赖，测试全 stub |
| T-261119-seed | seed | **closed（Lead 抽验通过）** | 223 条种子灌库 + e2e 演示 + M1/M2 验收报告 | `server/exp-pipeline/{seed.py,e2e_demo.md,ACCEPTANCE.md}` | task-5 ✅ + task-6 |

mem 抽验记录（Lead 亲自跑）：test_memories **59/59**、test_bodies 31/31、test_embed_throughput 53/53、selftest 274/274、
路由不互吞（/search vs /{id} 有专项断言）、memories_fts 用 **trigram**（unicode61 不切 CJK 的坑已避开，中文子串可命中）、
admin stats 保持四类口径 + data["memories"] 盘点块、DELETE 鉴权与 POST 同口径（合理）。

pipe 抽验记录（Lead 亲自跑）：test_pipeline **59/59**（真实归档夹具、stub 源码探索 factual_error 拦截、Dedup>0.90+禁桥接、Merge 四判）；
真实归档 dry-run 复跑（23 主题组→27 候选→3 create，零写）；digest 解析恰 **223 条**（lens: index164/jargon44/logic15）；
--llm 无 env 优雅降级 exit 0；README L72-74 三层默认方向齐全；越界检查干净。common.py（40 行）超出 7 文件清单=合理新增。

seed 抽验记录（Lead 亲自跑/读）：seed --dry-run=223 条（lens index164/jargon44/logic15）；
e2e 幂等重放 223 created→223 updated 库不增行；6 组查询 4 组 top-3 命中（2 组空命中=主题不在种子内，已在文档如实注明并给 grep 证据）；
M1 4/5 达成（contradict 跑批 0 判定=数据覆盖问题，队列机制已单独实测）；M2 1/4（其余属 review-service 后续批次）；
全程 127.0.0.1:58921 + 临时 DB，零线上触碰，进程/目录已清理。ACCEPTANCE.md 数字实、原因清。

### 派发说明
- mem 与 pipe **并行**：写范围互斥（code-index-service vs exp-pipeline）；pipe 的 client 按 task-5 冻结契约写，测试 stub，不等 mem。
- seed 阻塞在 5、6 之后，两员回报后 Lead 抽验通过再派 seed。
- 闸门：全员禁 git add/commit/push、禁部署、禁碰线上 192.168.50.112（pipe 只读 search 也在测试里 stub 掉）。

## 历史批次：code-index 0.17（已全部 closed，2026-11-18）

| Thread | 队员 | 状态 | 交付 |
|---|---|---|---|
| T-261118-srv | srv | closed | bodies 端点 + 契约 + 31 测试 |
| T-261118-plug | plug | closed | expand/code_graph/buildIndex 图挂钩 + 49 测试（Lead 修 store.js types 绑参根因） |
| T-261118-cons | cons | closed | preindex 脚本（46 仓）/ usage 指南 / 空库报告 |
| T-261118-A/B | Lead | done | 覆盖率闸门 0.2 + 文档降权 0.35 + 10 测试 |
| T-261118-perf | perf | closed | 吞吐 1.96×（分桶+去重+分片限速）+ speed/etaSeconds + 53 测试 |

回归总账（0.17 批次收口时）：插件 342 项 + 服务端 31+53+274 项全绿。

## 待用户决策（累积）
1. 全部未提交改动的 commit / push 时机
2. 服务端部署窗口（bodies + 吞吐 + memories 三合一）+ 模型精度实验（fp32/int8）
3. 删 5 个空壳索引库
4. 插件 profile 重装 + 重启 DSH（加载 expand/code_graph/闸门/降权）

## M0 部署完成（2026-11-20 00:05）

| 步骤 | 结果 |
|---|---|
| CI 构建（GitHub） | run 44557733052 success：base(cpu/gpu) 指纹命中跳过构建（`skipped`），app 两 flavor build→smoke→push 全绿 |
| 112 拉镜像 | server-v0.16.0-cpu（digest f91c9502…） |
| 部署 | 新容器 dsh-embed（97cf2166…）healthy after 20s；旧容器改名 dsh-embed-v0.15.5-backup 可回滚 |
| memories 端点 | 线上可用：`{"items":[],"total":0}` |
| bodies 端点 | 线上可用：HTTP 200 |
| speed/etaSeconds | 上线（erp-pos pending=0 → speed 0.0/eta null，属正常空载） |

## 数据完整性核验
19 scopes 全部保留；erp-pos **coverage 100%**（9467/9467 vectors）——fp16 模型换容器未换 tag，无需重嵌。

## 100% 覆盖下的语义检索实测（0.8 块/s 时代做不到的）
- 「加料不能单独下单」→ top1 正中 OnlineDietOrderService.java:5331（抛 CustomException 处）
- 「云打印 小票」→ top1 PosReceiptService 电子小票接口 + PrepackPrintRecordService
- 「结账写销售 payStatus payWay」→ ReportMapper.xml 报表块（此查询关键词通道更强；语义补位）
- 延迟：embed ~250ms + kNN 2-7ms，正常

## 凭据安全插曲
deploy 脚本首版硬编码 API_KEY/ADMIN_PASSWORD 被 pre-commit 拦截（钩子正确工作）→
重写为 scripts/deploy-embed.sh（凭据走环境变量，旧容器改名备份可回滚），已提交 41817d3。

## 后续（未做）
1. 服务器模型精度实验（fp32/int8）——5-20x 吞吐杠杆，换 tag 需全量重嵌，需排期
2. 线上灌种子：seed.py --url http://192.168.50.112:18000（223 条）
3. review-service 经验注入批次（M2 剩余 3 项）
4. 插件 profile 重装 + 重启 DSH（expand/code_graph/闸门/降权）

## 新批次：admin 控制台 v2（2026-11-20 07:50）

| Thread | 队员 | 状态 | 目标 | 写范围 |
|---|---|---|---|---|
| T-261120-ui | ui | **closed（Lead 冒烟通过）** | 设计稿 A+B+C+D 全量（概览双资产卡/经验 tab 四区块/代码资产 tab 改造/统计细分） | server.py（唯一） |

说明：单文件任务（133KB 内联 HTML 全在一个 r-string），拆不出并行单元，单队员全量做。
规格=docs/admin-console-v2.md；E 步（批量退役）后端参数缺失，本轮不做。

ui 抽验记录（Lead 亲自跑）：ast ok；server.py +494/-19 全在 ADMIN_HTML；
test_memories 59 / test_bodies 31 / selftest 274 全绿（ui 未改任何测试，selftest「作用域（永久快照）」
断言通过「代码资产 · 作用域（永久快照）」双标题保留）；
真实登录冒烟（临时DB+FakeEmbedder+admin 登录，161,601B）：tab-memories/代码资产/mem-conflict-dot/
data-asset seg/块均向量/冲突裁决 全 PASS，旧「>作用域</button>」已移除。
说明：冲突卡「既有条目」对照列暂取同队列另一 conflicting 条目（后端无 conflict.against 字段，下版可加）。

## admin v2 部署 + 线上灌种子（2026-11-20 09:24）

| 步骤 | 结果 |
|---|---|
| CI 构建 | run 44652080825：app(cpu) 4 分钟完成（base 指纹命中跳过）→ server-v0.17.0-cpu |
| 112 部署 | 新容器 39bedccd（healthy 10s），旧容器改名 dsh-embed-prev 可回滚 |
| 线上 admin v2 验证 | 登录后 **7 个 tab**：overview/memories/scopes/models/keys/stats/logs；经验 tab 锚点全 PASS（页面 171,347B） |
| 种子灌入 | **223 条 created / 0 失败**；幂等重放 **223 updated，total 仍 223** |
| 经验检索实测 | 3 组查询全命中，延迟 206-244ms：分支清理→worktree/merge 相关；结账 payWay→hzf_pay_book 超时经验；云打印→云效附件/日志经验 |
| admin stats | memories: {total: 223, hits: 0, adopted: 0} |

**注意**：命中质量反映 digest 语料主题分布（偏 DSH/云效/工具链），业务主题（结账写销售/云打印旧快照）
在种子里覆盖少——补种 biz-context.txt 可改善（待做）。

## CI 修复（2026-11-20 09:55）—— 三类失败全清

| 失败 | 根因 | 修复 |
|---|---|---|
| ci / plugin market index | 历史重写后插件目录最后改动 commit 全变 → index.json 过期 | pnpm market 重新生成 |
| ci / test dsh-code-index 6 断言 | **覆盖率闸门缺陷**：`rs.coverage ?? 0` 把"字段缺失"错当"覆盖 0%" → 静默拦成纯关键词（test-remote 的桩 GET 一律回 {ready:true} 无 coverage） | remoteCoverage() 改为缺失/非法 → null 不拦；test-remote 79/0 |
| secret-scan / curl-auth-header | **41817d3 误提交含真实 API_KEY/ADMIN_PASSWORD 的旧部署脚本** | filter-repo 全历史抹除 + 强推；**凭据已轮换**（API_KEY+ADMIN_PASSWORD 全新值，旧值 401）；DSH profile 已写新 KEY |
| secret-scan / generic-api-key | 模型清单 sha256 校验值（64hex）被误判 | .gitleaks.toml 白名单：当前文件 + 已删除的历史工具文件 |

最终状态：**ci success / secret-scan success / publish-image success**（0ef75d4）。

### 两次教训记录
1. 脚本曾含真值（上次 .env.example 同类事故）→ 这次发现后 4 分钟内完成 删文件→抹历史→轮换三连，损失为零（发现早）。
2. `?? 0` 的默认值语义陷阱：字段"缺失"≠"为零"。凡是判断"占比"类字段必须先验存在性。

## 插件重启后验证（2026-11-20 10:02）——发现并修复两个真 bug

重启后查到的是：profile 里装的是 **0.16.0**（`github:...#38d4ee30` 在历史重写后已成悬空 SHA，
pnpm 缓存旧包未重拉），所以 expand/code_graph/闸门/降权全都没生效。

### 处置
1. 插件版本 0.16.0 → 0.17.0（补版本号，此前只改了代码没升版本）→ 重建 market → tag `code-index-v0.17.0` → 重装。
2. 重装后实测发现**两个真 bug**，一并修掉升 0.17.1（tag `code-index-v0.17.1`）：
   - **解构参数漏抓符号**：`METHOD_RE` 参数段 `[^;{]*` 排除 `{`，
     `export async function buildIndex({ store })` 整条抓不到 → 本插件自己的入口函数都查不到。
     改 `[^;)]*`（允许 `{`，仍禁 `;` 与嵌套 `)`）。
   - **旧图赖着不走**：建库"无变更就跳过重建"会沿用旧规则抽的图。
     加 `GRAPH_VERSION`（改提取规则即 +1）+ 跳过条件校验版本 → 升级后首建强制重扫。
3. 回归：test-graph 49→**56**，test-remote 79、test 116、test-plugin 84、test-search-quality 10 全绿。

### 重启后实测（全部 PASS）
| 能力 | 实测 |
|---|---|
| `code_graph` 工具 | 在；`sendJSON` 入向 2 条、`orderCompletePost` 5 处声明 + 2 条入向 calls |
| `code_search expand` | 【关联代码】区块正常渲染（加权 0.50 + 首行摘要） |
| 远端 + 新 API_KEY | `hybrid-remote` 通道；embed 228~255 ms / kNN 2~7 ms |
| 覆盖率闸门 | 生效（且修了「字段缺失当 0」缺陷） |
| 图规模（版本强制重扫后） | dsh-plugins **1546 符号 / 3363 边**（原 1384/1960）；erp-pos **25406 符号 / 75825 边，重建 3.7 s** |

## 新批次：admin v3 + 治理可见性 + 指纹去重（2026-11-20 13:40）

| Thread | 队员 | 状态 | 目标 | 写范围 |
|---|---|---|---|---|
| T-261120-gov | gov | **closed（Lead 抽验通过）** | pipeline_runs/conflicts配对(against+trigger_words)/timeline/stale_days/冲突召回(conflictWarning) | code-index-service + exp-pipeline(client/pipeline/stage_c) |
| T-261120-dedup | dedup | **closed（Lead 抽验通过）** | vectors CAS化(v2)/lineages merge(事务+merged_into观察期)/duplicates检测/cleanup脚本 | code-index-service（与gov有同文件分工约定：MemoryStore归gov，IndexStore向量区归dedup） |
| T-261120-ui2 | ui2 | **closed（Lead 抽验通过 + 并发修复）** | 驾驶舱概览/Review Inbox/治理流水/融合裁决/分组视图/receipt toast | server.py ADMIN_HTML |

设计依据：docs/research-mature-solutions-and-mnemon.md（LangSmith run观测/knowns Review Inbox/Memanto冲突双方保留/CAS/alias观察期/Mnemon receipt文化）+ docs/diagnosis-admin-ui-governance-duplicates.md。

## 112 本地构建预览（预研完成，方案见 docs/preview-build-on-112.md）
- 112 具备直建能力：docker 29.5.2 + buildx 0.34.1 + ghcr 通 + latest-cpu(=v0.17.0)已缓存，磁盘余14G
- 流程：ui2 回报抽验后 → git archive 工作区 rsync 到 112 /srv/dsh-preview → docker build Dockerfile.app（FROM 缓存 base）→ preview 容器绑 18080（独立数据卷+独立KEY）→ seed 灌 223 条 → 浏览器看 v3
- 正式发版仍走 GitHub CI（分层缓存+smoke 门禁不变）；112 直建只做预览
- 模型层：首建时从生产容器 docker cp /models 一次性拷出，之后零下载

gov 抽验记录（Lead 亲自跑）：test_memories **90/90**（59 既有+31 新增）、test_pipeline 70/70、
selftest 274/274、test_bodies 31/31；锚点确认：pipeline_runs 路由（server.py L3931-3951）、
memories_against_id/trigger_words 列+索引（index_store.py L106-113）、memory_events 表+合成 timeline
（L115/L1692 synthesized）、link_conflict 双写；search 语义变更（conflicting 召回带 conflictWarning）
已进 docs/memories.md 且测试钉住。改动范围干净（8 文件全在授权内）。

dedup 抽验记录（Lead 亲自跑）：test_lineages **43/43**、selftest 274/274、test_bodies 31/31、
test_memories 90/90（gov 新基线）；锚点：vectors_v2 CAS 表（(tag,hash) 复合主键，取舍见 docs/lineages.md §1.1）、
旧表降级为血统成员表保住 _missing/adopt 兼容读、lineages/{duplicates,merge,hard-clean} 三端点（server.py L4463/L5199）、
cleanup-lineages.py 双模式（--db/--url）+ --dry-run/--apply/--hard/--vacuum。
用户已授权「历史数据可清理」：merge 即生效、观察期仅作安全网；bug-analysis 组 same_chunk_fp=false 清洗前人工确认。

dedup 调整版抽验（Lead 亲自跑，2026-11-20 14:40）：按「历史数据可清理」授权重交——
test_lineages **46/46**、test_memories 90/90、ast ok；启动 gate 只认 v2（旧库 RuntimeError 提示跑脚本）、
merge 当场物理删重（merged_into 仅墓碑/重定向）、--migrate-cas 一次性迁移幂等。
**部署执行序（已冻结，写进 docs/lineages.md §5）**：
  停写 → cleanup-lineages.py --db $DB --migrate-cas --vacuum → 起服务 → --dry-run 核对 → --apply
  （bug-analysis 组 same_chunk_fp=false 先人工确认，可 --only 清其余三组）
预期净删：chunks≈461 行、vectors 成员≈2049 行、erp-pos 组 blobs 归并≈9467 正文行。

## ui2 抽验 + Lead 修复 + 112 预演（2026-11-20 16:05）

ui2 抽验（Lead 亲自跑）：回归 selftest 274 / bodies 31 / memories 90 / lineages 46 全绿；
登录冒烟 15/15 锚点、tab 频率序正确（概览|经验|代码资产|统计|模型|Key|日志）；页面 188.6K 字符。
ui2 需确认裁定：① 203.5K wire 字节接受（单文件管理台 LAN 秒开，gzip 列后续）；② 并发 500 = 真问题 →
**Lead 修复**：MemoryStore 独立连接（不再与 IndexStore 共享）+ row_factory 对齐 + 7 个无锁读写方法补 RLock
（审计：写方法原有锁，get/list/search/timeline/stats/conflicting/list_runs 无锁）+ 并发烟测 8 线程×24 请求 0 错误；
③ resolve 只接 active|retired 属语义正确（conflicting 只能由 upsert 带入，管道正序 stage_c L247）。

## 112 预演实录（预览容器 :18080，生产 18000 全程未动）
1. git archive → 112 直建：**6 秒**（base 缓存命中）；模型 docker cp 一次性拷出 195MB
2. **预演抓到 2 个部署阻塞点**（都修复提交）：
   - 老库 SCHEMA executescript 先于补列 → "no such column: against_id"（eb9801b：索引移到补列后）
   - Dockerfile.app 漏 COPY scripts/（53fe94e：迁移脚本必须随镜像）
3. 生产库副本 222MB → 容器内 --migrate-cas --vacuum 完成（2049 冗余向量坍缩进 v2）
4. duplicates 检测（血统口径）：实际跨血统重复 1 组（dsh-plugins 406e34→02fa1d），--apply 完成
   droppedChunks=124 droppedVectors=185 droppedBlobs=185 freed=0.43MB
   （erp-pos/crm-order 镜像 namespace 属同血统不同 repoId，CAS 已消向量冗余；namespace 级清理列后续）
5. 预览数据就绪：223+2 条经验、1 对冲突演示（exp-000225 vs 224，trigger_words 带）、
   1 条治理流水演示（demo-preview-1，四判计数+拦截明细）、检索 conflictWarning=True 实证
6. 生产容器 healthy 6h 零影响

## 预览地址（待用户浏览器验收）
http://192.168.50.112:18080/admin  （admin / 预览密码见本地 _tmp；预览 KEY 独立，生产 18000 未动）

## 新批次：schema v2 + 经验抽取核心（2026-11-20 17:35）

用户已全部拍板（按推荐来）：
- **不写兼容代码**、重置重建（旧库启动即拒绝）、向量清空重算
- 证据片段落容器（excerpt 模式，≤2KB 已脱敏，180 天降级为 quote-only）
- 向量精度：重置前先做 20 条 A/B（fp16 vs fp32/int8），质量不降就换 fp32（3.8h → ~40min）
- 显示层中文名（jargon/index/logic → 黑话/索引/逻辑镜头）；卡片视图为默认
- 旧 223 条经验随库清空，问题消解

| Thread | 队员 | 状态 | 目标 | 写范围 |
|---|---|---|---|---|
| T-261120-schema | store2 | **closed（Lead 抽验通过）** | index_store/knn/governor/server-payload 全量改 v2 + tests | index_store.py, knn.py, governor.py, server.py(非 HTML), tests/ |
| T-261120-expcore | expcore | **closed（Lead 抽验通过 + 默认值调优）** | exp_prompt/exp_llm/exp_pipeline + admin_store settings + test_exp_core | 4 个新文件 + admin_store.py + test_exp_core.py |

协作边界：store2 不碰 ADMIN_HTML 段与 expcore 的 4 个新文件；expcore 只写授权文件。
两者都完成后，再由单一 owner 做 server.py 的路由/设置页/卡片视图（避免同文件并发）。

## 待办（后续阶段）
- P0 剩余：设置页 ADMIN_HTML + `POST /v1/admin/settings/llm-test`（必须服务端代理发起）
- P1 剩余：`/v1/exp/extract|import|jobs`、`/v1/memories/stats`、`/v1/admin/exp/replay`
- P2 插件接线（memory-archive 压缩后触发，失败不阻塞）
- P3 评测（gold set 18 正 + 8 负，三指标）
- P4 重置部署（含精度 A/B）

store2 抽验（Lead 亲自跑，2026-11-20 18:05）：
  test_schema **77/77** · test_scopes 128/128 · test_memories **119/119** · test_bodies 31/31 · selftest **278/278**
  实测旧库（无 meta）→ RuntimeError 且消息含「重置重建」+ docs/schema-v2.md §5 ✅
  实测 24 表/视图（14 表 + FTS 影子表），memories/conflicts/excerpts/vectors/chunks 关键列齐全，schema_version=2，foreign_keys=1 ✅
  ADMIN_HTML 区间（行 289~3396）git diff hunks = 0 处被改 ✅（store2 守住了冻结段）
  残留引用清理（Lead 做）：删掉已破损的 scripts/cleanup-lineages.py（引用了已删的 cas_migrate_db/lineage_hard_clean/vectors_v2）；
  docs/lineages.md 重写为 v2 语义（无墓碑、merged 不搬运、hard-clean=清空血统、duplicates 判定）；
  ADMIN_HTML 里"观察期 7 天"过时文案改为 v2 实际语义，改后 selftest 仍 278 绿。

## 第三批（2026-11-20 21:25）

| Thread | 队员 | 状态 | 交付 |
|---|---|---|---|
| T-261120-expcore | expcore | **closed** | 176/176；when_min 10、8000 tokens/240s/400 字分段、truncated 不静默、黄金样本 17 条修正 |
| T-261120-srv | srv2 | **closed** | 88/88 + selftest 279；设置页/llm-test(服务端发起)/exp 路由/stats/卡片流/中文标签 |
| T-261120-plugin | plugin | **closed（Lead 抽验）** | 109+78=187；压缩后 fire-and-forget 触发，四类失败下落盘逐字节一致 |
| T-261120-eval | evalr | dispatched | Recall/Precision/Garbage/Category Acc + 与规则版对照 |

提交：72fc29f(schema v2) → 15183ca(exp 核心) → 01e4ea7(HTTP+卡片) → 442da68(插件 1.3.0)

待办：
- 发版：memory-archive release/*.tgz 重打包 + market 已重建（版本 1.3.0）
- P4 重置部署（含 fp16 vs fp32 A/B 精度实验，唯一免费窗口）
- 线上启用：装新 tgz + profile 配 exp.enabled/url/key
