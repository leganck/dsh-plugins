"""嵌入治理：限流、暂停、优先级、后台续跑。

实测定位（NAS Tesla P4）：1000 块的**网络只花 0.7 s**，服务端计算 35–39 s ——
瓶颈是 GPU，不是网络。所以"别把 NAS 打满"要加在**嵌入侧**：

  · 默认 10 块/s = P4 峰值（26.8）的 37%：单个 16 万块的大仓 ≈ 4.5 小时，随时可调
  · `pause()/resume()`：让出 GPU 给别的容器，进度保留
  · `order='spread'`（按 hash 排序）：先嵌的块在全仓均匀分布，部分索引立刻可检索
  · 后台线程：HTTP 请求只入队，不等长活；进度走 `/status`

## 吞吐（2026-11-18 实测 0.8 块/秒 的定位与改动）

CPU 容器（4 线程，bge-base fp16）实测 0.8 块/秒 = **10 s/批（batch=8）**，
而本文件每批的固定开销（pending 查询 + put_vectors + commit + 锁）实测 0.9 ms
（`tests/bench_embed_governor.py`）—— 调度不是瓶颈，**模型调用本身是**。
但取块方式把模型算力浪费掉了两处，本文件改掉：

  · padding 浪费：tokenizer 把同一批补齐到**批内最长**序列，而 `order='spread'`
    按 hash 取块 → 批内长度随机，每批都按"最长的那个"付算力。改法：
    一次取 `window×batch` 个候选，**按长度排序后等分成 batch 大小的子批**
    （`_balanced_groups`）→ 每个子批长度相近，padding 从"随机样本最大值"
    降到"排序八分位最大值"。
  · 重复正文：代码块里完全相同的正文很常见，逐块送模型是纯浪费。改法：
    同一批内按正文去重（`dedupe=True`），相同正文只算一次、向量散播回去。

限速也从"算完再 sleep(need-dt)"改成**按截止时间分片等待**（`_throttle`）：
`set_rate/pause/stop` 最多 50 ms 内生效，而不是被一次长睡挡住。

`status()` 新增 `speed`（块/秒，滑动窗口实测）与 `etaSeconds`（pending/speed，
speed=0 时 null），`rate/paused/batch/coverage/pending` 语义不变。
"""
import collections
import threading
import time
import traceback

# speed 的滑动窗口（秒）：窗口内完成批次的块数 / 窗口内覆盖的时间。
SPEED_WINDOW = 30.0
# 窗口里只有一两批时的最小分母：否则"1 ms 嵌完 8 块"会算出 8000 块/秒。
SPEED_MIN_SPAN = 1.0
# 限速等待的切片：决定 set_rate/pause 的响应上限（50 ms）。
THROTTLE_SLICE = 0.05
# 候选窗口上界：window×batch 决定一次 `pending()` 的 limit，防止 env/admin 传个离谱值
# 把几万条正文一次性读进内存（正常 3~6 就够，收益在 window=6 已接近饱和）。
MAX_WINDOW = 64


def _clamp_window(window):
    return max(1, min(MAX_WINDOW, int(window)))


def _balanced_groups(order, batch):
    """把有序下标列表按顺序切成**尽量等大**的组，每组 ≤ batch。

    为什么等大而不是"每 batch 个一组、尾巴一小撮"：尾巴组太小（如 25 个 → 8,8,8,1）
    会让 GEMM 的批量优势丢一半；等大（25 → 7,6,6,6）多一次调用但总 token 更省。
    """
    n = len(order)
    batch = max(1, int(batch))
    if n <= batch:
        return [list(order)] if n else []
    k = (n + batch - 1) // batch
    base, extra = divmod(n, k)
    out, pos = [], 0
    for i in range(k):
        size = base + (1 if i < extra else 0)
        out.append(list(order[pos:pos + size]))
        pos += size
    return out


class EmbedGovernor:
    def __init__(self, store, embedder, knn, rate=10.0, batch=8, order="spread", log=print,
                 window=3, dedupe=True, clock=time.monotonic):
        self.store = store
        self.embedder = embedder
        self.knn = knn
        self.rate = float(rate)
        self.batch = max(1, int(batch))
        # 候选窗口 = window × batch：一次多取几批候选，才能按长度分桶
        # （window=1 退化为"取多少嵌多少"，padding 与旧行为一致）。
        self.window = _clamp_window(window)
        self.dedupe = bool(dedupe)
        self.order = order
        self.log = log
        self.clock = clock
        self.paused = False
        self.stopping = False
        self._thread = None
        self._wake = threading.Event()
        self._ns_queue = []
        self._state = {}  # namespace -> {"lastError":..., "embeddedTotal":0, "lastBatchMs":0}
        self.lock = threading.Lock()
        # 热切换模型前排空用：_inflight 记录"正在 _tick 的批次数"（0 或 1），
        # 用 self.lock 上的 Condition 等待它归零。锁对象与现有 _next_namespace 共用。
        self._inflight = 0
        self._idle_waiters = 0
        self._idle_cv = threading.Condition(self.lock)
        # 实测吞吐：deque[(t_start, t_end, chunks)]，status 用它算 speed/etaSeconds。
        # 放在 _state 之外 —— status() 会把 _state 浅拷贝进 JSON，deque 不可序列化。
        self._events = collections.deque()
        self._ns_events = {}

    # ------------------------------------------------------------------ 控制
    def kick(self, namespace):
        with self.lock:
            if namespace not in self._ns_queue:
                self._ns_queue.append(namespace)
        self._wake.set()

    def set_rate(self, rate):
        self.rate = max(0.0, float(rate))
        self._wake.set()  # 让正在限速等待的 _throttle 立刻重算截止时间

    def set_batch(self, batch, window=None):
        """运行时改模型批大小（/v1/admin/rate 的 batch 字段）；已取到的批次不受影响。"""
        self.batch = max(1, int(batch))
        if window is not None:
            self.window = _clamp_window(window)
        self._wake.set()

    def pause(self):
        self.paused = True
        self._wake.set()  # 唤醒限速中的等待，尽快让出

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

    # ------------------------------------------------------------------ 排空（热切换用）
    def wait_idle(self, timeout=15.0):
        """等当前批处理（_tick）结束；返回 True=已空闲，False=超时仍在跑。

        模型热切换前建议**先 pause()** 再 wait_idle()：本方法只保证"返回瞬间没有正在
        执行的 _tick"，而主循环在它返回后可以立刻开始下一批（队列非空时）。
        线程安全：_inflight 的增减与等待都在 self.lock 上完成。
        """
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._idle_cv:
            self._idle_waiters += 1
            try:
                while self._inflight > 0:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    self._idle_cv.wait(remaining)
                return True
            finally:
                self._idle_waiters -= 1

    def _begin_tick(self):
        with self._idle_cv:
            self._inflight += 1

    def _end_tick(self):
        with self._idle_cv:
            if self._inflight > 0:
                self._inflight -= 1
            idle = self._inflight == 0
            waiters = self._idle_waiters
            if idle:
                self._idle_cv.notify_all()
        # 背靠背批次时 idle 窗口只有几微秒，而通知后主循环可能立刻开始下一批
        # （锁不保证公平）—— 有人在等就主动让出 1ms，否则 wait_idle 永远看到
        # _inflight==1，直到超时。没有等待者时零开销，不改变限流节拍。
        if idle and waiters:
            time.sleep(0.001)

    # ------------------------------------------------------------------ 状态
    def _speed(self, events, now):
        """滑动窗口实测吞吐（块/秒）。events: deque[(t_start, t_end, chunks)]，须持锁调用。"""
        while events and now - events[0][1] > SPEED_WINDOW:
            events.popleft()
        if not events:
            return 0.0
        span = now - events[0][0]
        if span < SPEED_MIN_SPAN:  # 窗口还没铺满 / 单批极快：用最小分母，避免天文数字
            span = SPEED_MIN_SPAN
        return sum(e[2] for e in events) / span

    def _record(self, namespace, t_start, t_end, chunks):
        with self.lock:
            self._events.append((t_start, t_end, chunks))
            q = self._ns_events.setdefault(namespace, collections.deque())
            q.append((t_start, t_end, chunks))
            now = self.clock()
            self._speed(q, now)  # 顺手按窗口淘汰旧样本（全局队列在 status/下次 record 里淘汰）
            self._speed(self._events, now)

    def status(self, namespace=None):
        """治理状态。新增 `speed`/`etaSeconds`；`rate/paused/batch/coverage/pending` 原义不变。

        · `speed`：滑动窗口（30 s）实测块/秒；暂停或窗口内无样本时为 0.0
        · `etaSeconds`：pending / speed；speed=0 → null，pending=0 → 0.0
        · `pending` 仍取 `store.pending_count()`（不是估算），所以 ETA 不会因口径漂移
        """
        now = self.clock()
        with self.lock:
            queue = list(self._ns_queue)
            st = dict(self._state) if namespace is None else {namespace: self._state.get(namespace, {})}
            global_speed = 0.0 if self.paused else self._speed(self._events, now)
            ns_speed = global_speed
            if namespace is not None and not self.paused:
                ns_speed = self._speed(self._ns_events.get(namespace) or collections.deque(), now)
        out = {
            "paused": self.paused,
            "rate": self.rate,
            "batch": self.batch,
            "window": self.window,
            "speed": round(ns_speed if namespace else global_speed, 3),
            "queue": queue,
            "spaces": st,
        }
        if namespace:
            repo = self.store.repo(namespace)
            if repo:
                out.update(self.store.counts(namespace))
                pending = self.store.pending_count(namespace, repo["tag"])
                out["pending"] = pending
                speed = out["speed"]
                if speed <= 0:
                    out["etaSeconds"] = None
                elif pending <= 0:
                    out["etaSeconds"] = 0.0
                else:
                    out["etaSeconds"] = round(pending / speed, 1)
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
                self._begin_tick()
                try:
                    self._tick(ns)
                finally:
                    # 无论 _tick 抛不抛（含限速睡眠被打断的极端情况）都必须清零并唤醒等待者，
                    # 否则热切换的 wait_idle 会一直等到超时。
                    self._end_tick()
            except Exception as e:  # 线程绝不允许因单次失败退出
                self.log(f"[governor] tick failed: {e}\n{traceback.format_exc()[-600:]}")

    def _next_namespace(self):
        """**轮转**取下一个命名空间（每批换一个），而不是把队首那个排干。

        为什么必须轮转：实测在一个 43,836 待嵌的大命名空间后面新建一个小仓库，
        它的 pending 永远轮不到 —— 服务端 100% 的 GPU 都喂给大仓，"新增的代码"在
        **语义通道**上一直搜不到（BM25 能搜到，所以症状很隐蔽）。
        一批 = 8 块，轮转几乎不影响大仓的整体吞吐（它本来就被限速在 10 块/s）。
        """
        with self.lock:
            if not self._ns_queue:
                return None
            ns = self._ns_queue.pop(0)
            self._ns_queue.append(ns)  # 排到队尾：下一批换别人
            return ns

    # ------------------------------------------------------------------ 一批
    def _plan(self, texts):
        """候选正文 → [(子批正文下标列表)]；同批内按正文去重，再按长度排序分桶。

        返回 (uniq_texts, groups, owner)：
          uniq_texts[i] 要送模型的正文；groups 是 uniq 下标的等大分桶；
          owner[i] 是 uniq 下标 i 覆盖的原始下标列表（散播向量用）。
        """
        uniq_texts, owner, seen = [], [], {}
        if self.dedupe:
            for i, text in enumerate(texts):
                j = seen.get(text)
                if j is None:
                    seen[text] = j = len(uniq_texts)
                    uniq_texts.append(text)
                    owner.append([i])
                else:
                    owner[j].append(i)
        else:
            uniq_texts = list(texts)
            owner = [[i] for i in range(len(texts))]
        # 长度分桶：padding 到批内最长，所以把长度相近的放一起
        order = sorted(range(len(uniq_texts)), key=lambda k: len(uniq_texts[k]))
        return uniq_texts, _balanced_groups(order, self.batch), owner

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
        t_start = self.clock()
        items = self.store.pending(namespace, tag, self.batch * self.window, self.order)
        if not items:
            self._drop(namespace)
            return
        texts = [it["body"] for it in items]
        uniq_texts, groups, owner = self._plan(texts)
        vecs = [None] * len(uniq_texts)
        for gi, group in enumerate(groups):
            # pause/stop 在子批之间生效：一个 tick 可能有 window 个子批（CPU 上一批几秒），
            # 不检查就得等整轮跑完才让出 —— 热切换的 wait_idle(15s) 会被拖到超时。
            if gi and (self.paused or self.stopping):
                break
            out = self.embedder.embed([uniq_texts[k] for k in group], is_query=False)
            for slot, k in enumerate(group):
                vecs[k] = out[slot]
        pairs = []
        for k, holes in enumerate(owner):
            if vecs[k] is None:  # 中途暂停：这一份没算，下一轮再取（向量不落库）
                continue
            for i in holes:
                pairs.append((items[i]["hash"], vecs[k]))
        if not pairs:
            return
        self.store.put_vectors(repo["lineage_id"], tag, pairs)
        self.knn.invalidate(namespace)
        t_end = self.clock()
        st = self._state.setdefault(namespace, {"embeddedTotal": 0})
        st["embeddedTotal"] += len(pairs)
        st["lastBatchMs"] = round((t_end - t_start) * 1000, 1)
        st["lastGroups"] = len(groups)
        st["lastDeduped"] = len(texts) - len(uniq_texts)
        st["lastError"] = None
        self._record(namespace, t_start, t_end, len(pairs))
        self._throttle(len(pairs), t_start)

    def _throttle(self, chunks, t_start):
        """按 rate 精确控速：本批应在 t_start + chunks/rate 结束，不够就补等到截止时间。

        分片等待（50 ms）而不是一次 sleep 到底：`pause()/set_rate(0)/stop()` 最多
        等 50 ms 生效，不会被 rate 很低时的一次长睡（如 64 块 @0.5 块/s = 128 s）挡住。
        """
        if self.rate <= 0:  # 0 = 不限速
            return
        while not self.stopping and not self.paused:
            if self.rate <= 0:  # 等待期间被 set_rate(0) 放开
                return
            # 截止时间**每轮重算**：set_rate 改了 rate 必须立刻反映到剩余时间，
            # 否则"先算好 deadline 再睡"的老写法会让新速率等到这批睡完才生效。
            remain = (t_start + chunks / self.rate) - self.clock()
            if remain <= 0:
                return
            self._wake.wait(min(remain, THROTTLE_SLICE))
            self._wake.clear()

    def _drop(self, namespace):
        with self.lock:
            if namespace in self._ns_queue:
                self._ns_queue.remove(namespace)
