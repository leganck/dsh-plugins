"""Stage B（LLM 可选版）：OpenAI 兼容 chat/completions 抽取候选。

env：PIPE_LLM_URL / PIPE_LLM_KEY / PIPE_LLM_MODEL（缺任一 → 配置不可用）。
九类垃圾特征内嵌 prompt；输出 JSON 数组候选。任何失败（配置缺失/网络/解析）
都**不抛出**，由调用方降级回规则版并注明。
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

from stage_a import Topic
from stage_b_rules import Candidate, classify_lens, infer_repo, build_when

JUNK_FEATURES = """九类垃圾特征（命中任何一类即丢弃，不要输出为候选）：
1. 过程性指令（"继续/重试/换个方式"），无事实增量；
2. 纯情绪/寒暄（"好的/谢谢/牛逼"）；
3. 无锚定事实的泛化总结（没有工单号/路径/类名/表名/工具名任何一种）；
4. 一次性环境细节（本机临时文件名、端口号、随机 hash），换台机器就失效；
5. 失败路径录像（只记录"试了不行"，没有修正结论）；
6. 与代码/工程无关的生活闲聊；
7. 已被用户明确否决的猜测（"别瞎猜测"类纠正后仍输出的推断）；
8. 超大段原文引用（不是提炼，是复读）；
9. 敏感信息（密码/token/密钥）——绝不入库。"""

SYSTEM_PROMPT = """你是经验提纯器。从会话片段中提炼「可复用的工程经验」，输出 JSON 数组。
每条经验：{"what": "经验主体（一句话，≥8字）", "when_expr": "适用时机/触发条件",
"why": "原因或依据", "lens": "jargon|index|logic",
"evidence_hint": {"issue": "工单号或空", "symbol": "类名/方法名或空", "table": "表名或空"}}
lens 判定：logic=修正/约束/根因结论；index=文件路径/模块/类名/表名定位；
jargon=行话/工具黑话（词典未命中的专有名词）。

""" + JUNK_FEATURES + """

只输出 JSON 数组，不要 markdown 代码围栏，不要解释。没有可提炼的就输出 []。"""


class LLMConfigError(RuntimeError):
    """LLM 配置缺失（PIPE_LLM_URL/PIPE_LLM_KEY/PIPE_LLM_MODEL）。"""


def llm_env_available() -> bool:
    return bool(os.environ.get("PIPE_LLM_URL") and os.environ.get("PIPE_LLM_KEY")
                and os.environ.get("PIPE_LLM_MODEL"))


def extract_llm(topics: list[Topic], model: str = "", timeout: float = 60.0) -> tuple[list[Candidate], str]:
    """LLM 抽取。返回 (候选, 引擎标记)。失败时抛 LLMError 子类，调用方降级。"""
    if not llm_env_available():
        raise LLMConfigError("PIPE_LLM_URL/PIPE_LLM_KEY/PIPE_LLM_MODEL 未全部设置")
    url = os.environ["PIPE_LLM_URL"].rstrip("/")
    key = os.environ["PIPE_LLM_KEY"]
    model = model or os.environ["PIPE_LLM_MODEL"]
    if not url.endswith("/chat/completions"):
        url = url.rstrip("/") + "/v1/chat/completions"
    candidates: list[Candidate] = []
    for tp in topics:
        user_content = f"[主题] {tp.title}\n[锚定事实] issues={tp.facts.issues} "
        user_content += f"symbols={tp.facts.symbols[:10]} tables={tp.facts.sql_tables[:6]}\n"
        user_content += f"[原文]\n{tp.topic_text(3000)}"
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            "temperature": 0.1,
        }
        req = urllib.request.Request(
            url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", "Bearer " + key)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
            raise LLMConfigError(f"LLM 请求失败: {e}") from e
        content = (payload.get("choices") or [{}])[0].get("message", {}).get("content", "")
        for cand in _parse_json_candidates(content):
            what = str(cand.get("what") or "").strip()
            when_expr = str(cand.get("when_expr") or "").strip()
            if not what or not when_expr:
                continue  # 缺 what/when 的直接丢（Review 也会拦）
            hint = cand.get("evidence_hint") or {}
            ev = [{"archive_ref": tp.archive_ref}]
            if hint.get("issue"):
                ev.append({"issue": str(hint["issue"])})
            lens = str(cand.get("lens") or "").strip()
            if lens not in ("jargon", "index", "logic"):
                lens = classify_lens(what + when_expr, tp.facts)
            candidates.append(Candidate(
                repo=infer_repo(what + " " + tp.topic_text(1000), tp.facts),
                lens=lens,
                what=what[:200],
                when_expr=when_expr[:200],
                why=str(cand.get("why") or "")[:400],
                evidence=ev,
                origin="llm",
                topic_ref=tp.archive_ref,
            ))
    return candidates, "llm"


def _parse_json_candidates(content: str) -> list[dict]:
    content = content.strip()
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.S)
    try:
        arr = json.loads(content)
        return [x for x in arr if isinstance(x, dict)] if isinstance(arr, list) else []
    except json.JSONDecodeError:
        m = re.search(r"\[.*\]", content, re.S)
        if m:
            try:
                arr = json.loads(m.group(0))
                return [x for x in arr if isinstance(x, dict)] if isinstance(arr, list) else []
            except json.JSONDecodeError:
                return []
    return []
