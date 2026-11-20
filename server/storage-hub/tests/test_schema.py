#!/usr/bin/env python3
"""v2 schema 约束自测（docs/schema-v2.md §2/§4/§5）。

这一套是**表设计本身的验收**，不碰 HTTP、不需要模型：

  · 启动校验：旧库拒绝启动（无 meta / schema_version≠2），空库按 v2 DDL 建
  · STRICT：错误类型插不进去
  · 外键 CASCADE：删 scope → chunks；删 memory → events/vectors/excerpts 关联；
    删 blob → vectors；删 lineage → scopes → chunks
  · 唯一索引：scopes.namespace / scopes ident / lineages url / memories fingerprint /
    excerpts sha256
  · FTS 触发器：insert / update / delete 后 memories_fts 与实际行一致
  · 幂等 upsert：memories_fp 命中即更新，不产生新行
  ·  Conflicts 一等公民：open 查询、单行一对、裁决留痕
  · exp_jobs / api_calls 写入与聚合
  · GC：删掉最后一个引用者后孤儿 blob/vector 被回收

跑法（服务根目录或仓库根目录都行）：python tests/test_schema.py
退出码 0 = 全绿。
"""
import hashlib
import os
import shutil
import sqlite3
import sys
import tempfile
import time

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if APP not in sys.path:
    sys.path.insert(0, APP)

import index_store as istore  # noqa: E402

TMP = tempfile.mkdtemp(prefix="ci-schema-v2-")
PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  — {detail}")


def sha(*texts):
    h = hashlib.sha256()
    for t in texts:
        h.update(str(t).encode("utf-8"))
    return h.hexdigest()


def fresh(name="index.db"):
    path = os.path.join(TMP, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def make_scope(st, repo="demo", fp="fp1", kind="main", ref="x", root=None):
    ns = istore.canonical_namespace(repo, fp, kind, ref, root=root)
    lid = st.ensure_lineage(f"https://git.example.com/team/{repo}.git", repo, repo)
    return st.ensure_scope(ns, repo, fp, lid, tag="tagA")


def add_chunks(st, scope, hashes, path="a.py", bodies=True):
    st.sync(scope["namespace"], {
        "repoId": scope["repo_id"], "chunkFp": scope["chunk_fp"], "tag": "tagA",
        "url": "https://git.example.com/team/%s.git" % scope["repo_id"],
        "mode": "full", "repoState": "s-" + str(len(hashes)), "chunkCount": len(hashes),
        "upsert": [{"path": path, "hash": "file-" + path,
                    "chunks": [{"hash": h, "start": i + 1, "end": i + 1}
                               for i, h in enumerate(hashes)]}],
        "remove": [],
    })
    if bodies:
        st.put_chunks(scope["namespace"], [{"hash": h, "body": "body-" + h} for h in hashes])


# ---------------------------------------------------------------- ① 启动校验
def test_startup_gate():
    print("\n[1] 启动校验：旧库拒绝 / 空库建 v2")
    old = fresh("old/index.db")
    conn = sqlite3.connect(old)
    conn.executescript("create table repos(namespace text primary key, lineage_id text);"
                       "create table vectors(lineage_id text, tag text, hash text);")
    conn.commit()
    conn.close()
    err = None
    try:
        istore.IndexStore(old)
    except RuntimeError as e:
        err = str(e)
    check("无 meta 表的旧库 → RuntimeError", err is not None, err)
    check("错误信息含「重置重建」", bool(err) and "重置重建" in err, err)
    check("错误信息指向 docs/schema-v2.md §5", bool(err) and "schema-v2.md" in err, err)

    half = fresh("half/index.db")
    conn = sqlite3.connect(half)
    conn.execute("create table meta (key text primary key, value text not null)")
    conn.execute("insert into meta values ('schema_version', '1')")
    conn.commit()
    conn.close()
    herr = None
    try:
        istore.IndexStore(half)
    except RuntimeError as e:
        herr = str(e)
    check("schema_version='1' → RuntimeError（半迁移库也不放行）",
          bool(herr) and "重置重建" in herr, herr)

    st = istore.IndexStore(fresh())
    check("空库建成 v2：schema_version='2'", st.meta_get("schema_version") == "2")
    check("meta.chunk_schema='v2'", st.meta_get("chunk_schema") == "v2")
    check("meta.embed_tag 键存在（可为空串）", st.meta_get("embed_tag") is not None)
    tables = {r["name"] for r in st.db.execute(
        "select name from sqlite_master where type = 'table'").fetchall()}
    expected = {"meta", "lineages", "scopes", "chunks", "blobs", "vectors", "memories",
                "memory_vectors", "excerpts", "memory_excerpts", "memory_conflicts",
                "memory_events", "exp_jobs", "api_calls"}
    check("14 张 v2 表齐备", expected <= tables, sorted(expected - tables))
    check("2 个 FTS 虚拟表（memories_fts / chunks_fts）",
          {"memories_fts", "chunks_fts"} <= tables, sorted(tables))
    idx = {r["name"] for r in st.db.execute(
        "select name from sqlite_master where type = 'index'").fetchall()}
    check("关键索引齐备（scopes_namespace / scopes_ident / memories_fp / memory_conflicts_open）",
          {"scopes_namespace", "scopes_ident", "chunks_hash", "memories_fp",
           "memories_cat", "memories_wf", "memories_lens", "memories_hit_at",
           "memory_conflicts_open", "exp_jobs_created", "api_calls_group"} <= idx,
          sorted(idx))
    check("本连接 foreign_keys=ON", int(st.db.execute("pragma foreign_keys").fetchone()[0]) == 1)
    st.close()
    st2 = istore.IndexStore(st.db_path)
    check("二次启动幂等（不报错、版本不变）", st2.meta_get("schema_version") == "2")
    st2.close()


# ---------------------------------------------------------------- ② STRICT
def test_strict():
    print("\n[2] STRICT：类型错误插不进去")
    st = istore.IndexStore(fresh("strict.db", ))
    bad = 0
    cases = [
        ("insert into meta(key, value) values ('k', 1)", ()),   # value TEXT NOT NULL，未报错也允许
        ("insert into blobs(hash, body, created_at) values (?,?,?)", ("h1", b"x", "not-an-int")),
        ("insert into chunks(scope_id, path, start_line, end_line, hash) values (?,?,?,?,?)",
         ("x", "p", 1, 2, "h")),
        ("insert into vectors(tag, hash, dim, vec, updated_at) values (?,?,?,?,?)",
         ("t", "h1", "not-int", b"", 1)),
    ]
    for sql, args in cases[1:]:
        try:
            st.db.execute(sql, args)
        except sqlite3.IntegrityError:
            bad += 1
        finally:
            st.db.rollback()
    check("INTEGER 列存字符串 → IntegrityError（3 例全部拒绝）", bad == 3, f"{bad}/3")
    st.close()


# ---------------------------------------------------------------- ③ 外键 cascade
def test_cascade():
    print("\n[3] 外键 CASCADE：删父行自动清子行")
    st = istore.IndexStore(fresh("cascade.db"))
    sc = make_scope(st, "cascade")
    add_chunks(st, sc, ["c1", "c2", "c3"])
    sid = sc["id"]
    check("3 块入 chunks", st.db.execute(
        "select count(*) from chunks where scope_id = ?", (sid,)).fetchone()[0] == 3)
    st.db.execute("delete from scopes where id = ?", (sid,))
    st.db.commit()
    check("删 scope → chunks 级联清空", st.db.execute(
        "select count(*) from chunks where scope_id = ?", (sid,)).fetchone()[0] == 0)

    sc2 = make_scope(st, "cascade2")
    add_chunks(st, sc2, ["c4"])
    st.put_vectors("tagA", [("c4", np.ones(4, dtype=np.float32))])
    check("向量写入成功（blob 已存在）", st.db.execute(
        "select count(*) from vectors where tag = 'tagA'").fetchone()[0] == 1)
    st.db.execute("delete from blobs where hash = 'c4'")
    st.db.commit()
    check("删 blob → vectors 级联清空", st.db.execute(
        "select count(*) from vectors where hash = 'c4'").fetchone()[0] == 0)

    lid = st.ensure_lineage("https://git.example.com/team/lin.git", "lin")
    sc3 = st.ensure_scope(istore.canonical_namespace("lin", "fp1", "main", "x"),
                          "lin", "fp1", lid, tag="tagA")
    add_chunks(st, sc3, ["c5", "c6"])
    st.db.execute("delete from lineages where id = ?", (lid,))
    st.db.commit()
    check("删 lineage → scopes 级联清空", st.db.execute(
        "select count(*) from scopes where lineage_id = ?", (lid,)).fetchone()[0] == 0)
    check("删 lineage → 孙级 chunks 也清空", st.db.execute(
        "select count(*) from chunks where scope_id = ?", (sc3["id"],)).fetchone()[0] == 0)

    # 经验侧 cascade
    ms = istore.MemoryStore(st.db)
    mid_row, _act = ms.upsert("demo", "logic", "级联测试", "when", "why",
                              [{"text": "证据-级联"}], "seed", "active", category="business")
    mid = mid_row["id"]
    ms.put_vector(mid, np.ones(4, dtype=np.float32), 4)
    other, _ = ms.upsert("demo", "jargon", "对手条目", "when2", "why2", [], "seed", "active",
                         category="debug")
    ms.link_conflict(mid, other["id"])
    ms.record_hit(mid)
    n = int(istore.parse_memory_id(mid))
    # 事件应有 3 条：created + conflicted（link_conflict 双向留痕）+ hit
    check("memory 有向量/证据/事件×3/冲突", (
        int(st.db.execute("select count(*) from memory_vectors where memory_id = ?", (n,)).fetchone()[0]),
        int(st.db.execute("select count(*) from memory_excerpts where memory_id = ?", (n,)).fetchone()[0]),
        int(st.db.execute("select count(*) from memory_events where memory_id = ?", (n,)).fetchone()[0]),
        int(st.db.execute("select count(*) from memory_conflicts where memory_a = ?", (n,)).fetchone()[0]),
    ) == (1, 1, 3, 1))
    st.db.execute("delete from memories where id = ?", (n,))
    st.db.commit()
    check("删 memory → memory_vectors 级联清空", st.db.execute(
        "select count(*) from memory_vectors where memory_id = ?", (n,)).fetchone()[0] == 0)
    check("删 memory → memory_events 级联清空", st.db.execute(
        "select count(*) from memory_events where memory_id = ?", (n,)).fetchone()[0] == 0)
    check("删 memory → memory_excerpts 关联级联清空", st.db.execute(
        "select count(*) from memory_excerpts where memory_id = ?", (n,)).fetchone()[0] == 0)
    check("删 memory → memory_conflicts 级联清空", st.db.execute(
        "select count(*) from memory_conflicts where memory_a = ?", (n,)).fetchone()[0] == 0)
    check("excerpts 本体保留（CAS 片段可被别的经验复用）", st.db.execute(
        "select count(*) from excerpts").fetchone()[0] == 1)

    # 外键正向校验：没有正文不许有向量
    fk_ok = False
    try:
        st.db.execute("insert into vectors(tag, hash, dim, vec, updated_at)"
                      " values ('tagA', 'no-blob', 4, x'00', 1)")
    except sqlite3.IntegrityError:
        fk_ok = True
    finally:
        st.db.rollback()
    check("vectors.hash 外键：没有 blob 的 hash 插不进向量", fk_ok)

    # 外键正向校验：未知 scope 的 chunk 插不进去
    fk2 = False
    try:
        st.db.execute("insert into chunks(scope_id, path, start_line, end_line, hash)"
                      " values (999999, 'p', 1, 1, 'h')")
    except sqlite3.IntegrityError:
        fk2 = True
    finally:
        st.db.rollback()
    check("chunks.scope_id 外键：未知作用域的块插不进去", fk2)
    ms.close()
    st.close()


# ---------------------------------------------------------------- ④ 唯一索引
def test_unique():
    print("\n[4] 唯一索引：幂等键与 CAS 去重")
    st = istore.IndexStore(fresh("unique.db"))
    sc = make_scope(st, "uniq")
    check("同 namespace 重复 ensure → 同一行（不新建）",
          st.ensure_scope(sc["namespace"], "uniq", "fp1", sc["lineage_id"])["id"] == sc["id"])
    same_url = st.ensure_lineage("https://git.example.com/team/uniq.git", "other-name")
    check("同 URL（不同兜底名）→ 同一血统 id", same_url == sc["lineage_id"], (same_url, sc["lineage_id"]))
    dup = 0
    try:
        st.db.execute("insert into scopes(lineage_id, kind, ref, chunk_fp, namespace,"
                      " created_at, updated_at) values (?,?,?,?,?,?,?)",
                      (sc["lineage_id"], "main", "default", "fp1",
                       "uniq@fp1#main:default-dup", 1, 1))
    except sqlite3.IntegrityError:
        dup = 1
    finally:
        st.db.rollback()
    check("scopes_ident 唯一：同血缘同 kind/ref/root/chunkFp 不能再建一个作用域", dup == 1)
    nsdup = 0
    try:
        st.db.execute("insert into scopes(lineage_id, kind, ref, chunk_fp, namespace,"
                      " created_at, updated_at) values (?,?,?,?,?,?,?)",
                      (sc["lineage_id"], "branch", "b1", "fp2", sc["namespace"], 1, 1))
    except sqlite3.IntegrityError:
        nsdup = 1
    finally:
        st.db.rollback()
    check("scopes_namespace 唯一：namespace 不能重复", nsdup == 1)

    ms = istore.MemoryStore(st.db)
    r1, a1 = ms.upsert("demo", "logic", "幂等条目", "when-e", "why-e", [], "seed", "active",
                       category="business", workflow="erp-bug")
    r2, a2 = ms.upsert("demo", "logic", "幂等条目", "when-e2", "why-e2", [], "llm:1", "active",
                       category="business", workflow="erp-bug")
    check("memories_fp 幂等：同 (category|workflow|lens|what) → 更新而非新建",
          a1 == "created" and a2 == "updated" and r1["id"] == r2["id"], (a1, a2, r1, r2))
    r3, a3 = ms.upsert("demo", "logic", "幂等条目", "when-e", "why-e", [], "seed", "active",
                       category="debug", workflow="erp-bug")
    check("fingerprint 含 category：换 category 就是另一条", a3 == "created" and r3["id"] != r1["id"],
          (a3, r1, r3))
    dupfp = 0
    try:
        st.db.execute("insert into memories(fingerprint, category, lens, what, when_expr, why,"
                      " status, source, created_at, updated_at)"
                      " values (?, 'business', 'logic', 'x', 'w', 'y', 'active', 'seed', 1, 1)",
                      (ists := istore.memory_fingerprint("business", "erp-bug", "logic", "幂等条目"),))
    except sqlite3.IntegrityError:
        dupfp = 1
    finally:
        st.db.rollback()
    check("memories_fp 唯一索引兜底（手工插重复 fingerprint 被拒）", dupfp == 1)

    # excerpts CAS
    id1 = ms._put_excerpt({"text": "同一段证据"}, int(time.time()))[0]
    id2 = ms._put_excerpt({"text": "同一段证据"}, int(time.time()))[0]
    check("excerpts sha256 UNIQUE：同文本只存一份", id1 == id2)
    check("excerpts 只有 1 行", st.db.execute("select count(*) from excerpts").fetchone()[0] == 1)
    dup_sha = 0
    try:
        st.db.execute("insert into excerpts(sha256, text, captured_at) values (?,?,?)",
                      (sha("same"), "a", 1))
        st.db.execute("insert into excerpts(sha256, text, captured_at) values (?,?,?)",
                      (sha("same"), "b", 1))
    except sqlite3.IntegrityError:
        dup_sha = 1
    finally:
        st.db.rollback()
    check("excerpts.sha256 唯一约束兜底", dup_sha == 1)
    ms.close()
    st.close()


# ---------------------------------------------------------------- ⑤ FTS 触发器
def test_fts_triggers():
    print("\n[5] memories_fts 触发器：与 memories 表始终一致")
    st = istore.IndexStore(fresh("fts.db"))
    ms = istore.MemoryStore(st.db)

    def hits(q):
        return [r["id"] for r in st.db.execute(
            "select m.id from memories_fts f join memories m on m.id = f.rowid"
            " where memories_fts match ?", (f'"{q}"',)).fetchall()]

    r, _ = ms.upsert("demo", "logic", "触发器新增术语", "什么时候", "因为什么", [], "seed", "active",
                     category="business")
    n = istore.parse_memory_id(r["id"])
    check("insert 后 FTS 可检索（新 id 命中）", hits("触发器新增") == [n], hits("触发器新增"))
    r2, act = ms.upsert("demo", "logic", "触发器更新术语", "什么时候", "因为什么", [], "seed",
                        "active", category="business")
    check("同 fingerprint 变化（what 变了）→ 新行", act == "created" and r2["id"] != r["id"])
    st.db.execute("update memories set what = ? where id = ?", ("触发器改名术语", n))
    st.db.commit()
    check("update 后旧词不再命中", hits("触发器新增") == [], hits("触发器新增"))
    check("update 后新词命中", hits("触发器改名术语") == [n], hits("触发器改名术语"))
    st.db.execute("delete from memories where id = ?", (n,))
    st.db.commit()
    check("delete 后 FTS 不再命中（触发器 delete 生效）", hits("触发器改名术语") == [],
          hits("触发器改名术语"))
    check("外部内容表口径：FTS 行数 = memories 行数（不多不少）",
          int(st.db.execute("select count(*) from memories_fts").fetchone()[0])
          == int(st.db.execute("select count(*) from memories").fetchone()[0]))
    ms.close()
    st.close()


# ---------------------------------------------------------------- ⑥ conflicts
def test_conflicts():
    print("\n[6] memory_conflicts：一等公民 + open 查询 + 裁决留痕")
    st = istore.IndexStore(fresh("conflicts.db"))
    ms = istore.MemoryStore(st.db)
    a, _ = ms.upsert("demo", "logic", "必须重启", "发版后", "配置缓存", [], "seed", "active",
                     category="business")
    b, _ = ms.upsert("demo", "logic", "无需重启", "发版后", "配置热加载", [], "llm:2", "active",
                     category="business")
    ok, against = ms.link_conflict(a["id"], b["id"], ["必须", "无需"])
    check("link_conflict 返回对手摘要", ok and against["id"] == b["id"], against)
    rows = st.db.execute("select count(*) from memory_conflicts").fetchone()[0]
    check("一对冲突只存一行（UNIQUE(memory_a,memory_b)）", rows == 1, rows)
    ms.link_conflict(b["id"], a["id"], ["必须", "无需"])
    check("反向重复登记不产生第二行",
          st.db.execute("select count(*) from memory_conflicts").fetchone()[0] == 1)
    openq = st.db.execute(
        "select id from memory_conflicts where status = 'open' order by created_at desc").fetchall()
    check("open 查询命中（收件箱「待裁决 N」的数据源）", len(openq) == 1, openq)
    check("memories.status 仍是 active（冲突不再是状态列）",
          {r["status"] for r in st.db.execute("select status from memories").fetchall()} == {"active"})
    items = ms.conflicts()["items"]
    check("conflicts() 顶层给 memory_a 侧、against 给 memory_b 侧",
          items and items[0]["id"] == a["id"] and items[0]["against"]["id"] == b["id"], items)
    check("conflicts() 带 trigger_words", items and items[0]["trigger_words"] == ["必须", "无需"])
    res = ms.resolve_conflict(openq[0]["id"], "keep_a", "以实测为准", "tester")
    check("resolve_conflict 写入 resolution/resolved_by",
          res["status"] == "keep_a" and tuple(st.db.execute(
              "select resolution, resolved_by from memory_conflicts where id = ?",
              (openq[0]["id"],)).fetchone()) == ("以实测为准", "tester"))
    check("裁决后不再是 open", ms.conflicts()["total"] == 0)
    check("裁决事件进 memory_events（resolved ×2）",
          st.db.execute("select count(*) from memory_events where event = 'resolved'").fetchone()[0] == 2)
    ms.close()
    st.close()


# ---------------------------------------------------------------- ⑦ 任务与统计
def test_jobs():
    print("\n[7] exp_jobs / api_calls")
    st = istore.IndexStore(fresh("jobs.db"))
    js = istore.JobsStore(st.db)
    job = js.record({"session_id": "sess-1", "segment_no": 1, "workflow": "erp-bug",
                     "mode": "server", "status": "running", "model": "deepseek-v4",
                     "prompt_version": "p3", "candidates": 4, "reasons": {"garbage": 1}})
    check("exp_jobs 写入（queued/running 语义 + reasons json）",
          job["id"] == 1 and job["reasons"] == {"garbage": 1} and job["status"] == "running", job)
    again = js.record({"session_id": "sess-1", "segment_no": 1, "mode": "server",
                       "status": "done", "candidates": 6, "created_n": 2, "updated_n": 1})
    check("(session_id, segment_no) 幂等：重复上报覆盖同一行",
          again["id"] == job["id"] and again["candidates"] == 6 and again["status"] == "done", again)
    check("finished_at 在终态自动落时间", isinstance(again["finished_at"], int), again["finished_at"])
    js.record({"session_id": "sess-1", "segment_no": 2, "mode": "client", "status": "skipped"})
    check("第 2 段独立成行", js.list_jobs()["total"] == 2)
    stats = js.job_stats()
    check("job_stats 漏斗（byStatus/totals）",
          stats["byStatus"]["done"] == 1 and stats["byStatus"]["skipped"] == 1
          and stats["totals"]["candidates"] == 6, stats)
    js.api_call("search", "key-1", 12, 200)
    js.api_call("sync", "key-1", 30, 500, "boom")
    agg = js.api_stats()
    check("api_calls 按 group 聚合 + 错误计数",
          agg["total"] == 2 and {g["group"] for g in agg["groups"]} == {"search", "sync"}
          and sum(g["errors"] for g in agg["groups"]) == 1, agg)
    check("api_calls.group_ 白名单校验", _raises(ValueError, js.api_call, "not-a-group"))
    check("memories.exp_job_id 外键指向 exp_jobs",
          _memories_job_fk(st, js))
    js.close()
    st.close()


def _raises(exc, fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except exc:
        return True
    except Exception:  # noqa: BLE001
        return False
    return False


def _memories_job_fk(st, js):
    ms = istore.MemoryStore(st.db)
    job = js.record({"session_id": "sess-fk", "segment_no": 1, "mode": "server", "status": "done"})
    r, _ = ms.upsert("demo", "logic", "带 job 的经验", "w", "y", [], "llm:1", "active",
                     category="business", exp_job_id=job["id"])
    n = istore.parse_memory_id(r["id"])
    ok = st.db.execute("select exp_job_id from memories where id = ?", (n,)).fetchone()[0] == job["id"]
    st.db.execute("delete from exp_jobs where id = ?", (job["id"],))
    st.db.commit()
    ok = ok and st.db.execute(
        "select exp_job_id from memories where id = ?", (n,)).fetchone()[0] is None
    ms.close()
    return ok


# ---------------------------------------------------------------- ⑧ GC
def test_gc():
    print("\n[8] GC：删掉最后一个引用者后回收孤儿内容（§4）")
    st = istore.IndexStore(fresh("gc.db"))
    a = make_scope(st, "gc-a")
    b = make_scope(st, "gc-b")
    add_chunks(st, a, ["shared", "only-a"])
    add_chunks(st, b, ["shared"])
    st.put_vectors("tagA", [(h, np.ones(4, dtype=np.float32)) for h in ("shared", "only-a")])
    check("两块作用域共享 shared + a 独有 only-a",
          int(st.db.execute("select count(*) from blobs").fetchone()[0]) == 2)
    st.delete_scope(a["namespace"])
    g1 = st.gc()
    check("删 a 后 only-a 成为孤儿 → 回收 1 个 blob / 1 个向量",
          g1["blobs"] == 1 and g1["vectors"] == 1, g1)
    check("仍被 b 引用的 shared 保留",
          st.db.execute("select 1 from blobs where hash = 'shared'").fetchone() is not None
          and st.db.execute("select 1 from vectors where hash = 'shared'").fetchone() is not None)
    st.delete_scope(b["namespace"])
    g2 = st.gc()
    check("删 b 后全部回收", g2["blobs"] == 1 and g2["vectors"] == 1, g2)
    check("回收后 blobs/vectors 全空",
          int(st.db.execute("select count(*) from blobs").fetchone()[0]) == 0
          and int(st.db.execute("select count(*) from vectors").fetchone()[0]) == 0)
    check("再跑一次 gc 是幂等的（无孤儿可删）", st.gc() == {"blobs": 0, "vectors": 0})
    st.close()


# ---------------------------------------------------------------- ⑨ 枚举/ID 格式
def test_enums_ids():
    print("\n[9] 枚举与对外 id")
    check("memories.status 只有 active/retired", istore.MEMORY_STATUSES == ("active", "retired"))
    check("format_memory_id(1) == exp-000001", istore.format_memory_id(1) == "exp-000001")
    check("format_memory_id(1234567) 自然加宽", istore.format_memory_id(1234567) == "exp-1234567")
    check("parse_memory_id 双向可逆",
          istore.parse_memory_id("exp-000123") == 123
          and istore.parse_memory_id(123) == 123
          and istore.format_memory_id(ists := istore.parse_memory_id("exp-000123")) == "exp-000123")
    check("parse_memory_id 拒绝非法 id", _raises(ValueError, istore.parse_memory_id, "exp-xyz")
          and _raises(ValueError, istore.parse_memory_id, "")
          and _raises(ValueError, istore.parse_memory_id, 0))
    check("中文 label 常量齐全（lens 3 / category 5）",
          istore.LENS_LABELS == {"jargon": "黑话镜头", "index": "索引镜头", "logic": "逻辑镜头"}
          and istore.CATEGORY_LABELS["business"] == "业务知识"
          and istore.CATEGORY_LABELS["process"] == "交付流程")
    st = istore.IndexStore(fresh("enums.db"))
    ms = istore.MemoryStore(st.db)
    check("写入层拒绝 status='conflicting'",
          _raises(ValueError, ms.upsert, "demo", "logic", "x", "w", "y", [], "seed", "conflicting"))
    check("写入层拒绝未知 lens",
          _raises(ValueError, ms.upsert, "demo", "unknown", "x", "w", "y", [], "seed", "active"))
    check("写入层拒绝 category=process（process 不入库）",
          _raises(ValueError, ms.upsert, "demo", "logic", "x", "w", "y", [], "seed", "active",
                  "process"))
    check("memory_fingerprint 稳定（同输入同输出）",
          istore.memory_fingerprint("a", "b", "c", "d") == istore.memory_fingerprint("a", "b", "c", "d")
          and istore.memory_fingerprint("a", None, "c", "d") != istore.memory_fingerprint("a", "b", "c", "d"))
    ms.close()
    st.close()


def main():
    t0 = time.time()
    try:
        test_startup_gate()
        test_strict()
        test_cascade()
        test_unique()
        test_fts_triggers()
        test_conflicts()
        test_jobs()
        test_gc()
        test_enums_ids()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    print(f"\n通过 {PASS}，失败 {FAIL}（{round(time.time() - t0, 2)}s）")
    if PASS < 25:
        print("❌ schema 自测项数不足 25（验收要求 ≥25）")
        return 1
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
