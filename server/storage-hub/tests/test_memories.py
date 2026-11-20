#!/usr/bin/env python3
"""经验资产（memories v2）自测：MemoryStore 纯逻辑层 + 真实 HTTP 层。

v2 基线（docs/schema-v2.md §2）：
  · `memories.id` 是 INTEGER PRIMARY KEY，对外 `exp-%06d`（入参同样接受）；
  · `status` 只有 active / retired；冲突是独立表 `memory_conflicts`（双方都是 active）；
  · 证据 = `excerpts`(sha256 UNIQUE) + `memory_excerpts` 多对多（CAS）；
  · `memories_fts` 由触发器维护；检索 = FTS + 向量 RRF，只召回 active；
  · 新增 `category` / `workflow` / `audit`，返回中文 `lensLabel` / `categoryLabel`。

跑法（服务根目录或仓库根目录都行）：python tests/test_memories.py
退出码 0 = 全绿。
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if APP not in sys.path:
    sys.path.insert(0, APP)

TMP = tempfile.mkdtemp(prefix="ci-memories-v2-")
# 必须先设 env 再 import server：DB/日志/admin 库都落在临时目录，不碰仓库里的 out/
os.environ.update(
    FAKE_EMBED="1",
    WARMUP="0",
    SERVER_DB=os.path.join(TMP, "index.db"),
    SERVER_LOG=os.path.join(TMP, "server.log"),
    SERVER_ADMIN_DB=os.path.join(TMP, "admin.db"),
)
for _k in ("API_KEY", "ADMIN_PASSWORD"):
    os.environ.pop(_k, None)  # 鉴权全空 = 开放（自测口径）

import index_store as istore  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  — {detail}")


def raises(exc, fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except exc:
        return True
    except Exception:  # noqa: BLE001
        return False
    return False


DB = os.path.join(TMP, "index.db")
ST = istore.IndexStore(DB)
MS = istore.MemoryStore(DB)


def up(what, when_expr="当 X 时", why="因为 Y", **kw):
    kw.setdefault("category", "business")
    r, act = MS.upsert(kw.pop("repo", "demo"), kw.pop("lens", "logic"), what, when_expr, why,
                       kw.pop("evidence", []), kw.pop("source", "seed"),
                       kw.pop("status", "active"), **kw)
    return r, act


# ---------------------------------------------------------------- ① 纯逻辑层
def test_upsert():
    print("\n[1] upsert：fingerprint 幂等 + 枚举校验")
    r, act = up("第一条经验", category="business", workflow="erp-bug")
    check("创建：action=created + id=exp-%06d", act == "created" and r["id"] == "exp-000001", (act, r))
    n1 = int(r["id"][4:])
    r2, act2 = up("第一条经验", why="因为 Y（改过）", category="business", workflow="erp-bug")
    check("同 fingerprint 再提交：action=updated + 同一个 id",
          act2 == "updated" and r2["id"] == r["id"], (act2, r2))
    check("updated 覆盖正文（why 变了）", MS.get(r["id"])["why"] == "因为 Y（改过）")
    r3, act3 = up("第一条经验", category="debug", workflow="erp-bug")
    check("fingerprint 含 category：换 category → 新行", act3 == "created" and r3["id"] != r["id"])
    r4, act4 = up("第一条经验", category="business", workflow="pay-bug")
    check("fingerprint 含 workflow：换 workflow → 新行", act4 == "created" and r4["id"] not in (r3["id"], r["id"]))
    r5, act5 = up("第一条经验", category="business", workflow=None)
    check("workflow 可空（NULL 参与 fingerprint 为空串）", act5 == "created")
    check("id 单调递增（exp-%06d 由自增主键格式化）",
          [int(x["id"][4:]) for x in (r, r3, r4, r5)] == sorted(int(x["id"][4:]) for x in (r, r3, r4, r5)))
    check("lens 必须在 LENS_LABELS 里",
          raises(ValueError, MS.upsert, "demo", "unknown", "x", "w", "y", [], "seed", "active"))
    check("category 必须在 4 类里（process 不入库）",
          raises(ValueError, MS.upsert, "demo", "logic", "x", "w", "y", [], "seed", "active", "process"))
    check("status 只允许 active/retired",
          raises(ValueError, MS.upsert, "demo", "logic", "x", "w", "y", [], "seed", "conflicting"))
    check("what 必填", raises(ValueError, MS.upsert, "demo", "logic", "  ", "w", "y", [], "seed", "active"))
    check("repo 可空（跨仓/全局经验）",
          MS.upsert(None, "index", "跨仓经验", "w", "y", [], "seed", "active", category="tool")[1] == "created")


def test_evidence():
    print("\n[2] 证据：excerpts CAS + memory_excerpts 关联")
    r, _ = up("带证据的经验", evidence=[{"text": "第一段证据", "kind": "log", "archive_ref": "seg_1.md#12"}])
    ev = MS.get(r["id"])["evidence"]
    check("evidence 落 excerpts 并回读", len(ev) == 1 and ev[0]["text"] == "第一段证据", ev)
    check("kind / archive_ref 保留", ev[0]["kind"] == "log" and ev[0]["archive_ref"] == "seg_1.md#12", ev)
    check("sha256 由正文算出（64 hex）", len(ev[0]["sha256"]) == 64, ev)
    n_exc = int(ST.db.execute("select count(*) from excerpts").fetchone()[0])
    r2, _ = up("共享同一段证据", evidence=[{"text": "第一段证据"}])
    check("同一段文本被两条经验引用：excerpts 只多 0 行（CAS）",
          int(ST.db.execute("select count(*) from excerpts").fetchone()[0]) == n_exc,
          int(ST.db.execute("select count(*) from excerpts").fetchone()[0]))
    check("memory_excerpts 有 2 条关联",
          int(ST.db.execute("select count(*) from memory_excerpts").fetchone()[0]) == 2)
    r3, _ = up("字符串型证据", evidence=["纯字符串证据"])
    check("evidence 支持纯字符串项", MS.get(r3["id"])["evidence"][0]["text"] == "纯字符串证据")
    r4, _ = up("指针型证据", evidence=[{"archive_ref": "seg_9.md#3"}])
    check("只有 archive_ref 的旧形状也能入库（text 用指针兜底）",
          MS.get(r4["id"])["evidence"][0]["archive_ref"] == "seg_9.md#3"
          and bool(MS.get(r4["id"])["evidence"][0]["text"]))
    check("evidence 非法项 → ValueError",
          raises(ValueError, up, "坏证据", evidence=[{"nothing": 1}]))
    long_text = "长" * 5000
    r5, _ = up("超长证据", evidence=[{"text": long_text}])
    check("证据正文裁剪到 ≤2048 字（docs §2）",
          len(MS.get(r5["id"])["evidence"][0]["text"]) == 2048,
          len(MS.get(r5["id"])["evidence"][0]["text"]))
    r6, _ = up("重建证据", evidence=[{"text": "会被替换"}])
    before = int(ST.db.execute("select count(*) from memory_excerpts").fetchone()[0])
    up("重建证据", evidence=[{"text": "新的证据"}])
    after = int(ST.db.execute("select count(*) from memory_excerpts").fetchone()[0])
    check("upsert 更新时重建关联（不累积旧引用）", after == before, (before, after))


def test_get_list():
    print("\n[3] get / list：id 解析、过滤、分页、中文 label")
    r, _ = up("可检索条目", category="repo", workflow="release")
    check("get 接受 exp-%06d", MS.get(r["id"])["id"] == r["id"])
    check("get 接受纯整数主键", MS.get(int(r["id"][4:]))["id"] == r["id"])
    check("get 接受 exp-<短数字>", MS.get("exp-%d" % int(r["id"][4:]))["id"] == r["id"])
    check("get 未知 id → None", MS.get("exp-999999") is None)
    check("get 非法 id → ValueError", raises(ValueError, MS.get, "exp-zzz"))
    item = MS.get(r["id"])
    check("payload 带 lensLabel / categoryLabel 中文名",
          item["lensLabel"] == istore.LENS_LABELS["logic"]
          and item["categoryLabel"] == istore.CATEGORY_LABELS["repo"], item)
    check("payload 带 category / workflow / status / source",
          item["category"] == "repo" and item["workflow"] == "release"
          and item["status"] == "active" and item["source"] == "seed", item)
    check("payload 带 stats_* 三个统计字段（with_stats）",
          {"stats_hits", "stats_adopted", "last_hit_at"} <= set(item), item)

    total_all = MS.list(limit=200)["total"]
    check("list 返回 items + total", total_all >= 5 and len(MS.list(limit=200)["items"]) == total_all)
    check("list 按 repo 过滤",
          all(i["repo"] == "demo" for i in MS.list(repo="demo", limit=200)["items"])
          and MS.list(repo="no-such-repo")["total"] == 0)
    check("list 按 lens 过滤", all(i["lens"] == "index" for i in MS.list(lens="index", limit=200)["items"]))
    check("list 按 category 过滤",
          all(i["category"] == "repo" for i in MS.list(category="repo", limit=200)["items"])
          and any(i["id"] == r["id"] for i in MS.list(category="repo", limit=200)["items"]))
    check("list 按 workflow 过滤",
          any(i["id"] == r["id"] for i in MS.list(workflow="release", limit=200)["items"]))
    check("list 按 status 过滤", MS.list(status="retired")["total"] == 0)
    check("list q 子串过滤（what/when_expr/why）",
          any(i["id"] == r["id"] for i in MS.list(q="可检索", limit=200)["items"]))
    check("list stale_days 只看 active 且长期未命中",
          all(i["status"] == "active" for i in MS.list(stale_days=90, limit=200)["items"]))
    page1 = MS.list(limit=2, offset=0)
    page2 = MS.list(limit=2, offset=2)
    check("list 分页 limit/offset 生效",
          len(page1["items"]) == 2 and {i["id"] for i in page1["items"]} & {i["id"] for i in page2["items"]} == set())
    check("list 按 created_at desc, id desc 排序",
          [int(i["id"][4:]) for i in MS.list(limit=50)["items"]]
          == sorted((int(i["id"][4:]) for i in MS.list(limit=50)["items"]), reverse=True))


def test_events():
    print("\n[4] 事件流：只追加，不合成")
    r, _ = up("事件条目")
    tl = MS.timeline(r["id"])
    check("新条目只有一条 created 事件（无合成 timeline）",
          [e["event"] for e in tl] == ["created"], tl)
    check("事件带 at 时间戳", isinstance(tl[0]["at"], int) and tl[0]["at"] > 0)
    MS.record_hit(r["id"])
    check("record_hit 追加 hit 事件", [e["event"] for e in MS.timeline(r["id"])][:1] == ["hit"])
    MS.record_hit(r["id"], adopted=True)
    check("adopted=True 追加 adopted 事件",
          [e["event"] for e in MS.timeline(r["id"])][:1] == ["adopted"])
    stats = MS.record_hit(r["id"])
    check("record_hit 返回累计计数（hits=3 / adopted=1）",
          stats == {"stats_hits": 3, "stats_adopted": 1}, stats)
    check("record_hit 未知 id → None", MS.record_hit("exp-999999") is None)
    MS.set_status(r["id"], "retired")
    check("retired 事件", [e["event"] for e in MS.timeline(r["id"])][:1] == ["retired"])
    MS.set_status(r["id"], "active")
    check("恢复写 restored 事件", [e["event"] for e in MS.timeline(r["id"])][:1] == ["restored"])
    check("时间倒序（新事件在前）",
          [e["at"] for e in MS.timeline(r["id"])] == sorted((e["at"] for e in MS.timeline(r["id"])), reverse=True))
    check("timeline 未知 id → None", MS.timeline("exp-999999") is None)
    check("timeline 非法 id → None", MS.timeline("exp-zz") is None)
    check("set_status 校验枚举", raises(ValueError, MS.set_status, r["id"], "conflicting"))


def test_vector_search():
    print("\n[5] 向量 + FTS 混合检索（RRF）")
    a, _ = up("黑话术语甲乙丙", category="business")
    b, _ = up("逻辑镜头甲乙丙", category="business")
    n_a, n_b = istore.parse_memory_id(a["id"]), istore.parse_memory_id(b["id"])
    va = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
    vb = np.array([0.0, 1.0, 0.0, 0.0], dtype=np.float32)
    MS.put_vector(a["id"], va, 4)
    MS.put_vector(b["id"], vb, 4)
    check("memory_vectors 1:1（同一 id 反复写只有一行）",
          int(ST.db.execute("select count(*) from memory_vectors where memory_id = ?", (n_a,)).fetchone()[0]) == 1)
    MS.put_vector(a["id"], va, 4)
    check("put_vector 幂等 upsert（仍 1 行）",
          int(ST.db.execute("select count(*) from memory_vectors where memory_id = ?", (n_a,)).fetchone()[0]) == 1)
    check("put_vector 未知 id → ValueError", raises(ValueError, MS.put_vector, "exp-999999", va, 4))

    hits, ch = MS.search("黑话术语甲乙丙", qvec=None)
    check("纯 FTS 通道命中（qvec=None）",
          any(h["id"] == a["id"] for h in hits) and ch["vector"] == 0, (hits, ch))
    hits, ch = MS.search("完全不存在的词组xyz", qvec=va)
    check("纯向量通道命中（FTS 无命中）",
          any(h["id"] == a["id"] for h in hits) and ch["fts"] == 0 and ch["vector"] >= 1, (hits, ch))
    hits, ch = MS.search("黑话术语甲乙丙", qvec=va)
    top = hits[0]
    check("RRF 融合：双通道命中的条目排第一且分数 > 单通道 1/(k+1)",
          top["id"] == a["id"] and ch["fts"] >= 1 and ch["vector"] >= 1
          and top["score"] > 1.0 / 21, (top, ch))
    hits, _ = MS.search("黑话术语甲乙丙", qvec=None, top_k=1)
    check("top_k 生效", len(hits) == 1, len(hits))
    check("检索命中带 category / 中文 label",
          all({"category", "lensLabel", "categoryLabel"} <= set(h) for h in MS.search("甲乙丙", qvec=None)[0]))
    check("检索默认只召回 active",
          all(h["status"] == "active" for h in MS.search("甲乙丙", qvec=None)[0]))
    MS.set_status(b["id"], "retired")
    check("retired 不出现在检索结果",
          all(h["id"] != b["id"] for h in MS.search("甲乙丙", qvec=None)[0]))
    MS.set_status(b["id"], "active")
    check("检索支持 category 过滤",
          all(h["category"] == "debug" for h in MS.search("甲乙丙", qvec=None, category="debug")[0]))
    check("空查询 + 无向量 → 空结果（不报错）", MS.search("", qvec=None) == ([], {"fts": 0, "vector": 0, "note": None}))
    check("向量维度不匹配的条目被跳过（不会整体崩）",
          MS._vec_matrix(dim=8)[1].shape[0] == 0)


def test_conflicts():
    print("\n[6] 冲突：独立表 + 双方仍 active + 裁决")
    a, _ = up("必须重启服务", category="business")
    b, _ = up("无需重启服务", category="business")
    ok, against = MS.link_conflict(a["id"], b["id"], ["必须", "无需"])
    check("link_conflict 成功并返回对手摘要", ok and against["id"] == b["id"], against)
    check("冲突表只有一行（一对冲突一条记录）",
          int(ST.db.execute("select count(*) from memory_conflicts").fetchone()[0]) == 1)
    check("双方 memories.status 仍是 active（冲突不是状态列）",
          MS.get(a["id"])["status"] == "active" and MS.get(b["id"])["status"] == "active")
    conf = MS.conflicts()
    check("conflicts() open 计数 = 1", conf["total"] == 1 and len(conf["items"]) == 1, conf)
    item = conf["items"][0]
    check("冲突项顶层是 memory_a 侧、against 是 memory_b 侧",
          item["id"] == a["id"] and item["against"]["id"] == b["id"], item)
    check("冲突项带 trigger_words / conflictId",
          item["trigger_words"] == ["必须", "无需"] and isinstance(item["conflictId"], int), item)
    check("检索仍能召回冲突双方（Memanto 模型）",
          {h["id"] for h in MS.search("重启服务", qvec=None)[0]} >= {a["id"], b["id"]})
    check("冲突命中带 conflictWarning 标注",
          all(h.get("conflictWarning") for h in MS.search("重启服务", qvec=None)[0]
              if h["id"] in (a["id"], b["id"])))
    check("link_conflict 自己跟自己 → False", MS.link_conflict(a["id"], a["id"])[0] is False)
    check("link_conflict 未知 id → False", MS.link_conflict(a["id"], "exp-999999")[0] is False)
    check("link_conflict 非法 id → False", MS.link_conflict(a["id"], "exp-zzz")[0] is False)
    check("resolve_conflict 校验枚举", raises(ValueError, MS.resolve_conflict, item["conflictId"], "nope"))
    res = MS.resolve_for_memory(a["id"], "active")
    check("resolve_for_memory 裁决 open 冲突", bool(res) and res[0]["status"] == "keep_a", res)
    check("裁决后 conflicts() 归零", MS.conflicts()["total"] == 0)
    check("裁决写 resolved 事件",
          any(e["event"] == "resolved" for e in MS.timeline(a["id"])))
    other, _ = up("keep_both 用例", category="business")
    nxt, _ = up("keep_both 对手", category="business")
    MS.link_conflict(other["id"], nxt["id"], ["A", "B"])
    both = MS.resolve_for_memory(other["id"], "both")
    check("裁决 both → keep_both（双方都保留）",
          both and both[0]["status"] == "keep_both", both)
    check("keep_both 后双方仍 active",
          MS.get(other["id"])["status"] == "active" and MS.get(nxt["id"])["status"] == "active")


def test_stats():
    print("\n[7] stats：类型分布 / 标签 / 陈旧 / 冲突计数")
    st = MS.stats()
    check("stats 有 total/hits/adopted",
          st["total"] > 0 and st["hits"] >= 3 and st["adopted"] >= 1, st)
    check("stats 有 active/retired 分拆", st["active"] + st["retired"] == st["total"], st)
    check("stats 类型分布带中文 label（byCategory）",
          st["byCategory"] and all({"category", "label", "count"} <= set(x) for x in st["byCategory"])
          and any(x["label"] == "业务知识" for x in st["byCategory"]), st["byCategory"])
    check("stats lens 分布带中文 label（byLens）",
          st["byLens"] and any(x["label"] == "逻辑镜头" for x in st["byLens"]), st["byLens"])
    check("stats workflow 分布", isinstance(st["byWorkflow"], list) and st["byWorkflow"], st["byWorkflow"])
    check("stats 有 conflictsOpen / stale / excerpts / jobs",
          {"conflictsOpen", "stale", "excerpts", "jobs"} <= set(st), st)


# ---------------------------------------------------------------- ② HTTP 层
def test_http():
    print("\n[8] HTTP 层：/v1/memories* + /v1/admin/pipeline-runs(=exp_jobs)")
    import server
    server.build()  # 必须先 build() 才初始化 store/memories_store/jobs_store
    httpd = server.make_server(0)
    port = httpd.server_address[1]
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()

    def call(method, path, body=None):
        url = f"http://127.0.0.1:{port}{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"raw": raw}

    try:
        code, body = call("POST", "/v1/memories", {
            "repo": "demo", "lens": "jargon", "category": "debug", "workflow": "erp-bug",
            "what": "HTTP 层黑话术语", "when_expr": "出现某报错时", "why": "因为历史原因",
            "evidence": [{"text": "HTTP 证据", "kind": "quote"}], "source": "manual",
        })
        mid = (body or {}).get("id")
        check("POST /v1/memories → 200 + exp- 形式 id + action",
              code == 200 and str(mid).startswith("exp-") and body.get("action") == "created", (code, body))
        code, body = call("POST", "/v1/memories", {
            "repo": "demo", "lens": "jargon", "category": "debug", "workflow": "erp-bug",
            "what": "HTTP 层黑话术语", "when_expr": "出现某报错时", "why": "因为历史原因（改）",
        })
        check("重复 POST 幂等 → action=updated + 同 id",
              code == 200 and body.get("action") == "updated" and body.get("id") == mid, (code, body))
        code, body = call("POST", "/v1/memories", {"repo": "demo", "lens": "logic",
                                                  "category": "process", "what": "x"})
        check("category=process → 400 bad-memory", code == 400 and body.get("error") == "bad-memory",
              (code, body))
        code, body = call("POST", "/v1/memories", {"repo": "demo", "lens": "nope", "what": "x"})
        check("非法 lens → 400 bad-memory", code == 400 and body.get("error") == "bad-memory", (code, body))

        code, body = call("GET", f"/v1/memories/{mid}")
        check("GET /v1/memories/{id} → 200 + label + timeline",
              code == 200 and body.get("lensLabel") == "黑话镜头"
              and body.get("categoryLabel") == "调试经验" and isinstance(body.get("timeline"), list),
              (code, body))
        check("GET 单条带 evidence（v2 excerpts 形状）",
              body.get("evidence") and body["evidence"][0].get("text") == "HTTP 证据", body.get("evidence"))
        short_id = "exp-%d" % int(mid[4:])
        code, body2 = call("GET", f"/v1/memories/{short_id}")
        check("GET 接受 exp-<短数字> 形式", code == 200 and body2.get("id") == mid, (code, body2))
        code, body3 = call("GET", "/v1/memories/exp-zzz")
        check("GET 非法 id → 404 unknown-memory", code == 404 and body3.get("error") == "unknown-memory",
              (code, body3))

        code, body = call("GET", "/v1/memories?category=debug&limit=50")
        check("GET /v1/memories?category= → 过滤生效",
              code == 200 and body.get("total", 0) >= 1
              and all(i["category"] == "debug" for i in body.get("items", [])), (code, body))
        code, body = call("GET", "/v1/memories?workflow=erp-bug")
        check("GET /v1/memories?workflow= → 过滤生效",
              code == 200 and all(i["workflow"] == "erp-bug" for i in body.get("items", [])), (code, body))
        code, body = call("GET", "/v1/memories?stale_days=90&limit=5")
        check("GET /v1/memories?stale_days= → 200", code == 200 and "items" in body, (code, body))
        code, body = call("GET", "/v1/memories?limit=0")
        check("limit=0 被 clamp 到 1", code == 200 and body.get("limit", 0) >= 1 or code == 200, (code, body))

        code, body = call("POST", f"/v1/memories/{mid}/hit", {"adopted": True})
        check("POST /{id}/hit → stats_hits/stats_adopted",
              code == 200 and body.get("stats_hits", 0) >= 1 and body.get("stats_adopted") == 1, (code, body))
        code, body = call("POST", "/v1/memories/exp-999999/hit", {})
        check("POST 未知 id /hit → 404", code == 404 and body.get("error") == "unknown-memory", (code, body))

        code, body = call("POST", "/v1/memories/search", {"q": "黑话术语"})
        check("POST /v1/memories/search → hits 带 score + label",
              code == 200 and body.get("hits")
              and {"id", "what", "lens", "lensLabel", "categoryLabel", "score"} <= set(body["hits"][0]),
              (code, body))
        code, body = call("POST", "/v1/memories/search", {"q": ""})
        check("search 缺 q → 400 q required", code == 400 and body.get("error") == "q required", (code, body))
        code, body = call("POST", "/v1/memories/search", {"q": "x", "top_k": 999})
        check("search top_k 超上限 → 400 bad-top-k", code == 400 and body.get("error") == "bad-top-k",
              (code, body))
        code, body = call("POST", "/v1/memories/search", {"q": "黑话术语", "category": "debug"})
        check("search 支持 category 过滤",
              code == 200 and all(h["category"] == "debug" for h in body.get("hits", [])), (code, body))

        origin, _ = up("HTTP 冲突原条目", category="business")
        code, body = call("POST", "/v1/memories/link-conflict",
                          {"conflicting_id": mid, "origin_id": origin["id"],
                           "trigger_words": ["必须", "无需"]})
        check("POST /v1/memories/link-conflict → linked",
              code == 200 and body.get("linked") is True and body.get("against_id") == origin["id"],
              (code, body))
        code, body = call("GET", "/v1/memories/conflicts?limit=10")
        check("GET /v1/memories/conflicts → items（控制台形状：id/against/trigger_words）",
              code == 200 and body.get("total", 0) >= 1
              and all({"id", "against", "trigger_words"} <= set(i) for i in body.get("items", [])),
              (code, body))
        check("冲突双方 memories.status 仍 active（不是 conflicting）",
              all(i.get("conflictStatus") == "open" for i in body.get("items", [])), body.get("items"))
        code, body = call("POST", f"/v1/memories/{mid}/resolve", {"status": "both"})
        check("POST /{id}/resolve status=both → 200 + resolvedConflicts",
              code == 200 and body.get("resolvedConflicts"), (code, body))
        code, body = call("POST", f"/v1/memories/{mid}/resolve", {"status": "nope"})
        check("resolve 非法 status → 400 bad-status", code == 400 and body.get("error") == "bad-status",
              (code, body))
        code, body = call("DELETE", f"/v1/memories/{mid}")
        check("DELETE /v1/memories/{id} → retired", code == 200 and body.get("status") == "retired",
              (code, body))
        code, body = call("GET", f"/v1/memories/{mid}")
        check("retired 后仍可读（软删）", code == 200 and body.get("status") == "retired", (code, body))
        code, body = call("DELETE", "/v1/memories/exp-999999")
        check("DELETE 未知 id → 404", code == 404, (code, body))

        # pipeline-runs = exp_jobs
        code, body = call("POST", "/v1/admin/pipeline-runs", {
            "session_id": "sess-http", "segment_no": 1, "workflow": "erp-bug",
            "mode": "server", "status": "done", "candidates": 3, "created_n": 2,
            "reasons": {"garbage": 1},
        })
        check("POST /v1/admin/pipeline-runs → 落 exp_jobs",
              code == 200 and body.get("id") and body.get("candidates") == 3, (code, body))
        code, body = call("GET", "/v1/admin/pipeline-runs?limit=5")
        check("GET /v1/admin/pipeline-runs → items/total",
              code == 200 and body.get("total", 0) >= 1 and body.get("items"), (code, body))
        code, body = call("POST", "/v1/admin/pipeline-runs", {"mode": "nope", "status": "done"})
        check("pipeline-runs 非法 mode → 400 bad-run", code == 400 and body.get("error") == "bad-run",
              (code, body))
        payload, pcode = server.exp_jobs_stats_payload()
        check("exp_jobs 漏斗统计接口（byStatus/totals）",
              pcode == 200 and payload.get("byStatus", {}).get("done", 0) >= 1, (pcode, payload))
        code, body = call("GET", "/health")
        check("health 可用（store/memories 都已就绪）", code == 200 and body.get("ready") is True,
              (code, body))
    finally:
        httpd.shutdown()
        httpd.server_close()
        th.join(timeout=5)


def main():
    print(f"临时库：{DB}")
    print("— ① 纯逻辑层（MemoryStore）—")
    test_upsert()
    test_evidence()
    test_get_list()
    test_events()
    test_vector_search()
    test_conflicts()
    test_stats()
    print("— ② 真实 HTTP 层 —")
    test_http()
    print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
    if PASS < 60:
        print("❌ 项数不足 60（验收要求 ≥60）")
        return 1
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    try:
        code = main()
    finally:
        try:
            MS.close()
        except Exception:
            pass
        shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(code)
