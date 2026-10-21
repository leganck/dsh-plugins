"""GitLab MR diff 解析。

只做一件事：把 GitLab `/merge_requests/:iid/diffs`（或 webhook 里的 diff）解析成
"每个文件新增了哪些行（文件内行号）"，评审只对新增行提意见。

为什么不用现成库：解析规则就这几条，自己写反而能精确控制三个坑——
  ① 新文件是 `@@ -0,0 +1,N @@`、删除文件没有新增行；
  ② `\\ No newline at end of file` 不占行号；
  ③ 行号是**文件内**行号，不是 hunk 内偏移（GitLab position 就是按文件内行号）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .util import sha1

SKIP_REASONS = {
    "deleted": "文件被删除",
    "binary": "二进制文件",
    "too_large": "diff 过大，GitLab 未返回内容",
    "collapsed": "diff 被折叠，需单独取",
    "generated": "生成文件（锁文件/压缩产物等）",
    "no_changes": "没有 diff 内容",
    "no_added_lines": "只有删除行，没有新增行",
    "ignored": "命中排除规则",
}


@dataclass
class Hunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    # (kind, text, old_lineno, new_lineno)，kind ∈ {' ', '+', '-'}
    lines: list[tuple[str, str, int | None, int | None]] = field(default_factory=list)


@dataclass
class FileDiff:
    old_path: str
    new_path: str
    hunks: list[Hunk] = field(default_factory=list)
    new_file: bool = False
    deleted_file: bool = False
    renamed_file: bool = False
    binary: bool = False
    too_large: bool = False
    collapsed: bool = False
    generated: bool = False
    ignored: bool = False

    # ---------------------------------------------------------- 路径

    @property
    def path(self) -> str:
        """评审与 position 都用新路径；删除文件用旧路径。"""
        return self.new_path or self.old_path

    # ---------------------------------------------------------- 跳过判定

    def skip_reason(self) -> str | None:
        if self.ignored:
            return "ignored"
        if self.deleted_file:
            return "deleted"
        if self.binary:
            return "binary"
        if self.too_large:
            return "too_large"
        if self.collapsed:
            return "collapsed"
        if self.generated:
            return "generated"
        if not self.hunks:
            return "no_changes"
        if not self.added_lines():
            return "no_added_lines"
        return None

    # ---------------------------------------------------------- 行

    def added_lines(self) -> list[tuple[int, str]]:
        """[(文件内新行号, 行文本)]，只含 '+' 行。"""
        out: list[tuple[int, str]] = []
        for h in self.hunks:
            for kind, text, _old, new in h.lines:
                if kind == "+" and new is not None:
                    out.append((new, text))
        return out

    def added_lineno_set(self) -> set[int]:
        return {n for n, _ in self.added_lines()}

    def line_text(self, lineno: int) -> str | None:
        for n, text in self.added_lines():
            if n == lineno:
                return text
        return None

    def removed_lines(self) -> list[tuple[int, str]]:
        out: list[tuple[int, str]] = []
        for h in self.hunks:
            for kind, text, old, _new in h.lines:
                if kind == "-" and old is not None:
                    out.append((old, text))
        return out

    # ---------------------------------------------------------- 指纹

    def fingerprint(self) -> str:
        """文件级 diff 指纹：路径 + 新增行内容。用于 MR 幂等与增量判断。"""
        parts = [self.path]
        parts.extend(f"{n}:{t}" for n, t in self.added_lines())
        return sha1("\n".join(parts))

    def added_text(self) -> str:
        return "\n".join(t for _, t in self.added_lines())


def parse_hunks(diff_text: str) -> tuple[list[Hunk], bool]:
    """解析 hunks。返回 (hunks, 是否二进制)。只依赖 +/- 前缀，不信任 @@ 计数。"""
    hunks: list[Hunk] = []
    cur: Hunk | None = None
    old_no = new_no = 0
    for raw in diff_text.split("\n"):
        line = raw[:-1] if raw.endswith("\r") else raw
        if line.startswith("Binary files ") or line.startswith("GIT binary patch"):
            return hunks, True
        if line.startswith("@@"):
            # @@ -a,b +c,d @@ 可选的 section 文本忽略
            body = line[2:]
            end = body.find("@@")
            if end >= 0:
                body = body[:end]
            parts = body.split()
            if len(parts) < 2:
                continue
            old_spec = parts[0][1:] if parts[0].startswith("-") else parts[0]
            new_spec = parts[1][1:] if parts[1].startswith("+") else parts[1]

            def spec(s: str) -> tuple[int, int]:
                if "," in s:
                    a, b = s.split(",", 1)
                    return int(a), int(b)
                return int(s), 1

            old_start, old_count = spec(old_spec)
            new_start, new_count = spec(new_spec)
            cur = Hunk(old_start, old_count, new_start, new_count)
            hunks.append(cur)
            old_no, new_no = old_start, new_start
            continue
        if cur is None:
            continue  # diff --git / index / --- / +++ 等头部
        if line.startswith("\\"):
            continue  # \ No newline at end of file：不占行号
        if line == "":
            # 末尾空行（split 的产物）忽略；真正的空上下文行是单个空格 " "
            continue
        kind = line[0]
        text = line[1:]
        if kind == "+":
            cur.lines.append(("+", text, None, new_no))
            new_no += 1
        elif kind == "-":
            cur.lines.append(("-", text, old_no, None))
            old_no += 1
        elif kind == " ":
            cur.lines.append((" ", text, old_no, new_no))
            old_no += 1
            new_no += 1
        else:
            # 无法识别的行（例如 "\ No newline" 已处理），跳过而不是崩
            continue
    return hunks, False


def parse_gitlab_file(item: dict) -> FileDiff:
    """把一个 GitLab diff 文件对象解析成 FileDiff。

    GitLab 字段（/diffs 与 /changes 的差异对象）：
      old_path, new_path, new_file, renamed_file, deleted_file,
      diff, too_large, collapsed, generated_file
    注意：`too_large=true` 时 `diff` 为空串；`collapsed=true`（18.4+）时 diff 也可能为空。
    """
    fd = FileDiff(
        old_path=item.get("old_path") or "",
        new_path=item.get("new_path") or "",
        new_file=bool(item.get("new_file")),
        deleted_file=bool(item.get("deleted_file")),
        renamed_file=bool(item.get("renamed_file")),
        too_large=bool(item.get("too_large")),
        collapsed=bool(item.get("collapsed")),
        generated=bool(item.get("generated_file")),
    )
    diff_text = item.get("diff") or ""
    if diff_text:
        hunks, binary = parse_hunks(diff_text)
        fd.hunks = hunks
        fd.binary = binary
    return fd


def parse_gitlab_diffs(items: list[dict], ignore_globs: list[str] | None = None) -> list[FileDiff]:
    """解析整个 MR 的 diff 列表，并按 glob 标记忽略（不删，便于在汇总里说明跳过原因）。"""
    out = [parse_gitlab_file(it) for it in items]
    if ignore_globs:
        for fd in out:
            if matches_any(fd.path, ignore_globs):
                fd.ignored = True
    return out


def matches_any(path: str, globs: list[str]) -> bool:
    """极简 glob 匹配：支持 `**/x`、`*.lock`、`dir/**`、精确路径。

    只用于排除规则，语义偏保守（宁可漏排除，不可误排除要审的代码）。
    """
    from fnmatch import fnmatch

    p = path.replace("\\", "/")
    for g in globs:
        g = g.strip().replace("\\", "/")
        if not g:
            continue
        if g.startswith("**/") and fnmatch(p, g[3:]):
            return True
        if p == g or fnmatch(p, g):
            return True
        if g.endswith("/**") and (p == g[:-3] or p.startswith(g[:-2])):
            return True
    return False


def summarize_skips(files: list[FileDiff]) -> list[dict]:
    """汇总里要展示"哪些文件没审、为什么"—— 用户最容易被"静默跳过"惹毛。"""
    out = []
    for fd in files:
        reason = fd.skip_reason()
        if reason:
            out.append(
                {
                    "path": fd.path,
                    "reason": reason,
                    "detail": SKIP_REASONS.get(reason, reason),
                }
            )
    return out


def mr_fingerprint(files: list[FileDiff]) -> str:
    """整个 MR 的内容指纹：不随 rebase 变化，用于二级幂等（head_sha 会变，diff 不会）。"""
    parts = sorted(f"{fd.path}:{fd.fingerprint()}" for fd in files if not fd.skip_reason())
    return sha1("\n".join(parts))
