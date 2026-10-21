"""每个 (项目, 分支) 的索引/图谱状态：镜像路径、namespace、tag、已同步 revision。

与 `store.py` 的 jobs/findings 分表存同一个库，便于事务与运维（备份只需要一份文件）。
"""

from __future__ import annotations

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
  updated_at REAL,
  last_error TEXT,
  PRIMARY KEY(project_id, branch)
);
"""


class IndexState:
    def __init__(self, db_path: str):
        self.db_path = db_path
        with self._conn() as conn:
            conn.executescript(SCHEMA)

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
                "last_synced_sha", "graph_sha", "updated_at", "last_error"]
        with self._conn() as conn:
            conn.execute(
                f"INSERT INTO project_state({','.join(cols)}) VALUES({','.join('?' * len(cols))}) "
                "ON CONFLICT(project_id, branch) DO UPDATE SET " + ",".join(f"{c}=excluded.{c}" for c in cols[2:]),
                tuple(merged.get(c) for c in cols),
            )

    def set_error(self, project_id: str, branch: str, error: str) -> None:
        self.upsert(project_id, branch, last_error=error[:2000])

    def all(self) -> list[dict]:
        with self._conn() as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM project_state").fetchall()]
