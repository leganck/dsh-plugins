#!/usr/bin/env python3
"""一次性血统清洗脚本（T-261120-dedup 的第 4 项交付）。

同一仓库因 repoId 推导裂缝裂成多个 lineage 时，chunks/vectors 各存一份。本脚本：
  ⓪ --migrate-cas（仅 --db）：一次性 CAS 迁移（旧 vectors 负载去重搬进 vectors_v2）。
     部署序：**停写 → --migrate-cas [--vacuum] → 起服务**。服务启动只认 v2，
     旧 schema 的库会拒绝启动并提示跑本步。幂等。
  ① --dry-run（默认）：调 GET /v1/admin/lineages/duplicates（HTTP 模式）或
     IndexStore.lineage_duplicates()（直连模式），按组打印「将删除 N 行 / 释放 M MB」；
  ② --apply：按建议逐组合并（from=组内非 suggest 血统，into=suggest），走
     POST /v1/admin/lineages/merge 或 IndexStore.lineage_merge()；
  ③ --hard：merged_into 墓碑行清理（默认要求 merged_at 超过 --min-age-days=7，
     --force 无视龄期）——merge 本身当场物理删重，此步只是清墓碑；
  ④ --vacuum（仅直连模式）：VACUUM + checkpoint，把释放的页真正还给文件系统。

两种连法二选一：
  --db  PATH    直连 SQLite（容器内跑；服务在线时也可用——WAL + BEGIN IMMEDIATE，
                但迁移/合并建议停写后跑）。
  --url BASE    走 HTTP（--token Bearer 或 --user/--password Basic，admin 鉴权）。

安全设计：不带 --apply/--hard/--migrate-cas 时绝不写库/发写请求；--url 模式的
dry-run 是纯 GET。2026-11-20 授权：历史数据可清理，迁移/合并即生效；需要安全网
请先备份 index.db。
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------------------------------------------------------------- HTTP 模式
def http_call(base, method, path, payload=None, token=None, user=None, password=None, timeout=60):
    url = base.rstrip("/") + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    elif user is not None:
        raw = f"{user}:{password or ''}".encode("utf-8")
        req.add_header("Authorization", "Basic " + base64.b64encode(raw).decode())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            body = {"error": str(e)}
        return e.code, body


def http_mode(args):
    token = args.token or os.environ.get("CLEANUP_TOKEN")
    user = args.user if args.user is not None else os.environ.get("CLEANUP_USER")
    password = args.password if args.password is not None else os.environ.get("CLEANUP_PASSWORD")

    def call(method, path, payload=None):
        code, body = http_call(args.url, method, path, payload, token, user, password)
        if code >= 400:
            print(f"❌ HTTP {code} {method} {path}: {body}", file=sys.stderr)
            sys.exit(2)
        return body

    dup = call("GET", "/v1/admin/lineages/duplicates")
    if args.json:
        print(json.dumps(dup, ensure_ascii=False, indent=2))
    print_plan(dup["groups"], args)
    if args.apply:
        for g in dup["groups"]:
            others = [x["id"] for x in g["lineages"] if x["id"] != g["suggestId"]]
            if not others:
                continue
            if args.only and args.only.lower() not in (g["repoName"] or "").lower():
                print(f"跳过（--only 过滤）：{g['repoName']}")
                continue
            print(f"→ 合并 {g['repoName']}: {others} -> {g['suggestId']}")
            result = call("POST", "/v1/admin/lineages/merge", {"from": others, "into": g["suggestId"]})
            print(f"  完成：droppedChunks={result.get('droppedChunks')}"
                  f" droppedVectors={result.get('droppedVectors')}"
                  f" droppedBlobs={result.get('droppedBlobs')}"
                  f" freedBytes={result.get('freedBytes')}")
    if args.hard:
        payload = {"minAgeDays": args.min_age_days}
        if args.force:
            payload["force"] = True
        result = call("POST", "/v1/admin/lineages/hard-clean", payload)
        print(f"物理清理：removed={result.get('removedCount')} {result.get('removed')}")


# ---------------------------------------------------------------- 直连模式
def db_mode(args):
    sys.path.insert(0, SERVICE_ROOT)
    import index_store as istore  # noqa: E402

    if args.migrate_cas:
        # 部署序（Lead 执行）：停写 → 本步迁移 → 起服务。幂等，可重复跑。
        print("CAS 迁移（vectors → vectors_v2，单事务，幂等）…")
        r = istore.cas_migrate_db(args.db, vacuum=args.vacuum)
        print(f"  v2Vectors={r['v2Vectors']}  legacyMembershipRows={r['legacyMembershipRows']}"
              f"  旧表 v 列清空行={r['cleared']}  migrated={r['migrated']}"
              + ("  [vacuumed]" if r.get("vacuumed") else "")
              + (f"  ⚠ vacuum 失败：{r['vacuumError']}" if r.get("vacuumError") else ""))
        print("  下一步：重启服务（旧 schema 的库服务会拒绝启动并提示本脚本）。")

    st = istore.IndexStore(args.db)
    try:
        dup = st.lineage_duplicates()
        if args.json:
            print(json.dumps(dup, ensure_ascii=False, indent=2))
        print_plan(dup["groups"], args)
        if args.apply:
            for g in dup["groups"]:
                others = [x["id"] for x in g["lineages"] if x["id"] != g["suggestId"]]
                if not others:
                    continue
                if args.only and args.only.lower() not in (g["repoName"] or "").lower():
                    print(f"跳过（--only 过滤）：{g['repoName']}")
                    continue
                print(f"→ 合并 {g['repoName']}: {others} -> {g['suggestId']}")
                result = st.lineage_merge(others, g["suggestId"])
                print(f"  完成：droppedChunks={result['droppedChunks']}"
                      f" droppedVectors={result['droppedVectors']}"
                      f" droppedBlobs={result['droppedBlobs']}"
                      f" freedBytes={result['freedBytes']}")
        if args.hard:
            result = st.lineage_hard_clean(min_age_days=args.min_age_days, force=args.force)
            print(f"物理清理：removed={result['removedCount']} {result['removed']}")
        if args.vacuum:
            # 合并释放的页先落 freelist；VACUUM 重写库文件 + checkpoint 才真正缩小。
            print("VACUUM（大库可能要几分钟）…")
            r = st.cas_migrate(vacuum=True)
            print(f"VACUUM 完成：{r.get('vacuumed', False)}" +
                  (f" 注意：{r['vacuumError']}" if r.get("vacuumError") else ""))
    finally:
        st.close()


# ---------------------------------------------------------------- 输出
def print_plan(groups, args):
    if not groups:
        print("✅ 没有发现重复血统组（同 repoName 多 lineage / 同 chunkFp）。")
        return
    total_rows = total_bytes = 0
    for i, g in enumerate(groups, 1):
        if args.only and args.only.lower() not in (g["repoName"] or "").lower():
            continue
        est = g["estimates"]
        rows = int(est["droppedChunks"]) + int(est["droppedVectors"]) + int(est["droppedBlobs"])
        total_rows += rows
        total_bytes += int(est["freedBytes"])
        fp = "同 chunkFp" if g["same_chunk_fp"] else "⚠️ chunkFp 不同（合并前请人工确认）"
        print(f"[组 {i}] repoName={g['repoName']}  {fp}  {g['suggest']}")
        for x in g["lineages"]:
            print(f"    lineage {x['id']}  chunks={x['chunks']}  repoId={x['repoId']}"
                  f"  last_seen={x['last_seen']}  ns={len(x['namespaces'])}个")
        print(f"    将删除 {rows} 行 / 释放约 {est['freedMb']} MB"
              f"（chunks {est['droppedChunks']} + vectors成员 {est['droppedVectors']}"
              f" + blobs {est['droppedBlobs']}，按 blob 平均大小估算）")
    print(f"合计：将删除 {total_rows} 行 / 释放约 {round(total_bytes / 1024 / 1024, 2)} MB")
    if not (args.apply or args.hard):
        print("（dry-run：以上只是计划。加 --apply 执行合并；加 --hard 物理清理过观察期的血统。）")


def main():
    ap = argparse.ArgumentParser(description="重复血统一键清洗（merge/duplicates 端点的配套脚本）")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--db", help="直连 SQLite 文件（服务根目录下的 index.db）")
    mode.add_argument("--url", help="服务 HTTP 地址，如 http://127.0.0.1:8080")
    ap.add_argument("--migrate-cas", action="store_true",
                    help="（仅 --db 模式）一次性 CAS 迁移：旧 vectors 负载去重搬进 vectors_v2、"
                         "清空旧 v 列、meta 记版本。部署序：停写 → 本步 → 起服务。幂等")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划（默认行为，不写库）")
    ap.add_argument("--apply", action="store_true", help="按 duplicates 建议逐组合并（写操作！）")
    ap.add_argument("--hard", action="store_true",
                    help="物理清理 merged_into 已过观察期的血统（写操作！）")
    ap.add_argument("--min-age-days", type=int, default=7,
                    help="--hard 的观察期天数（默认 7；merged_into 保留不满此数不删）")
    ap.add_argument("--force", action="store_true", help="--hard 无视观察期（只给清理脚本兜底用）")
    ap.add_argument("--vacuum", action="store_true", help="（仅 --db 模式）合并后 VACUUM 回收文件体积")
    ap.add_argument("--only", help="只处理 repoName 含该子串的组")
    ap.add_argument("--json", action="store_true", help="duplicates 结果按 JSON 原样输出")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if not args.db and not args.url:
        ap.error("--db 与 --url 必须二选一（--db 走直连，--url 走服务 HTTP）")
    if args.migrate_cas and not args.db:
        ap.error("--migrate-cas 只支持 --db 直连模式（部署时容器内跑）")
    if args.db:
        db_mode(args)
    else:
        http_mode(args)


if __name__ == "__main__":
    main()
