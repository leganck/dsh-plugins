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
