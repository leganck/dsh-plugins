#!/usr/bin/env python3
"""正文直读端点自测：`GET /v1/namespaces/{ns}/bodies?hashes=...&max_bytes=...`

不需要模型、不联网：临时 SQLite 造 1 个血统 + 3 个块正文 + 2 个 namespace，
然后分两层验证：

  ① 纯逻辑层：直接调 `server.bodies_payload()`，查解析/去重/64-hex 校验、
     命中/缺失/有界（max_bytes 很小时 truncated 非空、绝不返回半截正文）、
     未知 namespace、200 个上限、`_endpoint_group` 分组；
  ② 真实 HTTP 层：起一个 `http.server`（随机端口），验证路由已接、
     namespace 的 URL 解码（含 "/"、"#" 的 namespace 必须编码）、404 风格错误。

跑法（服务根目录或仓库根目录都行）：
    python tests/test_bodies.py

退出码 0 = 全绿。
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request

# Windows 控制台默认 GBK，打不出 ✅/❌ → 强制 UTF-8（与 selftest.py 同做法）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if APP not in sys.path:
    sys.path.insert(0, APP)

TMP = tempfile.mkdtemp(prefix="ci-bodies-test-")
# 必须先设 env 再 import server：DB/日志/admin 库都落在临时目录，不碰仓库里的 out/
os.environ.update(
    FAKE_EMBED="1",
    WARMUP="0",
    SERVER_DB=os.path.join(TMP, "index.db"),
    SERVER_LOG=os.path.join(TMP, "server.log"),
    SERVER_ADMIN_DB=os.path.join(TMP, "admin.db"),
)
for _k in ("API_KEY", "ADMIN_PASSWORD"):
    os.environ.pop(_k, None)  # 鉴权全空 = 开放（自测口径，与 selftest.py 一致）

import index_store as istore  # noqa: E402
import server  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"✅ {name}")
    else:
        FAIL += 1
        print(f"❌ {name}" + (f"  → {detail}" if detail else ""))


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- 夹具：临时库
B1 = "A" * 40      # 40 字节
B2 = "B" * 80      # 80 字节
B3 = "C" * 160     # 160 字节
H1, H2, H3 = sha(B1), sha(B2), sha(B3)
H_MISSING = sha("never-uploaded")
NS = istore.canonical_namespace("demo", "fp-bodies", "main", "default")
NS_SLASH = "team/demo@fp-bodies#branch:feature%x"  # 含 "/" 与 "#"：走 URL 编码
NS_UNKNOWN = istore.canonical_namespace("ghost", "fp-bodies", "main", "default")

st = istore.IndexStore(os.path.join(TMP, "index.db"))
LID = st.ensure_lineage("https://example.com/demo.git", "demo")
st.ensure_repo(NS, "demo", "fp-bodies", LID, tag="tag-bodies", repo_name="demo")
st.ensure_repo(NS_SLASH, "team/demo", "fp-bodies", LID, tag="tag-bodies",
               repo_name="team/demo")
st.put_chunks(NS, [
    {"hash": H1, "body": B1},
    {"hash": H2, "body": B2},
    {"hash": H3, "body": B3},
])
# 端点走模块级 store（HTTP 服务用的是同一个全局），这里直接注入
server.store = st
server.state["ready"] = True


def call(hashes=None, max_bytes=None, ns=NS):
    return server.bodies_payload(ns, hashes if hashes is not None else "", max_bytes)


# ---------------------------------------------------------------- ① 纯逻辑层
def test_logic():
    # 1) 命中 2 个 + missing 1 个：顺序、字段、合计都对
    payload, code = call(f"{H1},{H2},{H_MISSING}")
    check("命中2/missing1 → 200", code == 200, f"code={code} {payload}")
    check("namespace/lineage 回显", payload.get("namespace") == NS
          and payload.get("lineage_id") == LID, repr(payload)[:300])
    check("returned==2", payload.get("returned") == 2, repr(payload)[:300])
    check("requested==3", payload.get("requested") == 3, repr(payload)[:300])
    check("missing==[H_MISSING]", payload.get("missing") == [H_MISSING],
          repr(payload.get("missing")))
    check("truncated 为空", payload.get("truncated") == [], repr(payload.get("truncated")))
    check("rejected 为空", payload.get("rejected") == [], repr(payload.get("rejected")))
    check("bodies 顺序 == 请求顺序且正文原样",
          [b["hash"] for b in payload["bodies"]] == [H1, H2]
          and [b["body"] for b in payload["bodies"]] == [B1, B2],
          repr(payload["bodies"])[:300])
    check("有 ms 字段且 >= 0", isinstance(payload.get("ms"), (int, float))
          and payload["ms"] >= 0, repr(payload.get("ms")))
    check("不变量 requested==returned+missing+truncated",
          payload["requested"] == payload["returned"] + len(payload["missing"])
          + len(payload["truncated"]), repr(payload)[:300])

    # 2) 默认 max_bytes（200000）→ 3 个都装得下（总 280 字节）
    payload, code = call(",".join([H1, H2, H3]))
    check("默认 max_bytes → 3 个全返回",
          code == 200 and payload["returned"] == 3 and payload["truncated"] == [],
          repr(payload)[:300])

    # 3) max_bytes 很小 → truncated 非空，且绝不返回半截正文
    payload, code = call(",".join([H1, H2, H3]), "100")
    check("max_bytes=100 → returned 1 / truncated 2",
          code == 200 and payload["returned"] == 1
          and payload["truncated"] == [H2, H3], repr(payload)[:400])
    check("truncated 的 hash 不出现在 bodies 里（无半截正文）",
          payload["truncated"] and not ({H2, H3} & {b["hash"] for b in payload["bodies"]}),
          repr(payload)[:400])
    check("装入的正文逐字节等于原正文",
          payload["bodies"] == [{"hash": H1, "body": B1}], repr(payload["bodies"])[:300])
    check("小块仍能装入：hashes=H2,H1 预算 100 → 只回 H2",
          call(f"{H2},{H1}", "100")[0]["bodies"] == [{"hash": H2, "body": B2}],
          repr(call(f"{H2},{H1}", "100")[0])[:300])

    # 4) max_bytes 非法/越界：回落默认、clamp 到 [1, 2000000]
    payload, code = call(",".join([H1, H2, H3]), "not-a-number")
    check("max_bytes 非法 → 回落默认（3 个全返回）",
          code == 200 and payload["returned"] == 3, repr(payload)[:300])
    payload, code = call(",".join([H1, H2, H3]), "-1")
    check("max_bytes=-1 → clamp 到 1 → 全 truncated",
          code == 200 and payload["returned"] == 0
          and payload["truncated"] == [H1, H2, H3], repr(payload)[:400])
    payload, code = call(",".join([H1, H2, H3]), "99999999")
    check("max_bytes 超上限被 clamp（仍正常返回）",
          code == 200 and payload["returned"] == 3, repr(payload)[:300])

    # 5) 去重：重复 hash 只算一次
    payload, code = call(f"{H1},{H1}, {H2} ,{H1}")
    check("重复 hash 去重 → requested==2 / returned==2",
          code == 200 and payload["requested"] == 2 and payload["returned"] == 2,
          repr(payload)[:300])

    # 6) 非法 hash → rejected（不查库），合法项照常返回
    bad_short, bad_chars = "deadbeef", "Z" * 64
    payload, code = call(f"{H1},{bad_short},{H2},{bad_chars},,{H_MISSING}")
    check("非法 hash 进 rejected，合法项照常命中",
          code == 200 and payload["rejected"] == [bad_short, bad_chars]
          and payload["returned"] == 2 and payload["missing"] == [H_MISSING],
          repr(payload)[:400])

    # 7) 空的 hashes → 200 空结果（不报错）
    payload, code = call("")
    check("hashes 为空 → 200 空结果",
          code == 200 and payload["requested"] == 0 and payload["bodies"] == [],
          repr(payload)[:300])

    # 8) 超 200 个 → 400 too-many-hashes（不静默截断）
    many = [f"{i:064x}" for i in range(201)]
    payload, code = call(",".join(many))
    check("201 个 hash → 400 too-many-hashes",
          code == 400 and payload.get("error") == "too-many-hashes"
          and payload.get("limit") == server.MAX_BODIES_HASHES, repr(payload)[:300])
    payload, code = call(",".join(many[:200]))
    check("恰好 200 个 → 200（不算超限）",
          code == 200 and payload["requested"] == 200
          and len(payload["missing"]) == 200, f"code={code}")

    # 9) 未知 namespace → 404 风格 {error}
    payload, code = call(f"{H1}", ns=NS_UNKNOWN)
    check("未知 namespace → 404 unknown-namespace",
          code == 404 and payload == {"error": "unknown-namespace"}, repr(payload))

    # 10) 分组与统计分类（验收 5）
    check("_endpoint_group(/bodies) == bodies",
          server._endpoint_group(f"/v1/namespaces/{urllib.parse.quote(NS, safe='')}/bodies")
          == "bodies",
          server._endpoint_group(f"/v1/namespaces/{urllib.parse.quote(NS, safe='')}/bodies"))
    check("bodies 计入 retrieval 统计类", server._stats_category("bodies") == "retrieval",
          server._stats_category("bodies"))


# ---------------------------------------------------------------- ② 真实 HTTP 层
def test_http():
    httpd = server.make_server(0)  # 随机端口；复用全局 store
    port = httpd.server_address[1]
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()

    def get(ns, query):
        url = "http://127.0.0.1:{}/v1/namespaces/{}/bodies?{}".format(
            port, urllib.parse.quote(ns, safe=""), query)
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    try:
        # 普通 namespace（含 @ 与 #，必须编码后进路径）
        code, body = get(NS, f"hashes={H1},{H2},{H_MISSING}")
        check("HTTP 200 命中 2 个", code == 200 and body.get("returned") == 2,
              f"code={code} {body}")
        check("HTTP namespace 解码正确（@ 与 # 原样回显）",
              body.get("namespace") == NS, f"got={body.get('namespace')!r} want={NS!r}")

        # 含 "/" 的 namespace：%2F 必须被解码回单个 segment
        code, body = get(NS_SLASH, f"hashes={H1}")
        check('含 "/" 的 namespace 经 %2F 解码后可访问',
              code == 200 and body.get("namespace") == NS_SLASH
              and body.get("returned") == 1, f"code={code} {body}")

        # 未知 namespace → 404 风格错误
        code, body = get(NS_UNKNOWN, f"hashes={H1}")
        check("HTTP 未知 namespace → 404 unknown-namespace",
              code == 404 and body.get("error") == "unknown-namespace",
              f"code={code} {body}")

        # 路由确实接在 GET 上（参数生效：max_bytes=100 只回 1 个）
        code, body = get(NS, f"hashes={H1},{H2},{H3}&max_bytes=100")
        check("HTTP max_bytes 生效（returned 1 / truncated 2）",
              code == 200 and body.get("returned") == 1
              and body.get("truncated") == [H2, H3], f"code={code} {body}")
    finally:
        httpd.shutdown()
        httpd.server_close()
        th.join(timeout=5)


def main():
    print(f"临时库：{os.path.join(TMP, 'index.db')}")
    print(f"夹具：namespace={NS!r}  H1={H1[:12]}…  H2={H2[:12]}…  H3={H3[:12]}…")
    print("— ① 纯逻辑层（server.bodies_payload）—")
    test_logic()
    print("— ② 真实 HTTP 层（GET 路由 + URL 解码）—")
    test_http()
    print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
    if FAIL:
        print("❌ 未全绿")
        return 1
    print("✅ 全绿")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        try:
            st.close()
        except Exception:
            pass
        shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(code)
