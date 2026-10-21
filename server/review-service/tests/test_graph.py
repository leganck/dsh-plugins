"""graph 验收：15 项断言（需要 tree-sitter，Linux 容器内跑）。

跑法：
    python tests/test_graph.py            # 默认用 tests/fixtures/graph-sample
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:  # Windows 控制台默认 GBK：统一改成 UTF-8，避免中文/emoji 输出崩
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


from app.graph import Graph  # noqa: E402

PASS = 0
FAILS: list[str] = []
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "graph-sample")


def check(label: str, cond, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  [ok] {label}")
    else:
        FAILS.append(label)
        print(f"  [FAIL] {label}" + (f" —— {detail}" if detail else ""))


def sym_id(g: Graph, path: str, name: str) -> int | None:
    for row in g._q(
        "SELECT id FROM graph_symbols WHERE project_id=? AND branch=? AND path=? AND name=?",
        (g.project_id, g.branch, path, name),
    ):
        return int(row["id"])
    return None


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="graph-test-")
    repo = os.path.join(tmp, "repo")
    shutil.copytree(FIXTURE, repo)
    db = os.path.join(tmp, "review.db")

    g = Graph(db, project_id="7", branch="main")
    stats = g.build(repo, commit_sha="deadbeef")
    print(f"build: {stats}")

    # 1) 基本产出
    check("1. 建图产出符号与边", stats["symbols"] > 10 and stats["edges"] > 5, str({k: stats[k] for k in ("symbols", "edges")}))
    check("1b. 非源码文件被忽略（notes.txt 未进图）", not g._q(
        "SELECT 1 FROM graph_symbols WHERE path=?", ("notes.txt",)
    ))

    # 2) 同文件调用 1.0：User.save -> self.log()
    uid = sym_id(g, "a.py", "save")
    got = g.callees(uid, min_confidence=0.9) if uid else []
    check("2. 同文件调用置信度 1.0", any(c["callee"] == "log" and c["confidence"] == 1.0 for c in got), str(got[:2]))

    # 3) import 解析 0.9：a.py 调 b.py 的 helper
    hid = sym_id(g, "b.py", "helper")
    callers = g.callers(hid, min_confidence=0.9) if hid else []
    check("3. 跨文件经 import 解析置信度 0.9", any(c["caller_path"] == "a.py" and c["confidence"] == 0.9 for c in callers), str(callers[:3]))

    # 4) 全仓唯一名 0.6：m.py 调 n.py 的 beta（未 import）
    bid = sym_id(g, "n.py", "beta")
    callers = g.callers(bid, min_confidence=0.3) if bid else []
    check("4. 全仓库唯一同名置信度 0.6", any(c["caller_path"] == "m.py" and c["confidence"] == 0.6 for c in callers), str(callers[:3]))

    # 5) 多候选 0.3，且不进 evidence
    gids = [r["id"] for r in g._q(
        "SELECT id FROM graph_symbols WHERE project_id=? AND branch=? AND name='gamma'", (g.project_id, g.branch)
    )]
    callers03 = g.callers(gids[0], min_confidence=0.3) if gids else []
    check("5. 多候选同名置信度 0.3", any(c["caller_path"] == "q.py" and c["confidence"] == 0.3 for c in callers03), str(callers03[:3]))
    ev = g.evidence_edges(gids) if gids else []
    check("5b. evidence_edges 不含 <0.8 的边", all(e["confidence"] >= 0.8 for e in ev) and len(ev) == 0, str(ev[:2]))

    # 6) importers
    imp = g.importers("b.py")
    check("6. importers(b.py) 含 a.py", any(r["from_path"] == "a.py" for r in imp), str(imp))

    # 7) callees
    mid = sym_id(g, "a.py", "main")
    callees = g.callees(mid) if mid else []
    check("7. callees(main) 含 helper", any(c["callee"] == "helper" for c in callees), str(callees[:3]))

    # 8) tests_for
    tests = g.tests_for(mid) if mid else []
    check("8. tests_for(main) 命中 a_test.py", any(t["test_path"] == "a_test.py" for t in tests), str(tests))

    # 9) importers(types.ts)（TS 的 ./types 解析）
    imp_ts = g.importers("types.ts")
    check("9. TS 相对 import 解析（d.ts → types.ts）", any(r["from_path"] == "d.ts" for r in imp_ts), str(imp_ts))

    # 16) tsx：函数定义 + import 解析
    tsx_sid = sym_id(g, "h.tsx", "Comp")
    callees_tsx = g.callees(tsx_sid) if tsx_sid else []
    check("16. tsx 函数定义与调用解析", tsx_sid is not None and any(c["callee"] == "util" and c["confidence"] == 0.9 for c in callees_tsx), str(callees_tsx[:3]))

    # 17) groovy：AST 无声明节点时正则兜底（并记录降级原因）
    gid = sym_id(g, "g.groovy", "run")
    groovy_degraded = any(d["path"] == "g.groovy" for d in stats.get("degraded") or [])
    check("17. groovy 正则兜底 + 降级原因可见", gid is not None and groovy_degraded, str(stats.get("degraded")))

    # 10) 增量：第二次 build 全部复用
    stats2 = g.build(repo, commit_sha="deadbeef")
    check("10. 未变更时增量复用（reused>0）", stats2.get("reused", 0) > 0, str({k: stats2.get(k) for k in ("reused", "symbols")}))
    check("10b. 增量后符号数不变", stats2["symbols"] == stats["symbols"], f"{stats2['symbols']} vs {stats['symbols']}")

    # 11) graph_version 相同则秒回
    stats3 = g.build(repo, commit_sha="deadbeef")
    check("11. graph_version 相同直接返回（ms < 500）", stats3["ms"] < 500 and stats3.get("reused") == 1, str(stats3["ms"]))

    # 12) 改一个文件后只重建该文件
    with open(os.path.join(repo, "b.py"), "a", encoding="utf-8") as f:
        f.write("\n\ndef helper2():\n    return helper() + 1\n")
    stats4 = g.build(repo, commit_sha="deadbeef")
    check("12. 改 1 个文件时其它文件复用", stats4.get("reused", 0) >= 10 and stats4["symbols"] > stats2["symbols"], str({k: stats4.get(k) for k in ("reused", "symbols")}))

    # 13) prune：删除文件后清理
    os.remove(os.path.join(repo, "q.py"))
    pruned = g.prune(repo)
    check("13. prune 清理已删除文件", pruned["removed_paths"] >= 1, str(pruned))

    # 14) 大文件跳过
    big_dir = os.path.join(tmp, "big")
    os.makedirs(big_dir, exist_ok=True)
    with open(os.path.join(big_dir, "huge.py"), "w", encoding="utf-8") as f:
        f.write("def huge():\n    return 1\n" + "# pad\n" * 200000)
    g2 = Graph(os.path.join(tmp, "big.db"), project_id="8", branch="main")
    big_stats = g2.build(big_dir)
    check("14. >1MB 文件被跳过并计数", big_stats["skipped_large"] == 1, str(big_stats))

    # 15) importance 稳定
    ids = [sym_id(g, "a.py", "main"), sym_id(g, "b.py", "helper")]
    ids = [i for i in ids if i]
    imp1 = g.importance(ids)
    imp2 = g.importance(ids)
    check("15. importance 同输入同输出（0~1）", imp1 == imp2 and all(0.0 <= v <= 1.0 for v in imp1.values()), str(imp1))

    print(f"\n通过 {PASS}，失败 {len(FAILS)}")
    if FAILS:
        print("失败项：")
        for f in FAILS:
            print("  - " + f)
        return 1
    print("✅ graph 验收通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
