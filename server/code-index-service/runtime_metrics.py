"""轻量运行指标采集：CPU / 内存 / GPU。

不依赖 psutil；容器内优先读 cgroup v2，失败回退 /proc。
GPU 通过 nvidia-smi 读取；没有 GPU 或命令不可用时返回 available=False，不抛异常。
"""

from __future__ import annotations

import csv
import io
import os
import shutil
import subprocess
import threading
import time

_LOCK = threading.Lock()
_CACHE = {"at": 0.0, "value": None}
_CACHE_TTL = 1.0
_GPU_CACHE = {"at": 0.0, "value": None}
_GPU_CACHE_TTL = 2.0
_CPU_PREV = {"cgroup": None, "proc": None}


def _read_text(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def _cgroup_v2(name: str) -> str | None:
    return _read_text(os.path.join("/sys/fs/cgroup", name))


def _cpu_count() -> int:
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        return max(1, os.cpu_count() or 1)


def _load_avg():
    try:
        return [round(x, 2) for x in os.getloadavg()]
    except (AttributeError, OSError):
        return [None, None, None]


def _cgroup_cpu_percent() -> float | None:
    text = _cgroup_v2("cpu.stat")
    if not text:
        return None
    usage = None
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == "usage_usec":
            try:
                usage = int(parts[1])
            except ValueError:
                return None
            break
    if usage is None:
        return None
    now = time.monotonic()
    with _LOCK:
        prev = _CPU_PREV["cgroup"]
        _CPU_PREV["cgroup"] = (usage, now)
    if not prev:
        return None
    delta_usage = usage - prev[0]
    delta_t = now - prev[1]
    if delta_t <= 0 or delta_usage < 0:
        return None
    return round(max(0.0, delta_usage / (delta_t * 1_000_000.0) * 100.0), 1)


def _proc_cpu_percent() -> float | None:
    text = _read_text("/proc/stat")
    if not text:
        return None
    first = text.splitlines()[0].split()
    if len(first) < 5 or first[0] != "cpu":
        return None
    try:
        nums = [int(x) for x in first[1:]]
    except ValueError:
        return None
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
    total = sum(nums)
    now = time.monotonic()
    with _LOCK:
        prev = _CPU_PREV["proc"]
        _CPU_PREV["proc"] = (total, idle, now)
    if not prev:
        return None
    dt = now - prev[2]
    dtotal = total - prev[0]
    didle = idle - prev[1]
    if dt <= 0 or dtotal <= 0:
        return None
    return round(max(0.0, min(100.0, (1.0 - didle / dtotal) * 100.0)), 1)


def _memory() -> dict:
    text = _cgroup_v2("memory.current")
    max_text = _cgroup_v2("memory.max")
    if text:
        try:
            used = int(text.strip())
        except ValueError:
            used = None
        total = None
        if max_text and max_text.strip() != "max":
            try:
                total = int(max_text.strip())
            except ValueError:
                total = None
        if used is not None and total and total > 0:
            return {
                "usedBytes": used,
                "totalBytes": total,
                "percent": round(max(0.0, min(100.0, used * 100.0 / total)), 1),
                "source": "cgroup-v2",
            }
    meminfo = _read_text("/proc/meminfo")
    if meminfo:
        vals = {}
        for line in meminfo.splitlines():
            key, _, rest = line.partition(":")
            try:
                vals[key] = int(rest.strip().split()[0]) * 1024
            except (ValueError, IndexError):
                continue
        total = vals.get("MemTotal")
        avail = vals.get("MemAvailable")
        if total and avail is not None:
            used = max(0, total - avail)
            return {
                "usedBytes": used,
                "totalBytes": total,
                "percent": round(max(0.0, min(100.0, used * 100.0 / total)), 1),
                "source": "/proc/meminfo",
            }
    return {"usedBytes": None, "totalBytes": None, "percent": None, "source": "unavailable"}


def _num(value):
    text = str(value or "").strip()
    if not text or text.upper() in ("N/A", "[N/A]", "NA"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _gpu_snapshot() -> dict:
    now = time.monotonic()
    with _LOCK:
        if _GPU_CACHE["value"] is not None and now - _GPU_CACHE["at"] < _GPU_CACHE_TTL:
            return _GPU_CACHE["value"]
    exe = shutil.which("nvidia-smi")
    if not exe:
        out = {"available": False, "source": "nvidia-smi", "reason": "nvidia-smi not found", "devices": []}
    else:
        query = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit"
        try:
            proc = subprocess.run(
                [exe, f"--query-gpu={query}", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=1.5, check=False,
            )
            if proc.returncode != 0:
                out = {"available": False, "source": "nvidia-smi", "reason": (proc.stderr or "failed").strip()[:200], "devices": []}
            else:
                devices = []
                for row in csv.reader(io.StringIO(proc.stdout)):
                    if len(row) < 8:
                        continue
                    try:
                        index = int(row[0].strip())
                    except ValueError:
                        index = len(devices)
                    used = _num(row[3])
                    total = _num(row[4])
                    devices.append({
                        "index": index,
                        "name": row[1].strip(),
                        "utilizationPercent": _num(row[2]),
                        "memoryUsedBytes": int(used) if used is not None else None,
                        "memoryTotalBytes": int(total) if total is not None else None,
                        "memoryPercent": round(used * 100.0 / total, 1) if used is not None and total else None,
                        "temperatureC": _num(row[5]),
                        "powerW": _num(row[6]),
                        "powerLimitW": _num(row[7]),
                    })
                out = {"available": bool(devices), "source": "nvidia-smi",
                       "reason": None if devices else "no GPU reported", "devices": devices}
        except (OSError, subprocess.TimeoutExpired) as exc:
            out = {"available": False, "source": "nvidia-smi", "reason": str(exc)[:200], "devices": []}
    with _LOCK:
        _GPU_CACHE.update(at=now, value=out)
    return out


def snapshot() -> dict:
    """返回可 JSON 序列化的运行指标；任何子采样失败都不抛。"""
    now = time.monotonic()
    with _LOCK:
        if _CACHE["value"] is not None and now - _CACHE["at"] < _CACHE_TTL:
            return _CACHE["value"]
    cgroup_pct = _cgroup_cpu_percent()
    cpu_pct = cgroup_pct if cgroup_pct is not None else _proc_cpu_percent()
    value = {
        "sampledAt": time.time(),
        "cpu": {
            "percent": cpu_pct,
            "cores": _cpu_count(),
            "load": _load_avg(),
            "source": "cgroup-v2" if cgroup_pct is not None else "/proc/stat",
        },
        "memory": _memory(),
        "gpu": _gpu_snapshot(),
    }
    with _LOCK:
        _CACHE.update(at=now, value=value)
    return value
