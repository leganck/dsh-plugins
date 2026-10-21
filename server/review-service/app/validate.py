"""评审产出的校验、降噪与截断。

这一层决定了"评论像不像资深工程师"：模型产出的候选里，
只有一小部分该发到行内；其余进汇总或直接丢。所有丢弃都带原因，便于统计精确率。

丢弃原因（与文档里的口径一致）：
  invalid_schema       结构不合法（缺字段/类型不对/超长）
  unknown_file         文件不在本次 diff 里
  line_not_changed     行号不是本次新增行（模型最容易犯）
  low_confidence       置信度低于门槛
  below_severity       严重度低于门槛
  duplicate_in_batch   本批内重复（同文件同行同内容）
  duplicate_posted     历史已发过（指纹命中）
  capped_per_file      单文件条数超限
  capped_total         全 MR 条数超限
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .diff import FileDiff
from .util import sha1

SEVERITIES = ("critical", "major", "minor", "trivial", "info")
SEVERITY_RANK = {s: i for i, s in enumerate(SEVERITIES)}  # 越小越严重
CATEGORIES = (
    "security",
    "stability",
    "data-integrity",
    "correctness",
    "performance",
    "maintainability",
)
MAX_MESSAGE_CHARS = 1500
MAX_EVIDENCE_CHARS = 600
MAX_SUGGESTION_CHARS = 4000

DROPPED_LABELS = {
    "invalid_schema": "结构不合法",
    "unknown_file": "文件不在本次 diff",
    "line_not_changed": "不是新增行",
    "low_confidence": "置信度不足",
    "below_severity": "严重度低于门槛",
    "duplicate_in_batch": "本批重复",
    "duplicate_posted": "历史已发过",
    "capped_per_file": "单文件超限",
    "capped_total": "全 MR 超限",
}


@dataclass
class Finding:
    file: str
    line: int
    severity: str
    category: str
    message: str
    confidence: float
    evidence: str = ""
    suggestion: str = ""
    title: str = ""

    def fingerprint(self) -> str:
        """内容指纹：文件 + 行 + 归一化后的正文。用于去重与"重跑不发重复评论"。"""
        norm = " ".join(self.message.split()).lower()
        return sha1(f"{self.file}:{self.line}:{norm}")

    def body(self, hidden: bool = True) -> str:
        parts = [f"**[{self.severity}] {self.category}**\n\n{self.message}"]
        if self.suggestion:
            parts.append("```suggestion\n" + self.suggestion.rstrip("\n") + "\n```")
        if self.evidence:
            parts.append(f"<details><summary>依据</summary>\n\n{self.evidence}\n\n</details>")
        if hidden:
            parts.append(f"<!-- ai-review:{self.fingerprint()} -->")
        return "\n\n".join(parts)

    def brief(self) -> str:
        return f"- `{self.file}:{self.line}` **[{self.severity}]** {self.message.splitlines()[0][:160]}"


@dataclass
class ValidationResult:
    posted: list[Finding] = field(default_factory=list)
    dropped: list[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def drop_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for d in self.dropped:
            counts[d["reason"]] = counts.get(d["reason"], 0) + 1
        return counts


def _norm_path(p: str) -> str:
    p = (p or "").strip().replace("\\", "/")
    if p.startswith("a/") or p.startswith("b/"):
        p = p[2:]
    while p.startswith("./"):
        p = p[2:]
    return p


def _norm_severity(v: str) -> str | None:
    s = (v or "").strip().lower()
    if s in SEVERITY_RANK:
        return s
    aliases = {
        "blocker": "critical",
        "high": "major",
        "error": "major",
        "medium": "minor",
        "low": "trivial",
        "warning": "minor",
        "nit": "trivial",
        "info": "info",
    }
    return aliases.get(s)


def _norm_category(v: str) -> str | None:
    c = (v or "").strip().lower().replace("_", "-").replace(" ", "-")
    aliases = {
        "security-privacy": "security",
        "sec": "security",
        "bug": "correctness",
        "functional-correctness": "correctness",
        "data": "data-integrity",
        "performance-issue": "performance",
        "maintainability": "maintainability",
        "style": "maintainability",
    }
    c = aliases.get(c, c)
    return c if c in CATEGORIES else None


def normalize(raw: dict) -> Finding | str:
    """把模型返回的一条原始对象规范化；不合法返回错误码字符串。"""
    if not isinstance(raw, dict):
        return "invalid_schema"
    file = _norm_path(str(raw.get("file") or ""))
    if not file:
        return "invalid_schema"
    try:
        line = int(raw.get("line"))
    except (TypeError, ValueError):
        return "invalid_schema"
    if line <= 0:
        return "invalid_schema"
    severity = _norm_severity(str(raw.get("severity") or ""))
    if not severity:
        return "invalid_schema"
    category = _norm_category(str(raw.get("category") or "")) or "correctness"
    message = str(raw.get("message") or "").strip()
    if not message:
        return "invalid_schema"
    try:
        confidence = float(raw.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = min(max(confidence, 0.0), 1.0)
    evidence = str(raw.get("evidence") or "").strip()[:MAX_EVIDENCE_CHARS]
    suggestion = str(raw.get("suggestion") or "")[:MAX_SUGGESTION_CHARS]
    return Finding(
        file=file,
        line=line,
        severity=severity,
        category=category,
        message=message[:MAX_MESSAGE_CHARS],
        confidence=confidence,
        evidence=evidence,
        suggestion=suggestion,
        title=str(raw.get("title") or "")[:200],
    )


def validate(
    raws: list,
    files: list[FileDiff],
    min_confidence: float = 0.7,
    severity_floor: str = "minor",
    max_per_file: int = 3,
    max_total: int = 15,
    posted_fingerprints: set[str] | None = None,
) -> ValidationResult:
    """规范化 + 行号校验 + 去重 + 阈值 + 截断。纯函数，不联网，便于单测。"""
    res = ValidationResult()
    by_path = {fd.path: fd for fd in files}
    floor_rank = SEVERITY_RANK.get(severity_floor, SEVERITY_RANK["minor"])
    posted_fp = posted_fingerprints or set()
    seen: set[str] = set()
    candidates: list[Finding] = []

    for raw in raws:
        norm = normalize(raw)
        if isinstance(norm, str):
            res.dropped.append({"reason": norm, "finding": raw})
            continue
        f = norm
        fd = by_path.get(f.file)
        if fd is None:
            res.dropped.append({"reason": "unknown_file", "finding": f})
            continue
        if f.line not in fd.added_lineno_set():
            res.dropped.append({"reason": "line_not_changed", "finding": f})
            continue
        if f.confidence < min_confidence:
            res.dropped.append({"reason": "low_confidence", "finding": f})
            continue
        if SEVERITY_RANK[f.severity] > floor_rank:
            res.dropped.append({"reason": "below_severity", "finding": f})
            continue
        fp = f.fingerprint()
        if fp in seen:
            res.dropped.append({"reason": "duplicate_in_batch", "finding": f})
            continue
        if fp in posted_fp:
            res.dropped.append({"reason": "duplicate_posted", "finding": f})
            continue
        seen.add(fp)
        candidates.append(f)

    # 排序：严重度优先，其次置信度
    candidates.sort(key=lambda x: (SEVERITY_RANK[x.severity], -x.confidence))

    per_file: dict[str, int] = {}
    for f in candidates:
        if per_file.get(f.file, 0) >= max_per_file:
            res.dropped.append({"reason": "capped_per_file", "finding": f})
            continue
        if len(res.posted) >= max_total:
            res.dropped.append({"reason": "capped_total", "finding": f})
            continue
        per_file[f.file] = per_file.get(f.file, 0) + 1
        res.posted.append(f)

    res.stats = {
        "candidates": len(raws),
        "posted": len(res.posted),
        "dropped": len(res.dropped),
        "drop_counts": res.drop_counts(),
    }
    return res


def render_summary(
    mr: dict,
    files: list[FileDiff],
    skips: list[dict],
    result: ValidationResult,
    *,
    model: str = "",
    tokens_in: int = 0,
    tokens_out: int = 0,
    latency_ms: int = 0,
    dry_run: bool = False,
) -> str:
    """汇总评论（MR 顶部那条）：改了哪些、审了什么、跳过什么、哪几条值得先看。"""
    title = mr.get("title") or "(无标题)"
    author = (mr.get("author") or {}).get("name") or ""
    changed = [fd for fd in files if not fd.skip_reason()]
    added = sum(len(fd.added_lines()) for fd in changed)
    lines = [f"## AI 评审：{title}"]
    if author:
        lines.append(f"\n> 提交者：{author}")
    lines.append(
        f"\n审查了 **{len(changed)}** 个文件、**{added}** 行新增；"
        f"共发现 **{len(result.posted)}** 条值得关注的问题。"
    )
    if dry_run:
        lines.append("\n> ⚠️ **dry-run**：本次只生成、未发送行内评论。")

    if result.posted:
        urgent = [f for f in result.posted if f.severity in ("critical", "major")]
        if urgent:
            lines.append("\n### 需要优先处理\n")
            lines.extend(f.brief() for f in urgent[:8])
        rest = [f for f in result.posted if f.severity not in ("critical", "major")]
        if rest:
            lines.append("\n### 其它\n")
            lines.extend(f.brief() for f in rest[:12])

    if skips:
        lines.append("\n### 未评审的文件\n")
        lines.append("| 文件 | 原因 |\n|---|---|")
        for s in skips[:20]:
            lines.append(f"| `{s['path']}` | {s['detail']} |")
        if len(skips) > 20:
            lines.append(f"| … | 其余 {len(skips) - 20} 个 |")

    if result.dropped:
        counts = result.drop_counts()
        detail = "、".join(f"{DROPPED_LABELS.get(k, k)} {v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1]))
        lines.append(f"\n<details><summary>降噪明细（丢弃 {len(result.dropped)} 条）</summary>\n\n{detail}\n\n</details>")

    meta = []
    if model:
        meta.append(f"模型 `{model}`")
    if tokens_in or tokens_out:
        meta.append(f"tokens {tokens_in}→{tokens_out}")
    if latency_ms:
        meta.append(f"耗时 {latency_ms / 1000:.1f}s")
    if meta:
        lines.append("\n---\n" + " · ".join(meta))
    lines.append("\n<!-- ai-review-summary -->")
    return "\n".join(lines)
