"""模型下载器：从 Release 资产（或任意 HTTP 目录）下载模型到本地，支持进度 / 续传 / 校验 / 重试。

设计要点：
- **白名单式目录**：只允许 `MODELS` 里预置的模型；不接受任意 URL（避免后台变成 SSRF 跳板）。
- **后台线程**：HTTP 请求随时返回进度，不阻塞服务；进度状态在内存里，进程重启后按"文件是否存在 + sha256"重新判定。
- **可恢复**：下载写 `<file>.part`，失败/取消后再点一次会带 Range 续传；sha256 不符自动重下。
- **可重传**：`force=True` 删掉已下载文件从头再来。
- 存储位置：`<DATA_DIR>/models/<dir>/`（/data 卷内，容器重启不丢）。

后台页面通过 `/v1/admin/models*` 接口调用；本模块不依赖 server.py，可单测。
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.request

# 预置模型目录（新增模型在这里加一项即可；也可以由 MODEL_CATALOG 指向的 JSON 覆盖/扩展）
DEFAULT_CATALOG = {
    "jina-v2-base-code": {
        "label": "jina-embeddings-v2-base-code（代码检索，Apache-2.0，768 维）",
        "dir": "model-jina",
        "release": "https://github.com/leganck/dsh-plugins/releases/download/dsh-embed-jina-v0.1.0",
        "files": {
            "model_fp16.onnx": "0b8988c2076a5ca27e10192b8c7abff7c907a77d9ceb4f2947368d0a0baeb872",
            "tokenizer.json": "b01c78a902aa4facb2f47f95449f48e2f7bbfea5d2472ee2f6ce92323c6f86e5",
            "config.json": "e426aa684c7f9a95c5f020aa855faf93a24f065f5fad0c9e17b124670cabdea6",
            "tokenizer_config.json": "f477aeb15ff9f78d3c1ddf2361d2b0b8b20cf55220f839f29a37f3a18efddd89",
            "special_tokens_map.json": "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
        },
        # 下载完成后如何启用（页面里展示；切换后向量 tag 变化 = 客户端会全量重嵌）
        "enable": {
            "MODEL_DIR": "（把下面的绝对路径填进来）",
            "MODEL_NAME": "jina-embeddings-v2-base-code",
            "POOLING": "auto",
            "QUERY_PREFIX": "",
            "PAD_TOKEN": "<pad>",
            "PAD_ID": "1",
            "SEP_ID": "0",
        },
        "note": "启用后向量 tag 会变（jina-…-fp16），客户端会全量重嵌；建议先 purge 旧 tag。",
    },
}


def load_catalog(path: str | None = None) -> dict:
    """默认目录 + 可选 JSON 覆盖（文件里同名字段整体替换）。"""
    catalog = json.loads(json.dumps(DEFAULT_CATALOG))
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            extra = json.load(f)
        if isinstance(extra, dict):
            for name, item in extra.items():
                if isinstance(item, dict):
                    catalog[name] = {**catalog.get(name, {}), **item}
    return catalog


class ModelDownloader:
    def __init__(self, root: str, catalog: dict | None = None, *, timeout: float = 60.0):
        self.root = os.path.abspath(root)
        os.makedirs(self.root, exist_ok=True)
        self.catalog = catalog or load_catalog(os.environ.get("MODEL_CATALOG"))
        self.timeout = timeout
        self._lock = threading.Lock()
        self._states: dict[str, dict] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}
        for name in self.catalog:
            self._states[name] = self._initial(name)

    # ------------------------------------------------------------ 公共接口

    def list(self) -> list[dict]:
        with self._lock:
            names = list(self._states)
        return [self.get(n) for n in names]

    def get(self, name: str) -> dict:
        if name not in self.catalog:
            raise KeyError(f"unknown model: {name}")
        with self._lock:
            st = self._states[name]
            st["files"] = self._scan_files(name)
            out = json.loads(json.dumps({k: v for k, v in st.items() if k != "cancel"}))
        out["name"] = name
        out["label"] = self.catalog[name].get("label", name)
        out["dir"] = self.catalog[name].get("dir", name)
        out["target"] = os.path.join(self.root, out["dir"])
        out["enable"] = dict(self.catalog[name].get("enable") or {})
        out["note"] = self.catalog[name].get("note", "")
        # 就绪判定：所有文件存在且 sha256 一致
        files = out["files"]
        out["ready"] = bool(files) and all(f.get("ok") for f in files)
        out["retryable"] = out["status"] in ("failed", "cancelled") or (out["status"] == "idle" and not out["ready"])
        return out

    def start(self, name: str, *, force: bool = False) -> dict:
        if name not in self.catalog:
            raise KeyError(f"unknown model: {name}")
        with self._lock:
            st = self._states[name]
            if st["status"] in ("downloading", "verifying"):
                return self.get(name)
            st.update(status="downloading", error=None, startedAt=time.time(), finishedAt=None,
                      bytesDone=0, bytesTotal=0, speedBps=0, message="准备中")
            self._cancel[name] = threading.Event()
            cancel = self._cancel[name]
        t = threading.Thread(target=self._run, args=(name, force, cancel), name=f"model-dl-{name}", daemon=True)
        self._threads[name] = t
        t.start()
        return self.get(name)

    def cancel(self, name: str) -> dict:
        with self._lock:
            ev = self._cancel.get(name)
        if ev:
            ev.set()
        return self.get(name)

    def wait(self, name: str, timeout: float = 60.0) -> dict:
        """测试/CLI 用：等下载结束（完成/失败/取消）。"""
        t = self._threads.get(name)
        if t:
            t.join(timeout=timeout)
        return self.get(name)

    # ------------------------------------------------------------ 内部实现

    def _initial(self, name: str) -> dict:
        return {
            "status": "idle", "bytesDone": 0, "bytesTotal": 0, "speedBps": 0,
            "error": None, "message": "未下载", "startedAt": None, "finishedAt": None,
            "files": [],
        }

    def _scan_files(self, name: str) -> list[dict]:
        spec = self.catalog[name]
        target = os.path.join(self.root, spec.get("dir", name))
        out = []
        for fname, sha in (spec.get("files") or {}).items():
            path = os.path.join(target, fname)
            size = os.path.getsize(path) if os.path.exists(path) else 0
            ok = False
            if size > 0:
                try:
                    ok = _sha256(path) == sha
                except OSError:
                    ok = False
            out.append({"name": fname, "sha256": sha, "size": size, "ok": ok})
        return out

    def _set(self, name: str, **kw) -> None:
        with self._lock:
            self._states[name].update(kw)

    def _run(self, name: str, force: bool, cancel: threading.Event) -> None:
        spec = self.catalog[name]
        target = os.path.join(self.root, spec.get("dir", name))
        os.makedirs(target, exist_ok=True)
        files = spec.get("files") or {}
        base = str(spec.get("release") or "").rstrip("/") + "/"
        t0 = time.time()
        done = 0
        total = 0

        # 先 HEAD 拿总大小（失败不致命：进度显示为未知总量）
        sizes: dict[str, int] = {}
        for fname in files:
            try:
                sizes[fname] = _http_size(base + fname, self.timeout)
            except Exception:  # noqa: BLE001
                sizes[fname] = 0
        total = sum(sizes.values())
        self._set(name, bytesTotal=total, message="开始下载")

        ok_files = skipped = 0
        for fname, sha in files.items():
            if cancel.is_set():
                self._set(name, status="cancelled", message="已取消", finishedAt=time.time())
                return
            dest = os.path.join(target, fname)
            part = dest + ".part"
            if os.path.exists(dest):
                if not force and _sha256(dest) == sha:
                    done += os.path.getsize(dest)
                    skipped += 1
                    ok_files += 1
                    self._set(name, bytesDone=done, message=f"{fname} 已存在")
                    continue
                os.remove(dest)
            if force and os.path.exists(part):
                os.remove(part)

            try:
                got = _download(base + fname, part, cancel,
                                on_progress=lambda n, fn=fname: self._progress(name, done + n, total, t0, fn))
            except _Cancelled:
                self._set(name, status="cancelled", message="已取消", finishedAt=time.time())
                return
            except Exception as e:  # noqa: BLE001
                self._set(name, status="failed", error=f"{fname}: {type(e).__name__}: {e}",
                          message="下载失败", finishedAt=time.time())
                return
            if _sha256(part) != sha:
                try:
                    os.remove(part)
                except OSError:
                    pass
                self._set(name, status="failed", error=f"{fname}: sha256 校验失败（可能下载不完整，可重试）",
                          message="校验失败", finishedAt=time.time())
                return
            os.replace(part, dest)
            done += got
            ok_files += 1
            self._set(name, bytesDone=done, message=f"{fname} 完成")

        self._set(name, status="done" if ok_files == len(files) else "failed",
                  bytesDone=done, bytesTotal=total or done, speedBps=int(done / max(time.time() - t0, 1e-6)),
                  finishedAt=time.time(),
                  message=f"完成（跳过已存在 {skipped} 个）" if skipped else "完成")

    def _progress(self, name: str, done: int, total: int, t0: float, fname: str) -> None:
        speed = int(done / max(time.time() - t0, 1e-6))
        self._set(name, bytesDone=done, speedBps=speed, message=f"下载中：{fname}")


class _Cancelled(Exception):
    pass


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _http_size(url: str, timeout: float) -> int:
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return int(r.headers.get("Content-Length") or 0)


def _download(url: str, dest: str, cancel: threading.Event, on_progress=None, chunk_size: int = 1 << 20) -> int:
    """下载到 dest；若 dest 已存在则带 Range 续传。返回本次写入字节数。"""
    start = os.path.getsize(dest) if os.path.exists(dest) else 0
    headers = {"Range": f"bytes={start}-"} if start else {}
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        if start and e.code == 416:  # 已完整下载
            return 0
        raise
    written = 0
    # 服务端若不支持 Range（返回 200），必须从头写；否则会把整文件追加到 .part 后面
    if start and getattr(resp, "status", 200) != 206:
        start = 0
    mode = "ab" if start else "wb"
    try:
        with open(dest, mode) as f:
            while True:
                if cancel.is_set():
                    raise _Cancelled()
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                written += len(chunk)
                if on_progress:
                    on_progress(start + written)
    finally:
        resp.close()
    return written


__all__ = ["ModelDownloader", "DEFAULT_CATALOG", "load_catalog"]
