"""调试：打印 build_context 的三路来源（与 tests/test_context_parallel.py 同夹具）。"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.test_context_parallel import FILES, FakeGraph, FakeIndex, make_git_repo  # noqa: E402

from app.clients import DictReader  # noqa: E402
from app.context import ContextSettings, build_context, extract_terms, git_grep  # noqa: E402


def main() -> int:
    reader = DictReader(FILES)
    tmp = tempfile.mkdtemp(prefix="ctx-debug-")
    repo = os.path.join(tmp, "repo")
    make_git_repo(repo)
    print("git grep:", git_grep(repo, ["helper", "main"], max_hits=5))
    print("terms:", extract_terms("helper main", 3))
    index = FakeIndex(
        [
            {"path": "b.py", "start": 1, "end": 2, "score": 0.9},
            {"path": "a.py", "start": 1, "end": 3, "score": 0.8},
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
    for c in ctx:
        print(f"  {c['source']:<8} {c['path']}:{c['start']}-{c['end']} conf={c['confidence']} text={c['text'][:40]!r}")
    print("sources:", [c["source"] for c in ctx])
    return 0


if __name__ == "__main__":
    sys.exit(main())
