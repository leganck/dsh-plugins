#!/bin/sh
# review-service 入口脚本：只做三件事——查目录可写、查必填环境、启动。
# 配置缺失时以 EX_CONFIG(78) 退出，并把"缺什么、怎么补"打在日志里（容器起不来时最有用）。
set -eu

log() { printf '%s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

DATA_DIR="${DATA_DIR:-/data}"

# ---------------------------------------------------------------- 1) 数据目录
if [ ! -d "$DATA_DIR" ]; then
  log "错误：数据目录不存在：$DATA_DIR（请挂载卷到 $DATA_DIR）"
  exit 78
fi
if ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  log "错误：$DATA_DIR 不可写。容器以 uid 10001 运行，宿主机目录属主需要是 10001："
  log "      docker run --rm -v <你的卷>:/data busybox chown -R 10001:10001 /data"
  exit 78
fi
rm -f "$DATA_DIR/.write-test"

# ---------------------------------------------------------------- 2) 必填环境
missing=""
[ -n "${GITLAB_URL:-}" ] || missing="$missing GITLAB_URL"
[ -n "${GITLAB_TOKEN:-}" ] || missing="$missing GITLAB_TOKEN"
[ -n "${WEBHOOK_SECRET:-}" ] || missing="$missing WEBHOOK_SECRET"
[ -n "${LLM_API_KEY:-}" ] || missing="$missing LLM_API_KEY"
if [ -n "$missing" ]; then
  log "错误：缺少必填环境变量：$missing"
  log "      参考 /app/../.env.example，或设置 DRY_RUN=1 只做影子模式（仍然需要 GitLab 凭据）"
  exit 78
fi

if [ -z "${INDEX_URL:-}" ]; then
  log "提示：没有配置 INDEX_URL（code-index-service）→ 评审只能看到 diff，没有跨文件上下文。"
fi
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "提示：DRY_RUN=1 —— 只生成评论内容，不向 GitLab 发送任何请求。"
fi

log "启动 dsh-review（$DATA_DIR，端口 ${PORT:-8000}，workers=${WORKERS:-2}）"
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec python -u -m app.main
