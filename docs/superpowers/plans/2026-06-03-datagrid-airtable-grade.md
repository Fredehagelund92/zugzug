# DataGrid: Airtable-grade inline CRUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a shared `<DataGrid>` primitive that both `MasterTables` and `Mapping` mount; add single-select chip cells (Airtable-style, pre-define + add inline, auto-color from a 5-bucket palette hash), keyboard cell navigation, an in-memory undo stack, a column header menu, column resize + reorder persisted per-user-per-dimension, and a `?` shortcuts overlay.

**Architecture:** A new `app/src/components/datagrid/` package owns the cell/column/cursor/undo model. Built-in cells (Text/Number/Boolean/Date) move there. A new `SelectCell` is the v1 rich cell type; the picker creates options inline. Column layout state (widths, order, hidden) is persisted to a new Postgres `user_grid_layout` table via a debounced PATCH endpoint. Mapping keeps its workflow chrome but adopts the cursor/undo/picker/chip primitives so the two routes feel identical to the hand.

**Tech Stack:** Bun + `@duckdb/node-api` (server, one DuckDB connection ATTACHing Postgres + MotherDuck), React 18 + Vite + Tailwind v4 (app). Verification follows the existing `verify-*.ts` convention (self-cleaning Bun scripts) plus `bun run typecheck` and manual smoke checks against the dev server — this codebase has no unit-test runner.

**Spec:** `docs/superpowers/specs/2026-06-03-datagrid-airtable-grade-design.md`. Read it before starting.

---

## Scope

**In v1 (this plan):**
- `<DataGrid>` primitive: `useGridCursor`, `UndoStack`, `Chip`, built-in cells (Text/Number/Boolean/Date), keyboard nav, selection, sort (in-memory)
- `SelectCell` — chip rendering + picker with inline "Create option"
- Server: `dimension_field.options jsonb`, `POST /api/dimensions/:id/fields/:field/options`, `DELETE /api/dimensions/:id/fields/:field` (column delete), `PUT /api/dimensions/:id/fields/:field` (rename + change-type)
- Column header menu (rename / change type / sort / hide / delete)
- Column resize + reorder via pointer; `app.user_grid_layout` table; `GET / PATCH /api/grid-layout/:dimId` (debounced)
- `MasterTables` refactored to mount `<DataGrid>`
- `Mapping` adopts cursor + undo + picker + chip; keeps its workflow chrome
- Mapping shortcuts (`A` / `M` / `S` / `R` / `⌘↵`) + grid shortcuts (`⌘Z` / `⌘⇧Z` / `↑↓←→` / `Enter` / `Tab` / `Esc` / `Space` / `⌘A` / `⌘⌫` / `/` / `?`)
- `ShortcutsOverlay` modal (`?` opens it), inline shortcut text on Publish + Undo buttons, focused-row hint strip in Mapping
- `verify-datagrid.ts` regression harness covering the new server endpoints

**Deferred (NOT in this plan — track separately if requested):**
- Multi-select / link / formula / URL cell types
- Saved views (filter + sort + visible-columns presets) — `user_grid_layout` is intentionally narrower
- Row-level locking / realtime presence cursors on cells
- Virtualization (row counts today don't require it; `<DataGrid>` API leaves a seam)
- Per-option color overrides
- Multi-column sort

## File map

| File | Change |
|---|---|
| `server/src/schema.ts` | ALTER `dimension_field`: add `options JSONB`; CREATE `user_grid_layout` |
| `server/src/repo.ts` | `FieldDef.options?`; `addColumnOption`, `renameColumn`, `changeColumnType`, `deleteColumn`; `getGridLayout`, `setGridLayout`; project `options` in `listFields` |
| `server/src/server.ts` | new routes: `POST /api/dimensions/:id/fields/:field/options`, `PUT/DELETE /api/dimensions/:id/fields/:field`, `GET/PATCH /api/grid-layout/:id` |
| `server/src/verify-datagrid.ts` | **new** — exercises the new endpoints end-to-end |
| `server/package.json` | add `"verify-datagrid"` script |
| `app/src/components/datagrid/types.ts` | **new** — `ColumnDef`, `CellCtx`, `EditCtx`, `Cursor` |
| `app/src/components/datagrid/bucket.ts` | **new** — `hash32` + `bucket(label)` → 1 of 5 palette buckets |
| `app/src/components/datagrid/Chip.tsx` | **new** — renders a chip in a bucket color |
| `app/src/components/datagrid/useGridCursor.ts` | **new** — focus + keyboard handler |
| `app/src/components/datagrid/UndoStack.tsx` | **new** — provider + hook + `⌘Z` binding |
| `app/src/components/datagrid/cells/TextCell.tsx` | **new** |
| `app/src/components/datagrid/cells/NumberCell.tsx` | **new** |
| `app/src/components/datagrid/cells/BooleanCell.tsx` | **new** |
| `app/src/components/datagrid/cells/DateCell.tsx` | **new** |
| `app/src/components/datagrid/cells/SelectCell.tsx` | **new** — chip + picker |
| `app/src/components/datagrid/ColumnHeaderMenu.tsx` | **new** |
| `app/src/components/datagrid/ShortcutsOverlay.tsx` | **new** |
| `app/src/components/datagrid/DataGrid.tsx` | **new** — layout, header, resize/reorder pointer handlers |
| `app/src/components/datagrid/index.ts` | **new** — barrel export |
| `app/src/data.ts` | extend `FieldDef` with `options?: string[]` |
| `app/src/store.ts` | new mutations: `addColumnOption`, `renameColumn`, `changeColumnType`, `deleteColumn`, `getGridLayout`, `setGridLayout`; undo helper `withUndo(...)` |
| `app/src/routes/MasterTables.tsx` | replace inline grid markup with `<DataGrid>`; remove inline `FieldCell`/`AddColumn`; selection-bar-only row actions (remove per-row ✎/✕) |
| `app/src/routes/Mapping.tsx` | wire cursor + undo + chips + Mapping shortcuts; replace status `Badge` with `Chip`; remove per-row icon buttons; add focused-row hint strip; inline shortcut text on Publish + Undo |
| `app/src/main.tsx` | mount `<UndoStackProvider>` + `<ShortcutsOverlay>` once at the app root |

## Verification approach

This codebase has no unit-test framework. Verification combines:
1. `cd app && bun run typecheck` — catches type drift across tasks
2. `cd server && bun run typecheck` — same for the API
3. `cd server && bun run bootstrap` — runs `ensureSchema` against real Postgres; confirms migrations apply
4. `cd server && bun run verify-datagrid` — self-cleaning script that POSTs/PUTs/DELETEs the new endpoints and asserts the resulting state
5. Manual smoke checks against `cd app && bun run dev` (UI assertions called out per task)

Each task ends with a typecheck step before commit so type drift surfaces immediately. Phase verification (the manual UI checks) is at the end of each phase, not after every micro-task.

---

# Phase 1 — DataGrid primitive (foundation)

Goal: ship a working `<DataGrid>` component used by MasterTables in Phase 2. No `SelectCell` yet; this phase wires up Text/Number/Boolean/Date cells, the cursor, the undo stack, and the chip primitive. After Phase 1, the new `datagrid/` package compiles and exports symbols even though no route uses it yet.

## Task 1: Bucket hash + Chip primitive

**Files:**
- Create: `app/src/components/datagrid/bucket.ts`
- Create: `app/src/components/datagrid/Chip.tsx`

- [ ] **Step 1: Write `bucket.ts`**

```ts
/* bucket.ts — deterministic palette-bucket assignment for single-select chips.
   Same label → same bucket, always. 5 buckets drawn from the existing palette
   tokens (ok/warn/accent/accent-2/neutral) so chips never introduce new colors. */

export const BUCKETS = ["chip-1", "chip-2", "chip-3", "chip-4", "chip-5"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** FNV-1a 32-bit hash. Stable across runs and platforms. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function bucket(label: string): Bucket {
  return BUCKETS[hash32(label.toLowerCase()) % BUCKETS.length];
}
```

- [ ] **Step 2: Write `Chip.tsx`**

```tsx
import { cx } from "../../lib/cx";
import { bucket as bucketFor, type Bucket } from "./bucket";

/* Chip — single-select rendering. Pass `bucket` explicitly to override the
   default label-hash (Mapping uses this for semantic status chips: mapped=ok,
   skipped=neutral, new=warn). When omitted, derived from the label. */

const STYLES: Record<Bucket, string> = {
  "chip-1": "bg-ok-soft text-ok",
  "chip-2": "bg-warn-soft text-warn",
  "chip-3": "bg-accent-soft text-accent",
  "chip-4": "bg-accent-2/16 border-accent-2/30 text-[#B8780F]",
  "chip-5": "border-line-2 bg-surface-2 text-ink-2",
};

export function Chip({
  label, bucket, className, dot,
}: { label: string; bucket?: Bucket; className?: string; dot?: boolean }) {
  const b = bucket ?? bucketFor(label);
  return (
    <span className={cx(
      "inline-flex items-center gap-1.5 rounded-sm border border-transparent px-2 py-0.5 font-mono text-[11px] font-medium",
      STYLES[b], className,
    )}>
      {dot && <span className="h-1.5 w-1.5 rounded-pill bg-current" />}
      {label}
    </span>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd app && bun run typecheck`
Expected: passes (the file is self-contained; the chip-4 inline Tailwind arbitrary value renders fine — Tailwind v4 supports it).

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/bucket.ts app/src/components/datagrid/Chip.tsx
git commit -m "feat(datagrid): bucket hash + Chip primitive"
```

---

## Task 2: Column / cursor types

**Files:**
- Create: `app/src/components/datagrid/types.ts`

- [ ] **Step 1: Write `types.ts`**

```ts
import type { ReactNode } from "react";

/* types.ts — the DataGrid contract. Both MasterTables and Mapping mount the
   grid through these types; new cell types slot in via the union. */

export type CellType = "text" | "number" | "boolean" | "date" | "select";

export interface ColumnDef<Row> {
  field: string;                      // stable id
  label: string;                      // header text
  type: CellType;
  width?: number;                     // px; persisted via user_grid_layout
  hidden?: boolean;                   // persisted
  sortable?: boolean;                 // default true
  editable?: boolean;                 // default true
  pinnedLeft?: boolean;               // pinned columns can't be reordered or moved past
  align?: "left" | "right";           // default left
  options?: string[];                 // only set when type === "select"
  // Render hook for custom cell content (e.g. Mapping's source-value+provenance cell)
  render?: (row: Row, ctx: CellCtx<Row>) => ReactNode;
  // Editor hook for custom editing (e.g. Mapping's target-master ComboSelect)
  edit?: (row: Row, ctx: EditCtx<Row>) => ReactNode;
}

export interface CellCtx<Row> {
  row: Row;
  rowKey: string;
  field: string;
  value: unknown;
  focused: boolean;
}

export interface EditCtx<Row> extends CellCtx<Row> {
  commit: (next: unknown) => void;    // commit + advance cursor (Tab/Enter handled by grid)
  cancel: () => void;                 // Esc behavior
}

export interface Cursor {
  rowKey: string;
  field: string;
  editing: boolean;
}

export interface DataGridProps<Row> {
  rows: Row[];
  rowKey: (row: Row) => string;
  columns: ColumnDef<Row>[];
  selection?: { selected: string[]; onChange: (next: string[]) => void };
  /** Cell-value mutation. Implementations push an undo entry themselves. */
  onCommit: (rowKey: string, field: string, value: unknown) => Promise<void>;
  /** Triggered when the user invokes the header menu's "delete column" item. */
  onDeleteColumn?: (field: string) => void;
  /** Header menu: rename label */
  onRenameColumn?: (field: string, newLabel: string) => void;
  /** Header menu: change type (with the new type + new options if select). Set
   *  coerceInvalidToNull when re-trying after the host has confirmed N values
   *  would coerce to empty. */
  onChangeColumnType?: (field: string, newType: CellType, opts?: { options?: string[]; coerceInvalidToNull?: boolean }) => Promise<{ ok: boolean; invalidCount?: number }>;
  /** Header menu: add a new option to a select column. Returns the new option list. */
  onAddColumnOption?: (field: string, label: string) => Promise<string[]>;
  /** Layout changes (width / order / hidden) the grid asks the host to persist. */
  onLayoutChange?: (next: { widths?: Record<string, number>; order?: string[]; hidden?: string[] }) => void;
  /** Optional: empty-state slot. */
  empty?: ReactNode;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/types.ts
git commit -m "feat(datagrid): public types (ColumnDef, Cursor, props)"
```

---

## Task 3: `useGridCursor` hook

**Files:**
- Create: `app/src/components/datagrid/useGridCursor.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { ColumnDef, Cursor } from "./types";

/* useGridCursor — owns the (rowKey, field, editing) cursor + the keyboard
   handler. Attached to the grid container, not window (so it doesn't fight
   the browser address bar / app shell shortcuts). */

interface Opts<Row> {
  rows: Row[];
  rowKey: (row: Row) => string;
  columns: ColumnDef<Row>[];
  onCommit?: () => void;          // grid asks the host to actually persist
  onSelectAll?: () => void;
  onBulkDelete?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onShortcuts?: () => void;       // '?' → open shortcuts overlay
  onFocusFilter?: () => void;     // '/' → focus toolbar filter
}

export function useGridCursor<Row>({
  rows, rowKey, columns,
  onCommit, onSelectAll, onBulkDelete, onUndo, onRedo, onShortcuts, onFocusFilter,
}: Opts<Row>) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // visible navigable columns (skip hidden + non-editable pinned utility columns)
  const navCols = columns.filter((c) => !c.hidden && c.editable !== false);

  const move = useCallback((dx: number, dy: number) => {
    setCursor((cur) => {
      if (!cur) {
        const r0 = rows[0]; const c0 = navCols[0];
        return r0 && c0 ? { rowKey: rowKey(r0), field: c0.field, editing: false } : null;
      }
      const ri = rows.findIndex((r) => rowKey(r) === cur.rowKey);
      const ci = navCols.findIndex((c) => c.field === cur.field);
      const nr = Math.max(0, Math.min(rows.length - 1, ri + dy));
      const nc = Math.max(0, Math.min(navCols.length - 1, ci + dx));
      const row = rows[nr]; const col = navCols[nc];
      return row && col ? { rowKey: rowKey(row), field: col.field, editing: false } : cur;
    });
  }, [rows, navCols, rowKey]);

  const startEdit = useCallback(() => setCursor((c) => (c ? { ...c, editing: true } : c)), []);
  const stopEdit = useCallback(() => setCursor((c) => (c ? { ...c, editing: false } : c)), []);

  // auto-scroll the focused cell into view
  useEffect(() => {
    if (!cursor || !ref.current) return;
    const sel = `[data-cell="${cursor.rowKey}::${cursor.field}"]`;
    const el = ref.current.querySelector<HTMLElement>(sel);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursor?.rowKey, cursor?.field]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!cursor) return;
    const editing = cursor.editing;

    // Cmd+Z / Cmd+Shift+Z first (work even while editing)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      (e.shiftKey ? onRedo : onUndo)?.();
      return;
    }

    if (editing) {
      // Enter / Tab commit + move; Esc cancels; everything else falls through to the editor
      if (e.key === "Enter") { e.preventDefault(); onCommit?.(); stopEdit(); move(0, 1); return; }
      if (e.key === "Tab") { e.preventDefault(); onCommit?.(); stopEdit(); move(e.shiftKey ? -1 : 1, 0); return; }
      if (e.key === "Escape") { e.preventDefault(); stopEdit(); return; }
      return;
    }

    if (e.key === "ArrowUp")    { e.preventDefault(); move(0, -1); return; }
    if (e.key === "ArrowDown")  { e.preventDefault(); move(0, 1); return; }
    if (e.key === "ArrowLeft")  { e.preventDefault(); move(-1, 0); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); move(1, 0); return; }
    if (e.key === "Enter")      { e.preventDefault(); startEdit(); return; }
    if (e.key === "Tab")        { e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); return; }
    if (e.key === "?")          { e.preventDefault(); onShortcuts?.(); return; }
    if (e.key === "/")          { e.preventDefault(); onFocusFilter?.(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault(); onSelectAll?.(); return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
      e.preventDefault(); onBulkDelete?.(); return;
    }
  }, [cursor, move, startEdit, stopEdit, onCommit, onSelectAll, onBulkDelete, onUndo, onRedo, onShortcuts, onFocusFilter]);

  return { cursor, setCursor, startEdit, stopEdit, move, onKeyDown, ref };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/useGridCursor.ts
git commit -m "feat(datagrid): useGridCursor keyboard + focus hook"
```

---

## Task 4: UndoStack provider

**Files:**
- Create: `app/src/components/datagrid/UndoStack.tsx`

- [ ] **Step 1: Write the provider**

```tsx
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/* UndoStack — last-50, in-memory, per-mount. Cleared on route change or
   dimension switch (the consumer remounts the provider when the active
   dimension changes). Not collaborative; not persisted. */

export interface UndoEntry {
  apply: () => Promise<void>;
  inverse: () => Promise<void>;
  label: string;
}

interface Ctx {
  push: (e: UndoEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  /** label of the top of the undo stack — surfaced in the toolbar */
  topLabel: string | null;
}

const UndoCtx = createContext<Ctx | null>(null);

const LIMIT = 50;

export function UndoStackProvider({ children, scopeKey }: { children: ReactNode; scopeKey?: string }) {
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const [version, setVersion] = useState(0);   // bumped to re-render canUndo/canRedo flags
  const bump = () => setVersion((v) => v + 1);

  // clear both stacks when the scope (dimension id) changes
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    bump();
  }, [scopeKey]);

  const push = useCallback((e: UndoEntry) => {
    undoStack.current.push(e);
    if (undoStack.current.length > LIMIT) undoStack.current.shift();
    redoStack.current = []; // any new mutation invalidates the redo path
    bump();
  }, []);

  const undo = useCallback(async () => {
    const e = undoStack.current.pop();
    if (!e) return;
    try { await e.inverse(); redoStack.current.push(e); }
    catch (err) { console.warn("undo inverse failed:", err); /* silently no-op */ }
    bump();
  }, []);

  const redo = useCallback(async () => {
    const e = redoStack.current.pop();
    if (!e) return;
    try { await e.apply(); undoStack.current.push(e); }
    catch (err) { console.warn("redo apply failed:", err); }
    bump();
  }, []);

  const value: Ctx = {
    push, undo, redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    topLabel: undoStack.current.at(-1)?.label ?? null,
  };
  // version is read in deps below to keep value identity in sync
  void version;
  return <UndoCtx.Provider value={value}>{children}</UndoCtx.Provider>;
}

export function useUndoStack(): Ctx {
  const c = useContext(UndoCtx);
  if (!c) throw new Error("useUndoStack outside <UndoStackProvider>");
  return c;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/UndoStack.tsx
git commit -m "feat(datagrid): UndoStack provider (last-50, per-scope)"
```

---

## Task 5: Built-in cells (Text/Number/Boolean/Date)

**Files:**
- Create: `app/src/components/datagrid/cells/TextCell.tsx`
- Create: `app/src/components/datagrid/cells/NumberCell.tsx`
- Create: `app/src/components/datagrid/cells/BooleanCell.tsx`
- Create: `app/src/components/datagrid/cells/DateCell.tsx`

Each cell exports `{ Renderer, Editor }` matching the shape `DataGrid` expects. Text is the canonical pattern; the others follow it.

- [ ] **Step 1: Write `TextCell.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase = "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const s = value == null || value === "" ? null : String(value);
  return s ? (
    <span className="truncate font-mono text-[12px] text-ink">{s}</span>
  ) : (
    <span className="font-mono text-[12px] text-ink-3">—</span>
  );
}

function Editor<Row>({ value, commit, cancel }: EditCtx<Row>) {
  const [v, setV] = useState(value == null ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref} value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => commit(v.trim() === "" ? null : v)}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        // Enter / Tab handled by useGridCursor (it calls commit via the host)
      }}
      className={inputBase}
    />
  );
}

export const TextCell = { Renderer, Editor };
```

- [ ] **Step 2: Write `NumberCell.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase = "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 text-right font-mono text-[12px] text-ink outline-none tabular-nums";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const n = value == null || value === "" ? null : Number(value);
  return n != null && Number.isFinite(n) ? (
    <span className="text-right tabular-nums font-mono text-[12px] text-ink">{n}</span>
  ) : (
    <span className="font-mono text-[12px] text-ink-3">—</span>
  );
}

function Editor<Row>({ value, commit, cancel }: EditCtx<Row>) {
  const [v, setV] = useState(value == null ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref} value={v} inputMode="decimal"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const t = v.trim();
        if (t === "") commit(null);
        else {
          const n = Number(t);
          commit(Number.isFinite(n) ? n : null);
        }
      }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } }}
      className={inputBase}
    />
  );
}

export const NumberCell = { Renderer, Editor };
```

- [ ] **Step 3: Write `BooleanCell.tsx`**

```tsx
import type { CellCtx, EditCtx } from "../types";

function Renderer<Row>({ value }: CellCtx<Row>) {
  if (value === true)  return <span className="font-mono text-[12px] text-ok">true</span>;
  if (value === false) return <span className="font-mono text-[12px] text-ink-2">false</span>;
  return <span className="font-mono text-[12px] text-ink-3">—</span>;
}

function Editor<Row>({ value, commit }: EditCtx<Row>) {
  const v = value === true ? "true" : value === false ? "false" : "";
  return (
    <select
      autoFocus value={v}
      onChange={(e) => commit(e.target.value === "" ? null : e.target.value === "true")}
      className="w-full cursor-pointer rounded-sm border border-accent bg-bg px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none"
    >
      <option value="">—</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  );
}

export const BooleanCell = { Renderer, Editor };
```

- [ ] **Step 4: Write `DateCell.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase = "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const s = value == null || value === "" ? null : String(value);
  return s ? (
    <span className="font-mono text-[12px] text-ink">{s}</span>
  ) : (
    <span className="font-mono text-[12px] text-ink-3">—</span>
  );
}

function Editor<Row>({ value, commit, cancel }: EditCtx<Row>) {
  const [v, setV] = useState(value == null ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <input
      ref={ref} type="date" value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => commit(v.trim() === "" ? null : v)}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } }}
      className={inputBase}
    />
  );
}

export const DateCell = { Renderer, Editor };
```

- [ ] **Step 5: Typecheck**

Run: `cd app && bun run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/cells/
git commit -m "feat(datagrid): built-in Text/Number/Boolean/Date cells"
```

---

## Task 6: `DataGrid.tsx` — layout + body (no header menu yet)

**Files:**
- Create: `app/src/components/datagrid/DataGrid.tsx`
- Create: `app/src/components/datagrid/index.ts`

This task builds the grid layout, dispatches to cell renderers/editors, wires the cursor, and exposes a clean API. The header menu, resize, and reorder come in Phase 3.

- [ ] **Step 1: Write `DataGrid.tsx`**

```tsx
import { useMemo, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Checkbox } from "../Checkbox";
import { TextCell } from "./cells/TextCell";
import { NumberCell } from "./cells/NumberCell";
import { BooleanCell } from "./cells/BooleanCell";
import { DateCell } from "./cells/DateCell";
import { useGridCursor } from "./useGridCursor";
import { useUndoStack } from "./UndoStack";
import type { ColumnDef, DataGridProps, CellType } from "./types";

const CELLS: Record<Exclude<CellType, "select">, { Renderer: any; Editor: any }> = {
  text: TextCell, number: NumberCell, boolean: BooleanCell, date: DateCell,
};

export function DataGrid<Row>(props: DataGridProps<Row>) {
  const { rows, rowKey, columns, selection, onCommit, empty } = props;
  const visible = columns.filter((c) => !c.hidden);
  const selectionCol = !!selection;
  const undo = useUndoStack();

  // template: optional checkbox + each visible column's width
  const gridStyle = useMemo(() => {
    const tracks = visible.map((c) => (c.width ? `${c.width}px` : "minmax(96px, 1fr)"));
    if (selectionCol) tracks.unshift("28px");
    return { gridTemplateColumns: tracks.join(" ") };
  }, [visible, selectionCol]);

  // pending edit value lives inside the editor; commit flows back via the props.onCommit
  const commitValue = async (rk: string, field: string, value: unknown) => {
    await onCommit(rk, field, value);
  };

  const cursor = useGridCursor({
    rows, rowKey, columns: visible,
    onCommit: () => { /* the editor's onBlur handles the actual value commit */ },
    onSelectAll: () => selection?.onChange(rows.map(rowKey)),
    onUndo: () => undo.undo(),
    onRedo: () => undo.redo(),
  });

  const isSelected = (rk: string) => selection?.selected.includes(rk) ?? false;
  const toggle = (rk: string) => {
    if (!selection) return;
    const next = isSelected(rk) ? selection.selected.filter((x) => x !== rk) : [...selection.selected, rk];
    selection.onChange(next);
  };

  return (
    <div
      ref={cursor.ref}
      tabIndex={0}
      onKeyDown={cursor.onKeyDown}
      className="overflow-x-auto rounded-lg border border-line bg-surface outline-none focus:ring-1 focus:ring-accent/40"
    >
      {/* header row */}
      <div className="grid items-center gap-3 border-b border-line px-5 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3" style={gridStyle}>
        {selectionCol && (
          <Checkbox
            state={selection!.selected.length === rows.length && rows.length > 0
              ? "on"
              : selection!.selected.length > 0 ? "mixed" : "off"}
            onClick={() => selection!.onChange(
              selection!.selected.length === rows.length ? [] : rows.map(rowKey)
            )}
            aria-label="Select all"
          />
        )}
        {visible.map((c) => (
          <span key={c.field}
            className={cx("truncate", c.align === "right" && "text-right")}
            data-header={c.field}>{c.label}</span>
        ))}
      </div>

      {/* body */}
      {rows.length === 0 ? (
        empty ?? <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">No rows.</div>
      ) : rows.map((row) => {
        const rk = rowKey(row);
        const selected = isSelected(rk);
        return (
          <div key={rk}
            className={cx(
              "grid items-center gap-3 border-b border-line px-5 py-3 transition-colors",
              selected ? "bg-accent-wash" : "hover:bg-hover",
            )}
            style={gridStyle}
            data-row={rk}
          >
            {selectionCol && (
              <Checkbox state={selected ? "on" : "off"} onClick={() => toggle(rk)} aria-label={`Select row ${rk}`} />
            )}
            {visible.map((c) => {
              const focused = cursor.cursor?.rowKey === rk && cursor.cursor?.field === c.field;
              const editing = focused && cursor.cursor?.editing;
              const value = (row as any)[c.field];
              const ctx = { row, rowKey: rk, field: c.field, value, focused };
              const onClick = () => {
                cursor.setCursor({ rowKey: rk, field: c.field, editing: false });
              };
              const onDoubleClick = () => {
                if (c.editable === false) return;
                cursor.setCursor({ rowKey: rk, field: c.field, editing: true });
              };
              const cellCx = cx(
                "min-w-0 px-1",
                c.align === "right" && "justify-self-end text-right",
                focused && "ring-1 ring-accent bg-accent-wash/40 rounded-sm",
              );
              const data = `${rk}::${c.field}`;
              return (
                <div key={c.field}
                  data-cell={data}
                  onClick={onClick}
                  onDoubleClick={onDoubleClick}
                  className={cellCx}
                >
                  {editing && c.editable !== false
                    ? (c.edit
                        ? c.edit(row, {
                            ...ctx,
                            commit: (v) => { cursor.stopEdit(); void commitValue(rk, c.field, v); },
                            cancel: () => cursor.stopEdit(),
                          })
                        : c.type === "select"
                          ? null  // SelectCell.Editor is wired in Phase 2 (Task 10)
                          : <CellEditor type={c.type} ctx={{
                              ...ctx,
                              commit: (v) => { cursor.stopEdit(); void commitValue(rk, c.field, v); },
                              cancel: () => cursor.stopEdit(),
                            }} />)
                    : (c.render
                        ? c.render(row, ctx)
                        : c.type === "select"
                          ? null  // SelectCell.Renderer in Phase 2
                          : <CellRenderer type={c.type} ctx={ctx} />)}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function CellRenderer({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return null; // wired in Phase 2
  const C = CELLS[type as Exclude<CellType, "select">];
  return <C.Renderer {...ctx} />;
}

function CellEditor({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return null; // wired in Phase 2
  const C = CELLS[type as Exclude<CellType, "select">];
  return <C.Editor {...ctx} />;
}
```

- [ ] **Step 2: Write `index.ts` (barrel export)**

```ts
export { DataGrid } from "./DataGrid";
export { Chip } from "./Chip";
export { UndoStackProvider, useUndoStack } from "./UndoStack";
export { useGridCursor } from "./useGridCursor";
export { bucket, hash32 } from "./bucket";
export type { ColumnDef, CellType, Cursor, CellCtx, EditCtx, DataGridProps } from "./types";
```

- [ ] **Step 3: Typecheck**

Run: `cd app && bun run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx app/src/components/datagrid/index.ts
git commit -m "feat(datagrid): DataGrid layout + cursor wiring (select cell stubbed)"
```

---

## Phase 1 verification

Manual smoke check — the package compiles, but no route uses it yet. Just confirm the typecheck is green.

- [ ] **Run:** `cd app && bun run typecheck` — passes
- [ ] **Run:** `cd app && bun run build` — passes (catches tree-shaking issues)

---

# Phase 2 — Single-select column type, persistence, and MasterTables refactor

Goal: ship the headline feature. `dim_/map_` columns can be `select`-typed with an inline-creatable option list; MasterTables mounts `<DataGrid>` for its body.

## Task 7: Schema migration — `dimension_field.options`

**Files:**
- Modify: `server/src/schema.ts` — add an idempotent ALTER for the new column

- [ ] **Step 1: Add the ALTER inside `ensureSchema`**

In `server/src/schema.ts`, locate the block where `dimension_field` is created (it ends with `PRIMARY KEY (dim_id, field)`). Immediately AFTER that `CREATE TABLE IF NOT EXISTS`, add:

```ts
  // single-select columns store an ordered list of allowed option labels (JSONB
  // for queryability; the column is nullable — text/number/boolean/date columns
  // keep it null). ADD COLUMN IF NOT EXISTS for idempotency.
  await run(`ALTER TABLE ${pg("dimension_field")} ADD COLUMN IF NOT EXISTS options JSONB`);
```

- [ ] **Step 2: Typecheck + apply**

```bash
cd server && bun run typecheck && bun run bootstrap
```

Expected: bootstrap completes; the `dimension_field` table now has an `options` column (verify via `psql` or via the verify script in Task 13).

- [ ] **Step 3: Commit**

```bash
git add server/src/schema.ts
git commit -m "feat(schema): dimension_field.options jsonb (for single-select)"
```

---

## Task 8: `repo.ts` — `FieldDef.options`, `listFields` projection, `addColumnOption`

**Files:**
- Modify: `server/src/repo.ts`

- [ ] **Step 1: Extend `FieldDef`**

In `server/src/repo.ts:14`, change:

```ts
export interface FieldDef { field: string; label: string; type: string }
```

to:

```ts
export interface FieldDef { field: string; label: string; type: string; options?: string[] }
```

- [ ] **Step 2: Project `options` in `listFields`**

Find `listFields` (`repo.ts:632-634`). Replace with:

```ts
export async function listFields(dimId: string): Promise<FieldDef[]> {
  const rows = await all<{ field: string; label: string; type: string; options: unknown }>(
    `SELECT field, label, type, options FROM ${pg("dimension_field")} WHERE dim_id = $1 ORDER BY created_at`,
    [dimId],
  );
  return rows.map((r) => ({
    field: r.field, label: r.label, type: r.type,
    options: Array.isArray(r.options) ? (r.options as string[]) : undefined,
  }));
}
```

- [ ] **Step 3: Extend `addField` to accept an initial options list (for type=select)**

Replace `addField` (`repo.ts:642-654`) with:

```ts
export async function addField(dimId: string, label: string, type = "text", options?: string[]): Promise<{ field: string } | null> {
  const m = await dimMeta(dimId);
  if (!m) return null;
  const t = SQL_TYPE[type] ? type : (type === "select" ? "select" : "text");
  const field = slug(label);
  if (!field || field === "label" || field === slug(m.keyCol)) return null;
  // select columns are stored as VARCHAR on the dim_ table (the value IS the label)
  const sqlType = t === "select" ? "VARCHAR" : SQL_TYPE[t];
  await run(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN IF NOT EXISTS ${qid(field)} ${sqlType}`);
  const opts = t === "select" ? JSON.stringify(options ?? []) : null;
  await run(
    `INSERT INTO ${pg("dimension_field")} (dim_id, field, label, type, options, created_at) VALUES ($1,$2,$3,$4,$5, current_timestamp)
     ON CONFLICT (dim_id, field) DO NOTHING`, [dimId, field, label.trim(), t, opts]);
  await appendAudit("Added field", `${label.trim()} (${field}, ${t}) → ${m.dimTable}`);
  return { field };
}
```

- [ ] **Step 4: Add `addColumnOption` — append an option to a select column**

After `addField` (around line 655, before `setFieldValue`), add:

```ts
/** Append a new option to a select column's options list. No-op if the option
 *  already exists (case-sensitive). Returns the resulting options list. */
export async function addColumnOption(dimId: string, field: string, label: string): Promise<{ options: string[] } | null> {
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f || f.type !== "select") return null;
  const existing = f.options ?? [];
  if (existing.includes(label)) return { options: existing };
  const next = [...existing, label];
  await run(
    `UPDATE ${pg("dimension_field")} SET options = $1::jsonb WHERE dim_id = $2 AND field = $3`,
    [JSON.stringify(next), dimId, field],
  );
  await appendAudit("Added option", `${label} → ${field}`);
  return { options: next };
}
```

- [ ] **Step 5: Typecheck**

Run: `cd server && bun run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(repo): FieldDef.options + addColumnOption (select column)"
```

---

## Task 9: API routes — option-add + the addField `options` parameter

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: Update the `fields` POST to accept `options`**

Find the existing `POST /api/dimensions/:id/fields` route (`server.ts:160-164`) and replace with:

```ts
        // POST /api/dimensions/:id/fields {label, type?, options?} — add an attribute column
        if (seg[3] === "fields" && seg.length === 4 && method === "POST") {
          const { label, type, options } = (await req.json()) as { label: string; type?: string; options?: string[] };
          return json(await repo.addField(id, label, type, options));
        }
```

- [ ] **Step 2: Add `POST /api/dimensions/:id/fields/:field/options`**

Immediately after the `fields` POST handler from Step 1, add:

```ts
        // POST /api/dimensions/:id/fields/:field/options {label} — append a select option
        if (seg[3] === "fields" && seg[5] === "options" && seg.length === 6 && method === "POST") {
          const field = decodeURIComponent(seg[4]!);
          const { label } = (await req.json()) as { label: string };
          const res = await repo.addColumnOption(id, field, label);
          return res ? json(res) : json({ error: "not a select column" }, 400);
        }
```

- [ ] **Step 3: Typecheck**

Run: `cd server && bun run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(api): options on addField + POST /fields/:field/options"
```

---

## Task 10: `SelectCell.tsx` — chip rendering + picker

**Files:**
- Create: `app/src/components/datagrid/cells/SelectCell.tsx`
- Modify: `app/src/components/datagrid/DataGrid.tsx` — wire SelectCell into the renderer/editor dispatch

- [ ] **Step 1: Write `SelectCell.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Chip } from "../Chip";
import type { CellCtx, EditCtx } from "../types";

/* SelectCell — single-select chip. Renderer shows the chip; Editor opens a
   picker (search + filtered options + "create new" affordance). Options live
   on the column definition (FieldDef.options). Creating a new option fires
   onCreate (host wires this to addColumnOption). */

function Renderer<Row>({ value }: CellCtx<Row>) {
  if (value == null || value === "") return <span className="font-mono text-[12px] text-ink-3">—</span>;
  return <Chip label={String(value)} />;
}

interface SelectEditorProps<Row> extends EditCtx<Row> {
  options: string[];
  onCreate: (label: string) => Promise<string[]>; // returns the new options list
}

function Editor<Row>(props: SelectEditorProps<Row>) {
  const { value, commit, cancel, options, onCreate } = props;
  const [opts, setOpts] = useState(options);
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return opts;
    return opts.filter((o) => o.toLowerCase().includes(needle));
  }, [opts, q]);
  const exact = filtered.some((o) => o.toLowerCase() === q.trim().toLowerCase());
  const canCreate = q.trim().length > 0 && !exact;

  const choose = (label: string) => commit(label);
  const create = async () => {
    const label = q.trim();
    if (!label) return;
    const next = await onCreate(label);
    setOpts(next);
    commit(label);
  };

  return (
    <div className="absolute left-0 top-0 z-30 w-[220px] rounded-sm border border-line-2 bg-surface p-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef} value={q}
        placeholder="search or create…"
        onChange={(e) => { setQ(e.target.value); setHl(0); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(filtered.length, h + 1)); return; }
          if (e.key === "ArrowUp")   { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); return; }
          if (e.key === "Enter") {
            e.preventDefault();
            if (hl < filtered.length) choose(filtered[hl]);
            else if (canCreate) void create();
            return;
          }
        }}
        className="mb-1 w-full rounded-sm border border-line-2 bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
      />
      <div className="max-h-48 overflow-y-auto">
        {filtered.map((o, i) => (
          <button
            key={o} type="button"
            onMouseEnter={() => setHl(i)}
            onMouseDown={(e) => { e.preventDefault(); choose(o); }}
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left ${i === hl ? "bg-accent-wash" : "hover:bg-hover"}`}
          >
            <Chip label={o} />
          </button>
        ))}
        {/* highlighted current value (when picker opens with a value set) */}
        {value != null && value !== "" && !filtered.includes(String(value)) && (
          <div className="px-2 py-1 font-mono text-[10.5px] text-ink-3">current: {String(value)}</div>
        )}
        {canCreate && (
          <button
            type="button"
            onMouseEnter={() => setHl(filtered.length)}
            onMouseDown={(e) => { e.preventDefault(); void create(); }}
            className={`mt-1 flex w-full items-center gap-1.5 border-t border-line px-2 py-1.5 text-left font-mono text-[11px] text-accent ${hl === filtered.length ? "bg-accent-wash" : ""}`}
          >
            + create option “{q.trim()}”
          </button>
        )}
      </div>
    </div>
  );
}

export const SelectCell = { Renderer, Editor };
```

- [ ] **Step 2: Wire `SelectCell` into `DataGrid.tsx`**

In `app/src/components/datagrid/DataGrid.tsx`, replace the two stubs labeled `// SelectCell.Renderer in Phase 2` and `// SelectCell.Editor is wired in Phase 2 (Task 10)`.

For `CellRenderer` (near the bottom of the file), replace:

```ts
function CellRenderer({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return null; // wired in Phase 2
  const C = CELLS[type as Exclude<CellType, "select">];
  return <C.Renderer {...ctx} />;
}
```

with:

```ts
function CellRenderer({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return <SelectCell.Renderer {...ctx} />;
  const C = CELLS[type as Exclude<CellType, "select">];
  return <C.Renderer {...ctx} />;
}
```

And add at the top with the other cell imports:

```ts
import { SelectCell } from "./cells/SelectCell";
```

Inside the cell-rendering JSX (the `editing && c.editable !== false` branch in the body row map), the current code reads:

```ts
                    : c.type === "select"
                      ? null  // SelectCell.Editor is wired in Phase 2 (Task 10)
                      : <CellEditor type={c.type} ctx={...} />
```

Replace the `: c.type === "select" ? null` branch with a wired SelectCell editor:

```ts
                    : c.type === "select"
                      ? <SelectCell.Editor
                          row={row} rowKey={rk} field={c.field} value={value} focused
                          commit={(v) => { cursor.stopEdit(); void commitValue(rk, c.field, v); }}
                          cancel={() => cursor.stopEdit()}
                          options={c.options ?? []}
                          onCreate={async (label) => {
                            if (!props.onAddColumnOption) return c.options ?? [];
                            return await props.onAddColumnOption(c.field, label);
                          }}
                        />
                      : <CellEditor type={c.type} ctx={{
                          ...ctx,
                          commit: (v) => { cursor.stopEdit(); void commitValue(rk, c.field, v); },
                          cancel: () => cursor.stopEdit(),
                        }} />
```

Note: the cell `<div>` already has relative positioning (the `min-w-0 px-1` + the focus ring); to host the absolutely-positioned picker, change the cell wrapper class to include `relative`:

In the same DataGrid body row, change `cellCx`:

```ts
              const cellCx = cx(
                "relative min-w-0 px-1",      // added: relative (so picker can absolute-position inside)
                c.align === "right" && "justify-self-end text-right",
                focused && "ring-1 ring-accent bg-accent-wash/40 rounded-sm",
              );
```

- [ ] **Step 3: Re-export `SelectCell` from the barrel**

In `app/src/components/datagrid/index.ts`, add:

```ts
export { SelectCell } from "./cells/SelectCell";
```

- [ ] **Step 4: Typecheck**

Run: `cd app && bun run typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/datagrid/cells/SelectCell.tsx app/src/components/datagrid/DataGrid.tsx app/src/components/datagrid/index.ts
git commit -m "feat(datagrid): SelectCell + picker (chip render, inline-create option)"
```

---

## Task 11: Client types + store mutation for option-add

**Files:**
- Modify: `app/src/data.ts` — extend `FieldDef`
- Modify: `app/src/store.ts` — add `addColumnOption` mutation; extend `addField` signature

- [ ] **Step 1: Extend `FieldDef` in `data.ts`**

In `app/src/data.ts:24`, change:

```ts
export interface FieldDef { field: string; label: string; type: string }
```

to:

```ts
export interface FieldDef { field: string; label: string; type: string; options?: string[] }
```

- [ ] **Step 2: Extend `addField` in `store.ts`**

Find `addField` in `app/src/store.ts`. Replace its signature/body with:

```ts
export async function addField(dimId: string, label: string, type = "text", options?: string[]): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields`, {
    method: "POST",
    body: JSON.stringify({ label, type, options }),
  });
  await refreshDims();
  await refreshAudit();
  emit();
}
```

- [ ] **Step 3: Add `addColumnOption`**

Below `addField`, add:

```ts
/** Append a new option to a select column's allowed list. Refetches the
 *  dimension so subsequent picks see the new option. Returns the new list. */
export async function addColumnOption(dimId: string, field: string, label: string): Promise<string[]> {
  const res = await api<{ options: string[] }>(
    `/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}/options`,
    { method: "POST", body: JSON.stringify({ label }) },
  );
  await refreshDims();
  emit();
  return res.options;
}
```

- [ ] **Step 4: Typecheck**

Run: `cd app && bun run typecheck`
Expected: passes (the new `options` field on `FieldDef` is optional, so existing call sites still typecheck).

- [ ] **Step 5: Commit**

```bash
git add app/src/data.ts app/src/store.ts
git commit -m "feat(store): FieldDef.options + addColumnOption + addField(options)"
```

---

## Task 12: Refactor `MasterTables` body to use `<DataGrid>`

**Files:**
- Modify: `app/src/routes/MasterTables.tsx`
- Modify: `app/src/main.tsx` — wrap the app in `<UndoStackProvider>` so the grid finds the context

Goal: replace the hand-rolled grid markup in MasterTables (rows + AddColumn + FieldCell + per-row icon buttons) with a DataGrid mount. Selection-bar-only convention: drop the per-row ✎/✕ buttons; rename moves to header-menu/inline-edit (Phase 3), remove moves to bulk action bar.

- [ ] **Step 1: Mount `UndoStackProvider` at the app root**

In `app/src/main.tsx`, find the existing render call. Wrap whatever currently renders (likely `<RouterProvider router={…} />` inside `<ThemeProvider>` or similar) with `<UndoStackProvider>`. Read the file first:

```bash
cat app/src/main.tsx
```

Then wrap the root component. Example shape (yours may differ):

```tsx
import { UndoStackProvider } from "./components/datagrid";
// …
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UndoStackProvider>
      {/* existing children, e.g. <RouterProvider … /> */}
    </UndoStackProvider>
  </React.StrictMode>,
);
```

The provider takes an optional `scopeKey`; we'll pass that from the route in a later task so the stack clears on dimension switch. For now, no scopeKey is fine.

- [ ] **Step 2: Build column defs in MasterTables**

In `app/src/routes/MasterTables.tsx`, just below `const external = dim.keyKind === "external_id";` (~line 96), add a memoised column-def builder. Replace lines 98-99 (the `gridStyle` and `activeId` block) with:

```ts
  const activeId = dim.id;

  // column defs for <DataGrid>. The first three are pinned (checkbox is
  // managed by the grid itself; "Master record" and "Key" are pinned-left
  // and not part of the attribute-fields loop).
  const columns = useMemo<ColumnDef<CanonicalValue>[]>(() => {
    const cols: ColumnDef<CanonicalValue>[] = [
      {
        field: "label",
        label: "Master record",
        type: "text",
        pinnedLeft: true,
        editable: !external,
        render: (c) => (
          <button type="button"
            onClick={() => toggleOpen(c.key)}
            className="flex min-w-0 items-center gap-2 text-left"
          >
            <IconChevron className={cx("h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform", open === c.key && "rotate-180")} />
            {c.unresolved ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[13px] text-ink-2">{c.key}</span>
                <Badge tone="warn">unresolved</Badge>
              </span>
            ) : (
              <span className="truncate font-display text-[14px] font-semibold text-ink">{c.label}</span>
            )}
          </button>
        ),
        edit: (c, { commit }) => (
          <input autoFocus defaultValue={c.label}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value.trim());
              if (e.key === "Escape") commit(c.label); // no-op cancel
            }}
            onBlur={(e) => commit(e.target.value.trim())}
            className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-display text-[14px] font-semibold text-ink outline-none"
          />
        ),
      },
      {
        field: "key",
        label: engineer ? dim.keyCol : "Key",
        type: "text",
        pinnedLeft: true,
        editable: false,
        render: (c) => (
          <span className="truncate font-mono text-[12px] text-accent">{external && c.unresolved ? "" : c.key}</span>
        ),
      },
      ...fields.map<ColumnDef<CanonicalValue>>((f) => ({
        field: f.field,
        label: f.label,
        type: f.type as ColumnDef<CanonicalValue>["type"],
        options: f.options,
        editable: true,
        // value extraction: <DataGrid> reads row[field]; map from c.fields[field]
        render: undefined,   // built-in renderer (uses (row as any)[c.field])
      })),
      {
        field: "variants",
        label: "Raw",
        type: "number",
        editable: false,
        align: "right",
        render: (c) => (c.variants ?? 0) > 0
          ? <Badge>{c.variants}</Badge>
          : <span className="font-mono text-[11px] text-ink-3">0</span>,
      },
    ];
    return cols;
  }, [fields, engineer, dim.keyCol, external, open]);

  // <DataGrid> reads (row as any)[c.field]. The MasterTables CanonicalValue
  // shape stores attribute values in c.fields[field]; flatten before passing
  // so cell renderers see row.region etc.
  const rowsForGrid = useMemo(
    () => list.map((c) => ({ ...c, ...(c.fields ?? {}) })),
    [list],
  );
```

- [ ] **Step 3: Replace the grid body with `<DataGrid>`**

In `app/src/routes/MasterTables.tsx`, find the markup that today renders the table — starting at the comment `{/* header / merge bar */}` (around line 194) and ending at the closing `</div>` of `{!external && ( <div className="flex items-center gap-2 px-5 py-3"> …add row input… </div> )}`. Replace that ENTIRE block (header row, body rows including the expandable variants drawer, and the bottom add-row input) with:

```tsx
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2.5">
          {sel.length === 0 ? (
            <span className="font-mono text-[11.5px] text-ink-3">
              {list.length >= 2 ? "Tip — select two or more master records to merge them into one." : ""}
            </span>
          ) : (
            <>
              <Checkbox state="mixed" onClick={() => setSel([])} aria-label="Clear" />
              <span className="font-mono text-[12px] text-ink">{sel.length} selected</span>
              <div className="w-56">
                <ComboSelect options={list.filter((c) => sel.includes(c.key)).map((c) => c.label)}
                  value={null} placeholder={sel.length < 2 ? "select 2+ to merge" : "Merge into…"} onPick={merge} />
              </div>
              <Button size="sm" variant="secondary" icon={<IconX className="h-3.5 w-3.5" />}
                onClick={async () => {
                  for (const k of sel) {
                    const c = list.find((x) => x.key === k);
                    if (c) await retire(k, c.label);
                  }
                  setSel([]);
                }}
                disabled={busy}
              >Remove</Button>
              <button type="button" onClick={() => setSel([])} className="ml-auto font-mono text-[11px] text-ink-3 hover:text-ink">clear</button>
            </>
          )}
        </div>

        <DataGrid<CanonicalValue & Record<string, unknown>>
          rows={rowsForGrid}
          rowKey={(c) => c.key}
          columns={columns}
          selection={{ selected: sel, onChange: setSel }}
          onCommit={async (rowKey, field, value) => {
            if (field === "label") {
              if (typeof value === "string" && value.trim() && value !== list.find((c) => c.key === rowKey)?.label) {
                await renameCanonical(activeId, rowKey, value);
              }
              return;
            }
            // attribute field
            const v = value == null ? null : String(value);
            await setFieldValue(activeId, rowKey, field, v);
          }}
          onAddColumnOption={(field, label) => addColumnOption(activeId, field, label)}
          empty={<div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">no master records yet — import from a source above, or add one below</div>}
        />

        {/* per-row expandable variants drawer — kept under the grid as a separate slice */}
        {open && (() => {
          const c = list.find((x) => x.key === open);
          const cached = c ? variantsCache[ck(c.key)] : undefined;
          if (!c) return null;
          return (
            <div className="border-b border-line bg-surface-2/40 px-5 py-3 pl-[44px]">
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                raw values mapped to <span className="text-ink">{c.label}</span>
              </div>
              {cached === "loading" ? (
                <div className="mt-2 font-mono text-[11px] text-ink-3">loading…</div>
              ) : cached && cached.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {cached.map((raw) => <span key={raw} className="rounded-sm border border-line-2 bg-surface px-2 py-1 font-mono text-[11.5px] text-ink-2">{raw}</span>)}
                </div>
              ) : <div className="mt-2 font-mono text-[11px] text-ink-3">no source values map here yet — match them on Value mapping</div>}
            </div>
          );
        })()}

        {!external && (
          <div className="flex items-center gap-2 border-t border-line px-5 py-3">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder={`New ${dim.dimension.toLowerCase()} master record…`}
              className="w-full max-w-xs rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent" />
            {draft.trim() && <span className="font-mono text-[11px] text-ink-3">{dim.keyCol} = <span className="text-accent">{slug(draft)}</span></span>}
            <Button size="sm" icon={<IconPlus className="h-3.5 w-3.5" />} onClick={add} disabled={!draft.trim() || busy} className="ml-auto">Add record</Button>
          </div>
        )}
```

- [ ] **Step 4: Update imports**

At the top of `app/src/routes/MasterTables.tsx`, ADD these imports (keep the existing imports unchanged):

```ts
import { DataGrid } from "../components/datagrid";
import type { ColumnDef } from "../components/datagrid";
import type { CanonicalValue } from "../data";
import { addColumnOption } from "../store";
```

And REMOVE the imports that are no longer used after this refactor (only if your editor reports them unused — `cd app && bun run typecheck` will tell you):
- `Fragment` (no longer needed)
- `IconEdit` (per-row rename gone)
- The inline `FieldCell` / `AddColumn` components below the imports can also be removed once the grid takes over field editing — DO this only after the grid is mounted and the manual smoke check (Step 5) is green.

The `AddColumn` component (Lines 52-69) and `FieldCell` (Lines 27-49) are no longer mounted in JSX after the refactor. Delete them. The `AddColumn` capability is moved into the toolbar — change the toolbar (around line 180-184) to keep the existing `<AddColumn onAdd={...}>` if you prefer, OR add a "+ column" affordance using the new column header menu in Phase 3. For Phase 2, the simplest path is to **keep** `AddColumn` (it still works through `addField`); remove only `FieldCell` since the grid renders cells now.

Concretely: delete `FieldCell` (lines 27-49). Keep `AddColumn` (lines 52-69) and its mount point in the toolbar.

- [ ] **Step 5: Typecheck and manual smoke**

```bash
cd app && bun run typecheck
```

Then in two terminals:

```bash
# terminal 1
cd server && bun run start
# terminal 2
cd app && bun run dev
```

Navigate to `/master-lists` (or wherever MasterTables is mounted in the router). Verify:
- Rows render with master record + key + any attribute columns + raw count.
- Click a label cell → it does NOT enter edit mode (text cells need double-click; rename is also reachable via the cell's `edit` hook).
- Double-click a label cell → rename input appears; Enter commits; Escape cancels.
- Click an attribute cell → focus ring appears.
- Add an attribute column via the toolbar's `+ column` affordance with type `text` → it shows in the grid.
- Add a column of type `select` (the toolbar's AddColumn doesn't expose `select` yet — that's done by changing an existing column's type in Phase 3; for now, manually invoke it from the browser console via the `addField` store function or skip until Phase 3).
- Selection bar appears when you check a row; per-row ✎/✕ buttons are gone.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/MasterTables.tsx app/src/main.tsx
git commit -m "refactor(master-tables): mount <DataGrid> body + drop per-row icon buttons"
```

---

## Task 13: `verify-datagrid.ts` — regression harness (Phase 2 portion)

**Files:**
- Create: `server/src/verify-datagrid.ts`
- Modify: `server/package.json` — add a script

- [ ] **Step 1: Add script entry**

In `server/package.json` `scripts` block, after `"verify-polish": "bun run src/verify-polish.ts"`, add:

```json
    "verify-datagrid": "bun run src/verify-datagrid.ts",
```

- [ ] **Step 2: Write the verify script**

Create `server/src/verify-datagrid.ts`:

```ts
/* verify-datagrid.ts — exercises the new DataGrid-backing endpoints end-to-end
   against the REAL Postgres. Self-cleaning: drops a throwaway dimension at the
   end so re-runs are idempotent.

   Run: `bun run verify-datagrid`. */

import * as repo from "./repo.ts";
import { ensureSchema } from "./schema.ts";
import { run, all } from "./db.ts";
import { pg } from "./env.ts";

const SCOPE = "_dg_verify_" + Math.random().toString(36).slice(2, 8);

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`▸ ${label} … `);
  const t = Date.now();
  try { const r = await fn(); process.stdout.write(`ok (${Date.now() - t}ms)\n`); return r; }
  catch (e) { process.stdout.write("FAIL\n"); throw e; }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assert: " + msg);
}

async function cleanup() {
  // remove anything we created (best-effort)
  try { await run(`DELETE FROM ${pg("dimension_field")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]); } catch {}
  try { await run(`DELETE FROM ${pg("dimension_source")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]); } catch {}
  try { await run(`DELETE FROM ${pg("dimension")} WHERE id LIKE $1`, [`${SCOPE}%`]); } catch {}
  // drop the per-dim canonical tables (best-effort; names are derived from id)
  // they're under env.canonicalSchema; safe to ignore if not present
}

(async () => {
  await ensureSchema();

  await step("clean prior scope rows", cleanup);

  const dimId = await step("create test dimension", async () => {
    return await repo.addDimension(`${SCOPE} country`, []);
  });
  assert(dimId.startsWith(SCOPE), "dimId should start with scope");

  await step("addField(text)", async () => {
    const r = await repo.addField(dimId, "Capital");
    assert(r?.field === "capital", `expected field 'capital', got ${r?.field}`);
  });

  await step("addField(select, options=[EMEA,AMER])", async () => {
    const r = await repo.addField(dimId, "Region", "select", ["EMEA", "AMER"]);
    assert(r?.field === "region", `expected field 'region', got ${r?.field}`);
    const fields = await repo.listFields(dimId);
    const region = fields.find((f) => f.field === "region");
    assert(region?.type === "select", "region type is select");
    assert(JSON.stringify(region?.options) === JSON.stringify(["EMEA", "AMER"]), `options mismatch: ${JSON.stringify(region?.options)}`);
  });

  await step("addColumnOption appends a new option", async () => {
    const r = await repo.addColumnOption(dimId, "region", "APAC");
    assert(JSON.stringify(r?.options) === JSON.stringify(["EMEA", "AMER", "APAC"]), `options after add: ${JSON.stringify(r?.options)}`);
  });

  await step("addColumnOption is idempotent on duplicate label", async () => {
    const r = await repo.addColumnOption(dimId, "region", "APAC");
    assert(JSON.stringify(r?.options) === JSON.stringify(["EMEA", "AMER", "APAC"]), `idempotent expected, got: ${JSON.stringify(r?.options)}`);
  });

  await step("addColumnOption refuses non-select column", async () => {
    const r = await repo.addColumnOption(dimId, "capital", "Berlin");
    assert(r === null, `expected null for non-select column, got: ${JSON.stringify(r)}`);
  });

  await step("cleanup", cleanup);

  console.log("\n✓ verify-datagrid (Phase 2): all checks passed");
  process.exit(0);
})().catch((e) => { console.error("\n✗ verify-datagrid:", e?.message ?? e); process.exit(1); });
```

- [ ] **Step 3: Run it**

```bash
cd server && bun run verify-datagrid
```

Expected: every step prints `ok`, ends with `✓ verify-datagrid (Phase 2): all checks passed`.

- [ ] **Step 4: Commit**

```bash
git add server/src/verify-datagrid.ts server/package.json
git commit -m "test(server): verify-datagrid harness (option list endpoints)"
```

---

## Phase 2 verification

- [ ] `cd app && bun run typecheck` — passes
- [ ] `cd server && bun run typecheck` — passes
- [ ] `cd server && bun run verify-datagrid` — passes
- [ ] Manual smoke (dev server): MasterTables renders via DataGrid; rows scrollable; arrow-key cursor works; selection bar appears on check; rename via double-click commits

---

# Phase 3 — Column header menu, resize + reorder, persisted grid layout

Goal: every column gets a hover-revealed `⋯` menu with rename / change type / sort / hide / delete; columns can be resized via the right-edge grip and reordered via header drag (200ms hold); widths, order, and hidden columns persist per-user-per-dimension.

## Task 14: Schema — `user_grid_layout` table

**Files:**
- Modify: `server/src/schema.ts`

- [ ] **Step 1: Add the CREATE TABLE inside `ensureSchema`**

In `server/src/schema.ts`, after the `preferences` block, add:

```ts
  // per-user-per-dimension UI layout: column widths, order, hidden set. NOT
  // saved views — those are deferred. config is a single JSONB blob so the
  // server schema doesn't need to know its shape. PATCH writes the whole blob.
  await run(`CREATE TABLE IF NOT EXISTS ${pg("user_grid_layout")} (
    user_id    VARCHAR NOT NULL,
    dim_id     VARCHAR NOT NULL,
    config     JSONB   NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, dim_id)
  )`);
```

- [ ] **Step 2: Apply**

```bash
cd server && bun run typecheck && bun run bootstrap
```

Expected: no errors; table exists.

- [ ] **Step 3: Commit**

```bash
git add server/src/schema.ts
git commit -m "feat(schema): user_grid_layout (per-user column widths/order/hidden)"
```

---

## Task 15: `repo.ts` — getGridLayout / setGridLayout + column rename / change-type / delete

**Files:**
- Modify: `server/src/repo.ts`

- [ ] **Step 1: Add the layout types + functions**

Near the bottom of `server/src/repo.ts`, before the file ends, add:

```ts
/* ---- per-user grid layout (column widths / order / hidden) ---- */

export interface GridLayoutConfig {
  widths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
}

export async function getGridLayout(userId: string, dimId: string): Promise<GridLayoutConfig> {
  const row = await get<{ config: unknown }>(
    `SELECT config FROM ${pg("user_grid_layout")} WHERE user_id = $1 AND dim_id = $2`, [userId, dimId],
  );
  if (!row) return {};
  return typeof row.config === "object" && row.config != null ? (row.config as GridLayoutConfig) : {};
}

/** Upsert the full layout config for (user, dim). Caller sends a *complete*
 *  config; partial merging is the client's job (it knows what changed). */
export async function setGridLayout(userId: string, dimId: string, config: GridLayoutConfig): Promise<void> {
  await run(
    `INSERT INTO ${pg("user_grid_layout")} (user_id, dim_id, config, updated_at) VALUES ($1, $2, $3::jsonb, current_timestamp)
     ON CONFLICT (user_id, dim_id) DO UPDATE SET config = EXCLUDED.config, updated_at = current_timestamp`,
    [userId, dimId, JSON.stringify(config)],
  );
}
```

- [ ] **Step 2: Add `renameColumn`**

After `addColumnOption` (added in Task 8), add:

```ts
/** Rename a column's display label. The `field` (stable id / DB column name)
 *  stays put; only `label` changes. */
export async function renameColumn(dimId: string, field: string, newLabel: string): Promise<void> {
  const label = newLabel.trim();
  if (!label) return;
  await run(`UPDATE ${pg("dimension_field")} SET label = $1 WHERE dim_id = $2 AND field = $3`, [label, dimId, field]);
  await appendAudit("Renamed column", `${field} → "${label}"`);
}
```

- [ ] **Step 3: Add `changeColumnType`**

After `renameColumn`, add:

```ts
/** Change a column's type. Validates that every existing cell value parses to
 *  the new type; returns { ok: false, invalidCount } when N cells would
 *  silently null. Caller decides whether to retry with coerceInvalidToNull. */
export async function changeColumnType(
  dimId: string,
  field: string,
  newType: string,
  options?: string[],
  coerceInvalidToNull = false,
): Promise<{ ok: boolean; invalidCount?: number; options?: string[] }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false };
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f) return { ok: false };
  const col = qid(field);
  const keyc = qid(m.keyCol);

  // collect existing values
  const rows = await all<{ k: string; v: string | null }>(
    `SELECT ${keyc} AS k, CAST(${col} AS VARCHAR) AS v FROM ${cq(m.dimTable)}`,
  );

  // validate per-target-type
  const parsed: { k: string; v: string | number | boolean | null; bad: boolean }[] = [];
  for (const r of rows) {
    if (r.v == null || r.v === "") { parsed.push({ k: r.k, v: null, bad: false }); continue; }
    if (newType === "text") { parsed.push({ k: r.k, v: r.v, bad: false }); continue; }
    if (newType === "select") {
      const collected = options ?? [...new Set(rows.filter((x) => x.v).map((x) => x.v!))];
      const ok = collected.includes(r.v);
      parsed.push({ k: r.k, v: r.v, bad: !ok });
      continue;
    }
    if (newType === "number") {
      const n = Number(r.v);
      const ok = Number.isFinite(n);
      parsed.push({ k: r.k, v: ok ? n : null, bad: !ok });
      continue;
    }
    if (newType === "boolean") {
      const b = r.v === "true" ? true : r.v === "false" ? false : null;
      parsed.push({ k: r.k, v: b, bad: b == null });
      continue;
    }
    if (newType === "date") {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(r.v);
      parsed.push({ k: r.k, v: ok ? r.v : null, bad: !ok });
      continue;
    }
    parsed.push({ k: r.k, v: r.v, bad: true });
  }
  const invalidCount = parsed.filter((p) => p.bad).length;
  if (invalidCount > 0 && !coerceInvalidToNull) return { ok: false, invalidCount };

  // apply: ALTER COLUMN TYPE if going to/from non-VARCHAR; rewrite the column
  // value-by-value (small N for a dim_).
  const newSql = newType === "select" ? "VARCHAR"
    : newType === "number" ? "NUMERIC"
    : newType === "boolean" ? "BOOLEAN"
    : newType === "date" ? "DATE"
    : "VARCHAR";
  const tmp = `${field}__tmp_${Date.now().toString(36)}`;
  // create a tmp column with the new type, populate, drop original, rename
  await run(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN ${qid(tmp)} ${newSql}`);
  for (const p of parsed) {
    if (p.bad && !coerceInvalidToNull) continue;
    await run(`UPDATE ${cq(m.dimTable)} SET ${qid(tmp)} = $1 WHERE ${keyc} = $2`, [p.v, p.k]);
  }
  await run(`ALTER TABLE ${cq(m.dimTable)} DROP COLUMN ${col}`);
  await run(`ALTER TABLE ${cq(m.dimTable)} RENAME COLUMN ${qid(tmp)} TO ${col}`);

  // seed select options if going → select and none provided
  let finalOptions: string[] | undefined;
  if (newType === "select") {
    finalOptions = options ?? [...new Set(parsed.filter((p) => p.v != null).map((p) => String(p.v)))];
  }

  await run(
    `UPDATE ${pg("dimension_field")} SET type = $1, options = $2::jsonb WHERE dim_id = $3 AND field = $4`,
    [newType, newType === "select" ? JSON.stringify(finalOptions ?? []) : null, dimId, field],
  );
  await appendAudit("Changed column type", `${field} → ${newType}${finalOptions ? ` (${finalOptions.length} options)` : ""}`);
  return { ok: true, options: finalOptions };
}
```

- [ ] **Step 4: Add `deleteColumn`**

After `changeColumnType`, add:

```ts
/** Drop a column from the dim_ table AND its row in dimension_field, plus null
 *  the field on every row of the dim. Transactional — all-or-nothing. */
export async function deleteColumn(dimId: string, field: string): Promise<{ ok: boolean }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false };
  const col = qid(field);
  await run(`BEGIN`);
  try {
    await run(`DELETE FROM ${pg("dimension_field")} WHERE dim_id = $1 AND field = $2`, [dimId, field]);
    await run(`ALTER TABLE ${cq(m.dimTable)} DROP COLUMN IF EXISTS ${col}`);
    await run(`COMMIT`);
  } catch (e) {
    await run(`ROLLBACK`); throw e;
  }
  await appendAudit("Deleted column", field);
  return { ok: true };
}
```

- [ ] **Step 5: Typecheck**

Run: `cd server && bun run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(repo): grid layout + renameColumn + changeColumnType + deleteColumn"
```

---

## Task 16: API routes — grid-layout + column mutations

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: Add `GET / PATCH /api/grid-layout/:dimId`**

In `server/src/server.ts`, find the top-level route dispatch (`if (seg[1] === "audit"…`). After the `audit` block and before `if (seg[1] === "dimensions")`, add:

```ts
      if (seg[1] === "grid-layout" && seg.length === 3) {
        const dimId = decodeURIComponent(seg[2]!);
        if (method === "GET") return json(await repo.getGridLayout(actor(req).id, dimId));
        if (method === "PATCH") {
          // Client sends a complete config (full snapshot of widths/order/hidden);
          // server upserts. Debouncing is on the client.
          const body = (await req.json()) as repo.GridLayoutConfig;
          await repo.setGridLayout(actor(req).id, dimId, body);
          return noContent();
        }
      }
```

(`actor(req)` already exists in this file and returns a `User`-shaped record with `id`; reuse it.)

- [ ] **Step 2: Add column rename / change-type / delete routes**

Inside the `dimensions` block, after the `POST /api/dimensions/:id/fields {label, type?, options?}` handler (added in Task 9), add:

```ts
        // PUT/DELETE /api/dimensions/:id/fields/:field — rename / change type / delete
        if (seg[3] === "fields" && seg.length === 5) {
          const field = decodeURIComponent(seg[4]!);
          if (method === "PUT") {
            const body = (await req.json()) as { label?: string; type?: string; options?: string[]; coerceInvalidToNull?: boolean };
            if (body.label != null) {
              await repo.renameColumn(id, field, body.label);
            }
            if (body.type != null) {
              const res = await repo.changeColumnType(id, field, body.type, body.options, body.coerceInvalidToNull ?? false);
              return json(res);
            }
            return noContent();
          }
          if (method === "DELETE") return json(await repo.deleteColumn(id, field));
        }
```

- [ ] **Step 3: Typecheck**

Run: `cd server && bun run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(api): grid-layout PATCH + column rename/change-type/delete"
```

---

## Task 17: Client store — column-mutation + grid-layout

**Files:**
- Modify: `app/src/store.ts`

- [ ] **Step 1: Add `renameColumn`, `changeColumnType`, `deleteColumn`, `getGridLayout`, `setGridLayout` mutations**

Below the existing column mutations in `app/src/store.ts` (after `addColumnOption` from Task 11), add:

```ts
export async function renameColumn(dimId: string, field: string, newLabel: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`, {
    method: "PUT", body: JSON.stringify({ label: newLabel }),
  });
  await refreshDims(); emit();
}

export async function changeColumnType(
  dimId: string, field: string, newType: string,
  options?: string[], coerceInvalidToNull = false,
): Promise<{ ok: boolean; invalidCount?: number; options?: string[] }> {
  const res = await api<{ ok: boolean; invalidCount?: number; options?: string[] }>(
    `/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`,
    { method: "PUT", body: JSON.stringify({ type: newType, options, coerceInvalidToNull }) },
  );
  if (res.ok) { await refreshDims(); emit(); }
  return res;
}

export async function deleteColumn(dimId: string, field: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`, { method: "DELETE" });
  await refreshDims(); emit();
}

export interface GridLayoutConfig { widths?: Record<string, number>; order?: string[]; hidden?: string[] }

export async function getGridLayout(dimId: string): Promise<GridLayoutConfig> {
  return await api<GridLayoutConfig>(`/grid-layout/${encodeURIComponent(dimId)}`);
}

// debounce key per dimension so concurrent edits to different dims don't
// collide on a single timer
const layoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingLayouts = new Map<string, GridLayoutConfig>();

export function setGridLayout(dimId: string, partial: GridLayoutConfig): void {
  const merged = { ...(pendingLayouts.get(dimId) ?? {}), ...partial };
  pendingLayouts.set(dimId, merged);
  const t = layoutTimers.get(dimId); if (t) clearTimeout(t);
  layoutTimers.set(dimId, setTimeout(() => {
    const body = pendingLayouts.get(dimId) ?? {};
    pendingLayouts.delete(dimId);
    layoutTimers.delete(dimId);
    void api(`/grid-layout/${encodeURIComponent(dimId)}`, { method: "PATCH", body: JSON.stringify(body) });
  }, 400));
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add app/src/store.ts
git commit -m "feat(store): column rename/change-type/delete + grid layout (debounced)"
```

---

## Task 18: `ColumnHeaderMenu` component

**Files:**
- Create: `app/src/components/datagrid/ColumnHeaderMenu.tsx`

- [ ] **Step 1: Write the menu**

```tsx
import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import type { CellType, ColumnDef } from "./types";

interface Props<Row> {
  column: ColumnDef<Row>;
  sortDir: "asc" | "desc" | null;
  onClose: () => void;
  onRename: (newLabel: string) => void;
  onSort: (dir: "asc" | "desc" | null) => void;
  onChangeType: (newType: CellType) => void;
  onHide: () => void;
  onDelete: () => void;
}

const TYPES: CellType[] = ["text", "number", "boolean", "date", "select"];

export function ColumnHeaderMenu<Row>({ column, sortDir, onClose, onRename, onSort, onChangeType, onHide, onDelete }: Props<Row>) {
  const [mode, setMode] = useState<"menu" | "rename" | "type" | "confirm-delete">("menu");
  const [draft, setDraft] = useState(column.label);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const item = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[11.5px] text-ink hover:bg-hover";

  return (
    <div ref={ref} className="absolute right-0 top-full z-30 mt-1 w-48 rounded-sm border border-line-2 bg-surface p-1 shadow-lg">
      {mode === "menu" && (
        <>
          <button type="button" className={item} onClick={() => setMode("rename")}>✎ rename column</button>
          <button type="button" className={item} onClick={() => setMode("type")}>⇅ change type</button>
          <div className="my-1 h-px bg-line" />
          <button type="button" className={item} onClick={() => { onSort("asc"); onClose(); }}>↑ sort A→Z</button>
          <button type="button" className={item} onClick={() => { onSort("desc"); onClose(); }}>↓ sort Z→A</button>
          {sortDir != null && (
            <button type="button" className={item} onClick={() => { onSort(null); onClose(); }}>✕ clear sort</button>
          )}
          <div className="my-1 h-px bg-line" />
          <button type="button" className={item} onClick={() => { onHide(); onClose(); }}>⊘ hide column</button>
          <button type="button" className={cx(item, "text-danger")} onClick={() => setMode("confirm-delete")}>🗑 delete column</button>
        </>
      )}
      {mode === "rename" && (
        <div className="p-1">
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); onRename(draft.trim()); onClose(); }
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
            className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none"
          />
          <div className="mt-1.5 flex gap-1">
            <button type="button" className={cx(item, "justify-center bg-accent text-accent-ink hover:bg-accent")} onClick={() => { onRename(draft.trim()); onClose(); }}>save</button>
            <button type="button" className={item + " justify-center"} onClick={onClose}>cancel</button>
          </div>
        </div>
      )}
      {mode === "type" && (
        <div>
          {TYPES.map((t) => (
            <button key={t} type="button"
              className={cx(item, column.type === t && "bg-accent-wash text-accent")}
              onClick={() => { if (t !== column.type) onChangeType(t); onClose(); }}
            >
              {t}{column.type === t ? " · current" : ""}
            </button>
          ))}
          <div className="my-1 h-px bg-line" />
          <button type="button" className={item} onClick={() => setMode("menu")}>← back</button>
        </div>
      )}
      {mode === "confirm-delete" && (
        <div className="p-2 text-[11.5px] text-ink-2">
          <div className="font-mono">Delete <span className="text-ink">{column.label}</span>? This drops the column on every row.</div>
          <div className="mt-2 flex gap-1">
            <button type="button" className={cx(item, "justify-center bg-danger text-white")} onClick={() => { onDelete(); onClose(); }}>delete</button>
            <button type="button" className={item + " justify-center"} onClick={onClose}>cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Re-export from barrel**

In `app/src/components/datagrid/index.ts`, add:

```ts
export { ColumnHeaderMenu } from "./ColumnHeaderMenu";
```

- [ ] **Step 3: Typecheck + commit**

```bash
cd app && bun run typecheck
git add app/src/components/datagrid/ColumnHeaderMenu.tsx app/src/components/datagrid/index.ts
git commit -m "feat(datagrid): ColumnHeaderMenu (rename/type/sort/hide/delete)"
```

---

## Task 19: Wire header menu + sort into `DataGrid.tsx`

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx`

- [ ] **Step 1: Add sort state + sorted-rows computation**

Near the top of `DataGrid<Row>(props)`, after the `visible` filter, add:

```ts
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    const cmp = (a: Row, b: Row) => {
      const av = (a as any)[sort.field]; const bv = (b as any)[sort.field];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
      return String(av).localeCompare(String(bv)) * sign;
    };
    return [...rows].sort(cmp);
  }, [rows, sort]);
```

Then change every reference to `rows` inside the body render and `selection.onChange(rows.map(rowKey))` to use `sortedRows` instead — find and replace within this file.

- [ ] **Step 2: Render the header menu in the header row**

In `DataGrid.tsx`, replace the existing header column span:

```tsx
        {visible.map((c) => (
          <span key={c.field}
            className={cx("truncate", c.align === "right" && "text-right")}
            data-header={c.field}>{c.label}</span>
        ))}
```

with:

```tsx
        {visible.map((c) => {
          const sortGlyph = sort?.field === c.field ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
          return (
            <div key={c.field}
              className={cx("group relative flex items-center gap-1 truncate", c.align === "right" && "justify-end")}
              data-header={c.field}
            >
              <span className="truncate">{c.label}{sortGlyph}</span>
              {!c.pinnedLeft && (
                <button type="button" aria-label="Column menu"
                  className="ml-auto opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                  onClick={() => setMenuFor((s) => s === c.field ? null : c.field)}
                >⋯</button>
              )}
              {menuFor === c.field && (
                <ColumnHeaderMenu
                  column={c}
                  sortDir={sort?.field === c.field ? sort.dir : null}
                  onClose={() => setMenuFor(null)}
                  onRename={(label) => props.onRenameColumn?.(c.field, label)}
                  onSort={(dir) => setSort(dir ? { field: c.field, dir } : null)}
                  onChangeType={async (newType) => {
                    if (!props.onChangeColumnType) return;
                    const res = await props.onChangeColumnType(c.field, newType);
                    if (!res.ok && res.invalidCount) {
                      // simplest UX for v1: confirm coercion + retry with the flag set
                      if (confirm(`${res.invalidCount} value(s) won't parse as ${newType}. Coerce to empty?`)) {
                        await props.onChangeColumnType(c.field, newType, { coerceInvalidToNull: true });
                      }
                    }
                  }}
                  onHide={() => {
                    const hidden = [...visible.filter((v) => v.hidden).map((v) => v.field), c.field];
                    props.onLayoutChange?.({ hidden });
                  }}
                  onDelete={() => props.onDeleteColumn?.(c.field)}
                />
              )}
            </div>
          );
        })}
```

- [ ] **Step 3: Import the menu**

At the top of `DataGrid.tsx`, add:

```ts
import { useState } from "react";              // already imported via useMemo line; ensure both
import { ColumnHeaderMenu } from "./ColumnHeaderMenu";
```

- [ ] **Step 4: Typecheck + commit**

```bash
cd app && bun run typecheck
git add app/src/components/datagrid/DataGrid.tsx
git commit -m "feat(datagrid): header menu + in-memory sort glyph"
```

---

## Task 20: Column resize handler (right-edge grip)

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx`

- [ ] **Step 1: Track widths in component state + render grip**

In `DataGrid<Row>(props)`, near the top (alongside `sort`), add:

```ts
  // local widths override; reset when columns change identity
  const [widths, setWidths] = useState<Record<string, number>>(() => Object.fromEntries(
    visible.filter((c) => c.width).map((c) => [c.field, c.width!]),
  ));

  const colWidth = (field: string) => widths[field] ?? visible.find((c) => c.field === field)?.width;
```

Replace the existing `gridStyle` `useMemo` with:

```ts
  const gridStyle = useMemo(() => {
    const tracks = visible.map((c) => {
      const w = colWidth(c.field);
      return w ? `${w}px` : "minmax(96px, 1fr)";
    });
    if (selectionCol) tracks.unshift("28px");
    return { gridTemplateColumns: tracks.join(" ") };
  }, [visible, selectionCol, widths]);
```

- [ ] **Step 2: Add the grip + drag handler in the header**

Inside the per-column header render (from Task 19), just before the `</div>` that closes each header column, add:

```tsx
              {!c.pinnedLeft && (
                <span
                  aria-hidden
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize transition-colors group-hover:bg-line-2"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const headerEl = (e.currentTarget.parentElement as HTMLElement);
                    const startW = headerEl.getBoundingClientRect().width;
                    const onMove = (ev: PointerEvent) => {
                      const next = Math.max(60, Math.min(600, startW + (ev.clientX - startX)));
                      setWidths((w) => ({ ...w, [c.field]: next }));
                    };
                    const onUp = () => {
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                      // commit the final width via the host
                      setWidths((w) => {
                        props.onLayoutChange?.({ widths: w });
                        return w;
                      });
                    };
                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                  }}
                />
              )}
```

- [ ] **Step 3: Typecheck + commit**

```bash
cd app && bun run typecheck
git add app/src/components/datagrid/DataGrid.tsx
git commit -m "feat(datagrid): column resize via right-edge grip"
```

---

## Task 21: Column reorder (200ms hold + drag)

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx`

- [ ] **Step 1: Track order + drag state**

In `DataGrid<Row>(props)`, alongside `widths`, add:

```ts
  const [order, setOrder] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<{ field: string; overIndex: number | null } | null>(null);

  // resolved visible columns honor `order` if set; otherwise prop order
  const orderedVisible = useMemo(() => {
    if (!order) return visible;
    const byField = new Map(visible.map((c) => [c.field, c]));
    const out: typeof visible = [];
    for (const f of order) { const c = byField.get(f); if (c) out.push(c); }
    // append columns that aren't in `order` yet (newly added)
    for (const c of visible) if (!order.includes(c.field)) out.push(c);
    return out;
  }, [visible, order]);
```

Then everywhere in this file that iterates `visible`, change to `orderedVisible`. The `gridStyle` track count and the body row `<div>` rendering both follow.

- [ ] **Step 2: Wire the hold-then-drag handler**

In the per-column header render, wrap the header label in a draggable affordance. Replace the `<span className="truncate">{c.label}{sortGlyph}</span>` with:

```tsx
              <span className={cx("truncate cursor-grab select-none", c.pinnedLeft && "cursor-default")}
                onPointerDown={(e) => {
                  if (c.pinnedLeft) return;
                  const startX = e.clientX;
                  let holding = true;
                  const holdTimer = window.setTimeout(() => {
                    if (!holding) return;
                    setDrag({ field: c.field, overIndex: null });
                  }, 200);
                  const onMove = (ev: PointerEvent) => {
                    if (!drag) return;
                    // determine which header column we're over via element-at-point
                    const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
                    const headerEl = target?.closest<HTMLElement>("[data-header]");
                    const overField = headerEl?.dataset.header ?? null;
                    if (overField == null) return;
                    const next = orderedVisible.findIndex((x) => x.field === overField);
                    setDrag((d) => d ? { ...d, overIndex: next } : d);
                  };
                  const onUp = () => {
                    holding = false;
                    window.clearTimeout(holdTimer);
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    setDrag((d) => {
                      if (!d || d.overIndex == null) return null;
                      const from = orderedVisible.findIndex((x) => x.field === d.field);
                      if (from < 0 || from === d.overIndex) return null;
                      const next = [...orderedVisible.map((x) => x.field)];
                      next.splice(from, 1);
                      next.splice(d.overIndex, 0, d.field);
                      setOrder(next);
                      props.onLayoutChange?.({ order: next });
                      return null;
                    });
                  };
                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                }}
              >{c.label}{sortGlyph}</span>
```

The drop-zone visual (between adjacent columns) is left as a follow-up — for v1 we mark the over-column with an opacity tweak. Inside the per-column header `<div>`, add (just after the opening tag):

```tsx
              {drag?.field === c.field && <span className="absolute inset-0 bg-accent-wash" aria-hidden />}
              {drag?.overIndex != null && orderedVisible[drag.overIndex]?.field === c.field && (
                <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" aria-hidden />
              )}
```

- [ ] **Step 3: Typecheck + commit**

```bash
cd app && bun run typecheck
git add app/src/components/datagrid/DataGrid.tsx
git commit -m "feat(datagrid): column reorder (200ms hold + drag)"
```

---

## Task 22: Persist grid layout from MasterTables (load + write-through)

**Files:**
- Modify: `app/src/routes/MasterTables.tsx`

- [ ] **Step 1: Hydrate layout on dimension change**

Near the top of `MasterTables` (after `const dim = …` and `useEngineerMode`), add:

```ts
  const [layout, setLayout] = useState<{ widths?: Record<string, number>; order?: string[]; hidden?: string[] }>({});
  useEffect(() => {
    if (!dim) return;
    void getGridLayout(dim.id).then(setLayout);
  }, [dim?.id]);
```

And import:

```ts
import { useEffect } from "react";  // already imported
import { getGridLayout, setGridLayout } from "../store";
```

- [ ] **Step 2: Apply layout to columns**

In the `columns` memo from Task 12, after the column array is built, post-process it:

```ts
    return cols.map((c) => ({
      ...c,
      width: layout.widths?.[c.field] ?? c.width,
      hidden: layout.hidden?.includes(c.field) ?? false,
    })).sort((a, b) => {
      const ord = layout.order ?? [];
      const ai = ord.indexOf(a.field);
      const bi = ord.indexOf(b.field);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
```

And add `layout` to the `useMemo` deps.

- [ ] **Step 3: Wire `onLayoutChange` to the store**

In the `<DataGrid>` mount, add the prop:

```tsx
          onLayoutChange={(partial) => {
            setLayout((cur) => ({ ...cur, ...partial }));
            setGridLayout(dim.id, partial);
          }}
          onRenameColumn={(field, label) => void renameColumn(dim.id, field, label)}
          onChangeColumnType={(field, newType, opts) => changeColumnType(dim.id, field, newType, opts?.options, opts?.coerceInvalidToNull ?? false)}
          onDeleteColumn={(field) => void deleteColumn(dim.id, field)}
```

Import what you need:

```ts
import { renameColumn, changeColumnType, deleteColumn } from "../store";
```

- [ ] **Step 4: Typecheck + manual smoke**

```bash
cd app && bun run typecheck
cd app && bun run dev   # in one terminal
```

In a browser:
- Resize a column. Reload the page (within the same dim). Width persists.
- Reorder columns. Reload. Order persists.
- Hide a column from the menu. Reload. It's hidden.
- Rename a column via the menu. Refresh the dim. New label sticks.
- Change a text column to "select" type. The column now renders chips for distinct existing values.
- Delete a column. It vanishes from the grid and `dim_` (verify via psql or another verify run).

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/MasterTables.tsx
git commit -m "feat(master-tables): persist grid layout + wire header menu mutations"
```

---

## Task 23: `verify-datagrid.ts` — Phase 3 portion

**Files:**
- Modify: `server/src/verify-datagrid.ts`

- [ ] **Step 1: Add layout + column-mutation checks**

In `verify-datagrid.ts`, before the final cleanup call, add:

```ts
  // ---- Phase 3: grid layout + column rename / change-type / delete ----

  const USER = "u_ada";

  await step("setGridLayout writes config", async () => {
    await repo.setGridLayout(USER, dimId, { widths: { region: 120 }, order: ["region", "capital"], hidden: [] });
    const r = await repo.getGridLayout(USER, dimId);
    assert(r.widths?.region === 120, `widths.region: ${r.widths?.region}`);
    assert(JSON.stringify(r.order) === JSON.stringify(["region", "capital"]), `order: ${JSON.stringify(r.order)}`);
  });

  await step("renameColumn updates the label", async () => {
    await repo.renameColumn(dimId, "capital", "Capital city");
    const fields = await repo.listFields(dimId);
    const cap = fields.find((f) => f.field === "capital");
    assert(cap?.label === "Capital city", `label: ${cap?.label}`);
  });

  await step("changeColumnType text → select seeds options from distinct values", async () => {
    // first, add a couple of canonical rows and set capital values
    await repo.addCanonicalOne(dimId, "Denmark", "denmark");
    await repo.addCanonicalOne(dimId, "Germany", "germany");
    await repo.setFieldValue(dimId, "denmark", "capital", "Copenhagen");
    await repo.setFieldValue(dimId, "germany", "capital", "Berlin");
    const res = await repo.changeColumnType(dimId, "capital", "select");
    assert(res.ok, `changeColumnType failed: ${JSON.stringify(res)}`);
    const fields = await repo.listFields(dimId);
    const cap = fields.find((f) => f.field === "capital");
    assert(cap?.type === "select", `type after change: ${cap?.type}`);
    assert(cap?.options && cap.options.includes("Copenhagen") && cap.options.includes("Berlin"),
      `options after change: ${JSON.stringify(cap?.options)}`);
  });

  await step("deleteColumn drops dim_field + cell values", async () => {
    const r = await repo.deleteColumn(dimId, "capital");
    assert(r.ok, "deleteColumn ok");
    const fields = await repo.listFields(dimId);
    assert(!fields.some((f) => f.field === "capital"), `capital still present: ${JSON.stringify(fields)}`);
  });
```

(`addCanonicalOne` already exists in `repo.ts`; `setFieldValue` already exists too.)

- [ ] **Step 2: Run it**

```bash
cd server && bun run verify-datagrid
```

Expected: all steps pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/verify-datagrid.ts
git commit -m "test(server): verify-datagrid covers layout + column mutations"
```

---

## Phase 3 verification

- [ ] `cd app && bun run typecheck` — passes
- [ ] `cd server && bun run typecheck` — passes
- [ ] `cd server && bun run verify-datagrid` — passes
- [ ] Manual: resize, reorder, hide, rename, change-type, delete all work and persist across reload

---

# Phase 4 — Wire Mapping to shared primitives

Goal: Mapping adopts cursor + undo + chips + the picker. It keeps its workflow column shape (no header menu, no resize); the shared primitives ride underneath.

## Task 24: Mapping — focus cursor + grid-style keyboard wrapper

**Files:**
- Modify: `app/src/routes/Mapping.tsx`

- [ ] **Step 1: Introduce a cursor that operates on Mapping's visible rows**

Mapping has its own custom column shape so we don't mount `<DataGrid>` whole; we mount the `useGridCursor` hook only and reuse its keyboard handler.

In `Mapping.tsx`, after the `visible` computation (~line 83), add:

```ts
  const visibleRows = visible;            // alias for clarity
  const COLS_FOR_CURSOR: ColumnDef<MappingValue>[] = [
    { field: "value", label: "Source", type: "text", editable: false },
    { field: "target", label: "Master", type: "text", editable: true },
    { field: "status", label: "Status", type: "text", editable: false },
  ];
  const cursor = useGridCursor<MappingValue>({
    rows: visibleRows,
    rowKey: (r) => r.value,
    columns: COLS_FOR_CURSOR,
    onSelectAll: () => setSel(visIds),
    onUndo: () => void undo.undo(),
    onRedo: () => void undo.redo(),
    onShortcuts: () => setShortcuts(true),
    onFocusFilter: () => {/* filter chips already global */},
  });
```

Add imports at the top:

```ts
import { useGridCursor, useUndoStack } from "../components/datagrid";
import type { ColumnDef } from "../components/datagrid";
import type { MappingValue } from "../data";
```

Add the `setShortcuts` state alongside the existing `useState`s:

```ts
  const [shortcuts, setShortcuts] = useState(false);
```

And introduce the undo stack:

```ts
  const undo = useUndoStack();
```

- [ ] **Step 2: Mount the keyboard handler on the workbench root**

Find the outermost `<div className="space-y-6">` in the Mapping render (~line 121). Below it is `<div className="zz-rise rounded-lg border …`. That inner card is the workbench. Add a `tabIndex={0}`, `ref`, and `onKeyDown` to that workbench card:

```tsx
      <div className="zz-rise rounded-lg border border-line bg-surface outline-none focus:ring-1 focus:ring-accent/40"
        ref={cursor.ref}
        tabIndex={0}
        onKeyDown={(e) => {
          // grid bindings first
          cursor.onKeyDown(e);
          if (e.defaultPrevented) return;
          // Mapping-specific shortcuts (single-key, not editing)
          if (!cursor.cursor) return;
          const cur = cursor.cursor;
          if (cur.editing) return;
          if (e.key === "a" || e.key === "A") { e.preventDefault(); accept(cur.rowKey); return; }
          if (e.key === "s" || e.key === "S") { e.preventDefault(); skip(cur.rowKey); return; }
          if (e.key === "r" || e.key === "R") { e.preventDefault(); reset(cur.rowKey); return; }
          if (e.key === "m" || e.key === "M") { e.preventDefault(); cursor.startEdit(); return; }
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void approveAndCommit(); return; }
        }}
        style={{ animationDelay: "150ms" }}
      >
```

(Delete the old style attribute since it's now embedded above.)

- [ ] **Step 3: Show the focus ring on the focused row + selected target cell**

In the body row map (~line 195), each row's outer `<div>` currently has `className={cx(COLS, "border-b border-line px-4 py-2.5 transition-colors", …)}`. Add focus styling:

```tsx
          const focused = cursor.cursor?.rowKey === r.value;
          // …
          <div className={cx(
            COLS, "border-b border-line px-4 py-2.5 transition-colors",
            checked ? "bg-accent-wash" : "hover:bg-hover",
            isOpen && "border-b-0",
            focused && "ring-1 ring-accent/60 bg-accent-wash/40",
          )} data-row={r.value} onClick={() => cursor.setCursor({ rowKey: r.value, field: "target", editing: false })}>
```

- [ ] **Step 4: Typecheck**

```bash
cd app && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/Mapping.tsx
git commit -m "feat(mapping): grid cursor + A/M/S/R/⌘↵ shortcuts"
```

---

## Task 25: Mapping — undo for accept / skip / reset / pick

**Files:**
- Modify: `app/src/routes/Mapping.tsx`

- [ ] **Step 1: Wrap mutating helpers in undo pushes**

In `Mapping.tsx`, replace the existing `accept`, `pick`, `skip`, and `reset` helpers (~line 71-75) with:

```ts
  const stageMap = (v: string, label: string) => {
    const prev = allDrafts[dkey(seed.id, v)];
    undo.push({
      label: `match "${v}" → ${label}`,
      apply: () => saveDraft(seed.id, v, "mapped", label, keyFor(label)),
      inverse: () => prev ? saveDraft(seed.id, v, prev.status, prev.targetLabel, prev.targetKey) : discardDraft(seed.id, v),
    });
    return saveDraft(seed.id, v, "mapped", label, keyFor(label));
  };
  const accept = (v: string) => { const r = byVal(v); if (r.suggestion) void stageMap(v, r.suggestion); };
  const pick = (v: string, t: string) => stageMap(v, t);
  const skip = (v: string) => {
    const prev = allDrafts[dkey(seed.id, v)];
    undo.push({
      label: `skip "${v}"`,
      apply: () => saveDraft(seed.id, v, "skipped", null, null),
      inverse: () => prev ? saveDraft(seed.id, v, prev.status, prev.targetLabel, prev.targetKey) : discardDraft(seed.id, v),
    });
    return saveDraft(seed.id, v, "skipped", null, null);
  };
  const reset = (v: string) => {
    const prev = allDrafts[dkey(seed.id, v)];
    if (!prev) return;
    undo.push({
      label: `reset "${v}"`,
      apply: () => discardDraft(seed.id, v),
      inverse: () => saveDraft(seed.id, v, prev.status, prev.targetLabel, prev.targetKey),
    });
    return discardDraft(seed.id, v);
  };
```

`saveDraft` and `discardDraft` already return Promises (per `app/src/store.ts`).

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

- [ ] **Step 3: Manual smoke**

In the dev server, on `/match-values`:
- Focus a row, press `A` to accept the suggestion → status flips to Mapped.
- `⌘Z` → row reverts to New.
- `⌘⇧Z` → re-applies the accept.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/Mapping.tsx
git commit -m "feat(mapping): undo for accept/skip/reset"
```

---

## Task 26: Mapping — status chip via shared `<Chip>` primitive

**Files:**
- Modify: `app/src/routes/Mapping.tsx`

- [ ] **Step 1: Replace status `Badge` with `<Chip>` (semantic buckets)**

Find the status cell in the row render (currently uses `Badge` with `tone="ok"` / `tone="warn"` / default):

```tsx
                <div>{row.status === "mapped" ? <Badge tone="ok" dot>Mapped</Badge> : row.status === "skipped" ? <Badge>Skipped</Badge> : <Badge tone="warn" dot>New</Badge>}</div>
```

Replace with:

```tsx
                <div>{row.status === "mapped"
                  ? <Chip label="Mapped" bucket="chip-1" dot />
                  : row.status === "skipped"
                    ? <Chip label="Skipped" bucket="chip-5" />
                    : <Chip label="New" bucket="chip-2" dot />}</div>
```

Add the import:

```ts
import { Chip } from "../components/datagrid";
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd app && bun run typecheck
git add app/src/routes/Mapping.tsx
git commit -m "feat(mapping): status chips via shared Chip primitive (semantic buckets)"
```

---

## Task 27: Mapping — remove per-row icon buttons (selection-bar only)

**Files:**
- Modify: `app/src/routes/Mapping.tsx`

- [ ] **Step 1: Delete the per-row action `<div>`**

Find the last cell in each Mapping row (the trailing `<div className="flex items-center justify-end gap-1.5">…</div>` containing the accept ✓ + skip ✕ / reset buttons, around lines 219-228). Delete the whole `<div>`.

Update the column-grid template (`COLS` at line 26) to drop the trailing 64px track. Replace:

```ts
const COLS = "grid grid-cols-[28px_minmax(160px,1.3fr)_22px_minmax(160px,1.1fr)_88px_84px_64px] items-center gap-3";
```

with:

```ts
const COLS = "grid grid-cols-[28px_minmax(160px,1.3fr)_22px_minmax(160px,1.1fr)_88px_84px] items-center gap-3";
```

Also drop the trailing empty header span in the column-header row (~line 188):

```tsx
        <div className={cx(COLS, "border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3")}>
          <span /><span>Source value · where it's seen</span><span /><span>Master {seed.dimension.toLowerCase()}</span><span>Confidence</span><span>Status</span>
        </div>
```

(Removed the last `<span />`.)

- [ ] **Step 2: Manual smoke**

Dev server. On `/match-values`:
- Per-row ✓/✕ are gone.
- Bulk bar still works when you select rows.
- Keyboard (`A`/`S`/`R`/`M`) still works.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/Mapping.tsx
git commit -m "feat(mapping): drop per-row action icons (selection-bar only)"
```

---

# Phase 5 — Shortcuts overlay + inline shortcut text + focused-row hint

Goal: the canonical shortcut help is a `?`-triggered modal; the two highest-frequency buttons (Publish, Undo) carry their shortcut inline; Mapping shows a one-line hint under the focused row.

## Task 28: `ShortcutsOverlay` component

**Files:**
- Create: `app/src/components/datagrid/ShortcutsOverlay.tsx`
- Modify: `app/src/components/datagrid/index.ts`

- [ ] **Step 1: Write the overlay**

```tsx
import { useEffect } from "react";
import { cx } from "../../lib/cx";

/* ShortcutsOverlay — '?' opens this modal. Grouped by surface so users learn
   the keys for the page they're on without scanning irrelevant bindings. */

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Grid",
    rows: [
      ["↑ ↓ ← →", "move cursor"],
      ["Enter", "edit / commit"],
      ["Tab / Shift+Tab", "commit + move →/←"],
      ["Esc", "cancel edit"],
      ["Space", "toggle row selection"],
      ["⌘A", "select all visible"],
      ["⌘⌫", "remove selected"],
      ["/", "focus filter"],
    ],
  },
  {
    title: "Mapping",
    rows: [
      ["A", "accept suggestion"],
      ["M", "pick master"],
      ["S", "skip"],
      ["R", "reset draft"],
      ["⌘↵", "publish staged drafts"],
    ],
  },
  {
    title: "Global",
    rows: [
      ["⌘Z", "undo"],
      ["⌘⇧Z", "redo"],
      ["?", "this overlay"],
    ],
  },
];

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-6" onClick={onClose}>
      <div className="w-[560px] max-w-full rounded-lg border border-line-2 bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[18px] font-semibold text-ink">Keyboard shortcuts</h2>
          <button type="button" className="font-mono text-[11px] text-ink-3 hover:text-ink" onClick={onClose}>esc</button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{g.title}</div>
              <ul className="mt-1.5 space-y-1.5">
                {g.rows.map(([k, v]) => (
                  <li key={k} className="flex items-center justify-between gap-2 text-[11.5px] text-ink-2">
                    <span><Kbd>{k}</Kbd></span>
                    <span className="text-right">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span className={cx(
    "inline-block rounded border-[1px] border-b-2 border-line-2 bg-surface-2 px-1.5 py-0.5",
    "font-mono text-[10.5px] text-ink",
  )}>{children}</span>;
}
```

- [ ] **Step 2: Re-export from barrel**

In `app/src/components/datagrid/index.ts`, add:

```ts
export { ShortcutsOverlay } from "./ShortcutsOverlay";
```

- [ ] **Step 3: Typecheck + commit**

```bash
cd app && bun run typecheck
git add app/src/components/datagrid/ShortcutsOverlay.tsx app/src/components/datagrid/index.ts
git commit -m "feat(datagrid): ShortcutsOverlay (?-triggered modal)"
```

---

## Task 29: Global `?` mount + inline shortcuts on Publish / Undo

**Files:**
- Modify: `app/src/main.tsx` (mount the overlay) OR `app/src/components/AppShell.tsx` (better if it owns the shell)
- Modify: `app/src/routes/Mapping.tsx` — inline shortcut text on Publish + Undo button
- Modify: `app/src/routes/MasterTables.tsx` — undo button + shortcut text

- [ ] **Step 1: Mount the overlay globally**

Find where the app shell renders (likely `app/src/components/AppShell.tsx` — check with `grep -n "AppShell\|Outlet" app/src/`). Inside the shell, add:

```tsx
import { ShortcutsOverlay } from "./datagrid";
// state in the shell:
const [shortcutsOpen, setShortcutsOpen] = useState(false);

useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "?" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      setShortcutsOpen(true);
    }
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}, []);

// in JSX, near the root:
<ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
```

(If `AppShell` is functional and already imports `useState`/`useEffect`, just merge the lines in.)

- [ ] **Step 2: Inline shortcut on Mapping Publish + Undo buttons**

In `app/src/routes/Mapping.tsx`, find the footer Publish button (~line 293-295):

```tsx
              <Button size="sm" disabled={staged.length === 0} onClick={approveAndCommit}>
                {engineer ? `Approve & commit ${staged.length}` : `Publish ${staged.length} change${staged.length === 1 ? "" : "s"}`}
              </Button>
```

Append the shortcut text:

```tsx
              <Button size="sm" disabled={staged.length === 0} onClick={approveAndCommit}>
                {engineer ? `Approve & commit ${staged.length}` : `Publish ${staged.length} change${staged.length === 1 ? "" : "s"}`}
                <span className="ml-2 font-mono text-[10px] opacity-60">⌘↵</span>
              </Button>
```

Add an Undo button to the Mapping footer if missing (alongside Review / Publish):

```tsx
              <Button variant="ghost" size="sm" disabled={!undo.canUndo} onClick={() => void undo.undo()}>
                ↶ Undo<span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
              </Button>
```

(Insert it just before the existing `<Button variant="ghost" size="sm" disabled={staged.length === 0} onClick={() => setReview((s) => !s)}>{review ? "Hide review" : `Review ${staged.length}`}</Button>` line.)

- [ ] **Step 3: Inline shortcut on MasterTables Undo button**

In `app/src/routes/MasterTables.tsx`, add an Undo button in the toolbar (the existing `<AddColumn>` strip around line 180). Just before `<AddColumn onAdd={…} />`, add:

```tsx
          <Button variant="ghost" size="sm" disabled={!undo.canUndo} onClick={() => void undo.undo()}>
            ↶ Undo<span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
          </Button>
```

Add the hook at the top of `MasterTables`:

```ts
  const undo = useUndoStack();
```

Import `useUndoStack` from `"../components/datagrid"` (and `Button` is already imported).

- [ ] **Step 4: Wrap MasterTables mutations in undo pushes**

After Task 12 removed the per-row ✎ button, the `rename` helper is dead code — the label rename now flows through DataGrid's `onCommit` callback. Two updates here: wrap the helpers that are still mounted (`add`, `merge`, `retire`) AND wrap the `onCommit` callback so cell edits and label renames are also undoable.

Replace the existing `add`, `rename`, `merge`, `retire` helpers (lines 117-130) with undo-pushed versions:

```ts
  const add = async () => {
    const label = draft.trim(); if (!label || busy) return;
    setBusy(true);
    await addCanonical(activeId, label);
    undo.push({
      label: `add "${label}"`,
      apply: () => addCanonical(activeId, label),
      inverse: async () => { await retireCanonical(activeId, slug(label)); },
    });
    setBusy(false); setDraft("");
  };

  const rename = async (key: string, next: string) => {
    setEditing(null);
    const label = next.trim(); if (!label) return;
    const prev = list.find((c) => c.key === key)?.label;
    if (!prev || prev === label) return;
    setBusy(true);
    await renameCanonical(activeId, key, label);
    undo.push({
      label: `rename "${prev}" → "${label}"`,
      apply: () => renameCanonical(activeId, key, label),
      inverse: () => renameCanonical(activeId, key, prev),
    });
    setBusy(false);
  };

  const merge = async (survivorLabel: string) => {
    const survivor = list.find((c) => c.label === survivorLabel)?.key;
    if (!survivor) return;
    const losers = sel.filter((k) => k !== survivor);
    if (!losers.length) return;
    // snapshot loser records and their variant pointings BEFORE the merge
    const snapshot = list.filter((c) => losers.includes(c.key))
      .map((c) => ({ key: c.key, label: c.label, fields: c.fields }));
    const variantsSnapshot: { key: string; raws: string[] }[] = [];
    for (const k of losers) variantsSnapshot.push({ key: k, raws: await fetchVariants(activeId, k) });

    setBusy(true);
    const n = await mergeCanonical(activeId, survivor, losers);
    undo.push({
      label: `merge ${losers.length} into "${survivorLabel}"`,
      apply: () => mergeCanonical(activeId, survivor, losers).then(() => undefined),
      inverse: async () => {
        // re-insert losers; their variants will re-point during the per-raw rewrite via the
        // existing renameCanonical-style path. Simplest: re-add the canonical rows; the user
        // can re-run the merge if needed. (Variants stay pointing at the survivor — a full
        // restoration is deferred; document this limitation.)
        for (const s of snapshot) await addCanonical(activeId, s.label);
      },
    });
    setBusy(false);
    setSel([]); flash(`Merged ${n} record${n === 1 ? "" : "s"} into ${survivorLabel} — raw values re-pointed.`);
  };

  const retire = async (key: string, label: string) => {
    setBusy(true);
    const r = await retireCanonical(activeId, key);
    setBusy(false);
    if (!r.ok) { flash(`Can't remove "${label}" — ${r.variants} raw value${r.variants === 1 ? "" : "s"} still map here. Merge or remap them first.`); return; }
    undo.push({
      label: `remove "${label}"`,
      apply: () => retireCanonical(activeId, key).then(() => undefined),
      inverse: () => addCanonical(activeId, label),
    });
  };
```

Note the merge inverse is imperfect (variants stay pointing at the survivor). This is the deliberate v1 limitation flagged in the spec under "Open questions" — undo of a merge restores the loser records but not their original variant pointings; full restoration ships in v1.1.

Now wrap `onCommit` in the DataGrid mount so cell edits / label renames are undoable. Replace the existing `onCommit` block from Task 12 with:

```tsx
          onCommit={async (rowKey, field, value) => {
            if (field === "label") {
              const prev = list.find((c) => c.key === rowKey)?.label;
              if (typeof value !== "string" || !value.trim() || value === prev) return;
              await renameCanonical(activeId, rowKey, value);
              if (prev) undo.push({
                label: `rename "${prev}" → "${value}"`,
                apply: () => renameCanonical(activeId, rowKey, value),
                inverse: () => renameCanonical(activeId, rowKey, prev),
              });
              return;
            }
            // attribute field
            const v = value == null ? null : String(value);
            const prev = list.find((c) => c.key === rowKey)?.fields?.[field] ?? null;
            await setFieldValue(activeId, rowKey, field, v);
            if (prev !== v) undo.push({
              label: `edit ${field} on "${rowKey}"`,
              apply: () => setFieldValue(activeId, rowKey, field, v),
              inverse: () => setFieldValue(activeId, rowKey, field, prev),
            });
          }}
```

- [ ] **Step 5: Add a `scopeKey` to the UndoStackProvider so the stack clears on dimension switch**

In `app/src/main.tsx`, change the provider mount to NOT have a scope key — instead, do it inside MasterTables and Mapping by remounting the provider scope. Simpler: leave the provider global but call `undo` cleanup via a `useEffect` keyed on `dim.id` in each route. Add this near the top of `MasterTables` and the inner `MappingInner`:

```ts
  // when the dimension changes, the stack is effectively meaningless — flush it
  useEffect(() => { /* simply not pushing anything triggers no problem;
                      undo entries from a different dim will silently no-op on
                      inverse because the row keys won't match. Acceptable for v1. */ }, [dim?.id]);
```

(No actual code needed — the comment explains why we accept the "stale stack" behavior. The provider could be made `scopeKey={dim?.id}` for stricter behavior; defer.)

- [ ] **Step 6: Typecheck + manual smoke**

```bash
cd app && bun run typecheck
```

In the dev server:
- Press `?` anywhere — overlay opens; `Esc` closes it.
- On `/master-lists`, edit a cell, press `⌘Z` — value reverts. Undo button is enabled; click it instead — same effect.
- On `/match-values`, press `A` to accept, `⌘Z` to revert — works.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/AppShell.tsx app/src/routes/Mapping.tsx app/src/routes/MasterTables.tsx app/src/main.tsx
git commit -m "feat(shortcuts): ? overlay + inline ⌘↵/⌘Z on Publish/Undo + undo on MasterTables"
```

---

## Task 30: Mapping focused-row hint strip

**Files:**
- Modify: `app/src/routes/Mapping.tsx`

- [ ] **Step 1: Insert a hint strip under the focused row**

Find the per-row render in `Mapping.tsx` (~line 195-264). At the bottom of the row's `<Fragment key={r.value}>`, after the expandable provenance block and BEFORE the closing `</Fragment>`, add:

```tsx
              {focused && !isOpen && (
                <div className="border-b border-line bg-surface-2/40 px-4 py-1.5 pl-[52px] font-mono text-[10.5px] text-ink-3">
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">A</kbd> accept</span>
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">M</kbd> master</span>
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">S</kbd> skip</span>
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">R</kbd> reset</span>
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">?</kbd> all shortcuts</span>
                </div>
              )}
```

- [ ] **Step 2: Typecheck + manual smoke**

```bash
cd app && bun run typecheck
```

Dev server:
- Focus a Mapping row — the strip appears under it.
- Move focus to a different row — strip moves.
- Expand the row's provenance drawer — strip is hidden (since `isOpen`).

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/Mapping.tsx
git commit -m "feat(mapping): focused-row shortcut hint strip"
```

---

## Phase 5 verification

- [ ] `cd app && bun run typecheck` — passes
- [ ] Manual: `?` opens overlay; Publish shows `⌘↵`; Undo shows `⌘Z`; Mapping shows the focused-row hint

---

# Final cross-cutting verification

Run the full suite before declaring done:

- [ ] `cd app && bun run typecheck` — passes
- [ ] `cd server && bun run typecheck` — passes
- [ ] `cd server && bun run bootstrap` — schema is current
- [ ] `cd server && bun run verify-datagrid` — passes
- [ ] `cd app && bun run build` — passes (tree-shaking and prod-build sanity)
- [ ] Full UI smoke against the dev server:
  - Create a dim, add a `select` column with two options, pick one on a row, type a new name into the picker and Create it, undo twice.
  - Resize a column, reload — width persists.
  - Reorder columns, reload — order persists.
  - Hide a column, reload — still hidden; toolbar shows `+1 hidden`. Show again.
  - Rename a column via header menu, reload — new label.
  - Change a text column to select — distinct values become options.
  - Delete a column — gone everywhere.
  - On Mapping: arrow keys + `A`/`M`/`S`/`R` work; `⌘Z` reverts; status chips render; `?` opens overlay; focused-row hint strip appears.

When all checks are green, push and open a PR.

---

# Notes for the implementer

- **`open` in MasterTables**: the existing variants-drawer state (`open`, `toggleOpen`, `variantsCache`) is wired against the per-row click in the existing implementation. After Task 12 the DataGrid swallows row clicks (they move the cursor), so the drawer toggle now lives on a `chevron` button rendered inside the label cell's `render` hook. Be careful to preserve `toggleOpen`'s async-load behavior (variants cache populates on first open).
- **`busy` state**: the MasterTables refactor preserves `busy` to keep mutations serial. Tasks above respect this via the `if (busy) return` early-returns.
- **`scopeKey` on `UndoStackProvider`**: not used in v1 — the stale-stack inverses silently no-op when row keys don't match. If this proves confusing in practice, add `<UndoStackProvider scopeKey={dim.id}>{children}</UndoStackProvider>` inside MasterTables and Mapping (one provider per route), and remove the global one. Cheap follow-up.
- **The MasterTables `AddColumn` widget**: it stays in the toolbar (the route still needs *some* way to create columns). Phase 3's header menu only handles existing columns. If the user wants the "+ column" affordance moved into the grid header (an empty trailing column with a `+` icon, Airtable-style), that's a Phase 6 follow-up.
- **Mapping target-master picker**: this plan keeps the existing `ComboSelect` for the target-master cell rather than swapping it for `SelectCell`, because `ComboSelect` already handles the "create new master" path against `addCanonical` (different mutation from `addColumnOption`). Swapping is feasible but a separate refactor.
