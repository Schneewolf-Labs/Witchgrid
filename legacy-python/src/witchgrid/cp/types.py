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


class ServiceState(BaseModel):
    """A service's current local state, as reported by the worker."""

    service_id: str
    state: str  # starting | running | stopping | stopped | failed
    pid: int | None = None
    port: int | None = None
    error: str | None = None


class CommandResult(BaseModel):
    command_id: str
    error: str | None = None


class HeartbeatReq(BaseModel):
    hardware: Hardware
    services: list[ServiceState] = Field(default_factory=list)
    command_results: list[CommandResult] = Field(default_factory=list)


class CommandToRun(BaseModel):
    command_id: str
    kind: str  # spawn_service | stop_service
    payload: dict[str, Any]


class HeartbeatResp(BaseModel):
    ok: bool = True
    commands: list[CommandToRun] = Field(default_factory=list)


class SpawnServiceReq(BaseModel):
    node_id: str
    template: str  # 'llama_server'
    config: dict[str, Any]


class ServiceView(BaseModel):
    service_id: str
    node_id: str
    template: str
    config: dict[str, Any]
    state: str
    pid: int | None
    port: int | None
    error: str | None
    created_at: datetime
    last_state_at: datetime


class NodeView(BaseModel):
    node_id: str
    hostname: str
    role: str
    version: str | None
    registered_at: datetime
    last_heartbeat_at: datetime
    online: bool
    hardware: Hardware
