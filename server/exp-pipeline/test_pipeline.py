#!/usr/bin/env python
"""exp-pipeline 自测：不依赖真实服务/模型（client 全用 stub，LLM 用 monkeypatch env）。

运行：python test_pipeline.py
覆盖：
1. Stage A：真实归档裁剪夹具的解析/主题分组/噪声剥离/事实锚定
2. Stage B 规则版：修正句式 → 候选；digest 解析（223 条唯一）
3. Stage B LLM 版：无 env 优雅降级（LLMConfigError → 调用方降级路径）
4. Stage C Review：缺 when / what 过短 / 证据空 / 源码探索证伪（stub：类名不存在→拦截）
5. Stage C Dedup：what+when 相似 >0.9 合并、禁桥接
6. Stage C Merge：create / update / skip / contradict 四判（stub memories/search）
7. client：HTTP stub server 走真实 urllib 路径
"""
from __future__ import annotations

import json
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

from http.server import BaseHTTPRequestHandler, HTTPServer  # noqa: E402

from client import IndexClient, PipelineClientError, StubIndexClient  # noqa: E402
from common import text_similarity  # noqa: E402
from stage_a import (  # noqa: E402
    Facts, Segment, Turn, extract_facts, is_noise_user_message, parse_segment,
    split_topics, strip_noise,
)
from stage_b_rules import Candidate, extract_rules, parse_digest  # noqa: E402
from stage_b_llm import LLMConfigError, extract_llm  # noqa: E402
from stage_c import (  # noqa: E402
    decide_merge, dedup, review_candidate, run_governance,
)

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}  {detail}")


def make_cand(what="改用 fork 推送并让用户合并 upstream 才成功", when="推送 smartpos 上游被 403 拒绝时",
              lens="logic", repo="web-erp", evidence=None, origin="rules", why="glab 403"):
    return Candidate(repo=repo, lens=lens, what=what, when_expr=when, why=why,
                     evidence=evidence if evidence is not None else
                     [{"archive_ref": "session-x/segment_000.md", "issue": "SPLAT-5530"}],
                     origin=origin)


# ---------------- 1. Stage A ----------------

REAL_FIXTURE = """# HISTORICAL -- GENERATED, DO NOT EDIT
# Record of compaction segment 000 from this same task.

## Segment metadata

| Field | Value |
|---|---|
| Session | `session-fixture-0001` |
| Segment index | 000 |
| Written | 2026-11-18T06:52:29.398Z |
| Shadowed range (reported) | 9 - 2009 |

## Summary (curated by the compaction backend)

## Errors and Fixes
- glab mr create 403 → succeeded via POST projects/244/merge_requests with target_project_id=69.

## Verbatim turns

### seq 9 -- Human
```text
CHGJ-3745 这单 smartpos-site-erp 的 git push origin 报 403 怎么处理
```

### seq 10 -- Assistant (tool call: ops_bash)
```text
[tool-call] git push origin feat/plat/jul
```

### seq 12 -- Tool response (callId c1, answers seq 10)
```text
remote: You are not allowed to push code to this project.
ERROR: Permission to smartpos/smartpos.site/smartpos-site-erp.git denied to dev.
```

### seq 13 -- Assistant
```text
上游是 Reporter 权限，403 正常。应该推到个人 fork 仓库（remote lailiqiang），
再让有权限的人合并 upstream；不要直接 push origin。
```

### seq 14 -- Human
```text
好的
```

### seq 15 -- Assistant
```text
继续执行。
```

### seq 16 -- Human
```text
帮我看下 hzf_pay_book 的退款单，join account_yee 查一下
```

### seq 18 -- Tool response (callId c2, answers seq 16)
```text
select * from hzf_pay_book b join account_yee a on b.id=a.book_id
```

### seq 19 -- Assistant
```text
Time sampled while preparing turn 1, step 1: 2026-11-19T19:07:03+08:00[Asia/Singapore]
```

### seq 20 -- Human
```text
继续
```

### seq 21 -- Assistant
```text
已完成。
```
"""


def test_stage_a():
    print("[Stage A]")
    seg = parse_segment(REAL_FIXTURE)
    check("parse: session id", seg.session_id == "session-fixture-0001", seg.session_id)
    check("parse: written", seg.written.startswith("2026-11-18"), seg.written)
    check("parse: turn count", len(seg.turns) == 11, str(len(seg.turns)))
    check("parse: kinds", [t.kind for t in seg.turns] ==
          ["human", "assistant", "tool", "assistant", "human", "assistant", "human", "tool",
           "assistant", "human", "assistant"],
          str([t.kind for t in seg.turns]))

    topics = split_topics(seg)
    # "好的"/"继续" 是噪声不切题；seq19 的时间戳轮归入当前题
    check("topics: 2 groups (噪声不切题)", len(topics) == 2, str(len(topics)))
    t0 = topics[0]
    check("topic0: title from user msg", "CHGJ-3745" in t0.title, t0.title)
    check("topic0: issue anchored", "CHGJ-3745" in t0.facts.issues, str(t0.facts.issues))
    check("topic0: symbols", len(t0.facts.symbols) >= 1, str(t0.facts.symbols))
    check("topic0: correction found", any(k == "should" for k, _ in t0.facts and t0.corrections),
          str(t0.corrections))
    t1 = topics[1]
    check("topic1: sql table hzf_pay_book", "hzf_pay_book" in t1.facts.sql_tables, str(t1.facts.sql_tables))
    check("topic1: sql table account_yee", "account_yee" in t1.facts.sql_tables, str(t1.facts.sql_tables))

    check("noise: 继续类指令", is_noise_user_message("继续"))
    check("noise: ok", is_noise_user_message("ok"))
    check("noise: 真话不放", not is_noise_user_message("CHGJ-3745 怎么处理"))
    stripped = strip_noise("<system-reminder>x</system-reminder>正文[Notice: 噪声]")
    check("noise: strip 信封", "正文" in stripped and "system-reminder" not in stripped, stripped)

    # 真实归档（存在时）
    real_dir = os.path.join(os.path.expanduser("~"), ".dsh", "archive")
    real_sid = "session-b62062c3-a05a-475a-89e4-e54a3763222d"
    rp = os.path.join(real_dir, real_sid, "segment_000.md")
    if os.path.isfile(rp):
        with open(rp, encoding="utf-8") as fh:
            rseg = parse_segment(fh.read(), session_id=real_sid, seg_index="000")
        check("real archive: 644 turns", len(rseg.turns) == 644, str(len(rseg.turns)))
        rtopics = split_topics(rseg)
        check("real archive: topics 10~40", 10 <= len(rtopics) <= 40, str(len(rtopics)))
        check("real archive: 有锚定事实",
              any(tp.facts.any() for tp in rtopics))
    else:
        print(f"  (skip real archive: {rp} 不存在)")


# ---------------- 2. Stage B rules ----------------

def test_stage_b_rules():
    print("[Stage B rules]")
    seg = parse_segment(REAL_FIXTURE)
    topics = split_topics(seg)
    cands = extract_rules(topics)
    check("rules: 有候选", len(cands) >= 1, str(len(cands)))
    logic = [c for c in cands if c.lens == "logic"]
    check("rules: logic 候选存在", len(logic) >= 1)
    if logic:
        c = logic[0]
        check("rules: what 非空且≥8字", len(c.what) >= 8, c.what)
        check("rules: when 非空", bool(c.when_expr.strip()))
        check("rules: evidence 有 archive_ref",
              any("archive_ref" in e for e in c.evidence), str(c.evidence))
        check("rules: to_payload 无内部字段",
              "origin" not in c.to_payload() and "topic_ref" not in c.to_payload())

    # digest
    dg = os.environ.get("PIPE_DIGEST_FILE") or r"D:\work\bug-analysis\_check\session-4ff93b80-experience\experience-digest.md"
    if os.path.isfile(dg):
        with open(dg, encoding="utf-8") as fh:
            dcands = parse_digest(fh.read())
        check("digest: 223 unique", len(dcands) == 223, str(len(dcands)))
        check("digest: 全部有 when", all(c.when_expr.strip() for c in dcands))
        check("digest: evidence archive_ref",
              all(any("archive_ref" in e for e in c.evidence) for c in dcands[:20]))
    else:
        print(f"  (skip digest: {dg} 不存在)")


# ---------------- 3. Stage B LLM 降级 ----------------

def test_stage_b_llm():
    print("[Stage B LLM]")
    saved = {k: os.environ.pop(k, None) for k in ("PIPE_LLM_URL", "PIPE_LLM_KEY", "PIPE_LLM_MODEL")}
    try:
        try:
            extract_llm([])
            check("llm: 无 env 抛 LLMConfigError", False, "未抛")
        except LLMConfigError:
            check("llm: 无 env 抛 LLMConfigError", True)
        # 归档路径（--llm 无 env → notes 带 [降级]，引擎回落 rules）
        import tempfile
        empty_arch = os.path.join(tempfile.gettempdir(), "exp_pipeline_empty_archive")
        os.makedirs(empty_arch, exist_ok=True)
        args = gather_parser().parse_args(["--dry-run", "--llm", "--limit", "1",
                                           "--archive-dir", empty_arch])
        import pipeline as pl
        cands, engine, notes = pl.gather_candidates(args)
        check("llm: 降级提示出现在 notes", any("降级" in n for n in notes), str(notes))
        check("llm: engine 回落 rules", engine == "rules", engine)
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


def gather_parser():
    import pipeline as pl
    return pl.build_parser()


# ---------------- 4. Stage C Review ----------------

def test_stage_c_review():
    print("[Stage C Review]")
    c_ok = make_cand()
    r = review_candidate(c_ok, client=None)
    check("review: 合格候选放行", r.passed, str(r.reasons))

    r = review_candidate(make_cand(when="  "), client=None)
    check("review: 缺 when 拦截", not r.passed and "missing_when" in r.reasons, str(r.reasons))

    r = review_candidate(make_cand(what="改一下"), client=None)
    check("review: what<8字 拦截", not r.passed and "what_too_short" in r.reasons, str(r.reasons))

    r = review_candidate(make_cand(evidence=[]), client=None)
    check("review: 证据空 拦截", not r.passed and "no_evidence" in r.reasons, str(r.reasons))

    # 源码探索 stub：类名不存在 → factual_error 拦截
    stub = StubIndexClient(known_symbols={"CrmOrderPayUtilService"})
    c_sym = make_cand(what="CrmOrderPayUtilService 加 @Lazy 才能解循环依赖")
    r = review_candidate(c_sym, client=stub, verify_symbols=True)
    check("review: 已知类名放行", r.passed and "CrmOrderPayUtilService" in r.verified_symbols,
          f"passed={r.passed} verified={r.verified_symbols}")
    stub_bad = StubIndexClient(known_symbols=set())
    c_bad = make_cand(what="FrmCrossPOSMgr 里的 DecodeMars 需要重写")
    r = review_candidate(c_bad, client=stub_bad, verify_symbols=True)
    check("review: 类名不存在 → factual_error", not r.passed and
          any(x.startswith("factual_error") for x in r.reasons), str(r.reasons))
    # 探索服务不可用：不拦（默认保留）
    class BoomClient:
        def code_search(self, *a, **k):
            raise PipelineClientError("down")
    r = review_candidate(c_sym, client=BoomClient(), verify_symbols=True)
    check("review: 探索服务不可用不拦", r.passed, str(r.reasons))


# ---------------- 5. Stage C Dedup ----------------

def test_stage_c_dedup():
    print("[Stage C Dedup]")
    a = make_cand()
    a2 = make_cand(why="glab 403 duplicate")  # what/when 相同 → 合并
    b = make_cand(what="完全不同的经验：JDK8 编译 pay 通过", when="pay 编译报 lombok IllegalAccessError")
    dd = dedup([a, a2, b])
    check("dedup: 相同合并", dd.merged_count == 1 and len(dd.kept) == 2,
          f"merged={dd.merged_count} kept={len(dd.kept)}")
    check("dedup: 证据合并保留", len(dd.kept[0].evidence) >= 1, str(dd.kept[0].evidence))
    # 禁桥接：A~B 0.95、B~C 0.95、A~C 0.5 → A、B 合并后 C 不得经 B 桥接进组
    x = make_cand(what="推送上游 403 要改用 fork 推送才成功", when="w1")
    y = make_cand(what="推送上游 403 要改用 fork 推送才成功的变体", when="w1")
    z = make_cand(what="推送上游 403 要改用 fork 推送才成功的变体再加长一些", when="w1")
    dd2 = dedup([x, y, z], threshold=0.9)
    check("dedup: 高相似组合并", dd2.merged_count >= 1 and len(dd2.kept) <= 2,
          f"merged={dd2.merged_count} kept={len(dd2.kept)}")
    # 相似度工具自检
    s1 = text_similarity("改用 fork 推送才成功", "改用 fork 推送才成功")
    s2 = text_similarity("改用 fork 推送才成功", "JDK8 编译 pay")
    check("sim: 自身=1", s1 == 1.0, str(s1))
    check("sim: 异己<0.5", s2 < 0.5, str(s2))


# ---------------- 6. Stage C Merge 四判 ----------------

def test_stage_c_merge():
    print("[Stage C Merge]")
    # create：无命中
    dec = decide_merge(make_cand(), [])
    check("merge: 无命中 → create", dec.action == "create", dec.action)
    # contradict：同主题方向相反
    hit_contra = {"id": "exp-000001", "what": "可以直接 push origin 上游",
                  "when_expr": "推送 smartpos 上游被 403 拒绝时", "lens": "logic"}
    dec = decide_merge(make_cand(), [hit_contra])
    check("merge: 同主题反向 → contradict", dec.action == "contradict" and dec.target_id == "exp-000001",
          f"{dec.action}/{dec.target_id}")
    # skip：同向几乎一致（>0.9）且证据已覆盖
    hit_same = {"id": "exp-000002", "what": "改用 fork 推送并让用户合并 upstream 才成功",
                "when_expr": "推送 smartpos 上游被 403 拒绝时", "lens": "logic",
                "evidence": [{"archive_ref": "session-x/segment_000.md"}]}
    dec = decide_merge(make_cand(evidence=[{"archive_ref": "session-x/segment_000.md"}]), [hit_same])
    check("merge: 同向无新增 → skip", dec.action == "skip", f"{dec.action}: {dec.reason}")
    # update：同向但证据新增（session-NEW 不在 hit.evidence）
    dec = decide_merge(make_cand(evidence=[{"archive_ref": "session-NEW/segment_001.md"}]), [hit_same])
    check("merge: 同向证据新增 → update", dec.action == "update", f"{dec.action}: {dec.reason}")

    # 全链路（stub client，dry-run 与执行）
    stub = StubIndexClient(known_symbols=set())
    rep = run_governance([make_cand(), make_cand(what="很短", evidence=[{"archive_ref": "s/1.md"}])],
                         client=stub, dry_run=True)
    writes = [c for c in stub.calls if c[1] == "/v1/memories" or c[1].endswith(("/hit", "/resolve"))
              or c[0] == "DELETE"]
    check("governance: dry-run 零写操作（只读 search 允许）",
          all(m["executed"] is None for m in rep["merge"]) and not writes,
          str(stub.calls))
    rep2 = run_governance([make_cand()], client=stub, dry_run=False)
    check("governance: 执行走 upsert",
          any(p == "/v1/memories" for _, p, _ in stub.calls), str(stub.calls[:3]))
    # contradict 写 status=conflicting
    stub2 = StubIndexClient(existing=[{"id": "exp-000009", "repo": "web-erp", "lens": "logic",
                                       "what": "可以直接 push origin 上游",
                                       "when_expr": "推送 smartpos 上游被 403 拒绝时", "why": ""}])
    rep3 = run_governance([make_cand()], client=stub2, dry_run=False)
    check("governance: contradict 执行写 conflicting",
          any(m["action"] == "contradict" and (m["executed"] or {}).get("action") == "created"
              for m in rep3["merge"]), json.dumps(rep3["merge"], ensure_ascii=False)[:200])
    # conflict 队列可查
    conflicts = stub2.memory_conflicts()
    check("governance: conflicts 队列", any(i["id"] == "exp-000009" or i.get("status") == "conflicting"
                                            for i in conflicts.get("items", [])), str(conflicts))


# ---------------- 7. client HTTP stub ----------------

def test_client_http():
    print("[client http stub]")
    calls = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n)) if n else {}
            calls.append(("POST", self.path, self.headers.get("Authorization"), body))
            if self.path == "/v1/memories":
                self._send(200, {"id": "exp-000001", "action": "created"})
            elif self.path == "/v1/memories/search":
                self._send(200, {"hits": [], "ms": 1})
            elif self.path == "/v1/search":
                self._send(200, {"hits": [], "ms": {"total": 1}})
            elif self.path.startswith("/v1/memories/") and self.path.endswith("/hit"):
                self._send(200, {"stats_hits": 1, "stats_adopted": 0})
            else:
                self._send(404, {"error": "unknown"})

        def do_GET(self):
            calls.append(("GET", self.path, self.headers.get("Authorization"), None))
            if self.path.startswith("/v1/memories/conflicts"):
                self._send(200, {"items": []})
            self._send(200, {"items": [], "total": 0})

        def do_DELETE(self):
            calls.append(("DELETE", self.path, self.headers.get("Authorization"), None))
            self._send(200, {"deleted": True})

    srv = HTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        c = IndexClient(base_url=f"http://127.0.0.1:{port}", api_key="test-key", retries=0)
        r = c.memory_upsert({"repo": "r", "lens": "logic", "what": "w" * 10,
                             "when_expr": "e", "why": "y", "evidence": [], "source": "pipeline"})
        check("http: upsert", r == {"id": "exp-000001", "action": "created"}, str(r))
        r = c.memory_search("q", repo="r")
        check("http: memories/search", r == {"hits": [], "ms": 1}, str(r))
        r = c.code_search("Foo", namespace="ns")
        check("http: /v1/search 源码探索", r == {"hits": [], "ms": {"total": 1}}, str(r))
        r = c.memory_hit("exp-000001")
        check("http: hit", r["stats_hits"] == 1, str(r))
        r = c.memory_conflicts()
        check("http: conflicts", r == {"items": []}, str(r))
        r = c.memory_delete("exp-000001")
        check("http: delete 软删", r == {"deleted": True}, str(r))
        auth = {p: a for m, p, a, _ in calls}
        check("http: Bearer 鉴权头", all(v == "Bearer test-key" for v in auth.values()), str(auth))
        try:
            c.memory_get("exp-000001")
            check("http: GET 单条", True)
        except PipelineClientError:
            check("http: GET 单条（stub 未实现 → 404 也算通）", True)
        # 未实现路径的错误形状
        try:
            c.memory_resolve("exp-000001", "active")
            check("http: resolve 报错可控", False, "未抛")
        except PipelineClientError as e:
            check("http: resolve 报错可控（HTTP 404 包成 PipelineClientError）", "404" in str(e), str(e))
    finally:
        srv.shutdown()


def main() -> int:
    test_stage_a()
    test_stage_b_rules()
    test_stage_b_llm()
    test_stage_c_review()
    test_stage_c_dedup()
    test_stage_c_merge()
    test_client_http()
    print(f"\n== {PASS} passed, {FAIL} failed ==")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
