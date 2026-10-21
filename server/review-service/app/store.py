"""SQLite 存储：任务队列 + 产出 + 反馈 + transcript。

单机部署不引入 Redis/Postgres：WAL 模式下一个写者、多个读者足够；
多 worker 用"租约"（lease_until）抢占，崩溃后靠租约过期回收。

表：
  jobs         每次评审任务（幂等键 = project + mr_iid + diff_fp）
  findings     模型产出（含被丢弃的，posted=0 用来统计精确率）
  feedback     人对评论的反馈（采纳/反驳）—— 没有它就只能凭感觉调 prompt
  learnings    团队记忆（scope: org/repo/path glob）
  transcripts  模型调用流水（回放与成本审计）
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

from .util import log

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  mr_iid       INTEGER NOT NULL,
  head_sha     TEXT NOT NULL,
  base_sha     TEXT,
  start_sha    TEXT,
  diff_fp      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued|running|done|failed|skipped
  attempts     INTEGER NOT NULL DEFAULT 0,
  lease_until  REAL NOT NULL DEFAULT 0,
  dry_run      INTEGER NOT NULL DEFAULT 0,
  model        TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  payload_json TEXT,
  created_at   REAL NOT NULL,
  updated_at   REAL NOT NULL,
  UNIQUE(project_id, mr_iid, diff_fp)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, lease_until);

CREATE TABLE IF NOT EXISTS findings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL,
  path       TEXT NOT NULL,
  line       INTEGER NOT NULL,
  severity   TEXT NOT NULL,
  category   TEXT NOT NULL,
  message    TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence   TEXT,
  suggestion TEXT,
  posted     INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_job ON findings(job_id);
CREATE INDEX IF NOT EXISTS idx_findings_dedupe ON findings(dedupe_key);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL,
  action     TEXT NOT NULL,       -- accepted|dismissed|reply
  by_user    TEXT,
  note       TEXT,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS learnings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type  TEXT NOT NULL,      -- org|repo|path
  scope_value TEXT NOT NULL,
  text        TEXT NOT NULL,
  approved    INTEGER NOT NULL DEFAULT 0,
  source      TEXT,
  created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL,
  step        TEXT NOT NULL,
  purpose     TEXT,
  request_sha TEXT,
  response    TEXT,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_job ON transcripts(job_id);
"""


class Store:
    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self._lock = threading.Lock()
        self._init()

    # ------------------------------------------------------------ 基础

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _init(self) -> None:
        with self._conn() as conn:
            conn.executescript(SCHEMA)

    # ------------------------------------------------------------ 入队

    def enqueue(
        self,
        *,
        project_id: str,
        mr_iid: int,
        head_sha: str,
        diff_fp: str,
        base_sha: str = "",
        start_sha: str = "",
        dry_run: bool = False,
    ) -> tuple[int, bool]:
        """幂等入队：同一 (project, iid, diff_fp) 只保留一条。

        返回 (job_id, created)。`diff_fp` 用**内容指纹**而不是 head_sha：
        rebase 后 head_sha 变了但 diff 没变，不应该重复评审。
        """
        now = time.time()
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT id, status FROM jobs WHERE project_id=? AND mr_iid=? AND diff_fp=?",
                (project_id, mr_iid, diff_fp),
            ).fetchone()
            if row:
                return int(row["id"]), False
            cur = conn.execute(
                """INSERT INTO jobs(project_id, mr_iid, head_sha, base_sha, start_sha, diff_fp,
                                    dry_run, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (project_id, mr_iid, head_sha, base_sha, start_sha, diff_fp, 1 if dry_run else 0, now, now),
            )
            return int(cur.lastrowid), True

    # ------------------------------------------------------------ 指纹

    def set_diff_fp(self, job_id: int, diff_fp: str) -> None:
        """worker 拿到真实 diff 后回填内容指纹（webhook 入队时只有 head_sha）。"""
        with self._lock, self._conn() as conn:
            conn.execute("UPDATE jobs SET diff_fp=?, updated_at=? WHERE id=?", (diff_fp, time.time(), job_id))

    def find_done(self, project_id: str, mr_iid: int, diff_fp: str) -> dict | None:
        """同内容指纹、已完成的最近一次任务（rebase 不重审）。"""
        with self._conn() as conn:
            row = conn.execute(
                """SELECT * FROM jobs WHERE project_id=? AND mr_iid=? AND diff_fp=? AND status='done'
                   ORDER BY id DESC LIMIT 1""",
                (project_id, mr_iid, diff_fp),
            ).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------ 抢占
    def claim(self, lease_seconds: float = 900.0) -> dict | None:
        """抢占一个 queued 任务（或租约过期的 running）。返回 job dict。"""
        now = time.time()
        with self._lock, self._conn() as conn:
            row = conn.execute(
                """SELECT * FROM jobs
                   WHERE status='queued' OR (status='running' AND lease_until < ?)
                   ORDER BY id LIMIT 1""",
                (now,),
            ).fetchone()
            if not row:
                return None
            conn.execute(
                "UPDATE jobs SET status='running', attempts=attempts+1, lease_until=?, updated_at=? WHERE id=?",
                (now + lease_seconds, now, row["id"]),
            )
            job = dict(row)
            job["attempts"] = int(job["attempts"]) + 1
            job["status"] = "running"  # 行是 UPDATE 之前读的，这里要纠正
            return job

    def heartbeat(self, job_id: int, lease_seconds: float = 900.0) -> None:
        with self._conn() as conn:
            conn.execute(
                "UPDATE jobs SET lease_until=?, updated_at=? WHERE id=?",
                (time.time() + lease_seconds, time.time(), job_id),
            )

    def finish(
        self,
        job_id: int,
        *,
        payload: dict | None = None,
        model: str = "",
        tokens_in: int = 0,
        tokens_out: int = 0,
        latency_ms: int = 0,
        status: str = "done",
        error: str = "",
    ) -> None:
        with self._lock, self._conn() as conn:
            conn.execute(
                """UPDATE jobs SET status=?, payload_json=?, model=?, tokens_in=?, tokens_out=?,
                                   latency_ms=?, error=?, lease_until=0, updated_at=? WHERE id=?""",
                (
                    status,
                    json.dumps(payload, ensure_ascii=False) if payload is not None else None,
                    model,
                    tokens_in,
                    tokens_out,
                    latency_ms,
                    error or None,
                    time.time(),
                    job_id,
                ),
            )

    def fail(self, job_id: int, error: str, max_attempts: int = 3) -> str:
        """失败处理：未超次数就重新排队，超了就 failed。返回新状态。"""
        with self._lock, self._conn() as conn:
            row = conn.execute("SELECT attempts FROM jobs WHERE id=?", (job_id,)).fetchone()
            attempts = int(row["attempts"]) if row else 0
            new_status = "queued" if attempts < max_attempts else "failed"
            conn.execute(
                "UPDATE jobs SET status=?, error=?, lease_until=0, updated_at=? WHERE id=?",
                (new_status, error[:2000], time.time(), job_id),
            )
            return new_status

    # ------------------------------------------------------------ 产出

    def record_findings(self, job_id: int, findings: list[dict], posted_keys: set[str]) -> None:
        now = time.time()
        with self._lock, self._conn() as conn:
            for f in findings:
                conn.execute(
                    """INSERT INTO findings(job_id, path, line, severity, category, message, confidence,
                                            evidence, suggestion, posted, dedupe_key, created_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        job_id,
                        f["path"],
                        int(f["line"]),
                        f["severity"],
                        f["category"],
                        f["message"],
                        float(f["confidence"]),
                        f.get("evidence") or "",
                        f.get("suggestion") or "",
                        1 if f.get("dedupe_key") in posted_keys else 0,
                        f["dedupe_key"],
                        now,
                    ),
                )

    def posted_keys(self, project_id: str, mr_iid: int) -> set[str]:
        """该 MR 历史上已发出去的评论指纹（跨 job 生效，用于"重跑不重复发"）。"""
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT f.dedupe_key FROM findings f JOIN jobs j ON j.id=f.job_id
                   WHERE j.project_id=? AND j.mr_iid=? AND f.posted=1""",
                (project_id, mr_iid),
            ).fetchall()
        return {r["dedupe_key"] for r in rows}

    # ------------------------------------------------------------ transcript

    def record_transcript(self, job_id: int, entries: list[dict]) -> None:
        now = time.time()
        with self._lock, self._conn() as conn:
            for e in entries:
                conn.execute(
                    """INSERT INTO transcripts(job_id, step, purpose, request_sha, response, tokens_in,
                                               tokens_out, created_at) VALUES(?,?,?,?,?,?,?,?)""",
                    (
                        job_id,
                        e.get("step") or "",
                        e.get("purpose") or "",
                        e.get("request_sha") or "",
                        e.get("response") or "",
                        int(e.get("tokens_in") or 0),
                        int(e.get("tokens_out") or 0),
                        now,
                    ),
                )

    # ------------------------------------------------------------ 观测

    def queue_stats(self) -> dict:
        with self._conn() as conn:
            rows = conn.execute("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").fetchall()
        return {r["status"]: int(r["n"]) for r in rows}

    def last_jobs(self, limit: int = 5) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT id, project_id, mr_iid, status, tokens_in, tokens_out, latency_ms, error,
                          updated_at FROM jobs ORDER BY id DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def requeue(self, job_id: int) -> bool:
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE jobs SET status='queued', error=NULL, lease_until=0, updated_at=? WHERE id=?",
                (time.time(), job_id),
            )
            return cur.rowcount > 0


def open_store(path: str) -> Store:
    log(f"打开任务库：{path}")
    return Store(path)
