from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Config(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="WITCHGRID_", extra="ignore")

    # Where the SQLite state lives (CP role).
    STATE_DIR: Path = Path.home() / ".witchgrid"

    # Bind address for CP HTTP surface.
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Worker discovery: how the worker reaches the CP.
    CP_URL: str = "http://localhost:8000"

    # Worker identity. Auto-assigned + persisted on first boot.
    NODE_ID_FILE: Path = Path.home() / ".witchgrid" / "node_id"

    HEARTBEAT_INTERVAL_S: float = 5.0
    OFFLINE_AFTER_S: float = 30.0

    LOG_LEVEL: str = "info"


config = Config()  # type: ignore[call-arg]
