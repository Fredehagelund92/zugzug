# E1 — Activity & Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship cell-level live cursors via yjs awareness on Bun WebSocket + inline "edited Nm ago" row activity badges fed from a covering-indexed Postgres `audit_log`.

**Architecture:** Two deliberately separated channels — ephemeral yjs awareness over WebSocket for live presence (cursors, selection), and a polled HTTP endpoint over the existing audit log for historical row activity badges. A small commit-time `row_touched` hint is broadcast over the presence channel to invalidate badge caches faster than the 5 s poll cadence, but Postgres stays the source of truth.

**Tech Stack:** Bun (native WebSocket), Drizzle ORM + Postgres (`zugzug_app` schema), yjs + y-protocols + y-websocket, React 18 + TypeScript + Tailwind v4 + @tanstack/react-virtual, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-06-e1-activity-presence-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/drizzle/schema.ts` | Edit | Add `table_id`, `row_key` columns + covering index on `auditLog` |
| `server/drizzle/migrations/` | Generate | `bun run db:generate` creates `0004_*.sql` |
| `server/src/repo-meta.ts` | Edit | Extend `appendAuditAs` signature with optional `{ tableId, rowKey }` |
| `server/src/repo-canonical.ts` | Edit | Pass `{ tableId, rowKey }` from the 5 per-row audit call sites |
| `server/src/repo-drafts.ts` | Edit | Per-row audit emission in `commit()` (one entry per committed draft) |
| `server/src/repo-activity.ts` | Create | `getRowActivitySince` query helper |
| `server/src/repo.ts` | Edit | Re-export `repo-activity.ts` |
| `server/src/realtime/presence-room.ts` | Create | `PresenceTransport` interface + `InMemoryPresenceTransport` |
| `server/src/server.ts` | Edit | `GET /api/tables/:id/row-activity` route + `/ws/presence/:tableId` WS upgrade |
| `server/test/repo-activity.test.ts` | Create | Unit tests for `getRowActivitySince` |
| `server/test/presence-room.test.ts` | Create | Unit tests for room broadcast / GC / readyState guard |
| `server/package.json` | Edit | Add `yjs`, `y-protocols` deps |
| `app/package.json` | Edit | Add `yjs`, `y-protocols`, `y-websocket` deps |
| `app/src/tokens.css` | Edit | Add `coral`, `sky`, `lime` tint tokens (dark + light variants) |
| `app/src/lib/use-presence-color.ts` | Create | Deterministic `userId → tint` hash over 10-color palette |
| `app/test/use-presence-color.test.ts` | Create | Hash determinism + collision smoke test |
| `app/src/lib/use-row-activity.ts` | Create | 5 s poll hook + `row_touched` invalidation listener |
| `app/src/lib/use-presence.ts` | Create | y-websocket + standalone `Awareness` + idle/away tracking |
| `app/src/components/datagrid/RowActivityBadge.tsx` | Create | Left-margin pip + hover-revealed inline badge |
| `app/src/components/datagrid/CursorOverlay.tsx` | Create | Absolutely-positioned peer cursor highlights + name labels |
| `app/src/components/datagrid/PresenceStrip.tsx` | Create | Toolbar-row avatar strip (active / away / removed) |
| `app/src/components/datagrid/DataGrid.tsx` | Edit | Mount `CursorOverlay`, render `RowActivityBadge` per row |
| `app/src/components/TablePane.tsx` | Edit | Mount `PresenceStrip` in toolbar |

---

## Task 1: Migration — `audit_log.table_id`, `audit_log.row_key`, covering index

**Files:**
- Modify: `server/drizzle/schema.ts:84-90`
- Generate: `server/drizzle/migrations/0004_*.sql`

- [ ] **Step 1: Extend the `auditLog` schema**

Open `server/drizzle/schema.ts`. Replace the `auditLog` declaration (lines 84-90):

```typescript
export const auditLog = app.table(
  "audit_log",
  {
    id:         varchar("id").primaryKey(),
    created_at: timestamp("created_at").notNull(),
    user_id:    varchar("user_id").notNull(),
    action:     varchar("action").notNull(),
    detail:     varchar("detail").notNull(),
    table_id:   varchar("table_id"),
    row_key:    varchar("row_key"),
  },
  (t) => [
    index("audit_log_table_row_recency_idx")
      .on(t.table_id, t.row_key, t.created_at.desc())
      .where(sql`${t.table_id} IS NOT NULL`),
  ],
);
```

If `index` and `sql` aren't already imported in `schema.ts`, add them to the import line (drizzle-orm/pg-core for `index`, drizzle-orm for `sql`).

- [ ] **Step 2: Generate the migration**

```bash
cd server && bun run db:generate
```

Expected: a new file `server/drizzle/migrations/0004_*.sql` containing:
- `ALTER TABLE "zugzug_app"."audit_log" ADD COLUMN "table_id" varchar;`
- `ALTER TABLE "zugzug_app"."audit_log" ADD COLUMN "row_key" varchar;`
- `CREATE INDEX "audit_log_table_row_recency_idx" ON "zugzug_app"."audit_log" ("table_id", "row_key", "created_at" DESC) WHERE "table_id" IS NOT NULL;`

If drizzle-kit asks any interactive prompts, accept the default (no rename, just add columns).

- [ ] **Step 3: Apply the migration locally**

```bash
cd server && bun run db:migrate
```

Expected: `1 migration(s) applied` (or similar drizzle-kit output).

- [ ] **Step 4: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/0004_*.sql server/drizzle/migrations/meta/
git commit -m "feat: add table_id/row_key to audit_log + covering index"
```

---

## Task 2: Extend `appendAuditAs` to accept optional `{ tableId, rowKey }`

**Files:**
- Modify: `server/src/repo-meta.ts:24-30`

- [ ] **Step 1: Update the signature**

Replace the `appendAuditAs` function in `server/src/repo-meta.ts`:

```typescript
export async function appendAuditAs(
  userId: string,
  action: string,
  detail: string,
  ctx: { tableId?: string; rowKey?: string } = {},
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("audit_log")} (id, created_at, user_id, action, detail, table_id, row_key)
     VALUES ($1, current_timestamp, $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, action, detail, ctx.tableId ?? null, ctx.rowKey ?? null],
  );
}
```

The existing 13 call sites (`tables.ts`, `repo-canonical.ts`, `repo-drafts.ts`, `repo-scan.ts`, `server.ts`) all keep working unchanged — they just write `null` into the new columns. Per-row sites will be updated in Tasks 3-4.

- [ ] **Step 2: Verify the typecheck still passes**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run existing tests**

```bash
cd server && bun run test:db:up && bun run test
```

Expected: all existing tests pass (the new optional param is non-breaking).

- [ ] **Step 4: Commit**

```bash
git add server/src/repo-meta.ts
git commit -m "feat: appendAuditAs accepts optional {tableId, rowKey}"
```

---

## Task 3: Back-populate per-row audit call sites in `repo-canonical.ts`

**Files:**
- Modify: `server/src/repo-canonical.ts` at lines 331, 351, 385, 404, 570

There are 5 per-row sites. Skip lines 282 (dimension creation), 448 (field add — schema not row), 468 (rename column), 595 (delete column), 621 (field-level metadata) — those are table/column level, not per-row.

- [ ] **Step 1: Find the `addCanonicalOne` call (line ~331)**

Locate this line in `repo-canonical.ts`:

```typescript
await appendAuditAs(userId, "Added canonical", `${label} (${k})`);
```

Replace with:

```typescript
await appendAuditAs(userId, "Added canonical", `${label} (${k})`, { tableId: dimId, rowKey: k });
```

(Confirm `dimId` and `k` are in scope at this call site — they are: `dimId` is the function parameter, `k` is the just-generated key.)

- [ ] **Step 2: Find the `renameCanonical` call (line ~351)**

Locate:

```typescript
await appendAuditAs(userId, "Renamed canonical", `${key} → "${label}"`);
```

Replace with:

```typescript
await appendAuditAs(userId, "Renamed canonical", `${key} → "${label}"`, { tableId: dimId, rowKey: key });
```

- [ ] **Step 3: Find the `mergeCanonicals` call (line ~385)**

Locate:

```typescript
await appendAuditAs(userId, "Merged canonical", `${real.join(", ")} → ${survivor}`);
```

Replace with:

```typescript
await appendAuditAs(userId, "Merged canonical", `${real.join(", ")} → ${survivor}`, { tableId: dimId, rowKey: survivor });
```

- [ ] **Step 4: Find the `retireCanonical` call (line ~404)**

Locate:

```typescript
await appendAuditAs(userId, "Retired canonical", key);
```

Replace with:

```typescript
await appendAuditAs(userId, "Retired canonical", key, { tableId: dimId, rowKey: key });
```

- [ ] **Step 5: Find the `setFieldValue` call (line ~570)**

Locate the multi-line call. It currently looks like:

```typescript
await appendAuditAs(
  userId,
  "Set field value",
  `${field} = ${JSON.stringify(value)} on ${key}`,
);
```

(Exact text may differ slightly — match the call inside `setFieldValue`.) Replace with:

```typescript
await appendAuditAs(
  userId,
  "Set field value",
  `${field} = ${JSON.stringify(value)} on ${key}`,
  { tableId: dimId, rowKey: key },
);
```

- [ ] **Step 6: Typecheck + tests**

```bash
cd server && bun run typecheck && bun run test
```

Expected: all green. (`addDimension.test.ts` and `commit.test.ts` and `merge.test.ts` exercise these paths — they should keep passing because the new param is optional.)

- [ ] **Step 7: Commit**

```bash
git add server/src/repo-canonical.ts
git commit -m "feat: pass tableId/rowKey from per-row canonical audit writes"
```

---

## Task 4: Per-row audit emission in `commit()` (`repo-drafts.ts`)

**Files:**
- Modify: `server/src/repo-drafts.ts` around lines 92-145

The existing `commit()` emits a single rolled-up audit entry like `"42 values → map_brand · 1234 rows recovered"`. For row badges we want one audit entry per committed `target_key` so each affected canonical row gets a "Mia · 3m ago" badge. Keep the rolled-up entry too (it powers the existing global audit view).

- [ ] **Step 1: Read the current `commit()` body**

Open `server/src/repo-drafts.ts` and locate `export async function commit(`. Read the function fully so you understand the transaction boundary.

- [ ] **Step 2: Before the existing rolled-up `appendAuditAs` call, add per-row emission**

Inside `commit()`, **after** the `await tx(...)` block that does the `INSERT INTO ${MAPT}` and `DELETE FROM ${DRAFT}`, but **before** the existing `await appendAuditAs(userId, "Committed", ...)` line, insert:

```typescript
// Per-row audit emission — drives inline row badges. Cheap fan-out: we
// already know each committed draft's target_key from the SELECT above.
const committedKeys = await pgAll<{ target_key: string }>(
  `SELECT DISTINCT target_key FROM ${DRAFT}
   WHERE dim_id = $1 AND status = 'mapped' AND target_key IS NOT NULL`,
  [dimId],
).catch(() => [] as { target_key: string }[]);

// NB: the DRAFT rows were deleted inside the tx above, so this query will
// be empty unless we moved it. Reorder: capture target_keys BEFORE the tx.
```

Actually, the comment above flags an ordering bug — the DRAFT rows are gone after the tx. Restructure: capture the target keys **before** the tx, then emit per-row audits after.

Locate the section in `commit()` that selects mapped drafts (look for `WHERE d.dim_id = $1 AND d.status = 'mapped'`). Immediately before the `await tx(...)` block, add:

```typescript
const committedRows = await pgAll<{ target_key: string }>(
  `SELECT DISTINCT target_key FROM ${DRAFT}
   WHERE dim_id = $1 AND status = 'mapped' AND target_key IS NOT NULL`,
  [dimId],
);
```

Then **after** the `await tx(...)` block, **before** the existing rolled-up `appendAuditAs`, add:

```typescript
for (const row of committedRows) {
  await appendAuditAs(
    userId,
    "Committed mapping",
    `→ ${row.target_key}`,
    { tableId: dimId, rowKey: row.target_key },
  );
}
```

Leave the existing rolled-up `await appendAuditAs(userId, "Committed", ...)` line untouched.

- [ ] **Step 3: Verify `commit.test.ts` still passes**

```bash
cd server && bun run test test/commit.test.ts
```

Expected: green. The test asserts the `committed` count and that drafts are deleted — it does not assert audit-log row count, so it will pass.

- [ ] **Step 4: Add a focused assertion in `commit.test.ts`**

Add a new test to `server/test/commit.test.ts`:

```typescript
test("commit writes one per-row audit entry per committed key + one rollup", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Channel", [], { keyKind: "slug" }, userId);

  await repo.addCanonicalOne(dimId, "Email", undefined, userId);
  await repo.addCanonicalOne(dimId, "SMS", undefined, userId);
  await repo.saveDraft(dimId, "email blast", "mapped", "Email", "email", userId);
  await repo.saveDraft(dimId, "sms blast",   "mapped", "SMS",   "sms",   userId);

  await repo.commit(dimId, userId);

  const audit = await repo.listAudit(50);
  const perRow = audit.filter((a) => a.action === "Committed mapping");
  const rollup = audit.filter((a) => a.action === "Committed");
  expect(perRow).toHaveLength(2);
  expect(rollup).toHaveLength(1);
});
```

Run it:

```bash
cd server && bun run test test/commit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-drafts.ts server/test/commit.test.ts
git commit -m "feat: per-row audit emission in commit()"
```

---

## Task 5: `repo-activity.ts` — `getRowActivitySince` + unit test

**Files:**
- Create: `server/src/repo-activity.ts`
- Create: `server/test/repo-activity.test.ts`
- Modify: `server/src/repo.ts` (re-export)

- [ ] **Step 1: Write the failing test**

Create `server/test/repo-activity.test.ts`:

```typescript
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { getRowActivitySince } from "../src/repo-activity.ts";

beforeEach(async () => {
  await resetDb();
});

test("getRowActivitySince returns latest entry per row_key within window", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, userId);

  await repo.addCanonicalOne(dimId, "United States", undefined, userId);
  await repo.addCanonicalOne(dimId, "Germany",       undefined, userId);
  await repo.renameCanonical(dimId, "united-states", "USA", userId);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const entries = await getRowActivitySince(dimId, since);

  expect(entries).toHaveLength(2);
  const usa = entries.find((e) => e.rowKey === "united-states");
  expect(usa?.op).toBe("rename");
  expect(usa?.displayName).toBeDefined();
});

test("getRowActivitySince ignores entries older than `since`", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brand", [], { keyKind: "slug" }, userId);
  await repo.addCanonicalOne(dimId, "Acme", undefined, userId);

  const future = new Date(Date.now() + 60_000);
  const entries = await getRowActivitySince(dimId, future);
  expect(entries).toHaveLength(0);
});

test("getRowActivitySince filters by tableId", async () => {
  const userId = "u_test";
  const dimA = await repo.addDimension("A", [], { keyKind: "slug" }, userId);
  const dimB = await repo.addDimension("B", [], { keyKind: "slug" }, userId);
  await repo.addCanonicalOne(dimA, "x", undefined, userId);
  await repo.addCanonicalOne(dimB, "y", undefined, userId);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const a = await getRowActivitySince(dimA, since);
  const b = await getRowActivitySince(dimB, since);
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0]?.rowKey).not.toBe(b[0]?.rowKey);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && bun run test test/repo-activity.test.ts
```

Expected: FAIL with "Cannot find module ../src/repo-activity.ts".

- [ ] **Step 3: Create `server/src/repo-activity.ts`**

```typescript
/* repo-activity.ts — derives per-row "last edited" entries from audit_log. */

import { pgAll } from "./repo-shared.ts";
import { pg } from "./env.ts";

export type AuditOp =
  | "rename"
  | "create"
  | "archive"
  | "field-write"
  | "merge"
  | "commit";

export type RowActivityEntry = {
  rowKey:      string;
  userId:      string;
  displayName: string;
  op:          AuditOp;
  at:          Date;
};

const ACTION_TO_OP: Record<string, AuditOp> = {
  "Added canonical":   "create",
  "Renamed canonical": "rename",
  "Merged canonical":  "merge",
  "Retired canonical": "archive",
  "Set field value":   "field-write",
  "Committed mapping": "commit",
};

export async function getRowActivitySince(
  tableId: string,
  since:   Date,
  newerThan?: Date,
): Promise<RowActivityEntry[]> {
  const lowerBound = newerThan ?? since;
  const rows = await pgAll<{
    row_key:  string;
    user_id:  string;
    name:     string | null;
    action:   string;
    created:  Date;
  }>(
    `SELECT DISTINCT ON (a.row_key)
       a.row_key, a.user_id, u.name, a.action, a.created_at AS created
     FROM ${pg("audit_log")} a
     LEFT JOIN ${pg("users")} u ON u.id = a.user_id
     WHERE a.table_id = $1
       AND a.row_key IS NOT NULL
       AND a.created_at > $2
     ORDER BY a.row_key, a.created_at DESC`,
    [tableId, lowerBound],
  );

  return rows.map((r) => ({
    rowKey:      r.row_key,
    userId:      r.user_id,
    displayName: r.name ?? "Unknown",
    op:          ACTION_TO_OP[r.action] ?? "field-write",
    at:          r.created,
  }));
}
```

- [ ] **Step 4: Re-export from `repo.ts`**

Open `server/src/repo.ts`. Find the existing re-export block (look for `export * from "./repo-ai-hint.ts";` or similar). Add:

```typescript
export * from "./repo-activity.ts";
```

- [ ] **Step 5: Run the tests, all should pass**

```bash
cd server && bun run test test/repo-activity.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-activity.ts server/src/repo.ts server/test/repo-activity.test.ts
git commit -m "feat: repo-activity — getRowActivitySince + tests"
```

---

## Task 6: `GET /api/tables/:id/row-activity` route

**Files:**
- Modify: `server/src/server.ts` (add route inline alongside existing `/api/dimensions/...` routes)

- [ ] **Step 1: Locate the right spot in `server.ts`**

Open `server/src/server.ts`. Find the section that handles `/api/dimensions/:id/...` routes (around line 267 based on the earlier grep). The new route is a sibling of those.

- [ ] **Step 2: Add the route**

Add this route handler in the same block where `/api/dimensions/:id/...` routes are matched. Use the same shape as adjacent routes — match on `seg`, call the repo, return JSON.

```typescript
// GET /api/tables/:id/row-activity?since=<iso>&newerThan=<iso>
if (req.method === "GET" && seg[1] === "tables" && seg[3] === "row-activity") {
  const tableId = seg[2]!;
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const newerThanParam = url.searchParams.get("newerThan");
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 86_400_000);
  const newerThan = newerThanParam ? new Date(newerThanParam) : undefined;

  if (Number.isNaN(since.getTime())) {
    return new Response(JSON.stringify({ error: "invalid `since`" }), { status: 400 });
  }

  const entries = await repo.getRowActivitySince(tableId, since, newerThan);
  return Response.json({ entries, serverTime: new Date().toISOString() });
}
```

(Match `seg` indexing to the convention used by adjacent routes — `seg[0]` is `"api"`, `seg[1]` is the resource. If the existing convention is different, adapt.)

- [ ] **Step 3: Manual smoke test**

```bash
cd server && bun run dev
```

In another shell:

```bash
curl -s -b "session=<your-session-cookie>" http://localhost:8787/api/tables/<some-dim-id>/row-activity | jq .
```

Expected: `{ "entries": [...], "serverTime": "2026-06-06T..." }`. If you don't have a session cookie handy, set `DEV_BYPASS_AUTH=true` in `server/.env.local` and restart.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts
git commit -m "feat: GET /api/tables/:id/row-activity route"
```

---

## Task 7: Client `use-row-activity.ts` hook

**Files:**
- Create: `app/src/lib/use-row-activity.ts`

- [ ] **Step 1: Create the hook**

```typescript
/* use-row-activity.ts — polls /api/tables/:id/row-activity every 5s. */

import { useEffect, useRef, useState } from "react";

export type AuditOp = "rename" | "create" | "archive" | "field-write" | "merge" | "commit";

export type RowActivityEntry = {
  rowKey:      string;
  userId:      string;
  displayName: string;
  op:          AuditOp;
  at:          string; // ISO
};

type State = {
  byRowKey: Map<string, RowActivityEntry>;
};

const TWENTY_FOUR_HOURS = 86_400_000;
const POLL_INTERVAL_MS = 5_000;

export function useRowActivity(tableId: string | null): Map<string, RowActivityEntry> {
  const [state, setState] = useState<State>({ byRowKey: new Map() });
  const serverTimeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!tableId) return;

    let cancelled = false;
    let timer: number | null = null;

    async function poll() {
      if (cancelled) return;
      const since = serverTimeRef.current
        ? `&newerThan=${encodeURIComponent(serverTimeRef.current)}`
        : `?since=${encodeURIComponent(new Date(Date.now() - TWENTY_FOUR_HOURS).toISOString())}`;
      const sep = serverTimeRef.current ? "?" : "";
      const url = `/api/tables/${tableId}/row-activity${sep}${since.replace(/^&/, "")}`;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as { entries: RowActivityEntry[]; serverTime: string };
        serverTimeRef.current = data.serverTime;
        if (data.entries.length > 0) {
          setState((prev) => {
            const next = new Map(prev.byRowKey);
            for (const e of data.entries) next.set(e.rowKey, e);
            return { byRowKey: pruneExpired(next) };
          });
        } else {
          setState((prev) => ({ byRowKey: pruneExpired(prev.byRowKey) }));
        }
      } catch {
        // network blip — try again on next tick
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [tableId]);

  return state.byRowKey;
}

function pruneExpired(map: Map<string, RowActivityEntry>): Map<string, RowActivityEntry> {
  const cutoff = Date.now() - TWENTY_FOUR_HOURS;
  const next = new Map(map);
  for (const [k, v] of next) {
    if (new Date(v.at).getTime() < cutoff) next.delete(k);
  }
  return next;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/use-row-activity.ts
git commit -m "feat: use-row-activity client hook (5s poll)"
```

---

## Task 8: `RowActivityBadge` component

**Files:**
- Create: `app/src/components/datagrid/RowActivityBadge.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMemo } from "react";
import { Badge } from "../Badge";
import type { RowActivityEntry } from "../../lib/use-row-activity";

export function RowActivityBadge({ entry }: { entry: RowActivityEntry }) {
  const relative = useMemo(() => relativeTime(new Date(entry.at)), [entry.at]);

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 bottom-0 w-0.5 bg-line-2 group-hover:bg-accent transition-colors"
      />
      <div className="pointer-events-none group-hover:pointer-events-auto absolute left-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <Badge tone="neutral" className="font-mono text-[10px]">
          {entry.displayName} · {relative}
        </Badge>
      </div>
    </>
  );
}

function relativeTime(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
```

If the `Badge` import path differs (e.g. `../Badge` resolves elsewhere), adjust to match the actual location (`app/src/components/Badge.tsx`).

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/RowActivityBadge.tsx
git commit -m "feat: RowActivityBadge — pip + hover-reveal"
```

---

## Task 9: Wire `RowActivityBadge` into `DataGrid` row rendering

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx` (or whichever file renders the row — confirm by `grep -l 'GridRow' app/src/components/datagrid/`)

- [ ] **Step 1: Locate the row-rendering component**

```bash
grep -ln "GridRow\|className=\"grid items-stretch" app/src/components/datagrid/
```

Open the file that renders one row. It will have a wrapper `<div className="... group ...">` or similar.

- [ ] **Step 2: Wire the hook and the badge**

In the `DataGrid` parent (the component that owns `tableId` and renders rows), import and call the hook:

```tsx
import { useRowActivity } from "../../lib/use-row-activity";
// ...inside the component:
const activity = useRowActivity(tableId);
```

Pass the per-row entry down via props. Then in the row component, ensure the row wrapper has `relative group` in its className (most likely already does), and render the badge conditionally:

```tsx
import { RowActivityBadge } from "./RowActivityBadge";
// ...inside the row:
{rowActivity && <RowActivityBadge entry={rowActivity} />}
```

If the grid uses `@tanstack/react-virtual`, pass `activity.get(rowKey)` into each virtualized row.

- [ ] **Step 3: Visual smoke test**

```bash
# In one shell:
cd server && bun run dev
# In another:
cd app && bun run dev
```

Open `http://localhost:5173/app/tables`. Pick a dim with recent commits. Hover over a row — the badge should slide in from the left. Resting state: the 2px pip on the left edge of the row.

If nothing shows, check: (a) the dim has audit entries with `table_id` populated (i.e. activity happened after Task 1 was deployed), (b) `tableId` prop is correctly threaded.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/
git commit -m "feat: wire RowActivityBadge into DataGrid rows"
```

---

## Task 10: Add `coral` / `sky` / `lime` tint tokens

**Files:**
- Modify: `app/src/tokens.css`

- [ ] **Step 1: Find the existing tint block**

Open `app/src/tokens.css`. Search for `--tint-rose`. The existing tints are defined for both dark mode (default `:root`) and light mode (`:root.theme-light` or similar). Find both blocks.

- [ ] **Step 2: Add the three new tints — dark variants**

In the dark-mode `:root` block, after the existing tint tokens, add:

```css
--tint-coral: #e8523a;
--tint-sky:   #2280d2;
--tint-lime:  #6ab04c;

--tint-coral-fg: #ffd9d0;
--tint-sky-fg:   #cfe5f7;
--tint-lime-fg:  #d8eecf;

--tint-coral-wash: color-mix(in srgb, var(--tint-coral) 18%, transparent);
--tint-sky-wash:   color-mix(in srgb, var(--tint-sky) 18%, transparent);
--tint-lime-wash:  color-mix(in srgb, var(--tint-lime) 18%, transparent);
```

(Match the exact pattern used by the existing tints — if they have different shadow/contrast tokens, mirror those.)

- [ ] **Step 3: Add light-mode variants**

In the light-mode block, dial saturation down ~15% and lightness down ~12% per the existing pattern:

```css
--tint-coral: #c64432;
--tint-sky:   #1b6ca8;
--tint-lime:  #58963f;

--tint-coral-fg: #7a2417;
--tint-sky-fg:   #0f3f63;
--tint-lime-fg:  #2f5722;

--tint-coral-wash: color-mix(in srgb, var(--tint-coral) 12%, transparent);
--tint-sky-wash:   color-mix(in srgb, var(--tint-sky) 12%, transparent);
--tint-lime-wash:  color-mix(in srgb, var(--tint-lime) 12%, transparent);
```

- [ ] **Step 4: Visual sanity check**

Spin up `app` and open devtools → Computed → search "tint-coral". Verify the variable resolves to a color. Toggle light/dark theme via the existing ThemeToggle — verify both variants apply.

- [ ] **Step 5: Commit**

```bash
git add app/src/tokens.css
git commit -m "feat: add coral/sky/lime tint tokens (dark + light)"
```

---

## Task 11: `use-presence-color` hook + test

**Files:**
- Create: `app/src/lib/use-presence-color.ts`
- Create: `app/test/use-presence-color.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/test/use-presence-color.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { presenceColorFor, PRESENCE_COLORS } from "../src/lib/use-presence-color";

test("returns a stable color for the same userId", () => {
  expect(presenceColorFor("u_alice")).toBe(presenceColorFor("u_alice"));
});

test("color belongs to the 10-color palette", () => {
  for (const id of ["u_alice", "u_bob", "u_carol", "u_dan", "u_eve"]) {
    expect(PRESENCE_COLORS).toContain(presenceColorFor(id));
  }
});

test("palette has exactly 10 entries", () => {
  expect(PRESENCE_COLORS).toHaveLength(10);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd app && bun test test/use-presence-color.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
/* use-presence-color.ts — deterministic userId → tint over 10-color palette. */

export const PRESENCE_COLORS = [
  "rose",
  "amber",
  "mint",
  "teal",
  "indigo",
  "violet",
  "slate",
  "coral",
  "sky",
  "lime",
] as const;

export type PresenceColor = (typeof PRESENCE_COLORS)[number];

export function presenceColorFor(userId: string): PresenceColor {
  let hash = 5381;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) + hash + userId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PRESENCE_COLORS.length;
  return PRESENCE_COLORS[idx]!;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd app && bun test test/use-presence-color.test.ts
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/use-presence-color.ts app/test/use-presence-color.test.ts
git commit -m "feat: use-presence-color — deterministic 10-color hash"
```

---

## Task 12: Add yjs deps (server + client)

**Files:**
- Modify: `server/package.json`
- Modify: `app/package.json`

- [ ] **Step 1: Add server deps**

```bash
cd server && bun add yjs y-protocols
```

This adds them to `dependencies` and updates `bun.lock`.

- [ ] **Step 2: Add client deps**

```bash
cd app && bun add yjs y-protocols y-websocket
```

- [ ] **Step 3: Typecheck both**

```bash
cd server && bun run typecheck && cd ../app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/bun.lock app/package.json app/bun.lock
git commit -m "chore: add yjs + y-protocols + y-websocket"
```

---

## Task 13: `presence-room.ts` — `InMemoryPresenceTransport` + tests

**Files:**
- Create: `server/src/realtime/presence-room.ts`
- Create: `server/test/presence-room.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/presence-room.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { InMemoryPresenceTransport } from "../src/realtime/presence-room";

function fakeWs(state: number = WebSocket.OPEN) {
  const sent: Uint8Array[] = [];
  return {
    sent,
    ws: {
      readyState: state,
      send: (msg: Uint8Array) => sent.push(msg),
    } as unknown as import("bun").ServerWebSocket,
  };
}

test("broadcastAwareness fans out to all peers except the sender", () => {
  const t = new InMemoryPresenceTransport();
  const a = fakeWs();
  const b = fakeWs();
  const c = fakeWs();
  t.join("dim_1", a.ws);
  t.join("dim_1", b.ws);
  t.join("dim_1", c.ws);

  const payload = new Uint8Array([1, 2, 3]);
  t.broadcastAwareness("dim_1", payload, a.ws);

  expect(a.sent).toHaveLength(0);
  expect(b.sent).toEqual([payload]);
  expect(c.sent).toEqual([payload]);
});

test("broadcastAwareness skips peers in non-OPEN state", () => {
  const t = new InMemoryPresenceTransport();
  const a = fakeWs(WebSocket.OPEN);
  const b = fakeWs(2 /* CLOSING */);
  t.join("dim_1", a.ws);
  t.join("dim_1", b.ws);

  t.broadcastAwareness("dim_1", new Uint8Array([9]));

  expect(b.sent).toHaveLength(0);
});

test("leave + rejoin keeps the room alive across the 2s GC grace", async () => {
  const t = new InMemoryPresenceTransport({ gcGraceMs: 50 });
  const a = fakeWs();
  t.join("dim_1", a.ws);
  t.leave("dim_1", a.ws);

  // Immediate rejoin — room must still exist
  const b = fakeWs();
  t.join("dim_1", b.ws);
  expect(t.roomCount()).toBe(1);

  await new Promise((r) => setTimeout(r, 80));
  // Room still alive because b is in it
  expect(t.roomCount()).toBe(1);
});

test("room is GC'd after grace if it stays empty", async () => {
  const t = new InMemoryPresenceTransport({ gcGraceMs: 30 });
  const a = fakeWs();
  t.join("dim_1", a.ws);
  t.leave("dim_1", a.ws);

  await new Promise((r) => setTimeout(r, 60));
  expect(t.roomCount()).toBe(0);
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd server && bun run test test/presence-room.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `server/src/realtime/presence-room.ts`:

```typescript
/* presence-room.ts — in-memory awareness fan-out for /ws/presence/:tableId.
 * The PresenceTransport interface exists so we can swap to a Redis-pubsub
 * implementation without touching the route handler. */

import type { ServerWebSocket } from "bun";

export type RowTouchedHint = {
  type: "row_touched";
  rowKey: string;
  userId: string;
  txnId?: string;
};

export interface PresenceTransport {
  join(tableId: string, ws: ServerWebSocket): void;
  leave(tableId: string, ws: ServerWebSocket): void;
  broadcastAwareness(tableId: string, payload: Uint8Array, except?: ServerWebSocket): void;
  broadcastRowTouched(tableId: string, hint: RowTouchedHint): void;
  roomCount(): number;
}

type Room = {
  peers: Set<ServerWebSocket>;
  gcTimer: ReturnType<typeof setTimeout> | null;
};

export class InMemoryPresenceTransport implements PresenceTransport {
  private rooms = new Map<string, Room>();
  private gcGraceMs: number;

  constructor(opts: { gcGraceMs?: number } = {}) {
    this.gcGraceMs = opts.gcGraceMs ?? 2000;
  }

  join(tableId: string, ws: ServerWebSocket): void {
    let room = this.rooms.get(tableId);
    if (!room) {
      room = { peers: new Set(), gcTimer: null };
      this.rooms.set(tableId, room);
    }
    if (room.gcTimer) {
      clearTimeout(room.gcTimer);
      room.gcTimer = null;
    }
    room.peers.add(ws);
  }

  leave(tableId: string, ws: ServerWebSocket): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    room.peers.delete(ws);
    if (room.peers.size === 0) {
      room.gcTimer = setTimeout(() => {
        const current = this.rooms.get(tableId);
        if (current && current.peers.size === 0) this.rooms.delete(tableId);
      }, this.gcGraceMs);
    }
  }

  broadcastAwareness(tableId: string, payload: Uint8Array, except?: ServerWebSocket): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    for (const peer of room.peers) {
      if (peer === except) continue;
      if (peer.readyState !== 1 /* OPEN */) continue;
      try {
        peer.send(payload);
      } catch {
        // Peer raced into CLOSING — silently skip.
      }
    }
  }

  broadcastRowTouched(tableId: string, hint: RowTouchedHint): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    const msg = JSON.stringify(hint);
    for (const peer of room.peers) {
      if (peer.readyState !== 1) continue;
      try {
        peer.send(msg);
      } catch {
        /* skip */
      }
    }
  }

  roomCount(): number {
    return this.rooms.size;
  }
}

export const presence: PresenceTransport = new InMemoryPresenceTransport();
```

- [ ] **Step 4: Run, expect pass**

```bash
cd server && bun run test test/presence-room.test.ts
```

Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/realtime/ server/test/presence-room.test.ts
git commit -m "feat: presence-room — in-memory awareness fan-out + tests"
```

---

## Task 14: WebSocket upgrade branch in `server.ts`

**Files:**
- Modify: `server/src/server.ts` (Bun.serve `fetch` + `websocket` handlers)

- [ ] **Step 1: Import the transport**

At the top of `server.ts`, add:

```typescript
import { presence } from "./realtime/presence-room.ts";
import { decodeAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
```

(If `awareness` exports differ in your installed version, check `node_modules/y-protocols/awareness.d.ts` and import accordingly. The minimum need is the protocol envelope bytes — we just relay them, we don't decode them, so the raw `Uint8Array` is enough. The imports above are optional.)

- [ ] **Step 2: Add the upgrade branch before the main `fetch` body**

Inside the `Bun.serve({ fetch: async (req, server) => { ... } })` function body, at the very top before the existing `/health` check, add:

```typescript
const url = new URL(req.url);
if (url.pathname.startsWith("/ws/presence/")) {
  const tableId = url.pathname.slice("/ws/presence/".length);
  if (!tableId) return new Response("missing tableId", { status: 400 });

  // Auth gate — reuse existing session helper
  const userId = await sessionUserIdFrom(req); // <-- use whatever helper auth.ts exposes
  if (!userId) return new Response("unauthorized", { status: 401 });

  const ok = server.upgrade(req, {
    data: { tableId, userId },
    headers: { "X-Powered-By": "zugzug-presence" },
  });
  return ok ? undefined : new Response("upgrade failed", { status: 500 });
}
```

Replace `sessionUserIdFrom(req)` with the actual session-resolution call used by the rest of `server.ts` (search for how other authenticated routes resolve `me`).

- [ ] **Step 3: Add the `websocket` block to `Bun.serve`**

Beside `fetch:`, add:

```typescript
websocket: {
  idleTimeout: 0, // we manage idle ourselves; Bun's default 120s drops idle stewards
  open(ws) {
    const { tableId } = ws.data as { tableId: string; userId: string };
    presence.join(tableId, ws);
  },
  message(ws, msg) {
    const { tableId } = ws.data as { tableId: string; userId: string };
    // Awareness protocol envelope is binary; we relay verbatim. JSON messages
    // (e.g. heartbeats from y-websocket) are also passed through unchanged.
    const payload =
      typeof msg === "string"
        ? new TextEncoder().encode(msg)
        : msg instanceof Uint8Array
          ? msg
          : new Uint8Array(msg as ArrayBuffer);
    presence.broadcastAwareness(tableId, payload, ws);
  },
  close(ws) {
    const { tableId } = ws.data as { tableId: string; userId: string };
    presence.leave(tableId, ws);
  },
},
```

- [ ] **Step 4: Manual smoke**

```bash
cd server && bun run dev
```

In another shell, connect with `wscat`:

```bash
npx wscat -c "ws://localhost:8787/ws/presence/test-dim" --header "Cookie: session=<your-session>"
```

Expected: connection opens, stays alive. Type anything → no error (no other peer to receive). Disconnect; check server logs for a join/leave.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts
git commit -m "feat: /ws/presence/:tableId WebSocket upgrade branch"
```

---

## Task 15: Client `use-presence` hook

**Files:**
- Create: `app/src/lib/use-presence.ts`

- [ ] **Step 1: Create the hook**

```typescript
/* use-presence.ts — y-websocket + standalone Awareness for live cursors. */

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Awareness } from "y-protocols/awareness";
import { presenceColorFor, type PresenceColor } from "./use-presence-color";

export type PeerState = {
  userId:      string;
  displayName: string;
  color:       PresenceColor;
  cell:        { row: number; col: number } | null;
  selection:   { row: number; col: number; rowEnd: number; colEnd: number } | null;
  away:        boolean;
};

const AWAY_AFTER_MS = 120_000;        // 2 min
const REMOVE_AFTER_MS = 600_000;      // 10 min
const CURSOR_THROTTLE_MS = 33;        // ~30 Hz

export function usePresence(
  tableId: string | null,
  me: { userId: string; displayName: string },
): { peers: PeerState[]; setCell: (row: number, col: number) => void; away: boolean } {
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [away, setAway] = useState(false);
  const awarenessRef = useRef<Awareness | null>(null);
  const lastSendRef = useRef(0);

  useEffect(() => {
    if (!tableId) return;

    const doc = new Y.Doc(); // throwaway, never carries data in E1
    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/presence`;
    const provider = new WebsocketProvider(wsUrl, tableId, doc, { connect: true });
    const awareness = provider.awareness as Awareness;
    awarenessRef.current = awareness;

    awareness.setLocalState({
      userId:      me.userId,
      displayName: me.displayName,
      color:       presenceColorFor(me.userId),
      cell:        null,
      selection:   null,
      lastActiveAt: Date.now(),
    });

    function syncPeers() {
      const states = Array.from(awareness.getStates().entries());
      const now = Date.now();
      const next: PeerState[] = states
        .filter(([clientId]) => clientId !== awareness.clientID)
        .map(([, s]) => {
          const last = (s.lastActiveAt as number | undefined) ?? now;
          const ageMs = now - last;
          if (ageMs > REMOVE_AFTER_MS) return null;
          return {
            userId:      s.userId,
            displayName: s.displayName,
            color:       s.color,
            cell:        ageMs > AWAY_AFTER_MS ? null : s.cell,
            selection:   ageMs > AWAY_AFTER_MS ? null : s.selection,
            away:        ageMs > AWAY_AFTER_MS,
          } as PeerState;
        })
        .filter((p): p is PeerState => p != null);
      setPeers(next);
    }
    awareness.on("change", syncPeers);
    const tick = window.setInterval(syncPeers, 5_000);

    // Idle detection
    let lastActive = Date.now();
    function bump() {
      lastActive = Date.now();
      const cur = awarenessRef.current;
      if (cur) {
        const s = cur.getLocalState() ?? {};
        cur.setLocalState({ ...s, lastActiveAt: lastActive });
      }
      if (away) setAway(false);
    }
    function checkIdle() {
      if (Date.now() - lastActive > AWAY_AFTER_MS && !away) setAway(true);
    }
    const idleTimer = window.setInterval(checkIdle, 5_000);
    window.addEventListener("mousemove", bump);
    window.addEventListener("keydown", bump);

    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("keydown", bump);
      window.clearInterval(idleTimer);
      window.clearInterval(tick);
      awareness.off("change", syncPeers);
      provider.destroy();
      doc.destroy();
      awarenessRef.current = null;
    };
  }, [tableId, me.userId, me.displayName]);

  function setCell(row: number, col: number) {
    const now = performance.now();
    if (now - lastSendRef.current < CURSOR_THROTTLE_MS) return;
    lastSendRef.current = now;
    const cur = awarenessRef.current;
    if (!cur) return;
    const s = cur.getLocalState() ?? {};
    cur.setLocalState({ ...s, cell: { row, col }, lastActiveAt: Date.now() });
  }

  return { peers, setCell, away };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors. (If `WebsocketProvider` types complain, check the y-websocket version — may need `@types/y-websocket` or an inline `as any`.)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/use-presence.ts
git commit -m "feat: use-presence — y-websocket + standalone Awareness"
```

---

## Task 16: `CursorOverlay` component

**Files:**
- Create: `app/src/components/datagrid/CursorOverlay.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useRef } from "react";
import type { PeerState } from "../../lib/use-presence";

type Rect = { top: number; left: number; width: number; height: number };

export function CursorOverlay({
  peers,
  cellRect,
}: {
  peers: PeerState[];
  cellRect: (row: number, col: number) => Rect | null;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {peers.map((p) => {
        if (!p.cell) return null;
        const r = cellRect(p.cell.row, p.cell.col);
        if (!r) return null;
        return <PeerCursor key={p.userId} peer={p} rect={r} />;
      })}
    </div>
  );
}

function PeerCursor({ peer, rect }: { peer: PeerState; rect: Rect }) {
  const labelRef = useRef<HTMLDivElement | null>(null);

  // Reset the fade timer every time the peer's cell coords change.
  useEffect(() => {
    const el = labelRef.current;
    if (!el) return;
    el.dataset.stale = "false";
    const t = window.setTimeout(() => {
      if (el) el.dataset.stale = "true";
    }, 1800);
    return () => window.clearTimeout(t);
  }, [peer.cell?.row, peer.cell?.col]);

  return (
    <div
      className="zz-peer-cell group/peer absolute"
      style={{
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        transform: "translate3d(0,0,0)",
      }}
    >
      <div
        className="absolute inset-0 border-l-2"
        style={{
          borderColor: `var(--tint-${peer.color})`,
          backgroundColor: `var(--tint-${peer.color}-wash)`,
        }}
      />
      <div
        ref={labelRef}
        data-stale="false"
        className="zz-peer-label absolute -top-5 left-0 rounded-pill px-1.5 py-0.5 font-mono text-[10px]"
        style={{
          backgroundColor: `var(--tint-${peer.color}-wash)`,
          color: `var(--tint-${peer.color}-fg)`,
        }}
      >
        {peer.displayName}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the fade-and-hover CSS to `globals.css`**

Open `app/src/globals.css`. Add (alongside any existing `zz-*` utility classes):

```css
.zz-peer-label {
  opacity: 1;
  transition: opacity 400ms var(--ease, ease-out);
}
.zz-peer-label[data-stale="true"] {
  opacity: 0;
}
.zz-peer-cell:hover .zz-peer-label {
  opacity: 1 !important;
}
```

(If `--ease` isn't a defined token, drop it and use `ease-out` literally.)

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/CursorOverlay.tsx app/src/globals.css
git commit -m "feat: CursorOverlay — cell-level peer highlights + 1.8s label fade"
```

---

## Task 17: Wire `CursorOverlay` + `usePresence` into `DataGrid`

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx`

- [ ] **Step 1: Locate the grid container**

The grid is wrapped in a `relative` container that already hosts the virtualized rows. Find it.

- [ ] **Step 2: Add the hook + overlay**

In `DataGrid`:

```tsx
import { usePresence } from "../../lib/use-presence";
import { CursorOverlay } from "./CursorOverlay";

// inside the component:
const me = useCurrentUser(); // existing hook or store selector
const { peers, setCell } = usePresence(tableId, { userId: me.id, displayName: me.name });

// In the cell focus handler:
function handleCellFocus(row: number, col: number) {
  // ...existing focus logic
  setCell(row, col);
}

// Add a cell-rect lookup using the existing virtual row state:
function cellRect(row: number, col: number) {
  const rowEl = rowRefs.current.get(row);
  const colEl = rowEl?.querySelector<HTMLElement>(`[data-col="${col}"]`);
  if (!colEl || !gridContainerRef.current) return null;
  const grid = gridContainerRef.current.getBoundingClientRect();
  const cell = colEl.getBoundingClientRect();
  return {
    top: cell.top - grid.top,
    left: cell.left - grid.left,
    width: cell.width,
    height: cell.height,
  };
}

// In the render:
<div ref={gridContainerRef} className="relative ...">
  {/* existing virtualized rows */}
  <CursorOverlay peers={peers} cellRect={cellRect} />
</div>
```

The `rowRefs` and `data-col` attributes may not exist yet — add them as needed (cells already have implicit positioning via grid columns; you may need to add `data-col={i}` to each cell or use `getBoundingClientRect` on the row + a column-width array).

- [ ] **Step 3: Multi-window smoke**

```bash
cd server && bun run dev &
cd app && bun run dev
```

Open `http://localhost:5173/app/tables` in two browser windows (one in normal mode, one in private/incognito so they have different sessions). Focus different cells in each. Verify the other window shows the peer's cell highlighted in their assigned color.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx
git commit -m "feat: wire CursorOverlay into DataGrid"
```

---

## Task 18: `PresenceStrip` component

**Files:**
- Create: `app/src/components/datagrid/PresenceStrip.tsx`

- [ ] **Step 1: Create the component**

```tsx
import type { PeerState } from "../../lib/use-presence";

export function PresenceStrip({ peers }: { peers: PeerState[] }) {
  const visible = peers.slice(0, 8);
  const overflow = peers.length - visible.length;
  return (
    <div className="flex items-center gap-1">
      {visible.map((p) => (
        <span
          key={p.userId}
          title={p.away ? `${p.displayName} (away)` : p.displayName}
          className={
            p.away
              ? "inline-flex h-5 w-5 items-center justify-center rounded-pill font-mono text-[9px] font-medium opacity-40 grayscale ring-[1.5px] ring-offset-1 ring-offset-surface ring-line-2 transition-all"
              : "inline-flex h-5 w-5 items-center justify-center rounded-pill font-mono text-[9px] font-medium ring-[1.5px] ring-offset-1 ring-offset-surface transition-all"
          }
          style={p.away ? undefined : { ringColor: `var(--tint-${p.color})` as never }}
        >
          {initials(p.displayName)}
        </span>
      ))}
      {overflow > 0 && (
        <span className="font-mono text-[10px] text-ink-3">+{overflow}</span>
      )}
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
```

(Tailwind's `ringColor` arbitrary value via inline style is brittle — if it doesn't render, replace with `style={{ boxShadow: \`0 0 0 1.5px var(--tint-\${p.color})\` }}`.)

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/PresenceStrip.tsx
git commit -m "feat: PresenceStrip — toolbar avatar strip with away state"
```

---

## Task 19: Mount `PresenceStrip` in `TablePane` toolbar

**Files:**
- Modify: `app/src/components/TablePane.tsx`

- [ ] **Step 1: Wire the strip into the toolbar**

In `TablePane.tsx`, lift the `peers` from `usePresence` (or re-use the same `usePresence` call if `TablePane` and `DataGrid` share it via context — if not, accept the duplication for E1 and refactor in E2).

Add the strip to the right side of the existing toolbar row:

```tsx
import { PresenceStrip } from "./datagrid/PresenceStrip";
// ...
<div className="toolbar-right flex items-center gap-3">
  <PresenceStrip peers={peers} />
  {/* existing controls */}
</div>
```

- [ ] **Step 2: Multi-window visual smoke**

Open two windows on the same table. Confirm both avatars appear in the strip on both sides.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "feat: mount PresenceStrip in TablePane toolbar"
```

---

## Task 20: `row_touched` hint emission + client invalidation

**Files:**
- Modify: `server/src/repo-canonical.ts` (and `repo-drafts.ts` if `commit()` should fan-out)
- Modify: `app/src/lib/use-row-activity.ts` (listen on the same WS used by `use-presence`)
- Modify: `app/src/lib/use-presence.ts` (expose `onRowTouched` callback)

- [ ] **Step 1: Emit hints from server after each per-row audit**

In `server/src/repo-canonical.ts`, after each per-row `appendAuditAs(...)` call we updated in Task 3, add:

```typescript
import { presence } from "./realtime/presence-room.ts";
// after each per-row appendAuditAs in renameCanonical / addCanonicalOne / mergeCanonicals / retireCanonical / setFieldValue:
presence.broadcastRowTouched(dimId, { type: "row_touched", rowKey: <key>, userId });
```

Use the appropriate `<key>` variable in scope at each site (`k` for create, `key` for rename/retire/setFieldValue, `survivor` for merge).

In `server/src/repo-drafts.ts` inside the new per-row loop from Task 4, after each `appendAuditAs(...)`:

```typescript
presence.broadcastRowTouched(dimId, { type: "row_touched", rowKey: row.target_key, userId });
```

- [ ] **Step 2: Expose a `onRowTouched` listener from `use-presence`**

In `use-presence.ts`, extend the hook return value:

```typescript
return { peers, setCell, away, onRowTouched };
```

Where `onRowTouched` is a `(handler: (hint: RowTouchedHint) => void) => () => void` subscription registered on the same `WebsocketProvider` instance. The provider exposes the raw socket — attach a `message` listener that tries `JSON.parse`, checks `type === "row_touched"`, and dispatches.

Concretely, inside the same `useEffect`:

```typescript
const handlers = new Set<(h: any) => void>();
const onMessage = (ev: MessageEvent) => {
  if (typeof ev.data !== "string") return;
  try {
    const hint = JSON.parse(ev.data);
    if (hint?.type === "row_touched") handlers.forEach((h) => h(hint));
  } catch { /* not JSON, ignore */ }
};
provider.ws?.addEventListener("message", onMessage);
// ...in cleanup:
provider.ws?.removeEventListener("message", onMessage);
```

Expose the subscription helper via a `ref` so callers can register/unregister:

```typescript
const onRowTouched = (h: (hint: any) => void) => {
  handlers.add(h);
  return () => handlers.delete(h);
};
```

- [ ] **Step 3: Hook the invalidation into `use-row-activity`**

`use-row-activity` already polls every 5 s; on a `row_touched` hint we want to refetch sooner. The cleanest way: have `use-row-activity` accept an `onRowTouched` registrar:

```typescript
export function useRowActivity(
  tableId: string | null,
  registerHint?: (handler: (hint: { rowKey: string }) => void) => () => void,
) {
  // ...inside the effect, after `poll()` starts:
  const unsub = registerHint?.((hint) => {
    // Trigger an immediate refetch by clearing the serverTime baseline
    serverTimeRef.current = new Date(Date.now() - 2_000).toISOString();
    poll();
  });
  // ...in cleanup: unsub?.();
}
```

In the call site (likely `DataGrid` or `TablePane`):

```tsx
const { peers, onRowTouched } = usePresence(tableId, me);
const activity = useRowActivity(tableId, onRowTouched);
```

- [ ] **Step 4: Multi-window smoke**

Two windows, same table. In window A: rename a canonical. In window B: confirm the inline badge appears within ~100 ms (much faster than the 5 s poll).

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-canonical.ts server/src/repo-drafts.ts app/src/lib/
git commit -m "feat: row_touched hints + fast badge invalidation"
```

---

## Task 21: Manual smoke walkthrough

**Files:** none (walkthrough only)

- [ ] **Step 1: Start fresh**

```bash
cd server && bun run dev &
cd app && bun run dev
```

Open three browser sessions (normal, private, second-private) signed in as three distinct users (use `DEV_BYPASS_AUTH=true` with three different `?as=u_alice|u_bob|u_carol` query params if the bypass supports it, or sign in via three Google accounts).

- [ ] **Step 2: Scenario 1 — concurrent cell focus**

User A focuses cell `[3, 2]` in `dim_country`. Users B and C should see A's cell highlighted in A's color with A's name label.

User B focuses the same cell `[3, 2]`. The cell should now show both A's left-border and B's right-border indicator.

User C focuses the same cell. The indicators should collapse to a `+1` badge (only if the polish from Task 16's follow-up was applied; otherwise expect both visible).

- [ ] **Step 3: Scenario 2 — idle/away**

User A stops moving the mouse and keyboard for 2 minutes. Users B and C: A's cursor disappears from the grid; A's avatar in the presence strip greys with `opacity-40 grayscale`.

User A bumps the mouse. A becomes active again within the next 5 s sync.

- [ ] **Step 4: Scenario 3 — reconnect**

User A kills their tab and reopens within 1 s. User B sees A briefly disappear from the strip and reappear; A's awareness is rebroadcast.

Stop the server (`Ctrl+C`). All three windows show their own avatars dropping; awareness clears. Restart the server. Within ~2 s all three reconnect and re-broadcast.

- [ ] **Step 5: Scenario 4 — commit-while-watching**

User A is viewing `dim_country`. User B renames `gbr → "United Kingdom"`. User A should see:
- The inline row badge for that row update to "Bob · just now" within ~100 ms (via `row_touched` hint).
- The full audit-log row in the existing global audit view (separate from this epic).

- [ ] **Step 6: Scenario 5 — 24h decay**

(Skip if you don't want to wait 24 h.) Verify a row touched 25 h ago no longer shows a badge.

- [ ] **Step 7: Final commit (notes only)**

If any polish gaps were noted during smoke, capture them as a TODO list in a comment on the spec or a follow-up issue. Do not paper over them with hot-fixes inside this plan.

```bash
git log --oneline -25
# Verify the 20 feature commits + this plan are all present.
```

---

## Self-review notes

- **Spec coverage:** Every spec section maps to at least one task. Migration (Task 1), `appendAuditAs` extension (Task 2), per-row back-population (Tasks 3-4), activity query + route (Tasks 5-6), badge hook + component + wiring (Tasks 7-9), color tokens + palette (Tasks 10-11), yjs deps (Task 12), server presence room + WS upgrade (Tasks 13-14), client presence hook + cursor overlay + wiring (Tasks 15-17), presence strip (Tasks 18-19), `row_touched` hint emission + invalidation (Task 20), manual smoke (Task 21).
- **Out-of-scope items remain out:** No row locking, no global notification bell, no activity dock, no toast, no y-postgres persistence, no multi-instance — none of these have tasks. Correct.
- **Type consistency:** `RowActivityEntry`, `PeerState`, `RowTouchedHint`, `PresenceColor`, `AuditOp` are defined once and referenced consistently.
- **Frequent commits:** Every task ends in a single commit; total 21 commits.
- **TDD where it pays:** Tasks 5, 11, 13 are red-green-refactor. Tasks 13's presence-room tests cover the three failure modes the websocket-engineer agent flagged (readyState guard, fast-reconnect race, GC grace). Tasks 14-21 are exercised by manual multi-window smoke since faithfully unit-testing browser WebSocket + virtualized DOM positioning is more cost than value at E1's scope.
