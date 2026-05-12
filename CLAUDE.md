# Witchgrid

Orchestration + dashboard for self-hosted AI inference services. For the case where you have a small fleet of CPU/GPU boxes and want to manage what's running where, what's loaded, and what's available — without ssh-ing into each one and editing scripts.

## Vision

You shouldn't have to ssh into your GPU box to swap a model. You shouldn't have to remember which checkpoint lives where. You shouldn't have to hand-wire each consuming app to a hardcoded inference URL. Witchgrid is the control plane that solves those problems behind a dashboard you can actually look at.

## What it does

- **Node registry** — every machine reports its hardware (GPU model, total/free VRAM via `nvidia-smi`) on register and on heartbeat (30 s). Stale (> 90 s) nodes drop out of placement decisions.
- **Service supervisor** — agents `posix_spawn` `llama-server` with a real argv (no shell wrapper), `setsid: true` for terminal detach, raw fd redirection for log/dev-null, transient `CUDA_VISIBLE_DEVICES`. PIDs tracked in a per-agent sqlite. SIGTERM on stop. Zombie rows reaped on agent boot.
- **Routing API** — `POST /v1/llama/{profile}/*` on CP proxies to the first live instance for that profile. If none exists, capacity-aware placement picks a stale-filtered node plus one GPU with enough reported free VRAM, spawns transparently, waits for `/health`, then completes the request.
- **Capacity-aware placement** — the GGUF metadata parser pulls model size + KV-cache footprint at decision time; placement is first-fit onto one GPU. Auto-placement currently requires CP to read the GGUF path itself, so model paths must be shared/mounted identically until agent-side inspection/model catalog work lands.
- **Capability introspection** — at agent boot, `llama-server --help` is parsed into `{flag → {short, longs, value, description}}` and exposed at the agent's `GET /capabilities`. CP aggregates per-node for the dashboard.
- **Intent-driven argv** — profile templates declare normalized intents (`flash_attention: true`, `kv_cache_k: "q4_0"`, `context: 131072`); at spawn time the agent translates each intent into the binary's actual flag form using its capability map. The same profile produces the right argv on different llama.cpp versions (legacy boolean `-fa` vs enum `-fa on|off|auto` is the canonical case).
- **Dashboard** — HTMX-driven live view at `GET /` on CP. Nodes, services, profiles, capabilities tables. Spawn form (Alpine.js) for manual placement. Static assets live in `dashboard/` and `assets/`, embedded into the CP binary at build time via `scripts/embed_assets.sh`.

## What it isn't

- **Not a job queue.** Consumers bring their own (pgmq, RabbitMQ, BullMQ). Witchgrid handles "where does this request go *right now*," not "when does this job run."
- **Not a fine-tuning harness.** Doesn't manage training runs. See [Merlina](https://github.com/Schneewolf-Labs/Merlina) for the lab's training side; the intended composition is below.
- **Not Kubernetes.** No pod scheduling, no networking abstractions, no manifests. Single-binary control plane + lightweight node agents over plain HTTP. No auth (single operator, LAN-only).
- **Not for single-node setups.** If you have one machine, you don't need Witchgrid — just SSH and edit your scripts. The value kicks in at ≥2 nodes or when sharing a GPU between multiple workloads.

## Documentation audit (current gaps)

- Routing is **not** round-robin today; CP picks the first live matching service. Round-robin/least-loaded routing remains a gap.
- Auto-placement is **single-GPU first-fit** and depends on `free_mb` reported by agents; it does not split one model across multiple GPUs.
- CP-side GGUF inspection means auto-placement needs the model path readable from CP. Explicit `node_id` + `gpus` placement is the workaround for agent-only paths.
- JSON capability aggregation exists on agents; CP only renders the aggregate in the dashboard fragment today.
- Data files are CWD-relative (`witchgrid.db`, `witchgrid-agent.db`) until a data-dir env lands.

## Architecture

```
┌──────────────────┐
│   Dashboard      │   HTMX + Alpine + Pico, embedded into CP
└────────┬─────────┘
         │
         ▼
┌──────────────────┐         ┌──────────────────────────┐
│  Witchgrid       │ ◄────── │  consuming clients       │
│  control plane   │  HTTP   │  (FlameWorker, FlameGen, │
│   (cp/, :8765)   │         │   external, …)           │
└────────┬─────────┘         └──────────────────────────┘
         │ /register heartbeats + spawn/stop RPC
   ┌─────┼─────────────┬─────────────────┐
   ▼     ▼             ▼                 ▼
┌───────────┐   ┌───────────┐   ┌───────────────┐
│ agent     │   │ agent     │   │ agent         │
│  :8766    │   │  :8766    │   │  :8766        │
│           │   │           │   │               │
│ + llama-  │   │ + llama-  │   │ + (cpu only)  │
│   server  │   │   server  │   │               │
│   :180xx  │   │   :180xx  │   │               │
└───────────┘   └───────────┘   └───────────────┘
```

CP and agent each compile to a standalone ~7 MB ELF (`witchgrid-cp`, `witchgrid-agent`). Universal dynamic deps only (`libm`, `libffi`, `libcrypto`, `libwebsockets`, `libc`).

## Components

| Component | Responsibility |
|---|---|
| **Control plane** (`cp/`) | Node registry, routing API, dashboard, GGUF introspection, capacity-aware placement. Exposes `/register`, `/nodes`, `/services` (proxy to agents), `/v1/llama/{profile}/*`, `/profiles`, `/healthz`, dashboard at `/`; capability aggregation is currently rendered at `/ui/capabilities`, not exposed as JSON. |
| **Node agent** (`agent/`) | Hardware probe (nvidia-smi), capability introspection (`llama-server --help`), service supervisor (posix_spawn + setsid), heartbeat. Exposes `/services` (CRUD), `/profiles`, `/capabilities`, `/healthz`. |
| **Profile templates** | Live in `agent/services.hml` `PROFILES`. Each profile is `{ binary, intent, extra_flags, default_port, default_model, ... }`. `intent` is a normalized map; `extra_flags` is the raw escape hatch. New profile = config not code. |
| **Intent translator** (`agent/intent.hml`) | Maps witchgrid-level intents (`flash_attention`, `kv_cache_k`, …) to the binary's actual flag form using its capability map. Handles `boolean_or_enum` for flags that changed shape between llama.cpp versions. |
| **GGUF parser** (`cp/gguf.hml`) | Reads GGUF metadata to extract model size + KV-cache footprint for placement. Standalone CLI `witchgrid-inspect` wraps it. |
| **Dashboard** | Static `dashboard/index.html` + `dashboard/spawn_form.js` + `dashboard/styles.css` + `assets/logo.svg`. Embedded into CP via `scripts/embed_assets.sh` → `cp/embedded_assets.hml`. HTMX polls `/ui/*` fragments; Alpine drives the spawn form. |

## Resolved design decisions

- **Language: Hemlock** ([hemlang.dev](https://hemlang.dev)). Python prototype shipped through v0.3 (now in `legacy-python/`); v0.1 of the Hemlock build is what's documented here. Single ~7 MB ELF per binary, universal libs only — drops onto every box without a runtime install. The 7-issue language-evaluation writeup that informed this lives in `docs/hemlock-feedback-archive.md`; all seven items are now resolved upstream in Hemlock 2.1.x / 2.2.x.
- **Service templating format.** Inline Hemlock map (`PROFILES` in `agent/services.hml`). YAML descriptors got skipped — at the current count (~3 profiles) they'd add a parser without earning their keep. Revisit if profile count grows past ~10 or non-ops users start authoring.
- **Model storage.** Catalog only knows where models live on each node. Witchgrid does not push models around. Profiles currently embed host-specific GGUF paths; the planned model catalog (open) decouples profile from path via aliases.
- **Concurrent loading on a single GPU.** Naive VRAM accounting (free_mb − sum(claimed_mb)). Works.
- **Auth / multi-tenancy.** Single-operator / LAN-only. **No auth.** Add API keys + per-tenant quotas if it grows beyond one operator.
- **GPU sharing across non-AI workloads.** Out of scope. Witchgrid manages inference services it spawned, not arbitrary processes squatting on the GPU.
- **Capability/intent split.** Profile templates declare what they want (intent); the agent's capability map decides how to ask for it. Same profile, different llama.cpp version, right argv.

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

Integration vectors (deferred until both projects need them):
1. **Merlina outputs → Witchgrid catalog.** When training completes, Merlina pings Witchgrid to register the new model as deployable. Lowest-friction. Needs the model catalog first.
2. **Witchgrid as Merlina's compute provider.** Merlina submits training jobs through Witchgrid; CP allocates a GPU worker; runs the training subprocess. Lets Merlina share a GPU pool with inference.
3. **Shared model storage.** Both lean on the same model directory tree (or HuggingFace org), so neither has to push files to the other.

## Relationship to flammen.ai

Witchgrid is **not required** for flammen.ai to ship. flammen.ai (`~/Projects/flammenai/`) runs on hardcoded inference URLs (env vars: `LLAMA_SERVER_URL`, `A1111_URL`). Swapping over to Witchgrid is a one-line config change: point those env vars at Witchgrid's routing API.

flammen.ai is the **first consumer** Witchgrid was designed against. The features that mattered most for it shaped v0.1: routing for text gen (llama-server), VRAM-aware placement so multiple workloads can coexist, dashboard visibility. (Image-gen routing for A1111 is not in v0.1 — flammen.ai's FlameGen still hits A1111 directly.)

## Status

- **`legacy-python/`** — v0.3 Python prototype. Frozen.
- **`cp/` + `agent/` + `dashboard/`** — v0.1 (Hemlock). Tagged `v0.1.0`. Multi-node, capacity-aware, dashboard-driven, end-to-end tested against real `llama-server` running Mahou-12B-Q5 on the lab's RTX A6000.

## Roadmap

The original 9-item v0.1 priority list (`docs/flammen-as-first-consumer.md`) is fully closed:

```
✅ agent split (CP + agents + heartbeats)
✅ hardware introspection (nvidia-smi)
✅ routing API (/v1/llama/{profile}/*)
✅ capacity-aware placement (gguf-driven)
✅ heartbeats + stale-node filter
✅ auto-spawn on first request
✅ capability introspection (parse --help)
✅ intent-driven argv
✅ dashboard
```

Plus operability/infra: spawn-failure visibility, port reservation, zombie reaping, UTF-8 routing fix, embedded-assets single-file deploy, build CI, intent registry.

Open, in rough order:

1. **Expand the test suite.** Hemlock-side unit tests cover intent translation and capability parsing; GGUF parser cases plus CP/agent integration smokes are still open. See `docs/test-cases-todo.md` for the planned cases.
2. **Model catalog.** Each agent scans known dirs (`~/AI/gguf_models`, A1111 checkpoints) and reports what's available by alias. Profiles reference aliases (`"model_alias": "mahou-12b-q5"`) instead of host-specific paths. Unblocks Merlina integration vector #1.
3. **`WITCHGRID_DATA_DIR` env.** Pin sqlite location so it doesn't move when the binary is launched from a different CWD.
4. **TCP-probe `pick_port`.** Detect non-Witchgrid port contention (other workloads on the box) before spawn rather than after the EADDRINUSE crash.
5. **Release artifacts.** CI already builds; add a release job that uploads `witchgrid-cp` + `witchgrid-agent` + `witchgrid-inspect` on tag push.
6. **SSE / streaming proxy.** When a consumer wants `stream: true`, the routing proxy needs to forward chunks instead of buffering. Deferred until a real consumer asks.
7. **Health checks + routing exclusion.** Basic `alive=true` filtering and auto-spawn `/health` waits exist; richer per-engine health checks and load-aware exclusion are still open.
8. **Engines beyond llama.cpp.** AUTOMATIC1111 / ComfyUI / vLLM as additional `binary` types. Intent vocabulary will need engine-specific subsets.

Longer-term — see `docs/llama-cpp-as-managed-runtime.md` for the "Witchgrid as the llama.cpp manager" brainstorm (vendoring binaries, prebuilt download, source build, eventual auto-canary).
