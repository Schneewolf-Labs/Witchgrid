# agent — Witchgrid node agent

Runs on every box that hosts inference. Probes hardware, registers with the
control plane, **supervises** local engine processes (llama-server, sd-server,
whisper-server, piper, and operator-declared `local` services), exposes each
binary's capability map, and keeps its services alive with an auto-restart
watchdog. Compiles to a single ~10 MB binary
(`witchgrid-agent`) with universal dynamic deps.

The agent is *not* the source of truth for profiles — since v0.7 those live on
the **CP**, which inlines the full profile object into every spawn payload. The
agent just runs whatever it's told, translating intents → argv against its local
binary's capabilities.

## What's in here

| File | Role |
|---|---|
| `agent.hml` | Entry point. Reads env, probes hardware, introspects engines, registers, starts the heartbeat + watchdog task, opens sqlite, dispatches routes. |
| `services.hml` | Service supervisor: `posix_spawn` with `setsid`, raw-fd log redirection, transient `CUDA_VISIBLE_DEVICES`/`LD_LIBRARY_PATH`, sqlite-tracked PIDs, verified stop (SIGTERM → SIGKILL → reap). Plus the **auto-restart watchdog** (`reconcile_services`, honours `profile.pin`), orphan adoption, per-service VRAM attribution (`measure_services`), and the `agent_settings` store. |
| `sigmask.hml` | Clears the spawning thread's signal mask around `posix_spawn` (FFI `pthread_sigmask`) so services don't inherit Hemlock's blocked worker-thread mask. |
| `fingerprint.hml` | `profile_fingerprint` (hash of the process-shaping profile fields; stamped on `/services` rows) + `json_tree` (tree copy before `stringify`). |
| `hardware.hml` | `nvidia-smi` parser → `{ role: "gpu"\|"cpu", gpus, cpu_cores, ram_*, disks }`. Also probes unmanaged GPU processes. |
| `capabilities.hml` | Runs `<binary> --help`, parses into `{flag → {short, longs, value, description}}`. Cached per agent lifetime. |
| `intent.hml` | Translates witchgrid intents (`flash_attention`, `kv_cache_k`, …) into the binary's actual flag form using the capability map. Handles `boolean_or_enum` for flags that changed shape across llama.cpp versions. |
| `llama_cpp.hml`, `sd_cpp.hml`, `whisper_cpp.hml`, `piper_cpp.hml` | Per-engine install lifecycle (download/build a binary, list installed, activate `current`) + binary-path resolution. |
| `local_services.hml` | The `local` engine's declaration files: load + validate, refuse undeclared names, build the explicit argv/env for a spawn, and the public view sent to the CP. |
| `lora_share.hml` | Shared-base LoRA serving rules (pure): adapters a `share_group` profile wants, the compatibility key, shared-server sizing, the per-request `lora` selection, which endpoints get it. |
| `lora_proxy.hml` | The member-port proxy for shared-LoRA profiles: byte-level HTTP/1.1 forwarding to the shared llama-server, selection injection, unbuffered SSE. |
| `transfers.hml` | Peer-to-peer model pulls (stream a GGUF from another node, bounded memory). |
| `http_server.hml` | Minimal HTTP/1.1 server (shared shape with `cp/`). |

## Engines

The agent supervises four engine binaries plus declared `local` services; a
profile's `binary` field selects one:

| `binary` | Engine | Bind flag | Health |
|---|---|---|---|
| `llama-server` | llama.cpp (chat, embeddings, vision) | `--port` | `GET /health` |
| `sd-server` | stable-diffusion.cpp (images) | `--listen-port` (`-l`) | `GET /sdapi/v1/options` |
| `whisper-server` | whisper.cpp (STT) | `--port` | — |
| `piper` | piper (TTS) | `--http` | — |
| `local` | anything declared on the agent (see below) | env `PORT` / `{port}` in argv | declared `health_path` |

Each engine has an on-demand install layer: `POST /{engine}_cpp/install`,
`GET /{engine}_cpp/installed`, `POST /{engine}_cpp/activate`. Spawns use the
`current` activated build, falling back to a bare-name PATH lookup. `local`
services have no install layer — the operator installs them (a venv, a script)
and declares them.

## Local services (`local` engine)

For a service that is just "run this command, it serves HTTP on a port" — e.g.
a Python venv (Kokoro TTS + RVC behind a small server) — that should live under
the same supervisor as the engines: GPU pin from placement, PID tracking in
sqlite, log capture, auto-restart watchdog, SIGTERM stop with SIGKILL
escalation, re-adoption after an agent restart.

**Security model.** CP auth is optional and is off on real fleets, so anything
a CP profile can say, any LAN peer can say. A profile therefore can NOT carry a
command. Commands live only on the agent, in declaration files the operator
writes:

```
$WITCHGRID_LOCAL_SERVICES/<name>.json      (default ~/.witchgrid/local-services/)
```

and a CP profile only *references* a declared name:

```json
{ "binary": "local", "local_service": "riko-voice" }
```

The agent refuses (403) any name it has no valid declaration for, and ignores
every argv-shaped field on the profile (`intent`, `extra_flags`, `model`) — the
CP refuses to store `extra_flags` on a local profile at all. A declaration file
(or its directory) that is group- or world-writable is refused. There is no
shell: `argv` goes to `posix_spawn` as a real argv.

**Declaration** (one file per service; the file stem must equal `name`;
unknown fields are rejected so a typo like `vram` fails loudly):

| field | required | meaning |
|---|---|---|
| `name` | yes | `[a-z0-9][a-z0-9._-]{0,62}`; what profiles reference |
| `argv` | yes | array of strings; `argv[0]` absolute (or `~/…`) and executable. `{port}` in any element is replaced with the port |
| `port` | yes | default port, 1024-65535. The CP may move it (contention); the process always gets the real one in env `PORT` (and `{port}`) |
| `cwd` | no | absolute (or `~/…`) existing dir; default: `argv[0]`'s directory |
| `env` | no | `{ "KEY": "string" }`; `PORT` / `CUDA_VISIBLE_DEVICES` are agent-owned and refused |
| `inherit_env` | no | extra agent env var names to pass through |
| `health_path` | no | default `/health`; used by CP auto-spawn and `/api/ready` |
| `vram_mb` | no | default 0. CP places the service on **one** GPU with this much free; 0 = no GPU (`CUDA_VISIBLE_DEVICES=""`) |
| `startup_timeout_s` | no | default 60; how long CP auto-spawn waits for `health_path` |
| `description`, `_comment` | no | display / notes |

`~/` is expanded (agent user's home) for `argv[0]` and `cwd` only. The child
gets an **explicit** environment, not the agent's: `PATH HOME USER LOGNAME LANG
LC_ALL TZ TMPDIR` from the agent, then `inherit_env`, then `env`, then `PORT`
and `CUDA_VISIBLE_DEVICES` from placement. In particular the agent's
`WITCHGRID_SHARED_SECRET` never reaches the service.

The child is spawned with `setsid`, so it leads its own process group. Stop,
the SIGKILL escalation and the watchdog act on the **whole group**: a `run.sh`
that starts python without `exec` still stops cleanly, and the unmanaged-GPU
probe counts the python grandchild as ours. Declarations are re-read on every
spawn/respawn/heartbeat — add or edit one without restarting the agent.

Example — [`docs/examples/local-services/riko-voice.json`](../docs/examples/local-services/riko-voice.json):

```json
{
  "name": "riko-voice",
  "description": "Riko voice: Kokoro TTS + RVC (python venv)",
  "argv": ["~/riko-voice/run.sh"],
  "cwd": "~/riko-voice",
  "env": { "DEVICE": "cuda" },
  "port": 19300,
  "health_path": "/health",
  "vram_mb": 1300,
  "startup_timeout_s": 180
}
```

```bash
mkdir -p ~/.witchgrid/local-services && chmod 755 ~/.witchgrid/local-services
cp docs/examples/local-services/riko-voice.json ~/.witchgrid/local-services/
chmod 644 ~/.witchgrid/local-services/riko-voice.json
curl -s http://<agent>:8766/local-services | jq     # declared + refused files (with reasons)

# on the CP: a profile that names it, then spawn (placed on a node that
# declares it, on one GPU with >= vram_mb free) — or pin with node_id + gpus
curl -X POST http://<cp>:8765/api/profiles -H 'content-type: application/json' \
  -d '{"name":"riko-voice","profile":{"binary":"local","local_service":"riko-voice"}}'
curl -X POST http://<cp>:8765/services -H 'content-type: application/json' \
  -d '{"profile":"riko-voice"}'                          # or add "node_id":"schneewolf","gpus":[2]
curl -s http://<cp>:8765/resolve/riko-voice              # → base_url http://<node>:19300
```

Consumers reach a local service **directly** at the resolved `node:port`
(`GET /resolve/{profile}`); the CP has no binary-safe proxy route for them (the
`/v1/llama` proxy is JSON-only, built for llama-server).

## Shared-base LoRA serving (`share_group`)

Profiles that run the **same base GGUF** with different LoRAs (Luna, Familiar
and Riko on B4-9B) can opt in to sharing one llama-server instead of loading
the base once per profile. Full design + measurements:
[`../docs/shared-lora.md`](../docs/shared-lora.md).

```jsonc
"luna-spark": {
  "binary": "llama-server",
  "share_group": "spark-b4-9b",           // the opt-in
  "intent": { "context": 65536, "parallel_slots": 2, "gpu_layers": 99, "flash_attention": true },
  "extra_flags": ["--jinja", "--lora", "/path/B4-9B-Luna-F2-f16.gguf"],   // or "lora": "/path/…"
  "default_port": 18091
}
```

What the agent does with a spawn of such a profile:

- **One server per (group, base model path, server settings, GPU set)** —
  the `shared:<group>` row. llama-server with every member's adapter at
  global scale 0 (`--lora-scaled <path>:0`), `--cache-ram 0` (the host-RAM
  prompt cache isn't adapter-aware), `--host 127.0.0.1`, an internal port
  from `WITCHGRID_SHARED_PORT_BASE` (default 18700). Sized: slots = sum of
  members' `parallel_slots`, per-slot context = max of members'.
- **Each member keeps its port**: a proxy inside the agent listens there and
  forwards everything (any path/method/headers, SSE unbuffered) to the
  shared server, appending the member's `"lora":[{"id":N,"scale":S},…]` (all
  ids explicit) to generation requests. A client-sent `lora` is overridden.
  `POST /lora-adapters` and `POST /slots/*` are refused (403). `/v1/models`
  and `/props` report the member's `-a` alias if it has one.
- **Join** restarts the server only if it doesn't already have the member's
  adapter / enough slots / per-slot context (llama-server can't load an
  adapter at runtime). **Leave** never restarts; the **last** member stops
  the server; stopping the **server row** stops all members.
- Incompatible settings within one group + base (e.g. one profile has
  `--jinja`, one doesn't) → **409** with both settings.
- **Watchdog**: the server respawns like any llama-server row; member ports
  are re-checked every tick and re-bound at boot (the proxies live in the
  agent process — an agent restart closes member ports until the new agent
  is up, while the shared server keeps running and is re-adopted).
- `/services` entries carry `shared`: `{role: "server", group, key, adapters,
  slots, ctx_per_slot, context, members: [{profile, port}], …}` or `{role:
  "member", group, key, server_id, server_port, server_alive, adapters,
  alias}`; the dashboard shows "shared · N members" / "↳ group" badges.

Trade-off: llama-server never batches requests with different adapter sets,
so when two members generate at once the second waits for the first to
finish (measured TTFT 3.9 s behind a 256-token generation). Don't share
latency-critical profiles.

## Endpoints

CP is the only intended caller — agents don't need to be internet-reachable, just
reachable from the CP.

```
# services (supervisor)
POST /services         { profile, profile_name, model?, port?, gpus?, tensor_split? } → 201 {id,...}
GET  /services                                                         → [{id,profile,pid,port,alive,...}]
POST /services/stop    { id, grace_s?, report? }                       → 204 once the process group is gone
                                                                         (SIGTERM → grace_s [10; 1 if SIGTERM is
                                                                         blocked/ignored] → SIGKILL → reap; adopted
                                                                         services too). report:true → 200 {gone,
                                                                         killed, sigterm_unreceivable, waited_s};
                                                                         202 + report if it outlived SIGKILL (row kept,
                                                                         listed as state "stopping")
GET  /vram                                                             → measure now: { gpus: [{index, total_mb,
                                                                         used_mb, free_mb, services_mb, other_mb}],
                                                                         services: [{id, profile, port, gpus, vram_mb,
                                                                         vram_total_mb, uptime_s, profile_fp}], other }
GET  /services/log/{id}                                                → text/plain (tail)

# per-agent settings (auto-restart watchdog toggle)
GET  /settings                                                         → { auto_restart }
PUT  /settings         { auto_restart: bool }                          → { auto_restart }

# capabilities + catalog
GET  /capabilities                                                     → { "llama-server": {...}, "sd-server": {...}, ...,
                                                                         "local": { name → {port, vram_mb, health_path, …} } }
GET  /local-services                                                   → { dir, services: [...], errors: [{file, error}] }
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
#           WITCHGRID_MODEL_DIRS_EXTRA, WITCHGRID_SHARED_SECRET,
#           WITCHGRID_LOCAL_SERVICES (local engine declarations dir)
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
- **Pins**: a profile with `pin: {node_id, gpus, port}` naming this node is
  respawned on exactly those GPUs/port.
- **Signal mask**: services start with nothing blocked (see `sigmask.hml`);
  ones started by an agent older than that keep SIGTERM blocked until
  restarted, which the stop path detects and SIGKILLs after 1 s.
- **Orphan adoption**: services spawned with `setsid` survive an agent *crash*;
  on restart the agent re-attaches them by port (no double-spawn).
- The watchdog's liveness checks use `/proc` on Linux and fall back to `ps` on
  macOS, so the agent works on either.

## Hardware probe

`nvidia-smi --query-gpu=...` → one entry per GPU (with `used_mb`). On every
heartbeat (and `GET /vram`) `nvidia-smi --query-compute-apps` is attributed to
services by pid, process group and descendants; `/services` rows carry the
result as `vram_mb` (`{"<gpu>": MB}`), the heartbeat sends it to the CP
(`service_vram`, `gpu_usage`). No `nvidia-smi` on PATH →
`{ role: "cpu", gpus: [] }`, registers anyway (CPU profiles still spawn there).
