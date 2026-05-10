"""Worker agent: registers with CP, heartbeats forever, executes
commands the CP queues for it."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx

from ..config import config
from ..logger import log
from . import hardware
from .services import ServiceManager

VERSION = "0.1.0"


def _node_id() -> str:
    f = config.NODE_ID_FILE
    if f.exists():
        return f.read_text().strip()
    f.parent.mkdir(parents=True, exist_ok=True)
    nid = str(uuid.uuid4())
    f.write_text(nid)
    return nid


async def _register(client: httpx.AsyncClient, node_id: str, role: str) -> bool:
    try:
        r = await client.post(
            f"{config.CP_URL}/api/nodes/register",
            json={
                "node_id": node_id,
                "hostname": hardware.hostname(),
                "role": role,
                "version": VERSION,
                "hardware": hardware.snapshot().model_dump(),
            },
        )
        r.raise_for_status()
        log.info("worker.registered", node_id=node_id, cp=config.CP_URL)
        return True
    except Exception as e:
        log.warn("worker.register_failed", err=str(e), cp=config.CP_URL)
        return False


def _service_states(svcs: ServiceManager) -> list[dict[str, Any]]:
    return [
        {
            "service_id": s.service_id,
            "state": s.state,
            "pid": s.pid,
            "port": s.port,
            "error": s.error,
        }
        for s in svcs.all()
    ]


async def _execute_commands(svcs: ServiceManager, commands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for cmd in commands:
        cid = cmd["command_id"]
        kind = cmd["kind"]
        payload = cmd["payload"]
        err: str | None = None
        try:
            if kind == "spawn_service":
                err = await svcs.spawn(
                    service_id=payload["service_id"],
                    template=payload["template"],
                    config=payload["config"],
                )
            elif kind == "stop_service":
                await svcs.stop(payload["service_id"])
            else:
                err = f"unknown command kind: {kind}"
        except Exception as e:
            err = f"command failed: {e}"
        log.info("worker.command_done", command_id=cid, kind=kind, err=err)
        results.append({"command_id": cid, "error": err})
    return results


async def _heartbeat(
    client: httpx.AsyncClient,
    node_id: str,
    svcs: ServiceManager,
    pending_results: list[dict[str, Any]],
) -> tuple[bool, list[dict[str, Any]]]:
    """Returns (still_known, new_commands_to_execute)."""
    await svcs.refresh_states()
    try:
        r = await client.post(
            f"{config.CP_URL}/api/nodes/{node_id}/heartbeat",
            json={
                "hardware": hardware.snapshot().model_dump(),
                "services": _service_states(svcs),
                "command_results": pending_results,
            },
            timeout=10,
        )
        if r.status_code == 410:
            log.info("worker.heartbeat_410_re_registering")
            return False, []
        r.raise_for_status()
        body = r.json()
        return True, body.get("commands", [])
    except Exception as e:
        log.warn("worker.heartbeat_failed", err=str(e))
        return True, []  # transient; next tick will retry


async def run_worker() -> None:
    node_id = _node_id()
    role = "worker"
    log.info("worker.starting", node_id=node_id, cp=config.CP_URL)

    svcs = ServiceManager()
    pending_results: list[dict[str, Any]] = []

    async with httpx.AsyncClient(timeout=10) as client:
        # Initial registration with backoff retry.
        for attempt in range(60):
            if await _register(client, node_id, role):
                break
            await asyncio.sleep(min(2.0 * (attempt + 1), 10.0))

        while True:
            await asyncio.sleep(config.HEARTBEAT_INTERVAL_S)
            still_known, commands = await _heartbeat(client, node_id, svcs, pending_results)
            pending_results = []
            if not still_known:
                await _register(client, node_id, role)
                continue
            if commands:
                pending_results = await _execute_commands(svcs, commands)
