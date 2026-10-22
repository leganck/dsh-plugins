"""模型切换预检：根据当前运行时和模型元数据提示潜在问题。

纯函数，不加载 ONNX；服务端把 state 中的 providers 和 runtime_metrics 结果传进来。
"""

from __future__ import annotations


def _warning(code: str, level: str, message: str) -> dict:
    return {"code": code, "level": level, "message": message}


def preflight(*, kind: str, model: dict, runtime: dict, active: dict | None = None) -> dict:
    """返回 {warnings, blocking, runtime, model, active}。

    所有警告默认非阻塞；只有模型本身非法由调用方返回 400。
    """
    active = active or {}
    warnings = []
    device = str(runtime.get("device") or "cpu").lower()
    gpu_available = bool(runtime.get("gpuAvailable"))
    gpu_name = runtime.get("gpuName") or "GPU"
    free = runtime.get("vramFreeBytes")
    available_providers = runtime.get("availableProviders") or []
    active_providers = runtime.get("activeProviders") or []
    model_bytes = int(model.get("modelBytes") or 0)
    model_dim = model.get("dim")
    active_dim = active.get("dim")

    if kind == "embed":
        if model.get("tag") and active.get("tag") and model["tag"] != active["tag"]:
            warnings.append(_warning(
                "embed-tag-change", "warn",
                "切换后向量 tag 会变化：旧向量保留但检索不到，客户端需要重新同步/重嵌。",
            ))
        if model_dim and active_dim and int(model_dim) != int(active_dim):
            warnings.append(_warning(
                "dimension-change", "warn",
                f"向量维度将从 {active_dim} 变为 {model_dim}；所有作用域需要重建向量，存储占用也会增加。",
            ))

    if device != "cuda" or not gpu_available:
        warnings.append(_warning(
            "cpu-runtime", "warn",
            "当前没有可用的 CUDA/GPU：模型会在 CPU 上运行，嵌入/重排会明显变慢。",
        ))
    elif "CUDAExecutionProvider" in available_providers and "CUDAExecutionProvider" not in active_providers:
        warnings.append(_warning(
            "provider-fallback", "warn",
            "运行时可见 CUDA，但当前 ORT active provider 没有 CUDA；模型可能仍跑在 CPU。",
        ))

    if gpu_available and free is not None and model_bytes:
        # 只做数量级估算：模型权重 + 约 512MB 运行时/激活余量。
        need = model_bytes + 512 * 1024 * 1024
        if int(free) < need:
            warnings.append(_warning(
                "vram-low", "danger",
                f"{gpu_name} 可用显存约 {_fmt_bytes(free)}，模型约 {_fmt_bytes(model_bytes)}"
                f"（加 512MB 余量估算需 {_fmt_bytes(need)}）；可能 OOM 或降级到 CPU。",
            ))

    if kind == "rerank" and device != "cuda":
        warnings.append(_warning(
            "rerank-cpu", "warn",
            "重排在 CPU 上运行；单次查询可能增加明显延迟，建议只在对精度要求高时启用。",
        ))

    # 同一 code 只保留一条，避免 CPU/CPU-rerank 重复刷屏优先级：rerank 专属提示保留。
    seen = set()
    uniq = []
    for w in warnings:
        if w["code"] in seen:
            continue
        seen.add(w["code"])
        uniq.append(w)
    return {
        "warnings": uniq,
        "blocking": False,
        "runtime": runtime,
        "model": model,
        "active": active,
    }


def _fmt_bytes(value) -> str:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "?"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024.0
    return "?"
