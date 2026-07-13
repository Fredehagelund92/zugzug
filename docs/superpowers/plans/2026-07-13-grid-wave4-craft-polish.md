# Grid Wave 4 — Craft Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every "feels-cheap" craft defect (audit 1.10–1.21) and remove the six dead-code items (§6), so the grid feels intentional — one menu system, correct numbers, real feedback, no layout shift, no React warnings, no vocabulary leaks.

**Architecture:** Many small surgical edits across the datagrid + a few shell/settings files. One deliberate cross-cutting change: unify the three bespoke menu presentations onto one spec (Title Case + icon + ⌘ hint). Everything else is localized. No schema change; number handling is boundary coercion only.

**Tech Stack:** React 18 + Vite + Tailwind v4 (`app/`), Bun (`server/`), Vitest (app tests, RTL), `bun:test` (server tests).

## Global Constraints

Every task implicitly includes this section. Copied from `docs/superpowers/specs/2026-07-13-grid-wave4-craft-polish-design.md`.

- **Vocabulary (CLAUDE.md, exit gate):** never surface `canonical`, `raw`, `triage`, `master`, `golden`, `commit`, `sync`, `tenant`, `matching` in user-facing strings. Task 15 is the sweep; its grep must be clean before the wave signs off.
- **Data-access (CLAUDE.md):** OLTP → `postgres.js`; warehouse → DuckDB; cross-store joins in app code; never a DuckDB→Postgres ATTACH. **No schema migration this wave.**
- **Locked decisions:** menu spec = Title Case + leading icon + right-aligned ⌘ hint; 1.11 = boundary coercion (no migration); 1.10 internal leaks (e.g. "next position") = delete outright; kill-list #4 "Duplicate" = remove (not implement).
- **Behavior-preserving unless a task says otherwise.** Surgical: every changed line traces to an audit defect; no unrelated refactoring.
- **Verify-first TDD:** several items may be partially fixed by prior waves. For each, write the test for the *desired* behavior FIRST. If it already passes, record "already satisfied" in the ledger and move on — do not force a change.
- **Test commands:** app → `cd app && bun run test <file>` / `bun run typecheck`. Server → `cd server && bun run test <file>` / `bun run typecheck` (Postgres test DB already up on :55432).
- **Commits:** small, per task; conventional prefixes (`fix(grid):`, `feat(grid):`, `chore(grid):`, `refactor(grid):`).

Task order minimizes conflicts: isolated deletions first (1–4), then menus (5–6), editing (7–8), feedback (9–12), bugs (13–14), vocabulary gate last (15).

---

## Task 1: Remove the dead `/` and `?` shortcuts + dead cursor params (1.21, kill #2/#3)

**Files:**
- Modify: `app/src/components/datagrid/useGridCursor.ts` (Opts `onShortcuts`/`onFocusFilter` ~66-81; destructure ~83-96; the `?`/`/` handlers ~355-363; deps array ~384-402)
- Modify: `app/src/components/datagrid/ShortcutsOverlay.tsx` (the `["/", "focus filter"]` row ~21)
- Test: `app/test/datagrid-slash-shortcut.test.tsx` (create)

**Interfaces:**
- Produces: `useGridCursor` no longer accepts `onShortcuts`/`onFocusFilter`; `/` and `?` are no longer intercepted by the grid.

- [ ] **Step 1: Write the failing test**

Create `app/test/datagrid-slash-shortcut.test.tsx` (house style from `datagrid-context-menu.test.tsx`): focus a cell, dispatch a `/` keydown, assert it is NOT preventDefaulted (so a leading `/` could be typed) — i.e. type-to-edit opens with `/`:
```tsx
test("pressing '/' on a focused cell starts editing with '/', not a swallowed shortcut", () => {
  const { container } = render(
    <UndoStackProvider><DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} /></UndoStackProvider>,
  );
  const cell = container.querySelector('[data-cell="1::name"]') as HTMLElement;
  act(() => { fireEvent.pointerDown(cell, { button: 0, bubbles: true }); fireEvent.pointerUp(cell, { button: 0, bubbles: true }); });
  act(() => { fireEvent.keyDown(cell.closest('[role="grid"]')!, { key: "/" }); });
  const input = cell.querySelector("input");
  expect(input?.value).toBe("/");   // '/' now type-to-edits instead of being swallowed
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test datagrid-slash-shortcut`
Expected: FAIL — the `/` handler preventDefaults and calls `onFocusFilter?.()` (no host passes it), so no editor opens with "/".

- [ ] **Step 3: Remove the dead handlers and params**

In `useGridCursor.ts`: delete the `onShortcuts?` and `onFocusFilter?` lines from `Opts` (~66-81), remove them from the destructure (~83-96), delete both handler blocks (the `if (e.key === "?")` and `if (e.key === "/")` at ~355-363), and remove `onShortcuts`/`onFocusFilter` from the `useCallback` deps array (~384-402). (Removing the `/`/`?` interception lets those keys flow to the normal type-to-edit path.)

- [ ] **Step 4: Sync the overlay**

In `ShortcutsOverlay.tsx`, delete the `["/", "focus filter"]` row (~21).

- [ ] **Step 5: Run + typecheck**

Run: `cd app && bun run test datagrid-slash-shortcut && cd app && bun run typecheck`
Expected: PASS; no unused-var errors (params fully removed). If any call site passed these params, remove those args too (grep `onFocusFilter|onShortcuts` across `app/src`).

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/useGridCursor.ts app/src/components/datagrid/ShortcutsOverlay.tsx app/test/datagrid-slash-shortcut.test.tsx
git commit -m "fix(grid): remove dead / and ? grid shortcuts and stale overlay row"
```

---

## Task 2: Remove `density` prop and the "Duplicate" row item (kill #1, #4)

**Files:**
- Modify: `app/src/components/datagrid/types.ts` (`density?` ~168-169; `onDuplicateRow?` ~176)
- Modify: `app/src/components/datagrid/DataGrid.tsx` (density `compact` flag ~175; Duplicate item ~988-990)
- Test: `app/test/datagrid-context-menu.test.tsx` (extend)

**Interfaces:**
- Produces: `DataGridProps` no longer has `density` or `onDuplicateRow`; the row-number context menu has no "Duplicate" item.

- [ ] **Step 1: Write the failing test**

Extend `datagrid-context-menu.test.tsx`: right-click a row number, assert the menu has NO "Duplicate" item:
```tsx
test("row-number context menu has no Duplicate item", () => {
  const { container } = render(<UndoStackProvider><DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={async () => {}} showRowNumbers /></UndoStackProvider>);
  const rownum = container.querySelector('[data-rownum="1"]') as HTMLElement; // adjust selector to the row-number cell
  act(() => { fireEvent.contextMenu(rownum, { clientX: 30, clientY: 30, bubbles: true }); });
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Duplicate");
});
```
(Confirm the row-number element's selector from the component; adjust if it differs.)

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test datagrid-context-menu`
Expected: FAIL — "Duplicate" is present.

- [ ] **Step 3: Remove the code**

In `types.ts` delete `density?: "default" | "compact";` (~168-169) and `onDuplicateRow?: (rowKey: string) => void;` (~176). In `DataGrid.tsx`: delete the `compact` computation (~175) and every use of it (grep `compact` — replace with the default padding it resolved to), and delete the `{ label: "Duplicate", onClick: () => props.onDuplicateRow?.(rk), disabled: !props.onDuplicateRow }` item (~988-990).

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test datagrid-context-menu && cd app && bun run typecheck`
Expected: PASS; grep `density|onDuplicateRow` across `app/src` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/datagrid/types.ts app/src/components/datagrid/DataGrid.tsx app/test/datagrid-context-menu.test.tsx
git commit -m "chore(grid): remove unused density prop and never-wired Duplicate row item"
```

---

## Task 3: Remove the legacy `?dimId=` URL fold (kill #6)

**Files:**
- Modify: `app/src/routes/MasterTables.tsx` (legacy `dimId` branch ~40-48; the `next.delete("dimId")` ~112)
- Test: `app/test/settings-ia-redirects.test.tsx` or a new `app/test/mastertables-url-fold.test.tsx`

**Interfaces:**
- Produces: `?dimId=` no longer opens a tab; `?open=`/`?active=` behavior is unchanged.

- [ ] **Step 1: Write the failing test**

Assert that a URL with only `?dimId=<id>` does NOT open that tab (legacy fold removed), while `?open=<id>` still does. Follow the routing-test setup already in `app/test/settings-ia-redirects.test.tsx`.

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test <the test file>`
Expected: FAIL — the legacy branch still opens `dimId`.

- [ ] **Step 3: Remove the legacy branch**

In `MasterTables.tsx`, delete the `const legacyDim = searchParams.get("dimId")` block and its `if (legacyDim && dims.some(...)) { openTab(legacyDim); ...; return; }` (~40-48). Keep the `openParam`/`activeParam` handling. Remove the now-dead `next.delete("dimId")` (~112) only if `dimId` is no longer read anywhere (grep to confirm; leave the `delete` if it still scrubs a stray param harmlessly — prefer removing it for cleanliness once the reader is gone).

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test <file> && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/MasterTables.tsx app/test/<file>
git commit -m "chore(grid): drop legacy ?dimId= URL fold"
```

---

## Task 4: Remove the legacy `/ws/presence/:tableId` route (kill #5)

**Files:**
- Modify: `server/src/server.ts` (legacy route ~1610-1634)
- Test: `server/test/legacy-routes-removed.test.ts` (extend — this file already exists)

**Interfaces:**
- Produces: the default-tenant `/ws/presence/:tableId` upgrade path no longer exists; only `/ws/t/:slug/presence/:tableId` remains.

- [ ] **Step 1: Write the failing test**

In `server/test/legacy-routes-removed.test.ts`, add an assertion that a request to `/ws/presence/<id>` does NOT upgrade / returns not-found (mirror how that file asserts other removed routes).

- [ ] **Step 2: Run — verify it fails**

Run: `cd server && bun run test legacy-routes-removed`
Expected: FAIL — the legacy route still handles the path.

- [ ] **Step 3: Remove the route**

Delete the `if (url.pathname.startsWith("/ws/presence/")) { ... }` block (~1610-1634) in `server.ts`. Confirm the tenant-scoped `/ws/t/:slug/presence/:tableId` path above it is untouched.

- [ ] **Step 4: Run + typecheck**

Run: `cd server && bun run test legacy-routes-removed && cd server && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/test/legacy-routes-removed.test.ts
git commit -m "chore(grid): remove elapsed-deprecation legacy /ws/presence route"
```

---

## Task 5: Unify the menu spec — Title Case + icon + ⌘ hint (1.14)

**Files:**
- Modify: `app/src/components/datagrid/ContextMenu.tsx` (`MenuItem` interface + render ~5-68 — add `icon?` and `shortcut?` slots)
- Modify: `app/src/components/datagrid/DataGrid.tsx` (context-menu item arrays ~744-826, 942-994 — add icons/shortcuts, ensure Title Case)
- Modify: `app/src/components/datagrid/ColumnHeaderMenu.tsx` (item labels lowercase → Title Case, keep icons ~143-243)
- Modify: `app/src/components/datagrid/FilterBar.tsx` ("apply" → "Apply" ~210; any lowercase menu labels)
- Test: `app/test/datagrid-menu-consistency.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `MenuItem` gains `icon?: ReactNode` and `shortcut?: string`; `ContextMenu` renders `[icon] label ⟶ [shortcut]`. Column menu + filter labels are Title Case.

**Note on scope:** unify the *presentation spec*, not the component tree — the three menus stay separate (ColumnHeaderMenu has submenus; ContextMenu is flat; FilterBar is pills). The goal is consistent casing + icon + shortcut affordance across them.

- [ ] **Step 1: Write the failing test**

Create `datagrid-menu-consistency.test.tsx`: open the cell context menu, assert an item renders Title Case (e.g. "Copy") AND, for an item with a shortcut, the ⌘ hint text is present; assert no lowercase-only menu label remains (e.g. filter "apply" is gone):
```tsx
test("context menu items are Title Case and show shortcut hints where defined", () => {
  // render grid, open cell context menu
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu.textContent).toContain("Copy");
  expect(menu.textContent).toContain("⌘C"); // Copy carries its shortcut hint
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test datagrid-menu-consistency`
Expected: FAIL — no shortcut hint rendered today.

- [ ] **Step 3: Extend `MenuItem` + `ContextMenu` render**

In `ContextMenu.tsx` add optional `icon?: React.ReactNode` and `shortcut?: string` to `MenuItem`; render them: leading icon slot, label, right-aligned `shortcut` in a muted span. Keep `disabled`/`separator` behavior.

- [ ] **Step 4: Populate icons/shortcuts + Title Case**

In `DataGrid.tsx` context-menu arrays, add `icon` (match the icon set used in ColumnHeaderMenu) and `shortcut` where one exists (Copy → `⌘C`, Paste → `⌘V`, etc.); ensure labels are Title Case. In `ColumnHeaderMenu.tsx`, change lowercase labels ("rename column" → "Rename column", etc.) to Title Case, keeping the existing icons. In `FilterBar.tsx`, "apply" → "Apply".

- [ ] **Step 5: Run + typecheck**

Run: `cd app && bun run test datagrid-menu-consistency && cd app && bun run test datagrid && cd app && bun run typecheck`
Expected: PASS; existing menu tests still green (update any that assert old lowercase labels).

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/ContextMenu.tsx app/src/components/datagrid/DataGrid.tsx app/src/components/datagrid/ColumnHeaderMenu.tsx app/src/components/datagrid/FilterBar.tsx app/test/datagrid-menu-consistency.test.tsx
git commit -m "feat(grid): one menu spec — Title Case labels, icons, and shortcut hints"
```

---

## Task 6: Header menu on pinned/key columns (1.15)

**Files:**
- Modify: `app/src/components/datagrid/DataGridHeader.tsx` (the `!c.pinnedLeft &&` gate ~374)
- Test: `app/test/datagrid-pinned-menu.test.tsx` (create)

**Interfaces:**
- Produces: pinned-left columns render the same header menu button as normal columns.

- [ ] **Step 1: Write the failing test**

Create `datagrid-pinned-menu.test.tsx`: render a grid with a `pinnedLeft` column, assert its header has the "Column menu" button (so sort/filter is reachable):
```tsx
test("a pinned-left column shows the header menu button", () => {
  const cols = [{ field: "id", label: "Record", config: { type: "text" }, pinnedLeft: true }, { field: "name", label: "Name", config: { type: "text" } }];
  // render, then:
  const pinnedHeader = container.querySelector('[data-header="id"]')!;
  expect(pinnedHeader.querySelector('[aria-label="Column menu"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test datagrid-pinned-menu`
Expected: FAIL — the `!c.pinnedLeft` gate hides the button.

- [ ] **Step 3: Remove the gate**

In `DataGridHeader.tsx` (~374), change `{!c.pinnedLeft && (<button ...menu...>)}` to always render the menu button (drop the `!c.pinnedLeft &&`).

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test datagrid-pinned-menu && cd app && bun run test datagrid && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/datagrid/DataGridHeader.tsx app/test/datagrid-pinned-menu.test.tsx
git commit -m "feat(grid): expose the header menu on pinned/key columns"
```

---

## Task 7: Numeric aggregates coercion + cell alignment (1.11)

**Files:**
- Modify: `app/src/components/datagrid/useAggregates.ts` (numeric branch ~49)
- Modify (if needed): `app/src/components/datagrid/cells/NumberCell.tsx` (renderer span ~90-102 — ensure the cell right-aligns, not just the inline span)
- Test: `app/test/datagrid-aggregates.test.ts` (extend)

**Interfaces:**
- Produces: `computeAggregates` sums/averages numeric-typed fields even when values arrive as numeric *strings*.

- [ ] **Step 1: Write the failing test**

In `datagrid-aggregates.test.ts`, add a case where numeric values are STRINGS (as they arrive from the store):
```ts
test("sums numeric-typed fields even when values are numeric strings", () => {
  const rows = [{ id: "1", n: "100" }, { id: "2", n: "100" }, { id: "3", n: "100" }];
  const cols = [{ field: "n", label: "N", config: { type: "number" } }];
  const agg = computeAggregates(rows as any, cols as any, (r, f) => (r as any)[f], { minRow: 0, maxRow: 2, minCol: 0, maxCol: 0 });
  expect(agg.sum).toBe(300);
  expect(agg.avg).toBe(100);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test datagrid-aggregates`
Expected: FAIL — `typeof v === "number"` is false for strings, so `sum` is null.

- [ ] **Step 3: Coerce at the aggregate boundary**

In `useAggregates.ts` (~49), replace the `typeof v === "number"` gate with a coercion:
```ts
const isNumericCol = col.config.type === "number" || col.config.type === "rating";
const num = typeof v === "number" ? v : Number(v);
if (isNumericCol && Number.isFinite(num)) {
  anyNumeric = true;
  sum += num; sumCount++;
  if (min == null || (typeof min === "number" && num < min)) min = num;
  if (max == null || (typeof max === "number" && num > max)) max = num;
}
```
(Keep the existing min/max shape; only the numeric coercion + finite guard change.)

- [ ] **Step 4: Cell alignment**

Verify a numeric cell right-aligns at the CELL (not just the inner inline span). If `NumberCell` Renderer's span (~90-102) doesn't fill/right-align within the cell, wrap it so the value sits at the right edge (e.g. `block w-full text-right`). If it already right-aligns visually (the cell container handles it), leave it and note "already aligned".

- [ ] **Step 5: Run + typecheck**

Run: `cd app && bun run test datagrid-aggregates && cd app && bun run typecheck`
Expected: PASS (300 / 100).

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/useAggregates.ts app/src/components/datagrid/cells/NumberCell.tsx app/test/datagrid-aggregates.test.ts
git commit -m "fix(grid): coerce numeric strings so Sum/Avg work; right-align number cells"
```

---

## Task 8: Type-to-edit replaces + header rename select-all (1.12)

**Files:**
- Inspect/modify: `app/src/components/datagrid/cells/*Cell.tsx` (how editors seed `initial` — the append bug)
- Modify: `app/src/components/datagrid/ColumnHeaderMenu.tsx` (rename input — select-all on open)
- Test: `app/test/datagrid-type-to-edit.test.tsx` (create)

**Interfaces:**
- Consumes: `cursorInitial` (the typed char from `useGridCursor.startEdit(e.key)`).
- Produces: starting to type on a focused cell opens the editor containing exactly the typed char (replacing the prior value); opening column rename selects the existing text.

**Note:** `useGridCursor` already passes the typed char via `startEdit(e.key)` → `initial`. The defect (if it still reproduces) is in how a cell editor *seeds* its input — appending `initial` to the existing value instead of replacing. Verify-first.

- [ ] **Step 1: Write the failing test**

Create `datagrid-type-to-edit.test.tsx`: focus a text cell containing "First Record", dispatch keydown "R", assert the editor input value is exactly "R":
```tsx
test("typing on a focused cell replaces content with the typed char", () => {
  const rows = [{ id: "1", name: "First Record" }];
  // render, focus the name cell via pointerDown/Up, then:
  act(() => { fireEvent.keyDown(cell.closest('[role="grid"]')!, { key: "R" }); });
  expect(cell.querySelector("input")?.value).toBe("R");
});
```

- [ ] **Step 2: Run — verify it fails (or already passes)**

Run: `cd app && bun run test datagrid-type-to-edit`
Expected: FAIL if the editor appends ("First RecordR" or "First Recor…"). If it already passes, the cell path is fixed — record "type-to-edit already satisfied" and move to the rename half (Step 4).

- [ ] **Step 3: Fix the seed**

In the editor that seeds from `initial` (e.g. `TextCell`/`NumberCell` editors), when `initial` is present, set the input value to `initial` (replace) rather than `existingValue + initial`. Match the fix across the typed editors that support type-to-edit.

- [ ] **Step 4: Header rename select-all**

In `ColumnHeaderMenu.tsx` rename mode, when the rename input mounts, select its text (`ref` + `el.select()` in an effect on open). Add a test asserting the rename input has its value selected on open (or, if selection state is hard to assert in jsdom, assert the input is focused with `selectionStart === 0 && selectionEnd === value.length`).

- [ ] **Step 5: Run + typecheck**

Run: `cd app && bun run test datagrid-type-to-edit && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/cells app/src/components/datagrid/ColumnHeaderMenu.tsx app/test/datagrid-type-to-edit.test.tsx
git commit -m "fix(grid): type-to-edit replaces cell content; rename selects all"
```

---

## Task 9: Copy feedback — range flash + toast (1.13)

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx` (`handleCopy` ~580-607; `toast` already imported ~28)
- Test: `app/test/datagrid-copy-feedback.test.tsx` (create)

**Interfaces:**
- Produces: a successful copy dispatches a "Copied" toast (and applies a brief flash class to the copied range/cell).

- [ ] **Step 1: Write the failing test**

Create `datagrid-copy-feedback.test.tsx`: mock `navigator.clipboard.writeText`; trigger ⌘C; assert the toast is shown. Spy on the `toast` module (`app/src/components/Toast`) or assert the toast DOM appears:
```tsx
test("copying shows a Copied confirmation", async () => {
  // render grid, focus a cell, dispatch ⌘C keydown
  await act(async () => { fireEvent.keyDown(grid, { key: "c", metaKey: true }); });
  expect(document.body.textContent).toContain("Copied");
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test datagrid-copy-feedback`
Expected: FAIL — copy is silent today.

- [ ] **Step 3: Add feedback**

In `handleCopy`, after a successful `navigator.clipboard.writeText(...)`, call `toast("Copied", "info")` (match the app's toast signature) and apply a brief flash class to the copied range (add/remove a `zz-copy-flash` class with a short timeout, or reuse an existing flash mechanism if one exists — grep for a flash pattern first).

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test datagrid-copy-feedback && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx app/test/datagrid-copy-feedback.test.tsx
git commit -m "feat(grid): copy confirms with a flash and a Copied toast"
```

---

## Task 10: Truncated-cell hover reveal (1.16)

**Files:**
- Modify: `app/src/components/datagrid/cells/TextCell.tsx` (Renderer ~7-14 — add `title`)
- Test: `app/test/datagrid-cell-title.test.tsx` (create)

**Interfaces:**
- Produces: a truncated text cell carries the full value in a `title` attribute (native hover reveal).

- [ ] **Step 1: Write the failing test**

Create `datagrid-cell-title.test.tsx`: render a cell with a long value; assert the value span has `title` equal to the full string.

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test datagrid-cell-title`
Expected: FAIL — no `title` today.

- [ ] **Step 3: Add the title**

In `TextCell.tsx` Renderer, add `title={s}` to the truncating span. (Keep the `—` empty branch untitled.) Apply the same to other text-like cell renderers that truncate (grep `truncate` under `cells/`), if trivial.

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test datagrid-cell-title && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/datagrid/cells/TextCell.tsx app/test/datagrid-cell-title.test.tsx
git commit -m "fix(grid): truncated cells reveal the full value on hover (title attr)"
```

---

## Task 11: Rename banner → overlay toast (1.19, folds "raw value" vocab)

**Files:**
- Modify: `app/src/components/TablePane.tsx` (in-flow rename banner ~857-881; state ~222-226; auto-dismiss ~969-980)
- Test: `app/test/tablepane-rename-toast.test.tsx` (create) — or assert no layout element

**Interfaces:**
- Produces: the rename confirmation renders as an overlay toast (absolute/fixed, not in document flow), so grid layout height does not change. The copy drops the banned "raw value" wording.

- [ ] **Step 1: Write the failing test**

Assert the rename confirmation is NOT a flow element above the grid — e.g. after a rename, the grid container's top offset / height is unchanged, or the confirmation node has `position: absolute|fixed`. Simpler behavioral proxy: the confirmation text is inside an overlay/toast container (a portal or an absolutely-positioned element), not a `border-b` sibling in the pane column.

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test tablepane-rename-toast`
Expected: FAIL — today it's an in-flow `border-b bg-accent-wash` div.

- [ ] **Step 3: Convert to overlay toast**

Replace the in-flow banner (~857-881) with an overlay presentation — reuse the app `toast` system if it supports an action (Undo), or an absolutely-positioned overlay within the pane that doesn't affect layout height. Preserve the Undo + Dismiss actions and the auto-dismiss timer. **Reword** the copy to drop "raw value": e.g. "Renamed "{prev}" → "{next}". {n} source value{s} re-pointed." (Task 15 verifies the vocab grep; fix it here since we're rewriting this string.)

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test tablepane-rename-toast && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/TablePane.tsx app/test/tablepane-rename-toast.test.tsx
git commit -m "fix(grid): rename confirmation is an overlay toast, no layout shift"
```

---

## Task 12: First-paint skeleton settle (1.20) — verify-first

**Files:**
- Inspect: `app/src/components/Skeleton.tsx` (heights already reserved via `h-3` + matching `gridTemplateColumns`)
- Modify (only if a shift reproduces): the grid/records skeleton usage or the fade-in that settles ~8px

**Interfaces:**
- Produces: no first-paint vertical settle on cold open.

- [ ] **Step 1: Reproduce or clear the defect**

The skeleton already reserves row heights (`h-3`) and matches column layout. First inspect whether the ~8px settle comes from the skeleton (unreserved height) or a fade-in transform. Write a test/measurement if feasible (e.g. the skeleton row height equals the data row height), or document the reproduction from the audit screenshots. If the skeleton already reserves the correct heights and no shift reproduces, record "1.20 already satisfied by reserved skeleton heights" in the ledger and skip to no commit.

- [ ] **Step 2: If a shift remains, reserve the missing height / drop the settling transform**

If the settle is real: align the skeleton row/toolbar heights to the loaded layout, or remove the translate-on-fade so opacity fades without vertical movement. Add a test asserting the reserved dimension matches the loaded one.

- [ ] **Step 3: Run + typecheck + commit (if changed)**

Run: `cd app && bun run test <file> && cd app && bun run typecheck`
```bash
git commit -m "fix(grid): first paint settles without vertical shift"
```
(If Step 1 found it already satisfied, note it in the ledger and make no commit.)

---

## Task 13: React warnings — setState-in-render + duplicate palette key (1.17)

**Files:**
- Modify: `app/src/components/datagrid/DataGridHeader.tsx` (resize/reorder state updates that fire during render)
- Modify: the palette command source that registers a duplicate `Review` key (NOT `CommandPalette.tsx` — grep for it)
- Test: `app/test/datagrid-no-warnings.test.tsx` (create)

**Interfaces:**
- Produces: resizing/reordering a column produces no "Cannot update X while rendering Y" warning; palette command keys are unique.

- [ ] **Step 1: Write the failing test**

Create `datagrid-no-warnings.test.tsx`: spy on `console.error`; simulate a column resize (and reorder); assert `console.error` was not called with a "Cannot update" / "while rendering" message:
```tsx
test("resizing a column logs no setState-in-render warning", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  // render grid, simulate resize drag on a header grip
  expect(spy.mock.calls.flat().join(" ")).not.toMatch(/Cannot update .* while rendering/);
  spy.mockRestore();
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test datagrid-no-warnings`
Expected: FAIL — the warning fires on resize/reorder.

- [ ] **Step 3: Move the state update out of render**

In `DataGridHeader.tsx`, find where resize/reorder calls a parent setState during render (the audit: "Cannot update RecordsBody while rendering DataGrid"). Move it into an effect or event handler (e.g. wrap in `useEffect`, or defer with a ref + effect) so it no longer runs in the render body.

- [ ] **Step 4: De-dupe the palette `Review` key**

Grep for where the command palette registers commands with a `Review` key/id (the duplicate that triggers a React duplicate-key warning) — likely a command list feeding `CommandPalette`. Make the keys unique. Add/extend a test asserting no duplicate keys (or that the palette renders without the duplicate-key warning).

- [ ] **Step 5: Run + typecheck**

Run: `cd app && bun run test datagrid-no-warnings && cd app && bun run typecheck`
Expected: PASS; test output pristine (no warnings).

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/DataGridHeader.tsx <palette command file> app/test/datagrid-no-warnings.test.tsx
git commit -m "fix(grid): no setState-in-render on resize/reorder; unique palette keys"
```

---

## Task 14: Optimistic create-table modal + background provisioning (1.18)

**Files:**
- Modify: `app/src/components/CreateTableModal.tsx` (submit ~82-104 — close optimistically)
- Modify: `app/src/components/AddFieldPopover.tsx` (submit ~212-269 — same optimistic treatment)
- Modify (as needed): `app/src/routes/MasterTables.tsx` / `app/src/lib/open-tabs.tsx` (pending-tab state)
- Test: `app/test/create-table-optimistic.test.tsx` (create)

**Interfaces:**
- Consumes: `createTable(payload)` (async), `openTab(dimId)` (returns immediately).
- Produces: submitting create closes the modal synchronously and shows a pending/provisioning indicator; on success the real table tab opens; on failure an error surfaces with a retry, and the pending state is removed on dismiss.

**Design latitude:** Prefer a **pending tab** (spinner) if it fits `open-tabs` cleanly. If threading a temporary tab id through `open-tabs` proves invasive beyond this task, fall back to: close the modal immediately + a "Creating …" toast that resolves to a success toast (opening the tab) or an error toast with a **Retry** action. Either satisfies "modal doesn't hang." State which you built.

- [ ] **Step 1: Write the failing test**

Create `create-table-optimistic.test.tsx`: make `createTable` a promise you control; submit the modal; assert the modal closes BEFORE the promise resolves (optimistic); then resolve → the tab opens; and in a second case, reject → an error with a retry affordance appears.

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test create-table-optimistic`
Expected: FAIL — today the modal awaits `createTable` before `onClose()`.

- [ ] **Step 3: Make create optimistic**

In `CreateTableModal.submit`, close the modal immediately and run `createTable` in the background; show the pending indicator; on success `onCreated(id)` + open the tab; on failure surface the error + Retry (re-invokes create with the same payload), and clear the pending state on dismiss. Apply the analogous optimistic treatment to `AddFieldPopover.handleSubmit` (pending field state).

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test create-table-optimistic && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/CreateTableModal.tsx app/src/components/AddFieldPopover.tsx app/src/routes/MasterTables.tsx app/src/lib/open-tabs.tsx app/test/create-table-optimistic.test.tsx
git commit -m "feat(grid): create-table/add-field close optimistically; provision in background"
```

---

## Task 15: Vocabulary sweep + exit gate (1.10)

**Files:**
- Modify: `app/src/components/TablePane.tsx` ("raw" meta ~685; "next position" ~673; "pick survivor…" ~1295; merge confirm ~1429)
- Modify: `app/src/routes/settings/Warehouse.tsx` ("master records" ~128; "master record" ~168)
- Test: `app/test/vocabulary-gate.test.ts` (create) — the exit-gate grep

**Interfaces:**
- Produces: no banned term in the grid/settings user-facing strings touched this wave.

**Replacements (locked):** "{n} raw" → "{n} source values"; "next position: …" → **deleted**; "pick survivor…" → "Keep which record?"; merge-confirm "Merge into …" keep (no banned term) but reword any survivor/master phrasing; Warehouse "master records live where…" → "records live where…"; "new values that need a master record" → "new values that need a record".

- [ ] **Step 1: Write the failing gate test**

Create `app/test/vocabulary-gate.test.ts`: read the touched source files and assert none of the banned terms appear in user-facing string literals. Practical form — scan the specific files for the banned words in JSX text / string literals:
```ts
import { readFileSync } from "node:fs";
const BANNED = ["canonical", "raw", "triage", "master", "golden", "commit", "sync", "tenant", "matching"];
const FILES = ["app/src/components/TablePane.tsx", "app/src/routes/settings/Warehouse.tsx"];
test("no banned vocabulary in user-facing strings of touched files", () => {
  for (const f of FILES) {
    const text = readFileSync(f, "utf8");
    // crude but effective: fail on a banned word appearing inside a JSX text/string.
    // (Allow identifiers/imports; target quoted strings and >...< text — see helper.)
  }
});
```
Implement a focused matcher (quoted strings + JSX text nodes) so code identifiers like `canonicalTable` type fields don't false-positive; the goal is user-facing copy. Keep it targeted to these files.

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test vocabulary-gate`
Expected: FAIL — "raw", "master record", etc. present.

- [ ] **Step 3: Apply the replacements**

Make the replacements above in `TablePane.tsx` and `Warehouse.tsx`. Delete the "next position: {dim.nextPosition}" display (~673). (The rename-banner "raw value" was already reworded in Task 11 — confirm it's clean.)

- [ ] **Step 4: Run the gate + full suites**

Run: `cd app && bun run test vocabulary-gate && cd app && bun run typecheck`
Expected: PASS (gate clean).

- [ ] **Step 5: Commit**

```bash
git add app/src/components/TablePane.tsx app/src/routes/settings/Warehouse.tsx app/test/vocabulary-gate.test.ts
git commit -m "fix(grid): sweep banned vocabulary from grid + warehouse copy"
```

---

## Wave sign-off

After Task 15: run the full app + server suites and both typechecks; confirm the vocabulary gate is green. Record the result and any items marked "already satisfied" (verify-first no-ops) in the progress ledger.
