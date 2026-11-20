# -*- coding: utf-8 -*-
"""规则版（旧生产路径）在同一素材上的基线：零 LLM 成本，样本 = E2 同一批 digest 素材。

目的：给「LLM 版 vs 规则版」提供**同素材、同 Review、同分母**的对照数字，
而不是只比 3 条样本（样本用于看具体差异，总量用于看比例）。

指标：
- 产出条数；`what == why` 比例（旧版核心缺陷）；`when` 为兜底句（处理X时）比例；
  lens 分布；以及**把这些产出喂给 v2 Review** 后的拦截率（= 旧版放行垃圾率）。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "server", "storage-hub"))
sys.path.insert(0, os.path.join(ROOT, "server", "exp-pipeline"))
sys.path.insert(0, HERE)

import exp_pipeline  # noqa: E402
import stage_b_rules  # noqa: E402
import run_eval  # noqa: E402

OUT = os.path.join(HERE, "rule_baseline.json")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    chunks, total = run_eval.e2_chunks()
    # 把 E2 抽样到的 chunk 拼回 digest 文本喂规则版（与 LLM 版逐 chunk 口径等价）
    def _norm(t):
        return "\n".join("- " + ln.lstrip("- ").strip()
                         for ln in t.splitlines() if ln.strip())
    material = "".join("### [%s] digest\n%s\n" % (c["segment"], _norm(c["text"]))
                       for c in chunks)
    cands = stage_b_rules.parse_digest(material)
    n = len(cands)
    sim = [exp_pipeline.similarity(c.what, c.why) for c in cands]
    same = sum(1 for s in sim if s > 0.75)
    identical = sum(1 for c in cands if " ".join(c.what.split()) == " ".join(c.why.split()[:len(c.what.split())]))
    generic_when = sum(1 for c in cands if c.when_expr.startswith("处理"))
    issue_when = sum(1 for c in cands if c.when_expr.startswith("工单"))
    lens = {}
    for c in cands:
        lens[c.lens] = lens.get(c.lens, 0) + 1

    # 同一 Review 下的拦截情况：旧版产出直接当候选
    policy = exp_pipeline.default_policy()
    blocked, reasons = 0, {}
    for c in cands:
        cand = {"what": c.what, "when_expr": c.when_expr, "why": c.why,
                "lens": c.lens, "category": exp_pipeline.infer_category(
                    {"what": c.what, "when_expr": c.when_expr, "why": c.why}),
                "audit": {"evidence_quote": c.why[:80], "reusable_because": "",
                          "exclusions": ""}}
        v = exp_pipeline.review_candidate(cand, policy=policy)
        if not v["ok"]:
            blocked += 1
            reasons[v["reason"]] = reasons.get(v["reason"], 0) + 1

    out = {
        "material_chunks": len(chunks), "digest_total_chunks": total,
        "chars": len(material), "candidates": n,
        "what_why_sim_gt_075": same, "what_why_ratio": round(same / n, 4) if n else 0,
        "what_equals_why_prefix": identical,
        "generic_when": generic_when, "issue_when": issue_when,
        "lens": lens,
        "review_blocked": blocked,
        "review_blocked_rate": round(blocked / n, 4) if n else 0,
        "review_reasons": reasons,
        "sample": [{"what": c.what, "when_expr": c.when_expr, "why": c.why,
                    "lens": c.lens, "repo": c.repo} for c in cands[:12]],
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print("规则版基线（同素材 %d chunk / %d 字）" % (len(chunks), len(material)))
    print("  产出 %d 条；what≈why(>0.75) %d 条 = %.1f%%"
          % (n, same, 100.0 * same / n if n else 0))
    print("  when 兜底句(处理X时) %d 条 = %.1f%%；when 用工单号 %d 条"
          % (generic_when, 100.0 * generic_when / n if n else 0, issue_when))
    print("  lens 分布 %s" % lens)
    print("  同一 v2 Review 下拦截 %d/%d = %.1f%%  reasons=%s"
          % (blocked, n, 100.0 * blocked / n if n else 0, reasons))
    print("  → 规则版放行率 %.1f%%（其中 what==why 属未提炼，全部被拦）"
          % (100.0 * (n - blocked) / n if n else 0))


if __name__ == "__main__":
    main()
