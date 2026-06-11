# Records Columns Memo Narrowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every open Records pane from rebuilding its column definitions on every store mutation anywhere in the app.

**Architecture:** `RecordsBody`'s `columns` memo (`app/src/components/TablePane.tsx:303-404`) depends on `allDims` — the entire dimensions array — solely because linked-field columns need the *referenced* dims' canonical lists as picker candidates. The store replaces the `dims` array identity on every `emit()`, so the memo re-fires for unrelated mutations (a draft saved in Review, an audit append, anything). Fix: a `useLinkedCandidates(fields, allDims)` hook that returns a `Map<dimId, Candidate[]>` with **stable identity** unless one of the actually-referenced dim *objects* changed identity. This works because the store's `refreshDim`/`patchCanonical` replace only the mutated dim object inside `dims.map(...)` — untouched dims keep their object identity across emits.

**Tech Stack:** React 18 + TypeScript. Tests: vitest + Testing Library (`renderHook`) in `app/test/`.

**Background you need:**
- `app/src/components/TablePane.tsx:191`: `const allDims = useDimensions();`
- `app/src/components/TablePane.tsx:303-404`: the `columns` memo. Line 349 is the only `allDims` consumer: `const targetDim = allDims.find((d) => d.id === f.referencedDimId);` then `targetDim?.canonical.map(...)` (candidates) and `targetDim?.fields?.find(...)` (lookup column labels).
- Deps line (`:404`): `[fields, engineer, dim.keyCol, external, layout, allDims]`.
- `FieldDef` and `MappingDimension` types: `app/src/data.ts`.
- Project rules: no comments unless the WHY is non-obvious; `cd app && bun run typecheck`; `cd app && bun run test`.

---

## File structure

- Create: `app/src/lib/use-linked-candidates.ts` — the hook (one responsibility: identity-stable candidate resolution)
- Modify: `app/src/components/TablePane.tsx:303-404` — consume the hook, drop `allDims` from the memo deps
- Test: `app/test/use-linked-candidates.test.tsx`

---

### Task 1: The `useLinkedCandidates` hook

**Files:**
- Create: `app/src/lib/use-linked-candidates.ts`
- Test: `app/test/use-linked-candidates.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/test/use-linked-candidates.test.tsx`:

```tsx
import { describe, test, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLinkedCandidates } from "../src/lib/use-linked-candidates";
import type { FieldDef, MappingDimension } from "../src/data";

const mkDim = (id: string, canonical: Array<{ key: string; label: string }>): MappingDimension => ({
  id,
  dimension: id.toUpperCase(),
  dimTable: `zugzug.dim_${id}`,
  mapTable: `zugzug.map_${id}`,
  keyCol: `${id}_code`,
  rows: 0,
  canonical: canonical.map((c) => ({ ...c, version: 1 })),
  values: [],
  fields: [],
});

const linkedField: FieldDef = {
  field: "country_fk",
  label: "Country",
  type: "linked",
  referencedDimId: "country",
};

describe("useLinkedCandidates", () => {
  test("resolves candidates for referenced dims", () => {
    const country = mkDim("country", [{ key: "US", label: "United States" }]);
    const { result } = renderHook(() => useLinkedCandidates([linkedField], [country]));
    expect(result.current.get("country")?.candidates).toEqual([
      { key: "US", label: "United States" },
    ]);
  });

  test("identity is STABLE when allDims array is new but referenced dims are unchanged", () => {
    const country = mkDim("country", [{ key: "US", label: "United States" }]);
    const channel = mkDim("channel", [{ key: "seo", label: "SEO" }]);
    const { result, rerender } = renderHook(
      ({ dims }) => useLinkedCandidates([linkedField], dims),
      { initialProps: { dims: [country, channel] } },
    );
    const first = result.current;
    rerender({ dims: [country, { ...channel }] }); // new array + unrelated dim replaced
    expect(result.current).toBe(first);
  });

  test("identity CHANGES when a referenced dim object is replaced", () => {
    const country = mkDim("country", [{ key: "US", label: "United States" }]);
    const { result, rerender } = renderHook(
      ({ dims }) => useLinkedCandidates([linkedField], dims),
      { initialProps: { dims: [country] } },
    );
    const first = result.current;
    rerender({ dims: [mkDim("country", [{ key: "US", label: "USA" }])] });
    expect(result.current).not.toBe(first);
    expect(result.current.get("country")!.candidates[0]!.label).toBe("USA");
  });

  test("no linked fields → stable empty map", () => {
    const dim = mkDim("country", []);
    const { result, rerender } = renderHook(({ dims }) => useLinkedCandidates([], dims), {
      initialProps: { dims: [dim] },
    });
    const first = result.current;
    rerender({ dims: [{ ...dim }] });
    expect(result.current).toBe(first);
    expect(result.current.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd app && bun run test use-linked-candidates`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `app/src/lib/use-linked-candidates.ts`:

```ts
import { useRef } from "react";
import type { FieldDef, MappingDimension } from "../data";

export interface LinkedCandidate {
  key: string;
  label: string;
}
export interface LinkedTarget {
  candidates: LinkedCandidate[];
  /** label lookups for `↳` columns: targetField id → display label */
  fieldLabels: Map<string, string>;
}

/** Resolve linked-field picker candidates with identity-stable output.
 *  The store replaces only mutated dim objects (dims.map), so comparing the
 *  referenced dims by object identity tells us whether anything this hook
 *  depends on actually changed — a plain useMemo on [allDims] re-fires on
 *  EVERY store emit because the array identity always changes. */
export function useLinkedCandidates(
  fields: FieldDef[],
  allDims: MappingDimension[],
): Map<string, LinkedTarget> {
  const prev = useRef<{
    fields: FieldDef[];
    refs: Array<MappingDimension | undefined>;
    out: Map<string, LinkedTarget>;
  } | null>(null);

  const referencedIds = fields
    .filter((f) => f.type === "linked" && f.referencedDimId)
    .map((f) => f.referencedDimId!);
  const refs = referencedIds.map((id) => allDims.find((d) => d.id === id));

  const p = prev.current;
  const unchanged =
    p !== null &&
    p.fields === fields &&
    p.refs.length === refs.length &&
    p.refs.every((d, i) => d === refs[i]);
  if (unchanged) return p.out;

  const out = new Map<string, LinkedTarget>();
  referencedIds.forEach((id, i) => {
    const dim = refs[i];
    if (!dim || out.has(id)) return;
    out.set(id, {
      candidates: dim.canonical.map((c) => ({ key: c.key, label: c.label })),
      fieldLabels: new Map((dim.fields ?? []).map((f) => [f.field, f.label])),
    });
  });
  prev.current = { fields, refs, out };
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && bun run test use-linked-candidates`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/use-linked-candidates.ts app/test/use-linked-candidates.test.tsx
git commit -m "feat(app): identity-stable linked-field candidate resolution"
```

---

### Task 2: Consume the hook in RecordsBody

**Files:**
- Modify: `app/src/components/TablePane.tsx`

- [ ] **Step 1: Call the hook**

In `RecordsBody`, after the `fields` memo (search `const fields = useMemo`), add:

```ts
  const linkedTargets = useLinkedCandidates(fields, allDims);
```

Import at the top of the file:

```ts
import { useLinkedCandidates } from "../lib/use-linked-candidates";
```

- [ ] **Step 2: Replace the `allDims.find` in the columns memo**

In the `columns` memo (`:303-404`), the linked branch currently reads:

```ts
        if (f.type === "linked") {
          const targetDim = allDims.find((d) => d.id === f.referencedDimId);
          const candidates =
            targetDim?.canonical.map((c) => ({ key: c.key, label: c.label })) ?? [];
```

Replace with:

```ts
        if (f.type === "linked") {
          const target = f.referencedDimId ? linkedTargets.get(f.referencedDimId) : undefined;
          const candidates = target?.candidates ?? [];
```

And the lookup-column label resolution a few lines below currently reads:

```ts
              const targetField = targetDim?.fields?.find((tf) => tf.field === df);
              return {
                field: `${f.field}__${df}`,
                label: `↳ ${targetField?.label ?? df}`,
```

Replace with:

```ts
              return {
                field: `${f.field}__${df}`,
                label: `↳ ${target?.fieldLabels.get(df) ?? df}`,
```

- [ ] **Step 3: Swap the dep**

Change the memo's dependency array (`:404`) from:

```ts
  }, [fields, engineer, dim.keyCol, external, layout, allDims]);
```

to:

```ts
  }, [fields, engineer, dim.keyCol, external, layout, linkedTargets]);
```

- [ ] **Step 4: Check for other `allDims` uses**

Run: `grep -n "allDims" app/src/components/TablePane.tsx`
Expected remaining uses: the `useDimensions()` declaration (`:191`) and the `allDims={allDims.map(...)}` prop pass-through (~`:879`, the AddFieldPopover). Those are fine — the popover open state is rare. If anything else inside the `columns` memo still references `allDims`, you missed a spot.

- [ ] **Step 5: Typecheck + full suite**

Run: `cd app && bun run typecheck && bun run test`
Expected: clean, all pass.

- [ ] **Step 6: Manual verification (the actual point of this change)**

`cd app && bun run dev`, open two tables as tabs (one with a linked field, e.g. via `?open=country,channel`). In React DevTools Profiler (or a temporary `console.count("columns")` inside the memo): edit cells in tab A rapidly — tab B's `columns` memo must NOT recompute. Then add a canonical record to the dim a linked field references — the consuming pane's columns MUST recompute (candidates list grows). Remove any temporary instrumentation before committing.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "perf(records): columns memo no longer rebuilds on unrelated store emits"
```

---

## Self-review checklist (for the executor)

- The hook must compare the **fields array identity** too — `fields` is already memoized in RecordsBody (`useMemo` on `dim.fields`), so identity comparison is sound.
- Multiple linked fields referencing the SAME dim must produce one map entry (the `out.has(id)` guard).
- A referenced dim that doesn't exist (deleted) yields no entry → `candidates ?? []` keeps the column rendering with an empty picker, same as today's `targetDim === undefined` path.
