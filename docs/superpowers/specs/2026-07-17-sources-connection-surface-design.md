# Sources — from Operator's Ledger to Connection Surface

**Date:** 2026-07-17
**Status:** Design approved (mockups reviewed), ready for implementation plan
**Route:** `/app/:tenantSlug/sources` (`app/src/routes/Sources.tsx`)
**Mockups:**
- `docs/superpowers/specs/mockups/2026-07-17-sources-connection-surface.html`
- `docs/superpowers/specs/mockups/2026-07-17-catalog-explorer.html`

## Problem

The Sources page currently does two jobs at once:

1. **Connect/configure** — pick a warehouse column and wire it to a table (the
   `Add source` → `CatalogExplorer` path).
2. **Monitor** — a live drift dashboard: a dynamic headline sentence, a pulsing
   "Standing · today" callout, a sticky toolbar (search + Needs review / All /
   Clean chips + impact sort), collapsible per-system groups with coverage %,
   6-column rows, expandable top-8 unmapped-value drills, j/k/n keyboard
   navigation, pagination, and footer totals.

The monitoring half doesn't resolve anything on this page — the callout's
button, every row drill, and every "Map values" link navigate away to the
per-table Map-values surface where the real work happens. Sources is a heavy
second front door to a workflow that already has a home. Connecting a source is
an occasional setup act; reviewing values is ongoing operational work on a
different clock. Splitting them makes both calmer.

## Decision

**Sources becomes a connection surface.** It answers *"what's connected, and let
me connect more"*. All value-review/monitoring stays on Map values.

## Target design — the list

```
Warehouse
Sources                                          [ Scan all ]  [ Add source ]
5 columns connected across 2 systems

  ▼ authco     3 columns · scanned 2h ago                            4
    authco.users.plan_type        → Plan        scanned 2h ago       ⋯
    authco.users.country          → Region      never scanned        ⋯
    authco.orgs.tier              → Plan         scanned 2h ago       ⋯

  ▼ billing    2 columns · scanned 1d ago                            4
    billing.subscriptions.status  → Status       ⚠ column not found  ⋯
    billing.invoices.currency     → Currency     scanned 1d ago       ⋯

  ● 8 values await a decision  →  Review
```

### Header
- Kicker `Warehouse`, title `Sources`.
- Lede: `"{N} columns connected across {M} systems"`. Drops the
  "…await a decision" tail (monitoring). Empty state keeps the existing
  "connect your first column" copy.
- Actions: `Add source` (primary, opens the catalog drawer) and `Scan all`
  (kept, demoted secondary — see Decisions).

### System groups (collapsible)
Rows are grouped by system (the schema prefix of `schema.table.column`). Each
group has a **collapsible header** (chevron) showing: system name, column count,
last-scan relative time, and — when folded — a **pending-count badge** in accent
so the "there's work in here" signal survives collapse. Default open/closed
state can mirror today's heuristic (open small workspaces, fold large ones) or
simply default-open; final call during implementation. No per-schema coverage %.

### Row
Each connected column renders three fields only:
- **Column identity:** `schema.table.column`.
- **Target:** `→ {table label}` (plain display name, e.g. `Plan`).
- **Connection state:** only states about the connection itself —
  `scanned {ago}` / `never scanned` / `⚠ column not found`. The
  column-not-found state is the one health signal that belongs here: a broken
  wire is a Sources problem, not a Map-values problem.
- **`⋯` overflow menu:** `Re-scan` (existing derive action) · `Open in Map
  values` (existing nav) · **`Remove source`** (NEW — no disconnect action
  exists today; a gap for a connection surface).

### Review pointer
A single quiet line at the bottom: `"{N} values await a decision → Review"`.
Shown only when `N > 0`. Links to the **most-affected table's** Map-values tab,
reusing the existing `agg.worst` impact logic (`nav.table(worst.dimId,
"match")`). Interim: preserves the one useful thing the callout did (telling you
work exists) without rebuilding the dashboard.

## Target design — Add source (catalog drawer)

The `Add source` flow moves from a centered modal to a **right slide-over
drawer** (~620px) that docks over the still-visible Sources list, so wiring a
column reads as feeding the list behind it.

```
┌───────────────────────────── drawer (right) ─────────────┐
│ [A] Catalog · analytics                              ✕    │
│ Wire a source                                             │
│ ⌕ Search 340 tables and columns…               [esc]     │
│                                                           │
│ ▶ authco.users              ● 1 wired · 9 cols            │
│     plan_type   ✓ Plan · 3 matched, 2 to review           │
│     country     [ + connect to table ]                    │
│ ▶ authco.orgs                          7 cols             │
│ ▶ billing.subscriptions               12 cols             │
│ ───────────────────────────────────────────────────────  │
│ Showing 4 of 340 · 2 wired just now   [Load more] [Done]  │
└───────────────────────────────────────────────────────────┘
```

Interaction:
- **Search-first.** Search over table + column names is the primary finder
  (there are 300–1000+ tables). Existing server-side `searchCatalog` + "Load
  more" pagination is retained.
- **No schema-facet rail.** Drop the "all systems" facet and the schema-facet
  column entirely — per product owner, that per-system split isn't reliable in
  the catalog. Search carries finding. (This removes the left rail from today's
  `CatalogExplorer`; verify no caller depends on `schemas` facet data.)
- **Wire inline.** Expand a table → each column has a `+ connect to table`
  control. Selecting a target animates into a green `✓ {table} · {outcome}`
  confirmation using the existing `deriveCanonical` result copy
  (`3 matched, 2 to review` / `12 records created`). Unchanged wiring backend.
- **Live tally.** Footer shows `N wired just now` as columns are connected — the
  payoff signal of the building-your-list idea.
- Escape / backdrop / ✕ / `Done` closes.

## What gets deleted (from `Sources.tsx`, refs vs current 821-line file)

| Lines | What | Reason |
|---|---|---|
| 503–547 | Standing "· today" callout | Monitoring; button only links out |
| 552–608 | Sticky toolbar: search + status chips + sort `<select>` | Filtering a small list is overkill |
| 638–651 | "Load more" schema pagination | Not needed at this scale |
| 656–672 | Footer "rows watched / last scan" totals | Monitoring stat |
| ~178–286 | `agg` atRisk, `counts`, sort/filter/group memos (keep a trimmed `agg` for header counts + `worst` for the pointer + per-group pending totals) | No longer needed |
| 315–397 | URL write-through for q/status/sort, cursor plumbing, scroll-into-view | Gone with toolbar + keyboard nav |

Deleted files/hooks:
- `app/src/routes/use-sources-cursor.ts` — j/k/n keyboard navigation (verify
  `Sources.tsx` is its only consumer before deleting).

**Do NOT delete or rename `LedgerRow` / `ExpandedDrill`.** They have a second
consumer: `app/src/components/modes/WiredSourcesModeBody.tsx` (the per-table
workbench "wired sources" mode) renders `LedgerRow` with `hideStandingBar`, and
`LedgerRow` renders `ExpandedDrill` when a row is expanded. That surface keeps
its current behavior. Instead, the redesigned Sources route gets a **new**
`app/src/components/sources/SourceRow.tsx` (3-field row + `⋯` menu). `LedgerRow`,
`ExpandedDrill`, and the top-8 `GET /sources/unmapped` peek remain in the
codebase, just no longer used by the Sources route.

`SchemaSection` (inline in `Sources.tsx`) is rewritten as a collapsible header
with a pending badge, no coverage % — and renders `SourceRow`, not `LedgerRow`.

Net effect: `Sources.tsx` drops from ~820 to ~230 lines.

## What is retained / added
- Add-source flow (redesigned into the drawer above); `searchCatalog` +
  pagination + `deriveCanonical` wiring backend unchanged.
- Per-row `Re-scan` (derive) action — moved into the `⋯` menu.
- `Scan all` header action — kept, demoted.
- Collapsible system groups with pending-count badge when folded.
- **NEW:** `Remove source` action — needs a store action + backend endpoint to
  disconnect a wired column. Confirm before removing.

## What moves to Map values
The unmapped-value drill (top-N sample) and the per-table "needs review" signal.
If Map values already surfaces these, this is a deletion here rather than a move
— verify during implementation before removing.

## URL state
Drop `q` / `status` / `sort` / `focus` search params on the Sources page — none
survive the toolbar removal. No new URL state introduced.

## Decisions (resolved with user)
1. **Review pointer destination:** most-affected table's Map-values tab (interim,
   reuse `agg.worst`). Not a new inbox.
2. **Scan all:** kept as a quiet secondary.
3. **System groups:** collapsible, with a pending-count badge when folded.
4. **Add source surface:** right slide-over drawer, not a centered modal.
5. **Catalog faceting:** no schema facets / "all systems" filter — search only.

## Open items for implementation
- Confirm a disconnect/remove endpoint exists in the store/API; add if missing.
- Confirm Map values already shows the unmapped top-N sample before deleting
  `ExpandedDrill`.
- Confirm nothing else consumes `CatalogExplorer`'s schema-facet (`schemas`)
  data before removing the rail.
- Vocabulary pass per CLAUDE.md: keep surface strings plain ("column",
  "connected", "table", "Map values", "Review"); avoid "canonical", "sync",
  "ledger", "drift" in user-facing copy.

## Non-goals
- No aggregate review-inbox page (future).
- No re-introduction of the status/sort toolbar or search on the Sources list
  until list size demands it (system collapse is the only navigation aid kept).
- No change to the Map-values surface beyond receiving the moved review
  affordances.
- No change to the catalog wiring backend (`searchCatalog`, `deriveCanonical`).
