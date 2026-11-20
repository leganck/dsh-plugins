#!/bin/sh
# 生产容器切到 int8 模型（CPU EP 无 fp16 kernel：fp16 实测 1.2 块/s，int8 31 块/s）
# 用法：cat switch-int8.sh | ssh root@112 'bash -s'
set -e
# 凭据从环境变量取：export API_KEY=... ADMIN_PASSWORD=...（仓库里不留明文）

echo "== 1) 清掉 fp32 半成品，确认 int8 模型就绪 =="
rm -f /srv/dsh-preview/model-fp32/model.onnx.part /srv/dsh-preview/model-fp32/model.onnx 2>/dev/null || true
ls -l /srv/dsh-preview/model-int8/

echo "== 2) 记录切换前状态 =="
docker exec dsh-embed python -c "
import sqlite3
c = sqlite3.connect('/data/index.db')
print('  chunks =', c.execute('select count(*) from chunks').fetchone()[0],
      '| vectors =', c.execute('select count(*) from vectors').fetchone()[0],
      '| tags =', c.execute('select tag, count(*) from vectors group by tag').fetchall())
"

echo "== 3) 重建容器：挂 int8 模型目录 + MODEL_DIR =="
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
  -e EMBED_RATE=10 \
  -e MAX_TOTAL_GB=20 \
  --restart unless-stopped \
  dsh-embed:v2-preview >/dev/null
echo "  已启动（int8）"

echo "== 4) 等健康 + 读 tag =="
for i in $(seq 1 30); do
  sleep 3
  out=$(docker exec dsh-embed python -c "
import json,urllib.request
print(json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3)).get('tag',''))
" 2>/dev/null || true)
  if [ -n "$out" ]; then echo "  healthy, tag=$out（${i}0 秒内）"; break; fi
done

echo "== 5) 观察 30 秒吞吐 =="
before=$(docker exec dsh-embed python -c "import sqlite3;print(sqlite3.connect('/data/index.db').execute('select count(*) from vectors').fetchone()[0])")
sleep 30
after=$(docker exec dsh-embed python -c "import sqlite3;print(sqlite3.connect('/data/index.db').execute('select count(*) from vectors').fetchone()[0])")
echo "  vectors: $before → $after（30 秒，约 $(( (after-before)/30 )) 块/s）"
docker logs --tail 3 dsh-embed 2>&1 | grep -vE "^\[entrypoint\]"
