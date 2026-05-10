# Witchgrid

Orchestration + dashboard for self-hosted AI inference services. The control plane that lets you stop SSH-ing into your GPU box every time you want to swap a model.

For the case where you have a small fleet of CPU/GPU boxes and want to manage what's running where, what's loaded, and what's available — without hand-wiring each consumer to a hardcoded URL.

> **Status: v1 in active build.** A Python prototype (v0.1 → v0.3) shipped first; v1 is being rebuilt in [Hemlock](https://hemlang.dev) so the deploy artifact is a single ~1 MB binary that drops onto every box in the fleet without a runtime to install. The Python tree lives in `legacy-python/` for reference.

## Layout

| Dir | What's there |
|-----|--------------|
| `cp/` | Control plane daemon (Hemlock). Currently includes the service supervisor too — splits to `agent/` next slice. |
| `agent/` | *(planned)* Per-node agent. Registers with CP, reports hardware via `nvidia-smi`, heartbeats, accepts spawn jobs from CP. |
| `docs/` | Design docs + roadmaps. See `flammen-as-first-consumer.md` (v1 priorities derived from the flammen.ai operator pain), `llama-cpp-as-managed-runtime.md` (long-game brainstorm), `hemlock-feedback-archive.md` (the language eval that informed the rewrite). |
| `legacy-python/` | Frozen v0.3 Python prototype. Source of truth for design references; no new features. |

## What it does

- **Node registry** — every machine reports its hardware (GPU model, VRAM, CPU, RAM) and current state (free VRAM, running services, loaded models).
- **Service lifecycle** — start, stop, restart inference services (`llama-server`, eventually AUTOMATIC1111, ComfyUI, vLLM) on remote nodes via opinionated profile templates that encode the right defaults (4-bit KV cache, 128 K context, GPU pinning, etc.).
- **Routing API** *(coming back in v1)* — single HTTP endpoint consuming apps point at instead of pinning a backend URL.
- **Capacity-aware placement** *(v1)* — when a request needs a capability ("a llama-server with Mahou-12B"), pick the right node based on free VRAM + loaded models, spinning up an instance if none exists.
- **Dashboard** *(v1)* — htmx + jinja, server-rendered. See everything; manual overrides when you want them.
- **Model catalog** *(v1)* — scan known directories per node for available models (GGUFs, SD checkpoints, LoRAs).

## What it isn't

- Not a job queue (consumers bring their own pgmq / RabbitMQ / etc.)
- Not a fine-tuning harness
- Not Kubernetes — single-binary control plane + lightweight node agents over plain HTTP
- Not for single-node setups (just SSH and edit your scripts at that scale)

## Quickstart

```bash
cd cp
hemlockc cp.hml -o witchgrid && ./witchgrid
# listens on :8765
```

See `cp/README.md` for the full smoke-test walkthrough.

## Roadmap

See `CLAUDE.md` for the long form. Near-term:

1. **Agent split** — extract the service supervisor from `cp/` into `agent/`; CP routes spawn jobs over HTTP instead of running services in-process.
2. **Hardware introspection** — agent calls `nvidia-smi --query-gpu` and reports per-GPU free VRAM in its registration / heartbeat.
3. **Routing API** — port the v0.3 `POST /v1/llama/{model}/*` round-robin proxy to Hemlock.
4. **Capability introspection** — parse `llama-server --help` once per binary, derive argv from intent (`flash_attention: true`) instead of hardcoding flag names. (See `docs/llama-cpp-as-managed-runtime.md`.)
5. **Dashboard** — htmx + jinja2 for the read-only live view, then layer on manual controls.
