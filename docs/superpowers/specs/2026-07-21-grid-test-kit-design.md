# Design: grid test-kit + core-interaction suite

**Date:** 2026-07-21
**Status:** Approved (pending spec review)
**Goal:** Give the data grid — the app's largest, most interaction-heavy surface, currently with **zero** automated component tests — a rerunnable safety net. Build a reusable RTL/jsdom **test-kit** (render helper, fixtures, interaction driver, DOM queries) and a **core-interaction suite** on top of it. Foundation-first: later plans layer copy/paste, fill, sort/filter, column ops, and per-type editors onto the same kit.

## Background (verified against the code)

- Grid lives in `app/src/components/datagrid/`. `DataGrid.tsx` (1688 lines) orchestrates; `useGridCursor.ts` (451) owns keyboard nav; `UndoStack.tsx` owns undo/redo; nine cell editors under `cells/`.
- **No `datagrid/` test exists.** The interaction surface (nav, edit, range-select, copy/paste, fill, undo, sort, filter, column ops, virtualization) is verified only manually. `server/src/verify-datagrid.ts` tests the **server repo layer** (Postgres), not the frontend, and isn't in CI.
- **Tooling is already present**: vitest 4 + jsdom + `@testing-library/react` + `@testing-library/user-event`. Crucially, `app/test/setup.ts` already polyfills `scrollIntoView`, `getBoundingClientRect` (→ 800×600), `ResizeObserver` (synchronous), `IntersectionObserver`, and `localStorage` — specifically so TanStack Virtual mounts rows in jsdom. The virtualizer renders in tests today.
- **`DataGrid` is store-agnostic.** Required props are only `rows`, `rowKey`, `columns`. `onCommit?` undefined ⇒ read-only. The single context requirement is `UndoStackProvider` (`useUndoStack` throws `"useUndoStack outside <UndoStackProvider>"`). No toast/presence provider needed — presence is a prop; network/toasts live in `TablePane`, not the grid.
- **Undo isolation gotcha**: `UndoStack` keeps stacks in a **module-level map keyed by `scopeKey`, never cleared** (so history survives tab switches). Without isolation, tests bleed undo state into each other.
- **CI**: `.github/workflows/ci.yml` app job runs `cd app && bun run test` (`vitest run`) on every push/PR. New `*.test.tsx` are auto-discovered — no CI change needed. Local: `bun run test` / `bun run test:watch`.

## Non-goals (deferred to later plans, on the same kit)

Copy/paste (jsdom has no real `navigator.clipboard`), pointer-drag fill-handle / mouse range-drag / column resize & reorder (synthetic pointer events are unreliable in jsdom), sort, filter, column-header-menu ops, conditional formatting, aggregates, deep per-type editor tests (date/select/linked/rating/url/email), and **real wall-clock performance benchmarking** (needs a real browser — see Scale section). These are listed so the boundary is explicit, not silent.

## Architecture

Test-kit + suite, co-located under the grid so the existing CI job covers them:

```
app/src/components/datagrid/
  test-kit/
    render-grid.tsx        # renderGrid(overrides) → the entry point
    fixtures.ts            # makeColumns(), makeRows(n), canonical dataset
    driver.ts              # keyboard/interaction driver over user-event
    queries.ts             # DOM readers for cursor/selection/editing/cell state
    render-grid.test.tsx   # smoke test for the kit itself
  navigation.test.tsx
  editing.test.tsx
  selection.test.tsx
  undo.test.tsx
  scale.test.tsx           # virtualization-at-10k guard
```

### Component: `render-grid.tsx`

`renderGrid(overrides?)` renders `DataGrid` and returns a handle. Responsibilities:
- Default `rows`/`rowKey`/`columns` from `fixtures.ts`; shallow-merge `overrides` (rows, columns, onCommit, any DataGridProps).
- Provide a `vi.fn()` `onCommit` by default (returns `Promise.resolve()`), exposed on the handle as `onCommit`.
- Wrap in `<UndoStackProvider scopeKey={uniqueKey}>` where `uniqueKey` is unique per call (e.g. a counter or `crypto.randomUUID()`), so each test gets fresh undo history.
- Create and return a `user` = `userEvent.setup()` instance (with `advanceTimers` wired if fake timers are used for rAF flushing).
- Return: `{ user, onCommit, rerender, container, ...queries }` where `queries` are the `queries.ts` helpers pre-bound to this render's container, and `driver` methods pre-bound to `user`.

Interface (types are illustrative; implementer finalizes against real props):
```ts
interface RenderGridHandle {
  user: UserEvent;
  onCommit: Mock<[rowKey: string, field: string, value: unknown], Promise<void>>;
  rerender: (overrides?: Partial<DataGridProps<Row>>) => void;
  container: HTMLElement;
  // queries (from queries.ts), bound:
  cellAt(rowIndex: number, field: string): HTMLElement;
  cursorCell(): { rowKey: string; field: string } | null;
  selectedCells(): Array<{ rowKey: string; field: string }>;
  editingCell(): { rowKey: string; field: string } | null;
  // driver (from driver.ts), bound to `user`:
  focusCell(rowIndex: number, field: string): Promise<void>;
  press(keys: string): Promise<void>;
  editCell(rowIndex: number, field: string, value: string): Promise<void>;
  selectRange(from: [number, string], to: [number, string]): Promise<void>;
}
```

### Component: `fixtures.ts`

Pure builders, no randomness that varies across runs:
- `makeColumns()` → a canonical `ColumnDef[]` covering the types the core suite needs: `text`, `number`, `select` (with options), `boolean`. (Other types belong to later per-type plans.)
- `makeRows(n)` → `n` deterministic rows keyed `r0…r{n-1}` with values across the columns.
- A default small dataset (e.g. 5 rows) used when `renderGrid` gets no `rows` override.

### Component: `queries.ts`

Read grid state from the DOM the way the user perceives it. The markers are already present and machine-readable (verified in `DataGridRow.tsx`/`DataGrid.tsx`):

- **Cell**: `role="gridcell"`, `data-cell="{rowKey}::{field}"`, `data-field="{field}"` (`DataGridRow.tsx:128-133`).
- **Cursor cell**: `aria-selected="true"` on exactly the focused cell (`DataGridRow.tsx:130`).
- **Row**: `role="row"`, `data-row="{rowKey}"`, `aria-rowindex` (`DataGridRow.tsx:347-354`). **Grid**: `role="grid"` (`DataGrid.tsx:1486`).
- **Editing cell**: the active editor (input / `contenteditable`) lives inside the cell; `editingCell()` finds it and returns its `closest("[data-cell]")`.

Concrete queries:
- `cellAt(rowKey, field)` → `[data-cell="{rowKey}::{field}"]` (kit maps a row *index* to its `rowKey` via fixtures).
- `cursorCell()` → the single `[role="gridcell"][aria-selected="true"]`, parse its `data-cell`.
- `selectedCells()` → **range cells are currently marked only by a Tailwind class (`bg-accent/10`, `DataGridRow.tsx:115`), not a data attribute.** Querying a styling class is brittle, so the first implementation task **adds a minimal `data-in-range="true"` attribute** to the range branch in `DataGridRow.tsx` (a one-line, test-supporting change), and `selectedCells()` reads `[data-in-range="true"]` plus the cursor cell. This is the one small grid-source edit this plan makes.

Each query throws a clear error if its marker isn't found, so a DOM-contract drift fails loudly in one place rather than returning null across many tests.

### Component: `driver.ts`

Thin, intent-revealing wrappers over `user.keyboard`/`user.click`, so tests read as behavior not keystrokes: `focusCell` (click the cell), `press` (`user.keyboard`), `editCell` (focus → enter/dblclick → type → Enter), `selectRange` (focus anchor → shift+arrow to target). Built on the `user` from `renderGrid`.

## Core-interaction suite

All keyboard/`user-event` driven (reliable in jsdom); assert on the `onCommit` spy and on cursor/selection DOM via `queries`.

- **`navigation.test.tsx`** — arrows move the cursor; Tab/Shift-Tab advance with row-edge wrap; Enter moves down; Home/End to row edges; PageUp/PageDown; `Cmd/Ctrl+Arrow` edge-jump to the last non-empty cell; cursor recovery when the cursor's row is removed via `rerender` with fewer rows.
- **`editing.test.tsx`** — double-click enters edit; Enter enters edit; **type-to-edit** (a printable key replaces the cell and enters edit with the seed); committing calls `onCommit(rowKey, field, value)` with exact args and the correct typed/coerced value (text vs number); Enter commits and advances one row; **Escape cancels** — `onCommit` NOT called and the original value remains.
- **`selection.test.tsx`** — `Shift+Arrow` extends a range; `Cmd/Ctrl+Shift+Arrow` edge-selects; `Cmd/Ctrl+A`; `selectedCells()` reflects the range; **Delete/Backspace** clears the cursor cell (one `onCommit` with empty value) and clears a multi-cell range (an `onCommit` per cell).
- **`undo.test.tsx`** — after an edit, `Cmd/Ctrl+Z` reverts via the inverse `onCommit`; `Cmd/Ctrl+Shift+Z` redoes; a multi-cell range clear undoes as a **single transaction** (one `Cmd+Z` restores all cleared cells). Relies on per-test undo isolation.
- **`test-kit/render-grid.test.tsx`** — the kit's own smoke: `renderGrid` mounts, default fixtures render, `cellAt`/`cursorCell` resolve, undo isolation holds (two sequential renders don't share history).

## Scale / virtualization guard (`scale.test.tsx`)

Guards the grid's performance **strategy**, not wall-clock speed (jsdom does no real layout, so timings are meaningless — real latency benchmarking is deferred to a real-browser/Playwright track).

- Render `makeRows(20_000)`. Assert the number of mounted row elements (`role="row"` gridcell rows, excluding header) is **bounded** — well under a threshold (e.g. `< 100`), proving the virtualizer mounts only visible + overscan rows rather than all 20k. This fails loudly if a change ever breaks virtualization and mounts every row.
- Assert core interactions still work at scale: cursor navigation moves and edit-commit fires `onCommit` with 20k rows loaded.
- The threshold is a generous constant (documented in the test) — a guard against the pathological regression, not a tight perf assertion.

## Testing approach & flakiness controls

- **Undo isolation**: unique `scopeKey` per `renderGrid` call.
- **rAF `flashCell`/`flashCellCopy`**: the kit flushes pending rAF via fake timers or `act()` so cell-flash class mutations don't leak across tests; `render-grid.tsx` centralizes this so individual tests don't each manage timers.
- **No `navigator.clipboard`**: the core suite avoids clipboard entirely (deferred). Delete/clear uses keyboard, which is reliable.
- **DOM-contract drift**: `queries.ts` throws on missing markers, so an internal DOM change surfaces as a clear failure in one place rather than silent nulls scattered across tests.
- **Determinism**: fixtures are static; no `Math.random`/`Date.now` in test data.

## Files

- **New:** `app/src/components/datagrid/test-kit/{render-grid.tsx, fixtures.ts, driver.ts, queries.ts, render-grid.test.tsx}`; `app/src/components/datagrid/{navigation,editing,selection,undo,scale}.test.tsx`.
- **Modify:** `app/src/components/datagrid/DataGridRow.tsx` — add a `data-in-range="true"` attribute on the range-cell branch (one line) so `selectedCells()` reads a stable hook instead of a styling class. This is the only grid-source change; the cursor cell (`aria-selected`) and cell identity (`data-cell`) markers already exist.
- **No CI change** — vitest auto-discovers the files.

## Verification (success criteria)

1. `cd app && bun run test` passes with the new suite green (and the whole app suite still green — no regressions).
2. The kit smoke proves undo isolation (sequential renders don't share history).
3. `scale.test.tsx` shows bounded row mounting at 20k rows.
4. A deliberately introduced bug (e.g. break `Enter`-advances-row) makes the relevant test fail — confirming the tests actually assert behavior, not just render.

## Risks / notes

- **DOM contract for cursor/selection**: resolved — cursor (`aria-selected`), cell identity (`data-cell`), and row (`data-row`) markers already exist; only range-cell needs the one-line `data-in-range` hook (above). No open ambiguity.
- **jsdom fidelity ceiling**: real scroll, pointer drag, and clipboard remain out of honest reach here — explicitly deferred to a future Playwright track (which the docker-compose stack now makes feasible), not silently skipped.
