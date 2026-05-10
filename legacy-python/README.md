# legacy-python — archived v0.3 prototype

The original Python prototype of Witchgrid (FastAPI + uvicorn + sqlite + a vanilla-JS dashboard, ~6 KLOC). Stages v0.1 → v0.3 of the original roadmap shipped here:

| Stage | What landed |
|-------|-------------|
| v0.1  | Control plane + node agent + dashboard |
| v0.2  | Spawn / stop llama-server services from the dashboard |
| v0.3  | Routing API — proxy `/v1/llama/{model}/*` to running services with round-robin |

## Why it's here, not deleted

The Hemlock port (now in `../cp/`) is the source of truth going forward. The Python is retained because:
- Historical reference for the v1 design — endpoint shapes, schema, dashboard behavior were all worked out here first.
- Fallback if the Hemlock port hits a wall during v1 build-out (it didn't, but cheap insurance).
- Some pieces (the dashboard HTML/CSS in `src/witchgrid/cp/static/`) will likely transplant nearly as-is.

## Why the rewrite

The Python deploy story (Python version match across boxes, venv on every node, uvicorn supervisor, systemd `EnvironmentFile` for the venv path) was the wrong shape for "agent that drops onto every GPU box in the fleet." Hemlock compiles to a single ~1 MB ELF with deps `libm/libffi/libcrypto/libc` (universal on every Linux box), so deploy collapses to `scp + systemd unit + done`. That's it. Same operator pain Witchgrid was built to eliminate, applied one layer down.

See `../docs/hemlock-feedback-archive.md` for the language-evaluation writeup that informed the switch.

## Running it

If you want to run the Python prototype for reference:

```bash
cd legacy-python
uv sync
uv run python -m witchgrid cp     # control plane
uv run python -m witchgrid worker # node agent
```

It's frozen — no new features will land here.
