#!/usr/bin/env python3
"""dsh-code-index 远端索引服务：/embed、/rerank、以及 **/v1 索引层**（同步/嵌入/检索）。

与插件的关系
------------
插件负责**切块 + 本地 BM25**，把「块正文 + (path,start,end,hash)」推给本服务；
本服务负责**向量存储、kNN、重排**，并把命中结果按内容哈希返回。于是：

    本机：BM25(top-40) ─┐
                        ├─ RRF(k=20) → 结果      ← 融合在客户端，BM25 永远可用
    远端：kNN(top-40) ──┘

三条硬规则
----------
1. **复用按血统（lineage）**：`vectors(lineage, tag, hash)`。实测跨无关项目块重合 0.00%，
   按项目血统才能同时拿到"同项目跨分支 ~98% 复用"和"不无谓累积"。
2. **别把 GPU 打满**：嵌入走后台线程 + 限流（默认 10 块/s，P4 峰值的 37%）+ 可暂停。
3. **小响应不要分两次写**：`BaseHTTPRequestHandler` 默认先 header 再 body，实测 LAN 上
   稳定多出 40 ms（Nagle + 延迟 ACK）。这里 `disable_nagle_algorithm = True` 且一次 write()。

端点
----
    GET  /                         自述（设置 API_KEY 后需 Bearer）：模型/tag/治理/作用域概览
    GET  /health                   同上（**免鉴权**，供探活；spaces[] 带 scope，顶层 scopes:{total,byKind}）
    GET  /admin                    后台查看页（单文件 HTML，免鉴权；数据经下方 API 拉取，需填 key）
    GET  /log?n=200                日志尾巴
    POST /embed                    {texts, is_query} -> {vectors_b64, dim, count, ms}   （兼容 0.7.0）
    POST /rerank                   {query, texts, max_tokens} -> {scores, ms}          （兼容 0.7.0）
    POST /v1/repos/{ns}/sync       {repoState, revision?, mode, upsert, remove, tag, url, repoId, chunkFp,
                                    scope?{kind,ref,commit?,ttlDays?}} -> {revision, unchanged, missing[], chunks, vectors, coverage, namespace}
    POST /v1/repos/{ns}/chunks     {bodies:[{hash, body}]} -> {accepted, deduped}
    POST /v1/repos/{ns}/embed      {order?, batch?} -> 入队后台嵌入
    GET  /v1/repos/{ns}/status     -> {revision, chunks, vectors, coverage, pending, paused, rate, lineageBytes, scope{}}
    POST /v1/search                {namespace} 或 {namespaces:[{namespace,weight?}]}, query, k?, tag?,
                                    rerank?:{candidates} -> {hits[]（带 namespace/scope）, ms{}, coverage, byScope[]}
    POST /v1/admin/pause | /resume | /rate | /gc | /sweep
    POST /v1/lineages/{id}/adopt   {from, hashes?} 显式跨血统借用
    GET  /v1/scopes?repoId=&kind=  作用域清单（kind/ref/TTL/占用）
    POST /v1/scopes/resolve        {repoId, chunkFp, kind, ref, commit?} -> {namespace, exists, revision?}
    POST /v1/scopes/{ns}/pin       {pinned, ttlDays?} -> {namespace, pinned, expiresAt}
    DELETE /v1/scopes/{ns}         -> {deleted, chunks}
"""
import base64
import gzip
import hmac
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, unquote

import numpy as np

import index_store
import admin_store
import model_downloader
import models_admin

APP = os.path.dirname(os.path.abspath(__file__))
F = os.environ

MODEL_DIR = F.get("MODEL_DIR", os.path.join(APP, "model"))
MODEL_NAME = F.get("MODEL_NAME", "")
RERANK_DIR = F.get("RERANK_MODEL_DIR", os.path.join(APP, "model-rerank"))
LOG_PATH = F.get("SERVER_LOG", os.path.join(APP, "out", "server.log"))
DB_PATH = F.get("SERVER_DB", os.path.join(APP, "out", "index.db"))
MODELS_DIR = F.get("MODELS_DIR", os.path.join(os.path.dirname(DB_PATH), "models"))
PORT = int(F.get("PORT", "8000"))
THREADS = int(F.get("ORT_THREADS", "6"))
PROVIDERS = F.get("ORT_PROVIDERS", "CUDAExecutionProvider,CPUExecutionProvider").split(",")
EMBED_RATE = float(F.get("EMBED_RATE", "10"))          # 块/秒；0 = 不限速
EMBED_BATCH = int(F.get("EMBED_BATCH", "8"))
RERANK_BATCH = int(F.get("RERANK_BATCH", "8"))
RERANK_MAX_TOKENS = int(F.get("RERANK_MAX_TOKENS", "256"))
KNN_MAX_BYTES = int(float(F.get("KNN_MAX_BYTES", str(2 * 1024**3))))
# 启动后台预热：嵌入会话、重排 CUDA 内核、最大命名空间的 kNN 矩阵。
# 实测冷启首查 2.4 s、首次重排 2.5 s（内核编译），预热后第一个用户查询就是热路径。
WARMUP = F.get("WARMUP", "1") not in ("0", "false", "no")
RETENTION_DAYS = int(F.get("RETENTION_DAYS", "30"))
MAX_VECTORS_PER_LINEAGE = int(F.get("MAX_VECTORS_PER_LINEAGE", "500000"))
MAX_TOTAL_BYTES = int(float(F.get("MAX_TOTAL_GB", "20")) * 1024**3)
API_KEY = F.get("API_KEY", "")            # 索引/检索客户端用：Authorization: Bearer
ADMIN_USER = F.get("ADMIN_USER", "admin")   # 后台页面用 HTTP Basic
ADMIN_PASSWORD = F.get("ADMIN_PASSWORD", "")  # 空 = 后台 Basic 不启用
FAKE_EMBED = F.get("FAKE_EMBED", "") not in ("", "0", "false")
MAX_TEXTS = 512
MAX_TEXT_CHARS = 8000

# ---------------- 档 3：作用域（快照）生命周期 ----------------
# TTL 单位是"天"；main / legacy 永久。janitor 周期见 SCOPE_SWEEP_INTERVAL。
SCOPE_TTL_BRANCH = int(F.get("SCOPE_TTL_BRANCH", "30"))
SCOPE_TTL_PR = int(F.get("SCOPE_TTL_PR", "14"))
SCOPE_TTL_WORKTREE = int(F.get("SCOPE_TTL_WORKTREE", "1"))
SCOPE_TTL = {"branch": SCOPE_TTL_BRANCH, "pr": SCOPE_TTL_PR, "worktree": SCOPE_TTL_WORKTREE,
             "main": None, "legacy": None}
SCOPE_SWEEP = F.get("SCOPE_SWEEP", "1") not in ("0", "false", "no")
SCOPE_SWEEP_INTERVAL = max(1, int(float(F.get("SCOPE_SWEEP_INTERVAL", "3600"))))
SCOPE_SWEEP_FIRST_DELAY = max(0, int(float(F.get("SCOPE_SWEEP_FIRST_DELAY", "30"))))  # 避开 warmup
MAX_SCOPES = int(F.get("MAX_SCOPES", "200"))
MAX_SEARCH_SCOPES = int(F.get("MAX_SEARCH_SCOPES", "4"))
RRF_K = 20  # 与插件 lib/search.js 的 RRF_K 保持一致

# 后台「模型下载」：白名单目录 + 后台线程；文件落在 /data/models 卷里
MODEL_CATALOG = F.get("MODEL_CATALOG", "")
downloader = model_downloader.ModelDownloader(MODELS_DIR, model_downloader.load_catalog(MODEL_CATALOG))

# 管理侧：API Key / 调用统计 / 管理员密码 / 会话（独立 admin.db，不碰 1.6GB 的 index.db）
ADMIN_DB = F.get("SERVER_ADMIN_DB", os.path.join(os.path.dirname(DB_PATH), "admin.db"))
SESSION_TTL = float(F.get("SESSION_TTL", "43200"))  # 12h
adm = admin_store.AdminStore(ADMIN_DB)

# 模型热切换：白名单目录（镜像内置 /models + 下载目录 /data/models + 可选额外目录）
MODEL_ROOTS = [p.strip() for p in F.get("MODEL_ROOTS", "/models,/data/models").split(",") if p.strip()]
MODEL_ROOTS += [p.strip() for p in F.get("MODEL_EXTRA_DIRS", "").split(os.pathsep) if p.strip()]
MODEL_LOCK = threading.RLock()  # embed/热切换互斥：切换时不能被推理线程用到半旧半新状态
ACTIVE = {"embed_dir": MODEL_DIR, "embed_name": MODEL_NAME, "rerank_dir": RERANK_DIR}
LOGIN_FAILS = {}  # ip -> [ts...]，简单登录限速（5 次 / 5 分钟）

# 端点分组：统计按组聚合，避免 path 高基数（/v1/repos/<ns>/... 每个 ns 一行）
def _endpoint_group(path):
    if path == "/embed":
        return "embed"
    if path == "/rerank":
        return "rerank"
    if path == "/v1/search":
        return "search"
    if path.startswith("/v1/repos/") and path.endswith("/sync"):
        return "sync"
    if path.startswith("/v1/repos/") and (path.endswith("/chunks") or path.endswith("/vectors")):
        return "vectors"
    if path.startswith("/v1/repos/") and path.endswith("/embed"):
        return "embed-queue"
    if path.startswith("/v1/admin/"):
        return "admin"
    if path.startswith("/v1/scopes") or path.startswith("/v1/spaces") or path.startswith("/v1/lineages/"):
        return "scopes"
    if path in ("/", "/health", "/v1/status", "/log"):
        return "status"
    return "other"


# 统计页只展示"业务用量"：系统/轮询请求单独归类，不进入 KPI 与主图
STATS_CATEGORY_GROUPS = {
    "retrieval": ("search", "rerank"),
    "embedding": ("embed",),
    "indexing": ("sync", "vectors", "embed-queue"),
    "system": ("status", "scopes", "admin", "other"),
}


def _stats_category(group):
    for category, groups in STATS_CATEGORY_GROUPS.items():
        if group in groups:
            return category
    return "system"


def _enrich_stats(data):
    """给 /v1/admin/stats 补业务分类、按天分类计数、按作用域元信息。"""
    categories = {name: {"requests": 0, "errors": 0, "latencySum": 0.0} for name in STATS_CATEGORY_GROUPS}

    def add_category(acc, endpoint, requests, errors, latency_avg):
        category = _stats_category(endpoint or "")
        slot = acc[category]
        slot["requests"] += int(requests or 0)
        slot["errors"] += int(errors or 0)
        slot["latencySum"] += float(latency_avg or 0.0) * int(requests or 0)

    for item in data.get("byEndpoint") or []:
        add_category(categories, item.get("endpoint"), item.get("requests"), item.get("errors"),
                     item.get("latencyAvg"))
    data["categories"] = {
        name: {"requests": slot["requests"], "errors": slot["errors"],
               "latencyAvg": round(slot["latencySum"] / slot["requests"], 6) if slot["requests"] else 0.0}
        for name, slot in categories.items()
    }

    prev_categories = {name: {"requests": 0, "errors": 0, "latencySum": 0.0} for name in STATS_CATEGORY_GROUPS}
    for item in data.get("prevByEndpoint") or []:
        add_category(prev_categories, item.get("endpoint"), item.get("requests"), item.get("errors"),
                     item.get("latencyAvg"))
    data["prevCategories"] = {
        name: {"requests": slot["requests"], "errors": slot["errors"],
               "latencyAvg": round(slot["latencySum"] / slot["requests"], 6) if slot["requests"] else 0.0}
        for name, slot in prev_categories.items()
    }

    day_categories = {}
    for item in data.get("byDayEndpoint") or []:
        category = _stats_category(item.get("endpoint") or "")
        slot = day_categories.setdefault(item["day"], {name: 0 for name in STATS_CATEGORY_GROUPS})
        slot[category] += int(item.get("requests") or 0)
    for day in data.get("byDay") or []:
        slot = day_categories.get(day.get("day")) or {}
        for name in STATS_CATEGORY_GROUPS:
            day[name + "Requests"] = int(slot.get(name, 0))

    scope_map = {}
    if store:
        try:
            for item in store.scope_overview(limit=MAX_SCOPES):
                scope_map[item.get("namespace")] = item
        except Exception:  # noqa: BLE001 —— 补元信息失败不影响统计
            pass
    for item in data.get("byScope") or []:
        known = scope_map.get(item.get("namespace"))
        if known:
            scope = known.get("scope") or {}
            item.update({
                "repoName": known.get("repo_name"),
                "kind": scope.get("kind") or "legacy",
                "ref": scope.get("ref"),
                "chunks": known.get("chunks"),
                "vectors": known.get("vectors"),
                "coverage": known.get("coverage"),
                "missing": False,
            })
        else:
            item.update({"repoName": None, "kind": None, "ref": None, "chunks": None,
                         "vectors": None, "coverage": None, "missing": True})
    return data


os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

# 站点图标（浏览器标签页/收藏夹）：单文件随镜像 COPY；缺失时退回纯色方块，不影响启动
try:
    with open(os.path.join(APP, "favicon.svg"), "rb") as _fav:
        FAVICON_SVG = _fav.read()
except OSError:
    FAVICON_SVG = (
        b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        b'<rect width="64" height="64" rx="14" fill="#2563eb"/></svg>'
    )


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ---------------- 管理页面（GET /admin）----------------
# 单文件、无依赖：页面壳不需要鉴权，数据一律走后端 API（API_KEY 开启时需在页面里填 key）。
# 只做"查看 + 治理"（暂停/恢复/清扫），删除作用域等破坏性操作留给 curl。
ADMIN_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>code-index-service · 控制台</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  :root { --bg:#f5f6f8; --card:#fff; --line:#e4e7ec; --text:#1b1f24; --muted:#667085; --faint:#98a2b3;
          --ok:#067647; --ok-bg:#e7f6ec; --warn:#b54708; --warn-bg:#fef4e6; --bad:#b42318; --bad-bg:#fdecea;
          --blue:#175cd3; --blue-bg:#eff4ff; --purple:#5925dc; --purple-bg:#f4f0ff; --mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1016; --card:#161a22; --line:#262c37; --text:#e7e9ee; --muted:#98a2b3; --faint:#667085;
            --ok:#75e0a7; --ok-bg:#0f2e1d; --warn:#fdb022; --warn-bg:#33240d; --bad:#fda29b; --bad-bg:#3a1512;
            --blue:#84adff; --blue-bg:#12203f; --purple:#c3b5fd; --purple-bg:#241a4d; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:13px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .mono { font-family:var(--mono); }
  header { display:flex; align-items:center; gap:10px; padding:11px 20px; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; z-index:20; flex-wrap:wrap; }
  .brand { display:flex; align-items:baseline; gap:8px; }
  .logo { display:inline-flex; width:22px; height:22px; border-radius:6px; background:linear-gradient(135deg,#2563eb,#7c3aed); color:#fff; font:600 11px/22px var(--mono); justify-content:center; }
  h1 { font-size:15px; margin:0; font-weight:650; letter-spacing:.2px; }
  .sub { color:var(--muted); font-size:12px; }
  .spacer { flex:1; }
  button { padding:6px 11px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; font-size:12.5px; transition:.15s; }
  button:hover { border-color:var(--muted); }
  button.primary { border-color:var(--blue); color:var(--blue); }
  button.danger { border-color:var(--bad); color:var(--bad); }
  button:disabled { opacity:.45; cursor:default; }
  input, select { padding:6px 9px; border-radius:7px; border:1px solid var(--line); background:var(--bg); color:var(--text); font-size:12.5px; }
  .chip { display:inline-flex; align-items:center; gap:5px; padding:2px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--muted); background:var(--card); white-space:nowrap; }
  .chip.ok { color:var(--ok); background:var(--ok-bg); border-color:transparent; }
  .chip.bad { color:var(--bad); background:var(--bad-bg); border-color:transparent; }
  .chip.warn { color:var(--warn); background:var(--warn-bg); border-color:transparent; }
  .chip.blue { color:var(--blue); background:var(--blue-bg); border-color:transparent; }
  .dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
  nav.tabs { display:flex; gap:2px; padding:0 14px; background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:48px; z-index:15; overflow-x:auto; }
  nav.tabs button { border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--muted); padding:10px 14px; font-size:13px; white-space:nowrap; }
  nav.tabs button.active { color:var(--text); border-bottom-color:var(--blue); font-weight:600; }
  main { padding:16px 20px 30px; }
  .panel { display:none; }
  .panel.active { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; min-width:0; }
  .card h2 { font-size:12px; margin:0 0 10px; font-weight:600; color:var(--muted); letter-spacing:.4px; text-transform:uppercase; display:flex; align-items:center; gap:8px; }
  .card h2 .tail { margin-left:auto; font-weight:400; text-transform:none; letter-spacing:0; font-size:11.5px; }
  .kv { display:grid; grid-template-columns:100px 1fr; gap:6px 12px; font-size:12.5px; align-items:baseline; }
  .kv .k { color:var(--muted); }
  .kv .v { min-width:0; overflow-wrap:anywhere; }
  .wide { grid-column:1/-1; }
  .toolbar { display:flex; align-items:center; gap:10px; margin:0 0 10px; flex-wrap:wrap; }
  .toolbar input[type=search] { flex:1; min-width:180px; max-width:320px; }
  .toolbar label { display:inline-flex; align-items:center; gap:5px; color:var(--muted); font-size:12px; }
  .table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:10px; }
  table { width:100%; border-collapse:separate; border-spacing:0; font-size:12.5px; }
  thead th { position:sticky; top:0; background:var(--card); color:var(--muted); font-weight:600; text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); white-space:nowrap; z-index:2; }
  tbody td { padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:middle; white-space:nowrap; }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr:hover td { background:color-mix(in srgb, var(--bg) 60%, transparent); }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .kind { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11.5px; font-family:var(--mono); background:var(--bg); border:1px solid var(--line); }
  .kind.main { color:var(--ok); background:var(--ok-bg); border-color:transparent; }
  .kind.branch { color:var(--blue); background:var(--blue-bg); border-color:transparent; }
  .kind.pr { color:var(--warn); background:var(--warn-bg); border-color:transparent; }
  .kind.worktree { color:var(--purple); background:var(--purple-bg); border-color:transparent; }
  .cov { display:flex; align-items:center; gap:7px; min-width:110px; }
  .bar { height:6px; width:88px; background:var(--line); border-radius:99px; overflow:hidden; flex:none; }
  .bar > i { display:block; height:100%; border-radius:99px; background:var(--ok); }
  .bar.warn > i { background:var(--warn); } .bar.bad > i { background:var(--bad); }
  .bar.blue > i { background:var(--blue); }
  .bar.purple > i { background:var(--purple); }
  .bar.ok > i { background:var(--ok); }
  .muted { color:var(--muted); } .faint { color:var(--faint); }
  .ns { font-family:var(--mono); font-size:11.5px; color:var(--muted); max-width:220px; overflow:hidden; text-overflow:ellipsis; display:inline-block; vertical-align:middle; }
  .copy { border:0; background:transparent; color:var(--faint); cursor:pointer; padding:0 2px; font-size:12px; }
  .copy:hover { color:var(--blue); }
  .empty { padding:22px 10px; text-align:center; color:var(--muted); }
  details.help { margin-top:12px; color:var(--muted); font-size:12.5px; }
  details.help summary { cursor:pointer; user-select:none; }
  details.help .grid { display:grid; gap:6px 18px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); margin-top:10px; }
  details.help b { color:var(--text); font-weight:600; }
  #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(10px); background:var(--text); color:var(--bg); padding:7px 14px; border-radius:8px; font-size:12.5px; opacity:0; pointer-events:none; transition:.2s; z-index:50; }
  #toast.show { opacity:.95; transform:translateX(-50%) translateY(0); }
  #banner { display:none; margin:12px 20px 0; padding:10px 13px; border-radius:9px; border:1px solid var(--warn); background:var(--warn-bg); color:var(--warn); font-size:12.5px; }
  #banner.bad { border-color:var(--bad); background:var(--bad-bg); color:var(--bad); }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; }
  .stat { border:1px solid var(--line); border-radius:10px; padding:10px 12px; background:var(--card); }
  .stat .n { font-size:19px; font-weight:650; font-variant-numeric:tabular-nums; }
  .stat .l { color:var(--muted); font-size:11.5px; margin-top:2px; }
  .spark { display:flex; align-items:flex-end; gap:3px; height:86px; padding-top:6px; }
  .spark .col { flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; gap:3px; min-width:0; }
  .spark .col i { display:block; width:100%; border-radius:3px 3px 0 0; background:var(--blue); min-height:2px; opacity:.85; }
  .spark .col:hover i { opacity:1; }
  .spark .col span { font-size:10px; color:var(--faint); transform:scale(.92); white-space:nowrap; }
  .model-box { border:1px solid var(--line); border-radius:10px; padding:11px 13px; margin-bottom:10px; }
  .model-box .head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .model-box .head b { font-size:13px; }
  .grid2 { display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
  .key-reveal { display:none; margin:10px 0; border:1px solid var(--ok); background:var(--ok-bg); color:var(--ok); border-radius:9px; padding:10px 12px; }
  .key-reveal .mono { word-break:break-all; color:var(--text); }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .seg button { border:0; border-radius:0; background:var(--card); padding:5px 10px; font-size:12px; color:var(--muted); }
  .seg button.active { background:var(--blue-bg); color:var(--blue); font-weight:600; }
  .login-hint { color:var(--muted); font-size:12px; }
  .chart { display:flex; align-items:flex-end; gap:2px; height:150px; padding:4px 2px 0; border-bottom:1px solid var(--line); }
  .chart .col { flex:1; height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; gap:2px; min-width:0; }
  .chart .bars { flex:1; width:100%; display:flex; align-items:flex-end; justify-content:center; gap:1px; min-height:0; }
  .chart .bars i { display:block; width:44%; border-radius:2px 2px 0 0; background:var(--blue); min-height:1px; }
  .chart .bars i.err { background:var(--bad); }
  .chart .bars i.lat { width:70%; background:var(--purple); }
  .chart .stack { flex:1; width:100%; height:100%; display:flex; flex-direction:column; justify-content:flex-end; gap:1px; }
  .chart .stack i { display:block; width:100%; min-height:1px; border-radius:1px; }
  .chart .stack i.s-ret { background:var(--blue); }
  .chart .stack i.s-idx { background:var(--purple); }
  .chart .stack i.s-emb { background:var(--ok); }
  .chart .x { font-size:9.5px; color:var(--faint); white-space:nowrap; line-height:1.2; }
  .chart .col:hover .bars i { opacity:.8; }
  .legend { display:flex; align-items:center; gap:10px; margin-top:6px; font-size:11px; color:var(--muted); flex-wrap:wrap; }
  .legend .lg { width:9px; height:9px; border-radius:2px; display:inline-block; background:var(--blue); }
  .legend .lg.err { background:var(--bad); } .legend .lg.lat { background:var(--purple); }
  .legend .lg.idx { background:var(--purple); } .legend .lg.emb { background:var(--ok); }
  .mix { display:grid; gap:8px; }
  .mix .row { display:grid; grid-template-columns:78px 1fr 120px; align-items:center; gap:10px; font-size:12px; }
  .mix .bar { width:100%; }
  .mix .num { text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; }
  .delta { font-size:11px; margin-left:4px; color:var(--muted); }
  .delta.up { color:var(--bad); } .delta.down { color:var(--ok); }
  .stat .sub { color:var(--faint); font-size:11px; margin-left:3px; }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="logo">CI</span><h1>code-index-service</h1><span class="sub">控制台</span></div>
  <span id="ready" class="chip"><span class="dot"></span>加载中</span>
  <span id="model" class="chip mono" title="当前向量模型 tag">—</span>
  <span id="authchip" class="chip"></span>
  <span class="spacer"></span>
  <span id="refreshed" class="faint" style="font-size:12px"></span>
  <button id="btn-refresh">刷新</button>
  <button id="btn-pause">暂停嵌入</button>
  <button id="btn-resume">恢复嵌入</button>
  <button id="btn-sweep">立即清扫</button>
  <button id="btn-logout">退出</button>
</header>
<nav class="tabs">
  <button data-tab="overview" class="active">概览</button>
  <button data-tab="models">模型</button>
  <button data-tab="keys">API Key</button>
  <button data-tab="stats">统计</button>
  <button data-tab="scopes">作用域</button>
  <button data-tab="logs">日志</button>
</nav>
<div id="banner"></div>
<main>
  <!-- ============================ 概览 ============================ -->
  <section id="tab-overview" class="panel active">
    <section class="card">
      <h2>运行时</h2>
      <div class="kv" id="runtime"><div class="k">加载中…</div><div class="v"></div></div>
    </section>
    <section class="card">
      <h2>嵌入治理</h2>
      <div class="kv" id="governor"><div class="k">加载中…</div><div class="v"></div></div>
    </section>
    <section class="card">
      <h2>存储与限额</h2>
      <div class="kv" id="limits"><div class="k">加载中…</div><div class="v"></div></div>
    </section>
    <section class="card">
      <h2>向量标签 <span class="tail"><button id="btn-purge-tags" style="padding:2px 8px">清理旧 tag</button></span></h2>
      <div class="kv" id="tags"><div class="k">加载中…</div><div class="v"></div></div>
    </section>
    <section class="card wide">
      <h2>鉴权状态</h2>
      <div class="kv" id="auth-kv"><div class="k">加载中…</div><div class="v"></div></div>
      <div id="setup-box" style="display:none;margin-top:12px;border-top:1px dashed var(--line);padding-top:12px">
        <div class="login-hint" style="margin-bottom:8px">还没有管理员密码。设置后控制台需要登录（也可继续用环境变量 ADMIN_PASSWORD）。</div>
        <input id="setup-pwd" type="password" placeholder="设置管理员密码（至少 8 位）" style="min-width:260px">
        <button class="primary" id="btn-setup">设置密码</button>
      </div>
    </section>
  </section>

  <!-- ============================ 模型 ============================ -->
  <section id="tab-models" class="panel">
    <section class="card wide">
      <h2>当前模型</h2>
      <div class="grid2" id="active-models"></div>
    </section>
    <section class="card wide">
      <h2>已安装模型 <span class="tail faint" id="model-roots"></span></h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>用途</th><th>名称</th><th>向量 tag</th><th>目录</th><th class="num">大小</th><th>状态</th><th>操作</th></tr></thead>
          <tbody id="installed"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
        </table>
      </div>
      <div class="faint" style="font-size:11.5px;margin-top:8px">切换后：<b>/health.tag</b> 立即变化，旧 tag 向量保留但检索不到；插件下次同步会按新 tag 全量重嵌（覆盖率从 0 恢复）。失败会自动保留原模型。</div>
    </section>
    <section class="card wide">
      <h2>可下载模型</h2>
      <div id="models" class="faint" style="font-size:12.5px">加载中…</div>
    </section>
  </section>

  <!-- ============================ Key ============================ -->
  <section id="tab-keys" class="panel">
    <section class="card wide">
      <h2>API Key</h2>
      <div class="stats" id="key-stats"></div>
      <div class="toolbar" style="margin-top:14px">
        <input id="key-name" placeholder="名称，例如：本机插件 / review-service" style="min-width:200px">
        <select id="key-role">
          <option value="index">index · 索引/检索服务</option>
        </select>
        <button class="primary" id="btn-create-key">新建 Key</button>
        <span class="faint" style="font-size:12px">明文只显示一次；服务端只存 sha256</span>
      </div>
      <div class="faint" id="key-role-hint" style="font-size:11.5px;margin:-4px 0 10px"></div>
      <div class="key-reveal" id="key-reveal">
        <div style="margin-bottom:6px">新 Key（只显示这一次，请复制保存）：</div>
        <div class="mono" id="key-plain">—</div>
        <div class="toolbar" style="margin:8px 0 0">
          <button id="btn-copy-key">复制</button>
          <button class="primary" id="btn-test-key">测试访问索引服务</button>
          <span id="key-test-out" class="faint" style="font-size:11.5px"></span>
        </div>
      </div>
      <div class="toolbar" style="margin-top:12px">
        <input id="key-filter" type="search" placeholder="筛选名称 / 前缀 / 角色…">
        <span class="faint" id="key-filtered"></span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>名称</th><th>前缀</th><th>角色 / 权限</th><th>状态</th><th class="num">今日请求</th><th class="num">今日错误</th><th>最后使用</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody id="keys"><tr><td colspan="9" class="empty">加载中…</td></tr></tbody>
        </table>
      </div>
      <div class="faint" style="font-size:11.5px;margin-top:8px">index Key 可调用索引/检索全部接口（sync / chunks / vectors / search / status / scopes），不能进控制台管理。<br>新建 Key 固定为 index 角色；admin 角色仅保留给既有 Key，不再从页面新建。</div>
      <div class="faint" id="key-legacy-note" style="font-size:11.5px;margin-top:6px">加载中…</div>
    </section>
  </section>

  <!-- ============================ 统计 ============================ -->
  <section id="tab-stats" class="panel">
    <section class="card wide">
      <h2>调用统计 <span class="tail">
        <span class="seg" id="stats-range">
          <button data-days="1">今日</button>
          <button data-days="7" class="active">近 7 天</button>
          <button data-days="30">近 30 天</button>
        </span>
        <label><input id="stats-auto" type="checkbox" checked> 自动刷新</label>
        <button id="btn-stats-refresh">刷新</button>
        <button id="btn-stats-export">导出 CSV</button>
      </span></h2>
      <div class="faint" id="stats-meta" style="font-size:11.5px;margin-bottom:10px">加载中…</div>
      <div class="stats" id="stat-cards"></div>
    </section>
    <section class="card wide">
      <h2>趋势 <span class="tail faint" id="stat-range-label"></span></h2>
      <div class="grid2">
        <div>
          <div class="faint" style="font-size:11.5px;margin-bottom:6px">每日业务请求（检索 / 索引 / 嵌入，不含系统轮询）</div>
          <div class="chart" id="stat-trend"></div>
          <div class="legend"><span class="lg req"></span>检索/重排 <span class="lg idx"></span>索引操作 <span class="lg emb"></span>嵌入</div>
        </div>
        <div>
          <div class="faint" style="font-size:11.5px;margin-bottom:6px">每日平均延迟</div>
          <div class="chart" id="stat-latency"></div>
          <div class="legend"><span class="lg lat"></span>全部请求平均延迟（悬停看当日最大/请求数）</div>
        </div>
      </div>
      <div style="margin-top:16px">
        <div class="faint" style="font-size:11.5px;margin-bottom:6px">业务请求构成</div>
        <div class="mix" id="stat-mix"></div>
      </div>
    </section>
    <section class="card wide">
      <h2>运行状态 / 配额 <span class="tail faint" id="stat-runtime-at"></span></h2>
      <div class="stats" id="stat-runtime"></div>
      <div class="toolbar" style="margin:12px 0 0">
        <button data-goto="models">模型页</button>
        <button data-goto="scopes">作用域页</button>
        <span class="faint" id="stat-system-note" style="font-size:11.5px"></span>
      </div>
    </section>
    <section class="card wide">
      <h2>按仓库 / 作用域 <span class="tail faint" id="stat-scope-tip"></span></h2>
      <div class="table-wrap"><table>
        <thead><tr><th>仓库 / 作用域</th><th>类型</th><th class="num">块 / 向量</th><th class="num">请求</th><th class="num">检索</th><th class="num">嵌入</th><th class="num">重排</th><th class="num">错误率</th><th class="num">平均延迟</th></tr></thead>
        <tbody id="stat-scopes"><tr><td colspan="9" class="empty">加载中…</td></tr></tbody>
      </table></div>
      <div class="faint" style="font-size:11.5px;margin-top:8px">按作用域的用量从本版本开始累计；多作用域检索只计第一个写作用域。</div>
    </section>
    <section class="card wide">
      <h2>按 Key</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Key</th><th>角色</th><th class="num">请求</th><th>占比</th><th class="num">错误</th><th class="num">嵌入</th><th class="num">检索</th><th class="num">重排</th><th class="num">平均延迟</th><th>最后使用</th></tr></thead>
        <tbody id="stat-keys"><tr><td colspan="10" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </section>
  </section>

  <!-- ============================ 作用域 ============================ -->
  <section id="tab-scopes" class="panel">
    <section class="card wide">
      <h2>检索测试</h2>
      <div class="toolbar">
        <select id="test-ns" style="max-width:380px"></select>
        <input id="test-q" placeholder="输入查询，例如：订单支付后的库存扣减" style="flex:1;min-width:240px">
        <input id="test-k" type="number" value="5" min="1" max="20" title="返回条数" style="width:64px">
        <button class="primary" id="btn-test">检索</button>
      </div>
      <div id="test-out" class="faint" style="font-size:12.5px">选择作用域、输入查询后点「检索」；结果来自服务端 kNN（附覆盖率与耗时）。</div>
    </section>
    <section class="card wide">
      <h2>作用域（快照）<span class="tail" id="scope-count"></span></h2>
      <div class="toolbar">
        <input id="filter" type="search" placeholder="筛选 kind / ref / repoId / namespace…">
        <label><input id="auto" type="checkbox" checked> 每 15 秒自动刷新</label>
        <span class="faint" id="filtered"></span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>类型</th><th>引用</th><th>仓库</th><th class="num">块</th><th class="num">向量</th><th>覆盖率</th>
            <th class="num">占用</th><th>创建</th><th>过期</th><th>保护</th><th>命名空间</th>
          </tr></thead>
          <tbody id="scopes"><tr><td colspan="11" class="empty">加载中…</td></tr></tbody>
        </table>
      </div>
      <details class="help">
        <summary>字段说明</summary>
        <div class="grid">
          <div><b>类型</b>：legacy = 接入作用域前的老命名空间（永久保护）；main/branch/pr/worktree = 新规范快照。</div>
          <div><b>覆盖率</b>：vectors ÷ chunks。后台嵌入限速异步，刚同步完会从 0% 涨到 100%。</div>
          <div><b>向量 tag</b>：模型指纹。热切换模型后 tag 变化，旧 tag 向量不会被检索，需要客户端重新同步。</div>
        </div>
      </details>
    </section>
    <section class="card wide" style="border-color:var(--bad)">
      <h2 style="color:var(--bad)">危险操作：清空所有作用域</h2>
      <div class="faint" style="font-size:12px;margin-bottom:10px">删除服务端全部作用域、块、向量与正文（API Key、调用统计、模型设置保留），随后 VACUUM 回收空间。清空后检索会暂时没有结果，客户端（插件 / review-service）下次同步会自动全量重建；本机已建索引的仓库可用重推脚本一次补齐。</div>
      <div class="toolbar" style="margin:0">
        <input id="reset-confirm" placeholder="输入 RESET 确认" style="min-width:200px">
        <button class="danger" id="btn-reset-index">清空所有作用域</button>
        <span class="faint" id="reset-out" style="font-size:11.5px"></span>
      </div>
    </section>
  </section>

  <!-- ============================ 日志 ============================ -->
  <section id="tab-logs" class="panel">
    <section class="card wide">
      <h2>服务日志 <span class="tail"><button id="btn-logs">刷新</button></span></h2>
      <pre id="log-lines" class="mono faint" style="margin:0;max-height:70vh;overflow:auto;font-size:11.5px;white-space:pre-wrap;line-height:1.5">加载中…</pre>
    </section>
  </section>
</main>
<div id="toast"></div>
<script>
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmtNum = (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString();
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}
function rel(tsSec) {
  if (!tsSec) return '—';
  const t = new Date(tsSec * 1000); const diff = Math.max(0, (Date.now() - t.getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}
const absTime = (tsSec) => tsSec ? new Date(tsSec * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
function ttl(expiresAt) {
  if (!expiresAt) return '永不';
  const days = (expiresAt * 1000 - Date.now()) / 86400000;
  if (days <= 0) return '已过期';
  if (days < 1) return Math.max(1, Math.round(days * 24)) + ' 小时内';
  return Math.round(days) + ' 天';
}
function friendlyNs(x) {
  const fp = String(x.chunkFp || '').slice(0, 8);
  const scope = x.kind === 'legacy' ? 'legacy' : ('#' + x.kind + (x.ref ? ':' + x.ref : ''));
  return scope + ' <span class="faint" style="font-size:11px">· fp ' + fp + '</span>';
}
function chip(kind) {
  const k = String(kind || 'legacy');
  return '<span class="kind ' + k + '">' + k + '</span>';
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1500);
}
function banner(msg, bad) {
  const b = $('#banner');
  if (!msg) { b.style.display = 'none'; return; }
  b.style.display = 'block'; b.textContent = msg; b.className = bad ? 'bad' : '';
}
async function api(path, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  const r = await fetch(path, Object.assign({}, opts, { headers, credentials: 'same-origin' }));
  let body = null; try { body = await r.json(); } catch (e) {}
  if (r.status === 401) { location.replace('/admin'); }
  return { status: r.status, body };
}
const kv = (el, rows) => { el.innerHTML = rows.map(([k, v, title]) => '<div class="k">' + k + '</div><div class="v"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + v + '</div>').join(''); };

// ---------------- Tab 路由 ----------------
const TABS = ['overview', 'models', 'keys', 'stats', 'scopes', 'logs'];
function showTab(name) {
  if (!TABS.includes(name)) name = 'overview';
  $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'models') loadModels();
  if (name === 'keys') loadKeys();
  if (name === 'stats') { loadStats(STATS_DAYS); startStatsTimer(); } else { stopStatsTimer(); }
  if (name === 'logs') loadLogs();
  if (name === 'overview' || name === 'scopes') refreshHealth();
  location.hash = name;
}

// ---------------- 概览 ----------------
let HEALTH = null;
function renderOverview() {
  const d = HEALTH; if (!d) return;
  const g = d.governor || {}, k = d.knn || {}, L = d.limits || {}, sc = d.scopes || {};
  $('#ready').className = 'chip ' + (d.ready ? 'ok' : 'bad');
  $('#ready').innerHTML = '<span class="dot"></span>' + (d.ready ? 'ready' : 'not ready');
  $('#model').textContent = d.tag || '—';
  $('#model').title = (d.providers || []).join(', ') + ' · ORT ' + (d.ort || '?') + ' · threads ' + (d.threads || '?');
  const auth = d.admin || {};
  $('#authchip').className = 'chip ' + (auth.authRequired ? 'ok' : 'warn');
  $('#authchip').innerHTML = '<span class="dot"></span>' + (auth.authRequired ? '鉴权已开' : '未开鉴权');
  kv($('#runtime'), [
    ['模型', '<span class="mono">' + (d.model || '—') + '</span> <span class="faint">' + fmtBytes(d.model_bytes) + '</span>'],
    ['模型目录', '<span class="mono">' + escapeHtml(d.model_dir || '—') + '</span>'],
    ['向量 tag', '<span class="mono">' + escapeHtml(d.tag || '—') + '</span>'],
    ['执行提供者', (d.providers || []).map(escapeHtml).join(', ') || '—'],
    ['ORT / 线程', (d.ort || '?') + ' / ' + (d.threads || '?')],
    ['重排', d.rerank_ready ? ('<span class="mono">' + escapeHtml(d.rerank_tag || 'ready') + '</span>') : '<span class="muted">off（未启用）</span>'],
    ['进程 / 数据库', '<span class="mono">' + fmtNum(d.pid) + '</span> · <span class="mono">' + escapeHtml(d.db || '—') + '</span>'],
    ['本模型启用时间', d.model_switched_at ? (rel(d.model_switched_at) + ' <span class="faint">(' + absTime(d.model_switched_at) + ')</span>') : '<span class="faint">启动时加载</span>'],
  ]);
  const hits = k.hits || 0, miss = k.misses || 0;
  const rate = (hits + miss) ? Math.round(hits * 100 / (hits + miss)) + '%' : '—';
  kv($('#governor'), [
    ['状态', g.paused ? '<span class="chip warn"><span class="dot"></span>已暂停</span>' : '<span class="chip ok"><span class="dot"></span>运行中</span>'],
    ['限速', fmtNum(g.rate) + ' 块 / 秒'],
    ['批大小', fmtNum(g.batch)],
    ['kNN 缓存', fmtNum(k.entries) + ' 个作用域 · ' + fmtBytes(k.bytes) + ' / ' + fmtBytes(k.maxBytes)],
    ['kNN 命中率', rate + ' <span class="faint">(' + fmtNum(hits) + ' / ' + fmtNum(hits + miss) + ' · 淘汰 ' + fmtNum(k.evictions) + ')</span>'],
  ]);
  const used = (d.spaces || []).reduce((a, x) => a + (x.totalBytes || 0), 0);
  kv($('#limits'), [
    ['已用 / 上限', fmtBytes(used) + ' / ' + (L.maxTotalGb ? L.maxTotalGb + ' GB' : '—')],
    ['保留期', fmtNum(L.retentionDays) + ' 天'],
    ['每血统向量上限', fmtNum(L.maxVectorsPerLineage)],
    ['作用域数 / 上限', fmtNum(sc.total) + ' / ' + fmtNum(L.maxScopes)],
    ['单次检索作用域', '≤ ' + fmtNum(L.maxSearchScopes)],
  ]);
  const tags = d.tags || [];
  kv($('#tags'), tags.length ? tags.map((t) => [
    t.tag === d.tag ? '当前模型' : '旧 tag',
    '<span class="mono">' + escapeHtml(t.tag) + '</span> <span class="faint">' + fmtNum(t.vectors) + ' 条 · ' + fmtBytes(t.bytes) + '</span>',
  ]) : [['—', '<span class="faint">还没有向量</span>']]);
  $('#btn-purge-tags').disabled = !tags.some((t) => t.tag !== d.tag && t.vectors > 0);
  kv($('#auth-kv'), [
    ['API 鉴权', auth.authRequired ? '<span class="chip ok"><span class="dot"></span>已强制 Bearer Key</span>' : '<span class="chip warn"><span class="dot"></span>未开启（任何人可检索）</span>'],
    ['Key 数量', fmtNum((auth.keys || 0) + (auth.legacyKey ? 1 : 0)) + ' <span class="faint">（含 env legacy）</span>'],
    ['管理员密码', auth.adminPasswordSet ? '<span class="chip ok"><span class="dot"></span>已设置</span>' : '<span class="chip warn"><span class="dot"></span>未设置</span>'],
    ['登录方式', '<span class="faint">登录页 → HttpOnly Cookie（12h）；也支持 HTTP Basic 与 admin 角色 Key</span>'],
  ]);
  $('#setup-box').style.display = auth.adminPasswordSet ? 'none' : 'block';
}
let REFRESH_INFLIGHT = null;
function overviewError(msg) {
  $('#ready').className = 'chip bad';
  $('#ready').innerHTML = '<span class="dot"></span>不可达';
  ['runtime', 'governor', 'limits', 'tags', 'auth-kv'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.innerHTML = '<div class="k">加载失败</div><div class="v">' + escapeHtml(String(msg || '请求失败')) + '</div>';
  });
}
async function refreshHealth() {
  // 并发去重：初始化时 showTab() 与显式调用可能同时触发，旧实现会重复请求 /health 两次。
  if (REFRESH_INFLIGHT) return REFRESH_INFLIGHT;
  REFRESH_INFLIGHT = (async () => {
    try {
      // 两个接口互不依赖 → 并行；串行时总耗时 = 两者之和
      const [h, s] = await Promise.all([api('/health'), api('/v1/scopes')]);
      if (h.status !== 200 || !h.body) { overviewError('HTTP ' + h.status); return; }
      HEALTH = h.body;
      $('#refreshed').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
      if (HEALTH.admin && !HEALTH.admin.authRequired) banner('当前未强制 API Key：任何能访问此地址的人都能检索。建议到「API Key」页创建第一个 Key。', true);
      else banner('');
      renderOverview();
      ROWS = (s.body && s.body.scopes) || [];
      renderScopes();
    } catch (e) {
      overviewError((e && e.message) || e);
    }
  })().finally(() => { REFRESH_INFLIGHT = null; });
  return REFRESH_INFLIGHT;
}
async function action(name) {
  const r = await api('/v1/admin/' + name, { method: 'POST', body: '{}' });
  toast(r.status === 200 ? name + ' 执行成功' : name + ' 失败（' + r.status + '）');
  setTimeout(refreshHealth, 400);
}
async function purgeTags() {
  if (!confirm('删除所有「非当前模型 tag」的向量？正文不受影响；删除后旧模型无法再检索。')) return;
  const r = await api('/v1/admin/purge-tags', { method: 'POST', body: '{}' });
  toast(r.status === 200 ? '已清理旧 tag 向量：' + ((r.body && r.body.deleted) || 0) : '清理失败（' + r.status + '）');
  setTimeout(refreshHealth, 400);
}
async function setupAdmin() {
  const pwd = $('#setup-pwd').value;
  if (pwd.length < 8) { toast('密码至少 8 位'); return; }
  const r = await api('/admin/setup', { method: 'POST', body: JSON.stringify({ password: pwd }) });
  if (r.status === 200) { toast('管理员密码已设置'); $('#setup-pwd').value = ''; refreshHealth(); }
  else toast('设置失败：' + (r.body && r.body.error || r.status));
}

// ---------------- 作用域 / 检索测试 ----------------
let ROWS = [];
function renderScopes() {
  const q = ($('#filter').value || '').trim().toLowerCase();
  const rows = ROWS.filter((x) => !q || [x.kind, x.ref, x.repoId, x.namespace].some((v) => String(v || '').toLowerCase().includes(q)));
  $('#filtered').textContent = q ? '匹配 ' + rows.length + ' / ' + ROWS.length : '';
  $('#scope-count').textContent = '(' + ROWS.length + ')';
  const sel = $('#test-ns');
  const cur = sel.value;
  sel.innerHTML = ROWS.map((x) => '<option value="' + escapeHtml(x.namespace) + '">' + escapeHtml(x.kind + (x.ref ? ':' + x.ref : '') + ' · ' + (x.repoName || x.repoId)) + '</option>').join('');
  if (cur && ROWS.some((x) => x.namespace === cur)) sel.value = cur;
  if (!rows.length) { $('#scopes').innerHTML = '<tr><td colspan="11" class="empty">' + (ROWS.length ? '没有匹配的作用域' : '还没有作用域') + '</td></tr>'; return; }
  $('#scopes').innerHTML = rows.map((x) => {
    const pct = Math.round((x.coverage || 0) * 100);
    const cls = pct >= 95 ? '' : (pct >= 50 ? 'warn' : 'bad');
    return '<tr>'
      + '<td>' + chip(x.kind) + '</td>'
      + '<td>' + (x.ref ? escapeHtml(x.ref) : '<span class="faint">—</span>') + '</td>'
      + '<td>' + (x.repoName ? escapeHtml(x.repoName) + ' <span class="faint mono" style="font-size:11px">' + escapeHtml(x.repoId || '') + '</span>' : '<span class="mono">' + escapeHtml(x.repoId || '—') + '</span>') + '</td>'
      + '<td class="num">' + fmtNum(x.chunks) + '</td>'
      + '<td class="num">' + fmtNum(x.vectors) + '</td>'
      + '<td><div class="cov"><span class="bar ' + cls + '"><i style="width:' + pct + '%"></i></span><span class="num">' + pct + '%</span></div></td>'
      + '<td class="num">' + fmtBytes(x.totalBytes) + '</td>'
      + '<td title="' + absTime(x.createdAt) + '">' + rel(x.createdAt) + '</td>'
      + '<td>' + ttl(x.expiresAt) + '</td>'
      + '<td>' + (x.pinned ? '<span class="chip ok">已钉住</span>' : '<span class="faint">—</span>') + '</td>'
      + '<td><span class="ns" title="' + escapeHtml(x.namespace) + '">' + friendlyNs(x) + '</span> '
      + '<button class="copy" data-ns="' + escapeHtml(x.namespace) + '" title="复制命名空间">⧉</button></td>'
      + '</tr>';
  }).join('');
  $$('button.copy').forEach((b) => {
    b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.ns); toast('已复制命名空间'); } catch (e) { toast('复制失败（浏览器限制）'); } };
  });
}
async function searchTest() {
  const ns = $('#test-ns').value;
  const q = $('#test-q').value.trim();
  const k = Math.max(1, Math.min(20, Number($('#test-k').value) || 5));
  const out = $('#test-out');
  if (!ns || !q) { out.innerHTML = '<span style="color:var(--warn)">请选择作用域并输入查询</span>'; return; }
  out.textContent = '检索中…';
  const r = await api('/v1/search', { method: 'POST', body: JSON.stringify({ namespace: ns, query: q, k }) });
  if (r.status !== 200) { out.innerHTML = '检索失败：' + escapeHtml((r.body && r.body.error) || r.status); return; }
  const d = r.body, ms = d.ms || {};
  const head = '命中 ' + (d.hits || []).length + ' 条 · embed ' + ms.embed + ' ms · kNN ' + ms.knn + ' ms · 覆盖率 ' + Math.round((d.coverage || 0) * 100) + '%';
  out.innerHTML = '<div class="faint" style="margin-bottom:6px">' + head + '</div>'
    + ((d.hits || []).map((h) => '<div style="padding:4px 0;border-bottom:1px solid var(--line)">'
      + '<span class="mono">' + escapeHtml(h.path) + ':' + h.start + '-' + h.end + '</span> '
      + '<span class="faint">score ' + h.score + '</span></div>').join('') || '<span class="faint">没有命中（可能该作用域还没嵌入完）</span>');
}

// ---------------- 模型 ----------------
let MODEL_DATA = null;
let MODEL_TIMER = null;
function modelStatusChip(status, ready, installedElsewhere) {
  if (installedElsewhere && !ready) {
    return '<span class="chip blue"><span class="dot"></span>已安装</span>';
  }
  if (ready) return '<span class="chip ok"><span class="dot"></span>已就绪</span>';
  const label = { idle: '未下载', downloading: '下载中', done: '已下载', failed: '失败', cancelled: '已取消' }[status] || status;
  const cls = { failed: 'chip bad', downloading: 'chip warn', cancelled: 'chip warn', done: 'chip ok' }[status] || 'chip';
  return '<span class="' + cls + '"><span class="dot"></span>' + label + '</span>';
}
function renderActiveModels() {
  const a = (MODEL_DATA && MODEL_DATA.active) || {};
  const e = a.embed || {}, r = a.rerank || {};
  const box = (title, body) => '<div class="model-box"><div class="head">' + title + '</div>' + body + '</div>';
  $('#active-models').innerHTML =
    box('<b>嵌入（embed）</b> <span class="chip ok"><span class="dot"></span>active</span>' + '<span class="spacer"></span><span class="faint" style="font-size:11.5px">' + escapeHtml(e.dir || '') + '</span>',
        '<div class="kv" style="margin-top:8px"><div class="k">名称</div><div class="v">' + escapeHtml(e.name || '—') + '</div>'
        + '<div class="k">tag</div><div class="v mono">' + escapeHtml(e.tag || '—') + '</div>'
        + '<div class="k">模型文件</div><div class="v mono">' + escapeHtml(e.model || '—') + '</div></div>')
    + box('<b>重排（rerank）</b> ' + (r.ready ? '<span class="chip ok"><span class="dot"></span>active</span>' : '<span class="chip warn"><span class="dot"></span>off</span>') + '<span class="spacer"></span><span class="faint" style="font-size:11.5px">' + escapeHtml(r.dir || '') + '</span>',
        '<div class="kv" style="margin-top:8px"><div class="k">tag</div><div class="v mono">' + escapeHtml(r.tag || '—') + '</div>'
        + '<div class="k">模型文件</div><div class="v mono">' + escapeHtml(r.model || '—') + '</div>'
        + '<div class="k">操作</div><div class="v">' + (r.ready ? '<button data-rerank-off="1">关闭重排</button>' : '<span class="faint">未启用（客户端自动跳过重排）</span>') + '</div></div>');
  const off = document.querySelector('[data-rerank-off]');
  if (off) off.onclick = deactivateRerank;
}
function renderInstalled() {
  const inst = (MODEL_DATA && MODEL_DATA.installed) || {};
  const rows = [];
  (inst.embed || []).forEach((m) => rows.push({ kind: 'embed', m }));
  (inst.rerank || []).forEach((m) => rows.push({ kind: 'rerank', m }));
  $('#model-roots').textContent = ((MODEL_DATA && MODEL_DATA.roots) || []).join(' · ');
  if (!rows.length) { $('#installed').innerHTML = '<tr><td colspan="7" class="empty">没有发现可用模型目录</td></tr>'; return; }
  $('#installed').innerHTML = rows.map(({ kind, m }) => {
    const active = !!m.active;
    const op = kind === 'embed'
      ? (active ? '<span class="chip ok">当前</span>' : '<button class="primary" data-switch-embed="' + escapeHtml(m.dir) + '">切换为嵌入</button>')
      : (active ? '<button data-rerank-off="1">关闭</button>' : '<button class="primary" data-switch-rerank="' + escapeHtml(m.dir) + '">启用重排</button>');
    const dups = m.alsoDirs || [];
    const dirTitle = [m.dir].concat(dups).join('\n');
    const dirCell = '<span class="mono faint" style="font-size:11px" title="' + escapeHtml(dirTitle) + '">' + escapeHtml(m.dir) + '</span>'
      + (dups.length ? ' <span class="chip warn" title="' + escapeHtml(dups.join('\n')) + '">另有 ' + dups.length + ' 份副本</span>' : '');
    return '<tr>'
      + '<td>' + (kind === 'embed' ? '嵌入' : '重排') + '</td>'
      + '<td>' + escapeHtml(m.name) + '</td>'
      + '<td class="mono" style="font-size:11.5px">' + escapeHtml(m.tag || '—') + '</td>'
      + '<td>' + dirCell + '</td>'
      + '<td class="num">' + fmtBytes(m.size_bytes || m.model_bytes) + '</td>'
      + '<td>' + (active ? '<span class="chip ok">active</span>' : (m.ready ? '<span class="chip">ready</span>' : '<span class="chip bad">incomplete</span>')) + '</td>'
      + '<td>' + op + '</td></tr>';
  }).join('');
  $$('[data-switch-embed]').forEach((b) => { b.onclick = () => switchModel('embed', b.dataset.switchEmbed); });
  $$('[data-switch-rerank]').forEach((b) => { b.onclick = () => switchModel('rerank', b.dataset.switchRerank); });
  $$('[data-rerank-off]').forEach((b) => { b.onclick = deactivateRerank; });
}
function renderDownloads() {
  const box = $('#models');
  const list = (MODEL_DATA && MODEL_DATA.models) || [];
  if (!list.length) { box.innerHTML = '<span class="faint">没有可下载的模型</span>'; return; }
  box.innerHTML = list.map((m) => {
    const ready = !!m.ready;
    const pct = ready ? 100 : (m.bytesTotal ? Math.min(100, Math.round(m.bytesDone * 100 / m.bytesTotal)) : 0);
    const cls = m.status === 'failed' ? 'bad' : (m.status === 'downloading' ? 'warn' : '');
    const elsewhere = m.installedElsewhere;
    const blocked = !!(elsewhere && !ready);
    const size = blocked
      ? '—'
      : (ready
        ? fmtBytes(m.diskBytes || m.bytesTotal || 0)
        : (fmtBytes(m.bytesDone) + ' / ' + (m.bytesTotal ? fmtBytes(m.bytesTotal) : '?')));
    const speed = (m.status === 'downloading' && m.speedBps) ? ' · ' + fmtBytes(m.speedBps) + '/s' : '';
    const btn = m.status === 'downloading'
      ? '<button data-cancel="' + escapeHtml(m.name) + '">取消</button>'
      : '<button data-start="' + escapeHtml(m.name) + '"' + (ready || blocked ? ' disabled' : '') + '>'
        + (ready ? '已就绪' : (blocked ? '已安装' : ((m.status === 'failed' || m.status === 'cancelled') ? '重试' : '下载'))) + '</button>'
        + '<button data-force="' + escapeHtml(m.name) + '" title="删掉已下载文件，从头再下">重传</button>';
    const hint = ready
      ? '已就绪 · 目标目录 <span class="mono">' + escapeHtml(m.target) + '</span> · 到「已安装模型」里点切换即可热加载（无需重启）'
      : escapeHtml(m.error || m.message || '');
    let extra = '';
    if (elsewhere && ready) {
      extra = '<div style="font-size:11.5px;margin-top:4px;color:var(--warn)">同 tag 已安装在 <span class="mono">' + escapeHtml(elsewhere.dir) + '</span>，这个目录是副本（可手动删除，不影响切换）</div>';
    } else if (elsewhere && !ready) {
      extra = '<div style="font-size:11.5px;margin-top:4px;color:var(--warn)">本机已有同款：<span class="mono">' + escapeHtml(elsewhere.dir) + '</span>' + (elsewhere.tag ? '（tag ' + escapeHtml(elsewhere.tag) + '）' : '') + '，一般无需再下载；确需副本可用「重传」</div>';
    }
    const note = m.note ? '<div class="faint" style="font-size:11.5px;margin-top:2px">' + escapeHtml(m.note) + '</div>' : '';
    return '<div style="padding:10px 0;border-bottom:1px solid var(--line)">'
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b>' + escapeHtml(m.name) + '</b> ' + modelStatusChip(m.status, ready, blocked)
      + '<span class="faint">' + escapeHtml(m.label || '') + '</span><span class="spacer"></span>' + btn + '</div>'
      + (blocked ? '' : '<div class="cov" style="margin-top:8px"><span class="bar ' + cls + '"><i style="width:' + pct + '%"></i></span>'
        + '<span class="num">' + pct + '%</span><span class="faint">' + size + speed + '</span></div>')
      + '<div class="faint" style="font-size:11.5px;margin-top:6px">' + hint + '</div>' + extra + note + '</div>';
  }).join('');
  $$('[data-start]').forEach((b) => { b.onclick = () => startModel(b.dataset.start, false); });
  $$('[data-force]').forEach((b) => { b.onclick = () => { if (confirm('删掉已下载文件，从头重新下载？')) startModel(b.dataset.force, true); }; });
  $$('[data-cancel]').forEach((b) => { b.onclick = () => cancelModel(b.dataset.cancel); });
}
async function loadModels() {
  const r = await api('/v1/admin/models');
  if (r.status !== 200 || !r.body) return;
  MODEL_DATA = r.body;
  renderActiveModels(); renderInstalled(); renderDownloads();
  const busy = ((MODEL_DATA.models || []).some((m) => m.status === 'downloading'));
  if (busy) ensureModelPolling();
}
function ensureModelPolling() {
  if (MODEL_TIMER) return;
  MODEL_TIMER = setInterval(async () => {
    await loadModels();
    if (!((MODEL_DATA && MODEL_DATA.models) || []).some((m) => m.status === 'downloading')) { clearInterval(MODEL_TIMER); MODEL_TIMER = null; }
  }, 1200);
}
async function startModel(name, force) {
  const r = await api('/v1/admin/models/' + encodeURIComponent(name) + '/download', { method: 'POST', body: JSON.stringify({ force: !!force }) });
  if (r.status !== 200) toast('启动失败：' + r.status);
  await loadModels(); ensureModelPolling();
}
async function cancelModel(name) {
  const r = await api('/v1/admin/models/' + encodeURIComponent(name) + '/cancel', { method: 'POST', body: '{}' });
  if (r.status !== 200) toast('取消失败：' + r.status);
  await loadModels();
}
async function switchModel(kind, dir) {
  const what = kind === 'embed' ? '嵌入模型' : '重排模型';
  if (!confirm('切换' + what + '？切换嵌入模型会改变向量 tag：旧向量保留但立即检索不到，客户端下次同步会全量重嵌（覆盖率从 0 恢复）。')) return;
  toast('正在切换' + what + '…');
  const r = await api('/v1/admin/models/activate', { method: 'POST', body: JSON.stringify({ kind, dir }) });
  if (r.status !== 200) { toast('切换失败：' + ((r.body && (r.body.detail || r.body.error)) || r.status)); return; }
  const b = r.body;
  if (kind === 'embed') banner('已切换嵌入模型：' + (b.prevTag || '?') + ' → ' + b.tag + '（' + (b.ms || 0) + ' ms，' + (b.repos || 0) + ' 个仓库已改 tag）。旧向量保留但不可检索；等客户端重新同步后覆盖率会自动恢复。');
  else banner('');
  toast('切换完成（' + (b.ms || 0) + ' ms）');
  await refreshHealth(); await loadModels();
}
async function deactivateRerank() {
  if (!confirm('关闭重排？检索会跳过重排（客户端回退 RRF 顺序）。')) return;
  const r = await api('/v1/admin/models/deactivate', { method: 'POST', body: JSON.stringify({ kind: 'rerank' }) });
  toast(r.status === 200 ? '已关闭重排' : '失败：' + r.status);
  await refreshHealth(); await loadModels();
}

// ---------------- API Key ----------------
let KEYS = [];
let LEGACY = false;
let PLAIN_KEY = '';
function updateRoleHint() {
  $('#key-role-hint').innerHTML = 'index：可访问索引/检索全部接口（sync / chunks / vectors / search / repo status / scopes 等），不能进控制台管理。';
}
function renderKeyStats() {
  const rows = KEYS.slice();
  const enabled = rows.filter((k) => k.enabled).length;
  const req = rows.reduce((a, k) => a + ((k.today && k.today.requests) || 0), 0);
  const err = rows.reduce((a, k) => a + ((k.today && k.today.errors) || 0), 0);
  const cards = [
    ['Key 总数', fmtNum(rows.length + (LEGACY ? 1 : 0))],
    ['启用中', fmtNum(enabled + (LEGACY ? 1 : 0))],
    ['今日请求', fmtNum(req)],
    ['今日错误', fmtNum(err)],
  ];
  $('#key-stats').innerHTML = cards.map(([l, n]) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join('');
}
async function loadKeys() {
  const r = await api('/v1/admin/keys');
  if (r.status !== 200) return;
  KEYS = (r.body && r.body.keys) || [];
  LEGACY = !!(r.body && r.body.legacy);
  const note = $('#key-legacy-note');
  if (note) {
    note.innerHTML = LEGACY
      ? '环境变量 <span class="mono">API_KEY</span> 作为 legacy Key（id=0，admin 角色）始终有效，不可在页面删除。'
      : '当前没有配置环境变量 <span class="mono">API_KEY</span>：所有 Key 都由 <span class="mono">admin.db</span> 管理，可随时禁用 / 删除 / 轮换。';
  }
  renderKeyStats();
  renderKeys();
}
function renderKeys() {
  const q = ($('#key-filter').value || '').trim().toLowerCase();
  const rows = [];
  if (LEGACY) rows.push({ id: 0, name: '环境变量 API_KEY', prefix: '（env）', role: 'admin', enabled: true, legacy: true, today: { requests: 0, errors: 0 } });
  rows.push(...KEYS);
  const shown = q ? rows.filter((k) => [k.name, k.prefix, k.role].some((v) => String(v || '').toLowerCase().includes(q))) : rows;
  $('#key-filtered').textContent = q ? '匹配 ' + shown.length + ' / ' + rows.length : '';
  if (!shown.length) {
    $('#keys').innerHTML = '<tr><td colspan="9" class="empty">' + (rows.length ? '没有匹配的 Key' : '还没有 Key。在上方新建后，所有索引/检索请求都需要带 Key。') + '</td></tr>';
    return;
  }
  $('#keys').innerHTML = shown.map((k) => {
    const perm = k.role === 'admin'
      ? '<span class="chip blue">admin</span> <span class="faint" style="font-size:11px">索引 + 控制台</span>'
      : '<span class="chip">index</span> <span class="faint" style="font-size:11px">仅索引/检索</span>';
    const op = k.legacy ? '<span class="faint" style="font-size:11.5px">只读（env）</span>'
      : '<button data-toggle="' + k.id + '">' + (k.enabled ? '禁用' : '启用') + '</button> <button class="danger" data-del="' + k.id + '">删除</button>';
    return '<tr>'
      + '<td>' + escapeHtml(k.name || '—') + (k.legacy ? ' <span class="chip blue">legacy</span>' : '') + '</td>'
      + '<td class="mono">' + escapeHtml(k.prefix || '—') + '</td>'
      + '<td>' + perm + '</td>'
      + '<td>' + (k.enabled ? '<span class="chip ok"><span class="dot"></span>启用</span>' : '<span class="chip bad"><span class="dot"></span>禁用</span>') + '</td>'
      + '<td class="num">' + fmtNum(k.today && k.today.requests) + '</td>'
      + '<td class="num">' + fmtNum(k.today && k.today.errors) + '</td>'
      + '<td title="' + absTime(k.lastUsedAt) + '">' + rel(k.lastUsedAt) + '</td>'
      + '<td title="' + absTime(k.createdAt) + '">' + rel(k.createdAt) + '</td>'
      + '<td>' + op + '</td></tr>';
  }).join('');
  $$('[data-toggle]').forEach((b) => { b.onclick = () => toggleKey(Number(b.dataset.toggle)); });
  $$('[data-del]').forEach((b) => { b.onclick = () => deleteKey(Number(b.dataset.del)); });
}
async function createKey() {
  const name = $('#key-name').value.trim();
  const role = 'index'; // 页面不再提供 admin 角色；admin 仅保留给 env/既有 Key
  if (!name) { toast('先填一个名称'); return; }
  const r = await api('/v1/admin/keys', { method: 'POST', body: JSON.stringify({ name, role }) });
  if (r.status !== 200) { toast('创建失败：' + ((r.body && r.body.error) || r.status)); return; }
  $('#key-name').value = '';
  PLAIN_KEY = r.body.key;
  $('#key-plain').textContent = PLAIN_KEY;
  $('#key-test-out').textContent = '';
  $('#key-reveal').style.display = 'block';
  toast('已创建 Key（明文只显示这一次，建议先点「测试访问索引服务」）');
  loadKeys();
}
async function testKeyAccess() {
  if (!PLAIN_KEY) { toast('先新建一个 Key（明文只显示一次）'); return; }
  const out = $('#key-test-out');
  out.textContent = '测试中…';
  const headers = { Authorization: 'Bearer ' + PLAIN_KEY };
  // credentials:'omit' 很关键：控制台本身有管理员会话 Cookie，带上 Cookie 测什么都是 200
  const [idx, adm] = await Promise.all([
    fetch('/v1/status', { headers, credentials: 'omit' }).then((r) => r.status).catch(() => 0),
    fetch('/v1/admin/session', { headers, credentials: 'omit' }).then((r) => r.status).catch(() => 0),
  ]);
  const chipOf = (code, okText) => code === 200
    ? '<span class="chip ok"><span class="dot"></span>' + okText + ' 200</span>'
    : '<span class="chip ' + (code === 401 ? '' : 'bad') + '">' + (code || 'ERR') + '</span>';
  out.innerHTML = '索引服务 ' + chipOf(idx, 'OK') + ' · 控制台管理 ' + chipOf(adm, 'OK');
}
function resetIndex() {
  const phrase = ($('#reset-confirm').value || '').trim().toUpperCase();
  if (phrase !== 'RESET') { toast('请输入 RESET 确认'); return; }
  if (!confirm('确认清空服务端所有作用域、块、向量与正文？此操作不可撤销（API Key 与统计保留）。')) return;
  const out = $('#reset-out');
  out.textContent = '清空中…';
  api('/v1/admin/reset-index', { method: 'POST', body: JSON.stringify({ confirm: phrase }) }).then((r) => {
    if (r.status !== 200) { out.textContent = '失败：' + ((r.body && (r.body.error || r.body.hint)) || r.status); return; }
    const d = (r.body && r.body.deleted) || {};
    out.textContent = '已清空：chunks=' + fmtNum(d.chunks) + ' vectors=' + fmtNum(d.vectors) + ' repos=' + fmtNum(d.repos) + '（' + ((r.body && r.body.ms) || 0) + ' ms）';
    toast('已清空所有作用域');
    $('#reset-confirm').value = '';
    refreshHealth();
  });
}
async function toggleKey(id) {
  const cur = KEYS.find((k) => k.id === id);
  if (!cur) return;
  const r = await api('/v1/admin/keys/' + id + '/' + (cur.enabled ? 'disable' : 'enable'), { method: 'POST', body: '{}' });
  toast(r.status === 200 ? '已' + (cur.enabled ? '禁用' : '启用') : '操作失败：' + r.status);
  loadKeys();
}
async function deleteKey(id) {
  const cur = KEYS.find((k) => k.id === id);
  if (!confirm('删除 Key「' + (cur && cur.name || id) + '」？删除后用它认证的客户端会立即 401。')) return;
  const r = await api('/v1/admin/keys/' + id, { method: 'DELETE' });
  toast(r.status === 200 ? '已删除' : '删除失败：' + r.status);
  loadKeys();
}

// ---------------- 统计 ----------------
let STATS_DAYS = 7;
let STATS = null;
let STATS_TIMER = null;
const STATS_CAT_ORDER = ['retrieval', 'indexing', 'embedding'];
const STATS_CAT_LABEL = { retrieval: '检索/重排', indexing: '索引操作', embedding: '嵌入', system: '系统/轮询' };
function fmtMs(v) { const n = Number(v || 0); return n > 0 ? Math.round(n) + ' ms' : '—'; }
function ratePct(errors, requests) { return requests ? (Number(errors || 0) / Number(requests)) * 100 : 0; }
function rateText(errors, requests) { const r = ratePct(errors, requests); return (requests ? r.toFixed(1) : '0.0') + '%'; }
function deltaTag(cur, prev, lowerBetter) {
  cur = Number(cur || 0); prev = Number(prev || 0);
  if (!prev) return cur > 0 ? '<span class="delta up">新增</span>' : '';
  const diff = (cur - prev) / prev * 100;
  if (Math.abs(diff) < 0.5) return '<span class="delta">持平</span>';
  const good = lowerBetter ? diff < 0 : diff > 0;
  return '<span class="delta ' + (good ? 'down' : 'up') + '">' + (diff > 0 ? '+' : '') + diff.toFixed(1) + '%</span>';
}
function statCard(label, value, sub) {
  return '<div class="stat"><div class="n">' + value + '</div><div class="l">' + label + (sub ? ' ' + sub : '') + '</div></div>';
}
function catOf(categories, name) {
  const c = (categories || {})[name] || {};
  return { requests: Number(c.requests || 0), errors: Number(c.errors || 0), latencyAvg: Number(c.latencyAvg || 0) };
}
function sumCats(categories, names) {
  let requests = 0, errors = 0, latencySum = 0;
  for (const name of names) {
    const c = catOf(categories, name);
    requests += c.requests;
    errors += c.errors;
    latencySum += c.latencyAvg * c.requests;
  }
  return { requests, errors, latencyAvg: requests ? latencySum / requests : 0 };
}
function businessCats(categories) { return sumCats(categories, STATS_CAT_ORDER); }
function renderStatCards() {
  const d = STATS || {}; const t = d.totals || {}; const lat = d.latency || {};
  const cats = d.categories || {}; const prevCats = d.prevCategories || {};
  const biz = businessCats(cats); const prevBiz = businessCats(prevCats);
  const retrieval = catOf(cats, 'retrieval'); const indexing = catOf(cats, 'indexing');
  const success = biz.requests ? 100 - ratePct(biz.errors, biz.requests) : null;
  $('#stat-cards').innerHTML = [
    statCard('业务请求', fmtNum(biz.requests), deltaTag(biz.requests, prevBiz.requests, false)),
    statCard('检索 / 重排', fmtNum(retrieval.requests), '<span class="sub">' + fmtNum(t.searchCalls) + ' 次检索</span>'),
    statCard('embed 文本', fmtNum(t.embedTexts), ''),
    statCard('业务成功率', success === null ? '—' : success.toFixed(1) + '%', '<span class="sub">' + fmtNum(biz.errors) + ' 错误</span>'),
    statCard('平均延迟（业务）', fmtMs(biz.latencyAvg), deltaTag(biz.latencyAvg, prevBiz.latencyAvg, true)),
    statCard('P95 延迟', lat.p95 || '—', lat.count ? '<span class="sub">' + fmtNum(lat.count) + ' 次采样（全部）</span>' : '<span class="sub">本次部署后累计</span>'),
    statCard('索引操作', fmtNum(indexing.requests), '<span class="sub">同步 / 上传 / 触发</span>'),
    statCard('活跃 Key', fmtNum((d.byKey || []).filter((k) => k.role !== 'deleted').length), '<span class="sub">' + (d.days === 1 ? '今日' : '区间内') + ' 有调用</span>'),
  ].join('');
}
function chartCol(x, bars, label, title) {
  return '<div class="col" title="' + escapeHtml(title || x.day) + '"><div class="bars">' + bars + '</div><span class="x">' + escapeHtml(label) + '</span></div>';
}
function renderTrend() {
  const rows = (STATS && STATS.byDay) || [];
  const el = $('#stat-trend');
  if (!rows.length) { el.innerHTML = '<div class="empty">没有数据</div>'; return; }
  const totals = rows.map((x) => STATS_CAT_ORDER.reduce((a, n) => a + Number(x[n + 'Requests'] || 0), 0));
  const max = Math.max(1, ...totals);
  const step = rows.length > 14 ? Math.ceil(rows.length / 10) : 1;
  el.innerHTML = rows.map((x, i) => {
    const seg = (name, cls) => {
      const v = Number(x[name + 'Requests'] || 0);
      return v ? '<i class="' + cls + '" style="height:' + ((v / max) * 100).toFixed(2) + '%"></i>' : '';
    };
    const bars = '<div class="stack">' + seg('embedding', 's-emb') + seg('indexing', 's-idx') + seg('retrieval', 's-ret') + '</div>';
    const title = x.day + '：检索/重排 ' + fmtNum(x.retrievalRequests) + ' · 索引 ' + fmtNum(x.indexingRequests)
      + ' · 嵌入 ' + fmtNum(x.embeddingRequests) + ' · 系统/轮询 ' + fmtNum(x.systemRequests) + ' · 错误 ' + fmtNum(x.errors);
    return chartCol(x, bars, i % step === 0 ? String(x.day || '').slice(5) : '', title);
  }).join('');
}
function renderLatencyTrend() {
  const rows = (STATS && STATS.byDay) || [];
  const el = $('#stat-latency');
  if (!rows.length) { el.innerHTML = '<div class="empty">没有数据</div>'; return; }
  const max = Math.max(1, ...rows.map((x) => Number(x.latencyAvg || 0)));
  const step = rows.length > 14 ? Math.ceil(rows.length / 10) : 1;
  el.innerHTML = rows.map((x, i) => {
    const h = Math.max(1, Math.round((Number(x.latencyAvg || 0) / max) * 100));
    return chartCol(x, '<i class="lat" style="height:' + h + '%"></i>', i % step === 0 ? String(x.day || '').slice(5) : '');
  }).join('');
  $$('#stat-latency .col').forEach((col, i) => {
    const x = rows[i] || {};
    col.title = String(x.day || '') + '：平均 ' + fmtMs(x.latencyAvg) + ' · 最大 ' + fmtMs(x.latencyMax) + ' · 请求 ' + fmtNum(x.requests);
  });
}
function renderMix() {
  const cats = (STATS && STATS.categories) || {};
  const items = STATS_CAT_ORDER.map((name) => [STATS_CAT_LABEL[name], catOf(cats, name).requests]);
  const total = items.reduce((a, x) => a + x[1], 0);
  const max = Math.max(1, ...items.map((x) => x[1]));
  const colors = ['blue', 'purple', 'ok'];
  $('#stat-mix').innerHTML = items.map(([label, count], i) => {
    const w = Math.max(1, Math.round((count / max) * 100));
    const share = total ? (count / total) * 100 : 0;
    return '<div class="row"><span class="faint">' + label + '</span><span class="bar ' + (colors[i] || 'blue') + '"><i style="width:' + w + '%"></i></span><span class="num">' + fmtNum(count) + ' · ' + share.toFixed(1) + '%</span></div>';
  }).join('');
}
function shortNs(ns) {
  const s = String(ns || '');
  const at = s.indexOf('@');
  if (at > 0) return s.slice(0, at) + '…';
  return s.length > 18 ? s.slice(0, 18) + '…' : s;
}
function renderRuntime(health, scopesBody) {
  const sc = (scopesBody && scopesBody.scopes) || [];
  let chunks = 0, vectors = 0, used = 0;
  for (const s of sc) { chunks += Number(s.chunks || 0); vectors += Number(s.vectors || 0); used += Number(s.totalBytes || 0); }
  const backlog = Math.max(0, chunks - vectors);
  const coverage = chunks ? (vectors / chunks) * 100 : 0;
  const limits = (health && health.limits) || {};
  const maxGb = Number(limits.maxTotalGb || 0);
  const maxBytes = maxGb * 1024 * 1024 * 1024;
  const storagePct = maxBytes ? Math.min(100, (used / maxBytes) * 100) : 0;
  const scopeMax = Number(limits.maxScopes || 0);
  const cats = (STATS && STATS.categories) || {};
  const biz = businessCats(cats); const sys = catOf(cats, 'system');
  let cards;
  if (!health) {
    cards = [statCard('运行状态', '<span class="chip bad">不可用</span>', ''), statCard('作用域', fmtNum(sc.length), '')];
  } else {
    const g = health.governor || {};
    cards = [
      statCard('服务', '<span class="chip ' + (health.ready ? 'ok' : 'bad') + '"><span class="dot"></span>' + (health.ready ? 'ready' : '未就绪') + '</span>', ''),
      statCard('当前模型', '<span class="mono" style="font-size:11px">' + escapeHtml(health.tag || '—') + '</span>', ''),
      statCard('嵌入限速', (g.paused ? '已暂停' : '运行中') + ' · ' + fmtNum(g.rate) + '/s · batch ' + fmtNum(g.batch), ''),
      statCard('作用域', fmtNum(sc.length) + (scopeMax ? ' / ' + fmtNum(scopeMax) : ''), '<span class="sub">平均覆盖 ' + coverage.toFixed(1) + '%</span>'),
      statCard('存储', maxGb ? fmtBytes(used) + ' / ' + maxGb + ' GB' : fmtBytes(used), '<span class="sub">' + storagePct.toFixed(1) + '%</span>'),
      statCard('块 / 向量', fmtNum(chunks) + ' / ' + fmtNum(vectors), ''),
      statCard('嵌入积压', backlog > 0 ? fmtNum(backlog) + ' 块' : '0', backlog > 0 ? '<span class="sub">后台嵌入中</span>' : '<span class="sub">已全部完成</span>'),
      statCard('业务 / 系统请求', fmtNum(biz.requests) + ' / ' + fmtNum(sys.requests), '<span class="sub">系统请求不计入 KPI</span>'),
    ];
  }
  $('#stat-runtime').innerHTML = cards.join('');
  $('#stat-runtime-at').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const note = $('#stat-system-note');
  if (note) note.textContent = '系统/轮询请求（status/scopes/admin）：' + fmtNum(sys.requests) + ' 次，明细可在「日志」查看';
}
function renderScopeTable() {
  const rows = (STATS && STATS.byScope) || [];
  const top = rows.slice(0, 15);
  $('#stat-scope-tip').textContent = rows.length ? ('Top ' + top.length + ' / ' + rows.length) : '';
  $('#stat-scopes').innerHTML = top.length ? top.map((s) => {
    const name = s.repoName || shortNs(s.namespace);
    const kind = s.kind || (s.missing ? 'deleted' : 'unknown');
    const label = kind === 'main' ? '#main:default' : (s.ref ? '#' + kind + ':' + s.ref : (s.missing ? '已删除' : '—'));
    const counts = s.chunks != null ? fmtNum(s.chunks) + ' / ' + fmtNum(s.vectors) : '—';
    const cov = s.chunks ? ' <span class="faint">' + Math.round((Number(s.vectors || 0) / Number(s.chunks)) * 100) + '%</span>' : '';
    return '<tr><td title="' + escapeHtml(s.namespace || '') + '"><span class="mono">' + escapeHtml(name) + '</span> <span class="faint" style="font-size:11px">' + escapeHtml(label) + '</span></td>'
      + '<td>' + (s.kind ? '<span class="kind ' + escapeHtml(s.kind) + '">' + escapeHtml(s.kind) + '</span>' : '<span class="chip bad">' + escapeHtml(kind) + '</span>') + '</td>'
      + '<td class="num">' + counts + cov + '</td><td class="num">' + fmtNum(s.requests) + '</td>'
      + '<td class="num">' + fmtNum(s.searchCalls) + '</td><td class="num">' + fmtNum(s.embedTexts) + '</td><td class="num">' + fmtNum(s.rerankCalls) + '</td>'
      + '<td class="num">' + (s.requests ? rateText(s.errors, s.requests) : '—') + '</td><td class="num">' + fmtMs(s.latencyAvg) + '</td></tr>';
  }).join('') : '<tr><td colspan="9" class="empty">按作用域用量从本版本开始累计（历史数据没有该维度）</td></tr>';
}
function renderKeyTable() {
  const keys = (STATS && STATS.byKey) || [];
  const totalReq = Number((STATS && STATS.totals && STATS.totals.requests) || 0);
  $('#stat-keys').innerHTML = keys.length ? keys.map((k) => {
    const share = totalReq ? (Number(k.requests || 0) / totalReq) * 100 : 0;
    const name = escapeHtml(k.name || ('#' + k.keyId)) + (k.role === 'legacy' ? ' <span class="chip blue">legacy</span>' : '') + ' <span class="faint mono" style="font-size:11px">' + escapeHtml(k.prefix || '') + '</span>';
    return '<tr><td>' + name + '</td><td>' + escapeHtml(k.role || '—') + '</td><td class="num">' + fmtNum(k.requests) + '</td>'
      + '<td><div class="cov"><span class="bar blue" style="width:100px"><i style="width:' + share.toFixed(1) + '%"></i></span><span class="faint">' + share.toFixed(1) + '%</span></div></td>'
      + '<td class="num">' + fmtNum(k.errors) + '</td><td class="num">' + fmtNum(k.embedTexts) + '</td><td class="num">' + fmtNum(k.searchCalls) + '</td><td class="num">' + fmtNum(k.rerankCalls) + '</td>'
      + '<td class="num">' + fmtMs(k.latencyAvg) + '</td><td title="' + absTime(k.lastUsedAt) + '">' + rel(k.lastUsedAt) + '</td></tr>';
  }).join('') : '<tr><td colspan="10" class="empty">没有数据</td></tr>';
}
function stopStatsTimer() { if (STATS_TIMER) { clearInterval(STATS_TIMER); STATS_TIMER = null; } }
function startStatsTimer() {
  stopStatsTimer();
  if ($('#stats-auto') && !$('#stats-auto').checked) return;
  STATS_TIMER = setInterval(() => {
    if (document.visibilityState === 'visible' && location.hash === '#stats') loadStats(STATS_DAYS);
  }, 30000);
}
async function loadStats(days) {
  STATS_DAYS = Number(days) || 7;
  $$('[data-days]').forEach((b) => b.classList.toggle('active', Number(b.dataset.days) === STATS_DAYS));
  const meta = $('#stats-meta'); if (meta) meta.textContent = '加载中…';
  const [r, h, s] = await Promise.all([api('/v1/admin/stats?days=' + STATS_DAYS), api('/health'), api('/v1/scopes')]);
  if (r.status !== 200 || !r.body) {
    $('#stat-cards').innerHTML = '<div class="empty">统计加载失败（' + r.status + '）</div>';
    if (meta) meta.textContent = '统计加载失败：' + r.status;
    return;
  }
  STATS = r.body;
  if (meta) meta.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' · ' + STATS.from + ' ~ ' + STATS.to + ' · 含未落盘缓冲（最多约 30 秒延迟）';
  $('#stat-range-label').textContent = STATS.days === 1 ? '今日' : ('近 ' + STATS.days + ' 天');
  renderStatCards();
  renderTrend();
  renderLatencyTrend();
  renderMix();
  renderRuntime(h.status === 200 ? h.body : null, s.status === 200 ? s.body : null);
  renderScopeTable();
  renderKeyTable();
  if (location.hash === '#stats') startStatsTimer();
}
function csvCell(v) { const s = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportStatsCsv() {
  if (!STATS) { toast('统计还没加载完'); return; }
  const t = STATS.totals || {}; const lat = STATS.latency || {};
  const cats = STATS.categories || {};
  const lines = [];
  lines.push('区间,' + STATS.from + ' ~ ' + STATS.to + ',天数,' + STATS.days);
  lines.push('');
  lines.push('分类,请求,错误,平均延迟ms');
  for (const name of STATS_CAT_ORDER.concat(['system'])) {
    const c = catOf(cats, name);
    lines.push([STATS_CAT_LABEL[name], c.requests, c.errors, c.latencyAvg.toFixed(1)].join(','));
  }
  lines.push('');
  lines.push('日期,业务请求,检索/重排,索引操作,嵌入,系统/轮询,错误,成功率,平均延迟ms,最大延迟ms');
  for (const d of STATS.byDay || []) {
    const biz = Number(d.retrievalRequests || 0) + Number(d.indexingRequests || 0) + Number(d.embeddingRequests || 0);
    const success = d.requests ? (100 - ratePct(d.errors, d.requests)) : 0;
    lines.push([d.day, biz, d.retrievalRequests, d.indexingRequests, d.embeddingRequests, d.systemRequests,
      d.errors, success.toFixed(1), Number(d.latencyAvg || 0).toFixed(1), Number(d.latencyMax || 0).toFixed(1)].join(','));
  }
  lines.push('');
  lines.push('仓库/作用域,类型,请求,检索,嵌入,重排,错误率,平均延迟ms');
  for (const s of STATS.byScope || []) {
    const label = (s.repoName || s.namespace || '') + (s.kind ? ' #' + s.kind + (s.ref ? ':' + s.ref : '') : '');
    lines.push([csvCell(label), s.kind || 'deleted', s.requests, s.searchCalls, s.embedTexts, s.rerankCalls,
      s.requests ? rateText(s.errors, s.requests) : '—', Number(s.latencyAvg || 0).toFixed(1)].join(','));
  }
  lines.push('');
  lines.push('Key,角色,请求,错误,嵌入,检索,重排,平均延迟ms,最后使用');
  for (const k of STATS.byKey || []) lines.push([csvCell(k.name || ('#' + k.keyId)), k.role, k.requests, k.errors, k.embedTexts, k.searchCalls, k.rerankCalls, Number(k.latencyAvg || 0).toFixed(1), k.lastUsedAt ? new Date(k.lastUsedAt * 1000).toISOString() : ''].join(','));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'code-index-stats-' + STATS.days + 'd-' + STATS.to + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 3000);
}

// ---------------- 日志 ----------------
async function loadLogs() {
  const r = await api('/log?n=300');
  if (r.status !== 200) return;
  $('#log-lines').textContent = ((r.body && r.body.lines) || []).join(String.fromCharCode(10)) || '（空）';
}

// ---------------- 初始化 ----------------
$('#btn-refresh').onclick = () => { refreshHealth(); if (location.hash === '#models') loadModels(); if (location.hash === '#stats') loadStats(STATS_DAYS); if (location.hash === '#keys') loadKeys(); if (location.hash === '#logs') loadLogs(); };
$('#btn-pause').onclick = () => action('pause');
$('#btn-resume').onclick = () => action('resume');
$('#btn-sweep').onclick = () => action('sweep');
$('#btn-purge-tags').onclick = purgeTags;
$('#btn-test').onclick = searchTest;
$('#test-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchTest(); });
$('#btn-create-key').onclick = createKey;
$('#key-role').onchange = updateRoleHint;
$('#key-filter').oninput = renderKeys;
$('#btn-test-key').onclick = testKeyAccess;
$('#btn-reset-index').onclick = resetIndex;
updateRoleHint();
$('#btn-setup').onclick = setupAdmin;
$('#btn-logs').onclick = loadLogs;
$('#filter').oninput = renderScopes;
$$('[data-days]').forEach((b) => { b.onclick = () => loadStats(b.dataset.days); });
$('#btn-stats-refresh').onclick = () => loadStats(STATS_DAYS);
$('#btn-stats-export').onclick = exportStatsCsv;
$('#stats-auto').onchange = () => { if (location.hash === '#stats') startStatsTimer(); };
$$('[data-goto]').forEach((b) => { b.onclick = () => { location.hash = '#' + b.dataset.goto; }; });
$$('nav.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
$('#btn-logout').onclick = async () => { await fetch('/admin/logout', { method: 'POST' }); location.replace('/admin'); };
$('#btn-copy-key').onclick = async () => { try { await navigator.clipboard.writeText($('#key-plain').textContent); toast('已复制'); } catch (e) { toast('复制失败（浏览器限制）'); } };
$('#setup-pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') setupAdmin(); });
window.addEventListener('hashchange', () => showTab((location.hash || '#overview').slice(1)));
// 初始化只触发一次刷新：showTab('overview'/'scopes') 内部会 refreshHealth；
// 其它 tab 首屏也补一次（标题栏的 ready/tag 需要），但都走 REFRESH_INFLIGHT 去重。
const INITIAL_TAB = (location.hash || '#overview').slice(1);
showTab(INITIAL_TAB);
if (INITIAL_TAB !== 'overview' && INITIAL_TAB !== 'scopes') refreshHealth();
// 模型列表只在「模型」Tab 打开时拉取（冷启动指纹 ~1s，不再拖慢首页）
setInterval(() => { if (document.visibilityState === 'visible' && $('#auto') && $('#auto').checked && (location.hash === '' || location.hash === '#overview' || location.hash === '#scopes')) refreshHealth(); }, 15000);
</script>
</body>
</html>
"""

LOGIN_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>code-index-service · 登录</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  :root { --bg:#f5f6f8; --card:#fff; --line:#e4e7ec; --text:#1b1f24; --muted:#667085; --blue:#175cd3; --bad:#b42318; --bad-bg:#fdecea; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1016; --card:#161a22; --line:#262c37; --text:#e7e9ee; --muted:#98a2b3; --blue:#84adff; --bad:#fda29b; --bad-bg:#3a1512; } }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text);
         font:13px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .box { width:min(360px,92vw); background:var(--card); border:1px solid var(--line); border-radius:14px; padding:26px 24px; }
  h1 { font-size:17px; margin:0 0 4px; }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:12.5px; }
  label { display:block; color:var(--muted); font-size:12px; margin:12px 0 5px; }
  input { width:100%; padding:9px 11px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--text); font-size:13px; }
  button { width:100%; margin-top:20px; padding:10px; border-radius:8px; border:1px solid var(--blue); background:var(--blue); color:#fff; font-size:13.5px; cursor:pointer; }
  button:disabled { opacity:.5; }
  #err { display:none; margin-top:14px; padding:8px 10px; border-radius:8px; border:1px solid var(--bad); background:var(--bad-bg); color:var(--bad); font-size:12.5px; }
  .foot { margin-top:16px; color:var(--muted); font-size:11.5px; text-align:center; }
</style></head>
<body>
<div class="box">
  <h1>code-index-service</h1>
  <p class="sub">管理控制台 · 请输入管理员账号</p>
  <form id="f">
    <label>用户名</label>
    <input id="u" autocomplete="username" value="admin" spellcheck="false">
    <label>密码</label>
    <input id="p" type="password" autocomplete="current-password">
    <button id="b" type="submit">登录</button>
  </form>
  <div id="err"></div>
  <div class="foot">登录状态保持 12 小时 · HttpOnly Cookie</div>
</div>
<script>
const $ = (s) => document.querySelector(s);
function showErr(m) { const e = $('#err'); e.textContent = m; e.style.display = 'block'; }
$('#f').onsubmit = async (ev) => {
  ev.preventDefault();
  const btn = $('#b'); btn.disabled = true; $('#err').style.display = 'none';
  try {
    const r = await fetch('/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('#u').value, password: $('#p').value }) });
    if (r.status === 200) { location.replace('/admin'); return; }
    const b = await r.json().catch(() => ({}));
    showErr(b.error === 'too-many-attempts' ? '失败次数过多，请 5 分钟后再试' : '用户名或密码不正确');
  } catch (e) { showErr('网络错误：' + e); }
  btn.disabled = false;
};
</script>
</body></html>
"""


# ---------------- 模型热切换（供 /v1/admin/models/activate 调用） ----------------
def _load_ort():
    import onnxruntime as ort
    return ort


def _make_embedder(directory, name, profile):
    if FAKE_EMBED:
        return FakeEmbedder(name=name)
    ort = _load_ort()
    providers = state.get("providers") or ["CPUExecutionProvider"]
    return _load("embedder").Embedder(ort, directory, providers, THREADS, name, profile)


def activate_embed(directory):
    """热切换嵌入模型：暂停 governor → 等空闲 → 加载新模型 → 换全局 → 重新打 tag → kNN 失效。"""
    global embedder
    spec = models_admin.validate_embed_dir(directory, roots=MODEL_ROOTS)
    t0 = time.time()
    with MODEL_LOCK:
        was_paused = bool(governor and governor.paused)
        if governor:
            governor.pause()
            governor.wait_idle(15)
        try:
            new = _make_embedder(spec["dir"], spec["name"], spec.get("profile"))
            info = new.info(state.get("ort_version", "?"))
            info["available_providers"] = state.get("available_providers") or []
            info["threads"] = THREADS
            prev_tag = state["info"].get("tag")
            embedder = new
            if governor:
                governor.embedder = new
            state["info"] = info
            state["model_dir"] = spec["dir"]
            state["model_switched_at"] = time.time()
            ACTIVE["embed_dir"] = spec["dir"]
            ACTIVE["embed_name"] = spec["name"]
            # 关键：repos.tag 立即指向新 tag → 旧 tag 向量不会再被检索到（等客户端重新同步）
            repos = store.set_all_tags(info["tag"]) if store else 0
            if knn:
                knn.invalidate()
            log(f"model switched: {prev_tag} -> {info['tag']} ({repos} repos retagged)")
            return {"ok": True, "tag": info["tag"], "prevTag": prev_tag, "model": info.get("model"),
                    "dir": spec["dir"], "name": spec["name"], "repos": repos,
                    "ms": round((time.time() - t0) * 1000, 1)}
        finally:
            if governor and not was_paused:
                governor.resume()


def activate_rerank(directory):
    global reranker
    spec = models_admin.validate_rerank_dir(directory, roots=MODEL_ROOTS)
    with MODEL_LOCK:
        if FAKE_EMBED:
            return {"ok": False, "error": "FAKE_EMBED 模式不能加载重排模型"}
        ort = _load_ort()
        providers = state.get("providers") or ["CPUExecutionProvider"]
        new = _load("reranker").Reranker(ort, spec["dir"], providers, THREADS, RERANK_MAX_TOKENS, RERANK_BATCH)
        reranker = new
        state.update(rerank_ready=True, rerank_err=None, rerank_info=new.info())
        ACTIVE["rerank_dir"] = spec["dir"]
        log(f"rerank switched: {state['rerank_info']}")
        return {"ok": True, "dir": spec["dir"], **new.info()}


def deactivate_rerank():
    global reranker
    with MODEL_LOCK:
        reranker = None
        state.update(rerank_ready=False, rerank_err="disabled by admin", rerank_info={})
        log("rerank disabled by admin")
        return {"ok": True, "rerank_ready": False}


def reset_index(confirm: str):
    """清空所有作用域/块/向量/正文（保留 API Key、统计与模型设置），然后 VACUUM。

    这是破坏性操作：调用方必须传 confirm="RESET"。客户端（插件/review-service）下次同步会
    自动全量重建；本函数只负责把服务端清干净。
    """
    if str(confirm or "") != "RESET":
        raise ValueError('confirm 必须为 "RESET"')
    t0 = time.time()
    with MODEL_LOCK:  # 嵌入线程/热切换互斥
        was_paused = bool(governor and governor.paused)
        if governor:
            governor.pause()
            governor.wait_idle(30)
        try:
            with store.lock:
                deleted = {}
                for table in ("chunks", "vectors", "blobs", "repos", "lineages"):
                    cur = store.db.execute(f"delete from {table}")
                    deleted[table] = int(cur.rowcount or 0)
                store.db.commit()
                try:
                    store.db.execute("VACUUM")
                    store.db.commit()
                    # WAL 模式下 VACUUM 的新页先写进 WAL，不做 checkpoint 的话主库文件不会缩小
                    store.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    log("reset-index: vacuum + checkpoint 完成")
                except Exception as e:  # noqa: BLE001 —— VACUUM 失败不影响"已清空"这个事实
                    log(f"reset-index: VACUUM 失败（忽略）{type(e).__name__}: {e}")
            store._invalidate()
            if knn:
                knn.invalidate()
            state["reset_at"] = time.time()
            log(f"index reset: {deleted} in {(time.time() - t0) * 1000:.0f} ms")
            return {"ok": True, "deleted": deleted, "ms": round((time.time() - t0) * 1000, 1)}
        finally:
            if governor and not was_paused:
                governor.resume()


def _annotate_download_models(out, installed):
    """给“可下载模型”标出本机已有同款（按 tag / 目录名），避免再下载一份副本。"""
    tag_index = {}
    fp_index = {}
    by_base = {}
    for items in (installed or {}).values():
        for it in items:
            if it.get("tag"):
                tag_index[it["tag"]] = it
            if it.get("fingerprint"):
                fp_index[str(it["fingerprint"])] = it
            base = os.path.basename(str(it.get("dir") or "").rstrip("/\\"))
            if base:
                by_base[base] = it
    for m in out.get("models") or []:
        target = str(m.get("target") or "")
        if not target:
            continue
        hit = None
        if m.get("ready"):
            try:
                info = models_admin.tag_for_dir(target)
                hit = tag_index.get(info["tag"]) or fp_index.get(str(info.get("fingerprint") or ""))
            except Exception:
                hit = None
        if hit is None:
            hit = by_base.get(os.path.basename(target.rstrip("/\\")))
        if hit is None:
            continue
        try:
            if os.path.realpath(str(hit.get("dir") or "")) == os.path.realpath(target):
                continue
        except Exception:
            continue
        m["installedElsewhere"] = {"dir": hit.get("dir"), "tag": hit.get("tag"),
                                   "active": bool(hit.get("active"))}


def models_payload():
    installed = {"embed": [], "rerank": []}
    err = None
    try:
        installed = models_admin.discover(
            roots=MODEL_ROOTS,
            active_embed_dir=ACTIVE["embed_dir"],
            active_rerank_dir=ACTIVE["rerank_dir"],
        )
    except Exception as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {e}"
    out = {
        "root": MODELS_DIR,
        "models": downloader.list(),
        "installed": installed,
        "roots": MODEL_ROOTS,
        "active": {
            "embed": {"dir": ACTIVE["embed_dir"], "name": ACTIVE["embed_name"],
                      "tag": state["info"].get("tag"), "model": state["info"].get("model")},
            "rerank": {"dir": ACTIVE["rerank_dir"], "ready": state["rerank_ready"],
                       "tag": state["rerank_info"].get("rerank_tag"),
                       "model": state["rerank_info"].get("rerank_model")},
        },
    }
    if err:
        out["error"] = err
    else:
        try:
            _annotate_download_models(out, installed)
        except Exception as e:  # noqa: BLE001 —— 标注失败不影响主数据
            log(f"models: 标注 installedElsewhere 失败（忽略）{type(e).__name__}: {e}")
    return out


class FakeEmbedder:
    """自测用：不需要 onnx 模型，向量由文本哈希确定，但仍保持 L2 归一化与确定性。"""

    def __init__(self, dim=16, name=""):
        self.dim = dim
        self.tag = f"{name or 'fake-model'}-0000fake-fp32"
        self.model_file = "fake.onnx"
        self.model_dir = "(fake)"

    def info(self, ort_version="0"):
        return {"model": self.model_file, "model_bytes": 0, "tag": self.tag, "providers": ["Fake"], "ort": ort_version}

    def embed(self, texts, is_query=False):
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, t in enumerate(texts):
            seed = f"{'Q:' if is_query else ''}{t}".encode("utf-8")
            h = 2166136261
            for b in seed[:256]:
                h = ((h ^ b) * 16777619) & 0xFFFFFFFF
            rng = np.random.default_rng(h)
            v = rng.standard_normal(self.dim).astype(np.float32)
            out[i] = v / (np.linalg.norm(v) or 1.0)
        return out


state = {"ready": False, "err": None, "info": {}, "rerank_ready": False, "rerank_err": None, "rerank_info": {}}
store = None
knn = None
governor = None
embedder = None
reranker = None


def _load(name):
    """按需导入同目录模块（脚本目录就是 cwd，所以普通 import 即可）。"""
    import importlib

    return importlib.import_module(name)


def build():
    global store, knn, governor, embedder, reranker
    if FAKE_EMBED:
        # 自测路径：完全不碰 onnxruntime / 模型文件
        embedder = FakeEmbedder()
        info = embedder.info("0")
        info["available_providers"] = ["Fake"]
        info["threads"] = THREADS
        state.update(ready=True, info=info, providers=["Fake"], available_providers=["Fake"], ort_version="0")
        ACTIVE["embed_name"] = "fake-model"
        log(f"embed ready (fake): tag={info['tag']}")
    else:
        import onnxruntime as ort

        ort.set_default_logger_severity(3)
        avail = ort.get_available_providers()
        providers = [p for p in PROVIDERS if p in avail] or ["CPUExecutionProvider"]
        embedder = _load("embedder").Embedder(ort, MODEL_DIR, providers, THREADS, MODEL_NAME)
        info = embedder.info(ort.__version__)
        info["available_providers"] = avail
        info["threads"] = THREADS
        state.update(ready=True, info=info, providers=providers, available_providers=avail, ort_version=ort.__version__)
        # 控制台展示用：优先环境变量 MODEL_NAME，否则按目录名映射内置 profile 的模型名
        ACTIVE["embed_name"] = MODEL_NAME or models_admin.name_for_dir(MODEL_DIR)
        log(f"embed ready: tag={info['tag']} providers={info['providers']}")

        try:
            reranker = _load("reranker").Reranker(ort, RERANK_DIR, providers, THREADS, RERANK_MAX_TOKENS, RERANK_BATCH)
            state.update(rerank_ready=True, rerank_info=reranker.info())
            log(f"rerank ready: {state['rerank_info']}")
        except Exception as e:
            state.update(rerank_ready=False, rerank_err=f"{type(e).__name__}: {e}")
            log("rerank unavailable: " + state["rerank_err"])

    store = index_store.IndexStore(DB_PATH, scope_ttl=SCOPE_TTL)
    knn = _load("knn").KnnCache(store, KNN_MAX_BYTES)
    governor = _load("governor").EmbedGovernor(store, embedder, knn, EMBED_RATE, EMBED_BATCH, "spread", log)
    governor.start()
    log(f"index store ready: db={DB_PATH} rate={EMBED_RATE}/s batch={EMBED_BATCH} knnMax={KNN_MAX_BYTES}B")
    if SCOPE_SWEEP:
        # janitor：启动后延迟 SCOPE_SWEEP_FIRST_DELAY 再跑第一次（避开 warmup 抢 CPU），此后周期扫。
        threading.Thread(target=_janitor_loop, name="scope-janitor", daemon=True).start()
        log(f"scope janitor on: interval={SCOPE_SWEEP_INTERVAL}s firstDelay={SCOPE_SWEEP_FIRST_DELAY}s")
    if WARMUP:
        threading.Thread(target=_warmup, name="warmup", daemon=True).start()


def _warmup():
    """把三条冷路径提前跑热：嵌入会话、重排内核、最大的 kNN 矩阵。

    代价是启动后 ~3 s 的 CPU/GPU 忙；收益是**第一个真人查询**不再吃 2.4 s（kNN 矩阵）
    或 2.5 s（rerank 内核编译）。任一步失败都只记日志，绝不影响服务可用性。
    """
    import time as _t

    _t.sleep(0.5)
    try:
        t0 = _t.time()
        embedder.embed(["warmup"], is_query=True)
        log(f"warmup: embed {(_t.time() - t0) * 1000:.0f} ms")
    except Exception as e:
        log(f"warmup: embed 失败（忽略）{type(e).__name__}: {e}")
    if reranker is not None:
        try:
            t0 = _t.time()
            reranker.score("warmup", ["warmup text"])
            log(f"warmup: rerank {(_t.time() - t0) * 1000:.0f} ms")
        except Exception as e:
            log(f"warmup: rerank 失败（忽略）{type(e).__name__}: {e}")
    # 预热 store 的重查询缓存：counts() 的 JOIN 在 16 万块上 ~0.4s/作用域，
    # tag_stats()/total_bytes() 要扫全表；不预热的话"重启后第一次打开控制台"要等 5~10s。
    try:
        t0 = _t.time()
        for _r in store.db.execute("select namespace from repos").fetchall():
            try:
                store.counts(_r["namespace"])
            except Exception:  # noqa: BLE001
                pass
        store.tag_stats()
        store.total_bytes()
        log(f"warmup: store stats {(_t.time() - t0) * 1000:.0f} ms")
    except Exception as e:  # noqa: BLE001
        log(f"warmup: store stats 失败（忽略）{type(e).__name__}: {e}")
    # 预热模型发现（指纹要读 195MB+556MB，冷启动 ~1s；后台"模型"页首次打开就快）
    try:
        t0 = _t.time()
        models_admin.discover(roots=MODEL_ROOTS, active_embed_dir=ACTIVE["embed_dir"],
                              active_rerank_dir=ACTIVE["rerank_dir"])
        log(f"warmup: model discovery {(_t.time() - t0) * 1000:.0f} ms")
    except Exception as e:  # noqa: BLE001
        log(f"warmup: model discovery 失败（忽略）{type(e).__name__}: {e}")
    try:
        row = store.db.execute(
            "select r.namespace, r.tag, (select count(*) from chunks c where c.namespace = r.namespace) as n"
            " from repos r order by n desc limit 1"
        ).fetchone()
        if row and row["n"] and row["tag"]:
            t0 = _t.time()
            hashes, mat, meta = knn.get(row["namespace"], row["tag"])
            if mat.shape[0]:
                q = embedder.embed(["warmup"], is_query=True)[0]
                knn.topk(mat, q, 10)   # topk 是 KnnCache 的 staticmethod，不是模块函数
            log(f"warmup: knn {row['namespace'][:24]}… n={mat.shape[0]} {(_t.time() - t0) * 1000:.0f} ms")
    except Exception as e:
        log(f"warmup: knn 失败（忽略）{type(e).__name__}: {e}")


def run_sweep(now=None):
    """扫一遍过期 scope：删 scope → 失效 kNN → 对受影响 lineage 做 retention GC。

    janitor 线程与 `POST /v1/admin/sweep` 共用这一条路径，保证两边行为一致。
    """
    now = int(time.time()) if now is None else int(now)
    result = store.sweep_scopes(now)
    for ns in result.get("deleted", []):
        knn.invalidate(ns)
        log(f"janitor: scope expired & deleted: {ns}")
    gc_stats = {}
    for lineage in result.get("lineages", []):
        try:
            stats = store.gc(lineage, RETENTION_DAYS)
            gc_stats[lineage] = stats
            log(f"janitor: gc lineage={lineage} blobs={stats['blobs']} vectors={stats['vectors']}")
        except Exception as e:  # gc 失败不能影响其余 scope 的清理
            log(f"janitor: gc failed lineage={lineage}: {type(e).__name__}: {e}")
    out = {"deleted": result.get("deleted", []), "lineages": result.get("lineages", [])}
    if gc_stats:
        out["gc"] = gc_stats
    return out


def _janitor_loop():
    time.sleep(SCOPE_SWEEP_FIRST_DELAY)
    while True:
        try:
            run_sweep()
        except Exception as e:
            log(f"janitor sweep failed: {type(e).__name__}: {e}")
        time.sleep(SCOPE_SWEEP_INTERVAL)


# ------------------------------------------------------------------ 业务
def _namespaces_from_request(raw, single):
    """把 {namespaces:[{namespace,weight?}]} / {namespace:"..."} 归一成 [(namespace, weight)]。

    旧客户端只传 namespace → 单元素数组，走同一实现（与旧结果等价）。
    """
    entries = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                if item:
                    entries.append((item, 1.0))
            elif isinstance(item, dict):
                ns = item.get("namespace") or ""
                if not ns:
                    continue
                weight = item.get("weight", 1.0)
                try:
                    weight = max(0.0, float(weight))
                except (TypeError, ValueError):
                    weight = 1.0
                entries.append((str(ns), weight))
    if not entries and single:
        entries.append((str(single), 1.0))
    if not entries:
        # 保持旧行为：namespace 缺失 → 404 unknown-namespace
        entries.append(("", 1.0))
    return entries


def _hit_scope(repo):
    if not repo:
        return {"kind": "legacy", "ref": None}
    return {"kind": repo["scope_kind"] or "legacy", "ref": repo["scope_ref"]}


def search(namespaces, query, k=10, tag=None, rerank_candidates=0, embed_text=None):
    """多作用域检索：embed 一次 → 每 ns topk → 按 hash 去重 + 加权 RRF(k=20) → 可选重排。

    单 namespace（或数组长度 1）与旧实现等价：hits 的 hash/顺序/score 一致，旧字段全保留。
    """
    if isinstance(namespaces, str) or namespaces is None:
        namespaces = [(namespaces or "", 1.0)]
    entries = list(namespaces)
    single = len(entries) == 1
    by_scope = []
    usable = []
    for ns, weight in entries:
        repo = store.repo(ns)
        if not repo:
            by_scope.append({"namespace": ns, "error": "unknown-namespace"})
            continue
        use_tag = tag or repo["tag"]
        if not use_tag:
            by_scope.append({"namespace": ns, "error": "no-tag",
                             "reason": "该命名空间还没有模型标签（先同步一次）"})
            continue
        usable.append({"namespace": ns, "weight": weight, "repo": repo, "tag": use_tag})
    if not usable:
        if single:
            repo = store.repo(entries[0][0])
            if repo is None:
                return {"error": "unknown-namespace", "namespace": entries[0][0]}, 404
            return {"hits": [], "reason": "该命名空间还没有模型标签（先同步一次）", "ms": {},
                    "byScope": by_scope}, 200
        return {"hits": [], "reason": "没有可检索的作用域（未知命名空间或还没同步过模型标签）",
                "ms": {}, "byScope": by_scope}, 200

    req_text = embed_text or query
    t0 = time.time()
    # ① 查询向量只 embed 一次（多作用域共享）
    with MODEL_LOCK:  # 热切换时避免新旧模型混用
        qvec = embedder.embed([req_text], is_query=True)[0]
    embed_ms = (time.time() - t0) * 1000

    merged = {}
    knn_total_ms = 0.0
    dim_error = None
    for item in usable:
        ns = item["namespace"]
        repo = item["repo"]
        use_tag = item["tag"]
        weight = item["weight"]
        coverage = store.counts(ns)["coverage"]
        item["coverage"] = coverage
        hashes, mat, meta = knn.get(ns, use_tag)
        if mat.shape[0] == 0:
            by_scope.append({"namespace": ns, "hits": 0, "coverage": coverage,
                             "ms": {"embed": round(embed_ms, 1), "knn": 0}})
            continue
        if qvec.shape[0] != mat.shape[1]:
            dim_error = f"query dim {qvec.shape[0]} != index dim {mat.shape[1]}"
            by_scope.append({"namespace": ns, "error": "dim-mismatch", "detail": dim_error})
            continue
        t1 = time.time()
        # ② 每个 ns 取 topk(max(k, rerank_candidates) * 2)：给跨作用域融合留余量
        take = max(int(k), int(rerank_candidates or 0)) * 2
        order, scores = knn.topk(mat, qvec, take)
        knn_ms = (time.time() - t1) * 1000
        knn_total_ms += knn_ms
        seen = set()
        ns_rank = 0
        for idx, sc in zip(order, scores):
            h = hashes[int(idx)]
            if h in seen:  # 同一 ns 内同内容多路径 → 只算一次，避免重复加权
                continue
            seen.add(h)
            ns_rank += 1
            path, start, end = meta[h]
            # ③ 合并：key=hash；score 取最高，来源保留首个 ns；rrf += weight/(k+rank)（rank 从 1 起，与插件一致）
            contribution = weight / (RRF_K + ns_rank)
            cur = merged.get(h)
            if cur is None:
                merged[h] = {
                    "hash": h, "path": path, "start": start, "end": end,
                    "score": float(sc), "namespace": ns,
                    "scope": _hit_scope(repo), "rrf": contribution,
                }
            else:
                cur["rrf"] += contribution
                if float(sc) > cur["score"]:
                    cur["score"] = float(sc)
        by_scope.append({"namespace": ns, "hits": len(seen), "coverage": coverage,
                         "ms": {"embed": round(embed_ms, 1), "knn": round(knn_ms, 1)}})

    if not merged:
        if single:
            if dim_error:
                return {"error": "dim-mismatch", "detail": dim_error}, 409
            return {"hits": [], "reason": "该命名空间还没有向量",
                    "ms": {"embed": round(embed_ms, 1)}, "byScope": by_scope}, 200
        return {"hits": [], "ms": {"embed": round(embed_ms, 1), "knn": round(knn_total_ms, 1)},
                "byScope": by_scope}, 200

    ranked = sorted(merged.values(), key=lambda h: (-h["rrf"], -h["score"], h["hash"]))
    rerank_ms = 0.0
    if rerank_candidates and reranker is not None and len(ranked) > 1:
        pool = ranked[: int(rerank_candidates)]
        # 正文按 lineage 批量取（多作用域可能跨血统）
        groups = {}
        for h in pool:
            repo = store.repo(h["namespace"]) or usable[0]["repo"]
            groups.setdefault(repo["lineage_id"], []).append(h["hash"])
        bodies = {}
        for lineage, hashes_in in groups.items():
            bodies.update(store.bodies(lineage, hashes_in))
        t2 = time.time()
        try:
            with MODEL_LOCK:
                sc = reranker.score(query, [bodies.get(h["hash"], "") for h in pool])
            rerank_ms = (time.time() - t2) * 1000
            for h, s in zip(pool, sc):
                h["rerankScore"] = round(float(s), 6)
            pool.sort(key=lambda h: h["rerankScore"], reverse=True)
            ranked = pool + ranked[len(pool):]
        except Exception as e:
            rerank_ms = (time.time() - t2) * 1000
            ranked[0]["rerankError"] = str(e)[:160]

    hits = []
    for h in ranked[: int(k)]:
        hit = {"hash": h["hash"], "path": h["path"], "start": h["start"], "end": h["end"],
               "score": round(float(h["score"]), 6),
               "namespace": h["namespace"], "scope": h["scope"], "rrf": round(h["rrf"], 6)}
        if "rerankScore" in h:
            hit["rerankScore"] = h["rerankScore"]
        elif "rerankError" in h:
            hit["rerankError"] = h["rerankError"]
        hits.append(hit)

    # 顶层 coverage：多作用域按权重加权平均（单作用域时与旧值完全一致）
    total_weight = sum(max(0.0, item["weight"]) for item in usable) or len(usable)
    coverage = sum(item["coverage"] * max(0.0, item["weight"]) for item in usable) / total_weight
    return {
        "hits": hits,
        "ms": {"embed": round(embed_ms, 1), "knn": round(knn_total_ms, 1), "rerank": round(rerank_ms, 1)},
        "coverage": round(coverage, 4),
        "byScope": by_scope,
    }, 200


def repo_status(namespace):
    repo = store.repo(namespace)
    if not repo:
        return {"error": "unknown-namespace"}, 404
    out = {
        "namespace": namespace,
        "lineage": repo["lineage_id"],
        "repoId": repo["repo_id"],
        "repoName": repo.get("repo_name"),
        "chunkFp": repo["chunk_fp"],
        "revision": repo["revision"],
        "tag": repo["tag"],
        "repoState": repo["repo_state"],
        "scope": {
            "kind": repo["scope_kind"] or "legacy",
            "ref": repo["scope_ref"],
            "commit": repo["commit_sha"],
            "createdAt": repo["created_at"],
            "expiresAt": repo["expires_at"],
            "pinned": bool(repo["pinned"]),
        },
    }
    out.update(store.counts(namespace))
    out.update(store.lineage_bytes(repo["lineage_id"]))
    out.update(governor.status(namespace))
    out["limits"] = {
        "maxVectorsPerLineage": MAX_VECTORS_PER_LINEAGE,
        "maxTotalGb": round(MAX_TOTAL_BYTES / 1024**3, 2),
        "retentionDays": RETENTION_DAYS,
        "maxScopes": MAX_SCOPES,
        "maxSearchScopes": MAX_SEARCH_SCOPES,
        "scopeTtlDays": {k: v for k, v in SCOPE_TTL.items() if v is not None},
    }
    return out, 200


def scope_list(repo_id=None, kind=None):
    """GET /v1/scopes 的响应体：把 scope_overview() 映射成契约里的字段名。"""
    out = []
    for it in store.scope_overview(repo_id=repo_id, kind=kind, limit=max(50, MAX_SCOPES)):
        scope = it.get("scope") or {}
        out.append({
            "namespace": it["namespace"],
            "kind": scope.get("kind") or "legacy",
            "ref": scope.get("ref"),
            "repoId": it["repo_id"],
            "repoName": it.get("repo_name"),
            "chunkFp": it["chunk_fp"],
            "revision": it["revision"],
            "commit": scope.get("commit"),
            "chunks": it.get("chunks", 0),
            "vectors": it.get("vectors", 0),
            "coverage": it.get("coverage", 0.0),
            "createdAt": scope.get("createdAt"),
            "expiresAt": scope.get("expiresAt"),
            "pinned": bool(scope.get("pinned")),
            "ttlRemaining": it.get("ttlRemaining"),
        })
    return out


def delete_scope(namespace):
    """DELETE /v1/scopes/{ns}：删 scope + 失效 kNN + 对血统做 retention GC（共享内容不会被误删）。"""
    result = store.delete_scope(namespace)
    if result.get("deleted"):
        knn.invalidate(namespace)
        lineage = result.get("lineage")
        if lineage:
            try:
                store.gc(lineage, RETENTION_DAYS)
            except Exception as e:
                log(f"delete scope gc failed lineage={lineage}: {type(e).__name__}: {e}")
        log(f"scope deleted: {namespace} chunks={result.get('chunks', 0)}")
    return {"deleted": bool(result.get("deleted")), "chunks": result.get("chunks", 0)}


def _scope_from_sync(req, ns):
    """解析 sync 里的可选 scope 元数据 → (canonical_ns, scope_meta)。

    namespace 以服务端推导出的 canonical 为准（响应里回给客户端）；
    没有 scope 时原样返回路径里的 namespace（老客户端/legacy 行为不变）。
    """
    scope = req.get("scope")
    if not isinstance(scope, dict):
        return ns, None
    existing = store.repo(ns)
    repo_id = req.get("repoId") or (existing or {}).get("repo_id")
    chunk_fp = req.get("chunkFp") or (existing or {}).get("chunk_fp")
    if not repo_id or not chunk_fp:
        guess_repo, guess_fp = index_store.namespace_identity(ns)
        repo_id = repo_id or guess_repo
        chunk_fp = chunk_fp or guess_fp
    ttl_days = scope.get("ttlDays")
    if ttl_days is not None:
        try:
            ttl_days = int(ttl_days)
        except (TypeError, ValueError):
            raise index_store.ScopeFormatError("bad-ttl-days", f"ttlDays={ttl_days!r}")
    canonical = index_store.canonical_namespace(repo_id, chunk_fp, scope.get("kind"), scope.get("ref"))
    return canonical, {
        "kind": scope.get("kind"),
        "ref": scope.get("ref"),
        "commit": scope.get("commit"),
        "ttl_days": ttl_days,
    }


def ensure_capacity(lineage):
    vecs = store.vector_count(lineage)
    if int(vecs) > MAX_VECTORS_PER_LINEAGE:
        return {
            "error": "lineage-vector-cap",
            "detail": f"该血统向量数 {vecs} 超过上限 {MAX_VECTORS_PER_LINEAGE}",
            "lineageBytes": store.lineage_bytes(lineage),
            "hint": "POST /v1/admin/gc {lineage} 清理，或调大 MAX_VECTORS_PER_LINEAGE",
        }
    total = store.total_bytes()
    if total > MAX_TOTAL_BYTES:
        return {
            "error": "server-full",
            "detail": f"总占用 {total} B 超过上限 {MAX_TOTAL_BYTES} B",
            "hint": "先清理不用的血统（/v1/admin/gc）",
        }
    return None


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True  # 见文件头第 3 条

    def _send(self, code, payload, ctype="application/json", headers=None):
        self._status = code
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        extra = "".join(f"{k}: {v}\r\n" for k, v in (headers or {}).items())
        head = (
            f"HTTP/1.1 {code} {self.responses.get(code, ('OK',))[0]}\r\n"
            f"Content-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"{extra}"
            "Connection: keep-alive\r\n\r\n"
        ).encode()
        self.wfile.write(head + body)

    def log_message(self, fmt, *args):
        pass

    def _body(self):
        """读请求体并**始终返回 dict**。

        兼容三种来源：JSON 客户端、浏览器原生表单提交（x-www-form-urlencoded，页面脚本没跑起来时）、
        以及空 body。之前直接 json.loads 遇到表单体/JSON 字符串会抛异常或返回 str，
        /admin/login 会 500（实测踩到，2026-10-22）。
        """
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        if not raw:
            return {}
        try:
            val = json.loads(raw)
        except Exception:  # noqa: BLE001
            try:
                from urllib.parse import parse_qs

                return {k: v[0] for k, v in parse_qs(raw.decode("utf-8", "replace")).items() if v}
            except Exception:  # noqa: BLE001
                return {}
        return val if isinstance(val, dict) else {}

    # ---------------- 鉴权：API Key（多把）/ 后台会话或 Basic ----------------
    def _bearer(self):
        auth = self.headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            return None
        return auth.split(" ", 1)[1].strip()

    def _auth_info(self):
        """解析 Bearer：先匹配环境变量 legacy key（id=0, admin），再查 admin.db。"""
        token = self._bearer()
        if not token:
            return None
        if API_KEY and hmac.compare_digest(token, API_KEY):
            return {"id": 0, "name": "env API_KEY", "role": "admin", "enabled": True}
        row = adm.lookup(token)
        if row is None:
            return None
        return {
            "id": int(row["id"]),
            "name": row.get("name") or "",
            "role": row.get("role") or "index",
            "enabled": bool(row.get("enabled")),
        }

    def auth_required(self):
        """有任意 Key（env 或 admin.db）就强制 API 鉴权；全空时保持开放（首次部署/自测）。"""
        return bool(API_KEY) or adm.has_keys()

    def _api_ok(self):
        """索引/检索客户端：Bearer Key（index 或 admin 角色均可）。"""
        if not self.auth_required():
            self._who = {"id": 0, "name": "open", "role": "admin", "enabled": True}
            return True
        info = self._auth_info()
        self._who = info
        return bool(info and info["enabled"])

    def _cookie(self, name):
        raw = self.headers.get("cookie", "")
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return None

    def _session_ok(self):
        token = self._cookie("dsh_admin")
        return bool(token and adm.verify_session(token))

    def _basic_ok(self):
        """后台页面：HTTP Basic（env ADMIN_USER/ADMIN_PASSWORD 或 admin.db 里的管理员密码）。"""
        auth = self.headers.get("authorization", "")
        if not auth.lower().startswith("basic "):
            return False
        try:
            raw = base64.b64decode(auth.split(" ", 1)[1].strip()).decode("utf-8", "replace")
        except Exception:
            return False
        user, _, pwd = raw.partition(":")
        if not hmac.compare_digest(user, ADMIN_USER):
            return False
        if ADMIN_PASSWORD and hmac.compare_digest(pwd, ADMIN_PASSWORD):
            return True
        return adm.check_admin_password(pwd)

    def _admin_ok(self):
        """后台数据接口：会话 Cookie / HTTP Basic / admin 角色的 Bearer Key。"""
        if self._session_ok() or self._basic_ok():
            self._who = {"id": 0, "name": "admin", "role": "admin", "enabled": True}
            return True
        info = self._auth_info()
        if info and info["enabled"] and info["role"] == "admin":
            self._who = info
            return True
        self._who = info
        # 只有「完全没配置任何凭据」才开放后台（首次部署引导）。
        # 生产必须配 ADMIN_PASSWORD（或 admin.db 管理员密码）；index Key 一律不能进后台。
        if (not self.auth_required() and not ADMIN_PASSWORD and not adm.has_admin_password()):
            self._who = {"id": 0, "name": "open", "role": "admin", "enabled": True}
            return True
        return False

    def _admin_creds_configured(self):
        """是否已有管理员凭据（env 密码 / admin.db 密码 / env API_KEY / admin 角色 Key）。"""
        if ADMIN_PASSWORD or adm.has_admin_password() or API_KEY:
            return True
        return any((k.get("role") == "admin") for k in adm.list_keys())

    def _login_limited(self, ip):
        now = time.time()
        arr = [x for x in LOGIN_FAILS.get(ip, []) if now - x < 300]
        LOGIN_FAILS[ip] = arr
        return len(arr) >= 5

    def _login_failed(self, ip):
        LOGIN_FAILS.setdefault(ip, []).append(time.time())

    def _set_session_cookie(self, token):
        secure = (self.headers.get("x-forwarded-proto") or "").lower() == "https"
        return f"dsh_admin={token}; HttpOnly; Path=/; SameSite=Strict; Max-Age={int(SESSION_TTL)}" + ("; Secure" if secure else "")

    def _redirect(self, location):
        return self._send(302, {"ok": True}, headers={"Location": location})

    def _client_ip(self):
        xff = (self.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        return xff or self.client_address[0]

    def _login(self):
        ip = self._client_ip()
        if self._login_limited(ip):
            return self._send(429, {"error": "too-many-attempts", "hint": "5 分钟内失败 5 次，请稍后再试"})
        try:
            req = self._body()
        except Exception:
            req = {}
        user = str(req.get("username") or ADMIN_USER)
        pwd = str(req.get("password") or "")
        ok = hmac.compare_digest(user, ADMIN_USER) and (
            (bool(ADMIN_PASSWORD) and hmac.compare_digest(pwd, ADMIN_PASSWORD)) or adm.check_admin_password(pwd)
        )
        if not ok:
            self._login_failed(ip)
            return self._send(401, {"error": "bad-credentials"})
        token = adm.issue_session(SESSION_TTL)
        log(f"admin login ok from {ip}")
        return self._send(200, {"ok": True}, headers={"Set-Cookie": self._set_session_cookie(token)})

    def _logout(self):
        return self._send(200, {"ok": True}, headers={
            "Set-Cookie": "dsh_admin=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0"
        })

    def _setup_admin(self):
        """首次初始化管理员密码（仅当 env 与库都没有密码时允许；用于全新部署）。"""
        if adm.has_admin_password() or ADMIN_PASSWORD:
            return self._send(409, {"error": "already-initialized"})
        try:
            req = self._body()
        except Exception:
            req = {}
        pwd = str(req.get("password") or "")
        if len(pwd) < 8:
            return self._send(400, {"error": "password-too-short", "hint": "至少 8 位"})
        adm.set_admin_password(pwd)
        token = adm.issue_session(SESSION_TTL)
        log("admin password initialized")
        return self._send(200, {"ok": True}, headers={"Set-Cookie": self._set_session_cookie(token)})

    def _unauthorized(self, basic=False):
        if basic:
            return self._send(
                401,
                {"error": "unauthorized", "hint": "HTTP Basic（ADMIN_USER / ADMIN_PASSWORD）"},
                headers={"WWW-Authenticate": 'Basic realm="code-index admin", charset="UTF-8"'},
            )
        return self._send(401, {"error": "unauthorized", "hint": "Authorization: Bearer <API_KEY>"})

    def _begin(self):
        self._t0 = time.time()
        self._status = 200
        self._counts = {"embed_texts": 0, "search_calls": 0, "rerank_calls": 0}
        self._scope_ns = None
        try:
            self._who = self._auth_info()
        except Exception:  # noqa: BLE001 —— 统计失败绝不能影响请求
            self._who = None

    def _end(self):
        try:
            path = urlparse(self.path).path
            key_id = int(self._who["id"]) if self._who else 0
            scope_ns = getattr(self, "_scope_ns", None)
            if not scope_ns:
                parts = path.split("/")
                if len(parts) >= 4 and parts[1] == "v1" and parts[2] == "repos":
                    scope_ns = unquote(parts[3]) or None
            adm.record(key_id, _endpoint_group(path), self._status < 400,
                       (time.time() - self._t0) * 1000.0, namespace=scope_ns, **self._counts)
        except Exception:  # noqa: BLE001
            pass

    def do_GET(self):
        self._begin()
        try:
            self._do_GET()
        finally:
            self._end()

    def do_POST(self):
        self._begin()
        try:
            self._do_POST()
        finally:
            self._end()

    def _do_GET(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if path in ("/admin", "/admin/", "/admin/login"):
            # 未登录 → 登录页（不再弹浏览器 Basic 框）；登录后 → 控制台
            # 控制台是单文件内联 JS：绝不能让浏览器按启发式缓存旧 HTML，否则界面会"半新半旧"
            no_store = {"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"}
            if not self._admin_ok():
                return self._send(200, LOGIN_HTML.encode("utf-8"), ctype="text/html; charset=utf-8", headers=no_store)
            return self._send(200, ADMIN_HTML.encode("utf-8"), ctype="text/html; charset=utf-8", headers=no_store)
        if path in ("/favicon.svg", "/favicon.ico"):
            return self._send(200, FAVICON_SVG, ctype="image/svg+xml",
                              headers={"Cache-Control": "public, max-age=86400"})
        if path == "/health":
            # 免鉴权，但无人认领时只返回最小探活字段（不泄露作用域/存储/治理信息）
            return self._send(200, self._status_payload(public=not self._admin_ok()))
        if path == "/":
            # 浏览器（Accept 含 text/html）→ 控制台；API 客户端（插件 describe 用 GET /）→ 原 JSON 自述
            accept = (self.headers.get("accept") or "").lower()
            q = parse_qs(u.query or "")
            if "text/html" in accept and "json" not in q and "format" not in q:
                return self._redirect("/admin")
        if path.startswith("/v1/admin/"):
            if not self._admin_ok():
                return self._unauthorized(basic=bool(ADMIN_PASSWORD))
        else:
            # 索引客户端（插件 / review-service）用 Bearer Key 读自述、repo status、scopes
            if not (self._api_ok() or self._admin_ok()):
                return self._unauthorized(basic=bool(ADMIN_PASSWORD) and not adm.has_admin_password())
        if path in ("/", "/v1/status"):
            return self._send(200, self._status_payload())
        if path == "/v1/admin/session":
            return self._send(200, {
                "authed": True,
                "keys": adm.count_keys(),
                "authRequired": self.auth_required(),
                "legacyKey": bool(API_KEY),
                "adminPasswordSet": bool(ADMIN_PASSWORD) or adm.has_admin_password(),
                "model": state["info"].get("model"),
                "tag": state["info"].get("tag"),
            })
        if path == "/v1/admin/keys":
            return self._send(200, {"keys": adm.list_keys(), "legacy": bool(API_KEY)})
        if path == "/v1/admin/stats":
            q = parse_qs(u.query or "")
            try:
                days = int((q.get("days") or ["7"])[0])
            except (TypeError, ValueError):
                days = 7
            data = adm.stats(days)
            try:
                data = _enrich_stats(data)
            except Exception as e:  # noqa: BLE001 —— enrichment 失败不能拖垮统计接口
                log(f"stats: enrich 失败（忽略）{type(e).__name__}: {e}")
            return self._send(200, data)
        if path == "/v1/admin/models":
            return self._send(200, models_payload())
        if path == "/log":
            n = 200
            if "n=" in (u.query or ""):
                try:
                    n = int(u.query.split("n=")[1].split("&")[0])
                except Exception:
                    pass
            try:
                with open(LOG_PATH, encoding="utf-8") as f:
                    lines = f.readlines()[-n:]
            except Exception as e:
                lines = [f"log read failed: {e}"]
            return self._send(200, {"lines": [x.rstrip() for x in lines]})
        if path == "/":
            return self._send(200, self._status_payload())
        if path.startswith("/v1/repos/") and path.endswith("/status"):
            ns = unquote(path[len("/v1/repos/") : -len("/status")])
            payload, code = repo_status(ns)
            return self._send(code, payload)
        if path == "/v1/scopes":
            if not store:
                return self._send(503, {"error": "not ready", "detail": state["err"]})
            q = parse_qs(u.query or "")
            repo_id = (q.get("repoId") or [None])[0] or None
            kind = (q.get("kind") or [None])[0] or None
            return self._send(200, {"scopes": scope_list(repo_id, kind)})
        if path == "/v1/spaces":
            return self._send(200, {"spaces": store.scope_overview() if store else []})
        return self._send(404, {"error": "not found"})

    def do_DELETE(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if path.startswith("/v1/admin/"):
            ok = self._admin_ok()
        else:
            ok = self._api_ok() or self._admin_ok()
        if not ok:
            return self._unauthorized(basic=bool(ADMIN_PASSWORD))
        if not state["ready"]:
            return self._send(503, {"error": "not ready", "detail": state["err"]})
        if path.startswith("/v1/admin/keys/"):
            try:
                kid = int(path[len("/v1/admin/keys/") :])
            except ValueError:
                return self._send(400, {"error": "bad key id"})
            if kid == 0:
                return self._send(400, {"error": "legacy key 不可删除", "hint": "环境变量 API_KEY"})
            ok = adm.delete_key(kid)
            return self._send(200 if ok else 404, {"ok": ok, "deleted": kid if ok else None})
        if path.startswith("/v1/scopes/"):
            ns = unquote(path[len("/v1/scopes/") :])
            return self._send(200, delete_scope(ns))
        return self._send(404, {"error": "not found"})

    def _status_payload(self, public=False):
        """public=True 只给探活所需的最小字段（API_KEY 开启时无人认领的 /health 走这条）。"""
        info = dict(state["info"])
        info.update(
            ready=state["ready"],
            err=state["err"],
            pid=os.getpid(),
            model_dir=ACTIVE["embed_dir"],
            model_name=ACTIVE["embed_name"],
            model_switched_at=state.get("model_switched_at"),
            rerank_ready=state["rerank_ready"],
            rerank_err=state["rerank_err"],
            rerank_model_dir=ACTIVE["rerank_dir"],
            admin={"keys": adm.count_keys(), "legacyKey": bool(API_KEY),
                   "authRequired": self.auth_required(),
                   "adminPasswordSet": bool(ADMIN_PASSWORD) or adm.has_admin_password()},
        )
        info.update(state["rerank_info"])
        if public:
            keep = ("ready", "err", "tag", "model", "providers", "ort", "threads",
                    "rerank_ready", "pid", "model_bytes", "available_providers")
            return {k: info[k] for k in keep if k in info}
        if governor:
            info["governor"] = {"paused": governor.paused, "rate": governor.rate, "batch": governor.batch}
        if knn:
            info["knn"] = knn.stats()
        if store:
            info["spaces"] = store.scope_overview()
            info["tags"] = store.tag_stats()
            info["scopes"] = store.scope_stats()
            info["db"] = DB_PATH
        info["limits"] = {
            "maxVectorsPerLineage": MAX_VECTORS_PER_LINEAGE,
            "maxTotalGb": round(MAX_TOTAL_BYTES / 1024**3, 2),
            "retentionDays": RETENTION_DAYS,
            "maxScopes": MAX_SCOPES,
            "maxSearchScopes": MAX_SEARCH_SCOPES,
            "scopeTtlDays": {k: v for k, v in SCOPE_TTL.items() if v is not None},
        }
        return info

    def _do_POST(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if path == "/admin/login":
            return self._login()
        if path == "/admin/logout":
            return self._logout()
        if path == "/admin/setup":
            return self._setup_admin()
        # /v1/admin/* 是后台治理接口：Basic（页面）或 Bearer（脚本）都行；其余索引/检索接口只认 Bearer
        # /v1/search 也允许后台 Basic（admin 页面的「检索测试」用），索引客户端仍可用 Bearer
        is_admin = path.startswith("/v1/admin/")
        if is_admin:
            ok = self._admin_ok()
        elif path in ("/embed", "/rerank"):
            ok = self._api_ok()
        else:
            # /v1/search、/v1/repos/*、/v1/scopes/resolve、/v1/scopes/*/pin…
            # 索引客户端用 Bearer，控制台用会话/Basic
            ok = self._api_ok() or self._admin_ok()
        if not ok:
            return self._unauthorized(basic=bool(ADMIN_PASSWORD) and is_admin)
        if not state["ready"]:
            return self._send(503, {"error": "not ready", "detail": state["err"]})
        try:
            req = self._body()
        except Exception as e:
            return self._send(400, {"error": f"bad json: {e}"})
        try:
            # ---------------- 兼容端点 ----------------
            if path == "/embed":
                texts = req.get("texts") or []
                if not texts:
                    return self._send(400, {"error": "texts must be a non-empty array"})
                texts = [str(t)[:MAX_TEXT_CHARS] for t in texts][:MAX_TEXTS]
                self._counts["embed_texts"] += len(texts)
                t0 = time.time()
                with MODEL_LOCK:  # 热切换时避免用半旧半新的会话
                    vecs = embedder.embed(texts, bool(req.get("is_query")))
                return self._send(
                    200,
                    {
                        "ok": True,
                        "dim": int(vecs.shape[1]),
                        "count": int(vecs.shape[0]),
                        "ms": round((time.time() - t0) * 1000, 2),
                        "providers": state["info"].get("providers"),
                        "tag": state["info"].get("tag"),
                        "vectors_b64": base64.b64encode(vecs.tobytes(order="C")).decode(),
                    },
                )
            if path == "/rerank":
                if not state["rerank_ready"]:
                    return self._send(503, {"error": "rerank not ready", "detail": state["rerank_err"]})
                texts = req.get("texts") or []
                query = str(req.get("query") or "")
                if not texts or not query:
                    return self._send(400, {"error": "query and texts required"})
                self._counts["rerank_calls"] += len(texts)
                t0 = time.time()
                with MODEL_LOCK:
                    scores = reranker.score(query, [str(t)[:MAX_TEXT_CHARS] for t in texts])
                return self._send(
                    200,
                    {
                        "ok": True,
                        "count": int(len(scores)),
                        "ms": round((time.time() - t0) * 1000, 2),
                        "providers": state["info"].get("providers"),
                        "model": state["rerank_info"].get("rerank_model"),
                        "scores": [round(float(x), 6) for x in scores],
                    },
                )
            # ---------------- 索引层 ----------------
            if path.startswith("/v1/repos/"):
                rest = unquote(path[len("/v1/repos/") :])
                ns, _, action = rest.partition("/")
                if not ns or not action:
                    return self._send(404, {"error": "bad path"})
                if action == "sync":
                    body = dict(req)
                    # 显式 null 与"缺键"同义：用服务端当前模型 tag。
                    # 不能只用 setdefault —— review-service 会固定发 "tag": null，setdefault 不覆盖显式 null，
                    # 结果是 repos.tag=NULL → governor 认为未定模型不嵌入 → /v1/search 永远 no-tag（实测踩到）。
                    if not body.get("tag"):
                        body["tag"] = state["info"].get("tag")
                    # 可选 scope 元数据：namespace 以服务端推导为准（老客户端没有 scope，保持原 ns）
                    try:
                        effective_ns, scope_meta = _scope_from_sync(req, ns)
                    except index_store.ScopeFormatError as e:
                        return self._send(400, {"error": "bad-scope", "reason": e.reason, "detail": str(e)})
                    existed = store.repo(effective_ns) is not None
                    # 配额：新建 repos 行前检查 MAX_SCOPES（只限 scope/快照路径，不拦老客户端的 legacy 行）
                    if not existed and (scope_meta is not None or "#" in effective_ns):
                        count = store.count_scopes()
                        if count >= MAX_SCOPES:
                            return self._send(507, {"error": "scope-cap", "count": count, "limit": MAX_SCOPES,
                                                    "hint": "DELETE /v1/scopes/{ns} 清理不用的快照，或调大 MAX_SCOPES"})
                    try:
                        payload = store.sync(effective_ns, body)
                    except Exception as e:
                        name = type(e).__name__
                        if name == "RevisionConflict":
                            return self._send(409, {"error": "revision-conflict", "revision": e.revision, "needFull": e.need_full})
                        if name == "SyncDiverged":
                            return self._send(400, {"error": "diverged", "detail": str(e)})
                        raise
                    repo = store.repo(effective_ns)
                    # 注册/刷新 scope 元数据：新行落默认 TTL；老行只更新 commit/updated_at，
                    # 不覆盖 pinned/expires_at（除非 ttlDays 显式给出）。
                    try:
                        if scope_meta is not None:
                            store.register_scope(
                                effective_ns, scope_meta["kind"], scope_meta["ref"],
                                commit_sha=scope_meta["commit"], ttl_days=scope_meta["ttl_days"],
                                pinned=0 if not existed else None, new_row=not existed,
                            )
                        elif "#" in effective_ns:
                            meta = index_store.parse_scope_namespace(effective_ns)
                            store.register_scope(
                                effective_ns, meta["kind"], meta["token"], scope_ref=meta["scope_ref"],
                                pinned=0 if not existed else None, new_row=not existed,
                            )
                    except index_store.ScopeFormatError as e:
                        return self._send(400, {"error": "bad-scope", "reason": e.reason, "detail": str(e)})
                    payload["namespace"] = effective_ns
                    cap = ensure_capacity(repo["lineage_id"]) if repo else None
                    if cap:
                        return self._send(507, cap)
                    if payload["missing"]:
                        # 外部预热（seed）时客户端自己算向量，别让服务端再算一遍
                        if not req.get("noEmbed"):
                            governor.kick(effective_ns)
                    knn.invalidate(effective_ns)
                    return self._send(200, payload)
                if action == "chunks":
                    r = store.put_chunks(ns, req.get("bodies") or [])
                    if r["accepted"]:
                        governor.kick(ns)
                    return self._send(200, r)
                if action == "vectors":
                    # 外部算好的向量直接灌进来（"用快机器预热"的路径）：
                    # 服务端不再重复嵌入，接完就生效。tag 必须与服务端当前模型一致，
                    # 否则这批向量会被闸门当成别的模型产物（等于白算）。
                    repo = store.repo(ns)
                    if not repo:
                        return self._send(404, {"error": "unknown-namespace"})
                    tag = req.get("tag") or repo["tag"] or state["info"].get("tag")
                    if tag != state["info"].get("tag"):
                        return self._send(409, {"error": "tag-mismatch", "serverTag": state["info"].get("tag"), "got": tag})
                    pairs = []
                    for item in req.get("vectors") or []:
                        raw = base64.b64decode(item["v_b64"])
                        vec = np.frombuffer(raw, dtype=np.float32)
                        if vec.shape[0] == 0:
                            continue
                        pairs.append((item["hash"], vec))
                    if pairs:
                        store.put_vectors(repo["lineage_id"], tag, pairs)
                        knn.invalidate(ns)
                    cap = ensure_capacity(repo["lineage_id"])
                    if cap:
                        return self._send(507, cap)
                    return self._send(200, {"accepted": len(pairs), "dim": int(pairs[0][1].shape[0]) if pairs else 0, **store.counts(ns)})
                if action == "embed":
                    if isinstance(req.get("rate"), (int, float)):
                        governor.set_rate(req["rate"])
                    governor.kick(ns)
                    return self._send(200, governor.status(ns))
                return self._send(404, {"error": "unknown repo action"})
            if path == "/v1/search":
                raw_namespaces = req.get("namespaces")
                if isinstance(raw_namespaces, list) and len(raw_namespaces) > MAX_SEARCH_SCOPES:
                    return self._send(400, {"error": "too-many-namespaces",
                                            "count": len(raw_namespaces), "limit": MAX_SEARCH_SCOPES})
                entries = _namespaces_from_request(raw_namespaces, req.get("namespace"))
                self._scope_ns = entries[0][0] if entries else None
                self._counts["search_calls"] += 1
                # 检索也会 embed 1 次 query（计入 embed 文本数，便于统计算力消耗）
                self._counts["embed_texts"] += 1
                payload, code = search(
                    entries,
                    str(req.get("query") or ""),
                    int(req.get("k", 10)),
                    req.get("tag"),
                    int((req.get("rerank") or {}).get("candidates", 0)),
                    req.get("embedText"),
                )
                return self._send(code, payload)
            # ---------------- 作用域（快照）管理 ----------------
            if path == "/v1/scopes/resolve":
                try:
                    ns = index_store.canonical_namespace(
                        req.get("repoId"), req.get("chunkFp"), req.get("kind"), req.get("ref")
                    )
                except index_store.ScopeFormatError as e:
                    return self._send(400, {"error": "bad-scope", "reason": e.reason, "detail": str(e)})
                repo = store.repo(ns)
                out = {"namespace": ns, "exists": repo is not None}
                if repo:
                    out["revision"] = repo["revision"]
                return self._send(200, out)
            if path.startswith("/v1/scopes/") and path.endswith("/pin"):
                ns = unquote(path[len("/v1/scopes/") : -len("/pin")])
                if not store.repo(ns):
                    return self._send(404, {"error": "unknown-namespace", "namespace": ns})
                update_ttl = "ttlDays" in req
                ttl_days = req.get("ttlDays")
                if update_ttl and ttl_days is not None:
                    try:
                        ttl_days = int(ttl_days)
                    except (TypeError, ValueError):
                        return self._send(400, {"error": "bad-scope", "reason": "bad-ttl-days"})
                row = store.pin_scope(ns, bool(req.get("pinned", True)), ttl_days=ttl_days, update_ttl=update_ttl)
                return self._send(200, {"namespace": ns, "pinned": bool(row["pinned"]),
                                        "expiresAt": row["expires_at"]})
            if path.startswith("/v1/admin/"):
                action = path[len("/v1/admin/") :]
                if action == "keys":
                    if not self._admin_creds_configured():
                        return self._send(400, {"error": "admin-password-required",
                                                "hint": "先设置管理员密码（POST /admin/setup），再创建 Key"})
                    name = str(req.get("name") or "").strip()
                    role = str(req.get("role") or "index").strip().lower()
                    if not name:
                        return self._send(400, {"error": "name required"})
                    try:
                        created = adm.create_key(name, role, str(req.get("note") or ""))
                    except ValueError as e:
                        return self._send(400, {"error": str(e)})
                    log(f"api key created: id={created['id']} name={created['name']} role={created['role']}")
                    return self._send(200, created)
                if action.startswith("keys/"):
                    rest = action[len("keys/"):]
                    kid, _, verb = rest.partition("/")
                    try:
                        kid = int(kid)
                    except ValueError:
                        return self._send(400, {"error": "bad key id"})
                    if kid == 0:
                        return self._send(400, {"error": "legacy key 不可修改", "hint": "环境变量 API_KEY"})
                    if verb in ("enable", "disable"):
                        row = adm.set_enabled(kid, verb == "enable")
                        if not row:
                            return self._send(404, {"error": "unknown key"})
                        return self._send(200, row)
                    return self._send(400, {"error": "bad key action", "hint": "enable | disable"})
                if action == "reset-index":
                    confirm = str(req.get("confirm") or "").upper()
                    if confirm != "RESET":
                        return self._send(400, {"error": "confirm-required",
                                                "hint": '需要在 body 里传 {"confirm":"RESET"}'})
                    return self._send(200, reset_index(confirm))
                if action == "models/activate":
                    kind = str(req.get("kind") or "embed").strip().lower()
                    directory = req.get("dir")
                    if not directory and req.get("name"):
                        inst = models_payload()["installed"]
                        pool = inst.get("rerank" if kind == "rerank" else "embed") or []
                        hit = [x for x in pool if x.get("name") == req.get("name")]
                        if not hit:
                            return self._send(404, {"error": "unknown model", "name": req.get("name")})
                        directory = hit[0]["dir"]
                    if not directory:
                        return self._send(400, {"error": "dir or name required"})
                    try:
                        if kind == "embed":
                            return self._send(200, activate_embed(str(directory)))
                        if kind == "rerank":
                            return self._send(200, activate_rerank(str(directory)))
                        return self._send(400, {"error": "bad kind", "hint": "embed | rerank"})
                    except models_admin.ModelError as e:
                        return self._send(400, {"error": "model-invalid", "detail": str(e)})
                    except Exception as e:  # noqa: BLE001
                        log(f"activate failed: {e}\n{traceback.format_exc()[-600:]}")
                        return self._send(500, {"error": "activate-failed", "detail": str(e)})
                if action == "models/deactivate":
                    kind = str(req.get("kind") or "rerank").strip().lower()
                    if kind == "rerank":
                        return self._send(200, deactivate_rerank())
                    return self._send(400, {"error": "只能关闭 rerank"})
                if action.startswith("models/"):
                    rest = action[len("models/"):]
                    name, _, verb = rest.partition("/")
                    if verb == "download":
                        try:
                            st = downloader.start(name, force=bool(req.get("force")))
                        except KeyError:
                            return self._send(404, {"error": "unknown model", "name": name})
                        return self._send(200, st)
                    if verb == "cancel":
                        try:
                            return self._send(200, downloader.cancel(name))
                        except KeyError:
                            return self._send(404, {"error": "unknown model", "name": name})
                    return self._send(400, {"error": "bad model action", "hint": "download | cancel"})
                if action == "pause":
                    governor.pause()
                elif action == "resume":
                    governor.resume()
                elif action == "rate":
                    governor.set_rate(float(req.get("rate", governor.rate)))
                elif action == "gc":
                    lineage = req.get("lineage")
                    if not lineage:
                        return self._send(400, {"error": "lineage required"})
                    return self._send(200, store.gc(lineage, req.get("retentionDays", RETENTION_DAYS)))
                elif action == "sweep":
                    return self._send(200, run_sweep())
                elif action == "purge-tags":
                    # 换模型后旧 tag 的向量仍占空间：删掉"非当前 tag"的向量（正文/其他 tag 不动）
                    drop = req.get("tag")
                    if drop:
                        result = store.purge_tag_vectors(drop_tag=str(drop))
                    else:
                        result = store.purge_tag_vectors(keep_tag=state["info"].get("tag"))
                    knn.invalidate()
                    result["tags"] = store.tag_stats()
                    return self._send(200, result)
                else:
                    return self._send(404, {"error": "unknown admin action"})
                return self._send(200, governor.status())
            if path.startswith("/v1/lineages/") and path.endswith("/adopt"):
                lid = unquote(path[len("/v1/lineages/") : -len("/adopt")])
                r = store.adopt(req.get("from") or "", lid, req.get("hashes"))
                knn.invalidate()
                return self._send(200, r)
            return self._send(404, {"error": "not found"})
        except Exception as e:
            log(f"{path} failed: {e}\n{traceback.format_exc()[-800:]}")
            return self._send(500, {"error": str(e), "trace": traceback.format_exc()[-600:]})


def make_server(port=None):
    port = PORT if port is None else port
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    log(f"listening on 0.0.0.0:{srv.server_address[1]}")
    return srv


def main():
    try:
        build()
    except Exception as e:
        state["err"] = f"{type(e).__name__}: {e}"
        log("build failed: " + traceback.format_exc())
    make_server().serve_forever()


if __name__ == "__main__":
    main()
