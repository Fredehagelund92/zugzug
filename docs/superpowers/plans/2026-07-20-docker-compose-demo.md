# Docker Compose Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `git clone … && cd zugzug && docker compose up` boot the full stack (Postgres + Bun server + nginx-served SPA) with seeded demo data and no external accounts, reachable at `http://localhost:8080`.

**Architecture:** A root `compose.yml` builds the existing `app/` and `server/` Dockerfiles from source and adds a Postgres service. The nginx image gains `/api` + `/ws` reverse-proxy blocks (the missing piece that currently stops the containerized SPA from reaching the backend), with the upstream host injected at container start via nginx's `envsubst` template mechanism. The server entrypoint (`start.sh`) auto-generates a Pull-API cursor-signing key into a persistent volume on first boot and runs the existing idempotent `bootstrap --seed`.

**Tech Stack:** Docker Compose, nginx (alpine, template/envsubst), Bun, Postgres 16, DuckDB (disabled in demo), Drizzle migrations.

## Global Constraints

- **Auth:** password mode (default); first signup becomes admin. No OAuth/OIDC env in the demo.
- **Warehouse:** `ATTACH_WAREHOUSE=false` in the demo — no MotherDuck token required.
- **Only `DATABASE_URL` is hard-required at boot** (`server/src/env.ts:55`); everything else defaults.
- **Idempotency:** `bun run bootstrap -- --seed` is safe to re-run (`ON CONFLICT DO NOTHING` + empty-table guards) and ends with `process.exit(0)`.
- **Host port:** app published on `8080:80`; server port `8787` stays internal to the compose network.
- **Vocabulary:** user-facing copy follows CONTEXT.md (plain words: table, record, publish, workspace).
- **Commits:** sign off with `git commit -s` (DCO, per CONTRIBUTING) and append the `Co-Authored-By` trailer shown in each commit step. Work on a branch, not `main`.
- **No regression:** existing `cd server && bun run test` and `cd app && bun run test` must stay green; the `SEED_DEMO`-unset path of `start.sh` must behave exactly as today (migrations only).

---

### Task 1: Server entrypoint — cursor-key auto-generation + demo seed

**Files:**
- Modify: `server/start.sh` (currently 6 lines: migrate then start)

**Interfaces:**
- Consumes: env vars `SEED_DEMO` (string `"true"` enables seed), `ZUGZUG_CURSOR_KEY` (if already set, respected), `ZUGZUG_DATA_DIR` (defaults `/data`).
- Produces: on first boot writes a 32-byte base64 key to `${ZUGZUG_DATA_DIR}/cursor.key` and exports `ZUGZUG_CURSOR_KEY`; then runs `bootstrap --seed` (when `SEED_DEMO=true`) or `drizzle/migrate.ts` (otherwise); then `exec bun run start`.

- [ ] **Step 1: Write the failing test (cursor-key generation is stable + well-formed)**

Create `server/test-start-cursor-key.sh` (a throwaway harness we delete in Step 5):

```sh
#!/usr/bin/env sh
# Extracts and exercises just the cursor-key block from start.sh logic.
set -e
TMP="$(mktemp -d)"
gen() {
  KEY_FILE="$TMP/cursor.key"
  mkdir -p "$(dirname "$KEY_FILE")"
  if [ ! -f "$KEY_FILE" ]; then
    head -c 32 /dev/urandom | base64 | tr -d '\n' > "$KEY_FILE"
  fi
  cat "$KEY_FILE"
}
K1="$(gen)"
K2="$(gen)"
LEN=$(printf %s "$K1" | wc -c | tr -d ' ')
[ "$K1" = "$K2" ] || { echo "FAIL: key not stable across runs"; exit 1; }
[ "$LEN" = "44" ] || { echo "FAIL: expected 44-char base64, got $LEN"; exit 1; }
echo "PASS: stable 44-char key"
rm -rf "$TMP"
```

- [ ] **Step 2: Run it to verify the generation logic works**

Run: `sh server/test-start-cursor-key.sh`
Expected: `PASS: stable 44-char key` (32 random bytes → 44 base64 chars; second call returns the same key).

- [ ] **Step 3: Rewrite `server/start.sh`**

Replace the entire file with:

```sh
#!/usr/bin/env sh
set -e

# Auto-generate a Pull-API cursor-signing key on first boot if none supplied.
# Persisted in the mounted data volume so it survives restarts. Losing it just
# invalidates in-flight Pull-API cursors (clients resync from ?since=), so this
# is low-stakes — but a stable key avoids surprising 500s on the read API.
if [ -z "$ZUGZUG_CURSOR_KEY" ]; then
  KEY_FILE="${ZUGZUG_DATA_DIR:-/data}/cursor.key"
  mkdir -p "$(dirname "$KEY_FILE")"
  if [ ! -f "$KEY_FILE" ]; then
    head -c 32 /dev/urandom | base64 | tr -d '\n' > "$KEY_FILE"
    echo "· generated cursor key at $KEY_FILE"
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

- [ ] **Step 4: Verify the non-demo path is unchanged and the script is valid**

Run: `sh -n server/start.sh && echo "syntax ok"`
Expected: `syntax ok` (POSIX sh parse check; no execution).
Confirm by reading: with `SEED_DEMO` unset, the `else` branch runs `bun run drizzle/migrate.ts` then `exec bun run start` — byte-for-byte the same commands as the previous `start.sh`.

- [ ] **Step 5: Delete the throwaway harness and commit**

```bash
rm server/test-start-cursor-key.sh
git add server/start.sh
git commit -s -m "feat(docker): auto-gen cursor key + demo seed in server entrypoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: nginx `/api` + `/ws` reverse proxy (the container-frontend fix)

**Files:**
- Modify: `app/nginx.conf` (add proxy blocks; templatable upstream)
- Modify: `app/Dockerfile` (ship conf as a template; set `API_UPSTREAM`)

**Interfaces:**
- Consumes: env var `API_UPSTREAM` (default `server:8787`), substituted at container start.
- Produces: an app image that serves the SPA on `:80`, reverse-proxies `/api` and `/ws` to `http://$API_UPSTREAM`, and preserves nginx runtime variables (`$host`, `$http_upgrade`, …).

- [ ] **Step 1: Rewrite `app/nginx.conf`**

Replace the entire file with:

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  # Reverse-proxy the API to the backend service. ${API_UPSTREAM} is the only
  # value substituted at container start (NGINX_ENVSUBST_FILTER); every other
  # $-variable here is an nginx runtime variable and must survive envsubst.
  location /api {
    proxy_pass http://${API_UPSTREAM};
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Presence/awareness WebSocket.
  location /ws {
    proxy_pass http://${API_UPSTREAM};
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }

  # Long-cache the hashed asset bundles; never cache index.html.
  location ~* \.(js|css|woff2?|svg|png|jpg|jpeg|webp)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
```

- [ ] **Step 2: Update `app/Dockerfile` runtime stage**

Replace the `runtime` stage (last three lines) so nginx renders the template at start:

```dockerfile
FROM nginx:1-alpine AS runtime
# server:8787 is the compose service name; override for other topologies.
ENV API_UPSTREAM=server:8787
# Only substitute API_UPSTREAM — leave $host/$http_upgrade/etc. untouched.
ENV NGINX_ENVSUBST_FILTER=API_UPSTREAM
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 80
```

(The `build` stage above it is unchanged.)

- [ ] **Step 3: Build the app image**

Run: `docker build -t zugzug-app-test ./app`
Expected: build succeeds (`naming to docker.io/library/zugzug-app-test`).

- [ ] **Step 4: Verify envsubst renders the upstream and preserves nginx vars**

```bash
docker run -d --name zz-app-test -e API_UPSTREAM=server:8787 zugzug-app-test
sleep 2
docker exec zz-app-test nginx -t
docker exec zz-app-test cat /etc/nginx/conf.d/default.conf | grep -E "proxy_pass|Upgrade"
docker rm -f zz-app-test
```

Expected:
- `nginx -t` → `... syntax is ok` / `test is successful`.
- grep shows `proxy_pass http://server:8787;` (substituted) **and** `proxy_set_header Upgrade $http_upgrade;` (nginx var preserved, still literal `$http_upgrade`).

- [ ] **Step 5: Commit**

```bash
docker rmi zugzug-app-test 2>/dev/null || true
git add app/nginx.conf app/Dockerfile
git commit -s -m "feat(docker): reverse-proxy /api and /ws from nginx to the backend

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Root `compose.yml` — full stack

**Files:**
- Create: `compose.yml` (repo root)

**Interfaces:**
- Consumes: `app/Dockerfile` (Task 2), `server/Dockerfile` + `server/start.sh` (Task 1).
- Produces: three services (`postgres`, `server`, `app`) on one network; app on host `:8080`; named volumes `pgdata`, `serverdata`.

- [ ] **Step 1: Create `compose.yml`**

```yaml
name: zugzug

# One-command demo. `docker compose up` → http://localhost:8080
# Password auth (first signup = admin), demo reference tables seeded, no warehouse.
# For a real self-host: set SEED_DEMO=false, supply your own ORIGIN, and wire a
# warehouse (ATTACH_WAREHOUSE=true + WAREHOUSE_ADAPTER + MOTHERDUCK_TOKEN).

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: zugzug
      POSTGRES_PASSWORD: zugzug
      POSTGRES_DB: zugzug
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U zugzug -d zugzug"]
      interval: 2s
      timeout: 3s
      retries: 30

  server:
    build: ./server
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://zugzug:zugzug@postgres:5432/zugzug
      PORT: "8787"
      ATTACH_WAREHOUSE: "false"
      SEED_DEMO: "true"
      ORIGIN: http://localhost:8080
      ZUGZUG_SELF_HOSTED: "1"
      ZUGZUG_DATA_DIR: /data
    volumes:
      - serverdata:/data

  app:
    build: ./app
    depends_on:
      server:
        condition: service_healthy
    ports:
      - "8080:80"

volumes:
  pgdata:
  serverdata:
```

(Note: `app` gates on `server` being `service_healthy` — the server image already declares a `HEALTHCHECK` on `/health` in `server/Dockerfile`, so this works with no extra config. `app` needs no `API_UPSTREAM` override; the image default `server:8787` matches the service name.)

- [ ] **Step 2: Bring the stack up**

Run: `docker compose up --build -d`
Then wait for health:
```bash
timeout 180 sh -c 'until [ "$(docker compose ps server --format "{{.Health}}")" = "healthy" ]; do sleep 3; done' && echo "server healthy"
docker compose ps
```
Expected: `server healthy`; `docker compose ps` shows `postgres`, `server`, `app` all Up (server + postgres healthy).

- [ ] **Step 3: Verify the API is reachable through nginx**

Run: `curl -fsS http://localhost:8080/api/health`
Expected: HTTP 200 with a JSON health snapshot (route served by `server/src/server.ts:124`, which handles both `/health` and `/api/health`).

Also confirm the SPA is served:
Run: `curl -fsS http://localhost:8080/ | grep -o "<title>[^<]*"`
Expected: the app's `<title>` (non-empty HTML, not an nginx 404).

- [ ] **Step 4: Verify persistence across a restart**

```bash
docker compose exec -T server cat /data/cursor.key > /tmp/zz-key-before
docker compose down
docker compose up -d
timeout 180 sh -c 'until [ "$(docker compose ps server --format "{{.Health}}")" = "healthy" ]; do sleep 3; done'
docker compose exec -T server cat /data/cursor.key > /tmp/zz-key-after
diff /tmp/zz-key-before /tmp/zz-key-after && echo "cursor key persisted"
docker compose logs server | grep -i "demo dimensions seeded\|Done." | tail -3
```
Expected: `cursor key persisted` (identical key); re-seed runs without error (idempotent — no crash, logs reach `Done.`).

- [ ] **Step 5: Tear down and commit**

```bash
docker compose down
git add compose.yml
git commit -s -m "feat(docker): full-stack compose for one-command demo

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: End-to-end acceptance — sign up and see demo tables

**Files:** none (verification only).

**Interfaces:**
- Consumes: the running stack from Task 3.

- [ ] **Step 1: Bring the stack up fresh**

```bash
docker compose down -v   # clean slate: drop volumes so it's a true first-run
docker compose up --build -d
timeout 180 sh -c 'until [ "$(docker compose ps server --format "{{.Health}}")" = "healthy" ]; do sleep 3; done'
```
Expected: server healthy.

- [ ] **Step 2: Verify demo data was seeded**

```bash
docker compose exec -T postgres psql -U zugzug -d zugzug -c "select name from zugzug_app.dimension order by name;"
```
Expected: rows including the demo `Country` and `Channel` dimensions.

- [ ] **Step 3: Browser acceptance via the verify skill**

Use the `verify` skill (or `/run`) to drive a real browser:
1. Open `http://localhost:8080`.
2. Create an account (email + password) — confirm it lands on the app and this first user is admin.
3. Confirm the demo `Country` / `Channel` reference tables are visible in the grid.
4. Confirm no console error on the presence WebSocket (`/ws` upgrade succeeds).

Expected: all four pass. If cookie auth is rejected at `http://localhost:8080` (Secure/SameSite), that's the one flagged risk — fix in the auth cookie logic and note it; otherwise no code change.

- [ ] **Step 4: Tear down**

Run: `docker compose down`
Expected: clean stop. (Leave the images; next `up` is fast.)

---

### Task 5: README — lead with the one-command path

**Files:**
- Modify: `README.md` (add "Try it in 30 seconds"; demote the manual 4-step flow to "Develop locally")

**Interfaces:** none.

- [ ] **Step 1: Insert the Try-it section**

Immediately before the existing `## Quickstart` heading, add:

```markdown
## Try it in 30 seconds

Requires [Docker](https://docs.docker.com/get-docker/). No warehouse or Google account needed.

​```bash
git clone https://github.com/Fredehagelund92/zugzug.git
cd zugzug
docker compose up
​```

Open `http://localhost:8080` and create your account — the first user becomes the admin. The demo boots with sample `Country` and `Channel` reference tables so you can explore the grid right away. (First run builds the images; that takes a few minutes. Later runs start in seconds.)

To connect your own warehouse or turn off the demo seed, see [Develop locally](#develop-locally) and `server/.env.example`.
```

- [ ] **Step 2: Rename the manual section**

Change the heading `## Quickstart` to `## Develop locally` and add one intro line under it:

```markdown
## Develop locally

For hacking on Zugzug with hot reload (Vite + `bun --watch`), run the two processes directly:
```

(The four numbered sub-steps below it stay as-is.)

- [ ] **Step 3: Verify the doc**

Run: `grep -n "Try it in 30 seconds\|Develop locally\|docker compose up" README.md`
Expected: the new heading, the renamed heading, and the `docker compose up` line all present.
Read the section once to confirm the fenced code block renders (the `​```bash` fence above uses a zero-width char only to escape this plan — use a normal ```` ``` ```` fence in the actual README).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -s -m "docs: lead the README with the one-command docker compose demo

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Topology (3 services, app-only host port, internal server) → Task 3. ✓
- nginx `/api`+`/ws` proxy fix + template → Task 2. ✓
- Seed via existing `bootstrap --seed` in entrypoint → Task 1. ✓
- Cursor-key auto-generation to persistent volume → Task 1 + `serverdata` in Task 3. ✓
- Env/keys inline in compose (`DATABASE_URL`, `ATTACH_WAREHOUSE`, `SEED_DEMO`, `ORIGIN`, `ZUGZUG_SELF_HOSTED`) → Task 3. ✓
- README restructure → Task 5. ✓
- Verification (compose up, `/api/health` 200, persistence, browser signup, tests green) → Tasks 3 & 4; no-regression on `bun run test` is a Global Constraint checked before the final commit. ✓
- `.dockerignore` "if absent" from the spec: dropped as YAGNI — build context size isn't a correctness issue for the demo, and adding ignore files is unrelated churn. Noted here intentionally.

**Placeholder scan:** No TBD/TODO; every code step shows full file contents or exact commands. The only "fix if it happens" is the flagged cookie risk in Task 4 Step 3, which is a genuine conditional, not a placeholder.

**Type/name consistency:** `API_UPSTREAM` (Task 2 conf, Dockerfile ENV, spec) consistent; `ZUGZUG_DATA_DIR`/`/data`/`serverdata` consistent across Task 1 and Task 3; `SEED_DEMO="true"` string compare matches `[ "$SEED_DEMO" = "true" ]`. Service name `server` matches the default `API_UPSTREAM=server:8787` and `DATABASE_URL` host `postgres`. ✓
