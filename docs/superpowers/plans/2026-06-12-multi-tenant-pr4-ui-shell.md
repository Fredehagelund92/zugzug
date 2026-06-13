# Multi-tenant PR 4 — UI shell + client `apiFetch`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end multi-tenant UX. Move every protected route under `/app/:tenantSlug/*`, ship `<TenantLayout>` + `useTenant()` context + workspace switcher (Linear-style top-left dropdown), introduce the URL-derived `apiFetch` helper + ESLint backstop + migrate ~23 raw fetch sites, tenant-scope `localStorage` keys, tenant-namespace the presence WebSocket URL, rewrite Settings → Team against per-tenant invite endpoints, and ship the super-admin `/app/admin` shell for tenant CRUD.

**Architecture:** The URL is the source of truth for the active tenant. `apiFetch(path)` parses `/app/:slug/` from `window.location.pathname` and rewrites `/api/...` → `/api/t/:slug/...` (with `/api/admin/...` and `/api/auth/...` exemptions). Routes restructure from a flat `/app/*` to `/app/:tenantSlug/*`. `<TenantLayout>` (one route component above `<AppShell>`) validates the slug against memberships fetched at boot, publishes a `useTenant()` context, and on slug change calls `onTenantSwitch()` which (1) aborts the in-flight `AbortController`, (2) cancels debounced timers, (3) resets store state, (4) re-runs `initStore()`. Settings → Team pivots from the global `/api/team/*` endpoints to per-tenant `/api/t/:slug/team/*` endpoints backed by `tenant_invite` and `tenant_member`. Super-admin `/app/admin` is a separate shell (not a tenant) wired to existing `/api/admin/*` routes.

**Branch:** `mt-pr4-ui-shell` off `main`.

**Tech Stack:** React 18 + react-router-dom v6 + Vite, Bun + postgres.js server-side. No new runtime dependencies. Builds on PR2a's `/api/t/:slug/*` routing and `SessionUser.isSuperAdmin`, PR2b's `TenantRepo` + per-tenant team/audit/admin endpoints + tenant-namespaced WebSocket, and #103's Team section UI shell (which becomes the host for per-tenant invites).

**Spec:** `docs/superpowers/specs/2026-06-07-multi-tenant-design.md` — "Routes", "`apiFetch`", "ESLint rule", "Workspace switcher", "AbortController-based race fix", "Cancel-on-switch", "Hardcoded nav hrefs", "Tenant-scoped `localStorage`", "Redirect in BootGate", "WebSocket".

**Prereq:** PR2b (#102) merged. Confirm with `git log --oneline main | head -5 | grep -c "PR 2b"` returning 1.

**Scope notes:**

- This PR folds the original PR3 (client `apiFetch` + ESLint + fetch-site sweep) into PR4 — the new `/app/:slug/*` routes require tenant-scoped fetches, so shipping them together avoids a half-migrated state where routes are tenant-aware but URLs aren't.
- This PR does NOT drop the legacy `/api/team/*` / `/api/preferences` / `/api/audit` un-tenanted route fallbacks — those are kept alive on `default` until PR5 (cutover) deletes them.
- This PR does NOT enable RLS, drop columns, or remove `users.role` — all of that is PR5.
- The workspace switcher's "Create workspace" CTA is **super-admin only** per user preference (confirmed 2026-06-11). Regular users see only the membership list and "Sign out".
- Bare `/` and `/app` redirect to `/app/<lastUsedSlug>`. Users with zero memberships and not super-admin land on a "You're not in any workspace yet — ask an admin to invite you" page (NOT redirected to `/login`).

---

## File structure (post-PR)

```
app/src/api.ts                                  NEW — apiFetch + authFetch
app/src/lib/tenant-context.tsx                  NEW — TenantProvider + useTenant() hook
app/src/lib/use-tenant-navigate.ts              NEW — useTenantNavigate + useNavLinks
app/src/lib/tenant-storage.ts                   NEW — scoped localStorage helpers (palette recents, open-tabs)
app/src/components/TenantLayout.tsx             NEW — slug validation + AbortController lifecycle + <Outlet/>
app/src/components/WorkspaceSwitcher.tsx        NEW — top-left dropdown
app/src/components/NoWorkspaceLanding.tsx       NEW — "you're not in a workspace" page
app/src/components/AdminShell.tsx               NEW — super-admin /app/admin chrome
app/src/routes/admin/Tenants.tsx                NEW — tenant CRUD list
app/src/main.tsx                                MOD — route table: /app/:tenantSlug/* + /app/admin/* + /app redirect
app/src/components/BootGate.tsx                 MOD — fetch memberships; pick initial slug; render NoWorkspaceLanding when applicable
app/src/components/AppShell.tsx                 MOD — host WorkspaceSwitcher; consume useTenant(); consume useNavLinks; tenant-scope localStorage keys
app/src/lib/open-tabs.tsx                       MOD — storage key suffixed with :${slug}
app/src/lib/use-presence.ts (or hook callsite)  MOD — WS URL uses /ws/t/:slug/presence/:tableId
app/src/store.ts                                MOD — apiFetch instead of raw fetch; tenantSessionController + onTenantSwitch + resetStore + cancelDebouncedTimers; signal-aware refreshes
app/src/routes/Settings.tsx                     MOD — Team section calls /api/t/:slug/team/* (via apiFetch)
app/src/routes/Login.tsx                        MOD — fetch sites use authFetch
app/src/routes/Signup.tsx                       MOD — fetch sites use authFetch
app/src/routes/Triage.tsx                       MOD — hardcoded /app/* → useNavLinks
app/src/routes/Dashboard.tsx                    MOD — hardcoded /app/* → useNavLinks
app/src/routes/Sources.tsx                      MOD — hardcoded /app/* → useNavLinks
app/src/routes/Showcase.tsx                     MOD — hardcoded /app/* → useNavLinks (or strip if dev-only)
app/src/components/SidebarTableTree.tsx         MOD — navigate via useTenantNavigate
app/src/components/NoTablesYet.tsx              MOD — Link via useNavLinks
app/src/lib/use-ai-hint.ts                      MOD — apiFetch (already signal-aware)
app/src/lib/use-row-activity.ts                 MOD — apiFetch
app/.eslintrc.cjs (or eslint.config.js)         MOD — no-restricted-syntax: ban fetch("/api…"); ban new Request("/api…")
app/test/api.test.ts                            NEW — apiFetch URL derivation table-driven test
app/test/tenant-context.test.tsx                NEW — TenantLayout slug-mismatch redirect + useTenant() returns context
app/test/workspace-switcher.test.tsx            NEW — switcher renders memberships + super-admin CTA visibility
app/test/boot-gate-redirect.test.tsx            NEW — /app → /app/<lastSlug>; zero memberships → NoWorkspaceLanding
app/test/store-tenant-switch.test.ts            NEW — onTenantSwitch aborts in-flight + cancels debounced
server/src/server.ts                            MOD — GET /api/me/memberships; per-tenant team routes
server/src/tenant.ts                            MOD — listInvites(tenantId), createInvite, revokeInvite
server/test/me-memberships.test.ts              NEW — endpoint returns user's memberships + isSuperAdmin flag
server/test/tenant-team-routes.test.ts          NEW — per-tenant invite create/list/revoke + member role change
```

---

## Task 1: Branch kickoff + baseline

**Files:** none.

- [ ] **Step 1: Confirm PR2b merged**

```bash
git log --oneline main | head -10 | grep -c "PR 2b"
```
Expected: at least 1.

- [ ] **Step 2: Create branch**

```bash
git checkout main && git pull --ff-only origin main && git checkout -b mt-pr4-ui-shell
```

- [ ] **Step 3: Baseline test counts**

```bash
cd server && bun run test 2>&1 | tail -3
cd ../app && bun run typecheck 2>&1 | tail -3
```

Record numbers in PR description at the end.

---

## Task 2: Server — `GET /api/me/memberships` + super-admin flag in /auth/me

The client needs a single endpoint to learn (a) which tenants the current user belongs to, (b) whether they are super-admin, in order to drive the BootGate redirect and workspace switcher. `/api/auth/me` already returns the session user; we add memberships in a sibling route to keep the auth handler shape unchanged.

**Files:**
- Modify: `server/src/server.ts` (add route)
- Test: `server/test/me-memberships.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

```ts
// server/test/me-memberships.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { provisionTenant } from "../src/tenant.ts";
import { signedInAs, startTestServer, stopTestServer } from "./helpers/http.ts";

describe("GET /api/me/memberships", () => {
  beforeAll(startTestServer);
  afterAll(stopTestServer);

  test("returns memberships for the current user, with isSuperAdmin flag", async () => {
    const a = await provisionTenant({ slug: "acme", label: "Acme", warehouseId: "default" });
    const b = await provisionTenant({ slug: "globex", label: "Globex", warehouseId: "default" });
    const u = await signedInAs("alice@example.com", { superAdmin: false, memberOf: [a.id, b.id] });
    const res = await u.fetch("/api/me/memberships");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isSuperAdmin).toBe(false);
    expect(body.memberships.map((m: { slug: string }) => m.slug).sort()).toEqual(["acme", "globex"]);
    expect(body.memberships[0]).toMatchObject({ slug: expect.any(String), label: expect.any(String), role: expect.any(String) });
  });

  test("401 when not signed in", async () => {
    const res = await fetch("http://localhost:8787/api/me/memberships");
    expect(res.status).toBe(401);
  });
});
```

(If `signedInAs`/`startTestServer` helpers don't exist in this exact shape, adapt to whatever PR2a/PR2b's tests use — the spec-reviewer will catch this.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && bun test test/me-memberships.test.ts 2>&1 | tail -10
```
Expected: route not found / 404.

- [ ] **Step 3: Implement the route**

In `server/src/server.ts`, in the authenticated branch (after session resolution, before tenant-context resolution), add:

```ts
// GET /api/me/memberships — list workspaces this user can enter + super-admin flag.
if (pathname === "/api/me/memberships" && method === "GET") {
  const memberships = await listMembershipsForUser(sessionUser.id);
  return json({
    isSuperAdmin: sessionUser.isSuperAdmin,
    memberships: memberships.map((m) => ({
      slug: m.tenant.slug,
      label: m.tenant.label,
      role: m.role,
    })),
  });
}
```

Add `listMembershipsForUser` to the existing tenant.ts import line.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && bun test test/me-memberships.test.ts 2>&1 | tail -5
```
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/test/me-memberships.test.ts
git commit -m "feat(server): GET /api/me/memberships for BootGate + switcher"
```

---

## Task 3: Server — per-tenant team endpoints (invite + member CRUD)

PR2b shipped admin teardown/audit/impersonate but Settings → Team still talks to the global `/api/team/*` endpoints (backed by `allowed_emails` + `users.role`). PR4 needs per-tenant endpoints so inviting from inside workspace "acme" adds a row to `tenant_invite` (consumed at sign-in by PR2a's auto-accept) and `tenant_member`, not the global allowlist.

Endpoints (mounted under the `/api/t/:slug/*` prefix that PR2a already strips):

- `GET    /api/t/:slug/team/members` — list `tenant_member` rows joined to `users`.
- `GET    /api/t/:slug/team/invites` — list pending `tenant_invite` rows for this tenant.
- `POST   /api/t/:slug/team/invites` — body `{ email, role }`. Admin only. Inserts into `tenant_invite`.
- `DELETE /api/t/:slug/team/invites/:email` — admin only.
- `PUT    /api/t/:slug/team/members/:userId/role` — body `{ role }`. Admin only. Update `tenant_member.role`.
- `DELETE /api/t/:slug/team/members/:userId` — admin only. Cannot remove self if you'd leave the tenant with zero admins.

**Files:**
- Modify: `server/src/server.ts` (route handlers)
- Modify: `server/src/tenant.ts` (helpers: `listInvites`, `createInvite`, `revokeInvite`, `listMembers`, `setMemberRole`, `removeMember`)
- Test: `server/test/tenant-team-routes.test.ts` (NEW)

- [ ] **Step 1: Write the failing tests (one per endpoint)**

```ts
// server/test/tenant-team-routes.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { provisionTenant } from "../src/tenant.ts";
import { signedInAs, startTestServer, stopTestServer } from "./helpers/http.ts";

describe("tenant team routes", () => {
  beforeAll(startTestServer);
  afterAll(stopTestServer);

  test("admin can list, invite, list invites, revoke invite", async () => {
    const t = await provisionTenant({ slug: "acme", label: "Acme", warehouseId: "default" });
    const admin = await signedInAs("admin@example.com", { memberOf: [{ id: t.id, role: "admin" }] });
    expect((await admin.fetch("/api/t/acme/team/members")).status).toBe(200);

    let res = await admin.fetch("/api/t/acme/team/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "newbie@example.com", role: "editor" }),
    });
    expect(res.status).toBe(201);

    res = await admin.fetch("/api/t/acme/team/invites");
    const invites = await res.json();
    expect(invites.map((i: { email: string }) => i.email)).toContain("newbie@example.com");

    res = await admin.fetch("/api/t/acme/team/invites/newbie@example.com", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("editor gets 403 on invite/role mutations", async () => {
    const t = await provisionTenant({ slug: "globex", label: "Globex", warehouseId: "default" });
    const editor = await signedInAs("ed@example.com", { memberOf: [{ id: t.id, role: "editor" }] });
    const res = await editor.fetch("/api/t/globex/team/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.com", role: "editor" }),
    });
    expect(res.status).toBe(403);
  });

  test("cannot remove the last admin", async () => {
    const t = await provisionTenant({ slug: "lone", label: "Lone", warehouseId: "default" });
    const admin = await signedInAs("only@example.com", { memberOf: [{ id: t.id, role: "admin" }] });
    const me = (await (await admin.fetch("/api/auth/me")).json()) as { id: string };
    const res = await admin.fetch(`/api/t/lone/team/members/${me.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("last_admin");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server && bun test test/tenant-team-routes.test.ts 2>&1 | tail -15
```
Expected: 3 failures (routes don't exist).

- [ ] **Step 3: Add helpers to `tenant.ts`**

```ts
// server/src/tenant.ts (append)

export interface InviteRecord {
  email: string;
  role: "admin" | "editor" | "viewer";
  invited_at: Date;
}

export async function listInvitesForTenant(tenantId: string): Promise<InviteRecord[]> {
  return pgAll<InviteRecord>(
    `SELECT email, role, invited_at
       FROM "zugzug_app"."tenant_invite"
      WHERE tenant_id = $1
      ORDER BY invited_at DESC`,
    [tenantId],
  );
}

export async function createInvite(
  tenantId: string,
  email: string,
  role: "admin" | "editor" | "viewer",
): Promise<void> {
  await run(
    `INSERT INTO "zugzug_app"."tenant_invite" (tenant_id, email, role, invited_at)
     VALUES ($1, lower($2), $3, now())
     ON CONFLICT (tenant_id, email) DO UPDATE SET role = EXCLUDED.role`,
    [tenantId, email, role],
  );
}

export async function revokeInvite(tenantId: string, email: string): Promise<void> {
  await run(
    `DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1 AND lower(email) = lower($2)`,
    [tenantId, email],
  );
}

export interface MemberRecord {
  user_id: string;
  email: string;
  name: string | null;
  role: "admin" | "editor" | "viewer";
  joined_at: Date;
}

export async function listMembersForTenant(tenantId: string): Promise<MemberRecord[]> {
  return pgAll<MemberRecord>(
    `SELECT u.id AS user_id, u.email, u.name, tm.role, tm.created_at AS joined_at
       FROM "zugzug_app"."tenant_member" tm
       JOIN "zugzug_app"."users" u ON u.id = tm.user_id
      WHERE tm.tenant_id = $1
      ORDER BY u.email`,
    [tenantId],
  );
}

export async function setMemberRole(
  tenantId: string,
  userId: string,
  role: "admin" | "editor" | "viewer",
): Promise<void> {
  await run(
    `UPDATE "zugzug_app"."tenant_member" SET role = $3
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId, role],
  );
}

export async function countAdmins(tenantId: string): Promise<number> {
  const row = await pgGet<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM "zugzug_app"."tenant_member"
      WHERE tenant_id = $1 AND role = 'admin'`,
    [tenantId],
  );
  return row?.n ?? 0;
}

export async function removeMember(tenantId: string, userId: string): Promise<void> {
  await run(
    `DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
}
```

(`run`, `pgAll`, `pgGet` are already imported in this file.)

- [ ] **Step 4: Mount routes in `server.ts`**

Inside the existing `/api/t/:slug/*` handler block, after `tenantCtx` is resolved and `reqRepo` constructed, add:

```ts
// Team routes (per-tenant). Slug already validated by tenant-middleware.
if (seg[3] === "team") {
  // /api/t/:slug/team/members
  if (seg[4] === "members" && seg.length === 5 && method === "GET") {
    return json(await listMembersForTenant(tenantCtx.tenantId));
  }
  if (seg[4] === "members" && seg.length === 7 && seg[6] === "role" && method === "PUT") {
    if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
    const body = (await req.json()) as { role: "admin" | "editor" | "viewer" };
    const targetUserId = decodeURIComponent(seg[5]!);
    await setMemberRole(tenantCtx.tenantId, targetUserId, body.role);
    return new Response(null, { status: 204 });
  }
  if (seg[4] === "members" && seg.length === 6 && method === "DELETE") {
    if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
    const targetUserId = decodeURIComponent(seg[5]!);
    // Prevent leaving the tenant with zero admins.
    const targetRole = (await listMembersForTenant(tenantCtx.tenantId)).find((m) => m.user_id === targetUserId)?.role;
    if (targetRole === "admin" && (await countAdmins(tenantCtx.tenantId)) <= 1) {
      return json({ error: "last_admin" }, 409);
    }
    await removeMember(tenantCtx.tenantId, targetUserId);
    return new Response(null, { status: 204 });
  }
  // /api/t/:slug/team/invites
  if (seg[4] === "invites" && seg.length === 5 && method === "GET") {
    return json(await listInvitesForTenant(tenantCtx.tenantId));
  }
  if (seg[4] === "invites" && seg.length === 5 && method === "POST") {
    if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
    const body = (await req.json()) as { email: string; role: "admin" | "editor" | "viewer" };
    await createInvite(tenantCtx.tenantId, body.email, body.role);
    return json({ ok: true }, 201);
  }
  if (seg[4] === "invites" && seg.length === 6 && method === "DELETE") {
    if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
    await revokeInvite(tenantCtx.tenantId, decodeURIComponent(seg[5]!));
    return new Response(null, { status: 204 });
  }
}
```

Import the new helpers at the top of `server.ts`.

(Note: the exact `seg[]` indices depend on the path-strip done in tenant-middleware. PR2a leaves `seg` as the post-prefix-strip array — verify against the existing route patterns before pasting.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd server && bun test test/tenant-team-routes.test.ts 2>&1 | tail -10
```
Expected: 3 pass.

- [ ] **Step 6: Run the full server test suite**

```bash
cd server && bun run test 2>&1 | tail -5
```
Expected: all pass (PR2b baseline + Tasks 2-3 new tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/tenant.ts server/src/server.ts server/test/tenant-team-routes.test.ts
git commit -m "feat(server): per-tenant team endpoints (invite + member CRUD)"
```

---

## Task 4: Client — `apiFetch` + `authFetch` helpers

**Files:**
- Create: `app/src/api.ts`
- Test: `app/test/api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/test/api.test.ts
import { describe, expect, test, beforeEach, vi } from "vitest";
import { apiFetch, authFetch } from "../src/api";

function setPath(p: string) {
  // jsdom — adjust if bun:test is used; if so use Object.defineProperty.
  window.history.replaceState(null, "", p);
}

describe("apiFetch URL derivation", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
  });

  const cases: Array<[string, string, string]> = [
    ["/app/acme/tables", "/dimensions", "/api/t/acme/dimensions"],
    ["/app/globex/triage", "/audit?limit=30", "/api/t/globex/audit?limit=30"],
    ["/app/admin/tenants", "/tenants", "/api/admin/tenants"],
    ["/app/admin", "/audit", "/api/admin/audit"],
    ["/login", "/auth/me", "/api/auth/me"],
    ["/app/acme/tables", "/admin/audit", "/api/admin/audit"], // explicit /admin override
  ];

  for (const [path, input, expected] of cases) {
    test(`pathname=${path} apiFetch(${input}) → ${expected}`, async () => {
      setPath(path);
      await apiFetch(input);
      expect(globalThis.fetch).toHaveBeenCalledWith(expected, expect.objectContaining({ credentials: "include" }));
    });
  }
});

describe("authFetch", () => {
  test("always builds /api${path}", async () => {
    setPath("/app/acme/tables");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    await authFetch("/auth/logout", { method: "POST" });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST", credentials: "include" }));
  });
});
```

(If the app uses `bun:test`, port the imports accordingly. `vi.spyOn` becomes `spyOn` from `bun:test`.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun test test/api.test.ts 2>&1 | tail -5
```
Expected: module not found.

- [ ] **Step 3: Implement `api.ts`**

```ts
// app/src/api.ts

/**
 * Tenant-aware fetch wrapper. Derives the active tenant slug from
 * window.location.pathname (`/app/<slug>/...`) and rewrites paths:
 *   `/foo`         → `/api/t/<slug>/foo`         (regular)
 *   `/admin/foo`   → `/api/admin/foo`            (super-admin override)
 *   `/foo` (admin) → `/api/admin/foo`            (slug === "admin")
 *   `/foo` (none)  → `/api/foo`                  (pre-login: /login, /signup)
 *
 * No module state. The URL is the source of truth — switching tenants is a
 * react-router navigation, the next apiFetch picks up the new slug.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const m = /^\/app\/([^/]+)\//.exec(window.location.pathname + "/");
  const slug = m?.[1] ?? "";
  const url =
    path.startsWith("/admin/") ? `/api${path}` :
    slug === "admin"           ? `/api/admin${path}` :
    slug                       ? `/api/t/${slug}${path}` :
                                 `/api${path}`;
  return fetch(url, { credentials: "include", ...init });
}

/**
 * Pre-login fetch wrapper. Always `/api${path}`, never tenant-prefixed.
 * Use for `/auth/me`, `/auth/logout`, `/auth/dev`, `/auth/config`, `/auth/login`,
 * `/auth/signup`, and `/me/memberships` (called pre-tenant-resolve in BootGate).
 */
export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api${path}`, { credentials: "include", ...init });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd app && bun test test/api.test.ts 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/api.ts app/test/api.test.ts
git commit -m "feat(app): apiFetch + authFetch helpers"
```

---

## Task 5: Client — ESLint rule banning raw `/api` fetch

Backstop against future raw fetches. Run on existing code first to surface every call site that needs migrating.

**Files:**
- Modify: `app/eslint.config.js` (or `.eslintrc.cjs` — whichever exists)

- [ ] **Step 1: Locate the existing ESLint config**

```bash
ls app/eslint.config.* app/.eslintrc* 2>/dev/null
```

- [ ] **Step 2: Add the rule**

In the rules block of the existing config, append:

```js
"no-restricted-syntax": ["error",
  {
    selector: "CallExpression[callee.name='fetch'] > Literal[value=/^\\/api/]",
    message: "Use apiFetch() from src/api.ts — raw fetch bypasses tenant routing.",
  },
  {
    selector: "CallExpression[callee.name='fetch'] > TemplateLiteral[quasis.0.value.raw=/^\\/api/]",
    message: "Use apiFetch() from src/api.ts — raw fetch bypasses tenant routing.",
  },
  {
    selector: "NewExpression[callee.name='Request'] > Literal[value=/^\\/api/]",
    message: "Use apiFetch() from src/api.ts — raw Request() bypasses tenant routing.",
  },
],
"no-restricted-imports": ["error", { paths: ["axios", "ky"] }],
```

If the file uses the new flat config (`eslint.config.js`), add the same under the appropriate config object.

- [ ] **Step 3: Run lint to surface the call sites**

```bash
cd app && bun run lint 2>&1 | grep "no-restricted-syntax" | head -30
```
Expected: ~22 violations across `store.ts`, `BootGate.tsx`, `AppShell.tsx`, `Settings.tsx`, `Login.tsx`, `Signup.tsx`, `routes/Sources.tsx`, etc. (Triage's `/api/triage/ai-hint` will also appear.) Save this list — Tasks 6-7 work through it.

- [ ] **Step 4: Add a temporary allowlist for `api.ts` itself**

`api.ts` contains the only legal raw `fetch("/api…")` calls. Add an inline disable inside `api.ts`'s `fetch(...)` calls, or scope the rule with an ESLint override pinning `src/api.ts` to ignore `no-restricted-syntax`:

```js
{
  files: ["src/api.ts"],
  rules: { "no-restricted-syntax": "off" },
},
```

- [ ] **Step 5: Verify api.ts passes lint**

```bash
cd app && bun run lint src/api.ts 2>&1 | tail -3
```
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add app/eslint.config.js  # or whichever path
git commit -m "lint(app): ban raw fetch('/api…') outside api.ts"
```

(Lint will fail repo-wide until Tasks 6-7 finish the sweep. That's fine — the next commits land them.)

---

## Task 6: Client — migrate store.ts to apiFetch + introduce tenant session controller

`store.ts` owns the largest cluster of fetch sites (`apiInner`, `initStore`, `useAuthConfig`, `useWorkspaceInfo`, `listTeamMembers`, `updateUserRole`, `loadTokens`, `createToken`, `revokeToken`, `refreshConnectionHealth`). It also gets the **AbortController-based race fix** — central place because every refresher goes through `apiInner`.

**Files:**
- Modify: `app/src/store.ts`

- [ ] **Step 1: Add tenant session controller + reset hook**

Near the top of `store.ts`, alongside the other module-level state:

```ts
import { apiFetch, authFetch } from "./api";

// One AbortController per tenant session. Aborted by onTenantSwitch().
// Every long-lived/auto-refresh fetch should pass tenantSessionController.signal
// so mid-flight responses are dropped on switch.
let tenantSessionController = new AbortController();

/** Called by TenantLayout when the URL slug changes. */
export function onTenantSwitch(): void {
  tenantSessionController.abort();
  tenantSessionController = new AbortController();
  cancelDebouncedTimers();
  resetStore();
}

function resetStore(): void {
  dims = [];
  sources = [];
  draftsFlat = {};
  audit = [];
  preferences = { publishThreshold: 95, suggestThreshold: 80, scanSchedule: null };
  _authConfigCache = null;
  _authConfigPromise = null;
  _workspaceInfoCache = null;
  _workspaceInfoPromise = null;
  emit();
}

// Track every debounced timer that lives across requests. Cleared on switch.
const _debouncedTimers = new Set<ReturnType<typeof setTimeout>>();
export function trackDebouncedTimer(t: ReturnType<typeof setTimeout>): void {
  _debouncedTimers.add(t);
}
function cancelDebouncedTimers(): void {
  for (const t of _debouncedTimers) clearTimeout(t);
  _debouncedTimers.clear();
}
```

- [ ] **Step 2: Rewrite `apiInner` to use `apiFetch`**

Replace the existing implementation:

```ts
async function apiInner<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...opts,
    signal: opts?.signal ?? tenantSessionController.signal,
    headers: { "content-type": "application/json", ...opts?.headers },
  });
  // ... rest unchanged (409 conflict parsing, throw on !ok, JSON parse) ...
}
```

- [ ] **Step 3: Migrate the remaining raw fetches in store.ts**

Walk the list from Task 5 lint output. For each fetch in `store.ts`:

- `fetch("/api/auth/config")` → `authFetch("/auth/config")`
- `fetch("/api/workspace/info")` → `apiFetch("/workspace/info")` (workspace info is per-tenant)
- `fetch("/api/auth/me")` in `initStore` → `authFetch("/auth/me")`
- `fetch("/api/tables", ...)` → `apiFetch("/tables", ...)`
- `fetch("/api/tokens")`, `fetch("/api/tokens", ...)`, `fetch(\`/api/tokens/${id}\`, ...)` → `apiFetch("/tokens", ...)` / `apiFetch(\`/tokens/${id}\`, ...)`
- `fetch("/api/team/users")` → `apiFetch("/team/members")` (rename — see Task 11)
- `fetch(\`/api/team/users/${userId}/role\`, ...)` → `apiFetch(\`/team/members/${userId}/role\`, ...)`

For each: parse `.json()` shape stays identical; only the URL changes. The auth/dev login path is left raw in `Login.tsx` because it does `redirect: "manual"` on a `GET` — it doesn't go through store.ts.

- [ ] **Step 4: Thread the signal into long-running refreshers**

`refreshDims`, `refreshSources`, `refreshAudit`, `refreshPreferences`, `refreshDrafts`, `refreshConnectionHealth` — none today pass an explicit signal, but the `apiInner` default above gives them `tenantSessionController.signal` automatically. Verify by reading the new `apiInner` once.

In `initStore`, where the top-of-function `Promise.all([... fetch('/api/auth/me') ...])` is, change that branch to `authFetch("/auth/me")`.

- [ ] **Step 5: Typecheck + lint**

```bash
cd app && bun run typecheck 2>&1 | tail -3
cd app && bun run lint src/store.ts 2>&1 | tail -3
```
Expected: 0 type errors, 0 lint errors on store.ts.

- [ ] **Step 6: Run existing store tests if any exist**

```bash
cd app && ls test/ 2>/dev/null && bun run test --reporter=dot 2>&1 | tail -5
```
Expected: existing tests still green.

- [ ] **Step 7: Commit**

```bash
git add app/src/store.ts
git commit -m "feat(app): store uses apiFetch; tenant session AbortController + onTenantSwitch"
```

---

## Task 7: Client — migrate remaining fetch sites

Walk the rest of the Task 5 lint output. Group by file so each commit is self-contained.

**Files:**
- Modify: `app/src/components/BootGate.tsx`
- Modify: `app/src/components/AppShell.tsx`
- Modify: `app/src/routes/Login.tsx`
- Modify: `app/src/routes/Signup.tsx`
- Modify: `app/src/routes/Settings.tsx` (only the team-section fetches — Settings → Team rewrite is Task 11)
- Modify: `app/src/lib/use-ai-hint.ts`
- Modify: `app/src/lib/use-row-activity.ts` (if it has fetches)

- [ ] **Step 1: BootGate**

`fetch("/api/auth/me")` → `authFetch("/auth/me")`.

- [ ] **Step 2: AppShell**

- `fetch("/api/auth/logout", { method: "POST" })` → `authFetch("/auth/logout", { method: "POST" })`.
- `fetch("/api/sources/scan-status")` → `apiFetch("/sources/scan-status")`.

- [ ] **Step 3: Login / Signup**

- Login: `fetch("/api/auth/login", ...)` → `authFetch("/auth/login", ...)`. The dev-login `fetch("/api/auth/dev", ...)` stays raw OR moves through `authFetch` (it just needs `/api/auth/dev`) — choose `authFetch` and add an ESLint disable if `redirect: "manual"` interacts oddly. Verify with a manual login click after.
- Signup: `fetch("/api/auth/signup", ...)` → `authFetch("/auth/signup", ...)`.

- [ ] **Step 4: Settings.tsx — team fetches**

Even though Task 11 rewrites against per-tenant endpoints, migrate the URL shapes now so lint passes:

- `fetch("/api/team/members")` → `apiFetch("/team/members")`
- `fetch("/api/team/members", { POST … })` → `apiFetch("/team/members", { POST … })`
- `fetch(\`/api/team/members/${encodeURIComponent(email)}\`, { DELETE })` → `apiFetch(\`/team/members/${encodeURIComponent(email)}\`, { DELETE })`
- `fetch("/api/sources/scan-status")` → `apiFetch("/sources/scan-status")`

Task 11 will swap the URL paths to the invite-based endpoints; this step only changes the call shape.

- [ ] **Step 5: use-ai-hint.ts**

`fetch(\`/api/triage/ai-hint?…\`, { signal })` → `apiFetch(\`/triage/ai-hint?${qs.toString()}\`, { signal: controller.signal })`. Local `controller.signal` overrides the store's tenant signal — that's correct (it's already per-hint).

- [ ] **Step 6: Lint must be green repo-wide**

```bash
cd app && bun run lint 2>&1 | tail -3
```
Expected: 0 errors.

- [ ] **Step 7: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add app/src/
git commit -m "refactor(app): migrate ~20 fetch sites to apiFetch/authFetch"
```

---

## Task 8: Client — `TenantProvider` + `useTenant()` context

`useTenant()` returns `{ id, slug, label, role, isSuperAdmin }`. It's set once per `<TenantLayout>` mount and stays stable until the slug changes (which unmounts/remounts the layout — react-router's `key={slug}` trick).

**Files:**
- Create: `app/src/lib/tenant-context.tsx`
- Test: `app/test/tenant-context.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// app/test/tenant-context.test.tsx
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { TenantProvider, useTenant } from "../src/lib/tenant-context";

function Probe() {
  const t = useTenant();
  return <div data-testid="ctx">{t.slug}/{t.role}</div>;
}

describe("TenantProvider", () => {
  test("exposes tenant via useTenant()", () => {
    render(
      <TenantProvider value={{ id: "t1", slug: "acme", label: "Acme", role: "admin", isSuperAdmin: false }}>
        <Probe />
      </TenantProvider>,
    );
    expect(screen.getByTestId("ctx").textContent).toBe("acme/admin");
  });

  test("throws when used outside provider", () => {
    expect(() => render(<Probe />)).toThrow(/useTenant.*outside/);
  });
});
```

(If `@testing-library/react` isn't installed, add via `bun add -d` first.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun test test/tenant-context.test.tsx 2>&1 | tail -5
```
Expected: module not found.

- [ ] **Step 3: Implement the context**

```tsx
// app/src/lib/tenant-context.tsx
import { createContext, useContext, type ReactNode } from "react";

export interface TenantContextValue {
  id: string;
  slug: string;
  label: string;
  role: "admin" | "editor" | "viewer";
  isSuperAdmin: boolean;
}

const Ctx = createContext<TenantContextValue | null>(null);

export function TenantProvider({ value, children }: { value: TenantContextValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTenant(): TenantContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTenant() called outside <TenantProvider> — only valid inside /app/:slug/* routes");
  return v;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd app && bun test test/tenant-context.test.tsx 2>&1 | tail -5
```
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tenant-context.tsx app/test/tenant-context.test.tsx
git commit -m "feat(app): TenantProvider + useTenant() context"
```

---

## Task 9: Client — `TenantLayout` (slug validation + session lifecycle)

The layout component sits between react-router and `<AppShell>`. It receives memberships (loaded by BootGate, threaded via outlet context) and the current `:tenantSlug` param, validates the slug against memberships (allowing super-admin to enter any tenant), and orchestrates `onTenantSwitch()` when the slug changes.

**Files:**
- Create: `app/src/components/TenantLayout.tsx`
- Test: `app/test/tenant-context.test.tsx` (extend with layout tests)

- [ ] **Step 1: Write the failing test**

```tsx
// app/test/tenant-context.test.tsx (append)
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TenantLayout } from "../src/components/TenantLayout";

const fakeMemberships = [{ slug: "acme", label: "Acme", role: "admin" as const }];

describe("TenantLayout slug validation", () => {
  test("renders children when slug is in memberships", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/triage"]}>
        <Routes>
          <Route element={<TenantLayout memberships={fakeMemberships} isSuperAdmin={false} />}>
            <Route path="/app/:tenantSlug/triage" element={<div data-testid="kid">child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("kid")).toBeTruthy();
  });

  test("redirects to /app when slug is not in memberships and not super-admin", () => {
    render(
      <MemoryRouter initialEntries={["/app/forbidden/triage"]}>
        <Routes>
          <Route element={<TenantLayout memberships={fakeMemberships} isSuperAdmin={false} />}>
            <Route path="/app/:tenantSlug/triage" element={<div data-testid="kid">child</div>} />
          </Route>
          <Route path="/app" element={<div data-testid="redirected">redirected</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("kid")).toBeNull();
    expect(screen.getByTestId("redirected")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun test test/tenant-context.test.tsx 2>&1 | tail -10
```
Expected: module not found.

- [ ] **Step 3: Implement `TenantLayout`**

```tsx
// app/src/components/TenantLayout.tsx
import { useEffect, useMemo, useRef } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../lib/tenant-context";
import { onTenantSwitch, initStore } from "../store";

export interface Membership {
  slug: string;
  label: string;
  role: "admin" | "editor" | "viewer";
  // id resolved lazily — server returns it in /workspace/info per-tenant on first call,
  // but for the context we only need slug+role+label until then. Store the id once known.
}

export function TenantLayout({
  memberships,
  isSuperAdmin,
}: {
  memberships: Membership[];
  isSuperAdmin: boolean;
}) {
  const { tenantSlug } = useParams<{ tenantSlug: string }>();
  const m = memberships.find((x) => x.slug === tenantSlug);

  // Track the slug we last initialized for. Switching = abort + reset + reinit.
  const lastSlug = useRef<string | null>(null);

  useEffect(() => {
    if (!tenantSlug) return;
    if (lastSlug.current === tenantSlug) return;
    if (lastSlug.current !== null) onTenantSwitch();
    lastSlug.current = tenantSlug;
    // Persist for the BootGate redirect on next session.
    localStorage.setItem("zugzug:last-tenant-slug", tenantSlug);
    void initStore();
  }, [tenantSlug]);

  if (!tenantSlug) return <Navigate to="/app" replace />;

  if (!m && !isSuperAdmin) {
    return <Navigate to="/app" replace />;
  }

  const ctx: TenantContextValue = useMemo(
    () => ({
      // id is unknown client-side until /workspace/info resolves; server is the
      // authority. We pass slug as the identity for UI purposes; mutations go
      // through apiFetch which embeds the slug in the URL.
      id: m?.slug ?? tenantSlug,
      slug: tenantSlug,
      label: m?.label ?? tenantSlug,
      role: m?.role ?? "admin", // super-admin entering a non-member tenant — gets admin UI affordances; server still enforces
      isSuperAdmin,
    }),
    [tenantSlug, m, isSuperAdmin],
  );

  return (
    <TenantProvider value={ctx}>
      <Outlet />
    </TenantProvider>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && bun test test/tenant-context.test.tsx 2>&1 | tail -5
```
Expected: 4 pass total.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/TenantLayout.tsx app/test/tenant-context.test.tsx
git commit -m "feat(app): TenantLayout — slug validation + session lifecycle"
```

---

## Task 10: Client — BootGate fetches memberships + resolves initial slug

BootGate currently fetches `/api/auth/me` and calls `initStore()` before the children render. PR4 splits this: BootGate fetches memberships **first** (without calling `initStore`, because there's no tenant yet), passes them to the route tree via outlet context, and renders either the route tree (with valid memberships) or `<NoWorkspaceLanding />` (when memberships is empty and user is not super-admin).

`initStore` no longer runs from BootGate — `TenantLayout` runs it when a slug mounts.

**Files:**
- Modify: `app/src/components/BootGate.tsx`
- Create: `app/src/components/NoWorkspaceLanding.tsx`
- Test: `app/test/boot-gate-redirect.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// app/test/boot-gate-redirect.test.tsx
import { describe, expect, test, beforeEach, vi } from "vitest"; // or bun:test equivalents
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
import { BootGate } from "../src/components/BootGate";

function mockResponses(map: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = map[url];
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("BootGate", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("renders NoWorkspaceLanding when memberships empty and not super-admin", async () => {
    mockResponses({
      "/api/auth/me": { id: "u1", email: "x@y.com", isSuperAdmin: false },
      "/api/me/memberships": { isSuperAdmin: false, memberships: [] },
    });
    render(
      <MemoryRouter initialEntries={["/app"]}>
        <BootGate>
          <Routes><Route path="*" element={<div>kid</div>} /></Routes>
        </BootGate>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/not in any workspace/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun test test/boot-gate-redirect.test.tsx 2>&1 | tail -10
```
Expected: failure.

- [ ] **Step 3: Implement `NoWorkspaceLanding`**

```tsx
// app/src/components/NoWorkspaceLanding.tsx
import { Mark } from "./Mark";
import { Button } from "./Button";
import { authFetch } from "../api";

export function NoWorkspaceLanding() {
  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() => window.location.replace("/login"));

  return (
    <div className="zz-canvas grid min-h-screen place-items-center p-8">
      <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-8 text-center">
        <Mark className="mx-auto h-10 w-10" />
        <h1 className="font-display text-2xl font-bold text-ink">You're not in any workspace yet.</h1>
        <p className="text-ink-2">
          Ask a workspace admin to invite your email. Once they do, refresh this page and you'll be
          dropped straight into the workspace.
        </p>
        <Button onClick={signOut}>Sign out</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `BootGate`**

```tsx
// app/src/components/BootGate.tsx
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Mark } from "./Mark";
import { Button } from "./Button";
import { NoWorkspaceLanding } from "./NoWorkspaceLanding";
import { authFetch } from "../api";
import type { Membership } from "./TenantLayout";

interface BootData {
  memberships: Membership[];
  isSuperAdmin: boolean;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: BootData }
  | { kind: "no-workspace" }
  | { kind: "error"; detail: string };

const LAST_SLUG_KEY = "zugzug:last-tenant-slug";

export function BootGate({ children }: { children: (data: BootData) => ReactNode | ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const navigate = useNavigate();
  const location = useLocation();

  const boot = () => {
    setState({ kind: "loading" });
    (async () => {
      const meRes = await authFetch("/auth/me");
      if (meRes.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!meRes.ok) throw new Error(`API unreachable (${meRes.status})`);

      const memRes = await authFetch("/me/memberships");
      if (!memRes.ok) throw new Error(`memberships ${memRes.status}`);
      const body = (await memRes.json()) as BootData;

      // Empty memberships + not super-admin → dead-end landing.
      if (body.memberships.length === 0 && !body.isSuperAdmin) {
        setState({ kind: "no-workspace" });
        return;
      }

      // Resolve initial slug ONLY when sitting at /app or /.
      if (location.pathname === "/" || location.pathname === "/app") {
        const last = localStorage.getItem(LAST_SLUG_KEY);
        const preferred =
          (last && body.memberships.find((m) => m.slug === last)?.slug) ??
          body.memberships[0]?.slug ??
          (body.isSuperAdmin ? "admin" : null);
        if (preferred) navigate(`/app/${preferred}`, { replace: true });
      }

      setState({ kind: "ready", data: body });
    })().catch((e: unknown) =>
      setState({ kind: "error", detail: e instanceof Error ? e.message : String(e) }),
    );
  };

  useEffect(boot, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "ready") {
    return <>{typeof children === "function" ? children(state.data) : children}</>;
  }
  if (state.kind === "no-workspace") return <NoWorkspaceLanding />;
  if (state.kind === "error") {
    return (
      <div className="zz-canvas grid min-h-screen place-items-center p-8">
        <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-8">
          <div className="flex items-center gap-2.5">
            <Mark className="h-7 w-7" />
            <span className="font-display text-lg font-extrabold tracking-tight text-ink">
              Zug Zug<span className="text-accent">.</span>
            </span>
          </div>
          <h1 className="font-display text-2xl font-bold text-ink">Can't reach the API.</h1>
          <p className="text-ink-2">The server isn't responding. Start it with:</p>
          <pre className="overflow-x-auto rounded-sm border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink-2">
            cd server &amp;&amp; bun run start
          </pre>
          <details className="text-[12px] text-ink-2">
            <summary className="cursor-pointer">Technical detail</summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono">{state.detail}</pre>
          </details>
          <div className="flex justify-end">
            <Button onClick={boot}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="zz-canvas grid min-h-screen place-items-center p-8">
      <div className="flex items-center gap-2.5">
        <Mark className="h-8 w-8 animate-pulse" />
        <span className="font-display text-lg font-extrabold tracking-tight text-ink-2">
          Loading Zug Zug<span className="text-accent">…</span>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd app && bun test test/boot-gate-redirect.test.tsx 2>&1 | tail -5
```
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/BootGate.tsx app/src/components/NoWorkspaceLanding.tsx app/test/boot-gate-redirect.test.tsx
git commit -m "feat(app): BootGate fetches memberships, redirects to last-used workspace"
```

---

## Task 11: Client — route restructure to `/app/:tenantSlug/*` + `/app/admin/*`

Wire BootGate's `data` into the route tree, mount `<TenantLayout>` above `<AppShell>`, mount a separate `<AdminShell>` for super-admin.

**Files:**
- Modify: `app/src/main.tsx`
- Create: `app/src/components/AdminShell.tsx`
- Create: `app/src/routes/admin/Tenants.tsx`

- [ ] **Step 1: Rewrite `main.tsx` route table**

```tsx
// app/src/main.tsx — Routes block (rest of file unchanged)
<Routes>
  {/* Public */}
  <Route path="/login" element={<Login />} />
  <Route path="/signup" element={<Signup />} />
  <Route path="/design" element={<Showcase />} />

  {/* Protected */}
  <Route
    path="*"
    element={
      <RouteErrorBoundary>
        <EngineerModeProvider>
          <BootGate>
            {(boot) => (
              <OpenTabsProvider>
                <CreateTableModalProvider>
                  <Routes>
                    {/* /app and / both redirect inside BootGate's effect — these are fallbacks
                        if the user lands on /app/<unknown-slug>/etc. */}
                    <Route path="/" element={<Navigate to="/app" replace />} />
                    <Route path="/app" element={<Navigate to={`/app/${boot.memberships[0]?.slug ?? "admin"}`} replace />} />

                    {/* Super-admin shell */}
                    {boot.isSuperAdmin && (
                      <Route path="/app/admin/*" element={<AdminShell />}>
                        <Route index element={<AdminTenants />} />
                        <Route path="tenants" element={<AdminTenants />} />
                      </Route>
                    )}

                    {/* Tenant-scoped shell. key={slug} forces full remount on switch. */}
                    <Route
                      path="/app/:tenantSlug/*"
                      element={
                        <TenantLayout memberships={boot.memberships} isSuperAdmin={boot.isSuperAdmin} />
                      }
                    >
                      <Route element={<AppShell />}>
                        <Route index element={<Dashboard />} />
                        <Route path="triage" element={<Triage />} />
                        <Route path="sources" element={<Sources />} />
                        <Route path="tables" element={<MasterTables />} />
                        <Route path="settings" element={<Settings />} />
                      </Route>
                    </Route>

                    <Route path="*" element={<Navigate to="/app" replace />} />
                  </Routes>
                </CreateTableModalProvider>
              </OpenTabsProvider>
            )}
          </BootGate>
        </EngineerModeProvider>
      </RouteErrorBoundary>
    }
  />
</Routes>
```

Add imports for `TenantLayout`, `AdminShell`, `AdminTenants`.

- [ ] **Step 2: Implement `AdminShell` (minimal chrome)**

```tsx
// app/src/components/AdminShell.tsx
import { Link, Outlet } from "react-router-dom";
import { Mark } from "./Mark";

export function AdminShell() {
  return (
    <div className="zz-canvas min-h-screen">
      <header className="border-b border-line px-6 py-3 flex items-center gap-3">
        <Mark className="h-6 w-6" />
        <span className="font-display font-bold">Zug Zug — Admin</span>
        <nav className="ml-6 text-sm flex gap-4">
          <Link to="/app/admin/tenants">Tenants</Link>
          <Link to="/app">Back to workspaces</Link>
        </nav>
      </header>
      <main className="p-6"><Outlet /></main>
    </div>
  );
}
```

- [ ] **Step 3: Implement `AdminTenants` (list + create form)**

```tsx
// app/src/routes/admin/Tenants.tsx
import { useEffect, useState } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";

interface Tenant { id: string; slug: string; label: string; warehouse_id: string; }

export function AdminTenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [warehouseId, setWarehouseId] = useState("default");

  const refresh = async () => {
    const r = await apiFetch("/tenants");
    if (r.ok) setTenants(((await r.json()) as { tenants: Tenant[] }).tenants);
  };
  useEffect(() => { void refresh(); }, []);

  const create = async () => {
    const r = await apiFetch("/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, label, warehouseId }),
    });
    if (r.ok) { setSlug(""); setLabel(""); void refresh(); }
  };

  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-2xl font-bold mb-3">Workspaces</h1>
        <ul className="divide-y divide-line">
          {tenants.map((t) => (
            <li key={t.id} className="py-2 flex gap-4">
              <span className="font-mono text-sm">{t.slug}</span>
              <span>{t.label}</span>
              <span className="text-ink-2">{t.warehouse_id}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="font-display text-lg font-bold mb-2">New workspace</h2>
        <div className="flex gap-2">
          <input className="border px-2 py-1" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="slug" />
          <input className="border px-2 py-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" />
          <input className="border px-2 py-1" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="warehouse_id" />
          <Button onClick={create}>Create</Button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Smoke-run in browser**

```bash
# In one terminal:
cd server && bun run start
# In another:
cd app && bun run dev
```

Open `http://localhost:5173/login`, sign in as the dev user, confirm:

1. After login, URL becomes `/app/default` (or whichever slug `default` membership has).
2. Sidebar renders.
3. Hit `Cmd+K` palette → still works.
4. Console has zero 404s.

- [ ] **Step 5: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/main.tsx app/src/components/AdminShell.tsx app/src/routes/admin/
git commit -m "feat(app): /app/:tenantSlug/* + /app/admin/* route shells"
```

---

## Task 12: Client — `useTenantNavigate` + `useNavLinks` + hardcoded `/app/*` sweep

Eighteen call sites (Task 5 grep) hardcode `/app/triage`, `/app/tables`, etc. ESLint can't catch them. Two helpers:

- `useNavLinks()` returns `{ dashboard, triage, sources, tables, settings }` — already prefixed with `/app/:slug/`.
- `useTenantNavigate()` wraps `useNavigate()` so `nav("/triage")` becomes `navigate("/app/:slug/triage")`.

**Files:**
- Create: `app/src/lib/use-tenant-navigate.ts`
- Modify: `app/src/components/AppShell.tsx`
- Modify: `app/src/components/SidebarTableTree.tsx`
- Modify: `app/src/components/NoTablesYet.tsx`
- Modify: `app/src/routes/Triage.tsx`
- Modify: `app/src/routes/Dashboard.tsx`
- Modify: `app/src/routes/Sources.tsx`
- Modify: `app/src/routes/Showcase.tsx` (or delete; dev-only)

- [ ] **Step 1: Implement helpers**

```ts
// app/src/lib/use-tenant-navigate.ts
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTenant } from "./tenant-context";

/** Prefixed nav helper: nav("/triage") → navigate("/app/:slug/triage"). */
export function useTenantNavigate(): (to: string, opts?: { replace?: boolean }) => void {
  const { slug } = useTenant();
  const navigate = useNavigate();
  return useCallback(
    (to, opts) => {
      const target = to.startsWith("/") ? `/app/${slug}${to}` : to;
      navigate(target, opts);
    },
    [slug, navigate],
  );
}

/** Tenant-prefixed nav hrefs for top-level pages. */
export function useNavLinks() {
  const { slug } = useTenant();
  return useMemo(
    () => ({
      base: `/app/${slug}`,
      dashboard: `/app/${slug}`,
      triage: `/app/${slug}/triage`,
      sources: `/app/${slug}/sources`,
      tables: `/app/${slug}/tables`,
      settings: `/app/${slug}/settings`,
      table: (dimId: string, mode?: "match" | "review") =>
        `/app/${slug}/tables?open=${dimId}&active=${dimId}${mode ? `&mode=${mode}` : ""}`,
      tablesFocus: (key: string) => `/app/${slug}/tables?focus=${encodeURIComponent(key)}`,
    }),
    [slug],
  );
}
```

- [ ] **Step 2: AppShell — swap hardcoded paths**

In `app/src/components/AppShell.tsx`:

- Import `useNavLinks` from `../lib/use-tenant-navigate`.
- Inside the component, `const nav = useNavLinks();`.
- Replace every nav item's path (`/app`, `/app/triage`, `/app/sources`, `/app/tables`, `/app/settings`) and every command-palette `action: () => navigate("/app/…")` with the corresponding `nav.xxx` values.
- Replace `navigate(\`/app/tables?open=${d.id}&active=${d.id}&mode=match\`)` with `navigate(nav.table(d.id, "match"))`.
- Replace `navigate(\`/app/tables?focus=…\`)` with `navigate(nav.tablesFocus(c.key))`.

- [ ] **Step 3: SidebarTableTree — use `useTenantNavigate`**

`navigate("/app/tables")` → `nav("/tables")` via `useTenantNavigate`.

- [ ] **Step 4: NoTablesYet — Link to nav.sources**

`<Link to="/app/sources">` → `<Link to={nav.sources}>`.

- [ ] **Step 5: Triage, Dashboard, Sources — same sweep**

Each file: import `useNavLinks`, replace every literal `/app/…` href/path.

- [ ] **Step 6: Showcase**

`Showcase` is a public design playground at `/design`. Its `to="/app"` Link should send users back to BootGate's resolver — keep it as `to="/app"` (TenantLayout / BootGate will redirect to slug). Verify behavior in browser.

- [ ] **Step 7: Grep for remaining hardcoded /app/* paths**

```bash
grep -rnE "[\"\`]/app/(triage|tables|sources|settings|admin)" app/src/ --include="*.ts" --include="*.tsx"
```
Expected output: only inside `use-tenant-navigate.ts` (the helper itself) and possibly `main.tsx` (route definitions) and `Showcase.tsx` (deliberate `/app` back-link).

- [ ] **Step 8: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```
Expected: 0 errors.

- [ ] **Step 9: Browser smoke test**

Visit `/app/default`, click every sidebar nav item, run a few palette commands. Switch URL manually to `/app/default/triage` — back/forward should work; sidebar highlights move.

- [ ] **Step 10: Commit**

```bash
git add app/src/lib/use-tenant-navigate.ts app/src/components/ app/src/routes/
git commit -m "refactor(app): tenant-prefixed nav via useNavLinks + useTenantNavigate"
```

---

## Task 13: Client — `WorkspaceSwitcher` dropdown

Top-left dropdown in `<AppShell>`'s header showing `{label} ▾`. Click opens a menu:

- For each membership: `{label}` (current one ticked). Click → `navigate("/app/<otherSlug>" + currentSubpath)`.
- For super-admin: a `─` divider then `Admin console` (→ `/app/admin`).
- For super-admin: a `─` divider then `+ Create workspace` (→ `/app/admin/tenants`).
- Always: `Sign out`.

Closing-on-outside-click via shared `useClickOutside` hook (already exists in the codebase if `CommandPalette` uses one — check first; otherwise inline).

**Files:**
- Create: `app/src/components/WorkspaceSwitcher.tsx`
- Modify: `app/src/components/AppShell.tsx` (render switcher in header)
- Test: `app/test/workspace-switcher.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// app/test/workspace-switcher.test.tsx
import { describe, expect, test } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { TenantProvider } from "../src/lib/tenant-context";
import { WorkspaceSwitcher } from "../src/components/WorkspaceSwitcher";

const memberships = [
  { slug: "acme", label: "Acme", role: "admin" as const },
  { slug: "globex", label: "Globex", role: "editor" as const },
];

function harness(value: { slug: string; isSuperAdmin: boolean }, path = "/app/acme/triage") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/:tenantSlug/*"
          element={
            <TenantProvider value={{ id: value.slug, slug: value.slug, label: value.slug, role: "admin", isSuperAdmin: value.isSuperAdmin }}>
              <WorkspaceSwitcher memberships={memberships} />
            </TenantProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WorkspaceSwitcher", () => {
  test("shows current label", () => {
    harness({ slug: "acme", isSuperAdmin: false });
    expect(screen.getByText(/acme/i)).toBeTruthy();
  });

  test("non-super-admin does NOT see Create workspace", () => {
    harness({ slug: "acme", isSuperAdmin: false });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText(/Create workspace/i)).toBeNull();
  });

  test("super-admin sees Create workspace + Admin console", () => {
    harness({ slug: "acme", isSuperAdmin: true });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/Create workspace/i)).toBeTruthy();
    expect(screen.getByText(/Admin console/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun test test/workspace-switcher.test.tsx 2>&1 | tail -10
```
Expected: module not found.

- [ ] **Step 3: Implement `WorkspaceSwitcher`**

```tsx
// app/src/components/WorkspaceSwitcher.tsx
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTenant } from "../lib/tenant-context";
import { authFetch } from "../api";

interface Item { slug: string; label: string; role: "admin" | "editor" | "viewer"; }

export function WorkspaceSwitcher({ memberships }: { memberships: Item[] }) {
  const tenant = useTenant();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const switchTo = (slug: string) => {
    setOpen(false);
    if (slug === tenant.slug) return;
    // Preserve subpath where possible: /app/<old>/triage → /app/<new>/triage.
    const rest = location.pathname.replace(/^\/app\/[^/]+/, "") || "";
    navigate(`/app/${slug}${rest}`);
  };

  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() => window.location.replace("/login"));

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="font-medium">{tenant.label}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full mt-1 min-w-[220px] rounded border border-line bg-surface shadow-lg z-50">
          <div className="px-3 py-1.5 text-xs text-ink-2 uppercase tracking-wide">Workspaces</div>
          {memberships.map((m) => (
            <button
              key={m.slug}
              onClick={() => switchTo(m.slug)}
              className={`block w-full text-left px-3 py-1.5 hover:bg-surface-2 ${m.slug === tenant.slug ? "font-medium" : ""}`}
              role="menuitem"
            >
              <span className="mr-2 inline-block w-3">{m.slug === tenant.slug ? "✓" : ""}</span>
              {m.label}
              <span className="ml-2 text-xs text-ink-2">({m.role})</span>
            </button>
          ))}
          {tenant.isSuperAdmin && (
            <>
              <hr className="my-1 border-line" />
              <button onClick={() => { setOpen(false); navigate("/app/admin"); }} className="block w-full text-left px-3 py-1.5 hover:bg-surface-2" role="menuitem">
                Admin console
              </button>
              <button onClick={() => { setOpen(false); navigate("/app/admin/tenants"); }} className="block w-full text-left px-3 py-1.5 hover:bg-surface-2" role="menuitem">
                + Create workspace
              </button>
            </>
          )}
          <hr className="my-1 border-line" />
          <button onClick={signOut} className="block w-full text-left px-3 py-1.5 hover:bg-surface-2" role="menuitem">
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Mount in AppShell header**

In `AppShell.tsx`, at the top of the sidebar (above the nav list), thread `memberships` from a prop or from a new `useMemberships()` hook. Simplest: extend `AppShell` to accept `memberships` and pass them from main.tsx via `<Route element={<AppShell memberships={boot.memberships} />}>`.

Render:

```tsx
<div className="px-3 pb-3">
  <WorkspaceSwitcher memberships={memberships} />
</div>
```

(Position above the nav items; the visual treatment is up to ui-designer but it must be the topmost element in the sidebar per spec.)

- [ ] **Step 5: Run tests + browser smoke**

```bash
cd app && bun test test/workspace-switcher.test.tsx 2>&1 | tail -5
cd app && bun run typecheck 2>&1 | tail -3
```
Expected: 3 pass, 0 type errors.

Visually: click the switcher, confirm membership list, confirm "Create workspace" is gated by super-admin.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/WorkspaceSwitcher.tsx app/src/components/AppShell.tsx app/src/main.tsx app/test/workspace-switcher.test.tsx
git commit -m "feat(app): workspace switcher dropdown"
```

---

## Task 14: Client — tenant-scoped `localStorage` keys

`PALETTE_RECENTS_KEY` and `open-tabs` storage key bleed cross-tenant. Suffix both with the active slug. `NAV_COLLAPSED_KEY` stays shared (cosmetic).

**Files:**
- Modify: `app/src/components/AppShell.tsx`
- Modify: `app/src/lib/open-tabs.tsx`
- Create: `app/src/lib/tenant-storage.ts`

- [ ] **Step 1: Add the helper**

```ts
// app/src/lib/tenant-storage.ts
export function scopedKey(base: string, slug: string): string {
  return `${base}:${slug}`;
}
```

- [ ] **Step 2: AppShell — palette recents**

In `AppShell.tsx`:

```ts
import { useTenant } from "../lib/tenant-context";
import { scopedKey } from "../lib/tenant-storage";

const { slug } = useTenant();
const paletteKey = scopedKey(PALETTE_RECENTS_KEY, slug);
// ...later replace localStorage.getItem(PALETTE_RECENTS_KEY) with paletteKey
// and localStorage.setItem(PALETTE_RECENTS_KEY, ...) with paletteKey.
```

- [ ] **Step 3: open-tabs.tsx**

Open `app/src/lib/open-tabs.tsx`, find the `localStorage.getItem/setItem` calls. Convert the provider to accept a `scope` prop or to read the slug from `useTenant()` (since `OpenTabsProvider` is mounted **outside** the tenant route, you can't call `useTenant()` there — instead, mount the `OpenTabsProvider` **inside** `<TenantLayout>` so it lives per-tenant and gets remounted on switch).

Refactor:
- Move `<OpenTabsProvider>` from `main.tsx` to **inside** `<TenantLayout>` (wrap `<Outlet />`).
- Inside the provider, `const { slug } = useTenant(); const key = scopedKey("zugzug:open-tabs", slug);`.

`CreateTableModalProvider` is tenant-agnostic (just modal state) — leave at the outer position.

- [ ] **Step 4: Manual verify**

In browser DevTools → Application → Local Storage, after visiting `/app/default/tables` and opening a table, confirm a key like `zugzug:open-tabs:default` exists. Visit `/app/other/tables` (after creating an "other" tenant via the admin shell) — confirm a separate `zugzug:open-tabs:other` key.

- [ ] **Step 5: Typecheck + commit**

```bash
cd app && bun run typecheck 2>&1 | tail -3
git add app/src/lib/tenant-storage.ts app/src/lib/open-tabs.tsx app/src/components/AppShell.tsx app/src/components/TenantLayout.tsx
git commit -m "feat(app): tenant-scope palette recents + open-tabs localStorage keys"
```

---

## Task 15: Client — WebSocket presence URL uses `/ws/t/:slug/`

PR2b shipped `/ws/t/:slug/presence/:tableId` server-side with `default`-tenant fallback on the legacy URL. Client needs to build the new URL.

**Files:**
- Modify: `app/src/lib/use-presence.ts` (or wherever the WS URL is constructed)

- [ ] **Step 1: Find the construction site**

```bash
grep -rn "ws/presence\|/ws/\|new WebSocket" app/src/ --include="*.ts" --include="*.tsx"
```

- [ ] **Step 2: Update URL**

In the file that builds the WS URL, derive the slug the same way `apiFetch` does and build `/ws/t/${slug}/presence/${tableId}`:

```ts
const m = /^\/app\/([^/]+)\//.exec(window.location.pathname + "/");
const slug = m?.[1] ?? "default";
const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
const url = `${proto}//${window.location.host}/ws/t/${slug}/presence/${encodeURIComponent(tableId)}`;
```

(Don't reuse the regex from `api.ts` to avoid a circular dep — duplicate the literal regex. If you want to factor it later, do it in a follow-up.)

- [ ] **Step 3: Browser smoke**

Open two browser windows in the same tenant, edit a row → presence cursor shows. Open a window in a different tenant on the same table id (if you have one) → no cross-tenant cursor. (If you don't have an overlapping table id between tenants, this confirms only the URL change; server-side namespacing is already tested in PR2b.)

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/use-presence.ts  # or wherever
git commit -m "feat(app): tenant-namespaced presence WebSocket URL"
```

---

## Task 16: Client — Settings → Team rewrite against per-tenant endpoints

The team section in Settings already exists (#103) and after Task 7 it talks to `/api/t/:slug/team/members` via `apiFetch`. PR4 finishes the job: rewrite to use the new invite-based flow.

**Files:**
- Modify: `app/src/routes/Settings.tsx`

- [ ] **Step 1: Read the existing Team section**

Open `Settings.tsx` around line 800–1050. Understand the existing chip-based add flow, the `members` list, the role picker.

- [ ] **Step 2: Pivot endpoints**

Replace:

- `apiFetch("/team/members")` (the list) — keep, but the server response shape changes (Task 3 returns `MemberRecord[]` with `user_id, email, name, role`). Update the local `Member` type and rendering.
- `apiFetch("/team/members", { POST … body: { email } })` (the add flow) — replace with `apiFetch("/team/invites", { POST … body: { email, role: "editor" } })`. Inviting now creates a pending invite, not an immediate member.
- `apiFetch(\`/team/members/${encodeURIComponent(email)}\`, { DELETE })` — replace with `apiFetch(\`/team/members/${userId}\`, { DELETE })` (delete by `user_id`, not email — emails change, IDs don't). Adjust the UI list to track `user_id`.
- Add a "Pending invites" panel above or below the members list — fetched via `apiFetch("/team/invites")`. Each row: `email`, `role`, `Revoke` button → `apiFetch(\`/team/invites/${encodeURIComponent(email)}\`, { DELETE })`.
- Role picker now calls `apiFetch(\`/team/members/${userId}/role\`, { PUT … body: { role } })`.
- Surface 403 from the server as "Only admins can invite" — gate the entire invite/remove UI behind `useTenant().role === "admin"`.

- [ ] **Step 3: Surface the user-facing model: invite → member**

In the chip flow, when an invite is created, show a toast "Invite sent to alice@example.com — they'll join when they next sign in." Don't optimistically add them to the member list (they're not a member yet).

- [ ] **Step 4: Browser smoke**

1. Sign in as admin in tenant `default`.
2. Settings → Team → invite a fresh email.
3. Confirm it shows up under "Pending invites".
4. Revoke; gone.
5. Sign in as that invited user (use the dev-login or sign-up flow); confirm landing in `/app/default`.

- [ ] **Step 5: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/Settings.tsx
git commit -m "feat(app): Settings → Team uses per-tenant invite endpoints"
```

---

## Task 17: Client — `store-tenant-switch` integration test

Verify the AbortController plumbing actually cancels in-flight refreshes on slug change. Hard to test purely in unit land (depends on store globals); the test mocks `fetch` to return a deferred promise, triggers a switch, and asserts the deferred promise's resolution doesn't write to the store.

**Files:**
- Test: `app/test/store-tenant-switch.test.ts`

- [ ] **Step 1: Write the test**

```ts
// app/test/store-tenant-switch.test.ts
import { describe, expect, test, beforeEach, vi } from "vitest";
import { initStore, onTenantSwitch, useDimensions } from "../src/store";
import { renderHook } from "@testing-library/react";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("onTenantSwitch", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("aborts in-flight refresh; late response does not land", async () => {
    const dimsD = deferred<Response>();
    window.history.replaceState(null, "", "/app/acme/tables");
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal) {
        signal.addEventListener("abort", () => dimsD.resolve(new Response("aborted", { status: 0 })));
      }
      // Return a never-resolving promise (or the deferred one) so initStore is hanging.
      return dimsD.promise;
    });

    const init = initStore();
    onTenantSwitch();
    await Promise.race([init, new Promise((r) => setTimeout(r, 50))]);
    // After the abort, dims should still be the initial empty array.
    const { result } = renderHook(() => useDimensions());
    expect(result.current).toEqual([]);
  });
});
```

(This test is the trickiest — it may need adjustment depending on how `fetch` is mocked in the project. Spec-reviewer should look at this carefully.)

- [ ] **Step 2: Run + tweak until green**

```bash
cd app && bun test test/store-tenant-switch.test.ts 2>&1 | tail -10
```
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add app/test/store-tenant-switch.test.ts
git commit -m "test(app): onTenantSwitch aborts in-flight refreshes"
```

---

## Task 18: End-to-end browser walk + screenshots

Manual but mandatory — much of the UX (visual switcher polish, redirect timing, mid-flight switch UX) can only be verified in the real app.

**Files:** none (PR description gets the screenshots).

- [ ] **Step 1: Start clean**

```bash
cd server && bun run start
# In another terminal:
cd app && bun run dev
```

- [ ] **Step 2: Provision a second tenant via the admin CLI**

```bash
cd server && bun run admin -- create-tenant other "Other Workspace" default
cd server && bun run admin -- promote-super-admin dev@localhost  # if not already
```

- [ ] **Step 3: Browser checklist**

In a logged-in browser session:

- [ ] Visit `/` → redirected to `/app/default` (or `last-tenant-slug`).
- [ ] Sidebar shows workspace switcher at top.
- [ ] Click switcher → see "Default", "Other Workspace", divider, "Admin console", "+ Create workspace", "Sign out".
- [ ] Switch to "Other Workspace" → URL becomes `/app/other`, sidebar table list reloads (empty for new tenant), no console errors.
- [ ] In "Other Workspace", Settings → Team → invite an email → confirm pending invite appears.
- [ ] Switch back to "Default" → invite is gone (it lived on "Other Workspace").
- [ ] Open palette `Cmd+K`, search "Settings", select → arrives at `/app/default/settings`.
- [ ] Click "Admin console" → arrives at `/app/admin/tenants`, list shows two tenants.
- [ ] Reload `/app/default/triage` directly — sidebar still highlights Triage, no flash of empty state.
- [ ] Sign out from switcher → cookies cleared, lands at `/login`.

- [ ] **Step 4: Capture screenshots for the PR description**

Take screenshots of the switcher open, the admin shell, the per-tenant team page with a pending invite. Save under `docs/screenshots/mt-pr4/` (create if needed).

- [ ] **Step 5: Commit screenshots**

```bash
git add docs/screenshots/mt-pr4/
git commit -m "docs(mt-pr4): screenshots — switcher, admin, team invites"
```

---

## Task 19: Final sweep + PR

- [ ] **Step 1: Lint must be green**

```bash
cd app && bun run lint 2>&1 | tail -3
cd server && bun run lint 2>&1 | tail -3
```
Expected: 0 errors each.

- [ ] **Step 2: Typecheck must be green**

```bash
cd app && bun run typecheck 2>&1 | tail -3
cd server && bun run typecheck 2>&1 | tail -3
```
Expected: 0 errors each.

- [ ] **Step 3: Full test sweep**

```bash
cd server && bun run test 2>&1 | tail -5
cd app && bun run test 2>&1 | tail -5
```
Expected: all green. Record numbers in PR description.

- [ ] **Step 4: Grep for leftover red flags**

```bash
grep -rn "fetch(\"/api\|fetch(\`/api" app/src/ --include="*.ts" --include="*.tsx" | grep -v "src/api.ts"
grep -rnE "[\"\`]/app/(triage|tables|sources|settings)[\"\`?]" app/src/ --include="*.ts" --include="*.tsx" | grep -v "use-tenant-navigate.ts"
```
Both expected empty (besides allowlisted lines).

- [ ] **Step 5: Update memory**

Append to `project-current-state.md`: PR4 shipped, list test counts, note residual items for PR5 (legacy `/api/team/*` route still alive, NOT NULL flips pending, RLS pending, drop `users.role` pending).

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin mt-pr4-ui-shell
gh pr create --title "Multi-tenant PR 4 — UI shell + apiFetch (folds in PR3)" --body "$(cat <<'EOF'
## Summary
- `/app/:tenantSlug/*` routes + `<TenantLayout>` + `useTenant()` context
- Workspace switcher (Linear-style top-left dropdown); super-admin gets "+ Create workspace" + "Admin console"
- `apiFetch` (URL-derived slug) + `authFetch` + ESLint backstop; ~23 fetch sites migrated
- BootGate fetches `/api/me/memberships` and redirects `/` → `/app/<lastUsedSlug>`
- `onTenantSwitch()` aborts in-flight + cancels debounced timers + resets store
- Tenant-scoped `localStorage` (palette recents, open-tabs)
- WebSocket: `/ws/t/:slug/presence/:tableId`
- Settings → Team: pivots to per-tenant invite endpoints (`/api/t/:slug/team/invites`)
- Super-admin: `/app/admin/tenants` list + create

## Folded in
- PR3's `apiFetch` + ESLint rule + fetch-site sweep (kept together because routes and URLs change together).

## What's deferred to PR5
- Legacy `/api/team/*` + `/api/preferences` + `/api/audit` routes (default-tenant fallback) — drop on cutover.
- NOT NULL flips, FKs, PK swaps, drop `users.role`, drop `allowed_emails`.
- Enable RLS.

## Test plan
- [ ] `bun run test` in `server/` — all green
- [ ] `bun run test` in `app/` — all green
- [ ] `bun run typecheck` + `bun run lint` in both — clean
- [ ] Manual: visit `/`, redirect to `/app/<slug>`; switch workspaces; admin shell; per-tenant invites; sign out

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** Tasks map to spec items: Routes (Task 11), `apiFetch` (Task 4), ESLint rule (Task 5), Workspace switcher (Task 13), AbortController race fix (Task 6 + Task 17), Cancel-on-switch (Task 6), Hardcoded nav (Task 12), Tenant-scoped `localStorage` (Task 14), BootGate redirect (Task 10), WebSocket (Task 15), Settings → Team (Task 16). `/app/admin` shell (Task 11). Server-side `/api/me/memberships` (Task 2) and per-tenant team endpoints (Task 3) are new but required for PR4's UI to function.
- **Type consistency:** `TenantContextValue` is defined in Task 8 and consumed in Tasks 9, 12, 13, 14. `Membership` is defined in Task 9 and consumed in Tasks 10, 11, 13. Both stable across tasks.
- **`AppShell` props change:** Tasks 11–13 extend `AppShell` to receive `memberships`. The route definition in Task 11 passes `memberships={boot.memberships}` (via a wrapping element since `<Route element>` doesn't take child props directly — use a small `<AppShellWithMemberships memberships={…} />` adapter inside `main.tsx` if React Router complains). This is a place to validate in execution.
- **`OpenTabsProvider` move (Task 14)** changes mount location — verify open-tabs state doesn't leak across switches, but ALSO verify that the create-table modal (still outer) doesn't break when the inner provider unmounts.
