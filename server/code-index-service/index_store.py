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
  last_seen integer not null,
  merged_into text,              -- 已被合并进的目标血统（观察期软标记，7 天后可 --hard 物理清理）
  merged_at integer              -- 合并发生时间（unix 秒）
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
  scope_kind text not null default 'main',
  scope_ref text,
  root_rel text,
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
-- 向量 CAS（内容寻址）：同一 (tag, hash) 全局只存一份向量负载，不带 lineage_id。
-- 主键取 (tag, hash) 复合而不是 hash 单列：tag（embedding 模型指纹）参与唯一性——
-- 同一内容哈希在不同模型下是不同向量，单列 hash pk 会把换模型期间的旧向量挤掉。
-- 代价：按 hash 单列检索吃不了主键前缀（实际没有这种查询；读写都带 tag）。
-- 旧 vectors 表保留，但 v2 迁移后降级为「血统→(tag,hash) 成员表」：v 列清空（负载唯一份在
-- v2），lineage 维度的语义（_missing / counts / adopt 成员判断 / gc）继续走它，保证兼容读。
create table if not exists vectors_v2 (
  tag text not null,
  hash text not null,
  dim integer not null,
  v blob not null,
  updated_at integer not null,
  primary key (tag, hash)
);
-- 服务端元数据键值表（schema 版本标记等；vectors_schema=cas 表示向量已完成 CAS 迁移）。
create table if not exists meta (
  key text primary key,
  value text
);
create table if not exists memories (
  id text primary key,
  repo text not null,
  lens text not null,
  what text not null,
  when_expr text,
  why text,
  evidence text,
  status text not null default 'active',
  source text not null default 'pipeline',
  stats_hits integer not null default 0,
  stats_adopted integer not null default 0,
  last_hit_at integer,
  created_at integer not null,
  updated_at integer not null,
  against_id text,               -- 冲突配对：与本条目冲突的另一条 id（可空；存量/单边为 NULL）
  trigger_words text             -- 冲突触发词对（json 数组，如 ["必须","无需"]；存于 conflicting 行上）
);
create index if not exists memories_repo_status on memories(repo, status);
create index if not exists memories_lens_status on memories(lens, status);
create index if not exists memories_status on memories(status);
create index if not exists memories_created on memories(created_at desc);
create index if not exists memories_against on memories(against_id);
-- 条目事件时间线：upsert/hit/adopt/resolve/软删/冲突配对各写一行（治理可见性，audit 用）
create table if not exists memory_events (
  id integer primary key autoincrement,
  memory_id text not null,
  at integer not null,
  event text not null,           -- created | updated | hit | adopted | conflicted | resolved | retired
  detail text                    -- JSON（触发词/来源/裁决方向等；可空）
);
create index if not exists memory_events_mid on memory_events(memory_id, at desc, id desc);
-- 治理跑批留痕：pipeline 每跑一次上报一行（候选/拦截/合并/四判计数 + 明细摘要）
create table if not exists pipeline_runs (
  id integer primary key autoincrement,
  run_id text not null,
  started_at integer not null,
  finished_at integer not null,
  engine text not null,
  dry_run integer not null default 0,
  candidates integer not null default 0,
  review_passed integer not null default 0,
  review_blocked integer not null default 0,
  dedup_kept integer not null default 0,
  dedup_merged integer not null default 0,
  actions text not null,         -- JSON：{create,update,skip,contradict} 计数
  details text                   -- JSON：拦截/合并/冲突明细（截断后的摘要，可空）
);
create index if not exists pipeline_runs_started on pipeline_runs(started_at desc);
create unique index if not exists pipeline_runs_run_id on pipeline_runs(run_id);
-- 全文索引：trigram 对 ASCII 子串与连续中文都按「原文子串」匹配，且 sqlite>=3.34 自带，
-- 与代码检索用的 tokenizer 语义对齐（免装 fts5 trigram 之外的扩展）。
create virtual table if not exists memories_fts using fts5(
  what, when_expr, why,
  tokenize='trigram'
);
create table if not exists memories_vec (
  mid integer primary key,
  dim integer not null,
  v blob not null,
  updated_at integer not null
);
"""

# ---------------------------------------------------------------- 作用域（档 3）
# 规则见 docs/scope-tier3.md §2；夹具 scope_format.json 是本文件的验收标准。
SCOPE_KINDS = ("main", "branch", "pr", "worktree")

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


def normalize_root(root):
    """把"索引根相对 git 顶层的路径"归一成命名空间里用的形式。

    规则（与插件 `lib/scope.js normalizeRoot()` 逐条一致）：
    - `None`/空/`.`/`/` → `""`（表示仓库根，不写 root 维度）；
    - 反斜杠统一成 `/`，去掉空段与 `./`；
    - 拒绝绝对路径（`/x`、`C:/x`）和 `..` 段 → ScopeFormatError('invalid-root')。

    为什么需要：同一个 git 仓库的子目录是**同一分支的另一个扫描根**，不是新快照；
    把根作为命名空间的一个维度（`~root:<sha8>`），子目录与仓库根才能并存且不混淆。
    """
    text = "" if root is None else str(root)
    text = text.strip().replace("\\", "/")
    if not text or text == "." or text == "./":
        return ""
    if text.startswith("/"):
        raise ScopeFormatError("invalid-root", f"root 必须是相对路径：{text!r}")
    parts = [p for p in text.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ScopeFormatError("invalid-root", f"root 不能包含 '..'：{text!r}")
    if parts and len(parts[0]) == 2 and parts[0][0].isalpha() and parts[0][1] == ":":
        raise ScopeFormatError("invalid-root", f"root 必须是相对路径：{text!r}")
    return "/".join(parts)


def root_token(root):
    """子目录根 → 8 位 sha1；仓库根返回 None（命名空间里不写 `~root:`）。"""
    rel = normalize_root(root)
    if not rel:
        return None
    return hashlib.sha1(rel.encode("utf-8")).hexdigest()[:8]


def canonical_namespace(repo_id, chunk_fp, kind, ref, root=None):
    """canonical_namespace(repoId, chunkFp, kind, ref, root=None)
    -> "{repoId}@{chunkFp}#{kind}:{refToken}[~root:{sha8}]"。

    - legacy 命名空间（不含 #）**不经过本函数**，原样保留（见 legacy_namespace()）；
    - `root` 为空 = 仓库根；非空 = 该仓库的某个子目录（同一 (repoId, kind, ref) 下允许并存，
      靠 `~root:<sha8>` 区分）。
    """
    repo_id = "" if repo_id is None else str(repo_id)
    chunk_fp = "" if chunk_fp is None else str(chunk_fp)
    if not _ID_RE.match(repo_id):
        raise ScopeFormatError("invalid-repo-id", f"repoId={repo_id!r}")
    if not _ID_RE.match(chunk_fp):
        raise ScopeFormatError("invalid-chunk-fp", f"chunkFp={chunk_fp!r}")
    if kind not in _TOKENS:
        raise ScopeFormatError("unknown-kind", f"kind={kind!r}")
    base = f"{repo_id}@{chunk_fp}#{_TOKENS[kind]}:{ref_token(kind, ref)}"
    rt = root_token(root)
    return f"{base}~root:{rt}" if rt else base


def legacy_namespace(namespace):
    """已废弃：不再支持 legacy 命名空间。不带 # 的 namespace 一律拒绝。"""
    ns = "" if namespace is None else str(namespace)
    raise ScopeFormatError(
        "legacy-not-supported",
        f"namespace 不含 #（旧格式已废弃）：{ns}；请用 canonical 格式 {{repoId}}@{{chunkFp}}#{{kind}}:{{ref}}",
    )


def parse_scope_namespace(namespace):
    """从 canonical namespace 反推 scope 元信息（不含 # 的旧格式返回 kind=None，调用方应拒绝）。

    返回 {kind, token, scope_ref, root}；scope_ref 按 §3 的列值口径：
    main -> "default"、branch -> token、pr -> token、worktree -> "wt:<sha8>"；
    root 是 `~root:<sha8>` 里的 sha8（仓库根为 None，无法反推相对路径）。
    """
    ns = "" if namespace is None else str(namespace)
    if "#" not in ns:
        return {"kind": None, "token": None, "scope_ref": None, "root": None}
    head, sep, root_hash = ns.partition("~root:")
    root = (root_hash or None) if sep else None
    _, _, tail = head.rpartition("#")
    prefix, _, token = tail.partition(":")
    kind = _TOKEN_KINDS.get(prefix)
    if not kind:
        return {"kind": None, "token": token or None, "scope_ref": None, "root": root}
    if kind == "worktree":
        scope_ref = f"wt:{token}" if token else None
    else:
        scope_ref = token or None
    return {"kind": kind, "token": token or None, "scope_ref": scope_ref, "root": root}


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


# ---------------------------------------------------------------- 向量 CAS 迁移（T-261120-dedup）
# 部署模型（2026-11-20 授权：历史数据可清理，不做运行时静默迁移）：
#   停写 → cleanup-lineages.py --db <index.db> --migrate-cas [--vacuum] → 起服务。
# 服务启动只认 v2（IndexStore.__init__ 的 gate）；旧 schema 直接 RuntimeError 报提示。
def cas_migrate_conn(db):
    """CAS 迁移核心（单事务 BEGIN IMMEDIATE），在给定连接上执行，幂等。

    ① 建表兜底（vectors_v2 / meta）；
    ② meta 无 `vectors_schema=cas` 时：旧表 (lineage,tag,hash) 行按 (tag,hash) 去重
       搬进 v2（REPLACE 语义 + ORDER BY updated_at，新者胜），然后清空旧 v 列——
       旧表降级为「血统→(tag,hash) 成员表」，兼容所有按血统的既有读路径；
    ③ meta 记 `vectors_schema=cas`，COMMIT。

    返回 `{migrated, cleared, v2Vectors, legacyMembershipRows}`；
    meta 已是 cas → migrated=False，只做建表兜底（跑两次结果一致）。
    """
    if db.in_transaction:
        db.commit()
    db.execute("begin immediate")
    try:
        db.execute(
            "create table if not exists vectors_v2 ("
            " tag text not null, hash text not null, dim integer not null, v blob not null,"
            " updated_at integer not null, primary key (tag, hash))"
        )
        db.execute("create table if not exists meta (key text primary key, value text)")
        state = db.execute("select value from meta where key = 'vectors_schema'").fetchone()
        migrated = False
        cleared = 0
        if state is None or (state["value"] or "") != "cas":
            db.execute(
                "insert or replace into vectors_v2(tag, hash, dim, v, updated_at)"
                " select tag, hash, dim, v, updated_at from vectors order by updated_at"
            )
            cur = db.execute("update vectors set v = '' where length(v) > 0")
            cleared = int(cur.rowcount or 0)
            db.execute(
                "insert or replace into meta(key, value) values ('vectors_schema', 'cas')"
            )
            migrated = True
        db.commit()
    except Exception:
        db.rollback()
        raise
    v2_total = int(db.execute("select count(*) as n from vectors_v2").fetchone()["n"])
    legacy_total = int(db.execute("select count(*) as n from vectors").fetchone()["n"])
    return {
        "migrated": migrated,
        "cleared": cleared,
        "v2Vectors": v2_total,
        "legacyMembershipRows": legacy_total,
    }


def cas_migrate_db(db_path, vacuum=False):
    """一次性显式迁移（部署脚本 `cleanup-lineages.py --migrate-cas` 用）。

    独立连接打开库文件执行 cas_migrate_conn，不动服务进程（建议停写后跑）。
    `vacuum=True` 顺带 VACUUM + checkpoint——迁移清空的旧 v 列释放的页先进
    freelist，文件真正缩小靠它。幂等，可重复执行。
    """
    db = sqlite3.connect(db_path, timeout=60)
    db.row_factory = sqlite3.Row
    try:
        out = cas_migrate_conn(db)
    finally:
        db.close()
    if vacuum:
        db = sqlite3.connect(db_path, timeout=60)
        try:
            db.execute("pragma wal_checkpoint(truncate)")
            db.execute("vacuum")
            db.commit()
            out["vacuumed"] = True
        except Exception as e:  # noqa: BLE001 —— 迁移已提交，vacuum 失败只报告
            out["vacuumError"] = f"{type(e).__name__}: {e}"
        finally:
            db.close()
    return out


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
        # 幂等迁移：历史库补齐列；TTL/pinned 列保留但不再读写。
        cols = {r["name"] for r in self.db.execute("pragma table_info(repos)").fetchall()}
        for name, ddl in (
            ("scope_kind", "text not null default 'main'"),
            ("scope_ref", "text"),
            ("root_rel", "text"),
            ("commit_sha", "text"),
            ("ttl_days", "integer"),
            ("expires_at", "integer"),
            ("pinned", "integer not null default 0"),
            ("created_at", "integer"),
            ("repo_name", "text"),
        ):
            if name not in cols:
                self.db.execute(f"alter table repos add column {name} {ddl}")
        if "repo_state_chunks" not in cols:
            self.db.execute("alter table repos add column repo_state_chunks integer")
        # P3 simhash：只增不删的幂等列（旧库启动自动补齐；旧客户端不写 → 保持 null）。
        for name, ddl in (
            ("simhash_path", "text"),
            ("simhash_content", "text"),
            ("simhash_algo", "text"),
            ("simhash_files", "integer"),
            ("simhash_at", "integer"),
        ):
            if name not in cols:
                self.db.execute(f"alter table repos add column {name} {ddl}")
        # memories 治理可见性列（旧库补齐；SCHEMA 已含新表 memory_events / pipeline_runs）：
        # against_id/trigger_words 由 MemoryStore.link_conflict 在冲突配对时双写。
        mem_cols = {r["name"] for r in self.db.execute("pragma table_info(memories)").fetchall()}
        for name, ddl in (
            ("against_id", "text"),
            ("trigger_words", "text"),
        ):
            if name not in mem_cols:
                self.db.execute(f"alter table memories add column {name} {ddl}")
        # lineages 合并软标记列（旧库补齐；merge 端点写，--hard 观察期后物理清理）。
        lin_cols = {r["name"] for r in self.db.execute("pragma table_info(lineages)").fetchall()}
        for name, ddl in (
            ("merged_into", "text"),
            ("merged_at", "integer"),
        ):
            if name not in lin_cols:
                self.db.execute(f"alter table lineages add column {name} {ddl}")
        self.db.commit()
        # 向量 CAS（v2）：服务只认已迁移的库（2026-11-20 授权：历史数据可清理，
        # 不做运行时静默迁移）。旧 schema（vectors 带真负载且 meta 未记 cas）→ 报错并
        # 提示先跑显式迁移脚本；空库直接落 cas 标记。
        state = self.db.execute("select value from meta where key = 'vectors_schema'").fetchone()
        if not state or (state["value"] or "") != "cas":
            payload = self.db.execute("select 1 from vectors where length(v) > 0 limit 1").fetchone()
            if payload:
                raise RuntimeError(
                    "vectors 仍是旧 schema（未做 CAS 迁移）。部署序：停写 → "
                    "python scripts/cleanup-lineages.py --db <index.db> --migrate-cas [--vacuum] → 重启服务。"
                    " 迁移把旧表 (lineage,tag,hash) 负载按 (tag,hash) 去重搬进 vectors_v2，"
                    "并清空旧 v 列（历史数据已授权清理）。")
            self.db.execute(
                "insert or replace into meta(key, value) values ('vectors_schema', 'cas')"
            )
            self.db.commit()
        # 废弃 legacy：删除旧格式作用域（scope_kind='legacy' 或 namespace 不含 #）及其 chunks。
        # blob/vector 按内容哈希共享，交给 janitor/retention 回收，不在这里删。
        legacy_rows = self.db.execute(
            "select namespace from repos where scope_kind = 'legacy' or namespace not like '%#%'"
        ).fetchall()
        if legacy_rows:
            for lr in legacy_rows:
                self.db.execute("delete from chunks where namespace = ?", (lr["namespace"],))
                self.db.execute("delete from repos where namespace = ?", (lr["namespace"],))
            self.db.commit()
            self._invalidate()
        self.db.execute("update repos set created_at = updated_at where created_at is null")
        self.db.commit()

    # ---------------------------------------------------------------- 血统 / 命名空间
    def ensure_lineage(self, url_norm, fallback_seed):
        lid = lineage_id_of(url_norm, fallback_seed)
        now = int(time.time())
        with self.lock:
            row = self.db.execute(
                "select id, merged_into from lineages where id = ?", (lid,)
            ).fetchone()
            # 合并观察期回退：该 id 的血统已被 merge 吸收 → 后续 sync 直接落在目标血统，
            # 不把旧血统复活（merged_into 链最多跟 8 跳防环）。
            hops = 0
            while row is not None and row["merged_into"] and hops < 8:
                nxt = self.db.execute(
                    "select id, merged_into from lineages where id = ?", (row["merged_into"],)
                ).fetchone()
                if nxt is None:
                    break
                row, lid, hops = nxt, nxt["id"], hops + 1
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
                # 行先按 namespace 反推 scope 元信息落库；带 scope 的同步随后由 register_scope() 校准。
                meta = parse_scope_namespace(namespace)
                kind = meta["kind"] or "main"
                self.db.execute(
                    "insert into repos(namespace, lineage_id, repo_id, repo_name, chunk_fp, revision, tag,"
                    " repo_state, repo_state_chunks, updated_at, scope_kind, scope_ref, commit_sha, created_at)"
                    " values (?,?,?,?,?,0,?,null,null,?,?,?,null,?)",
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
    def register_scope(self, namespace, kind, ref, commit_sha=None, scope_ref=None, root_rel=None):
        """写/更新 scope 元数据；作用域永久，不再计算 TTL/pin。

        `root_rel`：索引根相对 git 顶层的路径（仓库根传 None/空串）；
        命名空间里只带 `~root:<sha8>`，这里同时存一份可读路径供控制台展示。
        """
        now = int(time.time())
        kind = kind or "main"
        if kind not in SCOPE_KINDS:
            raise ScopeFormatError("unknown-kind", f"kind={kind!r}")
        if scope_ref is None:
            scope_ref = self._scope_ref_value(kind, ref)
        root_rel = normalize_root(root_rel) or None
        with self.lock:
            row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
            if row is None:
                repo_id, chunk_fp = namespace_identity(namespace)
                lineage = self.ensure_lineage("", repo_id or "unknown")
                self.db.execute(
                    "insert into repos(namespace, lineage_id, repo_id, chunk_fp, revision, tag, repo_state,"
                    " repo_state_chunks, updated_at, scope_kind, scope_ref, root_rel, commit_sha, created_at)"
                    " values (?,?,?,?,0,null,null,null,?,?,?,?,?,?)",
                    (namespace, lineage, repo_id or "unknown", chunk_fp or "default", now, kind, scope_ref,
                     root_rel, commit_sha, now),
                )
                self.db.commit()
                row = self.db.execute("select * from repos where namespace = ?", (namespace,)).fetchone()
            sets = ["scope_kind = ?", "scope_ref = ?", "updated_at = ?"]
            args = [kind, scope_ref, now]
            # root_rel 只在显式给了根时写（仓库根同步不写，避免把旧行已有值清掉）
            if root_rel:
                sets.append("root_rel = ?")
                args.append(root_rel)
            if commit_sha is not None:
                sets.append("commit_sha = ?")
                args.append(commit_sha)
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

    def bulk_delete_scopes(self, namespaces):
        """批量删除作用域；返回 deleted/failed/lineages，调用方统一做 GC。"""
        deleted = []
        failed = []
        lineages = []
        total_chunks = 0
        with self.lock:
            for raw in namespaces or []:
                ns = str(raw or "").strip()
                if not ns:
                    continue
                row = self.db.execute("select lineage_id from repos where namespace = ?", (ns,)).fetchone()
                if not row:
                    failed.append({"namespace": ns, "error": "not-found"})
                    continue
                try:
                    n = int(self.db.execute(
                        "select count(*) as n from chunks where namespace = ?", (ns,)
                    ).fetchone()["n"])
                    self.db.execute("delete from chunks where namespace = ?", (ns,))
                    self.db.execute("delete from repos where namespace = ?", (ns,))
                    total_chunks += n
                    deleted.append(ns)
                    lineage = row["lineage_id"]
                    if lineage and lineage not in lineages:
                        lineages.append(lineage)
                except Exception as e:  # noqa: BLE001
                    failed.append({"namespace": ns, "error": f"{type(e).__name__}: {e}"})
            self.db.commit()
            if deleted:
                self._invalidate()
        return {"deleted": deleted, "failed": failed, "lineages": lineages, "chunks": total_chunks}

    def scope_overview(self, repo_id=None, kind=None, limit=50):
        """overview() 的每一项再加 scope 元信息（给历史 /v1/scopes 与 /health）。"""
        where = []
        args = []
        if repo_id:
            where.append("r.repo_id = ?")
            args.append(repo_id)
        if kind:
            where.append("r.scope_kind = ?")
            args.append(kind)
        sql = (
            "select r.*, (select count(*) from chunks c where c.namespace = r.namespace) as chunks,"
            " (select url_norm from lineages l where l.id = r.lineage_id) as lineage_url"
            " from repos r"
        )
        if where:
            sql += " where " + " and ".join(where)
        sql += " order by r.updated_at desc limit ?"
        args.append(int(limit))
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item.update(self.counts(r["namespace"]))
            item.update(self.lineage_bytes(r["lineage_id"]))
            item["lineageUrl"] = r["lineage_url"] or ""
            item["scope"] = {
                "kind": r["scope_kind"] or "main",
                "ref": r["scope_ref"],
                "root": r["root_rel"],
                "commit": r["commit_sha"],
                "createdAt": r["created_at"],
            }
            out.append(item)
        return out

    def count_scopes(self):
        with self.lock:
            return int(self.db.execute("select count(*) as n from repos").fetchone()["n"])

    def _scope_where(self, repo_id=None, kind=None, q=None):
        where = []
        args = []
        if repo_id:
            where.append("r.repo_id = ?")
            args.append(str(repo_id))
        if kind:
            where.append("r.scope_kind = ?")
            args.append(str(kind))
        if q:
            needle = "%" + str(q).strip().lower() + "%"
            where.append("(lower(coalesce(r.repo_name,'')) like ? or lower(r.repo_id) like ?"
                         " or lower(r.namespace) like ? or lower(coalesce(r.scope_ref,'')) like ?"
                         " or lower(coalesce(r.root_rel,'')) like ?"
                         " or lower(r.chunk_fp) like ?)")
            args.extend([needle] * 6)
        return where, args

    def scope_page(self, repo_id=None, kind=None, q=None, sort="updated_at", order="desc",
                   limit=50, offset=0):
        """分页作用域列表 + 总数 + facets；只对当前页计算计数/占用。"""
        sort_map = {
            "updated_at": "r.updated_at",
            "created_at": "r.created_at",
            "repo_name": "coalesce(r.repo_name, r.repo_id)",
            "scope_kind": "r.scope_kind",
            "chunks": "chunks",
        }
        sort_col = sort_map.get(sort, sort_map["updated_at"])
        direction = "asc" if str(order).lower() == "asc" else "desc"
        where, args = self._scope_where(repo_id, kind, q)
        clause = (" where " + " and ".join(where)) if where else ""
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        count_sql = "select count(*) as n from repos r" + clause
        data_sql = (
            "select r.*, (select count(*) from chunks c where c.namespace = r.namespace) as chunks,"
            " (select url_norm from lineages l where l.id = r.lineage_id) as lineage_url"
            " from repos r" + clause + f" order by {sort_col} {direction}, r.namespace asc limit ? offset ?"
        )
        with self.lock:
            total = int(self.db.execute(count_sql, args).fetchone()["n"])
            rows = self.db.execute(data_sql, [*args, limit, offset]).fetchall()
            variant_rows = self.db.execute(
                "select repo_id, scope_kind, coalesce(scope_ref,'') as scope_ref, count(*) as n"
                " from repos group by repo_id, scope_kind, coalesce(scope_ref,'')"
            ).fetchall()
            repo_rows = self.db.execute(
                "select repo_id, coalesce(repo_name,'') as repo_name, count(*) as n"
                " from repos group by repo_id, coalesce(repo_name,'') order by n desc, repo_name asc"
            ).fetchall()
            kind_rows = self.db.execute(
                "select scope_kind, count(*) as n from repos group by scope_kind"
            ).fetchall()
            facets_repos = [
                {"repoId": r["repo_id"], "repoName": r["repo_name"] or r["repo_id"], "count": int(r["n"])}
                for r in repo_rows
            ]
            facets_kinds = {k: 0 for k in SCOPE_KINDS}
            for r in kind_rows:
                key = r["scope_kind"] or "main"
                facets_kinds[key] = facets_kinds.get(key, 0) + int(r["n"])
            variants = {
                (r["repo_id"], r["scope_kind"] or "main", r["scope_ref"] or ""): int(r["n"])
                for r in variant_rows
            }
            items = []
            for r in rows:
                item = dict(r)
                item.update(self.counts(r["namespace"]))
                item.update(self.lineage_bytes(r["lineage_id"]))
                item["files"] = int(self.db.execute(
                    "select count(distinct path) as n from chunks where namespace = ?", (r["namespace"],)
                ).fetchone()["n"])
                item["updatedAt"] = r["updated_at"]
                item["lineageUrl"] = r["lineage_url"] or ""
                item["variantCount"] = variants.get(
                    (r["repo_id"], r["scope_kind"] or "main", r["scope_ref"] or ""), 1
                )
                item["scope"] = {
                    "kind": r["scope_kind"] or "main",
                    "ref": r["scope_ref"],
                    "root": r["root_rel"],
                    "commit": r["commit_sha"],
                    "createdAt": r["created_at"],
                }
                items.append(item)
            # 重复身份检测：同一 repoName 出现多个 repoId 时，只有"有 git URL 的血统"是 canonical，
            # 其余标 duplicateIdentity（历史上读不到 origin 时回退成路径哈希会造成这种分裂）。
            id_rows = self.db.execute(
                "select r.repo_id, coalesce(r.repo_name, r.repo_id) as name,"
                " coalesce((select url_norm from lineages l where l.id = r.lineage_id), '') as url"
                " from repos r"
            ).fetchall()
            by_name = {}
            for r in id_rows:
                by_name.setdefault(r["name"], []).append((r["repo_id"], r["url"]))
            canonical = {}
            for name, lst in by_name.items():
                ids = {rid for rid, _ in lst}
                if len(ids) <= 1:
                    continue
                with_url = [rid for rid, url in lst if url]
                canonical[name] = with_url[0] if with_url else lst[0][0]
            for item in items:
                name = item.get("repo_name") or item["repo_id"]
                want = canonical.get(name)
                item["duplicateIdentity"] = bool(want) and item["repo_id"] != want
        return {
            "scopes": items,
            "total": total,
            "offset": offset,
            "limit": limit,
            "hasMore": offset + len(items) < total,
            "facets": {"repos": facets_repos, "kinds": facets_kinds},
        }

    def scope_stats(self):
        """全库作用域/块/向量/占用聚合（/health 与控制台概览）。"""
        hit = self._cache.get(("scopetotals",))
        if hit is not None:
            return dict(hit)
        with self.lock:
            total = int(self.db.execute("select count(*) as n from repos").fetchone()["n"])
            rows = self.db.execute("select scope_kind, count(*) as n from repos group by scope_kind").fetchall()
            by_kind = {k: 0 for k in SCOPE_KINDS}
            for r in rows:
                key = r["scope_kind"] or "main"
                by_kind[key] = by_kind.get(key, 0) + int(r["n"])
            chunks = int(self.db.execute("select count(*) as n from chunks").fetchone()["n"])
            vectors = int(self.db.execute(
                "select count(*) as n from chunks c join repos r on r.namespace = c.namespace"
                " join vectors v on v.lineage_id = c.lineage_id and v.tag = r.tag and v.hash = c.hash"
            ).fetchone()["n"])
            body_bytes = int(self.db.execute("select coalesce(sum(length(body)),0) as n from blobs").fetchone()["n"])
            # CAS 后向量负载唯一份在 v2（旧成员表 v 列已清空），体积按 v2 全局去重口径。
            vector_bytes = int(self.db.execute("select coalesce(sum(length(v)),0) as n from vectors_v2").fetchone()["n"])
        out = {
            "total": total,
            "byKind": by_kind,
            "chunks": chunks,
            "vectors": vectors,
            "coverage": round(vectors / chunks, 4) if chunks else 0.0,
            "totalBytes": body_bytes + vector_bytes,
            "bodyBytes": body_bytes,
            "vectorBytes": vector_bytes,
        }
        self._cache[("scopetotals",)] = out
        return dict(out)

    @staticmethod
    def _scope_ref_value(kind, ref):
        """§3 的 scope_ref 列口径：main:default / branch 原名 / pr:<iid> / wt:<sha8>。"""
        if kind == "main":
            return "default"
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
        """pairs: [(hash, np.ndarray)]

        CAS 双写：v2 存全局唯一负载（(tag,hash) 主键）；旧 vectors 表只记
        「该血统已完成此 (tag,hash) 的嵌入」成员关系，v 列写空串（负载不重复存）。
        lineage 参数保留在签名里：成员语义与 ensure_capacity / adopt 判断仍按血统走。
        """
        now = int(time.time())
        with self.lock:
            for h, vec in pairs:
                v = np.asarray(vec, dtype=np.float32)
                self.db.execute(
                    "insert or replace into vectors_v2(tag, hash, dim, v, updated_at) values (?,?,?,?,?)",
                    (tag, h, int(v.shape[0]), v.tobytes(), now),
                )
                self.db.execute(
                    "insert or replace into vectors(lineage_id, tag, hash, dim, v, updated_at) values (?,?,?,?,?,?)",
                    (lineage, tag, h, int(v.shape[0]), b"", now),
                )
            self.db.commit()
            self._invalidate()  # put_vectors 改了数据 → 计数/体积缓存失效

    def missing_bodies(self, namespace, tag, limit=64, order="spread"):
        return self.pending(namespace, tag, limit, order)

    # ---------------------------------------------------------------- 查询
    def matrix(self, namespace, tag):
        """返回 (hashes, matrix[float32, N×dim], meta{hash: (path,start,end)})。

        只读快照：调用方在锁外做点积，避免长时间占锁。

        CAS：向量负载在 vectors_v2（(tag,hash) 全局唯一），查询改为「namespace 的
        chunks → hash 集 → v2」，不再连血统。合并回退：旧 namespace 自己的 chunks
        被 merge 去重清空、但 repos 行还挂着（revision > 0）时，按血统读目标
        namespace 的块——这就是 merge 后旧 namespace 的「兼容读」路径。
        """
        with self.lock:
            rows = self.db.execute(
                "select c.hash, c.path, c.start, c.\"end\" as end, v.v, v.dim from chunks c"
                " join vectors_v2 v on v.tag = ? and v.hash = c.hash"
                " where c.namespace = ?",
                (tag, namespace),
            ).fetchall()
            if not rows:
                repo = self.db.execute(
                    "select lineage_id, revision from repos where namespace = ?", (namespace,)
                ).fetchone()
                if repo and int(repo["revision"] or 0) > 0:
                    rows = self.db.execute(
                        "select c.hash, c.path, c.start, c.\"end\" as end, v.v, v.dim from chunks c"
                        " join vectors_v2 v on v.tag = ? and v.hash = c.hash"
                        " where c.lineage_id = ?",
                        (tag, repo["lineage_id"]),
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
        """正文/向量占用。sum(length(...)) 在 16 万块上实测 0.5 s，同样必须缓存。

        CAS 后向量负载在 v2（全局）：vectorBytes 按「该血统 chunks 引用到的 hash」
        从 v2 归集——多血统共享同一份向量时不重复计数，数值即真实逻辑占用。
        """
        hit = self._cache.get(("bytes", lineage))
        if hit is not None:
            return dict(hit)
        with self.lock:
            b = self.db.execute("select coalesce(sum(length(body)),0) as n from blobs where lineage_id = ?", (lineage,)).fetchone()["n"]
            v = self.db.execute(
                "select coalesce(sum(length(v.v)),0) as n from vectors_v2 v"
                " where v.hash in (select hash from chunks where lineage_id = ?)",
                (lineage,),
            ).fetchone()["n"]
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

        CAS 后读 vectors_v2：条数/字节数是**全局去重后**的真实占用（旧表多血统
        重复行会把同一份向量计 N 次）。

        **必须缓存**：`sum(length(v))` 要扫全表（16 万行 ≈ 3 s），而 `/health` 每次都会调；
        不缓存会让后台首页每次刷新都卡 3 秒。写向量/清 tag 后 _invalidate() 自动失效。
        """
        hit = self._cache.get(("tagstats",))
        if hit is not None:
            return [dict(x) for x in hit]
        with self.lock:
            rows = self.db.execute(
                "select tag, count(*) as vectors, coalesce(sum(length(v)),0) as bytes"
                " from vectors_v2 group by tag order by vectors desc"
            ).fetchall()
        out = [{"tag": r["tag"], "vectors": int(r["vectors"]), "bytes": int(r["bytes"])} for r in rows]
        self._cache[("tagstats",)] = out
        return [dict(x) for x in out]

    def purge_tag_vectors(self, keep_tag=None, drop_tag=None):
        """删指定 tag 的向量，或保留 keep_tag 删其余所有 tag；返回 {deleted}。

        CAS：同时清 v2（负载）与旧 vectors（成员表），两者口径保持一致。
        """
        if drop_tag is None and keep_tag is None:
            raise ValueError("drop_tag 或 keep_tag 必须给一个")
        with self.lock:
            if drop_tag is not None:
                cur = self.db.execute("delete from vectors_v2 where tag = ?", (drop_tag,))
                self.db.execute("delete from vectors where tag = ?", (drop_tag,))
            else:
                cur = self.db.execute("delete from vectors_v2 where tag is null or tag != ?", (keep_tag,))
                self.db.execute("delete from vectors where tag is null or tag != ?", (keep_tag,))
            self.db.commit()
            self._invalidate()
            return {"deleted": int(cur.rowcount or 0), "keptTag": keep_tag, "droppedTag": drop_tag}

    def total_bytes(self):
        """全库正文+向量占用；同样要缓存（1.6GB 全扫），写操作后由 _invalidate() 失效。

        向量占用按 v2 全局去重口径统计（旧成员表 v 列已清空，不再重复计入）。
        """
        hit = self._cache.get(("totalbytes",))
        if hit is not None:
            return int(hit)
        with self.lock:
            b = self.db.execute("select coalesce(sum(length(body)),0) as n from blobs").fetchone()["n"]
            v = self.db.execute("select coalesce(sum(length(v)),0) as n from vectors_v2").fetchone()["n"]
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
    def gc(self, lineage):
        """删掉"血统内已无任何块引用"的 blob / vector（显式删除后立即回收）。"""
        with self.lock:
            live = set(self.hashes_in_lineage(lineage))
            dead_b = [
                r["hash"]
                for r in self.db.execute("select hash from blobs where lineage_id = ?", (lineage,)).fetchall()
                if r["hash"] not in live
            ]
            dead_v = [
                (r["tag"], r["hash"])
                for r in self.db.execute(
                    "select tag, hash from vectors where lineage_id = ?", (lineage,)
                ).fetchall()
                if r["hash"] not in live
            ]
            for h in dead_b:
                self.db.execute("delete from blobs where lineage_id = ? and hash = ?", (lineage, h))
            for tag, h in dead_v:
                self.db.execute("delete from vectors where lineage_id = ? and tag = ? and hash = ?", (lineage, tag, h))
            # CAS 负载回收：v2 行只有在**全库没有任何 chunks 行引用**该 hash 时才是孤儿。
            # 不能按血统删——vectors_v2 是全局内容寻址存储，别的血统可能正引用着。
            self.db.execute(
                "delete from vectors_v2 where not exists (select 1 from chunks c where c.hash = vectors_v2.hash)"
            )
            self.db.commit()
            self._invalidate()  # gc 改了数据 → 计数/体积缓存失效
        return {"blobs": len(dead_b), "vectors": len(dead_v)}

    def adopt(self, from_lineage, to_lineage, hashes=None):
        """显式跨血统借用（fork / vendor）：把源血统的 blob 与 vector 复制到目标血统。

        CAS：向量负载在 v2 全局共享，无需复制字节——这里按「源血统成员表有的 (tag,hash)」
        在 v2 确保存在（正常都已存在），并给目标血统补成员行（v=''）。blobs 仍按血统复制。
        """
        now = int(time.time())
        with self.lock:
            if hashes:
                q = ",".join("?" * len(hashes))
                b = self.db.execute(
                    f"select hash, body from blobs where lineage_id = ? and hash in ({q})", [from_lineage, *hashes]
                ).fetchall()
                v = self.db.execute(
                    f"select m.tag, m.hash, v2.dim, v2.v from vectors m"
                    f" join vectors_v2 v2 on v2.tag = m.tag and v2.hash = m.hash"
                    f" where m.lineage_id = ? and m.hash in ({q})",
                    [from_lineage, *hashes],
                ).fetchall()
            else:
                b = self.db.execute("select hash, body from blobs where lineage_id = ?", (from_lineage,)).fetchall()
                v = self.db.execute(
                    "select m.tag, m.hash, v2.dim, v2.v from vectors m"
                    " join vectors_v2 v2 on v2.tag = m.tag and v2.hash = m.hash"
                    " where m.lineage_id = ?",
                    (from_lineage,),
                ).fetchall()
            for r in b:
                self.db.execute(
                    "insert or ignore into blobs(lineage_id, hash, body, updated_at) values (?,?,?,?)",
                    (to_lineage, r["hash"], r["body"], now),
                )
            for r in v:
                # v2 幂等确保（同 (tag,hash) 内容一致）；成员表补目标血统的行（v 不再重复存）
                self.db.execute(
                    "insert or ignore into vectors_v2(tag, hash, dim, v, updated_at) values (?,?,?,?,?)",
                    (r["tag"], r["hash"], r["dim"], r["v"], now),
                )
                self.db.execute(
                    "insert or ignore into vectors(lineage_id, tag, hash, dim, v, updated_at) values (?,?,?,?,?,?)",
                    (to_lineage, r["tag"], r["hash"], r["dim"], b"", now),
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
                        f"select m.hash, v2.dim, v2.v from vectors m"
                        f" join vectors_v2 v2 on v2.tag = m.tag and v2.hash = m.hash"
                        f" where m.lineage_id = ? and m.tag = ? and m.hash in ({q})",
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
                    # CAS：v2 全局幂等确保负载；成员表补目标血统行（v 不再重复存）。
                    # inserted_vectors 记的是**成员表**实际新插入数（幂等语义与旧实现一致）。
                    cur = self.db.execute(
                        "insert or ignore into vectors_v2(tag, hash, dim, v, updated_at) values (?,?,?,?,?)",
                        (tag, h, vec["dim"], vec["v"], now),
                    )
                    cur = self.db.execute(
                        "insert or ignore into vectors(lineage_id, tag, hash, dim, v, updated_at)"
                        " values (?,?,?,?,?,?)",
                        (to_lineage, tag, h, vec["dim"], b"", now),
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

    # ---------------------------------------------------------------- 向量 CAS / 血统合并（T-261120-dedup）
    def cas_migrate(self, vacuum=False):
        """已打开的 store 上的幂等迁移入口（测试/诊断用）。

        部署期一次性迁移走模块级 `cas_migrate_db()`（独立连接，脚本 --migrate-cas）；
        服务启动不再自动迁移（__init__ 的 gate 只认 v2，旧 schema 报错提示）。
        `vacuum=True` 顺带 VACUUM + checkpoint 回收文件体积。
        """
        with self.lock:
            core = cas_migrate_conn(self.db)
            self._invalidate()
        out = {
            "schema": "cas",
            "v2Vectors": core["v2Vectors"],
            "legacyMembershipRows": core["legacyMembershipRows"],
            "legacyBlobRowsCleared": core["cleared"],
            "migrated": core["migrated"],
        }
        if vacuum:
            with self.lock:
                try:
                    self.db.execute("pragma wal_checkpoint(truncate)")
                    self.db.execute("vacuum")
                    out["vacuumed"] = True
                except Exception as e:  # noqa: BLE001 —— vacuum 失败不影响迁移结果
                    out["vacuumError"] = f"{type(e).__name__}: {e}"
        return out

    def cas_status(self):
        """当前向量存储形态（诊断 / 测试用，只读）。"""
        with self.lock:
            state = self.db.execute("select value from meta where key = 'vectors_schema'").fetchone()
            v2_total = int(self.db.execute("select count(*) as n from vectors_v2").fetchone()["n"])
            legacy_total = int(self.db.execute("select count(*) as n from vectors").fetchone()["n"])
        return {
            "schema": (state["value"] if state else None),
            "v2Vectors": v2_total,
            "legacyMembershipRows": legacy_total,
        }

    def lineage_resolve(self, token):
        """把 repoId / lineageId / namespace 解析成血统 id 集合（去重，保序）。

        - 精确命中 lineages.id → 就这一个；
        - 命中 repos.repo_id → 该 repoId 下所有血统（一个 repoId 裂成多个血统正是要合的对象）；
        - 命中 repos.namespace → 该 scope 的血统；
        - 都没命中 → ValueError（端点层转 400/404）。
        """
        token = str(token or "").strip()
        if not token:
            raise ValueError("empty lineage token")
        out = []
        seen = set()
        with self.lock:
            row = self.db.execute("select id from lineages where id = ?", (token,)).fetchone()
            if row:
                out.append(row["id"])
            else:
                for r in self.db.execute(
                    "select distinct lineage_id from repos where repo_id = ? order by lineage_id", (token,)
                ).fetchall():
                    if r["lineage_id"] and r["lineage_id"] not in seen:
                        out.append(r["lineage_id"])
                if not out:
                    row = self.db.execute(
                        "select lineage_id from repos where namespace = ?", (token,)
                    ).fetchone()
                    if row:
                        out.append(row["lineage_id"])
        if not out:
            raise ValueError(f"unknown lineage/repo/namespace: {token}")
        for x in out:
            seen.add(x)
        return out

    def lineage_merge(self, from_tokens, into_token):
        """把若干血统合并进目标血统（一次事务，BEGIN IMMEDIATE）。

        每个源血统依次执行：
          ① repos 行改挂靠：`update repos set lineage_id = into`（namespace 不动——
             旧 namespace 继续有效，客户端照常同步/检索，只是血统归一）；
          ② chunks：先把源血统的行改挂到 into，再按 (lineage_id, hash) 去重——
             源 namespace 里 hash 已存在于 into 侧的行直接删（保留目标行的
             path/start/end）；源独有的块保留；
          ③ blobs：源血统的正文 insert-or-ignore 搬进 into（目标缺的补上），
             然后删除源血统全部行（同 hash 同内容，纯冗余）；
          ④ vectors 旧成员表：源血统的 (tag,hash) 成员行搬进 into 后删除源行；
             v2 是全局内容寻址存储，无需删（本来就不带血统）；
          ⑤ lineages.merged_into/merged_at 记录软标记（旧血统行不物理删，观察期 7 天，
             过期后 lineage_hard_clean 物理清理）。

        返回 `{merged, from, into, dropped_chunks, dropped_vectors, dropped_blobs, freed_bytes}`。
        freed_bytes = 删除的 blob 正文字节 + 旧成员表 v 列字节 + 删除 chunk 行的 path 字节
        （v2 不变；文件体积实际回收要 VACUUM，见 cas_migrate）。
        """
        into_ids = self.lineage_resolve(into_token)
        if len(into_ids) != 1:
            raise ValueError(f"into 必须唯一解析成一个血统，得到 {len(into_ids)} 个：{into_token}")
        into = into_ids[0]
        # into 自身已被合并过 → 沿 merged_into 链落到最终目标（≤8 跳防环），
        # 否则数据会挂在一个「指向别处的空血统」上。
        hops = 0
        with self.lock:
            while hops < 8:
                row = self.db.execute(
                    "select merged_into from lineages where id = ?", (into,)
                ).fetchone()
                if row is None or not row["merged_into"]:
                    break
                into = row["merged_into"]
                hops += 1
        from_lineages = []
        for tok in from_tokens or []:
            for lid in self.lineage_resolve(tok):
                if lid != into and lid not in from_lineages:
                    from_lineages.append(lid)
        now = int(time.time())
        dropped_chunks = dropped_vectors = dropped_blobs = 0
        freed_bytes = 0
        merged = []
        with self.lock:
            if self.db.in_transaction:
                self.db.commit()
            self.db.execute("begin immediate")
            try:
                # 目标血统行必须存在（防御：namespace 反推可能在别处建过血统）
                if not self.db.execute("select 1 from lineages where id = ?", (into,)).fetchone():
                    raise ValueError(f"target lineage not found: {into}")
                for src in from_lineages:
                    # 已合并过的血统跳过（幂等；merged_into 链一并防环）
                    row = self.db.execute(
                        "select merged_into from lineages where id = ?", (src,)
                    ).fetchone()
                    if row is None:
                        continue
                    if (row["merged_into"] or ""):
                        merged.append({"from": src, "skipped": "already-merged", "into": row["merged_into"]})
                        continue
                    src_namespaces = [
                        r["namespace"]
                        for r in self.db.execute(
                            "select namespace from repos where lineage_id = ?", (src,)
                        ).fetchall()
                    ]
                    # ① repos 改挂靠（namespace 保留）
                    self.db.execute(
                        "update repos set lineage_id = ?, updated_at = ? where lineage_id = ?",
                        (into, now, src),
                    )
                    # ② chunks 改挂靠 + 按 (lineage, hash) 去重：源 namespace 行里
                    #    hash 已在 into 侧存在的直接删（保留目标行的 path/start/end）
                    self.db.execute(
                        "update chunks set lineage_id = ? where lineage_id = ?", (into, src)
                    )
                    if src_namespaces:
                        q = ",".join("?" * len(src_namespaces))
                        path_bytes = int(self.db.execute(
                            f"select coalesce(sum(length(path)),0) as n from chunks"
                            f" where lineage_id = ? and namespace in ({q})"
                            f" and hash in (select hash from chunks where lineage_id = ?"
                            f" and namespace not in ({q}))",
                            [into, *src_namespaces, into, *src_namespaces],
                        ).fetchone()["n"])
                        cur = self.db.execute(
                            f"delete from chunks where lineage_id = ? and namespace in ({q})"
                            f" and hash in (select hash from chunks where lineage_id = ?"
                            f" and namespace not in ({q}))",
                            [into, *src_namespaces, into, *src_namespaces],
                        )
                        dropped = int(cur.rowcount or 0)
                        dropped_chunks += dropped
                        freed_bytes += path_bytes
                    # ③ blobs：目标缺的补上，然后删源血统全部行（同 hash 同内容纯冗余）
                    blob_bytes = int(self.db.execute(
                        "select coalesce(sum(length(body)),0) as n from blobs where lineage_id = ?",
                        (src,),
                    ).fetchone()["n"])
                    self.db.execute(
                        "insert or ignore into blobs(lineage_id, hash, body, updated_at)"
                        " select ?, hash, body, updated_at from blobs where lineage_id = ?",
                        (into, src),
                    )
                    cur = self.db.execute("delete from blobs where lineage_id = ?", (src,))
                    dropped_blobs += int(cur.rowcount or 0)
                    freed_bytes += blob_bytes
                    # ④ 旧成员表：搬 (tag,hash) 成员行进 into（v 列已空，纯成员关系）
                    vec_bytes = int(self.db.execute(
                        "select coalesce(sum(length(v)),0) as n from vectors where lineage_id = ?",
                        (src,),
                    ).fetchone()["n"])
                    self.db.execute(
                        "insert or ignore into vectors(lineage_id, tag, hash, dim, v, updated_at)"
                        " select ?, tag, hash, dim, v, ? from vectors where lineage_id = ?",
                        (into, now, src),
                    )
                    cur = self.db.execute("delete from vectors where lineage_id = ?", (src,))
                    dropped_vectors += int(cur.rowcount or 0)
                    freed_bytes += vec_bytes
                    # ⑤ 软标记（不物理删，观察期）
                    self.db.execute(
                        "update lineages set merged_into = ?, merged_at = ? where id = ?",
                        (into, now, src),
                    )
                    merged.append({"from": src, "into": into, "namespaces": src_namespaces})
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise
            self._invalidate()
        return {
            "merged": merged,
            "from": from_lineages,
            "into": into,
            "droppedChunks": dropped_chunks,
            "droppedVectors": dropped_vectors,
            "droppedBlobs": dropped_blobs,
            "freedBytes": freed_bytes,
            "freedMb": round(freed_bytes / 1024 / 1024, 2),
        }

    def lineage_duplicates(self):
        """重复血统检测（只读，纯 SQL 聚合 + 内存分组）。

        按 repo_name（缺省回退 repo_id）分组；组内 ≥2 个未合并血统才算重复组；
        再按 chunk_fp 聚类——same_chunk_fp=true 表示组内共享同一 chunk 指纹（同内容仓库
        裂了多个血统，合并收益最大），false 表示同 repo 但内容指纹不同（合并需人工确认，
        bug-analysis 场景）。suggest = chunks 最大的那个（并列取 last_seen 新者）。
        每组附估算（estimates）：将删 chunk 行数 / 旧成员表向量行数 / 可释放字节
        （按 blob 平均大小 × 重复 blob 行 + 向量 v2 平均大小估算——成员表 v 已空）。
        """
        with self.lock:
            rows = self.db.execute(
                "select coalesce(nullif(r.repo_name,''), r.repo_id) as grp, r.repo_id,"
                " r.repo_name, r.namespace, r.lineage_id, r.chunk_fp,"
                " coalesce((select l.last_seen from lineages l where l.id = r.lineage_id), r.updated_at) as last_seen,"
                " coalesce((select l.merged_into from lineages l where l.id = r.lineage_id), '') as merged_into"
                " from repos r"
            ).fetchall()
            chunk_counts = {
                r["lineage_id"]: int(r["n"])
                for r in self.db.execute(
                    "select lineage_id, count(*) as n from chunks group by lineage_id"
                ).fetchall()
            }
            avg_blob = self.db.execute(
                "select coalesce(avg(length(body)),0) as n from blobs"
            ).fetchone()["n"]
            avg_vec = self.db.execute(
                "select coalesce(avg(length(v)),0) as n from vectors_v2"
            ).fetchone()["n"]
        groups = {}
        for r in rows:
            groups.setdefault(r["grp"], []).append(r)
        out = []
        for grp, lst in groups.items():
            live = [r for r in lst if not r["merged_into"]]
            lids = []
            for r in live:
                if r["lineage_id"] not in lids:
                    lids.append(r["lineage_id"])
            if len(lids) < 2:
                continue
            by_lid = {}
            for r in live:
                by_lid.setdefault(r["lineage_id"], {
                    "id": r["lineage_id"],
                    "repoId": r["repo_id"],
                    "repoIds": [],
                    "namespaces": [],
                    "chunkFps": [],
                    "chunks": 0,
                    "lastSeen": 0,
                })
                item = by_lid[r["lineage_id"]]
                if r["repo_id"] not in item["repoIds"]:
                    item["repoIds"].append(r["repo_id"])
                if r["namespace"] not in item["namespaces"]:
                    item["namespaces"].append(r["namespace"])
                if r["chunk_fp"] not in item["chunkFps"]:
                    item["chunkFps"].append(r["chunk_fp"])
                item["lastSeen"] = max(item["lastSeen"], int(r["last_seen"] or 0))
            lineages = []
            for lid in lids:
                item = by_lid[lid]
                item["chunks"] = int(chunk_counts.get(lid, 0))
                lineages.append(item)
            suggest = max(
                lineages,
                key=lambda x: (x["chunks"], x["lastSeen"]),
            )
            # 估算：每个非建议血统里，hash 已存在于建议血统的 chunk 行是纯冗余；
            # blobs/vectors 成员行同理按行数 × 平均大小估释放字节。
            sugg_hashes_q = (
                "select count(*) as n from chunks c where c.lineage_id = ?"
                " and c.hash in (select hash from chunks where lineage_id = ?)"
            )
            est_chunks = est_vectors = est_blobs = 0
            for item in lineages:
                if item["id"] == suggest["id"]:
                    continue
                est_chunks += int(self.db.execute(
                    sugg_hashes_q, (item["id"], suggest["id"])
                ).fetchone()["n"])
                est_vectors += int(self.db.execute(
                    "select count(*) as n from vectors m where m.lineage_id = ?"
                    " and exists (select 1 from vectors m2 where m2.lineage_id = ?"
                    " and m2.tag = m.tag and m2.hash = m.hash)",
                    (item["id"], suggest["id"]),
                ).fetchone()["n"])
                est_blobs += int(self.db.execute(
                    "select count(*) as n from blobs b where b.lineage_id = ?"
                    " and b.hash in (select hash from blobs where lineage_id = ?)",
                    (item["id"], suggest["id"]),
                ).fetchone()["n"])
            chunk_fps = sorted({fp for item in lineages for fp in item["chunkFps"]})
            out.append({
                "repoName": grp,
                "lineages": [
                    {
                        "id": item["id"], "repoId": item["repoId"], "repoIds": item["repoIds"],
                        "namespaces": item["namespaces"], "chunks": item["chunks"],
                        "last_seen": item["lastSeen"], "chunk_fps": item["chunkFps"],
                    }
                    for item in lineages
                ],
                "suggest": f"merge into {suggest['id']}",
                "suggestId": suggest["id"],
                "same_chunk_fp": len(chunk_fps) == 1,
                "chunkFps": chunk_fps,
                "estimates": {
                    "droppedChunks": est_chunks,
                    "droppedVectors": est_vectors,
                    "droppedBlobs": est_blobs,
                    "freedBytes": int(est_blobs * avg_blob),
                    "freedMb": round(est_blobs * avg_blob / 1024 / 1024, 2),
                },
            })
        out.sort(key=lambda g: (-max(x["chunks"] for x in g["lineages"]), g["repoName"]))
        return {"groups": out, "generatedAt": int(time.time())}

    def lineage_hard_clean(self, min_age_days=7, force=False):
        """观察期物理清理：删 merged_into 已置、且 merged_at 超过 min_age_days 的血统行。

        只删 lineages 行与其残留数据（merge 正常不应有残留，防御性兜底）；
        不动 repos/chunks/vectors_v2——它们在 merge 时已归到目标血统名下。
        force=True 无视观察期。返回 {removed: [...], removedCount}。
        """
        min_age_days = int(min_age_days or 7)
        cutoff = int(time.time()) - min_age_days * 86400
        removed = []
        with self.lock:
            if force:
                rows = self.db.execute(
                    "select id from lineages where merged_into is not null"
                ).fetchall()
            else:
                rows = self.db.execute(
                    "select id from lineages where merged_into is not null"
                    " and coalesce(merged_at, 0) <= ?",
                    (cutoff,),
                ).fetchall()
            for r in rows:
                lid = r["id"]
                # 防御兜底：merge 后不应再有挂在该血统上的行，有则一并清
                self.db.execute("delete from chunks where lineage_id = ?", (lid,))
                self.db.execute("delete from blobs where lineage_id = ?", (lid,))
                self.db.execute("delete from vectors where lineage_id = ?", (lid,))
                self.db.execute("delete from lineages where id = ?", (lid,))
                removed.append(lid)
            self.db.commit()
            self._invalidate()
        return {"removed": removed, "removedCount": len(removed)}

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


# ---------------------------------------------------------------- 经验资产（memories）
# 契约见 docs/memories.md：经验（"在什么仓库/镜头下、何时、做什么、为什么"）是独立于
# 代码块的资产，生命周期与作用域快照无关（scope 删除不应连带删经验），因此表挂在
# IndexStore 同一个 SQLite 文件里（一套 WAL/备份/迁移机制），但由 MemoryStore 自己管理。

MEMORY_STATUSES = ("active", "retired", "conflicting")
_MEMORY_ID_RE = re.compile(r"^exp-\d{6}$")
_MEMORY_MAX_TEXT = 8000          # 单字段字符上限（what/when_expr/why 与代码块正文同量级）
MEMORY_LIST_MAX_LIMIT = 200      # 列表分页上限
MEMORY_SEARCH_MAX_TOPK = 20      # search top_k 上限


def _mem_clean_text(value, field):
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} required")
    return text[:_MEMORY_MAX_TEXT]


class MemoryStore:
    """memories / memories_fts / memories_vec 的读写与混合检索。

    - id：`exp-` + 6 位十进制自增（首个 exp-000001），达到 999999 后继续加位数
      （exp-1000000），测试与服务都不会因此失败；
    - FTS：memories_fts(what, when_expr, why)，trigram 分词 → 中文连续段/英文子串
      都按「原文包含」匹配；查询侧由 `_fts_match_expr` 统一加引号防注入；
    - 向量：memories_vec(mid, dim, v) 同步写（经验量小，不走 governor），
      检索时全量读出暴力点积（L2 归一化后 = cosine），条目多后可换索引结构；
    - 融合：与代码检索同法的 RRF（k=20，server.RRF_K），`rrf = 1/(20+rank)` 按名次相加。
    """

    def __init__(self, db):
        # db 可以是现成连接（测试直连 store.db 用）或库文件路径。
        # 生产路径必须传**路径**：与 IndexStore 共用一条连接时，IndexStore 自己的写路径
        # （governor 嵌入/sync）不持本类的锁，两路事务在同一条连接上交错会抛
        # "cannot start a transaction within a transaction" → HTTP 500（admin 并发实测触发）。
        # 独立连接后并发由 SQLite 文件锁 + timeout 兜底，表级操作仍受 self.lock 串行。
        if isinstance(db, str):
            self.db = sqlite3.connect(db, check_same_thread=False, timeout=30)
            # IndexStore 的连接带 row_factory=Row，这里必须对齐——
            # 类内大量 row["列名"] 取值，默认 tuple 工厂会直接 TypeError（并发烟测实测）。
            self.db.row_factory = sqlite3.Row
            self._owns_conn = True
        else:
            self.db = db  # 与调用方共用连接（由各方法加锁）
            self._owns_conn = False
        self.lock = threading.RLock()

    def close(self):
        """释放自持连接（传入连接的实例不负责关闭）。"""
        if self._owns_conn:
            try:
                self.db.close()
            except Exception:
                pass

    # ------------------------------------------------------------ id / 行工具
    def _next_id(self):
        # 单线程调用方已持 self.lock；max(len(id)) 取最大数字后缀（含跨位数）。
        row = self.db.execute(
            "select id from memories where length(id) = (select max(length(id)) from memories)"
            " order by cast(substr(id, 5) as integer) desc limit 1"
        ).fetchone()
        seq = int(row["id"][4:]) + 1 if row else 1
        return f"exp-{seq:06d}"

    @staticmethod
    def _row_to_memory(row, with_stats=True):
        try:
            evidence = json.loads(row["evidence"]) if row["evidence"] else []
        except (TypeError, ValueError):
            evidence = []
        if not isinstance(evidence, list):
            evidence = []
        try:
            trigger_words = json.loads(row["trigger_words"]) if row["trigger_words"] else None
        except (TypeError, ValueError, IndexError):
            trigger_words = None
        if not isinstance(trigger_words, list):
            trigger_words = None
        item = {
            "id": row["id"],
            "repo": row["repo"],
            "lens": row["lens"],
            "what": row["what"],
            "when_expr": row["when_expr"] or "",
            "why": row["why"] or "",
            "evidence": evidence,
            "status": row["status"],
            "source": row["source"] or "pipeline",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        if "against_id" in row.keys() and row["against_id"]:
            item["against_id"] = row["against_id"]
        if trigger_words is not None:
            item["trigger_words"] = trigger_words
        if with_stats:
            item.update({
                "stats_hits": int(row["stats_hits"] or 0),
                "stats_adopted": int(row["stats_adopted"] or 0),
                "last_hit_at": row["last_hit_at"],
            })
        return item

    def get(self, memory_id, with_stats=True):
        # RLock：读也上锁——HTTP 多线程共享一条连接，无锁读会与写事务交错（并发实测 500）
        with self.lock:
            row = self.db.execute("select * from memories where id = ?", (memory_id,)).fetchone()
            return self._row_to_memory(row, with_stats) if row else None

    # ------------------------------------------------------------ 事件时间线
    def record_event(self, memory_id, event, detail=None, at=None):
        """写一条 memory_events（best-effort：失败不拖垮主流程，返回是否成功）。

        event ∈ created | updated | hit | adopted | conflicted | resolved | retired。
        """
        try:
            with self.lock:  # 调用方多为已持锁（RLock 可重入）；旁路直调也安全
                self.db.execute(
                    "insert into memory_events(memory_id, at, event, detail) values (?,?,?,?)",
                    (memory_id, int(at if at is not None else time.time()), str(event or "")[:32],
                     json.dumps(detail, ensure_ascii=False) if detail is not None else None),
                )
                self.db.commit()
            return True
        except Exception:  # noqa: BLE001 —— 时间线是旁路观测，不能挡业务写
            return False

    def timeline(self, memory_id):
        """组装条目事件时间线（时间倒序）。

        真实事件来自 memory_events；存量数据没有事件时用 created_at / updated_at /
        stats_* 推一条合成 timeline（synthesized 标注），保证老条目 timeline 不为空。
        返回 None 表示条目不存在。
        """
        with self.lock:
            row = self.db.execute("select * from memories where id = ?", (memory_id,)).fetchone()
            if not row:
                return None
            events = []
            for r in self.db.execute(
                "select at, event, detail from memory_events where memory_id = ?"
                " order by at desc, id desc", (memory_id,)
            ).fetchall():
                try:
                    detail = json.loads(r["detail"]) if r["detail"] else None
                except (TypeError, ValueError):
                    detail = None
                item = {"event": r["event"], "at": int(r["at"])}
                if detail is not None:
                    item["detail"] = detail
                events.append(item)
        if not events:
            # 合成：created（必）+ adopted（若有采纳）+ hit（last_hit_at，若有）
            synthesized = []
            if row["created_at"]:
                synthesized.append({"event": "created", "at": int(row["created_at"]),
                                    "detail": {"synthesized": True}})
            adopted = int(row["stats_adopted"] or 0)
            if adopted:
                synthesized.append({"event": "adopted",
                                    "at": int(row["last_hit_at"] or row["updated_at"]),
                                    "detail": {"count": adopted, "synthesized": True}})
            elif row["last_hit_at"]:
                synthesized.append({"event": "hit", "at": int(row["last_hit_at"]),
                                    "detail": {"synthesized": True}})
            events = sorted(synthesized, key=lambda e: -e["at"])
        return events

    # ------------------------------------------------------------ upsert
    def upsert(self, repo, lens, what, when_expr, why, evidence, source, status):
        """创建或更新一条经验（幂等：重复提交同一条返回 action=updated，不产生新行）。

        返回 (payload, action)。向量嵌入在 server 层做（需要 embedder 会话）。
        """
        repo = str(repo or "").strip()
        lens = str(lens or "").strip()
        if not repo or not lens:
            raise ValueError("repo required" if not repo else "lens required")
        what = _mem_clean_text(what, "what")
        when_expr = str(when_expr or "").strip()[:_MEMORY_MAX_TEXT]
        why = str(why or "").strip()[:_MEMORY_MAX_TEXT]
        if not isinstance(evidence, list):
            raise ValueError("evidence must be an array of {archive_ref|issue|mr}")
        for ev in evidence:
            if not isinstance(ev, dict) or not any(
                str(ev.get(k) or "").strip() for k in ("archive_ref", "issue", "mr")
            ):
                raise ValueError("evidence item must carry archive_ref / issue / mr")
        source = str(source or "").strip() or "pipeline"
        if status not in MEMORY_STATUSES:
            raise ValueError("status must be one of active / retired / conflicting")
        now = int(time.time())
        with self.lock:
            existing = self.db.execute(
                "select id from memories where repo = ? and lens = ? and what = ?",
                (repo, lens, what),
            ).fetchone()
            if existing:
                mid_id, is_new = existing["id"], False
                self.db.execute(
                    "update memories set when_expr = ?, why = ?, evidence = ?, source = ?,"
                    " status = ?, updated_at = ? where id = ?",
                    (when_expr, why, json.dumps(evidence, ensure_ascii=False), source, status, now, mid_id),
                )
            else:
                mid_id, is_new = self._next_id(), True
                self.db.execute(
                    "insert into memories(id, repo, lens, what, when_expr, why, evidence, status,"
                    " source, stats_hits, stats_adopted, last_hit_at, created_at, updated_at)"
                    " values (?,?,?,?,?,?,?,?,?,0,0,null,?,?)",
                    (mid_id, repo, lens, what, when_expr, why,
                     json.dumps(evidence, ensure_ascii=False), status, source, now, now),
                )
                mid = self._rowid(mid_id)
                self.db.execute(
                    "insert into memories_fts(rowid, what, when_expr, why) values (?,?,?,?)",
                    (mid, what, when_expr, why),
                )
            self.db.commit()
        # 时间线旁路：created/updated 各留一行（失败不影响主流程）
        self.record_event(mid_id, "created" if is_new else "updated",
                          {"repo": repo, "lens": lens, "status": status})
        return {"id": mid_id}, ("created" if is_new else "updated")

    def _rowid(self, memory_id):
        return int(self.db.execute(
            "select rowid from memories where id = ?", (memory_id,)
        ).fetchone()[0])

    def put_vector(self, memory_id, vec, dim):
        """同步嵌入向量（float32 blob）。经验量小：每次 upsert 一条，直接写。"""
        v = np.asarray(vec, dtype=np.float32).reshape(-1)
        now = int(time.time())
        with self.lock:
            mid = self._rowid(memory_id)
            self.db.execute(
                "insert into memories_vec(mid, dim, v, updated_at) values (?,?,?,?)"
                " on conflict(mid) do update set dim = excluded.dim, v = excluded.v,"
                " updated_at = excluded.updated_at",
                (mid, int(dim), v.tobytes(order="C"), now),
            )
            self.db.commit()

    def set_status(self, memory_id, status):
        """软删（retired）/ 恢复（active）/ 标记冲突（conflicting）的统一入口。"""
        if status not in MEMORY_STATUSES:
            raise ValueError("status must be one of active / retired / conflicting")
        with self.lock:
            cur = self.db.execute(
                "update memories set status = ?, updated_at = ? where id = ?",
                (status, int(time.time()), memory_id),
            )
            self.db.commit()
            ok = cur.rowcount > 0
        if ok:
            # 时间线旁路：retired/conflicted 记本名；resolve 回 active 记 resolved
            self.record_event(memory_id, status if status != "active" else "resolved",
                              {"status": status})
        return ok

    def record_hit(self, memory_id, adopted=False):
        with self.lock:
            cur = self.db.execute(
                "update memories set stats_hits = stats_hits + 1,"
                " stats_adopted = stats_adopted + ?, last_hit_at = ? where id = ?",
                (1 if adopted else 0, int(time.time()), memory_id),
            )
            self.db.commit()
            if cur.rowcount == 0:
                return None
            row = self.db.execute(
                "select stats_hits, stats_adopted from memories where id = ?", (memory_id,)
            ).fetchone()
        self.record_event(memory_id, "adopted" if adopted else "hit",
                          {"stats_hits": int(row["stats_hits"])})
        return {"stats_hits": int(row["stats_hits"]), "stats_adopted": int(row["stats_adopted"])}

    def link_conflict(self, conflicting_id, origin_id, trigger_words=None):
        """冲突配对双写：把 conflicting 条目与原条目互相指（against_id），并记触发词对。

        - trigger_words 存在 conflicting 条目行上（json 列），原条目不存（它可能已是
          active 的正常经验，配对信息由 conflicting 侧携带）；
        - 双方各写一条 conflicted 事件进 memory_events；
        - 返回 (ok, against)：against 是原条目摘要（conflicting 视角的对手）。
        """
        if conflicting_id == origin_id:
            return False, None
        trigger_json = None
        if isinstance(trigger_words, (list, tuple)) and trigger_words:
            trigger_json = json.dumps([str(t)[:64] for t in trigger_words[:16]], ensure_ascii=False)
        with self.lock:
            origin = self.db.execute(
                "select * from memories where id = ?", (origin_id,)
            ).fetchone()
            if not origin:
                return False, None
            now = int(time.time())
            self.db.execute(
                "update memories set against_id = ?, trigger_words = ?, updated_at = ?"
                " where id = ?",
                (origin_id, trigger_json, now, conflicting_id),
            )
            self.db.execute(
                "update memories set against_id = ?, updated_at = ? where id = ?",
                (conflicting_id, now, origin_id),
            )
            self.db.commit()
            row = self.db.execute(
                "select * from memories where id = ?", (conflicting_id,)
            ).fetchone()
            against = self._row_to_memory(origin, with_stats=False) if row else None
        self.record_event(conflicting_id, "conflicted",
                          {"against": origin_id, "trigger_words": trigger_words or []})
        self.record_event(origin_id, "conflicted",
                          {"against": conflicting_id, "peer": True})
        return True, against

    # ------------------------------------------------------------ 查询
    def list(self, repo=None, lens=None, status=None, q=None, limit=50, offset=0,
             stale_days=None):
        """过滤 + 分页；stale_days 给定时只看 active 且超过 N 天未命中（或从未命中）。

        stale 语义（治理可见性）：`last_hit_at IS NULL OR last_hit_at < now - N*86400`，
        用于 admin「陈旧经验」盘点（长期没人用的条目该复盘/退役）。
        """
        where, params = [], []
        if repo:
            where.append("repo = ?")
            params.append(repo)
        if lens:
            where.append("lens = ?")
            params.append(lens)
        if status:
            where.append("status = ?")
            params.append(status)
        if q:
            where.append("(what like ? or when_expr like ? or why like ?)")
            params.extend([f"%{q}%"] * 3)
        if stale_days is not None and stale_days > 0:
            where.append("status = 'active' and (last_hit_at is null or last_hit_at < ?)")
            params.append(int(time.time()) - int(stale_days) * 86400)
        cond = (" where " + " and ".join(where)) if where else ""
        with self.lock:
            total = self.db.execute(
                "select count(*) from memories" + cond, params
            ).fetchone()[0]
            rows = self.db.execute(
                "select * from memories" + cond + " order by created_at desc, id desc limit ? offset ?",
                params + [int(limit), int(offset)],
            ).fetchall()
        return {"items": [self._row_to_memory(r) for r in rows], "total": int(total)}

    def conflicting(self, limit=100, offset=0):
        """conflicting 队列，join 出 against（配对的原条目全文）与 trigger_words。"""
        with self.lock:
            total = self.db.execute(
                "select count(*) from memories where status = 'conflicting'"
            ).fetchone()[0]
            rows = self.db.execute(
                "select * from memories where status = 'conflicting'"
                " order by updated_at desc limit ? offset ?",
                (int(limit), int(offset)),
            ).fetchall()
            items = []
            for r in rows:
                item = self._row_to_memory(r)
                against_id = r["against_id"] if "against_id" in r.keys() else None
                if against_id:
                    origin = self.db.execute(
                        "select * from memories where id = ?", (against_id,)
                    ).fetchone()
                    if origin:
                        item["against"] = {
                            k: self._row_to_memory(origin, with_stats=False)[k]
                            for k in ("id", "what", "when_expr", "why")
                        }
                items.append(item)
        return {"items": items, "total": int(total)}

    # ------------------------------------------------------------ 跑批留痕（pipeline_runs）
    def record_run(self, payload):
        """POST /v1/admin/pipeline-runs：落一行跑批记录。run_id 重复时以最新为准（覆盖）。"""
        run_id = str(payload.get("run_id") or "").strip()
        if not run_id:
            raise ValueError("run_id required")
        started_at = payload.get("started_at")
        finished_at = payload.get("finished_at")
        now = int(time.time())
        try:
            started_at = now if started_at in (None, "") else int(started_at)
            finished_at = now if finished_at in (None, "") else int(finished_at)
        except (TypeError, ValueError):
            raise ValueError("started_at/finished_at must be unix seconds")
        actions = payload.get("actions")
        if not isinstance(actions, dict):
            actions = {}
        details = payload.get("details")
        if not isinstance(details, (dict, list)):
            details = None

        def _n(key):
            try:
                return max(0, int(payload.get(key) or 0))
            except (TypeError, ValueError):
                return 0

        with self.lock:
            self.db.execute(
                "insert into pipeline_runs(run_id, started_at, finished_at, engine, dry_run,"
                " candidates, review_passed, review_blocked, dedup_kept, dedup_merged,"
                " actions, details) values (?,?,?,?,?,?,?,?,?,?,?,?)"
                " on conflict(run_id) do update set"
                " started_at=excluded.started_at, finished_at=excluded.finished_at,"
                " engine=excluded.engine, dry_run=excluded.dry_run,"
                " candidates=excluded.candidates, review_passed=excluded.review_passed,"
                " review_blocked=excluded.review_blocked, dedup_kept=excluded.dedup_kept,"
                " dedup_merged=excluded.dedup_merged, actions=excluded.actions,"
                " details=excluded.details",
                (run_id, started_at, finished_at,
                 str(payload.get("engine") or "")[:64], 1 if payload.get("dry_run") else 0,
                 _n("candidates"), _n("review_passed"), _n("review_blocked"),
                 _n("dedup_kept"), _n("dedup_merged"),
                 json.dumps(actions, ensure_ascii=False)[:60000],
                 json.dumps(details, ensure_ascii=False)[:60000] if details is not None else None),
            )
            self.db.commit()
            row = self.db.execute(
                "select * from pipeline_runs where run_id = ?", (run_id,)
            ).fetchone()
        return self._row_to_run(row)

    @staticmethod
    def _row_to_run(row):
        try:
            actions = json.loads(row["actions"]) if row["actions"] else {}
        except (TypeError, ValueError):
            actions = {}
        try:
            details = json.loads(row["details"]) if row["details"] else None
        except (TypeError, ValueError):
            details = None
        return {
            "id": int(row["id"]),
            "run_id": row["run_id"],
            "started_at": int(row["started_at"]),
            "finished_at": int(row["finished_at"]),
            "engine": row["engine"],
            "dry_run": bool(row["dry_run"]),
            "candidates": int(row["candidates"]),
            "review_passed": int(row["review_passed"]),
            "review_blocked": int(row["review_blocked"]),
            "dedup_kept": int(row["dedup_kept"]),
            "dedup_merged": int(row["dedup_merged"]),
            "actions": actions,
            "details": details,
        }

    def list_runs(self, limit=20, offset=0):
        """GET /v1/admin/pipeline-runs：按 started_at 倒序。"""
        with self.lock:
            total = self.db.execute("select count(*) from pipeline_runs").fetchone()[0]
            rows = self.db.execute(
                "select * from pipeline_runs order by started_at desc, id desc limit ? offset ?",
                (int(limit), int(offset)),
            ).fetchall()
        return {"items": [self._row_to_run(r) for r in rows], "total": int(total)}

    # ------------------------------------------------------------ 混合检索
    @staticmethod
    def _fts_match_expr(q):
        """把用户查询转成安全的 FTS MATCH 表达式（全部短语化，杜绝语法注入）。

        trigram 分词下：ASCII 与连续中文都按「原文子串」匹配。空查询返回 None（跳过 FTS）。
        """
        tokens = [t for t in (x.strip() for x in re.split(r"\s+", str(q or ""))) if t]
        return " ".join(f'"{t}"' for t in tokens) or None

    def search_fts(self, match_expr, repo=None, lens=None, status="active", limit=None):
        """FTS5 通道：按名次返回 [(id, bm25)]。短语化表达式保证安全。

        status=None 时不过滤状态（检索语义：active+conflicting，conflicting 由
        search 层加 conflictWarning 标注——Memanto 模型：冲突双方保持可召回）。
        status=True（哨兵）→ active+conflicting；False/其它字符串按原语义单状态。
        """
        sql = (
            "select m.id, rank from memories m join memories_fts f on f.rowid = m.rowid"
            " where memories_fts match ?"
        )
        params = [match_expr]
        if status is True:
            # 哨兵 True：检索口径（active + conflicting，retired 仍不可见）
            sql += " and m.status in ('active','conflicting')"
        elif status:
            sql += " and m.status = ?"
            params.append(status)
        if repo:
            sql += " and m.repo = ?"
            params.append(repo)
        if lens:
            sql += " and m.lens = ?"
            params.append(lens)
        sql += " order by rank limit ?"
        params.append(int(limit) if limit else 1000)
        return [(r["id"], float(r["rank"])) for r in self.db.execute(sql, params)]

    def _vec_matrix(self, repo=None, lens=None, status="active", dim=None):
        """读出 (ids, matrix)：经验量小，直接全量载入暴力点积。

        dim 给定时只取同维向量（模型热切换后库内可能混维，异维行直接跳过，
        vstack 才不会崩；查询侧由 search 传当前 embedder 的维度）。
        """
        sql = (
            "select m.id, mv.dim, mv.v from memories m join memories_vec mv on mv.mid = m.rowid"
            " where mv.dim > 0"
        )
        params = []
        if status is True:
            sql += " and m.status in ('active','conflicting')"
        elif status:
            sql += " and m.status = ?"
            params.append(status)
        if repo:
            sql += " and m.repo = ?"
            params.append(repo)
        if lens:
            sql += " and m.lens = ?"
            params.append(lens)
        ids, vecs = [], []
        for r in self.db.execute(sql, params):
            v = np.frombuffer(r["v"], dtype=np.float32)
            if v.shape[0] != int(r["dim"]):
                continue  # 维度异常（写入残留）：跳过，不拖垮检索
            if dim is not None and v.shape[0] != int(dim):
                continue
            ids.append(r["id"])
            vecs.append(v)
        matrix = np.vstack(vecs).astype(np.float32) if vecs else np.zeros((0, 1), dtype=np.float32)
        return ids, matrix

    def search(self, q, qvec=None, repo=None, lens=None, top_k=5, rrf_k=20, status=True):
        """FTS5 + 向量 RRF 融合检索。

        - qvec 为 None（embedder 不可用）→ 纯 FTS；FTS 无命中且向量可用 → 纯向量；
        - RRF 与代码检索同法：`rrf += 1/(rrf_k + rank)`，rank 从 1 起；
        - 排序键 (-rrf, source_rank)：FTS 与向量都命中的条目排前面（这正是 RRF 的目的），
          同分时按原始向量相似度（有则 bm25，无则 -inf）稳定排序；
        - status 默认 True（哨兵）= 检索口径：active + conflicting **都参与召回**
          （Memanto 模型：冲突未决双方保持可召回，由 server 层给 conflicting 命中加
          conflictWarning 标注）；retired 永不出现。传 'active' 等字符串回到单状态口径。
        返回 (hits, channels)：channels 是各通道命中数（诊断/测试用）。
        """
        # 整个检索持锁：FTS 读 + 向量矩阵读 + 行补全是一个完整读事务面，
        # 与并发写（hit/upsert）在同一条连接上交错会互相干扰（并发实测 500）。
        with self.lock:
            return self._search_locked(q, qvec, repo, lens, top_k, rrf_k, status)

    def _search_locked(self, q, qvec, repo, lens, top_k, rrf_k, status):
        match_expr = self._fts_match_expr(q)
        fts_hits = self.search_fts(match_expr, repo, lens, status, limit=1000) if match_expr else []
        vec_hits, dim_note = [], None
        if qvec is not None:
            q = np.asarray(qvec, dtype=np.float32).reshape(-1)
            ids, matrix = self._vec_matrix(repo, lens, status, dim=int(q.shape[0]))
            if matrix.shape[0]:
                scores = matrix @ q
                order = np.argsort(-scores)[:1000]
                vec_hits = [(ids[int(i)], float(scores[int(i)])) for i in order if scores[int(i)] > 0]
        merged = {}
        for rank, (mid_id, _score) in enumerate(fts_hits, 1):
            merged[mid_id] = {"rrf": 1.0 / (rrf_k + rank), "vec": None}
        for rank, (mid_id, score) in enumerate(vec_hits, 1):
            cur = merged.get(mid_id)
            contribution = 1.0 / (rrf_k + rank)
            if cur is None:
                merged[mid_id] = {"rrf": contribution, "vec": score}
            else:
                cur["rrf"] += contribution
                cur["vec"] = score
        if not merged:
            return [], {"fts": len(fts_hits), "vector": len(vec_hits), "note": dim_note}
        ranked_ids = [mid_id for mid_id, _ in sorted(
            merged.items(), key=lambda kv: (-kv[1]["rrf"], -(kv[1]["vec"] if kv[1]["vec"] is not None else float("-inf")), kv[0])
        )][: int(top_k)]
        rows = self.db.execute(
            "select * from memories where id in (%s)" % ",".join("?" * len(ranked_ids)), ranked_ids
        ).fetchall()
        by_id = {r["id"]: self._row_to_memory(r, with_stats=False) for r in rows}
        hits = []
        for mid_id in ranked_ids:
            m = by_id.get(mid_id)
            if m:
                m["score"] = round(merged[mid_id]["rrf"], 6)
                hits.append(m)
        return hits, {"fts": len(fts_hits), "vector": len(vec_hits), "note": dim_note}

    def stats(self):
        with self.lock:
            row = self.db.execute(
                "select count(*) as total, coalesce(sum(stats_hits), 0) as hits,"
                " coalesce(sum(stats_adopted), 0) as adopted from memories"
            ).fetchone()
        return {
            "total": int(row["total"] or 0),
            "hits": int(row["hits"] or 0),
            "adopted": int(row["adopted"] or 0),
        }