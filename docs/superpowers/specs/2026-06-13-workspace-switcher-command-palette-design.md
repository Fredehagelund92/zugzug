# Workspace Switcher — Command Palette + Workspace Colors

**Date:** 2026-06-13
**Status:** Approved

## Problem

The workspace switcher dropdown breaks down with many workspaces: names wrap to multiple lines, the list grows unbounded, and there's no way to scan quickly when you have 10+ workspaces. A super admin sees every workspace, making this worse.

## Design

Replace the anchored dropdown with a command-palette modal. Add a `color` field to the tenant table so each workspace gets an avatar (initials + color background) that makes it scannable at a glance. The color is set at creation time and changeable in Settings → General.

---

## 1. Palette of colors

10 fixed swatches, all readable with white `#fff` text (contrast ratio ≥ 4.5:1):

| Name    | Hex       |
|---------|-----------|
| Indigo  | `#6366f1` |
| Violet  | `#8b5cf6` |
| Pink    | `#ec4899` |
| Red     | `#ef4444` |
| Orange  | `#f97316` |
| Amber   | `#f59e0b` |
| Emerald | `#10b981` |
| Teal    | `#14b8a6` |
| Blue    | `#3b82f6` |
| Slate   | `#64748b` |

Default when none set: `#6366f1` (Indigo). Applied in the application layer, not as a DB default, so `color IS NULL` rows get the fallback without a migration touching existing rows.

---

## 2. Database

Add `color varchar` (nullable) to `zugzug_app.tenant` via Drizzle:

```ts
// schema.ts
color: varchar("color"),
```

Run `bun run db:generate` to emit the migration. No backfill needed — NULL rows resolve to the default in code.

---

## 3. Server

### provisionTenant
Accept optional `color?: string` in opts. Validate it's one of the 10 palette values (or null). Insert into the `color` column.

### PATCH /api/tenants/:id (admin) + PATCH /api/t/:slug (settings)
Accept `color` in the request body, same validation, update the column.

### /api/me/memberships response
Include `color` on each membership entry alongside `slug`, `label`, `role`.

### TenantRecord / TenantContext
Add `color: string | null` to `TenantRecord`. Surface it through `TenantContext` so the sidebar trigger can read the current workspace's color without a separate fetch.

---

## 4. WorkspaceSwitcher — replaced with command palette

**Trigger:** The workspace button in the sidebar nav. Clicking opens the modal; clicking outside or pressing Esc closes it.

**Modal structure:**
- Fixed-width (360px), floating overlay — not anchored to the nav, positioned near the top-center of the viewport
- Backdrop: semi-transparent, clicking it closes the modal
- Search input at the top (autofocused on open), filters the workspace list in real time
- Two sections: "Current" (always visible, not filtered out) and "All workspaces" (filtered)
- Each row: avatar (26×26px, 6px border-radius, initials, color background) + workspace name (truncated with ellipsis, single line) + role badge
- Footer: "Admin console" link (super admins only) · "Account" · "Sign out"
- Keyboard: ↑↓ to move focus through workspace rows, Enter to switch, Esc to close

**Avatar initials:** first letter of each of the first two words, uppercased. Single-word labels use first two characters.

**No pagination.** The list scrolls (max-height ~240px on the workspace section). Search makes length manageable.

---

## 5. Sidebar trigger update

The workspace button in `AppShell`/`TenantLayout` nav gains the avatar alongside the truncated name. Layout: `[avatar 22px] [name, truncated, flex-1] [▾]`. The name never wraps.

---

## 6. Color picker component

A shared `<WorkspaceColorPicker>` component renders the 10 swatches in a row. Selected swatch has a 2px white gap + 2px colored ring (CSS `box-shadow: 0 0 0 2px #fff, 0 0 0 4px <color>`). Clicking a swatch calls `onChange(hex)`.

Used in two places:

**Admin → Workspaces create form:** Added as a fourth field in the creation form grid (or inline below the label field). Includes a live avatar preview next to the swatches so the admin can see how it'll look.

**Settings → General (workspace settings):** A new "Workspace color" row in the General section with a hint "Used as the avatar background in the workspace switcher." Auto-saves on swatch click (same pattern as label autosave). Visible to admins only (`can(tenant, "settings.general.edit")`).

---

## 7. What does NOT change

- The route structure — switching workspaces still navigates to `/app/:slug`
- The "Admin console" navigation — still goes to `/app/admin`
- Role display in the switcher — role badge stays, now just styled differently
- Auth/session logic — no changes

---

## 8. Files touched

| File | Change |
|------|--------|
| `server/drizzle/schema.ts` | Add `color varchar` to tenant table |
| `server/src/tenant.ts` | Accept + persist color in provisionTenant, updateTenant; include in all SELECT queries |
| `server/src/server.ts` | Pass color through memberships response; accept color in POST /tenants + PATCH handlers |
| `server/src/tenant-middleware.ts` | Add `color` to TenantContext |
| `app/src/components/WorkspaceSwitcher.tsx` | Full rewrite → command palette modal |
| `app/src/components/WorkspaceColorPicker.tsx` | New shared swatch picker component |
| `app/src/components/AppShell.tsx` | Sidebar trigger gains avatar |
| `app/src/routes/admin/Workspaces.tsx` | Create form gains color picker + avatar preview; list rows show colored dot |
| `app/src/routes/settings/General.tsx` | New "Workspace color" settings row |
| `app/src/lib/tenant-context.tsx` | Carry `color` field |
| `app/src/store.ts` | Membership type gains `color` |
