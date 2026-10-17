# nas-dsh-embed —— 把向量嵌入与重排租给一台带 GPU 的机器

`dsh-code-index` 默认全部在本机算。这个服务是**可选**的第二台机器：一台局域网里的
NAS / 工作站（本机实测用的是 Tesla P4，CUDA）跑 `/embed` 与 `/rerank`，
开发机通过 `embedding.backend: remote` / `rerankBackend: remote` 把这两段活交出去。

## 本机实测（2026-10-17，同一批块、同一份 bge-base fp16）

| 动作 | 本机 RX 6750 XT（DirectML） | NAS Tesla P4（CUDA） |
|---|---|---|
| 单条查询嵌入 | 45 ms | **15.8 ms**（含局域网往返） |
| 批量建库向量 | 28.6 块/s | 见 `tools/bench-build-vector.mjs` 实测 |
| 重排每候选 | 36 ms | **4.8 ms** |

> 结论：**查询嵌入不要搬**（本机 CPU 更快，见插件 README 的"建库用 GPU、查询用 CPU"）；
> **重排值得搬**（快 7 倍以上）。两者都能单独开关。

## 目录

```
nas-dsh-embed/
├── server.py      # / 、/embed、/rerank、/log；单次 write + 关 Nagle（否则小响应多 40 ms）
├── start.sh       # 装依赖、选 ORT（CUDA 12 / ORT 1.19.2 / 或退回 CPU）、启动
├── compose.yaml   # Traefik 暴露 + nvidia device 预留
├── model/         # 嵌入模型（bge-base-zh-v1.5：model_fp16.onnx + tokenizer*.json）
├── model-rerank/  # 重排模型（bge-reranker-base；可以没有 → rerank_ready=false）
├── cuda12/        # CUDA 12.4 运行库（约 28 个 .so，见下）
├── pylib/         # numpy + tokenizers（pip --target）
├── pylib119/      # onnxruntime-gpu==1.19.2（pip --target）
└── out/server.log # 运行日志
```

## 为什么必须是 CUDA 12 + onnxruntime 1.19.2

Tesla P4 是 **Pascal（sm_61）**。pip 上最新的 `onnxruntime-gpu`（1.31+）是 **CUDA 13** 栈，
而 CUDA 13 已经把 Maxwell/Pascal/Volta 移除（最低 sm_75）→ P4 上永远跑不起来。
能跑 Pascal 的组合是 **ORT 1.19.2 + CUDA 12.4 + cuDNN 9.1**，所以：

```bash
# 1) CUDA 12 运行库（不需要驱动，只要 .so）
pip download --no-deps -d /tmp/cuda nvidia-cublas-cu12==12.4.5.8 nvidia-cudnn-cu12==9.1.0.70 nvidia-cuda-runtime-cu12==12.4.127
# 解包后把 lib/ 下的 *.so* 全部拷到 ./cuda12/
# 2) ORT 1.19.2
pip install --no-cache-dir --target ./pylib119 onnxruntime-gpu==1.19.2
# 3) 基础依赖
pip install --no-cache-dir --target ./pylib numpy tokenizers
```

`start.sh` 会自动检查 `cuda12/libcublasLt.so.12` 与 `cuda12/libcudnn.so.9` 是否存在，
缺了就**退回 CPU**（服务仍可用，只是慢），并在日志里说清楚。

## 部署（fnOS 实测路径）

```bash
# 目录约定与其它 compose 项目一致：/vol1/1000/Docker/compose/<项目>/
cd /vol1/1000/Docker/compose/dsh-embed
# 放好 model/ 与 model-rerank/（见上方"目录"）
docker compose up -d          # 首次会 pip install，约 1~2 分钟
curl -s http://127.0.0.1:18000/ | head
```

`compose.yaml` 里两个关键项：

- `deploy.resources.reservations.devices[driver=nvidia]` —— 等价于 `--gpus all`
  （fnOS 的容器 API 没有 GPU 开关，直接用 compose 最省事）
- Traefik 标签 —— 对外暴露为 `https://dsh-embed.example.com`

## 端点

```
GET  /                自述：ready / model / tag / providers / rerank_ready / rerank_err
GET  /health          同上
GET  /log?n=200       日志尾巴
POST /embed           {"texts":[...], "is_query":false} -> {"vectors_b64": "<base64 float32 LE, N*dim>", "dim", "count", "ms"}
POST /rerank          {"query":"…","texts":[...],"max_tokens":256} -> {"scores":[...], "ms"}
```

**`tag` 是这套方案的关键**：它等于 `模型名-模型文件内容哈希-精度`，与插件
`lib/embedder.js` 的 `modelFingerprint()` **逐字节同一算法**。客户端据此确认
"远端和本机是同一份模型"，于是切换后端**不需要重建索引**；对不上就不回退（避免两种
向量混进一个索引）。实测 NAS 自述 `bge-base-zh-v1.5-c4fa1e57-fp16`，与本机算出的完全一致。

## 安全

- 服务本身只在局域网/内网可信的前提下使用。
- 需要一点门槛时设 `API_KEY=<随机串>`：之后所有 `POST` 都要求 `Authorization: Bearer <key>`，
  客户端在 `embedding.remote.apiKey` / `rerankRemote.apiKey` 里配同一个值。
- 暴露到公网请在 Traefik 上加 basicAuth / IP 白名单，不要只靠 `API_KEY`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MODEL_DIR` | `/app/model` | 嵌入模型目录 |
| `MODEL_NAME` | 目录名（`model` → `bge-base-zh-v1.5`） | 参与 tag 计算 |
| `RERANK_MODEL_DIR` | `/app/model-rerank` | 重排模型目录；缺文件时 `rerank_ready=false` |
| `RERANK_BATCH` | `8` | 重排批大小（P4 8 GB 显存下 16 也够） |
| `RERANK_MAX_TOKENS` | `256` | 与插件默认一致 |
| `ORT_THREADS` | `6` | CPU 线程（GPU 路径下只影响回退） |
| `ORT_PROVIDERS` | `CUDAExecutionProvider,CPUExecutionProvider` | 执行提供者顺序 |
| `API_KEY` | 空 | 设了就要求 Bearer |
| `PORT` | `8000` | 容器内监听端口 |
