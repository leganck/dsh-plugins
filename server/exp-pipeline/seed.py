#!/usr/bin/env python
"""seed.py：把 experience-digest.md 的 223 条种子灌入 index-server memories。

用法：
  python seed.py --dry-run                     # 只解析统计，不写任何服务端（零网络）
  python seed.py --url http://127.0.0.1:18081 --api-key K [--digest FILE] [--stats]

设计：
- 解析：直接复用 pipeline（task-6）现成的 digest 解析器
  `stage_b_rules.parse_digest`（pipeline.py --from-digest 同一入口），保证种子
  条目与管道正式灌库的 (repo, lens, what, when_expr, evidence) 形状完全一致。
- 幂等重放（id 连续可重跑）：服务端 upsert 契约（index_store.MemoryStore.upsert，
  L1624）以 (repo, lens, what) 三元组为幂等键——同三元组二次提交返回同 id +
  action=updated，不产生新行；因此**无需带 id upsert**（服务端契约本身不带 id），
  同一 digest 文件重跑即全部 action=updated，条目数不增长。本脚本在 --stats
  模式下输出 created/updated/skipped 分布作为重放证据。
  备选方案（未采用）：对 what+when 派生 sha1 确定性 id（如 exp-<hash12>）——
  被弃用，因为服务端 _MEMORY_ID_RE 只认 exp-\\d{6} 自增格式，带自定义 id 的
  upsert 会被 400 拒绝；改由 (repo, lens, what) 服务端幂等键承载重放语义。
- 与 pipeline.py --from-digest 的区别：pipeline 走完整三层治理（Review/Dedup/
  Merge，digest 之外的输入设计）；本脚本面向"已人工审过的 223 条评测种子"，
  原样灌入（不丢条目，供检索评测与影子对比），这是 M1「223 条种子灌入」的
  验收口径。垃圾过滤由 pipeline dry-run 跑批单独验收（见 ACCEPTANCE.md）。

安全：默认 dry-run 零网络；--url 必须显式给出（本仓库演示一律指向
127.0.0.1 随机端口的临时服务，绝不写线上）。
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from client import IndexClient, PipelineClientError  # noqa: E402
from stage_b_rules import parse_digest  # noqa: E402  task-6 现成 digest 解析器

DEFAULT_DIGEST = r"D:\work\bug-analysis\_check\session-4ff93b80-experience\experience-digest.md"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="灌 223 条种子经验进 memories（幂等可重放）")
    p.add_argument("--digest", default=DEFAULT_DIGEST, help="experience-digest.md 路径")
    p.add_argument("--dry-run", action="store_true", help="只解析统计，不写服务端（零网络）")
    p.add_argument("--url", default="", help="index-server 基址（如 http://127.0.0.1:18081）")
    p.add_argument("--api-key", default="", help="Bearer 鉴权（本地开放服务可省）")
    p.add_argument("--status", default="active",
                   help="写入状态（active|conflicting；默认 active）")
    p.add_argument("--stats", action="store_true", help="结束后打 created/updated 分布")
    p.add_argument("--verbose", action="store_true", help="逐条打印前 5 条样例")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    with open(args.digest, "r", encoding="utf-8") as fh:
        text = fh.read()
    cands = parse_digest(text)  # 去重口径与素材 223 条一致（keep_duplicates=False）

    print(f"== seed（digest={os.path.basename(args.digest)}）==")
    lens_count = Counter(c.lens for c in cands)
    repo_count = Counter(c.repo for c in cands)
    print(f"解析 {len(cands)} 条唯一条目 | lens 分布 {dict(lens_count)} "
          f"| repo top: {repo_count.most_common(3)}")
    if args.verbose:
        for c in cands[:5]:
            print(f"  样例 [{c.lens}] {c.what[:76]}")
            print(f"        when: {c.when_expr[:60]} | ev: {c.evidence[:1]}")

    if args.dry_run:
        print("(dry-run：未发起任何网络请求，未写服务端)")
        return 0

    if not args.url:
        print("错误：正式灌库必须显式 --url（演示一律 http://127.0.0.1:<随机端口>）", file=sys.stderr)
        return 2
    client = IndexClient(base_url=args.url, api_key=args.api_key or None)

    actions = Counter()
    err = 0
    for i, c in enumerate(cands, 1):
        payload = c.to_payload() | {"status": args.status}
        try:
            out = client.memory_upsert(payload)
            actions[out.get("action", "?")] += 1
            if args.verbose and i <= 5:
                print(f"  [{i:>3}] {out.get('action'):>7} {out.get('id')}  {c.what[:60]}")
        except PipelineClientError as e:
            err += 1
            print(f"  [{i:>3}] 失败 {c.what[:60]}: {e}", file=sys.stderr)
    total_in = len(cands)
    written = sum(v for k, v in actions.items() if k != "skip")
    print(f"灌库完成：写入请求 {total_in} 条，失败 {err} | 服务端动作分布 {dict(actions)} "
          f"| 库内净增 ≈ {written if 'created' not in actions else actions['created']}（重放时应全为 updated，净增 0）")
    if args.stats:
        print(f"stats: {dict(actions)}")
    return 1 if err else 0


if __name__ == "__main__":
    sys.exit(main())
