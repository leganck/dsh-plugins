# -*- coding: utf-8 -*-
"""验证 reconcile：本地起服务，造一个 scope + 块（无向量），断言 reconcile 把 scope 入队。

前提：FAKE_EMBED=1 时嵌入是假的，但 governor 仍会跑并写向量 → 可断言 pending 归零。
"""
import io
import json
import os
import sys
import tempfile
import threading
import time
import urllib.request

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, APP)

TMP = tempfile.mkdtemp(prefix="ci-reconcile-")
os.environ.update(
    FAKE_EMBED="1",
    WARMUP="0",
    SERVER_DB=os.path.join(TMP, "index.db"),
    SERVER_LOG=os.path.join(TMP, "server.log"),
    SERVER_ADMIN_DB=os.path.join(TMP, "admin.db"),
    API_KEY="k",
    EMBED_RATE="200",
    EMBED_BATCH="8",
)
import server  # noqa: E402

fails = []


def check(desc, ok, detail=""):
    print(("  ✅ " if ok else "  ❌ ") + desc + ("" if ok else f"  — {detail}"))
    if not ok:
        fails.append(desc)


server.build()
srv = server.make_server(0)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}"


def post(path, payload):
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
                                headers={"Content-Type": "application/json",
                                         "Authorization": "Bearer k"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


NS = "abc123def456@deadbeef#main:default"
print("\n[1] 造 scope + 3 块（无向量）")
st = server.store
st.register_scope(NS, "main", "default")
st.set_tag(NS, "old-model-0000old-fp16")  # 模拟「上一次同步用的是旧模型」
st.put_chunks(NS, [{"hash": "h1", "body": "body one"}, {"hash": "h2", "body": "body two"},
                   {"hash": "h3", "body": "body three"}])
# 清单（chunks 表）由 sync 的 manifest 路径写；测试里直接落，等价于一次完整 sync
sid = st._scope_id(NS)
with st.lock:
    for path, a, b, h in (("a.py", 1, 10, "h1"), ("a.py", 11, 20, "h2"), ("b.py", 1, 5, "h3")):
        st.db.execute(
            "insert into chunks(scope_id, path, start_line, end_line, hash) values (?,?,?,?,?)",
            (sid, path, a, b, h),
        )
    st.db.commit()
    st._invalidate()
tag = (server.state.get("info") or {}).get("tag") or ""
pending_before = st.pending_count(NS, tag)
check("块已入库且尚无向量（pending=3）", pending_before == 3, pending_before)

print("\n[2] POST /v1/admin/embed/reconcile")
code, body = post("/v1/admin/embed/reconcile", {})
check("返回 200 且 ok=true", code == 200 and body.get("ok") is True, (code, body))
check("被 kick 的 scope 含本 scope", NS in (body.get("kicked") or []), body.get("kicked"))
check("reconcile 先把 scope retag 到当前模型", body.get("retagged") == 1, body.get("retagged"))
check("scope.tag 已等于当前模型 tag", st.scope(NS)["tag"] == tag, st.scope(NS)["tag"])
check("pending 计数 >0", (body.get("pending") or 0) >= 3, body.get("pending"))

print("\n[3] 等 governor 落向量")
done = False
for _ in range(60):
    time.sleep(0.5)
    if st.pending_count(NS, tag) == 0:
        done = True
        break
check("governor 已补齐向量（pending→0）", done, st.pending_count(NS, tag))

print("\n[4] 再跑一次：无缺失时 kicked 为空")
code, body2 = post("/v1/admin/embed/reconcile", {})
check("第二次 reconcile 无事可做", code == 200 and (body2.get("kicked") or []) == [], body2)

srv.shutdown()
print()
if fails:
    print(f"❌ 失败 {len(fails)} 项")
    sys.exit(1)
print("✅ 全绿")
