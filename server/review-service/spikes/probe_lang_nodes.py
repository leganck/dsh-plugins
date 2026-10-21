"""打印某个文件在指定语法下的节点树（用于修正 query 的节点名）。

    python spikes/probe_lang_nodes.py groovy tests/fixtures/graph-sample/g.groovy
    python spikes/probe_lang_nodes.py typescript tests/fixtures/graph-sample/d.ts
"""

from __future__ import annotations

import sys

from tree_sitter_language_pack import get_parser


def walk(node, depth: int = 0, max_depth: int = 4) -> None:
    indent = "  " * depth
    field = ""
    print(f"{indent}{node.type}{field}  [{node.start_point[0] + 1}]")
    if depth >= max_depth:
        return
    for ch in node.named_children:
        walk(ch, depth + 1, max_depth)


def main() -> int:
    lang = sys.argv[1]
    path = sys.argv[2]
    parser = get_parser(lang)
    with open(path, "rb") as f:
        src = f.read()
    tree = parser.parse(src)
    walk(tree.root_node)
    return 0


if __name__ == "__main__":
    sys.exit(main())
