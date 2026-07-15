# Table toolbar — single rail redesign

**Date:** 2026-07-15
**Status:** approved (direction), pending implementation plan
**Visual source of truth:** `docs/table-toolbar-redesign.html` — Variant 01 "Single rail"
**Target:** `app/src/components/TablePane.tsx` → `RecordsBody`, toolbar block at lines 805–1012 (plus the inline panels at 1014–1128)

## Problem

The Records toolbar renders up to **11 controls in one flat row at equal visual weight**: stats · search · Undo · Redo · Export CSV · Ordering · Owner · History · Publish · Import CSV · Download snapshot · Re-scan. Nothing is tiered — the primary action (Publish) sits at the same weight as a config toggle (Owner). It reads as busy rather than enterprise-grade.

## Goal

Re-rank the same capabilities into a **single tiered rail** (Variant 01). This is a **presentation change**: no data-fetching, mutation, or handler logic changes. Existing handlers, state, gating (`canEdit`, `engineer`), and the inline Ordering/Owner/History panels are preserved — only how controls are grouped and triggered changes. Two controls collapse into new dropdown menus.

## Layout (left → right, one row, `flex-wrap`)

**Left cluster — identity & context**
1. Per-table tint dot (palette color for `dim`) — the "circuit identity" from `DESIGN.md`.
2. Engineer-mode prefix (unchanged): `table <dimTable>` · `key <keyCol>` when `engineer`.
3. **Gauges** — records / fields / source values, restyled as bold count (`text-ink`, tabular-nums) + muted unit (`text-ink-3`, uppercase), separated by thin dividers. Same values as today (`list.length`, `fields.length`, `totalVariants`).
4. Owner **chip** when `dim.ownerName` is set (pill: avatar initial + name). Replaces the inline `owner X` text.
Identity holds only "what is this table" (dot, name, gauges, owner). The changed-records filter is a view control and lives in the view group below — not here.

**Spring** — search is the flexible middle zone (`flex-1`); the action cluster hugs the right.

**Right cluster — controls**
6. `PresenceStrip` (only when peers present).
7. **View group:** Search input (leading magnifier; `/` and `⌘F` focus it) · **Sort** `⇅` toggling the `orderingOpen` panel (`canEdit`) · **Changed filter** — a filter chip (funnel + count, e.g. `2 changed`) toggling `changedOnly`, shown when `pubState.changedKeys.length > 0`; accent + ✕ when active; collapses to icon + count on narrow panes.
8. Vertical divider.
9. **Undo / Redo** — joined segmented control. Same `undo.undo/redo` / `canUndo/canRedo` / `topLabel`. Hidden below the container's `@3xl`.
10. **`⋯` overflow** — a single menu (see below).
11. **Publish** (right end):
    - When `canEdit && pubState && unpublished > 0`: primary accent button labelled **`Publish {n} change[s]`** — count in words, no version, no badge. Tooltip is a plain-language breakdown ("Publish 1 new mapping and 2 edited records since the last version"). Same publish-preview handler.
    - Else when `pubState.version > 0`: quiet readout — **`✓ Up to date`** when nothing is pending, or **`{n} unpublished`** for a viewer who can't publish. The version lives in the tooltip, not on screen.

## `⋯` overflow menu

**One** overflow menu — there is no separate `Data ▾` (a second adjacent dropdown was redundant chrome, and "Data" is a vague label). Two labelled sections:

**Import / export** (rendered when `canEdit || list.length > 0`):
- `↑ Import CSV` (`canEdit`) → `importFileRef.current?.click()`.
- `↓ Export records (CSV)` → `exportToCSV(dim)`, when `list.length > 0`. Sub-label: "key, label and fields as a spreadsheet".

**Table** — each item triggers the **existing** setter/panel:
- `⍟ Assign owner` (`canEdit`) → `openOwnerPanel()` → the searchable `OwnerPicker` panel.
- `⌛ Version history` → `setHistoryOpen(true)` (existing `VersionHistory` unchanged).
- `⟳ Re-scan source` (`canEdit && sourceOpts.length > 0`) → toggles the inline `rescanOpen` panel hosting the *existing* re-scan controls (internal `ComboSelect` w/ `derive`, or external id/name `ComboSelect`s + button w/ `deriveExternal`).

The menu always contains at least Version history, so it is never empty.

**Download snapshot (.parquet) was removed** — from this toolbar *and* the Triage publish panel. Programmatic / warehouse consumption belongs in **Integrations → Pull API** (JSON API + service accounts, for dbt / Fivetran / ETL). The `/api/dimensions/:id/snapshot.parquet` server endpoint stays.

## New components

`app/src/components/ToolbarMenu.tsx` — a small portal-anchored dropdown (the `⋯` overflow; reusable for other toolbar menus), following the house pattern in `datagrid/ColumnHeaderMenu.tsx`:
- `createPortal` to `document.body`, `useLayoutEffect` positioning against an `anchorRef`, right-aligned, outside-click + Escape to close, `zz-pop-in z-40 rounded-sm border border-line-2 bg-surface-elevated shadow-pop`.
- Exports `MenuItem` (renders as a button, or a download anchor when given `href`) with an optional sub-label line, plus `MenuSection` / `MenuSep` helpers.
- Trigger is a `Button variant="ghost" size="sm"`.

`app/src/components/OwnerPicker.tsx` — a searchable, scrollable people picker for the owner panel (replaces the flat wall-of-pills, which broke past ~20 users). Filter by name or id, tinted-initials avatars, current owner checked, `No owner` pinned, Enter selects the top match, count footer. Scales to hundreds.

Everything else (gauges, segmented undo/redo, owner chip, changed filter chip, quiet publish readout) is inline markup in `RecordsBody` using existing tokens.

## Non-goals

- No change to any handler or data logic: `exportToCSV`, `onImportFile`, `derive`, `deriveExternal`, `patchDimension`, publish preview/commit, rollback, ordering confirm dialogs, undo/redo, search filter.
- No change to the internals of the Ordering / Owner / History panels — only their triggers move.
- No palette, font, or token changes — dark stays home, light must hold.
- No new capabilities. Every control that exists today remains reachable.

## Success criteria

1. Toolbar renders as Variant 01: identity/gauges left, one accent Publish right, secondary folded into a single `⋯` overflow.
2. Every retained capability reachable: search, sort, undo/redo, export CSV, import CSV, assign owner, version history, re-scan (internal + external), publish, changed filter, engineer-mode prefix. (Snapshot download intentionally dropped — see the ⋯ menu.)
3. Empty state (0 records) shows no dead buttons: Publish/Export self-hide, Data collapses to Import.
4. `npm run` typecheck + lint pass. Dark and light both verified. Manual click-through confirms each action still fires.

## Verification

- `cd app && npm run` (typecheck + lint per project scripts).
- Manual: dark + light theme; a table with drafts (Publish + changed-only visible); a fresh 0-record table (empty state); a viewer role (`!canEdit`); an external-source table (dual-column re-scan).
