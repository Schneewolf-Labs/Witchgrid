# Witchgrid

Orchestration + dashboard for self-hosted AI inference services. For the case where you have a small fleet of CPU/GPU boxes and want to manage what's running where, what's loaded, and what's available — without ssh-ing into each one and editing scripts.

## Vision

You shouldn't have to ssh into your GPU box to swap a model. You shouldn't have to remember which checkpoint lives where. You shouldn't have to hand-wire each consuming app to a hardcoded inference URL. Witchgrid is the control plane that solves those problems behind a dashboard you can actually look at.

## What it does

- **Node registry** — discover and track machines that can run inference (CPU, GPU, both). Each node reports its hardware (GPU model, VRAM, CPU, RAM) and current state (free VRAM, running services, loaded models).
- **Model catalog** — scan known directories on each node for available models (GGUFs for llama.cpp, SD checkpoints, LoRAs, embedding models, etc.). Knows what's downloaded and where.
- **Service lifecycle** — start, stop, restart inference services (`llama-server`, AUTOMATIC1111, ComfyUI, vLLM, custom workers) on remote nodes via versioned templates.
- **Capacity-aware placement** — when a job needs a capability ("a llama-server with Mahou-12B"), figure out which node can host it (has the model on disk + has VRAM headroom) and either route to a running instance or spin one up.
- **Dashboard** — see everything: nodes online, services running, models loaded, VRAM usage, recent throughput. Manual overrides when you want them.
- **Routing API** — single endpoint that consuming apps point at instead of pinning a specific backend URL. Witchgrid handles which physical backend serves the request. OpenAI-compatible where it makes sense; engine-native passthrough where it doesn't (e.g. A1111).

## What it isn't

- **Not a job queue.** Consumers bring their own (pgmq, RabbitMQ, BullMQ). Witchgrid handles "where does this request go *right now*," not "when does this job run."
- **Not a fine-tuning harness.** Doesn't manage training runs.
- **Not Kubernetes.** No pod scheduling, no networking abstractions, no manifests. Single-binary control plane + lightweight node agents over plain HTTP.
- **Not for single-node setups.** If you have one machine, you don't need Witchgrid — just SSH and edit your scripts. The value kicks in when you have ≥2 nodes or want to share GPU between multiple workloads.

## Architecture (sketch — open for revision)

```
┌──────────────────┐
│   Dashboard      │   web UI on the control plane
└────────┬─────────┘
         │
         ▼
┌──────────────────┐         ┌──────────────────────────┐
│  Witchgrid       │ ◄────── │  consuming clients       │
│  control plane   │  HTTP   │  (FlameWorker, FlameGen, │
└────────┬─────────┘         │   external, …)           │
         │                   └──────────────────────────┘
         │ heartbeat / commands
   ┌─────┼─────────────┬─────────────────┐
   ▼     ▼             ▼                 ▼
┌───────────┐   ┌───────────┐   ┌───────────────┐
│ node      │   │ node      │   │ node          │
│ agent     │   │ agent     │   │ agent         │
│           │   │           │   │               │
│ + llama-  │   │ + A1111   │   │ + CPU         │
│   server  │   │           │   │   fallback    │
└───────────┘   └───────────┘   └───────────────┘
```

## Components (proposed)

| Component | Responsibility |
|---|---|
| **Control plane** | Single daemon. Owns node registry, model catalog, service registry, routing decisions. Exposes admin API + routing API + dashboard. |
| **Node agent** | Lives on each managed machine. Reports hardware state, runs commands (`start llama-server with this checkpoint`), proxies traffic to local services if asked. |
| **Dashboard** | Web UI on the control plane. Read-only views + manual controls (load this model, kill this service, reassign this node). |
| **Service templates** | Declarative descriptors of how to spawn each inference engine (llama-server, A1111, ComfyUI, vLLM…). Versioned in the repo. Adding a new engine = config not code. |
| **Routing API** | The HTTP surface consumers point at. Per-engine semantics: OpenAI-compatible for chat/completions, native passthrough for image gen. |

## Open design decisions

- **Language.** Python (matches AI ecosystem, easy CUDA/diffusers/transformers/nvidia-smi integration, fast iteration) vs Go/Rust (single binary, low overhead, better daemon ergonomics) vs Node (consistency with sibling Node projects). **Leaning Python** for v1; rewrite-for-perf later if it becomes a real product.
- **Service templating format.** Hand-written shell vs declarative YAML vs systemd unit generation. Probably **YAML descriptors** + a small executor.
- **Model storage.** Catalog only knows where models live on each node — does Witchgrid push models around to other nodes (sync), or just refuse to schedule jobs on nodes that don't have them? **Read-only catalog v1**, push later if it earns its keep.
- **Concurrent loading on a single GPU.** Naive VRAM accounting (subtract claimed VRAM from total) gets you 80% of the way; precise accounting needs talking to CUDA, which is hairy. **Start naive.**
- **Auth / multi-tenancy.** Single-operator / homelab v1 — **no auth.** Add API keys + per-tenant quotas if it grows beyond one operator.
- **GPU sharing across non-AI workloads.** Out of scope for v1 — Witchgrid manages inference services it spawned, not arbitrary processes squatting on the GPU.

## Relationship to flammen.ai

Witchgrid is **not required** for flammen.ai to ship. flammen.ai (`~/Projects/flammenai/`) will run with hardcoded inference URLs (env vars) for v1 — `LLAMA_SERVER_URL`, `A1111_URL`. If/when Witchgrid lands, swapping flammen.ai over is a one-line config change: point those env vars at Witchgrid's routing API instead of the raw service URLs. Worker code doesn't change.

flammen.ai is the **first consumer** Witchgrid is designed against. The features that matter most for it shape v1 priority:
- Routing for both text gen (llama-server) and image gen (A1111).
- VRAM-aware placement so llama-server + A1111 can coexist on one card without thrash.
- Dashboard visibility (what's loaded, what's burning VRAM right now).

## Status

Project not yet started. This document is the starting point.

## Roadmap (proposed; needs sign-off)

1. **Single-node control plane + node agent.** Agent registers with control plane, reports hardware. No service spawning yet — just visibility.
2. **Dashboard MVP.** Read-only view of nodes + their state.
3. **Service templates + spawn API.** Define `llama-server` and A1111 as templates; control plane can start/stop them on a node.
4. **Multi-node.** Second node agent; control plane handles >1.
5. **Routing API.** OpenAI-compatible endpoint that proxies to a running instance.
6. **Capacity-aware placement.** Pick the right node for a request based on free VRAM + loaded models.
7. **Model catalog + scanning.** Discover available models on each node.
