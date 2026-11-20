"""index-server HTTP 客户端（stdlib urllib，无第三方依赖）。

覆盖两组端点：
- memories API（task-5 冻结契约）：POST /v1/memories（幂等 upsert）、
  POST /v1/memories/search、GET /v1/memories/{id}、GET /v1/memories?repo=&lens=&status=&q=、
  POST /v1/memories/{id}/hit、DELETE /v1/memories/{id}（软删 retired）、
  GET /v1/memories/conflicts、POST /v1/memories/{id}/resolve
- 源码探索（已有端点）：POST /v1/search {query, namespace?, k} → {hits:[...]}

只含 HTTP 细节；业务判定在 stage_c.py。所有方法抛 PipelineClientError。
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request


class PipelineClientError(RuntimeError):
    """HTTP 请求失败（网络/非 2xx/解码失败）。"""


def default_base_url() -> str:
    return os.environ.get("INDEX_URL", "http://192.168.50.112:18000").rstrip("/")


def default_api_key() -> str:
    return os.environ.get("INDEX_API_KEY", "")


def admin_basic_auth() -> tuple[str, str] | None:
    """admin 凭据（PIPE_ADMIN_USER/PIPE_ADMIN_PASSWORD env）。

    pipeline-runs 上报走 /v1/admin/*（Basic 鉴权）。缺任一 env → 返回 None
    （调用方跳过上报并打印说明，不报错——留痕是旁路，不能挡管道）。
    """
    user = os.environ.get("PIPE_ADMIN_USER", "").strip()
    password = os.environ.get("PIPE_ADMIN_PASSWORD", "")
    if not user or not password:
        return None
    return user, password


class IndexClient:
    """轻量 REST 客户端。timeout 秒；失败重试 retries 次（指数退避）。"""

    def __init__(self, base_url: str | None = None, api_key: str | None = None,
                 timeout: float = 15.0, retries: int = 1):
        self.base = (base_url or default_base_url()).rstrip("/")
        self.api_key = api_key if api_key is not None else default_api_key()
        self.timeout = timeout
        self.retries = retries

    # ---------- 底层 ----------
    def _request(self, method: str, path: str, body: dict | None = None,
                 basic_auth: tuple[str, str] | None = None) -> dict:
        url = self.base + path
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        last_err: Exception | None = None
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Content-Type", "application/json")
            if basic_auth is not None:
                import base64
                token = base64.b64encode(
                    f"{basic_auth[0]}:{basic_auth[1]}".encode("utf-8")).decode("ascii")
                req.add_header("Authorization", "Basic " + token)
            elif self.api_key:
                req.add_header("Authorization", "Bearer " + self.api_key)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read()
                    if not raw:
                        return {}
                    return json.loads(raw.decode("utf-8"))
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = e.read().decode("utf-8", "replace")[:300]
                except Exception:  # noqa: BLE001
                    pass
                # 4xx 客户端错误不重试
                if 400 <= e.code < 500 or attempt >= self.retries:
                    raise PipelineClientError(f"{method} {path} -> HTTP {e.code}: {detail}") from e
                last_err = e
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
                if attempt >= self.retries:
                    raise PipelineClientError(f"{method} {path} failed: {e}") from e
                last_err = e
            time.sleep(0.5 * (attempt + 1))
        raise PipelineClientError(f"{method} {path} failed: {last_err}")

    # ---------- 源码探索（已有 /v1/search）----------
    def code_search(self, query: str, namespace: str = "", k: int = 5) -> dict:
        """POST /v1/search。namespace 可为空字符串（服务端自行处理）。返回 {hits, ...}。"""
        body: dict = {"query": query, "k": k}
        if namespace:
            body["namespace"] = namespace
        return self._request("POST", "/v1/search", body)

    # ---------- memories API（task-5 冻结契约）----------
    def memory_upsert(self, entry: dict) -> dict:
        """POST /v1/memories → {id, action:'created'|'updated'}（幂等 upsert）。
        entry: {repo, lens, what, when_expr, why, evidence:[...], source, status?}"""
        return self._request("POST", "/v1/memories", entry)

    def memory_search(self, q: str, repo: str = "", lens: str = "", top_k: int = 5) -> dict:
        """POST /v1/memories/search → {hits:[{id,what,when_expr,why,lens,repo,score}], ms}"""
        body: dict = {"q": q, "top_k": top_k}
        if repo:
            body["repo"] = repo
        if lens:
            body["lens"] = lens
        return self._request("POST", "/v1/memories/search", body)

    def memory_get(self, mem_id: str) -> dict:
        """GET /v1/memories/{id} → 条目或 404（404 抛 PipelineClientError）。"""
        return self._request("GET", f"/v1/memories/{mem_id}")

    def memory_list(self, repo: str = "", lens: str = "", status: str = "",
                    q: str = "", limit: int = 50, offset: int = 0) -> dict:
        """GET /v1/memories?... → {items, total}"""
        params = [f"limit={limit}", f"offset={offset}"]
        for key, val in (("repo", repo), ("lens", lens), ("status", status), ("q", q)):
            if val:
                from urllib.parse import quote
                params.append(f"{key}={quote(str(val))}")
        return self._request("GET", "/v1/memories?" + "&".join(params))

    def memory_hit(self, mem_id: str, adopted: bool | None = None) -> dict:
        """POST /v1/memories/{id}/hit → {stats_hits, stats_adopted}"""
        body = {}
        if adopted is not None:
            body["adopted"] = adopted
        return self._request("POST", f"/v1/memories/{mem_id}/hit", body)

    def memory_delete(self, mem_id: str) -> dict:
        """DELETE /v1/memories/{id} → 软删（status=retired）"""
        return self._request("DELETE", f"/v1/memories/{mem_id}")

    def memory_conflicts(self) -> dict:
        """GET /v1/memories/conflicts → status=conflicting 的条目"""
        return self._request("GET", "/v1/memories/conflicts")

    def memory_resolve(self, mem_id: str, status: str) -> dict:
        """POST /v1/memories/{id}/resolve {status:'active'|'retired'}"""
        return self._request("POST", f"/v1/memories/{mem_id}/resolve", {"status": status})

    def memory_link_conflict(self, conflicting_id: str, origin_id: str,
                             trigger_words: list[str] | None = None) -> dict:
        """POST /v1/memories/link-conflict：冲突配对双写（against_id 互指 + 触发词对）。"""
        body: dict = {"conflicting_id": conflicting_id, "origin_id": origin_id}
        if trigger_words:
            body["trigger_words"] = trigger_words
        return self._request("POST", "/v1/memories/link-conflict", body)

    def report_run(self, payload: dict) -> dict:
        """POST /v1/admin/pipeline-runs：跑批留痕上报（admin 鉴权）。

        需 PIPE_ADMIN_USER/PIPE_ADMIN_PASSWORD env；缺失时抛 PipelineClientError
        （调用方 pipeline.py 捕获后跳过并打印说明）。
        """
        creds = admin_basic_auth()
        if creds is None:
            raise PipelineClientError(
                "report_run skipped: PIPE_ADMIN_USER/PIPE_ADMIN_PASSWORD not set")
        return self._request("POST", "/v1/admin/pipeline-runs", payload, basic_auth=creds)


# ---------------- 测试替身（test_pipeline.py 与 dry-run 复用）----------------

class StubIndexClient:
    """内存版 index-server：实现与 IndexClient 相同的方法面。

    - known_symbols: 源码探索命中集合（不在集合内的类名/方法名 → 0 hits）
    - existing: 预置 memories 条目（dict 形状同服务端行），参与 memory_search 同向判定
    - calls: 请求日志 [(method, path, body)]，供断言
    """

    def __init__(self, known_symbols=None, existing=None, search_top_k_hit=None):
        self.known_symbols = set(known_symbols or [])
        self.existing: list[dict] = list(existing or [])
        self.calls: list[tuple] = []
        self._seq = 0
        # memory_search 返回前 N 条 existing（供 Merge 四判用例控制）
        self.search_top_k_hit = search_top_k_hit

    # ----- 内部 -----
    def _record(self, method, path, body=None):
        self.calls.append((method, path, body))

    def _match(self, item: dict, q: str) -> bool:
        hay = " ".join([item.get("what", ""), item.get("when_expr", ""), item.get("why", "")])
        return (not q) or any(w and w in hay for w in q.split())

    # ----- 源码探索 -----
    def code_search(self, query: str, namespace: str = "", k: int = 5) -> dict:
        self._record("POST", "/v1/search", {"query": query, "k": k})
        # 归一：取 query 中的代码 token（去掉 AND/OR 等操作符词）
        tokens = [t for t in query.replace("(", " ").replace(")", " ").split()
                  if t and t.upper() not in ("AND", "OR", "NOT")]
        hits = []
        for tok in tokens:
            if tok in self.known_symbols:
                hits.append({"path": f"src/{tok}.java", "start": 1, "end": 10,
                             "symbol": tok, "namespace": namespace or "stub", "score": 1.0})
        return {"hits": hits[:k], "ms": {"total": 1.0}, "coverage": 1.0}

    # ----- memories -----
    def memory_upsert(self, entry: dict) -> dict:
        self._record("POST", "/v1/memories", entry)
        what = entry.get("when_expr") and entry
        # 同向重复的幂等：what 完全一致 → updated
        for item in self.existing:
            if item.get("what") == entry.get("what"):
                item.update({k: v for k, v in entry.items() if k not in ("id",)})
                return {"id": item["id"], "action": "updated"}
        self._seq += 1
        new_id = f"exp-{self._seq:06d}"
        row = dict(entry)
        row["id"] = new_id
        row.setdefault("status", "active")
        row.setdefault("stats_hits", 0)
        self.existing.append(row)
        return {"id": new_id, "action": "created"}

    def memory_search(self, q: str, repo: str = "", lens: str = "", top_k: int = 5) -> dict:
        self._record("POST", "/v1/memories/search", {"q": q, "repo": repo, "lens": lens, "top_k": top_k})
        hits = []
        for item in self.existing:
            if repo and item.get("repo") != repo:
                continue
            if lens and item.get("lens") != lens:
                continue
            if not self._match(item, q):
                continue
            hits.append({"id": item["id"], "what": item.get("what", ""),
                         "when_expr": item.get("when_expr", ""), "why": item.get("why", ""),
                         "lens": item.get("lens", ""), "repo": item.get("repo", ""), "score": 0.9})
        if self.search_top_k_hit is not None:
            hits = hits[: self.search_top_k_hit]
        return {"hits": hits[:top_k], "ms": 1.0}

    def memory_get(self, mem_id: str) -> dict:
        self._record("GET", f"/v1/memories/{mem_id}")
        for item in self.existing:
            if item["id"] == mem_id:
                return dict(item)
        raise PipelineClientError(f"GET /v1/memories/{mem_id} -> HTTP 404")

    def memory_list(self, repo: str = "", lens: str = "", status: str = "",
                    q: str = "", limit: int = 50, offset: int = 0) -> dict:
        self._record("GET", "/v1/memories")
        items = [dict(i) for i in self.existing
                 if (not repo or i.get("repo") == repo)
                 and (not lens or i.get("lens") == lens)
                 and (not status or i.get("status") == status)
                 and self._match(i, q)]
        return {"items": items[offset : offset + limit], "total": len(items)}

    def memory_hit(self, mem_id: str, adopted: bool | None = None) -> dict:
        self._record("POST", f"/v1/memories/{mem_id}/hit", {"adopted": adopted})
        for item in self.existing:
            if item["id"] == mem_id:
                item["stats_hits"] = item.get("stats_hits", 0) + 1
                if adopted:
                    item["stats_adopted"] = item.get("stats_adopted", 0) + 1
                return {"stats_hits": item["stats_hits"], "stats_adopted": item.get("stats_adopted", 0)}
        raise PipelineClientError(f"hit {mem_id}: not found")

    def memory_delete(self, mem_id: str) -> dict:
        self._record("DELETE", f"/v1/memories/{mem_id}")
        for item in self.existing:
            if item["id"] == mem_id:
                item["status"] = "retired"
                return {"deleted": True}
        return {"deleted": False}

    def memory_conflicts(self) -> dict:
        self._record("GET", "/v1/memories/conflicts")
        return {"items": [dict(i) for i in self.existing if i.get("status") == "conflicting"]}

    def memory_resolve(self, mem_id: str, status: str) -> dict:
        self._record("POST", f"/v1/memories/{mem_id}/resolve", {"status": status})
        for item in self.existing:
            if item["id"] == mem_id:
                item["status"] = status
                return {"id": mem_id, "status": status}
        raise PipelineClientError(f"resolve {mem_id}: not found")

    def memory_link_conflict(self, conflicting_id: str, origin_id: str,
                             trigger_words: list[str] | None = None) -> dict:
        self._record("POST", "/v1/memories/link-conflict",
                     {"conflicting_id": conflicting_id, "origin_id": origin_id,
                      "trigger_words": trigger_words})
        conf = next((i for i in self.existing if i["id"] == conflicting_id), None)
        origin = next((i for i in self.existing if i["id"] == origin_id), None)
        if not conf or not origin:
            raise PipelineClientError(f"link-conflict: unknown id ({conflicting_id}/{origin_id})")
        conf["against_id"] = origin_id
        origin["against_id"] = conflicting_id
        if trigger_words:
            conf["trigger_words"] = list(trigger_words)
        return {"id": conflicting_id, "against_id": origin_id, "linked": True}

    def report_run(self, payload: dict) -> dict:
        self._record("POST", "/v1/admin/pipeline-runs", payload)
        return {"run_id": payload.get("run_id", ""), "recorded": True}
