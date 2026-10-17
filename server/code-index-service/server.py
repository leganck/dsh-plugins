#!/usr/bin/env python3
"""dsh-code-index 远端索引服务：/embed、/rerank、以及 **/v1 索引层**（同步/嵌入/检索）。

与插件的关系
------------
插件负责**切块 + 本地 BM25**，把「块正文 + (path,start,end,hash)」推给本服务；
本服务负责**向量存储、kNN、重排**，并把命中结果按内容哈希返回。于是：

    本机：BM25(top-40) ─┐
                        ├─ RRF(k=20) → 结果      ← 融合在客户端，BM25 永远可用
    远端：kNN(top-40) ──┘

三条硬规则
----------
1. **复用按血统（lineage）**：`vectors(lineage, tag, hash)`。实测跨无关项目块重合 0.00%，
   按项目血统才能同时拿到"同项目跨分支 ~98% 复用"和"不无谓累积"。
2. **别把 GPU 打满**：嵌入走后台线程 + 限流（默认 10 块/s，P4 峰值的 37%）+ 可暂停。
3. **小响应不要分两次写**：`BaseHTTPRequestHandler` 默认先 header 再 body，实测 LAN 上
   稳定多出 40 ms（Nagle + 延迟 ACK）。这里 `disable_nagle_algorithm = True` 且一次 write()。

端点
----
    GET  /                         自述：模型/tag/providers/重排状态/治理状态/命名空间概览
    GET  /health                   同上
    GET  /log?n=200                日志尾巴
    POST /embed                    {texts, is_query} -> {vectors_b64, dim, count, ms}   （兼容 0.7.0）
    POST /rerank                   {query, texts, max_tokens} -> {scores, ms}          （兼容 0.7.0）
    POST /v1/repos/{ns}/sync       {repoState, revision?, mode, upsert, remove, tag, url, repoId, chunkFp}
                                   -> {revision, unchanged, missing[], chunks, vectors, coverage}
    POST /v1/repos/{ns}/chunks     {bodies:[{hash, body}]} -> {accepted, deduped}
    POST /v1/repos/{ns}/embed      {order?, batch?} -> 入队后台嵌入
    GET  /v1/repos/{ns}/status     -> {revision, chunks, vectors, coverage, pending, paused, rate, lineageBytes}
    POST /v1/search                {namespace, query, k?, tag?, rerank?:{candidates}} -> {hits[], ms{}}
    POST /v1/admin/pause | /resume | /rate | /gc
    POST /v1/lineages/{id}/adopt   {from, hashes?} 显式跨血统借用
"""
import base64
import gzip
import json
import os
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

import numpy as np

APP = os.path.dirname(os.path.abspath(__file__))
F = os.environ

MODEL_DIR = F.get("MODEL_DIR", os.path.join(APP, "model"))
MODEL_NAME = F.get("MODEL_NAME", "")
RERANK_DIR = F.get("RERANK_MODEL_DIR", os.path.join(APP, "model-rerank"))
LOG_PATH = F.get("SERVER_LOG", os.path.join(APP, "out", "server.log"))
DB_PATH = F.get("SERVER_DB", os.path.join(APP, "out", "index.db"))
PORT = int(F.get("PORT", "8000"))
THREADS = int(F.get("ORT_THREADS", "6"))
PROVIDERS = F.get("ORT_PROVIDERS", "CUDAExecutionProvider,CPUExecutionProvider").split(",")
EMBED_RATE = float(F.get("EMBED_RATE", "10"))          # 块/秒；0 = 不限速
EMBED_BATCH = int(F.get("EMBED_BATCH", "8"))
RERANK_BATCH = int(F.get("RERANK_BATCH", "8"))
RERANK_MAX_TOKENS = int(F.get("RERANK_MAX_TOKENS", "256"))
KNN_MAX_BYTES = int(float(F.get("KNN_MAX_BYTES", str(2 * 1024**3))))
RETENTION_DAYS = int(F.get("RETENTION_DAYS", "30"))
MAX_VECTORS_PER_LINEAGE = int(F.get("MAX_VECTORS_PER_LINEAGE", "500000"))
MAX_TOTAL_BYTES = int(float(F.get("MAX_TOTAL_GB", "20")) * 1024**3)
API_KEY = F.get("API_KEY", "")
FAKE_EMBED = F.get("FAKE_EMBED", "") not in ("", "0", "false")
MAX_TEXTS = 512
MAX_TEXT_CHARS = 8000

os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


class FakeEmbedder:
    """自测用：不需要 onnx 模型，向量由文本哈希确定，但仍保持 L2 归一化与确定性。"""

    def __init__(self, dim=16):
        self.dim = dim
        self.tag = "fake-model-0000fake-fp32"
        self.model_file = "fake.onnx"
        self.model_dir = "(fake)"

    def info(self, ort_version="0"):
        return {"model": self.model_file, "model_bytes": 0, "tag": self.tag, "providers": ["Fake"], "ort": ort_version}

    def embed(self, texts, is_query=False):
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, t in enumerate(texts):
            seed = f"{'Q:' if is_query else ''}{t}".encode("utf-8")
            h = 2166136261
            for b in seed[:256]:
                h = ((h ^ b) * 16777619) & 0xFFFFFFFF
            rng = np.random.default_rng(h)
            v = rng.standard_normal(self.dim).astype(np.float32)
            out[i] = v / (np.linalg.norm(v) or 1.0)
        return out


state = {"ready": False, "err": None, "info": {}, "rerank_ready": False, "rerank_err": None, "rerank_info": {}}
store = None
knn = None
governor = None
embedder = None
reranker = None


def _load(name):
    """按需导入同目录模块（脚本目录就是 cwd，所以普通 import 即可）。"""
    import importlib

    return importlib.import_module(name)


def build():
    global store, knn, governor, embedder, reranker
    if FAKE_EMBED:
        # 自测路径：完全不碰 onnxruntime / 模型文件
        embedder = FakeEmbedder()
        info = embedder.info("0")
        info["available_providers"] = ["Fake"]
        info["threads"] = THREADS
        state.update(ready=True, info=info)
        log(f"embed ready (fake): tag={info['tag']}")
    else:
        import onnxruntime as ort

        ort.set_default_logger_severity(3)
        avail = ort.get_available_providers()
        providers = [p for p in PROVIDERS if p in avail] or ["CPUExecutionProvider"]
        embedder = _load("embedder").Embedder(ort, MODEL_DIR, providers, THREADS, MODEL_NAME)
        info = embedder.info(ort.__version__)
        info["available_providers"] = avail
        info["threads"] = THREADS
        state.update(ready=True, info=info)
        log(f"embed ready: tag={info['tag']} providers={info['providers']}")

        try:
            reranker = _load("reranker").Reranker(ort, RERANK_DIR, providers, THREADS, RERANK_MAX_TOKENS, RERANK_BATCH)
            state.update(rerank_ready=True, rerank_info=reranker.info())
            log(f"rerank ready: {state['rerank_info']}")
        except Exception as e:
            state.update(rerank_ready=False, rerank_err=f"{type(e).__name__}: {e}")
            log("rerank unavailable: " + state["rerank_err"])

    store = _load("index_store").IndexStore(DB_PATH)
    knn = _load("knn").KnnCache(store, KNN_MAX_BYTES)
    governor = _load("governor").EmbedGovernor(store, embedder, knn, EMBED_RATE, EMBED_BATCH, "spread", log)
    governor.start()
    log(f"index store ready: db={DB_PATH} rate={EMBED_RATE}/s batch={EMBED_BATCH} knnMax={KNN_MAX_BYTES}B")


# ------------------------------------------------------------------ 业务
def search(namespace, query, k=10, tag=None, rerank_candidates=0):
    repo = store.repo(namespace)
    if not repo:
        return {"error": "unknown-namespace", "namespace": namespace}, 404
    use_tag = tag or repo["tag"]
    if not use_tag:
        return {"hits": [], "reason": "该命名空间还没有模型标签（先同步一次）", "ms": {}}, 200
    t0 = time.time()
    qvec = embedder.embed([query], is_query=True)[0]
    embed_ms = (time.time() - t0) * 1000
    hashes, mat, meta = knn.get(namespace, use_tag)
    if mat.shape[0] == 0:
        return {"hits": [], "reason": "该命名空间还没有向量", "ms": {"embed": round(embed_ms, 1)}}, 200
    if qvec.shape[0] != mat.shape[1]:
        return {"error": "dim-mismatch", "detail": f"query dim {qvec.shape[0]} != index dim {mat.shape[1]}"}, 409
    t1 = time.time()
    take = max(int(k), int(rerank_candidates or 0))
    order, scores = knn.topk(mat, qvec, take)
    knn_ms = (time.time() - t1) * 1000
    hits = []
    for idx, sc in zip(order, scores):
        h = hashes[int(idx)]
        path, start, end = meta[h]
        hits.append({"hash": h, "path": path, "start": start, "end": end, "score": round(float(sc), 6)})

    rerank_ms = 0.0
    if rerank_candidates and reranker is not None and len(hits) > 1:
        pool = hits[: int(rerank_candidates)]
        bodies = store.bodies(repo["lineage_id"], [h["hash"] for h in pool])
        t2 = time.time()
        try:
            sc = reranker.score(query, [bodies.get(h["hash"], "") for h in pool])
            rerank_ms = (time.time() - t2) * 1000
            for h, s in zip(pool, sc):
                h["rerankScore"] = round(float(s), 6)
            pool.sort(key=lambda h: h["rerankScore"], reverse=True)
            hits = pool + hits[len(pool) :]
        except Exception as e:
            rerank_ms = (time.time() - t2) * 1000
            hits[0]["rerankError"] = str(e)[:160]
    return {
        "hits": hits[: int(k)],
        "ms": {"embed": round(embed_ms, 1), "knn": round(knn_ms, 1), "rerank": round(rerank_ms, 1)},
        "coverage": store.counts(namespace)["coverage"],
    }, 200


def repo_status(namespace):
    repo = store.repo(namespace)
    if not repo:
        return {"error": "unknown-namespace"}, 404
    out = {
        "namespace": namespace,
        "lineage": repo["lineage_id"],
        "repoId": repo["repo_id"],
        "chunkFp": repo["chunk_fp"],
        "revision": repo["revision"],
        "tag": repo["tag"],
        "repoState": repo["repo_state"],
    }
    out.update(store.counts(namespace))
    out.update(store.lineage_bytes(repo["lineage_id"]))
    out.update(governor.status(namespace))
    return out, 200


def ensure_capacity(lineage):
    vecs = store.vector_count(lineage)
    if int(vecs) > MAX_VECTORS_PER_LINEAGE:
        return {
            "error": "lineage-vector-cap",
            "detail": f"该血统向量数 {vecs} 超过上限 {MAX_VECTORS_PER_LINEAGE}",
            "lineageBytes": store.lineage_bytes(lineage),
            "hint": "POST /v1/admin/gc {lineage} 清理，或调大 MAX_VECTORS_PER_LINEAGE",
        }
    total = store.total_bytes()
    if total > MAX_TOTAL_BYTES:
        return {
            "error": "server-full",
            "detail": f"总占用 {total} B 超过上限 {MAX_TOTAL_BYTES} B",
            "hint": "先清理不用的血统（/v1/admin/gc）",
        }
    return None


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True  # 见文件头第 3 条

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        head = (
            f"HTTP/1.1 {code} {self.responses.get(code, ('OK',))[0]}\r\n"
            f"Content-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: keep-alive\r\n\r\n"
        ).encode()
        self.wfile.write(head + body)

    def log_message(self, fmt, *args):
        pass

    def _body(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        if self.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw or b"{}")

    def _auth_ok(self):
        if not API_KEY:
            return True
        return self.headers.get("authorization", "") == f"Bearer {API_KEY}"

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if path == "/log":
            n = 200
            if "n=" in (u.query or ""):
                try:
                    n = int(u.query.split("n=")[1].split("&")[0])
                except Exception:
                    pass
            try:
                with open(LOG_PATH, encoding="utf-8") as f:
                    lines = f.readlines()[-n:]
            except Exception as e:
                lines = [f"log read failed: {e}"]
            return self._send(200, {"lines": [x.rstrip() for x in lines]})
        if path in ("/", "/health"):
            return self._send(200, self._status_payload())
        if path.startswith("/v1/repos/") and path.endswith("/status"):
            ns = unquote(path[len("/v1/repos/") : -len("/status")])
            payload, code = repo_status(ns)
            return self._send(code, payload)
        if path == "/v1/spaces":
            return self._send(200, {"spaces": store.overview() if store else []})
        return self._send(404, {"error": "not found"})

    def _status_payload(self):
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
        if governor:
            info["governor"] = {"paused": governor.paused, "rate": governor.rate, "batch": governor.batch}
        if knn:
            info["knn"] = knn.stats()
        if store:
            info["spaces"] = store.overview()
            info["db"] = DB_PATH
        info["limits"] = {
            "maxVectorsPerLineage": MAX_VECTORS_PER_LINEAGE,
            "maxTotalGb": round(MAX_TOTAL_BYTES / 1024**3, 2),
            "retentionDays": RETENTION_DAYS,
        }
        return info

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if not self._auth_ok():
            return self._send(401, {"error": "unauthorized"})
        if not state["ready"]:
            return self._send(503, {"error": "not ready", "detail": state["err"]})
        try:
            req = self._body()
        except Exception as e:
            return self._send(400, {"error": f"bad json: {e}"})
        try:
            # ---------------- 兼容端点 ----------------
            if path == "/embed":
                texts = req.get("texts") or []
                if not texts:
                    return self._send(400, {"error": "texts must be a non-empty array"})
                texts = [str(t)[:MAX_TEXT_CHARS] for t in texts][:MAX_TEXTS]
                t0 = time.time()
                vecs = embedder.embed(texts, bool(req.get("is_query")))
                return self._send(
                    200,
                    {
                        "ok": True,
                        "dim": int(vecs.shape[1]),
                        "count": int(vecs.shape[0]),
                        "ms": round((time.time() - t0) * 1000, 2),
                        "providers": state["info"].get("providers"),
                        "tag": state["info"].get("tag"),
                        "vectors_b64": base64.b64encode(vecs.tobytes(order="C")).decode(),
                    },
                )
            if path == "/rerank":
                if not state["rerank_ready"]:
                    return self._send(503, {"error": "rerank not ready", "detail": state["rerank_err"]})
                texts = req.get("texts") or []
                query = str(req.get("query") or "")
                if not texts or not query:
                    return self._send(400, {"error": "query and texts required"})
                t0 = time.time()
                scores = reranker.score(query, [str(t)[:MAX_TEXT_CHARS] for t in texts])
                return self._send(
                    200,
                    {
                        "ok": True,
                        "count": int(len(scores)),
                        "ms": round((time.time() - t0) * 1000, 2),
                        "providers": state["info"].get("providers"),
                        "model": state["rerank_info"].get("rerank_model"),
                        "scores": [round(float(x), 6) for x in scores],
                    },
                )
            # ---------------- 索引层 ----------------
            if path.startswith("/v1/repos/"):
                rest = unquote(path[len("/v1/repos/") :])
                ns, _, action = rest.partition("/")
                if not ns or not action:
                    return self._send(404, {"error": "bad path"})
                if action == "sync":
                    body = dict(req)
                    body.setdefault("tag", state["info"].get("tag"))
                    try:
                        payload = store.sync(ns, body)
                    except Exception as e:
                        name = type(e).__name__
                        if name == "RevisionConflict":
                            return self._send(409, {"error": "revision-conflict", "revision": e.revision, "needFull": e.need_full})
                        if name == "SyncDiverged":
                            return self._send(400, {"error": "diverged", "detail": str(e)})
                        raise
                    repo = store.repo(ns)
                    cap = ensure_capacity(repo["lineage_id"]) if repo else None
                    if cap:
                        return self._send(507, cap)
                    if payload["missing"]:
                        governor.kick(ns)
                    knn.invalidate(ns)
                    return self._send(200, payload)
                if action == "chunks":
                    r = store.put_chunks(ns, req.get("bodies") or [])
                    if r["accepted"]:
                        governor.kick(ns)
                    return self._send(200, r)
                if action == "embed":
                    if isinstance(req.get("rate"), (int, float)):
                        governor.set_rate(req["rate"])
                    governor.kick(ns)
                    return self._send(200, governor.status(ns))
                return self._send(404, {"error": "unknown repo action"})
            if path == "/v1/search":
                payload, code = search(
                    req.get("namespace") or "",
                    str(req.get("query") or ""),
                    int(req.get("k", 10)),
                    req.get("tag"),
                    int((req.get("rerank") or {}).get("candidates", 0)),
                )
                return self._send(code, payload)
            if path.startswith("/v1/admin/"):
                action = path[len("/v1/admin/") :]
                if action == "pause":
                    governor.pause()
                elif action == "resume":
                    governor.resume()
                elif action == "rate":
                    governor.set_rate(float(req.get("rate", governor.rate)))
                elif action == "gc":
                    lineage = req.get("lineage")
                    if not lineage:
                        return self._send(400, {"error": "lineage required"})
                    return self._send(200, store.gc(lineage, req.get("retentionDays", RETENTION_DAYS)))
                else:
                    return self._send(404, {"error": "unknown admin action"})
                return self._send(200, governor.status())
            if path.startswith("/v1/lineages/") and path.endswith("/adopt"):
                lid = unquote(path[len("/v1/lineages/") : -len("/adopt")])
                r = store.adopt(req.get("from") or "", lid, req.get("hashes"))
                knn.invalidate()
                return self._send(200, r)
            return self._send(404, {"error": "not found"})
        except Exception as e:
            log(f"{path} failed: {e}\n{traceback.format_exc()[-800:]}")
            return self._send(500, {"error": str(e), "trace": traceback.format_exc()[-600:]})


def make_server(port=None):
    port = PORT if port is None else port
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    log(f"listening on 0.0.0.0:{srv.server_address[1]}")
    return srv


def main():
    try:
        build()
    except Exception as e:
        state["err"] = f"{type(e).__name__}: {e}"
        log("build failed: " + traceback.format_exc())
    make_server().serve_forever()


if __name__ == "__main__":
    main()
