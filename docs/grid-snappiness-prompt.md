# Grid Snappiness Audit — "Does it feel like a spreadsheet?"

You are auditing the data grid in Zugzug for one thing only: **the felt speed of
doing work in it.** The goal is that a user editing this table feels like they
are flying through a spreadsheet — hands on the keyboard, edits landing the
instant they type, never waiting to think, never reaching for the mouse. This is
**not** a raw-FPS audit and **not** a visual-polish audit (those live in
`docs/grid-audit-prompt.md`). This is about *interaction latency, keyboard flow,
and friction* — the difference between "a web table you can edit" and "Excel."

**This is a planning/diagnosis task, not an implementation task.** Do not change
product code (a single diagnostic edit is fine if you measure it and revert it).
Your deliverable is one document: `docs/grid-snappiness-plan.md`.

The dev server runs at http://localhost:5173. The page under audit is
`/app/default/tables?open=a%2Cbrand&active=brand`.

## What "spreadsheet feel" actually means — the four pillars

Score the grid against each. Every finding must name the pillar it hurts.

1. **Keyboard is the whole job.** A power user can select, move, edit, commit,
   extend selection, jump to edges, fill down, copy, paste, and undo without
   ever touching the mouse. Arrow keys move the cursor; typing a character
   *replaces* the cell and enters edit mode (first keystroke included); Enter
   commits and moves down; Tab commits and moves right; Shift+Enter / Shift+Tab
   go back; Escape cancels without committing; ⌘/Ctrl+arrows jump to the edge of
   the data; Shift+arrows extend the selection; ⌘D fills down. Test every one of
   these against the Excel/Google Sheets convention and log each deviation.

2. **Zero perceived latency on the hot path.** The hot path is: click/arrow to a
   cell → type → commit → next cell. Every step must feel instantaneous.
   Measure keystroke→painted-character, cell-focus→ready-to-type, and
   commit→cursor-on-next-cell. Anything a human can perceive as a wait (≳50ms on
   the type path, ≳100ms on focus/commit) is a defect. A fast edit run — retype
   20 cells down a column as fast as you can — must never drop a keystroke,
   stall, or let the cursor fall behind your typing.

3. **No friction interrupts the flow.** Nothing modal, blocking, or
   confirmation-gated may sit on the fast path. No save spinner you wait on, no
   dialog, no toast that steals focus, no focus trap, no "are you sure." Writes
   should be optimistic — the edit lands instantly and reconciles in the
   background — and failures surface *without* halting the next edit. Audit for
   anything that makes the user stop and wait before their next keystroke.

4. **Motion is predictable and reversible.** The cursor goes exactly where a
   spreadsheet user expects, every time. Selection is always visible and always
   correct. Undo (⌘Z) instantly reverts the last change and Redo (⌘⇧Z) restores
   it, including for paste and fill. Nothing surprises the hands.

## Ground rules

1. **Measure, don't guess.** Every latency claim needs a number (a trace, an INP
   figure, or a keydown→paint delta from a double-rAF probe). Every flow claim
   needs a specific observed keystroke sequence and what happened.
2. Cite `file:line` for every code-level finding.
3. Every recommendation gets a **verifiable success criterion** (a number or a
   pass/fail keystroke test), an effort estimate (S/M/L), and its dependencies.
4. Distinguish "confirmed by measurement" from "hypothesis."
5. Any proposed UI copy follows CLAUDE.md Language rules (plain words: "table",
   "record", "mapping", "publish"; never "canonical", "sync", "triage", "raw").
6. Zugzug is a governed reference-data / mapping workspace, **not** an Airtable
   clone (Airtable-parity is an explicit anti-goal per `ROADMAP.md`). Judge
   snappiness by whether a power user maintaining a few hundred to a few thousand
   records can move fast — not by feature count.

## Architecture (verify line numbers against current code before citing)

- React 18 + React Router 6 + Vite 6 + Tailwind v4. Hand-rolled grid in
  `app/src/components/datagrid/`: `DataGrid.tsx` (orchestrator: ranges,
  copy/paste, undo, fill handle), `DataGridBody.tsx` (row virtualization via
  `@tanstack/react-virtual`), `DataGridRow.tsx` (memoized row + `GridCell` per
  column), `DataGridHeader.tsx`, `useGridCursor.ts` (keyboard navigation),
  `UndoStack.tsx` (per-tab undo/redo).
- Cell editing is contentEditable + typed editors. Writes go through the store
  (`app/src/lib/store.ts`) to `/api`.
- Known prior findings that directly hurt snappiness (from
  `docs/grid-next-level-plan.md`, 2026-07-12 — **re-verify whether each is still
  present**): row virtualization height-chain break in Records mode
  (`TablePane.tsx` RecordsBody root div) making scroll/arrow-hold crawl;
  type-to-edit *appends* instead of replacing and eats the first keystroke
  (`useGridCursor.ts` / `DataGridHeader.tsx`); silent save failures with a lying
  "Saved" pill (`store.ts` write path); rapid record-adds dropped (in-flight
  POST aborted); copy has zero feedback; a `/` shortcut that swallows
  type-to-edit. Confirm which of these still reproduce — some may be fixed.

## Method

Run these as a power user would, in the browser, keyboard-only where possible,
and capture timings. Seed or find a table with enough rows that latency shows
(the real `brand` table, ~5k rows, is a good stress case; note how you seed if
you need more).

### Journey 1 — The fast edit run (the core test)
Put your cursor at the top of an editable text column. Without touching the
mouse: type a new value, Enter, type, Enter, 20 times down the column as fast as
you can type. Then do the same across a row with Tab. Record: dropped
keystrokes, cursor lag, any stall or spinner, whether the first keystroke of
each cell is eaten, whether typing replaces or appends, whether Enter/Tab land
you on the right next cell. This one journey is the heart of the audit.

### Journey 2 — Navigation without the mouse
From a cell: arrows, ⌘/Ctrl+arrow (jump to edge), Home/End, PageUp/PageDown,
Shift+arrow (extend), ⌘+Shift+arrow (extend to edge). Log every deviation from
spreadsheet behavior and every case where focus is lost, trapped, or the
selection outline lags or is wrong.

### Journey 3 — Bulk moves
Range-select with keyboard, copy (is there feedback?), paste (does it land
instantly? does it show what changed?), fill handle / ⌘D fill-down, then ⌘Z to
undo the whole thing and ⌘⇧Z to redo. Time each; note anything non-instant or
non-atomic.

### Journey 4 — Editing typed cells fast
Select cell, date cell, linked-field cell, number cell. Can you open, pick, and
commit each with the keyboard alone, at speed? Does an editor popover block the
next keystroke? Does committing a select/date advance the cursor like a text
cell? Number cells especially: does typing a number commit cleanly and advance,
or does it fight you?

### Journey 5 — The interruptions
Deliberately hunt for anything that makes you *wait* mid-flow: save spinners,
toasts, confirm dialogs, focus jumps, layout shift on hover/commit, re-render
stalls (e.g. periodic polls that freeze input), or a slow cell editor mount.
Each one is a friction defect — record what triggered it and how long it stole.

For each journey, produce timings and a defect list.

## Latency budget (the plan's exit criteria)

- Keystroke → painted character: **< 50ms** (target < 32ms / one frame).
- Cell focus → ready-to-type: **< 100ms**.
- Commit (Enter/Tab) → cursor on next cell, ready: **< 100ms**.
- Fast edit run of 20 cells: **zero** dropped keystrokes, cursor never falls
  behind, no stall > 100ms.
- Paste / fill / undo of a range: applied in **< 100ms**, atomic (one undo step).
- Arrow-hold navigation: **≥ 30 FPS** with the cursor tracking, at the largest
  real table.
- Nothing on the hot edit path is modal, blocking, or confirmation-gated.

Adjust any number with justification if measurements say otherwise.

## Deliverable: `docs/grid-snappiness-plan.md`

1. **Verdict** — in one paragraph: does the grid feel like a spreadsheet today?
   Where does it break the illusion first?
2. **Measured baseline** — the latency numbers table (each hot-path metric ×
   the tables you tested), plus which prior findings still reproduce.
3. **Defect list** — every friction/latency/keyboard defect, grouped by the four
   pillars, each with: the observed keystroke sequence, the expected
   (spreadsheet) behavior, the `file:line`, severity (breaks-the-flow /
   feels-sluggish / nice-to-have), and a success criterion.
4. **Fix plan** — defects turned into ordered work items (evidence → change →
   success criterion → effort), snappiness-first: the changes that most restore
   the fast-edit feel go first.
5. **Keyboard reference** — the full intended shortcut map (what should exist),
   marking which work today, which are wrong, which are missing.

Keep it honest: if the grid already feels fast on the hot path and the only
problem is one dropped-keystroke bug, say exactly that. If it feels sluggish,
name the single change that would most restore the spreadsheet feel and lead
with it.
