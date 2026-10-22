#
# dsh-embed —— 远端索引服务（/v1 索引层 + /embed + /rerank）
#
# 一条 Dockerfile 出 4 种镜像：base（无模型）、nomodel、embed（开箱即用）、embed-rerank。
#   docker buildx build --build-context models=./models --build-arg FLAVOR=cpu  --target embed        -t dsh-embed:cpu-embed .
#   docker buildx build                                                --build-arg FLAVOR=gpu  --target base -t dsh-embed:base-gpu .
#   docker buildx build                                                --build-arg FLAVOR=cpu  --target nomodel …
#
# 为什么模型用独立 build context（`--build-context models=./models`）而不是放主上下文：
#   - 主上下文保持只有几十 KB，改一行 Python 不会让 750 MB 模型重新上传/重新哈希；
#   - 模型目录可以被 `scripts/fetch-models.mjs` 单独准备和缓存（CI 用 actions/cache）。
#
# 为什么用 pip 装 CUDA 12（cublas/cudnn wheel）而不是 `nvidia/cuda` 基础镜像：
#   Tesla P4 是 Pascal（sm_61）。pip 上最新的 onnxruntime-gpu（1.31+）是 CUDA 13 栈，
#   而 CUDA 13 已移除 Maxwell/Pascal/Volta（最低 sm_75）→ P4 永远跑不起来。
#   能跑 Pascal 的组合是 **ORT 1.19.2 + CUDA 12.4 + cuDNN 9.1**；pip wheel 里就带
#   libcublasLt.so.12 / libcudnn.so.9，镜像比 CUDA 基础镜像小一半还不依赖宿主 CUDA。

ARG PYTHON_IMAGE=python:3.11-slim-bookworm

# ---------------------------------------------------------------- 依赖底座
# 只装系统依赖 + Python 依赖，**不 COPY 业务代码**：
# 改 server.py 不会让这层 1.5 GB 的 pip install 失效。
# （之前代码 COPY 在 RUN pip 之前，每次改代码都要重装 onnxruntime-gpu/nvidia-*，
#   单次构建多花 4~6 分钟；2026-10-21 拆开。）
FROM ${PYTHON_IMAGE} AS deps

ARG FLAVOR=cpu
ARG VERSION=dev
# FROM 之前声明的 ARG 不进 stage 作用域；LABEL 里要用就得重新声明（否则 buildkit 报 UndefinedVar）
ARG PYTHON_IMAGE

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000 \
    MODEL_DIR=/models/model \
    RERANK_MODEL_DIR=/models/model-rerank \
    SERVER_DB=/data/index.db \
    SERVER_LOG=/data/server.log \
    ORT_THREADS=6 \
    EMBED_RATE=10 \
    WARMUP=1

# libgomp1：onnxruntime 需要；ca-certificates：拉模型/走 HTTPS 时的 CA
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 版本固定的理由：numpy 2.x 与 ORT 1.19.x 的 ABI 组合没有实测过（1.26.4 是长期验证过的）；
# tokenizers 固定版本保证 tokenizer.json 解析行为可复现。改这两个版本必须重跑 selftest。
# 依赖分三步装，每一步都是为了减体积（实测：不分步时 cpu 底座 388 MB）：
#   1) tokenizers 用 --no-deps：它会拖 huggingface_hub/hf-xet/requests/PyYAML/tqdm…（≈40 MB），
#      而服务端只用 Tokenizer.from_file() 读本地 tokenizer.json，这些运行时用不到。
#   2) onnxruntime 正常装（protobuf/flatbuffers/coloredlogs 是硬依赖）。
#   3) **gpu flavor 必须多装 curand 与 cufft**：只装 cublas/cudnn 时，ORT 加载 CUDA provider 会报
#      `libcurand.so.10: cannot open shared object file` 然后**静默退回 CPU**（实测踩到：
#      镜像起来了、/health 也 ready，但 providers 只有 CPU —— 这种"以为在用 GPU"最难查）。
#   4) 装完再卸掉 sympy+mpmath（85 MB）：那是 onnxruntime 的形状推断工具用的，
#      实测加载真实 bge-base 并出向量（768 维）完全不受影响。
# 改这几行必须重跑容器内 selftest 与一次真实 /embed。
RUN pip install --no-cache-dir "numpy==1.26.4" \
 && pip install --no-cache-dir --no-deps "tokenizers==0.20.3" \
 && if [ "$FLAVOR" = "gpu" ]; then \
      pip install --no-cache-dir "onnxruntime-gpu==1.19.2" \
                  "nvidia-cublas-cu12==12.4.5.8" \
                  "nvidia-cudnn-cu12==9.1.0.70" \
                  "nvidia-cuda-runtime-cu12==12.4.127" \
                  "nvidia-curand-cu12==10.3.5.147" \
                  "nvidia-cufft-cu12==11.2.1.3" ; \
    else \
      pip install --no-cache-dir "onnxruntime==1.19.2" ; \
    fi \
 && pip uninstall -y sympy mpmath >/dev/null 2>&1 || true

# 把 flavor 写进镜像：入口脚本据此决定 ORT_PROVIDERS 默认值
# （gpu 镜像默认 CUDA,CPU，发现库缺失再降级 CPU；cpu 镜像固定 CPU；用户显式设置永远优先）
RUN echo "${FLAVOR}" > /app/.flavor \
 && useradd -u 10001 -m -s /usr/sbin/nologin app \
 && mkdir -p /data /models \
 && chown -R app:app /data /app
USER 10001:10001

# ---------------------------------------------------------------- 应用层
# 只有这层随业务代码变化：COPY 几个 .py（<1 MB），依赖层全缓存
FROM deps AS base
COPY --chown=10001:10001 server.py index_store.py knn.py governor.py embedder.py reranker.py model_downloader.py admin_store.py models_admin.py runtime_metrics.py runtime_preflight.py selftest.py bench_knn_modes.py scope_format.json favicon.svg /app/
COPY --chown=10001:10001 docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh
USER 10001:10001

VOLUME ["/data"]
EXPOSE 8000

# 健康检查用 python 标准库（不额外装 curl）：容器内打本机 /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status==200 else 1)"

LABEL org.opencontainers.image.title="dsh-embed (code-index service)" \
      org.opencontainers.image.description="Remote index layer + /embed + /rerank for the DSH code-index plugin" \
      org.opencontainers.image.source="https://github.com/leganck/dsh-plugins" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.base.name="${PYTHON_IMAGE}" \
      dev.dsh.flavor="${FLAVOR}"

ENTRYPOINT ["/app/docker-entrypoint.sh"]

# ---------------------------------------------------------------- 不带模型（模型走挂载）
FROM base AS nomodel
# 用法：-v /path/to/models:/models:ro（里面要有 model/ 与可选的 model-rerank/）

# ---------------------------------------------------------------- 嵌入模型（默认开箱即用）
FROM base AS embed
# 目录名必须是 model：embedder.py 用 basename=='model' 推导模型名，
# 改名会让向量标签（tag）变化 → 客户端全量重嵌。
COPY --from=models /model /models/model

# ---------------------------------------------------------------- 嵌入模型（jina-code 变体）
# 代码检索专用：jina-embeddings-v2-base-code（Apache-2.0，768 维，8k 上下文）。
# 与 bge 的差异全部用 ENV 表达，不需要改 Python：
#   - ONNX 图内已烘焙 mean pooling + L2 归一化 → 输出 [batch,768]（2D 分支直接使用）
#   - 不需要 query 指令前缀（QUERY_PREFIX 为空）
#   - tokenizer 的 pad 是 <pad> / id=1（bge 是 [PAD] / 0）
#   - 没有 BERT 的 [SEP]=102，禁用末位替换（SEP_ID=0）
# 构建：
#   docker buildx build --build-context models=./models --build-arg FLAVOR=gpu \
#     --target embed-jina -t dsh-embed:jina-gpu .
FROM base AS embed-jina
COPY --from=models /model-jina /models/model
ENV MODEL_NAME=jina-embeddings-v2-base-code \
    POOLING=auto \
    QUERY_PREFIX= \
    PAD_TOKEN=<pad> \
    PAD_ID=1 \
    SEP_ID=0

# ---------------------------------------------------------------- 嵌入 + 重排
FROM base AS embed-rerank
COPY --from=models /model /models/model
COPY --from=models /model-rerank /models/model-rerank
