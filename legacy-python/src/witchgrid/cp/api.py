from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request

from ..config import config
from ..logger import log
from .db import connect
from .types import (
    CommandToRun,
    HeartbeatReq,
    HeartbeatResp,
    NodeView,
    RegisterReq,
    RegisterResp,
    ServiceView,
    SpawnServiceReq,
)

router = APIRouter(prefix="/api")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/nodes/register", response_model=RegisterResp)
async def register_node(req: RegisterReq, request: Request) -> RegisterResp:
    now = _now()
    addr = request.client.host if request.client else None
    with connect() as conn:
        existing = conn.execute(
            "select registered_at from nodes where node_id = ?", (req.node_id,)
        ).fetchone()
        registered_at = existing["registered_at"] if existing else now
        conn.execute(
            """
            insert into nodes (node_id, hostname, addr, role, version, registered_at,
                               last_heartbeat_at, hardware)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(node_id) do update set
                hostname = excluded.hostname,
                addr = excluded.addr,
                role = excluded.role,
                version = excluded.version,
                last_heartbeat_at = excluded.last_heartbeat_at,
                hardware = excluded.hardware
            """,
            (
                req.node_id,
                req.hostname,
                addr,
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
        addr=addr,
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
            raise HTTPException(status_code=410, detail="node not registered")

        # Sync each service's last reported state.
        for s in req.services:
            conn.execute(
                """
                update services
                set state = ?, pid = ?, port = ?, error = ?, last_state_at = ?
                where service_id = ?
                """,
                (s.state, s.pid, s.port, s.error, now, s.service_id),
            )

        # Mark completed commands.
        for cr in req.command_results:
            conn.execute(
                "update commands set completed_at = ?, error = ? where command_id = ?",
                (now, cr.error, cr.command_id),
            )

        # Pick up any pending commands for this node.
        rows = conn.execute(
            """
            select command_id, kind, payload from commands
            where node_id = ? and delivered_at is null
            order by issued_at
            """,
            (node_id,),
        ).fetchall()
        commands = [
            CommandToRun(
                command_id=r["command_id"], kind=r["kind"], payload=json.loads(r["payload"])
            )
            for r in rows
        ]
        if commands:
            placeholders = ",".join("?" * len(commands))
            conn.execute(
                f"update commands set delivered_at = ? where command_id in ({placeholders})",
                (now, *(c.command_id for c in commands)),
            )

    return HeartbeatResp(commands=commands)


# ─── services ────────────────────────────────────────────────────


def _next_port_for(node_id: str) -> int:
    """Pick a free-ish port for a new service on a node. Naive: count
    existing services on the node and offset from 8081. Worker may end
    up choosing differently and reporting back; CP records the actual."""
    with connect() as conn:
        n = conn.execute(
            "select count(*) as c from services where node_id = ? and state in ('starting','running','pending')",
            (node_id,),
        ).fetchone()["c"]
    return 8081 + n


@router.post("/services/spawn", response_model=ServiceView)
async def spawn_service(req: SpawnServiceReq) -> ServiceView:
    if req.template != "llama_server":
        raise HTTPException(status_code=400, detail=f"unknown template: {req.template}")

    now = _now()
    service_id = str(uuid.uuid4())
    command_id = str(uuid.uuid4())

    # Inject defaults the worker template expects.
    config_full = {
        # 0.0.0.0 so the CP can reach the service when worker is on
        # a different host. Single-network homelab assumption — there's
        # no auth on the spawned service yet.
        "host": "0.0.0.0",
        "port": _next_port_for(req.node_id),
        "context_size": 8192,
        "n_gpu_layers": 999,
        **req.config,
    }
    if "model_path" not in config_full:
        raise HTTPException(status_code=400, detail="config.model_path is required")

    with connect() as conn:
        node = conn.execute(
            "select node_id from nodes where node_id = ?", (req.node_id,)
        ).fetchone()
        if not node:
            raise HTTPException(status_code=404, detail="node not registered")

        conn.execute(
            """
            insert into services
              (service_id, node_id, template, config, state, port, created_at, last_state_at)
            values (?, ?, ?, ?, 'pending', ?, ?, ?)
            """,
            (
                service_id,
                req.node_id,
                req.template,
                json.dumps(config_full),
                config_full["port"],
                now,
                now,
            ),
        )
        conn.execute(
            """
            insert into commands (command_id, node_id, kind, payload, issued_at)
            values (?, ?, 'spawn_service', ?, ?)
            """,
            (
                command_id,
                req.node_id,
                json.dumps(
                    {
                        "service_id": service_id,
                        "template": req.template,
                        "config": config_full,
                    }
                ),
                now,
            ),
        )

    log.info(
        "service.spawn_queued",
        service_id=service_id,
        node_id=req.node_id,
        template=req.template,
        port=config_full["port"],
    )
    return _service_view_by_id(service_id)


@router.post("/services/{service_id}/stop", response_model=ServiceView)
async def stop_service(service_id: str) -> ServiceView:
    now = _now()
    command_id = str(uuid.uuid4())
    with connect() as conn:
        row = conn.execute(
            "select node_id, state from services where service_id = ?", (service_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="service not found")
        if row["state"] in ("stopped", "stopping"):
            return _service_view_by_id(service_id)
        conn.execute(
            "update services set state = 'stopping', last_state_at = ? where service_id = ?",
            (now, service_id),
        )
        conn.execute(
            """
            insert into commands (command_id, node_id, kind, payload, issued_at)
            values (?, ?, 'stop_service', ?, ?)
            """,
            (command_id, row["node_id"], json.dumps({"service_id": service_id}), now),
        )
    log.info("service.stop_queued", service_id=service_id)
    return _service_view_by_id(service_id)


@router.get("/services", response_model=list[ServiceView])
async def list_services() -> list[ServiceView]:
    with connect() as conn:
        rows = conn.execute(
            "select * from services order by created_at desc"
        ).fetchall()
    return [_row_to_service_view(r) for r in rows]


def _service_view_by_id(service_id: str) -> ServiceView:
    with connect() as conn:
        row = conn.execute("select * from services where service_id = ?", (service_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="service not found")
    return _row_to_service_view(row)


def _row_to_service_view(r) -> ServiceView:  # type: ignore[no-untyped-def]
    return ServiceView(
        service_id=r["service_id"],
        node_id=r["node_id"],
        template=r["template"],
        config=json.loads(r["config"]),
        state=r["state"],
        pid=r["pid"],
        port=r["port"],
        error=r["error"],
        created_at=datetime.fromisoformat(r["created_at"]),
        last_state_at=datetime.fromisoformat(r["last_state_at"]),
    )


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
