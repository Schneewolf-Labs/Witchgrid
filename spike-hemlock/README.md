# Witchgrid Hemlock spike

A port of the smallest useful slice of Witchgrid v0.3 to [Hemlock](https://hemlang.dev) — node registry plus the "fancy llama-server wrapper" pillar. Goal: feel out whether the language is ergonomic enough to commit Witchgrid v1 to it.

**Verdict: yes.** Both the interpreter and the compiled 1 MB binary spawn a real `llama-server`, route a completion through it, and SIGTERM-stop it cleanly. Five language-level rough edges hit during the build — **all five now fixed upstream** (parity gaps via c5ced27, FFI lib collision via #531, posix_spawn primitive via #533). One minor follow-up still open: a raw-fd file open so process supervisors can drop the `sh -c` wrapper. See `HEMLOCK_FEEDBACK.md`.

## What's here

- `http_server.hml` — minimal HTTP/1.1 server on `@stdlib/net.TcpListener`. ~120 lines. Routes match exact `(method, path)`. No keep-alive, no chunked, no TLS.
- `services.hml` — llama-server supervisor. Profile templates with opinionated defaults (4-bit KV cache, 128K context, single slot, GPU-pinned), `posix_spawn`-detached children (via `sh -c "exec ... > log"` so the PID slot ends up holding llama-server, with `setsid: true` for terminal detachment), sqlite-tracked PIDs.
- `cp.hml` — control plane. Endpoints:
  - `POST /register` — upsert a node into sqlite
  - `GET  /nodes` — list registered nodes
  - `GET  /healthz` — liveness
  - `POST /services` `{profile, model, port?, gpus?}` — spawn llama-server with profile defaults, return `{id, pid, port, ...}`
  - `GET  /services` — list, with `alive` derived from `kill(pid, 0)`
  - `POST /services/stop` `{id}` — SIGTERM the child + delete row
  - `GET  /profiles` — list profile names
- `HEMLOCK_FEEDBACK.md` — friction notes for the Hemlock team.

## Run

```bash
# Interpreted (fast iteration)
hemlock cp.hml

# Compiled (single binary; this is the deploy story)
hemlockc cp.hml -o witchgrid && ./witchgrid
```

## End-to-end smoke test

```bash
# Register a node
curl -X POST http://localhost:8765/register \
  -H 'content-type: application/json' \
  -d '{"node_id":"schneewolf","hostname":"schneewolf","role":"gpu","hardware":{"gpus":[{"name":"A6000","total_mem_mb":48669}]}}'

# Spawn llama-server with the chat profile defaults
#  (-c 131072 --cache-type-k q4_0 --cache-type-v q4_0 -np 1 -ngl 99 -fa on)
curl -X POST http://localhost:8765/services -H 'content-type: application/json' \
  -d '{"profile":"chat-mahou","model":"/path/to/mahou.gguf","port":18080,"gpus":[0]}'

# Wait for load, then send a completion through the spawned llama-server
curl -X POST http://localhost:18080/completion -H 'content-type: application/json' \
  -d '{"prompt":"<|im_start|>system\nYou are Witchgrid.<|im_end|>\n<|im_start|>op\nstatus?<|im_end|>\n<|im_start|>Witchgrid\n","n_predict":40,"stop":["<|im_end|>"]}'

# Stop it (sends SIGTERM, deletes row)
ID=$(curl -s http://localhost:8765/services | jq -r '.[0].id')
curl -X POST http://localhost:8765/services/stop -H 'content-type: application/json' -d "{\"id\":\"$ID\"}"
```

## What this spike answered

- ✅ HTTP server on TcpListener — yes (~120 LOC for what we need)
- ✅ sqlite parameter binding + column-named row objects — clean
- ✅ json round-trip through request → db → response — faithful
- ✅ `hemlockc` produces a working binary — 1 MB, deps `libm/libffi/libcrypto/libc` (universal)
- ✅ `posix_spawn(argv, { setsid: true })` for detached children — clean, returns the PID directly, no shell racing
- ✅ profile templates with opinionated defaults — ergonomic shape, easy to extend

Forward path: port the rest of v0.3 (routing API, hardware introspection via `nvidia-smi --query-gpu` from `exec()` or libnvml FFI, capacity-aware placement, dashboard). All language-level blockers resolved upstream — only the optional `fs.open_fd` would let us drop the last `sh -c` wrapper from the spawn path.
