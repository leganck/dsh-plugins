"""外部依赖客户端：GitLab API、索引服务、以及"按行读取仓库文件"的 Reader。

刻意做成可注入的对象：
- 单测/回放用 `DictReader` + 假 GitLab；
- 生产用 `GitLabClient` 真发请求；
- 索引服务（code-index-service）只读调用：/v1/search 拿"相关代码块"的位置，
  正文交给 Reader 去仓库里按行取（这样不用给索引服务加新接口）。

限流：GitLab 默认 8 请求/秒（可配），429/5xx 指数退避；索引服务另有限流。
"""

from __future__ import annotations

import os
import threading
import time
import urllib.parse

from .util import HttpError, env_float, env_int, http_json, log, retry

# ---------------------------------------------------------------- 限流


class RateLimiter:
    """最简令牌桶：保证两次请求之间至少间隔 1/rps 秒。线程安全，够单机用。"""

    def __init__(self, rps: float):
        self.min_interval = 1.0 / rps if rps > 0 else 0.0
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            delta = now - self._last
            if delta < self.min_interval:
                time.sleep(self.min_interval - delta)
            self._last = time.monotonic()


# ---------------------------------------------------------------- 仓库读取


class RepoReader:
    """按行读取仓库文件：{path: [lines]} 或真实 GitLab。"""

    def read(self, path: str, start: int | None = None, end: int | None = None) -> str:
        raise NotImplementedError

    def exists(self, path: str) -> bool:
        raise NotImplementedError


class DictReader(RepoReader):
    """测试/回放用：直接给一份 {path: text}。"""

    def __init__(self, files: dict[str, str]):
        self.files = {k.replace("\\", "/"): v for k, v in files.items()}

    def read(self, path: str, start: int | None = None, end: int | None = None) -> str:
        text = self.files.get(path.replace("\\", "/"))
        if text is None:
            raise KeyError(path)
        if start is None:
            return text
        lines = text.split("\n")
        s = max(1, int(start))
        e = min(len(lines), int(end or s))
        return "\n".join(f"{i:4d}| {lines[i - 1]}" for i in range(s, e + 1))

    def exists(self, path: str) -> bool:
        return path.replace("\\", "/") in self.files


class LocalDirReader(RepoReader):
    """CI 模式：仓库已经 checkout 在本地目录里，直接读文件。"""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)

    def _abs(self, path: str) -> str:
        p = os.path.abspath(os.path.join(self.root, path.replace("\\", "/")))
        if not p.startswith(self.root + os.sep) and p != self.root:
            raise ValueError(f"越界路径：{path}")
        return p

    def read(self, path: str, start: int | None = None, end: int | None = None) -> str:
        with open(self._abs(path), "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        if start is None:
            return text
        lines = text.split("\n")
        s = max(1, int(start))
        e = min(len(lines), int(end or s))
        return "\n".join(f"{i:4d}| {lines[i - 1]}" for i in range(s, e + 1))

    def exists(self, path: str) -> bool:
        try:
            return os.path.isfile(self._abs(path))
        except ValueError:
            return False


# ---------------------------------------------------------------- GitLab


class GitLabClient:
    """GitLab REST 客户端（只覆盖评审需要的几个接口）。"""

    def __init__(self, base_url: str, token: str, *, timeout: float = 30.0, rps: float = 8.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.limiter = RateLimiter(rps)
        self._cache: dict[str, object] = {}

    # ------------------------------------------------------------ 基础

    def _request(self, method: str, path: str, payload=None, raw: bool = False):
        if not path.startswith("/"):
            path = "/" + path
        url = f"{self.base_url}/api/v4{path}"
        headers = {"PRIVATE-TOKEN": self.token}

        def call():
            self.limiter.wait()
            if raw:
                from .util import http_request

                status, body = http_request(method, url, headers=headers, timeout=self.timeout)
                return status, body
            return http_json(method, url, payload, headers=headers, timeout=self.timeout)

        return retry(call, attempts=3, what=f"{method} {path}")

    def _paged(self, path: str) -> list:
        """按 page 拉全量。GitLab 默认 20/页，评审用 100。"""
        out: list = []
        page = 1
        sep = "&" if "?" in path else "?"
        while page <= 20:
            items = self._request("GET", f"{path}{sep}per_page=100&page={page}")
            if not isinstance(items, list) or not items:
                break
            out.extend(items)
            if len(items) < 100:
                break
            page += 1
        return out

    # ------------------------------------------------------------ MR

    def project(self, project_id: int | str) -> dict:
        key = f"project:{project_id}"
        if key not in self._cache:
            self._cache[key] = self._request("GET", f"/projects/{project_id}")
        return self._cache[key]  # type: ignore[return-value]

    def mr(self, project_id: int | str, iid: int) -> dict:
        return self._request("GET", f"/projects/{project_id}/merge_requests/{iid}")

    def diffs(self, project_id: int | str, iid: int) -> list[dict]:
        """`/diffs`（15.7+；`/changes` 已废弃）。返回文件对象列表。"""
        return self._paged(f"/projects/{project_id}/merge_requests/{iid}/diffs")

    def versions(self, project_id: int | str, iid: int) -> list[dict]:
        """`diff_refs` 为空（刚创建的 MR）时用它兜底拿 base/head sha。"""
        return self._paged(f"/projects/{project_id}/merge_requests/{iid}/versions")

    def diff_refs(self, project_id: int | str, iid: int) -> dict:
        """优先 MR 详情的 diff_refs；为空再走 /versions 的最新一条。"""
        data = self.mr(project_id, iid)
        refs = data.get("diff_refs") or {}
        if refs.get("base_sha") and refs.get("head_sha"):
            return refs
        vers = self.versions(project_id, iid)
        if vers:
            # /versions 返回 {base_commit_sha, head_commit_sha, start_commit_sha}
            latest = vers[0]
            return {
                "base_sha": latest.get("base_commit_sha"),
                "start_sha": latest.get("start_commit_sha"),
                "head_sha": latest.get("head_commit_sha"),
            }
        return refs

    # ------------------------------------------------------------ 读文件

    def raw_file(self, project_id: int | str, path: str, ref: str) -> str:
        enc = urllib.parse.quote(path, safe="")
        status, body = self._request(
            "GET", f"/projects/{project_id}/repository/files/{enc}/raw?ref={urllib.parse.quote(ref)}", raw=True
        )
        return body.decode("utf-8", "replace")

    # ------------------------------------------------------------ 发布

    def create_discussion(self, project_id: int | str, iid: int, body: str, position: dict | None = None) -> dict:
        payload: dict = {"body": body}
        if position:
            payload["position"] = position
        return self._request("POST", f"/projects/{project_id}/merge_requests/{iid}/discussions", payload)

    def create_note(self, project_id: int | str, iid: int, body: str) -> dict:
        return self._request("POST", f"/projects/{project_id}/merge_requests/{iid}/notes", {"body": body})

    def update_note(self, project_id: int | str, iid: int, note_id: int, body: str) -> dict:
        return self._request("PUT", f"/projects/{project_id}/merge_requests/{iid}/notes/{note_id}", {"body": body})

    def notes(self, project_id: int | str, iid: int) -> list[dict]:
        return self._paged(f"/projects/{project_id}/merge_requests/{iid}/notes")

    def discussions(self, project_id: int | str, iid: int) -> list[dict]:
        return self._paged(f"/projects/{project_id}/merge_requests/{iid}/discussions")

    # ------------------------------------------------------------ 位置

    @staticmethod
    def position(refs: dict, path: str, line: int, line_range: tuple[int, int] | None = None) -> dict:
        """构造行内评论 position。

        坑：`new_line` 是**文件内行号**；多行评论要 line_range；三个 sha 必须是最新版本。
        """
        pos: dict = {
            "position_type": "text",
            "base_sha": refs.get("base_sha"),
            "start_sha": refs.get("start_sha"),
            "head_sha": refs.get("head_sha"),
            "new_path": path,
            "new_line": int(line),
        }
        if line_range and line_range[1] > line_range[0]:
            pos["line_range"] = {
                "start": {"new_line": int(line_range[0])},
                "end": {"new_line": int(line_range[1])},
            }
        return pos


# ---------------------------------------------------------------- 索引服务


def normalize_namespaces(namespaces) -> list[str]:
    """把 `str | [str] | [{namespace,...}] | None` 统一成去重保序的 list[str]。

    兼容旧调用（单字符串）与新多作用域调用；空值/坏值安静丢弃。
    """
    if not namespaces:
        return []
    if isinstance(namespaces, str):
        items = [namespaces]
    elif isinstance(namespaces, dict):
        items = [namespaces.get("namespace")]
    else:
        items = []
        for item in namespaces:
            if isinstance(item, dict):
                item = item.get("namespace")
            items.append(item)
    out: list[str] = []
    for ns in items:
        text = str(ns or "").strip()
        if text and text not in out:
            out.append(text)
    return out


class IndexClient:
    """code-index-service 的只读客户端（/v1/search，以及档3 的 scope 解析/删除）。"""

    def __init__(self, base_url: str, api_key: str = "", *, timeout: float = 15.0, rps: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.limiter = RateLimiter(rps)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    def search(self, namespaces, query: str, k: int = 6, *, embed_text: str | None = None) -> list[dict]:
        """检索一个或多个作用域。多作用域失败（旧服务端 400/404）自动回退单作用域重试一次。"""
        nss = normalize_namespaces(namespaces)
        if not self.base_url or not nss:
            return []
        multi = len(nss) > 1
        payload: dict = {"query": query, "k": k}
        if multi:
            # 档3 契约 §4.2：namespaces:[{namespace, weight?}]；权重默认 1
            payload["namespaces"] = [{"namespace": ns} for ns in nss]
        else:
            payload["namespace"] = nss[0]
        if embed_text:
            payload["embedText"] = embed_text
        try:
            self.limiter.wait()
            data = http_json(
                "POST", f"{self.base_url}/v1/search", payload, headers=self._headers(), timeout=self.timeout
            )
        except HttpError as e:
            log(f"索引检索失败（降级为空上下文）：HTTP {e.status} {e.body[:120]}")
            if multi and e.status in (400, 404):
                log(f"服务端不支持多作用域检索（HTTP {e.status}），回退单作用域重试")
                return self.search(nss[0], query, k, embed_text=embed_text)
            return []
        return list((data or {}).get("hits") or [])

    def resolve_scope(
        self, repo_id: str, chunk_fp: str, kind: str, ref: str, *, commit: str = "", timeout: float | None = None
    ) -> dict | None:
        """`POST /v1/scopes/resolve`：namespace 一律以服务端返回为准（review 侧不实现 canonical 规则）。

        失败返回 None，由调用方决定降级（best-effort）。
        """
        if not self.base_url or not repo_id or not chunk_fp:
            return None
        payload: dict = {"repoId": repo_id, "chunkFp": chunk_fp, "kind": kind, "ref": ref}
        if commit:
            payload["commit"] = commit
        try:
            self.limiter.wait()
            data = http_json(
                "POST",
                f"{self.base_url}/v1/scopes/resolve",
                payload,
                headers=self._headers(),
                timeout=timeout or self.timeout,
            )
        except HttpError as e:
            log(f"作用域解析失败（降级）：HTTP {e.status} {str(e.body)[:120]}")
            return None
        return data if isinstance(data, dict) else None

    def delete_scope(self, namespace: str, *, timeout: float | None = None) -> dict | None:
        """`DELETE /v1/scopes/{ns}`（幂等）。失败返回 None，调用方只记日志。"""
        if not self.base_url or not namespace:
            return None
        url = f"{self.base_url}/v1/scopes/{urllib.parse.quote(namespace, safe='')}"
        try:
            self.limiter.wait()
            data = http_json("DELETE", url, None, headers=self._headers(), timeout=timeout or self.timeout)
        except HttpError as e:
            log(f"删除作用域失败（忽略）：HTTP {e.status} {str(e.body)[:120]}")
            return None
        return data if isinstance(data, dict) else None

    def health(self) -> dict:
        try:
            return http_json("GET", f"{self.base_url}/health", headers=self._headers(), timeout=self.timeout) or {}
        except HttpError:
            return {}


def index_client_from_env() -> IndexClient:
    return IndexClient(
        env_str_safe("INDEX_URL", ""),
        env_str_safe("INDEX_API_KEY", ""),
        timeout=env_float("INDEX_TIMEOUT", 15.0),
        rps=env_float("INDEX_RPS", 10.0),
    )


def env_str_safe(name: str, default: str) -> str:
    return os.environ.get(name, default) or default


def gitlab_client_from_env() -> GitLabClient:
    base = env_str_safe("GITLAB_URL", "")
    token = env_str_safe("GITLAB_TOKEN", "")
    if not base or not token:
        raise RuntimeError("缺少 GITLAB_URL / GITLAB_TOKEN")
    return GitLabClient(base, token, timeout=env_float("GITLAB_TIMEOUT", 30.0), rps=env_float("GITLAB_RPS", 8.0))


def gitlab_file_reader(client: GitLabClient, project_id: int | str, ref: str) -> RepoReader:
    """用 GitLab raw API 按需读文件（不 clone），带进程内缓存。"""

    class _Reader(RepoReader):
        def __init__(self) -> None:
            self._cache: dict[str, str] = {}

        def _get(self, path: str) -> str:
            p = path.replace("\\", "/")
            if p not in self._cache:
                self._cache[p] = client.raw_file(project_id, p, ref)
            return self._cache[p]

        def read(self, path: str, start: int | None = None, end: int | None = None) -> str:
            text = self._get(path)
            if start is None:
                return text
            lines = text.split("\n")
            s = max(1, int(start))
            e = min(len(lines), int(end or s))
            return "\n".join(f"{i:4d}| {lines[i - 1]}" for i in range(s, e + 1))

        def exists(self, path: str) -> bool:
            try:
                self._get(path)
                return True
            except HttpError as e:
                if e.status == 404:
                    return False
                raise

    return _Reader()


__all__ = [
    "RateLimiter",
    "RepoReader",
    "DictReader",
    "LocalDirReader",
    "GitLabClient",
    "IndexClient",
    "normalize_namespaces",
    "gitlab_client_from_env",
    "gitlab_file_reader",
    "index_client_from_env",
]
