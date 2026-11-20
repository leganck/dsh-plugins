#!/bin/sh
# 实测结论（2026-11-21 01:15，112 CPU-only 4 核，真实代码块 ~512 token）：
#   fp16  ≈ 1.2 块/s（CPU EP 无 fp16 kernel，靠 cast）
#   int8  ≈ 0.3 块/s（更慢：动态量化的 dequant 开销在长序列上更亏）
#   fp32  预期最快（无 cast、无 dequant）→ 本脚本后台续传 fp32 模型
set -e
DIR=/srv/dsh-preview/model-fp32
mkdir -p "$DIR"
for f in tokenizer.json tokenizer_config.json config.json special_tokens_map.json; do
  [ -s "$DIR/$f" ] || docker cp "dsh-embed:/models/model/$f" "$DIR/" 2>/dev/null || true
done
U="https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main/onnx/model.onnx"
nohup curl -sL -C - --retry 10 --retry-delay 3 -m 3600 -o "$DIR/model.onnx" "$U" >/tmp/dl-fp32.log 2>&1 &
echo "  后台续传已启动 pid=$!"
sleep 5
ls -l "$DIR/model.onnx" 2>/dev/null | awk '{printf "  当前 %.1f MB\n", $5/1048576}'
