# Witchgrid

Orchestration + dashboard for self-hosted AI inference services. The control plane that lets you stop SSH-ing into your GPU box every time you want to swap a model.

For the case where you have a small fleet of CPU/GPU boxes and want to manage what's running where, what's loaded, and what's available — without hand-wiring each consumer to a hardcoded URL.

> **Status: not yet started.** This repo is currently a single design doc (`CLAUDE.md`) capturing what Witchgrid will be when it's built. The first consumer it's designed against is [flammen.ai](https://github.com/flammen-ai), which today runs against hardcoded inference URLs and will swap to Witchgrid as a single env-var change when this lands.

## What it'll do

- **Node registry** — every machine reports its hardware (GPU model, VRAM, CPU, RAM) and current state (free VRAM, running services, loaded models).
- **Model catalog** — scan known directories per node for available models (GGUFs, SD checkpoints, LoRAs).
- **Service lifecycle** — start, stop, restart inference services (`llama-server`, AUTOMATIC1111, ComfyUI, vLLM) on remote nodes via versioned templates.
- **Capacity-aware placement** — when a request needs a capability ("a llama-server with Mahou-12B"), pick the right node based on free VRAM + loaded models, spinning up an instance if none exists.
- **Dashboard** — see everything; manual overrides when you want them.
- **Routing API** — single HTTP endpoint consuming apps point at instead of pinning a backend URL.

## What it isn't

- Not a job queue (consumers bring their own pgmq / RabbitMQ / etc.)
- Not a fine-tuning harness
- Not Kubernetes — single-binary control plane + lightweight node agents over plain HTTP
- Not for single-node setups (just SSH and edit your scripts at that scale)

## Roadmap

See `CLAUDE.md` — 7 concrete stages from "single-node visibility" to "capacity-aware multi-node placement with model catalog."
