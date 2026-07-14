# Grid Wave 5 — Product Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three standalone Phase-2 grid features — search across all visible fields (2.1), a "Map values to this record" handoff to Match mode (2.3), and per-table filter persistence (2.4).

**Architecture:** All client-side except a one-field widening of the persisted `GridLayoutConfig` JSON blob (no migration). Search adds a records-mode search box + an all-visible-field predicate. The handoff adds a new `?target=` URL param (mirroring the existing `?value=` machinery) that Match mode consumes. Filter persistence rides the existing debounced grid-layout save.

**Tech Stack:** React 18 + Vite + Tailwind v4 + React Router 6 (`app/`), Bun + `postgres.js` (`server/`), Vitest (app), `bun:test` (server).

## Global Constraints

Copied from `docs/superpowers/specs/2026-07-13-grid-wave5-product-features-design.md`.

- **Vocabulary (CLAUDE.md, Wave-4 gate stays green):** never surface `canonical`, `raw`, `triage`, `master`, `golden`, `commit`, `sync`, `tenant`, `matching`. Search copy = "Search records…". Handoff item = "Map values to this record".
- **Data-access (CLAUDE.md):** OLTP → `postgres.js`; warehouse → DuckDB; cross-store joins in app code; never a DuckDB→Postgres ATTACH. **No schema migration** — 2.4 only widens the `user_grid_layout.config` varchar JSON blob.
- **Locked decisions:** 2.1 = filter rows (not highlight); 2.4 = auto-persist per user, per table (like widths/sort). 2.3 uses a NEW `?target=<recordKey>` param (the existing `?value=` pins a source-value row, not a target record).
- **Test commands:** app → `cd app && bun run test <file>` / `bun run typecheck`. Server → `cd server && bun run test <file>` / `bun run typecheck` (Postgres test DB already up on :55432).
- **Commits:** small, per task; `feat(grid):` / `test(grid):` prefixes.

**Note (2.1 framing):** the audit called the search "label-only", but on this branch there is NO records quick-search — `rowsForGrid` (`TablePane.tsx:420`) passes rows through unfiltered. So 2.1 *adds* a search box + predicate; the deliverable equals the spec's intent.

Task order: 2.1 (T1–T2) → 2.4 (T3–T4) → 2.3 (T5–T7). Features are independent; within 2.3, T5 (URL param) → T6 (consume) → T7 (menu) is dependency order.

---

## Task 1: Records search box + all-visible-field filter (2.1)

**Files:**
- Modify: `app/src/components/TablePane.tsx` (RecordsBody — add search state + input; filter `rowsForGrid` ~420 by query across visible fields)
- Test: `app/test/records-search.test.tsx` (create)

**Interfaces:**
- Produces: a `search` state + `searchRef` (an `HTMLInputElement` ref) that Task 2 focuses; a `matchesSearch(row, query, visibleFields)` predicate applied before rows reach the grid.

- [ ] **Step 1: Write the failing test**

Create `app/test/records-search.test.tsx` — render RecordsBody (or the smallest wrapper that mounts the records grid + search box; follow `app/test/master-tables-deeplink.test.tsx` setup for mounting a table). Assert: a record whose label does NOT contain the query but whose visible `rank` value DOES is present; a match only in a HIDDEN field is absent; clearing the query restores all rows.
```tsx
test("search matches any visible field value, not just the label", () => {
  // rows: [{key:'r1', label:'Alpha', rank:'4543'}, {key:'r2', label:'Beta', rank:'12'}]
  // type "4543" into the search box → only r1 remains (matched on rank, a visible field)
  // type a value that only exists in a HIDDEN column → 0 rows
  // clear → both rows
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test records-search`
Expected: FAIL — no search box exists; all rows always render.

- [ ] **Step 3: Add the search state + predicate**

In `TablePane.tsx` RecordsBody, add near the other state (`~220`):
```tsx
const [search, setSearch] = useState("");
const searchRef = useRef<HTMLInputElement | null>(null);
```
Compute visible fields from the `columns` already built in this component (the ones with `!hidden`), and filter `rowsForGrid` (`~420`) by matching the query (case-insensitive substring) against the string form of every visible field's value:
```tsx
const visibleFields = useMemo(
  () => columns.filter((c) => !c.hidden).map((c) => c.field),
  [columns],
);
const rowsForGrid = useMemo(() => {
  const all = list.map((c): CanonicalValue & Record<string, unknown> => ({ ...c, ...(c.fields ?? {}) }));
  const q = search.trim().toLowerCase();
  if (!q) return all;
  return all.filter((row) =>
    visibleFields.some((f) => {
      const v = (row as Record<string, unknown>)[f];
      return v != null && String(v).toLowerCase().includes(q);
    }),
  );
}, [list, search, visibleFields]);
```
(`label` is a visible field, so label matches still work.)

- [ ] **Step 4: Add the search input UI**

Add a search input to the records toolbar (near the existing add-record input region `~1227`, or the top toolbar — match the surrounding input styling). Copy exactly "Search records…":
```tsx
<input
  ref={searchRef}
  value={search}
  onChange={(e) => setSearch(e.target.value)}
  placeholder="Search records…"
  className="w-full max-w-xs rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
/>
```

- [ ] **Step 5: Run + typecheck**

Run: `cd app && bun run test records-search && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/TablePane.tsx app/test/records-search.test.tsx
git commit -m "feat(grid): search records across all visible fields"
```

---

## Task 2: Wire `/` and Cmd+F to focus search (2.1)

**Files:**
- Modify: `app/src/components/TablePane.tsx` (the pane keydown handler `~133-155`)
- Test: `app/test/records-search-keys.test.tsx` (create)

**Interfaces:**
- Consumes: `searchRef` from Task 1.

- [ ] **Step 1: Write the failing test**

Create `app/test/records-search-keys.test.tsx`: with the records pane focused (not in an input), pressing `/` focuses the search box and does not type "/" into a cell; pressing Cmd/Ctrl+F focuses the search box and calls `preventDefault` (suppressing native find).
```tsx
test("'/' and Cmd+F focus the records search box", () => {
  // render records pane; dispatch keydown '/' on the pane → document.activeElement === searchRef input
  // dispatch keydown 'f' with metaKey → search focused; the event was preventDefaulted
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test records-search-keys`
Expected: FAIL — no `/` / Cmd+F handling.

- [ ] **Step 3: Extend the keydown handler**

In the pane `onKeyDown` (`~133`), after the existing input-skip guard (which already returns when focus is in an INPUT/TEXTAREA/contentEditable), add:
```tsx
if (e.key === "/") {
  e.preventDefault();
  searchRef.current?.focus();
  searchRef.current?.select();
  return;
}
if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
  e.preventDefault();
  searchRef.current?.focus();
  searchRef.current?.select();
  return;
}
```
(The existing guard means these only fire when the grid/pane — not a cell editor — is the active surface, so `/` can still be typed into cells and the search box.)

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test records-search-keys && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/TablePane.tsx app/test/records-search-keys.test.tsx
git commit -m "feat(grid): / and Cmd+F focus the records search"
```

---

## Task 3: Add `filterSet` to the persisted `GridLayoutConfig` (2.4 data layer)

**Files:**
- Modify: `app/src/store.ts:1055-1060` (client `GridLayoutConfig`)
- Modify: `server/src/repo-shared.ts:256-261` (server `GridLayoutConfig`)
- Test: `server/test/grid-layout-filterset.test.ts` (create)

**Interfaces:**
- Produces: `GridLayoutConfig.filterSet?: FilterSet | null` on both client and server. `FilterSet` shape (from `app/src/components/datagrid/types.ts`): `{ conjunction: "and" | "or"; conditions: FilterCondition[] }`.

- [ ] **Step 1: Write the failing server test**

Create `server/test/grid-layout-filterset.test.ts` (follow the env-header + fixture pattern of existing `server/test/*grid*`/repo tests): `setGridLayout(user, dim, { sort, filterSet })` then `getGridLayout(user, dim)` round-trips `filterSet` intact.
```ts
test("grid layout round-trips filterSet", async () => {
  const cfg = { hidden: ["x"], filterSet: { conjunction: "and", conditions: [{ id: "a", field: "region", operator: "equals", value: "EU" }] } };
  await setGridLayout(U, D, cfg as any);
  const got = await getGridLayout(U, D);
  expect(got.filterSet).toEqual(cfg.filterSet);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd server && bun run test grid-layout-filterset`
Expected: FAIL — `GridLayoutConfig` has no `filterSet`; TS/shape rejects it or it's dropped.

- [ ] **Step 3: Widen both interfaces**

Server `repo-shared.ts:256`:
```ts
export interface GridLayoutConfig {
  widths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
  sort?: { column: string; direction: "asc" | "desc" } | null;
  filterSet?: FilterSetConfig | null;
}
export interface FilterSetConfig {
  conjunction: "and" | "or";
  conditions: Array<{ id: string; field: string; operator: string; value: string }>;
}
```
Client `store.ts:1055` — add the same `filterSet?: FilterSet | null` (import `FilterSet` from `./components/datagrid/types`). `setGridLayout`/`getGridLayout` already `JSON.stringify`/`JSON.parse` the whole config, so no other server change is needed.

- [ ] **Step 4: Run + typecheck**

Run: `cd server && bun run test grid-layout-filterset && cd server && bun run typecheck && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/store.ts server/src/repo-shared.ts server/test/grid-layout-filterset.test.ts
git commit -m "feat(grid): persist filterSet in the grid-layout config"
```

---

## Task 4: Apply + persist the saved filter per table (2.4 wiring)

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx` (add `initialFilterSet` prop + `onFilterSetChange` callback; init state from prop; fire callback on filter change ~217, ~791-821, ~1553)
- Modify: `app/src/components/datagrid/types.ts` (DataGridProps: `initialFilterSet?`, `onFilterSetChange?`)
- Modify: `app/src/components/TablePane.tsx` (pass `initialFilterSet={layout.filterSet}`; persist via `onFilterSetChange` → `onLayoutChange({ filterSet })`)
- Test: `app/test/datagrid-filter-persist.test.tsx` (create)

**Interfaces:**
- Consumes: `GridLayoutConfig.filterSet` (Task 3); the existing `onLayoutChange(partial)` save path (`TablePane.tsx:1048`).
- Produces: `DataGridProps.initialFilterSet?: FilterSet | null` and `onFilterSetChange?: (fs: FilterSet | null) => void`.

- [ ] **Step 1: Write the failing test**

Create `app/test/datagrid-filter-persist.test.tsx`: (a) `initialFilterSet` with one condition renders the grid already filtered; (b) adding/removing a filter fires `onFilterSetChange` with the new set; (c) clearing fires it with `null`.
```tsx
test("initialFilterSet applies and filter changes call onFilterSetChange", () => {
  const onFilterSetChange = vi.fn();
  // render DataGrid with initialFilterSet={{conjunction:'and',conditions:[{...region equals EU}]}} → filtered
  // add another condition via the context menu 'Filter to' → onFilterSetChange called with 2 conditions
  // clear filters → onFilterSetChange called with null
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test datagrid-filter-persist`
Expected: FAIL — no `initialFilterSet`/`onFilterSetChange`.

- [ ] **Step 3: Add the prop + callback in DataGrid**

`types.ts` DataGridProps: add `initialFilterSet?: FilterSet | null;` and `onFilterSetChange?: (fs: FilterSet | null) => void;`. In `DataGrid.tsx:217`:
```tsx
const [filterSet, setFilterSet] = useState<FilterSet | null>(() => props.initialFilterSet ?? null);
```
Wrap the setter so every filter mutation notifies the host — introduce a helper used by ALL filter writers (the context-menu "Filter to…" items ~791-821, the FilterBar `onChange` ~1455, and the clear button ~1553):
```tsx
const updateFilterSet = useCallback((next: FilterSet | null | ((cur: FilterSet | null) => FilterSet | null)) => {
  setFilterSet((cur) => {
    const resolved = typeof next === "function" ? next(cur) : next;
    props.onFilterSetChange?.(resolved);
    return resolved;
  });
}, [props]);
```
Replace the existing `setFilterSet(...)` call sites for user-driven filter changes with `updateFilterSet(...)` (keep the internal state name `filterSet` for reads). Do NOT fire the callback for the initial mount.

- [ ] **Step 4: Wire persistence in TablePane**

Where `<DataGrid ... />` is rendered (`~918`), add:
```tsx
initialFilterSet={layout.filterSet ?? null}
onFilterSetChange={(fs) => {
  setLayout((cur) => {
    const next = { ...cur, filterSet: fs };
    setGridLayout(activeId, { filterSet: fs });
    return next;
  });
}}
```
(`setGridLayout` debounces + merges; passing the partial `{ filterSet }` rides the same save path as widths/sort.)

- [ ] **Step 5: Run + typecheck**

Run: `cd app && bun run test datagrid-filter-persist && cd app && bun run test datagrid && cd app && bun run typecheck`
Expected: PASS; existing filter/datagrid tests still green.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx app/src/components/datagrid/types.ts app/src/components/TablePane.tsx app/test/datagrid-filter-persist.test.tsx
git commit -m "feat(grid): filters persist per table via grid-layout"
```

---

## Task 5: Add the `?target=` URL param to the mode machinery (2.3)

**Files:**
- Modify: `app/src/routes/MasterTables.tsx` (the URL effect `~100-130` — gate `target` on match mode exactly like `value`)
- Test: `app/test/master-tables-target-param.test.tsx` (create)

**Interfaces:**
- Produces: `?target=` persists only while `mode === "match"` and is dropped otherwise — the same lifecycle as `?value=`.

- [ ] **Step 1: Write the failing test**

Create `app/test/master-tables-target-param.test.tsx` (follow `master-tables-deeplink.test.tsx` `renderRoute`): deep-linking `?mode=match&target=r1` keeps `target=r1` in the URL while in match mode; switching that tab to records mode drops `target`.

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test master-tables-target-param`
Expected: FAIL — `target` is not managed (may be dropped immediately or never gated).

- [ ] **Step 3: Gate `target` like `value`**

In the URL effect (`~122`), alongside `if (mode !== "match") next.delete("value");` add:
```tsx
if (mode !== "match") next.delete("target");
```
Confirm the fold that reads the initial URL (`didInitFromUrl`) does not strip a fresh `?target=` before Match mode reads it (mirror how `?value=` is preserved on the first fold). If the initial-fold logic special-cases `value`, add `target` to the same preservation.

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test master-tables-target-param && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/MasterTables.tsx app/test/master-tables-target-param.test.tsx
git commit -m "feat(grid): carry ?target= alongside ?value= in match mode"
```

---

## Task 6: Match mode consumes `?target=` — default mapping target (2.3)

**Files:**
- Modify: `app/src/components/modes/MatchModeBody.tsx` (read `?target=` at mount ~257; resolve key→label; default-target state + affordance; default filter to "new"; "map selected → label" action via `stageMap`)
- Test: `app/test/match-mode-target.test.tsx` (create)

**Interfaces:**
- Consumes: `?target=<recordKey>` (Task 5); `dim.canonical` (`{key,label}`), `stageMap(value, label)` (~131), `setFilter` (~93), `sel` selection state (~89).
- Produces: a "Mapping values to <label>" affordance and a default mapping target for selected source values.

- [ ] **Step 1: Write the failing test**

Create `app/test/match-mode-target.test.tsx`: mounting Match mode with `?target=<key>` for an existing record resolves the key to the record's label, shows "Mapping values to <label>", and sets the status filter to "new"; a stale/unknown `target` key shows no affordance and does not throw; the "Map selected" action stages the selected source values to that record (assert `saveDraft`/`stageMap` called with the record's label).

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test match-mode-target`
Expected: FAIL — `?target=` is ignored.

- [ ] **Step 3: Consume `?target=` + affordance**

Mirror the `?value=` ref pattern (`~257`):
```tsx
const initialTargetRef = useRef<string | null>(isActive ? searchParams.get("target") : null);
const [defaultTarget, setDefaultTarget] = useState<{ key: string; label: string } | null>(null);
useEffect(() => {
  const key = initialTargetRef.current;
  if (!key) return;
  initialTargetRef.current = null;
  const rec = dim.canonical.find((c) => c.key === key);
  if (!rec) return;                    // stale key → ignore, no crash
  setDefaultTarget({ key: rec.key, label: rec.label });
  setFilter("new");
}, [dim.id, dim.canonical, setFilter]);
```
Render a dismissible affordance when `defaultTarget` is set (Wave-4 style, no banned words), e.g. "Mapping values to <label>" with a "Map selected" button and a clear/dismiss (× → `setDefaultTarget(null)`):
```tsx
{defaultTarget && (
  <div className="flex items-center gap-2 …">
    <span>Mapping values to <span className="text-ink">{defaultTarget.label}</span></span>
    <button onClick={() => { for (const v of sel) void stageMap(v, defaultTarget.label); }}>Map selected</button>
    <button aria-label="Clear target" onClick={() => setDefaultTarget(null)}>×</button>
  </div>
)}
```
(Reuse existing `sel` selection + `stageMap`; no new draft/undo machinery.)

- [ ] **Step 4: Run + typecheck**

Run: `cd app && bun run test match-mode-target && cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/modes/MatchModeBody.tsx app/test/match-mode-target.test.tsx
git commit -m "feat(grid): match mode maps selected values to a target record from ?target="
```

---

## Task 7: "Map values to this record" context-menu item (2.3)

**Files:**
- Modify: `app/src/components/datagrid/useContextMenu.ts` / `DataGrid.tsx` (add the item to the row-num menu ~987-1036 via a new `onMapValuesToRecord?` prop)
- Modify: `app/src/components/datagrid/types.ts` (DataGridProps: `onMapValuesToRecord?: (recordKey: string) => void`)
- Modify: `app/src/components/TablePane.tsx` (RecordsBody wires `onMapValuesToRecord` → `useNavigate` to `?mode=match&target=<key>`)
- Test: `app/test/records-map-handoff.test.tsx` (create)

**Interfaces:**
- Consumes: the `?target=` machinery (Task 5) and Match consumption (Task 6). The row-num context surface already carries `rowKey` (the record key) — `useContextMenu.ts` `{ kind: "row-num", rowKey }`.
- Produces: a records row-menu item "Map values to this record".

- [ ] **Step 1: Write the failing test**

Create `app/test/records-map-handoff.test.tsx`: right-click a record's row number in Records mode → the menu contains "Map values to this record"; clicking it navigates to a URL with `mode=match&target=<that record's key>`.

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test records-map-handoff`
Expected: FAIL — item absent.

- [ ] **Step 3: Add the menu item + prop**

`types.ts`: `onMapValuesToRecord?: (recordKey: string) => void;`. In the row-num menu (`DataGrid.tsx:987`), add (Wave-4 menu spec — Title Case + icon, no shortcut), only when the prop is provided:
```tsx
...(props.onMapValuesToRecord ? [{
  label: "Map values to this record",
  icon: <IconArrowRight />,               // match the app's icon set
  onClick: () => props.onMapValuesToRecord!(rk),
}] : []),
```

- [ ] **Step 4: Wire navigation in RecordsBody**

In `TablePane.tsx` RecordsBody, add `const navigate = useNavigate();` (if not present) and pass to the grid:
```tsx
onMapValuesToRecord={(recordKey) => {
  const next = new URLSearchParams(window.location.search);
  next.set("mode", "match");
  next.set("target", recordKey);
  navigate(`?${next.toString()}`);
}}
```

- [ ] **Step 5: Run + typecheck + vocabulary gate**

Run: `cd app && bun run test records-map-handoff && cd app && bun run test vocabulary-gate && cd app && bun run typecheck`
Expected: PASS; the new user-facing string obeys the banned list.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/useContextMenu.ts app/src/components/datagrid/DataGrid.tsx app/src/components/datagrid/types.ts app/src/components/TablePane.tsx app/test/records-map-handoff.test.tsx
git commit -m "feat(grid): 'Map values to this record' hands off to Match mode"
```

---

## Wave sign-off

After Task 7: full app + server suites and both typechecks green; the Wave-4 vocabulary gate still green (search copy + handoff item obey the banned list). Manual journey (deferred if no dev app): search hits a non-label field; `/` and Cmd+F focus search; a filter survives reload; the handoff lands in Match mode with the record's target affordance and status filter on "new".
