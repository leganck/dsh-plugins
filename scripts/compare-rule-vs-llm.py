# -*- coding: utf-8 -*-
"""对照实验：同一条源素材，规则版 vs LLM 版提炼出的「经验」差在哪。

只做展示，不写库。用库里已有的 3 条差样本 + 对应 digest 原句重抽。
"""
import json
import os
import sys
import urllib.request

MAGPIE = os.environ.get("PIPE_LLM_URL", "http://127.0.0.1:3425/v1")
MODEL = os.environ.get("PIPE_LLM_MODEL", "auto/glm-5.3")
KEY = os.environ.get("PIPE_LLM_KEY", "sk-local")

PROMPT = """你是 SmartPOS 交付团队的资深工程师，任务是把「会话素材里的一句话」提炼成**可复用的经验条目**。

## 硬要求
1. 必须是「条件 → 动作 → 依据」的指令式表述，能被另一个工程师直接照做。
2. **剥离叙事外壳**：源码/日志里的 "Earlier claim X was wrong"、"verified"、"first attempt"、"was wrongly included" 这类审计语气一律删掉，只留结论。
3. 三条内容必须**互不相同**：
   - what = 该做什么/不该做什么（祈使句，≤60 字）
   - when_expr = 触发条件（什么情况下适用，≤40 字）
   - why = 依据/原因（为什么这样做，≤80 字）
4. lens 判定：index=定位型（知道去哪找/哪个文件哪个方法）；jargon=内部黑话/专有名词；logic=业务逻辑与约束。
5. 若源句含一次性细节（具体单号的具体数量、某次临时状态），把它降为 evidence，不进 what。
6. 若这句话根本不构成可复用经验（纯进度汇报、纯过程记录），返回 {"skip": true, "reason": "..."}。

## 输出
只输出 JSON，不要 markdown 代码块：
{"what": "...", "when_expr": "...", "why": "...", "lens": "index|jargon|logic", "evidence_issue": "工单号或空"}

## 源句
%s
"""

SAMPLES = [
    "CHGJ-3735/SPLAT-5584 were wrongly included in the first approval draft — verified they are **5.2-line-only bug fixes**; the fix is already in 5.0.x, so they must not be listed for 5.0 patch release.",
    "Earlier claim “文件与 5.0.x 一致 = 可摘” was wrong — file identical means **5.0.x already contains the fix**; CHGJ-2979 must be removed from the 5.0 patch list.",
    "Deploy watcher false positives twice: matched by version string only, read old `status=4`/`status=3` records. Fix: match by version + build time + record id.",
]


def call_llm(text):
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT % text}],
        "temperature": 0.2,
        "max_tokens": 600,
    }
    req = urllib.request.Request(
        MAGPIE + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    return d["choices"][0]["message"]["content"].strip()


for i, s in enumerate(SAMPLES, 1):
    print(f"\n{'='*78}\n样本 {i}  源句：{s[:96]}...")
    try:
        out = call_llm(s)
        try:
            j = json.loads(out.strip().strip("`").removeprefix("json").strip())
        except Exception:
            j = {"raw": out[:400]}
        if j.get("skip"):
            print(f"  LLM 判定：不值得入库 —— {j.get('reason')}")
        else:
            print(f"  what : {j.get('what')}")
            print(f"  when : {j.get('when_expr')}")
            print(f"  why  : {j.get('why')}")
            print(f"  lens : {j.get('lens')}")
    except Exception as e:
        print("  LLM 调用失败：", type(e).__name__, str(e)[:120])
