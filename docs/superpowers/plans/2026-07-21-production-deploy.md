# Self-Hosted Production Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a turnkey self-hosted production deploy — `compose.prod.yml` + Caddy auto-HTTPS + bundled Postgres + a prod env template + a deploy doc — so a self-hoster goes from "domain + box" to "Zugzug on HTTPS with real credentials".

**Architecture:** A separate `compose.prod.yml` (the demo `compose.yml` is untouched). Caddy terminates TLS and reverse-proxies the whole site to the existing app image's nginx (`app:80`), which already serves the SPA and proxies `/api`+`/ws` to `server:8787`. Only Caddy publishes host ports; app/server/postgres stay internal. Both TLS and Postgres are overridable via documented escape hatches.

**Tech Stack:** Docker Compose, Caddy 2 (automatic Let's Encrypt), Postgres 16, the existing app (nginx) + server (Bun) images.

## Global Constraints

- **Reuse the existing app + server images unchanged** (`build: ./app`, `build: ./server`). No Dockerfile edits.
- **Only `caddy` publishes host ports** (`80`, `443`). `app`, `server`, `postgres` have no host ports.
- **All services** `restart: unless-stopped`.
- **`SEED_DEMO: "false"`** in prod (migrations only, no demo data). `DEV_BYPASS_AUTH: "false"`. `ZUGZUG_SELF_HOSTED: "1"`.
- **Cookies need https**: `ORIGIN` must be `https://<domain>` (server sets `Secure` only when `ORIGIN` starts with `https://`).
- **Single password source**: compose builds `DATABASE_URL` from `POSTGRES_PASSWORD` for the bundled DB (`postgres://zugzug:${POSTGRES_PASSWORD}@postgres:5432/zugzug`); setting `DATABASE_URL` directly overrides it (external-DB escape hatch).
- **Required vars fail loudly**: use `${VAR:?message}` for `DOMAIN`, `ACME_EMAIL`, `ORIGIN`, `POSTGRES_PASSWORD`.
- **Caddy cert volume must persist** (`caddy_data`) or certs re-issue and hit Let's Encrypt rate limits.
- **Do not commit a real `.env`** — only `.env.prod.example`. Verify `.env` is git-ignored and `.env.prod.example` is not.
- Commits: `git commit -s` with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Work on a branch.
- Local verification uses `DOMAIN=localhost` (Caddy serves it via its internal CA — no Let's Encrypt), so the full https topology is testable offline. Real ACME issuance needs a public domain and is out of scope to verify.

---

### Task 1: Production env template + gitignore guard

**Files:**
- Create: `.env.prod.example` (repo root)
- Modify: `.gitignore` (ensure `.env` ignored, `.env.prod.example` not)

**Interfaces produced:** the env var names `compose.prod.yml` (Task 2) interpolates: `DOMAIN`, `ACME_EMAIL`, `ORIGIN`, `POSTGRES_PASSWORD`, `DATABASE_URL` (optional), `SEED_DEMO`, `DEV_BYPASS_AUTH`, `ZUGZUG_SELF_HOSTED`, `ATTACH_WAREHOUSE`, `WAREHOUSE_ADAPTER`, `MOTHERDUCK_TOKEN`, `MOTHERDUCK_WRITABLE`, `ZUGZUG_DB`, `OIDC_*`, `ALLOWED_DOMAIN`, `ZUGZUG_CURSOR_KEY`, `WEBHOOKS_ENABLED`, `ZUGZUG_WEBHOOK_MASTER_KEY`, `PG_POOL_MAX`, `ZUGZUG_PULL_API_RPM`.

- [ ] **Step 1: Create `.env.prod.example`**

```bash
# Zugzug — production environment. Copy to `.env` (same directory as compose.prod.yml),
# fill in, then: docker compose -f compose.prod.yml up -d --build
# See docs/deploy.md. NEVER commit your real .env.

# ---- Deploy (required) ----
# Public domain (must have a DNS A/AAAA record pointing at this host) and an
# email for Let's Encrypt expiry notices.
DOMAIN=zugzug.example.com
ACME_EMAIL=ops@example.com

# Public URL of the app. MUST be https://<DOMAIN> — this is what makes session
# cookies Secure and builds correct OAuth redirects.
ORIGIN=https://zugzug.example.com

# ---- Database (required) ----
# Password for the bundled Postgres. Generate a strong one:
#   openssl rand -base64 32
POSTGRES_PASSWORD=

# To use an EXTERNAL/managed Postgres instead of the bundled one, set DATABASE_URL
# here (and remove the `postgres` service from compose.prod.yml). Leave commented
# to use the bundled DB (compose builds DATABASE_URL from POSTGRES_PASSWORD).
# DATABASE_URL=postgres://user:pass@host:5432/dbname?sslmode=require

# ---- Secrets (generate; back these up) ----
# HMAC key for Pull-API pagination cursors:  openssl rand -base64 32
ZUGZUG_CURSOR_KEY=

# Webhooks (optional). If you enable them, set a master key and BACK IT UP —
# losing it makes every stored webhook signing secret unrecoverable.
WEBHOOKS_ENABLED=0
# ZUGZUG_WEBHOOK_MASTER_KEY=   # openssl rand -base64 32

# ---- Warehouse (optional) ----
# Off by default: record + publish works Postgres-only. To scan a warehouse and
# (optionally) publish dim_/map_ into it, enable and provide a token.
ATTACH_WAREHOUSE=false
WAREHOUSE_ADAPTER=motherduck
MOTHERDUCK_TOKEN=
# WRITABLE mode publishes dim_/map_ INTO your warehouse. This is the least-tested
# path in the repo — validate against a staging warehouse before trusting prod dbt.
MOTHERDUCK_WRITABLE=false
ZUGZUG_DB=zugzug

# ---- Auth (optional: OIDC / SSO) ----
# Leave OIDC_ISSUER_URL unset for local email+password (first signup = admin).
OIDC_ISSUER_URL=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_ALLOWED_DOMAIN=
# Restrict signups to an email domain in BOTH password and OIDC modes:
ALLOWED_DOMAIN=

# ---- Tuning (optional) ----
PG_POOL_MAX=5
ZUGZUG_PULL_API_RPM=600
```

- [ ] **Step 2: Ensure `.env` is ignored and `.env.prod.example` is not**

Inspect `.gitignore`:
```bash
cat .gitignore
git check-ignore -v .env || echo "NOT-IGNORED: .env"
git check-ignore -v .env.prod.example && echo "PROBLEM: example is ignored" || echo "OK: example tracked"
```
- If `.env` is NOT ignored, append a line `/.env` to `.gitignore`.
- If the existing ignore pattern is a glob like `.env*` that also catches the example, add an explicit un-ignore line `!.env.prod.example` after it.

- [ ] **Step 3: Verify the gitignore result**

Run:
```bash
git check-ignore .env && echo "env ignored: OK"
git check-ignore .env.prod.example && echo "example ignored: BAD" || echo "example tracked: OK"
```
Expected: `env ignored: OK` and `example tracked: OK`.

- [ ] **Step 4: Commit**

```bash
git add .env.prod.example .gitignore
git commit -s -m "feat(deploy): production env template + gitignore guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `compose.prod.yml` + `Caddyfile` (with local topology verification)

**Files:**
- Create: `compose.prod.yml` (repo root)
- Create: `Caddyfile` (repo root)

**Interfaces consumed:** the env vars from Task 1's `.env.prod.example`.

- [ ] **Step 1: Create `Caddyfile`**

```
{
	email {$ACME_EMAIL}
}

{$DOMAIN} {
	reverse_proxy app:80
}
```

- [ ] **Step 2: Create `compose.prod.yml`**

```yaml
name: zugzug-prod

# Production self-host stack: Caddy (auto-HTTPS) -> app (nginx: SPA + /api,/ws)
# -> server (Bun) -> Postgres. Copy .env.prod.example to .env and fill it in.
# See docs/deploy.md. Only Caddy is exposed to the host.

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - app
    ports:
      - "80:80"
      - "443:443"
    environment:
      DOMAIN: ${DOMAIN:?set DOMAIN in .env}
      ACME_EMAIL: ${ACME_EMAIL:?set ACME_EMAIL in .env}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

  app:
    build: ./app
    restart: unless-stopped
    depends_on:
      server:
        condition: service_healthy

  server:
    build: ./server
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: ${DATABASE_URL:-postgres://zugzug:${POSTGRES_PASSWORD}@postgres:5432/zugzug}
      ORIGIN: ${ORIGIN:?set ORIGIN in .env}
      SEED_DEMO: "false"
      DEV_BYPASS_AUTH: "false"
      ZUGZUG_SELF_HOSTED: "1"
      ZUGZUG_DATA_DIR: /data
      ATTACH_WAREHOUSE: ${ATTACH_WAREHOUSE:-false}
      WAREHOUSE_ADAPTER: ${WAREHOUSE_ADAPTER:-}
      MOTHERDUCK_TOKEN: ${MOTHERDUCK_TOKEN:-}
      MOTHERDUCK_WRITABLE: ${MOTHERDUCK_WRITABLE:-false}
      ZUGZUG_DB: ${ZUGZUG_DB:-zugzug}
      OIDC_ISSUER_URL: ${OIDC_ISSUER_URL:-}
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:-}
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:-}
      OIDC_ALLOWED_DOMAIN: ${OIDC_ALLOWED_DOMAIN:-}
      ALLOWED_DOMAIN: ${ALLOWED_DOMAIN:-}
      ZUGZUG_CURSOR_KEY: ${ZUGZUG_CURSOR_KEY:-}
      WEBHOOKS_ENABLED: ${WEBHOOKS_ENABLED:-0}
      ZUGZUG_WEBHOOK_MASTER_KEY: ${ZUGZUG_WEBHOOK_MASTER_KEY:-}
      PG_POOL_MAX: ${PG_POOL_MAX:-5}
      ZUGZUG_PULL_API_RPM: ${ZUGZUG_PULL_API_RPM:-600}
    volumes:
      - serverdata:/data

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: zugzug
      POSTGRES_DB: zugzug
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U zugzug -d zugzug"]
      interval: 5s
      timeout: 3s
      retries: 30

volumes:
  pgdata:
  serverdata:
  caddy_data:
  caddy_config:
```

- [ ] **Step 3: Write a throwaway local env + validate config parses**

```bash
cat > /tmp/zugzug-prod-test.env <<EOF
DOMAIN=localhost
ACME_EMAIL=test@example.com
ORIGIN=https://localhost
POSTGRES_PASSWORD=$(openssl rand -base64 24)
ZUGZUG_CURSOR_KEY=$(openssl rand -base64 24)
EOF
docker compose --env-file /tmp/zugzug-prod-test.env -f compose.prod.yml config >/dev/null && echo "config OK"
```
Expected: `config OK`. Confirm the interpolation resolved — `DATABASE_URL` built from `POSTGRES_PASSWORD`, and no `${...}` left unresolved:
```bash
docker compose --env-file /tmp/zugzug-prod-test.env -f compose.prod.yml config | grep -E "DATABASE_URL|SEED_DEMO|ORIGIN" | head
```
Expected: `DATABASE_URL: postgres://zugzug:<pw>@postgres:5432/zugzug`, `SEED_DEMO: "false"`, `ORIGIN: https://localhost`.

- [ ] **Step 4: Bring the prod stack up locally (Caddy internal TLS for localhost)**

Ensure host ports 80/443 are free, then:
```bash
docker compose --env-file /tmp/zugzug-prod-test.env -f compose.prod.yml up -d --build
# wait for the server to be healthy
for i in $(seq 1 60); do
  h="$(docker compose --env-file /tmp/zugzug-prod-test.env -f compose.prod.yml ps server --format '{{.Health}}' 2>/dev/null || true)"
  [ "$h" = "healthy" ] && { echo "server healthy"; break; }
  sleep 5
done
docker compose --env-file /tmp/zugzug-prod-test.env -f compose.prod.yml ps
```
Expected: postgres + server healthy, app + caddy up.

- [ ] **Step 5: Smoke the full https topology through Caddy**

Caddy serves `localhost` with its internal CA, so use `-k` (self-signed):
```bash
echo "-- API health via Caddy TLS --"; curl -fsSk https://localhost/api/health | grep -q '"ok":true' && echo OK
echo "-- SPA via Caddy TLS --";        curl -fsSk https://localhost/ | grep -q '<title' && echo OK
echo "-- http -> https redirect --";   curl -s -o /dev/null -w '%{http_code}' http://localhost/ | grep -qE '30[128]' && echo "redirects OK"
echo "-- NO demo seed in prod --";     docker compose --env-file /tmp/zugzug-prod-test.env -f compose.prod.yml logs server | grep -qi "demo dimensions seeded" && echo "BAD: seeded" || echo "OK: no demo seed"
echo "-- signup cookie is Secure (https origin) --"
curl -sk -D - -o /dev/null -X POST https://localhost/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"prod-password-123","name":"Admin"}' \
  | grep -i 'set-cookie' | grep -q 'Secure' && echo "OK: Secure cookie"
```
Expected: each check prints `OK`/`redirects OK`/`OK: no demo seed`/`OK: Secure cookie`. If the Secure flag is missing, `ORIGIN` isn't https or the proxy isn't forwarding TLS — investigate before proceeding.

- [ ] **Step 6: Tear down + clean the throwaway env; commit**

```bash
docker compose --env-file /tmp/zugzug-prod-test.env -f compose.prod.yml down -v
rm -f /tmp/zugzug-prod-test.env
git status --short   # confirm only compose.prod.yml + Caddyfile are staged-worthy; no .env leaked
git add compose.prod.yml Caddyfile
git commit -s -m "feat(deploy): production compose stack — Caddy auto-HTTPS + bundled Postgres

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `docs/deploy.md` + README link

**Files:**
- Create: `docs/deploy.md`
- Modify: `README.md` (one link)

- [ ] **Step 1: Create `docs/deploy.md`**

```markdown
# Deploy to production (self-hosted)

Turnkey HTTPS deploy: Caddy gets you an automatic Let's Encrypt certificate,
and a bundled Postgres runs out of the box. Two escape hatches below cover
existing ingress and managed databases.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the stack and
[operations](./operations.md) for backup/restore.

## Prerequisites

- A host with [Docker](https://docs.docker.com/get-docker/) and ports **80 + 443** open to the internet.
- A DNS **A**/**AAAA** record for your domain pointing at the host.

## 1. Configure

```bash
git clone https://github.com/Fredehagelund92/zugzug.git
cd zugzug
cp .env.prod.example .env
```

Edit `.env`:
- `DOMAIN` — your domain (e.g. `zugzug.acme.com`).
- `ACME_EMAIL` — your email (Let's Encrypt expiry notices).
- `ORIGIN` — `https://<DOMAIN>` (must match; this makes cookies `Secure`).
- Generate secrets:
  ```bash
  openssl rand -base64 32   # -> POSTGRES_PASSWORD
  openssl rand -base64 32   # -> ZUGZUG_CURSOR_KEY
  ```

## 2. Launch

```bash
docker compose -f compose.prod.yml up -d --build
```

Caddy provisions the TLS certificate on first request (needs the DNS record live
and 80/443 reachable). Open `https://<DOMAIN>` and **create the first account —
it becomes the admin.** Do this immediately; to restrict who else can sign up,
set `ALLOWED_DOMAIN` (or configure OIDC) in `.env` and `up -d` again.

## Escape hatches

**Behind existing ingress / your own TLS** — remove the `caddy` service from
`compose.prod.yml`, publish `app` on a host port (e.g. `ports: ["8080:80"]`),
terminate TLS in your upstream proxy, and keep `ORIGIN=https://<domain>`.

**Managed / external Postgres** — remove the `postgres` service, set
`DATABASE_URL` in `.env` to your managed instance (e.g.
`postgres://user:pass@host:5432/db?sslmode=require`). Recommended at scale for
managed backups/PITR.

## Operate

- **Back up Postgres** and, if you use webhooks, the **webhook master key** — see [operations](./operations.md). Losing the master key orphans every stored webhook secret.
- **Warehouse (optional):** set `ATTACH_WAREHOUSE=true` + `MOTHERDUCK_TOKEN`. If you enable `MOTHERDUCK_WRITABLE=true` (publishing `dim_`/`map_` into your warehouse), validate against a staging warehouse first — it's the least-tested path.
- **Updates:** `git pull && docker compose -f compose.prod.yml up -d --build`. Migrations run automatically on server boot.
```

- [ ] **Step 2: Add a README link**

In `README.md`, immediately after the "Try it in 30 seconds" section (before `## Develop locally`), add:
```markdown
Running it for real? See [Deploy to production](./docs/deploy.md) — Caddy auto-HTTPS + bundled Postgres, with escape hatches for existing ingress and managed databases.
```

- [ ] **Step 3: Verify the docs**

```bash
grep -nE "Deploy to production|compose.prod.yml|Escape hatches|ALLOWED_DOMAIN" docs/deploy.md | head
grep -n "Deploy to production" README.md
```
Expected: the deploy headings/links present in `docs/deploy.md`, and the README link present. Read `docs/deploy.md` once to confirm the fenced code blocks render (normal triple-backtick fences).

- [ ] **Step 4: Commit**

```bash
git add docs/deploy.md README.md
git commit -s -m "docs: production deploy guide + README link

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `compose.prod.yml` (caddy + app + server + postgres, restart, internal-only, health-gated) → Task 2. ✓
- `Caddyfile` (auto-HTTPS `reverse_proxy app:80`) → Task 2. ✓
- `.env.prod.example` (all vars, secret-gen, single-password source, https ORIGIN) → Task 1. ✓
- `.gitignore` guard → Task 1. ✓
- `docs/deploy.md` (steps + both escape hatches + operate) → Task 3. ✓
- README link → Task 3. ✓
- Verification (config parse, local https topology via Caddy internal TLS, no demo seed, Secure cookie) → Task 2. ✓
- Demo path untouched (`compose.yml`, `compose-smoke` CI) → nothing in the plan modifies them. ✓

**Placeholder scan:** All file contents are complete. The `zugzug.example.com` / `ops@example.com` values in `.env.prod.example` are template placeholders for the operator to fill — that's the file's purpose, not a plan gap. Verification commands are concrete with expected output.

**Consistency:** Env var names in `.env.prod.example` (Task 1) match exactly the `${VAR}` interpolations in `compose.prod.yml` (Task 2) — `DOMAIN`, `ACME_EMAIL`, `ORIGIN`, `POSTGRES_PASSWORD`, `DATABASE_URL`, `SEED_DEMO`(literal false), `ZUGZUG_CURSOR_KEY`, `WEBHOOKS_ENABLED`, `ZUGZUG_WEBHOOK_MASTER_KEY`, `ATTACH_WAREHOUSE`, `WAREHOUSE_ADAPTER`, `MOTHERDUCK_TOKEN`, `MOTHERDUCK_WRITABLE`, `ZUGZUG_DB`, `OIDC_*`, `ALLOWED_DOMAIN`, `PG_POOL_MAX`, `ZUGZUG_PULL_API_RPM`. `Caddyfile` uses `{$DOMAIN}`/`{$ACME_EMAIL}` matching the `caddy` service env. Service name `app` matches Caddy's `reverse_proxy app:80` and the app image's default `API_UPSTREAM=server:8787`.
