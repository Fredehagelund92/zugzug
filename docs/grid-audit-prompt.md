# Grid Excellence Audit — Planning Prompt

You are auditing the data grid in Zugzug and producing a plan to take it from
"works" to the interaction quality of Airtable's grid, with the restraint and
speed of Linear and the visual polish of Vercel's dashboard. **This is a
planning task, not an implementation task.** Do not change any product code.
Your deliverable is a single document: `docs/grid-next-level-plan.md`.

The dev server runs at http://localhost:5173. The page under audit is
`/app/default/tables?open=a%2Cbrand&active=brand`.

## Verified architecture (as of 2026-07-12 — trust but re-verify line numbers)

- React 18 + React Router 6 + Vite 6 + Tailwind v4. No component library;
  custom token-driven design system (`tokens.css`, `app-kit.css`, `globals.css`).
- The grid is **hand-rolled** (no TanStack Table / AG Grid / Glide), in
  `app/src/components/datagrid/`:
  - `DataGrid.tsx` (~1573 LOC) — orchestrator: sort, filter, ranges, copy/paste, undo, fill handle
  - `DataGridBody.tsx` — row virtualization via `@tanstack/react-virtual` (constant `estimateSize`, overscan 5)
  - `DataGridRow.tsx` — memoized row, one memoized `GridCell` per column
  - `DataGridHeader.tsx` — column menu, drag-reorder, resize
  - `useGridCursor.ts` — keyboard navigation
  - `UndoStack.tsx` — per-tab undo/redo
- **No column virtualization.** All visible columns render for every virtualized row.
- **All rows load into memory at app boot** (`useDimensions` / `initStore`);
  no pagination, no lazy loading, sort/filter run in-memory in `DataGrid.tsx`.
- Shell: `routes/MasterTables.tsx` (tab URL contract `?open=...&active=...`),
  `TablePane.tsx`, `TableTabStrip.tsx`, `lib/open-tabs.tsx`. Inactive tab panes
  stay mounted, hidden with CSS.
- Existing features: cell editing (contentEditable + 9 typed editors), keyboard
  nav, range selection + fill handle, column resize/reorder/hide, single-column
  sort, filter bar (8 operators, AND/OR), sticky header + pinned-left columns,
  undo/redo, copy/paste (TSV), context menus, conditional formatting, activity
  badges, presence overlays, linked fields, density toggle, status bar
  (count/sum/avg), mode strip (records / match / wired-sources).
- Not implemented: grouping, saved views, multi-sort, per-row height, search
  within table, row detail panel, server-side sort/filter.

## Ground rules

1. **Measure, don't guess.** Every performance claim needs a trace, a number,
   or a DOM count. Every craft claim needs a specific observed behavior.
2. Cite `file:line` for every code-level finding.
3. Every recommendation gets a **verifiable success criterion** (a number or a
   pass/fail check), an effort estimate (S/M/L), and its dependencies.
4. Distinguish "confirmed by measurement" from "hypothesis" explicitly.
5. Any proposed UI copy must follow the CLAUDE.md Language rules (plain words:
   "table", "record", "mapping", "publish"; never "canonical", "sync", "triage").

---

## Track A — Performance diagnosis (scrolling is reported extremely slow with many rows)

1. **Build a stress dataset.** Find or seed a table with enough data to hurt:
   test at ~1k, ~10k, and ~50k rows, and separately at 30+ columns. Look at how
   the API/store seeds data (`/api/t/<slug>/dimensions`, `initStore`) and
   create test data if none exists. Document how you seeded it so runs are
   reproducible.
2. **Profile real scrolling** in the running app (Chrome DevTools Performance
   panel and/or Playwright + CDP tracing). Capture three gestures: wheel
   scroll, scrollbar drag, and holding ArrowDown / PageDown. Record per run:
   average FPS, longest task, scripting vs rendering vs painting breakdown,
   and INP for cell click → focused and keystroke → painted character.
3. **Count the DOM.** Nodes per cell × columns × rendered rows. State the math
   and compare against what Airtable/Glide render for the same viewport.
4. **Confirm or refute each suspect** (from a prior code read — verify against
   current code):
   - No column virtualization: cost per row render at 30+ columns.
   - Constant `estimateSize` in `DataGridBody.tsx` and overscan choice.
   - `GridCell` custom `areEqual` cost when scrolling recycles rows.
   - Per-cell borders (`border-r border-line`) and sticky pinned columns:
     paint/compositing cost (check layers panel).
   - `RangeOutline` re-measuring via `getBoundingClientRect` on scroll
     (`DataGrid.tsx` ~71–102) — rAF-coalesced, but does it fire during plain scroll?
   - `applyColumnHover` `querySelectorAll` DOM mutation on hover (`DataGrid.tsx` ~556).
   - In-memory `sortedRows` recompute (`DataGrid.tsx` ~275) — does it run during
     scroll or only on sort change?
   - Hidden-but-mounted tab panes: do inactive panes' virtualizers or listeners
     do work during scroll of the active pane?
   - Boot-time full fetch: initial load time and memory at 50k rows.
5. **Architecture verdict.** Given the measurements, recommend exactly one path
   with tradeoffs, and reject the others explicitly:
   (a) fix the current DOM grid (column virtualization, cheaper cells, fewer
   nodes), (b) move the body to canvas (Glide Data Grid style) keeping the
   existing editors as overlays, or (c) adopt a grid library. Consider that the
   grid's differentiators (linked fields, presence, conditional formatting,
   undo transactions) must survive the choice.
6. Set the **performance budget** the plan must hit, e.g.: 60fps sustained
   scroll at 50k rows × 30 columns, keystroke-to-paint < 50ms, cell focus
   INP < 100ms, tab switch < 100ms, boot-to-interactive with 50k rows < 2s.
   Adjust with justification if measurements say otherwise.

## Track B — Craft and feel audit ("does it feel vibe-coded?")

Benchmark against: **Airtable** (grid interactions: editing, fill, selection),
**Linear** (keyboard-first flow, latency, visual restraint), **Notion**
databases (inline editing feel), **Vercel** dashboard (typography, spacing,
dark-theme polish). Use the running app side-by-side with your knowledge of
these products.

Walk these journeys end-to-end in the browser and score each step:

1. Open the app cold → find a table → open it (loading states, skeletons, layout shift).
2. Scan a large table (scroll feel, sticky behavior, where the eye lands).
3. Edit: click a cell, type, Enter, Escape, Tab across a row, edit a select, a
   date, a linked field (enter/exit transitions, caret placement,
   contentEditable artifacts, save feedback).
4. Multi-edit: range select, fill handle, copy/paste, undo (visual feedback at
   every step — does copy confirm? does paste show what changed?).
5. Structure: add a column, rename, resize, reorder, hide, pin (affordances,
   drag feel, drop indicators).
6. Filter and sort (discoverability, applied-state visibility, clearing).
7. Keyboard-only session: can a power user do everything without the mouse?
   Is there a shortcut reference? A command palette?

For each journey, audit against this checklist and log concrete failures:

- **Latency**: every interaction < 100ms perceived; anything animated is < 200ms
  and interruptible.
- **State styling**: hover / active / focused / selected / disabled are
  distinct, consistent across cells, headers, menus, and tabs.
- **Details that expose "fast app" builds**: default browser scrollbars, native
  focus rings leaking through, contentEditable spellcheck squiggles or paste
  artifacts, text selection where it shouldn't be possible, cursor styles,
  layout shift on hover (borders appearing), popovers clipping at viewport
  edges, misaligned baselines, mixed icon sizes, inconsistent paddings between
  sibling components, mixed border treatments.
- **Typography**: numbers right-aligned with tabular figures? Header casing
  consistent? Truncation with ellipsis + full value on hover?
- **Empty / error / loading**: empty table, no results after filter, failed
  save, offline — designed or accidental?
- **Motion**: what animates today, what should (subtle enter for menus, none
  for scroll-critical paths), what shouldn't.
- **Sticky-region shadows/elevation** when content scrolls under header or
  pinned columns.
- **Accessibility**: visible focus, aria grid semantics, contrast on `--ink-3`
  text over `--surface`, screen-reader announcement of cell position/value.

Output for Track B: a numbered defect list (severity: breaks-trust / feels-cheap /
nice-to-have), each with the observed behavior, the benchmark behavior
(what Airtable/Linear does), and the file(s) involved.

## Track C — Feature strategy (add, polish, or kill)

1. **Audit what exists.** For every current feature (list above), verdict:
   *keep as-is*, *polish* (what specifically), or *candidate to cut*. Look
   especially hard at: presence overlays, activity badges, conditional
   formatting, the three-mode strip (records / match / wired-sources), and the
   density toggle — are they finished, discoverable, and earning their
   complexity? Check git history and the store for signs a feature is
   half-wired or unused.
2. **Gap analysis vs Airtable-class grids.** Evaluate each of these for fit
   with Zugzug's actual job (reference-data / mapping workspace — not a
   general-purpose Airtable clone; simplicity is the product ethos). Recommend
   in / out / later, with the user problem it solves:
   grouping by column; saved views (filter+sort+layout presets); multi-column
   sort; search within table (Cmd+F scoped to grid); row detail / record panel
   (expand a row); per-column summaries in footer; row drag-reorder; per-row
   height / wrap text; inline "add row" at bottom of grid; bulk edit via
   selection; column type conversion flow; command palette (Cmd+K); frozen
   right columns; export selection (CSV); keyboard shortcut overlay upgrade.
3. Anything you propose must not fight the perf plan from Track A — flag
   features that get harder under a canvas rewrite (e.g. presence overlays).

## Deliverable: `docs/grid-next-level-plan.md`

Structure it as:

1. **Executive summary** — the 5 findings that matter most, in plain language.
2. **Measured baseline** — the performance numbers table (row counts × gestures
   × metrics), DOM math, and confirmed root causes for slow scrolling.
3. **Architecture decision** — the chosen path from Track A.5 with tradeoffs.
4. **Phase 0: performance foundation** — ordered work items, each with
   evidence, change, success criterion, effort.
5. **Phase 1: craft** — the defect list from Track B turned into work items,
   ordered by severity.
6. **Phase 2: features** — additions from Track C, ordered by value/effort.
7. **Kill list** — features or code to remove, with justification.
8. **Verification plan** — how each phase is signed off (perf traces re-run
   against the budget, journey walkthroughs re-scored).

Keep the plan honest: if a suspect didn't reproduce, say so; if the grid is
actually fine at 10k rows and the problem is boot fetch, say that instead.
