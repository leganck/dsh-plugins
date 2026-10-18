#!/usr/bin/env python3
"""精确 kNN vs 二值量化两阶段检索：**同一批向量、同一批查询**的对照实测。

为什么值得比：ANN 类方案（HNSW/IVF-PQ）都要引入原生依赖，而"符号位二值化 + 精确重排"
只用 numpy 就能把常驻内存砍到 1/30 —— 代价是粗筛阶段会漏掉一部分真值。
这个脚本就是量那个代价：**Recall@10 / Recall@40 相对精确解** + 各自的耗时与内存。

做法：
  ① 从线上库里读某个命名空间的全部向量（只读打开，不动服务）
  ② 用服务自己的 /embed 给查询编码（保证与索引同一模型、同一个 tag）
  ③ 精确解 = M @ q；二值解 = sign 打包 768 bit（96 B/块）→ popcount 排序 → 取前 K
  ④ 两种重排：不重排（纯二值）/ 用 fp32 重排前 K

跑法（在容器里，能直接用 numpy 且能访问 127.0.0.1:8000）：
  docker exec -i dsh-embed sh -c 'PYTHONPATH=/app/pylib119:/app/pylib python -' < bench_knn_modes.py
"""
import json
import sqlite3
import sys
import time
import urllib.request

import numpy as np

DB = "/app/out/index.db"
EMBED_URL = "http://127.0.0.1:8000/embed"
TOP = 40          # 与插件融合时用的候选数一致
RESCORE_KS = [100, 200, 400, 1000]

QUESTIONS = [
    "怎么解析查询字符串",
    "索引刷新是怎么触发的",
    "集群状态是怎么合并的",
    "分片分配失败了会怎么处理",
    "聚合结果的归约在哪实现",
    "搜索请求的超时是怎么设置的",
    "文档写入的冲突怎么解决",
    "快照恢复的流程是什么",
    "段合并策略在哪里配置",
    "字段映射冲突时怎么校验",
    "查询缓存什么时候失效",
    "线程池的队列满了会怎样",
    "副本分片是怎么同步的",
    "集群健康状态是怎么计算的",
    "模板搜索是怎么解析的",
    "排序字段缺失时怎么处理",
    "scroll 查询是怎么保持上下文的",
    "高亮片段是怎么生成的",
    "索引模板是怎么应用的",
    "节点加入集群要经过哪些步骤",
    "错误重试策略在哪里定义",
    "写入压力大的时候怎么限流",
    "查询 DSL 是怎么转成内部表示的",
    "地理位置查询怎么实现的",
    "分词器的配置放在哪里",
    "别名切换是怎么保证原子性的",
    "文档删除是立即生效的吗",
    "统计信息是从哪里采集的",
    "权限校验是怎么做的",
    "跨集群搜索是怎么路由的",
    "how does the shard allocation decider work",
    "where is the query parser implemented",
    "how are aggregations reduced across shards",
    "what happens when a node leaves the cluster",
    "how is the translog flushed to disk",
    "where is the index template applied",
    "how does the circuit breaker work",
    "what is the role of the cluster state applier",
    "how are snapshots deduplicated",
    "where is the rest handler registered",
]


def load_vectors():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    row = con.execute(
        "select r.namespace, r.lineage_id, r.tag, (select count(*) from chunks c where c.namespace = r.namespace) as n"
        " from repos r order by n desc limit 1"
    ).fetchone()
    ns, lineage, tag, n = row["namespace"], row["lineage_id"], row["tag"], row["n"]
    rows = con.execute(
        "select c.hash, v.v, v.dim from chunks c join vectors v"
        " on v.lineage_id = c.lineage_id and v.tag = ? and v.hash = c.hash where c.namespace = ?",
        (tag, ns),
    ).fetchall()
    dim = rows[0]["dim"]
    hashes = [r["hash"] for r in rows]
    mat = np.empty((len(rows), dim), dtype=np.float32)
    for i, r in enumerate(rows):
        mat[i] = np.frombuffer(r["v"], dtype=np.float32, count=r["dim"])
    return ns, lineage, tag, hashes, mat


def embed_queries(texts):
    body = json.dumps({"texts": texts, "is_query": True}).encode()
    req = urllib.request.Request(EMBED_URL, data=body, method="POST")
    req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=300) as r:
        payload = json.loads(r.read())
    raw = np.frombuffer(__import__("base64").b64decode(payload["vectors_b64"]), dtype=np.float32)
    return raw.reshape(payload["count"], payload["dim"])


def popcount_rows(x):
    """按行统计 popcount。

    numpy>=2.0 自带 `np.bitwise_count`（ufunc、走 SIMD）。早期版本用 256 项查表 +
    花式索引，在 16 万 × 96 字节上要 20+ ms —— 比精确点积还慢，属于"实现把方案拖死"。
    """
    if hasattr(np, "bitwise_count"):
        return np.bitwise_count(x).sum(axis=1, dtype=np.int32)
    lut = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)
    return lut[x].sum(axis=1, dtype=np.int32)


def pack_bits(mat):
    """sign → 1 bit/维，768 维 = 96 字节/块。

    **调用方必须先减去语料均值**：bge 这类句向量的分布是各向异性的（所有向量共享一个
    很强的共同分量），直接对原始向量取符号位 → 几乎每一位都相同，Hamming 距离退化成
    常数，实测 Recall@10 只有 24%。中心化之后才是一份"有区分度"的二值编码。
    """
    return np.packbits(mat > 0, axis=1)


def topk_index(scores, k):
    """按分数取前 k 的下标（分数已排好方向：越大越好）。"""
    k = min(k, scores.shape[0])
    idx = np.argpartition(-scores, k - 1)[:k]
    return idx[np.argsort(-scores[idx])]


def main():
    t0 = time.time()
    ns, lineage, tag, hashes, mat = load_vectors()
    load_s = time.time() - t0
    n, dim = mat.shape
    print(f"命名空间：{ns}")
    print(f"向量：{n} × {dim}（tag {tag}）")
    print(f"加载：{load_s:.1f} s；精确矩阵 {mat.nbytes / 1048576:.0f} MB")

    t0 = time.time()
    mean = mat.mean(axis=0, dtype=np.float32)
    bits = pack_bits(mat - mean)          # 先中心化，再取符号位
    pack_s = time.time() - t0
    print(f"二值索引：{bits.nbytes / 1048576:.1f} MB（{bits.shape[1]} B/块），构建 {pack_s:.1f} s（含中心化）")

    # 随机正交旋转：把方差摊到所有维度上。二值量化不做这一步时，少数高方差维主导 Hamming
    # 距离，剩下几百位的符号基本是噪声 —— 实测 Recall@10 只有 22%。
    t0 = time.time()
    rng = np.random.default_rng(20261018)
    rot, _ = np.linalg.qr(rng.standard_normal((dim, dim)).astype(np.float32))
    rot = rot.astype(np.float32)
    rot_s = time.time() - t0
    t0 = time.time()
    mat_rot = (mat - mean) @ rot
    bits_rot = pack_bits(mat_rot)
    rot_build_s = time.time() - t0
    print(f"旋转矩阵：{dim}×{dim}，QR {rot_s:.1f} s；旋转+二值化 {rot_build_s:.1f} s（一次性）")
    del mat_rot

    Q = embed_queries(QUESTIONS)
    print(f"查询：{len(QUESTIONS)} 条（用服务自己的 /embed 编码，{Q.shape[0]} × {Q.shape[1]}）\n")

    # ---------------- 精确 ----------------
    exact_times = []
    exact_top = []
    for q in Q:
        t = performance = time.perf_counter()
        idx = topk_index(mat @ q, TOP)
        exact_times.append((time.perf_counter() - t) * 1000)
        exact_top.append(idx)

    # ---------------- 二值粗筛 ----------------
    def recall(ref_list, got_list, k):
        hit = 0
        for ref, got in zip(ref_list, got_list):
            hit += len(set(ref[:k].tolist()) & set(got[:k].tolist()))
        return hit / (len(ref_list) * k)

    def eval_variant(title, codes, query_codes):
        times = []
        cand = []
        for qb in query_codes:
            t = time.perf_counter()
            ham = popcount_rows(np.bitwise_xor(codes, qb))
            k0 = min(4000, n - 1)
            order = np.argpartition(ham, k0)[:k0]
            cand.append(order[np.argsort(ham[order])])
            times.append((time.perf_counter() - t) * 1000)
        bn = np.array(times)
        raw10 = recall(exact_top, cand, 10) * 100
        raw40 = recall(exact_top, cand, 40) * 100
        print(f"\n{title}  粗筛 p50 {np.percentile(bn, 50):.1f} ms  纯二值 R@10 {raw10:.1f}% / R@40 {raw40:.1f}%")
        print(f"  {'方案':<26}{'p50 ms':>9}{'p90 ms':>9}{'R@10':>8}{'R@40':>8}")
        for K in RESCORE_KS:
            res_times = []
            got = []
            for i in range(len(Q)):
                t = time.perf_counter()
                idx = cand[i][:K]
                scores = mat[idx] @ Q[i]
                got.append(idx[np.argsort(-scores)])
                res_times.append((time.perf_counter() - t) * 1000)
            tot = bn + np.array(res_times)
            print(
                f"  {'二值 + fp32 重排 top-' + str(K):<24}"
                f"{np.percentile(tot, 50):>9.1f}{np.percentile(tot, 90):>9.1f}"
                f"{recall(exact_top, got, 10) * 100:>7.1f}%{recall(exact_top, got, 40) * 100:>7.1f}%"
            )

    print(f"\n{'① 精确（全量比对）':<26}{np.percentile(np.array(exact_times), 50):>9.1f}"
          f"{np.percentile(np.array(exact_times), 90):>9.1f}{100.0:>7.0f}%{100.0:>7.0f}%")

    eval_variant("② 二值（仅中心化）", bits, pack_bits(Q - mean))
    eval_variant("③ 二值（中心化 + 随机旋转）", bits_rot, pack_bits((Q - mean) @ rot))

    print("\n内存对照：")
    print(f"  精确：{mat.nbytes / 1048576:>8.0f} MB（fp32 全量常驻）")
    print(f"  二值：{bits.nbytes / 1048576:>8.1f} MB + 重排临时 {RESCORE_KS[-1] * dim * 4 / 1048576:.1f} MB")
    print(f"  倍数：{mat.nbytes / bits.nbytes:.0f}×（另需一次性 {dim * dim * 4 / 1048576:.1f} MB 旋转矩阵）")


if __name__ == "__main__":
    main()
