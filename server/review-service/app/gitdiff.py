"""本地 git diff：把 `git diff base...head` 解析成与 GitLab API 同构的 `FileDiff`。

为什么要本地 diff（计划 D1）：
- 覆盖 GitLab API 的 `too_large` / `collapsed` 盲区；
- 不依赖 `/diffs` 分页，重命名/二进制都能正确识别；
- 与 worktree 读文件共享同一份代码，行号天然一致。

解析规则：
- `diff --git a/x b/x` 起一个文件；`---/+++` 取真实路径（重命名时两边不同）；
- `new file mode` / `deleted file mode` / `rename from|to` / `Binary files` / `GIT binary patch`；
- hunk 解析复用 `diff.parse_hunks`（只认 +/- 前缀，不信任 @@ 计数）。
"""

from __future__ import annotations

import os
import subprocess

from .diff import FileDiff, parse_hunks


def parse_git_diff(text: str) -> list[FileDiff]:
    files: list[FileDiff] = []
    cur: FileDiff | None = None
    body: list[str] = []

    def flush() -> None:
        nonlocal cur, body
        if cur is None:
            return
        if body:
            hunks, binary = parse_hunks("\n".join(body))
            cur.hunks = hunks
            cur.binary = cur.binary or binary
        files.append(cur)
        cur = None
        body = []

    for raw in text.split("\n"):
        line = raw[:-1] if raw.endswith("\r") else raw
        if line.startswith("diff --git "):
            flush()
            # 兜底路径（---/+++ 会覆盖它）；带空格时不能用 split
            rest = line[len("diff --git "):]
            old_path = new_path = ""
            if rest.startswith("a/") and " b/" in rest:
                idx = rest.find(" b/")
                old_path = rest[2:idx]
                new_path = rest[idx + 3:]
            cur = FileDiff(old_path=old_path, new_path=new_path)
            continue
        if cur is None:
            continue
        if line.startswith("new file mode"):
            cur.new_file = True
        elif line.startswith("deleted file mode"):
            cur.deleted_file = True
        elif line.startswith("rename from "):
            cur.old_path = line[len("rename from "):]
            cur.renamed_file = True
        elif line.startswith("rename to "):
            cur.new_path = line[len("rename to "):]
            cur.renamed_file = True
        elif line.startswith("Binary files ") or line.startswith("GIT binary patch"):
            cur.binary = True
        elif line.startswith("--- "):
            p = line[4:]
            if p != "/dev/null":
                cur.old_path = p[2:] if p.startswith("a/") else p
        elif line.startswith("+++ "):
            p = line[4:]
            if p != "/dev/null":
                cur.new_path = p[2:] if p.startswith("b/") else p
        elif line.startswith("@@") or body:
            body.append(line)
    flush()
    return files


def git_diff(worktree: str, base: str, head: str = "HEAD", *, timeout: float = 120.0) -> list[FileDiff]:
    """在 worktree 里跑 `git diff base...head` 并解析。失败抛 RuntimeError（带 stderr）。"""
    proc = subprocess.run(
        ["git", "-C", worktree, "diff", "--no-color", "--no-ext-diff", f"{base}...{head}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git diff 失败（{proc.returncode}）：{proc.stderr[:500]}")
    return parse_git_diff(proc.stdout)


def git_show_file(worktree: str, rel_path: str, ref: str = "HEAD", *, timeout: float = 30.0) -> str:
    """读某个 ref 下的文件内容（用于 base 分支取文件，而不是切工作树）。"""
    proc = subprocess.run(
        ["git", "-C", worktree, "show", f"{ref}:{rel_path}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git show 失败：{proc.stderr[:300]}")
    return proc.stdout


__all__ = ["parse_git_diff", "git_diff", "git_show_file"]
