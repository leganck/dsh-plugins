"""嵌入会话：加载 ONNX 模型、维护向量标签（tag）、批量编码。

为什么单独一个文件：`/embed`（兼容端点）与新索引层的后台嵌入**必须用同一个会话与同一个
tag 算法**，否则同一份代码在两处算出不同标签的向量，索引里就会混两种（检索质量静默变差）。
"""
import hashlib
import os

import numpy as np

# 模型差异全部走环境变量：同一份代码既跑 bge-base-zh（默认），也跑 jina-code 变体。
# 注意：这些值在 import 时读取，Dockerfile 的 ENV 在进程启动前生效，容器内改不了（要重启）。
QUERY_PREFIX = os.environ.get("QUERY_PREFIX", "为这个句子生成表示以用于检索相关文章：")
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "512"))
# BERT 的 [SEP]；<=0 表示该模型没有这个 token（jina 是 Llama 词表，禁用末位替换）
SEP_ID = int(os.environ.get("SEP_ID", "102"))
# cls（默认，bge）| mean | last | auto（输出已是 2D 就直接用）
POOLING = os.environ.get("POOLING", "cls").strip().lower()
PAD_TOKEN = os.environ.get("PAD_TOKEN", "[PAD]")
PAD_ID = int(os.environ.get("PAD_ID", "0"))


def fingerprint(model_dir, model_file):
    """与插件 `lib/embedder.js: modelFingerprint()` **逐字节相同**的算法。

    客户端索引里的 `embedding_tag` 靠它和远端对上；改了顺序/范围，两端标签就分叉，
    表现为"一切换后端就全量重嵌"。
    """
    h = hashlib.sha256()
    for name in (model_file, "tokenizer.json", "tokenizer_config.json"):
        p = os.path.join(model_dir, name)
        try:
            with open(p, "rb") as f:
                while True:
                    chunk = f.read(1 << 20)
                    if not chunk:
                        break
                    h.update(chunk)
        except FileNotFoundError:
            pass
    return h.hexdigest()[:8]


def pick_model(directory):
    for name in ("model_fp16.onnx", "model.onnx", "model_int8.onnx"):
        cand = os.path.join(directory, name)
        if os.path.exists(cand):
            return cand
    return None


def make_session(ort, model_path, providers, threads):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    return ort.InferenceSession(model_path, so, providers=providers)


class Embedder:
    """一个模型目录 → 一个会话 + 一个 tag。"""

    def __init__(self, ort, model_dir, providers, threads=6, model_name=""):
        from tokenizers import Tokenizer

        self.model_dir = model_dir
        self.providers = providers
        tok_path = os.path.join(model_dir, "tokenizer.json")
        tok = Tokenizer.from_file(tok_path)
        tok.enable_truncation(max_length=MAX_TOKENS)
        tok.enable_padding(pad_id=PAD_ID, pad_token=PAD_TOKEN, direction="right")
        self.tokenizer = tok

        model_path = pick_model(model_dir)
        if not model_path:
            raise FileNotFoundError(f"no onnx model under {model_dir}")
        self.model_file = os.path.basename(model_path)
        self.session = make_session(ort, model_path, providers, threads)

        name = model_name or (
            "bge-base-zh-v1.5" if os.path.basename(model_dir) == "model" else os.path.basename(model_dir)
        )
        precision = "fp16" if "fp16" in self.model_file else "int8" if "int8" in self.model_file else "fp32"
        self.dim = None
        self.tag = f"{name}-{fingerprint(model_dir, self.model_file)}-{precision}"

    def info(self, ort_version):
        return {
            "model": self.model_file,
            "model_bytes": os.path.getsize(os.path.join(self.model_dir, self.model_file)),
            "tag": self.tag,
            "providers": self.session.get_providers(),
            "ort": ort_version,
        }

    def embed(self, texts, is_query=False):
        inputs = [QUERY_PREFIX + t for t in texts] if is_query else list(texts)
        encs = self.tokenizer.encode_batch(inputs)
        ids = np.array([e.ids for e in encs], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
        seq = ids.shape[1]
        if SEP_ID > 0 and seq == MAX_TOKENS:
            last = seq - 1
            for i in range(ids.shape[0]):
                if mask[i, last] == 1 and ids[i, last] != SEP_ID:
                    ids[i, last] = SEP_ID
        feeds = {}
        for meta in self.session.get_inputs():
            if meta.name == "input_ids":
                feeds[meta.name] = ids
            elif meta.name == "attention_mask":
                feeds[meta.name] = mask
            elif meta.name == "token_type_ids":
                feeds[meta.name] = np.zeros_like(ids)
        out = np.asarray(self.session.run(None, feeds)[0], dtype=np.float32)
        if out.ndim == 2:
            # 模型图里已做 pooling + 归一化（jina 变体）；这里再归一化一次是幂等的
            emb = out
        elif POOLING == "mean":
            m = mask.astype(np.float32)[:, :, None]
            emb = (out * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-6, None)
        elif POOLING == "last":
            idx = np.clip(mask.sum(axis=1) - 1, 0, out.shape[1] - 1)
            emb = out[np.arange(out.shape[0]), idx]
        else:  # cls / auto（3D 输入按 bge 的 CLS 处理）
            emb = out[:, 0, :]
        norms = np.linalg.norm(emb, axis=1, keepdims=True)
        norms[norms == 0] = 1e-9
        self.dim = int(emb.shape[1])
        return emb / norms
