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
- [Observability](#observability)
- [Backup & restore](#backup--restore)
- [Reboot recovery](#reboot-recovery)
- [Upgrades](#upgrades)
- [Auth](#auth)
- [Troubleshooting](#troubleshooting)

---

## Build

Needs the [Hemlock](https://hemlang.dev) toolchain (`hemlockc`, ≥ 2.5.7). Or skip
building and grab the prebuilt binaries from a [release](https://github.com/hemlang/witchgrid/releases)
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

### pm2 (no-sudo agent supervision)

When you can't (or don't want to) write a system unit, pm2 with its boot hook
works for the agent:

```bash
pm2 start "$HOME/witchgrid-agent.sh" --name witchgrid-agent --interpreter bash
pm2 save                      # persist; pm2's startup unit resurrects on reboot
```

### launchd (macOS agents)

A user LaunchAgent (`~/Library/LaunchAgents/ai.flammen.witchgrid-agent.plist`)
with `KeepAlive` + `RunAtLoad` survives reboots; restart with
`launchctl kickstart -k gui/$(id -u)/ai.flammen.witchgrid-agent`.

## Configuration reference

All config is env vars. Both binaries read `WITCHGRID_DATA_DIR` and
`WITCHGRID_SHARED_SECRET`.

### Control plane

| Var | Default | Meaning |
|-----|---------|---------|
| `WITCHGRID_DATA_DIR` | *(CWD)* | Dir for `witchgrid.db` (+ `-wal`/`-shm`). Absolute, created if missing. **Set this** so the DB doesn't follow CWD — a stray fresh DB drops every node/profile/service from view. The CP logs `creating NEW database at …` when it makes a fresh one. |
| `WITCHGRID_SHARED_SECRET` | *(unset)* | Bearer secret required on inbound calls + sent on outbound. Unset = no auth (LAN-trusted). Must match on CP **and every agent**. See [`security.md`](security.md) for the full model (public vs protected routes, reverse-proxy guidance). |
| `WITCHGRID_STALE_NODE_SECONDS` | `90` | A node whose last heartbeat is older than this drops out of placement (and shows `node_up=0` in `/metrics`). Keep it ≳ 3× the agent's `WITCHGRID_HEARTBEAT_SECONDS` so one missed beat doesn't flap a node out. |
| `WITCHGRID_CP_HOST` | `0.0.0.0` | Bind address. Set `127.0.0.1` and front it with an authenticating reverse proxy for anything beyond a trusted LAN. |
| `WITCHGRID_CP_PORT` | `8765` | Bind port. |

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
