# Sources Monitor Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the per-table Sources monitor as the `sources.html` mockup — four action-driven states, urgency-ordered, a wiring-health headline, a handoff to Map values, and ambient "checked automatically" framing.

**Architecture:** Two modules. (1) `app/src/lib/source-status.ts` — pure functions that collapse the existing six-state `standing` into four action states (`classifySource`), sort sources by urgency, and summarize a dimension's wiring health. `Date.now()` is injectable for deterministic tests. (2) `app/src/components/modes/SourcesMonitorBody.tsx` — the redesigned component that reads `useSources()`, classifies + orders, and renders the health header, an optional "map them" handoff banner, and the per-column status rows with re-scan. Verified by a testing-library interaction test (store hooks mocked). It is built standalone; replacing the current `WiredSourcesModeBody` in the tab is a follow-up.

**Tech Stack:** TypeScript (strict), React, Tailwind, Vitest + jsdom + `@testing-library/react` + `react-router-dom` `MemoryRouter`. Run from the `app/` workspace.

**Plan series:** Plan **6 of 7**. Depends on the store's `SourceInfo`/`useSources`/`deriveCanonical` (on `main`). Independent of the cluster-mapper plans. Downstream: 7 (IA/naming); and the tab-wiring follow-up for both this and `ClusterMapperCard`.

## Global Constraints

- **Four action states, Broken kept distinct** (grilled decision): `classifySource` returns `"broken" | "new" | "stale" | "healthy"`, collapsing the current `standing` (`LedgerRow.tsx:46-58`): `not found`→**broken**; `drift`/`stale drift` (`unmapped>0`)→**new**; `stale`/`unscanned`→**stale** (="not checked recently"); `clean`→**healthy**. A `stale` flag rides alongside `new` for a "counts may be stale" note.
- **Deterministic classification.** `classifySource`/`sortByUrgency`/`summarizeSources` take an injectable `nowMs = Date.now()`; the staleness threshold is `STALE_DAYS = 7` (matches `components/sources/utils.ts`).
- **Lead with wiring health + a mapping handoff**, not a coverage KPI (grilled decision). Coverage % does not appear on this surface.
- **Ambient framing.** State that scanning is automatic (backend `scanSourcesJob` confirmed); per-row **Re-check** is the exception, not the loop.
- **Real Tailwind tokens** (verbatim from `WiredSourcesModeBody.tsx`): `bg-surface`/`bg-surface-2`, `text-ink`/`text-ink-2`/`text-ink-3`, `text-accent`/`bg-accent`, `border-line`, `font-mono`/`font-display`, `rounded-sm`/`rounded-pill`, `text-ok`/`text-warn`/`text-danger`/`text-committed`. Reuse `Button`, `Icons` (`IconArrowRight`, `IconWand`), `cx`.
- **Extensionless app imports.** `source-status.ts` in `app/src/lib/`; component in `app/src/components/modes/`.
- **Gates:** from `app/`, `tsc --noEmit` and `eslint src` clean for changed files.

### Test command (from `app/`)

```
npx vitest run src/lib/source-status.test.ts
npx vitest run src/components/modes/SourcesMonitorBody.test.tsx
```

## File Structure

- `app/src/lib/source-status.ts` — **new.** `classifySource`, `sortByUrgency`, `summarizeSources`, types.
- `app/src/lib/source-status.test.ts` — **new.** Pure tests (fixed `nowMs`).
- `app/src/components/modes/SourcesMonitorBody.tsx` — **new.** The redesigned monitor.
- `app/src/components/modes/SourcesMonitorBody.test.tsx` — **new.** testing-library test (mocks store hooks + nav; `MemoryRouter`).

## Interfaces Produced

```ts
// source-status.ts
import type { SourceInfo } from "../store";
export const STALE_DAYS = 7;
export type SourceStatus = "broken" | "new" | "stale" | "healthy";
export interface SourceStatusInfo { status: SourceStatus; unmapped: number; stale: boolean }
export function classifySource(s: SourceInfo, nowMs?: number): SourceStatusInfo;
export function sortByUrgency(sources: SourceInfo[], nowMs?: number): { source: SourceInfo; status: SourceStatusInfo }[];
export interface SourcesSummary { total: number; broken: number; needsMapping: number; notChecked: number; healthy: number; newValuesTotal: number }
export function summarizeSources(sources: SourceInfo[], nowMs?: number): SourcesSummary;
```

`SourceInfo` (from `store.ts:104-115`, type-only import): `{ table, column, dimension, dimId, present, rows, values, unmapped, scanned, scannedAt? }`.

---

### Task 1: `source-status.ts` — classify + order + summarize (pure)

**Files:**
- Create: `app/src/lib/source-status.ts`
- Test: `app/src/lib/source-status.test.ts`

**Interfaces:**
- Consumes: `SourceInfo` (type, `../store`).
- Produces: `STALE_DAYS`, `SourceStatus`, `SourceStatusInfo`, `classifySource`, `sortByUrgency`, `SourcesSummary`, `summarizeSources`.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/source-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifySource, sortByUrgency, summarizeSources } from "./source-status";
import type { SourceInfo } from "../store";

const NOW = new Date("2026-07-16T00:00:00Z").getTime();
const DAY = 86_400_000;

function src(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    table: "orders", column: "ship_country", dimension: "Country", dimId: "d1",
    present: true, rows: 1000, values: 10, unmapped: 0, scanned: true,
    scannedAt: new Date(NOW - DAY).toISOString(), // 1 day ago = fresh
    ...over,
  };
}

describe("classifySource", () => {
  it("broken: scanned but the column no longer exists", () => {
    expect(classifySource(src({ present: false, scanned: true }), NOW).status).toBe("broken");
  });
  it("new: has unmapped values (fresh or stale)", () => {
    expect(classifySource(src({ unmapped: 5 }), NOW).status).toBe("new");
    const staleNew = classifySource(src({ unmapped: 5, scannedAt: new Date(NOW - 30 * DAY).toISOString() }), NOW);
    expect(staleNew.status).toBe("new");
    expect(staleNew.stale).toBe(true); // drives the "counts may be stale" note
  });
  it("stale (not checked recently): never scanned, or resolved but overdue", () => {
    expect(classifySource(src({ scanned: false, scannedAt: null }), NOW).status).toBe("stale");
    expect(classifySource(src({ unmapped: 0, scannedAt: new Date(NOW - 30 * DAY).toISOString() }), NOW).status).toBe("stale");
  });
  it("healthy: resolved and freshly scanned", () => {
    expect(classifySource(src(), NOW).status).toBe("healthy");
  });
});

describe("sortByUrgency", () => {
  it("orders broken > new > stale > healthy, then by unmapped desc", () => {
    const out = sortByUrgency(
      [
        src({ column: "a", unmapped: 0 }), // healthy
        src({ column: "b", present: false, scanned: true }), // broken
        src({ column: "c", unmapped: 3 }), // new (3)
        src({ column: "d", unmapped: 9 }), // new (9)
        src({ column: "e", scanned: false, scannedAt: null }), // stale
      ],
      NOW,
    );
    expect(out.map((o) => o.source.column)).toEqual(["b", "d", "c", "e", "a"]);
  });
});

describe("summarizeSources", () => {
  it("counts per status and sums new values", () => {
    const s = summarizeSources(
      [src({ unmapped: 4 }), src({ unmapped: 6 }), src({ present: false, scanned: true }), src({ unmapped: 0 })],
      NOW,
    );
    expect(s).toEqual({ total: 4, broken: 1, needsMapping: 2, notChecked: 0, healthy: 1, newValuesTotal: 10 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/lib/source-status.test.ts`
Expected: FAIL — cannot resolve `./source-status`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/source-status.ts`:

```ts
import type { SourceInfo } from "../store";

/** Days after a scan a source is considered overdue (matches components/sources/utils.ts). */
export const STALE_DAYS = 7;

export type SourceStatus = "broken" | "new" | "stale" | "healthy";
export interface SourceStatusInfo {
  status: SourceStatus;
  unmapped: number;
  /** Scan is overdue — a secondary "counts may be stale" flag on a "new" row. */
  stale: boolean;
}

function daysAgo(iso: string | null | undefined, nowMs: number): number {
  if (!iso) return Infinity;
  return (nowMs - new Date(iso).getTime()) / 86_400_000;
}

/**
 * Collapse a source into one of four action states (grilled decision), mirroring
 * the existing six-state `standing` derivation: never-scanned or overdue-and-clean
 * → "stale" (not checked recently); vanished column → "broken"; unmapped values →
 * "new"; else "healthy". Broken is kept distinct from stale on purpose.
 */
export function classifySource(s: SourceInfo, nowMs: number = Date.now()): SourceStatusInfo {
  const stale = daysAgo(s.scannedAt, nowMs) > STALE_DAYS;
  let status: SourceStatus;
  if (!s.scanned && !s.scannedAt) status = "stale"; // never checked
  else if (!s.present && s.scanned) status = "broken"; // column vanished from the warehouse
  else if (s.unmapped > 0) status = "new"; // values need a record
  else if (stale) status = "stale"; // resolved but overdue
  else status = "healthy";
  return { status, unmapped: s.unmapped, stale };
}

const RANK: Record<SourceStatus, number> = { broken: 0, new: 1, stale: 2, healthy: 3 };

/** Sources paired with their status, ordered by urgency then by unmapped desc, rows desc. */
export function sortByUrgency(
  sources: SourceInfo[],
  nowMs: number = Date.now(),
): { source: SourceInfo; status: SourceStatusInfo }[] {
  return sources
    .map((source) => ({ source, status: classifySource(source, nowMs) }))
    .sort(
      (a, b) =>
        RANK[a.status.status] - RANK[b.status.status] ||
        b.status.unmapped - a.status.unmapped ||
        b.source.rows - a.source.rows,
    );
}

export interface SourcesSummary {
  total: number;
  broken: number;
  needsMapping: number;
  notChecked: number;
  healthy: number;
  newValuesTotal: number;
}

/** Dimension-level wiring health: counts per action state + total unmapped values. */
export function summarizeSources(sources: SourceInfo[], nowMs: number = Date.now()): SourcesSummary {
  const out: SourcesSummary = { total: sources.length, broken: 0, needsMapping: 0, notChecked: 0, healthy: 0, newValuesTotal: 0 };
  for (const s of sources) {
    const { status } = classifySource(s, nowMs);
    if (status === "broken") out.broken++;
    else if (status === "new") {
      out.needsMapping++;
      out.newValuesTotal += s.unmapped;
    } else if (status === "stale") out.notChecked++;
    else out.healthy++;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/lib/source-status.test.ts`
Expected: PASS — all classify/sort/summarize tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/source-status.ts app/src/lib/source-status.test.ts
git commit -m "feat(sources): add pure source classification (4 action states)"
```

---

### Task 2: `SourcesMonitorBody` — the redesigned monitor

**Files:**
- Create: `app/src/components/modes/SourcesMonitorBody.tsx`
- Test: `app/src/components/modes/SourcesMonitorBody.test.tsx`

**Interfaces:**
- Consumes: `useSources`/`useCanEdit`/`deriveCanonical` (`../../store`), `sortByUrgency`/`summarizeSources`/`SourceStatus` (`../../lib/source-status`), `useNavLinks` (`../../lib/use-tenant-navigate`), `useAsyncAction` (`../../hooks/useAsyncAction`), `toast` (`../Toast`), `Button`, `IconWand`/`IconArrowRight` (`../Icons`), `cx`, `MappingDimension` (type, `../../data`).
- Produces: `SourcesMonitorBody({ dim })`.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/modes/SourcesMonitorBody.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SourceInfo } from "../../store";

const { sourcesRef } = vi.hoisted(() => ({ sourcesRef: { current: [] as SourceInfo[] } }));
vi.mock("../../store", () => ({
  useSources: () => sourcesRef.current,
  useCanEdit: () => true,
  deriveCanonical: vi.fn().mockResolvedValue({ derived: 0, mode: "connect", matched: 0, unmatched: 0 }),
}));
vi.mock("../../lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({ sources: "/sources", table: () => "/tables" }),
}));
vi.mock("../Toast", () => ({ toast: vi.fn() }));

import { deriveCanonical } from "../../store";
import { SourcesMonitorBody } from "./SourcesMonitorBody";
import type { MappingDimension } from "../../data";

const deriveMock = deriveCanonical as unknown as ReturnType<typeof vi.fn>;
const DIM = { id: "d1", dimension: "Country" } as unknown as MappingDimension;
const NOW = Date.now();

function src(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    table: "orders", column: "ship_country", dimension: "Country", dimId: "d1",
    present: true, rows: 1000, values: 10, unmapped: 0, scanned: true,
    scannedAt: new Date(NOW - 86_400_000).toISOString(),
    ...over,
  };
}
function renderCard() {
  return render(
    <MemoryRouter>
      <SourcesMonitorBody dim={DIM} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  deriveMock.mockClear();
  sourcesRef.current = [];
});

describe("SourcesMonitorBody", () => {
  it("shows the first-run empty state when nothing is wired", () => {
    const { getByText } = renderCard();
    expect(getByText(/Browse warehouse/i)).toBeTruthy();
  });

  it("leads with wiring health and a mapping handoff when values need a record", () => {
    sourcesRef.current = [
      src({ column: "ship_country", unmapped: 24 }),
      src({ column: "bill_country", unmapped: 0 }),
    ];
    const { getByText } = renderCard();
    expect(getByText(/columns feed this table/i)).toBeTruthy(); // header (count is a separate span)
    expect(getByText(/24 new values/i)).toBeTruthy(); // handoff banner
  });

  it("orders broken first and renders its status, no coverage %", () => {
    sourcesRef.current = [
      src({ column: "ship_country", unmapped: 5 }),
      src({ column: "legacy_code", present: false, scanned: true }),
    ];
    const { getAllByRole, queryByText } = renderCard();
    const rows = getAllByRole("listitem");
    expect(within(rows[0]).getByText(/broken/i)).toBeTruthy(); // broken row first
    expect(queryByText(/coverage/i)).toBeNull(); // no coverage KPI on this surface
  });

  it("re-check calls deriveCanonical for that column", () => {
    sourcesRef.current = [src({ column: "ship_country", unmapped: 3 })];
    const { getByLabelText } = renderCard();
    fireEvent.click(getByLabelText(/re-check ship_country/i));
    expect(deriveMock).toHaveBeenCalledWith("d1", "orders", "ship_country");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/components/modes/SourcesMonitorBody.test.tsx`
Expected: FAIL — cannot resolve `./SourcesMonitorBody`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/components/modes/SourcesMonitorBody.tsx`:

```tsx
import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { MappingDimension } from "../../data";
import { useSources, useCanEdit, deriveCanonical } from "../../store";
import { sortByUrgency, summarizeSources, type SourceStatus } from "../../lib/source-status";
import { useNavLinks } from "../../lib/use-tenant-navigate";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { toast } from "../Toast";
import { Button } from "../Button";
import { IconWand, IconArrowRight } from "../Icons";
import { cx } from "../../lib/cx";
import { ago } from "../sources/utils";

const STATUS_META: Record<SourceStatus, { label: string; pill: string; bar: string }> = {
  broken: { label: "Broken", pill: "bg-danger-soft text-danger", bar: "border-l-danger" },
  new: { label: "New values", pill: "bg-warn-soft text-warn", bar: "border-l-warn" },
  stale: { label: "Not checked", pill: "bg-surface-2 text-ink-3", bar: "border-l-ink-3" },
  healthy: { label: "Healthy", pill: "bg-ok-soft text-ok", bar: "border-l-committed" },
};

/* SourcesMonitorBody — the "plumbing" view for one table. Classifies each wired
   column into four action states, orders by urgency, and hands the mapping work
   off to Map values. Scanning is automatic; per-row Re-check is the exception. */
export function SourcesMonitorBody({ dim }: { dim: MappingDimension }) {
  const sources = useSources();
  const canEdit = useCanEdit();
  const nav = useNavLinks();
  const wired = useMemo(() => sources.filter((s) => s.dimId === dim.id), [sources, dim.id]);
  const ranked = useMemo(() => sortByUrgency(wired), [wired]);
  const summary = useMemo(() => summarizeSources(wired), [wired]);

  const recheck = useAsyncAction(async (table: string, column: string) => {
    try {
      await deriveCanonical(dim.id, table, column);
      toast(`Re-checked ${table}.${column}`);
    } catch (e) {
      toast(e instanceof Error ? `Couldn't re-check ${table}.${column}: ${e.message}` : `Couldn't re-check ${table}.${column}.`, "error");
      throw e;
    }
  });

  if (wired.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 py-16">
        <div className="max-w-[44ch] text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center border border-line bg-surface-2 text-ink-3">
            <IconWand className="h-5 w-5" />
          </div>
          <div className="font-display text-[20px] font-semibold text-ink">Watch a column to get started.</div>
          <p className="mx-auto mt-2 text-[13px] leading-snug text-ink-3">
            This table catches new {dim.dimension} values as they appear in your warehouse. Point it at a column and Zugzug scans it automatically from then on.
          </p>
          <div className="mt-5 inline-flex">
            <Link to={nav.sources}>
              <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>Browse warehouse</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const needsAttention = summary.broken + summary.needsMapping + summary.notChecked;
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
      {/* wiring-health header */}
      <header className="border-b border-line bg-surface px-5 pt-5 pb-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">sources · {dim.dimension}</div>
        <h2 className="mt-2 font-display text-[22px] font-semibold tracking-[-0.02em] text-ink">
          <span className="tabular-nums">{wired.length}</span>{" "}
          <span className="text-ink-2">column{wired.length === 1 ? "" : "s"} feed this table</span>
          {needsAttention > 0 && <span className="ml-2 font-mono text-[12px] text-ink-3">· {needsAttention} need a look</span>}
        </h2>
        <div className="mt-2 font-mono text-[11px] text-ink-3">Checked automatically · re-check any column below to refresh it now</div>
      </header>

      {summary.newValuesTotal > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-accent-wash px-5 py-3">
          <span className="text-[14px] text-ink">
            <span className="font-semibold">{summary.newValuesTotal.toLocaleString("en-US")} new values</span> across {summary.needsMapping} column{summary.needsMapping === 1 ? "" : "s"} need a record.
          </span>
          <Link to={nav.table(dim.id, "match")} className="ml-auto">
            <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>Map them</Button>
          </Link>
        </div>
      )}

      {/* per-column status rows, urgency-ordered */}
      <ul className="flex flex-col">
        {ranked.map(({ source: s, status: st }) => {
          const meta = STATUS_META[st.status];
          return (
            <li
              key={`${s.table}.${s.column}`}
              className={cx("grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-line border-l-2 bg-surface px-5 py-3.5", meta.bar)}
            >
              <span className={cx("rounded-pill px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wide", meta.pill)}>
                {meta.label}
              </span>
              <div className="min-w-0">
                <div className="font-mono text-[14px] font-semibold text-ink">
                  {s.table}
                  <span className="text-ink-3">.{s.column}</span>
                  <span className="text-ink-3"> → {dim.dimension}</span>
                </div>
                <div className="mt-1 font-mono text-[11.5px] text-ink-3">
                  {st.status === "broken"
                    ? "Column no longer exists in the warehouse"
                    : st.status === "stale" && !s.scanned
                      ? "Never scanned since it was wired"
                      : `${s.rows.toLocaleString("en-US")} rows${s.scannedAt ? ` · checked ${ago(s.scannedAt)} ago` : ""}${st.stale ? " · counts may be stale" : ""}`}
                </div>
              </div>
              <div className="text-right">
                <div className={cx("font-mono text-[17px] font-semibold tabular-nums", st.status === "new" ? "text-warn" : "text-ink-3")}>
                  {st.status === "new" ? st.unmapped.toLocaleString("en-US") : st.status === "healthy" ? "0" : "—"}
                </div>
                <div className="font-mono text-[10px] text-ink-3">{st.status === "healthy" ? "all resolved" : st.status === "new" ? "need a record" : ""}</div>
              </div>
              <div className="flex items-center gap-2">
                {st.status === "new" && (
                  <Link to={nav.table(dim.id, "match")}>
                    <Button size="sm">Map these</Button>
                  </Link>
                )}
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Re-check ${s.column}`}
                    onClick={() => void recheck.run(s.table, s.column)}
                    className="grid h-8 w-8 place-items-center border border-line text-ink-3 hover:bg-hover hover:text-ink"
                  >
                    <IconWand className="h-4 w-4" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/components/modes/SourcesMonitorBody.test.tsx`
Expected: PASS — all 4 tests pass. (If `ago(...)` needs a value in tests, note the fixtures set `scannedAt`; the empty-state test has no sources so `ago` isn't hit.)

- [ ] **Step 5: Run the gates**

Run (from `app/`): `npx tsc --noEmit`
Expected: no NEW errors referencing `source-status.ts` or `SourcesMonitorBody.tsx`.

Run (from `app/`): `npx eslint src/lib/source-status.ts src/lib/source-status.test.ts src/components/modes/SourcesMonitorBody.tsx src/components/modes/SourcesMonitorBody.test.tsx`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/modes/SourcesMonitorBody.tsx app/src/components/modes/SourcesMonitorBody.test.tsx
git commit -m "feat(sources): add redesigned SourcesMonitorBody (4-state monitor)"
```

---

## Self-Review

**Spec coverage:**
- Four action states, Broken distinct → Task 1 `classifySource`, asserted for all four; Task 2 renders the pill + urgency order (broken first).
- Wiring-health headline + handoff, no coverage % → Task 2 header + accent-wash banner; test asserts "2 columns", "24 new values", and `queryByText(/coverage/i)` is null.
- Ambient framing → header copy "Checked automatically".
- Re-check per column → Task 2 wand button → `deriveCanonical(dim.id, table, column)`, asserted.
- First-run empty state → Task 2, asserted ("Browse warehouse").
- Deterministic classification → `nowMs` injected; Task 1 tests use a fixed `NOW`.

**Placeholder scan:** No TBD/TODO. Every step has literal code + the exact `npx vitest run <file>` command.

**Type consistency:** `SourceInfo` (type-only) from `store.ts`; `SourceStatus`/`sortByUrgency`/`summarizeSources` from Task 1; `deriveCanonical`/`useSources`/`useCanEdit` signatures per `store.ts`; `nav.table(dimId, "match")` per `use-tenant-navigate.ts`.

**Known follow-ups (not in scope):** replacing `WiredSourcesModeBody` with this in `TablePane`; smart column suggestions in the empty state (no client-side catalog-by-name-match exists today).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-sources-monitor.md`.

Two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
