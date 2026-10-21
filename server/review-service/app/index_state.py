"""每个 (项目, 分支) 的索引/图谱状态：镜像路径、namespace、tag、已同步 revision。

与 `store.py` 的 jobs/findings 分表存同一个库，便于事务与运维（备份只需要一份文件）。

档3 作用域快照：同一行里用 `scope_json` 记录各作用域的 namespace 与增量游标，
形如 `{"base":{"namespace":..,"repo_state":..,"revision":..,"scope":{..}},
"head":{"namespace":..,...}}`。旧库通过 `ALTER TABLE` 幂等补列，旧行 `scope_json` 为 NULL
（等价于只有旧的单 namespace 行为）。
"""

from __future__ import annotations

import json
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS project_state(
  project_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  mirror_path TEXT,
  namespace TEXT,
  tag TEXT,
  repo_state TEXT,
  revision INT,
  last_synced_sha TEXT,
  graph_sha TEXT,
  scope_json TEXT,
  updated_at REAL,
  last_error TEXT,
  PRIMARY KEY(project_id, branch)
);
"""

SCOPE_PARTS = ("base", "head")


class IndexState:
    def __init__(self, db_path: str):
        self.db_path = db_path
        with self._conn() as conn:
            conn.executescript(SCHEMA)
            self._migrate(conn)

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        """旧库补列（幂等）：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列。"""
        cols = {row[1] for row in conn.execute("PRAGMA table_info(project_state)").fetchall()}
        if "scope_json" not in cols:
            conn.execute("ALTER TABLE project_state ADD COLUMN scope_json TEXT")

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def get(self, project_id: str, branch: str) -> dict | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM project_state WHERE project_id=? AND branch=?",
                (str(project_id), branch),
            ).fetchone()
        return dict(row) if row else None

    def upsert(self, project_id: str, branch: str, **fields) -> None:
        cur = self.get(project_id, branch) or {}
        merged = {**cur, **fields, "project_id": str(project_id), "branch": branch, "updated_at": time.time()}
        cols = ["project_id", "branch", "mirror_path", "namespace", "tag", "repo_state", "revision",
                "last_synced_sha", "graph_sha", "scope_json", "updated_at", "last_error"]
        with self._conn() as conn:
            conn.execute(
                f"INSERT INTO project_state({','.join(cols)}) VALUES({','.join('?' * len(cols))}) "
                "ON CONFLICT(project_id, branch) DO UPDATE SET " + ",".join(f"{c}=excluded.{c}" for c in cols[2:]),
                tuple(merged.get(c) for c in cols),
            )

    def set_error(self, project_id: str, branch: str, error: str) -> None:
        self.upsert(project_id, branch, last_error=error[:2000])

    # ------------------------------------------------------------ 档3 scope

    def scope(self, project_id: str, branch: str, part: str) -> dict:
        """读某个作用域（base/head）的记录；没有/坏数据返回 {}。"""
        return scope_part(self.get(project_id, branch), part)

    def set_scope(self, project_id: str, branch: str, part: str, value: dict) -> None:
        """合并写入某个作用域记录（不覆盖另一个作用域）。"""
        cur = self.get(project_id, branch) or {}
        data = parse_scope_json(cur.get("scope_json"))
        data[part] = dict(value or {})
        self.upsert(project_id, branch, scope_json=dump_scope_json(data))

    def all(self) -> list[dict]:
        with self._conn() as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM project_state").fetchall()]


def parse_scope_json(value) -> dict:
    """解析 scope_json（列值/已解析 dict）→ dict；坏 JSON 安静返回 {}。"""
    if not value:
        return {}
    if isinstance(value, dict):
        return dict(value)
    try:
        data = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def dump_scope_json(data: dict) -> str:
    return json.dumps(data or {}, ensure_ascii=False, separators=(",", ":"))


def scope_part(row: dict | None, part: str) -> dict:
    """从 project_state 行里取一个作用域记录。"""
    if not row:
        return {}
    data = parse_scope_json(row.get("scope_json"))
    value = data.get(part)
    return dict(value) if isinstance(value, dict) else {}


__all__ = ["IndexState", "SCOPE_PARTS", "parse_scope_json", "dump_scope_json", "scope_part"]
