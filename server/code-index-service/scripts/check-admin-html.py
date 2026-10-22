#!/usr/bin/env python3
"""校验内联页面脚本：从 server.py 的运行时字符串抽 <script>，用 node --check 检查语法。

为什么需要：ADMIN_HTML/LOGIN_HTML 是 Python 三引号字符串，JS 里的 `\n` 会被 Python 解释成真换行，
浏览器会整段脚本语法错误（页面全空），而 Python 自身完全看不出问题（2026-10-22 踩过）。
CI 里 node 可用；本地没 node 时跳过（只提示）。
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
os.environ.setdefault("FAKE_EMBED", "1")
os.environ.setdefault("SERVER_DB", os.path.join(tempfile.mkdtemp(prefix="htmlcheck-"), "index.db"))
os.environ.setdefault("SERVER_LOG", os.path.join(tempfile.mkdtemp(prefix="htmlcheck-"), "server.log"))
os.environ.setdefault("SERVER_ADMIN_DB", os.path.join(tempfile.mkdtemp(prefix="htmlcheck-"), "admin.db"))

import server  # noqa: E402


def scripts_of(html: str):
    return re.findall(r"<script>(.*?)</script>", html, re.S)


def main() -> int:
    node = shutil.which("node")
    if not node:
        print("skip: 没有 node（本地可跳过；CI 的 JS job 会跑这个脚本）")
        return 0
    tmp = tempfile.mkdtemp(prefix="htmlcheck-")
    failures = 0
    for name, html in (("ADMIN_HTML", server.ADMIN_HTML), ("LOGIN_HTML", server.LOGIN_HTML)):
        for i, js in enumerate(scripts_of(html)):
            path = os.path.join(tmp, f"{name}_{i}.js")
            with open(path, "w", encoding="utf-8") as f:
                f.write(js)
            r = subprocess.run([node, "--check", path], capture_output=True, text=True)
            if r.returncode:
                failures += 1
                print(f"FAIL {name} script#{i}:")
                print((r.stderr or "").strip()[:800])
            else:
                print(f"ok   {name} script#{i} ({len(js)} bytes)")
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
