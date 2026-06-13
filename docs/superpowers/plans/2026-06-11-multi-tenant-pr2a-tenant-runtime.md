# Multi-tenant PR 2a — Tenant runtime + first vertical slice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the multi-tenant request lifecycle end-to-end on a thin vertical slice. After this PR every HTTP request has a resolved `tenantId` + per-tenant `role`, a `TenantRepo` request-scoped surface is the only DB interface for tenant routes, and `preferences` + `audit` are isolated per workspace. Existing `/api/*` keeps working unchanged under the `default` tenant.

**Architecture:** Three new modules — `pgTxScoped()` in `pg.ts` (transaction with `SET LOCAL app.tenant_id`), `tenant-middleware.ts` (slug → tenant + membership check + super-admin bypass), and `TenantRepo` class (request-scoped DB surface holding `{tenantId, role, tx}`). One server-side seam: `handle()` resolves the tenant once at entry and shadows the module `repo` import with a per-request `TenantRepo` instance. The vertical slice (`preferences` + `audit`) proves isolation works without yet touching the ~40 other repo functions — that's PR2b. **Tenants = Linear-style switchable workspaces.** One user, many memberships; session is user-scoped; the active workspace is URL state.

**Branch:** `mt-pr2a-tenant-runtime` off `main` (post-merge of #96).

**Tech Stack:** Drizzle migrations (none new in PR2a), Bun + postgres.js, bun:test. No new dependencies. Builds on PR1's `tenant` / `tenant_member` / `tenant_invite` tables and `provisionTenant()` service.

**Spec:** `docs/superpowers/specs/2026-06-07-multi-tenant-design.md` — relevant sections: "Auth & request lifecycle", "TenantRepo", "Sign-in flow", "Super-admin routes".

**Prereq:** PR #96 (MT PR1) merged to `main`. Confirm with `git log --oneline main | head -5` showing the PR1 commits before starting.

---

## File structure (post-PR)

```
server/src/pg.ts                                  MOD — add pgTxScoped(tenantId, fn)
server/src/tenant.ts                              MOD — add tenantBySlug, listMembershipsForUser, memberRole, acceptInvitesFor
server/src/tenant-middleware.ts                   NEW — resolveTenantContext(req, user) helper
server/src/tenant-repo.ts                         NEW — TenantRepo class with preferences/audit methods
server/src/repo-meta.ts                           MOD — preferences/audit gain WHERE/INSERT tenant_id; existing free fns kept (legacy routes still call them; PR2b removes them)
server/src/server.ts                              MOD — route /api/t/:slug/* through middleware + TenantRepo; /api/admin/tenants routes
server/src/auth-password.ts                       MOD — after login, accept any pending invites (idempotent)
server/src/auth-oidc.ts                           MOD — same as password
server/test/pg-tx-scoped.test.ts                  NEW — pgTxScoped + SET LOCAL semantics
server/test/tenant-membership.test.ts             NEW — tenantBySlug, memberRole, acceptInvitesFor
server/test/tenant-middleware.test.ts             NEW — resolveTenantContext (member + super-admin + 403)
server/test/tenant-repo-preferences.test.ts       NEW — TenantRepo.preferences isolation
server/test/tenant-routes-preferences.test.ts     NEW — GET/PUT /api/t/:slug/preferences isolation
server/test/admin-tenants-route.test.ts           NEW — POST /api/admin/tenants happy + non-admin 403
server/test/auth-invite-acceptance.test.ts        NEW — invite → membership flip on login
```

---

## Task 1: Branch kickoff + baseline

**Files:** none.

- [ ] **Step 1: Confirm PR1 merged**

```bash
git log --oneline main | head -10 | grep -c "MT PR1"
```
Expected: at least 5 (the PR1 commits are present on main).

- [ ] **Step 2: Create branch**

```bash
git checkout main && git pull --ff-only origin main && git checkout -b mt-pr2a-tenant-runtime
```

- [ ] **Step 3: Baseline test counts**

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: roughly 211 passing (PR1 baseline + Drizzle migrations applied).

```bash
cd app && bun run test 2>&1 | tail -5
```
Expected: roughly 178 passing + 1 skipped. No app changes in PR2a, so this stays green throughout.

- [ ] **Step 4: Confirm migrated test DB has PR1 schema**

```bash
psql postgres://zugzug:zugzug@localhost:55432/zugzug_test -c "\dt zugzug_app.tenant*"
```
Expected: rows for `tenant`, `tenant_invite`, `tenant_member`.

```bash
psql postgres://zugzug:zugzug@localhost:55432/zugzug_test -c "SELECT id, slug FROM zugzug_app.tenant"
```
Expected: at least `default | default`.

---

## Task 2: `pgTxScoped()` — transaction with SET LOCAL app.tenant_id

**Files:**
- Modify: `server/src/pg.ts` — append `pgTxScoped`
- Create: `server/test/pg-tx-scoped.test.ts`

**Why this exists:** Every tenant route runs its DB work inside a transaction that begins with `SET LOCAL app.tenant_id = $1`. In PR2a this is the only mechanism distinguishing tenants; in Deploy 2 (PR5) RLS policies read `current_setting('app.tenant_id')` and enforce isolation server-side. We ship the helper now so the route code is already shaped right.

- [ ] **Step 1: Write failing test**

Create `server/test/pg-tx-scoped.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { pgTxScoped } from "../src/pg.ts";

test("pgTxScoped exposes app.tenant_id via current_setting inside the tx", async () => {
  const seen = await pgTxScoped("default", async (tx) => {
    const row = await tx.get<{ t: string }>(`SELECT current_setting('app.tenant_id') AS t`);
    return row?.t;
  });
  expect(seen).toBe("default");
});

test("pgTxScoped isolates settings between transactions (SET LOCAL semantics)", async () => {
  const a = await pgTxScoped("tprov_a_setting", async (tx) =>
    (await tx.get<{ t: string }>(`SELECT current_setting('app.tenant_id') AS t`))?.t,
  );
  const b = await pgTxScoped("tprov_b_setting", async (tx) =>
    (await tx.get<{ t: string }>(`SELECT current_setting('app.tenant_id') AS t`))?.t,
  );
  expect(a).toBe("tprov_a_setting");
  expect(b).toBe("tprov_b_setting");
});

test("pgTxScoped rolls back if fn throws", async () => {
  // Use audit_log as a scratch table — we can roll back an INSERT cleanly.
  const probeId = `probe_${Date.now()}`;
  let thrown: Error | null = null;
  try {
    await pgTxScoped("default", async (tx) => {
      await tx.run(
        `INSERT INTO "zugzug_app"."audit_log" (id, created_at, user_id, action, detail)
         VALUES ($1, now(), 'u_test', 'probe', 'rollback-test')`,
        [probeId],
      );
      throw new Error("rollback me");
    });
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown?.message).toBe("rollback me");

  // Re-check outside the tx — row must not exist.
  const { pgGet } = await import("../src/pg.ts");
  const row = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."audit_log" WHERE id = $1`,
    [probeId],
  );
  expect(row).toBeNull();
});

test("pgTxScoped rejects invalid tenant id (defense-in-depth)", async () => {
  let thrown: Error | null = null;
  try {
    await pgTxScoped("' OR 1=1 --", async () => "noop");
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown).not.toBeNull();
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd server && bun run test pg-tx-scoped 2>&1 | tail -10
```
Expected: FAIL — `pgTxScoped` not exported.

- [ ] **Step 3: Implement `pgTxScoped` in `server/src/pg.ts`**

Append to `server/src/pg.ts`:

```ts
const TENANT_ID_RE = /^[a-z][a-z0-9_]{0,20}$|^\*$/;
// '*' is the super-admin wildcard; RLS in Deploy 2 treats '*' as "no filter".

export function pgTxScoped<T>(tenantId: string, fn: (tx: TxHelpers) => Promise<T>): Promise<T> {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`pgTxScoped: invalid tenant id '${tenantId}'`);
  }
  return pool.begin(async (txSql) => {
    // SET LOCAL is bound to the surrounding tx; postgres.js bridges this transparently.
    // Quote the value (it's already validated against the regex) — pg.query parameters
    // don't substitute into SET statements per Postgres semantics.
    await txSql.unsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const helpers: TxHelpers = {
      all: async <U = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<U[]> => {
        const rows = await txSql.unsafe(q, p as postgres.ParameterOrJSON<never>[]);
        return rows as unknown as U[];
      },
      get: async <U = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<U | null> => {
        const rows = await helpers.all<U>(q, p);
        return rows[0] ?? null;
      },
      run: async (q: string, p: unknown[] = []): Promise<void> => {
        await txSql.unsafe(q, p as postgres.ParameterOrJSON<never>[]);
      },
    };
    return fn(helpers) as unknown as T;
  }) as Promise<T>;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test pg-tx-scoped 2>&1 | tail -10
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/pg.ts server/test/pg-tx-scoped.test.ts
git commit -m "feat(pg): pgTxScoped() — tx with SET LOCAL app.tenant_id (MT PR2a)"
```

---

## Task 3: `tenant.ts` — membership + invite helpers

**Files:**
- Modify: `server/src/tenant.ts` — append `tenantBySlug`, `listMembershipsForUser`, `memberRole`, `acceptInvitesFor`
- Create: `server/test/tenant-membership.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/test/tenant-membership.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";
import {
  provisionTenant,
  tenantBySlug,
  listMembershipsForUser,
  memberRole,
  acceptInvitesFor,
} from "../src/tenant.ts";

const T_IDS = ["tmem_a", "tmem_b"];
const U_IDS = ["u_member_a", "u_member_b", "u_invitee"];
const EMAILS = ["invitee@example.com"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function makeUser(id: string, email: string): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role)
     VALUES ($1, $1, 'XX', $2, 'editor')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [id, email],
  );
}

test("tenantBySlug returns the tenant row or null", async () => {
  await provisionTenant({ id: "tmem_a", label: "A" });
  const found = await tenantBySlug("tmem_a");
  expect(found?.id).toBe("tmem_a");
  expect(await tenantBySlug("tmem_notthere")).toBeNull();
});

test("listMembershipsForUser returns all tenants the user is a member of, ordered by label", async () => {
  await provisionTenant({ id: "tmem_a", label: "Alpha" });
  await provisionTenant({ id: "tmem_b", label: "Bravo" });
  await makeUser("u_member_a", "a@example.com");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, 'admin', now()), ($3, $2, 'editor', now())`,
    ["tmem_a", "u_member_a", "tmem_b"],
  );

  const memberships = await listMembershipsForUser("u_member_a");
  expect(memberships.map((m) => m.tenant.id)).toEqual(["tmem_a", "tmem_b"]);
  expect(memberships.find((m) => m.tenant.id === "tmem_a")?.role).toBe("admin");
  expect(memberships.find((m) => m.tenant.id === "tmem_b")?.role).toBe("editor");
});

test("memberRole returns the role for an existing membership", async () => {
  await provisionTenant({ id: "tmem_a", label: "A" });
  await makeUser("u_member_a", "a@example.com");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ('tmem_a', 'u_member_a', 'viewer', now())`,
  );
  expect(await memberRole("tmem_a", "u_member_a")).toBe("viewer");
  expect(await memberRole("tmem_a", "u_member_b")).toBeNull();
});

test("acceptInvitesFor converts every pending invite for the email into a tenant_member row and deletes the invites", async () => {
  await provisionTenant({ id: "tmem_a", label: "A" });
  await provisionTenant({ id: "tmem_b", label: "B" });
  await makeUser("u_invitee", "invitee@example.com");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_invite" (tenant_id, email, role, invited_by, invited_at)
     VALUES ('tmem_a', 'invitee@example.com', 'editor', 'u_member_a', now()),
            ('tmem_b', 'invitee@example.com', 'viewer', 'u_member_a', now())`,
  );

  const accepted = await acceptInvitesFor("u_invitee", "invitee@example.com");
  expect(accepted.map((a) => a.tenant_id).sort()).toEqual(["tmem_a", "tmem_b"]);

  const memberships = await listMembershipsForUser("u_invitee");
  expect(memberships.map((m) => `${m.tenant.id}:${m.role}`).sort()).toEqual([
    "tmem_a:editor",
    "tmem_b:viewer",
  ]);
  const remaining = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."tenant_invite" WHERE lower(email) = $1`,
    ["invitee@example.com"],
  );
  expect(remaining?.n).toBe(0);
});

test("acceptInvitesFor is idempotent — running twice produces the same memberships, no error", async () => {
  await provisionTenant({ id: "tmem_a", label: "A" });
  await makeUser("u_invitee", "invitee@example.com");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_invite" (tenant_id, email, role, invited_by, invited_at)
     VALUES ('tmem_a', 'invitee@example.com', 'editor', 'u_member_a', now())`,
  );
  await acceptInvitesFor("u_invitee", "invitee@example.com");
  await acceptInvitesFor("u_invitee", "invitee@example.com");
  const memberships = await listMembershipsForUser("u_invitee");
  expect(memberships).toHaveLength(1);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd server && bun run test tenant-membership 2>&1 | tail -10
```
Expected: FAIL — `tenantBySlug` etc. not exported.

- [ ] **Step 3: Append to `server/src/tenant.ts`**

```ts
export interface Membership {
  tenant: TenantRecord;
  role: "admin" | "editor" | "viewer";
}

export async function tenantBySlug(slug: string): Promise<TenantRecord | null> {
  return pgGet<TenantRecord>(
    `SELECT id, slug, label, warehouse_id, created_at
       FROM "zugzug_app"."tenant"
      WHERE slug = $1 AND deleted_at IS NULL`,
    [slug],
  );
}

export async function listMembershipsForUser(userId: string): Promise<Membership[]> {
  const rows = await pgAll<{
    tid: string;
    slug: string;
    label: string;
    warehouse_id: string;
    created_at: Date;
    role: "admin" | "editor" | "viewer";
  }>(
    `SELECT t.id AS tid, t.slug, t.label, t.warehouse_id, t.created_at, tm.role
       FROM "zugzug_app"."tenant_member" tm
       JOIN "zugzug_app"."tenant" t ON t.id = tm.tenant_id
      WHERE tm.user_id = $1 AND t.deleted_at IS NULL
      ORDER BY t.label`,
    [userId],
  );
  return rows.map((r) => ({
    tenant: {
      id: r.tid,
      slug: r.slug,
      label: r.label,
      warehouse_id: r.warehouse_id,
      created_at: r.created_at,
    },
    role: r.role,
  }));
}

export async function memberRole(
  tenantId: string,
  userId: string,
): Promise<"admin" | "editor" | "viewer" | null> {
  const row = await pgGet<{ role: "admin" | "editor" | "viewer" }>(
    `SELECT role FROM "zugzug_app"."tenant_member"
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return row?.role ?? null;
}

export interface AcceptedInvite {
  tenant_id: string;
  role: "admin" | "editor" | "viewer";
}

/** Atomically convert every pending tenant_invite for `email` into a tenant_member
 *  row for `userId`. Returns the accepted invites. Idempotent: if a membership
 *  already exists (e.g. invite was already accepted in a concurrent login), the
 *  invite is still removed and no error is raised. */
export async function acceptInvitesFor(
  userId: string,
  email: string,
): Promise<AcceptedInvite[]> {
  const normalized = email.trim().toLowerCase();
  // postgres.js .begin() gives us a transaction handle; we use it directly here
  // instead of pgTxScoped because the invite-acceptance flow legitimately spans
  // the global users/tenant_invite tables and isn't bound to any one tenant.
  return pgTxRaw(async (tx) => {
    const invites = await tx.all<{ tenant_id: string; role: "admin" | "editor" | "viewer" }>(
      `SELECT tenant_id, role
         FROM "zugzug_app"."tenant_invite"
        WHERE lower(email) = $1
        FOR UPDATE`,
      [normalized],
    );
    if (invites.length === 0) return [];

    await tx.run(
      `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
       SELECT tenant_id, $1, role, now()
         FROM "zugzug_app"."tenant_invite"
        WHERE lower(email) = $2
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [userId, normalized],
    );
    await tx.run(
      `DELETE FROM "zugzug_app"."tenant_invite" WHERE lower(email) = $1`,
      [normalized],
    );
    return invites;
  });
}
```

The above uses a `pgTxRaw` helper that wraps `pool.begin()` without the SET LOCAL — add it to `pg.ts` alongside `pgTxScoped` since this is the second consumer:

In `server/src/pg.ts`, rename the current `pgTx` to `pgTxRaw` and re-export `pgTx` as an alias for back-compat (the existing one consumer is `tables.ts`):

Add at the bottom of `server/src/pg.ts`:

```ts
// Alias: legacy name. New code should call pgTxRaw or pgTxScoped explicitly.
export const pgTx = pgTxRaw;
```

Rename the current `pgTx` body to `pgTxRaw`. The existing import in `tables.ts` keeps working via the alias.

Update the import block in `tenant.ts`:

```ts
import { pgRun, pgGet, pgAll, pgTxRaw } from "./pg.ts";
```

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test tenant-membership 2>&1 | tail -10
```
Expected: 5 tests pass.

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: full suite green (~220 tests, +9 from baseline).

- [ ] **Step 5: Commit**

```bash
git add server/src/pg.ts server/src/tenant.ts server/test/tenant-membership.test.ts
git commit -m "feat(tenant): membership + invite helpers (MT PR2a)"
```

---

## Task 4: `tenant-middleware.ts` — resolve tenant + check membership

**Files:**
- Create: `server/src/tenant-middleware.ts`
- Create: `server/test/tenant-middleware.test.ts`

**What this does:** Given a parsed URL and a session user, returns `{tenantId, role, isSuperAdmin}` or throws an `AppError`. The HTTP layer in Task 8 calls this once per request before instantiating the `TenantRepo`.

- [ ] **Step 1: Write failing tests**

Create `server/test/tenant-middleware.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { resolveTenantContext, type TenantContext } from "../src/tenant-middleware.ts";
import { AppError } from "../src/errors.ts";
import type { SessionUser } from "../src/auth.ts";

const T_IDS = ["tctx_a"];
const U_IDS = ["u_ctx_member", "u_ctx_outsider", "u_ctx_super"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

function user(id: string, isSuperAdmin = false): SessionUser {
  return { id, name: id, email: `${id}@x`, initials: "XX", role: "editor" };
}

async function makeUser(id: string, isSuperAdmin = false): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, $1, 'XX', $2, 'editor', $3)`,
    [id, `${id}@x`, isSuperAdmin],
  );
}

test("resolveTenantContext: tenant route + valid member → returns {tenantId, role, isSuperAdmin=false}", async () => {
  await provisionTenant({ id: "tctx_a", label: "A" });
  await makeUser("u_ctx_member");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ('tctx_a', 'u_ctx_member', 'admin', now())`,
  );

  const ctx: TenantContext = await resolveTenantContext({
    pathname: "/api/t/tctx_a/preferences",
    user: user("u_ctx_member"),
  });
  expect(ctx).toEqual({ tenantId: "tctx_a", role: "admin", isSuperAdmin: false });
});

test("resolveTenantContext: tenant route + non-member → AppError 403", async () => {
  await provisionTenant({ id: "tctx_a", label: "A" });
  await makeUser("u_ctx_outsider");

  let thrown: AppError | null = null;
  try {
    await resolveTenantContext({
      pathname: "/api/t/tctx_a/preferences",
      user: user("u_ctx_outsider"),
    });
  } catch (e) {
    if (e instanceof AppError) thrown = e;
  }
  expect(thrown?.code).toBe("FORBIDDEN");
  expect(thrown?.status).toBe(403);
});

test("resolveTenantContext: tenant route + super-admin non-member → bypass, role='admin'", async () => {
  await provisionTenant({ id: "tctx_a", label: "A" });
  await makeUser("u_ctx_super", true);

  const ctx = await resolveTenantContext({
    pathname: "/api/t/tctx_a/preferences",
    user: user("u_ctx_super"),
    isSuperAdmin: true,
  });
  expect(ctx).toEqual({ tenantId: "tctx_a", role: "admin", isSuperAdmin: true });
});

test("resolveTenantContext: unknown slug → AppError 404", async () => {
  await makeUser("u_ctx_member");
  let thrown: AppError | null = null;
  try {
    await resolveTenantContext({
      pathname: "/api/t/no_such_slug/preferences",
      user: user("u_ctx_member"),
    });
  } catch (e) {
    if (e instanceof AppError) thrown = e;
  }
  expect(thrown?.code).toBe("NOT_FOUND");
  expect(thrown?.status).toBe(404);
});

test("resolveTenantContext: legacy /api/preferences path → tenantId='default'", async () => {
  await makeUser("u_ctx_member");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ('default', 'u_ctx_member', 'editor', now())
     ON CONFLICT DO NOTHING`,
  );

  const ctx = await resolveTenantContext({
    pathname: "/api/preferences",
    user: user("u_ctx_member"),
  });
  expect(ctx.tenantId).toBe("default");
  expect(ctx.role).toBe("editor");
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd server && bun run test tenant-middleware 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/tenant-middleware.ts`**

```ts
import { AppError } from "./errors.ts";
import { tenantBySlug, memberRole } from "./tenant.ts";
import type { SessionUser } from "./auth.ts";

export interface TenantContext {
  tenantId: string;
  role: "admin" | "editor" | "viewer";
  isSuperAdmin: boolean;
}

export interface ResolveOpts {
  pathname: string;
  user: SessionUser;
  /** Carried from auth.ts after PR1's users.is_super_admin column. Defaults false. */
  isSuperAdmin?: boolean;
}

const TENANT_PATH_RE = /^\/api\/t\/([^/]+)\//;

/** Resolve the tenant context for an incoming HTTP request.
 *
 *  Path shapes:
 *    /api/t/:slug/...   → resolve slug, require membership (or super-admin bypass)
 *    /api/admin/...     → handled by the route layer; this function is NOT called.
 *    everything else    → legacy /api/* mounted under tenantId='default'.
 *
 *  Throws AppError(NOT_FOUND, 404) for unknown slugs.
 *  Throws AppError(FORBIDDEN, 403) when the user is neither a member nor a super-admin.
 */
export async function resolveTenantContext(opts: ResolveOpts): Promise<TenantContext> {
  const m = TENANT_PATH_RE.exec(opts.pathname);
  if (m) {
    const slug = decodeURIComponent(m[1]!);
    const tenant = await tenantBySlug(slug);
    if (!tenant) {
      throw new AppError("NOT_FOUND", `workspace '${slug}' not found`, 404);
    }
    const role = await memberRole(tenant.id, opts.user.id);
    if (role) {
      return { tenantId: tenant.id, role, isSuperAdmin: false };
    }
    if (opts.isSuperAdmin) {
      // Super-admins get admin-level access to any workspace.
      return { tenantId: tenant.id, role: "admin", isSuperAdmin: true };
    }
    throw new AppError(
      "FORBIDDEN",
      `not a member of workspace '${slug}'`,
      403,
    );
  }

  // Legacy /api/* path → default tenant. The role comes from the user's
  // membership in 'default'; falls back to the session user's role (which is
  // the global users.role until Deploy 2 drops it). During PR2a both should
  // agree because the PR1 migration backfilled users.role into the default
  // tenant_member row.
  const role = (await memberRole("default", opts.user.id)) ?? opts.user.role;
  return { tenantId: "default", role, isSuperAdmin: opts.isSuperAdmin ?? false };
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test tenant-middleware 2>&1 | tail -10
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/tenant-middleware.ts server/test/tenant-middleware.test.ts
git commit -m "feat(tenant): resolveTenantContext middleware (MT PR2a)"
```

---

## Task 5: `TenantRepo` class scaffold + `preferences` methods

**Files:**
- Create: `server/src/tenant-repo.ts`
- Modify: `server/src/repo-meta.ts` — preferences SQL gains `tenant_id` (read filter + INSERT/UPDATE WHERE filter); existing exports stay so legacy routes/tests don't break
- Create: `server/test/tenant-repo-preferences.test.ts`

**Why this exists:** `TenantRepo` is the only DB surface tenant route handlers see. In PR2a it has two methods — `getPreferences()` and `setPreferences()` — proving the pattern. PR2b adds the other ~40 methods following the same shape.

**Schema reality check.** PR1 added `tenant_id VARCHAR DEFAULT 'default'` to `preferences`. That table's existing PK is `id = 1` (singleton). For per-tenant preferences we need one row PER tenant. So we change the SELECT/UPDATE to filter on `tenant_id` (not `id = 1`) AND change the INSERT path to upsert by `tenant_id`. The legacy `id = 1` row stays but is interpreted as `tenant_id = 'default'`.

- [ ] **Step 1: Refactor `repo-meta.ts` preferences SQL to be tenant-aware**

In `server/src/repo-meta.ts`, change `getPreferences` and `setPreferences`:

```ts
export async function getPreferences(tenantId: string = "default"): Promise<Preferences> {
  const row = await pgGet<{
    publish_threshold: number;
    suggest_threshold: number;
    scan_schedule: string | null;
  }>(
    `SELECT publish_threshold, suggest_threshold, scan_schedule
     FROM ${pg("preferences")}
     WHERE tenant_id = $1
     ORDER BY id LIMIT 1`,
    [tenantId],
  );
  const validSchedule = ["15m", "hourly", "daily"] as const;
  const sched = row?.scan_schedule ?? null;
  return {
    publishThreshold: row?.publish_threshold ?? 95,
    suggestThreshold: row?.suggest_threshold ?? 80,
    scanSchedule: validSchedule.includes(sched as (typeof validSchedule)[number])
      ? (sched as Preferences["scanSchedule"])
      : null,
  };
}

export async function setPreferences(
  p: Preferences,
  tenantId: string = "default",
): Promise<void> {
  const valid = p.scanSchedule === null || ["15m", "hourly", "daily"].includes(p.scanSchedule);
  if (!valid) throw new Error(`invalid scanSchedule: ${String(p.scanSchedule)}`);

  // Try UPDATE first; if no row exists for this tenant, INSERT one.
  const rows = await pgAll(
    `UPDATE ${pg("preferences")}
       SET publish_threshold = $1, suggest_threshold = $2,
           scan_schedule = $3, updated_at = current_timestamp
     WHERE tenant_id = $4
     RETURNING id`,
    [p.publishThreshold, p.suggestThreshold, p.scanSchedule, tenantId],
  );
  if (rows.length === 0) {
    await pgRun(
      `INSERT INTO ${pg("preferences")}
         (id, publish_threshold, suggest_threshold, scan_schedule, updated_at, tenant_id)
       VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM ${pg("preferences")}), $1, $2, $3, current_timestamp, $4)`,
      [p.publishThreshold, p.suggestThreshold, p.scanSchedule, tenantId],
    );
  }
}
```

The legacy default-tenant route in `server.ts` already calls `repo.getPreferences()` with no args — the new optional `tenantId = "default"` keeps that working. No call-site change yet.

- [ ] **Step 2: Implement `server/src/tenant-repo.ts`**

```ts
import { AppError } from "./errors.ts";
import * as repoMeta from "./repo-meta.ts";
import type { Preferences } from "./repo-shared.ts";

export type Role = "admin" | "editor" | "viewer";
export type Operation = "curate" | "commit" | "manage_team" | "manage_adapter";

const ROLE_OPS: Record<Role, Operation[]> = {
  admin: ["curate", "commit", "manage_team", "manage_adapter"],
  editor: ["curate", "commit"],
  viewer: [],
};

/* TenantRepo — request-scoped DB surface.
 *
 * PR2a ships the class with preferences + audit methods. Every method takes the
 * tenant scope from `this.tenantId` and forwards to the underlying repo-*.ts
 * function (which now accepts a `tenantId` parameter — see repo-meta.ts). PR2b
 * expands this to the remaining ~40 repo functions.
 *
 * Mutation methods call `this.assertRole(op)` first. The static permission
 * matrix here mirrors auth.ts.canMutate. */
export class TenantRepo {
  constructor(
    public readonly tenantId: string,
    public readonly role: Role,
    public readonly isSuperAdmin: boolean = false,
  ) {}

  assertRole(op: Operation): void {
    if (this.isSuperAdmin) return; // super-admin bypasses per-tenant role gates
    if (!ROLE_OPS[this.role].includes(op)) {
      throw new AppError("FORBIDDEN", `role '${this.role}' cannot ${op}`, 403);
    }
  }

  // --- preferences -----------------------------------------------------------
  getPreferences(): Promise<Preferences> {
    return repoMeta.getPreferences(this.tenantId);
  }

  setPreferences(p: Preferences): Promise<void> {
    this.assertRole("manage_adapter");
    return repoMeta.setPreferences(p, this.tenantId);
  }
}
```

- [ ] **Step 3: Write failing tests**

Create `server/test/tenant-repo-preferences.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { TenantRepo } from "../src/tenant-repo.ts";
import { AppError } from "../src/errors.ts";

const T_IDS = ["tpref_a", "tpref_b"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

test("setPreferences + getPreferences round-trip per tenant", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  const repo = new TenantRepo("tpref_a", "admin");

  await repo.setPreferences({
    publishThreshold: 90,
    suggestThreshold: 70,
    scanSchedule: "hourly",
  });

  const got = await repo.getPreferences();
  expect(got).toEqual({
    publishThreshold: 90,
    suggestThreshold: 70,
    scanSchedule: "hourly",
  });
});

test("tenant A preferences are independent from tenant B preferences", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  await provisionTenant({ id: "tpref_b", label: "B" });

  const a = new TenantRepo("tpref_a", "admin");
  const b = new TenantRepo("tpref_b", "admin");

  await a.setPreferences({ publishThreshold: 80, suggestThreshold: 60, scanSchedule: "15m" });
  await b.setPreferences({ publishThreshold: 99, suggestThreshold: 90, scanSchedule: "daily" });

  const gotA = await a.getPreferences();
  const gotB = await b.getPreferences();

  expect(gotA.publishThreshold).toBe(80);
  expect(gotA.scanSchedule).toBe("15m");
  expect(gotB.publishThreshold).toBe(99);
  expect(gotB.scanSchedule).toBe("daily");
});

test("setPreferences as viewer → 403 FORBIDDEN", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  const viewer = new TenantRepo("tpref_a", "viewer");
  let thrown: AppError | null = null;
  try {
    await viewer.setPreferences({
      publishThreshold: 1,
      suggestThreshold: 1,
      scanSchedule: null,
    });
  } catch (e) {
    if (e instanceof AppError) thrown = e;
  }
  expect(thrown?.code).toBe("FORBIDDEN");
});

test("super-admin bypasses the role check even with role='viewer'", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  const sa = new TenantRepo("tpref_a", "viewer", true);
  await sa.setPreferences({ publishThreshold: 50, suggestThreshold: 50, scanSchedule: null });
  expect((await sa.getPreferences()).publishThreshold).toBe(50);
});

test("default tenant getPreferences still returns the legacy id=1 row when no tenant_id row exists", async () => {
  // Don't write a new preferences row — verify the legacy default-seeded row (or fallback defaults) returns.
  const defaultRepo = new TenantRepo("default", "admin");
  const prefs = await defaultRepo.getPreferences();
  // Even with no row, the function returns the documented defaults.
  expect(prefs.publishThreshold).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test tenant-repo-preferences 2>&1 | tail -10
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/tenant-repo.ts server/src/repo-meta.ts server/test/tenant-repo-preferences.test.ts
git commit -m "feat(tenant): TenantRepo class + preferences per-tenant (MT PR2a)"
```

---

## Task 6: `audit_log` per-tenant + TenantRepo audit methods

**Files:**
- Modify: `server/src/repo-meta.ts` — `appendAuditAs` and `listAudit` gain `tenantId` parameter
- Modify: `server/src/tenant-repo.ts` — add `appendAudit` and `listAudit` methods
- Create: `server/test/tenant-repo-audit.test.ts`

- [ ] **Step 1: Update `repo-meta.ts`**

Change `appendAuditAs`:

```ts
export async function appendAuditAs(
  userId: string,
  action: string,
  detail: string,
  ctx: { tableId?: string; rowKey?: string; tenantId?: string } = {},
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("audit_log")} (id, created_at, user_id, action, detail, table_id, row_key, tenant_id)
     VALUES ($1, current_timestamp, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      userId,
      action,
      detail,
      ctx.tableId ?? null,
      ctx.rowKey ?? null,
      ctx.tenantId ?? "default",
    ],
  );
}
```

Change `listAudit`:

```ts
export async function listAudit(limit = 30, tenantId: string = "default"): Promise<AuditEntry[]> {
  // tenantId === '*' is the super-admin cross-tenant feed.
  const where = tenantId === "*" ? "" : "WHERE tenant_id = $1";
  const params = tenantId === "*" ? [] : [tenantId];
  const cappedLimit = Math.max(1, Math.min(200, limit));
  const rows = await pgAll<{
    id: string;
    uid: string;
    action: string;
    detail: string;
    secs: number;
  }>(
    `SELECT id, user_id AS uid, action, detail,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs
     FROM ${pg("audit_log")} ${where}
     ORDER BY created_at DESC
     LIMIT ${cappedLimit}`,
    params,
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

**Important:** scheduler and many internal callers of `appendAuditAs` pass no tenant — they'll default to `'default'`. PR2b adds explicit tenant threading through the scheduler.

- [ ] **Step 2: Extend `TenantRepo` in `server/src/tenant-repo.ts`**

Add to the class:

```ts
  // --- audit ----------------------------------------------------------------
  listAudit(limit = 30): Promise<import("./repo-shared.ts").AuditEntry[]> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return repoMeta.listAudit(limit, scope);
  }

  appendAudit(
    userId: string,
    action: string,
    detail: string,
    ctx: { tableId?: string; rowKey?: string } = {},
  ): Promise<void> {
    this.assertRole("curate");
    return repoMeta.appendAuditAs(userId, action, detail, { ...ctx, tenantId: this.tenantId });
  }
```

- [ ] **Step 3: Write failing tests**

Create `server/test/tenant-repo-audit.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { TenantRepo } from "../src/tenant-repo.ts";

const T_IDS = ["taudit_a", "taudit_b"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

test("tenant A's audit list does not include tenant B's entries", async () => {
  await provisionTenant({ id: "taudit_a", label: "A" });
  await provisionTenant({ id: "taudit_b", label: "B" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role)
     VALUES ('u_audit', 'U', 'XX', 'u_audit@x', 'editor')
     ON CONFLICT (id) DO NOTHING`,
  );

  const a = new TenantRepo("taudit_a", "editor");
  const b = new TenantRepo("taudit_b", "editor");
  await a.appendAudit("u_audit", "edit", "detail-A");
  await b.appendAudit("u_audit", "edit", "detail-B");

  const aList = await a.listAudit();
  const bList = await b.listAudit();

  expect(aList.map((r) => r.detail)).toContain("detail-A");
  expect(aList.map((r) => r.detail)).not.toContain("detail-B");
  expect(bList.map((r) => r.detail)).toContain("detail-B");
  expect(bList.map((r) => r.detail)).not.toContain("detail-A");
});

test("super-admin '*' tenant sees both tenants' entries", async () => {
  await provisionTenant({ id: "taudit_a", label: "A" });
  await provisionTenant({ id: "taudit_b", label: "B" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role)
     VALUES ('u_audit', 'U', 'XX', 'u_audit@x', 'editor')
     ON CONFLICT (id) DO NOTHING`,
  );

  const a = new TenantRepo("taudit_a", "editor");
  const b = new TenantRepo("taudit_b", "editor");
  await a.appendAudit("u_audit", "edit", "detail-A-sa");
  await b.appendAudit("u_audit", "edit", "detail-B-sa");

  const sa = new TenantRepo("*", "admin", true);
  const all = await sa.listAudit(200);
  const details = all.map((r) => r.detail);
  expect(details).toContain("detail-A-sa");
  expect(details).toContain("detail-B-sa");
});

test("appendAudit as viewer → 403", async () => {
  await provisionTenant({ id: "taudit_a", label: "A" });
  const viewer = new TenantRepo("taudit_a", "viewer");
  let thrown = false;
  try {
    await viewer.appendAudit("u_audit", "edit", "nope");
  } catch {
    thrown = true;
  }
  expect(thrown).toBe(true);
});
```

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test tenant-repo-audit 2>&1 | tail -10
```
Expected: 3 tests pass.

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: full suite green; ~232 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-meta.ts server/src/tenant-repo.ts server/test/tenant-repo-audit.test.ts
git commit -m "feat(tenant): TenantRepo audit methods + per-tenant audit_log writes (MT PR2a)"
```

---

## Task 7: Auth — `is_super_admin` carried on SessionUser

**Files:**
- Modify: `server/src/auth.ts` — extend `SessionUser` with `isSuperAdmin`; update `getSessionUser` SQL

**Why this exists:** The middleware in Task 4 needs `isSuperAdmin` to decide bypass. PR1 added the column; PR2a wires it onto the session shape so every authenticated route can read it.

- [ ] **Step 1: Update `SessionUser` interface**

In `server/src/auth.ts`:

```ts
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: Role;
  isSuperAdmin: boolean;
}
```

- [ ] **Step 2: Update the `getSessionUser` SELECT**

```ts
  return get<SessionUser>(
    `SELECT id, name, email, initials, role, is_super_admin AS "isSuperAdmin"
       FROM ${pg("users")} WHERE id = $1`,
    [session.user_id],
  );
```

- [ ] **Step 3: Check other SessionUser construction sites**

```bash
grep -rn "SessionUser" server/src/ | grep -v ".test.ts" | grep -v "auth.ts"
```

Likely results: `auth-api-tokens.ts` (`getApiTokenUser` constructs a SessionUser from a token row). Open it and update its SELECT to include `is_super_admin AS "isSuperAdmin"`. Also `server.ts` references `SessionUser` only as a type — no construction.

If `auth-api-tokens.ts:getApiTokenUser` builds a SessionUser literally, give it `isSuperAdmin: false` (api-token paths are not super-admin in PR2a; PR2b can introduce super-admin tokens if needed).

- [ ] **Step 4: Typecheck**

```bash
cd server && bun run typecheck 2>&1 | tail -3
```
Expected: clean.

- [ ] **Step 5: Run existing tests**

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: full suite green. Existing tests construct SessionUser fixtures — they may need `isSuperAdmin: false` added. Sweep:

```bash
grep -rln "SessionUser" server/test/ | xargs grep -l "id:.*role:" 2>/dev/null
```

For each fixture, add `isSuperAdmin: false`.

- [ ] **Step 6: Commit**

```bash
git add server/src/auth.ts server/src/auth-api-tokens.ts server/test/
git commit -m "feat(auth): SessionUser carries isSuperAdmin from users table (MT PR2a)"
```

---

## Task 8: Wire tenant context into `server.ts` HTTP routing

**Files:**
- Modify: `server/src/server.ts`

**What changes:** Inside `handle()`, after the session gate, call `resolveTenantContext` and instantiate a request-scoped `TenantRepo`. Then **only for the routes that PR2a migrates** (preferences, audit) — switch to using `req.repo`. All other routes keep calling the module-level `repo.*` directly (untouched in PR2a). Add the `/api/t/:slug/*` path prefix as a no-op prefix-strip so the same route table serves both URL shapes.

- [ ] **Step 1: Add the prefix strip + tenant resolution**

In `server/src/server.ts`, near the top of `handle()`, after the `OPTIONS` and `/health` early returns and before the `seg[0] !== "api"` check, insert:

```ts
  // /api/t/:slug/... strip the /t/:slug prefix so the existing route table matches.
  // We capture the slug to thread into tenant resolution after the session gate.
  let tenantSlugFromPath: string | null = null;
  if (seg[0] === "api" && seg[1] === "t" && seg.length >= 3) {
    tenantSlugFromPath = decodeURIComponent(seg[2]!);
    // Mutate seg + pathname so the existing route checks (seg[1] === "preferences", etc.) match.
    seg.splice(1, 2); // remove "t" and the slug
  }
```

(Place this BEFORE the `if (seg[0] !== "api")` 404 guard; the prefix strip leaves `seg[0] = "api"` intact.)

- [ ] **Step 2: Resolve tenant context after the session gate**

After the existing session-fetch block ends with `setUid(me);`, add:

```ts
  // Resolve the tenant context for this request. /api/admin/* and /api/auth/*
  // bypass this — admin handles its own auth in Task 9, and auth routes ran
  // earlier in the function.
  let tenantCtx: { tenantId: string; role: import("./auth.ts").Role; isSuperAdmin: boolean };
  if (seg[1] === "admin") {
    if (!sessionUser.isSuperAdmin) {
      return json({ error: "forbidden", reason: "super_admin_required" }, 403);
    }
    // Admin tenantCtx isn't used by handlers but populated for shape consistency.
    tenantCtx = { tenantId: "*", role: "admin", isSuperAdmin: true };
  } else {
    try {
      const pathnameForCtx = tenantSlugFromPath
        ? `/api/t/${tenantSlugFromPath}/_`
        : pathname;
      tenantCtx = await (await import("./tenant-middleware.ts")).resolveTenantContext({
        pathname: pathnameForCtx,
        user: sessionUser,
        isSuperAdmin: sessionUser.isSuperAdmin,
      });
    } catch (e) {
      if (e instanceof AppError) {
        return json({ error: e.message, code: e.code }, e.status);
      }
      throw e;
    }
  }
  const { TenantRepo } = await import("./tenant-repo.ts");
  const reqRepo = new TenantRepo(tenantCtx.tenantId, tenantCtx.role, tenantCtx.isSuperAdmin);
```

- [ ] **Step 3: Migrate the `preferences` route handler to `reqRepo`**

Find the existing block:

```ts
    if (seg[1] === "preferences" && seg.length === 2) {
      if (method === "GET") return json(await repo.getPreferences());
      if (method === "PUT") {
        const denied = gateOrJson(sessionUser, "manage_adapter");
        if (denied) return denied;
        const p = (await req.json()) as {
          publishThreshold: number;
          suggestThreshold: number;
          scanSchedule: "15m" | "hourly" | "daily" | null;
        };
        await repo.setPreferences(p);
        return noContent();
      }
    }
```

Replace with:

```ts
    if (seg[1] === "preferences" && seg.length === 2) {
      if (method === "GET") return json(await reqRepo.getPreferences());
      if (method === "PUT") {
        const p = (await req.json()) as {
          publishThreshold: number;
          suggestThreshold: number;
          scanSchedule: "15m" | "hourly" | "daily" | null;
        };
        try {
          await reqRepo.setPreferences(p);
        } catch (e) {
          if (e instanceof AppError) {
            return json({ error: e.message, code: e.code }, e.status);
          }
          throw e;
        }
        return noContent();
      }
    }
```

(`reqRepo.setPreferences` does the role check internally; `gateOrJson` is now redundant for this route.)

- [ ] **Step 4: Migrate the `audit` route handler to `reqRepo`**

Replace the existing audit block:

```ts
    if (seg[1] === "audit" && seg.length === 2) {
      if (method === "GET")
        return json(await reqRepo.listAudit(Number(url.searchParams.get("limit") ?? 30)));
      if (method === "POST") {
        const { action, detail } = (await req.json()) as { action: string; detail: string };
        try {
          await reqRepo.appendAudit(me, action, detail);
        } catch (e) {
          if (e instanceof AppError) {
            return json({ error: e.message, code: e.code }, e.status);
          }
          throw e;
        }
        return noContent();
      }
    }
```

- [ ] **Step 5: Write the route integration test**

Create `server/test/tenant-routes-preferences.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";

const T_IDS = ["troute_a", "troute_b"];
const U_IDS = ["u_route_member"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function setupUserWithMembership(opts: {
  userId: string;
  tenants: { id: string; label: string; role: "admin" | "editor" | "viewer" }[];
}): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role)
     VALUES ($1, $1, 'XX', $2, 'editor')
     ON CONFLICT (id) DO NOTHING`,
    [opts.userId, `${opts.userId}@example.com`],
  );
  for (const t of opts.tenants) {
    await provisionTenant({ id: t.id, label: t.label });
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT DO NOTHING`,
      [t.id, opts.userId, t.role],
    );
  }
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(opts.userId);
  return `zz_sid=${sessionId}`;
}

async function bootHandle(): Promise<
  (req: Request) => Promise<Response>
> {
  // Lazy-import server module; it boot-runs the scheduler etc. but for the test
  // we only need the `handle` function. Re-implement a thin adapter here.
  // server.ts doesn't export handle; we go through the Bun.serve fetch path via
  // a captured reference. Easiest: spawn the server on a random port for the test.
  // For PR2a we use a more direct path — re-import the handle by mocking Bun.serve.
  throw new Error(
    "Use the in-process call: import directly from a refactored server module exporting handle, OR run server in a child process. " +
      "Until the refactor, this test exercises TenantRepo via tenant-repo-preferences. See Task 8 step 5b.",
  );
}

// Step 5b — direct handle export pattern: we refactor server.ts to export handle
// (it's currently a top-level closure). Refactor below in step 5c.

test("GET /api/t/:slug/preferences returns the tenant's preferences", async () => {
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "troute_a", label: "A", role: "admin" }],
  });
  // Pre-seed preferences via the repo to assert the route returns them.
  const { TenantRepo } = await import("../src/tenant-repo.ts");
  await new TenantRepo("troute_a", "admin").setPreferences({
    publishThreshold: 77,
    suggestThreshold: 55,
    scanSchedule: "15m",
  });

  const { handle } = await import("../src/server.ts");
  const req = new Request("http://localhost/api/t/troute_a/preferences", {
    headers: { cookie },
  });
  const res = await handle(req, () => {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as { publishThreshold: number; scanSchedule: string };
  expect(body.publishThreshold).toBe(77);
  expect(body.scanSchedule).toBe("15m");
});

test("GET /api/t/:slug/preferences for a workspace the user does not belong to → 403", async () => {
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "troute_a", label: "A", role: "admin" }],
  });
  // Provision a tenant the user is NOT a member of.
  await provisionTenant({ id: "troute_b", label: "B" });

  const { handle } = await import("../src/server.ts");
  const req = new Request("http://localhost/api/t/troute_b/preferences", {
    headers: { cookie },
  });
  const res = await handle(req, () => {});
  expect(res.status).toBe(403);
});

test("GET /api/t/no_such_workspace/preferences → 404", async () => {
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "troute_a", label: "A", role: "admin" }],
  });
  const { handle } = await import("../src/server.ts");
  const req = new Request("http://localhost/api/t/no_such_workspace/preferences", {
    headers: { cookie },
  });
  const res = await handle(req, () => {});
  expect(res.status).toBe(404);
});

test("legacy /api/preferences still works under default tenant", async () => {
  await provisionTenant({ id: "default", label: "Default" }).catch(() => {});
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "default", label: "Default", role: "admin" }],
  });

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/preferences", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
});

test("PUT /api/t/:slug/preferences as viewer → 403", async () => {
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "troute_a", label: "A", role: "viewer" }],
  });
  const { handle } = await import("../src/server.ts");
  const req = new Request("http://localhost/api/t/troute_a/preferences", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ publishThreshold: 1, suggestThreshold: 1, scanSchedule: null }),
  });
  const res = await handle(req, () => {});
  expect(res.status).toBe(403);
});
```

- [ ] **Step 5c: Refactor `server.ts` to export `handle`**

In `server/src/server.ts`, change `async function handle(...)` to `export async function handle(...)`.

This requires the import-time side effects (warehouse adapter ping, scheduler start, Bun.serve) to be moved behind a guard. Wrap them in:

```ts
const IS_TEST = process.env.NODE_ENV === "test" || typeof Bun !== "undefined" && Bun.argv.some((a) => a.includes("bun:test"));
```

Simpler approach (preferred): move the top-level side effects into an `if (import.meta.main)` block. `import.meta.main` is true only when `bun run start` invokes the file, not when `import { handle } from "./server.ts"` is used by a test.

Wrap from `registerFactories({ ... })` down to the final `process.on("SIGINT", ...)` line in:

```ts
if (import.meta.main) {
  // ... all existing side-effectful boot code ...
}
```

The `export async function handle(...)` and its inner helpers (`json`, `noContent`, `err`, `gateOrJson`, `corsHeaders`) stay at top level.

- [ ] **Step 6: Run the route tests**

```bash
cd server && bun run test tenant-routes-preferences 2>&1 | tail -15
```
Expected: 5 tests pass.

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: full suite green; ~237 tests.

If existing tests start a real server via `bun run start` in a child process (grep `Bun.spawn.*start` in `server/test/`), they continue to work because the boot side-effects only fire when the file is executed as the main script.

- [ ] **Step 7: Commit**

```bash
git add server/src/server.ts server/test/tenant-routes-preferences.test.ts
git commit -m "feat(server): route /api/t/:slug/preferences|audit via TenantRepo (MT PR2a)"
```

---

## Task 9: `/api/admin/tenants` super-admin routes

**Files:**
- Modify: `server/src/server.ts` — add `/api/admin/tenants` GET + POST handlers
- Create: `server/test/admin-tenants-route.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/test/admin-tenants-route.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";

const T_IDS = ["tadmin_e2e"];
const U_IDS = ["u_admin_e2e", "u_nonadmin_e2e"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function login(userId: string, isSuperAdmin: boolean): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, $1, 'XX', $2, 'editor', $3)`,
    [userId, `${userId}@example.com`, isSuperAdmin],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("GET /api/admin/tenants as super-admin → 200 + list including default", async () => {
  const cookie = await login("u_admin_e2e", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/tenants", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tenants: { id: string }[] };
  expect(body.tenants.map((t) => t.id)).toContain("default");
});

test("GET /api/admin/tenants as non-super-admin → 403", async () => {
  const cookie = await login("u_nonadmin_e2e", false);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/tenants", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(403);
});

test("POST /api/admin/tenants as super-admin provisions a new tenant", async () => {
  const cookie = await login("u_admin_e2e", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/tenants", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "tadmin_e2e", label: "E2E Test" }),
    }),
    () => {},
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; label: string };
  expect(body.id).toBe("tadmin_e2e");
  expect(body.label).toBe("E2E Test");
});

test("POST /api/admin/tenants with duplicate id → 409", async () => {
  const cookie = await login("u_admin_e2e", true);
  const { handle } = await import("../src/server.ts");
  await handle(
    new Request("http://localhost/api/admin/tenants", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "tadmin_e2e", label: "First" }),
    }),
    () => {},
  );
  const res = await handle(
    new Request("http://localhost/api/admin/tenants", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "tadmin_e2e", label: "Second" }),
    }),
    () => {},
  );
  expect(res.status).toBe(409);
});
```

- [ ] **Step 2: Add the route handlers in `server.ts`**

Locate the existing top-level routes inside `handle()`'s try block (after the `if (seg[1] === "tokens")` block is a reasonable spot). Insert:

```ts
    // /api/admin/* — super-admin only; tenantCtx.isSuperAdmin already verified above.
    if (seg[1] === "admin" && seg[2] === "tenants") {
      const { provisionTenant, listTenants } = await import("./tenant.ts");
      if (seg.length === 3 && method === "GET") {
        const tenants = await listTenants();
        return json({ tenants });
      }
      if (seg.length === 3 && method === "POST") {
        const body = (await req.json()) as {
          id: string;
          label: string;
          slug?: string;
          warehouseId?: string;
        };
        try {
          const tenant = await provisionTenant({
            id: body.id,
            label: body.label,
            slug: body.slug,
            warehouseId: body.warehouseId,
          });
          return json(tenant, 201);
        } catch (e) {
          if (e instanceof AppError) {
            return json({ error: e.message, code: e.code }, e.status);
          }
          throw e;
        }
      }
    }
```

- [ ] **Step 3: Run, expect pass**

```bash
cd server && bun run test admin-tenants-route 2>&1 | tail -15
```
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts server/test/admin-tenants-route.test.ts
git commit -m "feat(admin): GET + POST /api/admin/tenants routes (MT PR2a)"
```

---

## Task 10: Sign-in flow — accept pending invites on login

**Files:**
- Modify: `server/src/auth-password.ts` — call `acceptInvitesFor` after upserting the user
- Modify: `server/src/auth-oidc.ts` — same
- Create: `server/test/auth-invite-acceptance.test.ts`

- [ ] **Step 1: Write failing test**

Create `server/test/auth-invite-acceptance.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";
import { provisionTenant, listMembershipsForUser } from "../src/tenant.ts";

const T_IDS = ["tinv_a"];
const EMAIL = "newhire@example.com";

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE lower(email) = $1`, [EMAIL]);
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE lower(email) = $1`, [EMAIL]);
}
beforeEach(cleanup);
afterAll(cleanup);

test("password signup with a matching pending invite → user becomes a member of the invited tenant", async () => {
  await provisionTenant({ id: "tinv_a", label: "Invite Target" });
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_invite" (tenant_id, email, role, invited_by, invited_at)
     VALUES ('tinv_a', $1, 'editor', 'u_inviter', now())`,
    [EMAIL],
  );

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "passw0rd!", displayName: "New Hire" }),
    }),
    () => {},
  );
  expect(res.status).toBeLessThan(400);

  const userRow = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."users" WHERE lower(email) = $1`,
    [EMAIL],
  );
  expect(userRow).not.toBeNull();

  const memberships = await listMembershipsForUser(userRow!.id);
  expect(memberships.map((m) => m.tenant.id)).toContain("tinv_a");
  expect(memberships.find((m) => m.tenant.id === "tinv_a")?.role).toBe("editor");

  // Invite must be consumed.
  const remaining = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."tenant_invite" WHERE lower(email) = $1`,
    [EMAIL],
  );
  expect(remaining?.n).toBe(0);
});

test("password login (existing user, no membership, no invite) does not crash and the user remains memberless", async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, auth_provider, password_hash)
     VALUES ('u_existing_memberless', 'X', 'XX', $1, 'editor', 'password', $2)`,
    [EMAIL, "$2b$10$dummyhashthatwontmatch"],
  );

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "wrong-password" }),
    }),
    () => {},
  );
  // Wrong password → 401; the test asserts no exception. Membership state untouched.
  expect(res.status).toBe(401);

  const memberships = await listMembershipsForUser("u_existing_memberless");
  expect(memberships).toHaveLength(0);
});
```

- [ ] **Step 2: Run, expect fail (second test may pass; the first fails because invites aren't auto-accepted)**

```bash
cd server && bun run test auth-invite-acceptance 2>&1 | tail -15
```
Expected: first test fails ("expected tinv_a in memberships").

- [ ] **Step 3: Wire `acceptInvitesFor` into `auth-password.ts`**

Read `server/src/auth-password.ts` to find the signup + login flow. After the user is upserted and a session is about to be issued, call:

```ts
try {
  const { acceptInvitesFor } = await import("./tenant.ts");
  await acceptInvitesFor(userId, email);
} catch (e) {
  // Don't block the login on invite-acceptance failure; log + continue.
  console.error("acceptInvitesFor failed:", e);
}
```

Place this immediately before `issueSession(userId)` in BOTH the signup and login paths.

- [ ] **Step 4: Wire `acceptInvitesFor` into `auth-oidc.ts`**

Same insertion: read `server/src/auth-oidc.ts`, find the spot after user upsert and before session issuance, paste the same block.

- [ ] **Step 5: Run, expect pass**

```bash
cd server && bun run test auth-invite-acceptance 2>&1 | tail -15
```
Expected: 2 tests pass.

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: full suite green; ~243 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/auth-password.ts server/src/auth-oidc.ts server/test/auth-invite-acceptance.test.ts
git commit -m "feat(auth): auto-accept pending invites on first login (MT PR2a)"
```

---

## Task 11: Verification gate + PR

**Files:** none beyond what's already changed.

- [ ] **Step 1: Full server gate**

```bash
cd server && bun run typecheck && bun run lint && bun run format:check && bun run test 2>&1 | tail -10
```
Expected: all green. ~243 tests.

- [ ] **Step 2: App gate (no changes in PR2a — sanity check)**

```bash
cd app && bun run typecheck && bun run lint && bun run format:check && bun run test 2>&1 | tail -5
```
Expected: green, unchanged from baseline.

- [ ] **Step 3: Manual smoke against the dev server**

```bash
cd server && bun run start &
sleep 2
# Use the dev-bypass login to get a session cookie.
curl -sS -c /tmp/zz-cookie.txt "http://localhost:8787/api/auth/dev?redirect=skip" -o /dev/null
# List tenants (super-admin only — promote u_dev first).
psql "$DATABASE_URL" -c "UPDATE zugzug_app.users SET is_super_admin = true WHERE id = 'u_dev';"
curl -sS -b /tmp/zz-cookie.txt http://localhost:8787/api/admin/tenants
# Provision a new tenant via the admin route.
curl -sS -b /tmp/zz-cookie.txt -H 'content-type: application/json' \
  -d '{"id":"smoke_pr2a","label":"PR2a Smoke"}' \
  -X POST http://localhost:8787/api/admin/tenants
# Add the dev user as a member, then hit the tenant route.
psql "$DATABASE_URL" -c "INSERT INTO zugzug_app.tenant_member (tenant_id, user_id, role, created_at) VALUES ('smoke_pr2a', 'u_dev', 'admin', now()) ON CONFLICT DO NOTHING;"
curl -sS -b /tmp/zz-cookie.txt http://localhost:8787/api/t/smoke_pr2a/preferences
# Set preferences on the new tenant.
curl -sS -b /tmp/zz-cookie.txt -H 'content-type: application/json' \
  -X PUT -d '{"publishThreshold":42,"suggestThreshold":42,"scanSchedule":"daily"}' \
  http://localhost:8787/api/t/smoke_pr2a/preferences
# Read back — should be 42/42/daily, NOT whatever default's preferences are.
curl -sS -b /tmp/zz-cookie.txt http://localhost:8787/api/t/smoke_pr2a/preferences
# Read default's preferences — should be unchanged.
curl -sS -b /tmp/zz-cookie.txt http://localhost:8787/api/preferences
# Cleanup
psql "$DATABASE_URL" -c "DELETE FROM zugzug_app.preferences WHERE tenant_id = 'smoke_pr2a';"
psql "$DATABASE_URL" -c "DELETE FROM zugzug_app.tenant_member WHERE tenant_id = 'smoke_pr2a';"
psql "$DATABASE_URL" -c "DELETE FROM zugzug_app.tenant WHERE id = 'smoke_pr2a';"
psql "$DATABASE_URL" -c "UPDATE zugzug_app.users SET is_super_admin = false WHERE id = 'u_dev';"
kill %1
```

Expected: tenant preferences differ from default preferences after the PUT. No 500s.

- [ ] **Step 4: Push branch**

```bash
git push -u origin mt-pr2a-tenant-runtime
```

- [ ] **Step 5: Open PR**

```bash
gh pr create --title "Multi-tenant PR 2a: tenant runtime + first vertical slice" --body "$(cat <<'EOF'
## Summary

Second of the multi-tenant series (epic #59), splitting the spec's "PR 2" into 2a + 2b for review-ability. **2a lands the runtime end-to-end on a thin vertical slice; 2b migrates the remaining ~40 repo functions.** Existing `/api/*` keeps working unchanged under the `default` tenant.

**Runtime plumbing**
- `pgTxScoped(tenantId, fn)` — Postgres tx with `SET LOCAL app.tenant_id` (RLS-ready for PR5)
- `resolveTenantContext(pathname, user)` — slug → tenant resolution + membership check + super-admin bypass
- `TenantRepo` class — request-scoped DB surface with role-gated mutations
- `server.ts` — `/api/t/:slug/*` route prefix strips into the existing route table; every authenticated request gets a `reqRepo` instance

**Vertical slice (proves the pattern)**
- `preferences` is now per-tenant (`getPreferences` / `setPreferences` filter on `tenant_id`)
- `audit_log` writes carry `tenant_id`; `listAudit` filters by tenant; super-admin `tenant_id='*'` returns the cross-tenant feed
- `GET/PUT /api/t/:slug/preferences` and `GET/POST /api/t/:slug/audit` go through `TenantRepo`

**Sign-in**
- `auth-password.ts` and `auth-oidc.ts` call `acceptInvitesFor(userId, email)` after user upsert and before session issuance. First login consumes any pending `tenant_invite` rows atomically.

**Super-admin**
- `users.isSuperAdmin` carried on `SessionUser`
- `GET /api/admin/tenants` — list
- `POST /api/admin/tenants` — provision (wraps PR1's `provisionTenant` service)

## What's NOT in this PR (PR2b)
- Per-tenant SQL filtering on the remaining repo modules: `repo.ts`, `repo-canonical.ts`, `repo-drafts.ts`, `repo-scan.ts`, `repo-ai-hint.ts`, `repo-activity.ts`, `repo-shared.ts`
- Scheduler refactor (per-tenant `SET LOCAL` per tick)
- WebSocket `/ws/t/:slug/presence/:tableId` upgrade
- `pg` Proxy defense-in-depth (pool.unsafe outside `withTenantTx` throws)
- `/api/admin/audit`, `/api/admin/impersonate`, `/api/admin/tenants/:id/teardown`

## Test plan
- [ ] `cd server && bun run typecheck && bun run lint && bun run format:check && bun run test` — green (~243 tests, +30 from baseline)
- [ ] `cd app && bun run typecheck && bun run lint && bun run format:check && bun run test` — green (no app changes)
- [ ] Manual smoke (see plan Task 11 step 3) — `/api/t/smoke_pr2a/preferences` returns its own values, `/api/preferences` returns default's values, no cross-bleed.

Spec: `docs/superpowers/specs/2026-06-07-multi-tenant-design.md`
Plan: `docs/superpowers/plans/2026-06-11-multi-tenant-pr2a-tenant-runtime.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Watch CI**

```bash
gh pr checks --watch
```
Expected: app + server gates pass.

---

## Self-review

**Spec coverage matrix (PR2a scope only):**

| Spec deliverable | Task |
|---|---|
| `pgTxScoped` / `SET LOCAL app.tenant_id` plumbing | Task 2 |
| Slug → tenant resolution | Task 3 (`tenantBySlug`) + Task 4 (middleware) |
| Membership check w/ super-admin bypass | Task 4 |
| `TenantRepo` class + role gates | Task 5 + 6 |
| `users.is_super_admin` on `SessionUser` | Task 7 |
| `/api/t/:slug/*` route mounting alongside `/api/*` default | Task 8 |
| Auto-accept invites at sign-in (atomic) | Task 3 (`acceptInvitesFor`) + Task 10 (wiring) |
| `/api/admin/tenants` GET + POST | Task 9 |
| Preferences + audit per-tenant | Task 5, 6, 8 |
| Test-DB isolation between tenants | Task 5, 6, 8 |

**Out-of-scope deferred to PR2b** (explicitly):
- Other repo modules (canonical/drafts/scan/ai-hint/activity)
- Scheduler tenant loop
- WS upgrade
- `pg` Proxy defense
- Other admin routes (audit, impersonate, teardown)

**Type consistency:**
- `TenantContext` (`{tenantId, role, isSuperAdmin}`) used identically in Task 4's interface and Task 8's resolution call.
- `Role` is `"admin" | "editor" | "viewer"` everywhere (Task 4 middleware, Task 5 TenantRepo, Task 6 audit).
- `Membership` interface returned by `listMembershipsForUser` (Task 3) is consumed by no current callers in PR2a but defined so PR2b's workspace switcher API can return it directly.

**Placeholder scan:** no TBDs. The "PR2b" references are scope statements, not placeholders.

**Risks flagged for PR2a:**

- **`SET LOCAL` quoting.** `pgTxScoped` interpolates the tenant id into the SQL via string concat (after regex validation). Postgres `SET` doesn't accept parameter substitution; the regex + the schema's CHECK constraint make this safe but the engineer should NOT relax the regex without also rewriting `SET LOCAL` to use a different mechanism (e.g. `set_config('app.tenant_id', $1, true)`).
- **`server.ts` `handle()` becomes exportable.** Wrapping boot-side-effects in `if (import.meta.main)` is the safest refactor; existing E2E tests that spawn `bun run start` are unaffected because they hit the script entry path. Tests that previously imported `server.ts` for type-only purposes are also unaffected.
- **`preferences` ID generation.** The current schema uses `id = 1` as a singleton. The new INSERT path uses `(SELECT COALESCE(MAX(id), 0) + 1)`, which is fine for our row volume but technically racy under concurrent first-time PUTs for new tenants. The race window is microseconds and the worst case is a unique-constraint violation surfacing as a 500; the second attempt resolves it. PR2b can replace `id` with a generated identity column.
- **Auto-accept invites timing.** `acceptInvitesFor` runs after user upsert and before session issuance. If the user upsert succeeds but invite acceptance fails, the session is still issued (we catch + log per Task 10 step 3). The user lands without memberships and hits the BootGate "no workspaces" path (PR4 ships that UI). Acceptable; users can re-login to retry.
- **`scan_run` and other unscoped writes by the scheduler.** PR2a leaves the scheduler unchanged — it writes `scan_run` rows with the default `tenant_id = 'default'`. PR2b refactors it to iterate tenants.
- **Migration of the `audit_log` writes inside the scheduler.** Same scope — scheduler-emitted audit entries go to the default tenant in PR2a. The cross-tenant audit feed (`tenant_id = '*'`) will reveal them when 2b lands.
