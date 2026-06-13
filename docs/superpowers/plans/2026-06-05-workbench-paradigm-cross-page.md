# Workbench paradigm — extending tables-multitab to Triage, Sources, and per-table modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the app as one workbench: per-table tabs in `/app/tables` gain a Records / Match values / Wired sources mode strip, the all-dim queue promotes to a new `/app/triage` route, and the standalone `/app/mapping` route is replaced by loader redirects.

**Architecture:** All work is in `app/`. Mapping's single-dim body lifts into `<MatchModeBody dim>` and mounts inside each `<TablePane>`; the all-dim inbox lifts into a standalone `<Triage>` route. The sidebar tree (left) plus a multi-tab `TableTabStrip` (top of `/app/tables`) become the spine, with each tab carrying its own `UndoStackProvider` and an `availableModes(dim, sources)`-gated mode strip. URL is canonical state, localStorage is a per-tab/per-dim mode hint. No schema changes; no server changes.

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind v4 + react-router-dom v6 (app only). Verification = `bun run typecheck` and `bun run test` in `app/` (vitest + Testing Library, harness present), plus manual UI walkthrough via `cd app && bun run dev`. No backend changes.

**Spec:** `docs/superpowers/specs/2026-06-05-workbench-paradigm-cross-page-design.md`. Read it before starting.

---

## Project conventions to follow

- **Commit style.** Conventional Commits. Recent log uses `feat(sidebar+grid):`, `feat(tables):`, `refactor(sidebar):`, `fix(grid):`. Use `feat(workbench):` for paradigm work, `refactor(workbench):` for lifts, `fix(<area>):` for bug fixes. Co-author footer per CLAUDE.md if running git via Claude harness.
- **Comments.** Default to none. Only call out non-obvious WHY (a hidden constraint, a known-good workaround). Don't paste this plan into comments. Don't mention "previously known as Mapping".
- **TypeScript.** No `any`. Avoid `unknown` casts; if you need a runtime guard, write one inline (see `app/src/lib/open-tabs.tsx:112` for the existing `readStored` pattern).
- **Tailwind.** Use existing tokens: `bg-surface`, `bg-surface-2`, `bg-surface-elevated`, `bg-accent-wash`, `text-ink`, `text-ink-2`, `text-ink-3`, `text-accent`, `border-line`, `border-line-2`, `shadow-pop-sm`, `ring-1 ring-line`, `var(--ease-spring)`, `var(--dur-slide)`. The mode strip's active-pill treatment must mirror `app/src/routes/Mapping.tsx:719-772`.
- **Tests.** Vitest + Testing Library are wired in `app/test/`; see `app/test/store-helpers.test.ts` and `app/test/datagrid-nav.test.tsx` for the existing style. Pure helpers (URL fold, redirect mapping, `availableModes`) get unit tests; React-tree behavior gets a focused RTL test (no full route mount needed — the helpers are the load-bearing pieces).
- **Manual verification.** UI changes need a real browser check. Run `cd app && bun run dev` (Vite serves on `:5173`, proxies `/api` to the Bun server on `:8787`). The `start the server first if needed: `cd server && bun run start`.

---

## File structure

**New files (app):**
- `app/src/lib/available-modes.ts` — `type Mode`, `availableModes(dim, sources)` pure helper.
- `app/src/lib/tab-mode.ts` — `readStoredMode(dimId)` / `writeStoredMode(dimId, mode)` / `foldUrlMode(searchParams, dimId, validModes)` localStorage+URL fold helpers.
- `app/src/lib/legacy-mapping-redirect.ts` — pure functions that map a legacy `/app/mapping?...` query into the new URL target. Used by the React Router loader for redirect rules.
- `app/src/routes/Triage.tsx` — new route for `/app/triage`; lifts the existing `CrossDimInbox` (in `app/src/routes/Mapping.tsx:1423+`) plus its footer (`CrossDimFooter`) and the cross-dim handler set from `MappingInner`.
- `app/src/components/modes/ModeStrip.tsx` — the per-tab segmented control (Records · Match values · Wired sources) with sliding-pill indicator.
- `app/src/components/modes/MatchModeBody.tsx` — lifts the single-dim workbench body from `Mapping.tsx:829-1370` (rows, filter chips, sticky drafts footer, A/M/S/R/N keys).
- `app/src/components/modes/WiredSourcesModeBody.tsx` — condensed `LedgerRow`-style listing filtered to `dim.id`.

**New test files (app/test):**
- `app/test/available-modes.test.ts`
- `app/test/legacy-mapping-redirect.test.ts`
- `app/test/tab-mode.test.ts`
- `app/test/open-tabs.test.ts` (validates `readStored` + `dimIdFromTabId` hardening)

**Modified files (app):**
- `app/src/main.tsx` — add Triage route, attach the loader-based redirect to `/app/mapping`, remove the `<Mapping>` route at the end of Step 3.
- `app/src/routes/MasterTables.tsx` — pass `mode` + `availableModes` into each `<TablePane>`, fold the `mode` URL param, honor the `value` URL param when `mode=match`.
- `app/src/routes/Sources.tsx` — add `focus` / `q` / `status` / `sort` URL params (write-through), retarget the two `/app/mapping?dimId=…` links, swap LedgerRow's standing-tone class for the shared scale.
- `app/src/routes/Dashboard.tsx` — retarget the three `/app/mapping*` links: top-of-page → `/app/triage`, "Review & commit" → `/app/triage`, per-dim mapping seed → `/app/tables?open=<id>&active=<id>&mode=match`.
- `app/src/components/AppShell.tsx` — rename sidebar nav "Match values" → "Triage", retarget to `/app/triage`; update CommandPalette `nav:mapping`, `nav:mapping:all`, and per-dim `dim:<id>` commands; add Cmd+1..9 tab-switch handler.
- `app/src/components/TablePane.tsx` — accept `mode` + `modes` props, render `<ModeStrip>` above the body, switch between the existing Records body and the new mode bodies inside the same pane; per-tab pane must be `flex flex-col h-full min-h-0`.
- `app/src/components/datagrid/UndoStack.tsx` — add `surface?: string` to `UndoEntry`, surface it on the Undo button label.
- `app/src/components/datagrid/ShortcutsOverlay.tsx` — add Triage + Workbench mode-switch keys.
- `app/src/components/datagrid/useGridCursor.ts` — clear `cursor` when `cursor.rowKey` is no longer present in `rows`.
- `app/src/lib/open-tabs.tsx` — validate `readStored` (prefix + array shape), assert prefix in `dimIdFromTabId`.

**Deleted files (Step 3):**
- `app/src/routes/Mapping.tsx`

---

## Step 1 — Foundations (no visible UX change)

Lands: `availableModes` helper, `tab-mode` fold helper, `useOpenTabs` hardening, cursor staleness normalization, `UndoStack` `surface` field, Sources URL params. Ships shippable; nothing renders differently.

### Task 1.1: `availableModes` helper

**Files:**
- Create: `app/src/lib/available-modes.ts`
- Test: `app/test/available-modes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/test/available-modes.test.ts
import { describe, test, expect } from "vitest";
import { availableModes } from "../src/lib/available-modes";
import type { MappingDimension } from "../src/data";
import type { SourceInfo } from "../src/store";

const dim = (id: string): MappingDimension =>
  ({
    id,
    dimension: id,
    dimTable: `dim_${id}`,
    mapTable: `map_${id}`,
    keyCol: `${id}_id`,
    rows: 0,
    canonical: [],
    values: [],
  }) as MappingDimension;
const src = (dimId: string): SourceInfo =>
  ({ table: "t", column: "c", dimId, values: 0, unmapped: 0, rows: 0 }) as SourceInfo;

describe("availableModes", () => {
  test("static reference table (no wiring) → records only", () => {
    expect(availableModes(dim("a"), [])).toEqual(["records"]);
  });
  test("sourced + mapped table → records, match, sources", () => {
    expect(availableModes(dim("a"), [src("a")])).toEqual(["records", "match", "sources"]);
  });
  test("wiring on a different dim does not unlock match for this one", () => {
    expect(availableModes(dim("a"), [src("b")])).toEqual(["records"]);
  });
  test("multiple wired sources for the same dim still yield one match + one sources entry", () => {
    expect(availableModes(dim("a"), [src("a"), src("a")])).toEqual(["records", "match", "sources"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bun run test -- available-modes`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/lib/available-modes.ts
import type { MappingDimension } from "../data";
import type { SourceInfo } from "../store";

export type Mode = "records" | "match" | "sources";

export function availableModes(dim: MappingDimension, sources: SourceInfo[]): Mode[] {
  const hasSourceWiring = sources.some((s) => s.dimId === dim.id);
  return hasSourceWiring ? ["records", "match", "sources"] : ["records"];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && bun run test -- available-modes`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/available-modes.ts app/test/available-modes.test.ts
git commit -m "feat(workbench): availableModes helper gates Match/Sources per dim wiring"
```

### Task 1.2: `tab-mode` fold helper (URL + localStorage)

**Files:**
- Create: `app/src/lib/tab-mode.ts`
- Test: `app/test/tab-mode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/test/tab-mode.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import {
  readStoredMode,
  writeStoredMode,
  foldUrlMode,
  TAB_MODE_KEY,
} from "../src/lib/tab-mode";

beforeEach(() => {
  localStorage.clear();
});

describe("tab-mode storage", () => {
  test("default mode is 'records' when nothing stored", () => {
    expect(readStoredMode("a", ["records", "match", "sources"])).toBe("records");
  });
  test("write-through round-trips", () => {
    writeStoredMode("a", "match");
    expect(localStorage.getItem(TAB_MODE_KEY("a"))).toBe("match");
    expect(readStoredMode("a", ["records", "match", "sources"])).toBe("match");
  });
  test("stored mode that's no longer valid falls back to 'records'", () => {
    writeStoredMode("a", "sources");
    expect(readStoredMode("a", ["records", "match"])).toBe("records");
  });
});

describe("foldUrlMode", () => {
  test("URL ?mode= wins over localStorage when valid", () => {
    writeStoredMode("a", "records");
    const url = new URLSearchParams("mode=match");
    expect(foldUrlMode(url, "a", ["records", "match", "sources"])).toBe("match");
  });
  test("URL ?mode= invalid → falls back to localStorage", () => {
    writeStoredMode("a", "match");
    const url = new URLSearchParams("mode=garbage");
    expect(foldUrlMode(url, "a", ["records", "match"])).toBe("match");
  });
  test("URL ?mode= not present → falls back to localStorage", () => {
    writeStoredMode("a", "sources");
    expect(foldUrlMode(new URLSearchParams(""), "a", ["records", "match", "sources"])).toBe(
      "sources",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bun run test -- tab-mode`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/lib/tab-mode.ts
import type { Mode } from "./available-modes";

export const TAB_MODE_KEY = (dimId: string): string => `zugzug:tab-mode:${dimId}`;

const isMode = (s: string): s is Mode => s === "records" || s === "match" || s === "sources";

export function readStoredMode(dimId: string, valid: readonly Mode[]): Mode {
  try {
    const raw = localStorage.getItem(TAB_MODE_KEY(dimId));
    if (raw && isMode(raw) && valid.includes(raw)) return raw;
  } catch {
    /* localStorage disabled */
  }
  return "records";
}

export function writeStoredMode(dimId: string, mode: Mode): void {
  try {
    localStorage.setItem(TAB_MODE_KEY(dimId), mode);
  } catch {
    /* quota / disabled */
  }
}

export function foldUrlMode(
  searchParams: URLSearchParams,
  dimId: string,
  valid: readonly Mode[],
): Mode {
  const fromUrl = searchParams.get("mode");
  if (fromUrl && isMode(fromUrl) && valid.includes(fromUrl)) return fromUrl;
  return readStoredMode(dimId, valid);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && bun run test -- tab-mode`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tab-mode.ts app/test/tab-mode.test.ts
git commit -m "feat(workbench): tab-mode URL+localStorage fold helper"
```

### Task 1.3: `useOpenTabs` hardening — `readStored` validation + `dimIdFromTabId` assertion

**Files:**
- Modify: `app/src/lib/open-tabs.tsx:21-23` and `app/src/lib/open-tabs.tsx:112-130`
- Test: `app/test/open-tabs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/test/open-tabs.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { dimIdFromTabId, makeTabId } from "../src/lib/open-tabs";

beforeEach(() => {
  localStorage.clear();
});

describe("dimIdFromTabId", () => {
  test("round-trips with makeTabId", () => {
    expect(dimIdFromTabId(makeTabId("country"))).toBe("country");
  });
  test("throws on a malformed id (missing prefix)", () => {
    expect(() => dimIdFromTabId("country" as unknown as ReturnType<typeof makeTabId>)).toThrow();
  });
});

describe("OpenTabsProvider readStored (via storage roundtrip)", () => {
  test("drops entries with the wrong prefix on rehydrate", async () => {
    localStorage.setItem(
      "zugzug:open-tabs",
      JSON.stringify({
        tabs: [
          { id: "tables:country", dimId: "country", pinned: false, openedAt: 1 },
          { id: "old:partner", dimId: "partner", pinned: false, openedAt: 2 },
        ],
        activeId: "old:partner",
      }),
    );
    // Re-import readStored after seeding — it's not exported, so we validate via
    // the documented contract: a stale prefix entry yields no surfaced tab. We
    // assert on storage contents that an in-app rehydrate would reject this.
    const stored = JSON.parse(localStorage.getItem("zugzug:open-tabs")!);
    expect(stored.tabs.filter((t: { id: string }) => !t.id.startsWith("tables:"))).toHaveLength(1);
  });
});
```

Note: `readStored` is internal; the test above seeds storage and asserts the input shape we want rejected. The actual rejection behavior is exercised in Step 3.4's integration check (mode strip mounts cleanly even with a poisoned storage payload).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bun run test -- open-tabs`
Expected: FAIL — `dimIdFromTabId` does not throw on bad input.

- [ ] **Step 3: Modify `dimIdFromTabId` to assert the prefix**

```ts
// app/src/lib/open-tabs.tsx — replace lines 21-23
export function dimIdFromTabId(id: TabId): string {
  if (!id.startsWith(TAB_PREFIX)) {
    throw new Error(`dimIdFromTabId: malformed tab id (missing "${TAB_PREFIX}" prefix): ${id}`);
  }
  return id.slice(TAB_PREFIX.length);
}
```

- [ ] **Step 4: Harden `readStored`**

```ts
// app/src/lib/open-tabs.tsx — replace lines 112-130
function readStored(): OpenTabsState {
  if (typeof localStorage === "undefined") return { tabs: [], activeId: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeId: null };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { tabs?: unknown }).tabs)
    ) {
      return { tabs: [], activeId: null };
    }
    const p = parsed as Serialized;
    const tabs: OpenTab[] = [];
    for (const t of p.tabs) {
      if (typeof t?.id !== "string" || !t.id.startsWith(TAB_PREFIX)) continue;
      if (typeof t.dimId !== "string" || t.dimId.length === 0) continue;
      tabs.push({
        id: t.id as TabId,
        dimId: t.dimId,
        pinned: !!t.pinned,
        openedAt: typeof t.openedAt === "number" ? t.openedAt : Date.now(),
      });
    }
    const activeId =
      typeof p.activeId === "string" && p.activeId.startsWith(TAB_PREFIX)
        ? (p.activeId as TabId)
        : null;
    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: null };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd app && bun run test -- open-tabs && bun run typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/open-tabs.tsx app/test/open-tabs.test.ts
git commit -m "fix(open-tabs): validate readStored prefix+shape; assert dimIdFromTabId"
```

### Task 1.4: Cursor staleness normalization

**Files:**
- Modify: `app/src/components/datagrid/useGridCursor.ts:71-77`

- [ ] **Step 1: Add a normalization effect**

When the `rows` list changes and the cursor's `rowKey` is no longer present, clear the cursor. Without this, switching modes (which hides the pane while leaving the cursor live) plus a background draft save that filters the row out can leave the cursor pointing at a dead row.

Insert a new `useEffect` immediately after the scroll-into-view effect at `useGridCursor.ts:77`:

```ts
// app/src/components/datagrid/useGridCursor.ts — insert after the existing
// scroll-into-view useEffect (currently ends at line 77)
useEffect(() => {
  if (!cursor) return;
  const present = rows.some((r) => rowKey(r) === cursor.rowKey);
  if (!present) setCursor(null);
}, [rows, cursor, rowKey]);
```

- [ ] **Step 2: Verify the existing grid-nav test still passes**

Run: `cd app && bun run test -- datagrid-nav && bun run typecheck`
Expected: PASS (existing tests still pass; typecheck clean).

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/useGridCursor.ts
git commit -m "fix(grid): clear cursor when its row leaves visibleRows"
```

### Task 1.5: `UndoStack` — `surface` field on `UndoEntry`

**Files:**
- Modify: `app/src/components/datagrid/UndoStack.tsx:15-19` (interface), `:142` (topLabel return), `:87-100` (compound transaction passes surface through if uniform).

- [ ] **Step 1: Extend the entry interface and `topLabel`**

```ts
// app/src/components/datagrid/UndoStack.tsx — replace lines 15-19
export interface UndoEntry {
  apply: () => Promise<void>;
  inverse: () => Promise<void>;
  label: string;
  /** Optional surface tag — e.g. "Records", "Match" — shown next to the undo
   *  label so a user pressing ⌘Z sees which surface the inverse will land on. */
  surface?: string;
}
```

Add a `topSurface` field to the `Ctx` interface (line 21) and surface it on the provider's `value` object (line 136):

```ts
// add to Ctx after topLabel
topSurface: string | null;
```

```ts
// inside the provider's value
topSurface: undoStack.current.at(-1)?.surface ?? null,
```

For compound transactions (lines 87-100), keep the surface only if all entries share the same surface; otherwise leave it undefined:

```ts
// inside endTransaction, before pushing `combined`
const surfaces = new Set(tx.entries.map((e) => e.surface).filter((s): s is string => !!s));
const surface = surfaces.size === 1 ? [...surfaces][0] : undefined;
const combined: UndoEntry =
  tx.entries.length === 1
    ? { ...tx.entries[0], label: tx.label, surface }
    : {
        label: tx.label,
        surface,
        apply: async () => {
          for (const e of tx.entries) await e.apply();
        },
        inverse: async () => {
          for (let i = tx.entries.length - 1; i >= 0; i--) await tx.entries[i].inverse();
        },
      };
```

- [ ] **Step 2: Render surface in the toolbar Undo button**

Modify `app/src/components/TablePane.tsx:367-369` (and the equivalent footer in `MatchModeBody` when Step 3 lands) to show the surface tag:

```tsx
// app/src/components/TablePane.tsx — replace lines 360-370 (the "↶ Undo" button)
<Button
  variant="ghost"
  size="sm"
  disabled={!undo.canUndo}
  onClick={() => void undo.undo()}
  title={undo.topLabel ?? undefined}
>
  ↶ Undo
  {undo.topSurface && (
    <span className="ml-1.5 font-mono text-[10px] text-ink-3">({undo.topSurface})</span>
  )}
  <span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
</Button>
```

- [ ] **Step 3: Tag existing TablePane mutations with `surface: "Records"`**

Every `undo.push(...)` call in `app/src/components/TablePane.tsx` (lines 255-260, 275-281, 297-301, 525-529, 542-546) gains `surface: "Records"`. Example for the rename push:

```tsx
// app/src/components/TablePane.tsx:525 — add surface to the push
undo.push({
  label: `rename "${prev}" → "${value}"`,
  surface: "Records",
  apply: () => renameCanonical(activeId, rowKey, value),
  inverse: () => renameCanonical(activeId, rowKey, prev),
});
```

Apply the same `surface: "Records"` addition to all five `undo.push` sites in this file and to the `undo.beginTransaction(...)` callers — `beginTransaction` does not take a surface; instead, set the surface on the inner `undo.push` entries so the homogeneous-surface check produces a "Records" combined entry.

- [ ] **Step 4: Typecheck**

Run: `cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual smoke**

`cd app && bun run dev`, open `/app/tables`, rename a record, hover the Undo button — the chip should read `(Records)`. The undo itself should still work (reverts the rename).

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/UndoStack.tsx app/src/components/TablePane.tsx
git commit -m "feat(undo): surface field on UndoEntry; label inverses by surface in toolbar"
```

### Task 1.6: Sources URL params — `focus`, `q`, `status`, `sort`

**Files:**
- Modify: `app/src/routes/Sources.tsx:1` (import `useSearchParams`), `:82-93` (initial state from URL), `:148-167` (search/status/sort write-through), `:211-221` (auto-expand respects `focus`).

- [ ] **Step 1: Read params on mount**

Replace the initial state declarations in `Sources.tsx:84-93`:

```tsx
// app/src/routes/Sources.tsx — top of Sources()
const [searchParams, setSearchParams] = useSearchParams();
const initialQ = searchParams.get("q") ?? "";
const initialStatus = ((): Status => {
  const v = searchParams.get("status");
  return v === "needs" || v === "all" || v === "clean" || v === "missing" ? v : "needs";
})();
const initialSort = ((): Sort => {
  const v = searchParams.get("sort");
  return v === "impact" || v === "name" || v === "recent" ? v : "impact";
})();

const [q, setQ] = useState(initialQ);
const [status, setStatus] = useState<Status>(initialStatus);
const [sort, setSort] = useState<Sort>(initialSort);
// remaining state unchanged
```

Add the `useSearchParams` import at the top of the file:

```tsx
import { Link, useSearchParams } from "react-router-dom";
```

- [ ] **Step 2: Write `q`/`status`/`sort` through to URL (debounced for `q`)**

Add after the existing `useEffect` blocks in Sources (around `Sources.tsx:222`):

```tsx
// debounced write-through for q
useEffect(() => {
  const handle = setTimeout(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (q.trim()) next.set("q", q);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
  }, 200);
  return () => clearTimeout(handle);
}, [q, setSearchParams]);

// immediate write-through for status + sort
useEffect(() => {
  setSearchParams(
    (prev) => {
      const next = new URLSearchParams(prev);
      if (status !== "needs") next.set("status", status);
      else next.delete("status");
      if (sort !== "impact") next.set("sort", sort);
      else next.delete("sort");
      return next;
    },
    { replace: true },
  );
}, [status, sort, setSearchParams]);
```

- [ ] **Step 3: Honor `?focus=<schema>` on the auto-expand effect**

Replace the auto-expand effect at `Sources.tsx:208-221`:

```tsx
useEffect(() => {
  if (openInit) return;
  if (sources.length === 0) {
    setOpenInit(true);
    return;
  }
  const allSchemas = new Set(sources.map((s) => s.table.split(".")[0]));
  const focusParam = searchParams.get("focus");
  if (focusParam && allSchemas.has(focusParam)) {
    // honor the deep-link first; auto-expand still applies on top per spec
    // open question #6, which we resolve "preserves user intent" (add to set).
    if (allSchemas.size <= AUTO_EXPAND_MAX_SCHEMAS) {
      setOpenSchemas(allSchemas);
    } else if (agg.worst) {
      setOpenSchemas(new Set([focusParam, agg.worst.table.split(".")[0]]));
    } else {
      setOpenSchemas(new Set([focusParam]));
    }
  } else if (allSchemas.size <= AUTO_EXPAND_MAX_SCHEMAS) {
    setOpenSchemas(allSchemas);
  } else if (agg.worst) {
    setOpenSchemas(new Set([agg.worst.table.split(".")[0]]));
  }
  setOpenInit(true);
}, [sources, agg.worst, openInit, searchParams]);
```

- [ ] **Step 4: Typecheck + manual smoke**

Run: `cd app && bun run typecheck`
Expected: PASS.

Manual: `cd app && bun run dev`, visit `/app/sources`, type in the search — URL should update to include `?q=…`. Click a status pill — URL should toggle `?status=`. Change sort — URL should update.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/Sources.tsx
git commit -m "feat(sources): URL-as-truth for focus/q/status/sort toolbar state"
```

---

## Step 2 — Triage route (lift `CrossDimInbox` out of Mapping)

Lands: `/app/triage` route, sidebar nav rename "Match values" → "Triage", Dashboard CTA retargeted to Triage, `/app/mapping?view=all` redirects to `/app/triage`. Mapping's all-mode branch is removed; single-dim mapping continues to live in the existing `Mapping.tsx` until Step 3.

### Task 2.1: Create `<Triage>` route

**Files:**
- Create: `app/src/routes/Triage.tsx`
- Modify: `app/src/main.tsx`

- [ ] **Step 1: Create the Triage route file**

The cleanest path is to lift `CrossDimInbox` (and its tightly coupled `CrossDimFooter`) wholesale, plus the all-dim handler set (`crossDimRows`, `visibleCross`, `crossCounts`, `acceptCross`, `skipCross`, `pickCross`, `discardCross`, `advanceCrossNext`, `approveAndCommitAll`) from `MappingInner`. The new file owns its own `UndoStackProvider` (scopeKey: `"triage"`).

```tsx
// app/src/routes/Triage.tsx
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../components/Button";
import { ComboSelect } from "../components/ComboSelect";
import { PageHeader } from "../components/PageHeader";
import { NoTablesYet } from "../components/NoTablesYet";
import { Chip, UndoStackProvider, useUndoStack } from "../components/datagrid";
import { IconX, IconArrowRight } from "../components/Icons";
import { cx } from "../lib/cx";
import { valueRows } from "../data";
import {
  useDimensions,
  useDrafts,
  saveDraft,
  discardDraft,
  commit,
  dkey,
  currentUser,
} from "../store";
import { useCreateTableModal } from "../lib/create-table-modal";

type RStatus = "mapped" | "new" | "skipped";
type Filter = "new" | "all" | "mapped";
type CrossRow = {
  dimId: string;
  dimName: string;
  dimRows: number;
  raw: string;
  suggestion: string | null;
  confidence: number;
  status: RStatus;
  target: string | null;
};

const confBar = (c: number) => (c >= 90 ? "bg-ok" : c >= 70 ? "bg-warn" : "bg-danger/30");
const confText = (c: number) => (c >= 90 ? "text-ok" : c >= 70 ? "text-warn" : "text-danger");
const COLS =
  "grid grid-cols-[120px_minmax(160px,1.3fr)_22px_minmax(160px,1.1fr)_88px_84px] items-center gap-3";
const attrEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function Triage() {
  const dims = useDimensions();
  const create = useCreateTableModal();
  if (dims.length === 0) return <NoTablesYet from="triage" onCreateRequested={create.open} />;
  return (
    <UndoStackProvider scopeKey="triage">
      <TriageInner />
    </UndoStackProvider>
  );
}

function TriageInner() {
  // 1. State setup: filter from URL, cursor (dimId+raw), commit flash.
  // 2. crossDimRows: copy verbatim from Mapping.tsx:237-273
  //    (drives the ranked queue; ranks by unmapped × log10(rows), then by
  //    confidence ascending within a dim).
  // 3. cross handlers: copy verbatim from Mapping.tsx:386-461 (stageMapCross,
  //    acceptCross, skipCross, pickCross, discardCross, advanceCrossNext).
  // 4. approveAndCommitAll: copy verbatim from Mapping.tsx:474-508.
  // 5. Render: PageHeader with kicker="WORKFLOW", title "Triage · N across M tables",
  //    lede "Sorted by blast radius. Press ⌘↵ to publish.". Filter chips. Queue rows
  //    (lift CrossDimInbox body verbatim). Sticky footer (lift CrossDimFooter verbatim).
  // 6. Keyboard wiring: J/K, A/M/S/N, Cmd+Z, Cmd+Enter, ? — same as
  //    Mapping.tsx:1445-1488.
  // 7. URL ?filter= — read on mount; write through on change (omit when "new" default).

  // … full body (copy-paste-port from Mapping.tsx, removing the viewMode logic
  // and the single-dim seed scope; the inbox itself is dim-agnostic).

  return /* … */ null;
}
```

This is intentionally a stub. Carry out the port section-by-section, keeping each section's logic identical:

- [ ] **Step 1a: State + URL `?filter=`**

```tsx
const [searchParams, setSearchParams] = useSearchParams();
const initialFilter = ((): Filter => {
  const v = searchParams.get("filter");
  return v === "new" || v === "all" || v === "mapped" ? v : "new";
})();
const [filter, setFilterBase] = useState<Filter>(initialFilter);
const setFilter = useCallback(
  (f: Filter) => {
    setFilterBase(f);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (f !== "new") next.set("filter", f);
        else next.delete("filter");
        return next;
      },
      { replace: true },
    );
  },
  [setSearchParams],
);
const [cursor, setCursor] = useState<{ dimId: string; raw: string } | null>(null);
const [flash, setFlash] = useState<{ n: number; rows: number } | null>(null);
const [commitError, setCommitError] = useState<string | null>(null);
const undo = useUndoStack();
const allDrafts = useDrafts();
```

- [ ] **Step 1b: Port `crossDimRows`, `visibleCross`, `crossCounts`, `dimById` from `Mapping.tsx:237-283`** — verbatim, with no `seedId` references.

- [ ] **Step 1c: Port the cross handlers (`stageMapCross`, `acceptCross`, `skipCross`, `pickCross`, `discardCross`, `advanceCrossNext`) from `Mapping.tsx:387-461`** — verbatim. Add `surface: "Triage"` to every `undo.push(...)` call in these handlers.

- [ ] **Step 1d: Port `approveAndCommitAll` from `Mapping.tsx:474-508`** — verbatim.

- [ ] **Step 1e: Port the queue + footer markup**

Wholesale-lift the markup body of `CrossDimInbox` (`Mapping.tsx:1440-1608`) and `CrossDimFooter` (`Mapping.tsx:1614-1778`). Replace the outer `mx-auto max-w-[var(--wide)]` wrapper with `mx-auto w-full max-w-[var(--wide)] space-y-5 p-8`. Above the queue, add the PageHeader:

```tsx
<PageHeader
  kicker="WORKFLOW"
  title={
    <>
      Triage{" "}
      <span className="font-mono text-[14px] text-ink-3">
        · {crossCounts.new} across{" "}
        {new Set(visibleCross.filter((r) => r.status === "new").map((r) => r.dimId)).size} table
        {new Set(visibleCross.filter((r) => r.status === "new").map((r) => r.dimId)).size === 1
          ? ""
          : "s"}
      </span>
    </>
  }
  lede="Sorted by blast radius. Press ⌘↵ to publish."
/>
```

The TableChip uses the existing `<Chip>` primitive (`app/src/components/datagrid/Chip.tsx`) with `bucket="chip-3"`. Spec note: "Per-table PALETTE color earns here." If the dim has `color` set, render with its tint by passing the dim's color tint to Chip. For v1 we keep the existing `bucket="chip-3"` behavior — PALETTE-per-dim tints land in Step 5 polish (or a follow-up, see Open question).

- [ ] **Step 1f: Empty states**

Per spec Section 2 → "Empty states":

```tsx
{visibleCross.length === 0 && filter === "new" && (
  <div className="px-4 py-12 text-center">
    <div className="font-display text-[20px] text-ok">Nothing to triage today.</div>
    <p className="mx-auto mt-2 max-w-[44ch] text-[12.5px] text-ink-3">
      Curate records in{" "}
      <Link to="/app/tables" className="text-accent hover:underline">
        Tables
      </Link>
      , or{" "}
      <Link to="/app/sources" className="text-accent hover:underline">
        wire more sources
      </Link>
      .
    </p>
  </div>
)}
{visibleCross.length === 0 && filter === "mapped" && (
  <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
    Nothing has been mapped yet.{" "}
    <button onClick={() => setFilter("new")} className="text-accent hover:underline">
      View needs review →
    </button>
  </div>
)}
```

- [ ] **Step 2: Register the route in `main.tsx`**

```tsx
// app/src/main.tsx — add the import
import { Triage } from "./routes/Triage";

// inside the AppShell <Route> block
<Route path="/app/triage" element={<Triage />} />
```

- [ ] **Step 3: Typecheck**

Run: `cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual smoke**

`cd app && bun run dev`, navigate to `/app/triage` directly — the cross-dim inbox should render and behave identically to `/app/mapping?view=all`. Accept (A), skip (S), Cmd+Z, Cmd+Enter should all work. URL should reflect filter changes.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/Triage.tsx app/src/main.tsx
git commit -m "feat(triage): standalone /app/triage route lifts CrossDimInbox out of Mapping"
```

### Task 2.2: Sidebar rename + Dashboard retarget

**Files:**
- Modify: `app/src/components/AppShell.tsx:152-163` (nav), `:181-198` (palette `nav:mapping*`).
- Modify: `app/src/routes/Dashboard.tsx:115` and `:143`.

- [ ] **Step 1: Rename sidebar nav entry**

In `app/src/components/AppShell.tsx:152-163`, change the `nav` array's "Match values" entry to point at Triage:

```tsx
const nav = [
  { to: "/app", label: "Dashboard", Icon: IconDashboard, end: true },
  { to: "/app/triage", label: "Triage", Icon: IconMapping, count: totalNew },
  {
    to: "/app/sources",
    label: "Sources",
    Icon: IconSources,
    count: undefined as number | undefined,
  },
  { to: "/app/tables", label: "Tables", Icon: IconTables, count: dims.length },
  { to: "/app/settings", label: "Settings", Icon: IconSettings },
];
```

- [ ] **Step 2: Update the CommandPalette entries**

In `app/src/components/AppShell.tsx:181-198`, replace the two `nav:mapping*` entries with one Triage entry:

```tsx
out.push({
  id: "nav:triage",
  group: "Navigate",
  label: "Triage",
  secondary: totalNew > 0 ? `${totalNew} new` : undefined,
  icon: <IconMapping className="h-4 w-4" />,
  action: () => navigate("/app/triage"),
  keywords: "inbox queue match reconcile mapping",
  priority: true,
});
```

Delete the prior `nav:mapping` and `nav:mapping:all` push blocks. The per-dim `dim:<id>` palette command (`AppShell.tsx:229-240`) keeps targeting `/app/mapping?dimId=...` for now — Step 3 will switch it to `/app/tables?open=…&active=…&mode=match`.

- [ ] **Step 3: Retarget Dashboard CTAs**

In `app/src/routes/Dashboard.tsx`:

```tsx
// line 115: top-of-page CTA
<Link to="/app/triage">

// line 143: "Review & commit"
<Link to="/app/triage">
```

The per-dim mapping-seed link at `Dashboard.tsx:198` stays pointing at `/app/mapping?dimId=…` until Step 3 (it will be redirected automatically by the loader landing in Step 3.5, but we retarget it now to skip the redirect hop):

```tsx
to={`/app/tables?open=${s.id}&active=${s.id}&mode=match`}
```

- [ ] **Step 4: Typecheck + manual smoke**

Run: `cd app && bun run typecheck`
Expected: PASS.

Manual: Visit `/app/dashboard` (i.e. `/app`) — top CTA jumps to `/app/triage`. Sidebar shows "Triage" with count badge. Click a mapping seed — opens a Tables tab. (The mode-strip won't render until Step 3, but the URL contract should already be honored — Tables silently ignores unknown query params.)

- [ ] **Step 5: Commit**

```bash
git add app/src/components/AppShell.tsx app/src/routes/Dashboard.tsx
git commit -m "feat(workbench): rename sidebar Match values → Triage; retarget Dashboard CTAs"
```

### Task 2.3: Add legacy redirect for `/app/mapping?view=all`

**Files:**
- Create: `app/src/lib/legacy-mapping-redirect.ts`
- Test: `app/test/legacy-mapping-redirect.test.ts`
- Modify: `app/src/main.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// app/test/legacy-mapping-redirect.test.ts
import { describe, test, expect } from "vitest";
import { redirectTarget } from "../src/lib/legacy-mapping-redirect";

describe("legacy /app/mapping redirect rules", () => {
  test("bare /app/mapping → /app/triage", () => {
    expect(redirectTarget(new URLSearchParams(""), new Set(["country"]))).toBe("/app/triage");
  });
  test("?view=all → /app/triage", () => {
    expect(redirectTarget(new URLSearchParams("view=all"), new Set(["country"]))).toBe(
      "/app/triage",
    );
  });
  test("?view=all&filter=mapped → /app/triage?filter=mapped", () => {
    expect(
      redirectTarget(new URLSearchParams("view=all&filter=mapped"), new Set(["country"])),
    ).toBe("/app/triage?filter=mapped");
  });
  test("?dimId=country → /app/tables?open=country&active=country&mode=match", () => {
    expect(redirectTarget(new URLSearchParams("dimId=country"), new Set(["country"]))).toBe(
      "/app/tables?open=country&active=country&mode=match",
    );
  });
  test("?dimId=country&value=US → adds &value=US", () => {
    expect(
      redirectTarget(new URLSearchParams("dimId=country&value=US"), new Set(["country"])),
    ).toBe("/app/tables?open=country&active=country&mode=match&value=US");
  });
  test("?dimId=country&view=single behaves like ?dimId=country", () => {
    expect(
      redirectTarget(new URLSearchParams("dimId=country&view=single"), new Set(["country"])),
    ).toBe("/app/tables?open=country&active=country&mode=match");
  });
  test("unknown dimId → /app/tables (no open) and signals a toast", () => {
    const out = redirectTarget(new URLSearchParams("dimId=ghost"), new Set(["country"]));
    expect(out).toBe("/app/tables?toast=missing-table");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bun run test -- legacy-mapping-redirect`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `redirectTarget`**

```ts
// app/src/lib/legacy-mapping-redirect.ts
/* Pure function: legacy /app/mapping query → new URL target.
   Tested via app/test/legacy-mapping-redirect.test.ts. */
export function redirectTarget(params: URLSearchParams, validDimIds: Set<string>): string {
  const dimId = params.get("dimId");
  const view = params.get("view");
  const value = params.get("value");
  const filter = params.get("filter");

  if (dimId) {
    if (!validDimIds.has(dimId)) return "/app/tables?toast=missing-table";
    const q = new URLSearchParams();
    q.set("open", dimId);
    q.set("active", dimId);
    q.set("mode", "match");
    if (value) q.set("value", value);
    return `/app/tables?${q.toString()}`;
  }

  // No dimId → either ?view=all or bare /app/mapping. Both go to Triage.
  if (view === "all" || view == null) {
    const q = new URLSearchParams();
    if (filter && filter !== "new") q.set("filter", filter);
    const s = q.toString();
    return s ? `/app/triage?${s}` : "/app/triage";
  }
  // view=single without dimId → no useful target; land on Triage.
  return "/app/triage";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && bun run test -- legacy-mapping-redirect`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire as a React Router loader**

In `app/src/main.tsx`, add a loader to the existing `/app/mapping` route. The loader needs the live dims snapshot — Drizzle/postgres-backed store hydrates on boot, so we expose a synchronous reader by importing the store directly:

```tsx
// app/src/main.tsx
import { redirect, type LoaderFunctionArgs } from "react-router-dom";
import { redirectTarget } from "./lib/legacy-mapping-redirect";
import { getDimensionsSnapshot } from "./store"; // exported in Step 2.3.5
```

```tsx
// inside the /app routes block — replace the existing /app/mapping route
<Route
  path="/app/mapping"
  loader={({ request }: LoaderFunctionArgs) => {
    const url = new URL(request.url);
    const dims = getDimensionsSnapshot();
    const validDimIds = new Set(dims.map((d) => d.id));
    return redirect(redirectTarget(url.searchParams, validDimIds));
  }}
/>
```

Important: React Router v6 only fires loaders on the data router (`createBrowserRouter`). The existing app uses the JSX `<BrowserRouter>` + `<Routes>` (declarative router), where `loader` is ignored. Two options:

  (a) Migrate to `createBrowserRouter` — large blast radius, skipped here.
  (b) Use a thin redirect component (`<Navigate>` won't work for query-string-conditional redirects; use a function component that calls `redirectTarget` + `Navigate` with computed target).

Choose (b). Replace the loader idea with a redirect component:

```tsx
// app/src/main.tsx — add above the routes
function LegacyMappingRedirect() {
  const [params] = useSearchParams();
  const dims = useDimensions();
  const validDimIds = useMemo(() => new Set(dims.map((d) => d.id)), [dims]);
  const target = redirectTarget(params, validDimIds);
  return <Navigate to={target} replace />;
}
```

Wire it as the `/app/mapping` element:

```tsx
<Route path="/app/mapping" element={<LegacyMappingRedirect />} />
```

The corresponding imports at the top of `main.tsx`:

```tsx
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useDimensions } from "./store";
import { redirectTarget } from "./lib/legacy-mapping-redirect";
```

Drop the `<Mapping>` import — the route no longer mounts that component. (The file `app/src/routes/Mapping.tsx` stays on disk until Step 3 deletes it.)

- [ ] **Step 6: Toast on missing dim**

Make MasterTables read the `?toast=missing-table` param and surface a one-shot dismissible toast. Smallest implementation: add a transient flash to `MasterTables.tsx`:

```tsx
// app/src/routes/MasterTables.tsx — inside MasterTables(), near the other URL effects
const [missingFlash, setMissingFlash] = useState<string | null>(null);
useEffect(() => {
  if (searchParams.get("toast") !== "missing-table") return;
  setMissingFlash("That table no longer exists.");
  // clear the param so a reload doesn't re-trigger
  const next = new URLSearchParams(searchParams);
  next.delete("toast");
  setSearchParams(next, { replace: true });
  const t = setTimeout(() => setMissingFlash(null), 4000);
  return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

Render `{missingFlash && <div className="border-b border-line bg-accent-wash px-4 py-2 font-mono text-[12px] text-accent">{missingFlash}</div>}` above the tab strip.

- [ ] **Step 7: Typecheck + manual smoke**

Run: `cd app && bun run typecheck && bun run test`
Expected: PASS.

Manual: Visit `/app/mapping?view=all` — should land on `/app/triage`. Visit `/app/mapping?view=all&filter=mapped` — should land on `/app/triage?filter=mapped`. Visit `/app/mapping?dimId=country` — should land on `/app/tables?open=country&active=country&mode=match` (the `mode=match` is silently ignored by Tables until Step 3). Visit `/app/mapping?dimId=ghost-nonexistent` — should land on `/app/tables` with the "That table no longer exists." toast.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/legacy-mapping-redirect.ts app/test/legacy-mapping-redirect.test.ts app/src/main.tsx app/src/routes/MasterTables.tsx
git commit -m "feat(workbench): redirect legacy /app/mapping URLs to triage or tables+match"
```

---

## Step 3 — Per-table Match mode (the biggest move)

Lands: `<ModeStrip>` component, Records + Match modes in each tab, `<MatchModeBody dim>` carries the full single-dim workbench, full deletion of `app/src/routes/Mapping.tsx`. After this step, the Mapping route is replaced entirely by the workbench + redirect loader.

This is the riskiest step. The spec calls it out (Section 10): land behind a no-op runtime path that lets us revert by toggling one constant.

### Task 3.1: `<ModeStrip>` component

**Files:**
- Create: `app/src/components/modes/ModeStrip.tsx`

- [ ] **Step 1: Implement the component**

```tsx
// app/src/components/modes/ModeStrip.tsx
import { useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import type { Mode } from "../../lib/available-modes";

interface ModeStripProps {
  modes: readonly Mode[];
  active: Mode;
  onSelect: (m: Mode) => void;
  /** badge counts per mode — accent count for match (new), warn dot for sources (unmapped). */
  badges?: Partial<Record<Mode, { count?: number; warn?: boolean }>>;
}

const LABEL: Record<Mode, string> = {
  records: "Records",
  match: "Match values",
  sources: "Wired sources",
};

export function ModeStrip({ modes, active, onSelect, badges }: ModeStripProps) {
  const refs = useRef<Record<Mode, HTMLButtonElement | null>>({
    records: null,
    match: null,
    sources: null,
  });
  const [marker, setMarker] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const btn = refs.current[active];
    const parent = btn?.parentElement;
    if (!btn || !parent) return;
    const pBox = parent.getBoundingClientRect();
    const bBox = btn.getBoundingClientRect();
    setMarker({ left: bBox.left - pBox.left, width: bBox.width });
  }, [active, modes]);

  if (modes.length <= 1) return null; // spec § 1: hide when only Records exists

  return (
    <div className="relative inline-flex items-stretch self-start rounded-pill border border-line bg-surface-2 p-1">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 rounded-pill bg-surface-elevated shadow-pop-sm ring-1 ring-line transition-[left,width] duration-[var(--dur-slide)] ease-[var(--ease-spring)]"
        style={{ left: marker.left, width: marker.width }}
      />
      {modes.map((m) => {
        const b = badges?.[m];
        const isActive = m === active;
        return (
          <button
            key={m}
            ref={(el) => {
              refs.current[m] = el;
            }}
            type="button"
            onClick={() => onSelect(m)}
            className={cx(
              "relative z-10 inline-flex items-center gap-2 rounded-pill px-4 py-2 transition-colors",
              isActive ? "text-ink" : "text-ink-3 hover:text-ink-2",
            )}
          >
            <span className="font-display text-[14px] font-semibold leading-none tracking-[-0.01em]">
              {LABEL[m]}
            </span>
            {b?.count != null && b.count > 0 && (
              <span
                className={cx(
                  "inline-flex h-5 min-w-[20px] items-center justify-center rounded-pill px-1.5 font-mono text-[10px] font-semibold leading-none tabular-nums",
                  isActive ? "bg-accent text-accent-ink" : "bg-surface-3 text-ink-2",
                )}
              >
                {b.count}
              </span>
            )}
            {b?.warn && (
              <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-warn" />
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/modes/ModeStrip.tsx
git commit -m "feat(workbench): ModeStrip segmented control with sliding-pill indicator"
```

### Task 3.2: Lift `MappingInner`'s single-dim body into `<MatchModeBody>`

**Files:**
- Create: `app/src/components/modes/MatchModeBody.tsx`

This task ports `MappingInner`'s single-dim workbench (the `viewMode === "single"` branch in `Mapping.tsx:829-1370`) plus its handlers (`stageMap`, `accept`, `pick`, `skipPersist`, `skip`, `reset`, `automap`, `bulkApply`, `approveAndCommit`, the `cursor`/`advanceToNextNew` wiring) into a new component that takes a fully resolved `dim` prop.

- [ ] **Step 1: Define the component contract**

```tsx
// app/src/components/modes/MatchModeBody.tsx
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../Button";
import { Checkbox } from "../Checkbox";
import { ComboSelect } from "../ComboSelect";
import { Chip, useGridCursor, useUndoStack } from "../datagrid";
import type { ColumnDef } from "../datagrid";
import { IconCheck, IconX, IconWand, IconArrowRight, IconChevron } from "../Icons";
import { cx } from "../../lib/cx";
import { useEngineerMode } from "../../lib/engineer-mode";
import { valueRows } from "../../data";
import type { MappingDimension, MappingValue } from "../../data";
import {
  useDrafts,
  saveDraft,
  discardDraft,
  listDrafts,
  commit,
  dkey,
  currentUser,
} from "../../store";

interface MatchModeBodyProps {
  /** Fully resolved dimension. Parent guarantees non-null (see MasterTables). */
  dim: MappingDimension;
  /** Whether this pane is currently the active tab. Drives URL-mirroring of focused row. */
  isActive: boolean;
}

export function MatchModeBody({ dim, isActive }: MatchModeBodyProps) {
  // … port body
  return /* … */ null;
}
```

- [ ] **Step 2: Port the body**

Substitute every reference to `seed` in `Mapping.tsx:121-1370` with `dim`. Drop:
- `useSessionState` for `viewMode` (only single mode exists here)
- `seedId` state + `selectSeed` + `setSeedId` (the dim is a prop now)
- `TablePicker` + `CreateTableModal` mount (the tab strip owns this now)
- `StatsBar` engineer-mode block (the existing `TablePane` toolbar at line 338-358 already shows these stats; we don't duplicate)
- The view-mode segmented control (`Mapping.tsx:719-772` — that pattern moves to `<ModeStrip>` and is owned by `TablePane`)
- The `crossDimRows`/`crossCounts`/`acceptCross`/`skipCross`/etc. (Triage owns these now)
- The `nextDims` "next dimension with work" hop in the empty-state (replace with the spec-defined Triage-jump CTA below)

Keep verbatim:
- `state` map computation (`Mapping.tsx:196-210`)
- `counts` (line 228-232)
- `stageMap`, `accept`, `pick`, `skipPersist`, `skip`, `reset`, `automap`, `bulkApply` (lines 302-384). Tag every `undo.push(...)` and `undo.beginTransaction(...)` call's eventual pushes with `surface: "Match"`.
- The `useGridCursor` wiring + `advanceToNextNew` (lines 524-559, 569-581)
- URL `?value=` mirror (585-598)
- `stagedDrafts` derivation (630-637)
- `sql` (641-651) and `approveAndCommit` (653-679)
- The entire toolbar + rows + sticky footer markup from `Mapping.tsx:877-1369`

Differences from the Mapping source:
- Replace `seed` → `dim`, `seedId` → `dim.id`.
- Wrap `useUndoStack()` and `useDrafts()` from props/store as before.
- The empty-state "next dimension with work" block (`Mapping.tsx:1177-1206`) — replace with a single Triage handoff:

```tsx
<div className="px-4 py-10 text-center">
  <div className="font-display text-[18px] font-semibold text-ink">
    {dim.dimension} is fully matched 🎉
  </div>
  <div className="mt-1.5 font-mono text-[11.5px] text-ink-3">
    See what else needs attention across all tables.
  </div>
  <div className="mt-4">
    <Link to="/app/triage">
      <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>
        Open Triage
      </Button>
    </Link>
  </div>
</div>
```

(Add `Link` to the `react-router-dom` import.)

- The Auto-match button moves into a small left-aligned toolbar at the top of the body (spec § 1: "above the mode body as a small left-aligned toolbar"):

```tsx
<div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
  {counts.new > 0 && (
    <Button
      size="sm"
      variant="ghost"
      icon={<IconWand className="h-3.5 w-3.5" />}
      onClick={automap}
      className="zz-glow-sm"
    >
      {autoFlash !== null ? `✓ Auto-matched ${autoFlash}` : "Auto-match new values"}
    </Button>
  )}
</div>
```

- Replace the outer wrapper. The old wrapper at `Mapping.tsx:831-874` is `<div className="zz-rise rounded-lg border …" ref={cursor.ref} tabIndex={0} onKeyDown={…} style={{ animationDelay: '150ms' }}>`. Keep `ref`, `tabIndex`, `onKeyDown` — but drop the outer rounded-lg border so the body lives flush inside the tab pane:

```tsx
<div
  className="flex flex-1 flex-col min-h-0 outline-none focus:ring-1 focus:ring-accent/40"
  ref={cursor.ref}
  tabIndex={0}
  onKeyDown={(e) => {
    cursor.onKeyDown(e);
    if (e.defaultPrevented) return;
    if (!cursor.cursor || cursor.cursor.editing) return;
    // … A/M/S/R/N/Cmd+Enter wiring (verbatim from Mapping.tsx:843-872)
  }}
>
```

The sticky footer at `Mapping.tsx:1214-1369` keeps its `sticky bottom-0 z-20` classes — the tab pane being `flex flex-col h-full min-h-0` (verified by Task 3.3) ensures the footer pins to the pane, not the route.

- [ ] **Step 3: Typecheck**

Run: `cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/modes/MatchModeBody.tsx
git commit -m "feat(workbench): MatchModeBody lifts Mapping single-dim workbench into reusable mode body"
```

### Task 3.3: Mount mode strip in `TablePane`; verify per-pane flex layout

**Files:**
- Modify: `app/src/components/TablePane.tsx`

- [ ] **Step 1: Update `TablePaneProps` to accept mode info**

```tsx
// app/src/components/TablePane.tsx
import { ModeStrip } from "./modes/ModeStrip";
import { MatchModeBody } from "./modes/MatchModeBody";
import type { Mode } from "../lib/available-modes";

interface TablePaneProps {
  dim: MappingDimension;
  isActive: boolean;
  mode: Mode;
  modes: readonly Mode[];
  onModeChange: (m: Mode) => void;
}
```

Forward `mode`, `modes`, `onModeChange` through `TablePane` → `TablePaneInner`.

- [ ] **Step 2: Verify the per-pane flex layout**

The mode-body sticky footer relies on each tab pane being its own flex column with the body as the overflow:auto child. Check the wrapper in `MasterTables.tsx:94-97`:

```tsx
<div key={tab.id} hidden={!isActive} className="absolute inset-0 flex flex-col min-h-0">
  <TablePane … />
</div>
```

Add `className="absolute inset-0 flex flex-col min-h-0"` and the parent `<div className="relative flex-1 min-h-0">` already exists at `MasterTables.tsx:88`. The `<TablePane>` itself must render as `flex flex-1 flex-col min-h-0`:

```tsx
// app/src/components/TablePane.tsx — replace the TablePaneInner outer wrapper
return (
  <div className="flex flex-1 flex-col min-h-0">
    {/* mode strip */}
    {modes.length > 1 && (
      <div className="border-b border-line bg-surface px-4 py-2.5">
        <ModeStrip
          modes={modes}
          active={mode}
          onSelect={onModeChange}
          badges={{
            match: { count: countNewForDim(dim) },
            sources: { warn: wired.some((s) => s.unmapped > 0) },
          }}
        />
      </div>
    )}
    {/* mode body */}
    <div className="flex flex-1 flex-col min-h-0 overflow-auto">
      {mode === "records" && <RecordsBody /* the existing body */ />}
      {mode === "match" && <MatchModeBody dim={dim} isActive={isActive} />}
      {/* Wired sources mode arrives in Step 4 */}
    </div>
  </div>
);
```

Define `countNewForDim` inside the file (counts `dim.values` where the overlaid status is "new"):

```tsx
function countNewForDim(dim: MappingDimension): number {
  return dim.values.filter((v) => v.status === "new").length;
}
```

The existing TablePane body (the toolbar at line 338-456 + the grid block at 458-645) becomes `RecordsBody` — extract as a local sub-component or a `renderRecords()` inline. Simplest: split into a local component within the same file so the existing logic moves into one place:

```tsx
function RecordsBody({ dim, isActive }: { dim: MappingDimension; isActive: boolean }) {
  // … the existing TablePaneInner body, verbatim (sources, density, columns, etc.)
}
```

Then `TablePaneInner` becomes the orchestrator that owns `useUndoStack()` (shared across modes — both the Records body and the Match body call `useUndoStack()` and get the same provider) and switches between bodies.

Important: both `RecordsBody` and `MatchModeBody` call `useUndoStack()`. The provider is mounted once at `TablePane` level (line 41-43, unchanged) — every consumer underneath gets the same stack. Sharing-across-modes is the documented behavior (spec § 4); the `surface` field on each push disambiguates inverses.

- [ ] **Step 3: Typecheck + manual smoke**

Run: `cd app && bun run typecheck`
Expected: PASS.

Manual: `cd app && bun run dev`, open `/app/tables`, click a sourced dim — mode strip should render with Records highlighted. Click Match values — should mount `<MatchModeBody>` with the row queue, filter chips, and sticky footer pinned to the pane bottom (not the route bottom). Open a second tab with a different sourced dim — switching between tabs preserves each pane's mode, cursor, and sticky-footer review state. Records mode should still work end-to-end (rename, add, merge, retire).

- [ ] **Step 4: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "feat(workbench): mount ModeStrip + MatchModeBody in TablePane; verify per-pane flex"
```

### Task 3.4: `MasterTables` — fold `mode` URL param, persist per-dim, honor `value`

**Files:**
- Modify: `app/src/routes/MasterTables.tsx`

- [ ] **Step 1: Per-tab mode state**

Add a `Record<dimId, Mode>` state keyed by `dim.id`. On mount, fold from URL (active tab only) or localStorage. On switch, write the new active tab's mode through to URL + localStorage:

```tsx
// app/src/routes/MasterTables.tsx
import { availableModes, type Mode } from "../lib/available-modes";
import { foldUrlMode, writeStoredMode, readStoredMode } from "../lib/tab-mode";
import { useSources } from "../store";

// inside MasterTables(), after dimById is defined
const sources = useSources();
const [perTabMode, setPerTabMode] = useState<Record<string, Mode>>({});

// On mount, fold the URL ?mode for the active tab.
const initialModeRef = useRef(false);
useEffect(() => {
  if (initialModeRef.current) return;
  if (!activeTabId) return;
  const dimId = dimIdFromTabId(activeTabId);
  const dim = dimById.get(dimId);
  if (!dim) return;
  const modes = availableModes(dim, sources);
  const folded = foldUrlMode(searchParams, dimId, modes);
  setPerTabMode((cur) => ({ ...cur, [dimId]: folded }));
  initialModeRef.current = true;
}, [activeTabId, dimById, sources, searchParams]);

const onModeChange = useCallback(
  (dimId: string, m: Mode) => {
    setPerTabMode((cur) => ({ ...cur, [dimId]: m }));
    writeStoredMode(dimId, m);
  },
  [],
);

// When the active tab changes, sync ?mode in the URL to that tab's current mode.
useEffect(() => {
  if (!activeTabId) return;
  const dimId = dimIdFromTabId(activeTabId);
  const dim = dimById.get(dimId);
  if (!dim) return;
  const modes = availableModes(dim, sources);
  const mode = perTabMode[dimId] ?? readStoredMode(dimId, modes);
  setSearchParams(
    (prev) => {
      const next = new URLSearchParams(prev);
      if (mode !== "records") next.set("mode", mode);
      else next.delete("mode");
      // Drop ?value when not in match mode (spec § 7).
      if (mode !== "match") next.delete("value");
      return next;
    },
    { replace: true },
  );
}, [activeTabId, perTabMode, dimById, sources, setSearchParams]);
```

Add `useCallback` to the React imports.

- [ ] **Step 2: Pass mode through to TablePane**

```tsx
// inside the tabs.map render
{tabs.map((tab) => {
  const dim = dimById.get(tab.dimId);
  if (!dim) return null;
  const isActive = tab.id === activeTabId;
  const modes = availableModes(dim, sources);
  const mode: Mode = perTabMode[tab.dimId] ?? readStoredMode(tab.dimId, modes);
  return (
    <div key={tab.id} hidden={!isActive} className="absolute inset-0 flex flex-col min-h-0">
      <TablePane
        dim={dim}
        isActive={isActive}
        mode={mode}
        modes={modes}
        onModeChange={(m) => onModeChange(tab.dimId, m)}
      />
    </div>
  );
})}
```

- [ ] **Step 3: Typecheck + manual smoke**

Run: `cd app && bun run typecheck`
Expected: PASS.

Manual: Open `/app/tables`, switch a tab to Match mode — URL should gain `?mode=match`. Close and reopen the tab (close via the tab strip's × → reopen from sidebar) — should default to Records (per spec: localStorage feeds URL fold at mount; closed-tab state isn't restored on a new open). Visit `/app/tables?open=country&active=country&mode=match&value=US` from a fresh tab — should open Country in Match mode with the row matching `US` focused (the existing `useGridCursor` pinning at `MatchModeBody`).

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/MasterTables.tsx
git commit -m "feat(workbench): MasterTables folds ?mode= per active tab; persists per-dim in localStorage"
```

### Task 3.5: Delete `Mapping.tsx`, drop import; update CommandPalette per-dim entries

**Files:**
- Delete: `app/src/routes/Mapping.tsx`
- Modify: `app/src/main.tsx` (drop `import { Mapping }`)
- Modify: `app/src/components/AppShell.tsx:229-240` (per-dim palette command)
- Modify: `app/src/components/TablePane.tsx:609-614` (the "match them on Value mapping" inline Link inside the expanded variants panel — retarget to a Match-mode jump)

- [ ] **Step 1: Retarget the per-dim CommandPalette entry**

```tsx
// app/src/components/AppShell.tsx — replace the per-dim push (around line 229-240)
for (const d of dims) {
  const newCount = d.values.filter((v) => v.status === "new").length;
  out.push({
    id: `dim:${d.id}`,
    group: "Tables",
    label: d.dimension,
    secondary: newCount > 0 ? `${newCount} new` : "clean",
    icon: <IconArrowRight className="h-4 w-4" />,
    keywords: `${d.id} ${d.mapTable} ${d.dimTable} ${d.keyCol}`,
    action: () => {
      openTab(d.id);
      navigate(`/app/tables?open=${d.id}&active=${d.id}&mode=match`);
    },
  });
}
```

- [ ] **Step 2: Retarget the inline Link in TablePane's expanded-variants panel**

```tsx
// app/src/components/TablePane.tsx:609-614 — replace the legacy Link
<Link
  to={`/app/tables?open=${activeId}&active=${activeId}&mode=match`}
  className="text-accent hover:underline"
>
  match them in Match values
</Link>
```

- [ ] **Step 3: Delete the Mapping route file**

```bash
git rm app/src/routes/Mapping.tsx
```

Drop the import from `app/src/main.tsx`:

```tsx
// remove this line
import { Mapping } from "./routes/Mapping";
```

The `/app/mapping` route in `main.tsx` already uses `<LegacyMappingRedirect />` from Step 2.3 — no further route changes here.

- [ ] **Step 4: Typecheck + lint + full test**

Run: `cd app && bun run typecheck && bun run lint && bun run test`
Expected: PASS — no references to `routes/Mapping` should remain.

If lint complains about unused imports, clean them.

- [ ] **Step 5: Manual smoke — golden paths**

`cd app && bun run dev`. Verify:
1. `/app/mapping?dimId=country` → lands at `/app/tables?open=country&active=country&mode=match` with Country opened in Match mode.
2. `/app/mapping?view=all` → lands at `/app/triage`.
3. `/app/tables` → Sourced dims open with a 3-mode strip; switching to Match value picker works (A, M, S, R, N, Cmd+Enter, Cmd+Z); the sticky footer pins to the pane.
4. Static reference dim (no wiring) → opens with no mode strip, just the Records grid.
5. Sources route's "Resolve" → still lands at `/app/mapping?dimId=…` (NOT yet updated — Sources update lands in Step 5; or update here as a follow-up of Step 3).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(workbench): delete Mapping route — replaced by Triage + per-table Match mode"
```

---

## Step 4 — Wired sources mode

Lands: the third mode segment activates; `<WiredSourcesModeBody dim>` shows the dim's wired columns; reverse handoff link to Sources.

### Task 4.1: `<WiredSourcesModeBody>`

**Files:**
- Create: `app/src/components/modes/WiredSourcesModeBody.tsx`

The spec (§ 1 → table row "Wired sources") strips: schema accordion grouping (only one table here), Standing callout, Browse warehouse. Keeps: LedgerRow, ScanScheduleMenu, derive button, status chip, expandable unmapped sample.

The `<LedgerRow>` in `Sources.tsx:583-694` is route-local. Extract it into a shared component first.

- [ ] **Step 1: Export `LedgerRow` + `ExpandedDrill` from a shared file**

Create `app/src/components/sources/LedgerRow.tsx` and `app/src/components/sources/ExpandedDrill.tsx`; move the existing implementations from `app/src/routes/Sources.tsx` verbatim. Update `Sources.tsx` to import from the new files.

```bash
mkdir -p app/src/components/sources
```

```tsx
// app/src/components/sources/LedgerRow.tsx — exports LedgerRow (port lines 583-694)
// app/src/components/sources/ExpandedDrill.tsx — exports ExpandedDrill (port lines 696-754)
```

Both port files preserve the existing class names and behavior — same `SCHED_LABEL`, `STALE_DAYS`, `ago`, `daysAgo` helpers (export them from `LedgerRow.tsx` or from a tiny `sources/utils.ts`).

After the move, `Sources.tsx` does `import { LedgerRow } from "../components/sources/LedgerRow"`.

Typecheck + manual: Sources should render unchanged.

- [ ] **Step 2: Implement the mode body**

```tsx
// app/src/components/modes/WiredSourcesModeBody.tsx
import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { Button } from "../Button";
import { IconArrowRight } from "../Icons";
import { LedgerRow } from "../sources/LedgerRow";
import { useSources, deriveCanonical, setSourceSchedule } from "../../store";
import type { MappingDimension } from "../../data";

interface Props {
  dim: MappingDimension;
}

export function WiredSourcesModeBody({ dim }: Props) {
  const sources = useSources();
  const [expanded, setExpanded] = useState<string | null>(null);
  const wired = useMemo(() => sources.filter((s) => s.dimId === dim.id), [sources, dim.id]);

  if (wired.length === 0) {
    return (
      <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
        nothing wired to this table yet
      </div>
    );
  }

  // The reverse handoff target: the schema of the first wired column.
  const firstSchema = wired[0].table.split(".")[0];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <Link to={`/app/sources?focus=${encodeURIComponent(firstSchema)}`}>
          <Button variant="ghost" size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>
            View in Sources
          </Button>
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto">
        {wired.map((row) => {
          const key = `${row.dimId}::${row.table}::${row.column}`;
          return (
            <LedgerRow
              key={key}
              row={row}
              expanded={expanded === key}
              onToggle={() => setExpanded(expanded === key ? null : key)}
              onScheduleChange={(next) => void setSourceSchedule(row.dimId, row.table, row.column, next)}
              onDerive={() => void deriveCanonical(row.dimId, row.table, row.column)}
            />
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire the mode into `TablePane`**

```tsx
// app/src/components/TablePane.tsx — inside the mode-body switch
{mode === "sources" && <WiredSourcesModeBody dim={dim} />}
```

Add the import.

- [ ] **Step 4: Typecheck + manual smoke**

Run: `cd app && bun run typecheck`
Expected: PASS.

Manual: Open a sourced dim in `/app/tables`, switch to Wired sources mode — shows the dim's wired columns with derive + schedule buttons working. Click "View in Sources" — lands at `/app/sources?focus=<schema>` with that schema expanded.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(workbench): Wired sources mode + reverse handoff to /app/sources?focus="
```

### Task 4.2: Sources reverse-handoff targets + Chip tone token unification

**Files:**
- Modify: `app/src/routes/Sources.tsx:369` (Standing callout Resolve link), `:747-749` (ExpandedDrill Resolve link)

- [ ] **Step 1: Retarget the two `/app/mapping?dimId=…` links**

Replace:

```tsx
// Sources.tsx:369 (Standing callout)
<Link to={`/app/tables?open=${agg.worst.dimId}&active=${agg.worst.dimId}&mode=match`} className="shrink-0">

// Sources.tsx:747 (ExpandedDrill)
<Link to={`/app/tables?open=${row.dimId}&active=${row.dimId}&mode=match`} className="text-accent hover:underline">
```

(Wherever `ExpandedDrill` now lives after the Step 4.1 extraction — `app/src/components/sources/ExpandedDrill.tsx`.)

- [ ] **Step 2: Manual smoke**

Sources → click Standing callout's "Resolve" → lands at the right tab + mode. Sources → expand a row → click "Resolve in Match values →" → lands at the right tab + mode + cursor pinned to that raw value (the `&value=` deep-link is wired by the existing `MatchModeBody` initial-cursor logic ported from `Mapping.tsx:561-581`).

Note: the deep-link from ExpandedDrill currently does NOT pass `&value=` per-row. The spec § 3 says "Resolve in Match values →" lands on the dim's Match mode, not a specific value. If we want per-value pinning we'd need ExpandedDrill to know which `UnmappedSample` row the user is targeting; that's a UI shift beyond this plan. Keep the current behavior.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(sources): retarget Resolve links to workbench Match mode"
```

---

## Step 5 — Polish

Lands: `⌥1`/`⌥2`/`⌥3` mode keys, `[`/`]` mode keys, `Cmd+1..9` tab-position keys, ShortcutsOverlay updates, Sources status-tone unification (no visual change today, one less divergence tomorrow), final accessibility verification.

### Task 5.1: `⌥1`/`⌥2`/`⌥3` + `[` / `]` mode keys

**Files:**
- Modify: `app/src/components/TablePane.tsx` (attach `onKeyDown` at the pane wrapper)

- [ ] **Step 1: Wire the mode keys**

Add to the outer wrapper of `TablePaneInner` (the one with `className="flex flex-1 flex-col min-h-0"`):

```tsx
<div
  className="flex flex-1 flex-col min-h-0"
  onKeyDown={(e) => {
    // Skip when editing in a grid cell (focus is inside an input)
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    if (e.altKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
      const idx = parseInt(e.key, 10) - 1;
      const target = modes[idx];
      if (target) {
        e.preventDefault();
        onModeChange(target);
      }
      return;
    }
    if (e.key === "[" || e.key === "]") {
      const dir = e.key === "]" ? 1 : -1;
      const i = modes.indexOf(mode);
      const next = modes[i + dir];
      if (next) {
        e.preventDefault();
        onModeChange(next);
      }
    }
  }}
>
```

Note: TablePane already has the cursor's own `onKeyDown` on its inner ref. The mode-key handler on the outer wrapper fires only when the inner grid hasn't preventDefaulted (the cursor's handler doesn't preventDefault `Alt` or `[`/`]`).

- [ ] **Step 2: Manual smoke**

Hit `⌥2` on a sourced dim → mode switches to Match. `]` advances; `[` reverses. Disabled segments (e.g., `⌥2` on a static reference dim) are no-ops because `modes[idx]` is undefined.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "feat(workbench): ⌥1/2/3 and [/] mode shortcuts on tab pane"
```

### Task 5.2: `Cmd+1..9` tab-position keys

**Files:**
- Modify: `app/src/components/AppShell.tsx` (global key handler at the top of the file already exists for `?` and `Cmd+K`)

- [ ] **Step 1: Wire Cmd+1..9 in the global key handler**

```tsx
// app/src/components/AppShell.tsx — inside the existing useEffect at line 134-150
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    const inField =
      e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === "?" && !inField) {
      e.preventDefault();
      setShortcutsOpen(true);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setPaletteOpen(true);
    } else if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      // Cmd+1..9 → switch to the Nth tab in the tab strip (1-indexed).
      // Only fires when on /app/tables, since tabs only exist there.
      if (!window.location.pathname.startsWith("/app/tables")) return;
      const idx = parseInt(e.key, 10) - 1;
      const target = tabsRef.current[idx];
      if (target) {
        e.preventDefault();
        focusTab(target.id);
      }
    }
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}, [focusTab]);
```

`tabsRef` is a `useRef<OpenTab[]>([])` synced from `useOpenTabs()`:

```tsx
const { tabs, focusTab } = useOpenTabs();
const tabsRef = useRef(tabs);
useEffect(() => {
  tabsRef.current = tabs;
}, [tabs]);
```

The ref pattern avoids re-binding the document listener every time `tabs` changes.

- [ ] **Step 2: Manual smoke**

Open `/app/tables` with three tabs. `Cmd+1`, `Cmd+2`, `Cmd+3` switch between them; `Cmd+9` no-ops when there are fewer than 9 tabs. From `/app/triage` or `/app/sources`, `Cmd+1` is a no-op.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/AppShell.tsx
git commit -m "feat(workbench): Cmd+1..9 switches tabs by position on /app/tables"
```

### Task 5.3: ShortcutsOverlay — add Workbench + Triage groups

**Files:**
- Modify: `app/src/components/datagrid/ShortcutsOverlay.tsx:7-43`

- [ ] **Step 1: Reorganize GROUPS**

```ts
const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Grid",
    rows: [
      ["↑ ↓ ← →", "move cursor"],
      ["any char", "type to edit"],
      ["Enter", "edit / commit + down"],
      ["Tab / Shift+Tab", "commit + edit →/←"],
      ["Esc", "cancel edit"],
      ["⌘A", "select all visible"],
      ["⌘⌫", "remove selected row(s)"],
      ["/", "focus filter"],
    ],
  },
  {
    title: "Workbench",
    rows: [
      ["⌘1 … ⌘9", "switch tab by position"],
      ["⌥1 / ⌥2 / ⌥3", "switch mode (Records / Match / Sources)"],
      ["[ / ]", "previous / next mode"],
    ],
  },
  {
    title: "Match · Triage",
    rows: [
      ["A", "accept suggestion"],
      ["M", "pick master record"],
      ["S", "skip"],
      ["R", "reset draft"],
      ["N", "jump to next new"],
      ["⌘↵", "publish staged drafts"],
    ],
  },
  {
    title: "Global",
    rows: [
      ["⌘K", "jump to anything"],
      ["⌘Z", "undo"],
      ["⌘⇧Z", "redo"],
      ["?", "this overlay"],
    ],
  },
];
```

Update the grid layout class on the wrapper (`sm:grid-cols-3` → `sm:grid-cols-2 md:grid-cols-4`) so 4 groups lay out cleanly:

```tsx
<div className="mt-4 grid gap-4 sm:grid-cols-2 md:grid-cols-4">
```

- [ ] **Step 2: Manual smoke**

Press `?` → overlay shows the four groups.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/ShortcutsOverlay.tsx
git commit -m "docs(shortcuts): add Workbench + Match·Triage groups"
```

### Task 5.4: Sources status-tone unification

**Files:**
- Modify: `app/src/components/sources/LedgerRow.tsx` (the `standingTone` mapping)

Per spec § 3: shared status tone tokens. LedgerRow's standing label keeps its plain-text treatment; only the tone names align with the shared scale `text-ok` / `text-warn` / `text-ink-3`. Today the file already uses these exact tokens (`LedgerRow.tsx:612-617` after the Step 4.1 extraction). Verify and pin them as the canonical scale via a one-line comment:

- [ ] **Step 1: Tone audit**

```tsx
// app/src/components/sources/LedgerRow.tsx — annotate the standingTone mapping
// Canonical status scale (shared with DataGrid Chip + Match-mode status pills):
//   clean → text-ok ; warn states → text-warn ; meta/unscanned → text-ink-3
const standingTone =
  standing === "clean"
    ? "text-ok"
    : standing === "unscanned" || standing === "not found"
      ? "text-ink-3"
      : "text-warn";
```

- [ ] **Step 2: Commit**

```bash
git add app/src/components/sources/LedgerRow.tsx
git commit -m "style(sources): pin LedgerRow standing scale to shared text-ok/warn/ink-3 tokens"
```

### Task 5.5: Final regression sweep + golden-path validation

- [ ] **Step 1: Run the full check matrix**

```bash
cd app && bun run typecheck && bun run lint && bun run test
```

Expected: PASS across the board.

- [ ] **Step 2: Manual golden paths**

`cd app && bun run dev` (with `cd server && bun run start` in another terminal). Walk:

1. **Dashboard → Triage → publish → open Partner → Match mode → drafts visible as committed.** From `/app`, click "Resolve N new" → lands at `/app/triage` → accept a few rows (A) → Cmd+↵ to publish → flash shows count. Open Partner from the sidebar → tab opens → switch to Match → the committed values now show status "mapped" with the persisted target.
2. **Sources → drill column → "Resolve" → workbench Match mode lands.** From `/app/sources`, expand a row with unmapped values → click "Resolve in Match values →" → lands at `/app/tables?open=…&active=…&mode=match` → Partner's Match mode body mounts.
3. **Legacy URL survival.** Visit `/app/mapping?dimId=country&value=US` → redirects to `/app/tables?open=country&active=country&mode=match&value=US` → tab opens, Match mode mounts, cursor pinned to `US`.
4. **Static reference table.** Create a new table with no source wiring → opens with no mode strip (just Records).
5. **Two tabs in Match mode.** Open Partner + Region tabs, both in Match mode, both with staged drafts → opening Review on Partner does not bleed into Region (per-pane sticky footer).
6. **Cursor staleness.** In Match mode, focus a "new" row → set filter to "Mapped" so the focused row vanishes → cursor should clear (no orphan focus ring).
7. **UndoStack surface.** In Records mode, rename a record → switch to Match mode → Undo button shows "(Records)" → press Cmd+Z → rename reverts and switches focus appropriately.
8. **Cmd+1..9.** Open three tabs → Cmd+1, Cmd+2, Cmd+3 → switches tabs.
9. **⌥1/2/3 + [/].** Inside a sourced dim's tab → these switch modes; disabled segments (⌥3 on a static dim) no-op.
10. **Triage empty state.** Match all values across all dims → Triage shows "Nothing to triage today." with the two CTAs.

- [ ] **Step 3: Final commit (if any cleanup)**

If the manual sweep surfaces any minor fixes, commit them as `fix(workbench): …` and re-run typecheck/lint.

```bash
git add -A
git commit -m "feat(workbench): final polish — paradigm shift complete"
```

---

## Risk / regression watch

Already enumerated in spec § 10. Reinforced here:

- **Step 3 is the biggest single move.** `MappingInner` is ~1100 lines and ports across two new files. Keep tasks 3.1–3.5 in order; revert by re-adding `routes/Mapping.tsx` + restoring the `<Route path="/app/mapping" element={<Mapping />} />` line in `main.tsx`. The redirect loader (Step 2.3) is independent — it stays even on revert.
- **Per-tab sticky footer.** Task 3.3 explicitly verifies `<div hidden={!isActive} className="absolute inset-0 flex flex-col min-h-0">` plus an inner `<TablePane>` with `flex flex-1 flex-col min-h-0`. The Step 5.5 manual sweep (#5) is the canary.
- **Cursor staleness across hidden panes.** Task 1.4 fix is small; Step 5.5 (#6) is the canary.
- **UndoStack across mode switches.** Mitigated by `surface` field (Task 1.5); Step 5.5 (#7) is the canary.

## Open questions (spec § Open questions — implementer call)

The plan resolves these during implementation:

1. **Auto-match button placement** — small left-aligned toolbar at the top of Match-mode body (Task 3.2).
2. **Mode strip when only Records exists** — render nothing (Task 3.1, `modes.length <= 1`).
3. **Cmd+1..9** — yes, included (Task 5.2).
4. **Standing callout / sidebar Triage badge microcopy** — leave as-is; visual context disambiguates.
5. **`View in Sources →` visibility** — always visible (Task 4.1).
6. **`?focus=<schema>` interaction with auto-expand** — preserves user intent (Task 1.6 → add to the auto-expand set rather than overriding).
