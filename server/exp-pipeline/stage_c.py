"""Stage C：三层治理（Review → Dedup → Merge）。

默认方向（storage-hub v2 §2.2 / 腾讯方法论）：
- Review 默认保留、定向过滤：只拦「可判定为垃圾」的候选（缺 when / what<8 字 /
  证据为空 / 源码探索证伪），其余放行——宁漏勿错杀。
- Dedup 宁严勿宽：仅当 what+when 相似度 > 0.90 才合并，且**禁桥接**
  （只与已保留代表项两两比较，不通过被合并项传递相似）。
- Merge 唯一目标前置、默认 create：先查 /v1/memories/search 找同向条目，
  同向 → update（upsert 幂等）/ skip（无新增信息）；反向 → contradict
  （写 status=conflicting 进人工队列）；无命中 → create。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from common import text_similarity, norm
from stage_b_rules import Candidate

# ---------------- Review ----------------

WHAT_MIN_CHARS = 8
DEDUP_THRESHOLD = 0.90
MERGE_SAME_THRESHOLD = 0.62      # what 相似度：同向判定阈值（略松，供 update/skip）
REVIEW_SYMBOL_LIMIT = 6          # 每候选最多探索验证的符号数

# 反向信号（contradict 判定）：同一主题上的禁令 vs 要求
FORBID_RE = re.compile(r"(不要|不能|不可以|切勿|别|禁止|must not|never)", re.I)
REQUIRE_RE = re.compile(r"(需要|必须|应该|应当|要|must|should|always)", re.I)
# 反向词对：候选与命中各含一侧且语义对立（改用 X vs 直接 Y / 必须 A vs 无需 A）
CONTRA_PAIRS = [
    (re.compile(r"(改用|改用 fork|换.{0,8}推送|推到.{0,8}fork)", re.I),
     re.compile(r"(直接.{0,8}push|直接推|可以直接)", re.I)),
    (re.compile(r"(必须|需要|应该)", re.I), re.compile(r"(无需|不必|不用|不需要)", re.I)),
]


@dataclass
class ReviewResult:
    passed: bool
    reasons: list[str] = field(default_factory=list)
    verified_symbols: list[str] = field(default_factory=list)   # 源码探索验证通过的
    failed_symbols: list[str] = field(default_factory=list)     # 证伪的


def review_candidate(cand: Candidate, client=None, verify_symbols: bool = True) -> ReviewResult:
    """规则 Review：缺 when / what 过短 / 证据为空 / 源码探索证伪 → 拦截。

    client 为 None 或 verify_symbols=False 时不做源码探索（dry-run 无服务时）。
    源码探索：候选里的类名/方法名调 GET/POST {INDEX_URL}/v1/search 验证存在，
    查不到 → factual_error 拦截（Review 默认保留：探索失败=服务不可用不拦，
    只有明确 0 hits 才拦）。
    """
    res = ReviewResult(passed=True)
    if not (cand.when_expr or "").strip():
        res.passed = False
        res.reasons.append("missing_when")
    if len((cand.what or "").strip()) < WHAT_MIN_CHARS:
        res.passed = False
        res.reasons.append("what_too_short")
    if not cand.evidence:
        res.passed = False
        res.reasons.append("no_evidence")
    if res.passed and verify_symbols and client is not None and cand.lens in ("logic", "index"):
        symbols = _symbols_of(cand)
        for sym in symbols[:REVIEW_SYMBOL_LIMIT]:
            try:
                out = client.code_search(sym, k=3)
            except Exception:  # noqa: BLE001 - 服务不可用：跳过探索，不拦（默认保留）
                res.verified_symbols = []
                break
            hits = out.get("hits") or []
            if hits:
                res.verified_symbols.append(sym)
            else:
                res.failed_symbols.append(sym)
        # 全部被查符号都 0 hits → 证伪；部分命中 → 放行（探索证据倾向保留）
        if res.failed_symbols and not res.verified_symbols and res.failed_symbols == symbols[:REVIEW_SYMBOL_LIMIT][:len(res.failed_symbols)]:
            res.passed = False
            res.reasons.append("factual_error:" + ",".join(res.failed_symbols[:3]))
    return res


def _symbols_of(cand: Candidate) -> list[str]:
    """从 what/why 里抽类名/方法名（供源码探索）。"""
    from stage_a import CLASS_METHOD_RE, STOP_SYMBOLS
    syms = []
    for m in CLASS_METHOD_RE.finditer((cand.what or "") + "\n" + (cand.why or "")):
        cls, via_dot, bare = m.group(1), m.group(2), m.group(3)
        for s in (cls, via_dot, bare):
            if s and s not in STOP_SYMBOLS and 3 <= len(s) <= 60:
                syms.append(s)
    out, seen = [], set()
    for s in syms:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


# ---------------- Dedup ----------------

@dataclass
class DedupResult:
    kept: list[Candidate]
    merged_count: int
    merge_pairs: list[tuple[int, int, float]] = field(default_factory=list)  # (kept_idx, dup_idx, sim)


def dedup(candidates: list[Candidate], threshold: float = DEDUP_THRESHOLD) -> DedupResult:
    """候选集内 what+when 相似 > threshold 合并。**禁桥接**：只与已保留代表项
    两两比较，被合并项不再作为代表参与后续比较（传递相似不合并）。"""
    kept: list[Candidate] = []
    merge_pairs: list[tuple[int, int, float]] = []
    for i, cand in enumerate(candidates):
        dup_of = -1
        best = 0.0
        for j, rep in enumerate(kept):
            sim = text_similarity(norm(cand.what) + " " + norm(cand.when_expr),
                                  norm(rep.what) + " " + norm(rep.when_expr))
            if sim > best:
                best, dup_of = sim, j
        if dup_of >= 0 and best > threshold:
            merge_pairs.append((dup_of, i, round(best, 4)))
            # 合并证据到代表项（保留更完整证据），不产生新条目
            rep_ev = {(e.get("archive_ref") or e.get("issue") or ""): e
                      for e in kept[dup_of].evidence}
            for e in cand.evidence:
                k = e.get("archive_ref") or e.get("issue") or ""
                rep_ev.setdefault(k, e)
            kept[dup_of].evidence = list(rep_ev.values())
        else:
            kept.append(cand)
    return DedupResult(kept=kept, merged_count=len(merge_pairs), merge_pairs=merge_pairs)


# ---------------- Merge（四判）----------------

@dataclass
class MergeDecision:
    action: str            # create | update | skip | contradict
    target_id: str = ""    # update/skip/contradict 的目标条目 id
    reason: str = ""


def _is_contradiction(cand: Candidate, hit: dict) -> bool:
    """反向判定：谈同一主题（when 相近或 what 高相似）且指令方向相反。"""
    same_subject = (
        text_similarity(norm(cand.what), norm(hit.get("what", ""))) >= MERGE_SAME_THRESHOLD
        or _same_target(cand, hit)
    )
    if not same_subject:
        return False
    a_text = cand.what + " " + cand.when_expr
    b_text = hit.get("what", "") + " " + hit.get("when_expr", "")
    a_forbid = bool(FORBID_RE.search(a_text))
    a_require = bool(REQUIRE_RE.search(a_text))
    b_forbid = bool(FORBID_RE.search(b_text))
    b_require = bool(REQUIRE_RE.search(b_text))
    if (a_forbid and b_require) or (a_require and b_forbid):
        return True
    for rx_a, rx_b in CONTRA_PAIRS:
        if (rx_a.search(a_text) and rx_b.search(b_text)) or \
           (rx_b.search(a_text) and rx_a.search(b_text)):
            return True
    return False


def decide_merge(cand: Candidate, hits: list[dict]) -> MergeDecision:
    """Merge 四判（纯函数，可测）。hits = /v1/memories/search 的命中条目。"""
    for hit in hits:
        if _is_contradiction(cand, hit):
            return MergeDecision("contradict", hit.get("id", ""),
                                 f"与 {hit.get('id')} 反向（同主题，指令方向相反）")
    best_sim, best_hit = 0.0, None
    for hit in hits:
        s = text_similarity(norm(cand.what) + " " + norm(cand.when_expr),
                            norm(hit.get("what", "")) + " " + norm(hit.get("when_expr", "")))
        if s > best_sim:
            best_sim, best_hit = s, hit
    if best_hit is not None and best_sim > MERGE_SAME_THRESHOLD:
        # 同向：what 几乎一致（>0.9，Dedup 同口径）且证据无新增 → skip；否则 update 补证据
        near_identical = best_sim > DEDUP_THRESHOLD
        new_evidence = [e for e in cand.evidence
                        if e.get("archive_ref") and near_identical is False]
        if near_identical and not _evidence_new(cand, best_hit):
            return MergeDecision("skip", best_hit.get("id", ""),
                                 f"同向近似（{best_sim:.2f}），无新增信息")
        return MergeDecision("update", best_hit.get("id", ""),
                             f"同向相似 {best_sim:.2f}，补充信息/证据")
    return MergeDecision("create", "", "无同向条目（唯一目标前置：默认 create）")


def _evidence_new(cand: Candidate, hit: dict) -> bool:
    """命中条目是否已覆盖候选的证据（stub/真实命中都带 evidence 或 archive_ref 信息）。"""
    hit_ev = hit.get("evidence") or []
    hit_refs = {e.get("archive_ref") for e in hit_ev if isinstance(e, dict)}
    if not hit_refs:
        return False  # 命中无证据信息：保守按"已覆盖"→ skip（宁少写勿重复）
    return any(e.get("archive_ref") and e.get("archive_ref") not in hit_refs
               for e in cand.evidence)


def _same_target(cand: Candidate, hit: dict) -> bool:
    """判断候选与命中是否指向同一目标（when_expr 接近）。"""
    return text_similarity(norm(cand.when_expr), norm(hit.get("when_expr", ""))) > 0.5


def execute_merge(decision: MergeDecision, cand: Candidate, client) -> dict:
    """执行四判（非 dry-run 时调用）。返回服务端响应摘要。"""
    if decision.action == "create":
        return client.memory_upsert(cand.to_payload() | {"status": "active"})
    if decision.action == "update":
        return client.memory_upsert(cand.to_payload())
    if decision.action == "contradict":
        # 写入候选并标 conflicting，进人工队列（GET /v1/memories/conflicts）
        return client.memory_upsert(cand.to_payload() | {"status": "conflicting"})
    return {"action": "skip", "id": decision.target_id}


def run_governance(candidates: list[Candidate], client=None, dry_run: bool = True,
                   verify_symbols: bool = True, top_k: int = 5) -> dict:
    """完整三层治理。返回结构化结果（pipeline.py 直接打印/执行）。

    dry-run：不写服务端（不做 execute_merge，源码探索仍可做——只读）。
    client 为 None：源码探索与 Merge 同向查询跳过（全部按无命中处理）。
    """
    report: dict = {"review": [], "dedup": None, "merge": [], "stats": {}}
    # Review
    passed: list[Candidate] = []
    for cand in candidates:
        rr = review_candidate(cand, client=client, verify_symbols=verify_symbols)
        row = {"what": cand.what, "pass": rr.passed, "reasons": rr.reasons,
               "verified": rr.verified_symbols, "failed": rr.failed_symbols}
        report["review"].append(row)
        if rr.passed:
            passed.append(cand)
    # Dedup
    dd = dedup(passed)
    report["dedup"] = {"kept": len(dd.kept), "merged": dd.merged_count,
                       "pairs": dd.merge_pairs}
    # Merge
    for cand in dd.kept:
        hits: list[dict] = []
        if client is not None:
            try:
                out = client.memory_search(q=(cand.what + " " + cand.when_expr)[:200],
                                           repo=cand.repo, top_k=top_k)
                hits = out.get("hits") or []
            except Exception as e:  # noqa: BLE001 - 查询失败按无命中处理（默认 create）
                hits = []
        dec = decide_merge(cand, hits)
        executed = None
        if not dry_run and client is not None and dec.action != "skip":
            try:
                executed = execute_merge(dec, cand, client)
            except Exception as e:  # noqa: BLE001
                executed = {"error": str(e)}
        report["merge"].append({
            "action": dec.action, "target": dec.target_id, "reason": dec.reason,
            "lens": cand.lens, "repo": cand.repo, "what": cand.what,
            "when_expr": cand.when_expr, "origin": cand.origin,
            "evidence": cand.evidence, "executed": executed,
        })
    report["stats"] = {
        "candidates_in": len(candidates),
        "review_passed": len(passed),
        "review_blocked": len(candidates) - len(passed),
        "dedup_kept": len(dd.kept),
        "dedup_merged": dd.merged_count,
        "actions": _count_actions(report["merge"]),
        "dry_run": dry_run,
    }
    return report


def _count_actions(merge_rows: list[dict]) -> dict:
    out: dict = {}
    for row in merge_rows:
        out[row["action"]] = out.get(row["action"], 0) + 1
    return out
