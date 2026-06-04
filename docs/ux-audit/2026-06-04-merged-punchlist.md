# Zug Zug — Merged UX Punch-List
**Date:** 2026-06-04
**Sources:** [`2026-06-04-frontend-developer-findings.md`](./2026-06-04-frontend-developer-findings.md) + [`2026-06-04-ui-designer-findings.md`](./2026-06-04-ui-designer-findings.md)
**Goal:** close the gap from "internal tool" to "paid master-data product"

---

## TL;DR — the shape of the work

The product is closer to "paid" than either audit expected. The keyboard model, token system, draft/commit separation, motion layer, and recent grid polish (commits `114d4ee`, `7adb9a4`, `0be18c7`, `0062f50`, `63c84ef`) are all production-caliber. The gap concentrates in four areas:

1. **Three trust-eroding bugs on visible surfaces** — Dashboard KPI cards are hardcoded fixtures, Settings "Save changes" silently drops input, Dashboard crashes when `dims=[]`. All <half-day fixes; they'd burn a paying customer on day one.
2. **The column-header menu and ComboSelect** — the two most-used micro-surfaces in the workflow, both unfinished (Unicode glyphs as icons; no keyboard nav; no focus restore). Both audits flagged independently.
3. **Visual flatness from a compressed surface ramp + missing elevation/motion/contrast scales** — the token system is mature but missing four tiers (surface-elevated, shadow scale, motion durations, 14px type step). Pure design-system work.
4. **Workflow primitives a collaborative tool needs** — no cmd-K, no deep-link to a specific row, bulk undo fires N round-trips, `initStore` is a 5-call waterfall.

One **decision is required before Tier 3 work starts**: which of three brand directions to commit to (warm editorial / Linear-precise / terminal-elevated — see §6). Tiers 0–2 are direction-agnostic.

---

## Tier 0 — Ship first: trust-eroding bugs (<1 day total)

| # | Finding | Location | Effort |
|---|---------|----------|--------|
| 0.1 | **Dashboard crashes when `dims=[]`** — `dims.find(...)!` non-null assertion has no guard; the route renders KPIs + seeds unconditionally. Mapping/MasterTables handle the empty case, Dashboard doesn't. | `Dashboard.tsx:19` | S |
| 0.2 | **KPI cards are hardcoded fixtures** — "48.6k / 23 / 11.4k" never moves. Real totals are computed in the same component and only used in prose. First impression = visibly wrong numbers. | `data.ts:19-24`, `Dashboard.tsx:52-57` | S (wire existing) / M (add `/api/stats` for total-mapped) |
| 0.3 | **Settings "Save changes" is a no-op** — `save()` only sets a 2.2s flash; the workspace name input is uncontrolled and never sent anywhere. Domain restriction `@bettercollective.com` is also hardcoded. | `Settings.tsx:131`, `TeamSection.tsx:65` | S (remove phantom button + persist on blur) / M (real workspace endpoint) |
| 0.4 | **Undo `pop()` happens before `inverse()` resolves** — failed inverses silently disappear; UI ends up inconsistent with no recovery. | `UndoStack.tsx:48-54` | S |

---

## Tier 1 — Cross-confirmed quick wins (both audits agreed; <1 day each)

These are the highest-confidence visible improvements. Order is impact-to-effort.

### 1.1 Column-header menu: kill the Unicode glyphs — **HIGH**
Both audits flagged this as the single biggest "internal tool" tell. `ColumnHeaderMenu.tsx:80–130` uses `✎`, `⇅`, `↑`, `↓`, `✕`, `⊘`, `🗑`, `←` as button content; the rest of the app uses 1.6-stroke `currentColor` SVG icons at 18×18. Same issue at `DataGrid.tsx:562` (`👁 N hidden`) and `Settings.tsx` (`✓ saved` tick). Add `IconSortAsc`, `IconSortDesc`, `IconHide`, `IconTrash`, `IconEye`, `IconChevronLeft` to `Icons.tsx`; replace inline. **Effort: S (~2-3h).**

### 1.2 ComboSelect: keyboard nav + focus restore — **HIGH**
The most-used interactive element in the workflow. Two independent gaps:
- **No arrow-key navigation through the option list** (`ComboSelect.tsx:67-98`) — Enter picks `list[0]` only.
- **No focus restore after selection** (`ComboSelect.tsx:43-47`) — after `setOpen(false)`, focus goes nowhere; user must Tab back in.

Both are blocking the keyboard-driven Mapping flow. Add `highlighted` index state, wire Arrow/Enter, `aria-activedescendant`, and `triggerRef.current?.focus()` on close. **Effort: M (combined, ~half-day).**

### 1.3 Review panel: bound the height — **MEDIUM**
The staged-drafts panel that drops down from the commit footer has no `max-h`. 50+ drafts pushes the commit button off-screen. `Mapping.tsx:746-761`. Add `max-h-64 overflow-y-auto`. **Effort: XS (~5 min).**

### 1.4 WCAG contrast pass on small text — **HIGH (accessibility)**
`text-ink-3` (`#5B6884`) on `--surface` (`#0E1422`) is ~3.0:1 at 10–11px — fails AA (needs 4.5:1). Hits Dashboard activity timestamps, Mapping idle footer, and several secondary labels. Blanket rule: **`text-ink-3` only on text ≥13px**; everything smaller goes to `text-ink-2`. **Effort: S (~30 min audit + swap).**

### 1.5 Surface ramp: widen the gap, add `--surface-elevated` — **HIGH**
`--surface` → `--surface-2` is only ~6% L delta in oklch — cards and canvas blur together. Widen to ~9% and add a new token for menus/popovers (currently they reuse card tokens, so floating UI looks like base surface). Proposal in `tokens.css`:
```
--surface:           #0E1422 → #0F1526
--surface-2:         #161E30 → #162035
--surface-3:         #202B44 → #1E2840
--surface-elevated:  (new)   → #252E48   /* menus, popovers, tooltips */
```
Cascades through every component for free. **Effort: S (~1h incl. QA across screens).**

### 1.6 Sort `<select>` in Sources → styled buttons — **MEDIUM**
Native `<select>` next to custom filter chips is the single largest visual inconsistency in the Sources toolbar. `Sources.tsx:308-311`. Replace with the three-button segment pattern already used for status pills. **Effort: S (~20 min).**

### 1.7 Shadow consistency — `shadow-md` / `shadow-2xl` / `shadow-lg` → token — **MEDIUM**
Each floating surface picked a different Tailwind default. Locations: `AppShell.tsx:70` (UserMenu), `CatalogExplorer.tsx:58` (modal), `ColumnHeaderMenu.tsx:76`, `HiddenFieldsPopover.tsx:61`. Replace with the existing `shadow-pop` and tune the underlying token (see §4). **Effort: S (~30 min).**

### 1.8 `tabular-nums` missing on numerics — **MEDIUM (polish)**
`Dashboard.tsx:137` (activity timestamps), `Mapping.tsx:751` (staged review timestamps), `Sources.tsx:396` (schema header row count). Timestamps that subtly shift width as digits change are a dead giveaway of unfinished UI. **Effort: S (~30 min).**

### 1.9 Replace `confirm()` browser dialog — **MEDIUM**
`DataGrid.tsx:506-511` — coerce-on-type-change uses native `confirm()`. Jarring, blocking, unstyled. Replace with inline modal or inline banner inside the `ColumnHeaderMenu`. **Effort: S.**

### 1.10 "Tip — select two or more records to merge" threshold — **LOW**
Shows at `list.length >= 2` so a fresh small table immediately surfaces merge instructions that aren't relevant. Raise threshold to ≥5 or make it once-per-session. `MasterTables.tsx:323`. **Effort: XS.**

### 1.11 Sources standing callout — redundant left border — **LOW**
`Sources.tsx:253` — `border-l-2 border-l-accent` on a card that already has a top gradient accent and a "Standing · today" eyebrow. Pick one. **Effort: XS.**

### 1.12 Commit success flash animation — **MEDIUM**
The flash text appears instantly; the commit action is the primary success moment in the product. Wrap in `zz-rise` enter + `--ak-dur` opacity exit. `Mapping.tsx:720-731`. **Effort: S (~30 min).**

---

## Tier 2 — Workflow upgrades (multi-day, real product moves)

### 2.1 Deep-link to a specific value in the workbench — **HIGH (collaborative tool primitive)**
URL only holds `?dimId=…`. Add `&value=…` so a teammate can Slack "look at this specific mapping decision" and the recipient lands on the focused row. `Mapping.tsx:76-89, 128-129`. **Effort: M.**

### 2.2 Bulk operations are not actually bulk — **HIGH**
`bulkApply` (`Mapping.tsx:247`) and `automap` (`Mapping.tsx:241-246`) call the per-value handler in a loop. Result: 20-row bulk accept = 20 sequential `saveDraft` calls + 20 individual undo stack entries. Undoing fires 20 more round-trips. Fix: snapshot all prev states, `Promise.all` the saves, push one compound undo entry whose inverse `Promise.all`s the rollback. Also surface `topLabel` (already computed in `UndoStack.tsx:67`, never rendered) on the undo button so it reads "Undo: auto-match 14 values". **Effort: M.**

### 2.3 `initStore()` parallelize the 5-call waterfall — **HIGH (perceived perf)**
`store.ts:85-95` runs `refreshDims → refreshDrafts → refreshSources → refreshAudit → refreshPreferences` sequentially. Fan out to `Promise.all([dims, sources, audit, preferences])` then `refreshDrafts` (depends on dims). Cuts cold boot by 3–4×. **Effort: S.**

### 2.4 `refreshDims()` N+1 — add `/api/dimensions?full=true` — **HIGH**
`store.ts:62-65`: 1 list call + N per-dimension calls. With 12 dims = 13 requests per mutation. Add a server endpoint that returns full shapes in one response. **Effort: S backend + S frontend.**

### 2.5 cmd-K command palette / quick-switcher — **HIGH (paid-product table stakes)**
Index: all dimensions (with unmapped count), all canonical records across all dims, recent audit entries. Selecting a dim → `/app/mapping?dimId=…`; canonical → `/app/tables?dimId=…&focus=…`. Document under "Global" in `ShortcutsOverlay`. **Effort: L.**

### 2.6 Per-dimension undo stack (no clear-on-switch) — **MEDIUM**
`UndoStack.tsx:35-38` clears on `scopeKey` change. Switching dim A → B → A and pressing undo does nothing. Switch to `Map<string, UndoEntry[]>` keyed by dimId. **Effort: M.**

### 2.7 `M` shortcut in cross-dim inbox — **MEDIUM**
Single-dim has A/M/S/R/N. Cross-dim handles only A/S/N + J/K. M (manual pick via ComboSelect) is conspicuously absent and the hint bar omits it. **Effort: M.**

### 2.8 All-dim view: expandable review + dashboard deep-link — **MEDIUM**
`Mapping.tsx:933-943` — all-dim commit footer has count but no expand-to-review. Dashboard "Review & commit" link doesn't preserve the all-dim view either. Both should land the reviewer in the right place. **Effort: M.**

### 2.9 Group review panel by canonical target + per-row discard — **MEDIUM**
Currently a flat `<ul>`. Group by target canonical record, show "→ United States (3 new mappings, 1 new canonical)", add per-row discard button (call `discardDraft`). `Mapping.tsx:746-760`. **Effort: M.**

### 2.10 Real first-run experience — **MEDIUM**
`NoTablesYet` is a minimal two-button block; Dashboard doesn't use it at all. Build a three-step guided card for `dims=[] && sources=[]`: browse warehouse → create table → start matching. **Effort: M.**

### 2.11 Retire canonical: confirm + optimistic undo + `Promise.all` — **SMALL**
`MasterTables.tsx:225-235` — undo is pushed *after* the API call; if the network fails mid-flight the action is lost without an undo entry. Also the multi-select retire loop (line 337) is sequential. **Effort: S.**

### 2.12 Per-slice store subscriptions — **MEDIUM (debt)**
Every mutation re-renders every subscriber. `saveDraft` re-renders Dashboard + Sources + every Mapping row. Split into `subscribeDims/Drafts/Sources/Audit`. Not urgent at 12 dims; matters at 100. **Effort: M.**

### 2.13 `MasterTables` columns memo depends on `open` (provenance drawer) — **SMALL**
`MasterTables.tsx:84-166`: expanding a row recomputes the column definitions and the grid layout chain. Move `open` to a ref or `useCallback` the render with `open` in its own dep. **Effort: S.**

---

## Tier 3 — Design system maturity (blocked on §6 brand direction for *style*, not structure)

Tier 3 structure (add scales, add tokens, promote shared components) is direction-agnostic. The *values* inside each scale shift slightly depending on §6, but the work shape is the same.

### 3.1 Typography scale gets a 14px step
Add `--ak-fs-base: 14px` between `--ak-fs-sm: 13px` and `--ak-fs-md: 15px`. The 13→15 jump is the most-used region (table cells, form fields, nav) and reads as a lurch. Sweep usages.

### 3.2 Three-tier shadow scale
Single `--shadow` is a marketing card-lift. Add:
```
--shadow-sm:  0 1px 4px rgba(0,0,0,.18), 0 0 0 1px rgba(255,255,255,.04);  /* tooltips, inline menus */
--shadow:     0 8px 24px -8px rgba(0,0,0,.40);                              /* cards, panels */
--shadow-lg:  0 24px 60px -20px rgba(0,0,0,.60);                            /* modals, palette */
```
Current `0 30px 70px -42px` is too diffuse and creates a halo artifact in light theme.

### 3.3 Motion tokens
```
--dur-fast:    120ms;   /* hover, button press */
--dur-base:    180ms;   /* current --ak-dur */
--dur-slide:   300ms;   /* drawers, segmented control */
--ease-spring: cubic-bezier(.32,.72,0,1);  /* already used in segmented control, not tokenized */
```

### 3.4 Semantic state tokens
Today everything in the funnel is the same green; "committed/published" should be distinct from "mapped draft":
- `--committed` / `--committed-soft` (cooler teal-green, e.g. `#0E9F8A`)
- `--staged` / `--staged-soft` (distinct from `--warn` which doubles as "needs attention"; e.g. `#C47C18`)

### 3.5 Line-height tokens
Replace ad-hoc `leading-[1.5]`, `leading-[1.55]` etc.:
- `--lh-tight: 1.25` (display headings)
- `--lh-reading: 1.55` (body, default)
- `--lh-code: 1.65` (mono blocks, already in `.ak-code`)

### 3.6 Display weight ladder
800 (page h1) → 600 (card title) skips 700. Add `font-bold` (700) for sub-section headings like "Mapping seeds" and "Activity".

### 3.7 Promote shared components
- `StatsBar` — Mapping coverage panel and MasterTables stats are visually identical, duplicated with `gap-y-3` vs `gap-y-2` drift
- `FormField` — the `Field` inline component in `Settings.tsx` is the right pattern; Mapping/MasterTables use ad-hoc inline `div` labels
- `StandingCallout` — `border-l-2 border-l-accent bg-accent-wash` pattern is replicated four times across Sources, MasterTables, and Settings with inconsistent widths/padding
- Replace bespoke engineer toggle in `Settings.tsx` with the `.ak-toggle` kit class (current version breaks in light mode — thumb invisible against white surface)
- Inline edit affordance in `MasterTables.tsx` columns: `border-accent bg-bg` creates a dark rectangle inside light rows; use `bg-transparent border-b-2 border-b-accent` (underline-only) to minimize disruption
- Variants drawer chips: use `.ak-badge` neutral tone, not bespoke `bg-surface border-line-2`
- Replace `min-w-3xl` Cards in Settings with the standard card pattern; `Connections` cards use `bg-bg` directly (breaks if light mode `--bg` changes)

### 3.8 Page header system
Every page renders its own `<h1>` with different `clamp(...)` ranges: Dashboard 34→52px, Mapping 26→40px, Sources 40→56px. Three unrelated scales make the product feel like three apps. Add a `PageHeader` with one `clamp(30px, 4vw, 44px)` baseline and use it everywhere. Also unifies the kicker mono row pattern.

### 3.9 Sidebar nav touch target
`py-2` on 13px text = 34px row, below the 44px accessibility minimum and tighter than Linear/Vercel (36–40px). Increase to `py-2.5` (40px). Also: active-state inset border at 2px → 3px (matches Linear) and use a left/right chevron for sidebar collapse instead of the rotated up/down chevron.

### 3.10 Schema header opacity → solid
`Sources.tsx` schema headers use `bg-surface-2/60` — composite-layer hazard on Firefox. Solve at design time by adding a solid `--surface-2-soft` token (or just use `bg-surface-2` without opacity).

---

## Tier 4 — Microinteractions and loading states

Stack-rank low-priority but visible-when-done:

- **ComboSelect dropdown** — pop-in animation (`zz-pop-in` at `--dur-fast`)
- **TablePicker dropdown** — same
- **Row action confirm flash** — when `A`/`M` accept-and-advance fires, briefly tint the just-acted row `bg-ok-soft` for 150ms before the cursor moves on
- **Staged draft slide-in** — drafts appear in the review panel instantly; should slide from top
- **Checkbox state transitions** — instant; 120ms fill on the check mark, important under bulk-select
- **Skeleton loaders** — `Kpi`, MasterTables variants drawer ("loading…" plain text), Sources scan button (`Scanning…` → spinner)
- **Optimistic commit** — clear staged count + show flash on button press, revert on error (~100ms ambiguity gap today)

---

## §5 — What's already great (don't touch)

Both audits independently called these out. These are the quality bar to protect:

- **Keyboard cursor model** (`useGridCursor`) — composable, framework-correct
- **Recent grid polish** — portaled `ColumnHeaderMenu` + `AddFieldPopover`, sliding segmented control with `useLayoutEffect`-measured indicator, hidden-column chip canonical entry, always-left-aligned headers
- **Shortcut hint bar** on focused mapping rows — perfect progressive disclosure
- **Commit footer's mode-aware copy** (engineer vs. non-engineer) — "Publish N changes" / "Approve & commit N" / "merged into map_country"
- **Sources standing callout** as a *concept* — surface the single highest-impact unmapped source on every visit. The content is right; just dedupe the visual treatment per 3.7.
- **Token + theme pipeline** — `tokens.css → globals.css → @theme inline`, no `dark:` modifiers anywhere, `[data-theme="light"]` swap just works, `SQUARE_MODE` global override is elegant
- **Draft/commit separation** — staging to Postgres first, batching to canonical store, surfaced through chip colors + review footer + audit trail
- **Undo/redo coverage** — present on both Mapping and MasterTables with proper inverses for merge/rename. Only fix the error handling (0.4); preserve the architecture.
- **`useSyncExternalStore` store** — the emit/subscribe model itself is right; just slice it (2.12)

---

## §6 — Decision required: brand direction

Tier 3 *values* (and a slice of Tier 4) depend on which direction you pick. Tiers 0–2 don't.

### A. "Warm Editorial — Data Newspaper"
Airtable × NYT Data desk. `DM Serif Display` for headings, warmer `#0A0D17` background, `#E04F25` rust accent replacing `#D6336C`, `border-2px` blockprint card edges, newspaper-column Dashboard.
**Tradeoff:** strong personality; risk of reading as "too editorial" for high-density data work; serif in dark mode requires careful contrast.

### B. "Linear-Precise — Engineer's Console" *(closest to current trajectory)*
The current direction, refined to completion. Keep all color tokens; finish the icon system; implement the three-tier shadow + motion scales; add thin-line SVG illustrations (80×80) for empty states; remove `[ master data ]` bracket decorations; demote the per-card `zz-tab` connector to a single highest-value KPI only.
**Tradeoff:** achievable in 2–3 weeks. Risk of staying in the "competent but anonymous" zone unless one memorable surface gesture is kept (the ZZ mark + square-mode is probably enough).

### C. "Data-Dense Terminal-Elevated"
Hex / Warp / Ghostty reference. Berkeley Mono (or JetBrains Mono) for ALL UI text, not just data. Warmer `#0C0E16` OLED-leaning surface. Ledger-book horizontal rules between sections. Sidebar full-mono. **Persistent right-edge status rail** (32px) showing live scan status, commit queue depth, presence dots.
**Tradeoff:** highest commitment; mono-everywhere narrows the audience (power users will love it; less technical stakeholders may find it intimidating); the right-rail is a real new feature requiring design + impl. Most distinctive of the three.

**Recommendation:** **B** unless the target user is strongly skewed to data engineers, in which case **C**. **A** only if a deliberate brand pivot is on the table.

---

## Suggested execution order

1. **Day 1** — Tier 0 (four bugs, all S). Ships visible "this is now a real product" energy.
2. **Days 2–3** — Tier 1 cross-confirmed wins. The column-header icons + ComboSelect + surface ramp + contrast pass collectively change the perceived bar.
3. **Pick §6 direction.** Blocks Tier 3 values but not its structure.
4. **Week 2** — Tier 2.1 (deep-link), 2.3 (parallel boot), 2.4 (N+1), 2.2 (compound bulk). The workflow primitives a paid tool needs.
5. **Weeks 3–4** — Tier 3 in §6-aligned values. Then Tier 4 polish.
6. **Backlog** — 2.5 (cmd-K, L-sized), 2.6 (per-dim undo), 2.10 (first-run).

---

*Cross-references: Frontend findings → `CF-*`, `P-*`, `W-*`, `T-*` from `2026-06-04-frontend-developer-findings.md`. Design findings → §2/§3/§4 + `QW1–10` from `2026-06-04-ui-designer-findings.md`. Effort: XS <1h, S <½day, M <2 days, L = multi-day.*
