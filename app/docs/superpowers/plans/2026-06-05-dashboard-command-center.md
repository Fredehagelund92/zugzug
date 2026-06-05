# Dashboard Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current card-grid dashboard with a Command Center layout — urgency-sorted dimension health table, inline staged highlighting, activity-as-column, compact header, and full KPI strip.

**Architecture:** Surgical — only `src/routes/Dashboard.tsx` and `src/components/Kpi.tsx` are modified. A co-located `src/routes/dashboard-helpers.ts` is extracted for the pure sort/filter/coverage functions so they can be unit-tested. No new shared components.

**Tech Stack:** React 18, TypeScript, Tailwind v4, Vitest, existing store hooks (`useDimensions`, `useAudit`, `useDrafts`), existing component library (`Kpi`, `Badge`, `Button`, `PageHeader`), `PALETTE`/`defaultTintFor` from `src/lib/palette.ts`.

---

## File map

| Action | File | Responsibility |
|---|---|---|
| Create | `src/routes/dashboard-helpers.ts` | Pure functions: `coveragePct`, `urgencyScore`, `coverageColor`, `lastAuditForDim`, `applyFilter`, `applySort`; types `FilterKey`, `SortKey` |
| Create | `test/dashboard-helpers.test.ts` | Unit tests for all helpers |
| Modify | `src/components/Kpi.tsx` | Add `"warn"` option to `dir` prop so sub-lines can render in amber without an arrow |
| Modify | `src/routes/Dashboard.tsx` | Full rewrite of the populated-state body; empty state unchanged |

---

## Task 1: dashboard-helpers.ts + tests

**Files:**
- Create: `src/routes/dashboard-helpers.ts`
- Create: `test/dashboard-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/dashboard-helpers.test.ts
import { test, expect, describe } from "vitest";
import type { MappingDimension } from "../src/data";
import type { AuditEntry } from "../src/store";
import {
  coveragePct,
  urgencyScore,
  coverageColor,
  lastAuditForDim,
  applyFilter,
  applySort,
} from "../src/routes/dashboard-helpers";

// ── minimal fixtures ──────────────────────────────────────────────────────────

const cleanDim: MappingDimension = {
  id: "post_type",
  dimension: "Post Type",
  dimTable: "zugzug.dim_post_type",
  mapTable: "zugzug.map_post_type",
  keyCol: "post_type",
  rows: 100,
  canonical: [],
  values: [
    { value: "A", status: "mapped", current: "A", suggestion: null, confidence: 0, sources: [] },
    { value: "B", status: "mapped", current: "B", suggestion: null, confidence: 0, sources: [] },
  ],
};

const dirtyDim: MappingDimension = {
  id: "country",
  dimension: "Country",
  dimTable: "zugzug.dim_country",
  mapTable: "zugzug.map_country",
  keyCol: "country_code",
  rows: 500,
  canonical: [],
  values: [
    { value: "US", status: "mapped", current: "US", suggestion: null, confidence: 0, sources: [] },
    { value: "GB", status: "mapped", current: "GB", suggestion: null, confidence: 0, sources: [] },
    { value: "XX", status: "new", current: null, suggestion: null, confidence: 0, sources: [] },
    { value: "YY", status: "new", current: null, suggestion: null, confidence: 0, sources: [] },
  ],
};

const emptyDim: MappingDimension = {
  id: "empty",
  dimension: "Empty",
  dimTable: "zugzug.dim_empty",
  mapTable: "zugzug.map_empty",
  keyCol: "id",
  rows: 0,
  canonical: [],
  values: [],
};

const auditLog: AuditEntry[] = [
  { id: "1", at: "1h ago", user: { id: "u1", name: "Alice", initials: "AL" }, action: "committed", detail: "3 values in Country" },
  { id: "2", at: "2h ago", user: { id: "u2", name: "Bob", initials: "BO" }, action: "renamed", detail: "TWEET → Tweet in post_type" },
  { id: "3", at: "3h ago", user: { id: "u1", name: "Alice", initials: "AL" }, action: "added", detail: "California to US State" },
];

// ── coveragePct ───────────────────────────────────────────────────────────────

describe("coveragePct", () => {
  test("returns 100 for empty values array", () => {
    expect(coveragePct(emptyDim)).toBe(100);
  });
  test("returns 100 when all values are mapped", () => {
    expect(coveragePct(cleanDim)).toBe(100);
  });
  test("returns 50 when half are mapped", () => {
    expect(coveragePct(dirtyDim)).toBe(50);
  });
  test("rounds down", () => {
    const d = { ...dirtyDim, values: [...dirtyDim.values, { value: "ZZ", status: "new" as const, current: null, suggestion: null, confidence: 0, sources: [] }] };
    // 2 mapped / 5 total = 40%
    expect(coveragePct(d)).toBe(40);
  });
});

// ── urgencyScore ──────────────────────────────────────────────────────────────

describe("urgencyScore", () => {
  test("clean dim has urgencyScore 0", () => {
    expect(urgencyScore(cleanDim)).toBe(0);
  });
  test("dim with new values scores higher than clean dim", () => {
    expect(urgencyScore(dirtyDim)).toBeGreaterThan(urgencyScore(cleanDim));
  });
  test("more new values = higher score", () => {
    const oneNew: MappingDimension = { ...dirtyDim, values: [dirtyDim.values[0], dirtyDim.values[2]] };
    expect(urgencyScore(dirtyDim)).toBeGreaterThan(urgencyScore(oneNew));
  });
});

// ── coverageColor ─────────────────────────────────────────────────────────────

describe("coverageColor", () => {
  test("96+ → ok color", () => {
    expect(coverageColor(96)).toBe("var(--ak-ok)");
    expect(coverageColor(100)).toBe("var(--ak-ok)");
  });
  test("80–95 → warn color", () => {
    expect(coverageColor(80)).toBe("var(--ak-warn)");
    expect(coverageColor(95)).toBe("var(--ak-warn)");
  });
  test("below 80 → accent color", () => {
    expect(coverageColor(79)).toBe("var(--accent)");
    expect(coverageColor(0)).toBe("var(--accent)");
  });
});

// ── lastAuditForDim ───────────────────────────────────────────────────────────

describe("lastAuditForDim", () => {
  test("finds entry whose detail contains the dimension name", () => {
    const entry = lastAuditForDim("country", "Country", auditLog);
    expect(entry?.id).toBe("1");
  });
  test("finds entry whose detail contains the dim id (fallback)", () => {
    const entry = lastAuditForDim("post_type", "Sprout Post Type", auditLog);
    expect(entry?.id).toBe("2");
  });
  test("returns null when no entry matches", () => {
    expect(lastAuditForDim("verticals", "Vertical", auditLog)).toBeNull();
  });
  test("is case-insensitive", () => {
    expect(lastAuditForDim("COUNTRY", "COUNTRY", auditLog)).not.toBeNull();
  });
});

// ── applyFilter ───────────────────────────────────────────────────────────────

describe("applyFilter", () => {
  const staged = new Set(["post_type"]);

  test("'all' returns all dims", () => {
    expect(applyFilter([cleanDim, dirtyDim], "all", staged)).toHaveLength(2);
  });
  test("'attention' returns dims with new values", () => {
    const result = applyFilter([cleanDim, dirtyDim], "attention", new Set());
    expect(result.map((d) => d.id)).toEqual(["country"]);
  });
  test("'attention' also includes staged dims", () => {
    const result = applyFilter([cleanDim, dirtyDim], "attention", staged);
    expect(result.map((d) => d.id)).toContain("post_type");
  });
  test("'clean' excludes dims with new values and staged dims", () => {
    const result = applyFilter([cleanDim, dirtyDim], "clean", staged);
    expect(result).toHaveLength(0);
  });
  test("'clean' includes truly clean dims", () => {
    const result = applyFilter([cleanDim, dirtyDim], "clean", new Set());
    expect(result.map((d) => d.id)).toEqual(["post_type"]);
  });
});

// ── applySort ─────────────────────────────────────────────────────────────────

describe("applySort", () => {
  test("'urgency' puts dirty dim first", () => {
    const result = applySort([cleanDim, dirtyDim], "urgency");
    expect(result[0].id).toBe("country");
  });
  test("'coverage' puts worst coverage first", () => {
    const result = applySort([cleanDim, dirtyDim], "coverage");
    expect(result[0].id).toBe("country"); // 50% < 100%
  });
  test("'name' sorts alphabetically", () => {
    const result = applySort([dirtyDim, cleanDim], "name");
    expect(result[0].id).toBe("country"); // "Country" < "Post Type"
  });
  test("'rows' puts highest row count first", () => {
    const result = applySort([cleanDim, dirtyDim], "rows");
    expect(result[0].id).toBe("country"); // 500 > 100
  });
  test("does not mutate the input array", () => {
    const input = [cleanDim, dirtyDim];
    applySort(input, "urgency");
    expect(input[0].id).toBe("post_type");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test -- test/dashboard-helpers.test.ts
```

Expected: all tests fail with "Cannot find module '../src/routes/dashboard-helpers'"

- [ ] **Step 3: Create `src/routes/dashboard-helpers.ts`**

```ts
// src/routes/dashboard-helpers.ts
import type { MappingDimension } from "../data";
import type { AuditEntry } from "../store";

export type FilterKey = "all" | "attention" | "clean";
export type SortKey = "urgency" | "coverage" | "name" | "rows";

/** Percentage of values already mapped (count-based, not row-weighted). */
export function coveragePct(dim: MappingDimension): number {
  if (dim.values.length === 0) return 100;
  return Math.round(
    (dim.values.filter((v) => v.status === "mapped").length / dim.values.length) * 100,
  );
}

/**
 * Higher = more urgent. Drives the default "Urgency" sort.
 * Formula: newCount * 1000 + (100 - coveragePct) so tables with new values always
 * outrank clean ones, and within those, worse coverage floats higher.
 */
export function urgencyScore(dim: MappingDimension): number {
  const newCount = dim.values.filter((v) => v.status === "new").length;
  return newCount * 1000 + (100 - coveragePct(dim));
}

/** CSS color var to use for coverage bars and percentage text. */
export function coverageColor(pct: number): string {
  if (pct >= 96) return "var(--ak-ok)";
  if (pct >= 80) return "var(--ak-warn)";
  return "var(--accent)";
}

/**
 * Returns the most recent audit entry whose detail mentions this dim.
 * AuditEntry has no dimId field, so we do a case-insensitive string match
 * on both the dimension display name and the dimId. Falls back to null.
 */
export function lastAuditForDim(
  dimId: string,
  dimension: string,
  auditLog: AuditEntry[],
): AuditEntry | null {
  const idLower = dimId.toLowerCase();
  const nameLower = dimension.toLowerCase();
  return (
    auditLog.find((e) => {
      const d = e.detail.toLowerCase();
      return d.includes(nameLower) || d.includes(idLower);
    }) ?? null
  );
}

/** Filter dims by tab selection. `stagedDimIds` is the set of dim ids that have
 *  at least one staged draft so the "Needs attention" filter surfaces them too. */
export function applyFilter(
  dims: MappingDimension[],
  filter: FilterKey,
  stagedDimIds: Set<string>,
): MappingDimension[] {
  if (filter === "all") return dims;
  if (filter === "attention") {
    return dims.filter(
      (d) => d.values.some((v) => v.status === "new") || stagedDimIds.has(d.id),
    );
  }
  // "clean"
  return dims.filter(
    (d) => !d.values.some((v) => v.status === "new") && !stagedDimIds.has(d.id),
  );
}

/** Sort dims. Returns a new array — never mutates the input. */
export function applySort(dims: MappingDimension[], sort: SortKey): MappingDimension[] {
  const copy = [...dims];
  switch (sort) {
    case "urgency":
      return copy.sort((a, b) => urgencyScore(b) - urgencyScore(a));
    case "coverage":
      return copy.sort((a, b) => coveragePct(a) - coveragePct(b));
    case "name":
      return copy.sort((a, b) => a.dimension.localeCompare(b.dimension));
    case "rows":
      return copy.sort((a, b) => b.rows - a.rows);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test -- test/dashboard-helpers.test.ts
```

Expected: all 22 tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/routes/dashboard-helpers.ts test/dashboard-helpers.test.ts
git commit -m "feat: add dashboard-helpers with coverage/sort/filter logic + tests"
```

---

## Task 2: Extend Kpi with `"warn"` dir + update KPI sub-lines

**Files:**
- Modify: `src/components/Kpi.tsx`
- Modify: `src/routes/Dashboard.tsx` (kpis array only)

- [ ] **Step 1: Update `Kpi.tsx` — add `"warn"` to `dir` type**

Open `src/components/Kpi.tsx`. The current delta block is:

```tsx
{delta && (
  <div className={cx("mt-1 font-mono text-xs", dir === "up" ? "text-ok" : "text-danger")}>
    {dir === "up" ? "▲" : "▼"} {delta}
  </div>
)}
```

Change the `dir` prop type and render:

```tsx
// change the prop type from:
dir?: "up" | "down";
// to:
dir?: "up" | "down" | "warn";
```

Replace the delta block:

```tsx
{delta && (
  <div
    className={cx(
      "mt-1 font-mono text-xs",
      dir === "up" ? "text-ok" : dir === "warn" ? "text-warn" : "text-danger",
    )}
  >
    {dir === "up" ? "▲ " : dir === "down" ? "▼ " : ""}{delta}
  </div>
)}
```

- [ ] **Step 2: Update the `kpis` array in `Dashboard.tsx`**

Find the `kpis` array (around line 57). Replace it:

```ts
const attentionTables = dims.filter((d) =>
  d.values.some((v) => v.status === "new"),
).length;
const cleanTables = dims.length - attentionTables;

const kpis: Array<{
  label: string;
  value: string;
  featured?: boolean;
  delta?: string;
  dir?: "up" | "down" | "warn";
}> = [
  {
    label: "Tables",
    value: String(dims.length),
    delta: `${attentionTables} active · ${cleanTables} clean`,
    dir: "warn",
  },
  {
    label: "Values mapped",
    value: fmtK(valuesMapped),
    delta: undefined,
    dir: undefined,
  },
  {
    label: "New to resolve",
    value: String(totalNew),
    featured: totalNew > 0,
    delta: totalNew > 0 ? `across ${attentionTables} table${attentionTables === 1 ? "" : "s"}` : undefined,
    dir: totalNew > 0 ? "warn" : undefined,
  },
  {
    label: "Rows at risk",
    value: fmtK(rowsAtRisk),
    delta: rowsAtRisk > 0 ? "unmapped warehouse rows" : undefined,
    dir: rowsAtRisk > 0 ? "warn" : undefined,
  },
];
```

And update the `<Kpi>` render to pass `delta` and `dir`:

```tsx
{kpis.map((m, i) => (
  <div key={m.label} {...rise(1 + i)}>
    <Kpi
      label={m.label}
      value={m.value}
      featured={m.featured}
      delta={m.delta}
      dir={m.dir}
    />
  </div>
))}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/Kpi.tsx src/routes/Dashboard.tsx
git commit -m "feat: extend Kpi with warn dir; add sub-lines to dashboard KPI cards"
```

---

## Task 3: Add toolbar to Dashboard

**Files:**
- Modify: `src/routes/Dashboard.tsx`

- [ ] **Step 1: Add imports and toolbar state**

At the top of `Dashboard.tsx`, add to the existing imports:

```ts
import { useState, useMemo } from "react";
import { useCreateTableModal } from "../lib/create-table-modal";
import {
  type FilterKey,
  type SortKey,
  applyFilter,
  applySort,
} from "./dashboard-helpers";
```

Inside the `Dashboard` function body, after the existing derivations, add:

```ts
const create = useCreateTableModal();
const [filter, setFilter] = useState<FilterKey>("all");
const [sort, setSort] = useState<SortKey>("urgency");

// Dim ids that have at least one staged draft (for filter + row highlighting)
const stagedDimIds = useMemo(
  () => new Set(staged.map((d) => d.dimId)),
  [staged],
);

// Staged drafts grouped by dimId for the inline flag in table rows
const stagedByDim = useMemo(() => {
  const map: Record<string, typeof staged> = {};
  for (const d of staged) {
    if (!map[d.dimId]) map[d.dimId] = [];
    map[d.dimId].push(d);
  }
  return map;
}, [staged]);

const visibleDims = useMemo(
  () => applySort(applyFilter(dims, filter, stagedDimIds), sort),
  [dims, filter, sort, stagedDimIds],
);
```

- [ ] **Step 2: Render the toolbar**

Inside the populated-state `return`, after the KPI strip `</div>` and before the old 2-column grid, add:

```tsx
{/* Toolbar */}
<div className="flex flex-wrap items-center gap-1.5 px-8">
  {/* filter pills */}
  {(
    [
      { key: "all" as FilterKey, label: "All", count: dims.length },
      {
        key: "attention" as FilterKey,
        label: "Needs attention",
        count: dims.filter(
          (d) => d.values.some((v) => v.status === "new") || stagedDimIds.has(d.id),
        ).length,
      },
      {
        key: "clean" as FilterKey,
        label: "Clean",
        count: dims.filter(
          (d) => !d.values.some((v) => v.status === "new") && !stagedDimIds.has(d.id),
        ).length,
      },
    ] as const
  ).map(({ key, label, count }) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      className={cx(
        "flex h-6 items-center gap-1.5 rounded-sm border px-2.5 font-mono text-[10px] transition-colors",
        filter === key && key === "attention"
          ? "border-warn/40 bg-warn-soft text-warn"
          : filter === key
            ? "border-accent/40 bg-accent-wash text-accent"
            : "border-line-2 bg-surface-2 text-ink-3 hover:text-ink-2",
      )}
    >
      {label}
      <span className="opacity-50">{count}</span>
    </button>
  ))}

  <div className="mx-1 h-4 w-px bg-line-2" />

  {/* sort pills */}
  {(
    [
      { key: "urgency" as SortKey, label: "Urgency" },
      { key: "coverage" as SortKey, label: "Coverage" },
      { key: "name" as SortKey, label: "Name" },
      { key: "rows" as SortKey, label: "Rows" },
    ] as const
  ).map(({ key, label }) => (
    <button
      key={key}
      type="button"
      onClick={() => setSort(key)}
      className={cx(
        "flex h-6 items-center gap-1 rounded-sm border px-2.5 font-mono text-[10px] transition-colors",
        sort === key
          ? "border-line bg-surface-3 text-ink-2"
          : "border-transparent text-ink-3 hover:text-ink-2",
      )}
    >
      {sort === key && <span className="opacity-60">↑</span>}
      {label}
    </button>
  ))}
</div>
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/Dashboard.tsx
git commit -m "feat: add filter/sort toolbar to dashboard"
```

---

## Task 4: DimHealthTable

**Files:**
- Modify: `src/routes/Dashboard.tsx`

- [ ] **Step 1: Add palette imports**

Add to the existing imports in `Dashboard.tsx`:

```ts
import { PALETTE, defaultTintFor } from "../lib/palette";
import { coveragePct, coverageColor, lastAuditForDim } from "./dashboard-helpers";
```

- [ ] **Step 2: Compute lastAuditByDim**

Inside the `Dashboard` function, after `stagedByDim`, add:

```ts
const lastAuditByDim = useMemo(
  () =>
    Object.fromEntries(
      dims.map((d) => [d.id, lastAuditForDim(d.id, d.dimension, auditLog)]),
    ),
  [dims, auditLog],
);
```

- [ ] **Step 3: Add the tint helper**

Add a small inline helper just inside the `Dashboard` function (or just above the return):

```ts
const dimTint = (dim: typeof dims[0]) => {
  const palette = dim.color ?? defaultTintFor(dim.id);
  return PALETTE[palette].fg; // e.g. "var(--tint-rose)"
};
```

- [ ] **Step 4: Render the table**

After the toolbar block, add:

```tsx
{/* Dimension health table */}
<div {...rise(5)} className="px-8 pb-8">
  <table className="w-full border-collapse">
    <thead>
      <tr>
        <th className="w-1 p-0" />
        <th className="border-b border-line-2 bg-surface px-4 py-2 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
          Table
        </th>
        <th className="border-b border-line-2 bg-surface px-4 py-2 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
          Coverage
        </th>
        <th className="border-b border-line-2 bg-surface px-4 py-2 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
          Records
        </th>
        <th className="border-b border-line-2 bg-surface px-4 py-2 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
          Rows
        </th>
        <th className="border-b border-line-2 bg-surface px-4 py-2 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
          Status
        </th>
        <th className="border-b border-line-2 bg-surface px-4 py-2 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
          Last activity
        </th>
      </tr>
    </thead>
    <tbody>
      {visibleDims.map((dim) => {
        const pct = coveragePct(dim);
        const color = coverageColor(pct);
        const newCount = dim.values.filter((v) => v.status === "new").length;
        const dimStaged = stagedByDim[dim.id] ?? [];
        const isStaged = dimStaged.length > 0;
        const lastAudit = lastAuditByDim[dim.id] ?? null;
        const tint = dimTint(dim);
        const hasUrgency = newCount > 0 || isStaged;

        return (
          <tr
            key={dim.id}
            onClick={() =>
              window.location.assign(
                `/app/tables?open=${dim.id}&active=${dim.id}&mode=match`,
              )
            }
            className={cx(
              "cursor-pointer",
              isStaged ? "bg-staged/[0.04] hover:bg-staged/[0.07]" : "hover:bg-hover",
            )}
          >
            {/* tint accent bar — only on urgent rows */}
            <td className="p-0">
              {hasUrgency && (
                <div
                  className="h-10 w-[3px] rounded-sm"
                  style={{ background: tint }}
                />
              )}
            </td>

            {/* table name + map table + optional staged flag */}
            <td className="border-b border-line px-4 py-2.5">
              <div className="flex items-center gap-2.5">
                <div
                  className="h-2 w-2 shrink-0 rounded-pill"
                  style={{ background: tint }}
                />
                <div className="min-w-0">
                  <div className="font-display text-[13px] font-semibold text-ink">
                    {dim.dimension}
                  </div>
                  <div className="font-mono text-[9px] text-ink-3">{dim.mapTable}</div>
                  {isStaged && (
                    <div className="mt-1 flex items-center gap-1 rounded-sm border border-staged/25 bg-staged-soft px-1.5 py-0.5 font-mono text-[9px] text-staged w-fit">
                      <span>⏸</span>
                      <span>
                        {dimStaged.length} staged
                        {dimStaged[0]
                          ? ` · ${dimStaged[0].user.initials} staged "${dimStaged[0].raw}"`
                          : ""}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </td>

            {/* coverage bar + pct */}
            <td className="border-b border-line px-4 py-2.5">
              <div className="flex items-center gap-2">
                <div className="h-[3px] w-18 overflow-hidden rounded-pill bg-surface-3">
                  <div
                    className="h-full rounded-pill"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </div>
                <span
                  className="min-w-[28px] font-mono text-[11px] tabular-nums"
                  style={{ color }}
                >
                  {pct}%
                </span>
              </div>
            </td>

            {/* records */}
            <td className="border-b border-line px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-2">
              {dim.canonical.length.toLocaleString()}
            </td>

            {/* rows */}
            <td className="border-b border-line px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-2">
              {fmtK(dim.rows)}
            </td>

            {/* status badge */}
            <td className="border-b border-line px-4 py-2.5">
              {newCount > 0 ? (
                <Badge tone={newCount > 5 ? "accent" : "warn"} dot>
                  {newCount} new
                </Badge>
              ) : isStaged ? (
                <Badge tone="staged" dot>
                  staged
                </Badge>
              ) : (
                <Badge tone="ok" dot>
                  clean
                </Badge>
              )}
            </td>

            {/* last activity */}
            <td className="border-b border-line px-4 py-2.5">
              {lastAudit ? (
                <div className="flex items-center gap-1.5">
                  <span
                    className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-pill bg-surface-3 font-mono text-[7px] font-semibold text-ink-2"
                  >
                    {lastAudit.user.initials}
                  </span>
                  <span className="font-mono text-[10px] text-ink-3">
                    {lastAudit.action} · {lastAudit.at}
                  </span>
                </div>
              ) : (
                <span className="font-mono text-[10px] text-ink-3">—</span>
              )}
            </td>
          </tr>
        );
      })}

      {/* empty filter state */}
      {visibleDims.length === 0 && (
        <tr>
          <td
            colSpan={7}
            className="border-b border-line px-4 py-8 text-center font-mono text-[11px] text-ink-3"
          >
            no tables match the current filter
          </td>
        </tr>
      )}

      {/* add row */}
      <tr>
        <td colSpan={7} className="px-4 py-2.5">
          <button
            type="button"
            onClick={create.open}
            className="flex items-center gap-1.5 font-mono text-[10px] text-ink-3 transition-colors hover:text-accent"
          >
            <IconPlus className="h-3 w-3" />
            New table
          </button>
        </td>
      </tr>
    </tbody>
  </table>
</div>
```

> **Note on navigation:** Using `window.location.assign` keeps navigation simple. If you prefer React Router's `useNavigate`, import it and call `navigate(...)` instead — either works since the Tables route doesn't need a full page reload.

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck
```

Expected: 0 errors. If you see "'staged' is not a valid tone" check Badge.tsx for the exact tone prop values — it should already accept `"staged"` based on existing usage in Dashboard.

- [ ] **Step 6: Commit**

```bash
git add src/routes/Dashboard.tsx
git commit -m "feat: add dimension health table to dashboard command center"
```

---

## Task 5: Remove old layout sections + final cleanup

**Files:**
- Modify: `src/routes/Dashboard.tsx`

- [ ] **Step 1: Delete the staged-for-review card**

Find and delete the block starting with:
```tsx
{/* staged drafts awaiting review/approve — the OLTP draft layer (Postgres) */}
{staged.length > 0 && (
  <div {...rise(5)}>
    <Card className="p-0">
      ...
    </Card>
  </div>
)}
```

Delete the entire block (lines ~133–179 in the current file).

- [ ] **Step 2: Delete the 2-column grid**

Find and delete the block starting with:
```tsx
<div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr]">
```

This contains both the "Mapping seeds" card and the "Activity" card. Delete the entire block (lines ~181–263 in the current file).

- [ ] **Step 3: Remove unused imports**

Remove these imports that are no longer used after the cleanup:

```ts
import { Card } from "../components/Card";  // remove
```

Keep all other imports — `Badge`, `Button`, `PageHeader`, `Kpi`, `Mark`, `IconWand`, `IconArrowRight`, `IconPlus` are all still used.

- [ ] **Step 4: Tidy the `rise` calls**

The populated-state return now uses `rise` for KPI cards (indices 1–4) and the table section (index 5). Verify the remaining `{...rise(N)}` calls are numbered sequentially — nothing skipped.

- [ ] **Step 5: Run typecheck + tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck && bun run test
```

Expected: 0 typecheck errors, all tests pass (including the 22 new dashboard-helpers tests).

- [ ] **Step 6: Commit**

```bash
git add src/routes/Dashboard.tsx
git commit -m "feat: remove old dashboard card grid; dashboard command center complete"
```

---

## Task 6: Visual smoke test

**Files:** none modified — dev server + browser only.

- [ ] **Step 1: Start dev server**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run dev
```

Open `http://localhost:5173/app` in a browser.

- [ ] **Step 2: Verify the populated state**

Check:
- [ ] Compact header with kicker "Master data" + title + meta bar (live dot · tables · coverage · new)
- [ ] 4 KPI cards with sub-lines in correct colors (green/amber/muted)
- [ ] Toolbar shows All / Needs attention / Clean filter pills + 4 sort pills
- [ ] Table renders all dims, sorted by urgency (worst coverage / most new values first)
- [ ] Tint dots match the dim's `color` from the sidebar
- [ ] Coverage bars are red/amber/green correctly at <80/80–95/≥96
- [ ] "Needs attention" filter hides clean dims
- [ ] "Clean" filter shows only fully-mapped dims
- [ ] Sort pills reorder the table correctly
- [ ] Staged rows (if any drafts exist) show purple wash + inline staged flag
- [ ] "Last activity" column shows `—` or avatar+action+time
- [ ] Clicking any row navigates to `/app/tables?open={id}&active={id}&mode=match`
- [ ] "+ New table" footer row opens the CreateTableModal

- [ ] **Step 3: Verify the empty state**

Navigate to a fresh profile (or temporarily clear dims in the store). Confirm the original empty state renders unchanged (no regressions).

- [ ] **Step 4: Typecheck one final time**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck
```

Expected: 0 errors.

---

## Self-review

**Spec coverage check:**

| Spec requirement | Covered in task |
|---|---|
| Layout A — Command Center | Task 3 (toolbar) + Task 4 (table) |
| Compact header with inline meta bar | Existing PageHeader — no change needed; meta bar already in current Dashboard |
| Full 4-card KPI strip with sub-lines | Task 2 |
| Filter pills: All / Needs attention / Clean | Task 3 |
| Sort pills: Urgency / Coverage / Name / Rows | Task 3 |
| Dimension health table with 7 columns | Task 4 |
| Tint dot + accent bar from dim.color | Task 4 (dimTint helper) |
| Coverage bar colored by health threshold | Task 4 (coverageColor) |
| Staged rows: purple wash + inline flag | Task 4 |
| Activity as last-activity column | Task 4 (lastAuditForDim) |
| "Clean" rows: no tint bar | Task 4 (hasUrgency guard) |
| + New table footer row | Task 4 |
| Remove staged card | Task 5 |
| Remove mapping seeds + activity cards | Task 5 |
| Empty state unchanged | Task 6 (smoke test verification) |

**Type consistency check:** `FilterKey`, `SortKey`, `applyFilter`, `applySort`, `coveragePct`, `coverageColor`, `lastAuditForDim` defined in Task 1 and consumed with matching names in Tasks 3 and 4. `dimTint` is an inline helper, not exported. `stagedDimIds`, `stagedByDim`, `visibleDims`, `lastAuditByDim` all defined in Task 3 and used in Task 4. ✓

**Placeholder scan:** No TBDs, no "similar to above", all code blocks are complete. ✓
