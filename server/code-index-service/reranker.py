"""交叉编码器重排（bge-reranker-base）。

可选：模型没装就抛错，由上层报 `rerank_ready=false` + 原因（客户端据此直接回退本机，
而不是先发一次请求再吃 500）。
"""
import os

import numpy as np

from embedder import MAX_TOKENS, fingerprint, make_session, pick_model


class Reranker:
    def __init__(self, ort, model_dir, providers, threads=6, max_tokens=256, batch=8):
        from tokenizers import Tokenizer

        self.model_dir = model_dir
        self.batch = max(1, int(batch))
        self.max_tokens = min(int(max_tokens), MAX_TOKENS)

        tok_path = os.path.join(model_dir, "tokenizer.json")
        if not os.path.exists(tok_path):
            raise FileNotFoundError(f"{model_dir} 下没有 tokenizer.json")
        tok = Tokenizer.from_file(tok_path)
        tok.enable_truncation(max_length=self.max_tokens)
        tok.enable_padding(pad_id=0, pad_token="[PAD]", direction="right")
        self.tokenizer = tok

        model_path = pick_model(model_dir)
        if not model_path:
            raise FileNotFoundError(f"{model_dir} 下没有 onnx 模型")
        self.model_file = os.path.basename(model_path)
        self.session = make_session(ort, model_path, providers, threads)

    def info(self):
        return {
            "rerank_model": self.model_file,
            "rerank_model_bytes": os.path.getsize(os.path.join(self.model_dir, self.model_file)),
            "rerank_tag": f"{os.path.basename(self.model_dir)}-{fingerprint(self.model_dir, self.model_file)}",
            "rerank_max_tokens": self.max_tokens,
        }

    def score(self, query, texts):
        """返回与 texts 等长的分数数组；越大越相关（bge-reranker 输出单 logit）。"""
        out = np.zeros(len(texts), dtype=np.float32)
        for start in range(0, len(texts), self.batch):
            part = texts[start : start + self.batch]
            encs = self.tokenizer.encode_batch([(query, t) for t in part])
            ids = np.array([e.ids for e in encs], dtype=np.int64)
            mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
            feeds = {}
            for meta in self.session.get_inputs():
                if meta.name == "input_ids":
                    feeds[meta.name] = ids
                elif meta.name == "attention_mask":
                    feeds[meta.name] = mask
                elif meta.name == "token_type_ids":
                    feeds[meta.name] = np.zeros_like(ids)
            res = np.asarray(self.session.run(None, feeds)[0], dtype=np.float32).reshape(len(part), -1)
            out[start : start + len(part)] = res[:, 0]
        return out
