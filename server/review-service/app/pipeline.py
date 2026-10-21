"""有界评审流水线：Planner → Reviewer → Verifier → Aggregator。

为什么是"有界图"而不是开放式 agent：
- 评审要在 CI/服务里可预期：步数、工具、token 都有硬上限，超了就降级出结论；
- 每一步的输入输出都是固定 JSON，才能做回放与评测（开放式 agent 做不到）；
- 唯一的"探索"发生在 Verifier：它最多请求 N 次证据（读文件/检索），拿不到就丢弃。

所有外部能力（llm / index / reader）都是注入的，单测与回放不联网。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .clients import IndexClient, RepoReader
from .context import ContextSettings, build_context as build_context_sources
from .parallel import Deadline, map_limited
from .diff import FileDiff, mr_fingerprint, parse_gitlab_diffs, summarize_skips
from .llm import BudgetExceeded, LLM
from .prompts import planner_messages, reviewer_messages, verifier_messages
from .util import dump, log
from .validate import ValidationResult, render_summary, validate

DEFAULT_GUIDELINES_PATHS = (
    "AGENTS.md",
    "CLAUDE.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
    ".gitlab/ai-review.md",
    "docs/review-guidelines.md",
)

DEFAULT_IGNORE_GLOBS = (
    "*.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "go.sum",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.snap",
    "vendor/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    "*.pb.go",
    "*.generated.*",
)


@dataclass
class ReviewSettings:
    """一次评审的全部可调参数（来自环境变量，见 config.py）。"""

    model: str = "deepseek-chat"
    guidelines_paths: tuple[str, ...] = DEFAULT_GUIDELINES_PATHS
    ignore_globs: tuple[str, ...] = DEFAULT_IGNORE_GLOBS
    max_files: int = 30
    max_added_lines_per_file: int = 120
    max_diff_chars: int = 60_000
    min_confidence: float = 0.7
    severity_floor: str = "minor"
    max_per_file: int = 3
    max_total: int = 15
    max_blocks: int = 6
    max_context_chunks: int = 6
    max_verifier_steps: int = 2
    max_candidates: int = 20
    context_chars: int = 900
    timeout_s: float = 300.0
    review_only_new_lines: bool = True


@dataclass
class ReviewOutcome:
    files: list[FileDiff] = field(default_factory=list)
    skips: list[dict] = field(default_factory=list)
    plan: dict = field(default_factory=dict)
    candidates: list[dict] = field(default_factory=list)
    kept: list[dict] = field(default_factory=list)
    validation: ValidationResult = field(default_factory=ValidationResult)
    summary: str = ""
    stopped_reason: str = ""
    diff_fp: str = ""
    seconds: float = 0.0


# ---------------------------------------------------------------- 规范


def build_guidelines(reader: RepoReader, paths: tuple[str, ...] = DEFAULT_GUIDELINES_PATHS) -> str:
    """读仓库里的规范文件（AGENTS.md / .cursorrules …）。找不到就返回空串。"""
    for p in paths:
        try:
            if not reader.exists(p):
                continue
            text = reader.read(p)
        except Exception:
            continue
        text = text.strip()
        if text:
            return f"（来源：{p}）\n{text[:6000]}"
    return ""


# ---------------------------------------------------------------- diff 文本


def build_diff_text(files: list[FileDiff], settings: ReviewSettings) -> str:
    """把"只含新增行"的改动渲染成带文件内行号的文本，按体积截断。"""
    chunks: list[str] = []
    total = 0
    for fd in files:
        if fd.skip_reason():
            continue
        added = fd.added_lines()
        shown = added[: settings.max_added_lines_per_file]
        lines = [f"### {fd.path}"]
        if fd.renamed_file and fd.old_path != fd.path:
            lines.append(f"（由 {fd.old_path} 重命名）")
        for n, text in shown:
            lines.append(f"{n:5d}| {text}")
        if len(added) > len(shown):
            lines.append(f"… 其余 {len(added) - len(shown)} 行新增未展示")
        block = "\n".join(lines)
        if total + len(block) > settings.max_diff_chars:
            chunks.append(f"### {fd.path}\n（超出本次评审体积上限，未展开）")
            total += 40
            continue
        chunks.append(block)
        total += len(block)
    return "\n\n".join(chunks)


def changed_files_payload(files: list[FileDiff], settings: ReviewSettings) -> list[dict]:
    out = []
    for fd in files:
        reason = fd.skip_reason()
        if reason:
            continue
        out.append({"path": fd.path, "added": len(fd.added_lines()), "renamed": fd.renamed_file})
    return out[: settings.max_files]


# ---------------------------------------------------------------- 上下文


def build_context(
    index: IndexClient,
    reader: RepoReader,
    namespace: str,
    query: str,
    settings: ReviewSettings,
    *,
    exclude_paths: set[str] | None = None,
) -> list[dict]:
    """检索"相关代码"并把正文取回来（索引只给位置，正文从仓库读）。"""
    hits = index.search(namespace, query, k=settings.max_context_chunks)
    out: list[dict] = []
    seen: set[tuple[str, int, int]] = set()
    for h in hits:
        path = str(h.get("path") or "")
        start = int(h.get("start") or 0)
        end = int(h.get("end") or start)
        if not path or start <= 0:
            continue
        if exclude_paths and path in exclude_paths:
            continue
        key = (path, start, end)
        if key in seen:
            continue
        seen.add(key)
        try:
            text = reader.read(path, start, end)
        except Exception:
            continue
        out.append({"path": path, "start": start, "end": end, "text": text[: settings.context_chars]})
        if len(out) >= settings.max_context_chunks:
            break
    return out


# ---------------------------------------------------------------- P / R / V


def plan(llm: LLM, mr: dict, files: list[FileDiff], code_map: dict | None, settings: ReviewSettings) -> dict:
    """Planner：把改动分组并标记重点。失败就退化成"一个 block 全包"。"""
    payload = changed_files_payload(files, settings)
    try:
        data = llm.chat_json(planner_messages(mr, payload, code_map), "planner", max_tokens=1200)
        blocks = data.get("blocks") if isinstance(data, dict) else None
        if not isinstance(blocks, list) or not blocks:
            raise ValueError("planner 没给出 blocks")
        clean = []
        valid_paths = {fd.path for fd in files if not fd.skip_reason()}
        for b in blocks[: settings.max_blocks]:
            if not isinstance(b, dict):
                continue
            bfiles = [p for p in (b.get("files") or []) if isinstance(p, str) and p in valid_paths]
            if not bfiles:
                continue
            clean.append(
                {
                    "theme": str(b.get("theme") or "变更"),
                    "files": bfiles,
                    "focus": str(b.get("focus") or ""),
                    "risk": str(b.get("risk") or "normal"),
                }
            )
        if not clean:
            raise ValueError("planner 的 blocks 里没有有效文件")
        return {"blocks": clean, "skip": data.get("skip") or [], "planned": True}
    except (ValueError, KeyError, BudgetExceeded) as e:
        log(f"Planner 降级为单块：{type(e).__name__} {e}")
        if isinstance(e, BudgetExceeded):
            raise
        return {
            "blocks": [
                {
                    "theme": "全部变更",
                    "files": [p["path"] for p in payload],
                    "focus": "逐文件审查改动",
                    "risk": "normal",
                }
            ],
            "skip": [],
            "planned": False,
        }


def review_block(
    llm: LLM,
    mr: dict,
    block: dict,
    files_by_path: dict[str, FileDiff],
    *,
    guidelines: str,
    contexts: list[dict],
    static_findings: list[dict],
    settings: ReviewSettings,
) -> list[dict]:
    """Reviewer：只针对本 block 的新增行产出候选 findings。"""
    block_files = [files_by_path[p] for p in block["files"] if p in files_by_path]
    diff_text = build_diff_text(block_files, settings)
    if not diff_text.strip():
        return []
    messages = reviewer_messages(
        theme=block["theme"],
        focus=block.get("focus") or "",
        diff_text=diff_text,
        guidelines=guidelines,
        contexts=contexts,
        static_findings=static_findings,
        max_findings=settings.max_total,
    )
    data = llm.chat_json(messages, "reviewer", max_tokens=2600)
    raw = data.get("findings") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        return []
    # 这里**不做**文件过滤：模型可能评论到本 block 之外的文件，是否是本次 diff 由 validate
    # 的 unknown_file 判定；跨 block 的重复也会在 validate 里被 duplicate_in_batch 去重。
    return [item for item in raw[: settings.max_candidates] if isinstance(item, dict)]


def verify_finding(
    llm: LLM,
    reader: RepoReader,
    index: IndexClient,
    namespace: str,
    finding: dict,
    settings: ReviewSettings,
) -> tuple[bool, str, list[dict]]:
    """Verifier：最多 N 轮取证。拿不到证据 → 丢弃（宁漏勿噪）。

    返回 (keep, reason, transcript_steps)
    """
    evidence: list[dict] = []
    steps: list[dict] = []
    for _ in range(settings.max_verifier_steps):
        try:
            data = llm.chat_json(verifier_messages(finding, evidence, settings.max_verifier_steps), "verifier", max_tokens=900)
        except (ValueError, KeyError) as e:
            steps.append({"step": "verify-error", "detail": str(e)[:200]})
            return False, f"验证结果不可解析：{e}", steps
        if not isinstance(data, dict):
            return False, "验证输出不是对象", steps
        action = str(data.get("action") or "").lower()
        if action == "final":
            keep = bool(data.get("keep"))
            reason = str(data.get("reason") or "")
            steps.append({"step": "verify-final", "keep": keep, "reason": reason[:300]})
            return keep, reason, steps
        if action == "read_file":
            path = str(data.get("path") or finding.get("file") or "")
            try:
                text = reader.read(path, int(data.get("start") or 1), int(data.get("end") or 120))
                result = text[:4000]
            except Exception as e:
                result = f"读取失败：{type(e).__name__}: {e}"
            evidence.append({"action": f"read_file {path}", "result": result})
            steps.append({"step": "verify-read", "path": path})
            continue
        if action == "search":
            hits = index.search(namespace, str(data.get("query") or ""), k=4)
            brief = "\n".join(f"{h.get('path')}:{h.get('start')}-{h.get('end')} (score {h.get('score')})" for h in hits)
            evidence.append({"action": f"search {data.get('query')}", "result": brief or "无结果"})
            steps.append({"step": "verify-search"})
            continue
        # 未知动作：保守丢弃
        steps.append({"step": "verify-unknown", "action": action})
        return False, f"未知验证动作：{action}", steps
    steps.append({"step": "verify-exhausted"})
    return False, "取证轮次用尽，未确认问题", steps


# ---------------------------------------------------------------- 编排


def run_review(
    *,
    mr: dict,
    diffs: list[dict] | None = None,
    files: list[FileDiff] | None = None,
    llm: LLM,
    index: IndexClient,
    reader: RepoReader,
    settings: ReviewSettings,
    namespace: str = "",
    code_map: dict | None = None,
    static_findings: list[dict] | None = None,
    posted_keys: set[str] | None = None,
    graph=None,
    worktree: str = "",
    context_settings: ContextSettings | None = None,
    concurrency: int = 4,
    deadline_s: float = 300.0,
    progress=None,
) -> ReviewOutcome:
    """跑完整条流水线。任何一步异常都不应让整个任务崩（除了预算超限）。"""
    t0 = time.monotonic()
    files = files if files is not None else parse_gitlab_diffs(list(diffs or []), list(settings.ignore_globs))
    skips = summarize_skips(files)
    outcome = ReviewOutcome(files=files, skips=skips, diff_fp=mr_fingerprint(files))
    say = progress or (lambda msg: log(msg))

    changed = [fd for fd in files if not fd.skip_reason()]
    if not changed:
        outcome.stopped_reason = "no-reviewable-files"
        outcome.summary = render_summary(mr, files, skips, outcome.validation, model=settings.model)
        outcome.seconds = round(time.monotonic() - t0, 2)
        return outcome

    try:
        guidelines = build_guidelines(reader, settings.guidelines_paths)
        outcome.plan = plan(llm, mr, files, code_map, settings)
        say(
            f"Planner：{len(outcome.plan['blocks'])} 个 block"
            f"（{'模型规划' if outcome.plan.get('planned') else '降级单块'}）"
        )

        files_by_path = {fd.path: fd for fd in changed}
        all_candidates: list[dict] = []
        static_findings = static_findings or []
        ctx_settings = context_settings or ContextSettings(max_chunks=settings.max_context_chunks)
        deadline = Deadline(seconds=deadline_s)

        # 改动涉及的符号 id（图谱邻居用；没有图谱就为空）
        symbol_ids: list[int] = []
        if graph is not None:
            try:
                symbol_ids = _changed_symbol_ids(graph, files_by_path, outcome.plan["blocks"])
            except Exception as e:  # noqa: BLE001
                say(f"取改动符号失败（图谱邻居跳过）：{type(e).__name__}: {e}")

        def _do_block(block: dict) -> list[dict]:
            query = f"{block['theme']} {block.get('focus') or ''}".strip() or "相关实现"
            if block["files"]:
                sample = files_by_path[block["files"][0]].added_text()[:300]
                if sample:
                    query = f"{query} {sample}"
            contexts = build_context_sources(
                index=index,
                graph=graph,
                reader=reader,
                namespace=namespace,
                query=query,
                changed_paths=set(block["files"]),
                symbol_ids=symbol_ids,
                worktree=worktree,
                settings=ctx_settings,
            )
            try:
                return review_block(
                    llm,
                    mr,
                    block,
                    files_by_path,
                    guidelines=guidelines,
                    contexts=contexts,
                    static_findings=[s for s in static_findings if s.get("path") in set(block["files"])],
                    settings=settings,
                )
            except ValueError as e:
                say(f"block「{block['theme']}」评审输出不可解析，跳过：{e}")
                return []

        blocks = outcome.plan["blocks"]
        block_results = map_limited(
            _do_block, blocks, concurrency=concurrency, deadline=deadline, raise_on=(BudgetExceeded,)
        )
        for block, res in zip(blocks, block_results):
            if res["ok"]:
                found = res["value"] or []
                all_candidates.extend(found)
                say(f"block「{block['theme']}」：候选 {len(found)} 条")
            else:
                say(f"block「{block['theme']}」失败：{res['error']}")

        outcome.candidates = all_candidates[: settings.max_candidates]

        # 先做一次结构/行号/阈值校验，减少要送 Verifier 的条数（省钱）
        pre = validate(
            outcome.candidates,
            files,
            min_confidence=settings.min_confidence,
            severity_floor=settings.severity_floor,
            max_per_file=settings.max_per_file,
            max_total=settings.max_candidates,
            posted_fingerprints=posted_keys,
        )
        kept: list[dict] = []

        def _verify(f):
            return verify_finding(llm, reader, index, namespace, _finding_payload(f), settings)

        verify_results = map_limited(
            _verify, pre.posted, concurrency=concurrency, deadline=deadline, raise_on=(BudgetExceeded,)
        )
        for f, res in zip(pre.posted, verify_results):
            if not res["ok"]:
                pre.dropped.append({"reason": "verifier_error", "finding": _finding_payload(f), "detail": res["error"]})
                say(f"Verifier {f.file}:{f.line} 出错：{res['error'][:80]}")
                continue
            ok, reason, steps = res["value"]
            say(f"Verifier {f.file}:{f.line} → {'保留' if ok else '丢弃'}（{reason[:60] or '无理由'}）")
            if ok:
                payload = _finding_payload(f)
                payload["verified"] = True
                payload["verify_steps"] = steps
                kept.append(payload)
            else:
                pre.dropped.append({"reason": "verifier_rejected", "finding": _finding_payload(f), "detail": reason})

        outcome.kept = kept
        # 最终校验：用 verifier 通过后的集合重新算（含历史去重/截断）
        final = validate(
            kept,
            files,
            min_confidence=settings.min_confidence,
            severity_floor=settings.severity_floor,
            max_per_file=settings.max_per_file,
            max_total=settings.max_total,
            posted_fingerprints=posted_keys,
        )
        # 丢弃统计 = 结构/行号/阈值阶段的丢弃 + verifier 拒绝 + 最终截断。
        # 分开记会导致"看起来只丢了 1 条"，而实际模型吐了 5 条——观测会失真。
        merged = list(pre.dropped) + list(final.dropped)
        counts: dict[str, int] = {}
        for d in merged:
            counts[d["reason"]] = counts.get(d["reason"], 0) + 1
        final.dropped = merged
        final.stats = {
            "candidates": len(outcome.candidates),
            "posted": len(final.posted),
            "dropped": len(merged),
            "drop_counts": counts,
        }
        outcome.validation = final

        outcome.summary = render_summary(
            mr,
            files,
            skips,
            outcome.validation,
            model=settings.model,
            tokens_in=llm.budget.usage.tokens_in,
            tokens_out=llm.budget.usage.tokens_out,
            latency_ms=int((time.monotonic() - t0) * 1000),
        )
    except BudgetExceeded as e:
        outcome.stopped_reason = f"budget: {e}"
        log(f"预算超限，提前收敛：{e}")
        outcome.summary = render_summary(
            mr,
            files,
            skips,
            outcome.validation,
            model=settings.model,
            tokens_in=llm.budget.usage.tokens_in,
            tokens_out=llm.budget.usage.tokens_out,
            latency_ms=int((time.monotonic() - t0) * 1000),
        )
    except Exception as e:  # noqa: BLE001 —— 评审失败不应拖垮服务
        outcome.stopped_reason = f"error: {type(e).__name__}: {e}"
        log(f"流水线异常（已收敛为汇总）：{type(e).__name__}: {e}")
        if not outcome.summary:
            outcome.summary = render_summary(
                mr, files, skips, outcome.validation, model=settings.model
            )

    outcome.seconds = round(time.monotonic() - t0, 2)
    return outcome


def _changed_symbol_ids(graph, files_by_path: dict, blocks: list[dict]) -> list[int]:
    """把"改动的新增行"映射到图谱符号 id（供 callers/callees 取邻居）。"""
    ids: list[int] = []
    seen: set[int] = set()
    for block in blocks:
        for path in block.get("files") or []:
            fd = files_by_path.get(path)
            if fd is None:
                continue
            lines = fd.added_lineno_set()
            if not lines:
                continue
            for s in graph.symbols_for_path(path):
                if s["id"] in seen:
                    continue
                if s["kind"] == "module":
                    continue
                if any(s["start"] <= ln <= s["end"] for ln in lines):
                    seen.add(s["id"])
                    ids.append(s["id"])
    return ids


def _finding_payload(f) -> dict:
    return {
        "file": f.file,
        "line": f.line,
        "severity": f.severity,
        "category": f.category,
        "message": f.message,
        "confidence": f.confidence,
        "evidence": f.evidence,
        "suggestion": f.suggestion,
    }


def outcome_payload(outcome: ReviewOutcome) -> dict:
    """落库/回放用的结构化结果（不含 summarize 之外的大文本）。"""
    return {
        "diff_fp": outcome.diff_fp,
        "stopped_reason": outcome.stopped_reason,
        "plan": outcome.plan,
        "candidates": len(outcome.candidates),
        "kept": outcome.kept,
        "posted": [
            {"file": f.file, "line": f.line, "severity": f.severity, "fingerprint": f.fingerprint()}
            for f in outcome.validation.posted
        ],
        "stats": outcome.validation.stats,
        "skips": outcome.skips[:50],
        "seconds": outcome.seconds,
    }


__all__ = [
    "ReviewSettings",
    "ReviewOutcome",
    "build_guidelines",
    "build_diff_text",
    "build_context",
    "plan",
    "review_block",
    "verify_finding",
    "run_review",
    "outcome_payload",
    "dump",
]
