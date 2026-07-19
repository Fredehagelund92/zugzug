# Rounded + Narrow — Rollout Plan (runs only after a GO)

**Gate:** `docs/redesign/rounded-narrow-findings.md` returned **GO** (verified in
the real shell, no blockers). Read it first for the full evidence + screenshots.
The findings resolved the two open values this plan needs:
- **`--doc` width = 1040px** (940 was cramped on the denser real pages, 1180
  barely differed from today's 1320).
- **Ranked risk list** — three items, none blocking; folded into Step 3 below.

## The decision this implements

- **Corners: rounded everywhere.** Retire square-mode; every non-pill surface
  gets the brand's `4/8/12` radius scale back. Includes grid pages.
- **Width: split.** Document pages (Settings, Account, peers on
  `PageContainer`) move to a narrow `--doc` column; grid pages stay full-width
  and gain rounded framing only.
- **Pills unchanged** (`--r-pill 999`).

## Baseline note

Builds on the current `polish` branch (`SettingsPageHeader.tsx` + modified
`routes/settings/*`). Do not revert or refactor that work — layer on top.

---

## Step 1 — Tokens

1. Delete the square-mode override block in `app/src/globals.css:284-288`. This
   alone restores `--r-sm 4 / --r 8 / --r-lg 12` (already declared in
   `tokens.css:35-38`) live across the whole app.
2. Add `--doc: 1040px` in `app/src/tokens.css` (near `--wide`, line 40).

**Verify:** app-wide corners round on reload; `getComputedStyle` on a `Panel`
shows `--r-lg: 12px`, not `0px`. No new radius values introduced.

## Step 2 — Layout: the narrow document column

1. Add `"doc"` to `PageContainerProps.max` in
   `app/src/components/PageContainer.tsx`; map it to `max-w-[var(--doc)]`.
   Update the component's doc comment (it currently says wide/full only).
2. Point document routes at it. Cheapest lever: `SettingsLayout.tsx` wraps
   `<PageContainer>` — give it `max="doc"`. Do the same for the Account layout
   and any other `PageContainer` document route. **Leave grid pages alone**
   (they bypass `PageContainer` per ADR-0003) and leave genuinely-wide admin
   tables on `max="full"`.

**Verify:** every settings/account page renders in the narrow column at the
findings width; grid pages unchanged in width; no page double-caps or
mis-centers. Check `PageContainer.test.tsx` still passes / extend it for `doc`.

## Step 3 — Component sweep (work queue = findings risk list)

The findings verified the classic square→round regressions as **OK** (Panel
`overflow-hidden` corner bleed, sticky-header top corners, connection-card left
spine, selected-cell ring) — no blockers. Three real items to fix:

1. **`Sources.tsx:274` — the lone square box** *(fix-during-rollout).* Its
   surface uses `overflow-hidden border … shadow-pop` with **no `rounded-lg`**,
   so once square-mode lifts it's the only hard-cornered box while every sibling
   (incl. Triage at `Triage.tsx:422`) rounds. Fix: add `rounded-lg`. Grep the
   whole tree for other hand-rolled `border` surfaces missing a radius util.
2. **`:focus-visible` ring radius** (`globals.css:305`) *(cosmetic).* Pinned to
   `--r-sm` 4px, so 8px inputs and 12px cards get a ring tighter than the
   element. Fix: bump the ring to `--r` (8px).
3. **Collapsed-sidebar column drift** *(cosmetic, optional).* `mx-auto` drifts
   the `--doc` column left toward the 64px rail, leaving an asymmetric right
   margin. Usable as-is; optionally left-bias the column when the rail is
   collapsed.

Then spot-check the small surfaces the findings cleared but that touch every
page — inputs, segmented controls, badges, buttons, popovers, scrollbar thumb.
Do not round pills.

**Verify:** each risk-list item resolved with a before/after screenshot; no new
corner-clip or seam artifacts.

## Step 4 — DESIGN.md (the doc reversal)

This is the biggest doc change — the current text calls square-mode permanent.
1. **§5 Radius** — remove the "square-mode is active and permanent" paragraph.
   Replace with: the brand's `4/8/12` scale is **live**; corners are rounded
   app-wide; pills remain the only fully-round shape. Note `rounded-*` utilities
   are now cosmetically active again.
2. **§5 Layout widths** — add `--doc` (the findings number). Document the
   **split**: document pages use `--doc`; grid pages stay `--wide`/full-bleed.
3. **§7 Containers** — update `PageContainer` to list `max="doc"`; update the
   `Panel` note that says "square under square-mode."
4. Cross-check every other DESIGN.md mention of "square" / "90°" for staleness.

**Verify:** grep DESIGN.md for `square` / `permanent` — no stale claims remain.
Tokens-vs-doc rule (§10, "tokens win") still holds.

## Step 5 — Full verification

1. Screenshot **every** settings page + Account + one grid page (Master
   tables), in **light and dark**, at **desktop and mobile**.
2. Visual-diff the Warehouse page against `warehouse-redesign.html` — corners,
   width, and rhythm should match the demo's intent.
3. Run the app end to end; click through the settings sidebar; confirm no
   layout regressions on the grid pages.
4. Run the test suite (`cd app && bun run test`) — fix any snapshot/width tests.

**Done when:** all screenshots read as intended, grid pages keep full-bleed,
DESIGN.md has no stale square-mode language, and tests pass.

---

## Out of scope

- New radius values (only the dormant `4/8/12` scale is restored).
- Rounding pills or changing the lattice.
- Refactoring the `polish`-branch settings work beyond what the split requires.
- Any width change to grid pages.
