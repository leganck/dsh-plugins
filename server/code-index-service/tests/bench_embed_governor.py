"""诊断基准：量化 governor 的每批调度开销 + padding 浪费。

不需要 onnxruntime / 真实模型 / tokenizers。三个实验：

  1. 每批固定开销：pending 查询 / put_vectors / 锁 / 主循环本身（合成库，9467 块）。
     → 回答「0.8 块/秒 是不是调度器造成的」。
  2. 吞吐上界（stub embedder 计算耗时=0）→ 调度器自己的天花板。
  3. padding 浪费：tokenizer 把同一批 pad 到批内最长序列，而 governor 用
     `order by c.hash` 取块（长度随机）→ 每批都按「批内最长」付出算力。
     用 token 成本模型对比「随机顺序 batch=8」与「候选窗口内按长度分桶」。

跑法：`python tests/bench_embed_governor.py`
"""
import os
import random
import statistics
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import index_store  # noqa: E402
import governor as governor_mod  # noqa: E402

CHUNKS = 9467          # erp-pos 实测块数
PRE_EMBEDDED = 284     # coverage 0.03 ≈ 284/9467
DIM = 768
MAX_TOKENS = 512       # embedder.DEFAULT_PROFILE.max_tokens


def token_len(text):
    """粗略 token 数：中文/代码混合 ≈ 4 字符/token，上限 MAX_TOKENS（enable_truncation）。"""
    return max(1, min(MAX_TOKENS, len(text) // 4))


def make_db(path, chunks=CHUNKS, pre=PRE_EMBEDDED, dup_every=None):
    store = index_store.IndexStore(path)
    ns = "erp-pos#main"
    store.ensure_lineage("git@example.com:erp/pos.git", ns)
    store.ensure_repo(ns, "erp/pos", "fp1", index_store.lineage_id_of("git@example.com:erp/pos.git", ns),
                      tag="bge-base-zh-v1.5-abc12345-fp16")
    repo = store.repo(ns)
    rnd = random.Random(7)
    bodies = {}
    shared = "def handler(request):\n    return dispatch(request)  # 复制粘贴的样板代码\n" * 8
    for i in range(chunks):
        # 代码块长度分布：多数中等、少数极长（贴近真实 chunk 分布）；
        # 尾部加序号保证正文唯一（否则去重实验会被"只有 8 种正文"污染）。
        n = rnd.choice([120, 200, 300, 400, 600, 900, 1500, 2400])
        body = "x" * n + f"#{i}"
        if dup_every and i % dup_every == 0:
            body = shared  # 每 dup_every 块里有一块是复制粘贴的重复正文
        bodies["%064x" % (i + 1)] = body
    with store.lock:
        now = int(time.time())
        store.db.executemany(
            "insert or replace into chunks(namespace, lineage_id, path, start, \"end\", hash) values (?,?,?,?,?,?)",
            [(ns, repo["lineage_id"], f"src/f{i % 97}.py", i, i + 10, "%064x" % (i + 1)) for i in range(chunks)],
        )
        store.db.executemany(
            "insert or replace into blobs(lineage_id, hash, body, updated_at) values (?,?,?,?)",
            [(repo["lineage_id"], h, b, now) for h, b in bodies.items()],
        )
        hashes = list(bodies)[:pre]
        store.db.executemany(
            "insert or replace into vectors(lineage_id, tag, hash, dim, v, updated_at) values (?,?,?,?,?,?)",
            [(repo["lineage_id"], repo["tag"], h, DIM, b"\0" * (4 * DIM), now) for h in hashes],
        )
        store.db.commit()
        store._invalidate()
    return store, ns, repo


class StubKnn:
    def invalidate(self, namespace=None):
        pass


class StubEmbedder:
    """cost=0 时纯测调度开销；cost>0 时模拟模型计算。"""

    def __init__(self, sec_per_batch=0.0):
        self.sec_per_batch = sec_per_batch
        self.calls = 0
        self.chunks = 0

    def embed(self, texts, is_query=False):
        import numpy as np

        self.calls += 1
        self.chunks += len(texts)
        if self.sec_per_batch:
            time.sleep(self.sec_per_batch)
        return np.zeros((len(texts), DIM), dtype=np.float32)


def timed(fn, n=5):
    ts = []
    out = None
    for _ in range(n):
        t0 = time.perf_counter()
        out = fn()
        ts.append((time.perf_counter() - t0) * 1000)
    ts.sort()
    return out, ts[len(ts) // 2]


def exp1_db_latency(store, ns, tag, repo):
    print("\n== 1. 单次 DB 操作延迟（中位数，9467 块 / pending≈9183）==")
    import numpy as np

    for label, limit, order in (("pending(spread, limit=8)", 8, "spread"),
                                ("pending(spread, limit=32)", 32, "spread"),
                                ("pending(path,   limit=8)", 8, "path")):
        rows, ms = timed(lambda: store.pending(ns, tag, limit, order))
        print(f"  {label:28s} {ms:8.2f} ms  rows={len(rows)}")
    _, ms = timed(lambda: store.pending_count(ns, tag))
    print(f"  {'pending_count()':28s} {ms:8.2f} ms")
    _, ms = timed(lambda: store.counts(ns))
    print(f"  {'counts() 热缓存':28s} {ms:8.2f} ms")
    vec = np.zeros(DIM, dtype=np.float32)
    pairs8 = [("%064x" % (10_000 + i), vec) for i in range(8)]
    _, ms = timed(lambda: store.put_vectors(repo["lineage_id"], tag, pairs8), n=3)
    print(f"  {'put_vectors(8) 含 commit':28s} {ms:8.2f} ms")


def exp2_scheduler_ceiling(tmp):
    print("\n== 2. 调度器天花板（stub embedder 计算耗时=0）==")
    for batch in (8, 32, 64):
        store, ns, _repo = make_db(os.path.join(tmp, f"b{batch}.db"))
        emb = StubEmbedder(0.0)
        gov = governor_mod.EmbedGovernor(store, emb, StubKnn(), rate=0.0, batch=batch,
                                         order="spread", log=lambda *_: None)
        gov.kick(ns)
        n_batches = 20
        t0 = time.perf_counter()
        for _ in range(n_batches):
            gov._tick(gov._next_namespace())
        dt = time.perf_counter() - t0
        print(f"  batch={batch:3d}: {n_batches * batch / dt:9.1f} 块/秒上界"
              f"  每批固定开销 {dt / n_batches * 1000:6.2f} ms")
        store.close()

    print("  → 模型每批耗时可反推：0.8 块/秒 = 10 s/批（batch=8）")
    store, ns, _repo = make_db(os.path.join(tmp, "mix.db"))
    gov = governor_mod.EmbedGovernor(store, StubEmbedder(0.0), StubKnn(), rate=0.0, batch=8,
                                     order="spread", log=lambda *_: None)
    gov.kick(ns)
    t0 = time.perf_counter()
    for _ in range(10):
        gov._tick(gov._next_namespace())
    overhead_ms = (time.perf_counter() - t0) / 10 * 1000
    print(f"  实测 batch=8 每批固定开销 = {overhead_ms:.2f} ms")
    for model_ms in (100, 1000, 5000, 10000):
        per_batch = overhead_ms + model_ms
        print(f"    模型 {model_ms:6d} ms/批 → {8 / per_batch * 1000:6.2f} 块/秒"
              f"（固定开销占比 {overhead_ms / per_batch * 100:4.1f}%）")
    store.close()


def padding_stats(lengths, batch, window):
    """模拟连续取块：hash 顺序（随机长度） vs 窗口内按长度分桶。返回 token 数。"""
    import governor as g

    if not lengths:
        return {"baseline": 0, "bucketed": 0, "ideal": 0, "batches": 0, "groups": 0}
    # baseline：每次按 hash 顺序取 batch 个
    baseline = 0
    for i in range(0, len(lengths), batch):
        part = lengths[i:i + batch]
        baseline += len(part) * max(part)
    # bucketed：每次取 window*batch 个候选，按长度排序后等分成分桶
    bucketed = 0
    groups = 0
    for i in range(0, len(lengths), window * batch):
        cand = lengths[i:i + window * batch]
        order = sorted(range(len(cand)), key=lambda k: cand[k])
        for grp in g._balanced_groups(order, batch):
            groups += 1
            bucketed += len(grp) * max(cand[k] for k in grp)
    return {"baseline": baseline, "bucketed": bucketed, "ideal": sum(lengths),
            "batches": (len(lengths) + batch - 1) // batch, "groups": groups}


def exp3_padding(tmp):
    print("\n== 3. padding 浪费：随机 hash 顺序 vs 长度分桶（token 成本模型 chars/4≤512）==")
    store, ns, _repo = make_db(os.path.join(tmp, "pad.db"), chunks=PRE_EMBEDDED)  # 只建仓库骨架
    bodies = ["x" * n for n in (120, 200, 300, 400, 600, 900, 1500, 2400) * 700]
    random.Random(11).shuffle(bodies)
    bufs = bodies[:9000]
    lengths = [token_len(b) for b in bufs]
    print(f"  样本 {len(lengths)} 块  token: 均值 {statistics.mean(lengths):.0f}"
          f" / 中位 {statistics.median(lengths):.0f} / 最大 {max(lengths)}")
    print(f"  {'窗口×批':12s} {'批数':>5s} {'模型调用':>7s} {'受 padding 影响的 token 数':>26s} {'相对理想':>8s} {'提速':>6s}")
    base_ref = None
    for window, batch in ((1, 8), (3, 8), (3, 16), (4, 8), (6, 8), (3, 32)):
        st = padding_stats(lengths, batch, window)
        if window == 1 and batch == 8:
            base_ref = st["bucketed"]
        ratio = st["bucketed"] / st["ideal"]
        speedup = (base_ref / st["bucketed"]) if base_ref else 1.0
        print(f"  {f'{window}×{batch}':12s} {st['batches']:5d} {st['groups']:7d}"
              f" {st['bucketed']:26d} {ratio:7.2f}x {speedup:5.2f}x")
    store.close()


def _simulate(tmp, name, window, dedupe, sec_per_token, dup_every=None):
    """用虚拟时钟跑真实 governor：模型耗时 = padding 后的 token 数 × sec_per_token。"""
    import numpy as np

    store, ns, _repo = make_db(os.path.join(tmp, name), dup_every=dup_every)
    pending0 = store.pending_count(ns, store.repo(ns)["tag"])

    class VirtualClock:
        def __init__(self):
            self.t = 0.0

        def __call__(self):
            return self.t

    clock = VirtualClock()

    class CostEmbedder:
        def __init__(self):
            self.calls = 0
            self.padded = 0

        def embed(self, texts, is_query=False):
            self.calls += 1
            toks = [token_len(t) for t in texts]
            batch_padded = len(texts) * max(toks)          # tokenizer 补到批内最长
            self.padded += batch_padded
            clock.t += batch_padded * sec_per_token        # 虚拟时间：模型算完
            return [np.zeros(DIM, dtype=np.float32)] * len(texts)

    emb = CostEmbedder()
    gov = governor_mod.EmbedGovernor(store, emb, StubKnn(), rate=0.0, batch=8, window=window,
                                     dedupe=dedupe, log=lambda *_: None, clock=clock)
    gov.kick(ns)
    ticks = 0
    while ticks < 20_000 and store.pending(ns, store.repo(ns)["tag"], 1):
        gov._tick(ns)
        ticks += 1
    dots = float(pending0) / clock.t if clock.t > 0 else 0.0
    store.close()
    return {"chunks": pending0, "seconds": clock.t, "ticks": ticks, "calls": emb.calls,
            "padded": emb.padded, "rate": dots}


def exp4_projected_throughput(tmp):
    print("\n== 4. 端到端预估吞吐（虚拟时钟，模型耗时 ∝ padding 后 token 数）==")
    # 用生产实测标定：baseline（window=1，老行为）在 erp-pos 是 0.8 块/秒
    store, ns, repo = make_db(os.path.join(tmp, "cal.db"))
    first = store.pending(ns, repo["tag"], 8, "spread")
    batch_tokens = 8 * max(token_len(it["body"]) for it in first)
    store.close()
    sec_per_token = 10.0 / batch_tokens       # 10 s/批（batch=8）取自重测数据
    print(f"  标定：首个 batch=8 的 padding token = {batch_tokens}，生产实测 10 s/批"
          f" → {sec_per_token * 1000:.3f} ms/token")
    print(f"  {'配置':28s} {'批数':>6s} {'模型调用':>7s} {'padding token':>13s} {'预估块/秒':>9s} {'相对旧':>7s}")
    base = None
    for window in (1, 3, 4, 6):
        r = _simulate(tmp, f"sim-w{window}.db", window, False, sec_per_token)
        if base is None:
            base = r["rate"]
        print(f"  {f'window={window} dedupe=off':28s} {r['ticks']:6d} {r['calls']:7d}"
              f" {r['padded']:13d} {r['rate']:9.3f} {r['rate'] / base:6.2f}x")


def exp5_dedupe_gain(tmp):
    print("\n== 5. 同批正文去重收益（20% 的块是复制粘贴的重复正文）==")
    store, ns, repo = make_db(os.path.join(tmp, "cal2.db"), dup_every=5)
    first = store.pending(ns, repo["tag"], 8, "spread")
    sec_per_token = 10.0 / (8 * max(token_len(it["body"]) for it in first))
    store.close()
    out = {}
    for dedupe in (False, True):
        r = _simulate(tmp, f"dup-{int(dedupe)}.db", 3, dedupe, sec_per_token, dup_every=5)
        out[dedupe] = r
        print(f"  dedupe={'on ' if dedupe else 'off'}: {r['ticks']:5d} 批 {r['calls']:5d} 次模型调用"
              f"  {r['padded']:9d} token  {r['rate']:6.3f} 块/秒")
    gain = out[True]["rate"] / out[False]["rate"]
    print(f"  → 去重收益 {gain:.2f}x（重复率 20%）")
    print(f"  → 去重 + window=3 合计 "
          f"{out[True]['rate'] / _simulate(tmp, 'dup-base.db', 1, False, sec_per_token, dup_every=5)['rate']:.2f}x")


def main():
    tmp = tempfile.mkdtemp(prefix="bench-gov-")
    db = os.path.join(tmp, "index.db")
    store, ns, repo = make_db(db)
    tag = repo["tag"]
    print(f"[db] {db}  chunks={CHUNKS} pre_embedded={PRE_EMBEDDED} pending={store.pending_count(ns, tag)}")
    exp1_db_latency(store, ns, tag, repo)
    store.close()
    exp2_scheduler_ceiling(tmp)
    exp3_padding(tmp)
    exp4_projected_throughput(tmp)
    exp5_dedupe_gain(tmp)


if __name__ == "__main__":
    main()
