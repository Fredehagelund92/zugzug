# Linked Fields UX — Design Spec

**Date:** 2026-06-13
**Scope:** Complete the lookup/virtual-field experience on linked columns: post-creation editing, differentiated context menus, clearer naming, and well-defined edge cases. No new data model — the existing `displayFields` JSON shape is reused.

---

## Background

Linked fields already ship a working virtual-field model that nobody can reach from the UI:

- `dimension_field.field_config` stores `{ targetDimId, displayFields: string[] }`.
- When `displayFields` has more than `["label"]`, the grid auto-generates **synthetic read-only columns** (`country__iso_code`) labeled `↳ iso_code` (`TablePane.tsx:366`).
- `displayFields` is hardcoded to `["label"]` at creation (`AddFieldPopover.tsx:252`) and frozen after — to change it today you delete and recreate the field.
- The column context menu (`DataGrid.tsx:669-719`) shows the **same items** for a normal text column, an FK column, and a lookup column.

This spec finishes the work: the user can pick which linked fields to bring along, change them later, and the right-click menu surfaces actions that are appropriate to each column kind.

Out of scope: rollup fields (aggregates over reverse-linked records), changing a linked field's target dimension after creation, multi-hop lookups.

---

## 1. Data Model

### 1.1 `displayFields` — semantics

`displayFields: string[]` on a linked field declares which fields of the target dimension are surfaced as inline read-only columns in this dimension's grid.

- Always contains `"label"`. The user cannot remove it; removing it would degrade the FK cell's display.
- The array is a **set** of which fields to surface, not a column order. Grid column order is governed by the existing `columnOrder` preference, independent of `displayFields`. Newly added entries default to appearing immediately to the right of the FK column (or to the right of the rightmost existing lookup for the same FK).
- Each entry must be a field that exists on the target dimension at read time. Stale entries (target field renamed/removed) are tolerated — see §5.

No schema migration. The existing `field_config` JSON column carries everything.

### 1.2 No new tables; no new server-side state

Lookup columns are entirely derived. The server returns canonical rows with `fields: Record<string, CellValue>` already, and the grid synthesises `country__iso_code` columns from `displayFields`. Removing an entry from `displayFields` is the entire delete operation for a lookup column.

---

## 2. Right-Click Menu — Branched by Column Kind

Today every column shows the same menu. Proposed: the menu detects the column kind and shows different items.

A column is one of:
- **Normal** — text/number/boolean/date/select/url/email/rating
- **FK** — `type: "linked"`, the source of truth field
- **Lookup** — synthetic, generated from an FK's `displayFields`

### 2.1 FK column menu

```
Sort ascending / descending
─────
Rename                        (renames the FK column label)
Edit description
Conditional formatting…
─────
Show linked fields…           NEW — opens picker (§3)
Open target dimension →       NEW — navigates to /app/:slug/tables/<targetDimId>
─────
Hide column
Delete column…                CONFIRM — also removes all lookup columns
```

### 2.2 Lookup column menu

```
Sort ascending / descending
Conditional formatting…
─────
Change displayed field…       NEW — swap which target field this column shows
Manage linked fields…         NEW — opens the same picker as the FK column (§3)
Jump to source column →       NEW — scrolls/selects the FK column
─────
Hide column
Remove this lookup            NEW — drops this entry from displayFields
```

Removed vs the normal menu (and rationale):
- **Rename** — the lookup label is auto-derived from the FK label + target field label (§4); a manual override would diverge from the source.
- **Change type** — the column's type follows the target field; you change it by changing the target field.
- **Edit description** — description lives on the target dimension's field, not on the lookup.

### 2.3 Implementation note

The menu lives in `DataGrid.tsx:669-719`. The branching adds a `columnKind: "normal" | "fk" | "lookup"` parameter the menu reads to render the right items. The handlers (`onShowLinkedFields`, `onChangeDisplayedField`, `onRemoveLookup`, `onJumpToSource`, `onOpenTargetDim`) are passed down from `TablePane.tsx` where field metadata is already available.

---

## 3. Picker — "Show linked fields…"

A popover anchored to the column header. Same component is used from both the FK column's "Show linked fields…" and a lookup column's "Manage linked fields…".

```
┌─ Show linked fields — Country ──────────┐
│ 🔎 Search fields…                       │
│ ─────────────────────────────────────── │
│ ☑ Label                  text           │   ← always checked, disabled
│ ☑ ISO Code               text           │
│ ☐ Region                 text           │
│ ☐ Population             number         │
│ ☐ Continent ↳            linked         │   ← disabled w/ tooltip
│ ─────────────────────────────────────── │
│ Preview:                                │
│ Country │ Country › ISO Code │ (new)    │
│ Germany │ DE                 │  …       │
│ ─────────────────────────────────────── │
│              [ Cancel ]   [ Apply ]     │
└─────────────────────────────────────────┘
```

### 3.1 Behavior

- The list shows every field on the target dimension, with its type label on the right.
- `label` is always checked and disabled.
- Linked fields on the target dim appear in the list but are **disabled** with tooltip `Lookups through another link are not supported`. This sidesteps multi-hop semantics.
- Search filters the list by field label (case-insensitive substring).
- The list is sorted: `label` first (always checked/disabled), then checked entries in `displayFields` order, then remaining unchecked entries alphabetically by label. The picker does not expose reordering — grid column order is managed via header drag (existing `columnOrder` preference).
- Preview row shows the FK column followed by a `Country › <field>` lookup column for each checked entry, with sample values from the first canonical record of the target dim if one exists.
- Cancel discards. Apply commits an optimistic `PATCH /api/dimensions/:dimId/fields/:field` with the new `displayFields`.

### 3.2 "Change displayed field…" (single-field variant)

From a lookup column's context menu, "Change displayed field…" opens the same popover but with the changed-column's row highlighted and the dialog scoped to swapping that one entry — checking a new field unchecks the previous one. Same Apply path.

### 3.3 No multi-hop lookups

Surfacing `Country › Continent › Region` as a column would require either (a) the server resolving deeply nested joins per row or (b) a recursive client merge. Both add complexity for a use case that hasn't been requested. Excluded explicitly.

---

## 4. Naming Convention

### 4.1 Lookup column label: `<FK label> › <target field label>`

- `Country › ISO Code` (FK label: "Country", target field label: "ISO Code")
- When the FK column is renamed, every lookup label updates automatically.
- When the target dim's field is renamed, every lookup label updates automatically.

This replaces today's `↳ iso_code` glyph, which is ambiguous when more than one linked column shares a field name.

### 4.2 Backing field name unchanged: `<fkField>__<targetField>`

No schema migration. The frontend keeps mapping `country__iso_code` to a synthetic column; only the label changes.

### 4.3 Tooltip on the lookup column header

`Lookup from "Country" — read-only`

### 4.4 Cell affordances

- Cursor on a lookup cell is the default arrow (not text-edit caret).
- No editor opens on click/Enter; the cell is announced to screen readers as `read-only lookup from Country`.

---

## 5. Edge Cases

| Case | Behavior |
|---|---|
| FK is null | Lookup cells render `—` (em dash) in muted color. No tooltip. |
| Linked record was deleted | Lookup cells render `—` with a small red dot indicator. Tooltip: `Linked record not found`. |
| Target dim's field is renamed (`iso_code` → `code`) | `displayFields` becomes stale. Lookup column header shows ⚠️ icon with tooltip `Source field was renamed — reconfigure`. Column still appears, but cells render `—`. Picker shows the stale name in red strikethrough at the top with "Replace…" affordance. |
| Target dim's field is deleted | Lookup column auto-disappears from the grid. A one-time banner in the FK column header: `Lookup column "ISO Code" was removed because the source field was deleted` (dismissible). The stale entry is **automatically cleaned** from `displayFields` on next save. |
| FK column is deleted | Confirmation prompt lists the lookup columns that will also be removed. On confirm, both the FK field and all derived lookup columns disappear. |
| User drags a lookup column to reorder | Allowed. Uses the existing per-user `columnOrder` preference, same as any other column. `displayFields` is unaffected. |
| Same target field picked twice | Not allowed — checkboxes prevent it. |
| Workspace switch mid-edit | Picker closes; in-flight mutation is cancelled. Standard `apiFetch` behavior. |

---

## 6. API Changes

### 6.1 Extend `PATCH /api/dimensions/:dimId/fields/:field`

The existing field-update endpoint accepts new fields:

```ts
PATCH /api/dimensions/:dimId/fields/:field
{
  // existing fields…
  fieldConfig?: {
    targetDimId?: string;    // rejected if changed — see §6.2
    displayFields?: string[]; // NEW — accepted, validated
  };
}
```

Validation:
- Every entry in `displayFields` must currently exist as a field on `targetDimId`'s dimension. **Exception:** the entry already present in the prior `displayFields` is allowed even if stale (so the server doesn't reject mid-recovery when the target was renamed).
- `displayFields` must contain `"label"`.
- `displayFields` entries must be unique.
- All updates are scoped to the active tenant; cross-tenant references rejected.

### 6.2 `targetDimId` stays frozen

If the request body contains `fieldConfig.targetDimId` and it differs from the stored value, return 400 with `{ error: "targetDimId is immutable after creation; delete and recreate the field" }`. The Linked record's target dim should not change post-creation — every existing FK in the column would silently invalidate.

### 6.3 Optimistic update on the client

Same pattern as `setFieldValue` in `store.ts`: patch the local field config immediately, fire the request, roll back on error with a toast. Existing infrastructure.

---

## 7. Permissions and Multi-Tenant

- **`canEdit`** — required to open the picker, mutate `displayFields`, remove a lookup, or change displayed field. Same gate as other field edits.
- **`canView`** only — context menu items related to picker/mutations are visible but disabled with tooltip `Read-only access`.
- The picker lists target-dim fields scoped to the **active tenant**. Cross-tenant FK targets are not currently allowed and stay disallowed.
- **Engineer mode (`useEngineerMode()`)** — internal-naming reveals (`country__iso_code`, the underlying `field_config` JSON) appear in tooltips only when engineer mode is on. Non-engineer users see only the human label.
- **Audit log** — `displayFields` changes append an audit entry `field.displayFields.update` with before/after arrays, so the dashboard activity feed shows who added/removed which lookup.

---

## 8. Migration & Rollout

No data migration is needed. All existing `linked` fields already have `displayFields` in their config (default `["label"]`). New behavior is additive.

UI rollout is a single PR (no feature flag): the new menu items and picker simply appear. Anyone who never opens the menu sees no change.

---

## 9. Out of Scope (Recorded For Future)

- **Rollup fields** (sum/count/min/max over reverse-linked records) — confirmed out of scope 2026-06-13. Reference data isn't transactional; rollups belong in BI.
- **Multi-hop lookups** (`Country › Continent › Region`) — see §3.3.
- **Changing `targetDimId` post-creation** — see §6.2.
- **Reorder lookups via header drag** — possible but a separate column-order preference; not bundled here.
- **Default to a bunch of fields at creation** — the create modal stays `displayFields: ["label"]` by default; the user opens the picker after to add more. Could add an "+ Show more fields" affordance in the create modal in a follow-up.

---

## 10. Acceptance Criteria

- A user with `canEdit` can right-click an FK column, pick "Show linked fields…", check additional target-dim fields, and Apply — the grid gains `Country › ISO Code`–style read-only columns showing the linked record's values.
- A user can right-click a lookup column and pick "Remove this lookup" — that single column disappears; other lookups for the same FK remain.
- A user can right-click a lookup column and pick "Change displayed field…" — swap to a different target-dim field in one step.
- FK and lookup columns show **different** context menus from normal columns, per §2.
- Renaming the FK column updates every lookup label live (no refresh needed).
- Renaming a target-dim field updates every lookup label live.
- Deleting an FK column shows a confirmation listing the lookups that will go with it.
- A user with `canView` only sees the new menu items disabled, not hidden.
- Audit log shows `field.displayFields.update` entries for every change, with before/after.
