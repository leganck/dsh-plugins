# jina-code 嵌入变体（`embed-jina`）

默认镜像用 `bge-base-zh-v1.5`（MIT，中文强、512 上下文）。本变体换成
**`jina-embeddings-v2-base-code`**（Apache-2.0，代码检索更强、768 维同维、8192 上下文）。

## 什么时候用

| 场景 | 建议 |
|---|---|
| 仓库以中文注释/文档为主，查询也是中文 | bge 够用（本仓库实测中文 hit@5 88% vs 90%，差距很小） |
| **查询里有大量英文/跨语言代码检索** | **用 jina**（英文 hit@5 66% → 92%） |
| 需要长上下文（整函数/整文件块） | jina（8192 vs 512） |
| 只是想要"更快" | 别换：两者在 P4 上延迟基本一样 |

## 实测（2026-10-21，NAS Tesla P4 / CUDA 12 + ORT 1.19.2）

同一语料（300 块 / 48 文件）+ 100 条查询（50 中文 + 50 英文），按命中预期文件计：

| 指标 | bge-base-zh-v1.5 | jina-v2-base-code |
|---|---|---|
| hit@5 | 77% | **91%** |
| hit@1 | 42% | **62%** |
| MRR | 0.548 | **0.727** |
| 中文 hit@5 | 88% | 90% |
| 英文 hit@5 | 66% | **92%** |
| 单条延迟（40 行块，GPU） | 35.9 ms | 35.0 ms（fp16） |
| 吞吐（batch32，GPU） | 25.6 块/s | 21.0 块/s |
| 镜像体积（docker 显示/未压缩） | latest-gpu 3.06 GB | **jina-gpu 3.18 GB** |
| 镜像体积（cpu） | latest-cpu 485 MB | **jina-cpu 603 MB** |
| 维度 | 768 | 768 |
| 上下文 | 512 | 8192（服务默认仍截断 512，可用 `MAX_TOKENS` 调大） |

> 延迟会随文本长度显著变化：3 行小片段 bge 约 7 ms，40 行块约 36 ms。比较时务必用同一批文本。

## 来源与许可

- 上游：<https://huggingface.co/jinaai/jina-embeddings-v2-base-code>（Apache-2.0）
- 结构：JinaBert（ALiBi 自定义注意力），需要 `trust_remote_code` 加载
  （代码来自 `jinaai/jina-bert-v2-qk-post-norm`）
- 再分发遵守 Apache-2.0：保留版权与许可声明、标注来源与修改。

## 我们做了什么（修改说明）

1. **导出 ONNX**：`torch.onnx.export`（opset 17，动态 batch/seq）；
2. **mean pooling + L2 归一化烘焙进图**：输出直接是 `[batch, 768]`，
   与 bge 的"3D hidden + CLS pooling"不同，服务端走 `POOLING=auto` 的 2D 分支；
3. **fp16 转换**：`onnxruntime.transformers.float16`，`keep_io_types=True`；
4. **不修改权重**。

导出脚本：`scripts/export-jina-onnx.py`（可复现，导出后打印 sha256 清单）。

## 产物与校验

| 文件 | 大小 | sha256 前缀 |
|---|---|---|
| `model_fp16.onnx` | 321 MB | `0b8988c2…` |
| `tokenizer.json` | 2.4 MB | `b01c78a9…` |
| `config.json` | 1.2 KB | `e426aa68…` |
| `tokenizer_config.json` | 0.5 KB | `f477aeb1…` |
| `special_tokens_map.json` | 0.3 KB | `06e405a3…` |

完整清单：`scripts/jina-v2.sha256`。

## 获取模型

模型不进 git（321 MB），发布在 GitHub Release：

```bash
node scripts/fetch-jina-model.mjs                 # 默认 release：dsh-embed-jina-v0.1.0
node scripts/fetch-jina-model.mjs --check         # 只校验本地
node scripts/fetch-jina-model.mjs --from ./dist   # 从内网/离线目录复制
```

或从源码重新导出（需要 torch+transformers+onnx+onnxconverter-common）：

```bash
python scripts/export-jina-onnx.py \
  --src jinaai/jina-embeddings-v2-base-code --out models/model-jina
```

## 构建镜像

```bash
node scripts/fetch-jina-model.mjs
docker buildx build --build-context models=./models \
  --build-arg FLAVOR=gpu --target embed-jina -t dsh-embed:jina-gpu .
```

CPU 版把 `FLAVOR=gpu` 换成 `cpu`。产物标签：`ghcr.io/leganck/dsh-embed:jina-gpu` / `jina-cpu`。

发布流水线：`.github/workflows/publish-jina-image.yml`
（tag `dsh-embed-jina-v*` 或手动 dispatch；构建前从同名 Release 拉模型并校验 sha256）。

## 运行（与 bge 的差异全部由镜像 ENV 表达）

| 环境变量 | bge 镜像 | jina 镜像 | 原因 |
|---|---|---|---|
| `MODEL_NAME` | 空（推导为 bge-base-zh-v1.5） | `jina-embeddings-v2-base-code` | 向量 tag 可读 |
| `POOLING` | `cls` | `auto` | jina 输出已是 2D pooled |
| `QUERY_PREFIX` | 中文检索指令 | 空 | jina v2 不需要指令前缀 |
| `PAD_TOKEN` / `PAD_ID` | `[PAD]` / 0 | `<pad>` / 1 | tokenizer 词表不同 |
| `SEP_ID` | 102（BERT `[SEP]`） | 0（禁用） | jina 是 Llama 词表，没有 102 这个特殊 token |

```bash
docker run -d --name dsh-embed -p 127.0.0.1:18000:8000 \
  -v dsh-embed-data:/data --gpus all \
  ghcr.io/leganck/dsh-embed:jina-gpu
curl -s localhost:18000/health | python -m json.tool
```

`/health.tag` 会变成 `jina-embeddings-v2-base-code-<fingerprint>-fp16`。

## 切回 bge

镜像/`MODEL_DIR` 换回 `latest-gpu` 即可。注意 **tag 变化会触发客户端全量重嵌**（这是预期行为）：
两套模型不能共用同一份索引。

## 已知限制

- 吞吐比 bge 低约 18%（P4 实测），大规模首建索引会慢一点；
- `MAX_TOKENS` 默认 512（服务端常量），8192 上下文需要显式调大（显存/显存增长要评估）；
- kNN 是精确解，索引维度同为 768，无需迁移数据格式。
