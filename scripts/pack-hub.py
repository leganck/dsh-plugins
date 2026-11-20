# -*- coding: utf-8 -*-
"""打包 server/storage-hub（排除缓存/out/models）→ 上传 112 供重建镜像。"""
import os
import tarfile

SRC = r"D:\Code\dsh-plugins-github\server\storage-hub"
OUT = r"D:\Code\dsh-plugins-github\out\hub-src.tgz"
SKIP_DIRS = {"__pycache__", "out", ".pytest_cache", "models"}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
n = 0
with tarfile.open(OUT, "w:gz") as tf:
    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.endswith((".pyc", ".pyo")):
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, SRC)
            tf.add(full, arcname="storage-hub/" + rel.replace("\\", "/"))
            n += 1
print(f"  {n} 文件 → {os.path.getsize(OUT)} B")
