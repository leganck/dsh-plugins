#!/bin/sh
# 取 bge-base-zh-v1.5 的 int8/quantized ONNX（110MB，比 fp32 400MB 好下且 CPU 上最快）
# 用法：cat fetch-int8.sh | ssh root@112 'bash -s'
set -e
DIR=/srv/dsh-preview/model-int8
mkdir -p "$DIR"

echo "== 复用已有 tokenizer/config =="
for f in tokenizer.json tokenizer_config.json config.json special_tokens_map.json; do
  [ -s "$DIR/$f" ] || docker cp "dsh-embed:/models/model/$f" "$DIR/" 2>/dev/null || true
done

echo "== 探测可用源 =="
for u in \
  "https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main/onnx/model_quantized.onnx" \
  "https://hf-mirror.com/Xenova/bge-base-zh-v1.5/resolve/main/onnx/model_quantized.onnx" \
  "https://modelscope.cn/models/Xenova/bge-base-zh-v1.5/resolve/master/onnx/model_quantized.onnx"
do
  code=$(curl -sIL -m 15 -o /dev/null -w "%{http_code}" "$u" || echo 000)
  size=$(curl -sIL -m 15 "$u" 2>/dev/null | awk 'tolower($1)=="content-length:"{v=$2} END{gsub(/\r/,"",v); print v}')
  echo "  $code  ${size:-?}B  $u"
done
