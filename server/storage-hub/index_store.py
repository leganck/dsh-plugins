"""storage-hub 存储层 v2：代码资产（lineages/scopes/chunks/blobs/vectors）+ 经验资产
（memories/memory_vectors/excerpts/memory_excerpts/memory_conflicts/memory_events）+
任务与统计（exp_jobs/api_calls/meta）。

## 本文件是 v2 schema 的唯一实现，**不含任何兼容/迁移代码**

契约见 `docs/schema-v2.md`：
  · 一种数据只存一份：正文进 `blobs(hash)`、向量进 `vectors(tag,hash)`（内容寻址），
    `chunks` 只记"这个快照里有哪些块"；
  · 整数主键 + 外键 + ON DELETE CASCADE：删除自动级联，不靠手工清；
  · 全表 `STRICT`：类型错误插不进去（旧库最大的隐患是 `'123'` 与 `123` 混存）；
  · 状态用「表」不用「列值」：冲突是一等公民 `memory_conflicts`，
    `memories.status` 只有 active/retired；
  · 幂等键显式化：`memories.fingerprint` 唯一索引，upsert 靠它；
  · `memories_fts` 用外部内容表 + 触发器，不再手工双写。

启动校验：`meta.schema_version` 必须等于 `'2'`；旧库（没有 meta 表、或版本不等于 2）
直接 `RuntimeError`，提示"重置重建（docs/schema-v2.md §5）"——**不做运行时迁移**。

对外 id：`memories.id` 是 `INTEGER PRIMARY KEY`，API 层格式化为 `exp-%06d`
（`format_memory_id` / `parse_memory_id` 是唯一的转换入口）。

namespace 字符串格式保持不变：`{repoId}@{chunkFp}#{kind}:{refToken}[~root:{sha8}]`。
"""
import hashlib
import json
import os
import re
import sqlite3
import threading
import time

import numpy as np

# ---------------------------------------------------------------- 显示层中文名（决策 7）
# API 直接返回 `lensLabel` / `categoryLabel`，前端不再自己维护一份枚举到中文的映射。
LENS_LABELS = {
    "jargon": "黑话镜头",
    "index": "索引镜头",
    "logic": "逻辑镜头",
}
CATEGORY_LABELS = {
    "business": "业务知识",
    "debug": "调试经验",
    "repo": "仓库联动",
    "tool": "工具环境",
    "process": "交付流程",
}
LENSES = tuple(LENS_LABELS)
# process 属于"已由 skill 覆盖"的交付流程，默认不入库（写入层拒绝；标签表保留供展示旧数据）。
CATEGORIES = ("business", "debug", "repo", "tool")
CATEGORIES_STORED = tuple(CATEGORY_LABELS)

WORKFLOWS = ("erp-bug", "pay-bug", "release", "erp-req", "ops", "ledger", "local-dev")

SCHEMA_VERSION = "2"
_CHUNK_SCHEMA = "v2"

OLD_DB_MESSAGE = (
    "旧库不兼容，请重置重建（docs/schema-v2.md §5）："
    "停服务后删掉 index.db / index.db-wal / index.db-shm，再起服务，由客户端重推索引。"
    "v2 不提供迁移代码（schema_version='2' 是硬门槛）。"
)

# ---------------------------------------------------------------- 完整 DDL（docs/schema-v2.md §2）
# 与文档逐行一致；只补 `if not exists`（启动可重入），其余不增不减。
SCHEMA = """
-- ---------------------------------------------------------------- 基础
create table if not exists meta (
  key   text primary key,
  value text not null
) strict;
-- 必需键：schema_version='2' / embed_tag / chunk_schema

-- ---------------------------------------------------------------- 代码资产
-- 血统：一个来源仓库（跨克隆/跨机器同一性）
create table if not exists lineages (
  id          integer primary key,
  repo_name   text not null,
  url_norm    text,
  root_hint   text,
  created_at  integer not null,
  last_seen   integer not null
) strict;
create unique index if not exists lineages_url  on lineages(url_norm) where url_norm is not null;
create unique index if not exists lineages_root on lineages(root_hint) where root_hint is not null;
create index        if not exists lineages_name on lineages(repo_name);

-- 快照：一个 lineage 的一次具体视图（分支/PR/worktree/子目录）
create table if not exists scopes (
  id            integer primary key,
  lineage_id    integer not null references lineages(id) on delete cascade,
  kind          text not null,
  ref           text not null default 'default',
  root_rel      text,
  chunk_fp      text not null,
  namespace     text not null,
  tag           text,
  revision      integer not null default 0,
  chunk_count   integer not null default 0,
  vector_count  integer not null default 0,
  repo_state    text,
  commit_sha    text,
  simhash_path     text,
  simhash_content  text,
  simhash_algo     text,
  simhash_files    integer,
  simhash_at       integer,
  created_at    integer not null,
  updated_at    integer not null
) strict;
create unique index if not exists scopes_namespace on scopes(namespace);
create unique index if not exists scopes_ident on scopes(lineage_id, kind, ref, coalesce(root_rel,''), chunk_fp);
create index if not exists scopes_lineage on scopes(lineage_id, updated_at desc);

-- 块清单：这个快照里有哪些块（正文/向量都在别处，按 hash 引用）
create table if not exists chunks (
  scope_id   integer not null references scopes(id) on delete cascade,
  path       text not null,
  start_line integer not null,
  end_line   integer not null,
  hash       text not null,
  primary key (scope_id, path, start_line)
) strict;
create index if not exists chunks_hash  on chunks(hash);
create index if not exists chunks_scope_path on chunks(scope_id, path);

-- 块正文：内容寻址，全局唯一（同内容多快照只存一份）
create table if not exists blobs (
  hash       text primary key,
  body       blob not null,
  created_at integer not null
) strict;

-- 块向量：内容寻址（同 hash 同 tag 只算一次）
create table if not exists vectors (
  tag        text not null,
  hash       text not null references blobs(hash) on delete cascade,
  dim        integer not null,
  vec        blob not null,
  updated_at integer not null,
  primary key (tag, hash)
) strict;

-- ---------------------------------------------------------------- 经验资产
create table if not exists memories (
  id          integer primary key,
  fingerprint text not null,
  category    text not null,
  lens        text not null,
  workflow    text,
  repo        text,
  what        text not null,
  when_expr   text not null,
  why         text not null,
  status      text not null default 'active',
  source      text not null,
  audit       text,
  exp_job_id  integer references exp_jobs(id) on delete set null,
  hits        integer not null default 0,
  adopted     integer not null default 0,
  last_hit_at integer,
  created_at  integer not null,
  updated_at  integer not null
) strict;
create unique index if not exists memories_fp     on memories(fingerprint);
create index        if not exists memories_cat    on memories(category, status);
create index        if not exists memories_wf     on memories(workflow, status);
create index        if not exists memories_lens   on memories(lens, status);
create index        if not exists memories_hit_at on memories(last_hit_at);
create index        if not exists memories_created on memories(created_at desc);

-- 经验向量（1:1，独立表而不是塞进 memories：重建向量不动行）
create table if not exists memory_vectors (
  memory_id  integer primary key references memories(id) on delete cascade,
  tag        text not null,
  dim        integer not null,
  vec        blob not null,
  updated_at integer not null
) strict;

-- 证据片段：CAS（同片段被多条经验引用只存一份）
create table if not exists excerpts (
  id          integer primary key,
  sha256      text not null unique,
  text        text not null,
  kind        text not null default 'quote',
  archive_ref text,
  captured_at integer not null,
  expires_at  integer
) strict;

create table if not exists memory_excerpts (
  memory_id integer not null references memories(id) on delete cascade,
  excerpt_id integer not null references excerpts(id) on delete cascade,
  primary key (memory_id, excerpt_id)
) strict;
create index if not exists memory_excerpts_ev on memory_excerpts(excerpt_id);

-- 冲突：一等公民。双方都是 active（冲突未决仍可召回）
create table if not exists memory_conflicts (
  id          integer primary key,
  memory_a    integer not null references memories(id) on delete cascade,
  memory_b    integer not null references memories(id) on delete cascade,
  trigger_words text,
  status      text not null default 'open',
  resolution  text,
  resolved_by text,
  resolved_at integer,
  created_at  integer not null,
  unique (memory_a, memory_b)
) strict;
create index if not exists memory_conflicts_open on memory_conflicts(status, created_at desc);

-- 事件流：只追加，用于条目 timeline 与漏斗统计
create table if not exists memory_events (
  id        integer primary key,
  memory_id integer not null references memories(id) on delete cascade,
  at        integer not null,
  event     text not null,
  detail    text
) strict;
create index if not exists memory_events_mid on memory_events(memory_id, at desc);
create index if not exists memory_events_at  on memory_events(at desc);

-- ---------------------------------------------------------------- 任务与统计
create table if not exists exp_jobs (
  id             integer primary key,
  session_id     text,
  segment_no     integer,
  workflow       text,
  mode           text not null,
  status         text not null,
  model          text,
  prompt_version text,
  tokens_in      integer,
  tokens_out     integer,
  ms             integer,
  candidates     integer not null default 0,
  blocked        integer not null default 0,
  created_n      integer not null default 0,
  updated_n      integer not null default 0,
  skipped_n      integer not null default 0,
  contradicted_n integer not null default 0,
  reasons        text,
  error          text,
  created_at     integer not null,
  finished_at    integer
) strict;
create index if not exists exp_jobs_created on exp_jobs(created_at desc);
create index if not exists exp_jobs_seg     on exp_jobs(session_id, segment_no);

create table if not exists api_calls (
  id       integer primary key,
  at       integer not null,
  group_   text not null,
  key_id   text,
  ms       integer,
  status   integer,
  err      text
) strict;
create index if not exists api_calls_at    on api_calls(at desc);
create index if not exists api_calls_group on api_calls(group_, at desc);

-- ---------------------------------------------------------------- FTS
-- 经验全文：外部内容表 + 触发器同步（不再手工维护两份文本）
create virtual table if not exists memories_fts using fts5(
  what, when_expr, why,
  content   = 'memories',
  content_rowid = 'id',
  tokenize  = 'trigram'
);

create trigger if not exists memories_ai after insert on memories begin
  insert into memories_fts(rowid, what, when_expr, why)
  values (new.id, new.what, new.when_expr, new.why);
end;
create trigger if not exists memories_ad after delete on memories begin
  insert into memories_fts(memories_fts, rowid, what, when_expr, why)
  values ('delete', old.id, old.what, old.when_expr, old.why);
end;
create trigger if not exists memories_au after update of what, when_expr, why on memories begin
  insert into memories_fts(memories_fts, rowid, what, when_expr, why)
  values ('delete', old.id, old.what, old.when_expr, old.why);
  insert into memories_fts(rowid, what, when_expr, why)
  values (new.id, new.what, new.when_expr, new.why);
end;

-- 代码块全文（trigram；服务端仅在 fts 模式或管理端搜索时用）
create virtual table if not exists chunks_fts using fts5(
  body,
  content   = 'blobs',
  content_rowid = 'rowid',
  tokenize  = 'trigram'
);
"""

# ---------------------------------------------------------------- 作用域（档 3）
# 规则见 docs/scope-tier3.md §2；夹具 scope_format.json 是本文件的验收标准。
SCOPE_KINDS = ("main", "branch", "pr", "worktree")

# ---------------------------------------------------------------- simhash 候选（跨血统冷启动）
# 客户端把整棵文件清单压成两个 64-bit simhash（path-aware / content-only）。
# 服务端只用它**找候选**，绝不把它当存储键：真正复用的仍是精确内容哈希。
SIMHASH_HEX_LEN = 16          # 64-bit → 16 hex
SIMHASH_MIN_SIMILARITY = 0.85  # max(path/content 相似度) 门槛
ADOPT_MIN_OVERLAP = 0.80       # 目标 chunks ∩ 已有当前 tag 向量的比例
MAX_ADOPT_CANDIDATES = 5
MAX_ADOPT_HASHES = 50000
MAX_SIMHASH_FILES = 10_000_000
_SIMHASH_HEX_RE = re.compile(r"^[0-9a-fA-F]{1,16}$")
_SIMHASH_ALGO_RE = re.compile(r"^[A-Za-z0-9._:-]{1,16}$")
_TOKENS = {"main": "main", "branch": "branch", "pr": "pr", "worktree": "wt"}
_TOKEN_KINDS = {v: k for k, v in _TOKENS.items()}
_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_DIGITS_RE = re.compile(r"^[0-9]+$")

# repo_id 一直编码在 namespace 里（`<repoId>@<chunkFp>#...`）：v2 不再冗余存列，
# 统一的派生表达式放这里，凡按 repoId 过滤/分组都复用它。
_REPO_ID_SQL = "substr({alias}.namespace, 1, instr({alias}.namespace, '@') - 1)"


def repo_id_sql(alias="s"):
    return _REPO_ID_SQL.format(alias=alias)


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
        s = s[len("ssh://"):]
    if s.startswith("git@"):
        s = s[len("git@"):].replace(":", "/", 1)
    if "://" in s:
        s = s.split("://", 1)[1]
    if s.startswith("ssh:"):
        s = s[len("ssh:"):].lstrip("/")
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
        yield seq[i: i + size]


def _as_bool(value):
    """把 payload 里的开关宽松归一（true / 1 / "auto" 都算开；"off"/"false"/0 算关）。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on", "auto")
    return False


def _to_blob(body):
    """块正文入库形态：统一存 BLOB（STRICT 表列是 BLOB，TEXT 值会被类型检查拒绝）。"""
    if isinstance(body, bytes):
        return body
    if isinstance(body, bytearray):
        return bytes(body)
    if isinstance(body, str):
        return body.encode("utf-8")
    return str(body).encode("utf-8")


def _to_text(body):
    """块正文出库形态：API 一律返回 str（JSON 不能装 bytes）。"""
    if isinstance(body, str):
        return body
    if isinstance(body, (bytes, bytearray)):
        try:
            return bytes(body).decode("utf-8")
        except UnicodeDecodeError:
            return bytes(body).decode("utf-8", errors="replace")
    return str(body)


def _connect(db_path):
    """统一连接工厂：WAL + NORMAL + **每连接强制外键**（v2 依赖 cascade 自动清）。"""
    db = sqlite3.connect(db_path, check_same_thread=False, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("pragma journal_mode = wal")
    db.execute("pragma synchronous = normal")
    db.execute("pragma foreign_keys = on")
    return db


def check_schema(db):
    """启动 schema 校验（**唯一**的库版本门槛）。

    返回 "fresh"（空库，将按 v2 DDL 建）或 "v2"（已是 v2 库）。
    其它一切情况（有表但没有 meta / 版本不等于 2）→ RuntimeError（提示重置重建）。
    """
    tables = {
        r["name"]
        for r in db.execute("select name from sqlite_master where type = 'table'").fetchall()
    }
    if not tables:
        return "fresh"
    if "meta" not in tables:
        raise RuntimeError(OLD_DB_MESSAGE)
    row = db.execute("select value from meta where key = 'schema_version'").fetchone()
    if row is None or str(row["value"]) != SCHEMA_VERSION:
        raise RuntimeError(OLD_DB_MESSAGE)
    return "v2"


# ---------------------------------------------------------------- 代码资产
class IndexStore:
    """lineages / scopes / chunks / blobs / vectors 的读写。

    - 一种数据只存一份：`chunks` 只记 (scope, path, start) → hash；正文在 `blobs(hash)`，
      向量在 `vectors(tag, hash)`，两者都是内容寻址，跨快照/跨血统自动共享；
    - 删除靠 cascade：删 scope → chunks 自动清；随后 `gc()` 回收孤儿 blobs/vectors；
    - 计数/体积必须缓存：`counts()` 的 JOIN 在 16 万块上要 0.4 s，而它在**每次查询**里都要用；
      只在会改变数据的操作（sync/put_chunks/put_vectors/gc）后失效。
    """

    def __init__(self, db_path):
        self.db_path = db_path
        parent = os.path.dirname(os.path.abspath(db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.lock = threading.RLock()
        self._cache = {}
        self.db = _connect(db_path)
        state = check_schema(self.db)
        if state == "fresh":
            self.db.executescript(SCHEMA)
            self.db.execute("insert or replace into meta(key, value) values ('schema_version', ?)",
                            (SCHEMA_VERSION,))
            self.db.execute("insert or replace into meta(key, value) values ('chunk_schema', ?)",
                            (_CHUNK_SCHEMA,))
            self.db.execute("insert or replace into meta(key, value) values ('embed_tag', '')")
            self.db.commit()
        else:
            self.db.executescript(SCHEMA)  # 幂等兜底（含 if not exists）：补齐漏建的表/索引
            self.db.commit()
        self.meta_set("schema_version", SCHEMA_VERSION, commit=False)
        self.db.commit()

    # ---------------------------------------------------------------- meta
    def meta_get(self, key, default=None):
        with self.lock:
            row = self.db.execute("select value from meta where key = ?", (str(key),)).fetchone()
        return row["value"] if row else default

    def meta_set(self, key, value, commit=True):
        with self.lock:
            self.db.execute(
                "insert into meta(key, value) values (?, ?)"
                " on conflict(key) do update set value = excluded.value",
                (str(key), "" if value is None else str(value)),
            )
            if commit:
                self.db.commit()
        return value

    def embed_tag(self):
        return self.meta_get("embed_tag")

    def set_embed_tag(self, tag):
        """当前 embedding 模型 tag（meta.embed_tag；诊断/迁移后核对用）。"""
        return self.meta_set("embed_tag", "" if tag is None else str(tag))

    # ---------------------------------------------------------------- 血统 / 作用域
    def ensure_lineage(self, url_norm, fallback_seed, repo_name=None):
        """按归一化 URL（优先）或 root_hint（无 remote 时）定位/创建血统，返回整数 id。"""
        url = normalize_url(url_norm or "")
        seed = "" if fallback_seed is None else str(fallback_seed)
        hint = None if url else (seed or "unknown")
        name = (str(repo_name).strip() if repo_name else "") or seed or hint or "unknown"
        now = int(time.time())
        with self.lock:
            row = None
            if url:
                row = self.db.execute(
                    "select id, repo_name from lineages where url_norm = ?", (url,)
                ).fetchone()
            elif hint:
                row = self.db.execute(
                    "select id, repo_name from lineages where root_hint = ?", (hint,)
                ).fetchone()
            if row:
                lid = int(row["id"])
                self.db.execute("update lineages set last_seen = ? where id = ?", (now, lid))
                if repo_name and (row["repo_name"] or "") != name:
                    self.db.execute("update lineages set repo_name = ? where id = ?", (name, lid))
                self.db.commit()
                return lid
            cur = self.db.execute(
                "insert into lineages(repo_name, url_norm, root_hint, created_at, last_seen)"
                " values (?,?,?,?,?)",
                (name, url or None, hint, now, now),
            )
            self.db.commit()
            return int(cur.lastrowid)

    def lineage(self, lineage_id):
        with self.lock:
            row = self.db.execute("select * from lineages where id = ?", (int(lineage_id),)).fetchone()
        return dict(row) if row else None

    def scope(self, namespace):
        """按 namespace 取作用域（合并 lineage 的可读信息，供 API 层直接用）。"""
        ns = "" if namespace is None else str(namespace)
        with self.lock:
            row = self.db.execute(
                "select s.*, l.repo_name as lineage_name, l.url_norm as lineage_url"
                " from scopes s join lineages l on l.id = s.lineage_id where s.namespace = ?",
                (ns,),
            ).fetchone()
        if not row:
            return None
        item = dict(row)
        repo_id, _chunk_fp = namespace_identity(ns)
        item["repo_id"] = repo_id
        item["repo_name"] = item.get("lineage_name")
        item["lineageUrl"] = item.get("lineage_url") or ""
        return item

    # 兼容别名不再保留：调用方一律用 scope()。

    def _scope_id(self, namespace):
        row = self.db.execute("select id from scopes where namespace = ?", (str(namespace),)).fetchone()
        return int(row["id"]) if row else None

    def ensure_scope(self, namespace, repo_id, chunk_fp, lineage_id=None, tag=None,
                     repo_name=None, root_rel=None):
        """确保作用域行存在（已存在则只更新 tag/名字/root，绝不改血统——血统在创建时定死）。

        `root_rel` 必须是可读的相对路径（子目录索引时由 sync payload 的 scope.root 提供）。
        `scopes_ident` 的唯一键是 (lineage, kind, ref, COALESCE(root_rel,''), chunk_fp)：
        子目录作用域若把 root_rel 留 NULL，就会和仓库根撞唯一索引（实测踩到）。
        """
        now = int(time.time())
        meta = parse_scope_namespace(namespace)
        kind = meta["kind"] or "main"
        root_rel = normalize_root(root_rel) or None
        with self.lock:
            row = self.db.execute(
                "select id, lineage_id, tag from scopes where namespace = ?", (str(namespace),)
            ).fetchone()
            if row:
                if tag and (row["tag"] or "") != tag:
                    self.db.execute("update scopes set tag = ? where id = ?", (tag, int(row["id"])))
                if root_rel:
                    self.db.execute(
                        "update scopes set root_rel = coalesce(root_rel, ?) where id = ?",
                        (root_rel, int(row["id"])),
                    )
                if repo_name and lineage_id is None:
                    self.db.execute(
                        "update lineages set repo_name = ? where id = ? and (repo_name = '' or repo_name is null)",
                        (str(repo_name), int(row["lineage_id"])),
                    )
                self.db.commit()
                return self.scope(namespace)
            lid = int(lineage_id) if lineage_id else self.ensure_lineage(
                "", repo_id or namespace_identity(namespace)[0] or "unknown", repo_name,
            )
            try:
                self.db.execute(
                    "insert or ignore into scopes(lineage_id, kind, ref, root_rel, chunk_fp,"
                    " namespace, tag, revision, chunk_count, vector_count, created_at, updated_at)"
                    " values (?,?,?,?,?,?,?,0,0,0,?,?)",
                    (lid, kind, meta["scope_ref"] or "default", root_rel,
                     chunk_fp, str(namespace), tag, now, now),
                )
                self.db.commit()
            except sqlite3.IntegrityError as e:  # pragma: no cover —— 防御：并发建同名作用域
                self.db.rollback()
                raise SyncDiverged(f"作用域创建冲突：{namespace}（{e}）")
            if self._scope_id(namespace) is None:
                raise SyncDiverged(
                    f"同一血统下已存在等价作用域（lineage/kind/ref/root/chunkFp 相同）：{namespace}"
                )
            return self.scope(namespace)

    def set_tag(self, namespace, tag):
        """服务端模型换了 → 该作用域现有向量作废（tag 变了，missing 会重新算）。"""
        with self.lock:
            self.db.execute("update scopes set tag = ?, updated_at = ? where namespace = ?",
                            (tag, int(time.time()), str(namespace)))
            self.db.commit()
            self._invalidate()

    def set_all_tags(self, tag):
        """把所有**已同步**作用域的 tag 批量改成新模型 tag（热切换用）；返回影响行数。

        - 只更新 tag 非空的行：从未定过 tag 的作用域保持原样，它们的 pending 语义是
          "全部待嵌"，不能被一次热切换误标成已同步；
        - 单条 UPDATE、单事务；同时写 meta.embed_tag。
        """
        tag = "" if tag is None else str(tag)
        if not tag:
            raise ValueError("set_all_tags 的 tag 不能为空")
        with self.lock:
            cur = self.db.execute(
                "update scopes set tag = ?, updated_at = ? where tag is not null and tag != ''",
                (tag, int(time.time())),
            )
            self.db.commit()
            self._invalidate()
            changed = int(cur.rowcount or 0)
        self.meta_set("embed_tag", tag)
        return changed

    # ---------------------------------------------------------------- 作用域生命周期
    def register_scope(self, namespace, kind, ref, commit_sha=None, scope_ref=None, root_rel=None):
        """写/更新 scope 元数据（kind/ref/root/commit）。

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
            sid = self._scope_id(namespace)
            if sid is None:
                repo_id, chunk_fp = namespace_identity(namespace)
                lineage = self.ensure_lineage("", repo_id or "unknown")
                cur = self.db.execute(
                    "insert or ignore into scopes(lineage_id, kind, ref, root_rel, chunk_fp,"
                    " namespace, tag, revision, chunk_count, vector_count, commit_sha,"
                    " created_at, updated_at) values (?,?,?,?,?,?,null,0,0,0,?,?,?)",
                    (lineage, kind, scope_ref or "default", root_rel, chunk_fp or "default",
                     str(namespace), commit_sha, now, now),
                )
                self.db.commit()
                sid = self._scope_id(namespace)
                if sid is None:
                    raise ScopeFormatError("scope-conflict", f"无法注册作用域：{namespace}")
            sets = ["kind = ?", "ref = ?", "updated_at = ?"]
            args = [kind, scope_ref or "default", now]
            if root_rel:
                sets.append("root_rel = ?")
                args.append(root_rel)
            if commit_sha is not None:
                sets.append("commit_sha = ?")
                args.append(commit_sha)
            try:
                self.db.execute(f"update scopes set {', '.join(sets)} where id = ?", [*args, sid])
                self.db.commit()
            except sqlite3.IntegrityError as e:
                self.db.rollback()
                raise ScopeFormatError(
                    "scope-conflict",
                    f"作用域身份冲突（同一血统下已有等价的 kind/ref/root/chunkFp）：{namespace}（{e}）",
                )
        return self.scope(namespace)

    def delete_scope(self, namespace):
        """删除一个作用域：chunks 由外键 cascade 清理；blob/vector 交给 gc（可能仍被引用）。幂等。"""
        with self.lock:
            row = self.db.execute(
                "select id, lineage_id, chunk_count from scopes where namespace = ?", (str(namespace),)
            ).fetchone()
            if not row:
                return {"deleted": False, "chunks": 0, "lineage": None}
            sid = int(row["id"])
            chunks = int(row["chunk_count"] or 0)
            if not chunks:
                chunks = int(self.db.execute(
                    "select count(*) as n from chunks where scope_id = ?", (sid,)
                ).fetchone()["n"])
            self.db.execute("delete from scopes where id = ?", (sid,))
            self.db.commit()
            self._invalidate()
        return {"deleted": True, "chunks": chunks, "lineage": int(row["lineage_id"])}

    def bulk_delete_scopes(self, namespaces):
        """批量删除作用域；返回 deleted/failed/lineages，调用方统一做 GC。"""
        deleted, failed, lineages = [], [], []
        total_chunks = 0
        with self.lock:
            for raw in namespaces or []:
                ns = str(raw or "").strip()
                if not ns:
                    continue
                row = self.db.execute(
                    "select id, lineage_id from scopes where namespace = ?", (ns,)
                ).fetchone()
                if not row:
                    failed.append({"namespace": ns, "error": "not-found"})
                    continue
                try:
                    sid = int(row["id"])
                    n = int(self.db.execute(
                        "select count(*) as n from chunks where scope_id = ?", (sid,)
                    ).fetchone()["n"])
                    self.db.execute("delete from scopes where id = ?", (sid,))
                    total_chunks += n
                    deleted.append(ns)
                    lineage = int(row["lineage_id"])
                    if lineage not in lineages:
                        lineages.append(lineage)
                except Exception as e:  # noqa: BLE001
                    failed.append({"namespace": ns, "error": f"{type(e).__name__}: {e}"})
            self.db.commit()
            if deleted:
                self._invalidate()
        return {"deleted": deleted, "failed": failed, "lineages": lineages, "chunks": total_chunks}

    def count_scopes(self):
        with self.lock:
            return int(self.db.execute("select count(*) as n from scopes").fetchone()["n"])

    def scope_overview(self, repo_id=None, kind=None, limit=50):
        """overview() 的每一项再加 scope 元信息（给 /v1/scopes 与 /health）。"""
        where, args = [], []
        if repo_id:
            where.append(repo_id_sql("s") + " = ?")
            args.append(str(repo_id))
        if kind:
            where.append("s.kind = ?")
            args.append(str(kind))
        sql = (
            f"select s.*, l.repo_name as lineage_name, l.url_norm as lineage_url,"
            f" (select count(*) from chunks c where c.scope_id = s.id) as chunks"
            f" from scopes s join lineages l on l.id = s.lineage_id"
        )
        if where:
            sql += " where " + " and ".join(where)
        sql += " order by s.updated_at desc limit ?"
        args.append(int(limit))
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            repo_id_v, _ = namespace_identity(r["namespace"])
            item["repo_id"] = repo_id_v
            item["repo_name"] = r["lineage_name"]
            item["lineageUrl"] = r["lineage_url"] or ""
            item.update(self.counts(r["namespace"]))
            item.update(self.lineage_bytes(r["lineage_id"]))
            item["scope"] = {
                "kind": r["kind"] or "main",
                "ref": r["ref"],
                "root": r["root_rel"],
                "commit": r["commit_sha"],
                "createdAt": r["created_at"],
            }
            out.append(item)
        return out

    def _scope_where(self, repo_id=None, kind=None, q=None):
        where, args = [], []
        if repo_id:
            where.append(repo_id_sql("s") + " = ?")
            args.append(str(repo_id))
        if kind:
            where.append("s.kind = ?")
            args.append(str(kind))
        if q:
            needle = "%" + str(q).strip().lower() + "%"
            where.append("(lower(coalesce(l.repo_name,'')) like ? or lower(s.namespace) like ?"
                         " or lower(coalesce(s.ref,'')) like ? or lower(coalesce(s.root_rel,'')) like ?"
                         " or lower(s.chunk_fp) like ?)")
            args.extend([needle] * 5)
        return where, args

    def scope_page(self, repo_id=None, kind=None, q=None, sort="updated_at", order="desc",
                   limit=50, offset=0):
        """分页作用域列表 + 总数 + facets；只对当前页计算计数/占用。"""
        sort_map = {
            "updated_at": "s.updated_at",
            "created_at": "s.created_at",
            "repo_name": "coalesce(l.repo_name, s.namespace)",
            "repo_kind": "s.kind",
            "kind": "s.kind",
            "chunks": "s.chunk_count",
        }
        sort_col = sort_map.get(sort, sort_map["updated_at"])
        direction = "asc" if str(order).lower() == "asc" else "desc"
        where, args = self._scope_where(repo_id, kind, q)
        clause = (" where " + " and ".join(where)) if where else ""
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        count_sql = "select count(*) as n from scopes s join lineages l on l.id = s.lineage_id" + clause
        data_sql = (
            f"select s.*, l.repo_name as lineage_name, l.url_norm as lineage_url,"
            f" (select count(*) from chunks c where c.scope_id = s.id) as chunks,"
            f" {repo_id_sql('s')} as repo_id"
            f" from scopes s join lineages l on l.id = s.lineage_id" + clause
            + f" order by {sort_col} {direction}, s.namespace asc limit ? offset ?"
        )
        with self.lock:
            total = int(self.db.execute(count_sql, args).fetchone()["n"])
            rows = self.db.execute(data_sql, [*args, limit, offset]).fetchall()
            variant_rows = self.db.execute(
                f"select {repo_id_sql('s')} as repo_id, s.kind as kind, coalesce(s.ref,'') as ref,"
                f" count(*) as n from scopes s group by 1, 2, 3"
            ).fetchall()
            repo_rows = self.db.execute(
                f"select {repo_id_sql('s')} as repo_id,"
                f" coalesce(max(l.repo_name), '') as repo_name, count(*) as n"
                f" from scopes s join lineages l on l.id = s.lineage_id"
                f" group by 1 order by n desc, repo_name asc"
            ).fetchall()
            kind_rows = self.db.execute(
                "select kind, count(*) as n from scopes group by kind"
            ).fetchall()
            facets_repos = [
                {"repoId": r["repo_id"], "repoName": r["repo_name"] or r["repo_id"], "count": int(r["n"])}
                for r in repo_rows
            ]
            facets_kinds = {k: 0 for k in SCOPE_KINDS}
            for r in kind_rows:
                key = r["kind"] or "main"
                facets_kinds[key] = facets_kinds.get(key, 0) + int(r["n"])
            variants = {
                (r["repo_id"], r["kind"] or "main", r["ref"] or ""): int(r["n"])
                for r in variant_rows
            }
            items = []
            for r in rows:
                item = dict(r)
                item["repo_name"] = r["lineage_name"]
                item["lineageUrl"] = r["lineage_url"] or ""
                item.update(self.counts(r["namespace"]))
                item.update(self.lineage_bytes(r["lineage_id"]))
                item["files"] = int(self.db.execute(
                    "select count(distinct path) as n from chunks where scope_id = ?", (int(r["id"]),)
                ).fetchone()["n"])
                item["updatedAt"] = r["updated_at"]
                item["variantCount"] = variants.get(
                    (r["repo_id"], r["kind"] or "main", r["ref"] or ""), 1
                )
                item["scope"] = {
                    "kind": r["kind"] or "main",
                    "ref": r["ref"],
                    "root": r["root_rel"],
                    "commit": r["commit_sha"],
                    "createdAt": r["created_at"],
                }
                items.append(item)
            # 重复身份检测：同一 repoName 出现多个 repoId 时，只有"有 git URL 的血统"是 canonical，
            # 其余标 duplicateIdentity（历史上读不到 origin 时回退成路径哈希会造成这种分裂）。
            id_rows = self.db.execute(
                f"select {repo_id_sql('s')} as repo_id,"
                f" coalesce(l.repo_name, s.namespace) as name, coalesce(l.url_norm, '') as url"
                f" from scopes s join lineages l on l.id = s.lineage_id"
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
            total = int(self.db.execute("select count(*) as n from scopes").fetchone()["n"])
            rows = self.db.execute("select kind, count(*) as n from scopes group by kind").fetchall()
            by_kind = {k: 0 for k in SCOPE_KINDS}
            for r in rows:
                key = r["kind"] or "main"
                by_kind[key] = by_kind.get(key, 0) + int(r["n"])
            chunks = int(self.db.execute("select count(*) as n from chunks").fetchone()["n"])
            vectors = int(self.db.execute(
                "select count(*) as n from chunks c join scopes s on s.id = c.scope_id"
                " join vectors v on v.tag = s.tag and v.hash = c.hash"
            ).fetchone()["n"])
            body_bytes = int(self.db.execute(
                "select coalesce(sum(length(body)),0) as n from blobs"
            ).fetchone()["n"])
            vector_bytes = int(self.db.execute(
                "select coalesce(sum(length(vec)),0) as n from vectors"
            ).fetchone()["n"])
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
          repoId, chunkFp, url, lineage?, tag, repoName,
          repoState, revision, mode: 'diff'|'full', chunkCount,
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
        repo_name = payload.get("repoName") or payload.get("repo_name")
        # scope.root 是子目录索引的相对路径；它参与 scopes_ident 唯一键，必须落库。
        scope_meta = payload.get("scope") if isinstance(payload.get("scope"), dict) else {}
        root_rel = normalize_root(scope_meta.get("root")) or None

        lineage = payload.get("lineage")
        if not lineage:
            lineage = self.ensure_lineage(url, repo_id, repo_name)
        cur = self.ensure_scope(namespace, repo_id, chunk_fp, int(lineage), tag=tag,
                                repo_name=repo_name, root_rel=root_rel)
        # **血统在创建时定死**：后续同步即使不带 url/repoId，也绝不重新推导 ——
        # 否则一个"最小载荷"（只发 repoState + revision）会凭空造出一个新血统。
        lineage = int(cur["lineage_id"])

        # ① 状态指纹短路：指纹一致**且块数一致**才立刻回。
        # 只比指纹是不够的：指纹是客户端算的，若上一次同步是"空清单"（客户端本地早已建好索引、
        # 本轮 0 变更），服务端会把指纹记下来却一块内容都没有 —— 之后两端指纹永远相同，
        # 服务端就永远短路、永远 missing=0。实测被 ES 16 万块的预热直接踩中。
        cur_chunks = cur.get("chunk_count")
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
            raise SyncDiverged(
                f"namespace {namespace} 的 chunkFp 不一致：服务端 {cur['chunk_fp']} vs 客户端 {chunk_fp}"
            )

        upsert = payload.get("upsert") or []
        remove = payload.get("remove") or []
        remove_set = set(remove)
        for f in upsert:
            if f.get("path") in remove_set:
                raise SyncDiverged(f"path 同时出现在 upsert 与 remove：{f.get('path')}")

        now = int(time.time())
        sid = int(cur["id"])
        # simhash 只作为候选线索：非法值直接忽略（老客户端/坏客户端不能拖垮 sync）。
        simhash = parse_simhash(payload.get("simhash"))
        # 跨血统冷启动复用只在 full + 客户端显式 adopt 开关 + reuse 非 off 时发生；
        # 其他 sync（diff / 普通 full）**绝不做**候选查询，避免热路径多付一次全 scope 扫描。
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
                self.db.execute("delete from chunks where scope_id = ? and path = ?", (sid, str(path)))
            for f in upsert:
                path = str(f["path"])
                keep = [(c["start"], c["end"], c["hash"]) for c in (f.get("chunks") or [])]
                self.db.execute("delete from chunks where scope_id = ? and path = ?", (sid, path))
                for start, end, chash in keep:
                    self.db.execute(
                        "insert or replace into chunks(scope_id, path, start_line, end_line, hash)"
                        " values (?,?,?,?,?)",
                        (sid, path, int(start), int(end), str(chash)),
                    )
            self.db.execute(
                "update scopes set revision = revision + 1, repo_state = ?,"
                " tag = coalesce(?, tag), updated_at = ?,"
                " chunk_count = (select count(*) from chunks where scope_id = ?)"
                " where id = ?",
                (repo_state, tag, now, sid, sid),
            )
            self.db.execute("update lineages set last_seen = ? where id = ?", (now, lineage))
            self.db.commit()
            self._invalidate()
            rev = int(self.db.execute(
                "select revision from scopes where id = ?", (sid,)
            ).fetchone()["revision"])
            if simhash:
                try:
                    self._write_simhash(namespace, simhash, now=now)
                except Exception:  # noqa: BLE001 —— simhash 落库失败不影响 sync
                    pass
            # 写入目标 chunks 之后、计算 _missing 之前尝试 adopt；失败继续正常 sync。
            if adopt_requested and simhash:
                try:
                    adopted = self._maybe_adopt(namespace, lineage, tag, simhash)
                except Exception as e:  # noqa: BLE001 —— adopt 是尽力而为，绝不返回 500
                    self.db.rollback()
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
            missing = self._missing(namespace, tag, limit=None, scope_id=sid)
            # vector_count 是冗余计数（列表页/status 免 JOIN），每次 sync 刷新
            self.db.execute(
                "update scopes set vector_count = ? where id = ?",
                (max(0, self._chunk_total(sid) - len(missing)), sid),
            )
            self.db.commit()
            self._invalidate()

        out = {"revision": rev, "unchanged": False, "missing": missing, **self.counts(namespace)}
        if adopted:
            out["adopted"] = adopted
        if adopt_candidates:
            out["adoptCandidates"] = adopt_candidates
        if adopt_error:
            out["adoptError"] = adopt_error
        return out

    def _chunk_total(self, scope_id):
        return int(self.db.execute(
            "select count(*) as n from chunks where scope_id = ?", (scope_id,)
        ).fetchone()["n"])

    def _missing(self, namespace, tag, limit=None, scope_id=None):
        """该作用域里"没有当前 tag 向量"的块。tag 为空表示还没定过模型 → 全部视为缺。"""
        sid = scope_id if scope_id is not None else self._scope_id(namespace)
        if sid is None:
            return []
        if not tag:
            sql = "select c.hash from chunks c where c.scope_id = ?"
            args = [sid]
        else:
            sql = (
                "select c.hash from chunks c where c.scope_id = ? and not exists ("
                " select 1 from vectors v where v.tag = ? and v.hash = c.hash)"
            )
            args = [sid, str(tag)]
        if limit:
            sql += f" limit {int(limit)}"
        with self.lock:
            return [r["hash"] for r in self.db.execute(sql, args).fetchall()]

    # ---------------------------------------------------------------- 正文
    def put_chunks(self, namespace, bodies):
        """上传块正文（幂等，内容寻址全局去重）。返回 {accepted, deduped}。"""
        if self._scope_id(namespace) is None:
            raise SyncDiverged(f"未知命名空间：{namespace}")
        now = int(time.time())
        accepted = deduped = 0
        with self.lock:
            for item in bodies:
                h = item.get("hash")
                body = item.get("body")
                if not h or body is None:
                    continue
                h = str(h)
                if self.db.execute("select 1 from blobs where hash = ?", (h,)).fetchone():
                    deduped += 1
                    continue
                self.db.execute(
                    "insert into blobs(hash, body, created_at) values (?,?,?)",
                    (h, _to_blob(body), now),
                )
                accepted += 1
            self.db.commit()
            self._invalidate()
        return {"accepted": accepted, "deduped": deduped}

    def pending(self, namespace, tag, limit=64, order="spread"):
        """待嵌入的块（正文来自 blobs）。order='spread' 按 hash 排序 → 全仓均匀覆盖。"""
        sid = self._scope_id(namespace)
        if sid is None:
            return []
        clause = "c.scope_id = ? and not exists (select 1 from vectors v where v.tag = ? and v.hash = c.hash)"
        order_sql = "c.hash" if order == "spread" else "c.path, c.start_line"
        sql = (
            "select distinct c.hash as hash, b.body as body from chunks c join blobs b"
            " on b.hash = c.hash"
            f" where {clause} order by {order_sql} limit ?"
        )
        with self.lock:
            rows = self.db.execute(sql, (sid, str(tag or ""), int(limit))).fetchall()
        return [{"hash": r["hash"], "body": _to_text(r["body"])} for r in rows]

    def put_vectors(self, tag, pairs):
        """pairs: [(hash, np.ndarray)] → `vectors(tag, hash)` 单表 upsert。

        内容寻址：同 (tag, hash) 全局只有一份，不再有"血统成员表"。
        外键兜底：`vectors.hash` 指向 `blobs(hash)`，这里用 `insert ... select ... where exists`
        保证"没有正文的块不会长出向量"（有向量没正文会让检索拿到空文本）。
        """
        if not tag:
            raise ValueError("put_vectors 需要 embedding tag")
        tag = str(tag)
        now = int(time.time())
        written = 0
        with self.lock:
            for h, vec in pairs:
                v = np.asarray(vec, dtype=np.float32).reshape(-1)
                cur = self.db.execute(
                    "insert into vectors(tag, hash, dim, vec, updated_at)"
                    " select ?, ?, ?, ?, ? where exists (select 1 from blobs where hash = ?)"
                    " on conflict(tag, hash) do update set dim = excluded.dim,"
                    " vec = excluded.vec, updated_at = excluded.updated_at",
                    (tag, str(h), int(v.shape[0]), v.tobytes(), now, str(h)),
                )
                written += max(0, int(cur.rowcount or 0))
            self.db.commit()
            self._invalidate()
        return {"written": written}

    def missing_bodies(self, namespace, tag, limit=64, order="spread"):
        return self.pending(namespace, tag, limit, order)

    # ---------------------------------------------------------------- 查询
    def matrix(self, namespace, tag):
        """返回 (hashes, matrix[float32, N×dim], meta{hash: (path,start,end)})。

        取样路径（§4）：`scopes → chunks.hash 集合 → vectors(tag, hash)`。
        只读快照：调用方在锁外做点积，避免长时间占锁。
        """
        sid = self._scope_id(namespace)
        if sid is None:
            return [], np.empty((0, 0), dtype=np.float32), {}
        with self.lock:
            rows = self.db.execute(
                "select c.hash, c.path, c.start_line as start, c.end_line as end,"
                " v.vec, v.dim from chunks c join vectors v"
                " on v.tag = ? and v.hash = c.hash where c.scope_id = ?",
                (str(tag or ""), sid),
            ).fetchall()
        hashes = []
        meta = {}
        dim = rows[0]["dim"] if rows else 0
        mat = np.empty((len(rows), dim), dtype=np.float32) if rows else np.empty((0, 0), dtype=np.float32)
        for i, r in enumerate(rows):
            mat[i] = np.frombuffer(r["vec"], dtype=np.float32, count=r["dim"])
            hashes.append(r["hash"])
            meta[r["hash"]] = (r["path"], int(r["start"]), int(r["end"]))
        return hashes, mat, meta

    def bodies(self, hashes):
        """按内容哈希直读正文（v2：blobs 是全局内容寻址表，不需要血统参数）。"""
        wanted = [str(h) for h in (hashes or []) if h]
        if not wanted:
            return {}
        out = {}
        with self.lock:
            for part in _chunked(wanted):
                q = ",".join("?" * len(part))
                rows = self.db.execute(
                    f"select hash, body from blobs where hash in ({q})", part
                ).fetchall()
                for r in rows:
                    out[r["hash"]] = _to_text(r["body"])
        return out

    def pending_count(self, namespace, tag):
        """便宜的待嵌入计数（给 /status 用，不要把整表捞出来）。"""
        sid = self._scope_id(namespace)
        if sid is None:
            return 0
        if not tag:
            sql = "select count(distinct c.hash) as n from chunks c where c.scope_id = ?"
            args = (sid,)
        else:
            sql = (
                "select count(distinct c.hash) as n from chunks c where c.scope_id = ? and not exists ("
                " select 1 from vectors v where v.tag = ? and v.hash = c.hash)"
            )
            args = (sid, str(tag))
        with self.lock:
            return int(self.db.execute(sql, args).fetchone()["n"])

    def _invalidate(self):
        """任何会改变 chunks/blobs/vectors 的操作后调用（sync/put_chunks/put_vectors/gc）。"""
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
            sid = self._scope_id(namespace)
            if sid is None:
                out = {"chunks": 0, "vectors": 0, "coverage": 0.0}
                self._cache[("counts", namespace)] = out
                return dict(out)
            tag = self.db.execute("select tag from scopes where id = ?", (sid,)).fetchone()["tag"]
            chunks = self.db.execute(
                "select count(*) as n from chunks where scope_id = ?", (sid,)
            ).fetchone()["n"]
            vectors = self.db.execute(
                "select count(*) as n from chunks c join vectors v"
                " on v.tag = ? and v.hash = c.hash where c.scope_id = ?",
                (tag or "", sid),
            ).fetchone()["n"]
        out = {
            "chunks": int(chunks),
            "vectors": int(vectors),
            "coverage": round(vectors / chunks, 4) if chunks else 0.0,
        }
        self._cache[("counts", namespace)] = out
        return dict(out)

    def lineage_bytes(self, lineage):
        """正文/向量逻辑占用（按该血统 chunks 引用到的 hash 归集；共享内容不重复计数）。"""
        lid = int(lineage)
        hit = self._cache.get(("bytes", lid))
        if hit is not None:
            return dict(hit)
        with self.lock:
            hq = "select c.hash from chunks c join scopes s on s.id = c.scope_id where s.lineage_id = ?"
            b = self.db.execute(
                f"select coalesce(sum(length(body)),0) as n from blobs where hash in ({hq})", (lid,)
            ).fetchone()["n"]
            v = self.db.execute(
                f"select coalesce(sum(length(vec)),0) as n from vectors where hash in ({hq})", (lid,)
            ).fetchone()["n"]
        out = {"bodyBytes": int(b), "vectorBytes": int(v), "totalBytes": int(b) + int(v)}
        self._cache[("bytes", lid)] = out
        return dict(out)

    def vector_count(self, lineage, tag=None):
        lid = int(lineage)
        hq = "select c.hash from chunks c join scopes s on s.id = c.scope_id where s.lineage_id = ?"
        if tag:
            sql, args = f"select count(*) as n from vectors where tag = ? and hash in ({hq})", (str(tag), lid)
        else:
            sql, args = f"select count(*) as n from vectors where hash in ({hq})", (lid,)
        with self.lock:
            return int(self.db.execute(sql, args).fetchone()["n"])

    def tag_stats(self):
        """所有向量 tag 的条数与占用（换模型后旧 tag 会继续占空间，需要显式清理）。

        **必须缓存**：`sum(length(vec))` 要扫全表（16 万行 ≈ 3 s），而 `/health` 每次都会调。
        """
        hit = self._cache.get(("tagstats",))
        if hit is not None:
            return [dict(x) for x in hit]
        with self.lock:
            rows = self.db.execute(
                "select tag, count(*) as vectors, coalesce(sum(length(vec)),0) as bytes"
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
                cur = self.db.execute("delete from vectors where tag = ?", (str(drop_tag),))
            else:
                cur = self.db.execute(
                    "delete from vectors where tag is null or tag != ?", (str(keep_tag),)
                )
            self.db.commit()
            self._invalidate()
            return {"deleted": int(cur.rowcount or 0), "keptTag": keep_tag, "droppedTag": drop_tag}

    def total_bytes(self):
        """全库正文+向量占用；同样要缓存（1.6 GB 全扫），写操作后由 _invalidate() 失效。"""
        hit = self._cache.get(("totalbytes",))
        if hit is not None:
            return int(hit)
        with self.lock:
            b = self.db.execute("select coalesce(sum(length(body)),0) as n from blobs").fetchone()["n"]
            v = self.db.execute("select coalesce(sum(length(vec)),0) as n from vectors").fetchone()["n"]
        total = int(b) + int(v)
        self._cache[("totalbytes",)] = total
        return total

    def hashes_in_lineage(self, lineage, tag=None):
        lid = int(lineage)
        if tag:
            sql = (
                "select distinct c.hash from chunks c join scopes s on s.id = c.scope_id"
                " join vectors v on v.tag = ? and v.hash = c.hash where s.lineage_id = ?"
            )
            args = [str(tag), lid]
        else:
            sql = "select distinct c.hash from chunks c join scopes s on s.id = c.scope_id where s.lineage_id = ?"
            args = [lid]
        with self.lock:
            return [r["hash"] for r in self.db.execute(sql, args).fetchall()]

    # ---------------------------------------------------------------- 维护
    def gc(self, lineage=None):
        """回收孤儿内容（§4）：全库没有任何 chunks 行引用的 blob / vector。

        v2 的 blobs/vectors 是**全局内容寻址**的，所以 GC 也是全局的：删掉作用域后
        （chunks 由外键 cascade 清），这里把不再被引用的 blob 与 vector 一并清掉。
        `vectors.hash` 外键指向 `blobs(hash)`，删 blob 时向量会被级联删；这里仍显式
        先删向量，为的是给出可报告的行数。
        lineage 参数保留给调用方（删除某血统后的 GC 只是同一件全局清理）。
        """
        with self.lock:
            dead_v = int(self.db.execute(
                "select count(*) as n from vectors where hash not in (select hash from chunks)"
            ).fetchone()["n"])
            self.db.execute("delete from vectors where hash not in (select hash from chunks)")
            dead_b = int(self.db.execute(
                "select count(*) as n from blobs where hash not in (select hash from chunks)"
            ).fetchone()["n"])
            self.db.execute("delete from blobs where hash not in (select hash from chunks)")
            self.db.commit()
            self._invalidate()
        return {"blobs": dead_b, "vectors": dead_v}

    def adopt(self, from_lineage, to_lineage, hashes=None):
        """显式跨血统借用。

        v2 里 blobs / vectors 都是**全局内容寻址**：内容只存一份，目标作用域的 chunks
        引用到同一个 hash 时天然就能拿到正文和向量，所以"复制字节"这件事不存在了。
        这个方法退化为**核对**：返回源血统可达的 hash 里，已经有正文 / 已经有向量的条数。
        """
        src = self.lineage_resolve(from_lineage)
        src = src[0] if isinstance(src, list) and src else None
        if src is None:
            return {"blobs": 0, "vectors": 0}
        wanted = [str(h) for h in (hashes or []) if h]
        if not wanted:
            wanted = self.hashes_in_lineage(src)
        if not wanted:
            return {"blobs": 0, "vectors": 0}
        blobs = vectors = 0
        with self.lock:
            for part in _chunked(wanted):
                q = ",".join("?" * len(part))
                blobs += int(self.db.execute(
                    f"select count(*) as n from blobs where hash in ({q})", part
                ).fetchone()["n"])
                vectors += int(self.db.execute(
                    f"select count(*) as n from vectors where hash in ({q})", part
                ).fetchone()["n"])
        return {"blobs": blobs, "vectors": vectors}

    # ---------------------------------------------------------------- simhash 候选 / 精确 adopt
    def set_simhash(self, namespace, simhash, now=None):
        """写入/更新一个作用域的 simhash 元信息；非法值抛 ValueError（sync 内部不走这里）。"""
        data = parse_simhash(simhash)
        if data is None:
            raise ValueError("bad simhash: path/content 必须是 ≤16 位十六进制，v/files 必须合法")
        return self._write_simhash(namespace, data, now=now)

    def _write_simhash(self, namespace, data, now=None):
        """已是校验过的 simhash dict；返回写入后的 dict，未知 namespace 返回 None。"""
        ts = int(time.time()) if now is None else int(now)
        with self.lock:
            cur = self.db.execute(
                "update scopes set simhash_path = ?, simhash_content = ?, simhash_algo = ?,"
                " simhash_files = ?, simhash_at = ? where namespace = ?",
                (data["path"], data["content"], data["algo"], data["files"], ts, str(namespace)),
            )
            self.db.commit()
        return dict(data) if cur.rowcount else None

    def similar_lineages(self, simhash_path, simhash_content, exclude_lineage, tag,
                         limit=MAX_ADOPT_CANDIDATES, min_similarity=SIMHASH_MIN_SIMILARITY,
                         algo=None, target_namespace=None):
        """按 simhash 找相似作用域（只返回元信息，**不返回正文**）。

        实现取"扫 scopes 行"而不是"扫块"：有 simhash 的行数 = 作用域数，量级远小于块数。
        每个 lineage 按 updated_at 取最新一行再过滤：

          - 不是 `exclude_lineage`；
          - 候选 `scopes.tag == tag`：tag 为空直接返回 []，模型不同就没有可复用的向量；
          - `algo` 给定时算法版本必须一致（算法升级后旧 simhash 不参与候选）；
          - `similarity = max(pathSimilarity, contentSimilarity) >= min_similarity`；
          - 给了 `target_namespace` 且目标血统当前 tag 已有向量 → 返回 []（不是冷启动）。
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
                    "select lineage_id from scopes where namespace = ?", (str(target_namespace),)
                ).fetchone()
                if trow:
                    if not exclude_lineage:
                        exclude_lineage = int(trow["lineage_id"])
                    # v2 内容全局共享：目标"已经有向量"是常态（共享内容天然命中），
                    # 所以冷启动闸门改成"还有没有任何块缺当前 tag 向量" —— 全覆盖才算非冷启动。
                    if self.pending_count(str(target_namespace), tag) == 0:
                        return []
            rows = self.db.execute(
                f"select s.namespace, s.lineage_id, s.tag, s.simhash_path, s.simhash_content,"
                f" s.simhash_algo, s.simhash_files, s.updated_at, l.repo_name,"
                f" {repo_id_sql('s')} as repo_id"
                f" from scopes s join lineages l on l.id = s.lineage_id"
                f" where s.simhash_path is not null and s.simhash_content is not null"
                f" order by s.updated_at desc"
            ).fetchall()
        seen = set()
        out = []
        for r in rows:
            lineage = int(r["lineage_id"])
            if lineage in seen:
                continue
            seen.add(lineage)
            if exclude_lineage and lineage == int(exclude_lineage):
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
        """目标作用域的 distinct chunk hash 里"已经有当前 tag 向量"的比例。

        v2 的向量是全局内容寻址的，所以这个比例就是目标作用域的覆盖率；
        `from_lineage` 参数保留在签名里（调用方语义是"从哪个候选比对"）。
        返回 `{hashes, overlap, matched, targetHashes, targetChunks}`；
        `overlap = matched / targetHashes`（分母用 distinct hash）。
        """
        tag = "" if tag is None else str(tag)
        empty = {"hashes": [], "overlap": 0.0, "matched": 0, "targetHashes": 0, "targetChunks": 0}
        if not tag or not namespace:
            return empty
        sid = self._scope_id(namespace)
        if sid is None:
            return empty
        with self.lock:
            row = self.db.execute(
                "select count(*) as chunks, count(distinct hash) as hashes"
                " from chunks where scope_id = ?", (sid,)
            ).fetchone()
            total_hashes = int(row["hashes"] or 0)
            if not total_hashes:
                return empty
            rows = self.db.execute(
                "select distinct c.hash from chunks c join vectors v"
                " on v.tag = ? and v.hash = c.hash where c.scope_id = ?",
                (tag, sid),
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
        """核对"目标确实拥有 + 当前 tag 向量已存在"的精确内容哈希。

        v2 里内容全局共享，"复制"退化为**确认可复用**：
          - `namespace` 给定时只认该作用域 chunks 里确实存在的 hash；
          - 返回 `{blobs, vectors, hashes, truncated}`：blobs/vectors 是**可复用**条数
            （有正文 / 有当前 tag 向量）。
        """
        tag = "" if tag is None else str(tag)
        if not tag:
            raise ValueError("adopt_hashes 需要当前 embedding tag")
        wanted, seen = [], set()
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
        with self.lock:
            if namespace:
                sid = self._scope_id(namespace)
                if sid is None:
                    return {"blobs": 0, "vectors": 0, "hashes": 0, "truncated": truncated}
                allowed = set()
                for part in _chunked(wanted):
                    q = ",".join("?" * len(part))
                    rows = self.db.execute(
                        f"select distinct hash from chunks where scope_id = ? and hash in ({q})",
                        [sid, *part],
                    ).fetchall()
                    allowed.update(r["hash"] for r in rows)
                wanted = [h for h in wanted if h in allowed]
            blobs = vectors = eligible = 0
            for part in _chunked(wanted):
                q = ",".join("?" * len(part))
                have_b = {r["hash"] for r in self.db.execute(
                    f"select hash from blobs where hash in ({q})", part
                ).fetchall()}
                have_v = {r["hash"] for r in self.db.execute(
                    f"select hash from vectors where tag = ? and hash in ({q})", [tag, *part]
                ).fetchall()}
                for h in part:
                    if h in have_b:
                        blobs += 1
                    if h in have_v:
                        vectors += 1
                    if h in have_b and h in have_v:
                        eligible += 1
        return {"blobs": blobs, "vectors": vectors, "hashes": eligible, "truncated": truncated}

    def _maybe_adopt(self, namespace, lineage, tag, simhash):
        """sync 内部的 best-effort adopt（候选 → overlap 门槛 → 精确 hash 核对）。

        调用方负责 catch/rollback；这里只负责按阈值挑第一个合格候选。
        返回 `{fromLineage, fromRepo, similarity, overlap, blobs, vectors}` 或 None。
        """
        if not simhash or not namespace or not lineage or not tag:
            return None
        if not self.scope(namespace):
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

    # ---------------------------------------------------------------- 血统治理
    def lineage_resolve(self, token):
        """把 repoId / lineageId / namespace 解析成血统 id 集合（去重，保序）。

        - 精确命中 lineages.id（整数或数字串）→ 就这一个；
        - 命中 namespace（含 @ 或 #）→ 该作用域的血统；
        - 命中 lineage repo_name / scopes 里 namespace 前缀的 repoId → 这些血统；
        - 都没命中 → ValueError（端点层转 400/404）。
        """
        raw = "" if token is None else str(token).strip()
        if not raw:
            raise ValueError("empty lineage token")
        out, seen = [], set()
        with self.lock:
            if _DIGITS_RE.match(raw):
                row = self.db.execute("select id from lineages where id = ?", (int(raw),)).fetchone()
                if row:
                    out.append(int(row["id"]))
            if not out and ("@" in raw or "#" in raw):
                row = self.db.execute(
                    "select lineage_id from scopes where namespace = ?", (raw,)
                ).fetchone()
                if row:
                    out.append(int(row["lineage_id"]))
            if not out:
                rows = self.db.execute(
                    "select distinct s.lineage_id from scopes s join lineages l on l.id = s.lineage_id"
                    " where lower(coalesce(l.repo_name,'')) = lower(?) or "
                    + repo_id_sql("s") + " = ?",
                    (raw, raw),
                ).fetchall()
                for r in rows:
                    lid = int(r["lineage_id"])
                    if lid not in seen:
                        out.append(lid)
            if not out:
                row = self.db.execute(
                    "select id from lineages where lower(repo_name) = lower(?)", (raw,)
                ).fetchone()
                if row:
                    out.append(int(row["id"]))
        if not out:
            raise ValueError(f"unknown lineage/repo/namespace: {token}")
        for x in out:
            seen.add(x)
        return out

    def lineage_merge(self, from_tokens, into_token):
        """把若干血统合并进目标血统（一次事务，BEGIN IMMEDIATE）。

        v2 不兼容历史数据 → **不留墓碑**：直接把源血统的作用域改挂到目标血统，
        然后物理删掉源血统行（如果它已经空了）。blobs / vectors 是全局内容寻址的，
        合并根本不涉及搬运或删除。

        返回 `{merged, from, into, droppedChunks, droppedVectors, droppedBlobs, freedBytes}`：
        v2 下三个 dropped* 恒为 0（内容全局唯一），保留字段是为了响应契约稳定。
        """
        into_ids = self.lineage_resolve(into_token)
        if len(into_ids) != 1:
            raise ValueError(f"into 必须唯一解析成一个血统，得到 {len(into_ids)} 个：{into_token}")
        into = int(into_ids[0])
        from_lineages = []
        for tok in from_tokens or []:
            for lid in self.lineage_resolve(tok):
                if lid != into and lid not in from_lineages:
                    from_lineages.append(int(lid))
        now = int(time.time())
        merged = []
        with self.lock:
            if self.db.in_transaction:
                self.db.commit()
            self.db.execute("begin immediate")
            try:
                if not self.db.execute("select 1 from lineages where id = ?", (into,)).fetchone():
                    raise ValueError(f"target lineage not found: {into}")
                for src in from_lineages:
                    if not self.db.execute("select 1 from lineages where id = ?", (src,)).fetchone():
                        continue
                    namespaces = [
                        r["namespace"]
                        for r in self.db.execute(
                            "select namespace from scopes where lineage_id = ?", (src,)
                        ).fetchall()
                    ]
                    dropped = 0
                    for ns in namespaces:
                        try:
                            self.db.execute(
                                "update scopes set lineage_id = ?, updated_at = ? where namespace = ?",
                                (into, now, ns),
                            )
                        except sqlite3.IntegrityError:
                            # 目标血统里已经有**等价作用域**（ident 唯一索引冲突）：
                            # v2 的作用域身份不含 repoId，两个克隆看到的同一 (kind,ref,root,chunkFp)
                            # 就是同一个快照 → 先并块（目标优先，同 path+start 保留目标行），
                            # 再把源作用域行删掉（不留墓碑、不留重复身份）。
                            src_row = self.db.execute(
                                "select id, kind, ref, coalesce(root_rel,'') as root_rel, chunk_fp"
                                " from scopes where namespace = ?", (ns,)
                            ).fetchone()
                            if not src_row:
                                continue
                            src_sid = int(src_row["id"])
                            ident = self.db.execute(
                                "select id from scopes where lineage_id = ? and kind = ? and ref = ?"
                                " and coalesce(root_rel,'') = ? and chunk_fp = ?",
                                (into, src_row["kind"], src_row["ref"], src_row["root_rel"],
                                 src_row["chunk_fp"]),
                            ).fetchone()
                            if ident:
                                tid = int(ident["id"])
                                before = int(self.db.execute(
                                    "select count(*) from chunks where scope_id = ?", (src_sid,)
                                ).fetchone()[0])
                                # v2 的 chunks 主键是 (scope_id, path, start_line)：同一 (path,start)
                                # 只能留一份内容 → 目标优先，源侧同位置的行按"被丢弃"计数。
                                cur = self.db.execute(
                                    "insert or ignore into chunks(scope_id, path, start_line,"
                                    " end_line, hash) select ?, path, start_line, end_line, hash"
                                    " from chunks where scope_id = ?",
                                    (tid, src_sid),
                                )
                                dropped += max(0, before - int(cur.rowcount or 0))
                                self.db.execute(
                                    "update scopes set chunk_count = (select count(*) from chunks"
                                    " where scope_id = ?) where id = ?", (tid, tid),
                                )
                            self.db.execute("delete from scopes where namespace = ?", (ns,))
                    self.db.execute("delete from lineages where id = ?", (src,))
                    merged.append({
                        "from": src, "into": into, "namespaces": namespaces,
                        "droppedScopes": dropped,
                    })
                self.db.execute("update lineages set last_seen = ? where id = ?", (now, into))
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise
            self._invalidate()
        return {
            "merged": merged,
            "from": from_lineages,
            "into": into,
            "droppedChunks": 0,
            "droppedVectors": 0,
            "droppedBlobs": 0,
            "droppedScopes": sum(int(m.get("droppedScopes") or 0) for m in merged),
            "freedBytes": 0,
            "freedMb": 0.0,
        }

    def lineage_duplicates(self):
        """重复血统检测（只读，纯 SQL 聚合 + 内存分组）。

        按 repo_name 分组；组内 ≥2 个血统才算重复组；再按 chunk_fp 聚类——
        same_chunk_fp=true 表示组内共享同一 chunk 指纹（同内容仓库裂了多个血统，
        合并收益最大）。suggest = chunks 最多的那个（并列取 last_seen 新者）。

        v2 下 blobs/vectors 全局唯一，合并本身不释放空间，所以 estimates 全为 0
        （字段保留给控制台展示口径）。
        """
        with self.lock:
            rows = self.db.execute(
                "select coalesce(nullif(l.repo_name,''), s.namespace) as grp,"
                f" {repo_id_sql('s')} as repo_id, s.namespace, s.lineage_id, s.chunk_fp,"
                " coalesce(l.last_seen, s.updated_at) as last_seen"
                " from scopes s join lineages l on l.id = s.lineage_id"
            ).fetchall()
            chunk_counts = {
                int(r["scope_id"]): int(r["n"])
                for r in self.db.execute(
                    "select scope_id, count(*) as n from chunks group by scope_id"
                ).fetchall()
            }
            scope_ids = {
                r["namespace"]: int(r["id"])
                for r in self.db.execute("select id, namespace from scopes").fetchall()
            }
        groups = {}
        for r in rows:
            groups.setdefault(r["grp"], []).append(r)
        out = []
        for grp, lst in groups.items():
            lids = []
            for r in lst:
                if int(r["lineage_id"]) not in lids:
                    lids.append(int(r["lineage_id"]))
            if len(lids) < 2:
                continue
            by_lid = {}
            for r in lst:
                lid = int(r["lineage_id"])
                item = by_lid.setdefault(lid, {
                    "id": lid, "repoId": r["repo_id"], "repoIds": [],
                    "namespaces": [], "chunkFps": [], "chunks": 0, "lastSeen": 0,
                })
                if r["repo_id"] not in item["repoIds"]:
                    item["repoIds"].append(r["repo_id"])
                if r["namespace"] not in item["namespaces"]:
                    item["namespaces"].append(r["namespace"])
                if r["chunk_fp"] not in item["chunkFps"]:
                    item["chunkFps"].append(r["chunk_fp"])
                item["chunks"] += int(chunk_counts.get(scope_ids.get(r["namespace"], -1), 0))
                item["lastSeen"] = max(item["lastSeen"], int(r["last_seen"] or 0))
            lineages = [by_lid[lid] for lid in lids]
            suggest = max(lineages, key=lambda x: (x["chunks"], x["lastSeen"]))
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
                    "droppedChunks": 0, "droppedVectors": 0, "droppedBlobs": 0,
                    "freedBytes": 0, "freedMb": 0.0,
                },
            })
        out.sort(key=lambda g: (-max(x["chunks"] for x in g["lineages"]), g["repoName"]))
        return {"groups": out, "generatedAt": int(time.time())}

    def cleanup_lineages(self, min_age_days=0, force=False):
        """清理空血统（没有任何作用域的血统行）。

        v2 没有 merged_into 墓碑，所以"观察期物理清理"整段消失；剩余价值是删掉
        `register_scope()` 早期按 repoId 兜底创建、后来从未挂上作用域的空血统。
        `min_age_days` 给定时只删创建时间早于该天数的空血统；`force=True` 无视年龄。
        """
        min_age_days = int(min_age_days or 0)
        cutoff = int(time.time()) - min_age_days * 86400
        removed = []
        with self.lock:
            sql = ("select l.id from lineages l where not exists"
                   " (select 1 from scopes s where s.lineage_id = l.id)")
            rows = self.db.execute(sql).fetchall()
            for r in rows:
                lid = int(r["id"])
                if not force and min_age_days > 0:
                    row = self.db.execute(
                        "select created_at from lineages where id = ?", (lid,)
                    ).fetchone()
                    if row and int(row["created_at"] or 0) > cutoff:
                        continue
                self.db.execute("delete from lineages where id = ?", (lid,))
                removed.append(lid)
            self.db.commit()
            if removed:
                self._invalidate()
        return {"removed": removed, "removedCount": len(removed)}

    def overview(self):
        return self.scope_overview(limit=50)

    def close(self):
        with self.lock:
            self.db.close()


# ---------------------------------------------------------------- 经验资产（memories）
# 契约见 docs/schema-v2.md §2：
#   · id 是 INTEGER PRIMARY KEY，对外 `exp-%06d`（format_memory_id / parse_memory_id）；
#   · 幂等键是 fingerprint = sha1(category|workflow|lens|what)；
#   · 状态只有 active / retired；冲突是独立表 memory_conflicts（一等公民）；
#   · 证据是 excerpts(sha256 唯一) + memory_excerpts 多对多；
#   · memories_fts 由触发器维护，不再手工双写。

MEMORY_STATUSES = ("active", "retired")
CONFLICT_STATUSES = ("open", "keep_a", "keep_b", "keep_both", "merged")
MEMORY_EVENTS = ("created", "updated", "hit", "adopted", "conflicted", "resolved", "retired", "restored")
MEMORY_ID_PREFIX = "exp-"
_MEMORY_ID_RE = re.compile(r"^exp-\d{1,9}$", re.IGNORECASE)
_MEMORY_MAX_TEXT = 8000          # 单字段字符上限（what/when_expr/why 与代码块正文同量级）
_EXCERPT_MAX_TEXT = 2048         # 证据片段上限（docs/schema-v2.md §2：≤2KB）
MEMORY_LIST_MAX_LIMIT = 200      # 列表分页上限
MEMORY_SEARCH_MAX_TOPK = 20      # search top_k 上限


def format_memory_id(seq):
    """整数主键 → 对外 `exp-000123`（6 位补零，超过 6 位自然加宽）。"""
    return f"{MEMORY_ID_PREFIX}{int(seq):06d}"


def parse_memory_id(value):
    """对外 id / 整数 → 整数主键。非法抛 ValueError（端点层转 404/400）。"""
    if isinstance(value, bool):
        raise ValueError(f"bad memory id: {value!r}")
    if isinstance(value, int):
        if value <= 0:
            raise ValueError(f"bad memory id: {value}")
        return value
    s = str(value or "").strip()
    if not s:
        raise ValueError("empty memory id")
    if _MEMORY_ID_RE.match(s):
        return int(s[len(MEMORY_ID_PREFIX):])
    if _DIGITS_RE.match(s) and int(s) > 0:
        return int(s)
    raise ValueError(f"bad memory id: {s}")


def memory_fingerprint(category, workflow, lens, what):
    """幂等键：sha1(category|workflow|lens|what)；workflow 缺失按空串参与。"""
    raw = "|".join([
        str(category or ""), str(workflow or ""), str(lens or ""), str(what or ""),
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _mem_clean_text(value, field):
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} required")
    return text[:_MEMORY_MAX_TEXT]


def _json_dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class MemoryStore:
    """memories / memory_vectors / excerpts / memory_excerpts / memory_conflicts / memory_events。"""

    def __init__(self, db):
        # db 可以是现成连接（测试直连 store.db 用）或库文件路径。
        # 生产路径必须传**路径**：与 IndexStore 共用一条连接时，IndexStore 自己的写路径
        # （governor 嵌入/sync）不持本类的锁，两路事务在同一条连接上交错会抛
        # "cannot start a transaction within a transaction" → HTTP 500（admin 并发实测触发）。
        # 独立连接后并发由 SQLite 文件锁 + timeout 兜底，表级操作仍受 self.lock 串行。
        if isinstance(db, str):
            self.db = _connect(db)
            self._owns_conn = True
        else:
            self.db = db  # 与调用方共用连接（由各方法加锁）
            self._owns_conn = False
            try:
                self.db.execute("pragma foreign_keys = on")
            except Exception:  # noqa: BLE001
                pass
        self.lock = threading.RLock()

    def close(self):
        """释放自持连接（传入连接的实例不负责关闭）。"""
        if self._owns_conn:
            try:
                self.db.close()
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------ 行工具
    @staticmethod
    def _row_to_memory(row, with_stats=True, evidence=None):
        keys = row.keys()
        item = {
            "id": format_memory_id(row["id"]),
            "category": row["category"],
            "categoryLabel": CATEGORY_LABELS.get(row["category"], row["category"]),
            "lens": row["lens"],
            "lensLabel": LENS_LABELS.get(row["lens"], row["lens"]),
            "workflow": row["workflow"] if "workflow" in keys else None,
            "repo": row["repo"] if "repo" in keys else None,
            "what": row["what"],
            "when_expr": row["when_expr"] or "",
            "why": row["why"] or "",
            "evidence": list(evidence or []),
            "status": row["status"],
            "source": row["source"] or "",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        if "audit" in keys and row["audit"]:
            try:
                item["audit"] = json.loads(row["audit"])
            except (TypeError, ValueError):
                item["audit"] = None
        if with_stats:
            item.update({
                "stats_hits": int(row["hits"] or 0),
                "stats_adopted": int(row["adopted"] or 0),
                "last_hit_at": row["last_hit_at"],
            })
        return item

    def _evidence_for(self, memory_ids):
        """批量取证据（避免 list/get 的 N+1）：{int_id: [excerpt dict]}。"""
        ids = [int(x) for x in memory_ids]
        if not ids:
            return {}
        q = ",".join("?" * len(ids))
        rows = self.db.execute(
            f"select me.memory_id, e.id, e.sha256, e.text, e.kind, e.archive_ref,"
            f" e.captured_at, e.expires_at from memory_excerpts me"
            f" join excerpts e on e.id = me.excerpt_id where me.memory_id in ({q})"
            f" order by e.id",
            ids,
        ).fetchall()
        out = {i: [] for i in ids}
        for r in rows:
            out[int(r["memory_id"])].append({
                "sha256": r["sha256"],
                "text": r["text"],
                "kind": r["kind"],
                "archive_ref": r["archive_ref"],
                "captured_at": int(r["captured_at"]),
                "expires_at": r["expires_at"],
            })
        return out

    def _hydrate(self, rows, with_stats=True):
        evidence = self._evidence_for([r["id"] for r in rows])
        return [self._row_to_memory(r, with_stats, evidence.get(int(r["id"]))) for r in rows]

    def get(self, memory_id, with_stats=True):
        mid = parse_memory_id(memory_id)
        with self.lock:
            row = self.db.execute("select * from memories where id = ?", (mid,)).fetchone()
            if not row:
                return None
            evidence = self._evidence_for([mid]).get(mid, [])
        return self._row_to_memory(row, with_stats, evidence)

    # ------------------------------------------------------------ 证据（CAS）
    def _sha256(self, text):
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def _put_excerpt(self, item, now):
        """一条 evidence → excerpts 行（sha256 CAS），返回 excerpt_id。"""
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            raise ValueError("evidence item must be a string or an object")
        raw_text = item.get("text", item.get("quote"))
        if raw_text is None:
            pointer = item.get("archive_ref") or item.get("issue") or item.get("mr")
            if not pointer:
                raise ValueError("evidence item must carry text / archive_ref / issue / mr")
            raw_text = str(pointer)
        text = str(raw_text).strip()[:_EXCERPT_MAX_TEXT]
        if not text:
            raise ValueError("evidence text required")
        sha = item.get("sha256")
        if not isinstance(sha, str) or not re.match(r"^[0-9a-f]{64}$", sha.strip().lower()):
            sha = self._sha256(text)
        else:
            sha = sha.strip().lower()
        kind = str(item.get("kind") or "quote").strip()[:16] or "quote"
        archive_ref = item.get("archive_ref")
        archive_ref = str(archive_ref).strip()[:200] if archive_ref else None
        cur = self.db.execute(
            "insert or ignore into excerpts(sha256, text, kind, archive_ref, captured_at)"
            " values (?,?,?,?,?)",
            (sha, text, kind, archive_ref, now),
        )
        if not int(cur.rowcount or 0):
            row = self.db.execute("select id from excerpts where sha256 = ?", (sha,)).fetchone()
            return int(row["id"]), False
        return int(cur.lastrowid), True

    def _link_evidence(self, memory_id, evidence):
        """重建一条经验的证据关联（幂等：同 sha256 只存一份，重复引用同一行）。

        `evidence` 为 None **或空数组**时不改动现有证据 —— API 的幂等 upsert 默认不传
        evidence，若把空数组当"清空"会一提交就抹掉已有证据（实测踩到）。
        """
        if evidence is None or evidence == []:
            return 0
        if not isinstance(evidence, list):
            raise ValueError("evidence must be an array of {text|archive_ref|issue|mr}")
        now = int(time.time())
        self.db.execute("delete from memory_excerpts where memory_id = ?", (int(memory_id),))
        linked = 0
        for item in evidence:
            eid, _new = self._put_excerpt(item, now)
            self.db.execute(
                "insert or ignore into memory_excerpts(memory_id, excerpt_id) values (?,?)",
                (int(memory_id), int(eid)),
            )
            linked += 1
        return linked

    # ------------------------------------------------------------ 事件时间线
    def record_event(self, memory_id, event, detail=None, at=None):
        """写一条 memory_events（best-effort：失败不拖垮主流程，返回是否成功）。

        event ∈ created | updated | hit | adopted | conflicted | resolved | retired | restored。
        """
        try:
            mid = parse_memory_id(memory_id)
        except ValueError:
            return False
        try:
            with self.lock:
                self.db.execute(
                    "insert into memory_events(memory_id, at, event, detail) values (?,?,?,?)",
                    (mid, int(at if at is not None else time.time()), str(event or "")[:32],
                     _json_dumps(detail) if detail is not None else None),
                )
                self.db.commit()
            return True
        except Exception:  # noqa: BLE001 —— 时间线是旁路观测，不能挡业务写
            return False

    def timeline(self, memory_id):
        """条目事件时间线（时间倒序）。**不合成**：没有事件就是空数组（v2 无存量）。

        返回 None 表示条目不存在。
        """
        try:
            mid = parse_memory_id(memory_id)
        except ValueError:
            return None
        with self.lock:
            if not self.db.execute("select 1 from memories where id = ?", (mid,)).fetchone():
                return None
            rows = self.db.execute(
                "select at, event, detail from memory_events where memory_id = ?"
                " order by at desc, id desc", (mid,)
            ).fetchall()
        events = []
        for r in rows:
            try:
                detail = json.loads(r["detail"]) if r["detail"] else None
            except (TypeError, ValueError):
                detail = None
            item = {"event": r["event"], "at": int(r["at"])}
            if detail is not None:
                item["detail"] = detail
            events.append(item)
        return events

    # ------------------------------------------------------------ upsert
    def upsert(self, repo, lens, what, when_expr, why, evidence, source, status,
               category=None, workflow=None, audit=None, exp_job_id=None):
        """创建或更新一条经验（幂等键 = fingerprint；重复提交返回 action=updated）。

        参数保持 API 层既有顺序（repo/lens/what/when_expr/why/evidence/source/status），
        v2 追加 category/workflow/audit/exp_job_id。
        返回 ({"id": "exp-000123", "fingerprint": "..."}, "created"|"updated")。
        """
        lens = str(lens or "").strip()
        if lens not in LENS_LABELS:
            raise ValueError("lens must be one of jargon / index / logic")
        category = str(category or "business").strip()
        if category not in CATEGORIES:
            raise ValueError(f"category must be one of {' / '.join(CATEGORIES)}（process 不入库）")
        workflow = None if workflow in (None, "") else str(workflow).strip()[:64]
        repo = None if repo in (None, "") else str(repo).strip()[:200]
        what = _mem_clean_text(what, "what")
        when_expr = str(when_expr or "").strip()[:_MEMORY_MAX_TEXT]
        why = str(why or "").strip()[:_MEMORY_MAX_TEXT]
        source = str(source or "").strip()[:64] or "manual"
        if status in (None, ""):
            status = "active"
        if status not in MEMORY_STATUSES:
            raise ValueError("status must be one of active / retired")
        if audit is not None and not isinstance(audit, (dict, str)):
            raise ValueError("audit must be a JSON object")
        fp = memory_fingerprint(category, workflow, lens, what)
        audit_json = None
        if audit is not None:
            audit_json = audit if isinstance(audit, str) else _json_dumps(audit)
            audit_json = audit_json[:60000]
        job_id = None
        if exp_job_id is not None:
            try:
                job_id = int(exp_job_id)
            except (TypeError, ValueError):
                job_id = None
        now = int(time.time())
        with self.lock:
            if job_id is not None and not self.db.execute(
                "select 1 from exp_jobs where id = ?", (job_id,)
            ).fetchone():
                job_id = None  # 外键兜底：未知 job 就当没给
            row = self.db.execute(
                "select id from memories where fingerprint = ?", (fp,)
            ).fetchone()
            if row:
                mid, is_new = int(row["id"]), False
                self.db.execute(
                    "update memories set category = ?, lens = ?, workflow = ?, repo = ?,"
                    " what = ?, when_expr = ?, why = ?, status = ?, source = ?, audit = coalesce(?, audit),"
                    " exp_job_id = coalesce(?, exp_job_id), updated_at = ? where id = ?",
                    (category, lens, workflow, repo, what, when_expr, why, status, source,
                     audit_json, job_id, now, mid),
                )
            else:
                cur = self.db.execute(
                    "insert into memories(fingerprint, category, lens, workflow, repo, what,"
                    " when_expr, why, status, source, audit, exp_job_id, hits, adopted,"
                    " last_hit_at, created_at, updated_at)"
                    " values (?,?,?,?,?,?,?,?,?,?,?,?,0,0,null,?,?)",
                    (fp, category, lens, workflow, repo, what, when_expr, why, status, source,
                     audit_json, job_id, now, now),
                )
                mid, is_new = int(cur.lastrowid), True
            self._link_evidence(mid, evidence)
            self.db.commit()
        self.record_event(mid, "created" if is_new else "updated",
                          {"repo": repo, "lens": lens, "category": category,
                           "workflow": workflow, "status": status})
        return {"id": format_memory_id(mid), "fingerprint": fp}, ("created" if is_new else "updated")

    # ------------------------------------------------------------ 向量
    def put_vector(self, memory_id, vec, dim):
        """同步嵌入向量（float32 blob，写入 memory_vectors 1:1 表）。"""
        mid = parse_memory_id(memory_id)
        v = np.asarray(vec, dtype=np.float32).reshape(-1)
        now = int(time.time())
        with self.lock:
            if not self.db.execute("select 1 from memories where id = ?", (mid,)).fetchone():
                raise ValueError(f"unknown memory: {memory_id}")
            self.db.execute(
                "insert into memory_vectors(memory_id, tag, dim, vec, updated_at) values (?,?,?,?,?)"
                " on conflict(memory_id) do update set tag = excluded.tag, dim = excluded.dim,"
                " vec = excluded.vec, updated_at = excluded.updated_at",
                (mid, "", int(dim), v.tobytes(order="C"), now),
            )
            self.db.commit()

    # ------------------------------------------------------------ 状态 / 命中
    def set_status(self, memory_id, status):
        """retired（下线）/ active（恢复）的统一入口。"""
        if status not in MEMORY_STATUSES:
            raise ValueError("status must be one of active / retired")
        mid = parse_memory_id(memory_id)
        with self.lock:
            cur = self.db.execute(
                "update memories set status = ?, updated_at = ? where id = ?",
                (status, int(time.time()), mid),
            )
            self.db.commit()
            ok = int(cur.rowcount or 0) > 0
        if ok:
            self.record_event(mid, "retired" if status == "retired" else "restored",
                              {"status": status})
        return ok

    def record_hit(self, memory_id, adopted=False):
        mid = parse_memory_id(memory_id)
        with self.lock:
            cur = self.db.execute(
                "update memories set hits = hits + 1, adopted = adopted + ?,"
                " last_hit_at = ? where id = ?",
                (1 if adopted else 0, int(time.time()), mid),
            )
            self.db.commit()
            if not int(cur.rowcount or 0):
                return None
            row = self.db.execute(
                "select hits, adopted from memories where id = ?", (mid,)
            ).fetchone()
            hits, adopted_n = int(row["hits"]), int(row["adopted"])
        self.record_event(mid, "adopted" if adopted else "hit", {"stats_hits": hits})
        return {"stats_hits": hits, "stats_adopted": adopted_n}

    # ------------------------------------------------------------ 冲突（一等公民）
    def link_conflict(self, conflicting_id, origin_id, trigger_words=None):
        """在 memory_conflicts 里登记一对冲突（双向唯一），双方各记一条 conflicted 事件。

        返回 (ok, against)：against 是对手条目摘要（调用方视角的"既有条目"）。
        """
        try:
            a = parse_memory_id(conflicting_id)
            b = parse_memory_id(origin_id)
        except ValueError:
            return False, None
        if a == b:
            return False, None
        trigger_json = None
        if isinstance(trigger_words, (list, tuple)) and trigger_words:
            trigger_json = _json_dumps([str(t)[:64] for t in trigger_words[:16]])
        now = int(time.time())
        with self.lock:
            origin = self.db.execute("select * from memories where id = ?", (b,)).fetchone()
            if not origin or not self.db.execute(
                "select 1 from memories where id = ?", (a,)
            ).fetchone():
                return False, None
            # UNIQUE(memory_a, memory_b) → 一对冲突只存一行（方向 = 新候选在前）。
            # 反方向已存在（同一对曾被反向登记）就不重复插入，避免收件箱出现两条。
            reverse = self.db.execute(
                "select 1 from memory_conflicts where memory_a = ? and memory_b = ?", (b, a)
            ).fetchone()
            if not reverse:
                self.db.execute(
                    "insert or ignore into memory_conflicts(memory_a, memory_b, trigger_words,"
                    " status, created_at) values (?,?,?,'open',?)",
                    (a, b, trigger_json, now),
                )
            self.db.commit()
            evidence = self._evidence_for([b]).get(b, [])
            against = self._row_to_memory(origin, with_stats=False, evidence=evidence)
        self.record_event(a, "conflicted", {"against": format_memory_id(b),
                                            "trigger_words": trigger_words or []})
        self.record_event(b, "conflicted", {"against": format_memory_id(a), "peer": True})
        return True, against

    def conflicts(self, limit=100, offset=0, status="open"):
        """冲突队列：**open** 的冲突（收件箱「待裁决 N」）。

        item 形状（保持控制台契约）：memory_a 侧字段平铺在顶层（含 id/what/when_expr/
        why/lens/category/repo/evidence），`against` 是 memory_b 侧摘要，
        另有 conflictId / status / trigger_words / created_at。
        """
        cond = "" if status in (None, "", "all") else " where c.status = ?"
        args = [] if not cond else [str(status)]
        with self.lock:
            total = int(self.db.execute(
                "select count(*) from memory_conflicts c" + cond, args
            ).fetchone()[0])
            rows = self.db.execute(
                "select c.id as conflict_id, c.memory_a, c.memory_b, c.trigger_words,"
                " c.status as conflict_status, c.resolution, c.resolved_by, c.resolved_at,"
                " c.created_at as conflict_created_at"
                " from memory_conflicts c" + cond +
                " order by c.created_at desc, c.id desc limit ? offset ?",
                [*args, int(limit), int(offset)],
            ).fetchall()
            ids = []
            for r in rows:
                ids.extend([int(r["memory_a"]), int(r["memory_b"])])
            q = ",".join("?" * len(ids)) or "null"
            mem_rows = {
                int(m["id"]): m
                for m in self.db.execute(
                    f"select * from memories where id in ({q})", ids
                ).fetchall()
            } if ids else {}
            evidence = self._evidence_for(list(mem_rows)) if mem_rows else {}
        items = []
        for r in rows:
            a = mem_rows.get(int(r["memory_a"]))
            b = mem_rows.get(int(r["memory_b"]))
            if not a or not b:
                continue
            try:
                tw = json.loads(r["trigger_words"]) if r["trigger_words"] else []
            except (TypeError, ValueError):
                tw = []
            if not isinstance(tw, list):
                tw = []
            item = self._row_to_memory(a, with_stats=False, evidence=evidence.get(int(r["memory_a"])))
            item.update({
                "conflictId": int(r["conflict_id"]),
                "conflictStatus": r["conflict_status"],
                "status": r["conflict_status"],  # 冲突态在冲突行上，不在 memories.status
                "trigger_words": tw,
                "created_at": int(r["conflict_created_at"]),
                "against_id": format_memory_id(r["memory_b"]),
                "against": {
                    k: v for k, v in
                    self._row_to_memory(b, with_stats=False,
                                        evidence=evidence.get(int(r["memory_b"]))).items()
                    if k in ("id", "what", "when_expr", "why", "lens", "category", "repo", "evidence")
                },
            })
            if r["resolution"]:
                item["resolution"] = r["resolution"]
            if r["resolved_by"]:
                item["resolved_by"] = r["resolved_by"]
            items.append(item)
        return {"items": items, "total": total}

    def resolve_conflict(self, conflict_id, status, resolution=None, resolved_by=None):
        """裁决一条冲突：open|keep_a|keep_b|keep_both|merged（留痕 resolution）。"""
        if status not in CONFLICT_STATUSES:
            raise ValueError(f"status must be one of {' / '.join(CONFLICT_STATUSES)}")
        cid = int(conflict_id)
        now = int(time.time())
        with self.lock:
            row = self.db.execute(
                "select memory_a, memory_b from memory_conflicts where id = ?", (cid,)
            ).fetchone()
            if not row:
                return None
            self.db.execute(
                "update memory_conflicts set status = ?, resolution = ?, resolved_by = ?,"
                " resolved_at = ? where id = ?",
                (status, None if resolution is None else str(resolution)[:2000],
                 None if resolved_by is None else str(resolved_by)[:64], now, cid),
            )
            self.db.commit()
            a, b = int(row["memory_a"]), int(row["memory_b"])
        for mid in (a, b):
            self.record_event(mid, "resolved", {"conflictId": cid, "status": status,
                                                "resolution": resolution})
        return {"conflictId": cid, "status": status}

    def resolve_for_memory(self, memory_id, resolution):
        """把一条经验参与的所有 open 冲突标记为已裁决（/resolve 端点用）。"""
        mid = parse_memory_id(memory_id)
        if resolution == "both":
            status = "keep_both"
            reason = "都保留"
        elif resolution == "retired":
            status = "keep_b"
            reason = "保留对手"
        else:
            status = "keep_a"
            reason = "保留本条"
        with self.lock:
            rows = self.db.execute(
                "select id from memory_conflicts where status = 'open'"
                " and (memory_a = ? or memory_b = ?)", (mid, mid)
            ).fetchall()
        out = []
        for r in rows:
            res = self.resolve_conflict(int(r["id"]), status, reason, "api")
            if res:
                out.append(res)
        return out

    # ------------------------------------------------------------ 查询
    def list(self, repo=None, lens=None, status=None, q=None, limit=50, offset=0,
             stale_days=None, category=None, workflow=None):
        """过滤 + 分页；stale_days 给定时只看 active 且超过 N 天未命中（或从未命中）。

        stale 语义（治理可见性）：`last_hit_at IS NULL OR last_hit_at < now - N*86400`，
        用于 admin「陈旧经验」盘点（长期没人用的条目该复盘/退役）。
        """
        where, params = [], []
        if repo:
            where.append("repo = ?")
            params.append(str(repo))
        if lens:
            where.append("lens = ?")
            params.append(str(lens))
        if category:
            where.append("category = ?")
            params.append(str(category))
        if workflow:
            where.append("workflow = ?")
            params.append(str(workflow))
        if status:
            where.append("status = ?")
            params.append(str(status))
        if q:
            where.append("(what like ? or when_expr like ? or why like ?)")
            params.extend([f"%{q}%"] * 3)
        if stale_days is not None and stale_days > 0:
            where.append("status = 'active' and (last_hit_at is null or last_hit_at < ?)")
            params.append(int(time.time()) - int(stale_days) * 86400)
        cond = (" where " + " and ".join(where)) if where else ""
        with self.lock:
            total = int(self.db.execute(
                "select count(*) from memories" + cond, params
            ).fetchone()[0])
            rows = self.db.execute(
                "select * from memories" + cond + " order by created_at desc, id desc limit ? offset ?",
                params + [int(limit), int(offset)],
            ).fetchall()
            items = self._hydrate(rows)
        return {"items": items, "total": total}

    # ------------------------------------------------------------ 混合检索
    @staticmethod
    def _fts_match_expr(q):
        """把用户查询转成安全的 FTS MATCH 表达式（全部短语化，杜绝语法注入）。

        trigram 分词下：ASCII 与连续中文都按「原文子串」匹配。空查询返回 None（跳过 FTS）。
        """
        tokens = [t for t in (x.strip() for x in re.split(r"\s+", str(q or ""))) if t]
        return " ".join(f'"{t}"' for t in tokens) or None

    def search_fts(self, match_expr, repo=None, lens=None, status="active", limit=None,
                   category=None, workflow=None):
        """FTS5 通道：按名次返回 [(id, bm25)]。短语化表达式保证安全。

        status=True（哨兵）→ 只召回 active（retired 不可见）。
        """
        sql = (
            "select m.id, rank from memories_fts f join memories m on m.id = f.rowid"
            " where memories_fts match ?"
        )
        params = [match_expr]
        if status is True:
            sql += " and m.status = 'active'"
        elif status:
            sql += " and m.status = ?"
            params.append(status)
        if repo:
            sql += " and m.repo = ?"
            params.append(str(repo))
        if lens:
            sql += " and m.lens = ?"
            params.append(str(lens))
        if category:
            sql += " and m.category = ?"
            params.append(str(category))
        if workflow:
            sql += " and m.workflow = ?"
            params.append(str(workflow))
        sql += " order by rank limit ?"
        params.append(int(limit) if limit else 1000)
        return [(int(r["id"]), float(r["rank"])) for r in self.db.execute(sql, params)]

    def _vec_matrix(self, repo=None, lens=None, status="active", dim=None,
                    category=None, workflow=None):
        """读出 (ids, matrix)：经验量小，直接全量载入暴力点积。

        dim 给定时只取同维向量（模型热切换后库内可能混维，异维行直接跳过）。
        """
        sql = (
            "select m.id, mv.dim, mv.vec from memories m join memory_vectors mv"
            " on mv.memory_id = m.id where mv.dim > 0"
        )
        params = []
        if status is True:
            sql += " and m.status = 'active'"
        elif status:
            sql += " and m.status = ?"
            params.append(status)
        if repo:
            sql += " and m.repo = ?"
            params.append(str(repo))
        if lens:
            sql += " and m.lens = ?"
            params.append(str(lens))
        if category:
            sql += " and m.category = ?"
            params.append(str(category))
        if workflow:
            sql += " and m.workflow = ?"
            params.append(str(workflow))
        ids, vecs = [], []
        for r in self.db.execute(sql, params):
            v = np.frombuffer(r["vec"], dtype=np.float32)
            if v.shape[0] != int(r["dim"]):
                continue
            if dim is not None and v.shape[0] != int(dim):
                continue
            ids.append(int(r["id"]))
            vecs.append(v)
        matrix = np.vstack(vecs).astype(np.float32) if vecs else np.zeros((0, 1), dtype=np.float32)
        return ids, matrix

    def search(self, q, qvec=None, repo=None, lens=None, top_k=5, rrf_k=20, status="active",
               category=None, workflow=None):
        """FTS5 + 向量 RRF 融合检索。

        - v2 语义：只召回 **active**（retired 永不出现）；参与开放冲突的条目照样召回，
          并带 `conflictWarning: True`（Memanto 模型：冲突未决仍可召回）；
        - qvec 为 None（embedder 不可用）→ 纯 FTS；FTS 无命中且向量可用 → 纯向量；
        - RRF 与代码检索同法：`rrf += 1/(rrf_k + rank)`，rank 从 1 起；
        - 返回 (hits, channels)，channels 是各通道命中数（诊断/测试用）。
        """
        with self.lock:
            return self._search_locked(q, qvec, repo, lens, top_k, rrf_k, status,
                                       category, workflow)

    def _search_locked(self, q, qvec, repo, lens, top_k, rrf_k, status, category, workflow):
        match_expr = self._fts_match_expr(q)
        fts_hits = (self.search_fts(match_expr, repo, lens, status, limit=1000,
                                    category=category, workflow=workflow)
                    if match_expr else [])
        vec_hits = []
        if qvec is not None:
            qv = np.asarray(qvec, dtype=np.float32).reshape(-1)
            ids, matrix = self._vec_matrix(repo, lens, status, dim=int(qv.shape[0]),
                                           category=category, workflow=workflow)
            if matrix.shape[0]:
                scores = matrix @ qv
                order = np.argsort(-scores)[:1000]
                vec_hits = [(ids[int(i)], float(scores[int(i)]))
                            for i in order if scores[int(i)] > 0]
        merged = {}
        for rank, (mid, _score) in enumerate(fts_hits, 1):
            merged[mid] = {"rrf": 1.0 / (rrf_k + rank), "vec": None}
        for rank, (mid, score) in enumerate(vec_hits, 1):
            cur = merged.get(mid)
            contribution = 1.0 / (rrf_k + rank)
            if cur is None:
                merged[mid] = {"rrf": contribution, "vec": score}
            else:
                cur["rrf"] += contribution
                cur["vec"] = score
        if not merged:
            return [], {"fts": len(fts_hits), "vector": len(vec_hits), "note": None}
        ranked_ids = [mid for mid, _ in sorted(
            merged.items(),
            key=lambda kv: (-kv[1]["rrf"],
                            -(kv[1]["vec"] if kv[1]["vec"] is not None else float("-inf")),
                            kv[0]),
        )][: int(top_k)]
        rows = self.db.execute(
            "select * from memories where id in (%s)" % ",".join("?" * len(ranked_ids)),
            ranked_ids,
        ).fetchall()
        conflict_ids = {
            int(r["memory_a"]) for r in self.db.execute(
                "select memory_a from memory_conflicts where status = 'open' and memory_a in (%s)"
                % ",".join("?" * len(ranked_ids)), ranked_ids
            ).fetchall()
        } | {
            int(r["memory_b"]) for r in self.db.execute(
                "select memory_b from memory_conflicts where status = 'open' and memory_b in (%s)"
                % ",".join("?" * len(ranked_ids)), ranked_ids
            ).fetchall()
        }
        by_id = {int(r["id"]): r for r in rows}
        evidence = self._evidence_for(list(by_id)) if by_id else {}
        hits = []
        for mid in ranked_ids:
            row = by_id.get(mid)
            if not row:
                continue
            item = self._row_to_memory(row, with_stats=False, evidence=evidence.get(mid))
            item["score"] = round(merged[mid]["rrf"], 6)
            if mid in conflict_ids:
                item["conflictWarning"] = True
            hits.append(item)
        return hits, {"fts": len(fts_hits), "vector": len(vec_hits), "note": None}

    def stats(self):
        with self.lock:
            row = self.db.execute(
                "select count(*) as total, coalesce(sum(hits), 0) as hits,"
                " coalesce(sum(adopted), 0) as adopted,"
                " sum(case when status = 'active' then 1 else 0 end) as active,"
                " sum(case when status = 'retired' then 1 else 0 end) as retired"
                " from memories"
            ).fetchone()
            conflicts_open = int(self.db.execute(
                "select count(*) from memory_conflicts where status = 'open'"
            ).fetchone()[0])

            by_cat = self.db.execute(
                "select category, count(*) as n from memories group by category order by n desc"
            ).fetchall()
            by_lens = self.db.execute(
                "select lens, count(*) as n from memories group by lens order by n desc"
            ).fetchall()
            by_wf = self.db.execute(
                "select coalesce(workflow, '') as workflow, count(*) as n from memories"
                " group by 1 order by n desc"
            ).fetchall()
            stale = int(self.db.execute(
                "select count(*) from memories where status = 'active'"
                " and (last_hit_at is null or last_hit_at < ?)",
                (int(time.time()) - 90 * 86400,),
            ).fetchone()[0])
            excerpts = int(self.db.execute("select count(*) from excerpts").fetchone()[0])
            jobs = int(self.db.execute("select count(*) from exp_jobs").fetchone()[0])
        return {
            "total": int(row["total"] or 0),
            "hits": int(row["hits"] or 0),
            "adopted": int(row["adopted"] or 0),
            "active": int(row["active"] or 0),
            "retired": int(row["retired"] or 0),
            "conflictsOpen": conflicts_open,
            "stale": stale,
            "excerpts": excerpts,
            "jobs": jobs,
            "byCategory": [
                {"category": r["category"],
                 "label": CATEGORY_LABELS.get(r["category"], r["category"]),
                 "count": int(r["n"])} for r in by_cat
            ],
            "byLens": [
                {"lens": r["lens"], "label": LENS_LABELS.get(r["lens"], r["lens"]),
                 "count": int(r["n"])} for r in by_lens
            ],
            "byWorkflow": [
                {"workflow": r["workflow"], "count": int(r["n"])} for r in by_wf
            ],
        }


# ---------------------------------------------------------------- 任务与统计（exp_jobs / api_calls）
JOB_STATUSES = ("queued", "running", "done", "failed", "skipped")
JOB_MODES = ("server", "client")
API_GROUPS = ("search", "sync", "bodies", "memories", "admin", "exp")


class JobsStore:
    """exp_jobs（每次抽取一段一条）+ api_calls（调用统计，重启不掉）。

    与 MemoryStore 同一套连接策略（路径 → 自持连接；连接对象 → 共享）。
    """

    def __init__(self, db):
        if isinstance(db, str):
            self.db = _connect(db)
            self._owns_conn = True
        else:
            self.db = db
            self._owns_conn = False
            try:
                self.db.execute("pragma foreign_keys = on")
            except Exception:  # noqa: BLE001
                pass
        self.lock = threading.RLock()

    def close(self):
        if self._owns_conn:
            try:
                self.db.close()
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _row_to_job(row):
        def _j(value):
            if not value:
                return None
            try:
                return json.loads(value)
            except (TypeError, ValueError):
                return None

        def _i(key):
            return int(row[key] or 0)

        return {
            "id": int(row["id"]),
            "session_id": row["session_id"],
            "segment_no": row["segment_no"],
            "workflow": row["workflow"],
            "mode": row["mode"],
            "status": row["status"],
            "model": row["model"],
            "prompt_version": row["prompt_version"],
            "tokens_in": row["tokens_in"],
            "tokens_out": row["tokens_out"],
            "ms": row["ms"],
            "candidates": _i("candidates"),
            "blocked": _i("blocked"),
            "created_n": _i("created_n"),
            "updated_n": _i("updated_n"),
            "skipped_n": _i("skipped_n"),
            "contradicted_n": _i("contradicted_n"),
            "reasons": _j(row["reasons"]),
            "error": row["error"],
            "created_at": int(row["created_at"]),
            "finished_at": row["finished_at"],
        }

    def record(self, payload):
        """登记一条抽取任务（幂等：同 (session_id, segment_no) 视为同一段 → 覆盖更新）。"""
        if not isinstance(payload, dict):
            raise ValueError("job payload must be an object")
        mode = str(payload.get("mode") or "server").strip()
        if mode not in JOB_MODES:
            raise ValueError("mode must be server or client")
        status = str(payload.get("status") or "queued").strip()
        if status not in JOB_STATUSES:
            raise ValueError(f"status must be one of {' / '.join(JOB_STATUSES)}")
        session_id = payload.get("session_id")
        session_id = None if session_id in (None, "") else str(session_id)[:200]
        segment_no = payload.get("segment_no")
        if segment_no in (None, ""):
            segment_no = None
        else:
            try:
                segment_no = int(segment_no)
            except (TypeError, ValueError):
                raise ValueError("segment_no must be an integer")

        def _n(key):
            try:
                return int(payload.get(key) or 0)
            except (TypeError, ValueError):
                return 0

        def _opt_int(key):
            value = payload.get(key)
            if value in (None, ""):
                return None
            try:
                return int(value)
            except (TypeError, ValueError):
                return None

        reasons = payload.get("reasons")
        if reasons is not None and not isinstance(reasons, (dict, list)):
            reasons = None
        now = int(time.time())
        created_at = _opt_int("created_at") or now
        finished_at = _opt_int("finished_at")
        if finished_at is None and status in ("done", "failed", "skipped"):
            finished_at = now
        error = payload.get("error")
        with self.lock:
            existing = None
            if session_id is not None and segment_no is not None:
                existing = self.db.execute(
                    "select id from exp_jobs where session_id = ? and segment_no = ?",
                    (session_id, segment_no),
                ).fetchone()
            if existing:
                jid = int(existing["id"])
                self.db.execute(
                    "update exp_jobs set workflow = ?, mode = ?, status = ?, model = ?,"
                    " prompt_version = ?, tokens_in = ?, tokens_out = ?, ms = ?, candidates = ?,"
                    " blocked = ?, created_n = ?, updated_n = ?, skipped_n = ?, contradicted_n = ?,"
                    " reasons = ?, error = ?, finished_at = ? where id = ?",
                    (payload.get("workflow"), mode, status, payload.get("model"),
                     payload.get("prompt_version"), _opt_int("tokens_in"), _opt_int("tokens_out"),
                     _opt_int("ms"), _n("candidates"), _n("blocked"), _n("created_n"),
                     _n("updated_n"), _n("skipped_n"), _n("contradicted_n"),
                     _json_dumps(reasons) if reasons is not None else None,
                     None if error in (None, "") else str(error)[:2000], finished_at, jid),
                )
            else:
                cur = self.db.execute(
                    "insert into exp_jobs(session_id, segment_no, workflow, mode, status, model,"
                    " prompt_version, tokens_in, tokens_out, ms, candidates, blocked, created_n,"
                    " updated_n, skipped_n, contradicted_n, reasons, error, created_at, finished_at)"
                    " values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (session_id, segment_no, payload.get("workflow"), mode, status,
                     payload.get("model"), payload.get("prompt_version"),
                     _opt_int("tokens_in"), _opt_int("tokens_out"), _opt_int("ms"),
                     _n("candidates"), _n("blocked"), _n("created_n"), _n("updated_n"),
                     _n("skipped_n"), _n("contradicted_n"),
                     _json_dumps(reasons) if reasons is not None else None,
                     None if error in (None, "") else str(error)[:2000], created_at, finished_at),
                )
                jid = int(cur.lastrowid)
            self.db.commit()
            row = self.db.execute("select * from exp_jobs where id = ?", (jid,)).fetchone()
        return self._row_to_job(row)

    def get(self, job_id):
        with self.lock:
            row = self.db.execute("select * from exp_jobs where id = ?", (int(job_id),)).fetchone()
        return self._row_to_job(row) if row else None

    def finish(self, job_id, **fields):
        """收尾一条任务（status/finished_at/统计字段）。返回更新后的行或 None。"""
        jid = int(job_id)
        allowed = ("status", "tokens_in", "tokens_out", "ms", "candidates", "blocked",
                   "created_n", "updated_n", "skipped_n", "contradicted_n", "reasons", "error")
        sets, args = [], []
        for key in allowed:
            if key not in fields:
                continue
            value = fields[key]
            if key in ("reasons",) and isinstance(value, (dict, list)):
                value = _json_dumps(value)
            if key == "status":
                if str(value) not in JOB_STATUSES:
                    raise ValueError(f"status must be one of {' / '.join(JOB_STATUSES)}")
                value = str(value)
            sets.append(f"{key} = ?")
            args.append(value)
        if not sets:
            return self.get(jid)
        sets.append("finished_at = coalesce(?, finished_at)")
        args.append(int(fields.get("finished_at") or time.time()))
        with self.lock:
            self.db.execute(f"update exp_jobs set {', '.join(sets)} where id = ?", [*args, jid])
            self.db.commit()
        return self.get(jid)

    def list_jobs(self, limit=20, offset=0, status=None, session_id=None, workflow=None):
        where, args = [], []
        if status:
            where.append("status = ?")
            args.append(str(status))
        if session_id:
            where.append("session_id = ?")
            args.append(str(session_id))
        if workflow:
            where.append("workflow = ?")
            args.append(str(workflow))
        cond = (" where " + " and ".join(where)) if where else ""
        with self.lock:
            total = int(self.db.execute("select count(*) from exp_jobs" + cond, args).fetchone()[0])
            rows = self.db.execute(
                "select * from exp_jobs" + cond + " order by created_at desc, id desc limit ? offset ?",
                [*args, int(limit), int(offset)],
            ).fetchall()
        return {"items": [self._row_to_job(r) for r in rows], "total": total}

    def job_stats(self):
        with self.lock:
            rows = self.db.execute(
                "select status, count(*) as n, coalesce(sum(candidates),0) as candidates,"
                " coalesce(sum(created_n),0) as created_n, coalesce(sum(updated_n),0) as updated_n,"
                " coalesce(sum(blocked),0) as blocked, coalesce(sum(contradicted_n),0) as contradicted"
                " from exp_jobs group by status"
            ).fetchall()
            last = self.db.execute(
                "select * from exp_jobs order by created_at desc, id desc limit 1"
            ).fetchone()
        by_status = {k: 0 for k in JOB_STATUSES}
        totals = {"candidates": 0, "created": 0, "updated": 0, "blocked": 0, "contradicted": 0}
        for r in rows:
            key = r["status"] or "queued"
            by_status[key] = by_status.get(key, 0) + int(r["n"])
            totals["candidates"] += int(r["candidates"] or 0)
            totals["created"] += int(r["created_n"] or 0)
            totals["updated"] += int(r["updated_n"] or 0)
            totals["blocked"] += int(r["blocked"] or 0)
            totals["contradicted"] += int(r["contradicted"] or 0)
        return {
            "byStatus": by_status,
            "total": sum(by_status.values()),
            "totals": totals,
            "last": self._row_to_job(last) if last else None,
        }

    # ------------------------------------------------------------ 调用统计
    def api_call(self, group_, key_id=None, ms=None, status=None, err=None, at=None):
        """记一条 API 调用（group ∈ search|sync|bodies|memories|admin|exp）。"""
        group_ = str(group_ or "").strip()
        if group_ not in API_GROUPS:
            raise ValueError(f"group must be one of {' / '.join(API_GROUPS)}")
        with self.lock:
            self.db.execute(
                "insert into api_calls(at, group_, key_id, ms, status, err) values (?,?,?,?,?,?)",
                (int(at if at is not None else time.time()), group_,
                 None if key_id in (None, "") else str(key_id)[:64],
                 None if ms is None else int(ms),
                 None if status is None else int(status),
                 None if err in (None, "") else str(err)[:500]),
            )
            self.db.commit()

    def api_stats(self, days=7):
        """按 group 聚合调用统计（admin 趋势图数据源）。"""
        since = int(time.time()) - int(days or 7) * 86400
        with self.lock:
            rows = self.db.execute(
                "select group_, count(*) as n, coalesce(avg(ms),0) as avg_ms,"
                " sum(case when status >= 400 then 1 else 0 end) as errors"
                " from api_calls where at >= ? group by group_ order by n desc",
                (since,),
            ).fetchall()
            total = int(self.db.execute(
                "select count(*) from api_calls where at >= ?", (since,)
            ).fetchone()[0])
        return {
            "days": int(days or 7),
            "total": total,
            "groups": [
                {"group": r["group_"], "count": int(r["n"]),
                 "avgMs": round(float(r["avg_ms"] or 0), 2), "errors": int(r["errors"] or 0)}
                for r in rows
            ],
        }
