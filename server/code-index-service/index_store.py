"""索引存储：血统（lineage）/命名空间（namespace）/* 内容寻址的 blob 与 vector。

## 为什么按"血统 + 内容哈希"存，而不是全局

实测（4 个无关仓库两两比对）：跨项目块重合 **0.00%** —— 全局去重对无关项目毫无收益，
只会线性累积。而同一项目的不同分支/不同克隆，仓库级复用率 **~98%**。
所以存储边界是**血统**（= 归一化后的 git remote URL），血统内按内容哈希去重：

    10 个分支的同一仓库 → 235 MB（去重后），而不是 2.35 GB（每分支一份）

跨血统只留显式口子 `adopt()`（fork / vendor 代码借用），默认不共享。

## 为什么 blob 与 vector 都用 hash 做主键的一部分

切块在客户端做（服务端不切块），客户端送上来的是 `(path, start, end, hash)` + 正文。
hash = sha256(块正文) 是内容身份：同一段代码换了路径/行号仍然是同一行存储，
因此"改文件 → 只有变化的块需要重嵌"这件事在存储层天然成立。
"""
import hashlib
import json
import os
import sqlite3
import threading
import time

import numpy as np

SCHEMA = """
create table if not exists lineages (
  id text primary key,
  url_norm text,
  created_at integer not null,
  last_seen integer not null
);
create table if not exists repos (
  namespace text primary key,
  lineage_id text not null,
  repo_id text not null,
  chunk_fp text not null,
  revision integer not null default 0,
  tag text,
  repo_state text,
  repo_state_chunks integer,
  updated_at integer not null
);
create table if not exists chunks (
  namespace text not null,
  lineage_id text not null,
  path text not null,
  start integer not null,
  "end" integer not null,
  hash text not null,
  primary key (namespace, path, start)
);
create index if not exists chunks_ns_hash on chunks(namespace, hash);
create index if not exists chunks_lin_hash on chunks(lineage_id, hash);
create table if not exists blobs (
  lineage_id text not null,
  hash text not null,
  body text not null,
  updated_at integer not null,
  primary key (lineage_id, hash)
);
create table if not exists vectors (
  lineage_id text not null,
  tag text not null,
  hash text not null,
  dim integer not null,
  v blob not null,
  updated_at integer not null,
  primary key (lineage_id, tag, hash)
);
"""


class RevisionConflict(Exception):
    """客户端拿的 revision 不是服务端当前的 → 需要改走全量清单。"""

    def __init__(self, revision, need_full=True):
        super().__init__(f"revision conflict: server={revision}")
        self.revision = revision
        self.need_full = need_full


class SyncDiverged(Exception):
    """请求里的字段自相矛盾（例如 remove 与 upsert 同一个 path）。"""


def normalize_url(url):
    """把 git remote 归一化成稳定标识：去凭证、统一协议、小写 host、去 .git 与尾斜杠。"""
    if not url:
        return ""
    s = url.strip()
    if not s:
        return ""
    s = s.split("@")[-1] if "@" in s and "://" in s else s
    if s.startswith("ssh://"):
        s = s[len("ssh://") :]
    if s.startswith("git@"):
        s = s[len("git@") :].replace(":", "/", 1)
    if "://" in s:
        s = s.split("://", 1)[1]
    if s.startswith("ssh:"):
        s = s[len("ssh:") :].lstrip("/")
    s = s.split("@")[-1]
    s = s.rstrip("/")
    if s.endswith(".git"):
        s = s[: -len(".git")]
    if "/" in s:
        host, rest = s.split("/", 1)
        s = host.lower() + "/" + rest.strip("/")
    else:
        s = s.lower()
    return s


def lineage_id_of(url_norm, fallback_seed):
    seed = url_norm or f"local:{fallback_seed}"
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


class IndexStore:
    def __init__(self, db_path):
        self.db_path = db_path
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self.lock = threading.RLock()
        # 计数/体积缓存：coverage 的 JOIN 计数在 16 万块上要 400 ms，而它在**每次查询**里都要用。
        # 只在会改变数据的操作（sync/put_chunks/put_vectors/gc/adopt）后失效。
        self._cache = {}
        self.db = sqlite3.connect(db_path, check_same_thread=False, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma journal_mode = wal")
        self.db.execute("pragma synchronous = normal")
        self.db.executescript(SCHEMA)
        # 幂等迁移：早期 0.8.0 的库里 repos 没有 repo_state_chunks 这一列
        cols = {r["name"] for r in self.db.execute("pragma table_info(repos)").fetchall()}
        if "repo_state_chunks" not in cols:
            self.db.execute("alter table repos add column repo_state_chunks integer")
        self.db.commit()

    # ---------------------------------------------------------------- 血统 / 命名空间
    def ensure_lineage(self, url_norm, fallback_seed):
        lid = lineage_id_of(url_norm, fallback_seed)
        now = int(time.time())
        with self.lock:
            row = self.db.execute("select id from lineages where id = ?", (lid,)).fetchone()
            if row:
                self.db.execute("update lineages set last_seen = ? where id = ?", (now, lid))
            else:
                self.db.execute(
                    "insert into lineages(id, url_norm, created_at, last_seen) values (?,?,?,?)",
                    (lid, url_norm or "", now, now),
                )
            self.db.commit()
        return lid

    def ensure_repo(self, namespace, repo_id, chunk_fp, lineage_id, tag=None):
        now = int(time.time())
        with self.lock:
            row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
            if not row:
                self.db.execute(
                    "insert into repos(namespace, lineage_id, repo_id, chunk_fp, revision, tag, repo_state, updated_at)"
                    " values (?,?,?,?,0,?,null,?)",
                    (namespace, lineage_id, repo_id, chunk_fp, tag, now),
                )
                self.db.commit()
        return self.repo(namespace)

    def repo(self, namespace):
        with self.lock:
            row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
        return dict(row) if row else None

    def set_tag(self, namespace, tag):
        """服务端模型换了 → 该命名空间现有向量作废（tag 变了，missing 会重新算）。"""
        with self.lock:
            self.db.execute("update repos set tag = ?, updated_at = ? where namespace = ?", (tag, int(time.time()), namespace))
            self.db.commit()
            self._invalidate()  # set_tag 改了数据 → 计数/体积缓存失效

    # ---------------------------------------------------------------- 同步
    def sync(self, namespace, payload):
        """应用一次清单差分。

        payload:
          repoId, chunkFp, url, lineage?, tag,
          repoState, revision, mode: 'diff'|'full',
          upsert: [{path, hash, chunks:[{hash,start,end}]}],
          remove: [path]

        返回 {revision, unchanged, missing, chunks, vectors, coverage}
        """
        url = normalize_url(payload.get("url") or "")
        repo_id = payload.get("repoId") or "unknown"
        chunk_fp = payload.get("chunkFp") or "default"
        tag = payload.get("tag") or None
        mode = payload.get("mode") or "diff"
        client_rev = payload.get("revision")
        repo_state = payload.get("repoState") or ""

        lineage = payload.get("lineage")
        if not lineage:
            lineage = self.ensure_lineage(url, repo_id)
        cur = self.ensure_repo(namespace, repo_id, chunk_fp, lineage, tag=tag)
        # **血统在创建时定死**：后续同步即使不带 url/repoId，也绝不重新推导 ——
        # 否则一个"最小载荷"（只发 repoState + revision）会凭空造出一个新血统，
        # 表现是"刚 adopt 过的向量又变成缺失"。这个坑由自测用例抓出来。
        lineage = cur["lineage_id"]

        # ① 状态指纹短路：指纹一致**且块数一致**才立刻回。
        # 只比指纹是不够的：指纹是客户端算的，若上一次同步是"空清单"（客户端本地早已建好索引、
        # 本轮 0 变更），服务端会把指纹记下来却一块内容都没有 —— 之后两端指纹永远相同，
        # 服务端就永远短路、永远 missing=0。实测被 ES 16 万块的预热直接踩中。
        cur_chunks = cur.get("repo_state_chunks")
        client_chunks = payload.get("chunkCount", -1)
        if (
            repo_state
            and repo_state == (cur["repo_state"] or "")
            and cur_chunks is not None
            and int(cur_chunks) == int(client_chunks)
        ):
            return {
                "revision": cur["revision"],
                "unchanged": True,
                "missing": [],
                **self.counts(namespace),
            }

        # ② revision 冲突先于 chunkFp 判定：丢过本地状态的客户端会用最小载荷来撞这一条
        if mode == "diff" and client_rev is not None and int(client_rev) != int(cur["revision"]):
            raise RevisionConflict(cur["revision"], need_full=True)

        # ③ 切块配置不同 → 不同命名空间，绝不混写同一份 (path,start)
        if cur["chunk_fp"] != chunk_fp:
            raise SyncDiverged(f"namespace {namespace} 的 chunkFp 不一致：服务端 {cur['chunk_fp']} vs 客户端 {chunk_fp}")

        upsert = payload.get("upsert") or []
        remove = payload.get("remove") or []
        remove_set = set(remove)
        for f in upsert:
            if f.get("path") in remove_set:
                raise SyncDiverged(f"path 同时出现在 upsert 与 remove：{f.get('path')}")

        now = int(time.time())
        with self.lock:
            # ① 删除：整文件移除 + 文件内不再存在的块
            for path in remove_set:
                self.db.execute("delete from chunks where namespace = ? and path = ?", (namespace, path))
            for f in upsert:
                path = f["path"]
                keep = [(c["start"], c["end"], c["hash"]) for c in (f.get("chunks") or [])]
                self.db.execute("delete from chunks where namespace = ? and path = ?", (namespace, path))
                for start, end, chash in keep:
                    self.db.execute(
                        'insert or replace into chunks(namespace, lineage_id, path, start, "end", hash)'
                        " values (?,?,?,?,?,?)",
                        (namespace, lineage, path, int(start), int(end), chash),
                    )

            self.db.execute(
                "update repos set revision = revision + 1, repo_state = ?, tag = coalesce(?, tag), updated_at = ?,"
                " repo_state_chunks = (select count(*) from chunks where namespace = ?) where namespace = ?",
                (repo_state, tag, now, namespace, namespace),
            )
            self.db.execute("update lineages set last_seen = ? where id = ?", (now, lineage))
            self.db.commit()
            self._invalidate()  # sync 改了数据 → 计数/体积缓存失效
            rev = int(self.db.execute("select revision from repos where namespace = ?", (namespace,)).fetchone()["revision"])
            missing = self._missing(namespace, lineage, tag)

        return {"revision": rev, "unchanged": False, "missing": missing, **self.counts(namespace)}

    def _missing(self, namespace, lineage, tag, limit=None):
        """该命名空间里"没有向量的块"。tag 为空表示还没定过模型 → 全部视为缺。"""
        if not tag:
            sql = "select c.hash from chunks c where c.namespace = ?"
            args = [namespace]
        else:
            sql = (
                "select c.hash from chunks c where c.namespace = ? and not exists ("
                " select 1 from vectors v where v.lineage_id = c.lineage_id and v.tag = ? and v.hash = c.hash)"
            )
            args = [namespace, tag]
        if limit:
            sql += f" limit {int(limit)}"
        with self.lock:
            return [r["hash"] for r in self.db.execute(sql, args).fetchall()]

    # ---------------------------------------------------------------- 正文
    def put_chunks(self, namespace, bodies):
        """上传块正文（幂等）。返回 {accepted, deduped}。"""
        repo = self.repo(namespace)
        if not repo:
            raise SyncDiverged(f"未知命名空间：{namespace}")
        lineage = repo["lineage_id"]
        now = int(time.time())
        accepted = deduped = 0
        with self.lock:
            for item in bodies:
                h = item.get("hash")
                body = item.get("body")
                if not h or body is None:
                    continue
                cur = self.db.execute(
                    "select 1 from blobs where lineage_id = ? and hash = ?", (lineage, h)
                ).fetchone()
                if cur:
                    deduped += 1
                    continue
                self.db.execute(
                    "insert into blobs(lineage_id, hash, body, updated_at) values (?,?,?,?)",
                    (lineage, h, body, now),
                )
                accepted += 1
            self.db.commit()
            self._invalidate()  # put_chunks 改了数据 → 计数/体积缓存失效
        return {"accepted": accepted, "deduped": deduped}

    def pending(self, namespace, tag, limit=64, order="spread"):
        """待嵌入的块（正文来自 blobs）。order='spread' 按 hash 排序 → 全仓均匀覆盖。"""
        repo = self.repo(namespace)
        if not repo:
            return []
        clause = "c.namespace = ? and not exists (select 1 from vectors v where v.lineage_id = c.lineage_id and v.tag = ? and v.hash = c.hash)"
        order_sql = "c.hash" if order == "spread" else "c.path, c.start"
        sql = (
            "select distinct c.hash, b.body from chunks c join blobs b"
            " on b.lineage_id = c.lineage_id and b.hash = c.hash"
            f" where {clause} order by {order_sql} limit ?"
        )
        with self.lock:
            rows = self.db.execute(sql, (namespace, tag, int(limit))).fetchall()
        return [{"hash": r["hash"], "body": r["body"]} for r in rows]

    def put_vectors(self, lineage, tag, pairs):
        """pairs: [(hash, np.ndarray)]"""
        now = int(time.time())
        with self.lock:
            for h, vec in pairs:
                v = np.asarray(vec, dtype=np.float32)
                self.db.execute(
                    "insert or replace into vectors(lineage_id, tag, hash, dim, v, updated_at) values (?,?,?,?,?,?)",
                    (lineage, tag, h, int(v.shape[0]), v.tobytes(), now),
                )
            self.db.commit()
            self._invalidate()  # put_vectors 改了数据 → 计数/体积缓存失效

    def missing_bodies(self, namespace, tag, limit=64, order="spread"):
        return self.pending(namespace, tag, limit, order)

    # ---------------------------------------------------------------- 查询
    def matrix(self, namespace, tag):
        """返回 (hashes, matrix[float32, N×dim], meta{hash: (path,start,end)})。

        只读快照：调用方在锁外做点积，避免长时间占锁。
        """
        with self.lock:
            rows = self.db.execute(
                "select c.hash, c.path, c.start, c.\"end\" as end, v.v, v.dim from chunks c"
                " join vectors v on v.lineage_id = c.lineage_id and v.tag = ? and v.hash = c.hash"
                " where c.namespace = ?",
                (tag, namespace),
            ).fetchall()
        hashes = []
        meta = {}
        dim = rows[0]["dim"] if rows else 0
        mat = np.empty((len(rows), dim), dtype=np.float32) if rows else np.empty((0, 0), dtype=np.float32)
        for i, r in enumerate(rows):
            mat[i] = np.frombuffer(r["v"], dtype=np.float32, count=r["dim"])
            hashes.append(r["hash"])
            meta[r["hash"]] = (r["path"], int(r["start"]), int(r["end"]))
        return hashes, mat, meta

    def bodies(self, lineage, hashes):
        if not hashes:
            return {}
        q = ",".join("?" * len(hashes))
        with self.lock:
            rows = self.db.execute(
                f"select hash, body from blobs where lineage_id = ? and hash in ({q})", [lineage, *hashes]
            ).fetchall()
        return {r["hash"]: r["body"] for r in rows}

    def pending_count(self, namespace, tag):
        """便宜的待嵌入计数（给 /status 用，不要把整表捞出来）。"""
        if not tag:
            sql = "select count(distinct c.hash) as n from chunks c where c.namespace = ?"
            args = (namespace,)
        else:
            sql = (
                "select count(distinct c.hash) as n from chunks c where c.namespace = ? and not exists ("
                " select 1 from vectors v where v.lineage_id = c.lineage_id and v.tag = ? and v.hash = c.hash)"
            )
            args = (namespace, tag)
        with self.lock:
            return int(self.db.execute(sql, args).fetchone()["n"])

    def _invalidate(self):
        """任何会改变 chunks/blobs/vectors 的操作后调用（sync/put_chunks/put_vectors/gc/adopt）。"""
        self._cache.clear()

    def counts(self, namespace):
        """{chunks, vectors, coverage}。

        **必须缓存**：`vectors` 那个 JOIN 在 16 万块上实测 401 ms，而 coverage 是
        `/v1/search` 每次都要返回的字段 —— 不缓存就等于每次查询白付 0.4 秒。
        缓存只在写操作后失效，稳态下是 O(1)。
        """
        hit = self._cache.get(("counts", namespace))
        if hit is not None:
            return dict(hit)
        with self.lock:
            chunks = self.db.execute("select count(*) as n from chunks where namespace = ?", (namespace,)).fetchone()["n"]
            repo = self.db.execute("select lineage_id, tag from repos where namespace = ?", (namespace,)).fetchone()
            if not repo:
                out = {"chunks": 0, "vectors": 0, "coverage": 0.0}
                self._cache[("counts", namespace)] = out
                return dict(out)
            vectors = self.db.execute(
                "select count(*) as n from chunks c join vectors v"
                " on v.lineage_id = c.lineage_id and v.tag = ? and v.hash = c.hash where c.namespace = ?",
                (repo["tag"] or "", namespace),
            ).fetchone()["n"]
        out = {"chunks": int(chunks), "vectors": int(vectors), "coverage": round(vectors / chunks, 4) if chunks else 0.0}
        self._cache[("counts", namespace)] = out
        return dict(out)

    def lineage_bytes(self, lineage):
        """正文/向量占用。sum(length(...)) 在 16 万块上实测 0.5 s，同样必须缓存。"""
        hit = self._cache.get(("bytes", lineage))
        if hit is not None:
            return dict(hit)
        with self.lock:
            b = self.db.execute("select coalesce(sum(length(body)),0) as n from blobs where lineage_id = ?", (lineage,)).fetchone()["n"]
            v = self.db.execute("select coalesce(sum(length(v)),0) as n from vectors where lineage_id = ?", (lineage,)).fetchone()["n"]
        out = {"bodyBytes": int(b), "vectorBytes": int(v), "totalBytes": int(b) + int(v)}
        self._cache[("bytes", lineage)] = out
        return dict(out)

    def vector_count(self, lineage, tag=None):
        if tag:
            sql, args = "select count(*) as n from vectors where lineage_id = ? and tag = ?", (lineage, tag)
        else:
            sql, args = "select count(*) as n from vectors where lineage_id = ?", (lineage,)
        with self.lock:
            return int(self.db.execute(sql, args).fetchone()["n"])

    def total_bytes(self):
        with self.lock:
            b = self.db.execute("select coalesce(sum(length(body)),0) as n from blobs").fetchone()["n"]
            v = self.db.execute("select coalesce(sum(length(v)),0) as n from vectors").fetchone()["n"]
        return int(b) + int(v)

    def hashes_in_lineage(self, lineage, tag=None):
        sql = "select distinct hash from chunks where lineage_id = ?"
        args = [lineage]
        if tag:
            sql = "select distinct hash from vectors where lineage_id = ? and tag = ?"
            args.append(tag)
        with self.lock:
            return [r["hash"] for r in self.db.execute(sql, args).fetchall()]

    # ---------------------------------------------------------------- 维护
    def gc(self, lineage, retention_days=30):
        """删掉"血统内已无任何块引用、且超过保留期"的 blob / vector。"""
        cutoff = int(time.time()) - int(retention_days) * 86400
        with self.lock:
            live = set(self.hashes_in_lineage(lineage))
            dead_b = [
                r["hash"]
                for r in self.db.execute("select hash, updated_at from blobs where lineage_id = ?", (lineage,)).fetchall()
                if r["hash"] not in live and int(r["updated_at"]) <= cutoff
            ]
            dead_v = [
                (r["tag"], r["hash"])
                for r in self.db.execute(
                    "select tag, hash, updated_at from vectors where lineage_id = ?", (lineage,)
                ).fetchall()
                if r["hash"] not in live and int(r["updated_at"]) <= cutoff
            ]
            for h in dead_b:
                self.db.execute("delete from blobs where lineage_id = ? and hash = ?", (lineage, h))
            for tag, h in dead_v:
                self.db.execute("delete from vectors where lineage_id = ? and tag = ? and hash = ?", (lineage, tag, h))
            self.db.commit()
            self._invalidate()  # gc 改了数据 → 计数/体积缓存失效
        return {"blobs": len(dead_b), "vectors": len(dead_v)}

    def adopt(self, from_lineage, to_lineage, hashes=None):
        """显式跨血统借用（fork / vendor）：把源血统的 blob 与 vector 复制到目标血统。"""
        now = int(time.time())
        with self.lock:
            if hashes:
                q = ",".join("?" * len(hashes))
                b = self.db.execute(
                    f"select hash, body from blobs where lineage_id = ? and hash in ({q})", [from_lineage, *hashes]
                ).fetchall()
                v = self.db.execute(
                    f"select tag, hash, dim, v from vectors where lineage_id = ? and hash in ({q})",
                    [from_lineage, *hashes],
                ).fetchall()
            else:
                b = self.db.execute("select hash, body from blobs where lineage_id = ?", (from_lineage,)).fetchall()
                v = self.db.execute("select tag, hash, dim, v from vectors where lineage_id = ?", (from_lineage,)).fetchall()
            for r in b:
                self.db.execute(
                    "insert or ignore into blobs(lineage_id, hash, body, updated_at) values (?,?,?,?)",
                    (to_lineage, r["hash"], r["body"], now),
                )
            for r in v:
                self.db.execute(
                    "insert or ignore into vectors(lineage_id, tag, hash, dim, v, updated_at) values (?,?,?,?,?,?)",
                    (to_lineage, r["tag"], r["hash"], r["dim"], r["v"], now),
                )
            self.db.commit()
            self._invalidate()  # adopt 改了数据 → 计数/体积缓存失效
        return {"blobs": len(b), "vectors": len(v)}

    def overview(self):
        with self.lock:
            rows = self.db.execute(
                "select r.namespace, r.lineage_id, r.repo_id, r.chunk_fp, r.revision, r.tag,"
                " (select count(*) from chunks c where c.namespace = r.namespace) as chunks"
                " from repos r order by r.updated_at desc limit 50"
            ).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item.update(self.counts(r["namespace"]))
            item.update(self.lineage_bytes(r["lineage_id"]))
            out.append(item)
        return out

    def close(self):
        with self.lock:
            self.db.close()