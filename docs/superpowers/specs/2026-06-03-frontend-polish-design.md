# Frontend polish for review-readiness

**Date:** 2026-06-03
**Status:** Approved design, pending implementation plan
**Repo:** trust-me-bro (Zug Zug)
**Audience:** non-technical users coming from a Google Sheet

## Problem

Zug Zug is replacing a Google Sheet that a non-technical team uses today. The UI
is already polished from a brand/design-system perspective, but it surfaces
warehouse internals front-and-center — table names like `zugzug.dim_country`, SQL
previews with `MERGE INTO`, copy like `LEFT JOIN to NULL`, sidebar status
`analytics.duckdb · warehouse · live`. That language is fine for a data engineer
and even useful for trust-building, but for a Sheets refugee it reads as noise at
best and intimidation at worst.

Separately, the app has good automation primitives (auto-map ≥90%, threshold
slider) but the surface for automation is one knob in Settings; a Sheets user
wants to set this once and stop thinking about it. And there are scattered rough
edges — a fresh-install crash, error/loading gaps, accessibility inconsistencies
— that would embarrass us if a reviewer walked the app cold.

This spec covers the polish pass to get the app review-ready *for non-technical
users coming from a Sheet*. The product itself is good; the goal is to make sure
that goodness is what a reviewer encounters, not the implementation seams.

## Decisions (locked during brainstorming)

1. **Approach is a self-review punch list, not a feature build.** Three themes
   in scope (jargon strip, automation surface, polish/bugs). Three themes
   explicitly deferred (full empty-state / first-run UX, workflow legibility,
   governance affordances) — they're worth doing but not this pass.
2. **Jargon stays reachable, not front-and-center.** A single "engineer details"
   toggle in Settings exposes table names, SQL preview, JOIN warnings, etc. Off
   by default. Information is preserved, not deleted — engineers can still see
   it; everyone else doesn't have to.
3. **One `dims[0]` crash gets fixed even though full empty-state UX is out of
   scope.** `Mapping.tsx:29` and `MasterTables.tsx:72` blow up with zero
   dimensions; that's a hard crash on a fresh-install reviewer. Guard it but
   don't design the full first-run flow.
4. **Automation surface is "scheduled scans + confidence bands" only.** Auto-map
   on scan with two thresholds (auto-publish, suggest-only) replaces the single
   slider. Scheduled scan toggle per source. Notifications / dbt webhook /
   "why this suggestion?" are out of scope.

## Current state (ground truth)

User-facing jargon locations confirmed by grep:

- `Mapping.tsx:90` — full SQL preview with `MERGE INTO`, `USING (VALUES)`, `ON
  CONFLICT`, `WHEN NOT MATCHED THEN INSERT`. Triggered by a "Preview SQL"
  button visible by default.
- `Mapping.tsx:125-130` — header row exposes `master zugzug.dim_country`,
  `lookup zugzug.map_country`, `4421 rows · key country_code`.
- `Mapping.tsx:229` — row-expand says `⚠ unresolved — these 96,400 rows
  currently LEFT JOIN to NULL`.
- `Mapping.tsx:258` — commit footer says `23 staged drafts → batch MERGE to
  zugzug.dim_country + zugzug.map_country`.
- `DimensionPicker.tsx:99-100` — every dimension row's subtitle is
  `zugzug.map_country`.
- `DimensionPicker.tsx:121` — the create-dimension form previews `creates
  zugzug.dim_… + zugzug.map_…`.
- `MasterTables.tsx:165-167` — header row exposes `table zugzug.dim_country`,
  `key country_code`.
- `Settings.tsx:78-106` — Connections section is prose for engineers, including
  `ATTACH … (TYPE postgres)` and the `dim_*` / `map_*` mention.
- `AppShell.tsx:80-87` — sidebar footer shows `analytics.duckdb · warehouse ·
  live · {dims.length} tables`.

Crash bugs confirmed:

- `Mapping.tsx:29` — `useState(dims[0].id)` throws when `dims` is empty.
- `MasterTables.tsx:72` — same pattern.

Automation surface today:

- `Settings.tsx:113` — single confidence-threshold slider (50–100, default 90)
  and a "Auto-accept suggestions above the threshold on scan" toggle. Neither is
  wired to anything observable in the UI today; the toggle's state is local
  React state.
- `Mapping.tsx:65` — `automap()` button auto-stages drafts at confidence ≥ 90,
  hardcoded. No tie to the Settings slider.
- No scheduled scans — `scanSources()` in `store.ts:136` is manual-only.

What's already good (don't touch):

- The brand layer, design tokens, light/dark, accent system, Tailwind aliasing
  (`tokens.css` → `@theme inline` in `globals.css`).
- The draft → review → publish workflow (the OLTP draft layer in Postgres).
- The dimension picker UX (searchable, type-to-find, scales to many dims).
- The CatalogExplorer (server-side paged search of the warehouse catalog).
- Multi-user audit log + collaborator avatars.

## Design

### Theme 1 — Strip jargon (engineer-mode toggle)

The single mechanism: a global "engineer details" preference, persisted to
`localStorage`, surfaced in two places:

- A toggle in **Settings → Appearance** (existing section, well-suited).
- A small `</>` toggle in the topbar next to the theme toggle, so engineers can
  flip it without leaving the page they're on.

Off by default. When off, all engineer-targeted UI hides. When on, everything
appears exactly as it does today (no behavior change for engineers).

Implementation: a `useEngineerMode()` hook that reads/writes `localStorage`, plus
a context provider so the topbar toggle and Settings checkbox stay in sync.

The specific UI changes when engineer mode is **off**:

| Component | Hide / replace |
|---|---|
| `Mapping.tsx:125-137` header row | Hide the `master zugzug.dim_country / lookup zugzug.map_country / 4421 rows · key country_code` strip. Keep the coverage bar and `N new` badge. |
| `Mapping.tsx:90`, `:262-263` SQL preview | Hide the "Preview SQL" button entirely. |
| `Mapping.tsx:229` unmapped warning | Replace `LEFT JOIN to NULL` with `Unmapped — 96,400 rows downstream are missing this value`. |
| `Mapping.tsx:258` commit footer copy | Replace `… → batch MERGE to {dimTable} + {mapTable}` with `Ready to publish to {dim.dimension}`. |
| `Mapping.tsx:264` "Approve & commit" button label | `Publish N changes` |
| `DimensionPicker.tsx:99-100, :72` subtitle | Replace `{mapTable}` line with `{mapped} mapped · {fresh} new`. |
| `DimensionPicker.tsx:121` create-form preview | Replace `creates zugzug.dim_… + zugzug.map_…` with `Creates a new master list called "{name}"`. |
| `MasterTables.tsx:165-167` header row | Hide `table zugzug.dim_country · key country_code`. Keep the records-count and attribute-columns count. |
| `Settings.tsx:78-106` Connections section | When engineer mode is **off**: three simple cards (Warehouse / Master store / Workspace) with a status dot and plain-English status (e.g. "Reading from your warehouse — read-only"). When engineer mode is **on**: today's content (`md:zugzug`, `ATTACH (TYPE postgres)`, `dim_*/map_*` prose) replaces those cards. |
| `AppShell.tsx:80-87` sidebar footer | Replace `analytics.duckdb · warehouse · live · 4 tables` with `Connected to warehouse · 4 master lists` (and a live dot). |
| Sidebar label `"Value mapping"` | `"Match values"` |
| Sidebar label `"Master tables"` | `"Master lists"` |
| Sidebar label `"Sources"` | Keep — already plain English |

When engineer mode is **on**, every one of the above reverts to today's
behavior. The toggle should require zero re-render gymnastics — just a class on
the root, or a `useEngineerMode()` boolean threaded into each component.

**Information preservation rule:** every piece of engineer detail must remain
reachable in engineer mode. We are gating display, not deleting content.

**Microcopy pass (applies regardless of engineer mode):**

- `Mapping.tsx:117` button `Auto-map ≥90%` → keep, but after running show a
  result chip: `✓ Auto-matched 8 — review pending`. The current implementation
  shows nothing; users have to scroll to find what changed.
- `Mapping.tsx:142-153` "New / All / Mapped" filter chips: keep, but rename
  `New` → `Needs review` to align with the rest of the language.
- `Sources.tsx:79-84` status chips: rename `Needs attention` → `Needs review`
  for consistency with Mapping.
- `Settings.tsx` `Mapping defaults` section heading → `Matching defaults`
  (matches the terminology pass already in flight).

### Theme 5 — Automation surface

**Two changes, both in Settings.**

**5a. Replace the single confidence slider with a two-band picker.**

The mental model is a band-pass filter on suggestions:

```
publish threshold ────┐
                      │  ≥ this confidence: auto-publish on every scan
suggest threshold ──┐ │
                    │ │  between these: surface as suggestion, human required
                    │ │
              0% ───┘─┘  below: no suggestion
```

UI: one horizontal range slider with **two thumbs** (range input pattern,
implemented as two overlapping `<input type="range">`s with absolute-positioned
fills). Default values: `publish=95`, `suggest=80`. The current single slider in
`Settings.tsx:111-113` is removed in favor of this.

Both thresholds are stored as a **single workspace-global preferences row** in
a new `app.preferences` table (one row, `id=1`). Per-user preferences are not
needed for this pass — a Sheets-style workspace has one shared automation
policy. The backend's existing `scanSources()` already runs the scan; the new
bit is that the **server** auto-stages drafts for any value with confidence ≥
publish threshold inside the same scan handler (client doesn't need to do a
second round-trip). The "Auto-accept" toggle in `Settings.tsx:115-120` becomes
redundant and is removed.

`Mapping.tsx:65` `automap()` is removed in favor of using the Settings
thresholds. The "Auto-map ≥90%" button in the header (`Mapping.tsx:117`) becomes
**"Auto-match new values"** and uses the current publish threshold; the result
chip says `Auto-matched N at ≥{publish}% confidence`.

**5b. Scheduled scans toggle per source.**

In `Sources.tsx`, each row gets a small clock icon next to the existing wand
icon. Click it: a small popover with `Off / Every 15 min / Hourly / Daily`.
Server-side: a single Node `setInterval` in `server/src/server.ts` (no
BullMQ — the registry is tiny and per-process is fine). It runs every minute,
walks the source registry, and triggers `scanSources()` for any source whose
schedule is due. On the row, replace `unscanned` text with `Last scanned 4m
ago` when a scan has run, and `Auto every 15m` when scheduled.

**Out of scope for this pass** (called out so they don't sneak in): dbt
webhook, daily digest notifications, "why this suggestion?" explainer, per-user
notification preferences.

### Theme 6 — Polish & bug fixes

These are unrelated small items; batch into one polish PR.

**6a. Fix the `dims[0]` crash.**

`Mapping.tsx:29-30` and `MasterTables.tsx:72-73` both index into `dims` directly.
Guard:

```tsx
const [seedId, setSeedId] = useState(dims[0]?.id ?? null);
const seed = dims.find((s) => s.id === seedId) ?? dims[0] ?? null;
if (!seed) return <NoDimensionsYet />;
```

`NoDimensionsYet` is a single tiny component used by both routes (and Dashboard
too if needed). Copy: `No master lists yet. Create one or import from a wired
warehouse column.` with a button linking to Sources. **No further empty-state
work** — just stop the crash and give the reviewer a useful screen.

**6b. Style the `initStore()` error fallback.**

`main.tsx:34` writes raw HTML into `#root` on API failure. Replace with a small
React component (don't even need a route — just render directly): brand
masthead, plain-English message ("Can't reach the Zug Zug API. Make sure the
backend is running."), the technical detail in a collapsed `<details>`, and a
"Retry" button that calls `boot()` again.

**6c. Loading state during `initStore()`.**

Today the page is blank until the API call resolves. Add a skeleton AppShell
(sidebar visible, main area showing a "Loading…" with the Zug Zug mark
animating). Mount React immediately; show the skeleton until `initStore()`
resolves; then swap to the real routes.

This requires moving the `await initStore()` out of `main.tsx:30-36` and into
a top-level component that uses `useEffect` to load and renders skeleton →
real content.

**6d. Top-bar search input — decide.**

`AppShell.tsx:94-101` shows a styled search box with `⌘K` kbd hint, but nothing
is wired. Two options: (a) wire it up to search across `useDimensions()` master
records and `useSources()` columns, or (b) remove it. Recommend (b) for this
pass — it sets an expectation we don't yet meet. Replace with an empty space or
the breadcrumb of the current route.

**6e. Confidence color third tone.**

`Mapping.tsx:22-23`: `<70` uses `bg-line-2` (gray) and `text-ink-3`. That reads
as "low confidence is just less," not "this needs your attention." Change `<70`
to `bg-danger-soft` / `text-danger` so it visibly demands review.

**6f. Theme toggle duplication.**

The topbar `<ThemeToggle />` (`AppShell.tsx:103`) and the Settings theme picker
(`Settings.tsx:61-73`) set the same thing. Keep the topbar one (quick toggle);
remove the Settings field cleanly. The Appearance section then has only the
engineer-mode toggle (added in Theme 1).

**6g. Accessibility audit.**

Concrete items:

- Every icon-only button in `Mapping.tsx`, `MasterTables.tsx`, `Sources.tsx`,
  and `CatalogExplorer.tsx` should have `aria-label`. Several already do; audit
  for the gaps.
- Focus rings: `Button.tsx`, `ComboSelect.tsx`, `DimensionPicker.tsx` use
  varying `:focus` / `:focus-within` styles. Standardize on one accent-ring
  pattern.
- Headings: confirm `<h1>` per route, `<h2>` for sections (Cards). Currently
  some sections use `<h2>` inside Cards but Dashboard masthead is `<h1>` and
  some routes use bare `<div>` for headings. Audit.
- Keyboard: `DimensionPicker` doesn't trap focus inside its popover; add a
  basic focus trap (or at least make `Tab` cycle within the open dropdown).
- Color contrast: spot-check `text-ink-3` against `bg-surface` and
  `bg-surface-2` at the smallest used size (10px). If marginal, bump to
  `text-ink-2`.

**6h. Bulk-merge hint on Master tables.**

`MasterTables.tsx:189-190` only shows "select 2+ to merge" placeholder inside
the merge dropdown when ≥1 is selected. When 0 are selected, the header has no
merge affordance at all. Add a one-line hint below the table header when
`sel.length === 0`: `Select two or more master records to merge them into one.`
— gated by engineer mode? No — this is plain English and useful for everyone.

## Component boundaries

The work spans many files but the abstractions are clean:

- **`useEngineerMode` hook** (new, `src/lib/engineer-mode.ts`): localStorage +
  context provider + boolean. Consumed by every component that conditionally
  hides engineer detail.
- **`NoDimensionsYet` component** (new, `src/components/NoDimensionsYet.tsx`):
  one-shot empty state, used by Mapping + MasterTables + (optionally) Dashboard.
- **`BootGate` component** (new, `src/components/BootGate.tsx`): wraps the
  router and handles loading/error states. Replaces the top-level `await` in
  `main.tsx`.
- **`ThresholdRange` component** (new, `src/components/ThresholdRange.tsx`):
  the two-thumb range slider used in Settings.
- **`SourceScheduleMenu` component** (new, inline in `Sources.tsx`): the small
  per-row "scan every N" picker.

Backend additions:

- `app.preferences` table (or extend `app.user` with two columns) for the two
  threshold values.
- A `POST /api/preferences` (or `PUT`) and `GET /api/preferences` endpoint.
- A `POST /api/sources/{table}/{column}/schedule` endpoint that records the
  per-source schedule, plus a single scheduler in `server/src/server.ts` (or a
  tiny separate file) that polls for due scans.
- The `scanSources()` (and per-source equivalent) handler should, after
  scanning, auto-stage drafts for values with confidence ≥ publish threshold.
  The existing draft pipeline handles the rest.

## What's not in scope

These were considered and explicitly excluded for this pass:

- **Full first-run / empty-state UX** (Theme 2 beyond the crash fix): no
  guided onboarding, no "wire your first source" wizard, no welcome dashboard.
- **Workflow legibility** (Theme 3): no workflow ribbon, no cross-page "what's
  next" nudges.
- **Governance affordances** (Theme 4): no role concept, no row-locking, no
  audit filtering.
- **Larger automation**: no notifications, no dbt webhook, no
  "why this suggestion?" explainer.
- **Top-bar search wiring** — recommendation is to remove it for now (6d);
  wiring it is out of scope.

Each of these is a credible follow-up; they should not creep into this spec.

## Success criteria

- A non-technical reviewer walking the app from `/app` sees no SQL, no
  `zugzug.dim_*` / `zugzug.map_*` table names, no `MERGE`/`JOIN` language, and
  no `analytics.duckdb` in the sidebar footer.
- Toggling **Engineer details** on restores every piece of engineer-targeted UI
  (table names, SQL preview, MERGE/JOIN copy, ATTACH prose, sidebar footer
  detail) — no information is lost, only gated by display. The microcopy
  renames (e.g. `New` → `Needs review`, `Value mapping` → `Match values`)
  apply regardless of engineer mode.
- Fresh-install (zero dimensions) does not crash any route.
- The Settings page exposes one place to configure auto-publish/suggest
  thresholds (two-thumb slider) and per-source scan schedules are visible from
  Sources.
- API down / API slow both render usable screens (error fallback / skeleton),
  not blank white or raw HTML.
- Every icon-only button has an `aria-label`; focus rings are consistent across
  components.
- The polish pass is split into reviewable commits per theme so a reviewer can
  step through them.
