# Rounded corners return; document pages get a narrow column

Square-mode — the `globals.css` override that forced `--r-sm/--r/--r-lg` to `0`
app-wide — is retired. Corners now render at the brand's own dormant radius
scale (`4 / 8 / 12`) everywhere except pills, which were always exempt. At the
same time, single-column **document pages** (tenant settings, Account) move off
the `--wide` (1320) cap onto a new narrower `--doc` (1040) column.

The trigger was a light-mode redesign spike (`warehouse-redesign.html`): rounded
cards inside a ~1000px framed column read markedly better than the flat,
full-width square surfaces the app shipped. An investigation
(`docs/redesign/rounded-narrow-findings.md`) verified the look in the real
mounted shell — dark/light, desktop/mobile, sidebar expanded/collapsed, against
live data — and returned GO with no blockers. 940 tested cramped on the denser
real pages; 1180 barely differed from 1320; **1040** framed the column while
leaving room for 2-up cards and the widest real settings table.

## Two decisions

**Rounded everywhere.** The reversal is app-wide, not scoped to document pages —
every Panel, card, button, input, badge, and popover picks up the restored
radius, *including inside the grid pages* (Sources, Review, Master tables). This
keeps one corner language across the product. Grid pages keep their full-bleed,
full-height identity (ADR-0003) — they gain rounded framing, not a narrow
column.

**Width is split, not global.** The narrow `--doc` column is for
single-column, reading/forms surfaces only. Table-dominant pages keep `--wide`,
because width is the point on those: the admin console (Users/Workspaces tables)
and the Activity log stay at 1320. The rule that decides the frame:

| Surface | Frame | Why |
|---|---|---|
| Tenant settings, Account | `--doc` 1040 | single-column forms — a document |
| Admin console, Activity log | `--wide` 1320 | table-dominant — width is content |
| Sources, Review, Master tables | full-bleed (no `PageContainer`) | bespoke grid — ADR-0003 |

## Consequences

- **`globals.css` square-mode block is deleted.** `rounded-*` utilities and the
  kit components that read `--r-lg` etc. are cosmetically live again — no longer
  no-ops. The `4/8/12` scale is declared once in `tokens.css`; nothing overrides
  it.
- **`PageContainer` gains `max="doc"`.** `SettingsLayout` and Account's
  `SettingsShell` pass it; `AdminLayout` and `Audit` stay on the default
  `wide`. `SettingsShell` takes a `max` prop so the shared shell can serve both.
- **This supersedes ADR-0003's radius consequence.** ADR-0003 stated "corners
  are square by brand intent and that is permanent" and treated radius
  normalization as pixel-inert code hygiene. That is no longer true: radius is a
  live, user-facing value. ADR-0003's container/tint/shadow model is otherwise
  unchanged and still governs.
- **DESIGN.md §5 (radius, widths) and §7 (containers) are rewritten** to match.
  Per DESIGN.md §10, tokens win over prose; this ADR + the token change are the
  source of truth the doc was updated to follow.
- Surfaces that hand-rolled `border + overflow-hidden` without a radius util now
  read as the lone square box and must add `rounded-lg` (found: `Sources.tsx`).
