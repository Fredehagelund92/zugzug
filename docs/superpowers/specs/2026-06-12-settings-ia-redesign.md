# Settings IA redesign — Account / Workspace / Admin

**Status:** Design approved 2026-06-12. Ships in three sequenced PRs (A, B, C).
**Owner:** Frederik
**Branches:** `mt-pr5a-settings-ia`, `mt-pr5b-account-danger`, `mt-pr5c-admin-console` (off `main`, after `mt-pr4-ui-shell` lands)

---

## 1. Motivation

The current `Settings.tsx` (1683 LOC) is a single page that mixes per-user concerns (theme, engineer mode), per-workspace operational config (scans, matching), and per-workspace identity/membership (team, tokens) with no role gating — anyone with a session can see every control, and any admin can edit anything. The admin shell at `/app/admin` is a one-page Workspaces CRUD placeholder.

This redesign establishes three distinct surfaces aligned to Linear's IA, splits the monolithic Settings file into focused sections, introduces a server-enforced role permission model exposed to the client via a typed `can()` helper, and grows the admin shell into a proper system console.

## 2. Surfaces

Three surfaces, three URL prefixes, three role tiers:

```
ACCOUNT  (any signed-in user, cross-workspace)
  /app/:slug/account                  → redirects to /profile
  /app/:slug/account/profile             name, email (read-only), sign out
  /app/:slug/account/appearance          theme, engineer mode
  /app/:slug/account/notifications       placeholder ("Coming soon")

WORKSPACE  (gated by tenant_member.role within :slug)
  /app/:slug/settings                 → redirects to first permitted section
  /app/:slug/settings/general            workspace label rename (admin), slug display, created_at
  /app/:slug/settings/members            members + invites (existing TeamSection)
  /app/:slug/settings/tokens             API tokens (hidden from viewers)
  /app/:slug/settings/scans              scan schedule, auto-publish
  /app/:slug/settings/matching           publish/suggest thresholds
  /app/:slug/settings/warehouse          adapter, mode, health, warehouse_id (read-only)
  /app/:slug/settings/audit              per-workspace audit timeline
  /app/:slug/settings/danger             leave workspace + delete workspace

ADMIN  (super-admin only, distinct chrome — separate shell from /app/:slug)
  /app/admin                          → redirects to /workspaces
  /app/admin/workspaces                  existing tenant CRUD (renamed file)
  /app/admin/users                       list users, promote/demote super-admin, last-seen
  /app/admin/audit                       system-wide audit + tenant filter
  /app/admin/warehouses                  read-only MotherDuck DB list
```

Account stays inside the AppShell (cheap drop-in). Workspace Settings stays inside the AppShell (sidebar nav `Settings` deep-links to it). Admin keeps a separate shell — the tenant-context invariant (slug-keyed store, presence WS, palette recents) breaks if Admin runs inside `TenantLayout`, and the visual differentiation is a deliberate tripwire for cross-tenant actions.

## 3. Role model

Four tiers (`viewer` < `editor` < `admin` < `super-admin`). Super-admin entering a non-member workspace gets `admin` UI affordances client-side; server enforces independently. The matrix:

| Section | viewer | editor | admin | super-admin |
|---|---|---|---|---|
| Account/* (Profile, Appearance, Notifications) | edit | edit | edit | edit |
| Settings/General (workspace label) | read | read | **edit** | edit |
| Settings/Members | read | read | **edit** | edit |
| Settings/Tokens | hidden | read | **edit** | edit |
| Settings/Scans (schedule, auto-publish) | read | **edit** | **edit** | edit |
| Settings/Matching (thresholds) | read | **edit** | **edit** | edit |
| Settings/Warehouse | read | read | read | read |
| Settings/Audit | read | read | read | read |
| Settings/Danger | leave only | leave only | leave + delete | leave + delete |
| Admin/* | hidden | hidden | hidden | full |

Rules:
- **Account is universal.** Everyone owns their profile/appearance/notifications regardless of workspace role.
- **Operational config (Scans, Matching)** = editor-or-above. Day-to-day toggles, not destructive.
- **Identity/membership (General, Members, Tokens)** = admin-or-above. Reshapes who-can-do-what.
- **Warehouse is read-only for everyone in Phase 1.** Switching warehouse credentials is super-admin territory (Admin → Workspaces edit form, PR C).
- **Tokens hidden from viewers** — security posture (no visibility into the credential inventory).
- **Danger zone**: anyone can leave their own membership (server enforces last-admin guard — refuses with 409 `last_admin` if it would leave the workspace with zero admins). Workspace deletion is admin-only and refuses on the system `default` tenant.

### Client permission API

```ts
// app/src/lib/permissions.ts
export type Action =
  | "account.profile.edit"        // always true for signed-in users
  | "settings.general.view"
  | "settings.general.edit"
  | "settings.members.view"
  | "settings.members.edit"
  | "settings.tokens.view"
  | "settings.tokens.edit"
  | "settings.scans.view"
  | "settings.scans.edit"
  | "settings.matching.view"
  | "settings.matching.edit"
  | "settings.warehouse.view"
  | "settings.audit.view"
  | "settings.danger.leave"       // always true
  | "settings.danger.delete"
  | "admin.view";                 // gates the entire /app/admin shell

export function can(t: TenantContextValue, a: Action): boolean { … }
```

Two composable React primitives consume `can()`:

- `<RoleGate action="settings.tokens.view" fallback={null}>{children}</RoleGate>` — hide or render. Used by the sidebar to filter nav items and by sections that should not mount at all for the current role.
- `<ReadOnly enabled={!can(t, "settings.scans.edit")}>{children}</ReadOnly>` — renders a `<fieldset disabled aria-disabled>` wrapper that visually dims controls and blocks pointer events without unmounting them. Viewers see the form populated with current values but cannot interact.

Server-side enforcement is independent and authoritative — every mutation route checks `tenantCtx.role` (or `sessionUser.isSuperAdmin` for admin routes); client gating is purely UX.

## 4. Component architecture

### Sidebar layouts

Two parallel layout components, both 220px left-rail + outlet on the right:

```
app/src/components/settings/
  SettingsShell.tsx          primitive: 220px left rail + content area; takes sidebar + children
  SettingsLayout.tsx         hosts /settings/* — composes SettingsShell with workspace sections
  SettingsSidebar.tsx        grouped nav (Workspace tier only), role-filtered, active highlight
  SettingsSection.tsx        card shell (extracts existing Section from Settings.tsx)
  RoleGate.tsx               { action, children, fallback? }
  ReadOnly.tsx               { enabled, children } — fieldset wrapper

app/src/components/admin/
  AdminLayout.tsx            replaces AdminShell — same SettingsShell primitive
  AdminSidebar.tsx           Workspaces / Users / Audit / Warehouses
```

`SettingsShell` is the shared primitive; `SettingsLayout` (workspace settings) and `Account.tsx` (per-user) and `AdminLayout` (super-admin) all compose it. This gives the three surfaces a unified visual language without code duplication.

### Section files

Each section is its own focused component (<200 lines), extracted from the current monolith. File-naming convention: `routes/<surface>/<Section>.tsx`.

```
app/src/routes/account/
  Account.tsx                layout host — SettingsShell + AccountSidebar
  Profile.tsx                NEW — name (PATCH /auth/me), email, sign out button
  Appearance.tsx             NEW — theme toggle + engineer mode (extracted from current Settings)
  Notifications.tsx          NEW — placeholder card

app/src/routes/settings/
  index.tsx                  NEW — Navigate to general (visible to every role per the matrix)
  General.tsx                NEW — workspace label rename (admin), slug + created_at display
  Members.tsx                MOVE — extracts TeamSection() from Settings.tsx
  Tokens.tsx                 MOVE — extracts token UI from Settings.tsx
  Scans.tsx                  MOVE — extracts ScansSection() from Settings.tsx
  Matching.tsx               MOVE — extracts matching defaults
  Warehouse.tsx              MOVE — extracts Data flow / Workspace info from Settings.tsx
  Audit.tsx                  NEW — uses existing useAudit hook + /api/t/:slug/audit
  Danger.tsx                 NEW — Leave (any) + Delete (admin) with typed-slug confirm

app/src/routes/admin/
  Workspaces.tsx             RENAME from Tenants.tsx (no behavior change)
  Users.tsx                  NEW — list, promote/demote, last-seen
  Audit.tsx                  NEW — system-wide audit + tenant filter
  Warehouses.tsx             NEW — MotherDuck DB list (consumes shipped endpoint)
```

### Files modified or removed

```
app/src/components/AppShell.tsx              MOD — Settings nav item points at /settings (Tasks 1)
app/src/components/WorkspaceSwitcher.tsx     MOD (PR B) — "Account settings" + "Workspace settings" entries
app/src/components/AdminShell.tsx            DELETE (PR C) — replaced by AdminLayout
app/src/main.tsx                             MOD (PR A + PR C) — restructured route table
app/src/routes/Settings.tsx                  DELETE (PR A) — fully extracted
```

### Route table after PR A

```tsx
<Route path="/app/:tenantSlug/*" element={<TenantLayout … />}>
  <Route element={<AppShell />}>
    <Route index element={<Dashboard />} />
    <Route path="triage" element={<Triage />} />
    <Route path="sources" element={<Sources />} />
    <Route path="tables" element={<MasterTables />} />

    <Route path="settings" element={<SettingsLayout />}>
      <Route index element={<Navigate to="general" replace />} />   {/* general is visible to every role */}
      <Route path="general" element={<General />} />
      <Route path="members" element={<Members />} />
      <Route path="tokens" element={<Tokens />} />
      <Route path="scans" element={<Scans />} />
      <Route path="matching" element={<Matching />} />
      <Route path="warehouse" element={<Warehouse />} />
      <Route path="audit" element={<SettingsAudit />} />
      <Route path="danger" element={<Danger />} />       {/* stub in PR A, real in PR B */}
    </Route>

    <Route path="account" element={<Account />}>        {/* PR B */}
      <Route index element={<Navigate to="profile" replace />} />
      <Route path="profile" element={<Profile />} />
      <Route path="appearance" element={<Appearance />} />
      <Route path="notifications" element={<Notifications />} />
    </Route>
  </Route>
</Route>

{boot.isSuperAdmin && (
  <Route path="/app/admin/*" element={<AdminLayout />}>   {/* PR C — was AdminShell */}
    <Route index element={<Navigate to="workspaces" replace />} />
    <Route path="workspaces" element={<Workspaces />} />
    <Route path="users" element={<AdminUsers />} />
    <Route path="audit" element={<AdminAudit />} />
    <Route path="warehouses" element={<AdminWarehouses />} />
  </Route>
)}
```

## 5. Server endpoints

### Existing (no change)

`/api/auth/me`, `/api/me/memberships`, `/api/t/:slug/team/*`, `/api/t/:slug/audit`, `/api/t/:slug/tokens`, `/api/t/:slug/preferences`, `/api/admin/tenants`, `/api/admin/tenants/:id/teardown`, `/api/admin/audit`, `/api/admin/impersonate`, `/api/admin/warehouses`.

### New (PR B)

```
PATCH /api/auth/me                              { name }                  → 204
  Updates users.name for the current session user. Email + id immutable here.
  Any signed-in user.

PATCH /api/t/:slug                              { label }                 → 204
  Updates tenant.label. Admin only. Slug is immutable post-create.

POST  /api/t/:slug/leave                                                  → 204 | 409 last_admin
  Any member removes their own membership. Same last-admin guard as
  DELETE /members/:userId — refuses with { error: "last_admin" } if it would
  leave the workspace with zero admins. Audit: "member.leave".

DELETE /api/t/:slug                                                       → 204 | 409 cannot_teardown_default
  Admin only. Calls existing teardownTenant() internally. Refuses on the
  system "default" tenant. Audit row to system audit: "workspace.delete".
```

### New (PR C)

```
GET   /api/admin/users[?q=…&limit=…&offset=…]                             → { users: [...], total }
  Lists users with: id, email, name, is_super_admin, created_at,
  last_seen_at, membership_count (LEFT JOIN tenant_member, COUNT).
  Pagination via limit/offset; q matches email or name LIKE.

PATCH /api/admin/users/:id                      { isSuperAdmin: bool }    → 204 | 409
  Promote/demote super-admin.
  Refuses 409 last_super_admin if it would leave zero super-admins.
  Refuses 409 self_demote when caller demotes themselves (tripwire — must
  be done by another super-admin). Audit: "admin.user.role".
```

### Schema additions (one Drizzle migration, PR B)

- `users.last_seen_at timestamp null` — written on every `/auth/me` hit (cheap, single UPDATE).

No other schema changes — `tenant.label` already exists, `users.is_super_admin` already exists, `tenant_member.role` already supports admin/editor/viewer, `tenant_invite` already exists.

## 6. Phasing

### PR A — Settings IA scaffold + role infrastructure + extraction

Branch: `mt-pr5a-settings-ia` off `main`. ~1200 LOC.

- `permissions.ts` (`can()`, `Action` type, exhaustive switch).
- `RoleGate`, `ReadOnly` primitives.
- `SettingsShell` primitive, `SettingsLayout` + `SettingsSidebar` (workspace-tier nav, role-filtered).
- Routes restructured under `/settings/*` with sub-routes.
- Extract existing sections to `routes/settings/{Members,Tokens,Scans,Matching,Warehouse}.tsx`. Behavior preserved 1:1.
- `General.tsx` as a read-only stub (workspace label display + slug + created_at).
- `SettingsAudit.tsx` consuming the existing `/api/t/:slug/audit` + `useAudit` hook.
- `Danger.tsx` as a stub (real implementation in PR B).
- Role gating applied per the matrix — viewers see disabled controls or hidden sections.
- `Settings.tsx` deleted.
- Tests:
  - `app/test/permissions.test.ts` — `can()` truth table across all action × role combinations.
  - `app/test/settings-sidebar.test.tsx` — role filtering, active route highlighting.
  - `app/test/read-only.test.tsx` — fieldset disabled, pointer events blocked.
  - `app/test/settings-index-redirect.test.tsx` — viewer hitting `/settings` redirects to first permitted section.

Rationale: establishes the primitives (`SettingsShell`, `RoleGate`, `ReadOnly`, route table, `can()`) that PR B and PR C build on. Lowest blast radius — no new server endpoints, no new sections, just IA + role gating + extraction.

### PR B — Account surface + workspace switcher polish + General/Danger sections

Branch: `mt-pr5b-account-danger` off PR A. ~900 LOC.

Server:
- `PATCH /api/auth/me`, `PATCH /api/t/:slug`, `POST /api/t/:slug/leave`, `DELETE /api/t/:slug`.
- `users.last_seen_at` migration + write on `/auth/me` hit.
- Tests: `account-profile.test.ts`, `tenant-label.test.ts`, `tenant-leave.test.ts`, `tenant-delete.test.ts`.

Client:
- `routes/account/{Profile,Appearance,Notifications}.tsx` + `Account.tsx` (composes `SettingsShell` with an Account sidebar).
- Move theme + engineer mode out of any `Settings/Appearance` placeholder into `Account/Appearance`.
- `General.tsx` upgraded — workspace label rename (admin only, optimistic update).
- `Danger.tsx` — Leave workspace (any role, confirm dialog) + Delete workspace (admin, typed-slug confirmation dialog matching the workspace's slug exactly).
- `WorkspaceSwitcher` adds "Account settings" + "Workspace settings" (admin-gated) entries above the sign-out row.
- Tests: `danger-zone.test.tsx` (typed-slug confirm flow), `workspace-switcher.test.tsx` extended for new entries, `profile-edit.test.tsx`.

### PR C — Admin console overhaul

Branch: `mt-pr5c-admin-console` off PR B. ~700 LOC.

Server:
- `GET /api/admin/users`, `PATCH /api/admin/users/:id` with `last_super_admin` + `self_demote` guards.
- Tests: `admin-users.test.ts` (list, promote, demote, last-super-admin guard, self-demote guard).

Client:
- `AdminLayout` + `AdminSidebar` (replaces `AdminShell`), `SettingsShell` primitive reused.
- `routes/admin/Workspaces.tsx` (rename from `Tenants.tsx`, route stays `/workspaces`).
- `routes/admin/Users.tsx` — list, search, promote/demote, last-seen.
- `routes/admin/Audit.tsx` — system-wide audit timeline with tenant filter (consumes shipped endpoint).
- `routes/admin/Warehouses.tsx` — read-only MotherDuck DB list (consumes shipped `/api/admin/warehouses`).
- `AdminShell.tsx` deleted.
- Tests: `admin-sidebar.test.tsx` (active route, super-admin gating), `admin-users-page.test.tsx`.

## 7. Testing strategy

Server: each new route gets a focused test in `server/test/` using the existing `signedInAs` + `startTestServer` harness (the same pattern PR2a and PR2b established). Cover success, 401, 403, and the explicit 409 guards (last_admin, last_super_admin, self_demote, cannot_teardown_default).

Client: role-matrix testing concentrated in `permissions.test.ts` (truth table) and `settings-sidebar.test.tsx` (the visible consequence). Per-section tests for non-trivial flows (Danger typed-slug confirm, Profile optimistic update, Workspace switcher menu). Existing tests for shipped components (`workspace-switcher`, `boot-gate-redirect`) get extended rather than rewritten.

## 8. Deferred / out of scope

- **Notifications** ship as a placeholder card in PR B; real implementation belongs to a later notifications PR.
- **Per-workspace warehouse credentials** (each workspace owns its own MotherDuck token) — PR C ships a read-only Warehouses page that lists the currently-attached MotherDuck databases; full per-workspace credential management is a future PR that needs schema + key-management design.
- **Workspace slug rename** — slugs stay immutable post-create (URLs reference them everywhere).
- **Bulk user actions** in Admin/Users (bulk demote, bulk suspend) — single-user actions only in PR C.
- **Granular audit filters** — PR C ships tenant filter only; action-type filter is a future polish.

## 9. Risks

- **PR A's extraction risk** is non-zero (1683 lines moving around). Mitigation: behavior preserved 1:1, no new server endpoints in PR A, all existing tests for Team/Tokens/Scans must stay green. If a test breaks, the extraction did something it shouldn't.
- **`SettingsShell` reused across three layouts** — easy to over-specialize. Rule: the primitive accepts `{ sidebar, children }` only; layout-specific concerns (active route, role filtering) stay in the sidebar component, not the shell.
- **Super-admin entering a workspace** still gets `role: "admin"` UI affordances via `TenantLayout` (existing behavior). Server enforces independently — there is no risk of UI showing a control the server would 403. But it does mean a super-admin demoted from super-admin mid-session still sees admin affordances until BootGate refetches. Acceptable; full refresh resolves it.
- **`users.last_seen_at` write on every `/auth/me`** — single UPDATE per session ping. Cheap, but the timing of the write matters: must happen after auth resolves and inside the user's existing pg connection (no new connection per ping). Verify in PR B.

## 10. Open questions resolved during brainstorming

- Scope: full Linear-grade IA (option 3 of three).
- Viewer access: read-only (option 1 of three).
- Switcher: includes "Workspace settings" entry (admin-only) and "Account settings" entry (always).
- Layout: inside AppShell (not full-page overlay). Settings page hosts its own vertical sub-nav.
- Admin shell: stays separate from AppShell, but graduates to a proper sidebar console matching the Settings pattern.
