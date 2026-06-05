# Witchgrid security model

Witchgrid is **LAN-first**: it's designed to run on a trusted, private network
(a homelab / lab subnet), not on the open internet. Read this before exposing a
control plane beyond that.

## TL;DR

- **Default = no authentication.** With `WITCHGRID_SHARED_SECRET` unset, *every*
  endpoint is open to anyone who can reach the CP or an agent. Only run this on a
  network you fully trust.
- **Set the shared secret** to authenticate CP↔agent and programmatic API
  clients. It's a single bearer token shared across the fleet.
- **HTTP only, no TLS.** The bearer travels in cleartext. Don't send it across an
  untrusted network without a TLS-terminating reverse proxy in front.
- **The dashboard has no login.** With a secret set, the dashboard's *read-only*
  views still work (those routes are public), but *mutations* (spawn, stop,
  profile edits) will `401` from a browser — there's no UI to supply the token
  yet. Drive mutations via the API with the bearer, or front the dashboard with
  an authenticating reverse proxy.

## The two modes

### 1. No secret (default)

`WITCHGRID_SHARED_SECRET` unset → `cp_auth_check` lets every request through.
The CP logs `[auth] DISABLED` at boot. Appropriate only for an isolated,
single-operator LAN. Anyone who can open a TCP connection to `:8765` (or an
agent's `:8766`) can spawn/stop services, edit profiles, pull models, and read
everything.

### 2. Shared bearer secret

Set the **same** `WITCHGRID_SHARED_SECRET` on the CP **and every agent**. Then:

- Non-`public` routes require `Authorization: Bearer <secret>` (compared with a
  SHA-256 digest, so the check isn't a raw byte-compare).
- CP→agent calls carry the bearer automatically (header on GETs; an in-band
  `_auth_token` body field on POSTs — a workaround for a Hemlock libwebsockets
  limitation that drops arbitrary request headers, to be removed when the
  runtime grows POST-with-headers).
- Programmatic consumers (FlameWorker/FlameGen, curl, …) send the bearer
  themselves.

This authenticates the **machine-to-machine** surface. It does **not** give the
dashboard a login (see below).

## What's public vs protected

**Always public** (no auth even when the secret is set) — these are status,
location, or read-only-render surfaces:

- `GET /healthz`, `GET /metrics`
- The dashboard HTML pages + `/assets/*`
- `GET /nodes`, the `/ui/*` fragments, `GET /api/state`, `GET /events` (SSE),
  `GET /api/ready/*`, `GET /api/capabilities`, `GET /resolve/*`
- `GET /api/profiles`, `GET /api/catalog`, `POST /api/placement_preview`
  (read-only computation), `GET /services/log/*`
- `* /v1/llama/*` — the inference data plane (see below)

**Protected** (need the bearer when the secret is set) — the mutating control
surface: `POST /register`, `POST /services`, `POST /services/stop`,
`PATCH /api/nodes/*`, profile/alias/settings CRUD, `POST /models/*`,
`POST /api/bench`.

> Because the read surface is public, anyone who can reach the CP can *see* the
> fleet (nodes, services, GPU stats, model catalog) regardless of the secret.
> Treat that as expected — it's a status console, not a vault. If even read
> access must be restricted, put it behind a reverse proxy.

## The inference plane (`/v1/llama/*`)

The `/v1/llama/{profile}/*` proxy is **public** today, so on a no-secret deploy
any LAN client can run inference; with a secret set it requires the one shared
bearer. There are **no per-consumer tokens** yet — every consumer shares the
same secret, so you can't revoke one without rotating all. Per-consumer API
tokens are planned (see roadmap).

Most high-throughput consumers should skip the proxy entirely: `GET /resolve/
{profile}` returns the live `host:port` and they connect to the llama-server
directly, keeping the CP out of the hot path.

## Exposing beyond a trusted LAN

If you must reach Witchgrid from an untrusted network:

1. **Bind the CP to loopback** — `WITCHGRID_CP_HOST=127.0.0.1` — and put an
   authenticating, TLS-terminating reverse proxy (Caddy, nginx, a tunnel) in
   front of it.
2. Have the proxy enforce its own auth (basic-auth, OIDC, mTLS, …) and inject
   `Authorization: Bearer <WITCHGRID_SHARED_SECRET>` on the way through, so the
   dashboard works end to end behind the proxy.
3. Set `WITCHGRID_SHARED_SECRET` so the agents authenticate to the CP too, and
   keep agent ports (`:8766`) off any public interface.

## Known gaps / roadmap

- **Dashboard login (slice 2)** — a browser session so the dashboard can drive
  mutations with the secret set, without a reverse proxy.
- **Per-consumer `/v1/llama` tokens (slice 3)** — issue/revoke tokens per
  consumer instead of one shared secret.
- **TLS** — native HTTPS (currently delegated to a reverse proxy).

These are post-1.0; the 1.0 posture is the documented LAN-first shared-secret
model above.

## Reporting a vulnerability

This is a personal-lab project. Open a GitHub issue for security concerns, or
contact the maintainer directly for anything sensitive.
