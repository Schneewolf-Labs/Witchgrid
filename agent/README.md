# agent — Witchgrid node agent

Runs on every box that hosts inference. Probes hardware, registers with the
control plane, **supervises** local engine processes (llama-server, sd-server,
whisper-server, piper), exposes each binary's capability map, and keeps its
services alive with an auto-restart watchdog. Compiles to a single ~7 MB binary
(`witchgrid-agent`) with universal dynamic deps.

The agent is *not* the source of truth for profiles — since v0.7 those live on
the **CP**, which inlines the full profile object into every spawn payload. The
agent just runs whatever it's told, translating intents → argv against its local
binary's capabilities.

## What's in here

| File | Role |
|---|---|
| `agent.hml` | Entry point. Reads env, probes hardware, introspects engines, registers, starts the heartbeat + watchdog task, opens sqlite, dispatches routes. |
| `services.hml` | Service supervisor: `posix_spawn` with `setsid`, raw-fd log redirection, transient `CUDA_VISIBLE_DEVICES`/`LD_LIBRARY_PATH`, sqlite-tracked PIDs, SIGTERM stop. Plus the **auto-restart watchdog** (`reconcile_services`), orphan adoption, and the `agent_settings` store. |
| `hardware.hml` | `nvidia-smi` parser → `{ role: "gpu"\|"cpu", gpus, cpu_cores, ram_*, disks }`. Also probes unmanaged GPU processes. |
| `capabilities.hml` | Runs `<binary> --help`, parses into `{flag → {short, longs, value, description}}`. Cached per agent lifetime. |
| `intent.hml` | Translates witchgrid intents (`flash_attention`, `kv_cache_k`, …) into the binary's actual flag form using the capability map. Handles `boolean_or_enum` for flags that changed shape across llama.cpp versions. |
| `llama_cpp.hml`, `sd_cpp.hml`, `whisper_cpp.hml`, `piper_cpp.hml` | Per-engine install lifecycle (download/build a binary, list installed, activate `current`) + binary-path resolution. |
| `transfers.hml` | Peer-to-peer model pulls (stream a GGUF from another node, bounded memory). |
| `http_server.hml` | Minimal HTTP/1.1 server (shared shape with `cp/`). |

## Engines

The agent supervises four engine binaries; a profile's `binary` field selects one:

| `binary` | Engine | Bind flag | Health |
|---|---|---|---|
| `llama-server` | llama.cpp (chat, embeddings, vision) | `--port` | `GET /health` |
| `sd-server` | stable-diffusion.cpp (images) | `--listen-port` (`-l`) | `GET /sdapi/v1/options` |
| `whisper-server` | whisper.cpp (STT) | `--port` | — |
| `piper` | piper (TTS) | `--http` | — |

Each engine has an on-demand install layer: `POST /{engine}_cpp/install`,
`GET /{engine}_cpp/installed`, `POST /{engine}_cpp/activate`. Spawns use the
`current` activated build, falling back to a bare-name PATH lookup.

## Endpoints

CP is the only intended caller — agents don't need to be internet-reachable, just
reachable from the CP.

```
# services (supervisor)
POST /services         { profile, profile_name, model?, port?, gpus?, tensor_split? } → 201 {id,...}
GET  /services                                                         → [{id,profile,pid,port,alive,...}]
POST /services/stop    { id }                                          → 204
GET  /services/log/{id}                                                → text/plain (tail)

# per-agent settings (auto-restart watchdog toggle)
GET  /settings                                                         → { auto_restart }
PUT  /settings         { auto_restart: bool }                          → { auto_restart }

# capabilities + catalog
GET  /capabilities                                                     → { "llama-server": {...}, "sd-server": {...}, ... }
GET  /models                                                           → [catalog entries]
GET  /models/{alias}/blob                                              → streams the GGUF (peer pulls)
POST /models/pull      { ... }                                        → start a pull
GET  /models/transfers                                                 → in-flight pulls
POST /rescan                                                           → re-scan model dirs, return new count

# engine install lifecycle (llama_cpp | sd_cpp | whisper_cpp | piper_cpp)
POST /{engine}/install · GET /{engine}/installed · POST /{engine}/activate · GET /{engine}/flavor

# misc
POST /port_check       { port: N }                                     → { port, available }  (OS bind probe)
GET  /healthz                                                          → ok   (public)
```

## Profiles (defined on the CP)

A profile declares **intent**, not raw flags. It's stored + versioned on the CP
(`GET /api/profiles`) and inlined into the spawn the agent receives:

```jsonc
"chat-mahou": {
  "binary": "llama-server",
  "intent": { "context": 131072, "kv_cache_k": "q4_0", "kv_cache_v": "q4_0",
              "parallel_slots": 1, "gpu_layers": 99, "flash_attention": true },
  "extra_flags": [],
  "default_port": 18080,
  "model_alias": "mahou-1.5-mistral-nemo-12b.q5_k_m"
}
```

At spawn, `intent.hml` renders each intent against the binary's `--help`-derived
capabilities — short forms preferred (`-c`, `-ctk`, `-ngl`, `-fa on`), longs as
fallback, e.g.:

```
llama-server -c 131072 -ctk q4_0 -ctv q4_0 -np 1 -ngl 99 -fa on -m /…/mahou.gguf --port 18080 --host 0.0.0.0
```

The same profile produces the right argv on a build where `-fa` is still a bare
boolean (`boolean_or_enum` handles both). `extra_flags` is the raw escape hatch.

## Config (env vars)

See [`../docs/operations.md`](../docs/operations.md#configuration-reference) for the full table. Minimum:

```
WITCHGRID_CP_URL      http://10.0.0.10:8765    # required
WITCHGRID_AGENT_URL   http://10.0.0.20:8766    # required — what URL the CP calls us at
WITCHGRID_DATA_DIR    $HOME/.witchgrid         # pin the sqlite DB off CWD (strongly recommended)
WITCHGRID_MODEL_DIR   $HOME/.witchgrid/models  # canonical model dir (default)
# optional: WITCHGRID_AGENT_HOST/PORT, WITCHGRID_NODE_ID,
#           WITCHGRID_MODEL_DIRS_EXTRA, WITCHGRID_SHARED_SECRET
```

`WITCHGRID_AGENT_URL` isn't derivable (NAT / multiple NICs) — always set it.

## Build & run

```bash
hemlockc agent.hml -o witchgrid-agent
WITCHGRID_CP_URL=http://<cp>:8765 WITCHGRID_AGENT_URL=http://<me>:8766 \
WITCHGRID_DATA_DIR=$HOME/.witchgrid ./witchgrid-agent
```

State persists in `witchgrid-agent.db` (sqlite, WAL). Re-registers every 30 s
(CP's stale cutoff is 90 s). See [`../docs/operations.md`](../docs/operations.md) for service units.

## Behavior on restart / crash

- **Auto-restart watchdog** (`reconcile_services`, on by default): at boot and
  every heartbeat, any service whose process is gone is respawned from its stored
  profile/model/GPU pinning — covering crashes *and* host reboots. Crash-loop
  guard parks a service in `failed` after 5 rapid restarts. Toggle via `/settings`.
- **Orphan adoption**: services spawned with `setsid` survive an agent *crash*;
  on restart the agent re-attaches them by port (no double-spawn).
- The watchdog's liveness checks use `/proc` on Linux and fall back to `ps` on
  macOS, so the agent works on either.

## Hardware probe

`nvidia-smi --query-gpu=...` → one entry per GPU. No `nvidia-smi` on PATH →
`{ role: "cpu", gpus: [] }`, registers anyway (CPU profiles still spawn there).
