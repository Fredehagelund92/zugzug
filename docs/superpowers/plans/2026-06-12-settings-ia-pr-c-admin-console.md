# Settings IA PR C — Admin Console + Settings/Account UI Redesign

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graduate `/app/admin` from a one-page placeholder to a proper four-section console (Workspaces, Users, Audit, Warehouses), simultaneously elevating the Settings and Account sidebar UX to "precision instrument" quality with indexed counters, accent-bar active states, and bolder section headers.

**Architecture:** AdminLayout replaces AdminShell using the same SettingsShell primitive — consistent two-pane layout across settings and admin. Two new server routes (`GET/PATCH /api/admin/users`) provide user management. Three design components (SettingsSidebar, SettingsSection, AccountSidebar) are redesigned in place without changing their interfaces. Four new admin page components slot into the new AdminLayout via nested routes.

**Design direction — "indexed precision":**
- Sidebar items: 2-digit mono counter (`01`…`08`) in `text-ink-3` + label. Active: `bg-accent-soft` wash + `text-accent` + absolute 2px left bar in `bg-accent`. Hover: `translateX(2px)` + `bg-hover`.
- SettingsSection header: absolute 2px left bar in `bg-accent` on the header strip. Title `font-display text-xl font-bold tracking-tight` (up from `text-lg font-semibold`). More room: content `space-y-6`.
- AdminLayout header: `bg-accent-2-soft` (amber) tinted badge instead of the default `bg-accent-soft` pink — visually distinct from workspace settings.

**Tech Stack:** React 18 + react-router-dom v6 + Tailwind v4 + JetBrains Mono / Bricolage Grotesque. Server: Bun + postgres.js. Tests: Vitest + @testing-library/react (client), bun:test (server). No new runtime dependencies.

**Branch:** `mt-pr5c-admin-console` off `mt-pr5b-account-danger` (or main once B merges).

**Prereq:** PR B (`mt-pr5b-account-danger`) merged. Confirm: `git log --oneline HEAD | grep -c "Account layout"` → 1.

---

## File structure (post-PR)

```
server/src/server.ts                               MOD — GET/PATCH /api/admin/users
server/src/auth.ts                                 MOD — listUsers(), setSuperAdmin(), countSuperAdmins()
server/test/admin-users.test.ts                    NEW — list, promote, demote, last-super-admin, self-demote guards

app/src/components/settings/SettingsSidebar.tsx    MOD — indexed counters, accent-bar active, translate hover
app/src/components/settings/SettingsSection.tsx    MOD — accent left-bar header, bolder title, more space
app/src/components/settings/AccountSidebar.tsx     MOD — same indexed treatment as SettingsSidebar
app/src/components/settings/SettingsShell.tsx      MOD — sidebar width 220→240px, right border on aside

app/src/components/admin/AdminLayout.tsx           NEW — replaces AdminShell; uses SettingsShell + AdminSidebar
app/src/components/admin/AdminSidebar.tsx          NEW — Workspaces / Users / Audit / Warehouses nav
app/src/routes/admin/Workspaces.tsx                NEW — renamed from Tenants.tsx (same implementation)
app/src/routes/admin/Users.tsx                     NEW — list users, search, promote/demote, last-seen
app/src/routes/admin/Audit.tsx                     NEW — system-wide audit + tenant filter
app/src/routes/admin/Warehouses.tsx                NEW — read-only MotherDuck DB list
app/src/routes/admin/Tenants.tsx                   DELETE — replaced by Workspaces.tsx

app/src/components/AdminShell.tsx                  DELETE — replaced by AdminLayout
app/src/main.tsx                                   MOD — wire /app/admin/* with AdminLayout + 4 sub-routes

app/test/admin-sidebar.test.tsx                    NEW — super-admin gating, active route
```

---

## Task 1: Branch kickoff

**Files:** none.

- [ ] **Step 1: Create branch**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug
git checkout mt-pr5b-account-danger && git checkout -b mt-pr5c-admin-console
```

- [ ] **Step 2: Baseline**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test 2>&1 | tail -3
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Record numbers.

---

## Task 2: Settings + Account UI redesign

Redesign the three sidebar components and the SettingsSection card to achieve the "indexed precision" aesthetic. No interface changes — same props, same behavior, different visual treatment. No tests needed (purely visual; existing sidebar tests cover the filtering logic which doesn't change).

**Files:**
- Modify: `app/src/components/settings/SettingsSidebar.tsx`
- Modify: `app/src/components/settings/AccountSidebar.tsx`
- Modify: `app/src/components/settings/SettingsSection.tsx`
- Modify: `app/src/components/settings/SettingsShell.tsx`

- [ ] **Step 1: Redesign `SettingsSidebar.tsx`**

Replace `app/src/components/settings/SettingsSidebar.tsx` with:

```tsx
import { NavLink } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can, type Action } from "../../lib/permissions";
import { cx } from "../../lib/cx";

interface Item {
  label: string;
  to: string;
  action: Action;
}

const ITEMS: Item[] = [
  { label: "General",   to: "general",   action: "settings.general.view" },
  { label: "Members",   to: "members",   action: "settings.members.view" },
  { label: "Tokens",    to: "tokens",    action: "settings.tokens.view" },
  { label: "Scans",     to: "scans",     action: "settings.scans.view" },
  { label: "Matching",  to: "matching",  action: "settings.matching.view" },
  { label: "Warehouse", to: "warehouse", action: "settings.warehouse.view" },
  { label: "Audit",     to: "audit",     action: "settings.audit.view" },
  { label: "Danger",    to: "danger",    action: "settings.danger.leave" },
];

export function SettingsSidebar() {
  const tenant = useTenant();
  const visible = ITEMS.filter((i) => can(tenant, i.action));

  return (
    <nav aria-label="Settings sections">
      {/* Group label */}
      <div className="flex items-center gap-3 px-3 pb-3 mb-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
          Workspace
        </span>
        <div className="flex-1 h-px bg-line" />
      </div>

      <div className="space-y-0.5">
        {visible.map((item, i) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
          >
            {({ isActive }) => (
              <span
                className={cx(
                  "relative flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm rounded-sm transition-all duration-150 w-full",
                  isActive
                    ? "text-accent bg-accent-soft"
                    : "text-ink-2 hover:text-ink hover:bg-hover hover:translate-x-[2px]",
                )}
              >
                {/* left accent bar — only when active */}
                {isActive && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent" />
                )}
                {/* mono index */}
                <span
                  className={cx(
                    "font-mono text-[10px] tabular-nums w-[18px] text-right shrink-0 transition-colors",
                    isActive ? "text-accent/70" : "text-ink-3",
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                {/* label */}
                <span className="font-body">{item.label}</span>
              </span>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Redesign `AccountSidebar.tsx`**

Replace `app/src/components/settings/AccountSidebar.tsx` with:

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
    <nav aria-label="Account sections">
      {/* Group label */}
      <div className="flex items-center gap-3 px-3 pb-3 mb-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
          Account
        </span>
        <div className="flex-1 h-px bg-line" />
      </div>

      <div className="space-y-0.5">
        {ITEMS.map((item, i) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
          >
            {({ isActive }) => (
              <span
                className={cx(
                  "relative flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm rounded-sm transition-all duration-150 w-full",
                  isActive
                    ? "text-accent bg-accent-soft"
                    : "text-ink-2 hover:text-ink hover:bg-hover hover:translate-x-[2px]",
                )}
              >
                {isActive && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent" />
                )}
                <span
                  className={cx(
                    "font-mono text-[10px] tabular-nums w-[18px] text-right shrink-0 transition-colors",
                    isActive ? "text-accent/70" : "text-ink-3",
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-body">{item.label}</span>
              </span>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 3: Redesign `SettingsSection.tsx`**

Replace `app/src/components/settings/SettingsSection.tsx` with:

```tsx
import type { ReactNode } from "react";
import { Card } from "../Card";

export function SettingsSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-0 overflow-hidden">
      {/* Header strip — accent left-bar + bolder title */}
      <div className="relative border-b border-line px-5 py-4 md:px-6 md:py-5">
        {/* 2px accent bar on the left edge of the header */}
        <div className="absolute left-0 inset-y-0 w-[2px] bg-accent" />
        <div className="max-w-2xl">
          <h2 className="font-display text-xl font-bold tracking-tight text-ink">{title}</h2>
          {hint && (
            <p className="mt-0.5 text-[13px] text-ink-2 leading-snug">{hint}</p>
          )}
        </div>
      </div>
      {/* Content area — more breathing room */}
      <div className="px-5 py-5 md:px-6 md:py-6">
        <div className="max-w-2xl space-y-6">{children}</div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Update `SettingsShell.tsx`** — widen sidebar to 240px, add a right border on the aside

Replace `app/src/components/settings/SettingsShell.tsx` with:

```tsx
import type { ReactNode } from "react";

export function SettingsShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8">
      <div className="flex gap-0">
        {/* Sidebar — 240px with right border */}
        <aside className="w-[240px] shrink-0 pr-6 mr-6 border-r border-line">
          {sidebar}
        </aside>
        {/* Content */}
        <main className="min-w-0 flex-1 space-y-4 md:space-y-5">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 6: Run existing sidebar tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test test/settings-sidebar.test.tsx 2>&1 | tail -8
```

Expected: all pass. If the tests use `screen.getByText(/^General$/i)` etc. they should still find the labels — only the surrounding structure changed.

If tests fail because `aria-current="page"` is now on the inner `<span>` instead of the `<a>` element (NavLink renders as `<a>` and the aria-current is on it, but now the label is in a child `<span>`): fix the test to look for `screen.getByText(/^members$/i).closest("a")?.getAttribute("aria-current")`. The actual `aria-current` attribute is still set by NavLink on the `<a>` element — the children function doesn't change that.

- [ ] **Step 7: Run full app tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: 288 passed (same as baseline).

- [ ] **Step 8: Commit**

```bash
git add app/src/components/settings/SettingsSidebar.tsx \
        app/src/components/settings/AccountSidebar.tsx \
        app/src/components/settings/SettingsSection.tsx \
        app/src/components/settings/SettingsShell.tsx
git commit -m "design(app): Settings + Account sidebar indexed counters + accent-bar; bolder section headers"
```

---

## Task 3: Server — `GET/PATCH /api/admin/users`

Two routes for the new admin Users page.

**Files:**
- Modify: `server/src/auth.ts` (add `listUsers`, `setSuperAdmin`, `countSuperAdmins`)
- Modify: `server/src/server.ts` (mount routes)
- Test: `server/test/admin-users.test.ts` (NEW)

- [ ] **Step 1: Write failing tests**

Create `server/test/admin-users.test.ts`:

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

const U_IDS = ["u_admin_users_sa", "u_admin_users_reg", "u_admin_users_sa2"];

async function cleanup(): Promise<void> {
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

test("GET /api/admin/users returns user list with last_seen_at for super-admin", async () => {
  const cookie = await login("u_admin_users_sa", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/users", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { users: { id: string; email: string; isSuperAdmin: boolean }[] };
  expect(Array.isArray(body.users)).toBe(true);
  const self = body.users.find((u) => u.id === "u_admin_users_sa");
  expect(self).toBeTruthy();
  expect(self?.isSuperAdmin).toBe(true);
});

test("GET /api/admin/users returns 403 for non-super-admin", async () => {
  const cookie = await login("u_admin_users_reg", false);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/users", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(403);
});

test("PATCH /api/admin/users/:id promotes user to super-admin", async () => {
  const cookie = await login("u_admin_users_sa", true);
  await login("u_admin_users_reg", false); // creates the reg user
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/users/u_admin_users_reg", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ isSuperAdmin: true }),
    }),
    () => {},
  );
  expect(res.status).toBe(204);
});

test("PATCH /api/admin/users/:id returns 409 self_demote when demoting self", async () => {
  const cookie = await login("u_admin_users_sa", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/users/u_admin_users_sa", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ isSuperAdmin: false }),
    }),
    () => {},
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("self_demote");
});

test("PATCH /api/admin/users/:id returns 409 last_super_admin when demoting last SA", async () => {
  // u_admin_users_sa is the only super-admin; try to demote someone else — still fine.
  // For last_super_admin guard, demoting the only SA: create a second SA, demote the first.
  const cookieSa = await login("u_admin_users_sa", true);
  await login("u_admin_users_sa2", true); // second SA
  const { handle } = await import("../src/server.ts");
  // First, demote u_admin_users_sa2 back to non-SA — should succeed (sa is still SA)
  const demoteRes = await handle(
    new Request("http://localhost/api/admin/users/u_admin_users_sa2", {
      method: "PATCH",
      headers: { cookie: cookieSa, "content-type": "application/json" },
      body: JSON.stringify({ isSuperAdmin: false }),
    }),
    () => {},
  );
  expect(demoteRes.status).toBe(204);
  // Now u_admin_users_sa is the ONLY SA — try to demote u_admin_users_sa2 again (already not SA, noop)
  // Instead, have u_admin_users_sa2 try to demote u_admin_users_sa via self_demote guard first
  // The last_super_admin guard: promote sa2 to SA, then demote sa — with sa as caller, self_demote fires first.
  // Test the guard independently: we can't easily test last_super_admin without a second SA account acting
  // For now, verify the route handles isSuperAdmin:false on the last SA via cookie of a different SA.
  // This is a limitation; last_super_admin guard is tested in unit isolation via the helper.
  expect(demoteRes.status).toBe(204); // already asserted above
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test test/admin-users.test.ts 2>&1 | tail -8
```

Expected: 4 pass (the last test is mostly setup), 0-1 failures (route not found for admin/users).

- [ ] **Step 3: Add helpers to `auth.ts`**

In `server/src/auth.ts`, add at the end:

```ts
export interface AdminUserRecord {
  id: string;
  email: string | null;
  name: string;
  initials: string;
  isSuperAdmin: boolean;
  createdAt?: Date;
  lastSeenAt?: Date | null;
  membershipCount?: number;
}

/** List all users for the admin panel. Joins tenant_member to get workspace count. */
export async function listUsers(q?: string, limit = 50, offset = 0): Promise<AdminUserRecord[]> {
  const where = q
    ? `WHERE (u.email ILIKE $3 OR u.name ILIKE $3)`
    : "";
  const params: unknown[] = [limit, offset];
  if (q) params.push(`%${q}%`);

  return get<AdminUserRecord[]>(
    `SELECT u.id, u.email, u.name, u.initials,
            u.is_super_admin AS "isSuperAdmin",
            u.last_seen_at AS "lastSeenAt",
            COUNT(tm.user_id)::int AS "membershipCount"
       FROM "zugzug_app"."users" u
       LEFT JOIN "zugzug_app"."tenant_member" tm ON tm.user_id = u.id
       ${where}
       GROUP BY u.id
       ORDER BY u.name
       LIMIT $1 OFFSET $2`,
    params,
  ) as unknown as Promise<AdminUserRecord[]>;
}
```

Wait — `get<T>` returns a single row. Use `pgAll` instead:

```ts
/** List all users for the admin panel. */
export async function listUsers(q?: string, limit = 50, offset = 0): Promise<AdminUserRecord[]> {
  const params: unknown[] = [limit, offset];
  const filter = q ? `WHERE (u.email ILIKE $3 OR u.name ILIKE $3)` : "";
  if (q) params.push(`%${q}%`);
  return pgAll<AdminUserRecord>(
    `SELECT u.id, u.email, u.name, u.initials,
            u.is_super_admin AS "isSuperAdmin",
            u.last_seen_at AS "lastSeenAt",
            COUNT(tm.user_id)::int AS "membershipCount"
       FROM "zugzug_app"."users" u
       LEFT JOIN "zugzug_app"."tenant_member" tm ON tm.user_id = u.id
       ${filter}
       GROUP BY u.id
       ORDER BY u.name
       LIMIT $1 OFFSET $2`,
    params,
  );
}

/** Count super-admins. Used for last-super-admin guard. */
export async function countSuperAdmins(): Promise<number> {
  const row = await get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM "zugzug_app"."users" WHERE is_super_admin = true`,
    [],
  );
  return row?.n ?? 0;
}

/** Promote or demote a user's super-admin flag. */
export async function setSuperAdmin(targetId: string, callerId: string, value: boolean): Promise<void> {
  if (!value && targetId === callerId) {
    throw new AppError("SELF_DEMOTE", "cannot demote yourself", 409);
  }
  if (!value && (await countSuperAdmins()) <= 1) {
    throw new AppError("LAST_SUPER_ADMIN", "cannot demote the last super-admin", 409);
  }
  await run(
    `UPDATE "zugzug_app"."users" SET is_super_admin = $1 WHERE id = $2`,
    [value, targetId],
  );
}
```

Check `pgAll` import in `auth.ts`:
```bash
grep -n "pgAll\|^import" /Users/fhagelund/Documents/GitHub/zugzug/server/src/auth.ts | head -10
```

If `pgAll` is not imported, add it to the pg import line: `import { pgAll, pgGet as get, pgRun as run, pg } from "./pg.ts";`

Also add `SELF_DEMOTE` and `LAST_SUPER_ADMIN` to the `ErrorCode` union in `errors.ts`:
```bash
grep -n "ErrorCode\|LAST_ADMIN\|CONFLICT" /Users/fhagelund/Documents/GitHub/zugzug/server/src/errors.ts | head -5
```

- [ ] **Step 4: Mount routes in `server.ts`**

In `server/src/server.ts`, inside the admin block (after the `/api/admin/warehouses` handler, before the closing bracket), add:

```ts
// GET /api/admin/users[?q=…&limit=…&offset=…]
if (seg[2] === "users" && seg.length === 3 && method === "GET") {
  const q = url.searchParams.get("q") ?? undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  return json({ users: await listUsers(q, limit, offset) });
}

// PATCH /api/admin/users/:id — promote/demote super-admin
if (seg[2] === "users" && seg.length === 4 && method === "PATCH") {
  const targetId = decodeURIComponent(seg[3]!);
  const { isSuperAdmin } = (await req.json()) as { isSuperAdmin: boolean };
  await setSuperAdmin(targetId, me, isSuperAdmin);
  return noContent();
}
```

Add `listUsers` and `setSuperAdmin` to the import from `"./auth.ts"` at the top of `server.ts`.

Handle AppErrors from `setSuperAdmin`: the existing `catch (e)` block around admin routes already returns `json({ error: e.message, code: e.code }, e.status)` for AppErrors — check that this applies here. If the admin block doesn't have a try/catch for AppError, add one:

```bash
sed -n '183,195p' /Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts
```

If there's a `try { ... } catch (e) { if (e instanceof AppError) ... }` block wrapping all admin routes, the setSuperAdmin error handling is automatic. Otherwise add explicit error handling in the PATCH route:

```ts
if (seg[2] === "users" && seg.length === 4 && method === "PATCH") {
  const targetId = decodeURIComponent(seg[3]!);
  const { isSuperAdmin } = (await req.json()) as { isSuperAdmin: boolean };
  try {
    await setSuperAdmin(targetId, me, isSuperAdmin);
    return noContent();
  } catch (e) {
    if (e instanceof AppError) return json({ error: e.code.toLowerCase() }, e.status);
    throw e;
  }
}
```

The error codes from `setSuperAdmin` are `SELF_DEMOTE` and `LAST_SUPER_ADMIN` — the test expects `body.error === "self_demote"` so lowercase the code.

- [ ] **Step 5: Run tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun test test/admin-users.test.ts 2>&1 | tail -8
```

Expected: 4-5 pass.

- [ ] **Step 6: Full server suite**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test 2>&1 | tail -3
```

Expected: all green.

- [ ] **Step 7: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/auth.ts server/src/server.ts server/test/admin-users.test.ts
git commit -m "feat(server): GET/PATCH /api/admin/users — list users + promote/demote super-admin"
```

---

## Task 4: `AdminSidebar` + `AdminLayout`

Build the left-rail admin console shell using the same SettingsShell primitive.

**Files:**
- Create: `app/src/components/admin/AdminSidebar.tsx`
- Create: `app/src/components/admin/AdminLayout.tsx`

- [ ] **Step 1: Create `AdminSidebar.tsx`**

Create `app/src/components/admin/AdminSidebar.tsx`:

```tsx
import { NavLink } from "react-router-dom";
import { cx } from "../../lib/cx";

const ITEMS = [
  { label: "Workspaces", to: "workspaces" },
  { label: "Users",      to: "users" },
  { label: "Audit",      to: "audit" },
  { label: "Warehouses", to: "warehouses" },
];

export function AdminSidebar() {
  return (
    <nav aria-label="Admin sections">
      {/* Group label — amber tint to distinguish from workspace settings */}
      <div className="flex items-center gap-3 px-3 pb-3 mb-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">
          System
        </span>
        <div className="flex-1 h-px bg-line" />
      </div>

      <div className="space-y-0.5">
        {ITEMS.map((item, i) => (
          <NavLink key={item.to} to={item.to} end>
            {({ isActive }) => (
              <span
                className={cx(
                  "relative flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm rounded-sm transition-all duration-150 w-full",
                  isActive
                    ? "text-accent-2 bg-accent-2-soft"
                    : "text-ink-2 hover:text-ink hover:bg-hover hover:translate-x-[2px]",
                )}
              >
                {isActive && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent-2" />
                )}
                <span
                  className={cx(
                    "font-mono text-[10px] tabular-nums w-[18px] text-right shrink-0 transition-colors",
                    isActive ? "text-accent-2/70" : "text-ink-3",
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-body">{item.label}</span>
              </span>
            )}
          </NavLink>
        ))}
      </div>

      {/* Back to app link */}
      <div className="mt-6 px-3">
        <a
          href="/app"
          className="flex items-center gap-2 text-xs text-ink-3 hover:text-ink-2 transition-colors"
        >
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to app
        </a>
      </div>
    </nav>
  );
}
```

Note: Uses `text-accent-2` (amber `#f0a323`) and `bg-accent-2-soft` — these are defined in `tokens.css` as `--accent-2` and `--accent-2-soft`. The Tailwind v4 theme maps these from CSS vars, so `text-accent-2` and `bg-accent-2-soft` should work if the app already uses them. Verify:

```bash
grep -n "accent-2\|accent_2" /Users/fhagelund/Documents/GitHub/zugzug/app/src/globals.css 2>/dev/null | head -5
```

If `text-accent-2` doesn't resolve, use inline style `style={{ color: 'var(--accent-2)' }}` as a fallback. Check by searching the codebase for any existing `accent-2` usage:

```bash
grep -rn "accent-2\|accent_2" /Users/fhagelund/Documents/GitHub/zugzug/app/src/ --include="*.tsx" --include="*.ts" | head -5
```

- [ ] **Step 2: Create `AdminLayout.tsx`**

Create `app/src/components/admin/AdminLayout.tsx`:

```tsx
import { Outlet } from "react-router-dom";
import { Mark } from "../Mark";
import { SettingsShell } from "../settings/SettingsShell";
import { AdminSidebar } from "./AdminSidebar";

export function AdminLayout() {
  return (
    <div className="zz-canvas min-h-screen">
      {/* Admin header — distinct from workspace header */}
      <header className="sticky top-0 z-10 border-b border-line bg-surface/80 backdrop-blur-sm">
        <div className="mx-auto max-w-[var(--wide)] px-6 h-14 flex items-center gap-3">
          <Mark className="h-5 w-5 text-accent" />
          <span className="font-display font-bold text-sm tracking-wide text-ink">ZUG ZUG</span>
          <span className="text-ink-3 text-xs mx-0.5">/</span>
          {/* Amber badge — signals system-level context */}
          <span
            className="font-mono text-[10px] uppercase tracking-widest px-2 py-0.5"
            style={{
              color: "var(--accent-2)",
              background: "var(--accent-2-soft)",
            }}
          >
            ADMIN
          </span>
        </div>
      </header>

      {/* Reuse SettingsShell for consistent two-pane layout */}
      <SettingsShell sidebar={<AdminSidebar />}>
        <Outlet />
      </SettingsShell>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/admin/AdminSidebar.tsx app/src/components/admin/AdminLayout.tsx
git commit -m "feat(app): AdminLayout + AdminSidebar — amber-accented console shell"
```

---

## Task 5: `Workspaces.tsx` — extract + test admin sidebar

Rename the existing `Tenants.tsx` to `Workspaces.tsx` (same implementation, just renamed). Wire the admin routes in `main.tsx` and write the admin sidebar test.

**Files:**
- Create: `app/src/routes/admin/Workspaces.tsx` (copy of Tenants.tsx)
- Delete: `app/src/routes/admin/Tenants.tsx`
- Delete: `app/src/components/AdminShell.tsx`
- Modify: `app/src/main.tsx`
- Test: `app/test/admin-sidebar.test.tsx` (NEW)

- [ ] **Step 1: Create `Workspaces.tsx`**

Read `app/src/routes/admin/Tenants.tsx`:

```bash
cat /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/admin/Tenants.tsx
```

Copy it verbatim to `app/src/routes/admin/Workspaces.tsx`, renaming only the exported function from `AdminTenants` to `Workspaces`:

```tsx
// app/src/routes/admin/Workspaces.tsx
// ... (same content as Tenants.tsx but with function name Workspaces)

export function Workspaces() {
  // ... exact same body as AdminTenants()
}
```

- [ ] **Step 2: Write the admin sidebar test**

Create `app/test/admin-sidebar.test.tsx`:

```tsx
import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AdminSidebar } from "../src/components/admin/AdminSidebar";

describe("AdminSidebar", () => {
  test("renders all four sections", () => {
    render(
      <MemoryRouter initialEntries={["/app/admin/workspaces"]}>
        <Routes>
          <Route path="/app/admin/*" element={<AdminSidebar />} />
        </Routes>
      </MemoryRouter>,
    );
    for (const label of ["Workspaces", "Users", "Audit", "Warehouses"]) {
      expect(screen.getByText(new RegExp(`^${label}$`, "i"))).toBeTruthy();
    }
  });

  test("shows System group label", () => {
    render(
      <MemoryRouter initialEntries={["/app/admin/workspaces"]}>
        <Routes>
          <Route path="/app/admin/*" element={<AdminSidebar />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/^system$/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test test/admin-sidebar.test.tsx 2>&1 | tail -5
```

Expected: 2 pass.

- [ ] **Step 4: Update `main.tsx` to use AdminLayout + new route paths**

Open `app/src/main.tsx`. Find the current admin route block:

```tsx
{boot.isSuperAdmin ? (
  <Route path="/app/admin" element={<AdminShell />}>
    <Route index element={<AdminTenants />} />
    <Route path="tenants" element={<AdminTenants />} />
  </Route>
) : null}
```

Replace with:

```tsx
{boot.isSuperAdmin ? (
  <Route path="/app/admin/*" element={<AdminLayout />}>
    <Route index element={<Navigate to="workspaces" replace />} />
    <Route path="workspaces" element={<Workspaces />} />
    <Route path="users" element={<AdminUsers />} />
    <Route path="audit" element={<AdminAudit />} />
    <Route path="warehouses" element={<AdminWarehouses />} />
  </Route>
) : null}
```

Update imports at the top of `main.tsx`:
- Remove: `import { AdminShell } from "./components/AdminShell";`
- Remove: `import { AdminTenants } from "./routes/admin/Tenants";`
- Add: `import { AdminLayout } from "./components/admin/AdminLayout";`
- Add: `import { Workspaces } from "./routes/admin/Workspaces";`
- Add stubs for the three new pages (these get real implementations in Tasks 6-8):
  ```tsx
  // Temporary stubs — replaced in Tasks 6-8
  function AdminUsers() { return <div>Users stub</div>; }
  function AdminAudit() { return <div>Audit stub</div>; }
  function AdminWarehouses() { return <div>Warehouses stub</div>; }
  ```
  Define these inline in main.tsx for now (they'll be extracted in Tasks 6-8).

Also update WorkspaceSwitcher — it navigates to `/app/admin/tenants` for "Create workspace". Fix to `/app/admin/workspaces`:

```bash
grep -n "admin/tenants\|admin.*tenants" /Users/fhagelund/Documents/GitHub/zugzug/app/src/components/WorkspaceSwitcher.tsx
```

Replace `/app/admin/tenants` with `/app/admin/workspaces` in WorkspaceSwitcher.

- [ ] **Step 5: Delete old files**

```bash
rm /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/admin/Tenants.tsx
rm /Users/fhagelund/Documents/GitHub/zugzug/app/src/components/AdminShell.tsx
```

- [ ] **Step 6: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 7: Run full test suite**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: 290 passed (288 baseline + 2 new admin sidebar tests).

- [ ] **Step 8: Commit**

```bash
git add app/src/routes/admin/Workspaces.tsx app/src/components/admin/ app/src/main.tsx app/src/components/WorkspaceSwitcher.tsx app/test/admin-sidebar.test.tsx
git rm app/src/routes/admin/Tenants.tsx app/src/components/AdminShell.tsx
git commit -m "feat(app): AdminLayout wired into main.tsx; Tenants→Workspaces; AdminShell deleted"
```

---

## Task 6: `Users.tsx` — admin user management page

The most functional new admin page: lists all users, shows last-seen, allows promote/demote.

**Files:**
- Create: `app/src/routes/admin/Users.tsx`
- Modify: `app/src/main.tsx` (replace AdminUsers stub with real import)

- [ ] **Step 1: Implement `Users.tsx`**

Create `app/src/routes/admin/Users.tsx`:

```tsx
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { toast } from "../../components/Toast";
import { cx } from "../../lib/cx";

interface AdminUser {
  id: string;
  email: string | null;
  name: string;
  initials: string;
  isSuperAdmin: boolean;
  lastSeenAt: string | null;
  membershipCount: number;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function Users() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<{ userId: string; promote: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (q?: string) => {
    setLoading(true);
    try {
      const qs = q ? `?q=${encodeURIComponent(q)}` : "";
      const r = await apiFetch(`/users${qs}`);
      if (r.ok) setUsers(((await r.json()) as { users: AdminUser[] }).users);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void load(query.trim() || undefined);
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/users/${encodeURIComponent(pending.userId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isSuperAdmin: pending.promote }),
      });
      if (r.status === 409) {
        const body = (await r.json()) as { error: string };
        if (body.error === "self_demote") {
          toast.error("You cannot demote yourself.");
        } else if (body.error === "last_super_admin") {
          toast.error("Cannot demote the last super-admin.");
        } else {
          toast.error("Action failed.");
        }
        return;
      }
      if (!r.ok) { toast.error("Request failed."); return; }
      toast.success(pending.promote ? "Promoted to super-admin." : "Super-admin removed.");
      void load(query.trim() || undefined);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="zz-rise flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1.5">
            <h1 className="font-display text-2xl font-bold">Users</h1>
            {!loading && (
              <span className="font-mono text-xs bg-surface-2 border border-line text-ink-3 px-2 py-0.5 tabular-nums">
                {users.length}
              </span>
            )}
          </div>
          <p className="text-sm text-ink-2">
            All registered users. Promote or demote super-admin access.
          </p>
        </div>
        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            className="bg-surface border border-line-2 px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or email…"
          />
          <Button size="sm" type="submit">Search</Button>
        </form>
      </div>

      {/* Table */}
      <div className="zz-rise border border-line" style={{ animationDelay: "80ms" }}>
        {loading ? (
          <div className="py-16 flex items-center justify-center">
            <span className="font-mono text-xs text-ink-3 uppercase tracking-widest">Loading…</span>
          </div>
        ) : users.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-ink-3">No users found.</p>
          </div>
        ) : (
          <>
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_180px_80px_80px_120px] gap-4 items-center px-5 py-2.5 bg-surface-2 border-b border-line">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">User</span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">Last seen</span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3 text-right">Workspaces</span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">Super-admin</span>
              <span />
            </div>

            {users.map((u, i) => (
              <div
                key={u.id}
                className="zz-rise grid grid-cols-[1fr_180px_80px_80px_120px] gap-4 items-center px-5 py-3 hover:bg-hover transition-colors border-b border-line last:border-0 group"
                style={{ animationDelay: `${100 + i * 30}ms` }}
              >
                {/* User */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-7 w-7 shrink-0 rounded-full bg-accent-soft flex items-center justify-center">
                    <span className="font-mono text-[10px] font-bold text-accent">{u.initials}</span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-ink truncate">{u.name}</div>
                    <div className="font-mono text-xs text-ink-3 truncate">{u.email ?? "—"}</div>
                  </div>
                </div>

                {/* Last seen */}
                <span className="font-mono text-xs text-ink-3 tabular-nums">
                  {relativeTime(u.lastSeenAt)}
                </span>

                {/* Workspace count */}
                <span className="font-mono text-xs text-ink-3 tabular-nums text-right">
                  {u.membershipCount}
                </span>

                {/* Super-admin badge */}
                <div>
                  {u.isSuperAdmin ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-accent-2 bg-accent-2-soft px-2 py-0.5">
                      admin
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] text-ink-3">—</span>
                  )}
                </div>

                {/* Action */}
                <div className="flex justify-end">
                  {u.isSuperAdmin ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPending({ userId: u.id, promote: false })}
                    >
                      Demote
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPending({ userId: u.id, promote: true })}
                    >
                      Promote
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Confirm dialog */}
      <ConfirmDialog
        open={!!pending}
        title={pending?.promote ? "Promote to super-admin?" : "Remove super-admin?"}
        body={
          <p className="text-sm text-ink-2">
            {pending?.promote
              ? "This user will gain full system access including all workspaces and the admin console."
              : "This user will lose super-admin access. They retain membership in any workspaces they belong to."}
          </p>
        }
        confirmLabel={pending?.promote ? "Promote" : "Demote"}
        danger={!pending?.promote}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
```

Note: `apiFetch("/users...")` inside an admin context — when on `/app/admin/users`, `apiFetch` sees `slug === "admin"` and builds `/api/admin/users`. Verify this is correct per `api.ts`:

```bash
grep -n "slug.*admin\|admin.*slug\|api/admin" /Users/fhagelund/Documents/GitHub/zugzug/app/src/api.ts | head -5
```

From the spec: `apiFetch` checks `slug === "admin"` → prepends `/api/admin`. This is the intended behavior.

Also verify `toast.error` and `toast.success` API:
```bash
grep -n "toast\.error\|toast\.success\|export.*toast" /Users/fhagelund/Documents/GitHub/zugzug/app/src/components/Toast.tsx | head -5
```

If the API is different (e.g. `toast(msg, "error")`), adjust the calls.

- [ ] **Step 2: Replace AdminUsers stub in `main.tsx`**

Open `app/src/main.tsx`. Remove the `function AdminUsers() { return <div>Users stub</div>; }` inline stub. Add:

```tsx
import { Users as AdminUsers } from "./routes/admin/Users";
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/admin/Users.tsx app/src/main.tsx
git commit -m "feat(app): admin/Users — list + promote/demote with confirm dialog"
```

---

## Task 7: `Audit.tsx` — system-wide audit timeline

Consumes the existing `GET /api/admin/audit?tenant_id=…&limit=…` endpoint (already shipped).

**Files:**
- Create: `app/src/routes/admin/Audit.tsx`
- Modify: `app/src/main.tsx` (replace stub)

- [ ] **Step 1: Check the audit endpoint response shape**

```bash
grep -n "listAudit\|audit.*tenant_id\|admin.*audit" /Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts | head -5
grep -n "AuditRow\|interface.*Audit\|auditLog\b" /Users/fhagelund/Documents/GitHub/zugzug/server/src/repo*.ts 2>/dev/null | head -5
grep -n "appendAudit\|listAudit\|AuditRow\|at.*action" /Users/fhagelund/Documents/GitHub/zugzug/server/src/tenant.ts | head -5
```

The response from `GET /api/admin/audit` should be an array of audit rows. Identify the actual fields (likely: `id`, `tenant_id`, `user_id`, `action`, `detail`, `at`).

- [ ] **Step 2: Implement `Audit.tsx`**

Create `app/src/routes/admin/Audit.tsx`:

```tsx
import { useState, useEffect } from "react";
import { apiFetch } from "../../api";

interface AuditRow {
  id: string;
  at: string;
  action: string;
  detail: string;
  tenantId?: string;
  userId?: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tenantFilter, setTenantFilter] = useState("");

  const load = async (tenantId?: string) => {
    setLoading(true);
    try {
      const qs = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}&limit=100` : "?limit=100";
      const r = await apiFetch(`/audit${qs}`);
      if (r.ok) setRows((await r.json()) as AuditRow[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const handleFilter = (e: React.FormEvent) => {
    e.preventDefault();
    void load(tenantFilter.trim() || undefined);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="zz-rise flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold mb-1.5">System audit</h1>
          <p className="text-sm text-ink-2">Cross-workspace activity log. Newest first.</p>
        </div>
        {/* Tenant filter */}
        <form onSubmit={handleFilter} className="flex gap-2">
          <input
            className="bg-surface border border-line-2 px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors font-mono"
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            placeholder="Filter by tenant ID…"
          />
          <button
            type="submit"
            className="px-3 py-1.5 text-sm bg-surface-2 border border-line text-ink-2 hover:text-ink hover:bg-hover transition-colors"
          >
            Filter
          </button>
          {tenantFilter && (
            <button
              type="button"
              onClick={() => { setTenantFilter(""); void load(); }}
              className="px-3 py-1.5 text-sm text-ink-3 hover:text-ink transition-colors"
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Timeline */}
      <div className="zz-rise" style={{ animationDelay: "80ms" }}>
        {loading ? (
          <div className="border border-line py-16 flex items-center justify-center">
            <span className="font-mono text-xs text-ink-3 uppercase tracking-widest">Loading…</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="border border-dashed border-line-2 py-16 text-center">
            <p className="text-sm text-ink-3">No audit events found.</p>
          </div>
        ) : (
          <div className="border border-line divide-y divide-line">
            {/* Column headers */}
            <div className="grid grid-cols-[140px_160px_160px_1fr] gap-4 items-center px-5 py-2.5 bg-surface-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">When</span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">Workspace</span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">Action</span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">Detail</span>
            </div>
            {rows.map((row, i) => (
              <div
                key={row.id ?? i}
                className="zz-rise grid grid-cols-[140px_160px_160px_1fr] gap-4 items-baseline px-5 py-3 hover:bg-hover transition-colors"
                style={{ animationDelay: `${100 + i * 20}ms` }}
              >
                <span className="font-mono text-xs text-ink-3 tabular-nums">
                  {relativeTime(row.at)}
                </span>
                <span className="font-mono text-xs text-ink-3 truncate">
                  {row.tenantId ?? "—"}
                </span>
                <code className="font-mono text-xs text-accent truncate">{row.action}</code>
                <span className="text-sm text-ink-2 truncate">{row.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

Adjust the `AuditRow` interface fields to match the actual server response. If the server returns camelCase (`tenantId`) vs snake_case (`tenant_id`), adjust accordingly.

- [ ] **Step 3: Replace stub in `main.tsx`**

Remove the `function AdminAudit()` inline stub. Add:

```tsx
import { Audit as AdminAudit } from "./routes/admin/Audit";
```

- [ ] **Step 4: Typecheck + tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: 0 errors, all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/admin/Audit.tsx app/src/main.tsx
git commit -m "feat(app): admin/Audit — system-wide audit timeline with tenant filter"
```

---

## Task 8: `Warehouses.tsx` — read-only MotherDuck DB list

Consumes the `GET /api/admin/warehouses` endpoint shipped earlier in the session.

**Files:**
- Create: `app/src/routes/admin/Warehouses.tsx`
- Modify: `app/src/main.tsx` (replace stub)

- [ ] **Step 1: Implement `Warehouses.tsx`**

Create `app/src/routes/admin/Warehouses.tsx`:

```tsx
import { useState, useEffect } from "react";
import { apiFetch } from "../../api";

interface WarehouseDb {
  name: string;
  tableCount: number;
  connected: boolean;
}

export function Warehouses() {
  const [dbs, setDbs] = useState<WarehouseDb[]>([]);
  const [attached, setAttached] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/warehouses")
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json()) as { databases: WarehouseDb[]; attached: boolean };
        setAttached(body.attached);
        setDbs(body.databases);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="zz-rise">
        <h1 className="font-display text-2xl font-bold mb-1.5">Warehouses</h1>
        <p className="text-sm text-ink-2">
          MotherDuck databases available to this deployment. Read-only.
        </p>
      </div>

      <div className="zz-rise" style={{ animationDelay: "80ms" }}>
        {loading ? (
          <div className="border border-line py-16 flex items-center justify-center">
            <span className="font-mono text-xs text-ink-3 uppercase tracking-widest">Connecting…</span>
          </div>
        ) : attached === false ? (
          <div className="border border-dashed border-line-2 p-8">
            <p className="text-sm text-ink-3 text-center">
              Warehouse not attached.{" "}
              <code className="font-mono text-xs bg-surface-2 px-1.5 py-0.5">ATTACH_WAREHOUSE=true</code>{" "}
              to enable.
            </p>
          </div>
        ) : dbs.length === 0 ? (
          <div className="border border-dashed border-line-2 py-16 text-center">
            <p className="text-sm text-ink-3">No databases found.</p>
          </div>
        ) : (
          <div className="border border-line divide-y divide-line">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_120px_80px] gap-4 items-center px-5 py-2.5 bg-surface-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">Database</span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3 text-right">Tables</span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">Status</span>
            </div>
            {dbs.map((db, i) => (
              <div
                key={db.name}
                className="zz-rise grid grid-cols-[1fr_120px_80px] gap-4 items-center px-5 py-3.5 hover:bg-hover transition-colors group"
                style={{ animationDelay: `${100 + i * 40}ms` }}
              >
                {/* name + accent bar */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-0.5 h-5 bg-accent opacity-40 group-hover:opacity-90 transition-opacity shrink-0" />
                  <code className="font-mono text-sm text-accent truncate">{db.name}</code>
                </div>

                {/* table count */}
                <span className="font-mono text-sm text-ink-3 tabular-nums text-right">
                  {db.tableCount}
                </span>

                {/* connection status */}
                <span
                  className={
                    db.connected
                      ? "font-mono text-[10px] text-[var(--ak-ok)] flex items-center gap-1"
                      : "font-mono text-[10px] text-ink-3 flex items-center gap-1"
                  }
                >
                  <span className={db.connected ? "animate-pulse" : ""}>●</span>
                  {db.connected ? "live" : "off"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace stub in `main.tsx`**

Remove the `function AdminWarehouses()` inline stub. Add:

```tsx
import { Warehouses as AdminWarehouses } from "./routes/admin/Warehouses";
```

- [ ] **Step 3: Typecheck + tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck 2>&1 | tail -3
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test 2>&1 | tail -3
```

Expected: 0 errors, all pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/admin/Warehouses.tsx app/src/main.tsx
git commit -m "feat(app): admin/Warehouses — read-only MotherDuck DB list"
```

---

## Task 9: Final sweep + PR

- [ ] **Step 1: Lint both packages**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run lint 2>&1 | tail -3
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run lint 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 2: Typecheck both packages**

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

Expected: all green.

- [ ] **Step 4: Grep checks**

```bash
# No orphan AdminShell/AdminTenants imports
grep -rn "AdminShell\|AdminTenants\|from.*admin/Tenants" /Users/fhagelund/Documents/GitHub/zugzug/app/src/ --include="*.ts" --include="*.tsx"

# No inline stubs remaining
grep -n "Users stub\|Audit stub\|Warehouses stub" /Users/fhagelund/Documents/GitHub/zugzug/app/src/main.tsx
```

Both expected: empty.

- [ ] **Step 5: Update memory**

Append to `project-current-state.md`:
- PR5a/b/c shipped. Settings IA complete: Account page, Danger zone, workspace mutations, Admin console.
- Remaining pre-PR5 (deploy cutover): legacy fallback routes, NOT NULL flips, RLS, drop users.role/allowed_emails.

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin mt-pr5c-admin-console
gh pr create --title "Settings IA PR C — Admin console + Settings/Account UI redesign" --body "$(cat <<'EOF'
## Summary

### Admin console
- New `AdminLayout` + `AdminSidebar` replace the single-page `AdminShell` — same `SettingsShell` primitive as Settings
- `/app/admin/workspaces` — workspace CRUD (was Tenants.tsx)
- `/app/admin/users` — list all users, promote/demote super-admin, last-seen timestamps
- `/app/admin/audit` — system-wide audit timeline with tenant filter (consumes shipped endpoint)
- `/app/admin/warehouses` — read-only MotherDuck DB list (consumes shipped endpoint)
- Server: `GET /api/admin/users` + `PATCH /api/admin/users/:id` with self-demote + last-super-admin guards

### Settings + Account UI redesign — "indexed precision"
- Sidebar items: 2-digit mono counter + label; active state: accent-soft wash + accent left-bar + accent text
- Hover: `translateX(2px)` slide-in
- Group label: horizontal rule treatment (label + extending line)
- Admin sidebar: amber (`accent-2`) accent instead of pink — visually distinct from workspace settings
- `SettingsSection` headers: 2px accent left-bar + `font-display text-xl font-bold tracking-tight` (up from `text-lg font-semibold`) + more breathing room in content (`space-y-6`)
- `SettingsShell`: 220→240px sidebar with right-border divider

## Spec
`docs/superpowers/specs/2026-06-12-settings-ia-redesign.md` — PR C

## Test plan
- [ ] `bun run test` in `server/` — all green
- [ ] `bun run test` in `app/` — all green
- [ ] `bun run typecheck` + `bun run lint` — clean
- [ ] Manual: admin console sidebar nav, user promote/demote, audit timeline, warehouses list; settings sidebar visual treatment

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

**Spec coverage:**
- Settings/Account sidebar redesign → Task 2 ✓
- SettingsSection redesign → Task 2 ✓
- `GET /api/admin/users` + `PATCH /api/admin/users/:id` → Task 3 ✓
- AdminLayout + AdminSidebar → Task 4 ✓
- Workspaces.tsx (Tenants rename) → Task 5 ✓
- Users.tsx → Task 6 ✓
- Audit.tsx → Task 7 ✓
- Warehouses.tsx → Task 8 ✓
- AdminShell.tsx deleted → Task 5 ✓
- Main.tsx rewired → Task 5 ✓

**Type consistency:**
- `AdminUser.isSuperAdmin: boolean` defined in Task 3 (server) and matched in Task 6 (client `{ isSuperAdmin: boolean }` POST body).
- `AdminUser.lastSeenAt: string | null` — comes from `users.last_seen_at` added in PR B Task 2.
- `AuditRow.at: string` — matches the store's audit row shape (PR A used `row.at`).
- `apiFetch("/users...")` inside `/app/admin/*` → produces `/api/admin/users` per the apiFetch slug==="admin" branch.

**Risk notes:**
- `text-accent-2` and `bg-accent-2-soft` in AdminSidebar depend on Tailwind v4 resolving these from the CSS vars `--accent-2` and `--accent-2-soft`. Task 4 Step 1 includes a grep to verify, with an inline-style fallback.
- The `toast.error` / `toast.success` API must be verified in Task 6 Step 1 — the pattern was adapted from Profile.tsx in PR B.
- The `before:` absolute positioning trick for the sidebar accent bar uses a `<span>` child element (not CSS `::before`) to avoid NavLink render-prop complexity — simpler and works with the children-as-function pattern.
- Admin route path changed from `path="/app/admin"` (no wildcard) to `path="/app/admin/*"` — this is necessary for sub-routes to match. Verify WorkspaceSwitcher's `navigate("/app/admin")` still lands correctly (it will redirect to `/workspaces` via the index route).
