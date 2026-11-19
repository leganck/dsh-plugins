"""经验提纯管道：共享小工具（无第三方依赖，stdlib + 可选 numpy）。"""
from __future__ import annotations

import json
import re


def text_similarity(a: str, b: str) -> float:
    """字符 bigram Dice 相似度（0~1）。中文/代码标识符友好，禁桥接场景够用。"""
    a, b = (a or "").strip(), (b or "").strip()
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    ga, gb = set(), set()
    for s, out in ((a, ga), (b, gb)):
        u = " ".join(s.split())  # 归一空白，避免纯格式差异
        for i in range(len(u) - 1):
            out.add(u[i : i + 2])
    if not ga or not gb:
        return 1.0 if a == b else 0.0
    inter = len(ga & gb)
    return 2.0 * inter / (len(ga) + len(gb))


def norm(s: str) -> str:
    """文本归一：压空白。Dedup 相似度统一先过这层。"""
    return " ".join((s or "").split())


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def trunc(s: str, n: int = 200) -> str:
    s = s or ""
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"
