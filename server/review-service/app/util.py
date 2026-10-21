"""通用小工具：环境变量、日志、JSON、HTTP、哈希。

刻意不用第三方库：评审服务要和 code-index-service 一样"一个 python:3.11-slim 就能跑"。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

# ---------------------------------------------------------------- 日志


def log(msg: str) -> None:
    """结构化前缀日志：时间 | 模块 | 内容。stderr 输出，容器里 `docker logs` 直接看。"""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write(f"{ts} | {msg}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- 环境


def env_str(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return default if v is None else v


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def env_bool(name: str, default: bool = False) -> bool:
    v = (os.environ.get(name) or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


# ---------------------------------------------------------------- 哈希


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()


def sha1_bytes(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


# ---------------------------------------------------------------- JSON


def dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def loads(text: str) -> Any:
    return json.loads(text)


def extract_json_object(text: str) -> Any:
    """从模型输出里抠出第一个 JSON 对象/数组。

    模型即使被要求"只输出 JSON"，也常带 ```json 围栏或前后寒暄。这里：
      1. 去掉 ```json / ``` 围栏；
      2. 从第一个 '{' 或 '[' 起用括号配平扫描（跳过字符串内的括号与转义）；
      3. 解析失败抛 ValueError，由调用方决定"这条丢不丢"。
    """
    s = text.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        if nl >= 0:
            s = s[nl + 1 :]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    starts = [i for i in (s.find("{"), s.find("[")) if i >= 0]
    if not starts:
        raise ValueError("模型输出里没有 JSON")
    start = min(starts)
    opener = s[start]
    closer = "}" if opener == "{" else "]"
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return json.loads(s[start : i + 1])
    raise ValueError("JSON 括号不配平")


# ---------------------------------------------------------------- HTTP


class HttpError(Exception):
    """带状态码的 HTTP 错误。GitLab 的 400/422 要靠它做降级。"""

    def __init__(self, status: int, body: str, url: str = ""):
        self.status = status
        self.body = body
        self.url = url
        super().__init__(f"HTTP {status} {url}: {body[:300]}")


def http_request(
    method: str,
    url: str,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> tuple[int, bytes]:
    """最小 HTTP 客户端（urllib）。返回 (状态码, 响应体)；非 2xx 抛 HttpError。"""
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        raise HttpError(e.code, e.read().decode("utf-8", "replace"), url) from e
    except urllib.error.URLError as e:
        raise HttpError(0, str(e.reason), url) from e


def http_json(
    method: str,
    url: str,
    payload: Any | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> Any:
    hdrs = {"Content-Type": "application/json", **(headers or {})}
    body = None if payload is None else dump(payload).encode("utf-8")
    status, raw = http_request(method, url, body, hdrs, timeout)
    if not raw:
        return None
    return loads(raw.decode("utf-8", "replace"))


# ---------------------------------------------------------------- 重试


def retry(fn, attempts: int = 3, base_delay: float = 0.5, what: str = ""):
    """指数退避重试；只对 429/5xx/网络错误重试，4xx 其它立即抛。"""
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn()
        except HttpError as e:
            retriable = e.status == 0 or e.status == 429 or 500 <= e.status < 600
            last = e
            if not retriable or i == attempts - 1:
                raise
            delay = base_delay * (2**i)
            log(f"重试 {what or '请求'}：HTTP {e.status}，{delay:.1f}s 后再试")
            time.sleep(delay)
    assert last is not None
    raise last
