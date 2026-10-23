# syntax=docker/dockerfile:1.7
#
# 应用层镜像：从已发布的 base 镜像出发，只叠加**当前代码 + 模型**。
#
# 为什么单独拆出来：
#   - base（apt + 1.5GB pip 依赖）只在 Dockerfile 依赖层变化时构建；
#   - 普通服务端改代码（server.py / index_store.py / admin 页面）只走这个文件，
#     不再重新装 onnxruntime-gpu / nvidia-*，发布从分钟级降到秒级；
#   - 模型仍通过命名 build context `models` 传入，与 Dockerfile 的 embed target 一致。
#
# 构建示例：
#   docker buildx build \
#     --build-arg BASE_IMAGE=ghcr.io/leganck/dsh-embed:base-gpu \
#     --build-arg VERSION=0.15.0 \
#     --build-context models=./models \
#     -f Dockerfile.app -t dsh-embed:app-gpu .
#
# 注意：BASE_IMAGE 必须与模型/入口脚本匹配的 flavor（cpu/gpu）。

ARG BASE_IMAGE=ghcr.io/leganck/dsh-embed:base-cpu
FROM ${BASE_IMAGE}

ARG VERSION=dev

# 模型层：build context `models` 里由 scripts/fetch-models.mjs 准备
COPY --from=models /model /models/model

# 服务端代码只覆盖 /app，不碰依赖层
USER root
COPY --chown=10001:10001 \
  server.py index_store.py knn.py governor.py embedder.py reranker.py \
  model_downloader.py admin_store.py models_admin.py runtime_metrics.py \
  runtime_preflight.py selftest.py bench_knn_modes.py scope_format.json favicon.svg \
  /app/
COPY --chown=10001:10001 docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh

LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="dsh-embed" \
      org.opencontainers.image.description="DSH code index service (app layer)"

USER 10001:10001
