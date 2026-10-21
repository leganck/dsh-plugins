"""上下文三路融合 + 并行执行验收（不需要 tree-sitter，但 grep 需要 git）。

    python tests/test_context_parallel.py

覆盖：
- build_context：语义/图谱/grep 三路去重、排除改动文件、预算截断、确定性排序；
- git_grep：真实 git 仓库里命中标识符；
- map_limited：结果顺序稳定、单任务异常隔离、deadline 到点、raise_on 冒泡。
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:  # Windows 控制台默认 GBK：统一改成 UTF-8，避免中文/emoji 输出崩
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


from app.clients import DictReader  # noqa: E402
from app.context import ContextSettings, build_context, extract_terms, git_grep  # noqa: E402
from app.parallel import Deadline, map_limited  # noqa: E402

PASS = 0
FAILS: list[str] = []


def check(label: str, cond, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  [ok] {label}")
    else:
        FAILS.append(label)
        print(f"  [FAIL] {label}" + (f" —— {detail}" if detail else ""))


FILES = {
    "a.py": "def main():\n    helper()\n    return 1\n",
    "b.py": "def helper():\n    return 2\n",
    "c.py": "def other():\n    return 3\n",
    "d.py": "def main():\n    return 4\n",
}


class FakeIndex:
    def __init__(self, hits):
        self.hits = hits
        self.calls = 0

    def search(self, namespace, query, k=6, embed_text=None):
        self.calls += 1
        return self.hits


class FakeGraph:
    def __init__(self, callers):
        self._callers = callers

    def callers(self, sid, min_confidence=0.6, limit=20):
        return self._callers


def make_git_repo(root: str) -> None:
    os.makedirs(root, exist_ok=True)
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    subprocess.run(["git", "init", "-q", "-b", "main", root], check=True, env=env)
    for name, text in FILES.items():
        with open(os.path.join(root, name), "w", encoding="utf-8") as f:
            f.write(text)
    subprocess.run(["git", "-C", root, "add", "-A"], check=True, env=env)
    subprocess.run(["git", "-C", root, "commit", "-q", "-m", "init"], check=True, env=env)


def main() -> int:
    reader = DictReader(FILES)

    check("1. extract_terms 跳过常见词", extract_terms("def main(): return helper_call()", 3) == ["main", "helper_call"], str(extract_terms("def main(): return helper_call()", 3)))

    tmp = tempfile.mkdtemp(prefix="ctx-test-")
    repo = os.path.join(tmp, "repo")
    make_git_repo(repo)

    grep = git_grep(repo, ["helper"], max_hits=3)
    check("2. git_grep 命中定义与调用", any(h["path"] == "b.py" for h in grep) and any(h["path"] == "a.py" for h in grep), str(grep))

    index = FakeIndex(
        [
            {"path": "b.py", "start": 1, "end": 2, "score": 0.9},
            {"path": "a.py", "start": 1, "end": 3, "score": 0.8},  # 改动文件，应被排除
            {"path": "c.py", "start": 1, "end": 2, "score": 0.7},
        ]
    )
    graph = FakeGraph([{"path": "c.py", "line": 1, "confidence": 1.0}])
    ctx = build_context(
        index=index,
        graph=graph,
        reader=reader,
        namespace="repo-7@review-1",
        query="helper main",
        changed_paths={"a.py"},
        symbol_ids=[1],
        worktree=repo,
        settings=ContextSettings(max_chunks=4, max_semantic=2, max_graph=2, max_grep=2),
    )
    sources = [c["source"] for c in ctx]
    check("3. 三路都有产出", set(sources) >= {"graph", "semantic", "grep"}, str(sources))
    check("4. 排除改动文件", all(c["path"] != "a.py" for c in ctx), str([c["path"] for c in ctx]))
    check("5. 预算截断（≤4）", len(ctx) <= 4, str(len(ctx)))
    check("6. 确定性顺序（图谱优先）", sources[0] == "graph", str(sources))
    check("7. 去重无重复 key", len({(c["path"], c["start"], c["end"]) for c in ctx}) == len(ctx))
    check("8. 每段正文非空", all(c["text"] for c in ctx))

    # 并行：顺序稳定 + 异常隔离 + deadline + raise_on
    items = list(range(8))

    def slow(x):
        time.sleep(0.01)
        return x * x

    res = map_limited(slow, items, concurrency=4)
    check("9. 并行结果与输入同序", [r["value"] for r in res] == [x * x for x in items])

    def boom(x):
        if x == 3:
            raise ValueError("boom")
        return x

    res2 = map_limited(boom, items, concurrency=4)
    check("10. 单任务异常被隔离", res2[3]["ok"] is False and "ValueError" in res2[3]["error"] and res2[0]["ok"] is True)

    dl = Deadline(seconds=0.0)
    res3 = map_limited(slow, items, concurrency=2, deadline=dl)
    check("11. deadline 到期不再执行", all(r["error"] == "deadline" for r in res3), str({r["error"] for r in res3}))

    def budget(x):
        raise RuntimeError("budget")

    try:
        map_limited(budget, [1, 2], raise_on=(RuntimeError,))
        check("12. raise_on 异常向上冒泡", False)
    except RuntimeError:
        check("12. raise_on 异常向上冒泡", True)

    print(f"\n通过 {PASS}，失败 {len(FAILS)}")
    if FAILS:
        print("失败项：")
        for f in FAILS:
            print("  - " + f)
        return 1
    print("✅ context/parallel 验收通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
