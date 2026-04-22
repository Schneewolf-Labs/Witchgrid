"""Local service supervision: spawn / health-check / stop subprocesses
launched on this worker."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from ..logger import log
from . import templates

LOG_DIR = Path.home() / ".witchgrid" / "logs"


@dataclass
class ServiceProcess:
    service_id: str
    template: str
    config: dict[str, Any]
    proc: subprocess.Popen | None = None
    state: str = "starting"
    error: str | None = None
    health_url: str = ""

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc else None

    @property
    def port(self) -> int | None:
        return self.config.get("port")


class ServiceManager:
    """Owns the running services on this worker. State queried at
    every heartbeat; CP commands routed here."""

    def __init__(self) -> None:
        self._services: dict[str, ServiceProcess] = {}
        LOG_DIR.mkdir(parents=True, exist_ok=True)

    def all(self) -> list[ServiceProcess]:
        return list(self._services.values())

    async def spawn(self, service_id: str, template: str, config: dict[str, Any]) -> str | None:
        """Launch a service; returns error string or None."""
        if service_id in self._services:
            return "already running"

        try:
            argv, health_url = templates.build(template, config)
        except Exception as e:
            return f"template error: {e}"

        if not shutil.which(argv[0]):
            return f"binary not found on PATH: {argv[0]}"

        log_path = LOG_DIR / f"{service_id}.log"
        log_file = log_path.open("ab")  # noqa: SIM115 — held for proc lifetime

        try:
            proc = subprocess.Popen(  # noqa: S603 — argv from trusted CP
                argv,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except Exception as e:
            log_file.close()
            return f"spawn failed: {e}"

        sp = ServiceProcess(
            service_id=service_id,
            template=template,
            config=config,
            proc=proc,
            state="starting",
            health_url=health_url,
        )
        self._services[service_id] = sp
        log.info("service.spawned", service_id=service_id, pid=proc.pid, port=sp.port, log=str(log_path))
        return None

    async def stop(self, service_id: str) -> None:
        sp = self._services.get(service_id)
        if not sp or not sp.proc:
            return
        sp.state = "stopping"
        try:
            sp.proc.terminate()
            try:
                await asyncio.to_thread(sp.proc.wait, 10)
            except subprocess.TimeoutExpired:
                sp.proc.kill()
                await asyncio.to_thread(sp.proc.wait)
        except Exception as e:
            log.warn("service.stop_error", service_id=service_id, err=str(e))
        sp.state = "stopped"
        log.info("service.stopped", service_id=service_id)

    async def refresh_states(self) -> None:
        """Update each service's state by checking exit code + health."""
        for sp in self._services.values():
            await self._check_one(sp)

    async def _check_one(self, sp: ServiceProcess) -> None:
        if sp.state in ("stopped", "failed"):
            return
        if sp.proc is None:
            return

        rc = sp.proc.poll()
        if rc is not None:
            # Process has exited.
            if sp.state == "stopping":
                sp.state = "stopped"
            else:
                sp.state = "failed"
                sp.error = f"exited with code {rc}"
            log.warn("service.exited", service_id=sp.service_id, rc=rc, prev_state=sp.state)
            return

        # Still alive — probe health endpoint.
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                r = await client.get(sp.health_url)
                if r.status_code == 200:
                    sp.state = "running"
                    sp.error = None
                # else: leave as 'starting' (e.g. model still loading)
        except Exception:
            # Health probe failed — could be model still loading. Leave
            # state alone.
            pass
