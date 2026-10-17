#!/usr/bin/env python3
"""dsh-code-index 的远端推理服务：`/embed` + `/rerank`（可选的第二台机器算力）。

为什么需要这个服务
------------------
查询路径有两段重活：**把问题变成向量**、**给候选打分（交叉编码器重排）**。
在开发机（集成显卡 / 弱 GPU）上重排尤其贵：本机实测 top-20 要 450–940 ms，
而一台带独显的机器只要 ~66 ms。把这两段租出去，开发机就能保住"本地检索、远端重排"。

设计要点
--------
1. **向量标签（tag）必须和本机一致**：客户端用 `模型名-模型文件内容哈希-精度` 作为
   `embedding_tag` 写进索引。服务端用**逐字节相同的算法**（见 `fingerprint()`）自述 tag，
   客户端据此确认"远端和本机是同一份模型"，于是**切后端不需要重建索引**。
2. **不做动态 batching / 队列**：这是单用户局域网服务，简单优先。
3. **小响应不要分两次写**：`BaseHTTPRequestHandler` 默认先写 header 再写 body，
   小响应会撞上 Nagle + 延迟 ACK，实测 LAN 上稳定多出 **40 ms**（`GET /` 44 ms vs 单条 embed 15 ms）。
   这里 `disable_nagle_algorithm = True` 且 header+body 一次 `write()`。
4. **重排模型可缺**：没装就在 `GET /` 里自述 `rerank_ready=false` + 原因，
   客户端据此直接回退本机，而不是先发一次请求再吃 500。

端点
----
    GET  /                 -> 自述：ready / model / model_bytes / tag / providers / rerank_ready / rerank_model
    GET  /health           -> 同上（给探活用）
    GET  /log?n=200        -> 日志尾巴
    POST /embed            <- {"texts":[...], "is_query":false}
                           -> {"ok":true,"dim":768,"count":N,"ms":X,"providers":[...],
                               "vectors_b64":"<base64 float32 LE, N*dim>"}
    POST /rerank           <- {"query":"…","texts":[...],"max_tokens":256}
                           -> {"ok":true,"scores":[v1,v2,…],"ms":X,"providers":[...],"model":"…"}

环境变量
--------
    MODEL_DIR         嵌入模型目录（默认 /app/model）
    MODEL_NAME        模型名（默认按目录名推断，`model` → bge-base-zh-v1.5）
    RERANK_MODEL_DIR  重排模型目录（默认 /app/model-rerank；不存在则 rerank_ready=false）
    RERANK_BATCH      重排批大小（默认 8）
    RERANK_MAX_TOKENS 重排截断上限（默认 256，与插件默认一致）
    ORT_THREADS       CPU 线程（默认 6）
    ORT_PROVIDERS     逗号分隔的执行提供者（默认 CUDA,CPU）
    PORT              监听端口（默认 8000）
    SERVER_LOG        日志文件（默认 <app>/out/server.log）
"""
import base64
import hashlib
import json
import os
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

APP = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(APP, "model"))
RERANK_DIR = os.environ.get("RERANK_MODEL_DIR", os.path.join(APP, "model-rerank"))
LOG_PATH = os.environ.get("SERVER_LOG", os.path.join(APP, "out", "server.log"))
MODEL_NAME = os.environ.get("MODEL_NAME", "")
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："
MAX_TOKENS = 512
SEP_ID = 102
RERANK_BATCH = int(os.environ.get("RERANK_BATCH", "8"))
RERANK_MAX_TOKENS = int(os.environ.get("RERANK_MAX_TOKENS", "256"))
MAX_TEXTS = 512
MAX_TEXT_CHARS = 8000
# 可选的最小鉴权：设了 API_KEY 就要求 Authorization: Bearer <key>（客户端 embedding.remote.apiKey 对应）
API_KEY = os.environ.get("API_KEY", "")

os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


state = {
    "ready": False,
    "err": None,
    "info": {},
    "tokenizer": None,
    "session": None,
    "rerank_ready": False,
    "rerank_err": None,
    "rerank_info": {},
    "rerank_tokenizer": None,
    "rerank_session": None,
}


def fingerprint(model_dir, model_file):
    """与插件 `lib/embedder.js: modelFingerprint()` **逐字节相同**的算法。

    客户端索引里的 `embedding_tag` 就靠它和远端对上；改了这里的顺序/范围，
    远端与本机的标签就会分叉，表现为"一切换后端就全量重嵌"。
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
            pass  # 与 JS 侧一致：缺文件就跳过
    return h.hexdigest()[:8]


def pick_model(directory):
    for name in ("model_fp16.onnx", "model.onnx", "model_int8.onnx"):
        cand = os.path.join(directory, name)
        if os.path.exists(cand):
            return cand
    return None


def make_session(ort, model_path, providers):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.intra_op_num_threads = int(os.environ.get("ORT_THREADS", "6"))
    so.inter_op_num_threads = 1
    return ort.InferenceSession(model_path, so, providers=providers)


def build():
    import onnxruntime as ort

    ort.set_default_logger_severity(3)
    avail = ort.get_available_providers()
    want = os.environ.get("ORT_PROVIDERS", "CUDAExecutionProvider,CPUExecutionProvider").split(",")
    providers = [p for p in want if p in avail] or ["CPUExecutionProvider"]

    from tokenizers import Tokenizer

    tok_path = os.path.join(MODEL_DIR, "tokenizer.json")
    tok = Tokenizer.from_file(tok_path)
    tok.enable_truncation(max_length=MAX_TOKENS)
    tok.enable_padding(pad_id=0, pad_token="[PAD]", direction="right")

    model_path = pick_model(MODEL_DIR)
    if not model_path:
        raise FileNotFoundError(f"no onnx model under {MODEL_DIR}")
    sess = make_session(ort, model_path, providers)

    model_file = os.path.basename(model_path)
    name = MODEL_NAME or ("bge-base-zh-v1.5" if os.path.basename(MODEL_DIR) == "model" else os.path.basename(MODEL_DIR))
    precision = "fp16" if "fp16" in model_file else "int8" if "int8" in model_file else "fp32"
    tag = f"{name}-{fingerprint(MODEL_DIR, model_file)}-{precision}"

    state.update(
        ready=True,
        tokenizer=tok,
        session=sess,
        info={
            "ort": ort.__version__,
            "available_providers": avail,
            "used_providers": sess.get_providers(),
            "model": model_file,
            "model_bytes": os.path.getsize(model_path),
            "tag": tag,
            "threads": int(os.environ.get("ORT_THREADS", "6")),
        },
    )
    log(f"embed ready: tag={tag} {state['info']}")

    # ---- 重排模型（可选）----
    try:
        rk_path = pick_model(RERANK_DIR) if os.path.isdir(RERANK_DIR) else None
        rk_tok_path = os.path.join(RERANK_DIR, "tokenizer.json")
        if not rk_path or not os.path.exists(rk_tok_path):
            raise FileNotFoundError(f"{RERANK_DIR} 下缺 onnx 或 tokenizer.json")
        rk_tok = Tokenizer.from_file(rk_tok_path)
        rk_tok.enable_truncation(max_length=RERANK_MAX_TOKENS)
        rk_tok.enable_padding(pad_id=0, pad_token="[PAD]", direction="right")
        rk_sess = make_session(ort, rk_path, providers)
        state.update(
            rerank_ready=True,
            rerank_tokenizer=rk_tok,
            rerank_session=rk_sess,
            rerank_info={
                "rerank_model": os.path.basename(rk_path),
                "rerank_model_bytes": os.path.getsize(rk_path),
                "rerank_tag": f"{os.path.basename(RERANK_DIR)}-{fingerprint(RERANK_DIR, os.path.basename(rk_path))}",
                "rerank_max_tokens": RERANK_MAX_TOKENS,
            },
        )
        log(f"rerank ready: {state['rerank_info']}")
    except Exception as e:
        state["rerank_err"] = f"{type(e).__name__}: {e}"
        log("rerank unavailable: " + state["rerank_err"])


def embed(texts, is_query=False):
    tok = state["tokenizer"]
    sess = state["session"]
    inputs = [QUERY_PREFIX + t for t in texts] if is_query else list(texts)
    encs = tok.encode_batch(inputs)
    ids = np.array([e.ids for e in encs], dtype=np.int64)
    mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
    seq = ids.shape[1]
    if seq == MAX_TOKENS:
        last = seq - 1
        for i in range(ids.shape[0]):
            if mask[i, last] == 1 and ids[i, last] != SEP_ID:
                ids[i, last] = SEP_ID
    feeds = {}
    for meta in sess.get_inputs():
        if meta.name == "input_ids":
            feeds[meta.name] = ids
        elif meta.name == "attention_mask":
            feeds[meta.name] = mask
        elif meta.name == "token_type_ids":
            feeds[meta.name] = np.zeros_like(ids)
    out = sess.run(None, feeds)
    hidden = out[0]
    cls = hidden[:, 0, :].astype(np.float32)
    norms = np.linalg.norm(cls, axis=1, keepdims=True)
    norms[norms == 0] = 1e-9
    return cls / norms


def rerank(query, texts, max_tokens=None):
    tok = state["rerank_tokenizer"]
    sess = state["rerank_session"]
    if max_tokens and max_tokens != RERANK_MAX_TOKENS:
        # 每个请求可以要求更短的截断（更省算力）；只在比服务端默认更小时生效，避免越界
        tok.enable_truncation(max_length=min(int(max_tokens), MAX_TOKENS))
    scores = np.zeros(len(texts), dtype=np.float32)
    for start in range(0, len(texts), RERANK_BATCH):
        part = texts[start : start + RERANK_BATCH]
        encs = tok.encode_batch([(query, t) for t in part])
        ids = np.array([e.ids for e in encs], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
        feeds = {}
        for meta in sess.get_inputs():
            if meta.name == "input_ids":
                feeds[meta.name] = ids
            elif meta.name == "attention_mask":
                feeds[meta.name] = mask
            elif meta.name == "token_type_ids":
                feeds[meta.name] = np.zeros_like(ids)
        out = sess.run(None, feeds)
        t = np.asarray(out[0], dtype=np.float32).reshape(len(part), -1)
        scores[start : start + len(part)] = t[:, 0]
    return scores


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # 见文件头第 3 条：不加这一行，小响应会稳定多出 40 ms（Nagle + 延迟 ACK）
    disable_nagle_algorithm = True

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        # header 与 body **一次写完**：分两次写会触发同一个 40 ms 停顿
        head = (
            f"HTTP/1.1 {code} {self.responses.get(code, ('OK',))[0]}\r\n"
            f"Content-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: keep-alive\r\n\r\n"
        ).encode()
        self.wfile.write(head + body)

    def log_message(self, fmt, *args):
        pass

    def status_payload(self):
        info = dict(state["info"])
        info.update(
            ready=state["ready"],
            err=state["err"],
            pid=os.getpid(),
            model_dir=MODEL_DIR,
            rerank_ready=state["rerank_ready"],
            rerank_err=state["rerank_err"],
            rerank_model_dir=RERANK_DIR,
        )
        info.update(state["rerank_info"])
        return info

    def do_GET(self):
        if self.path.startswith("/log"):
            n = 200
            if "n=" in self.path:
                try:
                    n = int(self.path.split("n=")[1].split("&")[0])
                except Exception:
                    pass
            try:
                with open(LOG_PATH, encoding="utf-8") as f:
                    lines = f.readlines()[-n:]
            except Exception as e:
                lines = [f"log read failed: {e}"]
            return self._send(200, {"lines": [l.rstrip("\n") for l in lines]})
        return self._send(200, self.status_payload())

    def do_POST(self):
        if self.path not in ("/embed", "/rerank"):
            return self._send(404, {"error": "not found"})
        if API_KEY and self.headers.get("authorization", "") != f"Bearer {API_KEY}":
            return self._send(401, {"error": "unauthorized"})
        if self.path == "/rerank" and not state["rerank_ready"]:
            return self._send(503, {"error": "rerank not ready", "detail": state["rerank_err"]})
        if not state["ready"]:
            return self._send(503, {"error": "not ready", "detail": state["err"]})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
            texts = req.get("texts") or []
            if not isinstance(texts, list) or not texts:
                return self._send(400, {"error": "texts must be a non-empty array"})
            if len(texts) > MAX_TEXTS:
                return self._send(400, {"error": f"texts too many ({len(texts)} > {MAX_TEXTS})"})
            texts = [str(t)[:MAX_TEXT_CHARS] for t in texts]
            t0 = time.time()
            if self.path == "/embed":
                vecs = embed(texts, bool(req.get("is_query")))
                ms = (time.time() - t0) * 1000.0
                return self._send(
                    200,
                    {
                        "ok": True,
                        "dim": int(vecs.shape[1]),
                        "count": int(vecs.shape[0]),
                        "ms": round(ms, 2),
                        "providers": state["info"].get("used_providers"),
                        "tag": state["info"].get("tag"),
                        "vectors_b64": base64.b64encode(vecs.tobytes(order="C")).decode(),
                    },
                )
            query = str(req.get("query") or "")
            if not query:
                return self._send(400, {"error": "query must be a non-empty string"})
            scores = rerank(query, texts, req.get("max_tokens"))
            ms = (time.time() - t0) * 1000.0
            return self._send(
                200,
                {
                    "ok": True,
                    "count": int(len(scores)),
                    "ms": round(ms, 2),
                    "providers": state["info"].get("used_providers"),
                    "model": state["rerank_info"].get("rerank_model"),
                    "scores": [round(float(x), 6) for x in scores],
                },
            )
        except Exception as e:
            log(f"{self.path} failed: " + traceback.format_exc().splitlines()[-1])
            return self._send(500, {"error": str(e), "trace": traceback.format_exc()[-800:]})


def main():
    try:
        build()
    except Exception as e:
        state["err"] = f"{type(e).__name__}: {e}"
        log("build failed: " + traceback.format_exc())
    port = int(os.environ.get("PORT", "8000"))
    log(f"listening on 0.0.0.0:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
