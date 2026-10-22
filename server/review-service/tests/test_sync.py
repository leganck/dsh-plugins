"""索引同步客户端验收：用本地假服务端跑完整协议（sync → missing → chunks → embed）。

    python tests/test_sync.py

覆盖：
1. 首次同步走全量清单，服务端返回缺失 hash，客户端上传正文并触发嵌入；
2. 未变更时只发指纹+revision，服务端短线返回 unchanged；
3. revision 冲突（409）→ 客户端自动改走全量；
4. 内容变化后增量清单里出现新块。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:  # Windows 控制台默认 GBK：统一改成 UTF-8，避免中文/emoji 输出崩
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


from app.sync import IndexSync  # noqa: E402

PASS = 0
FAILS: list[str] = []


def check(label: str, cond, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  [ok] {label}")
    else:
        FAILS.append(label)
        print(f"  [FAIL] {label}" + (f" —— {detail}" if detail else ""))


class FakeServer:
    def __init__(self) -> None:
        self.state: dict[str, dict] = {}
        self.bodies: set[str] = set()
        self.calls: list[tuple[str, dict]] = []
        self.conflict_once = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # noqa: A003
                pass

            def _send(self, code: int, payload: dict) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(n) or b"{}")
                outer.calls.append((self.path, payload))
                parts = self.path.strip("/").split("/")
                if self.path == "/v1/namespaces/sync":
                    ns = payload.get("namespace") or f"{payload.get('repoId')}@{payload.get('chunkFp')}#main:default"
                    action = "sync"
                    st = outer.state.setdefault(ns, {"revision": 0, "repo_state": "", "chunks": 0})
                elif len(parts) >= 4 and parts[0] == "v1" and parts[1] == "namespaces":
                    import urllib.parse
                    ns = urllib.parse.unquote(parts[2])
                    action = parts[-1]
                    st = outer.state.setdefault(ns, {"revision": 0, "repo_state": "", "chunks": 0})
                else:
                    return self._send(404, {"error": "not found"})
                if action == "sync":
                    client_rev = payload.get("revision")
                    if outer.conflict_once and client_rev is not None and int(client_rev) != st["revision"]:
                        outer.conflict_once = False
                        return self._send(409, {"error": "revision-conflict", "revision": st["revision"]})
                    if payload.get("repoState") == st["repo_state"] and int(payload.get("chunkCount", -1)) == st["chunks"]:
                        return self._send(200, {"revision": st["revision"], "unchanged": True, "missing": [],
                                                "chunks": st["chunks"], "vectors": 0, "namespace": ns})
                    missing = []
                    for f in payload.get("upsert") or []:
                        for c in f.get("chunks") or []:
                            if c["hash"] not in outer.bodies:
                                missing.append(c["hash"])
                    st["repo_state"] = payload.get("repoState", "")
                    st["chunks"] = int(payload.get("chunkCount") or 0)
                    st["revision"] += 1
                    return self._send(200, {"revision": st["revision"], "unchanged": False,
                                            "missing": missing, "chunks": st["chunks"], "vectors": 0, "namespace": ns})
                if action == "chunks":
                    bodies = payload.get("bodies") or []
                    for b in bodies:
                        outer.bodies.add(b["hash"])
                    return self._send(200, {"accepted": len(bodies)})
                if action == "embed":
                    return self._send(200, {"ok": True})
                return self._send(404, {"error": "not found"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="sync-test-")
    wt = os.path.join(tmp, "repo")
    os.makedirs(wt)
    for name, body in (
        ("a.py", "def a():\n    return 1\n"),
        ("b.js", "export function b() {\n  return 2;\n}\n"),
        ("c.md", "# title\n\ntext\n"),
    ):
        with open(os.path.join(wt, name), "w", encoding="utf-8") as f:
            f.write(body)

    srv = FakeServer()
    url = f"http://127.0.0.1:{srv.port}"
    sync = IndexSync(url, "", timeout=5)
    try:
        res = sync.sync_worktree(wt, repo_id="repo-7", repo_url="", chunk_fp="review-1")
        check("1. 首次同步拿到 namespace/revision", res.namespace == "repo-7@review-1#main:default" and res.revision >= 1, str(res.as_dict()))
        check("2. 全量清单产生缺失 hash", res.missing > 0, str(res.missing))
        check("3. 正文上传成功", res.uploaded == res.missing, f"{res.uploaded} vs {res.missing}")
        check("4. 触发了嵌入", any(p.endswith("/embed") for p, _ in srv.calls))

        state = {"repo_state": res.repo_state, "revision": res.revision}
        res2 = sync.sync_worktree(wt, repo_id="repo-7", chunk_fp="review-1", tag=None, state=state)
        check("5. 未变更时服务端返回 unchanged", res2.unchanged is True, str(res2.as_dict()))
        check("5b. 未变更时不上传正文", res2.uploaded == 0 and res2.missing == 0)

        # 内容变化 → 出现新的 missing
        with open(os.path.join(wt, "a.py"), "a", encoding="utf-8") as f:
            f.write("\ndef a2():\n    return a() + 1\n")
        res3 = sync.sync_worktree(wt, repo_id="repo-7", chunk_fp="review-1", state={"repo_state": res2.repo_state, "revision": res2.revision})
        check("6. 内容变化后重新同步有新增块", res3.missing > 0 and res3.uploaded == res3.missing, str(res3.as_dict()))

        # revision 冲突 → 自动全量自愈
        with open(os.path.join(wt, "c.md"), "a", encoding="utf-8") as f:
            f.write("\nmore text\n")
        srv.conflict_once = True
        res4 = sync.sync_worktree(wt, repo_id="repo-7", chunk_fp="review-1", state={"repo_state": "stale", "revision": 999})
        check("7. revision 冲突自动改走全量", res4.revision >= 1 and res4.unchanged is False, str(res4.as_dict()))
    finally:
        srv.close()

    print(f"\n通过 {PASS}，失败 {len(FAILS)}")
    if FAILS:
        print("失败项：")
        for f in FAILS:
            print("  - " + f)
        return 1
    print("✅ sync 验收通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
