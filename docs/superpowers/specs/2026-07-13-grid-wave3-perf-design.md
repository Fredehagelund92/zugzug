# Grid Wave 3 Design: Perf Ceiling (boot N+1, scroll hygiene, activity push, lazy rows)

Audit items 0.5, 0.6, 0.7 from `docs/grid-next-level-plan.md`. Finishes Phase 0.
Approved 2026-07-13 (build A/B/C unconditionally; gate D — lazy rows — behind a clean
boot re-measure). Roadmap context: `docs/grid-remaining-waves-roadmap.md`.

## Goal

Close the Phase 0 performance budget (audit §2 exit criteria) now that virtualization
works (0.1): boot→interactive with the real 5.3k-row brand table under 1.5s on a warm
dev server, no scroll long-task >200ms at 10k×30, and activity staleness in the tens of
milliseconds instead of 5 seconds.

## Global constraints (bind every item)

- **Data-access rules (CLAUDE.md):** OLTP → `postgres.js` (`server/src/pg.ts`); warehouse
  reads → DuckDB; cross-store joins in app code; never a DuckDB→Postgres ATTACH. Schema
  changes → Drizzle migration; dynamic `dim_*/map_*` stay imperative DDL.
- **Tenant scoping:** every new query is tenant-scoped exactly like its neighbors
  (route context / `this.tenantId`). The test role has `BYPASSRLS`, so add explicit
  multi-tenant tests for any new cross-table read.
- **Banned user-facing vocabulary:** never surface canonical, raw, triage, master, golden,
  commit, sync, tenant, matching. This wave adds no user-facing copy, but any incidental
  string obeys the list.
- **Budget is the exit gate:** the wave is not done until the audit §2 budget table passes
  on a clean re-measure.

## Measurement bookends (the spine)

The audit's post-0.1 boot number was taken under parallel-agent load and is explicitly
inconclusive. Wave 3 opens and closes with measurement.

- **Task 1 — clean baseline.** Rebuild the audit harness (Playwright + CDP against the dev
  app, dev-login session, synthetic rows injected by intercepting the
  `dimensions?full=true` response; all non-GET API calls blocked — the pattern in
  `docs/grid-audit-prompt.md` Track A). Capture, with the box otherwise idle: boot→rows
  with the real brand table; wheel FPS + longest task at 10k×30; ArrowDown FPS. Record the
  numbers in the plan's progress ledger. This baseline decides whether Item D runs.
- **Final task — budget verification.** Re-run every §2 scenario (1k / 10k / 10k×30 /
  50k×30 / brand-real) against the budget table; every row must pass or be explicitly
  waived with a reason. Confirm the 0.2 mounted-row regression guard still holds.

## Item A — Drafts N+1 → one batch endpoint (unconditional)

**Problem.** Cold boot fires one `GET /dimensions/:id/drafts` per table
(`store.ts:399-401`, `Promise.all(dims.map(...))`) — ~20 requests on today's workspace,
on top of the 695KB `full=true` payload.

**Design.**
- **Server:** new route `GET /api/t/:slug/drafts` → `listAllDrafts(tenantId)`: a single
  tenant-scoped SELECT over the `draft` table returning every dim's drafts (the same
  `Draft` shape the per-dim route returns, carrying `dimId`). No per-dim loop; no warehouse
  access (drafts are pure Postgres). Gated by the same read auth as the per-dim drafts route.
- **Client:** `refreshDrafts()` (the no-arg boot path) calls the batch endpoint and builds
  `draftsFlat` from the one response. The keyed form `refreshDrafts(dimId)` (used after a
  draft mutation, `store.ts:390-397`) is unchanged — drafts remain an independent slice that
  refreshes per-dim on write.
- **Result:** boot drafts cost goes from ~20 requests to 1. `initStore` still awaits
  `refreshDrafts()` after `refreshDims()` (it no longer needs the dim list to fan out, but
  keeping the order is harmless and preserves the single emit).

**Testing.** Server: `listAllDrafts` returns drafts across multiple dims in one call, is
tenant-scoped (a second tenant's drafts never appear), and returns `[]` for an empty
workspace. Client: `refreshDrafts()` issues exactly one request and populates `draftsFlat`
identically to the old fan-out.

## Item B — Scroll-path hygiene (0.6, unconditional)

**Problem.** Three per-scroll costs the audit flagged (§2.5), now that rows actually move
under a stationary pointer:
1. `applyColumnHover` (`DataGrid.tsx:515-527`) runs two `querySelectorAll` sweeps on every
   cell `onMouseEnter`, which fire continuously as virtualized rows slide past the cursor.
2. `transition-colors` on every row (`DataGridRow.tsx:342`) animates background on each
   reflow.
3. `isFirstPinned` is recomputed per cell with an O(cols²) `columns.slice(0, idx).some(...)`
   inside the render map (`DataGridRow.tsx:384`).

**Design.**
- Gate the hover sweep so it does not run during active scroll: skip `applyColumnHover`
  while a scroll is in flight (reuse/extend the grid's existing scroll-active signal), or
  move column-hover to CSS `:has([data-field=...]:hover)` and delete the JS sweep. Prefer
  the CSS route if it reproduces the current highlight; fall back to the scroll-gate.
- Remove `transition-colors` from the row className (`DataGridRow.tsx:342`). Hover
  background still applies instantly; only the animation is dropped.
- Compute the first-pinned column index once per render (a single left-to-right pass or a
  memo keyed on `columns`) and pass a boolean/`firstPinnedField` down, replacing the
  per-cell `columns.slice(...).some(...)`. Keep `gridRowAreEqual`'s `isFirstPinned`
  comparison intact.

**Testing.** A render test asserts the first-pinned flag is correct for a multi-pin column
set (unchanged behavior); no per-cell `slice().some()` remains. Hover highlight verified in
the harness walk (no functional regression). This item is behavior-preserving — the guard
is "no long task >200ms during scroll at 10k×30" in the final measurement.

## Item C — Activity poll → `row_touched` push (0.7, unconditional)

**Problem.** `useRowActivity` (`app/src/lib/use-row-activity.ts`) polls
`/api/tables/:id/row-activity` every 5s, re-rendering the pane and lagging real edits by up
to 5s. Roadmap #53. The channel is **half-built**: `presence-room.ts` already defines
`RowTouchedHint` and `broadcastRowTouched(tableId, hint, tenantId)`, but nothing server-side
calls it and nothing client-side consumes it.

**Design (invalidation model).**
- **Server emit — one central point.** Row-scoped audit writes all flow through
  `appendAuditAs(userId, action, detail, {tableId?, rowKey?, tenantId?})` (`repo-meta.ts:24`).
  After the audit INSERT succeeds, when both `ctx.tableId` and `ctx.rowKey` are present, call
  `presence.broadcastRowTouched(ctx.tableId, { type: "row_touched", rowKey: ctx.rowKey,
  userId }, ctx.tenantId ?? DEFAULT_TENANT)`. This covers every row-scoped write (add,
  rename, merge, retire, insert-at-position, field-write) in one place. Ensure the
  row-scoped call sites pass `tableId` (add it where a `rowKey` is passed without one).
  Broadcast is best-effort and fire-and-forget: a presence failure must never fail or roll
  back the write (wrap in try/catch, or emit after the transaction commits).
- **Client receive — tap the presence socket for text frames.** yjs awareness frames on the
  presence WebSocket are **binary** (`ArrayBuffer`); our hint is a JSON **string**. So
  `usePresence` adds a raw `message` listener on the provider's underlying socket that acts
  only when `typeof event.data === "string"`, parses `{type:"row_touched", ...}`, and invokes
  an `onRowTouched` callback. Binary frames are left entirely to y-websocket. Guard against
  y-websocket choking on unexpected text (it should ignore non-binary; verify in the live
  probe).
- **`useRowActivity` becomes push-driven.** Keep exactly one initial fetch (the 24h
  backfill). Replace the 5s poll with: on each `row_touched` for the active table, schedule a
  single **debounced (~250ms) refetch** (coalesces bursts like a paste-fill). Keep a long
  **60s safety-net poll** for missed pushes / reconnect gaps. Staleness collapses from 5s to
  ~50ms. The hook subscribes to the same presence room `useRowActivity` already keys on
  (`activeId`); wiring goes through the shared `usePresence` (both are mounted in
  `TablePane`, keyed on the same table).

**Testing.** Server: a row-scoped write (e.g. field-write) triggers exactly one
`broadcastRowTouched` with the right `rowKey`/`userId` in the correct tenant room; a
presence-transport throw does not fail the write. Client: `sanitizePeerCell`-style shape
guard for the hint (ignore non-`row_touched` / malformed strings); a `row_touched` event
schedules one debounced refetch; binary frames never trigger a refetch; the 5s poll is gone
and only the 60s safety net remains. Live probe: two sessions, one edits a row, the other
sees the activity badge update in <500ms with no 5s poll on the wire.

## Item D — Lazy row-loading (0.5 payload half, GATED)

**Runs only if** Task 1's clean baseline (with Item A already collapsing the drafts N+1)
still shows boot→interactive on the real brand table **above the 1.5s budget**. If Item A +
the height-chain fix already meet budget, **Item D is not built** and the wave closes after C.

**Why gated.** It is the one invasive change: `full=true` today returns every dim's full
canonical rows (the 695KB is row-dominated), and eight files / 14 sites read
`dims[].canonical` — including **Dashboard and Triage, which aggregate across *all* tables**.
Deferring per-table rows therefore also requires server-side aggregate endpoints so those
views keep their cross-table counts. The audit itself scoped this as conditional.

**Design (if built).**
- `full=true` returns dim **metadata + per-dim counts** (id, label, fields, ordering,
  `recordCount`, `mappedCount` as needed) but **not** the `canonical` row arrays.
- Opening a table fetches its rows (`refreshDim(dimId)` already returns the full shape,
  `store.ts:360-362`); the store marks a per-dim `rowsLoaded` flag and consumers tolerate the
  unloaded state (render the skeleton until loaded — the height chain already reserves space).
- **Dashboard / Triage:** add a dedicated counts/aggregate endpoint (single tenant-scoped
  query returning per-dim tallies) and point those views at it instead of summing
  `.canonical` from the cache. No cross-store join; pure Postgres.
- Match mode and other single-table consumers load rows on open like Records mode.

**Testing (if built).** Server: `full=true` omits row arrays but includes counts; the
aggregate endpoint returns correct per-dim tallies, tenant-scoped. Client: opening a table
loads its rows once and caches them; Dashboard/Triage counts match the aggregate endpoint;
re-measure shows boot under budget. Regression: the mounted-row guard and all
`.canonical`-reading views still render.

## Out of scope

- Column virtualization (not needed at ≤30 columns post-0.1; audit §Architecture verdict).
- Canvas grid body / grid-library migration (rejected in the audit).
- Any Wave 4 craft item or Wave 5 feature.
- Redis-backed presence (the in-memory transport's interface already allows a later swap;
  not this wave).
