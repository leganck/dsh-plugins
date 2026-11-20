#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""守护测试：镜像 COPY 清单必须覆盖仓库里所有顶层 .py 与 scripts/。

背景（2026-11-20 实测踩到两次）：
  ① Dockerfile.app 漏 COPY scripts/ → 容器里 `python /app/scripts/cleanup-lineages.py` 打不开；
  ② 新增 exp_prompt/exp_llm/exp_pipeline 只在仓库、没进 COPY 清单 →
     镜像内 /v1/exp/extract 直接 500 `No module named 'exp_prompt'`。
两者都是"本地测试全绿、镜像里坏掉"的静默故障，用这条测试钉住。
"""
import io
import os
import re
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failures = []


def check(desc, ok, detail=""):
    print(("  ✅ " if ok else "  ❌ ") + desc + ("" if ok else f"  — {detail}"))
    if not ok:
        failures.append(desc)


TOP_PY = sorted(f for f in os.listdir(APP) if f.endswith(".py"))

for dockerfile in ("Dockerfile", "Dockerfile.app"):
    path = os.path.join(APP, dockerfile)
    if not os.path.exists(path):
        check(f"{dockerfile} 存在", False, "文件缺失")
        continue
    text = io.open(path, encoding="utf-8").read()
    copied = set(re.findall(r"([\w.]+\.py)", text))
    missing = [f for f in TOP_PY if f not in copied]
    check(f"{dockerfile} COPY 覆盖全部 {len(TOP_PY)} 个顶层 .py", not missing, ", ".join(missing))
    check(f"{dockerfile} COPY 了 scripts/ 目录", "scripts/ /app/scripts/" in text.replace("\r\n", "\n"),
          "缺 `COPY ... scripts/ /app/scripts/`")

# 反向检查：COPY 里提到的文件必须真实存在（删文件后忘改 COPY 会构建失败）
for dockerfile in ("Dockerfile", "Dockerfile.app"):
    path = os.path.join(APP, dockerfile)
    if not os.path.exists(path):
        continue
    text = io.open(path, encoding="utf-8").read().replace("\r\n", "\n")
    stale = []
    for m in re.finditer(r"COPY (?:--chown=[\d:]+ )?([^\n]+?) /app/", text):
        for token in m.group(1).split():
            if token.startswith("--"):
                continue
            if token.endswith("/"):          # 目录，跳过
                continue
            if not os.path.exists(os.path.join(APP, token)):
                stale.append(token)
    check(f"{dockerfile} 没有指向已删文件的 COPY 项", not stale, ", ".join(sorted(set(stale))))

print()
if failures:
    print(f"❌ 失败 {len(failures)} 项")
    sys.exit(1)
print("✅ 全绿")
