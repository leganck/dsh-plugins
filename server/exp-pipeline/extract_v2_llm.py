# -*- coding: utf-8 -*-
"""按腾讯《AI Coding 的下一站》方法论重抽经验（v2）——**独立 CLI，已被服务端 exp_prompt.py 取代**。

保留原因：容器不可用时可在本机手工重抽（不依赖 storage-hub 服务）。
生产路径请用 `server/storage-hub/exp_prompt.py`（prompt 单一事实源）；
两者的三镜头/九类垃圾/可审计三维定义必须一致，改一处要同步另一处。

原始说明：按腾讯《AI Coding 的下一站》方法论重抽经验（v2）。

与规则版的本质差别（文章 §四~§六）：
  1. 经验的定义 = 被召回后 Agent 行为能否正向改变（不是"一段有价值的文本"）
  2. 三镜头分类：黑话(语义不可发现) / 索引(位置不可发现) / 逻辑(行为不可发现)
  3. 九类垃圾特征排除：事实性错误/通用常识/对话摘要/一次性case/用户偏好/
     缺上下文/粒度混用/不可执行/证据不足
  4. 可审计：每条必须给出「为什么算经验」「通过了哪些排除」「证据原文」
  5. Review 用源码探索做事实性校验（拿本机 code-index 的 symbols 表）
  6. Dedup 宁严勿宽、禁止桥接；Merge 唯一目标前置、默认 create

用法：
  python scripts/extract-v2-llm.py --segments 3          # 试跑 3 个分组
  python scripts/extract-v2-llm.py --all --out x.jsonl   # 全量
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

DIGEST = r"D:\work\bug-analysis\_check\session-4ff93b80-experience\experience-digest.md"
MAGPIE = os.environ.get("PIPE_LLM_URL", "http://127.0.0.1:3425/v1")
MODEL = os.environ.get("PIPE_LLM_MODEL", "auto/glm-5.3")
KEY = os.environ.get("PIPE_LLM_KEY", "sk-local")
ERP_DB = r"C:\Users\leganck\.dsh\code-index\smartpos-erp-pos-cb3fcfc4\index.db"
PLUGIN_DB = r"C:\Users\leganck\.dsh\code-index\dsh-plugins-github-36a1d82b\index.db"

PROMPT = """你是 SmartPOS 交付团队的资深工程师。任务：从一段真实工作记录里提炼**团队经验**。

## 什么算经验（唯一标准）
被召回后，另一个 Agent 面对相似场景时**行为会正向改变**。推不出来的才算经验。

## 三镜头（必须选一个，按"Agent 认知障碍"分类，不是按主题）
- jargon（黑话镜头·语义不可发现）：项目内部黑话、缩写、代称，字面无法推导（如"惠管家""D 站"）
- index（索引镜头·位置不可发现）：某个能力/入口/工具在哪，读代码找不到（如"某功能在 xhome 模块的 FastCutXXX 类"）
- logic（逻辑镜头·行为不可发现）：反直觉的工程约束、隐式机制、踩过的坑（如"stop hook 不能同步上报"）

## 九类垃圾（命中任一即**不要输出**）
1 事实性错误（编造约束/把临时说法当规则）2 通用常识（任何项目都适用）3 对话摘要（只复述过程）
4 一次性 case（只对当前任务有效）5 用户主观偏好 6 缺少上下文（不知对应哪个模块/组件/接口）
7 粒度混用（通用规则与 case 细节混在一条）8 不可执行（抽象建议，不知下一步干嘛）9 证据不足（素材里没有依据，全靠推断）

## 硬要求
- what：**祈使句**动作，≤60 字，具体到可执行（说清改什么/查什么/用什么参数）
- when_expr：触发条件，≤40 字，必须收窄到能判定的场景（禁止"处理问题时"这类空条件）
- why：机制/后果，≤80 字，讲清"不这么做会发生什么"
- 三者内容必须互不相同（what 不得复制成 why）
- 剥离审计语气（Earlier claim / was wrong / first attempt / 已验证 等）与工单号细节（工单号只进 evidence）
- 一条只讲一件事；同一素材有多个独立经验就输出多条
- 数量不设下限：全部不合格就输出 []（宁缺勿滥）

## 输出格式（只输出 JSON 数组，无解释无代码块）
[{"what":"...","when_expr":"...","why":"...","lens":"jargon|index|logic",
  "evidence_issue":"工单号或空字符串",
  "audit":{"reusable_because":"为什么这条能改变后续行为（≤40字）",
           "exclusions":"通过与哪几条垃圾规则核对，如'2,3,4'",
           "evidence_quote":"支撑它的原文片段（≤80字，必须来自素材）"}}]

## 素材（同一工作分组的记录）
%s
"""

# ---------------------------------------------------------------- 源数据
def load_groups():
    """按 digest 的 segment 分组（文章 §五：主题分组不附大纲）。"""
    groups, cur = [], None
    with open(DIGEST, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^### \[(segment_\d+\.md)\] (.*)$", line.strip())
            if m:
                cur = {"segment": m.group(1), "topic": m.group(2), "bullets": []}
                groups.append(cur)
                continue
            if line.strip().startswith(("-", "*")) and cur is not None:
                body = line.strip().lstrip("-* ").strip()
                if body:
                    cur["bullets"].append(body)
    return [g for g in groups if g["bullets"]]


# ---------------------------------------------------------------- LLM
def call_llm(text, tries=4):
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT % text}],
        "temperature": 0.2,
        "max_tokens": 6000,   # 推理型模型：留足 reasoning 预算，否则 content 为空
    }
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(
                MAGPIE + "/chat/completions",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY},
            )
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.load(r)
            return (d["choices"][0]["message"].get("content") or "").strip()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 + k * 3)
    raise RuntimeError(f"LLM 失败：{type(last).__name__}: {str(last)[:120]}")


def parse_entries(raw):
    if not raw:
        return []
    m = re.search(r"\[.*\]", raw, re.S)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return []
    return [x for x in arr if isinstance(x, dict)]


# ---------------------------------------------------------------- Review
SYMBOL_RE = re.compile(r"\b([A-Z][A-Za-z0-9]{2,}(?:Service|ServiceImpl|Controller|Mapper|Dao|DAO|Util|Utils|DTO|Enum|Model|Task|Impl))\b")
GENERIC_RE = re.compile(
    r"^(遇到问题|注意|小心|多收集上下文|多沟通|多看日志|仔细检查|充分测试|保持|确保代码|尽量|建议先了解)"
)
OFFCASE_RE = re.compile(r"(这一次|本次|当天|临时|暂时|这次)")
NEWS_RE = re.compile(r"(Earlier claim|was wrong|were wrongly|first attempt|已验证|verified that)", re.I)

_erp_syms, _plugin_syms = None, None


def _load_syms(path):
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        return {r[0] for r in con.execute("select name from symbols")}
    except Exception:
        return set()


def known_symbol(name):
    global _erp_syms, _plugin_syms
    if _erp_syms is None:
        _erp_syms = _load_syms(ERP_DB)
    if _plugin_syms is None:
        _plugin_syms = _load_syms(PLUGIN_DB)
    return name in _erp_syms or name in _plugin_syms


def similarity(a, b):
    """粗相似度：字符集合 Jaccard（what/why 重复检测够用，不引依赖）。"""
    sa, sb = set(a or ""), set(b or "")
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def review(entry):
    """返回 (ok, reason)。对应文章 §6.2：默认保留、定向过滤。"""
    what = (entry.get("what") or "").strip()
    when = (entry.get("when_expr") or "").strip()
    why = (entry.get("why") or "").strip()
    lens = entry.get("lens")
    audit = entry.get("audit") or {}
    if not what or not when or not why:
        return False, "缺字段"
    if lens not in ("jargon", "index", "logic"):
        return False, "lens 非法"
    if len(what) > 90 or len(when) > 70 or len(why) > 140:
        return False, "超长（粒度混用嫌疑）"
    if similarity(what, why) > 0.75:
        return False, "what 与 why 重复（未提炼）"
    if GENERIC_RE.match(what):
        return False, "通用常识"
    if OFFCASE_RE.search(when) and len(when) < 12:
        return False, "一次性 case（when 过窄）"
    if not audit.get("evidence_quote"):
        return False, "证据不足（无 evidence_quote）"
    # 源码探索：名字看起来是真实类/方法时必须能在代码索引里找到（文章 §6.2）
    for sym in SYMBOL_RE.findall(what + " " + why):
        if not known_symbol(sym):
            return False, f"事实性错误（源码无此类：{sym}）"
    return True, ""


def dedup(entries):
    """宁严勿宽 + 禁止桥接：只与已保留代表项比 What+When 双高相似。"""
    kept = []
    for e in entries:
        dup = None
        for k in kept:
            if similarity(e["what"], k["what"]) > 0.82 and similarity(e["when_expr"], k["when_expr"]) > 0.70:
                dup = k
                break
        if dup:
            # 证据取并集，保留更长 why
            dup.setdefault("merged_from", []).append(e["what"][:40])
            continue
        kept.append(e)
    return kept


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--segments", type=int, default=0)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    groups = load_groups()
    if not args.all:
        groups = groups[: args.segments or 3]
    print(f"分组数 {len(groups)}（共 {sum(len(g['bullets']) for g in groups)} 条素材）\n")

    all_kept, stats = [], {"groups": 0, "candidates": 0, "blocked": 0, "reasons": {}}
    for g in groups:
        text = "\n".join(f"- {b}" for b in g["bullets"])
        try:
            raw = call_llm(text)
        except Exception as e:
            print(f"[{g['segment']}] 失败：{e}")
            continue
        cands = parse_entries(raw)
        ok, blocked = [], []
        for c in cands:
            good, reason = review(c)
            (ok if good else blocked).append((c, reason) if not good else c)
        merged = dedup(ok)
        stats["groups"] += 1
        stats["candidates"] += len(cands)
        stats["blocked"] += len(blocked)
        for _, r in blocked:
            stats["reasons"][r] = stats["reasons"].get(r, 0) + 1
        for e in merged:
            e["segment"] = g["segment"]
            all_kept.append(e)
        print(f"[{g['segment']}] 候选 {len(cands)} → Review 拦 {len(blocked)} → Dedup 后 {len(merged)}")
        for c, r in blocked[:2]:
            print(f"    ✗ {r}：{(c.get('what') or '')[:52]}")
        for e in merged[:2]:
            print(f"    ✓ [{e['lens']}] {e['what'][:56]}")

    print(f"\n=== 汇总 ===")
    print(f"  候选 {stats['candidates']} / Review 拦截 {stats['blocked']} / 入库候选 {len(all_kept)}")
    if stats["candidates"]:
        print(f"  垃圾率 {stats['blocked']/stats['candidates']*100:.1f}%")
    print(f"  拦截原因：{json.dumps(stats['reasons'], ensure_ascii=False)}")
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            for e in all_kept:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
        print(f"  已写 {args.out}")


if __name__ == "__main__":
    main()
