"""配置：全部来自环境变量（12-factor），启动时校验必填项并给出可执行的报错。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .pipeline import DEFAULT_GUIDELINES_PATHS, DEFAULT_IGNORE_GLOBS, ReviewSettings
from .util import env_bool, env_float, env_int, env_str, log

# 档3：索引作用域模式（契约见 server/code-index-service/docs/scope-tier3.md §7）
SCOPE_MODES = ("repo", "branch", "pr")


class ConfigError(RuntimeError):
    pass


def _parse_scope_mode(text: str) -> str:
    """INDEX_SCOPE_MODE 只认 repo|branch|pr；写错时退回默认 repo（启动不因笔误失败）。"""
    value = (text or "").strip().lower()
    if not value:
        return "repo"
    if value not in SCOPE_MODES:
        log(f"INDEX_SCOPE_MODE={text!r} 非法（可选 {'|'.join(SCOPE_MODES)}），按 repo 处理")
        return "repo"
    return value


@dataclass
class AppConfig:
    # 服务
    port: int = 8000
    bind: str = "0.0.0.0"
    data_dir: str = "/data"
    workers: int = 2
    dry_run: bool = False
    log_level: str = "info"

    # GitLab
    gitlab_url: str = ""
    gitlab_token: str = ""
    webhook_secret: str = ""
    gitlab_rps: float = 8.0

    # LLM
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_api_key: str = ""
    llm_model: str = "deepseek-chat"
    llm_timeout: float = 120.0
    llm_temperature: float = 0.0

    # 索引服务（可选；不配就退化为"没有上下文"）
    index_url: str = ""
    index_api_key: str = ""
    index_namespace: str = ""
    index_namespace_map: dict = field(default_factory=dict)
    # 档3：作用域快照（repo=旧行为不变；branch=按目标分支；pr=按 MR，可选 head 临时作用域）
    index_scope_mode: str = "repo"
    index_pr_head: bool = False

    # 预算
    max_calls: int = 24
    max_tokens_in: int = 160_000
    max_tokens_out: int = 20_000

    review: ReviewSettings = field(default_factory=ReviewSettings)
    ignore_globs: tuple[str, ...] = DEFAULT_IGNORE_GLOBS
    guidelines_paths: tuple[str, ...] = DEFAULT_GUIDELINES_PATHS

    # ---- 上下文获取（P1：镜像仓 + 索引 + 图谱）----
    git_strategy: str = "api"          # api | clone
    mirror_dir: str = "/data/mirrors"
    worktree_dir: str = "/data/worktrees"
    mirror_ttl_days: float = 30.0
    max_worktrees: int = 6
    index_sync: bool = False
    index_sync_min_interval: int = 600
    index_repo_prefix: str = "repo"
    index_chunk_fp: str = "review-1"
    graph_enabled: bool = False
    graph_evidence_confidence: float = 0.8
    review_concurrency: int = 4
    review_deadline_s: float = 300.0
    gc_interval_s: float = 3600.0

    @property
    def db_path(self) -> str:
        return os.path.join(self.data_dir, "review.db")

    def validate(self) -> None:
        missing = []
        if not self.gitlab_url:
            missing.append("GITLAB_URL（如 https://gitlab.example.com）")
        if not self.gitlab_token:
            missing.append("GITLAB_TOKEN（bot 用户的 PAT，scope=api）")
        if not self.webhook_secret:
            missing.append("WEBHOOK_SECRET（GitLab webhook 的 Secret token）")
        if not self.llm_api_key:
            missing.append("LLM_API_KEY（模型服务密钥）")
        if missing:
            raise ConfigError(
                "缺少必填环境变量：\n  - " + "\n  - ".join(missing) + "\n参考 .env.example"
            )


def _parse_json_map(text: str) -> dict:
    """把 `INDEX_NAMESPACE_MAP='{"12":"energy@rev"}'` 解析成 dict；坏 JSON 不影响启动。"""
    if not text.strip():
        return {}
    try:
        import json

        data = json.loads(text)
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def load_config(env: dict | None = None) -> AppConfig:
    """从环境变量装配配置；`env` 参数只给测试用。"""
    if env is not None:
        os.environ.update({k: str(v) for k, v in env.items()})

    review = ReviewSettings(
        model=env_str("LLM_MODEL", "deepseek-chat"),
        guidelines_paths=tuple(
            s.strip() for s in env_str("GUIDELINES_PATHS", "").split(",") if s.strip()
        )
        or DEFAULT_GUIDELINES_PATHS,
        ignore_globs=tuple(s.strip() for s in env_str("IGNORE_GLOBS", "").split(",") if s.strip())
        or DEFAULT_IGNORE_GLOBS,
        max_files=env_int("MAX_FILES", 30),
        max_added_lines_per_file=env_int("MAX_LINES_PER_FILE", 120),
        max_diff_chars=env_int("MAX_DIFF_CHARS", 60_000),
        min_confidence=env_float("MIN_CONFIDENCE", 0.7),
        severity_floor=env_str("SEVERITY_FLOOR", "minor"),
        max_per_file=env_int("MAX_PER_FILE", 3),
        max_total=env_int("MAX_TOTAL", 15),
        max_blocks=env_int("MAX_BLOCKS", 6),
        max_context_chunks=env_int("MAX_CONTEXT_CHUNKS", 6),
        max_verifier_steps=env_int("MAX_VERIFIER_STEPS", 2),
        max_candidates=env_int("MAX_CANDIDATES", 20),
        timeout_s=env_float("REVIEW_TIMEOUT", 300.0),
    )

    cfg = AppConfig(
        port=env_int("PORT", 8000),
        bind=env_str("BIND", "0.0.0.0"),
        data_dir=env_str("DATA_DIR", "/data"),
        workers=max(1, env_int("WORKERS", 2)),
        dry_run=env_bool("DRY_RUN", False),
        gitlab_url=env_str("GITLAB_URL", ""),
        gitlab_token=env_str("GITLAB_TOKEN", ""),
        webhook_secret=env_str("WEBHOOK_SECRET", ""),
        gitlab_rps=env_float("GITLAB_RPS", 8.0),
        llm_base_url=env_str("LLM_BASE_URL", "https://api.deepseek.com/v1"),
        llm_api_key=env_str("LLM_API_KEY", ""),
        llm_model=env_str("LLM_MODEL", "deepseek-chat"),
        llm_timeout=env_float("LLM_TIMEOUT", 120.0),
        llm_temperature=env_float("LLM_TEMPERATURE", 0.0),
        index_url=env_str("INDEX_URL", ""),
        index_api_key=env_str("INDEX_API_KEY", ""),
        index_namespace=env_str("INDEX_NAMESPACE", ""),
        index_namespace_map=_parse_json_map(env_str("INDEX_NAMESPACE_MAP", "")),
        index_scope_mode=_parse_scope_mode(env_str("INDEX_SCOPE_MODE", "repo")),
        index_pr_head=env_bool("INDEX_PR_HEAD", False),
            max_calls=env_int("MAX_LLM_CALLS", 24),
        max_tokens_in=env_int("MAX_TOKENS_IN", 160_000),
        max_tokens_out=env_int("MAX_TOKENS_OUT", 20_000),
        review=review,
        ignore_globs=review.ignore_globs,
        guidelines_paths=review.guidelines_paths,
        git_strategy=env_str("GIT_STRATEGY", "api"),
        mirror_dir=env_str("MIRROR_DIR", "/data/mirrors"),
        worktree_dir=env_str("WORKTREE_DIR", "/data/worktrees"),
        mirror_ttl_days=env_float("MIRROR_TTL_DAYS", 30.0),
        max_worktrees=env_int("MAX_WORKTREES", 6),
        index_sync=env_bool("INDEX_SYNC", False),
        index_sync_min_interval=env_int("INDEX_SYNC_MIN_INTERVAL", 600),
        index_repo_prefix=env_str("INDEX_REPO_PREFIX", "repo"),
        index_chunk_fp=env_str("INDEX_CHUNK_FP", "review-1"),
        graph_enabled=env_bool("GRAPH_ENABLED", False),
        graph_evidence_confidence=env_float("GRAPH_EVIDENCE_CONFIDENCE", 0.8),
        review_concurrency=env_int("REVIEW_CONCURRENCY", 4),
        review_deadline_s=env_float("REVIEW_DEADLINE_S", 300.0),
        gc_interval_s=env_float("GC_INTERVAL_S", 3600.0),
    )
    return cfg
