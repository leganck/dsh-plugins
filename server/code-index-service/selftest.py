#!/usr/bin/env python3
"""服务端自测：**不需要 onnx 模型**（`FAKE_EMBED=1` 用哈希造向量），只验证索引层语义。

覆盖：
  ① 首次同步 / 未变更短路 / 只报缺失 hash       ② 正文上传幂等
  ③ 后台嵌入 + 限流生效                          ④ kNN 检索与排序
  ⑤ 增量：改一个文件只缺 1 块                    ⑥ 删除 + GC
  ⑦ revision 冲突 → 409                          ⑧ chunkFp 不一致 → 400
  ⑨ 血统隔离 + adopt 显式跨血统                  ⑩ 存储上界 → 507
  ⑪ 暂停/恢复/限速                              ⑫ gzip 请求体
  ⑬ 未知命名空间 → 404                           ⑭ /health 自述

档 3（快照作用域）：
  ⑮ namespace 规范夹具（scope_format.json 三组 cases）
  ⑯ scope 注册 / resolve / 列表 / status / health 汇总
  ⑰ legacy 命名空间 pinned，不被 sweep
  ⑱ TTL 过期 → sweep 删除 + /health.spaces 消失
  ⑲ DELETE scope 后 GC 不误删仍被其他 scope 引用的内容
  ⑳ 多作用域：按 hash 去重、来源、加权 RRF、byScope、旧单 ns 等价
  ㉑ MAX_SCOPES 配额 → 507
  ㉒ 旧 DB 启动即幂等迁移（legacy → pinned=1，created_at 回填）

P3（simhash 候选 + 精确哈希 adopt）：
  · 旧库补 simhash 5 列；simhash 存取 / 非法值 / Hamming
  · 候选查询（相似 / 无关 / tag / 排除 / 非冷启动）与 overlap 计算
  · 只复制精确 hash + 当前 tag，不复制 chunks/path；full+adopt 集成
  · reuse=off / diff 不查询；adopt 失败不影响 sync；诊断接口与鉴权

跑法：python selftest.py
"""
import base64
import functools
import gzip
import hashlib
import http.server
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# Windows 控制台默认 GBK，打不出 ✅/❌ → 强制 UTF-8（否则测试自己在打印时崩掉）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TMP = tempfile.mkdtemp(prefix="ci-selftest-")
os.environ.update(
    FAKE_EMBED="1",
    SERVER_DB=os.path.join(TMP, "index.db"),
    SERVER_LOG=os.path.join(TMP, "server.log"),
    EMBED_RATE="50",          # 自测要快；限流本身另有用例覆盖
    EMBED_BATCH="4",
    RETENTION_DAYS="0",
    # 档 3 的默认值钉死，避免外部环境变量让自测结果漂移
    SCOPE_TTL_BRANCH="30",
    SCOPE_TTL_PR="14",
    SCOPE_TTL_WORKTREE="1",
    SCOPE_SWEEP="1",
    MAX_SCOPES="200",
    MAX_SEARCH_SCOPES="4",
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402
import index_store as istore  # noqa: E402

PASS = 0
FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {label}")
    else:
        FAIL += 1
        print(f"  ❌ {label}{('  — ' + str(extra)) if extra else ''}")


def req(method, path, body=None, gz=False, headers=None):
    url = f"http://127.0.0.1:{PORT}{path}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        if gz:
            data = gzip.compress(data)
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("content-type", "application/json")
    if gz:
        r.add_header("content-encoding", "gzip")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def chunk(h, body, path, start):
    return {"hash": h, "body": body, "path": path, "start": start}


def req_raw(path, headers=None):
    """原样返回 (status, text, content-type)；用于 /admin HTML 这类非 JSON 响应。"""
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    with urllib.request.urlopen(r, timeout=30) as resp:
        return resp.status, resp.read().decode("utf-8", "replace"), resp.headers.get("content-type", "")


def req_auth(path, auth=None, method="GET", body=None, headers=None):
    """返回 (status, headers, text)；可带 authorization，用于 Basic/Bearer 鉴权断言。"""
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, method=method)
    r.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    if auth:
        r.add_header("authorization", auth)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


def req_form(path, fields):
    """application/x-www-form-urlencoded 请求（模拟浏览器原生表单提交，页面 JS 没跑起来时）。"""
    data = urllib.parse.urlencode(fields).encode()
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, method="POST")
    r.add_header("content-type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


def sync(ns, payload, gz=False):
    return req("POST", f"/v1/repos/{ns}/sync", payload, gz=gz)


def nsq(ns):
    """namespace 进 URL path 必须先 percent-encode（canonical ns 含 '#'，否则会被当 fragment 截断）。"""
    return urllib.parse.quote(str(ns), safe="")


def wait_vectors(ns, want, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, body = req("GET", f"/v1/repos/{nsq(ns)}/status")
        if body.get("vectors", 0) >= want:
            return body
        time.sleep(0.1)
    return req("GET", f"/v1/repos/{nsq(ns)}/status")[1]


def main():
    global PORT
    server.build()
    srv = server.make_server(0)
    PORT = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.2)

    URL = "https://git.example.com/team/demo.git"
    NS = "demo-abc@fp1"
    files = {
        "a.java": [("h1", "class A { void f(){} }", 1, 5)],
        "b.java": [("h2", "class B { void g(){} }", 1, 5), ("h3", "class B2 { }", 6, 9)],
        "c.java": [("h4", "class C { }", 1, 3), ("h5", "class C2 { }", 4, 8)],
    }

    def manifest(fs, state):
        return {
            "repoId": "demo",
            "chunkFp": "fp1",
            "url": URL,
            "repoState": state,
            "mode": "full",
            "upsert": [
                {"path": p, "hash": f"file-{p}", "chunks": [{"hash": h, "start": s, "end": e} for h, _b, s, e in cs]}
                for p, cs in fs.items()
            ],
            "remove": [],
        }

    print("\n[1] 首次同步 + 缺失清单")
    st, body = sync(NS, manifest(files, "state-1"))
    check("sync 返回 200", st == 200, body)
    check("revision = 1", body.get("revision") == 1, body.get("revision"))
    check("5 块全部缺向量", sorted(body.get("missing", [])) == ["h1", "h2", "h3", "h4", "h5"], body.get("missing"))
    check("chunks = 5", body.get("chunks") == 5, body.get("counts") or body.get("chunks"))
    check("vectors = 0", body.get("vectors") == 0)

    print("\n[2] 未变更短路（1 个 RTT，不传清单）")
    st, body2 = sync(NS, {"repoState": "state-1", "mode": "diff", "revision": 1, "chunkCount": 5})
    check("unchanged = true", body2.get("unchanged") is True, body2)
    check("revision 不变", body2.get("revision") == 1)
    check("missing 为空", body2.get("missing") == [])

    print("\n[2b] 指纹相同但块数不一致 → 不得短路（服务端不能凭指纹认为内容相同）")
    st, body2b = sync(NS, {"repoState": "state-1", "mode": "full", "chunkCount": 0, "chunkFp": "fp1", "upsert": manifest(files, "state-1b")["upsert"], "remove": []})
    check("未被短路", body2b.get("unchanged") is not True, body2b)
    check("服务端块数仍为 5", body2b.get("chunks") == 5, body2b.get("chunks"))

    print("\n[3] 上传正文（幂等）")
    bodies = [{"hash": h, "body": b} for cs in files.values() for h, b, _s, _e in cs]
    st, r1 = req("POST", f"/v1/repos/{NS}/chunks", {"bodies": bodies})
    check("首次全部 accepted", r1.get("accepted") == 5 and r1.get("deduped") == 0, r1)
    st, r2 = req("POST", f"/v1/repos/{NS}/chunks", {"bodies": bodies})
    check("重复上传全部 deduped", r2.get("accepted") == 0 and r2.get("deduped") == 5, r2)

    print("\n[4] 后台嵌入")
    stt = wait_vectors(NS, 5)
    check("5 块都拿到向量", stt.get("vectors") == 5, stt)
    check("覆盖率 = 1.0", stt.get("coverage") == 1.0, stt.get("coverage"))

    print("\n[5] kNN 检索")
    st, s1 = req("POST", "/v1/search", {"namespace": NS, "query": "class B2", "k": 3})
    check("返回 3 条", len(s1.get("hits", [])) == 3, s1)
    check("分数降序", all(s1["hits"][i]["score"] >= s1["hits"][i + 1]["score"] for i in range(len(s1["hits"]) - 1)))
    check("带路径与行号", all("path" in h and "start" in h for h in s1.get("hits", [])))
    check("带耗时分解", set(s1.get("ms", {})) >= {"embed", "knn"}, s1.get("ms"))

    print("\n[6] 增量：只缺新增块")
    files["a.java"].append(("h6", "class A2 { }", 6, 9))
    st, body3 = sync(NS, manifest(files, "state-2"))
    check("revision 递增到 3（2b 已推进过一次）", body3.get("revision") == 3, body3.get("revision"))
    check("只缺 h6", body3.get("missing") == ["h6"], body3.get("missing"))
    req("POST", f"/v1/repos/{NS}/chunks", {"bodies": [{"hash": "h6", "body": "class A2 { }"}]})
    stt = wait_vectors(NS, 6)
    check("向量补到 6", stt.get("vectors") == 6, stt)

    print("\n[7] 删除文件 + GC")
    files.pop("c.java")
    payload = manifest(files, "state-3")
    payload["mode"] = "full"
    payload["remove"] = ["c.java"]
    st, body4 = sync(NS, payload)
    check("删除后 chunks = 4", body4.get("chunks") == 4, body4)
    lid = req("GET", f"/v1/repos/{NS}/status")[1]["lineage"]
    st, g = req("POST", "/v1/admin/gc", {"lineage": lid, "retentionDays": 0})
    check("GC 清掉了 2 个 blob", g.get("blobs") == 2, g)
    check("GC 清掉了 2 个向量", g.get("vectors") == 2, g)

    print("\n[8] revision 冲突 → 409")
    st, c1 = sync(NS, {"repoState": "state-x", "mode": "diff", "revision": 999, "chunkFp": "fp1"})
    check("返回 409", st == 409, (st, c1))
    check("要求全量", c1.get("needFull") is True, c1)

    print("\n[9] chunkFp 不一致 → 400")
    bad = manifest(files, "state-4")
    bad["chunkFp"] = "fp2"
    bad["mode"] = "full"
    st, c2 = sync(NS, bad)
    check("返回 400 diverged", st == 400 and c2.get("error") == "diverged", (st, c2))

    print("\n[10] 血统隔离 + adopt")
    NS2 = "other-xyz@fp1"
    other = {
        "repoId": "other",
        "chunkFp": "fp1",
        "url": "https://git.example.com/team/OTHER.git",
        "repoState": "o1",
        "mode": "full",
        "upsert": [{"path": "x.java", "hash": "file-x", "chunks": [{"hash": "h1", "start": 1, "end": 5}]}],
        "remove": [],
    }
    st, o1 = sync(NS2, other)
    check("另一血统里 h1 也算缺（不跨血统共享）", o1.get("missing") == ["h1"], o1.get("missing"))
    lid2 = req("GET", f"/v1/repos/{NS2}/status")[1]["lineage"]
    check("两个血统 id 不同", lid != lid2)
    st, ad = req("POST", f"/v1/lineages/{lid2}/adopt", {"from": lid, "hashes": ["h1"]})
    check("adopt 复制了 1 个向量", ad.get("vectors") == 1, ad)
    st, o2 = sync(NS2, {"repoState": "o2", "mode": "full", "chunkFp": "fp1", "upsert": other["upsert"], "remove": []})
    check("adopt 后 h1 不再缺", o2.get("missing") == [], o2.get("missing"))
    lid2b = req("GET", f"/v1/repos/{NS2}/status")[1]["lineage"]
    check("最小载荷不会造出新血统", lid2b == lid2, (lid2, lid2b))

    print("\n[11] 存储上界 → 507")
    server.MAX_VECTORS_PER_LINEAGE = 1
    st, cap = sync(NS, {"repoState": "state-5", "mode": "full", "chunkFp": "fp1", "upsert": manifest(files, "s")["upsert"], "remove": []})
    check("返回 507", st == 507, (st, cap))
    check("错误码可读", cap.get("error") == "lineage-vector-cap", cap)
    server.MAX_VECTORS_PER_LINEAGE = 500000

    print("\n[12] 暂停 / 恢复 / 限速")
    st, p = req("POST", "/v1/admin/pause", {})
    check("pause 生效", p.get("paused") is True, p)
    st, r = req("POST", "/v1/admin/rate", {"rate": 3})
    check("rate 已改", r.get("rate") == 3.0, r)
    st, rs = req("POST", "/v1/admin/resume", {})
    check("resume 生效", rs.get("paused") is False, rs)

    print("\n[13] gzip 请求体")
    NS3 = "gz-abc@fp1"
    st, g3 = req("POST", f"/v1/repos/{NS3}/sync", manifest(files, "g1"), gz=True)
    check("gzip 同步成功", st == 200 and g3.get("chunks") == sum(len(v) for v in files.values()), (st, g3))

    print("\n[14] 未知命名空间 / 自述")
    st, nf = req("GET", "/v1/repos/nope/status")
    check("未知命名空间 → 404", st == 404, (st, nf))
    st, h = req("GET", "/health")
    check("health 带 tag", isinstance(h.get("tag"), str) and h["tag"].startswith("fake-model"), h.get("tag"))
    check("health 报 governor", h.get("governor", {}).get("rate") is not None, h.get("governor"))
    check("health 报存储上界", h.get("limits", {}).get("maxVectorsPerLineage") == 500000, h.get("limits"))
    check("health 列命名空间", any(s["namespace"] == NS for s in h.get("spaces", [])), len(h.get("spaces", [])))

    # ================================================================ 档 3：作用域（快照）
    def scope_sync(ns, files_map, state, scope=None, repo_id="scopedemo", url=None, chunk_fp="fp1"):
        payload = {
            "repoId": repo_id,
            "chunkFp": chunk_fp,
            "url": url or URL,
            "repoState": state,
            "mode": "full",
            "upsert": [
                {"path": p, "hash": "file-" + p,
                 "chunks": [{"hash": h, "start": s, "end": e} for h, _b, s, e in cs]}
                for p, cs in files_map.items()
            ],
            "remove": [],
        }
        if scope:
            payload["scope"] = scope
        return req("POST", f"/v1/repos/{nsq(ns)}/sync", payload)

    def upload(ns, files_map):
        bodies = [{"hash": h, "body": b} for cs in files_map.values() for h, b, _s, _e in cs]
        return req("POST", f"/v1/repos/{nsq(ns)}/chunks", {"bodies": bodies})[1]

    print("\n[15] namespace 规范夹具（scope_format.json）")
    fixture_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scope_format.json")
    if not os.path.exists(fixture_path):
        # 显式失败而不是静默跳过：容器发布门禁也要能发现"夹具没被打包进镜像"
        check("scope_format.json 可用", False, f"文件不存在：{fixture_path}（Dockerfile COPY 需包含它）")
    else:
        with open(fixture_path, encoding="utf-8") as f:
            fixture = json.load(f)
        bad = []
        for c in fixture["cases"]:
            got = istore.canonical_namespace(c["repoId"], c["chunkFp"], c["kind"], c["ref"])
            if got != c["expect"]:
                bad.append((c["expect"], got))
        check("cases：7 条 canonical namespace 全一致", not bad, bad[:2])
        bad = []
        for c in fixture["invalid_cases"]:
            try:
                istore.canonical_namespace(c["repoId"], c["chunkFp"], c["kind"], c["ref"])
                bad.append((c["reason"], "没有报错"))
            except istore.ScopeFormatError as e:
                if e.reason != c["reason"]:
                    bad.append((c["reason"], e.reason))
        check("invalid_cases：6 条 reason 全对", not bad, bad[:2])
        bad = [c for c in fixture["legacy_cases"] if istore.legacy_namespace(c["namespace"]) != c["expect"]]
        check("legacy_cases：原样保留不规范化", not bad, bad[:1])

    print("\n[16] scope 注册 / resolve / 列表 / status / health")
    REPO = "scopedemo"
    URL2 = "https://git.example.com/team/scopedemo.git"
    NS_BR = istore.canonical_namespace(REPO, "fp1", "branch", "feat/x")
    st, sb = scope_sync(NS_BR, {"d.java": [("hb1", "class D { }", 1, 3)]}, "sb-1",
                        {"kind": "branch", "ref": "feat/x", "commit": "c0ffee"}, repo_id=REPO, url=URL2)
    check("带 scope 的 sync 成功", st == 200, (st, sb))
    check("响应回服务端 canonical namespace", sb.get("namespace") == NS_BR, sb.get("namespace"))
    st, res = req("POST", "/v1/scopes/resolve",
                  {"repoId": REPO, "chunkFp": "fp1", "kind": "branch", "ref": "feat/x"})
    check("resolve 命中已存在 scope", st == 200 and res.get("exists") is True and res.get("namespace") == NS_BR, res)
    st, res_bad = req("POST", "/v1/scopes/resolve",
                      {"repoId": REPO, "chunkFp": "fp1", "kind": "pr", "ref": "abc"})
    check("resolve 非法 ref → 400 bad-scope", st == 400 and res_bad.get("reason") == "pr-ref-not-numeric", res_bad)
    st, lst = req("GET", f"/v1/scopes?repoId={REPO}&kind=branch")
    item = next((x for x in lst.get("scopes", []) if x["namespace"] == NS_BR), None)
    check("列表字段完整（kind/ref/TTL/coverage）",
          item is not None and item.get("kind") == "branch" and item.get("ref") == "feat/x"
          and item.get("expiresAt") and (item.get("ttlRemaining") or 0) > 0 and item.get("pinned") is False,
          item)
    st, sst = req("GET", f"/v1/repos/{nsq(NS_BR)}/status")
    check("status 带 scope 元数据",
          sst.get("scope", {}).get("kind") == "branch" and sst["scope"].get("ref") == "feat/x"
          and sst["scope"].get("commit") == "c0ffee", sst.get("scope"))
    st, hh = req("GET", "/health")
    check("health 顶层 scopes 汇总", hh.get("scopes", {}).get("byKind", {}).get("branch", 0) >= 1
          and hh["scopes"].get("total", 0) >= 1, hh.get("scopes"))

    print("\n[17] legacy 命名空间 pinned，janitor 不删")
    LEG = "legacy-demo@fp1"
    st, lg = req("POST", f"/v1/repos/{nsq(LEG)}/sync", {
        "repoId": REPO, "chunkFp": "fp1", "url": URL2, "repoState": "lg-1", "mode": "full",
        "upsert": [{"path": "l.java", "hash": "file-l.java", "chunks": [{"hash": "hl1", "start": 1, "end": 2}]}],
        "remove": [],
    })
    check("legacy 同步成功", st == 200, (st, lg))
    st, sw = req("POST", "/v1/admin/sweep", {})
    check("sweep 不删 legacy", LEG not in sw.get("deleted", []), sw)
    st, lstt = req("GET", f"/v1/repos/{nsq(LEG)}/status")
    check("legacy = pinned + 无过期时间", lstt.get("scope", {}).get("kind") == "legacy"
          and lstt["scope"].get("pinned") is True and lstt["scope"].get("expiresAt") is None, lstt.get("scope"))

    print("\n[18] TTL 过期 → sweep 删除")
    check("build() 已启动 janitor 线程", any(t.name == "scope-janitor" for t in threading.enumerate()))
    NS_PR = istore.canonical_namespace(REPO, "fp1", "pr", "42")
    st, sp = scope_sync(NS_PR, {"p.java": [("hp1", "class P { }", 1, 3)]}, "pr-1",
                        {"kind": "pr", "ref": "42"}, repo_id=REPO, url=URL2)
    check("PR scope 创建（默认 TTL）", st == 200 and sp.get("namespace") == NS_PR, (st, sp))
    st, pinr = req("POST", f"/v1/scopes/{nsq(NS_PR)}/pin", {"pinned": False, "ttlDays": 0})
    check("pin 可把 TTL 改成 0（立即过期）", st == 200 and pinr.get("expiresAt") is not None, pinr)
    st, sw2 = req("POST", "/v1/admin/sweep", {})
    check("过期 scope 被删除", NS_PR in sw2.get("deleted", []), sw2)
    st, lst2 = req("GET", "/v1/scopes")
    check("/v1/scopes 里已消失", all(x["namespace"] != NS_PR for x in lst2.get("scopes", [])))
    st, hs2 = req("GET", "/health")
    check("/health.spaces 里已消失", all(s["namespace"] != NS_PR for s in hs2.get("spaces", [])))

    print("\n[19] DELETE scope 后 GC 不误删被其他 scope 引用的内容")
    REPO3 = "wt"
    URL3 = "https://git.example.com/team/wt.git"
    NS_WA = istore.canonical_namespace(REPO3, "fp1", "worktree", "wt-a")
    NS_WB = istore.canonical_namespace(REPO3, "fp1", "worktree", "wt-b")
    shared = [("hshared", "shared body text", 1, 2)]
    fa = {"a.java": [("ha1", "alpha body", 1, 2)], "s.java": shared}
    fb = {"b.java": [("hb1", "beta body", 1, 2)], "s.java": shared}
    scope_sync(NS_WA, fa, "wa-1", {"kind": "worktree", "ref": "wt-a"}, repo_id=REPO3, url=URL3)
    scope_sync(NS_WB, fb, "wb-1", {"kind": "worktree", "ref": "wt-b"}, repo_id=REPO3, url=URL3)
    upload(NS_WA, fa)
    upload(NS_WB, fb)
    wait_vectors(NS_WA, 2)
    wait_vectors(NS_WB, 2)
    lid3 = req("GET", f"/v1/repos/{nsq(NS_WB)}/status")[1]["lineage"]

    def blob_exists(h):
        return server.store.db.execute(
            "select 1 from blobs where lineage_id = ? and hash = ?", (lid3, h)).fetchone() is not None

    def vector_exists(h):
        return server.store.db.execute(
            "select 1 from vectors where lineage_id = ? and hash = ?", (lid3, h)).fetchone() is not None

    check("共享内容已入库", blob_exists("hshared") and vector_exists("hshared"))
    st, dl = req("DELETE", f"/v1/scopes/{nsq(NS_WA)}")
    check("DELETE 返回 deleted/chunks", st == 200 and dl.get("deleted") is True and dl.get("chunks") == 2, dl)
    check("被 NS_WB 引用的共享 blob/vector 仍在", blob_exists("hshared") and vector_exists("hshared"))
    st, sh = req("POST", "/v1/search", {"namespace": NS_WB, "query": "shared body text", "k": 5})
    check("NS_WB 仍能检索到共享内容", any(h.get("hash") == "hshared" for h in sh.get("hits", [])), sh.get("hits"))
    st, dl2 = req("DELETE", f"/v1/scopes/{nsq(NS_WB)}")
    check("删掉最后引用后 GC 清掉孤儿内容",
          st == 200 and dl2.get("deleted") is True and not blob_exists("hshared") and not vector_exists("hshared"),
          (dl2, blob_exists("hshared"), vector_exists("hshared")))

    print("\n[20] 多作用域检索：去重 / 来源 / 权重 / byScope / 旧单 ns 等价")
    REPO4 = "multi"
    URL4 = "https://git.example.com/team/multi.git"
    NS_X = istore.canonical_namespace(REPO4, "fp1", "branch", "x")
    NS_Y = istore.canonical_namespace(REPO4, "fp1", "branch", "y")
    NS_S1 = istore.canonical_namespace(REPO4, "fp1", "branch", "s1")
    NS_S2 = istore.canonical_namespace(REPO4, "fp1", "branch", "s2")
    fx = {"x.java": [("hx1", "alpha one", 1, 2), ("hx2", "alpha two", 3, 4)]}
    fy = {"y.java": [("hy1", "beta one", 1, 2), ("hy2", "beta two", 3, 4)]}
    fs1 = {"s1.java": [("hdup", "shared chunk body", 1, 2), ("hs1", "s1 unique", 3, 4)]}
    fs2 = {"s2.java": [("hdup", "shared chunk body", 1, 2), ("hs2", "s2 unique", 3, 4)]}
    for ns, fm, ref in ((NS_X, fx, "x"), (NS_Y, fy, "y"), (NS_S1, fs1, "s1"), (NS_S2, fs2, "s2")):
        scope_sync(ns, fm, f"ms-{ref}", {"kind": "branch", "ref": ref}, repo_id=REPO4, url=URL4)
        upload(ns, fm)
    for ns in (NS_X, NS_Y, NS_S1, NS_S2):
        wait_vectors(ns, 2)
    st, both = req("POST", "/v1/search", {
        "namespaces": [{"namespace": NS_S1}, {"namespace": NS_S2}],
        "query": "shared chunk body", "k": 5,
    })
    dup_hits = [h for h in both.get("hits", []) if h.get("hash") == "hdup"]
    check("跨 scope 同 hash 只出现一次", len(dup_hits) == 1, [h.get("hash") for h in both.get("hits", [])])
    check("命中项带来源 namespace（首个 scope）", bool(dup_hits) and dup_hits[0].get("namespace") == NS_S1, dup_hits[:1])
    check("命中项带 scope {kind,ref}", bool(dup_hits)
          and dup_hits[0].get("scope", {}).get("kind") == "branch"
          and dup_hits[0]["scope"].get("ref") == "s1", dup_hits[:1])
    check("byScope 每项带 hits/coverage/ms", len(both.get("byScope", [])) == 2
          and all("hits" in b and "coverage" in b and "ms" in b for b in both["byScope"]), both.get("byScope"))
    st, wy = req("POST", "/v1/search", {
        "namespaces": [{"namespace": NS_X, "weight": 1}, {"namespace": NS_Y, "weight": 100}],
        "query": "anything", "k": 5,
    })
    check("加权 RRF：高权重 scope 的命中排第一",
          bool(wy.get("hits")) and wy["hits"][0].get("namespace") == NS_Y,
          [h.get("namespace") for h in wy.get("hits", [])])
    st, too = req("POST", "/v1/search", {"namespaces": [{"namespace": NS_X}] * 5, "query": "x", "k": 3})
    check("namespaces 超 MAX_SEARCH_SCOPES → 400", st == 400 and too.get("error") == "too-many-namespaces", (st, too))
    st, one_old = req("POST", "/v1/search", {"namespace": NS_X, "query": "alpha one", "k": 3})
    st, one_new = req("POST", "/v1/search", {"namespaces": [{"namespace": NS_X}], "query": "alpha one", "k": 3})
    check("旧单 namespace 与单元素数组结果等价", one_old.get("hits") == one_new.get("hits"),
          (one_old.get("hits"), one_new.get("hits")))
    check("旧字段保留（score/ms/coverage）",
          all(k in one_old for k in ("hits", "ms", "coverage"))
          and all(k in one_old.get("ms", {}) for k in ("embed", "knn"))
          and all("score" in h for h in one_old.get("hits", [])))

    print("\n[21] MAX_SCOPES 配额 → 507")
    old_max = server.MAX_SCOPES
    server.MAX_SCOPES = server.store.count_scopes()
    NS_QUOTA = istore.canonical_namespace("quota", "fp1", "branch", "new")
    st, q = scope_sync(NS_QUOTA, {"q.java": [("hq1", "quota probe", 1, 2)]}, "q-1",
                       {"kind": "branch", "ref": "new"}, repo_id="quota",
                       url="https://git.example.com/team/quota.git")
    check("新建 scope 超限 → 507 scope-cap", st == 507 and q.get("error") == "scope-cap", (st, q))
    check("配额响应带 count/limit", q.get("count") == server.MAX_SCOPES and q.get("limit") == server.MAX_SCOPES, q)
    server.MAX_SCOPES = old_max

    print("\n[22] 旧 DB 启动即幂等迁移")
    old_db = os.path.join(TMP, "legacy-db", "index.db")
    os.makedirs(os.path.dirname(old_db), exist_ok=True)
    conn = sqlite3.connect(old_db)
    conn.executescript("""
    create table lineages (id text primary key, url_norm text, created_at integer not null, last_seen integer not null);
    create table repos (
      namespace text primary key,
      lineage_id text not null,
      repo_id text not null,
      chunk_fp text not null,
      revision integer not null default 0,
      tag text,
      repo_state text,
      repo_state_chunks integer,
      updated_at integer not null
    );
    """)
    conn.execute("insert into lineages values ('L1', 'u', 1000, 1000)")
    conn.execute("insert into repos(namespace, lineage_id, repo_id, chunk_fp, revision, tag, repo_state,"
                 " repo_state_chunks, updated_at) values ('old@fp', 'L1', 'old', 'fp', 3, null, null, 0, 1000)")
    conn.commit()
    conn.close()
    m1 = istore.IndexStore(old_db)
    row = m1.repo("old@fp")
    check("老库补列后 legacy/pinned/no-expiry",
          row["scope_kind"] == "legacy" and row["pinned"] == 1 and row["expires_at"] is None, row)
    check("created_at 回填 updated_at", row["created_at"] == 1000, row.get("created_at"))
    simhash_cols = {"simhash_path", "simhash_content", "simhash_algo", "simhash_files", "simhash_at"}
    check("老库幂等补上 simhash 5 列（值保持 null）",
          simhash_cols <= set(row) and all(row[c] is None for c in simhash_cols), row)
    check("simhash 5 列已落进 repos schema",
          simhash_cols <= {r["name"] for r in m1.db.execute("pragma table_info(repos)").fetchall()})
    m1.close()
    m2 = istore.IndexStore(old_db)
    check("二次启动迁移幂等", m2.repo("old@fp")["pinned"] == 1)
    m2.pin_scope("old@fp", False)
    m2.close()
    m3 = istore.IndexStore(old_db)
    check("显式 unpin 不会被二次迁移重新钉住", m3.repo("old@fp")["pinned"] == 0)
    m3.close()

    print("\n[23] sync 显式 tag=null → 服务端补默认 tag（review-service 旧 payload 回归）")
    NS_NULL = istore.canonical_namespace("nulltag", "fp1", "branch", "feat/n")
    null_payload = {
        "repoId": "nulltag",
        "chunkFp": "fp1",
        "url": "https://git.example.com/team/nulltag.git",
        "tag": None,  # review-service 的 IndexSync 固定发 null；不能让它把 repos.tag 写成 NULL
        "repoState": "n-1",
        "mode": "full",
        "upsert": [{"path": "n.java", "hash": "file-n.java",
                    "chunks": [{"hash": "hn1", "start": 1, "end": 2}]}],
        "remove": [],
        "scope": {"kind": "branch", "ref": "feat/n"},
    }
    st, nt = req("POST", f"/v1/repos/{nsq(NS_NULL)}/sync", null_payload)
    check("显式 tag=null 的 sync → 200", st == 200, nt)
    stt = req("GET", f"/v1/repos/{nsq(NS_NULL)}/status")[1]
    check("repos.tag 被补成服务端当前 tag", stt.get("tag") == server.state["info"].get("tag"), stt.get("tag"))
    req("POST", f"/v1/repos/{nsq(NS_NULL)}/chunks",
        {"bodies": [{"hash": "hn1", "body": "null tag probe"}]})
    server.governor.kick(NS_NULL)
    stv = wait_vectors(NS_NULL, 1)
    check("显式 null tag 的命名空间能正常嵌入（coverage=1）",
          stv.get("vectors") == 1 and stv.get("coverage") == 1.0, stv)
    stq, sq = req("POST", "/v1/search", {"namespace": NS_NULL, "query": "null tag probe", "k": 3})
    check("显式 null tag 的命名空间可检索（不再 no-tag）",
          stq == 200 and bool(sq.get("hits")), sq)

    print("\n[24] /admin 后台页面")
    st, html, ctype = req_raw("/admin")
    check("/admin → 200 text/html", st == 200 and "text/html" in ctype, (st, ctype))
    check("页面包含标题与关键区块",
          "code-index-service · 控制台" in html and "作用域（快照）" in html and "/v1/scopes" in html
          and "API Key" in html and "概览" in html)
    st, html_slash, _ = req_raw("/admin/")
    check("/admin/ 同样可用", st == 200 and "code-index-service" in html_slash)
    check("页面不再内嵌 API-Key 输入逻辑（改走 HTTP Basic）",
          "dshAdminKey" not in html and "localStorage" not in html)
    st, fav, fav_ctype = req_raw("/favicon.svg")
    check("站点图标 /favicon.svg → 200 svg 且页面已声明",
          st == 200 and "svg" in fav_ctype and "<svg" in fav and 'rel="icon"' in html, (st, fav_ctype))

    print("\n[25] API_KEY（Bearer）鉴权")
    old_key = server.API_KEY
    server.API_KEY = "test-key-123"
    try:
        st, hp = req("GET", "/health")
        check("health 免鉴权", st == 200, st)
        check("公开 health 只给最小字段（不泄露 spaces）", "spaces" not in hp, list(hp.keys()))
        st, _ = req("GET", "/")
        check("根路径需鉴权（401）", st == 401, st)
        st, _ = req("GET", "/log?n=1")
        check("log 需鉴权（401）", st == 401, st)
        st, _ = req("GET", "/v1/scopes")
        check("scopes 需鉴权（401）", st == 401, st)
        st, _ = req("GET", f"/v1/repos/{nsq(NS_NULL)}/status")
        check("repo status 需鉴权（401）", st == 401, st)
        st, _ = req("POST", "/embed", {"texts": ["auth probe"]})
        check("POST 需鉴权（401）", st == 401, st)
        auth = {"Authorization": "Bearer test-key-123"}
        st, _ = req("GET", "/v1/scopes", headers=auth)
        check("带 Bearer 的 GET 放行", st == 200, st)
        st, hf = req("GET", "/health", headers=auth)
        check("带 key 的 health 是完整版（含 spaces/limits）",
              st == 200 and "spaces" in hf and "limits" in hf, list(hf.keys()))
        st, _ = req("POST", "/embed", {"texts": ["auth probe"]}, headers=auth)
        check("带 Bearer 的 POST 放行", st == 200, st)
        st, html, ctype = req_raw("/admin")
        check("管理员页面本身免鉴权（数据接口才要 key）", st == 200 and "text/html" in ctype, st)
    finally:
        server.API_KEY = old_key

    print("\n[26] 后台 HTTP Basic（ADMIN_USER / ADMIN_PASSWORD）")
    old_admin_pw = server.ADMIN_PASSWORD
    old_admin_user = server.ADMIN_USER
    old_api_key = server.API_KEY
    server.ADMIN_USER = "admin"
    server.ADMIN_PASSWORD = "admin-pw"
    server.API_KEY = "test-key-123"
    good = "Basic " + base64.b64encode(b"admin:admin-pw").decode()
    bad = "Basic " + base64.b64encode(b"admin:wrong").decode()
    bearer = "Bearer test-key-123"
    try:
        st, hdrs, page = req_auth("/admin")
        check("无凭据访问 /admin → 登录页（200，不再弹 Basic）",
              st == 200 and "请输入管理员账号" in page, (st, page[:40]))
        st, _, page = req_auth("/admin", auth=bad)
        check("错误 Basic 凭据 → 仍是登录页", st == 200 and "请输入管理员账号" in page, st)
        st, _, page = req_auth("/admin", auth=good)
        check("正确 Basic → /admin 控制台 html", st == 200 and "code-index-service · 控制台" in page, st)
        st, _, body = req_auth("/v1/scopes", auth=good)
        check("正确 Basic → 后台数据接口放行", st == 200 and "scopes" in body, st)
        st, _, body = req_auth("/health", auth=good)
        check("正确 Basic → health 是完整版", st == 200 and "spaces" in json.loads(body), st)
        st, _, _ = req_auth("/v1/admin/pause", auth=good, method="POST", body={})
        check("正确 Basic → 后台治理接口放行", st == 200, st)
        req_auth("/v1/admin/resume", auth=good, method="POST", body={})  # 别把 paused 状态留给后续用例
        st, _, _ = req_auth("/embed", auth=good, method="POST", body={"texts": ["basic only"]})
        check("索引接口不接受 Basic（只认 Bearer）", st == 401, st)
        st, _, _ = req_auth("/embed", auth=bearer, method="POST", body={"texts": ["bearer ok"]})
        check("索引接口仍接受 Bearer", st == 200, st)
        st, _, body = req_auth("/health")
        check("无凭据 health 仍是最小公共字段", st == 200 and "spaces" not in json.loads(body), st)
    finally:
        server.ADMIN_USER = old_admin_user
        server.ADMIN_PASSWORD = old_admin_pw
        server.API_KEY = old_api_key

    print("\n[27] 仓库可读名（repoName）")
    NS_NAME = istore.canonical_namespace("named01", "fp1", "branch", "feat/n")
    named = {
        "repoId": "named01",
        "chunkFp": "fp1",
        "url": "https://git.example.com/team/smartpos-crm-order.git",
        "repoName": "smartpos-crm-order",
        "tag": server.state["info"].get("tag"),
        "repoState": "named-1",
        "mode": "full",
        "upsert": [{"path": "n/J.java", "hash": "file-J.java",
                    "chunks": [{"hash": "hj1", "start": 1, "end": 2}]}],
        "remove": [],
        "scope": {"kind": "branch", "ref": "feat/n"},
    }
    st, sy = req("POST", f"/v1/repos/{nsq(NS_NAME)}/sync", named)
    check("sync 带 repoName → 200", st == 200, sy)
    stl, lst = req("GET", "/v1/scopes?repoId=named01")
    row = (lst.get("scopes") or [{}])[0]
    check("/v1/scopes 返回可读仓库名", row.get("repoName") == "smartpos-crm-order", row)
    sts, st_body = req("GET", f"/v1/repos/{nsq(NS_NAME)}/status")
    check("status 带 repoName", st_body.get("repoName") == "smartpos-crm-order", st_body.get("repoName"))
    old_name_row = istore.IndexStore  # noqa: F841  （仅保持脚本结构清晰）
    check("健康检查 spaces 也带 repoName",
          any(s.get("repo_name") == "smartpos-crm-order" for s in req("GET", "/health")[1].get("spaces", [])),
          None)

    print("\n[28] 向量标签统计 / 清理旧 tag / 后台检索测试")
    page = req_raw("/admin")[1]
    check("后台包含「检索测试」与「向量标签」卡片",
          "检索测试" in page and "向量标签" in page)
    row = server.store.repo(NS_NULL)
    vec = server.embedder.embed(["old model probe"])[0]
    server.store.put_vectors(row["lineage_id"], "old-model-tag", [("hash-old-tag", vec)])
    st, health = req("GET", "/health")
    tag_rows = {t["tag"]: t for t in health.get("tags", [])}
    check("/health.tags 同时列出当前模型与旧 tag",
          server.state["info"]["tag"] in tag_rows and "old-model-tag" in tag_rows, list(tag_rows))
    st, purged = req("POST", "/v1/admin/purge-tags", {})
    check("purge-tags 删掉非当前 tag 的向量", st == 200 and purged.get("deleted", 0) >= 1, purged)
    st, health2 = req("GET", "/health")
    check("purge 后旧 tag 消失",
          all(t["tag"] == server.state["info"]["tag"] for t in health2.get("tags", [])),
          health2.get("tags"))
    old_pw, old_key = server.ADMIN_PASSWORD, server.API_KEY
    server.ADMIN_PASSWORD, server.API_KEY = "admin-pw", "test-key-123"
    basic = "Basic " + base64.b64encode(b"admin:admin-pw").decode()
    try:
        st, _, body = req_auth("/v1/search", auth=basic, method="POST",
                               body={"namespace": NS_NULL, "query": "null tag probe", "k": 3})
        check("后台 Basic 可调用 /v1/search（检索测试）", st == 200 and "hits" in json.loads(body), st)
        st, _, _ = req_auth("/v1/search", method="POST",
                            body={"namespace": NS_NULL, "query": "x", "k": 1})
        check("无凭据调用 /v1/search 仍 401", st == 401, st)
    finally:
        server.ADMIN_PASSWORD, server.API_KEY = old_pw, old_key

    print("\n[29] 模型下载（进度 / 校验 / 重传）")
    import model_downloader as mdl

    src = os.path.join(TMP, "dlsrc")
    os.makedirs(src, exist_ok=True)
    payloads = {"a.txt": b"hello-model" * 1000, "b.bin": os.urandom(200_000)}
    for n, b in payloads.items():
        with open(os.path.join(src, n), "wb") as f:
            f.write(b)
    shas = {n: hashlib.sha256(b).hexdigest() for n, b in payloads.items()}
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=src)
    hsrv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=hsrv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % hsrv.server_address[1]
    catalog = {"tiny": {"label": "测试模型", "dir": "tiny", "release": base, "files": shas, "enable": {"MODEL_DIR": "x"}}}
    dl = mdl.ModelDownloader(os.path.join(TMP, "dlroot"), catalog, timeout=10)
    st = dl.get("tiny")
    check("初始 idle / 未就绪", st["status"] == "idle" and st["ready"] is False, st["status"])
    dl.start("tiny")
    st = dl.wait("tiny", timeout=30)
    check("下载完成且文件就绪", st["status"] == "done" and st["ready"] is True, st.get("error"))
    check("进度字节数正确", st["bytesDone"] == sum(len(b) for b in payloads.values()), st["bytesDone"])
    check("进度 100%", st["bytesTotal"] > 0 and st["bytesDone"] == st["bytesTotal"], (st["bytesDone"], st["bytesTotal"]))
    st2 = dl.wait("tiny", timeout=5)
    dl.start("tiny")
    st2 = dl.wait("tiny", timeout=10)
    check("重复下载跳过已存在文件", "跳过" in (st2.get("message") or ""), st2.get("message"))
    dl.start("tiny", force=True)
    st3 = dl.wait("tiny", timeout=30)
    check("重传（force）可以重新下载", st3["status"] == "done" and st3["ready"] is True, st3["status"])
    bad = json.loads(json.dumps(catalog))
    bad["tiny"]["files"] = {"a.txt": "0" * 64}
    dl2 = mdl.ModelDownloader(os.path.join(TMP, "dlroot2"), bad, timeout=10)
    dl2.start("tiny")
    st4 = dl2.wait("tiny", timeout=30)
    check("sha256 不符 → failed", st4["status"] == "failed" and "sha256" in (st4.get("error") or ""), st4.get("error"))
    check("失败可重试", st4["retryable"] is True)
    # 多源回退 + 远端路径（files 用 dict 形式）：第一个源 404 → 第二个源成功
    mirror = {"mirror": {
        "label": "镜像回退测试", "dir": "mirror",
        "release": [base + "/missing", base],
        "files": {"a.txt": {"sha256": shas["a.txt"], "remote": "a.txt"}},
    }}
    dl3 = mdl.ModelDownloader(os.path.join(TMP, "dlroot3"), mirror, timeout=10)
    dl3.start("mirror")
    st6 = dl3.wait("mirror", timeout=30)
    check("多源回退：第一个源 404 自动换下一个源", st6["status"] == "done" and st6["ready"] is True, st6.get("error"))
    bad_url = {"bad": {"label": "全失败", "dir": "bad", "release": [base + "/x", base + "/y"],
                       "files": {"a.txt": {"sha256": shas["a.txt"]}}}}
    dl4 = mdl.ModelDownloader(os.path.join(TMP, "dlroot4"), bad_url, timeout=5)
    dl4.start("bad")
    st7 = dl4.wait("bad", timeout=20)
    check("所有源都失败 → failed", st7["status"] == "failed" and bool(st7.get("error")), st7.get("error"))
    hsrv.shutdown()
    st5, body = req("GET", "/v1/admin/models")
    ids = [m["name"] for m in (body or {}).get("models", [])]
    check("/v1/admin/models 列出 bge / rerank / jina 三个模型",
          st5 == 200 and {"bge-base-zh", "bge-reranker-base", "jina-v2-base-code"} <= set(ids), ids)
    page = req_raw("/admin")[1]
    check("后台页面包含「可下载模型」与「重传」", "可下载模型" in page and "重传" in page)
    check("后台页面初始化会加载模型列表（不会停在加载中）", "loadModels();" in page)
    check("API Key 页含权限说明与测试按钮", "测试访问索引服务" in page and "index · 索引/检索服务" in page)
    check("新建 Key 只有 index 选项（无 admin option）", 'value="admin"' not in page)
    check("统计页含趋势图/导出/运行状态/按作用域", all(k in page for k in (
        "stat-trend", "stat-latency", "stat-mix", "stat-runtime", "stat-scopes",
        "btn-stats-export", "btn-stats-refresh")))
    check("统计页不再显示原始端点表", "按端点" not in page and "stat-endpoints" not in page)
    check("作用域页含清空索引危险操作", "清空所有作用域" in page and "输入 RESET 确认" in page)
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/admin", timeout=10) as _resp:
        _cc = _resp.headers.get("Cache-Control") or ""
    check("控制台 HTML 禁止缓存（避免浏览器继续用旧内联 JS）", "no-store" in _cc, _cc)

    # ================================================================
    print("\n[30] 入口内容协商 / 会话登录")
    server.API_KEY = ""
    old_admin_pw = server.ADMIN_PASSWORD
    server.ADMIN_PASSWORD = "admin-pw"
    try:
        st, _, page = req_auth("/", headers={"accept": "text/html"})
        check("浏览器 Accept text/html → 重定向到控制台（登录页）",
              st == 200 and "请输入管理员账号" in page, (st, page[:40]))
        basic2 = "Basic " + base64.b64encode(b"admin:admin-pw").decode()
        st, _, body = req_auth("/", auth=basic2)
        check("非 HTML 客户端 GET / → JSON 自述（插件契约）", st == 200 and "tag" in json.loads(body), st)
        st, _, body = req_auth("/v1/status", auth=basic2)
        check("/v1/status → JSON 自述", st == 200 and "tag" in json.loads(body), st)
        st, hdrs, _ = req_auth("/admin/login", method="POST", body={"username": "admin", "password": "wrong"})
        check("错误密码登录 → 401", st == 401, st)
        st, hdrs, _ = req_auth("/admin/login", method="POST", body={"username": "admin", "password": "admin-pw"})
        h = {k.lower(): v for k, v in hdrs.items()}
        cookie = (h.get("set-cookie") or "").split(";")[0]
        check("正确密码登录 → 200 + HttpOnly 会话 Cookie",
              st == 200 and cookie.startswith("dsh_admin=") and "httponly" in (h.get("set-cookie") or "").lower(),
              (st, h.get("set-cookie")))
        st, _, page = req_auth("/admin", headers={"cookie": cookie})
        check("带会话 Cookie → 控制台", st == 200 and "code-index-service · 控制台" in page, st)
        st, _, body = req_auth("/v1/admin/session", headers={"cookie": cookie})
        check("会话可读 /v1/admin/session", st == 200 and json.loads(body).get("authed") is True, st)
        st, _, _ = req_auth("/admin/logout", method="POST", body={})
        check("登出 → 200（清 Cookie）", st == 200, st)
        st, _, page = req_auth("/admin")
        check("登出后 /admin 回到登录页", st == 200 and "请输入管理员账号" in page, st)
        # 浏览器原生表单兜底（JS 没跑起来时，_body 必须能解析 urlencoded，而不是 500）
        st, hdrs, _ = req_form("/admin/login", {"username": "admin", "password": "admin-pw"})
        cookie_h = {k.lower(): v for k, v in hdrs.items()}
        check("表单兜底登录 → 200 + 会话 Cookie",
              st == 200 and "dsh_admin=" in (cookie_h.get("set-cookie") or ""), st)
    finally:
        server.ADMIN_PASSWORD = old_admin_pw

    print("\n[31] 多 API Key（创建/禁用/删除/角色）")
    old_admin_pw = server.ADMIN_PASSWORD
    server.ADMIN_PASSWORD = "admin-pw"
    admin_auth = {"Authorization": "Basic " + base64.b64encode(b"admin:admin-pw").decode()}
    try:
        st, body = req("GET", "/v1/admin/keys", headers=admin_auth)
        check("Key 列表可读（管理员 Basic）", st == 200 and "keys" in body, st)
        st, body = req("POST", "/v1/admin/keys", {"name": "test-index", "role": "index"}, headers=admin_auth)
        created = body
        plain = (created or {}).get("key") or ""
        kid = (created or {}).get("id")
        check("创建 index Key：返回一次性明文 + 前缀", st == 200 and len(plain) >= 20 and "key" in (created or {}), created)
        st, body = req("GET", "/v1/admin/keys", headers=admin_auth)
        lst = (body or {}).get("keys") or []
        check("Key 列表不含明文/hash，只有前缀",
              all(("key" not in k) and ("key_hash" not in k) and k.get("prefix") for k in lst), [list(k) for k in lst])
        auth = {"Authorization": "Bearer " + plain}
        st, _ = req("POST", "/v1/search", {"namespace": NS_NULL, "query": "key probe", "k": 1}, headers=auth)
        check("index Key 可调检索接口", st == 200, st)
        st, _ = req("GET", "/v1/admin/keys", headers=auth)
        check("index Key 不能调后台管理接口（403/401）", st in (401, 403), st)
        st, body = req("POST", f"/v1/admin/keys/{kid}/disable", {}, headers=admin_auth)
        check("禁用 Key → 200", st == 200, st)
        st, _ = req("POST", "/v1/search", {"namespace": NS_NULL, "query": "key probe", "k": 1}, headers=auth)
        check("禁用后 index Key 立即 401", st == 401, st)
        st, body = req("POST", f"/v1/admin/keys/{kid}/enable", {}, headers=admin_auth)
        check("重新启用 Key → 200", st == 200, st)
        st, _ = req("POST", "/v1/search", {"namespace": NS_NULL, "query": "key probe", "k": 1}, headers=auth)
        check("启用后恢复可用", st == 200, st)
        # 先建一个 keep key：否则删掉唯一 key 后服务回到"开放模式"，旧 token 也会放行（那是预期行为）
        st, body = req("POST", "/v1/admin/keys", {"name": "keep-key", "role": "index"}, headers=admin_auth)
        keep = body or {}
        st, _ = req("DELETE", f"/v1/admin/keys/{kid}", headers=admin_auth)
        check("删除 Key → 200", st == 200, st)
        st, _ = req("POST", "/v1/search", {"namespace": NS_NULL, "query": "key probe", "k": 1}, headers=auth)
        check("删除后 index Key 401", st == 401, st)
        req("DELETE", f"/v1/admin/keys/{keep.get('id')}", headers=admin_auth)
        st, _ = req("DELETE", "/v1/admin/keys/0", headers=admin_auth)
        check("legacy id=0 不可删除（400）", st == 400, st)

        print("\n[32] 调用统计（按 Key/端点/天）")
        st, body = req("POST", "/v1/admin/keys", {"name": "stats-key", "role": "index"}, headers=admin_auth)
        created = body
        plain2, kid2 = (created or {}).get("key"), (created or {}).get("id")
        auth2 = {"Authorization": "Bearer " + plain2}
        for _ in range(3):
            req("POST", "/v1/search", {"namespace": NS_NULL, "query": "统计探针", "k": 1}, headers=auth2)
        req("POST", "/embed", {"texts": ["统计探针 a", "统计探针 b"]}, headers=auth2)
        time.sleep(0.3)
        st, body = req("GET", "/v1/admin/stats?days=7", headers=admin_auth)
        stats = body or {}
        tot = stats.get("totals") or {}
        check("统计 totals：请求/embed/search 计数 > 0",
              st == 200 and tot.get("requests", 0) >= 4 and tot.get("embedTexts", 0) >= 4
              and tot.get("searchCalls", 0) >= 3, tot)
        by_key = {k.get("keyId"): k for k in (stats.get("byKey") or [])}
        check("统计按 Key 归属到新建 Key", kid2 in by_key and by_key[kid2].get("requests", 0) >= 4,
              {k: v.get("requests") for k, v in by_key.items()})
        eps = {e.get("endpoint"): e for e in (stats.get("byEndpoint") or [])}
        check("统计按端点分组（search/embed）", eps.get("search", {}).get("requests", 0) >= 3
              and eps.get("embed", {}).get("requests", 0) >= 1, list(eps))
        check("统计按天序列存在", len(stats.get("byDay") or []) >= 1, len(stats.get("byDay") or []))
        check("byDay 含延迟字段", all("latencyAvg" in d and "latencyMax" in d for d in (stats.get("byDay") or [])))
        check("按 Key 含平均延迟", kid2 in by_key and "latencyAvg" in by_key[kid2], by_key.get(kid2))
        check("上期对比 prevTotals 存在", isinstance(stats.get("prevTotals"), dict)
              and "requests" in (stats.get("prevTotals") or {}), stats.get("prevTotals"))
        lat = stats.get("latency") or {}
        check("延迟分桶存在且 P50/P95 已算出",
              lat.get("count", 0) >= 5 and bool(lat.get("p95")) and len(lat.get("buckets") or []) == 11,
              {"count": lat.get("count"), "p50": lat.get("p50"), "p95": lat.get("p95")})
        check("usage_latency 表已建",
              server.adm.db.execute("select name from sqlite_master where type='table' and name='usage_latency'").fetchone() is not None)
        st1, body1 = req("GET", "/v1/admin/stats?days=1", headers=admin_auth)
        check("days=1 只返回今日一天", st1 == 200 and len((body1 or {}).get("byDay") or []) == 1,
              len((body1 or {}).get("byDay") or []))
        cats = stats.get("categories") or {}
        check("统计含业务/系统四类", set(cats) == {"retrieval", "indexing", "embedding", "system"}, list(cats))
        check("系统/轮询请求不为 0 且单独归类", cats.get("system", {}).get("requests", 0) >= 1,
              (cats.get("system") or {}).get("requests"))
        biz_requests = sum((cats.get(name) or {}).get("requests", 0)
                           for name in ("retrieval", "indexing", "embedding"))
        check("业务请求 + 系统请求 = 总请求", biz_requests + (cats.get("system") or {}).get("requests", 0)
              == (tot.get("requests") or 0), (biz_requests, cats, tot.get("requests")))
        check("byDay 含分类请求数", all(("retrievalRequests" in d and "indexingRequests" in d
              and "embeddingRequests" in d and "systemRequests" in d) for d in (stats.get("byDay") or [])))
        by_scope = {s.get("namespace"): s for s in (stats.get("byScope") or [])}
        check("按作用域统计记录检索请求", NS_NULL in by_scope and by_scope[NS_NULL].get("searchCalls", 0) >= 1,
              list(by_scope))
        check("usage_scope 表已建",
              server.adm.db.execute("select name from sqlite_master where type='table' and name='usage_scope'").fetchone() is not None)
        check("prevCategories 存在", isinstance(stats.get("prevCategories"), dict))
        server.adm.flush()
        check("flush 后可读（stats 持久化入口）", True, "")
        req("DELETE", f"/v1/admin/keys/{kid2}", headers=admin_auth)

        print("\n[33] 模型热切换（FAKE_EMBED + 假目录）")
        fake_a = os.path.join(TMP, "model-fake-a")
        fake_b = os.path.join(TMP, "model-fake-b")
        for d in (fake_a, fake_b):
            os.makedirs(d, exist_ok=True)
            for fn, data in (("model_fp16.onnx", b"onnx-" + d.encode()[-8:]), ("tokenizer.json", b"{}"),
                             ("tokenizer_config.json", b"{}")):
                with open(os.path.join(d, fn), "wb") as f:
                    f.write(data)
        server.MODEL_ROOTS.append(TMP)
        old_tag = server.state["info"]["tag"]
        st, body = req("POST", "/v1/admin/models/activate", {"kind": "embed", "dir": fake_a}, headers=admin_auth)
        r1 = body or {}
        check("热切换 embed → 200 且 tag 变化", st == 200 and r1.get("tag") != old_tag, (st, r1.get("tag"), old_tag))
        st, hp = req("GET", "/health")
        check("/health.tag 立即反映新模型", st == 200 and hp.get("tag") == r1.get("tag"), (hp.get("tag"), r1.get("tag")))
        st, body = req("GET", "/v1/scopes", headers=admin_auth)
        check("切换后作用域数据仍在", st == 200 and (body or {}).get("scopes") is not None, st)
        st, body = req("POST", "/v1/admin/models/activate", {"kind": "embed", "dir": fake_b}, headers=admin_auth)
        r2 = body or {}
        check("再切到第二个模型 → tag 不同", st == 200 and r2.get("tag") != r1.get("tag"), r2.get("tag"))
        st, body = req("POST", "/v1/admin/models/activate", {"kind": "embed", "dir": "C:/definitely/not/a/model"}, headers=admin_auth)
        check("非法目录 → 400 且保留原模型", st == 400 and server.state["info"]["tag"] == r2.get("tag"), st)
        dup_dir = os.path.join(TMP, "model-fake-b-copy")
        os.makedirs(dup_dir, exist_ok=True)
        for fn in ("model_fp16.onnx", "tokenizer.json", "tokenizer_config.json"):
            with open(os.path.join(fake_b, fn), "rb") as src, open(os.path.join(dup_dir, fn), "wb") as dst:
                dst.write(src.read())
        st, body = req("GET", "/v1/admin/models", headers=admin_auth)
        mdata = body or {}
        check("/v1/admin/models 含 installed/active/下载目录",
              st == 200 and "installed" in mdata and "active" in mdata and "models" in mdata, list(mdata))
        merged_rows = [m for m in ((mdata.get("installed") or {}).get("embed") or []) if m.get("alsoDirs")]
        check("重复模型目录按内容指纹合并为一行（active 优先，副本记入 alsoDirs）",
              len(merged_rows) == 1 and merged_rows[0].get("active")
              and any("copy" in str(d) for d in (merged_rows[0].get("alsoDirs") or [])),
              [(m.get("dir"), m.get("tag"), m.get("active"), m.get("alsoDirs")) for m in ((mdata.get("installed") or {}).get("embed") or [])])
        check("下载列表能标出本机已有同款（installedElsewhere 字段可用）",
              all("installedElsewhere" not in m or m["installedElsewhere"].get("dir") for m in (mdata.get("models") or [])))
        check("热切换后 governor 恢复运行", server.governor and not server.governor.paused,
              server.governor.paused if server.governor else None)
    finally:
        server.ADMIN_PASSWORD = old_admin_pw
        if TMP in server.MODEL_ROOTS:
            server.MODEL_ROOTS.remove(TMP)

    print("\n[34] 清空索引（reset-index）")
    st, before = req("GET", "/v1/scopes")
    check("重置前有作用域", st == 200 and len((before or {}).get("scopes") or []) > 0,
          len((before or {}).get("scopes") or []))
    st, body = req("POST", "/v1/admin/reset-index", {})
    check("缺少 confirm → 400", st == 400, st)
    st, body = req("POST", "/v1/admin/reset-index", {"confirm": "RESET"})
    deleted = (body or {}).get("deleted") or {}
    check("confirm=RESET → 200 且删除统计 > 0",
          st == 200 and deleted.get("chunks", 0) > 0 and deleted.get("repos", 0) > 0, (st, deleted))
    st, after = req("GET", "/v1/scopes")
    check("清空后作用域列表为空", st == 200 and (after or {}).get("scopes") == [], st)
    st, hp = req("GET", "/health")
    check("清空后 health.spaces/tags 均为空", st == 200 and hp.get("spaces") == [] and hp.get("tags") == [],
          (hp.get("spaces"), hp.get("tags")))
    check("清空后服务仍 ready（模型不受影响）", st == 200 and hp.get("ready") is True, hp.get("ready"))
    st, ks = req("GET", "/v1/admin/keys")
    check("清空索引不影响 API Key 库", st == 200 and "keys" in (ks or {}), st)

    # ================================================================ P3：simhash 候选 + 精确哈希 adopt
    print("\n[35] simhash 候选 / 精确 hash adopt（跨血统冷启动）")
    TAG_NOW = server.state["info"]["tag"]

    # ---- 单元层：hex 校验 / 归一化 / Hamming
    check("normalize_simhash_hex：大写转小写、短值左补零",
          istore.normalize_simhash_hex("ABC") == "0000000000000abc", istore.normalize_simhash_hex("ABC"))
    check("normalize_simhash_hex：超长 / 注入 / 非字符串 → None",
          istore.normalize_simhash_hex("0" * 17) is None
          and istore.normalize_simhash_hex("'; drop table repos; --") is None
          and istore.normalize_simhash_hex(123) is None)
    check("parse_simhash：非法 files 归 null、非法 hex 整体丢弃",
          istore.parse_simhash({"path": "1", "content": "2", "files": "x"})["files"] is None
          and istore.parse_simhash({"path": "zz", "content": "2"}) is None)
    check("Hamming：相同 = 1.0 / 全反 = 0.0 / 差 1 bit = 63/64",
          istore.hamming_similarity("0" * 16, "0" * 16) == 1.0
          and istore.hamming_similarity("0" * 16, "f" * 16) == 0.0
          and abs(istore.hamming_similarity("0" * 16, "0" * 15 + "1") - 63 / 64) < 1e-9)

    SIM_PATH_IN = "A1B2C3D4E5F60718"   # 大写输入：落库应规范成小写
    SIM_PATH = SIM_PATH_IN.lower()
    SIM_CONTENT_IN = "0F1E2D3C4B5A6978"
    SIM_CONTENT = SIM_CONTENT_IN.lower()
    SIM_OBJ = {"v": 1, "path": SIM_PATH_IN, "content": SIM_CONTENT_IN, "files": 9}
    A_SHARED = ["sh1", "sh2", "sh3", "sh4", "sh5", "sh6", "sh7", "sh8"]
    A_ONLY = "sh-cand-only"       # 只属于候选：绝不能出现在目标
    STALE = "sh-stale-tag-only"   # 候选只有旧 tag 向量：不能算 overlap、不能复制
    B_NEW = "sh-target-new"       # 只属于目标：adopt 后仍要嵌入
    NS_CA = "simcand@fp1"         # 候选血统（legacy ns 即可）
    NS_TB = "simtarg@fp1"         # 目标血统（另一个 URL → 另一个 lineage）

    def _sim_manifest(repo_id, repo_name, url, state, hashes, path,
                      simhash=None, adopt=False, reuse=None, no_embed=True):
        payload = {
            "repoId": repo_id, "repoName": repo_name, "chunkFp": "fp1", "url": url,
            "repoState": state, "mode": "full",
            "upsert": [{"path": path, "hash": "file-" + path,
                        "chunks": [{"hash": h, "start": i * 2 + 1, "end": i * 2 + 2}
                                   for i, h in enumerate(hashes)]}],
            "remove": [],
        }
        if simhash is not None:
            payload["simhash"] = simhash
        if adopt:
            payload["adopt"] = True
        if reuse is not None:
            payload["reuse"] = reuse
        if no_embed:
            payload["noEmbed"] = True
        return payload

    # ---- 候选仓库：full sync 带 simhash，正常上传正文 + 后台嵌入
    st, rca = sync(NS_CA, _sim_manifest("simcand01", "sim-candidate", "https://git.example.com/team/sim-candidate.git",
                                        "ca-1", A_SHARED + [A_ONLY], "cand.java",
                                        simhash=SIM_OBJ, no_embed=False))
    check("候选仓库 full sync + simhash → 200", st == 200, (st, rca))
    row_ca = server.store.repo(NS_CA)
    check("repos 存 simhash（小写 16 位 / 算法 / 文件数 / 时间）",
          row_ca["simhash_path"] == SIM_PATH and row_ca["simhash_content"] == SIM_CONTENT
          and row_ca["simhash_algo"] == "1" and row_ca["simhash_files"] == 9
          and isinstance(row_ca["simhash_at"], int), row_ca)
    bodies_a = [{"hash": h, "body": "body-" + h} for h in A_SHARED + [A_ONLY]]
    bodies_a.append({"hash": STALE, "body": "body-" + STALE})  # 候选有正文，但只有 stale tag 向量
    req("POST", f"/v1/repos/{NS_CA}/chunks", {"bodies": bodies_a})
    stv = wait_vectors(NS_CA, len(A_SHARED) + 1)
    check("候选仓库块全部嵌入（adopt 的前提）", stv.get("vectors") == 9, stv.get("vectors"))
    stale_vec = server.embedder.embed(["stale-tag-probe"])[0]
    server.store.put_vectors(row_ca["lineage_id"], "stale-model-tag", [(STALE, stale_vec)])
    check("候选血统另有 stale tag 向量（用于验证 tag 过滤）",
          server.store.vector_count(row_ca["lineage_id"], "stale-model-tag") == 1)

    # ---- 目标仓库：10 块里 8 块与候选同内容（overlap 恰好 0.80）
    st, rtb = sync(NS_TB, _sim_manifest("simtarg01", "sim-target", "https://git.example.com/team/sim-target.git",
                                        "tb-1", A_SHARED + [STALE, B_NEW], "target.java",
                                        simhash=SIM_OBJ, adopt=True, reuse="auto"))
    adopted = rtb.get("adopted") or {}
    check("full + adopt 开关 → 200 且返回 adopted", st == 200 and bool(adopted), (st, rtb))
    check("adopted 元信息（fromLineage / fromRepo / similarity / overlap）",
          adopted.get("fromLineage") == row_ca["lineage_id"]
          and adopted.get("fromRepo") == "sim-candidate"
          and adopted.get("similarity") == 1.0 and adopted.get("overlap") == 0.8, adopted)
    check("只复制 8 个共享 hash 的 blob + vector",
          adopted.get("blobs") == 8 and adopted.get("vectors") == 8, adopted)
    check("missing 只剩目标独有的 2 块（adopt 后算 _missing）",
          sorted(rtb.get("missing") or []) == sorted([STALE, B_NEW]), rtb.get("missing"))

    row_tb = server.store.repo(NS_TB)
    db = server.store.db
    target_chunks = int(db.execute("select count(*) as n from chunks where namespace = ?",
                                   (NS_TB,)).fetchone()["n"])
    target_paths = sorted(r["path"] for r in db.execute(
        "select distinct path from chunks where namespace = ?", (NS_TB,)).fetchall())
    check("不复制候选 chunks / path：目标块数与路径不变",
          target_chunks == 10 and target_paths == ["target.java"], (target_chunks, target_paths))
    target_vecs = {r["hash"] for r in db.execute(
        "select hash from vectors where lineage_id = ?", (row_tb["lineage_id"],)).fetchall()}
    target_tags = {r["tag"] for r in db.execute(
        "select distinct tag from vectors where lineage_id = ?", (row_tb["lineage_id"],)).fetchall()}
    target_blobs = {r["hash"] for r in db.execute(
        "select hash from blobs where lineage_id = ?", (row_tb["lineage_id"],)).fetchall()}
    check("只复制精确 hash：共享 8 块在、候选独有 / stale-only / 目标新增都不在",
          set(A_SHARED) <= target_vecs and A_ONLY not in target_vecs
          and STALE not in target_vecs and B_NEW not in target_vecs, sorted(target_vecs))
    check("只复制当前 tag：目标血统只有当前 tag 向量",
          target_tags == {TAG_NOW}, target_tags)
    check("blob 与 vector 一起复制（不含候选独有 / stale / 目标新增）",
          target_blobs == set(A_SHARED), sorted(target_blobs))
    check("目标 repos 也保存了 simhash", row_tb["simhash_path"] == SIM_PATH, row_tb.get("simhash_path"))

    ov = server.store.adopt_overlap(NS_TB, row_ca["lineage_id"], TAG_NOW)
    check("overlap = 目标 chunks ∩ 候选当前 tag vectors = 8/10",
          ov.get("targetHashes") == 10 and ov.get("targetChunks") == 10
          and ov.get("matched") == 8 and ov.get("overlap") == 0.8, ov)
    again = server.store.adopt_hashes(row_ca["lineage_id"], row_tb["lineage_id"], A_SHARED, TAG_NOW,
                                      namespace=NS_TB)
    check("adopt_hashes 幂等（重复调用不重复插入）",
          again.get("blobs") == 0 and again.get("vectors") == 0 and again.get("hashes") == 8, again)
    orphan = server.store.adopt_hashes(row_ca["lineage_id"], row_tb["lineage_id"], [A_ONLY], TAG_NOW,
                                       namespace=NS_TB)
    check("目标 chunks 没有的候选 hash 不复制",
          orphan.get("hashes") == 0 and orphan.get("vectors") == 0, orphan)

    # ---- 候选查询：相似 / 无关 / tag / 排除 / 非冷启动
    cands = server.store.similar_lineages(SIM_PATH_IN, SIM_CONTENT_IN, None, TAG_NOW)
    hit = next((c for c in cands if c["lineage"] == row_ca["lineage_id"]), None)
    check("相同 simhash → 候选 similarity = 1.0", hit is not None and hit.get("similarity") == 1.0, cands)
    check("候选只返回元信息、不含正文", hit is not None and all("body" not in c for c in cands))
    check("候选带 repoName / namespace / updatedAt / path+content 相似度",
          hit is not None and hit.get("repoName") == "sim-candidate" and hit.get("namespace") == NS_CA
          and isinstance(hit.get("updatedAt"), int) and hit.get("pathSimilarity") == 1.0
          and hit.get("contentSimilarity") == 1.0, hit)
    excluded = server.store.similar_lineages(SIM_PATH_IN, SIM_CONTENT_IN, row_ca["lineage_id"], TAG_NOW)
    check("exclude_lineage 生效", all(c["lineage"] != row_ca["lineage_id"] for c in excluded), excluded)
    check("无关 simhash → 空候选（阈值 0.85）",
          server.store.similar_lineages("0" * 16, "0" * 16, None, TAG_NOW) == [])
    check("tag 不一致 → 空候选",
          server.store.similar_lineages(SIM_PATH_IN, SIM_CONTENT_IN, None, "other-model-tag") == [])
    check("tag 为空不乱匹配 → 空候选",
          server.store.similar_lineages(SIM_PATH_IN, SIM_CONTENT_IN, None, "") == [])
    check("目标血统已有当前 tag 向量 → 不再返回候选（非冷启动）",
          server.store.similar_lineages(SIM_PATH_IN, SIM_CONTENT_IN, None, TAG_NOW,
                                        target_namespace=NS_TB) == [])

    # ---- 诊断接口 GET /v1/lineages/similar
    qs = urllib.parse.urlencode({"path": SIM_PATH_IN, "content": SIM_CONTENT_IN, "tag": TAG_NOW, "limit": 5})
    st, diag = req("GET", f"/v1/lineages/similar?{qs}")
    meta = next((c for c in (diag.get("candidates") or []) if c.get("lineage") == row_ca["lineage_id"]), None)
    check("GET /v1/lineages/similar → 200 + 候选元信息（无正文）",
          st == 200 and (diag.get("count") or 0) >= 2 and meta is not None and "body" not in meta, (st, diag))
    st, badq = req("GET", "/v1/lineages/similar?path=zz&content=" + "0" * 16 + "&tag=" + urllib.parse.quote(TAG_NOW))
    check("诊断接口：非法 simhash → 400 bad-simhash", st == 400 and badq.get("error") == "bad-simhash", (st, badq))
    st, notag = req("GET", f"/v1/lineages/similar?path={SIM_PATH}&content={SIM_CONTENT}")
    check("诊断接口：缺 tag → 400 tag-required", st == 400 and notag.get("error") == "tag-required", (st, notag))
    old_api_key = server.API_KEY
    server.API_KEY = "test-key-123"
    try:
        st, _ = req("GET", f"/v1/lineages/similar?{qs}")
        check("诊断接口走现有 API Key 鉴权（无 key → 401）", st == 401, st)
        st, okq = req("GET", f"/v1/lineages/similar?{qs}", headers={"Authorization": "Bearer test-key-123"})
        check("诊断接口带 Bearer → 200", st == 200 and bool(okq.get("candidates")), st)
    finally:
        server.API_KEY = old_api_key

    # ---- 非法 simhash：sync 不失败、不落库
    NS_BAD = "simbad@fp1"
    st, rbad = sync(NS_BAD, _sim_manifest("simbad01", "sim-bad", "https://git.example.com/team/sim-bad.git",
                                          "bad-1", ["bad1"], "bad.java",
                                          simhash={"v": 1, "path": "z" * 17, "content": "0" * 16, "files": 1}))
    row_bad = server.store.repo(NS_BAD)
    check("非法 simhash 值：sync 仍 200", st == 200, (st, rbad))
    check("非法 simhash 不落库（保持 null）",
          row_bad["simhash_path"] is None and row_bad["simhash_at"] is None, row_bad)
    st, rbad2 = sync(NS_BAD, _sim_manifest("simbad01", "sim-bad", "https://git.example.com/team/sim-bad.git",
                                           "bad-2", ["bad1"], "bad.java",
                                           simhash={"v": 1, "path": "'; drop table repos; --",
                                                    "content": "0" * 16, "files": 1}))
    check("注入串 simhash：sync 200 且仍不落库",
          st == 200 and server.store.repo(NS_BAD)["simhash_path"] is None, (st, rbad2))

    # ---- overlap 门槛 / 无关 simhash
    NS_LOW = "simlow@fp1"
    st, rlow = sync(NS_LOW, _sim_manifest("simlow01", "sim-low", "https://git.example.com/team/sim-low.git",
                                          "low-1", A_SHARED[:5] + ["low1", "low2", "low3", "low4", "low5"],
                                          "low.java", simhash=SIM_OBJ, adopt=True, reuse="auto"))
    check("overlap 5/10 低于 0.80 → 不 adopt，missing 保持全量",
          st == 200 and "adopted" not in rlow and len(rlow.get("missing") or []) == 10, (st, rlow))
    NS_FAR = "simfar@fp1"
    far_obj = {"v": 1, "path": "0" * 16, "content": "0" * 16, "files": 1}
    st, rfar = sync(NS_FAR, _sim_manifest("simfar01", "sim-far", "https://git.example.com/team/sim-far.git",
                                          "far-1", ["far1", "far2"], "far.java",
                                          simhash=far_obj, adopt=True, reuse="auto"))
    check("无关 simhash → 不 adopt", st == 200 and "adopted" not in rfar, (st, rfar))

    # ---- 兼容只传 reuse 的客户端：reuse=auto 视为显式 adopt 开关；suggest 不复制
    NS_TB2 = "simtarg2@fp1"
    st, rtb2 = sync(NS_TB2, _sim_manifest(
        "simtarg02", "sim-target2", "https://git.example.com/team/sim-target-2.git",
        "tb2-1", A_SHARED + [STALE, B_NEW], "target2.java", simhash=SIM_OBJ, reuse="auto"))
    check("只传 reuse=auto（无 adopt 字段）→ 也执行 adopt（兼容当前插件契约）",
          st == 200 and (rtb2.get("adopted") or {}).get("vectors") == 8, rtb2.get("adopted") or rtb2)
    NS_TB3 = "simtarg3@fp1"
    st, rtb3 = sync(NS_TB3, _sim_manifest(
        "simtarg03", "sim-target3", "https://git.example.com/team/sim-target-3.git",
        "tb3-1", A_SHARED + [STALE, B_NEW], "target3.java", simhash=SIM_OBJ, reuse="suggest"))
    check("reuse=suggest（默认配置）不复制", st == 200 and "adopted" not in rtb3, (st, rtb3))

    # ---- 只在 full + 显式 adopt + reuse 非 off 时查询候选；adopt 失败不能拖垮 sync
    orig_similar = server.store.similar_lineages

    def _simhash_boom(*_args, **_kwargs):
        raise RuntimeError("simhash boom")

    server.store.similar_lineages = _simhash_boom
    try:
        st, roff = sync("simoff@fp1", _sim_manifest(
            "simoff01", "sim-off", "https://git.example.com/team/sim-off.git",
            "off-1", ["off1"], "off.java", simhash=SIM_OBJ, adopt=True, reuse="off"))
        check("reuse=off → 不查候选（sync 200，无 adopted / adoptError）",
              st == 200 and "adopted" not in roff and "adoptError" not in roff, roff)
        st, rno = sync("simnoflag@fp1", _sim_manifest(
            "simnf01", "sim-noflag", "https://git.example.com/team/sim-noflag.git",
            "nf-1", ["nf1"], "nf.java", simhash=SIM_OBJ))
        check("full 但无 adopt 开关 → 不查候选 / 不 adopt（不会对所有 sync 做候选查询）",
              st == 200 and "adopted" not in rno and "adoptError" not in rno, rno)
        diff_payload = _sim_manifest("simdf01", "sim-diff", "https://git.example.com/team/sim-diff.git",
                                     "df-1", ["df1"], "df.java", simhash=SIM_OBJ, adopt=True, reuse="auto")
        diff_payload["mode"] = "diff"
        st, rdiff = sync("simdiff@fp1", diff_payload)
        check("mode=diff + adopt 开关 → 仍不查候选",
              st == 200 and "adopted" not in rdiff and "adoptError" not in rdiff, rdiff)
        st, rfail = sync("simfail@fp1", _sim_manifest(
            "simfl01", "sim-fail", "https://git.example.com/team/sim-fail.git",
            "fl-1", ["fl1", "fl2"], "fl.java", simhash=SIM_OBJ, adopt=True, reuse="auto"))
        check("adopt 抛异常不影响 sync：200 + 正常 missing 清单",
              st == 200 and sorted(rfail.get("missing") or []) == ["fl1", "fl2"], rfail)
        check("adopt 失败被记录在 adoptError（不抛 500）", bool(rfail.get("adoptError")),
              rfail.get("adoptError"))
        row_fail = server.store.repo("simfail@fp1")
        fail_chunks = int(db.execute("select count(*) as n from chunks where namespace = ?",
                                     ("simfail@fp1",)).fetchone()["n"])
        check("adopt 失败回滚后目标 chunks 完好", row_fail is not None and fail_chunks == 2,
              (row_fail is not None, fail_chunks))
    finally:
        server.store.similar_lineages = orig_similar

    # ---- 旧客户端不带 simhash → null；后来带则每次 sync 更新
    NS_OLD = "simold@fp1"
    st, rold = sync(NS_OLD, _sim_manifest("simold01", "sim-old", "https://git.example.com/team/sim-old.git",
                                          "old-1", ["old1"], "old.java"))
    row_old = server.store.repo(NS_OLD)
    check("旧客户端不带 simhash → repos 保持 null（sync 仍 200）",
          st == 200 and row_old["simhash_path"] is None and row_old["simhash_at"] is None, row_old)
    st, _ = sync(NS_OLD, _sim_manifest("simold01", "sim-old", "https://git.example.com/team/sim-old.git",
                                       "old-2", ["old1"], "old.java",
                                       simhash={"v": 1, "path": "1" * 16, "content": "2" * 16, "files": 7}))
    row_old = server.store.repo(NS_OLD)
    first_simhash_at = row_old["simhash_at"]
    check("后来带 simhash 的 sync 会补上（含 files）",
          row_old["simhash_path"] == "1" * 16 and row_old["simhash_content"] == "2" * 16
          and row_old["simhash_files"] == 7 and isinstance(first_simhash_at, int), row_old)
    st, _ = sync(NS_OLD, _sim_manifest("simold01", "sim-old", "https://git.example.com/team/sim-old.git",
                                       "old-3", ["old1"], "old.java",
                                       simhash={"v": 2, "path": "3" * 16, "content": "4" * 16, "files": 8}))
    row_old = server.store.repo(NS_OLD)
    check("再次 sync 覆盖 simhash（含算法版本 / 时间戳）",
          row_old["simhash_path"] == "3" * 16 and row_old["simhash_algo"] == "2"
          and row_old["simhash_files"] == 8 and row_old["simhash_at"] >= first_simhash_at, row_old)
    bad_set = False
    try:
        server.store.set_simhash(NS_OLD, {"path": "zz", "content": "0" * 16})
    except ValueError:
        bad_set = True
    check("set_simhash 非法值抛 ValueError（明确失败，不静默写坏）", bad_set)

    # ---- legacy adopt 端点保持兼容（老调用不带 tag，按 hash 复制候选全部 tag）
    st, legacy_adopt = req("POST", f"/v1/lineages/{row_tb['lineage_id']}/adopt",
                           {"from": row_ca["lineage_id"], "hashes": [A_ONLY]})
    check("旧 POST /v1/lineages/{id}/adopt 仍兼容（按 hash 复制）",
          st == 200 and legacy_adopt.get("vectors") == 1, (st, legacy_adopt))

    srv.shutdown()
    print(f"\n通过 {PASS}，失败 {FAIL}")
    shutil.rmtree(TMP, ignore_errors=True)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
