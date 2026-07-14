# Grid Excellence — Remaining Waves Roadmap

Companion to `docs/grid-next-level-plan.md` (the 2026-07-12 audit). Records how the
audit's remaining items are grouped, sequenced, and gated after Waves 0–2 shipped.
Each wave gets its own spec + implementation plan when we reach it.

## Shipped (context)

- **Phase 0 core (0.1–0.4):** height-chain fix (row virtualization restored, 0.4→55.6 FPS),
  regression guard, deep-link fold fix, sticky-region verification.
- **Phase 1 breaks-trust (1.1–1.9):** silent-save surfaces, add-record queue, layout-save
  race, deep links, empty-vs-no-match states, number validation, **delete table (1.7)**,
  **presence record-key cursors (1.8)**, **grid a11y active-cell + keyboard exit (1.9)**.

Remaining audit items fall into three coherent, independently shippable waves.

## Wave 3 — Perf ceiling (spec: `docs/superpowers/specs/2026-07-13-grid-wave3-perf-design.md`)

Finishes Phase 0. The next performance ceiling after virtualization: boot cost and
the last scroll-path debt, plus the pre-stubbed activity-push.

| Item | What | Disposition |
|------|------|-------------|
| 0.5 (N+1) | Collapse the per-table `/drafts` boot fetches into one batch endpoint | Unconditional |
| 0.5 (payload) | Defer per-table row payloads until a table is opened (lazy rows) | **Gated** on a clean boot re-measure still missing the 1.5s budget |
| 0.6 | Scroll-path hygiene: hover sweep, `transition-colors`, O(cols²) pin recompute | Unconditional |
| 0.7 | Activity poll → `row_touched` push over the presence WebSocket (roadmap #53) | Unconditional; wires a pre-stubbed channel |

**Why first:** same performance thread we have been pulling; measurable against the
Phase 0 exit budget (§2 of the audit). Depends on the publish-lifecycle branch only
insofar as 0.7 rides the existing presence room (already present on the base).

## Wave 4 — Craft polish (feels-cheap 1.10–1.21 + kill list)

The "make it feel expensive" sweep. Many small surgical edits, one coherent pass.
Kill-list items 2/3/4 are the tails of 1.21/1.17 and land with them.

- 1.10 vocabulary leaks ("raw", "master record", "next position: 6144", "new a record…")
- 1.11 numbers left-aligned + dead Sum/Avg (coerce numeric fields end-to-end)
- 1.12 type-to-edit appends / eats first keystroke; header rename no select-all
- 1.13 copy has no feedback (range flash + toast)
- 1.14 two incoherent menu systems (pick one spec, apply everywhere)
- 1.15 pinned/key columns have no header menu
- 1.16 truncated cells no hover reveal
- 1.17 React warnings (resize/reorder setState-in-render; duplicate palette key)
- 1.18 create-table modal hangs >10s (optimistic close + background provisioning)
- 1.19 rename banner layout shift (overlay toast)
- 1.20 first-paint fade settle (reserve skeleton heights)
- 1.21 dead `/` shortcut + overlay drift + forever-disabled Duplicate
- **Kill list:** density prop (#1), dead `useGridCursor` params (#2), stale
  ShortcutsOverlay rows (#3), Duplicate item (#4), legacy `/ws/presence/:tableId` (#5),
  legacy `?dimId=` URL fold (#6). #1/#5/#6 stand alone; #2/#3/#4 ride their feature items.
- **Nice-to-have (fold in selectively):** `prefers-color-scheme` honoring, `--ink-3`
  contrast, fill-handle visibility, column-drag ghost + shorter threshold, swatch clip,
  dropdown chips, stale "changed only · 3" chip, Undo scope label.

## Wave 5 — Product features (Phase 2)

Deepen the product's job (not Airtable parity — `ROADMAP.md:112`).

- 2.1 search across all visible fields + wire `/` and Cmd+F (also closes 1.d)
- 2.3 "Map values to this record" context-menu handoff to Match mode (URL machinery exists)
- 2.4 persist the filter set per table (sort/widths/hidden already persist)
- 2.2 "changes with next publish" row markers — **gated on the publish-lifecycle branch
  landing** (consumes its `changedKeys` + staged-workflow token)

## Sequencing notes

- Wave 3 → 4 → 5 is the default order (perf foundation, then craft, then features).
- Wave 4 is the most parallelizable (independent surgical edits); good SDD fan-out.
- Wave 5's 2.2 is the only cross-branch dependency; the other three features are standalone.
- The vocabulary sweep (audit §7) is a Wave 4 sign-off gate: grep user-facing strings for
  the CLAUDE.md banned list before closing.
