"""HTTP 入口（标准库 ThreadingHTTPServer，与 code-index-service 同风格）。

路由：
  GET  /healthz          存活 + 队列深度 + 最近任务
  GET  /metrics          Prometheus 文本
  POST /webhook          GitLab webhook（10 秒内必须返回，只入队不干活）
  GET  /admin/jobs       最近任务
  POST /admin/requeue    {job_id} 重新排队
"""

from __future__ import annotations

import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import __version__
from .config import AppConfig
from .store import Store
from .util import dump, env_str, log


class AppState:
    def __init__(self, cfg: AppConfig, store: Store):
        self.cfg = cfg
        self.store = store
        self.started_at = 0.0


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
        kind = body.get("object_kind") or ""
        if kind != "merge_request":
            # note/issue 等事件先忽略，但必须 200，否则 GitLab 会标记 webhook 失败并重投
            return self._send(200, {"ignored": True, "object_kind": kind})

        attrs = body.get("object_attributes") or {}
        action = str(attrs.get("action") or "")
        if action not in ("open", "reopen", "update", "approved"):
            return self._send(200, {"ignored": True, "action": action})
        # update 事件只有真的改了代码才有 oldrev；纯改标题/标签不触发评审
        if action == "update" and not attrs.get("oldrev"):
            return self._send(200, {"ignored": True, "reason": "no code change"})

        project = body.get("project") or {}
        project_id = project.get("id") or attrs.get("target_project_id")
        iid = attrs.get("iid")
        if not project_id or not iid:
            return self._send(400, {"error": "missing project/iid"})

        head_sha = str((attrs.get("last_commit") or {}).get("id") or "")
        # webhook 入队时还没有 diff 指纹，先用 head_sha 占位；worker 会回填内容指纹
        fp = f"head:{head_sha}" if head_sha else f"iid:{iid}"
        job_id, created = self.app.store.enqueue(
            project_id=str(project_id),
            mr_iid=int(iid),
            head_sha=str(head_sha),
            diff_fp=fp,
            dry_run=bool(self.app.cfg.dry_run),
        )
        log(f"webhook 入队 job #{job_id}（project={project_id} MR !{iid} action={action} created={created}）")
        return self._send(202, {"job_id": job_id, "created": created, "action": action})

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


__all__ = ["AppState", "Handler", "serve", "webhook_secret_hint"]
