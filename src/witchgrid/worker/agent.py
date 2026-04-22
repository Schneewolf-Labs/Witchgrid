"""Worker agent: registers with CP, heartbeats forever."""

from __future__ import annotations

import asyncio
import uuid

import httpx

from ..config import config
from ..logger import log
from . import hardware

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


async def _heartbeat(client: httpx.AsyncClient, node_id: str) -> bool:
    try:
        r = await client.post(
            f"{config.CP_URL}/api/nodes/{node_id}/heartbeat",
            json={"hardware": hardware.snapshot().model_dump()},
            timeout=10,
        )
        if r.status_code == 410:
            # CP doesn't know us — re-register.
            log.info("worker.heartbeat_410_re_registering")
            return False
        r.raise_for_status()
        return True
    except Exception as e:
        log.warn("worker.heartbeat_failed", err=str(e))
        return True  # transient; keep beating, will recover


async def run_worker() -> None:
    node_id = _node_id()
    role = "worker"  # if also CP, __main__ runs both serve_cp() + run_worker()
    log.info("worker.starting", node_id=node_id, cp=config.CP_URL)

    async with httpx.AsyncClient(timeout=10) as client:
        # Initial registration with backoff retry — CP might not be up yet.
        for attempt in range(60):
            if await _register(client, node_id, role):
                break
            await asyncio.sleep(min(2.0 * (attempt + 1), 10.0))

        # Heartbeat loop.
        while True:
            await asyncio.sleep(config.HEARTBEAT_INTERVAL_S)
            still_known = await _heartbeat(client, node_id)
            if not still_known:
                # CP told us we're not in its registry — re-register.
                await _register(client, node_id, role)
