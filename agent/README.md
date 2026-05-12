# agent — Witchgrid node agent

Runs on every box that hosts inference. Probes hardware, registers with the control plane, supervises local `llama-server` processes, exposes the local binary's capability map. Compiles to a single ~7 MB ELF (`witchgrid-agent`) with universal dynamic deps.

## What's in here

| File | Role |
|---|---|
| `agent.hml` | Entry point. Reads env, probes hardware, registers with CP, starts heartbeat task, opens sqlite, dispatches routes. |
| `hardware.hml` | `nvidia-smi --query-gpu=name,memory.total,memory.free,uuid --format=csv,noheader` parser. Returns `{ role: "gpu"\|"cpu", gpus: [...] }`. |
| `services.hml` | `posix_spawn` `llama-server` with `setsid: true`, raw fd redirection (log file, /dev/null), transient `CUDA_VISIBLE_DEVICES`. PIDs in sqlite. SIGTERM on stop. Liveness check via `/proc/<pid>/status` (zombie detection). Profile templates live here in `PROFILES`. |
| `capabilities.hml` | Runs `llama-server --help`, parses into `{flag → {short, longs, value, description}}`. Cached for the agent's lifetime. |
| `intent.hml` | Translates witchgrid-level intents (`flash_attention`, `kv_cache_k`, …) into the binary's actual flag form using the capability map. |
| `http_server.hml` | Same minimal HTTP/1.1 server as `cp/`. |

## Endpoints

```
POST /services         { profile, model?, port?, gpus? }   → 201 {id, ...}
GET  /services                                             → [...]
POST /services/stop    { id }                              → 204
GET  /profiles                                             → [profile names]
GET  /capabilities                                         → { "llama-server": {...} }
GET  /healthz                                              → ok
```

CP is the only intended caller — agents don't need to be reachable from the public internet, just from CP.

## Profiles

Profiles in `PROFILES` (in `services.hml`) declare *intent*, not raw flags:

```hemlock
"chat-mahou": {
    binary: "llama-server",
    intent: {
        context: 131072,
        kv_cache_k: "q4_0",
        kv_cache_v: "q4_0",
        parallel_slots: 1,
        gpu_layers: 99,
        flash_attention: true,
    },
    extra_flags: [],
    default_port: 8080,
    context: 131072,
    kv_type: "q4_0",
    default_model: "/path/to/mahou.gguf",
}
```

At spawn time, `intent.hml` looks up each intent in the binary's `--help`-derived capability map and renders the right argv shape — short forms preferred (`-c`, `-ctk`, `-ngl`, `-fa on`) when available, longs as fallback. Verified output:

```
llama-server -c 131072 -ctk q4_0 -ctv q4_0 -np 1 -ngl 99 -fa on -m /.../mahou.gguf --port 18091 --host 0.0.0.0
```

The same profile produces the right argv on a llama.cpp build where `-fa` is still a bare boolean — `boolean_or_enum` kind in `INTENTS` handles both shapes.

`extra_flags` is the escape hatch for one-off raw flags that haven't been promoted to a named intent.

## Config (env vars)

```
WITCHGRID_CP_URL         http://192.168.8.154:8765    # required
WITCHGRID_AGENT_URL      http://192.168.8.217:8766    # required (what URL CP calls us at)
WITCHGRID_AGENT_HOST     0.0.0.0                       # bind address (default 0.0.0.0)
WITCHGRID_AGENT_PORT     8766                          # bind port (default 8766)
WITCHGRID_NODE_ID        $HOSTNAME                     # stable identifier
```

`WITCHGRID_AGENT_URL` isn't derivable — the agent might be behind NAT or have multiple interfaces. Always set it explicitly.

## Build & run

```bash
hemlockc agent.hml -o witchgrid-agent
WITCHGRID_CP_URL=http://<cp-host>:8765 \
WITCHGRID_AGENT_URL=http://<this-host>:8766 \
  ./witchgrid-agent
```

State persists in `witchgrid-agent.db` (sqlite). Re-registers every 30 s as heartbeat (CP's stale cutoff is 90 s).

## Behavior on restart

- Detached children survive the agent (they're in their own session via `setsid`); on agent restart, `reap_zombie_services` walks the `services` table and clears rows whose PIDs are gone.
- Live PIDs continue to show up in `/services` after restart, since the row is still there and the process is still alive.

## Hardware probe

GPU box: parses `nvidia-smi --query-gpu=name,memory.total,memory.free,uuid --format=csv,noheader,nounits`, returns one entry per GPU. CPU-only box: returns `{ role: "cpu", gpus: [] }` and registers anyway — CPU profiles can still spawn there.

If `nvidia-smi` isn't on the path, the agent treats it as CPU-only without erroring.
