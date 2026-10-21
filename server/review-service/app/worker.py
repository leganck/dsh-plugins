"""worker：抢占任务 → 取数（clone 或 API）→ 建索引/图谱 → 跑流水线 → 发布 → 落库。

两种取数策略（`GIT_STRATEGY`）：
- `api`：GitLab `/diffs` + raw 文件（原路径，零磁盘，但 `too_large` 文件是盲区）；
- `clone`：镜像仓 + worktree + 本地 `git diff`（推荐；覆盖 too_large，能建图谱/索引）。

容错：
- clone 失败自动回退 API（并在汇总里如实说明）；
- 索引/图谱失败不阻塞评审（降级为"只按 diff 审"）；
- 任务有租约，worker 崩溃后过期重抢；同 diff 内容指纹重复直接 skipped。
"""

from __future__ import annotations

import threading
import time

from .clients import GitLabClient, IndexClient, gitlab_file_reader
from .config import AppConfig
from .context import ContextSettings
from .diff import mr_fingerprint, parse_gitlab_diffs
from .gitdiff import git_diff
from .graph import Graph
from .index_state import IndexState
from .llm import Budget, LLM
from .parallel import Deadline
from .pipeline import ReviewSettings, outcome_payload, run_review
from .publish import Publisher
from .repo import MirrorManager
from .store import Store
from .sync import IndexSync
from .util import log


def is_superseded(reviewed: str, current: str) -> bool:
    """评审期间分支又 push 了？两边都有值且不同才算（查不到时不拦）。"""
    return bool(reviewed and current and reviewed != current)


def resolve_namespace(cfg: AppConfig, project_id: str | int) -> str:
    """索引命名空间：优先按项目映射，其次全局默认，最后空（无上下文检索）。"""
    mapping = cfg.index_namespace_map
    if mapping.get(str(project_id)):
        return mapping[str(project_id)]
    return cfg.index_namespace


class Worker(threading.Thread):
    def __init__(self, name: str, cfg: AppConfig, store: Store, stop_event: threading.Event, index: IndexClient):
        super().__init__(name=f"worker-{name}", daemon=True)
        self.cfg = cfg
        self.store = store
        self.stop_event = stop_event
        self.index = index
        self.poll_interval = 1.0
        self.mirrors = MirrorManager(cfg.mirror_dir, cfg.worktree_dir) if cfg.git_strategy == "clone" else None
        self.index_state = IndexState(store.path)
        self._sync_last: dict[str, float] = {}
        self._last_gc = 0.0

    # ------------------------------------------------------------ 主循环

    def run(self) -> None:
        log(f"{self.name} 启动（取数策略={self.cfg.git_strategy}，索引同步={self.cfg.index_sync}，图谱={self.cfg.graph_enabled}）")
        if self.mirrors is not None:
            try:
                self.mirrors.prune()
            except Exception as e:  # noqa: BLE001
                log(f"{self.name} 启动清理失败（忽略）：{e}")
        while not self.stop_event.is_set():
            job = None
            try:
                job = self.store.claim(lease_seconds=900.0)
            except Exception as e:  # noqa: BLE001
                log(f"{self.name} 抢任务失败：{e}")
            if not job:
                self._maybe_gc()
                self.stop_event.wait(self.poll_interval)
                continue
            try:
                self.process(job)
            except Exception as e:  # noqa: BLE001
                status = self.store.fail(int(job["id"]), f"{type(e).__name__}: {e}")
                log(f"{self.name} 任务 #{job['id']} 失败（-> {status}）：{type(e).__name__}: {e}")
        log(f"{self.name} 退出")

    # ------------------------------------------------------------ 单个任务

    def process(self, job: dict) -> None:
        cfg = self.cfg
        job_id = int(job["id"])
        project_id = str(job["project_id"])
        iid = int(job["mr_iid"])
        log(f"{self.name} 处理 #{job_id}（project={project_id} MR !{iid}）")

        gitlab = GitLabClient(cfg.gitlab_url, cfg.gitlab_token, timeout=30.0, rps=cfg.gitlab_rps)
        mr = gitlab.mr(project_id, iid)
        target_branch = str(mr.get("target_branch") or "main")
        refs = {}
        try:
            refs = gitlab.diff_refs(project_id, iid) or {}
        except Exception as e:  # noqa: BLE001
            log(f"取 diff_refs 失败（行内评论会降级为 note）：{e}")

        files = None
        diffs: list[dict] = []
        reader = None
        worktree_head = ""
        worktree_base = ""
        graph = None
        namespace = resolve_namespace(cfg, project_id)
        state = self.index_state.get(project_id, target_branch) or {}
        degrade_notes: list[str] = []

        reviewed_head = ""
        try:
            if cfg.git_strategy == "clone" and self.mirrors is not None:
                try:
                    worktree_head, worktree_base, files, namespace, reviewed_head = self._prepare_clone(
                        gitlab, project_id, iid, mr, target_branch, state, degrade_notes
                    )
                    from .clients import LocalDirReader

                    reader = LocalDirReader(worktree_head)
                except Exception as e:  # noqa: BLE001 —— 回退 API
                    degrade_notes.append(f"镜像仓取数失败，回退 API：{type(e).__name__}: {e}")
                    log(f"#{job_id} clone 策略失败，回退 API：{e}")
                    files = None

            if files is None:
                diffs = gitlab.diffs(project_id, iid)
                files = parse_gitlab_diffs(diffs, list(cfg.review.ignore_globs))
                reader = gitlab_file_reader(gitlab, project_id, refs.get("base_sha") or target_branch)
                reviewed_head = str(refs.get("head_sha") or "")

            fp = mr_fingerprint(files)
            self.store.set_diff_fp(job_id, fp)
            done = self.store.find_done(project_id, iid, fp)
            if done and int(done["id"]) != job_id:
                log(f"#{job_id} 与已完成 #{done['id']} 的 diff 相同（rebase/重投），跳过")
                self.store.finish(job_id, status="skipped", payload={"reason": "duplicate-diff", "diff_fp": fp})
                return

            # 图谱（base 分支）
            if cfg.graph_enabled and worktree_base:
                try:
                    graph = Graph(self.store.path, project_id=project_id, branch=target_branch)
                    stats = graph.build(worktree_base, commit_sha=str(refs.get("base_sha") or ""))
                    log(f"#{job_id} 图谱：符号 {stats['symbols']} / 边 {stats['edges']} / {stats['ms']} ms")
                    if stats.get("degraded"):
                        degrade_notes.append(f"图谱降级：{len(stats['degraded'])} 个文件（{stats['degraded'][0]['reason']}）")
                except Exception as e:  # noqa: BLE001
                    degrade_notes.append(f"图谱构建失败（忽略）：{type(e).__name__}: {e}")

            # 索引同步（async-ish：同一项目有最小间隔）
            if cfg.index_sync and cfg.index_url and worktree_base:
                namespace = self._maybe_sync_index(project_id, target_branch, worktree_base, state, degrade_notes) or namespace

            llm = LLM(
                cfg.llm_base_url,
                cfg.llm_api_key,
                cfg.llm_model,
                temperature=cfg.llm_temperature,
                timeout=cfg.llm_timeout,
                budget=Budget(cfg.max_calls, cfg.max_tokens_in, cfg.max_tokens_out),
            )
            settings: ReviewSettings = cfg.review
            outcome = run_review(
                mr=mr,
                diffs=diffs or None,
                files=files,
                llm=llm,
                index=self.index,
                reader=reader,
                settings=settings,
                namespace=namespace,
                posted_keys=self.store.posted_keys(project_id, iid),
                graph=graph,
                worktree=worktree_base,
                context_settings=ContextSettings(max_chunks=settings.max_context_chunks),
                concurrency=cfg.review_concurrency,
                deadline_s=cfg.review_deadline_s,
            )
            if degrade_notes:
                outcome.summary += "\n\n" + "\n".join(f"> ⚠️ {n}" for n in degrade_notes)

            # D8：发布前重取 head_sha。评审期间又 push 了就标 superseded，不发过期评论。
            superseded = False
            current_head = ""
            try:
                latest = gitlab.mr(project_id, iid)
                current_head = str(latest.get("sha") or (gitlab.diff_refs(project_id, iid) or {}).get("head_sha") or "")
                superseded = is_superseded(reviewed_head, current_head)
            except Exception as e:  # noqa: BLE001 —— 查不到就照常发（宁发不漏）
                log(f"#{job_id} supersede 检查失败（继续发布）：{type(e).__name__}: {e}")
            if superseded:
                log(f"#{job_id} 分支在评审期间又变了（{reviewed_head[:8]} → {current_head[:8]}），标记 superseded")
                self.store.finish(
                    job_id,
                    status="skipped",
                    payload={
                        "reason": "superseded",
                        "reviewed_head": reviewed_head,
                        "current_head": current_head,
                        "stats": outcome.validation.stats,
                    },
                    model=cfg.llm_model,
                    tokens_in=llm.budget.usage.tokens_in,
                    tokens_out=llm.budget.usage.tokens_out,
                    latency_ms=int(outcome.seconds * 1000),
                )
                return

            publisher = Publisher(gitlab, project_id, iid, refs, dry_run=bool(job.get("dry_run")) or cfg.dry_run)
            pres = publisher.publish(outcome)

            payload = outcome_payload(outcome)
            payload["publish"] = {
                "posted": pres.posted,
                "notes": pres.notes,
                "failed": pres.failed,
                "dry_run": publisher.dry_run,
            }
            payload["strategy"] = "clone" if files and worktree_head else "api"
            payload["degraded"] = degrade_notes
            if publisher.dry_run:
                payload["dry_run_payloads"] = pres.payloads

            findings = [
                {
                    "path": f.file,
                    "line": f.line,
                    "severity": f.severity,
                    "category": f.category,
                    "message": f.message,
                    "confidence": f.confidence,
                    "evidence": f.evidence,
                    "suggestion": f.suggestion,
                    "dedupe_key": f.fingerprint(),
                }
                for f in outcome.validation.posted
            ]
            self.store.record_findings(job_id, findings, {f["dedupe_key"] for f in findings})
            self.store.record_transcript(job_id, [{"step": "llm", **e} for e in llm.transcript])
            self.store.finish(
                job_id,
                payload=payload,
                model=cfg.llm_model,
                tokens_in=llm.budget.usage.tokens_in,
                tokens_out=llm.budget.usage.tokens_out,
                latency_ms=int(outcome.seconds * 1000),
                status="done",
            )
            log(
                f"#{job_id} 完成（{payload['strategy']}）：{len(outcome.validation.posted)} 条行内 / 共 {pres.posted} 条，"
                f"丢弃 {outcome.validation.stats.get('dropped', 0)} 条，"
                f"tokens {llm.budget.usage.tokens_in}/{llm.budget.usage.tokens_out}，{outcome.seconds}s"
            )
        finally:
            if self.mirrors is not None and worktree_head:
                try:
                    self.mirrors.remove_worktree(project_id, f"mr-{iid}-{job_id}")
                except Exception as e:  # noqa: BLE001
                    log(f"清理 worktree 失败（忽略）：{e}")

    # ------------------------------------------------------------ clone 策略

    def _prepare_clone(
        self,
        gitlab: GitLabClient,
        project_id: str,
        iid: int,
        mr: dict,
        target_branch: str,
        state: dict,
        notes: list[str],
    ) -> tuple[str, str, list, str, str]:
        assert self.mirrors is not None
        project = gitlab.project(project_id)
        git_url = project.get("http_url_to_repo") or project.get("ssh_url_to_repo") or ""
        if not git_url:
            raise RuntimeError("项目没有 http_url_to_repo，无法克隆")
        self.mirrors.ensure_mirror(project_id, git_url)
        self.mirrors.fetch_merge_request(project_id, iid, target_branch)

        head_ref = f"refs/mr/{iid}"
        head_sha = self.mirrors.rev_parse(project_id, head_ref)
        base_ref = f"refs/heads/{target_branch}"
        base_sha = self.mirrors.rev_parse(project_id, base_ref)

        # base 工作树长期复用（建图/索引/grep 用）
        base_wt = self.mirrors.add_worktree(project_id, base_sha, f"base-{target_branch}", reuse=True)
        head_wt = self.mirrors.add_worktree(project_id, head_sha, f"mr-{iid}-{state.get('job_id', '')}", reuse=False)
        files = git_diff(head_wt, base_sha, head_sha)
        lines = sum(len(f.added_lines()) for f in files)
        log(f"本地 diff：{len(files)} 文件 / {lines} 新增行（base={base_sha[:8]} head={head_sha[:8]}）")
        namespace = f"{self.cfg.index_repo_prefix}-{project_id}@{self.cfg.index_chunk_fp}"
        return head_wt, base_wt, files, namespace, head_sha

    # ------------------------------------------------------------ 运维

    def _maybe_gc(self) -> None:
        """空闲时做一次镜像/worktree 清理（默认每小时）。"""
        import time as _t

        cfg = self.cfg
        if self.mirrors is None or cfg.gc_interval_s <= 0:
            return
        now = _t.monotonic()
        if now - self._last_gc < cfg.gc_interval_s:
            return
        self._last_gc = now
        try:
            pruned = self.mirrors.prune()
            removed = self.mirrors.gc(cfg.mirror_ttl_days)
            if removed:
                log(f"镜像 GC：删除 {removed} 个超过 {cfg.mirror_ttl_days} 天未用的镜像")
            log(f"worktree 清理完成（{pruned} 个镜像）")
        except Exception as e:  # noqa: BLE001
            log(f"GC 失败（忽略）：{type(e).__name__}: {e}")

    # ------------------------------------------------------------ 索引同步

    def _maybe_sync_index(self, project_id: str, branch: str, worktree_base: str, state: dict, notes: list[str]) -> str | None:
        cfg = self.cfg
        now = time.monotonic()
        last = self._sync_last.get(project_id, 0.0)
        if now - last < cfg.index_sync_min_interval:
            return state.get("namespace")
        self._sync_last[project_id] = now
        try:
            sync = IndexSync(cfg.index_url, cfg.index_api_key)
            res = sync.sync_worktree(
                worktree_base,
                repo_id=f"{cfg.index_repo_prefix}-{project_id}",
                repo_url="",
                tag=None,
                chunk_fp=cfg.index_chunk_fp,
                state=state,
                no_embed=False,
            )
            self.index_state.upsert(
                project_id,
                branch,
                namespace=res.namespace,
                repo_state=res.repo_state,
                revision=res.revision,
                tag=state.get("tag"),
                last_synced_sha=str(state.get("last_synced_sha") or ""),
                last_error=None,
            )
            log(f"索引同步：{res.namespace} revision={res.revision} chunks={res.chunks} missing={res.missing} {res.ms}ms")
            return res.namespace
        except Exception as e:  # noqa: BLE001
            self.index_state.set_error(project_id, branch, f"{type(e).__name__}: {e}")
            notes.append(f"索引同步失败（降级为无跨文件语义上下文）：{type(e).__name__}: {e}")
            log(f"索引同步失败：{e}")
            return state.get("namespace")


__all__ = ["Worker", "resolve_namespace", "Deadline"]
