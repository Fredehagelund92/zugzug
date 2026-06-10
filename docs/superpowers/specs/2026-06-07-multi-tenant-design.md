# Multi-tenant (workspaces) — design

**Status:** approved (brainstormed 2026-06-07, revised 2026-06-10)
**Scope:** phase 1 (everything except per-tenant warehouse tokens). Phase 2 (warehouse tokens) is a separate spec.
**Supersedes:** scope of GitHub epic #36 in full — its child issues #28/#29/#31/#32 are absorbed here; #30 (parse Google `hd`) stays standalone.

## Revision history

- **2026-06-07** — initial spec, approved. Phase 2 deferred per-tenant roles; phase 1.5 deferred RLS.
- **2026-06-10** — revised after RBAC (PR #90), E2 concurrency (PR #93), and E1 activity/presence (PR #94/#95) shipped, plus a fresh round of architect/SQL/API reviews. The substantive changes from the prior spec:
  - **Per-tenant roles ship in phase 1** (absorbs the original phase 2). `tenant_member.role ∈ {admin, editor, viewer}` is authoritative from day one; `users.role` is dropped.
  - **RLS ships in phase 1 Deploy 2** (was phase 1.5). The earlier deferral assumed `current_setting('app.tenant_id', true)` was the only available form; the `true` arg can simply be dropped so missing `SET LOCAL` *throws* instead of silently zero-rowing. `BYPASSRLS` on the app Postgres role is the rollout safety net.
  - **Workspace-switch races use `AbortController`, not a `switchGen` counter.** One controller per tenant session, aborted on switch; aborted fetches reject naturally with no per-callsite boilerplate.
  - **`apiFetch` reads the tenant slug from `window.location.pathname`,** not a module-level setter. The URL is already the source of truth.
  - **No `dim_X` table renames in Deploy 2.** Existing `dim_country` stays `dim_country` for the default tenant; new tenants get prefixed naming (`dim_sportsbook_country`). Removes a mid-loop-crash risk.
  - **`TenantRepo` Proxy-wraps the `pg` instance** so a direct `pg.query()` from inside a route 500s at runtime — ESLint + convention isn't enough.
  - **WebSocket presence is namespaced by tenant** (`/ws/t/:slug/presence/:tableId`; yjs room key prefixed with `tenantId`). Prevents cross-tenant cursor leaks when two tenants share a dim id like `country`.
  - **Three more tables to scope** (added since 2026-06-07): `canonical_version` (E2), `scan_run` (scheduler hardening). `audit_log` already gained `table_id`/`row_key` from E1-A — those stay as-is.
  - **`tenant.id` has a DB-level slug check** (`^[a-z][a-z0-9_]{0,20}$`) so dynamic `dim_${tenantId}_${slug}` doesn't blow Postgres's 63-byte identifier limit.

## Goal

Add multi-tenancy to Zugzug so Better Collective's internal sub-teams (Sportsbook, iGaming, Affiliates, etc.) each get an isolated workspace within the same deployment. Existing data becomes a single `default` tenant.

Out of scope for this spec: per-tenant warehouses (`tenant.warehouse_id` column ships but only points at the shared default), self-serve provisioning (super-admin CLI only), tenant export, SSO/SAML, per-dimension ACLs.

## Decisions locked

1. **Tenant = internal sub-team** (not external org, not Google domain). Code says `tenant`; UI says "Workspace" (Linear/Vercel convention).
2. **Shared warehouse** for now. `tenant.warehouse_id` exists from day one so per-tenant tokens are a future config change, not a migration.
3. **Multi-membership:** one user → many tenants. Workspace switcher in topbar.
4. **Row-level isolation** with `tenant_id` column on every app-state and canonical row. Single Postgres schema. **RLS enabled in Deploy 2** with non-silent policies (see Migration).
5. **Tenant in URL path** (`/app/:tenantSlug/...`). Server route `/api/t/:tenantSlug/*` is authoritative; no header.
6. **Super-admin provisioning** via CLI only in phase 1. First tenant `default` seeded at migration time, all existing data backfilled into it.
7. **Per-tenant invite by email.** Drops `allowed_emails`. Adds `tenant_invite` for not-yet-registered emails.
8. **Per-tenant roles from day one.** `tenant_member.role ∈ {admin, editor, viewer}`. The existing global `users.role` is backfilled into the default tenant's memberships, then dropped in Deploy 2.

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
  canonical_version · scan_run
  dim_<tenant>_<slug> / map_<tenant>_<slug>  (canonical rows; default tenant grandfathered)
```

**Query rule:** every Postgres query touching scoped tables runs inside a transaction that began with `SET LOCAL app.tenant_id = $1`. A `TenantRepo` class wraps `repo-*.ts` modules and is the only public surface; the un-tenanted free functions are unexported. `TenantRepo` Proxy-wraps the `pg` instance so calling `pg.query()` directly throws at runtime — ESLint catches the obvious cases at lint time; the Proxy is defense-in-depth for the legacy free functions. RLS is the database-level backstop, enabled in Deploy 2 with policies that **error on missing `SET LOCAL`**.

## Data model

### New tables

```sql
CREATE TABLE zugzug_app.tenant (
  id           VARCHAR PRIMARY KEY,
  slug         VARCHAR NOT NULL UNIQUE,       -- URL segment; equal to id in phase 1
  label        VARCHAR NOT NULL,              -- 'Sportsbook'
  warehouse_id VARCHAR NOT NULL,              -- 'default' for now
  created_at   TIMESTAMP NOT NULL,
  deleted_at   TIMESTAMP,                     -- soft delete; teardown function handles hard cleanup
  CONSTRAINT tenant_id_slug_format CHECK (id ~ '^[a-z][a-z0-9_]{0,20}$')
);
-- 21-char cap on id leaves room for `dim_${id}_${slug}` to fit Postgres's 63-byte identifier limit
-- with a 37-char dim slug (4 + 21 + 1 + 37 = 63). `dim.id` (e.g. 'country') is unconstrained because
-- the existing slugs are short and adding the constraint would block the data backfill.

CREATE TABLE zugzug_app.tenant_member (
  tenant_id  VARCHAR NOT NULL REFERENCES zugzug_app.tenant(id),
  user_id    VARCHAR NOT NULL REFERENCES zugzug_app.users(id),
  role       VARCHAR NOT NULL,                -- admin | editor | viewer
  created_at TIMESTAMP NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT tenant_member_role_chk CHECK (role IN ('admin', 'editor', 'viewer'))
);
CREATE INDEX tenant_member_user_idx ON zugzug_app.tenant_member(user_id);

CREATE TABLE zugzug_app.tenant_invite (
  tenant_id  VARCHAR NOT NULL REFERENCES zugzug_app.tenant(id),
  email      VARCHAR NOT NULL,
  role       VARCHAR NOT NULL,
  invited_by VARCHAR NOT NULL,
  invited_at TIMESTAMP NOT NULL,
  PRIMARY KEY (tenant_id, email),
  CONSTRAINT tenant_invite_role_chk CHECK (role IN ('admin', 'editor', 'viewer'))
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
| `audit_log` | unchanged (`id` PK) | Globally unique cursor needed for super-admin cross-tenant feed; add index `(tenant_id, created_at DESC)`. |
| `preferences` | `(tenant_id)` | Was singleton `id = 1`. |
| `active_sessions` | `(tenant_id, user_id)` | One row per (tenant, user). A user across two tenants in two tabs = two rows. Per-tab presence stays out of scope. |
| `ai_hint_cache` | `(tenant_id, dim_id, raw)` | Per-tenant cache (privacy over cost). |
| `canonical_version` | `(tenant_id, dim_id, key)` | E2. `bumpVersionOrThrow` updates `ON CONFLICT (tenant_id, dim_id, key)`. |
| `scan_run` | `(tenant_id, id)` | Scheduler hardening. Per-tenant scan attribution. |

Composite PKs replace the single-column ones above where natural. `dimension.id` stays a string; child tables reference `(tenant_id, dim_id)` via app-level lookups (no real FK constraint — matches today's pattern).

### Tables that stay global (no `tenant_id`)

- `users` — one Google identity = one row. Email/`google_sub` unique indexes stay valid.
- `sessions` — auth is global; the workspace lives in the URL.
- `user_grid_layout` — per-user-per-dim. `dim_id` is unambiguous because dims are tenant-scoped.

### Dropped

- `allowed_emails` (Deploy 2) — replaced by `tenant_member ∪ tenant_invite`. First-login rule: signed-in iff at least one `tenant_member` row OR `tenant_invite` row matches the email.
- `users.role` (Deploy 2) — moved to `tenant_member.role`. Existing values backfilled into the default tenant in Deploy 1.

### Dynamic `dim_*` / `map_*` tables

Two naming conventions coexist:

- **Default tenant (grandfathered):** existing tables `dim_country`, `map_country` etc. stay as-is. Their `dimension.dim_table` registry entries already store the unqualified two-part ref (`zugzug.dim_country`).
- **New tenants:** `dim_${tenantId}_${slug}` / `map_${tenantId}_${slug}`. `addDimension(tenantId, ...)` generates them. The fully-qualified string is stored in `dimension.dim_table` / `map_table` so downstream `repo-canonical.ts` code is data-driven.

Rationale: a mid-loop crash during the rename of every existing `dim_*` table during Deploy 2 leaves the registry in an inconsistent state (half-renamed, half-not). The grandfathered approach removes the risk at the cost of a slightly inconsistent naming convention going forward — acceptable for an internal tool.

Each dynamic table also gets `tenant_id NOT NULL DEFAULT '<tenant>'` so RLS covers them.

### Super-admin

`ALTER TABLE users ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT false`. Flag flipped by CLI. Super-admin bypasses the `tenant_member` check, can call `provisionTenant()`/`teardownTenant()`, can read the cross-tenant audit feed, and can impersonate a tenant for debugging (sets `app.tenant_id = '<target>'` for that session with an audit log entry).

## Auth & request lifecycle

```
1. Cookie session  → user_id                                (existing)
2. URL /api/t/:slug/...                                     (or /api/admin/* for super-admin)
3. Middleware:
     resolve slug → tenant_id
     verify tenant_member(user_id, tenant_id) → role  OR  is_super_admin
     open Postgres tx, SET LOCAL app.tenant_id = '<id>'      (or '*' for super-admin)
     construct req.repo = new TenantRepo(tenantId, role, pgProxy)
4. Route handler runs; req.repo is the only DB surface
5. Commit tx, release conn
```

A `withTenantTx(req, async (repo) => { ... })` helper wraps step 3–5 and is **mandatory** for any tenant route. The `pgProxy` is a `Proxy` over the postgres.js client that 500s if any method other than the tx-bound ones is called; this is defense-in-depth on top of the ESLint rule banning raw `pg.query` in route handlers.

### TenantRepo

A class instantiated per request, holding `{tenantId, role, pg}`. Wraps the previously-free repo functions. Mutation methods call `this.assertRole('editor')` (mutates) or `this.assertRole('admin')` (member / settings ops); read methods are role-agnostic. The current free functions in `repo.ts`, `repo-canonical.ts`, `repo-drafts.ts`, `repo-meta.ts`, `repo-scan.ts`, `repo-shared.ts`, `repo-ai-hint.ts`, `repo-activity.ts` become module-private — only the `TenantRepo` class is exported. The scheduler (which legitimately needs un-tenanted access) iterates tenants and calls a module-private path per tenant with an explicit `SET LOCAL`.

### Sign-in flow

```
POST /api/auth/{password|oidc}/callback
  verify credentials → email + (optionally google_sub)
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

The `role` carried in the resulting membership is whatever `tenant_invite.role` had; default `editor` if the invite was created without a role.

### Super-admin routes

All under `/api/admin/*` guarded by `is_super_admin`. Never reachable via `/api/t/:slug/*`. Handlers are the same code as `/api/t/:slug/*` mounted twice — super-admin variants pass `tenant_id = '*'` so the policy returns all rows.

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

`<TenantLayout>` at `/app/:tenantSlug` validates the slug against memberships on mount, loads tenant metadata into a context, 403/redirects on mismatch.

`useTenant() → {id, slug, label, role}` is the hook. `role` is consumed for UI affordances (gating buttons, RoleBadge); server-side `req.repo.role` remains the authority for mutations. If the role changes server-side mid-session, the context goes stale until the next mount — accept and let the server reject the mutation with a clear error the UI surfaces.

### `apiFetch`

```ts
// app/src/api.ts
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // Read tenant slug from the URL — already the source of truth.
  // Path shape: /app/<slug>/... (regular) or /app/admin/... (super-admin).
  const m = /^\/app\/([^/]+)\//.exec(window.location.pathname);
  const slug = m?.[1] ?? "";
  const url =
    path.startsWith("/admin/")       ? `/api${path}` :
    slug === "admin"                 ? `/api/admin${path}` :
    slug                             ? `/api/t/${slug}${path}` :
                                       `/api${path}`; // /auth/* and similar pre-login

  return fetch(url, { credentials: "include", ...init });
}
```

No module-level state, no setter, no race window between switch and next fetch. The URL is the authority.

Three pre-login exemptions (`/auth/me`, `/auth/logout`, `/auth/dev`) go through a thin `authFetch(path, init)` wrapper that always builds `/api${path}`, avoiding inline ESLint disables.

### ESLint rule

```js
"no-restricted-syntax": ["error",
  {
    // fetch("/api/...") — literal string
    selector: "CallExpression[callee.name='fetch'] > Literal[value=/^\\/api/]",
    message: "Use apiFetch() — raw fetch bypasses tenant routing.",
  },
  {
    // fetch(`/api/...`) — template literal beginning with /api
    selector: "CallExpression[callee.name='fetch'] > TemplateLiteral[quasis.0.value.raw=/^\\/api/]",
    message: "Use apiFetch() — raw fetch bypasses tenant routing.",
  },
  {
    // new Request("/api/...") + similar
    selector: "NewExpression[callee.name='Request'] > Literal[value=/^\\/api/]",
    message: "Use apiFetch() — raw Request() bypasses tenant routing.",
  },
],
"no-restricted-imports": ["error", { paths: ["axios", "ky"] }],
```

The literal/template selectors are scoped so external URLs (`fetch("https://...")`) don't false-positive. Variable URLs (`const u = '/api/x'; fetch(u)`) defeat the lint rule — the server-side backstop is a 404 on any `/api/*` request that's not `/api/t/...`, `/api/admin/...`, or one of the three auth paths, which surfaces the bypass loudly at runtime.

### Workspace switcher

Topbar dropdown listing the user's memberships. On click:

1. Validate `dim_id` in current path against target tenant's dims. If mismatch → strip `dim_id`, navigate to `/app/<targetSlug>/tables`, toast "table doesn't exist here". Otherwise navigate to `/app/<targetSlug>/<currentSubpath>`.
2. Call `onTenantSwitch()`:
   - **Abort the current tenant session's `AbortController`** — all in-flight `apiFetch` calls reject with `AbortError`, the responses never land.
   - Clear any pending debounced timers (`setGridLayout`'s 400ms flush, etc.) and their queued payloads.
   - Reset module-level store state (`dims`, `sources`, etc.).
3. Construct a new `AbortController` for the next tenant session.
4. Re-run `initStore()` under the new slug (resolved from `window.location.pathname` by `apiFetch`).

### AbortController-based race fix

```ts
// app/src/store.ts
let tenantSessionController = new AbortController();

export function onTenantSwitch(): void {
  tenantSessionController.abort();
  tenantSessionController = new AbortController();
  resetStore();
  cancelDebouncedTimers();
}

async function refreshDims(): Promise<void> {
  try {
    const res = await apiFetch("/dimensions?full=true", { signal: tenantSessionController.signal });
    dims = (await res.json()) as MappingDimension[];
    emit();
  } catch (e) {
    if ((e as Error).name === "AbortError") return; // tenant switched mid-flight
    throw e;
  }
}
```

Two properties this gives us that the previous `switchGen` counter did not:

- The fetch is actually cancelled, not just discarded — fewer wasted bytes + server work on rapid switches.
- No per-callsite boilerplate: store.ts functions either pass the signal or they don't; missing the signal means the response will land late and overwrite state, which is identical to today's behavior on switch-less navigation. Catch via grep, not via human discipline.

### Mid-flight mutation contract

A POST/PUT that's already in flight when the user switches tenants will:
- Land server-side against the old tenant (correct — the URL had the old slug).
- Reject client-side with `AbortError` — the response is dropped before any optimistic state update or `emit()`.

The mutation **happened** on the old tenant. We do not try to roll it back. UI shows "saving…" indicator that disappears with the switch (state was reset). If the user navigates back to the old tenant, they see the mutation reflected.

Document this explicitly in the switcher tooltip ("switching workspaces commits any pending edits in the current one") so users aren't surprised.

### Cancel-on-switch (debounce fix)

`setGridLayout` debounces a 400ms write per `dim_id`. A user editing a column width + immediately switching tenants would fire the PATCH against the wrong tenant. `onTenantSwitch()` clears all `layoutTimers` and `pendingLayouts`. (Debounced writes can't be aborted via `AbortController` because they haven't started yet; cancelling the timer is the only fix.)

### Hardcoded nav hrefs

`AppShell.tsx` and the command palette currently hardcode `/app/triage`, `/app/tables?open=...`, etc. These won't be caught by the ESLint rule (it watches `fetch`, not `navigate`). A `useNavLinks()` hook returns the nav array prefixed with the current tenant slug; command palette `navigate(...)` calls go through a `useTenantNavigate()` helper.

### Tenant-scoped `localStorage`

- `PALETTE_RECENTS_KEY` → `zugzug:palette-recents:${slug}` (dim_ids bleed across tenants otherwise)
- `open-tabs` storage key → suffixed with `:${slug}`
- `NAV_COLLAPSED_KEY` → stays shared (cosmetic preference)
- New: `zugzug:last-tenant-slug` for the BootGate redirect

### Redirect in BootGate

`/app` → `/app/<slug>` redirect lives in `BootGate`, not a route loader or effect. BootGate already orchestrates `initStore()` pre-render; extend it to resolve memberships and pick `slug = localStorage.getItem('zugzug:last-tenant-slug') ?? first(memberships) ?? null`. If null and not super-admin → `/login` with error. Route element for `/app` becomes `<Navigate to={\`/app/\${resolvedSlug}\`} replace />` — synchronous on first render.

### WebSocket (E1-B presence)

E1-B shipped `/ws/presence/:tableId` (untenanted). Multi-tenant requires:

- **Path:** `/ws/t/:slug/presence/:tableId`. Server upgrade handler resolves slug → tenant_id and verifies membership before accepting the upgrade (mirrors the HTTP middleware).
- **yjs room key:** prefixed with `tenantId` (`${tenantId}:${tableId}`) so two tenants with a dim named `country` don't share an awareness room.
- **`use-presence` hook:** passes the tenant slug from `window.location.pathname` (matches `apiFetch`'s approach) when building the WS URL.

Untenanted today = real cross-tenant cursor leak the moment two tenants exist with overlapping dim ids. Closing it now is cheap; retrofitting after Sportsbook goes live is not.

## Migration

Two deploys, both zero-downtime. **No `dim_X` table renames, no `dimension.id` rewrite. RLS enabled in Deploy 2 (not deferred).**

### Deploy 1 — additive only

```sql
-- new tables
CREATE TABLE zugzug_app.tenant (...);
CREATE TABLE zugzug_app.tenant_member (...);
CREATE TABLE zugzug_app.tenant_invite (...);

-- seed
INSERT INTO zugzug_app.tenant (id, slug, label, warehouse_id, created_at)
VALUES ('default', 'default', 'Default', 'default', now());

-- nullable tenant_id columns WITH default so any inserts during the window self-heal.
-- The default is dropped in Deploy 2 after the NOT NULL flip.
ALTER TABLE zugzug_app.dimension          ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.dimension_source   ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.dimension_field    ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.source_stat        ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.draft              ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.audit_log          ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.preferences        ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.active_sessions    ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.ai_hint_cache      ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.canonical_version  ADD COLUMN tenant_id VARCHAR DEFAULT 'default';
ALTER TABLE zugzug_app.scan_run           ADD COLUMN tenant_id VARCHAR DEFAULT 'default';

-- backfill existing rows
UPDATE zugzug_app.dimension       SET tenant_id = 'default' WHERE tenant_id IS NULL;
-- ... repeat per table; single UPDATE is fine at our scale (~tens of thousands of audit rows max).
-- If a scoped table ever exceeds ~1M rows, switch to a batched DO-block cursor.

-- backfill tenant_member from existing users + their role
INSERT INTO zugzug_app.tenant_member (tenant_id, user_id, role, created_at)
SELECT 'default', id, role, now() FROM zugzug_app.users
ON CONFLICT DO NOTHING;

-- concurrent indexes (no table lock)
CREATE INDEX CONCURRENTLY dim_tenant_idx        ON zugzug_app.dimension(tenant_id);
CREATE INDEX CONCURRENTLY draft_tenant_idx      ON zugzug_app.draft(tenant_id);
CREATE INDEX CONCURRENTLY audit_tenant_time_idx ON zugzug_app.audit_log(tenant_id, created_at DESC);
-- ... repeat per scoped table

-- super-admin flag
ALTER TABLE zugzug_app.users
  ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT false;
```

App keeps running with the old code throughout. The new columns are ignored. `users.role` stays put through Deploy 1 — Deploy 2 drops it after the cutover.

### Deploy 2 — cutover

```sql
-- Drop the DEFAULTs first; we want NOT NULL violations to expose any missed inserts.
ALTER TABLE zugzug_app.dimension          ALTER COLUMN tenant_id DROP DEFAULT;
-- ... repeat per scoped table

-- NOT NULL flip. Fast at our scale (tens of thousands of rows max).
-- If a scoped table grows past ~1M, prepend each with a validated CHECK first to skip the table scan:
--   ALTER TABLE x ADD CONSTRAINT chk NOT NULL (tenant_id) NOT VALID;
--   ALTER TABLE x VALIDATE CONSTRAINT chk;
--   ALTER TABLE x ALTER COLUMN tenant_id SET NOT NULL;
--   ALTER TABLE x DROP CONSTRAINT chk;
ALTER TABLE zugzug_app.dimension       ALTER COLUMN tenant_id SET NOT NULL;
-- ... repeat per scoped table

-- FKs (NOT VALID then VALIDATE — no table scan lock)
ALTER TABLE zugzug_app.dimension
  ADD CONSTRAINT fk_dimension_tenant FOREIGN KEY (tenant_id)
  REFERENCES zugzug_app.tenant(id) NOT VALID;
ALTER TABLE zugzug_app.dimension VALIDATE CONSTRAINT fk_dimension_tenant;
-- ... repeat per scoped table

-- PK swaps: build the new index concurrently first so the swap is microseconds.
CREATE UNIQUE INDEX CONCURRENTLY dimension_pkey_new ON zugzug_app.dimension(tenant_id, id);
ALTER TABLE zugzug_app.dimension
  DROP CONSTRAINT dimension_pkey,
  ADD CONSTRAINT dimension_pkey PRIMARY KEY USING INDEX dimension_pkey_new;
-- ... repeat for: dimension_source, dimension_field, source_stat, draft,
--                 canonical_version, scan_run, ai_hint_cache, preferences, active_sessions
-- audit_log keeps id PK (needed for stable cross-tenant cursor in super-admin feed).

-- Drop the legacy allowlist and the global role column.
DROP TABLE zugzug_app.allowed_emails;
ALTER TABLE zugzug_app.users DROP COLUMN role;

-- Enable RLS. The policy intentionally drops the `, true` argument so a missing
-- SET LOCAL throws "unrecognized configuration parameter" rather than silently
-- returning zero rows. App Postgres role keeps BYPASSRLS for the first 24h, then
-- the flag is revoked after a smoke pass.
ALTER TABLE zugzug_app.dimension       ENABLE ROW LEVEL SECURITY;
ALTER TABLE zugzug_app.draft           ENABLE ROW LEVEL SECURITY;
ALTER TABLE zugzug_app.audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE zugzug_app.canonical_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE zugzug_app.ai_hint_cache   ENABLE ROW LEVEL SECURITY;
-- ... repeat per scoped table

CREATE POLICY tenant_iso ON zugzug_app.dimension USING (
  tenant_id = current_setting('app.tenant_id')                -- throws on missing SET LOCAL
  OR current_setting('app.is_super_admin', true) = 't'        -- super-admin bypass
);
-- ... repeat per scoped table
```

Then code switchover: deploy new server with auth middleware, `withTenantTx`, `TenantRepo`, `/api/t/:slug/*` routes, `/ws/t/:slug/presence/:tableId`, and new sign-in flow. Frontend deploys with new routes, `apiFetch`, workspace switcher.

CLI promotes the bootstrapping user:

```
bun run admin -- promote-super-admin frederik.hagelund@example.com
```

After 24h of clean prod operation, revoke `BYPASSRLS` on the app role.

## Sub-PR slicing

"Full phase 1" lands as five successive PRs, each green and reversible on its own until PR 5. Pause-able after PR 1 or PR 2 if priorities shift.

1. **PR 1 — Data foundation** — Deploy 1 migration (additive only — including `users.is_super_admin` column) + `tenant` / `tenant_member` / `tenant_invite` tables + `provisionTenant()` service function + super-admin CLI (`bun run admin -- create-tenant <slug> <label>` and `promote-super-admin <email>`). No HTTP routes yet — CLI is the only way to use the new tables. App keeps running unchanged.
2. **PR 2 — Server runtime** — `TenantRepo` class + `withTenantTx` helper + `pg` Proxy wrap + auth middleware (slug resolve, membership check, super-admin bypass) + scheduler refactor (per-tenant `SET LOCAL`) + `/api/t/:slug/*` route mounting + `/api/admin/*` super-admin routes. Server is multi-tenant on the wire; existing `/api/*` routes also keep working under `default` for backward compat during the transition.
3. **PR 3 — Client API surface** — `apiFetch` + `authFetch` + ESLint rule + migration of ~50 fetch sites to `apiFetch`. Client now uses tenant-scoped URLs; both old `/api/*` and new `/api/t/*` routes work server-side.
4. **PR 4 — UI shell** — `/app/:tenantSlug/*` routes + `<TenantLayout>` + `useTenant()` context + workspace switcher with AbortController-based race fix + BootGate redirect + Settings → Team (invite + member list + role picker for admins) + tenant-scoped `localStorage` + `useNavLinks` / `useTenantNavigate`. End-to-end multi-tenant UX.
5. **PR 5 — Cutover** — Deploy 2 migration (NOT NULL flips, FKs, PK swaps, drop `allowed_emails`, drop `users.role`, enable RLS) + drop the legacy un-tenanted routes from server + drop pre-migration fetch fallbacks from client. Single coordinated deploy.

## Phase 1 deliverables (epic checklist)

**Server (Postgres + Bun):**
1. Drizzle migration — Deploy 1 (additive)
2. Drizzle migration — Deploy 2 (cutover, includes RLS)
3. `TenantRepo` class + un-export legacy `repo-*.ts` functions + `pg` Proxy wrap
4. `withTenantTx(req, fn)` helper + `SET LOCAL app.tenant_id`
5. Auth middleware: slug resolve, membership check, super-admin bypass
6. Sign-in flow: invite acceptance via `DELETE ... RETURNING`
7. `provisionTenant()` service function + CLI `bun run admin -- create-tenant <slug> <label>`
8. `teardownTenant()` stored procedure + CLI `bun run admin -- teardown-tenant <slug>`
9. Super-admin: `users.is_super_admin`, `/api/admin/*` routes, impersonation endpoint
10. Scheduler refactor: iterate tenants with per-tenant `SET LOCAL`
11. WebSocket: `/ws/t/:slug/presence/:tableId` + tenant-prefixed yjs room key

**Frontend (React + Vite):**
12. Routes: `/app/:tenantSlug/*` + `<TenantLayout>` + `useTenant()` context
13. `apiFetch` (URL-derived slug) + `authFetch` wrapper + ESLint rule
14. Migrate ~50 `fetch('/api/...')` sites to `apiFetch`
15. Workspace switcher with dim_id validation + `AbortController`-based race fix + debounced-timer cancellation
16. `useNavLinks()` + `useTenantNavigate()` (AppShell + command palette)
17. Tenant-scoped `localStorage` keys (palette recents, open-tabs)
18. BootGate: resolve memberships + initial slug pre-render
19. Settings → Team: invite input + member list + role picker (admin-only)

## Phase 2 (no spec yet)

- Per-tenant warehouse tokens (`tenant.warehouse_id` already exists; needs token store + per-tenant DuckDB connection pool)
- Super-admin tenant management UI (replace CLI)
- Tenant export (`COPY (SELECT … WHERE tenant_id = $1)` runner)
- Domain-based auto-membership (`tenant_domain_rule` table)
- Multi-DuckDB connection pool (noisy-neighbor mitigation; for phase 1 the mitigation is scan timeouts + async 202+poll)
- #30: parse Google `hd` JWT claim for signed-domain trust

## Out of scope

- Cross-tenant analytics dashboards
- Per-dimension ACLs
- SSO/SAML
- Tenant-aware backup beyond `pg_dump --schema=zugzug_app` (per-tenant export comes in phase 2)
