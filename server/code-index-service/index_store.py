"""索引存储：血统（lineage）/命名空间（namespace）/* 内容寻址的 blob 与 vector。

## 为什么按"血统 + 内容哈希"存，而不是全局

实测（4 个无关仓库两两比对）：跨项目块重合 **0.00%** —— 全局去重对无关项目毫无收益，
只会线性累积。而同一项目的不同分支/不同克隆，仓库级复用率 **~98%**。
所以存储边界是**血统**（= 归一化后的 git remote URL），血统内按内容哈希去重：

    10 个分支的同一仓库 → 235 MB（去重后），而不是 2.35 GB（每分支一份）

跨血统只留两个显式口子（默认不共享）：`adopt()`（调用方点名从哪个血统借）；
以及"simhash 候选 → 精确哈希 adopt"（`similar_lineages()` / `adopt_overlap()` /
`adopt_hashes()`，给 fork / remote 改名 / vendor 副本的冷启动用）。后者只复制
**候选里确实存在、且目标自己 manifest 也拥有**的内容哈希，绝不复制 chunks / path。

## 为什么 blob 与 vector 都用 hash 做主键的一部分

切块在客户端做（服务端不切块），客户端送上来的是 `(path, start, end, hash)` + 正文。
hash = sha256(块正文) 是内容身份：同一段代码换了路径/行号仍然是同一行存储，
因此"改文件 → 只有变化的块需要重嵌"这件事在存储层天然成立。
"""
import hashlib
import json
import os
import re
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
  repo_name text,
  chunk_fp text not null,
  revision integer not null default 0,
  tag text,
  repo_state text,
  repo_state_chunks integer,
  updated_at integer not null,
  scope_kind text not null default 'legacy',
  scope_ref text,
  commit_sha text,
  ttl_days integer,
  expires_at integer,
  pinned integer not null default 0,
  created_at integer,
  simhash_path text,
  simhash_content text,
  simhash_algo text,
  simhash_files integer,
  simhash_at integer
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

# ---------------------------------------------------------------- 作用域（档 3）
# 规则见 docs/scope-tier3.md §2；夹具 scope_format.json 是本文件的验收标准。
SCOPE_KINDS = ("legacy", "main", "branch", "pr", "worktree")
# 默认 TTL（天）：main / legacy 永久。服务端可用环境变量覆盖后传给 IndexStore。
DEFAULT_SCOPE_TTL = {"branch": 30, "pr": 14, "worktree": 1, "main": None, "legacy": None}

# ---------------------------------------------------------------- simhash 候选（跨血统冷启动）
# 客户端把整棵文件清单压成两个 64-bit simhash（path-aware / content-only）。
# 服务端只用它**找候选**，绝不把它当存储键：真正复制的仍是精确内容哈希（blobs/vectors）。
SIMHASH_HEX_LEN = 16          # 64-bit → 16 hex
SIMHASH_MIN_SIMILARITY = 0.85  # max(path/content 相似度) 门槛
ADOPT_MIN_OVERLAP = 0.80       # 目标 chunks ∩ 候选当前 tag vectors / 目标 chunks
MAX_ADOPT_CANDIDATES = 5
MAX_ADOPT_HASHES = 50000
MAX_SIMHASH_FILES = 10_000_000
_SIMHASH_HEX_RE = re.compile(r"^[0-9a-fA-F]{1,16}$")
_SIMHASH_ALGO_RE = re.compile(r"^[A-Za-z0-9._:-]{1,16}$")
_TOKENS = {"main": "main", "branch": "branch", "pr": "pr", "worktree": "wt"}
_TOKEN_KINDS = {v: k for k, v in _TOKENS.items()}
_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_DIGITS_RE = re.compile(r"^[0-9]+$")


class ScopeFormatError(ValueError):
    """namespace 规范化失败。`reason` 直接进 API 的 400 {error:'bad-scope', reason}。"""

    def __init__(self, reason, detail=""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


def scope_safe(s):
    """safe(s)：非 [A-Za-z0-9._-] 的**连续**字符压成 "-"，再去首尾 "-"；空则 "x"。"""
    out = []
    dash = False
    for ch in str(s or ""):
        if ch.isascii() and (ch.isalnum() or ch in "._-"):
            out.append(ch)
            dash = False
        elif not dash:
            out.append("-")
            dash = True
    return "".join(out).strip("-") or "x"


def ref_token(kind, ref):
    """§2 的 refToken（main 忽略 ref，返回 "default"）。非法时抛 ScopeFormatError。"""
    if kind == "main":
        return "default"
    token = "" if ref is None else str(ref)
    if kind == "branch":
        if not token:
            raise ScopeFormatError("empty-ref", "branch ref 不能为空")
        return f"{scope_safe(token)}-{hashlib.sha1(token.encode('utf-8')).hexdigest()[:6]}"
    if kind == "pr":
        if not token:
            raise ScopeFormatError("empty-ref", "pr ref 不能为空")
        if not _DIGITS_RE.match(token):
            raise ScopeFormatError("pr-ref-not-numeric", f"pr ref 必须是纯数字：{token}")
        return str(int(token))
    if kind == "worktree":
        if not token:
            raise ScopeFormatError("empty-ref", "worktree ref 不能为空")
        return hashlib.sha1(token.encode("utf-8")).hexdigest()[:8]
    raise ScopeFormatError("unknown-kind", f"kind={kind}")


def canonical_namespace(repo_id, chunk_fp, kind, ref):
    """canonical_namespace(repoId, chunkFp, kind, ref) -> "{repoId}@{chunkFp}#{kind}:{refToken}"。

    legacy 命名空间（不含 #）**不经过本函数**，原样保留（见 legacy_namespace()）。
    """
    repo_id = "" if repo_id is None else str(repo_id)
    chunk_fp = "" if chunk_fp is None else str(chunk_fp)
    if not _ID_RE.match(repo_id):
        raise ScopeFormatError("invalid-repo-id", f"repoId={repo_id!r}")
    if not _ID_RE.match(chunk_fp):
        raise ScopeFormatError("invalid-chunk-fp", f"chunkFp={chunk_fp!r}")
    if kind not in _TOKENS:
        raise ScopeFormatError("unknown-kind", f"kind={kind!r}")
    return f"{repo_id}@{chunk_fp}#{_TOKENS[kind]}:{ref_token(kind, ref)}"


def legacy_namespace(namespace):
    """legacy 命名空间原样保留（不做规范化）；带 "#" 的说明其实是 scope，不当 legacy。"""
    ns = "" if namespace is None else str(namespace)
    if "#" in ns:
        raise ScopeFormatError("not-legacy", f"带 # 的 namespace 不是 legacy：{ns}")
    return ns


def parse_scope_namespace(namespace):
    """从 canonical namespace 反推 scope 元信息（legacy 返回 kind='legacy'）。

    返回 {kind, token, scope_ref}；scope_ref 按 §3 的列值口径：
    main -> "default"、branch -> token、pr -> token、worktree -> "wt:<sha8>"。
    """
    ns = "" if namespace is None else str(namespace)
    if "#" not in ns:
        return {"kind": "legacy", "token": None, "scope_ref": None}
    _, _, tail = ns.rpartition("#")
    prefix, _, token = tail.partition(":")
    kind = _TOKEN_KINDS.get(prefix)
    if not kind:
        return {"kind": "legacy", "token": token or None, "scope_ref": None}
    if kind == "worktree":
        scope_ref = f"wt:{token}" if token else None
    else:
        scope_ref = token or None
    return {"kind": kind, "token": token or None, "scope_ref": scope_ref}


def namespace_identity(namespace):
    """从 "{repoId}@{chunkFp}#..." / "{repoId}@{chunkFp}" 里取 (repoId, chunkFp)。"""
    ns = "" if namespace is None else str(namespace)
    if "@" not in ns:
        return None, None
    repo_id, _, rest = ns.partition("@")
    chunk_fp = rest.split("#", 1)[0]
    return repo_id or None, chunk_fp or None


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


# ---------------------------------------------------------------- simhash 校验 / 距离
def normalize_simhash_hex(value):
    """把 64-bit simhash 规范成 16 位小写 hex；非法返回 None。

    输入放宽到 1–16 位（客户端可能没补前导 0，服务端按左补零对齐），但长度有硬上界：
    simhash 只是候选线索，**绝不能**原样拼进 SQL / 路径，这里先把注入面消掉。
    """
    if not isinstance(value, str):
        return None
    s = value.strip().lower()
    if not _SIMHASH_HEX_RE.match(s):
        return None
    return s.rjust(SIMHASH_HEX_LEN, "0")


def parse_simhash(obj):
    """校验 sync payload 里的可选 simhash 对象 → {path, content, algo, files}；非法返回 None。

    非法只意味着"这次不更新 simhash"，**绝不抛异常**：旧客户端 / 坏客户端不能拖垮 sync。
    """
    if not isinstance(obj, dict):
        return None
    path = normalize_simhash_hex(obj.get("path"))
    content = normalize_simhash_hex(obj.get("content"))
    if not path or not content:
        return None
    raw_algo = obj.get("v", obj.get("algo", 1))
    if raw_algo is None or isinstance(raw_algo, bool):
        return None
    algo = str(raw_algo).strip()
    if not _SIMHASH_ALGO_RE.match(algo):
        return None
    files = obj.get("files")
    if files is not None:
        try:
            files = int(files)
        except (TypeError, ValueError):
            files = None
        if files is not None:
            files = max(0, min(files, MAX_SIMHASH_FILES))
    return {"path": path, "content": content, "algo": algo, "files": files}


def hamming_similarity(a, b):
    """两个 64-bit simhash 的相似度 = 1 - hamming_bits / 64；任一非法返回 None。"""
    na = normalize_simhash_hex(a)
    nb = normalize_simhash_hex(b)
    if not na or not nb:
        return None
    x = int(na, 16) ^ int(nb, 16)
    bits = x.bit_count() if hasattr(x, "bit_count") else bin(x).count("1")
    return 1.0 - bits / 64.0


def _chunked(seq, size=400):
    """把 IN (...) 的参数分批：SQLite 老版本变量上限是 999，adopt 可能有几万 hash。"""
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def _as_bool(value):
    """把 payload 里的开关宽松归一（true / 1 / "auto" 都算开；"off"/"false"/0 算关）。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on", "auto")
    return False


class IndexStore:
    def __init__(self, db_path, scope_ttl=None):
        self.db_path = db_path
        # 每个 kind 的默认 TTL（天）；None = 永久。服务端用环境变量覆盖。
        self.scope_ttl = dict(DEFAULT_SCOPE_TTL)
        if scope_ttl:
            for k, v in scope_ttl.items():
                self.scope_ttl[k] = None if v is None else int(v)
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
        # 幂等迁移：早期 0.8.0 的库里 repos 没有 repo_state_chunks 这一列；
        # 档 3 又加了 scope 相关 7 列。老库补齐后，legacy 行标成 pinned（永不被 janitor 删）。
        cols = {r["name"] for r in self.db.execute("pragma table_info(repos)").fetchall()}
        scope_added = False
        for name, ddl in (
            ("scope_kind", "text not null default 'legacy'"),
            ("scope_ref", "text"),
            ("commit_sha", "text"),
            ("ttl_days", "integer"),
            ("expires_at", "integer"),
            ("pinned", "integer not null default 0"),
            ("created_at", "integer"),
            ("repo_name", "text"),
        ):
            if name not in cols:
                self.db.execute(f"alter table repos add column {name} {ddl}")
                scope_added = True
        if "repo_state_chunks" not in cols:
            self.db.execute("alter table repos add column repo_state_chunks integer")
        # P3 simhash：只增不删的幂等列（旧库启动自动补齐；旧客户端不写 → 保持 null）。
        # 刻意与 scope 的 `scope_added` 回填解耦：补 simhash 列不能触发 legacy 重新 pin。
        for name, ddl in (
            ("simhash_path", "text"),
            ("simhash_content", "text"),
            ("simhash_algo", "text"),
            ("simhash_files", "integer"),
            ("simhash_at", "integer"),
        ):
            if name not in cols:
                self.db.execute(f"alter table repos add column {name} {ddl}")
        # 只在"本次才补上 scope 列"的老库上做 legacy 回填：先 pinned/expires，再回填 created_at，
        # 这样二次启动不会再把管理员显式 unpin 的 legacy 行重新钉上（幂等）。
        if scope_added:
            self.db.execute("update repos set pinned = 1 where scope_kind = 'legacy' and created_at is null")
            self.db.execute("update repos set expires_at = null where scope_kind = 'legacy' and created_at is null")
        self.db.execute("update repos set created_at = updated_at where created_at is null")
        self.db.execute("create index if not exists repos_scope on repos(scope_kind, expires_at)")
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

    def ensure_repo(self, namespace, repo_id, chunk_fp, lineage_id, tag=None, repo_name=None):
        now = int(time.time())
        with self.lock:
            row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
            if not row:
                # 行先按 namespace 反推 scope 元信息落库（legacy 行 pinned=1，protected 于 janitor）；
                # 带 scope 的同步随后由 register_scope() 校准 kind/ref/TTL。
                meta = parse_scope_namespace(namespace)
                kind = meta["kind"]
                self.db.execute(
                    "insert into repos(namespace, lineage_id, repo_id, repo_name, chunk_fp, revision, tag,"
                    " repo_state, repo_state_chunks, updated_at, scope_kind, scope_ref, commit_sha, ttl_days,"
                    " expires_at, pinned, created_at)"
                    " values (?,?,?,?,?,0,?,null,null,?,?,?,null,null,null,?,?)",
                    (
                        namespace,
                        lineage_id,
                        repo_id,
                        repo_name,
                        chunk_fp,
                        tag,
                        now,
                        kind,
                        meta["scope_ref"],
                        1 if kind == "legacy" else 0,
                        now,
                    ),
                )
                self.db.commit()
            elif repo_name and (row["repo_name"] or "") != repo_name:
                # 老行补名字（插件/客户端后续同步时带上 repoName）
                self.db.execute(
                    "update repos set repo_name = ?, updated_at = ? where namespace = ?",
                    (repo_name, now, namespace),
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

    def set_all_tags(self, tag):
        """把所有**已同步**仓库的 tag 批量改成新模型 tag（热切换用）；返回影响行数。

        - 只更新 tag 非空的行：从未定过 tag 的仓库（还没带 tag 同步过）保持原样，
          它们的 pending 语义是"全部待嵌"，不能被一次热切换误标成已同步；
        - 单条 UPDATE、单事务（调完一起 commit），16 万块规模也只是一次行更新；
        - 改 tag 等价于让现有向量作废（旧 tag 的向量留在库里，missing 按新 tag 重算，
          旧向量由 purge_tag_vectors() 显式清理），所以必须失效计数/体积/覆盖度缓存。
        """
        tag = "" if tag is None else str(tag)
        if not tag:
            raise ValueError("set_all_tags 的 tag 不能为空")
        with self.lock:
            cur = self.db.execute(
                "update repos set tag = ?, updated_at = ? where tag is not null and tag != ''",
                (tag, int(time.time())),
            )
            self.db.commit()
            self._invalidate()  # tag 全改 → counts 的 vectors/coverage 缓存全部失效
            return int(cur.rowcount or 0)

    # ---------------------------------------------------------------- 作用域生命周期
    def register_scope(self, namespace, kind, ref, commit_sha=None, ttl_days=None, pinned=None,
                       scope_ref=None, new_row=None):
        """写/更新 scope 元数据。

        - `expires_at = now + (ttl_days ?? default_for(kind))`；kind=main/legacy 永远为 null；
        - 已存在的行**不覆盖** pinned/expires_at（除非 ttl_days 显式给出）——sync 的增量语义；
        - new_row=True 表示这是刚建出来的 repos 行（调用方在 sync 前判断过），此时落默认 TTL/pinned。
        返回更新后的 repos 行。
        """
        now = int(time.time())
        kind = kind or "legacy"
        if kind not in SCOPE_KINDS:
            raise ScopeFormatError("unknown-kind", f"kind={kind!r}")
        if scope_ref is None:
            scope_ref = self._scope_ref_value(kind, ref)
        with self.lock:
            row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
            if row is None:
                repo_id, chunk_fp = namespace_identity(namespace)
                lineage = self.ensure_lineage("", repo_id or "unknown")
                self.db.execute(
                    "insert into repos(namespace, lineage_id, repo_id, chunk_fp, revision, tag, repo_state,"
                    " repo_state_chunks, updated_at, scope_kind, scope_ref, commit_sha, ttl_days, expires_at,"
                    " pinned, created_at) values (?,?,?,?,0,null,null,null,?,?,?,?,null,null,?,?)",
                    (namespace, lineage, repo_id or "unknown", chunk_fp or "default", now, kind, scope_ref,
                     commit_sha, 1 if kind == "legacy" else 0, now),
                )
                self.db.commit()
                row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
                new_row = True
            if new_row is None:
                new_row = False
            sets = ["scope_kind = ?", "scope_ref = ?", "updated_at = ?"]
            args = [kind, scope_ref, now]
            if commit_sha is not None:
                sets.append("commit_sha = ?")
                args.append(commit_sha)
            # TTL：新行必须落默认/显式值；老行只有显式 ttlDays 才改（否则 pin 出来的永久态会被同步覆盖）
            if new_row or ttl_days is not None:
                if kind in ("main", "legacy"):
                    expires_at = None
                elif ttl_days is not None:
                    expires_at = now + max(0, int(ttl_days)) * 86400
                else:
                    days = self.scope_ttl.get(kind)
                    expires_at = None if days is None else now + int(days) * 86400
                sets += ["expires_at = ?", "ttl_days = ?"]
                args += [expires_at, max(0, int(ttl_days)) if ttl_days is not None else None]
            if pinned is not None or new_row:
                value = pinned if pinned is not None else (1 if kind == "legacy" else 0)
                sets.append("pinned = ?")
                args.append(1 if value else 0)
            args.append(namespace)
            self.db.execute(f"update repos set {', '.join(sets)} where namespace = ?", args)
            self.db.commit()
            row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
        return dict(row) if row else None

    def pin_scope(self, namespace, pinned, ttl_days=None, update_ttl=False):
        """设置 pinned；update_ttl=True 时同时改 expires_at（ttl_days=None → 永久）。"""
        now = int(time.time())
        with self.lock:
            row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
            if row is None:
                return None
            sets = ["pinned = ?", "updated_at = ?"]
            args = [1 if pinned else 0, now]
            if update_ttl:
                kind = row["scope_kind"] or "legacy"
                if kind in ("main", "legacy") or ttl_days is None:
                    expires_at = None
                else:
                    expires_at = now + max(0, int(ttl_days)) * 86400
                sets += ["expires_at = ?", "ttl_days = ?"]
                args += [expires_at, max(0, int(ttl_days)) if ttl_days is not None else None]
            args.append(namespace)
            self.db.execute(f"update repos set {', '.join(sets)} where namespace = ?", args)
            self.db.commit()
            row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
        return dict(row) if row else None

    def delete_scope(self, namespace):
        """删除一个 scope：chunks + repos 行；blob/vector 交给 gc（可能还被别的 scope 引用）。幂等。"""
        with self.lock:
            row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
            if not row:
                return {"deleted": False, "chunks": 0, "lineage": None}
            chunks = int(
                self.db.execute("select count(*) as n from chunks where namespace = ?", (namespace,)).fetchone()["n"]
            )
            self.db.execute("delete from chunks where namespace = ?", (namespace,))
            self.db.execute("delete from repos where namespace = ?", (namespace,))
            self.db.commit()
            self._invalidate()  # 删块 → 计数/体积缓存失效
        return {"deleted": True, "chunks": chunks, "lineage": row["lineage_id"]}

    def expired_scopes(self, now=None):
        now = int(time.time()) if now is None else int(now)
        with self.lock:
            rows = self.db.execute(
                "select namespace, lineage_id from repos where pinned = 0 and expires_at is not null and expires_at <= ?",
                (now,),
            ).fetchall()
        return [{"namespace": r["namespace"], "lineage_id": r["lineage_id"]} for r in rows]

    def sweep_scopes(self, now=None):
        """只删 pinned=0 且已过期的 scope；返回 {deleted:[ns...], lineages:[...]}。"""
        expired = self.expired_scopes(now)
        deleted = []
        lineages = []
        for item in expired:
            r = self.delete_scope(item["namespace"])
            if not r.get("deleted"):
                continue
            deleted.append(item["namespace"])
            if item["lineage_id"] and item["lineage_id"] not in lineages:
                lineages.append(item["lineage_id"])
        return {"deleted": deleted, "lineages": lineages}

    def scope_overview(self, repo_id=None, kind=None, limit=50):
        """overview() 的每一项再加 scope 元信息与 ttlRemaining（给 /v1/scopes 与 /health）。"""
        where = []
        args = []
        if repo_id:
            where.append("r.repo_id = ?")
            args.append(repo_id)
        if kind:
            where.append("r.scope_kind = ?")
            args.append(kind)
        sql = (
            "select r.*, (select count(*) from chunks c where c.namespace = r.namespace) as chunks"
            " from repos r"
        )
        if where:
            sql += " where " + " and ".join(where)
        sql += " order by r.updated_at desc limit ?"
        args.append(int(limit))
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
        now = int(time.time())
        out = []
        for r in rows:
            item = dict(r)
            item.update(self.counts(r["namespace"]))
            item.update(self.lineage_bytes(r["lineage_id"]))
            expires_at = r["expires_at"]
            pinned = bool(r["pinned"])
            item["scope"] = {
                "kind": r["scope_kind"] or "legacy",
                "ref": r["scope_ref"],
                "commit": r["commit_sha"],
                "createdAt": r["created_at"],
                "expiresAt": expires_at,
                "pinned": pinned,
            }
            item["pinned"] = pinned
            item["ttlRemaining"] = None if expires_at is None else max(0, int(expires_at) - now)
            out.append(item)
        return out

    def count_scopes(self):
        with self.lock:
            return int(self.db.execute("select count(*) as n from repos").fetchone()["n"])

    def scope_stats(self):
        """{total, byKind:{legacy,main,branch,pr,worktree}}（/health 的 scopes 汇总）。"""
        with self.lock:
            rows = self.db.execute("select scope_kind, count(*) as n from repos group by scope_kind").fetchall()
        by_kind = {k: 0 for k in SCOPE_KINDS}
        for r in rows:
            key = r["scope_kind"] or "legacy"
            by_kind[key] = by_kind.get(key, 0) + int(r["n"])
        return {"total": sum(by_kind.values()), "byKind": by_kind}

    @staticmethod
    def _scope_ref_value(kind, ref):
        """§3 的 scope_ref 列口径：main:default / branch 原名 / pr:<iid> / wt:<sha8>。"""
        if kind == "main":
            return "default"
        if kind == "legacy":
            return None
        token = "" if ref is None else str(ref)
        if kind == "pr":
            return str(int(token)) if _DIGITS_RE.match(token) else token
        if kind == "worktree":
            if token.startswith("wt:"):
                return token
            return f"wt:{hashlib.sha1(token.encode('utf-8')).hexdigest()[:8]}"
        return token or None

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
        repo_name = payload.get("repoName") or payload.get("repo_name")
        cur = self.ensure_repo(namespace, repo_id, chunk_fp, lineage, tag=tag, repo_name=repo_name)
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
            # 指纹短路也要顺手更新 simhash（客户端升级后第一次 full sync 可能正好命中短路；
            # 不更新就会永远没有候选线索）。失败无所谓：simhash 只是线索，绝不影响 sync。
            sh = parse_simhash(payload.get("simhash"))
            if sh and (cur.get("simhash_path") != sh["path"] or cur.get("simhash_content") != sh["content"]):
                try:
                    self.set_simhash(namespace, sh)
                except Exception:  # noqa: BLE001
                    pass
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
        # simhash 只作为候选线索：非法值直接忽略（老客户端/坏客户端不能拖垮 sync）。
        simhash = parse_simhash(payload.get("simhash"))
        # 跨血统冷启动复用只在 full + 客户端显式 adopt 开关 + reuse 非 off 时发生；
        # 其他 sync（diff / 普通 full）**绝不做**候选查询，避免热路径多付一次全 repos 扫描。
        # adopt 开关优先看 payload.adopt；客户端只发 reuse 时，"auto" 本身就是
        # "达到阈值自动复制"的显式配置（suggest/off 都不复制）。
        reuse = str(payload.get("reuse") or "").strip().lower()
        if payload.get("adopt") is not None:
            adopt_switch = _as_bool(payload.get("adopt"))
        else:
            adopt_switch = reuse == "auto"
        adopt_requested = mode == "full" and adopt_switch and reuse != "off"
        adopted = None
        adopt_error = None
        adopt_candidates = None
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
            # 每次 sync 都刷新 simhash（仅当本次带了合法值）
            if simhash:
                try:
                    self._write_simhash(namespace, simhash, now=now)
                except Exception:  # noqa: BLE001 —— simhash 落库失败不影响 sync
                    pass
            # 写入目标 chunks 之后、计算 _missing 之前尝试 adopt；失败回滚并继续正常 sync。
            if adopt_requested and simhash:
                try:
                    adopted = self._maybe_adopt(namespace, lineage, tag, simhash)
                except Exception as e:  # noqa: BLE001 —— adopt 是尽力而为，绝不返回 500
                    self.db.rollback()  # adopt 中途失败时不要留下半截事务
                    adopted = None
                    adopt_error = f"{type(e).__name__}: {e}"
            # suggest 只返回候选元信息，不复制；让调用方决定是否改 auto。
            if mode == "full" and reuse == "suggest" and simhash:
                try:
                    adopt_candidates = self.similar_lineages(
                        simhash["path"], simhash["content"], lineage, tag,
                        limit=3, algo=simhash.get("algo"), target_namespace=namespace,
                    )
                except Exception:  # noqa: BLE001 —— 候选只是建议
                    adopt_candidates = None
            missing = self._missing(namespace, lineage, tag)

        out = {"revision": rev, "unchanged": False, "missing": missing, **self.counts(namespace)}
        if adopted:
            out["adopted"] = adopted
        if adopt_candidates:
            out["adoptCandidates"] = adopt_candidates
        if adopt_error:
            out["adoptError"] = adopt_error
        return out

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

    def tag_stats(self):
        """所有向量 tag 的条数与占用（换模型后旧 tag 会继续占空间，需要显式清理）。

        **必须缓存**：`sum(length(v))` 要扫全表（16 万行 ≈ 3 s），而 `/health` 每次都会调；
        不缓存会让后台首页每次刷新都卡 3 秒。写向量/清 tag 后 _invalidate() 自动失效。
        """
        hit = self._cache.get(("tagstats",))
        if hit is not None:
            return [dict(x) for x in hit]
        with self.lock:
            rows = self.db.execute(
                "select tag, count(*) as vectors, coalesce(sum(length(v)),0) as bytes"
                " from vectors group by tag order by vectors desc"
            ).fetchall()
        out = [{"tag": r["tag"], "vectors": int(r["vectors"]), "bytes": int(r["bytes"])} for r in rows]
        self._cache[("tagstats",)] = out
        return [dict(x) for x in out]

    def purge_tag_vectors(self, keep_tag=None, drop_tag=None):
        """删指定 tag 的向量，或保留 keep_tag 删其余所有 tag；返回 {deleted}。"""
        if drop_tag is None and keep_tag is None:
            raise ValueError("drop_tag 或 keep_tag 必须给一个")
        with self.lock:
            if drop_tag is not None:
                cur = self.db.execute("delete from vectors where tag = ?", (drop_tag,))
            else:
                cur = self.db.execute("delete from vectors where tag is null or tag != ?", (keep_tag,))
            self.db.commit()
            self._invalidate()
            return {"deleted": int(cur.rowcount or 0), "keptTag": keep_tag, "droppedTag": drop_tag}

    def total_bytes(self):
        """全库正文+向量占用；同样要缓存（1.6GB 全扫），写操作后由 _invalidate() 失效。"""
        hit = self._cache.get(("totalbytes",))
        if hit is not None:
            return int(hit)
        with self.lock:
            b = self.db.execute("select coalesce(sum(length(body)),0) as n from blobs").fetchone()["n"]
            v = self.db.execute("select coalesce(sum(length(v)),0) as n from vectors").fetchone()["n"]
        total = int(b) + int(v)
        self._cache[("totalbytes",)] = total
        return total

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

    # ---------------------------------------------------------------- simhash 候选 / 精确 adopt
    def set_simhash(self, namespace, simhash, now=None):
        """写入/更新一个命名空间的 simhash 元信息；非法值抛 ValueError（sync 内部不走这里）。"""
        data = parse_simhash(simhash)
        if data is None:
            raise ValueError("bad simhash: path/content 必须是 ≤16 位十六进制，v/files 必须合法")
        return self._write_simhash(namespace, data, now=now)

    def _write_simhash(self, namespace, data, now=None):
        """已是校验过的 simhash dict；返回写入后的 dict，未知 namespace 返回 None。"""
        ts = int(time.time()) if now is None else int(now)
        with self.lock:
            cur = self.db.execute(
                "update repos set simhash_path = ?, simhash_content = ?, simhash_algo = ?,"
                " simhash_files = ?, simhash_at = ? where namespace = ?",
                (data["path"], data["content"], data["algo"], data["files"], ts, namespace),
            )
            self.db.commit()
        return dict(data) if cur.rowcount else None

    def similar_lineages(self, simhash_path, simhash_content, exclude_lineage, tag,
                         limit=MAX_ADOPT_CANDIDATES, min_similarity=SIMHASH_MIN_SIMILARITY,
                         algo=None, target_namespace=None):
        """按 simhash 找相似血统（只返回元信息，**不返回正文**）。

        实现取"扫 repos 行"而不是"扫块"：有 simhash 的行数 = 血统/scope 数，量级远小于块数。
        每个 lineage 按 updated_at 取最新一行再过滤：

          - 不是 `exclude_lineage`；
          - 候选 `repos.tag == tag`：tag 为空直接返回 []，模型不同就没有可复用的向量；
          - `algo` 给定时算法版本必须一致（算法升级后旧 simhash 不参与候选）；
          - `similarity = max(pathSimilarity, contentSimilarity) >= min_similarity`；
          - 给了 `target_namespace` 且目标血统当前 tag 已有向量 → 返回 []（不是冷启动，没必要）。

        结果按相似度降序，最多 `limit` 条。
        """
        query_path = normalize_simhash_hex(simhash_path)
        query_content = normalize_simhash_hex(simhash_content)
        if not query_path or not query_content:
            return []
        tag = "" if tag is None else str(tag)
        if not tag:
            return []
        try:
            limit = max(1, min(int(limit), 50))
        except (TypeError, ValueError):
            limit = MAX_ADOPT_CANDIDATES
        try:
            threshold = float(min_similarity)
        except (TypeError, ValueError):
            threshold = SIMHASH_MIN_SIMILARITY
        algo_s = None if algo is None else str(algo)
        with self.lock:
            if target_namespace:
                trow = self.db.execute(
                    "select lineage_id from repos where namespace = ?", (target_namespace,)
                ).fetchone()
                if trow:
                    if not exclude_lineage:
                        exclude_lineage = trow["lineage_id"]
                    # 目标血统已经有当前 tag 的向量 → 不是冷启动，做候选/adopt 没有收益
                    if self.vector_count(trow["lineage_id"], tag) > 0:
                        return []
            rows = self.db.execute(
                "select namespace, lineage_id, repo_id, repo_name, tag, simhash_path, simhash_content,"
                " simhash_algo, simhash_files, updated_at from repos"
                " where simhash_path is not null and simhash_content is not null"
                " order by updated_at desc"
            ).fetchall()
        seen = set()
        out = []
        for r in rows:
            lineage = r["lineage_id"]
            if not lineage or lineage in seen:
                continue
            seen.add(lineage)  # 同 lineage 只取 updated_at 最大的那行（SQL 已倒序）
            if exclude_lineage and lineage == exclude_lineage:
                continue
            if (r["tag"] or "") != tag:
                continue
            if algo_s is not None and (r["simhash_algo"] or "") != algo_s:
                continue
            path_sim = hamming_similarity(query_path, r["simhash_path"])
            content_sim = hamming_similarity(query_content, r["simhash_content"])
            if path_sim is None or content_sim is None:
                continue
            sim = max(path_sim, content_sim)
            if sim < threshold:
                continue
            out.append({
                "lineage": lineage,
                "namespace": r["namespace"],
                "repoId": r["repo_id"],
                "repoName": r["repo_name"],
                "tag": r["tag"],
                "similarity": round(sim, 4),
                "pathSimilarity": round(path_sim, 4),
                "contentSimilarity": round(content_sim, 4),
                "distance": int(round((1.0 - sim) * 64)),
                "algo": r["simhash_algo"],
                "files": r["simhash_files"],
                "updatedAt": int(r["updated_at"]),
            })
        out.sort(key=lambda x: (-x["similarity"], x["lineage"]))
        return out[:limit]

    def adopt_overlap(self, namespace, from_lineage, tag):
        """目标 namespace 的 distinct chunk hash ∩ 候选 lineage 当前 tag vectors。

        返回 `{hashes, overlap, matched, targetHashes, targetChunks}`；
        `overlap = matched / targetHashes`（分母用 distinct hash：vectors 是按 hash 存的，
        同内容多路径不该稀释比例；`targetChunks` 另给 chunk 行数，便于诊断）。
        """
        tag = "" if tag is None else str(tag)
        empty = {"hashes": [], "overlap": 0.0, "matched": 0, "targetHashes": 0, "targetChunks": 0}
        if not tag or not from_lineage or not namespace:
            return empty
        with self.lock:
            row = self.db.execute(
                "select count(*) as chunks, count(distinct hash) as hashes"
                " from chunks where namespace = ?", (namespace,)
            ).fetchone()
            total_hashes = int(row["hashes"] or 0)
            if not total_hashes:
                return empty
            rows = self.db.execute(
                "select distinct c.hash from chunks c join vectors v"
                " on v.lineage_id = ? and v.tag = ? and v.hash = c.hash"
                " where c.namespace = ?",
                (from_lineage, tag, namespace),
            ).fetchall()
        hashes = [r["hash"] for r in rows]
        return {
            "hashes": hashes,
            "overlap": round(len(hashes) / total_hashes, 4),
            "matched": len(hashes),
            "targetHashes": total_hashes,
            "targetChunks": int(row["chunks"] or 0),
        }

    def adopt_hashes(self, from_lineage, to_lineage, hashes, tag, namespace=None):
        """只复制"目标确实拥有 + 候选 blobs/vectors 都有 + 当前 tag"的精确内容哈希。

        - `namespace` 给定时再做一层防御：只允许该 namespace chunks 里确实存在的 hash；
        - **绝不复制** chunks / repos / path：目标搜索永远只查自己的 namespace；
        - `insert or ignore` 保证幂等；只有 blob 与当前 tag vector 同时在的 hash 才复制，
          避免造出"有向量没正文"的块；
        - 返回 `{blobs, vectors, hashes, truncated}`：blobs/vectors 是**实际新插入**行数，
          hashes 是命中的精确 hash 数（>50000 会截断并置 truncated）。
        """
        tag = "" if tag is None else str(tag)
        if not tag:
            raise ValueError("adopt_hashes 需要当前 embedding tag")
        if not from_lineage or not to_lineage or from_lineage == to_lineage:
            return {"blobs": 0, "vectors": 0, "hashes": 0, "truncated": False}
        wanted = []
        seen = set()
        for h in hashes or []:
            h = "" if h is None else str(h)
            if not h or h in seen:
                continue
            seen.add(h)
            wanted.append(h)
        truncated = len(wanted) > MAX_ADOPT_HASHES
        wanted = wanted[:MAX_ADOPT_HASHES]
        if not wanted:
            return {"blobs": 0, "vectors": 0, "hashes": 0, "truncated": truncated}

        now = int(time.time())
        inserted_blobs = inserted_vectors = eligible_total = 0
        with self.lock:
            if namespace:
                allowed = set()
                for part in _chunked(wanted):
                    q = ",".join("?" * len(part))
                    rows = self.db.execute(
                        f"select distinct hash from chunks where namespace = ? and lineage_id = ?"
                        f" and hash in ({q})",
                        [namespace, to_lineage, *part],
                    ).fetchall()
                    allowed.update(r["hash"] for r in rows)
                wanted = [h for h in wanted if h in allowed]
            for part in _chunked(wanted):
                q = ",".join("?" * len(part))
                bodies = {
                    r["hash"]: r["body"]
                    for r in self.db.execute(
                        f"select hash, body from blobs where lineage_id = ? and hash in ({q})",
                        [from_lineage, *part],
                    ).fetchall()
                }
                vectors = {
                    r["hash"]: r
                    for r in self.db.execute(
                        f"select tag, hash, dim, v from vectors"
                        f" where lineage_id = ? and tag = ? and hash in ({q})",
                        [from_lineage, tag, *part],
                    ).fetchall()
                }
                for h in part:
                    if h not in bodies or h not in vectors:
                        continue
                    eligible_total += 1
                    cur = self.db.execute(
                        "insert or ignore into blobs(lineage_id, hash, body, updated_at) values (?,?,?,?)",
                        (to_lineage, h, bodies[h], now),
                    )
                    inserted_blobs += max(0, int(cur.rowcount or 0))
                    vec = vectors[h]
                    cur = self.db.execute(
                        "insert or ignore into vectors(lineage_id, tag, hash, dim, v, updated_at)"
                        " values (?,?,?,?,?,?)",
                        (to_lineage, tag, h, vec["dim"], vec["v"], now),
                    )
                    inserted_vectors += max(0, int(cur.rowcount or 0))
            self.db.commit()
            self._invalidate()  # adopt 改了 data → 计数/体积缓存失效
        return {"blobs": inserted_blobs, "vectors": inserted_vectors,
                "hashes": eligible_total, "truncated": truncated}

    def _maybe_adopt(self, namespace, lineage, tag, simhash):
        """sync 内部的 best-effort adopt（候选 → overlap 门槛 → 精确 hash 复制）。

        调用方负责 catch/rollback；这里只负责按阈值挑第一个合格候选。
        返回 `{fromLineage, fromRepo, similarity, overlap, blobs, vectors}` 或 None。
        """
        if not simhash or not namespace or not lineage or not tag:
            return None
        target = self.repo(namespace)
        if not target:
            return None
        candidates = self.similar_lineages(
            simhash["path"], simhash["content"], lineage, tag,
            limit=MAX_ADOPT_CANDIDATES, algo=simhash.get("algo"), target_namespace=namespace,
        )
        for cand in candidates:
            overlap = self.adopt_overlap(namespace, cand["lineage"], tag)
            if overlap["overlap"] < ADOPT_MIN_OVERLAP:
                continue
            copied = self.adopt_hashes(cand["lineage"], lineage, overlap["hashes"], tag, namespace=namespace)
            if not copied["vectors"]:
                continue
            adopted = {
                "fromLineage": cand["lineage"],
                "fromRepo": cand.get("repoName") or cand.get("repoId") or cand.get("namespace"),
                "fromNamespace": cand.get("namespace"),
                "similarity": cand["similarity"],
                "pathSimilarity": cand["pathSimilarity"],
                "contentSimilarity": cand["contentSimilarity"],
                "overlap": overlap["overlap"],
                "blobs": copied["blobs"],
                "vectors": copied["vectors"],
                "hashes": copied["hashes"],
            }
            if copied.get("truncated"):
                adopted["truncated"] = True
            return adopted
        return None

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