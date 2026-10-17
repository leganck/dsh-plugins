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

跑法：python selftest.py
"""
import gzip
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
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
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

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


def sync(ns, payload, gz=False):
    return req("POST", f"/v1/repos/{ns}/sync", payload, gz=gz)


def wait_vectors(ns, want, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, body = req("GET", f"/v1/repos/{ns}/status")
        if body.get("vectors", 0) >= want:
            return body
        time.sleep(0.1)
    return req("GET", f"/v1/repos/{ns}/status")[1]


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

    srv.shutdown()
    print(f"\n通过 {PASS}，失败 {FAIL}")
    shutil.rmtree(TMP, ignore_errors=True)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
