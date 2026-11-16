# Shared-base LoRA serving

Several llama-server profiles often run the **same base GGUF** with different
LoRA adapters. On schneewolf: `luna-spark` (B4-9B Q8 + Luna LoRA),
`familiar-spark` (B4-9B Q8, no LoRA) and `riko-narrator` (B4-9B Q8 + Riko
LoRA) each ran their own llama-server, ~11 GB apiece on 16 GB cards — three
copies of the same 9.5 GB of weights.

A profile that sets **`share_group`** is instead served by **one**
llama-server per *(group, base model, server settings, GPU set)* that has
every member's adapters loaded, and the adapter is selected **per request**.
Consumers don't change: every member keeps its own port.

It's opt-in. A profile without `share_group` (Riko's live narrator, anything
latency-critical) keeps its dedicated server, exactly as before.

## How it works

```
 consumer ──► :18091 (luna-spark)  ─┐   agent-side proxies: forward bytes,
 consumer ──► :18090 (familiar)    ─┤   write the member's "lora" selection
                                     ▼   into generation requests
                         127.0.0.1:18700  llama-server
                         -m B4-9B-Q8 --lora-scaled luna.gguf:0
                         -c 131072 -np 4 --cache-ram 0 --host 127.0.0.1
```

- **Server row** (`/services`: `profile: "shared:<group>"`, `shared.role:
  "server"`): an ordinary llama-server spawned by the agent, bound to
  **loopback** on an internal port (`WITCHGRID_SHARED_PORT_BASE`, default
  18700, walking up). Every adapter is loaded at **global scale 0**
  (`--lora-scaled <path>:0`), so anything that reaches it without a selection
  gets the plain base model, never somebody's adapter.
- **Member rows** (`shared.role: "member"`, `profile: <the profile>`, `port:
  <its own port>`): the port is served by a thin HTTP proxy **inside the
  agent** (`agent/lora_proxy.hml`). Its pid is the agent's.
- The CP's `/v1/llama/{profile}/…` route and `/resolve/{profile}` find the
  member row by profile name and go to the member port, so they select the
  profile's LoRA with no CP-side special case.

### What the proxy does

Byte-level HTTP/1.1 forwarding, one request per connection (`Connection:
close`):

| Request | Handling |
|---|---|
| `POST` `/completion`, `/completions`, `/v1/completions`, `/chat/completions`, `/v1/chat/completions`, `/responses`, `/v1/responses`, `/v1/messages`, `/infill`, `/embedding(s)`, `/v1/embeddings`, `/rerank(ing)`, `/v1/rerank(ing)` with a JSON-object body | the member's selection is appended: `"lora":[{"id":0,"scale":1.0},{"id":1,"scale":0.0},…]` |
| `GET /v1/models`, `/models`, `/props` | rewritten to the member's `-a` alias **if it has one** (otherwise passed through: the shared server reports the base model path, which is also what a dedicated server without `-a` reports) |
| `POST /lora-adapters`, `POST /slots/*` | **403** — server-global state the other members depend on |
| `GET /__witchgrid/lora-proxy` | answered by the proxy (liveness probe used by the watchdog) |
| everything else (`/health`, `/tokenize`, `/metrics`, `/slots`, `GET /lora-adapters`, …) | passed through unchanged |

- Every path, method, query string and header passes through (hop-by-hop
  headers are dropped; `Host`, `Content-Length` and `Connection` are
  rewritten). Request bodies: `Content-Length` or chunked (decoded);
  `Expect: 100-continue` is answered.
- **Responses are relayed as raw bytes as they arrive** — status line, headers,
  chunked framing, SSE (`stream: true`) — not buffered (the alias-rewritten
  GETs are the only buffered responses). A client that disconnects closes
  the upstream connection, which llama-server treats as a cancel.
- While the shared server is (re)loading the proxy answers **503 `{"error":
  {"code":503,"message":"Loading model",…}}`**, the same shape llama-server
  uses, so health pollers (CP auto-spawn, `/api/ready`, nginx health
  checks) see "loading", not "broken".
- **A client-sent `lora` is overridden** (policy): the selection is appended
  as the *last* key and llama-server's JSON parser keeps the last duplicate.
  Otherwise anyone who can reach one member's port (Luna's public chat via
  nginx) could run another member's adapter, or turn its own off. The
  client's other bytes are not re-serialized.
- **Not generation-bound:** `POST /tokenize`, `/detokenize`,
  `/apply-template`, the `…/input_tokens` counters — adapters don't change
  them.
- Not supported on member ports: the `/v1/realtime` websocket upgrade.

### llama-server facts this relies on

Verified on the llama.cpp build on sabre (`version: 0.8.0-dev (build 12003,
commit 36a0e2ffc)`), reading `tools/server` and measuring:

- Per-request `lora: [{id, scale}]`: listed ids get `scale`, **unlisted ids
  get 0**; an **empty list or no field falls back to the global scales**. So a
  no-LoRA member must send every id at 0, never `[]` — the proxy always
  sends the full list.
- **`--lora-init-without-apply` is not enough**: it skips applying the
  adapters at load, but the global scales stay 1.0 and every request
  *without* a `lora` field then runs with **all** adapters. Hence
  `--lora-scaled <path>:0`.
- Zero-scale adapters are dropped from the graph
  (`llama_context::set_adapters_lora`), so a member's output is
  **bit-identical** to a dedicated `--lora <its adapter>` server (measured
  below).
- **Adapters can't be added to a running server** — `POST /lora-adapters`
  only rescales the ones loaded at startup. A member that needs a new
  adapter means a restart.
- Requests with different adapter sets are **never batched together**
  (`can_batch_with` compares the adapter list); each decode step serves one
  adapter set, taken from the lowest-numbered busy slot.
- The **per-slot** prompt cache is adapter-aware: a slot whose last request
  used another adapter set clears its KV before reuse
  (`lora_should_clear_cache`).
- The **host-RAM prompt cache** (`--cache-ram`, default 8 GiB) is **not**:
  saved states are matched by tokens only. A slot can restore KV computed
  under *another member's adapter* and continue under its own — silently
  conditioned output. The shared server therefore runs with **`--cache-ram
  0`** (added only when the binary's `--help` has the flag).

## Measurements

B4-9B-noMTP-Q8_0 base, adapters `Riko-9B-distill-A-f16` and
`Familiar-9B-luna-F2-f16`, llama.cpp build 12003, RTX A6000, temperature 0.
Script: [`tests/gpu/run_shared_lora_gpu.sh`](../tests/gpu/run_shared_lora_gpu.sh).

**Output equivalence** (member port vs a dedicated server, 24 tokens, per-
token logprob of the chosen token):

| | tokens equal | max \|Δ logprob\| |
|---|---|---|
| member with LoRA A vs dedicated `--lora A` (`/completion`) | yes | **0.0** |
| member with LoRA B vs dedicated `--lora B` (`/completion`) | yes | **0.0** |
| no-LoRA member vs plain base | yes | **0.0** |
| same three via `/v1/chat/completions` | yes | **0.0** |
| LoRA A member via the CP `/v1/llama/…` route | yes | **0.0** |
| no-LoRA member, client sends `lora: [1, 1]` (override) | yes | **0.0** vs base |

(For scale: adapter A vs adapter B on the same prompt differ by up to 0.088
in logprob; Luna vs base on a chat prompt by 0.142.)

**Prompt-cache safety across adapters** — sequence A,P → B,Q → B,R → B,P on
one server (P a ~1600-token prompt; Q, R unrelated), compared with dedicated
B on P:

| server | `B,P` cache_n | `B,P` max \|Δ logprob\| vs dedicated B |
|---|---|---|
| Witchgrid shared server (`--cache-ram 0`) | 0 (cleared) | **0.0** |
| …then `B,P` again (same adapter) | 1596 (reused) | **0.0** |
| control: same adapters, default `--cache-ram` | **1596** (A's KV restored from RAM) | **0.12** — and it sticks to the slot for the next B request |

Greedy text happened to match in the contaminated case, which is why this
has to be checked on logprobs, not strings. Cost of the mitigation: no host-
RAM cache — a conversation evicted from its slot re-prefills instead of being
restored from RAM. Prefix reuse inside a slot (the common chat case) is kept.

**Concurrency** (256 streamed tokens each, second request 0.3 s after the
first):

| | request 1 | request 2 |
|---|---|---|
| one member alone | 4.1 s, TTFT 0.05 s | — |
| two requests, same member | 4.7 s | 4.7 s (batched) |
| two members, different adapters | 4.1 s | **TTFT 3.9 s**, 7.9 s |
| adapter member + no-LoRA member | 4.1 s | **TTFT 3.9 s**, 7.5 s |
| two dedicated servers, same GPU | 8.3 s, TTFT 0.06 s | 8.3 s, TTFT 0.07 s |

Total throughput is about the same; the distribution isn't. On a shared
server a request for member B **waits for member A's in-flight generation to
finish** before its first token, and there is no fairness — sustained traffic
on one member can hold another off. (The proxy itself adds nothing
measurable: 4.10 s vs 4.08 s direct.) This is why sharing is opt-in.

**VRAM** (per process, nvidia-smi, A6000 — a 4060 Ti adds a little less CUDA
context):

| | VRAM |
|---|---|
| dedicated base + LoRA, 8192 ctx × 2 slots | 8 964 MiB |
| shared, 3 members (2 adapters, 6 slots, 24 576 ctx) | 9 696 MiB |
| dedicated `luna-spark` shape (65 536 ctx, 2 slots, Luna LoRA) | 10 700 MiB |
| **shared luna-spark + familiar-spark** (131 072 ctx, 4 slots) | **12 840 MiB** (vs 21 400 for two dedicated) |
| …plus a 4-slot member at 32 768/slot (7 slots measured) | 16 220 MiB |

## Policy

### Profile fields

```jsonc
{
  "binary": "llama-server",
  "share_group": "spark-b4-9b",            // opt in; [a-z0-9._-]{1,63}
  "intent": { "context": 65536, "parallel_slots": 2, ... },   // both required
  "extra_flags": ["--jinja", "--lora", "/path/luna.gguf"],      // or:
  "lora": "/path/luna.gguf",               // path | [path] | [{ "path", "scale" }]
  "lora_mb": 64                            // optional VRAM hint for join placement
}
```

- Adapters come from `lora` and/or the `--lora` / `--lora-scaled` flags the
  profile already has — an existing dedicated profile needs **only
  `share_group`** added. Paths containing `,` or `:` are refused
  (llama-server can't parse them in these flags).
- `-a/--alias` in `extra_flags` becomes the member's alias (`/v1/models`).
- `-c`, `-np`, `-m` in `extra_flags` are refused: context and slots must be
  intent so the agent can size the shared server. `--cache-ram`, `--host`,
  `--port`, `--lora-init-without-apply` are dropped (the shared server owns
  them).
- The CP refuses to store a `share_group` profile that breaks these rules
  (400).

### Who shares with whom

Members share a server when they have the same `share_group`, resolve to the
same base GGUF on the node, run on the same GPU set, and have **identical
server settings**: every intent except `context`/`parallel_slots`, and every
extra flag except adapters/alias (e.g. both `--jinja`). Same group + same
model + different settings is refused with a **409** that shows both
settings — almost always a profile mistake, so it isn't papered over with a
second copy of the base. A different base model in the same group is simply
another shared server.

### Sizing

- **slots** = sum of the members' `parallel_slots`
- **per-slot context** = the **max** of the members' `context /
  parallel_slots` (rounded up) — nobody gets less than on their own server
- llama-server `-c` = per-slot context × slots (it's the total)

Luna + Familiar (65 536 × 2 each) → `-c 131072 -np 4`: exactly the per-slot
context both had. Slots are pooled, not reserved per member — any member can
use any idle slot.

### Lifecycle

- **First member** starts the shared server (normal placement for its own
  estimate).
- **Join**: if the running server already *covers* the new member (its
  adapters loaded, enough slots and per-slot context) the member just gets
  its port — **no restart**. Otherwise the server restarts with the new
  config: stop-then-start (a 16 GB card can't hold two copies), so the other
  members answer 503 "Loading model" for one reload (≈ model load time +
  1 s). If the bigger config fails to start, the previous config is restored
  and the join fails.
- **Leave**: stopping a member closes its port; the server keeps running for
  the others **without a restart** (the leaver's adapter and slots are
  reclaimed at the next restart — and a later rejoin is instant). Stopping
  the **last** member stops the server. Stopping the **server row** stops
  every member.
- **Watchdog**: the server is an ordinary llama-server row — a crash is
  respawned from its stored profile (same config, same port), a crash loop
  parks it in `failed` (members then answer 503). Each tick also re-checks
  every member's port.
- **Agent restart**: the shared server is a `setsid` child and outlives the
  agent (re-adopted by pid, no respawn). The member proxies are part of the
  agent, so **member ports are closed while the agent is down** — unlike a
  dedicated server, an agent restart is not zero-downtime for members. The
  new agent re-binds them first thing at boot, before the hardware probe and
  catalog scan (~10 ms after the process starts in the integration test). With
  `auto_restart` off they are still re-bound at boot; a crashed server is
  then not respawned.
- **Concurrency of changes**: joins, leaves and the watchdog tick are
  serialized on one lock; the heartbeat skips its tick instead of waiting
  if a join is mid-reload, so the node doesn't go stale on the CP.

### Placement (CP)

Before the normal "fit a whole new server" search, the CP looks for a
**running** shared server of the same group whose base model is this
profile's model on that node, and estimates what the join adds: nothing if
the server covers the member, otherwise the KV growth (catalog estimate) plus
`lora_mb` (default 512 MB) per adapter to load. If the server's GPUs have
that much free (+10%), the profile joins it; otherwise normal placement runs
(which may start a second shared server elsewhere). The catalog's KV estimate
counts every layer as attention, so it **overestimates hybrid models**
(B4-9B has full attention in 8 of 32 layers) — for those, spawn pinned
(`node_id` + `gpus`), which skips the estimate, or let the layout planner
place them: it sizes a shared server from its last **measured** memory
(per member set) or a `vram_mb` you give it — see
[operations.md](operations.md#declarative-layout) and
[`examples/layouts/schneewolf.json`](examples/layouts/schneewolf.json).

## Example: Luna + Familiar on one server

[`docs/examples/profiles/spark-shared.json`](examples/profiles/spark-shared.json)
has both profiles. Against the current ones, the only change is
`share_group` (plus making sure `context`/`parallel_slots` are in `intent`
and the two profiles' other intents/flags are identical):

```bash
CP=http://<cp>:8765
# 1. add share_group to both profiles (PUT takes the whole profile object)
curl -s $CP/api/profiles/luna-spark     | jq '. + {share_group:"spark-b4-9b"} | del(.__name,.__version)' \
  | curl -s -X PUT $CP/api/profiles/luna-spark     -H 'content-type: application/json' -d @-
curl -s $CP/api/profiles/familiar-spark | jq '. + {share_group:"spark-b4-9b"} | del(.__name,.__version)' \
  | curl -s -X PUT $CP/api/profiles/familiar-spark -H 'content-type: application/json' -d @-
# 2. stop the two dedicated services (frees the ports + VRAM)
curl -s $CP/services | jq -r '.[] | select(.profile=="luna-spark" or .profile=="familiar-spark") | "\(.id) \(.node_id)"' \
  | while read id node; do curl -s -X POST $CP/services/stop -H 'content-type: application/json' \
      -d "{\"id\":\"$id\",\"node_id\":\"$node\"}"; done
# 3. start them again, pinned to the card that should hold the shared copy
curl -s -X POST $CP/services -H 'content-type: application/json' \
  -d '{"profile":"luna-spark","node_id":"schneewolf","gpus":[N],"port":18091}'
curl -s -X POST $CP/services -H 'content-type: application/json' \
  -d '{"profile":"familiar-spark","node_id":"schneewolf","gpus":[N],"port":18090}'
```

The second spawn restarts the shared server once (2 → 4 slots); Luna's port
answers 503 "Loading model" for that reload. Starting `familiar-spark` first
and Luna second costs the same single reload.

**riko-narrator** could join the same group technically (same base, same
`--jinja`), but shouldn't today: with the per-slot-max rule its 4 slots get
32 768 context each → 8 slots × 32 768 = 262 144 total, measured ≈ 16.2 GB at
7 slots and ≈ 17 GB at 8 — over a 16 GB card. It would fit with its slot
count or the group's per-slot context reduced, but it would also put the
live narrator behind Luna's and Familiar's generations (TTFT above). Keep it
dedicated (no `share_group`).

## Hemlock runtime issues found (worked around here)

- `socket.connect()` resolves through `gethostbyname()` (static storage):
  concurrent connects from different threads can crash the process
  (SIGSEGV in `hml_socket_connect`; reproducible with 16 threads × 3000
  loopback connects). The proxy serializes its connects.
- `posix_spawn` doesn't reset the signal mask, and Hemlock blocks signals in
  spawned tasks: a service spawned from an HTTP handler or the heartbeat
  thread started with SIGTERM **blocked** and only died on the SIGKILL
  escalation. **Fixed in the agent**: every spawn clears the calling
  thread's mask first (`agent/sigmask.hml`, `pthread_sigmask(SIG_SETMASK,
  ∅)` via FFI) and restores it after, so children start with nothing
  blocked. Services started before that keep their blocked mask until
  restarted; stop detects it (`SigBlk`/`SigIgn`) and SIGKILLs after 1 s.
  (Upstream ask: a `sigmask`/`sigdefault` option on `posix_spawn`, i.e.
  `POSIX_SPAWN_SETSIGMASK`.)
- `stringify()` reports any object reached twice as a circular reference,
  even a map merely shared by two entries; the CP/agent tree-copy
  (`json_tree`) values assembled from shared parts before serializing.
- `hemlockc` emits `#undef <name>` for imported names, which can clobber C
  macros (`SIGTERM`, `AF_INET`, …) used by modules initialized later —
  imports of those names are aliased in `agent/services.hml`.
- Writing to a socket whose peer closed raises SIGPIPE, whose default action
  kills the process; the agent now ignores SIGPIPE.
