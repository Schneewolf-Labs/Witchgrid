# Witchgrid security model

Witchgrid is **LAN-first**: it's designed to run on a trusted, private network
(a homelab / lab subnet), not on the open internet. Read this before exposing a
control plane beyond that.

## TL;DR

- **Default = no authentication.** With `WITCHGRID_SHARED_SECRET` unset, *every*
  endpoint is open to anyone who can reach the CP or an agent. Only run this on a
  network you fully trust.
- **Set the shared secret** to authenticate CP↔agent and programmatic API
  clients. It's a single bearer token shared across the fleet. The secret stays
  **optional** — nothing changes until you set it.
- **Two opt-in scope knobs** (no effect without the secret):
  `WITCHGRID_AUTH_PROTECT_READ=1` gates the read-only surface (nodes, state,
  fragments, logs, metrics, `/resolve/*`) behind the bearer too, and
  `WITCHGRID_AUTH_PROTECT_INFERENCE=1` gates the `/v1/llama/*` data plane.
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

When the secret is set, agents also require it for peer model pulls: the
pulling agent appends `?token=<sha256(secret)>` to the source agent's
`/models/{alias}/blob` URL (Hemlock's streaming downloader can't attach
headers). The token is a derived, URL-safe digest — the raw secret never
appears in a URL, a transfers row, or a log — and it only unlocks the blob
route, never the rest of the API.

## What's public vs protected

Routes fall into **three tiers** when the secret is set:

**Always public** — status + static surfaces with no fleet data:

- `GET /healthz`
- The dashboard HTML shell pages + `/assets/*` (baked into the binary)

**Read surface** — public by default, bearer-gated when
`WITCHGRID_AUTH_PROTECT_READ=1`:

- `GET /metrics`, `GET /nodes`, the `/ui/*` fragments, `GET /api/state`,
  `GET /events` (SSE), `GET /api/ready/*`, `GET /api/capabilities`,
  `GET /resolve/*`
- `GET /api/profiles`, `GET /api/catalog`, `POST /api/placement_preview`
  (read-only computation), `GET /services/log/*`, `GET /api/config`,
  `GET /api/settings`, bench/transfer reads

**Protected** (always need the bearer when the secret is set) — the mutating
control surface: `POST /register`, `POST /services`, `POST /services/stop`,
`PATCH /api/nodes/*`, profile/alias/settings CRUD, `POST /models/*`,
`POST /api/bench`, `POST /mcp`.

> With `WITCHGRID_AUTH_PROTECT_READ` unset, anyone who can reach the CP can
> *see* the fleet (nodes, services, GPU stats, model catalog) regardless of the
> secret — it's a status console, not a vault. Setting it closes that, but the
> browser dashboard's live views will `401` too (no login UI yet) — front the
> dashboard with a reverse proxy that injects the bearer (see below). Note that
> with the read surface gated, Prometheus needs `bearer_token` configured for
> `/metrics`, and consumers calling `GET /resolve/*` need the bearer.

## The inference plane (`/v1/llama/*`)

The `/v1/llama/{profile}/*` proxy is **public by default** — even with the
shared secret set, any LAN client can run inference. Set
`WITCHGRID_AUTH_PROTECT_INFERENCE=1` (with the secret) to require the bearer
on it. There are **no per-consumer tokens** yet — every consumer shares the
same secret, so you can't revoke one without rotating all. Per-consumer API
tokens are planned (see roadmap).

Most high-throughput consumers should skip the proxy entirely: `GET /resolve/
{profile}` returns the live `host:port` and they connect to the llama-server
directly, keeping the CP out of the hot path.

## Secret handling details

- The bearer is compared via SHA-256 digests, not raw bytes.
- The CP's dashboard fan-outs shell out to `curl`; the bearer is passed via a
  `0600` curl config file (`curl_auth.cfg` in the data dir, rewritten at every
  boot, deleted when auth is off) — **not** via `-H` argv, which would be
  world-readable through `/proc/<pid>/cmdline` on every fan-out.
- `GET /api/config` reports *whether* auth and the scope knobs are on; the
  secret itself is never exposed by any endpoint.
- CP↔agent POSTs carry the secret as an in-band `_auth_token` body field (a
  Hemlock libwebsockets workaround); agents strip it from anything they
  persist — it never lands in `services.profile_json` or transfer rows.

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
