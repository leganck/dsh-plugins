# -*- coding: utf-8 -*-
"""经验抽取量化评测执行器（E1 / E2 / E3）。

设计约束（成本）：
- 本机网关单次抽取实测 ~30s/段，E1+E2 控制在 ~45 次调用；
- **每跑完一个 chunk 立刻落盘**（`eval/raw/*.json`），`--resume` 跳过已存在的，
  所以中途超时/被杀不会白跑；
- 单 chunk 墙钟硬截止 240s（`hard_timeout_ms`），重试 0 次 —— 超时如实记 `timeout`，
  不让 3 倍重试把整批拖死。

素材口径（写进报告，别含糊）：
- E1：黄金集 17 条的证据落在 archive 的 `## Errors and Fixes` 小节，
  故 E1 素材 = **该段 archive 的 Errors and Fixes 全部 bullet**（统一规则，不按条挑），
  再交给 `exp_pipeline.split_segments(max_chars=400)` 切 chunk；
- E2：真实生产输入 `experience-digest.md`（59 个 digest 小节 → 去重后 30 段 112 chunk），
  按 **系统抽样每 9 个 chunk 取 1** 得 12 个，覆盖 archive 段 000–029；
- E3：8 条负例当作「LLM 已抽好的候选」直接喂 `review_candidate`（不调模型）。

CLI:
  python run_eval.py --dry-run          只打印计划，不调 LLM
  python run_eval.py --exp all          跑全部
  python run_eval.py --exp e1 --resume  续跑（已落盘的跳过）
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
STORAGE_HUB = os.path.join(ROOT, "server", "storage-hub")
sys.path.insert(0, STORAGE_HUB)
import exp_llm  # noqa: E402
import exp_pipeline  # noqa: E402
import exp_prompt  # noqa: E402

ARCH_DIR = r"C:\Users\leganck\.dsh\archive\session-4ff93b80-08ba-4561-bc0c-04c1462dc7f5"
DIGEST = r"D:\work\bug-analysis\_check\session-4ff93b80-experience\experience-digest.md"
GOLDEN = os.path.join(ROOT, "server", "exp-pipeline",
                      "experiences-v2-session-4ff93b80.jsonl")
RAW_DIR = os.path.join(HERE, "raw")

BASE_URL = "http://127.0.0.1:3425/v1"
MODEL = "auto/deepseek-v4.1-flash"
MAX_TOKENS = 8000
TIMEOUT_MS = 240_000

# E1 段选择依据：黄金集证据按 issue id / 专属标识符在这些 archive 段里可 grep 到
#  （032: 140709/zb1/31a34cff；027+028+014: branchId=30840；013: StoreComputeImpl；
#   001+008: bas_interface_log；021+029: 可摘/CHGJ-3735）
E1_SEGMENTS = [
    "segment_001.md", "segment_008.md", "segment_013.md", "segment_014.md",
    "segment_021.md", "segment_027.md", "segment_028.md", "segment_029.md",
    "segment_032.md",
]
E2_SAMPLE_STEP = 9  # 112 chunk / 9 ≈ 12 个样本

SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")


# ---------------------------------------------------------------- 素材构建
def archive_errors_section(segment):
    """（保留：E2 对照组用）取 archive 段 `## Errors and Fixes` 小节的 bullet。"""
    path = os.path.join(ARCH_DIR, segment)
    if not os.path.exists(path):
        return None
    lines, kept, inside = [], [], False
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            raw = line.rstrip("\n")
            m = SECTION_RE.match(raw)
            if m:
                inside = m.group(1).strip().lower() == "errors and fixes"
                continue
            if inside and raw.strip():
                kept.append(raw.strip())
    bullets = [l.lstrip("-* ").strip() for l in kept if l.lstrip("-* ").strip()]
    return bullets or None


def e1_chunks():
    """E1：黄金 17 条的定向原文窗口（build_materials.py 产出），同窗口去重后逐 chunk 跑。

    返回 [{key, exp, segment, chunk_idx, text, chars, goldens}]，
    `goldens` 记录该素材覆盖哪几条黄金（Recall 评分用）。
    """
    with open(os.path.join(HERE, "materials_e1.json"), encoding="utf-8") as fh:
        rows = json.load(fh)
    groups = {}       # material_hash -> {"material":.., "goldens":[idx..], "prov":..}
    for r in rows:
        if not r.get("material"):
            continue
        h = hashlib.sha1(r["material"].encode("utf-8")).hexdigest()
        g = groups.setdefault(h, {"material": r["material"], "goldens": [], "prov": r["provenance"]})
        g["goldens"].append(r["idx"])
    out = []
    for i, (h, g) in enumerate(sorted(groups.items(), key=lambda kv: kv[1]["goldens"][0])):
        prov = g["prov"] or {}
        seg = prov.get("segment") or "m%02d" % i
        chunks = exp_pipeline.split_segments(g["material"],
                                             max_chars=exp_pipeline.SEGMENT_MAX_CHARS)
        for ci, ch in enumerate(chunks):
            out.append({"key": "e1__m%02d_c%02d" % (i, ci), "exp": "e1",
                        "segment": "%s/%s" % (seg, prov.get("kind")),
                        "chunk_idx": ci, "text": ch["text"], "chars": len(ch["text"]),
                        "goldens": g["goldens"], "material_hash": h[:10]})
    return out


def e2_chunks(step=E2_SAMPLE_STEP):
    """真实 digest 的系统抽样（每 step 个 chunk 取 1），覆盖全部 archive 段。

    digest 里相邻小节有 compaction 重叠（同一段内容出现两次），先按内容哈希去重再切，
    否则同一素材会被抽两次、垃圾率被重复计权。
    """
    with open(DIGEST, encoding="utf-8") as fh:
        material = fh.read()
    # 去重：按 `### [seg] topic` 分块，块内 bullet 列表哈希相同的只留第一次
    HEAD_RE = re.compile(r"^###\s*\[(segment_\d+\.md)\]\s*(.*)$")
    secs, cur = [], None
    for line in material.splitlines():
        m = HEAD_RE.match(line.strip())
        if m:
            cur = {"seg": m.group(1), "topic": m.group(2).strip(), "bullets": []}
            secs.append(cur)
            continue
        if cur is not None and line.strip():
            cur["bullets"].append(line.strip().lstrip("-* ").strip())
    deduped, seen = [], set()
    for s in secs:
        if not s["bullets"]:
            continue
        h = hashlib.sha1("\n".join(s["bullets"]).encode("utf-8")).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        deduped.append(s)
    clean = "".join("### [%s] %s\n%s\n" % (s["seg"], s["topic"],
                                           "\n".join("- " + b for b in s["bullets"]))
                    for s in deduped)
    chunks = exp_pipeline.split_segments(clean, max_chars=exp_pipeline.SEGMENT_MAX_CHARS)
    picked = chunks[::step]
    out = []
    for i, ch in enumerate(picked):
        out.append({"key": "digest__s%02d" % i, "exp": "e2",
                    "segment": ch["segmentId"], "chunk_idx": i,
                    "text": ch["text"], "chars": len(ch["text"]),
                    "chunk_global_idx": chunks.index(ch)})
    return out, len(chunks)


# 负例 8 条（md §四）—— 当作「LLM 已抽好的候选」喂 Review，不调模型。
NEGATIVES = [
    {"id": "N1", "what": "多试几次就好了", "when_expr": "客户报上传数据查不到时",
     "why": "偶发问题重复执行通常能够恢复", "lens": "logic", "category": "debug",
     "garbage": "common-sense / one-off"},
    {"id": "N2", "what": "遇到复杂问题多收集上下文", "when_expr": "排查线上疑难故障并需要定位根因时",
     "why": "上下文越全越容易定位根因", "lens": "logic", "category": "debug",
     "garbage": "common-sense / not-actionable"},
    {"id": "N3", "what": "超时就调大超时参数", "when_expr": "接口或脚本执行超时的时候",
     "why": "把超时阈值调大可以避免任务被中断", "lens": "logic", "category": "tool",
     "garbage": "factual-error"},
    {"id": "N4", "what": "先沟通再动手", "when_expr": "准备修改生产数据或线上配置之前",
     "why": "避免因理解偏差做出错误修改", "lens": "logic", "category": "process",
     "garbage": "user-preference / skill-covered"},
    {"id": "N5", "what": "本次改了 7 个文件、跑了 3 次测试", "when_expr": "完成一轮代码修改之后",
     "why": "记录本轮改动范围与验证次数", "lens": "index", "category": "repo",
     "garbage": "dialogue-summary"},
    {"id": "N6", "what": "已经部署到 dev1 了", "when_expr": "需要确认当前部署进度时",
     "why": "说明这次变更已经落到 dev1 环境", "lens": "index", "category": "tool",
     "garbage": "one-off"},
    {"id": "N7", "what": "CHGJ-3735 涉及 3 笔共 34 元", "when_expr": "核对补丁版本工单范围时",
     "why": "该工单影响的订单金额较小", "lens": "logic", "category": "business",
     "garbage": "mixed-granularity"},
    {"id": "N8", "what": "只推个人 fork、不直推 origin", "when_expr": "需要把本地提交推到远端时",
     "why": "没有上游写权限，直推会被拒绝并污染主干", "lens": "index", "category": "tool",
     "garbage": "skill-covered（不算垃圾但重复入库无收益）"},
]


def build_negative_candidate(n):
    """把负例补成结构完整的候选（否则会被「缺字段」拦住，测不到真实垃圾规则）。"""
    return {
        "what": n["what"], "when_expr": n["when_expr"], "why": n["why"],
        "lens": n["lens"], "category": n["category"], "evidence_issue": "",
        "audit": {"reusable_because": "（负例回放：按原样喂入）",
                  "exclusions": "1,2,3,4,5,6,7,8",
                  "evidence_quote": "素材原文：" + n["what"]},
        "_negative_id": n["id"],
    }


def load_golden():
    return [json.loads(l) for l in open(GOLDEN, encoding="utf-8") if l.strip()]


def golden_candidate(g):
    """黄金 17 条原样当候选（验证 Review 不误伤人工标准 = 回归基线）。"""
    cand = {k: g.get(k) for k in ("what", "when_expr", "why", "lens", "audit")}
    cand["category"] = exp_pipeline.infer_category(cand)
    cand["evidence_issue"] = g.get("evidence_issue") or ""
    return cand


# ---------------------------------------------------------------- 执行
def run_one(item, client, max_tokens, timeout_ms):
    """跑一个 chunk：切分→抽取→Review→Dedup→证据片段，原样落盘。"""
    t0 = time.time()
    try:
        result = exp_pipeline.run_pipeline(item["text"], llm=client, dry_run=False,
                                           max_chars=exp_pipeline.SEGMENT_MAX_CHARS,
                                           session_id="eval:4ff93b80")
    except Exception as exc:  # noqa: BLE001 - 单段失败要落盘，不能中断批次
        return {"key": item["key"], "exp": item["exp"], "segment": item["segment"],
                "chunk_idx": item["chunk_idx"], "chars": item.get("chars"),
                "status": "error", "error": repr(exc), "elapsed_s": round(time.time() - t0, 1)}
    dt = round(time.time() - t0, 1)
    job = result["job"]
    status = "ok"
    if job["error"] and job["failed_segments"] == job["segments"]:
        status = "failed"
    return {
        "key": item["key"], "exp": item["exp"], "segment": item["segment"],
        "chunk_idx": item["chunk_idx"], "chars": item.get("chars"),
        "status": status, "elapsed_s": dt,
        "job": job,
        "segments": result["segments"],
        "candidates": [{"what": c["what"], "when_expr": c["when_expr"], "why": c["why"],
                        "lens": c["lens"], "category": c.get("category"),
                        "evidence_issue": c.get("evidence_issue"),
                        "audit": c.get("audit"),
                        "excerptKind": (c.get("excerpt") or {}).get("kind"),
                        "excerptHitFound": (c.get("excerpt") or {}).get("hitFound")}
                       for c in result["candidates"]],
        "blocked": [{"what": b["candidate"]["what"], "reason": b["reason"],
                     "detail": b["detail"],
                     # 落盘完整字段：早期版本只存 what，导致被拦条目的 lens 无法比对（见报告限制 6）
                     "when_expr": b["candidate"].get("when_expr"),
                     "why": b["candidate"].get("why"),
                     "lens": b["candidate"].get("lens"),
                     "category": b["candidate"].get("category")}
                    for b in result["blocked"]],
        "errors": result["errors"],
        "warnings": result["warnings"],
    }


def raw_path(key):
    return os.path.join(RAW_DIR, key + ".json")


def e3_replay():
    """E3：8 条负例 + 17 条黄金，直接过 Review（零 LLM）。"""
    policy = exp_pipeline.default_policy()
    neg = []
    for n in NEGATIVES:
        cand = build_negative_candidate(n)
        verdict = exp_pipeline.review_candidate(cand, policy=policy)
        neg.append({"id": n["id"], "what": n["what"], "garbage_class": n["garbage"],
                    "ok": verdict["ok"], "reason": verdict["reason"],
                    "detail": verdict["detail"],
                    "garbageFlag": verdict["garbage"],
                    "skillCovered": verdict["skillCovered"]})
    gold = []
    for i, g in enumerate(load_golden()):
        cand = golden_candidate(g)
        verdict = exp_pipeline.review_candidate(cand, policy=policy)
        gold.append({"idx": i, "lens": g["lens"], "what": g["what"],
                     "ok": verdict["ok"], "reason": verdict["reason"],
                     "detail": verdict["detail"]})
    out = {"exp": "e3", "policy": policy,
           "negatives": neg, "golden": gold,
           "negatives_blocked": sum(1 for x in neg if not x["ok"]),
           "negatives_total": len(neg),
           "negatives_skill_covered": sum(1 for x in neg if x["skillCovered"]),
           "golden_pass": sum(1 for x in gold if x["ok"]),
           "golden_total": len(gold)}
    with open(os.path.join(RAW_DIR, "e3__replay.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", default="all", choices=["e1", "e2", "e3", "all"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--max-calls", type=int, default=60)
    ap.add_argument("--max-seconds", type=int, default=2700)
    ap.add_argument("--max-tokens", type=int, default=MAX_TOKENS)
    ap.add_argument("--timeout-ms", type=int, default=TIMEOUT_MS)
    ap.add_argument("--shard", default="0/1", help="第 i/n 片，如 0/3（并行跑时互不重叠）")
    ap.add_argument("--keys", default="", help="只跑这些 key（逗号分隔），用于补跑指定 chunk")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    os.makedirs(RAW_DIR, exist_ok=True)

    plan = []
    # 顺序：先 E2（生产输入口径的垃圾率/精度，指标最硬），再 E1（Recall）。
    # 单次调用实测 75–200s 波动很大，先把指标优先级高的跑完，断点续跑可分批。
    if args.exp in ("e2", "all"):
        ch, total = e2_chunks()
        plan += ch
        print("E2: digest 共 %d chunk，抽样 %d 个（每 %d 取 1）" % (total, len(ch), E2_SAMPLE_STEP))
    if args.exp in ("e1", "all"):
        plan += [i for i in e1_chunks() if i.get("text")]

    if args.keys:
        want = {k.strip() for k in args.keys.split(",") if k.strip()}
        plan = [it for it in plan if it["key"] in want]
        print("keys 过滤：本片 %d 个 chunk" % len(plan))
    shard_i, shard_n = (int(x) for x in args.shard.split("/"))
    if shard_n > 1:
        plan = [it for j, it in enumerate(plan) if j % shard_n == shard_i]
        print("shard %d/%d: 本片 %d 个 chunk" % (shard_i, shard_n, len(plan)))

    if args.dry_run:
        print("\n== 计划（不调 LLM）==")
        cur = None
        for it in plan:
            if it["segment"] != cur:
                cur = it["segment"]
                print("  [%s] %s" % (it["exp"], cur))
            print("    - %-28s chars=%s %s" % (it["key"], it.get("chars"),
                                              "(已落盘)" if os.path.exists(raw_path(it["key"])) else ""))
        print("\nE1 chunk=%d, E2 chunk=%d, 合计 LLM 调用=%d"
              % (sum(1 for i in plan if i["exp"] == "e1"),
                 sum(1 for i in plan if i["exp"] == "e2"), len(plan)))
        print("dry-run：未调用 LLM。")
        return 0

    client = exp_llm.LLMClient(base_url=BASE_URL, model=MODEL, max_tokens=args.max_tokens,
                               timeout_ms=args.timeout_ms, max_retries=0)
    t_start, calls, done, skipped = time.time(), 0, 0, 0
    for it in plan:
        path = raw_path(it["key"])
        if args.resume and os.path.exists(path):
            skipped += 1
            continue
        if calls >= args.max_calls:
            print("[budget] 达到 --max-calls=%d，停止" % args.max_calls)
            break
        if time.time() - t_start > args.max_seconds:
            print("[budget] 达到 --max-seconds=%d，停止" % args.max_seconds)
            break
        calls += 1
        rec = run_one(it, client, args.max_tokens, args.timeout_ms)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False, indent=2)
        done += 1
        print("[%02d] %-28s status=%-6s %5.1fs cand=%d blocked=%d job_err=%s"
              % (calls, it["key"], rec.get("status"), rec.get("elapsed_s") or -1,
                 len(rec.get("candidates") or []), len(rec.get("blocked") or []),
                 (rec.get("job") or {}).get("error")))

    if args.exp in ("e3", "all"):
        out = e3_replay()
        print("E3: 负例拦截 %d/%d，其中 skill-covered %d；黄金通过 %d/%d"
              % (out["negatives_blocked"], out["negatives_total"],
                 out["negatives_skill_covered"], out["golden_pass"], out["golden_total"]))
    print("\n本轮调用=%d 落盘=%d 跳过(已存在)=%d 用时=%.0fs"
          % (calls, done, skipped, time.time() - t_start))
    return 0


if __name__ == "__main__":
    sys.exit(main())
