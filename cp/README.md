# cp — Witchgrid control plane

The control plane daemon. Owns the node registry and (currently) the service supervisor. Written in [Hemlock](https://hemlang.dev) — compiles to a single ~1 MB ELF with universal dynamic deps (`libm`, `libffi`, `libcrypto`, `libc`). The deploy story is `scp + systemd unit + done`.

## What's in here

- `cp.hml` — entry point. Opens sqlite, starts the HTTP server, dispatches routes.
- `http_server.hml` — minimal HTTP/1.1 server on `@stdlib/net.TcpListener`. ~120 lines. Routes match exact `(method, path)`. No keep-alive, no chunked, no TLS.
- `services.hml` — llama-server supervisor. Profile templates with opinionated defaults (4-bit KV cache, 128 K context, single slot, GPU-pinned), direct `posix_spawn` (no shell wrapper) with raw fds for log/dev-null redirection via `fs.open_fd`, `setsid: true` for terminal detachment, transient `setenv`/`unsetenv` around the spawn for `CUDA_VISIBLE_DEVICES`, sqlite-tracked PIDs, `kill(pid, SIGTERM)` for stop.

When the agent component lands (next slice), `services.hml` will move to `../agent/` — for now it lives here so the CP can spawn services on the same box it runs on (single-node mode, matches the original v0.3 shape).

## Endpoints

```
POST /register         { node_id, hostname, role, hardware }     → 200
GET  /nodes                                                      → [...]
GET  /healthz                                                    → ok

POST /services         { profile, model, port?, gpus? }          → 201
GET  /services                                                   → [{ ..., alive }]
POST /services/stop    { id }                                    → 204
GET  /profiles                                                   → [profile names]
```

## Build & run

```bash
# Interpreted (fast iteration during development)
hemlock cp.hml

# Compiled (the deploy artifact)
hemlockc cp.hml -o witchgrid && ./witchgrid
```

Listens on `0.0.0.0:8765`. State persists in `witchgrid.db` (sqlite).

## End-to-end smoke

```bash
# Register a node
curl -X POST http://localhost:8765/register \
  -H 'content-type: application/json' \
  -d '{"node_id":"schneewolf","hostname":"schneewolf","role":"gpu","hardware":{"gpus":[{"name":"A6000","total_mem_mb":48669}]}}'

# Spawn llama-server with the chat profile defaults
#  (-c 131072 --cache-type-k q4_0 --cache-type-v q4_0 -np 1 -ngl 99 -fa on)
curl -X POST http://localhost:8765/services -H 'content-type: application/json' \
  -d '{"profile":"chat-mahou","model":"/path/to/mahou.gguf","port":18080,"gpus":[0]}'

# Send a completion through the spawned llama-server (after load)
curl -X POST http://localhost:18080/completion -H 'content-type: application/json' \
  -d '{"prompt":"<|im_start|>system\nYou are Witchgrid.<|im_end|>\n<|im_start|>op\nstatus?<|im_end|>\n<|im_start|>Witchgrid\n","n_predict":40,"stop":["<|im_end|>"]}'

# Stop it (SIGTERM, deletes row)
ID=$(curl -s http://localhost:8765/services | jq -r '.[0].id')
curl -X POST http://localhost:8765/services/stop -H 'content-type: application/json' -d "{\"id\":\"$ID\"}"
```

## Hemlock requirements

Built and tested against Hemlock 2.1.x (post c5ced27, #531, #533, #534, #535). The full evolution from spike → here is captured in `../docs/hemlock-feedback-archive.md`.
