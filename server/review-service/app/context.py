"""上下文三路融合（计划 D7）：语义检索 + 图谱邻居 + 精确 grep。

- 语义：code-index `/v1/search` 给 `path/start/end`，正文从 worktree 读；
- 图谱：`Graph.callers/callees` 给"谁调用我/我调用谁"，高置信边还带行号；
- 精确：`git grep` 用改动里的标识符搜调用点（补语义检索的召回盲区）。

所有来源都按 (path,start,end) 去重，再按"优先级 + 置信度"截断到预算。
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass

from .clients import normalize_namespaces
from .util import log

IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{3,}")
SOURCE_RANK = {"graph": 0, "semantic": 1, "grep": 2}


@dataclass
class ContextSettings:
    max_chunks: int = 6
    max_semantic: int = 4
    max_graph: int = 4
    max_grep: int = 4
    chars: int = 900
    grep_terms: int = 3
    min_confidence: float = 0.6


def extract_terms(text: str, max_terms: int = 3) -> list[str]:
    """从改动文本里挑几个标识符做 grep 关键词（去重、保序、跳过常见词）。"""
    stop = {
        "self", "this", "return", "import", "from", "const", "function", "public", "private",
        "static", "final", "class", "interface", "string", "number", "boolean", "void", "None",
    }
    out: list[str] = []
    for m in IDENT.finditer(text or ""):
        word = m.group()
        if word.lower() in stop:  # type: ignore[attr-defined]
            continue
        if word not in out:
            out.append(word)
        if len(out) >= max_terms:
            break
    return out


def git_grep(worktree: str, terms: list[str], max_hits: int = 4, timeout: float = 10.0) -> list[dict]:
    """在 worktree 里 ripgrep/git grep 关键词。git grep 无结果返回码 1，不算错误。"""
    if not worktree or not terms:
        return []
    pattern = "|".join(re.escape(t) for t in terms)
    try:
        proc = subprocess.run(
            ["git", "-C", worktree, "grep", "-n", "-I", "-E", "-w", pattern],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"git grep 失败（忽略）：{type(e).__name__}")
        return []
    if proc.returncode not in (0, 1):
        return []
    hits = []
    for line in proc.stdout.splitlines()[: max_hits * 4]:
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        path, lineno, text = parts
        try:
            line_no = int(lineno)
        except ValueError:
            continue
        hits.append({"path": path, "line": line_no, "text": text.strip()[:200]})
        if len(hits) >= max_hits:
            break
    return hits


def _read_range(reader, path: str, start: int, end: int, chars: int) -> str:
    try:
        text = reader.read(path, start, end)
    except Exception:  # noqa: BLE001 —— 文件不存在/不可读就跳过
        return ""
    return text[:chars]


def build_context(
    *,
    index=None,
    graph=None,
    reader,
    namespaces: list[str] | str | None = None,
    namespace: str = "",
    query: str,
    changed_paths: set[str] | None = None,
    symbol_ids: list[int] | None = None,
    worktree: str = "",
    settings: ContextSettings | None = None,
) -> list[dict]:
    s = settings or ContextSettings()
    changed = changed_paths or set()
    out: list[dict] = []
    # 档3：多作用域检索；`namespace` 保留给旧调用（单值等价于 [namespace]）
    nss = normalize_namespaces(namespaces if namespaces else ([namespace] if namespace else []))

    # ① 语义检索
    if index is not None and nss:
        try:
            hits = index.search(nss, query, k=max(s.max_semantic * 2, s.max_chunks))
        except Exception as e:  # noqa: BLE001
            log(f"语义检索失败（降级为空）：{type(e).__name__}: {e}")
            hits = []
        got = 0
        for h in hits:
            if got >= s.max_semantic:
                break
            path = str(h.get("path") or "")
            if not path or path in changed:
                continue
            start = int(h.get("start") or 0)
            end = int(h.get("end") or start)
            if start <= 0:
                continue
            text = _read_range(reader, path, start, end, s.chars)
            if text:
                item = {"path": path, "start": start, "end": end, "text": text, "source": "semantic",
                        "confidence": float(h.get("score") or 0.0)}
                # 命中项带来源作用域，进 evidence 供模型/审计辨别上下文来自哪个快照
                if h.get("namespace"):
                    item["namespace"] = str(h["namespace"])
                if isinstance(h.get("scope"), dict):
                    item["scope"] = h["scope"]
                out.append(item)
                got += 1

    # ② 图谱邻居（只取高置信边，低置信的只用于"知道有这个符号"）
    if graph is not None and symbol_ids:
        got = 0
        for sid in symbol_ids:
            if got >= s.max_graph:
                break
            try:
                callers = graph.callers(sid, min_confidence=s.min_confidence, limit=2)
            except Exception:  # noqa: BLE001
                callers = []
            for c in callers:
                if got >= s.max_graph:
                    break
                path = c.get("path") or c.get("caller_path")
                line = int(c.get("line") or 0)
                if not path or line <= 0 or path in changed:
                    continue
                text = _read_range(reader, path, max(1, line - 2), line + 2, s.chars)
                if text:
                    out.append(
                        {"path": path, "start": max(1, line - 2), "end": line + 2, "text": text,
                         "source": "graph", "confidence": float(c.get("confidence") or 0.0)}
                    )
                    got += 1

    # ③ 精确 grep（多取几倍命中再过滤：命中可能全落在改动文件里）
    if worktree:
        terms = extract_terms(query, s.grep_terms)
        got = 0
        for hit in git_grep(worktree, terms, max_hits=max(s.max_grep * 4, 8)):
            if got >= s.max_grep:
                break
            if hit["path"] in changed:
                continue
            text = _read_range(reader, hit["path"], max(1, hit["line"] - 1), hit["line"] + 1, s.chars)
            if text:
                out.append(
                    {"path": hit["path"], "start": max(1, hit["line"] - 1), "end": hit["line"] + 1,
                     "text": text, "source": "grep", "confidence": 0.5}
                )
                got += 1

    # 去重 + 截断（确定性顺序：来源优先 + 置信度降序 + 路径）
    seen: set[tuple[str, int, int]] = set()
    uniq = []
    for item in out:
        key = (item["path"], item["start"], item["end"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(item)
    uniq.sort(key=lambda x: (SOURCE_RANK.get(x["source"], 9), -x["confidence"], x["path"], x["start"]))
    return uniq[: s.max_chunks]


__all__ = ["ContextSettings", "build_context", "extract_terms", "git_grep"]
