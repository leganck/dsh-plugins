"""影子模式报表：把 dry-run 跑出来的数据导出成"可读 + 可标注"的文件。

用法：
    python -m app.report --days 14 --out shadow.md
    python -m app.report --days 14 --csv findings.csv

统计口径（与计划的 G2 决策门一致）：
- 噪声：每个 MR 会发多少条行内评论（均值/中位数/p90）；
- 丢弃原因：为什么没发（行号错/置信度低/重复/验证拒绝…）；
- 成本：tokens 与估算费用（--price-in/--price-out，单位 USD/1M token）；
- 延迟：p50/p95（端到端秒数）；
- 待标注清单：每条"本该发的评论"，供人工打 正确/误报 标签。

只读 SQLite，不联网、不改数据。
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import statistics
import sys
from datetime import datetime, timezone

DEFAULT_PRICE_IN = 0.30  # USD / 1M input tokens（可被 --price-in 覆盖）
DEFAULT_PRICE_OUT = 1.20  # USD / 1M output tokens


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    idx = min(len(values) - 1, max(0, int(round((pct / 100.0) * (len(values) - 1)))))
    return float(values[idx])


def _fmt_money(usd: float) -> str:
    return f"${usd:.4f}" if usd < 1 else f"${usd:.2f}"


def _load_jobs(db_path: str, days: int, project: str | None) -> list[dict]:
    if not os.path.exists(db_path):
        raise SystemExit(f"数据库不存在：{db_path}（用 --db 指定 review.db 路径）")
    cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    sql = (
        "SELECT id, project_id, mr_iid, status, dry_run, model, tokens_in, tokens_out, "
        "latency_ms, error, payload_json, created_at FROM jobs "
        "WHERE created_at >= ? AND status IN ('done','skipped','failed')"
    )
    args: list = [cutoff]
    if project:
        sql += " AND project_id = ?"
        args.append(str(project))
    sql += " ORDER BY id"
    rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
    for r in rows:
        try:
            r["payload"] = json.loads(r["payload_json"]) if r["payload_json"] else {}
        except json.JSONDecodeError:
            r["payload"] = {}
    return rows


def build_report(jobs: list[dict], *, days: int, price_in: float, price_out: float) -> dict:
    done = [j for j in jobs if j["status"] == "done"]
    dry = [j for j in done if (j.get("payload", {}).get("publish") or {}).get("dry_run")]
    live = [j for j in done if j not in dry]

    posted_counts = [int((j["payload"].get("stats") or {}).get("posted") or 0) for j in dry]
    latency = [float(j.get("latency_ms") or 0) / 1000.0 for j in dry if (j.get("latency_ms") or 0) > 0]
    tokens_in = sum(int(j.get("tokens_in") or 0) for j in done)
    tokens_out = sum(int(j.get("tokens_out") or 0) for j in done)
    cost = tokens_in / 1_000_000 * price_in + tokens_out / 1_000_000 * price_out

    drop_counts: dict[str, int] = {}
    skip_reasons: dict[str, int] = {}
    degraded: dict[str, int] = {}
    findings: list[dict] = []
    for j in dry:
        p = j["payload"]
        for reason, n in ((p.get("stats") or {}).get("drop_counts") or {}).items():
            drop_counts[reason] = drop_counts.get(reason, 0) + int(n)
        for s in p.get("skips") or []:
            skip_reasons[s.get("reason") or "other"] = skip_reasons.get(s.get("reason") or "other", 0) + 1
        for d in p.get("degraded") or []:
            key = str(d)[:60]
            degraded[key] = degraded.get(key, 0) + 1
        for payload in p.get("dry_run_payloads") or []:
            disc = payload.get("discussion") or {}
            pos = disc.get("position") or {}
            body = str(disc.get("body") or "")
            findings.append(
                {
                    "project_id": j["project_id"],
                    "mr_iid": j["mr_iid"],
                    "path": pos.get("new_path") or "",
                    "line": pos.get("new_line") or "",
                    "severity": _extract_severity(body),
                    "body": body,
                    "chars": len(body),
                }
            )

    return {
        "days": days,
        "jobs_total": len(jobs),
        "done": len(done),
        "dry_run": len(dry),
        "live": len(live),
        "failed": len([j for j in jobs if j["status"] == "failed"]),
        "skipped": len([j for j in jobs if j["status"] == "skipped"]),
        "posted_mean": round(statistics.mean(posted_counts), 2) if posted_counts else 0.0,
        "posted_median": round(statistics.median(posted_counts), 2) if posted_counts else 0.0,
        "posted_p90": _percentile(posted_counts, 90),
        "posted_counts": posted_counts,
        "drop_counts": dict(sorted(drop_counts.items(), key=lambda kv: -kv[1])),
        "skip_reasons": dict(sorted(skip_reasons.items(), key=lambda kv: -kv[1])),
        "degraded": dict(sorted(degraded.items(), key=lambda kv: -kv[1])),
        "latency_p50": _percentile(latency, 50),
        "latency_p95": _percentile(latency, 95),
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": cost,
        "cost_per_mr": cost / len(dry) if dry else 0.0,
        "findings": findings,
    }


def _extract_severity(body: str) -> str:
    for sev in ("critical", "major", "minor", "trivial", "info"):
        if f"[{sev}]" in body:
            return sev
    return "?"


# ---------------------------------------------------------------- 渲染


def render_markdown(rep: dict) -> str:
    lines = [f"# 影子模式报表（近 {rep['days']} 天）", ""]
    lines.append("## 1. 概览")
    lines.append("")
    lines.append("| 项 | 值 |")
    lines.append("|---|---|")
    lines.append(f"| 任务总数 | {rep['jobs_total']} |")
    lines.append(f"| 完成（dry-run） | **{rep['dry_run']}** |")
    lines.append(f"| 完成（已发布） | {rep['live']} |")
    lines.append(f"| 失败 / 跳过 | {rep['failed']} / {rep['skipped']} |")
    lines.append(f"| 每 MR 行内评论（均值/中位/p90） | **{rep['posted_mean']} / {rep['posted_median']} / {rep['posted_p90']}** |")
    lines.append(f"| 端到端延迟 p50/p95 | {rep['latency_p50']:.1f}s / {rep['latency_p95']:.1f}s |")
    lines.append(f"| tokens（in/out） | {rep['tokens_in']:,} / {rep['tokens_out']:,} |")
    lines.append(f"| 估算成本 | {_fmt_money(rep['cost_usd'])}（每 MR {_fmt_money(rep['cost_per_mr'])}） |")
    lines.append("")

    lines.append("## 2. 噪声与丢弃原因")
    lines.append("")
    if rep["drop_counts"]:
        lines.append("| 丢弃原因 | 次数 |")
        lines.append("|---|---|")
        for k, v in rep["drop_counts"].items():
            lines.append(f"| `{k}` | {v} |")
    else:
        lines.append("（没有丢弃记录）")
    lines.append("")

    if rep["skip_reasons"]:
        lines.append("## 3. 未评审文件")
        lines.append("")
        lines.append("| 原因 | 文件数 |")
        lines.append("|---|---|")
        for k, v in rep["skip_reasons"].items():
            lines.append(f"| `{k}` | {v} |")
        lines.append("")

    if rep["degraded"]:
        lines.append("## 4. 降级/异常")
        lines.append("")
        for k, v in rep["degraded"].items():
            lines.append(f"- {v} 次：{k}")
        lines.append("")

    lines.append("## 5. 待标注清单（本该发的评论）")
    lines.append("")
    if rep["findings"]:
        lines.append("| # | MR | 文件:行 | 严重度 | 评论（截断） |")
        lines.append("|---|---|---|---|---|")
        for i, f in enumerate(rep["findings"], 1):
            msg = " ".join(f["body"].split())[:120].replace("|", "\\|")
            lines.append(f"| {i} | !{f['mr_iid']} | `{f['path']}:{f['line']}` | {f['severity']} | {msg} |")
        lines.append("")
        lines.append(f"> 共 {len(rep['findings'])} 条；用 `--csv` 导出带空标签列的表格做人工标注。")
    else:
        lines.append("（没有 dry-run 产出）")
    lines.append("")
    return "\n".join(lines)


def write_csv(rep: dict, path: str) -> None:
    import csv

    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["project_id", "mr_iid", "path", "line", "severity", "comment", "label", "note"])
        for x in rep["findings"]:
            w.writerow([x["project_id"], x["mr_iid"], x["path"], x["line"], x["severity"], x["body"], "", ""])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="影子模式报表（只读 SQLite）")
    ap.add_argument("--db", default=os.path.join(os.environ.get("DATA_DIR", "/data"), "review.db"))
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--project", default=None, help="只看某个 project_id")
    ap.add_argument("--out", default=None, help="Markdown 输出路径（默认 stdout）")
    ap.add_argument("--csv", default=None, help="CSV 输出路径（标注用）")
    ap.add_argument("--price-in", type=float, default=DEFAULT_PRICE_IN)
    ap.add_argument("--price-out", type=float, default=DEFAULT_PRICE_OUT)
    args = ap.parse_args(argv)

    jobs = _load_jobs(args.db, args.days, args.project)
    rep = build_report(jobs, days=args.days, price_in=args.price_in, price_out=args.price_out)
    md = render_markdown(rep)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(md)
        print(f"已写出 {args.out}（{rep['dry_run']} 个 dry-run 任务，{len(rep['findings'])} 条待标注）")
    else:
        print(md)
    if args.csv:
        write_csv(rep, args.csv)
        print(f"已写出 {args.csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
