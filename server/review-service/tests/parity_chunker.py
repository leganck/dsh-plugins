"""chunker parity：Python 版 vs 插件（JS）golden。

跑法（容器内，需要 tree-sitter 依赖）：
    python tests/parity_chunker.py \
        --golden tests/fixtures/chunk-golden.json \
        --repo dsh-plugins=/work/dsh-plugins --repo energy=/work/energy

判定（与计划一致）：
- 策略一致（golden 是 ast，Python 也必须是 ast，不允许静默降级）
- 块数一致
- 块边界（startLine,endLine）相同比例 ≥ 95%
任何一条不满足 → 退出码 1，并打印首个不一致细节。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:  # Windows 控制台默认 GBK：统一改成 UTF-8，避免中文/emoji 输出崩
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


from app.chunker import chunk_file  # noqa: E402

BOUNDARY_MIN = 0.95


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--golden", default="tests/fixtures/chunk-golden.json")
    ap.add_argument("--repo", action="append", default=[], help="逻辑仓库名=本地路径，可重复")
    ap.add_argument("--min-ratio", type=float, default=BOUNDARY_MIN)
    args = ap.parse_args()

    repos: dict[str, str] = {}
    for item in args.repo:
        name, _, path = item.partition("=")
        repos[name] = os.path.abspath(path)

    with open(args.golden, "r", encoding="utf-8") as f:
        golden = json.load(f)
    files = golden.get("files") or []
    print(f"== chunker parity ==\ngolden：{len(files)} 文件 / {golden.get('totals', {}).get('chunks', '?')} 块")

    failures: list[str] = []
    checked = 0
    total_ratio = 0.0
    for item in files:
        repo = item.get("repo") or "dsh-plugins"
        root = repos.get(repo)
        if not root:
            print(f"  [skip] {item['path']}（未提供仓库 {repo} 的路径）")
            continue
        abs_path = os.path.join(root, item["path"])
        if not os.path.exists(abs_path):
            print(f"  [skip] {item['path']}（文件不存在：{abs_path}）")
            continue
        with open(abs_path, "r", encoding="utf-8", newline="") as f:  # newline="" 保留 CRLF，与 JS 读法一致
            text = f.read()
        expected_hash = item.get("textHash")
        if expected_hash and hashlib.sha256(text.encode("utf-8")).hexdigest() != expected_hash:
            print(f"  [stale] {item['path']}（文件已改动，golden 过期；重跑 spikes/make_chunk_golden.mjs）")
            continue

        got = chunk_file(item["path"], text)
        ref_boundaries = {(c["start"], c["end"]) for c in item["chunks"]}
        got_boundaries = {(c["startLine"], c["endLine"]) for c in got["chunks"]}
        hit = len(ref_boundaries & got_boundaries)
        ratio = hit / max(len(ref_boundaries), len(got_boundaries), 1)
        checked += 1
        total_ratio += ratio

        problems = []
        if got["strategy"] != item.get("strategy"):
            problems.append(f"策略 {got['strategy']} != golden {item.get('strategy')}")
        if got["fellBack"]:
            problems.append(f"发生降级：{got.get('reason')}")
        if len(got["chunks"]) != item.get("chunkCount"):
            problems.append(f"块数 {len(got['chunks'])} != {item.get('chunkCount')}")
        if ratio < args.min_ratio:
            problems.append(f"边界一致率 {ratio:.1%} < {args.min_ratio:.0%}")
        if problems:
            detail = "；".join(problems)
            failures.append(f"{item['path']}：{detail}")
            print(f"  [FAIL] {item['path']}：{detail}")
            only_ref = sorted(ref_boundaries - got_boundaries)[:3]
            only_got = sorted(got_boundaries - ref_boundaries)[:3]
            if only_ref or only_got:
                print(f"         golden 有而我们没有：{only_ref}")
                print(f"         我们有而 golden 没有：{only_got}")
        else:
            print(f"  [ok] {item['path']}：{len(got['chunks'])} 块，边界 {ratio:.0%}")

    if checked == 0:
        print("没有可比对的文件（检查 --repo 参数）")
        return 2
    avg = total_ratio / checked
    print(f"\n比对 {checked} 文件：通过 {checked - len(failures)}，失败 {len(failures)}，平均边界一致率 {avg:.1%}")
    if failures:
        print("失败项：")
        for f in failures:
            print("  - " + f)
        return 1
    print("✅ parity 通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
