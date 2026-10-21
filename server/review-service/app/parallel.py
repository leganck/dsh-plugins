"""有界并行：线程池 + 全局 deadline + 结果顺序稳定。

评审里的并行只用于"多 block 的 Reviewer"和"多候选的 Verifier"：
- 并发度默认 4（`REVIEW_CONCURRENCY`）；
- 全局 deadline（默认 300 s）到点后不再提交新任务，已完成的照常聚合；
- 返回顺序与输入一致，保证 transcript / 汇总可复现（并行不引入不确定性）。
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field


@dataclass
class Deadline:
    seconds: float = 300.0
    _start: float = field(default_factory=time.monotonic)

    def remaining(self) -> float:
        return max(0.0, self.seconds - (time.monotonic() - self._start))

    def expired(self) -> bool:
        return self.remaining() <= 0.0


def map_limited(
    fn, items, *, concurrency: int = 4, deadline: Deadline | None = None, raise_on: tuple[type, ...] = ()
) -> list[dict]:
    """对 items 并行执行 fn(item)，返回与输入等长的 [{ok, value, error}]。

    - fn 抛异常不会中断整体（记 error）；
    - deadline 到点后剩余项标记为 error="deadline"，不再执行。
    """
    items = list(items)
    results: list[dict] = [{"ok": False, "value": None, "error": "not-run"} for _ in items]
    if not items:
        return results
    workers = max(1, int(concurrency))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {}
        for i, item in enumerate(items):
            if deadline is not None and deadline.expired():
                results[i] = {"ok": False, "value": None, "error": "deadline"}
                continue
            futures[pool.submit(fn, item)] = i
        for fut, i in futures.items():
            try:
                results[i] = {"ok": True, "value": fut.result(), "error": ""}
            except Exception as e:  # noqa: BLE001 —— 单个任务失败不影响其它
                if raise_on and isinstance(e, raise_on):
                    raise  # 预算超限这类必须向上冒泡，由 pipeline 收敛
                results[i] = {"ok": False, "value": None, "error": f"{type(e).__name__}: {e}"}
    return results


__all__ = ["Deadline", "map_limited"]
