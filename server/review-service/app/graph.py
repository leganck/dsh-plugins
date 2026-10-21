"""语法图：tree-sitter 抽 defs/calls + 文本解析 import，SQLite 存查。

定位（与计划 D13/D14 对应）：
- 只做**语法级**图：不做类型推导，因此每条边带 confidence；
- `evidence_edges()` 只返回 >=0.8 的边——**低置信边不得作为 critical/major 结论的依据**，
  只能用来扩展上下文；
- 建图针对 base 分支的工作树，按文件 hash 增量；`graph_version` 相同则秒回。

语言覆盖：python / javascript / typescript / tsx / go / java / rust / groovy。
某语言 query 编译失败时降级为"只建 defs"，并记录 degraded 原因（不中断整库）。

设计取舍：
- import 用"抓整条语句文本 + 正则解析"，比按语法节点逐个取字段更抗语法版本变化；
- call 用 `function: (_) @callee` 通配 + 文本取最后一段标识符，统一处理
  `f()` / `obj.f()` / `this.f()` / `s.Save()`；
- 每个文件一个 module 符号（kind=module），import 边是 module → module。
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import time

from .chunker import DEFAULT_BY_EXT, split_lines

SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    "vendor",
    "out",
    ".venv",
    "__pycache__",
    ".idea",
    ".gradle",
    "coverage",
}

MAX_FILE_BYTES = 1024 * 1024
GRAPH_SCHEMA_VERSION = "graph-1"

# 参与建图的扩展名（chunker 里策略为 ast 的那些）
GRAPH_EXTS: dict[str, str] = {
    ext: cfg["grammar"] for ext, cfg in DEFAULT_BY_EXT.items() if cfg.get("strategy") == "ast" and cfg.get("grammar")
}

# 各语言"类容器"节点，用于给方法推导 receiver
CLASS_TYPES = {
    "class_definition",
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "impl_item",
    "object_declaration",
    "trait_item",
    "struct_item",
    "type_declaration",
    "class_specifier",
}

KIND_BY_TYPE = {
    "function_definition": "function",
    "function_declaration": "function",
    "function_item": "function",
    "method_definition": "method",
    "method_declaration": "method",
    "class_definition": "class",
    "class_declaration": "class",
    "class_specifier": "class",
    "interface_declaration": "interface",
    "trait_item": "trait",
    "struct_item": "struct",
    "enum_item": "enum",
    "enum_declaration": "enum",
    "type_spec": "type",
    "type_alias_declaration": "type",
    "type_declaration": "type",
    "impl_item": "impl",
    "object_declaration": "class",
}

# ---------------------------------------------------------------- 查询表

DEFS_QUERY = {
    "python": """
        (function_definition name: (_) @name) @def
        (class_definition name: (_) @name) @def
    """,
    "javascript": """
        (function_declaration name: (_) @name) @def
        (class_declaration name: (_) @name) @def
        (method_definition name: (_) @name) @def
    """,
    "typescript": """
        (function_declaration name: (_) @name) @def
        (class_declaration name: (_) @name) @def
        (method_definition name: (_) @name) @def
        (interface_declaration name: (_) @name) @def
        (type_alias_declaration name: (_) @name) @def
        (enum_declaration name: (_) @name) @def
    """,
    "go": """
        (function_declaration name: (_) @name) @def
        (method_declaration name: (_) @name) @def
        (type_spec name: (_) @name) @def
    """,
    "java": """
        (method_declaration name: (_) @name) @def
        (class_declaration name: (_) @name) @def
        (interface_declaration name: (_) @name) @def
        (enum_declaration name: (_) @name) @def
    """,
    "rust": """
        (function_item name: (_) @name) @def
        (struct_item name: (_) @name) @def
        (enum_item name: (_) @name) @def
        (trait_item name: (_) @name) @def
        (impl_item type: (_) @name) @def
    """,
    "groovy": """
        (method_declaration name: (_) @name) @def
        (class_declaration name: (_) @name) @def
    """,
}

CALLS_QUERY = {
    "python": "(call function: (_) @callee) @call",
    "javascript": "(call_expression function: (_) @callee) @call",
    "typescript": "(call_expression function: (_) @callee) @call",
    "tsx": "(call_expression function: (_) @callee) @call",
    "go": "(call_expression function: (_) @callee) @call",
    "java": "(method_invocation name: (_) @callee) @call",
    "rust": "(call_expression function: (_) @callee) @call",
    "groovy": "(method_invocation name: (_) @callee) @call",
}

IMPORTS_QUERY = {
    "python": """
        (import_statement) @import
        (import_from_statement) @import
    """,
    "javascript": "(import_statement) @import",
    "typescript": "(import_statement) @import",
    "tsx": "(import_statement) @import",
    "go": "(import_spec) @import",
    "java": "(import_declaration) @import",
    "rust": "(use_declaration) @import",
    "groovy": "(import_declaration) @import",
}

# tsx 与 typescript 共用定义/导入 query
for _alias in ("tsx",):
    DEFS_QUERY[_alias] = DEFS_QUERY["typescript"]
    IMPORTS_QUERY[_alias] = IMPORTS_QUERY["typescript"]

# ---------------------------------------------------------------- import 解析

IMPORT_RE = {
    "python": re.compile(r"^\s*(?:from\s+(\.*)([\w.]*)\s+import|import\s+([\w.]+))", re.MULTILINE),
    "javascript": re.compile(r"""from\s+["']([^"']+)["']|import\s+["']([^"']+)["']"""),
    "typescript": re.compile(r"""from\s+["']([^"']+)["']|import\s+["']([^"']+)["']"""),
    "tsx": re.compile(r"""from\s+["']([^"']+)["']|import\s+["']([^"']+)["']"""),
    "go": re.compile(r"""["']([^"']+)["']"""),
    "java": re.compile(r"import\s+(?:static\s+)?([\w.]+)"),
    "groovy": re.compile(r"import\s+([\w.]+)"),
    "rust": re.compile(r"use\s+([\w:]+)"),
}

QUOTED = re.compile(r"""["']([^"']+)["']""")
IDENT = re.compile(r"[A-Za-z_$][\w$]*")

# ---------------------------------------------------------------- 表结构

SCHEMA = """
CREATE TABLE IF NOT EXISTS graph_meta(
  project_id TEXT, branch TEXT, commit_sha TEXT, graph_version TEXT,
  built_at REAL, files INT, symbols INT, edges INT, schema_version TEXT,
  PRIMARY KEY(project_id, branch)
);
CREATE TABLE IF NOT EXISTS graph_symbols(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL, branch TEXT NOT NULL,
  path TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, receiver TEXT,
  start INT NOT NULL, end INT NOT NULL, file_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_edges(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL, branch TEXT NOT NULL,
  src INT NOT NULL, dst INT NOT NULL, kind TEXT NOT NULL,
  confidence REAL NOT NULL, path TEXT, line INT, file_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_gsym_name ON graph_symbols(project_id, branch, name);
CREATE INDEX IF NOT EXISTS idx_gsym_path ON graph_symbols(project_id, branch, path);
CREATE INDEX IF NOT EXISTS idx_gedge_dst ON graph_edges(project_id, branch, dst, kind);
CREATE INDEX IF NOT EXISTS idx_gedge_src ON graph_edges(project_id, branch, src, kind);
CREATE INDEX IF NOT EXISTS idx_gedge_hash ON graph_edges(project_id, branch, file_hash);
"""


def _node_text(node) -> str:
    raw = node.text
    return raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)


def _callee_name(text: str) -> str | None:
    """从 `obj.f()` / `this.n()` / `s.Save()` / `f()` 的 callee 文本里取最后一段标识符。"""
    parts = IDENT.findall(text or "")
    return parts[-1] if parts else None


def _receiver_of(node) -> str | None:
    """方法所属类：Go 用 receiver 参数，其它语言向上找类容器。"""
    if node.type == "method_declaration":
        try:
            recv = node.child_by_field_name("receiver")
        except (TypeError, ValueError):
            recv = None
        if recv is not None:
            ids = IDENT.findall(_node_text(recv))
            if ids:
                return ids[-1]
    cur = node.parent
    for _ in range(5):
        if cur is None:
            break
        if cur.type in CLASS_TYPES:
            for filed in ("name", "type"):
                try:
                    n = cur.child_by_field_name(filed)
                except (TypeError, ValueError):
                    n = None
                if n is not None:
                    ids = IDENT.findall(_node_text(n))
                    if ids:
                        return ids[-1]
        cur = cur.parent
    return None


def _looks_like_test(path: str) -> bool:
    base = os.path.basename(path).lower()
    return (
        base.endswith("_test.py")
        or base.startswith("test_")
        or base.endswith(".test.js")
        or base.endswith(".spec.js")
        or base.endswith(".test.ts")
        or base.endswith(".spec.ts")
        or base.endswith("_test.go")
        or "test" in base.split(".")[0]
    )


def _walk_source_files(root: str) -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext in GRAPH_EXTS:
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


# ---------------------------------------------------------------- 图对象


class Graph:
    def __init__(self, db_path: str, *, project_id: str = "0", branch: str = "main"):
        self.db_path = db_path
        self.project_id = str(project_id)
        self.branch = branch
        self._init_db()

    # ------------------------------------------------------------ 基础

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.executescript(SCHEMA)

    # ------------------------------------------------------------ 构建

    def build(self, worktree: str, *, commit_sha: str = "", incremental: bool = True) -> dict:
        """扫 worktree 建图。返回统计（与 P0 原型口径一致，便于对比）。"""
        t0 = time.monotonic()
        stats = {
            "files": 0,
            "skipped_large": 0,
            "failed": 0,
            "symbols": 0,
            "edges": 0,
            "import_edges": 0,
            "call_edges": 0,
            "resolved": 0,
            "ambiguous": 0,
            "unresolved": 0,
            "unresolved_imports": 0,
            "degraded": [],
            "reused": 0,
            "ms": 0,
        }
        abs_files = _walk_source_files(worktree)
        stats["files"] = len(abs_files)
        version = hashlib.sha256(
            "\n".join(
                f"{os.path.relpath(p, worktree).replace(os.sep, '/')}\0{_sha256_text(self._read(p))}"
                for p in abs_files
                if os.path.getsize(p) <= MAX_FILE_BYTES
            ).encode()
        ).hexdigest()

        with self._conn() as conn:
            old = conn.execute(
                "SELECT graph_version FROM graph_meta WHERE project_id=? AND branch=?",
                (self.project_id, self.branch),
            ).fetchone()
            if incremental and old and old["graph_version"] == version:
                meta = conn.execute(
                    "SELECT files, symbols, edges FROM graph_meta WHERE project_id=? AND branch=?",
                    (self.project_id, self.branch),
                ).fetchone()
                if meta is not None:
                    stats.update({"files": meta["files"], "symbols": meta["symbols"], "edges": meta["edges"]})
                return {**stats, "reused": 1, "graph_version": version, "ms": int((time.monotonic() - t0) * 1000)}

            # 每个文件的 hash 缓存，供增量判断
            existing = {
                r["path"]: r["file_hash"]
                for r in conn.execute(
                    "SELECT path, MAX(file_hash) AS file_hash FROM graph_symbols WHERE project_id=? AND branch=? GROUP BY path",
                    (self.project_id, self.branch),
                ).fetchall()
            }

            extracts: list[dict] = []
            for path in abs_files:
                rel = os.path.relpath(path, worktree).replace(os.sep, "/")
                try:
                    if os.path.getsize(path) > MAX_FILE_BYTES:
                        stats["skipped_large"] += 1
                        continue
                    text = self._read(path)
                    fhash = _sha256_text(text)
                    if incremental and existing.get(rel) == fhash:
                        stats["reused"] += 1
                        continue
                    ex = self._extract_file(rel, text)
                    if ex is None:
                        stats["failed"] += 1
                        continue
                    ex["hash"] = fhash
                    extracts.append(ex)
                except Exception:  # noqa: BLE001 —— 单文件失败不中断
                    stats["failed"] += 1

            # 写 symbols（先删后插，单事务）
            for ex in extracts:
                conn.execute(
                    "DELETE FROM graph_symbols WHERE project_id=? AND branch=? AND path=?",
                    (self.project_id, self.branch, ex["path"]),
                )
                conn.execute(
                    "DELETE FROM graph_edges WHERE project_id=? AND branch=? AND path=?",
                    (self.project_id, self.branch, ex["path"]),
                )
            symbol_rows: dict[int, dict] = {}
            for ex in extracts:
                conn.execute(
                    "INSERT INTO graph_symbols(project_id, branch, path, kind, name, receiver, start, end, file_hash) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        self.project_id,
                        self.branch,
                        ex["path"],
                        "module",
                        ex["path"],
                        None,
                        1,
                        max(1, len(split_lines(ex["text"]))),
                        ex["hash"],
                    ),
                )
                module_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
                ex["module_id"] = module_id
                symbol_rows[module_id] = {"path": ex["path"], "kind": "module", "name": ex["path"]}
                for d in ex["defs"]:
                    conn.execute(
                        "INSERT INTO graph_symbols(project_id, branch, path, kind, name, receiver, start, end, file_hash) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (
                            self.project_id,
                            self.branch,
                            ex["path"],
                            d["kind"],
                            d["name"],
                            d["receiver"],
                            d["start"],
                            d["end"],
                            ex["hash"],
                        ),
                    )
                    sid = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
                    d["id"] = sid
                    symbol_rows[sid] = {"path": ex["path"], "kind": d["kind"], "name": d["name"]}
                if ex.get("degraded"):
                    stats["degraded"].append({"path": ex["path"], "reason": ex["degraded"]})

            # 解析（需要全局符号索引）
            all_syms = conn.execute(
                "SELECT id, path, kind, name, receiver, start, end FROM graph_symbols WHERE project_id=? AND branch=?",
                (self.project_id, self.branch),
            ).fetchall()
            by_name: dict[str, list[sqlite3.Row]] = {}
            by_path: dict[str, list[sqlite3.Row]] = {}
            for r in all_syms:
                by_name.setdefault(r["name"], []).append(r)
                by_path.setdefault(r["path"], []).append(r)

            for ex in extracts:
                import_targets = self._resolve_imports(ex, by_path, worktree)
                stats["unresolved_imports"] += sum(1 for t in import_targets if not t["resolved"])
                for t in import_targets:
                    if t["resolved"]:
                        dst = by_path[t["path"]][0][0] if t["path"] in by_path else None
                        if dst is None:
                            continue
                        conn.execute(
                            "INSERT INTO graph_edges(project_id, branch, src, dst, kind, confidence, path, line, file_hash) "
                            "VALUES(?,?,?,?,?,?,?,?,?)",
                            (self.project_id, self.branch, ex["module_id"], dst, "import", 1.0, ex["path"], t["line"], ex["hash"]),
                        )
                        stats["import_edges"] += 1
                imported_paths = {t["path"] for t in import_targets if t["resolved"]}
                for c in ex["calls"]:
                    src = self._containing_symbol(ex, c["line"])
                    if src is None:
                        continue
                    dst, conf, kind = self._resolve_call(c["name"], ex, src, by_name, imported_paths)
                    if dst is None:
                        stats["unresolved"] += 1
                        continue
                    if conf >= 0.9:
                        stats["resolved"] += 1
                    elif conf <= 0.3:
                        stats["ambiguous"] += 1
                    conn.execute(
                        "INSERT INTO graph_edges(project_id, branch, src, dst, kind, confidence, path, line, file_hash) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (self.project_id, self.branch, src, dst, "call", conf, ex["path"], c["line"], ex["hash"]),
                    )
                    stats["call_edges"] += 1

            stats["symbols"] = int(
                conn.execute(
                    "SELECT COUNT(*) FROM graph_symbols WHERE project_id=? AND branch=?",
                    (self.project_id, self.branch),
                ).fetchone()[0]
            )
            stats["edges"] = int(
                conn.execute(
                    "SELECT COUNT(*) FROM graph_edges WHERE project_id=? AND branch=?",
                    (self.project_id, self.branch),
                ).fetchone()[0]
            )
            conn.execute(
                "INSERT INTO graph_meta(project_id, branch, commit_sha, graph_version, built_at, files, symbols, edges, schema_version) "
                "VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(project_id, branch) DO UPDATE SET commit_sha=excluded.commit_sha, graph_version=excluded.graph_version, "
                "built_at=excluded.built_at, files=excluded.files, symbols=excluded.symbols, edges=excluded.edges, schema_version=excluded.schema_version",
                (
                    self.project_id,
                    self.branch,
                    commit_sha,
                    version,
                    time.time(),
                    stats["files"],
                    stats["symbols"],
                    stats["edges"],
                    GRAPH_SCHEMA_VERSION,
                ),
            )
        stats["graph_version"] = version
        stats["ms"] = int((time.monotonic() - t0) * 1000)
        return stats

    @staticmethod
    def _read(path: str) -> str:
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
            return f.read()

    # ------------------------------------------------------------ 抽取

    def _extract_file(self, rel: str, text: str) -> dict | None:
        lang = GRAPH_EXTS.get(os.path.splitext(rel)[1].lower())
        if not lang:
            return None
        parser = _parser_for(lang)
        if parser is None:
            return {"path": rel, "text": text, "lang": lang, "defs": [], "calls": [], "imports": [],
                    "degraded": f"缺少语法 {lang}"}
        tree = parser.parse(text.encode("utf-8"))
        lines = split_lines(text)
        import_line = {i + 1 for i, ln in enumerate(lines) if ln.strip().startswith(("import ", "from ", "use "))}

        defs = _extract_defs(parser, tree, lang, lines)
        note = None
        if not defs and lang == "groovy":
            defs, note = _regex_defs_groovy(text, lines)
        calls = _extract_calls(parser, tree, lang)
        imports = _extract_imports(parser, tree, text, lang, lines)
        ex = {"path": rel, "text": text, "lang": lang, "defs": defs, "calls": calls, "imports": imports}
        if note:
            ex["degraded"] = note
        return ex

    # ------------------------------------------------------------ 解析

    def _resolve_imports(self, ex: dict, by_path: dict, worktree: str) -> list[dict]:
        out = []
        lang = ex["lang"]
        for imp in ex["imports"]:
            target = _import_to_path(lang, imp["module"], ex["path"], set(by_path.keys()))
            out.append({"module": imp["module"], "line": imp["line"], "path": target, "resolved": bool(target)})
        return out

    def _containing_symbol(self, ex: dict, line: int) -> int | None:
        best = None
        for d in ex["defs"]:
            if d["start"] <= line <= d["end"]:
                if best is None or (d["end"] - d["start"]) < (best["end"] - best["start"]):
                    best = d
        return best["id"] if best else ex["module_id"]

    def _resolve_call(self, name: str, ex: dict, src: int, by_name: dict, imported_paths: set[str]):
        cands = by_name.get(name) or []
        if not cands:
            return None, 0.0, "call"
        same = [c for c in cands if c["path"] == ex["path"]]
        if len(same) == 1:
            return same[0]["id"], 1.0, "call"
        if len(same) > 1:
            # 同类（receiver）优先
            recv = next((d["receiver"] for d in ex["defs"] if d["id"] == src), None)
            if recv:
                hit = [c for c in same if c["receiver"] == recv]
                if len(hit) == 1:
                    return hit[0]["id"], 1.0, "call"
            return same[0]["id"], 0.3, "call"
        imported = [c for c in cands if c["path"] in imported_paths]
        if len(imported) == 1:
            return imported[0]["id"], 0.9, "call"
        if len(cands) == 1:
            return cands[0]["id"], 0.6, "call"
        return cands[0]["id"], 0.3, "call"

    # ------------------------------------------------------------ 查询

    def _q(self, sql: str, args: tuple = ()) -> list[dict]:
        with self._conn() as conn:
            return [dict(r) for r in conn.execute(sql, args).fetchall()]

    def symbols_for_path(self, path: str) -> list[dict]:
        """某文件里的全部符号（含 module），按起始行排序。"""
        return self._q(
            "SELECT id, path, kind, name, receiver, start, end FROM graph_symbols "
            "WHERE project_id=? AND branch=? AND path=? ORDER BY start",
            (self.project_id, self.branch, path),
        )

    def callers(self, symbol_id: int, min_confidence: float = 0.6, limit: int = 20) -> list[dict]:
        return self._q(
            """SELECT s.path AS caller_path, s.name AS caller, s.kind AS caller_kind,
                      e.path AS path, e.line, e.confidence
               FROM graph_edges e JOIN graph_symbols s ON s.id=e.src
               WHERE e.project_id=? AND e.branch=? AND e.dst=? AND e.kind='call' AND e.confidence>=?
               ORDER BY e.confidence DESC, e.line LIMIT ?""",
            (self.project_id, self.branch, symbol_id, min_confidence, limit),
        )

    def callees(self, symbol_id: int, min_confidence: float = 0.6, limit: int = 20) -> list[dict]:
        return self._q(
            """SELECT s.path AS callee_path, s.name AS callee, s.kind AS callee_kind,
                      e.path AS path, e.line, e.confidence
               FROM graph_edges e JOIN graph_symbols s ON s.id=e.dst
               WHERE e.project_id=? AND e.branch=? AND e.src=? AND e.kind='call' AND e.confidence>=?
               ORDER BY e.confidence DESC, e.line LIMIT ?""",
            (self.project_id, self.branch, symbol_id, min_confidence, limit),
        )

    def importers(self, path: str, min_confidence: float = 0.9) -> list[dict]:
        return self._q(
            """SELECT s.path AS from_path, e.line, e.confidence
               FROM graph_edges e
               JOIN graph_symbols d ON d.id=e.dst
               JOIN graph_symbols s ON s.id=e.src
               WHERE e.project_id=? AND e.branch=? AND e.kind='import' AND d.path=?
                 AND e.confidence>=? ORDER BY s.path""",
            (self.project_id, self.branch, path, min_confidence),
        )

    def tests_for(self, symbol_id: int) -> list[dict]:
        row = self._q(
            "SELECT path, name FROM graph_symbols WHERE id=?", (symbol_id,)
        )
        if not row:
            return []
        path = row[0]["path"]
        base = os.path.basename(path)
        stem = os.path.splitext(base)[0]
        out = []
        for r in self._q(
            """SELECT s.path, s.name FROM graph_edges e JOIN graph_symbols s ON s.id=e.src
               WHERE e.project_id=? AND e.branch=? AND e.dst=? AND e.kind='call' AND e.confidence>=0.9""",
            (self.project_id, self.branch, symbol_id),
        ):
            if _looks_like_test(r["path"]):
                out.append({"test_path": r["path"], "via": "call"})
        for r in self._q(
            "SELECT path, name FROM graph_symbols WHERE project_id=? AND branch=? AND kind='module' AND path LIKE ?",
            (self.project_id, self.branch, f"%{stem}%"),
        ):
            if _looks_like_test(r["path"]) and not any(o["test_path"] == r["path"] for o in out):
                out.append({"test_path": r["path"], "via": "name"})
        return out

    def neighbors_for_symbols(self, ids: list[int], min_confidence: float = 0.6) -> dict:
        return {
            "callers": {i: self.callers(i, min_confidence) for i in ids},
            "callees": {i: self.callees(i, min_confidence) for i in ids},
            "tests": {i: self.tests_for(i) for i in ids},
        }

    def evidence_edges(self, ids: list[int]) -> list[dict]:
        """只返回 >=0.8 的边：供 Reviewer/Verifier 写进 evidence。"""
        out = []
        for i in ids:
            for c in self.callers(i, min_confidence=0.8):
                out.append({"kind": "caller", "symbol": i, **c})
            for c in self.callees(i, min_confidence=0.8):
                out.append({"kind": "callee", "symbol": i, **c})
        return out

    def importance(self, ids: list[int]) -> dict[int, float]:
        """粗排序分数：被调用次数 + 文件被 import 的次数（各自归一化到 0~1）。"""
        mods = self._q(
            "SELECT DISTINCT path FROM graph_symbols WHERE project_id=? AND branch=? AND kind='module'",
            (self.project_id, self.branch),
        )
        in_deg = {m["path"]: len(self.importers(m["path"])) for m in mods}
        max_in = max(list(in_deg.values()) + [1])
        out = {}
        for i in ids:
            in_call = len(self.callers(i, min_confidence=0.9, limit=1000))
            row = self._q("SELECT path FROM graph_symbols WHERE id=?", (i,))
            imp = in_deg.get(row[0]["path"], 0) if row else 0
            out[i] = round(min(1.0, in_call / 20.0) * 0.7 + min(1.0, imp / max_in) * 0.3, 4)
        return out

    def stats(self) -> dict:
        meta = self._q(
            "SELECT * FROM graph_meta WHERE project_id=? AND branch=?", (self.project_id, self.branch)
        )
        counts = self._q(
            """SELECT
                 (SELECT COUNT(*) FROM graph_symbols WHERE project_id=? AND branch=?) AS symbols,
                 (SELECT COUNT(*) FROM graph_edges WHERE project_id=? AND branch=?) AS edges""",
            (self.project_id, self.branch, self.project_id, self.branch),
        )
        return {**counts[0], "meta": meta[0] if meta else None}

    def prune(self, worktree: str) -> dict:
        """清理已不存在文件的符号/边。"""
        existing = {
            os.path.relpath(p, worktree).replace(os.sep, "/") for p in _walk_source_files(worktree)
        }
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT DISTINCT path FROM graph_symbols WHERE project_id=? AND branch=?",
                (self.project_id, self.branch),
            ).fetchall()
            removed = 0
            for r in rows:
                if r["path"] not in existing:
                    conn.execute("DELETE FROM graph_symbols WHERE project_id=? AND branch=? AND path=?",
                                 (self.project_id, self.branch, r["path"]))
                    conn.execute("DELETE FROM graph_edges WHERE project_id=? AND branch=? AND path=?",
                                 (self.project_id, self.branch, r["path"]))
                    removed += 1
        return {"removed_paths": removed}


# ---------------------------------------------------------------- 解析器与抽取


_parser_cache: dict[str, object] = {}


def _parser_for(lang: str):
    if lang in _parser_cache:
        return _parser_cache[lang]
    try:
        from tree_sitter_language_pack import get_parser
    except ImportError:
        _parser_cache[lang] = None
        return None
    try:
        p = get_parser(lang)
    except Exception:  # noqa: BLE001
        p = None
    _parser_cache[lang] = p
    return p


_QUERY_CACHE: dict[tuple[str, str, int], object] = {}


def _query(parser, lang: str, kind: str, src: str):
    """编译后的 Query 缓存：同一 (语言, 用途, query 文本) 只编译一次。"""
    key = (lang, kind, hash(src))
    q = _QUERY_CACHE.get(key)
    if q is None:
        from tree_sitter import Query

        q = Query(parser.language, src)
        _QUERY_CACHE[key] = q
    return q


def _captures(parser, lang: str, kind: str, src: str, node) -> dict[str, list]:
    from tree_sitter import QueryCursor

    return QueryCursor(_query(parser, lang, kind, src)).captures(node)


def _extract_defs(parser, tree, lang: str, lines: list[str]) -> list[dict]:
    src = DEFS_QUERY.get(lang)
    if not src:
        return []
    out = []
    try:
        from tree_sitter import Query, QueryCursor

        matches = list(QueryCursor(_query(parser, lang, "defs", src)).matches(tree.root_node))
    except Exception:  # noqa: BLE001 —— query 与语法不兼容 → 降级为空定义
        return []
    for _mid, caps in matches:
        def_nodes = caps.get("def") or []
        name_nodes = caps.get("name") or []
        if not def_nodes or not name_nodes:
            continue
        node = def_nodes[0]
        name = _node_text(name_nodes[0])
        if not name:
            continue
        out.append(
            {
                "name": name[:120],
                "kind": KIND_BY_TYPE.get(node.type, "symbol"),
                "receiver": _receiver_of(node),
                "start": node.start_point[0] + 1,
                "end": node.end_point[0] + 1,
            }
        )
    return out


GROOVY_CLASS = re.compile(r"^\s*(?:public\s+|private\s+|protected\s+)?(class|interface|enum|trait)\s+(\w+)")
GROOVY_METHOD = re.compile(
    r"^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+)*"
    r"(?:def|void|[A-Za-z_][\w<>\[\], ]*?)\s+(\w+)\s*\("
)


def _regex_defs_groovy(text: str, lines: list[str]) -> tuple[list[dict], str]:
    """groovy 语法包无法给出声明节点时的兜底：按行正则抽 class/method。"""
    out: list[dict] = []
    cls = None
    for i, line in enumerate(lines, 1):
        m = GROOVY_CLASS.match(line)
        if m:
            cls = m.group(2)
            out.append({"name": cls, "kind": m.group(1), "receiver": None, "start": i, "end": len(lines)})
            continue
        m = GROOVY_METHOD.match(line)
        if m and m.group(1) not in ("if", "for", "while", "switch", "catch", "return", "new"):
            out.append({"name": m.group(1), "kind": "method", "receiver": cls, "start": i, "end": len(lines)})
    return out, "groovy AST 无声明节点，已用正则提取（class/method）"


def _extract_calls(parser, tree, lang: str) -> list[dict]:
    src = CALLS_QUERY.get(lang)
    if not src:
        return []
    out = []
    try:
        caps = _captures(parser, lang, "calls", src, tree.root_node)
    except Exception:  # noqa: BLE001
        return []
    calls = caps.get("call", [])
    callees = caps.get("callee", [])
    for i, call in enumerate(calls):
        callee = callees[i] if i < len(callees) else None
        name = _callee_name(_node_text(callee)) if callee is not None else None
        if not name:
            name = _callee_name(_node_text(call))
        if name:
            out.append({"name": name[:120], "line": call.start_point[0] + 1})
    return out


def _extract_imports(parser, tree, text: str, lang: str, lines: list[str]) -> list[dict]:
    src = IMPORTS_QUERY.get(lang)
    if not src:
        return []
    out = []
    try:
        caps = _captures(parser, lang, "imports", src, tree.root_node)
    except Exception:  # noqa: BLE001
        return []
    rx = IMPORT_RE.get(lang)
    for node in caps.get("import", []):
        stmt = _node_text(node)
        line = node.start_point[0] + 1
        if not rx:
            continue
        m = rx.search(stmt)
        if not m:
            continue
        if lang == "python":
            dots = m.group(1) or ""
            rel = m.group(2) or ""
            direct = m.group(3) or ""
            module = (dots + rel) if (dots or rel) else direct
        else:
            groups = [g for g in m.groups() if g]
            module = groups[0] if groups else None
        if not module:
            continue
        out.append({"module": module.strip(), "line": line})
    return out


def _import_to_path(lang: str, module: str, from_path: str, all_paths: set[str]) -> str | None:
    """把 import 模块名映射到仓库内文件路径；解析不到返回 None。"""
    base_dir = os.path.dirname(from_path)

    def pick(candidates: list[str]) -> str | None:
        for c in candidates:
            c = c.replace("\\", "/")
            if c in all_paths:
                return c
        return None

    if lang == "python":
        rel = module
        dots = 0
        while rel.startswith("."):
            dots += 1
            rel = rel[1:]
        parts = [p for p in rel.split(".") if p]
        root = base_dir
        for _ in range(max(0, dots - 1)):
            root = os.path.dirname(root) if "/" in root else ""
        stem = "/".join([p for p in [root, *parts] if p])
        return pick([stem + ".py", stem + "/__init__.py"])
    if lang in ("javascript", "typescript", "tsx"):
        if not module.startswith("."):
            return None  # 包名/别名（@/、~）先不解析
        stem = os.path.normpath(os.path.join(base_dir, module)).replace("\\", "/")
        stem = re.sub(r"\.(js|ts|tsx|jsx)$", "", stem)
        return pick([f"{stem}.js", f"{stem}.ts", f"{stem}.tsx", f"{stem}/index.js", f"{stem}/index.ts"])
    if lang == "go":
        tail = module.split("/")[-1]
        return pick([p for p in all_paths if f"/{tail}/" in f"/{p}" and p.endswith(".go")][:1])
    if lang in ("java", "groovy"):
        stem = module.replace(".", "/")
        return pick([stem + ".java", stem + ".groovy"])
    if lang == "rust":
        rel = module.replace("::", "/")
        for pre in ("crate/", "super/", "self/"):
            rel = rel.replace(pre, "")
        return pick([f"src/{rel}.rs", f"src/{rel}/mod.rs", f"{rel}.rs"])
    return None


__all__ = ["Graph", "GRAPH_EXTS", "SKIP_DIRS", "MAX_FILE_BYTES"]
