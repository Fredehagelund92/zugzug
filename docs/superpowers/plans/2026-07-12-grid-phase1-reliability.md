# Grid Phase 1: Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silent data loss in the Tables grid: failed saves must be visible (and the "Saved" pill must stop lying), rapid record adds must never drop input, layout saves must survive page unloads, a filtered-out grid must not claim the table is empty, and number fields must reject garbage instead of silently nulling it.

**Architecture:** All five fixes ride existing seams. The store's central `api()` write wrapper (`app/src/store.ts:305`) gains a failure branch feeding the existing sync-status pub/sub (`SyncPill`). The imperative `toast()` singleton (`app/src/components/Toast.tsx`) is the error surface — it is framework-light pub/sub, safe to call from the store. Add-record gets a serial FIFO queue extracted as a small hook so it is unit-testable (the TablePane component harness is known-untestable in jsdom — see the skipped `tablepane-conflict.test.tsx`). The empty-state and NumberCell fixes are local to the datagrid.

**Tech Stack:** React 18, vitest 4 + @testing-library/react (jsdom), TypeScript, Tailwind v4.

## Global Constraints

- Working directory for npm commands: `app/` inside the worktree. Single file: `npx vitest run <file>`; suite: `npm test`.
- Match existing code style (Prettier: `npm run format:check` stays clean — note it currently fails on two PRE-EXISTING files this branch must not touch: `src/lib/integrations-api.ts`, `src/lib/palette.ts`; your changed files must be clean).
- User-facing copy uses plain vocabulary (CLAUDE.md): "record", "table", "saved", "filters". Never surface: canonical, raw, triage, master, golden, commit, sync, tenant, matching.
- No new dependencies. Touch only the files each task names. `npm run typecheck` passes after each task.
- Every commit message ends with the two trailer lines:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01DjP13yuXXqX2aktep2MPnz`
- The full suite can show flaky timeout failures under machine load. If an unrelated test fails, re-run that file in isolation once; report BLOCKED only if it also fails in isolation.

---

### Task 1: Failed writes are visible — sync status gains "failed", paste errors toast

Today `api()` (store.ts:305-314) marks every settled write as saved — `writeSettled()` runs in `finally`, so a rejected PUT still flips the pill to green "Saved". And DataGrid's multi-cell paste/fill catch (DataGrid.tsx ~line 690) logs to the console only.

**Files:**
- Modify: `app/src/store.ts` (SyncStatus type :265, writeStarted/writeSettled block :272-302, `api()` :305-314)
- Modify: `app/src/components/SyncPill.tsx` (failed variant)
- Modify: `app/src/components/datagrid/DataGrid.tsx` (~:690 paste/fill catch — the `void Promise.all(writes.map(...))` block)
- Test: extend `app/test/sync-status.test.tsx`; new `app/test/sync-pill-failed.test.tsx`

**Interfaces:**
- Produces: `SyncStatus` union gains `"failed"`; internal `writeFailed()` in store.ts. Task 3's layout PATCH failures flow through the same `api()` path and inherit the failed pill.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/sync-status.test.tsx` inside the existing `describe`:

```tsx
  test("failed when a write rejects; the pill state does not report saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts?: RequestInit) => {
        if (opts?.method && opts.method !== "GET") return new Response("boom", { status: 500 });
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const { useSyncStatus, discardDraft } = await import("../src/store");
    const { result } = renderHook(() => useSyncStatus());

    let done!: Promise<void>;
    act(() => {
      done = discardDraft("country", "usa").catch(() => undefined);
    });
    await act(async () => {
      await done;
    });
    expect(result.current).toBe("failed");
  });
```

Create `app/test/sync-pill-failed.test.tsx`:

```tsx
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return { ...actual, useSyncStatus: () => "failed" as const };
});

describe("SyncPill", () => {
  test("failed status renders 'Save failed', not 'Saved'", async () => {
    const { SyncPill } = await import("../src/components/SyncPill");
    render(<SyncPill />);
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/sync-status.test.tsx test/sync-pill-failed.test.tsx`
Expected: the new sync-status test FAILS with `expected 'saved' to be 'failed'` (the `finally` marks it saved); the pill test FAILS (no "Save failed" branch renders). Pre-existing tests in sync-status.test.tsx stay green.

- [ ] **Step 3: Implement**

(a) `app/src/store.ts:265` — extend the union:

```ts
export type SyncStatus = "idle" | "saving" | "saved" | "failed";
```

(b) After the existing `writeSettled()` function (:283-291), add:

```ts
function writeFailed(): void {
  pendingWrites--;
  syncStatus = "failed";
  emitSync();
  if (savedDecayTimer) clearTimeout(savedDecayTimer);
  savedDecayTimer = setTimeout(() => {
    syncStatus = "idle";
    emitSync();
  }, 4000);
}
```

(Use the exact local names from the file — `pendingWrites`, `savedDecayTimer`, `emitSync` all exist in the :272-302 block.)

(c) Restructure `api()` (:305-314) so failure does not report saved:

```ts
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const isWrite = !!opts?.method && opts.method !== "GET";
  if (isWrite) writeStarted();
  try {
    const result = await apiInner<T>(path, opts);
    if (isWrite) writeSettled();
    return result;
  } catch (e) {
    if (isWrite) writeFailed();
    throw e;
  }
}
```

(d) `app/src/components/SyncPill.tsx` — add the failed branch. Replace the component body's className/label logic:

```tsx
export function SyncPill() {
  const status = useSyncStatus();
  if (status === "idle") return null;
  return (
    <span
      role="status"
      className={cx(
        "flex items-center gap-1.5 rounded-pill px-2.5 py-1 font-mono text-[10.5px] transition-colors",
        status === "saving" && "bg-accent-wash text-accent",
        status === "saved" && "bg-surface-2 text-ink-3",
        status === "failed" && "bg-[color-mix(in_srgb,var(--ak-danger)_14%,var(--surface-2))] text-danger",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "h-1.5 w-1.5 rounded-pill",
          status === "saving" && "animate-pulse bg-accent",
          status === "saved" && "bg-ok",
          status === "failed" && "bg-danger",
        )}
      />
      {status === "saving" ? "Saving…" : status === "failed" ? "Save failed" : "Saved"}
    </span>
  );
}
```

(Keep the file's existing imports; `text-danger`/`bg-danger` utilities exist — Toast.tsx already uses them.)

(e) `app/src/components/datagrid/DataGrid.tsx` — in the multi-write block (~:690), surface the failure:

```ts
void Promise.all(writes.map((w) => commitValue(w.rk, w.field, w.value)))
  .catch((err) => {
    console.error(`DataGrid: ${label} failed`, err);
    toast(
      `${label} didn't save — ${err instanceof Error ? err.message : "please try again"}`,
      "error",
    );
  })
```

Add the import `import { toast } from "../Toast";` alongside DataGrid's other component imports. (`label` is the transaction label already in scope, e.g. "paste 4 cells".)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run test/sync-status.test.tsx test/sync-pill-failed.test.tsx`
Expected: PASS (all tests in both files, including pre-existing ones).

- [ ] **Step 5: Full suite + typecheck**

Run: `cd app && npm test && npm run typecheck`
Expected: green (flaky-timeout caveat in Global Constraints applies).

- [ ] **Step 6: Commit**

```bash
git add app/src/store.ts app/src/components/SyncPill.tsx app/src/components/datagrid/DataGrid.tsx app/test/sync-status.test.tsx app/test/sync-pill-failed.test.tsx
git commit -m "fix(grid): failed saves are visible — sync pill 'failed' state, paste errors toast

A rejected write used to flip the pill to green 'Saved' (writeSettled ran
in finally) and multi-cell paste failures only hit the console. api() now
routes rejections through writeFailed(); the pill shows 'Save failed';
paste/fill failures raise an error toast.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DjP13yuXXqX2aktep2MPnz"
```

---

### Task 2: Rapid record adds never drop input — serial add queue

Today `add()` in TablePane's RecordsBody (:424-441) bails while `busy`, and a rejection skips `setBusy(false)`/`setDraft("")`, wedging the form. Submissions during an in-flight add are silently ignored.

**Files:**
- Create: `app/src/hooks/use-add-queue.ts`
- Modify: `app/src/components/TablePane.tsx` (RecordsBody: the `busy` state, `add()` :424-441, and the input/Button JSX :1230-1251)
- Test: `app/test/use-add-queue.test.tsx`

**Interfaces:**
- Produces: `useAddQueue(run: (label: string) => Promise<void>, onError: (label: string, err: unknown) => void): { enqueue: (label: string) => void; pending: number }`

- [ ] **Step 1: Write the failing test**

Create `app/test/use-add-queue.test.tsx`:

```tsx
import { describe, test, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAddQueue } from "../src/hooks/use-add-queue";

describe("useAddQueue", () => {
  test("runs adds serially in order and tracks pending count", async () => {
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const run = vi.fn((label: string) => {
      order.push(`start:${label}`);
      return new Promise<void>((resolve) =>
        gates.push(() => {
          order.push(`end:${label}`);
          resolve();
        }),
      );
    });
    const { result } = renderHook(() => useAddQueue(run, () => {}));

    act(() => {
      result.current.enqueue("one");
      result.current.enqueue("two");
      result.current.enqueue("three");
    });
    expect(result.current.pending).toBe(3);
    // Only the first has started — the rest wait their turn.
    await waitFor(() => expect(order).toEqual(["start:one"]));

    await act(async () => gates[0]());
    await waitFor(() => expect(order).toEqual(["start:one", "end:one", "start:two"]));

    await act(async () => gates[1]());
    await act(async () => gates[2]());
    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two", "start:three", "end:three"]);
  });

  test("a failure surfaces via onError with its label and does not block later adds", async () => {
    const failed: string[] = [];
    const run = vi.fn((label: string) =>
      label === "bad" ? Promise.reject(new Error("boom")) : Promise.resolve(),
    );
    const { result } = renderHook(() =>
      useAddQueue(run, (label) => failed.push(label)),
    );
    act(() => {
      result.current.enqueue("good1");
      result.current.enqueue("bad");
      result.current.enqueue("good2");
    });
    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(failed).toEqual(["bad"]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith("good2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/use-add-queue.test.tsx`
Expected: FAIL — module `../src/hooks/use-add-queue` does not exist.

- [ ] **Step 3: Implement the hook**

Create `app/src/hooks/use-add-queue.ts`:

```ts
import { useCallback, useRef, useState } from "react";

/** Serial FIFO for add-record submissions. Every enqueued label is attempted
 *  in order; a failure surfaces through onError (with the lost label) instead
 *  of being dropped, and never blocks the labels behind it. `pending` drives
 *  the submit button's spinner. */
export function useAddQueue(
  run: (label: string) => Promise<void>,
  onError: (label: string, err: unknown) => void,
): { enqueue: (label: string) => void; pending: number } {
  const [pending, setPending] = useState(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const runRef = useRef(run);
  runRef.current = run;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const enqueue = useCallback((label: string) => {
    setPending((n) => n + 1);
    chain.current = chain.current.then(async () => {
      try {
        await runRef.current(label);
      } catch (err) {
        onErrorRef.current(label, err);
      } finally {
        setPending((n) => n - 1);
      }
    });
  }, []);

  return { enqueue, pending };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/use-add-queue.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into RecordsBody**

In `app/src/components/TablePane.tsx`, RecordsBody:

Remove the `busy` state (`const [busy, setBusy] = useState(false);` — find it near the other RecordsBody state) and replace `add()` (:424-441) with:

```tsx
  const addQueue = useAddQueue(
    async (label) => {
      await addCanonical(activeId, label);
      undo.push({
        label: `add "${label}"`,
        surface: "Records",
        apply: () => addCanonical(activeId, label),
        inverse: () => {
          const addedKey = slug(label);
          const v = getCanonical(activeId, addedKey)?.version ?? 1;
          return retireCanonical(activeId, addedKey, v).then(() => undefined);
        },
      });
    },
    (label, err) => {
      toast(
        `Couldn't add "${label}" — ${err instanceof Error ? err.message : "please try again"}`,
        "error",
      );
    },
  );

  const add = () => {
    const label = draft.trim();
    if (!label) return;
    setDraft("");
    addQueue.enqueue(label);
  };
```

Add imports: `import { useAddQueue } from "../hooks/use-add-queue";` and ensure `toast` is imported from `./Toast` (TablePane already imports it — verify).

In the JSX (:1230-1251), update the Button props:

```tsx
  disabled={!draft.trim()}
  loading={addQueue.pending > 0}
```

(The `busy` guard is gone on purpose — queued submissions are the fix. The undo `push` body, `slug`, `getCanonical`, `retireCanonical` calls are exactly the pre-existing ones, relocated.)

- [ ] **Step 6: Full suite + typecheck**

Run: `cd app && npm test && npm run typecheck`
Expected: green. There is no component-level test for RecordsBody (its harness is known-untestable in jsdom — `tablepane-conflict.test.tsx` documents this); the hook test is the unit gate and the controller runs a live browser check after all tasks.

- [ ] **Step 7: Commit**

```bash
git add app/src/hooks/use-add-queue.ts app/src/components/TablePane.tsx app/test/use-add-queue.test.tsx
git commit -m "fix(tables): rapid record adds queue instead of dropping — failures toast the lost label

Submitting while an add was in flight silently no-oped, and a rejected add
wedged the form (busy never reset). Adds now flow through a serial FIFO
(useAddQueue): every submission runs in order, failures surface with the
exact label that didn't save, and the input clears immediately.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DjP13yuXXqX2aktep2MPnz"
```

---

### Task 3: Layout saves survive page unload and surface failures

`setGridLayout` (store.ts:1064-1082) debounces 400ms then fires a fire-and-forget PATCH with no `keepalive` — closing the tab (or the browser killing the fetch on unload) loses the layout, observed as `net::ERR_ABORTED`. Failures are invisible.

**Files:**
- Modify: `app/src/store.ts` (:1064-1082, the `setGridLayout` timer body)
- Test: `app/test/grid-layout-save.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `writeFailed()` path (a failed PATCH now also flips the pill — no extra wiring needed since the call goes through `api()`).

- [ ] **Step 1: Write the failing test**

Create `app/test/grid-layout-save.test.ts`:

```ts
import { describe, test, expect, vi, afterEach } from "vitest";

vi.mock("../src/components/Toast", () => ({ toast: vi.fn() }));

describe("setGridLayout persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("PATCH goes out with keepalive so it survives page unload", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      }),
    );
    const { setGridLayout } = await import("../src/store");
    setGridLayout("brand", { widths: { label: 240 } });
    await vi.advanceTimersByTimeAsync(500);
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.url).toContain("/grid-layout/brand");
    expect(patch!.init!.keepalive).toBe(true);
  });

  test("a failed layout save raises an error toast", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PATCH"
          ? new Response("boom", { status: 500 })
          : new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const { toast } = await import("../src/components/Toast");
    const { setGridLayout } = await import("../src/store");
    setGridLayout("brand", { hidden: ["rank"] });
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("layout"), "error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/grid-layout-save.test.ts`
Expected: FAIL — `keepalive` is undefined on the PATCH init; no toast fired on failure.

- [ ] **Step 3: Implement**

In `app/src/store.ts` `setGridLayout` (:1064-1082), change the timer body's fetch call:

```ts
      void api(`/grid-layout/${encodeURIComponent(dimId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {
        toast("Couldn't save the table layout — recent column changes may not stick.", "error");
      });
```

Add the import at the top of store.ts: `import { toast } from "./components/Toast";`
(Toast is an imperative pub/sub singleton with no store dependencies — no import cycle. If ESLint or the module graph complains about a cycle, report BLOCKED rather than restructuring.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/grid-layout-save.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `cd app && npm test && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add app/src/store.ts app/test/grid-layout-save.test.ts
git commit -m "fix(grid): layout saves survive page unload and surface failures

The debounced grid-layout PATCH was fire-and-forget with no keepalive:
navigating or closing the tab within ~400ms of a column change killed the
request (ERR_ABORTED) and the hide/resize/reorder silently reverted next
session. keepalive:true lets the browser finish the request on unload;
in-app failures now raise an error toast (and the failed sync pill, via
the shared write path).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DjP13yuXXqX2aktep2MPnz"
```

---

### Task 4: Filtered-out grid says "no matches", not "no records yet"

When the FilterBar excludes every row, DataGrid renders the host's `empty` node — TablePane's copy is "no records yet — import from a source above, or add one below", which implies the data is gone. DataGrid knows the difference: `rows.length > 0` but `filteredRows.length === 0`.

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx` (the `empty={empty}` pass-through at ~:1461; `filterSet` state is :194, `filteredRows` :207)
- Test: `app/test/datagrid-filtered-empty.test.tsx` (new)

**Interfaces:**
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

Create `app/test/datagrid-filtered-empty.test.tsx`:

```tsx
import { describe, test, expect } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

/**
 * Filter-aware empty state: when the FilterBar excludes every row the grid
 * must say records exist but are filtered out (with a one-click clear), not
 * render the host's "table is empty" node. Filter is applied through the
 * real UI: right-click → "Filter to value", then edit the FilterBar's value
 * input to something that matches nothing.
 */

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [
  { id: "a", name: "Acme" },
  { id: "b", name: "Bravo" },
];
const columns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

function renderGrid() {
  return render(
    <UndoStackProvider>
      <DataGrid
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        onCommit={async () => {}}
        empty={<div data-testid="host-empty">no records yet</div>}
      />
    </UndoStackProvider>,
  );
}

function cellByText(container: HTMLElement, text: string): HTMLElement {
  const cells = Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  const cell = cells.find((c) => c.textContent?.includes(text));
  if (!cell) throw new Error(`No gridcell containing "${text}"`);
  return cell;
}

describe("filter-aware empty state", () => {
  test("no matches shows the filtered message + clear; host empty stays for truly empty tables", async () => {
    const { container } = renderGrid();

    // Apply a real filter via the context menu on the "Acme" cell.
    act(() => {
      fireEvent.contextMenu(cellByText(container, "Acme"));
    });
    const filterItem = await screen.findByText(/filter to value/i);
    act(() => {
      fireEvent.click(filterItem);
    });

    // FilterBar is up, filtering to "Acme" — Bravo is out, Acme still visible.
    expect(cellByText(container, "Acme")).toBeInTheDocument();

    // Edit the FilterBar value input to something that matches nothing.
    const valueInput = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (i) => i.value === "Acme",
    );
    expect(valueInput).toBeDefined();
    act(() => {
      fireEvent.change(valueInput!, { target: { value: "zzz-no-match" } });
    });

    // Filtered-empty state, NOT the host empty node.
    expect(await screen.findByText(/no records match/i)).toBeInTheDocument();
    expect(screen.queryByTestId("host-empty")).not.toBeInTheDocument();

    // One-click clear restores the rows.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    });
    expect(cellByText(container, "Bravo")).toBeInTheDocument();
  });

  test("a truly empty table still renders the host empty node", () => {
    render(
      <UndoStackProvider>
        <DataGrid
          rows={[]}
          columns={columns}
          rowKey={(r: Row) => r.id}
          onCommit={async () => {}}
          empty={<div data-testid="host-empty">no records yet</div>}
        />
      </UndoStackProvider>,
    );
    expect(screen.getByTestId("host-empty")).toBeInTheDocument();
  });
});
```

(If the context-menu item's label differs from "Filter to value" on this branch, use the actual label — check `app/test/datagrid-context-menu.test.tsx` for the established way to open and click it, and mirror that. Do not weaken the assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/datagrid-filtered-empty.test.tsx`
Expected: first test FAILS — the host-empty node renders when the filter matches nothing. Second test passes.

- [ ] **Step 3: Implement**

In `app/src/components/datagrid/DataGrid.tsx`, at the `empty={empty}` pass-through (~:1461), replace with:

```tsx
          empty={
            rows.length > 0 && filterSet && filterSet.conditions.length > 0 ? (
              <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">
                <div>No records match the current filters.</div>
                <button
                  type="button"
                  onClick={() => setFilterSet(null)}
                  className="mt-2 text-accent underline-offset-2 hover:underline"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              empty
            )
          }
```

(`rows` here is the host-supplied prop — nonzero means the table has records and only the filter hid them.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/datagrid-filtered-empty.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `cd app && npm test && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx app/test/datagrid-filtered-empty.test.tsx
git commit -m "fix(grid): filtered-out table says 'no records match', not 'no records yet'

Filtering every row out rendered the host's empty-table node, implying
the data was gone. The grid now distinguishes: records exist but the
filters excluded them — with a one-click 'Clear filters'.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DjP13yuXXqX2aktep2MPnz"
```

---

### Task 5: Number fields reject invalid input instead of nulling it

NumberCell's editor commits `null` for anything `Number()` can't parse (`commitNow`, NumberCell.tsx:138-155) — typing `abc` into a number field silently erases the value. DateCell already has the right convention: invalid input → `cancel()` (revert, keep the old value).

**Files:**
- Modify: `app/src/components/datagrid/cells/NumberCell.tsx` (:138-155, `commitNow`)
- Test: `app/test/datagrid-number-editor.test.tsx` (new)

**Interfaces:**
- Consumes: nothing from other tasks. `cancel` is already destructured in the Editor signature (NumberCell.tsx:104).

- [ ] **Step 1: Write the failing test**

Create `app/test/datagrid-number-editor.test.tsx`:

```tsx
import { describe, test, expect, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  amount: number | null;
}
const columns: ColumnDef<Row>[] = [
  { field: "amount", label: "Amount", config: { type: "number" }, editable: true },
];

function setup(onCommit: (rk: string, field: string, value: unknown) => Promise<void>) {
  const rows: Row[] = [{ id: "r1", amount: 42 }];
  return render(
    <UndoStackProvider>
      <DataGrid rows={rows} columns={columns} rowKey={(r) => r.id} onCommit={onCommit} />
    </UndoStackProvider>,
  );
}

function openEditor(container: HTMLElement): HTMLInputElement {
  const cell = container.querySelector<HTMLElement>('[role="gridcell"]');
  if (!cell) throw new Error("no gridcell");
  act(() => {
    fireEvent.pointerDown(cell, { button: 0, bubbles: true, cancelable: true });
    fireEvent.pointerUp(cell, { button: 0, bubbles: true });
  });
  act(() => {
    fireEvent.doubleClick(cell);
  });
  const input = cell.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("editor input did not open");
  return input;
}

describe("NumberCell editor validation", () => {
  test("invalid text cancels the edit — no commit, value preserved", () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const input = openEditor(container);
    act(() => {
      fireEvent.change(input, { target: { value: "abc" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("42");
  });

  test("valid number commits", () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const input = openEditor(container);
    act(() => {
      fireEvent.change(input, { target: { value: "7" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onCommit).toHaveBeenCalledWith("r1", "amount", 7);
  });

  test("clearing to empty commits null (clearing a value is legitimate)", () => {
    const onCommit = vi.fn(async () => {});
    const { container } = setup(onCommit);
    const input = openEditor(container);
    act(() => {
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onCommit).toHaveBeenCalledWith("r1", "amount", null);
  });
});
```

(If `onCommit`'s call signature in DataGrid differs — e.g. it receives `(rowKey, field, value)` via an adapter — mirror how `app/test/datagrid-nav.test.tsx` asserts commits and adjust the expectation form, not the behavior under test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/datagrid-number-editor.test.tsx`
Expected: the "invalid text" test FAILS — `onCommit` IS called (with null) today. The other two pass.

- [ ] **Step 3: Implement**

In `app/src/components/datagrid/cells/NumberCell.tsx`, replace `commitNow` (:138-155):

```ts
  const commitNow = () => {
    const t = v.trim();
    if (t === "") {
      commit(null);
      return;
    }
    if (isDuration) {
      const secs = hmsToSeconds(t);
      if (secs == null) {
        cancel();
        return;
      }
      commit(secs);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) {
      cancel();
      return;
    }
    // Percent editor works in display space (0–100); store normalized (0–1)
    commit(isPercent ? n / 100 : n);
  };
```

(Same convention as DateCell.tsx:160-177: invalid input reverts the cell instead of destroying the stored value. Empty still means "clear".)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/datagrid-number-editor.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `cd app && npm test && npm run typecheck`
Expected: green (watch `number-format.test.ts` in particular).

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/cells/NumberCell.tsx app/test/datagrid-number-editor.test.tsx
git commit -m "fix(grid): number fields reject invalid input instead of erasing the value

Typing non-numeric text into a number cell committed null, silently
destroying the stored value. Invalid input now cancels the edit (the
DateCell convention); clearing to empty still stores null.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DjP13yuXXqX2aktep2MPnz"
```

---

## Out of scope for this plan (deliberately)

- Delete-table (audit item 1.7): needs a product decision (delete vs archive, warehouse DDL semantics).
- Presence cursor rowKey publishing (1.8) and grid a11y (1.9): next wave.
- Per-cell retry affordance on failed saves: the failed pill + cell revert covers the trust gap; retry UX is Phase 1 polish.

## Verification after all tasks (controller-run)

Live probe against a dev server in this worktree: (1) block a PUT via route interception, edit a cell → pill shows "Save failed", never "Saved"; (2) type three records fast into add-record → all three POSTs fire serially (or fail with a toast naming the label); (3) change a column width, close the page within 400ms → PATCH carries keepalive; (4) filter brand to nonsense → "No records match the current filters." + working Clear; (5) type `abc` into a number cell → value survives.
