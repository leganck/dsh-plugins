#!/bin/sh
# storage-hub v2 生产重置部署（在 112 上执行）
# 用法：cat deploy-v2.sh | ssh root@112 'bash -s'
set -e
# 凭据从环境变量取：export API_KEY=... ADMIN_PASSWORD=...（仓库里不留明文）

TS=$(date +%Y%m%d%H%M)
echo "== 1) 备份旧库（回滚用） =="
docker exec dsh-embed sh -c "cp /data/index.db /data/index.db.v1bak-$TS" || echo "  备份失败（容器可能已停），跳过"
docker exec dsh-embed sh -c "ls -la /data | head -5" || true
echo "  备份后缀: v1bak-$TS"

echo "== 2) 保留旧容器（改名不停，先不删） =="
docker rename dsh-embed dsh-embed-prev 2>/dev/null && echo "  已改名 dsh-embed-prev" || echo "  已是 prev 或不存在"
docker stop dsh-embed-prev >/dev/null 2>&1 || true
echo "  旧容器已停"

echo "== 3) 删除 v1 索引库（保留 admin.db / 模型 / 备份） =="
docker run --rm -v dsh-embed-data:/data alpine:3.20 sh -c 'rm -f /data/index.db /data/index.db-wal /data/index.db-shm; ls /data' 2>/dev/null \
  || docker run --rm -v dsh-embed-data:/data dsh-embed:v2-preview sh -c 'rm -f /data/index.db /data/index.db-wal /data/index.db-shm; ls -la /data | head -8'

echo "== 4) 起 v2 容器（同卷同端口同 env） =="
docker rm -f dsh-embed 2>/dev/null || true
docker run -d --name dsh-embed \
  -p 18000:8000 \
  -v dsh-embed-data:/data \
  -e API_KEY="${API_KEY:?请先 export API_KEY}" \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD="${ADMIN_PASSWORD:?请先 export ADMIN_PASSWORD}" \
  -e TZ=Asia/Shanghai \
  -e ORT_THREADS=4 \
  -e EMBED_RATE=10 \
  -e MAX_TOTAL_GB=20 \
  --restart unless-stopped \
  dsh-embed:v2-preview >/dev/null
echo "  已启动 dsh-embed:v2-preview"

echo "== 5) 等健康 =="
for i in $(seq 1 30); do
  sleep 3
  if docker exec dsh-embed python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3).status==200 else 1)" 2>/dev/null; then
    echo "  healthy（用时 $((i*3))s）"
    break
  fi
done

echo "== 6) 校验 v2 schema =="
docker exec dsh-embed python - <<'PY'
import sqlite3
c = sqlite3.connect("/data/index.db")
ver = c.execute("select value from meta where key='schema_version'").fetchone()
tabs = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like '%_fts_%' and name!='chunks_fts'")]
print("  schema_version =", ver[0] if ver else None, "| 表数 =", len(tabs))
print("  memories 行数 =", c.execute("select count(*) from memories").fetchone()[0],
      "| scopes 行数 =", c.execute("select count(*) from scopes").fetchone()[0])
PY

echo "== 7) 现状 =="
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E 'dsh-embed'
