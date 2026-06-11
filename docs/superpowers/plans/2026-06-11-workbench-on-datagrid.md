# Workbench on DataGrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the Match-values workbench (and then the Review inbox) through `DataGrid` itself, so both surfaces get the grid's cursor, range selection, copy, virtualization, and visuals from one engine instead of hand-built row markup that merely imitates it.

**Architecture:** `DataGrid` already supports fully custom cells (`ColumnDef.render` / `ColumnDef.edit` — see how RecordsBody's `label` column does it, `app/src/components/TablePane.tsx:303-334`). Two capabilities are missing for workbench surfaces and get added first: (1) `onCellKeyDown` — a host hook for single-key actions (A/S/R/N/⌘↵) that runs after the grid's own bindings, with a `startEdit` escape hatch for the M key; (2) `renderRowDetail` — a full-width detail row beneath a data row (the provenance drill / AI-reasoning strip). Then `MatchModeBody`'s hand-built row list (~`:547-700`) is replaced by a `<DataGrid>` with a columns factory, keeping ALL existing handlers (`pick`/`accept`/`skip`/`reset`/`automap`/footer) untouched. Phase 2 does the same to Triage's `CrossDimInbox`.

**Tech Stack:** React 18 + TypeScript + @tanstack/react-virtual (already in DataGrid). Tests: vitest + Testing Library in `app/test/` (see `app/test/datagrid-nav.test.tsx` for the established DataGrid test style — read it before writing tests).

**Read these files completely before starting:**
- `app/src/components/datagrid/types.ts` (esp. `ColumnDef`, `CellCtx`, `EditCtx`, `DataGridProps` at `:121-183`)
- `app/src/components/datagrid/DataGrid.tsx:1039-1130` (`handleKeyDown`) and `:1700-1800` (the virtualized row loop)
- `app/src/components/modes/MatchModeBody.tsx` (the whole file — you are replacing its row rendering, lines ~532-700, NOT its state/handlers)
- `app/src/components/ComboSelect.tsx:25-37` (`ComboSelectHandle { open() }`, props)

**Known constraint to preserve:** the engineer-mode rule — any warehouse-internal string (table names, SQL) must stay gated behind `useEngineerMode()`. The current Match row provenance line (`primary.table`.`primary.column`) is shown ungated today; keep behavior identical (don't add gating that isn't there, don't remove gating that is).

**Known accepted tradeoff:** detail rows render outside the virtualizer's size model (row heights are estimates already — `measureElement` is not attached). With ≤500 visible workbench rows and one open detail at a time, scroll-length error is negligible. Do not attach `measureElement` in this plan.

---

## File structure

- Modify: `app/src/components/datagrid/types.ts` — two new optional props on `DataGridProps`
- Modify: `app/src/components/datagrid/DataGrid.tsx` — wire `onCellKeyDown` into `handleKeyDown`; render detail rows in the virtual loop
- Create: `app/test/datagrid-workbench.test.tsx` — tests for both new props
- Create: `app/src/components/modes/match-columns.tsx` — columns factory + `TargetEditor` (the ComboSelect edit cell)
- Modify: `app/src/components/modes/MatchModeBody.tsx` — swap hand-built rows for `<DataGrid>`
- Modify (Phase 2): `app/src/routes/Triage.tsx` — same swap for `CrossDimInbox`

---

### Task 1: DataGrid extensions — `onCellKeyDown` + `renderRowDetail`

**Files:**
- Modify: `app/src/components/datagrid/types.ts:121-183`
- Modify: `app/src/components/datagrid/DataGrid.tsx`
- Test: `app/test/datagrid-workbench.test.tsx`

- [ ] **Step 1: Write the failing tests**

First read `app/test/datagrid-nav.test.tsx` to copy its render/fixture helpers style. Then create `app/test/datagrid-workbench.test.tsx`:

```tsx
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DataGrid, UndoStackProvider } from "../src/components/datagrid";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];
const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function renderGrid(extra: Partial<React.ComponentProps<typeof DataGrid<Row>>> = {}) {
  return render(
    <UndoStackProvider scopeKey="test">
      <DataGrid<Row> rows={rows} rowKey={(r) => r.id} columns={columns} {...extra} />
    </UndoStackProvider>,
  );
}

describe("onCellKeyDown", () => {
  test("fires for unhandled keys with the cursor position", () => {
    const seen: Array<string | null> = [];
    renderGrid({
      onCellKeyDown: (e, ctx) => seen.push(`${e.key}:${ctx.cursor?.rowKey ?? "none"}`),
    });
    const cell = document.querySelector('[data-cell="a::name"]')!;
    fireEvent.pointerDown(cell, { button: 0 });
    const container = document.querySelector('[tabindex="0"]')!;
    fireEvent.keyDown(container, { key: "s" });
    expect(seen).toContain("s:a");
  });

  test("does NOT fire for keys the grid already handles (ArrowDown)", () => {
    const seen: string[] = [];
    renderGrid({ onCellKeyDown: (e) => seen.push(e.key) });
    const cell = document.querySelector('[data-cell="a::name"]')!;
    fireEvent.pointerDown(cell, { button: 0 });
    const container = document.querySelector('[tabindex="0"]')!;
    fireEvent.keyDown(container, { key: "ArrowDown" });
    expect(seen).not.toContain("ArrowDown");
  });

  test("ctx.startEdit opens the editor on the cursor cell", () => {
    renderGrid({
      onCellKeyDown: (e, ctx) => {
        if (e.key === "m") {
          e.preventDefault();
          ctx.startEdit();
        }
      },
    });
    const cell = document.querySelector('[data-cell="a::name"]')!;
    fireEvent.pointerDown(cell, { button: 0 });
    const container = document.querySelector('[tabindex="0"]')!;
    fireEvent.keyDown(container, { key: "m" });
    expect(document.querySelector("input")).toBeInTheDocument();
  });
});

describe("renderRowDetail", () => {
  test("renders the detail beneath the matching row, and only that row", () => {
    renderGrid({
      renderRowDetail: (r) => (r.id === "a" ? <div data-testid="detail">drill-{r.id}</div> : null),
    });
    expect(screen.getByTestId("detail")).toHaveTextContent("drill-a");
    expect(screen.queryByText("drill-b")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && bun run test datagrid-workbench`
Expected: FAIL — `onCellKeyDown` / `renderRowDetail` are not valid props.

- [ ] **Step 3: Add the props to `DataGridProps`**

In `app/src/components/datagrid/types.ts`, append inside `DataGridProps<Row>` (before the closing brace at `:183`):

```ts
  /** Host hook for workbench single-key actions (A/S/R/N…). Called for keydowns
   *  the grid itself did not handle (never while editing). `startEdit` opens
   *  the editor on the cursor cell — the M-key affordance. */
  onCellKeyDown?: (
    e: React.KeyboardEvent,
    ctx: { cursor: { rowKey: string; field: string } | null; startEdit: () => void },
  ) => void;
  /** Full-width detail row rendered beneath a data row when this returns
   *  non-null. The host owns which row is open (return null for the rest).
   *  Detail height is outside the virtualizer's estimates — fine for one open
   *  drill at a time. */
  renderRowDetail?: (row: Row) => ReactNode | null;
```

(`ReactNode` is already imported in this file.)

- [ ] **Step 4: Wire `onCellKeyDown` into `handleKeyDown`**

In `app/src/components/datagrid/DataGrid.tsx`, `handleKeyDown` (`:1039`) currently ends by delegating to `cursor.onKeyDown(e)` (read to the end of the callback to find the final delegation). The contract: the host hook fires only if neither the grid's explicit handlers above NOR the cursor bindings consumed the event. After the final `cursor.onKeyDown(e)` call in the non-editing path, add:

```ts
      if (!e.defaultPrevented && props.onCellKeyDown) {
        props.onCellKeyDown(e, {
          cursor: cur ? { rowKey: cur.rowKey, field: cur.field } : null,
          startEdit: () => cursor.startEdit(),
        });
      }
```

Also add `props.onCellKeyDown` to the `useCallback` dependency array of `handleKeyDown` (find the array at the end of the callback; add it alongside the existing deps).

Check: `cursor.startEdit` — confirm the method name on the `useGridCursor` return value (`app/src/components/datagrid/useGridCursor.ts`; MatchModeBody already calls `cursor.startEdit()` today, so it exists).

- [ ] **Step 5: Wire `renderRowDetail` into the row loop**

In the virtualized body (`DataGrid.tsx`, search `vItems.map((vRow)`), each iteration currently returns a single `<GridRow …/>`. Change the return to a fragment that appends the detail:

```tsx
                    const detail = props.renderRowDetail?.(row) ?? null;
                    return (
                      <Fragment key={rk}>
                        <GridRow
                          /* …all existing props exactly as they are, but remove key={rk} from GridRow itself… */
                        />
                        {detail !== null && (
                          <div role="row" className="border-b border-line bg-surface-2/50">
                            {detail}
                          </div>
                        )}
                      </Fragment>
                    );
```

Add `Fragment` to the React import at the top of `DataGrid.tsx` if not present.

- [ ] **Step 6: Run the tests**

Run: `cd app && bun run test datagrid-workbench`
Expected: all 4 PASS. Also run the full suite — `bun run test` — the existing `datagrid-nav` tests must still pass (you changed the hot path).

- [ ] **Step 7: Typecheck + commit**

Run: `cd app && bun run typecheck`

```bash
git add app/src/components/datagrid/types.ts app/src/components/datagrid/DataGrid.tsx app/test/datagrid-workbench.test.tsx
git commit -m "feat(datagrid): onCellKeyDown host hook + renderRowDetail slot"
```

---

### Task 2: Match columns factory

**Files:**
- Create: `app/src/components/modes/match-columns.tsx`

The row type is the existing `MappingValue` from `app/src/data.ts` (`value`, `status`, `current`, `suggestion`, `confidence`, `sources`). Draft state comes from the host: `state[r.value]` → `{ target: string | null; status: "mapped" | "new" | "skipped" }`.

- [ ] **Step 1: Create the file**

```tsx
import { useEffect, useRef } from "react";
import type { MappingValue } from "../../data";
import type { ColumnDef, EditCtx } from "../datagrid/types";
import { ComboSelect, type ComboSelectHandle } from "../ComboSelect";
import { Chip } from "../datagrid";
import { cx } from "../../lib/cx";
import { valueRows } from "../../data";

const confBar = (c: number) => (c >= 90 ? "bg-ok" : c >= 70 ? "bg-warn" : "bg-danger/30");
const confText = (c: number) => (c >= 90 ? "text-ok" : c >= 70 ? "text-warn" : "text-danger");

export interface MatchRowState {
  target: string | null;
  status: "mapped" | "new" | "skipped";
}

/** ComboSelect as a DataGrid edit cell: opens on mount, commits the pick,
 *  cancels when the popover closes without one. */
function TargetEditor({
  row,
  ctx,
  options,
  allowCreate,
  current,
}: {
  row: MappingValue;
  ctx: EditCtx<MappingValue>;
  options: string[];
  allowCreate: boolean;
  current: string | null;
}) {
  const handle = useRef<ComboSelectHandle>(null);
  useEffect(() => {
    handle.current?.open();
  }, []);
  return (
    <ComboSelect
      ref={handle}
      options={options}
      value={current}
      suggestion={row.suggestion}
      allowCreate={allowCreate}
      onPick={(t) => ctx.commit(t)}
    />
  );
}

export function matchColumns(opts: {
  dimensionLabel: string;
  options: string[];
  state: Record<string, MatchRowState>;
  external: boolean;
  canEdit: boolean;
  onToggleDrill: (value: string) => void;
  openDrill: string | null;
}): ColumnDef<MappingValue>[] {
  const { dimensionLabel, options, state, external, canEdit, onToggleDrill, openDrill } = opts;
  return [
    {
      field: "value",
      label: "Source value · where it's seen",
      config: { type: "text" },
      editable: false,
      pinnedLeft: true,
      render: (r) => {
        const primary = r.sources[0];
        return (
          <span className="min-w-0">
            <span className="block truncate font-mono text-[13px] text-ink">{r.value}</span>
            {primary && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleDrill(r.value);
                }}
                className={cx(
                  "block truncate font-mono text-[10px] transition-colors",
                  openDrill === r.value ? "text-ink-2" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {primary.table}.{primary.column}
                {r.sources.length > 1 ? ` +${r.sources.length - 1}` : ""} ·{" "}
                {valueRows(r).toLocaleString()} rows
              </button>
            )}
          </span>
        );
      },
    },
    {
      field: "target",
      label: `${dimensionLabel.toLowerCase()} record`,
      config: { type: "text" },
      editable: canEdit,
      render: (r) => {
        const target = state[r.value]?.target ?? null;
        if (target)
          return <span className="truncate font-display text-[13px] text-ink">{target}</span>;
        if (r.suggestion)
          return (
            <span className="truncate font-mono text-[12px] text-ink-3">
              {r.suggestion} <span className="text-accent">(suggested)</span>
            </span>
          );
        return <span className="font-mono text-[12px] text-ink-3">—</span>;
      },
      edit: (r, ctx) => (
        <TargetEditor
          row={r}
          ctx={ctx}
          options={options}
          allowCreate={!external}
          current={state[r.value]?.target ?? null}
        />
      ),
    },
    {
      field: "confidence",
      label: "Confidence",
      config: { type: "text" },
      editable: false,
      width: 110,
      render: (r) =>
        r.confidence > 0 ? (
          <span className="flex items-center gap-2">
            <span className="h-1 w-8 overflow-hidden rounded-pill bg-surface-2">
              <span
                className={cx("block h-full rounded-pill", confBar(r.confidence))}
                style={{ width: `${r.confidence}%` }}
              />
            </span>
            <span className={cx("font-mono text-[11px] tabular-nums", confText(r.confidence))}>
              {r.confidence}
            </span>
          </span>
        ) : (
          <span className="font-mono text-[11px] text-ink-2">—</span>
        ),
    },
    {
      field: "status",
      label: "Status",
      config: { type: "text" },
      editable: false,
      width: 96,
      render: (r) => {
        const s = state[r.value]?.status ?? "new";
        return s === "mapped" ? (
          <Chip label="Mapped" bucket="chip-1" dot />
        ) : s === "skipped" ? (
          <Chip label="Skipped" bucket="chip-5" />
        ) : (
          <Chip label="New" bucket="chip-2" dot />
        );
      },
    },
  ];
}
```

Verify before moving on: `Chip` is exported from `../datagrid` (MatchModeBody imports it today — copy its exact import path); `valueRows` is exported from `app/src/data.ts:82`. If `Chip`'s bucket prop names differ, copy the exact usages from the current MatchModeBody rows (`:583-589`).

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck`
Expected: clean (file compiles standalone; nothing consumes it yet).

- [ ] **Step 3: Commit**

```bash
git add app/src/components/modes/match-columns.tsx
git commit -m "feat(workbench): DataGrid column factory for the match surface"
```

---

### Task 3: MatchModeBody on DataGrid

**Files:**
- Modify: `app/src/components/modes/MatchModeBody.tsx`

Everything above the row list stays: state derivation (`state`, `counts`), handlers (`stageMap`, `accept`, `pick`, `skip`, `reset`, `automap`, `approveAndCommit`), the Auto-match toolbar, the filter-chips toolbar, the footer. You are replacing ONLY: the hand-built column header (`~:532-545`), the `visible.map(...)` row loop (`~:547-700`), and the manual `cursor.*` wiring (the component's `useGridCursor` usage and the container's `onKeyDown` at `~:398-440`) — DataGrid now owns cursor + keyboard.

- [ ] **Step 1: Track the open drill as plain state**

The drill (expanded provenance) currently uses `open` state with `setOpen` — keep it. It feeds both `onToggleDrill` and `renderRowDetail`.

- [ ] **Step 2: Build columns + swap in the grid**

Inside the component, after the existing `state`/`sel` declarations:

```tsx
  const columns = useMemo(
    () =>
      matchColumns({
        dimensionLabel: dim.dimension,
        options,
        state,
        external,
        canEdit,
        onToggleDrill: (v) => setOpen((cur) => (cur === v ? null : v)),
        openDrill: open,
      }),
    [dim.dimension, options, state, external, canEdit, open],
  );
```

Replace the column-header div and the rows loop with:

```tsx
        <DataGrid<MappingValue>
          rows={visible}
          rowKey={(r) => r.value}
          columns={columns}
          selection={{ selected: sel, onChange: setSel }}
          getValue={(r, field) =>
            field === "target" ? (state[r.value]?.target ?? "") : (r as never)[field]
          }
          onCommit={
            canEdit
              ? async (rowKey, field, value) => {
                  if (field !== "target" || typeof value !== "string" || !value) return;
                  pick(rowKey, value);
                }
              : undefined
          }
          onCellKeyDown={(e, ctx) => {
            const v = ctx.cursor?.rowKey;
            if (canEdit && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void approveAndCommit();
              return;
            }
            if (!v) return;
            const k = e.key.toLowerCase();
            if (canEdit && k === "a") {
              e.preventDefault();
              accept(v);
            } else if (canEdit && k === "s") {
              e.preventDefault();
              skip(v);
            } else if (canEdit && k === "r") {
              e.preventDefault();
              reset(v);
            } else if (canEdit && k === "m") {
              e.preventDefault();
              ctx.startEdit();
            } else if (k === "n") {
              e.preventDefault();
              advanceToNextNew(v);
            }
          }}
          renderRowDetail={(r) =>
            open === r.value ? (
              <div className="px-12 py-3">
                {/* move the existing expanded-drill JSX here verbatim (the isOpen block
                    in the old row loop — source occurrence list). */}
              </div>
            ) : null
          }
          empty={
            <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
              no values in this view
            </div>
          }
        />
```

Imports to add: `DataGrid` (from `"../datagrid"` — check the barrel export; RecordsBody imports it from `"./datagrid"` relative to `components/`), `matchColumns` from `"./match-columns"`, `useMemo` if not present. Imports to REMOVE after the swap: `useGridCursor` and anything else now unused — let typecheck/eslint tell you.

Important details:
- `advanceToNextNew` must now move DataGrid's cursor, not the old local cursor. DataGrid owns the cursor internally, so the old "advance" behavior (auto-jump after accept/skip) can't reach it. **Drop the cursor-jump for now** — keep `advanceToNextNew` only where it's still used, or delete it if unused (acceptable UX change: after A/S the cursor stays put; arrow keys move on). Note this in the commit message. If the reviewer wants auto-advance back, that's a follow-up DataGrid prop (`cursorRef` escape hatch) — do not build it speculatively.
- `flashRow` calls keyed on `[data-row="${value}"]` still work — GridRow renders `data-row={rk}`.
- The old mobile-only ComboSelect inside each row disappears with the old markup; DataGrid handles narrow viewports the same way Records does. Acceptable.

- [ ] **Step 3: Typecheck + tests**

Run: `cd app && bun run typecheck && bun run test`
Expected: clean. If `app/test/` has MatchModeBody-specific tests (grep for `MatchModeBody`), update their queries to the DataGrid DOM (cells are `[data-cell="<value>::target"]` etc.).

- [ ] **Step 4: Manual verification (the real gate)**

This surface needs warehouse values: run with `ATTACH_WAREHOUSE=true` against the dev warehouse, or seed (`cd server && bun run bootstrap -- --seed` — **ask the repo owner before reseeding a shared dev DB**). Then in the browser, in a table's "Match values" tab:
1. Arrow keys move the cursor ring; type-to-edit on the target column opens the ComboSelect.
2. `A` accepts the suggestion (row flips to Mapped, optimistic), `S` skips, `R` resets, `M`/Enter opens the picker, picking commits a draft.
3. Click the provenance line → detail row expands beneath; click again → closes.
4. Row checkboxes still drive the bulk bar; ⌘A selects all; ⌘↵ publishes.
5. Switch to Records and back — mode state and drafts intact.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/modes/MatchModeBody.tsx
git commit -m "refactor(workbench): Match values renders through DataGrid"
```

---

### Task 4 (Phase 2): Review inbox on DataGrid

**Files:**
- Modify: `app/src/routes/Triage.tsx` (the `CrossDimInbox` component — row loop at `~:535-700`, keyboard handler at `~:414-500`)

Pre-read: the `CrossRow` type (`Triage.tsx:37-46`), the handlers `accept(dimId, raw)` / `skip(dimId, raw)` / `pick(dimId, raw, label)` / `advanceNext(dimId, raw)` passed in as props `p.*`, and the per-row option resolution (`p.dimById.get(r.dimId)?.canonical.map(c => c.label)`).

- [ ] **Step 1: Columns factory for cross-dim rows**

Add to `app/src/components/modes/match-columns.tsx` (same file — the two factories share `TargetEditor`, `confBar`, `confText`; export a second function):

```tsx
import type { CrossRowLike } from "…"; // define locally instead — see below
```

Define the row contract structurally in `match-columns.tsx` so Triage's `CrossRow` satisfies it without imports from a route file:

```tsx
export interface CrossRowLike {
  dimId: string;
  dimName: string;
  raw: string;
  suggestion: string | null;
  confidence: number;
  status: "mapped" | "new" | "skipped";
  target: string | null;
  dimRows: number;
}

export function crossDimColumns(opts: {
  optionsFor: (dimId: string) => string[];
  canEdit: boolean;
}): ColumnDef<CrossRowLike>[] {
  const { optionsFor, canEdit } = opts;
  return [
    {
      field: "dimName",
      label: "Table",
      config: { type: "text" },
      editable: false,
      width: 130,
      render: (r) => <Chip label={r.dimName} bucket="chip-3" />,
    },
    {
      field: "raw",
      label: "Source value",
      config: { type: "text" },
      editable: false,
      pinnedLeft: true,
      render: (r) => (
        <span className="min-w-0">
          <span className="block truncate font-mono text-[13px] text-ink">{r.raw}</span>
          <span className="block font-mono text-[10px] text-ink-2 tabular-nums">
            {r.dimRows.toLocaleString()} rows in warehouse
          </span>
        </span>
      ),
    },
    {
      field: "target",
      label: "record",
      config: { type: "text" },
      editable: canEdit,
      render: (r) =>
        r.target ? (
          <span className="truncate font-display text-[13px] text-ink">{r.target}</span>
        ) : r.suggestion ? (
          <span className="truncate font-mono text-[12px] text-ink-3">
            {r.suggestion} <span className="text-accent">(suggested)</span>
          </span>
        ) : (
          <span className="font-mono text-[12px] text-ink-3">—</span>
        ),
      edit: (r, ctx) => (
        <TargetEditorCross row={r} ctx={ctx} options={optionsFor(r.dimId)} />
      ),
    },
    // confidence + status columns: copy the two ColumnDef objects from
    // matchColumns() verbatim, changing the generic row type to CrossRowLike
    // and reading r.confidence / r.status directly (status lives on the row
    // here, not in a state map).
  ];
}

function TargetEditorCross({
  row,
  ctx,
  options,
}: {
  row: CrossRowLike;
  ctx: EditCtx<CrossRowLike>;
  options: string[];
}) {
  const handle = useRef<ComboSelectHandle>(null);
  useEffect(() => {
    handle.current?.open();
  }, []);
  return (
    <ComboSelect
      ref={handle}
      options={options}
      value={row.target}
      suggestion={row.suggestion}
      onPick={(t) => ctx.commit(t)}
    />
  );
}
```

(Where the comment says "copy verbatim" — actually copy the code; the executor must not leave a comment in its place.)

- [ ] **Step 2: Swap CrossDimInbox's row loop for DataGrid**

In `Triage.tsx`'s `CrossDimInbox`, replace the header + `p.rows.slice(0, 500).map(...)` loop with:

```tsx
        <DataGrid<CrossRow>
          rows={visibleRows}
          rowKey={(r) => `${r.dimId}::${r.raw}`}
          columns={columns}
          getValue={(r, field) => (r as never)[field]}
          onCommit={
            p.canEdit
              ? async (rowKey, field, value) => {
                  if (field !== "target" || typeof value !== "string" || !value) return;
                  const [dimId, ...rest] = rowKey.split("::");
                  p.pick(dimId!, rest.join("::"), value);
                }
              : undefined
          }
          onCellKeyDown={(e, ctx) => {
            if (p.canEdit && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              p.commitAll();
              return;
            }
            const rk = ctx.cursor?.rowKey;
            if (!rk) return;
            const [dimId, ...rest] = rk.split("::");
            const raw = rest.join("::");
            const k = e.key.toLowerCase();
            if (p.canEdit && k === "a") {
              e.preventDefault();
              p.accept(dimId!, raw);
            } else if (p.canEdit && k === "s") {
              e.preventDefault();
              p.skip(dimId!, raw);
            } else if (p.canEdit && (k === "m" || e.key === "Enter")) {
              e.preventDefault();
              ctx.startEdit();
            } else if (k === "n") {
              e.preventDefault();
              p.advanceNext(dimId!, raw);
            }
          }}
          renderRowDetail={(r) =>
            curKey === `${r.dimId}::${r.raw}` ? (
              /* move the existing TriageReasoningStrip / aiHint block here if it
                 currently renders under the focused row; otherwise return null
                 and leave the strip where it is. Check Triage.tsx first. */
              null
            ) : null
          }
          empty={
            <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
              no values in this view
            </div>
          }
        />
```

The bigger "Nothing to review today. 🎯" celebration block (search that string in `Triage.tsx`) renders OUTSIDE the inbox when the whole queue is empty — leave it where it is; the `empty` slot above only covers an empty *filter* view.

```tsx
```

Where `columns` is:

```tsx
  const columns = useMemo(
    () =>
      crossDimColumns({
        optionsFor: (dimId) => p.dimById.get(dimId)?.canonical.map((c) => c.label) ?? [],
        canEdit: p.canEdit,
      }),
    [p.dimById, p.canEdit],
  );
```

Caveats to handle while in there:
- The old `p.cursor`/`p.setCursor` ({dimId, raw}) prop pair and the J/K/Home/End/Page keyboard handler on the container are superseded by DataGrid's cursor — remove the container `onKeyDown` and the `move`/`moveTo` helpers, and remove the cursor props from `CrossDimInbox`'s prop interface IF nothing else uses them (the parent `TriageInner` uses `cursor` for `useAiHint` — check; if so, keep a thin sync: pass `onCursorChange` is NOT available from DataGrid, so instead keep `aiHint` keyed off the focused row via the detail render, or leave `p.cursor` driven by row clicks only. Decide by reading how `aiHint` is consumed and write down the choice in the commit message).
- Row cap: the old loop sliced to 500; DataGrid virtualizes, so pass all rows and delete the slice.
- The `focusedComboRef` M-key plumbing dies; `ctx.startEdit()` replaces it.

- [ ] **Step 3: Typecheck + full suite + fix fallout**

Run: `cd app && bun run typecheck && bun run test`
The `triage-commit-copy.test.tsx` mounts `<Triage>` with stubbed store — it asserts on footer copy, which you didn't touch; it should pass. Fix anything else honestly (no test deletions without replacing coverage).

- [ ] **Step 4: Manual verification**

Same checklist as Task 3 step 4, on `/app/triage` (needs warehouse values). Also: per-dim pickers must show each row's OWN dimension's records.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/Triage.tsx app/src/components/modes/match-columns.tsx
git commit -m "refactor(review): cross-dim inbox renders through DataGrid"
```

---

## Self-review checklist (for the executor)

- `onCellKeyDown` must never fire while a cell editor is open (the editing branch returns before the hook).
- Single-letter shortcuts (A/S/R/M/N) must not swallow typing: they only run when not editing — which the editing-branch guard already guarantees — and DataGrid's type-to-edit only triggers on editable cells; verify pressing "a" with the cursor on the *target* column performs accept rather than starting type-to-edit. If type-to-edit wins, gate the workbench keys first by calling `props.onCellKeyDown` BEFORE the type-to-edit branch in `handleKeyDown` and document the ordering choice in a comment.
- `rowKey.split("::")` in Triage: raw values can contain `::` — that's why the code rejoins with `rest.join("::")`. dimIds cannot contain `::` (slug-derived). Do not "simplify" this.
- Both factories live in `match-columns.tsx`; if it exceeds ~400 lines after Task 4, split `cross-dim-columns.tsx` out — same directory.
- Run `cd app && bun run test` one final time across the whole suite before declaring done.
