#!/bin/sh
# 一次性安装：把凭据落到 112 本地（600）+ 安装并武装 fp32 自动切换脚本
# 用法：cat setup-auto-switch.sh | ssh root@112 'API_KEY=... ADMIN_PASSWORD=... bash -s'
set -e
umask 077
printf %s "${API_KEY:?}" > /srv/dsh-preview/.api_key
printf %s "${ADMIN_PASSWORD:?}" > /srv/dsh-preview/.admin_password
chmod 600 /srv/dsh-preview/.api_key /srv/dsh-preview/.admin_password
echo "  凭据文件已写（600）"

cat > /srv/dsh-preview/auto-switch-fp32.sh <<'INNER'
#!/bin/sh
set -u
DIR=/srv/dsh-preview/model-fp32
TARGET=380000000
LOG=/tmp/auto-switch-fp32.log
: > "$LOG"
echo "$(date +%H:%M) 等待 fp32 模型（目标 >${TARGET}B）" >> "$LOG"
for i in $(seq 1 160); do
  sleep 15
  [ -f "$DIR/model.onnx" ] || continue
  size=$(stat -c%s "$DIR/model.onnx" 2>/dev/null || echo 0)
  [ "$size" -ge "$TARGET" ] && break
done
size=$(stat -c%s "$DIR/model.onnx" 2>/dev/null || echo 0)
echo "$(date +%H:%M) 下载结束 size=$size" >> "$LOG"
if [ "$size" -lt "$TARGET" ]; then echo "  未达标，保持 fp16" >> "$LOG"; exit 0; fi
echo "$(date +%H:%M) 校验能否加载" >> "$LOG"
if ! docker run --rm -v "$DIR":/m:ro --entrypoint python dsh-embed:v2-preview -c "
import onnxruntime as ort
s = ort.InferenceSession('/m/model.onnx', providers=['CPUExecutionProvider'])
print('ok', [i.name for i in s.get_inputs()])
" >> "$LOG" 2>&1; then
  echo "  校验失败，保持 fp16" >> "$LOG"; exit 0
fi
echo "$(date +%H:%M) 切换到 fp32" >> "$LOG"
docker rm -f dsh-embed >/dev/null 2>&1 || true
docker run -d --name dsh-embed \
  -p 18000:8000 -v dsh-embed-data:/data -v "$DIR":/models/model-fp32:ro \
  -e MODEL_DIR=/models/model-fp32 \
  -e API_KEY="$(cat /srv/dsh-preview/.api_key)" \
  -e ADMIN_USER=admin -e ADMIN_PASSWORD="$(cat /srv/dsh-preview/.admin_password)" \
  -e TZ=Asia/Shanghai -e ORT_THREADS=4 -e EMBED_RATE=20 -e MAX_TOTAL_GB=20 \
  --restart unless-stopped dsh-embed:v2-preview >> "$LOG" 2>&1
sleep 20
docker logs --tail 10 dsh-embed 2>&1 | grep -iE "embed ready|reconcile|警告" >> "$LOG"
echo "$(date +%H:%M) 完成" >> "$LOG"
INNER
chmod +x /srv/dsh-preview/auto-switch-fp32.sh
nohup sh /srv/dsh-preview/auto-switch-fp32.sh >/dev/null 2>&1 &
echo "  自动切换已武装（日志 /tmp/auto-switch-fp32.log）"
