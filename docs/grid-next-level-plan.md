# Grid Next-Level Plan

Audit date: 2026-07-12 · branch `publish-lifecycle` · dev server (Vite) + Bun API, measured with Playwright/CDP on the live app. Produced by the audit prompt in `docs/grid-audit-prompt.md`. Plan only — no product code was changed (one diagnostic edit was applied, measured, and reverted).

## 1. Executive summary

1. **Row virtualization is broken in Records mode, and has been since 2026-06-05.** `RecordsBody`'s root element is a bare `<div>` (`app/src/components/TablePane.tsx:739`) with no `flex flex-1 min-h-0`, so the grid's scroll container grows to full content height, `overflow-auto` never engages, and TanStack Virtual mounts **every row**. All the slowness the user feels follows from this: 5,300-row brand table = 61k DOM nodes; wheel scroll at 10k rows runs at **0.4 FPS**. The fix is one line, and it was verified: with the class added, 10k rows render 22 row elements / 478 DOM nodes and scroll at **55.6 FPS**. Introduced by commit `36e743f` (multi-tab work); Match mode (`MatchModeBody.tsx:368`) has the correct classes and is unaffected.
2. **Because the grid doesn't scroll, the whole page canvas scrolls instead** (`main.zz-canvas` in AppShell). The grid's sticky header and pinned-left column are therefore silent no-ops in Records mode today — users scroll the toolbar and column headers off screen. Several "feel" problems are this one bug wearing different hats.
3. **Deep links are broken.** `?open=a,brand&active=brand` on a fresh profile silently drops all requested tabs and opens `dims[0]` instead: the mount-only URL fold (`MasterTables.tsx:35-59`) runs before the store has loaded, every `dims.some(...)` check fails, and the fallback effect (`:63-68`) takes over. Links only appear to work when localStorage already holds the tabs. This bit the audit harness itself on every cold run.
4. **Writes fail silently, and the UI lies about it.** A failed cell save reverts with no toast/banner/retry while the status pill still shows green "Saved"; a failed 4-cell paste is logged only to the devtools console; typing three records quickly into the add-record input drops two of them (`POST /canonical` aborted in flight); the grid-layout PATCH fires on unmount and is routinely killed by navigation (`ERR_ABORTED`), so hide/resize done before leaving are lost. For a governed-reference-data product, silent data loss is the single biggest trust breaker after performance.
5. **The grid's feature set is in better shape than expected** — fill handle, undo transactions, copy/paste coercion, conditional formatting, mode strip all finished and tested. The gaps are dead/half-wired items (density prop no host passes, `/` shortcut that swallows type-to-edit, permanently disabled "Duplicate", presence cursors misplaced across users) plus craft debt (numbers left-aligned with dead Sum/Avg aggregates, two incoherent menu systems, vocabulary leaks like "5,295 raw" and "next position: 6144"). Per `ROADMAP.md:112`, Airtable-parity is an explicit anti-goal; the highest-value additions are product-specific (publish-diff row markers, search across all fields). Boot loads everything for every table (`full=true`, 695KB, `store.ts:361`) plus an N+1 drafts fetch (`store.ts:403`) — the next ceiling after virtualization.

## 2. Measured baseline

Method: Playwright 1.60 headless Chromium against the running dev app, dev-login session; synthetic rows injected by intercepting the `dimensions?full=true` response (real DB untouched; all non-GET API calls blocked). Wheel = 4s of continuous wheel events over the grid; arrow-hold = 3s of held ArrowDown; type = keydown→paint (double-rAF). Machine: M-series Mac, dev build — treat absolute numbers as relative indicators.

| Scenario | Boot→rows | Heap | DOM nodes | Mounted rows | Wheel FPS | Longest task | ArrowDown FPS | Keystroke→paint |
|---|---|---|---|---|---|---|---|---|
| brand real, 5.3k rows | 4.8s | 257MB | 61,376 | all | 37* | 702ms | **1** | 545–1,286ms |
| synthetic 1k | 1.8s | 45MB | 11,888 | all | 56* | 115ms | 10 | 85–264ms |
| synthetic 10k | 9.1s | 561MB | 116,276 | 9,672 | **0.4** | 2,729ms | **1** | 916–1,636ms |
| synthetic 50k | **never rendered** (>45s, screenshots timed out) | — | — | — | — | — | — | — |
| **10k after 1-line fix** | ~same† | — | **478** | **22** | **55.6** | 119ms | — | — |

\* First-run wheel numbers at 5k/1k are inflated: the gesture pointer landed off-viewport (an artifact of the overgrown container). The corrected 10k measurement is the honest pre-fix number: 0.4 FPS.
† Post-fix boot at 10k didn't improve in this session, but the box was under load from parallel audit agents; boot attribution needs a clean re-measurement (Phase 0 item 5). Pre-fix, boot clearly scaled with row count (1.8s → 4.8s → 9.1s → hang).

DOM math: ~11.6 nodes per row (row div + row number + checkbox + ~5 cells × ~2 nodes). At 5.3k rows that is 61k nodes in one 37,000px-tall scrolling layer — versus ~480 nodes with working virtualization. Airtable/Glide render only the viewport (canvas or ~1–2k DOM nodes) regardless of row count.

Confirmed root causes, in order of impact:

1. **Height-chain break** — `TablePane.tsx:739` (`<div>` with no classes; flex child defaults to `min-height:auto`). Probed chain: `.zz-grid-scroll` clientHeight 36,759 = scrollHeight (canScroll false); the unclassed div is the first unconstrained ancestor. Wheel input scrolls `main.zz-canvas` instead (verified scrollTop 300 there, 0 on the grid). Regression from `36e743f`, 2026-06-05.
2. **Everything downstream of (1)**: sticky header/pinned column no-ops; `RangeOutline`/`FillHandle` scroll listeners attached to an element that never scrolls; virtualizer spacer math irrelevant.
3. **Boot payload + N+1** — `store.ts:361` (`full=true` all tables, all rows) and `store.ts:403` (per-table `/drafts`). 695KB + 20 requests on today's small workspace.
4. **5s row-activity poll** (`use-row-activity.ts:14,33`) re-renders the pane every 5s; pre-fix that meant multi-second long tasks at rest on big tables. Roadmap item #53 (push over the presence websocket) already covers the right fix.
5. Scroll-path per-cell work that matters only at scale and post-fix is minor: per-cell `onMouseEnter`→`applyColumnHover` double `querySelectorAll` sweep (`DataGrid.tsx:544-560`, fires as rows move under a stationary pointer), `transition-colors` + hover background on every row (`DataGridRow.tsx:337-338`), O(cols²) `isFirstPinned` recompute per row render (`DataGridRow.tsx:379`).

### Architecture verdict

**Keep the hand-rolled DOM grid.** Rejected alternatives:

- *Canvas body (Glide-style)*: unnecessary — post-fix the DOM grid hits ~56 FPS at 10k×3 on a dev build; the product's tables are governed lists (hundreds to low thousands of rows), not 100k-row analytics sets. Canvas would also force rebuilding contentEditable editors, linked-field popovers, presence overlays, and conditional formatting as overlay systems — the grid's actual differentiators.
- *Adopt TanStack Table / AG Grid*: the hard parts already work (undo transactions, typed editors, fill handle, coercing paste). A library migration is weeks of risk to reacquire what exists.

Follow-ups that stay within the current architecture: none required for the perf budget. Column virtualization is explicitly **not** needed at ≤30 columns once rows virtualize (measure first if a 50+ column use case appears).

### Performance budget (Phase 0 exit criteria)

Measured on the dev build with the audit harness (`scratchpad/harness.js` pattern — re-create from `docs/grid-audit-prompt.md` Track A):

- 55+ FPS sustained wheel scroll at 10k rows × 30 columns; no long task >200ms during scroll.
- ≤60 mounted row elements regardless of row count; DOM total in the grid <5k nodes at 30 columns.
- Keystroke→paint <50ms; ArrowDown held ≥30 FPS with cursor tracking.
- 50k×30 renders and scrolls (degraded to 30 FPS acceptable); today it hangs the tab.
- Boot→interactive with the real brand table (5.3k rows) <1.5s warm dev server.
- Deep link `?open=a,brand&active=brand` opens both tabs with brand active on a cold profile, every time.

## 3. Phase 0 — performance foundation (do first, ~days not weeks)

| # | Item | Evidence | Change | Success criterion | Effort |
|---|---|---|---|---|---|
| 0.1 | Fix the height chain | §2.1; verified 0.4→55.6 FPS | Add `flex flex-1 flex-col min-h-0` to `RecordsBody`'s root div (`TablePane.tsx:739`) | Budget rows 1–3 pass; `.zz-grid-scroll` scrollHeight > clientHeight on brand | **XS** |
| 0.2 | Regression-proof it | This broke silently for 5 weeks | Add a test asserting mounted `[data-row]` count stays ~viewport-sized with 1k rows (jsdom + fixed container height, or a Playwright smoke); alternatively assert the scroll container is the scrolling element | Test fails on the bare-`<div>` regression | S |
| 0.3 | Fix deep-link fold | §1.3; harness reproduced 100% on cold profiles | Make the URL fold wait for dims to load (run the fold effect when `dims.length > 0` or gate on `useStoreLoading()`), keep mount-only semantics per fold | Budget row 6 | S |
| 0.4 | Sticky-region verification | Sticky header/pin are no-ops today | After 0.1, verify sticky header + pinned column actually hold during grid scroll; add scrolled-under shadow (`--shadow` token) | Header visible at scrollTop 10k; visual check both themes | S |
| 0.5 | Boot attribution + N+1 | §2 boot column; `store.ts:361,403` | Re-measure boot cleanly post-0.1. Collapse per-table `/drafts` into the `full=true` payload or a single batch endpoint. Defer per-table row payloads until a table is opened if boot >1.5s target still misses | Budget row 5; one request replaces 20 | M |
| 0.6 | Scroll-path hygiene | §2.5 | Only after 0.1, re-profile; if hover work shows up: gate `applyColumnHover` during scroll (or move to CSS `:has()`), drop `transition-colors` from rows, hoist first-pinned index computation out of the per-cell loop | No long task >200ms during scroll at 10k×30 | S |
| 0.7 | Activity poll → push | §2.4; already roadmapped as #53 | Ship #53 as planned (websocket hint instead of 5s poll) | No periodic re-render at rest | M (planned) |

## 4. Phase 1 — reliability & craft

From the browser walkthrough (9 journeys, 110 screenshots in the audit scratchpad, prefix `craft-`), plus code-confirmed items. Ordered by severity. Perf-rooted defects (frozen sort, 7fps scroll, non-sticky header, scroll-bottom dead zone) are excluded here — they are Phase 0.1's one-line fix wearing different hats and must be re-checked after it.

### Breaks-trust (fix before any feature work)

| # | Item | Observed | Where |
|---|---|---|---|
| 1.1 | Silent save failures + lying "Saved" pill | Failed PUT reverts the cell with no toast/retry; status pill stays green "Saved"; failed multi-cell paste only `console.error`s (`craft-j9-01/02`, `craft-j4-11`) | `store.ts` write path (~`apiInner`, :328); paste catch in `DataGrid.tsx`. Add error surface + retry; make the pill reflect failures |
| 1.2 | Rapid record adds dropped | 3 quick Enter submissions → 1 record created; in-flight `POST /canonical` aborted, no error, text lost (`craft-j3-12`) | Add-record form `TablePane.tsx:~1454` + store POST. Queue or disable-while-pending with optimistic row |
| 1.3 | Grid-layout persistence racy | `PATCH /grid-layout/<dim>` fired at unmount, killed by navigation (`ERR_ABORTED`); hidden column reappeared next session | Layout save in `store.ts`. Save on change (debounced) or `keepalive: true` |
| 1.4 | Deep links dropped | See §1.3 / Phase 0.3 — also reproduced here (`?open=brand&active=brand` → `?open=a&active=a`) | `MasterTables.tsx:35-68` |
| 1.5 | Zero-result search shows "no records yet — import from a source above, or add one below" | Searching 5,267 records for garbage implies the data is gone; meta still says "5267 records" (`craft-j6-21`) | Records empty-state branch. Split "empty table" from "no matches" + one-click clear |
| 1.6 | Number fields accept garbage silently | `abc` and `1234567.89` committed visually into an Integer field, then vanished on reload (`craft-j3-23`, `craft-j4-00`) | `NumberCell.tsx` editor (no filtering) + server coercion. Validate live, reject with feedback |
| 1.7 | Tables can be created but never deleted | No UI affordance; `DELETE /api/dimensions/:id` has no route. Every experiment permanently pollutes the workspace | `server/src/server.ts` (only PATCH exists), `tables.ts` create-only. Decide: delete (with confirm + retire semantics) or archive |
| 1.8 | Presence cursors on wrong rows across users | Published as positional indices into the sender's sorted/filtered rows (`DataGrid.tsx:526-532`), resolved against the receiver's ordering (`:1505-1523`) | Publish `{rowKey, field}` instead; resolve via existing `[data-cell]` machinery |
| 1.9 | Keyboard focus trapped in grid; active cell invisible to AT | 12 Tabs never leave the grid; no `aria-activedescendant`, so screen readers get nothing as the cursor moves. (Rows do have `aria-rowindex` — `DataGridRow.tsx:335` — and the container has `aria-rowcount/colcount`, `DataGrid.tsx:1402-1403`; the gap is active-cell exposure and an escape hatch) | `DataGrid.tsx` grid container, `useGridCursor.ts`. Add `aria-activedescendant` + Escape-then-Tab exit |

### Feels-cheap

| # | Item | Observed | Where |
|---|---|---|---|
| 1.10 | Vocabulary leaks in first-class UI | "5,295 **raw**" in every table meta line (`TablePane.tsx:764`); "**master record**" (`settings/Warehouse.tsx:181`); "next position: 6144" dev counter shown to all users; "pick survivor…" merge copy; "new a record…" grammar (`TablePane.tsx:1454` interpolates the table name blindly) | Copy sweep against the CLAUDE.md banned list; gate internals behind engineer mode |
| 1.11 | Numbers left-aligned, unformatted; Sum/Avg dead | Renderer puts `text-right tabular-nums` on an inline span that shrinks to content (`NumberCell.tsx:98`); values stored as strings so `useAggregates.ts:50` (`typeof v === "number"`) never sums — "Sum: – Avg: –" over three cells of 100 (`craft-j4-09`) | Align at the cell, format ("4,543"), coerce numeric fields to numbers end-to-end |
| 1.12 | Type-to-edit appends and eats the first keystroke | Selected "First Record", typed "Renamed" → "First Recordenamed" (`craft-j3-14`); header rename doesn't select-all → "StatusStage" (`craft-j5-16`) | Type-to-edit should replace, first keystroke included (Excel/Airtable convention). `useGridCursor.ts` / `DataGridHeader.tsx` |
| 1.13 | Copy has zero feedback | ⌘C on a range: no flash, no "Copied" (`craft-j4-04`) | Brief range flash + toast |
| 1.14 | Two incoherent menu systems | Column menu: mono lowercase w/ icons (one item wraps, misaligned icon `craft-j5-11`); context menu: sans Title Case, no icons/shortcut hints (`craft-j7-07`); filter popover lowercase "apply"; "Create field" button reads disabled when enabled | Pick one menu spec (casing, icons, ⌘ hints) and apply everywhere |
| 1.15 | Pinned "Record" and key columns have no header menu | `menuBtn: false` — can't sort/filter the primary columns from the header; sorting brand by name is impossible from the grid | `DataGridHeader.tsx:374` `!c.pinnedLeft` gate |
| 1.16 | Truncated cells have no hover reveal | Ellipsized values lack `title`/tooltip; headers DO have a hover-expand (`DataGridHeader.tsx:512-537`) — inconsistent | Add title attr or expand-on-hover for cells |
| 1.17 | React warnings during ordinary use | "Cannot update RecordsBody while rendering DataGrid" on every column resize/reorder; duplicate `Review` key in palette (matches duplicate "REVIEW" section, `craft-j7-03`) | `DataGridHeader.tsx` resize/drag state; `ShortcutsOverlay.tsx:25,53`; `CommandPalette.tsx` |
| 1.18 | Create-table modal hangs >10s; add-field ~3.4s, no progress | Table existed long before the modal released; synchronous warehouse DDL (`craft-j3-04`) | `CreateTableModal.tsx`, `AddFieldPopover.tsx`, `server/src/tables.ts`. Optimistic close + background provisioning state |
| 1.19 | Rename banner shifts layout, gridlines paint through it | Confirmation banner inserts in document flow above the grid (`craft-j3-17`) | Overlay toast instead of flow element |
| 1.20 | First-paint fade-in settles ~8px | Visible on every cold open (`craft-j1-02/03`) | Reserve heights in the skeleton |
| 1.21 | `/` shortcut dead and harmful; shortcuts overlay drift; forever-disabled "Duplicate" | `useGridCursor.ts:369-378` preventDefaults `/` for a callback no host passes (blocks typing a leading `/`); overlay advertises it (`ShortcutsOverlay.tsx:21`); `DataGrid.tsx:976-980` "Duplicate" gated on unimplemented `onDuplicateRow` | Wire `/` to search (Phase 2.1), sync overlay, remove or implement Duplicate |

### Nice-to-have

Dark theme is the more finished one yet light is the default (tokens are dark-first; consider honoring `prefers-color-scheme`). `--ink-3` on dark ≈ 3.9:1 at 11-12px (below AA). Fill handle nearly invisible (6px, no cursor change). Column drag needs an undiscoverable 350ms hold (`DataGridHeader.tsx:254-321`) — add a ghost + shorter threshold. Select-options color swatches clip at popover edge; dropdown options lack the chips the builder shows. "changed only · 3" chip reads stale next to "0 records". `Undo (Records)` scope label cryptic. Empty-table state could carry Add record / Import CSV buttons.

**Calibration — already genuinely good:** date editor (calendar + Today/Clear), remove-records confirm copy, sort-applied banner with Restore, ⌘K palette feel, styled scrollbars (no native leak), presence/activity badges, "Filter to value" context item, select combo's "search or create…".

## 5. Phase 2 — features (strategy: deepen the product's job, not Airtable parity)

The product job (CONTEXT.md): turn messy source values into governed reference tables that dbt consumes; the grid serves list maintenance, mapping, and publish legibility. `ROADMAP.md:112` names the Airtable-like surface an explicit anti-goal.

**In (ordered):**

| # | Feature | User problem | Effort | Notes |
|---|---|---|---|---|
| 2.1 | Search across all visible fields + wire `/` and Cmd+F | Quick search matches label only (`TablePane.tsx:74`, `DataGrid.tsx:265-273`) — "find 4543 in rank" fails silently | S | Fixes 1.d at the same time. Copy stays "Search records…" |
| 2.2 | "Changes with next publish" row markers | The publish lifecycle computes `changedKeys` (`TablePane.tsx:440,781-794`) but rows don't show which will publish unless the filter is toggled | S/M | Use the existing staged-workflow token (DESIGN.md:68-76). Fits the current `publish-lifecycle` branch |
| 2.3 | "Map values to this record" context-menu handoff | Records→Match round-trip is manual; URL machinery already carries `?mode=match&value=` (`MasterTables.tsx:104-136`) | S | Near-zero new UI |
| 2.4 | Persist the filter set per table | Filters are session state (`DataGrid.tsx:218`) while sort/widths/hidden persist via `GridLayoutConfig` — a weekly "records missing region" check rebuilds its filter every visit | S | Cheaper than saved views; covers most of that need |

**Later:** record detail panel in Records mode reusing `renderRowDetail` (proven in Match mode, `MatchModeBody.tsx:517`) listing mapped source values with "Move to another record…" — wait for publish lifecycle to land. Bulk "Set value…" on a range (paste-fill already covers it; add when asked). Numeric/date filter operators (filter bar is string-only, `FilterBar.tsx:14-27`, inconsistent with conditional formatting's `between`).

**Out, deliberately:** grouping, saved views, multi-column sort, footer summaries, per-row height/wrap, frozen right columns, export-selection (⌘C already yields spreadsheet-pasteable TSV; whole-table CSV + Parquet snapshot exist), inline ghost add-row (persistent add-record input exists). Each is Airtable-surface against ROADMAP.md:112, or already covered. Row drag-reorder, column type conversion, and Cmd+K palette **already exist** — no work needed.

**Freeze (keep, invest nothing):** conditional formatting, status bar, mode strip — finished, tested, earning their keep.

## 6. Kill list

1. `density` prop + both branches (`types.ts:168-169`, `DataGrid.tsx:189-190,483`) — zero call sites pass it; a feature flag without a feature.
2. Dead `onFocusFilter`/`onShortcuts` params in `useGridCursor` (`useGridCursor.ts:76-77,369-378,409-410`) — superseded by 2.1, or delete outright.
3. Stale ShortcutsOverlay rows (`ShortcutsOverlay.tsx:21,25,53`) — with 1.e.
4. "Duplicate" context-menu item + `onDuplicateRow` prop (`DataGrid.tsx:976-980`, `types.ts:176`) — unless implemented per 1.f.
5. Legacy presence path `/ws/presence/:tableId` (`server/src/server.ts:1602-1604`) — its "one-release deprecation" (`presence-room.ts:2`) has elapsed.
6. Legacy `?dimId=` URL fold (`MasterTables.tsx:40-45`) — schedule removal alongside 0.3 so the fold rewrite doesn't fossilize it.

## 7. Verification plan

- **Phase 0**: re-run the harness scenarios (1k / 10k / 10k×30 / 50k×30 / brand-real) against the budget table in §2; every row must pass. Add the 0.2 regression test to CI. Cold-profile deep-link check in a fresh browser context.
- **Phase 1**: re-walk the seven Track B journeys and re-score; every breaks-trust item closed, feels-cheap items closed or explicitly deferred with reasons.
- **Phase 2**: each feature ships with its journey scripted (search hits non-label fields; publish markers match the changed-only filter's row set; handoff lands in Match mode with the value preselected; filters survive reload).
- Vocabulary sweep: grep user-facing strings for the CLAUDE.md banned list (canonical, raw, triage, master, golden, commit, sync, tenant, matching) as part of Phase 1 sign-off.

## Audit side-effects

- The craft walkthrough created a scratch table **`audit_scratch`** (3 fields, 0 records — all test records were removed via the UI). It **cannot be removed** because the product has no delete-table UI or API route (defect 1.7); the shell plus its warehouse table `zugzug.dim_audit_scratch` remain, sidebar count 20 → 21. Delete it manually once 1.7 ships, or drop it at the DB level.
- No records in brand or any pre-existing table were edited. Brand was sorted and restored (layout-level only). Perf measurements used synthetic rows injected at the network layer; all non-GET API calls were blocked during those runs.
- ~110 walkthrough screenshots (`craft-*.png`) and the harness/probe scripts live in the session scratchpad; they are temporary — copy anything worth keeping before the session ends.

## Honest caveats

- All numbers are dev-build, single machine, headless Chromium; ratios are trustworthy, absolutes will differ in production builds (likely better).
- Post-fix boot time was measured under background load and is inconclusive — re-measure before deciding how far to take 0.5.
- The 5k/1k pre-fix wheel FPS numbers overstate smoothness (pointer artifact, noted in §2); the 10k pre/post pair is the controlled comparison.
- Column virtualization was *not* needed to hit 55 FPS at 30 columns in the post-fix probe at 3 columns; re-verify at 30 columns during Phase 0 before closing 0.6.
