"""发布层：行内 discussion + 汇总 note。

三条经验：
1. `position` 被 400/422 拒（MR 又 push 了 / 行号对不上）时**不能丢评论**，降级成普通 note 并标 `文件:行`；
2. 汇总 note 用 `<!-- ai-review-summary -->` 作为标记，重跑时更新同一条而不是再发一条；
3. dry-run 只打印 payload，一个请求都不发（影子模式靠它）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .clients import GitLabClient
from .pipeline import ReviewOutcome
from .util import HttpError, log


@dataclass
class PublishResult:
    posted: int = 0
    notes: int = 0
    failed: list[dict] = field(default_factory=list)
    payloads: list[dict] = field(default_factory=list)
    summary_note_id: int | None = None


class Publisher:
    def __init__(
        self,
        gitlab: GitLabClient | None,
        project_id: int | str,
        iid: int,
        refs: dict | None = None,
        *,
        dry_run: bool = False,
    ):
        self.gitlab = gitlab
        self.project_id = project_id
        self.iid = iid
        self.refs = refs or {}
        self.dry_run = dry_run

    # ------------------------------------------------------------ 行内

    def _position(self, path: str, line: int) -> dict | None:
        if not (self.refs.get("base_sha") and self.refs.get("head_sha")):
            return None
        return GitLabClient.position(self.refs, path, line)

    def publish_inline(self, outcome: ReviewOutcome) -> PublishResult:
        res = PublishResult()
        for f in outcome.validation.posted:
            pos = self._position(f.file, f.line)
            body = f.body()
            payload = {"body": body, "position": pos} if pos else {"body": f"`{f.file}:{f.line}`\n\n{body}"}
            res.payloads.append({"discussion": payload})
            if self.dry_run or self.gitlab is None:
                res.posted += 1
                continue
            try:
                assert pos is not None
                self.gitlab.create_discussion(self.project_id, self.iid, body, pos)
                res.posted += 1
            except (HttpError, AssertionError) as e:
                status = getattr(e, "status", 0)
                log(f"行内评论被拒（HTTP {status}），降级为普通 note：{f.file}:{f.line}")
                try:
                    self.gitlab.create_note(self.project_id, self.iid, f"`{f.file}:{f.line}`\n\n{body}")
                    res.notes += 1
                except HttpError as e2:
                    res.failed.append({"file": f.file, "line": f.line, "error": str(e2)[:200]})
        return res

    # ------------------------------------------------------------ 汇总

    def publish_summary(self, outcome: ReviewOutcome) -> PublishResult:
        res = PublishResult()
        body = outcome.summary
        res.payloads.append({"note": body})
        if self.dry_run or self.gitlab is None:
            res.notes += 1
            return res
        # 同一 MR 复用同一条汇总（避免每次 push 都刷一条）
        try:
            existing = [
                n
                for n in self.gitlab.notes(self.project_id, self.iid)
                if (n.get("body") or "").strip().endswith("<!-- ai-review-summary -->")
            ]
            if existing:
                note_id = int(existing[-1]["id"])
                self.gitlab.update_note(self.project_id, self.iid, note_id, body)
                res.summary_note_id = note_id
            else:
                note = self.gitlab.create_note(self.project_id, self.iid, body)
                res.summary_note_id = int(note.get("id") or 0) or None
            res.notes += 1
        except HttpError as e:
            res.failed.append({"summary": True, "error": str(e)[:200]})
        return res

    def publish(self, outcome: ReviewOutcome) -> PublishResult:
        inline = self.publish_inline(outcome)
        summary = self.publish_summary(outcome)
        return PublishResult(
            posted=inline.posted,
            notes=inline.notes + summary.notes,
            failed=inline.failed + summary.failed,
            payloads=inline.payloads + summary.payloads,
            summary_note_id=summary.summary_note_id,
        )
