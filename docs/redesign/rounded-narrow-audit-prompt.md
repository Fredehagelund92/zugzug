# Rounded + Narrow — Investigation Prompt (the gate)

You are investigating whether Zugzug should adopt the look of
`warehouse-redesign.html` (repo root): **rounded corners** and a **narrow,
framed reading column**. **This is an investigation task, not an implementation
task.** Do not change any product code that survives past this session. Your
one deliverable is a findings document:
`docs/redesign/rounded-narrow-findings.md`, ending in a **go / no-go** call, a
**width recommendation**, and a **ranked risk list**.

The rollout that follows (`docs/redesign/rounded-narrow-rollout-plan.md`)
consumes your findings. If you say no-go, the rollout does not run.

The dev server runs at http://localhost:5173. Start it with `cd app && bun run
dev` if it isn't up.

## What the user is reacting to

Open `warehouse-redesign.html` in a browser. Two things make it feel good, and
both **reverse a documented, deliberate decision** in the current app:

1. **Rounded corners.** The demo uses the brand's own dormant radius scale
   (`--r-sm 4 · --r 8 · --r-lg 12`). The live app runs **square-mode**:
   `app/src/globals.css:284-288` overrides those three tokens to `0px`.
   DESIGN.md §5 calls square-mode "active and permanent."
2. **A narrow ~940px column** (`.wrap { max-width: 940px }`). The live app caps
   document pages at `--wide` **1320px** via `PageContainer`.

## The decisions already made (do not re-litigate — investigate *within* them)

- **Corners: rounded EVERYWHERE.** Kill square-mode app-wide. Restore the
  brand's `4/8/12` scale on every Panel, card, button, input, badge, popover —
  **including inside the grid pages** (Sources, Review, Master tables). Do not
  invent new radius values; the dormant scale is the target.
- **Width: split.** The narrow column is for **document pages only** (Settings,
  Account, and peers that use `PageContainer`). The **grid pages stay
  full-width** but gain the rounded framing. Grid pages must not lose their
  full-bleed identity.
- **Pills stay pills.** `--r-pill 999` is exempt and unchanged (status dots,
  the live pulse, switches, the workspace switcher).

Your job is not to decide *whether* to round or *whether* to split — it's to
decide the **width number**, confirm it **looks good in the real shell**, and
surface **everything that breaks** when square-mode comes off.

## Verified architecture (trust but re-verify line numbers)

- React 18 + React Router 6 + Vite 6 + Tailwind v4. Token-driven design system:
  `app/src/tokens.css` (variables), `app/src/app-kit.css` (utility layer),
  `app/src/globals.css` (base + the square-mode override), `DESIGN.md` (narrative).
- Radius tokens declared in `app/src/tokens.css:35-38`, overridden to `0` in
  `app/src/globals.css:284-288`.
- Width tokens in `app/src/tokens.css:39-40` (`--maxw 1180` retired, `--wide 1320`).
- `PageContainer` (`app/src/components/PageContainer.tsx`) — the one document
  page frame. `max="wide" (1320, default) | "full"`. No narrow option today.
- `Panel` (`app/src/components/Panel.tsx`) — the one framed container; uses
  `rounded-lg` (→ `--r-lg`, currently squared) + `overflow-hidden`.
- Settings routes go through `SettingsLayout.tsx` → `PageContainer`. The
  settings/admin shell is `SettingsShell.tsx` (has its own sidebar).
- Grid pages deliberately bypass `PageContainer` (ADR-0003) and are full-bleed.
- **Uncommitted work exists on the `polish` branch**: `SettingsPageHeader.tsx`
  and 7 modified `routes/settings/*` files. Treat that as the current baseline —
  your spike must render on top of it, not fight it.

## Ground rules

1. **No lasting product-code changes.** Build the spike behind a throwaway
   branch or a scratch commit you will discard. Nothing you write here ships.
2. **Screenshots are evidence.** Every claim about "looks good / looks cramped /
   breaks" needs a screenshot in `docs/redesign/rounded-narrow-findings.md`
   (or a linked image). No screenshot, no claim.
3. **Real shell only.** Judge everything with the actual sidebar + 60px topbar
   mounted — not an isolated page. The user's stated unknown is "how it looks
   with the current sidebar." Answer that first.
4. Test **light AND dark** (dark is the lead look) and **mobile** (the shell
   stacks the sidebar below a breakpoint).

## Tasks

### 1 — Build a throwaway spike
- Comment out the square-mode block (`globals.css:284-288`) so the brand's
  `4/8/12` radius scale comes back live.
- Add a temporary `--doc` width token and a `max="doc"` branch in
  `PageContainer` pointing at it.
- Route the real **Warehouse** settings page (and one 2-column-heavy page, e.g.
  **Members** or **Matching**) through `max="doc"`.
- Run the app. Confirm it renders on top of the current `polish` work.

### 2 — Width shoot-out (this picks the number)
- Screenshot the spike at `--doc` = **940 / 1040 / 1180**, each at:
  desktop + mobile, sidebar expanded + collapsed, light + dark.
- Judge: reading measure (line length of hint text), the demo's **2-up
  connection cards** at each width, and whether any real settings table
  overflows. Note where 940 feels cramped and where 1180 feels un-framed.
- **Output: one recommended number, with the screenshot that justifies it.**

### 3 — Pitfall sweep (this is the risk list)
Rounding corners app-wide reveals things square-mode hid. Enumerate and
screenshot each; mark severity:
- `:focus-visible` ring uses `border-radius: var(--r-sm)` (`globals.css:305`) —
  does the restored 4px ring sit right on inputs/buttons/cells?
- **`overflow:hidden` parents with square children** — a rounded `Panel`
  wrapping a full-bleed table/header: do child corners bleed past the parent's
  rounded corner? (Classic square→round regression.)
- The **sticky grid header** (`--surface-2`, `z-index:10`) inside a now-rounded
  frame — top corners.
- The **per-table 2px left border** and the **selected-cell ring** (`--accent`,
  no fill) — do they read against rounded cells/frames?
- Inputs, segmented controls (`.seg` in the demo), badges, buttons, popovers /
  dropdowns (`--surface-elevated` + shadow), scrollbar thumb.
- Anything currently relying on a flush 90° seam between adjacent surfaces.

### 4 — Grid pages keep their identity
- Apply the rounded framing to one grid page (Master tables). Confirm it still
  reads as full-bleed and full-height — not as a narrow document. Screenshot.
- Flag anything that makes the grid feel "boxed" or loses vertical fill.

### 5 — Write the findings
`docs/redesign/rounded-narrow-findings.md` must contain, in order:
1. **Go / no-go** — one line, with the single most decisive screenshot.
2. **Recommended `--doc` width** — the number + its justification shot.
3. **Ranked risk list** — each pitfall from Task 3/4 with severity
   (blocker / fix-during-rollout / cosmetic) and a one-line fix sketch. This
   list is the rollout's step-3 work queue.
4. **Sidebar verdict** — does rounded + narrow look good with the real shell?
   (The user's headline question.)

Then stop. Do not proceed to the rollout — that is a separate, gated step.
