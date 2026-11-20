#!/usr/bin/env python3
"""经验抽取 API 自测（storage-hub v2）：settings / llm-test / extract / import / jobs / stats / stage / replay / 登录冒烟。

为什么要有这一层：schema v2 与 exp_* 核心都有纯逻辑单测（test_schema / test_exp_core），
但 HTTP 层是新接线——路由此处错一个字符，插件就整条链路失败。这里全部走真实 HTTP：
先 `server.build()` 再 `make_server(0)`（否则 store 未初始化 → 503），LLM 一律注入 stub
（`EXP_LLM_STUB` / `EXP_LLM_TEST_TRANSPORT`），绝不依赖真实模型网关。

跑法（服务根目录或仓库根目录都行）：python tests/test_exp_api.py
退出码 0 = 全绿。
"""
import io
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if APP not in sys.path:
    sys.path.insert(0, APP)

TMP = tempfile.mkdtemp(prefix="ci-exp-api-")
# 必须先设 env 再 import server：DB/日志/admin 库都落在临时目录，不碰仓库里的 out/
os.environ.update(
    FAKE_EMBED="1",
    WARMUP="0",
    SERVER_DB=os.path.join(TMP, "index.db"),
    SERVER_LOG=os.path.join(TMP, "server.log"),
    SERVER_ADMIN_DB=os.path.join(TMP, "admin.db"),
    EXP_ARCHIVE_ROOT=os.path.join(TMP, "archive"),
)
for _k in ("API_KEY", "ADMIN_PASSWORD"):
    os.environ.pop(_k, None)  # 鉴权全空 = 开放（API 段自测口径；登录冒烟段临时开密码）

import server  # noqa: E402
import exp_llm  # noqa: E402
import index_store  # noqa: E402

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


# ---------------------------------------------------------------- LLM stub（不碰真实网关）
GOOD_CAND = {
    "what": "落库前核对 pay_sign 字段再重放回调",
    "when_expr": "支付回调返回签名不匹配时",
    "why": "因为不校验签名会放过伪造的成功回调",
    "lens": "logic",
    "category": "debug",
    "audit": {"evidence_quote": "sign=abc mismatch", "reusable_because": "线上真实踩过",
              "exclusions": "仅支付回调"},
}
BAD_CAND = {
    "what": "遇到问题多想想", "when_expr": "随便什么时候都可以", "why": "总之多想",
    "lens": "logic", "category": "debug", "audit": {"evidence_quote": "x"},
}


def extract_transport(url, payload, headers, timeout_s):
    """抽取用 stub：固定返回 1 条合格 + 1 条垃圾候选（垃圾理由 = when 过短）。"""
    return {
        "model": "stub-extract-model",
        "choices": [{"message": {"content": json.dumps([GOOD_CAND, BAD_CAND], ensure_ascii=False)},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 22, "total_tokens": 33},
    }


def ok_transport(url, payload, headers, timeout_s):
    return {"model": "stub-echo-model",
            "choices": [{"message": {"content": "OK"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}}


def reasoning_transport(url, payload, headers, timeout_s):
    return {"model": "stub-reasoner",
            "choices": [{"message": {"content": "", "reasoning_content": "先想想……"},
                         "finish_reason": "length"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 16, "total_tokens": 21,
                      "completion_tokens_details": {"reasoning_tokens": 16}}}


# ---------------------------------------------------------------- 真实 HTTP 服务
server.build()  # 必须先 build()：否则 store/memories_store/jobs_store 全 None → 503
HTTPD = server.make_server(0)
PORT = HTTPD.server_address[1]
THREAD = threading.Thread(target=HTTPD.serve_forever, daemon=True)
THREAD.start()
BASE = f"http://127.0.0.1:{PORT}"
COOKIE = {"value": None}


def call(method, path, body=None, cookie=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            ctype = resp.headers.get("content-type") or ""
            if "json" in ctype:
                return resp.status, json.loads(raw.decode("utf-8")), resp.headers
            return resp.status, raw.decode("utf-8", "replace"), resp.headers
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw), exc.headers
        except ValueError:
            return exc.code, {"raw": raw}, exc.headers


def qs(**kwargs):
    return "?" + urllib.parse.urlencode({k: v for k, v in kwargs.items() if v is not None})


# ================================================================ ① LLM 设置
def test_settings():
    print("\n[1] settings：GET 掩码 / PUT 局部更新 / 明文只写不读")
    code, body, _h = call("GET", "/v1/admin/settings/llm")
    check("GET 200 且字段齐全（enabled/baseUrl/model/maxTokens/timeoutMs/dailyTokenCap/mode/"
          "evidenceMode/apiKeyMasked/apiKeyConfigured/promptVersion）",
          code == 200 and {"enabled", "baseUrl", "model", "maxTokens", "timeoutMs",
                           "dailyTokenCap", "mode", "evidenceMode", "apiKeyMasked",
                           "apiKeyConfigured", "promptVersion"} <= set(body), (code, body))
    check("默认未启用（抽取是写库动作，必须显式开启）", body.get("enabled") is False, body)
    check("响应里没有明文 key 字段", "apiKey" not in body and "api_key" not in body
          and "apiKeyPlain" not in body, list(body))
    check("prompt 版本来自 exp_prompt.PROMPT_VERSION",
          body.get("promptVersion") == "exp-v2.0", body.get("promptVersion"))

    SECRET = "sk-local-abcdef123456"
    code, body, _h = call("PUT", "/v1/admin/settings/llm",
                          {"enabled": True, "apiKey": SECRET, "maxTokens": 4000})
    check("PUT 200 + enabled 生效", code == 200 and body.get("enabled") is True, (code, body))
    code, body, _h = call("PUT", "/v1/admin/settings/llm", {"enabled": False})
    check("enabled 可一键关闭（写库动作必须能停）",
          code == 200 and body.get("enabled") is False, (code, body))
    check("PUT 回掩码（sk-loc…3456 形状）且 apiKeyConfigured",
          body.get("apiKeyMasked") == "sk-loc…3456" and body.get("apiKeyConfigured") is True, body)
    check("PUT 响应不含明文 key", SECRET not in json.dumps(body, ensure_ascii=False), body)
    check("PUT 只改给定字段（maxTokens=4000，其余不动）",
          body.get("maxTokens") == 4000 and body.get("timeoutMs") == 240000, body)

    code, body, _h = call("PUT", "/v1/admin/settings/llm", {"apiKey": ""})
    check("api_key 传空串 = 保持原值（不被掩码写坏）",
          code == 200 and body.get("apiKeyMasked") == "sk-loc…3456", (code, body))
    code, body, _h = call("PUT", "/v1/admin/settings/llm", {"apiKey": SECRET})
    check("api_key 明文只写不读（二次写仍只回掩码）",
          code == 200 and body.get("apiKeyMasked") == "sk-loc…3456"
          and SECRET not in json.dumps(body, ensure_ascii=False), body)

    code, body, _h = call("PUT", "/v1/admin/settings/llm", {"mode": "nope"})
    check("非法枚举 → 400 bad-llm-settings", code == 400 and body.get("error") == "bad-llm-settings",
          (code, body))
    code, body, _h = call("PUT", "/v1/admin/settings/llm", {"what": 1})
    check("未知字段 → 400（静默丢配置会比报错更难查）",
          code == 400 and body.get("error") == "bad-llm-settings", (code, body))
    code, body, _h = call("PUT", "/v1/admin/settings/llm", {})
    check("空 patch → 400 empty-patch", code == 400 and body.get("error") == "empty-patch",
          (code, body))
    code, body, _h = call("POST", "/v1/admin/settings/llm", {"evidenceMode": "digest"})
    check("POST 与 PUT 同语义（局部更新）",
          code == 200 and body.get("evidenceMode") == "digest", (code, body))
    call("PUT", "/v1/admin/settings/llm", {"evidenceMode": "excerpt"})


# ================================================================ ② llm-test（必须服务端发起）
def test_llm_test():
    print("\n[2] llm-test：服务端代理测连通（成功 / 不可达 / 推理型）")
    code, body, _h = call("POST", "/v1/admin/settings/llm-test",
                          {"baseUrl": "http://127.0.0.1:1/v1"})
    check("不可达：仍 200（诊断结论不是业务失败）+ ok=false",
          code == 200 and body.get("ok") is False, (code, body))
    check("不可达：warning=unreachable + 容器侧错误摘要",
          body.get("warning") == "unreachable" and bool(body.get("error"))
          and body.get("httpStatus") == 0, body)
    check("不可达：给出容器侧排查提示", bool(body.get("hint")), body)

    server.EXP_LLM_TEST_TRANSPORT = ok_transport
    try:
        code, body, _h = call("POST", "/v1/admin/settings/llm-test", {})
        check("成功：ok=true + httpStatus=200 + modelEcho + 无 warning",
              code == 200 and body.get("ok") is True and body.get("httpStatus") == 200
              and body.get("modelEcho") == "stub-echo-model" and not body.get("warning"), body)
        check("成功：带 ms / usage / baseUrl（容器侧真实用的地址）",
              isinstance(body.get("ms"), int) and isinstance(body.get("usage"), dict)
              and bool(body.get("baseUrl")), body)
        code, body, _h = call("POST", "/v1/admin/settings/llm-test",
                              {"baseUrl": "http://example.invalid/v1", "model": "m-echo"})
        check("可临时覆盖 baseUrl（只用于本次，不落库）",
              code == 200 and body.get("baseUrl") == "http://example.invalid/v1"
              and body.get("ok") is True, (code, body))
        code, body, _h = call("GET", "/v1/admin/settings/llm")
        check("临时覆盖不写回设置",
              body.get("baseUrl") == "http://127.0.0.1:3425/v1"
              and body.get("model") == "auto/deepseek-v4.1-flash", body)

        server.EXP_LLM_TEST_TRANSPORT = reasoning_transport
        code, body, _h = call("POST", "/v1/admin/settings/llm-test", {})
        check("推理型模型：ok=true 但 warning=reasoning-model",
              code == 200 and body.get("ok") is True
              and body.get("warning") == "reasoning-model", (code, body))
    finally:
        server.EXP_LLM_TEST_TRANSPORT = None


# ================================================================ ③ extract
def test_extract():
    print("\n[3] extract：未配置 skipped / stub 漏斗 / jobs 落库 / 幂等")
    code, body, _h = call("POST", "/v1/exp/extract",
                          {"session_id": "s-0", "segment_no": 1,
                           "summary": "随便一段", "verbatim": "abc"})
    check("未配置 LLM：200 + status=skipped + reason=llm-not-configured（不报 5xx）",
          code == 200 and body.get("status") == "skipped"
          and body.get("reason") == "llm-not-configured", (code, body))
    check("skipped 也写一条 exp_jobs（进度可见，不留白）",
          isinstance(body.get("job_id"), int), body)
    check("skipped 的 funnel 全 0", set((body.get("funnel") or {}).values()) == {0},
          body.get("funnel"))

    call("PUT", "/v1/admin/settings/llm", {"enabled": True})
    server.EXP_LLM_STUB = exp_llm.LLMClient(transport=extract_transport, model="stub-extract-model")

    code, body, _h = call("POST", "/v1/exp/extract",
                          {"session_id": "s-1", "segment_no": 2, "workflow": "pay-bug",
                           "verbatim": "支付回调签名校验失败：落库前核对 pay_sign 再重放"})
    print("      extract ->", json.dumps(body, ensure_ascii=False)[:260])
    check("extract 200 + status=done", code == 200 and body.get("status") == "done", (code, body))
    funnel = body.get("funnel") or {}
    check("funnel 六项齐全（candidates/blocked/created/updated/skipped/contradicted）",
          {"candidates", "blocked", "created", "updated", "skipped", "contradicted"} <= set(funnel),
          funnel)
    check("漏斗计数：候选 2 / 拦截 1 / 入库 1",
          funnel.get("candidates") == 2 and funnel.get("blocked") == 1
          and funnel.get("created") == 1, funnel)
    check("reasons 记录拦截原因", isinstance(body.get("reasons"), dict) and body["reasons"],
          body.get("reasons"))
    check("响应带 tokens / model / promptVersion / ms",
          (body.get("tokens") or {}).get("in") == 11
          and body.get("model") == "stub-extract-model"
          and body.get("promptVersion") == "exp-v2.0"
          and isinstance(body.get("ms"), int), body)
    code, jobs, _h = call("GET", "/v1/exp/jobs?limit=20")
    mine = [x for x in jobs.get("items") or []
            if x.get("session_id") == "s-1" and x.get("segment_no") == 2]
    check("exp_jobs 落库：一条 job，mode=server，created_n=1，tokens 有值",
          len(mine) == 1 and mine[0]["mode"] == "server" and mine[0]["created_n"] == 1
          and mine[0]["tokens_in"] == 11, mine)
    code, mems, _h = call("GET", "/v1/memories?limit=5")
    item = (mems.get("items") or [{}])[0]
    check("经验入库：带中文 lensLabel/categoryLabel（index_store 标签表）",
          mems.get("total") == 1 and item.get("lensLabel") == index_store.LENS_LABELS["logic"]
          and item.get("categoryLabel") == index_store.CATEGORY_LABELS["debug"], item)
    check("经验入库：带服务端派生的 stage/stageLabel（默认 未召回）",
          item.get("stage") == "未召回" and item.get("stageLabel") == "未召回", item)
    check("经验入库：证据片段由管道生成并落库", bool(item.get("evidence")), item.get("evidence"))

    code, again, _h = call("POST", "/v1/exp/extract",
                           {"session_id": "s-1", "segment_no": 2, "workflow": "pay-bug",
                            "verbatim": "支付回调签名校验失败：落库前核对 pay_sign 再重放"})
    funnel2 = again.get("funnel") or {}
    check("同 (session_id, segment_no) 重放：走合并（skip/updated=1，不新建）",
          code == 200 and funnel2.get("created") == 0
          and funnel2.get("updated", 0) + funnel2.get("skipped", 0) == 1, (code, funnel2))
    code, jobs, _h = call("GET", "/v1/exp/jobs?limit=50")
    same = [x for x in jobs.get("items") or []
            if x.get("session_id") == "s-1" and x.get("segment_no") == 2]
    check("exp_jobs 幂等：同段只有一条（覆盖更新）", len(same) == 1, same)

    code, dry, _h = call("POST", "/v1/exp/extract",
                         {"session_id": "s-9", "segment_no": 1, "apply": False,
                          "verbatim": "支付回调签名校验失败：落库前核对 pay_sign 再重放"})
    check("apply=false：只预览不写库（applied=false）",
          code == 200 and dry.get("applied") is False, (code, dry))
    code, mems2, _h = call("GET", "/v1/memories?limit=5")
    check("apply=false 后条目数不变", mems2.get("total") == 1, mems2.get("total"))
    code, bad, _h = call("POST", "/v1/exp/extract", {"session_id": "s-1"})
    check("空素材 → 400 bad-extract", code == 400 and bad.get("error") == "bad-extract",
          (code, bad))


# ================================================================ ④ import（降级通道）
def test_import():
    print("\n[4] import：跳过 LLM 直接走 Review/Dedup/Merge（插件侧自抽降级）")
    good = dict(GOOD_CAND)
    good["workflow"] = "erp-bug"
    good["excerpt"] = "select * from pay_order where id=1"
    fresh = {
        "what": "先在 devops 查订单流水再判断结余",
        "when_expr": "对账结余与实际不一致时",
        "why": "因为跳过流水核对会把差额当成配置错误",
        "lens": "index", "category": "business",
        "audit": {"evidence_quote": "查流水：select * from pay_order"},
        "workflow": "erp-bug",
    }
    code, body, _h = call("POST", "/v1/exp/import",
                          {"session_id": "s-2", "segment_no": 1, "workflow": "erp-bug",
                           "candidates": [good, BAD_CAND, fresh]})
    print("      import ->", json.dumps(body, ensure_ascii=False)[:240])
    check("import 200 + status=done + mode=client（插件侧抽取）",
          code == 200 and body.get("status") == "done" and body.get("mode") == "client",
          (code, body))
    funnel = body.get("funnel") or {}
    check("import 漏斗：候选 3 / 拦截 1 / 入库 2",
          funnel.get("candidates") == 3 and funnel.get("blocked") == 1
          and funnel.get("created") == 2, funnel)
    check("import 也写 exp_jobs（mode=client 可见于流水）",
          any(x.get("mode") == "client" for x in call("GET", "/v1/exp/jobs?limit=50")[1]["items"]))
    code, body, _h = call("POST", "/v1/exp/import", {"candidates": []})
    check("空 candidates → 400 bad-import", code == 400 and body.get("error") == "bad-import",
          (code, body))

    # 降级通道不需要 LLM：关掉 enabled 之后仍然能落库
    call("PUT", "/v1/admin/settings/llm", {"enabled": False})
    extra = dict(fresh)
    extra["what"] = "回放前先在 jenkins 核对构建号"
    extra["when_expr"] = "准备重放生产消息之前"
    extra["why"] = "因为构建号和镜像不一致会导致回放打到旧代码"
    code, body, _h = call("POST", "/v1/exp/import",
                          {"session_id": "s-3", "segment_no": 1, "candidates": [extra]})
    check("未启用 LLM 时 import 仍可用（降级通道不依赖模型）",
          code == 200 and (body.get("funnel") or {}).get("created") == 1, (code, body))
    call("PUT", "/v1/admin/settings/llm", {"enabled": True})


# ================================================================ ⑤ 列表 / 阶段 / 统计
def test_memories_and_stats():
    print("\n[5] memories：stage 过滤 / 中文字段 / 统计六项")
    code, body, _h = call("GET", "/v1/memories?limit=50")
    check("列表条目全部带 stage（服务端算，前端只渲染）",
          code == 200 and body.get("total", 0) >= 1
          and all(i.get("stage") in index_store_test_stages for i in body["items"]),
          [i.get("stage") for i in (body.get("items") or [])])

    code, body, _h = call("GET", "/v1/memories" + qs(stage="未召回"))
    check("stage=未召回 过滤生效",
          code == 200 and body.get("total", 0) >= 1
          and all(i["stage"] == "未召回" for i in body["items"]), (code, body))
    code, body, _h = call("GET", "/v1/memories" + qs(stage="unrecalled"))
    check("stage 英文别名也认（unrecalled）", code == 200 and body.get("total", 0) >= 1,
          (code, body))
    code, body, _h = call("GET", "/v1/memories" + qs(stage="已归档"))
    check("stage=已归档（没有 retired 条目）→ 空", code == 200 and body.get("total") == 0,
          (code, body))
    code, body, _h = call("GET", "/v1/memories" + qs(stage="nope"))
    check("未知 stage → 400 bad-stage", code == 400 and body.get("error") == "bad-stage",
          (code, body))
    code, body, _h = call("GET", "/v1/memories" + qs(stage="未召回", limit=1))
    check("stage 过滤与分页共存（limit=1 时 total 仍为全量）",
          code == 200 and len(body.get("items") or []) == 1 and body.get("total", 0) >= 2,
          (code, body.get("total")))
    code, body, _h = call("GET", "/v1/memories" + qs(category="business", workflow="erp-bug"))
    check("category + workflow 组合过滤（两条 business/erp-bug）",
          code == 200 and body.get("total") == 2
          and all(i["category"] == "business" and i["workflow"] == "erp-bug"
                  for i in body["items"]), (code, body.get("total")))

    # 冲突 → 待裁决；采纳 → 已采纳
    a = call("POST", "/v1/memories", {"repo": "demo", "lens": "jargon", "category": "business",
                                      "what": "必须重启服务再查缓存", "when_expr": "缓存不一致时",
                                      "why": "因为进程内缓存不会热更新"})[1]
    b = call("POST", "/v1/memories", {"repo": "demo", "lens": "jargon", "category": "business",
                                      "what": "无需重启服务查缓存", "when_expr": "缓存不一致时",
                                      "why": "因为缓存每次请求都从库里读"})[1]
    code, body, _h = call("POST", "/v1/memories/link-conflict",
                          {"conflicting_id": a["id"], "origin_id": b["id"],
                           "trigger_words": ["必须", "无需"]})
    check("冲突登记成功", code == 200 and body.get("linked") is True, (code, body))
    code, body, _h = call("GET", "/v1/memories" + qs(stage="待裁决"))
    check("开放冲突 → 待裁决（双方两条）", code == 200 and body.get("total") == 2, (code, body))
    code, body, _h = call("POST", "/v1/memories/%s/hit" % a["id"], {"adopted": True})
    check("采纳计数写入", code == 200 and body.get("stats_adopted") == 1, (code, body))
    call("POST", "/v1/memories/%s/resolve" % a["id"], {"status": "active"})
    code, body, _h = call("GET", "/v1/memories" + qs(stage="待裁决"))
    check("裁决后 待裁决 清空", code == 200 and body.get("total") == 0, (code, body))
    code, body, _h = call("GET", "/v1/memories/%s" % a["id"])
    check("裁决后条目可读（含 audit / timeline）",
          code == 200 and body.get("id") == a["id"] and isinstance(body.get("timeline"), list),
          (code, body if code != 200 else None))

    code, stats, _h = call("GET", "/v1/memories/stats")
    check("stats 200 且六项齐全（funnel/byCategory/byStage/adoptRate7d/trend + totals）",
          code == 200 and {"funnel", "byCategory", "byStage", "adoptRate7d", "trend",
                           "totals"} <= set(stats), list(stats))
    check("stats.funnel 四项（candidates/blocked/merged/created）",
          {"candidates", "blocked", "merged", "created"} <= set(stats.get("funnel") or {}),
          stats.get("funnel"))
    check("stats.byStage 六类齐全且总数与条目数一致",
          set(stats.get("byStage") or {}) == set(index_store_test_stages)
          and sum((stats.get("byStage") or {}).values()) == (stats.get("totals") or {}).get("total"),
          (stats.get("byStage"), stats.get("totals")))
    check("stats.trend 最近 7 天，每天 created/hits/adopted",
          len(stats.get("trend") or []) == 7
          and all({"day", "created", "hits", "adopted"} <= set(d) for d in stats["trend"]),
          stats.get("trend"))
    check("stats.adoptRate7d 是 0..1 的数（采纳/召回）",
          isinstance(stats.get("adoptRate7d"), (int, float))
          and 0 <= float(stats["adoptRate7d"]) <= 1, stats.get("adoptRate7d"))
    check("stats 中文标签表来自 index_store（lensLabels/categoryLabels）",
          (stats.get("lensLabels") or {}).get("index") == index_store.LENS_LABELS["index"]
          and (stats.get("categoryLabels") or {}).get("business")
          == index_store.CATEGORY_LABELS["business"], stats.get("lensLabels"))
    check("stats.byCategory 是 {code: count} 字典",
          isinstance(stats.get("byCategory"), dict)
          and all(isinstance(v, int) for v in stats["byCategory"].values()),
          stats.get("byCategory"))


index_store_test_stages = ("待裁决", "未召回", "已召回", "已采纳", "可退役", "已归档")


# ================================================================ ⑥ 历史重放
def test_replay():
    print("\n[6] replay：后台逐段读归档，进度看 exp_jobs")
    root = os.environ["EXP_ARCHIVE_ROOT"]
    sid = os.path.join(root, "sess-a")
    os.makedirs(sid, exist_ok=True)
    with io.open(os.path.join(sid, "segment_1.md"), "w", encoding="utf-8") as handle:
        handle.write("### [segment_1.md] 支付回调\n支付回调签名校验失败：落库前核对 pay_sign\n")
    with io.open(os.path.join(sid, "segment_2.md"), "w", encoding="utf-8") as handle:
        handle.write("### [segment_2.md] 结余\n先在 devops 查订单流水再判断结余\n")
    other = os.path.join(root, "sess-b")
    os.makedirs(other, exist_ok=True)
    with io.open(os.path.join(other, "segment_1.md"), "w", encoding="utf-8") as handle:
        handle.write("### [segment_1.md] 占位\n随便什么内容都行，这里只是占位\n")

    code, body, _h = call("POST", "/v1/admin/exp/replay", {"all": True, "apply": True})
    check("replay all → 200 + queued=3（2 会话 3 段）",
          code == 200 and body.get("queued") == 3 and body.get("status") == "queued",
          (code, body))
    for _ in range(150):
        if not server.EXP_REPLAY_STATE.get("running"):
            break
        time.sleep(0.2)
    check("重放跑完（done>=3，无失败）",
          (server.EXP_REPLAY_STATE.get("done") or 0) >= 3
          and not server.EXP_REPLAY_STATE.get("failed"), server.EXP_REPLAY_STATE)
    code, jobs, _h = call("GET", "/v1/exp/jobs?limit=50")
    replayed = [x for x in jobs.get("items") or [] if x.get("session_id") == "sess-a"]
    check("重放：每段一条 job，且带 segmentsTotal（进度条 段 N/M 的数据源）",
          len(replayed) == 2
          and all((x.get("reasons") or {}).get("segmentsTotal") == 2 for x in replayed), replayed)
    check("重放：job 状态 done 且入库数有值",
          all(x["status"] == "done" for x in replayed)
          and sum(x["created_n"] for x in replayed) >= 1, replayed)
    code, body, _h = call("POST", "/v1/admin/exp/replay", {"session_ids": []})
    check("replay 无目标 → 400 bad-replay",
          code == 400 and body.get("error") == "bad-replay", (code, body))
    code, body, _h = call("POST", "/v1/admin/exp/replay", {"all": True, "since": "2030-01-01"})
    check("replay since 过滤掉全部（queued=0）",
          code == 200 and body.get("queued") == 0, (code, body))
    code, body, _h = call("POST", "/v1/admin/exp/replay", {"session_ids": ["../../etc"]})
    check("replay 拒绝目录穿越（不读根目录外内容）",
          code in (200, 400) and body.get("queued", 0) == 0, (code, body))


# ================================================================ ⑦ 登录冒烟（真实 admin 会话）
EXPECTED_ANCHORS = (
    "llm-settings", "llm-test", "llm-api-key", "llm-prompt-version", "llm-base-url",
    "exp-progress", "exp-replay", "mem-card", "mem-stage", "adopt-bar", "cat-dist",
    "gov-timeline", "mem-view-cards", "mem-view-table", "mem-cat-filter", "mem-stage-filter",
    "黑话镜头", "索引镜头", "逻辑镜头", "业务知识", "调试经验",
)


def test_login_smoke():
    print("\n[7] 登录冒烟：真起服务 + admin 会话 + 页面锚点/体积/390px")
    old_pw = server.ADMIN_PASSWORD
    server.ADMIN_PASSWORD = "sr2-smoke-pw-123"
    try:
        code, body, _h = call("GET", "/admin")
        check("未登录 /admin → 登录页（不弹 Basic）",
              code == 200 and isinstance(body, str) and "登录" in body
              and "<form" in body and "密码" in body, (code, str(body)[:80]))
        code, body, _h = call("GET", "/v1/admin/settings/llm")
        check("未登录调 /v1/admin/settings/llm → 401", code == 401, (code, body))
        code, body, _h = call("POST", "/admin/login",
                              {"username": "admin", "password": "wrong-pw"})
        check("错密码登录 → 401 bad-credentials",
              code == 401 and body.get("error") == "bad-credentials", (code, body))
        code, body, headers = call("POST", "/admin/login",
                                   {"username": "admin", "password": "sr2-smoke-pw-123"})
        raw_cookie = headers.get("Set-Cookie") or ""
        check("正确密码登录 → 200 + dsh_admin cookie",
              code == 200 and "dsh_admin=" in raw_cookie, (code, raw_cookie[:40]))
        cookie = raw_cookie.split(";")[0]
        COOKIE["value"] = cookie
        code, html, _h = call("GET", "/admin", cookie=cookie)
        check("登录后 /admin → 200 text/html",
              code == 200 and isinstance(html, str) and "<!doctype html" in html.lower(),
              (code, type(html)))
        missing = [a for a in EXPECTED_ANCHORS if a not in html]
        check(f"页面含 {len(EXPECTED_ANCHORS)} 个新锚点（缺：{missing}）", not missing, missing)
        size = len(html.encode("utf-8"))
        check(f"页面体积 {size} 字节 < 220KB", size < 220 * 1024, size)
        check("页面带 viewport meta（移动端按设备宽度排版）",
              'name="viewport"' in html and "width=device-width" in html, "viewport")
        check("390px 不破版：媒体查询把卡片流/配置栅格降为单列",
              "@media (max-width:640px){.mem-cards{grid-template-columns:1fr}"
              in html.replace("\r\n", ""), "media query")
        check("页面永不单写「索引」二字（镜头一律 索引镜头）",
              "索引镜头" in html and "索引</span>" not in html and ">索引<" not in html
              and ">索引（" not in html, "bare 索引")
        code, body, _h = call("GET", "/v1/admin/settings/llm", cookie=cookie)
        check("登录态读设置 → 200（admin 会话鉴权链路通）", code == 200, (code, body))
        code, body, _h = call("PUT", "/v1/admin/settings/llm", {"maxTokens": 8000}, cookie=cookie)
        check("登录态写设置 → 200", code == 200 and body.get("maxTokens") == 8000, (code, body))
        code, body, _h = call("GET", "/v1/exp/jobs?limit=1", cookie=cookie)
        check("登录态读抽取流水 → 200 + items", code == 200 and "items" in body, (code, body))
    finally:
        server.ADMIN_PASSWORD = old_pw


# ================================================================ ⑧ 静态验收
def test_static():
    print("\n[8] 静态验收：ast / _do_GET 唯一 / 路由分组")
    import ast
    src_path = os.path.join(APP, "server.py")
    src = io.open(src_path, encoding="utf-8").read()
    try:
        ast.parse(src)
        ok = True
    except SyntaxError as exc:
        ok = False
        detail = str(exc)
    else:
        detail = ""
    check("server.py ast 解析通过", ok, detail)
    check('grep -c "def _do_GET" == 1', src.count("def _do_GET") == 1, src.count("def _do_GET"))
    check("_endpoint_group 有 exp 与 settings 分组",
          'return "exp"' in src and 'return "settings"' in src)
    check("settings 走 PUT（do_PUT 存在，PUT 才有局部更新语义）",
          "def do_PUT(self):" in src and "def _do_PUT(self):" in src)


def main():
    print(f"临时库：{os.path.join(TMP, 'index.db')}")
    print(f"服务端口：{PORT}")
    test_settings()
    test_llm_test()
    test_extract()
    test_import()
    test_memories_and_stats()
    test_replay()
    test_login_smoke()
    test_static()
    print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
    if PASS < 25:
        print("❌ 项数不足 25（验收要求 ≥25）")
        return 1
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    try:
        code = main()
    finally:
        try:
            HTTPD.shutdown()
            HTTPD.server_close()
        except Exception:
            pass
        for store in (getattr(server, "memories_store", None), getattr(server, "jobs_store", None),
                      getattr(server, "store", None)):
            try:
                store.close()
            except Exception:
                pass
        shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(code)
