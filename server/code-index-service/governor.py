"""嵌入治理：限流、暂停、优先级、后台续跑。

实测定位（NAS Tesla P4）：1000 块的**网络只花 0.7 s**，服务端计算 35–39 s ——
瓶颈是 GPU，不是网络。所以"别把 NAS 打满"要加在**嵌入侧**：

  · 默认 10 块/s = P4 峰值（26.8）的 37%：单个 16 万块的大仓 ≈ 4.5 小时，随时可调
  · `pause()/resume()`：让出 GPU 给别的容器，进度保留
  · `order='spread'`（按 hash 排序）：先嵌的块在全仓均匀分布，部分索引立刻可检索
  · 后台线程：HTTP 请求只入队，不等长活；进度走 `/status`
"""
import threading
import time
import traceback


class EmbedGovernor:
    def __init__(self, store, embedder, knn, rate=10.0, batch=8, order="spread", log=print):
        self.store = store
        self.embedder = embedder
        self.knn = knn
        self.rate = float(rate)
        self.batch = int(batch)
        self.order = order
        self.log = log
        self.paused = False
        self.stopping = False
        self._thread = None
        self._wake = threading.Event()
        self._ns_queue = []
        self._state = {}  # namespace -> {"lastError":..., "embeddedTotal":0, "lastBatchMs":0}
        self.lock = threading.Lock()

    # ------------------------------------------------------------------ 控制
    def kick(self, namespace):
        with self.lock:
            if namespace not in self._ns_queue:
                self._ns_queue.append(namespace)
        self._wake.set()

    def set_rate(self, rate):
        self.rate = max(0.0, float(rate))

    def pause(self):
        self.paused = True

    def resume(self):
        self.paused = False
        self._wake.set()

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self.stopping = False
        self._thread = threading.Thread(target=self._loop, name="embed-governor", daemon=True)
        self._thread.start()

    def stop(self):
        self.stopping = True
        self._wake.set()

    # ------------------------------------------------------------------ 状态
    def status(self, namespace=None):
        with self.lock:
            queue = list(self._ns_queue)
            st = dict(self._state) if namespace is None else {namespace: self._state.get(namespace, {})}
        out = {"paused": self.paused, "rate": self.rate, "batch": self.batch, "queue": queue, "spaces": st}
        if namespace:
            repo = self.store.repo(namespace)
            if repo:
                out.update(self.store.counts(namespace))
                out["pending"] = self.store.pending_count(namespace, repo["tag"])
        return out

    # ------------------------------------------------------------------ 主循环
    def _loop(self):
        while not self.stopping:
            try:
                if self.paused:
                    self._wake.wait(0.5)
                    self._wake.clear()
                    continue
                ns = self._next_namespace()
                if not ns:
                    self._wake.wait(1.0)
                    self._wake.clear()
                    continue
                self._tick(ns)
            except Exception as e:  # 线程绝不允许因单次失败退出
                self.log(f"[governor] tick failed: {e}\n{traceback.format_exc()[-600:]}")

    def _next_namespace(self):
        with self.lock:
            if not self._ns_queue:
                return None
            return self._ns_queue[0]

    def _tick(self, namespace):
        repo = self.store.repo(namespace)
        if not repo:
            self._drop(namespace)
            return
        tag = repo["tag"]
        if not tag:
            # 还不知道模型标签：等客户端带 tag 的同步（同步里会写 tag）
            self._drop(namespace)
            return
        items = self.store.pending(namespace, tag, self.batch, self.order)
        if not items:
            self._drop(namespace)
            return
        t0 = time.time()
        texts = [it["body"] for it in items]
        vecs = self.embedder.embed(texts, is_query=False)
        self.store.put_vectors(repo["lineage_id"], tag, list(zip([it["hash"] for it in items], vecs)))
        self.knn.invalidate(namespace)
        dt = time.time() - t0
        st = self._state.setdefault(namespace, {"embeddedTotal": 0})
        st["embeddedTotal"] += len(items)
        st["lastBatchMs"] = round(dt * 1000, 1)
        st["lastError"] = None
        # 限流：本批应花 len/rate 秒，不够就补睡
        if self.rate > 0:
            need = len(items) / self.rate
            if dt < need:
                time.sleep(need - dt)

    def _drop(self, namespace):
        with self.lock:
            if namespace in self._ns_queue:
                self._ns_queue.remove(namespace)
