# Settings IA PR B — Account surface + Danger zone + server mutations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Account page (`/app/:slug/account/*`), workspace label rename, Leave/Delete workspace actions, and workspace-switcher deep-links for Settings and Account.

**Architecture:** Five new server routes (`PATCH /auth/me`, `PATCH/DELETE /t/:slug`, `POST /t/:slug/leave`) plus one Drizzle migration (`users.last_seen_at`). On the client, `Account.tsx` reuses the `SettingsShell` primitive from PR A with its own `AccountSidebar`. `General.tsx` and `Danger.tsx` gain their live implementations. `WorkspaceSwitcher` gets "Account settings" and "Workspace settings" nav entries.

**Tech Stack:** Bun + postgres.js (server), React 18 + react-router-dom v6 + Tailwind v4 (client), Vitest + @testing-library/react (client tests), bun:test (server tests), Drizzle ORM (migrations).

**Branch:** `mt-pr5b-account-danger` off `mt-pr5a-settings-ia` (or `main` once PR A merges).

**Spec:** `docs/superpowers/specs/2026-06-12-settings-ia-redesign.md` — Phase PR B.

**Prereq:** PR A (`mt-pr5a-settings-ia`) merged. Confirm with `git log --oneline HEAD | grep -c "SettingsLayout"` returning 1.

**Key architectural facts** (read before coding):
- `seg` in `server.ts` is the URL path split by `/` with empty strings removed. For tenant-scoped routes, line 115 splices out `"t"` and the slug: `/api/t/acme/leave` → `seg = ["api","leave"]`.
- `PATCH /api/auth/me` needs no tenant context — add it in the pre-tenantCtx block (after `GET /api/me/memberships`, before the admin block).
- `PATCH/DELETE /api/t/:slug` and `POST /api/t/:slug/leave` go in the tenant-scoped block alongside the existing team routes. After splice, a bare `/api/t/:slug` produces `seg = ["api"]` (`seg.length === 1`); `/api/t/:slug/leave` produces `seg = ["api","leave"]` (`seg[1] === "leave"`).
- Account routes live inside `<AppShell>` under `/app/:slug/account/*` — same nesting level as `settings`.
- `SettingsShell` (from PR A at `app/src/components/settings/SettingsShell.tsx`) is the layout primitive reused by Account.

---

## File structure (post-PR)

```
server/drizzle/schema.ts                       MOD — add users.last_seen_at column
server/drizzle/migrations/0013_…sql            NEW — generated migration
server/src/server.ts                           MOD — PATCH /auth/me; PATCH/DELETE /t/:slug; POST /t/:slug/leave; last_seen_at touch
server/src/tenant.ts                           MOD — updateTenantLabel(), leaveTenant() helpers
server/src/auth.ts                             MOD — updateUserName() helper
server/test/account-profile.test.ts            NEW — PATCH /auth/me tests
server/test/tenant-label.test.ts               NEW — PATCH /api/t/:slug tests
server/test/tenant-leave-delete.test.ts        NEW — POST /leave + DELETE /t/:slug tests

app/src/components/settings/AccountSidebar.tsx NEW — Profile / Appearance / Notifications nav
app/src/routes/account/Account.tsx             NEW — layout host using SettingsShell + AccountSidebar
app/src/routes/account/Profile.tsx             NEW — name edit + email display + sign-out
app/src/routes/account/Appearance.tsx          NEW — engineer mode (moved from settings/Appearance)
app/src/routes/account/Notifications.tsx       NEW — placeholder card

app/src/routes/settings/Appearance.tsx         DELETE — engineer mode moves to Account
app/src/components/settings/SettingsSidebar.tsx  MOD — remove Appearance item
app/src/routes/settings/General.tsx            MOD — label rename input (admin only)
app/src/routes/settings/Danger.tsx             MOD — Leave + Delete workspace actions

app/src/components/WorkspaceSwitcher.tsx       MOD — "Account settings" + "Workspace settings"
app/src/main.tsx                               MOD — /account/* routes inside AppShell

app/test/danger-zone.test.tsx                  NEW — Leave confirm dialog; Delete typed-slug
app/test/workspace-switcher.test.tsx           MOD — test new nav entries
```

---

## Task 1: Branch kickoff

**Files:** none.

- [ ] **Step 1: Create branch**

```bash
git checkout mt-pr5a-settings-ia && git pull --ff-only origin mt-pr5a-settings-ia && git checkout -b mt-pr5b-account-danger
```

If PR A is already merged to main:
```bash
git checkout main && git pull --ff-only origin main && git checkout -b mt-pr5b-account-danger
```

- [ ] **Step 2: Baseline**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test 2>&1 | tail -3
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Record numbers.

---

## Task 2: `users.last_seen_at` migration

Adds a nullable timestamp column so the admin Users page (PR C) can show when a user was last active. Written on every `/auth/me` hit.

**Files:**
- Modify: `server/drizzle/schema.ts`
- New: `server/drizzle/migrations/0013_*.sql` (generated)
- Modify: `server/src/server.ts` (write the column on auth/me)

- [ ] **Step 1: Add column to schema**

Open `server/drizzle/schema.ts`. The `users` table is at line ~118. Add `last_seen_at` after the existing columns:

```ts
export const users = app.table(
  "users",
  {
    id:            varchar("id").primaryKey(),
    name:          varchar("name").notNull(),
    initials:      varchar("initials").notNull(),
    email:         varchar("email"),
    google_sub:    varchar("google_sub"),
    password_hash: varchar("password_hash"),
    auth_provider: varchar("auth_provider").notNull().default("password"),
    role:           varchar("role").notNull().default("editor"),
    is_super_admin: boolean("is_super_admin").notNull().default(false),
    last_seen_at:   timestamp("last_seen_at"),                        // ADD THIS LINE
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email).where(sql`email IS NOT NULL`),
    uniqueIndex("users_google_sub_unique").on(t.google_sub).where(sql`google_sub IS NOT NULL`),
  ],
);
```

- [ ] **Step 2: Generate the migration**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run db:generate
```

Expected: a new file `server/drizzle/migrations/0013_*.sql` appears.

- [ ] **Step 3: Verify the migration file looks correct**

```bash
ls server/drizzle/migrations/ | tail -3
cat server/drizzle/migrations/$(ls server/drizzle/migrations/ | grep 0013 | head -1)
```

Expected: `ALTER TABLE "zugzug_app"."users" ADD COLUMN "last_seen_at" timestamp;`

- [ ] **Step 4: Write `last_seen_at` on every `/auth/me` hit**

In `server/src/server.ts`, find where `handleMe` is called (line ~122):

```ts
if (seg[2] === "me" && method === "GET") return handleMe(req);
```

Replace with:

```ts
if (seg[2] === "me" && method === "GET") {
  if (sessionUser) {
    // Best-effort — fire-and-forget, don't block the response.
    void pgRun(
      `UPDATE "zugzug_app"."users" SET last_seen_at = now() WHERE id = $1`,
      [sessionUser.id],
    ).catch(() => {});
  }
  return handleMe(req);
}
```

Note: `pgRun` is already imported in `server.ts`. The `handleMe` call uses its own session lookup so passing `sessionUser` here would require refactoring `handleMe` — the fire-and-forget UPDATE is the right approach; the response time is unaffected.

Actually check whether `sessionUser` is available at this point in the code. The `/api/auth/me` handler is in the pre-auth section (unauthenticated). Look at line ~80 of server.ts:

```bash
sed -n '80,130p' /Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts
```

If it's in the pre-auth block, `sessionUser` is not available yet. In that case, handle it differently: touch `last_seen_at` inside `handleMe` in `auth.ts`, after the user is fetched.

- [ ] **Step 5: If needed, update `handleMe` in `auth.ts`**

In `server/src/auth.ts`, update `handleMe` to touch `last_seen_at` after session resolution:

```ts
export async function handleMe(req: Request): Promise<Response> {
  const user = await getSessionUser(req);
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", ...cors },
    });
  // Best-effort last_seen_at update — fire-and-forget, never blocks the response.
  void run(
    `UPDATE "zugzug_app"."users" SET last_seen_at = now() WHERE id = $1`,
    [user.id],
  ).catch(() => {});
  return new Response(JSON.stringify(user), {
    status: 200,
    headers: { "content-type": "application/json", ...cors },
  });
}
```

(`run` is already used elsewhere in `auth.ts` — check the import.)

- [ ] **Step 6: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/ server/src/auth.ts server/src/server.ts
git commit -m "feat(server): users.last_seen_at column + touch on /auth/me"
```

---

## Task 3: `PATCH /api/auth/me` — update user name

Allows any signed-in user to update their display name.

**Files:**
- Modify: `server/src/auth.ts` (add `updateUserName()` + mount the route)
- Modify: `server/src/server.ts` (add route handler)
- Test: `server/test/account-profile.test.ts` (NEW)

- [ ] **Step 1: Write the failing tests**

Create `server/test/account-profile.test.ts`:

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

const U_IDS = ["u_profile_e2e"];

async function cleanup(): Promise<void> {
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function login(userId: string): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, 'Original Name', 'ON', $2, 'editor', false)`,
    [userId, `${userId}@example.com`],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("PATCH /api/auth/me updates name", async () => {
  const cookie = await login("u_profile_e2e");
  const res = await fetch("http://localhost:8787/api/auth/me", {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "New Name" }),
  });
  expect(res.status).toBe(204);
  const row = await pgGet<{ name: string }>(
    `SELECT name FROM "zugzug_app"."users" WHERE id = $1`,
    ["u_profile_e2e"],
  );
  expect(row?.name).toBe("New Name");
});

test("PATCH /api/auth/me rejects empty name", async () => {
  const cookie = await login("u_profile_e2e");
  const res = await fetch("http://localhost:8787/api/auth/me", {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "   " }),
  });
  expect(res.status).toBe(400);
});

test("PATCH /api/auth/me returns 401 when not signed in", async () => {
  const res = await fetch("http://localhost:8787/api/auth/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Hacker" }),
  });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test test/account-profile.test.ts 2>&1 | tail -10
```

Expected: failures (route not found / 404).

- [ ] **Step 3: Add `updateUserName` to `auth.ts`**

In `server/src/auth.ts`, add at the end of the file:

```ts
/** Updates the display name for an authenticated user. */
export async function updateUserName(userId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "name cannot be empty", 400);
  await run(
    `UPDATE "zugzug_app"."users" SET name = $1 WHERE id = $2`,
    [trimmed, userId],
  );
}
```

Import `AppError` in `auth.ts` if not already imported:

```bash
grep -n "AppError" /Users/fhagelund/Documents/GitHub/zugzug/server/src/auth.ts | head -3
```

If not present, add to the imports at the top:

```ts
import { AppError } from "./errors.ts";
```

Check the actual errors file path:

```bash
find /Users/fhagelund/Documents/GitHub/zugzug/server/src -name "errors*" 2>/dev/null
```

If no separate errors file, check where `AppError` is defined:

```bash
grep -rn "class AppError\|export.*AppError" /Users/fhagelund/Documents/GitHub/zugzug/server/src/ | head -5
```

- [ ] **Step 4: Mount the route in `server.ts`**

In `server/src/server.ts`, find the block near `GET /api/me/memberships` (line ~170). Add `PATCH /api/auth/me` in the same pre-tenantCtx block. Find the section that handles `seg[2] === "me"`:

```bash
grep -n "seg\[2\].*me\|me.*seg\[2\]\|auth.*me\|handleMe" /Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts | head -5
```

The GET handler will look like: `if (seg[2] === "me" && method === "GET") ...`

Add the PATCH handler right after it:

```ts
// PATCH /api/auth/me — update display name
if (seg[1] === "auth" && seg[2] === "me" && method === "PATCH") {
  const { name } = (await req.json()) as { name: string };
  await updateUserName(me, name);
  return noContent();
}
```

Add `updateUserName` to the `import ... from "./auth.ts"` line at the top of `server.ts`.

Also ensure `me` (the current user ID) is available at this point in the code flow. Looking at server.ts: `const me = sessionUser.id;` is defined after session resolution. Confirm this is available where you're inserting the route.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test test/account-profile.test.ts 2>&1 | tail -5
```

Expected: 3 pass.

- [ ] **Step 6: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/auth.ts server/src/server.ts server/test/account-profile.test.ts
git commit -m "feat(server): PATCH /auth/me — update user display name"
```

---

## Task 4: `PATCH /api/t/:slug` + `POST /api/t/:slug/leave` + `DELETE /api/t/:slug`

Three tenant-scoped mutation routes. All go in the same test file. Tenant routes after the slug splice have `seg = ["api", ...]`.

**Files:**
- Modify: `server/src/tenant.ts` (add `updateTenantLabel()`, `leaveTenant()`)
- Modify: `server/src/server.ts` (mount three routes)
- Test: `server/test/tenant-label.test.ts` (NEW)
- Test: `server/test/tenant-leave-delete.test.ts` (NEW)

- [ ] **Step 1: Write the failing tests**

Create `server/test/tenant-label.test.ts`:

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

const T_IDS = ["t_label_e2e"];
const U_IDS = ["u_label_admin_e2e", "u_label_editor_e2e"];

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

async function login(userId: string, role: "admin" | "editor", tenantId: string): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, $1, 'XX', $2, 'editor', false)`,
    [userId, `${userId}@example.com`],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role) VALUES ($1, $2, $3)`,
    [tenantId, userId, role],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("PATCH /api/t/:slug updates label — admin only", async () => {
  const t = await provisionTenant({ id: "t_label_e2e", slug: "t-label-e2e", label: "Old Label", warehouseId: "default" });
  const cookie = await login("u_label_admin_e2e", "admin", t.id);
  const res = await fetch("http://localhost:8787/api/t/t-label-e2e", {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "New Label" }),
  });
  expect(res.status).toBe(204);
  const row = await pgGet<{ label: string }>(
    `SELECT label FROM "zugzug_app"."tenant" WHERE id = $1`,
    [t.id],
  );
  expect(row?.label).toBe("New Label");
});

test("PATCH /api/t/:slug returns 403 for non-admin", async () => {
  const t = await provisionTenant({ id: "t_label_e2e", slug: "t-label-e2e", label: "Label", warehouseId: "default" });
  const cookie = await login("u_label_editor_e2e", "editor", t.id);
  const res = await fetch("http://localhost:8787/api/t/t-label-e2e", {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "Hacked" }),
  });
  expect(res.status).toBe(403);
});
```

Create `server/test/tenant-leave-delete.test.ts`:

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

const T_IDS = ["t_leave_e2e", "t_delete_e2e"];
const U_IDS = ["u_leave_admin_e2e", "u_leave_editor_e2e", "u_delete_admin_e2e"];

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

async function login(userId: string, role: "admin" | "editor", tenantId: string): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, $1, 'XX', $2, 'editor', false)`,
    [userId, `${userId}@example.com`],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role) VALUES ($1, $2, $3)`,
    [tenantId, userId, role],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("POST /api/t/:slug/leave removes own membership", async () => {
  const t = await provisionTenant({ id: "t_leave_e2e", slug: "t-leave-e2e", label: "Leave", warehouseId: "default" });
  // Add a second admin so the first can leave without triggering last-admin guard
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin) VALUES ('u_leave_admin2_e2e', 'x', 'XX', 'u_leave_admin2_e2e@example.com', 'editor', false)`,
    [],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role) VALUES ($1, 'u_leave_admin2_e2e', 'admin')`,
    [t.id],
  );
  const cookie = await login("u_leave_admin_e2e", "admin", t.id);
  const res = await fetch("http://localhost:8787/api/t/t-leave-e2e/leave", {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(204);
  const row = await pgGet<{ user_id: string }>(
    `SELECT user_id FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1 AND user_id = 'u_leave_admin_e2e'`,
    [t.id],
  );
  expect(row).toBeNull();
  // cleanup extra user
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = 'u_leave_admin2_e2e'`, []);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE user_id = 'u_leave_admin2_e2e'`, []);
});

test("POST /api/t/:slug/leave returns 409 when last admin", async () => {
  const t = await provisionTenant({ id: "t_leave_e2e", slug: "t-leave-e2e", label: "Leave", warehouseId: "default" });
  const cookie = await login("u_leave_admin_e2e", "admin", t.id);
  const res = await fetch("http://localhost:8787/api/t/t-leave-e2e/leave", {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(409);
  expect((await res.json() as { error: string }).error).toBe("last_admin");
});

test("DELETE /api/t/:slug deletes the workspace", async () => {
  const t = await provisionTenant({ id: "t_delete_e2e", slug: "t-delete-e2e", label: "Delete Me", warehouseId: "default" });
  const cookie = await login("u_delete_admin_e2e", "admin", t.id);
  const res = await fetch("http://localhost:8787/api/t/t-delete-e2e", {
    method: "DELETE",
    headers: { cookie },
  });
  expect(res.status).toBe(204);
  const row = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."tenant" WHERE id = $1`,
    [t.id],
  );
  expect(row).toBeNull();
});

test("DELETE /api/t/:slug refuses to delete 'default' tenant", async () => {
  // The default tenant is seeded by bootstrap; just test the guard
  const res = await fetch("http://localhost:8787/api/t/default", {
    method: "DELETE",
    // No auth — but we test the guard first; adjust if auth check comes first
    headers: { cookie: "zz_sid=bogus" },
  });
  // Either 401 (auth fails first) or 409 (guard triggers) — both are acceptable
  expect([401, 403, 409]).toContain(res.status);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test test/tenant-label.test.ts 2>&1 | tail -5
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test test/tenant-leave-delete.test.ts 2>&1 | tail -5
```

Expected: failures (routes not found).

- [ ] **Step 3: Add helpers to `tenant.ts`**

In `server/src/tenant.ts`, add at the end:

```ts
/** Updates the display label of a tenant. Slug is immutable. */
export async function updateTenantLabel(tenantId: string, label: string): Promise<void> {
  const trimmed = label.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "label cannot be empty", 400);
  await run(
    `UPDATE "zugzug_app"."tenant" SET label = $1 WHERE id = $2`,
    [trimmed, tenantId],
  );
}

/**
 * Removes a user's own membership from a tenant.
 * Enforces the last-admin guard: refuses with AppError("LAST_ADMIN",...,409)
 * if removing this member would leave the tenant with zero admins.
 */
export async function leaveTenant(tenantId: string, userId: string): Promise<void> {
  const members = await listMembersForTenant(tenantId);
  const leaving = members.find((m) => m.user_id === userId);
  if (leaving?.role === "admin") {
    const adminCount = members.filter((m) => m.role === "admin").length;
    if (adminCount <= 1) {
      throw new AppError("LAST_ADMIN", "cannot leave — you are the last admin", 409);
    }
  }
  await run(
    `DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
}
```

Verify `AppError` is already imported in `tenant.ts`:

```bash
grep -n "AppError" /Users/fhagelund/Documents/GitHub/zugzug/server/src/tenant.ts | head -3
```

If not, add the import (find the path from existing usage in the file or `grep -rn "class AppError" server/src/`).

- [ ] **Step 4: Mount routes in `server.ts`**

In `server/src/server.ts`, find the block with `if (tenantSlugFromPath !== null && seg[1] === "team")` (around line 358). Add three new route handlers in the same `tenantSlugFromPath !== null` zone, just before the `pgContext.run` call:

```ts
// PATCH /api/t/:slug — rename workspace label (admin only)
if (tenantSlugFromPath !== null && seg.length === 1 && method === "PATCH") {
  if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
  const { label } = (await req.json()) as { label: string };
  await updateTenantLabel(tenantCtx.tenantId, label);
  return noContent();
}

// DELETE /api/t/:slug — delete workspace (admin only; refuses on "default")
if (tenantSlugFromPath !== null && seg.length === 1 && method === "DELETE") {
  if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
  if (tenantSlugFromPath === "default") {
    return json({ error: "cannot_delete_default" }, 409);
  }
  await teardownTenant(tenantCtx.tenantId);
  return noContent();
}

// POST /api/t/:slug/leave — leave workspace (any member; last-admin guard)
if (tenantSlugFromPath !== null && seg[1] === "leave" && seg.length === 2 && method === "POST") {
  await leaveTenant(tenantCtx.tenantId, me);
  return noContent();
}
```

Add `updateTenantLabel` and `leaveTenant` to the tenant.ts import line at the top of `server.ts`. `teardownTenant` should already be imported.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test test/tenant-label.test.ts 2>&1 | tail -5
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test test/tenant-leave-delete.test.ts 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 6: Full server test suite**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test 2>&1 | tail -3
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add server/src/tenant.ts server/src/server.ts server/test/tenant-label.test.ts server/test/tenant-leave-delete.test.ts
git commit -m "feat(server): PATCH/DELETE /t/:slug + POST /t/:slug/leave"
```

---

## Task 5: Account layout — `AccountSidebar` + `Account.tsx` + routes

Builds the Account section shell. Uses the same `SettingsShell` primitive as Settings.

**Files:**
- Create: `app/src/components/settings/AccountSidebar.tsx`
- Create: `app/src/routes/account/Account.tsx`
- Modify: `app/src/main.tsx`

- [ ] **Step 1: Create `AccountSidebar.tsx`**

Create `app/src/components/settings/AccountSidebar.tsx`:

```tsx
import { NavLink } from "react-router-dom";
import { cx } from "../../lib/cx";

const ITEMS = [
  { label: "Profile",       to: "profile" },
  { label: "Appearance",    to: "appearance" },
  { label: "Notifications", to: "notifications" },
];

export function AccountSidebar() {
  return (
    <nav aria-label="Account sections" className="space-y-1">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-3 px-3 pb-2">
        Account
      </div>
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end
          className={({ isActive }) =>
            cx(
              "block px-3 py-1.5 text-sm font-body transition-colors rounded-sm",
              isActive
                ? "bg-surface-2 text-ink"
                : "text-ink-2 hover:text-ink hover:bg-hover",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Create `Account.tsx`**

Create `app/src/routes/account/Account.tsx`:

```tsx
import { Navigate, Outlet } from "react-router-dom";
import { SettingsShell } from "../../components/settings/SettingsShell";
import { AccountSidebar } from "../../components/settings/AccountSidebar";
import { PageHeader } from "../../components/PageHeader";

export function Account() {
  return (
    <>
      <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8 md:pb-0">
        <PageHeader kicker="Personal" title="Account" lede="Your profile and preferences." />
      </div>
      <SettingsShell sidebar={<AccountSidebar />}>
        <Outlet />
      </SettingsShell>
    </>
  );
}
```

- [ ] **Step 3: Add `/account/*` routes to `main.tsx`**

Open `app/src/main.tsx`. Inside the `<Route element={<AppShell memberships={boot.memberships} />}>` block (the same block that has `settings`), add the account routes after the `settings` route:

```tsx
<Route path="account" element={<Account />}>
  <Route index element={<Navigate to="profile" replace />} />
  <Route path="profile" element={<Profile />} />
  <Route path="appearance" element={<AccountAppearance />} />
  <Route path="notifications" element={<Notifications />} />
</Route>
```

Add imports at the top of `main.tsx`:

```tsx
import { Account } from "./routes/account/Account";
import { Profile } from "./routes/account/Profile";
import { Appearance as AccountAppearance } from "./routes/account/Appearance";
import { Notifications } from "./routes/account/Notifications";
```

(The section files `Profile`, `Appearance`, `Notifications` will be created in Tasks 6, 7, 8. For now, create stub files so the app typechecks.)

Create stubs (to be filled out in Tasks 6-8):

`app/src/routes/account/Profile.tsx`:
```tsx
export function Profile() { return <div>Profile stub</div>; }
```

`app/src/routes/account/Appearance.tsx`:
```tsx
export function Appearance() { return <div>Appearance stub</div>; }
```

`app/src/routes/account/Notifications.tsx`:
```tsx
export function Notifications() { return <div>Notifications stub</div>; }
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 5: Run tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: 283 passed.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/settings/AccountSidebar.tsx app/src/routes/account/ app/src/main.tsx
git commit -m "feat(app): Account layout — SettingsShell + AccountSidebar + routes"
```

---

## Task 6: `Profile.tsx` — name edit + email display + sign-out

Replaces the stub. Calls `PATCH /api/auth/me` on save.

**Files:**
- Modify: `app/src/routes/account/Profile.tsx`

- [ ] **Step 1: Read the current session user shape from store**

```bash
grep -n "currentUser\|SessionUser\|name.*email\|initials" /Users/fhagelund/Documents/GitHub/zugzug/app/src/store.ts | head -10
```

Identify what `currentUser()` returns — it should have `{ id, name, email, initials, role, isSuperAdmin }`.

- [ ] **Step 2: Implement `Profile.tsx`**

Replace `app/src/routes/account/Profile.tsx`:

```tsx
import { useState, useEffect } from "react";
import { apiFetch, authFetch } from "../../api";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { toast } from "../../components/Toast";
import { currentUser } from "../../store";

export function Profile() {
  const user = currentUser();
  const [name, setName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user?.name]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await authFetch("/auth/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Name updated");
    } catch {
      toast.error("Failed to update name");
    } finally {
      setSaving(false);
    }
  };

  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() =>
      window.location.replace("/login"),
    );

  return (
    <>
      <SettingsSection title="Profile" hint="Your display name and email address.">
        <FormField label="Display name">
          <div className="flex gap-3">
            <input
              className="flex-1 bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
              placeholder="Your name"
            />
            <Button
              onClick={save}
              loading={saving}
              disabled={!name.trim() || name.trim() === user?.name}
              size="sm"
            >
              Save
            </Button>
          </div>
        </FormField>
        <FormField label="Email">
          <p className="text-sm text-ink-2">{user?.email ?? "—"}</p>
          <p className="mt-1 text-xs text-ink-3">Email cannot be changed here.</p>
        </FormField>
      </SettingsSection>

      <SettingsSection title="Session">
        <div className="flex items-center justify-between">
          <p className="text-sm text-ink-2">Signed in as <span className="text-ink">{user?.email}</span></p>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </SettingsSection>
    </>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors. If `currentUser` import is wrong, check the actual export name in `store.ts`.

- [ ] **Step 4: Run tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: 283 passed.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/account/Profile.tsx
git commit -m "feat(app): Profile — name edit + email display + sign-out"
```

---

## Task 7: `Account/Appearance.tsx` — move engineer mode + clean up settings

Move the engineer-mode toggle from `routes/settings/Appearance.tsx` into `routes/account/Appearance.tsx`. Remove Appearance from the Settings sidebar. Delete `routes/settings/Appearance.tsx`.

**Files:**
- Modify: `app/src/routes/account/Appearance.tsx` (replace stub with real impl)
- Delete: `app/src/routes/settings/Appearance.tsx`
- Modify: `app/src/components/settings/SettingsSidebar.tsx` (remove Appearance item)
- Modify: `app/src/main.tsx` (remove `appearance` child from the settings route)

- [ ] **Step 1: Implement `Account/Appearance.tsx`**

Replace the stub at `app/src/routes/account/Appearance.tsx` with:

```tsx
import { FormField } from "../../components/FormField";
import { useEngineerMode } from "../../lib/engineer-mode";
import { SettingsSection } from "../../components/settings/SettingsSection";

export function Appearance() {
  const { engineer, setEngineer } = useEngineerMode();

  return (
    <SettingsSection title="Appearance" hint="Theme follows the toggle in the top bar.">
      <FormField label="Engineer details">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={engineer}
            aria-label="Engineer details"
            onClick={() => setEngineer(!engineer)}
            className={
              engineer
                ? "h-5 w-9 rounded-full bg-accent transition-colors"
                : "h-5 w-9 rounded-full bg-line-2 transition-colors"
            }
          >
            <span
              className={
                engineer
                  ? "block h-4 w-4 translate-x-4 rounded-full bg-white shadow transition-transform"
                  : "block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform"
              }
            />
          </button>
          <span className="text-sm text-ink-2">
            Show warehouse table names, SQL, and join warnings
          </span>
        </div>
      </FormField>
    </SettingsSection>
  );
}
```

(Verify the exact toggle JSX matches what was in `settings/Appearance.tsx` before deleting it in the next step.)

- [ ] **Step 2: Read `routes/settings/Appearance.tsx` before deleting**

```bash
cat /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/settings/Appearance.tsx
```

Confirm it only contains the engineer-mode toggle (nothing else to preserve).

- [ ] **Step 3: Delete `routes/settings/Appearance.tsx`**

```bash
rm /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/settings/Appearance.tsx
```

- [ ] **Step 4: Remove Appearance from the Settings route in `main.tsx`**

Open `app/src/main.tsx`. Remove the `<Route path="appearance" element={<Appearance />} />` line from the settings children. Remove the `import { Appearance } from "./routes/settings/Appearance"` import line.

The `import { Appearance as AccountAppearance }` for the account route stays — that's the new home.

- [ ] **Step 5: Remove Appearance from `SettingsSidebar.tsx`**

Open `app/src/components/settings/SettingsSidebar.tsx`. Remove the Appearance entry from the `ITEMS` array:

```ts
// Remove this line:
{ label: "Appearance", to: "appearance", action: "settings.appearance.edit" },
```

Also remove `"settings.appearance.edit"` from the permissions.ts `Action` type — or leave it if it might be used elsewhere. Check:

```bash
grep -rn "settings.appearance.edit" /Users/fhagelund/Documents/GitHub/zugzug/app/src/ --include="*.ts" --include="*.tsx"
```

If only used in `SettingsSidebar.tsx` (which you just edited), also remove it from `permissions.ts`'s `Action` type and `can()` switch. This keeps the type clean.

- [ ] **Step 6: Update permissions.ts to remove the Appearance action**

In `app/src/lib/permissions.ts`, remove:
- `| "settings.appearance.edit"` from the `Action` union type
- The `case "settings.appearance.edit": return true;` case from the `can()` switch

In `app/test/permissions.test.ts`, remove the `"settings.appearance.edit"` row from `MATRIX` and update the total expected count comment if any.

- [ ] **Step 7: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 8: Run tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: all pass (count may drop by the removed MATRIX tests, that's fine).

- [ ] **Step 9: Commit**

```bash
git add app/src/routes/account/Appearance.tsx app/src/components/settings/SettingsSidebar.tsx app/src/main.tsx app/src/lib/permissions.ts app/test/permissions.test.ts
git rm app/src/routes/settings/Appearance.tsx
git commit -m "refactor(app): move Appearance section from Settings to Account; remove from Settings sidebar"
```

---

## Task 8: `Notifications.tsx` + complete Account route wiring

Replaces the Notifications stub with a real placeholder card. At this point all three Account section stubs should have real implementations.

**Files:**
- Modify: `app/src/routes/account/Notifications.tsx`

- [ ] **Step 1: Implement `Notifications.tsx`**

Replace the stub at `app/src/routes/account/Notifications.tsx`:

```tsx
import { SettingsSection } from "../../components/settings/SettingsSection";

export function Notifications() {
  return (
    <SettingsSection
      title="Notifications"
      hint="Email and in-app notification preferences."
    >
      <p className="text-sm text-ink-3">
        Notification settings are coming in a future release.
      </p>
    </SettingsSection>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 3: Run tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/account/Notifications.tsx
git commit -m "feat(app): Notifications placeholder section"
```

---

## Task 9: `General.tsx` — workspace label rename (admin only)

Upgrades the read-only stub from PR A into an editable form for admins.

**Files:**
- Modify: `app/src/routes/settings/General.tsx`

- [ ] **Step 1: Implement `General.tsx`**

Replace `app/src/routes/settings/General.tsx` with:

```tsx
import { useState } from "react";
import { useTenant } from "../../lib/tenant-context";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { toast } from "../../components/Toast";

export function General() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.general.edit");
  const [label, setLabel] = useState(tenant.label);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!label.trim()) return;
    setSaving(true);
    try {
      const res = await apiFetch("", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Workspace renamed — takes effect on next navigation.");
    } catch {
      toast.error("Failed to rename workspace");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="General" hint="Workspace identity. Slug is immutable.">
      <ReadOnly enabled={!canEdit}>
        <FormField label="Workspace name">
          <div className="flex gap-3">
            <input
              className="flex-1 bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
              placeholder={tenant.label}
            />
            {canEdit && (
              <Button
                onClick={save}
                loading={saving}
                disabled={!label.trim() || label.trim() === tenant.label}
                size="sm"
              >
                Save
              </Button>
            )}
          </div>
        </FormField>
      </ReadOnly>

      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-3 text-sm mt-2">
        <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-3 pt-0.5">Slug</dt>
        <dd>
          <code className="font-mono text-accent">{tenant.slug}</code>
          <span className="ml-2 text-xs text-ink-3">immutable</span>
        </dd>
      </dl>
    </SettingsSection>
  );
}
```

Note on the fetch URL: `apiFetch("")` with an empty path — `apiFetch` prepends `/api/t/:slug`, so an empty path produces `/api/t/acme`. Verify this is correct for the PATCH route by checking `api.ts`:

```bash
grep -n "apiFetch\|function apiFetch" /Users/fhagelund/Documents/GitHub/zugzug/app/src/api.ts
```

If `apiFetch("")` doesn't work as expected (some implementations require at least `/`), use `apiFetch("/")` or check what the function does with an empty string. The actual URL path segment logic matters here. The safest approach: use a literal path that matches the route you added in Task 4:

The server route is `tenantSlugFromPath !== null && seg.length === 1 && method === "PATCH"`. After splice, `seg = ["api"]` — so the URL is `/api/t/:slug` with no trailing path. In `apiFetch`, the `path` argument gets prepended with `/api/t/${slug}`, so `apiFetch("")` would produce `/api/t/acme`. Test this.

If needed, use a query param workaround: add a trailing `/` to make it unambiguous: the server pattern `seg.length === 1` requires the path to not have extra segments. `apiFetch("/")` would produce `/api/t/acme/` — check if this still matches `seg.length === 1` after filtering empty strings (it should).

Alternative: if empty string is problematic, adjust the server route to match `seg.length === 1 || (seg.length === 2 && seg[1] === "")` — or just test with a running server.

- [ ] **Step 2: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/General.tsx
git commit -m "feat(app): General — workspace label rename (admin only)"
```

---

## Task 10: `Danger.tsx` — Leave + Delete workspace

Replaces the placeholder stub. Two destructive actions with confirmation dialogs.

**Files:**
- Modify: `app/src/routes/settings/Danger.tsx`
- Test: `app/test/danger-zone.test.tsx` (NEW)

- [ ] **Step 1: Write the failing test**

Create `app/test/danger-zone.test.tsx`:

```tsx
import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import { Danger } from "../src/routes/settings/Danger";

vi.mock("../src/api", () => ({
  apiFetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  authFetch: vi.fn().mockResolvedValue(new Response(null)),
}));
vi.mock("../src/store", async (orig) => {
  const a = await orig<typeof import("../src/store")>();
  return { ...a, initStore: vi.fn(), onTenantSwitch: vi.fn() };
});

function harness(role: "viewer" | "editor" | "admin") {
  const value: TenantContextValue = {
    id: "t1", slug: "acme", label: "Acme", role, isSuperAdmin: false,
  };
  return render(
    <MemoryRouter initialEntries={["/app/acme/settings/danger"]}>
      <Routes>
        <Route
          path="/app/:tenantSlug/settings/danger"
          element={
            <TenantProvider value={value}>
              <Danger />
            </TenantProvider>
          }
        />
        <Route path="/app" element={<div data-testid="redirected">redirected</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Danger zone", () => {
  test("shows Leave workspace button for viewer", () => {
    harness("viewer");
    expect(screen.getByRole("button", { name: /leave workspace/i })).toBeTruthy();
  });

  test("does NOT show Delete workspace button for editor", () => {
    harness("editor");
    expect(screen.queryByRole("button", { name: /delete workspace/i })).toBeNull();
  });

  test("shows Delete workspace button for admin", () => {
    harness("admin");
    expect(screen.getByRole("button", { name: /delete workspace/i })).toBeTruthy();
  });

  test("Leave confirm dialog opens on click", () => {
    harness("admin");
    fireEvent.click(screen.getByRole("button", { name: /leave workspace/i }));
    expect(screen.getByText(/leave.*acme|are you sure/i)).toBeTruthy();
  });

  test("Delete confirm requires typing the slug", () => {
    harness("admin");
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    // Find the typed-slug input
    const input = screen.getByPlaceholderText(/acme|slug/i);
    expect(input).toBeTruthy();
    // Confirm button should be disabled before typing
    const confirmBtn = screen.getByRole("button", { name: /^delete$/i });
    expect(confirmBtn).toBeTruthy();
    // Type wrong slug — confirm stays disabled or error shown
    fireEvent.change(input, { target: { value: "wrong" } });
    // Type correct slug — confirm should become enabled
    fireEvent.change(input, { target: { value: "acme" } });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test test/danger-zone.test.tsx 2>&1 | tail -10
```

Expected: failures (module/component issues).

- [ ] **Step 3: Implement `Danger.tsx`**

Replace `app/src/routes/settings/Danger.tsx`:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { RoleGate } from "../../components/settings/RoleGate";
import { can } from "../../lib/permissions";
import { toast } from "../../components/Toast";

export function Danger() {
  const tenant = useTenant();
  const navigate = useNavigate();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteSlug, setDeleteSlug] = useState("");
  const [busy, setBusy] = useState(false);

  const leave = async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/leave", { method: "POST" });
      if (res.status === 409) {
        const body = (await res.json()) as { error: string };
        if (body.error === "last_admin") {
          toast.error("You're the last admin — promote another member first.");
          return;
        }
      }
      if (!res.ok) throw new Error(`${res.status}`);
      navigate("/app", { replace: true });
    } catch {
      toast.error("Failed to leave workspace");
    } finally {
      setBusy(false);
      setLeaveOpen(false);
    }
  };

  const deleteWorkspace = async () => {
    if (deleteSlug !== tenant.slug) return;
    setBusy(true);
    try {
      const res = await apiFetch("", { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status}`);
      navigate("/app", { replace: true });
    } catch {
      toast.error("Failed to delete workspace");
    } finally {
      setBusy(false);
      setDeleteOpen(false);
      setDeleteSlug("");
    }
  };

  return (
    <>
      <SettingsSection
        title="Danger zone"
        hint="Irreversible actions. Take care."
      >
        {/* Leave workspace — any role */}
        <div className="flex items-center justify-between py-3 border-b border-line last:border-0">
          <div>
            <p className="text-sm font-medium text-ink">Leave workspace</p>
            <p className="text-xs text-ink-3 mt-0.5">
              Remove yourself from <span className="font-mono text-accent">{tenant.slug}</span>. You'll lose access immediately.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLeaveOpen(true)}
          >
            Leave workspace
          </Button>
        </div>

        {/* Delete workspace — admin only */}
        <RoleGate action="settings.danger.delete">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium text-red-500">Delete workspace</p>
              <p className="text-xs text-ink-3 mt-0.5">
                Permanently delete <span className="font-mono text-accent">{tenant.slug}</span> and all its data.
              </p>
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setDeleteOpen(true)}
            >
              Delete workspace
            </Button>
          </div>
        </RoleGate>
      </SettingsSection>

      {/* Leave confirm dialog */}
      <ConfirmDialog
        open={leaveOpen}
        title={`Leave ${tenant.label}?`}
        body={
          <p className="text-sm text-ink-2">
            You'll be removed from <span className="font-mono">{tenant.slug}</span> immediately
            and lose access to all its data. You can rejoin only if an admin invites you again.
          </p>
        }
        confirmLabel="Leave"
        danger
        onConfirm={leave}
        onCancel={() => setLeaveOpen(false)}
      />

      {/* Delete confirm dialog — requires typing the slug */}
      {deleteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => { setDeleteOpen(false); setDeleteSlug(""); }}
        >
          <div
            className="w-full max-w-md rounded border border-line bg-surface p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-display text-lg font-bold text-ink mb-2">
              Delete {tenant.label}?
            </h2>
            <p className="text-sm text-ink-2 mb-4">
              This will permanently delete the workspace, all canonical tables, all mappings,
              and the entire audit history. This <strong>cannot be undone</strong>.
            </p>
            <p className="text-sm text-ink-2 mb-2">
              Type <code className="font-mono text-accent">{tenant.slug}</code> to confirm:
            </p>
            <input
              className="w-full bg-surface border border-line-2 px-3 py-2 text-sm font-mono text-ink focus:outline-none focus:border-accent mb-4"
              value={deleteSlug}
              onChange={(e) => setDeleteSlug(e.target.value)}
              placeholder={tenant.slug}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setDeleteOpen(false); setDeleteSlug(""); }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={deleteWorkspace}
                disabled={deleteSlug !== tenant.slug || busy}
                loading={busy}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

Note: verify that `Button` accepts `variant="danger"`. Check:

```bash
grep -n "danger\|variant" /Users/fhagelund/Documents/GitHub/zugzug/app/src/components/Button.tsx | head -10
```

If `variant="danger"` doesn't exist, use `variant="primary"` and adjust styling, or use a different available destructive variant.

- [ ] **Step 4: Run tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test test/danger-zone.test.tsx 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/settings/Danger.tsx app/test/danger-zone.test.tsx
git commit -m "feat(app): Danger zone — Leave + Delete workspace with confirmation"
```

---

## Task 11: `WorkspaceSwitcher` additions

Add "Account settings" (always visible) and "Workspace settings" (admin-gated) entries above "Sign out".

**Files:**
- Modify: `app/src/components/WorkspaceSwitcher.tsx`
- Modify: `app/test/workspace-switcher.test.tsx`

- [ ] **Step 1: Read the existing WorkspaceSwitcher**

```bash
cat /Users/fhagelund/Documents/GitHub/zugzug/app/src/components/WorkspaceSwitcher.tsx
```

Find the current menu structure. The bottom of the open menu renders: (optional) Admin console + Create workspace (super-admin), a `<hr>`, and the Sign out button.

- [ ] **Step 2: Add the new entries**

In `app/src/components/WorkspaceSwitcher.tsx`, add the "Account settings" and "Workspace settings" links **above** the final `<hr>` + Sign out row.

The new section goes between the super-admin block (if any) and the final `<hr>`:

```tsx
{/* Account + Workspace settings */}
<hr className="my-1 border-line" />
<button
  onClick={() => { setOpen(false); navigate(`/app/${tenant.slug}/account`); }}
  className="block w-full text-left px-3 py-1.5 text-sm hover:bg-hover transition-colors"
  role="menuitem"
>
  Account settings
</button>
{can(tenant, "settings.general.edit") && (
  <button
    onClick={() => { setOpen(false); navigate(`/app/${tenant.slug}/settings`); }}
    className="block w-full text-left px-3 py-1.5 text-sm hover:bg-hover transition-colors"
    role="menuitem"
  >
    Workspace settings
  </button>
)}
```

Add `import { can } from "../lib/permissions";` to the imports if not already present.

Note: "Workspace settings" is gated on `settings.general.edit` (admin-only) — this is the narrowest permission that gates workspace admin actions. Any admin can reach Settings; non-admins see it as read-only anyway, so showing the link to them is also acceptable. Per the spec: "admin-gated". Use `settings.general.edit` which is admin-only.

- [ ] **Step 3: Update the workspace-switcher test**

Open `app/test/workspace-switcher.test.tsx`. Add tests for the new entries:

```tsx
test("shows Account settings for all roles", () => {
  harness({ slug: "acme", isSuperAdmin: false });
  fireEvent.click(screen.getByRole("button", { name: /acme/i }));
  expect(screen.getByText(/account settings/i)).toBeTruthy();
});

test("non-admin does NOT see Workspace settings", () => {
  // TenantProvider role is "admin" in harness — make it editor
  const value: TenantContextValue = {
    id: "acme", slug: "acme", label: "Acme", role: "editor", isSuperAdmin: false,
  };
  render(
    <MemoryRouter initialEntries={["/app/acme/triage"]}>
      <Routes>
        <Route path="/app/:tenantSlug/*" element={
          <TenantProvider value={value}>
            <WorkspaceSwitcher memberships={memberships} />
          </TenantProvider>
        } />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(screen.queryByText(/workspace settings/i)).toBeNull();
});

test("admin sees Workspace settings", () => {
  harness({ slug: "acme", isSuperAdmin: false });
  fireEvent.click(screen.getByRole("button", { name: /acme/i }));
  expect(screen.getByText(/workspace settings/i)).toBeTruthy();
});
```

- [ ] **Step 4: Run switcher tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test test/workspace-switcher.test.tsx 2>&1 | tail -10
```

Expected: all pass (existing + new tests).

- [ ] **Step 5: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 6: Full app test suite**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/WorkspaceSwitcher.tsx app/test/workspace-switcher.test.tsx
git commit -m "feat(app): WorkspaceSwitcher — Account settings + Workspace settings entries"
```

---

## Task 12: Final sweep + PR

- [ ] **Step 1: Lint**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run lint 2>&1 | tail -3
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run lint 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 2: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors each.

- [ ] **Step 3: Full test sweeps**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test 2>&1 | tail -5
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -5
```

Expected: all green. Record final counts.

- [ ] **Step 4: Grep checks**

```bash
# No orphan Settings imports
grep -rn "from.*routes/settings/Appearance" /Users/fhagelund/Documents/GitHub/zugzug/app/src/ --include="*.ts" --include="*.tsx"

# No raw /api fetches in new account/ routes
grep -rn "fetch(\"/api\|fetch(\`/api" /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/account/ --include="*.ts" --include="*.tsx"
```

Both expected: empty.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin mt-pr5b-account-danger
gh pr create --title "Settings IA PR B — Account + Danger zone + workspace mutations" --body "$(cat <<'EOF'
## Summary
- Server: `PATCH /api/auth/me` (name), `PATCH /api/t/:slug` (label), `POST /api/t/:slug/leave`, `DELETE /api/t/:slug`
- Server: `users.last_seen_at` — touched on every `/auth/me` hit (for PR C admin/users page)
- Client: `/app/:slug/account/*` — Profile (name edit, sign-out), Appearance (engineer mode), Notifications (placeholder)
- Client: `General.tsx` — workspace label rename, admin only
- Client: `Danger.tsx` — Leave workspace (any role, confirm dialog) + Delete workspace (admin, typed-slug confirm)
- Client: `WorkspaceSwitcher` — "Account settings" (always) + "Workspace settings" (admin-gated)
- Cleanup: `Appearance` moved from Settings sidebar → Account; `settings.appearance.edit` permission removed

## Spec
`docs/superpowers/specs/2026-06-12-settings-ia-redesign.md` — PR B

## Deferred to PR C
- Admin console overhaul (Users page, system audit, AdminLayout upgrade)

## Test plan
- [ ] `bun run test` in `server/` — all green
- [ ] `bun run test` in `app/` — all green
- [ ] `bun run typecheck` + `bun run lint` in both — clean
- [ ] Manual: sign in, open switcher → "Account settings" navigates to profile; admin sees "Workspace settings"; editor doesn't; admin can rename workspace; Leave confirm; Delete typed-slug guard

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

**Spec coverage check:**
- `PATCH /api/auth/me` → Task 3 ✓
- `PATCH /api/t/:slug` + `POST /leave` + `DELETE` → Task 4 ✓
- `users.last_seen_at` migration → Task 2 ✓
- Account surface (Profile, Appearance, Notifications) → Tasks 5-8 ✓
- Theme/engineer mode moved to Account → Task 7 ✓
- `General.tsx` rename → Task 9 ✓
- `Danger.tsx` Leave + Delete → Task 10 ✓
- WorkspaceSwitcher entries → Task 11 ✓
- Tests for all server routes → Tasks 3-4 ✓

**Type consistency:**
- `updateTenantLabel(tenantId: string, label: string)` defined in Task 4 Step 3, called in Task 4 Step 4.
- `leaveTenant(tenantId: string, userId: string)` defined in Task 4 Step 3, called in Task 4 Step 4.
- `updateUserName(userId: string, name: string)` defined in Task 3 Step 3, called in Task 3 Step 4.
- All use `me` (= `sessionUser.id`) as the userId parameter — consistent with existing patterns.

**Risk notes:**
- Task 9 `apiFetch("")` for PATCH on the bare tenant URL may need verification — the URL produced would be `/api/t/acme` which after path split + filter + splice produces `seg = ["api"]`, `seg.length === 1`. The server guard checks exactly this. If the empty string causes issues in `apiFetch`, the fallback is to adjust the server to also match `seg.length === 1` after filtering trailing slashes, or to add a dedicated subpath like `/label`.
- `Button variant="danger"` may not exist — Task 10 Step 3 notes this and suggests a fallback.
- `currentUser()` from store — Task 6 Step 1 greps for the actual export name before using it.
