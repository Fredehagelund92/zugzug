# Admin polish audit — closing the Linear/Vercel gap

**Status:** Design approved 2026-06-13.
**Owner:** Frederik
**Scope:** Settings / Admin / Account surfaces. Tier 1 + Tier 2 from the audit. Ships in five phases.
**Builds on:** [2026-06-12 Settings IA redesign](./2026-06-12-settings-ia-redesign.md). The three-surface IA, the role model, and the file-per-section split are settled and shipped. This spec is the **polish layer on top**.

---

## 1. Motivation

The IA redesign shipped a clean three-surface split (Account / Workspace / Admin) with role-gated routes. The surfaces work, the routing is right, the permission model is right. But sitting next to Linear, Vercel, or Airtable, three things still read as amateur:

1. **Tab sprawl.** Workspace Settings has 8 tabs. Five of those concern the same warehouse connection or are over-granular slices of a smaller idea. Linear's workspace settings has ~6. Vercel groups aggressively. We don't earn the count.
2. **State patterns are stubs.** `<span>Loading…</span>` in mono uppercase across 13 pages. "No workspaces yet." in a dashed box. The good empty-state work in `Members.tsx` (search-cleared "no matches" with reset action) didn't propagate. Every empty state is a missed activation moment.
3. **Two voices, two paths.** The Settings layout lede says *"Changes are saved as you make them"* — but General and Profile have explicit Save buttons. ConfirmDialog handles Leave; Danger.tsx hand-rolls its own slug-confirmation modal. Toasts leak internals (*"takes effect on next navigation"*). Notifications is a 9-line stub still showing in nav.

The cumulative effect is a product that's structurally sound but reads as a hobby project on first impression. For an OSS launch where "screams premium SaaS" is non-negotiable, that gap is the launch blocker.

`Members.tsx` is the proof that the bar is achievable in this codebase — chip-based invite input, role popovers with glyphs, search with ⌘K hint, hover-reveal actions, inline error banners with Retry/Dismiss. It is the **reference implementation** this spec raises the rest of Settings/Admin to.

---

## 2. Non-goals

- **No color or component-design changes.** The visual language (accent left-bar, mono kicker, two-tone admin amber, `zz-rise`, numbered sidebar) stays.
- **No grid/triage/tables changes.** Daily-loop polish is a separate track.
- **No new product surface area.** Memberships page in Account is the one exception, and it exists only to host the relocated "Leave workspace" action.
- **No re-litigation of the role model or surface split** from the 2026-06-12 spec.

---

## 3. The bar — Members.tsx as reference

Every change in this spec must match `app/src/routes/settings/Members.tsx` on these dimensions:

- **Loading states render real layout**, not text. Members shows the roster shell + a hint chip; on first paint there's no flicker between "Loading…" and content.
- **Empty states are activation moments.** Members' filtered "no matches" includes the search term + a Reset button. The unfiltered zero-member state should match (currently doesn't — see Phase 2).
- **Errors are recoverable inline.** Members banners include `<Button variant="ghost">Retry</Button>` or `Dismiss`. No silent failures.
- **Hover-reveal for destructive actions.** Remove only appears on row hover with `focus-visible` fallback.
- **Confirm dialogs use ConfirmDialog**, not bespoke inline modals.
- **Pending state per row** (`rolePending: Set<string>`) — not a global spinner.
- **Search affordances** include ⌘K hint when empty and clear button when active.
- **Counts are first-class.** `<span className="tabular-nums">{visible}</span> / {total}` next to titles.

The five issues found in Members itself are fixed in Phase 2.

---

## 4. Phase 1 — IA collapse

**Goal:** Workspace Settings from 8 tabs to 5. Unify the page-header pattern.

### 4.1 Tab fold

| Current tab | After | Rationale |
|---|---|---|
| General | General | Stays. Workspace identity. |
| Members | Members | Stays. The reference. |
| Tokens | **→ Warehouse → Tokens section** | API tokens are a warehouse-connection concern. |
| Scans | **→ Warehouse → Scans section** | Scan schedule is a warehouse-connection concern. |
| Matching | Matching | Stays. Flagship surface (AI mapping landed in #109). |
| Warehouse | Warehouse | Becomes the parent that contains Tokens + Scans as in-page sections. |
| Audit | **→ promoted to top-nav** | Workspace activity log is not a setting; it's a view of the workspace. Moves to primary sidebar under Settings (separate item). |
| Danger | Danger | Stays. After the C4 move below, only contains "Delete workspace". |

After: **General, Members, Matching, Warehouse, Danger** (5 tabs). Audit becomes its own primary-nav item.

Numbered sidebar updates from 01–08 to 01–05.

### 4.2 Warehouse page becomes a parent

`app/src/routes/settings/Warehouse.tsx` grows three `SettingsSection`s:

1. **Connection** — current contents (adapter, mode, health, warehouse_id).
2. **Scans** — moved verbatim from `Scans.tsx`. Schedule + auto-publish.
3. **Tokens** — moved verbatim from `Tokens.tsx`. API tokens table + create form.

Role gating is per-section (Tokens hidden from viewers per the matrix in the IA spec). Routes `/settings/scans` and `/settings/tokens` redirect to `/settings/warehouse#scans` / `#tokens` (smooth-scroll deep-link) for one release cycle, then drop.

### 4.3 Audit promoted

New top-nav item between `Tables` and `Settings`. Move route from `/app/:slug/settings/audit` to `/app/:slug/audit`. Reuses existing `routes/settings/Audit.tsx` content but rendered without the SettingsLayout chrome — promote the file to `routes/Audit.tsx` (workspace-scoped, not settings-scoped). Add a redirect from the old path for one release cycle, then drop.

### 4.4 PageHeader is the only header

Three patterns coexist today:

- `SettingsLayout` uses `<PageHeader kicker title lede>`.
- `Admin/Workspaces.tsx` hand-rolls `<h1>+badge+description`.
- `Account/Profile.tsx` has no page header.

Promote `<PageHeader>` to the single pattern across Settings, Admin, and Account pages. Extend it with optional `count` and `actions` slots so it can host the workspace-count badge (Workspaces) and the "+ New" button:

```tsx
<PageHeader
  kicker="System"
  title="Workspaces"
  lede="Isolated reconciliation environments…"
  count={tenants.length}
  actions={<Button>+ New workspace</Button>}
/>
```

---

## 5. Phase 2 — State patterns

**Goal:** Replace text-based loading and dashed-box empty states with patterns that match Members.

### 5.1 Skeleton loading

Create `app/src/components/Skeleton.tsx` exporting:

- `<SkeletonRow columns={[...]}>` — renders a row matching a final table layout, with shimmer.
- `<SkeletonList rows={5} columns={[...]}>` — N skeleton rows.

Apply to:

- `Admin/Workspaces.tsx` (line 83: replace `<span>Loading…</span>`)
- `Admin/Users.tsx`, `Admin/Audit.tsx`, `Admin/Warehouses.tsx`
- `Settings/Members.tsx` (initial load before `teamUsers` resolves)
- `Settings/Audit.tsx`
- Anywhere else that currently renders "Loading…" in mono caps.

Shimmer uses existing `--surface-2` / `--surface-3` tokens; animation runs ≤1.2s and respects `prefers-reduced-motion` (degrade to static).

### 5.2 Empty states as activation moments

Create `app/src/components/EmptyState.tsx`:

```tsx
<EmptyState
  glyph={<MarkOrIcon />}
  title="No workspaces yet"
  body="Workspaces are isolated reconciliation environments…"
  action={<Button>Create your first workspace</Button>}
  secondary={<a href="…">Learn more</a>}
/>
```

Apply to:

- `Admin/Workspaces.tsx` zero state.
- `Settings/Members.tsx` zero-members state (currently invisible — line 916 short-circuits). For a brand-new workspace, render: *"You're flying solo. Invite teammates to collaborate."* + focus the invite input.
- Tokens, Scans, Audit zero states.

The current "no matches" pattern inside Members (search-filtered empty) stays — it's already correct.

---

## 6. Phase 3 — Form & feedback

**Goal:** One voice, one save path, one confirm pattern, real error surfaces.

### 6.1 Autosave + SyncPill

Resolves the contradiction in `SettingsLayout.tsx:14` ("Changes are saved as you make them") vs the explicit Save buttons in `General.tsx` and `Profile.tsx`.

Pattern: input changes debounced 600ms → PATCH → `SyncPill` next to the field shows `Saving…` → `Saved` (2s fade). On error, pill shows `Failed — retry` (clickable).

Apply to:

- `Settings/General.tsx` (workspace label rename)
- `Settings/Matching.tsx` (thresholds)
- `Settings/Scans.tsx` → soon `Warehouse/Scans` section (schedule, auto-publish)
- `Account/Profile.tsx` (display name)
- `Account/Appearance.tsx` (theme, engineer mode — these may already be instant; verify)

Save buttons removed from those forms. Multi-field forms keep a single "Saving / Saved" pill for the section.

### 6.2 Unified ConfirmDialog with `confirmPhrase`

`Danger.tsx:108-162` hand-rolls a modal that requires typing the workspace slug. The pattern is correct — but it bypasses `ConfirmDialog`. Promote into the shared component:

```tsx
<ConfirmDialog
  open={open}
  title={`Delete ${tenant.label}?`}
  body="This will permanently delete the workspace and all its data."
  confirmPhrase={tenant.slug}   // ← new prop
  confirmLabel="Delete"
  danger
  onConfirm={deleteWorkspace}
  onCancel={() => setOpen(false)}
/>
```

When `confirmPhrase` is set, ConfirmDialog renders the input and disables the confirm button until the typed value matches.

Delete the inline modal in Danger.tsx.

### 6.3 Toast copy pass

Three rules:

1. **Drop internals from success copy.**
   - *"Workspace renamed — takes effect on next navigation."* → *"Renamed."* (re-fetch in place if state is stale.)
   - *"Invites sent — they'll join when they next sign in."* → *"Invites sent."*

2. **Surface real errors.**
   - *"Failed to rename workspace"* → use server-returned error message when present; fall back to *"Couldn't rename — try again."*
   - For 5xx, append *"If this keeps happening, see the [troubleshooting docs](…)."* (link target: OSS docs once they exist; for now, github issues).

3. **One tone, lowercase-leading.** Match the Members toast voice (*"Invite sent"*) across the app. No exclamation marks. No hedging adverbs.

Audit pass across all `toast(...)` call sites. Estimated ~30 sites.

---

## 7. Phase 4 — User vs workspace cleanup

**Goal:** Disentangle per-user actions from per-workspace actions. Stop showing stub routes.

### 7.1 Account → Memberships

New route: `/app/:slug/account/memberships`.

Lists every workspace the current user is a member of (uses existing `boot.memberships`):

```
- Sportsbook    admin    joined 2026-04-12   [Leave]
- Media         editor   joined 2026-05-03   [Leave]
- Default       viewer   joined 2026-03-01   [Leave]
```

Each row's Leave action calls `POST /api/t/:slug/leave` (existing endpoint). On success, the row is removed and a toast confirms. The current `Settings/Danger` "Leave workspace" UI is deleted.

After this, `Settings/Danger` contains only "Delete workspace". Single concern per room.

Account sidebar grows from 3 to 4 items: Profile, Appearance, Notifications, Memberships. (Or 3 if Notifications drops per 7.2.)

### 7.2 Hide or ship Notifications

`account/Notifications.tsx` is 9 lines. Two options:

- **Hide.** Remove from `AccountSidebar` ITEMS and unregister the route. Cheapest path; ships in this phase.
- **Ship a real preferences page.** Email-on-mention, email-on-invite, weekly digest. Requires backend work (preferences table, email sender). Out of scope for the audit.

**Decision: hide.** Notifications returns when there's something to notify about and a sender to send through. A nav item that opens an empty page is anti-premium.

---

## 8. Phase 5 — Sidebar polish

**Goal:** Numbers (01–05, 01–04, 01–03) replaced with icons.

The numbers reset across three sidebars and don't identify anything stable. They read as vanity. Icons restore identity-per-item and free the visual language for hierarchy.

Icon set: lucide-react (already a dependency? — verify; if not, hand-rolled SVGs in `Icons.tsx`). Picks (proposed):

- Settings: General → `settings`, Members → `users`, Matching → `wand`, Warehouse → `database`, Danger → `octagon-alert`.
- Account: Profile → `user`, Appearance → `palette`, Memberships → `layers`.
- Admin: Workspaces → `building`, Users → `users-round`, Audit → `clock`, Warehouses → `database`.

Sidebar row treatment: same hover translate, same accent left-bar, same accent-soft active. Icon replaces the `01` slot at the same width.

This phase is small and independent — can ship last or in parallel.

---

## 9. Phases are independently shippable

Each phase is a separate PR off `main`. Order can flex; I'd recommend:

1. **Phase 1** (IA collapse) — biggest perceived change, sets the new structure.
2. **Phase 2** (state patterns) — compounds with Phase 1's pages.
3. **Phase 3** (form & feedback) — voice consistency once the structure settles.
4. **Phase 4** (Memberships + hide Notifications) — small, isolated.
5. **Phase 5** (icons) — last polish, no dependencies.

If launch pressure forces a cut: ship Phase 1 + Phase 2 + the toast copy slice of Phase 3 (6.3). Defer 6.1 autosave and Phase 4-5. That subset captures ~70% of the perceived-quality jump.

---

## 10. Tier 3 (deferred, tracked here for visibility)

- **Appearance dedup** — verify Settings/Appearance vs Account/Appearance actually overlap; if so, collapse.
- **Admin → workspace breadcrumb chip** — *"← workspace: Sportsbook"* in Admin header so super-admins can hop back.
- **`zz-rise` first-paint gating** — disable after first paint of each route to avoid the "settling" feel on rapid navigation.

These survive the launch. Revisit in a v0.3 polish pass.

---

## 11. Open questions

1. **Audit promotion** — does the workspace audit log have enough utility today to justify primary-nav real estate, or does it stay tucked away? (My read: yes, for an OSS audience evaluating governance.)
2. **Matching as a tab** — once AI mapping is no longer MVP, does it grow into its own primary-nav surface? Out of scope, flagged.
3. **lucide-react** — already installed? If not, the dependency add is part of Phase 5. Verify before Phase 5 PR.

---

## 12. Success criteria

- Workspace Settings sidebar shows 5 items.
- No page in Settings/Admin/Account renders `<span>Loading…</span>` as its loading state.
- No page renders "No X yet" in a dashed box without an action.
- Zero explicit Save buttons remain in Settings/General, Settings/Matching, Settings/Scans, Account/Profile.
- One `ConfirmDialog` component handles both simple and phrase-confirmed flows. Zero inline modal implementations.
- Every Settings/Admin/Account page uses `<PageHeader>` for its header.
- `Account/Notifications` is no longer in the nav.
- An icon, not a number, prefixes each sidebar item.

If we can screenshot the Settings, Admin, and Account surfaces next to Linear or Vercel and not flinch, we're done.
