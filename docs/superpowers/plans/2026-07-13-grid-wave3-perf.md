# Grid Wave 3 — Perf Ceiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Phase 0 performance budget (audit §2 exit criteria) now that row virtualization works: collapse the boot drafts N+1 into one request, remove the last per-scroll costs, replace the 5s activity poll with a WebSocket push, and — only if a clean boot re-measure still misses 1.5s — defer per-table rows behind lazy loading.

**Architecture:** Keep the hand-rolled DOM grid (audit architecture verdict). Server changes are pure Postgres (drafts batch, aggregate counts) following the CLAUDE.md data-access rules. The activity push reuses the already-half-built presence room (`RowTouchedHint` + `broadcastRowTouched` exist; nothing calls or consumes them yet). The wave opens and closes with measurement against the audit harness.

**Tech Stack:** Bun + `postgres.js` (`server/`), React 18 + Vite + Tailwind v4 (`app/`), Vitest (app tests), `bun:test` (server tests), Playwright + CDP (measurement harness, scratchpad-only).

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from `docs/superpowers/specs/2026-07-13-grid-wave3-perf-design.md`.

- **Data-access rules (CLAUDE.md):** OLTP → `postgres.js` (`server/src/pg.ts`); warehouse reads → DuckDB; cross-store joins in app code; never a DuckDB→Postgres ATTACH. Schema changes → Drizzle migration; dynamic `dim_*/map_*` stay imperative DDL. **This wave adds no schema.**
- **Tenant scoping:** every new query is tenant-scoped exactly like its neighbors (`this.tenantId` inside `TenantRepo`). The test role has `BYPASSRLS`, so add explicit multi-tenant tests for any new cross-table read.
- **Banned user-facing vocabulary:** never surface `canonical`, `raw`, `triage`, `master`, `golden`, `commit`, `sync`, `tenant`, `matching`. This wave adds no user-facing copy; any incidental string obeys the list.
- **Budget is the exit gate:** the wave is not done until the audit §2 budget table passes on a clean re-measure (Task 8). Item D (Task 7) runs **only if** Task 1's clean baseline shows boot→interactive on the real brand table **above 1.5s** after Item A lands.
- **Test commands:** app → `cd app && bun run test` (Vitest) and `cd app && bun run typecheck`. Server → `cd server && bun run test` (needs `docker compose -f docker-compose.test.yml up -d --wait` once) and `cd server && bun run typecheck`.
- **Commits:** small and frequent, one per task step group. Conventional-commit prefixes matching the branch history (`feat(grid):`, `fix(grid):`, `perf(grid):`, `test(grid):`).

## Budget table (audit §2 — Task 8 re-runs every row)

| Scenario | Target |
|---|---|
| Wheel scroll @ 10k×30 | 55+ FPS sustained; **no long task >200ms** |
| Mounted rows | ≤60 row elements regardless of count; grid DOM <5k nodes @ 30 cols |
| Keystroke→paint | <50ms; ArrowDown held ≥30 FPS with cursor tracking |
| 50k×30 | renders and scrolls (30 FPS acceptable) |
| Boot→interactive, real brand (5.3k) | **<1.5s** warm dev server *(this row gates Item D)* |
| Deep link `?open=a,brand&active=brand` cold | opens both tabs, brand active, every time |

---

## Task 1: Clean baseline measurement harness

**Purpose:** The audit's post-0.1 boot number was taken under parallel-agent load and is explicitly inconclusive. This task rebuilds the harness (the scratchpad script from the audit is gone) and captures a clean baseline with the box otherwise idle. **The boot→rows number on the real brand table decides whether Task 7 (Item D) runs.**

**Environment dependency (read first):** This task needs the dev app running (`app` on :5173, `server` API on :8787) against a database that contains the **real brand table (~5.3k rows)**. Scroll/FPS scenarios use synthetic rows injected at the network layer (real DB untouched); the boot-baseline scenario needs real brand data. If the local DB has no brand table, the boot-baseline row cannot be measured here — record that explicitly in the ledger and treat Item D's gate as **undecided → defer Item D** (do not build it speculatively). Surface this to the human before proceeding.

**Files:**
- Create: `<session-scratchpad>/harness.mjs` (Playwright + CDP; **not committed** — scratchpad only, per audit §2)
- Create/append: this plan's **Progress ledger** section (bottom of this file) — commit the recorded numbers as a docs edit.

**Interfaces:**
- Produces: a `baseline` ledger block with `bootRealBrandMs`, `wheelFps10k30`, `longestTaskMs10k30`, `arrowDownFps`, `keystrokePaintMs`. Task 7's gate reads `bootRealBrandMs`. Task 8 re-runs the same script for the final table.

- [ ] **Step 1: Ensure Playwright is available**

Run (in the session scratchpad dir):
```bash
cd <session-scratchpad>
npm init -y >/dev/null 2>&1
npm i -D playwright@^1.60 >/dev/null 2>&1
npx playwright install chromium
```
Expected: chromium downloads without error.

- [ ] **Step 2: Write the harness script**

Mirror the audit method (§2): headless Chromium, dev-login session, synthetic rows injected by intercepting the `dimensions?full=true` response, **all non-GET API calls blocked**, wheel = 4s continuous wheel over the grid, arrow-hold = 3s held ArrowDown, keystroke = keydown→paint via double-rAF. Page under audit: `/app/default/tables?open=a%2Cbrand&active=brand`.

Create `<session-scratchpad>/harness.mjs`:
```js
import { chromium } from "playwright";

const APP = "http://localhost:5173";
const PAGE = "/app/default/tables?open=a%2Cbrand&active=brand";

// Build N synthetic rows in the full=true shape the store expects.
function synthRows(n, cols) { /* clone one real dim, replace .canonical with n rows × cols fields */ }

async function measure({ rows, cols, real }) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Block all non-GET API calls; inject synthetic rows for non-real runs.
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") return route.abort();
    if (!real && /dimensions\?full=true/.test(req.url())) {
      const res = await route.fetch();
      const body = await res.json();
      // replace row arrays with synthRows(rows, cols); keep metadata
      return route.fulfill({ response: res, json: /* patched */ body });
    }
    return route.continue();
  });

  // dev-login: hit /api/auth/dev (same path BootGate uses) before navigating.
  const client = await ctx.newCDPSession(page);
  await client.send("Performance.enable");
  const t0 = Date.now();
  await page.goto(APP + PAGE);
  await page.waitForSelector('[data-row]');           // boot→rows
  const bootMs = Date.now() - t0;

  // wheel 4s over the grid; sample FPS + longest task via CDP tracing / rAF counter.
  // arrow-hold 3s; keystroke→paint double-rAF. Return the metrics object.
  await browser.close();
  return { bootMs, /* wheelFps, longestTaskMs, arrowDownFps, keystrokePaintMs */ };
}

const scenarios = [
  { name: "brand-real", real: true },
  { name: "1k", rows: 1000, cols: 5 },
  { name: "10k", rows: 10000, cols: 5 },
  { name: "10k30", rows: 10000, cols: 30 },
  { name: "50k30", rows: 50000, cols: 30 },
];
for (const s of scenarios) console.log(s.name, await measure(s));
```
(Flesh out `synthRows`, the FPS sampler, and the keystroke probe from the audit-prompt Track A description. Keep it a single self-contained file.)

- [ ] **Step 3: Start the dev app idle and run the harness**

Run:
```bash
# terminal 1: cd server && bun run start
# terminal 2: cd app && bun run dev
cd <session-scratchpad> && node harness.mjs
```
Expected: prints one metrics line per scenario. `50k30` may hang pre-fix — record "hang" if it times out.

- [ ] **Step 4: Record the baseline in the Progress ledger**

Append the numbers to the **Progress ledger** at the bottom of this plan. Explicitly state whether `brand-real` boot was measurable (real brand table present) and its value.

- [ ] **Step 5: Decide Item D gate and commit the ledger**

Rule: `bootRealBrandMs` **< 1.5s (after Item A lands, re-measure in Task 8)** → **skip Task 7**. `≥ 1.5s` → **run Task 7**. Undecided (no brand data) → **defer Task 7**, surface to human. Note the decision in the ledger.

```bash
git add docs/superpowers/plans/2026-07-13-grid-wave3-perf.md
git commit -m "docs(grid): wave 3 clean perf baseline + Item D gate decision"
```

---

## Task 2: Item A (server) — `listAllDrafts` + batch route

**Problem.** Cold boot fires one `GET /dimensions/:id/drafts` per table (`store.ts` `Promise.all(dims.map(...))`) — ~20 requests. Collapse to one tenant-scoped SELECT.

**Files:**
- Modify: `server/src/repo-drafts.ts` (add `listAllDrafts`)
- Modify: `server/src/tenant-repo.ts:341` (add wrapper next to `listDrafts`)
- Modify: `server/src/server.ts` (add `GET /api/t/:slug/drafts` route near the tenant-route block, after `reqRepo` is constructed at :569)
- Test: `server/src/repo-drafts.test.ts` (extend — follow its existing fixtures)

**Interfaces:**
- Produces: `listAllDrafts(tenantId: string): Promise<Draft[]>` (repo-drafts) and `TenantRepo.listAllDrafts(): Promise<Draft[]>`. `Draft` is unchanged (`server/src/repo-shared.ts:231`, already carries `dimId`). Client (Task 3) consumes the flat `Draft[]`.

- [ ] **Step 1: Write the failing server test**

In `server/src/repo-drafts.test.ts`, add (using the file's existing tenant/dim/draft fixtures — seed drafts under **two** dims and **two** tenants):
```ts
test("listAllDrafts returns every dim's drafts for the tenant in one call", async () => {
  // seed: dim A has 2 drafts, dim B has 1 draft, all under tenant T1
  const all = await listAllDrafts(T1);
  expect(all.map((d) => d.dimId).sort()).toEqual(["dimA", "dimA", "dimB"].sort());
});

test("listAllDrafts is tenant-scoped — a second tenant's drafts never appear", async () => {
  // seed: tenant T2 has a draft under dim A
  const all = await listAllDrafts(T1);
  expect(all.every((d) => d.dimId !== "dimA_t2")).toBe(true);
});

test("listAllDrafts returns [] for an empty workspace", async () => {
  expect(await listAllDrafts(T_EMPTY)).toEqual([]);
});
```
Add `listAllDrafts` to the import from `../src/repo-drafts.ts`.

- [ ] **Step 2: Run the test — verify it fails**

Run: `cd server && bun run test repo-drafts`
Expected: FAIL — `listAllDrafts is not a function` / not exported.

- [ ] **Step 3: Implement `listAllDrafts`**

In `server/src/repo-drafts.ts`, add below `listDrafts` (reuse its exact projection/user-hydration shape, drop the `dim_id = $1` filter, keep `tenant_id = $1`):
```ts
export async function listAllDrafts(tenantId: string): Promise<Draft[]> {
  const rows = await pgAll<{
    dimId: string; raw: string; status: "mapped" | "skipped";
    targetLabel: string | null; targetKey: string | null; uid: string;
    secs: number; source: "user" | "ai";
    confidence: "high" | "medium" | "low" | null; reasoning: string | null;
  }>(
    `SELECT dim_id AS "dimId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs,
            source, confidence, reasoning
     FROM ${pg("draft")} WHERE tenant_id = $1 ORDER BY dim_id, created_at DESC`,
    [tenantId],
  );
  if (rows.length === 0) return [];
  const uids = Array.from(new Set(rows.map((r) => r.uid)));
  const users = await pgAll<User>(
    `SELECT id, name, initials FROM ${pg("users")} WHERE id = ANY($1::text[])`,
    [uids],
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  const unknownUser: User = { id: "unknown", name: "Unknown", initials: "??" };
  return rows.map((r) => ({
    dimId: r.dimId, raw: r.raw, status: r.status,
    targetLabel: r.targetLabel, targetKey: r.targetKey,
    user: byId.get(r.uid) ?? unknownUser,
    at: new Date(Date.now() - r.secs * 1000).toISOString(),
    source: r.source, confidence: r.confidence, reasoning: r.reasoning,
  }));
}
```
(Match the exact `.map(...)` shape already used by `listDrafts` in this file — copy it verbatim, only the query WHERE clause and ORDER BY differ.)

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd server && bun run test repo-drafts`
Expected: PASS (all three new tests green).

- [ ] **Step 5: Add the `TenantRepo` wrapper**

In `server/src/tenant-repo.ts`, next to `listDrafts` (~:341):
```ts
listAllDrafts(): Promise<Draft[]> {
  return this.withClearCtx(() => repoDrafts.listAllDrafts(this.tenantId));
}
```

- [ ] **Step 6: Add the batch route**

In `server/src/server.ts`, inside the authenticated tenant-route region (after `const reqRepo = new TenantRepo(...)` at :569, alongside the other `tenantSlugFromPath !== null` routes), add:
```ts
// GET /api/t/:slug/drafts — all drafts for the workspace in one query (boot path).
if (tenantSlugFromPath !== null && seg[1] === "drafts" && seg.length === 2 && method === "GET") {
  return json(await reqRepo.listAllDrafts());
}
```
Gate is the same read auth as the per-dim drafts GET (no `gateOrJson("curate")` — that guard is only on PUT/DELETE).

- [ ] **Step 7: Typecheck, then commit**

Run: `cd server && bun run typecheck`
Expected: no errors.
```bash
git add server/src/repo-drafts.ts server/src/tenant-repo.ts server/src/server.ts server/src/repo-drafts.test.ts
git commit -m "feat(grid): batch drafts endpoint — one query replaces the boot N+1"
```

---

## Task 3: Item A (client) — `refreshDrafts()` uses the batch endpoint

**Files:**
- Modify: `app/src/store.ts` (`refreshDrafts` no-arg branch, ~:399-405)
- Test: `app/test/store-refresh-drafts.test.ts` (create)

**Interfaces:**
- Consumes: `GET /drafts` (via `api("/drafts")` → `/api/t/:slug/drafts`) returning `Draft[]`.
- Produces: unchanged `draftsFlat` keyed by `dkey(dimId, raw)`. The keyed form `refreshDrafts(dimId)` is **untouched**.

- [ ] **Step 1: Write the failing test**

Create `app/test/store-refresh-drafts.test.ts` — mock `apiFetch` (or global fetch) and assert the boot path issues exactly one request and populates `draftsFlat` identically to the old fan-out. Follow the mocking pattern in `app/test/api.test.ts`:
```ts
test("refreshDrafts() issues exactly one request to /drafts and flattens by dkey", async () => {
  const calls: string[] = [];
  // stub apiFetch to record paths and return a two-dim Draft[] for "/drafts"
  // ...load store, call the exported boot refresh, read the drafts selector...
  expect(calls.filter((u) => u.endsWith("/drafts")).length).toBe(1);
  expect(calls.some((u) => /\/dimensions\/.+\/drafts/.test(u))).toBe(false);
  // draftsFlat has both dims' drafts, keyed dimId::raw
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `cd app && bun run test store-refresh-drafts`
Expected: FAIL — old code fans out per-dim (`/dimensions/:id/drafts` calls present, `/drafts` absent).

- [ ] **Step 3: Rewrite the no-arg branch**

In `app/src/store.ts`, replace the `Promise.all(dims.map(...))` block in `refreshDrafts` (keep the `if (dimId) { ... }` keyed branch exactly as-is):
```ts
async function refreshDrafts(dimId?: string): Promise<void> {
  if (dimId) {
    const list = await api<Draft[]>(`/dimensions/${encodeURIComponent(dimId)}/drafts`);
    const next: Record<string, Draft> = {};
    for (const [k, d] of Object.entries(draftsFlat)) if (d.dimId !== dimId) next[k] = d;
    for (const d of list) next[dkey(d.dimId, d.raw)] = d;
    draftsFlat = next;
    return;
  }
  const list = await api<Draft[]>("/drafts");
  const flat: Record<string, Draft> = {};
  for (const d of list) flat[dkey(d.dimId, d.raw)] = d;
  draftsFlat = flat;
}
```
`initStore` still `await refreshDrafts()` after `refreshDims()` (order harmless; the no-arg path no longer needs the dim list).

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd app && bun run test store-refresh-drafts`
Expected: PASS.

- [ ] **Step 5: Typecheck, then commit**

Run: `cd app && bun run typecheck`
```bash
git add app/src/store.ts app/test/store-refresh-drafts.test.ts
git commit -m "feat(grid): boot fetches drafts in one request via the batch endpoint"
```

---

## Task 4: Item B — Scroll-path hygiene (behavior-preserving)

**Problem (§2.5).** Three per-scroll costs now that rows slide under a stationary pointer: (1) `applyColumnHover` runs two `querySelectorAll` sweeps on every cell `onMouseEnter`; (2) `transition-colors` animates every row background on reflow; (3) `isFirstPinned` recomputes O(cols²) per cell.

**Files:**
- Modify: `app/src/components/datagrid/DataGridRow.tsx` (:342 className; :384 `isFirstPinned`)
- Modify: `app/src/components/datagrid/DataGrid.tsx` (:514-532 `applyColumnHover`; :538-558 `data-scrolled` signal)
- Test: `app/test/datagrid-first-pinned.test.tsx` (create)

**Interfaces:**
- Produces: a `firstPinnedField: string | null` computed once per render in `DataGrid`/`DataGridBody` and passed to rows/cells, replacing the per-cell `columns.slice(0, idx).some(...)`. `gridCellAreEqual`'s `isFirstPinned` comparison stays intact.

- [ ] **Step 1: Write the failing render test for first-pinned**

Create `app/test/datagrid-first-pinned.test.tsx` — assert the first-pinned flag is correct for a multi-pin column set and unchanged behavior:
```tsx
test("only the leftmost pinned column is flagged first-pinned", () => {
  // columns: [pinned:Record, pinned:Key, normal:Name, normal:Rank]
  // render the grid; the Record cell/header carries the first-pinned marker,
  // Key does not, normals do not.
});
```
(Use the existing datagrid test harness in `app/test/datagrid-*.test.tsx` for setup.)

- [ ] **Step 2: Run the test — verify it fails or passes-as-baseline**

Run: `cd app && bun run test datagrid-first-pinned`
Expected: PASS against current behavior (this test pins behavior *before* the refactor — it must still pass after). If it can't be written against current props, note why and make it pass post-refactor.

- [ ] **Step 3: Hoist the first-pinned computation**

Compute once where columns are known (in `DataGrid`/`DataGridBody`, before the row map):
```ts
const firstPinnedField = useMemo(
  () => columns.find((c) => c.pinnedLeft)?.field ?? null,
  [columns],
);
```
Thread `firstPinnedField` into `GridRowProps`/`GridCellProps`. In `DataGridRow.tsx` replace `:384`:
```ts
// was: const isFirstPinned = !!(c.pinnedLeft && !columns.slice(0, idx).some((x) => x.pinnedLeft));
const isFirstPinned = c.pinnedLeft === true && c.field === firstPinnedField;
```
Keep `gridCellAreEqual`'s `prev.isFirstPinned === next.isFirstPinned` line unchanged.

- [ ] **Step 4: Drop `transition-colors` from the row**

In `DataGridRow.tsx:342`, remove `transition-colors` only (hover background still applies instantly):
```tsx
className={cx(
  "relative group grid items-stretch border-b border-line",
  selected ? "bg-surface-2" : "hover:bg-hover",
)}
```

- [ ] **Step 5: Gate the hover sweep during scroll**

Prefer the CSS route if it reproduces the highlight: replace the JS `querySelectorAll` sweep with a CSS `:has([data-field="..."]:hover)` rule and delete `applyColumnHover` + its call sites. If CSS can't reproduce it, fall back to gating: skip `applyColumnHover` while the grid's existing scroll signal is active (the `data-scrolled` attribute machinery at `DataGrid.tsx:538-558` — read/extend it to expose an `isScrollingRef`, and early-return from `applyColumnHover` when set). Pick one; document which in the commit body.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd app && bun run test datagrid && cd app && bun run typecheck`
Expected: first-pinned test PASS; no datagrid regressions; types clean.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx app/src/components/datagrid/DataGridRow.tsx app/test/datagrid-first-pinned.test.tsx
git commit -m "perf(grid): remove per-scroll hover sweep, row transition, and O(cols^2) pin recompute"
```

---

## Task 5: Item C (server) — emit `row_touched` from the audit path

**Problem.** `useRowActivity` polls every 5s. The push channel is half-built: `presence-room.ts` defines `RowTouchedHint` + `broadcastRowTouched`, but nothing calls it. Emit from the one central point every row-scoped write flows through: `appendAuditAs`.

**Files:**
- Modify: `server/src/repo-meta.ts:24` (`appendAuditAs` — emit after the INSERT)
- Modify: row-scoped `appendAuditAs` call sites that pass `rowKey` without `tableId` (audit: `server/src/repo-canonical.ts` add/rename/merge/retire/insert-at-position/field-write)
- Test: `server/test/row-touched-broadcast.test.ts` (create)

**Interfaces:**
- Consumes: `presence.broadcastRowTouched(tableId, hint, tenantId)` and `RowTouchedHint` from `./realtime/presence-room.ts` (already exported).
- Produces: exactly one broadcast per row-scoped audit write, in the correct tenant room, best-effort (a transport throw never fails the write).

- [ ] **Step 1: Write the failing server test**

Create `server/test/row-touched-broadcast.test.ts` — stub/observe `presence.broadcastRowTouched` (spy on the imported `presence` object), trigger a row-scoped write (e.g. `setFieldValue`), assert exactly one broadcast with the right `rowKey`/`userId` in the right tenant room; and assert a transport throw does not fail the write:
```ts
test("a row-scoped write broadcasts exactly one row_touched to the tenant room", async () => {
  const seen: Array<{ tableId: string; hint: RowTouchedHint; tenantId: string }> = [];
  spyOn(presence, "broadcastRowTouched").mockImplementation((tableId, hint, tenantId) =>
    void seen.push({ tableId, hint, tenantId }));
  await repo.setFieldValue(dimId, rowKey, "rank", "5"); // row-scoped write under T1
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ tableId: dimId, tenantId: T1,
    hint: { type: "row_touched", rowKey, userId: U1 } });
});

test("a presence-transport throw does not fail the write", async () => {
  spyOn(presence, "broadcastRowTouched").mockImplementation(() => { throw new Error("ws down"); });
  await expect(repo.setFieldValue(dimId, rowKey, "rank", "6")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd server && bun run test row-touched-broadcast`
Expected: FAIL — no broadcast emitted (0 seen).

- [ ] **Step 3: Emit from `appendAuditAs`**

In `server/src/repo-meta.ts`, import `presence` + `RowTouchedHint` from `./realtime/presence-room.ts`. After the audit INSERT succeeds, add:
```ts
// Best-effort activity push. Row-scoped writes carry tableId + rowKey; hint the room
// so peers refetch instead of polling. A presence failure must never fail the write.
if (ctx.tableId && ctx.rowKey) {
  try {
    presence.broadcastRowTouched(
      ctx.tableId,
      { type: "row_touched", rowKey: ctx.rowKey, userId },
      ctx.tenantId ?? "default",
    );
  } catch { /* transport down — the 60s client safety net covers it */ }
}
```
(`"default"` matches the existing `ctx.tenantId ?? "default"` convention in this file — do not invent a `DEFAULT_TENANT` symbol unless one already exists.)

- [ ] **Step 4: Ensure row-scoped callers pass `tableId`**

Run: `grep -n "appendAuditAs" server/src/repo-canonical.ts` and for every call that passes `rowKey` (add/rename/merge/retire/insert-at-position/field-write), confirm the same ctx object also passes `tableId` (the dim id). Add `tableId: dimId` where a `rowKey` is present without one. Non-row writes (column/field-meta edits) stay as-is.
Expected outcome: every row-scoped audit ctx has both `tableId` and `rowKey`.

- [ ] **Step 5: Run — verify it passes**

Run: `cd server && bun run test row-touched-broadcast`
Expected: PASS (both tests).

- [ ] **Step 6: Typecheck + commit**

Run: `cd server && bun run typecheck`
```bash
git add server/src/repo-meta.ts server/src/repo-canonical.ts server/test/row-touched-broadcast.test.ts
git commit -m "feat(grid): broadcast row_touched from the audit path (activity push)"
```

---

## Task 6: Item C (client) — presence text-frame → push-driven `useRowActivity`

**Problem.** yjs awareness frames are **binary** (`ArrayBuffer`); the hint is a JSON **string**. `usePresence` must tap the socket for text frames only and invoke an `onRowTouched` callback; `useRowActivity` replaces its 5s poll with a debounced refetch + a 60s safety net.

**Files:**
- Modify: `app/src/lib/use-presence.ts` (raw `message` listener for string frames; `onRowTouched` param + shape guard)
- Modify: `app/src/lib/use-row-activity.ts` (drop 5s poll; keep one initial fetch; debounced refetch on push; 60s safety net)
- Modify: `app/src/components/.../TablePane.tsx` (~:206-212 — wire `usePresence`'s `onRowTouched` into `useRowActivity`)
- Test: `app/test/use-row-activity-push.test.ts` (create); `app/test/row-touched-guard.test.ts` (create)

**Interfaces:**
- Consumes: string frames `{type:"row_touched", rowKey, userId}` on the presence socket.
- Produces: `usePresence(..., { onRowTouched })`; `useRowActivity(tableId, { refetchSignal })` (or a returned `bump()` — pick one wiring and keep it consistent across both files and `TablePane`).

- [ ] **Step 1: Write the failing shape-guard test**

Create `app/test/row-touched-guard.test.ts` — a `sanitizePeerCell`-style guard (`isRowTouchedHint`) that accepts only well-formed hints:
```ts
test("isRowTouchedHint accepts a valid hint and rejects malformed / non-row_touched strings", () => {
  expect(isRowTouchedHint({ type: "row_touched", rowKey: "k", userId: "u" })).toBe(true);
  expect(isRowTouchedHint({ type: "other", rowKey: "k", userId: "u" })).toBe(false);
  expect(isRowTouchedHint({ rowKey: 1 })).toBe(false);
  expect(isRowTouchedHint(null)).toBe(false);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd app && bun run test row-touched-guard`
Expected: FAIL — `isRowTouchedHint` not exported.

- [ ] **Step 3: Add the guard + text-frame listener in `usePresence`**

In `app/src/lib/use-presence.ts`, export (mirror `sanitizePeerCell`):
```ts
export interface RowTouchedHint { type: "row_touched"; rowKey: string; userId: string }
export function isRowTouchedHint(raw: unknown): raw is RowTouchedHint {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Record<string, unknown>;
  return c.type === "row_touched" && typeof c.rowKey === "string" && typeof c.userId === "string";
}
```
Add an `onRowTouched?: (hint: RowTouchedHint) => void` param. After the provider connects, attach a raw listener on the underlying socket that acts **only** on string frames (binary stays with y-websocket):
```ts
const ws = provider.ws; // y-websocket's underlying WebSocket
const onMessage = (event: MessageEvent) => {
  if (typeof event.data !== "string") return;      // binary → y-websocket
  try {
    const parsed = JSON.parse(event.data);
    if (isRowTouchedHint(parsed)) onRowTouched?.(parsed);
  } catch { /* ignore non-JSON text */ }
};
ws?.addEventListener("message", onMessage);
// cleanup: ws?.removeEventListener("message", onMessage)
```
(If the provider recreates its socket on reconnect, re-attach via the provider's `status`/`connection` hook — verify against the y-websocket version in `app/package.json` and follow its API.)

- [ ] **Step 4: Write the failing push test for `useRowActivity`**

Create `app/test/use-row-activity-push.test.ts`:
```ts
test("one initial fetch, then a row_touched schedules a single debounced refetch; no 5s poll", async () => {
  // render useRowActivity; assert exactly 1 fetch initially
  // fire a row_touched bump; advance timers ~250ms; assert exactly 1 more fetch
  // advance 5s with no push; assert NO extra fetch (poll is gone)
});
test("binary frames never trigger a refetch", async () => { /* dispatch ArrayBuffer → 0 refetches */ });
test("the 60s safety net still fires", async () => { /* advance 60s → 1 refetch */ });
```

- [ ] **Step 5: Run — verify it fails**

Run: `cd app && bun run test use-row-activity-push`
Expected: FAIL — current hook still polls every 5s.

- [ ] **Step 6: Make `useRowActivity` push-driven**

In `app/src/lib/use-row-activity.ts`: keep exactly one initial 24h-backfill fetch. Remove `POLL_INTERVAL_MS`/the 5s `setTimeout` loop. Add: a debounced (~250ms) refetch triggered by a push signal (coalesces paste-fill bursts), plus a long 60s safety-net poll for missed pushes/reconnect gaps. Accept the push signal from the caller (a `refetchNonce`/`bump` prop the hook `useEffect`-depends on).

- [ ] **Step 7: Wire them together in `TablePane`**

At `TablePane.tsx:~206-212`, connect `usePresence`'s `onRowTouched` (filtered to the active table's rowKeys, or unconditional refetch — the debounce coalesces) to bump `useRowActivity`:
```ts
const [activityNonce, setActivityNonce] = useState(0);
const activity = useRowActivity(activeId, { refetchNonce: activityNonce });
const presence = usePresence(currentUser ? activeId : null, {
  userId: currentUser?.id ?? "",
  displayName: currentUser?.name ?? "",
  onRowTouched: () => setActivityNonce((n) => n + 1),
});
```

- [ ] **Step 8: Run tests + typecheck**

Run: `cd app && bun run test use-row-activity && cd app && bun run test row-touched-guard && cd app && bun run typecheck`
Expected: all PASS; types clean.

- [ ] **Step 9: Live probe (manual, two sessions)**

Two browser sessions on the same table; one edits a row, the other's activity badge updates in <500ms with **no** 5s poll on the wire (Network tab). Confirm y-websocket does not choke on the text frames (no console errors). Record pass/fail in the ledger.

- [ ] **Step 10: Commit**

```bash
git add app/src/lib/use-presence.ts app/src/lib/use-row-activity.ts app/src/components/**/TablePane.tsx app/test/use-row-activity-push.test.ts app/test/row-touched-guard.test.ts
git commit -m "feat(grid): activity is push-driven over the presence socket; drop the 5s poll"
```

---

## Task 7: Item D (GATED) — Lazy row-loading

**Runs only if** Task 1's baseline (re-measured after Item A in Task 8, or the Task 1 number if already conclusive) shows boot→interactive on the **real brand table above 1.5s**. If Item A + the height-chain fix already meet budget, **do not build this** — close the wave after Task 6 and skip to Task 8. If undecided (no brand data locally), defer and surface to the human.

**Why gated / invasive.** `full=true` returns every dim's full rows (695KB is row-dominated); **eight files / 14 sites read `dims[].canonical`**, including Dashboard (`Dashboard.tsx:484`) and Triage (`Triage.tsx:172,396`), which aggregate across **all** tables. Deferring per-table rows requires server-side aggregate endpoints so those views keep cross-table counts.

**Files (if built):**
- Modify: `server/src/server.ts` (`full=true` handler at ~:969 — return metadata + counts, omit `canonical` arrays; add a counts/aggregate route)
- Modify: `server/src/tenant-repo.ts` + a repo (add `dimCounts()` — one tenant-scoped Postgres query, per-dim tallies; no cross-store join)
- Modify: `app/src/store.ts` (per-dim `rowsLoaded` flag; `refreshDim` marks loaded; consumers tolerate unloaded)
- Modify: `app/src/routes/Dashboard.tsx:484`, `app/src/routes/Triage.tsx:172,396` (read the aggregate endpoint instead of summing `.canonical`)
- Modify: `app/src/components/.../TablePane.tsx`, `MatchModeBody.tsx` (load rows on table open)
- Test: `server/test/dim-counts.test.ts`, `app/test/lazy-rows.test.ts` (create)

**Interfaces:**
- Produces: `full=true` shape without `canonical` arrays but with `recordCount`/`mappedCount`; `GET /api/t/:slug/dim-counts` → per-dim tallies; store `rowsLoaded: Record<dimId, boolean>`.

- [ ] **Step 1 (server test):** `full=true` omits row arrays but includes counts; `dimCounts()` returns correct per-dim tallies, tenant-scoped. Write, run (FAIL).
- [ ] **Step 2 (server impl):** aggregate query (pure Postgres, `this.tenantId`); strip `canonical` from `full=true`; add the route. Run (PASS).
- [ ] **Step 3 (client test):** opening a table loads its rows once and caches them; Dashboard/Triage counts match the aggregate endpoint; unloaded dims render the skeleton (height chain already reserves space). Write, run (FAIL).
- [ ] **Step 4 (client impl):** `rowsLoaded` flag + on-open `refreshDim`; repoint Dashboard/Triage/Match at the aggregate/on-open loads. Run (PASS).
- [ ] **Step 5 (regression):** the 0.2 mounted-row guard and all `.canonical`-reading views still render (`cd app && bun run test` + `cd server && bun run test`). Typecheck both.
- [ ] **Step 6 (re-measure):** re-run the harness `brand-real` boot — must now be **<1.5s**. Record in ledger.
- [ ] **Step 7 (commit):** `git commit -m "perf(grid): defer per-table rows until a table opens; aggregate counts for cross-table views"`

---

## Task 8: Final budget verification + regression guard

**Purpose.** The wave is not done until the audit §2 budget table passes on a clean re-measure.

- [ ] **Step 1: Re-run every §2 scenario**

Run the harness (Task 1 script) idle for `1k / 10k / 10k×30 / 50k×30 / brand-real`. If Item A landed but Item D did not, **re-measure `brand-real` boot now** — this is the number that retroactively confirms the Item D gate decision.

- [ ] **Step 2: Check each budget row**

Every row in the budget table above must PASS or be explicitly **waived with a written reason** in the ledger (e.g. `50k×30` degraded-but-scrolls). Confirm: no long task >200ms during scroll @ 10k×30; ≤60 mounted rows; keystroke→paint <50ms; deep link cold opens both tabs.

- [ ] **Step 3: Confirm the 0.2 mounted-row regression guard still holds**

Run: `cd app && bun run test` (the mounted-row / virtualization guard from Phase 0.2 must still be green).
Expected: PASS.

- [ ] **Step 4: Vocabulary spot-check**

This wave adds no user-facing copy; grep any incidental new strings against the banned list (`canonical|raw|triage|master|golden|commit|sync|tenant|matching`).

- [ ] **Step 5: Record results and commit**

Fill the final ledger table; note any waivers.
```bash
git add docs/superpowers/plans/2026-07-13-grid-wave3-perf.md
git commit -m "docs(grid): wave 3 final budget verification"
```

---

## Progress ledger

_Filled during execution. Task 1 records the baseline; Task 8 records the final table._

**Baseline (Task 1):**

| Scenario | Boot→rows | Wheel FPS | Longest task | ArrowDown FPS | Keystroke→paint |
|---|---|---|---|---|---|
| brand-real (5.3k) | _tbd_ | — | — | — | — |
| 10k×30 | — | _tbd_ | _tbd_ | _tbd_ | _tbd_ |

- Real brand table present? _tbd_ · **Item D gate decision:** _tbd (run / skip / defer)_

**Final (Task 8):**

| Budget row | Target | Result | Pass? |
|---|---|---|---|
| Wheel @ 10k×30 | 55+ FPS, no task >200ms | _tbd_ | _tbd_ |
| Mounted rows | ≤60 | _tbd_ | _tbd_ |
| Keystroke→paint | <50ms | _tbd_ | _tbd_ |
| 50k×30 | renders/scrolls | _tbd_ | _tbd_ |
| Boot real brand | <1.5s | _tbd_ | _tbd_ |
| Deep link cold | both tabs | _tbd_ | _tbd_ |
