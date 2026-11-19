"""Stage B（规则版）：从 Topic 锚定事实 + 修正句式构造经验候选。

候选形状（对齐 memories API 契约）：
  {repo, lens, what, when_expr, why, evidence:[{archive_ref|issue|mr}], source}

lens 判定（storage-hub v2 §2.2 三镜头）：
- jargon（黑话）：专有名词词典未命中 + 无路径/模块指向 + 非修正/约束句式
- index（索引）：有文件路径或模块指向（代码/文件系统定位类经验）
- logic（逻辑）：修正/约束句式（"改成 X 才对/应该 Y/不要 Z"）
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict

from stage_a import Topic, strip_noise

# 专有名词词典（命中 → 不是黑话候选）
KNOWN_TERMS = {
    "git", "rebase", "merge", "cherry-pick", "cherry pick", "jenkins", "nexus",
    "maven", "gradle", "snapshot", "lombok", "spring", "mybatis", "mysql",
    "sqlite", "fts5", "numpy", "python", "powershell", "cmd", "bash", "curl",
    "docker", "nginx", "redis", "zstd", "xlog", "cdp", "selenium", "playwright",
    "sql", "join", "index", "timeout", "deploy", "rollback", "worktree",
    "jdk", "jvm", "jar", "war", "tomcat", "checkstyle", "javadoc", "mr",
    "glab", "yunxiao", "devops", "sla", "oss", "cdn", "dns", "proxy",
    "jargon", "index", "logic",  # 自身
}
# 模块指向（repo 推断）
REPO_HINTS = [
    (re.compile(r"\bsvc[-_]pay\b|\bpay\b.*\b3\.x\b|smartpos-svc-pay", re.I), "svc-pay"),
    (re.compile(r"web[-_]erp|smartpos-site-erp", re.I), "web-erp"),
    (re.compile(r"crm[-_]order|smartpos-crm-order", re.I), "crm-order"),
    (re.compile(r"crm[-_]policy|smartpos-crm-policy", re.I), "crm-policy"),
    (re.compile(r"erp[-_]pos|smartpos-erp-pos", re.I), "erp-pos"),
    (re.compile(r"erp[-_]md|smartpos-erp-md", re.I), "erp-md"),
    (re.compile(r"code[-_]index|code_search|dsh-code-index", re.I), "dsh-code-index"),
    (re.compile(r"dsh[-_]wake", re.I), "dsh-wake"),
    (re.compile(r"review[-_]service", re.I), "review-service"),
]


@dataclass
class Candidate:
    repo: str
    lens: str                 # jargon | index | logic
    what: str                 # 经验主体（≥8 字）
    when_expr: str            # 适用时机/触发条件（非空）
    why: str
    evidence: list[dict] = field(default_factory=list)
    source: str = "pipeline"
    origin: str = "rules"     # rules | llm | digest
    topic_ref: str = ""

    def to_payload(self) -> dict:
        d = asdict(self)
        d.pop("origin", None)
        d.pop("topic_ref", None)
        return d

    def summary(self) -> str:
        return f"[{self.lens}] {self.what[:60]}  (when: {self.when_expr[:40]})"


def classify_lens(text: str, facts) -> str:
    """lens 判定：优先级 logic > index > jargon。"""
    has_correction = bool(re.search(
        r"(改成|改为|应该|应当|需要|必须|不要|不能|切勿|别|才对|才成功|根因|root cause|修复|解决)", text, re.I))
    has_pathish = bool(facts.paths) or bool(facts.symbols) or bool(facts.sql_tables)
    if has_correction:
        return "logic"
    if has_pathish:
        return "index"
    return "jargon"


def infer_repo(text: str, facts) -> str:
    for rx, repo in REPO_HINTS:
        if rx.search(text):
            return repo
    if facts.sql_tables or facts.issues:
        return "global"
    return "global"


# 修正句式 → what/when 提取
WHAT_RES = [
    # "X 报 403 → 改用 Y 才成功" → what=改用 Y 才成功
    re.compile(r"(改用|换成|改为|改成)([^，。；;\n]{2,80}?(?:才成功|才对|才生效|后成功|即可))"),
    # "不要 Z" / "不能 Z"（禁令类，信息量最实）
    re.compile(r"(不要|不能|不可以|切勿|别|禁止)([^，。；;\n]{4,80})"),
    # "应该 Y" / "需要 X"
    re.compile(r"(应该|应当|需要|必须)([^，。；;\n]{6,80})"),
]
# what 噪声模式：纯口语/无技术含量的修正短语（Review 第一道闸前的预过滤）
WHAT_NOISE_RE = re.compile(
    r"^(?:应该?|需要|必须|不要|不能|不可以|切勿|别|禁止|改成|改为|换|用|是|有|要|够呛|"
    r"的操作|的东西|的话|一下|这么|那么)[。.!！\s]*$"
)
WHEN_RES = [
    re.compile(r"^(.{2,60}?)(?:时|的时候|情况下|场景下|之前|之后)"),
    re.compile(r"\b(when|whenever)\b\s+(.{3,60})", re.I),
]
# when 兜底来源：错误码/异常名/工具名 + 主题
WHEN_HINT_RES = [
    re.compile(r"\b(\d{3})\b"),                                    # HTTP 状态码
    re.compile(r"\b([A-Za-z]*(?:Exception|Error))\b"),              # 异常名
    re.compile(r"`([\w.\-+/\\]+)`"),                                # 反引号里的标识物
]


def _clean(s: str) -> str:
    s = strip_noise(s).strip(" ：:，,。.；;\n\t")
    return " ".join(s.split())


def build_when(facts, topic_title: str) -> str:
    parts = []
    if facts.issues:
        parts.append("工单 " + "/".join(facts.issues[:2]))
    errs = []
    for rx in WHEN_HINT_RES[:2]:
        errs.extend(rx.findall(topic_title))
    if errs:
        parts.append("出现 " + errs[0])
    if not parts:
        parts.append("处理" + (topic_title[:30] or "相关问题") + "时")
    return "；".join(parts[:2])


def candidate_from_topic(topic: Topic) -> list[Candidate]:
    """一个 Topic → 0..N 个候选。修正句式每条产一个 logic 候选；
    无修正句式但有锚定事实的产一个 index/jargon 候选。"""
    text = topic.topic_text()
    out: list[Candidate] = []
    ev_base = {"archive_ref": topic.archive_ref}
    if topic.facts.issues:
        ev_base["issue"] = topic.facts.issues[0]

    used_correction_sentences = set()
    for kind, sent in topic.corrections:
        if sent in used_correction_sentences:
            continue
        used_correction_sentences.add(sent)
        what = ""
        for rx in WHAT_RES:
            m = rx.search(sent)
            if m:
                what = _clean(m.group(1) + (m.group(2) or ""))
                break
        if not what or WHAT_NOISE_RE.match(what):
            continue  # 提不出实质 what：丢弃该句（宁缺勿滥）
        when_expr = build_when(topic.facts, topic.title)
        why = _clean(sent)[:300]
        lens = classify_lens(sent, topic.facts)
        if lens != "logic":
            lens = "logic"  # 修正句式一律 logic（规则版从修正模式构造）
        out.append(Candidate(
            repo=infer_repo(sent + " " + text, topic.facts),
            lens=lens,
            what=what[:200],
            when_expr=when_expr[:200],
            why=why,
            evidence=[ev_base],
            origin="rules",
            topic_ref=topic.archive_ref,
        ))

    if not out and topic.facts.any():
        # 无修正句式：锚定事实本身作为 index 候选（定位类经验）
        syms = "/".join(topic.facts.symbols[:3] or [])
        paths = topic.facts.paths[:2]
        tabs = "/".join(topic.facts.sql_tables[:3])
        bits = [b for b in (syms, tabs, "、".join(paths)) if b]
        what = _clean("定位入口：" + "；".join(bits))[:200] if bits else topic.title
        when_expr = build_when(topic.facts, topic.title)
        out.append(Candidate(
            repo=infer_repo(text, topic.facts),
            lens="index",
            what=what,
            when_expr=when_expr,
            why="锚定事实（无修正句式）：symbols=" + ",".join(topic.facts.symbols[:8])
                + " tables=" + ",".join(topic.facts.sql_tables[:8]),
            evidence=[ev_base],
            origin="rules",
            topic_ref=topic.archive_ref,
        ))
    return out


def extract_rules(topics: list[Topic]) -> list[Candidate]:
    out: list[Candidate] = []
    for tp in topics:
        out.extend(candidate_from_topic(tp))
    return out


# ---------------- digest 解析（--from-digest）----------------

DIGEST_HEAD_RE = re.compile(r"^###\s*\[segment_(\d+)\.md\]\s*(.+?)\s*$", re.M)


def parse_digest(text: str, keep_duplicates: bool = False) -> list[Candidate]:
    """解析 experience-digest.md：`### [segment_NNN.md] <节名>` 下的 `- ` 条目。

    每条 bullet → 一个候选：
    - lens：修正/约束句式 → logic；路径/标识符 → index；否则 jargon（黑话）
    - when：bullet 里的工单号/错误码/异常名，兜底"处理 <节名> 类问题时"
    - 证据：{archive_ref: <session>/segment_NNN.md} + 工单号
    原始 digest 有跨段重复（同 bullet 出现在相邻两段），默认去重（与素材
    生成时的 223 条唯一口径一致）；keep_duplicates=True 保留全部。
    """
    session = "session-4ff93b80-08ba-4561-bc0c-04c1462dc7f5"
    out: list[Candidate] = []
    seen: set[str] = set()
    matches = list(DIGEST_HEAD_RE.finditer(text))
    for i, m in enumerate(matches):
        seg_idx = m.group(1)
        section = m.group(2).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[start:end]
        for line in block.splitlines():
            line = line.rstrip()
            if not line.startswith("- "):
                continue
            bullet = line[2:].strip()
            if not bullet:
                continue
            key = " ".join(bullet.split())
            if not keep_duplicates and key in seen:
                continue
            seen.add(key)
            from stage_a import ISSUE_RE, extract_facts
            facts = extract_facts(bullet)
            lens = classify_lens(bullet, facts)
            if lens == "jargon" and not _has_jargon(bullet):
                lens = "logic" if re.search(r"(应该|需要|必须|不要|不能|才|改)", bullet) else "index"
            when_expr = build_when(facts, section)
            ev = [{"archive_ref": f"{session}/segment_{seg_idx}.md"}]
            if facts.issues:
                ev.append({"issue": facts.issues[0]})
            out.append(Candidate(
                repo=infer_repo(bullet, facts),
                lens=lens,
                what=key[:200],
                when_expr=when_expr[:200],
                why=_clean(bullet)[:400],
                evidence=ev,
                origin="digest",
                topic_ref=f"{session}/segment_{seg_idx}.md",
            ))
    return out


def _has_jargon(text: str) -> bool:
    """专有名词词典未命中（=存在黑话/行话信号）。"""
    words = set(re.findall(r"[A-Za-z][A-Za-z0-9_\-]{2,}", text))
    return any(w.lower() not in KNOWN_TERMS for w in words)
