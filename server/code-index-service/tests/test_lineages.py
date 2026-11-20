#!/usr/bin/env python3
"""血统合并 / 向量 CAS 自测：`vectors_v2` 内容寻址 + lineages/merge + duplicates 检测。

不需要模型、不联网（FAKE_EMBED=1 也用不上：向量直接用 numpy 造），分四层验证：

  ① CAS 迁移（部署序：显式一次性）：旧 schema 库直开被拒（报错提示先跑
     `--migrate-cas`）；显式 `cas_migrate_db()` 迁移后 v2 按 (tag,hash) 全局唯一、
     旧表降级成员表（v 清空）、search 走 v2 正常返回；幂等（跑两次结果一致）。
  ② merge：2 个 lineage 同 chunkFp 各存同批 chunks/blobs/vectors → 合并后
     chunk 行减半、blobs/vectors 成员归并、lineages.merged_into 记录、
     返回 {merged, droppedChunks, droppedVectors, freedBytes}；重复执行幂等；
     旧 namespace 检索回退（兼容读）；旧客户端再同步不复活旧血统。
  ③ duplicates：同 repoName 多 lineage → 建议对（suggest = chunks 最大）+ 估算；
     不同 repoName 不误报；same_chunk_fp 语义。
  ④ 端点层：真实 HTTP（GET /v1/admin/lineages/duplicates、POST /v1/admin/lineages/merge、
     POST /v1/admin/lineages/hard-clean）；鉴权关闭时可直接访问；
     scripts/cleanup-lineages.py --dry-run 在本造数库上输出「将删除 N 行 / 释放 M MB」。

跑法（服务根目录或仓库根目录都行）：
    python tests/test_lineages.py

退出码 0 = 全绿。
"""
import json
import os
import shutil
import subprocess
import sqlite3
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request

# Windows 控制台默认 GBK，打不出 ✅/❌ → 强制 UTF-8（与 selftest.py 同做法）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if APP not in sys.path:
    sys.path.insert(0, APP)

import numpy as np  # noqa: E402

TMP = tempfile.mkdtemp(prefix="ci-lineages-test-")
os.environ.update(
    FAKE_EMBED="1",
    WARMUP="0",
    SERVER_DB=os.path.join(TMP, "index.db"),
    SERVER_LOG=os.path.join(TMP, "server.log"),
    SERVER_ADMIN_DB=os.path.join(TMP, "admin.db"),
)
for _k in ("API_KEY", "ADMIN_PASSWORD"):
    os.environ.pop(_k, None)  # 鉴权全空 = 开放（自测口径，与 selftest.py 一致）

import index_store as istore  # noqa: E402
import server  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"✅ {name}")
    else:
        FAIL += 1
        print(f"❌ {name}" + (f"  → {detail}" if detail else ""))


def vec(seed, dim=8):
    return np.full((dim,), seed, dtype=np.float32)


# ================================================================ ① CAS 迁移
def test_cas_migration():
    print("— ① CAS 迁移（显式一次性 + 幂等 + 全局唯一）—")
    # 手工造一个「旧格式」库：只有旧 vectors 表、带真 blob、无 v2/meta。
    legacy = os.path.join(TMP, "legacy.db")
    conn = sqlite3.connect(legacy)
    conn.executescript("""
    create table lineages (id text primary key, url_norm text, created_at integer not null, last_seen integer not null);
    create table repos (
      namespace text primary key, lineage_id text not null, repo_id text not null,
      chunk_fp text not null, revision integer not null default 0, tag text,
      repo_state text, repo_state_chunks integer, updated_at integer not null
    );
    create table chunks (namespace text not null, lineage_id text not null, path text not null,
      start integer not null, "end" integer not null, hash text not null,
      primary key (namespace, path, start));
    create table blobs (lineage_id text not null, hash text not null, body text not null,
      updated_at integer not null, primary key (lineage_id, hash));
    create table vectors (lineage_id text not null, tag text not null, hash text not null,
      dim integer not null, v blob not null, updated_at integer not null,
      primary key (lineage_id, tag, hash));
    """)
    rows = [
        ("L1", "t1", "h1", 8, vec(1).tobytes(), 10),
        ("L1", "t1", "h2", 8, vec(2).tobytes(), 11),
        ("L2", "t1", "h1", 8, vec(1).tobytes(), 12),   # 跨血统重复：同 (tag,hash)
        ("L2", "t1", "h3", 8, vec(3).tobytes(), 13),
    ]
    conn.executemany("insert into vectors values (?,?,?,?,?,?)", rows)
    # 迁移后要验证「search 走 v2 正常返回」：补上 chunks/blobs/repos 夹具
    conn.execute(
        "insert into repos values ('repo-a@fp1#main:default','L1','repo-a','fp1',1,'t1',null,null,1)")
    conn.execute(
        "insert into chunks values ('repo-a@fp1#main:default','L1','a.java',1,9,'h1')")
    conn.execute(
        "insert into chunks values ('repo-a@fp1#main:default','L1','b.java',1,9,'h2')")
    conn.execute("insert into blobs values ('L1','h1','body1',1)")
    conn.execute("insert into blobs values ('L1','h2','body2',1)")
    conn.commit()
    conn.close()

    # 新授权（2026-11-20）：不做运行时静默迁移——旧 schema 直开被拒，提示先跑迁移脚本
    try:
        istore.IndexStore(legacy)
        rejected, err = False, ""
    except RuntimeError as e:
        rejected, err = True, str(e)
    check("旧 schema 库直开被拒（报错提示先跑 --migrate-cas）",
          rejected and "migrate-cas" in err, err)

    # 部署序：停写 → 显式迁移（幂等）→ 起服务
    r1 = istore.cas_migrate_db(legacy)
    r2 = istore.cas_migrate_db(legacy)
    check("显式 cas_migrate_db：4 行（跨血统重复 1）→ v2 去重成 3 份",
          r1["migrated"] is True and r1["v2Vectors"] == 3, r1)
    check("迁移幂等：跑两次结果一致（第二次不再搬/不再清）",
          r2["migrated"] is False and r2["v2Vectors"] == 3 and r2["cleared"] == 0, (r1, r2))

    st = istore.IndexStore(legacy)  # 迁移后可正常打开
    check("迁移后旧库可正常打开（meta 记 vectors_schema=cas）",
          st.cas_status()["schema"] == "cas", st.cas_status())
    check("旧表降级成员表：v 列清空（负载唯一份在 v2）",
          st.db.execute("select sum(length(v)) from vectors").fetchone()[0] == 0,
          st.db.execute("select sum(length(v)) from vectors").fetchone()[0])
    hs, mat, meta = st.matrix("repo-a@fp1#main:default", "t1")
    check("显式迁移后 search 走 v2 正常返回（matrix 有向量负载）",
          sorted(hs) == ["h1", "h2"] and mat.shape == (2, 8)
          and float(mat[0][0]) == 1.0, (hs, mat.shape))
    r3 = st.cas_migrate()
    r4 = st.cas_migrate()
    check("方法入口同样幂等（已迁移 store 上重跑不搬不清）",
          r3 == r4 and r4["migrated"] is False and r4["v2Vectors"] == 3, (r3, r4))
    st.close()

    # 新库直开即 CAS
    fresh = istore.IndexStore(os.path.join(TMP, "fresh.db"))
    check("新库直开即 CAS（v2/meta 已建）",
          fresh.cas_status()["schema"] == "cas" and fresh.cas_status()["v2Vectors"] == 0,
          fresh.cas_status())
    fresh.close()

    # put_vectors 双写：同 (tag,hash) 跨血统 → v2 全局一份；同 hash 不同 tag → 两份
    st = istore.IndexStore(os.path.join(TMP, "cas.db"))
    st.put_vectors("LA", "t1", [("h1", vec(1)), ("h2", vec(2))])
    st.put_vectors("LB", "t1", [("h1", vec(1))])
    st.put_vectors("LB", "t2", [("h1", vec(9))])
    check("put_vectors 双写：同 (tag,hash) 跨血统 → v2 全局一份",
          st.db.execute("select count(*) from vectors_v2 where tag='t1' and hash='h1'").fetchone()[0] == 1,
          None)
    check("tag 参与唯一性：同 hash 不同 tag 是两份（(tag,hash) 复合主键）",
          st.db.execute("select count(*) from vectors_v2 where hash='h1'").fetchone()[0] == 2,
          None)
    check("旧成员表按血统记行（LA=2 / LB=2），v 列为空",
          st.db.execute("select count(*) from vectors where lineage_id='LA'").fetchone()[0] == 2
          and st.db.execute("select count(*) from vectors where lineage_id='LB'").fetchone()[0] == 2
          and st.db.execute("select sum(length(v)) from vectors").fetchone()[0] == 0,
          None)
    st.close()


# ================================================================ 夹具：重复血统
def build_dups(db_path):
    """2 个 lineage、同 repoName+chunkFp、各存同一批 chunks/blobs/vectors（完全重复）。

    另造一个独立 repo（不同名不同 fp）当对照组——duplicates 不应误报它。
    返回 (store, NS_A, NS_B, NS_OTHER, hashes)。
    """
    files = {
        "a.java": [("ha1", 1, 9), ("ha2", 10, 20)],
        "b.java": [("hb1", 1, 5)],
    }
    hashes = [h for cs in files.values() for h, _s, _e in cs]
    st = istore.IndexStore(db_path)
    # 模拟真实裂缝：A 带 git URL 派生血统；B 是读不到 origin 的老客户端，回退 repoId 派生
    # （url_norm 不同 → lineage_id 不同——正是 repoId 推导裂缝的成因）。
    LA = st.ensure_lineage("https://git.example.com/team/dup.git", "repo-a")
    LB = st.ensure_lineage("", "repo-b")
    assert LA != LB, "夹具要求两个不同血统"
    NS_A = istore.canonical_namespace("repo-a", "fp-dup", "main", "default")
    NS_B = istore.canonical_namespace("repo-b", "fp-dup", "main", "default")
    st.ensure_repo(NS_A, "repo-a", "fp-dup", LA, tag="t1", repo_name="dup-repo")
    st.ensure_repo(NS_B, "repo-b", "fp-dup", LB, tag="t1", repo_name="dup-repo")
    LO = st.ensure_lineage("https://git.example.com/team/other.git", "other-r")
    NS_O = istore.canonical_namespace("other-r", "fp-other", "main", "default")
    st.ensure_repo(NS_O, "other-r", "fp-other", LO, tag="t1", repo_name="other-repo")
    # 同批 chunks（两血统各一份：namespace 不同、path/start/hash 完全一样）
    for ns, lid in ((NS_A, LA), (NS_B, LB), (NS_O, LO)):
        for path, cs in files.items():
            for h, s, e in cs:
                st.db.execute(
                    "insert or replace into chunks(namespace, lineage_id, path, start, \"end\", hash)"
                    " values (?,?,?,?,?,?)", (ns, lid, path, s, e, h))
        for h in hashes:
            st.db.execute(
                "insert or ignore into blobs(lineage_id, hash, body, updated_at) values (?,?,?,1)",
                (lid, h, "body-of-" + h))
        st.db.execute("update repos set revision = 1 where namespace = ?", (ns,))
    st.db.commit()
    # 向量：A 先嵌；B 侧 v2 全局共享但成员表也记一份（模拟两边都跑完嵌入）
    st.put_vectors(LA, "t1", [(h, vec(i + 1)) for i, h in enumerate(hashes)])
    st.put_vectors(LB, "t1", [(h, vec(i + 1)) for i, h in enumerate(hashes)])
    st.put_vectors(LO, "t1", [(h, vec(i + 1)) for i, h in enumerate(hashes)])
    st._invalidate()
    return st, NS_A, NS_B, NS_O, hashes, LA, LB, LO


# ================================================================ ② merge
def test_merge():
    print("— ② merge（事务 + 减半 + merged_into + 兼容读）—")
    db = os.path.join(TMP, "merge.db")
    st, NS_A, NS_B, NS_O, hashes, LA, LB, LO = build_dups(db)
    chunks_before = st.db.execute(
        "select count(*) from chunks where namespace in (?, ?)", (NS_A, NS_B)).fetchone()[0]
    check("夹具：两血统各存同批 chunks（重复组共 2N）", chunks_before == 6, chunks_before)

    r = st.lineage_merge([LB], LA)
    check("merge 返回 merged/dropped*/freedBytes 字段",
          {"merged", "droppedChunks", "droppedVectors", "droppedBlobs", "freedBytes"} <= set(r), r)
    check("chunk 行减半（重复行直接删，保留目标行）",
          r["droppedChunks"] == 3
          and st.db.execute("select count(*) from chunks where namespace in (?, ?)",
                            (NS_A, NS_B)).fetchone()[0] == 3,
          (r["droppedChunks"], st.db.execute(
              "select count(*) from chunks where namespace in (?, ?)",
              (NS_A, NS_B)).fetchone()[0]))
    check("v2 全局唯一不受影响（本来就是一份）",
          r["droppedVectors"] == 3
          and st.db.execute("select count(*) from vectors_v2").fetchone()[0] == len(hashes),
          (r["droppedVectors"], st.db.execute("select count(*) from vectors_v2").fetchone()[0]))
    check("blobs 归并（源血统行删除，目标可查正文）",
          st.db.execute("select count(*) from blobs where lineage_id=?", (LB,)).fetchone()[0] == 0
          and st.bodies(LA, hashes) == {h: "body-of-" + h for h in hashes},
          None)
    check("freedBytes > 0（blobs + path 字节）", r["freedBytes"] > 0, r["freedBytes"])
    row = st.db.execute("select merged_into, merged_at from lineages where id=?", (LB,)).fetchone()
    check("merged_into 记录（墓碑/重定向标记，重复数据已当场物理清理）",
          row["merged_into"] == LA and row["merged_at"] and
          st.db.execute("select count(*) from lineages where id=?", (LB,)).fetchone()[0] == 1,
          tuple(row))
    check("repos 行改挂靠（旧 namespace 的 lineage_id = 目标）",
          st.repo(NS_B)["lineage_id"] == LA, st.repo(NS_B)["lineage_id"])

    # 兼容读：旧 namespace 检索回退（按血统）
    hs, mat, meta = st.matrix(NS_B, "t1")
    check("旧 namespace 检索回退（兼容读）：matrix 返回目标血统的块",
          sorted(hs) == sorted(hashes) and mat.shape[0] == len(hashes), (hs, mat.shape))
    # 旧客户端（无 URL、回退 repoId）再同步：ensure_lineage 沿 merged_into 回退到目标，
    # 不把旧血统复活、也不裂出新血统。
    lid_after = st.ensure_lineage("", "repo-b")
    lin_count = st.db.execute("select count(*) from lineages").fetchone()[0]
    check("旧 repoId 再 ensure_lineage：沿 merged_into 回退到目标血统，不复活",
          lid_after == LA and lin_count == 3, (lid_after, LA, lin_count))

    # 幂等：重复 merge
    r2 = st.lineage_merge([LB], LA)
    check("merge 幂等：第二次 skipped already-merged、不再删行",
          r2["droppedChunks"] == 0 and r2["merged"][0].get("skipped") == "already-merged", r2)

    # from 含 into 自身 → 自动跳过
    r3 = st.lineage_merge([LA, LB], LA)
    check("from 含 into 自身：自动跳过，不报错",
          all(m.get("skipped") == "already-merged" for m in r3["merged"]), r3)

    # 错误路径
    try:
        st.lineage_merge([LB], "no-such-lineage")
        bad = False
    except ValueError:
        bad = True
    check("into 解析不到 → ValueError（端点层转 400）", bad, None)

    # into 自身已被合并过 → 沿 merged_into 链落到最终目标（不挂在空血统上）
    LC = st.ensure_lineage("", "repo-c")
    NS_C = istore.canonical_namespace("repo-c", "fp-dup", "main", "default")
    st.ensure_repo(NS_C, "repo-c", "fp-dup", LC, tag="t1", repo_name="dup-repo")
    st.put_vectors(LC, "t1", [(h, vec(7)) for h in hashes])
    r4 = st.lineage_merge(["repo-c"], LB)  # LB 已 merged_into=LA
    check("into 已被合并过：沿链落到最终目标 LA",
          r4["into"] == LA and st.repo(NS_C)["lineage_id"] == LA, r4)

    # 观察期硬清理
    hc = st.lineage_hard_clean()
    check("hard-clean 未过观察期：不删", hc["removedCount"] == 0, hc)
    st.db.execute("update lineages set merged_at = 1 where id = ?", (LB,))
    st.db.commit()
    hc2 = st.lineage_hard_clean()
    check("hard-clean 过观察期：物理删除 merged_into 血统行",
          hc2["removedCount"] == 1 and hc2["removed"] == [LB], hc2)
    check("对照组血统不受 merge/hard-clean 影响",
          st.db.execute("select count(*) from lineages where id=?", (LO,)).fetchone()[0] == 1, None)
    return st, NS_A, NS_B, NS_O, hashes, LA, LB, LO


# ================================================================ ③ duplicates
def test_duplicates():
    print("— ③ duplicates 检测（只读聚合 + 建议对）—")
    db = os.path.join(TMP, "dups.db")
    st, NS_A, NS_B, NS_O, hashes, LA, LB, LO = build_dups(db)
    before = st.db.execute("select count(*) from chunks").fetchone()[0]
    dup = st.lineage_duplicates()
    groups = dup["groups"]
    check("同 repoName 多 lineage → 检出 1 组（对照组不误报）",
          len(groups) == 1 and groups[0]["repoName"] == "dup-repo",
          [(g["repoName"], len(g["lineages"])) for g in groups])
    g = groups[0]
    check("组内 lineages 带 id/repoId/chunks/last_seen",
          {x["id"] for x in g["lineages"]} == {LA, LB}
          and all(("repoId" in x and "chunks" in x and "last_seen" in x) for x in g["lineages"]),
          g["lineages"])
    check("suggest = chunks 最大的那个（并列取 last_seen 新者）",
          g["suggest"] == f"merge into {LA}" and g["suggestId"] == LA, g["suggest"])
    check("same_chunk_fp = true（组内共享同一 chunk 指纹）", g["same_chunk_fp"] is True, g["chunkFps"])
    check("估算字段（将删行/释放字节）按建议对给出",
          g["estimates"]["droppedChunks"] == 3 and g["estimates"]["droppedBlobs"] == 3
          and g["estimates"]["freedBytes"] > 0, g["estimates"])
    check("duplicates 只读（跑完 chunk 行数不变）",
          st.db.execute("select count(*) from chunks").fetchone()[0] == before, None)
    # 合并后组消失（merged_into 的血统不再参与建议）
    st.lineage_merge([LB], LA)
    dup2 = st.lineage_duplicates()
    check("merge 后组不再出现（merged_into 血统退出建议）",
          all(gg["repoName"] != "dup-repo" for gg in dup2["groups"]),
          [(gg["repoName"], len(gg["lineages"])) for gg in dup2["groups"]])
    st.close()


# ================================================================ ④ 端点 + 脚本
def test_http_and_script():
    print("— ④ HTTP 端点 + cleanup-lineages.py --dry-run —")
    db = os.path.join(TMP, "http.db")
    st, NS_A, NS_B, NS_O, hashes, LA, LB, LO = build_dups(db)
    # 注入 server 模块（与 test_bodies 同做法：HTTP 服务用同一个全局 store）
    server.store = st
    server.state["ready"] = True
    httpd = server.make_server(0)  # 随机端口
    port = httpd.server_address[1]
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()

    def call(method, path, payload=None):
        url = f"http://127.0.0.1:{port}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    try:
        code, dup = call("GET", "/v1/admin/lineages/duplicates")
        check("GET /v1/admin/lineages/duplicates → 200 且带建议组",
              code == 200 and len(dup.get("groups") or []) == 1
              and dup["groups"][0]["suggestId"] == LA, (code, dup))
        code, bad = call("POST", "/v1/admin/lineages/merge", {"from": [], "into": LA})
        check("POST merge 空 from → 400", code == 400, (code, bad))
        code, bad = call("POST", "/v1/admin/lineages/merge", {"from": ["LB"], "into": "nope"})
        check("POST merge 未知 into → 400 bad-lineage",
              code == 400 and bad.get("error") == "bad-lineage", (code, bad))
        code, r = call("POST", "/v1/admin/lineages/merge", {"from": [LB], "into": LA})
        check("POST /v1/admin/lineages/merge → 200 且 droppedChunks=3",
              code == 200 and r.get("droppedChunks") == 3, (code, r))
        check("merge 响应带 snake_case 别名（dropped_chunks/freed_bytes）",
              code == 200 and r.get("dropped_chunks") == r.get("droppedChunks")
              and r.get("freed_bytes") == r.get("freedBytes"), r)
        code, hc = call("POST", "/v1/admin/lineages/hard-clean", {"minAgeDays": 7})
        check("POST lineages/hard-clean 未过观察期 → removed=0",
              code == 200 and hc.get("removedCount") == 0, (code, hc))
        # 合并后重复组消失（HTTP 层的只读回查）
        code, dup2 = call("GET", "/v1/admin/lineages/duplicates")
        check("merge 后 duplicates 不再报该组（HTTP 回查）",
              code == 200 and all(gg["repoName"] != "dup-repo" for gg in dup2.get("groups") or []),
              (code, dup2.get("groups")))
    finally:
        httpd.shutdown()
        httpd.server_close()
        th.join(timeout=5)

    # cleanup-lineages.py --dry-run：在另一个造数库上验证输出「将删除 N 行 / 释放 M MB」
    dry_db = os.path.join(TMP, "script.db")
    st2, *_rest = build_dups(dry_db)
    st2.close()
    out = subprocess.run(
        [sys.executable, os.path.join(APP, "scripts", "cleanup-lineages.py"),
         "--db", dry_db, "--dry-run"],
        capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    text = (out.stdout or "") + (out.stderr or "")
    check("cleanup --dry-run 退出码 0", out.returncode == 0, text[:400])
    check("cleanup --dry-run 输出「将删除 N 行 / 释放 M MB」",
          "将删除 9 行" in text and "释放约" in text and "MB" in text, text[:600])

    # cleanup --db --apply 真合并（脚本路径的写模式）
    out2 = subprocess.run(
        [sys.executable, os.path.join(APP, "scripts", "cleanup-lineages.py"),
         "--db", dry_db, "--apply"],
        capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    text2 = (out2.stdout or "") + (out2.stderr or "")
    check("cleanup --apply 完成合并（droppedChunks=3 出现在输出）",
          out2.returncode == 0 and "droppedChunks=3" in text2, text2[:600])
    conn = sqlite3.connect(dry_db)
    left = conn.execute(
        "select count(*) from chunks where namespace like '%fp-dup%'").fetchone()[0]
    conn.close()
    check("cleanup --apply 后重复组 chunk 行减半（对照组不动）", left == 3, left)


def main():
    print(f"临时库：{TMP}")
    test_cas_migration()
    test_merge()
    test_duplicates()
    test_http_and_script()
    print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
    if FAIL:
        print("❌ 未全绿")
        return 1
    print("✅ 全绿")
    return 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    finally:
        try:
            server.store.close()
        except Exception:
            pass
        shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(code)
