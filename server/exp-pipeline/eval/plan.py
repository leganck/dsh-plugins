# -*- coding: utf-8 -*-
"""评测规划：digest 切分测量 + 黄金集 -> 素材段映射（纯本地，不调 LLM）。

用途：在真跑 LLM 之前把「跑哪些段、每段切几 chunk、总共多少次调用」算清楚，
避免跑一半发现预算爆炸。输出只读，不写任何库。
"""
import bisect
import hashlib
import json
import re
import sys
from collections import OrderedDict

sys.path.insert(0, r"D:\Code\dsh-plugins-github\server\storage-hub")
import exp_pipeline  # noqa: E402  只读引用

DIGEST = r"D:\work\bug-analysis\_check\session-4ff93b80-experience\experience-digest.md"
GOLDEN = r"D:\Code\dsh-plugins-github\server\exp-pipeline\experiences-v2-session-4ff93b80.jsonl"
HEADER_RE = re.compile(r"^###\s*\[(segment_\d+\.md)\]\s*(.*)$")


def load_digest(path):
    """按 digest header 分组，返回有序 section 列表 [{segmentId, topic, lines, text}]。"""
    sections, cur = [], None
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            m = HEADER_RE.match(line.strip())
            if m:
                cur = {"segmentId": m.group(1), "topic": m.group(2).strip(), "lines": []}
                sections.append(cur)
                continue
            if cur is None:
                continue
            if line.strip():
                cur["lines"].append(line.strip())
    for s in sections:
        s["text"] = "\n".join(s["lines"])
        s["bullets"] = [l.lstrip("-* ").strip() for l in s["lines"]]
        s["hash"] = hashlib.sha1(s["text"].encode("utf-8")).hexdigest()[:12]
    return sections


def dedupe_sections(sections):
    """同一 archive 段在 digest 里可能重复出现（compaction 重叠），按内容哈希去重。

    只保留首个；返回 (kept, dropped) 供报告写口径。
    """
    seen, kept, dropped = set(), [], []
    for s in sections:
        if s["hash"] in seen:
            dropped.append(s)
            continue
        seen.add(s["hash"])
        kept.append(s)
    return kept, dropped


def chunks_for(section, max_chars=exp_pipeline.SEGMENT_MAX_CHARS):
    """把单段拼回 digest 文本，过 pipeline 的 split_segments，得到真实 chunk 数。"""
    material = "### [%s] %s\n%s\n" % (section["segmentId"], section["topic"],
                                      "\n".join("- " + b for b in section["bullets"]))
    return exp_pipeline.split_segments(material, max_chars=max_chars), material


def norm(s):
    return exp_pipeline._norm_text(s or "")


def locate(sections, needle, min_tokens=3):
    """在 digest 里找包含 needle 的段（归一化后子串或关键字覆盖）。

    返回 [(segmentId, best_line)]。needed：golden 的 evidence_quote 经常带
    「…」/数字噪声，所以先整体子串，再退化成"关键 tokens 覆盖率"。
    """
    n_raw = norm(needle)
    if not n_raw:
        return []
    hits = []
    for s in sections:
        body = norm(s["text"])
        if n_raw and n_raw in body:
            line = next((b for b in s["bullets"] if n_raw in norm(b)), s["bullets"][0])
            hits.append((s["segmentId"], line, 1.0))
            continue
        # 退化：按 4 字滑窗覆盖率
        grams = {n_raw[i:i + 4] for i in range(0, max(1, len(n_raw) - 3))}
        if len(grams) < min_tokens:
            continue
        best_ratio, best_line = 0.0, ""
        for b in s["bullets"]:
            nb = norm(b)
            cov = sum(1 for g in grams if g in nb) / len(grams)
            if cov > best_ratio:
                best_ratio, best_line = cov, b
        if best_ratio >= 0.6:
            hits.append((s["segmentId"], best_line, best_ratio))
    hits.sort(key=lambda x: -x[2])
    return hits


def main():
    out = sys.stdout
    sections = load_digest(DIGEST)
    kept, dropped = dedupe_sections(sections)
    out.write("digest sections: %d  (去重后 %d，丢弃重复 %d)\n"
              % (len(sections), len(kept), len(dropped)))

    by_seg = OrderedDict()
    for s in kept:
        by_seg.setdefault(s["segmentId"], []).append(s)

    out.write("\n== 每 archive 段的 chunk 数（max_chars=%d）==\n" % exp_pipeline.SEGMENT_MAX_CHARS)
    total_chunks = 0
    per_seg = {}
    for seg, ss in by_seg.items():
        n = 0
        for s in ss:
            ch, _ = chunks_for(s)
            n += len(ch)
        per_seg[seg] = n
        total_chunks += n
        out.write("  %s sections=%d bullets=%3d chars=%5d chunks=%2d\n"
                  % (seg, len(ss), sum(len(s["bullets"]) for s in ss),
                     sum(len(s["text"]) for s in ss), n))
    out.write("合计 chunks=%d\n" % total_chunks)

    golden = [json.loads(l) for l in open(GOLDEN, encoding="utf-8") if l.strip()]
    out.write("\n== 黄金集 17 条 -> 素材段定位 ==\n")
    mapping = {}
    for i, g in enumerate(golden):
        ev = g.get("evidence_issue") or ""
        quote = (g.get("audit") or {}).get("evidence_quote") or ""
        cand = []
        for needle in (quote, ev):
            if needle:
                for seg, line, ratio in locate(kept, needle)[:3]:
                    cand.append((seg, line, ratio, needle[:40]))
        # 去重保序
        seen, uniq = set(), []
        for c in cand:
            if c[0] in seen:
                continue
            seen.add(c[0])
            uniq.append(c)
        mapping[i] = uniq
        out.write("\n[%02d] lens=%-6s evid=%-10s | %s\n" % (i, g["lens"], ev or "-", g["what"][:52]))
        out.write("     quote: %s\n" % (quote[:90] or "-"))
        if not uniq:
            out.write("     >>> 定位失败（digest 无匹配）\n")
        for seg, line, ratio, needle in uniq:
            out.write("     -> %s  ratio=%.2f  「%s」\n" % (seg, ratio, line[:70]))

    # 汇总：17 条覆盖到的段
    segs_needed = OrderedDict()
    for i, lst in mapping.items():
        for seg, line, ratio, _ in lst:
            segs_needed.setdefault(seg, []).append(i)
    out.write("\n== E1 需要跑的段（%d 段）==\n" % len(segs_needed))
    e1_calls = 0
    for seg, idxs in sorted(segs_needed.items()):
        e1_calls += per_seg.get(seg, 0)
        out.write("  %s chunks=%2d 覆盖黄金 %s\n" % (seg, per_seg.get(seg, 0),
                                                 ",".join(str(x) for x in sorted(idxs))))
    out.write("E1 LLM 调用上限 = %d\n" % e1_calls)

    e2_segs = ["segment_%03d.md" % i for i in range(12)]
    e2_calls = sum(per_seg.get(s, 0) for s in e2_segs)
    out.write("\n== E2 抽样前 12 段 LLM 调用上限 = %d ==\n" % e2_calls)

    with open(r"D:\Code\dsh-plugins-github\server\exp-pipeline\eval\plan.json", "w",
              encoding="utf-8") as fh:
        json.dump({
            "segments_in_digest": len(sections),
            "segments_deduped": len(kept),
            "chunks_per_segment": per_seg,
            "golden_mapping": {str(k): [[s, l, r] for s, l, r, _ in v]
                               for k, v in mapping.items()},
            "e1_segments": list(segs_needed.keys()),
            "e1_calls": e1_calls,
            "e2_segments": e2_segs,
            "e2_calls": e2_calls,
        }, fh, ensure_ascii=False, indent=2)
    out.write("\nplan.json 已写入 server/exp-pipeline/eval/plan.json\n")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
