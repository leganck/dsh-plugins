"""HTTP 入口（标准库 ThreadingHTTPServer，与 code-index-service 同风格）。

路由：
  GET  /healthz          存活 + 队列深度 + 最近任务
  GET  /metrics          Prometheus 文本
  POST /webhook          GitLab webhook（10 秒内必须返回，只入队不干活）
  GET  /admin/jobs       最近任务
  POST /admin/requeue    {job_id} 重新排队

档3：merge/close 事件不再入队，而是 best-effort 删除该 MR 的临时 PR 作用域
（`POST /v1/scopes/resolve` → `DELETE /v1/scopes/{ns}`，2s 超时，失败只记日志）。
"""

from __future__ import annotations

import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import __version__
from .clients import IndexClient
from .config import AppConfig
from .store import Store
from .util import dump, env_str, log

# 档3：MR 生命周期结束事件 → 清理临时 PR 作用域
PR_CLEANUP_ACTIONS = ("merge", "close")
CLEANUP_TIMEOUT_S = 2.0


class AppState:
    def __init__(self, cfg: AppConfig, store: Store):
        self.cfg = cfg
        self.store = store
        self.started_at = 0.0


# ---------------------------------------------------------------- 档3：PR 作用域清理


def cleanup_pr_scope(
    cfg: AppConfig,
    project_id,
    iid: int,
    *,
    client=None,
    timeout: float = CLEANUP_TIMEOUT_S,
) -> dict:
    """MR 合并/关闭后清理该 MR 的临时 PR 作用域（best-effort，永不抛异常）。

    review 侧不实现 canonical namespace：先 `POST /v1/scopes/resolve` 拿服务端
    namespace，再 `DELETE /v1/scopes/{ns}`（契约 §4）。2s 超时；任何失败只记日志，
    不影响 webhook 返回（GitLab 重投比漏删更糟，janitor 还会兜底 TTL）。
    """
    result: dict = {"attempted": False, "skipped": "", "namespace": "", "deleted": False}
    mode = getattr(cfg, "index_scope_mode", "repo")
    if mode != "pr":
        result["skipped"] = f"scope-mode={mode}"
        return result
    if not cfg.index_url:
        result["skipped"] = "no-index-url"
        return result
    result["attempted"] = True
    repo_id = f"{cfg.index_repo_prefix}-{project_id}"
    try:
        cli = client or IndexClient(cfg.index_url, cfg.index_api_key, timeout=timeout)
        data = cli.resolve_scope(repo_id, cfg.index_chunk_fp, "pr", str(int(iid)), timeout=timeout)
        namespace = str((data or {}).get("namespace") or "")
        if not namespace:
            result["skipped"] = "resolve-failed"
            log(f"合并/关闭清理：解析 PR 作用域失败（忽略）：project={project_id} !{iid}")
            return result
        result["namespace"] = namespace
        resp = cli.delete_scope(namespace, timeout=timeout) or {}
        result["deleted"] = bool(resp.get("deleted"))
        if "chunks" in resp:
            result["chunks"] = resp.get("chunks")
        log(f"合并/关闭清理：DELETE {namespace} → deleted={result['deleted']} chunks={result.get('chunks', 0)}")
    except Exception as e:  # noqa: BLE001 —— best-effort：清理失败不能拖垮 webhook
        result["error"] = f"{type(e).__name__}: {e}"
        log(f"合并/关闭清理失败（忽略）：{result['error']}")
    return result


def process_webhook(cfg: AppConfig, store: Store, body: dict, *, cleanup=cleanup_pr_scope, log_fn=log) -> tuple[int, dict]:
    """webhook 业务路由（与 HTTP 解耦，便于离线自测）。返回 (status, payload)。

    未知 action / 非 MR 事件一律 200（否则 GitLab 会标记 webhook 失败并反复重投）。
    """
    kind = body.get("object_kind") or ""
    if kind != "merge_request":
        return 200, {"ignored": True, "object_kind": kind}

    attrs = body.get("object_attributes") or {}
    action = str(attrs.get("action") or "")
    project = body.get("project") or {}
    project_id = project.get("id") or attrs.get("target_project_id")
    iid = attrs.get("iid")

    # 合并/关闭：MR 结束 → 清理临时 PR 作用域（幂等；失败只记日志）
    if action in PR_CLEANUP_ACTIONS:
        if not project_id or not iid:
            return 200, {"ignored": True, "action": action, "reason": "missing project/iid"}
        summary = cleanup(cfg, project_id, int(iid))
        return 200, {"ok": True, "action": action, "scope_cleanup": summary}

    if action not in ("open", "reopen", "update", "approved"):
        return 200, {"ignored": True, "action": action}
    # update 事件只有真的改了代码才有 oldrev；纯改标题/标签不触发评审
    if action == "update" and not attrs.get("oldrev"):
        return 200, {"ignored": True, "reason": "no code change"}
    if not project_id or not iid:
        return 400, {"error": "missing project/iid"}

    head_sha = str((attrs.get("last_commit") or {}).get("id") or "")
    # webhook 入队时还没有 diff 指纹，先用 head_sha 占位；worker 会回填内容指纹
    fp = f"head:{head_sha}" if head_sha else f"iid:{iid}"
    job_id, created = store.enqueue(
        project_id=str(project_id),
        mr_iid=int(iid),
        head_sha=str(head_sha),
        diff_fp=fp,
        dry_run=bool(cfg.dry_run),
    )
    log_fn(f"webhook 入队 job #{job_id}（project={project_id} MR !{iid} action={action} created={created}）")
    return 202, {"job_id": job_id, "created": created, "action": action}


class Handler(BaseHTTPRequestHandler):
    server_version = f"dsh-review/{__version__}"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ 基础

    @property
    def app(self) -> AppState:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        log(f"{self.address_string()} {fmt % args}")

    def _send(self, code: int, payload, content_type: str = "application/json; charset=utf-8") -> None:
        body = payload.encode("utf-8") if isinstance(payload, str) else dump(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 8 * 1024 * 1024:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}

    def _authorized(self, header: str) -> bool:
        secret = self.app.cfg.webhook_secret
        if not secret:
            return False
        return hmac.compare_digest((header or "").encode(), secret.encode())

    # ------------------------------------------------------------ 路由

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/", "/healthz"):
            stats = self.app.store.queue_stats()
            return self._send(
                200,
                {
                    "ok": True,
                    "version": __version__,
                    "dry_run": self.app.cfg.dry_run,
                    "queue": stats,
                    "last_jobs": self.app.store.last_jobs(5),
                    "uptime_s": round(__import__("time").time() - self.app.started_at, 1),
                },
            )
        if path == "/metrics":
            return self._send(200, self._metrics(), "text/plain; version=0.0.4; charset=utf-8")
        if path == "/admin/jobs":
            return self._send(200, {"jobs": self.app.store.last_jobs(50)})
        return self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/webhook":
            return self._webhook()
        if path == "/admin/requeue":
            body = self._read_json()
            try:
                job_id = int(body.get("job_id"))
            except (TypeError, ValueError):
                return self._send(400, {"error": "job_id required"})
            ok = self.app.store.requeue(job_id)
            return self._send(200 if ok else 404, {"ok": ok, "job_id": job_id})
        return self._send(404, {"error": "not found"})

    # ------------------------------------------------------------ webhook

    def _webhook(self) -> None:
        token = self.headers.get("X-Gitlab-Token") or ""
        if not self._authorized(token):
            log("webhook 鉴权失败（X-Gitlab-Token 不匹配）")
            return self._send(401, {"error": "invalid webhook token"})
        body = self._read_json()
        code, payload = process_webhook(self.app.cfg, self.app.store, body)
        return self._send(code, payload)

    # ------------------------------------------------------------ metrics

    def _metrics(self) -> str:
        stats = self.app.store.queue_stats()
        lines = [f"# HELP dsh_review_jobs 任务数（按状态）", "# TYPE dsh_review_jobs gauge"]
        for k, v in sorted(stats.items()):
            lines.append(f'dsh_review_jobs{{status="{k}"}} {v}')
        total = sum(stats.values())
        lines.append(f'dsh_review_jobs{{status="total"}} {total}')
        lines.append("# HELP dsh_review_up 服务存活")
        lines.append("# TYPE dsh_review_up gauge")
        lines.append("dsh_review_up 1")
        return "\n".join(lines) + "\n"


def serve(cfg: AppConfig, store: Store, bind: str, port: int) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((bind, port), Handler)
    httpd.app = AppState(cfg, store)  # type: ignore[attr-defined]
    import time

    httpd.app.started_at = time.time()  # type: ignore[attr-defined]
    log(f"监听 http://{bind}:{port}（webhook: POST /webhook）")
    return httpd


def webhook_secret_hint() -> str:
    return env_str("WEBHOOK_SECRET", "")


__all__ = [
    "AppState",
    "Handler",
    "serve",
    "webhook_secret_hint",
    "cleanup_pr_scope",
    "process_webhook",
    "PR_CLEANUP_ACTIONS",
    "CLEANUP_TIMEOUT_S",
]
