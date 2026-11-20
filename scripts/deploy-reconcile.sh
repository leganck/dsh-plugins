#!/bin/sh
# 生产容器换新镜像（带 reconcile 自愈），保留 int8 模型挂载与全部 env
set -e
# 凭据从环境变量取：export API_KEY=... ADMIN_PASSWORD=...（仓库里不留明文）
docker rm -f dsh-embed >/dev/null 2>&1 || true
docker run -d --name dsh-embed \
  -p 18000:8000 \
  -v dsh-embed-data:/data \
  -v /srv/dsh-preview/model-int8:/models/model-int8:ro \
  -e MODEL_DIR=/models/model-int8 \
  -e API_KEY="${API_KEY:?请先 export API_KEY}" \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD="${ADMIN_PASSWORD:?请先 export ADMIN_PASSWORD}" \
  -e TZ=Asia/Shanghai \
  -e ORT_THREADS=4 \
  -e EMBED_RATE=25 \
  -e MAX_TOTAL_GB=20 \
  --restart unless-stopped \
  dsh-embed:v2-preview >/dev/null
echo "  已启动（int8 + EMBED_RATE=25）"
for i in $(seq 1 20); do
  sleep 3
  if docker exec dsh-embed python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3).status==200 else 1)" 2>/dev/null; then
    echo "  healthy（$((i*3))s）"; break
  fi
done
echo "== reconcile 日志 =="
docker logs dsh-embed 2>&1 | grep -iE "reconcile|embed ready|index store ready" | tail -4
echo "== 观察 30 秒吞吐 =="
b=$(docker exec dsh-embed python -c "import sqlite3;print(sqlite3.connect('/data/index.db').execute('select count(*) from vectors').fetchone()[0])")
sleep 30
a=$(docker exec dsh-embed python -c "import sqlite3;print(sqlite3.connect('/data/index.db').execute('select count(*) from vectors').fetchone()[0])")
echo "  vectors: $b → $a（30s，约 $(( (a-b)/30 )) 块/s）"
docker exec dsh-embed python -c "
import sqlite3
c = sqlite3.connect('/data/index.db')
print('  chunks =', c.execute('select count(*) from chunks').fetchone()[0],
      '| vectors =', c.execute('select count(*) from vectors').fetchone()[0],
      '| tags =', c.execute('select tag, count(*) from vectors group by tag').fetchall())"
