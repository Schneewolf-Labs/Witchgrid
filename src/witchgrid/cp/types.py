from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class GpuInfo(BaseModel):
    index: int
    name: str
    total_mem_mb: int
    free_mem_mb: int
    util_pct: int | None = None


class Hardware(BaseModel):
    cpu_count: int
    cpu_util_pct: float | None = None
    ram_total_mb: int
    ram_free_mb: int
    gpus: list[GpuInfo] = Field(default_factory=list)


class RegisterReq(BaseModel):
    node_id: str
    hostname: str
    role: str
    version: str = "0.1.0"
    hardware: Hardware


class RegisterResp(BaseModel):
    node_id: str
    registered_at: datetime
    welcome: str = "joined the grid"


class HeartbeatReq(BaseModel):
    hardware: Hardware


class HeartbeatResp(BaseModel):
    ok: bool = True
    # Reserved for future: commands the CP wants this worker to run.
    commands: list[dict[str, Any]] = Field(default_factory=list)


class NodeView(BaseModel):
    node_id: str
    hostname: str
    role: str
    version: str | None
    registered_at: datetime
    last_heartbeat_at: datetime
    online: bool
    hardware: Hardware
