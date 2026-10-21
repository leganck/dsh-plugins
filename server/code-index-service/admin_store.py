"""管理侧存储：API Key、调用统计、管理员密码、会话（独立 admin.db，热路径零写库）。

## 为什么单独一个 admin.db
索引库（index.db）是"大表 + 低频写"，管理数据是"小表 + 高频读"：两者放一个库，
每次 Bearer 鉴权都会去撞索引写入的排他锁（WAL 下写者串行），而且替换/重灌索引库时
key 不该跟着丢。分开后鉴权只读 admin.db，且 key 表**全量常驻内存** →
一次请求 0 次磁盘 IO；admin.db 由本模块独占，自测也可以完全脱离模型与索引库。

## 为什么调用统计走"内存聚合 + 定时落库"
一次检索/嵌入请求只产生 1 次 `record()`，但按 (key, day, endpoint) 聚合后要写 2 张表、
2 次 upsert —— 每个请求 2 个写事务在高 QPS 下就是瓶颈，还会拖慢索引同步（SQLite 写者串行）。
这里把事件先在内存里按 (key_id, day, endpoint) 累加，攒够 `FLUSH_EVENTS`（200）次或每
`flush_interval` 秒落一次：热路径只有一次字典加法 + 一把短锁，落盘被放大成 1 事务 / 200 请求。
进程崩溃最多丢一个 flush 窗口的统计——对"调用量看板"完全可以接受。

## 为什么 API Key 只存 sha256
admin.db 会被备份/挂载到别处，明文 key 落库等于把 bearer token 写进磁盘。存 sha256 后
库泄露 ≠ key 泄露（token 是 32 字节随机串，不可反查），展示只需要 prefix（明文前 6 位）
就足够管理员认出是哪把 key。明文只在 `create_key()` 的返回值里出现**一次**，之后无接口可取回。

## 数据模型
- `api_keys`：key 元数据 + sha256；`enabled=0` 的 key 仍然能被 `lookup()` 命中（由调用方决定 401）；
- `usage_daily` / `usage_endpoint`：按天 / 按端点的计数与延迟累加（upsert 增量），保留 `retention_days` 天；
- `settings`：管理员密码（pbkdf2）与会话 HMAC 密钥（懒生成，重启后会话仍有效）；
- 环境变量里的 legacy key（API_KEY）**不落库**：它只以 `key_id=0` 的形式出现在统计里。
"""
import base64
import datetime
import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time

DAY_FMT = "%Y-%m-%d"
ROLES = ("index", "admin")
LEGACY_KEY_ID = 0
LEGACY_KEY_NAME = "legacy/env"

# 攒够这么多条 record() 就立刻落一次盘（正常是定时线程落盘，这里只兜底"突发流量"）
FLUSH_EVENTS = 200
# last_used_at 的落库节流：lookup 命中只改内存并打脏标记，最多这么频繁写一次库
LAST_USED_WRITE = 60.0
PBKDF2_ITER = 200_000
SESSION_SECRET_KEY = "session_secret"
ADMIN_PASSWORD_KEY = "admin_password"

SCHEMA = """
create table if not exists settings(
  key text primary key,
  value text
);
create table if not exists api_keys(
  id integer primary key autoincrement,
  name text not null,
  key_hash text unique not null,
  prefix text not null,
  role text not null default 'index',
  enabled integer not null default 1,
  created_at real not null,
  last_used_at real,
  note text
);
create table if not exists usage_daily(
  key_id integer not null,
  day text not null,
  requests integer not null default 0,
  errors integer not null default 0,
  embed_texts integer not null default 0,
  search_calls integer not null default 0,
  rerank_calls integer not null default 0,
  latency_sum real not null default 0,
  latency_max real not null default 0,
  primary key(key_id, day)
);
create table if not exists usage_endpoint(
  key_id integer not null,
  day text not null,
  endpoint text not null,
  requests integer not null default 0,
  errors integer not null default 0,
  latency_sum real not null default 0,
  primary key(key_id, day, endpoint)
);
"""


def _blank_totals():
    """统计累加器骨架；latencySum/latencyMax 是内部字段，输出时换成 latencyAvg/latencyMax。"""
    return {
        "requests": 0,
        "errors": 0,
        "embedTexts": 0,
        "searchCalls": 0,
        "rerankCalls": 0,
        "latencySum": 0.0,
        "latencyMax": 0.0,
    }


def _add_totals(acc, requests, errors, embed_texts, search_calls, rerank_calls, latency_sum, latency_max):
    """把一行（或一批）计数累加进 acc（dict 原地改）。"""
    acc["requests"] += int(requests)
    acc["errors"] += int(errors)
    acc["embedTexts"] += int(embed_texts)
    acc["searchCalls"] += int(search_calls)
    acc["rerankCalls"] += int(rerank_calls)
    acc["latencySum"] += float(latency_sum)
    lat_max = float(latency_max)
    if lat_max > acc["latencyMax"]:
        acc["latencyMax"] = lat_max


def _avg(latency_sum, requests):
    """平均延迟；延迟是浮点，四舍五入到 6 位只是消掉浮点累加噪声，不改变业务精度。"""
    return round(float(latency_sum) / int(requests), 6) if requests else 0.0


def _b64url(raw):
    """base64url 去 padding（URL/JSON 里都能安全传输）。"""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


class AdminStore:
    def __init__(self, path="/data/admin.db", *, flush_interval=30.0, retention_days=90):
        self.path = path
        self.flush_interval = max(0.01, float(flush_interval))
        self.retention_days = max(1, int(retention_days))
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        # 一把锁同时保护"连接 + 内存缓存 + 统计缓冲"：flush 线程与请求线程共用同一把锁，
        # 保证「统计快照 + 落库」之间不会看到半截状态。RLock 便于内部方法互相调用。
        self._lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma journal_mode = wal")
        self.db.execute("pragma synchronous = normal")
        self.db.executescript(SCHEMA)
        self.db.commit()
        # sha256(key) -> {id,name,role,enabled,key_hash}；lookup 走这里，命中时零 SQL
        self._keys = {}
        # (key_id, day, endpoint) -> [requests, errors, embed_texts, search_calls, rerank_calls,
        #                              latency_sum, latency_max]；flush 前全部累加在内存
        self._pending = {}
        self._events = 0
        # key_id -> 最近一次 lookup 时间（内存里立即生效，落库节流）
        self._last_used = {}
        self._last_used_write = 0.0
        self._last_purge_day = None
        self._secret = None
        self._closed = False
        self._stop = threading.Event()
        self._load_keys()
        # daemon：进程退出不阻塞；正常路径请显式 close()（flush + 停线程）
        self._thread = threading.Thread(target=self._flush_loop, name="admin-store-flush", daemon=True)
        self._thread.start()

    # ---------------------------------------------------------------- 内部：缓存 / 线程
    def _load_keys(self):
        """启动时把 key 表全量读进内存（key 是"个位数~几十"级别，常驻代价可忽略）。"""
        with self._lock:
            rows = self.db.execute("select id, name, key_hash, role, enabled from api_keys").fetchall()
            self._keys = {
                r["key_hash"]: {
                    "id": int(r["id"]),
                    "name": r["name"] or "",
                    "role": r["role"] or "index",
                    "enabled": bool(r["enabled"]),
                    "key_hash": r["key_hash"],
                }
                for r in rows
            }

    def _flush_loop(self):
        # 用 Event.wait 而不是 sleep：close() 能立刻唤醒线程，退出不用等满一个周期
        while not self._stop.wait(self.flush_interval):
            try:
                self.flush()
            except Exception:
                # 后台线程抛异常会静默死掉，导致统计再也不落盘；这里吞掉等下一轮重试
                pass

    # ---------------------------------------------------------------- Key 管理
    def has_keys(self):
        """DB 里是否有任何 key（含 disabled）——用于判断是否要引导初始化第一把 key。"""
        with self._lock:
            return self.db.execute("select 1 from api_keys limit 1").fetchone() is not None

    def count_keys(self):
        with self._lock:
            return int(self.db.execute("select count(*) as n from api_keys").fetchone()["n"])

    def create_key(self, name, role="index", note=""):
        """新建 key；**明文只在本次返回值里出现**，库里只留 sha256。"""
        role = str(role or "index")
        if role not in ROLES:
            raise ValueError(f"role 只能是 {'|'.join(ROLES)}：{role!r}")
        name = str(name or "").strip()
        note = str(note or "")
        now = time.time()
        token = secrets.token_urlsafe(32)  # 32B 随机 → 43 字符，不可猜
        key_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        prefix = token[:6]
        with self._lock:
            cur = self.db.execute(
                "insert into api_keys(name, key_hash, prefix, role, enabled, created_at, last_used_at, note)"
                " values (?,?,?,?,1,?,null,?)",
                (name, key_hash, prefix, role, now, note),
            )
            self.db.commit()
            key_id = int(cur.lastrowid)
            self._keys[key_hash] = {
                "id": key_id,
                "name": name,
                "role": role,
                "enabled": True,
                "key_hash": key_hash,
            }
        return {"id": key_id, "key": token, "prefix": prefix, "name": name, "role": role, "createdAt": now}

    def list_keys(self):
        """列表：绝不返回明文或哈希；today 是"今天"的请求/错误数（含尚未落库的缓冲）。"""
        with self._lock:
            rows = self.db.execute("select * from api_keys order by id").fetchall()
            today = time.strftime(DAY_FMT, time.localtime())
            today_counts = self._today_usage(today)
            return [self._public_key(r, today_counts) for r in rows]

    def set_enabled(self, key_id, enabled):
        """启用/禁用；不存在返回 None。禁用不删数据，随时可恢复。"""
        key_id = int(key_id)
        enabled = bool(enabled)
        with self._lock:
            row = self.db.execute("select * from api_keys where id = ?", (key_id,)).fetchone()
            if row is None:
                return None
            self.db.execute("update api_keys set enabled = ? where id = ?", (1 if enabled else 0, key_id))
            self.db.commit()
            cached = self._keys.get(row["key_hash"])
            if cached is not None:
                cached["enabled"] = enabled
            fresh = dict(row)
            fresh["enabled"] = 1 if enabled else 0
            today_counts = self._today_usage(time.strftime(DAY_FMT, time.localtime()))
            return self._public_key(fresh, today_counts)

    def delete_key(self, key_id):
        """永久删除 key（不存在返回 False）。统计行保留：总量/历史曲线要连续，按 retention 清理。"""
        key_id = int(key_id)
        with self._lock:
            row = self.db.execute("select key_hash from api_keys where id = ?", (key_id,)).fetchone()
            if row is None:
                return False
            self.db.execute("delete from api_keys where id = ?", (key_id,))
            self.db.commit()
            self._keys.pop(row["key_hash"], None)
            self._last_used.pop(key_id, None)
        return True

    def lookup(self, token):
        """Bearer 明文 → {id,name,role,enabled}；未知 token 返回 None。

        内存命中（零 SQL）。hash 比较用 hmac.compare_digest 逐个比，避免字典查找的时序侧信道
        （key 只有个位数~几十把，这点 O(n) 完全可忽略）。disabled 的 key 也会返回（enabled=False），
        由调用方决定返回 401。
        """
        if not isinstance(token, str) or not token:
            return None
        key_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = time.time()
        with self._lock:
            hit = None
            for known, item in self._keys.items():
                if hmac.compare_digest(known, key_hash):
                    hit = item
                    break
            if hit is None:
                return None
            # last_used_at 只改内存（列表立刻能看到），落库交给 flush（最多 60s 一次）
            self._last_used[hit["id"]] = now
            return {"id": hit["id"], "name": hit["name"], "role": hit["role"], "enabled": hit["enabled"]}

    # ---------------------------------------------------------------- 内部：展示用行
    def _public_key(self, row, today_counts):
        """api_keys 行 → 对外的列表项（lastUsedAt 取内存最新值，today 来自计数）。"""
        key_id = int(row["id"])
        db_last = row["last_used_at"]
        mem_last = self._last_used.get(key_id)
        if mem_last is not None and (db_last is None or mem_last > float(db_last)):
            db_last = mem_last
        requests, errors = today_counts.get(key_id, (0, 0))
        return {
            "id": key_id,
            "name": row["name"] or "",
            "prefix": row["prefix"] or "",
            "role": row["role"] or "index",
            "enabled": bool(row["enabled"]),
            "createdAt": float(row["created_at"]),
            "lastUsedAt": db_last,
            "today": {"requests": requests, "errors": errors},
        }

    def _today_usage(self, today):
        """今天每把 key 的 (requests, errors)；调用方需持锁。

        把内存缓冲也并进来：list_keys 是"看板"，不该因为还没到 flush 周期少显示一截当天调用量。
        落库与缓冲的边界由同一把锁保护，不会重复计数。
        """
        out = {}
        for r in self.db.execute("select key_id, requests, errors from usage_daily where day = ?", (today,)):
            out[int(r["key_id"])] = [int(r["requests"]), int(r["errors"])]
        for (key_id, day, _endpoint), v in self._pending.items():
            if day != today:
                continue
            slot = out.setdefault(key_id, [0, 0])
            slot[0] += v[0]
            slot[1] += v[1]
        return {key_id: (value[0], value[1]) for key_id, value in out.items()}

    # ---------------------------------------------------------------- 统计
    def record(self, key_id, endpoint, ok, latency_ms, embed_texts=0, search_calls=0, rerank_calls=0):
        """热路径：只做内存累加（线程安全、**绝不写 SQLite**），攒够 200 条才落盘。"""
        now = time.time()
        day = time.strftime(DAY_FMT, time.localtime(now))
        key_id = int(key_id or 0)
        endpoint = "" if endpoint is None else str(endpoint)
        latency = float(latency_ms or 0.0)
        embed_texts = int(embed_texts or 0)
        search_calls = int(search_calls or 0)
        rerank_calls = int(rerank_calls or 0)
        with self._lock:
            if self._closed:
                return
            slot = self._pending.get((key_id, day, endpoint))
            if slot is None:
                slot = [0, 0, 0, 0, 0, 0.0, 0.0]
                self._pending[(key_id, day, endpoint)] = slot
            slot[0] += 1
            slot[1] += 0 if ok else 1
            slot[2] += embed_texts
            slot[3] += search_calls
            slot[4] += rerank_calls
            slot[5] += latency
            if latency > slot[6]:
                slot[6] = latency
            self._events += 1
            need_flush = self._events >= FLUSH_EVENTS
        # 落盘放在锁外：200 条聚合后是一次小事务，不要占着锁做 IO
        if need_flush:
            self.flush()

    def flush(self):
        """把内存缓冲写进 usage_daily/usage_endpoint（单事务），顺带做节流写入与过期清理。"""
        if self._closed:
            return
        self._flush(force=False)

    def _flush(self, force=False):
        now = time.time()
        with self._lock:
            today = time.strftime(DAY_FMT, time.localtime(now))
            # 过期清理每天最多一次（跨零点后第一次 flush 触发）
            purge_due = today != self._last_purge_day
            # last_used_at 节流：最多每 LAST_USED_WRITE 秒写一次库；close() 时 force=True 兜底
            used_due = force or (now - self._last_used_write) >= LAST_USED_WRITE
            used_items = list(self._last_used.items()) if used_due else []
            if not self._pending and not used_items and not purge_due:
                return
            pending, self._pending = self._pending, {}
            events, self._events = self._events, 0
            try:
                for (key_id, day, endpoint), v in pending.items():
                    # 增量 upsert：并发 flush 不会互相覆盖，重启后数据仍是累加值
                    self.db.execute(
                        "insert into usage_daily(key_id, day, requests, errors, embed_texts, search_calls,"
                        " rerank_calls, latency_sum, latency_max) values (?,?,?,?,?,?,?,?,?)"
                        " on conflict(key_id, day) do update set"
                        " requests = requests + excluded.requests,"
                        " errors = errors + excluded.errors,"
                        " embed_texts = embed_texts + excluded.embed_texts,"
                        " search_calls = search_calls + excluded.search_calls,"
                        " rerank_calls = rerank_calls + excluded.rerank_calls,"
                        " latency_sum = latency_sum + excluded.latency_sum,"
                        " latency_max = max(latency_max, excluded.latency_max)",
                        (key_id, day, v[0], v[1], v[2], v[3], v[4], v[5], v[6]),
                    )
                    self.db.execute(
                        "insert into usage_endpoint(key_id, day, endpoint, requests, errors, latency_sum)"
                        " values (?,?,?,?,?,?)"
                        " on conflict(key_id, day, endpoint) do update set"
                        " requests = requests + excluded.requests,"
                        " errors = errors + excluded.errors,"
                        " latency_sum = latency_sum + excluded.latency_sum",
                        (key_id, day, endpoint, v[0], v[1], v[5]),
                    )
                for key_id, last_used in used_items:
                    self.db.execute(
                        "update api_keys set last_used_at = ? where id = ?", (float(last_used), int(key_id))
                    )
                if purge_due:
                    cutoff = time.strftime(
                        DAY_FMT, time.localtime(now - self.retention_days * 86400)
                    )
                    self.db.execute("delete from usage_daily where day < ?", (cutoff,))
                    self.db.execute("delete from usage_endpoint where day < ?", (cutoff,))
                self.db.commit()
            except Exception:
                # 写失败不能丢数据：回滚后把这一轮缓冲/脏标记并回去，等下一轮重试
                try:
                    self.db.rollback()
                except Exception:
                    pass
                for key, value in pending.items():
                    current = self._pending.get(key)
                    if current is None:
                        self._pending[key] = value
                    else:
                        for i in range(7):
                            if i == 6:
                                current[i] = max(current[i], value[i])
                            else:
                                current[i] += value[i]
                self._events += events
                return
            # 提交成功后才清脏标记（提交前清会让失败那轮丢掉 last_used 更新）
            for key_id, _last_used in used_items:
                self._last_used.pop(key_id, None)
            if used_items:
                self._last_used_write = now
            if purge_due:
                self._last_purge_day = today

    def stats(self, days=7):
        """最近 N 天（1..90）的聚合：totals / byDay / byKey / byEndpoint。

        内存缓冲（尚未落库的部分）同样计入，所以看板数字最多滞后一次锁竞争，不会滞后 30s。
        `byKey` 里 `keyId=0` 是环境变量 legacy key（不落库），显示为 "legacy/env"。
        """
        days = max(1, min(90, int(days)))
        today = datetime.date.today()
        start = today - datetime.timedelta(days=days - 1)
        day_list = [(start + datetime.timedelta(days=i)).isoformat() for i in range(days)]
        day_from, day_to = day_list[0], day_list[-1]

        totals = _blank_totals()
        by_day = {}
        by_key = {}
        by_endpoint = {}
        with self._lock:
            rows = self.db.execute(
                "select key_id, day, requests, errors, embed_texts, search_calls, rerank_calls,"
                " latency_sum, latency_max from usage_daily where day >= ? and day <= ?",
                (day_from, day_to),
            ).fetchall()
            endpoint_rows = self.db.execute(
                "select endpoint, coalesce(sum(requests), 0) as requests,"
                " coalesce(sum(errors), 0) as errors, coalesce(sum(latency_sum), 0) as latency_sum"
                " from usage_endpoint where day >= ? and day <= ? group by endpoint",
                (day_from, day_to),
            ).fetchall()
            key_meta = {
                int(r["id"]): {"name": r["name"] or "", "prefix": r["prefix"] or "", "role": r["role"] or "index"}
                for r in self.db.execute("select id, name, prefix, role from api_keys").fetchall()
            }
            pending = list(self._pending.items())

        for r in rows:
            day = r["day"]
            _add_totals(
                totals, r["requests"], r["errors"], r["embed_texts"], r["search_calls"],
                r["rerank_calls"], r["latency_sum"], r["latency_max"],
            )
            _add_totals(
                by_day.setdefault(day, _blank_totals()), r["requests"], r["errors"],
                r["embed_texts"], r["search_calls"], r["rerank_calls"], r["latency_sum"], r["latency_max"],
            )
            _add_totals(
                by_key.setdefault(int(r["key_id"]), _blank_totals()), r["requests"], r["errors"],
                r["embed_texts"], r["search_calls"], r["rerank_calls"], r["latency_sum"], r["latency_max"],
            )
        for r in endpoint_rows:
            ep = by_endpoint.setdefault(r["endpoint"] or "", {"requests": 0, "errors": 0, "latencySum": 0.0})
            ep["requests"] += int(r["requests"])
            ep["errors"] += int(r["errors"])
            ep["latencySum"] += float(r["latency_sum"])
        # 未落库的缓冲（按 (key, day, endpoint) 聚合）补进来
        for (key_id, day, endpoint), v in pending:
            if day < day_from or day > day_to:
                continue
            _add_totals(totals, v[0], v[1], v[2], v[3], v[4], v[5], v[6])
            _add_totals(by_day.setdefault(day, _blank_totals()), v[0], v[1], v[2], v[3], v[4], v[5], v[6])
            _add_totals(by_key.setdefault(key_id, _blank_totals()), v[0], v[1], v[2], v[3], v[4], v[5], v[6])
            ep = by_endpoint.setdefault(endpoint, {"requests": 0, "errors": 0, "latencySum": 0.0})
            ep["requests"] += v[0]
            ep["errors"] += v[1]
            ep["latencySum"] += v[5]

        def totals_out(acc):
            return {
                "requests": acc["requests"],
                "errors": acc["errors"],
                "embedTexts": acc["embedTexts"],
                "searchCalls": acc["searchCalls"],
                "rerankCalls": acc["rerankCalls"],
                "latencyAvg": _avg(acc["latencySum"], acc["requests"]),
                "latencyMax": round(acc["latencyMax"], 6),
            }

        # byDay 补零：前端画图/对齐日期需要连续的 N 天
        days_out = []
        for day in day_list:
            row = totals_out(by_day.get(day) or _blank_totals())
            days_out.append({"day": day, **row})

        keys_out = []
        for key_id, acc in sorted(by_key.items(), key=lambda item: (-item[1]["requests"], item[0])):
            if key_id == LEGACY_KEY_ID:
                meta = {"name": LEGACY_KEY_NAME, "prefix": "", "role": "legacy"}
            elif key_id in key_meta:
                meta = key_meta[key_id]
            else:
                # key 已删除，但历史统计还在保留期内 —— 给个不误导的名字
                meta = {"name": f"key#{key_id}", "prefix": "", "role": "deleted"}
            keys_out.append(
                {
                    "keyId": key_id,
                    "name": meta["name"],
                    "prefix": meta["prefix"],
                    "role": meta["role"],
                    "requests": acc["requests"],
                    "errors": acc["errors"],
                    "embedTexts": acc["embedTexts"],
                    "searchCalls": acc["searchCalls"],
                    "rerankCalls": acc["rerankCalls"],
                }
            )

        endpoints_out = [
            {
                "endpoint": endpoint,
                "requests": acc["requests"],
                "errors": acc["errors"],
                "latencyAvg": _avg(acc["latencySum"], acc["requests"]),
            }
            for endpoint, acc in sorted(by_endpoint.items(), key=lambda item: (-item[1]["requests"], item[0]))
        ]

        return {
            "days": days,
            "from": day_from,
            "to": day_to,
            "totals": totals_out(totals),
            "byDay": days_out,
            "byKey": keys_out,
            "byEndpoint": endpoints_out,
        }

    # ---------------------------------------------------------------- settings
    def get_setting(self, key, default=None):
        with self._lock:
            row = self.db.execute("select value from settings where key = ?", (str(key),)).fetchone()
        return row["value"] if row is not None else default

    def set_setting(self, key, value):
        with self._lock:
            self.db.execute(
                "insert into settings(key, value) values (?, ?)"
                " on conflict(key) do update set value = excluded.value",
                (str(key), "" if value is None else str(value)),
            )
            self.db.commit()

    # ---------------------------------------------------------------- 管理员密码
    def has_admin_password(self):
        return bool(self.get_setting(ADMIN_PASSWORD_KEY))

    def set_admin_password(self, password):
        """存 pbkdf2-hmac-sha256（20 万次迭代）而不是明文/裸 hash：库泄露后猜密码成本很高。"""
        password = "" if password is None else str(password)
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITER)
        self.set_setting(
            ADMIN_PASSWORD_KEY, f"pbkdf2${PBKDF2_ITER}${salt.hex()}${digest.hex()}"
        )

    def check_admin_password(self, password):
        """常量时间比较；未设置密码返回 False（调用方据此决定是否启用后台登录）。"""
        stored = self.get_setting(ADMIN_PASSWORD_KEY)
        if not stored:
            return False
        password = "" if password is None else str(password)
        try:
            algo, iterations, salt_hex, hash_hex = stored.split("$")
            if algo != "pbkdf2":
                return False
            iterations = int(iterations)
            salt = bytes.fromhex(salt_hex)
            expected = bytes.fromhex(hash_hex)
        except (ValueError, TypeError):
            return False
        if iterations <= 0 or not salt or not expected:
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations, dklen=len(expected)
        )
        return hmac.compare_digest(actual, expected)

    # ---------------------------------------------------------------- 会话（HMAC 签名）
    def _session_secret(self):
        """懒生成 32B 会话密钥并持久化：进程重启后已发出去的会话仍然有效。"""
        if self._secret is not None:
            return self._secret
        with self._lock:
            if self._secret is not None:
                return self._secret
            raw = self.get_setting(SESSION_SECRET_KEY) or ""
            try:
                secret = bytes.fromhex(raw)
            except ValueError:
                secret = b""
            if len(secret) != 32:
                secret = secrets.token_bytes(32)
                self.set_setting(SESSION_SECRET_KEY, secret.hex())
            self._secret = secret
            return secret

    def issue_session(self, ttl=43200):
        """签发会话：`"<exp_unix>.<hmac_sig_b64url>"`，默认 12 小时。不落库（无状态签名）。"""
        exp = int(time.time() + float(ttl))
        msg = f"{exp}"
        sig = hmac.new(self._session_secret(), msg.encode("utf-8"), hashlib.sha256).digest()
        return f"{msg}.{_b64url(sig)}"

    def verify_session(self, token):
        """校验签名 + 是否过期。签名对 `"<exp>"` 做 HMAC-SHA256（不含 ttl/用户信息）。"""
        if not isinstance(token, str) or "." not in token:
            return False
        exp_text, _, sig_text = token.partition(".")
        try:
            exp = int(exp_text)
        except ValueError:
            return False
        if exp < time.time():
            return False
        expected = _b64url(
            hmac.new(self._session_secret(), str(exp).encode("utf-8"), hashlib.sha256).digest()
        )
        return hmac.compare_digest(expected, sig_text)

    # ---------------------------------------------------------------- 生命周期
    def close(self):
        """flush + 停线程 + 关连接；幂等。不依赖 __del__（解释器退出时不可靠）。"""
        if self._closed:
            return
        self._stop.set()
        thread = getattr(self, "_thread", None)
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5.0)
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            self._flush(force=True)  # 最后一次：缓冲 + 脏的 last_used 全部落库
        finally:
            with self._lock:
                self.db.close()
