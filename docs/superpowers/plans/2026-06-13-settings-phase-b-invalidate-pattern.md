# Settings — Phase B: invalidate() + per-page wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After any Settings save, every downstream UI surface (nav, headers, switchers, listings) reflects the change without reload, within 500ms.

**Architecture:** Add a single `invalidate` object to `app/src/store.ts` that exposes named refetch entry points. Extend `useAutosave` with an `onSaved` callback. Wire every save in Settings / Account / Admin to call the matching invalidator. Two store-init effects refresh `TenantProvider` and `WorkspaceSwitcher` from the live memberships slice.

**Tech Stack:** React, Zustand-style store (existing `app/src/store.ts`), fetch. No new dependencies.

**Spec reference:** Section 4 of `docs/superpowers/specs/2026-06-13-settings-functionality-completeness-design.md`.

---

## File Structure

**Modified:**
- `app/src/store.ts` — add `invalidate` object + missing refetchers
- `app/src/hooks/useAutosave.ts` — add `onSaved` callback
- `app/src/components/TenantLayout.tsx` — re-derive context when memberships change
- `app/src/components/WorkspaceSwitcher.tsx` — subscribe to memberships slice
- ~12 Settings / Account / Admin pages — call `invalidate.X()` in save handlers (one task per page)

**Created:**
- `app/src/store-invalidate.test.ts` — smoke test for each entry on `invalidate`

---

## Task 1: Inventory current refetchers and add missing ones

**Files:**
- Read: `app/src/store.ts` (1134 lines — identify existing fetchers)

- [ ] **Step 1: Map the existing fetchers**

Run: `grep -n 'fetch\|GET /api' app/src/store.ts`. Record which entities already have a refetcher: `currentUser`, `tenant`, `memberships`, `members`, `tokens`, `scans` (preferences), `audit`, `warehouses` (admin), `tenants` (admin).

For any entity in the spec's invalidation inventory (Section 4.3 of the spec) without an existing refetcher, add one. Most should already exist as part of `initStore()`.

- [ ] **Step 2: Add `refetchCurrentUser()` if missing**

If not present, add at module scope:

```ts
async function refetchCurrentUser() {
  const r = await fetch("/api/auth/me", { credentials: "include" });
  if (!r.ok) return;
  const me = await r.json();
  setStore({ currentUserFull: me }); // adapt to actual store setter API
}
```

Apply the same pattern (one helper per entity) for any missing ones from the inventory.

- [ ] **Step 3: Commit if helpers were added**

```bash
git add app/src/store.ts
git commit -m "feat(store): add missing entity refetchers ahead of invalidate()"
```

---

## Task 2: Failing test for `invalidate`

**Files:**
- Create: `app/src/store-invalidate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { invalidate } from "./store";

describe("invalidate", () => {
  it("exposes the expected entries", () => {
    expect(typeof invalidate.currentUser).toBe("function");
    expect(typeof invalidate.tenant).toBe("function");
    expect(typeof invalidate.memberships).toBe("function");
    expect(typeof invalidate.members).toBe("function");
    expect(typeof invalidate.tokens).toBe("function");
    expect(typeof invalidate.scans).toBe("function");
    expect(typeof invalidate.audit).toBe("function");
    expect(typeof invalidate.warehouses).toBe("function");
    expect(typeof invalidate.tenantList).toBe("function");
    expect(typeof invalidate.adminUsers).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bunx vitest run src/store-invalidate.test.ts`
Expected: FAIL — `invalidate` is undefined.

---

## Task 3: Implement and export `invalidate`

**Files:**
- Modify: `app/src/store.ts`

- [ ] **Step 1: Append the `invalidate` object**

At the bottom of `store.ts`:

```ts
export const invalidate = {
  currentUser: () => refetchCurrentUser(),
  tenant:      (slug: string) => refetchTenant(slug),
  memberships: () => refetchMemberships(),
  members:     (slug: string) => refetchMembers(slug),
  tokens:      (slug: string) => refetchTokens(slug),
  scans:       (slug: string) => refetchPreferences(slug),
  audit:       (slug?: string) => refetchAudit(slug),
  warehouses:  () => refetchWarehouseList(),
  tenantList:  () => refetchAdminTenants(),
  adminUsers:  () => refetchAdminUsers(),
};
```

Each referenced refetcher must exist. If a refetcher takes no slug (e.g. `refetchMemberships`), make the `invalidate` wrapper match. The exact names should match what Task 1 confirmed or added.

- [ ] **Step 2: Run test to verify it passes**

Run: `cd app && bunx vitest run src/store-invalidate.test.ts`
Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/store.ts app/src/store-invalidate.test.ts
git commit -m "feat(store): export invalidate() for post-save refetches"
```

---

## Task 4: Extend `useAutosave` with `onSaved`

**Files:**
- Modify: `app/src/hooks/useAutosave.ts`

- [ ] **Step 1: Read current hook**

Open the file. It's 35 lines. Identify the save success branch.

- [ ] **Step 2: Add the optional callback**

Extend the options type to include `onSaved?: () => void | Promise<void>`. After a successful save, call `await opts.onSaved?.()`. Make sure errors in `onSaved` log to console and don't roll back the save status pill.

- [ ] **Step 3: Add a small test**

```ts
// app/src/hooks/useAutosave.test.ts
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react"; // confirm available; else use a Vitest pattern that exercises the hook
import { useAutosave } from "./useAutosave";

describe("useAutosave", () => {
  it("calls onSaved after a successful save", async () => {
    const onSaved = vi.fn();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave({ value: "x", save, onSaved, debounceMs: 0 }));
    await act(async () => { await result.current.flush?.(); });
    expect(save).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });
});
```

If `@testing-library/react` isn't already a dep, skip the unit test and rely on the integration verification in later tasks. Note the gap in the commit message.

- [ ] **Step 4: Typecheck + commit**

```bash
cd app && bun run typecheck
git add app/src/hooks/useAutosave.ts app/src/hooks/useAutosave.test.ts 2>/dev/null
git commit -m "feat(hooks): useAutosave onSaved callback for invalidation"
```

---

## Task 5: Account → Profile name save invalidates currentUser

**Files:**
- Modify: `app/src/routes/account/Profile.tsx`

- [ ] **Step 1: Locate the autosave call for `name`**

Open `Profile.tsx`. Find the `useAutosave({ … })` invocation that PATCHes `/api/auth/me`.

- [ ] **Step 2: Add `onSaved: () => invalidate.currentUser()`**

```tsx
import { invalidate } from "../../store";
// ...
useAutosave({
  value: name,
  save: (v) => api.patchAuthMe({ name: v }),
  onSaved: () => invalidate.currentUser(),
});
```

- [ ] **Step 3: Manual verify**

Start app + server. In Account → Profile, change your name. Within ~500ms, the user-menu (WorkspaceSwitcher header), any other surface that renders `currentUserFull.name`, and the field on reload all reflect the new value.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/account/Profile.tsx
git commit -m "fix(account): name autosave refreshes currentUserFull"
```

---

## Task 6: Settings → General label save invalidates tenant + memberships

**Files:**
- Modify: `app/src/routes/settings/General.tsx`

- [ ] **Step 1: Add the invalidation**

```tsx
import { invalidate } from "../../store";
import { useTenant } from "../../lib/tenant-context";
// ...
const tenant = useTenant();
useAutosave({
  value: label,
  save: (v) => api.patchTenant(tenant.slug, { label: v }),
  onSaved: () => {
    invalidate.tenant(tenant.slug);
    invalidate.memberships();
  },
});
```

- [ ] **Step 2: Manual verify**

Rename a workspace from Settings → General. Within 500ms: WorkspaceSwitcher trigger label updates, page header updates, the workspace dropdown row updates. No reload required.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/General.tsx
git commit -m "fix(settings): label rename refreshes tenant + memberships"
```

---

## Task 7: TenantProvider re-derives from live memberships

**Files:**
- Modify: `app/src/components/TenantLayout.tsx`

- [ ] **Step 1: Read current TenantLayout**

The current shape (lines 14–58) reads `memberships` as a prop. After Phase A and Task 6, the membership label can change at runtime, but `TenantProvider`'s `value` only re-memos on prop changes — and the prop comes from `boot.memberships` (mounted once).

- [ ] **Step 2: Subscribe to the memberships store slice**

Change `TenantLayout` to read memberships from the store, not from the prop:

```tsx
import { useStore } from "../store"; // adapt to actual hook
// ...
const memberships = useStore((s) => s.memberships); // adapt selector
// (remove the `memberships` prop or leave it as initial value)
```

Ensure `main.tsx` seeds the store with `boot.memberships` at mount so the first render is correct. (Add a `setMemberships(boot.memberships)` call inside an effect, before children render.)

The `useMemo` keyed on `tenantSlug, m, isSuperAdmin` will re-compute when memberships change (since `m` reads from the store).

- [ ] **Step 3: Manual verify**

After Task 6's rename, the page header in `SettingsLayout` shows the new label without reload (it reads from `useTenant()`).

- [ ] **Step 4: Commit**

```bash
git add app/src/components/TenantLayout.tsx app/src/main.tsx
git commit -m "fix(layout): TenantProvider tracks live memberships slice"
```

---

## Task 8: WorkspaceSwitcher subscribes to memberships slice

**Files:**
- Modify: `app/src/components/WorkspaceSwitcher.tsx`

- [ ] **Step 1: Inspect current data source**

Find where the dropdown's membership list comes from. If it accepts a prop, switch to the store subscription so it updates after `invalidate.memberships()`.

- [ ] **Step 2: Wire the subscription**

```tsx
import { useStore } from "../store";
const memberships = useStore((s) => s.memberships);
// remove prop, render from `memberships`
```

- [ ] **Step 3: Manual verify**

Rename a workspace (Task 6) — the WorkspaceSwitcher dropdown row updates. Delete a workspace (later in this plan) — the row disappears. No reload.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/WorkspaceSwitcher.tsx
git commit -m "fix(switcher): subscribe to memberships slice"
```

---

## Task 9: Members → invite/remove/role invalidates members(slug)

**Files:**
- Modify: `app/src/routes/settings/Members.tsx`

- [ ] **Step 1: Add invalidation on each mutation success**

For each handler (`onInvite`, `onRemove`, `onRoleChange`), call `invalidate.members(tenant.slug)` after the API call resolves. If pending invites have a separate refetcher, also call that.

- [ ] **Step 2: Manual verify**

Invite a user → invite list refreshes immediately. Remove a user → row disappears. Change a role → badge updates. No reload.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/Members.tsx
git commit -m "fix(members): post-mutation refetch via invalidate.members"
```

---

## Task 10: Settings → Matching threshold saves invalidate tenant

**Files:**
- Modify: `app/src/routes/settings/Matching.tsx`

- [ ] **Step 1: Wire `onSaved: () => invalidate.tenant(tenant.slug)` on every threshold/toggle autosave**

- [ ] **Step 2: Manual verify**

Change a threshold. Reload the page → value sticks. Open another tab with the same workspace → value is consistent. (Cross-tab consistency relies on the next tab refetching at mount; tab-to-tab live sync is not part of this phase.)

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/Matching.tsx
git commit -m "fix(matching): autosave refreshes tenant slice"
```

---

## Task 11: Warehouse → Scans schedule save invalidates scans(slug)

**Files:**
- Modify: `app/src/routes/settings/Warehouse.tsx` (Scans section) or `app/src/routes/settings/Scans.tsx` if not yet collapsed per the 06-13 polish spec

- [ ] **Step 1: Wire `onSaved: () => invalidate.scans(tenant.slug)`**

- [ ] **Step 2: Manual verify**

Change scan schedule. Reload → sticks. Trigger a manual scan — progress feedback is unchanged (covered by the 06-13 polish spec).

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/Warehouse.tsx app/src/routes/settings/Scans.tsx 2>/dev/null
git commit -m "fix(scans): autosave refreshes scans slice"
```

---

## Task 12: Warehouse → Tokens create/revoke invalidates tokens(slug)

**Files:**
- Modify: `app/src/routes/settings/Warehouse.tsx` Tokens section (or `Tokens.tsx` if separate)

- [ ] **Step 1: After successful create / revoke, call `invalidate.tokens(tenant.slug)`**

- [ ] **Step 2: Manual verify**

Create a token → list updates with the new row. Revoke → row disappears. No reload.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/Warehouse.tsx app/src/routes/settings/Tokens.tsx 2>/dev/null
git commit -m "fix(tokens): post-mutation refetch via invalidate.tokens"
```

---

## Task 13: Danger → delete invalidates memberships + tenantList and redirects

**Files:**
- Modify: `app/src/routes/settings/Danger.tsx`

- [ ] **Step 1: In the delete success branch**

```tsx
await api.deleteTenant(tenant.slug);
await invalidate.memberships();
await invalidate.tenantList();
const next = useStore.getState().memberships[0]?.slug;
navigate(next ? `/app/${next}` : "/app/admin");
```

- [ ] **Step 2: Manual verify**

As super-admin with multiple workspaces: delete a non-default workspace. The current view exits, the WorkspaceSwitcher dropdown shows one fewer row, the Admin → Workspaces list (if open) shows one fewer.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/Danger.tsx
git commit -m "fix(danger): delete refreshes memberships + tenant list, navigates to next"
```

---

## Task 14: Admin → Workspaces create/teardown invalidates tenantList

**Files:**
- Modify: `app/src/routes/admin/Workspaces.tsx`

- [ ] **Step 1: On create + on teardown success, call `invalidate.tenantList()` + `invalidate.memberships()`**

`memberships` because creating a workspace auto-joins the super-admin (verify; if not, skip the second call).

- [ ] **Step 2: Manual verify**

Create a workspace from Admin → Workspaces. Row appears in the table. WorkspaceSwitcher dropdown shows the new row (if auto-membership applies).

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/admin/Workspaces.tsx
git commit -m "fix(admin): workspace mutations refresh tenant list + memberships"
```

---

## Task 15: Admin → Users promote/demote invalidates adminUsers

**Files:**
- Modify: `app/src/routes/admin/Users.tsx`

- [ ] **Step 1: After PATCH succeeds, call `invalidate.adminUsers()`**

- [ ] **Step 2: Manual verify**

Promote a user to super-admin from Admin → Users. The badge updates immediately. Demote — same.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/admin/Users.tsx
git commit -m "fix(admin): user promote/demote refreshes list"
```

---

## Task 16: End-to-end smoke test

- [ ] **Step 1: Start the stack** (`cd server && bun run start`; `cd app && bun run dev`)

- [ ] **Step 2: Run the full save-reflect matrix**

For each row in Section 4.3 of the spec, perform the save and observe that the listed downstream surface updates without reload, within 500ms:

- [ ] Profile name → user-menu name
- [ ] Appearance theme → next page render uses new theme
- [ ] Memberships leave → row disappears
- [ ] General label → switcher + header
- [ ] Members invite → list
- [ ] Members remove → list
- [ ] Members role change → badge
- [ ] Matching threshold → reload shows persisted value
- [ ] Warehouse → Scans schedule → reload shows persisted value
- [ ] Warehouse → Tokens create / revoke → list
- [ ] Danger delete → switcher + admin table
- [ ] Admin Workspaces create → table + switcher (if auto-membership)
- [ ] Admin Users promote/demote → row badge

- [ ] **Step 3: Confirm no reload was required for any of the above.** Document any exception in a follow-up issue.

---

## Self-review checklist

- [ ] Spec Section 4.1 (pattern) → Tasks 2, 3, 4.
- [ ] Spec Section 4.3 (per-page inventory, 13 rows) → Tasks 5–15. Every row mapped.
- [ ] Spec Section 4.4 (stale paths) → Tasks 7, 8.
- [ ] No remaining `useAutosave` call in Settings / Account / Admin that lacks an `onSaved` invalidation, unless the field has no downstream surface (grep `useAutosave` and audit each hit).
