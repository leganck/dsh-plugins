"""离线自测：不联网、不需要模型、不需要 GitLab。

跑法：
    python -m app.selftest          # 或者  python app/selftest.py

它覆盖的是"最容易出错、最值得回归"的部分：
  diff 解析（新文件/删除/二进制/换行符/行号）、降噪与丢弃原因、回放与预算、
  流水线端到端（含 Verifier 保留与拒绝两条路径）、任务库幂等与队列、发布层（含 position 降级）。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import threading
import traceback
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PASS = 0
FAILS: list[str] = []


def check(label: str, cond, detail: str = "") -> bool:
    global PASS
    if cond:
        PASS += 1
        print(f"  [ok] {label}")
        return True
    FAILS.append(label)
    print(f"  [FAIL] {label}" + (f" —— {detail}" if detail else ""))
    return False


def section(name: str) -> None:
    print(f"\n[{name}]")


# ---------------------------------------------------------------- 夹具

DIFF_MULTI = """diff --git a/src/user.py b/src/user.py
index 1111111..2222222 100644
--- a/src/user.py
+++ b/src/user.py
@@ -38,5 +38,8 @@ def get_user(uid):
     user = db.get(uid)
+    if user is None:
+        return None
+    name = user.name
     return user
diff --git a/src/new.py b/src/new.py
new file mode 100644
--- /dev/null
+++ b/src/new.py
@@ -0,0 +1,3 @@
+import os
+
+print(os.getcwd())
diff --git a/old.py b/old.py
deleted file mode 100644
--- a/old.py
+++ /dev/null
@@ -1,2 +0,0 @@
-x = 1
-y = 2
diff --git a/logo.png b/logo.png
index 3333333..4444444 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/lock.txt b/lock.txt
--- a/lock.txt
+++ b/lock.txt
@@ -1 +1,2 @@
 keep
+added line
\\ No newline at end of file
"""


def gitlab_items() -> list[dict]:
    return [
        {"old_path": "src/user.py", "new_path": "src/user.py", "diff": DIFF_MULTI.split("diff --git a/src/new.py")[0].split("diff --git a/src/user.py")[1]},
        {"old_path": "src/new.py", "new_path": "src/new.py", "new_file": True, "diff": "new file mode 100644\n--- /dev/null\n+++ b/src/new.py\n@@ -0,0 +1,3 @@\n+import os\n+\n+print(os.getcwd())"},
        {"old_path": "old.py", "new_path": "old.py", "deleted_file": True, "diff": "deleted file mode 100644\n--- a/old.py\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x = 1\n-y = 2"},
        {"old_path": "logo.png", "new_path": "logo.png", "diff": "Binary files a/logo.png and b/logo.png differ"},
        {"old_path": "lock.txt", "new_path": "lock.txt", "diff": "--- a/lock.txt\n+++ b/lock.txt\n@@ -1 +1,2 @@\n keep\n+added line\n\\ No newline at end of file"},
        {"old_path": "big.json", "new_path": "big.json", "too_large": True, "diff": ""},
        {"old_path": "docs/readme.md", "new_path": "docs/readme.md", "diff": "--- a/docs/readme.md\n+++ b/docs/readme.md\n@@ -1 +1,2 @@\n old\n+new\n"},
    ]


FILES_FOR_REVIEW = {
    "src/user.py": "def get_user(uid):\n    user = db.get(uid)\n    if user is None:\n        return None\n    name = user.name\n    return user\n",
    "AGENTS.md": "团队规范：所有外部输入必须判空；禁止裸 except。\n",
}


REPLAY_OK = {
    "planner#0": '{"blocks":[{"theme":"用户接口层","files":["src/user.py"],"focus":"空值处理与返回值","risk":"high"}],"skip":[]}',
    "reviewer#1": '{"findings":['
    '{"file":"src/user.py","line":40,"severity":"major","category":"correctness","message":"uid 为 None 时未判空","confidence":0.92,"evidence":"第 40 行直接使用参数"},'
    '{"file":"src/user.py","line":999,"severity":"major","category":"security","message":"不存在的行","confidence":0.9},'
    '{"file":"src/user.py","line":41,"severity":"minor","category":"maintainability","message":"低置信度","confidence":0.2},'
    '{"file":"src/other.py","line":1,"severity":"minor","category":"correctness","message":"不在本次 diff","confidence":0.9},'
    '{"file":"src/user.py","line":40,"severity":"major","category":"correctness","message":"uid 为 None 时未判空","confidence":0.9}'
    "]}",
    "verifier#2": '{"action":"final","keep":true,"reason":"参数确实未判空，且上层没有兜底","evidence":"src/user.py 第 40 行"}',
}

REPLAY_REJECT = dict(REPLAY_OK)
REPLAY_REJECT["verifier#2"] = '{"action":"final","keep":false,"reason":"上层已校验 uid","evidence":"调用方"}'

REPLAY_VERIFY_READ = dict(REPLAY_OK)
REPLAY_VERIFY_READ["verifier#2"] = '{"action":"read_file","path":"src/user.py","start":36,"end":44}'
REPLAY_VERIFY_READ["verifier#3"] = '{"action":"final","keep":true,"reason":"读完上下文确认","evidence":"第 40 行"}'


# ---------------------------------------------------------------- 1) diff


def test_diff() -> None:
    section("diff 解析")
    from . import diff as D

    files = D.parse_gitlab_diffs(gitlab_items(), ["lock.txt"])
    by = {f.path: f for f in files}

    check("新增行行号是文件内行号（hunk 从 38 起：39/40/41）", by["src/user.py"].added_lineno_set() == {39, 40, 41}, str(by["src/user.py"].added_lineno_set()))
    check("新增文件被识别", by["src/new.py"].new_file and not by["src/new.py"].skip_reason())
    check("删除文件被跳过", by["old.py"].skip_reason() == "deleted")
    check("二进制文件被识别（即使没有 diff 正文）", by["logo.png"].binary and by["logo.png"].skip_reason() == "binary")
    check("too_large 被标记", by["big.json"].skip_reason() == "too_large")
    check("命中的 ignore glob 被标记为 ignored", by["lock.txt"].skip_reason() == "ignored")
    check("无增删的 markdown 正常可审", by["docs/readme.md"].skip_reason() is None)
    check("新增行文本正确", by["src/user.py"].line_text(40) == "        return None", repr(by["src/user.py"].line_text(40)))
    check("删除行带旧行号", by["old.py"].removed_lines() == [(1, "x = 1"), (2, "y = 2")])

    # \\ No newline 不占行号
    lock = by["lock.txt"]
    check("No newline 标记不产生额外行号", lock.added_lines() == [(2, "added line")], str(lock.added_lines()))

    # CRLF 兼容
    hunks, _binary = D.parse_hunks("@@ -1 +1,2 @@\r\n keep\r\n+added\r\n")
    added = [(kind, text, new) for kind, text, _old, new in hunks[0].lines if kind == "+"]
    check("CRLF 行尾被剥离", added == [("+", "added", 2)], str(added))

    # 指纹
    fp1 = D.mr_fingerprint(files)
    fp2 = D.mr_fingerprint(D.parse_gitlab_diffs(gitlab_items(), ["lock.txt"]))
    check("同一 diff 的 MR 指纹稳定（rebase 后 head_sha 变、指纹不变）", fp1 == fp2)
    mutated = gitlab_items()
    mutated[0]["diff"] = mutated[0]["diff"].replace("user.name", "user.full_name")
    check("内容变了指纹就变", D.mr_fingerprint(D.parse_gitlab_diffs(mutated)) != fp1)

    skips = D.summarize_skips(files)
    reasons = {s["reason"] for s in skips}
    check("跳过汇总包含 deleted/binary/too_large/ignored", {"deleted", "binary", "too_large", "ignored"} <= reasons, str(reasons))

    check("glob 匹配 **/x 与 dir/**", D.matches_any("a/b/c.lock", ["**/*.lock"]) and D.matches_any("vendor/x/y.go", ["vendor/**"]))
    check("glob 不误伤相似路径", not D.matches_any("src/vendorx.go", ["vendor/**"]))


# ---------------------------------------------------------------- 2) 校验


def test_validate() -> None:
    section("校验与降噪")
    from . import diff as D
    from . import validate as V

    files = D.parse_gitlab_diffs(gitlab_items(), ["lock.txt"])
    raws = [
        {"file": "src/user.py", "line": 40, "severity": "major", "category": "correctness", "message": "空指针", "confidence": 0.9},
        {"file": "src/user.py", "line": 40, "severity": "major", "category": "correctness", "message": "空指针", "confidence": 0.9},
        {"file": "src/user.py", "line": 38, "severity": "major", "category": "correctness", "message": "行不在新增里", "confidence": 0.9},
        {"file": "nope.py", "line": 1, "severity": "major", "category": "correctness", "message": "未知文件", "confidence": 0.9},
        {"file": "src/user.py", "line": 41, "severity": "minor", "category": "correctness", "message": "低置信", "confidence": 0.3},
        {"file": "src/user.py", "line": 41, "severity": "trivial", "category": "maintainability", "message": "风格问题", "confidence": 0.95},
        {"file": "src/user.py", "line": 41, "severity": "bogus", "category": "correctness", "message": "非法严重度", "confidence": 0.9},
        {"file": "", "line": 1, "severity": "major", "category": "correctness", "message": "缺文件", "confidence": 0.9},
        "not-a-dict",
    ]
    res = V.validate(raws, files, min_confidence=0.7, severity_floor="minor", max_per_file=1, max_total=3)
    counts = res.drop_counts()
    check("重复项被去重", counts.get("duplicate_in_batch") == 1, str(counts))
    check("非新增行被拒", counts.get("line_not_changed") == 1, str(counts))
    check("未知文件被拒", counts.get("unknown_file") == 1, str(counts))
    check("低置信被拒", counts.get("low_confidence") == 1, str(counts))
    check("低于严重度门槛被拒", counts.get("below_severity") == 1, str(counts))
    check("非法结构被拒（非法严重度 + 缺文件 + 非对象）", counts.get("invalid_schema") == 3, str(counts))
    check("单文件上限生效", len(res.posted) == 1 and all(f.file == "src/user.py" for f in res.posted), str(len(res.posted)))
    check("统计里有 posted/dropped", res.stats["posted"] == 1 and res.stats["candidates"] == len(raws), str(res.stats))

    # 排序：严重度高在前
    many = [
        {"file": "src/user.py", "line": 39, "severity": "minor", "category": "correctness", "message": "a", "confidence": 0.99},
        {"file": "src/user.py", "line": 40, "severity": "critical", "category": "security", "message": "b", "confidence": 0.7},
        {"file": "src/user.py", "line": 41, "severity": "major", "category": "correctness", "message": "c", "confidence": 0.8},
    ]
    res2 = V.validate(many, files, max_per_file=5, max_total=5)
    check("严重度排序：critical → major → minor", [f.severity for f in res2.posted] == ["critical", "major", "minor"], str([f.severity for f in res2.posted]))

    f = res2.posted[0]
    check("评论正文含隐藏指纹（去重靠它）", f"<!-- ai-review:{f.fingerprint()} -->" in f.body())
    check("建议补丁用 suggestion 围栏", "```suggestion" in V.Finding("a", 1, "major", "correctness", "m", 0.8, suggestion="x = 1").body())

    # 行内位置
    from .clients import GitLabClient

    pos = GitLabClient.position({"base_sha": "b", "start_sha": "s", "head_sha": "h"}, "src/user.py", 42)
    check("position 使用文件内行号与三个 sha", pos["new_line"] == 42 and pos["base_sha"] == "b" and pos["head_sha"] == "h")
    multi = GitLabClient.position({"base_sha": "b", "start_sha": "s", "head_sha": "h"}, "src/user.py", 42, (42, 45))
    check("多行评论带 line_range", multi.get("line_range", {}).get("start") == {"new_line": 42} and multi["line_range"]["end"] == {"new_line": 45}, str(multi.get("line_range")))

    # 汇总渲染
    res3 = V.validate(
        [
            {"file": "src/user.py", "line": 40, "severity": "critical", "category": "security", "message": "越权", "confidence": 0.95},
            {"file": "src/user.py", "line": 41, "severity": "minor", "category": "correctness", "message": "噪声", "confidence": 0.1},
        ],
        files,
    )
    summary = V.render_summary({"title": "修用户接口", "author": {"name": "张三"}}, files, D.summarize_skips(files), res3, model="deepseek-chat", tokens_in=100, tokens_out=20, latency_ms=1500)
    check("汇总含标题/统计/未评审文件/降噪明细", all(k in summary for k in ("AI 评审：修用户接口", "需要优先处理", "未评审的文件", "降噪明细")), summary[:200])
    check("汇总带标记（用于复用同一条 note）", summary.strip().endswith("<!-- ai-review-summary -->"))


# ---------------------------------------------------------------- 3) 回放与预算


def test_llm() -> None:
    section("模型回放与预算")
    from .llm import Budget, BudgetExceeded, LLM, request_sha

    llm = LLM("http://replay", replay={"planner#0": "{}"})
    out = llm.chat([{"role": "user", "content": "hi"}], "planner")
    check("回放返回预设内容且不联网", out == "{}")
    check("回放也记账", llm.budget.usage.calls == 1 and llm.budget.usage.replayed == 1)
    check("transcript 有记录", len(llm.transcript) == 1 and llm.transcript[0]["replayed"] is True)

    same = request_sha([{"role": "user", "content": "hi"}], "planner")
    other = request_sha([{"role": "user", "content": "hi"}], "reviewer")
    check("request_sha 对同输入稳定、按用途区分", same == request_sha([{"role": "user", "content": "hi"}], "planner") and same != other)

    tiny = LLM("http://replay", replay={"planner#0": "{}", "reviewer#1": "{}"}, budget=Budget(max_calls=1))
    tiny.chat([{"role": "user", "content": "a"}], "planner")
    try:
        tiny.chat([{"role": "user", "content": "b"}], "reviewer")
        check("预算超限会抛 BudgetExceeded", False)
    except BudgetExceeded:
        check("预算超限会抛 BudgetExceeded", True)

    from .util import extract_json_object

    check("能从 ```json 围栏里抠 JSON", extract_json_object('前缀\n```json\n{"a":1}\n```\n后缀') == {"a": 1})
    check("能处理字符串里的括号", extract_json_object('{"msg":"配置 {a} 未设置"}')["msg"] == "配置 {a} 未设置")
    try:
        extract_json_object("没有 json")
        check("无 JSON 时抛 ValueError", False)
    except ValueError:
        check("无 JSON 时抛 ValueError", True)


# ---------------------------------------------------------------- 4) 流水线


def _run_pipeline(replay: dict, *, budget_calls: int = 24):
    from .clients import DictReader, IndexClient
    from .diff import parse_gitlab_diffs
    from .llm import Budget, LLM
    from .pipeline import ReviewSettings, run_review

    files = parse_gitlab_diffs(gitlab_items(), ["*.lock"])
    reader = DictReader(FILES_FOR_REVIEW)

    class FakeIndex(IndexClient):
        def __init__(self):
            super().__init__("")

        def search(self, namespace, query, k=6, embed_text=None):  # noqa: D401
            return [{"path": "src/user.py", "start": 1, "end": 6, "score": 0.9}]

    llm = LLM("http://replay", replay=replay, budget=Budget(max_calls=budget_calls))
    return run_review(
        mr={"title": "修用户接口", "author": {"name": "张三"}, "target_branch": "main"},
        diffs=gitlab_items(),
        llm=llm,
        index=FakeIndex(),
        reader=reader,
        settings=ReviewSettings(max_per_file=3, max_total=15),
        namespace="demo@rev",
    ), files, llm


def test_pipeline() -> None:
    section("流水线端到端（回放）")
    outcome, files, llm = _run_pipeline(REPLAY_OK)
    check("Planner 产出 1 个 block", len(outcome.plan.get("blocks") or []) == 1, str(outcome.plan))
    check("候选数 = 模型给的 5 条", len(outcome.candidates) == 5, str(len(outcome.candidates)))
    check("最终只发 1 条", len(outcome.validation.posted) == 1, str(len(outcome.validation.posted)))
    posted = outcome.validation.posted[0]
    check("发的是第 40 行那条", posted.line == 40 and posted.severity == "major", f"{posted.line}/{posted.severity}")
    counts = outcome.validation.drop_counts()
    check("丢弃原因齐全（行号/置信/未知文件/重复/验证）", {"line_not_changed", "low_confidence", "unknown_file", "duplicate_in_batch"} <= set(counts), str(counts))
    check("没有触发预算停止", outcome.stopped_reason == "", outcome.stopped_reason)
    check("汇总非空且含标记", outcome.summary.strip().endswith("<!-- ai-review-summary -->"))
    check("transcript 记录了 planner/reviewer/verifier", {e["purpose"] for e in llm.transcript} >= {"planner", "reviewer", "verifier"}, str([e["purpose"] for e in llm.transcript]))
    check("diff 指纹已计算", len(outcome.diff_fp) == 40, outcome.diff_fp)

    # Verifier 拒绝
    rej, _, _ = _run_pipeline(REPLAY_REJECT)
    check("Verifier 拒绝 → 一条都不发", len(rej.validation.posted) == 0, str(len(rej.validation.posted)))
    check("拒绝计入 verifier_rejected", rej.validation.drop_counts().get("verifier_rejected") == 1, str(rej.validation.drop_counts()))

    # Verifier 先取证再判断（有界探索）
    rv, _, llm_rv = _run_pipeline(REPLAY_VERIFY_READ)
    check("Verifier 取证一轮后仍保留", len(rv.validation.posted) == 1)
    check("取证动作被记录", any(s.get("step") == "verify-read" for s in rv.kept[0].get("verify_steps", [])), str(rv.kept[0].get("verify_steps")))
    check("取证后调用次数增加（planner+reviewer+2 次 verifier）", len(llm_rv.transcript) == 4, str(len(llm_rv.transcript)))

    # 预算超限
    limited, _, _ = _run_pipeline(REPLAY_OK, budget_calls=1)
    check("预算超限 → 停止原因带 budget", limited.stopped_reason.startswith("budget:"), limited.stopped_reason)
    check("预算超限仍产出汇总（不静默失败）", "AI 评审" in limited.summary)


# ---------------------------------------------------------------- 5) 任务库


def test_store() -> None:
    section("任务库与队列")
    from .store import Store

    d = tempfile.mkdtemp(prefix="review-db-")
    st = Store(os.path.join(d, "review.db"))

    jid1, created1 = st.enqueue(project_id="7", mr_iid=3, head_sha="aaa", diff_fp="head:aaa")
    jid2, created2 = st.enqueue(project_id="7", mr_iid=3, head_sha="aaa", diff_fp="head:aaa")
    check("同 (project,iid,fp) 幂等，不重复建任务", jid1 == jid2 and created1 and not created2, f"{jid1},{jid2},{created1},{created2}")

    job = st.claim(lease_seconds=60)
    check("能抢占到任务且状态 running", job is not None and job["status"] == "running", str(job and job["status"]))
    again = st.claim(lease_seconds=60)
    check("已被租约占用的任务不会再被抢", again is None)

    st.set_diff_fp(jid1, "content:xyz")
    st.finish(jid1, payload={"ok": True}, model="m", tokens_in=10, tokens_out=2, latency_ms=100)
    done = st.find_done("7", 3, "content:xyz")
    check("按内容指纹能找到已完成任务", done is not None and done["id"] == jid1)

    st.record_findings(jid1, [{"path": "a.py", "line": 1, "severity": "major", "category": "correctness", "message": "m", "confidence": 0.9, "evidence": "", "suggestion": "", "dedupe_key": "k1"}], {"k1"})
    check("已发评论指纹可查询（跨任务去重）", st.posted_keys("7", 3) == {"k1"}, str(st.posted_keys("7", 3)))
    check("队列统计含 done", st.queue_stats().get("done") == 1, str(st.queue_stats()))

    jid3, _ = st.enqueue(project_id="7", mr_iid=4, head_sha="bbb", diff_fp="head:bbb")
    check("新 MR 可以再入队", jid3 != jid1)
    check("requeue 把任务改回 queued", st.requeue(jid3) and st.queue_stats().get("queued", 0) >= 1, str(st.queue_stats()))
    check("finish 带 payload 可读回", bool(st.last_jobs(1)))


# ---------------------------------------------------------------- 6) 发布


def test_publish() -> None:
    section("发布层（dry-run 与 position 降级）")
    from .diff import parse_gitlab_diffs
    from .pipeline import ReviewOutcome
    from .publish import Publisher
    from .util import HttpError
    from .validate import Finding, ValidationResult

    files = parse_gitlab_diffs(gitlab_items(), ["*.lock"])
    outcome = ReviewOutcome(files=files, summary="## AI 评审：x\n\n<!-- ai-review-summary -->")
    outcome.validation = ValidationResult(
        posted=[
            Finding(file="src/user.py", line=40, severity="major", category="correctness", message="空值未处理", confidence=0.9),
        ]
    )

    class FakeGitLab:
        def __init__(self, fail_inline: bool = False):
            self.discussions: list[dict] = []
            self.posted_notes: list[str] = []
            self.updates: list[dict] = []
            self.fail_inline = fail_inline

        def create_discussion(self, pid, iid, body, position=None):
            if self.fail_inline:
                raise HttpError(400, "position is invalid")
            self.discussions.append({"body": body, "position": position})
            return {"id": 1}

        def create_note(self, pid, iid, body):
            self.posted_notes.append(body)
            return {"id": len(self.posted_notes)}

        def notes(self, pid, iid):
            return [{"id": i + 1, "body": b} for i, b in enumerate(self.posted_notes)]

        def update_note(self, pid, iid, note_id, body):
            self.updates.append({"id": note_id, "body": body})
            return {"id": note_id}

    refs = {"base_sha": "b", "start_sha": "s", "head_sha": "h"}
    dry = Publisher(None, 7, 3, refs, dry_run=True)
    res = dry.publish(outcome)
    check("dry-run 不发请求也有 payload", res.posted == 1 and res.notes == 1 and len(res.payloads) == 2, str(len(res.payloads)))

    gl = FakeGitLab()
    pub = Publisher(gl, 7, 3, refs)
    res2 = pub.publish(outcome)
    check("真实发布：行内 discussion 带 position", res2.posted == 1 and gl.discussions[0]["position"]["new_line"] == 40)
    check("真实发布：汇总走 note", res2.notes == 1 and len(gl.posted_notes) == 1 and gl.posted_notes[0].strip().endswith("<!-- ai-review-summary -->"))
    pub.publish(outcome)
    check("重跑时更新同一条汇总（不再新发）", len(gl.posted_notes) == 1 and len(gl.updates) == 1, f"notes={len(gl.posted_notes)} updates={len(gl.updates)}")

    gl_fail = FakeGitLab(fail_inline=True)
    res3 = Publisher(gl_fail, 7, 3, refs).publish(outcome)
    check("position 被拒时降级为普通 note 且带 文件:行", res3.posted == 0 and res3.notes >= 2 and any("src/user.py:40" in n for n in gl_fail.posted_notes), str(gl_fail.posted_notes[:1]))


# ---------------------------------------------------------------- 7) 配置


def test_config() -> None:
    section("配置校验")
    from .config import ConfigError, load_config

    cfg = load_config(
        {
            "GITLAB_URL": "https://gitlab.example.com",
            "GITLAB_TOKEN": "t",
            "WEBHOOK_SECRET": "s",
            "LLM_API_KEY": "k",
            "DATA_DIR": tempfile.mkdtemp(prefix="review-cfg-"),
            "MIN_CONFIDENCE": "0.8",
            "MAX_TOTAL": "9",
            "INDEX_NAMESPACE_MAP": '{"7":"demo@rev"}',
        }
    )
    check("环境变量能装配出配置", cfg.gitlab_url.endswith("example.com") and cfg.review.min_confidence == 0.8 and cfg.review.max_total == 9)
    check("index 命名空间映射解析", cfg.index_namespace_map.get("7") == "demo@rev")
    check("db_path 在 DATA_DIR 下", cfg.db_path.startswith(cfg.data_dir))
    try:
        load_config({"GITLAB_URL": "", "GITLAB_TOKEN": "", "WEBHOOK_SECRET": "", "LLM_API_KEY": "", "DATA_DIR": cfg.data_dir}).validate()
        check("缺必填项时 validate 大声失败", False)
    except ConfigError:
        check("缺必填项时 validate 大声失败", True)


# ---------------------------------------------------------------- 8) chunker


def test_chunker() -> None:
    section("chunker（window/heuristic/配置）")
    from . import chunker as C

    # window 策略
    text = "\n".join(f"line{i}" for i in range(1, 101))
    ws = C.chunk_text(text, 40)
    check("window 切块：100 行 → 3 块", [c["startLine"] for c in ws] == [1, 41, 81] and ws[-1]["endLine"] == 100, str([c["startLine"] for c in ws]))

    # 配置表：groovy 的 maxLines 与插件一致（200）
    cfg = C.resolve_chunk_config("Foo.groovy")
    check("groovy 使用 ast + max_lines=200（与插件策略表一致）", cfg["strategy"] == "ast" and cfg["max_lines"] == 200, str(cfg))
    cfg2 = C.resolve_chunk_config("a.md")
    check("markdown 用 window 60", cfg2["strategy"] == "window" and cfg2["window_lines"] == 60)
    check("未知扩展名退到 heuristic", C.resolve_chunk_config("x.zzz")["strategy"] == "heuristic")

    # heuristic：Java 风格成员边界（方法之间空行 + 类体深度 1）
    java = "\n".join(
        ["class A {", "    void a() {", "        int x = 1;", "        int y = 2;", "    }", "", "    void b() {", "        int z = 3;", "    }", "}"]
        + ["    void c() {", "        int w = 4;", "    }", "}"]
    )
    hs = C.heuristic_chunks(java, min_lines=6, max_lines=120, target_lines=8)
    check("heuristic 至少产出一个块且覆盖全文", len(hs) >= 1 and hs[-1]["endLine"] == len(java.split("\n")), str([(c["startLine"], c["endLine"]) for c in hs]))
    check("heuristic 块哈希稳定（同文本两次一致）", [c["hash"] for c in hs] == [c["hash"] for c in C.heuristic_chunks(java, min_lines=6, max_lines=120, target_lines=8)])

    # ast 走不通时必须降级并带回原因（此处用不存在的语法名模拟）
    check("语法不存在时 parser_for 返回 None", C.parser_for("no-such-grammar") is None)
    got = C.chunk_file("x.go", "package main\n\nfunc main() {\n\n}\n")
    check("缺语法时 chunk_file 记录降级原因（不静默）", got["fellBack"] is True or got["strategy"] in ("ast", "heuristic"), str({k: got[k] for k in ("strategy", "fellBack")}))
    check("body_for_embedding 截断到 1500 字符", len(C.body_for_embedding("x" * 3000)) == 1500)

# ---------------------------------------------------------------- 9) worker 纯函数


def test_worker() -> None:
    section("worker：supersede 判定")
    from .worker import is_superseded

    check("同一 head → 不算 superseded", is_superseded("abc", "abc") is False)
    check("head 变化 → superseded", is_superseded("abc", "def") is True)
    check("任一侧为空 → 不拦（宁发不漏）", is_superseded("", "def") is False and is_superseded("abc", "") is False)


# ---------------------------------------------------------------- 10) 档3：作用域


def _make_worktree(files: dict[str, str]) -> str:
    root = tempfile.mkdtemp(prefix="review-scope-wt-")
    for name, body in files.items():
        path = os.path.join(root, name.replace("/", os.sep))
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
    return root


class FakeIndexServer:
    """最小 code-index-service 桩（档3 契约 §4）：scopes resolve/delete、repos sync、search。

    与 tests/test_sync.py 的假服务端同风格：真起一个 ThreadingHTTPServer，记录全部请求。
    """

    def __init__(self, *, fail_multi: bool = False, resolve_ok: bool = True, delete_ok: bool = True):
        self.calls: list[tuple[str, str, dict]] = []
        self.fail_multi = fail_multi
        self.resolve_ok = resolve_ok
        self.delete_ok = delete_ok
        self.sync_namespace = ""  # 非空时覆盖 sync 响应里的 namespace（验证"以服务端为准"）
        self.scope_namespaces: dict[tuple[str, str], str] = {}
        self.hits: list[dict] = [
            {
                "hash": "h1",
                "path": "src/user.py",
                "start": 1,
                "end": 3,
                "score": 0.9,
                "namespace": "r7@fp#branch:main-abc123",
                "scope": {"kind": "branch", "ref": "main"},
            }
        ]
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # noqa: A003
                pass

            def _send(self, code: int, payload: dict) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _read(self) -> dict:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                try:
                    payload = json.loads(raw or b"{}")
                except ValueError:
                    return {}
                return payload if isinstance(payload, dict) else {}

            def do_POST(self):  # noqa: N802
                payload = self._read()
                path = self.path
                outer.calls.append(("POST", path, payload))
                if path == "/v1/scopes/resolve":
                    if not outer.resolve_ok:
                        return self._send(404, {"error": "not found"})
                    namespace = outer.namespace_for(payload)
                    if not namespace:
                        return self._send(400, {"error": "bad-scope", "reason": "unknown-kind"})
                    return self._send(200, {"namespace": namespace, "exists": True})
                if path == "/v1/search":
                    if outer.fail_multi and payload.get("namespaces"):
                        return self._send(400, {"error": "unsupported-field", "field": "namespaces"})
                    return self._send(
                        200,
                        {
                            "hits": outer.hits,
                            "ms": {"embed": 1.0, "knn": 0.5, "rerank": 0},
                            "coverage": 0.9,
                            "byScope": [{"namespace": outer.hits[0].get("namespace"), "hits": len(outer.hits)}],
                        },
                    )
                if path.startswith("/v1/repos/"):
                    parts = path.strip("/").split("/")
                    action = parts[-1]
                    if action == "sync":
                        namespace = urllib.parse.unquote(parts[2]) if len(parts) >= 3 else ""
                        return self._send(
                            200,
                            {
                                "revision": 1,
                                "unchanged": False,
                                "missing": [],
                                "chunks": 0,
                                "vectors": 0,
                                "namespace": outer.sync_namespace or namespace,
                            },
                        )
                    if action == "chunks":
                        return self._send(200, {"accepted": 0})
                    if action == "embed":
                        return self._send(200, {"ok": True})
                return self._send(404, {"error": "not found"})

            def do_DELETE(self):  # noqa: N802
                outer.calls.append(("DELETE", self.path, {}))
                if not outer.delete_ok:
                    return self._send(500, {"error": "boom"})
                return self._send(200, {"deleted": True, "chunks": 3})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def namespace_for(self, payload: dict) -> str:
        kind = str(payload.get("kind") or "")
        ref = str(payload.get("ref") or "")
        if (kind, ref) in self.scope_namespaces:
            return self.scope_namespaces[(kind, ref)]
        if kind == "branch":
            return f"r7@fp#branch:{ref.replace('/', '-')}-abc123"
        if kind == "pr":
            return f"r7@fp#pr:{ref}"
        return ""

    def calls_matching(self, suffix: str) -> list[tuple[str, str, dict]]:
        return [c for c in self.calls if c[1].endswith(suffix)]

    def last_call(self, suffix: str) -> tuple[str, str, dict] | None:
        got = self.calls_matching(suffix)
        return got[-1] if got else None

    def deletes(self) -> list[tuple[str, str, dict]]:
        return [c for c in self.calls if c[0] == "DELETE"]

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class RecordingIndex:
    """记录检索参数并返回固定命中的假索引客户端。"""

    def __init__(self, hits: list[dict]):
        self.hits = hits
        self.seen: list = []

    def search(self, namespaces, query, k=6, embed_text=None):
        self.seen.append(namespaces)
        return list(self.hits)


def test_scope_config() -> None:
    section("档3：scope 配置与推导")
    from .clients import normalize_namespaces
    from .config import load_config
    from .worker import scope_label, scope_plan

    def load(env: dict):
        return load_config({**env, "DATA_DIR": tempfile.mkdtemp(prefix="review-scope-cfg-")})

    cfg_repo = load({"INDEX_SCOPE_MODE": "", "INDEX_PR_HEAD": "0", "INDEX_PR_TTL_DAYS": "14"})
    check("默认 INDEX_SCOPE_MODE=repo、INDEX_PR_HEAD=0", cfg_repo.index_scope_mode == "repo" and cfg_repo.index_pr_head is False, f"{cfg_repo.index_scope_mode}/{cfg_repo.index_pr_head}")
    cfg_branch = load({"INDEX_SCOPE_MODE": "branch"})
    check("INDEX_SCOPE_MODE=branch 解析", cfg_branch.index_scope_mode == "branch")
    cfg_pr = load({"INDEX_SCOPE_MODE": "pr", "INDEX_PR_HEAD": "1", "INDEX_PR_TTL_DAYS": "7"})
    check("INDEX_SCOPE_MODE=pr + INDEX_PR_HEAD + TTL", cfg_pr.index_scope_mode == "pr" and cfg_pr.index_pr_head is True and cfg_pr.index_pr_ttl_days == 7, f"{cfg_pr.index_scope_mode}/{cfg_pr.index_pr_head}/{cfg_pr.index_pr_ttl_days}")
    cfg_bad = load({"INDEX_SCOPE_MODE": "wat"})
    check("非法 INDEX_SCOPE_MODE 退回 repo", cfg_bad.index_scope_mode == "repo")

    plan_repo = scope_plan(cfg_repo, 123, "main")
    check("repo 模式不产生任何 scope（行为不变）", plan_repo["mode"] == "repo" and plan_repo["base"] is None and plan_repo["head"] is None, str(plan_repo))
    plan_branch = scope_plan(cfg_branch, 123, "release/5.0")
    check("branch 模式：base → branch:<target_branch>", plan_branch["base"] == {"kind": "branch", "ref": "release/5.0"} and plan_branch["head"] is None, str(plan_branch))
    plan_pr_off = scope_plan(load({"INDEX_SCOPE_MODE": "pr", "INDEX_PR_HEAD": "0"}), 123, "main")
    check("pr 模式默认只有 base 作用域", plan_pr_off["base"]["kind"] == "branch" and plan_pr_off["head"] is None, str(plan_pr_off))
    plan_pr = scope_plan(cfg_pr, 123, "main", base_commit="b" * 40, head_commit="h" * 40)
    check("pr+INDEX_PR_HEAD=1：head → pr:<iid>（带 TTL/commit）", plan_pr["head"] == {"kind": "pr", "ref": "123", "ttlDays": 7, "commit": "h" * 40}, str(plan_pr["head"]))
    check("pr 模式 base 作用域带 base commit", plan_pr["base"] == {"kind": "branch", "ref": "main", "commit": "b" * 40}, str(plan_pr["base"]))
    check("scope_label：legacy 与 kind:ref", scope_label(None) == "legacy" and scope_label(plan_pr["head"]) == "pr:123")

    check("normalize_namespaces 单值兼容", normalize_namespaces("a@fp") == ["a@fp"])
    check("normalize_namespaces 去重保序", normalize_namespaces(["a", "a", "b"]) == ["a", "b"])
    check("normalize_namespaces 兼容 [{namespace}] 并忽略空值", normalize_namespaces([{"namespace": "x"}, {"namespace": "x"}, None, ""]) == ["x"])


def test_scope_state() -> None:
    section("档3：project_state scope_json（幂等迁移）")
    from .index_state import IndexState, parse_scope_json, scope_part

    tmp = tempfile.mkdtemp(prefix="review-scope-state-")
    db = os.path.join(tmp, "review.db")
    old_schema = """
    CREATE TABLE project_state(
      project_id TEXT NOT NULL, branch TEXT NOT NULL, mirror_path TEXT, namespace TEXT,
      tag TEXT, repo_state TEXT, revision INT, last_synced_sha TEXT, graph_sha TEXT,
      updated_at REAL, last_error TEXT, PRIMARY KEY(project_id, branch)
    );"""
    with sqlite3.connect(db) as conn:
        conn.executescript(old_schema)
        conn.execute(
            "INSERT INTO project_state(project_id,branch,namespace,repo_state,revision,updated_at) VALUES('7','main','repo-7@fp','st',3,1.0)"
        )

    st = IndexState(db)
    row = st.get("7", "main")
    check("旧库启动时自动补 scope_json 列", row is not None and "scope_json" in row, str(row))
    check("旧行数据保留（legacy 不受影响）", row["namespace"] == "repo-7@fp" and row["revision"] == 3)
    IndexState(db)  # 再开一次：迁移幂等
    check("重复打开 DB 迁移幂等（不报错）", True)

    st.set_scope("7", "main", "base", {"namespace": "repo-7@fp#branch:main-abc123", "scope": {"kind": "branch", "ref": "main"}, "repo_state": "s1", "revision": 1})
    st.set_scope("7", "main", "head", {"namespace": "repo-7@fp#pr:123", "scope": {"kind": "pr", "ref": "123"}, "repo_state": "s2", "revision": 2})
    row2 = st.get("7", "main")
    check("base 作用域记录", scope_part(row2, "base").get("namespace") == "repo-7@fp#branch:main-abc123", str(scope_part(row2, "base")))
    check("head 作用域记录且不覆盖 base", scope_part(row2, "head").get("namespace") == "repo-7@fp#pr:123" and scope_part(row2, "base").get("revision") == 1, str(row2.get("scope_json")))
    check("scope_part 无记录返回 {}", scope_part(row2, "nope") == {} and scope_part(None, "base") == {})
    check("坏 scope_json 安静返回 {}", parse_scope_json("{bad") == {} and parse_scope_json(None) == {})


def test_scope_sync() -> None:
    section("档3：sync payload 带 scope / 多作用域检索")
    from .clients import DictReader, IndexClient
    from .config import AppConfig
    from .context import ContextSettings, build_context
    from .pipeline import ReviewSettings, _hit_brief, build_context as pipeline_build_context
    from .store import Store
    from .sync import IndexSync
    from .worker import Worker, scope_plan

    srv = FakeIndexServer()
    try:
        wt = _make_worktree({"a.py": "def a():\n    return 1\n"})
        sync = IndexSync(srv.url, timeout=5)

        srv.sync_namespace = "r7@fp#branch:server-side-xyz"
        res = sync.sync_worktree(
            wt,
            repo_id="r7",
            chunk_fp="fp",
            namespace="r7@fp#branch:local-abc",
            scope={"kind": "branch", "ref": "main"},
        )
        call = srv.last_call("/sync")
        check("sync payload 带 scope:{kind,ref}", call is not None and call[2].get("scope") == {"kind": "branch", "ref": "main"}, str(call and call[2].get("scope")))
        check("sync 路径使用服务端 resolve 的 namespace", urllib.parse.unquote(call[1].split("/")[3]) == "r7@fp#branch:local-abc", call[1])
        check("sync 以响应 namespace 为准（覆盖请求路径）", res.namespace == "r7@fp#branch:server-side-xyz", res.namespace)

        srv.sync_namespace = ""
        legacy = sync.sync_worktree(wt, repo_id="r7", chunk_fp="fp")
        legacy_call = srv.last_call("/sync")
        check("repo 模式 payload 不带 scope（旧服务端零感知）", "scope" not in legacy_call[2] and legacy.namespace == "r7@fp", str(legacy_call[2].keys()))

        # 多作用域检索：请求体 / 新字段 / 单值兼容 / 旧服务端回退
        cli = IndexClient(srv.url, timeout=5)
        hits = cli.search(["a@fp#main:default", "b@fp#branch:x"], "q", k=3)
        search_call = srv.last_call("/v1/search")
        check("多作用域检索发 namespaces 数组（≤MAX_SEARCH_SCOPES）", search_call[2].get("namespaces") == [{"namespace": "a@fp#main:default"}, {"namespace": "b@fp#branch:x"}] and "namespace" not in search_call[2], str(search_call[2]))
        check("hits 带回 namespace 与 scope", hits and hits[0]["namespace"] == "r7@fp#branch:main-abc123" and hits[0]["scope"]["kind"] == "branch", str(hits[:1]))
        cli.search("a@fp#main:default", "q")
        single_call = srv.last_call("/v1/search")
        check("单作用域仍发旧 payload（旧服务端兼容）", single_call[2].get("namespace") == "a@fp#main:default" and "namespaces" not in single_call[2], str(single_call[2]))

        resolve = cli.resolve_scope("r7", "fp", "pr", "123")
        check("resolve_scope 拿服务端 namespace", resolve is not None and resolve.get("namespace") == "r7@fp#pr:123", str(resolve))
        deleted = cli.delete_scope("r7@fp#pr:123")
        deletes = srv.deletes()
        check("delete_scope 走 DELETE 且 namespace 正确编码", deleted is not None and deleted.get("deleted") is True and bool(deletes) and urllib.parse.unquote(deletes[-1][1]) == "/v1/scopes/r7@fp#pr:123", str(deletes[-1:]))

        srv_bad = FakeIndexServer(fail_multi=True)
        try:
            cli_bad = IndexClient(srv_bad.url, timeout=5)
            fallback_hits = cli_bad.search(["a@fp", "b@fp"], "q")
            calls = srv_bad.calls_matching("/v1/search")
            check("旧服务端 400 → 回退单作用域重试一次", len(calls) == 2 and calls[1][2].get("namespace") == "a@fp" and bool(fallback_hits), f"{len(calls)} calls, hits={len(fallback_hits)}")
        finally:
            srv_bad.close()

        # 上下文/证据：命中项带 namespace/scope，检索传列表
        reader = DictReader(FILES_FOR_REVIEW)
        hit = srv.hits[0]
        rindex = RecordingIndex([hit])
        ctx = build_context(
            index=rindex,
            reader=reader,
            namespaces=["a@fp#main:default", "b@fp#branch:x"],
            query="user",
            changed_paths=set(),
            settings=ContextSettings(max_chunks=2, max_semantic=2, max_graph=0, max_grep=0),
        )
        check("三路上下文：语义检索收到多作用域列表", rindex.seen and rindex.seen[0] == ["a@fp#main:default", "b@fp#branch:x"], str(rindex.seen[:1]))
        check("上下文命中项带 namespace/scope（进 evidence）", bool(ctx) and ctx[0].get("namespace") == hit["namespace"] and ctx[0].get("scope") == hit["scope"], str(ctx[:1]))
        pctx = pipeline_build_context(rindex, reader, ["a@fp#main:default", "b@fp#branch:x"], "user", ReviewSettings(max_context_chunks=2))
        check("pipeline 上下文命中项带 namespace/scope", bool(pctx) and pctx[0].get("scope") == hit["scope"], str(pctx[:1]))
        check("单值调用兼容（str 也能检）", bool(pipeline_build_context(rindex, reader, "a@fp", "user", ReviewSettings(max_context_chunks=1))))
        check("命中渲染带 namespace/scope", _hit_brief({"path": "a.py", "start": 1, "end": 2, "score": 0.5, "namespace": "ns", "scope": {"kind": "branch", "ref": "main"}}) == "a.py:1-2 (score 0.5, ns=ns, scope=branch:main)")
        check("旧命中渲染格式不变", _hit_brief({"path": "a.py", "start": 1, "end": 2, "score": 0.5}) == "a.py:1-2 (score 0.5)")

        # worker：base/head 双作用域同步 + 落库 + 节流回退
        srv2 = FakeIndexServer()
        try:
            srv2.scope_namespaces = {("branch", "release/1.0"): "ns-base", ("pr", "123"): "ns-head"}
            tmp = tempfile.mkdtemp(prefix="review-scope-worker-")
            cfg = AppConfig(
                data_dir=tmp,
                git_strategy="api",
                index_url=srv2.url,
                index_api_key="",
                index_scope_mode="pr",
                index_pr_head=True,
                index_pr_ttl_days=7,
                index_repo_prefix="r",
                index_chunk_fp="fp",
                index_sync_min_interval=600,
            )
            wt_base = _make_worktree({"base.py": "def base():\n    return 1\n"})
            wt_head = _make_worktree({"head.py": "def head():\n    return 2\n"})
            worker = Worker("t", cfg, Store(os.path.join(tmp, "review.db")), threading.Event(), IndexClient(srv2.url, timeout=5))
            plan = scope_plan(cfg, 123, "release/1.0")
            notes: list[str] = []
            got = worker._maybe_sync_index("7", "release/1.0", wt_base, {}, notes, plan=plan, head_worktree=wt_head, iid=123)
            check("worker 返回 base+head 两个作用域 namespace", got == ["ns-base", "ns-head"], str(got))
            resolve_calls = srv2.calls_matching("/v1/scopes/resolve")
            check("worker 用服务端 resolve 的 namespace 做 sync 路径", [urllib.parse.unquote(c[1].split("/")[3]) for c in srv2.calls_matching("/sync")] == ["ns-base", "ns-head"], str([c[1] for c in srv2.calls_matching("/sync")]))
            sync_payloads = [c[2] for c in srv2.calls_matching("/sync")]
            check("base sync 带 branch scope", sync_payloads[0].get("scope") == {"kind": "branch", "ref": "release/1.0"}, str(sync_payloads[0].get("scope")))
            check("head sync 带 pr scope + ttlDays", sync_payloads[1].get("scope") == {"kind": "pr", "ref": "123", "ttlDays": 7}, str(sync_payloads[1].get("scope")))
            check("resolve 请求体符合契约（repoId/chunkFp/kind/ref）", resolve_calls[0][2] == {"repoId": "r-7", "chunkFp": "fp", "kind": "branch", "ref": "release/1.0"}, str(resolve_calls[0][2]))
            state = worker.index_state.get("7", "release/1.0") or {}
            from .index_state import scope_part

            check("scope_json 记录 base/head namespace", scope_part(state, "base").get("namespace") == "ns-base" and scope_part(state, "head").get("namespace") == "ns-head", str(state.get("scope_json")))
            check("顶层 namespace 列保留 base（运维可读）", state.get("namespace") == "ns-base", str(state.get("namespace")))
            check("无降级说明（作用域解析成功）", notes == [], str(notes))
            again = worker._maybe_sync_index("7", "release/1.0", wt_base, state, [], plan=plan, head_worktree=wt_head, iid=123)
            check("节流窗口内沿用已记录的作用域 namespace", again == ["ns-base", "ns-head"] and len(srv2.calls_matching("/sync")) == 2, str(again))
        finally:
            srv2.close()

        # 回归：刚启动的机器 time.monotonic() 很小（CI runner），首次同步不能被节流误杀
        import unittest.mock as _mock
        from dataclasses import replace as _replace

        srv3 = FakeIndexServer()
        try:
            srv3.scope_namespaces = {("branch", "release/1.0"): "ns-base", ("pr", "123"): "ns-head"}
            cfg3 = _replace(cfg, index_url=srv3.url)
            w3 = Worker("t3", cfg3, Store(os.path.join(tmp, "review3.db")), threading.Event(), IndexClient(srv3.url, timeout=5))
            with _mock.patch("app.worker.time.monotonic", return_value=5.0):
                got_boot = w3._maybe_sync_index("7", "release/1.0", wt_base, {}, [], plan=plan, head_worktree=wt_head, iid=123)
            check("刚启动（monotonic=5s）首次同步不被节流", got_boot == ["ns-base", "ns-head"], str(got_boot))
        finally:
            srv3.close()
    finally:
        srv.close()


def test_scope_webhook() -> None:
    section("档3：webhook merge/close 清理 PR 作用域")
    from .config import AppConfig
    from .server import cleanup_pr_scope, process_webhook, serve
    from .store import Store

    srv = FakeIndexServer()
    try:
        cfg_pr = AppConfig(index_url=srv.url, index_scope_mode="pr", index_repo_prefix="r", index_chunk_fp="fp")
        out = cleanup_pr_scope(cfg_pr, 7, 123)
        resolve_call = srv.last_call("/v1/scopes/resolve")
        check("清理：resolve 按 pr:<iid> 请求", resolve_call is not None and resolve_call[2] == {"repoId": "r-7", "chunkFp": "fp", "kind": "pr", "ref": "123"}, str(resolve_call and resolve_call[2]))
        del_calls = srv.deletes()
        check("清理：DELETE 服务端返回的 namespace", bool(del_calls) and urllib.parse.unquote(del_calls[-1][1]) == "/v1/scopes/r7@fp#pr:123", str(del_calls[-1:]))
        check("清理结果带 deleted/namespace", out["attempted"] is True and out["deleted"] is True and out["namespace"] == "r7@fp#pr:123", str(out))

        out_repo = cleanup_pr_scope(AppConfig(index_url=srv.url, index_scope_mode="repo"), 7, 123)
        check("repo 模式不触发清理（零请求）", out_repo["attempted"] is False and out_repo["skipped"].startswith("scope-mode="), str(out_repo))

        srv_nores = FakeIndexServer(resolve_ok=False)
        try:
            out_fail = cleanup_pr_scope(AppConfig(index_url=srv_nores.url, index_scope_mode="pr"), 7, 123)
            check("resolve 失败 → 只记日志仍返回 200（skipped）", out_fail["attempted"] is True and out_fail["deleted"] is False and out_fail["skipped"] == "resolve-failed", str(out_fail))
        finally:
            srv_nores.close()
        srv_del = FakeIndexServer(delete_ok=True)
        try:
            out_del = cleanup_pr_scope(AppConfig(index_url=srv_del.url, index_scope_mode="pr"), 7, 123)
            check("清理幂等（deleted=true 正常路径）", out_del["deleted"] is True)
        finally:
            srv_del.close()

        # process_webhook 路由（与 HTTP 解耦）：merge/close 200 不入队；未知 action 仍 200
        store = Store(os.path.join(tempfile.mkdtemp(prefix="review-scope-hook-"), "review.db"))
        cfg = AppConfig(index_url=srv.url, index_scope_mode="pr", index_repo_prefix="r", index_chunk_fp="fp")
        seen: list[tuple[str, int]] = []

        def fake_cleanup(cfg2, project_id, iid):
            seen.append((str(project_id), int(iid)))
            return {"attempted": True, "deleted": True}

        merge_body = {"object_kind": "merge_request", "project": {"id": 7}, "object_attributes": {"action": "merge", "iid": 123}}
        close_body = {"object_kind": "merge_request", "project": {"id": 9}, "object_attributes": {"action": "close", "iid": 5}}
        code, payload = process_webhook(cfg, store, merge_body, cleanup=fake_cleanup)
        check("merge 事件返回 200 且触发清理（不入队）", code == 200 and payload.get("ok") and seen == [("7", 123)] and store.queue_stats().get("queued", 0) == 0, f"{code} {payload} {seen}")
        code2, payload2 = process_webhook(cfg, store, close_body, cleanup=fake_cleanup)
        check("close 事件同样触发清理", code2 == 200 and payload2.get("ok") and seen[-1] == ("9", 5), f"{code2} {seen}")
        code3, payload3 = process_webhook(cfg, store, {"object_kind": "merge_request", "project": {"id": 7}, "object_attributes": {"action": "labeled", "iid": 1}})
        check("未识别 action 仍返回 200 ignored", code3 == 200 and payload3.get("ignored") is True, f"{code3} {payload3}")
        code4, _payload4 = process_webhook(cfg, store, {"object_kind": "note"})
        check("非 MR 事件仍返回 200 ignored", code4 == 200)
        code5, _payload5 = process_webhook(cfg, store, {"object_kind": "merge_request", "object_attributes": {"action": "merge"}})
        check("merge 缺 project/iid 时 200 ignored（不让 GitLab 重投）", code5 == 200)
        open_body = {"object_kind": "merge_request", "project": {"id": 7}, "object_attributes": {"action": "open", "iid": 3, "last_commit": {"id": "abc"}}}
        code6, payload6 = process_webhook(cfg, store, open_body)
        check("open 事件照旧入队（202）", code6 == 202 and payload6.get("job_id") and store.queue_stats().get("queued", 0) == 1, f"{code6} {payload6}")

        code7, payload7 = process_webhook(cfg, store, merge_body)
        check("webhook merge 真实清理（HTTP 桩）", code7 == 200 and payload7["scope_cleanup"]["deleted"] is True, str(payload7))

        # HTTP 端到端：/webhook 鉴权 + merge 清理
        cfg_http = AppConfig(
            data_dir=tempfile.mkdtemp(prefix="review-scope-http-"),
            webhook_secret="s3cret",
            index_url=srv.url,
            index_scope_mode="pr",
            index_repo_prefix="r",
            index_chunk_fp="fp",
        )
        httpd = serve(cfg_http, Store(os.path.join(cfg_http.data_dir, "review.db")), "127.0.0.1", 0)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/webhook",
                data=json.dumps(merge_body).encode(),
                headers={"Content-Type": "application/json", "X-Gitlab-Token": "s3cret"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
            check("HTTP /webhook merge → 200 并返回清理结果", data.get("ok") is True and data["scope_cleanup"]["deleted"] is True, str(data))
            bad = urllib.request.Request(
                f"http://127.0.0.1:{port}/webhook",
                data=json.dumps(open_body).encode(),
                headers={"Content-Type": "application/json", "X-Gitlab-Token": "wrong"},
                method="POST",
            )
            try:
                urllib.request.urlopen(bad, timeout=5)
                check("webhook 鉴权失败返回 401", False)
            except urllib.error.HTTPError as e:
                check("webhook 鉴权失败返回 401", e.code == 401, str(e.code))
        finally:
            httpd.shutdown()
            httpd.server_close()
    finally:
        srv.close()


# ---------------------------------------------------------------- main


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    print("== review-service 离线自测 ==")
    for fn in (
        test_diff,
        test_validate,
        test_llm,
        test_pipeline,
        test_store,
        test_publish,
        test_config,
        test_chunker,
        test_worker,
        test_scope_config,
        test_scope_state,
        test_scope_sync,
        test_scope_webhook,
    ):
        try:
            fn()
        except Exception:  # noqa: BLE001
            FAILS.append(f"{fn.__name__} 抛异常")
            print("  [FAIL] 用例抛异常：")
            traceback.print_exc()
    print(f"\n通过 {PASS}，失败 {len(FAILS)}")
    if FAILS:
        print("失败项：")
        for f in FAILS:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
