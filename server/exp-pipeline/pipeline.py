#!/usr/bin/env python
"""exp-pipeline 主入口：读本地 DSH 归档 → 清洗 → 三层治理 → 写 index-server memories。

用法：
  python pipeline.py [--archive-dir DIR] [--since YYYY-MM-DD] [--session ID]
                     [--dry-run] [--llm] [--limit N] [--from-digest FILE]
                     [--explore] [--no-verify] [--top-k N] [--verbose]

默认 --archive-dir = ~/.dsh/archive。--dry-run 只出判定不写服务端（默认也不发起
任何网络请求；加 --explore 才在 dry-run 下做只读源码探索 /v1/search）。
--llm 需 PIPE_LLM_URL/PIPE_LLM_KEY/PIPE_LLM_MODEL，缺省时优雅降级规则版（提示，不报错）。
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from client import IndexClient  # noqa: E402
from common import trunc  # noqa: E402
from stage_a import load_segments, split_topics  # noqa: E402
from stage_b_rules import extract_rules, parse_digest  # noqa: E402
from stage_b_llm import extract_llm, llm_env_available  # noqa: E402
from stage_c import run_governance  # noqa: E402


def default_archive_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".dsh", "archive")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="经验提纯管道（离线，不常驻）")
    p.add_argument("--archive-dir", default=default_archive_dir(),
                   help="归档根目录（默认 ~/.dsh/archive）")
    p.add_argument("--since", default="", help="只处理 Written >= YYYY-MM-DD 的 segment")
    p.add_argument("--session", default="", help="只处理该 sessionId（目录名）")
    p.add_argument("--dry-run", action="store_true", help="只出治理判定，不写服务端")
    p.add_argument("--llm", action="store_true", help="LLM 抽取（缺 env 自动降级规则版）")
    p.add_argument("--limit", type=int, default=0, help="最多处理 N 个候选（0=不限）")
    p.add_argument("--from-digest", default="", help="从 experience-digest.md 灌库（跳过 Stage A）")
    p.add_argument("--explore", action="store_true",
                   help="dry-run 下也做只读源码探索（POST /v1/search 验证类名/方法名）")
    p.add_argument("--no-verify", action="store_true", help="Review 跳过源码探索")
    p.add_argument("--top-k", type=int, default=5, help="Merge 同向查询 top_k")
    p.add_argument("--verbose", action="store_true", help="打印候选明细")
    return p


def gather_candidates(args) -> tuple[list, str, list[str]]:
    """返回 (候选列表, 引擎标记, notes)。"""
    notes: list[str] = []
    if args.from_digest:
        with open(args.from_digest, "r", encoding="utf-8") as fh:
            text = fh.read()
        cands = parse_digest(text)
        engine = "digest"
        notes.append(f"--from-digest 解析 {len(cands)} 条唯一条目（原始 bullet 去重后）")
        if args.llm:
            notes.append("--from-digest 输入跳过 LLM（digest 已是提炼稿，直接走治理）")
        return cands, engine, notes

    segments = load_segments(args.archive_dir, session_id=args.session,
                             since=args.since)
    notes.append(f"载入 {len(segments)} 个 segment（archive={args.archive_dir}"
                 + (f" session={args.session}" if args.session else "")
                 + (f" since={args.since}" if args.since else "") + "）")
    topics = []
    for seg in segments:
        topics.extend(split_topics(seg))
    notes.append(f"Stage A 切出 {len(topics)} 个主题组（噪声已剥离）")

    engine = "rules"
    cands = []
    if args.llm:
        if llm_env_available():
            try:
                cands, engine = extract_llm(topics)
                notes.append(f"Stage B LLM 抽取 {len(cands)} 条")
            except Exception as e:  # noqa: BLE001
                cands = []
                notes.append(f"[降级] LLM 抽取失败（{e}），回退规则版")
        else:
            notes.append("[降级] --llm 但 PIPE_LLM_URL/PIPE_LLM_KEY/PIPE_LLM_MODEL 未设置，回退规则版")
    if not cands:
        cands = extract_rules(topics)
        engine = "rules" if engine != "digest" else engine
        notes.append(f"Stage B 规则抽取 {len(cands)} 条")
    return cands, engine, notes


def print_report(report: dict, verbose: bool) -> None:
    st = report["stats"]
    print(f"\n== 治理汇总 ==")
    print(f"  候选 {st['candidates_in']} | Review 通过 {st['review_passed']} / 拦截 {st['review_blocked']}"
          f" | Dedup 保留 {st['dedup_kept']} / 合并 {st['dedup_merged']}"
          f" | 动作 {st['actions']} | dry_run={st['dry_run']}")
    blocked = [r for r in report["review"] if not r["pass"]]
    if blocked:
        print(f"\n-- Review 拦截（{len(blocked)}）--")
        for r in blocked[:10]:
            print(f"  [拦] {trunc(r['what'], 70)}  原因={','.join(r['reasons'])}")
    print(f"\n-- Merge 判定（{len(report['merge'])}）--")
    for row in report["merge"]:
        line = f"  [{row['action']:>10}] {trunc(row['what'], 60)}"
        if row["target"]:
            line += f"  -> {row['target']}"
        print(line + f"  ({row['reason']})")
        if verbose:
            print(f"              lens={row['lens']} repo={row['repo']} when={trunc(row['when_expr'], 50)}"
                  f" origin={row['origin']}")


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    print("== exp-pipeline ==")
    cands, engine, notes = gather_candidates(args)
    for n in notes:
        print("  " + n)
    if args.limit and args.limit > 0:
        cands = cands[: args.limit]
        print(f"  --limit 截取 {len(cands)} 条候选")

    client = None
    if not args.dry_run:
        client = IndexClient()
    elif args.explore:
        client = IndexClient()  # dry-run + --explore：只读源码探索，不写
    else:
        print("  (dry-run：跳过源码探索与 Merge 同向查询，全部按无命中判定；加 --explore 可开只读探索)")

    report = run_governance(cands, client=client, dry_run=args.dry_run,
                            verify_symbols=bool(client) and not args.no_verify,
                            top_k=args.top_k)
    report["engine"] = engine
    print_report(report, args.verbose)
    if args.dry_run:
        print("\n(dry-run：未写服务端)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
