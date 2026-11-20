# -*- coding: utf-8 -*-
"""规则版 vs LLM 版对照：同一素材（E2 抽样 chunk）分别过 `stage_b_rules.parse_digest`
与 LLM 管道产出，并排比对 3 条样本 + 结构健康度统计。

规则版是旧生产路径（digest 直灌），本轮只读引用，不改它。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "server", "storage-hub"))
sys.path.insert(0, os.path.join(ROOT, "server", "exp-pipeline"))
sys.path.insert(0, HERE)

import run_eval  # noqa: E402
import stage_b_rules  # noqa: E402

RAW = os.path.join(HERE, "raw")
# 选 3 个 E2 样本：覆盖工具类 / 交付流程类 / 部署构建类
PICK = ["digest__s01", "digest__s05", "digest__s07"]


def llm_candidates(key):
    path = os.path.join(RAW, key + ".json")
    if not os.path.exists(path):
        return None
    rec = json.load(open(path, encoding="utf-8"))
    return rec


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    chunks, total = run_eval.e2_chunks()
    by_key = {c["key"]: c for c in chunks}
    report = []
    print("E2 抽样 %d/%d chunk" % (len(chunks), total))
    for key in PICK:
        item = by_key[key]
        seg_id = item["segment"].split("~")[0]
        header = "### [%s] %s\n" % (seg_id, "digest")
        norm = "\n".join("- " + ln.lstrip("- ").strip()
                         for ln in item["text"].splitlines() if ln.strip())
        rule_cands = stage_b_rules.parse_digest(header + norm + "\n")
        rec = llm_candidates(key)
        llm = [c for c in (rec or {}).get("candidates") or []]
        print("\n" + "=" * 78)
        print("素材 %s（%s, %d 字）" % (key, item["segment"], item["chars"]))
        print("原文：" + item["text"][:300].replace("\n", " | "))
        print("\n-- 规则版产出 %d 条 --" % len(rule_cands))
        for c in rule_cands:
            print("  what: %s" % c.what[:160])
            print("  when: %s" % c.when_expr[:100])
            print("  why : %s" % c.why[:160])
            print("  lens: %s  repo: %s" % (c.lens, c.repo))
        print("\n-- LLM 版产出 %d 条 --" % len(llm))
        for c in llm:
            print("  what: %s" % (c.get("what") or "")[:160])
            print("  when: %s" % (c.get("when_expr") or "")[:100])
            print("  why : %s" % (c.get("why") or "")[:160])
            print("  lens: %s  category: %s" % (c.get("lens"), c.get("category")))
        report.append({
            "key": key, "segment": item["segment"], "chars": item["chars"],
            "material": item["text"],
            "rule": [{"what": c.what, "when_expr": c.when_expr, "why": c.why,
                      "lens": c.lens, "repo": c.repo} for c in rule_cands],
            "llm": llm, "llm_blocked": [b for b in (rec or {}).get("blocked") or []],
        })
    with open(os.path.join(HERE, "compare_rules.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print("\ncompare_rules.json 已写入")


if __name__ == "__main__":
    main()
