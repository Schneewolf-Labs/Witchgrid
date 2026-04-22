"""Service templates — how to launch each engine.

For v1 these are inline. Easy path to YAML files later: load from
disk, validate against a schema. Adding a new engine = adding a
template here (or in a yaml dir).
"""

from __future__ import annotations

from typing import Any


def llama_server(config: dict[str, Any]) -> tuple[list[str], str]:
    """Build a launch argv for llama-server. Returns (argv, health_url).
    health_url always uses loopback since the worker checks locally;
    the bind host (often 0.0.0.0) is for cross-host reachability."""
    bind = config.get("host", "0.0.0.0")
    port = config["port"]
    argv = [
        "llama-server",
        "-m", config["model_path"],
        "--host", str(bind),
        "--port", str(port),
        "-c", str(config.get("context_size", 8192)),
        "-ngl", str(config.get("n_gpu_layers", 999)),
        "--jinja",
    ]
    return argv, f"http://127.0.0.1:{port}/health"


def build(template: str, config: dict[str, Any]) -> tuple[list[str], str]:
    if template == "llama_server":
        return llama_server(config)
    raise ValueError(f"unknown template: {template}")
