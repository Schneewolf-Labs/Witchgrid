"""FastAPI app for the control plane."""

from __future__ import annotations

from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..config import config
from ..logger import log
from .api import router
from .db import init_db
from .routing import router as routing_router


def build_app() -> FastAPI:
    app = FastAPI(title="Witchgrid CP", version="0.2.0")
    app.include_router(router)
    app.include_router(routing_router)

    static_dir = Path(__file__).parent / "static"
    if static_dir.exists():
        # Bundled dashboard. Serves index.html at /, assets at /assets/*.
        app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")

        @app.get("/", include_in_schema=False)
        async def index() -> FileResponse:
            return FileResponse(static_dir / "index.html")

    return app


async def serve_cp() -> None:
    init_db()
    app = build_app()
    log.info("cp.starting", host=config.HOST, port=config.PORT)
    cfg = uvicorn.Config(
        app,
        host=config.HOST,
        port=config.PORT,
        log_level=config.LOG_LEVEL,
        access_log=False,
    )
    server = uvicorn.Server(cfg)
    await server.serve()
