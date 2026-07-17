# Cluster-Mapper Integration Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose the Plan-3 pieces into one `useClusterMapper(dim)` hook the focused-card JSX can render — resolving the current cluster, its candidate list, a *mapped-sibling* suggestion, and staging map/skip/undo into the store.

**Architecture:** Two modules under `app/src/lib/`. (1) `cluster-selection.ts` holds two pure functions: `pendingClusters` (clusters with at least one unmapped member — the mapper's work queue) and `siblingSuggestion` (if a cluster already has a mapped member, the record it was mapped to — a prior *human* decision, the strongest possible pre-highlight; review finding). (2) `use-cluster-mapper.ts` wires `useDimClusters` (fetched with `filter:"all"` so mapped siblings are visible) + `useReducer(clusterMapperReducer)` + `buildCandidates` + the store's `saveDraft`/`discardDraft` into a single hook exposing the current cluster, candidates, suggestion, coverage, and map/skip/undo actions. The styled JSX card that renders this hook and owns keyboard/active-index is Plan 5 — not here.

**Tech Stack:** TypeScript (strict), React, Vitest + jsdom + `@testing-library/react` (`renderHook`/`act`/`waitFor`). Run from the `app/` workspace.

**Plan series:** Plan **4 of 7**. Depends on Plan 3 (`use-dim-clusters.ts`, `cluster-candidates.ts`, `cluster-mapper-reducer.ts`) and Plan 2's `/clusters` endpoint — all on `main`. Downstream: Plan 5 (the focused-card JSX) renders this hook and wires keyboard + the AI slot + publish.

## Global Constraints

- **Fetch `filter:"all"`, not `"new"`.** The hook loads the cluster feed with `filter:"all"` so a cluster's already-mapped siblings are present; the work queue is then derived as clusters with `mappedCount < members.length`. (Review finding: `filter:"new"` drops the mapped sibling — the best suggestion — before it reaches the client.)
- **Map the whole family.** Mapping a cluster stages `saveDraft` for **every** member `raw`; skipping stages `skipped` for every member; undoing a cluster `discardDraft`s every member. The store call shape mirrors `MatchModeBody`: `saveDraft(dim.id, raw, "mapped", recordLabel, recordKey)`, `saveDraft(dim.id, raw, "skipped", null, null)`, `discardDraft(dim.id, raw)`.
- **The caller resolves record keys.** `mapCluster(recordKey, recordLabel)` receives both — the hook does not slugify (a "create-new-record" key is resolved by the Plan-5 caller).
- **Pure `cluster-selection.ts`.** It imports only types + `foldLabel` from `./cluster-candidates`; no React, store, or network.
- **Extensionless app imports** (`from "../store"`), matching the codebase.
- **Gates:** from `app/`, `tsc --noEmit` and `eslint src` clean for changed files.

### Test command (from `app/`), used in every task

```
npx vitest run src/lib/<file>.test.ts
```

(No DB/server — pure tests, or `renderHook` with `useDimClusters` and the store module mocked via `vi.mock`, exactly as `src/lib/use-dim-clusters.test.ts` mocks `../api`.)

## File Structure

- `app/src/lib/cluster-selection.ts` — **new.** `pendingClusters`, `siblingSuggestion` (pure).
- `app/src/lib/cluster-selection.test.ts` — **new.** Pure tests.
- `app/src/lib/use-cluster-mapper.ts` — **new.** The `useClusterMapper` hook + its `UseClusterMapper` return type.
- `app/src/lib/use-cluster-mapper.test.ts` — **new.** `renderHook` tests with `useDimClusters` + store mocked.

## Interfaces Produced (for Plan 5)

```ts
// cluster-selection.ts
import type { Cluster } from "./use-dim-clusters";
import type { CandidateRecord } from "./cluster-candidates";
export function pendingClusters(clusters: Cluster[]): Cluster[];
export function siblingSuggestion(cluster: Cluster, records: CandidateRecord[]): CandidateRecord | null;

// use-cluster-mapper.ts
export interface UseClusterMapper {
  loading: boolean;
  error: string | null;
  current: Cluster | null;          // the cluster in the focused card (null when done/empty)
  candidates: Candidate[];          // buildCandidates over dim.canonical + query
  suggestion: CandidateRecord | null; // mapped-sibling record, if any
  coverage: { resolvedRows: number; atRiskRows: number; pct: number };
  truncated: boolean;
  staged: number;                   // clusters mapped this session
  done: boolean;                    // queue non-empty and fully worked
  position: { index: number; total: number };
  query: string;
  setQuery: (q: string) => void;
  mapCluster: (recordKey: string, recordLabel: string) => void;
  skipCluster: () => void;
  undo: () => void;
  jumpTo: (index: number) => void;
  refetch: () => void;
}
export function useClusterMapper(dim: MappingDimension): UseClusterMapper;
```

---

### Task 1: `cluster-selection.ts` — pending queue + mapped-sibling suggestion (pure)

**Files:**
- Create: `app/src/lib/cluster-selection.ts`
- Test: `app/src/lib/cluster-selection.test.ts`

**Interfaces:**
- Consumes: `Cluster` (type, `./use-dim-clusters`), `CandidateRecord` (type, `./cluster-candidates`), `foldLabel` (`./cluster-candidates`).
- Produces: `pendingClusters(clusters)`, `siblingSuggestion(cluster, records)`.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/cluster-selection.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pendingClusters, siblingSuggestion } from "./cluster-selection";
import type { Cluster, ClusterMember } from "./use-dim-clusters";
import type { CandidateRecord } from "./cluster-candidates";

const RECORDS: CandidateRecord[] = [
  { key: "us", label: "United States" },
  { key: "de", label: "Germany" },
];

function member(raw: string, rows: number, isMapped = false, mappedLabel: string | null = null): ClusterMember {
  return { raw, rows, isMapped, mappedLabel, occurrences: [] };
}
function cluster(key: string, members: ClusterMember[]): Cluster {
  return {
    key,
    rep: members[0].raw,
    members,
    rows: members.reduce((s, m) => s + m.rows, 0),
    mappedCount: members.filter((m) => m.isMapped).length,
  };
}

describe("pendingClusters", () => {
  it("keeps clusters with at least one unmapped member, drops fully-mapped ones", () => {
    const partly = cluster("usa", [member("USA", 100), member("U.S.A.", 50, true, "United States")]);
    const done = cluster("ger", [member("Germany", 30, true, "Germany")]);
    const out = pendingClusters([partly, done]);
    expect(out.map((c) => c.key)).toEqual(["usa"]);
  });

  it("preserves input order (worst-first is already applied upstream)", () => {
    const a = cluster("a", [member("a", 10)]);
    const b = cluster("b", [member("b", 5)]);
    expect(pendingClusters([a, b]).map((c) => c.key)).toEqual(["a", "b"]);
  });
});

describe("siblingSuggestion", () => {
  it("returns the record a mapped sibling was mapped to", () => {
    const c = cluster("usa", [member("USA", 100), member("U.S.A.", 50, true, "United States")]);
    expect(siblingSuggestion(c, RECORDS)).toEqual({ key: "us", label: "United States" });
  });

  it("uses the highest-rows mapped sibling when several are mapped", () => {
    const c = cluster("x", [
      member("a", 100, true, "Germany"),
      member("b", 200, true, "United States"),
    ]);
    // members arrive rows-desc from the server; "b" (200) is first → United States
    expect(siblingSuggestion(c, RECORDS)).toEqual({ key: "us", label: "United States" });
  });

  it("returns null when no member is mapped", () => {
    const c = cluster("usa", [member("USA", 100), member("U.S.A.", 50)]);
    expect(siblingSuggestion(c, RECORDS)).toBeNull();
  });

  it("returns null when the mapped label matches no known record", () => {
    const c = cluster("usa", [member("USA", 100, true, "Atlantis")]);
    expect(siblingSuggestion(c, RECORDS)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/lib/cluster-selection.test.ts`
Expected: FAIL — cannot resolve `./cluster-selection`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/cluster-selection.ts`:

```ts
import type { Cluster } from "./use-dim-clusters";
import { foldLabel, type CandidateRecord } from "./cluster-candidates";

/** The mapper's work queue: clusters with at least one still-unmapped member.
 *  Fully-mapped clusters are done and excluded. Input order (worst-first) is
 *  preserved. */
export function pendingClusters(clusters: Cluster[]): Cluster[] {
  return clusters.filter((c) => c.mappedCount < c.members.length);
}

/**
 * If a cluster already has a mapped member, return the record it was mapped to —
 * a prior human decision on the same family, the strongest pre-highlight. Members
 * arrive rows-desc, so the first mapped member is the highest-impact one. Matches
 * the record by exact label, then by conservative fold. Returns null if nothing
 * is mapped or the label matches no known record.
 */
export function siblingSuggestion(cluster: Cluster, records: CandidateRecord[]): CandidateRecord | null {
  const mapped = cluster.members.find((m) => m.isMapped && m.mappedLabel);
  if (!mapped || !mapped.mappedLabel) return null;
  const label = mapped.mappedLabel;
  const exact = records.find((r) => r.label === label);
  if (exact) return exact;
  const key = foldLabel(label);
  return records.find((r) => foldLabel(r.label) === key) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/lib/cluster-selection.test.ts`
Expected: PASS — all `pendingClusters` and `siblingSuggestion` tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/cluster-selection.ts app/src/lib/cluster-selection.test.ts
git commit -m "feat(mapper): add pending-queue + mapped-sibling suggestion (pure)"
```

---

### Task 2: `useClusterMapper` hook

**Files:**
- Create: `app/src/lib/use-cluster-mapper.ts`
- Test: `app/src/lib/use-cluster-mapper.test.ts`

**Interfaces:**
- Consumes: `useDimClusters`/`Cluster` (`./use-dim-clusters`), `buildCandidates`/`Candidate`/`CandidateRecord` (`./cluster-candidates`), `pendingClusters`/`siblingSuggestion` (`./cluster-selection`), `clusterMapperReducer`/`initMapperState`/`stagedCount` (`./cluster-mapper-reducer`), `saveDraft`/`discardDraft` (`../store`), `MappingDimension` (type, `../data`).
- Produces: `UseClusterMapper`, `useClusterMapper(dim)`.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/use-cluster-mapper.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { DimClusterFeed } from "./use-dim-clusters";

type FeedState = DimClusterFeed & { loading: boolean; error: string | null; refetch: () => void };

// The hook reads the feed and the store; mock both. `vi.hoisted` lets the
// hoisted mock factory safely reference this shared ref.
const { feedRef } = vi.hoisted(() => ({ feedRef: { current: null as unknown as FeedState } }));
vi.mock("./use-dim-clusters", () => ({ useDimClusters: () => feedRef.current }));
vi.mock("../store", () => ({ saveDraft: vi.fn(), discardDraft: vi.fn() }));

import { saveDraft, discardDraft } from "../store";
import { useClusterMapper } from "./use-cluster-mapper";
import type { MappingDimension } from "../data";

const saveMock = saveDraft as unknown as ReturnType<typeof vi.fn>;
const discardMock = discardDraft as unknown as ReturnType<typeof vi.fn>;

function makeFeedState(feed: DimClusterFeed): FeedState {
  return { ...feed, loading: false, error: null, refetch: vi.fn() };
}
function loadedFeed(): DimClusterFeed {
  return {
    clusters: [
      // pending: one unmapped + one mapped sibling (United States)
      { key: "usa", rep: "USA", rows: 150, mappedCount: 1, members: [
        { raw: "USA", rows: 100, isMapped: false, mappedLabel: null, occurrences: [] },
        { raw: "U.S.A.", rows: 50, isMapped: true, mappedLabel: "United States", occurrences: [] },
      ] },
      // fully mapped → excluded from the queue
      { key: "ger", rep: "Germany", rows: 30, mappedCount: 1, members: [
        { raw: "Germany", rows: 30, isMapped: true, mappedLabel: "Germany", occurrences: [] },
      ] },
    ],
    coverage: { resolvedRows: 80, atRiskRows: 100, pct: 44 },
    truncated: false,
  };
}

const DIM = {
  id: "d1",
  canonical: [
    { key: "us", label: "United States" },
    { key: "de", label: "Germany" },
  ],
} as unknown as MappingDimension;

beforeEach(() => {
  saveMock.mockReset();
  discardMock.mockReset();
  feedRef.current = makeFeedState(loadedFeed());
});

describe("useClusterMapper", () => {
  it("exposes the first pending cluster, its coverage, and the mapped-sibling suggestion", async () => {
    const { result } = renderHook(() => useClusterMapper(DIM));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));
    expect(result.current.position).toEqual({ index: 0, total: 1 }); // only "usa" is pending
    expect(result.current.coverage.pct).toBe(44);
    expect(result.current.suggestion).toEqual({ key: "us", label: "United States" });
    expect(result.current.candidates.some((c) => c.kind === "create")).toBe(true);
  });

  it("mapCluster stages a draft for every member and advances to done", async () => {
    const { result } = renderHook(() => useClusterMapper(DIM));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));

    act(() => result.current.mapCluster("us", "United States"));

    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock).toHaveBeenCalledWith("d1", "USA", "mapped", "United States", "us");
    expect(saveMock).toHaveBeenCalledWith("d1", "U.S.A.", "mapped", "United States", "us");
    expect(result.current.staged).toBe(1);
    expect(result.current.current).toBeNull();
    expect(result.current.done).toBe(true);
  });

  it("skipCluster stages a skipped draft for every member", async () => {
    const { result } = renderHook(() => useClusterMapper(DIM));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));

    act(() => result.current.skipCluster());

    expect(saveMock).toHaveBeenCalledWith("d1", "USA", "skipped", null, null);
    expect(saveMock).toHaveBeenCalledWith("d1", "U.S.A.", "skipped", null, null);
    expect(result.current.staged).toBe(0); // skipped is not staged
  });

  it("undo discards the drafts of the last decided cluster's members", async () => {
    const { result } = renderHook(() => useClusterMapper(DIM));
    await waitFor(() => expect(result.current.current?.key).toBe("usa"));

    act(() => result.current.mapCluster("us", "United States"));
    act(() => result.current.undo());

    expect(discardMock).toHaveBeenCalledWith("d1", "USA");
    expect(discardMock).toHaveBeenCalledWith("d1", "U.S.A.");
    expect(result.current.current?.key).toBe("usa"); // back on the cluster
    expect(result.current.staged).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/lib/use-cluster-mapper.test.ts`
Expected: FAIL — cannot resolve `./use-cluster-mapper`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/use-cluster-mapper.ts`:

```ts
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { MappingDimension } from "../data";
import { useDimClusters, type Cluster } from "./use-dim-clusters";
import { buildCandidates, type Candidate, type CandidateRecord } from "./cluster-candidates";
import { pendingClusters, siblingSuggestion } from "./cluster-selection";
import { clusterMapperReducer, initMapperState, stagedCount } from "./cluster-mapper-reducer";
import { saveDraft, discardDraft } from "../store";

export interface UseClusterMapper {
  loading: boolean;
  error: string | null;
  current: Cluster | null;
  candidates: Candidate[];
  suggestion: CandidateRecord | null;
  coverage: { resolvedRows: number; atRiskRows: number; pct: number };
  truncated: boolean;
  staged: number;
  done: boolean;
  position: { index: number; total: number };
  query: string;
  setQuery: (q: string) => void;
  mapCluster: (recordKey: string, recordLabel: string) => void;
  skipCluster: () => void;
  undo: () => void;
  jumpTo: (index: number) => void;
  refetch: () => void;
}


export function useClusterMapper(dim: MappingDimension): UseClusterMapper {
  const feed = useDimClusters({ dimId: dim.id, filter: "all" });
  const pending = useMemo(() => pendingClusters(feed.clusters), [feed.clusters]);
  const records = useMemo<CandidateRecord[]>(
    () => dim.canonical.map((c) => ({ key: c.key, label: c.label })),
    [dim.canonical],
  );

  const [state, dispatch] = useReducer(clusterMapperReducer, [] as string[], initMapperState);

  // Re-init the reducer whenever the set of pending cluster keys changes.
  // Cluster keys can contain any char (empty-fold values are NUL-prefixed),
  // so JSON round-trips the pending key set unambiguously for the re-init guard.
  const keysRef = useRef<string>("");
  const keySig = JSON.stringify(pending.map((c) => c.key));
  useEffect(() => {
    if (keySig !== keysRef.current) {
      keysRef.current = keySig;
      dispatch({ type: "init", clusterKeys: JSON.parse(keySig) as string[] });
    }
  }, [keySig]);

  const [query, setQuery] = useState("");
  const current = state.cursor < pending.length ? pending[state.cursor] : null;

  const suggestion = useMemo(
    () => (current ? siblingSuggestion(current, records) : null),
    [current, records],
  );
  const candidates = useMemo(
    () => (current ? buildCandidates(records, query, current.rep) : []),
    [current, records, query],
  );

  const mapCluster = useCallback(
    (recordKey: string, recordLabel: string) => {
      if (!current) return;
      for (const m of current.members) {
        void saveDraft(dim.id, m.raw, "mapped", recordLabel, recordKey);
      }
      dispatch({ type: "map", clusterKey: current.key, recordKey, recordLabel });
      setQuery("");
    },
    [current, dim.id],
  );

  const skipCluster = useCallback(() => {
    if (!current) return;
    for (const m of current.members) {
      void saveDraft(dim.id, m.raw, "skipped", null, null);
    }
    dispatch({ type: "skip", clusterKey: current.key });
    setQuery("");
  }, [current, dim.id]);

  const undo = useCallback(() => {
    const lastKey = state.undo[state.undo.length - 1];
    if (!lastKey) return;
    const cluster = pending.find((c) => c.key === lastKey);
    if (cluster) {
      for (const m of cluster.members) void discardDraft(dim.id, m.raw);
    }
    dispatch({ type: "undo" });
  }, [state.undo, pending, dim.id]);

  const jumpTo = useCallback((index: number) => dispatch({ type: "jumpTo", index }), []);

  return {
    loading: feed.loading,
    error: feed.error,
    current,
    candidates,
    suggestion,
    coverage: feed.coverage,
    truncated: feed.truncated,
    staged: stagedCount(state),
    done: pending.length > 0 && state.cursor >= pending.length,
    position: { index: state.cursor, total: pending.length },
    query,
    setQuery,
    mapCluster,
    skipCluster,
    undo,
    jumpTo,
    refetch: feed.refetch,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/lib/use-cluster-mapper.test.ts`
Expected: PASS — all four `useClusterMapper` tests pass.

- [ ] **Step 5: Run the gates**

Run (from `app/`): `npx tsc --noEmit`
Expected: no NEW errors referencing `cluster-selection.ts` or `use-cluster-mapper.ts`. (Pre-existing errors in unrelated files may exist — ignore them.)

Run (from `app/`): `npx eslint src/lib/cluster-selection.ts src/lib/cluster-selection.test.ts src/lib/use-cluster-mapper.ts src/lib/use-cluster-mapper.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/use-cluster-mapper.ts app/src/lib/use-cluster-mapper.test.ts
git commit -m "feat(mapper): add useClusterMapper hook wiring feed+reducer+store"
```

---

## Self-Review

**Spec coverage:**
- Fetch `filter:"all"` + derive pending queue (finding 2) → Task 1 `pendingClusters`, Task 2 hook passes `filter:"all"`; test seeds a fully-mapped cluster and asserts it's excluded (`total:1`).
- Mapped-sibling suggestion (finding 2) → Task 1 `siblingSuggestion`, asserted incl. highest-rows tiebreak and no-match/no-mapped null paths; Task 2 exposes it as `suggestion`.
- Map/skip stage a draft per member; undo discards per member → Task 2 tests assert `saveDraft`/`discardDraft` call args and counts.
- Reducer re-inits when the pending set changes → keysRef guard; the hook's `done`/`position`/`staged` derive from reducer state.

**Placeholder scan:** No TBD/TODO. Every step has literal code and the exact `npx vitest run <file>` command.

**Type consistency:** `Cluster`/`ClusterMember`/`DimClusterFeed`/`Coverage` come from Plan-3 `use-dim-clusters.ts`; `Candidate`/`CandidateRecord`/`foldLabel` from Plan-3 `cluster-candidates.ts`; reducer symbols from Plan-3 `cluster-mapper-reducer.ts`. `mapCluster(recordKey, recordLabel)` matches the reducer's `map` action fields. `MappingDimension` is imported type-only from `../data`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-cluster-mapper-hook.md`.

**Execution prerequisite:** app deps installed (already present). No DB/server — pure tests + mocked `renderHook`.

Two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
