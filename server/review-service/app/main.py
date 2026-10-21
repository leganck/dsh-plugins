"""服务入口：`python -m app.main`（容器 ENTRYPOINT 会直接跑它）。

启动顺序：读配置 → 校验 → 打开 SQLite → 起 worker 线程 → 起 HTTP → 等信号。
配置缺失时按 EX_CONFIG(78) 退出，并在日志里逐条列出缺什么。
"""

from __future__ import annotations

import os
import signal
import sys
import threading
import time

from .clients import index_client_from_env
from .config import ConfigError, load_config
from .server import serve
from .store import open_store
from .util import log
from .worker import Worker

EX_CONFIG = 78


def main() -> int:
    cfg = load_config()
    try:
        cfg.validate()
    except ConfigError as e:
        log(f"配置错误：\n{e}")
        return EX_CONFIG

    os.makedirs(cfg.data_dir, exist_ok=True)
    store = open_store(cfg.db_path)
    index = index_client_from_env()
    if cfg.index_url:
        health = index.health()
        log(f"索引服务：{cfg.index_url} tag={health.get('tag')} ready={health.get('ready')}")
    else:
        log("索引服务未配置（INDEX_URL 为空）→ 评审将没有跨文件上下文，只按 diff 本身审")

    stop = threading.Event()
    workers = [Worker(str(i + 1), cfg, store, stop, index) for i in range(cfg.workers)]
    for w in workers:
        w.start()

    httpd = serve(cfg, store, cfg.bind, cfg.port)

    def shutdown(signum, _frame):
        log(f"收到信号 {signum}，准备退出")
        stop.set()
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        stop.set()
        for w in workers:
            w.join(timeout=5)
        log("已退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
