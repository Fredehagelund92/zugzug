# Frontend UX Audit — Zug Zug
**Date:** 2026-06-04  
**Auditor role:** Senior frontend developer  
**Scope:** All routes + components in `app/src/`; API surface in `server/src/server.ts` + `repo.ts`

---

## 1. Executive Summary

1. **The reconciliation workflow is genuinely strong** — keyboard shortcuts, undo, draft/commit separation, and the cross-dim inbox are all ahead of most internal tools. The recent grid polish (portaled menus, hidden-column chip, segmented control) shows a clear commitment to craft. The gap to "paid product" is narrower than expected but concentrated in a small number of high-visibility spots.

2. **No deep-link to a specific value in the mapping workbench.** The URL only preserves `dimId`, not the focused row. A teammate who wants to share "look at this specific mapping decision" has to navigate manually. For a collaborative review tool this is a critical trust gap.

3. **The dashboard KPIs are static fixtures.** `metrics` in `data.ts` is a hardcoded array; live data (total mapped, new-to-resolve) is calculated correctly from the store but goes only into the prose sentence and the mapping seeds list — the KPI cards always show "48.6k / 23 / 11.4k". This is the first thing a new user notices and immediately erodes trust in the numbers.

4. **Bulk operations in the mapping workbench are incomplete.** Multi-select exists and works for Accept/Skip; however, bulk undo pushes only a single `stageMap` entry per call — the `bulkApply` loop at `Mapping.tsx:247` calls the handler once per value but there is no compound undo entry wrapping the entire batch. Undoing a 20-row bulk accept fires 20 separate network round-trips sequentially.

5. **No cmd-K / global command palette or cross-page search.** With 12+ dimensions and multiple pages, the only navigation primitives are the sidebar and the TablePicker dropdown. There is no way to jump from "anywhere" to a specific dimension, a specific canonical record, or a specific unmapped value without already knowing which page to be on.

6. **Settings page has a "Save changes" button that does nothing.** The `save` handler at `Settings.tsx:131` sets a boolean flash only — the workspace name input and all appearance toggles have no write path behind them. The only real setting that persists is the matching thresholds (ThresholdRange calls `setPreferences` directly on change) and the engineer toggle (localStorage). A user clicking "Save changes" after editing the workspace name gets a "saved" flash but the change is silently dropped.

7. **Empty/loading/error states exist on every surface but are inconsistent in quality.** The boot screen, sources empty state, and catalog explorer have good copy. The MasterTables grid `empty` prop shows a mono string, the cross-dim inbox shows an emoji in prose, and the Dashboard shows nothing when `dims.length === 0` — it would crash (`newCount` assumes dims is non-empty at `Dashboard.tsx:19`).

---

## 2. Critical Findings

### CF-1: Dashboard crashes when dims is empty
**File:** `app/src/routes/Dashboard.tsx:19`  
**What's wrong:** `dims.find((s) => s.id === id)!` is a non-null assertion with no guard. If `dims` loads empty (e.g. a fresh workspace with no tables), the destructured call `s.values.filter(...)` throws. The `Mapping` and `MasterTables` routes handle the zero-dims case with `NoTablesYet`, but `Dashboard` does not — it renders the KPI row, the "Staged for review" section, and the "Mapping seeds" card unconditionally.  
**What good looks like:** An `if (dims.length === 0)` early return that renders a first-run onboarding card (see CF-7 below), or at minimum a safe no-op on `totalNew`.  
**Effort:** S

---

### CF-2: Dashboard KPI cards show hardcoded fixture data
**File:** `app/src/data.ts:19-24`, `app/src/routes/Dashboard.tsx:52-57`  
**What's wrong:** The four KPI cards ("Tables 12", "Values mapped 48.6k", "New to resolve 23", "Rows at risk 11.4k") come from `metrics` in `data.ts`, a static array that never changes. The real totals are already computed in the same component (`totalNew`, `staged.length`, `dims.length`) but only fed into the prose sentence and the mapping list — the cards are cosmetic. A production user will immediately notice the count drift.  
**What good looks like:** Derive KPIs from live store data. "Tables" = `dims.length`, "New to resolve" = `totalNew`, "Staged" = `staged.length`. "Values mapped" and "Rows at risk" need server-level totals (add a `/api/stats` endpoint or include them in the existing `/api/dimensions` summary). The sparkline can stay mocked until time-series data exists — just note it visually (e.g. grey the sparkline bars).  
**Effort:** S (for wiring existing data) / M (for adding the server endpoint for total-mapped)

---

### CF-3: "Save changes" button on Settings does nothing for non-threshold fields
**File:** `app/src/routes/Settings.tsx:131-132`  
**What's wrong:** `save()` calls `setSaved(true)` and sets a 2.2s timer. It does not read the workspace name input's value, does not call any API, and does not persist anything. The workspace name field (`defaultValue="Zugzug · Data"`) is an uncontrolled input with no `onChange`. Engineer toggle and theme follow the token system and are persisted. Thresholds persist directly via `onChange`. The "Save changes" button is a phantom.  
**What good looks like:** Either (a) remove the "Save changes" button and persist each field on blur/change (like thresholds already do), or (b) wire the workspace name to controlled state and call a `PUT /api/workspace` endpoint on save. The domain restriction in `TeamSection.tsx:65` (`@example.com`) is also hardcoded — that should come from server config.  
**Effort:** S (remove phantom button) / M (wire real workspace config endpoint)

---

### CF-4: Bulk undo is N sequential network round-trips, not one compound action
**File:** `app/src/routes/Mapping.tsx:247`  
**What's wrong:** `bulkApply` calls `fn(v)` per selected value. Each `fn` is typically `(v) => stageMap(v, suggestion)` which calls `saveDraft` (1 network call) and `undo.push` with a single-value inverse. When undoing, each entry fires independently. A 20-row bulk accept creates 20 undo stack entries and 20 network calls when undoing.  
**What good looks like:** Wrap `bulkApply` in a compound undo entry — snapshot all prev states before the loop, fire all `saveDraft` calls in parallel (`Promise.all`), and push one undo entry whose inverse un-stages all of them in one `Promise.all`.  
**Effort:** M

---

### CF-5: ComboSelect has no keyboard-navigable option list
**File:** `app/src/components/ComboSelect.tsx:67-98`  
**What's wrong:** The search input has `onKeyDown` for Enter (picks `list[0]`) but there is no arrow-key navigation through the `<ul>`. The user can type to filter and press Enter, but cannot use Down/Up to browse. This is the most-used interactive element on the Mapping page — every "pick a canonical record" action goes through it. For a keyboard-driven workflow this is a meaningful friction point.  
**What good looks like:** Track a `highlighted` index in state, wire ArrowDown/ArrowUp/Enter to it, and add `aria-activedescendant` for accessibility. This is table stakes for a combobox.  
**Effort:** M

---

### CF-6: No per-value or per-decision deep link
**File:** `app/src/routes/Mapping.tsx:76-89`, `app/src/routes/Mapping.tsx:128-129`  
**What's wrong:** URL only holds `?dimId=…`. There is no way to share a link to a specific unmapped value, a specific canonical record, or a specific draft. `selectSeed` replaces `dimId` in the URL, but the focused row (`cursor.cursor`) and the open provenance drawer (`open`) are ephemeral state.  
**What good looks like:** Persist `?dimId=…&value=…` to the URL for the currently-focused value. On load, set `cursor` to that value. This enables "here's the disputed mapping, please review" Slack links that are the bread and butter of collaborative data tools.  
**Effort:** M

---

### CF-7: Zero first-run / onboarding experience
**File:** `app/src/components/NoTablesYet.tsx`, `app/src/routes/Dashboard.tsx`  
**What's wrong:** `NoTablesYet` exists for Mapping and MasterTables but shows a minimal two-button block with no context. Dashboard doesn't use it at all and would crash. There is no empty-state for a workspace with zero sources wired AND zero dimensions — the critical first-run path where a new user lands, sees nothing, and doesn't know what to do next.  
**What good looks like:** A guided empty state on the Dashboard when `dims.length === 0` AND `sources.length === 0`: "Your workspace is empty. Step 1: browse your warehouse to wire a source column. Step 2: create a table. Step 3: start matching values." with direct CTAs. Think Linear's first-run — each step is reachable from one screen.  
**Effort:** M

---

## 3. High-Impact Polish

### P-1: `confirm()` dialog for type-change coerce path
**File:** `app/src/components/datagrid/DataGrid.tsx:506-511`  
**What's wrong:** When changing a column type and there are invalid values, the code calls `confirm(...)` — a browser native blocking dialog. This is jarring in a polished tool, blocks the main thread, and is unstyled.  
**What good looks like:** Replace with an inline modal or an inline banner in the ColumnHeaderMenu itself: "12 values can't be parsed as number. Coerce them to empty to continue." with a Cancel / Coerce button pair.  
**Effort:** S

---

### P-2: Column header menu uses emoji for icons instead of the existing icon system
**File:** `app/src/components/datagrid/ColumnHeaderMenu.tsx:82-91`  
**What's wrong:** Menu items use literal emoji strings: `"✎ rename column"`, `"⇅ change type"`, `"↑ sort A→Z"`, `"⊘ hide column"`, `"🗑 delete column"`. The rest of the app uses the `Icons.tsx` SVG set. Emoji render inconsistently across platforms and sizes; this menu stands out as unfinished relative to the recent grid polish.  
**What good looks like:** Use `IconEdit`, `IconFieldText` (type), sort glyphs from the SVG set, and add a `IconTrash`/`IconX` for delete. Consistent weight and color with `text-ink-3`.  
**Effort:** S

---

### P-3: Mapping workbench "Record" ComboSelect trigger width is unconstrained
**File:** `app/src/routes/Mapping.tsx:619`, column layout `COLS` at line 42  
**What's wrong:** The grid column template is `minmax(160px,1.1fr)` for the canonical record picker. On narrow viewports or with long canonical names the ComboSelect trigger truncates, making the current mapping invisible at a glance. The status column (84px) and confidence column (88px) are fixed, competing for the same row width.  
**What good looks like:** The canonical record column should grow greedily. Consider `1fr` for the record cell and `auto` for the confidence/status columns when the viewport is narrow. Or collapse confidence to a tooltip icon at < 1200px.  
**Effort:** S

---

### P-4: Review panel in commit footer is a flat list with no grouping
**File:** `app/src/routes/Mapping.tsx:746-760`  
**What's wrong:** The "Staged for review" list shows raw → canonical pairs in a flat `<ul>` with no grouping by dimension, no way to remove an individual staged draft without undoing the whole undo stack, and no way to tell at a glance how many new canonical records will be created vs. how many map to existing ones.  
**What good looks like:** Group by target canonical record. Show "→ United States (3 new mappings, 1 new canonical)". Add an individual discard button (calls `discardDraft`) per entry so reviewers can trim the commit set before approving.  
**Effort:** M

---

### P-5: "Auto-match new values" button gives no undo feedback
**File:** `app/src/routes/Mapping.tsx:241-246`  
**What's wrong:** `automap()` loops over values with confidence >= 90 and calls `stageMap` per value, pushing individual undo stack entries. The `autoFlash` state correctly shows "✓ Auto-matched N" for 2.6 seconds, but there's no compound undo ("Undo auto-match 14 values" appearing in the undo button's tooltip). Each auto-matched value is a separate undo entry.  
**What good looks like:** Batch the automap into a single compound undo entry (same fix as CF-4). The undo button label should read the `topLabel` from the undo stack and show "Undo: auto-match 14 values" or similar. Currently `topLabel` is computed in `UndoStack.tsx:67` but is never rendered anywhere — the undo button just says "↶ Undo" always.  
**Effort:** S (render topLabel) / M (compound undo entry)

---

### P-6: MasterTables "Tip" toolbar hint is visible even with 1 record
**File:** `app/src/routes/MasterTables.tsx:323`  
**What's wrong:** `list.length >= 2 ? "Tip — select two or more records to merge them into one." : ""` — the tip shows with 2 records, which means a fresh table imported from a small column immediately shows merge instructions that aren't relevant. The ">= 2" threshold is too low; it should appear when there are 4+ records and the user hasn't selected anything yet.  
**What good looks like:** Show the tip only when `list.length >= 5` or surface it as a dismissible once-per-session tooltip on first merge affordance hover rather than a permanent fixture in the toolbar.  
**Effort:** XS

---

### P-7: Sources "standing callout" accent-left border competes with the overall page accent
**File:** `app/src/routes/Sources.tsx:253`  
**What's wrong:** The "Standing · today" callout uses `border-l-2 border-l-accent bg-accent-wash`. The overall Sources ledger panel already has a top gradient accent edge (`via-accent/70`). The left border is redundant visual hierarchy — the callout already has the heading and the distinct background wash.  
**What good looks like:** Remove `border-l-2 border-l-accent` from the callout div. Let the wash background and the "Standing · today" eyebrow (with its live dot + accent color) carry the prominence signal. The accent left border belongs on notification/toast patterns, not on the hero callout of a page.  
**Effort:** XS

---

### P-8: Login page error handling misses 401 → already-authed path
**File:** `app/src/routes/Login.tsx:8-9`, `app/src/components/BootGate.tsx:16`  
**What's wrong:** The `ERROR_MESSAGES` map handles `domain`, `not_allowed`, `token`, `state`, `no_code`. If the user navigates to `/login` while already authenticated, `BootGate` correctly redirects on 401 — but if someone lands on `/login` from a bad OAuth redirect with an unrecognised error code, the fallback is "Something went wrong — please try again." with no further guidance.  
**What good looks like:** Add an "already_logged_in" error key; add a "contact your admin if this persists" link for unknown error codes. The login page is the first impression for new team members.  
**Effort:** XS

---

## 4. Workflow Improvements

### W-1: No cmd-K command palette / quick-switcher
**What's wrong:** There is no global "jump to dimension", "jump to unmapped value", or "find canonical record" affordance. The sidebar has 5 nav links and the TablePicker is per-page. With 12 dimensions today, this is manageable; at 50+ it becomes a serious navigation tax.  
**What good looks like:** A `cmd-K` palette that indexes: all dimensions (with their unmapped count), all canonical records across all dims (searchable by label or key), recent audit log entries. Selecting a dimension goes to `/app/mapping?dimId=…`; selecting a canonical record goes to `/app/tables?dimId=…&focus=…`. The shortcut should be documented in `ShortcutsOverlay.tsx` under "Global".  
**Effort:** L

---

### W-2: Undo stack is per-page-mount, cleared on dimension switch
**File:** `app/src/components/datagrid/UndoStack.tsx:35-38`  
**What's wrong:** The `UndoStackProvider` clears both stacks when `scopeKey` changes (`useEffect` on `[scopeKey]`). In `MasterTables`, this means switching from dimension A to dimension B clears all dimension-A undo history. On the Mapping page the provider is at the app root (`main.tsx:39`) without a `scopeKey`, so undo persists cross-dimension. This is inconsistent — if you make a mistake in dimension A, switch to B, switch back to A, and press undo, you undo nothing (the stack was cleared by the B switch).  
**What good looks like:** Scope the undo stack by dimension but keep a separate stack per dimension rather than clearing it. A `Map<string, UndoEntry[]>` keyed by dimId lets each dimension have independent history. Alternatively, make the MasterTables undo provider wrap the entire route (it does at the app level) and filter entries by the active dimId rather than clearing on switch.  
**Effort:** M

---

### W-3: Cross-dim inbox lacks "M" (manual pick) keyboard shortcut
**File:** `app/src/routes/Mapping.tsx:838-844`  
**What's wrong:** The single-dim workbench has `A` (accept), `S` (skip), `R` (reset), `M` (open ComboSelect for manual pick), `N` (next new). The cross-dim inbox (`CrossDimInbox` component) handles only `A`, `S`, `N`, and J/K navigation. There is no `M` binding — the user must click the ComboSelect in the focused row to manually pick a canonical record. The hint in the toolbar shows "A accept · S skip · N next" — M is conspicuously absent.  
**What good looks like:** Add `M` to the cross-dim inbox keydown handler: find the ComboSelect in the focused row (`containerRef.current.querySelector('[data-row-key]')`) and trigger click/focus. Or track a "row is open for editing" state mirroring the single-dim cursor model.  
**Effort:** M

---

### W-4: No way to see all pending drafts across dimensions from a single view
**File:** `app/src/routes/Dashboard.tsx:61-85`, `app/src/routes/Mapping.tsx:933-943`  
**What's wrong:** The Dashboard shows up to 5 staged drafts from all dimensions, but clicking "Review & commit" links to `/app/mapping` without preserving which dimensions have staged drafts. In the all-dim view's commit footer, the count is right but there's no expandable review panel (unlike the single-dim footer which has a full `review && staged.length > 0` panel). A reviewer doing a final approval round trip must expand each dimension individually.  
**What good looks like:** In the all-dim commit footer, add the same "Review N" toggle that expands to show all staged drafts grouped by dimension with a discard-per-row button. The Dashboard "Review & commit" link should deep-link to `/app/mapping?view=all` to land the user directly in the all-dim inbox.  
**Effort:** M

---

### W-5: No drag-to-map or multi-row drag affordance
**What's wrong:** The mapping workbench is click-only for mapping. Drag-to-map (drag a source value row onto a canonical record chip) is a natural affordance for rapid reconciliation, especially for users who work mouse-first. The grid already has drag handling for column reordering and cell range selection.  
**What good looks like:** A DnD layer where dragging a value row over a canonical record chip (in a sidebar panel or an expanded canonical list view) highlights the target and drops the mapping. This would require a canonical panel alongside the workbench — not trivial to add without redesigning the layout, but the primitives exist.  
**Effort:** L

---

### W-6: Retire canonical record has no confirmation and fires immediately
**File:** `app/src/routes/MasterTables.tsx:225-235`  
**What's wrong:** The `retire` handler calls `retireCanonical` immediately on click from the bulk remove button in the selection bar. The server correctly blocks retirement if `variants > 0`, but if it returns `ok: true`, the record is gone. There is no "Are you sure?" step or undo registered before the `ok` path. The undo stack push happens only after the fact (`undo.push` at line 231), which means if the API call fails mid-flight (network error), the undo entry was never added.  
**What good looks like:** Push the undo entry optimistically before the API call (or at minimum, add a 1-step confirmation inline in the selection bar: "Remove 2 records? Undo is available."). The `retire` loop for multi-select at line 337 fires sequentially — another case where `Promise.all` would be more correct.  
**Effort:** S

---

## 5. Code-Level Technical Debt Impacting UX

### T-1: `initStore()` is a sequential waterfall of 5+ API calls
**File:** `app/src/store.ts:85-95`  
**What's wrong:**
```ts
await refreshDims();
await refreshDrafts();
await refreshSources();
await refreshAudit();
await refreshPreferences();
```
These five calls are sequential. On a cold API start with a slow Postgres connection, this adds ~5× the latency of a single call before the first render. The boot screen is shown for this entire duration.  
**What good looks like:** Fan these out in parallel: `await Promise.all([refreshDims(), refreshSources(), refreshAudit(), refreshPreferences()])` then `await refreshDrafts()` (which depends on dims being populated). This alone could reduce perceived boot time by 3-4×.  
**Effort:** S

---

### T-2: `refreshDims()` fetches every dimension individually
**File:** `app/src/store.ts:62-65`  
**What's wrong:**
```ts
const metas = await api<{ id: string }[]>("/dimensions");
dims = await Promise.all(metas.map((m) => api<MappingDimension>(`/dimensions/${m.id}`)));
```
N+1 HTTP requests: 1 to list IDs, then one per dimension to fetch the full shape. With 12 dimensions this is 13 requests on every store refresh. Every mutation that calls `refreshDims()` (addCanonical, renameCanonical, mergeCanonical, etc.) re-fires all 13 requests.  
**What good looks like:** Add a `GET /api/dimensions?full=true` endpoint that returns the full dimension shapes in one response. The server already has all the data; the split was inherited from a mock-to-real transition artifact.  
**Effort:** S (backend endpoint) + S (frontend call change)

---

### T-3: Global store uses a single emit/subscribe model — every mutation re-renders everything
**File:** `app/src/store.ts:48-51`, `app/src/store.ts:52-60`  
**What's wrong:** All `useSyncExternalStore` hooks subscribe to the same `listeners` set. Every `emit()` call (which happens after every mutation) re-renders every component that calls any hook. A `saveDraft` re-renders the Dashboard, the Sources page, and every Mapping row simultaneously, even though drafts only affect the active dimension.  
**What good looks like:** Split into per-slice subscriptions: `subscribeDims`, `subscribeDrafts`, `subscribeSources`, `subscribeAudit`. Each hook subscribes only to its slice's listeners. This is the canonical `useSyncExternalStore` pattern for this pattern. Not urgent at 12 dims but will matter at 100.  
**Effort:** M

---

### T-4: The UndoStack `undo.undo()` error handling silently no-ops
**File:** `app/src/components/datagrid/UndoStack.tsx:48-54`  
**What's wrong:**
```ts
try { await e.inverse(); } catch (err) { console.warn("undo inverse failed:", err); }
```
If the undo inverse fails (e.g. the server rejected `discardDraft`), the user gets no feedback. The undo entry is consumed from the stack (via `pop()` at line 47) even if the inverse throws — meaning the action is lost. A failed undo leaves the UI in an inconsistent state with no recovery path.  
**What good looks like:** Re-push the failed entry back onto the stack and surface an error toast: "Undo failed — the server is unreachable." The `pop` should happen only after a successful inverse.  
**Effort:** S

---

### T-5: `MasterTables` columns `useMemo` depends on `open` (provenance drawer state)
**File:** `app/src/routes/MasterTables.tsx:84-166`  
**What's wrong:** `useMemo` for `columns` lists `[fields, engineer, dim.keyCol, external, open, layout]` in its deps array. `open` is the key of the expanded provenance drawer. Every time the user expands a row the entire column definition array is recomputed. Since `columns` feeds `DataGrid`'s `orderedVisible` memo chain, this triggers a recompute of the grid layout on each row expand — a visible, if brief, jank.  
**What's wrong:** The `render` function for the label column is defined inline and closes over `open`. Move `open` out of the column definition by using a ref for the expanded key, or use `useCallback` for the render function with `open` in its own dep.  
**Effort:** S

---

### T-6: Settings `TeamSection.load()` has no error state
**File:** `app/src/routes/Settings.tsx:45-50`  
**What's wrong:**
```ts
fetch("/api/team/members")
  .then((r) => r.json())
  .then((data) => setMembers(data))
  .catch(() => {});  // silent empty catch
```
If the team members API fails, the list stays empty with no indication to the user. The `remove()` function at line 76 also silently ignores failures.  
**What good looks like:** Track an error state: `setError("Couldn't load team members — try refreshing.")`. The add error path is handled, but load and remove are not.  
**Effort:** XS

---

## 6. What's Already Great

**Do not touch these — they are the quality bar to protect:**

- **The grid's keyboard model** — Arrow keys, Enter/Tab for edit, Escape, Shift+Arrow range selection, Cmd+A, Cmd+C/V, Cmd+Z/Shift+Z. This is better than most paid grid components.

- **The recent segmented control polish** (commit 114d4ee) — The sliding pill indicator, the layout-effect-based position calculation, the font hierarchy (display semibold + mono metadata). Exactly the kind of detail that makes a tool feel considered.

- **The shortcut hint bar on focused rows** — When a row is focused, the hint bar `<A> accept <M> record <S> skip <R> reset <?> all shortcuts` appears inline below the row. This is excellent progressive disclosure — the shortcuts are only visible when you're about to use them, and they disappear when you expand provenance.

- **The commit footer's dual-mode copy** (engineer vs. non-engineer) — "Publish N changes" vs. "Approve & commit N" vs. "merged into map_country". The mode-aware copy is a strong UX detail that respects both audiences.

- **Sources page "Standing callout"** — surfacing the single highest-impact unmapped source every time the user visits is the right opinionated choice. The "Nothing requires a decision today" empty state for the callout when everything is clean is well-crafted.

- **Portaled menus with fixed-position placement** (commit 63c84ee) — The ColumnHeaderMenu and AddFieldPopover both use `createPortal(…, document.body)` with `getBoundingClientRect`-based positioning and scroll/resize listeners. No more stacking context traps.

- **Token system and theme architecture** — The `tokens.css` → `globals.css` → `@theme inline` pipeline means no `dark:` variants anywhere, no hardcoded hex in components. The `[data-theme="light"]` swap just works. The `SQUARE_MODE` override (`:root { --r-sm: 0px }`) is an elegant one-line global.

- **Draft/commit separation** — The architecture of staging to Postgres first (no MotherDuck write per keystroke) then batching to the canonical store is correct and the UI correctly surfaces the staged-vs-committed distinction through chip colors, the review footer, and the audit trail.

- **Undo/redo is consistently available** across both Mapping and MasterTables, with proper `inverse` callbacks for every mutation type including merge and rename.

- **The `useGridCursor` hook is clean and composable** — the cursor is independent of row data structure, and the Mapping page extends it without subclassing by handling mapping-specific keys after `cursor.onKeyDown` returns.

---

*Findings are ordered by impact within each section. "Effort" is relative: XS < 1 hour, S < half-day, M < 2 days, L = multi-day sprint.*
