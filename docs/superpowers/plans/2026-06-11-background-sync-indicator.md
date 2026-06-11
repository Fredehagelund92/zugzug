# Background Sync Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Linear-style sync indicator in the AppShell topbar — "Saving…" while any write is in flight, a brief "Saved" confirmation, plus a toast when the server's scheduler auto-publishes drafts in the background (which today is completely silent).

**Architecture:** Two independent halves. (1) Client: a module-level in-flight write counter inside `store.ts`'s `api()` wrapper, exposed via its own `useSyncExternalStore` channel (NOT the global `emit()` bus — that re-renders every subscriber per keystroke, which we just spent a sprint avoiding), rendered as a small pill in the AppShell topbar. (2) Server: extend the existing `GET /api/sources/scan-status` payload with the timestamp/detail of the last auto-publish (audit_log query for user `u_system`, action `Committed`); AppShell polls it every 60s while the tab is visible and toasts when the timestamp advances.

**Tech Stack:** React 18 + TypeScript (app), Bun + postgres.js (server). Tests: vitest + Testing Library in `app/test/`, `bun test` in `server/test/`.

**Background you need:**
- All client writes go through `api()` in `app/src/store.ts` (search `async function api<T>`). Mutations are everything with `opts.method` set (`POST`/`PUT`/`PATCH`/`DELETE`); plain GETs pass no method.
- The scheduler (`server/src/scheduler-jobs.ts`) runs `autoCommitJob` on a 1-minute tick; it calls `commit(id, "u_system")`, which writes an audit row via `appendAuditAs("u_system", "Committed", "<N> values → <table> · <rows> rows recovered")` (`server/src/repo-drafts.ts:166-170`).
- Audit rows live in `zugzug_app.audit_log` with columns `(id, created_at, user_id, action, detail, table_id, row_key)` — see `appendAuditAs` in `server/src/repo-meta.ts:24-35`.
- `scanStatus()` lives in `server/src/repo-scan.ts:357` and is served at `server/src/server.ts` (search `scan-status`). The client type `ScanStatus` is currently declared locally in `app/src/routes/Settings.tsx:67-71` — you will extend both.
- Toasts: `import { toast } from "../components/Toast"` — `toast(message)` auto-dismisses, `toast(message, "error")` persists.
- Project rules: no comments unless the WHY is non-obvious; typecheck with `cd app && bun run typecheck` / `cd server && bun run typecheck`; tests with `cd app && bun run test`.

---

## File structure

- Modify: `app/src/store.ts` — in-flight counter + `useSyncStatus()` hook (lives with the other store hooks; this file is the data layer's single home)
- Create: `app/src/components/SyncPill.tsx` — the topbar pill (pure presentation)
- Modify: `app/src/components/AppShell.tsx` — mount `<SyncPill />` in the topbar; add the scan-status poll + auto-publish toast
- Modify: `server/src/repo-scan.ts` — extend `scanStatus()` result
- Modify: `app/src/routes/Settings.tsx` — extend the local `ScanStatus` interface (two optional fields; no behavior change)
- Create: `app/test/sync-status.test.tsx` — store counter + pill behavior
- Modify: `server/test/` — extend whichever existing test covers `scanStatus()` (search `scan-status` / `scanStatus` under `server/test/`; if none exists, create `server/test/scan-status.test.ts` following the DB-backed pattern in `server/test/tenant-migration.test.ts`)

---

### Task 1: In-flight write counter in the store

**Files:**
- Modify: `app/src/store.ts`
- Test: `app/test/sync-status.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/test/sync-status.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

describe("useSyncStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("idle → saving while a write is in flight → saved after it settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts?: RequestInit) => {
        if (opts?.method) await gate;
        return new Response(null, { status: 204 });
      }),
    );
    const { useSyncStatus, discardDraft } = await import("../src/store");
    const { result } = renderHook(() => useSyncStatus());
    expect(result.current).toBe("idle");

    let done!: Promise<void>;
    act(() => {
      done = discardDraft("country", "usa").catch(() => undefined);
    });
    await waitFor(() => expect(result.current).toBe("saving"));

    release();
    await act(() => done);
    await waitFor(() => expect(result.current).toBe("saved"));
  });

  test("saved decays back to idle after ~1.5s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const { useSyncStatus, discardDraft } = await import("../src/store");
    const { result } = renderHook(() => useSyncStatus());
    await act(async () => {
      await discardDraft("country", "usa").catch(() => undefined);
    });
    await waitFor(() => expect(result.current).toBe("saved"));
    await waitFor(() => expect(result.current).toBe("idle"), { timeout: 3000 });
  });
});
```

Note: `discardDraft` is just a convenient existing mutation that calls `api()` with a method; the background `refreshDrafts` it fires may also hit the stubbed fetch — that's fine, GETs don't touch the counter.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd app && bun run test sync-status`
Expected: FAIL — `useSyncStatus` is not exported.

- [ ] **Step 3: Implement the counter + hook in `store.ts`**

Place directly above `async function api<T>` (search for it):

```ts
/* ---- sync status (own listener channel — NOT the global emit() bus, which
   would re-render every store subscriber on every write start/settle) ---- */
export type SyncStatus = "idle" | "saving" | "saved";
let pendingWrites = 0;
let syncStatus: SyncStatus = "idle";
let savedDecayTimer: ReturnType<typeof setTimeout> | null = null;
const syncListeners = new Set<() => void>();
const emitSync = () => syncListeners.forEach((l) => l());

function writeStarted(): void {
  pendingWrites++;
  if (savedDecayTimer) clearTimeout(savedDecayTimer);
  if (syncStatus !== "saving") {
    syncStatus = "saving";
    emitSync();
  }
}
function writeSettled(): void {
  pendingWrites--;
  if (pendingWrites > 0) return;
  syncStatus = "saved";
  emitSync();
  savedDecayTimer = setTimeout(() => {
    syncStatus = "idle";
    emitSync();
  }, 1500);
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      syncListeners.add(l);
      return () => syncListeners.delete(l);
    },
    () => syncStatus,
    () => syncStatus,
  );
}
```

Then wire it into `api()`. The current body starts:

```ts
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
```

Change to:

```ts
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const isWrite = !!opts?.method && opts.method !== "GET";
  if (isWrite) writeStarted();
  try {
    return await apiInner<T>(path, opts);
  } finally {
    if (isWrite) writeSettled();
  }
}

async function apiInner<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
```

…with the rest of the original `api()` body moving unchanged into `apiInner`.

- [ ] **Step 4: Run the test again**

Run: `cd app && bun run test sync-status`
Expected: PASS (both tests).

- [ ] **Step 5: Typecheck + full suite, then commit**

Run: `cd app && bun run typecheck && bun run test`
Expected: clean, all pass.

```bash
git add app/src/store.ts app/test/sync-status.test.tsx
git commit -m "feat(app): in-flight write counter + useSyncStatus hook"
```

---

### Task 2: SyncPill component in the topbar

**Files:**
- Create: `app/src/components/SyncPill.tsx`
- Modify: `app/src/components/AppShell.tsx`

- [ ] **Step 1: Create the pill**

`app/src/components/SyncPill.tsx`:

```tsx
import { useSyncStatus } from "../store";
import { cx } from "../lib/cx";

/** Topbar sync state — renders nothing at idle so the chrome stays calm. */
export function SyncPill() {
  const status = useSyncStatus();
  if (status === "idle") return null;
  return (
    <span
      role="status"
      className={cx(
        "flex items-center gap-1.5 rounded-pill px-2.5 py-1 font-mono text-[10.5px] transition-colors",
        status === "saving" ? "bg-accent-wash text-accent" : "bg-surface-2 text-ink-3",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "h-1.5 w-1.5 rounded-pill",
          status === "saving" ? "animate-pulse bg-accent" : "bg-ok",
        )}
      />
      {status === "saving" ? "Saving…" : "Saved"}
    </span>
  );
}
```

- [ ] **Step 2: Mount it in AppShell's topbar**

In `app/src/components/AppShell.tsx`, find the topbar right-side cluster (search for `{me && <RoleBadge`). Insert `<SyncPill />` immediately before it:

```tsx
            <SyncPill />
            {me && <RoleBadge role={me.role} />}
```

Add the import next to the other component imports:

```tsx
import { SyncPill } from "./SyncPill";
```

- [ ] **Step 3: Verify in the browser**

Run the app (`cd app && bun run dev`; server must be up). Open a table, edit a cell. The pill must flash "Saving…" → "Saved" → disappear. Because mutations are optimistic, "Saving…" may only be visible for ~100ms on a fast network — throttle to "Slow 4G" in devtools (or add a 2s delay route in a Playwright probe) to see it clearly.

- [ ] **Step 4: Typecheck + commit**

Run: `cd app && bun run typecheck && bun run test`

```bash
git add app/src/components/SyncPill.tsx app/src/components/AppShell.tsx
git commit -m "feat(app): topbar sync pill (Saving…/Saved)"
```

---

### Task 3: Server — expose last auto-publish in scan-status

**Files:**
- Modify: `server/src/repo-scan.ts` (the `scanStatus()` function, currently `:357`)
- Test: extend the existing scanStatus coverage in `server/test/` (search `scanStatus`); if none, create `server/test/scan-status.test.ts`

- [ ] **Step 1: Find `scanStatus()` and its result type**

Open `server/src/repo-scan.ts:357`. Note the `ScanStatusResult` interface (declared nearby). Server tests assume the dockerized Postgres from `bun run test:db:up` — same as every other server test.

- [ ] **Step 2: Write the failing test**

Add to the scanStatus test file (create if needed, following the setup pattern of `server/test/tenant-migration.test.ts` — import from `../src/repo-scan.ts`, use the shared test DB):

```ts
import { describe, test, expect } from "bun:test";
import { scanStatus } from "../src/repo-scan.ts";
import { appendAuditAs } from "../src/repo-meta.ts";

describe("scanStatus auto-publish fields", () => {
  test("reports the latest u_system Committed audit entry", async () => {
    await appendAuditAs("u_system", "Committed", "2 values → zugzug.map_test · 14 rows recovered");
    const s = await scanStatus();
    expect(s.lastAutoPublishAt).not.toBeNull();
    expect(s.lastAutoPublishDetail).toContain("rows recovered");
  });
});
```

Note: `appendAuditAs` requires the user row `u_system` to exist if `audit_log.user_id` has an FK — this repo's convention is **no FKs**, so a bare insert works. If the test DB seed doesn't have `u_system` and something still fails, check how `repo-scan.ts`'s own tests seed users and mirror that.

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd server && bun test scan-status`
Expected: FAIL — `lastAutoPublishAt` does not exist on the result type.

- [ ] **Step 4: Extend `scanStatus()`**

In `server/src/repo-scan.ts`, add to the `ScanStatusResult` interface:

```ts
  lastAutoPublishAt: string | null;
  lastAutoPublishDetail: string | null;
```

And in the `scanStatus()` body, alongside the existing queries:

```ts
  const lastAuto = await pgGet<{ at: string; detail: string }>(
    `SELECT created_at AS at, detail
       FROM ${pg("audit_log")}
      WHERE user_id = 'u_system' AND action = 'Committed'
      ORDER BY created_at DESC
      LIMIT 1`,
  ).catch(() => null);
```

…and include in the returned object:

```ts
    lastAutoPublishAt: lastAuto?.at ?? null,
    lastAutoPublishDetail: lastAuto?.detail ?? null,
```

(`pgGet` and `pg` are already imported in this file — verify at the top; if `pg` isn't, it comes from `./env.ts`.)

- [ ] **Step 5: Run the test, typecheck, commit**

Run: `cd server && bun test scan-status && bun run typecheck`
Expected: PASS, clean.

```bash
git add server/src/repo-scan.ts server/test/
git commit -m "feat(server): scan-status reports last auto-publish (u_system Committed audit)"
```

---

### Task 4: Client — poll + toast on auto-publish

**Files:**
- Modify: `app/src/components/AppShell.tsx`
- Modify: `app/src/routes/Settings.tsx:67-71` (extend the local `ScanStatus` interface with the two new optional fields)

- [ ] **Step 1: Add the poll effect to AppShell**

Inside the `AppShell` component (near its other top-level effects), add:

```tsx
  // Background auto-publish visibility: the scheduler commits as u_system with
  // no client signal. Poll scan-status once a minute while the tab is visible
  // and toast when the last-auto-publish timestamp advances past what this
  // session has already seen (seeded on first poll so old runs don't toast).
  const lastAutoSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/sources/scan-status");
        if (!r.ok) return;
        const s = (await r.json()) as {
          lastAutoPublishAt: string | null;
          lastAutoPublishDetail: string | null;
        };
        if (lastAutoSeen.current === undefined) {
          lastAutoSeen.current = s.lastAutoPublishAt;
          return;
        }
        if (s.lastAutoPublishAt && s.lastAutoPublishAt !== lastAutoSeen.current) {
          lastAutoSeen.current = s.lastAutoPublishAt;
          toast(`⚡ Auto-published ${s.lastAutoPublishDetail ?? "changes"}`);
        }
      } catch {
        /* offline — the BootGate/health surfaces handle connectivity */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 60_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
```

Imports needed in AppShell (check which already exist): `useRef`, `useEffect` from react; `toast` from `./Toast`.

- [ ] **Step 2: Extend Settings' ScanStatus interface**

In `app/src/routes/Settings.tsx:67`, add the two fields so the one shared endpoint has one shape:

```ts
interface ScanStatus {
  lastScanAt: string | null;
  sourceCount: number;
  unmappedCount: number;
  lastAutoPublishAt?: string | null;
  lastAutoPublishDetail?: string | null;
}
```

- [ ] **Step 3: Typecheck + full app suite**

Run: `cd app && bun run typecheck && bun run test`
Expected: clean.

- [ ] **Step 4: Manual verification**

With the server running and `ATTACH_WAREHOUSE` off, the scheduler never auto-commits — simulate instead: insert an audit row directly (`curl` the dev server is not enough; use psql or a one-off bun script calling `appendAuditAs("u_system", "Committed", "3 values → zugzug.map_country · 120 rows recovered")`), then wait for the next poll tick (or reload — first poll seeds, second detects; to force, lower the interval temporarily). Confirm the toast appears once and does not repeat on subsequent ticks.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/AppShell.tsx app/src/routes/Settings.tsx
git commit -m "feat(app): toast when the scheduler auto-publishes in the background"
```

---

## Self-review checklist (for the executor)

- The counter must never go negative — `writeSettled` runs in `finally`, including the error path.
- `useSyncStatus` must NOT use the store's global `emit()`/`subscribe` — separate listener set.
- The poll seeds on first response (no toast for historic runs) and toasts at most once per timestamp.
- GET requests must not move the pill.
