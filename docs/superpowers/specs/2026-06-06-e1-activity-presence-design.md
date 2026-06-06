# E1 — Activity & Presence — Design Spec

**Date:** 2026-06-06
**Status:** Ready for implementation
**Epic:** 1 of 4 in the realtime-collaboration initiative (E1 Activity & Presence, E2 Concurrent Editing Safety, E3 History & Rollback, E4 Branching / What-if Sandbox)

---

## Problem

Zugzug is a single-editor-feeling tool today. The audit log records every commit but never surfaces in the UI; two stewards opening the same dim table can silently clobber each other; nothing in the grid signals "Mia just touched this row 3 minutes ago." For a team that is starting to use Zugzug as the shared source of truth for dimension mappings, this is the next-largest gap after AI Triage Co-pilot.

This epic delivers the **foundation** for the rest of the realtime collaboration roadmap. The yjs awareness primitive and WebSocket transport built here will be reused by E2 for actual concurrent editing (CRDT merging of cell writes). The audit-log surfacing built here unblocks E3 (per-row history / rollback) and E4 (branched sandbox views).

---

## Solution

Two deliberately separated channels:

1. **Live presence (ephemeral, yjs awareness over WebSocket)** — cell-level live cursors and selections, throttled to 30 Hz. In-memory rooms keyed by table id. No persistence; cursors disappear on disconnect.
2. **Historical activity (persisted, Postgres audit log + polling)** — inline row badges showing "Mia · 3m ago", read from the existing audit log via a new covering index, polled every 5 s by the client. Decay window: 24 hours.

A small commit-time hint message (`{type: "row_touched", rowId, actorId, txnId}`) is broadcast over the presence channel to invalidate badge caches faster than the 5 s poll interval, collapsing observed staleness to ~50 ms — but Postgres remains the authority.

---

## Architecture

### Data flow

```
Browser (React)
  │
  ├── usePresence(tableId)
  │     └── y-websocket  ──►  /ws/presence/:tableId
  │                              └── PresenceRoom (in-memory Map<tableId, Room>)
  │                                    ├── Awareness relay (cursor, selection, identity)
  │                                    └── row_touched fan-out (post-commit hint)
  │
  └── useRowActivity(tableId)
        └── poll 5 s  ──►  GET /api/tables/:id/row-activity?since=<ts>
                              └── Postgres audit_log + covering index
                                    → Map<rowKey, { userId, displayName, op, at }>
```

### Three-store impact

- **Warehouse (MotherDuck `analytics`)** — no change.
- **Master store (MotherDuck `zugzug`)** — no change.
- **App state (Postgres `zugzug_app`)** — `audit_log` gains `table_id`, `row_key` columns + a covering index. All existing `repo.ts` write paths back-populate these. No new tables.

---

## Prerequisite migration (blocking)

The current `audit_log` schema is `(id, created_at, user_id, action, detail)`. The badge query needs `table_id` and `row_key`. This migration ships first as part of E1's first task, and every existing audit-log writer in `repo.ts` is updated to populate the new columns.

```sql
ALTER TABLE zugzug_app.audit_log
  ADD COLUMN table_id VARCHAR,
  ADD COLUMN row_key  VARCHAR;

-- Best-effort back-population from existing detail JSON; nullable columns stay null
-- for legacy rows where the table/row context cannot be recovered.

CREATE INDEX audit_log_table_row_recency_idx
  ON zugzug_app.audit_log (table_id, row_key, created_at DESC)
  WHERE table_id IS NOT NULL;
```

Writers to update (audit each call site in `repo.ts`, `repo-canonical.ts`, `repo-triage.ts`):
- canonical rename / create / archive
- field write (cell edit)
- triage commit
- bulk merge

If a call site cannot reasonably supply `table_id`+`row_key` (e.g. settings change), the new columns stay null — the badge query already filters on `table_id IS NOT NULL`.

---

## Server

### `server/src/realtime/presence-room.ts`

```ts
export interface PresenceTransport {
  join(tableId: string, ws: ServerWebSocket): void;
  leave(tableId: string, ws: ServerWebSocket): void;
  broadcastAwareness(tableId: string, payload: Uint8Array, except?: ServerWebSocket): void;
  broadcastRowTouched(tableId: string, hint: RowTouchedHint): void;
}

export class InMemoryPresenceTransport implements PresenceTransport { … }
```

- Rooms live in a `Map<string, Room>` where `Room = { awareness: Awareness, peers: Set<ServerWebSocket> }`.
- `Awareness` is instantiated **standalone** (with a throwaway `Y.Doc` that holds no state) — we don't need the document-sync protocol in E1, only the awareness protocol from `y-protocols/awareness`.
- `broadcastAwareness` iterates `room.peers`, **always re-looking-up the room from the map** at call time (never closing over a stale reference — guards against the room-GC race on fast reconnect).
- Every `ws.send()` is guarded by `ws.readyState === WebSocket.OPEN` — Bun throws synchronously on CLOSING sockets, which would otherwise abort the fan-out loop.
- GC: room is deleted when `room.peers.size === 0` **after a 2 s grace** to absorb fast reconnects.

The interface boundary is deliberate. The in-memory implementation is the only one we ship in E1. If we ever scale horizontally (today: not in the foreseeable future at 5–10 stewards), a Redis-pubsub implementation is a single-file swap.

### WebSocket route — added inline to `server/src/server.ts`

Following the existing `server.ts` route convention (all routes live in the single `Bun.serve` switch), add:

- A pre-`fetch` `server.upgrade` branch that matches `/ws/presence/:tableId`.
- Auth: existing session cookie. Reject with 401 on unauthenticated upgrade.
- **`idleTimeout: 0`** on the upgrade options — Bun's default 120 s would silently drop idle stewards (we stop broadcasting cursor moves on idle; the connection still needs to live).
- `websocket` handlers (`open`, `message`, `close`) delegate to `InMemoryPresenceTransport` exported from `server/src/realtime/presence-room.ts`. On `message`, decode the `awareness` protocol envelope and rebroadcast to all other peers in the same room. No server-side merging.

### `server/src/repo-activity.ts`

```ts
export type RowActivityEntry = {
  rowKey: string;
  userId: string;
  displayName: string;
  op: "rename" | "create" | "archive" | "field-write" | "merge" | "commit";
  at: Date;
};

export async function getRowActivitySince(
  tableId: string,
  since: Date,            // typically Date.now() - 24h
  newerThan?: Date,       // for delta polling
): Promise<RowActivityEntry[]>;
```

Query uses the covering index. Returns the latest entry per `row_key` in the time window.

### Activity route — added inline to `server/src/server.ts`

- `GET /api/tables/:id/row-activity?since=<iso>&newerThan=<iso>`
- Returns `{ entries: RowActivityEntry[], serverTime: string }`.
- The `serverTime` is what the client uses as `newerThan` on its next poll — avoids clock-skew races.

### Commit-time hint emission

In `server/src/repo.ts` and `server/src/repo-canonical.ts` (`commit()`, `renameCanonical()`, every field-write path), **after** the Postgres transaction commits, call:

```ts
presence.broadcastRowTouched(tableId, { rowKey, userId, op, at: new Date() });
```

The transport silently no-ops if the room is empty.

---

## Client

### `app/src/lib/use-presence.ts`

```ts
export function usePresence(tableId: string): {
  peers: Peer[];           // other users' awareness state
  setCell(row: number, col: number): void;
  setSelection(range: Range | null): void;
  away: boolean;           // this user's own away state
};
```

- Uses `y-websocket` provider attached to a standalone `Awareness` (no document content sync).
- Throttles `setCell` to 30 Hz via `requestAnimationFrame`.
- Listens to `document.visibilitychange` — when hidden, stops broadcasting cursor changes but keeps the socket open.
- Listens to `mousemove` / `keydown` to maintain a `lastActiveAt`. When `Date.now() - lastActiveAt > 120_000`, sets `away: true` and clears the broadcast cursor. After 10 minutes total inactivity, the awareness state for this user is cleared entirely.

### `app/src/components/datagrid/CursorOverlay.tsx`

- Absolutely-positioned overlay laid over the virtualized DataGrid.
- Renders one element per remote peer's focused cell:
  - **No blinking caret.** A 2 px left border on the cell in the peer's color, plus a `color-mix(...)` background wash. Same visual language as the existing local focus ring (`ring-2 ring-accent ring-inset bg-accent/30`), swapped to the peer's color token.
  - Name label as a small pill positioned at `top: -20px, left: 0` of the cell. Visible for 1.8 s after each awareness update, then fades to `opacity: 0` over 400 ms via a `data-stale` attribute toggled by `setTimeout`. Cell hover re-reveals via `group-hover`.
- **Same-cell stacking:** if a second peer focuses the same cell, their indicator is rendered on the cell's right edge (`right: 0`) with their own 2 px border. A third peer collapses both to a `+N` badge in the top-right corner (16 px circle, `font-mono text-[9px]`, background = first peer's wash).
- Position updates use CSS `transform: translate()` only — no React re-render per frame.

### `app/src/components/datagrid/RowActivityBadge.tsx`

- Renders inside `GridRow`, NOT as a column.
- **Resting state:** a 2 px vertical line at `left: 0, top: 0, bottom: 0` colored `text-line-2` when the row has activity in the last 24 h.
- **Row-hover state:** the line transitions to `bg-accent`; an inline badge slides in absolutely-positioned at `left: 2, top: 50%, translate-y: -50%`, overlapping the first cell's left padding (no layout shift).
- Badge content: `<Badge tone="neutral" className="font-mono text-[10px]">{displayName} · {relativeTime}</Badge>`.
- Click → opens a popover with full audit detail (op type with `tone="warn"`/`tone="danger"` differentiation, full timestamp, diff). The popover is the right surface for op-type semantics; the row-level pip is neutral-only.

### `app/src/lib/use-row-activity.ts`

- Fetches `/api/tables/:id/row-activity` every 5 s with `since = now - 24h` on first load, then `newerThan = serverTime` on subsequent polls.
- Listens to `row_touched` hints from the presence channel and **immediately invalidates** the affected `rowKey` (refetches just that row's entry or, cheaper, merges the hint directly into local state and refetches in the background to confirm).
- Filters out entries older than 24 h on the client (defensive — server already does this).

### `app/src/lib/use-presence-color.ts`

- Hashes `userId` deterministically to one of **10 presence colors** (Zugzug's existing 7 tints + 3 new: `coral`, `sky`, `lime`).
- The 3 new tints get full dark- and light-mode variants in `tokens.css`, matching the luminance pattern of the existing 7.
- Collisions at 30 users are statistically rare (3 per color at saturation); at 5–10 concurrent stewards they will functionally never happen.

### `app/src/components/datagrid/PresenceStrip.tsx`

- Compact row of 20 px circular avatars, right-aligned in the table toolbar.
- **Active peers:** 1.5 px ring in their tint color, full opacity.
- **Away peers** (idle 2–10 min): `opacity-40 grayscale ring-line-2` — visibly "here but stepped away."
- **Removed peers** (idle > 10 min): no longer in the strip.
- Max visible 8 avatars; overflow collapses to `+N`.

---

## Failure modes

| Case | Handling |
|---|---|
| WS disconnect (network blip) | y-websocket auto-reconnect with backoff. Remote peer cursors fade to 30% opacity after 5 s with no awareness update. |
| Server restart | All rooms drop; clients reconnect within ~1 s; awareness rebuilds. Row badges unaffected (Postgres-backed). |
| Tab hidden | Stop broadcasting cursor; keep socket open. Other peers see this user fade to away after 2 min. |
| User idle > 2 min | Local cursor stops broadcasting, presence strip greys avatar. |
| User idle > 10 min | Awareness entry cleared; avatar removed from presence strip. |
| Two peers on same cell | Right-edge offset; third+ collapses to `+N` badge. |
| `ws.send()` on CLOSING socket | `readyState === OPEN` guard; silently skip. |
| Fast reconnect (close → open in <100 ms) | 2 s GC grace; room is reused. If the room was GC'd between close and open, the reconnecting client re-broadcasts its full awareness state on `open` (provider does this automatically). |
| Commit lands but client polls before hint arrives | The 5 s poll picks it up; staleness window is bounded. |
| Postgres LISTEN/NOTIFY-style triggers | Not used — commit hints are emitted from application code, not from DB triggers. |

---

## Explicitly out of scope

- **No row or cell locking.** Last-write-wins on conflicting saves (existing behavior). E2 will introduce CRDT merging.
- **No global notification bell, no activity dock, no toast.** Only inline row badges.
- **No editing of the awareness payload.** Awareness is read-only outside cursor/selection state; persisted writes still flow through the existing HTTP `commit()` path.
- **No engineer-mode gating.** Everyone sees everyone's presence; no internal-table-name leakage risk because presence payloads carry only display names and cell coordinates.
- **No y-postgres persistence of the `Y.Doc`.** The doc is a throwaway carrier for the awareness protocol.
- **No multi-instance support.** Single Bun process only; `PresenceRoom` interface allows future Redis-pubsub swap.
- **No avatar photos.** Initials only in E1; photo support deferred to E2 if needed.

---

## Implementation order

1. Prerequisite migration: `audit_log.table_id`, `audit_log.row_key`, covering index, back-population of all existing writers in `repo.ts` and `repo-canonical.ts`.
2. `repo-activity.ts` + `GET /api/tables/:id/row-activity` route inline in `server.ts` + tests.
3. Client `use-row-activity` hook + `RowActivityBadge` + wire into `DataGrid` row rendering.
4. `realtime/presence-room.ts` (`InMemoryPresenceTransport`) + WebSocket upgrade branch in `server.ts`.
5. Client `use-presence` hook + `y-websocket` wiring + `Awareness` instance management.
6. `CursorOverlay` component + cell-coordinate translation against the virtualized rows.
7. `PresenceStrip` component + wire into table toolbar.
8. `use-presence-color` + add `coral` / `sky` / `lime` tokens to `tokens.css` with dark/light variants.
9. `row_touched` hint emission from `repo.ts` write paths + `use-row-activity` invalidation listener.
10. Manual smoke walkthrough with 3 browser windows: cursor visibility, same-cell stacking, idle/away, reconnect, commit-while-watching.

---

## Estimated effort

**~2 weeks for a single dev.**

Roughly: 3 d migration + back-population + activity endpoint, 2 d badge UI, 3 d WebSocket + presence room + auth/idle handling, 3 d cursor overlay + virtualized-grid coordinate maths, 1 d presence strip + colors, 1 d hint emission + invalidation, 1 d manual multi-window smoke + polish.
