# -*- coding: utf-8 -*-
"""人工判定视图：把「每条黄金 vs 它的候选」「E2 全部候选」打印出来，供逐条判定。

判定结果写到 `judge.json`（本脚本不改它，只打印；避免把机器初筛当人工结论）。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "server", "storage-hub"))
sys.path.insert(0, HERE)
import exp_pipeline  # noqa: E402
import run_eval  # noqa: E402
import score  # noqa: E402

RAW = os.path.join(HERE, "raw")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    golden = [json.loads(l) for l in open(score.GOLDEN, encoding="utf-8") if l.strip()]
    materials = json.load(open(score.MATERIALS, encoding="utf-8"))
    missing = {r["idx"] for r in materials if r.get("missing")}
    plan = {it["key"]: it for it in run_eval.e1_chunks() if it.get("text")}
    raw = score.load_raw()

    print("#" * 78)
    print("A. 黄金 vs 产出（含被 Review 拦截的）")
    for idx, g in enumerate(golden):
        if idx in missing:
            print("\n[%02d] 素材缺失（不计分母）" % idx)
            continue
        keys = [k for k, it in plan.items() if idx in (it.get("goldens") or [])]
        print("\n[%02d] lens=%s | %s" % (idx, g["lens"], g["what"]))
        print("     when=%s" % g["when_expr"])
        print("     素材 chunk: %s" % (keys,))
        found = False
        for rec in raw["e1"]:
            if rec["key"] not in keys:
                continue
            for c in rec.get("candidates") or []:
                sim = exp_pipeline.similarity(g["what"], c["what"])
                print("     ✓ [%s] sim=%.2f lens=%s cat=%s" % (rec["key"], sim, c["lens"], c["category"]))
                print("        what: %s" % c["what"])
                print("        when: %s" % c["when_expr"])
                print("        why : %s" % c["why"])
                found = True
            for b in rec.get("blocked") or []:
                sim = exp_pipeline.similarity(g["what"], b["what"])
                print("     ✗ [%s] sim=%.2f BLOCKED=%s" % (rec["key"], sim, b["reason"]))
                print("        what: %s" % b["what"])
                found = True
        if not found:
            print("     （该素材 chunk 无任何候选）")

    print("\n" + "#" * 78)
    print("B. E2 全部产出（逐条判垃圾）")
    for rec in raw["e2"]:
        print("\n-- %s status=%s elapsed=%ss cand=%d blocked=%d"
              % (rec["key"], rec["status"], rec.get("elapsed_s"),
                 len(rec.get("candidates") or []), len(rec.get("blocked") or [])))
        for c in rec.get("candidates") or []:
            h = __import__("hashlib").sha1((rec["key"] + c["what"]).encode("utf-8")).hexdigest()[:10]
            print("   %s cat=%-8s lens=%-6s" % (h, c["category"], c["lens"]))
            print("     what: %s" % c["what"])
            print("     when: %s" % c["when_expr"])
            print("     why : %s" % c["why"])
        for b in rec.get("blocked") or []:
            print("   BLOCKED %-30s %s" % (b["reason"], b["what"]))


if __name__ == "__main__":
    main()
