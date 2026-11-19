"""Stage A：清洗分组锚定（storage-hub v2 §2.2）。

输入：~/.dsh/archive/<sessionId>/segment_NNN.md（dsh-memory-archive 格式）
输出：Topic（主题组，含锚定事实与修正句式候选行）

流程（腾讯方法论，规则版）：
1) 主题分组：按 segment 内事件类型序列切题（Human 开题 → 吸收后续 Assistant/Tool 轮
   到下一个 Human 轮），**不附大纲**（腾讯实测：大纲引导泛化，放大垃圾）。
2) 噪声剥离：<system-reminder>/<available_skills> 等信封、"继续/重试/换个方式"类
   过程性指令、无结论调试轮次（既无锚定事实也无修正句式的组）。
3) 事实锚定：工单号（CHGJ-\\d+|SPLAT-\\d+|BHGJ-\\d+）、文件路径、类名/方法名、SQL 表名。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

# ---------------- 解析 ----------------

TURN_RE = re.compile(r"^### seq (\d+) -- (.+?)\s*$", re.M)
META_SESSION_RE = re.compile(r"^\|\s*Session\s*\|\s*`?([^`|]+?)`?\s*\|", re.M)
META_WRITTEN_RE = re.compile(r"^\|\s*Written\s*\|\s*([^|]+?)\s*\|", re.M)


@dataclass
class Turn:
    seq: int
    header: str
    body: str

    @property
    def kind(self) -> str:
        h = self.header
        if h.startswith("Human"):
            return "human"
        if h.startswith("Assistant"):
            return "assistant"
        if h.startswith("Tool response"):
            return "tool"
        if h.startswith("Developer"):
            return "developer"
        return "other"

    @property
    def tools(self) -> list[str]:
        m = re.search(r"tool calls?: (.+?)\s*$", self.header)
        if not m:
            return []
        return [t.strip() for t in m.group(1).split(",")]


@dataclass
class Segment:
    session_id: str
    seg_index: str
    written: str = ""
    turns: list[Turn] = field(default_factory=list)

    @property
    def archive_ref(self) -> str:
        return f"{self.session_id}/segment_{self.seg_index}.md"


def parse_segment(text: str, session_id: str = "", seg_index: str = "") -> Segment:
    """解析 segment md：`## Verbatim turns` 下的 `### seq N -- ...` 块。"""
    if not session_id:
        m = META_SESSION_RE.search(text)
        session_id = m.group(1).strip() if m else session_id
    seg = Segment(session_id=session_id, seg_index=seg_index)
    m = META_WRITTEN_RE.search(text)
    if m:
        seg.written = m.group(1).strip()
    matches = list(TURN_RE.finditer(text))
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        seg.turns.append(Turn(seq=int(m.group(1)), header=m.group(2), body=text[start:end]))
    return seg


# ---------------- 噪声剥离 ----------------

NOISE_BLOCK_RES = (
    re.compile(r"<system-reminder>.*?</system-reminder>", re.S),
    re.compile(r"<available_skills>.*?</available_skills>", re.S),
    re.compile(r"<env_state>.*?</env_state>", re.S),
)
NOISE_LINE_RES = (
    re.compile(r"^# HISTORICAL.*$", re.M),
    re.compile(r"\[Notice:.*?\]", re.S),
    re.compile(r"^Time sampled while preparing.*$", re.M),   # 信封时间戳行
    re.compile(r"^Browser time zone for this request:.*$", re.M),
    re.compile(r"^Elapsed since the preceding.*$", re.M),
    re.compile(r"^Values written like \{\{NAME_ab12cd34\}\}.*$", re.M),
)
# 用户纯过程性指令（不含事实/锚点）→ 噪声
NOISE_USER_MSGS = re.compile(
    r"^(继续|好的|嗯+|ok|OK|Okay|谢谢|再试一次|重试|换个方式|再想想|继续吧|接着来|"
    r"go on|continue|retry|try again)[。.!！\s]*$"
)
# 信封系统注入（非真实用户话语）→ 该 Human 轮不切题（按剥离围栏后的内容判断）
ENVELOPE_MARK_RE = re.compile(
    r"^(Time sampled while preparing|Browser time zone for this request:|Elapsed since the preceding)", re.M
)
_FENCE_RE = re.compile(r"^```\w*\s*$", re.M)


def strip_noise(text: str) -> str:
    for rx in NOISE_BLOCK_RES:
        text = rx.sub("", text)
    for rx in NOISE_LINE_RES:
        text = rx.sub("", text)
    return text


def is_envelope_turn(text: str) -> bool:
    """整个轮次是宿主信封（时间戳/浏览器提示），不是用户话语。
    先剥掉 markdown 围栏（归档里用户消息被 ```text 包裹），再看剩余内容
    是否全为信封行/空。"""
    body = _FENCE_RE.sub("", text)
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    if not lines:
        return False  # 空轮不在此处理（split_topics 已跳过空消息）
    return all(ENVELOPE_MARK_RE.match(ln) for ln in lines)


def is_noise_user_message(msg: str) -> bool:
    return bool(NOISE_USER_MSGS.match(msg.strip()))


# ---------------- 事实锚定 ----------------

ISSUE_RE = re.compile(r"\b((?:CHGJ|SPLAT|BHGJ)-\d+)\b")
PATH_RE = re.compile(
    r"(?:[A-Za-z]:[\\/][\w.\- ]+(?:[\\/][\w.\- ]+)+)"  # Windows 绝对路径
    r"|(?:/[\w.\-]+(?:/[\w.\-]+)+)"                     # POSIX 绝对路径
    r"|(?:[\w.\-]+/[\w.\-]+/[\w.\-]+\.(?:java|xml|js|ts|py|md|json|sql|mjs))"  # 相对源文件
)
CLASS_METHOD_RE = re.compile(
    r"\b([A-Z][A-Za-z0-9_]{2,})\b(?:\s*\.\s*([a-z][A-Za-z0-9_]{2,})\s*\()?"  # Cls.method(
    r"|\b([a-z][A-Za-z0-9_]{2,})\s*\(\s*\)"                                    # method()
)
SQL_TABLE_RE = re.compile(r"\b(?:from|join|into|update|table)\s+([a-z_][a-z0-9_]{2,})", re.I)

# 路径噪声段（时间戳/URL 片段/信封字段等不作锚点）
_PATH_NOISE = (
    re.compile(r"^\d{4}-\d{2}-\d{2}[T ]"),        # 时间戳开头
    re.compile(r"^\d+:\d+"),                      # 时刻开头
    re.compile(r"^[A-Za-z0-9_]+/\d+(/\d+)*$"),    # seq/id 型纯数字路径
    re.compile(r"^(?:http|https|ftp)$", re.I),
    re.compile(r"^[A-Za-z]{2,40}(/[A-Za-z]{2,40})+$"),  # 纯单词斜杠段（Time/Asia/Singapore）
)
# URL 主机/路径片段（github.com/...、api.github.com/...）：不作路径锚点
_URLISH = re.compile(
    r"^(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|top|dev|me|im|ai)(?:/|$)", re.I
)


@dataclass
class Facts:
    issues: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    symbols: list[str] = field(default_factory=list)      # 类名/方法名
    sql_tables: list[str] = field(default_factory=list)

    def any(self) -> bool:
        return bool(self.issues or self.paths or self.symbols or self.sql_tables)

    def merged(self, other: "Facts") -> "Facts":
        return Facts(
            issues=_uniq(self.issues + other.issues),
            paths=_uniq(self.paths + other.paths),
            symbols=_uniq(self.symbols + other.symbols),
            sql_tables=_uniq(self.sql_tables + other.sql_tables),
        )


def _uniq(items):
    seen, out = set(), []
    for it in items:
        if it not in seen:
            seen.add(it)
            out.append(it)
    return out


# 常见非代码词（类名正则误报抑制）
STOP_SYMBOLS = {
    "The", "This", "That", "These", "Those", "There", "Then", "When", "What", "Why",
    "How", "And", "But", "Not", "All", "Any", "One", "Two", "Use", "Using", "Used",
    "For", "You", "Are", "Was", "Has", "Have", "Had", "His", "Her", "Its", "New",
    "See", "Set", "Get", "Put", "Run", "Fix", "Add", "Git", "Sql", "Java", "Json",
    "Http", "Test", "True", "False", "None", "Null", "Data", "Info", "Note", "Todo",
    "Warning", "Error", "Failed", "Success", "Python", "Windows", "PowerShell",
    "Chinese", "English", "Human", "Assistant", "Tool", "Developer", "Session",
    "Segment", "Summary", "Verbatim", "Notice", "Token", "Memory", "Archive",
    "Bash", "Shell", "Text", "File", "Line", "Code", "Read", "Write", "Edit",
    "Search", "Index", "User", "Name", "Type", "Kind", "Status", "Value", "Key",
    "Limit", "Skip", "Take", "Make", "Let", "Now", "Next", "Prev", "Top",
    # 信封/宿主事件词（Time sampled/Elapsed/…）
    "Time", "Asia", "Singapore", "Shanghai", "Browser", "Interpret", "Elapsed",
    "Base", "Program", "Files", "Microsoft", "Windows", "Users", "AppData",
    "Local", "Temp", "Application", "Edge", "Chrome", "Github", "Gitlab",
    "Stack", "Trace", "Most", "Recent", "Values", "Written", "Like", "Reply",
}


def _path_ok(p: str) -> bool:
    """路径锚点过滤：信封噪声（时间戳/纯单词段/URL 主机）不算文件路径。"""
    p = p.strip().strip("`\"'")
    if len(p) < 5 or len(p) > 260:
        return False
    for rx in _PATH_NOISE:
        if rx.match(p):
            return False
    if _URLISH.match(p):
        return False
    # 至少一段要带扩展名或下划线/连字符（工程路径特征），或盘符开头
    if re.match(r"^[A-Za-z]:[\\/]", p):
        return True
    segs = [s for s in re.split(r"[\\/]", p) if s]
    has_ext = any(re.search(r"\.[A-Za-z0-9]{1,8}$", s) for s in segs)
    has_eng = any(re.search(r"[_\-]|^(src|lib|app|plugins?|server|docs?|test)$", s) for s in segs)
    return bool(has_ext or has_eng)


def extract_facts(text: str) -> Facts:
    text = strip_noise(text)
    f = Facts()
    f.issues = _uniq(ISSUE_RE.findall(text))
    for m in PATH_RE.finditer(text):
        p = m.group(0).strip()
        if _path_ok(p):
            f.paths.append(p)
    f.paths = _uniq(f.paths)
    syms = []
    for m in CLASS_METHOD_RE.finditer(text):
        cls, via_dot, bare = m.group(1), m.group(2), m.group(3)
        if cls and cls not in STOP_SYMBOLS:
            syms.append(cls)
        if via_dot:
            syms.append(via_dot)
        if bare and bare not in ("get", "set", "run", "add", "use"):
            syms.append(bare)
    f.symbols = _uniq([s for s in syms if 3 <= len(s) <= 60])
    tabs = []
    for m in SQL_TABLE_RE.finditer(text):
        t = m.group(1).lower()
        if t not in ("the", "select", "where", "this"):
            tabs.append(t)
    f.sql_tables = _uniq(tabs)
    return f


# ---------------- 修正句式 ----------------

CORRECTION_RES = [
    (re.compile(r"(改成|换成了?|改为)[^，。；;\n]{2,80}?(才对|才成功|才生效|后成功|即可)"), "correction"),
    (re.compile(r"(不要|不能|不可以|切勿|别|禁止)[^，。；;\n]{4,80}"), "forbid"),
    (re.compile(r"(改为|换成|改用)[^，。；;\n]{4,80}"), "switch_to"),
    (re.compile(r"(根因是|根本原因[是:：]|root cause[^，。\n]{0,80})", re.I), "root_cause"),
    (re.compile(r"(失败|报错|403|404|超时|timeout)[^，。；;\n]{0,80}?(→|->|改成|换|修复|解决)"), "error_to_fix"),
    # 「应该/需要」类放宽：仅当后面跟着动宾/技术内容（≥6 字且非口语）才算修正
    (re.compile(r"(应该|应当|需要|必须)([^，。；;\n]{6,80})"), "should"),
]


def find_correction_patterns(text: str) -> list[tuple[str, str]]:
    """返回 [(kind, 句子片段)]。句子按中英文标点粗切。
    过滤口语噪声句：主体（剥掉修正词后）不足 6 字的丢弃。"""
    text = strip_noise(text)
    sents = re.split(r"(?<=[。！？!?；;\n])", text)
    out = []
    for s in sents:
        s = s.strip()
        if len(s) < 10:
            continue
        for rx, kind in CORRECTION_RES:
            m = rx.search(s)
            if m:
                tail = "".join(g for g in m.groups() if g)
                if len(tail) < 6:
                    break  # 命中修正词但内容太薄：整句跳过
                out.append((kind, s[:300]))
                break
    return out


# ---------------- 主题分组 ----------------

@dataclass
class Topic:
    session_id: str
    seg_index: str
    title: str
    turns: list[Turn] = field(default_factory=list)
    facts: Facts = field(default_factory=Facts)
    corrections: list[tuple[str, str]] = field(default_factory=list)
    dropped_reason: str = ""

    @property
    def archive_ref(self) -> str:
        return f"{self.session_id}/segment_{self.seg_index}.md"

    def topic_text(self, limit: int = 6000) -> str:
        parts = [strip_noise(t.body) for t in self.turns]
        return "\n".join(parts)[:limit]


def split_topics(seg: Segment) -> list[Topic]:
    """按事件类型序列切题：非噪声 Human 轮开启一个主题，吸收到下一个 Human 轮前的
    全部 Assistant/Tool/Developer 轮；过程性指令不切题。整段无 Human 时整体作一题。"""
    topics: list[Topic] = []
    cur: Topic | None = None
    preamble: list[Turn] = []
    for t in seg.turns:
        k = t.kind
        if k == "human":
            msg = strip_noise(t.body).strip()
            if is_noise_user_message(msg) or not msg or is_envelope_turn(t.body):
                if cur:  # 过程性指令/信封：归入当前主题，不切新题
                    cur.turns.append(t)
                continue
            cur = Topic(session_id=seg.session_id, seg_index=seg.seg_index,
                        title=" ".join(_FENCE_RE.sub("", msg).split())[:80], turns=[t])
            topics.append(cur)
        elif k in ("assistant", "tool", "developer"):
            if cur:
                cur.turns.append(t)
            else:
                preamble.append(t)
    if preamble and not topics:
        topics.append(Topic(session_id=seg.session_id, seg_index=seg.seg_index,
                            title="(no human turn)", turns=preamble))
    kept: list[Topic] = []
    for tp in topics:
        txt = tp.topic_text()
        tp.facts = extract_facts(txt)
        tp.corrections = find_correction_patterns(txt)
        if not tp.facts.any() and not tp.corrections:
            tp.dropped_reason = "no_conclusion"  # 无结论调试轮次 → 噪声剥离
        else:
            kept.append(tp)
    return kept


def load_segments(archive_dir: str, session_id: str = "", since: str = "",
                  limit_segments: int = 0) -> list[Segment]:
    """扫描 archive_dir 下 <sessionId>/segment_*.md。
    since: YYYY-MM-DD，按 segment 的 Written 日期过滤（缺 Written 的保留）。"""
    out: list[Segment] = []
    if session_id:
        cand = os.path.join(archive_dir, session_id)
        dirs = [cand] if os.path.isdir(cand) else []
    else:
        dirs = []
        if os.path.isdir(archive_dir):
            for name in sorted(os.listdir(archive_dir)):
                p = os.path.join(archive_dir, name)
                if os.path.isdir(p) and name.startswith("session-"):
                    dirs.append(p)
    for d in dirs:
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        for fname in names:
            if not (fname.startswith("segment_") and fname.endswith(".md")):
                continue
            path = os.path.join(d, fname)
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    text = fh.read()
            except OSError:
                continue
            seg = parse_segment(text, session_id=os.path.basename(d),
                                seg_index=fname[len("segment_"):-len(".md")])
            if since:
                w = (seg.written or "")[:10]
                if w and w < since:
                    continue
            out.append(seg)
            if limit_segments and len(out) >= limit_segments:
                return out
    return out
