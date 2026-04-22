"""SQLite state for the control plane.

Single file; portable. To migrate the CP to a new host, copy this file
and start witchgrid in CP mode there. Workers re-register on next
heartbeat against the new URL.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from ..config import config

SCHEMA = """
create table if not exists nodes (
    node_id           text primary key,
    hostname          text not null,
    role              text not null,                   -- 'cp,worker', 'worker', etc.
    version           text,
    registered_at     text not null,                   -- ISO timestamp
    last_heartbeat_at text not null,
    hardware          text not null                    -- JSON blob
);
create index if not exists nodes_last_heartbeat_idx on nodes(last_heartbeat_at);
"""


def _db_path() -> Path:
    config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    return config.STATE_DIR / "state.db"


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(_db_path(), isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row
    conn.execute("pragma journal_mode = wal")
    conn.execute("pragma foreign_keys = on")
    try:
        yield conn
    finally:
        conn.close()
