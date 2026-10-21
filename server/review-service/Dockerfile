# 自研 AI 评审服务：Python 标准库 + tree-sitter 两包；需要 git 客户端（镜像仓/worktree）。
ARG PYTHON_IMAGE=python:3.11-slim-bookworm
FROM ${PYTHON_IMAGE}

ARG VERSION=dev
LABEL org.opencontainers.image.title="dsh-review" \
      org.opencontainers.image.description="自研 GitLab MR AI 评审服务（Planner/Reviewer/Verifier + 镜像仓/语法图）" \
      org.opencontainers.image.source="https://github.com/leganck/dsh-plugins" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DATA_DIR=/data \
    PORT=8000 \
    BIND=0.0.0.0 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_LFS_SKIP_SMUDGE=1

# git：镜像仓 + worktree（不 clone 全仓、只读工作树）；ca-certificates：https 访问 GitLab
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# tree-sitter：切块与语法图（两个 wheel，无编译；language-pack 覆盖 372 种语言）
RUN pip install --no-cache-dir --disable-pip-version-check \
      "tree-sitter==0.26.0" \
      "tree-sitter-language-pack==1.22.1"

WORKDIR /app
COPY app ./app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && useradd -u 10001 -m -s /usr/sbin/nologin app \
 && mkdir -p /data/mirrors /data/worktrees /data/index \
 && chown -R app:app /app /data

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8000

# 健康检查用标准库（镜像里没有 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import sys,urllib.request;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3).status==200 else 1)"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-u", "-m", "app.main"]
