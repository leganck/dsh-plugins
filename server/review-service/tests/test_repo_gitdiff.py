"""镜像仓 / worktree / 本地 git diff 验收（需要 git，容器内跑）。

    python tests/test_repo_gitdiff.py

步骤：造一个本地仓库（main + feature 分支：改文件、重命名、新增、二进制）→
用 MirrorManager 克隆镜像、fetch ref、建两个 worktree → 本地 diff 解析 → 断言。
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:  # Windows 控制台默认 GBK：统一改成 UTF-8，避免中文/emoji 输出崩
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


from app.gitdiff import git_diff  # noqa: E402
from app.repo import MirrorManager  # noqa: E402

PASS = 0
FAILS: list[str] = []


def check(label: str, cond, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  [ok] {label}")
    else:
        FAILS.append(label)
        print(f"  [FAIL] {label}" + (f" —— {detail}" if detail else ""))


def git(*args: str, cwd: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{proc.stderr}")
    return proc.stdout


def make_source_repo(root: str) -> str:
    os.makedirs(root, exist_ok=True)
    git("init", "-q", "-b", "main", cwd=root)
    with open(os.path.join(root, "a.py"), "w", encoding="utf-8") as f:
        f.write("def a():\n    return 1\n")
    with open(os.path.join(root, "old.txt"), "w", encoding="utf-8") as f:
        f.write("hello\n")
    with open(os.path.join(root, "img.png"), "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n\x00" + b"0" * 64)
    git("add", "-A", cwd=root)
    git("commit", "-q", "-m", "init", cwd=root)

    git("checkout", "-q", "-b", "feature", cwd=root)
    with open(os.path.join(root, "a.py"), "w", encoding="utf-8") as f:
        f.write("def a():\n    x = 1\n    return x\n")
    git("mv", "old.txt", "new.txt", cwd=root)
    with open(os.path.join(root, "b.py"), "w", encoding="utf-8") as f:
        f.write("def b():\n    return 2\n")
    with open(os.path.join(root, "img.png"), "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n\x00" + b"1" * 64)
    git("add", "-A", cwd=root)
    git("commit", "-q", "-m", "feature", cwd=root)
    return root


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="repo-test-")
    src = make_source_repo(os.path.join(tmp, "src"))
    mm = MirrorManager(os.path.join(tmp, "mirrors"), os.path.join(tmp, "worktrees"))

    mm.ensure_mirror("7", src)
    check("1. 镜像仓建立成功", mm.exists("7"), mm.mirror_path("7"))

    mm.fetch("7", ["+refs/heads/main:refs/heads/main", "+refs/heads/feature:refs/mr/1"])
    check("2. fetch 目标分支与 MR ref", mm.ref_exists("7", "refs/mr/1") and mm.ref_exists("7", "refs/heads/main"))

    base_sha = mm.rev_parse("7", "refs/heads/main")
    head_sha = mm.rev_parse("7", "refs/mr/1")
    check("3. rev-parse 拿到两个 sha", len(base_sha) == 40 and len(head_sha) == 40 and base_sha != head_sha)

    base_wt = mm.add_worktree("7", base_sha, "base-main", reuse=True)
    head_wt = mm.add_worktree("7", head_sha, "mr-1", reuse=False)
    check("4. 两个 worktree 就绪", os.path.isfile(os.path.join(base_wt, "a.py")) and os.path.isfile(os.path.join(head_wt, "b.py")))
    check("5. base worktree 里没有新文件", not os.path.exists(os.path.join(base_wt, "b.py")))

    again = mm.add_worktree("7", base_sha, "base-main", reuse=True)
    check("6. base worktree 可复用（路径一致）", again == base_wt)

    files = git_diff(head_wt, base_sha, head_sha)
    by = {f.path: f for f in files}
    check("7. 解析出 4 个文件", len(files) == 4, str(sorted(by)))
    check("8. 修改文件含新增行", "a.py" in by and [t for _, t in by["a.py"].added_lines()] == ["    x = 1", "    return x"], str(by.get("a.py") and by["a.py"].added_lines()))
    check("9. 重命名被识别（old → new）", "new.txt" in by and by["new.txt"].renamed_file and by["new.txt"].old_path == "old.txt", str(by.get("new.txt")))
    check("10. 新增文件被识别", "b.py" in by and by["b.py"].new_file)
    check("11. 二进制文件被识别并跳过", by["img.png"].binary and by["img.png"].skip_reason() == "binary")

    mm.remove_worktree("7", "mr-1")
    check("12. worktree 删除成功", not os.path.exists(head_wt))
    mm.prune()
    check("13. prune 不报错且镜像仍在", mm.exists("7"))

    # GC：造一个 2 天没动过的镜像目录，ttl=1 天应被删；当前镜像保留
    stale = os.path.join(tmp, "mirrors", "stale.git")
    os.makedirs(stale, exist_ok=True)
    head = os.path.join(stale, "HEAD")
    with open(head, "w", encoding="utf-8") as f:
        f.write("ref: refs/heads/main\n")
    old = __import__("time").time() - 2 * 86400
    os.utime(head, (old, old))
    removed = mm.gc(ttl_days=1)
    check("14. GC 删除过期镜像、保留在用的", removed == 1 and not os.path.isdir(stale) and mm.exists("7"), f"removed={removed}")

    # 私有仓 git 认证：PAT 只进子进程环境，不写 remote URL/日志
    auth_mm = MirrorManager(os.path.join(tmp, "auth-mirrors"), os.path.join(tmp, "auth-worktrees"), git_token="test-token")
    auth_env = auth_mm._git_env
    check(
        "15. 私有仓认证只注入 git http header，不落 URL",
        auth_env.get("GIT_CONFIG_KEY_0") == "http.extraHeader"
        and str(auth_env.get("GIT_CONFIG_VALUE_0", "")).startswith("Authorization: Basic ")
        and "test-token" not in str(auth_env.get("GIT_CONFIG_VALUE_0", "")),
        str(auth_env.get("GIT_CONFIG_KEY_0")),
    )

    print(f"\n通过 {PASS}，失败 {len(FAILS)}")
    if FAILS:
        print("失败项：")
        for f in FAILS:
            print("  - " + f)
        return 1
    print("✅ repo/gitdiff 验收通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
