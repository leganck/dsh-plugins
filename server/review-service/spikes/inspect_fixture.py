"""调试：打印 graph-sample 夹具里每个文件的符号（检查各语言 query 是否生效）。

    python spikes/inspect_fixture.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.graph import Graph  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures", "graph-sample")


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="graph-inspect-")
    repo = os.path.join(tmp, "repo")
    shutil.copytree(FIXTURE, repo)
    g = Graph(os.path.join(tmp, "g.db", ), project_id="inspect", branch="main")
    stats = g.build(repo)
    print(f"stats: {stats}")
    for path in sorted({r["path"] for r in g._q("SELECT path FROM graph_symbols WHERE project_id=? AND branch=?", (g.project_id, g.branch))}):
        rows = g._q(
            "SELECT kind, name, receiver, start, end FROM graph_symbols WHERE project_id=? AND branch=? AND path=? ORDER BY id",
            (g.project_id, g.branch, path),
        )
        print(path, "→", [(r["kind"], r["name"], r["receiver"]) for r in rows])
    return 0


if __name__ == "__main__":
    sys.exit(main())
