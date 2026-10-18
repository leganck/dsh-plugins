#!/bin/sh
# 容器入口：把 CUDA 库路径、模型文件、/data 权限这些"容易在运行时才炸"的事提前到启动阶段说清楚。
#
# 设计原则：**能降级就降级，降不了就大声失败**。
#   - GPU 库缺 → 退回 CPU 并告警（服务仍可用，只是慢）；
#   - 没有重排模型 → 只提示一句（rerank_ready=false 是正常状态，客户端会自动回退）；
#   - 连嵌入模型都没有 → 直接退出并说明怎么修（避免"起来了但 /embed 全 500"）。
set -eu

APP=/app
MODEL_DIR="${MODEL_DIR:-/models/model}"
RERANK_MODEL_DIR="${RERANK_MODEL_DIR:-/models/model-rerank}"
DATA_DIR="$(dirname "${SERVER_DB:-/data/index.db}")"

log() { printf '[entrypoint] %s\n' "$*"; }

# ---------------------------------------------------------------- 1) /data 可写
if ! mkdir -p "$DATA_DIR" 2>/dev/null || [ ! -w "$DATA_DIR" ]; then
  log "错误：$DATA_DIR 不可写（容器以 uid 10001 运行）。"
  log "      宿主机上执行：docker run --rm -v <卷名>:/data busybox chown -R 10001:10001 /data"
  exit 78
fi
mkdir -p "$(dirname "${SERVER_LOG:-/data/server.log}")" 2>/dev/null || true

# ---------------------------------------------------------------- 2) CUDA 库路径
# pip wheel 把库放在 site-packages/nvidia/*/lib；Pascal 老路径可能把库挂在 /opt/cuda12。
cuda_dirs="$(python - <<'PY'
import glob, os, sysconfig
base = sysconfig.get_paths().get("purelib") or ""
dirs = sorted(glob.glob(os.path.join(base, "nvidia", "*", "lib")))
print(":".join(dirs))
PY
)"
if [ -d /opt/cuda12 ]; then
  cuda_dirs="${cuda_dirs:+$cuda_dirs:}/opt/cuda12"
fi

have_cublas=0
have_cudnn=0
old_ifs="$IFS"; IFS=:
for d in $cuda_dirs; do
  [ -d "$d" ] || continue
  for f in "$d"/libcublasLt.so.12*; do [ -e "$f" ] && have_cublas=1; done
  for f in "$d"/libcudnn.so.9*; do [ -e "$f" ] && have_cudnn=1; done
done
IFS="$old_ifs"

FLAVOR="$(cat /app/.flavor 2>/dev/null || echo cpu)"
if [ -z "${ORT_PROVIDERS:-}" ]; then
  if [ "$FLAVOR" = "gpu" ]; then
    ORT_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider
  else
    ORT_PROVIDERS=CPUExecutionProvider
  fi
  export ORT_PROVIDERS
fi
log "flavor=$FLAVOR，ORT_PROVIDERS=$ORT_PROVIDERS"

wants_cuda=0
case "$ORT_PROVIDERS" in
  *CUDA*) wants_cuda=1 ;;
esac

if [ -n "$cuda_dirs" ]; then
  export LD_LIBRARY_PATH="$cuda_dirs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

if [ "$wants_cuda" = "1" ]; then
  # 设备比库更关键：容器没做 GPU 设备预留时 /dev/nvidia0 不存在，
  # ORT 1.19.2 的 CUDA provider 在这种情况下会**段错误**（实测 Exited 139），
  # 而不是优雅降级。所以先看设备，再决定用不用 CUDA。
  if [ ! -e /dev/nvidia0 ]; then
    log "警告：要求 CUDA，但容器内没有 /dev/nvidia0 —— 说明没做 GPU 设备预留。"
    log "      用 compose 的话叠加：docker compose -f compose.yaml -f compose.gpu.yaml up -d"
    log "      （并确认宿主机装了 nvidia-container-toolkit）。本次退回 CPU。"
    ORT_PROVIDERS=CPUExecutionProvider
    export ORT_PROVIDERS
  elif [ "$have_cublas" = "0" ] || [ "$have_cudnn" = "0" ]; then
    log "警告：要求 CUDA，但找不到 libcublasLt.so.12 / libcudnn.so.9 → 本次退回 CPU。"
    log "      常见原因：拉的是 cpu 镜像、或 GPU 库没随镜像安装（用 --build-arg FLAVOR=gpu 构建）。"
    ORT_PROVIDERS=CPUExecutionProvider
    export ORT_PROVIDERS
  else
    log "CUDA 就绪（设备 /dev/nvidia0 + 库 $cuda_dirs）"
  fi
fi

# ---------------------------------------------------------------- 3) 模型检查
if [ "${FAKE_EMBED:-}" != "" ] && [ "${FAKE_EMBED}" != "0" ]; then
  log "FAKE_EMBED=$FAKE_EMBED：不加载模型（自测/冒烟模式）"
else
  if ! ls "${MODEL_DIR}"/model*.onnx >/dev/null 2>&1 || [ ! -f "${MODEL_DIR}/tokenizer.json" ]; then
    log "错误：嵌入模型不完整：${MODEL_DIR}"
    log "      需要 model_fp16.onnx（或 model.onnx / model_int8.onnx）+ tokenizer.json。"
    log "      修复方式二选一："
    log "        1) 用内置模型的镜像：ghcr.io/leganck/dsh-embed:latest-cpu / latest-gpu"
    log "        2) 用 nomodel 镜像并挂载：-v /path/to/models:/models:ro"
    exit 78
  fi
  if ls "${RERANK_MODEL_DIR}"/model*.onnx >/dev/null 2>&1 && [ -f "${RERANK_MODEL_DIR}/tokenizer.json" ]; then
    log "重排模型就绪：${RERANK_MODEL_DIR}"
  else
    log "提示：没有重排模型（正常）→ /health 会报 rerank_ready=false，客户端自动回退本机重排。"
    log "      需要远端重排就用 -rerank 变体，或把模型挂到 ${RERANK_MODEL_DIR}。"
  fi
fi

# ---------------------------------------------------------------- 4) 启动
# 显式给了命令就照办（例如 docker run … python /app/selftest.py）。
# 不加这段的话 ENTRYPOINT 会把任何命令都吞掉、一律起服务 —— 冒烟测试会"看起来卡住"。
if [ "$#" -gt 0 ]; then
  log "执行自定义命令：$*"
  exec "$@"
fi

log "启动 server.py（PORT=${PORT:-8000}，ORT_PROVIDERS=${ORT_PROVIDERS:-CPUExecutionProvider}）"
exec python -u "$APP/server.py"
