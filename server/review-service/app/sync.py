"""索引同步客户端（Python 版）：把 worktree 切块后同步到 code-index-service。

协议（与服务端/插件完全一致）：
  POST /v1/repos/{namespace}/sync
    {repoId, chunkFp, url, tag, repoState, revision, mode:'full'|'diff',
     upsert:[{path, hash, chunks:[{hash,start,end}]}], remove:[path],
     chunkCount, noEmbed, scope?:{kind, ref, commit?, ttlDays?}}
    → {revision, unchanged, missing:[hash...], chunks, vectors, coverage, namespace?}
  POST /v1/repos/{namespace}/chunks   {bodies:[{hash, body}]}
  POST /v1/repos/{namespace}/embed    {rate?}   （触发服务端后台嵌入）

默认 namespace = `{repoId}@{chunkFp}`（旧行为，INDEX_SCOPE_MODE=repo 时不变）；
档3 作用域模式下由 worker 先 `POST /v1/scopes/resolve` 拿到 namespace 再传进来，
并附带 `scope` 元数据；响应里的 `namespace` 优先（服务端为准）。
`repoState = sha256(排序后的 "path\\0sha")`。
增量策略：本地记录了 (repoState, revision) 且未变 → 只发指纹+revision（1 个 RTT、0 字节正文）。
"""

from __future__ import annotations

import os
import urllib.parse
from dataclasses import dataclass

from .chunker import chunk_file, sha256
from .util import HttpError, http_json, log

SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "target", "vendor", "out", ".venv",
    "__pycache__", ".idea", ".gradle", "coverage", ".next", ".turbo",
}

# 参与建索引的扩展名（与插件策略表一致；window 策略的 md/json 等也索引，评审里可能要看）
INDEX_EXTS = {
    ".py", ".pyi", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".go", ".rs",
    ".java", ".kt", ".groovy", ".gradle", ".rb", ".php", ".cs", ".c", ".h", ".cc", ".cpp",
    ".hpp", ".swift", ".scala", ".sql", ".sh", ".bash", ".md", ".json", ".yml", ".yaml",
    ".toml", ".ini", ".properties", ".xml", ".html", ".css", ".scss",
}

MAX_FILE_BYTES = 1024 * 1024


@dataclass
class SyncResult:
    namespace: str
    revision: int = 0
    unchanged: bool = False
    missing: int = 0
    uploaded: int = 0
    chunks: int = 0
    vectors: int = 0
    repo_state: str = ""
    files: int = 0
    ms: int = 0

    def as_dict(self) -> dict:
        return {
            "namespace": self.namespace,
            "revision": self.revision,
            "unchanged": self.unchanged,
            "missing": self.missing,
            "uploaded": self.uploaded,
            "chunks": self.chunks,
            "vectors": self.vectors,
            "repo_state": self.repo_state,
            "files": self.files,
            "ms": self.ms,
        }


def _walk(worktree: str) -> list[str]:
    out = []
    for dirpath, dirnames, filenames in os.walk(worktree):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if os.path.splitext(name)[1].lower() in INDEX_EXTS:
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def build_manifest(worktree: str, *, chunking: dict | None = None) -> tuple[list[dict], dict[str, str], str, int]:
    """扫 worktree → (manifest, bodies, repoState, chunkCount)。"""
    manifest: list[dict] = []
    bodies: dict[str, str] = {}
    state_rows: list[str] = []
    total_chunks = 0
    for path in _walk(worktree):
        rel = os.path.relpath(path, worktree).replace(os.sep, "/")
        try:
            if os.path.getsize(path) > MAX_FILE_BYTES:
                continue
            with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
                text = f.read()
        except OSError:
            continue
        if not text.strip():
            continue
        fhash = sha256(text)
        got = chunk_file(rel, text, chunking)
        chunks = [{"hash": c["hash"], "start": c["startLine"], "end": c["endLine"]} for c in got["chunks"]]
        for c in got["chunks"]:
            bodies[c["hash"]] = c["body"]
        manifest.append({"path": rel, "hash": fhash, "chunks": chunks})
        state_rows.append(f"{rel}\0{fhash}")
        total_chunks += len(chunks)
    repo_state = sha256("\n".join(sorted(state_rows)))
    return manifest, bodies, repo_state, total_chunks


class IndexSync:
    def __init__(self, base_url: str, api_key: str = "", *, timeout: float = 60.0, batch: int = 256):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.batch = batch

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    def _post(self, path: str, payload: dict, *, timeout: float | None = None):
        return http_json(
            "POST",
            f"{self.base_url}{path}",
            payload,
            headers=self._headers(),
            timeout=timeout or self.timeout,
        )

    # ------------------------------------------------------------ 主流程

    def sync_worktree(
        self,
        worktree: str,
        *,
        repo_id: str,
        repo_url: str = "",
        tag: str | None = None,
        chunk_fp: str = "review-1",
        state: dict | None = None,
        no_embed: bool = False,
        chunking: dict | None = None,
        namespace: str | None = None,
        scope: dict | None = None,
        log_fn=log,
    ) -> SyncResult:
        """同步一个 worktree。

        - `namespace=None, scope=None`：旧行为（`{repo_id}@{chunk_fp}`），服务端零感知；
        - `namespace=<服务端 resolve 结果>, scope={kind,ref,...}`：档3 作用域快照，
          payload 带 scope，最终 namespace 以响应体为准（没给则回退本地值）。
        """
        import time

        t0 = time.monotonic()
        local_ns = namespace or f"{repo_id}@{chunk_fp}"
        manifest, bodies, repo_state, chunk_count = build_manifest(worktree, chunking=chunking)
        res = SyncResult(namespace=local_ns, repo_state=repo_state, files=len(manifest))

        base = {
            "repoId": repo_id,
            "chunkFp": chunk_fp,
            "url": repo_url,
            "tag": tag,
            "repoState": repo_state,
            "noEmbed": no_embed,
            "chunkCount": chunk_count,
        }
        if scope:
            base["scope"] = dict(scope)
        last_state = (state or {}).get("repo_state")
        last_rev = (state or {}).get("revision")
        ns_path = f"/v1/repos/{urllib.parse.quote(local_ns, safe='')}"

        if last_state == repo_state and last_rev is not None:
            payload = {**base, "mode": "diff", "revision": int(last_rev)}
        elif last_rev is None:
            payload = {**base, "mode": "full", "upsert": manifest, "remove": []}
        else:
            payload = {**base, "mode": "diff", "revision": int(last_rev), "upsert": manifest, "remove": []}

        try:
            resp = self._post(f"{ns_path}/sync", payload)
        except HttpError as e:
            body = (e.body or "").lower()
            if e.status == 409 and "revision-conflict" in body:
                log_fn("同步 revision 冲突，改走全量清单")
                resp = self._post(f"{ns_path}/sync", {**base, "mode": "full", "upsert": manifest, "remove": []})
            else:
                raise

        missing = list(resp.get("missing") or [])
        # 档3：以服务端返回的 namespace 为准；旧服务端没有该字段时沿用本地值
        res.namespace = str((resp or {}).get("namespace") or local_ns)
        res.revision = int(resp.get("revision") or 0)
        res.unchanged = bool(resp.get("unchanged"))
        res.missing = len(missing)
        res.chunks = int(resp.get("chunks") or 0)
        res.vectors = int(resp.get("vectors") or 0)

        # 只上传服务端缺的正文（幂等）
        for i in range(0, len(missing), self.batch):
            part = missing[i : i + self.batch]
            payload = [{"hash": h, "body": bodies[h]} for h in part if h in bodies]
            if not payload:
                continue
            got = self._post(f"{ns_path}/chunks", {"bodies": payload})
            res.uploaded += int((got or {}).get("accepted") or 0)

        if missing and not no_embed:
            try:
                self._post(f"{ns_path}/embed", {})
            except HttpError as e:
                log_fn(f"触发嵌入失败（不影响本次同步）：HTTP {e.status}")

        import time as _t

        res.ms = int((_t.monotonic() - t0) * 1000)
        return res


__all__ = ["IndexSync", "SyncResult", "build_manifest", "INDEX_EXTS"]
