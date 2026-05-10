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

- **Language: Hemlock** ([hemlang.dev](https://hemlang.dev)). Python prototype shipped through v0.3 (now in `legacy-python/`); v1 is being built in Hemlock because the deploy story (single ~1 MB ELF, deps `libm/libffi/libcrypto/libc` universal on every Linux box) is dramatically better for "agent that drops onto every box in the fleet." `nvidia-smi --query-gpu` over `exec()` covers the GPU introspection that diffusers/transformers would have given us in Python. The 7-issue language-evaluation writeup that informed this lives in `docs/hemlock-feedback-archive.md` — all seven items are now resolved upstream in Hemlock 2.1.x.
- **Service templating format.** Hand-written shell vs declarative YAML vs systemd unit generation. Probably **YAML descriptors** + a small executor.
- **Model storage.** Catalog only knows where models live on each node — does Witchgrid push models around to other nodes (sync), or just refuse to schedule jobs on nodes that don't have them? **Read-only catalog v1**, push later if it earns its keep.
- **Concurrent loading on a single GPU.** Naive VRAM accounting (subtract claimed VRAM from total) gets you 80% of the way; precise accounting needs talking to CUDA, which is hairy. **Start naive.**
- **Auth / multi-tenancy.** Single-operator / homelab v1 — **no auth.** Add API keys + per-tenant quotas if it grows beyond one operator.
- **GPU sharing across non-AI workloads.** Out of scope for v1 — Witchgrid manages inference services it spawned, not arbitrary processes squatting on the GPU.

## Relationship to Merlina (sibling Schneewolf Labs project)

[Merlina](https://github.com/Schneewolf-Labs/Merlina) is the lab's fine-tuning UI — Python + FastAPI, supports ORPO/DPO/SimPO/CPO/IPO/KTO/SFT, integrates with HuggingFace + Weights & Biases + llama.cpp. Same stack as Witchgrid; naturally complementary.

The intended composition: **Merlina trains, Witchgrid serves.**

```
flammen.ai data (chats, message_feedback, generation_attempts)
   → Merlina fine-tunes (Mahou replacement, character-designer model,
                         moderation classifier, etc.)
       → Witchgrid registers + serves the trained model
           → flammen.ai consumes via Witchgrid's routing API
               → produces more data → loop
```

The "Mahou is the wrong shape for FlameGen designer pass" gap noted in flammen.ai's CLAUDE.md is the obvious first use case for this loop.

Integration vectors (all deferred until both projects exist):
1. **Merlina outputs → Witchgrid catalog.** When training completes, Merlina pings Witchgrid to register the new model as deployable. Lowest-friction.
2. **Witchgrid as Merlina's compute provider.** Merlina submits training jobs through Witchgrid; CP allocates a GPU worker; runs the training subprocess. Lets Merlina share a GPU pool with inference.
3. **Shared model storage.** Both lean on the same model directory tree (or HuggingFace org), so neither has to push files to the other.

None of these require Witchgrid v1 code changes — just keep the model catalog shape generic enough that Merlina's outputs slot in cleanly.

## Relationship to flammen.ai

Witchgrid is **not required** for flammen.ai to ship. flammen.ai (`~/Projects/flammenai/`) will run with hardcoded inference URLs (env vars) for v1 — `LLAMA_SERVER_URL`, `A1111_URL`. If/when Witchgrid lands, swapping flammen.ai over is a one-line config change: point those env vars at Witchgrid's routing API instead of the raw service URLs. Worker code doesn't change.

flammen.ai is the **first consumer** Witchgrid is designed against. The features that matter most for it shape v1 priority:
- Routing for both text gen (llama-server) and image gen (A1111).
- VRAM-aware placement so llama-server + A1111 can coexist on one card without thrash.
- Dashboard visibility (what's loaded, what's burning VRAM right now).

## Status

**v0.3 Python shipped** (`legacy-python/`): control plane + node agent + dashboard + spawn/stop + round-robin routing. Frozen — no new features there.

**v1 Hemlock build in progress** (`cp/`): node registry + service supervisor are working, both on the interpreter and the compiled binary, end-to-end tested against real `llama-server`. Next slice is the agent split.

## Roadmap

Near-term, in order:

1. **Agent split.** Extract the service supervisor from `cp/` into `agent/`. CP routes spawn jobs to the appropriate agent over HTTP instead of running them in-process. This unlocks every multi-node feature below.
2. **Hardware introspection.** Agent calls `nvidia-smi --query-gpu=name,memory.total,memory.free,uuid --format=csv,noheader` and reports per-GPU state on `/register` and via heartbeat. CP stores in the node registry.
3. **Routing API.** Port the v0.3 `POST /v1/llama/{model}/*` proxy to Hemlock. Round-robin across registered instances. This is the moment flammen.ai can swap from per-service URLs to a single `WITCHGRID_URL`.
4. **Capability introspection.** Parse `llama-server --help` once per binary at registration time, store the flag set in sqlite, derive argv from intent (`flash_attention: true`) instead of hardcoding `-fa on`. Profiles outlast llama.cpp upgrades. See `docs/llama-cpp-as-managed-runtime.md` for the long form.
5. **Capacity-aware placement.** Use per-GPU free VRAM + a model spec (size, KV-cache budget) to pick (node, GPU set) for spawn requests. Naive accounting (subtract claimed VRAM) gets 80% of the value.
6. **Health checks + routing exclusion.** Liveness probe on each registered service; wedged ones drop out of the round-robin pool.
7. **Auto-spawn on first request.** If a route comes in for `mahou` and no instance is running, the placement algorithm picks a node + spawns transparently. Converts model-swap from "deploy" to "request."
8. **Dashboard.** htmx + jinja2 (Hemlock has it), server-rendered. Read-only view first; manual controls layered on.
9. **Model catalog.** Each agent scans known dirs (`~/AI/gguf_models`, A1111 checkpoints) and reports what's *available*, not just loaded.

Longer-term — see `docs/llama-cpp-as-managed-runtime.md` for the "Witchgrid as the llama.cpp manager" brainstorm (vendoring binaries, prebuilt download, source build, eventual auto-canary). Not v1, but the architecture should leave room.
