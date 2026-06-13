# Settings — Phase A: Super-admin elevation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `isSuperAdmin === true` grant admin-equivalent affordances and access on both client and server, regardless of the user's actual workspace role. Tag every elevated mutation in the audit log.

**Architecture:** Two surgical fixes plus an audit-tagging extension. Client: extend `can()` in `app/src/lib/permissions.ts` so super-admin short-circuits to `true` for every workspace action. Server: replace inline `tenantCtx.role !== "admin"` checks with a `requireAdmin(tenantCtx)` helper that also accepts super-admins, and write an `actor_super_admin: true` field into the audit metadata on every such call.

**Tech Stack:** TypeScript, React, Bun, postgres.js. No new dependencies.

**Spec reference:** Section 3 of `docs/superpowers/specs/2026-06-13-settings-functionality-completeness-design.md`.

---

## File Structure

**Modified:**
- `app/src/lib/permissions.ts` — short-circuit on `t.isSuperAdmin`
- `server/src/server.ts` — replace inline role checks at lines 418, 426, 463, 475, 492, 499 with `requireAdmin(tenantCtx)`
- `server/src/auth.ts` — add `requireAdmin(ctx)` helper + audit-tagging helper

**Created:**
- `app/src/lib/permissions.test.ts` — Vitest spec for `can()`
- `server/src/auth.test.ts` — Bun test for `requireAdmin` (extend if file exists)
- `app/src/components/SuperAdminBanner.tsx` — banner shown in non-member workspace
- `app/src/routes/settings/Members.tsx` — embed the banner (modify, ~5 lines)

---

## Task 1: Failing test for `can()` super-admin elevation

**Files:**
- Create: `app/src/lib/permissions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/src/lib/permissions.test.ts
import { describe, expect, it } from "vitest";
import { can, type Action } from "./permissions";
import type { TenantContextValue } from "./tenant-context";

function ctx(role: "admin" | "editor" | "viewer", isSuperAdmin = false): TenantContextValue {
  return { id: "t1", slug: "t1", label: "T1", role, isSuperAdmin };
}

const EDIT_ACTIONS: Action[] = [
  "settings.general.edit",
  "settings.members.edit",
  "settings.tokens.edit",
  "settings.tokens.view",
  "settings.scans.edit",
  "settings.matching.edit",
  "settings.danger.delete",
];

describe("can()", () => {
  it("super-admin viewer can perform every workspace edit action", () => {
    const t = ctx("viewer", true);
    for (const a of EDIT_ACTIONS) {
      expect(can(t, a), `super-admin should be able to ${a}`).toBe(true);
    }
  });

  it("super-admin editor can perform admin-only edits", () => {
    const t = ctx("editor", true);
    expect(can(t, "settings.general.edit")).toBe(true);
    expect(can(t, "settings.members.edit")).toBe(true);
    expect(can(t, "settings.danger.delete")).toBe(true);
  });

  it("non-super-admin viewer cannot perform edit actions", () => {
    const t = ctx("viewer", false);
    for (const a of EDIT_ACTIONS) {
      expect(can(t, a), `viewer should not be able to ${a}`).toBe(false);
    }
  });

  it("admin role still grants admin actions without super-admin flag", () => {
    const t = ctx("admin", false);
    expect(can(t, "settings.general.edit")).toBe(true);
    expect(can(t, "settings.danger.delete")).toBe(true);
  });

  it("admin.view requires the super-admin flag", () => {
    expect(can(ctx("admin", false), "admin.view")).toBe(false);
    expect(can(ctx("viewer", true), "admin.view")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bun run test src/lib/permissions.test.ts`
Expected: FAIL — "super-admin should be able to settings.general.edit" assertion fails (current code only checks `t.role === "admin"`).

If `bun run test` is missing, run: `cd app && bunx vitest run src/lib/permissions.test.ts`.

---

## Task 2: Implement super-admin short-circuit in `can()`

**Files:**
- Modify: `app/src/lib/permissions.ts`

- [ ] **Step 1: Edit `can()` to short-circuit on super-admin**

Replace the body of `can()` with:

```ts
export function can(t: TenantContextValue, action: Action): boolean {
  // Super-admin gets every workspace + account affordance. The /admin shell
  // is still gated by isSuperAdmin via the "admin.view" action below — we
  // reach this branch only for non-admin actions.
  if (t.isSuperAdmin && action !== "admin.view") return true;

  switch (action) {
    case "account.profile.edit":
    case "settings.danger.leave":
      return true;

    case "settings.general.view":
    case "settings.members.view":
    case "settings.scans.view":
    case "settings.matching.view":
    case "settings.warehouse.view":
    case "settings.audit.view":
      return true;

    case "settings.tokens.view":
      return t.role === "editor" || t.role === "admin";

    case "settings.scans.edit":
    case "settings.matching.edit":
      return t.role === "editor" || t.role === "admin";

    case "settings.general.edit":
    case "settings.members.edit":
    case "settings.tokens.edit":
    case "settings.danger.delete":
      return t.role === "admin";

    case "admin.view":
      return t.isSuperAdmin;
  }
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd app && bunx vitest run src/lib/permissions.test.ts`
Expected: PASS for all 5 cases.

- [ ] **Step 3: Run client typecheck**

Run: `cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug-settings-polish
git add app/src/lib/permissions.ts app/src/lib/permissions.test.ts
git commit -m "fix(permissions): honor isSuperAdmin in can() per IA spec"
```

---

## Task 3: Server-side `requireAdmin` helper

**Files:**
- Modify: `server/src/auth.ts` (add helper)
- Create or extend: `server/src/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/auth.test.ts` (create if missing — use Bun's built-in test runner):

```ts
// server/src/auth.test.ts
import { describe, it, expect } from "bun:test";
import { requireAdmin, type TenantAuthContext } from "./auth.ts";

function ctx(role: "admin" | "editor" | "viewer", isSuperAdmin = false): TenantAuthContext {
  return { tenantId: "t1", role, isSuperAdmin };
}

describe("requireAdmin", () => {
  it("admin role passes", () => {
    expect(requireAdmin(ctx("admin"))).toEqual({ ok: true, elevated: false });
  });
  it("super-admin viewer passes with elevated flag", () => {
    expect(requireAdmin(ctx("viewer", true))).toEqual({ ok: true, elevated: true });
  });
  it("super-admin admin passes with elevated=false (already admin)", () => {
    expect(requireAdmin(ctx("admin", true))).toEqual({ ok: true, elevated: false });
  });
  it("non-admin non-super-admin fails", () => {
    expect(requireAdmin(ctx("editor"))).toEqual({ ok: false });
    expect(requireAdmin(ctx("viewer"))).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && bun test src/auth.test.ts`
Expected: FAIL — `requireAdmin` not exported.

- [ ] **Step 3: Implement the helper in `server/src/auth.ts`**

Append at the bottom of `server/src/auth.ts`:

```ts
export interface TenantAuthContext {
  tenantId: string;
  role: "admin" | "editor" | "viewer";
  isSuperAdmin: boolean;
}

/**
 * Authorization check for workspace-admin mutations.
 * Super-admin entering a workspace as a non-admin member is elevated to admin.
 * Returns { ok, elevated } so callers can tag the audit log.
 */
export function requireAdmin(
  ctx: TenantAuthContext,
): { ok: true; elevated: boolean } | { ok: false } {
  if (ctx.role === "admin") return { ok: true, elevated: false };
  if (ctx.isSuperAdmin) return { ok: true, elevated: true };
  return { ok: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && bun test src/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Run server typecheck**

Run: `cd server && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/auth.ts server/src/auth.test.ts
git commit -m "feat(auth): requireAdmin helper accepts super-admin elevation"
```

---

## Task 4: Wire `requireAdmin` into every workspace-admin endpoint

**Files:**
- Modify: `server/src/server.ts` lines 418, 426, 463, 475, 492, 499

Each occurrence today reads:

```ts
if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
```

- [ ] **Step 1: Add the import at the top of `server/src/server.ts`**

In the existing import block from `./auth.ts`, add `requireAdmin`. Locate the line near the top:

```ts
import { ... } from "./auth.ts";
```

and ensure `requireAdmin` is included.

- [ ] **Step 2: Replace each inline check (6 sites)**

For each line listed (418, 426, 463, 475, 492, 499), replace:

```ts
if (tenantCtx.role !== "admin") return json({ error: "forbidden" }, 403);
```

with:

```ts
const gate = requireAdmin(tenantCtx);
if (!gate.ok) return json({ error: "forbidden" }, 403);
```

Then capture `gate.elevated` for use in Task 5 (audit tagging). For now, leave a `// elevated audit tag in next task` comment after each.

- [ ] **Step 3: Run server typecheck**

Run: `cd server && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Smoke test by curling each endpoint**

This is optional but reassuring. Start the server (`cd server && bun run start`) and verify the 403 response shape didn't change for a non-admin viewer:

```bash
curl -s -i -X PATCH http://localhost:8787/api/t/default \
  -H 'Cookie: session=<viewer-session>' \
  -H 'content-type: application/json' \
  -d '{"label":"X"}'
```

Expected: `HTTP/1.1 403` with body `{"error":"forbidden"}`.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts
git commit -m "refactor(server): use requireAdmin at workspace-admin endpoints"
```

---

## Task 5: Audit-tag elevated actions

**Files:**
- Modify: `server/src/server.ts` — at each of the 6 endpoints, pass `elevated` into the audit-write call
- Modify: any audit-writer helper that mutations use (search `audit` writes; typically a `writeAudit` or inline `INSERT INTO audit_log` shape)

- [ ] **Step 1: Locate the audit-write shape**

Run: `cd server && grep -rn 'audit' src/ | grep -i 'insert\|write\|log' | head -20`
Identify the writer used by tenant-admin mutations (likely in `tenant.ts` or `repo-shared.ts`). Read the writer's signature.

- [ ] **Step 2: Extend audit metadata**

Whichever writer is in use, ensure it accepts `metadata: Record<string, unknown>` (or whatever the existing column is named — likely `metadata jsonb`). Most paths probably already pass a metadata object. If not, extend the writer signature.

Pattern, at each of the 6 endpoints in `server.ts`:

```ts
const gate = requireAdmin(tenantCtx);
if (!gate.ok) return json({ error: "forbidden" }, 403);
const actorMeta = { actor_super_admin: gate.elevated };
// pass actorMeta into the audit-write call below
```

If a given endpoint currently has no audit write, add one — workspace-label rename, member invite, member remove, role change, token create/revoke are all auditable. Use the same `tenant.ts` or `repo-shared.ts` writer that other endpoints use.

- [ ] **Step 3: Add a test for elevated tagging**

Append to `server/src/auth.test.ts`:

```ts
it("requireAdmin elevation flag matches expected actor_super_admin tag", () => {
  expect(requireAdmin(ctx("viewer", true)).ok && requireAdmin(ctx("viewer", true)).elevated).toBe(true);
  expect(requireAdmin(ctx("admin", false)).ok && !requireAdmin(ctx("admin", false)).elevated).toBe(true);
});
```

This is a small redundant check, but the actual integration test is harder to write without a full test harness — leave a TODO ONLY IF the project lacks an integration harness today. Otherwise, write an integration test that POSTs as super-admin viewer, then queries the audit log and asserts `actor_super_admin === true`.

- [ ] **Step 4: Run tests**

Run: `cd server && bun test src/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/src/auth.test.ts
git commit -m "feat(audit): tag elevated super-admin mutations with actor_super_admin"
```

---

## Task 6: Audit filter chip in Admin → Audit

**Files:**
- Modify: `app/src/routes/admin/Audit.tsx`

- [ ] **Step 1: Read the current Audit.tsx**

Open the file. Identify how filters are rendered and applied (in-memory filter on the fetched list vs server-side query param).

- [ ] **Step 2: Add the chip**

Add a chip alongside any existing filter chips, labeled **"Super-admin actions"**. When active, filter rows where `metadata?.actor_super_admin === true`.

Minimal pattern (adapt to existing markup):

```tsx
const [onlyElevated, setOnlyElevated] = useState(false);
const filtered = onlyElevated
  ? rows.filter((r) => (r.metadata as { actor_super_admin?: boolean } | null)?.actor_super_admin === true)
  : rows;

// in the filter bar:
<button
  type="button"
  data-active={onlyElevated}
  onClick={() => setOnlyElevated((v) => !v)}
  className="..."
>
  Super-admin actions
</button>
```

- [ ] **Step 3: Manual verify**

Start app + server. Sign in as super-admin who is NOT a member of `default`. Rename `default` from Workspace Settings → General. Open Admin → Audit. Confirm:
- The rename row exists.
- It carries `actor_super_admin: true` in its metadata.
- The "Super-admin actions" chip filters down to just this row.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/admin/Audit.tsx
git commit -m "feat(admin): add Super-admin actions filter to audit log"
```

---

## Task 7: Members banner for non-member super-admins

**Files:**
- Create: `app/src/components/SuperAdminBanner.tsx`
- Modify: `app/src/routes/settings/Members.tsx`

- [ ] **Step 1: Create the banner component**

```tsx
// app/src/components/SuperAdminBanner.tsx
import type { ReactNode } from "react";

export function SuperAdminBanner({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700">
      {children}
    </div>
  );
}
```

(Adjust color tokens to match existing amber treatment used elsewhere in the admin shell — see `routes/admin/*` for the standard amber.)

- [ ] **Step 2: Wire into Members.tsx**

In `Members.tsx`, near the top of the page render:

```tsx
import { SuperAdminBanner } from "../../components/SuperAdminBanner";
// ...
const tenant = useTenant();
const memberships = useStore((s) => s.memberships); // adapt to actual selector
const isMember = memberships.some((m) => m.slug === tenant.slug);

// in JSX, immediately inside the page wrapper:
{tenant.isSuperAdmin && !isMember && (
  <SuperAdminBanner>
    You're viewing this workspace as a super-admin. You can manage members but aren't a member yourself.
  </SuperAdminBanner>
)}
```

If `memberships` isn't already in the store, fall back to `boot.memberships` passed via TenantLayout (read from existing layout-level prop chain).

- [ ] **Step 3: Manual verify**

Sign in as super-admin who is not a member of `default`. Visit `/app/default/settings/members`. The banner should appear. Sign in as super-admin who IS a member of `default`. Banner should be absent.

- [ ] **Step 4: Run client typecheck**

Run: `cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/SuperAdminBanner.tsx app/src/routes/settings/Members.tsx
git commit -m "feat(members): banner for super-admins viewing non-member workspace"
```

---

## Task 8: End-to-end smoke test

- [ ] **Step 1: Start the stack**

In two terminals:
- `cd server && bun run start`
- `cd app && bun run dev`

- [ ] **Step 2: Reproduce the original symptoms**

Sign in as a super-admin. Visit a workspace where the super-admin is NOT a member (or join one as `viewer` for an even stronger test). For each, verify the previously hidden actions are now visible AND functional:

- [ ] Workspace Settings → General → rename input is editable and save persists.
- [ ] Workspace Settings → Members → "Invite" input is visible; "Remove" buttons render on hover.
- [ ] Workspace Settings → Warehouse → Tokens → "Create token" is visible.
- [ ] Workspace Settings → Danger → "Delete workspace" button is visible (and refuses on the `default` slug with friendly text).
- [ ] WorkspaceSwitcher dropdown shows "Workspace settings" entry for this workspace.

- [ ] **Step 3: Verify audit trail**

After the rename in step 2, Admin → Audit shows the row, with `actor_super_admin: true` (visible via "Super-admin actions" chip).

- [ ] **Step 4: Commit the verification log**

No commit needed unless edits surfaced from the smoke test.

---

## Self-review checklist

After completing Task 8:

- [ ] Spec Section A.1 covered → Task 2.
- [ ] Spec Section A.2 covered → Tasks 3, 4.
- [ ] Spec Section A.3 covered → Tasks 5, 6.
- [ ] Spec Section A.4 covered → Task 7.
- [ ] Spec Section A.5 covered → Tasks 1, 3, 8.
- [ ] No `t.role === "admin"` literal remaining as the sole gate on a workspace mutation in either client or server (grep both trees).
- [ ] `grep -n 'actor_super_admin' server/src` shows the tag is written at every elevated mutation.

If any unchecked, return to the corresponding task.
