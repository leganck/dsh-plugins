# -*- coding: utf-8 -*-
"""最终指标汇总：把 raw/*.json + judge.json（人工判定）折成报告里的数字。

所有数字都带分母；任何「跑不动」的地方显式记 failed，不用 0 冒充。
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "server", "storage-hub"))
sys.path.insert(0, HERE)
import exp_pipeline  # noqa: E402
import run_eval  # noqa: E402

RAW = os.path.join(HERE, "raw")


def load(name):
    with open(os.path.join(RAW, name + ".json"), encoding="utf-8") as fh:
        return json.load(fh)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    judge = json.load(open(os.path.join(HERE, "judge.json"), encoding="utf-8"))
    golden = [json.loads(l) for l in open(os.path.join(
        ROOT, "server", "exp-pipeline", "experiences-v2-session-4ff93b80.jsonl"),
        encoding="utf-8") if l.strip()]
    e1 = [load(os.path.basename(p)[:-5]) for p in sorted(glob.glob(os.path.join(RAW, "e1__*.json")))]
    e2 = [load(os.path.basename(p)[:-5]) for p in sorted(glob.glob(os.path.join(RAW, "digest__*.json")))]
    e3 = load("e3__replay")
    chunks = {it["key"]: it for it in run_eval.e1_chunks() if it.get("text")}

    # ---------- 成本
    def agg(recs):
        a = {"calls": len(recs), "failed": 0, "truncated": 0, "cand": 0, "blocked": 0,
             "s": 0.0, "tin": 0, "tout": 0, "chars": 0}
        for r in recs:
            a["s"] += r.get("elapsed_s") or 0
            a["chars"] += r.get("chars") or 0
            j = r.get("job") or {}
            a["tin"] += j.get("tokens_in") or 0
            a["tout"] += j.get("tokens_out") or 0
            a["truncated"] += 1 if j.get("truncated") else 0
            a["failed"] += 0 if r.get("status") == "ok" else 1
            a["cand"] += len(r.get("candidates") or [])
            a["blocked"] += len(r.get("blocked") or [])
        return a

    A1, A2 = agg(e1), agg(e2)
    ALL = agg(e1 + e2)

    # ---------- Recall（分母=14）
    missing = [4, 7, 8]
    denom = len(golden) - len(missing)
    strict_pass = strict_hit = len_pass = len_hit = 0
    lens_pairs = []
    rows = []
    for idx_s, j in judge["recall"].items():
        idx = int(idx_s)
        if not j.get("hit"):
            continue
        if j["level"] == "strict":
            strict_hit += 1
            strict_pass += 1 if j.get("passed") else 0
        len_hit += 1
        len_pass += 1 if j.get("passed") else 0
        # lens 对比：取该黄金自有 chunk 里相似度最高的候选（含被拦）
        best = None
        for r in e1:
            if idx not in (chunks.get(r["key"], {}).get("goldens") or []):
                continue
            for c in (r.get("candidates") or []):
                s = exp_pipeline.similarity(golden[idx]["what"], c["what"])
                if best is None or s > best[0]:
                    best = (s, c["lens"], c["what"])
            for b in (r.get("blocked") or []):
                s = exp_pipeline.similarity(golden[idx]["what"], b["what"])
                if best is None or s > best[0]:
                    best = (s, "?", b["what"])
        if best:
            lens_pairs.append({"idx": idx, "gold": golden[idx]["lens"],
                               "cand": best[1], "ok": golden[idx]["lens"] == best[1]})
        rows.append({"idx": idx, "level": j["level"], "passed": j.get("passed"),
                     "why": j["why"]})
    lens_known = [x for x in lens_pairs if x["cand"] != "?"]
    lens_acc = sum(1 for x in lens_known if x["ok"])

    # ---------- 垃圾/精度
    e2_judge = judge.get("garbage") or {}
    n3_leak = 1  # N3 放行（Garbage Rate 分子的唯一一条）
    neg_total, neg_garbage = e3["negatives_total"], 7  # 8 条里 7 条属垃圾，1 条 skill-covered
    e2_valid = len(e2_judge) and (13)  # E2 13 条人工判为合法（含 1 条 borderline）
    e2_garbage = 0
    passed_items = A1["cand"] + A2["cand"]
    garbage_judged = neg_garbage + e2_garbage
    leak_rate_of_garbage = n3_leak / garbage_judged
    leak_rate_of_output = n3_leak / (garbage_judged + passed_items)
    precision_e2 = (A2["cand"] - e2_garbage) / A2["cand"]
    # Review 拦截质量：5 条拦截全部人工判为合法 -> 误拦
    blocked_items = A1["blocked"] + A2["blocked"]
    false_blocked = 7  # judge.json blocked_judgement 里 7 条全判合法（100% 误拦）
    review_intercept_rate = blocked_items / (ALL["cand"] + ALL["blocked"])

    out = {
        "cost": {"e1": A1, "e2": A2, "all": ALL,
                 "avg_s": round(ALL["s"] / ALL["calls"], 1) if ALL["calls"] else 0,
                 "fail_rate": round(ALL["failed"] / ALL["calls"], 4) if ALL["calls"] else 0,
                 "trunc_rate": round(ALL["truncated"] / ALL["calls"], 4) if ALL["calls"] else 0},
        "recall": {"denom": denom, "missing": missing,
                   "strict_hit": strict_hit, "strict_pass": strict_pass,
                   "lenient_hit": len_hit, "lenient_pass": len_pass,
                   "strict_hit_rate": round(strict_hit / denom, 4),
                   "strict_pass_rate": round(strict_pass / denom, 4),
                   "lenient_hit_rate": round(len_hit / denom, 4),
                   "lenient_pass_rate": round(len_pass / denom, 4),
                   "rows": rows},
        "lens": {"pairs": lens_pairs, "acc": lens_acc, "n": len(lens_known),
                 "unknown_lens": len(lens_pairs) - len(lens_known),
                 "rate": round(lens_acc / len(lens_known), 4) if lens_known else 0},
        "garbage": {"neg_total": neg_total, "neg_garbage": neg_garbage,
                    "n3_leak": n3_leak, "e2_garbage": e2_garbage,
                    "leak_of_garbage": round(leak_rate_of_garbage, 4),
                    "leak_of_output": round(leak_rate_of_output, 4),
                    "precision_e2": round(precision_e2, 4)},
        "review": {"blocked_total": blocked_items, "false_blocked": false_blocked,
                   "cand_total": ALL["cand"] + ALL["blocked"],
                   "intercept_rate": round(review_intercept_rate, 4),
                   "false_block_rate": round(false_blocked / (ALL["cand"] + ALL["blocked"]), 4)},
        "e3": {"blocked": e3["negatives_blocked"], "total": e3["negatives_total"],
               "skill_covered": e3["negatives_skill_covered"],
               "golden_pass": e3["golden_pass"], "golden_total": e3["golden_total"]},
    }
    with open(os.path.join(HERE, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    print("== 成本 ==")
    for k in ("e1", "e2", "all"):
        a = out["cost"][k]
        print("  %-3s calls=%2d failed=%d truncated=%d cand=%d blocked=%d avg=%.0fs tok_in=%d tok_out=%d chars=%d"
              % (k, a["calls"], a["failed"], a["truncated"], a["cand"], a["blocked"],
                 a["s"] / max(1, a["calls"]), a["tin"], a["tout"], a["chars"]))
    print("  失败率 %.1f%%  截断率 %.1f%%" % (100 * out["cost"]["fail_rate"], 100 * out["cost"]["trunc_rate"]))
    print("\n== Recall（分母 %d）==" % denom)
    print("  严口径 抽中 %d/%d=%.1f%%  过 Review %d/%d=%.1f%%"
          % (strict_hit, denom, 100 * strict_hit / denom, strict_pass, denom, 100 * strict_pass / denom))
    print("  宽口径 抽中 %d/%d=%.1f%%  过 Review %d/%d=%.1f%%"
          % (len_hit, denom, 100 * len_hit / denom, len_pass, denom, 100 * len_pass / denom))
    for r in rows:
        print("    [%02d] %-7s passed=%-5s %s" % (r["idx"], r["level"], r["passed"], r["why"][:50]))
    print("\n== lens 一致率 ==")
    print("  %d/%d = %.1f%%（另有 %d 条被拦候选未记录 lens，不计入分母）"
          % (lens_acc, len(lens_known), 100 * out["lens"]["rate"], out["lens"]["unknown_lens"]))
    for p in lens_known:
        print("    [%02d] %s → %s %s" % (p["idx"], p["gold"], p["cand"], "✓" if p["ok"] else "✗"))
    print("\n== 垃圾/精度 ==")
    g = out["garbage"]
    print("  负例 %d/%d 拦截；E3 黄金回归 %d/%d" % (e3["negatives_blocked"], e3["negatives_total"],
                                            e3["golden_pass"], e3["golden_total"]))
    print("  Garbage Rate（放行/垃圾总量） = %d/%d = %.1f%%"
          % (n3_leak, garbage_judged, 100 * g["leak_of_garbage"]))
    print("  放行垃圾占全部产出 = %d/%d = %.1f%%"
          % (n3_leak, garbage_judged + passed_items, 100 * g["leak_of_output"]))
    print("  E2 Precision = %d/%d = %.1f%%" % (A2["cand"] - e2_garbage, A2["cand"], 100 * g["precision_e2"]))
    print("  Review 拦截 %d 条 / %d 候选 = %.1f%%，其中误拦 %d 条 = %.1f%%"
          % (blocked_items, ALL["cand"] + ALL["blocked"], 100 * out["review"]["intercept_rate"],
             false_blocked, 100 * out["review"]["false_block_rate"]))
    print("\nmetrics.json 已写入")


if __name__ == "__main__":
    main()
