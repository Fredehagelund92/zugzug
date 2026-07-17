# Cluster-Mapper Data & State Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the app-side brains of the cluster mapper — a hook that loads the `/clusters` feed, plus the pure candidate-list and reducer logic the focused card will render — all unit-tested, with no JSX yet.

**Architecture:** Three focused modules under `app/src/lib/`. (1) `useDimClusters` mirrors the existing `useDimValuesPage` but hits the Plan-2 `GET /dimensions/:id/clusters` endpoint and returns the whole feed (`clusters`, `coverage`, `truncated`). (2) `cluster-candidates.ts` is a pure builder for the type-ahead list (closest local match first, or query-filtered, plus a "create" row). (3) `cluster-mapper-reducer.ts` is a pure state machine over cluster decisions (map / skip / undo / advance). The JSX card that wires these to the keyboard is a later plan; keeping the logic pure and separately tested is what makes that plan small.

**Tech Stack:** TypeScript (strict), React, Vitest + jsdom + `@testing-library/react` (`renderHook`/`waitFor`/`act`). Run from the `app/` workspace.

**Plan series:** Plan **3 of 7**. Depends on Plan 2's `GET /dimensions/:id/clusters` (merged to `main`). Downstream: Plan 4 (the focused-card JSX) renders `useDimClusters` + these helpers and wires keyboard/undo to the store's `saveDraft`/`discardDraft`/`commit`.

## Global Constraints

- **Mirror the existing hook.** `useDimClusters` follows `app/src/lib/use-dim-values-page.ts`: `apiFetch` returns a raw `Response` (caller checks `!r.ok`, parses `r.json()`); use a `seq` ref to discard stale responses; expose `loading`/`error`/`refetch`; re-fetch when `(dimId, filter, enabled)` change.
- **Pure helpers stay pure.** `cluster-candidates.ts` and `cluster-mapper-reducer.ts` import nothing from React, the store, or the network. Deterministic in, deterministic out.
- **Conservative fold, client-side.** The "closest match" uses a local `foldLabel` (lowercase, strip diacritics, drop non-alphanumerics) — the same conservative idea as the server's `normalizeKey`. It is duplicated here on purpose: the server module (`server/src/cluster-values.ts`) is a different package and is not importable in the browser bundle.
- **Explicit relative imports**, matching the codebase (no `.ts` extension in app imports — app uses extensionless relative imports, e.g. `import { apiFetch } from "../api"`; follow the existing `use-dim-values-page.ts` style exactly).
- **Gates:** from `app/`, `tsc --noEmit` and `eslint src` clean for changed files.

### Test command (from `app/`), used in every task

```
npx vitest run src/lib/<file>.test.ts
```

(Prerequisite: app deps installed — `bun install` from `app/` if `node_modules` is missing. No database or server is needed; these tests mock `apiFetch` or are pure.)

## File Structure

- `app/src/lib/use-dim-clusters.ts` — **new.** The `useDimClusters` hook + its exported types (`Cluster`, `ClusterMember`, `Coverage`, `DimClusterFeed`, opts, return).
- `app/src/lib/use-dim-clusters.test.ts` — **new.** `renderHook` tests with a mocked `apiFetch`.
- `app/src/lib/cluster-candidates.ts` — **new.** `foldLabel`, `buildCandidates`, and their types.
- `app/src/lib/cluster-candidates.test.ts` — **new.** Pure tests.
- `app/src/lib/cluster-mapper-reducer.ts` — **new.** `clusterMapperReducer`, `initMapperState`, `stagedCount`, and types.
- `app/src/lib/cluster-mapper-reducer.test.ts` — **new.** Pure tests.

## Interfaces Produced (for Plan 4)

```ts
// use-dim-clusters.ts
export interface ClusterMember { raw: string; rows: number; isMapped: boolean; mappedLabel: string | null; occurrences: { table: string; column: string; rows: number }[] }
export interface Cluster { key: string; rep: string; members: ClusterMember[]; rows: number; mappedCount: number }
export interface Coverage { resolvedRows: number; atRiskRows: number; pct: number }
export interface DimClusterFeed { clusters: Cluster[]; coverage: Coverage; truncated: boolean }
export interface UseDimClustersOpts { dimId: string | null; filter: "new" | "mapped" | "all"; enabled?: boolean }
export interface UseDimClusters { clusters: Cluster[]; coverage: Coverage; truncated: boolean; loading: boolean; error: string | null; refetch: () => void }
export function useDimClusters(opts: UseDimClustersOpts): UseDimClusters;

// cluster-candidates.ts
export interface CandidateRecord { key: string; label: string }
export type Candidate =
  | { kind: "record"; key: string; label: string; closest: boolean }
  | { kind: "create"; label: string };
export function foldLabel(s: string): string;
export function buildCandidates(records: CandidateRecord[], query: string, rep: string, limit?: number): Candidate[];

// cluster-mapper-reducer.ts
export type Decision = { status: "mapped"; recordKey: string; recordLabel: string } | { status: "skipped" };
export interface MapperState { order: string[]; cursor: number; decisions: Record<string, Decision>; undo: string[] }
export type MapperAction =
  | { type: "init"; clusterKeys: string[] }
  | { type: "map"; clusterKey: string; recordKey: string; recordLabel: string }
  | { type: "skip"; clusterKey: string }
  | { type: "undo" }
  | { type: "jumpTo"; index: number };
export function initMapperState(clusterKeys: string[]): MapperState;
export function clusterMapperReducer(state: MapperState, action: MapperAction): MapperState;
export function stagedCount(state: MapperState): number;
```

---

### Task 1: `useDimClusters` hook

**Files:**
- Create: `app/src/lib/use-dim-clusters.ts`
- Test: `app/src/lib/use-dim-clusters.test.ts`

**Interfaces:**
- Consumes: `apiFetch` from `../api`.
- Produces: the `use-dim-clusters.ts` exports listed above.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/use-dim-clusters.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../api", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../api";
import { useDimClusters, type DimClusterFeed } from "./use-dim-clusters";

const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const FEED: DimClusterFeed = {
  clusters: [
    { key: "usa", rep: "USA", rows: 1500, mappedCount: 0, members: [
      { raw: "USA", rows: 1000, isMapped: false, mappedLabel: null, occurrences: [] },
      { raw: "U.S.A.", rows: 500, isMapped: false, mappedLabel: null, occurrences: [] },
    ] },
  ],
  coverage: { resolvedRows: 300, atRiskRows: 1500, pct: 17 },
  truncated: false,
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => mockFetch.mockReset());

describe("useDimClusters", () => {
  it("loads the cluster feed and calls the clusters endpoint", async () => {
    mockFetch.mockResolvedValue(okResponse(FEED));
    const { result } = renderHook(() => useDimClusters({ dimId: "d1", filter: "new" }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.clusters).toHaveLength(1);
    expect(result.current.clusters[0].key).toBe("usa");
    expect(result.current.coverage.pct).toBe(17);
    expect(result.current.truncated).toBe(false);
    expect(result.current.error).toBeNull();

    const calledPath = mockFetch.mock.calls[0][0] as string;
    expect(calledPath).toContain("/dimensions/d1/clusters");
    expect(calledPath).toContain("filter=new");
  });

  it("surfaces an error on a non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const { result } = renderHook(() => useDimClusters({ dimId: "d1", filter: "new" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("HTTP 500");
    expect(result.current.clusters).toEqual([]);
  });

  it("does not fetch when dimId is null", async () => {
    const { result } = renderHook(() => useDimClusters({ dimId: null, filter: "new" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/lib/use-dim-clusters.test.ts`
Expected: FAIL — cannot resolve `./use-dim-clusters` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/use-dim-clusters.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";

export interface ClusterMember {
  raw: string;
  rows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}
export interface Cluster {
  key: string;
  rep: string;
  members: ClusterMember[];
  rows: number;
  mappedCount: number;
}
export interface Coverage {
  resolvedRows: number;
  atRiskRows: number;
  pct: number;
}
export interface DimClusterFeed {
  clusters: Cluster[];
  coverage: Coverage;
  truncated: boolean;
}

export interface UseDimClustersOpts {
  dimId: string | null;
  filter: "new" | "mapped" | "all";
  enabled?: boolean;
}
export interface UseDimClusters {
  clusters: Cluster[];
  coverage: Coverage;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY_COVERAGE: Coverage = { resolvedRows: 0, atRiskRows: 0, pct: 100 };

/** Load the whole cluster feed for a dimension. Mirrors useDimValuesPage's
 *  race-safe fetch shape, but the feed is a single (non-paginated) payload. */
export function useDimClusters(opts: UseDimClustersOpts): UseDimClusters {
  const { dimId, filter, enabled = true } = opts;
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [coverage, setCoverage] = useState<Coverage>(EMPTY_COVERAGE);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const fetchFeed = useCallback(async () => {
    if (!dimId || !enabled) return;
    const ticket = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ filter });
      const r = await apiFetch(`/dimensions/${encodeURIComponent(dimId)}/clusters?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as DimClusterFeed;
      if (ticket !== seq.current) return;
      setClusters(body.clusters);
      setCoverage(body.coverage);
      setTruncated(body.truncated);
    } catch (e) {
      if (ticket !== seq.current) return;
      setClusters([]);
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [dimId, filter, enabled]);

  useEffect(() => {
    setClusters([]);
    setCoverage(EMPTY_COVERAGE);
    setTruncated(false);
    void fetchFeed();
  }, [fetchFeed]);

  const refetch = useCallback(() => {
    void fetchFeed();
  }, [fetchFeed]);

  return { clusters, coverage, truncated, loading, error, refetch };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/lib/use-dim-clusters.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/use-dim-clusters.ts app/src/lib/use-dim-clusters.test.ts
git commit -m "feat(mapper): add useDimClusters hook for the /clusters feed"
```

---

### Task 2: `buildCandidates` + `foldLabel` (pure)

**Files:**
- Create: `app/src/lib/cluster-candidates.ts`
- Test: `app/src/lib/cluster-candidates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CandidateRecord`, `Candidate`, `foldLabel(s)`, `buildCandidates(records, query, rep, limit?)`.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/cluster-candidates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { foldLabel, buildCandidates, type CandidateRecord } from "./cluster-candidates";

const RECORDS: CandidateRecord[] = [
  { key: "us", label: "United States" },
  { key: "gb", label: "United Kingdom" },
  { key: "de", label: "Germany" },
  { key: "fr", label: "France" },
];

describe("foldLabel", () => {
  it("folds case, punctuation, and diacritics", () => {
    expect(foldLabel("United States")).toBe("unitedstates");
    expect(foldLabel("Déjà")).toBe("deja");
    expect(foldLabel("U.S.A.")).toBe("usa");
  });
});

describe("buildCandidates", () => {
  it("with no query, puts the exact fold-match of rep first and marks it closest", () => {
    const out = buildCandidates(RECORDS, "", "united states", 3);
    expect(out[0]).toEqual({ kind: "record", key: "us", label: "United States", closest: true });
    // remaining records fill up to `limit`, none marked closest
    expect(out.filter((c) => c.kind === "record" && c.closest)).toHaveLength(1);
    // a create row is always last
    expect(out[out.length - 1]).toEqual({ kind: "create", label: "united states" });
  });

  it("with no fold-match, returns records (none closest) then a create row for rep", () => {
    const out = buildCandidates(RECORDS, "", "Grande-Bretagne", 2);
    expect(out.some((c) => c.kind === "record" && c.closest)).toBe(false);
    expect(out.filter((c) => c.kind === "record")).toHaveLength(2);
    expect(out[out.length - 1]).toEqual({ kind: "create", label: "Grande-Bretagne" });
  });

  it("with a query, filters records by label/key (case-insensitive) then a create row for the query", () => {
    const out = buildCandidates(RECORDS, "united", "USA", 10);
    const recs = out.filter((c) => c.kind === "record") as Extract<typeof out[number], { kind: "record" }>[];
    expect(recs.map((r) => r.key)).toEqual(["us", "gb"]);
    expect(out[out.length - 1]).toEqual({ kind: "create", label: "united" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/lib/cluster-candidates.test.ts`
Expected: FAIL — cannot resolve `./cluster-candidates`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/cluster-candidates.ts`:

```ts
export interface CandidateRecord {
  key: string;
  label: string;
}
export type Candidate =
  | { kind: "record"; key: string; label: string; closest: boolean }
  | { kind: "create"; label: string };

/** Conservative client-side fold — the browser twin of the server's
 *  normalizeKey (separate package, cannot be imported). Lowercase, strip
 *  diacritics, drop every non-alphanumeric character. */
export function foldLabel(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Build the type-ahead candidate list. With an empty query, the record whose
 * label folds to the same key as `rep` is placed first and marked `closest`,
 * followed by other records up to `limit`. With a query, records whose label or
 * key contains the query (case-insensitive) are returned. A `create` row is
 * always appended — labelled with the query when searching, else with `rep`.
 */
export function buildCandidates(
  records: CandidateRecord[],
  query: string,
  rep: string,
  limit = 4,
): Candidate[] {
  const q = query.trim();
  const out: Candidate[] = [];

  if (q) {
    const needle = q.toLowerCase();
    for (const r of records) {
      if (r.label.toLowerCase().includes(needle) || r.key.toLowerCase().includes(needle)) {
        out.push({ kind: "record", key: r.key, label: r.label, closest: false });
      }
    }
    out.push({ kind: "create", label: q });
    return out;
  }

  const repKey = foldLabel(rep);
  const closest = records.find((r) => foldLabel(r.label) === repKey);
  if (closest) {
    out.push({ kind: "record", key: closest.key, label: closest.label, closest: true });
  }
  for (const r of records) {
    if (closest && r.key === closest.key) continue;
    if (out.filter((c) => c.kind === "record").length >= limit) break;
    out.push({ kind: "record", key: r.key, label: r.label, closest: false });
  }
  out.push({ kind: "create", label: rep });
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/lib/cluster-candidates.test.ts`
Expected: PASS — all `foldLabel` and `buildCandidates` tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/cluster-candidates.ts app/src/lib/cluster-candidates.test.ts
git commit -m "feat(mapper): add pure candidate-list builder with closest-match fold"
```

---

### Task 3: `clusterMapperReducer` (pure state machine)

**Files:**
- Create: `app/src/lib/cluster-mapper-reducer.ts`
- Test: `app/src/lib/cluster-mapper-reducer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Decision`, `MapperState`, `MapperAction`, `initMapperState`, `clusterMapperReducer`, `stagedCount`.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/cluster-mapper-reducer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  initMapperState,
  clusterMapperReducer,
  stagedCount,
  type MapperState,
} from "./cluster-mapper-reducer";

const KEYS = ["usa", "germany", "uk"];
const init = (): MapperState => initMapperState(KEYS);

describe("clusterMapperReducer", () => {
  it("initializes at cursor 0 with no decisions", () => {
    const s = init();
    expect(s.order).toEqual(KEYS);
    expect(s.cursor).toBe(0);
    expect(s.decisions).toEqual({});
    expect(s.undo).toEqual([]);
  });

  it("map records the decision and advances to the next undecided cluster", () => {
    const s = clusterMapperReducer(init(), { type: "map", clusterKey: "usa", recordKey: "us", recordLabel: "United States" });
    expect(s.decisions.usa).toEqual({ status: "mapped", recordKey: "us", recordLabel: "United States" });
    expect(s.cursor).toBe(1); // advanced to "germany"
    expect(s.undo).toEqual(["usa"]);
    expect(stagedCount(s)).toBe(1);
  });

  it("skip records a skipped decision and advances", () => {
    const s = clusterMapperReducer(init(), { type: "skip", clusterKey: "usa" });
    expect(s.decisions.usa).toEqual({ status: "skipped" });
    expect(s.cursor).toBe(1);
    expect(stagedCount(s)).toBe(0); // skipped is not staged
  });

  it("advance skips over already-decided clusters", () => {
    let s = init();
    s = clusterMapperReducer(s, { type: "map", clusterKey: "germany", recordKey: "de", recordLabel: "Germany" });
    // cursor started at 0 (usa), germany was decided out of order → advance from 0 stays at 0 (usa undecided)
    expect(s.cursor).toBe(0);
    s = clusterMapperReducer(s, { type: "map", clusterKey: "usa", recordKey: "us", recordLabel: "United States" });
    // usa + germany decided → next undecided is "uk" (index 2)
    expect(s.cursor).toBe(2);
  });

  it("undo reverts the last decision and moves the cursor back to it", () => {
    let s = clusterMapperReducer(init(), { type: "map", clusterKey: "usa", recordKey: "us", recordLabel: "United States" });
    s = clusterMapperReducer(s, { type: "undo" });
    expect(s.decisions.usa).toBeUndefined();
    expect(s.cursor).toBe(0);
    expect(s.undo).toEqual([]);
    expect(stagedCount(s)).toBe(0);
  });

  it("undo with an empty stack is a no-op", () => {
    const s = init();
    expect(clusterMapperReducer(s, { type: "undo" })).toEqual(s);
  });

  it("jumpTo sets the cursor", () => {
    const s = clusterMapperReducer(init(), { type: "jumpTo", index: 2 });
    expect(s.cursor).toBe(2);
  });

  it("when all clusters are decided, cursor lands at order.length", () => {
    let s = init();
    for (const k of KEYS) s = clusterMapperReducer(s, { type: "skip", clusterKey: k });
    expect(s.cursor).toBe(KEYS.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/lib/cluster-mapper-reducer.test.ts`
Expected: FAIL — cannot resolve `./cluster-mapper-reducer`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/cluster-mapper-reducer.ts`:

```ts
export type Decision =
  | { status: "mapped"; recordKey: string; recordLabel: string }
  | { status: "skipped" };

export interface MapperState {
  /** Cluster keys in worst-impact-first order. */
  order: string[];
  /** Index into `order` of the cluster currently in the focused card. */
  cursor: number;
  /** Decision per cluster key. Absent = undecided. */
  decisions: Record<string, Decision>;
  /** Stack of cluster keys decided, most recent last — drives undo. */
  undo: string[];
}

export type MapperAction =
  | { type: "init"; clusterKeys: string[] }
  | { type: "map"; clusterKey: string; recordKey: string; recordLabel: string }
  | { type: "skip"; clusterKey: string }
  | { type: "undo" }
  | { type: "jumpTo"; index: number };

export function initMapperState(clusterKeys: string[]): MapperState {
  return { order: clusterKeys, cursor: 0, decisions: {}, undo: [] };
}

/** First index at or after `from` whose cluster is undecided; `order.length` if none. */
function nextUndecided(state: MapperState, from: number): number {
  let i = Math.max(0, from);
  while (i < state.order.length && state.decisions[state.order[i]]) i++;
  return i;
}

export function clusterMapperReducer(state: MapperState, action: MapperAction): MapperState {
  switch (action.type) {
    case "init":
      return initMapperState(action.clusterKeys);

    case "map": {
      const decisions = {
        ...state.decisions,
        [action.clusterKey]: {
          status: "mapped" as const,
          recordKey: action.recordKey,
          recordLabel: action.recordLabel,
        },
      };
      const next = { ...state, decisions, undo: [...state.undo, action.clusterKey] };
      return { ...next, cursor: nextUndecided(next, 0) };
    }

    case "skip": {
      const decisions = { ...state.decisions, [action.clusterKey]: { status: "skipped" as const } };
      const next = { ...state, decisions, undo: [...state.undo, action.clusterKey] };
      return { ...next, cursor: nextUndecided(next, 0) };
    }

    case "undo": {
      if (state.undo.length === 0) return state;
      const undo = state.undo.slice(0, -1);
      const last = state.undo[state.undo.length - 1];
      const decisions = { ...state.decisions };
      delete decisions[last];
      const cursor = state.order.indexOf(last);
      return { ...state, decisions, undo, cursor: cursor < 0 ? state.cursor : cursor };
    }

    case "jumpTo":
      return { ...state, cursor: action.index };

    default:
      return state;
  }
}

/** Number of clusters mapped (skipped clusters are not staged for publish). */
export function stagedCount(state: MapperState): number {
  return Object.values(state.decisions).filter((d) => d.status === "mapped").length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/lib/cluster-mapper-reducer.test.ts`
Expected: PASS — all reducer tests pass.

- [ ] **Step 5: Run the gates**

Run (from `app/`): `npx tsc --noEmit`
Expected: no NEW errors referencing `use-dim-clusters.ts`, `cluster-candidates.ts`, or `cluster-mapper-reducer.ts`. (Pre-existing errors in unrelated files may exist — ignore them.)

Run (from `app/`): `npx eslint src/lib/use-dim-clusters.ts src/lib/use-dim-clusters.test.ts src/lib/cluster-candidates.ts src/lib/cluster-candidates.test.ts src/lib/cluster-mapper-reducer.ts src/lib/cluster-mapper-reducer.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/cluster-mapper-reducer.ts app/src/lib/cluster-mapper-reducer.test.ts
git commit -m "feat(mapper): add pure cluster-mapper reducer (map/skip/undo/advance)"
```

---

## Self-Review

**Spec coverage:**
- Loads `/clusters` feed (worst-first clusters + coverage + truncated) → Task 1 `useDimClusters`, asserted incl. endpoint path, error path, and null-dim no-fetch.
- Local type-ahead with closest-match-first pre-highlight + create row → Task 2 `buildCandidates`, with the conservative `foldLabel` (mirrors server `normalizeKey`), asserted for no-query/closest, no-match, and query cases.
- Map/skip/undo/advance state machine (the keyboard brain, minus JSX) → Task 3 reducer, asserted incl. out-of-order decide, advance-past-decided, undo restore, empty-undo no-op, all-decided cursor.
- Purity: Tasks 2–3 import nothing; Task 1 mirrors the existing hook and mocks `apiFetch` in tests.

**Placeholder scan:** No TBD/TODO. Every step has literal code and the exact `npx vitest run <file>` command.

**Type consistency:** `Cluster`/`Coverage`/`DimClusterFeed` (Task 1) match the Plan-2 server `DimClusterFeed` shape. `Candidate`/`CandidateRecord` (Task 2) and `MapperState`/`Decision`/`MapperAction` (Task 3) are self-contained and match the Interfaces Produced block. Plan 4 will import all three modules.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-cluster-mapper-state-layer.md`.

**Execution prerequisite:** app deps installed (`bun install` from `app/` if needed). No DB/server required — tests mock `apiFetch` or are pure.

Two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
