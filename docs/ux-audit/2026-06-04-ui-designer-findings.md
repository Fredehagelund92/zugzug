# UI/UX Audit — Zug Zug
**Date:** 2026-06-04  
**Auditor:** UI Designer agent  
**Codebase snapshot:** commit 114d4ee (main)

---

## 1. Visual Diagnosis

Six-bullet summary of the current visual character and where the gap to "paid product" sits:

**What's already strong**
- The token architecture is genuinely mature. A single `tokens.css` exports a coherent dark/light pair, all CSS properties reference `var()`, and the runtime accent switch + data-theme swap cascade through every Tailwind utility without a single `dark:` modifier. That discipline is rare at this scale of codebase and means design changes propagate correctly.
- The brand has real character: the ZZ zigzag mark, Bricolage Grotesque for display type, JetBrains Mono for data (with `tabular-nums` applied consistently in the right places), the `--r-sm/r/r-lg` square-mode override in `globals.css` giving everything 0-radius corners for a sharp editorial feel. That is a deliberate aesthetic point of view, not a template.
- The motion layer (`zz-rise`, `zz-drawer`, `zz-flow`, `zz-pulse`, `zz-live`) is done right: CSS-only, tied to the ease token, with a `prefers-reduced-motion` block that actually turns the animations off correctly.
- The recent polish commits (114d4ee through 63c84ef) show the bar is rising fast: the Mapping view's segmented control with a `useLayoutEffect`-measured sliding indicator is production-caliber interaction work.

**Where the gap to "paid product" is**

1. **The dark background is almost-but-not-quite right.** `--bg: #080B14` is deep navy-black, `--surface: #0E1422`, `--surface-2: #161E30`, `--surface-3: #202B44`. These four steps are correct in principle but the delta between surface and surface-2 (6% L difference in oklch space) is too compressed at the top of the scale. Cards and panels sit on backgrounds with near-identical perceived lightness, so hierarchy reads as flatness, not depth. Premium dark-mode tools (Linear, Vercel, Raycast) use a three-stop strategy: canvas (true dark), chrome (slightly lighter), interactive surface (clearly lighter with a visible border shimmer).

2. **Elevation is under-deployed.** `--shadow: 0 30px 70px -42px rgba(0,0,0,.72)` is a large diffuse lift shadow. But most interactive surfaces use `border border-line` plus the shadow token only at the card level — nothing intermediate. Menus, popovers, and the active segmented-control marker lack their own elevation tier. The result: menus (`rounded-sm border border-line-2 bg-surface p-1 shadow-lg`) and cards share the same shadow class, making layering feel one-dimensional.

3. **The type scale is missing a middle step.** The app has `--ak-fs-xs: 12px`, `--ak-fs-sm: 13px`, `--ak-fs-md: 15px`. The 13-to-15 jump is the most-used region (nav, table cells, body copy, form fields) and that 2px jump creates a visible lurch between "label" and "body" without a natural 14px resting size. Product tools like Linear use a tight 11/12/13/14/15 scale in the UI.

4. **Semantic status color system is incomplete on the visual dimension.** `ok/warn/danger` are correct semantically, but all three sit at similar saturation levels and only differ in hue. In the Mapping view, "Mapped" (ok-soft green), "New" (warn-soft amber), and "Skipped" (surface-2 neutral) read together legibly, but there is no "committed/published" state distinct from "mapped draft" — everything that has passed through the reconciliation funnel is visually the same green, which undersells the commit event.

5. **Icons are thin in the column-header menu context.** The `ColumnHeaderMenu` uses Unicode glyphs (`✎`, `⇅`, `⊘`, `🗑`, `↶`, `✕`) mixed with actual SVG icons elsewhere. This breaks the icon system's coherence: the inline SVG icons are all 1.6-stroke `currentColor` at 18×18, but the menu glyphs are at whatever weight the system font renders them, with different optical sizes and baselines. The emoji bin `🗑` in a dark-mode UI at 12px is jarring next to the precision of the rest of the iconography.

6. **The page-level information architecture has a silent gap: there is no page title, breadcrumb, or persistent page header inside the main content area.** The sidebar nav has active state but the content area opens without a persistent landmark. Every page re-renders its own `<h1>` in different styles (Dashboard: `clamp(34px,5vw,52px)`, Mapping: `clamp(26px,3.6vw,40px)`, Sources: `clamp(40px,5.6vw,56px)`). These three font-size clamp ranges are inconsistent with each other and make the product feel like three unrelated screens rather than one coherent app.

---

## 2. Design System Gaps

### 2a. Color token gaps

**Missing: a `--surface-elevated` token** for menus, dropdowns, tooltips, and popovers that need to read above the card layer. Currently these surfaces all use `--surface` or `--surface-2` — the same tokens as cards — so floating UI and base surfaces are indistinguishable by color alone.

Proposal:
```
dark:  --surface-elevated: #1E2840   (sits above --surface-2: #161E30, below --surface-3)
light: --surface-elevated: #FFFFFF   (same as --surface in light)
```

**Missing: a `--surface-canvas` alias for the `zz-canvas` bg color** so it can be referenced without knowing that the canvas is `--bg`. The app is already doing `bg-bg` in some places (`ComboSelect`, `Login`) and `zz-canvas` in the main content area — these aliases diverge without a single canonical token.

**Proposed evolution of surface ramp (dark):**
| Token | Current hex | Proposed hex | Delta |
|---|---|---|---|
| `--bg` | `#080B14` | `#080B14` | unchanged |
| `--surface` | `#0E1422` | `#0F1526` | +1 step |
| `--surface-2` | `#161E30` | `#162035` | widen gap |
| `--surface-3` | `#202B44` | `#1E2840` | pull back, less blue-shifted |
| `--surface-elevated` | (missing) | `#252E48` | new — for menus/popovers |

The key change is widening the `surface` → `surface-2` perceptual gap from ~6% to ~9% L in oklch, which makes card vs. canvas hierarchy read without relying on borders alone.

**Missing semantic state tokens:**
- `--committed` / `--committed-soft`: a distinct "published" state that is differentiated from the in-progress "mapped draft". Proposal: use a cooler teal-adjacent green rather than the warm `--ak-ok: #1F9D6B`. E.g. `--committed: #0E9F8A`, `--committed-soft: color-mix(in srgb, #0E9F8A 12%, transparent)`.
- `--staged` / `--staged-soft`: amber that reads distinctly from `--ak-warn` (which the app also uses for "needs review" badges). Currently both the "this value has a pending draft" state and the "this dimension needs review" state use `warn` tone — they should diverge. Proposal: keep `warn` for attention/alerting, introduce `--staged: #C47C18` (slightly more saturated ochre) for in-flight workflow state.

**The accent-2 / amber (#F0A323 dark / #C68410 light) is used in exactly one place** (the `★` suggestion indicator in ComboSelect and the bottom-left corner glow on the canvas). This token earns its keep on the canvas atmospheric gradient but the `★` usage in the dropdown is tiny and hard to read at 12.5px. Either increase its usage to become a true secondary accent or replace the `★` with the existing `--accent-soft` wash.

### 2b. Typography scale gaps

**Missing a 14px step.** The jump from `--ak-fs-sm: 13px` to `--ak-fs-md: 15px` skips the most useful body density size. Add:
```
--ak-fs-base: 14px;
```
This slot covers: table cell body text, form field body text, sidebar nav items (currently 13px, which reads slightly small at high resolution), and the ComboSelect trigger text (currently 12.5px hardcoded in the component, bypassing the scale).

**`tabular-nums` usage is inconsistent.** The class is correctly applied on count badges, KPI values, row counts in the Mapping workbench, and the coverage percentage. It is missing from: the audit log timestamps (`.tsx` uses `text-[10px]` without `tabular-nums`), the staged-draft review list line, and the Settings matching-defaults threshold readout.

**Line-height is not tokenized.** The kit uses `line-height: 1.55` on body as a reset, but individual components set ad-hoc line heights: the masthead description uses `leading-[1.5]`, the `zz-canvas` node labels use default leading, the ExpandedDrill unmapped-sample list has no explicit leading. Add two tokens:
- `--lh-tight: 1.25` — for display headings and tight-packed UI
- `--lh-reading: 1.55` — default (already body default)
- `--lh-code: 1.65` — for mono blocks (already correct in `.ak-code`)

**Weight ladder has a gap in the display family.** The app uses `font-extrabold` (800) on page headings and `font-semibold` (600) on cards, with nothing at 700 used in display text. The dashboard masthead `h1` at 800 and the Card section headers at 600 are separated by too many steps. Adding a `font-bold` (700) tier for sub-section headings (e.g. "Mapping seeds", "Activity" card titles) would tighten the hierarchy.

### 2c. Spacing and density

**The `--ak-space-*` scale stops at 8 steps (4→64px).** A step at `--ak-space-4b: 20px` would cover the frequent pattern of `gap-5` (20px) that appears in flex containers across Sources and Dashboard. Currently `gap-5` maps to Tailwind's default 20px, not an `ak-space` token, creating a silent inconsistency.

**Row height in the DataGrid is `py-[7px]`** (14px total vertical + border) making effective row height approximately 34px. This is appropriate for dense data. The Mapping workbench rows use `py-2.5` (10px each = 20px total) making them 52px rows — significantly taller than the DataGrid. The two workbenches in the same product should use the same density tier or explicitly signal that one is a "reading surface" and one is a "editing surface" through the row height differential.

### 2d. Elevation / shadow scale

Only one shadow token exists: `--shadow: 0 30px 70px -42px rgba(0,0,0,.72)`. This is a marketing/card-lift shadow. The app needs three tiers:

```css
--shadow-sm:  0 1px 4px rgba(0,0,0,.18), 0 0 0 1px rgba(255,255,255,.04);  /* inline menus, tooltips */
--shadow:     0 8px 24px -8px rgba(0,0,0,.40);                               /* cards, panels (replace current) */
--shadow-lg:  0 24px 60px -20px rgba(0,0,0,.60);                            /* modals, command palette */
```

The current `0 30px 70px -42px` spread is extreme — it creates a visible halo on cards in the light theme that reads as a fuzzy artifact, not a refined elevation.

### 2e. Motion scale

The motion system is good but has one inconsistency: `--ak-dur: .18s` is used for all UI transitions (buttons, nav links, input borders). The segmented control indicator uses `duration-300 ease-[cubic-bezier(.32,.72,0,1)]` — a custom spring-like ease — without being tokenized. Add:

```css
--dur-fast:   120ms;   /* hover states, button press */
--dur-base:   180ms;   /* current --ak-dur, default UI */
--dur-slide:  300ms;   /* panel slides, segmented controls, drawers */
--ease-spring: cubic-bezier(.32,.72,0,1);  /* the spring already used in mapping */
```

---

## 3. Per-Screen Findings

### 3a. Login screen
**File:** `app/src/routes/Login.tsx`

**Current state:** A minimal centered card (max-w-sm, p-8) with the Mark logo, wordmark, a subtitle "Master data reconciliation · Zugzug", error banner, and a Google sign-in button. Uses inline `style` props with `var(--bg)` rather than Tailwind utilities. The `rounded-lg` on the card conflicts with the rest of the app's square-mode global override (`--r: 0px`), so the login card is the only rounded surface in the entire UI.

**Issues:**
- `rounded-lg` at line 28 will compute to `--r-lg: 0px` in the global square override, making the card square-cornered. However the `border-[var(--line)]` uses the CSS var directly rather than `border-line`, bypassing Tailwind. This inconsistency means if a different theme ever changes `--line`, the login card might not respond.
- The subtitle "Master data reconciliation · Zugzug" reads as a client-specific tagline baked into code. It's in a generic `text-[13px]` with `--ink-2` color, carrying no visual weight.
- No illustration, no signal of what the product does. Every paid tool (Linear, Vercel, Retool) uses the login gate to reinforce brand identity.
- Error state: `rounded-sm border px-3 py-2 text-[13px]` inline style — bypasses the badge/alert kit components.
- The Google sign-in button has no hover state differentiation (just `hover:bg-[var(--hover)]`) and is visually identical to a generic secondary button. The Google wordmark is in full brand color which creates a colorfulness conflict against the dark background.

**Proposed upgrade (S effort):**
- Replace the `rounded-lg` card with the standard `.ak-card` surface (which already uses `--r-lg` and will honor the square override correctly).
- Replace inline `style` props with `bg-surface border-line text-ink` Tailwind utilities.
- Replace the error `<p>` with `<div className="bg-danger-soft border border-danger/40 text-danger rounded-sm px-3 py-2 text-[13px]">`.
- Replace the subtitle with the mono kicker style: `font-mono text-[11px] uppercase tracking-[0.18em] text-ink-3`.
- Add the `zz-canvas` background behind the card to carry the brand atmosphere into the auth gate.

---

### 3b. App shell (sidebar + topbar)
**File:** `app/src/components/AppShell.tsx`

**Current state:** Two-column grid layout. Sidebar is `bg-surface border-r border-line` with a logo row, a mono kicker ("Master data layer"), a ZigRule decoration, nav links, and a "Connected" footer dot. Topbar is `bg-[var(--ak-glass)]` (82% transparent bg) with backdrop-blur, containing the collapse toggle, theme toggle, and user menu.

**Issues:**
- **Sidebar width** is `--ak-nav: 248px`. This is fine but the nav links at 13px with 8px vertical padding (`py-2`) are short — they have a click target of ~34px total height. Minimum accessible click target is 44px. Most premium tools use 36–40px minimum for nav items.
- **Active state left indicator**: `shadow-[inset_2px_0_0_var(--accent)]` is a good choice but 2px is very thin and disappears at some DPI settings. 3px is the standard for selected nav items (Linear uses 3px).
- **The ZigRule decoration** (`ZigRule` SVG) is a charming brand touch but at `h-2 w-24` (8×96px) it is extremely small and low-contrast (`text-accent` at 8px height). It either needs to be larger and more purposeful, or removed in favor of a simpler divider.
- **The mono kicker "Master data layer"** above the ZigRule is correct in principle but the text at `text-[10px] tracking-[0.22em]` uppercase is already rendered in three other places on the app (every page header uses the same style). This specific instance in the sidebar is the right place for the product sub-title, but it's not visually distinct from the page-level kickers.
- **UserMenu** (`AppShell.tsx:56–88`): The dropdown uses `min-w-[160px] rounded-sm border border-line bg-surface shadow-md`. The `shadow-md` here is a Tailwind default shadow that is not driven by any `--shadow-*` token, breaking the single source of truth. The sign-out button uses `w-full px-3 py-2 text-left text-[13px]` — it should use the `.ak-menu button` pattern for consistency.
- **Topbar collapse toggle**: `h-8 w-8` (32px) with `border border-line-2`. The icon is `IconChevron` at `h-3.5 w-3.5` — 14px — which is on the small side inside a 32px container with no padding guidance. The toggle direction logic (`collapsed ? "-rotate-90" : "rotate-90"`) rotates the chevron sideways; a left/right chevron (`←/→`) is more immediately readable for a sidebar collapse affordance.

**Proposed upgrades:**
- Increase nav link `py-2` to `py-2.5` (10px each side = 40px total row height) — M effort.
- Change `shadow-[inset_2px_0_0_var(--accent)]` to `shadow-[inset_3px_0_0_var(--accent)]` — S effort.
- Replace `shadow-md` in UserMenu with `shadow-pop` (the token-backed shadow) — S effort.
- Replace UserMenu dropdown markup with `ak-menu` class-driven approach — M effort.

---

### 3c. Dashboard
**File:** `app/src/routes/Dashboard.tsx`

**Current state:** Masthead with large `h1`, a mono kicker with `[ master data ]` bracket decoration, inline status bar (live dot + counts), a primary "Resolve N new" CTA button. Below: a 4-column KPI row, an optional "Staged for review" card, and a two-column layout of "Mapping seeds" + "Activity" feed.

**Issues:**
- **The masthead font-size** `clamp(34px,5vw,52px)` tops out at 52px. This is the correct range for a display heading in an application. But the text itself, "Value mapping overview", is a description of a feature rather than a user-oriented page landmark. Compare: Linear says "My Issues", not "Issue tracking overview". Consider "Reconciliation" or just the workspace name.
- **`[ master data ]`** bracket decoration: the `<span className="text-accent">[ </span>` and `<span className="text-accent"> ]</span>` add visual noise without adding meaning. The accent color on brackets carries no semantic signal and is purely decorative. In the paid-product register this pattern reads as "a designer used brackets from a code editor theme" rather than a deliberate typographic decision.
- **The KPI row** (`Kpi.tsx`) uses `zz-tab` which adds a 2px accent top-connector. This is a strong brand motif but when four consecutive KPI cards all have the same connector it flattens the "junction" metaphor — the connector is only meaningful when pointing at something singular, not a grid of four identical items.
- **Mapping seeds progress bars** are `h-1.5 w-40` (6px tall, 160px wide, fixed width). On a fluid layout, fixed-width progress bars create orphaned whitespace to the right. Use `flex-1 min-w-0 max-w-[160px]` to let them breathe.
- **Activity feed timestamps** (`text-[10px] text-ink-3`) are too small and too faint. 10px text at `--ink-3: #5B6884` fails WCAG AA on `--surface: #0E1422` (contrast ratio ~3.0, needs 4.5 for small text). The timestamps should be at least 11px.
- **The "Staged for review" card** uses `icon={<IconArrowRight />}` on the "Review & commit" button — an arrow right at this context means "go to" not "review", which is correct navigational semantics but loses the urgency of the commit action. A `IconCheck` or `IconWand` might better signal the intent.
- **Empty state for Activity**: when `auditLog` is empty, no empty state renders — the card simply has no `<li>` items, leaving a header with no body. Needs a proper empty state (`ak-empty` pattern).

---

### 3d. Mapping workbench
**File:** `app/src/routes/Mapping.tsx`

This is the highest-density and most interaction-rich screen. The recent polish (sliding segmented control, keyboard shortcuts, cross-dim inbox) is excellent.

**Issues:**
- **The COLS grid definition** at line 42: `"grid grid-cols-[28px_minmax(160px,1.3fr)_22px_minmax(160px,1.1fr)_88px_84px]"`. The arrow column is `22px` — correct — but it doesn't scale with viewport, so at narrow widths the "Source value" column compresses to below 160px min while the arrow stays 22px. The `_22px_` slot should be `auto` with a fixed icon wrapper inside.
- **Coverage bar** in the stats panel is `h-1.5 w-36` (6px × 144px). Same fixed-width issue as Dashboard. The stats panel itself (`rounded-lg border border-line bg-surface px-5 py-4`) is good but the bar sits with right-hand padding that could house a `${coverage}% mapped` label instead of having it beside the bar.
- **Confidence mini-bar** (`h-1 w-8`) at 4px tall, 32px wide is too small for reliable reading. A percentage number alone in `confText()` color would be more scannable at this density. Alternatively, render the bar taller (h-1.5) with a tooltip.
- **The workbench container focus ring** (`focus:ring-1 focus:ring-accent/40`) is a single pixel at 40% opacity — barely visible against the border. The focused workbench should use `focus-visible:ring-2 focus-visible:ring-accent/60` to confirm keyboard takeover.
- **Empty state when fully matched**: the "fully matched" state uses an emoji `🎉` inline in a `div`. This is the one place in the app where emoji appears in meaningful content (vs. iconography). The Mark SVG or a simple `IconCheck` would maintain visual consistency.
- **The Review panel** (the staged drafts list that drops down from the footer) uses `divide-y divide-line` with `px-5 py-2.5`. This list has no maximum height, so committing 50+ staged drafts would push the commit button off-screen. Add `max-h-64 overflow-y-auto`.
- **"nothing to publish yet" footer state**: the mono text at 11px at `text-ink-3` fails the WCAG AA contrast threshold on `--surface: #0E1422`. Use `text-ink-2` for footer idle states.
- **The SQL preview panel** (`overflow-x-auto border-t border-line bg-bg px-5 py-4 font-mono text-[11.5px]`) is a raw `<pre>` with no syntax highlighting. Even two-color highlighting (keyword in `text-accent`, value in `text-ink`) would make the SQL legible. The `.ak-code` class already has `.tok` and `.com` tokens.
- **Cross-dim inbox column header**: `COLS_CROSS` defines a `120px` first column for "Dimension". The Chip rendered there (`<Chip label={r.dimName} bucket="chip-3" />`) at 13px mono in a 120px column will truncate for dimension names longer than ~10 characters. Use `minmax(100px, auto)` to let the chip size breathe.

---

### 3e. Tables (MasterTables)
**File:** `app/src/routes/MasterTables.tsx`

**Current state:** A dimension picker (TablePicker), a stats bar, a selection/action bar above a DataGrid, and a per-row expandable variants drawer below. The DataGrid is a full-featured spreadsheet-like component.

**Issues:**
- **The stats bar** at `rounded-lg border border-line bg-surface px-5 py-4 font-mono text-[11px]` is visually identical to the coverage bar in the Mapping screen. These two screens should share a single `StatsBar` component rather than duplicating the pattern. Inconsistency risk: the Mapping stats bar uses `gap-x-6 gap-y-3` while the Tables stats bar uses `gap-x-6 gap-y-2`. 2px difference is invisible but signals drift.
- **The "Tip — select two or more records to merge them into one"** text in the selection bar is 11.5px mono `text-ink-3`. This is teaching text, not status text. It should either be inside a tooltip/help affordance or be a more prominent inline hint that disappears once the user has ever done a merge.
- **Inline record name editing** (`c.edit` renderer in columns): the edit input uses `border border-accent bg-bg px-2 py-1 font-display text-[14px]` inline in a DataGrid cell. The `bg-bg` makes the input background jump to the canvas color inside a `bg-surface` row, creating an intrusive dark rectangle. Use `bg-transparent border-b-2 border-b-accent` (underline-only edit affordance) for inline editing to minimize visual disruption.
- **Variants drawer** (the "raw values mapped to X" expandable): raw value chips use `rounded-sm border border-line-2 bg-surface px-2 py-1 font-mono text-[11.5px] text-ink-2`. These are close to the standard `.ak-badge` pattern but not quite — they use `bg-surface` (not `bg-surface-2`) and `border-line-2` (not `border-line`). This is a minor inconsistency that should use the Badge component's neutral tone.
- **DataGrid "👁 N hidden" chip** (DataGrid.tsx:562): uses a Unicode emoji `👁` in a button with `text-[12px]`. This is the one remaining Unicode-icon usage after the ColumnHeaderMenu. Replace with the `IconFieldText` or a new `IconEye` SVG icon from the existing icon set.
- **"+ Field" button** in the DataGrid header uses `text-[12px] font-medium text-ink-3` — this is a primary CTA for schema editing and should be more visually prominent, at minimum matching the `text-accent` color used for creation affordances elsewhere.
- **Add record input at the bottom** uses a bespoke `className` (`rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[12.5px]`) rather than the `.ak-input` class. Diverges from the form input system.

---

### 3f. Sources
**File:** `app/src/routes/Sources.tsx`

The Sources screen is the most architecturally mature of all screens — the Ledger Surface concept, Standing callout, schema grouping, sticky toolbar, and coverage hairline bar are all strong product ideas.

**Issues:**
- **The sort `<select>` element** (`value={sort} onChange=… className="border-0 bg-transparent text-[12.5px] text-ink-2"`) is a native `<select>` with `appearance: auto` visible. The surrounding toolbar uses custom styled filter chips, so this native select looks jarring: different height, different rendering engine, different text alignment. Replace with a three-button segment (matching the filter chip pattern) or a custom dropdown using the `ak-menu` pattern.
- **Standing callout**: `border-l-2 border-l-accent bg-accent-wash px-7 py-5`. The left border alone is used as a priority indicator in four other places across the app (derived notification in Sources, notice flash in MasterTables, an inline note in Settings). These left-border highlights all use slightly different widths (`border-l-2`, `border-l-2`, `border-b border-l-2` etc.) and different padding. This pattern needs to be a shared component.
- **Coverage hairline bar** at the bottom of each `LedgerRow`: `pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line` with a colored inner div. This is a creative and effective data display. However it shares `h-px` with the row separator, so the progress fill and the separator border merge visually when coverage is 100% and tone is `bg-ok` — a green line that looks like a separator. Use `h-[2px]` to create vertical separation from the 1px border.
- **Schema headers** use `bg-surface-2/60` at 60% opacity — this creates an inconsistent intermediate background that is neither fully surface-2 nor surface. On Firefox, partial opacity on background can cause composite-layer issues. Use a solid color calculated at design time: `--surface-2` at 60% over `--surface` in dark = approximately `#131B2C` — add this as a new token or use solid `bg-surface-2` without the opacity modifier.
- **The "Nothing requires a decision today" italic state** (`font-display text-[18px] italic text-ink-2`) is a nice editorial touch. But `italic` on `Bricolage Grotesque` (a variable display font) may not have a true italic axis — check the font's axis map. If no italic axis, the browser will synthesize italics (slant transformation), which degrades the font quality noticeably.
- **CatalogExplorer (Sources > Browse warehouse)** uses `bg-bg shadow-2xl` for the modal container. `shadow-2xl` is a Tailwind default, not a design token — use `shadow-pop` or the proposed `--shadow-lg` token.
- **EmptyState for zero sources** (`NoTablesYet` equivalent): the Sources `EmptyState` component uses a `<div>` with `font-display text-[20px] italic text-ink-2` and a paragraph. This has no icon, no visual weight, and the italic style (same issue as above) carries the full communicative burden. Add an icon (`IconSources` at 40×40) and a proper CTA button.

---

### 3g. Settings
**File:** `app/src/routes/Settings.tsx`

**Current state:** A max-w-3xl column of Card-wrapped sections (Workspace, Appearance, Connections, Matching defaults, Team). Clean and functional.

**Issues:**
- **The `Field` component** (`label` span in `font-mono text-[11px] uppercase tracking-wider text-ink-3`) is an inline function, not a shared component. The equivalent in the Mapping and MasterTables screens use ad-hoc inline `div` labels. The `Field` component here is the right pattern and should be promoted to a shared `FormField` component in `components/`.
- **Connections cards** use a bespoke `rounded-sm border border-line bg-bg p-4` pattern. The `bg-bg` (canvas color) inside a `bg-surface` card creates a subtle but correct nested surface. This is good — it creates a second-level nesting. But it uses `bg-bg` directly rather than `bg-surface-2` (the correct semantic for a nested surface). If the light mode ever changes `--bg` to a non-white value, these cards would lose their legibility.
- **The engineer toggle** uses a bespoke toggle markup (a `<button>` with a `<span>` pair) rather than the `.ak-toggle` class from the kit, which is already token-driven and has correct `on/off` state management. The bespoke version uses `border-accent bg-accent` vs `border-line-2 bg-surface-2` but the thumb uses `bg-surface` — on dark mode this works but in light mode `--surface` is white and the thumb would be invisible against a white background. The kit's `.ak-toggle::after` uses `--ink-2` for the thumb, which adapts correctly.
- **"Save changes" button** — the `saved` state feedback is `font-mono text-[12px] text-ok "✓ saved"`. The `✓` is a Unicode tick character. Using `<IconCheck />` at 12×12 would be consistent with the rest of the icon system.
- **Team section empty state**: `<li className="px-4 py-3 text-[13px] text-ink-3">No members yet.</li>` has no CTA pointing at the email input below it. A micro-annotation "Add a team member below" with an arrow pointing down would remove the cognitive gap.
- **ThresholdRange**: this component is not in the audit scope files requested, but its rendering inside Settings introduces a color (`bg-accent` on the thumb, `bg-danger/30` on the danger zone) that are component-internal. Worth verifying the range track uses the semantic tokens, not hardcoded values.

---

### 3h. Datagrid column-header menu
**File:** `app/src/components/datagrid/ColumnHeaderMenu.tsx`

**This is the highest density of icon-system violations in the codebase.**

Line 80: `✎ rename column` — Unicode pencil  
Line 81: `⇅ change type` — Unicode double arrow  
Line 83: `↑ sort A→Z` — Unicode arrow  
Line 84: `↓ sort Z→A` — Unicode arrow  
Line 86: `✕ clear sort` — Unicode multiplication sign  
Line 89: `⊘ hide column` — Unicode prohibited sign  
Line 90: `🗑 delete column` — Emoji wastebasket  
Line 103: `bg-accent text-accent-ink hover:bg-accent` on the save button is correct but `hover:bg-accent` is a no-op — add `hover:brightness-110` to show the hover.  
Line 119: `← back` — Unicode left arrow  
Line 125: `delete` button uses `bg-danger text-white` — correct, but `text-white` is a literal color, not a token. Use `text-accent-ink` (which is `#fff` for danger's contrast requirements) or add a `--danger-ink: #fff` token.

**The entire icon set in this menu should be replaced with inline SVG from the existing Icons.tsx pattern:**
- `IconEdit` (already exists) for rename
- `IconFieldSelect`/`IconFieldText` (already exists) for type
- Sort up/down glyphs need new `IconSortAsc` / `IconSortDesc` icons
- `IconX` (already exists) for clear sort
- A new `IconHide` for hide column
- A new `IconTrash` for delete

---

### 3i. ComboSelect
**File:** `app/src/components/ComboSelect.tsx`

**Current state:** A button-triggered dropdown with a search input. Used pervasively in Mapping and MasterTables.

**Issues:**
- **The trigger** (line 54–61): when `value` is null and a `suggestion` is present, it renders `${suggestion}?` in `font-mono text-ink-3` with dashed border. This is a good affordance but the `?` suffix is unusual — in standard UI patterns, a suggested/pre-filled value is shown with a distinct fill or left-border indicator, not a `?` appended to the text.
- **Focus management**: when the dropdown opens, `autoFocus` on the search input is correct. But when the user selects a value and the dropdown closes (line 44 `setOpen(false); setQ("")`), focus returns to... nowhere. The trigger button is not re-focused. This breaks keyboard flow — the user has to tab back to the next field after every selection.
- **Dropdown positioning**: the dropdown uses `absolute left-0 z-50 mt-1 w-60` — it always drops left-aligned. In the Mapping workbench, some ComboSelect instances are in the rightmost columns of a wide table and the dropdown overflows the viewport right edge. The dropdown should check available space and flip to right-aligned.
- **The "★" suggestion indicator** (line 88): a bold orange star `text-accent-2` at 12.5px is hard to see and has no tooltip. Replace with a more readable `<span className="font-mono text-[10px] text-accent-2 uppercase tracking-wider">suggested</span>` or use the existing Badge component in `tone="neutral"` with the accent-2 color.
- **List item density**: `py-1.5` (6px each = 12px total) per item. At 12.5px type, this creates 24px item height — slightly cramped for touch targets but fine for desktop. Consistent with the rest of the app.

---

## 4. Interaction and Motion

### 4a. Missing microinteractions

**Commit flash** (Mapping footer): the success state `✓ {flash.n} changes published · {flash.rows.toLocaleString()} rows recovered` currently appears as a text swap. The `flash` state is set then cleared after 2800ms — no animation in or out. Add a `zz-rise` enter animation and a fade-out CSS transition on the text container. The token `--ak-dur: .18s` is available.

**Checkbox state transitions**: the Checkbox component (not fully read but used extensively) appears to use instant state changes — checked/unchecked with no visual intermediate. A 120ms fill transition on the checkbox check mark would soften the binary snap, especially in the bulk-select flows where many rows change simultaneously.

**ComboSelect dropdown open/close**: the dropdown (`absolute... mt-1 w-60`) has no entry or exit animation. Add:
```css
@keyframes zz-pop-in { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
```
at `--dur-fast` (120ms). The `.zz-drawer` animation at 280ms is already defined and available; a shorter version for small popovers would be appropriate. Map this to a `zz-dropdown` CSS class.

**TablePicker dropdown**: same issue as ComboSelect — no entry animation. The dropdown appears instantly, which at 320px wide on an already-busy screen feels jarring.

**Row focus keyboard advance** (Mapping): when pressing `A` to accept and advance to the next row, the cursor moves but there is no visual indication of which row just got acted on. A brief `bg-ok-soft` flash on the acted row (150ms → fades to normal) would confirm the action without interrupting the user's flow through the inbox.

**Staged draft row appearance**: in the review panel footer, newly-staged drafts appear instantly when the user accepts a value. They should slide into the list from the top with a `zz-rise` variant at 200ms delay to reinforce the "this just happened" mental model.

### 4b. Missing loading states

**Dashboard KPI cards**: on initial load, the four `Kpi` components are rendered with static `metrics` data from `data.ts`. When connected to a real backend, they will need skeleton loaders. The `.ak-skeleton` class exists in the kit and is available. The Kpi component should accept `loading?: boolean` and conditionally render a `<div className="ak-skeleton h-8 w-24 rounded-sm">` in place of the value.

**MasterTables variants drawer**: `loading…` is a plain text string (line 425 MasterTables.tsx). Replace with two `.ak-skeleton` lines at 11px height + 60% and 40% widths to match the typical variants content shape.

**Sources scan button**: the `scanning ? "Scanning…" : "Scan all"` text swap is abrupt. Add an `ak-spinner` inline icon during scanning that replaces the `IconWand` icon in the button.

### 4c. Optimistic UI gaps

The draft system is already optimistic by design (drafts persist in-memory via the store). But the `commit()` call is not optimistic — the button shows the current count until `commit()` resolves, then the flash appears. Consider: optimistically clear the staged count and replace the footer with the flash state immediately on button press, reverting on error (with the existing `commitError` state). The server round-trip at 20–100ms is barely perceptible but the current UX gap (button press → nothing → flash) creates ~100ms of ambiguity.

---

## 5. Brand Direction Options

Three distinct directions, each coherent from token level to page layout. The current design sits closest to Option B but leans toward A in the typography.

---

### Option A: "Warm Editorial — The Data Newspaper"

**Character:** Airtable meets the NYT Data desk. High contrast, editorial weight, generous whitespace, typographically opinionated. Every screen feels like it was typeset by a designer who cares about reading rhythm.

**Changes from current:**
- Replace `Bricolage Grotesque` display font with `DM Serif Display` for headings (a more classically editorial voice). Keep `Hanken Grotesk` for body. Keep `JetBrains Mono` for data.
- Widen line-height to 1.6 for body copy, tighten headings to 1.0.
- Change the background from `#080B14` to `#0A0D17` (cooler, more neutral — removes the blue cast). Surface steps become warmer: `--surface: #111520` (warm-tinted neutral).
- Replace the accent `#D6336C` with `#E04F25` (a refined rust/terracotta) — warmer, less nightclub.
- Keep the square-mode corner treatment (important brand signal).
- Add a newspaper-column layout to the Dashboard with a full-width "Today's standing" banner spanning the full content width.
- Card borders become `border-2px` solid rather than 1px hairline, giving a blockprint quality.

**Tradeoffs:**  
Strong personality. Risk: can read as "too editorial" for a data tool where users expect maximum information density. The serif display font in a dark-mode environment needs careful contrast management.

---

### Option B: "Linear-Precise — The Engineer's Console"

**Character:** The current direction, refined. Precision, density, zero ornamentation. Closer to Linear, Vercel, or Raycast than to Airtable. Every pixel serves information. The product looks like it was built by engineers for engineers but with the understanding that appearance communicates competence.

**Changes from current (the delta to reach this):**
- Keep the exact color tokens as-is, with the surface ramp fixes from Section 2a.
- Extend the icon system (add IconSortAsc, IconSortDesc, IconTrash, IconHide, IconEye) to eliminate all Unicode glyphs.
- Implement the three-tier shadow scale (Section 2d).
- Add the `--dur-fast / --dur-base / --dur-slide` motion tokens and apply them consistently.
- Increase nav item click targets to 40px.
- Remove the `[ master data ]` bracket decorations from the Dashboard masthead.
- Add a proper empty-state illustration system: thin-line SVG illustrations at 80×80, using `--accent` and `--line-2`, not full-color art. One per major empty state (no tables yet, everything matched, no sources, etc.).
- Replace the `zz-tab` connector-tab on every KPI card with a single left-border accent on the highest-value KPI only.

**Tradeoffs:**  
This is achievable in 2–3 weeks of focused work. The risk is it stays in the "competent but anonymous" zone. The brand needs one more memorable surface gesture to break out of that.

---

### Option C: "Data-Dense Engineer-First — The Terminal Elevated"

**Character:** Hex is a good reference: dense, monospaced where it counts, warm color palette, lots of surface hierarchy, deliberate use of borders as information. This direction leans into the fact that the users are data engineers who work in terminals and SQL clients. Make the app feel native to that world while still being beautiful.

**Changes from current:**
- Add a `--font-ui: "Berkeley Mono", "JetBrains Mono", monospace` — use a mono font (or mono-hybrid like Berkeley Mono) for ALL UI text, not just data. This is a high-commitment but high-character choice. Hex, Warp Terminal, and Ghostty do this.
- Change the surface palette to be warmer and slightly more saturated: `--bg: #0C0E16`, `--surface: #11141F`, `--surface-2: #171B2B`. This is a more "OLED-warm" space.
- Add a `--gutter: 1px solid var(--line)` horizontal rule between every major section (like a ledger book). Currently sections are separated by `space-y-8` alone; adding the hairline gives a spreadsheet/ledger quality that is deeply appropriate for a master-data tool.
- Make the sidebar full-mono: all nav labels in `font-mono`, all counts in `font-mono tabular-nums`, schema names in uppercase mono.
- Add a persistent narrow status rail on the right edge of the main content (32px wide): shows real-time scan status, commit queue depth, and team presence dots. This is a paid-SaaS differentiator that makes the app feel "live" without consuming content real estate.
- Use `--tint-amber` as the primary accent instead of `--tint-rose` — amber/ochre reads as more "data terminal" than rose-pink.

**Tradeoffs:**  
Highest commitment. The mono-everywhere approach narrows the audience (power users and data engineers will love it; less technical stakeholders may find it intimidating). The right-rail status panel is a significant new feature that would need design + implementation. If the user base is internal data teams, this direction would set Zug Zug most apart from generic shadcn templates.

---

## 6. Quick Wins

Ordered by visible impact. Each is achievable in under one working day.

---

**QW1: Replace all Unicode glyphs in `ColumnHeaderMenu` with proper SVG icons**  
Location: `app/src/components/datagrid/ColumnHeaderMenu.tsx:80–130`  
Current: `✎`, `⇅`, `↑`, `↓`, `✕`, `⊘`, `🗑`, `←` inline in button text  
Proposed: Add `IconEdit`, `IconSortAsc`, `IconSortDesc`, `IconX`, `IconHide`, `IconTrash`, `IconChevronLeft` to `Icons.tsx` and replace the Unicode glyphs. The items should use the `flex items-center gap-2` pattern already used in the rest of the menu items.  
Effort: S (2–3 hours)  
Impact: HIGH — this is the first menu many data engineers will use repeatedly; Unicode emoji in a dark-mode precision tool signals "prototype" not "product"

---

**QW2: Fix the three surface-ramp inconsistencies that cause flatness**  
Location: `app/src/tokens.css:5–12`  
Current: `--surface: #0E1422`, `--surface-2: #161E30` (delta too small)  
Proposed: Increase surface-2 to `#172035` and add `--surface-elevated: #232C44` for menus/popovers. Update both `:root` (dark) and `[data-theme="light"]` blocks.  
Effort: S (1 hour, including QA across all screens)  
Impact: HIGH — immediately adds depth to the card-over-canvas composition without changing any component code

---

**QW3: Fix the `shadow-md` / `shadow-2xl` / `shadow-lg` breakouts — use `shadow-pop` everywhere**  
Locations:  
- `AppShell.tsx:70` — UserMenu: `shadow-md`  
- `CatalogExplorer.tsx:58` — modal: `shadow-2xl`  
- `ColumnHeaderMenu.tsx:76` — `shadow-lg`  
- `HiddenFieldsPopover.tsx:61` — `shadow-lg`  
Current: Each floating surface uses a different Tailwind default shadow  
Proposed: All floating surfaces use `shadow-pop` (the `--shadow` token). Adjust the token to be a three-tier value per Section 2d.  
Effort: S (30 minutes to find + replace, 1 hour to tune the shadow token)  
Impact: MEDIUM — creates visual consistency; shadow rendering was slightly different across surfaces

---

**QW4: Add `tabular-nums` to missing numeric contexts**  
Locations:  
- `Dashboard.tsx:137` — `text-[10px] text-ink-3` timestamp in Activity feed  
- `Mapping.tsx:751` — staged review list timestamps  
- `Sources.tsx:396` — schema header row count  
Current: No `tabular-nums` on timestamps and some row counts  
Proposed: Add `tabular-nums` class (already in Tailwind via the token bridge) to each numeric/timestamp context  
Effort: S (30 minutes)  
Impact: MEDIUM — subtle but signals craft; timestamps that subtly shift width when seconds/minutes change are a dead giveaway of unfinished UI

---

**QW5: Add re-focus after ComboSelect selection**  
Location: `app/src/components/ComboSelect.tsx:43–47`  
Current: `choose()` calls `onPick(v); setOpen(false); setQ("")` with no focus management  
Proposed: Add a `ref` to the trigger button and call `triggerRef.current?.focus()` after closing  
Effort: S (15 minutes)  
Impact: HIGH — the Mapping workbench is keyboard-operated; losing focus after every pick is the primary friction point in the keyboard flow. This change directly improves the core task.

---

**QW6: Replace the native `<select>` sort control in Sources with styled buttons**  
Location: `app/src/routes/Sources.tsx:308–311`  
Current: `<select value={sort} onChange=… className="border-0 bg-transparent text-[12.5px] text-ink-2">` — native browser select  
Proposed: Three inline buttons using the same filter-chip pattern as the status pills above:
```tsx
<div className="flex items-center gap-0.5 rounded-sm border border-line bg-bg p-0.5">
  {SORTS.map((s) => (
    <button key={s.k} type="button" onClick={() => setSort(s.k)}
      className={cx("rounded-sm px-2.5 py-1 text-[12px] transition-colors",
        sort === s.k ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2")}>
      {s.label}
    </button>
  ))}
</div>
```
Effort: S (20 minutes)  
Impact: MEDIUM — the native select is the single largest visual inconsistency in the Sources toolbar

---

**QW7: Add `max-h-64 overflow-y-auto` to the staged-drafts review panel**  
Location: `app/src/routes/Mapping.tsx:746–761`  
Current: The `{review && staged.length > 0 && ...}` review panel has no maximum height  
Proposed: Add `max-h-64 overflow-y-auto` to the `<div className="border-t border-line">` wrapper  
Effort: S (5 minutes)  
Impact: MEDIUM — prevents the review panel from pushing the commit button off-screen for large commit sets

---

**QW8: Make the commit success flash animate**  
Location: `app/src/routes/Mapping.tsx:720–731`  
Current: The `flash` state text appears instantly; it just replaces the idle state copy  
Proposed: Wrap the flash `<span>` in a `<span className="zz-rise" style={{ animationDuration: "0.3s" }}>` so it rises in. Add `transition-opacity duration-[var(--ak-dur)]` to the outer `<span>` for the fade-out phase (controlled by setting `opacity: 0` on exit via a CSS class swap).  
Effort: S (30 minutes)  
Impact: MEDIUM — the commit action is the primary success moment in the product. It deserves celebration commensurate with its importance.

---

**QW9: Fix WCAG AA contrast failures on small text**  
Locations:  
- `Dashboard.tsx:137`: `text-[10px] text-ink-3` timestamps — `#5B6884` on `#0E1422` ≈ 3.0:1 (fails AA small text 4.5:1)  
- `Mapping.tsx:732`: idle footer `text-ink-3` at 11px — same contrast failure  
- `AppShell.tsx:181`: `text-[11px] text-ink` Connected label — passes at `--ink: #EAEEF7`, but the dot beside it is `bg-accent` at 6×6px = too small to count as meaningful indicator without a text label  
Proposed: Minimum `text-ink-2` for any text below 13px. `text-ink-3` should only appear on text 13px and above.  
Effort: S (30 minutes to audit + swap classes)  
Impact: HIGH — accessibility violations are a product quality signal; these specific instances are in high-traffic paths

---

**QW10: Restore rounded corners on `CreateTableModal` and `TablePicker` dropdowns**  
Location: `globals.css:139–142` and `TablePicker.tsx:76`, `CreateTableModal.tsx:115`  
Current: The global `--r: 0px` override in `globals.css` sets all `rounded-md` and `rounded-lg` to 0. But `TablePicker` uses `rounded-md` on its trigger and dropdown — these will now be square. `CreateTableModal` uses `rounded-lg` on the outer container — also square.  
Issue: The brand intends square corners (the override is deliberate per the comment). But the `--r-sm: 0px` makes checkboxes and small indicators also perfectly square. Fine for buttons and cards; problematic for `rounded-pill` elements that should stay pill-shaped (the `--r-pill: 999px` is correctly excluded from the override).  
Proposed: This is actually correct behavior — the brand is squared. But verify that `border-radius: 0` on the modal container doesn't look unintentional. If it does, change the modal to `rounded-none` explicitly to make the intent clear in code, and add a comment: "intentionally square — see globals.css square-mode override".  
Effort: S (15 minutes — mostly documentation and intent clarification)  
Impact: LOW-MEDIUM — clarifies intent and prevents future "bug" reports about missing border-radius

---

*End of audit. Total findings: 6 system-level, 47 screen-level, 10 interaction/motion, 3 brand direction options, 10 quick wins.*
