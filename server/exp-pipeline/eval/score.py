# -*- coding: utf-8 -*-
"""评测打分：读 eval/raw/*.json，算三指标 + Category(lens) 准确率 + 成本表。

口径（与 docs/exp-eval.md 一致）：
- Recall = 「素材里确实有这条经验」的黄金条数中被抽中且通过 Review 的比例；
  分母 = 17 - 3（archive 原文里搜不到证据的 #4/#7/#8，标 `missing`）
  「抽中」= `what` 与黄金 `what` bigram 相似度 ≥0.30 **或** 双方共享判别性锚点
  （issue/表名/命令），再由人工逐条确认（confirmation 写到 judge 字段）。
- Precision = 产出条目中人工判定「非垃圾」比例，分母 = 通过 Review 的条目数。
- Garbage Rate = 人工判定为垃圾的条目中**被 Review 放行**的比例（九类垃圾口径），
  另报 Review 侧拦截率作为对照。
- Category Acc = `lens` 与黄金人工标注一致率（黄金集无 category 字段，故以 lens 为准），
  category 另报分布与人工合理性抽查。

用法：python score.py [--json]
"""
import argparse
import glob
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "server", "storage-hub"))
import exp_pipeline  # noqa: E402

RAW = os.path.join(HERE, "raw")
MATERIALS = os.path.join(HERE, "materials_e1.json")
GOLDEN = os.path.join(ROOT, "server", "exp-pipeline",
                      "experiences-v2-session-4ff93b80.jsonl")
JUDGE = os.path.join(HERE, "judge.json")  # 人工判定落盘（本文件由人工维护）

# 每条黄金的判别性锚点（与 build_materials.ANCHORS 同源，用于"抽中"的机器初筛）
MATCH_ANCHORS = {
    0: ["140709", "zb1", "za4", "分区"],
    1: ["66112", "pos 表", "ti4", "posId"],
    2: ["软删", "补录", "审批", "20 行"],
    3: ["30840", "branch_id", "store_account"],
    4: ["结余", "balance"],
    5: ["StoreComputeImpl", "五张"],
    6: ["bas_interface_log", "防重", "452"],
    7: ["XINFO", "XLEN", "last-generated-id"],
    8: ["451", "先投 1 条", "批量重放"],
    9: ["cherry-pick", "merge", "SpecDescFormatter", "200"],
    10: ["-s ours", "merge -s ours", "祖先"],
    11: ["nothing to commit", "cherry-pick continue"],
    12: ["default", "www_ali", "44"],
    13: ["gradle-wrapper", "gradlew", "JAVA_HOME"],
    14: ["数据库前缀", "越权", "SHOW COLUMNS", "-d"],
    15: ["版本线", "补丁", "5.2", "5.0.x"],
    16: ["可摘"],
}


def load_raw():
    out = {"e1": [], "e2": [], "e3": None}
    for path in sorted(glob.glob(os.path.join(RAW, "*.json"))):
        with open(path, encoding="utf-8") as fh:
            rec = json.load(fh)
        exp = rec.get("exp")
        if exp in ("e1", "e2"):
            rec["_file"] = os.path.basename(path)
            out[exp].append(rec)
        elif exp == "e3":
            out["e3"] = rec
    return out


def key_goldens():
    """key -> 该素材覆盖的黄金序号（从 run_eval.e1_chunks 复算，确定性可复现）。"""
    sys.path.insert(0, HERE)
    import run_eval
    return {it["key"]: it.get("goldens") or [] for it in run_eval.e1_chunks()}


def cached_candidates(raw_e1):
    """E1/E2 的候选池：[(exp, key, segment, cand)]。"""
    mapping = key_goldens()
    pool = []
    for rec in raw_e1:
        for c in rec.get("candidates") or []:
            pool.append({"exp": rec["exp"], "key": rec["key"],
                         "segment": rec["segment"], "cand": c,
                         "goldens": mapping.get(rec["key"]) or []})
    return pool


def match_score(golden, cand):
    what = (golden.get("what") or "")
    sim = exp_pipeline.similarity(what, cand.get("what") or "")
    blob = " ".join(str(cand.get(k) or "") for k in ("what", "when_expr", "why"))
    anchors = MATCH_ANCHORS.get(golden["_idx"], [])
    hits = [a for a in anchors if a.lower() in blob.lower()]
    return sim, hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    golden_raw = [json.loads(l) for l in open(GOLDEN, encoding="utf-8") if l.strip()]
    materials = json.load(open(MATERIALS, encoding="utf-8"))
    missing = {r["idx"] for r in materials if r.get("missing")}
    has_material = [i for i in range(len(golden_raw)) if i not in missing]
    golden = []
    for i, g in enumerate(golden_raw):
        d = dict(g)
        d["_idx"] = i
        golden.append(d)

    raw = load_raw()
    pool = cached_candidates(raw["e1"])
    judge = json.load(open(JUDGE, encoding="utf-8")) if os.path.exists(JUDGE) else {}

    # ---------------- 成本
    cost = {"calls": 0, "elapsed_s": 0.0, "tokens_in": 0, "tokens_out": 0,
            "reasoning_tokens": 0, "truncated": 0, "failed": 0, "chars": 0}
    per_exp = {}
    for exp in ("e1", "e2"):
        e = {"calls": 0, "elapsed_s": 0.0, "tokens_in": 0, "tokens_out": 0,
             "truncated": 0, "failed": 0, "candidates": 0, "blocked": 0, "kept": 0,
             "chars": 0}
        for rec in raw[exp]:
            e["calls"] += 1
            e["elapsed_s"] += rec.get("elapsed_s") or 0
            e["chars"] += rec.get("chars") or 0
            job = rec.get("job") or {}
            e["tokens_in"] += job.get("tokens_in") or 0
            e["tokens_out"] += job.get("tokens_out") or 0
            e["truncated"] += 1 if job.get("truncated") else 0
            if (rec.get("status") or "") != "ok":
                e["failed"] += 1
            e["candidates"] += len(rec.get("candidates") or [])
            e["blocked"] += len(rec.get("blocked") or [])
            e["kept"] += len(rec.get("candidates") or [])
        e["avg_s"] = round(e["elapsed_s"] / e["calls"], 1) if e["calls"] else 0
        per_exp[exp] = e
        for k in ("calls", "elapsed_s", "tokens_in", "tokens_out", "truncated", "failed", "chars"):
            cost[k] += e[k]

    # ---------------- Recall（E1）
    recall_rows = []
    matched_goldens = set()
    for idx in has_material:
        g = golden[idx]
        best = []
        for item in pool:
            if item["exp"] != "e1":
                continue
            if idx not in (item.get("goldens") or []):
                continue
            sim, hits = match_score(g, item["cand"])
            best.append((sim, hits, item))
        best.sort(key=lambda x: (-x[0], -len(x[1])))
        top = best[0] if best else None
        manual = (judge.get("recall") or {}).get(str(idx))
        hit = bool(manual.get("hit")) if manual else bool(
            top and (top[0] >= 0.30 or len(top[1]) >= 2))
        if hit:
            matched_goldens.add(idx)
        recall_rows.append({
            "idx": idx, "lens": g["lens"], "what": g["what"],
            "cands": len(best), "best_sim": round(top[0], 3) if top else None,
            "anchors": top[1] if top else [],
            "best_what": top[2]["cand"].get("what") if top else None,
            "best_lens": top[2]["cand"].get("lens") if top else None,
            "hit": hit, "manual": manual,
        })

    # ---------------- Precision / 垃圾（人工判定优先）
    judged = judge.get("candidates") or {}
    cand_rows = []
    for item in pool:
        c = item["cand"]
        h = hashlib.sha1((item["key"] + c["what"]).encode("utf-8")).hexdigest()[:10]
        j = judged.get(h)
        cand_rows.append({"hash": h, "exp": item["exp"], "segment": item["segment"],
                          "what": c.get("what"), "when_expr": c.get("when_expr"),
                          "why": c.get("why"), "lens": c.get("lens"),
                          "category": c.get("category"),
                          "judge": j})

    blocked_rows = []
    for exp in ("e1", "e2"):
        for rec in raw[exp]:
            for b in rec.get("blocked") or []:
                blocked_rows.append({"exp": exp, "segment": rec["segment"],
                                     "what": b["what"], "reason": b["reason"],
                                     "detail": b["detail"]})

    out = {
        "cost": cost, "per_exp": per_exp,
        "recall": {"rows": recall_rows,
                   "denominator": len(has_material),
                   "missing": sorted(missing),
                   "hits": len(matched_goldens)},
        "candidates": cand_rows,
        "blocked": blocked_rows,
        "e3": raw["e3"],
        "review_side": {
            "candidates": per_exp["e1"]["candidates"] + per_exp["e2"]["candidates"],
            "blocked": per_exp["e1"]["blocked"] + per_exp["e2"]["blocked"],
        },
    }
    with open(os.path.join(HERE, "score.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    print("== 成本 ==")
    print("  calls=%d  elapsed=%.0fs  avg=%.1fs/chunk  tokens_in=%d tokens_out=%d"
          % (cost["calls"], cost["elapsed_s"],
             cost["elapsed_s"] / cost["calls"] if cost["calls"] else 0,
             cost["tokens_in"], cost["tokens_out"]))
    print("  chars=%d  truncated=%d  failed=%d" % (cost["chars"], cost["truncated"], cost["failed"]))
    for exp, e in per_exp.items():
        print("  [%s] calls=%d cand=%d blocked=%d avg=%.1fs tok_in=%d tok_out=%d truncated=%d failed=%d"
              % (exp, e["calls"], e["candidates"], e["blocked"], e["avg_s"],
                 e["tokens_in"], e["tokens_out"], e["truncated"], e["failed"]))
    print("\n== Recall（分母 %d，缺失素材 %s）==" % (len(has_material), sorted(missing)))
    for r in recall_rows:
        print("  [%02d] hit=%-5s sim=%-5s anchors=%-20s lens=%s→%s"
              % (r["idx"], r["hit"], r["best_sim"], ",".join(r["anchors"])[:20],
                 r["lens"], r["best_lens"]))
        if r["best_what"]:
            print("       产出: %s" % r["best_what"][:110])
    print("  → 命中 %d/%d" % (len(matched_goldens), len(has_material)))
    print("\n== 产出候选（%d 条，待人工判垃圾）==" % len(cand_rows))
    for c in cand_rows:
        print("  %s [%s/%s] %s" % (c["hash"], c["exp"], c["lens"], (c["what"] or "")[:100]))
    print("\n== Review 拦截（%d 条）==\n" % len(blocked_rows))
    for b in blocked_rows:
        print("  [%s] %-28s %s" % (b["exp"], b["reason"], (b["what"] or "")[:80]))
    if out["e3"]:
        e3 = out["e3"]
        print("\n== E3 负例回放 ==")
        print("  拦截 %d/%d（其中 skill-covered %d）；黄金回归 %d/%d"
              % (e3["negatives_blocked"], e3["negatives_total"],
                 e3["negatives_skill_covered"], e3["golden_pass"], e3["golden_total"]))
        for n in e3["negatives"]:
            print("    %s ok=%-5s reason=%-28s %s" % (n["id"], n["ok"], n["reason"],
                                                      n["what"][:40]))
    print("\nscore.json 已写入")
    return 0


if __name__ == "__main__":
    sys.exit(main())
