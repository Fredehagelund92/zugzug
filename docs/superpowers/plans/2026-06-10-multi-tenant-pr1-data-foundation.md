# Multi-tenant PR 1 — Data foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Deploy 1 of the multi-tenant migration (additive only) + `provisionTenant()` service + super-admin CLI. After this PR, the database has tenant tables and every existing row is owned by the `default` tenant; the HTTP API behavior is unchanged.

**Architecture:** Pure additive migration. Three new tables (`tenant`, `tenant_member`, `tenant_invite`), `users.is_super_admin` column, `tenant_id` column with `DEFAULT 'default'` on 11 existing tables, backfill of `users.role` into `tenant_member.role` for the default tenant. New module-private `provisionTenant()` service function used by a new admin CLI script. No route changes, no client changes. The app keeps running with the old code throughout.

**Branch:** `mt-pr1-data-foundation` off updated `main`.

**Tech Stack:** Drizzle (schema + migration), Bun + postgres.js (server), bun:test (server tests). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-07-multi-tenant-design.md` — relevant sections: "Decisions locked", "Data model", "Migration → Deploy 1", "Sub-PR slicing → PR 1".

---

## File structure (post-PR)

```
server/drizzle/schema.ts                                  MOD — 3 new tables, 11 tenant_id cols, users.is_super_admin
server/drizzle/migrations/0011_mt_data_foundation.sql     GENERATED — additive migration + backfill
server/drizzle/migrations/meta/0011_snapshot.json         GENERATED
server/drizzle/migrations/meta/_journal.json              MOD
server/src/tenant.ts                                      NEW — provisionTenant() + listTenants()
server/src/admin.ts                                       NEW — promoteSuperAdmin() service helper
server/scripts/admin.ts                                   NEW — CLI dispatcher: create-tenant + promote-super-admin
server/test/tenant-provision.test.ts                      NEW — provisionTenant happy + duplicate slug
server/test/tenant-migration.test.ts                      NEW — backfill + tenant_member seeding from users.role
server/test/admin-cli.test.ts                             NEW — CLI parses + dispatches the two subcommands
server/package.json                                       MOD — add "admin" script
```

---

## Task 1: Branch kickoff + baseline

**Files:** none.

- [ ] **Step 1: Confirm clean main**

```bash
git status -sb && git log -1 --oneline
```
Expected: branch is `main`, last commit is the multi-tenant spec revision (`6bf3ed6` or later).

- [ ] **Step 2: Create branch**

```bash
git checkout -b mt-pr1-data-foundation
```

- [ ] **Step 3: Baseline test counts**

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: ~195 passing across ~33 files.

```bash
cd app && bun run test 2>&1 | tail -5
```
Expected: ~178 passing + 1 skipped across ~36 files.

---

## Task 2: Drizzle schema — three new tables

**Files:**
- Modify: `server/drizzle/schema.ts` — add `tenant`, `tenantMember`, `tenantInvite` table declarations

- [ ] **Step 1: Confirm imports + helpers**

```bash
grep -E "^import.*(check|sql|index|primaryKey|varchar|timestamp|boolean)" server/drizzle/schema.ts | head -5
```

Drizzle's `check()` constraint builder lives in `drizzle-orm/pg-core`. If it isn't already imported, add it:

```ts
import { check, /* existing imports */ } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
```

(`sql` may already be imported per the E1-A migration; check with grep.)

- [ ] **Step 2: Append the three table declarations**

At the end of `server/drizzle/schema.ts` (after the last existing `export const ...` table), append:

```ts
/* ---------- Multi-tenant (PR 1 of 5) ---------- */

export const tenant = app.table(
  "tenant",
  {
    id:           varchar("id").primaryKey(),
    slug:         varchar("slug").notNull(),
    label:        varchar("label").notNull(),
    warehouse_id: varchar("warehouse_id").notNull(),
    created_at:   timestamp("created_at").notNull(),
    deleted_at:   timestamp("deleted_at"),
  },
  (t) => [
    // 21-char cap on id keeps room for dim_${tenantId}_${dimSlug} under Postgres's
    // 63-byte identifier limit (4 + 21 + 1 + 37 = 63).
    check("tenant_id_format", sql`${t.id} ~ '^[a-z][a-z0-9_]{0,20}$'`),
    // slug is the URL segment; same constraint shape.
    check("tenant_slug_format", sql`${t.slug} ~ '^[a-z][a-z0-9_]{0,20}$'`),
  ],
);

export const tenantMember = app.table(
  "tenant_member",
  {
    tenant_id:  varchar("tenant_id").notNull(),
    user_id:    varchar("user_id").notNull(),
    role:       varchar("role").notNull(),
    created_at: timestamp("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.user_id] }),
    index("tenant_member_user_idx").on(t.user_id),
    check("tenant_member_role_chk", sql`${t.role} IN ('admin', 'editor', 'viewer')`),
  ],
);

export const tenantInvite = app.table(
  "tenant_invite",
  {
    tenant_id:  varchar("tenant_id").notNull(),
    email:      varchar("email").notNull(),
    role:       varchar("role").notNull(),
    invited_by: varchar("invited_by").notNull(),
    invited_at: timestamp("invited_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.email] }),
    index("tenant_invite_email_idx").on(t.email),
    check("tenant_invite_role_chk", sql`${t.role} IN ('admin', 'editor', 'viewer')`),
  ],
);
```

**Note on FKs:** Drizzle's `references()` would add real FK constraints on `tenant_member.tenant_id → tenant.id` etc. The existing schema convention (`dimension_source.dim_id` doesn't FK to `dimension.id` either) is to skip FKs and rely on app-level enforcement. Match that convention here; FKs land in Deploy 2 anyway via `ADD CONSTRAINT ... NOT VALID` per the spec.

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/drizzle/schema.ts
git commit -m "feat(db): add tenant/tenant_member/tenant_invite to Drizzle schema (MT PR1)"
```

---

## Task 3: Drizzle schema — `tenant_id` columns + `users.is_super_admin`

**Files:**
- Modify: `server/drizzle/schema.ts` — 11 existing tables gain a nullable `tenant_id` column; `users` gains `is_super_admin`

- [ ] **Step 1: Add `is_super_admin` to `users`**

Find the existing `users` table declaration (around `server/drizzle/schema.ts:103`). Inside its column object, add the new column. Existing shape:

```ts
export const users = app.table(
  "users",
  {
    id:            varchar("id").primaryKey(),
    // ... existing fields ...
    role:          varchar("role").notNull().default("editor"),
  },
);
```

Add `is_super_admin` as the last column:

```ts
    role:           varchar("role").notNull().default("editor"),
    is_super_admin: boolean("is_super_admin").notNull().default(false),
```

If `boolean` isn't already imported from `drizzle-orm/pg-core`, add it.

- [ ] **Step 2: Add `tenant_id` to the 11 scoped tables**

For each of these tables in `server/drizzle/schema.ts`, append a nullable `tenant_id` column to the column object:

- `dimension`
- `dimensionSource`
- `dimensionField`
- `sourceStat`
- `draft`
- `auditLog`
- `preferences`
- `activeSessions`
- `aiHintCache` (if present in the schema — grep `ai_hint_cache` to confirm)
- `canonicalVersion`
- `scanRuns` (if present — grep `scan_run`)

Pattern per table:

```ts
    // ... existing columns ...
    tenant_id: varchar("tenant_id").default("default"),
```

**Important:** `tenant_id` is intentionally NOT marked `.notNull()` in this PR. Deploy 1 leaves it nullable + defaulted; Deploy 2 (separate PR) flips it to `NOT NULL`. The default value ensures any inserts during the transition window auto-populate to `'default'` without code changes.

For each table you touch, check whether it has a composite primary key declared in the `(t) => [...]` callback. Composite PKs DON'T change in this PR — the existing PK stays single-column or as-is. Deploy 2 (later PR) does the composite-PK swap.

If a table's column block uses positional formatting (columns vertically aligned), keep the alignment. If you can't tell at a glance, just append the line in any reasonable position.

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/drizzle/schema.ts
git commit -m "feat(db): tenant_id col on 11 scoped tables + users.is_super_admin (MT PR1)"
```

---

## Task 4: Generate + customize the migration

**Files:**
- Generate: `server/drizzle/migrations/0011_*.sql` then rename
- Modify: `server/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Generate the migration**

```bash
cd server && bun run db:generate
```

Expected: a new file `server/drizzle/migrations/0011_*.sql` containing CREATE TABLE for the three new tables, ALTER TABLE ADD COLUMN for each `tenant_id` and `is_super_admin`, plus CREATE INDEX entries.

Drizzle-kit may prompt; accept defaults (no rename, just add).

- [ ] **Step 2: Rename the file**

```bash
mv server/drizzle/migrations/0011_*.sql server/drizzle/migrations/0011_mt_data_foundation.sql
```

Update `server/drizzle/migrations/meta/_journal.json`: find the entry with `"idx": 11` and change its `"tag"` to `"0011_mt_data_foundation"`.

- [ ] **Step 3: Read the generated SQL**

```bash
cat server/drizzle/migrations/0011_mt_data_foundation.sql
```

Confirm:
- `CREATE TABLE` for `tenant`, `tenant_member`, `tenant_invite` (with the CHECK constraints + indexes)
- `ALTER TABLE` adding `tenant_id` (nullable, with `DEFAULT 'default'`) to 11 tables
- `ALTER TABLE` adding `is_super_admin` to `users`

If the `DEFAULT 'default'` isn't being emitted (Drizzle's behavior depends on how the column was declared in the schema), the customization in the next step adds it manually.

- [ ] **Step 4: Append the backfill block to the migration**

Append the following to the end of `server/drizzle/migrations/0011_mt_data_foundation.sql`:

```sql

-- Backfill: seed the default tenant + memberships from existing users.
--> statement-breakpoint

INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
VALUES ('default', 'default', 'Default', 'default', now())
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- Existing rows in scoped tables get tenant_id = 'default' via the column DEFAULT
-- applied at ADD COLUMN time. No explicit UPDATE needed in Postgres 11+.

-- Memberships: every existing user becomes a member of the default tenant with
-- their current users.role. Idempotent.
INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
SELECT 'default', id, role, now()
  FROM "zugzug_app"."users"
ON CONFLICT (tenant_id, user_id) DO NOTHING;
--> statement-breakpoint

-- Indexes that Drizzle didn't generate but the spec calls out for read paths
-- under multi-tenant queries (small at our scale; CONCURRENTLY is overkill —
-- a fresh deploy of this migration will run against a Postgres with at most
-- a few thousand rows total).
CREATE INDEX IF NOT EXISTS "dimension_tenant_idx"
  ON "zugzug_app"."dimension" (tenant_id);
CREATE INDEX IF NOT EXISTS "draft_tenant_idx"
  ON "zugzug_app"."draft" (tenant_id);
CREATE INDEX IF NOT EXISTS "audit_log_tenant_time_idx"
  ON "zugzug_app"."audit_log" (tenant_id, created_at DESC);
```

Note: `--> statement-breakpoint` is Drizzle's marker for splitting the migration into separate statements; Drizzle's runner uses it to know where one logical chunk ends.

If `DEFAULT 'default'` is NOT in the ALTER TABLE ADD COLUMN statements that Drizzle generated, manually edit each one to add it. Pattern:

```sql
-- before:
ALTER TABLE "zugzug_app"."dimension" ADD COLUMN "tenant_id" varchar;
-- after:
ALTER TABLE "zugzug_app"."dimension" ADD COLUMN "tenant_id" varchar DEFAULT 'default';
```

- [ ] **Step 5: Apply against the test DB**

```bash
cd server && DATABASE_URL=postgres://zugzug:zugzug@localhost:55432/zugzug_test bun run db:migrate 2>&1 | tail -10
```

Expected: `migrations applied successfully!` If drizzle-kit eats the error (a known issue we hit earlier in the project — see PR #95 cleanup log), apply the SQL manually with `psql -f` to surface the real error, then fix the SQL.

- [ ] **Step 6: Sanity check the schema state**

```bash
psql postgres://zugzug:zugzug@localhost:55432/zugzug_test -c "\d zugzug_app.tenant"
psql postgres://zugzug:zugzug@localhost:55432/zugzug_test -c "SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'zugzug_app' AND table_name = 'dimension' AND column_name = 'tenant_id';"
```

Expected: `tenant` table exists with the check constraint; `dimension.tenant_id` is nullable with default `'default'`.

- [ ] **Step 7: Commit**

```bash
git add server/drizzle/migrations/0011_mt_data_foundation.sql server/drizzle/migrations/meta/_journal.json server/drizzle/migrations/meta/0011_snapshot.json
git commit -m "feat(db): Deploy 1 migration — tenant tables + backfill + tenant_id cols (MT PR1)"
```

---

## Task 5: `tenant.ts` service — `provisionTenant()` + tests

**Files:**
- Create: `server/src/tenant.ts`
- Create: `server/test/tenant-provision.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/test/tenant-provision.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgGet, pgAll, pgRun } from "../src/pg.ts";
import { provisionTenant, listTenants } from "../src/tenant.ts";

const TEST_TENANT_IDS = ["tprov_a", "tprov_b", "tprov_dup"];

beforeEach(async () => {
  for (const id of TEST_TENANT_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [id]);
  }
});

afterAll(async () => {
  for (const id of TEST_TENANT_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [id]);
  }
});

test("provisionTenant creates a tenant row with slug = id and pointing at default warehouse", async () => {
  const t = await provisionTenant({ id: "tprov_a", label: "Test A" });
  expect(t.id).toBe("tprov_a");
  expect(t.slug).toBe("tprov_a");
  expect(t.label).toBe("Test A");
  expect(t.warehouse_id).toBe("default");

  const row = await pgGet<{ id: string; slug: string; label: string; warehouse_id: string }>(
    `SELECT id, slug, label, warehouse_id FROM "zugzug_app"."tenant" WHERE id = $1`,
    ["tprov_a"],
  );
  expect(row).toEqual({ id: "tprov_a", slug: "tprov_a", label: "Test A", warehouse_id: "default" });
});

test("provisionTenant with a duplicate id rejects with a clear error", async () => {
  await provisionTenant({ id: "tprov_dup", label: "First" });
  let thrown: Error | null = null;
  try {
    await provisionTenant({ id: "tprov_dup", label: "Second" });
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown).not.toBeNull();
  expect(thrown!.message.toLowerCase()).toContain("already exists");
});

test("provisionTenant rejects invalid id formats", async () => {
  for (const bad of ["TPROV", "with-dash", "with space", "1starts-with-digit", "way_too_long_for_a_tenant_id_limit"]) {
    let thrown: Error | null = null;
    try {
      await provisionTenant({ id: bad, label: "x" });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
  }
});

test("listTenants returns the default tenant plus any provisioned ones", async () => {
  await provisionTenant({ id: "tprov_a", label: "Test A" });
  await provisionTenant({ id: "tprov_b", label: "Test B" });

  const all = await listTenants();
  const ids = all.map((t) => t.id);
  expect(ids).toContain("default");
  expect(ids).toContain("tprov_a");
  expect(ids).toContain("tprov_b");
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd server && bun run test tenant-provision 2>&1 | tail -10
```
Expected: FAIL — module `../src/tenant.ts` not found.

- [ ] **Step 3: Implement the service**

Create `server/src/tenant.ts`:

```ts
/* tenant.ts — provisioning + listing for multi-tenant workspaces.
 *
 * This module is the single creation seam for tenants. The HTTP layer doesn't
 * touch the tenant table directly — it calls provisionTenant() (later via the
 * super-admin /api/admin/tenants route in PR 2). The CLI script in
 * scripts/admin.ts also calls in here for PR 1 bootstrap. */

import { pgRun, pgGet, pgAll } from "./pg.ts";
import { AppError } from "./errors.ts";

const TENANT_ID_RE = /^[a-z][a-z0-9_]{0,20}$/;

export interface TenantRecord {
  id: string;
  slug: string;
  label: string;
  warehouse_id: string;
  created_at: Date;
}

export async function provisionTenant(opts: {
  id: string;
  label: string;
  /** Optional URL slug; defaults to id (per Decision 1 in the spec, slug == id in phase 1). */
  slug?: string;
  /** Optional warehouse id; defaults to 'default' (shared warehouse for phase 1). */
  warehouseId?: string;
}): Promise<TenantRecord> {
  const id = opts.id.trim();
  const slug = (opts.slug ?? id).trim();
  const label = opts.label.trim();
  const warehouseId = (opts.warehouseId ?? "default").trim();

  if (!TENANT_ID_RE.test(id)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `tenant id '${id}' must match ${TENANT_ID_RE.source}`,
      400,
    );
  }
  if (!TENANT_ID_RE.test(slug)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `tenant slug '${slug}' must match ${TENANT_ID_RE.source}`,
      400,
    );
  }
  if (!label) {
    throw new AppError("VALIDATION_FAILED", `tenant label cannot be empty`, 400);
  }

  const existing = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."tenant" WHERE id = $1`,
    [id],
  );
  if (existing) {
    throw new AppError("ALREADY_EXISTS", `tenant '${id}' already exists`, 409);
  }

  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $2, $3, $4, now())`,
    [id, slug, label, warehouseId],
  );

  const row = await pgGet<TenantRecord>(
    `SELECT id, slug, label, warehouse_id, created_at
       FROM "zugzug_app"."tenant" WHERE id = $1`,
    [id],
  );
  if (!row) {
    throw new AppError("INTERNAL", `tenant '${id}' disappeared after insert`, 500);
  }
  return row;
}

export async function listTenants(): Promise<TenantRecord[]> {
  return pgAll<TenantRecord>(
    `SELECT id, slug, label, warehouse_id, created_at
       FROM "zugzug_app"."tenant"
      WHERE deleted_at IS NULL
      ORDER BY id`,
  );
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test tenant-provision 2>&1 | tail -10
```
Expected: 4 tests pass.

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: full suite green; ~199 tests (+4 from baseline 195).

- [ ] **Step 5: Commit**

```bash
git add server/src/tenant.ts server/test/tenant-provision.test.ts
git commit -m "feat(tenant): provisionTenant() service + listTenants (MT PR1)"
```

---

## Task 6: `admin.ts` service — `promoteSuperAdmin()` + tests

**Files:**
- Create: `server/src/admin.ts`
- Modify: `server/test/tenant-provision.test.ts` — append two `promoteSuperAdmin` tests (keeps test file count down)

- [ ] **Step 1: Append failing tests to the existing test file**

Append to `server/test/tenant-provision.test.ts`:

```ts
import { promoteSuperAdmin } from "../src/admin.ts";

test("promoteSuperAdmin sets users.is_super_admin = true for an existing user", async () => {
  // Provision a fresh user row to mutate. The users table is global, no tenant_id.
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role)
     VALUES ('u_promo_test', 'Promo Test', 'PT', 'promo@example.com', 'editor')
     ON CONFLICT (id) DO UPDATE SET is_super_admin = false`,
  );

  await promoteSuperAdmin("promo@example.com");

  const row = await pgGet<{ is_super_admin: boolean }>(
    `SELECT is_super_admin FROM "zugzug_app"."users" WHERE email = $1`,
    ["promo@example.com"],
  );
  expect(row?.is_super_admin).toBe(true);
});

test("promoteSuperAdmin rejects when the email does not match any user", async () => {
  let thrown: Error | null = null;
  try {
    await promoteSuperAdmin("noone@example.com");
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown).not.toBeNull();
  expect(thrown!.message.toLowerCase()).toContain("not found");
});
```

Also extend the cleanup at the top of the file (the `TEST_TENANT_IDS` cleanup block) to also delete the test user. Add this constant near the top:

```ts
const TEST_USER_EMAILS = ["promo@example.com"];
```

And inside the `beforeEach` + `afterAll`, append a loop:

```ts
for (const email of TEST_USER_EMAILS) {
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE email = $1`, [email]);
}
```

- [ ] **Step 2: Run, expect fail**

```bash
cd server && bun run test tenant-provision 2>&1 | tail -10
```
Expected: FAIL — module `../src/admin.ts` not found.

- [ ] **Step 3: Implement `admin.ts`**

Create `server/src/admin.ts`:

```ts
/* admin.ts — super-admin service operations.
 *
 * Phase 1: just promotion (CLI-driven). PR 2 adds the HTTP routes that wrap
 * these same primitives behind /api/admin/*. */

import { pgRun, pgGet } from "./pg.ts";
import { AppError } from "./errors.ts";

export async function promoteSuperAdmin(email: string): Promise<{ id: string; email: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    throw new AppError("VALIDATION_FAILED", `'${email}' is not a valid email`, 400);
  }

  const row = await pgGet<{ id: string; email: string }>(
    `SELECT id, email FROM "zugzug_app"."users" WHERE lower(email) = $1`,
    [normalized],
  );
  if (!row) {
    throw new AppError(
      "NOT_FOUND",
      `user with email '${email}' not found — they must sign in once before being promoted`,
      404,
    );
  }

  await pgRun(
    `UPDATE "zugzug_app"."users" SET is_super_admin = true WHERE id = $1`,
    [row.id],
  );
  return row;
}

export async function demoteSuperAdmin(email: string): Promise<{ id: string; email: string }> {
  const normalized = email.trim().toLowerCase();
  const row = await pgGet<{ id: string; email: string }>(
    `SELECT id, email FROM "zugzug_app"."users" WHERE lower(email) = $1`,
    [normalized],
  );
  if (!row) {
    throw new AppError("NOT_FOUND", `user with email '${email}' not found`, 404);
  }
  await pgRun(
    `UPDATE "zugzug_app"."users" SET is_super_admin = false WHERE id = $1`,
    [row.id],
  );
  return row;
}
```

`demoteSuperAdmin` isn't covered by tests in this PR — it's symmetric with `promoteSuperAdmin` and is shipped now for completeness (one less follow-up).

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test tenant-provision 2>&1 | tail -10
```
Expected: 6 tests pass (4 from Task 5 + 2 new).

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: ~201 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/admin.ts server/test/tenant-provision.test.ts
git commit -m "feat(admin): promoteSuperAdmin + demoteSuperAdmin service helpers (MT PR1)"
```

---

## Task 7: Admin CLI scaffold

**Files:**
- Create: `server/scripts/admin.ts`
- Modify: `server/package.json` — add `"admin"` script

- [ ] **Step 1: Add the script entry to `server/package.json`**

In the `"scripts"` block, add:

```json
"admin": "bun run scripts/admin.ts",
```

(Place it next to `"quickstart"` and `"reset-password"`.)

- [ ] **Step 2: Implement the CLI dispatcher**

Create `server/scripts/admin.ts`:

```ts
#!/usr/bin/env bun
/* admin.ts — super-admin CLI.
 *
 * Usage:
 *   bun run admin -- create-tenant <id> <label> [--warehouse=<id>] [--slug=<slug>]
 *   bun run admin -- promote-super-admin <email>
 *   bun run admin -- demote-super-admin <email>
 *   bun run admin -- list-tenants
 *
 * The CLI reads DATABASE_URL from .env (Bun auto-loads). Run from server/.
 */

import { provisionTenant, listTenants } from "../src/tenant.ts";
import { promoteSuperAdmin, demoteSuperAdmin } from "../src/admin.ts";
import { AppError } from "../src/errors.ts";

const HELP = `Zug Zug admin CLI

Usage:
  bun run admin -- create-tenant <id> <label> [--warehouse=<id>] [--slug=<slug>]
  bun run admin -- promote-super-admin <email>
  bun run admin -- demote-super-admin <email>
  bun run admin -- list-tenants

Examples:
  bun run admin -- create-tenant sportsbook "Sportsbook"
  bun run admin -- promote-super-admin frederik.hagelund@example.com
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): Args {
  // argv comes from process.argv.slice(2) — already strips bun + script path.
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of rest) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        flags[arg.slice(2)] = "true";
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: command ?? "", positional, flags };
}

async function run(args: Args): Promise<void> {
  switch (args.command) {
    case "create-tenant": {
      const [id, ...labelParts] = args.positional;
      if (!id || labelParts.length === 0) {
        console.error("usage: bun run admin -- create-tenant <id> <label> [--warehouse=<id>] [--slug=<slug>]");
        process.exit(1);
      }
      const label = labelParts.join(" ");
      const t = await provisionTenant({
        id,
        label,
        slug: args.flags.slug,
        warehouseId: args.flags.warehouse,
      });
      console.log(`✓ created tenant ${t.id} (${t.label}) → warehouse ${t.warehouse_id}`);
      return;
    }
    case "promote-super-admin": {
      const [email] = args.positional;
      if (!email) {
        console.error("usage: bun run admin -- promote-super-admin <email>");
        process.exit(1);
      }
      const u = await promoteSuperAdmin(email);
      console.log(`✓ promoted ${u.email} (id=${u.id}) to super-admin`);
      return;
    }
    case "demote-super-admin": {
      const [email] = args.positional;
      if (!email) {
        console.error("usage: bun run admin -- demote-super-admin <email>");
        process.exit(1);
      }
      const u = await demoteSuperAdmin(email);
      console.log(`✓ demoted ${u.email} (id=${u.id}) from super-admin`);
      return;
    }
    case "list-tenants": {
      const tenants = await listTenants();
      for (const t of tenants) {
        console.log(`${t.id.padEnd(24)} ${t.label.padEnd(32)} warehouse=${t.warehouse_id}`);
      }
      return;
    }
    case "":
    case "--help":
    case "-h":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${args.command}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

// Only invoke the dispatcher when run as a script — keeps parseArgs() importable
// from the test file without triggering DB calls at import time.
if (import.meta.path === Bun.main) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof AppError) {
      console.error(`✗ ${e.code}: ${e.message}`);
      process.exit(1);
    }
    console.error("✗ unexpected error:", e);
    process.exit(1);
  }
}
```

- [ ] **Step 3: Add CLI parsing tests**

Create `server/test/admin-cli.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { parseArgs } from "../scripts/admin.ts";

test("parseArgs: create-tenant with id + multi-word label", () => {
  const args = parseArgs(["create-tenant", "sportsbook", "Sportsbook", "Team"]);
  expect(args.command).toBe("create-tenant");
  expect(args.positional).toEqual(["sportsbook", "Sportsbook", "Team"]);
  expect(args.flags).toEqual({});
});

test("parseArgs: flags split from positionals", () => {
  const args = parseArgs([
    "create-tenant",
    "sportsbook",
    "Sportsbook",
    "--warehouse=alt",
    "--slug=sb",
  ]);
  expect(args.command).toBe("create-tenant");
  expect(args.positional).toEqual(["sportsbook", "Sportsbook"]);
  expect(args.flags).toEqual({ warehouse: "alt", slug: "sb" });
});

test("parseArgs: promote-super-admin captures the email", () => {
  const args = parseArgs(["promote-super-admin", "user@example.com"]);
  expect(args.command).toBe("promote-super-admin");
  expect(args.positional).toEqual(["user@example.com"]);
});

test("parseArgs: empty argv → empty command (will print help)", () => {
  const args = parseArgs([]);
  expect(args.command).toBe("");
  expect(args.positional).toEqual([]);
});

test("parseArgs: bare --flag without = treated as boolean", () => {
  const args = parseArgs(["create-tenant", "x", "X", "--force"]);
  expect(args.flags).toEqual({ force: "true" });
});
```

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test admin-cli 2>&1 | tail -10
```
Expected: 5 tests pass.

- [ ] **Step 5: End-to-end smoke test**

```bash
cd server && bun run admin -- list-tenants
```
Expected: prints `default` row.

```bash
cd server && bun run admin -- create-tenant test_cli_e2e "End-to-end CLI test"
```
Expected: `✓ created tenant test_cli_e2e ...`. Then:

```bash
cd server && bun run admin -- list-tenants
```
Expected: prints both `default` and `test_cli_e2e`.

Clean up the smoke-test tenant:

```bash
psql "$DATABASE_URL" -c "DELETE FROM \"zugzug_app\".\"tenant\" WHERE id = 'test_cli_e2e';"
```

- [ ] **Step 6: Commit**

```bash
git add server/scripts/admin.ts server/test/admin-cli.test.ts server/package.json
git commit -m "feat(scripts): admin CLI — create-tenant + promote-super-admin (MT PR1)"
```

---

## Task 8: Migration backfill verification test

**Files:**
- Create: `server/test/tenant-migration.test.ts`

This task adds a regression test that verifies the migration left the DB in the right state — specifically, that `tenant_member` got seeded from `users.role` for the default tenant.

- [ ] **Step 1: Write the test**

Create `server/test/tenant-migration.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { pgGet, pgAll } from "../src/pg.ts";

test("Deploy 1 migration seeded the 'default' tenant", async () => {
  const row = await pgGet<{ id: string; slug: string; label: string; warehouse_id: string }>(
    `SELECT id, slug, label, warehouse_id FROM "zugzug_app"."tenant" WHERE id = 'default'`,
  );
  expect(row?.id).toBe("default");
  expect(row?.slug).toBe("default");
  expect(row?.warehouse_id).toBe("default");
});

test("Deploy 1 migration created tenant_member rows for every existing user with their role", async () => {
  const users = await pgAll<{ id: string; role: string }>(
    `SELECT id, role FROM "zugzug_app"."users"`,
  );
  // The migration ran ON CONFLICT DO NOTHING, so re-running these tests after a
  // fresh user is added without re-running the migration would NOT add the new
  // member. That's acceptable — the migration is one-shot. Just verify the
  // pre-migration users got their seat.
  for (const u of users) {
    const member = await pgGet<{ role: string }>(
      `SELECT role FROM "zugzug_app"."tenant_member"
        WHERE tenant_id = 'default' AND user_id = $1`,
      [u.id],
    );
    if (member) {
      expect(member.role).toBe(u.role);
    }
    // If member is null, the user was created AFTER the migration. Don't fail
    // — that's expected for any test that creates a fresh user (which then
    // becomes a member via the new sign-in flow shipped in PR 2).
  }
});

test("Deploy 1 added is_super_admin to users with default false", async () => {
  const col = await pgGet<{ column_default: string; is_nullable: string }>(
    `SELECT column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'zugzug_app'
        AND table_name = 'users'
        AND column_name = 'is_super_admin'`,
  );
  expect(col?.column_default?.toLowerCase()).toContain("false");
  expect(col?.is_nullable).toBe("NO");
});

test("Deploy 1 added tenant_id column to dimension with DEFAULT 'default'", async () => {
  const col = await pgGet<{ column_default: string }>(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_schema = 'zugzug_app'
        AND table_name = 'dimension'
        AND column_name = 'tenant_id'`,
  );
  expect(col?.column_default).toContain("default");
});

test("Existing dimension rows have tenant_id = 'default' after the migration", async () => {
  const orphans = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."dimension"
      WHERE tenant_id IS NULL OR tenant_id != 'default'`,
  );
  expect(orphans?.n).toBe(0);
});
```

- [ ] **Step 2: Run, expect pass**

```bash
cd server && bun run test tenant-migration 2>&1 | tail -10
```
Expected: 5 tests pass.

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: ~206 tests total (+5 from Task 7's 201).

- [ ] **Step 3: Commit**

```bash
git add server/test/tenant-migration.test.ts
git commit -m "test(migration): verify Deploy 1 backfill state (MT PR1)"
```

---

## Task 9: Verification gate + PR

**Files:** none beyond what's already changed.

- [ ] **Step 1: Full server gate**

```bash
cd server && bun run typecheck && bun run lint && bun run format:check && bun run test 2>&1 | tail -10
```
Expected: all green. ~206 tests.

- [ ] **Step 2: App gate (unchanged in this PR — sanity check)**

```bash
cd app && bun run typecheck && bun run lint && bun run format:check && bun run test 2>&1 | tail -5
```
Expected: green. Same count as baseline (no app changes in PR 1).

- [ ] **Step 3: Manual smoke**

```bash
cd server && bun run admin -- list-tenants
```
Expected: shows the `default` row.

```bash
cd server && bun run admin -- create-tenant smoke_pr1 "Smoke PR1 Test"
cd server && bun run admin -- list-tenants
```
Expected: shows `default` + `smoke_pr1`.

Tear down the smoke tenant before opening the PR:

```bash
psql "postgres://zugzug:zugzug@localhost:55432/zugzug_test" -c "DELETE FROM \"zugzug_app\".\"tenant\" WHERE id = 'smoke_pr1';"
```

- [ ] **Step 4: Verify the existing app still works against the migrated schema**

Start the server pointing at the migrated test DB:

```bash
cd server && DATABASE_URL=postgres://zugzug:zugzug@localhost:55432/zugzug_test ATTACH_WAREHOUSE=false bun run start
```

In another shell:

```bash
curl -sS http://localhost:8787/api/dimensions
```

Expected: response is the same shape as before the migration — the `tenant_id` columns are populated server-side but the existing `repo-*.ts` code ignores them. App behavior unchanged.

Kill the server (Ctrl-C).

- [ ] **Step 5: Push branch**

```bash
git push -u origin mt-pr1-data-foundation
```

- [ ] **Step 6: Open PR**

```bash
gh pr create --title "Multi-tenant PR 1: data foundation (Deploy 1 migration + admin CLI)" --body "$(cat <<'EOF'
## Summary

First of 5 PRs implementing multi-tenant workspaces (epic #59). Pure additive migration + admin CLI. **No HTTP API behavior change.** Existing single-tenant code path keeps working; every existing row is owned by the `default` tenant.

**Database**
- New tables: `tenant`, `tenant_member`, `tenant_invite` with CHECK constraints (slug format, role enum)
- `tenant_id VARCHAR DEFAULT 'default'` added to 11 scoped tables (`dimension`, `dimension_source`, `dimension_field`, `source_stat`, `draft`, `audit_log`, `preferences`, `active_sessions`, `ai_hint_cache`, `canonical_version`, `scan_run`)
- `users.is_super_admin BOOLEAN NOT NULL DEFAULT false`
- Default tenant seeded; every existing user becomes an `admin/editor/viewer` member of `default` with their current `users.role`. Idempotent.

**Service layer**
- `provisionTenant({ id, label, slug?, warehouseId? })` — slug-format validated, rejects duplicates with `ALREADY_EXISTS` (HTTP 409 in PR 2's route)
- `listTenants()`
- `promoteSuperAdmin(email)` + `demoteSuperAdmin(email)`

**CLI**
- `bun run admin -- create-tenant <id> <label>` — provisions a new workspace
- `bun run admin -- promote-super-admin <email>` — flips `is_super_admin` on an existing user
- `bun run admin -- list-tenants`
- `bun run admin -- demote-super-admin <email>`

Spec: `docs/superpowers/specs/2026-06-07-multi-tenant-design.md`
Plan: `docs/superpowers/plans/2026-06-10-multi-tenant-pr1-data-foundation.md`

## What's NOT in this PR (later in the series)
- PR 2: `TenantRepo` + `withTenantTx` + auth middleware + `/api/t/:slug/*` + `/api/admin/*` routes + scheduler refactor
- PR 3: client `apiFetch` + ESLint rule + ~50 fetch-site migration
- PR 4: UI shell (`/app/:slug/*` routes + `<TenantLayout>` + workspace switcher + Settings → Team)
- PR 5: Deploy 2 cutover (NOT NULL, FKs, PK swaps, RLS, drop `allowed_emails`, drop `users.role`)

## Test plan
- [ ] `cd server && bun run typecheck && bun run lint && bun run format:check && bun run test` — green (~206 tests, +11 from baseline)
- [ ] `cd app && bun run typecheck && bun run lint && bun run format:check && bun run test` — green (no app changes)
- [ ] Migration applies cleanly against a fresh DB: `DATABASE_URL=... bun run db:migrate`
- [ ] Migration is idempotent: re-running `db:migrate` is a no-op
- [ ] Manual: `bun run admin -- list-tenants` shows `default`; `create-tenant` + re-`list` shows the new one
- [ ] Manual: `GET /api/dimensions` on the migrated DB returns the same shape as before the migration (existing app code unchanged)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Verify CI**

```bash
gh pr checks --watch
```
Expected: app + server + license-placeholder-check + notice-up-to-date all pass.

---

## Self-review

**Spec coverage matrix (PR 1 scope only):**

| Spec deliverable | Task |
|---|---|
| `tenant` table with `CHECK (id ~ '^[a-z][a-z0-9_]{0,20}$')` | Task 2 |
| `tenant_member` with composite PK + role CHECK | Task 2 |
| `tenant_invite` with composite PK + role CHECK | Task 2 |
| `users.is_super_admin BOOLEAN NOT NULL DEFAULT false` | Task 3 |
| `tenant_id VARCHAR DEFAULT 'default'` on 11 scoped tables | Task 3 + 4 |
| Default tenant seeded | Task 4 |
| Backfill `users.role` → `tenant_member.role` for default | Task 4 |
| `dimension_tenant_idx`, `draft_tenant_idx`, `audit_log_tenant_time_idx` | Task 4 |
| `provisionTenant()` service | Task 5 |
| `promoteSuperAdmin()` service | Task 6 |
| Admin CLI: `create-tenant`, `promote-super-admin`, `demote-super-admin`, `list-tenants` | Task 7 |
| Migration regression tests | Task 8 |

**Type consistency:**

- `TenantRecord` shape (`{id, slug, label, warehouse_id, created_at}`) is consistent across Task 5 (used in `provisionTenant`, `listTenants`) and Task 7 (CLI consumes via the service functions).
- Args parsing API (`parseArgs(argv): {command, positional, flags}`) consistent between Task 7's implementation and Task 7's tests.
- `AppError` codes used: `VALIDATION_FAILED`, `ALREADY_EXISTS`, `NOT_FOUND`, `INTERNAL` — all part of the existing `ErrorCode` union in `server/src/errors.ts`. No new codes added in this PR.

**Placeholder scan:** no TBDs. The "Deploy 2 (later PR)" references are roadmap statements, not placeholders.

**Risks flagged for PR 1:**

- **Drizzle-kit error swallowing.** We hit this in PR #95 (E1-B) — `db:migrate` exits 1 silently. Task 4 step 5 acknowledges this and falls back to `psql -f`. Worth re-verifying the same pattern works here; if drizzle-kit succeeds cleanly that's better.
- **`tenant_member` seed from `users.role`.** The seed is `ON CONFLICT DO NOTHING`. If a user was created between Deploy 1 application and Deploy 2 (the window during which this PR's migration is the latest applied), their `users.role` is set but no `tenant_member` row exists. PR 2's sign-in flow handles this by creating the membership on next login — but during this PR's lifetime, that user wouldn't have a workspace association. Acceptable for an internal tool in transition.
- **CHECK constraint `id ~ regex`.** The existing 'default' seed value matches (`'default'` is all-lowercase 7 chars). Any pre-existing user-supplied tenant ids would need to match too — there are none yet, so safe.
- **`scan_run` may not yet exist in schema.ts.** Task 3 hedges with "if present — grep". If the column-add fails because the table doesn't exist, the implementer should fall back to schema.ts inspection and either add the table here (out of scope for PR 1) or skip the column for now and note as a follow-up.
