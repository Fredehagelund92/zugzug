# Sources keyboard cursor — `j/k` navigation for the warehouse ledger

**Date:** 2026-06-05
**Status:** Design — pending implementation plan
**Scope:** `app/src/routes/Sources.tsx`, `app/src/components/sources/LedgerRow.tsx`, `app/src/components/datagrid/ShortcutsOverlay.tsx`.

## Goal

Give Sources a keyboard cursor consistent with Match mode and Triage so a power user can fly through warehouse columns without touching the mouse. Deferred from the workbench-paradigm spec as "in-page keyboard cursor on Sources — plausible (`j`/`k` walks schemas + expanded rows), but a meaningful chunk of work and not required for paradigm fit. Out of v1; revisit in a power-user pass." This is that pass.

Three drivers:
1. **Vocabulary consistency** — `j`/`k`/`Enter`/`N`/`/` work identically across Match, Triage, and Sources. Muscle memory transfers.
2. **Scale** — 100s of wired warehouse columns need a fast skim affordance; scrolling and mouse hover don't.
3. **Discoverability** — adding Sources to the ShortcutsOverlay surfaces the cursor without requiring users to discover it by trial.

## Decisions

These are settled and not open for re-litigation during implementation:

| Decision | Choice | Why |
|---|---|---|
| What's navigable | LedgerRows only; schema headers stay mouse-only | Matches Triage's row-only model; collapsed schemas hide their rows from the cursor cleanly |
| Enter behavior | Toggle the drill (mirror click) | Conservative, matches existing UX, no new mental model |
| Cursor lifecycle | Lazy — unset on mount, appears on first `j/k`/click | Matches the existing `useGridCursor` pattern in DataGrid (cursor null until first interaction) — no noise for mouse-only users |
| Focused-row treatment | `ring-1 ring-accent/60 bg-accent-wash/40` (same as Match/Triage) | Workbench vocabulary consistency |
| Schema-header navigation | Out of scope (deferred) | Collapsed schemas remain reachable by mouse; rarer interaction, not worth the model complexity in v1 |
| Separate `D` (derive) / `S` (scan) keys | Out of scope (deferred) | Enter-as-drill is enough; we don't need a queue-style action surface in Sources |

## Key bindings

| Key | Action |
|---|---|
| `j` / `↓` | Move cursor to next visible LedgerRow |
| `k` / `↑` | Move cursor to previous visible LedgerRow |
| `Enter` | Toggle the focused row's drill (same as clicking the row) |
| `N` | Jump cursor to next visible LedgerRow with `unmapped > 0`. Wraps around once at the end. |
| `/` | Focus the toolbar search input |
| `Escape` | Clear the cursor (and remove focus ring) |

`A`/`M`/`S`/`R`/`⌘↵` from Match/Triage do NOT apply on Sources. Sources isn't queue-shaped; there's no per-row accept/skip/reset semantic.

## Cursor lifecycle

- **Initial state:** `cursor: null`. No focus ring on any row.
- **First press of `j`/`k`/`N`:** cursor lands on the first visible LedgerRow (top-of-list, in current filter+sort order).
- **Click on a LedgerRow:** also sets the cursor to that row, so the user can mouse-position then take over with `j/k`. Click on the row's interior actions (`ScanScheduleMenu`, derive button, chevron) does NOT move the cursor — only a click on the row body itself. (In practice, clicking the row body is what toggles the drill today; we just additionally set the cursor.)
- **Auto-scroll:** on every cursor change, call `el.scrollIntoView({ block: "nearest", inline: "nearest" })` on the focused row's DOM node. Matches `useGridCursor`.
- **Filter/search/sort changes the visible row set:** if the cursor's row is no longer in the new visible set, clear cursor to `null`. Same pattern as the `useGridCursor` staleness fix (Task 1.4 of workbench-paradigm).
- **`Escape`:** clear cursor.

## Focused-row treatment

`<LedgerRow>` accepts a new `focused?: boolean` prop. When true, the outer `<div>` receives the same classes Match-mode rows use:

```tsx
className={cx(
  "relative bg-surface transition-colors",
  hideStandingBar && "border-b border-line",
  expanded
    ? "bg-surface-2/40"
    : focused
      ? "bg-accent-wash/40 ring-1 ring-accent/60"
      : "hover:bg-surface-2",
)}
```

When the row is BOTH focused AND expanded, expanded wins for the bg-color (so the drill stays visually grouped) but the ring stays — the row reads as "focused while expanded." This matches how Match-mode handles the focus+expand combination.

## Input-focus guard

The route-level `onKeyDown` skips when `e.target` is `HTMLInputElement` / `HTMLTextAreaElement` / `[contenteditable]`. So typing `j` in the search input filters by "j" (existing behavior); typing `/` outside the input focuses the input (new); `Escape` outside the input clears the cursor (new) — `Escape` inside the input clears the search (existing behavior, owned by the input's own handler).

The single exception: `Cmd+Z` / `Cmd+Shift+Z` still need to bubble even when an input has focus — but Sources has no undo stack of its own, so this is a non-concern. We don't need to special-case Cmd-shortcuts here.

## Implementation outline

### `useSourcesCursor()` hook

Local to `Sources.tsx`. Same shape as `useGridCursor` but row-key-only (no column dimension):

```tsx
type RowKey = string; // `${dimId}::${table}::${column}`

interface Cursor {
  key: RowKey;
}

function useSourcesCursor(opts: {
  visibleKeys: RowKey[];
  containerRef: React.RefObject<HTMLElement | null>;
}): {
  cursor: Cursor | null;
  setCursor: (k: RowKey | null) => void;
  move: (delta: 1 | -1) => void;
  jumpToNextNeedsAttention: (rowsWithUnmapped: RowKey[]) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}
```

Internal effects:
1. Auto-scroll on cursor change (via `containerRef.current?.querySelector('[data-row-key="…"]').scrollIntoView`).
2. Staleness normalization: when `visibleKeys` no longer contains `cursor.key`, clear cursor.

### `Sources.tsx` wiring

- Compute `visibleKeys` from `visibleGroups`: flatten all schemas → rows, in render order.
- Compute `rowsWithUnmapped: RowKey[]` from the same flatten, filtered to `r.unmapped > 0`.
- Mount the hook with these inputs.
- Add a `searchInputRef = useRef<HTMLInputElement>(null)` and attach to the existing `<input>` in the toolbar.
- Wrap the existing `<section>` ledger surface with `tabIndex={0}` and `onKeyDown={cursor.onKeyDown}`. The onKeyDown reads the input-focus guard, then dispatches on key:

```ts
const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
  if (e.key === "k" || e.key === "ArrowUp")   { e.preventDefault(); move(-1); return; }
  if (e.key === "Enter") { e.preventDefault(); toggleDrillAtCursor(); return; }
  if (e.key === "N" || e.key === "n") { e.preventDefault(); jumpToNextNeedsAttention(); return; }
  if (e.key === "/") { e.preventDefault(); searchInputRef.current?.focus(); return; }
  if (e.key === "Escape") { e.preventDefault(); setCursor(null); return; }
};
```

`toggleDrillAtCursor` reads the cursor's row key and calls the existing `setExpanded(prev → prev === key ? null : key)`.

### `LedgerRow.tsx` changes

Accept `focused?: boolean`. Conditional class on the outer div per the snippet above. No other behavior change.

### `SchemaSection`

Pass `focusedRowKey` through from Sources → SchemaSection → LedgerRow. SchemaSection compares its rows' keys to `focusedRowKey` and forwards the boolean.

### `ShortcutsOverlay` update

Add a new group `"Sources"` between `"Workbench"` and `"Match · Triage"`:

```ts
{
  title: "Sources",
  rows: [
    ["j / k", "navigate columns"],
    ["Enter", "toggle drill"],
    ["N", "next column with unmapped"],
    ["/", "focus search"],
  ],
},
```

The existing 4-group `sm:grid-cols-2 md:grid-cols-4` becomes a 5-group `sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5` so the layout still fits.

## URL contract

No change. The Sources URL contract (`?focus=&q=&status=&sort=`) doesn't include cursor state. The cursor is session-ephemeral, not deep-linkable — same as Match/Triage.

## Schema and server changes

**None.** All work is in `app/`. The keyboard cursor is pure client-side state; no API changes.

## Risk / regression watch

- **Sticky toolbar `sticky top-0` + scroll-into-view:** the existing scroll region (Sources' inner `<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">`) is the cursor's scroll context. `scrollIntoView` should bring the focused row into the visible area, with the sticky toolbar staying pinned at the top.
- **N's wrap-around:** when the only `unmapped > 0` row is the focused row, N is a no-op (stays put). Same behavior as Triage's `advanceCrossNext`.
- **`/` inside the search input:** typing `/` while focused in the search field should produce a literal `/` character — the input-focus guard handles this.
- **Cursor on a row in a schema that gets collapsed via mouse click:** the row leaves `visibleKeys` → cursor clears. User sees the focus ring disappear but the schema header stays where they collapsed it. Acceptable.

## Testing

Test approach mirrors the workbench-paradigm plan: unit tests for the pure cursor logic, manual smoke for the integrated UI.

| Layer | Coverage |
|---|---|
| Unit | `useSourcesCursor` core logic: `move(1)` from null lands on first key; `move(1)` past end stays at end; `move(-1)` from null lands on first; cursor clears when `visibleKeys` no longer contains it; `jumpToNextNeedsAttention` wraps correctly. |
| Manual | Walk Sources with `j/k`, verify focus ring + scroll-into-view; press `Enter` to toggle drill; press `N` to skip clean rows; press `/` to focus search; type in search → verify `j/k` doesn't fire; press `Escape` outside input → cursor clears; collapse a focused-row's schema via mouse click → cursor clears. |

## Files touched (estimate)

- `app/src/routes/Sources.tsx` — `useSourcesCursor` hook, `onKeyDown` handler, `searchInputRef`, `focusedRowKey` plumbing
- `app/src/components/sources/LedgerRow.tsx` — `focused?: boolean` prop + conditional classes
- `app/src/components/sources/SchemaSection.tsx` (or wherever the inline `SchemaSection` lives in Sources.tsx today) — pass `focusedRowKey` through
- `app/src/components/datagrid/ShortcutsOverlay.tsx` — new "Sources" group, grid columns bump
- `app/test/sources-cursor.test.ts` — new test file for `useSourcesCursor`

## Open questions — implementer call

These are calls deferred to implementer judgment, not blockers:

1. **Should `j` past the last visible row trigger "Load more" pagination?** If user has scrolled through all 60 shown rows and there are more behind the `Load more →` button, does `j` past the last row auto-load? **Recommendation: no.** Surprising and breaks the "j stops at the end" mental model. User clicks "Load more" with mouse if they want more rows.
2. **Should Tab also move between rows?** Tab is reserved for normal focus traversal (toolbar → ledger → footer). **Recommendation: leave Tab alone**, use only `j/k`. Matches Triage.
3. **Should the cursor survive route navigation?** If a user navigates to `/app/tables` then back to `/app/sources`, does the cursor restore? **Recommendation: no.** The cursor is session-ephemeral; no need to persist. Same as Match/Triage.
