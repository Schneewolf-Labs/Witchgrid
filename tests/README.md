# tests — Witchgrid test suite

Hemlock-side unit tests for the pure-function layers. Built on `@stdlib/testing` (`describe / test / assert_eq / assert_throws / run`).

## Run

From the repo root:

```bash
hemlock tests/run.hml
```

Exits non-zero if any test fails — the same `tests/run.hml` is what CI invokes.

## Layout

```
tests/
├── run.hml                # entry point: imports + run()
├── intent_test.hml        # agent/intent.hml — intent → argv translation
├── capabilities_test.hml  # agent/capabilities.hml — --help parser
├── gguf_test.hml          # cp/gguf.hml — GGUF parser + VRAM estimator
├── local_services_test.hml # agent/local_services.hml — `local` engine declarations
└── fixtures/
    ├── llama_help_enum_fa.txt    # modern build: -fa [on|off|auto]
    ├── llama_help_legacy_fa.txt  # older build: -fa as bare boolean
    ├── make_gguf_fixtures.py     # generator for the synthetic GGUFs below
    ├── nemo_llama.gguf           # llama, context_length=1024000 (the lie)
    ├── normal_llama.gguf         # llama, honest 131072 context
    ├── gguf_v2.gguf              # valid magic, unsupported version
    └── bad_magic.bin             # not a GGUF
```

## What's covered (and what's not)

In:
- `intent.render_argv` — short vs long form, value vs boolean_or_enum kinds, legacy boolean translation, extra_flags, error paths
- `intent.explain` — output shape + per-line error annotation
- `capabilities.parse_help` — short/long extraction, value-shape detection, multi-alias, section divider + continuation skipping
- `gguf.read_metadata` / `claimed_context` / `safe_context` / `kv_per_token_bytes` / `max_context_tokens` / `estimate_vram_mb` / `estimate_vram_from_ingredients` — parsed against synthetic header-only fixtures: arch metadata, the Mistral-Nemo 1024000→131072 override, context capping, kv/VRAM math, bad-magic + unsupported-version errors

Out of the *unit* suite (covered by the integration harness instead, see below):
- `services.spawn_service`, HTTP routing, placement, auto-spawn, health-gating, SSE
Still uncovered:
- `hardware.probe` — calls `nvidia-smi` (mocked-probe test still worth adding, todo #10)
- `capabilities.introspect` — calls a real `llama-server --help`; covered transitively

## Integration tests

`tests/integration/run_integration.sh` boots a **real CP + agent** and drives
the control-plane end to end, with `fake_llama_server.py` standing in for the
inference backend (answers `--help` so the capability probe works, binds
`--port`, serves `/health` + `/completion` + SSE) — so no GPU or model is
needed. It isolates `HOME` to a temp dir so the agent can't pick up a real
`llama-server` install on the host.

Covers: agent registration round-trip, the `auto_restart` watchdog field,
`POST /services` spawn, `/resolve`, health-gating, the `/v1/llama` proxy
(non-stream), and **SSE passthrough**.

The **`local` engine** block declares `tiny-voice` (`fake_local_run.sh`, a
venv-style wrapper that starts `fake_local_service.py` without `exec`) in a
temp `WITCHGRID_LOCAL_SERVICES` dir and drives: capabilities + `/nodes`
advertisement (no argv/env values), local profile create (and refusal of
`extra_flags`), placement preview, spawn → declared health path, the child's
cwd/env/PORT/CUDA pin and non-inheritance of the agent's env, `/resolve` +
`/api/ready`, watchdog respawn after the group is killed, re-adoption across an
agent SIGKILL + restart, stop taking down the whole process group, proxy
auto-spawn waiting on the declared health path, refusal of an
undeclared name (CP 503, agent 403), and that argv-shaped fields in a raw spawn
payload are ignored.

```bash
# after building cp/witchgrid-cp + agent/witchgrid-agent:
bash tests/integration/run_integration.sh    # exits non-zero on any failure
```

CI runs it on the Linux leg after the unit tests + CP smoke test.

### Shared-base LoRA serving

`tests/lora_share_test.hml` (unit) covers the pure rules in
`agent/lora_share.hml`: adapter parsing from `lora` / `--lora` /
`--lora-scaled`, the compatibility signature + share key, sizing (summed
slots, max per-slot context), covers/restart decisions, the per-request
selection (every id explicit, never `[]`), body injection (last-key
override, bytes kept), endpoint policy and alias rewrite.

`tests/integration/run_shared_lora.sh` (CI, fake backend — the fake
implements llama-server's `lora` semantics and echoes what it got): join with
and without restart, per-member selection through member ports and the CP
`/v1/llama` route, client-`lora` override, SSE unbuffered, chunked and
`Expect: 100-continue` bodies, byte-identical passthrough, alias rewrite,
refused endpoints, incompatible settings (409), a 40-request concurrent
burst, member leave (no restart) and rejoin, watchdog respawn, agent restart
(server adopted, ports re-bound), last-member stop, server-row stop,
auto-spawn through `/v1/llama`.

`tests/gpu/run_shared_lora_gpu.sh` (**opt-in**, needs a GPU, a base GGUF and
two matching LoRA GGUFs; not in CI): output equivalence vs dedicated servers
on tokens and logprobs, prompt-cache safety across adapters (plus a control
without `--cache-ram 0`), concurrency latency, VRAM. Results are in
[`../docs/shared-lora.md`](../docs/shared-lora.md#measurements).

```bash
CP_PORT=8865 AGENT_PORT=8866 bash tests/integration/run_shared_lora.sh
BASE_GGUF=… LORA_A=… LORA_B=… LLAMA_SERVER=… CP_PORT=8865 AGENT_PORT=8866 \
  bash tests/gpu/run_shared_lora_gpu.sh
```

### Declarative layout + measured VRAM

`tests/layout_test.hml` (unit) drives the pure planner (`cp/layout.hml`) and
replays every plan with an independent simulator: the schneewolf 2026-11-15
re-layout (4 × 16 380 MB; niku/Luna-split/voice/Mahou-split/Familiar → one
main service per card, Mahou patched) must never overflow a card and must
reach the goal; plus no-op, infeasible (GPU + overflow), keep_unlisted,
restart-in-place, cross-node make-before-break, port swap, shared-server
join restart, merge patch and request validation.

`tests/integration/run_layout.sh` (CI, fake backend + `fake_nvidia_smi.py`,
which "holds" `--fake-vram N` MB per fake server split over its
`CUDA_VISIBLE_DEVICES`): the spawned signal mask, measured `vram_mb` in
`/services`/`/vram`/`/nodes`, `GET /api/layout` round-trip no-op, plan
assertions, infeasible 409, MCP tools, apply of the same re-layout (measured
usage within capacity − margin after every step, old pids gone, pins
written), idempotent re-apply, pinned auto-spawn + `placed_by: pin`,
rollback of a failing step, a share_group layout (one server, both ports),
unpinning on keep_unlisted: false, stale `/services` while the agent is
down, and the verified stop of an adopted SIGTERM-ignoring service.

```bash
CP_PORT=8865 AGENT_PORT=8866 bash tests/integration/run_layout.sh
```

## Adding tests

New tests should sit alongside the file they cover:

```hemlock
import { describe, test, assert_eq } from "@stdlib/testing";
import { thing_under_test } from "../agent/my_module";

describe("my_module.thing_under_test", fn() {
    test("does the thing", fn() {
        assert_eq(thing_under_test(input), expected);
    });
});
```

Then add `import "./my_module_test";` to `run.hml` so it gets picked up.

For fixtures, drop the file into `tests/fixtures/` and read with `read_file("tests/fixtures/<name>")` (paths are relative to the CWD that `hemlock tests/run.hml` was invoked from — i.e. the repo root).
