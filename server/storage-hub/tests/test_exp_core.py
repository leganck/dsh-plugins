#!/usr/bin/env python3
"""经验抽取核心自测（prompt v2 / LLM 客户端 / 管道 / 证据脱敏 / 设置存储）。

覆盖四块，全部**离线**（stub 传输、注入回调，不连 LLM、不碰 index.db、不碰 server.py）：

  ① exp_prompt：版本号、三镜头、四类 category + process 拒收、九类垃圾、可审计三维、
     prompt 正文里的数字与 Review 常量一致；
  ② exp_pipeline：切分、Review（九类垃圾逐条 + what≈why + when 过短 + 超长）、
     源码符号校验（unverified 只标不拦 / index 断言存在才拦）、
     Dedup（双高合并 + **禁止桥接**）、Merge 四判（create/update/skip/contradict）、
     证据片段（命中行 ±2 / 命令 / 日志首尾 / ≤2KB / 脱敏 / sha256 稳定）、
     以及人工 17 条黄金样本（`experiences-v2-session-4ff93b80.jsonl`，标准 JSONL 一行一条）回归；
  ③ exp_llm：默认参数、429/超时重试与最终失败原因、4xx 不重试、推理型模型识别、
     token 统计、JSON 解析、串行保证；
  ④ admin_store：仅 LLM settings 部分（掩码 / 明文分离 / 校验 / 清空），并回归既有 key 能力。

跑法（服务根目录或仓库根目录都行）：
    python tests/test_exp_core.py

退出码 0 = 全绿。不需要模型、不需要网络、不需要服务端起来。
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time

# Windows 控制台默认 GBK，打不出 ✅/❌ → 强制 UTF-8（与 selftest.py / test_bodies.py 同做法）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if APP not in sys.path:
    sys.path.insert(0, APP)

import admin_store  # noqa: E402
import exp_llm  # noqa: E402
import exp_pipeline as P  # noqa: E402
import exp_prompt  # noqa: E402

PASS = 0
FAIL = 0
TMP = tempfile.mkdtemp(prefix="ci-exp-core-test-")
GOLDEN = os.path.join(os.path.dirname(APP), "exp-pipeline", "experiences-v2-session-4ff93b80.jsonl")

# 脱敏用例的假凭据：拆开拼接 + 全部是合成值，既避免被凭据扫描误报，
# 也保证断言只依赖下面这一处定义（改一处不会漏改断言）。
FAKE_SK = "sk-" + "blpc7v0s1n3x9a1g65699971z2x0l0v1p1y5"
FAKE_BEARER = "eyJhbGciOiJIUzI1NiJ9" + "xyDwyGqaJjFYXpV6RkTg"
FAKE_PASSWORD = "Q1amm2qgPn2-Wq"
FAKE_PHONE = "13800138000"
FAKE_ID_CARD = "110101199003071234"


def check(label, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {label}")
    else:
        FAIL += 1
        print(f"  ❌ {label}" + (f"  →  {extra}" if extra else ""))


# ================================================================ 夹具
def cand(**overrides):
    """一条合法候选（改哪个字段就传哪个）。默认可通过 Review，便于只测目标规则。"""
    base = {
        "what": "上传流水查不到时先比对同机相邻流水的落库分区",
        "when_expr": "客户报上传成功但后台查不到流水",
        "why": "分区路由错时数据写进别的租户库，客户端仍收到成功，只查本租户永远查不到",
        "lens": "logic",
        "category": "debug",
        "audit": {
            "reusable_because": "把排查起点从本租户库改成跨分区比对",
            "exclusions": "1,2,3,4,6,8",
            "evidence_quote": "分区 za4 正常；三笔上传被路由到 zb1，落进 tenant_id=140709",
        },
    }
    base.update(overrides)
    return base


def review(**overrides):
    return P.review_candidate(cand(**overrides))


def load_golden():
    return P._load_golden(GOLDEN)


class StubLLM:
    """替身模型：按段文本返回预置 entries，不联网。"""

    model = "stub-model"

    def __init__(self, entries, warning=None, usage=None, ms=12):
        self.entries = entries
        self.warning = warning
        self.usage = usage or {"tokensIn": 100, "tokensOut": 50, "tokensTotal": 150, "reasoningTokens": 0}
        self.ms = ms
        self.calls = []

    def extract_json_array(self, material, **kwargs):
        self.calls.append(material)
        return {
            "content": json.dumps(self.entries, ensure_ascii=False),
            "entries": list(self.entries),
            "usage": dict(self.usage),
            "attempts": 1,
            "ms": self.ms,
            "warning": self.warning,
        }


class StubLLMError(StubLLM):
    """某几段直接抛错（测管道容错）。"""

    def extract_json_array(self, material, **kwargs):
        raise exp_llm.LLMError("boom", reason="http-500", attempts=3)


def ok_response(content, reasoning="", finish="stop", tokens=(10, 5, 0)):
    return {
        "choices": [{"message": {"content": content, "reasoning_content": reasoning},
                     "finish_reason": finish}],
        "usage": {
            "prompt_tokens": tokens[0],
            "completion_tokens": tokens[1],
            "completion_tokens_details": {"reasoning_tokens": tokens[2]},
            "total_tokens": tokens[0] + tokens[1],
        },
        "model": "stub-model",
    }


# ================================================================ ① prompt 常量
def test_prompt_constants():
    print("\n[1] prompt 版本与必含要素")
    check("PROMPT_VERSION == 'exp-v2.0'", exp_prompt.PROMPT_VERSION == "exp-v2.0",
          exp_prompt.PROMPT_VERSION)
    check("版本号形如 exp-v2.<n>", bool(__import__("re").match(r"^exp-v2\.\d+$", exp_prompt.PROMPT_VERSION)))
    check("三镜头 == jargon/index/logic", exp_prompt.LENSES == ("jargon", "index", "logic"),
          str(exp_prompt.LENSES))
    prompt_text = exp_prompt.PROMPT_TEMPLATE
    check("prompt 含三个镜头标识与说明",
          all(lens in prompt_text for lens in exp_prompt.LENSES)
          and all(exp_prompt.LENS_DESCRIPTIONS[lens] in prompt_text for lens in exp_prompt.LENSES))
    check("四类 category == business/debug/repo/tool",
          exp_prompt.CATEGORIES == ("business", "debug", "repo", "tool"), str(exp_prompt.CATEGORIES))
    check("prompt 含四类 category 标识", all(c in prompt_text for c in exp_prompt.CATEGORIES))
    check("process 不在有效 category 里且被标为拒收",
          exp_prompt.REJECTED_CATEGORY == "process"
          and exp_prompt.REJECTED_CATEGORY not in exp_prompt.CATEGORIES
          and exp_prompt.PROCESS_REJECT_REASON == "skill-covered")
    check("prompt 明确禁止输出 process/skill-covered",
          "process" in prompt_text and "skill" in prompt_text.lower())
    check("九类垃圾恰 9 条且 code 唯一",
          len(exp_prompt.GARBAGE_CLASSES) == 9
          and len(set(exp_prompt.GARBAGE_CODES)) == 9, str(exp_prompt.GARBAGE_CODES))
    check("prompt 逐一列出九类垃圾名称",
          all(g["name"] in prompt_text for g in exp_prompt.GARBAGE_CLASSES))
    check("九类垃圾 reason 唯一且都计入垃圾", len(set(exp_prompt.ALL_GARBAGE_REASONS)) == 9
          and all(exp_prompt.is_garbage_reason(r) for r in exp_prompt.ALL_GARBAGE_REASONS))
    check("skill-covered 不计入垃圾率", exp_prompt.is_garbage_reason("skill-covered") is False)
    check("可审计三维 == reusable_because/exclusions/evidence_quote",
          exp_prompt.AUDIT_DIMENSIONS == ("reusable_because", "exclusions", "evidence_quote"))
    check("prompt 含可审计三维与 evidence_quote 要求",
          all(dim in prompt_text for dim in exp_prompt.AUDIT_DIMENSIONS))
    check("prompt 里的字数上限与常量一致",
          str(exp_prompt.WHAT_MAX) in prompt_text and str(exp_prompt.WHEN_MAX) in prompt_text
          and str(exp_prompt.WHY_MAX) in prompt_text
          and str(exp_prompt.SIM_WHAT_WHY) in prompt_text)
    check("prompt 要求 what 用祈使句、when 可判定、why 讲机制",
          all(word in prompt_text for word in ("祈使句", "可判定", "机制")))
    check("prompt 带少样本且字段齐全",
          len(exp_prompt.FEW_SHOT_EXAMPLES) >= 3
          and all(set(("what", "when_expr", "why", "lens", "category", "audit")) <= set(e)
                  for e in exp_prompt.FEW_SHOT_EXAMPLES))
    check("少样本都符合两轴枚举",
          all(e["lens"] in exp_prompt.LENSES and e["category"] in exp_prompt.CATEGORIES
              for e in exp_prompt.FEW_SHOT_EXAMPLES))
    nasty = "素材里有 %s 占位、{花括号}、反斜杠 C:\\tmp\\x 与 100% 进度"
    rendered = exp_prompt.render_prompt(nasty)
    check("render_prompt 注入素材且不被 % / {} / \\ 干扰", nasty in rendered
          and exp_prompt.MATERIAL_PLACEHOLDER not in rendered)
    check("prompt_fingerprint 是 16 位十六进制且稳定",
          len(exp_prompt.prompt_fingerprint()) == 16
          and exp_prompt.prompt_fingerprint() == exp_prompt.prompt_fingerprint())


# ================================================================ ② Review：九类垃圾
def test_review_garbage_classes():
    print("\n[2] Review 九类垃圾逐条拦截")
    base_ok = review()
    check("合法候选默认通过（默认保留）", base_ok["ok"] is True, base_ok)

    r = P.review_candidate(
        cand(what="StorePersistenceComputeImpl 在本仓库中存在，评估库存修复范围前先读它",
             why="只处理 store 与 store_account 会留下负批次与进销存缺口",
             lens="index"),
        symbol_lookup=lambda name: False,
    )
    check("① 事实性错误：index 断言存在但索引没有 → 拦",
          r["reason"] == "garbage-1-factual-error", r)

    r = review(what="遇到问题多收集上下文", why="上下文越全越容易定位到真正的根因所在")
    check("② 通用常识 → 拦", r["reason"] == "garbage-2-common-sense", r)

    r = review(what="本次改了 7 个文件并跑了 3 次测试",
               why="改动集中在库存归属与结余重算两处逻辑")
    check("③ 对话摘要（过程录像）→ 拦", r["reason"] == "garbage-3-dialogue-summary", r)

    r = review(what="确认 dev1 的临时开关已打开后再触发重放任务",
               why="开关没打开时消息进队列但不被消费，看起来像投递失败")
    check("④ 一次性 case → 拦", r["reason"] == "garbage-4-one-off", r)

    r = review(what="先沟通再动手改代码", why="避免方向理解偏差导致的返工与相互覆盖")
    check("⑤ 用户主观偏好 → 拦", r["reason"] == "garbage-5-user-preference", r)

    r = review(when_expr="处理问题时")
    check("⑥ 缺少上下文（when 过短/不可判定）→ 拦",
          r["reason"] == "garbage-6-missing-context", r)
    check("when 下限常量为 10（人工第 2、4 条 when 恰 11 字，12 会误伤）",
          exp_prompt.WHEN_MIN == 10 and P.default_policy()["when_min"] == 10, exp_prompt.WHEN_MIN)

    r = review(what="CHGJ-3735 涉及 3 笔共 34 元，需核对统计口径",
               why="金额与笔数属于该工单的明细，不该写进通用结论里")
    check("⑦ 粒度混用（case 明细进 what）→ 拦", r["reason"] == "garbage-7-mixed-granularity", r)

    r = review(what="值得团队共同体会", why="这类判断只有长期做过交付的人才会形成直觉")
    check("⑧ 不可执行（无动作也无锚点）→ 拦", r["reason"] == "garbage-8-not-actionable", r)

    r = review(audit={"reusable_because": "有道理", "exclusions": "1", "evidence_quote": ""})
    check("⑨ 证据不足（缺 evidence_quote）→ 拦", r["reason"] == "garbage-9-no-evidence", r)
    check("缺证据时 garbage 标记为真", r["garbage"] is True and r["skillCovered"] is False)

    r = review(category="process")
    check("process 直接拒收为 skill-covered（不计垃圾）",
          r["reason"] == "skill-covered" and r["skillCovered"] is True and r["garbage"] is False, r)

    r = review(what="只推个人 fork，不要直推 origin 分支",
               why="直推 origin 会污染共享分支并触发保护规则拒绝")
    check("skill 已覆盖的团队规范 → skill-covered", r["reason"] == "skill-covered", r)

    reasons = set(exp_prompt.ALL_GARBAGE_REASONS)
    hit = set()
    for kwargs, lookup in (
        (dict(what="StorePersistenceComputeImpl 在本仓库中存在，评估库存修复范围前先读它",
              lens="index"), lambda name: False),
        (dict(what="遇到问题多收集上下文"), None),
        (dict(what="本次改了 7 个文件并跑了 3 次测试"), None),
        (dict(what="确认 dev1 的临时开关已打开后再触发重放任务"), None),
        (dict(what="先沟通再动手改代码"), None),
        (dict(when_expr="处理问题时"), None),
        (dict(what="CHGJ-3735 涉及 3 笔共 34 元，需核对统计口径"), None),
        (dict(what="值得团队共同体会"), None),
        (dict(audit={"evidence_quote": ""}), None),
    ):
        base = cand(**kwargs)
        verdict = P.review_candidate(base, symbol_lookup=lookup) if lookup else P.review_candidate(base)
        hit.add(verdict["reason"])
    check("九类垃圾每类都至少命中一条用例", set(exp_prompt.ALL_GARBAGE_REASONS) <= hit,
          f"缺失={reasons - hit}")


# ================================================================ ② Review：其它规则
def test_review_other_rules():
    print("\n[3] Review 其它规则（what≈why / when / 超长 / 非法字段）")
    dup_what = "分区路由错时数据写进别的租户库，客户端仍收到成功"
    r = review(what=dup_what, why=dup_what)
    check("what 与 why 相同 → 未提炼拦截",
          r["reason"] == "unrefined-what-equals-why", r)

    r = review(what="分区路由错时数据写进别的租户库客户端仍收到成功提示",
               why="分区路由错时数据写进别的租户库，客户端仍收到成功提示")
    check("what≈why 相似度 >0.75 → 拦截（阈值生效）",
          r["reason"] == "unrefined-what-equals-why",
          r)

    r = review(when_expr="查不到流水")
    check("when 仅 5 字 → 缺少上下文", r["reason"] == "garbage-6-missing-context", r)

    r = review(when_expr="导出上月的销售报表")  # 9 字：仍在下限之外
    check("when 9 字（<10）→ 拦", r["reason"] == "garbage-6-missing-context", r)

    r = review(when_expr="导出上月门店销售报表")  # 10 字：正好达到下限
    check("when 10 字（=下限）→ 放行", r["ok"] is True, r)

    r = review(when_expr="怀疑流水被写到别的分区")  # 11 字：人工标准第 2 条
    check("when 11 字（人工标准第 2 条原样）→ 放行", r["ok"] is True, r)

    r = review(when_expr="客户报上传成功但后台查不到流水")
    check("when 正常长度不拦", r["ok"] is True, r)

    r = review(what="确认" + "分区归属" * 25)
    check("what 超 90 字 → 粒度混用（超长）", r["reason"] == "garbage-7-mixed-granularity", r)

    r = review(lens="unknown")
    check("lens 非法 → invalid-field", r["reason"] == "invalid-field", r)

    r = review(category="nonsense")
    check("category 非法 → invalid-field", r["reason"] == "invalid-field", r)

    r = review(what="")
    check("缺字段 → invalid-field", r["reason"] == "invalid-field", r)

    # 缺 category（人工 17 条就没有该字段）不该被拦，只在落库时兜底推断
    raw = cand()
    raw.pop("category")
    r = P.review_candidate(raw)
    check("缺 category 不拦（模型漏填由 infer_category 兜底）", r["ok"] is True, r)

    syn = P.similarity("分区路由错时数据写进别的租户库", "分区路由错时数据写进其他租户库")
    check("相似度对同义改写不过度敏感（>0.5）", syn > 0.5, syn)
    check("相似度对无关文本接近 0",
          P.similarity("分区路由错时数据写进别的租户库", "gradle 构建用 java 直调") < 0.2)


# ================================================================ ③ 黄金样本回归
def test_golden_regression():
    print("\n[4] 人工标准回归（experiences-v2-session-4ff93b80.jsonl）")
    golden = load_golden()
    check("黄金样本可解析（17 条，标准 JSONL 一行一条）", len(golden) == 17, len(golden))
    check("黄金样本三镜头取值合法",
          all(g["lens"] in exp_prompt.LENSES for g in golden))

    # Lead 裁定后默认 when_min=10：人工标准必须全过（这正是改阈值的依据）
    default_policy = P.default_policy()
    blocked = []
    for idx, g in enumerate(golden, 1):
        verdict = P.review_candidate(P.normalize_candidate(g, policy=default_policy),
                                     policy=default_policy)
        if not verdict["ok"]:
            blocked.append((idx, verdict["reason"], verdict["detail"]))
    check("默认策略（when>=10）下 17/17 全部通过", not blocked, blocked)

    # 保留旧阈值 12 的反证：它会误伤人工第 2、4 条（when 恰 11 字）——记录改阈值的依据
    strict = P.default_policy(when_min=12)
    strict_blocked = [idx for idx, g in enumerate(golden, 1)
                      if not P.review_candidate(P.normalize_candidate(g, policy=strict),
                                                policy=strict)["ok"]]
    check("旧阈值 when_min=12 会误伤恰好 2 条（人工标准第 2、4 条）",
          strict_blocked == [2, 4], strict_blocked)

    deduped = P.dedup_candidates([P.normalize_candidate(g) for g in golden])
    check("黄金 17 条互不合并（Dedup 宁严勿宽）",
          len(deduped["kept"]) == 17 and not deduped["merged"],
          f"kept={len(deduped['kept'])} merged={len(deduped['merged'])}")

    lens_count = {}
    for g in golden:
        lens_count[g["lens"]] = lens_count.get(g["lens"], 0) + 1
    check("黄金 lens 分布以 logic/index 为主（logic 最多）",
          lens_count.get("logic", 0) >= lens_count.get("index", 0), lens_count)

    # _load_golden 要同时吃两种落盘形态：标准 JSONL（一行一条）与旧的 pretty-print 流
    jsonl_path = os.path.join(TMP, "golden-jsonl.jsonl")
    with open(jsonl_path, "w", encoding="utf-8") as fh:
        for g in golden[:2]:
            fh.write(json.dumps(g, ensure_ascii=False) + "\n")
    pretty_path = os.path.join(TMP, "golden-pretty.jsonl")
    with open(pretty_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(json.dumps(g, ensure_ascii=False, indent=2) for g in golden[:2]))
    check("_load_golden 支持标准 JSONL（一行一条）",
          len(P._load_golden(jsonl_path)) == 2)
    check("_load_golden 兼容旧 pretty-print 流（回退解析）",
          len(P._load_golden(pretty_path)) == 2)


# ================================================================ ④ 源码事实校验
def test_symbol_verification():
    print("\n[5] 源码探索事实校验")
    missing = lambda name: False  # noqa: E731
    present = lambda name: True  # noqa: E731

    c = cand(what="评估库存修复范围前先读 StorePersistenceComputeImpl 确认它写五张表",
             why="只处理 store 与 store_account 会留下负批次与进销存缺口",
             lens="logic")
    r = P.review_candidate(c, symbol_lookup=missing)
    check("跨仓符号不存在 + 非 index 镜头 → 不拦，只标 unverified",
          r["ok"] is True and c["audit"].get("unverified") is True
          and "StorePersistenceComputeImpl" in c["audit"].get("unverifiedSymbols", []),
          r)

    c2 = cand(what="这条经验说 StoreComputeImpl 存在于本仓库的库存模块",
              why="评估库存修复范围前必须先确认它写的是哪五张表",
              lens="index")
    r2 = P.review_candidate(c2, symbol_lookup=missing)
    check("index 镜头 + 断言'存在' → 升级为事实性错误（garbage-1）",
          r2["reason"] == "garbage-1-factual-error", r2)

    c3 = cand(what="评估库存修复范围前先读 StoreComputeImpl 确认它写五张表",
              why="只处理 store 与 store_account 会留下负批次与进销存缺口")
    r3 = P.review_candidate(c3, symbol_lookup=present)
    check("符号在索引里存在 → 通过且无 unverified 标记",
          r3["ok"] is True and not (c3.get("audit") or {}).get("unverified"), r3)

    verdict = P.verify_symbols({"what": "读 ReportService 与 DataController 的数据来源",
                                "why": "", "lens": "index"}, missing)
    check("verify_symbols 能抽出多个符号并全部标未验证",
          set(verdict["symbols"]) == {"ReportService", "DataController"}
          and len(verdict["unverified"]) == 2, verdict)

    lookup = P.make_code_index_lookup([os.path.join(TMP, "not-exist.db")])
    check("索引库缺失时 lookup 返回 False 而不是抛错", lookup("StoreComputeImpl") is False)


# ================================================================ ⑤ Dedup
def test_dedup():
    print("\n[6] Dedup（宁严勿宽 + 禁止桥接）")
    check("阈值冻结为 0.82 / 0.70",
          (exp_prompt.DEDUP_WHAT, exp_prompt.DEDUP_WHEN) == (0.82, 0.70))

    base_what = "比对同机相邻流水的落库分区确认是否跨租户错写"
    when = "客户报上传成功但后台查不到流水"
    a = cand(what=base_what, when_expr=when, audit={"evidence_quote": "分区 za4 正常"})
    b = cand(what="先" + base_what, when_expr=when, audit={"evidence_quote": "分区 za4 正常"})
    result = P.dedup_candidates([a, b])
    check("what/when 双高相似 → 合并为 1 条",
          len(result["kept"]) == 1 and len(result["merged"]) == 1, result)
    check("被合并条目的来源记进 mergedFrom",
          result["kept"][0].get("mergedFrom") and "what" in result["kept"][0]["mergedFrom"][0])

    c = cand(what=base_what, when_expr="重放库存消息前清理接口日志", audit={"evidence_quote": "q"})
    d = cand(what="先" + base_what, when_expr="报表口径核对前先看字段定义", audit={"evidence_quote": "q"})
    result2 = P.dedup_candidates([c, d])
    check("what 高但 when 低 → 不合并（双条件都要满足）", len(result2["kept"]) == 2, result2)

    bridge_b = "重放消息前先删除接口日志防重记录再"
    bridge_a = bridge_b + "投一条"
    bridge_c = bridge_b + "试一次"
    when2 = "手工 XADD 投递 stream 后确认是否成功"
    group = [
        cand(what=bridge_a, when_expr=when2, audit={"evidence_quote": "q1"}),
        cand(what=bridge_b, when_expr=when2, audit={"evidence_quote": "q2"}),
        cand(what=bridge_c, when_expr=when2, audit={"evidence_quote": "q3"}),
    ]
    sim_ab, sim_bc, sim_ac = (P.similarity(bridge_a, bridge_b), P.similarity(bridge_b, bridge_c),
                              P.similarity(bridge_a, bridge_c))
    bridged = P.dedup_candidates(group)
    check("桥接夹具成立：A~B 与 B~C 均 >0.82，A~C <0.82",
          sim_ab > 0.82 and sim_bc > 0.82 and sim_ac < 0.82, (sim_ab, sim_bc, sim_ac))
    check("禁止桥接：A~B~C 只合并 B，最终保留 2 条",
          len(bridged["kept"]) == 2 and len(bridged["merged"]) == 1,
          [x["what"] for x in bridged["kept"]])
    check("桥接不会被串联成 1 条（若是传递闭包会只剩 1 条）", len(bridged["kept"]) != 1)

    e = cand(what=base_what, when_expr=when)
    result3 = P.dedup_candidates([e, e, e])
    check("完全相同的三条只留 1 条且 mergedFrom 记 2 条",
          len(result3["kept"]) == 1 and len(result3["kept"][0]["mergedFrom"]) == 2)


# ================================================================ ⑥ Merge
def test_merge():
    print("\n[7] Merge 唯一目标前置（create/update/skip/contradict）")
    what = "查 POS 生产日志用 default 环境不要用 www_ali 环境"
    when = "查 POS 或 ERP 线上业务日志"
    c = cand(what=what, when_expr=when, audit={"evidence_quote": "日志在 default 环境 44 主题"})

    check("无同向目标 → create", P.analyze_merge(c, [])["action"] == "create")

    same1 = {"what": what, "when_expr": when, "why": c["why"],
             "audit": {"evidence_quote": "日志在 default 环境 44 主题"}}
    same2 = {"what": what[:-2], "when_expr": when, "why": "www_ali 只剩心跳",
             "audit": {"evidence_quote": "另一个证据"}}
    ambiguous = P.analyze_merge(c, [same1, same2])
    check("同向目标不唯一 → create（不猜）", ambiguous["action"] == "create", ambiguous)

    skip = P.analyze_merge(c, [same1])
    check("唯一同向且证据已覆盖 → skip",
          skip["action"] == "skip" and skip["target"] is same1, skip)

    update_target = {"what": what, "when_expr": when, "why": "短",
                     "audit": {"evidence_quote": "完全不同的另一段证据原文"}}
    update = P.analyze_merge(c, [update_target])
    check("唯一同向但带来新证据 → update", update["action"] == "update", update)

    opposite_cand = cand(what="查 POS 生产日志就用 www_ali 环境",
                         when_expr="查 POS 或 ERP 线上业务日志",
                         audit={"evidence_quote": "日志在 www_ali"})
    opposite_target = {"what": what, "when_expr": when, "why": "www_ali 只剩心跳",
                       "audit": {"evidence_quote": "日志在 default 环境 44 主题"}}
    contra = P.analyze_merge(opposite_cand, [opposite_target])
    check("同向但否定极性相反 → contradict",
          contra["action"] == "contradict" and contra["target"] is opposite_target, contra)

    two_opposite = P.analyze_merge(opposite_cand, [opposite_target, dict(opposite_target)])
    check("相反方向目标不唯一 → create（走人工而非猜）",
          two_opposite["action"] == "create", two_opposite)

    check("每次判定都给出可读 reason",
          all(P.analyze_merge(c, existing)["reason"]
              for existing in ([], [same1], [same1, same2])))


# ================================================================ ⑦ 证据片段 / 脱敏
def test_excerpt_and_mask():
    print("\n[8] 证据片段生成与脱敏")
    lines = [f"第{i}行：普通记录内容" for i in range(1, 11)]
    lines[4] = "第5行：分区 za4 正常，三笔上传被路由到 zb1"
    material = "\n".join(lines)
    exc = P.build_excerpt(material, hit="zb1")
    check("命中行 ±2 行（第 3~7 行，共 5 行）",
          exc["hitFound"] is True and exc["lines"] == 5
          and "第3行" in exc["text"] and "第7行" in exc["text"]
          and "第2行" not in exc["text"] and "第8行" not in exc["text"], exc)

    exc2 = P.build_excerpt(material, hit="这段素材里根本没有")
    check("命中不到时退回窗口并标 hitFound=False",
          exc2["hitFound"] is False and exc2["text"], exc2)

    secret_material = (
        f"配置片段：api_key={FAKE_SK}\n"
        f"请求头 Authorization: Bearer {FAKE_BEARER}\n"
        f"连接串 password={FAKE_PASSWORD}\n"
        f"客户手机 {FAKE_PHONE} 与身份证 {FAKE_ID_CARD}\n"
        "tenant_id=140709 / 门店 9016 / CHGJ-3943 / SPLAT-5584"
    )
    masked = P.mask_secrets(secret_material)
    check("sk- 密钥打码", FAKE_SK not in masked and "sk-***" in masked, masked)
    check("Bearer token 打码", FAKE_BEARER not in masked and "Bearer ***" in masked, masked)
    check("password= 明文打码", FAKE_PASSWORD not in masked and "password=***" in masked, masked)
    check("手机号打码", FAKE_PHONE not in masked and "***" in masked, masked)
    check("身份证打码", FAKE_ID_CARD not in masked, masked)
    check("租户名与工单号保留", "tenant_id=140709" in masked and "CHGJ-3943" in masked
          and "SPLAT-5584" in masked and "9016" in masked, masked)
    check("contains_secret 能识别敏感素材", P.contains_secret(secret_material) is True)
    check("干净文本不误报敏感", P.contains_secret("分区 za4 正常，CHGJ-3943 已处理") is False)

    exc3 = P.build_excerpt(secret_material, hit="password")
    check("片段入库前已脱敏且 sha256 基于脱敏后文本",
          FAKE_PASSWORD not in exc3["text"] and "***" in exc3["text"]
          and exc3["sha256"] == __import__("hashlib").sha256(exc3["text"].encode("utf-8")).hexdigest(),
          exc3)

    cmd_material = ("输出噪声第一行\n"
                    "$ git status --short\n"
                    " M server.py\n"
                    "?? exp_prompt.py\n"
                    "$ pnpm test\n"
                    "全部通过 12 项")
    cmd = P.build_excerpt(cmd_material, kind="command")
    check("命令类只留命令（丢输出噪声）",
          cmd["kind"] == "command" and "git status --short" in cmd["text"]
          and "pnpm test" in cmd["text"] and "输出噪声第一行" not in cmd["text"]
          and "全部通过" not in cmd["text"], cmd)

    log_material = "\n".join(f"2026-11-20 10:0{i}:0{i} INFO 消费成功 seq={i}" for i in range(8))
    log = P.build_excerpt(log_material, kind="auto")
    check("日志类首尾各 3 行（含省略号）",
          log["kind"] == "log" and log["text"].count("INFO") == 6 and "…" in log["text"], log)

    sql_material = "执行结果：\nselect id, name from tenant where id = 140709;\n共 1 行"
    sql = P.build_excerpt(sql_material, kind="auto")
    check("SQL 类只留语句", sql["kind"] == "sql" and "select id, name from tenant" in sql["text"]
          and "执行结果" not in sql["text"], sql)

    big_material = "\n".join(["2026-11-20 10:00:00 ERROR " + "很长的日志内容" * 40] * 40)
    big = P.build_excerpt(big_material, kind="log")
    check("片段 ≤2KB（超长按字节裁剪并标 truncated）",
          len(big["text"].encode("utf-8")) <= P.EXCERPT_MAX_BYTES and big["truncated"] is True,
          len(big["text"].encode("utf-8")))

    again = P.build_excerpt(material, hit="zb1")
    check("同输入 sha256 稳定", again["sha256"] == exc["sha256"])
    changed = P.build_excerpt(material, hit="第9行")
    check("不同输入 sha256 不同", changed["sha256"] != exc["sha256"])

    check("四条素材类型 + quote 共 5 类判定可用",
          P.detect_kind("随便一段说明文字") == "quote"
          and P.detect_kind("$ pytest -x") == "command"
          and P.detect_kind("2026-11-20 10:00:01 INFO ok") == "log"
          and P.detect_kind("select 1 from dual") == "sql"
          and P.detect_kind("随便一段说明文字", explicit="context") == "context")

    # 真实素材上踩到的误判：散文顺带提到 git 命令，不能整段判成 command
    prose = "- `git add` failed（pathspec did not match）：仓库 toplevel 是另一个目录，要用 git -C 指定"
    check("提到 git 命令的散文仍判为 quote（不是 command）", P.detect_kind(prose) == "quote",
          P.detect_kind(prose))
    check("行首是真命令才判 command（prompt 提示符也算）",
          P.detect_kind("git status --short") == "command"
          and P.detect_kind("$ pnpm test") == "command"
          and P.detect_kind("- `git add` failed") == "quote")


# ================================================================ ⑧ LLM 客户端
def test_llm_client():
    print("\n[9] LLM 客户端（默认参数 / 重试 / 超时 / 推理型识别 / 统计）")
    client = exp_llm.LLMClient(transport=lambda *a: ok_response("[]"), sleep=lambda s: None)
    check("默认 max_tokens=8000 / timeout=240s / 重试 2 次",
          client.max_tokens == 8000 and client.timeout_ms == 240000 and client.max_retries == 2,
          (client.max_tokens, client.timeout_ms, client.max_retries))
    check("默认退避为 2s / 8s", client.backoff == (2.0, 8.0), client.backoff)
    check("墙钟硬截止默认等于 timeout（240s）", client.hard_timeout_ms == 240000, client.hard_timeout_ms)
    check("base_url 自动补 /v1", exp_llm.LLMClient(base_url="http://x:1").base_url == "http://x:1/v1")

    calls = {"n": 0}
    sleeps = []

    def flaky(url, payload, headers, timeout_s):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise exp_llm.LLMError("rate limited", reason="http-429", status=429)
        return ok_response('[{"what":"ok"}]', tokens=(20, 10, 0))

    c2 = exp_llm.LLMClient(transport=flaky, sleep=sleeps.append)
    result = c2.chat([{"role": "user", "content": "hi"}])
    check("429 两次后成功：共 3 次尝试", result["attempts"] == 3 and calls["n"] == 3, result)
    check("重试按 2s/8s 退避", sleeps == [2.0, 8.0], sleeps)
    check("成功后 token 统计累计", c2.snapshot()["tokensIn"] == 20
          and c2.snapshot()["tokensOut"] == 10 and c2.snapshot()["retries"] == 2,
          c2.snapshot())
    check("成功响应带 usage 明细", result["usage"]["tokensTotal"] == 30, result["usage"])

    def always_429(url, payload, headers, timeout_s):
        raise exp_llm.LLMError("rate limited", reason="http-429", status=429)

    c3 = exp_llm.LLMClient(transport=always_429, sleep=lambda s: None)
    try:
        c3.chat([{"role": "user", "content": "hi"}])
        check("持续 429 → 抛错", False, "未抛错")
    except exp_llm.LLMError as exc:
        check("重试用尽抛 LLMError 且 attempts=3、reason=http-429",
              exc.attempts == 3 and exc.reason == "http-429", exc.as_dict())

    def always_timeout(url, payload, headers, timeout_s):
        raise exp_llm.LLMError("timeout after 60s", reason="timeout")

    c4 = exp_llm.LLMClient(transport=always_timeout, sleep=lambda s: None)
    try:
        c4.chat([{"role": "user", "content": "hi"}])
        check("超时要抛错", False)
    except exp_llm.LLMError as exc:
        check("超时也会重试后失败，reason=timeout", exc.reason == "timeout" and exc.attempts == 3,
              exc.as_dict())

    bad_calls = {"n": 0}

    # 墙钟硬截止：transport 挂住（线程睡）但 socket 一直"活着"的场景
    def hanging(url, payload, headers, timeout_s):
        time.sleep(0.6)
        return ok_response("[]")

    c4b = exp_llm.LLMClient(transport=hanging, sleep=lambda s: None,
                            timeout_ms=60000, hard_timeout_ms=80, max_retries=1)
    started = time.time()
    try:
        c4b.chat([{"role": "user", "content": "hi"}])
        check("硬截止要抛错", False)
    except exp_llm.LLMError as exc:
        elapsed = time.time() - started
        check("socket 不超时但墙钟超截止 → 仍按 timeout 失败（不会静默挂住）",
              exc.reason == "timeout" and elapsed < 0.55, (exc.reason, round(elapsed, 2)))
        check("硬截止也走重试（2 次尝试）", exc.attempts == 2, exc.attempts)
        check("硬超时计入统计", c4b.snapshot()["hardTimeouts"] == 2, c4b.snapshot()["hardTimeouts"])

    c4c = exp_llm.LLMClient(transport=lambda *a: ok_response("[]"), sleep=lambda s: None,
                            hard_timeout_ms=0)
    check("hard_timeout_ms=0 关闭硬截止（只保留 socket 超时）",
          c4c._transport_with_deadline({})["choices"][0]["message"]["content"] == "[]")
    def always_400(url, payload, headers, timeout_s):
        bad_calls["n"] += 1
        raise exp_llm.LLMError("bad request", reason="http-4xx", status=400)

    c5 = exp_llm.LLMClient(transport=always_400, sleep=lambda s: None)
    try:
        c5.chat([{"role": "user", "content": "hi"}])
        check("400 要抛错", False)
    except exp_llm.LLMError as exc:
        check("4xx 不重试（只尝试 1 次）", exc.attempts == 1 and bad_calls["n"] == 1, exc.as_dict())

    c6 = exp_llm.LLMClient(transport=lambda *a: ok_response("", reasoning="想很久但没结论"),
                           sleep=lambda s: None)
    reasoning_result = c6.chat([{"role": "user", "content": "hi"}])
    check("content 空而 reasoning 有 → warning=reasoning-model",
          reasoning_result["warning"] == "reasoning-model", reasoning_result)

    c7 = exp_llm.LLMClient(transport=lambda *a: ok_response('[{"a":1}]', finish="length"),
                           sleep=lambda s: None)
    check("finish_reason=length → warning=truncated",
          c7.chat([{"role": "user", "content": "hi"}])["warning"] == "truncated")

    def noisy(url, payload, headers, timeout_s):
        return {"ok": True}

    c8 = exp_llm.LLMClient(transport=noisy, sleep=lambda s: None)
    try:
        c8.chat([{"role": "user", "content": "hi"}])
        check("响应缺 choices 要抛错", False)
    except exp_llm.LLMError as exc:
        check("响应缺 choices → bad-response", exc.reason == "bad-response", exc.as_dict())

    cap = exp_llm.LLMClient(transport=lambda *a: ok_response("[]", tokens=(100, 50, 0)),
                            sleep=lambda s: None, token_cap=100)
    cap.chat([{"role": "user", "content": "hi"}])
    try:
        cap.chat([{"role": "user", "content": "hi"}])
        check("token 上限要生效", False)
    except exp_llm.LLMError as exc:
        check("超过 token_cap → reason=token-cap", exc.reason == "token-cap", exc.as_dict())

    # 串行：4 个线程同时打，transport 内部记录并发峰值，必须是 1
    state = {"now": 0, "max": 0}
    guard = threading.Lock()

    def slow(url, payload, headers, timeout_s):
        with guard:
            state["now"] += 1
            state["max"] = max(state["max"], state["now"])
        time.sleep(0.02)
        with guard:
            state["now"] -= 1
        return ok_response("[]")

    c9 = exp_llm.LLMClient(transport=slow, sleep=lambda s: None)
    threads = [threading.Thread(target=lambda: c9.chat([{"role": "user", "content": "hi"}]))
               for _ in range(4)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    check("串行保证：并发峰值 == 1", state["max"] == 1, state)

    entries, err = exp_llm.parse_json_array('```json\n[{"what":"a"}]\n```')
    check("JSON 解析：容忍 ``` 代码块", err is None and entries == [{"what": "a"}], (entries, err))
    entries, err = exp_llm.parse_json_array('说明文字 {"experiences":[{"what":"b"}]} 尾巴')
    check("JSON 解析：容忍对象包一层",
          err is None and entries == [{"what": "b"}], (entries, err))
    entries, err = exp_llm.parse_json_array("完全不是 JSON")
    check("JSON 解析：非 JSON 返回 error 而不抛", entries == [] and err, (entries, err))
    entries, err = exp_llm.parse_json_array("")
    check("JSON 解析：空 content 返回 error", entries == [] and err)

    built = exp_llm.LLMClient.from_settings({"baseUrl": "http://127.0.0.1:3425/v1",
                                             "model": "m1", "maxTokens": 3000,
                                             "timeoutMs": 5000, "apiKeyPlain": "k"})
    check("from_settings 正确映射 baseUrl/model/maxTokens/timeoutMs",
          built.base_url == "http://127.0.0.1:3425/v1" and built.model == "m1"
          and built.max_tokens == 3000 and built.timeout_ms == 5000 and built.api_key == "k")


# ================================================================ ⑨ 管道端到端
def test_pipeline_end_to_end():
    print("\n[10] 管道端到端（stub 模型，离线）")
    material = (
        "### [segment_001.md] 库存归属\n"
        "- 分区 za4 正常；三笔上传被路由到 zb1，落进 tenant_id=140709\n"
        f"- 客户手机 {FAKE_PHONE}，api_key={FAKE_SK}\n"
        "\n"
        "### [segment_002.md] 重放\n"
        "- 接口日志 452 条、status 全 1，必须先清理再重放\n"
    )
    segments = P.split_segments(material)
    check("切分按 digest 段头切出 2 段", len(segments) == 2
          and segments[0]["segmentId"] == "segment_001.md", [s["segmentId"] for s in segments])

    good = cand()
    process_entry = cand(what="只推个人 fork，不要直推 origin 分支",
                         why="直推 origin 会污染共享分支并触发保护规则拒绝")
    no_evidence = cand(what="清理接口日志后再重放库存消息",
                       when_expr="用 Redis 重放 goods:stock 消息",
                       why="消费端按 saleDetailId 判重，日志还在则消息全被当重复丢弃",
                       audit={"reusable_because": "x", "exclusions": "1", "evidence_quote": ""})
    llm = StubLLM([good, process_entry, no_evidence])
    search_calls = []

    result = P.run_pipeline(material, llm=llm, dry_run=True,
                            search_memories=lambda c: search_calls.append(c) or [],
                            session_id="test-sess")
    job = result["job"]
    check("dry_run 不调用 search_memories", search_calls == [], len(search_calls))
    check("候选数 6（2 段 × 3 条）", job["candidates"] == 6, job["candidates"])
    check("拦截数 4（每段各 1 process + 1 无证据）", job["blocked"] == 4, job["blocked"])
    check("skill-covered 单独计数 = 2", job["skill_covered"] == 2, job["skill_covered"])
    check("垃圾率只算真垃圾：4-2=2 条 / 6 候选 ≈ 33.3%",
          abs(job["garbage_rate"] - round(2 / 6, 4)) < 1e-9, job["garbage_rate"])
    check("reasons 里 skill-covered 与 garbage-9 各自计数",
          job["reasons"].get("skill-covered") == 2
          and job["reasons"].get("garbage-9-no-evidence") == 2, job["reasons"])
    check("通过 Review 的候选进入 created", job["created_n"] == 2 and len(result["created"]) == 2,
          job["created_n"])
    check("候选带 audit 三维与 prompt_version",
          all(c["audit"]["prompt_version"] == exp_prompt.PROMPT_VERSION
              and c["audit"]["reusable_because"] and c["audit"]["evidence_quote"]
              for c in result["candidates"]))
    check("候选带 fingerprint（sha1 40 位）",
          all(len(c["fingerprint"]) == 40 for c in result["candidates"]))
    check("候选带证据片段且已脱敏",
          all(c.get("excerpt") and FAKE_SK not in c["excerpt"]["text"]
              and FAKE_PHONE not in c["excerpt"]["text"] for c in result["candidates"]))
    check("job 字段覆盖 exp_jobs 需要的列",
          {"mode", "status", "model", "prompt_version", "tokens_in", "tokens_out", "ms",
           "candidates", "blocked", "created_n", "updated_n", "skipped_n",
           "contradicted_n", "reasons"} <= set(job), sorted(job))
    check("token 统计按段累加（2 段 × 100/50）",
          job["tokens_in"] == 200 and job["tokens_out"] == 100, (job["tokens_in"], job["tokens_out"]))

    llm2 = StubLLM([good])
    existing = [{"what": good["what"], "when_expr": good["when_expr"], "why": good["why"],
                 "audit": {"evidence_quote": good["audit"]["evidence_quote"]}}]
    result2 = P.run_pipeline(material, llm=llm2, search_memories=lambda c: existing,
                             session_id="test-sess")
    check("非 dry_run 会查已有条目并判 skip（证据已覆盖）",
          result2["job"]["skipped_n"] == 2, result2["job"])

    result3 = P.run_pipeline(material, llm=StubLLMError([]), dry_run=True)
    check("全部段落抽取失败 → status=failed 且记录错误",
          result3["job"]["status"] == "failed" and len(result3["errors"]) == 2,
          result3["job"]["status"])

    result4 = P.run_pipeline(material, llm=StubLLM([], warning="reasoning-model"), dry_run=True)
    check("模型 warning 透传到结果（不进垃圾原因表）",
          result4["warnings"] and result4["warnings"][0]["warning"] == "reasoning-model"
          and "reasoning-model" not in result4["job"]["reasons"], result4["warnings"])

    # 截断不能静默丢：finish_reason=length 要让 job 记账（服务端会写进 exp_jobs.error）
    result5 = P.run_pipeline(material, llm=StubLLM([good], warning="truncated"), dry_run=True)
    job5 = result5["job"]
    check("truncated 单独计数并落进 job.error",
          job5["truncated"] == 2 and "truncated:2/2" in (job5["error"] or ""), job5["error"])
    check("被截断的段在 segments 明细里标记 truncated",
          all(s.get("truncated") for s in result5["segments"]), result5["segments"])
    check("截断不改变 status（已抽出的候选仍有效）", job5["status"] == "done", job5["status"])
    check("无异常时 job.error 为 None", job["error"] is None, job["error"])

    long_material = ("### [segment_007.md] 长段\n"
                     + "".join(f"- 第{i}条：这是一条比较长的素材内容，用来触发按字符上限切分。" * 3 + "\n"
                               for i in range(1, 21)))
    long_segments = P.split_segments(long_material)
    check("单段素材上限 800 字（超长按 bullet 打包切分）",
          all(len(s["text"]) <= 800 for s in long_segments) and len(long_segments) > 1,
          [len(s["text"]) for s in long_segments])
    check("切出来的子段 id 带序号后缀（segment_007.md~2）",
          long_segments[1]["segmentId"].startswith("segment_007.md~"), long_segments[1]["segmentId"])
    check("子段 id 能被再次切分识别（CLI 重新拼回素材后段数不变）",
          len(P.split_segments("\n".join(
              f"### [{s['segmentId']}] {s['topic']}\n{s['text']}" for s in long_segments))) == len(long_segments))
    check("SEGMENT_MAX_CHARS 默认 400 且 run_pipeline 可覆盖",
          P.SEGMENT_MAX_CHARS == 400
          and len(P.split_segments(long_material, max_chars=400)) >= len(long_segments))

    plain = "第一段落内容，讲库存归属。\n\n第二段落内容，讲消息重放。"
    check("非 digest 文本按空行切分",
          len(P.split_segments(plain)) == 2, P.split_segments(plain))
    check("超长文本会再细切（max_chars 生效）",
          len(P.split_segments("\n\n".join(["x" * 200] * 10), max_chars=300)) > 1)


# ================================================================ ⑩ admin 设置存储
def test_admin_settings():
    print("\n[11] admin_store：LLM settings（只回掩码 / 明文分离 / 校验）")
    db_path = os.path.join(TMP, "admin.db")
    st = admin_store.AdminStore(db_path, flush_interval=0.05)
    try:
        defaults = st.get_llm_settings()
        check("默认值：关闭 / max_tokens 8000 / timeout 240s / mode server / evidence excerpt",
              defaults["enabled"] is False and defaults["maxTokens"] == 8000
              and defaults["timeoutMs"] == 240000 and defaults["mode"] == "server"
              and defaults["evidenceMode"] == "excerpt", defaults)
        check("admin 默认值与 exp_llm 常量一致（改一处不会漂）",
              defaults["maxTokens"] == exp_llm.DEFAULT_MAX_TOKENS
              and defaults["timeoutMs"] == exp_llm.DEFAULT_TIMEOUT_MS)
        check("未配置 api_key 时掩码为空且 configured=False",
              defaults["apiKeyMasked"] == "" and defaults["apiKeyConfigured"] is False, defaults)
        check("返回 promptVersion 供页面只读展示",
              defaults["promptVersion"] == exp_prompt.PROMPT_VERSION)

        secret = "sk-" + "mavq7361173763rrfiaqzyxc"
        written = st.set_llm_settings({
            "apiKey": secret, "model": "auto/deepseek-v4.1-flash", "maxTokens": 4500,
            "enabled": True, "mode": "client", "timeoutMs": 45000, "dailyTokenCap": 90000,
        })
        check("写入后读回一致（camelCase 接口）",
              written["enabled"] is True and written["maxTokens"] == 4500
              and written["mode"] == "client" and written["timeoutMs"] == 45000
              and written["dailyTokenCap"] == 90000 and written["model"] == "auto/deepseek-v4.1-flash",
              written)
        check("对外只回掩码，绝不含明文",
              secret not in json.dumps(written, ensure_ascii=False)
              and written["apiKeyMasked"] == secret[:6] + "…" + secret[-4:]
              and written["apiKeyConfigured"] is True, written["apiKeyMasked"])
        check("get_llm_secret 才拿得到明文（服务端内部用）", st.get_llm_secret() == secret)
        check("has_llm_secret / mask_llm_secret 与明文一致",
              st.has_llm_secret() is True and st.mask_llm_secret() == written["apiKeyMasked"])

        after_empty = st.set_llm_settings({"apiKey": ""})
        check("api_key 传空串表示保持原值（不被掩码回写覆盖）",
              st.get_llm_secret() == secret and after_empty["apiKeyConfigured"] is True)

        snake = st.set_llm_settings({"max_tokens": 1234, "evidence_mode": "digest"})
        check("snake_case 字段名同样可写",
              snake["maxTokens"] == 1234 and snake["evidenceMode"] == "digest", snake)

        for bad in ({"maxTokens": "abc"}, {"mode": "bogus"}, {"evidenceMode": "nope"},
                    {"unknownKey": 1}, {"timeoutMs": -5}):
            try:
                st.set_llm_settings(bad)
                check(f"非法值要报错：{bad}", False, "未抛 ValueError")
            except ValueError:
                check(f"非法值要报错：{bad}", True)

        cleared = st.set_llm_settings({}, clear_api_key=True)
        check("clear_api_key 清空密钥", cleared["apiKeyConfigured"] is False
              and st.get_llm_secret() == "")

        # 既有能力回归：settings 表被复用，不能把 api_keys / 密码 / 会话搞坏
        created = st.create_key("回归测试 key", role="index")
        hit = st.lookup(created["key"])
        check("既有 api_keys 能力不受影响（create_key + lookup）",
              hit and hit["id"] == created["id"] and hit["role"] == "index", hit)
        check("key 表与 settings 表互不干扰",
              st.count_keys() == 1 and st.get_llm_settings()["maxTokens"] == 1234)
        st.set_admin_password("admin-pw")
        check("既有管理员密码能力不受影响",
              st.has_admin_password() is True and st.check_admin_password("admin-pw") is True
              and st.check_admin_password("wrong") is False)
        token = st.issue_session(ttl=60)
        check("既有会话签发/校验不受影响",
              st.verify_session(token) is True and st.verify_session("1.bad") is False)
    finally:
        st.close()


# ================================================================ ⑪ 指纹与规范化
def test_fingerprint_and_normalize():
    print("\n[12] 幂等指纹与候选规范化")
    a = P.normalize_candidate(cand())
    b = P.normalize_candidate(cand())
    check("同候选 fingerprint 稳定", a["fingerprint"] == b["fingerprint"])
    check("fingerprint 是 40 位 sha1", len(a["fingerprint"]) == 40)

    c = P.normalize_candidate(cand(what=str(cand()["what"]).replace("先比对", "先  比对")))
    check("fingerprint 对空白/标点抖动不敏感", c["fingerprint"] == a["fingerprint"])

    d = P.normalize_candidate(cand(category="repo"))
    check("fingerprint 随 category 变化", d["fingerprint"] != a["fingerprint"])

    raw_missing = cand()
    raw_missing.pop("category")
    e = P.normalize_candidate(raw_missing)
    check("缺 category 时按关键词兜底并标记 category_inferred",
          e["category"] in exp_prompt.CATEGORIES and e["category_inferred"] is True, e["category"])

    f = P.normalize_candidate({"what": "只推个人 fork", "when_expr": "提交代码前", "why": "w",
                               "lens": "logic", "category": "process"})
    check("normalize 保留 process 标记（由 Review 拒收）", f["category"] == "process")
    check("normalize 补齐 audit 三维与 prompt_version",
          set(exp_prompt.AUDIT_DIMENSIONS) <= set(f["audit"])
          and f["audit"]["prompt_version"] == exp_prompt.PROMPT_VERSION)

    infer = P.infer_category({"what": "在 Git Bash 里用 JAVA_HOME 下的 java 直调 gradle-wrapper.jar",
                              "when_expr": "在 MSYS/Git Bash 执行 gradle 构建", "why": "w"})
    check("infer_category 把构建类线索判成 tool", infer == "tool", infer)


# ================================================================ main
def main():
    print(f"临时目录：{TMP}")
    print(f"黄金样本：{GOLDEN}（存在={os.path.exists(GOLDEN)}）")
    test_prompt_constants()
    test_review_garbage_classes()
    test_review_other_rules()
    test_golden_regression()
    test_symbol_verification()
    test_dedup()
    test_merge()
    test_excerpt_and_mask()
    test_llm_client()
    test_pipeline_end_to_end()
    test_admin_settings()
    test_fingerprint_and_normalize()
    print(f"\n结果：{PASS} 通过 / {FAIL} 失败（合计 {PASS + FAIL} 项断言）")
    if FAIL:
        print("❌ 未全绿")
        return 1
    print("✅ 全绿")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(code)
