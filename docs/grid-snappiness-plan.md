# Grid Snappiness Plan — "Does it feel like a spreadsheet?"

_Audit date: 2026-07-17. Page under test: `/app/default/tables?open=a%2Cbrand&active=brand`
(Brand table, 5267 records). Method: headless Chrome driven with Playwright at
1600×1000, keyboard-only, timings from a double-rAF keydown→paint probe, a
`longtask` PerformanceObserver, and `aria-activedescendant`/`focusin` mutation
watchers. Every number below is measured, not estimated. Scripts and raw JSON in
the session scratchpad._

## 1. Verdict

The grid's **render engine is genuinely fast** — every keystroke-to-paint,
focus, and commit measurement beats its latency budget with a wide margin, at 60
FPS, with zero long tasks. If snappiness were only about frame timing, this grid
would pass.

But it does **not** feel like a spreadsheet, and it breaks the illusion almost
immediately, for three reasons that have nothing to do with frame rate:

1. **You cannot scroll to your data.** On the 5267-row Brand table the scroll
   container is only ~880px tall — about 33 rows. Mouse wheel, dragging the
   scrollbar, `⌘↓`, `⌘End`, and holding `↓` all stop at row ~33. The other ~5234
   records are unreachable. The virtualizer _does_ reserve the correct height
   (a 199 272px spacer), but that spacer sits inside a `flex flex-col` scroll
   container and `flex-shrink` crushes it to 0px. This is the single most
   important defect: a table you can't scroll can't feel like a spreadsheet at
   any frame rate.
2. **Typing on a cell does nothing.** The most basic spreadsheet reflex — land
   on a cell, type, and the cell starts replacing — is disabled on this table.
   You must press Enter first, and even then the editor appends rather than
   replaces.
3. **Pressing Escape kills the keyboard.** After you cancel an edit, DOM focus
   falls to `<body>`; the cursor outline still shows, but arrows, undo, and
   typing are all dead until you physically click back into the grid.

The fast hot-path numbers are real but partly illusory: the grid renders 60 FPS
because it only ever renders ~28 rows — it is fast because it is showing almost
none of the data. **Fix the scroll-height collapse first; nothing else about
"spreadsheet feel" matters until a user can move through the table.**

## 2. Measured baseline

### Hot-path latency (Brand, 5267 rows, within the reachable window)

| Metric | Budget | p50 | p90 | max | Verdict |
|---|---|---|---|---|---|
| Keystroke → painted char (typing in editor, n=30) | <50ms (target <32) | 21.0 | 28.1 | 31.5 | **PASS** |
| Keystroke → painted char (sustained 12s nav, n=540) | <50ms | 27.0 | 31.3 | 34.8 | **PASS** |
| Cell focus → ready-to-type (Enter→input focused, n=5) | <100ms | 7.9 | 9.0 | 9.0 | **PASS** |
| Commit → cursor on next cell (n=6) | <100ms | 11.0 | 15.8 | 15.8 | **PASS** |
| Commit → next editor focused & ready (n=6) | <100ms | 10.3 | 14.5 | 14.5 | **PASS** |
| Arrow keydown → paint (n=30) | <50ms | 24.4 | 34.3 | 34.8 | **PASS** |
| `⌘↓` jump keydown → paint | <50ms | — | — | 25.0 | **PASS** |
| Paste 3 cells → all cells painted | <100ms | — | — | 42.5 | **PASS** |
| Copy → "Copied" toast | — | — | — | 11.9 | **PASS** |
| Arrow-hold 3s | ≥30 FPS | — | — | 60.3 FPS (worst frame gap 17.7ms) | **PASS\*** |
| Long tasks ≥50ms on any hot path | 0 | — | — | 0 | **PASS** |

\* 60 FPS is real but only meaningful within the ~33 reachable rows (see D0).
There were **zero** dropped frames >50ms across a 12-second sustained
navigation, and **zero** `longtask` entries during any edit or nav run. The
5-second row-activity poll did **not** cause a single input stall.

### Prior findings (`docs/grid-next-level-plan.md`, 2026-07-12) — re-verified

| # | Prior finding | Status now | Evidence |
|---|---|---|---|
| a | Row-virtualization height-chain break in Records mode | **STILL BROKEN — worse than "crawl"** | Scroll caps at ~33 of 5267 rows. Not the line previously checked (`TablePane.tsx:828` is fine); the break is the flex spacer collapse — see D0. |
| b | Type-to-edit appends and eats the first keystroke | **Type-to-edit is now fully DISABLED on this table** | Typing `x` on a focused cell: keydown fires, `defaultPrevented=false`, no edit starts. Root: `DataGrid.tsx:521`. Append-on-Enter still reproduces on the record-name editor. |
| c | Silent save failures with a lying "Saved" pill | **No "Saved" pill exists; silent failure REPRODUCES** | Renaming any record whose name was never edited → server 404 → value silently reverts, no toast. Reproduced via UI and `curl` (5263/5267 rows). |
| d | Rapid record-adds dropped (in-flight POST aborted) | **Not re-tested this pass** | Can't safely add thousands of records to the live table; code path unchanged per source read. Carry forward. |
| e | Copy has zero feedback | **FIXED** | "Copied" toast fires in 11.9ms + cell flash. |
| f | `/` shortcut swallows type-to-edit | **Improved / moot** | `/` now focuses the record search (`TablePane.tsx`), correct behavior. No conflict observed (type-to-edit is off on these tables anyway). |

## 3. Defect list (grouped by pillar)

Severity: **breaks-the-flow** (stops a spreadsheet user cold) /
**feels-sluggish** (perceptible friction) / **nice-to-have**.

### Pillar 2 — Zero perceived latency  *(and the structural failure that hides behind it)*

**D0 — Scroll height collapses; only ~33 of 5267 rows are reachable.**
_Severity: breaks-the-flow (highest priority)._
_Status: ✅ **FIXED & VERIFIED** on branch `fix/grid-scroll-height-collapse` —
`shrink-0` added to both spacer divs. After fix: `scrollHeight` 879 → 200 151px;
last record "ZOS" (row 5267) reachable by wheel/scrollbar/`⌘↓` with the cursor
rendered and in view; rows stay 37px (no squish); header still sticky; arrow-hold
re-measured at 60.2 FPS with the cursor genuinely traversing hundreds of rows,
zero frame gaps >50ms, zero long tasks; typecheck/eslint/prettier clean._
- **Observed:** On Brand, `grid.scrollHeight` = 879px with `clientHeight` 667px.
  Mouse wheel ×40, `element.scrollTop = 200000`, and 120× `↓` all cap at
  `scrollTop` ≈ 396 (row 33, "BildBet"). `⌘End` reports "at bottom" while
  showing row 33; the cursor's `aria-activedescendant` jumps to the true last
  row ("zos") but that cell is never rendered (`cursorRendered:false`).
- **Root cause:** `DataGridBody` uses padding-spacer virtualization —
  `<div style={{height: topPad}} />` … rows … `<div style={{height: bottomPad}} />`
  (`DataGridBody.tsx:134` and `:184`). Those spacers are direct children of the
  scroll container `<div role="grid" class="… flex flex-1 flex-col …">`
  (`DataGrid.tsx:1452`). In a flex column, `flex-shrink:1` (default) shrinks the
  ~199 272px `bottomPad` spacer to ~0 because nearly all shrinkage is weighted
  onto the item with the largest flex-basis. The rows (basis ~37px) survive; the
  spacer is annihilated, so the scrollable area is only as tall as the rendered
  window.
- **Proven:** A live diagnostic edit setting `flex-shrink:0` on the spacer made
  `scrollHeight` jump 879 → **200 151px** immediately (edit reverted; React
  overwrites it on next render, which is why it must be fixed in source).
- **Expected:** The full row count is scrollable; the cursor is always brought
  into view on `⌘↓`/`⌘End`/arrow-past-viewport.
- **Success criterion:** On Brand, `scrollHeight ≥ rows × rowHeight` (~200 000px);
  `⌘End` renders and shows the last row ("zos"); dragging the scrollbar reaches
  the last record. Arrow-hold FPS re-measured with the cursor actually tracking.
- **`file:line`:** `DataGridBody.tsx:134,184`; `DataGrid.tsx:1452`.

Apart from D0, **Pillar 2 has no defects.** Keystroke→paint, focus, and commit
are all comfortably inside budget; no spinner, no stall, no dropped frames.

### Pillar 1 — Keyboard is the whole job

**D1 — Type-to-edit is disabled on manual-ordered tables.**
_Severity: breaks-the-flow._
- **Observed:** Focus a cell, press `x`. Nothing happens — keydown reaches the
  grid, `defaultPrevented=false`, no edit mode, cell text unchanged. Confirmed on
  both Brand and table A (both `orderingMode: "manual"`).
- **Root cause:** `typeToEdit: !props.onCellKeyDown` (`DataGrid.tsx:521`).
  Manual-ordered tables wire `onCellKeyDown` for the `⌘⇧`-arrow row-reorder
  feature (`TablePane.tsx:1498-1499`), which silently switches type-to-edit off
  for the _entire grid_. The reorder handler only acts on `⌘⇧`-arrows/`Home` and
  returns for everything else, so printable keys never actually conflict — the
  coupling is accidental.
- **Expected:** Typing a printable character replaces the cell and enters edit
  mode, first keystroke included (Excel/Sheets).
- **Success criterion:** Type `x` on a focused text cell → cell enters edit
  showing `x`; the reorder shortcut still works.
- **`file:line`:** `DataGrid.tsx:521`; `useGridCursor.ts:384`; `TablePane.tsx:1498`.

**D2 — No replace path even via Enter; the record-name editor appends.**
_Severity: breaks-the-flow (compounds D1)._
- **Observed:** Enter to edit the record name loads the full value with the
  caret at the end; typing appends (`"Acme Corp"` → type `Z` → `"Acme CorpZ"`).
  With D1 also disabling type-to-edit, there is **no fast way to replace a
  record name** — you must Enter, then manually select-all or backspace.
- **Expected:** Type-to-edit replaces; Enter/F2 edits in place (Excel). At least
  one of the two must give a clean replace.
- **Success criterion:** With D1 fixed, typing on the name cell replaces it. If
  Enter-to-edit is meant to select-all, first keystroke replaces.
- **`file:line`:** record-name editor (label column) in `DataGridRow.tsx` cell
  renderers; `useGridCursor.ts:361-364`.

**D3 — `Home` / `End` do nothing.** _Severity: breaks-the-flow._
- **Observed:** From `acme_corp::key`, `Home` and `End` leave the cursor
  unmoved. No handler exists (only `⌘Home`/`⌘End` are handled,
  `useGridCursor.ts:325-337`).
- **Expected:** `Home` → first column of the row, `End` → last column.
- **Success criterion:** `End` on any row moves the cursor to the rightmost
  cell; `Home` returns it to the first.

**D4 — `PageUp`/`PageDown` don't page the cursor.** _Severity: feels-sluggish._
- **Observed:** `PageDown` scrolls the container (`scrollTop` 0→323) but the
  cursor detaches (`focusedCellDataCell` becomes null); `PageUp` doesn't restore
  it. No cursor paging.
- **Expected:** Move the cursor one viewport and keep it visible.
- **Success criterion:** `PageDown` advances the cursor ~one screen and it stays
  rendered/visible. (Depends on D0.)

**D5 — `⌘D` fill-down is not implemented.** _Severity: feels-sluggish._
- **Observed:** Select a cell + the cell below, press `⌘D`; the lower cell keeps
  its own value (no fill). The prompt lists `⌘D` as expected spreadsheet
  behavior.
- **Success criterion:** `⌘D` fills the selection's top value down the range in
  one atomic undo step.

**D6 — `⌘X` (cut) is not implemented.** _Severity: nice-to-have._

**D7 (note, not a defect) — Enter/Tab auto-re-enter edit on the destination.**
`useGridCursor.ts:266-280` commits, moves, and re-opens the editor (Airtable
convention, intentional per code comment). It's the only reason a type-Enter run
"flows" today given D1. Re-evaluate once D1 lands: Excel's Enter just _moves_ and
lets type-to-edit replace, which is snappier for a fast down-column retype.

### Pillar 3 — No friction interrupts the flow

**D8 — Focus is orphaned to `<body>` after Escape (and any edit-exit).**
_Severity: breaks-the-flow._
- **Observed:** Click cell → Enter → Escape. `document.activeElement` = `<body>`.
  The cursor ring still shows (React cursor state persists) but `↓` doesn't move,
  `⌘Z` doesn't fire, typing does nothing — until you mouse-click back into the
  grid. Same after commit-then-Escape. There are **zero** `.focus()` calls in
  `datagrid/`, so nothing returns focus to the scroll container when the editor
  `<input>` unmounts.
- **Why it hides:** A pure type-Enter-type-Enter run stays alive because each
  Enter re-mounts an editor that grabs focus. Focus only orphans when edit mode
  fully _exits_ (Escape, or clicking elsewhere) — exactly when a user bails out
  of a typo.
- **Expected:** Exiting edit returns DOM focus to the grid so keyboard nav
  continues without the mouse.
- **Success criterion:** Click cell, Enter, Escape, `↓` → cursor moves down.
- **`file:line`:** `useGridCursor.ts:282-285` (Escape/stopEdit path) — needs to
  restore focus to `cursor.ref` after the editor unmounts.

**D9 — Failed record renames fail silently.** _Severity: feels-sluggish
(root cause may be data-seeding — verify)._
- **Observed:** Renaming a record whose name was never edited → `PUT
  …/canonical/:key` returns 404 "not found" → the optimistic value silently
  reverts, **no toast, no indicator**. Field-value edits (`…/canonical/:key/field/:field`)
  on the same rows succeed. Reproduced in the UI and directly:
  `curl -X PUT …/canonical/za_operator_native_adskeeper_ron_jackpotcity_android_cas_loc`
  → `404 {"code":"NOT_FOUND"}`, while `GET …?full=true` returns that very row.
- **Root cause:** `renameCanonical` (`store.ts:960-972`) reverts on catch but
  surfaces nothing to the user. Server-side, `bumpVersionOrThrow`
  (`repo-canonical.ts:120-147`) 404s when no `canonical_version` row exists;
  5263/5267 Brand rows have no version row (they default to `version:1` in the
  read path, `repo-canonical.ts:396`). This is likely a dev-seed gap rather than
  a production path — **flag for verification** — but the _client_ behavior
  (a core operation silently no-ops) is a real snappiness defect regardless.
- **Expected:** Either the rename succeeds, or a non-blocking error tells the
  user it didn't save; the cell must reflect true saved state.
- **Success criterion:** A rejected write shows a dismissible error and never
  leaves a stale optimistic value on screen.
- **`file:line`:** `store.ts:960-972`; `repo-canonical.ts:120-147,396`.

**No friction defects otherwise.** No save spinner on the edit path; the "Copied"
toast does not steal focus (arrow after copy still works); no confirm dialog on
single edits; no layout shift on commit; the 5s activity poll caused no stall
across 12s of sustained input. Paste is optimistic and lands in 42.5ms.

### Pillar 4 — Motion is predictable and reversible

**D10 — On off-screen jumps/extends the cursor & selection focus aren't scrolled
into view.** _Severity: feels-sluggish (largely a symptom of D0)._
- **Observed:** `⌘⇧↓` correctly extends the selection to the column edge — the
  Excel-style aggregation footer shows `Count: 5266` and rendered in-range cells
  get a pink highlight — but the viewport stays near the top and the focus end is
  never shown. `⌘End` behaves the same. Within-viewport selection **is** visible;
  the problem is the grid doesn't follow the focus. Expect this to resolve once
  D0 restores real scroll height, but verify `scrollToIndex` fires for the range
  focus, not just the cursor.
- **Success criterion:** After `⌘⇧↓`, the focus cell (bottom of the range) is
  scrolled into view and visibly marked.

**Undo/redo is solid.** Paste, `⌘D`-style fills, fill-handle drag, and
delete-range each collapse to **one** atomic `⌘Z`; redo (`⌘⇧Z`) restores them.
Verified: paste of 3 cells → single `⌘Z` reverts all three; fill-handle drag →
single `⌘Z`. The only caveat is D8 (undo is dead while focus is orphaned).

## 4. Fix plan (snappiness-first)

Ordered so the changes that most restore the fast-edit feel land first. Each
item: evidence → change → success criterion → effort.

1. **Restore scroll height (D0). ✅ DONE.** _Effort: S._
   Shipped on `fix/grid-scroll-height-collapse`: `shrink-0` on both spacer divs
   (`DataGridBody.tsx:134,184`) so the flex column can't crush them. Verified —
   `scrollHeight` 879 → 200 151px, all 5267 rows reachable, cursor tracks, 60 FPS,
   no squish. (A more thorough refactor to the standard TanStack sizer +
   absolutely-positioned rows remains optional; the 2-line fix is sufficient and
   is a no-op for any non-flex grid consumer.)

2. **Re-enable type-to-edit on manual tables (D1).** _Effort: S._
   Evidence: `typeToEdit: !props.onCellKeyDown` disables it whenever
   `onCellKeyDown` is wired. Change: decouple — make `typeToEdit` an explicit
   prop defaulting to `true`, independent of `onCellKeyDown` (the host handler
   already ignores printable keys). Success: type `x` on a cell → edit starts
   with `x`; `⌘⇧`-arrow reorder still works.

3. **Return focus to the grid when an edit exits (D8).** _Effort: S._
   Evidence: `activeElement` = `<body>` after Escape; nav dead. Change: after
   `stopEdit()` on Escape/blur, call `cursor.ref.current?.focus()` once the
   editor unmounts. Success: click → Enter → Escape → `↓` moves.

4. **Clean replace on the record-name editor (D2).** _Effort: S._
   Depends on #2. Ensure the name editor selects-all (or seeds) so the first
   keystroke replaces. Success: typing on a name cell replaces it.

5. **Surface failed writes; verify the rename 404 (D9).** _Effort: M._
   Evidence: silent 404 on 5263/5267 renames. First confirm whether missing
   `canonical_version` rows are a dev-seed gap or a real path (check how rows are
   created / whether `seedVersionRow` runs for imported rows). Then add a
   non-blocking error toast on write rejection so no edit fails invisibly.
   Success: a rejected rename shows an error and no stale value remains.

6. **Add the missing navigation keys: `Home`/`End`, real `PageUp`/`PageDown`
   cursor paging (D3, D4).** _Effort: M._ Depends on #1 for paging to be
   meaningful. Success: `Home`/`End` jump to row edges; `PageDown` advances ~one
   screen with the cursor visible.

7. **`⌘D` fill-down (D5).** _Effort: M._ Success: `⌘D` fills the top value down
   the selection in one undo step.

8. **Scroll the range focus into view after `⌘⇧`-arrow / `⌘End` (D10).**
   _Effort: S, after #1._ Success: focus end of an extended selection is visible.

9. **`⌘X` cut (D6).** _Effort: S. Nice-to-have._

10. **Re-evaluate Enter/Tab auto-re-enter-edit (D7).** _Effort: S._ After #2,
    decide whether Excel-style "Enter just moves" feels snappier for down-column
    retyping. No change if the team prefers the Airtable convention.

## 5. Keyboard reference (intended map vs. today)

| Key | Intended (spreadsheet) | Today | Status |
|---|---|---|---|
| `↑ ↓ ← →` | Move cursor one cell | Moves one cell | ✅ works |
| Printable char | Replace cell, enter edit (1st key kept) | Nothing (disabled on manual tables) | ❌ **D1** |
| `Enter` (not editing) | Enter edit | Enters edit | ✅ works |
| `Enter` (editing) | Commit + move down | Commit + move + re-open editor | ⚠️ Airtable convention (D7) |
| `Shift+Enter` (editing) | Commit + move up | Commit + move up + re-open | ⚠️ as above |
| `Tab` / `Shift+Tab` (editing) | Commit + move right/left | Commit + move + re-open | ⚠️ as above |
| `Tab` / `Shift+Tab` (not editing) | Move right/left | Moves right/left | ✅ works |
| `Escape` (editing) | Cancel, stay put, keep keyboard | Cancels **but orphans focus to `<body>`** | ❌ **D8** |
| `Home` / `End` | First / last column of row | Nothing | ❌ **D3** |
| `PageUp` / `PageDown` | Move cursor one viewport | Scrolls a bit, cursor detaches | ❌ **D4** |
| `⌘Home` / `⌘End` | Top-left / bottom-right | `⌘Home` ok; `⌘End` jumps logically but can't display (D0) | ⚠️ blocked by **D0** |
| `⌘←/→/↑/↓` | Jump to data edge | Logical jump; view can't follow past ~row 33 | ⚠️ blocked by **D0** |
| `Shift+Arrow` | Extend selection | Extends; aggregation footer shows | ✅ works |
| `⌘Shift+Arrow` | Extend to data edge | Extends; focus end off-screen | ⚠️ **D10** |
| `⌘D` | Fill down | Not implemented | ❌ **D5** |
| `⌘C` | Copy range | Copies + "Copied" toast (11.9ms) | ✅ works |
| `⌘V` | Paste | Optimistic, atomic (42.5ms) | ✅ works |
| `⌘X` | Cut | Not implemented | ❌ **D6** |
| `⌘Z` / `⌘⇧Z` | Undo / redo (atomic) | Atomic for paste/fill/delete; dead while focus orphaned | ⚠️ blocked by **D8** |
| `Delete` / `Backspace` | Clear cell/range | Clears range, one undo step | ✅ works |
| Fill handle (drag) | Fill range | Works, atomic undo | ✅ works |
| `⌘A` | Select all | Selects all | ✅ works |
| `/` | Focus record search | Focuses search | ✅ works |
| `F2` | Edit in place | Not implemented | ❌ missing (nice-to-have) |

---

_Bottom line: the grid is fast but not usable at scale. One S-effort CSS fix
(D0) unlocks scrolling to all rows; two more S-effort fixes (D1 type-to-edit,
D8 focus-return) restore the core type-and-move reflex. Those three, in that
order, do 80% of the work of making this feel like a spreadsheet._
