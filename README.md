# Witchgrid

Orchestration + dashboard for self-hosted AI inference services. The control plane that lets you stop SSH-ing into your GPU box every time you want to swap a model.

For the case where you have a small fleet of CPU/GPU boxes and want to manage what's running where, what's loaded, and what's available — without hand-wiring each consumer to a hardcoded URL.

> **Status: v0.1.** Single-tenant, LAN-only, llama.cpp-only. Multi-node spawn + capacity-aware placement + auto-spawn-on-first-request + dashboard all working. See `docs/test-cases-todo.md` for the open edges.

## Layout

| Dir | What's there |
|-----|--------------|
| `cp/` | Control plane daemon. Node registry, routing API, dashboard, model inspection. |
| `agent/` | Per-node agent. Probes hardware, registers with CP, supervises local `llama-server` processes, exposes capability map of its installed binary. |
| `dashboard/` | Static HTMX + Alpine.js + Pico CSS assets. Embedded into `cp` via `scripts/embed_assets.sh`. |
| `assets/` | Brand mark (logo.svg). Embedded the same way. |
| `scripts/` | Build-time helpers. Currently just the asset embedder. |
| `docs/` | Design docs + roadmaps. `flammen-as-first-consumer.md` (v0.1 priority list, all green now), `llama-cpp-as-managed-runtime.md` (long-game brainstorm), `hemlock-feedback-archive.md` (language eval — all 7 issues resolved upstream), `test-cases-todo.md` (open edges + planned tests). |
| `legacy-python/` | Frozen v0.3 Python prototype. Reference only; no new features. |

Built in [Hemlock](https://hemlang.dev) 2.2.x. Each binary is a single ~7 MB ELF with universal dynamic deps (`libm`, `libffi`, `libcrypto`, `libwebsockets`, `libc`). Deploy = `scp + systemd unit + done`.

## What it does (v0.1)

- **Node registry** — agents POST `/register` at boot with hardware (GPU model, total/free VRAM via `nvidia-smi`); re-register every 30 s as heartbeat. Stale (> 90 s) nodes drop out of placement.
- **Service supervisor** — agents `posix_spawn` `llama-server` with `setsid: true`, raw fd redirection for logs, transient `CUDA_VISIBLE_DEVICES`, sqlite-tracked PIDs, `kill(SIGTERM)` for stop. Zombie rows reaped on agent boot.
- **Routing API** — `POST /v1/llama/{profile}/*` on CP proxies to a running instance for that profile, round-robin. If none is running, capacity-aware placement picks a node with the GGUF on disk + enough free VRAM and spawns one transparently before completing the request.
- **Capacity-aware placement** — GGUF metadata parser extracts model size + KV-cache footprint at spawn-decision time; placement picks the GPU set that fits.
- **Capability introspection** — at agent boot, `llama-server --help` is parsed into a `{flag → {short, longs, value, description}}` map and exposed at `GET /capabilities`. CP aggregates per-node.
- **Intent-driven argv** — profile templates declare normalized intents (`flash_attention: true`, `kv_cache_k: "q4_0"`, `context: 131072`); the agent translates each into the binary's actual flag form using its capability map. Profiles outlast llama.cpp upgrades.
- **Dashboard** — HTMX-driven live view at `GET /` on CP. Nodes, services, profiles, capabilities tables. Spawn form (Alpine.js) for manual placement.

## What it isn't

- Not a job queue (consumers bring their own pgmq / RabbitMQ / etc.)
- Not a fine-tuning harness (see [Merlina](https://github.com/Schneewolf-Labs/Merlina))
- Not Kubernetes — single-binary CP + lightweight agents over plain HTTP, no auth, single operator
- Not for single-node setups (just SSH and edit your scripts at that scale)

## Quickstart

```bash
# CP, on the box you want to call from
cd cp && hemlockc cp.hml -o witchgrid-cp && ./witchgrid-cp
#  → listens on :8765 (HTTP), serves dashboard at GET /

# Agent, on every box that hosts inference
cd agent
hemlockc agent.hml -o witchgrid-agent
WITCHGRID_CP_URL=http://<cp-host>:8765 \
WITCHGRID_AGENT_URL=http://<this-host>:8766 \
  ./witchgrid-agent
#  → registers, heartbeats every 30s, supervises llama-server on demand
```

See `cp/README.md` and `agent/README.md` for endpoint reference and smoke-test walkthroughs.

## Open

The v0.1 priority list (`docs/flammen-as-first-consumer.md`) is fully closed. Open edges:

- **Test suite** — see `docs/test-cases-todo.md` for what's covered manually + the planned automated cases.
- **Model catalog** — agent scans known dirs and advertises models by alias, so profiles stop pinning host-specific paths.
- **Hardening** — TCP-probe `pick_port` for non-Witchgrid contention; `WITCHGRID_DATA_DIR` env so `witchgrid.db` doesn't dance with CWD.
- **SSE streaming** — deferred until a real consumer needs it.
- **Real release artifacts** — CI builds the binaries on every push but doesn't yet attach them to tags.

Longer-term: the [Merlina](https://github.com/Schneewolf-Labs/Merlina) pairing ("Merlina trains, Witchgrid serves") and the "Witchgrid as the llama.cpp manager" angle (vendoring binaries / source builds / canary). See `CLAUDE.md` and `docs/llama-cpp-as-managed-runtime.md` for the long form.
