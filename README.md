# Witchgrid

Orchestration + dashboard for self-hosted AI inference. The control plane that lets you stop SSH-ing into your GPU box to swap models — point your apps at one URL and let Witchgrid decide *what runs where, right now*.

For the case where you have a small fleet of CPU/GPU boxes and want to manage what's running where, what's loaded, and what's available — without hand-wiring each consumer to a hardcoded inference URL.

> **Status: pre-1.0 (v0.7 line).** Single-operator, LAN-first. In daily production use serving [flammen.ai](https://github.com/Schneewolf-Labs). Multi-node capacity-aware placement, auto-spawn, on-demand model management, a live dashboard, and a self-healing service supervisor all work. `main` is ahead of the `v0.7.0` tag (auto-restart watchdog, `/metrics`, SQLite WAL, `WITCHGRID_DATA_DIR`, unit + integration tests). See [the 1.0 punch list](#roadmap-to-10).

Built in [Hemlock](https://hemlang.dev) (2.5.7). Each binary is a single ~7 MB ELF with universal dynamic deps (`libm`, `libffi`, `libcrypto`, `libwebsockets`, `libc`) — deploy is `scp` + a service unit.

---

## What it does

- **Node registry + heartbeats** — every box runs an agent that reports hardware (GPU model, total/free VRAM via `nvidia-smi`, CPU, RAM, disk) on register and every 30 s. Stale (> 90 s) nodes drop out of placement.
- **Capacity-aware placement** — a GGUF metadata parser extracts model weights + KV-cache footprint at decision time; placement picks the (node, GPU set) that fits in live free VRAM. Tensor-split across GPUs when needed.
- **Auto-spawn on demand** — `POST /v1/llama/{profile}/*` proxies to a running instance, or — if none — places + spawns one, waits for its `/health`, then completes the request. Spawn nothing by hand.
- **Self-healing supervision** — the agent keeps its services as *desired state*: an **auto-restart watchdog** (default on, per-node toggle) respawns any service that dies, covering both crashes and host reboots, with crash-loop backoff. Orphan adoption re-attaches services that outlived an agent crash.
- **Multi-engine** — not just llama.cpp. Manages **`llama-server`** (chat/embeddings/vision), **`sd-server`** (stable-diffusion.cpp images), **`whisper-server`** (STT), and **`piper`** (TTS), each with a normalized profile + on-demand install/activate.
- **Model management** — agents scan model dirs into a per-node catalog (advertised by alias, so profiles stop pinning host paths); CP can pull from HuggingFace and distribute models peer-to-peer between nodes.
- **Intent-driven argv** — profiles declare normalized intents (`flash_attention: true`, `kv_cache_k: "q4_0"`, `context: 131072`); the agent translates each into the binary's actual flag form from its parsed `--help`, so one profile produces the right argv across llama.cpp versions.
- **Routing + SSE** — direct `/resolve/{profile}` for resolve-then-connect consumers (CP stays off the data path), or the `/v1/llama` proxy with **SSE passthrough** (`stream:true` streams `text/event-stream` straight through).
- **Observability** — Prometheus `/metrics` (node liveness, per-GPU VRAM, watchdog state) + a live HTMX dashboard (nodes, services, profiles, capabilities, catalog, transfers, bench).

## What it isn't

- **Not a job queue.** Consumers bring their own (pgmq, RabbitMQ, …). Witchgrid answers "where does this request go *now*," not "when does this job run."
- **Not a fine-tuning harness.** See [Merlina](https://github.com/Schneewolf-Labs/Merlina) — the intended composition is *Merlina trains, Witchgrid serves*.
- **Not Kubernetes.** Single-binary CP + lightweight agents over plain HTTP. No pods, no manifests, no networking abstractions.
- **Not multi-tenant (yet).** Single operator. Auth is an *optional* shared bearer secret (`WITCHGRID_SHARED_SECRET`); the design target is a trusted LAN — **don't expose the CP to the internet.**
- **Not for single-node setups.** One machine? Just SSH and edit your scripts. The value kicks in at ≥2 nodes, or when sharing a GPU between workloads.

## Architecture

```
┌──────────────┐   embedded HTMX dashboard + Prometheus /metrics
│  operator /  │
│  Grafana     │
└──────┬───────┘
       ▼
┌──────────────────┐        ┌───────────────────────────────┐
│  control plane   │ ◄───── │  consumers                    │
│   cp/  :8765     │  HTTP  │  resolve-then-connect, or the │
│  registry · place │       │  /v1/llama proxy (+ SSE)      │
│   · route · catalog│      └───────────────────────────────┘
└────────┬─────────┘
         │  /register heartbeats  +  spawn/stop/settings RPC
   ┌─────┼───────────────┬────────────────────┐
   ▼     ▼               ▼                    ▼
┌──────────┐      ┌──────────┐        ┌──────────────┐
│ agent    │      │ agent    │        │ agent (cpu)  │
│  :8766   │      │  :8766   │        │  :8766       │
│ llama /  │      │ sd /     │        │ whisper /    │
│ sd /...  │      │ llama    │        │ piper        │
│  :18xxx  │      │  :19xxx  │        │  :19xxx      │
└──────────┘      └──────────┘        └──────────────┘
```

`cp/` and `agent/` each compile to a standalone ELF (`witchgrid-cp`, `witchgrid-agent`). Profiles, the node registry, and routing all live on the CP; agents are stateless-ish supervisors that run whatever the CP inlines into a spawn.

## Quickstart

```bash
# Control plane — on the box you'll call from
cd cp && hemlockc cp.hml -o witchgrid-cp && ./witchgrid-cp
#  → :8765, dashboard at GET /, metrics at GET /metrics

# Agent — on every box that hosts inference
cd agent && hemlockc agent.hml -o witchgrid-agent
WITCHGRID_CP_URL=http://<cp-host>:8765 \
WITCHGRID_AGENT_URL=http://<this-host>:8766 \
WITCHGRID_DATA_DIR=$HOME/.witchgrid \
  ./witchgrid-agent
#  → registers, heartbeats every 30s, supervises engines on demand

# Drive it
curl -s http://<cp-host>:8765/nodes | jq            # who's in the grid
curl -X POST http://<cp-host>:8765/v1/llama/chat-mahou/completion \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello","n_predict":32}'             # auto-place + spawn + complete
```

Prebuilt binaries (linux-x86_64 + macos-arm64) are attached to each [GitHub release](https://github.com/hemlang/witchgrid/releases); installing the matching [Hemlock](https://hemlang.dev) runtime is only needed to *build*.

## Docs

| Doc | What's in it |
|-----|--------------|
| [`docs/operations.md`](docs/operations.md) | **Deploy + run in production**: service units (systemd / pm2 / launchd), the full env-var reference, auto-restart, metrics scraping, backup/restore, reboot recovery, upgrades. |
| [`cp/README.md`](cp/README.md) | Control-plane endpoint reference + build/run + smoke test. |
| [`agent/README.md`](agent/README.md) | Agent endpoints, config, profiles (owned by CP), engine install lifecycle, restart behavior. |
| [`CLAUDE.md`](CLAUDE.md) | Architecture, components, design decisions, project relationships. |
| [`docs/test-cases-todo.md`](docs/test-cases-todo.md) | Test backlog (what's automated vs. still manual). |
| [`docs/llama-cpp-as-managed-runtime.md`](docs/llama-cpp-as-managed-runtime.md) | The "Witchgrid as the llama.cpp manager" long-game (vendoring, canary/rollback). |

## Layout

| Dir | What's there |
|-----|--------------|
| `cp/` | Control-plane daemon: registry, placement, routing, profiles, catalog, dashboard, GGUF introspection. |
| `agent/` | Per-node agent: hardware probe, capability introspection, engine supervisor + watchdog, install lifecycle. |
| `dashboard/` | HTMX + Alpine + Pico assets, embedded into `cp` via `scripts/embed_assets.sh`. |
| `scripts/` | Build helpers (`embed_assets.sh`) + the CP `systemd` unit template. |
| `tests/` | Unit suite (`hemlock tests/run.hml`) + integration harness (`tests/integration/`). |
| `docs/` | Design docs, ops guide, roadmaps, the Hemlock language-eval archive. |
| `legacy-python/` | Frozen v0.3 Python prototype. Reference only. |

## Tests

```bash
hemlock tests/run.hml                         # unit: intent / capabilities / GGUF parser
bash tests/integration/run_integration.sh     # integration: real CP+agent, fake backend
```

CI (`.github/workflows/build.yml`) builds both platforms, runs the unit + integration suites, and on a `v*` tag attaches per-platform binaries + `SHA256SUMS` to the release. See [`tests/README.md`](tests/README.md).

## Roadmap to 1.0

Capability-wise it's there; 1.0 is about coherence, deployability, and test breadth:

- [x] **Single source of truth for the version** (`version.hml`), surfaced in `/healthz` + `/metrics` (`witchgrid_build_info`) + the dashboard header.
- [x] **CP bind configurable** — `WITCHGRID_CP_HOST` / `WITCHGRID_CP_PORT`.
- [x] **Deploy/ops documented** — see [`docs/operations.md`](docs/operations.md).
- [x] **Test breadth** — the integration harness now covers port-contention, stale-node drop, spawn-failure, bad-model-path, multi-node registration, the CPU/GPU device override, and the live/health endpoints (26 assertions).
- [ ] **Auth posture finalized** — shared-secret path works + is documented (LAN-first). Still open: an operator login for the dashboard (slice 2) + per-consumer `/v1/llama` tokens (slice 3). Until then: keep it on a trusted LAN or behind an authenticating reverse proxy (HTTP-only, no TLS).
- [~] **Graceful shutdown / 2-agent test** — single-host multi-node registration is tested; WAL-checkpoint-on-SIGTERM is **blocked on Hemlock**: its async runtime (the libuv/libev loop `serve()` runs on) overrides the signal disposition, so handlers don't fire once the loop is up. SQLite WAL is crash-durable, so an ungraceful stop recovers on next open — low impact until the Hemlock fix lands.

## Related projects

- **[Merlina](https://github.com/Schneewolf-Labs/Merlina)** — the lab's fine-tuning UI. *Merlina trains, Witchgrid serves.*
- **[flammen.ai](https://github.com/Schneewolf-Labs)** — Witchgrid's first consumer (chat + image + caption workers route through it).

Built in [Hemlock](https://hemlang.dev). The language-evaluation writeup that informed the rewrite lives in [`docs/hemlock-feedback-archive.md`](docs/hemlock-feedback-archive.md).
