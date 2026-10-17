"""kNN 矩阵缓存：每个 (namespace, tag) 一份 fp32 矩阵，按 revision 失效、按总字节 LRU。

实测（NAS 12 线程 CPU、160,507 块 × 768 维）：
  fp32 矩阵 470 MB，查询 **14.3 ms**（`M @ q` + argpartition）
  fp16 矩阵只有 235 MB，但 numpy 的 fp16 matmul 没有优化 BLAS → **452 ms**，反而慢 30 倍。
所以：**磁盘存 fp32、内存也存 fp32**，不要用 fp16 省内存 —— 那个省法会把查询拖垮。
单命名空间超过约 40 万块（≈1.2 GB）或常驻命名空间变多时，才考虑换成 hnswlib/faiss。
"""
import threading
from collections import OrderedDict

import numpy as np


class KnnCache:
    def __init__(self, store, max_bytes=2 * 1024**3):
        self.store = store
        self.max_bytes = max_bytes
        self._cache = OrderedDict()  # key -> (bytes, revision, hashes, mat, meta)
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    def _key(self, namespace, tag):
        return f"{namespace}\0{tag}"

    def get(self, namespace, tag):
        key = self._key(namespace, tag)
        with self._lock:
            entry = self._cache.get(key)
        if entry is not None:
            nbytes, revision, hashes, mat, meta = entry
            repo = self.store.repo(namespace)
            if repo and int(repo["revision"]) == revision and (repo["tag"] or "") == (tag or ""):
                with self._lock:
                    self._cache.move_to_end(key)
                    self.hits += 1
                return hashes, mat, meta
        hashes, mat, meta = self.store.matrix(namespace, tag)
        revision = int((self.store.repo(namespace) or {}).get("revision", 0))
        nbytes = int(mat.nbytes)
        with self._lock:
            self.misses += 1
            self._cache[key] = (nbytes, revision, hashes, mat, meta)
            self._cache.move_to_end(key)
            total = sum(v[0] for v in self._cache.values())
            while total > self.max_bytes and len(self._cache) > 1:
                _, (nb, *_rest) = self._cache.popitem(last=False)
                total -= nb
                self.evictions += 1
        return hashes, mat, meta

    def invalidate(self, namespace=None):
        with self._lock:
            if namespace is None:
                self._cache.clear()
            else:
                for k in list(self._cache):
                    if k.startswith(namespace + "\0"):
                        self._cache.pop(k, None)

    def stats(self):
        with self._lock:
            return {
                "entries": len(self._cache),
                "bytes": sum(v[0] for v in self._cache.values()),
                "hits": self.hits,
                "misses": self.misses,
                "evictions": self.evictions,
                "maxBytes": self.max_bytes,
            }

    @staticmethod
    def topk(mat, qvec, k):
        """余弦相似度 top-k（矩阵与查询都已 L2 归一化 → 点积即可）。"""
        if mat.shape[0] == 0:
            return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.float32)
        scores = mat @ qvec
        k = min(int(k), mat.shape[0])
        idx = np.argpartition(-scores, k - 1)[:k]
        order = idx[np.argsort(-scores[idx])]
        return order, scores[order]
