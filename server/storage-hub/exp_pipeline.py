# -*- coding: utf-8 -*-
"""经验抽取管道：切分 → 抽取 → Review → Dedup → Merge → 证据片段（纯逻辑 + 注入式 store）。

## 为什么这一层不碰数据库
管道里真正需要"外部世界"的只有三件事：调模型、查已有经验（合并判定）、核验源码符号。
把它们做成**注入的 callable**，这一层就退化成纯函数：
- 单测零数据库、零网络、零 sleep，能精确断言每一条规则；
- 服务端把它接到真实 store / code-index 时，不需要改动判定逻辑；
- `--dry-run` 能脱离服务端独立跑（本文件末尾的 CLI）。

## 各阶段的口径（全部来自冻结决策，不要在这里重新发明）
1. **切分**：按 digest 的 `### [segment_NNN.md] topic` 分段；非 digest 文本按空行切，超长再按长度切。
2. **抽取**：一次一段（串行），模型输出经 `exp_llm.parse_json_array` 解析。
3. **Review（默认保留、定向过滤）**：九类垃圾逐一对应稳定 reason code；
   `category=process` → 拒收 `skill-covered`（redundancy，**不计入垃圾率**）。
4. **Dedup（宁严勿宽 + 禁止桥接）**：what >0.82 **且** when >0.70 才合并；
   只与已保留的**代表项**两两比较，不做传递闭包（A~B、B~C 但 A≁C → 保留 A、C 两条）。
5. **Merge（唯一目标前置）**：同向目标必须唯一，0 个或多个 → create；
   1 个且证据已被覆盖 → skip；1 个但有新信息 → update；1 个方向相反 → contradict（走人工）。
6. **证据片段**：命中行 ±2 行；命令只留命令；日志首尾各 3 行；≤2KB；入库前脱敏。

## 脱敏边界
打码：`sk-` 密钥、`Bearer` token、`password=`、手机号、身份证。
**保留**：租户名（tenant_id/tenantName）、工单号（CHGJ-3735 / SPLAT-5584）——
它们是排查证据的核心坐标，打掉就等于把证据变废话。
"""
import hashlib
import json
import re

import exp_prompt
from exp_prompt import (
    CATEGORIES,
    DEDUP_WHAT,
    DEDUP_WHEN,
    MERGE_OPPOSITE_WHAT,
    MERGE_SAME_WHAT,
    PROCESS_REJECT_REASON,
    PROMPT_VERSION,
    REASON_GARBAGE,
    REASON_INVALID,
    REASON_UNREFINED,
    REJECTED_CATEGORY,
    SIM_WHAT_WHY,
    WHAT_MAX,
    WHEN_MAX,
    WHEN_MIN,
    WHY_MAX,
)

# ================================================================ 相似度
_PUNCT_RE = re.compile(
    r"[\s，。；：、！？,.;:!?\"'“”‘’（）()《》\[\]【】<>/\-—_+*=~`|\\^\$#@&%]+", re.U
)


def _norm_text(text):
    """归一化：去标点空白 + 小写。相似度与指纹都基于它，保证不因排版抖动而漂移。"""
    return _PUNCT_RE.sub("", (text or "").lower())


def _bigrams(text):
    """中文不需要分词：字符 bigram 既保留语序，又对同义改写不过度敏感。"""
    s = _norm_text(text)
    if len(s) <= 1:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def similarity(a, b):
    """字符 bigram Jaccard ∈ [0,1]。

    选它而不是"字符集合 Jaccard"：后者对语序不敏感，中文里"分区路由错"与
    "路由分区错"会给 1.0；选它而不是向量：Dedup 的阈值要可解释、可复现，
    同一对文本今天明天必须给同一个数。
    """
    sa, sb = _bigrams(a), _bigrams(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


# ================================================================ 1. 切分
# 单段上限 800 字：实测 1823 字一段素材送进模型，300s 硬截止都跑不完，4000 max_tokens
# 还会被 finish_reason=length 截断。800 字既能把一次输出压在预算内，也不会把一条经验拆散
# （digest 的 bullet 平均 100~200 字）。
SEGMENT_MAX_CHARS = 400
SEGMENT_HEADER_RE = re.compile(r"^###\s*\[(segment_\d+\.md(?:[~#]\d+)?)\]\s*(.*)$")
PART_SEP = "~"

# 二级退化（v2.1）：round1 失败率 17.9%（3 次 timeout + 4 次 bad-json）/ 截断 15.4%。
# 失败或 finish_reason=length 时，把该段再切成 ≤200 字的小段**重试一次**（只一次），
# 单次硬截止收紧到 120s——小段的产出量本来就小，再用 240s 等同一个坏请求只会拖长批次。
DEGRADE_CHARS = 200
DEGRADE_TIMEOUT_MS = 120_000
DEGRADE_MAX_PARTS = 2  # 400 字的段最多切 2 片，避免退化把调用数放大 3 倍
# 退化重试同时把输出预算放宽：round1 的 4 次 bad-json 里 3 次是 reasoning 把 8000 预算吃光
# （复跑探针复核：m08_c00 的首次调用就是 finish_reason=length）。`docs/exp-eval.md` §8.2-5 的
# "content 为空时把 max_tokens 提到 12000 再试一次" 就是这一条。
DEGRADE_MAX_TOKENS = 12_000
DEGRADE_WARNING = "degraded"
# 与 exp_llm.WARN_TRUNCATED 同值：本模块不 import exp_llm（保持纯逻辑层可独立单测）
WARN_TRUNCATED = "truncated"


def split_segments(material, max_chars=SEGMENT_MAX_CHARS):
    """把素材切成"一次喂给模型的最小单元"（≤max_chars）。返回 `[{segmentId, topic, bullets, text}]`。

    digest 格式（`### [segment_003.md] Errors and Fixes` + `- ` 列表）先按 header 分组，
    **再按 bullet 打包到 ≤max_chars**（超限时 id 变成 `segment_003.md~2`）；
    其它文本按空行分块，块内超长再按行切。分段粒度直接决定抽取质量与 token 预算：
    一段塞进多个不相关任务时模型会把经验搅在一起；一段太长则会被截断/超时。
    """
    text = material if isinstance(material, str) else str(material or "")
    lines = text.splitlines()
    segments, current = [], None
    for line in lines:
        m = SEGMENT_HEADER_RE.match(line.strip())
        if m:
            current = {"segmentId": m.group(1), "topic": (m.group(2) or "").strip(), "bullets": []}
            segments.append(current)
            continue
        stripped = line.strip()
        if current is not None:
            body = stripped.lstrip("-*").strip() if stripped[:1] in ("-", "*") else stripped
            if body:
                current["bullets"].append(body)
    if segments:
        out = []
        for seg in segments:
            if not seg["bullets"]:
                continue
            out.extend(_pack_bullets(seg["segmentId"], seg["topic"], seg["bullets"], max_chars))
        return out
    return _split_plain(text, max_chars=max_chars)


def _pack_bullets(segment_id, topic, bullets, max_chars):
    """把同一 segment 的 bullet 打包成若干 ≤max_chars 的段（尽量不切断单条 bullet）。"""
    parts, buf, size = [], [], 0
    for bullet in bullets:
        # 单条 bullet 自己就超限：先单独切碎，避免把整段拖长
        pieces = _chunk_by_lines("- " + bullet, max_chars) if len(bullet) + 2 > max_chars else ["- " + bullet]
        for piece in pieces:
            if size + len(piece) + 1 > max_chars and buf:
                parts.append("\n".join(buf))
                buf, size = [], 0
            buf.append(piece)
            size += len(piece) + 1
    if buf:
        parts.append("\n".join(buf))
    if not parts:
        return []
    out = []
    for idx, body in enumerate(parts, 1):
        out.append({
            "segmentId": segment_id if idx == 1 else f"{segment_id}{PART_SEP}{idx}",
            "topic": topic,
            "bullets": [line.lstrip("- ").strip() for line in body.splitlines()],
            "text": body,
        })
    return out


def _split_plain(text, max_chars=SEGMENT_MAX_CHARS):
    """非 digest 文本：**一个空行块 = 一段**。

    不把多个小块合并成一段：分段是"喂给模型的最小主题单元"，合并不相关主题会让模型
    把两条经验的因素搅在一起（旧规则版就是整篇灌进去，what 全是摘要）。块内超长再按行切。
    """
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text or "") if b.strip()]
    segments = []
    for block in blocks:
        for chunk in _chunk_by_lines(block, max_chars):
            segments.append({
                "segmentId": f"segment_{len(segments) + 1:03d}.md",
                "topic": "",
                "bullets": [chunk],
                "text": chunk,
            })
    return segments


def _chunk_by_lines(block, max_chars):
    """把一个超长块按行切成 ≤max_chars 的若干片（单行本身超长时硬切）。"""
    if len(block) <= max_chars:
        return [block]
    chunks, buf, size = [], [], 0
    for line in block.splitlines():
        while len(line) > max_chars:  # 单行超长：先硬切，避免死循环
            if buf:
                chunks.append("\n".join(buf))
                buf, size = [], 0
            chunks.append(line[:max_chars])
            line = line[max_chars:]
        if size + len(line) + 1 > max_chars and buf:
            chunks.append("\n".join(buf))
            buf, size = [], 0
        buf.append(line)
        size += len(line) + 1
    if buf:
        chunks.append("\n".join(buf))
    return [c for c in chunks if c.strip()]


# ================================================================ 2. 脱敏
SECRET_PATTERNS = (
    # sk- 开头的 API key（本机/云端通用前缀）→ 保留前缀便于识别是"哪把钥匙"
    (re.compile(r"sk-[A-Za-z0-9_\-]{16,}"), "sk-***"),
    # Authorization: Bearer <token>
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{8,}"), "Bearer ***"),
    # password= / password: 明文
    (re.compile(r"(?i)\bpassword\s*[=:]\s*[^\s&;,'\"）)]+"), "password=***"),
    # 中国大陆手机号（前后不能是数字，避免吃掉订单号/时间戳中的片段）
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "***"),
    # 身份证：18 位（末位可为 X）或 15 位老号码
    (re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)"), "***"),
    (re.compile(r"(?<!\d)\d{15}(?!\d)"), "***"),
)


def mask_secrets(text):
    """入库前脱敏。只打这五类；租户名、工单号、表名、行号一律保留。"""
    out = text if isinstance(text, str) else str(text or "")
    for pattern, replacement in SECRET_PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def contains_secret(text):
    """是否含敏感串（单测与告警用；正常路径不需要）。"""
    raw = text if isinstance(text, str) else str(text or "")
    return any(pattern.search(raw) for pattern, _ in SECRET_PATTERNS)


# ================================================================ 3. 证据片段
EXCERPT_MAX_BYTES = 2048
EXCERPT_CONTEXT_LINES = 2
LOG_EDGE_LINES = 3

_COMMAND_PREFIXES = (
    "git ", "python ", "python3 ", "java ", "mvn ", "gradle", "./gradlew",
    "docker ", "kubectl ", "curl ", "redis-cli", "mysql ", "psql ", "node ",
    "npm ", "pnpm ", "pytest", "sp-devops", "sp-jenkins", "sp-gitlab", "sp-yunxiao",
    "$ ", "powershell ", "pwsh ", "fsutil ", "xinfo ", "xadd ", "ssh ", "scp ",
)
_LOG_LINE_RE = re.compile(
    r"(?:^|\s)(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?|"
    r"\d{2}:\d{2}:\d{2}[.,]\d{3}|(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b)"
)
_SQL_RE = re.compile(r"(?is)\b(select\s+.+\s+from|insert\s+into|update\s+\w+\s+set|"
                     r"delete\s+from|show\s+(?:columns|tables|databases)|"
                     r"create\s+table|alter\s+table)\b")
EXCERPT_KINDS = ("quote", "context", "command", "log", "sql")


def detect_kind(text, explicit=None):
    """证据类型判定：显式优先，其次按内容特征猜（顺序：sql → log → command → quote）。"""
    if explicit in EXCERPT_KINDS:
        return explicit
    raw = text if isinstance(text, str) else str(text or "")
    if _SQL_RE.search(raw):
        return "sql"
    lines = [ln for ln in raw.splitlines() if ln.strip()]
    if lines and sum(1 for ln in lines if _LOG_LINE_RE.search(ln)) >= max(1, len(lines) // 2):
        return "log"
    if lines and _looks_like_command(lines[0].strip()):
        return "command"
    return "quote"


def _looks_like_command(line):
    """行首是命令/提示符才算命令。

    不能用"包含"判断：digest 里的说明性 bullet 常常顺带提到 `git add` / `pnpm test`，
    用包含匹配会把整段散文判成 command，证据片段就只剩一两条"像命令"的行（真实素材上
    实测踩到过：一条讲 reparse point 的 bullet 因为提到 `git -C ... add` 被判成 command）。
    """
    stripped = line.strip().lstrip("-*• ").strip()
    low = stripped.lower()
    if not low:
        return False
    if stripped[0] in "$^>":
        return True
    return any(low.startswith(prefix) for prefix in _COMMAND_PREFIXES)


def _is_command_line(line):
    stripped = line.strip()
    if not stripped:
        return False
    if stripped[0] in "$^#>" or stripped.lower().startswith("ps "):
        return True
    return _looks_like_command(stripped)


def _cap_bytes(text, max_bytes):
    """按 UTF-8 字节上限裁剪（不切断多字节字符），返回 (text, truncated)。"""
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text, False
    suffix = "…"
    budget = max(0, max_bytes - len(suffix.encode("utf-8")))
    cut = raw[:budget]
    while cut:
        try:
            return cut.decode("utf-8") + suffix, True
        except UnicodeDecodeError:
            cut = cut[:-1]
    return suffix, True


def build_excerpt(material, hit=None, kind="auto", max_bytes=EXCERPT_MAX_BYTES,
                  context=EXCERPT_CONTEXT_LINES):
    """生成证据片段 `{text, kind, sha256, truncated, lines, hitFound}`。

    - 命中行 ±2 行（`hit` 在素材里定位不到时从头取，并标 `hitFound=False`）
    - 命令类只留命令（丢掉输出噪声）；日志留首尾各 3 行
    - 脱敏 → ≤2KB → sha256（对**脱敏后**的最终文本取，落 excerpts.sha256 才能 CAS 去重）
    """
    raw = material if isinstance(material, str) else str(material or "")
    lines = raw.splitlines()
    kind = detect_kind(raw, None if kind == "auto" else kind)

    hit_found = False
    hit_index = 0
    needle = _norm_text(hit) if hit else ""
    if needle:
        for idx, line in enumerate(lines):
            if needle and needle in _norm_text(line):
                hit_index, hit_found = idx, True
                break

    if kind == "log":
        picked = _pick_log_edges(lines)
    elif kind in ("command", "sql"):
        picked = _pick_command_lines(lines, kind)
        if not picked:  # 猜错类型时退回窗口，不能因为找不到命令就返回空片段
            picked = _window(lines, hit_index, context)
    else:
        picked = _window(lines, hit_index, context)

    text = "\n".join(picked).strip()
    text = mask_secrets(text)
    text, truncated = _cap_bytes(text, max_bytes)
    return {
        "text": text,
        "kind": kind,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "truncated": truncated,
        "lines": text.count("\n") + 1 if text else 0,
        "hitFound": hit_found,
    }


def _window(lines, hit_index, context):
    start = max(0, hit_index - context)
    end = min(len(lines), hit_index + context + 1)
    return [ln for ln in lines[start:end] if ln.strip()]


def _pick_log_edges(lines):
    body = [ln for ln in lines if ln.strip()]
    if len(body) <= LOG_EDGE_LINES * 2:
        return body
    return body[:LOG_EDGE_LINES] + ["…"] + body[-LOG_EDGE_LINES:]


def _pick_command_lines(lines, kind):
    """命令/SQL：只留命令本身（行首提示符去掉），丢掉输出与装饰行。"""
    picked = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if kind == "sql":
            if _SQL_RE.search(stripped):
                picked.append(stripped)
            continue
        if _is_command_line(stripped):
            for marker in ("$ ", "> ", "# "):
                if stripped.startswith(marker):
                    stripped = stripped[len(marker):].strip()
                    break
            picked.append(stripped)
    return picked


# ================================================================ 4. Review
# 词表都放在模块级：单测可以逐个断言"哪条规则拦的"，而不是只看到"被拦了"。
COMMON_SENSE_RE = re.compile(
    r"^(?:遇到问题|遇到复杂问题|注意|小心|多试几次|再试一次|重启一下|多收集上下文|多沟通|"
    r"多看日志|多加日志|仔细检查|充分测试|保持|确保|尽量|建议先了解|总结经验|认真|"
    r"做好备份|注意边界|多看代码|先复现)"
)
USER_PREFERENCE_RE = re.compile(
    r"(我觉得|我认为|我习惯|我倾向|我喜欢|个人认为|个人偏好|建议你|最好先|"
    r"先沟通|多沟通|互相沟通|沟通再动手)"  # 人工标准把它判成「5 用户主观偏好」，故收录
)
DIALOGUE_SUMMARY_RE = re.compile(
    r"(本次|这次|这一轮|随后我|接着我|然后我|接着又|最终我|已经部署|部署到\s*\w+|"
    r"改了\s*\d+\s*个文件|跑了\s*\d+\s*次(?:测试|构建)|共改了)"
)
# 一次性 case 的标记词。v2.1 起**不能再只看标记词**：round1 里「OSS 临时链接」里那个
# "临时"就是这么被误判成一次性 case 的（7 条误拦里唯一一条非长度误拦）。
# 判据改成"标记词命中 **且** 写不出可复用三要素"（见 `reusable_triad`）。
ONE_OFF_RE = re.compile(r"(今天|当天|当下|临时|暂时|这一次|本次|刚才|刚刚)")
# 弱标记：这些词也能当名词定语（临时链接/临时表/暂时字段），三要素齐全时一律不判一次性。
ONE_OFF_WEAK_MARKERS = ("临时", "暂时", "本次")
# 可复用三要素里的"触发条件"信号：when 能指到一个可观测的现象/时点，而不是空条件。
TRIGGER_CUE_RE = re.compile(
    r"(时|后|前|当|出现|发现|收到|看到|报错|报|查不到|为空|失败|超时|不一致|冲突|异常|现象|场景)"
)
GRANULARITY_RE = re.compile(r"\d+\s*(?:笔|元)|共\s*\d+\s*元|涉及\s*\d+\s*(?:笔|元)")
VAGUE_REF_RE = re.compile(r"(这一块|那个地方|这块|那处|相关代码|某个地方)")
# what 里必须能读出一个"下一步动作"。这里宁可宽松（多列常见动词）也不要严：
# ⑧「不可执行」只该拦真正空的套话，误拦一条好经验比漏掉一条垃圾代价大得多。
ACTION_VERBS = (
    "查", "比对", "对比", "确认", "核对", "复核", "改", "替换", "删", "清", "重算", "重放",
    "投递", "投", "读", "看", "用", "走", "按", "准备", "执行", "核验", "检查", "调",
    "保留", "合并", "回滚", "补录", "理解", "禁止", "避免", "先", "要", "需", "让",
    "分析", "评估", "判断", "区分", "优先", "同步", "拆", "分", "排序", "挂", "加", "减",
    "写", "配", "启", "停", "换", "切", "拉", "推", "建", "开", "关",
)
ACTION_VERB_RE = re.compile("(?:" + "|".join(sorted(ACTION_VERBS, key=len, reverse=True)) + ")")
CONCRETE_ANCHOR_RE = re.compile(
    r"([a-z]+_[a-z_]+|[A-Z][A-Za-z0-9]{2,}|[A-Z]+-\d+|\d{4,}|`[^`]+`|/[\w./-]+|"
    r"--?[a-z-]{2,}|\b(?:select|update|insert|delete|xadd|xinfo|xlen)\b)"
)
# 源码存在性断言：只有这种语气才允许把"符号不存在"升级成"事实性错误"
EXISTENCE_CLAIM_RE = re.compile(r"(该类存在|此类存在|存在该类|存在于|在此仓库|在本仓库|位于此仓库|项目中存在|仓库里有)")

SYMBOL_RE = re.compile(
    r"\b([A-Z][A-Za-z0-9]{2,}(?:ServiceImpl|Service|Controller|Mapper|Dao|DAO|Util|Utils|"
    r"DTO|Enum|Model|Task|Impl))\b"
)

# skill 已覆盖的团队规范：命中说明"该留在 skill，不该进经验库"（redundancy，不是垃圾）
SKILL_COVERED_RE = re.compile(
    r"(只推个人\s*fork|不(?:要)?直推\s*origin|不要直推\s*origin|先推\s*fork|"
    r"提交前先跑\s*CI|回写云效|按\s*yunxiao\s*流程)"
)

# ---------------------------------------------------------------- 堆补丁启发式（S1 事实性错误）
# round1 唯一被放行的真垃圾是「超时就调大超时参数」——它的根因是 reasoning 吃光预算，
# 调大超时只会让失败更晚发生。这类"把调参当结论"的写法一律按事实性错误拦；
# 只要句子里写出了机制/根因（因为/根因/原因是/机制…），就说明它在讲机理，放过。
PATCH_FIX_RE = re.compile(
    r"(调大|调高|放大|加大|增加|提高|拉长|放宽)\s*(?:一下)?\s*"
    r"(?:超时时间|超时|重试次数|重试|线程数|线程|内存|堆|参数|阈值|连接池|并发)"
)
ROOT_CAUSE_RE = re.compile(r"(根因|因为|原因是|机制|由于|本质|其实|真正原因|为什么|会失效|失效原因)")

# ---------------------------------------------------------------- lens 自洽性（v2.1）
# round1 Category(lens) Acc 只有 50%（3/6），错法集中在"位置不可发现"被判成 logic。
# prompt 里已写死判定顺序（黑话 → 位置 → 约束），这里做一次兜底纠正：只纠正形态明显冲突的，
# 纠正结果记 `lens-coerced:*` warning 并保留原值（`lensOriginal`），不拦候选。
LOOKUP_PREFIX_RE = re.compile(r"^(?:查|查询|查找|去查|先查|核对|确认位置|定位|改用|换成|用|在)")
LOCATION_CUE_RE = re.compile(
    r"([a-z][a-z0-9]*_[a-z0-9_]+|[A-Z][A-Za-z0-9]{2,}|表|环境|目录|路径|topic|日志|jar|"
    r"classpath|字段|参数|端口|env=|-d\b)"
)
JARGON_CUE_RE = re.compile(r"(「|」|『|』|黑话|代称|缩写|术语|俗称|内部叫)")
CONSTRAINT_RE = re.compile(r"(必须|不能|不要|禁止|否则)")


def _trim_text(text, limit):
    """超长**只截断不拦**：优先在标点处断开（尽量保住语义），返回 `(text, changed)`。

    v2.1 的口径：长度与"粒度混用"没有因果关系，round1 的 7 条误拦里 6 条死在
    `what>90 / when>70` 硬阈值上（含黄金 #11/#13）。所以长度只用来做截断上限。
    """
    text = text if isinstance(text, str) else str(text or "")
    if not text or limit <= 0 or len(text) <= limit:
        return text, False
    head = text[: max(0, limit - 1)]
    cut = -1
    for i in range(len(head) - 1, int(len(head) * 0.6), -1):
        if head[i] in "；;。，,、：: ":
            cut = i
            break
    if cut > 0:
        return head[:cut] + "…", True
    return head + "…", True


def reusable_triad(candidate):
    """判「可复用三要素」：触发条件 + 动作/锚点 + 机制。

    一次性 case 的本质是"换场景就不成立"，不是"句子里出现了时间词"。
    round1 真实误拦「收到 OSS 临时链接后立即下载到本地」三要素齐全（有触发、有动作、有机制），
    只是把"临时"当定语用，按标记词一刀切必然误伤。
    """
    cand = candidate or {}
    what = str(cand.get("what") or "")
    when = str(cand.get("when_expr") or "")
    why = str(cand.get("why") or "")
    trigger = bool(TRIGGER_CUE_RE.search(when)) or bool(CONCRETE_ANCHOR_RE.search(when))
    action = bool(ACTION_VERB_RE.search(what)) or bool(CONCRETE_ANCHOR_RE.search(what))
    mechanism = len(why) >= 8 and similarity(what, why) <= SIM_WHAT_WHY
    return {"trigger": trigger, "action": action, "mechanism": mechanism,
            "complete": bool(trigger and action and mechanism)}


def patch_fix_signal(candidate):
    """堆补丁信号：`调大/加大/增加… + 超时/重试/线程/内存/参数` 且**没有**根因词。

    返回命中的 `Match` 或 None。命中即判 `garbage-1-factual-error`。
    """
    cand = candidate or {}
    blob = " ".join(str(cand.get(k) or "") for k in ("what", "why"))
    m = PATCH_FIX_RE.search(blob)
    if not m:
        return None
    if ROOT_CAUSE_RE.search(blob):
        return None
    return m


def coerce_lens(candidate):
    """lens 与 what 形态的自洽性纠正。返回 `(lens, detail)`；无需纠正时 detail 为空串。

    只处理两类明显冲突（其余交给 prompt 的判定顺序）：
    - what 是"去哪找"形态（查/核对/用 + 表/类/环境/命令等位置线索）却判 `logic` → `index`；
    - 判 `jargon` 但既无黑话标记（「」/黑话/代称…）又在讲约束 → `logic`。
    """
    cand = candidate or {}
    what = str(cand.get("what") or "")
    lens = str(cand.get("lens") or "").strip().lower()
    reason = str(cand.get("lens_reason") or cand.get("lensReason") or "").strip()
    if lens == "logic" and LOOKUP_PREFIX_RE.match(what) and LOCATION_CUE_RE.search(what):
        return "index", "lens-coerced:logic->index（what 是「去哪找」形态）"
    if lens == "jargon" and not JARGON_CUE_RE.search(what + " " + reason) \
            and CONSTRAINT_RE.search(what):
        return "logic", "lens-coerced:jargon->logic（无黑话标记，实为约束）"
    return lens, ""

DEFAULT_CATEGORY = "business"
# 模型偶尔漏填 category：按关键词兜底（只影响落库字段，不参与质量判定）
_CATEGORY_HINTS = (
    ("tool", re.compile(r"(构建|编译|gradle|maven|java_home|git bash|msys|devops|redis|xadd|xinfo|"
                        r"查库|查日志|命令行|部署环境|jenkins|nexus|端口|脚本)")),
    ("repo", re.compile(r"(分支|仓库|移植|cherry-pick|merge|rebase|tag|发版|release|mr|commit|索引)")),
    ("debug", re.compile(r"(故障|报错|异常|查不到|修复|数据|结余|重放|分区|租户|日志|超时|定位)")),
)


def infer_category(candidate):
    """category 缺省时的关键词兜底；命中不了就当 business（最保守）。"""
    haystack = " ".join(str(candidate.get(k) or "") for k in ("what", "when_expr", "why"))
    for name, pattern in _CATEGORY_HINTS:
        if pattern.search(haystack):
            return name
    return DEFAULT_CATEGORY


def default_policy(**overrides):
    """Review 阈值集中一处：单测可只覆盖某一项，不必重写整套规则。

    `what_max/when_max/why_max` 在 v2.1 起是**截断上限**，不是拦截条件
    （`trim_overflow=False` 可关掉截断，用于对照 round1 的硬拦口径）。
    """
    policy = {
        "what_max": WHAT_MAX,
        "when_max": WHEN_MAX,
        "why_max": WHY_MAX,
        "when_min": WHEN_MIN,
        "sim_what_why": SIM_WHAT_WHY,
        "verify_symbols": True,
        "check_skill_covered": True,
        # v2.1：超长只截断 + warnings=['trimmed']，不再判垃圾
        "trim_overflow": True,
        # v2.1：一次性 case 只有"标记词命中 且 可复用三要素不全"才成立
        "one_off_requires_triad": True,
        # v2.1：lens 与 what 形态自洽性纠正（只改判，不拦）
        "coerce_lens": True,
        # v2.1：堆补丁启发式（「调大超时」这类把调参当结论的写法按事实性错误拦）
        "check_patch_fix": True,
        # v2.1：二级退化（失败/截断 → 更小分段 + 更宽输出预算，重试一次）
        "degrade_chars": DEGRADE_CHARS,
        "degrade_timeout_ms": DEGRADE_TIMEOUT_MS,
        "degrade_max_tokens": DEGRADE_MAX_TOKENS,
        "degrade_max_parts": DEGRADE_MAX_PARTS,
    }
    policy.update(overrides)
    return policy


def review_candidate(candidate, policy=None, symbol_lookup=None):
    """定向过滤。返回 `{ok, reason, detail, garbage, skillCovered, warnings}`。

    顺序有讲究：**先判 process/skill-covered**（redundancy 不该被记成垃圾），
    再判字段合法性，最后按"信息量从高到低"逐条判垃圾——这样最终 reason 是
    最具体的那条，而不是被后面的弱规则抢先。

    v2.1 起**超长不再拦**：越界只截断（候选原地改短）并记 `warnings=['trimmed']`。
    `verdict['warnings']` 是软标记，不进 `reasons` 统计、不影响垃圾率。
    """
    policy = policy or default_policy()
    cand = candidate or {}
    what = str(cand.get("what") or "").strip()
    when = str(cand.get("when_expr") or "").strip()
    why = str(cand.get("why") or "").strip()
    lens = str(cand.get("lens") or "").strip()
    category = str(cand.get("category") or "").strip()
    audit = cand.get("audit") or {}
    warnings = []

    def block(reason, detail=""):
        return {
            "ok": False,
            "reason": reason,
            "detail": detail,
            "garbage": exp_prompt.is_garbage_reason(reason),
            "skillCovered": reason == PROCESS_REJECT_REASON,
            "warnings": list(warnings),
        }

    def ok_(detail=""):
        return {"ok": True, "reason": "", "detail": detail, "garbage": False,
                "skillCovered": False, "warnings": list(warnings)}

    # ① process 拒收（不是垃圾，是 redundancy）
    if category == REJECTED_CATEGORY:
        return block(PROCESS_REJECT_REASON, "category=process（交付流程由 skill 覆盖）")
    if policy.get("check_skill_covered") and SKILL_COVERED_RE.search(what):
        return block(PROCESS_REJECT_REASON, "命中 skill 已覆盖的团队规范（重复入库无收益）")

    # ② 字段合法性
    if not what or not when or not why:
        return block(REASON_INVALID, "缺 what/when/why")
    if lens not in exp_prompt.LENSES:
        return block(REASON_INVALID, f"lens 非法：{lens!r}")
    if category and category not in CATEGORIES:
        return block(REASON_INVALID, f"category 非法：{category!r}")

    # ②' lens 自洽性纠正（只改判 + 记 warning，不拦）
    if policy.get("coerce_lens", True):
        fixed, lens_detail = coerce_lens(cand)
        if fixed != lens:
            cand["lensOriginal"] = lens
            cand["lens"] = fixed
            lens = fixed
            warnings.append(lens_detail)

    # ③ 超长：**只截断不判垃圾**
    #    round1 的 7 条误拦里 6 条死在长度硬阈值上（含黄金 #11/#13）；粒度混用另有
    #    内容判据（⑩ GRANULARITY_RE：what 里出现金额/笔数），长度与它没有因果关系。
    if policy.get("trim_overflow", True):
        trimmed = {}
        for field, key in (("what", "what_max"), ("when_expr", "when_max"), ("why", "why_max")):
            value = str(cand.get(field) or "").strip()
            short, changed = _trim_text(value, policy[key])
            if not changed:
                continue
            cand[field] = short
            trimmed[field] = [len(value), len(short)]
            if field == "what":
                what = short
            elif field == "when_expr":
                when = short
            else:
                why = short
        if trimmed:
            cand["trimWarnings"] = trimmed
            if isinstance(cand.get("audit"), dict):
                cand["audit"]["trimmed"] = True
            warnings.append("trimmed:" + ",".join(
                f"{k}:{v[0]}->{v[1]}" for k, v in sorted(trimmed.items())))

    # ④ what 与 why 重复 = 没提炼
    sim = similarity(what, why)
    if sim > policy["sim_what_why"]:
        return block(REASON_UNREFINED, f"what≈why 相似度 {sim:.3f}>{policy['sim_what_why']}")

    # ⑤ when 不可判定
    if len(when) < policy["when_min"]:
        return block(REASON_GARBAGE["missing-context"], f"when 仅 {len(when)} 字（<{policy['when_min']}，无法判定触发）")
    if VAGUE_REF_RE.search(when):
        return block(REASON_GARBAGE["missing-context"], f"when 指代不明：{VAGUE_REF_RE.search(when).group(0)}")

    # ⑥ 通用常识
    hit = COMMON_SENSE_RE.match(what)
    if hit:
        return block(REASON_GARBAGE["common-sense"], f"通用常识前缀：{hit.group(0)}")

    # ⑦ 用户主观偏好
    hit = USER_PREFERENCE_RE.search(what + " " + why)
    if hit:
        return block(REASON_GARBAGE["user-preference"], f"主观偏好：{hit.group(0)}")

    # ⑧ 对话摘要（过程录像）
    hit = DIALOGUE_SUMMARY_RE.search(what)
    if hit:
        return block(REASON_GARBAGE["dialogue-summary"], f"只复述过程：{hit.group(0)}")

    # ⑨ 一次性 case：标记词命中 **且** 可复用三要素不齐才拦
    #    v2.1：「OSS 临时链接」的"临时"是三要素齐全的经验里的定语，不能当 case 标记
    hit = ONE_OFF_RE.search(when) or ONE_OFF_RE.search(what)
    if hit:
        triad = reusable_triad(cand)
        if policy.get("one_off_requires_triad", True) \
                and hit.group(0) in ONE_OFF_WEAK_MARKERS and triad["complete"]:
            hit = None
        if hit:
            missing = "、".join(k for k in ("trigger", "action", "mechanism") if not triad[k])
            return block(REASON_GARBAGE["one-off"],
                         f"一次性标记：{hit.group(0)}（可复用三要素缺 {missing or '无'}）")

    # ⑩ 粒度混用（业务明细写进 what，应降级到 evidence）——**按内容判，不按长度判**
    hit = GRANULARITY_RE.search(what)
    if hit:
        return block(REASON_GARBAGE["mixed-granularity"], f"case 明细进 what：{hit.group(0)}")

    # ⑪ 堆补丁式事实性错误（S1）：把"调大参数"当结论，且写不出根因
    #    round1 唯一被放行的真垃圾「超时就调大超时参数」就是这一形态
    if policy.get("check_patch_fix", True):
        hit = patch_fix_signal(cand)
        if hit:
            return block(REASON_GARBAGE["factual-error"],
                         f"堆补丁当结论：{hit.group(0)}（无根因/机制）")

    # ⑫ 不可执行：既无动作动词，也无任何具体锚点（表名/符号/路径/命令）
    if not ACTION_VERB_RE.search(what) and not CONCRETE_ANCHOR_RE.search(what):
        return block(REASON_GARBAGE["not-actionable"], "what 无动作动词也无具体锚点")

    # ⑬ 证据不足（硬门：缺 evidence_quote 一律拦）
    quote = str(audit.get("evidence_quote") or "").strip()
    if not quote:
        return block(REASON_GARBAGE["no-evidence"], "audit.evidence_quote 为空")

    # ⑭ 源码探索事实校验：不存在只标 unverified，只有"断言存在"才拦
    if policy.get("verify_symbols") and symbol_lookup is not None:
        verdict = verify_symbols(cand, symbol_lookup)
        if verdict["claimedMissing"]:
            return block(
                REASON_GARBAGE["factual-error"],
                "断言存在但源码索引未找到：" + "、".join(verdict["claimedMissing"]),
            )
        if verdict["unverified"]:
            if not isinstance(cand.get("audit"), dict):
                cand["audit"] = {}
            cand["audit"]["unverified"] = True
            cand["audit"]["unverifiedSymbols"] = verdict["unverified"]
        return ok_(f"unverified={verdict['unverified']}" if verdict["unverified"] else "")

    return ok_()


def verify_symbols(candidate, symbol_lookup):
    """用源码索引核验候选里提到的类/方法名（冻结决策 5）。

    跨仓符号必然假阴性（`StorePersistenceComputeImpl` 属 stock 仓），所以**默认只标
    `unverified` 不拦**；只有 `lens=index`（在讲"东西在哪"）并且明确断言"存在/在此仓库"时，
    才升级成事实性错误——那种情况下符号不存在就是结论错了。
    """
    cand = candidate or {}
    text = f"{cand.get('what') or ''} {cand.get('why') or ''}"
    symbols = []
    for sym in SYMBOL_RE.findall(text):
        if sym not in symbols:
            symbols.append(sym)
    unverified, claimed_missing = [], []
    asserts_existence = bool(EXISTENCE_CLAIM_RE.search(text))
    lens = str(cand.get("lens") or "")
    for sym in symbols:
        try:
            found = bool(symbol_lookup(sym))
        except Exception:  # noqa: BLE001 - 索引不可用不该拦经验
            found = True
        if found:
            continue
        unverified.append(sym)
        if lens == "index" and asserts_existence:
            claimed_missing.append(sym)
    return {
        "symbols": symbols,
        "unverified": unverified,
        "claimedMissing": claimed_missing,
        "assertsExistence": asserts_existence,
    }


# ================================================================ 5. Dedup
def dedup_candidates(candidates, what_threshold=DEDUP_WHAT, when_threshold=DEDUP_WHEN):
    """宁严勿宽 + 禁止桥接。返回 `{kept, merged, pairs}`。

    关键点是"只与代表项比较"：B 并进 A 之后代表项仍然是 A，C 只和 A 比。
    如果改成"和 A∪B 的合并文本比"，就会一路传递把整条语义链并成一条，
    三条经验的边界条件全部丢失（golden §六 明确禁止）。
    """
    kept, merged, pairs = [], [], []
    for cand in candidates or []:
        target = None
        for rep in kept:
            what_sim = similarity(cand.get("what"), rep.get("what"))
            when_sim = similarity(cand.get("when_expr"), rep.get("when_expr"))
            pairs.append({"what": round(what_sim, 4), "when": round(when_sim, 4)})
            if what_sim > what_threshold and when_sim > when_threshold:
                target = rep
                break
        if target is None:
            kept.append(cand)
            continue
        target.setdefault("mergedFrom", []).append({
            "what": cand.get("what"),
            "evidence_issue": cand.get("evidence_issue"),
            "reason": f"what={similarity(cand.get('what'), target.get('what')):.3f} "
                      f"when={similarity(cand.get('when_expr'), target.get('when_expr')):.3f}",
        })
        merged.append({"into": len(kept) - 1, "candidate": cand})
    return {"kept": kept, "merged": merged, "pairs": pairs}


# ================================================================ 6. Merge
def _negated(text):
    return bool(re.search(r"(不要|禁止|别|不能|不可|切勿|避免|never|do not|don't|禁止使用)", text or "", re.I))


def _evidence_set(memory):
    """已入库条目承载的证据文本集合（来自 audit.evidence_quote 与 excerpts）。"""
    quotes = set()
    audit = memory.get("audit") or {}
    quote = str(audit.get("evidence_quote") or "").strip()
    if quote:
        quotes.add(_norm_text(quote))
    for exc in memory.get("excerpts") or []:
        if isinstance(exc, dict):
            text = exc.get("text") or exc.get("evidence_quote")
        else:
            text = exc
        if text:
            quotes.add(_norm_text(text))
    return {q for q in quotes if q}


def _coverage_ratio(quote, target_text):
    """候选证据被已有条目覆盖的比例（子串命中算全中，否则按 bigram 相似度）。"""
    needle = _norm_text(quote)
    if not needle:
        return 0.0
    haystack = _norm_text(target_text)
    if needle and needle in haystack:
        return 1.0
    return similarity(needle, haystack)


def analyze_merge(candidate, existing, what_threshold=MERGE_SAME_WHAT,
                  opposite_threshold=MERGE_OPPOSITE_WHAT, coverage_threshold=0.85):
    """唯一目标前置的合并判定。返回 `{action, target, reason, candidates}`。

    - `create`：没有同向目标，或同向目标**不唯一**（歧义时宁可新建，也不猜）
    - `skip`：唯一同向目标已覆盖这条的证据与结论
    - `update`：唯一同向目标存在，但这条带来了新证据/更完整的机制
    - `contradict`：唯一同向目标方向相反（否定极性相反）→ 写 conflicts 走人工
    """
    cand = candidate or {}
    related, opposite, same = [], [], []
    for mem in existing or []:
        what_sim = similarity(cand.get("what"), mem.get("what"))
        if what_sim < min(what_threshold, opposite_threshold):
            continue
        related.append({"memory": mem, "whatSim": what_sim})
        flipped = _negated(cand.get("what")) != _negated(mem.get("what"))
        if flipped and what_sim >= opposite_threshold:
            opposite.append({"memory": mem, "whatSim": what_sim})
        elif what_sim >= what_threshold:
            same.append({"memory": mem, "whatSim": what_sim})

    if len(opposite) == 1:
        return {
            "action": "contradict",
            "target": opposite[0]["memory"],
            "reason": f"方向相反（what 相似 {opposite[0]['whatSim']:.3f}，否定极性相反）",
            "candidates": [r["memory"] for r in opposite],
        }
    if len(opposite) > 1:
        return {"action": "create", "target": None,
                "reason": f"相反方向目标不唯一（{len(opposite)} 个）", "candidates": [r["memory"] for r in opposite]}
    if len(same) > 1:
        return {"action": "create", "target": None,
                "reason": f"同向目标不唯一（{len(same)} 个），不猜", "candidates": [r["memory"] for r in same]}
    if not same:
        return {"action": "create", "target": None, "reason": "无同向目标", "candidates": []}

    target = same[0]["memory"]
    quote = str((cand.get("audit") or {}).get("evidence_quote") or "").strip()
    covered = False
    if quote:
        for known in _evidence_set(target):
            if _coverage_ratio(quote, known) >= coverage_threshold:
                covered = True
                break
    new_why = len(str(cand.get("why") or "")) > len(str(target.get("why") or "")) * 1.15
    if covered and not new_why:
        return {"action": "skip", "target": target,
                "reason": "同向目标已覆盖该证据与结论", "candidates": [target]}
    return {"action": "update", "target": target,
            "reason": "同向目标存在但有新证据/更完整机制", "candidates": [target]}


# ================================================================ 7. 候选规范化
def fingerprint(candidate):
    """幂等键：sha1(category|workflow|lens|what)（与 schema-v2 `memories.fingerprint` 一致）。"""
    cand = candidate or {}
    raw = "|".join([
        str(cand.get("category") or ""),
        str(cand.get("workflow") or ""),
        str(cand.get("lens") or ""),
        _norm_text(cand.get("what")),
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def normalize_candidate(raw, *, policy=None, segment_id=None, source="llm", workflow=None, repo=None):
    """把模型输出规整成落库候选 dict（字段名对齐 schema-v2 `memories` 列）。"""
    cand = dict(raw or {})
    audit = cand.get("audit") if isinstance(cand.get("audit"), dict) else {}
    category = str(cand.get("category") or "").strip().lower()
    category_inferred = False
    if not category or category in ("", "none", "null"):
        category = infer_category(cand)
        category_inferred = True
    out = {
        "what": str(cand.get("what") or "").strip(),
        "when_expr": str(cand.get("when_expr") or cand.get("when") or "").strip(),
        "why": str(cand.get("why") or "").strip(),
        "lens": str(cand.get("lens") or "").strip().lower(),
        # v2.1：模型自述的镜头理由（Review 用它做 lens 自洽性校验；不参与落库判据）
        "lens_reason": str(cand.get("lens_reason") or cand.get("lensReason") or "").strip(),
        "category": category,
        "workflow": workflow or cand.get("workflow"),
        "repo": repo or cand.get("repo"),
        "evidence_issue": str(cand.get("evidence_issue") or "").strip(),
        "audit": {
            "reusable_because": str(audit.get("reusable_because") or "").strip(),
            "exclusions": str(audit.get("exclusions") or "").strip(),
            "evidence_quote": str(audit.get("evidence_quote") or "").strip(),
            "prompt_version": (policy or {}).get("prompt_version") or PROMPT_VERSION,
        },
        "source": source,
        "segment_id": segment_id,
        "category_inferred": category_inferred,
    }
    out["fingerprint"] = fingerprint(out)
    return out


# ================================================================ 8. 管道
class _NullLLM:
    """没有模型时的占位（dry-run 只跑切分与统计口径）。"""

    model = "none"

    def extract_json_array(self, material, **kwargs):  # noqa: ARG002
        return {"content": "[]", "entries": [], "usage": {"tokensIn": 0, "tokensOut": 0,
                                                          "tokensTotal": 0, "reasoningTokens": 0},
                "attempts": 0, "ms": 0, "warning": None}


def run_pipeline(material, llm=None, *, policy=None, search_memories=None, symbol_lookup=None,
                 session_id=None, mode="server", workflow=None, repo=None, model=None,
                 with_excerpt=True, dry_run=False, max_chars=SEGMENT_MAX_CHARS):
    """跑完整管道，返回可观测结果（本函数不写任何库）。

    注入点：
      `llm.extract_json_array(material, max_tokens=...) -> {entries, usage, ...}`
      `search_memories(candidate) -> list[dict]`   合并判定的"已有同向条目"
      `symbol_lookup(symbol_name) -> bool`         源码索引核验

    `dry_run=True` 时不调用 `search_memories`，合并动作全部记 create（未接库时的安全默认）。
    `max_chars` 是单段上限（默认 800）：太长会触发 truncated/超时，太短会把一条经验拆散。
    """
    policy = {**default_policy(), **(policy or {})}
    llm = llm or _NullLLM()
    tokens_in = tokens_out = total_ms = 0
    segments_out, blocked_all, kept_all, created, updated, skipped, contradictions = [], [], [], [], [], [], []
    reasons, errors, warnings = {}, [], []
    failed_segments = 0
    truncated_segments = 0

    segments = split_segments(material, max_chars=max_chars)
    degraded_segments = 0

    def _extract(text, timeout_ms=None, max_tokens=None):
        """调一次抽取；`timeout_ms`/`max_tokens` 只在退化重试时传（替身会忽略 kwargs）。"""
        kwargs = {}
        if timeout_ms is not None:
            kwargs["timeout_ms"] = timeout_ms
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if not kwargs:
            return llm.extract_json_array(text)
        try:
            return llm.extract_json_array(text, **kwargs)
        except TypeError:  # 替身模型 / 老签名不支持这些 kwargs
            return llm.extract_json_array(text)

    def _degrade(seg):
        """二级退化：失败或截断 → 切 ≤degrade_chars 的小段**重试一次**。

        返回 `{entries, usage, parts, okParts, failed, truncated}`。
        小段的产出与大段取**并集**：截断时大段已抽出的前半部分不能丢，
        失败时大段本来就是空的。单次硬截止收紧到 `degrade_timeout_ms`，
        输出预算放宽到 `degrade_max_tokens`（reasoning 吃光 8000 的那类 bad-json 靠它救回）。
        """
        parts = split_segments(seg["text"], max_chars=policy["degrade_chars"])
        parts = parts[: max(1, int(policy["degrade_max_parts"]))]
        out = {"entries": [], "usage": {"tokensIn": 0, "tokensOut": 0, "tokensTotal": 0,
                                        "reasoningTokens": 0},
               "parts": len(parts), "okParts": 0, "failed": 0, "truncated": 0}
        for part in parts:
            try:
                resp = _extract(part["text"], timeout_ms=policy["degrade_timeout_ms"],
                                max_tokens=policy.get("degrade_max_tokens"))
            except Exception:  # noqa: BLE001 - 退化也失败：交由调用方保留首次失败的计数
                out["failed"] += 1
                continue
            out["okParts"] += 1
            out["entries"].extend((resp or {}).get("entries") or [])
            usage = (resp or {}).get("usage") or {}
            for key in out["usage"]:
                out["usage"][key] += int(usage.get(key) or 0)
            if (resp or {}).get("warning") == WARN_TRUNCATED:
                out["truncated"] += 1
        return out

    for seg in segments:
        seg_entry = {"segmentId": seg["segmentId"], "topic": seg.get("topic", ""),
                     "candidates": 0, "blocked": 0, "kept": 0}
        response, first_error = None, None
        try:
            response = _extract(seg["text"])
        except Exception as exc:  # noqa: BLE001 - 单段失败不影响其它段
            first_error = exc

        primary_truncated = (response or {}).get("warning") == WARN_TRUNCATED
        # 二级退化：只对"失败"或"截断"的段做，且该段本身要够长（否则切不动）
        if (first_error is not None or primary_truncated) \
                and policy.get("degrade_chars") and len(seg["text"]) > int(policy["degrade_chars"]):
            primary_reason = getattr(first_error, "reason", "") if first_error else ""
            degraded = _degrade(seg)
            degraded_segments += 1
            seg_entry["degraded"] = True
            seg_entry["degradedParts"] = degraded["parts"]
            if degraded["okParts"]:
                merged = [dict(e) for e in ((response or {}).get("entries") or [])]
                merged.extend(degraded["entries"])
                # token 账要算全：首次调用的 usage 不能因为退化成功就被丢掉
                primary_usage = (response or {}).get("usage") or {}
                usage_sum = {k: int(primary_usage.get(k) or 0) + int(degraded["usage"].get(k) or 0)
                             for k in degraded["usage"]}
                response = {
                    "entries": merged,
                    "usage": usage_sum,
                    "ms": int((response or {}).get("ms") or 0),
                    # 退化成功 = 不再算 failed；只有小段也全被截断时才仍记 truncated
                    "warning": WARN_TRUNCATED if degraded["truncated"] else None,
                }
                first_error = None
                msg = f"二级退化成功：{degraded['parts']} 小段"
                if degraded["truncated"]:
                    msg += "（仍截断）"
                if primary_reason:
                    msg += f"；原失败原因 {primary_reason}"
                warnings.append({"segmentId": seg["segmentId"], "warning": DEGRADE_WARNING,
                                 "message": msg})
            else:
                seg_entry["degradedFailed"] = True
                if first_error is None:
                    first_error = RuntimeError("degraded retry failed")
        if first_error is not None:
            failed_segments += 1
            errors.append({"segmentId": seg["segmentId"], "stage": "extract",
                           "reason": getattr(first_error, "reason", "error"),
                           "message": str(first_error)[:300]})
            reasons["extract-failed"] = reasons.get("extract-failed", 0) + 1
            segments_out.append(seg_entry)
            continue
        usage = (response or {}).get("usage") or {}
        tokens_in += int(usage.get("tokensIn") or 0)
        tokens_out += int(usage.get("tokensOut") or 0)
        total_ms += int((response or {}).get("ms") or 0)
        if (response or {}).get("warning"):
            # warning 不是垃圾原因（reasons 只记拦截计数），单独一栏给运维看；
            # truncated 必须单独计数：被截断的那一段只抽出了前半部分经验，不能当"本来就只有这些"
            warnings.append({"segmentId": seg["segmentId"], "warning": response["warning"],
                             "message": f"模型返回 warning={response['warning']}"})
            if response["warning"] == "truncated":
                truncated_segments += 1
                seg_entry["truncated"] = True

        passed = []
        for raw in (response or {}).get("entries") or []:
            cand = normalize_candidate(raw, policy=policy, segment_id=seg["segmentId"],
                                       source=f"llm:{session_id or 'local'}",
                                       workflow=workflow, repo=repo)
            verdict = review_candidate(cand, policy=policy, symbol_lookup=symbol_lookup)
            seg_entry["candidates"] += 1
            if not verdict["ok"]:
                seg_entry["blocked"] += 1
                reasons[verdict["reason"]] = reasons.get(verdict["reason"], 0) + 1
                blocked_all.append({"candidate": cand, "reason": verdict["reason"],
                                    "detail": verdict["detail"],
                                    "skillCovered": verdict["skillCovered"],
                                    "segmentId": seg["segmentId"]})
                continue
            if with_excerpt:
                cand["excerpt"] = build_excerpt(seg["text"], hit=cand["audit"]["evidence_quote"])
            passed.append(cand)

        dedup = dedup_candidates(passed)
        for cand in dedup["kept"]:
            action = "create"
            target = None
            if not dry_run and search_memories is not None:
                try:
                    decision = analyze_merge(cand, search_memories(cand) or [])
                except Exception as exc:  # noqa: BLE001 - 查库失败按 create 处理并留痕
                    errors.append({"segmentId": seg["segmentId"], "stage": "merge",
                                   "reason": "search-failed", "message": str(exc)[:200]})
                    decision = {"action": "create", "target": None, "reason": "search-failed"}
                action, target = decision["action"], decision.get("target")
                cand["mergeReason"] = decision["reason"]
            cand["mergeAction"] = action
            if action == "skip":
                skipped.append({"candidate": cand, "target": target})
                continue
            if action == "contradict":
                contradictions.append({"candidate": cand, "target": target})
                continue
            if action == "update":
                updated.append({"candidate": cand, "target": target})
            else:
                created.append(cand)
            kept_all.append(cand)
            seg_entry["kept"] += 1
        segments_out.append(seg_entry)

    candidates_total = sum(s["candidates"] for s in segments_out)
    blocked_total = len(blocked_all)
    garbage_blocked = sum(1 for b in blocked_all if b["reason"] not in exp_prompt.NON_GARBAGE_REASONS)
    skill_covered = sum(1 for b in blocked_all if b["reason"] == PROCESS_REJECT_REASON)
    # 失败/截断要能一句话落进 exp_jobs.error：服务端直接写这个字符串，不用自己拼。
    # 被截断不等于失败（已抽出的候选仍然有效），但必须留痕，否则"这次只出了 2 条"永远查不出原因。
    error_parts = []
    if failed_segments:
        error_parts.append(f"extract-failed:{failed_segments}/{len(segments)}")
    if truncated_segments:
        error_parts.append(f"truncated:{truncated_segments}/{len(segments)}")
    other_warnings = [w["warning"] for w in warnings if w["warning"] != "truncated"]
    if other_warnings:
        error_parts.append("warning:" + ",".join(sorted(set(other_warnings))))
    job = {
        "session_id": session_id,
        "mode": mode,
        "status": "failed" if segments and failed_segments == len(segments) else "done",
        "model": model or getattr(llm, "model", None),
        "prompt_version": (policy or {}).get("prompt_version") or PROMPT_VERSION,
        "segments": len(segments),
        "failed_segments": failed_segments,
        "truncated": truncated_segments,
        # v2.1 二级退化：有多少段走了"更小分段重试一次"（成功的不再计入 failed/truncated）
        "degraded_segments": degraded_segments,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "ms": total_ms,
        "candidates": candidates_total,
        "blocked": blocked_total,
        "created_n": len(created),
        "updated_n": len(updated),
        "skipped_n": len(skipped),
        "contradicted_n": len(contradictions),
        "garbage_blocked": garbage_blocked,
        "skill_covered": skill_covered,
        # 垃圾率的分母是**候选数**，分子只算真垃圾（skill-covered 不算垃圾）
        "garbage_rate": round(garbage_blocked / candidates_total, 4) if candidates_total else 0.0,
        "reasons": reasons,
        # 直接落 exp_jobs.error（None = 无异常；truncated/failed 都会出现在这里）
        "error": "; ".join(error_parts) or None,
    }
    return {
        "job": job,
        "segments": segments_out,
        "candidates": kept_all,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "contradictions": contradictions,
        "blocked": blocked_all,
        "errors": errors,
        "warnings": warnings,
    }


# ================================================================ 9. 源码索引（可选）
def make_code_index_lookup(paths):
    """构造 `symbol_lookup(name) -> bool`：只读打开 code-index 的 `symbols` 表。

    索引库路径由调用方给（本机 erp-pos / dsh-plugins 各一份）；库不存在时返回
    "永远查不到"的 lookup —— 调用方会把它当成 unverified，不会误拦经验。
    """
    import sqlite3

    existing = [p for p in paths or [] if p]
    cache = {}

    def lookup(name):
        if name in cache:
            return cache[name]
        for path in existing:
            try:
                con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
                try:
                    row = con.execute("select 1 from symbols where name = ? limit 1", (name,)).fetchone()
                finally:
                    con.close()
            except Exception:  # noqa: BLE001 - 单库不可用不影响其它库
                continue
            if row:
                cache[name] = True
                return True
        cache[name] = False
        return False

    return lookup


DEFAULT_CODE_INDEX_PATHS = (
    r"C:\Users\leganck\.dsh\code-index\smartpos-erp-pos-cb3fcfc4\index.db",
    r"C:\Users\leganck\.dsh\code-index\dsh-plugins-github-36a1d82b\index.db",
)


# ================================================================ CLI（dry-run 冒烟）
def _load_golden(path):
    """读人工标准（17 条）。兼容两种落盘形态：标准 JSONL（一行一条）与旧的 pretty-print 流。"""
    text = open(path, encoding="utf-8").read()
    rows = []
    try:  # 优先按标准 JSONL 读
        for line in text.splitlines():
            line = line.strip()
            if line:
                rows.append(json.loads(line))
        return rows
    except ValueError:
        rows = []
    # 回退：JsonDecoder 流式解析（旧的多行 pretty-print 版本）
    dec, idx = json.JSONDecoder(), 0
    while idx < len(text):
        while idx < len(text) and text[idx] in " \r\n\t":
            idx += 1
        if idx >= len(text):
            break
        obj, idx = dec.raw_decode(text, idx)
        rows.append(obj)
    return rows


def _cli(argv=None):
    import argparse
    import os
    import sys

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - 老终端不支持就算了
        pass

    ap = argparse.ArgumentParser(description="经验抽取管道 dry-run 冒烟")
    ap.add_argument("--material", default=r"D:\work\bug-analysis\_check\session-4ff93b80-experience\experience-digest.md")
    ap.add_argument("--segments", type=int, default=2, help="只跑前 N 段（0=全部）")
    ap.add_argument("--segment-filter", default="", help="只跑 segmentId 含该子串的段")
    ap.add_argument("--live", action="store_true", help="真连本机 LLM（默认只切分不调模型）")
    ap.add_argument("--model", default=os.environ.get("PIPE_LLM_MODEL", "auto/deepseek-v4.1-flash"))
    ap.add_argument("--base-url", default=os.environ.get("PIPE_LLM_URL", "http://127.0.0.1:3425/v1"))
    ap.add_argument("--max-tokens", type=int, default=None,
                    help="默认取 exp_llm.DEFAULT_MAX_TOKENS（4000）")
    ap.add_argument("--max-chars", type=int, default=SEGMENT_MAX_CHARS,
                    help="单段素材上限（默认 800；调大容易触发 truncated/超时）")
    ap.add_argument("--golden", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                                     "exp-pipeline", "experiences-v2-session-4ff93b80.jsonl"))
    ap.add_argument("--json-out", default="", help="把结果写成 JSON 便于后续对照")
    args = ap.parse_args(argv)

    material = open(args.material, encoding="utf-8").read()
    segments = split_segments(material, max_chars=args.max_chars)
    if args.segment_filter:
        segments = [s for s in segments if args.segment_filter in s["segmentId"]]
    if args.segments:
        segments = segments[: args.segments]
    # 只把选中的段重新拼回 digest 格式：管道会再切一次，保证"喂给模型的 == 统计的 == 选中的"
    material = "\n".join(
        f"### [{s['segmentId']}] {s.get('topic') or ''}\n{s['text']}" for s in segments
    )
    print(f"素材：{args.material}")
    print(f"分段：{len(segments)} 段（{segments[0]['segmentId'] if segments else '-'} … "
          f"{segments[-1]['segmentId'] if segments else '-'}），单段上限 {args.max_chars} 字")

    llm = None
    if args.live:
        import exp_llm
        llm = exp_llm.LLMClient(base_url=args.base_url, model=args.model,
                                max_tokens=args.max_tokens or exp_llm.DEFAULT_MAX_TOKENS,
                                api_key=os.environ.get("PIPE_LLM_KEY", "sk-local"))
        print(f"LLM：{llm.base_url} model={llm.model} max_tokens={llm.max_tokens} "
              f"timeout={llm.timeout_ms}ms")
    else:
        print("LLM：未启用（--live 才真跑；此处只验切分与规则口径）")

    result = run_pipeline(material, llm=llm, dry_run=True, mode="dry-run",
                          session_id="4ff93b80", with_excerpt=True, max_chars=args.max_chars)
    job = result["job"]
    print("\n=== job 统计 ===")
    print(json.dumps(job, ensure_ascii=False, indent=2))
    if result["warnings"]:
        print("\n=== warning ===")
        for warn in result["warnings"]:
            print(f"- {warn}")
    print("\n=== 候选 ===")
    for cand in result["candidates"]:
        print(f"- [{cand['lens']}/{cand['category']}] what={cand['what']}")
        print(f"    when={cand['when_expr']}")
        print(f"    why ={cand['why']}")
        print(f"    audit.evidence_quote={cand['audit']['evidence_quote']}"
              f"  excerpt.kind={cand['excerpt']['kind']} bytes={len(cand['excerpt']['text'].encode())}"
              f" sha={cand['excerpt']['sha256'][:12]}")
    if result["blocked"]:
        print("\n=== 被拦 ===")
        for item in result["blocked"]:
            print(f"- [{item['reason']}] {item['candidate']['what'][:60]} :: {item['detail']}")
    if result["errors"]:
        print("\n=== 错误 ===")
        for err in result["errors"]:
            print(f"- {err}")

    if os.path.exists(args.golden):
        golden = _load_golden(args.golden)
        print(f"\n=== 与人工标准对照（人工 {len(golden)} 条）===")
        golden_lens = {}
        for g in golden:
            golden_lens[g.get("lens")] = golden_lens.get(g.get("lens"), 0) + 1
        got_lens = {}
        for cand in result["candidates"]:
            got_lens[cand["lens"]] = got_lens.get(cand["lens"], 0) + 1
        print(f"  人工 lens 分布：{golden_lens}")
        print(f"  本次 lens 分布：{got_lens}")
        print(f"  人工条数 {len(golden)} / 本次通过 {len(result['candidates'])} / 拦截 {len(result['blocked'])}")
        print(f"  垃圾率 {job['garbage_rate'] * 100:.1f}%（skill-covered {job['skill_covered']} 条不计入）")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
        print(f"\n已写 {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
