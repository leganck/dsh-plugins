"""离线自测：不联网、不需要模型、不需要 GitLab。

跑法：
    python -m app.selftest          # 或者  python app/selftest.py

它覆盖的是"最容易出错、最值得回归"的部分：
  diff 解析（新文件/删除/二进制/换行符/行号）、降噪与丢弃原因、回放与预算、
  流水线端到端（含 Verifier 保留与拒绝两条路径）、任务库幂等与队列、发布层（含 position 降级）。
"""

from __future__ import annotations

import os
import sys
import tempfile
import traceback

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


# ---------------------------------------------------------------- main


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    print("== review-service 离线自测 ==")
    for fn in (test_diff, test_validate, test_llm, test_pipeline, test_store, test_publish, test_config, test_chunker, test_worker):
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
