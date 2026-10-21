"""镜像仓 + worktree 管理（计划 D1）。

每个项目一份 `git clone --mirror`（只建一次），每次评审：
  1. 在**项目锁**内 fetch：`+refs/merge-requests/<iid>/head:refs/mr/<iid>` + 目标分支；
  2. `git worktree add --detach` 到临时目录（评审结束后删除）；
  3. base 分支另有一份长期 worktree，供建图/取上下文复用。

安全：
- clone/fetch **不会执行仓库里的代码**（hooks 不随 clone 过来；.gitattributes 的 filter 只在本地配置过才会跑）；
- 关闭 submodule 递归、跳过 LFS smudge、禁止交互式凭据提示；
- worktree 目录只给评审进程读（部署时用只读挂载/非 root 容器）。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time

from .util import log

GIT_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_LFS_SKIP_SMUDGE": "1",
    "GIT_ASKPASS": "echo",
    "GIT_SSH_COMMAND": "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
}

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def _safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text)[:80] or "repo"


def _run(args: list[str], *, cwd: str | None = None, timeout: float = 600.0) -> str:
    env = {**os.environ, **GIT_ENV}
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:3])} 失败（{proc.returncode}）：{proc.stderr.strip()[:600]}")
    return proc.stdout


class MirrorManager:
    def __init__(self, mirrors_dir: str, worktrees_dir: str, *, timeout: float = 600.0):
        self.mirrors_dir = os.path.abspath(mirrors_dir)
        self.worktrees_dir = os.path.abspath(worktrees_dir)
        self.timeout = timeout
        os.makedirs(self.mirrors_dir, exist_ok=True)
        os.makedirs(self.worktrees_dir, exist_ok=True)

    # ------------------------------------------------------------ 路径

    def mirror_path(self, project_key: str) -> str:
        return os.path.join(self.mirrors_dir, _safe_name(project_key) + ".git")

    def worktree_path(self, project_key: str, suffix: str) -> str:
        return os.path.join(self.worktrees_dir, f"{_safe_name(project_key)}-{_safe_name(suffix)}")

    def exists(self, project_key: str) -> bool:
        return os.path.isdir(os.path.join(self.mirror_path(project_key), "objects"))

    # ------------------------------------------------------------ 镜像

    def ensure_mirror(self, project_key: str, git_url: str) -> str:
        path = self.mirror_path(project_key)
        if self.exists(project_key):
            return path
        with _lock_for(project_key):
            if self.exists(project_key):
                return path
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            log(f"克隆镜像：{git_url} → {path}")
            _run(["clone", "--mirror", "--no-recurse-submodules", git_url, path], timeout=self.timeout)
        return path

    def fetch(self, project_key: str, refspecs: list[str]) -> None:
        """拉取指定 ref（串行：git 会锁 refs）。refspec 例如 `+refs/heads/main:refs/heads/main`。"""
        mirror = self.mirror_path(project_key)
        if not os.path.isdir(mirror):
            raise RuntimeError(f"镜像仓不存在：{mirror}（先 ensure_mirror）")
        with _lock_for(project_key):
            _run(["--git-dir", mirror, "fetch", "--prune", "origin", *refspecs], timeout=self.timeout)

    def fetch_merge_request(self, project_key: str, mr_iid: int, target_branch: str) -> None:
        refspecs = [f"+refs/merge-requests/{mr_iid}/head:refs/mr/{mr_iid}"]
        if target_branch:
            refspecs.append(f"+refs/heads/{target_branch}:refs/heads/{target_branch}")
        self.fetch(project_key, refspecs)

    def ref_exists(self, project_key: str, ref: str) -> bool:
        mirror = self.mirror_path(project_key)
        proc = subprocess.run(
            ["git", "--git-dir", mirror, "rev-parse", "--verify", "--quiet", ref],
            capture_output=True,
            text=True,
            env={**os.environ, **GIT_ENV},
        )
        return proc.returncode == 0

    def rev_parse(self, project_key: str, ref: str) -> str:
        return _run(["--git-dir", self.mirror_path(project_key), "rev-parse", ref]).strip()

    # ------------------------------------------------------------ worktree

    def add_worktree(self, project_key: str, ref: str, suffix: str, *, reuse: bool = False) -> str:
        path = self.worktree_path(project_key, suffix)
        mirror = self.mirror_path(project_key)
        if os.path.exists(os.path.join(path, ".git")):
            if reuse:
                return path
            self.remove_worktree(project_key, suffix)
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _run(["--git-dir", mirror, "worktree", "add", "--detach", path, ref], timeout=self.timeout)
        return path

    def remove_worktree(self, project_key: str, suffix: str) -> None:
        path = self.worktree_path(project_key, suffix)
        mirror = self.mirror_path(project_key)
        if os.path.isdir(mirror):
            subprocess.run(
                ["git", "--git-dir", mirror, "worktree", "remove", "--force", path],
                capture_output=True,
                text=True,
                env={**os.environ, **GIT_ENV},
            )
        shutil.rmtree(path, ignore_errors=True)

    def prune(self) -> int:
        """清理孤儿工作树（进程崩溃后遗留）。返回清理的镜像数。"""
        cleaned = 0
        for name in os.listdir(self.mirrors_dir):
            if not name.endswith(".git"):
                continue
            mirror = os.path.join(self.mirrors_dir, name)
            subprocess.run(
                ["git", "--git-dir", mirror, "worktree", "prune"],
                capture_output=True,
                text=True,
                env={**os.environ, **GIT_ENV},
            )
            cleaned += 1
        cutoff = time.time() - 6 * 3600
        for name in os.listdir(self.worktrees_dir):
            path = os.path.join(self.worktrees_dir, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    shutil.rmtree(path, ignore_errors=True)
            except OSError:
                continue
        return cleaned

    def gc(self, ttl_days: float = 30.0) -> int:
        """删除超过 TTL 未使用的镜像（按 mtime）。返回删除数量。"""
        cutoff = time.time() - ttl_days * 86400
        removed = 0
        for name in os.listdir(self.mirrors_dir):
            if not name.endswith(".git"):
                continue
            path = os.path.join(self.mirrors_dir, name)
            try:
                newest = max(
                    os.path.getmtime(os.path.join(path, p)) for p in ("HEAD", "config") if os.path.exists(os.path.join(path, p))
                ) if os.path.exists(path) else 0
            except OSError:
                continue
            if newest and newest < cutoff:
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
        return removed


__all__ = ["MirrorManager", "GIT_ENV"]
