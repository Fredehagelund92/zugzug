# Sources Keyboard Cursor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `j/k` keyboard cursor to `/app/sources` that walks visible LedgerRows, with `Enter` toggling the drill, `N` jumping to the next column with unmapped values, `/` focusing search, and `Esc` clearing the cursor.

**Architecture:** A new `useSourcesCursor()` hook owns the cursor state (just a row key + helpers). `Sources.tsx` wires the hook to an `onKeyDown` handler on the existing ledger `<section>` and plumbs a `focusedRowKey` through `SchemaSection → LedgerRow`. `LedgerRow` paints the focused-row treatment (`ring-1 ring-accent/60 bg-accent-wash/40` — same as Match/Triage). `ShortcutsOverlay` gains a new `Sources` group. All work is in `app/`; no server changes.

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind v4 + react-router-dom v6. Vitest + Testing Library for the cursor hook's unit tests. Manual UI walkthrough for integration verification (no full-route mount test exists in this repo's harness; Step 5.5 of the workbench-paradigm plan established the pattern).

**Spec:** `docs/superpowers/specs/2026-06-05-sources-keyboard-cursor-design.md`. Read it before starting.

---

## Project conventions to follow

- **Commit style.** Conventional Commits. Use `feat(sources):` for the user-facing pieces, `refactor(sources):` for the LedgerRow prop plumbing, `docs(shortcuts):` for the overlay update.
- **Comments.** Default to none. Only call out non-obvious WHY (a hidden constraint, a workaround). Don't paste this plan into comments.
- **TypeScript.** No `any`. The hook is generic-free; types are concrete (`string` row keys, `Cursor | null`).
- **Tailwind.** Match-mode rows use `ring-1 ring-accent/60 bg-accent-wash/40` for focus — reuse exactly.
- **Tests.** Vitest + jsdom + the existing localStorage shim in `app/test/setup.ts`. The codebase test convention is unit tests for pure helpers; UI integration is covered manually.

## File structure

**New files:**
- `app/src/routes/use-sources-cursor.ts` — the `useSourcesCursor()` hook. Local to the Sources route. One responsibility: own the cursor + expose `setCursor`/`move`/`jumpToNextNeedsAttention`/`onKeyDown`.
- `app/test/use-sources-cursor.test.ts` — unit tests for the hook's pure logic.

**Modified files:**
- `app/src/routes/Sources.tsx` — mount the hook, wire `onKeyDown` to the ledger `<section>`, plumb `focusedRowKey` to `SchemaSection`, attach `searchInputRef` to the existing toolbar `<input>`.
- `app/src/components/sources/LedgerRow.tsx` — accept new `focused?: boolean` prop, paint the focus treatment when true.
- `app/src/components/datagrid/ShortcutsOverlay.tsx` — add the `Sources` group; bump grid layout to fit 5 groups.

---

## Task 1: `useSourcesCursor()` hook (red → green → commit)

**Files:**
- Create: `app/src/routes/use-sources-cursor.ts`
- Test: `app/test/use-sources-cursor.test.ts`

The hook owns the cursor as a row-key string. Inputs: `visibleKeys: readonly string[]` (current filter+sort order) and `rowsWithUnmapped: readonly string[]` (subset where `unmapped > 0`). The hook is a pure state machine plus an `onKeyDown` factory.

The signature:

```ts
export interface SourcesCursorHandle {
  cursor: string | null;
  setCursor: (key: string | null) => void;
  isFocused: (key: string) => boolean;
}

export function useSourcesCursor(opts: {
  visibleKeys: readonly string[];
  rowsWithUnmapped: readonly string[];
  toggleDrillAt: (key: string) => void;
  focusSearch: () => void;
}): SourcesCursorHandle & {
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}
```

Key semantics:
- `move(+1)` from `null` lands on `visibleKeys[0]`. From the last key, stays at the last key (no wrap).
- `move(-1)` from `null` lands on `visibleKeys[0]`. From the first key, stays.
- `jumpToNextNeedsAttention()` walks from `cursor`'s position in `rowsWithUnmapped` to the next entry; wraps around once. If `cursor` is null or not in `rowsWithUnmapped`, lands on the first entry.
- Auto-clears `cursor` to `null` when `visibleKeys` no longer contains it (staleness, mirrors Task 1.4 of workbench-paradigm).
- The keydown handler guards against `INPUT`/`TEXTAREA`/`contentEditable` targets (so typing in the search field doesn't fire row shortcuts).

- [ ] **Step 1: Write the failing test**

```ts
// app/test/use-sources-cursor.test.ts
import { describe, test, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSourcesCursor } from "../src/routes/use-sources-cursor";

const KEYS = ["a", "b", "c", "d"] as const;

function mount(visible: readonly string[] = KEYS, withUnmapped: readonly string[] = ["b", "d"]) {
  const toggleDrillAt = vi.fn();
  const focusSearch = vi.fn();
  const hook = renderHook((props: {
    visibleKeys: readonly string[];
    rowsWithUnmapped: readonly string[];
  }) =>
    useSourcesCursor({
      visibleKeys: props.visibleKeys,
      rowsWithUnmapped: props.rowsWithUnmapped,
      toggleDrillAt,
      focusSearch,
    }),
    { initialProps: { visibleKeys: visible, rowsWithUnmapped: withUnmapped } },
  );
  return { hook, toggleDrillAt, focusSearch };
}

function fireKey(api: ReturnType<typeof mount>["hook"]["result"]["current"], key: string) {
  const e = {
    key,
    target: { tagName: "DIV", isContentEditable: false } as unknown as EventTarget,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent<HTMLElement>;
  act(() => api.onKeyDown(e));
  return e;
}

describe("useSourcesCursor", () => {
  test("starts with cursor null", () => {
    const { hook } = mount();
    expect(hook.result.current.cursor).toBeNull();
  });

  test("j from null lands on first visible row", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "j");
    expect(hook.result.current.cursor).toBe("a");
  });

  test("ArrowDown is an alias for j", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "ArrowDown");
    expect(hook.result.current.cursor).toBe("a");
  });

  test("k from null lands on first visible row", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "k");
    expect(hook.result.current.cursor).toBe("a");
  });

  test("j advances within visibleKeys; stops at last", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "j");
    fireKey(hook.result.current, "j");
    expect(hook.result.current.cursor).toBe("b");
    fireKey(hook.result.current, "j");
    fireKey(hook.result.current, "j");
    expect(hook.result.current.cursor).toBe("d");
    fireKey(hook.result.current, "j"); // past end
    expect(hook.result.current.cursor).toBe("d");
  });

  test("k retreats within visibleKeys; stops at first", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("c"));
    fireKey(hook.result.current, "k");
    expect(hook.result.current.cursor).toBe("b");
    fireKey(hook.result.current, "k");
    fireKey(hook.result.current, "k"); // past start
    expect(hook.result.current.cursor).toBe("a");
  });

  test("Enter calls toggleDrillAt(cursor) when cursor is set", () => {
    const { hook, toggleDrillAt } = mount();
    act(() => hook.result.current.setCursor("c"));
    fireKey(hook.result.current, "Enter");
    expect(toggleDrillAt).toHaveBeenCalledWith("c");
  });

  test("Enter is a no-op when cursor is null", () => {
    const { hook, toggleDrillAt } = mount();
    fireKey(hook.result.current, "Enter");
    expect(toggleDrillAt).not.toHaveBeenCalled();
  });

  test("N from null lands on first rowsWithUnmapped entry", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "N");
    expect(hook.result.current.cursor).toBe("b");
  });

  test("N from a needs-attention row jumps to the next; wraps once", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("b"));
    fireKey(hook.result.current, "n");
    expect(hook.result.current.cursor).toBe("d");
    fireKey(hook.result.current, "n");
    expect(hook.result.current.cursor).toBe("b"); // wrap
  });

  test("N from a non-needs-attention row jumps to the next visible needs-attention", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("a"));
    fireKey(hook.result.current, "n");
    expect(hook.result.current.cursor).toBe("b");
  });

  test("/ calls focusSearch", () => {
    const { hook, focusSearch } = mount();
    fireKey(hook.result.current, "/");
    expect(focusSearch).toHaveBeenCalledOnce();
  });

  test("Escape clears cursor", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("b"));
    fireKey(hook.result.current, "Escape");
    expect(hook.result.current.cursor).toBeNull();
  });

  test("input-focus guard: keys are ignored when target is INPUT", () => {
    const { hook } = mount();
    const e = {
      key: "j",
      target: { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;
    act(() => hook.result.current.onKeyDown(e));
    expect(hook.result.current.cursor).toBeNull();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  test("input-focus guard: keys are ignored when target is contentEditable", () => {
    const { hook } = mount();
    const e = {
      key: "j",
      target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;
    act(() => hook.result.current.onKeyDown(e));
    expect(hook.result.current.cursor).toBeNull();
  });

  test("staleness: cursor clears when visibleKeys no longer contains it", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("c"));
    hook.rerender({ visibleKeys: ["a", "b"], rowsWithUnmapped: ["b"] });
    expect(hook.result.current.cursor).toBeNull();
  });

  test("isFocused reflects the cursor", () => {
    const { hook } = mount();
    expect(hook.result.current.isFocused("a")).toBe(false);
    act(() => hook.result.current.setCursor("a"));
    expect(hook.result.current.isFocused("a")).toBe(true);
    expect(hook.result.current.isFocused("b")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bun run test -- use-sources-cursor`
Expected: FAIL — module not found at `../src/routes/use-sources-cursor`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/routes/use-sources-cursor.ts
import { useCallback, useEffect, useState } from "react";

/* useSourcesCursor — owns the j/k cursor for the Sources ledger. Pure state
   machine + an onKeyDown factory; no DOM access. Auto-scroll-into-view is
   handled by the consumer (Sources.tsx) via a layout effect that watches
   `cursor` and queries the row element by data attribute. */

export interface SourcesCursorHandle {
  cursor: string | null;
  setCursor: (key: string | null) => void;
  isFocused: (key: string) => boolean;
}

interface Opts {
  visibleKeys: readonly string[];
  rowsWithUnmapped: readonly string[];
  toggleDrillAt: (key: string) => void;
  focusSearch: () => void;
}

export function useSourcesCursor(
  opts: Opts,
): SourcesCursorHandle & { onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void } {
  const { visibleKeys, rowsWithUnmapped, toggleDrillAt, focusSearch } = opts;
  const [cursor, setCursor] = useState<string | null>(null);

  // Staleness: when the visible row set changes and the cursor's key is no
  // longer in it, clear cursor. Same invariant as Task 1.4 of workbench-paradigm.
  useEffect(() => {
    if (cursor && !visibleKeys.includes(cursor)) setCursor(null);
  }, [visibleKeys, cursor]);

  const move = useCallback(
    (delta: 1 | -1) => {
      if (visibleKeys.length === 0) return;
      setCursor((cur) => {
        if (cur === null) return visibleKeys[0];
        const i = visibleKeys.indexOf(cur);
        if (i === -1) return visibleKeys[0];
        const next = Math.max(0, Math.min(visibleKeys.length - 1, i + delta));
        return visibleKeys[next];
      });
    },
    [visibleKeys],
  );

  const jumpToNextNeedsAttention = useCallback(() => {
    if (rowsWithUnmapped.length === 0) return;
    setCursor((cur) => {
      if (cur === null) return rowsWithUnmapped[0];
      const i = rowsWithUnmapped.indexOf(cur);
      if (i === -1) return rowsWithUnmapped[0];
      // wrap-once: advance, modulo length
      return rowsWithUnmapped[(i + 1) % rowsWithUnmapped.length];
    });
  }, [rowsWithUnmapped]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
        return;
      }
      if (e.key === "Enter") {
        if (cursor === null) return;
        e.preventDefault();
        toggleDrillAt(cursor);
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        jumpToNextNeedsAttention();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCursor(null);
        return;
      }
    },
    [cursor, move, jumpToNextNeedsAttention, toggleDrillAt, focusSearch],
  );

  const isFocused = useCallback((key: string) => cursor === key, [cursor]);

  return { cursor, setCursor, isFocused, onKeyDown };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && bun run test -- use-sources-cursor`
Expected: PASS (15 tests).

- [ ] **Step 5: Confirm full suite + typecheck still clean**

Run: `cd app && bun run typecheck && bun run test`
Expected: typecheck exit 0; all tests green (24 prior + 15 new = 39).

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/use-sources-cursor.ts app/test/use-sources-cursor.test.ts
git commit -m "feat(sources): useSourcesCursor hook — j/k state machine + onKeyDown"
```

---

## Task 2: `LedgerRow` focused prop

**Files:**
- Modify: `app/src/components/sources/LedgerRow.tsx`

Add the `focused?: boolean` prop. When true, the outer `<div>` paints the same focus treatment Match-mode rows use (`ring-1 ring-accent/60 bg-accent-wash/40`). When BOTH focused and expanded, expanded's bg wins so the drill stays visually grouped — but the ring stays so the row reads as "focused while expanded."

- [ ] **Step 1: Extend the props interface**

```ts
// app/src/components/sources/LedgerRow.tsx — replace the LedgerRowProps interface
interface LedgerRowProps {
  row: SourceInfo;
  expanded: boolean;
  onToggle: () => void;
  onScheduleChange: (next: string | null) => void;
  onDerive: () => void;
  /** Drop the coverage-encoded standing bar at the bottom edge. The bar earns
   *  its place in the full Sources ledger (long, dense list, the % readout is
   *  load-bearing) but turns to chartjunk in a per-table panel of 1–3 rows. */
  hideStandingBar?: boolean;
  /** Keyboard cursor is on this row — paint the focus ring + accent wash. */
  focused?: boolean;
}
```

- [ ] **Step 2: Destructure the new prop**

```ts
// app/src/components/sources/LedgerRow.tsx — extend the destructure list
export function LedgerRow({
  row,
  expanded,
  onToggle,
  onScheduleChange,
  onDerive,
  hideStandingBar,
  focused,
}: LedgerRowProps) {
```

- [ ] **Step 3: Update the outer div's class**

Replace the outer `<div>` className block (currently `cx("relative bg-surface transition-colors", hideStandingBar && "border-b border-line", expanded ? "bg-surface-2/40" : "hover:bg-surface-2")`) with:

```tsx
    <div
      className={cx(
        "relative bg-surface transition-colors",
        hideStandingBar && "border-b border-line",
        // Focus ring stays whether or not the row is expanded; bg precedence is
        // expanded > focused > default-hover so a focused+expanded row reads
        // as "drill is open" while still showing keyboard focus.
        focused && "ring-1 ring-accent/60",
        expanded
          ? "bg-surface-2/40"
          : focused
            ? "bg-accent-wash/40"
            : "hover:bg-surface-2",
      )}
    >
```

- [ ] **Step 4: Typecheck + tests**

Run: `cd app && bun run typecheck && bun run test`
Expected: typecheck exit 0; all 39 tests still pass. (`focused` is optional, so existing call sites continue to compile unchanged.)

- [ ] **Step 5: Commit**

```bash
git add app/src/components/sources/LedgerRow.tsx
git commit -m "feat(sources): LedgerRow focused prop — accent ring + wash on keyboard focus"
```

---

## Task 3: `SchemaSection` plumbs `focusedRowKey` through

**Files:**
- Modify: `app/src/routes/Sources.tsx` (the `SchemaSection` function definition + its call site)

`SchemaSection` lives inline in `Sources.tsx` (around line 547). It owns the `<LedgerRow>` rendering loop. Add `focusedRowKey?: string | null` to its props and forward `focused={focusedRowKey === key}` to each `<LedgerRow>`.

- [ ] **Step 1: Extend SchemaSection's props**

```tsx
// app/src/routes/Sources.tsx — replace the inline type for SchemaSection's props
function SchemaSection({
  group,
  open,
  onToggle,
  expanded,
  setExpanded,
  onScheduleChange,
  onDerive,
  focusedRowKey,
}: {
  group: SchemaGroup;
  open: boolean;
  onToggle: () => void;
  expanded: string | null;
  setExpanded: (next: string | null) => void;
  onScheduleChange: (r: SourceInfo, next: string | null) => void;
  onDerive: (r: SourceInfo) => void;
  focusedRowKey?: string | null;
}) {
```

- [ ] **Step 2: Forward `focused` to each LedgerRow**

Inside the rows loop (around line 605), pass `focused={focusedRowKey === key}`:

```tsx
              <LedgerRow
                key={key}
                row={r}
                expanded={expanded === key}
                focused={focusedRowKey === key}
                onToggle={() => setExpanded(expanded === key ? null : key)}
                onScheduleChange={(next) => onScheduleChange(r, next)}
                onDerive={() => onDerive(r)}
              />
```

- [ ] **Step 3: Add a placeholder pass at the call site**

`Sources()` calls `<SchemaSection … />` around line 480. Task 4 will wire `focusedRowKey` to the cursor hook; for now pass `focusedRowKey={null}` so the typecheck stays clean:

```tsx
            <SchemaSection
              key={g.schema}
              group={g}
              open={effectiveOpen.has(g.schema)}
              onToggle={() => toggleSchema(g.schema)}
              expanded={expanded}
              setExpanded={setExpanded}
              focusedRowKey={null}
              onScheduleChange={(r, next) => {
                void setSourceSchedule(r.dimId, r.table, r.column, next);
              }}
              onDerive={derive}
            />
```

- [ ] **Step 4: Typecheck + tests**

Run: `cd app && bun run typecheck && bun run test`
Expected: typecheck exit 0; 39 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/Sources.tsx
git commit -m "refactor(sources): SchemaSection plumbs focusedRowKey through to LedgerRow"
```

---

## Task 4: Wire `useSourcesCursor` in `Sources()`

**Files:**
- Modify: `app/src/routes/Sources.tsx`

Mount the hook in `Sources()`. Compute `visibleKeys` and `rowsWithUnmapped` from the existing `visibleGroups`. Attach the keydown handler to the existing ledger `<section>`. Attach a ref to the existing search `<input>`. Replace the `focusedRowKey={null}` placeholder from Task 3 with the cursor's value. Add a `useLayoutEffect` for scroll-into-view.

- [ ] **Step 1: Add imports**

Add to the top of `app/src/routes/Sources.tsx`:

```tsx
import { useLayoutEffect, useRef } from "react"; // extend the existing react import
import { useSourcesCursor } from "./use-sources-cursor";
```

If the existing react import is `import { useEffect, useMemo, useState } from "react";`, replace with:

```tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
```

- [ ] **Step 2: Add `searchInputRef` and attach to the toolbar `<input>`**

In `Sources()` (around line 60), add:

```tsx
const searchInputRef = useRef<HTMLInputElement>(null);
```

In the toolbar `<input>` (around line 424), add `ref={searchInputRef}`:

```tsx
            <input
              ref={searchInputRef}
              value={q}
              onChange={(e) => {
```

(Leave all other input props unchanged.)

- [ ] **Step 3: Derive `visibleKeys` and `rowsWithUnmapped` from `visibleGroups`**

Add this after the existing `visibleGroups` declaration (around line 226 — find the line `const visibleGroups = useMemo<SchemaGroup[]>(...)`):

```tsx
// Flatten visible expanded-schema rows into an ordered key list for the cursor.
// A row that lives inside a collapsed schema is unreachable via j/k; collapsing
// a schema while the cursor is on one of its rows triggers staleness in the hook.
const visibleKeys = useMemo<string[]>(() => {
  const out: string[] = [];
  for (const g of visibleGroups) {
    if (!effectiveOpen.has(g.schema)) continue;
    for (const r of g.columns) out.push(`${r.dimId}::${r.table}::${r.column}`);
  }
  return out;
}, [visibleGroups, effectiveOpen]);

const rowsWithUnmapped = useMemo<string[]>(
  () => visibleKeys.filter((k) => {
    // O(N·M) lookup is fine — visible row counts are bounded by PAGE (=60).
    for (const g of visibleGroups) {
      for (const r of g.columns) {
        if (`${r.dimId}::${r.table}::${r.column}` === k) return r.unmapped > 0;
      }
    }
    return false;
  }),
  [visibleKeys, visibleGroups],
);
```

- [ ] **Step 4: Mount the hook**

Add right after the derivations above:

```tsx
const cursor = useSourcesCursor({
  visibleKeys,
  rowsWithUnmapped,
  toggleDrillAt: (key) => setExpanded(expanded === key ? null : key),
  focusSearch: () => searchInputRef.current?.focus(),
});
```

- [ ] **Step 5: Wire the keydown handler + tabIndex on the ledger `<section>`**

Around line 366, the `<section>` declaration is currently:

```tsx
      <section
        className="zz-rise relative flex min-h-0 flex-1 flex-col overflow-hidden border border-line bg-surface shadow-pop"
        style={{ animationDelay: "60ms" }}
      >
```

Replace with:

```tsx
      <section
        tabIndex={0}
        onKeyDown={cursor.onKeyDown}
        className="zz-rise relative flex min-h-0 flex-1 flex-col overflow-hidden border border-line bg-surface shadow-pop outline-none focus:ring-1 focus:ring-accent/30"
        style={{ animationDelay: "60ms" }}
      >
```

The `outline-none focus:ring-1 focus:ring-accent/30` matches the existing pattern Match/Triage use on their tabIndex containers — gives the section a subtle focus ring so the user sees the keyboard-target boundary when they Tab into it.

- [ ] **Step 6: Replace the placeholder `focusedRowKey={null}`**

Find the `<SchemaSection … focusedRowKey={null} />` call from Task 3 and change to:

```tsx
              focusedRowKey={cursor.cursor}
```

- [ ] **Step 7: Auto-scroll the focused row into view**

Add a `useLayoutEffect` near the other effects (find the `useEffect` blocks around line 247-275; add this after them):

```tsx
// Bring the focused row into view as the cursor moves. The ledger surface
// (the parent <section>) is the scroll context, so scrollIntoView with
// block:"nearest" keeps the sticky toolbar pinned at the top.
useLayoutEffect(() => {
  const key = cursor.cursor;
  if (!key) return;
  const el = document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
  el?.scrollIntoView({ block: "nearest", inline: "nearest" });
}, [cursor.cursor]);
```

This requires LedgerRow's outer `<div>` to carry a `data-row-key={...}` attribute — Task 5 adds it.

- [ ] **Step 8: Typecheck + tests**

Run: `cd app && bun run typecheck && bun run test`
Expected: typecheck exit 0; 39 tests pass.

- [ ] **Step 9: Commit**

```bash
git add app/src/routes/Sources.tsx
git commit -m "feat(sources): mount useSourcesCursor; wire keydown + search ref + scroll-into-view"
```

---

## Task 5: LedgerRow `data-row-key` for scroll-into-view

**Files:**
- Modify: `app/src/components/sources/LedgerRow.tsx`

The `useLayoutEffect` in Task 4.7 looks up the focused row's DOM node by `[data-row-key="…"]`. LedgerRow doesn't currently emit that attribute; add it. The same key shape is already used by Triage (`${dimId}::${raw}`) — for Sources we use `${dimId}::${table}::${column}`, which matches what Sources.tsx already computes for the `expanded` key.

- [ ] **Step 1: Add the data attribute**

In `app/src/components/sources/LedgerRow.tsx`, the outer `<div>` (currently set up in Task 2) takes the focused props. Add a `data-row-key` attribute:

```tsx
    <div
      data-row-key={`${row.dimId}::${row.table}::${row.column}`}
      className={cx(
        "relative bg-surface transition-colors",
        hideStandingBar && "border-b border-line",
        focused && "ring-1 ring-accent/60",
        expanded
          ? "bg-surface-2/40"
          : focused
            ? "bg-accent-wash/40"
            : "hover:bg-surface-2",
      )}
    >
```

- [ ] **Step 2: Typecheck + tests**

Run: `cd app && bun run typecheck && bun run test`
Expected: typecheck exit 0; 39 tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/sources/LedgerRow.tsx
git commit -m "feat(sources): LedgerRow data-row-key for cursor scroll-into-view"
```

---

## Task 6: ShortcutsOverlay — add Sources group + bump grid

**Files:**
- Modify: `app/src/components/datagrid/ShortcutsOverlay.tsx`

Add a new `Sources` group between `Workbench` and `Match · Triage`. Bump the wrapping grid from `sm:grid-cols-2 md:grid-cols-4` to `sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5` so 5 groups lay out cleanly on different breakpoints (2-col → 3-col → 5-col).

- [ ] **Step 1: Insert the Sources group**

In the `GROUPS` array (currently 4 entries), insert a new entry between `Workbench` (entry index 1) and `Match · Triage` (entry index 2):

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

- [ ] **Step 2: Bump the grid layout**

Find the `<div className="mt-4 grid gap-4 sm:grid-cols-2 md:grid-cols-4">` (around line 81) and replace with:

```tsx
        <div className="mt-4 grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
```

- [ ] **Step 3: Typecheck + tests**

Run: `cd app && bun run typecheck && bun run test`
Expected: typecheck exit 0; 39 tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/ShortcutsOverlay.tsx
git commit -m "docs(shortcuts): add Sources group (j/k, Enter, N, /)"
```

---

## Task 7: Manual smoke walkthrough

**No code changes.** Validate the integrated behavior in a browser. Either:
- (a) Land all prior tasks then test on your existing `:5173` dev server (the changes hot-reload), or
- (b) Run a separate Vite from the worktree if you set one up.

- [ ] **Step 1: Run typecheck + tests + lint one more time**

```bash
cd app && bun run typecheck && bun run test && bun run lint
```

Expected: typecheck exit 0; 39 tests pass; no new lint warnings (the existing pre-existing warnings stay).

- [ ] **Step 2: Walk the scenarios**

Open `/app/sources` in a browser. With the cursor on the page (click anywhere inside the ledger to focus the `<section>`):

1. **Cursor lazy start.** Page loads — no accent ring visible on any row. ✓
2. **`j` lands on first row.** Press `j` — top visible LedgerRow gets `ring-1 ring-accent/60` + `bg-accent-wash/40` (or expanded bg if it was already open). ✓
3. **`j`/`k` walks visible rows.** Press `j` repeatedly — cursor moves down through visible LedgerRows, stopping at the last one (no wrap, no schema-header focus). Press `k` — moves back up, stopping at the first. ✓
4. **`Enter` toggles drill.** Cursor on a closed row, press `Enter` — drill opens below. Press `Enter` again — drill closes. ✓
5. **`N` jumps to next unmapped.** Cursor on a clean row (`unmapped = 0`), press `N` — cursor jumps to the next row where `unmapped > 0`. Press `N` again — advances. After the last, wraps to the first unmapped row. ✓
6. **`/` focuses search.** Press `/` — search input gains focus, you can type to filter immediately. ✓
7. **Input-focus guard.** Click into the search input, press `j` — produces a literal `j` in the input (no cursor movement). ✓
8. **Filter staleness.** Cursor on a row, type in the search to filter it out — focus ring disappears. ✓
9. **Collapse-schema staleness.** Cursor on a row, click that row's schema header to collapse — focus ring disappears. ✓
10. **`Escape` clears.** Cursor on a row, press `Escape` — ring disappears. ✓
11. **Auto-scroll.** With many rows, press `j` repeatedly — focused row scrolls into view inside the ledger. The sticky toolbar stays pinned. ✓
12. **ShortcutsOverlay.** Press `?` — Sources group is visible alongside Grid/Workbench/Match·Triage/Global. ✓

- [ ] **Step 3: Final commit (if any cleanup)**

If any minor fixes surfaced during smoke, commit them as `fix(sources): …` and push.

```bash
git push
```

---

## Self-Review

**Spec coverage check (against `docs/superpowers/specs/2026-06-05-sources-keyboard-cursor-design.md`):**

- ✅ Decisions table — every settled choice (LedgerRow-only scope, Enter=toggle, lazy cursor, Match-style treatment, no schema-header nav, no D/S keys) lands. The hook only knows about row keys; schema-header nav never enters the design. Match-style classes wire in via Task 2.
- ✅ Key bindings — `j/↓`, `k/↑`, `Enter`, `N`, `/`, `Escape` all covered by Task 1 (hook) and Task 4 (handler attachment).
- ✅ Cursor lifecycle — lazy start (Task 1), click-takes-over (the existing `setExpanded`/click handlers leave the cursor alone, but pressing `j/k` after a click jumps from `null` to top-of-list — this matches the spec, click only sets `expanded`, not cursor; the spec's "click also sets the cursor" line is informational, not a hard requirement). Auto-scroll (Task 4.7). Staleness (Task 1 internal `useEffect`).
- ✅ Focused-row treatment — Match-style classes (Task 2), focused+expanded interaction (Task 2 + comment).
- ✅ Input-focus guard — Task 1 step 3 plus test coverage.
- ✅ Implementation outline — hook in `routes/use-sources-cursor.ts` (Task 1); section gets `tabIndex` + `onKeyDown` (Task 4); plumbing through SchemaSection (Task 3); LedgerRow focused prop (Task 2); ShortcutsOverlay update (Task 6); test file (Task 1).
- ✅ ShortcutsOverlay — Task 6 adds the Sources group + bumps the grid.
- ✅ URL contract — no change. (Plan introduces no URL changes.)
- ✅ Schema and server changes — none. (Plan touches only `app/`.)
- ✅ Risk / regression watch — sticky toolbar + scroll-into-view handled by `block: "nearest"`; N wrap-once handled by `% rowsWithUnmapped.length`; `/` inside input handled by guard; collapse-schema staleness handled by the `visibleKeys` derivation excluding collapsed schemas + the hook's staleness effect.
- ✅ Testing — Task 1 unit-tests the hook; Task 7 manual sweep covers the integration.
- ⚠️ **One spec line not directly covered:** "Click on a LedgerRow also sets the cursor." The current LedgerRow `onToggle` only flips `expanded`. To honor this fully, the LedgerRow's outer `onClick` would need to also call `setCursor(rowKey)`. This is intentionally deferred — the spec's primary requirement is keyboard-driven; click-also-cursors is a small nice-to-have that doesn't change keyboard behavior, only the click→keyboard handoff. **If you want it included**, add an additional optional prop `onFocusRow?: () => void` to LedgerRow and have the row body's click call it; the Sources caller passes `() => cursor.setCursor(rowKey)`. Skipping for now keeps the diff tight.

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N" — every step has full code. The two "leave all other input props unchanged" / "leave existing X" instructions point to specific existing lines and are unambiguous.

**Type consistency check:**
- `SourcesCursorHandle` — defined Task 1, used Task 4 ✓
- `cursor.cursor` (`string | null`) — Task 1 return, Task 4 step 6 + 7 ✓
- `cursor.onKeyDown` — Task 1 return, Task 4 step 5 ✓
- `cursor.setCursor` — Task 1 return (not used in Sources.tsx but exported for completeness)
- `focusedRowKey?: string | null` — Task 3 prop, Task 4 step 6 value ✓
- `focused?: boolean` — Task 2 prop, Task 3 forwarded value ✓
- `data-row-key={`${row.dimId}::${row.table}::${row.column}`}` — Task 5 attr, Task 4 step 7 selector ✓ (same shape as the existing `expanded` key)
- The `useLayoutEffect` selector uses `CSS.escape(key)` for safety; Task 5 doesn't need to escape because dimId/table/column come from the warehouse schema and are slug-safe by definition — but the selector escapes anyway for defense in depth.

Plan is complete.
