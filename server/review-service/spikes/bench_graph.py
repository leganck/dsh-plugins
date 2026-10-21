"""graph 真实仓库基准：建图耗时、符号/边数、查询延迟（p50/p95）。

跑法（容器内，需 tree-sitter）：
    python spikes/bench_graph.py /path/to/repo [--branch main]
"""

from __future__ import annotations

import os
import statistics
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.graph import Graph  # noqa: E402


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "/repo"
    db = os.path.join(tempfile.mkdtemp(prefix="graph-bench-"), "graph.db")
    if not os.path.isdir(root):
        print(f"目录不存在：{root}")
        return 2

    g = Graph(db, project_id="bench", branch="main")
    t0 = time.monotonic()
    stats = g.build(root)
    build_ms = int((time.monotonic() - t0) * 1000)
    total = g.stats()
    print(f"仓库 {root}")
    print(
        f"建图：{stats['files']} 文件 → 符号 {stats['symbols']} / 边 {stats['edges']}"
        f"（import {stats['import_edges']} / call {stats['call_edges']}），"
        f"解析成功 {stats['resolved']}、多候选 {stats['ambiguous']}、未解析 {stats['unresolved']}，"
        f"耗时 {build_ms} ms"
    )
    if stats.get("degraded"):
        print(f"降级语言：{stats['degraded'][:5]}")
    rss = 0
    try:
        import resource

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except Exception:  # noqa: BLE001
        pass

    ids = [r["id"] for r in g._q("SELECT id FROM graph_symbols WHERE kind!='module' LIMIT 200")]
    lat = []
    for sid in ids[:100]:
        t0 = time.monotonic()
        g.callers(sid, min_confidence=0.6)
        g.callees(sid, min_confidence=0.6)
        lat.append((time.monotonic() - t0) * 1000)
    if lat:
        lat.sort()
        p50 = statistics.median(lat)
        p95 = lat[max(0, int(len(lat) * 0.95) - 1)]
    else:
        p50 = p95 = 0.0
    print(
        f"查询：{len(lat)} 个符号 → callers+callees p50={p50:.2f} ms p95={p95:.2f} ms；"
        f"峰值内存 {rss:.0f} MB；DB {os.path.getsize(db)/1024/1024:.1f} MB"
    )
    t0 = time.monotonic()
    again = g.build(root)
    print(f"二次 build（未变更）：{int((time.monotonic()-t0)*1000)} ms，reused={again.get('reused')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
