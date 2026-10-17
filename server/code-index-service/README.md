# code-index-service —— 远端索引服务（/v1 索引层 + /embed + /rerank）

`dsh-code-index` 插件默认**全在本机**。这个服务是可选的一台"算力/存储都放外面"的机器：

- **0.7.0 的用法**：只借算力 —— `POST /embed`（算向量）、`POST /rerank`（重排），索引仍在本地。
- **0.8.0 的用法**：整个向量索引搬过来 —— 插件只留 BM25，本服务负责同步、嵌入、kNN、重排。

两者共存，同一份模型、同一套向量标签。

## 实测（本机 RX 6750 XT / DirectML ↔ NAS Tesla P4 / CUDA 12 + ORT 1.19.2）

| 动作 | 本机 | 这台服务 | 说明 |
|---|---|---|---|
| 建库向量（512 token 长块） | **33.05 块/s** | 26.8 块/s | 本机更快（750 W vs 75 W 的卡，不意外） |
| 单条查询嵌入 | 45 ms（DML）/ 26 ms（CPU） | **15.8 ms**（含局域网） | 远端赢在"没有每次调用的 45 ms 固定开销" |
| 重排每候选 | 36 ms | **4.8 ms** | 远端快 7.5× |
| 服务端 kNN（16 万块 × 768 维，fp32） | — | **14.3 ms** | 470 MB 常驻内存；np16 会慢 30 倍，别用 |
| 端到端混合检索（1,503 块） | 40–68 ms | **≈19 ms**（含往返） | 服务端拆分：embed 7.4 + knn 0.1 |
| 端到端混合检索（**160,507 块**） | — | **p50 30 ms / p90 37.5 ms** | embed 7.7 + kNN 14.6；矩阵 493 MB |
| 冷启（第一次查询建 493 MB 矩阵 + 首次计数） | — | 2.4 s | 之后为热路径 |
| 单仓占用（16 万块） | — | 800 MB | 正文 332 MB + fp32 向量 468 MB |

> 结论：**建库搬过来不划算（慢 23%），查询与重排划算**。默认让插件全本机，按需把
> `vectorStore` / `rerankBackend` 切到 remote。

## 目录

```
code-index-service/
├── server.py        # HTTP 路由（单次 write + 关 Nagle；小响应少 40 ms）
├── index_store.py   # 血统 / 命名空间 / blobs / chunks / vectors；sync、GC、adopt
├── knn.py           # 内存矩阵 + revision 失效 + 总字节 LRU
├── governor.py      # 后台嵌入：限流、暂停、优先级、进度
├── embedder.py      # ONNX 嵌入会话 + 向量标签（tag）
├── reranker.py      # 交叉编码器重排
├── selftest.py      # 不需要模型的自测（FAKE_EMBED=1），41 项
├── start.sh         # 装依赖、选 ORT（CUDA 12 / 1.19.2 / 或退回 CPU）、启动
├── compose.yaml     # Traefik 暴露 + nvidia device 预留
└── out/             # server.log 与 index.db（运行时生成）
```

## 数据模型：为什么按"血统"存

```sql
lineages(id, url_norm, created_at, last_seen)
repos   (namespace, lineage_id, repo_id, chunk_fp, revision, tag, repo_state)
blobs   (lineage_id, hash, body)                     -- 正文，血统内按内容哈希去重
chunks  (namespace, lineage_id, path, start, end, hash)
vectors (lineage_id, tag, hash, dim, v)              -- 向量，血统内按内容哈希去重
```

**实测依据**（4 个无关仓库两两比对）：跨项目块重合 **0.00%**，同仓库跨分支 **~98%**、同仓库内重复块 0.1–0.4%。

所以：

- **存储边界是血统**（= 归一化后的 git remote URL）。10 个分支的同一仓库只占 **235 MB**；
  按分支各存一份就是 **2.35 GB**；全局存无关项目则是纯累积（0% 收益）。
- **去重按内容哈希**：改文件只有变化的块需要重嵌；第二个克隆 **0 块新嵌入**（实测）。
- 跨血统只留显式口子：`POST /v1/lineages/{id}/adopt {from, hashes?}`（fork / vendor 借用）。
- 上界：`MAX_VECTORS_PER_LINEAGE`（默认 50 万块）、`MAX_TOTAL_GB`（默认 20 GB）→ 超限 **507 + 可清理清单**，
  不静默丢数据。`RETENTION_DAYS`（默认 30）控制"没人引用的 blob/vector 什么时候删"。

## 端点

| 端点 | 说明 |
|---|---|
| `POST /v1/repos/{ns}/sync` | 清单差分。`{repoState, revision?, mode:'diff'|'full', tag, url, repoId, chunkFp, lineage?, upsert[], remove[]}` → `{revision, unchanged, missing[], chunks, vectors, coverage}` |
| `POST /v1/repos/{ns}/chunks` | 上传缺失正文（gzip、批量、幂等）→ `{accepted, deduped}` |
| `POST /v1/repos/{ns}/embed` | 触发后台嵌入（可带 `rate`） |
| `GET /v1/repos/{ns}/status` | `{revision, chunks, vectors, coverage, pending, rate, paused, totalBytes, limits}` |
| `POST /v1/search` | `{namespace, query, k, tag?, rerank:{candidates}}` → `{hits[{hash,path,start,end,score,rerankScore?}], ms{embed,knn,rerank}, coverage}` |
| `POST /v1/admin/pause` `/resume` `/rate` `/gc` | 治理 |
| `POST /v1/lineages/{id}/adopt` | 显式跨血统借用 |
| `POST /embed` `POST /rerank` | 0.7.0 兼容：只借算力 |
| `GET /` `/health` `/log` | 自述（模型、tag、重排状态、治理状态、命名空间概览） |

**`sync` 的三个分支**：`repoState` 与库中一致 → 直接 `unchanged`（1 个 RTT、0 字节正文）；
`mode:'diff'` 且 `revision` 不是服务端当前值 → `409 {needFull:true}`（客户端改发全量自愈）；
`chunkFp` 不同 → `400`（切块配置不同的客户端不能混写同一命名空间）。

## 热路径上别做聚合查询（实测踩坑）

`coverage` 需要"有向量的块 / 总块数"，最直接的写法是 JOIN 计数 —— 在 16 万块上实测 **401 ms**，
而它是 **每次 `/v1/search` 都要返回**的字段。同理 `sum(length(...))` 算占用要 **0.5 s**，
`/health` 与 `/status` 都会碰到。修法是给 `counts()` / `lineage_bytes()` 加**变更失效**的缓存
（sync / put_chunks / put_vectors / gc / adopt 之后清空）：

| | 修前 | 修后 |
|---|---|---|
| `/v1/search` 端到端（16 万块） | 485–533 ms | **29–46 ms**（冷启首查 2.4 s 建矩阵） |
| `/health` | 1151 ms | 首次之后 O(1) |

## 初始化：别把 GPU 打满

实测瓶颈是 **GPU 而不是网络**（1000 块：服务端计算 35–39 s，网络 0.7 s）。所以限流在嵌入侧：

| 手段 | 默认 | 说明 |
|---|---|---|
| `EMBED_RATE` | **10 块/s**（P4 峰值 37%） | 16 万块 ≈ 4.5 h；`POST /v1/admin/rate {rate: 26}` 可打满 |
| `POST /v1/admin/pause` | — | 立即让出 GPU，进度保留 |
| 优先级 | `spread`（按 hash） | 先嵌的块在全仓均匀分布 → 部分索引立刻可检索 |
| 覆盖率 | `/status.coverage` | 查询结果里也会带上；初始化期间 BM25 照常可用 |

## 部署（fnOS 实测路径）

```bash
# 目录约定与其它 compose 项目一致
cd /vol1/1000/Docker/compose/dsh-embed
# 放好 model/（bge-base-zh-v1.5 fp16）与可选 model-rerank/（bge-reranker-base）
docker compose up -d          # 首次会 pip install（约 1–2 分钟）
curl -s http://127.0.0.1:18000/health | head -c 400
```

`compose.yaml` 的关键项：`deploy.resources.reservations.devices[driver=nvidia]`（等价 `--gpus all`，
fnOS 的容器 API 没有 GPU 开关）与 Traefik 标签（对外暴露为 `https://dsh-embed.example.com`）。

### 为什么必须是 CUDA 12 + onnxruntime 1.19.2

Tesla P4 是 **Pascal（sm_61）**；pip 上最新的 `onnxruntime-gpu`（1.31+）是 **CUDA 13** 栈，
而 CUDA 13 已移除 Maxwell/Pascal/Volta（最低 sm_75）→ P4 上永远跑不起来。
能跑 Pascal 的组合是 **ORT 1.19.2 + CUDA 12.4 + cuDNN 9.1**：

```bash
pip download --no-deps -d /tmp/cuda nvidia-cublas-cu12==12.4.5.8 nvidia-cudnn-cu12==9.1.0.70 nvidia-cuda-runtime-cu12==12.4.127
# 解包后把 lib/ 下 *.so* 拷到 ./cuda12/（28 个文件）
pip install --no-cache-dir --target ./pylib119 onnxruntime-gpu==1.19.2
pip install --no-cache-dir --target ./pylib numpy tokenizers
```

`start.sh` 会自动检查 `cuda12/libcublasLt.so.12` 与 `cuda12/libcudnn.so.9`，缺了就退回 CPU（服务仍可用）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MODEL_DIR` / `MODEL_NAME` | `/app/model` / 目录名推断 | 嵌入模型；`MODEL_NAME` 参与 tag 计算 |
| `RERANK_MODEL_DIR` | `/app/model-rerank` | 重排模型；缺文件 → `rerank_ready=false`（客户端直接回退本机） |
| `SERVER_DB` | `<app>/out/index.db` | 索引库 |
| `EMBED_RATE` / `EMBED_BATCH` | `10` / `8` | 后台嵌入限流与批大小 |
| `RERANK_BATCH` / `RERANK_MAX_TOKENS` | `8` / `256` | 重排批与截断 |
| `KNN_MAX_BYTES` | `2 GiB` | 内存矩阵 LRU 上限 |
| `MAX_VECTORS_PER_LINEAGE` / `MAX_TOTAL_GB` | `500000` / `20` | 存储上界（超限 507） |
| `RETENTION_DAYS` | `30` | 无人引用的 blob/vector 保留期 |
| `ORT_THREADS` / `ORT_PROVIDERS` | `6` / `CUDA,CPU` | 执行提供者 |
| `API_KEY` | 空 | 设了则所有 `POST` 要求 `Authorization: Bearer` |
| `FAKE_EMBED` | 空 | `1` = 不加载模型（自测用） |

## 自测

```bash
python selftest.py     # 41 项：同步/未变更/缺向量/幂等/嵌入/kNN/增量/GC/409/400/血统隔离/adopt/上限/暂停/gzip
```

## 安全

- 默认按"局域网 / 内网可信"设计。设 `API_KEY` 可加一层 Bearer 鉴权。
- 暴露到公网请在 Traefik 上配 basicAuth / IP 白名单，不要只靠 `API_KEY`。
- 服务端**存源码正文**（`blobs`），这是 rerank 与片段返回的前提；请把它当成代码仓库同等敏感。
