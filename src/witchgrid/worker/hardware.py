"""Local hardware introspection. Used at registration + heartbeat."""

from __future__ import annotations

import socket

import psutil

from ..cp.types import GpuInfo, Hardware


def hostname() -> str:
    return socket.gethostname()


def _gpus() -> list[GpuInfo]:
    try:
        from pynvml import (  # type: ignore[import-not-found]
            nvmlDeviceGetCount,
            nvmlDeviceGetHandleByIndex,
            nvmlDeviceGetMemoryInfo,
            nvmlDeviceGetName,
            nvmlDeviceGetUtilizationRates,
            nvmlInit,
            nvmlShutdown,
        )
    except ImportError:
        return []

    out: list[GpuInfo] = []
    try:
        nvmlInit()
        try:
            for i in range(nvmlDeviceGetCount()):
                h = nvmlDeviceGetHandleByIndex(i)
                name = nvmlDeviceGetName(h)
                if isinstance(name, bytes):
                    name = name.decode()
                mem = nvmlDeviceGetMemoryInfo(h)
                try:
                    util = nvmlDeviceGetUtilizationRates(h).gpu
                except Exception:
                    util = None
                out.append(
                    GpuInfo(
                        index=i,
                        name=name,
                        total_mem_mb=mem.total // (1024 * 1024),
                        free_mem_mb=mem.free // (1024 * 1024),
                        util_pct=util,
                    )
                )
        finally:
            nvmlShutdown()
    except Exception:
        # No NVIDIA driver / no GPU / pynvml init failed. CPU-only worker.
        return []
    return out


def snapshot() -> Hardware:
    vm = psutil.virtual_memory()
    return Hardware(
        cpu_count=psutil.cpu_count(logical=True) or 1,
        cpu_util_pct=psutil.cpu_percent(interval=None),
        ram_total_mb=vm.total // (1024 * 1024),
        ram_free_mb=vm.available // (1024 * 1024),
        gpus=_gpus(),
    )
