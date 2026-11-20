#!/usr/bin/env python3

"""经验资产（memories）端点自测：/v1/memories 全套 8 个端点。

不需要 onnxruntime：FAKE_EMBED=1 时 server 用 FakeEmbedder stub（向量由文本哈希确定），
另有一个「embedder 不可用」的降级用例（vectorNote + 纯 FTS 检索）。

两层验证（与 test_bodies.py 同骨架）：
  ① 纯逻辑层：直接调 memory_*_payload()（upsert 幂等 / 检索 RRF / 计数 / 软删 / 冲突队列 / 分页）；
  ② 真实 HTTP 层：make_server(0) 起 http.server，验证路由不互吞
     （/search、/conflicts、/{id}、/{id}/hit、/{id}/resolve）与错误风格。

跑法（服务根目录或仓库根目录都行）：
    python tests/test_memories.py

退出码 0 = 全绿。
"""
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

TMP = tempfile.mkdtemp(prefix="ci-memories-test-")
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

import numpy as np  # noqa: E402

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


st = istore.IndexStore(os.path.join(TMP, "index.db"))
ms = istore.MemoryStore(st.db)
server.store = st
server.memories_store = ms
server.state["ready"] = True
# embedder stub：FAKE_EMBED=1 只影响 build()，本测试不跑 build() → 显式注入 FakeEmbedder
# （向量由文本哈希确定且 L2 归一化；query 侧前缀体现在 seed 里，见 FakeEmbedder.embed）。
server.embedder = server.FakeEmbedder(dim=16)


def upsert(repo, lens, what, when_expr="2026-11", why="原因", evidence=None,
           source="pipeline", status=None):
    body = {"repo": repo, "lens": lens, "what": what, "when_expr": when_expr,
            "why": why, "evidence": evidence if evidence is not None else [], "source": source}
    if status:
        body["status"] = status
    return server.memory_upsert_payload(body)


# ---------------------------------------------------------------- ① 纯逻辑层
def test_logic():
    # 1) upsert：created → id 格式 exp-6 位
    payload, code = upsert("demo", "code-style", "禁止用明文密码提交代码", evidence=[
        {"issue": "CHGJ-1"}, {"mr": "!123"},
    ])
    check("upsert 创建 → 200 + id=exp-000001", code == 200 and payload.get("id") == "exp-000001",
          f"code={code} {payload}")
    check("action=created", payload.get("action") == "created", repr(payload))
    check("无向量失败时不带 vectorNote（stub 可用）", "vectorNote" not in payload, repr(payload))

    # 2) upsert 幂等：同 (repo,lens,what) 二次写 → action=updated 且不重复行
    payload2, code2 = upsert("demo", "code-style", "禁止用明文密码提交代码",
                             when_expr="2026-12", why="更新后的原因", evidence=[{"mr": "!77"}])
    check("upsert 幂等 → 同 id + action=updated",
          code2 == 200 and payload2.get("id") == "exp-000001"
          and payload2.get("action") == "updated", f"code={code2} {payload2}")
    rows = st.db.execute("select count(*) from memories").fetchone()[0]
    fts_rows = st.db.execute("select count(*) from memories_fts").fetchone()[0]
    check("幂等后表里仍只有 1 行（memories 与 memories_fts）", rows == 1 and fts_rows == 1,
          f"memories={rows} fts={fts_rows}")
    item, _ = server.memory_get_payload("exp-000001")
    check("updated 覆盖 when_expr/why", item.get("when_expr") == "2026-12"
          and item.get("why") == "更新后的原因", repr(item)[:300])
    check("evidence JSON 往返（updated 覆盖为新值）", item.get("evidence") == [{"mr": "!77"}],
          repr(item.get("evidence")))

    # 3) 自增 id：第二条 exp-000002
    p3, _ = upsert("demo", "release", "发版前必须跑 selftest 274 项")
    p4, _ = upsert("other", "deploy", "deploy 用 flow.verifyEnv 环境")
    check("id 自增 exp-000002 / exp-000003",
          p3.get("id") == "exp-000002" and p4.get("id") == "exp-000003",
          f"{p3} {p4}")

    # 4) 校验错误：缺 what / 非法 status / evidence 非数组
    payload, code = upsert("demo", "x", "")
    check("缺 what → 400 bad-memory", code == 400 and payload.get("error") == "bad-memory",
          f"code={code} {payload}")
    payload, code = upsert("demo", "x", "内容", status="bogus")
    check("非法 status → 400", code == 400 and payload.get("error") == "bad-memory",
          f"code={code} {payload}")
    payload, code = upsert("demo", "x", "内容", evidence="not-a-list")
    check("evidence 非数组 → 400", code == 400, f"code={code} {payload}")
    payload, code = upsert("demo", "x", "内容", evidence=[{"nothing": 1}])
    check("evidence 项缺 archive_ref/issue/mr → 400", code == 400, f"code={code} {payload}")

    # 5) search：FTS 命中（中文连续段 = trigram 子串）。
    #    向量通道在 stub 下是确定性随机的（query 侧有 Q: 前缀，与入库向量独立），
    #    所以「排名/分值」用存储层纯 FTS（qvec=None）断言，payload 层只断言命中。
    payload, code = server.memory_search_payload({"q": "明文密码", "top_k": 5})
    check("search FTS 命中 → 200", code == 200, f"code={code} {payload}")
    hits = payload.get("hits") or []
    check("exp-000001 在命中里且字段符合契约",
          any(h["id"] == "exp-000001" for h in hits) and set(hits[0]) ==
          {"id", "what", "when_expr", "why", "lens", "repo", "score"},
          repr(hits)[:400])
    check("有 ms 字段", isinstance(payload.get("ms"), (int, float)) and payload["ms"] >= 0,
          repr(payload.get("ms")))
    pure_fts, ch = ms.search("明文密码", qvec=None, top_k=5)
    check("纯 FTS（qvec=None）：exp-000001 排第一，score=1/(20+1)",
          pure_fts and pure_fts[0]["id"] == "exp-000001"
          and abs(pure_fts[0]["score"] - 1 / 21) < 1e-6 and ch["vector"] == 0,
          repr([(h["id"], h["score"]) for h in pure_fts]))

    # 6) search：repo/lens 过滤 + top_k
    payload, _ = server.memory_search_payload({"q": "selftest", "repo": "other"})
    check("search repo 过滤：别的仓库查不到", (payload.get("hits") or []) == [], repr(payload)[:300])
    payload, _ = server.memory_search_payload({"q": "selftest", "repo": "demo", "lens": "release"})
    check("search repo+lens 过滤命中", len(payload.get("hits") or []) == 1
          and payload["hits"][0]["id"] == "exp-000002", repr(payload)[:300])
    payload, code = server.memory_search_payload({"q": "x", "top_k": 0})
    check("top_k 越界 → 400", code == 400 and payload.get("error") == "bad-top-k",
          f"code={code} {payload}")
    payload, code = server.memory_search_payload({})
    check("缺 q → 400", code == 400 and payload.get("error") == "q required",
          f"code={code} {payload}")

    # 7) RRF 融合（存储层确定性断言）：拿库里 exp-000001 的向量当查询向量 →
    #    该条目 FTS+向量双通道命中，RRF = 1/21 + 1/21，必大于任何单通道条目。
    row = st.db.execute(
        "select mv.v from memories_vec mv join memories m on m.rowid = mv.mid where m.id = ?",
        ("exp-000001",),
    ).fetchone()
    qvec_own = np.frombuffer(row["v"], dtype=np.float32)
    fused, _ch = ms.search("明文密码", qvec=qvec_own, top_k=10)
    fused_map = {h["id"]: h["score"] for h in fused}
    check("双通道命中（≈2/21=0.0952）高于任何单通道条目",
          abs(fused_map.get("exp-000001", 0) - 2 / 21) < 1e-5
          and fused_map["exp-000001"] > max(
              (s for i, s in fused_map.items() if i != "exp-000001"), default=0.0),
          repr(fused_map))

    # 8) hit / adopted 计数
    payload, code = server.memory_hit_payload("exp-000001", {"adopted": True})
    check("hit adopted=true → 计数 1/1",
          code == 200 and payload == {"stats_hits": 1, "stats_adopted": 1}, f"code={code} {payload}")
    payload, _ = server.memory_hit_payload("exp-000001", {})
    check("hit 不带 adopted → 只加 hits", payload == {"stats_hits": 2, "stats_adopted": 1},
          repr(payload))
    item, _ = server.memory_get_payload("exp-000001")
    check("last_hit_at 已落库", isinstance(item.get("last_hit_at"), int), repr(item.get("last_hit_at")))
    payload, code = server.memory_hit_payload("exp-999999", {})
    check("hit 未知 id → 404", code == 404 and payload.get("error") == "unknown-memory",
          f"code={code} {payload}")

    # 9) conflicts 队列：conflicting 状态的条目
    p5, _ = upsert("demo", "conflict-lens", "冲突条目 A", status="conflicting")
    payload, code = server.memory_conflicts_payload()
    check("conflicts 只列 conflicting", code == 200 and payload.get("total") == 1
          and payload["items"][0]["id"] == p5["id"], repr(payload)[:300])
    payload, code = server.memory_resolve_payload(p5["id"], {"status": "active"})
    check("resolve → active", code == 200 and payload == {"id": p5["id"], "status": "active"},
          f"code={code} {payload}")
    payload, _ = server.memory_conflicts_payload()
    check("resolve 后队列为空", payload.get("total") == 0, repr(payload)[:200])
    payload, code = server.memory_resolve_payload(p5["id"], {"status": "bogus"})
    check("resolve 非法 status → 400", code == 400 and payload.get("error") == "bad-status",
          f"code={code} {payload}")

    # 10) 软删：DELETE → retired；search 不出（该条目本身），但列表按 status=retired 仍可见
    payload, code = server.memory_delete_payload("exp-000002")
    check("软删 → 200 retired", code == 200 and payload == {"id": "exp-000002", "status": "retired"},
          f"code={code} {payload}")
    payload, _ = server.memory_search_payload({"q": "selftest"})
    check("软删后 search 查不到该条目",
          all(h["id"] != "exp-000002" for h in payload.get("hits") or []), repr(payload)[:400])
    payload, _ = server.memory_list_payload(status="retired")
    check("列表按 status=retired 仍可见", payload.get("total") == 1
          and payload["items"][0]["id"] == "exp-000002", repr(payload)[:300])
    payload, code = server.memory_delete_payload("exp-999999")
    check("DELETE 未知 id → 404", code == 404, f"code={code} {payload}")
    payload, code = server.memory_get_payload("exp-999999")
    check("GET 未知 id → 404 unknown-memory", code == 404
          and payload.get("error") == "unknown-memory", f"code={code} {payload}")

    # 11) 分页与过滤
    for i in range(6):
        upsert("page-repo", "lens-a", f"分页样例条目 {i}")
    payload, _ = server.memory_list_payload(repo="page-repo", limit=2, offset=0)
    total_all = payload.get("total")
    payload2, _ = server.memory_list_payload(repo="page-repo", limit=2, offset=2)
    check("分页 limit/offset 生效（两页不重叠）",
          total_all == 6 and len(payload["items"]) == 2 and len(payload2["items"]) == 2
          and {it["id"] for it in payload["items"]}.isdisjoint({it["id"] for it in payload2["items"]}),
          f"total={total_all} p1={[i['id'] for i in payload['items']]} p2={[i['id'] for i in payload2['items']]}")
    payload, _ = server.memory_list_payload(repo="page-repo", q="条目 3")
    check("列表 q 子串过滤", payload.get("total") == 1, repr(payload)[:300])
    payload, _ = server.memory_list_payload(repo="page-repo", lens="lens-a", limit=200)
    check("lens 过滤 + limit 上限 200 可用", payload.get("total") == 6, repr(payload)[:200])
    payload, code = server.memory_list_payload(repo="page-repo", limit="abc")
    check("limit 非法 → 400 bad-pagination", code == 400 and payload.get("error") == "bad-pagination",
          f"code={code} {payload}")

    # 12) embedder 不可用：向量缺省，FTS 仍可用并注明 vectorNote
    old_embedder = server.embedder
    server.embedder = None
    try:
        payload, code = upsert("novec", "lens", "无模型时的经验")
        check("embedder 缺席时 upsert 仍 200 且带 vectorNote",
              code == 200 and payload.get("action") == "created"
              and "vectorNote" in payload, f"code={code} {payload}")
        payload, code = server.memory_search_payload({"q": "无模型"})
        check("embedder 缺席时 search 走 FTS 且带 vectorNote",
              code == 200 and len(payload.get("hits") or []) == 1
              and "vectorNote" in payload, f"code={code} {payload}")
    finally:
        server.embedder = old_embedder

    # 13) MemoryStore 统计（admin stats 用）
    stats = ms.stats()
    check("stats() 汇总条目/命中/采纳", stats["total"] == st.db.execute(
        "select count(*) from memories").fetchone()[0] and stats["hits"] >= 2
        and stats["adopted"] >= 1, repr(stats))

    # 14) 分组与统计分类（验收 5）
    check("_endpoint_group(/v1/memories/*) == memories",
          server._endpoint_group("/v1/memories") == "memories"
          and server._endpoint_group("/v1/memories/exp-000001") == "memories"
          and server._endpoint_group("/v1/memories/search") == "memories"
          and server._endpoint_group("/v1/memories/exp-000001/hit") == "memories",
          server._endpoint_group("/v1/memories/exp-000001/hit"))
    check("memories 端点组计入 retrieval 统计类（四类口径不变）",
          server._stats_category("memories") == "retrieval",
          server._stats_category("memories"))

    # 15) 治理可见性：pipeline_runs 上报/列表/覆盖
    run_payload, code = server.pipeline_run_report_payload({
        "run_id": "run-gov-001", "engine": "rules", "dry_run": False,
        "started_at": 1700000000, "finished_at": 1700000042,
        "candidates": 10, "review_passed": 8, "review_blocked": 2,
        "dedup_kept": 7, "dedup_merged": 1,
        "actions": {"create": 5, "update": 1, "skip": 1, "contradict": 1},
        "details": {"blocked": [{"what": "x", "reasons": ["missing_when"]}]},
    })
    check("pipeline-runs 上报 → 200 且回显计数", code == 200
          and run_payload.get("run_id") == "run-gov-001"
          and run_payload.get("candidates") == 10
          and run_payload.get("actions", {}).get("contradict") == 1,
          f"code={code} {run_payload}")
    server.pipeline_run_report_payload({
        "run_id": "run-gov-002", "engine": "rules", "dry_run": True,
        "started_at": 1700000100, "finished_at": 1700000110, "candidates": 3,
    })
    listed, code = server.pipeline_runs_list_payload(limit=10)
    check("pipeline-runs 列表按 started_at 倒序", code == 200 and listed.get("total") == 2
          and listed["items"][0]["run_id"] == "run-gov-002"
          and listed["items"][1]["run_id"] == "run-gov-001"
          and listed["items"][0]["dry_run"] is True,
          f"code={code} {listed}"[:300])
    again, _ = server.pipeline_run_report_payload({
        "run_id": "run-gov-001", "engine": "rules", "candidates": 99,
        "started_at": 1700000200, "finished_at": 1700000210,
    })
    listed2, _ = server.pipeline_runs_list_payload(limit=10)
    check("pipeline-runs 同 run_id 重复上报覆盖（不新增行）",
          listed2.get("total") == 2 and again.get("candidates") == 99
          and listed2["items"][0]["run_id"] == "run-gov-001",
          f"{again} {listed2}"[:300])
    payload, code = server.pipeline_run_report_payload({"engine": "rules"})
    check("pipeline-runs 缺 run_id → 400 bad-run", code == 400
          and payload.get("error") == "bad-run", f"code={code} {payload}")

    # 16) link-conflict：双方 against_id 互指 + trigger_words 存 conflicting 行
    p_origin, _ = upsert("demo", "gov-lens", "发版必须走 release 分支流程")
    p_conf, _ = upsert("demo", "gov-lens", "发版无需走 release 分支流程",
                       status="conflicting")
    payload, code = server.memory_link_conflict_payload({
        "conflicting_id": p_conf["id"], "origin_id": p_origin["id"],
        "trigger_words": ["必须", "无需"],
    })
    check("link-conflict → 200 且带 against 全文", code == 200
          and payload.get("against_id") == p_origin["id"]
          and payload.get("against", {}).get("what") == "发版必须走 release 分支流程",
          f"code={code} {payload}")
    conf = ms.get(p_conf["id"])
    orig = ms.get(p_origin["id"])
    check("against_id 双向互指（conflicting 行 + 原条目行）",
          conf.get("against_id") == p_origin["id"] and orig.get("against_id") == p_conf["id"],
          f"conf={conf.get('against_id')} orig={orig.get('against_id')}")
    check("trigger_words 存在 conflicting 行（json 列）",
          conf.get("trigger_words") == ["必须", "无需"] and "trigger_words" not in orig,
          f"conf={conf.get('trigger_words')} orig={orig.get('trigger_words')}")
    cq, _ = server.memory_conflicts_payload()
    check("conflicts 响应 join 出 against + trigger_words",
          any(it["id"] == p_conf["id"] and it.get("trigger_words") == ["必须", "无需"]
              and it.get("against", {}).get("id") == p_origin["id"] for it in cq.get("items") or []),
          repr(cq)[:400])
    payload, code = server.memory_link_conflict_payload({
        "conflicting_id": p_conf["id"], "origin_id": "exp-999999"})
    check("link-conflict 未知 origin → 404", code == 404, f"code={code} {payload}")
    payload, code = server.memory_link_conflict_payload({"conflicting_id": "", "origin_id": ""})
    check("link-conflict 缺参 → 400 bad-conflict-link", code == 400
          and payload.get("error") == "bad-conflict-link", f"code={code} {payload}")

    # 17) timeline：真实事件流（倒序）+ 存量合成（synthesized）
    tl = ms.timeline(p_origin["id"])
    events = [e["event"] for e in tl]
    check("timeline 真实事件：created 在流里（新写条目）",
          "created" in events, repr(tl)[:300])
    check("timeline 倒序（at 非升序）",
          all(tl[i]["at"] >= tl[i + 1]["at"] for i in range(len(tl) - 1)), repr(tl)[:300])
    conf_ev = [e for e in ms.timeline(p_conf["id"]) if e["event"] == "conflicted"]
    check("link-conflict 写 conflicted 事件（含触发词 detail）",
          conf_ev and conf_ev[0].get("detail", {}).get("against") == p_origin["id"],
          repr(conf_ev)[:300])
    # 存量合成：手工删掉事件行，模拟老条目 → timeline 仍非空且标 synthesized
    st.db.execute("delete from memory_events where memory_id = ?", ("exp-000001",))
    st.db.commit()
    tl_old = ms.timeline("exp-000001")
    check("存量条目（无事件）合成 timeline（synthesized 标注）",
          tl_old and any(e["event"] == "created"
                         and e.get("detail", {}).get("synthesized") is True for e in tl_old),
          repr(tl_old)[:300])
    st.db.execute("delete from memories where id = 'exp-nonexist-tl'")
    st.db.commit()
    check("timeline 未知 id → None", ms.timeline("exp-nonexist-tl") is None)
    item_tl, _ = server.memory_get_payload(p_origin["id"])
    check("GET /{id} 响应含 timeline 数组", isinstance(item_tl.get("timeline"), list)
          and len(item_tl["timeline"]) >= 1, repr(item_tl.get("timeline"))[:200])

    # 18) stale_days 过滤：从未命中（last_hit_at 为空）的 active 条目算陈旧
    #     exp-000001 曾 hit（last_hit_at 不为空）→ 不算；page-repo 条目从未 hit → 算。
    stale, _ = server.memory_list_payload(repo="page-repo", stale_days=90)
    check("stale_days：从未命中的 active 条目算陈旧",
          stale.get("total") == 6, repr(stale)[:300])
    stale_hit, _ = server.memory_list_payload(repo="demo", lens="code-style", stale_days=90)
    check("stale_days：最近命中过的条目不算陈旧（last_hit_at 在窗口内）",
          stale_hit.get("total") == 0, repr(stale_hit)[:300])
    # 直接把 last_hit_at 拨回 100 天前 → 变陈旧
    st.db.execute("update memories set last_hit_at = ? where id = ?",
                  (int(__import__("time").time()) - 100 * 86400, "exp-000001"))
    st.db.commit()
    stale2, _ = server.memory_list_payload(repo="demo", lens="code-style", stale_days=90)
    check("stale_days：last_hit_at 早于 N 天 → 陈旧", stale2.get("total") == 1,
          repr(stale2)[:300])
    payload, code = server.memory_list_payload(repo="demo", stale_days="abc")
    check("stale_days 非法 → 400 bad-pagination", code == 400
          and payload.get("error") == "bad-pagination", f"code={code} {payload}")

    # 19) 冲突召回：conflicting 参与 search 且带 conflictWarning（Memanto 模型）
    payload, code = server.memory_search_payload({"q": "release 分支流程", "top_k": 10})
    hits = payload.get("hits") or []
    conf_hit = [h for h in hits if h["id"] == p_conf["id"]]
    active_hit = [h for h in hits if h["id"] == p_origin["id"]]
    check("search 召回 conflicting 条目（不再排除）",
          bool(conf_hit), repr(hits)[:400])
    check("conflicting 命中带 conflictWarning:true",
          conf_hit and conf_hit[0].get("conflictWarning") is True, repr(conf_hit)[:200])
    check("active 命中不带 conflictWarning", active_hit
          and "conflictWarning" not in active_hit[0], repr(active_hit)[:200])
    pure, ch = ms.search("release 分支流程", qvec=None, top_k=10)
    check("存储层 search（status=True 口径）active+conflicting 都召回",
          {h["id"] for h in pure} >= {p_conf["id"], p_origin["id"]}, repr(pure)[:300])
    # retired 仍不召回：软删原条目后 search 不出
    ms.set_status(p_origin["id"], "retired")
    payload, _ = server.memory_search_payload({"q": "release 分支流程", "top_k": 10})
    check("软删后 retired 仍不参与召回",
          all(h["id"] != p_origin["id"] for h in payload.get("hits") or []),
          repr(payload)[:300])
    ms.set_status(p_origin["id"], "active")
    # 清场：conflicting 队列留给 HTTP 层的用例（total==1 断言），resolve 掉本节条目
    ms.set_status(p_conf["id"], "retired")


# ---------------------------------------------------------------- ② 真实 HTTP 层
def test_http():
    httpd = server.make_server(0)  # 随机端口；复用全局 store / memories_store
    port = httpd.server_address[1]
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()

    def req(method, path, body=None):
        url = f"http://127.0.0.1:{port}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        r = urllib.request.Request(url, data=data, method=method,
                                   headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    try:
        # upsert → GET /{id}（URL 路由）
        code, body = req("POST", "/v1/memories", {
            "repo": "http-repo", "lens": "http-lens", "what": "HTTP 层验证的经验条目",
            "when_expr": "2026-11", "why": "验证路由", "evidence": [{"issue": "T-1"}],
        })
        mid = body.get("id")
        check("HTTP upsert → 200", code == 200 and body.get("action") == "created",
              f"code={code} {body}")
        code, body = req("GET", f"/v1/memories/{mid}")
        check("HTTP GET /{id} → 200 全字段", code == 200 and body.get("id") == mid
              and body.get("repo") == "http-repo" and body.get("evidence") == [{"issue": "T-1"}],
              f"code={code} {body}"[:300])

        # 路由不互吞：/search 是 POST 搜索，不是 id= "search" 的 GET
        code, body = req("POST", "/v1/memories/search", {"q": "HTTP 层验证", "top_k": 3})
        check("HTTP POST /v1/memories/search 命中（不被 {id} 吞）",
              code == 200 and mid in [h["id"] for h in body.get("hits") or []],
              f"code={code} {body}"[:300])
        code, body = req("GET", "/v1/memories/search")
        check("GET /search 走 {id} 分支 → 404 unknown-memory",
              code == 404 and body.get("error") == "unknown-memory", f"code={code} {body}")

        # /conflicts 与 /{id} 不互吞
        req("POST", "/v1/memories", {"repo": "http-repo", "lens": "lens2",
                                     "what": "HTTP 冲突条目", "status": "conflicting"})
        code, body = req("GET", "/v1/memories/conflicts")
        check("HTTP GET /conflicts 列队列（不被 {id} 吞）",
              code == 200 and body.get("total") == 1
              and body["items"][0]["what"] == "HTTP 冲突条目", f"code={code} {body}"[:300])
        cid = body["items"][0]["id"]
        code, body = req("POST", f"/v1/memories/{cid}/resolve", {"status": "retired"})
        check("HTTP POST /{id}/resolve", code == 200 and body.get("status") == "retired",
              f"code={code} {body}")
        code, body = req("GET", "/v1/memories/conflicts")
        check("resolve 后 conflicts 队列清空", code == 200 and body.get("total") == 0,
              f"code={code} {body}")

        # /hit 子路径
        code, body = req("POST", f"/v1/memories/{mid}/hit", {"adopted": True})
        check("HTTP POST /{id}/hit 计数", code == 200
              and body == {"stats_hits": 1, "stats_adopted": 1}, f"code={code} {body}")

        # DELETE 软删 + 列表过滤
        code, body = req("DELETE", f"/v1/memories/{mid}")
        check("HTTP DELETE → 软删", code == 200 and body.get("status") == "retired",
              f"code={code} {body}")
        code, body = req("POST", "/v1/memories/search", {"q": "HTTP 层验证"})
        check("软删后 HTTP search 不出该条目",
              code == 200 and all(h["id"] != mid for h in body.get("hits") or []),
              f"code={code} {body}")

        # 列表分页（HTTP 查询串）
        code, body = req("GET", "/v1/memories?repo=page-repo&limit=3&offset=0")
        check("HTTP 列表过滤+分页", code == 200 and body.get("total") == 6
              and len(body.get("items") or []) == 3, f"code={code} {body}"[:300])

        # 鉴权与其它 /v1 端点一致：配了 API_KEY 后无 Bearer → 401
        old_key = server.API_KEY
        server.API_KEY = "mem-test-key-1"
        try:
            code, body = req("GET", "/v1/memories")
            check("配置 API_KEY 后无 Bearer → 401", code == 401
                  and body.get("error") == "unauthorized", f"code={code} {body}")
            code, body = req("POST", "/v1/memories/search", {"q": "x"})
            check("search 同样要求 Bearer → 401", code == 401, f"code={code} {body}")
            r = urllib.request.Request(f"http://127.0.0.1:{port}/v1/memories",
                                       method="GET",
                                       headers={"Authorization": "Bearer mem-test-key-1"})
            with urllib.request.urlopen(r, timeout=10) as resp:
                check("带 Bearer → 200", resp.status == 200, resp.status)
        finally:
            server.API_KEY = old_key

        # 治理可见性（HTTP 层）：pipeline-runs 上报/列表（admin 端点）+ stale_days + conflictWarning
        code, body = req("POST", "/v1/admin/pipeline-runs", {
            "run_id": "run-http-001", "engine": "rules", "dry_run": False,
            "candidates": 5, "review_passed": 4, "review_blocked": 1,
            "actions": {"create": 4},
        })
        check("HTTP POST /v1/admin/pipeline-runs → 200", code == 200
              and body.get("run_id") == "run-http-001"
              and body.get("review_blocked") == 1, f"code={code} {body}")
        code, body = req("GET", "/v1/admin/pipeline-runs?limit=5")
        check("HTTP GET /v1/admin/pipeline-runs 列表", code == 200
              and body.get("total", 0) >= 1
              and any(i["run_id"] == "run-http-001" for i in body.get("items") or []),
              f"code={code} {body}"[:300])
        code, body = req("POST", "/v1/admin/pipeline-runs", {"engine": "x"})
        check("HTTP pipeline-runs 缺 run_id → 400", code == 400
              and body.get("error") == "bad-run", f"code={code} {body}")

        code, body = req("GET", "/v1/memories?repo=page-repo&stale_days=90")
        check("HTTP stale_days 过滤生效", code == 200 and body.get("total") == 6,
              f"code={code} {body}"[:200])

        # conflicting 参与检索 + conflictWarning（HTTP 层钉住语义变更）
        req("POST", "/v1/memories", {"repo": "http-repo", "lens": "warn-lens",
                                     "what": "冲突召回验证条目", "status": "conflicting",
                                     "evidence": [{"issue": "T-9"}]})
        code, body = req("POST", "/v1/memories/search", {"q": "冲突召回验证", "top_k": 5})
        whits = [h for h in body.get("hits") or [] if h.get("conflictWarning")]
        check("HTTP search conflicting 命中带 conflictWarning", code == 200
              and len(whits) >= 1 and whits[0]["what"] == "冲突召回验证条目",
              f"code={code} {body}"[:300])

        # timeline：HTTP GET /{id} 带 timeline（created 事件来自 upsert）
        code, body = req("GET", f"/v1/memories/{mid}")
        check("HTTP GET /{id} 含 timeline", code == 200
              and isinstance(body.get("timeline"), list)
              and any(e["event"] == "created" for e in body["timeline"]),
              f"code={code} {body}"[:300])

        # admin stats 含 memories 盘点（验收 4：走真实 HTTP）
        code, body = req("GET", "/v1/admin/stats?days=1")
        check("/v1/admin/stats 含 memories.total/hits",
              code == 200 and isinstance((body or {}).get("memories"), dict)
              and body["memories"].get("total", 0) >= 1 and body["memories"].get("hits", 0) >= 1,
              f"code={code} {(body or {}).get('memories')}")
        check("categories 四类口径不变（memories 计入 retrieval）",
              isinstance((body or {}).get("categories"), dict)
              and set(body["categories"]) == {"retrieval", "indexing", "embedding", "system"},
              list((body or {}).get("categories") or []))
    finally:
        httpd.shutdown()
        httpd.server_close()
        th.join(timeout=5)


def main():
    print(f"临时库：{os.path.join(TMP, 'index.db')}")
    print("— ① 纯逻辑层（memory_*_payload / MemoryStore）—")
    test_logic()
    print("— ② 真实 HTTP 层（路由不互吞 + 鉴权 + admin stats）—")
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
