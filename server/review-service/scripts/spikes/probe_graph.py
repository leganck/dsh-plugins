"""P0 spike：tree-sitter 语法图原型 + SQLite 读写与查询延迟实测。

不是产品代码，目的只有三个：
1. 验证"用 tree-sitter query 抽 defs/imports/calls"这条路可行；
2. 量出真实仓库的符号数/边数与建图耗时；
3. 量出 SQLite 上 callers/callees 查询的 p50/p95（目标 <50 ms）。

跑法：
    docker exec <容器> python /work/probe_graph.py /repo
"""

from __future__ import annotations

import os
import sqlite3
import statistics
import sys
import time

SKIP_DIRS = {".git", "node_modules", "dist", "build", "target", "vendor", "out", ".venv", "__pycache__"}

EXT_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".groovy": "groovy",
}

# 每个语言的 (定义查询, import 查询, 调用查询)。query 返回的捕获名统一为 def/import/call。
QUERIES = {
    "python": (
        """
        (function_definition name: (identifier) @def)
        (class_definition name: (identifier) @def)
        """,
        """
        (import_statement name: (dotted_name) @import)
        (import_from_statement module_name: (dotted_name) @import)
        """,
        """
        (call function: (identifier) @call)
        (call function: (attribute attribute: (identifier) @call))
        """,
    ),
    "javascript": (
        """
        (function_declaration name: (identifier) @def)
        (class_declaration name: (identifier) @def)
        (method_definition name: (property_identifier) @def)
        """,
        """
        (import_statement source: (string) @import)
        """,
        """
        (call_expression function: (identifier) @call)
        (call_expression function: (member_expression property: (property_identifier) @call))
        """,
    ),
    "go": (
        """
        (function_declaration name: (identifier) @def)
        (method_declaration name: (field_identifier) @def)
        (type_declaration (type_spec name: (type_identifier) @def))
        """,
        """
        (import_spec path: (interpreted_string_literal) @import)
        (import_spec path: (raw_string_literal) @import)
        """,
        """
        (call_expression function: (identifier) @call)
        (call_expression function: (selector_expression field: (field_identifier) @call))
        """,
    ),
    "java": (
        """
        (method_declaration name: (identifier) @def)
        (class_declaration name: (identifier) @def)
        (interface_declaration name: (identifier) @def)
        """,
        """
        (import_declaration (scoped_identifier) @import)
        (import_declaration (identifier) @import)
        """,
        """
        (method_invocation name: (identifier) @call)
        """,
    ),
    "rust": (
        """
        (function_item name: (identifier) @def)
        (struct_item name: (type_identifier) @def)
        (impl_item type: (type_identifier) @def)
        """,
        """
        (use_declaration argument: (_) @import)
        """,
        """
        (call_expression function: (identifier) @call)
        (call_expression function: (field_expression field: (field_identifier) @call))
        """,
    ),
}


def make_query(language, src: str):
    """tree-sitter 0.26 用 Query(language, src) + QueryCursor；旧版是 language.query(src)。"""
    try:
        from tree_sitter import Query, QueryCursor

        q = Query(language, src)
        return q, QueryCursor(q)
    except ImportError:
        return language.query(src), None


def iter_captures(q, cursor, node):
    """统一两种 API 的遍历：新 API 返回 {name: [nodes]}，旧 API 返回 [(node, name)]。"""
    if cursor is not None:
        for name, nodes in cursor.captures(node).items():
            for n in nodes:
                yield n, name
    else:
        for n, name in q.captures(node):
            yield n, name


def collect(root: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            lang = EXT_LANG.get(os.path.splitext(name)[1].lower())
            if lang:
                out.setdefault(lang, []).append(os.path.join(dirpath, name))
    return out


def ms(t0: float) -> float:
    return (time.monotonic() - t0) * 1000


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "/repo"
    from tree_sitter_language_pack import get_parser

    groups = collect(root)
    total = sum(len(v) for v in groups.values())
    print(f"== 语法图探针 ==\n仓库 {root}：{total} 个可解析文件；语言分布 "
          + ", ".join(f"{k}={len(v)}" for k, v in sorted(groups.items())))

    db = sqlite3.connect(":memory:")
    db.executescript(
        """
        CREATE TABLE sym(id INTEGER PRIMARY KEY, path TEXT, kind TEXT, name TEXT, start INT, end INT);
        CREATE TABLE edge(src INT, dst_name TEXT, kind TEXT, confidence REAL, line INT, path TEXT);
        CREATE INDEX idx_sym_name ON sym(name);
        
        """
    )

    t_build = time.monotonic()
    n_defs = n_imports = n_calls = 0
    parse_ms = query_ms = 0.0
    for lang, files in sorted(groups.items()):
        if lang not in QUERIES:
            print(f"  {lang}: 跳过（未定义查询）")
            continue
        try:
            parser = get_parser(lang)
        except Exception as e:  # noqa: BLE001
            print(f"  {lang}: 语法不可用 {e}")
            continue
        q_def, c_def = make_query(parser.language, QUERIES[lang][0])
        q_imp, c_imp = make_query(parser.language, QUERIES[lang][1]) if QUERIES[lang][1].strip() else (None, None)
        q_call, c_call = make_query(parser.language, QUERIES[lang][2]) if QUERIES[lang][2].strip() else (None, None)
        for path in files:
            try:
                src = open(path, "rb").read()
            except OSError:
                continue
            t0 = time.monotonic()
            tree = parser.parse(src)
            parse_ms += ms(t0)
            rel = os.path.relpath(path, root).replace("\\", "/")
            t0 = time.monotonic()
            for kind, q, cur in (("def", q_def, c_def), ("import", q_imp, c_imp), ("call", q_call, c_call)):
                if q is None:
                    continue
                for node, _name in iter_captures(q, cur, tree.root_node):
                    text = src[node.start_byte : node.end_byte].decode("utf-8", "replace")
                    text = text.strip().strip('"').strip("'")
                    if not text or len(text) > 200:
                        continue
                    if kind == "def":
                        db.execute(
                            "INSERT INTO sym(path, kind, name, start, end) VALUES(?,?,?,?,?)",
                            (rel, node.type, text, node.start_point[0] + 1, node.end_point[0] + 1),
                        )
                        n_defs += 1
                    else:
                        db.execute(
                            "INSERT INTO edge(src, dst_name, kind, confidence, line, path) VALUES(?,?,?,?,?,?)",
                            (-1, text, kind, 0.0, node.start_point[0] + 1, rel),
                        )
                        if kind == "import":
                            n_imports += 1
                        else:
                            n_calls += 1
            query_ms += ms(t0)
    db.commit()
    build_ms = ms(t_build)

    # 用名字把 call/import 边连到符号（同文件优先，其次全仓唯一名）
    t0 = time.monotonic()
    names = [r[0] for r in db.execute("SELECT DISTINCT name FROM sym")]
    print(f"  符号 {n_defs}，import 边 {n_imports}，call 边 {n_calls}；"
          f"解析 {parse_ms:.0f} ms，query {query_ms:.0f} ms，建图总计 {build_ms:.0f} ms，唯一符号名 {len(names)}")

    # 名称消歧：同文件优先 → 全仓唯一名 → 多候选（confidence 0.3）
    t0 = time.monotonic()
    resolved = ambiguous = unresolved = 0
    for eid, name, path in db.execute("SELECT rowid, dst_name, path FROM edge").fetchall():
        cands = db.execute("SELECT id, path FROM sym WHERE name=?", (name,)).fetchall()
        if not cands:
            unresolved += 1
            continue
        same = [c for c in cands if c[1] == path]
        if same:
            db.execute("UPDATE edge SET src=?, confidence=? WHERE rowid=?", (same[0][0], 1.0, eid))
            resolved += 1
        elif len(cands) == 1:
            db.execute("UPDATE edge SET src=?, confidence=? WHERE rowid=?", (cands[0][0], 0.6, eid))
            resolved += 1
        else:
            db.execute("UPDATE edge SET src=?, confidence=? WHERE rowid=?", (cands[0][0], 0.3, eid))
            ambiguous += 1
    db.execute("CREATE INDEX idx_edge_src ON edge(src, kind)")
    db.execute("CREATE INDEX idx_edge_dst ON edge(dst_name, kind)")
    resolve_ms = ms(t0)

    # 查询延迟：随机取 100 个符号，查 callers（edge.src 存的是"被调用符号 id"）
    ids = [r[0] for r in db.execute("SELECT id FROM sym LIMIT 400").fetchall()]
    sample = ids[:100]
    for _ in range(20):
        db.execute("SELECT COUNT(*) FROM edge").fetchone()
    lat = []
    for sid in sample:
        t0 = time.monotonic()
        db.execute(
            "SELECT e.line, s.path FROM edge e JOIN sym s ON s.id=e.src WHERE e.src=? AND e.kind='call' LIMIT 20",
            (sid,),
        ).fetchall()
        lat.append(ms(t0))
    if lat:
        lat.sort()
        p50 = statistics.median(lat)
        p95 = lat[max(0, int(len(lat) * 0.95) - 1)]
    else:
        p50 = p95 = 0.0
    print(f"  查询延迟（{len(lat)} 次抽样）：p50={p50:.2f} ms  p95={p95:.2f} ms")
    print(f"  消歧：解析成功 {resolved}，多候选 {ambiguous}，未解析 {unresolved}，耗时 {resolve_ms:.0f} ms")
    lat.sort()
    p50 = statistics.median(lat) if lat else 0
    p95 = lat[int(len(lat) * 0.95) - 1] if lat else 0
    rss = 0
    try:
        import resource

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except Exception:  # noqa: BLE001
        pass
    print(f"  查询延迟（{len(lat)} 次抽样）：p50={p50:.1f} ms  p95={p95:.1f} ms  峰值内存 {rss:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
