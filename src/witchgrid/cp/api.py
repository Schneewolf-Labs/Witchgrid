from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException

from ..config import config
from ..logger import log
from .db import connect
from .types import (
    HeartbeatReq,
    HeartbeatResp,
    NodeView,
    RegisterReq,
    RegisterResp,
)

router = APIRouter(prefix="/api")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/nodes/register", response_model=RegisterResp)
async def register_node(req: RegisterReq) -> RegisterResp:
    now = _now()
    with connect() as conn:
        # Upsert: re-registration on the same node_id refreshes hostname,
        # role, version, hardware. registered_at is preserved.
        existing = conn.execute(
            "select registered_at from nodes where node_id = ?", (req.node_id,)
        ).fetchone()
        registered_at = existing["registered_at"] if existing else now
        conn.execute(
            """
            insert into nodes (node_id, hostname, role, version, registered_at,
                               last_heartbeat_at, hardware)
            values (?, ?, ?, ?, ?, ?, ?)
            on conflict(node_id) do update set
                hostname = excluded.hostname,
                role = excluded.role,
                version = excluded.version,
                last_heartbeat_at = excluded.last_heartbeat_at,
                hardware = excluded.hardware
            """,
            (
                req.node_id,
                req.hostname,
                req.role,
                req.version,
                registered_at,
                now,
                req.hardware.model_dump_json(),
            ),
        )
    log.info(
        "node.register",
        node_id=req.node_id,
        hostname=req.hostname,
        role=req.role,
        gpus=len(req.hardware.gpus),
    )
    return RegisterResp(node_id=req.node_id, registered_at=datetime.fromisoformat(registered_at))


@router.post("/nodes/{node_id}/heartbeat", response_model=HeartbeatResp)
async def heartbeat(node_id: str, req: HeartbeatReq) -> HeartbeatResp:
    now = _now()
    with connect() as conn:
        cur = conn.execute(
            """
            update nodes set last_heartbeat_at = ?, hardware = ?
            where node_id = ?
            """,
            (now, req.hardware.model_dump_json(), node_id),
        )
        if cur.rowcount == 0:
            # Node fell out of the registry (CP restart, manual delete);
            # tell the worker to re-register on its next tick.
            raise HTTPException(status_code=410, detail="node not registered")
    return HeartbeatResp()


@router.get("/nodes", response_model=list[NodeView])
async def list_nodes() -> list[NodeView]:
    cutoff = (
        datetime.now(timezone.utc) - timedelta(seconds=config.OFFLINE_AFTER_S)
    ).isoformat()
    with connect() as conn:
        rows = conn.execute(
            "select * from nodes order by hostname"
        ).fetchall()
    out: list[NodeView] = []
    for r in rows:
        out.append(
            NodeView(
                node_id=r["node_id"],
                hostname=r["hostname"],
                role=r["role"],
                version=r["version"],
                registered_at=datetime.fromisoformat(r["registered_at"]),
                last_heartbeat_at=datetime.fromisoformat(r["last_heartbeat_at"]),
                online=r["last_heartbeat_at"] > cutoff,
                hardware=json.loads(r["hardware"]),
            )
        )
    return out
