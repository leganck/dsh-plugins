"""吞吐/调度单测：**不需要 onnxruntime、不需要模型**，全部用 stub embedder。

覆盖（验收标准 4）：
  · batch 调度：候选窗口大小、长度分桶是否真的降低 padding、子批不超过 batch
  · 同批正文去重：模型调用数下降，但每个 hash 都拿到向量
  · 限速：rate 精确控速、rate=0 不限速、set_rate/pause 能在几十毫秒内生效
  · speed 滑动窗口：多批累加、窗口外淘汰、最小分母（避免天文数字）
  · etaSeconds 边界：pending=0 → 0.0；speed=0 → None；正常 → pending/speed
  · 既有语义不变：rate/paused/batch/coverage/pending 原样保留，status JSON 可序列化

跑法：`python tests/test_embed_throughput.py`（全绿退出码 0）
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import governor as gov_mod  # noqa: E402

FAILS = []
CHECKS = [0]


def check(name, ok, detail=None):
    CHECKS[0] += 1
    if ok:
        print(f"  ok  {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name}  {detail if detail is not None else ''}")


def eq(name, got, want):
    check(name, got == want, f"got={got!r} want={want!r}")


# --------------------------------------------------------------------------- 桩
class Clock:
    """可注入时钟：t 手动推进（_record/_speed 用它做确定性断言）。"""

    def __init__(self, t=0.0):
        self.t = float(t)

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += float(dt)


class FakeStore:
    """内存版 IndexStore：pending 按插入序（≈ hash 序）取未嵌入的块。"""

    def __init__(self, hashes_bodies, tag="bge-base-zh-v1.5-abc-fp16"):
        self.bodies = dict(hashes_bodies)
        self.tag = tag
        self.embedded = {}          # hash -> vec
        self.put_calls = 0
        self.pending_limits = []

    def repo(self, namespace):
        return {"namespace": namespace, "lineage_id": "lin-1", "tag": self.tag}

    def pending(self, namespace, tag, limit=64, order="spread"):
        self.pending_limits.append(limit)
        out = []
        for h, body in self.bodies.items():
            if h in self.embedded:
                continue
            out.append({"hash": h, "body": body})
            if len(out) >= int(limit):
                break
        return out

    def put_vectors(self, lineage, tag, pairs):
        self.put_calls += 1
        for h, vec in pairs:
            self.embedded[h] = vec

    def pending_count(self, namespace, tag):
        return sum(1 for h in self.bodies if h not in self.embedded)

    def counts(self, namespace):
        total = len(self.bodies)
        done = len(self.embedded)
        return {"chunks": total, "vectors": done, "coverage": round(done / total, 4) if total else 0.0}


class StubKnn:
    def __init__(self):
        self.invalidated = 0

    def invalidate(self, namespace=None):
        self.invalidated += 1


class StubEmbedder:
    """记录每次模型调用的正文；向量 = (批次序号, 下标) 便于断言散播正确。"""

    def __init__(self, on_call=None):
        self.calls = []
        self.on_call = on_call

    def embed(self, texts, is_query=False):
        texts = list(texts)
        self.calls.append(texts)
        if self.on_call:
            self.on_call(len(self.calls), texts)
        # 向量内容不重要（FakeStore 原样存），但同正文必须得到同一个向量
        return [hash(t) for t in texts]

    @property
    def texts(self):
        return [t for call in self.calls for t in call]

    @property
    def padded_cost(self):
        """受 padding 影响的 token 数：每批 = 批大小 × 批内最长（模拟 tokenizer 补齐）。"""
        return sum(len(call) * max(len(t) for t in call) for call in self.calls if call)


def make_governor(store, embedder, **kw):
    kw.setdefault("rate", 0.0)
    return gov_mod.EmbedGovernor(store, embedder, StubKnn(), log=lambda *_: None, **kw)


# --------------------------------------------------------------------------- 用例
def test_batch_bucketing():
    print("\n[1] batch 调度：候选窗口 + 长度分桶")
    # 长度随机混排（模拟 order='spread' 按 hash 取块）：8 个短、8 个中、8 个长
    lens = [10, 400, 1000, 20, 380, 900, 30, 420, 1100, 40, 360, 950,
            50, 440, 1050, 60, 500, 1200, 70, 300, 850, 80, 320, 800]
    store = FakeStore([(f"h{i}", "x" * n) for i, n in enumerate(lens)])
    emb = StubEmbedder()
    g = make_governor(store, emb, batch=8, window=3)
    ns = "erp-pos#main"
    g.kick(ns)
    g._tick(ns)

    eq("一次 tick 取的候选数 = batch × window", store.pending_limits[0], 24)
    # 等分成分桶：24 个 → 3 个子批，每批 ≤ batch 且尽量等大
    eq("24 个候选 → 3 个子批", len(emb.calls), 3)
    check("每个子批 ≤ batch", all(len(c) <= 8 for c in emb.calls), [len(c) for c in emb.calls])
    check("子批大小尽量等大（8,8,8）", sorted(len(c) for c in emb.calls) == [8, 8, 8],
          [len(c) for c in emb.calls])
    # 长度分桶：子批按长度单调递增（后一批不低于前一批），不再长短混排
    maxes = [max(map(len, c)) for c in emb.calls]
    check("子批长度单调递增（分桶生效）", maxes == sorted(maxes), maxes)
    # padding 成本：分桶 vs 老行为（每批 8 个按插入序）
    baseline = 0
    for i in range(0, len(lens), 8):
        part = lens[i:i + 8]
        baseline += len(part) * max(part)
    check(f"padding token 数下降 ≥1.5 倍（{emb.padded_cost} < {baseline}）",
          emb.padded_cost * 1.5 <= baseline, f"new={emb.padded_cost} old={baseline}"
          f" 提速 {baseline / emb.padded_cost:.2f}x")
    eq("所有块都落库", len(store.embedded), len(lens))
    eq("向量无丢失/错位", sorted(store.embedded), sorted(f"h{i}" for i in range(len(lens))))
    eq("KNN 失效被调用", g.knn.invalidated, 1)
    eq("embeddedTotal 累计", g.status(ns)["spaces"][ns]["embeddedTotal"], 24)


def test_dedupe():
    print("\n[2] 同批正文去重")
    bodies = [("a1", "same body"), ("a2", "same body"), ("a3", "same body"),
              ("b1", "another body"), ("b2", "another body"), ("c1", "third")]
    store = FakeStore(bodies)
    emb = StubEmbedder()
    g = make_governor(store, emb, batch=8, window=3, dedupe=True)
    g.kick("ns")
    g._tick("ns")
    eq("6 块只有 3 个不同正文 → 1 次模型调用只送 3 条", len(emb.texts), 3)
    eq("6 个 hash 全部落库", len(store.embedded), 6)
    eq("同正文的向量一致", store.embedded["a1"], store.embedded["a2"])
    check("去重计数进状态", g.status("ns")["spaces"]["ns"]["lastDeduped"] == 3,
          g.status("ns")["spaces"]["ns"])

    store2 = FakeStore(bodies)
    emb2 = StubEmbedder()
    g2 = make_governor(store2, emb2, batch=8, window=3, dedupe=False)
    g2.kick("ns")
    g2._tick("ns")
    eq("dedupe=False 时 6 块 6 条都送模型", len(emb2.texts), 6)


def test_rate_and_interrupt():
    print("\n[3] 限速：精确控速 / rate=0 不限速 / set_rate 与 pause 快速生效")
    bodies = [(f"h{i}", "x" * 40) for i in range(64)]

    # rate=0 → 不限速
    store = FakeStore(bodies)
    g = make_governor(store, StubEmbedder(), batch=4, window=1, rate=0.0)
    g.kick("ns")
    t0 = time.monotonic()
    for _ in range(16):  # 64 块
        g._tick("ns")
    eq("rate=0 时 64 块一次性跑完", len(store.embedded), 64)
    check("rate=0 不等待（<0.5 s）", time.monotonic() - t0 < 0.5, time.monotonic() - t0)

    # rate=200 块/秒，batch=4 window=1 → 每批 4/200 = 20 ms
    store = FakeStore(bodies)
    g = make_governor(store, StubEmbedder(), batch=4, window=1, rate=200.0)
    g.kick("ns")
    t0 = time.monotonic()
    for _ in range(8):  # 32 块 → 应 ≈ 32/200 = 0.16 s
        g._tick("ns")
    dt = time.monotonic() - t0
    check(f"rate 生效（32 块 @200/s ≈ 0.16 s，实测 {dt:.3f} s）", 0.14 <= dt <= 0.6, dt)

    # set_rate 打断长睡眠：rate 极低时 tick 要睡很久，改 rate 必须立刻生效
    store = FakeStore(bodies)
    g = make_governor(store, StubEmbedder(), batch=8, window=1, rate=0.5)  # 一批要睡 16 s
    g.kick("ns")
    result = {}

    def run_tick():
        t0 = time.monotonic()
        g._tick("ns")
        result["elapsed"] = time.monotonic() - t0

    import threading

    th = threading.Thread(target=run_tick, daemon=True)
    th.start()
    time.sleep(0.15)
    g.set_rate(1000.0)  # 立刻放开
    th.join(timeout=2.0)
    check(f"set_rate 能打断限速等待（{result.get('elapsed', 99):.3f} s < 2 s）",
          (not th.is_alive()) and result.get("elapsed", 99) < 2.0, result)

    # pause 打断长睡眠
    store = FakeStore(bodies)
    g = make_governor(store, StubEmbedder(), batch=8, window=1, rate=0.5)
    g.kick("ns")
    result2 = {}

    def run_tick2():
        t0 = time.monotonic()
        g._tick("ns")
        result2["elapsed"] = time.monotonic() - t0

    th2 = threading.Thread(target=run_tick2, daemon=True)
    th2.start()
    time.sleep(0.15)
    g.pause()
    th2.join(timeout=2.0)
    check(f"pause 能打断限速等待（{result2.get('elapsed', 99):.3f} s < 2 s）",
          (not th2.is_alive()) and result2.get("elapsed", 99) < 2.0, result2)


def test_pause_between_subbatches():
    print("\n[4] 子批之间响应 pause（热切换 wait_idle 不被整轮拖住）")
    lens = [10, 20, 30, 40, 50, 60, 70, 80, 111, 222, 333, 444,
            1234, 2345, 3456, 4567, 5678, 6789, 100, 200, 300, 400, 500, 600]
    store = FakeStore([(f"h{i}", "x" * n) for i, n in enumerate(lens)])
    g = make_governor(store, StubEmbedder(), batch=8, window=3)

    def pause_after_first(call_no, _texts):
        if call_no == 1:
            g.pause()

    emb = StubEmbedder(on_call=pause_after_first)
    g.embedder = emb
    g.kick("ns")
    g._tick("ns")
    eq("只跑了第一个子批的模型调用", len(emb.calls), 1)
    eq("第一个子批的 8 块落库（其余留到下一轮）", len(store.embedded), 8)
    g.resume()
    g._tick("ns")
    eq("resume 后补齐剩下的", len(store.embedded), 24)


def test_speed_window():
    print("\n[5] speed 滑动窗口")
    clock = Clock(0.0)
    store = FakeStore([(f"h{i}", "x") for i in range(100)])
    g = gov_mod.EmbedGovernor(store, StubEmbedder(), StubKnn(), rate=0.0, batch=8, window=3,
                              log=lambda *_: None, clock=clock)
    ns = "ns"

    clock.advance(2.0)
    g._record(ns, 0.0, 2.0, 8)          # 2 秒嵌 8 块
    eq("单批 speed = 8/2 = 4.0", g.status(ns)["speed"], 4.0)

    clock.advance(1.0)                   # now=3，分母变成 3
    eq("窗口内分母随时间增长（8/3 ≈ 2.667）", g.status(ns)["speed"], 2.667)

    clock.advance(0.5)
    g._record(ns, 3.0, 3.5, 16)          # 窗口总量 24，起始 0，now=3.5
    eq("多批累加（24/3.5 ≈ 6.857）", g.status(ns)["speed"], 6.857)

    clock.advance(gov_mod.SPEED_WINDOW + 1.0)  # 超过窗口 → 旧样本淘汰
    eq("窗口外样本被淘汰（只剩 0 批 → 0.0）", g.status(ns)["speed"], 0.0)

    # 最小分母：单批极快不会算出天文数字
    clock2 = Clock(0.0)
    g2 = gov_mod.EmbedGovernor(store, StubEmbedder(), StubKnn(), rate=0.0, batch=8, window=3,
                               log=lambda *_: None, clock=clock2)
    clock2.advance(0.001)
    g2._record(ns, 0.0, 0.001, 8)
    eq("极快单批用最小分母 1 s（8 块/秒）", g2.status(ns)["speed"], 8.0)

    # 暂停时 speed 归零（否则 ETA 会一直显示旧速度）
    g2.pause()
    eq("paused → speed 0.0", g2.status(ns)["speed"], 0.0)


def test_eta_boundaries():
    print("\n[6] etaSeconds 边界")
    clock = Clock(0.0)
    bodies = [(f"h{i}", "x") for i in range(100)]

    # 正常：pending / speed
    store = FakeStore(bodies)
    g = gov_mod.EmbedGovernor(store, StubEmbedder(), StubKnn(), rate=0.0, batch=8, window=3,
                              log=lambda *_: None, clock=clock)
    ns = "ns"
    clock.advance(5.0)
    g._record(ns, 0.0, 5.0, 25)           # speed = 25/5 = 5 块/秒
    st = g.status(ns)
    eq("speed = 5.0", st["speed"], 5.0)
    eq("eta = pending/speed = 100/5 = 20.0", st["etaSeconds"], 20.0)

    # pending=0 → 0.0
    store.embedded.update({h: "v" for h, _ in bodies})
    eq("pending=0 → eta 0.0", g.status(ns)["etaSeconds"], 0.0)

    # speed=0（窗口外）→ None
    clock.advance(gov_mod.SPEED_WINDOW * 2)
    st2 = g.status(ns)
    eq("speed 归零后 speed=0.0", st2["speed"], 0.0)
    eq("speed=0 → eta null", st2["etaSeconds"], None)

    # pending>0 但暂停 → speed=0 → eta null
    store.embedded.clear()
    g.resume()
    clock.advance(0.1)
    g._record(ns, clock.t - 0.1, clock.t, 8)
    g.pause()
    st3 = g.status(ns)
    eq("paused → speed 0.0", st3["speed"], 0.0)
    eq("paused → eta null", st3["etaSeconds"], None)

    # 全局 status 不带 pending/eta（语义不变），但有 speed
    gst = g.status()
    check("全局 status 有 speed", "speed" in gst, list(gst))
    check("全局 status 不臆造 etaSeconds", "etaSeconds" not in gst, list(gst))


def test_status_semantics():
    print("\n[7] 既有字段语义不变 + JSON 可序列化")
    clock = Clock(0.0)
    store = FakeStore([(f"h{i}", "x") for i in range(10)])
    g = gov_mod.EmbedGovernor(store, StubEmbedder(), StubKnn(), rate=10.0, batch=8, window=3,
                              log=lambda *_: None, clock=clock)
    ns = "ns"
    clock.advance(1.0)
    g._record(ns, 0.0, 1.0, 8)
    st = g.status(ns)
    eq("rate 原义（配置值）", st["rate"], 10.0)
    eq("paused 原义", st["paused"], False)
    eq("batch 仍在", st["batch"], 8)
    eq("coverage 来自 store.counts", st["coverage"], store.counts(ns)["coverage"])
    eq("pending 来自 pending_count", st["pending"], 10)
    eq("chunks 仍在", st["chunks"], 10)
    # _state 里的 deque 不能漏进 JSON（status 会把 spaces 浅拷贝出去）
    json.dumps(g.status())
    json.dumps(st)
    check("status 可 JSON 序列化", True)

    # set_batch 影响下一 tick 的候选窗口；窗口下限 1
    g.set_batch(4, window=2)
    eq("set_batch 改 batch", g.batch, 4)
    eq("set_batch 改 window", g.window, 2)
    g.set_batch(0, window=0)
    eq("batch 下限 1", g.batch, 1)
    eq("window 下限 1", g.window, 1)
    store.pending_limits.clear()
    g.set_rate(0.0)  # 这个用例的时钟是冻结的（Clock），限速等待会等不到时间前进
    g._tick(ns)
    eq("下次 tick 取 batch×window 个候选", store.pending_limits[-1], 1)


def test_empty_namespace_dropped():
    print("\n[8] 取不到块 → 命名空间出队（不再空转）")
    store = FakeStore([])
    g = make_governor(store, StubEmbedder(), batch=8, window=3)
    g.kick("empty")
    eq("队列里有", g.status()["queue"], ["empty"])
    g._tick("empty")
    eq("空命名空间被摘出队列", g.status()["queue"], [])
    eq("没有模型调用", len(g.embedder.calls), 0)


def main():
    test_batch_bucketing()
    test_dedupe()
    test_rate_and_interrupt()
    test_pause_between_subbatches()
    test_speed_window()
    test_eta_boundaries()
    test_status_semantics()
    test_empty_namespace_dropped()
    print(f"\n{'-' * 60}\n{CHECKS[0]} 项检查，失败 {len(FAILS)}")
    if FAILS:
        for name in FAILS:
            print(f"  FAILED: {name}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
