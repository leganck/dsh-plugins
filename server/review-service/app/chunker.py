"""tree-sitter 切块（Python 版）。

与插件（`plugins/dsh-code-index/lib/chunker.js` + `chunk-ast.js` + `chunk-heuristic.js`）
**行为对齐**：策略表、打包参数、降级链、哈希算法全部一致，便于用 golden 夹具做 parity。

为什么保留两份实现：
- 插件在用户机器上跑（Node + 按需安装的语法包）；
- 评审服务在服务器上跑（Python + language-pack）。
两份实现由 `tests/fixtures/chunk-golden.json`（插件生成）做 parity 守护：
块数一致、块边界 ≥95% 相同；参数改动必须同时改两边并重跑 golden。

tree-sitter 0.26 注意：`Language.query()` 已被移除；解析用 `parser.parse(bytes)`。
"""

from __future__ import annotations

import hashlib
import re

WINDOW_LINES = 40
EMBED_CHAR_CAP = 1500

# 与插件 strategies.js 的 P 常量一致
P = {"min_lines": 8, "max_lines": 120, "target_lines": 40}

# 与 plugins/dsh-code-index/lib/strategies.js 的 DEFAULT_BY_EXT 保持一致（顺序即优先级）
DEFAULT_BY_EXT: dict[str, dict] = {
    # ── AST 切块 ──
    ".java": {"strategy": "ast", "grammar": "java", **P},
    ".js": {"strategy": "ast", "grammar": "javascript", **P},
    ".mjs": {"strategy": "ast", "grammar": "javascript", **P},
    ".cjs": {"strategy": "ast", "grammar": "javascript", **P},
    ".jsx": {"strategy": "ast", "grammar": "javascript", **P},
    ".ts": {"strategy": "ast", "grammar": "typescript", **P},
    ".tsx": {"strategy": "ast", "grammar": "tsx", **P},
    # Groovy 的成员本身更长：插件实测把 maxLines 调到 200（残差 100% 来自超长成员）
    ".groovy": {"strategy": "ast", "grammar": "groovy", **P, "max_lines": 200},
    ".gradle": {"strategy": "ast", "grammar": "groovy", **P, "max_lines": 200},
    ".go": {"strategy": "ast", "grammar": "go", **P},
    ".py": {"strategy": "ast", "grammar": "python", **P},
    ".pyi": {"strategy": "ast", "grammar": "python", **P},
    ".rs": {"strategy": "ast", "grammar": "rust", **P},
    # ── 语言内部混排 / 非括号语言：固定窗口 ──
    ".vue": {"strategy": "window", "window_lines": 60},
    ".xml": {"strategy": "window", "window_lines": 60},
    ".html": {"strategy": "window", "window_lines": 60},
    ".sql": {"strategy": "window", "window_lines": 60},
    ".md": {"strategy": "window", "window_lines": 60},
    ".json": {"strategy": "window", "window_lines": 60},
    ".yml": {"strategy": "window", "window_lines": 60},
    ".yaml": {"strategy": "window", "window_lines": 60},
    ".properties": {"strategy": "window", "window_lines": 60},
}

DEFAULT_FALLBACK = {"strategy": "heuristic", **P}

# 行首"像成员声明"的样貌（与插件 chunk-heuristic.js 的 MEMBER_START 等价）
MEMBER_START = re.compile(
    r"^\s*(@|//|/\*|(public|private|protected|static|final|synchronized|abstract|native|transient|"
    r"volatile|default|sealed|override|open|suspend|internal|companion|fun|val|var|class|interface|"
    r"enum|record|struct|impl|fn|async|export|function|const|let|var|def|type|module)\b)"
)

_parser_cache: dict[str, object] = {}


# ---------------------------------------------------------------- 哈希/工具


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def split_lines(text: str) -> list[str]:
    """等价 JS `text.split(/\\r?\\n/)`：CRLF 与 LF 都切成同样多的行。"""
    return re.split(r"\r?\n", text)


def body_for_embedding(body: str) -> str:
    """送入嵌入前的截断（存库仍保留完整 body），与插件 EMBED_CHAR_CAP 一致。"""
    return body[:EMBED_CHAR_CAP] if len(body) > EMBED_CHAR_CAP else body


# ---------------------------------------------------------------- 策略配置


def resolve_chunk_config(rel_path: str, chunking: dict | None = None) -> dict:
    """按扩展名查策略表，再应用调用方覆盖（chunking = {strategy, byExt, windowLines}）。"""
    chunking = chunking or {}
    ext = ("." + rel_path.rsplit(".", 1)[-1].lower()) if "." in rel_path else ""
    base = DEFAULT_BY_EXT.get(ext, DEFAULT_FALLBACK)
    override = (chunking.get("byExt") or {}).get(ext) or {}
    forced = chunking.get("strategy")
    forced = None if not forced or forced == "auto" else forced
    merged = {**base, **override}
    return {
        "ext": ext,
        "strategy": forced or merged.get("strategy"),
        "grammar": merged.get("grammar"),
        "min_lines": merged.get("min_lines", P["min_lines"]),
        "max_lines": merged.get("max_lines", P["max_lines"]),
        "target_lines": merged.get("target_lines", P["target_lines"]),
        "window_lines": merged.get("window_lines", chunking.get("windowLines", WINDOW_LINES)),
        "from_table": ext in DEFAULT_BY_EXT,
    }


# ---------------------------------------------------------------- window


def chunk_text(text: str, window_lines: int = WINDOW_LINES) -> list[dict]:
    lines = split_lines(text)
    out = []
    for i in range(0, len(lines), max(1, window_lines)):
        seg = lines[i : i + window_lines]
        body = "\n".join(seg)
        if not body.strip():
            continue
        out.append(
            {
                "startLine": i + 1,
                "endLine": min(i + window_lines, len(lines)),
                "hash": sha256(body),
                "body": body,
                "kind": "window",
            }
        )
    return out


# ---------------------------------------------------------------- heuristic


def brace_depths(lines: list[str]) -> list[int]:
    """逐行给出"行首处的括号深度"，跳过字符串与注释里的括号（与插件的状态机一致）。"""
    d = [0] * len(lines)
    cur = 0
    in_block_comment = False
    for i, s in enumerate(lines):
        d[i] = cur
        in_str: str | None = None
        j = 0
        while j < len(s):
            c = s[j]
            n = s[j + 1] if j + 1 < len(s) else ""
            if in_block_comment:
                if c == "*" and n == "/":
                    in_block_comment = False
                    j += 2
                    continue
                j += 1
                continue
            if in_str:
                if c == "\\":
                    j += 2
                    continue
                if c == in_str:
                    in_str = None
                j += 1
                continue
            if c == "/" and n == "*":
                in_block_comment = True
                j += 2
                continue
            if c == "/" and n == "/":
                break  # 行注释
            if c in ('"', "'", "`"):
                in_str = c
                j += 1
                continue
            if c == "{":
                cur += 1
            elif c == "}":
                cur -= 1
            j += 1
        if cur < 0:
            cur = 0
    return d


def heuristic_chunks(
    text: str, min_lines: int = P["min_lines"], max_lines: int = P["max_lines"], target_lines: int = P["target_lines"]
) -> list[dict]:
    lines = split_lines(text)
    if not lines:
        return []
    d = brace_depths(lines)
    base = min(d[: min(len(d), 5000)]) if d else 0
    out: list[dict] = []
    start = 0
    for i in range(len(lines)):
        length = i - start + 1
        if length < min_lines:
            continue
        cur = d[i]
        next_non_empty = ""
        for k in range(i + 1, len(lines)):
            if lines[k].strip():
                next_non_empty = lines[k]
                break
        at_member_level = cur == base or cur == base + 1
        member_start = at_member_level and (
            bool(MEMBER_START.match(next_non_empty)) or (cur == base + 1 and bool(MEMBER_START.match(lines[i])))
        )
        after_closing = cur == base + 1 and lines[i].strip() == "}"
        at_boundary = at_member_level and (member_start or after_closing)
        if length >= max_lines or (at_boundary and length >= target_lines):
            out.append({"start": start, "end": i + 1})
            start = i + 1
    if start < len(lines):
        out.append({"start": start, "end": len(lines)})

    # 尾部碎片合并（与插件一致）
    while len(out) >= 2 and out[-1]["end"] - out[-1]["start"] < min_lines:
        tail = out.pop()
        out[-1]["end"] = tail["end"]

    result = []
    for c in out:
        body = "\n".join(lines[c["start"] : c["end"]])
        if not body.strip():
            continue
        result.append(
            {
                "startLine": c["start"] + 1,
                "endLine": min(c["end"], len(lines)),
                "hash": sha256(body),
                "body": body,
                "kind": "heuristic",
            }
        )
    return result


# ---------------------------------------------------------------- ast


def _node_text(node) -> str:
    raw = node.text
    return raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)


def _child(node, field: str):
    """兼容 0.26 的字段名入参（str / bytes 都试一次）。"""
    for f in (field, field.encode()):
        try:
            got = node.child_by_field_name(f)
        except (TypeError, ValueError):
            got = None
        if got is not None:
            return got
    return None


def _push_unit(node, out: list, depth: int = 0) -> None:
    """把一个节点拆成"成员级单元"（与插件 pushUnit 一致）。

    容器（class/interface/enum 等，body 类型以 `_body` 结尾）要迭代 body 的子节点，
    而不是容器自己的子节点；`export class X {}` 这类包装节点则穿透到 declaration。
    """
    if node.type in ("comment", "line_comment", "block_comment"):
        return
    if depth > 4:
        out.append(node)
        return
    body = _child(node, "body")
    if body is not None and re.search(r"_body$", body.type):
        for m in body.named_children:
            _push_unit(m, out, depth + 1)
        return
    decl = _child(node, "declaration")
    if decl is not None and decl.id != node.id:
        _push_unit(decl, out, depth)
        return
    out.append(node)


def _name_of(node) -> str | None:
    for field in ("name", "declarator"):
        n = _child(node, field)
        if n is not None:
            return _node_text(n)[:60]
    return None


def ast_chunks(
    text: str,
    parser,
    min_lines: int = P["min_lines"],
    max_lines: int = P["max_lines"],
    target_lines: int = P["target_lines"],
) -> list[dict]:
    """AST 切块：与插件 astChunks 的打包规则逐条一致（min/target/max 三个阈值）。"""
    tree = parser.parse(text.encode("utf-8"))
    lines = split_lines(text)
    units: list = []
    for ch in tree.root_node.named_children:
        _push_unit(ch, units)

    out: list[dict] = []
    cur: dict | None = None

    def cut() -> None:
        nonlocal cur
        if cur:
            out.append(cur)
        cur = None

    for u in units:
        s = u.start_point[0]
        e = u.end_point[0]
        length = e - s + 1
        if length > max_lines:
            cut()
            a = s
            while a <= e:
                out.append(
                    {
                        "start": a,
                        "end": min(a + max_lines - 1, e),
                        "units": 1,
                        "kind": "forced",
                        "symbol": _name_of(u),
                        "type": u.type,
                    }
                )
                a += max_lines
            continue
        if cur and (cur["end"] - cur["start"] + 1 >= target_lines or e - cur["start"] + 1 > max_lines):
            cut()
        if cur is None:
            cur = {"start": s, "end": e, "units": 1, "kind": "member", "symbol": _name_of(u), "type": u.type}
        else:
            cur["end"] = e
            cur["units"] += 1
            cur["kind"] = "packed"
            cur["symbol"] = None
    cut()

    result = []
    for c in out:
        body = "\n".join(lines[c["start"] : c["end"] + 1])
        if not body.strip():
            continue
        result.append(
            {
                "startLine": c["start"] + 1,
                "endLine": min(c["end"] + 1, len(lines)),
                "hash": sha256(body),
                "body": body,
                "kind": c["kind"],
                "symbol": c["symbol"],
                "nodeType": c["type"],
            }
        )
    return result


def parser_for(grammar: str):
    """按语言名取 parser（进程内缓存）；language-pack 不可用时返回 None。"""
    if grammar in _parser_cache:
        return _parser_cache[grammar]
    try:
        from tree_sitter_language_pack import get_parser  # 延迟导入：无依赖时也能用 heuristic
    except ImportError:
        _parser_cache[grammar] = None
        return None
    try:
        p = get_parser(grammar)
    except Exception:  # noqa: BLE001 —— 语法包缺该语言
        p = None
    _parser_cache[grammar] = p
    return p


# ---------------------------------------------------------------- 分发


def _done(chunks: list[dict], strategy: str, wanted: str, fell_back: bool = False, reason: str | None = None) -> dict:
    return {"chunks": chunks, "strategy": strategy, "wanted": wanted, "fellBack": fell_back, "reason": reason}


def chunk_file(rel_path: str, text: str, chunking: dict | None = None) -> dict:
    """按策略表切块：ast → heuristic → window 的降级链与插件一致，并带回降级原因。"""
    cfg = resolve_chunk_config(rel_path, chunking)
    wanted = cfg["strategy"]

    if wanted == "window":
        return _done(chunk_text(text, cfg["window_lines"]), "window", wanted)
    if wanted == "heuristic":
        return _done(
            heuristic_chunks(text, cfg["min_lines"], cfg["max_lines"], cfg["target_lines"]), "heuristic", wanted
        )

    grammar = cfg["grammar"] or "java"
    parser = parser_for(grammar)
    if parser is None:
        return _done(
            heuristic_chunks(text, cfg["min_lines"], cfg["max_lines"], cfg["target_lines"]),
            "heuristic",
            wanted,
            True,
            f"ast 不可用 → 降级 heuristic：缺少语法 {grammar}",
        )
    try:
        chunks = ast_chunks(text, parser, cfg["min_lines"], cfg["max_lines"], cfg["target_lines"])
        return _done(chunks, "ast", wanted)
    except Exception as e:  # noqa: BLE001
        return _done(
            heuristic_chunks(text, cfg["min_lines"], cfg["max_lines"], cfg["target_lines"]),
            "heuristic",
            wanted,
            True,
            f"ast 解析失败 → 降级 heuristic：{type(e).__name__}: {e}",
        )


def language_of(rel_path: str) -> str | None:
    cfg = resolve_chunk_config(rel_path)
    return cfg["grammar"]


__all__ = [
    "WINDOW_LINES",
    "EMBED_CHAR_CAP",
    "DEFAULT_BY_EXT",
    "resolve_chunk_config",
    "chunk_text",
    "heuristic_chunks",
    "ast_chunks",
    "chunk_file",
    "body_for_embedding",
    "language_of",
    "sha256",
    "split_lines",
]
