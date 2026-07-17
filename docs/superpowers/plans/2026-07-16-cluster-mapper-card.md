# Cluster-Mapper Card (JSX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `useClusterMapper` as the visible focused card from the `map-values.html` mockup — cluster, member chips, keyboard-driven candidate picker, the mapped-sibling suggestion pre-highlighted, coverage, and map/skip/undo — wired for real.

**Architecture:** Two modules. (1) `app/src/lib/use-candidate-picker.ts` — a small hook that owns the active-candidate index and an `onKeyDown` handler mapping ↑/↓/Enter/Tab/Esc/⌘Z to the mapper actions; it pre-highlights the suggestion and resolves a "create" row's key. Pure enough to test by feeding it synthetic key events via `renderHook`. (2) `app/src/components/modes/ClusterMapperCard.tsx` — the styled component that calls `useClusterMapper(dim)` + `useCandidatePicker`, renders the loading/error/done/active states with the app's real Tailwind tokens and reusable `Button`/`Icons`, and guards against double-fire. Verified by a testing-library interaction test (the hook is mocked). The app can't run standalone (dev server proxies to a backend on :8787), so visual fidelity is by careful translation of the existing static mockup, not a live render.

**Tech Stack:** TypeScript (strict), React, Tailwind, Vitest + jsdom + `@testing-library/react`. Run from the `app/` workspace.

**Plan series:** Plan **5 of 7**. Depends on Plan 4 (`useClusterMapper`) + Plan 3 (`Candidate`/`CandidateRecord`) — on `main`. This is the first *visible* UI. Wiring it into the per-table tab (TablePane mode strip) is a small follow-up, not in this plan. Downstream: 6 (Sources monitor), 7 (IA/naming).

## Global Constraints

- **Use the app's real token vocabulary** (verbatim from `MatchModeBody.tsx`/`WiredSourcesModeBody.tsx`): surfaces `bg-surface`/`bg-surface-2`/`bg-bg`; text `text-ink`/`text-ink-2`/`text-ink-3`; accent `text-accent`/`bg-accent`/`bg-accent-wash`/`text-accent-ink`; borders `border-line`/`border-line-2`; fonts `font-mono`/`font-display`; `rounded-sm`/`rounded-pill`; hover `hover:bg-hover`; semantic `text-committed`/`bg-warn-soft`/`text-warn`/`text-danger`. Square aesthetic — only pills are rounded. Join conditional classes with `cx` from `../../lib/cx`.
- **Reuse components**: `Button` (`variant`/`size`/`icon` props) and `Icons` (`IconSearch`, `IconArrowRight`, `IconCheck`, `IconX`) from `../`.
- **Pre-highlight the suggestion.** The picker's initial active index is the position of `suggestion` in `candidates` (the mapped-sibling record — Plan-4 finding), else `0` (the closest fold-match, already first from `buildCandidates`).
- **Guard double-fire.** Map/skip must ignore a second synchronous invocation before the cluster advances (review finding: a double-click stages duplicate drafts + a duplicate undo key).
- **Keyboard contract:** ↑/↓ move the active candidate (wrapping); Enter commits the active candidate (a "create" row resolves its key via `slug`); Tab accepts the suggestion (if any); Esc clears the query; ⌘/Ctrl+Z undoes. Skip is a button.
- **Extensionless app imports.** Component lives at `app/src/components/modes/`; hook at `app/src/lib/`.
- **Gates:** from `app/`, `tsc --noEmit` and `eslint src` clean for changed files.

### Test command (from `app/`)

```
npx vitest run src/lib/use-candidate-picker.test.ts
npx vitest run src/components/modes/ClusterMapperCard.test.tsx
```

## File Structure

- `app/src/lib/use-candidate-picker.ts` — **new.** `useCandidatePicker` + `UseCandidatePicker` type.
- `app/src/lib/use-candidate-picker.test.ts` — **new.** `renderHook` + synthetic key events.
- `app/src/components/modes/ClusterMapperCard.tsx` — **new.** The styled card.
- `app/src/components/modes/ClusterMapperCard.test.tsx` — **new.** testing-library interaction test (mocks `useClusterMapper`).

## Interfaces Produced

```ts
// use-candidate-picker.ts
import type { Candidate } from "./cluster-candidates";
import type { CandidateRecord } from "./cluster-candidates";
export interface CandidatePickerOpts {
  candidates: Candidate[];
  suggestion: CandidateRecord | null;
  onMap: (recordKey: string, recordLabel: string) => void;
  onUndo: () => void;
  onQueryReset: () => void;
}
export interface UseCandidatePicker {
  active: number;
  setActive: (i: number) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  commit: (candidate: Candidate) => void;  // also used by row clicks
}
export function useCandidatePicker(opts: CandidatePickerOpts): UseCandidatePicker;

// ClusterMapperCard.tsx
export function ClusterMapperCard(props: { dim: MappingDimension }): JSX.Element;
```

---

### Task 1: `useCandidatePicker` — active index + keyboard

**Files:**
- Create: `app/src/lib/use-candidate-picker.ts`
- Test: `app/src/lib/use-candidate-picker.test.ts`

**Interfaces:**
- Consumes: `Candidate`/`CandidateRecord` (types, `./cluster-candidates`).
- Produces: `useCandidatePicker`, `UseCandidatePicker`, `CandidatePickerOpts`.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/use-candidate-picker.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCandidatePicker, type CandidatePickerOpts } from "./use-candidate-picker";
import type { Candidate, CandidateRecord } from "./cluster-candidates";

const CANDS: Candidate[] = [
  { kind: "record", key: "us", label: "United States", closest: true },
  { kind: "record", key: "gb", label: "United Kingdom", closest: false },
  { kind: "create", label: "USA" },
];

function key(k: string, mods: Partial<React.KeyboardEvent> = {}) {
  return { key: k, preventDefault: vi.fn(), metaKey: false, ctrlKey: false, altKey: false, ...mods } as unknown as React.KeyboardEvent;
}
function opts(over: Partial<CandidatePickerOpts> = {}): CandidatePickerOpts {
  return {
    candidates: CANDS,
    suggestion: null,
    onMap: vi.fn(),
    onUndo: vi.fn(),
    onQueryReset: vi.fn(),
    ...over,
  };
}

describe("useCandidatePicker", () => {
  it("defaults active to the suggestion's index, else 0", () => {
    const a = opts({ suggestion: { key: "gb", label: "United Kingdom" } as CandidateRecord });
    const { result } = renderHook(() => useCandidatePicker(a));
    expect(result.current.active).toBe(1); // gb is candidate index 1

    const b = opts();
    const { result: r2 } = renderHook(() => useCandidatePicker(b));
    expect(r2.current.active).toBe(0);
  });

  it("ArrowDown/ArrowUp move the active index, wrapping", () => {
    const { result } = renderHook(() => useCandidatePicker(opts()));
    act(() => result.current.onKeyDown(key("ArrowDown")));
    expect(result.current.active).toBe(1);
    act(() => result.current.onKeyDown(key("ArrowUp")));
    act(() => result.current.onKeyDown(key("ArrowUp")));
    expect(result.current.active).toBe(2); // wrapped past 0
  });

  it("Enter commits the active record via onMap(key, label)", () => {
    const a = opts();
    const { result } = renderHook(() => useCandidatePicker(a));
    act(() => result.current.onKeyDown(key("Enter")));
    expect(a.onMap).toHaveBeenCalledWith("us", "United States");
  });

  it("Enter on a create row resolves the key via slug", () => {
    const a = opts();
    const { result } = renderHook(() => useCandidatePicker(a));
    act(() => result.current.setActive(2)); // the create row
    act(() => result.current.onKeyDown(key("Enter")));
    expect(a.onMap).toHaveBeenCalledWith("usa", "USA"); // slug("USA") === "usa"
  });

  it("Tab accepts the suggestion", () => {
    const a = opts({ suggestion: { key: "gb", label: "United Kingdom" } as CandidateRecord });
    const { result } = renderHook(() => useCandidatePicker(a));
    const e = key("Tab");
    act(() => result.current.onKeyDown(e));
    expect(e.preventDefault).toHaveBeenCalled();
    expect(a.onMap).toHaveBeenCalledWith("gb", "United Kingdom");
  });

  it("Escape resets the query; Cmd/Ctrl+Z undoes", () => {
    const a = opts();
    const { result } = renderHook(() => useCandidatePicker(a));
    act(() => result.current.onKeyDown(key("Escape")));
    expect(a.onQueryReset).toHaveBeenCalled();
    act(() => result.current.onKeyDown(key("z", { metaKey: true })));
    expect(a.onUndo).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/lib/use-candidate-picker.test.ts`
Expected: FAIL — cannot resolve `./use-candidate-picker`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/use-candidate-picker.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import type { Candidate, CandidateRecord } from "./cluster-candidates";

export interface CandidatePickerOpts {
  candidates: Candidate[];
  suggestion: CandidateRecord | null;
  onMap: (recordKey: string, recordLabel: string) => void;
  onUndo: () => void;
  onQueryReset: () => void;
}
export interface UseCandidatePicker {
  active: number;
  setActive: (i: number) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  commit: (candidate: Candidate) => void;
}

/** Client twin of the store's slug — resolves a "create new record" label to a key. */
const slugKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function defaultActive(candidates: Candidate[], suggestion: CandidateRecord | null): number {
  if (suggestion) {
    const i = candidates.findIndex((c) => c.kind === "record" && c.key === suggestion.key);
    if (i >= 0) return i;
  }
  return 0;
}

export function useCandidatePicker(opts: CandidatePickerOpts): UseCandidatePicker {
  const { candidates, suggestion, onMap, onSkip, onUndo, onQueryReset } = opts;
  const [active, setActive] = useState(() => defaultActive(candidates, suggestion));

  // Re-seed the highlight whenever the candidate list or suggestion changes.
  useEffect(() => {
    setActive(defaultActive(candidates, suggestion));
  }, [candidates, suggestion]);

  const commit = useCallback(
    (candidate: Candidate) => {
      if (candidate.kind === "create") onMap(slugKey(candidate.label), candidate.label);
      else onMap(candidate.key, candidate.label);
    },
    [onMap],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const n = candidates.length;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        onUndo();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (n === 0 ? 0 : (a + 1) % n));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (n === 0 ? 0 : (a - 1 + n) % n));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cand = candidates[active];
        if (cand) commit(cand);
      } else if (e.key === "Tab" && suggestion) {
        e.preventDefault();
        onMap(suggestion.key, suggestion.label);
      } else if (e.key === "Escape") {
        onQueryReset();
      }
    },
    [candidates, active, suggestion, commit, onMap, onUndo, onQueryReset],
  );

  return { active, setActive, onKeyDown, commit };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/lib/use-candidate-picker.test.ts`
Expected: PASS — all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/use-candidate-picker.ts app/src/lib/use-candidate-picker.test.ts
git commit -m "feat(mapper): add useCandidatePicker (active index + keyboard)"
```

---

### Task 2: `ClusterMapperCard` — the styled focused card

**Files:**
- Create: `app/src/components/modes/ClusterMapperCard.tsx`
- Test: `app/src/components/modes/ClusterMapperCard.test.tsx`

**Interfaces:**
- Consumes: `useClusterMapper` (`../../lib/use-cluster-mapper`), `useCandidatePicker` (`../../lib/use-candidate-picker`), `Button` (`../Button`), `IconSearch`/`IconArrowRight` (`../Icons`), `cx` (`../../lib/cx`), `MappingDimension` (type, `../../data`).
- Produces: `ClusterMapperCard({ dim })`.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/modes/ClusterMapperCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { UseClusterMapper } from "../../lib/use-cluster-mapper";

const { mapperRef } = vi.hoisted(() => ({ mapperRef: { current: null as unknown as UseClusterMapper } }));
vi.mock("../../lib/use-cluster-mapper", () => ({ useClusterMapper: () => mapperRef.current }));

import { ClusterMapperCard } from "./ClusterMapperCard";
import type { MappingDimension } from "../../data";

const DIM = { id: "d1", dimension: "Country" } as unknown as MappingDimension;

function baseMapper(over: Partial<UseClusterMapper> = {}): UseClusterMapper {
  return {
    loading: false,
    error: null,
    current: {
      key: "usa", rep: "USA", rows: 12405, mappedCount: 1,
      members: [
        { raw: "USA", rows: 12000, isMapped: false, mappedLabel: null, occurrences: [] },
        { raw: "U.S.A.", rows: 405, isMapped: true, mappedLabel: "United States", occurrences: [] },
      ],
    },
    candidates: [
      { kind: "record", key: "us", label: "United States", closest: true },
      { kind: "create", label: "USA" },
    ],
    suggestion: { key: "us", label: "United States" },
    coverage: { resolvedRows: 400, atRiskRows: 12405, pct: 3 },
    truncated: false,
    staged: 0,
    done: false,
    position: { index: 0, total: 5 },
    query: "",
    setQuery: vi.fn(),
    mapCluster: vi.fn(),
    skipCluster: vi.fn(),
    undo: vi.fn(),
    jumpTo: vi.fn(),
    refetch: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  mapperRef.current = baseMapper();
});

describe("ClusterMapperCard", () => {
  it("renders the current cluster: rep, members, and the suggested record", () => {
    const { getByText, getAllByText } = render(<ClusterMapperCard dim={DIM} />);
    expect(getAllByText("USA").length).toBeGreaterThanOrEqual(1); // rep + member chip
    expect(getByText("U.S.A.")).toBeTruthy(); // a member chip (unique)
    expect(getByText("United States")).toBeTruthy(); // the candidate record (unique)
    expect(getByText("Suggested")).toBeTruthy(); // the mapped-sibling pill
  });

  it("Enter maps the pre-highlighted suggested record", () => {
    const map = vi.fn();
    mapperRef.current = baseMapper({ mapCluster: map });
    const { getByLabelText } = render(<ClusterMapperCard dim={DIM} />);
    fireEvent.keyDown(getByLabelText("Map values"), { key: "Enter" });
    expect(map).toHaveBeenCalledWith("us", "United States");
  });

  it("Skip button calls skipCluster", () => {
    const skip = vi.fn();
    mapperRef.current = baseMapper({ skipCluster: skip });
    const { getByText } = render(<ClusterMapperCard dim={DIM} />);
    fireEvent.click(getByText("Skip"));
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("guards against a double map before the cluster advances", () => {
    const map = vi.fn();
    mapperRef.current = baseMapper({ mapCluster: map });
    const { getByLabelText } = render(<ClusterMapperCard dim={DIM} />);
    const card = getByLabelText("Map values");
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(map).toHaveBeenCalledTimes(1); // second Enter is swallowed
  });

  it("shows the done state when the queue is worked", () => {
    mapperRef.current = baseMapper({ current: null, done: true, staged: 7 });
    const { getByText } = render(<ClusterMapperCard dim={DIM} />);
    expect(getByText(/all mapped/i)).toBeTruthy();
  });

  it("shows an error with a retry", () => {
    const refetch = vi.fn();
    mapperRef.current = baseMapper({ error: "HTTP 500", current: null, refetch });
    const { getByText } = render(<ClusterMapperCard dim={DIM} />);
    fireEvent.click(getByText("retry"));
    expect(refetch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/components/modes/ClusterMapperCard.test.tsx`
Expected: FAIL — cannot resolve `./ClusterMapperCard`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/components/modes/ClusterMapperCard.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { MappingDimension } from "../../data";
import { useClusterMapper } from "../../lib/use-cluster-mapper";
import { useCandidatePicker } from "../../lib/use-candidate-picker";
import { Button } from "../Button";
import { IconSearch } from "../Icons";
import { cx } from "../../lib/cx";

/* ClusterMapperCard — the focused "map one family at a time" card. Renders the
   useClusterMapper controller: the current cluster, a keyboard-driven candidate
   list with the mapped-sibling suggestion pre-highlighted, coverage, and
   map/skip/undo. Styled with the app's Squared tokens. */
export function ClusterMapperCard({ dim }: { dim: MappingDimension }) {
  const m = useClusterMapper(dim);

  // Swallow a second synchronous map/skip before the cluster advances.
  const acting = useRef(false);
  useEffect(() => {
    acting.current = false;
  }, [m.current?.key, m.done]);
  const mapGuarded = (k: string, l: string) => {
    if (acting.current) return;
    acting.current = true;
    m.mapCluster(k, l);
  };
  const skipGuarded = () => {
    if (acting.current) return;
    acting.current = true;
    m.skipCluster();
  };

  const picker = useCandidatePicker({
    candidates: m.candidates,
    suggestion: m.suggestion,
    onMap: mapGuarded,
    onUndo: m.undo,
    onQueryReset: () => m.setQuery(""),
  });

  if (m.loading) {
    return <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">loading…</div>;
  }
  if (m.error) {
    return (
      <div className="px-4 py-12 text-center font-mono text-[12px] text-danger">
        Couldn't load values: {m.error}{" "}
        <button type="button" onClick={m.refetch} className="text-accent hover:underline">
          retry
        </button>
      </div>
    );
  }
  if (m.done || !m.current) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="font-display text-[18px] font-semibold text-ink">
          {dim.dimension} is all mapped 🎉
        </div>
        <div className="mt-1.5 font-mono text-[11.5px] text-ink-3">
          {m.coverage.pct}% of at-risk rows resolved · {m.staged} staged
        </div>
      </div>
    );
  }

  const c = m.current;
  const shown = c.members.slice(0, 6);
  return (
    <div
      className="flex flex-1 flex-col min-h-0 outline-none"
      tabIndex={0}
      onKeyDown={picker.onKeyDown}
      aria-label="Map values"
    >
      {/* header: progress + coverage */}
      <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">mapping</span>
        <span className="ml-auto font-mono text-[11px] text-ink-3">
          <span className="text-ink">{m.position.index + 1}</span> of {m.position.total}
        </span>
        <div className="h-1 w-28 overflow-hidden rounded-pill bg-surface-2">
          <div className="h-full bg-committed" style={{ width: `${m.coverage.pct}%` }} />
        </div>
        <span className="font-mono text-[11px] text-committed">{m.coverage.pct}%</span>
      </div>

      {m.truncated && (
        <div className="border-b border-line bg-warn-soft px-4 py-1.5 font-mono text-[11px] text-warn">
          Showing the highest-impact groups; a long tail of rare values remains.
        </div>
      )}

      {/* cluster: rep + member chips */}
      <div className="px-5 pt-5">
        <div className="flex items-end justify-between gap-4">
          <div className="break-all font-mono text-[26px] font-semibold leading-none tracking-[-0.01em] text-ink">
            {c.rep}
          </div>
          <div className="text-right font-mono text-[11px] text-ink-3">
            <span className="block text-[15px] font-semibold text-ink-2">{c.rows.toLocaleString("en-US")}</span>
            rows affected
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {shown.map((mem) => (
            <span key={mem.raw} className="rounded-sm border border-line bg-surface px-2 py-0.5 font-mono text-[12px] text-ink">
              {mem.raw}
            </span>
          ))}
          {c.members.length > shown.length && (
            <span className="rounded-sm border border-dashed border-line px-2 py-0.5 font-mono text-[12px] text-ink-3">
              +{c.members.length - shown.length} more
            </span>
          )}
        </div>
      </div>

      {/* search */}
      <label className="mx-5 mt-4 flex items-center gap-2 border border-line-2 bg-surface">
        <span className="pl-3 text-ink-3">
          <IconSearch className="h-4 w-4" />
        </span>
        <input
          value={m.query}
          onChange={(e) => m.setQuery(e.target.value)}
          placeholder="Search records…"
          className="min-h-[36px] flex-1 bg-transparent px-1 font-mono text-[12px] text-ink outline-none placeholder:text-ink-3"
          aria-label="Search records"
        />
        <span className="pr-3 font-mono text-[10px] text-ink-3">↑↓ · ⏎ map</span>
      </label>

      {/* candidate list */}
      <div className="mt-3 flex-1 overflow-y-auto" role="listbox" aria-label="Records">
        {m.candidates.map((cand, i) => {
          const activeCls = i === picker.active ? "border-l-accent bg-surface-2" : "border-l-transparent";
          const label = cand.kind === "create" ? `Create “${cand.label}” as a new record` : cand.label;
          const isSuggested = cand.kind === "record" && m.suggestion?.key === cand.key;
          return (
            <button
              key={cand.kind === "create" ? "__create" : cand.key}
              type="button"
              role="option"
              aria-selected={i === picker.active}
              onClick={() => picker.commit(cand)}
              className={cx(
                "flex w-full items-center gap-3 border-l-2 px-5 py-2.5 text-left hover:bg-hover",
                activeCls,
              )}
            >
              <span className={cx("font-display text-[15px] font-semibold", cand.kind === "create" ? "text-accent" : "text-ink")}>
                {cand.kind === "create" ? "＋ " : ""}
                {label}
              </span>
              {cand.kind === "record" && <span className="font-mono text-[11px] text-ink-3">{cand.key}</span>}
              <span className="ml-auto flex items-center gap-2">
                {isSuggested && (
                  <span className="rounded-pill bg-accent-wash px-2 py-0.5 font-mono text-[9.5px] uppercase text-accent">
                    Suggested
                  </span>
                )}
                {i === picker.active && (
                  <span className="bg-accent px-1.5 font-mono text-[10px] text-accent-ink">⏎</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* footer: staged + undo + skip */}
      <div className="flex items-center gap-3 border-t border-line bg-surface px-4 py-3">
        <span className="font-mono text-[11px] text-ink-3">
          <span className="text-ink-2">{m.staged}</span> staged · Tab takes the suggestion
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={m.undo}>
            ↶ Undo
          </Button>
          <Button variant="secondary" size="sm" onClick={skipGuarded}>
            Skip <span className="ml-1 font-mono text-[10px] opacity-60">→</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/components/modes/ClusterMapperCard.test.tsx`
Expected: PASS — all 6 tests pass.

- [ ] **Step 5: Run the gates**

Run (from `app/`): `npx tsc --noEmit`
Expected: no NEW errors referencing `use-candidate-picker.ts` or `ClusterMapperCard.tsx`. (Pre-existing errors elsewhere are out of scope.)

Run (from `app/`): `npx eslint src/lib/use-candidate-picker.ts src/lib/use-candidate-picker.test.ts src/components/modes/ClusterMapperCard.tsx src/components/modes/ClusterMapperCard.test.tsx`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/modes/ClusterMapperCard.tsx app/src/components/modes/ClusterMapperCard.test.tsx
git commit -m "feat(mapper): add ClusterMapperCard focused-card component"
```

---

## Self-Review

**Spec coverage:**
- Keyboard contract (↑/↓/Enter/Tab/Esc/⌘Z) → Task 1 `useCandidatePicker`, each asserted; Task 2 wires `onKeyDown` on the card and asserts Enter maps the suggestion.
- Suggestion pre-highlight (Plan-4 finding lands visibly) → Task 1 defaults active to the suggestion's index; Task 2 renders the "Suggested" pill and Enter maps `us`.
- Map the whole family / caller resolves key → the card calls `m.mapCluster(key,label)`; create rows resolve via `slug` in the picker's `commit`.
- Double-fire guard → Task 2 `acting` ref, asserted (second Enter swallowed).
- States: loading/error(+retry)/done/active → Task 2, asserted for done + error.
- Real token vocabulary + reusable `Button`/`Icons` → per Global Constraints.

**Placeholder scan:** No TBD/TODO. Every step has literal code and the exact `npx vitest run <file>` command.

**Type consistency:** `Candidate`/`CandidateRecord` from Plan-3 `cluster-candidates.ts`; `UseClusterMapper` (mocked in the card test) from Plan-4 `use-cluster-mapper.ts`; `MappingDimension` type-only from `../../data`. `useCandidatePicker`'s `onMap(recordKey, recordLabel)` matches `useClusterMapper.mapCluster`.

**Known follow-up (not in scope):** wiring `ClusterMapperCard` into `TablePane`'s mode strip, and pixel-level visual polish (the app can't run standalone here; fidelity is by translation of `docs/redesign/map-values.html`).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-cluster-mapper-card.md`.

Two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
