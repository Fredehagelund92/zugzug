# Grid Phase 0: Performance Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore row virtualization in the Tables grid (broken by a missing flex constraint), make deep links to tables reliable, and add the scrolled-under header shadow — the three highest-certainty items from `docs/grid-next-level-plan.md` Phase 0.

**Architecture:** All three are small, surgical changes to existing React components. The grid (`app/src/components/datagrid/`) is a hand-rolled CSS-grid table with row virtualization via `@tanstack/react-virtual`; the virtualizer only works when its scroll container (`.zz-grid-scroll`) is height-constrained by an unbroken `flex`/`min-h-0` ancestor chain. Task 1 repairs that chain. Task 2 makes the URL→tabs fold wait for table data instead of running against an empty store. Task 3 adds a `data-scrolled` attribute + CSS shadow so the sticky header reads as elevated once content scrolls under it.

**Tech Stack:** React 18, Vite 6, Tailwind v4 (utility classes + `app/src/globals.css`), vitest 4 + @testing-library/react (jsdom), TypeScript.

## Global Constraints

- Working directory for all commands: `app/` inside the worktree (`cd app` first). Test command: `npx vitest run <file>` for a single file, `npm test` for the suite.
- Match existing code style exactly (the repo uses Prettier: `npm run format:check` must stay clean; run `npm run format` if unsure).
- Do not change any user-facing copy. Vocabulary rules (CLAUDE.md): never surface "canonical", "raw", "triage", "master", "golden", "commit", "sync", "tenant", "matching" in UI strings.
- No new dependencies.
- Touch only the files each task names. Do not refactor adjacent code.
- TypeScript must stay clean: `npm run typecheck` passes after each task.
- Every commit message ends with the two trailer lines:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01DjP13yuXXqX2aktep2MPnz`
- jsdom performs no layout. Tests therefore assert *structural contracts* (class chains, attributes), not pixel geometry. Do not try to assert rendered heights.

---

### Task 1: Restore row virtualization — fix the height-constraint chain

The grid's scroll container `.zz-grid-scroll` (in `DataGrid.tsx`) is `overflow-auto` inside a `flex` column chain. `RecordsBody` in `TablePane.tsx` returns a bare `<div>` with **no classes**; as a flex child it defaults to `min-height: auto`, grows to full content height (37,000px+ at 1k rows), and the scroll container never scrolls. TanStack Virtual then renders **every row** (measured: 9,672 mounted rows / 116k DOM nodes / 0.4 FPS at 10k rows; 22 rows / 478 nodes / 55.6 FPS with the fix). Regression introduced in commit `36e743f` (2026-06-05).

**Files:**
- Modify: `app/src/components/TablePane.tsx:643-644` (RecordsBody's `return (` — the bare `<div>`)
- Test: `app/test/tablepane-height-chain.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks consume. (Task 3 depends on the *behavior* this restores — a scrolling `.zz-grid-scroll` — but no code interface.)

- [ ] **Step 1: Write the failing test**

Create `app/test/tablepane-height-chain.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Height-chain contract for the Tables grid.
 *
 * The DataGrid's scroll container (`.zz-grid-scroll`, overflow-auto) can only
 * scroll — and therefore the row virtualizer can only virtualize — when every
 * flex-child wrapper between the tab pane and the grid carries `min-h-0`
 * (flex children default to min-height:auto and grow to content height).
 *
 * A bare `<div>` wrapper in RecordsBody broke this chain in commit 36e743f:
 * with it, ALL rows mount (116k DOM nodes / 0.4 FPS at 10k rows, measured in
 * docs/grid-next-level-plan.md §2). jsdom does no layout, so this contract is
 * asserted at the source level: the root element each mode body returns must
 * participate in the flex chain.
 *
 * If this test fails after a refactor, the fix is to keep `flex flex-1
 * flex-col min-h-0` (or an equivalent height constraint) on the mode body's
 * root element — not to delete the test.
 */

function rootDivOfComponent(source: string, componentName: string): string {
  const start = source.indexOf(`function ${componentName}(`);
  expect(start, `function ${componentName} not found`).toBeGreaterThan(-1);
  const body = source.slice(start);
  const ret = body.indexOf("return (");
  expect(ret, `no return ( in ${componentName}`).toBeGreaterThan(-1);
  const afterReturn = body.slice(ret);
  const divStart = afterReturn.indexOf("<div");
  const divEnd = afterReturn.indexOf(">", divStart);
  return afterReturn.slice(divStart, divEnd + 1);
}

describe("Tables grid height-constraint chain", () => {
  test("RecordsBody's root div is height-constrained (min-h-0 flex chain)", () => {
    const src = readFileSync(
      join(__dirname, "../src/components/TablePane.tsx"),
      "utf8",
    );
    const rootDiv = rootDivOfComponent(src, "RecordsBody");
    expect(rootDiv).toContain("min-h-0");
    expect(rootDiv).toContain("flex");
  });

  test("MatchModeBody's root div is height-constrained (guards the sibling mode)", () => {
    const src = readFileSync(
      join(__dirname, "../src/components/modes/MatchModeBody.tsx"),
      "utf8",
    );
    const rootDiv = rootDivOfComponent(src, "MatchModeBody");
    expect(rootDiv).toContain("min-h-0");
    expect(rootDiv).toContain("flex");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/tablepane-height-chain.test.ts`
Expected: FAIL — the RecordsBody assertion fails (`expect(rootDiv).toContain("min-h-0")`, rootDiv is `<div>`). The MatchModeBody assertion passes (its classes already exist).

- [ ] **Step 3: Apply the one-line fix**

In `app/src/components/TablePane.tsx`, inside `function RecordsBody` (around line 643), change:

```tsx
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
```

to:

```tsx
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
```

(One attribute added to the outer div. Do not touch anything else. There is exactly one bare `return (\n    <div>` inside RecordsBody; the other `return (` sites in the file belong to other components and already have classes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/tablepane-height-chain.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full app suite + typecheck**

Run: `cd app && npm test && npm run typecheck`
Expected: all tests pass (the change is a CSS class; no behavior in jsdom changes). If any datagrid test fails, STOP and report BLOCKED with the failure output — do not adapt other tests.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/TablePane.tsx app/test/tablepane-height-chain.test.ts
git commit -m "fix(grid): restore row virtualization — height-constrain RecordsBody root

RecordsBody returned a bare <div>; as a flex child it grew to content
height, .zz-grid-scroll never scrolled, and TanStack Virtual mounted
every row (116k DOM nodes / 0.4 FPS at 10k rows). One class restores
virtualization: 478 nodes / 55.6 FPS measured. Regression from 36e743f.

Adds a source-level height-chain contract test (jsdom does no layout)."
```

---

### Task 2: Deep links — fold ?open/?active after tables load

On a cold profile, `?open=a,brand&active=brand` silently loses all requested tabs: the mount-only fold effect in `MasterTables.tsx` runs before `initStore()` (fire-and-forget in `TenantLayout.tsx:31`) has populated dims, every `dims.some(...)` check fails, and the blank-page fallback opens `dims[0]` instead. Deep links only work when localStorage already holds the tabs.

**Files:**
- Modify: `app/src/routes/MasterTables.tsx:25-56` (the fold effect)
- Test: `app/test/master-tables-deeplink.test.tsx` (new)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Create `app/test/master-tables-deeplink.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { OpenTabsProvider } from "../src/lib/open-tabs";

/**
 * Deep-link contract: ?open=a,brand&active=brand must open those tabs with
 * brand active even when the store loads AFTER the route mounts (initStore is
 * fire-and-forget — TenantLayout.tsx). Regression: the mount-only fold ran
 * against an empty dims list, dropped every requested tab, and the fallback
 * opened dims[0] instead.
 *
 * The store is mocked with a mutable dims list so the test controls when
 * "loading" finishes. Heavy children (TablePane, TableTabStrip) are stubbed;
 * open-tabs state and the URL writer run for real.
 */

const mockState = vi.hoisted(() => ({
  dims: [] as Array<{ id: string; dimension: string }>,
  listeners: new Set<() => void>(),
}));

vi.mock("../src/store", () => ({
  useDimensions: () => {
    const { useSyncExternalStore } = require("react");
    return useSyncExternalStore(
      (cb: () => void) => {
        mockState.listeners.add(cb);
        return () => mockState.listeners.delete(cb);
      },
      () => mockState.dims,
    );
  },
  useSources: () => [],
  useCanEdit: () => true,
}));

vi.mock("../src/components/TablePane", () => ({
  TablePane: ({ dim, isActive }: { dim: { id: string }; isActive: boolean }) => (
    <div data-testid={`pane-${dim.id}`} data-active={isActive} />
  ),
}));

vi.mock("../src/components/TableTabStrip", () => ({
  TableTabStrip: () => <div data-testid="tabstrip" />,
}));

vi.mock("../src/components/NoTablesYet", () => ({
  NoTablesYet: () => <div data-testid="no-tables" />,
}));

vi.mock("../src/lib/create-table-modal", () => ({
  useCreateTableModal: () => ({ open: () => {} }),
}));

const DIMS = [
  { id: "a", dimension: "A" },
  { id: "brand", dimension: "Brand" },
];

function setDims(dims: typeof DIMS) {
  mockState.dims = dims;
  for (const cb of mockState.listeners) cb();
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

async function renderRoute(initialUrl: string) {
  const { MasterTables } = await import("../src/routes/MasterTables");
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <OpenTabsProvider slug={`t-${Math.random().toString(36).slice(2, 8)}`}>
        <Routes>
          <Route
            path="/app/:slug/tables"
            element={
              <>
                <MasterTables />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockState.dims = [];
  mockState.listeners.clear();
  localStorage.clear();
});

describe("Tables deep links", () => {
  test("?open=a,brand&active=brand survives a cold load (dims arrive after mount)", async () => {
    await renderRoute("/app/default/tables?open=a,brand&active=brand");

    // Store finishes loading after the route mounted (the cold-profile case).
    act(() => setDims(DIMS));

    expect(await screen.findByTestId("pane-brand")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("pane-a")).toHaveAttribute("data-active", "false");
    const search = screen.getByTestId("loc").textContent ?? "";
    expect(search).toContain("open=a%2Cbrand");
    expect(search).toContain("active=brand");
  });

  test("legacy ?dimId=brand opens brand after cold load", async () => {
    await renderRoute("/app/default/tables?dimId=brand");
    act(() => setDims(DIMS));
    expect(await screen.findByTestId("pane-brand")).toHaveAttribute("data-active", "true");
  });

  test("dims already loaded at mount still folds the URL (warm path)", async () => {
    mockState.dims = DIMS;
    await renderRoute("/app/default/tables?open=brand&active=brand");
    expect(await screen.findByTestId("pane-brand")).toHaveAttribute("data-active", "true");
  });

  test("no URL params + loaded dims falls back to first table", async () => {
    await renderRoute("/app/default/tables");
    act(() => setDims(DIMS));
    expect(await screen.findByTestId("pane-a")).toHaveAttribute("data-active", "true");
  });
});
```

Note on the store mock: `useDimensions` must be reactive so the component re-renders when `setDims` fires — the `useSyncExternalStore` subscription above does that. If `require("react")` inside the mock trips ESM lint/build, hoist the import instead: `import { useSyncExternalStore } from "react";` at the top of the test file and reference it in the mock factory via `vi.hoisted`-safe indirection (vitest allows referencing top-level imports from `vi.mock` factories only via `vi.hoisted`; the `mockState` pattern above is already hoisted — mirror it for the hook if needed).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/master-tables-deeplink.test.tsx`
Expected: the first two tests FAIL (pane-brand missing or inactive; fold ran against empty dims and the fallback opened "a"). The warm-path test passes. If instead the tests fail on mock/provider wiring (import errors, missing context), fix the harness first — the harness must compile and reproduce the bug before you touch product code.

- [ ] **Step 3: Fix the fold effect**

In `app/src/routes/MasterTables.tsx`, replace the fold effect (lines 25-56):

```tsx
  // Mount-only URL → state fold. Honors legacy ?dimId=<id> from old palette
  // links + bookmarks. New contract is ?open=a,b,c&active=<dimId>.
  const didInitFromUrl = useRef(false);
  // Whether the URL fold opened any tab. The blank-page fallback below runs in
  // the same commit with a stale (pre-fold) `tabs` capture, so without this
  // gate it would open dims[0] AFTER the fold and steal active from a deep link.
  const urlOpenedTab = useRef(false);
  useEffect(() => {
    if (didInitFromUrl.current) return;
    didInitFromUrl.current = true;
    const legacyDim = searchParams.get("dimId");
    const openParam = searchParams.get("open");
    const activeParam = searchParams.get("active");
    if (legacyDim && dims.some((d) => d.id === legacyDim)) {
      openTab(legacyDim);
      urlOpenedTab.current = true;
      return;
    }
    if (openParam) {
      for (const did of openParam.split(",").filter(Boolean)) {
        if (dims.some((d) => d.id === did)) {
          openTab(did);
          urlOpenedTab.current = true;
        }
      }
    }
    if (activeParam && dims.some((d) => d.id === activeParam)) {
      openTab(activeParam);
      urlOpenedTab.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

with:

```tsx
  // URL → state fold, run once — but only after the store has delivered the
  // table list. initStore() is fire-and-forget (TenantLayout), so on a cold
  // profile this route mounts with dims=[] and a mount-only fold would drop
  // every deep-linked tab; the URL writer below stays gated until the fold
  // lands, so ?open/?active survive the wait. Honors legacy ?dimId=<id>.
  // A workspace with no tables never folds — there is nothing to open, and
  // NoTablesYet renders regardless.
  const didInitFromUrl = useRef(false);
  // Whether the URL fold opened any tab. The blank-page fallback below runs in
  // the same commit with a stale (pre-fold) `tabs` capture, so without this
  // gate it would open dims[0] AFTER the fold and steal active from a deep link.
  const urlOpenedTab = useRef(false);
  useEffect(() => {
    if (didInitFromUrl.current) return;
    if (dims.length === 0) return;
    didInitFromUrl.current = true;
    const legacyDim = searchParams.get("dimId");
    const openParam = searchParams.get("open");
    const activeParam = searchParams.get("active");
    if (legacyDim && dims.some((d) => d.id === legacyDim)) {
      openTab(legacyDim);
      urlOpenedTab.current = true;
      return;
    }
    if (openParam) {
      for (const did of openParam.split(",").filter(Boolean)) {
        if (dims.some((d) => d.id === did)) {
          openTab(did);
          urlOpenedTab.current = true;
        }
      }
    }
    if (activeParam && dims.some((d) => d.id === activeParam)) {
      openTab(activeParam);
      urlOpenedTab.current = true;
    }
  }, [dims, searchParams, openTab]);
```

(The `eslint-disable` comment is deleted — the dependency array is now honest. The ref keeps it once-only.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/master-tables-deeplink.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full app suite + typecheck**

Run: `cd app && npm test && npm run typecheck`
Expected: all pass. `open-tabs.test.ts` in particular must stay green.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/MasterTables.tsx app/test/master-tables-deeplink.test.tsx
git commit -m "fix(tables): deep links survive cold loads — fold URL after tables arrive

The ?open/?active fold ran on mount, before fire-and-forget initStore()
populated the table list, so every dims.some() check failed and the
blank-page fallback opened the first table instead. Gate the fold on a
non-empty table list; the URL writer already waits for the fold, so the
deep link's params survive the load."
```

---

### Task 3: Scrolled-under header shadow

With virtualization restored (Task 1), `.zz-grid-scroll` scrolls and the header (`DataGridHeader`, `sticky top-0`) actually sticks. Add the elevation cue benchmarks use: a shadow on the header once content has scrolled under it. Mechanism: the grid toggles `data-scrolled` on the scroll container (rAF-coalesced, matching the file's existing scroll-listener pattern); CSS keys off it.

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx` (one new effect near the other container effects; the component's scroll-container ref is `cursor.ref`)
- Modify: `app/src/components/datagrid/DataGridHeader.tsx:199` (add `zz-grid-header` to the existing className)
- Modify: `app/src/globals.css` (one rule next to the existing `.zz-grid-scroll` block at ~line 338)
- Test: `app/test/datagrid-header-shadow.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1's restored scrolling (behavioral only).
- Produces: `.zz-grid-scroll[data-scrolled]` attribute contract used by CSS.

- [ ] **Step 1: Write the failing test**

Create `app/test/datagrid-header-shadow.test.tsx`:

```tsx
import { test, expect, vi, describe } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

/**
 * Header elevation contract: the scroll container carries data-scrolled
 * exactly when scrollTop > 0, so CSS can shadow the sticky header
 * (.zz-grid-scroll[data-scrolled] .zz-grid-header). The toggle is
 * rAF-coalesced like the file's other scroll listeners — rAF is stubbed to
 * run synchronously here.
 */

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = Array.from({ length: 50 }, (_, i) => ({
  id: `r${i}`,
  name: `Row ${i}`,
}));
const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} />
    </UndoStackProvider>,
  );
}

describe("header scrolled-under shadow", () => {
  test("data-scrolled toggles with scrollTop; header carries zz-grid-header", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const { container } = renderGrid();
      const scroller = container.querySelector<HTMLElement>(".zz-grid-scroll");
      expect(scroller).not.toBeNull();
      expect(container.querySelector(".zz-grid-header")).not.toBeNull();
      expect(scroller!.hasAttribute("data-scrolled")).toBe(false);

      Object.defineProperty(scroller!, "scrollTop", { value: 120, configurable: true });
      act(() => {
        fireEvent.scroll(scroller!);
      });
      expect(scroller!.hasAttribute("data-scrolled")).toBe(true);

      Object.defineProperty(scroller!, "scrollTop", { value: 0, configurable: true });
      act(() => {
        fireEvent.scroll(scroller!);
      });
      expect(scroller!.hasAttribute("data-scrolled")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/datagrid-header-shadow.test.tsx`
Expected: FAIL — `.zz-grid-header` missing and `data-scrolled` never set.

- [ ] **Step 3: Implement**

(a) `app/src/components/datagrid/DataGridHeader.tsx:199` — prepend the hook class to the existing className string:

```tsx
        className="zz-grid-header grid sticky top-0 z-10 items-stretch border-b border-line bg-surface text-[12px] font-medium text-ink-2"
```

(b) `app/src/components/datagrid/DataGrid.tsx` — add one effect inside the `DataGrid` component body, alongside its other `useEffect`s (after the `applyColumnHover` callback is a reasonable spot). The scroll container ref in this component is `cursor.ref`:

```tsx
  // Header elevation: flag the scroll container once content has scrolled
  // under the sticky header so CSS can add a shadow
  // (.zz-grid-scroll[data-scrolled] .zz-grid-header). rAF-coalesced like the
  // other scroll listeners in this file.
  useEffect(() => {
    const el = cursor.ref.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      el.toggleAttribute("data-scrolled", el.scrollTop > 0);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
    };
  }, [cursor.ref]);
```

(c) `app/src/globals.css` — next to the existing `.zz-grid-scroll` rules (~line 338), add:

```css
/* Sticky-header elevation once rows have scrolled underneath. */
.zz-grid-scroll[data-scrolled] .zz-grid-header {
  box-shadow: var(--shadow-sm);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/datagrid-header-shadow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full app suite + typecheck**

Run: `cd app && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx app/src/components/datagrid/DataGridHeader.tsx app/src/globals.css app/test/datagrid-header-shadow.test.tsx
git commit -m "feat(grid): shadow the sticky header once content scrolls under it

The grid toggles data-scrolled on .zz-grid-scroll (rAF-coalesced, same
pattern as the file's other scroll listeners); CSS keys the --shadow-sm
elevation off it. Complements the restored container scrolling."
```

---

## Out of scope for this plan (deliberately)

- Boot payload / drafts N+1 (`grid-next-level-plan.md` 0.5): re-measure boot on a quiet machine after Task 1 lands before deciding.
- Scroll-path hygiene (0.6): profile-first item; 55 FPS was already reached with Task 1 alone.
- Activity-poll push (0.7): tracked as roadmap #53.
- All Phase 1 reliability/craft items and Phase 2 features.

## Verification after all tasks (controller-run)

Live probe against a dev server in this worktree: with ~10k injected rows, `.zz-grid-scroll` must scroll itself (`scrollHeight > clientHeight`), mounted `[data-row]` count ≤ 60, wheel FPS ≥ 50, sticky header visible with shadow at scrollTop > 0, and `?open=a,brand&active=brand` must open both tabs on a fresh profile.
