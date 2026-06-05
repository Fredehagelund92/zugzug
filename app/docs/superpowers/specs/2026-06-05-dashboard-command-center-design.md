***REMOVED*** Dashboard — Command Center redesign

**Date:** 2026-06-05
**Scope:** `src/routes/Dashboard.tsx` only (surgical — no new shared components)
**Goal:** Make the dashboard feel as professional as Airtable for master-data operations — information-dense, urgency-sorted, zero wasted vertical space.

---

***REMOVED******REMOVED*** Problem

The current dashboard leads with a large decorative page header and a 2-column card grid (Mapping seeds + Activity). This layout:

- Buries the most urgent information (which table is on fire?) below a hero title
- Wastes a full card column on the activity feed — rarely the first thing a data engineer needs
- Has no sorting or filtering — tables are in insertion order
- Stages the "staged for review" section as a separate card above the table, adding noise when there's nothing pending

---

***REMOVED******REMOVED*** Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Layout direction | **A — Command Center** | Dense table-led layout; scales to 20+ tables without scrolling cards |
| Activity placement | **Column in the table** | Last actor + timestamp per row; full audit still in store |
| Staged drafts | **Highlighted row** (purple wash + inline flag) | No separate section; staged state is visible exactly where it's relevant |
| KPI strip | **Full 4-card strip** (keep as-is) | Big numbers, hover lift, featured left border on "New to resolve" |
| Implementation scope | **Approach 1 — Dashboard.tsx only** | No new shared components; extract later if needed |

---

***REMOVED******REMOVED*** Layout structure

```
┌─ topbar (unchanged, AppShell) ───────────────────────────────────┐
│ logo · wordmark · search · live · presence avatars · theme / user │
└───────────────────────────────────────────────────────────────────┘
┌─ sidebar (unchanged, AppShell) ─┐ ┌─ main (Dashboard.tsx) ───────┐
│ collapsed icon rail              │ │                               │
│  ● Dashboard (active)            │ │  Page header                  │
│  ○ Triage                        │ │  ─ kicker "Master data"       │
│  ○ Sources                       │ │  ─ title "Value mapping…"     │
│  ○ Tables                        │ │  ─ meta bar (live / 5 tables  │
│  ─                               │ │    / coverage / new / staged) │
│  ○ Settings                      │ │  ─ [+ New table] [Resolve N]  │
│                                  │ │                               │
│                                  │ │  KPI strip (4 cards, 2×2→4×1)│
│                                  │ │                               │
│                                  │ │  Toolbar                      │
│                                  │ │  ─ filter pills: All / Needs  │
│                                  │ │    attention / Clean          │
│                                  │ │  ─ sort pills: Urgency /      │
│                                  │ │    Coverage / Name / Rows     │
│                                  │ │                               │
│                                  │ │  Dimension health table       │
│                                  │ │  ─ [tint bar] Table | Cov |   │
│                                  │ │    Records | Rows | Status |  │
│                                  │ │    Last activity              │
│                                  │ │  ─ + New table footer row     │
└──────────────────────────────────┘ └───────────────────────────────┘
```

---

***REMOVED******REMOVED*** Page header

Reuses the existing `<PageHeader>` component unchanged.

- **kicker:** `"Master data"`
- **title:** `"Value mapping overview"`
- **meta slot:** single-line monospace bar:
  `● live / N tables / N values mapped / N% coverage / N new to resolve [ / N staged for review ]`
  — "staged" segment only rendered when `staged.length > 0`
- **action slot:** `[+ New table]` (secondary, links to `/app/tables`) + `[Resolve N new]` (primary, `zz-glow-sm`, links to `/app/triage`). Primary button hidden when `totalNew === 0`.

---

***REMOVED******REMOVED*** KPI strip

Four `<Kpi>` cards in a `grid-cols-2 lg:grid-cols-4` grid. Unchanged from today except:

- **New to resolve** card gets `featured` prop (2px accent left border) only when `totalNew > 0`
- Subtitle text added per card (rendered via the existing `delta` prop or an inline sub-element — see implementation notes)

| Label | Value | Sub-line |
|---|---|---|
| Tables | `dims.length` | `"N active · N clean"` |
| Values mapped | `fmtK(valuesMapped)` | `"▲ +N this week"` *(static for now — omit if 0)* |
| New to resolve | `totalNew` | `"across N tables"` (warn color) when > 0, else omit |
| Rows at risk | `fmtK(rowsAtRisk)` | `"unmapped warehouse rows"` (muted) |

> **Note:** The existing `Kpi` component has a `delta` + `dir` prop for the sub-line. Use `delta` for the sub-line text and pass `dir="up"` for green / `dir="down"` for warn. The "across N tables" line uses warn color — either add a `tone` prop to `Kpi` or render it as a separate element below the KPI strip (implementation choice for the coder).

---

***REMOVED******REMOVED*** Toolbar

A flex row above the table. Two groups separated by a 1px divider:

**Filter pills** (left group — mutually exclusive, one active at a time):
- `All` — shows all dims; count badge
- `Needs attention` — dims where `newCount > 0`; count badge; warn color when active
- `Clean` — dims where `newCount === 0 && staged === 0`; count badge

**Sort pills** (right group — one active):
- `Urgency` (default) — sort by `newCount desc`, then `coverage asc`
- `Coverage` — sort by `coverage asc` (worst first)
- `Name` — sort by `dim.dimension asc`
- `Rows` — sort by `dim.rows desc`

Toolbar state is **local React state** (`useState`) — no URL persistence needed for sort/filter.

---

***REMOVED******REMOVED*** Dimension health table

A plain HTML `<table>` (not `<DataGrid>`) — this is a read-only summary view, not an editable grid.

***REMOVED******REMOVED******REMOVED*** Columns

| Column | Content |
|---|---|
| *(tint bar)* | 3px × 40px colored left-edge bar using `dim.tint` color; only on rows where `newCount > 0` or staged; blank for clean rows |
| **Table** | `dim.dimension` (display font, semibold) + `dim.mapTable` (mono, muted) below. Staged rows add an inline flag: `ⓘ N staged · [user.initials] staged "[raw]"` — purple, small, margin-top |
| **Coverage** | Progress bar (72px, 3px tall) + `N%` number. Bar and number color: accent-red when <80%, amber when 80–95%, green when ≥96% |
| **Records** | `dim.canonical.length` — mono, right-aligned |
| **Rows** | `fmtK(dim.rows)` — mono, right-aligned |
| **Status** | Badge: `warn` "N new" / `accent` "N new 🔥" (when >5) / `staged` "staged" / `ok` "clean". When both new + staged: show new badge only (staged flag in name cell is enough) |
| **Last activity** | Avatar initials (colored per user tint) + last audit action text + relative time. Pull from `auditLog` filtered by `dimId`. If no audit entry, render `—` |

***REMOVED******REMOVED******REMOVED*** Row styling

- **Default:** hover `bg-hover`
- **Staged row** (any draft with status `"mapped"` pointing to a new value in this dim): `background: rgba(var(--staged-rgb), 0.04)`, left tint bar always shown in staged color
- **Clean row:** no left tint bar, muted presence in the table

***REMOVED******REMOVED******REMOVED*** Row click

Clicking any row navigates to `/app/tables?open={dim.id}&active={dim.id}&mode=match` — same as the current "Mapping seeds" link behavior.

***REMOVED******REMOVED******REMOVED*** Footer row

A `+ New table` inline link at the bottom of the table (the last `<tr>`), styled like a ghost add-row. Calls `create.open()` from `useCreateTableModal()`.

***REMOVED******REMOVED******REMOVED*** Empty state

When `dims.length === 0`: existing empty-state block is unchanged (no tables yet → create your first table).

---

***REMOVED******REMOVED*** Data derivations

All computed from existing store hooks — no new store functions needed.

```ts
const dims = useDimensions();
const auditLog = useAudit();
const draftsMap = useDrafts();
const create = useCreateTableModal();

// Per-dim helpers
const newCount = (id) => dim.values.filter(v => v.status === "new").length;
const coveragePct = (dim) => {
  const total = dim.values.length;
  return total === 0 ? 100 : Math.round((dim.values.filter(v => v.current).length / total) * 100);
};

// Staged: drafts that are mapped + the target value is still "new" in the dim
const staged = Object.values(draftsMap).filter(
  d => d.status === "mapped" &&
    dims.find(s => s.id === d.dimId)?.values.find(v => v.value === d.raw)?.status === "new"
);

// Last audit entry per dim (for "Last activity" column)
const lastAuditByDim = dims.reduce((acc, d) => {
  const entry = auditLog.find(e => e.dimId === d.id); // auditLog is newest-first
  acc[d.id] = entry ?? null;
  return acc;
}, {});
```

> **Note:** Check whether `AuditEntry` has a `dimId` field. If not, parse it from `e.detail` (the current entries embed the dim name). The "Last activity" column can fall back to `—` safely.

---

***REMOVED******REMOVED*** Removed from the current dashboard

| Element | Disposition |
|---|---|
| "Mapping seeds" card | Replaced by the dimension health table |
| "Activity" card (team feed) | Removed; activity lives as a column in the table |
| "Staged for review" card | Removed; staged state lives as a highlighted row in the table |

---

***REMOVED******REMOVED*** What stays unchanged

- `AppShell` — topbar, sidebar, command palette, shortcuts overlay
- `<PageHeader>` — used as-is
- `<Kpi>` — used as-is (4 cards)
- `<Badge>` — used as-is
- `<Button>` — used as-is
- `useCreateTableModal` hook — used for the footer "+ New table" row
- `fmtK` helper — stays in `Dashboard.tsx`
- `MarkBackdrop` / empty-state block — stays unchanged

---

***REMOVED******REMOVED*** Spec self-review

- No TBDs or placeholders remaining
- `auditLog[entry].dimId` dependency noted with a fallback
- `Kpi` sub-line tone noted as an implementation choice (delta prop vs. inline element)
- Scope is tight: one file, no new shared components, no new store functions
- Coverage color thresholds (<80 / 80–95 / ≥96) are explicit
- Sort + filter state is local (no URL, no persistence needed)
