"""Routing API: consumers point at the CP, CP proxies to a running
service that hosts the requested model.

For v1 we expose llama.cpp's native paths verbatim under
  /v1/llama/{model}/{path...}

so a consumer that used to hit
  http://localhost:8080/completion
just changes its base URL to
  http://witchgrid:8000/v1/llama/<model-key>/completion

Model key is the lowercased filename stem of the service's
model_path (e.g. mahou-1.5-mistral-nemo-12b.q5_k_m). When multiple
services run the same model, we round-robin across them — one less
hot path on a single instance.
"""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from ..logger import log
from .db import connect

router = APIRouter()

# Keep one client per CP process; httpx pools connections internally.
_client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0))

# Round-robin counter per model key.
_rr: dict[str, itertools.count] = {}


def _model_key(model_path: str) -> str:
    return Path(model_path).stem.lower()


def _pick_running_service(model: str) -> dict | None:
    """Find a running service hosting `model` (lowercased filename stem).
    Round-robin across multiple instances."""
    target = model.lower()
    with connect() as conn:
        rows = conn.execute(
            """
            select s.service_id, s.port, s.config, n.addr, n.hostname
            from services s
            join nodes n on n.node_id = s.node_id
            where s.state = 'running'
            order by s.created_at
            """
        ).fetchall()
    candidates: list[dict] = []
    for r in rows:
        cfg = json.loads(r["config"])
        if _model_key(cfg.get("model_path", "")) == target:
            candidates.append(
                {
                    "service_id": r["service_id"],
                    "addr": r["addr"] or "127.0.0.1",
                    "port": r["port"],
                    "hostname": r["hostname"],
                }
            )
    if not candidates:
        return None
    counter = _rr.setdefault(target, itertools.count())
    return candidates[next(counter) % len(candidates)]


@router.api_route(
    "/v1/llama/{model}/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    include_in_schema=False,
)
async def proxy_llama(model: str, path: str, request: Request) -> Response:
    target = _pick_running_service(model)
    if not target:
        raise HTTPException(
            status_code=404,
            detail=f"no running service for model: {model}",
        )

    upstream = f"http://{target['addr']}:{target['port']}/{path}"
    body = await request.body()

    headers = {
        k: v for k, v in request.headers.items() if k.lower() not in ("host", "content-length")
    }

    try:
        upstream_resp = await _client.request(
            request.method,
            upstream,
            content=body,
            params=request.query_params,
            headers=headers,
        )
    except httpx.RequestError as e:
        log.warn("routing.upstream_error", model=model, upstream=upstream, err=str(e))
        raise HTTPException(status_code=502, detail=f"upstream unreachable: {e}") from e

    # Strip hop-by-hop headers + content-encoding (we re-emit raw bytes).
    drop = {"transfer-encoding", "connection", "content-encoding", "content-length"}
    out_headers = {k: v for k, v in upstream_resp.headers.items() if k.lower() not in drop}

    return Response(
        content=upstream_resp.content,
        status_code=upstream_resp.status_code,
        headers=out_headers,
        media_type=upstream_resp.headers.get("content-type"),
    )


@router.get("/v1/llama", include_in_schema=False)
async def list_llama_models() -> dict:
    """Convenience: list model keys currently being served by some
    running llama_server. Useful for consumers to discover what's up."""
    with connect() as conn:
        rows = conn.execute(
            "select config from services where state = 'running' and template = 'llama_server'"
        ).fetchall()
    keys: dict[str, int] = {}
    for r in rows:
        cfg = json.loads(r["config"])
        k = _model_key(cfg.get("model_path", ""))
        keys[k] = keys.get(k, 0) + 1
    return {"models": [{"name": k, "instances": v} for k, v in sorted(keys.items())]}
