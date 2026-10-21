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
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, unquote

import numpy as np

import index_store

APP = os.path.dirname(os.path.abspath(__file__))
F = os.environ

MODEL_DIR = F.get("MODEL_DIR", os.path.join(APP, "model"))
MODEL_NAME = F.get("MODEL_NAME", "")
RERANK_DIR = F.get("RERANK_MODEL_DIR", os.path.join(APP, "model-rerank"))
LOG_PATH = F.get("SERVER_LOG", os.path.join(APP, "out", "server.log"))
DB_PATH = F.get("SERVER_DB", os.path.join(APP, "out", "index.db"))
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
API_KEY = F.get("API_KEY", "")
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

os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


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
ADMIN_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>code-index-service · 后台</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --line:#e3e6ea; --text:#1f2328; --muted:#6b7280; --ok:#1a7f37; --warn:#b45309; --bad:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --text:#e6e6e6; --muted:#9aa4b2; } }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--text); font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; } .spacer { flex:1; }
  .badge { padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--muted); }
  .badge.ok { color:var(--ok); border-color:var(--ok); } .badge.bad { color:var(--bad); border-color:var(--bad); }
  button { padding:5px 10px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; }
  button:hover { border-color:var(--muted); } button:disabled { opacity:.5; cursor:default; }
  main { padding:16px 18px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .card h2 { font-size:13px; margin:0 0 8px; font-weight:600; color:var(--muted); }
  .kv { display:grid; grid-template-columns:110px 1fr; gap:3px 10px; } .kv div:nth-child(odd) { color:var(--muted); }
  .wide { grid-column:1/-1; } table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); } th { color:var(--muted); font-weight:600; }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; } .ns { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; }
  .bar { height:7px; width:80px; background:var(--line); border-radius:4px; overflow:hidden; display:inline-block; vertical-align:middle; }
  .bar > i { display:block; height:100%; background:var(--ok); }
  .muted { color:var(--muted); } #msg { color:var(--muted); font-size:12px; } pre { margin:0; white-space:pre-wrap; word-break:break-all; }
</style>
</head>
<body>
<header>
  <h1>code-index-service · 后台</h1>
  <span id="ready" class="badge">…</span>
  <span id="model" class="badge" title="向量模型 tag">—</span>
  <span class="spacer"></span>
  <span id="msg"></span>
  <button id="btn-refresh">刷新</button>
  <button id="btn-pause">暂停嵌入</button>
  <button id="btn-resume">恢复嵌入</button>
  <button id="btn-sweep">立即清扫</button>
</header>
<main>
  <section class="card">
    <h2>运行时</h2>
    <div class="kv" id="runtime"></div>
  </section>
  <section class="card">
    <h2>嵌入治理</h2>
    <div class="kv" id="governor"></div>
  </section>
  <section class="card">
    <h2>存储与限额</h2>
    <div class="kv" id="limits"></div>
  </section>
  <section class="card wide">
    <h2>作用域（快照） <span class="muted" id="scope-count"></span></h2>
    <table>
      <thead><tr><th>kind</th><th>ref</th><th>repoId</th><th class="num">chunks</th><th class="num">vectors</th><th>coverage</th><th class="num">占用</th><th>创建</th><th>过期</th><th>pinned</th><th>namespace</th></tr></thead>
      <tbody id="scopes"><tr><td colspan="11" class="muted">加载中…</td></tr></tbody>
    </table>
  </section>
</main>
<script>
const $ = (s) => document.querySelector(s);
let KEY = localStorage.getItem('dshAdminKey') || '';
const fmt = (n) => n === null || n === undefined ? '—' : (typeof n === 'number' ? n.toLocaleString() : String(n));
const ts = (s) => !s ? '—' : new Date((typeof s === 'number' ? s * 1000 : s)).toLocaleString('zh-CN', { hour12: false });
const iso = (n) => !n ? '永不' : ts(n);
const bytes = (n) => !n ? '0 B' : (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');
function setMsg(t) { $('#msg').textContent = t || ''; }
async function api(path, opts = {}, retried = false) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (KEY) headers.authorization = 'Bearer ' + KEY;
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  if (r.status === 401 && !retried) {
    const k = prompt('需要 API Key（服务端已启用 API_KEY）：');
    if (k) { KEY = k.trim(); localStorage.setItem('dshAdminKey', KEY); return api(path, opts, true); }
  }
  let body = null; try { body = await r.json(); } catch (e) {}
  return { status: r.status, body };
}
const kv = (el, rows) => { el.innerHTML = rows.map(([k, v, title]) => '<div>' + k + '</div><div' + (title ? ' title="' + title + '"' : '') + '>' + v + '</div>').join(''); };
async function refresh() {
  setMsg('');
  // 先拉作用域（无 key 时在这里触发 401 弹窗），再拉 health：带 key 的 health 才是完整版
  const s = await api('/v1/scopes');
  const h = await api('/health');
  if (h.status !== 200 || !h.body) { $('#ready').className = 'badge bad'; $('#ready').textContent = '不可达'; return; }
  const d = h.body;
  $('#ready').className = 'badge ' + (d.ready ? 'ok' : 'bad');
  $('#ready').textContent = d.ready ? 'ready' : 'not ready';
  $('#model').textContent = d.tag || '—';
  $('#model').title = (d.providers || []).join(', ') + ' · ORT ' + (d.ort || '?') + ' · threads ' + (d.threads || '?');
  kv($('#runtime'), [
    ['模型', (d.model || '—') + ' <span class="muted">(' + bytes(d.model_bytes) + ')</span>'],
    ['tag', d.tag || '—'], ['providers', (d.providers || []).join(', ') || '—'],
    ['ORT / threads', (d.ort || '?') + ' / ' + (d.threads || '?')],
    ['重排', d.rerank_ready ? (d.rerank_tag || 'ready') : '<span class="muted">off（' + (d.rerank_err || '无模型') + '）</span>'],
    ['pid / db', fmt(d.pid) + ' / <span class="ns">' + (d.db || '—') + '</span>'],
  ]);
  const g = d.governor || {}, k = d.knn || {};
  kv($('#governor'), [
    ['状态', g.paused ? '<span class="badge bad">已暂停</span>' : '<span class="badge ok">运行中</span>'],
    ['限速', fmt(g.rate) + ' 块 / 秒'], ['batch', fmt(g.batch)],
    ['kNN 缓存', fmt(k.entries) + ' 个作用域 / ' + bytes(k.bytes) + ' <span class="muted">上限 ' + bytes(k.maxBytes) + '</span>'],
    ['kNN 命中/未命中', fmt(k.hits) + ' / ' + fmt(k.misses) + ' <span class="muted">淘汰 ' + fmt(k.evictions) + '</span>'],
  ]);
  const L = d.limits || {}, sc = d.scopes || {};
  kv($('#limits'), [
    ['总存储上限', fmt(L.maxTotalGb) + ' GB'], ['保留期', fmt(L.retentionDays) + ' 天'],
    ['每血统向量上限', fmt(L.maxVectorsPerLineage)], ['作用域上限', fmt(L.maxScopes) + '（单次检索 ≤ ' + fmt(L.maxSearchScopes) + '）'],
    ['当前作用域', fmt(sc.total) + ' <span class="muted">' + JSON.stringify(sc.byKind || {}) + '</span>'],
  ]);
  const rows = (s.body && s.body.scopes) || [];
  $('#scope-count').textContent = '(' + rows.length + ')';
  const bytesOf = {}; (d.spaces || []).forEach((x) => { bytesOf[x.namespace] = x.totalBytes; });
  $('#scopes').innerHTML = rows.length ? rows.map((x) => {
    const cov = Math.round((x.coverage || 0) * 100);
    return '<tr><td>' + x.kind + '</td><td>' + (x.ref || '—') + '</td><td>' + x.repoId + '</td>'
      + '<td class="num">' + fmt(x.chunks) + '</td><td class="num">' + fmt(x.vectors) + '</td>'
      + '<td><span class="bar" title="' + cov + '%"><i style="width:' + cov + '%"></i></span> ' + cov + '%</td>'
      + '<td class="num">' + bytes(bytesOf[x.namespace]) + '</td>'
      + '<td>' + ts(x.createdAt) + '</td><td>' + iso(x.expiresAt) + '</td>'
      + '<td>' + (x.pinned ? '是' : '否') + '</td>'
      + '<td class="ns" title="' + x.namespace + '">' + x.namespace.slice(0, 46) + (x.namespace.length > 46 ? '…' : '') + '</td></tr>';
  }).join('') : '<tr><td colspan="11" class="muted">还没有作用域</td></tr>';
  if (s.status === 401) setMsg('API Key 无效或未填写');
}
async function action(name) {
  const r = await api('/v1/admin/' + name, { method: 'POST', body: '{}' });
  setMsg(r.status === 200 ? name + ' ok' : name + ' 失败（' + r.status + '）');
  setTimeout(refresh, 300);
}
$('#btn-refresh').onclick = refresh;
$('#btn-pause').onclick = () => action('pause');
$('#btn-resume').onclick = () => action('resume');
$('#btn-sweep').onclick = () => action('sweep');
refresh(); setInterval(refresh, 15000);
</script>
</body>
</html>
"""



class FakeEmbedder:
    """自测用：不需要 onnx 模型，向量由文本哈希确定，但仍保持 L2 归一化与确定性。"""

    def __init__(self, dim=16):
        self.dim = dim
        self.tag = "fake-model-0000fake-fp32"
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
        state.update(ready=True, info=info)
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
        state.update(ready=True, info=info)
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

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        head = (
            f"HTTP/1.1 {code} {self.responses.get(code, ('OK',))[0]}\r\n"
            f"Content-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: keep-alive\r\n\r\n"
        ).encode()
        self.wfile.write(head + body)

    def log_message(self, fmt, *args):
        pass

    def _body(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        if self.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw or b"{}")

    def _auth_ok(self):
        if not API_KEY:
            return True
        return self.headers.get("authorization", "") == f"Bearer {API_KEY}"

    def _unauthorized(self):
        # 401 统一提示；管理页会据此弹窗要求输入 API Key（存 localStorage，仅本地浏览器）
        return self._send(401, {"error": "unauthorized", "hint": "Authorization: Bearer <API_KEY>"})

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        # 页面壳与健康检查免鉴权（探活用）；其余 GET 在设置 API_KEY 后都要 Bearer
        if path in ("/admin", "/admin/"):
            return self._send(200, ADMIN_HTML.encode("utf-8"), ctype="text/html; charset=utf-8")
        if path == "/health":
            # 免鉴权，但未带 key 时只返回最小探活字段（不泄露作用域/存储/治理信息）
            return self._send(200, self._status_payload(public=not self._auth_ok()))
        if not self._auth_ok():
            return self._unauthorized()
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
        if not self._auth_ok():
            return self._send(401, {"error": "unauthorized"})
        if not state["ready"]:
            return self._send(503, {"error": "not ready", "detail": state["err"]})
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
            model_dir=MODEL_DIR,
            rerank_ready=state["rerank_ready"],
            rerank_err=state["rerank_err"],
            rerank_model_dir=RERANK_DIR,
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

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if not self._auth_ok():
            return self._send(401, {"error": "unauthorized"})
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
                t0 = time.time()
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
                t0 = time.time()
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
