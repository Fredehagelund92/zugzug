# Zugzug — Design System

> The narrative layer for building UI that matches Zugzug's brand. Tokens are defined in code; this document explains *what to reach for and when*.

**Live source of truth:** [`app/src/tokens.css`](app/src/tokens.css) (CSS variables), [`app/src/app-kit.css`](app/src/app-kit.css) (utility layer), [`app/src/lib/palette.ts`](app/src/lib/palette.ts) (per-table tints), [`app/src/theme.ts`](app/src/theme.ts).
**Visual specimen / PDF leave-behind:** [`docs/brand-preview/`](docs/brand-preview/) — original brand book, kept as historical reference; the app has since evolved past it.

---

## 1. Identity

Zugzug is a **master-data layer for a DuckDB warehouse** — the place where messy source values converge on one canonical record you can trust.

The visual metaphor is a **control-room junction diagram**: source columns enter from many places and meet at a single canonical node. The signature ground is a faint lattice — node dots on a wide grid joined by hairline connectors. Every surface in the app should feel like it's wired into that diagram.

**Personality:** infrastructural, technical, calm. Not playful, not corporate, not "delightful." A data steward should feel they're operating a precise instrument, not browsing a SaaS landing page.

**Aesthetic anchors:** dark-first ground · cobalt-rose signal accent · amber source-lamp secondary · characterful Bricolage display set tight against utilitarian Hanken body · JetBrains Mono with `[bracket]` ornaments for cased labels.

---

## 2. Voice & Tone

Direct. Specific. Lowercase for state and microcopy; sentence case for actions. Never marketing.

| Good | Bad |
|---|---|
| `12 unmapped values in dim_country` | `Looks like there are a few things to review!` |
| `Commit 8 staged changes` | `Save your work` |
| `No tables yet — add one to get started` | `Welcome! 🎉 Let's get you set up.` |
| `Scan failed: connection refused` | `Oops, something went wrong` |

Empty states get a single emoji ornament (`🎉`) and a one-line directive on `text-ink`. No paragraphs.

Reference: [`feedback-coding-style`](.claude/projects/-Users-fhagelund-Documents-GitHub-zugzug/memory/feedback-coding-style.md) if present.

---

## 3. Color

All colors live as CSS variables. **Never hardcode hex in components.** Use `var(--token)` or the corresponding Tailwind `text-ink` / `bg-surface` class.

### Theme grounds (light + dark)

Dark is the lead look. Light is a genuine paper theme for stakeholder PDFs and users who prefer it.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#080b14` | `#f4f6fc` | Page background |
| `--surface` | `#0f1526` | `#ffffff` | Cards, panels, the default writable surface |
| `--surface-2` | `#182240` | `#eaeef7` | Nested surface (table rows on hover, secondary panels) |
| `--surface-3` | `#243056` | `#dfe5f2` | Deepest nesting (toolbar wells, code blocks) |
| `--surface-elevated` | `#2b3863` | `#ffffff` | Popovers, dropdowns, modals |
| `--ink` | `#eaeef7` | `#0c1020` | Primary text |
| `--ink-2` | `#9ba7bf` | `#48526a` | Secondary text, labels |
| `--ink-3` | `#5b6884` | `#8893a8` | Tertiary text, placeholders, disabled |
| `--line` | rgba w/.09 | rgba w/.11 | Default borders |
| `--line-2` | rgba w/.17 | rgba w/.20 | Strong borders, scrollbar thumb |

### Signal colors

| Token | Hex | When to use |
|---|---|---|
| `--accent` | `#d6336c` | The one brand accent. CTAs, focus rings, the live "flow" travelling toward the canonical node, link color. **One accent per view.** |
| `--accent-2` | `#f0a323` | Source-lamp secondary. Source-side decorations, "in-flight" highlights, things being scanned. Never used as a CTA. |
| `--accent-soft`, `--accent-2-soft` | color-mix 18% | Backgrounds, washes, hover halos |

### Workflow semantics (Zugzug-specific)

Master-data work has two states with no generic analogue. Don't reuse `ok`/`warn` for these.

| Token | Hex | Means |
|---|---|---|
| `--ak-committed` | `#0e9f8a` | Published to the master store. Cooler teal than `ok` green — these are *correct* AND *durable*. |
| `--ak-staged` | `#c47c18` | In-flight draft awaiting commit. Saturated ochre, not the alerting `warn` yellow. |
| `--ak-committed-soft`, `--ak-staged-soft` | color-mix | Row backgrounds, badge fills |

### Generic status

| Token | Hex | Means |
|---|---|---|
| `--ak-ok` | `#1f9d6b` | Generic success — scan completed, save succeeded |
| `--ak-warn` | `#c7901c` | Attention needed — threshold crossed, source overdue |
| `--ak-danger` | `#d7434b` | Destructive or failure state |
| `--ak-info` | `var(--accent)` | Informational, neutral guidance |

### Per-table tints

Master tables get an identifying color from a fixed seven-tint palette so users can recognize tables at a glance in tabs, breadcrumbs, and KPI cards. Tints are assigned by `app/src/lib/palette.ts`.

`--tint-rose · --tint-amber · --tint-mint · --tint-teal · --tint-indigo · --tint-violet · --tint-slate`

Light theme has darkened variants for contrast on paper.

### Brand constants (held across themes)

`--brand-ink #0c1020 · --brand-paper #f5f7fc · --brand-graphite #353d52 · --brand-mist #c4ccdc`

Use these for brand-marks, the logo wordmark, and any surface that must read the same in either theme (PDF cover pages, login).

---

## 4. Typography

Three families. No others.

| Family | Variable | Use |
|---|---|---|
| **Bricolage Grotesque** | `--font-display` | Headings, KPI numbers, brand-mark, anything > 22px |
| **Hanken Grotesk** | `--font-body` | Body text, UI labels, buttons, table cells |
| **JetBrains Mono** | `--font-mono` | Code, IDs, SQL, table/column names, cased `[bracket]` labels |

### Type scale (utility tokens from `app-kit.css`)

`--ak-fs-xs 12 · sm 13 · base 14 · md 15 · lg 18 · xl 24 · 2xl 32 · 3xl 46 · 4xl 64`

Body default is `md` (15px). Tables and dense UI run at `sm` (13px). Mono labels and metadata run at `xs` (12px).

### The `[bracket]` cased label

Cased mono labels carry `[bracket]` ornament across the brand. The brackets are in `--accent`. Use sparingly — section kickers, schema names, dimension IDs in headers. Not on buttons.

```css
.kick { font-family: var(--font-mono); font-size: 11px; letter-spacing: .2em;
        text-transform: uppercase; color: var(--ink-3); }
.kick::before { content: "[ "; color: var(--accent); }
.kick::after  { content: " ]"; color: var(--accent); }
```

### Display setting

Display headings are tight: `letter-spacing: -.03em` on `h1`, `-.02em` on `h2/h3`. Body and mono ship at default tracking.

---

## 5. Spacing, radius, layout

### Spacing scale

`--ak-space-1 4 · 2 8 · 3 12 · 4 16 · 5 24 · 6 32 · 7 48 · 8 64`

8px grid. Components compose on this — never use 5px, 7px, 13px gaps.

### Radius

`--r-sm 4 · --r 8 · --r-lg 12 · --r-pill 999`

Default radius is `8px`. Pills (`999px`) only on tags, switches, and the workspace switcher. Avoid radius > 12 except on hero cards in print layouts.

### Layout widths

`--maxw 1180 · --wide 1320 · --ak-sidebar 264 · --ak-nav 248 · --ak-topbar 60`

App pages use `--maxw`. Marketing/brand pages use `--wide`. The topbar is a hard 60px and never changes.

### Z-index layers

Documented in `app/src/tokens.css`:
- `10` — sticky surfaces (tab strip, toolbar headers)
- `30` — overlay/modal backdrops
- `40` — dropdowns, popovers, context menus
- `50` — full-screen overlays (command palette, modals)

Don't invent new layers. If something doesn't fit, restructure.

---

## 6. Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | `120ms` | Color/opacity transitions, hover states |
| `--dur-base` | `180ms` | Default for most state changes |
| `--dur-slide` | `300ms` | Drawer/modal open, page transitions |
| `--ease` | `cubic-bezier(.4,0,.2,1)` | Default ease — material standard |
| `--ease-spring` | `cubic-bezier(.32,.72,0,1)` | Toasts, popovers, anything entering with a slight overshoot |

Theme transitions use `.5s var(--ease)` on `background` and `color`. Respect `prefers-reduced-motion`.

---

## 7. Components

### Buttons

Default = ghost on `--surface-2`, hover on `--ak-hover`. Primary CTA = filled `--accent` with `--accent-ink` text. Destructive = filled `--ak-danger`. No outline buttons (they fight the dark ground).

### Cards

`background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg);`. Padding `--ak-space-5` minimum. Don't use shadow on dark theme cards — the lattice ground does the work.

### Tables (the grid)

The DataGrid is the heart of the app. Conventions:
- Sticky header at `z-index: 10`, `background: var(--surface-2)`
- Row hover `background: var(--ak-hover)`
- Selected cell ring uses `--accent`, no background fill (preserves readability of colored content)
- Per-table tint shows as a 2px left border on the leftmost cell
- Mono font for IDs, body font for labels

### Cells (Airtable-style)

One cell type per field. Read-mode renderer + edit-mode editor in the same component file. Empty cells render `--ink-3` placeholder, never bare. Validation errors show as a thin `--ak-danger` underline, not a popup.

### Empty states

Single emoji ornament + one-line directive on `text-ink`. No illustrations, no buttons unless the empty state is fixable in one action.

### Popovers / dropdowns

`background: var(--surface-elevated); border: 1px solid var(--line-2); box-shadow: var(--shadow);`. Always animate in with `--dur-base var(--ease-spring)`.

---

## 8. The signature lattice

The faint junction grid on the body background is the single most identity-defining visual element. Don't remove it from full-page surfaces. Reproduce with:

```css
body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image:
    radial-gradient(circle at center, var(--node-line) 1.4px, transparent 1.6px),
    linear-gradient(var(--node-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--node-line) 1px, transparent 1px);
  background-size: 74px 74px;
}
```

Lattice spacing is always 74px. Suppress on modals, popovers, and print.

---

## 9. Hard rules

1. **Never hardcode brand color.** Use `var(--accent)` / `var(--accent-2)` / tint tokens.
2. **One accent per view.** If two things both demand `--accent`, one of them is wrong.
3. **Committed ≠ ok. Staged ≠ warn.** Master-data workflow has its own semantics — use the right token.
4. **8px spacing grid.** No 5/7/13px gaps.
5. **Dark first.** Build the dark theme; verify the light theme reads on paper.
6. **Respect the engineer-mode toggle.** Surface SQL/table-name jargon only when `engineerMode` is on.
7. **Tints come from `palette.ts`, not from the component.** Don't pick a tint inline.
8. **Mono only for identifiers.** Don't render English prose in JetBrains Mono.

---

## 10. How to use this document

- **Humans:** read sections 1-3 to absorb the personality and color philosophy; reference 4-9 while building.
- **LLMs building UI:** load this entire file as context plus the latest `app/src/tokens.css`. The two together describe the design completely.
- **When this document and the tokens disagree:** the tokens win. Open a PR to update this file.

For the visual specimen, open `docs/brand-preview/zugzug-brand-guide.html` in a browser. For the live app, run `cd app && bun run dev`.
