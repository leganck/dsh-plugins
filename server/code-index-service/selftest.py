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

跑法：python selftest.py
"""
import base64
import gzip
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
          "code-index-service · 后台" in html and "作用域（快照）" in html and "/v1/scopes" in html)
    st, html_slash, _ = req_raw("/admin/")
    check("/admin/ 同样可用", st == 200 and "code-index-service" in html_slash)
    check("页面不再内嵌 API-Key 输入逻辑（改走 HTTP Basic）",
          "dshAdminKey" not in html and "localStorage" not in html)

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
        st, hdrs, _ = req_auth("/admin")
        check("无凭据访问 /admin → 401 + Basic challenge",
              st == 401 and "basic" in (hdrs.get("WWW-Authenticate") or "").lower(),
              (st, hdrs.get("WWW-Authenticate")))
        st, _, _ = req_auth("/admin", auth=bad)
        check("错误 Basic 凭据 → 401", st == 401, st)
        st, _, page = req_auth("/admin", auth=good)
        check("正确 Basic → /admin 200 html", st == 200 and "code-index-service" in page, st)
        st, _, body = req_auth("/v1/scopes", auth=good)
        check("正确 Basic → 后台数据接口放行", st == 200 and "scopes" in body, st)
        st, _, body = req_auth("/health", auth=good)
        check("正确 Basic → health 是完整版", st == 200 and "spaces" in json.loads(body), st)
        st, _, _ = req_auth("/v1/admin/pause", auth=good, method="POST", body={})
        check("正确 Basic → 后台治理接口放行", st == 200, st)
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
    check("后台包含「检索测试」与「模型与向量标签」卡片",
          "检索测试" in page and "模型与向量标签" in page)
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

    srv.shutdown()
    print(f"\n通过 {PASS}，失败 {FAIL}")
    shutil.rmtree(TMP, ignore_errors=True)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
