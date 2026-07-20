# Design: one-command demo via `docker compose up`

**Date:** 2026-07-20
**Status:** Approved (pending spec review)
**Goal:** Make Zugzug trivially runnable for the open-source community. `git clone … && cd zugzug && docker compose up` boots the full stack with seeded demo data and no external accounts (no warehouse, no OAuth). This is Tier 1 of the OSS production-readiness effort — the first-run on-ramp.

## Background

Main already has the hard parts: password auth (default, first signup = admin), `ATTACH_WAREHOUSE=false` (warehouse optional), `bun run bootstrap --seed` (seeds demo Country/Channel dimensions), per-package Dockerfiles with healthchecks, a `start.sh` that migrates then boots, and CI. The gap is purely packaging and first-run wiring:

- There is **no full-stack compose file** (only `server/docker-compose.test.yml` for the test DB).
- The production `app/nginx.conf` serves the SPA but has **no `/api` or `/ws` proxy**, so the containerized frontend cannot reach the backend. Dev works only because Vite proxies `/api`→`:8787` and `/ws`→`:8787`.
- Only `DATABASE_URL` is hard-required at boot (verified in `server/src/env.ts`); everything else defaults.

## Non-goals (later tiers, explicitly out of scope here)

GHCR/CI image publishing, a separate production compose file, backup/restore tooling, secrets manager, per-tenant warehouse tokens, load testing. This spec is only the try-it-from-clone path.

## Topology

Three services on one compose network:

```
┌─ postgres:16 ──────┐   ┌─ server (Bun, :8787) ─┐   ┌─ app (nginx, :80) ─┐
│ zugzug_app DB      │◄──│ migrate+seed on boot  │◄──│ serves SPA         │
│ volume: pgdata     │   │ ATTACH_WAREHOUSE=false│   │ proxies /api,/ws   │
└────────────────────┘   │ volume: serverdata    │   └────────────────────┘
                         └───────────────────────┘     host:8080 → app:80
```

- **Only `app` is published to the host** (`8080:80`). The browser uses one origin; nginx reverse-proxies `/api` and `/ws` to `server:8787` on the internal network. Server port stays internal — no host clash, no CORS.
- **postgres**: named volume `pgdata` so data survives `down`/`up`. Healthcheck `pg_isready`; server gates on it with `depends_on: { postgres: { condition: service_healthy } }`.
- **server**: builds from `./server`. Named volume `serverdata` mounted at `/data` to persist the auto-generated cursor key across restarts.
- **app**: builds from `./app`.

Images are **built from source** (`build:`), not pulled — works from a fresh clone with no registry or CI. First build is ~2–4 min; subsequent runs are cached.

## Component changes

### 1. `compose.yml` (new, repo root)

Defines the three services above with all demo env inline (see Env table). `SEED_DEMO=true` and `ATTACH_WAREHOUSE=false` by default. Comments point real self-hosters at the vars to change (`SEED_DEMO=false`, warehouse creds, `ORIGIN`).

### 2. `app/nginx.conf` + `app/Dockerfile` — the proxy fix (required)

nginx gains reverse-proxy blocks:

```nginx
location /api {
  proxy_pass http://${API_UPSTREAM};
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location /ws {
  proxy_pass http://${API_UPSTREAM};
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

To keep the app image reusable, `${API_UPSTREAM}` (default `server:8787`) is injected via nginx's built-in template mechanism: the file is shipped as `/etc/nginx/templates/default.conf.template` and nginx's entrypoint runs `envsubst` at container start. `app/Dockerfile` changes: copy the conf into the templates dir instead of `conf.d/default.conf`, and set `ENV API_UPSTREAM=server:8787`.

Only `${API_UPSTREAM}` is templated; all other `$` nginx variables (`$host`, `$http_upgrade`, etc.) must be preserved — set `NGINX_ENVSUBST_FILTER=API_UPSTREAM` so envsubst only substitutes that one name.

Dev is unaffected: Vite (`app/vite.config.*`) still proxies `/api` and `/ws` to `localhost:8787` locally.

### 3. `server/start.sh` — seed + cursor-key auto-generation

Current: runs `drizzle/migrate.ts` then `bun run start`. New behavior:

```sh
#!/usr/bin/env sh
set -e

# Auto-generate a cursor-signing key on first boot if none supplied.
# Persisted in the mounted data volume so it survives restarts.
if [ -z "$ZUGZUG_CURSOR_KEY" ]; then
  KEY_FILE="${ZUGZUG_DATA_DIR:-/data}/cursor.key"
  mkdir -p "$(dirname "$KEY_FILE")"
  if [ ! -f "$KEY_FILE" ]; then
    head -c 32 /dev/urandom | base64 | tr -d '\n' > "$KEY_FILE"
  fi
  ZUGZUG_CURSOR_KEY="$(cat "$KEY_FILE")"
  export ZUGZUG_CURSOR_KEY
fi

if [ "$SEED_DEMO" = "true" ]; then
  echo "· bootstrapping (migrations + demo seed)…"
  bun run bootstrap -- --seed
else
  echo "· running migrations…"
  bun run drizzle/migrate.ts
fi

echo "· starting server…"
exec bun run start
```

`bootstrap --seed` is idempotent (uses `ON CONFLICT DO NOTHING` and empty-table guards), so re-running `up` is safe. When `SEED_DEMO` is unset/false, behavior is identical to today (migrations only) — no regression for existing non-compose users who run `start.sh` directly.

`base64` and `/dev/urandom` are present in the `oven/bun:1` (Debian) image.

### 4. `README.md`

Add a top-of-fold **"Try it in 30 seconds"** section:

```
git clone https://github.com/Fredehagelund92/zugzug.git
cd zugzug
docker compose up
# open http://localhost:8080, create your account (first user = admin)
```

The existing four-step manual flow is retained under a **"Develop locally"** heading (it's the dev path: Vite hot reload, no Docker). Auth and warehouse sections unchanged.

## Env / keys (all inline in `compose.yml`, no `.env` editing to start)

| Var | Demo value | Why |
|---|---|---|
| `DATABASE_URL` | `postgres://zugzug:zugzug@postgres:5432/zugzug` | points at the pg service |
| `ATTACH_WAREHOUSE` | `false` | no MotherDuck token needed |
| `SEED_DEMO` | `true` | demo Country/Channel dimensions |
| `ORIGIN` | `http://localhost:8080` | matches browser URL (cookies/redirects) |
| `ZUGZUG_SELF_HOSTED` | `1` | relaxes localhost webhook ban; self-host defaults |
| `ZUGZUG_CURSOR_KEY` | *(unset → auto-generated to `/data/cursor.key`)* | Pull API cursor signing |
| `POSTGRES_USER/PASSWORD/DB` | `zugzug`/`zugzug`/`zugzug` | pg service init |

Auth: password mode (default), first signup becomes admin. Nothing to configure.

## Files touched

- **New:** `compose.yml` (repo root); `.dockerignore` in `app/` and `server/` if absent (keep build context lean).
- **Edit:** `app/nginx.conf` (proxy blocks + template var), `app/Dockerfile` (templates dir + `API_UPSTREAM`), `server/start.sh` (seed + cursor key).
- **Edit:** `README.md` (Try-it section; demote manual flow to Develop-locally).

No changes to `server/src/**` expected — `bootstrap.ts`/`seed.ts` already exist under `src/` and are copied into the server image.

## Verification (success criteria, run before claiming done)

1. `docker compose up --build` from a clean clone → all three services reach healthy.
2. `curl -fsS localhost:8080/api/health` (through nginx) → 200.
3. Browser at `localhost:8080` (via `/run` or `verify`): sign up → land on app with demo Country/Channel tables visible; the WebSocket presence connection (`/ws`) establishes (no console error).
4. `docker compose down && docker compose up` → data persists; cursor key unchanged (same `/data/cursor.key`); no duplicate-seed errors.
5. `cd server && bun run test` and `cd app && bun run test` still green (no regression from nginx/`start.sh` edits).

## Risks / notes

- **nginx template preservation:** getting `envsubst` to substitute only `API_UPSTREAM` and leave `$host`/`$http_upgrade` intact is the one fiddly bit — covered by `NGINX_ENVSUBST_FILTER`. Verified by step 2/3.
- **First build time** (~2–4 min) may surprise users; the README notes it.
- **`ORIGIN` correctness:** password-mode cookies must be accepted at `localhost:8080`. If cookie `Secure`/`SameSite` handling rejects http-localhost, adjust in the auth cookie logic (verify in step 3). No change anticipated, but flagged.
