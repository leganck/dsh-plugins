#!/bin/sh
# dsh-embed 启动脚本
#
# 目标：让 /embed 服务**优先跑在 GPU 上**（Tesla P4 / Pascal sm_61）。
#
# 为什么不是"直接 pip install onnxruntime-gpu"：
#   - pip 默认给的是 ORT 1.31，那是 **CUDA 13** 栈（需要 libcublasLt.so.13），
#     而 CUDA 13 已经把 Maxwell/Pascal/Volta 移除（最低 sm_75）→ P4 永远跑不起来。
#   - 能跑 Pascal 的是 **ORT 1.19.x + CUDA 12.4 + cuDNN 9.1**，已在 /app/pylib119 + /app/cuda12 备好。
#   - 若 CUDA 库缺失，自动退回 CPU（服务仍可用，只是慢）。
set -e

PIP_MIRROR="${PIP_MIRROR:-https://mirrors.aliyun.com/pypi/simple/}"

# 注：不需要 apt 装 libgomp —— 实测 python:3.11-slim 里 ORT 能直接 import（曾因 apt 拉 deb.debian.org
# 极慢而卡住 3 分钟以上，故整段删掉）。

# 基础依赖（numpy / tokenizers）走 /app/pylib；CUDA 版 ORT 单独放 /app/pylib119
if [ ! -d /app/pylib/tokenizers ]; then
  echo "[start] installing base deps (numpy, tokenizers) from $PIP_MIRROR"
  pip install --no-cache-dir --target /app/pylib -i "$PIP_MIRROR" numpy tokenizers 2>&1 | tail -3
fi

USE_GPU=0
if [ -f /app/cuda12/libcublasLt.so.12 ] && [ -f /app/cuda12/libcudnn.so.9 ]; then
  if [ ! -d /app/pylib119/onnxruntime ]; then
    echo "[start] installing onnxruntime-gpu==1.19.2 (CUDA 12 stack) from $PIP_MIRROR"
    pip install --no-cache-dir --target /app/pylib119 -i "$PIP_MIRROR" onnxruntime-gpu==1.19.2 2>&1 | tail -3
  fi
  USE_GPU=1
else
  echo "[start] WARN: /app/cuda12 缺少 libcublasLt.so.12 / libcudnn.so.9 → 走 CPU"
  if [ ! -d /app/pylib/onnxruntime ]; then
    pip install --no-cache-dir --target /app/pylib -i "$PIP_MIRROR" onnxruntime-gpu 2>&1 | tail -3
  fi
fi

if [ "$USE_GPU" = "1" ]; then
  export PYTHONPATH=/app/pylib119:/app/pylib
  export LD_LIBRARY_PATH=/app/cuda12:${LD_LIBRARY_PATH}
  echo "[start] launching server.py (CUDA 12 / ORT 1.19.2)"
else
  export PYTHONPATH=/app/pylib
  echo "[start] launching server.py (CPU)"
fi

exec python /app/server.py
