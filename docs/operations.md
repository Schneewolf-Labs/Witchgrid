# Operating Witchgrid

How to build, deploy, run, observe, and recover a Witchgrid fleet in production.
The control plane (`witchgrid-cp`) runs on one box; an agent (`witchgrid-agent`)
runs on every box that hosts inference. Both are single ELF/Mach-O binaries with
universal dynamic deps — deploy is a copy + a service unit.

- [Build](#build)
- [Install layout](#install-layout)
- [Run as a service](#run-as-a-service)
- [Configuration reference](#configuration-reference)
- [Auto-restart watchdog](#auto-restart-watchdog)
- [Persistent inference instances](#persistent-inference-instances)
- [Declarative layout](#declarative-layout) — measured VRAM, pins, plan/apply
- [Observability](#observability)
- [Backup & restore](#backup--restore)
- [Reboot recovery](#reboot-recovery)
- [Upgrades](#upgrades)
- [Auth](#auth)
- [Troubleshooting](#troubleshooting)

---

## Build

Needs the [Hemlock](https://hemlang.dev) toolchain (`hemlockc`; CI and releases are built on the version pinned in `.github/workflows/build.yml`, currently 2.16.0). Or skip
building and grab the prebuilt binaries from a [release](https://github.com/Schneewolf-Labs/Witchgrid/releases)
(`linux-x86_64`, `macos-arm64`).

```bash
# If you changed any dashboard asset, re-embed first:
scripts/embed_assets.sh                       # → cp/embedded_assets.hml

cd cp    && hemlockc cp.hml      -o witchgrid-cp      && cd ..
cd agent && hemlockc agent.hml   -o witchgrid-agent   && cd ..
cd cp    && hemlockc inspect.hml -o witchgrid-inspect && cd ..   # optional GGUF CLI
```

> ⚠️ The binaries statically link the Hemlock **runtime**, so a build is only as
> current as the `hemlockc` that produced it. Build with the toolchain version
> you intend to ship (CI pins it via `HEMLOCK_VERSION` in `build.yml`).

## Install layout

A simple, battle-tested layout per box (any user; examples use `$HOME`):

```
$HOME/witchgrid-cp            # the CP binary           (cp host only)
$HOME/witchgrid/             # CP working dir + sqlite  (cp host only)
$HOME/witchgrid-agent         # the agent binary        (every node)
$HOME/.witchgrid/            # data dir: DB, models, env files, engine installs
    cp.env                    # CP env (sourced by the launcher)
    agent.env                 # agent env
    models/                   # canonical model dir (pulls land here)
```

Copy a **new** binary into place with `mv`, not `cp` — a running binary can't be
overwritten (`ETXTBSY`); `mv` swaps the directory entry and the running process
keeps its old inode until you restart it.

## Runtime dependencies

As of Hemlock 2.6.0 the binaries **static-link** libwebsockets, libssl,
libcrypto, libffi and libz — those are baked in and don't need to be on the
box. What's left:

- **`libsqlite3.so.0` — required, and invisible to `ldd`.** `@stdlib/sqlite`
  `dlopen()`s it at startup (compile-time FFI), so it does *not* show up in
  `ldd` and is *not* bundled. Every box that runs the CP or agent needs it:
  ```
  sudo apt-get install -y libsqlite3-0      # Debian/Ubuntu
  ```
  macOS ships libsqlite3 in the system, so nothing to install there. If it's
  missing the process dies at startup with an FFI load error, not a link error.
- **`libcap.so.2`, `libuv.so.1`, `libev.so.4`** (plus libc/libm) — standard,
  present on any normal Linux; listed by `ldd <binary>`.

Quick check on a fresh box: `ldd ./witchgrid-cp` (covers everything except the
sqlite dlopen) and `ldconfig -p | grep libsqlite3`.

## Run as a service

Both binaries are plain long-running processes; supervise them with whatever you
already use. The pattern that's proven out: a tiny launcher that sources an env
file and `exec`s the binary, wrapped by a service manager set to restart on
failure.

**Launcher** (`$HOME/witchgrid-cp.sh`; mirror for the agent):

```bash
#!/bin/bash
set -a
[ -f "$HOME/.witchgrid/cp.env" ] && source "$HOME/.witchgrid/cp.env"
set +a
cd "$HOME/witchgrid"          # CP: relative DB + backups land here (or set WITCHGRID_DATA_DIR)
exec "$HOME/witchgrid-cp"
```

### systemd (recommended for the CP)

A ready template lives at [`scripts/witchgrid-cp.service`](../scripts/witchgrid-cp.service):

```ini
[Service]
Type=simple
User=nbeerbower
ExecStart=/home/nbeerbower/witchgrid-cp.sh
WorkingDirectory=/home/nbeerbower/witchgrid
Restart=on-failure
RestartSec=5                 # lets sqlite release the WAL lock cleanly
LimitNOFILE=65536            # libwebsockets + sqlite fds
[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now witchgrid-cp
journalctl -u witchgrid-cp -f
```

On stop (`systemctl stop` → SIGTERM) the CP checkpoints the WAL (`TRUNCATE`)
and exits cleanly, so the next start is from a compact, fully-merged DB —
provided it was built against a Hemlock with the signal fix
([hemlang/hemlock#587](https://github.com/hemlang/hemlock/pull/587)). On an
older toolchain it falls back to default termination; SQLite WAL is
crash-durable, so the DB still recovers + checkpoints on the next open.

### Zero-downtime agent restarts (don't tree-kill the inference)

The agent `posix_spawn`s its inference servers with `setsid:true` — they're
their own session leaders, so they **survive the agent going away** and the
restarted agent re-adopts the still-`running` rows (no respawn). The agent
itself installs **no** shutdown handler, so it never stops its children.

That means an agent restart can be **zero-downtime** — *if* the service
manager doesn't kill the agent's whole process tree/cgroup along with it.
Configure it not to:

- **pm2** → `--no-treekill` (only the agent gets the signal, not its children).
- **systemd** → `KillMode=process` in `[Service]` (kill the main process only,
  not the whole cgroup).
- **launchd** → `AbandonProcessGroup=true` so children aren't reaped with the job.

Without these, every agent roll bounces inference for a few seconds (the
children die, the watchdog respawns them). With them, you can upgrade the
agent under live traffic.

**Exception — shared-LoRA members** (`share_group` profiles, see
[`shared-lora.md`](shared-lora.md)): their ports are proxies *inside* the
agent, so they are closed while the agent is down even with the settings
above (the shared llama-server behind them survives and is re-adopted). The
restarted agent re-binds them first thing at boot; the gap is the time the
agent process is gone.

### pm2 (no-sudo agent supervision)

When you can't (or don't want to) write a system unit, pm2 with its boot hook
works for the agent:

```bash
pm2 start "$HOME/witchgrid-agent.sh" --name witchgrid-agent --interpreter bash --no-treekill
pm2 save                      # persist; pm2's startup unit resurrects on reboot
```

`--no-treekill` is the zero-downtime bit (see above). To add it to an
already-running agent: `pm2 delete witchgrid-agent` then re-`start` with the
flag (the delete bounces the services one last time), then `pm2 save`.

### systemd (--user) agents

```ini
[Service]
KillMode=process              # zero-downtime: don't cgroup-kill the inference
ExecStart=%h/witchgrid-agent.sh
Restart=on-failure
```

### launchd (macOS agents)

A user LaunchAgent (`~/Library/LaunchAgents/ai.flammen.witchgrid-agent.plist`)
with `KeepAlive` + `RunAtLoad` survives reboots; restart with
`launchctl kickstart -k gui/$(id -u)/ai.flammen.witchgrid-agent`. Add
`<key>AbandonProcessGroup</key><true/>` for zero-downtime restarts.

## Configuration reference

All config is env vars. Both binaries read `WITCHGRID_DATA_DIR` and
`WITCHGRID_SHARED_SECRET`.

### Control plane

| Var | Default | Meaning |
|-----|---------|---------|
| `WITCHGRID_DATA_DIR` | *(CWD)* | Dir for `witchgrid.db` (+ `-wal`/`-shm`). Absolute, created if missing. **Set this** so the DB doesn't follow CWD — a stray fresh DB drops every node/profile/service from view. The CP logs `creating NEW database at …` when it makes a fresh one. |
| `WITCHGRID_SHARED_SECRET` | *(unset)* | Bearer secret required on inbound calls + sent on outbound. Unset = no auth (LAN-trusted). Must match on CP **and every agent**. See [`security.md`](security.md) for the full model (public vs protected routes, reverse-proxy guidance). |
| `WITCHGRID_AUTH_PROTECT_READ` | *(unset)* | With the secret set, also require the bearer on the read-only surface (`/nodes`, `/ui/*`, `/api/state`, `/events`, `/metrics`, `/resolve/*`, service logs, …). The browser dashboard's live views will 401 (no login UI yet) — front it with a bearer-injecting reverse proxy. No effect without `WITCHGRID_SHARED_SECRET`. |
| `WITCHGRID_AUTH_PROTECT_INFERENCE` | *(unset)* | With the secret set, require the bearer on the `/v1/llama/*` inference plane (otherwise it stays open to any LAN client). No effect without `WITCHGRID_SHARED_SECRET`. |
| `WITCHGRID_STALE_NODE_SECONDS` | `90` | A node whose last heartbeat is older than this drops out of placement (and shows `node_up=0` in `/metrics`). Keep it ≳ 3× the agent's `WITCHGRID_HEARTBEAT_SECONDS` so one missed beat doesn't flap a node out. |
| `WITCHGRID_CP_HOST` | `0.0.0.0` | Bind address. Set `127.0.0.1` and front it with an authenticating reverse proxy for anything beyond a trusted LAN. |
| `WITCHGRID_CP_PORT` | `8765` | Bind port. |
| `WITCHGRID_MEASURE_MIN_UPTIME_S` | `45` | A service's measured VRAM is recorded as its profile's "last measured" size (used to size the next start of that profile — see [Declarative layout](#declarative-layout)) only once it has been up this long. |

> The CP version is surfaced in `/healthz` (`{"status":"ok","version":…}`),
> `/metrics` (`witchgrid_build_info{version=…}`), and the dashboard header —
> single source of truth in `version.hml`, bumped at release.
> Backup cadence/dir/retention are runtime settings (`PUT /api/settings`:
> `db_backup_interval_min`, `db_backup_dir`, `db_backup_keep`).

### Agent

| Var | Default | Meaning |
|-----|---------|---------|
| `WITCHGRID_CP_URL` | **required** | Control-plane URL, e.g. `http://10.0.0.10:8765`. |
| `WITCHGRID_AGENT_URL` | **required** | URL the CP reaches *this* agent at (NAT/multi-NIC means it's not derivable). |
| `WITCHGRID_AGENT_HOST` | `0.0.0.0` | Bind address. |
| `WITCHGRID_AGENT_PORT` | `8766` | Bind port. |
| `WITCHGRID_NODE_ID` | `$HOSTNAME` | Stable node identifier. |
| `WITCHGRID_MODEL_DIR` | `~/.witchgrid/models` | Canonical model dir; pulls land here; reported as `canonical` disk. Created if missing. |
| `WITCHGRID_MODEL_DIRS_EXTRA` | *(empty)* | Colon-separated extra dirs to scan read-only into the catalog. |
| `WITCHGRID_DATA_DIR` | *(CWD)* | Dir for `witchgrid-agent.db`. Same rationale as the CP. |
| `WITCHGRID_HEARTBEAT_SECONDS` | `30` | How often the agent re-probes hardware and heartbeats the CP (advancing its `last_seen_at`). Lower = fresher `free_mb` for placement at the cost of more RPC + `nvidia-smi` calls. Keep the CP's `WITCHGRID_STALE_NODE_SECONDS` ≳ 3× this. |
| `WITCHGRID_SHARED_SECRET` | *(unset)* | See above; must match the CP. |
| `WITCHGRID_SHARED_PORT_BASE` | `18700` | First internal (loopback) port for shared-LoRA llama-servers; walks up past ports in use. Members keep their own ports. See [`shared-lora.md`](shared-lora.md). |
| `WITCHGRID_LOCAL_SERVICES` | `~/.witchgrid/local-services` | Dir of `local` engine declarations (one `<name>.json` per service: argv, cwd, env, port, health path, VRAM). Missing = no local services. Must not be group/world-writable. See [`agent/README.md`](../agent/README.md#local-services-local-engine). |

## Device selection (CPU/GPU)

Whether a service runs on GPU or CPU is a first-class choice, resolved at
spawn time in this order:

1. **Per-spawn** — `device` in `POST /services` (and the deploy page's device
   dropdown): `auto` | `cpu` | `gpu`.
2. **Per-profile** — a profile's `default_device` (set in the profile editor),
   used when the spawn request doesn't specify one.
3. **`auto`** — honor the profile's `intent.gpu_layers` (0 ⇒ CPU, >0 ⇒ GPU).
   This is the historical behavior.

`cpu` forces `gpu_layers=0` (no offload; placement skips the VRAM-fit search,
`CUDA_VISIBLE_DEVICES=""`). `gpu` forces offload (the profile's layer count, or
99 if it was a CPU profile) and a normal VRAM-fit placement. The chosen device
comes back on the spawn response (`"device"`) and shows as a badge per service
in the dashboard's Services table and `/ui/services`.

Tip: keep latency-insensitive, low-traffic services (summarizers, embeddings,
designer) on CPU so they don't compete with chat for VRAM — ship them as CPU
profiles (`gpu_layers: 0`) or set their `default_device` to `cpu`, and promote
to GPU per-spawn only when you need the throughput.

## Auto-restart watchdog

Each agent keeps its managed services as **desired state**. With `auto_restart`
on (the default), a per-heartbeat + boot reconcile respawns any service whose
process has died — covering both crashes and host reboots — from the
profile/model/GPU pinning persisted at spawn. A crash-loop guard parks a service
in `failed` after 5 rapid restarts (≤120 s apart) instead of looping forever.

```bash
# per-agent toggle (agent is source of truth):
curl http://<agent>:8766/settings                                  # {"auto_restart":true}
curl -X PUT http://<cp>:8765/api/nodes/<node_id>/auto-restart \
     -H 'content-type: application/json' -d '{"auto_restart":false}'
```

`/nodes` reports each node's `auto_restart`; the dashboard shows a ⟳ badge +
toggle. `witchgrid_node_auto_restart` is exported in `/metrics`.

## Persistent inference instances

Consumers that use **resolve-then-connect** (`GET /resolve/{profile}` → `base_url`,
then talk to the engine directly) rely on the target instance already running —
`/resolve` is a pure locator, it never spawns. So the inference instances are
long-lived. The watchdog keeps them up across crashes/reboots; the
`/v1/llama/{profile}/*` proxy path additionally auto-spawns on first request.

To pre-spawn / pin one (e.g. an SDXL `sd-server` whose GGUF lacks the LLM arch
metadata placement needs, so it can't use capacity-aware placement):

```bash
curl -X POST http://<cp>:8765/services -H 'content-type: application/json' \
  -d '{"profile":"image-niku","node_id":"<node>","gpus":[0],"port":19080,"model":"/abs/model.gguf"}'
```

## Declarative layout

Laying out a GPU box by hand ("Mahou has to leave GPU 1 before Luna gets a
card, Niku has to leave GPU 0 first…") is a sequence of stops and pinned
spawns where one wrong order overflows a card. Witchgrid does that sequencing:
you describe **where everything should run**, it works out a safe order and
executes it. Built for an operator that is an AI assistant driving the CP over
HTTP or MCP, but just as usable with curl.

### Measured memory

Every agent attributes nvidia-smi's compute apps to its services — the
service's pid, its process group (all services are `setsid`, pgid = pid) and
all descendants — on every heartbeat and on demand:

| Where | What |
|---|---|
| `GET /services` (CP or agent) | per service: `vram_mb` (`{"<gpu>": MB}`), `vram_total_mb`, `vram_measured_at`, `uptime_s`, `profile_fp` |
| `GET /nodes` (CP) | per GPU: `used_mb`, `services: [{profile, port, mb}]`, `services_mb`, `other_mb` (not ours: other users' processes + driver/context) |
| `GET /vram` (agent) | the same, measured now (the layout executor calls it after every step) |

The CP also keeps the **last measured** MB of each profile (and of each shared
server's member set) in `profile_vram`, valid for the profile's
*fingerprint* — a hash of the process-shaping fields (binary, intent,
extra_flags, model, adapters, share_group, …; not pin/port/description). A
service has to be up `WITCHGRID_MEASURE_MIN_UPTIME_S` (default 45 s) before
it counts; the largest value per fingerprint + GPU set is kept (an sd-server
allocates more on its first image).

### Pins

`profile.pin = {node_id, gpus, port?}` says where a profile runs. It is
honoured by `POST /services` without `node_id`/`gpus` (response
`placed_by: "pin"`; `ignore_pin: true` opts out), by `/v1/llama` auto-spawn,
by the agent watchdog's respawn, and by shared-group joins (a pinned spawn
joins the server on exactly that GPU set). A pin to a node that isn't live is
a 503, not "somewhere else". Layout apply writes pins by default.

### The document

`GET /api/layout` returns the fleet:

```jsonc
{
  "keep_unlisted": true, "pin": false, "margin_mb": 512,
  "desired": [   // running services — exactly what plan/apply accept
    { "profile": "luna-spark", "node_id": "schneewolf", "gpus": [0,1,2,3], "port": 18091,
      "measured_mb": {"0": 3950, "1": 2260, "2": 2500, "3": 3300}, "service_id": "…" },
    { "profile": "familiar-spark", "node_id": "schneewolf", "gpus": [3], "port": 18090,
      "measured_mb": {"3": 10870}, "service_id": "…" }
    // a share_group member carries "shared_group" and an empty measured_mb;
    // its server's memory is under nodes[].gpus[].services as "shared:<group>"
  ],
  "nodes": [{ "node_id": "schneewolf", "reachable": true, "measured": true, "gpus": [
    { "index": 0, "total_mb": 16380, "used_mb": 9750, "free_mb": 6630, "other_mb": 450,
      "services": [{ "profile": "image-niku", "port": 19080, "mb": 4450, "state": "running" }, …] } ] }]
}
```

(`pin` is `true` only when every listed profile is already pinned where it
runs, so posting the document back unchanged is always a no-op.) Edit
`desired` and post it:

```jsonc
POST /api/layout/plan        // dry run, changes nothing
POST /api/layout/apply       // same body + "confirm": true
{
  "desired": [ { "profile", "node_id", "gpus", "port"?, "vram_mb"? }, … ],
  "profile_patches": { "chat-mahou": { "intent": { "context": 65536 }, "context": 65536 } },
  "keep_unlisted": true,     // false: stop running services that aren't listed (and drop their pins)
  "pin": true,               // record each placement as profile.pin
  "margin_mb": 512,          // free MB kept on every GPU after every step
  "confirm": true,           // apply only
  "wait_s": 900,             // apply only: return 202 + run_id if it takes longer
  "health_timeout_s": 300    // apply only: per started service
}
```

- One entry per profile. `port` defaults to the profile's current port on
  that node, then its pin, then `default_port` — ports are kept unless you
  change them.
- `profile_patches` are [JSON merge patches](https://www.rfc-editor.org/rfc/rfc7386)
  (objects merge, `null` deletes, arrays replace) applied first; a patch that
  changes the fingerprint restarts the service.
- `share_group` profiles with the same group, node and GPU set are **one
  unit** (one server); `vram_mb` on any member sizes the whole server.
- `vram_mb` overrides the size of something the CP hasn't measured yet.
  Without it a start is sized from: `profile.vram_mb`, the last measurement
  (re-spread over a different GPU set; scaled by the GGUF-estimate ratio
  across profile versions), a local service's declared `vram_mb`, then the
  GGUF estimate (which **overestimates hybrid models** like B4-9B — pass
  `vram_mb` for those). `estimates[].source` says which one was used.

### The plan

```jsonc
{ "ok": true, "noop": false,
  "steps": [
    { "n": 1, "op": "patch_profile", "profile": "chat-mahou",
      "patch": { "intent": { "context": 65536 }, "pin": { … } }, "restart": true, "projected_mb": { … } },
    { "n": 2, "op": "stop", "profile": "chat-mahou", "node_id": "schneewolf", "gpus": [1,2],
      "port": 18080, "service_id": "…", "reason": "moving: profile change, placement …",
      "then_start": true, "est_s": 3, "projected_mb": { "schneewolf:0": 9300, "schneewolf:1": 2260, … } },
    { "n": 3, "op": "start", "profile": "chat-mahou", "node_id": "schneewolf", "gpus": [2],
      "port": 18080, "est_mb": { "2": 9600 }, "est_source": "…", "est_s": 20, "projected_mb": { … } },
    { "n": 6, "op": "stop", "profile": "luna-spark", "parked": true, "reason": "parked: nothing fits until it moves; …" },
    …
  ],
  "unchanged": ["riko-voice", "familiar-spark"],
  "downtime": [ { "profile": "chat-mahou", "expected_s": 23, "kind": "move", "steps": [2, 3] }, … ],
  "initial_mb": { … }, "final_mb": { … }, "peak_mb": { … }, "usable_mb": { … },
  "estimates": [ { "profiles": ["luna-spark"], "gpus": [0], "mb": { "0": 12010 }, "source": "measured on GPUs [0,1,2,3], respread" } ],
  "warnings": [], "layout": { "desired": [ … normalized … ] } }
```

Ordering rules: profile patches first (they only affect the next spawn), then
stops of services not in the layout; then, repeatedly, the change that fits
now and unblocks the most others ("move the blockers first"). A move to
another node (or port) starts the new copy before stopping the old one when
both fit (no downtime); on the same node + port the old copy stops right
before the new one starts. When nothing fits, one service is **parked**
(stopped early, restarted at its new place once room exists) — the cheapest
unblock. Joining a running shared server is marked `restarts_shared` (with
`reload_members`) when the server has to reload for the new member.

`projected_mb` after every step stays ≤ capacity − `margin_mb` on every GPU
(a GPU already above that may not go up). If the end state doesn't fit, the
plan is a 409:

```json
{ "ok": false, "error": "infeasible: the layout overflows schneewolf GPU 3 by 9104 MB (24972 of 15868 usable)",
  "overflows": [ { "node_id": "schneewolf", "gpu": 3, "projected_mb": 24972, "usable_mb": 15868,
    "over_by_mb": 9104, "other_mb": 100,
    "holders": [ { "profiles": ["familiar-spark"], "mb": 10870, "source": "measured" },
                 { "profiles": ["riko-narrator"], "mb": 11000, "source": "request vram_mb" } ] } ] }
```

### Apply

`POST /api/layout/apply` (with `confirm: true`) runs in the background and
answers when done (or `202 {run_id}` after `wait_s`; poll
`GET /api/layout/runs/{run_id}`, list with `GET /api/layout/runs/`). One step
at a time:

- **start** — pinned spawn at exactly `node_id`/`gpus`/`port`, then waits for
  the service's health path (`health_timeout_s`); the time to healthy is
  recorded and used for the next plan's downtime estimates.
- **stop** — the agent returns only once the process (group) is gone:
  SIGTERM, wait, SIGKILL, reap (see the agent's stop below).
- after every step: re-measure (`GET /vram` on every node), log projected vs
  measured MB, and **re-plan from reality** (estimates are replaced by
  measurements as services come up). `replanned: true` in the log marks
  where the remaining plan changed.
- a failed step **rolls back**: stops what the run started, restores the
  profiles it patched, restarts what it stopped at the old placement; the
  result is `rolled_back` (409) with the failing step and the rollback log.
- one apply at a time (409 while one runs). Applying the current layout is a
  no-op (`status: "noop"`).

```json
{ "run_id": "279c4734fce7c8dc", "status": "done",
  "log": [ { "n": 7, "op": "stop", "profile": "chat-mahou", "ok": true, "seconds": 1.36,
             "projected_mb": { … }, "measured_mb": { … }, "replanned": false,
             "stop": { "pid": 1246340, "gone": true, "killed": false, "waited_s": 0.2 } }, … ],
  "result": { "ok": true, "status": "done", "layout": { … GET /api/layout after … } } }
```

MCP: `get_layout`, `plan_layout`, `apply_layout` (waits 120 s by default,
then returns the `run_id`) and `get_layout_run`. The dashboard's **GPU
layout** section shows one bar per card with a segment per service.

Example: [`examples/layouts/schneewolf.json`](examples/layouts/schneewolf.json)
— Luna + Familiar sharing one server on GPU 0 with the Riko voice, the
narrator on GPU 1, Mahou at 64k on GPU 2, Niku on GPU 3:

```bash
CP=http://<cp>:8765
curl -s -X POST $CP/api/layout/plan  -H 'content-type: application/json' \
  -d @docs/examples/layouts/schneewolf.json | jq '.ok, .error, [.steps[] | "\(.n) \(.op) \(.profile) \(.gpus // "")"], .downtime'
jq '. + {confirm: true}' docs/examples/layouts/schneewolf.json \
  | curl -s -X POST $CP/api/layout/apply -H 'content-type: application/json' -d @- | jq '.status, .log[] | {n, op, profile, ok}'
```

### Stop semantics (agent)

`POST /services/stop {id, grace_s?, report?}` returns only once the process
— for every engine, its whole process group — is gone: SIGTERM, wait
`grace_s` (default 10 s; 1 s when `/proc/<pid>/status` shows SIGTERM blocked
or ignored), SIGKILL, wait up to 15 s, reap. Adopted services (outlived an
agent restart, not our children) get the same treatment. `204` when gone
(`report: true` → `200` with `{gone, killed, sigterm_unreceivable,
waited_s}`); `202` + report when the process outlived SIGKILL — its row is
kept, shown in `/services` as `state: "stopping"` (`alive: false`, still
counted for VRAM), and the watchdog keeps escalating. A stopped row is never
pruned while its process lives.

Services start with a **clean signal mask**: Hemlock blocks signals on its
worker threads and `posix_spawn` children inherit the caller's mask, so
services spawned from an HTTP handler or the watchdog used to start with
SIGTERM blocked (only SIGKILL worked). The agent now clears the thread's mask
around each spawn (`agent/sigmask.hml`, `pthread_sigmask` via FFI). Services
started by an older agent keep their blocked mask until restarted — the stop
path detects that and SIGKILLs after 1 s.

`GET /services` on the CP never silently drops an agent that is restarting
or busy: its last answer is served with `"stale": true, "stale_as_of"` and
the node is named in `x-witchgrid-stale` (and, as before,
`x-witchgrid-unreachable`). The layout planner refuses to plan while a live
node's agent doesn't answer.

## Observability

**Live dashboard.** `GET /events` (CP, public) is a Server-Sent Events stream:
the dashboard opens one `EventSource` per tab and the CP pushes a fleet snapshot
(services + nodes) whenever it changes, so tables update within ~2s of a real
change instead of on a fixed poll — and a service dying raises a toast. Each
connection runs in its own task (no blocking), and the htmx panels keep a slow
30s timer purely as a fallback if SSE is unavailable (EventSource auto-reconnects
otherwise). `GET /api/state` returns the same snapshot as a one-shot JSON for
scripts or first paint. `GET /api/ready/{profile}` reports `{ready, phase}`
for a service's `/health` — the spawn UI polls it to show **loading model… →
ready** instead of a bare "spawned" while the model loads (`POST /services`
returns when the process is up, ~10–15s before it answers). Nothing to configure.

**Health banner.** The overview shows a failure-first banner: calm/green when
everything's nominal, loud/red when a node is offline or a service is **down**
(crashed) or **failed** (crash-loop guard gave up after repeated restarts), with
per-issue *logs*/*stop* buttons. It's a pure function of the live snapshot, so it
updates in real time. Failed services also show as `✗ failed` in the Services
table (they're surfaced specifically because a transient crash gets respawned by
the watchdog within a tick — only the durable `failed` state needs a human).

`GET /metrics` (CP, public, Prometheus text format) — built from the registry,
so a scrape never fans out to agents:

```
witchgrid_up                        witchgrid_nodes_total
witchgrid_node_up{node}             witchgrid_node_last_seen_seconds{node}
witchgrid_node_auto_restart{node}   witchgrid_node_{cpu_cores,ram_free_mb,ram_total_mb}{node}
witchgrid_gpu_{free,total,used}_mb{node,gpu}   witchgrid_gpu_power_watts{node,gpu}
```

Prometheus scrape:

```yaml
scrape_configs:
  - job_name: witchgrid
    static_configs: [{ targets: ['cp-host:8765'] }]
```

Alert ideas: `witchgrid_node_up == 0` (node down), `witchgrid_gpu_free_mb` low
(no headroom), `witchgrid_node_auto_restart == 0` (watchdog disabled). The live
dashboard at `GET /` covers nodes, services, profiles, capabilities, catalog,
transfers, and a bench view.

## Backup & restore

The CP runs an in-process backup loop (off by default). Enable + tune via
settings; it `VACUUM INTO`s a clean standalone copy:

```bash
curl -X PUT http://<cp>:8765/api/settings -H 'content-type: application/json' \
  -d '{"db_backup_interval_min":"60","db_backup_dir":"./backups","db_backup_keep":"24"}'
```

**Restore:** stop the CP, copy a `witchgrid.db.bak.<ts>` over `witchgrid.db`
(remove any stale `-wal`/`-shm` sidecars first), start the CP. WAL is enabled, so
an unclean stop recovers automatically on next open.

## Reboot recovery

After a node reboots, with the service units + watchdog in place it's hands-off:

1. The service manager restarts the **agent** (systemd / pm2 `pm2 save` / launchd `KeepAlive`).
2. The agent's boot reconcile respawns its services from persisted rows (incl. GPU pins).
3. The **CP** restarts via its own unit; the registry persists in sqlite, so nodes/profiles survive.

Verify: `curl :8765/nodes` shows fresh `last_seen` (< 90 s) for each node, the
expected services are running, and `/metrics` `witchgrid_node_up` is 1. If a
service is parked in `failed` (crash-looped), fix the cause and re-spawn it.

## Upgrades

```bash
scp witchgrid-cp    cp-host:/tmp/        # build elsewhere; Hemlock ≥2.5.7
ssh cp-host '
  cp ~/witchgrid/witchgrid-cp ~/witchgrid/witchgrid-cp.bak.$(date +%s)   # keep a rollback
  mv /tmp/witchgrid-cp ~/witchgrid/witchgrid-cp                          # mv, not cp (ETXTBSY)
  sudo systemctl restart witchgrid-cp'                                   # ~5s; consumers with cached routes ride it out
```

Agent upgrade is the same `mv` + restart; the boot reconcile auto-respawns the
node's services, so there's no manual re-spawn. A CP restart doesn't touch
running inference (it's not on the data path). `ldd witchgrid-cp` on the target
before restart catches any missing shared lib.

## Auth

Set `WITCHGRID_SHARED_SECRET` to the **same** value on the CP and every agent.
Inbound CP↔agent calls then require `Authorization: Bearer <secret>`; public
endpoints (`/healthz`, `/metrics`, `/resolve`, dashboard) stay open. A mismatch
(one side set, the other not) surfaces as 401s in the logs. This is LAN-grade —
**do not expose the CP to the internet.**

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `[cp] creating NEW database …` unexpectedly | Started from the wrong CWD with no `WITCHGRID_DATA_DIR`. Set it; you're looking at an empty registry. |
| `database is locked` | Pre-WAL build, or a non-Witchgrid writer. Current builds set WAL + `busy_timeout=5000`; rebuild. |
| node shows but `last_seen` is stale (`witchgrid_node_up 0`) | Agent down or can't reach the CP. Check the agent service + `WITCHGRID_CP_URL`. |
| spawn returns `{"error":"internal"}` for an image/whisper/piper model | The GGUF has no `general.architecture` (SD/whisper aren't LLMs) → capacity placement can't size it. Spawn pinned: `node_id` + `gpus` + `port` + `model`. |
| spawn lands on an occupied port | `pick_port` TCP-probes the agent, but only the agent's own OS sees non-Witchgrid listeners — make sure you're hitting the right node. |
| 401s everywhere after enabling auth | `WITCHGRID_SHARED_SECRET` mismatch between CP and an agent. |
| duplicate services after an agent restart | Should not happen (two-phase reconcile + per-port guard). If it does, capture the agent log and file it — that's the watchdog churn class. |
