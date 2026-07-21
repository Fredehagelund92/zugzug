# Design: self-hosted production deploy

**Date:** 2026-07-21
**Status:** Approved (pending spec review)
**Goal:** Give a self-hoster a documented, turnkey path from "I have a domain and a box" to "Zugzug running in production over HTTPS with real credentials" — the must-have #1 gap between the demo (`docker compose up`) and an actual go-live. Scope: **self-hosted single-box**, not a hosted/multi-tenant offering.

## Background (verified this session)

- The demo `compose.yml` is exactly that — a demo: `ORIGIN=http://localhost:8080`, `SEED_DEMO=true`, DB creds `zugzug/zugzug`, `ATTACH_WAREHOUSE=false`. Not safe for real users.
- The app image (`app/Dockerfile`) runs nginx that serves the built SPA and reverse-proxies `/api` + `/ws` to `server:8787` (via `API_UPSTREAM`, default `server:8787`). So a front proxy only needs to forward the whole site to `app:80` — no per-path config.
- Session cookies are `Secure` only when `ORIGIN` starts with `https://` (`server/src/auth.ts:66`). Production therefore requires an https `ORIGIN`.
- The server entrypoint (`server/start.sh`) runs migrations (and, only when `SEED_DEMO=true`, the demo seed) then boots; it auto-generates the cursor key into `${ZUGZUG_DATA_DIR}/cursor.key` if unset.
- Only `DATABASE_URL` is hard-required at boot.

## Decisions (from brainstorming)

- **TLS:** bundle **Caddy** for automatic Let's Encrypt HTTPS as the default; document a bring-your-own-proxy escape hatch. Caddy is the self-hosted convention (one small service, one-line auto-HTTPS).
- **Postgres:** **bundled** hardened Postgres as the default; document switching to an external/managed Postgres via `DATABASE_URL`.
- Reuse the existing app + server images unchanged.

## Non-goals

Kubernetes/Helm, secrets-manager integration, multi-replica / zero-downtime, a monitoring stack, and **server-side error alerting** (that is must-have #3 — its own follow-up). Real Let's Encrypt issuance cannot be tested without a public domain.

## Architecture

```
Internet :80 / :443
   │  Caddy: auto-provisions Let's Encrypt for $DOMAIN, redirects http→https
   ▼
caddy ─reverse_proxy─► app (nginx :80, SPA + /api,/ws proxy) ─► server (:8787) ─► postgres (:5432)
                                                                            └─► warehouse (optional, ATTACH_WAREHOUSE=true)
```

- **Only `caddy` publishes host ports** (`80`, `443`). `app`, `server`, `postgres` are internal to the compose network — not reachable from the host/internet directly.
- All services: `restart: unless-stopped`.
- Health-gated startup: `postgres` healthy → `server` healthy → `app` → `caddy` (reuses the existing healthchecks; server's is the bun probe from `server/Dockerfile`).

## Components

### `compose.prod.yml` (new, repo root)

Services:
- **caddy** — image `caddy:2-alpine`; mounts `./Caddyfile` (read-only) and named volumes `caddy_data` (certs/ACME state — must persist or you re-issue certs and hit rate limits) + `caddy_config`; env `DOMAIN`, `ACME_EMAIL`; ports `80:80`, `443:443`; `depends_on: app`.
- **app** — `build: ./app`; no host ports; `depends_on: server` (service_healthy).
- **server** — `build: ./server`; no host ports; volume `serverdata:/data`; `depends_on: postgres` (service_healthy). `SEED_DEMO` is **unset** → migrations only, no demo data. Its `DATABASE_URL` is **built by compose from the single `POSTGRES_PASSWORD`** so the operator never types the password twice: `DATABASE_URL: postgres://zugzug:${POSTGRES_PASSWORD}@postgres:5432/zugzug`. (For the managed-Postgres escape hatch, the operator sets `DATABASE_URL` directly in `.env`, which overrides this.) All other server env (`ORIGIN`, `SEED_DEMO=false`, warehouse, OIDC, secrets) passes through from `.env`.
- **postgres** — `postgres:16-alpine`; `POSTGRES_USER=zugzug`, `POSTGRES_DB=zugzug`, `POSTGRES_PASSWORD` from `.env` (no default — compose fails loudly if unset); volume `pgdata`; `pg_isready` healthcheck; no host ports.

Named volumes: `pgdata`, `serverdata`, `caddy_data`, `caddy_config`.

Compose auto-loads `.env` from the working directory for `${VAR}` interpolation, so the operator fills one `.env` file.

### `Caddyfile` (new, repo root)

```
{
	email {$ACME_EMAIL}
}

{$DOMAIN} {
	reverse_proxy app:80
}
```

Auto-HTTPS + http→https redirect are automatic once `DOMAIN` resolves to the host. Caddy handles the ACME challenge on `:80`/`:443`.

### `.env.prod.example` (new, repo root)

The production env template — copied to `.env` and filled. Committed; real `.env` is git-ignored. Contents (grouped, with inline secret-generation guidance):

- **Deploy:** `DOMAIN=zugzug.example.com`, `ACME_EMAIL=ops@example.com`.
- **Required:** `POSTGRES_PASSWORD=` (— `openssl rand -base64 32`; compose builds `DATABASE_URL` from it for the bundled DB), `ORIGIN=https://zugzug.example.com` (must match `DOMAIN`; makes cookies `Secure`). `DATABASE_URL` is commented out by default — uncomment/set it only to point at an **external** Postgres.
- **Production safety:** `SEED_DEMO=false`, `DEV_BYPASS_AUTH=false`, `ZUGZUG_SELF_HOSTED=1`.
- **Secrets (generate + back up):** `ZUGZUG_CURSOR_KEY=` (`openssl rand -base64 32`); if webhooks: `WEBHOOKS_ENABLED=1` + `ZUGZUG_WEBHOOK_MASTER_KEY=` (`openssl rand -base64 32` — **back this up; losing it orphans all webhook secrets**).
- **Warehouse (optional):** `ATTACH_WAREHOUSE=true`, `WAREHOUSE_ADAPTER=motherduck`, `MOTHERDUCK_TOKEN=`, `MOTHERDUCK_WRITABLE=` (with the least-tested-path caveat), `ZUGZUG_DB=zugzug`.
- **Auth (optional OIDC):** `OIDC_ISSUER_URL=`, `OIDC_CLIENT_ID=`, `OIDC_CLIENT_SECRET=`, `OIDC_ALLOWED_DOMAIN=` / `ALLOWED_DOMAIN=`.
- **Tuning (optional):** `PG_POOL_MAX=5`, `ZUGZUG_PULL_API_RPM=600`.

`.gitignore` gets a `/.env` entry if not already ignored (verify; do not ignore `.env.prod.example`).

### `docs/deploy.md` (new)

Step-by-step:
1. **Prerequisites** — a host with Docker + a public DNS `A`/`AAAA` record for `DOMAIN` pointing at it; ports 80/443 open.
2. **Configure** — `cp .env.prod.example .env`; fill `DOMAIN`, `ACME_EMAIL`, `ORIGIN`; generate the three secrets with the shown `openssl` commands.
3. **Launch** — `docker compose -f compose.prod.yml up -d --build`. Caddy issues the cert on first request; browse to `https://DOMAIN`, create the first account (becomes admin).
4. **Escape hatches:**
   - *Behind existing ingress:* remove the `caddy` service, publish `app` on a host port, terminate TLS upstream, keep `ORIGIN=https://…`.
   - *Managed Postgres:* remove the `postgres` service, set `DATABASE_URL` to your managed instance.
5. **Operate** — link `docs/operations.md` (backups); reminders to back up the webhook master key and Postgres; the writable-warehouse caveat.

### `README.md`

One link near the demo section: "Running it for real? See [Deploy to production](./docs/deploy.md)."

## Verification

- `docker compose -f compose.prod.yml config` parses with a representative `.env`.
- **Topology proof (local, no public domain):** run the prod stack with Caddy in local mode — either plain `:80` (`http://` site address) or Caddy's internal CA — and confirm: `curl` the health endpoint and SPA **through Caddy**; `docker compose ps` shows all services healthy; server logs show migrations ran and **no demo seed** (no "demo dimensions seeded"); the stack comes up with `POSTGRES_PASSWORD` from `.env` (not the demo default).
- **Cookie-Secure check:** with `ORIGIN=https://…`, confirm the signup `Set-Cookie` carries `Secure` (served via Caddy's TLS, or asserted from `auth.ts` behavior).
- **Cannot verify:** real Let's Encrypt issuance (needs public DNS) — documented as such; everything up to the public ACME handshake is covered.
- No regression to the demo path: existing `compose.yml` and the `compose-smoke` CI job untouched.

## Risks / notes

- **Caddy cert persistence:** `caddy_data` must be a named volume, or certs re-issue on every recreate and hit Let's Encrypt rate limits. Called out in the compose + doc.
- **`ORIGIN` vs `DOMAIN` drift:** if they don't match, OAuth redirects and cookies break. The `.env` template ties them together with a comment.
- **First-run admin over the internet:** first signup becomes admin — the doc tells operators to create their account immediately after launch (and set `ALLOWED_DOMAIN`/OIDC domain gating if they want to restrict signups).
