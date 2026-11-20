# -*- coding: utf-8 -*-
"""E1 素材构建：把 17 条黄金经验各自定位到 archive 段的**原文窗口**并落盘。

为什么是窗口而不是整段：单段 archive 是 0.9–1.2MB 事件流水，整段喂模型在本机网关上
不可行（实测 400 字 chunk ≈ 30s，1MB ≈ 2500 chunk）。生产路径喂的是 digest/summary，
但本批黄金的关键证据大量只存在于 summary 之外的 **Verbatim turns**（原始事件），
所以 E1 素材取「命中行 ±2 行」的原文窗口（≤800 字），
测的是「素材里确实有这条经验时，抽取器能不能把它写出来」→ Recall 属**上界**口径。

已知素材缺失（archive 里搜不到，不计入 Recall 分母）：
- #4「改库存台账后重算 5 个结余列」：`结余`/`balance` 相关表述均无命中原句
- #7「XINFO STREAM / XLEN」：archive 内 `xinfo` 仅命中无关 HTML 类名（wxInformation），无 Redis 语义
- #8「批量重放先投 1 条 / 451 条」：`451 条`、`先只投` 无命中
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "server", "storage-hub"))
import exp_pipeline  # noqa: E402

ARCH_DIR = r"C:\Users\leganck\.dsh\archive\session-4ff93b80-08ba-4561-bc0c-04c1462dc7f5"
GOLDEN = os.path.join(ROOT, "server", "exp-pipeline",
                      "experiences-v2-session-4ff93b80.jsonl")
OUT = os.path.join(HERE, "materials_e1.json")
SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")
MAX_MATERIAL = 800

ANCHORS = {
    0: ["zb1", "za4", "upload"],
    1: ["66112", "pos id=", "ti4"],
    2: ["软删", "补录", "审批"],
    3: ["store_account", "branchId=30840", "库存"],
    4: [],  # 素材缺失
    5: ["StoreComputeImpl"],
    6: ["bas_interface_log"],
    7: ["xlen", "entries-added", "last-delivered-id"],
    8: [],  # 素材缺失
    9: ["200 compile", "SpecDescFormatter", "merge --abort"],
    10: ["-s ours", "31a34cff"],
    11: ["nothing to commit"],
    12: ["default", "www_ali", "44 topics"],
    13: ["gradle-wrapper", "126", "JAVA_HOME"],
    14: ["数据库前缀", "越权", "SHOW COLUMNS"],
    15: ["5.2 线", "补丁清单", "CHGJ-3735"],
    16: ["可摘"],
}
PREFER = {
    0: ["segment_032.md"], 1: ["segment_032.md"], 2: ["segment_032.md"],
    3: ["segment_027.md", "segment_014.md", "segment_028.md"],
    4: [], 5: ["segment_013.md"],
    6: ["segment_001.md", "segment_008.md", "segment_009.md"],
    7: ["segment_023.md"],
    8: [],
    9: ["segment_032.md"], 10: ["segment_032.md"], 11: ["segment_032.md"],
    12: ["segment_032.md", "segment_002.md"], 13: ["segment_032.md"],
    14: ["segment_032.md", "segment_018.md"], 15: ["segment_029.md", "segment_021.md"],
    16: ["segment_029.md", "segment_028.md", "segment_030.md"],
}
MISSING = {4, 7, 8}  # archive 原文里搜不到证据原句（不计入 Recall 分母）


def split_file(segment):
    """返回 (summary_sections, verbatim_lines)。verbatim_lines 只取 Verbatim turns 之后的行。"""
    path = os.path.join(ARCH_DIR, segment)
    sections, cur, in_block, verbatim, in_verbatim = [], None, False, [], False
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            raw = line.rstrip("\n")
            m = SECTION_RE.match(raw)
            if m:
                title = m.group(1).strip()
                low = title.lower()
                if low.startswith("verbatim"):
                    in_block, in_verbatim, cur = False, True, None
                    continue
                if low.startswith("summary"):
                    in_block, cur = True, None
                    continue
                if in_block:
                    cur = {"title": title, "bullets": []}
                    sections.append(cur)
                continue
            if in_block and cur is not None and raw.strip():
                cur["bullets"].append(raw.strip().lstrip("-* ").strip())
            elif in_verbatim and raw.strip():
                verbatim.append(raw.strip())
    return [s for s in sections if s["bullets"]], verbatim


def score(text, anchors):
    low = text.lower()
    return sum(1 for a in anchors if a.lower() in low)


def find(golden_idx, anchors, prefer, cache):
    """在 prefer 段里找 summary bullet / verbatim 行，取命中最多者，返回窗口。"""
    if not anchors:
        return None
    best = None  # (hits, kind, seg, section, idx, lines)
    for seg in prefer:
        if seg not in cache:
            cache[seg] = split_file(seg)
        secs, verb = cache[seg]
        for sec in secs:
            for i, b in enumerate(sec["bullets"]):
                sc = score(b, anchors)
                if sc and (best is None or sc > best[0]):
                    best = (sc, "summary", seg, sec["title"], i, sec["bullets"])
        for i, line in enumerate(verb):
            sc = score(line, anchors)
            if sc and (best is None or sc > best[0]):
                best = (sc, "verbatim", seg, "Verbatim turns", i, verb)
    if not best:
        return None
    sc, kind, seg, title, i, lines = best
    lo, hi = max(0, i - 2), min(len(lines), i + 3)
    window = lines[lo:hi]
    # 控制在 MAX_MATERIAL 以内：从窗口尾部/头部裁
    text = "\n".join(window)
    while len(text) > MAX_MATERIAL and len(window) > 1:
        window = window[1:-1] if len(window) > 2 else window[:-1]
        text = "\n".join(window)
    if len(text) > MAX_MATERIAL:
        text = text[:MAX_MATERIAL]
    return {"kind": kind, "segment": seg, "section": title, "hit_index": i,
            "hits": sc, "anchors": anchors, "lines": [text] if kind == "verbatim" else None,
            "bullets": window, "matched": lines[i][:200]}


def build():
    golden = [json.loads(l) for l in open(GOLDEN, encoding="utf-8") if l.strip()]
    cache, out = {}, []
    for idx, g in enumerate(golden):
        prov = None if idx in MISSING else find(idx, ANCHORS[idx], PREFER[idx], cache)
        material = ""
        if prov:
            if prov["kind"] == "summary":
                material = "### [%s] %s\n%s\n" % (
                    prov["segment"], prov["section"],
                    "\n".join("- " + b for b in prov["bullets"]))
            else:
                material = prov["lines"][0] + "\n"
        out.append({"idx": idx, "lens": g["lens"], "what": g["what"],
                    "evidence_issue": g.get("evidence_issue"),
                    "evidence_quote": (g.get("audit") or {}).get("evidence_quote"),
                    "missing": idx in MISSING, "material": material, "provenance": prov})
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    rows = build()
    total = 0
    for r in rows:
        p = r["provenance"]
        if r["missing"]:
            print("[%02d] 素材缺失（不计入分母）%s" % (r["idx"], r["what"][:40]))
            continue
        if not p:
            print("[%02d] ** 定位失败 ** %s" % (r["idx"], r["what"][:40]))
            continue
        chunks = exp_pipeline.split_segments(r["material"], max_chars=400)
        total += len(chunks)
        print("[%02d] %s/%s hits=%d chars=%d chunks=%d" %
              (r["idx"], p["segment"], p["kind"], p["hits"], len(r["material"]), len(chunks)))
        print("     命中: %s" % p["matched"][:160])
    print("\nE1 chunk 合计=%d（同窗口去重后会少）" % total)


if __name__ == "__main__":
    main()
