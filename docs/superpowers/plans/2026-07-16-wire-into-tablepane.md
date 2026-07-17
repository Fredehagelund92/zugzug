# Wire the Redesign into TablePane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped-but-unmounted redesign *appear in the running app* — swap the Sources tab to `SourcesMonitorBody`, and give the Map values tab a Focused/Grid toggle where Focused is `ClusterMapperCard` + a publish bar and Grid is the existing `MatchModeBody` (unchanged, as the power view).

**Architecture:** Two changes in `app/src/components/`. (1) A one-line drop-in: TablePane renders `SourcesMonitorBody` instead of `WiredSourcesModeBody` for the `sources` mode (prop-compatible — verified). (2) A new `MapValuesBody` wrapper that owns a Focused/Grid view toggle: Focused renders `ClusterMapperCard` (the staging surface) plus a minimal publish bar (`listDrafts`→`commit`); Grid renders the existing `MatchModeBody` verbatim. TablePane renders `MapValuesBody` for the `match` mode. The design is **additive and reversible** — the old `MatchModeBody` stays fully reachable via the Grid toggle, so a visual issue in the new card never blocks a user.

**Tech Stack:** TypeScript, React, Tailwind, Vitest + `@testing-library/react`. Run from the `app/` workspace.

**Plan series:** The **integration** plan for the 7-plan cluster-mapper arc (all on `main`). Depends on `ClusterMapperCard` (Plan 5), `SourcesMonitorBody` (Plan 6), and the store's `listDrafts`/`commit`/`useDrafts`.

> **VERIFICATION CAVEAT (read before executing):** the app dev server proxies to a backend on `:8787`, so it can't run standalone in the plan-authoring environment. The unit tests here cover wiring + logic (toggle switches views, publish calls `commit`, the card renders), but **not** the live visual render against real data. Execute Task 1 (the Sources drop-in) freely — it's low-risk and the old body is one `git revert` away. For Task 2, ideally run the app locally (`cd server && bun run dev` + `cd app && bun run dev`) and eyeball the Focused card once; if you can't, the Grid toggle keeps `MatchModeBody` available as the safety net.

## Global Constraints

- **Additive + reversible.** Do not delete or modify `MatchModeBody`/`WiredSourcesModeBody` — Grid renders `MatchModeBody` unchanged; the old Sources body simply stops being referenced. No behavior removed.
- **Reuse the real publish path.** The Focused publish bar uses the same store calls as `MatchModeBody`: staged = `listDrafts(dim.id).filter(d => d.status === "mapped")` (re-rendered via `useDrafts()`); publish = `commit(dim.id)`; gate on `useCanEdit()`.
- **Real Tailwind tokens** (as elsewhere) + reused `Button`/`cx`.
- **Extensionless imports.**
- **Gates:** from `app/`, `tsc --noEmit` and `eslint src` clean for changed files.

### Test command (from `app/`)

```
npx vitest run src/components/modes/MapValuesBody.test.tsx
```

## File Structure

- `app/src/components/TablePane.tsx` — **modify.** Two render lines (188, 189) + two imports.
- `app/src/components/modes/MapValuesBody.tsx` — **new.** The Focused/Grid wrapper + publish bar.
- `app/src/components/modes/MapValuesBody.test.tsx` — **new.** testing-library test (mocks the card, MatchModeBody, and store).

## Interfaces Produced

```ts
export function MapValuesBody(props: { dim: MappingDimension; isActive: boolean }): JSX.Element;
```

---

### Task 1: Swap the Sources tab to `SourcesMonitorBody` (drop-in)

**Files:**
- Modify: `app/src/components/TablePane.tsx`

**Interfaces:** none.

- [ ] **Step 1: Apply the swap**

In `app/src/components/TablePane.tsx`:
- Replace the import (line ~66) `import { WiredSourcesModeBody } from "./modes/WiredSourcesModeBody";` with `import { SourcesMonitorBody } from "./modes/SourcesMonitorBody";`
- Replace the render (line ~189) `{activeMode === "sources" && <WiredSourcesModeBody dim={dim} />}` with `{activeMode === "sources" && <SourcesMonitorBody dim={dim} />}`

- [ ] **Step 2: Verify the gates**

Run (from `app/`): `npx tsc --noEmit`
Expected: no NEW errors referencing `TablePane.tsx` or `SourcesMonitorBody.tsx`. (`WiredSourcesModeBody` is now unreferenced but not deleted — that's fine; it may show an unused-file lint at most, not a tsc error.)

Run (from `app/`): `npx eslint src/components/TablePane.tsx`
Expected: no errors. (If eslint flags the now-unused `WiredSourcesModeBody` import, you already removed it in Step 1 — confirm no stray import remains.)

Run (from `app/`): `npx vitest run src/components/modes/SourcesMonitorBody.test.tsx`
Expected: PASS (unchanged — 4/4).

- [ ] **Step 3: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "feat(sources): mount SourcesMonitorBody in the Sources tab"
```

---

### Task 2: Map values tab — Focused/Grid toggle + publish bar

**Files:**
- Create: `app/src/components/modes/MapValuesBody.tsx`
- Test: `app/src/components/modes/MapValuesBody.test.tsx`
- Modify: `app/src/components/TablePane.tsx` (render `MapValuesBody` for `match`)

**Interfaces:**
- Consumes: `ClusterMapperCard` (`./ClusterMapperCard`), `MatchModeBody` (`./MatchModeBody`), `useDrafts`/`listDrafts`/`commit`/`useCanEdit` (`../../store`), `toast` (`../Toast`), `useAsyncAction` (`../../hooks/useAsyncAction`), `Button`, `cx`, `MappingDimension` (type).
- Produces: `MapValuesBody({ dim, isActive })`.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/modes/MapValuesBody.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// Mock the two heavy bodies + the store so the wrapper is testable in isolation.
vi.mock("./ClusterMapperCard", () => ({ ClusterMapperCard: () => <div>FOCUSED CARD</div> }));
vi.mock("./MatchModeBody", () => ({ MatchModeBody: () => <div>GRID BODY</div> }));

const { draftsRef } = vi.hoisted(() => ({ draftsRef: { current: [] as { dimId: string; status: string }[] } }));
vi.mock("../../store", () => ({
  useDrafts: () => draftsRef.current,
  listDrafts: (dimId: string) => draftsRef.current.filter((d) => d.dimId === dimId),
  commit: vi.fn().mockResolvedValue({ committed: 2, rowsRecovered: 0 }),
  useCanEdit: () => true,
}));
vi.mock("../Toast", () => ({ toast: vi.fn() }));

import { commit } from "../../store";
import { MapValuesBody } from "./MapValuesBody";
import type { MappingDimension } from "../../data";

const commitMock = commit as unknown as ReturnType<typeof vi.fn>;
const DIM = { id: "d1", dimension: "Country" } as unknown as MappingDimension;

beforeEach(() => {
  commitMock.mockClear();
  draftsRef.current = [];
});

describe("MapValuesBody", () => {
  it("defaults to the Focused card and can toggle to the Grid power view", () => {
    const { getByText, queryByText } = render(<MapValuesBody dim={DIM} isActive />);
    expect(getByText("FOCUSED CARD")).toBeTruthy();
    expect(queryByText("GRID BODY")).toBeNull();

    fireEvent.click(getByText("Grid"));
    expect(getByText("GRID BODY")).toBeTruthy();
    expect(queryByText("FOCUSED CARD")).toBeNull();
  });

  it("shows the staged count and publishes via commit", () => {
    draftsRef.current = [
      { dimId: "d1", status: "mapped" },
      { dimId: "d1", status: "mapped" },
      { dimId: "d1", status: "skipped" }, // not counted
      { dimId: "other", status: "mapped" }, // other dim, not counted
    ];
    const { getByText } = render(<MapValuesBody dim={DIM} isActive />);
    expect(getByText(/2 staged changes/i)).toBeTruthy();
    fireEvent.click(getByText(/Publish 2 changes/i));
    expect(commitMock).toHaveBeenCalledWith("d1");
  });

  it("disables publish when nothing is staged", () => {
    const { getByText } = render(<MapValuesBody dim={DIM} isActive />);
    expect((getByText(/Publish 0 changes/i).closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npx vitest run src/components/modes/MapValuesBody.test.tsx`
Expected: FAIL — cannot resolve `./MapValuesBody`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/components/modes/MapValuesBody.tsx`:

```tsx
import { useMemo, useState } from "react";
import type { MappingDimension } from "../../data";
import { ClusterMapperCard } from "./ClusterMapperCard";
import { MatchModeBody } from "./MatchModeBody";
import { useDrafts, listDrafts, commit, useCanEdit } from "../../store";
import { toast } from "../Toast";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { Button } from "../Button";
import { cx } from "../../lib/cx";

type View = "focused" | "grid";

/* MapValuesBody — the Map values tab. Default is the focused cluster card
   (ClusterMapperCard) with a publish bar; the Grid toggle drops to the existing
   MatchModeBody power view (bulk / paste / engineer SQL). Both stage into the
   same drafts, so the publish bar works from either. */
export function MapValuesBody({ dim, isActive }: { dim: MappingDimension; isActive: boolean }) {
  const [view, setView] = useState<View>("focused");
  const drafts = useDrafts();
  const canEdit = useCanEdit();

  const staged = useMemo(
    () => listDrafts(dim.id).filter((d) => d.status === "mapped").length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, dim.id],
  );

  const publish = useAsyncAction(async () => {
    if (staged === 0) return;
    try {
      const res = await commit(dim.id);
      toast(`Published ${res.committed} change${res.committed === 1 ? "" : "s"} to ${dim.dimension}`);
    } catch (e) {
      toast(e instanceof Error ? `Publish failed — ${e.message}` : "Publish failed.", "error");
      throw e;
    }
  });

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Focused / Grid toggle */}
      <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <div className="inline-flex border border-line">
          {(["focused", "grid"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cx(
                "px-3 py-1 font-mono text-[11px]",
                view === v ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {v === "focused" ? "Focused" : "Grid"}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[11px] text-ink-3">Grid is the power view — bulk, paste, SQL</span>
      </div>

      {view === "focused" ? (
        <>
          <ClusterMapperCard dim={dim} />
          <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t border-line bg-surface px-4 py-3">
            <span className="font-mono text-[11px] text-ink-2">
              {staged > 0 ? (
                <>
                  <span className="font-semibold text-ink">{staged}</span> staged change{staged === 1 ? "" : "s"} ready to publish to {dim.dimension}
                </>
              ) : (
                <>nothing staged yet — map values above</>
              )}
            </span>
            <Button
              size="sm"
              className="ml-auto"
              disabled={staged === 0 || !canEdit}
              onClick={() => void publish.run()}
            >
              Publish {staged} change{staged === 1 ? "" : "s"}
            </Button>
          </div>
        </>
      ) : (
        <MatchModeBody dim={dim} isActive={isActive} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `app/`): `npx vitest run src/components/modes/MapValuesBody.test.tsx`
Expected: PASS — all 3 tests pass.

- [ ] **Step 5: Wire it into TablePane**

In `app/src/components/TablePane.tsx`:
- Add the import: `import { MapValuesBody } from "./modes/MapValuesBody";`
- Replace the render (line ~188) `{activeMode === "match" && <MatchModeBody dim={dim} isActive={isActive} />}` with `{activeMode === "match" && <MapValuesBody dim={dim} isActive={isActive} />}`
- The direct `MatchModeBody` import in TablePane is now unused (it's rendered inside `MapValuesBody`) — remove TablePane's `import { MatchModeBody } ...` line to avoid an unused-import lint error.

- [ ] **Step 6: Run the gates**

Run (from `app/`): `npx tsc --noEmit`
Expected: no NEW errors referencing `MapValuesBody.tsx` or `TablePane.tsx`.

Run (from `app/`): `npx eslint src/components/modes/MapValuesBody.tsx src/components/modes/MapValuesBody.test.tsx src/components/TablePane.tsx`
Expected: no errors (no unused `MatchModeBody` import left in TablePane).

- [ ] **Step 7: Commit**

```bash
git add app/src/components/modes/MapValuesBody.tsx app/src/components/modes/MapValuesBody.test.tsx app/src/components/TablePane.tsx
git commit -m "feat(mapper): mount MapValuesBody (focused card + grid toggle) in the Map values tab"
```

---

## Self-Review

**Spec coverage:**
- Sources drop-in → Task 1 (one import + one render line); verified by gates + the existing SourcesMonitorBody suite.
- Map values = Focused card + Grid power view → Task 2 `MapValuesBody`; toggle asserted (Focused ↔ Grid), Grid renders the unchanged `MatchModeBody`.
- Publish from Focused → Task 2 publish bar reuses `listDrafts`/`commit`; staged count + disabled-when-empty + `commit(dim.id)` all asserted.
- Additive/reversible → `MatchModeBody`/`WiredSourcesModeBody` untouched; the new default is toggleable back to Grid.

**Placeholder scan:** No TBD/TODO — literal code + exact commands throughout.

**Type consistency:** `MapValuesBody({dim, isActive})` matches the props TablePane passed to `MatchModeBody`; `commit(dim.id)` / `listDrafts(dim.id)` per `store.ts`.

**Known follow-ups (not in scope, in the ledger):** pass `isActive` into `ClusterMapperCard`/`useClusterMapper` to skip fetching in a hidden pane (mounted-but-hidden panes currently fetch); the a11y `aria-activedescendant`, disable-wand-on-pending, and `STALE_DAYS` de-dup carry-forwards. And the **visual verification** of the Focused card in a running app (see the caveat at the top).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-wire-into-tablepane.md`.

Two execution options:
1. **Subagent-Driven (recommended)** — a subagent per task, review between.
2. **Inline Execution** — execute in this session with checkpoints.

**Recommended:** execute Task 1 now (safe drop-in). For Task 2, execute the code + tests, then verify the Focused card visually in a running app before relying on it — the Grid toggle keeps the old surface available in the meantime.
