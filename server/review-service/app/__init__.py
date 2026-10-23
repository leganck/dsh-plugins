"""评审服务（review-service）—— 面向 GitLab MR 的自研 AI 评审。

设计约束（与 code-index-service 保持一致）：
- 只用标准库：不引入 fastapi/httpx/redis，镜像能压到最小，单测不需要装任何依赖。
- 队列与状态放 SQLite（WAL），单机可跑，多 worker 也能跑（表级租约）。
- 模型调用统一走 OpenAI 兼容的 /chat/completions，可换 DeepSeek / 内网网关。

这个包对外只暴露 main.run()，其余模块可单独 import 做单测。
"""

__version__ = "0.2.2"
