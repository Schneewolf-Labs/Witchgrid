# Witchgrid

Orchestration + dashboard for self-hosted AI inference services. For the case where you have a small fleet of CPU/GPU boxes and want to manage what's running where, what's loaded, and what's available — without ssh-ing into each one and editing scripts.

## Vision

You shouldn't have to ssh into your GPU box to swap a model. You shouldn't have to remember which checkpoint lives where. You shouldn't have to hand-wire each consuming app to a hardcoded inference URL. Witchgrid is the control plane that solves those problems behind a dashboard you can actually look at.

## What it does

- **Node registry** — every machine reports its hardware (GPU model, total/free VRAM via `nvidia-smi`) on register and on heartbeat (30 s). Stale (> 90 s) nodes drop out of placement decisions.
- **Service supervisor** — agents `posix_spawn` `llama-server` with a real argv (no shell wrapper), `setsid: true` for terminal detach, raw fd redirection for log/dev-null, transient `CUDA_VISIBLE_DEVICES`. PIDs tracked in a per-agent sqlite. SIGTERM on stop. Zombie rows reaped on agent boot.
- **Routing API** — `POST /v1/llama/{profile}/*` on CP proxies to a healthy instance for that profile, round-robin. If none exists, capacity-aware placement picks (node, GPU set) with the GGUF on disk + enough free VRAM, spawns transparently, then completes the request.
- **Capacity-aware placement** — the GGUF metadata parser pulls model size + KV-cache footprint at decision time; placement picks the GPU set that fits. Naive accounting (subtract claimed VRAM from free) — gets 80% of the value without talking to CUDA.
- **Capability introspection** — at agent boot, `llama-server --help` is parsed into `{flag → {short, longs, value, description}}` and exposed at `GET /capabilities`. CP aggregates per-node and renders in the dashboard.
- **Intent-driven argv** — profile templates declare normalized intents (`flash_attention: true`, `kv_cache_k: "q4_0"`, `context: 131072`); at spawn time the agent translates each intent into the binary's actual flag form using its capability map. The same profile produces the right argv on different llama.cpp versions (legacy boolean `-fa` vs enum `-fa on|off|auto` is the canonical case).
- **Dashboard** — HTMX-driven live view at `GET /` on CP. Nodes, services, profiles, capabilities tables. Spawn form (Alpine.js) for manual placement. Static assets live in `dashboard/` and `assets/`, embedded into the CP binary at build time via `scripts/embed_assets.sh`.

## What it isn't

- **Not a job queue.** Consumers bring their own (pgmq, RabbitMQ, BullMQ). Witchgrid handles "where does this request go *right now*," not "when does this job run."
- **Not a fine-tuning harness.** Doesn't manage training runs. See [Merlina](https://github.com/Schneewolf-Labs/Merlina) for the lab's training side; the intended composition is below.
- **Not Kubernetes.** No pod scheduling, no networking abstractions, no manifests. Single-binary control plane + lightweight node agents over plain HTTP. Auth is an *optional* shared bearer secret (`WITCHGRID_SHARED_SECRET`); the design target is a trusted LAN — don't expose the CP to the internet.
- **Not for single-node setups.** If you have one machine, you don't need Witchgrid — just SSH and edit your scripts. The value kicks in at ≥2 nodes or when sharing a GPU between multiple workloads.

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
| **Control plane** (`cp/`) | Node registry, routing API, dashboard, GGUF introspection, capacity-aware placement. Exposes `/register`, `/nodes`, `/services` (proxy to agents), `/v1/llama/{profile}/*`, `/profiles`, `/capabilities`, `/healthz`, `/mcp` (MCP server), dashboard at `/`. |
| **MCP server** (`cp/mcp.hml`) | Model Context Protocol over Streamable HTTP at `POST /mcp`. A thin JSON-RPC adapter exposing existing CP handlers as MCP tools (`list_nodes`, `list_services`, `list_profiles`, `list_catalog`, `fleet_status`, `resolve_profile`, `spawn_service`, `stop_service`) so an AI assistant can introspect + drive the fleet. CP-agnostic — cp.hml hands it the tool table; auth via the shared bearer like the rest of the operator API. |
| **Node agent** (`agent/`) | Hardware probe (nvidia-smi), capability introspection (`<engine> --help`), service supervisor (posix_spawn + setsid) + auto-restart watchdog, engine install lifecycle, heartbeat. Exposes `/services`, `/settings`, `/capabilities`, `/models`, `/{engine}_cpp/*`, `/port_check`, `/healthz`. Profiles live on the CP, not here. |
| **Profile templates** | **CP-owned** (since v0.7) — stored + versioned in the CP's sqlite, seeded with defaults, edited via `/api/profiles` + the dashboard, and inlined into each spawn payload. Each profile is `{ binary, intent, extra_flags, default_port, default_model\|model_alias, ... }`. `intent` is a normalized map; `extra_flags` is the raw escape hatch. New profile = an API call, not a rebuild. |
| **Intent translator** (`agent/intent.hml`) | Maps witchgrid-level intents (`flash_attention`, `kv_cache_k`, …) to the binary's actual flag form using its capability map. Handles `boolean_or_enum` for flags that changed shape between llama.cpp versions. |
| **GGUF parser** (`cp/gguf.hml`) | Reads GGUF metadata to extract model size + KV-cache footprint for placement. Standalone CLI `witchgrid-inspect` wraps it. |
| **Dashboard** | Static `dashboard/index.html` + `dashboard/spawn_form.js` + `dashboard/styles.css` + `assets/logo.svg`. Embedded into CP via `scripts/embed_assets.sh` → `cp/embedded_assets.hml`. HTMX polls `/ui/*` fragments; Alpine drives the spawn form. |

## Resolved design decisions

- **Language: Hemlock** ([hemlang.dev](https://hemlang.dev), built on 2.5.7). Python prototype shipped through v0.3 (now in `legacy-python/`); the Hemlock rewrite (v0.7 line) is what's documented here. Single ~7 MB binary each, universal libs only — drops onto every box without a runtime install. The 7-issue language-evaluation writeup that informed the rewrite lives in `docs/hemlock-feedback-archive.md`; all seven were resolved upstream. (Witchgrid has since driven further Hemlock fixes — e.g. the v2.5.7 async-task pthread + accepted-socket leak fixes that matter to the long-running daemons.)
- **Service templating format.** Profiles are CP-owned rows in sqlite (moved off the agent in v0.7), seeded with defaults and edited via `/api/profiles` + the dashboard — versioned, so a running service keeps the argv it was spawned with even after the profile is edited. Still a normalized intent map, not raw YAML.
- **Model storage + catalog.** Agents scan their model dirs into a per-node catalog advertised by alias, so profiles reference `model_alias` instead of host-specific paths. CP can pull models from HuggingFace and distribute them peer-to-peer between nodes (`transfers.hml`).
- **Concurrent loading on a single GPU.** Naive VRAM accounting (free_mb − sum(claimed_mb)). Works.
- **Auth / multi-tenancy.** Single-operator, LAN-first. Auth is an *optional* shared bearer secret (`WITCHGRID_SHARED_SECRET`, must match on CP + every agent). Per-consumer API keys + quotas are a post-1.0 item if it grows beyond one operator.
- **Engines.** Multi-engine since v0.7: `llama-server`, `sd-server` (stable-diffusion.cpp), `whisper-server`, `piper`, each with an on-demand install/activate lifecycle. The `binary` field on a profile selects the engine.
- **Self-healing.** An auto-restart watchdog (per-node, default on) keeps managed services as desired state — respawns on crash + reboot, with crash-loop backoff. See `agent/services.hml` `reconcile_services`.
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

flammen.ai is the **first consumer** Witchgrid was designed against, and now runs on it in production: FlameWorker (chat via the `chat-mahou` profile + memory via `memory-phoenix`), FlameGen (character design via `designer-cpu` + image gen via the `image-niku` `sd-server` profile, having moved off direct A1111), and FlameCaption all resolve through Witchgrid. The features that shaped the early versions: routing for text gen, VRAM-aware placement so multiple workloads coexist, and dashboard visibility — since extended with the `sd-server` image engine and the auto-restart watchdog that keeps those persistent instances alive across reboots.

## Status

- **`legacy-python/`** — v0.3 Python prototype. Frozen.
- **`cp/` + `agent/` + `dashboard/`** — pre-1.0, **v0.7 line** (Hemlock 2.5.7); `main` is ahead of the `v0.7.0` tag. In daily **production** use serving flammen.ai (chat / image / caption). Multi-node, capacity-aware, multi-engine (llama / sd / whisper / piper), self-healing (auto-restart watchdog), observable (`/metrics`), with unit + integration tests in CI and multi-platform release artifacts. The 1.0 punch list is in `README.md` (version coherence, configurable CP bind, test breadth, auth posture).

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

**Shipped since v0.1** (the original "open" list is now closed):

- ✅ Unit test suite (gguf parser, intent translator, capabilities parser) **+ an integration harness** (real CP+agent, fake backend) in CI — `tests/`.
- ✅ Model catalog (scan → advertise by alias) + HuggingFace pull + peer-to-peer distribute.
- ✅ `WITCHGRID_DATA_DIR` (+ SQLite WAL / `busy_timeout`).
- ✅ TCP-probe `pick_port` for non-Witchgrid port contention.
- ✅ Release artifacts — tag pushes attach per-platform binaries + `SHA256SUMS`.
- ✅ SSE / streaming proxy passthrough.
- ✅ Health-gated routing (spawn waits for `/health` before proxying).
- ✅ Engines beyond llama.cpp — `sd-server`, `whisper-server`, `piper`, each with an install/activate lifecycle.
- ✅ Auto-restart watchdog + Prometheus `/metrics` (post-v0.7).

**Toward 1.0** (see `README.md` for the punch list): version coherence, configurable CP bind (`:8765` is hardcoded), broader integration-test coverage, finalized auth posture, graceful shutdown.

Longer-term — see `docs/llama-cpp-as-managed-runtime.md` for the "Witchgrid as the llama.cpp manager" brainstorm (vendoring binaries, prebuilt download, source build, eventual auto-canary). vLLM / ComfyUI as further `binary` types remain candidates.
