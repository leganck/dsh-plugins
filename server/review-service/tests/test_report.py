"""影子模式报表验收（只读 SQLite，不需要 tree-sitter/git，可在 Windows 跑）。

    python tests/test_report.py
"""

from __future__ import annotations

import csv
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:  # Windows 控制台默认 GBK：统一改成 UTF-8，避免中文/emoji 输出崩
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


from app.report import build_report, main as report_main, render_markdown, write_csv  # noqa: E402
from app.store import Store  # noqa: E402

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


def seed(db_path: str) -> None:
    st = Store(db_path)
    # 两个 dry-run 任务 + 一个真实发布任务
    for n, posted in ((1, 2), (2, 5)):
        jid, _ = st.enqueue(project_id="7", mr_iid=n, head_sha=f"h{n}", diff_fp=f"fp{n}", dry_run=True)
        st.finish(
            jid,
            payload={
                "stats": {
                    "posted": posted,
                    "dropped": 3,
                    "drop_counts": {"line_not_changed": 1, "low_confidence": 2},
                },
                "skips": [{"path": "a.png", "reason": "binary"}, {"path": "b.lock", "reason": "ignored"}],
                "degraded": ["索引同步失败（降级为无跨文件语义上下文）：RuntimeError: boom"],
                "publish": {"dry_run": True},
                "dry_run_payloads": [
                    {
                        "discussion": {
                            "body": "**[major] correctness**\n\n空指针风险\n\n<!-- ai-review:abc -->",
                            "position": {"new_path": "src/a.py", "new_line": 42},
                        }
                    }
                ],
            },
            model="deepseek-chat",
            tokens_in=10_000,
            tokens_out=2_000,
            latency_ms=12_000,
        )
    jid, _ = st.enqueue(project_id="7", mr_iid=3, head_sha="h3", diff_fp="fp3", dry_run=False)
    st.finish(jid, payload={"publish": {"dry_run": False}, "stats": {"posted": 1}}, latency_ms=8_000)


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="report-test-")
    db = os.path.join(tmp, "review.db")
    seed(db)

    jobs = __import__("app.report", fromlist=["_load_jobs"])._load_jobs(db, 30, None)
    check("1. 读出 3 个完成任务", len(jobs) == 3, str(len(jobs)))

    rep = build_report(jobs, days=14, price_in=0.30, price_out=1.20)
    check("2. dry-run 任务数正确", rep["dry_run"] == 2 and rep["live"] == 1, str(rep["dry_run"]))
    check("3. 噪声统计（2/5 → 均值 3.5）", rep["posted_mean"] == 3.5 and rep["posted_p90"] == 5, str(rep["posted_mean"]))
    check("4. 丢弃原因聚合", rep["drop_counts"] == {"low_confidence": 4, "line_not_changed": 2}, str(rep["drop_counts"]))
    check("5. 未评审文件原因", rep["skip_reasons"] == {"binary": 2, "ignored": 2}, str(rep["skip_reasons"]))
    check("6. 降级记录", len(rep["degraded"]) == 1, str(rep["degraded"]))
    # tokens: dry 12k in / 2.4k out（两个）+ live 0；成本按全量 12k/2.4k 算
    check("7. tokens 与成本", rep["tokens_in"] == 20_000 and rep["tokens_out"] == 4_000 and rep["cost_usd"] > 0, str(rep["tokens_in"]))
    check("8. 延迟 p50/p95 合理", 8.0 <= rep["latency_p95"] <= 12.0, str(rep["latency_p95"]))
    check("9. 待标注清单（2 条，严重度解析）", len(rep["findings"]) == 2 and rep["findings"][0]["severity"] == "major", str(rep["findings"][:1]))

    md = render_markdown(rep)
    check("10. Markdown 含全部小节", all(k in md for k in ("概览", "噪声与丢弃原因", "未评审文件", "降级/异常", "待标注清单")), md[:120])
    check("11. 表格里带文件:行", "`src/a.py:42`" in md)

    csv_path = os.path.join(tmp, "findings.csv")
    write_csv(rep, csv_path)
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    check("12. CSV 表头与空标签列", rows[0] == ["project_id", "mr_iid", "path", "line", "severity", "comment", "label", "note"] and rows[1][6] == "", str(rows[:2]))

    out = os.path.join(tmp, "shadow.md")
    rc = report_main(["--db", db, "--days", "7", "--out", out, "--csv", os.path.join(tmp, "x.csv")])
    check("13. CLI 写出报表文件", rc == 0 and os.path.getsize(out) > 100)

    print(f"\n通过 {PASS}，失败 {len(FAILS)}")
    if FAILS:
        print("失败项：")
        for f in FAILS:
            print("  - " + f)
        return 1
    print("✅ report 验收通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
