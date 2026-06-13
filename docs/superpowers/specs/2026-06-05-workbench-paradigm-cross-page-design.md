# Workbench paradigm — extending tables-multitab to Triage, Sources, and per-table modes

**Date:** 2026-06-05
**Status:** Design — pending implementation plan
**Scope:** `app/src/routes/MasterTables.tsx`, the deletion of `app/src/routes/Mapping.tsx`, a new `app/src/routes/Triage.tsx`, light additions to `app/src/routes/Sources.tsx`, sidebar nav rename in `AppShell`, plus three new per-mode body components.

## Goal

Extend the "tables workbench" paradigm (multi-tab strip · per-pane UndoStack · DataGrid · sidebar tree, landed on branch `tables-multitab`) across Match values and Sources so the app reads as one workbench rather than four routes that each reinvent navigation. Three drivers locked during brainstorming:

1. **Cohesive workbench feel** — the sidebar tree is the spine; the active tab is the unit of work.
2. **Power-user parity** — keyboard navigation, undo, and mode-switching feel identical wherever they appear.
3. **Triage workflow speed** — Match-decisions and per-table curation share state without route-switch friction.

Code consolidation is **not** a driver. We adopt primitives where they earn; we keep bespoke surfaces where they earn.

## Headline shift

The entity in the workbench is a **master table** — which may be:
- **Sourced + mapped** — warehouse values flow in, get reconciled (Partner, Region, Country)
- **Static reference** — curated rows with numeric/text columns, no source reconciliation (currency rules, fee tiers)
- **Hybrid** — both

Each table tab carries a **mode strip** gated by what the table supports:

| Table shape | Modes shown |
|---|---|
| Sourced (any warehouse wiring) | `Records · Match values · Wired sources` |
| Static reference (no source wiring) | `Records` (alone, no strip) |

A static reference table opens with just a grid and no mode-strip noise. Adding source wiring later just unlocks the other modes inside the same tab. Match values appears as soon as wiring exists — an empty Match body shows "Nothing to match yet"; that's a valid state, and gating it differently would lie about the table's intent.

The **Mapping route is deleted.** Its two jobs split honestly: the per-table single-dim work moves into the **Match values** mode of each table tab; the cross-table impact queue promotes to its own top-level route, **Triage**.

## Non-goals (deferred)

- **Multi-tab in Sources.** Verified: schemas-as-tabs would force the Standing callout into a global banner above the strip, breaking its organic relationship to the ledger surface. Sources is investigation, not parallel workbenches.
- **DataGrid in Sources.** Verified: LedgerRow's standing bar, ScanScheduleMenu, and derive button don't collapse cleanly into ColumnDefs. Keep LedgerRow.
- **PALETTE TabMono colors in Sources or Match-mode chrome.** Reserved for surfaces where they identify *which table* a row belongs to (Triage rows, workbench tab strip, sidebar tree). On single-table surfaces they fight accent-as-status disciplines.
- **Density toggle on Sources.** Sources' bespoke ledger density matches its task; a toggle implies grid parity that doesn't exist.
- **In-page keyboard cursor on Sources.** Plausible (`j`/`k` walks schemas + expanded rows), but a meaningful chunk of work and not required for paradigm fit. Out of v1; revisit in a power-user pass.
- **Cross-tab bulk-accept in Triage.** Triage stays one-at-a-time; per-table bulk lives in per-table Match mode where consequences are scoped.
- **Per-mode undo stacks.** One stack per tab, shared across modes; the UX confusion is mitigated by labeling the surface on each undo entry (see Section 4).

## Architecture

```
┌──────────────┬────────────────────────────────────────────┐
│ SIDEBAR      │  WORKBENCH ROUTE (/app/tables)             │
│              │                                            │
│ Master data  │  [◼ Partner] [◻ Region] [◻ Currency] [+]   │  ← TableTabStrip
│              ├────────────────────────────────────────────┤
│ Tables       │   Records · Match values · Wired sources   │  ← mode strip
│  ◼ Partner   │   ─────                                    │     (per-tab; gated)
│  ◻ Region    │                                            │
│  ◻ Currency  │   [active mode body]                       │
│              │                                            │
│ ─────        │   ┌─────────────────────────────────────┐  │  ← sticky footer
│ Dashboard    │   │ Match drafts footer (Match mode)    │  │     (per-tab)
│ Triage ·23   │   └─────────────────────────────────────┘  │
│ Sources      └────────────────────────────────────────────┘
│ Settings
└──────────────
```

Four hookup points; each page changes at most one place.

### Route map

```
/app/dashboard               glance
/app/tables                  workbench — per-table tabs with mode strip
/app/triage                  cross-table impact queue (was Mapping all-dim mode)
/app/sources                 investigation surface (unchanged in shape)
/app/settings                unchanged
```

`/app/mapping` is deleted at the route level. Its legacy URL forms redirect via a React Router `loader` — see Section 7.

## Vocabulary

UI surfaces use plain **"Table"** as the noun, with "Master data layer" only as the framing kicker (already present in the sidebar). The cross-table queue route is **"Triage"**. The per-table mode reading from source values stays **"Match values"** (accurate at the table level).

Code stays `MappingDimension` and `dim_*` / `map_*` prefixes — load-bearing in the data model. The renaming is a UX/conceptual layer, not a database migration.

## Section 1 — Per-table mode strip

### Visual treatment

Lift the Mapping segmented control (`app/src/routes/Mapping.tsx:719-772`) and **move it from above the workbench to inside each tab pane.** Same sliding-pill indicator, same `var(--ease-spring)` motion, same display-font primary label + mono kicker pattern. Each tab gets its own.

Anatomy per mode segment:
- **Records** — display-font label, no kicker, no badge.
- **Match values** — display-font label, accent count badge showing this table's `new`-status count. When zero: badge hidden, label muted.
- **Wired sources** — display-font label, optional warn-tone dot when any wired column has `unmapped > 0`.

Active treatment matches the segmented control: `bg-surface-elevated shadow-pop-sm ring-1 ring-line` on the active pill, `text-ink-3` on inactive labels.

### Mode gating — `availableModes` helper

The gating predicate is a single helper computed from data, called by both the mode strip (to decide what to render) and defensively by mode bodies:

```ts
type Mode = "records" | "match" | "sources";

function availableModes(
  dim: MappingDimension,
  sources: SourceInfo[],
): Mode[] {
  const hasSourceWiring = sources.some((s) => s.dimId === dim.id);
  return [
    "records",
    ...(hasSourceWiring ? (["match"] as const) : []),
    ...(hasSourceWiring ? (["sources"] as const) : []),
  ];
}
```

**Both Match values and Wired sources gate on `sources.some(s => s.dimId === dim.id)`** — the durable "this table participates in mapping" signal. NOT on `dim.values.length > 0`, which would silently hide the entire workbench whenever `ATTACH_WAREHOUSE` is off (the default).

A table with source wiring but a fully-mapped state still shows Match mode (the queue is empty but the mode exists). A table with no wiring shows neither Match nor Wired sources — just Records. When `availableModes(...).length === 1`, the strip renders nothing; the mode body fills the pane directly.

### Mode body contents

| Mode | Lifts from | Stripped | Kept |
|---|---|---|---|
| Records | `TablePane` body (current) | nothing | DataGrid, density toggle, row numbers, column header menu, UndoStack |
| Match values | `MappingInner` single-dim workbench `<div>` (`Mapping.tsx:830-1370`) | PageHeader, TablePicker, view-mode segmented control, Auto-match-in-header | row layout, ComboSelect+suggestion, filter chips (Needs/All/Mapped), confidence bar, expandable provenance, sticky drafts footer, A/M/S/R/N/⌘↵ shortcuts, UndoStack |
| Wired sources | Condensed `LedgerRow` list filtered by `sourceInfo.dimId === dim.id` | schema accordion grouping (only one table here), Standing callout, Browse warehouse button | LedgerRow, ScanScheduleMenu, derive button, status chip, expandable unmapped sample |

The Auto-match button moves from `PageHeader.action` into a small left-aligned toolbar at the top of the Match mode body. Same `zz-glow-sm` treatment, smaller scale.

### Body component contract

Body components take a **fully resolved `dim: MappingDimension`** as a prop, not `dimId: string`. The parent (`MasterTables`) holds the `dimById` map and early-exits with `if (!dim) return null` before mounting. This eliminates the `MappingDimension | undefined` case inside body components and removes the silent `dims[0]` fallback that exists in `MappingInner` today (`Mapping.tsx:146`) — which would, post-lift, cause one tab to silently show another dim's data including draft mutations closured over the wrong `dimId`.

```tsx
// In MasterTables.tsx
{tabs.map((tab) => {
  const dim = dimById.get(tab.dimId);
  if (!dim) return null;                       // explicit gate
  const modes = availableModes(dim, sources);
  const mode = activeMode(tab, modes);         // URL > localStorage > "records"
  return (
    <div key={tab.id} hidden={tab.id !== activeTabId}>
      <TablePane dim={dim} mode={mode} modes={modes} />
    </div>
  );
})}
```

### State persistence — URL is truth, localStorage is write-through cache

```
zugzug:tab-mode:<dimId> → "records" | "match" | "sources"
```

URL `?mode=X` is the source of truth when present and writes through to localStorage on tab focus. localStorage feeds the URL fold only at mount. Default for a brand-new tab is `"records"`.

We do **not** push mode into `app.user_grid_layout`. That table is scoped to DataGrid column layout (widths, order, hidden); mode is a different concern at a different persistence tier.

### Keyboard

| Key | Action |
|---|---|
| `⌥1 / ⌥2 / ⌥3` | switch mode within active tab; disabled segments skipped |
| `[` / `]` | previous/next mode within active tab |
| `Cmd+1 … Cmd+9` | switch tab by position |

Mode shortcuts respect "not editing": if the grid cursor is in edit mode, `⌥1` is a no-op. Within-mode shortcuts (A/M/S/R/N/⌘↵ in Match; Cmd+Z everywhere; ? for shortcuts overlay) are untouched.

### Per-tab sticky footer (architectural verification)

Each tab pane is already its own DOM subtree (`<div hidden={!isActive}>`), so the Match-mode sticky footer naturally scopes to that pane's scroll container. Requirement to verify before Step 3: each tab pane is `flex flex-col h-full min-h-0` with its content as the overflow:auto child. Test: open two tabs in Match mode with different draft states; review-open in one must not bleed into the other.

## Section 2 — Triage route (`/app/triage`)

The cross-table impact-sorted queue. Lifts `CrossDimInbox` (`Mapping.tsx:1373` onward) into its own route.

### Header

PageHeader stays (unlike Tables, which strips it). Triage is a verb the user navigates to deliberately; the header reinforces what surface you're on, and it carries live counts. No primary action button — Publish lives in the sticky footer.

- kicker: `WORKFLOW`
- title: `Triage · 23 across 4 tables`
- lede: `Sorted by blast radius. Press ⌘↵ to publish.`

### Row layout

```
[▸] [TableChip] [raw value · sources]    [→ target / picker]    [conf · %]   [status]
```

`TableChip` is the inline TabMono — same component as the tab strip, just rendered inline. **Per-table PALETTE color earns here** because the chip *is* the identifier. (This is the resolution to the color-discipline tension: PALETTE colors only appear where they identify which table a row belongs to; in single-table surfaces, they don't appear at all.)

Target column reuses the same `ComboSelect` / picker as Match mode. **Inline pick stays in queue** — Triage is queue-draining, not deep-context work. A hover-revealed `↗ open in workbench` icon per row jumps to `/app/tables?open=<dim>&active=<dim>&mode=match&value=<raw>` for the explicit per-table context.

### Filter chips, sticky footer, keyboard

Filter chips (`Needs review` / `All` / `Mapped`) sit below the header, above the queue — same pattern as Sources' toolbar so visual rhythm carries between routes.

Sticky footer lifts `approveAndCommitAll` (`Mapping.tsx:474`). Same `↶ Undo · Review N · Publish N changes` pattern, same `zz-rise` flash on success, same grouped-by-target staged-drafts list.

Keyboard is identical to today's all-mode in `MappingInner`:

| Key | Action |
|---|---|
| `↑ ↓` / `j k` | move cursor through visible rows |
| `Enter` | open picker on focused row |
| `A` | accept suggestion |
| `M` | open picker (explicit) |
| `S` | skip |
| `R` | reset draft |
| `N` | jump to next "new" row |
| `Cmd+Z` / `Cmd+Shift+Z` | undo / redo |
| `Cmd+Enter` | publish all |
| `?` | shortcuts overlay |
| `/` | focus filter chip |

Uses `useGridCursor` (same primitive as Match mode and Records mode), so the focused-row treatment is identical to elsewhere.

### Empty states

- `filter=new` and queue empty: `Nothing to triage today.` + nudges to Tables (curation) and Sources (wire more). Tone: success.
- `filter=mapped` and empty: `Nothing has been mapped yet.` + link to Needs review.
- Zero tables: route shows workspace-empty placeholder pointing at Tables.

### Sidebar count badge

Sidebar bottom-nav row reads `Triage  · 23` — same `totalNew` derivation that exists in `AppShell` today, renamed from "Match values."

### Triage explicitly is NOT

- No provenance drawers (no expandable rows). For provenance, jump to the table.
- No SQL preview / engineer-mode toggle (per-table concern).
- No bulk-select. Cross-table bulk-accept would be useful for "all high-confidence everywhere," but consequences are easier to reason about when scoped per-table. Defer.

## Section 3 — Sources (selective adoption)

Sources stays a single-surface investigation route.

### Stays unchanged

- PageHeader with live `dashboardSentence` lede (load-bearing — real-time metric)
- Standing callout (the accent-as-urgency hero — page chrome, not absorbed anywhere else)
- Ledger surface with gradient folder-tab edge (earns precisely because there's no tab strip above)
- SchemaSection accordions; LedgerRow with ScanScheduleMenu and derive button
- Toolbar: search + status pills + sort select
- Accent reserved for Standing callout + unmapped counts (`Sources.tsx:34` comment is the locked rule)
- Schema auto-expand heuristic

### Adopts

1. **URL vocabulary.** Sources today persists nothing to the URL. Add:
   ```
   /app/sources?focus=<schema>&q=<search>&status=needs|all|clean&sort=impact|recent|name
   ```
   `focus` deep-link-expands a schema. The other three persist toolbar state across reloads. Mirrors the URL-as-truth pattern used by Tables and Triage.

2. **Deep-link target update.**
   - `ExpandedDrill` "Resolve in Match values →" link: `/app/mapping?dimId=...` → `/app/tables?open=<dim>&active=<dim>&mode=match`
   - Standing callout "Resolve" button: same update

3. **Shared status tone tokens (not full Chip component).** LedgerRow's standing label (`clean` / `drift` / `stale drift` / etc.) keeps its plain-text treatment — adding `<Chip>` pills here would muddy the ledger's intentional lightness. But the *tones* unify with the rest of the app: `text-ok` / `text-warn` / `text-ink-3` become the canonical scale shared with the DataGrid Chip. No visual change today; one less divergence point tomorrow.

4. **Reverse handoff from workbench → Sources.** Per-table Wired sources mode (Section 1) gets a `View in Sources →` link in its toolbar area, jumping to `/app/sources?focus=<schema>` of the first wired column.

### Explicitly NOT adopted

- DataGrid (LedgerRow has affordances that don't collapse into ColumnDefs)
- Multi-tab strip (no entity model for "open multiple schemas")
- PALETTE TabMonos (collides with accent-as-urgency)
- Density toggle (bespoke density matches the ledger feel)
- In-page keyboard cursor (worthwhile, but defer to a later power-user pass)

## Section 4 — UndoStack labeling

One UndoStack per tab, shared across modes within that tab. To avoid the "I pressed undo while in Match mode and my Records cell reverted" confusion, the `UndoEntry` interface adds an optional `surface` field:

```ts
interface UndoEntry {
  apply: () => Promise<void>;
  inverse: () => Promise<void>;
  label: string;
  surface?: string;     // "Records" | "Match" | undefined
}
```

The Undo button renders the surface alongside the label when present:

```
↶ Undo (Match): match "BetMagic" → BetMGM
```

Each undoable mutation tags its surface at push time. Cross-mode entries (e.g., renaming a canonical record from Records, then switching to Match) remain technically correct — the closures fire against the right `dimId` regardless of the visible mode — but the user sees which surface the inverse will land on before pressing Cmd+Z.

No per-mode stacks. No reducer changes. Single optional string field, single label update.

## Section 5 — `useOpenTabs` hardening

Today `TAB_PREFIX = "tables:"` is hardcoded and `OpenTab.id` is a branded `TabId` string. The branding is type-level only; at runtime any string cast with `as TabId` gets through. Two cheap fixes before Step 3:

1. **Validate in `readStored`.** When deserializing from `localStorage`, check `id.startsWith(TAB_PREFIX)` and `parsed.tabs` is an array. Stale or corrupt entries get dropped, not silently passed through.
2. **Assert in `dimIdFromTabId`.** Defensive runtime guard so a bad ID throws explicitly rather than returning garbage.

No prefix generalization — Triage has no tabs in this design and won't get any.

## Section 6 — Cursor staleness normalization

`useGridCursor` receives `rows: visibleRows` as a dependency. When the active mode changes and the previous mode's pane is hidden (`<div hidden>`), the cursor reference is still live. If `visibleRows` changes while hidden (e.g., a background draft save shifts a row's `status` and the filter chips exclude it), the cursor's `rowKey` may point to a row no longer in `visibleRows`. Cursor type is `Cursor | null` — "stale vs. valid" isn't expressed.

Fix: in the cursor's `rows` `useEffect`, validate `cursor.rowKey` is still present in the next `visibleRows`; if not, clear to `null`. One-line normalization, no API change.

## Section 7 — URL contract + legacy redirects

### Locked URL contracts

```
/app/dashboard
/app/tables?open=a,b,c&active=<dim>&mode=records|match|sources[&value=<raw>]
/app/triage?filter=new|all|mapped
/app/sources?focus=<schema>&q=<search>&status=needs|all|clean&sort=impact|recent|name
/app/settings
```

Rules:
- `mode` reflects the *active* tab's last-used mode. When `active` changes, `mode` updates to that tab's localStorage value.
- `value` is honored only when `mode=match`; ignored otherwise.
- Sources query params persist live (debounced) as the user interacts with the toolbar.
- Triage's `filter` defaults to `new`; the param appears in URL only when non-default.

### URL-as-truth, localStorage-as-write-through

Treat URL as the canonical state for active tab + mode. Parse `searchParams` on every render (cheap), write back after every mutation. localStorage feeds the URL fold only at mount (the "last known mode per dim" hint), and is written through on URL change. No in-flight divergence.

### Legacy redirects — React Router `loader`

```
/app/mapping                            → /app/triage
/app/mapping?view=all                   → /app/triage
/app/mapping?view=all&filter=X          → /app/triage?filter=X
/app/mapping?dimId=X                    → /app/tables?open=X&active=X&mode=match
/app/mapping?dimId=X&value=Y            → /app/tables?open=X&active=X&mode=match&value=Y
/app/mapping?dimId=X&view=single        → same as ?dimId=X
```

Implemented as a React Router `loader` returning `redirect()` (not `<Navigate>`). The loader interrogates the live `dims` snapshot from the store — if the legacy `dimId` no longer exists, it redirects to `/app/tables` with no `open` param (and surfaces a one-shot toast: "That table no longer exists"). Explicit handling beats the current implicit "unknown ID silently ignored" behavior.

## Section 8 — Schema and server changes

**None.** localStorage holds per-table mode preference. No `app.user_grid_layout` extension. No Postgres migration. All work is in `app/`. Mapping → Triage is component-lift; per-table Match mode reuses existing `useDimensions` / `useDrafts` / `commit` store functions, which are already dim-scoped.

## Section 9 — Implementation order

Five steps, each shippable. No step depends on a later step landing.

| # | Step | Lands | Visible to user |
|---|---|---|---|
| 1 | **URL contract + legacy redirects** | Loader-based redirect rules for every `/app/mapping` URL form; standardize `dimId`; add Sources query params; `useOpenTabs` hardening (`readStored` validation, `dimIdFromTabId` assertion) | Nothing changes visually. Bookmarks survive everything later. |
| 2 | **Triage route** | Lift `CrossDimInbox` out of `MappingInner` to `/app/triage`; rename sidebar nav "Match values" → "Triage"; update Dashboard CTA; loader for `/app/mapping?view=all` now active | All-dim queue gets a real home. Single-dim mapping still works via legacy URL. |
| 3 | **Per-table Match mode** | `availableModes` helper; mode strip in `<TablePane>` (Records + Match only — Sources mode comes in Step 4); lift `MappingInner` single-dim body into `<MatchModeBody dim>`; localStorage mode persistence; cursor staleness normalization; UndoStack `surface` field + label update; legacy `/app/mapping?dimId=X` now redirects to workbench | Mapping route deleted (lives only as loader redirects). Match work happens inside Partner's tab. Sources' "Resolve" links land correctly. |
| 4 | **Wired sources mode** | Third mode segment (gated on `sources.some(s => s.dimId === dim.id)`); lift condensed `LedgerRow` filtered by `dimId` into `<WiredSourcesModeBody dim>`; add `View in Sources →` reverse handoff | Workbench tab has all three modes when applicable. Bidirectional handoff complete. |
| 5 | **Glue & polish** | Sliding-pill mode-strip indicator (lift from old segmented control); `⌥1/⌥2/⌥3` mode keys; `Cmd+1..9` tab keys; ShortcutsOverlay updates; Sources Chip tone token unification | The full paradigm reads coherent. Power-user keys arrive. |

After Step 1: nothing changes but no future link breaks.
After Step 2: stewards get a real Triage route. Dashboard handoff improves.
After Step 3: workbench feels like the place to live. Mapping route's UX inconsistency goes away.
After Step 4: per-table tab is the complete unit of work.
After Step 5: the paradigm reads as polished.

## Section 10 — Risk / regression watch

- **Step 3 is the biggest single component move.** `MappingInner` is ~1100 lines today; after `CrossDimInbox` lifts in Step 2, the remainder is ~700 lines. Land Step 3 behind a feature flag so we can revert without rolling back the URL contract.
- **Per-tab sticky footer.** Each tab pane must be `flex-col h-full min-h-0` with its body as the overflow:auto child. Test with two tabs in Match mode with different review-open states.
- **Cursor staleness across hidden panes.** Normalize when `visibleRows` shifts; ensure hidden tabs don't accumulate stale cursors.
- **UndoStack across mode switches.** Inverses fire correctly (closures); UX risk mitigated by `surface` field on the label. Watch for support tickets after launch — if the labeling isn't enough, retrofit per-mode stacks.

## Testing

| Step | Coverage |
|---|---|
| 1 | Unit: every legacy URL form maps correctly through the loader; `readStored` rejects corrupt localStorage entries; `dimIdFromTabId` throws on malformed IDs. |
| 2 | Integration: Dashboard CTA → Triage lands correctly; bulk publish across tables works; old `/app/mapping?view=all` URL lands on Triage. |
| 3 | Integration: `/app/mapping?dimId=X` redirects to workbench Match mode with cursor pinned; localStorage persists mode across tab close/reopen; deleting a dim mid-session does not silently switch a tab's content; cursor clears when row leaves `visibleRows`; UndoStack labels show surface. |
| 4 | Integration: mode strip shows correct subset per table shape (static reference vs sourced+mapped); reverse handoff link lands on Sources with `?focus=` set. |
| 5 | E2E (Playwright) golden paths: (a) Dashboard → Triage → publish → open Partner → switch to Match → drafts visible as committed; (b) Sources → drill column → "Resolve" → workbench Match mode lands correctly with cursor pinned. |

## Open questions — implementer call

These are calls deferred to frontend / UI judgment during implementation, not blockers:

1. **Auto-match button placement in Match mode.** Above the mode body as a small left-aligned toolbar (preserves the `zz-glow-sm` moment), or absorbed into the filter chip strip for compactness?
2. **Mode strip rendering when only Records exists.** Render nothing (clean), or render a degenerate single-pill (consistent)?
3. **`Cmd+1..9` tab switching.** Worth adding in Step 5 even though it's not strictly required by the paradigm extension? It's a power-user win the multi-tab paradigm earned but never claimed.
4. **Standing callout vs sidebar Triage badge — microcopy clarification.** Both surface "work to do" at different scopes (column-level vs value-level). Worth a small clarifying line in the callout, or does the visual context (Sources route vs sidebar nav) make it obvious?
5. **Reverse handoff link visibility.** `View in Sources →` inside Wired sources mode — visible always, or only when this table has ≥2 schemas of source wiring (when seeing the broader warehouse view actually helps)?
6. **`?focus=<schema>` interaction with auto-expand.** Open that schema in addition to whatever auto-expand decided (preserves user intent), or override and open only that schema?

## Files touched (estimate)

- `app/src/routes/MasterTables.tsx` — mode strip, `availableModes` integration, body resolution
- `app/src/routes/Mapping.tsx` — **deleted** at end of Step 3 (replaced by `MatchModeBody` + `Triage` route)
- `app/src/routes/Triage.tsx` — **new** (Step 2)
- `app/src/routes/Sources.tsx` — URL params, deep-link target updates, Chip tone tokens
- `app/src/components/TablePane.tsx` — mode strip rendering, mode body switching
- `app/src/components/modes/MatchModeBody.tsx` — **new** (Step 3; the big lift)
- `app/src/components/modes/WiredSourcesModeBody.tsx` — **new** (Step 4)
- `app/src/components/modes/ModeStrip.tsx` — **new** (Step 5 polish; the sliding-pill indicator)
- `app/src/components/AppShell.tsx` — sidebar nav rename, command palette URL updates
- `app/src/components/datagrid/UndoStack.tsx` — `surface` field on `UndoEntry`, label rendering
- `app/src/lib/open-tabs.ts` — `readStored` validation, `dimIdFromTabId` assertion
- `app/src/lib/available-modes.ts` — **new** helper
- `app/src/lib/tab-mode.ts` — **new** localStorage + URL-fold helper
- `app/src/main.tsx` — route table: add Triage, replace Mapping with redirect loader
