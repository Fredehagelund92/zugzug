# Multi-tenant (workspaces) — design

**Status:** approved (brainstorming complete 2026-06-07)
**Scope:** phase 1 only. Phase 2 (roles) and phase 3 (per-tenant warehouses) are separate specs.
**Supersedes:** scope of GitHub epic #36 — child issues #28/#29/#31/#32 are absorbed into phase 2; #30 (parse Google `hd`) stays standalone.

## Goal

Add multi-tenancy to Zugzug so Better Collective's internal sub-teams (Sportsbook, iGaming, Affiliates, etc.) each get an isolated workspace within the same deployment. Existing data becomes a single `default` tenant.

Out of scope for this spec: per-tenant roles (every member is admin in phase 1), per-tenant warehouses (`tenant.warehouse_id` column ships but only points at the shared default), self-serve provisioning (super-admin CLI only), tenant export, SSO/SAML, per-dimension ACLs.

## Decisions locked during brainstorming

1. **Tenant = internal sub-team** (not external org, not Google domain).
2. **Shared warehouse** for now. `tenant.warehouse_id` exists from day one so per-tenant tokens are a future config change, not a migration.
3. **Multi-membership:** one user → many tenants. Workspace switcher in topbar.
4. **Row-level isolation** with `tenant_id` column on every app-state and canonical row. Single Postgres schema.
5. **Tenant in URL path** (`/app/:tenantSlug/...`). Server route `/api/t/:tenantSlug/*` is authoritative; no header.
6. **Super-admin provisioning** via CLI only in phase 1. First tenant `default` seeded at migration time, all existing data backfilled into it.
7. **Per-tenant invite by email.** Drops `allowed_emails`. Adds `tenant_invite` for not-yet-registered emails.
8. **Phase 1 ships with a single hardcoded `'admin'` role** on every `tenant_member`. Phase 2 (separate spec, absorbing #36) adds admin/editor/viewer with gating and the Team settings UI.

## Architecture

The three-store model (Warehouse / Canonical / App state) is unchanged. Multi-tenancy is a scope column on every app-state row plus three new tables.

```
Identity (global)
  users · sessions · users.is_super_admin
       │
       │ membership (many-to-many, role per tenant)
       ▼
Tenant (the workspace boundary)
  tenant · tenant_member · tenant_invite
       │
       │ owns
       ▼
Tenant-scoped app state (all gain tenant_id)
  dimension · dimension_source · dimension_field · source_stat
  draft · audit_log · preferences · active_sessions · ai_hint_cache
  dim_<tenant>_<slug> / map_<tenant>_<slug>  (canonical rows)
```

**Query rule:** every Postgres query touching scoped tables runs inside a transaction that began with `SET LOCAL app.tenant_id = $1`. A `TenantRepo` class wraps `repo-*.ts` modules and is the only public surface; the un-tenanted free functions are unexported. RLS is the backstop (deferred to phase 1.5 — see Migration).

## Data model

### New tables

```sql
CREATE TABLE zugzug_app.tenant (
  id           VARCHAR PRIMARY KEY,           -- 'sportsbook'
  slug         VARCHAR NOT NULL UNIQUE,       -- URL segment; equal to id in phase 1
  label        VARCHAR NOT NULL,              -- 'Sportsbook'
  warehouse_id VARCHAR NOT NULL,              -- 'default' for now
  created_at   TIMESTAMP NOT NULL,
  deleted_at   TIMESTAMP                      -- soft delete; teardown function handles hard cleanup
);

CREATE TABLE zugzug_app.tenant_member (
  tenant_id  VARCHAR NOT NULL REFERENCES zugzug_app.tenant(id),
  user_id    VARCHAR NOT NULL REFERENCES zugzug_app.users(id),
  role       VARCHAR NOT NULL,                -- always 'admin' in phase 1
  created_at TIMESTAMP NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX tenant_member_user_idx ON zugzug_app.tenant_member(user_id);

CREATE TABLE zugzug_app.tenant_invite (
  tenant_id  VARCHAR NOT NULL REFERENCES zugzug_app.tenant(id),
  email      VARCHAR NOT NULL,
  role       VARCHAR NOT NULL,                -- always 'admin' in phase 1
  invited_by VARCHAR NOT NULL,
  invited_at TIMESTAMP NOT NULL,
  PRIMARY KEY (tenant_id, email)
);
CREATE INDEX tenant_invite_email_idx ON zugzug_app.tenant_invite(email);
```

### Tables that gain `tenant_id`

| Table | New PK | Notes |
|---|---|---|
| `dimension` | `(tenant_id, id)` | Composite PK. `id` stays `'country'` etc; no rewrite. |
| `dimension_source` | `(tenant_id, dim_id, source_table, source_column)` | |
| `dimension_field` | `(tenant_id, dim_id, field)` | |
| `source_stat` | `(tenant_id, dim_id, source_table, source_column)` | |
| `draft` | `(tenant_id, dim_id, raw, user_id)` | |
| `audit_log` | unchanged (`id` PK) | Add index `(tenant_id, created_at DESC)` for feeds. |
| `preferences` | `(tenant_id)` | Was singleton `id = 1`. |
| `active_sessions` | `(tenant_id, user_id)` | A user in two tabs across two tenants = two presence rows. |
| `ai_hint_cache` | `(tenant_id, dim_id, raw)` | Per-tenant cache (privacy over cost). |

Composite PKs replace the single-column ones above where natural. `dimension.id` stays a string; child tables reference `(tenant_id, dim_id)` via app-level lookups (no real FK constraint — matches today's pattern).

### Tables that stay global (no `tenant_id`)

- `users` — one Google identity = one row. Email/`google_sub` unique indexes stay valid.
- `sessions` — auth is global; the workspace lives in the URL.
- `user_grid_layout` — per-user-per-dim. `dim_id` is unambiguous because dims are tenant-scoped.

### Dropped

- `allowed_emails` — replaced by `tenant_member ∪ tenant_invite`. First-login rule: signed-in iff at least one `tenant_member` row OR `tenant_invite` row matches the email.

### Dynamic `dim_*` / `map_*` tables

Naming changes to `dim_${tenantId}_${slug}` and `map_${tenantId}_${slug}`. `addDimension(tenantId, ...)` generates them. The fully-qualified string lives in `dimension.dim_table` / `map_table` so downstream `repo-canonical.ts` code is data-driven and unchanged.

Each dynamic table also gets `tenant_id NOT NULL DEFAULT '<tenant>'` so RLS (when enabled) covers them too.

### Super-admin

`ALTER TABLE users ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT false`. Flag flipped by CLI. Super-admin bypasses the `tenant_member` check, can call `provisionTenant()`/`teardownTenant()`, can read the cross-tenant audit feed, and can impersonate a tenant for debugging (sets `app.tenant_id = '<target>'` for that session with an audit log entry).

## Auth & request lifecycle

```
1. Cookie session  → user_id                                (existing)
2. URL /api/t/:slug/...                                     (or /api/admin/* for super-admin)
3. Middleware:
     resolve slug → tenant_id
     verify tenant_member(user_id, tenant_id) OR is_super_admin
     open Postgres tx, SET LOCAL app.tenant_id = '<id>' (or '*' for super-admin)
     construct req.repo = new TenantRepo(tenantId, role, pgConn)
4. Route handler runs; req.repo is the only DB surface
5. Commit tx, release conn
```

A `withTenantTx(req, async (repo) => { ... })` helper wraps step 3–5 and is **mandatory** for any tenant route. Raw `pg.query` is banned inside route handlers (RLS would silently leak otherwise with transaction-mode pooling).

### TenantRepo

A class instantiated per request, holding `{tenantId, role, pg}`. Wraps the previously-free repo functions. Mutation methods call `this.assertRole('admin')` (no-op in phase 1; gating in phase 2). The current free functions in `repo.ts`, `repo-canonical.ts`, `repo-drafts.ts`, `repo-meta.ts`, `repo-scan.ts`, `repo-shared.ts`, `repo-ai-hint.ts` become module-private. The scheduler (which legitimately needs un-tenanted access) iterates tenants and calls a module-private path per tenant with an explicit `SET LOCAL`.

### Sign-in flow

```
POST /api/auth/google/callback
  verify ID token → email + google_sub
  upsert users row (global; unchanged)
  IF tenant_member rows exist for user_id → success
  ELIF tenant_invite rows exist for email:
       in one tx: INSERT tenant_member SELECT … FROM tenant_invite WHERE email = $1
                  DELETE FROM tenant_invite WHERE email = $1 RETURNING *
       (DELETE RETURNING handles concurrent acceptors atomically)
  ELSE → 403 "no workspaces"
  redirect:
    /app/<active_sessions.tenant_id>  if recent
    /app/<first membership slug>      otherwise
    /app/admin                        if super-admin with no memberships
```

### Super-admin routes

All under `/api/admin/*` guarded by `is_super_admin`. Never reachable via `/api/t/:slug/*`.

- `POST /api/admin/tenants` — provision
- `GET  /api/admin/tenants` — list
- `GET  /api/admin/audit?tenant_id=…&limit=…` — cross-tenant feed (sets `app.tenant_id = '*'`)
- `POST /api/admin/tenants/:id/teardown` — invokes the stored teardown function
- `POST /api/admin/impersonate/:tenant_id` — sets a session flag so subsequent `/api/t/:slug/*` requests succeed without membership (audit logged)

## Frontend

### Routes

```
/login                              public
/app                                redirect → /app/<last-or-first-tenant>
/app/admin                          super-admin shell (tenant CRUD, cross-tenant audit)
/app/:tenantSlug/                   dashboard
/app/:tenantSlug/triage
/app/:tenantSlug/sources
/app/:tenantSlug/tables/:dimId
/app/:tenantSlug/settings
```

`<TenantLayout>` at `/app/:tenantSlug` validates the slug against memberships on mount, calls `setCurrentTenant(slug)`, loads tenant metadata into a context, 403/redirects on mismatch.

`useTenant() → {id, slug, label, role}` is the hook.

### `apiFetch` (module-level function, not a hook)

```ts
// app/src/api.ts
export let currentTenantSlug = "";
export function setCurrentTenant(slug: string) { currentTenantSlug = slug; }

export async function apiFetch(path: string, init?: RequestInit) {
  const url = path.startsWith("/admin/")
    ? `/api${path}`
    : `/api/t/${currentTenantSlug}${path}`;
  return fetch(url, init);
}
```

Module-level (not hook) matches the existing `store.ts` pattern — `store.ts`'s async functions can't call hooks. `TenantLayout`'s mount effect sets the slug before any data fetching occurs.

### ESLint rule (no plugin needed)

```js
"no-restricted-syntax": ["error",
  {
    selector: "CallExpression[callee.name='fetch'][arguments.0.type='Literal'][arguments.0.value=/^\\/api/]",
    message: "Use apiFetch() — raw fetch bypasses tenant routing.",
  },
  {
    selector: "CallExpression[callee.name='fetch'][arguments.0.type='TemplateLiteral']",
    message: "Use apiFetch() — raw fetch bypasses tenant routing.",
  },
]
```

Exemptions for `auth/me`, `auth/logout`, `auth/dev` (no tenant context) get inline `eslint-disable-next-line` with a reason. `createTable` in `store.ts` (currently bypasses `api()` for error shape) gets migrated to `api()` as part of this work.

### Workspace switcher

Topbar dropdown listing the user's memberships. On click:

1. Validate `dim_id` in current path against target tenant's dims. If mismatch → strip `dim_id`, navigate to `/app/<targetSlug>/tables`, toast "table doesn't exist here". Otherwise navigate to `/app/<targetSlug>/<currentSubpath>`.
2. Call `onTenantSwitch()`:
   - Increment `switchGen` counter (in store.ts).
   - Cancel all pending debounced timers (`setGridLayout`'s 400ms flush, any others).
   - Reset module-level store state (`dims`, `sources`, etc.).
3. `setCurrentTenant(newSlug)`.
4. Re-run `initStore()` under the new slug.

### Switch-generation counter (race fix)

```ts
let switchGen = 0;
export function onTenantSwitch() { switchGen++; resetStore(); cancelTimers(); }

async function refreshDims(): Promise<void> {
  const gen = switchGen;
  const data = await apiFetch("/dimensions?full=true").then(r => r.json());
  if (gen !== switchGen) return;   // tenant switched mid-flight; drop the response
  dims = data;
  emit();
}
```

Every async refresh/mutate in `store.ts` captures `switchGen` at call time and bails on the `emit()` if it advanced. Otherwise: `commit()` on Sportsbook + switch to iGaming + late `refreshDim()` lands → store is now corrupt.

### Cancel-on-switch (debounce fix)

`setGridLayout` debounces a 400ms write per `dim_id`. A user editing a column width + immediately switching tenants would fire the PATCH against the wrong tenant. `onTenantSwitch()` clears all `layoutTimers` and `pendingLayouts`.

### Hardcoded nav hrefs

`AppShell.tsx` and the command palette currently hardcode `/app/triage`, `/app/tables?open=...`, etc. These won't be caught by the ESLint rule (it watches `fetch`, not `navigate`). A `useNavLinks()` hook returns the nav array prefixed with the current tenant slug; command palette `navigate(...)` calls go through a `useTenantNavigate()` helper.

### Tenant-scoped `localStorage`

- `PALETTE_RECENTS_KEY` → `zugzug:palette-recents:${slug}` (dim_ids bleed across tenants otherwise)
- `open-tabs` storage key → suffixed with `:${slug}`
- `NAV_COLLAPSED_KEY` → stays shared (cosmetic preference)
- New: `zugzug:last-tenant-slug` for the BootGate redirect

### Redirect in BootGate

`/app` → `/app/<slug>` redirect lives in `BootGate`, not a route loader or effect. BootGate already orchestrates `initStore()` pre-render; extend it to resolve memberships and pick `slug = localStorage.getItem('zugzug:last-tenant-slug') ?? first(memberships) ?? null`. If null and not super-admin → `/login` with error. Route element for `/app` becomes `<Navigate to={\`/app/\${resolvedSlug}\`} replace />` — synchronous on first render.

## Migration

Two deploys, both zero-downtime. **No DDL renames, no `dimension.id` rewrite, no RLS in Deploy 1** (each of these was caught as a real bug source in second-round review).

### Deploy 1 — additive only

```sql
-- new tables
CREATE TABLE zugzug_app.tenant (...);
CREATE TABLE zugzug_app.tenant_member (...);
CREATE TABLE zugzug_app.tenant_invite (...);

-- seed
INSERT INTO zugzug_app.tenant (id, slug, label, warehouse_id, created_at)
VALUES ('default', 'default', 'Default', 'default', now());

-- nullable tenant_id columns
ALTER TABLE zugzug_app.dimension          ADD COLUMN tenant_id VARCHAR;
ALTER TABLE zugzug_app.dimension_source   ADD COLUMN tenant_id VARCHAR;
ALTER TABLE zugzug_app.dimension_field    ADD COLUMN tenant_id VARCHAR;
ALTER TABLE zugzug_app.source_stat        ADD COLUMN tenant_id VARCHAR;
ALTER TABLE zugzug_app.draft              ADD COLUMN tenant_id VARCHAR;
ALTER TABLE zugzug_app.audit_log          ADD COLUMN tenant_id VARCHAR;
ALTER TABLE zugzug_app.preferences        ADD COLUMN tenant_id VARCHAR;
ALTER TABLE zugzug_app.active_sessions    ADD COLUMN tenant_id VARCHAR;
ALTER TABLE zugzug_app.ai_hint_cache      ADD COLUMN tenant_id VARCHAR;

-- backfill (batched cursor loop for tables > 100k rows)
UPDATE zugzug_app.dimension       SET tenant_id = 'default' WHERE tenant_id IS NULL;
-- ... repeat per table; batched if needed (see below)

-- concurrent indexes (no table lock)
CREATE INDEX CONCURRENTLY dim_tenant_idx       ON zugzug_app.dimension(tenant_id);
CREATE INDEX CONCURRENTLY draft_tenant_idx     ON zugzug_app.draft(tenant_id);
CREATE INDEX CONCURRENTLY audit_tenant_time_idx ON zugzug_app.audit_log(tenant_id, created_at DESC);
-- ... repeat per scoped table

-- super-admin flag
ALTER TABLE zugzug_app.users
  ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT false;
```

App keeps running with the old code throughout. The new columns are ignored.

**Batched backfill for `audit_log` / `draft`** (if > 100k rows):

```sql
DO $$
DECLARE last_id TEXT := ''; batch INT := 5000; n INT;
BEGIN
  LOOP
    WITH b AS (
      SELECT id FROM zugzug_app.audit_log
      WHERE tenant_id IS NULL AND id > last_id
      ORDER BY id LIMIT batch
    )
    UPDATE zugzug_app.audit_log t SET tenant_id = 'default'
    FROM b WHERE t.id = b.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
    SELECT MAX(id) INTO last_id FROM b;
    PERFORM pg_sleep(0.05);
  END LOOP;
END $$;
```

### Deploy 2 — cutover (single coordinated change)

```sql
-- per-dimension atomic rename + dim_table/map_table column update
-- (loop generated by migration runner from the dimension registry)
BEGIN;
  ALTER TABLE zugzug_app.dim_country RENAME TO dim_default_country;
  ALTER TABLE zugzug_app.map_country RENAME TO map_default_country;
  UPDATE zugzug_app.dimension
    SET dim_table = 'zugzug_app.dim_default_country',
        map_table = 'zugzug_app.map_default_country'
    WHERE id = 'country' AND tenant_id = 'default';
COMMIT;
-- repeat per dimension row

-- NOT NULL flip
ALTER TABLE zugzug_app.dimension       ALTER COLUMN tenant_id SET NOT NULL;
-- ... repeat per table

-- FKs (NOT VALID then VALIDATE — no table scan lock)
ALTER TABLE zugzug_app.dimension
  ADD CONSTRAINT fk_dimension_tenant FOREIGN KEY (tenant_id)
  REFERENCES zugzug_app.tenant(id) NOT VALID;
ALTER TABLE zugzug_app.dimension VALIDATE CONSTRAINT fk_dimension_tenant;
-- ... repeat per table

-- PK swaps (drop old, add new composite PK)
ALTER TABLE zugzug_app.dimension DROP CONSTRAINT dimension_pkey;
ALTER TABLE zugzug_app.dimension ADD CONSTRAINT dimension_pkey PRIMARY KEY (tenant_id, id);
-- ... repeat for: dimension_source, dimension_field, source_stat, draft,
--                 ai_hint_cache, preferences, active_sessions
-- audit_log keeps id PK (tenant_id is a column + index only)

-- drop the legacy allowlist
DROP TABLE zugzug_app.allowed_emails;
```

Then code switchover: deploy new server with auth middleware, `withTenantTx`, `TenantRepo`, `/api/t/:slug/*` routes, and new sign-in flow. Frontend deploys with new routes, `apiFetch`, workspace switcher.

CLI promotes the bootstrapping user:

```
bun run admin -- promote-super-admin frederik.hagelund@bettercollective.com
```

### Phase 1.5 — RLS (separate deploy after phase 1 settles)

`current_setting('app.tenant_id', true)` returns `''` (not NULL) when unset — silent zero-row returns, not errors. So RLS waits until the middleware is confirmed setting `app.tenant_id` correctly in production. Enable per-policy:

```sql
ALTER TABLE zugzug_app.dimension ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON zugzug_app.dimension USING (
  tenant_id = current_setting('app.tenant_id', true)
  OR current_setting('app.tenant_id', true) = '*'
);
-- repeat for draft, audit_log, ai_hint_cache
```

App Postgres role gets `BYPASSRLS` during the transition window; revoked once policies are live and verified.

## Phase 1 deliverables (epic checklist)

**Server (Postgres + Bun):**
1. Drizzle migration — Deploy 1 (additive)
2. Drizzle migration — Deploy 2 (cutover)
3. `TenantRepo` class + un-export legacy `repo-*.ts` functions
4. `withTenantTx(req, fn)` helper + `SET LOCAL app.tenant_id`
5. Auth middleware: slug resolve, membership check, super-admin bypass
6. Sign-in flow: invite acceptance via `DELETE ... RETURNING`
7. `provisionTenant()` service function + CLI `bun run admin -- create-tenant <slug> <label>`
8. `teardownTenant()` stored procedure + CLI `bun run admin -- teardown-tenant <slug>`
9. Super-admin: `users.is_super_admin`, `/api/admin/*` routes, impersonation endpoint
10. Scheduler refactor: iterate tenants with per-tenant `SET LOCAL`

**Frontend (React + Vite):**
11. Routes: `/app/:tenantSlug/*` + `<TenantLayout>` + `useTenant()` context
12. `apiFetch` wrapper + `setCurrentTenant` + ESLint rule
13. Migrate ~50 `fetch('/api/...')` sites to `apiFetch`
14. Workspace switcher with dim_id validation + cancel-on-switch + `switchGen` counter
15. `useNavLinks()` + `useTenantNavigate()` (AppShell + command palette)
16. Tenant-scoped `localStorage` keys (palette recents, open-tabs)
17. BootGate: resolve memberships + initial slug pre-render
18. Settings → Team: invite input + member list (phase 1 admin-only since everyone is admin)

**Phase 1.5 (follow-up):**
19. Enable RLS on `dimension`, `draft`, `audit_log`, `ai_hint_cache`

## Phase 2 (separate spec; supersedes #36)

- Three roles on `tenant_member`: `admin` / `editor` / `viewer`
- `assertRole('editor')` on mutations, `'admin'` on member/settings ops
- UI: viewer read-only badges, disabled affordances
- Settings → Team: role picker (admin-only)
- #30: parse Google `hd` JWT claim for signed-domain trust

## Phase 3 (no spec yet)

- Per-tenant warehouse tokens (`tenant.warehouse_id` already exists; needs token store + per-tenant DuckDB connection pool)
- Super-admin tenant management UI (replace CLI)
- Tenant export (`COPY (SELECT … WHERE tenant_id = $1)` runner)
- Domain-based auto-membership (`tenant_domain_rule` table)
- Multi-DuckDB connection pool (noisy-neighbor mitigation; for phase 1 the mitigation is scan timeouts + async 202+poll)

## Out of scope

- Cross-tenant analytics dashboards
- Per-dimension ACLs
- SSO/SAML
- Tenant-aware backup beyond `pg_dump --schema=zugzug_app` (per-tenant export comes in phase 3)
