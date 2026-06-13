# Settings functionality completeness

**Status:** Design approved 2026-06-13.
**Owner:** Frederik
**Branch:** `settings-polish` (worktree at `../zugzug-settings-polish`, off `main`)
**Builds on:** [2026-06-12 Settings IA redesign](./2026-06-12-settings-ia-redesign.md) (IA + role model settled) and [2026-06-13 Admin polish audit](./2026-06-13-admin-polish-audit-design.md) (visual/UX polish in flight).
**Sister spec:** This is the **functional layer** beneath the polish layer. Polish makes the surfaces feel premium; this spec makes them actually do what they look like they do.

---

## 1. Motivation

A hands-on review of Settings / Account / Admin found that most reported "I can't do X" complaints are not missing endpoints — the endpoints exist and work. They are:

1. **Permission implementation drift.** The 06-12 IA spec states super-admin "gets `admin` UI affordances client-side; server enforces independently." `app/src/lib/permissions.ts` does not honor that — super-admin shows ✗ for most workspace-edit actions. Result: a super-admin who is not also a workspace `admin` cannot see the add-member, rename-workspace, delete-workspace, or warehouse-edit buttons. The reported "can't find the button" cluster is one bug.
2. **No cache invalidation after save.** `useAutosave` writes through but never tells higher-level stores. The displayed name in Account/Profile updates locally but `currentUserFull` in `store.ts` stays stale; same for workspace label in `TenantProvider`. Save "succeeds" but the UI lies about the post-save state until reload.
3. **One genuinely missing feature.** No UI to create a new MotherDuck database from the app. Admin → Warehouses lists existing databases but cannot create one. Users who want a fresh warehouse for a new workspace have to drop to a DuckDB shell.

These three classes account for every gap the reviewer found. None require new architecture. None require re-litigating IA or roles.

## 2. Non-goals

- **No IA changes.** Three-surface split, route layout, and sidebar structure stay as in 06-12 / 06-13.
- **No visual / component redesign.** Skeletons, PageHeader, EmptyState, toast voice, icon swap — all owned by the 06-13 polish audit. This spec writes against the existing component surface.
- **No new permission tier.** Four-tier model from 06-12 stands; we are fixing its implementation, not extending it.
- **No multi-tenant warehouses.** "Register a different MotherDuck token" is out of scope (separate spec if it ever lands).
- **No account email / password / delete-account.** Touches auth and ToS — separate spec.
- **No workspace ownership transfer.** Separate spec.

## 3. Section A — Super-admin acts as workspace admin

### A.1 Client

`app/src/lib/permissions.ts` `can(tenant, action)` short-circuits to `true` when `tenant.isSuperAdmin === true` for every `settings.*` and `account.*` action. The matrix in the 06-12 spec is the contract; this change makes the implementation honor it.

Affected call sites (verify, no edits needed if `can()` is the only entry point):
- `RoleGate`, `ReadOnly` wrappers (auto-fixed via `can()`)
- `SettingsSidebar` filter (auto-fixed)
- `Members.tsx` Remove / Revoke / Invite (auto-fixed via `isAdmin = can(t, "settings.members.edit")`)
- `General.tsx` rename input disabled-state (auto-fixed)
- `Danger.tsx` Delete button inside `RoleGate` (auto-fixed)
- `WorkspaceSwitcher.tsx:107` "Workspace settings" entry (auto-fixed)

### A.2 Server

Server-side guards already accept super-admin in most places (e.g. `tenant.ts` membership check). Audit pass: for every `server.ts` endpoint that today requires `role === "admin"` on the tenant, accept `users.is_super_admin === true` as equivalent. Specifically verify:
- `PATCH /api/t/:slug` (rename) — `server.ts:416`
- `DELETE /api/t/:slug` (delete) — `server.ts:424`
- `POST /api/t/:slug/team/invites` — `server.ts:490`
- `DELETE /api/t/:slug/team/members/:userId` — `server.ts:473`
- `PUT /api/t/:slug/team/members/:userId/role` — `server.ts:461`
- `POST /api/tokens` / `DELETE /api/tokens/:id`
- `PUT /api/preferences` (scans)

Centralize the check: introduce `requireAdmin(req, slug)` helper in `server/src/auth.ts` that returns the role-or-super-admin verdict. Every endpoint listed above calls it; no inline copies.

### A.3 Audit trail

Each elevated action writes one audit-log row tagged `actor_super_admin: true` (extend the existing audit shape). The Admin → Audit view (`routes/admin/Audit.tsx`) gains a "Super-admin actions" filter chip that selects these rows. No new schema column needed — encode in the existing `metadata` JSON.

### A.4 Membership list display

Super-admin viewing `Members.tsx` for a workspace they aren't a member of: don't fake-stamp them into the member list. The list reflects actual `tenant_member` rows. Add a small banner above the list when `isSuperAdmin && !isMember`:
> *"You're viewing this workspace as a super-admin. You can manage members but aren't a member yourself."*

### A.5 Tests

Server: `auth.test.ts` adds cases for every `requireAdmin`-protected endpoint with a super-admin who is not a member — must succeed. Client: visual regression / Playwright (if any) for `Members.tsx` and `Danger.tsx` showing the action buttons under super-admin.

---

## 4. Section B — Post-save state reflects immediately

### B.1 The pattern

Today: `useAutosave` PATCHes the server, sets local component state, and returns. The rest of the app reads from higher-level stores (`store.ts` `currentUserFull`, `TenantProvider` `tenant.label`, `memberships`). Those stores never learn the save happened.

New: a single `invalidate` object exported from `app/src/store.ts`:

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
};
```

Each refetch hits the existing GET endpoint and updates the matching store slice. The mutator signal is the only side-effect — subscribers re-render through normal store flow.

`useAutosave` gains an optional `onSaved` callback so the call site is one line:

```ts
useAutosave({ value, save: api.renameTenant, onSaved: () => invalidate.tenant(slug) });
```

### B.2 Why not React Query / SWR

Rejected. The store is small, the mutator count is bounded (~15 across all of Settings), and introducing a cache layer doubles the mental model for two months of churn while the rest of the app still uses the existing store. Targeted refetches are 5 lines apiece and explicit.

### B.3 Per-page wiring inventory

| Page | Save action | Invalidation |
|---|---|---|
| `account/Profile.tsx` | name | `invalidate.currentUser()` |
| `account/Appearance.tsx` | theme, engineer mode | `invalidate.currentUser()` (preferences live on user) |
| `account/Memberships.tsx` | leave workspace | `invalidate.memberships()` + redirect if current |
| `settings/General.tsx` | workspace label | `invalidate.tenant(slug)` + `invalidate.memberships()` (label shows in switcher) |
| `settings/Members.tsx` | invite / remove / role | `invalidate.members(slug)` |
| `settings/Matching.tsx` | thresholds | `invalidate.tenant(slug)` (config lives on tenant) |
| `settings/Warehouse.tsx` Scans | schedule, auto-publish | `invalidate.scans(slug)` |
| `settings/Warehouse.tsx` Tokens | create / revoke | `invalidate.tokens(slug)` |
| `settings/Danger.tsx` | delete workspace | `invalidate.memberships()` + `invalidate.tenantList()` + redirect to next workspace |
| `admin/Workspaces.tsx` | create / edit / teardown | `invalidate.tenantList()` |
| `admin/Users.tsx` | promote / demote | refetch admin users list (add `invalidate.adminUsers()`) |
| `admin/Warehouses.tsx` | + New database (Section C) | `invalidate.warehouses()` + `invalidate.tenantList()` (picker stale) |

### B.4 Stale checks

Two known stale paths beyond saves:
- **`TenantProvider` initialization** reads from `boot.memberships` at app mount. If memberships change mid-session (workspace renamed, joined, left, deleted), the tenant in URL must re-resolve. Add a `TenantProvider` effect that re-derives from the latest `memberships` slice on change.
- **`WorkspaceSwitcher`** dropdown caches the membership list at first paint. Subscribe to the `memberships` slice.

### B.5 Tests

Each invalidator gets one unit test (mock fetch, assert store slice updated). One integration test per Settings page: render → mutate → assert downstream UI updated without reload. Lean on existing test infra; don't add new harness.

---

## 5. Section C — "+ New database" on Admin → Warehouses

### C.1 Endpoint

`POST /api/admin/warehouses` body `{ name: string }`. Server-side:
1. Validate name: `/^[a-z][a-z0-9_]{2,62}$/`. Reject with 400 + remediation.
2. Check uniqueness against the live MotherDuck enumeration.
3. Run `CREATE DATABASE "<name>"` via the existing DuckDB connection (`server/src/db.ts`).
4. On `Permission denied` / `read_only` from MotherDuck, return 403 with body:
   > *"Your MotherDuck token has read-only scaling. Update `MOTHERDUCK_TOKEN` to a write-capable token or create the database manually in MotherDuck and refresh this list."*
5. On success, return the refreshed warehouse list (same shape as `GET /api/admin/warehouses`).

Audit: write one `admin.warehouse.create` row (super-admin only — enforced by existing `admin.view` gate).

### C.2 UI

`app/src/routes/admin/Warehouses.tsx`:
- "+ New database" button in the page header `actions` slot (the 06-13 polish spec extends `<PageHeader>` with this slot).
- Click opens a small dialog (`ConfirmDialog` extension or a one-off `Dialog`, reusing existing chrome).
- Form: single text input with inline validation (length, charset, uniqueness).
- Submit: POST → on success, `invalidate.warehouses()` + close dialog + toast "Database created."
- On 403 (token scaling), show the remediation message inline in the dialog, not as a toast. Include a link target to MotherDuck dashboard.

### C.3 Downstream

The Admin → Workspaces "+ Create workspace" picker (`WarehousePicker.tsx`) already refetches from `/api/admin/warehouses`. After Section C, hitting `invalidate.warehouses()` is enough to surface a freshly created database in that picker without reload.

### C.4 Deep-link discoverability

Workspace `settings/Warehouse.tsx` Connection section gains a small footer link (super-admin only):
> *"Need a fresh database? → Admin / Warehouses"*

Renders only when `tenant.isSuperAdmin`. No new route — deep-link to existing Admin page.

### C.5 Tests

Server: `admin.test.ts` — happy path, name validation rejection, read-only-token rejection, idempotency on duplicate name. Client: dialog form validation + success path + 403 surface.

---

## 6. Section D — Missing polish actions

These are small, per-page, additive. None require new architecture. Order is implementation order, not priority order.

### D.1 Account → Profile
- Name field reflects post-save (Section B handles).
- Show "Saved" indicator next to the field (matches Members reference quality bar from 06-13 spec).
- Email row gets a small disabled hint *"Email changes coming soon"*. No new route.

### D.2 Account → Memberships
- (New page exists per 06-13 spec.) Each row shows label + role + joined-at + Leave action.
- Leave action uses `ConfirmDialog` with confirm phrase = workspace slug for the user's last-admin case (server returns 409 `last_admin` → surface inline).

### D.3 Settings → General
- Rename reflects via `invalidate.tenant(slug)` (Section B).
- Slug change: **new action**, super-admin only. Adds endpoint `PATCH /api/t/:slug/slug` body `{ new_slug }`. Server validates: charset, uniqueness, refuses on `default`. On success, redirects all open sessions for this workspace via a presence broadcast (already in the WS protocol). UI deep-link rewrite is implicit because the URL changes; provide a one-line warning *"Renaming the slug changes the URL for everyone."*
- *(Defer if Phase 1 needs to land fast. Slug-change is the only D.3 item beyond Section B's wiring.)*

### D.4 Settings → Members
- Post-invite, pending-invites list refetches via `invalidate.members(slug)` (Section B).
- Role dropdown disabled for the workspace's last `admin` (matches server `last_admin` guard).
- (Visual / toast polish belongs to 06-13.)

### D.5 Settings → Matching
- Verify every threshold/toggle persists via `invalidate.tenant(slug)` (Section B).
- No new actions.

### D.6 Settings → Warehouse → Scans
- Schedule edit reflects via `invalidate.scans(slug)`.
- Manual scan trigger shows progress feedback (presence WS already broadcasts scan state — wire the existing event to a pill near the button).

### D.7 Settings → Warehouse → Tokens
- Create / revoke list refetches via `invalidate.tokens(slug)`.

### D.8 Settings → Danger
- Delete confirmation phrase matches workspace label (per 06-13 spec promotion of `ConfirmDialog.confirmPhrase`).
- *"Cannot delete default"* surfaces via inline disabled state with tooltip, not a click-and-fail toast.

### D.9 Admin → Workspaces
- **Edit workspace label**: missing today. Adds endpoint `PATCH /api/admin/tenants/:id` `{ label }`. Surface as inline edit on each row.
- Show member count + last-activity columns (server: extend `GET /api/admin/tenants` query). Both useful for the OSS launch story ("which workspaces are active?").

### D.10 Admin → Users
- Filter chips: "All", "Super-admins", "By workspace".
- Confirm dialog text on promote/demote includes the user's display name + email and the action *"grant super-admin powers"* in plain language.

### D.11 Admin → Audit
- Filter by event type (multi-select chips).
- Persist filters in URL (`?type=invite&tenant=sportsbook`).
- "Super-admin actions" chip (Section A.3).

### D.12 Admin → Warehouses
- "+ New database" (Section C).
- Each row shows which workspaces use the database (server: extend `GET /api/admin/warehouses` with usage count + sample tenant labels).

---

## 7. Implementation plan structure

Implementation happens via a separate `writing-plans` session per phase. Each phase is independently shippable and reviewable. Recommended order:

1. **Phase A — Super-admin elevation** (Section A). Single highest-impact change. Touches `permissions.ts`, `server.ts` guards, `auth.ts` `requireAdmin`. ~1 day. Unblocks every other "can't find the button" symptom.
2. **Phase B — `invalidate()` + per-page wiring** (Section B). Touches `store.ts`, `useAutosave`, and ~12 Settings pages. ~1.5 days. Self-contained, no API changes.
3. **Phase C — New-database flow** (Section C). Touches `server.ts`, `admin/Warehouses.tsx`, picker invalidation. ~0.5 day. Independent of A and B.
4. **Phase D — Polish actions** (Section D). Many small touches. Each subsection is its own commit. ~2 days. Depends on A (for the new admin actions) and B (for state reflection).
5. **Phase E — Admin workspace edit + columns** (D.9). Bigger than the rest of D — pulled out as its own phase. ~1 day.

Total: ~6 implementation days. Phases A, B, C can land in parallel by separate subagents. D and E depend on B.

## 8. Subagent fan-out

Each phase gets its own implementation plan via `writing-plans`, then its own subagent for the diff. For phases A–C this can happen in parallel — they touch disjoint files. D and E run after.

The brainstorming → plan → execute loop:
1. This spec (done).
2. `writing-plans` → 5 plan files in `docs/superpowers/plans/2026-06-13-settings-functionality-*/`.
3. Per-phase: one subagent executes, one verifies (`verification-before-completion`), one reviews (`requesting-code-review`).

## 9. Success criteria

- A super-admin who is not a member of a workspace can rename it, add/remove members, manage tokens, edit scans, and delete it from the workspace Settings UI.
- Changing the display name in Account → Profile updates the user-menu name and any other display of that name within 500ms, without reload.
- Renaming a workspace updates the WorkspaceSwitcher label, the page header, and the workspace nav within 500ms, without reload.
- Admin → Warehouses has a "+ New database" button. Clicking it and supplying a valid name creates a MotherDuck database and the database appears in the Workspaces create-workspace picker within the same session.
- The Admin audit log records every super-admin action with an `actor_super_admin: true` tag, filterable via a dedicated chip.
- Every Settings page passes a save → reflect → no-reload check for at least one mutation.

## 10. Open questions

1. **`requireAdmin` audit row noise.** Every elevated action writes one audit row. For high-frequency mutations (token revocations during a credential rotation), is that volume acceptable? Lean: yes — these are rare actions and the audit story is one of the OSS launch differentiators. Revisit if a customer complains.
2. **MotherDuck `CREATE DATABASE` permissions.** The current `MOTHERDUCK_TOKEN` is documented as `read_scaling` in `CLAUDE.md`. Section C's 403 path will fire on day one in development. Acceptable — the surface is super-admin-only and the remediation text is clear. We do not change the token in this spec.
3. **Last-admin guard symmetry.** Server returns 409 `last_admin` for member-remove and role-demote. Should renaming/deleting the *workspace* also surface a last-admin warning ("you are the only admin — confirm")? Probably not — workspace-level destruction is a different decision from membership-level. Leaving as-is.
