"""P0 spike：验证 tree-sitter + tree-sitter-language-pack 在容器内的可用性。

跑法（容器内）：
    docker run --rm -v <repo>:/repo:ro -v <spikes>:/work:ro python:3.11-slim \
        sh -c "pip install -q tree-sitter==0.26.0 tree-sitter-language-pack==1.22.1 && python /work/probe_ts.py /repo"

输出（供规划文档引用）：
- 导入 API 与版本、语言覆盖
- 各语言文件数、解析耗时、错误数、吞吐（文件/s）
- 峰值内存
"""

from __future__ import annotations

import os
import resource
import sys
import time
import traceback

LANG_BY_EXT = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".groovy": "groovy",
}

SKIP_DIRS = {".git", "node_modules", "dist", "build", "target", "vendor", "out", ".venv", "__pycache__"}


def collect(root: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            lang = LANG_BY_EXT.get(ext)
            if lang:
                out.setdefault(lang, []).append(os.path.join(dirpath, name))
    return out


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "/repo"
    print("== tree-sitter 可用性探针 ==")
    try:
        import tree_sitter as ts

        print(f"tree_sitter: {ts.__version__ if hasattr(ts, '__version__') else '?'}  路径={ts.__file__}")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] 导入 tree_sitter 失败：{e}")
        traceback.print_exc()
        return 1

    get_parser = get_language = None
    try:
        from tree_sitter_language_pack import get_parser, get_language  # type: ignore

        print("language_pack 导入方式：from tree_sitter_language_pack import get_parser, get_language")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] 导入 language_pack 失败：{e}")
        try:
            import tree_sitter_language_pack as lp  # type: ignore

            print("language_pack 模块属性：", [a for a in dir(lp) if not a.startswith("_")][:20])
        except Exception:  # noqa: BLE001
            pass
        return 1

    # 语言覆盖：逐个尝试加载
    langs = ["python", "javascript", "typescript", "tsx", "java", "go", "rust", "groovy"]
    ok_langs = []
    for lang in langs:
        try:
            get_language(lang)
            ok_langs.append(lang)
        except Exception as e:  # noqa: BLE001
            print(f"  语言不可用：{lang}（{type(e).__name__}: {e}）")
    print(f"可用语言（{len(ok_langs)}/{len(langs)}）：{', '.join(ok_langs)}")

    groups = collect(root)
    total_files = sum(len(v) for v in groups.values())
    print(f"仓库 {root}：识别到 {total_files} 个可解析文件")
    if total_files == 0:
        return 0

    parsed = 0
    errors = 0
    bytes_total = 0
    t0 = time.monotonic()
    for lang, files in sorted(groups.items()):
        if lang not in ok_langs:
            print(f"  {lang:<11} {len(files):>5} 个文件（跳过：语言不可用）")
            continue
        parser = get_parser(lang)
        lang_t0 = time.monotonic()
        lang_err = 0
        node_count = 0
        for path in files:
            try:
                with open(path, "rb") as f:
                    src = f.read()
                bytes_total += len(src)
                tree = parser.parse(src)
                node_count += tree.root_node.child_count
                parsed += 1
            except Exception:  # noqa: BLE001
                lang_err += 1
                errors += 1
        dt = time.monotonic() - lang_t0
        print(
            f"  {lang:<11} {len(files):>5} 个文件  {dt*1000:>7.0f} ms  "
            f"{len(files)/dt if dt else 0:>7.0f} 文件/s  错误 {lang_err}"
        )
    total_dt = time.monotonic() - t0
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    print(
        f"合计：解析 {parsed} 个文件，{bytes_total/1024/1024:.1f} MB，"
        f"{total_dt*1000:.0f} ms，吞吐 {parsed/total_dt if total_dt else 0:.0f} 文件/s，"
        f"错误 {errors}，峰值内存 {rss:.0f} MB"
    )
    return 0 if errors == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
