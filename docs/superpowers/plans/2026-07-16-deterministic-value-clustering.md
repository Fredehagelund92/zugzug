# Deterministic Value Clustering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure, conservative, deterministic module that groups scanned source values into look-alike clusters, so one mapping decision can cover a whole family of spellings.

**Architecture:** A single pure server module (`server/src/cluster-values.ts`) exporting `normalizeKey`, `clusterValues`, and `clusterScanRows`. It folds each raw value to a normalized key (case-fold, strip diacritics, drop non-alphanumerics) and groups values that fold to the *same* key. It deliberately **under-clusters** — anything less than an exact fold-match stays its own cluster; fuzzy/alias grouping is an explicit opt-in layer built in a later plan, never here. No I/O, no DB, no React — just data in, clusters out, which makes it exhaustively unit-testable.

**Tech Stack:** TypeScript (strict), Bun test runner (`bun:test`), run from the `server/` workspace.

**Plan series:** This is **Plan 1 of 7** in the Map-values / Review redesign. It produces a tested library that later plans import. Downstream plans: (2) coverage/row-impact ordering + `scan-values` endpoint wiring, (3) the cluster-mapper UI, (4) Publish preview, (5) global Review + table board, (6) Sources monitor, (7) IA/naming. **This plan ships and tests on its own** — nothing else depends on it being wired to the UI yet.

## Global Constraints

- **Conservative clustering only.** Group values *only* when they fold to the identical `normalizeKey`. No fuzzy matching, no edit-distance, no alias maps in this module — under-clustering is the intended bias.
- **Pure module.** `cluster-values.ts` may `import type` from other files but must not perform I/O, touch the DB, read env, or import React. It must be safe to unit-test with no database.
- **Deterministic output.** Same input → identical output every run: clusters sorted `rows` desc then `rep` ascending; members sorted `rows` desc then `raw` ascending.
- **Import extensions.** Server code imports with explicit `.ts` extensions (e.g. `import { X } from "./repo-dim-scan.ts"`), matching the existing codebase.
- **Gates must pass.** `tsc --noEmit` and `eslint src` must pass clean from the `server/` directory before the final commit.
- **Run tests from `server/`.** All test commands are run with the working directory at `server/`. This pure test file needs no database env.

## File Structure

- `server/src/cluster-values.ts` — **new.** The entire clustering library: `normalizeKey`, `clusterValues`, `clusterScanRows`, their exported types, and two private comparators. One responsibility: turn raw values into deterministic clusters.
- `server/src/cluster-values.test.ts` — **new.** All unit tests for the module, one `describe` block per exported function.
- `server/src/repo-dim-scan.ts` — **read-only reference.** Source of the `ScanValueRow` interface (lines 171–177) that `clusterScanRows` consumes. Not modified by this plan.

## Interfaces Produced (for later plans)

Later plans import these exact names/types from `server/src/cluster-values.ts`:

```ts
export function normalizeKey(raw: string): string;

export interface ClusterInput { raw: string; rows: number }
export interface ValueCluster { key: string; rep: string; members: ClusterInput[]; rows: number }
export function clusterValues(values: ClusterInput[]): ValueCluster[];

export interface ScanValueMember {
  raw: string;
  rows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}
export interface ScanValueCluster {
  key: string;
  rep: string;
  members: ScanValueMember[];
  rows: number;
  mappedCount: number;
}
export function clusterScanRows(rows: ScanValueRow[]): ScanValueCluster[];
```

`ScanValueRow` is imported (type-only) from `./repo-dim-scan.ts`:

```ts
export interface ScanValueRow {
  raw: string;
  totalRows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}
```

---

### Task 1: `normalizeKey` — the conservative fold key

**Files:**
- Create: `server/src/cluster-values.ts`
- Test: `server/src/cluster-values.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeKey(raw: string): string`.

- [ ] **Step 1: Write the failing test**

Create `server/src/cluster-values.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { normalizeKey } from "./cluster-values.ts";

describe("normalizeKey", () => {
  it("folds case, punctuation, and spacing to one key", () => {
    expect(normalizeKey("USA")).toBe("usa");
    expect(normalizeKey("U.S.A.")).toBe("usa");
    expect(normalizeKey("u s a")).toBe("usa");
  });

  it("strips diacritics", () => {
    expect(normalizeKey("Déjà")).toBe("deja");
    expect(normalizeKey("Grande-Bretagne")).toBe("grandebretagne");
  });

  it("keeps genuinely different values apart (US is not USA)", () => {
    expect(normalizeKey("US")).toBe("us");
    expect(normalizeKey("US")).not.toBe(normalizeKey("USA"));
  });

  it("gives punctuation-only values a unique, non-merging key", () => {
    expect(normalizeKey("!!!")).not.toBe(normalizeKey("???"));
    expect(normalizeKey("!!!")).toContain("!!!");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `bun test src/cluster-values.test.ts`
Expected: FAIL — cannot resolve `./cluster-values.ts` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `server/src/cluster-values.ts`:

```ts
/* cluster-values.ts — deterministic, conservative clustering of scanned source
   values. Values that fold to the SAME normalized key are one cluster; anything
   less certain stays its own cluster (bias to under-cluster). No fuzzy matching
   or aliasing here — that is an opt-in layer built above this module. Pure: no
   I/O, no DB, no env, no React. */

/**
 * Fold a raw value to its conservative cluster key: NFKD-normalize, strip
 * diacritics, lowercase, then drop every non-alphanumeric character. "U.S.A."
 * and "usa" both fold to "usa"; "US" folds to "us" and is kept separate on
 * purpose. A value that folds to the empty string (punctuation-only) gets a
 * unique per-raw key prefixed with NUL so such values never merge together.
 */
export function normalizeKey(raw: string): string {
  const folded = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return folded === "" ? `\u0000${raw}` : folded;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `server/`): `bun test src/cluster-values.test.ts`
Expected: PASS — 4 tests in the `normalizeKey` describe block pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/cluster-values.ts server/src/cluster-values.test.ts
git commit -m "feat(cluster): add conservative normalizeKey fold"
```

---

### Task 2: `clusterValues` — group by fold key, deterministic order

**Files:**
- Modify: `server/src/cluster-values.ts`
- Test: `server/src/cluster-values.test.ts`

**Interfaces:**
- Consumes: `normalizeKey` (Task 1).
- Produces: `ClusterInput`, `ValueCluster`, `clusterValues(values: ClusterInput[]): ValueCluster[]`, and two private comparators reused by Task 3: `cmpByRowsThenRaw`, `cmpByRowsThenRep`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/cluster-values.test.ts` (add `clusterValues` to the existing import line first, so it reads `import { normalizeKey, clusterValues } from "./cluster-values.ts";`):

```ts
describe("clusterValues", () => {
  it("merges values that fold to the same key and keeps others apart", () => {
    const out = clusterValues([
      { raw: "USA", rows: 6200 },
      { raw: "U.S.A.", rows: 3100 },
      { raw: "u.s.a.", rows: 700 },
      { raw: "US", rows: 2000 },
    ]);
    expect(out).toHaveLength(2);

    const usa = out.find((c) => c.key === "usa");
    expect(usa).toBeDefined();
    expect(usa!.members.map((m) => m.raw)).toEqual(["USA", "U.S.A.", "u.s.a."]);
    expect(usa!.rows).toBe(10000);
    expect(usa!.rep).toBe("USA");

    const us = out.find((c) => c.key === "us");
    expect(us!.rows).toBe(2000);
  });

  it("breaks rep and member ties by raw ascending", () => {
    const out = clusterValues([
      { raw: "usa", rows: 5 },
      { raw: "USA", rows: 5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rep).toBe("USA");
    expect(out[0].members.map((m) => m.raw)).toEqual(["USA", "usa"]);
  });

  it("sorts clusters by rows descending (worst-impact first)", () => {
    const out = clusterValues([
      { raw: "small", rows: 10 },
      { raw: "big", rows: 9000 },
    ]);
    expect(out.map((c) => c.rep)).toEqual(["big", "small"]);
  });

  it("returns an empty array for empty input", () => {
    expect(clusterValues([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `bun test src/cluster-values.test.ts`
Expected: FAIL — `clusterValues` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Append to `server/src/cluster-values.ts` (below `normalizeKey`):

```ts
/** A raw value plus its downstream row weight. */
export interface ClusterInput {
  raw: string;
  rows: number;
}

/** A group of look-alike values sharing one normalized key. */
export interface ValueCluster {
  /** Deterministic fold key shared by all members. */
  key: string;
  /** Representative raw value: the member with the most rows (ties → raw asc). */
  rep: string;
  /** Members, sorted rows desc then raw asc. */
  members: ClusterInput[];
  /** Sum of member rows — the cluster's downstream impact. */
  rows: number;
}

// Shared deterministic comparators (also used by clusterScanRows).
function cmpByRowsThenRaw(a: { rows: number; raw: string }, b: { rows: number; raw: string }): number {
  return b.rows - a.rows || (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0);
}
function cmpByRowsThenRep(a: { rows: number; rep: string }, b: { rows: number; rep: string }): number {
  return b.rows - a.rows || (a.rep < b.rep ? -1 : a.rep > b.rep ? 1 : 0);
}

/**
 * Group inputs into deterministic clusters. Values folding to the same
 * `normalizeKey` merge; everything else stays separate. Output order is stable:
 * clusters by rows desc then rep asc, members by rows desc then raw asc.
 */
export function clusterValues(values: ClusterInput[]): ValueCluster[] {
  const byKey = new Map<string, ClusterInput[]>();
  for (const v of values) {
    const key = normalizeKey(v.raw);
    const arr = byKey.get(key);
    if (arr) arr.push(v);
    else byKey.set(key, [v]);
  }

  const clusters: ValueCluster[] = [];
  for (const [key, members] of byKey) {
    members.sort(cmpByRowsThenRaw);
    const rows = members.reduce((sum, m) => sum + m.rows, 0);
    clusters.push({ key, rep: members[0].raw, members, rows });
  }
  clusters.sort(cmpByRowsThenRep);
  return clusters;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `server/`): `bun test src/cluster-values.test.ts`
Expected: PASS — all `normalizeKey` and `clusterValues` tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/cluster-values.ts server/src/cluster-values.test.ts
git commit -m "feat(cluster): add deterministic clusterValues grouping"
```

---

### Task 3: `clusterScanRows` — cluster real scan rows, carrying occurrences

**Files:**
- Modify: `server/src/cluster-values.ts`
- Test: `server/src/cluster-values.test.ts`

**Interfaces:**
- Consumes: `normalizeKey`, `cmpByRowsThenRaw`, `cmpByRowsThenRep` (Tasks 1–2); `ScanValueRow` (type-only, from `./repo-dim-scan.ts`).
- Produces: `ScanValueMember`, `ScanValueCluster`, `clusterScanRows(rows: ScanValueRow[]): ScanValueCluster[]`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/cluster-values.test.ts` (add `clusterScanRows` to the import so it reads `import { normalizeKey, clusterValues, clusterScanRows } from "./cluster-values.ts";`, and add the `ScanValueRow` type import shown below):

```ts
import type { ScanValueRow } from "./repo-dim-scan.ts";

function scanRow(
  raw: string,
  totalRows: number,
  isMapped = false,
  mappedLabel: string | null = null,
): ScanValueRow {
  return {
    raw,
    totalRows,
    isMapped,
    mappedLabel,
    occurrences: [{ table: "orders", column: "ship_country", rows: totalRows }],
  };
}

describe("clusterScanRows", () => {
  it("clusters scan rows, summing rows and carrying occurrences + mapped state", () => {
    const out = clusterScanRows([
      scanRow("USA", 6200),
      scanRow("U.S.A.", 3100, true, "United States"),
      scanRow("US", 2000),
    ]);
    expect(out).toHaveLength(2);

    const usa = out.find((c) => c.key === "usa");
    expect(usa).toBeDefined();
    expect(usa!.rows).toBe(9300);
    expect(usa!.rep).toBe("USA");
    expect(usa!.mappedCount).toBe(1);
    expect(usa!.members[0].occurrences[0].column).toBe("ship_country");
  });

  it("orders clusters worst-impact first", () => {
    const out = clusterScanRows([scanRow("rare", 12), scanRow("common", 8800)]);
    expect(out.map((c) => c.rep)).toEqual(["common", "rare"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `bun test src/cluster-values.test.ts`
Expected: FAIL — `clusterScanRows` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Add the type-only import at the **top** of `server/src/cluster-values.ts` (immediately under the file header comment):

```ts
import type { ScanValueRow } from "./repo-dim-scan.ts";
```

Append to the bottom of `server/src/cluster-values.ts`:

```ts
/** A scan-row member of a cluster — richer than ClusterInput, keeps occurrences. */
export interface ScanValueMember {
  raw: string;
  rows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}

/** A cluster of scan rows, plus how many members are already mapped. */
export interface ScanValueCluster {
  key: string;
  rep: string;
  members: ScanValueMember[];
  rows: number;
  mappedCount: number;
}

/**
 * Cluster real `ScanValueRow`s the way `clusterValues` clusters plain inputs,
 * but preserve each member's occurrences and mapped state and report how many
 * members are already mapped. Weight is `totalRows`.
 */
export function clusterScanRows(rows: ScanValueRow[]): ScanValueCluster[] {
  const byKey = new Map<string, ScanValueMember[]>();
  for (const r of rows) {
    const key = normalizeKey(r.raw);
    const member: ScanValueMember = {
      raw: r.raw,
      rows: r.totalRows,
      isMapped: r.isMapped,
      mappedLabel: r.mappedLabel,
      occurrences: r.occurrences,
    };
    const arr = byKey.get(key);
    if (arr) arr.push(member);
    else byKey.set(key, [member]);
  }

  const clusters: ScanValueCluster[] = [];
  for (const [key, members] of byKey) {
    members.sort(cmpByRowsThenRaw);
    const rows2 = members.reduce((sum, m) => sum + m.rows, 0);
    const mappedCount = members.reduce((n, m) => n + (m.isMapped ? 1 : 0), 0);
    clusters.push({ key, rep: members[0].raw, members, rows: rows2, mappedCount });
  }
  clusters.sort(cmpByRowsThenRep);
  return clusters;
}
```

- [ ] **Step 4: Run the full test file to verify everything passes**

Run (from `server/`): `bun test src/cluster-values.test.ts`
Expected: PASS — all three describe blocks (`normalizeKey`, `clusterValues`, `clusterScanRows`) pass.

- [ ] **Step 5: Run the gates**

Run (from `server/`): `tsc --noEmit`
Expected: no output, exit 0.

Run (from `server/`): `eslint src/cluster-values.ts src/cluster-values.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/cluster-values.ts server/src/cluster-values.test.ts
git commit -m "feat(cluster): add clusterScanRows adapter over ScanValueRow"
```

---

## Self-Review

**Spec coverage** (against the grilled decision "clustering is conservative/deterministic; fuzzy only opt-in"):
- Deterministic fold-key grouping → Task 1 (`normalizeKey`) + Task 2 (`clusterValues`).
- Under-cluster bias (US ≠ USA; punctuation-only never merges) → Task 1 tests assert it explicitly.
- Worst-impact-first ordering (feeds Plan 2's coverage) → Task 2/3 cluster sort by rows desc.
- Real scan-row integration carrying occurrences + mapped state → Task 3 (`clusterScanRows`).
- No fuzzy/alias in this module → enforced by Global Constraints; the opt-in "add similar" layer is explicitly deferred to a later plan.

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every step has literal code and an exact `bun test src/cluster-values.test.ts` command with expected result.

**Type consistency:** `ClusterInput`, `ValueCluster`, `ScanValueMember`, `ScanValueCluster`, and `ScanValueRow` are used identically across tasks; `cmpByRowsThenRaw`/`cmpByRowsThenRep` are defined in Task 2 and reused (not redefined) in Task 3; `normalizeKey` signature is stable across all three tasks.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-deterministic-value-clustering.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
