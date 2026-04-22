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
    addr              text,                            -- IP captured from request.client at register
    role              text not null,                   -- 'cp,worker', 'worker', etc.
    version           text,
    registered_at     text not null,                   -- ISO timestamp
    last_heartbeat_at text not null,
    hardware          text not null                    -- JSON blob
);
create index if not exists nodes_last_heartbeat_idx on nodes(last_heartbeat_at);

-- Spawned inference services. State machine:
--   pending → starting → running
--                     ↘  failed
--   running → stopping → stopped
create table if not exists services (
    service_id     text primary key,
    node_id        text not null references nodes(node_id) on delete cascade,
    template       text not null,                      -- 'llama_server', etc.
    config         text not null,                      -- JSON: model path, port, etc.
    state          text not null,                      -- pending|starting|running|stopping|stopped|failed
    pid            integer,
    port           integer,
    error          text,
    created_at     text not null,
    last_state_at  text not null
);
create index if not exists services_node_idx on services(node_id);
create index if not exists services_state_idx on services(state);

-- Commands queued for delivery to a node via heartbeat response.
-- delivered_at marks "worker has been told"; completed_at marks
-- "worker reported result back".
create table if not exists commands (
    command_id     text primary key,
    node_id        text not null,
    kind           text not null,                      -- spawn_service | stop_service
    payload        text not null,                      -- JSON
    issued_at      text not null,
    delivered_at   text,
    completed_at   text,
    error          text
);
create index if not exists commands_node_undelivered_idx
    on commands(node_id) where delivered_at is null;
"""


def _db_path() -> Path:
    config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    return config.STATE_DIR / "state.db"


# Idempotent in-place column additions for DBs created by older versions.
MIGRATIONS = [
    "alter table nodes add column addr text",
]


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        for stmt in MIGRATIONS:
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                # column already exists
                pass


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
