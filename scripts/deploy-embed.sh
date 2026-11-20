#!/bin/bash
# 部署 dsh-embed 到目标机（保留：环境变量、数据卷、端口）
#
# 用法（凭据不落盘、不进 git）：
#   export INDEX_API_KEY='...' ADMIN_PASSWORD='...'
#   ssh root@192.168.50.112 'bash -s' < scripts/deploy-embed.sh
#
# 回滚：旧容器被改名为 dsh-embed-prev（不删除），
#   docker rm -f dsh-embed && docker rename dsh-embed-prev dsh-embed && docker start dsh-embed
set -uo pipefail

IMAGE="${IMAGE:-ghcr.io/leganck/dsh-embed:latest-cpu}"
BACKUP_NAME="${BACKUP_NAME:-dsh-embed-prev}"
HOST_PORT="${HOST_PORT:-18000}"
VOLUME="${VOLUME:-dsh-embed-data}"

# 凭据必须由调用方通过环境变量注入；缺了就用容器内已有的旧值（首次部署必须给）
: "${INDEX_API_KEY:?需要 INDEX_API_KEY 环境变量}"
: "${ADMIN_PASSWORD:?需要 ADMIN_PASSWORD 环境变量}"

echo "== 1. 当前容器配置快照（回滚依据）"
docker inspect dsh-embed --format '{{json .Config.Env}}' > /tmp/old-env.json 2>/dev/null
docker inspect dsh-embed --format '{{json .Mounts}}' > /tmp/old-mounts.json 2>/dev/null
echo "已存 /tmp/old-env.json /tmp/old-mounts.json"

echo "== 2. 停旧容器并改名（不删，便于回滚）"
docker rm -f "$BACKUP_NAME" >/dev/null 2>&1
docker stop dsh-embed >/dev/null 2>&1
docker rename dsh-embed "$BACKUP_NAME" 2>/dev/null && echo "旧容器已改名 $BACKUP_NAME"

echo "== 3. 起新容器（$IMAGE）"
docker run -d --name dsh-embed --restart unless-stopped \
  -p "${HOST_PORT}:8000" \
  -v "${VOLUME}:/data" \
  -e EMBED_RATE="${EMBED_RATE:-10}" \
  -e API_KEY="$INDEX_API_KEY" \
  -e ADMIN_USER="${ADMIN_USER:-admin}" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e MAX_TOTAL_GB="${MAX_TOTAL_GB:-20}" \
  -e TZ="${TZ:-Asia/Shanghai}" \
  -e ORT_THREADS="${ORT_THREADS:-4}" \
  "$IMAGE"

echo "== 4. 等待健康检查"
for i in $(seq 1 40); do
  if curl -sf -m 3 "http://127.0.0.1:${HOST_PORT}/health" >/dev/null 2>&1; then
    echo "healthy after ~$((i*5))s"
    break
  fi
  sleep 5
done

echo "== 5. 能力自检"
curl -s "http://127.0.0.1:${HOST_PORT}/health" | head -c 300; echo
echo "-- memories 端点:"
curl -s -H "Authorization: Bearer $INDEX_API_KEY" "http://127.0.0.1:${HOST_PORT}/v1/memories?limit=1" | head -c 120; echo
echo "-- admin 页面标签页（v0.17 应有 经验/代码资产）:"
curl -s -b "dsh_admin=dummy" "http://127.0.0.1:${HOST_PORT}/admin" | grep -o 'data-tab="[a-z]*"' | sort -u | tr '\n' ' '; echo
echo "== 完成"
