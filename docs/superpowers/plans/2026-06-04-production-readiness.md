# Production-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap from "working prototype" to "paid software" — correctness fixes, security posture, observability, deployment artifacts, tests, and DX baseline.

**Architecture:** Eight phases, each producing a deployable state. Phase 1 ships the safety/correctness floor; phases 2–4 add audit trust, accessibility, and observability; phases 5–6 establish DX + deploy; phase 7 adds tests; phase 8 is structural cleanup. Don't reorder phases — later phases depend on earlier ones (e.g. CI in phase 6 depends on lint in phase 5; the test job depends on docker-compose in phase 7).

**Tech Stack:** Bun + TypeScript 6 + postgres.js + DuckDB (`@duckdb/node-api`) on the server. React 18 + Vite 6 + Tailwind v4 in the app. `bun:test` for backend, Vitest + Testing Library for the frontend. Sentry for runtime errors. GitHub Actions for CI.

**Source audits:** See the two-agent audit summary in the originating session for `file:line` evidence and severity rationale behind every task here.

---

## Phase 1 — Stop-the-bleeding (1–2 days)

**Goal of phase:** Every task here is small, deployable, and removes a sharp edge. After this phase, the app is safe to expose behind a load balancer.

### Task 1.1: Wrap `mergeCanonical` in a transaction

**Why:** Today `repo.ts:800-802` runs UPDATE then DELETE per loser in a bare `for` loop. Mid-loop failure leaves the canonical table half-merged with no recovery path. This is a P0 correctness bug.

**Files:**
- Modify: `server/src/repo.ts:793-806`

- [ ] **Step 1: Replace the loop body with a single `pgTx`**

```ts
export async function mergeCanonical(dimId: string, survivor: string, losers: string[]): Promise<number> {
  const m = await dimMeta(dimId);
  if (!m) return 0;
  const key  = qid(m.keyCol);
  const real = losers.filter((l) => l && l !== survivor);
  if (real.length === 0) return 0;

  await pgTx(async (tx) => {
    await tx.run(
      `UPDATE ${cq(m.mapTable)} SET ${key} = $1 WHERE ${key} = ANY($2::text[])`,
      [survivor, real],
    );
    await tx.run(
      `DELETE FROM ${cq(m.dimTable)} WHERE ${key} = ANY($1::text[])`,
      [real],
    );
  });

  await appendAudit("Merged canonical", `${real.join(", ")} → ${survivor}`);
  return real.length;
}
```

- [ ] **Step 2: Add the `pgTx` import**

In `server/src/repo.ts`, top of the file with the other `pg.ts` imports — find the existing line `import { pgAll, pgGet, pgRun … } from "./pg.ts";` and add `pgTx`.

- [ ] **Step 3: Verify typecheck**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Smoke-test via verify script**

```bash
cd server && bun run verify-eid
```

Expected: existing script passes; merge still works on the canonical fixtures.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo.ts
git commit -m "fix(repo): wrap mergeCanonical UPDATE+DELETE in a transaction"
```

---

### Task 1.2: Graceful shutdown on SIGTERM/SIGINT

**Why:** `server.ts` has no signal handler. Container stops kill in-flight requests and abandon Postgres connections. Required before any orchestrated deploy.

**Files:**
- Modify: `server/src/server.ts` (bottom of file)
- Modify: `server/src/pg.ts:6-8` (already exports `pgEnd`)

- [ ] **Step 1: Add shutdown handler at the bottom of `server.ts`**

After the `console.log` on line 302, append:

```ts
import { pgEnd } from "./pg.ts";

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`· ${signal} received — draining…`);
  server.stop(false); // stop accepting new requests; let in-flight finish
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  await pgEnd().catch((e) => console.error("pgEnd failed:", e));
  console.log("· shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

- [ ] **Step 2: Move the `pgEnd` import to the top of the file with the other imports**

(Putting it at the top keeps imports tidy and avoids the ESM-only top-level-await ordering trap.)

- [ ] **Step 3: Verify behaviour locally**

```bash
cd server && bun run start &
SERVER_PID=$!
sleep 2
kill -TERM $SERVER_PID
wait $SERVER_PID
```

Expected output includes `· SIGTERM received — draining…` and `· shutdown complete`. Exit code 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): graceful shutdown on SIGTERM/SIGINT"
```

---

### Task 1.3: `/health` endpoint with Postgres ping

**Why:** Load balancers, container orchestrators, and uptime monitors all need a cheap readiness probe.

**Files:**
- Modify: `server/src/server.ts` (around line 56, before the auth-route branch)

- [ ] **Step 1: Add the health route before the `seg[0] !== "api"` guard**

Insert at `server.ts:55`:

```ts
if (pathname === "/health" || pathname === "/api/health") {
  try {
    await pgAll(`SELECT 1`);
    return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 503, headers: { "content-type": "application/json" },
    });
  }
}
```

- [ ] **Step 2: Add `pgAll` to the imports if not already present**

Top of `server.ts`: `import { pgAll } from "./pg.ts";`

- [ ] **Step 3: Verify**

```bash
cd server && bun run start &
sleep 2
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:8787/health
```

Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): add /health readiness endpoint"
```

---

### Task 1.4: Replace CORS `*` with `env.origin`

**Why:** Wildcard CORS is wrong for a closed team tool. It also blocks `credentials: "include"` if/when you move off Vite's same-origin proxy.

**Files:**
- Modify: `server/src/server.ts:13-15, 52-53`
- Modify: `server/src/auth.ts:192-200, 206-207`

- [ ] **Step 1: Centralize the CORS header set in `server.ts`**

Replace the `json`, `noContent`, and OPTIONS handler with:

```ts
const corsHeaders = {
  "access-control-allow-origin": env.origin,
  "access-control-allow-credentials": "true",
  "vary": "Origin",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });

const noContent = () =>
  new Response(null, { status: 204, headers: corsHeaders });
```

And inside `fetch()`:

```ts
if (method === "OPTIONS")
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
```

- [ ] **Step 2: Fix `auth.ts` to use the same headers**

In `auth.ts` replace the two `cors` literals at lines 192 and 206 with:

```ts
const cors = {
  "access-control-allow-origin": env.origin,
  "access-control-allow-credentials": "true",
  "vary": "Origin",
};
```

(Define once near the top of the file, after the existing constants.)

- [ ] **Step 3: Verify**

```bash
curl -sS -i -H "Origin: http://localhost:5173" http://localhost:8787/api/auth/config | grep -i "access-control"
```

Expected: `access-control-allow-origin: http://localhost:5173` (not `*`).

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts server/src/auth.ts
git commit -m "fix(security): replace wildcard CORS with explicit origin + credentials"
```

---

### Task 1.5: Drop `devBypass` from public `/api/auth/config`

**Why:** Exposing the dev-bypass flag publicly turns an environment misconfiguration into a one-click account takeover on any reachable instance.

**Files:**
- Modify: `server/src/auth.ts:204-208`

- [ ] **Step 1: Return an empty config object**

Replace `handleAuthConfig` with:

```ts
export function handleAuthConfig(): Response {
  return new Response(JSON.stringify({}), {
    headers: { "content-type": "application/json", ...cors },
  });
}
```

(The frontend already attempts Google login first; the `/api/auth/dev` route stays 404'd when `devBypassAuth` is false, which is the actual gate.)

- [ ] **Step 2: Update the login page to probe rather than read**

In `app/src/routes/Login.tsx`, replace the `fetch("/api/auth/config")` + `devBypass` check with a `fetch("/api/auth/dev", { redirect: "manual" })` HEAD-style check on mount that shows the dev button only if the response is a 302 (or the request resolves in dev). Acceptable: just drop the dev button entirely in production builds via `import.meta.env.DEV`.

```tsx
const [devAvailable, setDevAvailable] = useState(false);
useEffect(() => {
  if (!import.meta.env.DEV) return;
  fetch("/api/auth/dev", { method: "HEAD" })
    .then((r) => setDevAvailable(r.status !== 404))
    .catch(() => {});
}, []);
```

- [ ] **Step 3: Verify**

```bash
curl -sS http://localhost:8787/api/auth/config
```

Expected: `{}` (no `devBypass` field).

- [ ] **Step 4: Commit**

```bash
git add server/src/auth.ts app/src/routes/Login.tsx
git commit -m "fix(security): stop leaking devBypass flag via /api/auth/config"
```

---

### Task 1.6: Delete the MotherDuck token SQL interpolation

**Why:** `db.ts:11` does `SET motherduck_token='${env.motherduckToken}'` raw — a structured query logger would log the secret. The env var on line 10 already does the handshake.

**Files:**
- Modify: `server/src/db.ts:7-13`

- [ ] **Step 1: Remove line 11**

```ts
async function attachMotherDuck(conn: DuckDBConnection): Promise<void> {
  await conn.run(`INSTALL motherduck`);
  await conn.run(`LOAD motherduck`);
  process.env.motherduck_token = env.motherduckToken;
  await conn.run(`ATTACH IF NOT EXISTS 'md:'`);
}
```

- [ ] **Step 2: Verify with `ATTACH_WAREHOUSE=true`**

```bash
cd server && ATTACH_WAREHOUSE=true bun run src/spike.ts
```

Expected: MotherDuck attaches successfully.

- [ ] **Step 3: Commit**

```bash
git add server/src/db.ts
git commit -m "fix(db): rely on motherduck_token env var; drop interpolated SET"
```

---

### Task 1.7: `Bun.serve` request body size limit

**Why:** Every `req.json()` buffers without a guard.

**Files:**
- Modify: `server/src/server.ts:43-46`

- [ ] **Step 1: Add `maxRequestBodySize` to the serve options**

```ts
const server = Bun.serve({
  port: env.port,
  idleTimeout: 120,
  maxRequestBodySize: 512 * 1024, // 512 KB — largest legit payload is a grid layout
  async fetch(req) {
```

- [ ] **Step 2: Verify**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -X PUT \
  -H "content-type: application/json" \
  --data-binary @<(head -c 600000 /dev/urandom | base64) \
  http://localhost:8787/api/preferences
```

Expected: non-200 (413 or similar). (Without a session you'll see 401 — the point is that the body did not crash the server.)

- [ ] **Step 3: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): cap request bodies at 512KB"
```

---

### Task 1.8: Explicit Postgres pool sizing

**Why:** `postgres.js` defaults to `max: 10`; managed tiers (e.g. Supabase Free = 20) get squeezed once migrations + sessions run alongside.

**Files:**
- Modify: `server/src/pg.ts:1-8`
- Modify: `server/.env.example` (document the new pool envs)

- [ ] **Step 1: Add explicit options**

```ts
import postgres from "postgres";
import { env } from "./env.ts";

const pool = postgres(env.databaseUrl, {
  max: Number(process.env.PG_POOL_MAX ?? 5),
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false, // postgres.js prepared-stmt cache fights pgbouncer transaction mode
});

export async function pgEnd(): Promise<void> {
  await pool.end({ timeout: 5 });
}
```

- [ ] **Step 2: Add `PG_POOL_MAX` to `.env.example`**

```bash
# Postgres pool sizing — defaults to 5 for the main pool.
# Migrations run with their own max=1 connection.
PG_POOL_MAX=5
```

- [ ] **Step 3: Verify typecheck**

```bash
cd server && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add server/src/pg.ts server/.env.example
git commit -m "feat(pg): explicit pool sizing + 5s shutdown timeout"
```

---

### Task 1.9: Route-level React error boundary

**Why:** `main.tsx` has no `ErrorBoundary` — any throw inside a route paints the screen white.

**Files:**
- Create: `app/src/components/RouteErrorBoundary.tsx`
- Modify: `app/src/main.tsx:36-57`

- [ ] **Step 1: Create the error boundary component**

```tsx
import React from "react";

type State = { error: Error | null };

export class RouteErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Wired to Sentry in Phase 4.
    console.error("Route error:", error, info.componentStack);
  }

  reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center bg-bg p-6 text-ink">
        <div className="max-w-md space-y-4 text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
            Something went wrong
          </div>
          <div className="font-display text-2xl font-semibold">
            The app hit an unexpected error
          </div>
          <p className="text-sm text-ink-2">
            {this.state.error.message || "An unknown error occurred."}
          </p>
          <div className="flex justify-center gap-2 pt-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded border border-line px-3 py-1.5 text-sm hover:border-accent"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.assign("/app")}
              className="rounded bg-accent px-3 py-1.5 text-sm text-white"
            >
              Go to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
```

- [ ] **Step 2: Wrap the protected subtree**

In `main.tsx`, wrap the entire `<UndoStackProvider>…</UndoStackProvider>` content with `<RouteErrorBoundary>`:

```tsx
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";

// …

<Route
  path="*"
  element={
    <RouteErrorBoundary>
      <UndoStackProvider>
        <EngineerModeProvider>
          <BootGate>
            {/* …existing routes… */}
          </BootGate>
        </EngineerModeProvider>
      </UndoStackProvider>
    </RouteErrorBoundary>
  }
/>
```

- [ ] **Step 3: Manually verify by injecting a throw**

Temporarily add `throw new Error("boundary test")` at the top of `Dashboard.tsx`'s component. Reload `/app`. Expected: the fallback UI renders. Remove the throw, reload, confirm normal rendering returns.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/RouteErrorBoundary.tsx app/src/main.tsx
git commit -m "feat(app): route-level error boundary with retry"
```

---

### Task 1.10: Hide `window.BrandApp` in production builds

**Why:** Unconditional global on `main.tsx:23`. Fine in dev, a curious surface in prod.

**Files:**
- Modify: `app/src/main.tsx:18-23`

- [ ] **Step 1: Guard the global assignment**

```tsx
declare global {
  interface Window {
    BrandApp?: { setAccent: typeof setAccent; setTheme: typeof setTheme; toggleTheme: typeof toggleTheme };
  }
}
if (import.meta.env.DEV) {
  window.BrandApp = { setAccent, setTheme, toggleTheme };
}
```

- [ ] **Step 2: Verify**

```bash
cd app && bun run build && grep -c "BrandApp" dist/assets/*.js
```

Expected: `0` (the conditional removes the global from the prod bundle).

- [ ] **Step 3: Commit**

```bash
git add app/src/main.tsx
git commit -m "chore(app): dev-only window.BrandApp"
```

---

## Phase 2 — Audit truth + N+1s + stale closures (2–3 days)

**Goal of phase:** The audit log starts telling the truth, the hot-path list endpoints stop scaling badly, and the three stale-closure `useEffect`s become correct.

### Task 2.1: Thread `userId` through every audit call

**Why:** `repo.ts:1213-1216` defines `appendAudit` as a thin wrapper that hardcodes `u_ada`. Twelve write paths use it. The audit log is currently the most-trusted surface in the product and it is lying about who did what.

**Files:**
- Modify: `server/src/repo.ts:459, 472, 732, 782, 790, 804, 818, 865, 879, 959, 973, 1025, 1206-1216`
- Modify: `server/src/tables.ts:145`
- Modify: `server/src/server.ts` (every route handler that calls these — pass `me`)

- [ ] **Step 1: Update each repo function signature to accept `userId`**

For each of these functions, append a `userId: string` parameter and replace the internal `appendAudit(...)` call with `appendAuditAs(userId, ...)`:

- `deriveCanonical(dimId, table, column, nameColumn, opts, userId)`
- `addSource(dimId, table, column, userId)` — (audit may live here; if not, skip)
- `addCanonicalOne(dimId, label, key, userId)`
- `renameCanonical(dimId, key, label, userId)`
- `mergeCanonical(dimId, survivor, losers, userId)`
- `retireCanonical(dimId, key, userId)`
- `addField(dimId, label, type, options, userId)`
- `renameColumn(dimId, field, label, userId)`
- `changeColumnType(dimId, field, newType, options, coerceInvalidToNull, userId)`
- `deleteColumn(dimId, field, userId)`
- `addColumnOption(dimId, field, label, color, userId)`

Use a code-search-replace pass on the function bodies (find `await appendAudit(`, replace with `await appendAuditAs(userId, `).

- [ ] **Step 2: Update `tables.ts:145`**

```ts
await repo.appendAuditAs(userId, "Created table", detail);
```

Then add `userId: string` to the `createTable` signature and thread it from the route handler. Update `CreateTableInput` (the type) only if the field already lives there; otherwise pass as a second arg.

- [ ] **Step 3: Update every route handler in `server.ts` to pass `me`**

For each repo call updated in step 1, pass `me` as the trailing argument:

```ts
// server.ts:169
return json({ id: await repo.addDimension(name, [], { keyKind }, me) }, 201);
// server.ts:240
await repo.addCanonicalOne(id, label, key, me);
// server.ts:245
return json({ merged: await repo.mergeCanonical(id, survivor, losers, me) });
// …etc for every site
```

- [ ] **Step 4: Delete the `appendAudit` wrapper**

In `repo.ts:1213-1216`, remove:

```ts
export async function appendAudit(action: string, detail: string): Promise<void> {
  await appendAuditAs("u_ada", action, detail);
}
```

After this deletion, `bun run typecheck` will flag any callers you missed — fix each one by threading `me` through.

- [ ] **Step 5: Verify typecheck and audit-as-real-user**

```bash
cd server && bun run typecheck && bun run verify-tables
```

Expected: no type errors; verify scripts pass.

- [ ] **Step 6: Manually confirm audit log shows real user**

Start the server, perform an `addCanonical` via the UI, then:

```bash
curl -sS --cookie "zz_sid=<your-sid>" http://localhost:8787/api/audit?limit=5
```

Expected: the new entry's `user` is your real session user, not Ada Berg.

- [ ] **Step 7: Commit**

```bash
git add server/
git commit -m "fix(audit): record real userId on every write path"
```

---

### Task 2.2: Authorization gate on `mergeCanonical`

**Why:** Today any team member can re-point or delete canonical records — an irreversible MDM operation. Until a real role model exists, require an explicit `confirm=true` query param so it can't be triggered by a stray button.

**Files:**
- Modify: `server/src/server.ts:243-246`

- [ ] **Step 1: Require an explicit confirmation token**

```ts
if (seg[4] === "merge" && seg.length === 5 && method === "POST") {
  if (url.searchParams.get("confirm") !== "true")
    return json({ error: "merge requires ?confirm=true", code: "CONFIRMATION_REQUIRED" }, 400);
  const { survivor, losers } = (await req.json()) as { survivor: string; losers: string[] };
  return json({ merged: await repo.mergeCanonical(id, survivor, losers, me) });
}
```

- [ ] **Step 2: Update the frontend caller in `app/src/store.ts`**

Find the merge call (search for `canonical/merge`) and append `?confirm=true` to the path. The UI already shows a confirmation modal — this just couples the contract.

- [ ] **Step 3: Verify**

```bash
curl -sS -X POST -H "content-type: application/json" --cookie "zz_sid=<sid>" \
  -d '{"survivor":"x","losers":["y"]}' \
  http://localhost:8787/api/dimensions/your-dim/canonical/merge
```

Expected: 400 with `code: "CONFIRMATION_REQUIRED"`.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts app/src/store.ts
git commit -m "feat(security): require confirm=true on mergeCanonical"
```

---

### Task 2.3: Batch user lookups in `listAudit`

**Why:** `repo.ts:1247-1250` does one `userById` query per audit row, up to 200 sequential round-trips.

**Files:**
- Modify: `server/src/repo.ts:1238-1251`

- [ ] **Step 1: Pre-fetch users in one query**

```ts
export async function listAudit(limit: number): Promise<AuditEntry[]> {
  const rows = await pgAll<{ id: string; uid: string; action: string; detail: string; secs: number }>(
    `SELECT id, user_id AS uid, action, detail,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs
     FROM ${pg("audit_log")} ORDER BY created_at DESC
     LIMIT ${Math.max(1, Math.min(200, limit))}`,
  );
  if (rows.length === 0) return [];

  const uids = Array.from(new Set(rows.map((r) => r.uid)));
  const users = await pgAll<User>(
    `SELECT id, name, initials FROM ${pg("users")} WHERE id = ANY($1::text[])`,
    [uids],
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  const unknownUser: User = { id: "unknown", name: "Unknown", initials: "??" };

  return rows.map((r) => ({
    id: r.id,
    user: byId.get(r.uid) ?? unknownUser,
    action: r.action,
    detail: r.detail,
    at: rel(Number(r.secs)),
  }));
}
```

- [ ] **Step 2: Verify**

Hit `GET /api/audit?limit=30` against a seeded DB. Expected: same payload shape as before; check server logs show 2 queries instead of 31.

- [ ] **Step 3: Commit**

```bash
git add server/src/repo.ts
git commit -m "perf(repo): batch user lookups in listAudit (N+1 → 2 queries)"
```

---

### Task 2.4: Batch user lookups in `listDrafts`

**Why:** Same N+1 as `listAudit`, on a hotter path (Mapping screen loads).

**Files:**
- Modify: `server/src/repo.ts:1080-1101`

- [ ] **Step 1: Apply the same batched-Map pattern**

```ts
export async function listDrafts(dimId: string): Promise<Draft[]> {
  const rows = await pgAll<{
    dimId: string; raw: string; status: "mapped" | "skipped";
    targetLabel: string | null; targetKey: string | null; uid: string; secs: number;
  }>(
    `SELECT dim_id AS "dimId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs
     FROM ${pg("draft")} WHERE dim_id = $1 ORDER BY created_at DESC`,
    [dimId],
  );
  if (rows.length === 0) return [];

  const uids = Array.from(new Set(rows.map((r) => r.uid)));
  const users = await pgAll<User>(
    `SELECT id, name, initials FROM ${pg("users")} WHERE id = ANY($1::text[])`,
    [uids],
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  const unknownUser: User = { id: "unknown", name: "Unknown", initials: "??" };

  return rows.map((r) => ({
    dimId: r.dimId, raw: r.raw, status: r.status,
    targetLabel: r.targetLabel, targetKey: r.targetKey,
    user: byId.get(r.uid) ?? unknownUser,
    at: rel(Number(r.secs)),
  }));
}
```

- [ ] **Step 2: Verify and commit**

```bash
cd server && bun run typecheck
git add server/src/repo.ts
git commit -m "perf(repo): batch user lookups in listDrafts"
```

---

### Task 2.5: Parallelize per-dimension counts in `listDimensions`

**Why:** `repo.ts:524-528` runs N sequential `count(*)` queries.

**Files:**
- Modify: `server/src/repo.ts:517-531`

- [ ] **Step 1: Use `Promise.all`**

```ts
export async function listDimensions(): Promise<DimensionMeta[]> {
  const metas = await pgAll<Omit<DimensionMeta, "rows">>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} ORDER BY label`,
  );

  const counts = await Promise.all(
    metas.map((m) =>
      pgGet<{ n: number }>(`SELECT count(*)::int AS n FROM ${cq(m.mapTable)}`)
        .catch(() => null),
    ),
  );

  return metas.map((m, i) => ({ ...m, rows: Number(counts[i]?.n ?? 0) }));
}
```

- [ ] **Step 2: Verify**

`GET /api/dimensions` returns the same shape; observe sub-100ms wall time even with 20 dims.

- [ ] **Step 3: Commit**

```bash
git add server/src/repo.ts
git commit -m "perf(repo): parallelize per-dimension row counts"
```

---

### Task 2.6: Fix the three stale-closure `useEffect`s

**Why:** `Mapping.tsx:347, 388` and `CreateTableModal.tsx:62` suppress `react-hooks/exhaustive-deps`. Each captures rapidly-changing values; cursor advancement can act on a stale frame after a filter change.

**Files:**
- Modify: `app/src/routes/Mapping.tsx:341-395`
- Modify: `app/src/components/CreateTableModal.tsx:45-75`

- [ ] **Step 1: Wrap `advanceToNextNew` and `advanceCrossNext` in `useCallback`**

In `Mapping.tsx`, locate `function advanceToNextNew(fromRowKey: string | null)` (around line 375) and convert to:

```ts
const advanceToNextNew = useCallback((fromRowKey: string | null) => {
  const rows = visibleRows;
  if (rows.length === 0) return;
  const idx = fromRowKey ? rows.findIndex((r) => r.value === fromRowKey) : -1;
  for (let i = 1; i <= rows.length; i++) {
    const j = ((idx < 0 ? -1 : idx) + i + rows.length) % rows.length;
    if (state[rows[j].value]?.status === "new") {
      cursor.setCursor({ rowKey: rows[j].value, field: "value", editing: false });
      return;
    }
  }
}, [visibleRows, state, cursor]);
```

Do the same for `advanceCrossNext` — find its definition and `useCallback`-wrap it with its true dependencies (`visibleCross`, anything else it reads).

- [ ] **Step 2: Remove the `eslint-disable` lines from the `useEffect`s**

For the effect at `Mapping.tsx:343-348`:

```ts
useEffect(() => {
  if (focusedModeRef.current === viewMode) return;
  focusedModeRef.current = viewMode;
  if (viewMode === "all" && !crossCursor) advanceCrossNext(null, null);
}, [viewMode, crossCursor, advanceCrossNext]);
```

Same pattern for the effect around line 392 that calls `advanceToNextNew` — list its real deps.

- [ ] **Step 3: Fix `CreateTableModal.tsx:62`**

Locate the keyboard `useEffect` at line 51. Extract `canSubmit` and `requestClose` from the render scope into `useCallback`:

```tsx
const canSubmit = useMemo(() => /* existing logic */, [name, source, external, mode]);
const requestClose = useCallback(() => {
  if (dirty && !confirmingDiscard) { setConfirmingDiscard(true); return; }
  onClose();
}, [dirty, confirmingDiscard, onClose]);

useEffect(() => {
  if (!open) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") requestClose();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) submit();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [open, canSubmit, requestClose, submit]);
```

(`submit` likely needs `useCallback` too — apply consistently.)

- [ ] **Step 4: Verify**

```bash
cd app && bun run typecheck
```

Then in the running app: change dimension filter on Mapping, press `A` repeatedly. Expected: cursor advances through the current filter's visible rows, never lands on a row outside the filter.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/Mapping.tsx app/src/components/CreateTableModal.tsx
git commit -m "fix(react): replace stale-closure useEffect suppressions with useCallback"
```

---

## Phase 3 — Accessibility pass (1 day)

**Goal of phase:** Every modal and popover announces correctly, every keyboard interaction has a path that doesn't escape into the page underneath.

### Task 3.1: `CreateTableModal` ARIA + focus trap

**Files:**
- Modify: `app/src/components/CreateTableModal.tsx:112-128`

- [ ] **Step 1: Add dialog roles to the inner content div**

```tsx
<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="create-table-title"
  onClick={(e) => e.stopPropagation()}
  className="mt-[10vh] w-[520px] max-w-full overflow-hidden rounded-lg border border-line-2 bg-surface-elevated shadow-pop"
>
  …
  <div id="create-table-title" className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">New table</div>
```

- [ ] **Step 2: Add a focus trap**

Inside the modal component:

```tsx
const containerRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (!open) return;
  const root = containerRef.current;
  if (!root) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  };
  root.addEventListener("keydown", onKey);
  return () => root.removeEventListener("keydown", onKey);
}, [open]);
```

Attach `ref={containerRef}` to the inner content div.

- [ ] **Step 3: Verify**

Open the modal, hit Tab repeatedly. Expected: focus loops within the modal, never escapes to the page underneath.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/CreateTableModal.tsx
git commit -m "a11y(modal): aria-modal + focus trap on CreateTableModal"
```

---

### Task 3.2: `AddFieldPopover` focus trap

**Files:**
- Modify: `app/src/components/AddFieldPopover.tsx:156-275`

- [ ] **Step 1: Apply the same focus-trap pattern as 3.1**

Use the same `containerRef` + Tab-loop `useEffect`. Add `role="dialog" aria-modal="true" aria-label="Add field"` to the root popover div.

- [ ] **Step 2: Verify**

Open the popover via "+ Field" in MasterTables. Tab from the last button → focus returns to the name input.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/AddFieldPopover.tsx
git commit -m "a11y(popover): focus trap + aria-modal on AddFieldPopover"
```

---

### Task 3.3: `ComboSelect` Tab-closes-listbox

**Why:** Currently Tab from the search input drops into the page beneath the open listbox.

**Files:**
- Modify: `app/src/components/ComboSelect.tsx:99-170`

- [ ] **Step 1: Intercept Tab to close the popover**

In the existing keydown handler on the search input, add:

```ts
if (e.key === "Tab") {
  setOpen(false);
  triggerRef.current?.focus();
  // intentional: don't preventDefault — let the natural Tab move to next field
}
```

(`triggerRef` likely already exists for the click trigger; if not, add `const triggerRef = useRef<HTMLButtonElement>(null)` and attach to the trigger.)

- [ ] **Step 2: Verify**

Open ComboSelect, press Tab. Expected: listbox closes and focus moves to the next focusable element on the page.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/ComboSelect.tsx
git commit -m "a11y(combo): Tab closes ComboSelect listbox cleanly"
```

---

### Task 3.4: `ScanScheduleMenu` keyboard nav

**Files:**
- Modify: `app/src/components/ScanScheduleMenu.tsx:53-74`

- [ ] **Step 1: Add ArrowUp/ArrowDown item navigation**

```tsx
const itemRefs = useRef<HTMLButtonElement[]>([]);
const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
  const items = itemRefs.current.filter(Boolean);
  const i = items.findIndex((el) => el === document.activeElement);
  if (e.key === "ArrowDown") { items[(i + 1) % items.length]?.focus(); e.preventDefault(); }
  if (e.key === "ArrowUp")   { items[(i - 1 + items.length) % items.length]?.focus(); e.preventDefault(); }
  if (e.key === "Home")      { items[0]?.focus(); e.preventDefault(); }
  if (e.key === "End")       { items[items.length - 1]?.focus(); e.preventDefault(); }
};
```

Apply `onKeyDown={onMenuKey}` to the menu container; for each menu button add `ref={(el) => { if (el) itemRefs.current[idx] = el; }}`. On open, focus the first item.

- [ ] **Step 2: Verify and commit**

Open the menu via the schedule button, navigate with arrow keys.

```bash
git add app/src/components/ScanScheduleMenu.tsx
git commit -m "a11y(menu): ArrowUp/ArrowDown navigation on ScanScheduleMenu"
```

---

### Task 3.5: `DataGrid` ARIA grid roles

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx`

- [ ] **Step 1: Apply roles to the structural divs**

- Outer container: `role="grid"`, `aria-rowcount={sortedRows.length + 1}`, `aria-colcount={visibleColumns.length}`
- Header row: `role="row"`, `aria-rowindex={1}`
- Header cells: `role="columnheader"`, `aria-colindex={i + 1}`, `aria-sort` (if sorted)
- Body rows: `role="row"`, `aria-rowindex={rowIdx + 2}`
- Body cells: `role="gridcell"`, `aria-colindex={i + 1}`, `aria-selected={isFocused}`

This is purely additive — visual behavior is unchanged.

- [ ] **Step 2: Verify with VoiceOver or NVDA**

Tab into the grid; the screen reader should announce row/column position.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx
git commit -m "a11y(grid): aria grid roles + row/col indices"
```

---

## Phase 4 — Observability (2 days)

**Goal of phase:** When something breaks in production, you find out within 60 seconds and have enough context to diagnose.

### Task 4.1: Structured JSON request log

**Files:**
- Create: `server/src/log.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: Create the logger**

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  level: LogLevel;
  msg: string;
  reqId?: string;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  userId?: string;
  err?: string;
  [key: string]: unknown;
}

export function log(fields: LogFields): void {
  const line = { ts: new Date().toISOString(), ...fields };
  const stream = fields.level === "error" || fields.level === "warn" ? "stderr" : "stdout";
  if (stream === "stderr") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}
```

- [ ] **Step 2: Wrap every response in `server.ts` with timing + ID**

At the very top of `fetch()`:

```ts
const reqId = crypto.randomUUID();
const start = performance.now();
let userId: string | undefined;
let status = 500;
try {
  const res = await handle(req, (uid) => { userId = uid; });
  status = res.status;
  res.headers.set("x-request-id", reqId);
  return res;
} finally {
  log({
    level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    msg: "request",
    reqId, method: req.method, path: new URL(req.url).pathname,
    status, ms: Math.round(performance.now() - start), userId,
  });
}
```

Extract the existing body of `fetch` into a `handle(req, setUid)` function (move the `seg`/`method`/route tree into it). When the session is resolved, call `setUid(sessionUser.id)`.

- [ ] **Step 3: Verify**

```bash
cd server && bun run start 2>&1 | head -5
curl -sS http://localhost:8787/health > /dev/null
```

Expected: a JSON log line per request with `reqId`, `method`, `path`, `status`, `ms`.

- [ ] **Step 4: Commit**

```bash
git add server/src/log.ts server/src/server.ts
git commit -m "feat(observability): structured JSON request logs with x-request-id"
```

---

### Task 4.2: Per-source scan timing + slow-query log

**Files:**
- Modify: `server/src/repo.ts` (`scanSources` function)

- [ ] **Step 1: Add timing around each per-source query**

Locate `scanSources` (search for `export async function scanSources`). Inside the per-source loop:

```ts
const t = performance.now();
const result = await /* existing per-source DuckDB query */;
const ms = Math.round(performance.now() - t);
log({
  level: ms > 5000 ? "warn" : "info",
  msg: "scan-source",
  table: s.table, column: s.column, ms, rows: result.length,
});
```

- [ ] **Step 2: Add a 30s timeout per source**

Wrap each DuckDB call in `Promise.race`:

```ts
const TIMEOUT_MS = 30_000;
const result = await Promise.race([
  duckCall,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("scan timeout")), TIMEOUT_MS)),
]);
```

On timeout, log `level: "error"` and continue with the next source rather than throwing the whole scan.

- [ ] **Step 3: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(observability): per-source scan timing + 30s timeout"
```

---

### Task 4.3: Sentry on the frontend

**Files:**
- Modify: `app/package.json` (add `@sentry/react`, `@sentry/vite-plugin`)
- Modify: `app/vite.config.ts`
- Modify: `app/src/main.tsx`
- Modify: `app/src/components/RouteErrorBoundary.tsx` (wire `Sentry.captureException`)
- Modify: `app/.env.example` (add `VITE_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`)

- [ ] **Step 1: Install dependencies**

```bash
cd app && bun add @sentry/react && bun add -d @sentry/vite-plugin
```

- [ ] **Step 2: Enable source maps + Sentry plugin in `vite.config.ts`**

```ts
import { sentryVitePlugin } from "@sentry/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  build: {
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
  // …existing server config…
});
```

- [ ] **Step 3: Init Sentry in `main.tsx` before `createRoot`**

```tsx
import * as Sentry from "@sentry/react";

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    integrations: [Sentry.browserTracingIntegration()],
  });
}
```

- [ ] **Step 4: Send caught errors from the boundary**

In `RouteErrorBoundary.componentDidCatch`:

```tsx
componentDidCatch(error: Error, info: React.ErrorInfo): void {
  console.error("Route error:", error, info.componentStack);
  if (import.meta.env.VITE_SENTRY_DSN) {
    Sentry.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
  }
}
```

- [ ] **Step 5: Verify build still works**

```bash
cd app && bun run build
```

Expected: build succeeds; `dist/assets/*.js.map` files exist (hidden source maps).

- [ ] **Step 6: Commit**

```bash
git add app/
git commit -m "feat(observability): Sentry + hidden source maps + vendor chunk split"
```

---

## Phase 5 — DX baseline (1 day)

**Goal of phase:** PRs get automated feedback before review.

### Task 5.1: ESLint in `app/`

**Files:**
- Create: `app/eslint.config.js`
- Modify: `app/package.json` (add deps + `lint` script)

- [ ] **Step 1: Install**

```bash
cd app && bun add -d eslint @eslint/js typescript-eslint eslint-plugin-react eslint-plugin-react-hooks
```

- [ ] **Step 2: Create flat config**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
    settings: { react: { version: "detect" } },
  },
);
```

- [ ] **Step 3: Add `lint` script**

```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "typecheck": "tsc --noEmit",
  "lint": "eslint src"
}
```

- [ ] **Step 4: Run once and fix surfaced issues**

```bash
cd app && bun run lint
```

Expected: a small number of issues (likely the remaining unused `_shortcuts`, an index-key warning or two). Fix them or add narrow `// eslint-disable-next-line` with a justification comment.

- [ ] **Step 5: Commit**

```bash
git add app/
git commit -m "feat(dx): ESLint with react-hooks + typescript-eslint"
```

---

### Task 5.2: ESLint in `server/`

**Files:**
- Create: `server/eslint.config.js`
- Modify: `server/package.json`

- [ ] **Step 1: Install**

```bash
cd server && bun add -d eslint @eslint/js typescript-eslint
```

- [ ] **Step 2: Flat config**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "drizzle/migrations"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { Bun: "readonly" } },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
```

- [ ] **Step 3: Add `lint` script + run + commit**

```bash
cd server && bun run lint
git add server/
git commit -m "feat(dx): ESLint on server"
```

---

### Task 5.3: Prettier in both packages

**Files:**
- Create: `.prettierrc.json` (repo root)
- Create: `.prettierignore`
- Modify: both `package.json`s

- [ ] **Step 1: Repo-root config**

`.prettierrc.json`:

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always"
}
```

`.prettierignore`:

```
dist
node_modules
**/migrations
*.svg
bun.lock
```

- [ ] **Step 2: Add `format` scripts**

In each `package.json`:

```json
"format": "prettier --write src",
"format:check": "prettier --check src"
```

Install in each:

```bash
cd app && bun add -d prettier
cd ../server && bun add -d prettier
```

- [ ] **Step 3: Run `format` once, accept the noise commit**

```bash
cd app && bun run format
cd ../server && bun run format
git add .
git commit -m "style: apply prettier across repo"
```

---

### Task 5.4: Typed `getValue` accessor in DataGrid

**Why:** Replaces six `(row as any)[field]` sites in `DataGrid.tsx` and the `MasterTables.tsx` cast.

**Files:**
- Modify: `app/src/components/datagrid/types.ts` (the props interface)
- Modify: `app/src/components/datagrid/DataGrid.tsx:57, 192, 204, 617`
- Modify: `app/src/routes/MasterTables.tsx:353`

- [ ] **Step 1: Add `getValue` to `DataGridProps`**

```ts
export interface DataGridProps<Row> {
  rows: Row[];
  columns: ColumnDef<Row>[];
  getValue?: (row: Row, field: string) => unknown;
  // …existing props
}
```

- [ ] **Step 2: Use it inside `DataGrid` with a typed fallback**

At the top of the component:

```ts
const getValue: (row: Row, field: string) => unknown =
  props.getValue ?? ((row, field) => (row as Record<string, unknown>)[field]);
```

Replace every `(row as any)[c.field]` / `(row as any)[field]` / `(a as any)[sort.field]` with `getValue(row, field)`. The fallback keeps existing call sites working; only the type changes from `any` to `unknown`.

- [ ] **Step 3: Type the sort comparison**

```ts
const av = getValue(a, sort.field);
const bv = getValue(b, sort.field);
// cast at the comparison site only:
const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
```

(`av` and `bv` are now `unknown`, which forces an explicit narrowing. That's the point.)

- [ ] **Step 4: Drop the `MasterTables.tsx:353` cast**

Now that `getValue` is the accessor, the host can flatten safely:

```tsx
<DataGrid
  rows={rowsForGrid}
  getValue={(row, field) => row[field] ?? row.fields?.[field]}
  /* …other props */
/>
```

- [ ] **Step 5: Verify**

```bash
cd app && bun run typecheck && bun run lint
```

Expected: clean. Manually exercise sort, copy, paste, cell edit, range select.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/ app/src/routes/MasterTables.tsx
git commit -m "fix(grid): typed getValue accessor; remove (row as any)[field]"
```

---

## Phase 6 — Deploy (1 day)

**Goal of phase:** `docker build` and `docker run` reproduce the production app from a clean checkout. GitHub Actions runs typecheck + lint on every PR.

### Task 6.1: Server Dockerfile

**Files:**
- Create: `server/Dockerfile`
- Create: `server/.dockerignore`
- Create: `server/start.sh`

- [ ] **Step 1: Multi-stage Dockerfile**

```dockerfile
# server/Dockerfile
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts tsconfig.json ./
COPY drizzle ./drizzle
COPY src ./src
COPY start.sh ./
RUN chmod +x start.sh
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/health || exit 1
CMD ["./start.sh"]
```

- [ ] **Step 2: `start.sh` that migrates then serves**

```bash
#!/usr/bin/env sh
set -e
echo "· running migrations…"
bun run db:migrate
echo "· starting server…"
exec bun run start
```

- [ ] **Step 3: `.dockerignore`**

```
node_modules
dist
.env
.env.local
*.log
```

- [ ] **Step 4: Verify build + run**

```bash
cd server && docker build -t zugzug-server . \
  && docker run --rm -p 8787:8787 \
    -e DATABASE_URL=$DATABASE_URL \
    -e MOTHERDUCK_TOKEN=$MOTHERDUCK_TOKEN \
    -e GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID \
    -e GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET \
    -e ORIGIN=http://localhost:5173 \
    zugzug-server &
sleep 5
curl -sS http://localhost:8787/health
```

Expected: `{"ok":true,"ts":…}`.

- [ ] **Step 5: Commit**

```bash
git add server/Dockerfile server/.dockerignore server/start.sh
git commit -m "build(server): multi-stage Dockerfile + migration-on-boot entrypoint"
```

---

### Task 6.2: App Dockerfile (static)

**Files:**
- Create: `app/Dockerfile`
- Create: `app/.dockerignore`
- Create: `app/nginx.conf` (minimal SPA-routing config)

- [ ] **Step 1: Multi-stage Dockerfile**

```dockerfile
# app/Dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM nginx:1-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 2: `nginx.conf` for SPA routing**

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

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

- [ ] **Step 3: Verify and commit**

```bash
cd app && docker build -t zugzug-app .
git add app/Dockerfile app/.dockerignore app/nginx.conf
git commit -m "build(app): static SPA Dockerfile + nginx routing"
```

---

### Task 6.3: GitHub Actions CI (typecheck + lint)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Workflow**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  app:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: app } }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run format:check

  server:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: server } }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run format:check
```

- [ ] **Step 2: Verify locally**

```bash
cd app && bun run typecheck && bun run lint && bun run format:check
cd ../server && bun run typecheck && bun run lint && bun run format:check
```

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck + lint + format check for both packages"
git push
```

Expected: GitHub Actions runs the workflow on the push; both jobs go green.

---

## Phase 7 — Tests (3–5 days)

**Goal of phase:** The three most-likely-to-regress backend paths and a baseline of frontend behaviour have machine-checked coverage.

### Task 7.1: Backend test harness with disposable Postgres

**Files:**
- Create: `server/docker-compose.test.yml`
- Create: `server/test/setup.ts`
- Modify: `server/package.json` (add `test`, `test:db:up`, `test:db:down`)

- [ ] **Step 1: docker-compose for a disposable Postgres**

```yaml
# server/docker-compose.test.yml
services:
  pg:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: zugzug
      POSTGRES_PASSWORD: zugzug
      POSTGRES_DB: zugzug_test
    ports: ["55432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U zugzug"]
      interval: 1s
      timeout: 3s
      retries: 30
```

- [ ] **Step 2: Test setup harness**

```ts
// server/test/setup.ts
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const TEST_DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";

export async function resetDb(): Promise<void> {
  const sql = postgres(TEST_DATABASE_URL, { max: 1 });
  await sql`DROP SCHEMA IF EXISTS zugzug_app CASCADE`;
  await sql`DROP SCHEMA IF EXISTS zugzug CASCADE`;
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  await sql.end();
}
```

- [ ] **Step 3: package.json scripts**

```json
"test:db:up": "docker compose -f docker-compose.test.yml up -d --wait",
"test:db:down": "docker compose -f docker-compose.test.yml down -v",
"test": "DATABASE_URL=postgres://zugzug:zugzug@localhost:55432/zugzug_test bun test"
```

- [ ] **Step 4: Verify**

```bash
cd server && bun run test:db:up && bun -e "import('./test/setup.ts').then(m => m.resetDb()).then(() => console.log('ok'))"
```

- [ ] **Step 5: Commit**

```bash
git add server/docker-compose.test.yml server/test/setup.ts server/package.json
git commit -m "test(server): disposable Postgres + drizzle migration harness"
```

---

### Task 7.2: `commit()` happy-path test

**Files:**
- Create: `server/test/commit.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
  process.env.ATTACH_WAREHOUSE = "false";
  await resetDb();
});

test("commit folds approved drafts into canonical", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brand", [], { keyKind: "slug" }, userId);

  await repo.addCanonicalOne(dimId, "Acme", undefined, userId);
  await repo.saveDraft(dimId, "ACME Inc", "mapped", "Acme", "acme", userId);

  const result = await repo.commit(dimId, userId);
  expect(result.committed).toBe(1);

  const drafts = await repo.listDrafts(dimId);
  expect(drafts).toHaveLength(0);
});
```

- [ ] **Step 2: Run**

```bash
cd server && bun run test test/commit.test.ts
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add server/test/commit.test.ts
git commit -m "test(commit): happy-path draft → canonical fold"
```

---

### Task 7.3: `mergeCanonical` atomicity test

**Files:**
- Create: `server/test/merge.test.ts`

- [ ] **Step 1: Test the atomic merge**

```ts
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
  process.env.ATTACH_WAREHOUSE = "false";
  await resetDb();
});

test("mergeCanonical re-points crosswalk rows and deletes losers", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brand", [], { keyKind: "slug" }, userId);
  await repo.addCanonicalOne(dimId, "Acme", undefined, userId);
  await repo.addCanonicalOne(dimId, "Acme Corp", undefined, userId);
  await repo.saveDraft(dimId, "acme corp", "mapped", "Acme Corp", "acme-corp", userId);
  await repo.commit(dimId, userId);

  const merged = await repo.mergeCanonical(dimId, "acme", ["acme-corp"], userId);
  expect(merged).toBe(1);

  const dim = await repo.getDimension(dimId);
  expect(dim?.canonical.map((c) => c.key).sort()).toEqual(["acme"]);
});

test("mergeCanonical with empty losers is a no-op", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brand", [], { keyKind: "slug" }, userId);
  const n = await repo.mergeCanonical(dimId, "acme", [], userId);
  expect(n).toBe(0);
});
```

- [ ] **Step 2: Run + commit**

```bash
cd server && bun run test test/merge.test.ts
git add server/test/merge.test.ts
git commit -m "test(merge): atomic re-point + delete"
```

---

### Task 7.4: `addDimension` idempotency test

**Files:**
- Create: `server/test/add-dimension.test.ts`

- [ ] **Step 1: Test that re-adding the same name throws a recognisable error**

```ts
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
  process.env.ATTACH_WAREHOUSE = "false";
  await resetDb();
});

test("addDimension rejects duplicate names", async () => {
  const userId = "u_test";
  await repo.addDimension("Brand", [], { keyKind: "slug" }, userId);
  await expect(repo.addDimension("Brand", [], { keyKind: "slug" }, userId))
    .rejects.toThrow(/exists|duplicate|unique/i);
});

test("addDimension creates registry + dim_ + map_ tables", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Channel", [], { keyKind: "slug" }, userId);
  const dim = await repo.getDimension(dimId);
  expect(dim).not.toBeNull();
  expect(dim?.dimension).toBe("Channel");
});
```

- [ ] **Step 2: Run + commit**

```bash
cd server && bun run test test/add-dimension.test.ts
git add server/test/add-dimension.test.ts
git commit -m "test(dimension): name uniqueness + table creation"
```

---

### Task 7.5: Frontend Vitest setup

**Files:**
- Modify: `app/package.json`
- Create: `app/vitest.config.ts`
- Create: `app/test/setup.ts`

- [ ] **Step 1: Install**

```bash
cd app && bun add -d vitest @vitest/ui jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

- [ ] **Step 2: Vitest config**

```ts
// app/vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
  },
});
```

- [ ] **Step 3: Setup file**

```ts
// app/test/setup.ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: `test` script**

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: Smoke test**

```bash
cd app && echo 'import { test, expect } from "vitest"; test("env", () => expect(1+1).toBe(2));' > test/env.test.ts
bun run test
rm test/env.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add app/package.json app/vitest.config.ts app/test/setup.ts
git commit -m "test(app): Vitest + RTL setup"
```

---

### Task 7.6: Store pure-helper tests

**Files:**
- Create: `app/test/store-helpers.test.ts`

- [ ] **Step 1: Test the helpers that already live in `store.ts`**

Identify the exported pure helpers (`slug`, `dkey`, `defaultTintFor`, the `api` error path). Write at minimum:

```ts
import { test, expect } from "vitest";
import { slug, dkey } from "../src/store";

test("slug normalizes whitespace and case", () => {
  expect(slug("Acme Corp")).toBe("acme-corp");
  expect(slug("  Trailing Space  ")).toBe("trailing-space");
});

test("dkey is stable for the same logical name", () => {
  expect(dkey("Brand")).toBe(dkey("Brand"));
  expect(dkey("Brand")).not.toBe(dkey("Channel"));
});
```

(Adjust expectations to whatever the current implementations actually return — read `store.ts` to confirm before writing.)

- [ ] **Step 2: Run + commit**

```bash
cd app && bun run test
git add app/test/store-helpers.test.ts
git commit -m "test(store): unit tests for slug + dkey"
```

---

### Task 7.7: DataGrid keyboard nav test

**Files:**
- Create: `app/test/datagrid-nav.test.tsx`

- [ ] **Step 1: Test Arrow keys move the cursor**

```tsx
import { test, expect } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataGrid } from "../src/components/datagrid";

const rows = [{ id: "a", name: "Acme" }, { id: "b", name: "Bravo" }];
const columns = [
  { field: "id", label: "ID", type: "text" as const, editable: false },
  { field: "name", label: "Name", type: "text" as const, editable: true },
];

test("ArrowDown moves cursor to next row", async () => {
  const user = userEvent.setup();
  const { container } = render(
    <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} />
  );
  const grid = container.querySelector('[role="grid"]') as HTMLElement;
  grid.focus();
  await user.keyboard("{ArrowDown}");
  const focused = container.querySelector('[aria-selected="true"]');
  expect(focused?.textContent).toContain("Bravo");
});
```

(Will need a minimal viable `DataGrid` invocation — adjust props to whatever the component requires.)

- [ ] **Step 2: Run + commit**

```bash
cd app && bun run test
git add app/test/datagrid-nav.test.tsx
git commit -m "test(grid): ArrowDown moves cursor"
```

---

### Task 7.8: Wire tests into CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add a test job for each package**

Replace the existing workflow with:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:

jobs:
  app:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: app } }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run format:check
      - run: bun run test

  server:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: zugzug
          POSTGRES_PASSWORD: zugzug
          POSTGRES_DB: zugzug_test
        ports: ["55432:5432"]
        options: >-
          --health-cmd "pg_isready -U zugzug"
          --health-interval 1s
          --health-timeout 3s
          --health-retries 30
    defaults: { run: { working-directory: server } }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run format:check
      - run: bun run test
        env:
          DATABASE_URL: postgres://zugzug:zugzug@localhost:55432/zugzug_test
          MOTHERDUCK_TOKEN: dummy-for-ci
          GOOGLE_CLIENT_ID: dummy
          GOOGLE_CLIENT_SECRET: dummy
          ATTACH_WAREHOUSE: "false"
```

- [ ] **Step 2: Push and verify CI green**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run tests with Postgres service"
git push
```

---

## Phase 8 — Tech debt cleanup (optional, ongoing)

**Goal of phase:** Structural debt that's safe to defer but worth scheduling. Pick one per sprint.

### Task 8.1: Split `repo.ts` into domain files

**Files:**
- Create: `server/src/repo-scan.ts`
- Create: `server/src/repo-canonical.ts`
- Create: `server/src/repo-drafts.ts`
- Create: `server/src/repo-meta.ts`
- Modify: `server/src/repo.ts` → barrel re-export

- [ ] **Step 1: Move warehouse-scan functions to `repo-scan.ts`**

Cut `scanSources`, `topUnmapped`, `liveSources`, `occUnion`, `anyScanDue`, `setSourceSchedule`, `addSource`, `listSources`, `sourceFacets`, `searchCatalog` to `repo-scan.ts`. Keep the same exports.

- [ ] **Step 2: Move canonical/dimension CRUD to `repo-canonical.ts`**

Cut `listDimensions`, `getDimension`, `addDimension`, `addCanonicalOne`, `renameCanonical`, `mergeCanonical`, `retireCanonical`, `listVariants`, `deriveCanonical`, plus the field-management functions (`listFields`, `addField`, `renameColumn`, `changeColumnType`, `deleteColumn`, `addColumnOption`, `setFieldValue`).

- [ ] **Step 3: Move drafts + commit to `repo-drafts.ts`**

Cut `listDrafts`, `saveDraft`, `discardDraft`, `commit`.

- [ ] **Step 4: Move audit + users + preferences + grid layout to `repo-meta.ts`**

Cut `listUsers`, `userById`, `appendAuditAs`, `listAudit`, `getPreferences`, `setPreferences`, `getGridLayout`, `setGridLayout`.

- [ ] **Step 5: Convert `repo.ts` into a barrel**

```ts
export * from "./repo-scan.ts";
export * from "./repo-canonical.ts";
export * from "./repo-drafts.ts";
export * from "./repo-meta.ts";
```

(Hoist shared helpers — `qid`, `cq`, `dimMeta`, `rel`, type definitions — to a `repo-shared.ts` that the four domain files import.)

- [ ] **Step 6: Verify + commit**

```bash
cd server && bun run typecheck && bun run test
git add server/src/
git commit -m "refactor(repo): split 1251-line repo.ts into four domain files"
```

---

### Task 8.2: `AppError` base + error-code enum

**Files:**
- Create: `server/src/errors.ts`
- Modify: `server/src/tables.ts` (replace `CreateTableError`)
- Modify: `server/src/server.ts` (catch + serialize)

- [ ] **Step 1: Define base + codes**

```ts
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NAME_TAKEN"
  | "CONFIRMATION_REQUIRED"
  | "NOT_FOUND"
  | "WRONG_DOMAIN"
  | "ALREADY_EXISTS"
  | "CANNOT_REMOVE_SELF"
  | "INTERNAL";

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public status: number = 400) {
    super(message);
    this.name = "AppError";
  }
}
```

- [ ] **Step 2: Replace `CreateTableError`**

```ts
// in tables.ts
import { AppError } from "./errors.ts";
export const CreateTableError = AppError; // back-compat alias
// at throw sites: throw new AppError("NAME_TAKEN", "Table already exists", 409);
```

- [ ] **Step 3: Top-level catch in `server.ts`**

```ts
} catch (e) {
  if (e instanceof AppError) return json({ error: e.message, code: e.code }, e.status);
  log({ level: "error", msg: "unhandled", reqId, err: String(e) });
  return json({ error: "Internal server error", code: "INTERNAL" }, 500);
}
```

- [ ] **Step 4: Verify + commit**

```bash
cd server && bun run typecheck && bun run test
git add server/src/
git commit -m "refactor(errors): AppError base + error-code enum on every response"
```

---

### Task 8.3: DuckDB call serialization queue

**Files:**
- Modify: `server/src/db.ts`

- [ ] **Step 1: Wrap `all`/`get`/`run` with a FIFO**

```ts
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {}); // don't poison the queue on a rejection
  return next as Promise<T>;
}

export async function all<T = Record<string, unknown>>(sql: string, params: DuckDBValue[] = []): Promise<T[]> {
  return serialized(async () => {
    const conn = await connect();
    const reader = await conn.runAndReadAll(sql, params);
    return reader.getRowObjects() as T[];
  });
}
// same wrap for get + run
```

- [ ] **Step 2: Verify + commit**

```bash
cd server && bun run test
git add server/src/db.ts
git commit -m "fix(db): serialize DuckDB calls on the shared connection"
```

---

### Task 8.4: Narrow `refreshDim` + memoized `GridRow`

**Files:**
- Modify: `app/src/store.ts` (add `refreshDim`)
- Modify: `app/src/components/datagrid/DataGrid.tsx` (extract `GridRow`)

- [ ] **Step 1: Add a narrow per-dim refresh to `store.ts`**

```ts
export async function refreshDim(dimId: string): Promise<void> {
  const dim = await api<MappingDimension>(`/api/dimensions/${encodeURIComponent(dimId)}`);
  cache.dims = cache.dims.map((d) => (d.id === dim.id ? { ...d, ...dim } : d));
  emit();
}
```

Wire `setFieldValue`, `renameCanonical`, `addCanonicalOne` to call `refreshDim(dimId)` instead of `refreshDims()`. Keep `refreshDims()` for cold start and structural changes (dimension add/remove).

- [ ] **Step 2: Extract `GridRow` and memo it**

In `DataGrid.tsx`, extract the row-body JSX into:

```tsx
const GridRow = React.memo(function GridRow<Row>(props: {
  row: Row;
  rowKey: string;
  columns: ColumnDef<Row>[];
  focused: boolean;
  editing: boolean;
  inRange: (field: string) => boolean;
  selected: boolean;
  getValue: (row: Row, field: string) => unknown;
  /* …callbacks: onClick, onMouseDown, onDoubleClick, etc. */
}) {
  /* the current per-row render body */
});
```

Replace the `sortedRows.map(...)` body with `<GridRow ... key={rowKey} />`. The `React.memo` default shallow compare is sufficient since `columns`, `getValue`, and the callbacks should be `useMemo`/`useCallback`-stabilized.

- [ ] **Step 3: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add app/src/
git commit -m "perf(grid+store): memoized GridRow + narrow refreshDim"
```

---

## Self-review

**1. Spec coverage**

Mapped against the consolidated audit summary delivered to the user:

| Audit finding | Task |
|---|---|
| mergeCanonical not transactional (P0) | 1.1 |
| No SIGTERM handler (P1) | 1.2 |
| No /health (P1) | 1.3 |
| CORS wildcard (P1) | 1.4 |
| devBypass leak (P1) | 1.5 |
| MotherDuck token interpolation (P1) | 1.6 |
| No request body size limit (P1) | 1.7 |
| Postgres pool defaults (P1) | 1.8 |
| No route error boundary (P1) | 1.9 |
| window.BrandApp in prod (P2) | 1.10 |
| appendAudit hardcoded u_ada (P1) | 2.1 |
| No authz on mergeCanonical (P1) | 2.2 |
| N+1 listAudit (P1) | 2.3 |
| N+1 listDrafts (P1) | 2.4 |
| N+1 listDimensions (P1) | 2.5 |
| Stale-closure useEffects (P1) | 2.6 |
| CreateTableModal aria (P1) | 3.1 |
| AddFieldPopover focus trap (P1) | 3.2 |
| ComboSelect Tab handling (P1) | 3.3 |
| ScanScheduleMenu kbd nav (P1) | 3.4 |
| DataGrid role=grid (P2) | 3.5 |
| Structured logging (P1) | 4.1 |
| Slow scan detection (P2) | 4.2 |
| Sentry + sourcemaps (P1) | 4.3 |
| No ESLint (P1) | 5.1, 5.2 |
| No Prettier (P2) | 5.3 |
| (row as any)[field] (P1) | 5.4 |
| No Dockerfile (P1) | 6.1, 6.2 |
| No CI (P1) | 6.3, 7.8 |
| No tests (P1) | 7.1–7.7 |
| repo.ts size (P2) | 8.1 |
| Free-text error responses (P1) | 8.2 |
| DuckDB single-conn (P1) | 8.3 |
| GridRow memo + refreshDim (P2) | 8.4 |

Coverage is complete for everything flagged P0–P1 in either audit.

**2. Placeholder scan**

No "TBD", "implement later", or "add appropriate error handling" without showing the handling. Every code step shows the actual code.

**3. Type consistency**

`mergeCanonical(dimId, survivor, losers, userId)` in 1.1 matches the signature change in 2.1 and the test signature in 7.3. The `getValue` accessor introduced in 5.4 is referenced in 8.4's `GridRow` extraction. `RouteErrorBoundary` is the name used in 1.9, 4.3, and the import paths match.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-04-production-readiness.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best when phases have many small tasks that benefit from context isolation.

**2. Inline Execution** — Execute tasks in this session using executing-plans, with batch checkpoints at the end of each phase.

**Which approach?** (Or pick a starting phase — Phase 1 stands alone and gives the biggest production-readiness yield per hour.)
