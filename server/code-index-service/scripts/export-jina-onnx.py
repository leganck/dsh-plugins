#!/usr/bin/env python3
"""把 jina-embeddings-v2-base-code 导出成服务可用的 ONNX（mean pooling + L2 归一化烘焙进图）。

为什么需要这个脚本：jina v2 是 JinaBert（ALiBi 自定义注意力），
- HuggingFace 仓库里**没有 ONNX**，现有服务只认 ONNX；
- 它的自定义建模代码通过 `trust_remote_code` 从 `jinaai/jina-bert-v2-qk-post-norm` 拉取；
- 正确 pooling 是 **mean**（不是 BERT 的 CLS），必须烘焙进图或改服务端代码。

产物（默认写到 models/model-jina/）：
  model_fp16.onnx      —— 推荐给 GPU（P4）
  model.onnx           —— fp32（对齐/排错用）
  tokenizer.json / tokenizer_config.json / special_tokens_map.json / config.json
  jina-v2.sha256 的新清单（打印到 stdout，需人工替换 scripts/jina-v2.sha256）

依赖：pip install torch transformers onnx onnxruntime onnxconverter-common

用法：
  python scripts/export-jina-onnx.py --src jinaai/jina-embeddings-v2-base-code --out models/model-jina
  python scripts/export-jina-onnx.py --src /path/to/local/weights --out models/model-jina --no-fp16
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time

import numpy as np
import torch
import torch.nn as nn


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class WithPooling(nn.Module):
    """last_hidden_state → mean pooling（按 attention_mask）→ L2 归一化。"""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask):
        h = self.model(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        mask = attention_mask.unsqueeze(-1).float()
        emb = (h * mask).sum(1) / mask.sum(1).clamp(min=1e-6)
        return torch.nn.functional.normalize(emb, dim=1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="jinaai/jina-embeddings-v2-base-code")
    ap.add_argument("--out", default="models/model-jina")
    ap.add_argument("--no-fp16", action="store_true")
    ap.add_argument("--max-tokens", type=int, default=512, help="导出时的最大序列长度（推理可更短）")
    args = ap.parse_args()

    from transformers import AutoModel, AutoTokenizer

    os.makedirs(args.out, exist_ok=True)
    print(f"加载模型 {args.src} …", flush=True)
    tok = AutoTokenizer.from_pretrained(args.src)
    model = AutoModel.from_pretrained(args.src, trust_remote_code=True, attn_implementation="eager").eval()
    print(f"  {type(model).__name__} dim={model.config.hidden_size}", flush=True)

    wrapped = WithPooling(model).eval()
    texts = ["def add(a, b):\n    return a + b\n", "class User:\n    def __init__(self, uid): self.uid = uid\n"]
    enc = tok(texts, padding=True, truncation=True, max_length=args.max_tokens, return_tensors="pt")
    feeds = {"input_ids": enc["input_ids"], "attention_mask": enc["attention_mask"]}

    fp32_path = os.path.join(args.out, "model.onnx")
    t0 = time.time()
    torch.onnx.export(
        wrapped,
        (feeds["input_ids"], feeds["attention_mask"]),
        fp32_path,
        input_names=["input_ids", "attention_mask"],
        output_names=["embeddings"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "embeddings": {0: "batch"},
        },
        opset_version=17,
        do_constant_folding=True,
        training=torch.onnx.TrainingMode.EVAL,
    )
    print(f"导出 fp32：{fp32_path}（{time.time() - t0:.1f}s）", flush=True)

    # ---- 数值校验：ONNX vs PyTorch ----
    import onnx
    import onnxruntime as ort

    m = onnx.load(fp32_path)
    onnx.checker.check_model(m)
    sess = ort.InferenceSession(fp32_path, providers=["CPUExecutionProvider"])
    out = sess.run(None, {k: v.numpy() for k, v in feeds.items()})[0]
    with torch.no_grad():
        ref = wrapped(feeds["input_ids"], feeds["attention_mask"]).numpy()
    cos = (out * ref).sum(1) / (np.linalg.norm(out, axis=1) * np.linalg.norm(ref, axis=1) + 1e-9)
    print(f"fp32 vs torch cosine: {np.round(cos, 6).tolist()}", flush=True)
    if float(cos.min()) < 0.9999:
        print("✗ 导出结果与 PyTorch 不一致，终止", file=sys.stderr)
        return 1

    # ---- fp16（P4 上更快；keep_io_types 保证输入仍喂 int64/fp32）----
    if not args.no_fp16:
        from onnxruntime.transformers.float16 import convert_float_to_float16

        fp16_path = os.path.join(args.out, "model_fp16.onnx")
        m16 = convert_float_to_float16(m, keep_io_types=True, disable_shape_infer=True)
        onnx.save(m16, fp16_path)
        print(f"导出 fp16：{fp16_path}", flush=True)

    # ---- tokenizer / 配置：服务端只需要 tokenizer.json，其余用于 fingerprint 与排查 ----
    tok.save(os.path.join(args.out, "tokenizer.json"))
    for name in ("tokenizer_config.json", "special_tokens_map.json"):
        src = os.path.join(args.src, name) if os.path.isdir(args.src) else None
        if src and os.path.exists(src):
            shutil.copy(src, os.path.join(args.out, name))
        else:
            try:
                from huggingface_hub import hf_hub_download

                shutil.copy(hf_hub_download(args.src, name), os.path.join(args.out, name))
            except Exception:  # noqa: BLE001 —— 非致命
                pass
    model.config.save_pretrained(args.out)

    # ---- 打印校验清单（逐行替换 scripts/jina-v2.sha256）----
    print("\n# 校验清单（替换 scripts/jina-v2.sha256 中的对应行）")
    for name in ("model_fp16.onnx", "model.onnx", "tokenizer.json", "config.json",
                 "tokenizer_config.json", "special_tokens_map.json"):
        p = os.path.join(args.out, name)
        if os.path.exists(p):
            print(f"{sha256(p)}  {name}")
    print(f"\n产物目录：{os.path.abspath(args.out)}")
    print(json.dumps({"out": args.out, "fp16": not args.no_fp16}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
