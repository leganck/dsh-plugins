#!/usr/bin/env python3
"""作用域与血统（scopes / lineages）自测 —— v2 schema 基线。

替代 v1 的 tests/test_lineages.py：v2 把"血统"（跨克隆同一性）与"作用域"（一次快照）
拆成两张表，去掉了 `repos` 混装表与 `merged_into` 墓碑，向量/正文改成全局内容寻址。

覆盖：
  ① namespace 协议（canonical / parse / root / legacy 拒绝）
  ② 血统身份（URL 归一化、root_hint 兜底、repo_name 跟随）
  ③ 作用域生命周期（register / ident 唯一 / delete / bulk-delete / 分页 facets）
  ④ 块与向量（sync 幂等、revision、pending、matrix、可达性统计）
  ⑤ tag 治理（set_all_tags / tag_stats / purge）
  ⑥ simhash 候选与 adopt（v2：内容全局共享，"复制"退化为"核对可复用"）
  ⑦ 血统治理（resolve / merge 无墓碑 / duplicates / 空血统清理 / GC）

跑法：python tests/test_scopes.py；退出码 0 = 全绿。
"""
import os
import shutil
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

TMP = tempfile.mkdtemp(prefix="ci-scopes-v2-")
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


def raises(exc, fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except exc:
        return True
    except Exception:  # noqa: BLE001
        return False
    return False


def new_store(name):
    path = os.path.join(TMP, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return istore.IndexStore(path)


def scope_of(st, repo="demo", fp="fp1", kind="main", ref="x", root=None, tag="tagA",
             url=None, name=None):
    ns = istore.canonical_namespace(repo, fp, kind, ref, root=root)
    lid = st.ensure_lineage(url or f"https://git.example.com/team/{repo}.git", repo, name or repo)
    return st.ensure_scope(ns, repo, fp, lid, tag=tag, repo_name=name or repo, root_rel=root)


def sync_manifest(st, scope, hashes, path="a.py", state="s1", tag="tagA", bodies=True,
                  url=None):
    out = st.sync(scope["namespace"], {
        "repoId": scope["repo_id"], "chunkFp": scope["chunk_fp"], "tag": tag,
        "url": url or ("https://git.example.com/team/%s.git" % scope["repo_id"]),
        "mode": "full", "repoState": state, "chunkCount": len(hashes),
        "upsert": [{"path": path, "hash": "file-" + path,
                    "chunks": [{"hash": h, "start": i + 1, "end": i + 2}
                               for i, h in enumerate(hashes)]}],
        "remove": [],
    })
    if bodies:
        st.put_chunks(scope["namespace"], [{"hash": h, "body": "body-" + h} for h in hashes])
    return out


# ---------------------------------------------------------------- ① namespace 协议
def test_namespace():
    print("\n[1] namespace 协议（对外字符串格式不变）")
    check("canonical main", istore.canonical_namespace("r1", "fp1", "main", "whatever") == "r1@fp1#main:default")
    branch = istore.canonical_namespace("r1", "fp1", "branch", "feat/x y")
    check("canonical branch 带 sha1 后缀（去非法字符）",
          branch.startswith("r1@fp1#branch:feat-x-y-") and len(branch.rsplit("-", 1)[1]) == 6, branch)
    check("canonical pr 去掉前导零", istore.canonical_namespace("r1", "fp1", "pr", "007") == "r1@fp1#pr:7")
    wt = istore.canonical_namespace("r1", "fp1", "worktree", "/abs/path")
    check("canonical worktree 是 8 位 sha1", wt.startswith("r1@fp1#wt:") and len(wt.rsplit(":", 1)[1]) == 8, wt)
    withroot = istore.canonical_namespace("r1", "fp1", "main", "x", root="pkg/sub")
    check("子目录根 → ~root:<sha8> 后缀", withroot.startswith("r1@fp1#main:default~root:") and len(withroot.rsplit(":", 1)[1]) == 8, withroot)
    check("仓库根不写 ~root", "~root:" not in istore.canonical_namespace("r1", "fp1", "main", "x", root=""))
    check("repoId 非法字符 → ScopeFormatError",
          raises(istore.ScopeFormatError, istore.canonical_namespace, "bad/id", "fp1", "main", "x"))
    check("kind 未知 → ScopeFormatError",
          raises(istore.ScopeFormatError, istore.canonical_namespace, "r1", "fp1", "nope", "x"))
    check("branch 空 ref → ScopeFormatError('empty-ref')",
          raises(istore.ScopeFormatError, istore.ref_token, "branch", ""))
    check("pr 非数字 ref → ScopeFormatError('pr-ref-not-numeric')",
          raises(istore.ScopeFormatError, istore.ref_token, "pr", "abc"))

    parsed = istore.parse_scope_namespace(branch)
    check("parse: branch → kind/token/scope_ref 齐全",
          parsed["kind"] == "branch" and parsed["token"] == branch.rsplit(":", 1)[1]
          and parsed["scope_ref"] == parsed["token"], parsed)
    check("parse: worktree → scope_ref 带 wt: 前缀",
          istore.parse_scope_namespace(wt)["scope_ref"].startswith("wt:"))
    check("parse: 子目录 root 反推出 sha8",
          istore.parse_scope_namespace(withroot)["root"] == withroot.rsplit(":", 1)[1])
    check("parse: 旧格式（无 #）→ kind=None（调用方必须拒绝）",
          istore.parse_scope_namespace("old@fp")["kind"] is None)
    check("legacy_namespace() 一律拒绝",
          raises(istore.ScopeFormatError, istore.legacy_namespace, "old@fp"))
    check("namespace_identity 拆出 repoId/chunkFp",
          istore.namespace_identity(withroot) == ("r1", "fp1"))

    check("normalize_root: 空/./ → ''",
          istore.normalize_root("") == "" and istore.normalize_root(".") == ""
          and istore.normalize_root(None) == "")
    check("normalize_root: 反斜杠 / 尾斜杠 / 重复斜杠归一",
          istore.normalize_root("a\\b//c/") == "a/b/c")
    check("normalize_root: 绝对路径拒绝",
          raises(istore.ScopeFormatError, istore.normalize_root, "/abs"))
    check("normalize_root: '..' 拒绝",
          raises(istore.ScopeFormatError, istore.normalize_root, "a/../b"))
    check("normalize_root: Windows 盘符拒绝",
          raises(istore.ScopeFormatError, istore.normalize_root, "C:/repo"))
    check("root_token: 仓库根 None，子目录 8 位 sha1",
          istore.root_token("") is None and len(istore.root_token("pkg")) == 8)
    check("scope_safe 压缩连续非法字符",
          istore.scope_safe("a b//c") == "a-b-c" and istore.scope_safe("///") == "x")


# ---------------------------------------------------------------- ② 血统身份
def test_lineages():
    print("\n[2] 血统身份（跨克隆同一性）")
    st = new_store("lin/index.db")
    a = st.ensure_lineage("https://Git.Example.com/Team/Repo.git", "seed1", "repo")
    b = st.ensure_lineage("git@git.example.com:Team/Repo.git", "seed2")
    # 路径大小写是 git 服务端语义的一部分（host 才小写归一），所以这里保持同一大小写
    c = st.ensure_lineage("ssh://git@git.example.com/Team/Repo", "seed3")
    check("三种 URL 写法归一后是同一血统", a == b == c, (a, b, c))
    d = st.ensure_lineage("", "local-seed")
    e = st.ensure_lineage("", "local-seed")
    check("无 remote 时按 root_hint 兜底同一性", d == e and d != a, (d, e, a))
    row = st.lineage(a)
    check("lineage 行带 repo_name / url_norm / last_seen",
          row["repo_name"] == "repo" and row["url_norm"] == "git.example.com/Team/Repo"
          and isinstance(row["last_seen"], int), row)
    st.ensure_lineage("https://git.example.com/Team/Repo.git", "seed1", "renamed-repo")
    check("后带的 repo_name 会更新（可读名跟随）", st.lineage(a)["repo_name"] == "renamed-repo")
    first_seen = st.lineage(a)["last_seen"]
    time.sleep(0.01)
    st.ensure_lineage("https://git.example.com/Team/Repo.git", "seed1")
    check("last_seen 每次出现都刷新", st.lineage(a)["last_seen"] >= first_seen)
    check("lineage 未知 id → None", st.lineage(999999) is None)
    st.close()


# ---------------------------------------------------------------- ③ 作用域
def test_scopes():
    print("\n[3] 作用域生命周期")
    st = new_store("scope/index.db")
    sc = scope_of(st, "alpha")
    check("ensure_scope 建行并回填派生字段",
          sc["namespace"] == "alpha@fp1#main:default" and sc["repo_id"] == "alpha"
          and sc["kind"] == "main" and sc["ref"] == "default" and sc["tag"] == "tagA", sc)
    check("ensure_scope 幂等（同 id）", st.ensure_scope(sc["namespace"], "alpha", "fp1", sc["lineage_id"])["id"] == sc["id"])
    check("scope(ns) 合并血统信息（repo_name / lineageUrl）",
          sc["repo_name"] == "alpha" and sc["lineageUrl"].startswith("git.example.com/"), sc)
    check("scope(未知 ns) → None", st.scope("nope@fp#main:default") is None)
    check("同一血统同 kind/ref/root/chunkFp 再造第二个 repoId → SyncDiverged",
          raises(istore.SyncDiverged, st.ensure_scope, "alpha2@fp1#main:default", "alpha2", "fp1",
                 sc["lineage_id"]))

    br = scope_of(st, "alpha", fp2 := "fp2", "branch", "feat/x")
    check("同血统不同 chunkFp → 新作用域", br["id"] != sc["id"] and br["kind"] == "branch")
    sub = scope_of(st, "alpha", "fp1", "main", "x", root="pkg/sub")
    check("同 (kind,ref,chunkFp) 不同 root → 并存", sub["id"] not in (sc["id"], br["id"]) and "~root:" in sub["namespace"])

    reg = st.register_scope(sc["namespace"], "pr", "42", commit_sha="deadbeef", scope_ref="42")
    check("register_scope 更新 kind/ref/commit",
          reg["kind"] == "pr" and reg["ref"] == "42" and reg["commit_sha"] == "deadbeef", reg)
    reg2 = st.register_scope(sub["namespace"], "main", "x", root_rel="pkg\\sub")
    check("register_scope 归一化并写入 root_rel（反斜杠 → /）", reg2["root_rel"] == "pkg/sub", reg2["root_rel"])
    check("把仓库根作用域改挂到已有子目录根 → ScopeFormatError('scope-conflict')",
          raises(istore.ScopeFormatError, st.register_scope, sc["namespace"], "main", "x",
                 root_rel="pkg/sub"))
    check("register_scope 未知 kind → ScopeFormatError",
          raises(istore.ScopeFormatError, st.register_scope, sc["namespace"], "nope", "x"))
    check("count_scopes 统计全部作用域", st.count_scopes() == 3, st.count_scopes())

    stats = st.scope_stats()
    check("scope_stats 有 total/byKind/chunks/vectors/coverage/字节数",
          {"total", "byKind", "chunks", "vectors", "coverage", "totalBytes", "bodyBytes",
           "vectorBytes"} <= set(stats) and stats["total"] == 3, stats)
    check("scope_stats byKind 覆盖 main/branch/pr/worktree 四档",
          set(stats["byKind"]) == set(istore.SCOPE_KINDS), stats["byKind"])

    page = st.scope_page(limit=2, sort="kind", order="asc")
    check("scope_page 分页字段 + facets",
          page["total"] == 3 and len(page["scopes"]) == 2 and page["hasMore"] is True
          and "repos" in page["facets"] and "kinds" in page["facets"], page["total"])
    check("scope_page limit 上限 200（不报错）", st.scope_page(limit=999)["limit"] == 200)
    check("scope_page 按 repoId 过滤",
          st.scope_page(repo_id="alpha")["total"] == 3 and st.scope_page(repo_id="nope")["total"] == 0)
    check("scope_page 按 kind 过滤", st.scope_page(kind="branch")["total"] == 1)
    check("scope_page q 子串过滤（namespace/repo_name）",
          st.scope_page(q="alpha")["total"] == 3 and st.scope_page(q="zzz")["total"] == 0)
    check("scope_page 每项带 chunks/files/vectors/coverage/variantCount",
          {"chunks", "files", "vectors", "coverage", "variantCount"} <= set(page["scopes"][0]), page["scopes"][0])

    ov = st.scope_overview(limit=10)
    check("scope_overview 每项带 scope{kind/ref/root/commit/createdAt}",
          all({"kind", "ref", "root", "commit", "createdAt"} <= set(x["scope"]) for x in ov))

    deleted = st.delete_scope(sc["namespace"])
    check("delete_scope 返回 deleted/chunks/lineage",
          deleted["deleted"] is True and deleted["lineage"] == sc["lineage_id"], deleted)
    check("delete_scope 幂等（再删 → deleted=False）", st.delete_scope(sc["namespace"])["deleted"] is False)
    bulk = st.bulk_delete_scopes([br["namespace"], "ghost@fp#main:default"])
    check("bulk_delete_scopes 成功/失败分开返回",
          bulk["deleted"] == [br["namespace"]] and bulk["failed"][0]["error"] == "not-found", bulk)
    check("bulk 后 lineage id 去重列出", bulk["lineages"] == [br["lineage_id"]], bulk)
    st.close()


# ---------------------------------------------------------------- ④ 块与向量
def test_chunks_vectors():
    print("\n[4] 块与向量（sync / pending / matrix / 可达性）")
    st = new_store("chunks/index.db")
    sc = scope_of(st, "beta")
    r = sync_manifest(st, sc, ["h1", "h2", "h3"], state="b1")
    check("首次 sync：revision=1 / chunks=3 / missing 3",
          r["revision"] == 1 and r["chunks"] == 3 and sorted(r["missing"]) == ["h1", "h2", "h3"], r)
    r2 = st.sync(sc["namespace"], {"repoState": "b1", "mode": "diff", "revision": 1,
                                   "chunkFp": "fp1", "chunkCount": 3, "upsert": [], "remove": []})
    check("指纹 + 块数一致 → unchanged 短路", r2["unchanged"] is True and r2["revision"] == 1, r2)
    check("revision 不一致 → RevisionConflict",
          raises(istore.RevisionConflict, st.sync, sc["namespace"],
                 {"repoState": "b2", "mode": "diff", "revision": 99, "chunkFp": "fp1"}))
    check("chunkFp 不一致 → SyncDiverged",
          raises(istore.SyncDiverged, st.sync, sc["namespace"],
                 {"repoState": "b3", "mode": "full", "chunkFp": "other-fp"}))
    check("同一 path 同时 upsert 与 remove → SyncDiverged",
          raises(istore.SyncDiverged, st.sync, sc["namespace"], {
              "repoState": "b4", "mode": "full", "chunkFp": "fp1",
              "upsert": [{"path": "x.py", "chunks": []}], "remove": ["x.py"]}))

    up = st.put_chunks(sc["namespace"], [{"hash": "h1", "body": "dup"}])
    check("put_chunks 已存在的 hash → deduped", up["deduped"] == 1 and up["accepted"] == 0, up)
    check("put_chunks 未知 namespace → SyncDiverged",
          raises(istore.SyncDiverged, st.put_chunks, "ghost@fp#main:default", []))

    pend = st.pending(sc["namespace"], "tagA", 10)
    check("pending 返回待嵌块（带正文）", len(pend) == 3 and pend[0]["body"].startswith("body-"), pend)
    check("pending order='path' 按 path/start 排序",
          [p["hash"] for p in st.pending(sc["namespace"], "tagA", 10, "path")] == ["h1", "h2", "h3"])
    check("pending_count = 3", st.pending_count(sc["namespace"], "tagA") == 3)

    wrote = st.put_vectors("tagA", [(h, np.ones(4, dtype=np.float32) * i)
                                    for i, h in enumerate(["h1", "h2", "h3"])])
    check("put_vectors 写入 3 行", wrote["written"] == 3 and st.counts(sc["namespace"])["vectors"] == 3, wrote)
    check("put_vectors 没有正文的 hash 被跳过（外键兜底）",
          st.put_vectors("tagA", [("no-blob-hash", np.ones(4, dtype=np.float32))])["written"] == 0)
    check("put_vectors 需要 tag", raises(ValueError, st.put_vectors, "", [("h1", np.ones(4, dtype=np.float32))]))
    check("coverage = 1.0", st.counts(sc["namespace"])["coverage"] == 1.0)
    check("pending_count 归零", st.pending_count(sc["namespace"], "tagA") == 0)

    hashes, mat, meta = st.matrix(sc["namespace"], "tagA")
    check("matrix 形状 N×dim 与 meta 对齐",
          mat.shape == (3, 4) and len(hashes) == 3 and meta["h1"] == ("a.py", 1, 2), (mat.shape, meta))
    check("matrix 未知 tag → 空矩阵", st.matrix(sc["namespace"], "nope")[1].shape[0] == 0)
    check("bodies 全局直读（str 进 str 出）", st.bodies(["h1"])["h1"] == "body-h1")
    check("bodies 未知 hash 缺席", st.bodies(["zzz"]) == {})
    check("vector_count(lineage, tag) 按可达性统计", st.vector_count(sc["lineage_id"], "tagA") == 3)
    check("hashes_in_lineage 列出全部 hash（去重）", sorted(st.hashes_in_lineage(sc["lineage_id"])) == ["h1", "h2", "h3"])
    lb = st.lineage_bytes(sc["lineage_id"])
    check("lineage_bytes 正文字节 > 0 且向量字节 > 0",
          lb["bodyBytes"] > 0 and lb["vectorBytes"] > 0 and lb["totalBytes"] == lb["bodyBytes"] + lb["vectorBytes"], lb)
    check("total_bytes = 全库正文 + 向量", st.total_bytes() == lb["totalBytes"], (st.total_bytes(), lb))

    st.sync(sc["namespace"], {"repoState": "b9", "mode": "full", "chunkFp": "fp1",
                              "chunkCount": 1,
                              "upsert": [{"path": "b.py", "hash": "file-b.py",
                                          "chunks": [{"hash": "h9", "start": 1, "end": 1}]}],
                              "remove": ["a.py"]})
    check("remove 整个文件后块数下降",
          st.counts(sc["namespace"])["chunks"] == 1, st.counts(sc["namespace"]))
    st.close()


# ---------------------------------------------------------------- ⑤ tag 治理
def test_tags():
    print("\n[5] tag 治理（换模型）")
    st = new_store("tags/index.db")
    a = scope_of(st, "taga")
    b = scope_of(st, "tagb")
    sync_manifest(st, a, ["t1"], state="t1")
    st.put_vectors("tagA", [("t1", np.ones(4, dtype=np.float32))])
    check("tag_stats 列出 tagA 的条数与字节", st.tag_stats()[0]["tag"] == "tagA"
          and st.tag_stats()[0]["vectors"] == 1, st.tag_stats())
    st.set_all_tags("tagB")
    check("set_all_tags 只改已定过 tag 的作用域（覆盖全部 2 个）",
          {s["tag"] for s in st.scope_overview(limit=10)} == {"tagB"}, st.scope_overview(limit=10))
    sc_untagged = st.ensure_scope(istore.canonical_namespace("tagc", "fp1", "main", "x"),
                                  "tagc", "fp1", st.ensure_lineage("", "tagc"), tag=None)
    st.set_all_tags("tagC")
    check("set_all_tags 不动 tag 为 NULL 的作用域（新库待嵌语义）",
          st.scope(sc_untagged["namespace"])["tag"] is None, st.scope(sc_untagged["namespace"]))
    check("set_all_tags 需要非空 tag", raises(ValueError, st.set_all_tags, ""))
    st.set_tag(a["namespace"], "tagZ")
    check("set_tag 单作用域改 tag", st.scope(a["namespace"])["tag"] == "tagZ")
    purged = st.purge_tag_vectors(drop_tag="tagA")
    check("purge_tag_vectors(drop_tag) 删掉旧 tag", purged["deleted"] == 1 and st.tag_stats() == [], purged)
    check("purge 需要 drop_tag 或 keep_tag 之一", raises(ValueError, st.purge_tag_vectors))
    st.put_vectors("tagB", [("t1", np.ones(4, dtype=np.float32))])
    st.put_vectors("tagOld", [("t1", np.ones(4, dtype=np.float32) * 2)])
    kept = st.purge_tag_vectors(keep_tag="tagB")
    check("purge_tag_vectors(keep_tag) 只留指定 tag",
          kept["deleted"] == 1 and {x["tag"] for x in st.tag_stats()} == {"tagB"}, kept)
    st.close()


# ---------------------------------------------------------------- ⑥ simhash / adopt
def test_simhash_adopt():
    print("\n[6] simhash 候选与 adopt（v2：内容全局共享）")
    st = new_store("sim/index.db")
    cand = scope_of(st, "cand", url="https://git.example.com/team/cand.git")
    sync_manifest(st, cand, ["s1", "s2", "s3"], state="c1")
    st.put_vectors("tagA", [(h, np.ones(4, dtype=np.float32)) for h in ("s1", "s2", "s3")])
    sim = {"v": 1, "path": "0F1E2D3C4B5A6978", "content": "89ABCDEF01234567", "files": 3}
    check("set_simhash 落库（小写 16 位）", st.set_simhash(cand["namespace"], sim)["path"] == "0f1e2d3c4b5a6978")
    check("set_simhash 非法值 → ValueError", raises(ValueError, st.set_simhash, cand["namespace"], {"path": "zz"}))
    check("set_simhash 未知 namespace → None", st.set_simhash("ghost@fp#main:default", sim) is None)

    cands = st.similar_lineages("0f1e2d3c4b5a6978", "89abcdef01234567", None, "tagA")
    check("相同 simhash → similarity 1.0", cands and cands[0]["similarity"] == 1.0, cands)
    check("候选带 lineage/namespace/repoName/updatedAt",
          {"lineage", "namespace", "repoName", "repoId", "updatedAt"} <= set(cands[0]), cands[0])
    check("exclude_lineage 生效",
          st.similar_lineages("0f1e2d3c4b5a6978", "89abcdef01234567", cand["lineage_id"], "tagA") == [])
    check("无关 simhash → 空候选（阈值 0.85）",
          st.similar_lineages("0" * 16, "0" * 16, None, "tagA") == [])
    check("tag 不一致 → 空候选",
          st.similar_lineages("0f1e2d3c4b5a6978", "89abcdef01234567", None, "other-tag") == [])
    check("tag 为空 → 空候选", st.similar_lineages("0f1e2d3c4b5a6978", "89abcdef01234567", None, "") == [])
    check("algo 不一致 → 空候选",
          st.similar_lineages("0f1e2d3c4b5a6978", "89abcdef01234567", None, "tagA", algo="9") == [])
    check("limit 生效",
          len(st.similar_lineages("0f1e2d3c4b5a6978", "89abcdef01234567", None, "tagA", limit=1)) == 1)

    tgt = scope_of(st, "tgt", url="https://git.example.com/team/tgt.git")
    sync_manifest(st, tgt, ["s1", "s2", "s3", "new1"], state="g1", bodies=False)
    ov = st.adopt_overlap(tgt["namespace"], cand["lineage_id"], "tagA")
    check("adopt_overlap = 已有当前 tag 向量的 distinct hash 比例（3/4）",
          ov["targetHashes"] == 4 and ov["matched"] == 3 and ov["overlap"] == 0.75, ov)
    check("adopt_overlap 未知 tag → 空", st.adopt_overlap(tgt["namespace"], cand["lineage_id"], "zz")["overlap"] == 0.0)
    reuse = st.adopt_hashes(cand["lineage_id"], tgt["lineage_id"], ["s1", "s2", "new1"], "tagA",
                            namespace=tgt["namespace"])
    check("adopt_hashes 返回可复用条数（s1/s2 有正文+向量，new1 无正文）",
          reuse["blobs"] == 2 and reuse["vectors"] == 2 and reuse["hashes"] == 2, reuse)
    check("adopt_hashes 需要 tag", raises(ValueError, st.adopt_hashes, cand["lineage_id"], tgt["lineage_id"], ["s1"], ""))
    check("adopt_hashes 截断标记（超 MAX_ADOPT_HASHES 时置 true）",
          st.adopt_hashes(cand["lineage_id"], tgt["lineage_id"], [f"x{i}" for i in range(3)], "tagA")["truncated"] is False)
    checked = st.adopt(cand["lineage_id"], tgt["lineage_id"], ["s1", "s2"])
    check("adopt() 核对可复用内容（v2 无字节复制）",
          checked == {"blobs": 2, "vectors": 2}, checked)
    st.close()


# ---------------------------------------------------------------- ⑦ 血统治理
def test_governance():
    print("\n[7] 血统治理（resolve / merge 无墓碑 / duplicates / 清理 / GC）")
    st = new_store("gov/index.db")
    l1 = st.ensure_lineage("https://git.example.com/team/dup.git", "dup", "dup")
    l2 = st.ensure_lineage("https://git.example.com/mirror/dup.git", "dup", "dup")
    check("同 repo_name 两个血统（重复身份）", l1 != l2)
    s1 = st.ensure_scope("dup@fp1#main:default", "dup", "fp1", l1, tag="tagA")
    s2 = st.ensure_scope("dup2@fp2#main:default", "dup2", "fp2", l2, tag="tagA")
    sync_manifest(st, s1, ["g1", "g2"], state="g1")
    # 第三个血统：作用域身份与 s1 完全等价（同 kind/ref/root/chunkFp）→ merge 时走"并块"分支
    l3 = st.ensure_lineage("https://git.example.com/third/dup.git", "dup", "dup")
    s3 = st.ensure_scope("dup3@fp1#main:default", "dup3", "fp1", l3, tag="tagA")
    # 用不同 path，验证"等价身份折叠"时非冲突块会并进来（同 path+start 的位置目标优先）
    sync_manifest(st, s3, ["g1", "g3"], path="b.py", state="g3",
                  url="https://git.example.com/third/dup.git")
    check("lineage_resolve 支持整数 id", st.lineage_resolve(l1) == [l1])
    check("lineage_resolve 支持数字字符串", st.lineage_resolve(str(l1)) == [l1])
    check("lineage_resolve 支持 namespace", st.lineage_resolve(s1["namespace"]) == [l1])
    check("lineage_resolve 支持 repo_name（同名三个血统全返回）",
          sorted(st.lineage_resolve("dup")) == sorted([l1, l2, l3]))
    check("lineage_resolve 未知 token → ValueError", raises(ValueError, st.lineage_resolve, "zzz-nope"))
    check("lineage_resolve 空 token → ValueError", raises(ValueError, st.lineage_resolve, ""))

    dups = st.lineage_duplicates()["groups"]
    grp = next((g for g in dups if g["repoName"] == "dup"), None)
    check("lineage_duplicates 定位重复组（同名 3 个血统归一组）",
          grp is not None and len(grp["lineages"]) == 3, dups)
    check("重复组带 suggest / same_chunk_fp / estimates",
          grp and grp["suggest"].startswith("merge into ") and isinstance(grp["same_chunk_fp"], bool)
          and {"droppedChunks", "droppedVectors", "freedBytes"} <= set(grp["estimates"]), grp)

    merged = st.lineage_merge(["dup2@fp2#main:default", "dup3@fp1#main:default"], str(l1))
    check("merge 把源作用域改挂到目标血统（不同身份直接改 lineage_id）",
          st.scope(s2["namespace"])["lineage_id"] == l1)
    check("merge 后源血统行被物理删除（v2 无 merged_into 墓碑）",
          st.lineage(l2) is None and st.lineage(l3) is None)
    check("merge 返回契约字段（into / merged / dropped*）",
          merged["into"] == l1 and len(merged["merged"]) == 2
          and {"droppedChunks", "droppedVectors", "droppedBlobs", "freedBytes"} <= set(merged), merged)
    check("等价身份的作用域被折进来（只留一份，非冲突块并入 → g1/g2/g3）",
          st.scope(s3["namespace"]) is None
          and sorted(st.hashes_in_lineage(l1)) == ["g1", "g2", "g3"], st.hashes_in_lineage(l1))
    check("折叠时同一 (path,start) 目标优先（源侧该位置的内容被丢弃并计数）",
          merged["droppedChunks"] == 0 and merged["merged"][1]["droppedScopes"] == 0, merged)
    check("merge 后目标血统有 2 个作用域（fp1 折叠后 + fp2）",
          st.db.execute("select count(*) from scopes where lineage_id = ?", (l1,)).fetchone()[0] == 2)
    check("merge 到无法解析的目标 → ValueError",
          raises(ValueError, st.lineage_merge, [], "zzz-nope"))

    empty = st.ensure_lineage("https://git.example.com/team/empty.git", "empty", "empty")
    check("空血统创建成功", st.lineage(empty) is not None)
    cleaned = st.cleanup_lineages()
    check("cleanup_lineages 删掉没有作用域的空血统",
          empty in cleaned["removed"] and st.lineage(empty) is None, cleaned)
    check("cleanup_lineages 不动有作用域的血统", st.lineage(l1) is not None)
    check("cleanup 幂等（再跑无删除）", st.cleanup_lineages()["removedCount"] == 0)
    check("min_age_days 过滤（新建空血统不会立刻被删）",
          st.cleanup_lineages(min_age_days=7)["removedCount"] == 0)

    # GC：共享内容不被误删，删掉最后一个引用者后回收
    st.delete_scope(s1["namespace"])
    g1 = st.gc(s1["lineage_id"])
    # merge 把等价作用域折进了 s1（同一行），删掉 s1 后 g1/g2/g3 全部无引用
    check("GC 回收全部无引用内容（g1/g2/g3）", g1["blobs"] == 3 and g1["vectors"] == 0, g1)
    check("GC 后 blobs 全空", st.db.execute("select count(*) from blobs").fetchone()[0] == 0)
    st.delete_scope(s2["namespace"])
    check("再 GC 无事可做", st.gc() == {"blobs": 0, "vectors": 0})
    check("overview() 等价 scope_overview（空库为空）", st.overview() == [])
    st.close()


def main():
    t0 = time.time()
    try:
        test_namespace()
        test_lineages()
        test_scopes()
        test_chunks_vectors()
        test_tags()
        test_simhash_adopt()
        test_governance()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    print(f"\n通过 {PASS}，失败 {FAIL}（{round(time.time() - t0, 2)}s）")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
