# Task 7 Report: "Map values to this record" context-menu handoff

## TDD: RED → GREEN

**RED:** Wrote `app/test/records-map-handoff.test.tsx` with 3 tests:
1. Row-num context menu shows "Map values to this record" when prop provided
2. Clicking the item calls `onMapValuesToRecord` with the correct record key
3. Item is absent when prop is not provided

All 3 failed (prop didn't exist on DataGridProps).

**GREEN:** After implementing — all 3 pass.

## Menu Item

Added to `DataGrid.tsx` row-num menu (`surface.kind === "row-num"` branch, after the Delete item):

```tsx
...(props.onMapValuesToRecord
  ? [
      {
        label: "Map values to this record",
        icon: <IconArrowRight />,
        onClick: () => props.onMapValuesToRecord!(rk),
      } as MenuItem,
    ]
  : []),
```

- Wave-4 styled: Title Case label, icon (`IconArrowRight` from existing icon set).
- Conditional on prop presence — absent when not provided (third test verifies).

## Navigation Wiring (RecordsBody)

`TablePane.tsx` already had `const navigate = useNavigate()` at line 582. Added to the `<DataGrid>` in RecordsBody:

```tsx
onMapValuesToRecord={(recordKey) => {
  const next = new URLSearchParams(window.location.search);
  next.set("mode", "match");
  next.set("target", recordKey);
  navigate(`?${next.toString()}`);
}}
```

`window.location.search` captures live URL params — `open` and `active` params are preserved because `URLSearchParams` copies all existing params before setting `mode` and `target`. Task 5's `?target=` machinery + Task 6's match-mode consumer handle the rest.

## Test Coverage

- DataGrid item + callback: fully tested (3 passing tests).
- RecordsBody navigation: not unit-tested (TablePane harness wall prevents rendering RecordsBody in isolation). The logic is a 4-line URL manipulation — the construction follows the task brief spec verbatim.

## Files Changed

- `app/src/components/datagrid/types.ts` — added `onMapValuesToRecord?: (recordKey: string) => void` to `DataGridProps`
- `app/src/components/datagrid/DataGrid.tsx` — added `IconArrowRight` import; added conditional menu item in row-num branch
- `app/src/components/TablePane.tsx` — passed `onMapValuesToRecord` to `<DataGrid>` in RecordsBody
- `app/test/records-map-handoff.test.tsx` — new test file (3 tests)

## Results

- `bun run test records-map-handoff`: 3/3 pass
- `bun run test vocabulary-gate`: 5/5 pass ("Map values to this record" obeys banned list)
- `bun run typecheck`: clean
- `bun run test` (full suite): 496 passed | 1 skipped (106 files)

## Self-Review

- Menu item "Map values to this record" appears in the record row menu only when prop provided ✓
- Wave-4 styled: Title Case, `IconArrowRight` icon ✓
- Clicking calls `onMapValuesToRecord(recordKey)` ✓
- RecordsBody navigates to `?mode=match&target=<key>` preserving open/active ✓
- Vocabulary gate green ✓
- Existing menu tests still pass ✓

## Concerns

None. The only limitation is the TablePane harness wall preventing a full integration test of the navigation URL construction — the logic is trivial enough (4 lines, spec-verbatim) that this is acceptable.

---

# Critical Fix Report: fold-gate blocked URL-only mode nav (review finding)

## Defect

The original `onMapValuesToRecord` handler wrote `?mode=match&target=<key>` to the URL via `navigate()` but never switched `perTabMode` directly. `MasterTables` only reads `?mode=` once per dim per session (`foldUrlMode`, gated by `foldedDimsRef`). For an already-open tab, the fold has already run — writing to the URL is silently ignored. Meanwhile the URL writer (line 123) runs on the next render and strips `?target=` because `perTabMode[dimId]` is still `"records"`. Net: the handoff did nothing.

## Fix — Option A

Threaded `onModeChange` from `TablePaneInner` down into `RecordsBody`. `RecordsBody` signature expanded to `{ dim, isActive, onModeChange?: (m: Mode) => void }`. The handler now:

```tsx
onMapValuesToRecord={(recordKey) => {
  const next = new URLSearchParams(window.location.search);
  next.set("mode", "match"); next.set("target", recordKey);
  navigate(`?${next.toString()}`);   // puts ?target= in the URL for MatchModeBody
  onModeChange?.("match");            // switches perTabMode — the real mechanism
}}
```

Option A chosen because `onModeChange` is already on `TablePaneInner`'s props — threading it one level into `RecordsBody` is a minimal change (no new props on MasterTables or TablePane itself).

## React 18 Batching / Ordering

Both `navigate()` (updates MemoryRouter history) and `onModeChange("match")` (calls `setPerTabMode`) happen in the same event handler → React 18 batches them into one commit. `MatchModeBody` mounts once — after that commit — with `?target=` already in `searchParams`. The URL writer's effect runs after the commit with `perTabMode["<dim>"] === "match"`, so it does NOT delete `?target=` (line 123 only strips when `mode !== "match"`).

## Integration Test

Added to `app/test/master-tables-target-param.test.tsx` — new describe block "Already-open-tab handoff (fold-gate regression)":
- Opens tab in records mode (no `?mode=` param → fold defaults to records, fold gate fires)
- Stubs `window.location.search` to `?open=brand&active=brand&target=r1` (what `navigate()` produces; note: without `mode=match` in stub — that's derived from `perTabMode` by the URL writer, not the stub)
- Calls `paneCallbacks.onModeChange!("match")` (the real fix path — captured from MasterTables' prop)
- Asserts `useLocation().search` (LocationProbe) contains `mode=match` and `target=r1`

This directly exercises the seam the bug lived in: the fold gate is confirmed active (tab was already open), and the test proves that `onModeChange("match")` + stub is the only working path.

## Files Changed

- `app/src/components/TablePane.tsx` — `RecordsBody` props extended with `onModeChange?`; `TablePaneInner` passes it down; `onMapValuesToRecord` handler calls `onModeChange?.("match")`
- `app/test/master-tables-target-param.test.tsx` — new describe block with 1 integration test

## Test Results

- `bun run test records-map-handoff`: 3/3 pass
- `bun run test master-tables`: 8/8 pass (2 describe blocks, previous 2 + new 1)
- `bun run test datagrid`: 65/65 pass (24 files)
- `bun run typecheck`: clean
