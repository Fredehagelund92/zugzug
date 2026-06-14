# Row Ordering — Design Spec

**Date:** 2026-06-14
**Scope:** Make "Insert row above/below" do the right thing by introducing per-dimension manual ordering as an opt-in mode, alongside the existing derived sort. Adds a `position` column to `dim_*` tables, drag-to-reorder, and a clear interaction model for view-sorts vs. persisted order.

---

## Background

Two facts collided last week:

1. The right-click "Insert row above" / "Insert row below" handler in `app/src/components/TablePane.tsx:952` is a stub — it focuses the bottom "+ Add record" input regardless of which row was clicked. The DataGrid already wires `onInsertRow(key, "above" | "below")` (see `app/src/components/datagrid/DataGrid.tsx:653-661,804-811`) but the consumer ignores the direction.
2. The canonical `dim_*` tables have no position column. Reads are sorted by `ORDER BY variants DESC, label` (server/src/repo-canonical.ts:267, 276). Row order is a derived projection of the data, not a stored property — so "between rows 4 and 5" is undefined.

The terminology bleeds from spreadsheets, but Zugzug master records aren't a spreadsheet — they're a small, evolving registry of canonical values that BI joins against. The honest question: do users ever *need* an explicit manual order on these tables?

We surveyed the seeded dims and the way teams use them. Two cohorts emerged:

- **Reference dims** (countries, currencies, product categories) — order doesn't matter. Users sort by the column they care about in the moment.
- **Workflow-stage dims** (`lead_status: new → contacted → qualified → won`, `priority: p0 → p3`, `support_tier: bronze → silver → gold → platinum`) — there is a canonical, semantically meaningful order, and alphabetising it actively hurts comprehension. dbt models for funnel analysis assume this order. Today, users hack a `sort_order` numeric field by hand and it goes stale immediately.

So: we need manual ordering, but only some dimensions need it. And we need view-sorts that don't fight the persisted order.

---

## Goals / Non-goals

**Goals**
- "Insert row above/below" works deterministically — the new row appears where the user pointed.
- Workflow-stage dims get a persisted, drag-orderable order that BI consumers can rely on (`ORDER BY position`).
- Reference dims keep their existing derived sort (`variants DESC, label`) with zero migration overhead.
- View-sorts (click a column header) are per-user and never mutate the persisted order.
- Performance stays sane at 5k rows per dim (the current realistic ceiling).

**Non-goals**
- We are not building nested rows / outline view.
- We are not building per-row pinning ("always show this at the top").
- We are not building multi-column persisted sort. Manual order is one-dimensional.
- We are not changing the warehouse scan or `commit()` semantics. Mapping/variants order is unaffected.
- We are not building a server→client live-broadcast channel for canonical row changes. No `LISTEN/NOTIFY`, no SSE. Concurrency is handled with optimistic UI + refetch on next query invalidation (see §Edge cases).

---

## The Design

### The two ordering modes

A dimension is in one of two **ordering modes**:

1. **`derived`** (default, no migration) — `ORDER BY variants DESC, label` as today. The grid offers view-sort by any column; that view-sort overrides the default for that user only.
2. **`manual`** — `ORDER BY position` is the canonical persisted order. Drag-to-reorder is enabled. "Insert above/below" places the row between neighbours. View-sorts are still available but they're labelled "Sorted view (manual order is not active)" and a "Restore manual order" affordance appears in the toolbar.

The mode is per-dimension, set on creation and changeable from dim settings. **Switching modes is reversible but lossy on the manual → derived flip** — see Migration.

### Why a stored `position`, not LexoRank strings

Three options were considered for the index:

| Option | Pros | Cons |
|---|---|---|
| LexoRank (fractional string keys) | No rebalance needed for ~10k ops; widely used by Jira | Opaque strings (`"0|i00007:"` is unreadable in SQL); needs a custom comparator everywhere reads happen; dbt joins get awkward |
| Floating-point `double precision` | Trivial midpoint computation `(a+b)/2`; ~2^52 midpoint inserts before precision collapse | Non-portable across rendering engines and warehouses; harder to reason about for BI consumers; subtle equality bugs across `numeric`/`float8` |
| **Integer with explicit rebalance** | Predictable; dbt-friendly; trivial `ORDER BY`; allows `position % 100` UX tricks | Needs occasional rebalance (rare in practice — see §Rebalance) |

We're picking **integer with explicit rebalance**, using `BIGINT` (not `INT`) with steps of 1024 between rows. `BIGINT` removes any practical concern about head-insert underflow or tail-append overflow — head-inserts subtract 1024 indefinitely and we still have ~9.2 × 10^18 of headroom in each direction. LexoRank is the right call for issue trackers with hundreds of thousands of ordered items; for a reference-data registry with at most a few thousand rows per dim, integers are clearer and dbt-friendly.

### How "Insert above/below" computes a position

Given a row R with `position = P_r` and neighbours with positions `P_above` and `P_below`:

- **Insert above R**: new position = `floor((P_above + P_r) / 2)`. If R is the first row, new position = `P_r - 1024`.
- **Insert below R**: new position = `floor((P_r + P_below) / 2)`. If R is the last row, new position = `P_r + 1024`.
- If `|P_above - P_r| <= 1` (no room), trigger a rebalance for the whole dim, then retry. This is rare in practice — at step 1024 you'd need ~10 inserts at the same spot before colliding.

### Rebalance — when it runs

Rebalance walks the dim in `position ASC` order and reassigns `position = (rank * 1024)`. Triggers:

1. **Automatic, mid-write** — when an `INSERT_AT` or `PUT /position` lands at a midpoint with `<= 1` integer of gap. Runs inside the same transaction as the failed write; the client doesn't see the intermediate failure.
2. **Proactive, threshold-based** — when `MIN(position) < -2_000_000_000` OR `MAX(position) > 2_000_000_000`. These thresholds are well inside `BIGINT` headroom but produce a metric signal long before any plausible failure mode. Triggered as a side-effect of the next position-mutating write; logged in the audit feed.
3. **Manual** — Settings → Ordering → Advanced → Rebalance positions. Rate-limited via `dimension.last_rebalanced_at` (see §API.4 for the wire shape and §Data model.7 for the column).

### How "Add record" (the bottom + button) behaves

- **`derived` mode** — no `position` written; the row sorts where the variants/label projection puts it (today's behaviour).
- **`manual` mode** — `position = MAX(position) + 1024`, appended at the end. Computed inside the same transaction as the insert so two concurrent appends each get a distinct value (see §Write paths and concurrency).

### How `commit()` (drafts → canonical) handles position

The current `commit()` path inserts new canonical rows in a single statement using `INSERT INTO ${DIMT} (${key}, label) SELECT DISTINCT … NOT EXISTS …` (see `server/src/repo-drafts.ts:265-271`). `SELECT DISTINCT` has no deterministic ordering, so we cannot just append `(i+1) * 1024` against an undefined `i`. The fix wraps the SELECT in a deterministically-ordered subquery and assigns the position with `row_number()`:

```sql
-- Manual mode commit (Postgres). Wrapped in the existing pgTx with the
-- subsequent map_* insert + draft delete, so MAX is consistent with the write.
WITH max_pos AS (
  SELECT COALESCE(MAX(position), 0) AS m FROM ${DIMT}
),
ordered AS (
  SELECT
    target_key   AS k,
    target_label AS lbl,
    MIN(created_at) AS first_seen
  FROM ${DRAFT} d
  WHERE d.dim_id = $1 AND d.tenant_id = $2
    AND d.status = 'mapped' AND d.target_key IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)
  GROUP BY target_key, target_label
)
INSERT INTO ${DIMT} (${key}, label, position)
SELECT
  o.k, o.lbl,
  (SELECT m FROM max_pos) + 1024 * row_number() OVER (ORDER BY o.first_seen, o.k)
FROM ordered o;
```

In **derived mode** the existing `INSERT … SELECT DISTINCT … NOT EXISTS …` shape is unchanged — no `position` column is written. The branch is a server-side `if (meta.orderingMode === 'manual')`.

Why `MIN(created_at)` then key: two drafts may resolve to the same `(target_key, target_label)` (deduped via `GROUP BY`); the earliest draft creation date is a stable, human-meaningful ordering, with the key as a tiebreaker if `created_at` ties.

Drafts that resolve to *existing* canonical keys are still skipped via the `NOT EXISTS` clause — they're updates to `map_*`, not inserts.

### How view-sorts interact

The grid already has a per-user `GridLayoutConfig` (widths / order / hidden) persisted to `user_grid_layout.config`. The `config` column is `varchar` JSON, so we extend the TypeScript type with a new field — no SQL migration:

```ts
// app/src/store.ts
export interface GridLayoutConfig {
  widths?:  Record<string, number>;
  order?:   string[];
  hidden?:  string[];
  sort?:    { column: string; direction: "asc" | "desc" } | null;  // NEW
}
```

`setGridLayout` (the existing debounced PATCH) already serialises the whole object — no setter or server change. The grid reads `sort` on mount, after `getGridLayout(dimId)` resolves.

- In **`derived` mode**: a view-sort overrides the default `variants DESC, label`. No banner — derived sort is a projection of the data, not a user-curated decision; overriding it is a routine view choice with no semantic loss.
- In **`manual` mode**: a view-sort temporarily replaces the curator's persisted order. We render a banner and disable the drag handle. The rationale for the asymmetry: manual order is the curator's contract with downstream dbt consumers, so overriding it is something users should know they did.
- The drag handle is the *only* mutator of `position`. Clicking a column header never writes to canonical.

### Why hybrid (configurable per-dimension), not always-on

We considered the Linear pattern — sort by `(priority, createdAt)` where `priority` is the manual override. Linear can do this because every issue has the same set of fields and the same notion of priority. Zugzug dims are heterogeneous: countries don't have a meaningful priority; lead_status does. Adding a position to every dim and asking users to ignore it on the dims where it doesn't apply would visually clutter 80% of dims with a drag handle they don't want.

We also considered always-on `position` with a hidden default — but then the column quietly diverges from what users see, and migration of existing dims requires a backfill on every table even when nobody'll ever use it. Hybrid is the minimum viable surface.

---

## Data model

### 1. `zugzug_app.dimension` gains `ordering_mode` + `last_rebalanced_at`

```ts
// server/drizzle/schema.ts — extend `dimension`
ordering_mode:       varchar("ordering_mode").notNull().default("derived"),
last_rebalanced_at:  timestamp("last_rebalanced_at"),       // NEW; nullable
```

Plus a Drizzle CHECK constraint (matching the existing convention — see `tenant_member_role_chk`, `draft_source_chk`, `preferences_ai_provider_chk`):

```ts
(t) => [
  // …existing constraints…
  check("dimension_ordering_mode_chk", sql`${t.ordering_mode} IN ('derived', 'manual')`),
]
```

- Default `"derived"` so existing dims work unchanged.
- Validation at insert/update: must be one of the two literals; the CHECK rejects anything else at the DB level.
- Stored as `varchar` (matches the other small-enum columns like `key_kind`).
- `last_rebalanced_at` is the rate-limit gate for §API.4. Nullable because a freshly-migrated dim has never rebalanced. Stored on the registry row (Postgres), not in a separate counter store — this works correctly across replicas.

### 2. Every `dim_*` table gains a nullable `position bigint` + indexes

The `addDimension` DDL (`server/src/repo-canonical.ts:471-477`) becomes (using `${env.canonicalSchema}` — which evaluates to the literal `zugzug` per `server/src/env.ts:61` / `.env.example`):

```sql
CREATE TABLE IF NOT EXISTS zugzug.dim_<id> (
  <key_col> VARCHAR PRIMARY KEY,
  label VARCHAR NOT NULL,
  position BIGINT,                       -- NEW; nullable, ordering_mode='manual' uses it
  tenant_id VARCHAR NOT NULL DEFAULT '<tenant>'
);
-- read path: ORDER BY position seeks this; partial so derived dims stay zero-cost
CREATE INDEX dim_<id>_position_idx
  ON zugzug.dim_<id> (position)
  WHERE position IS NOT NULL;
-- collision guard — see §Write paths and concurrency
CREATE UNIQUE INDEX dim_<id>_position_uniq
  ON zugzug.dim_<id> (position)
  WHERE position IS NOT NULL;
```

Naming notes:
- The partial indexes live in the canonical schema (resolved at runtime via `env.canonicalSchema`), same as the table.
- The registry stores both `dimension.id` and `dimension.dim_table`. The `dim_table` value is a *qualified* string like `zugzug.dim_lead_status` (built in `repo-canonical.ts:455`). DDL builders that consume `r.dim_table` must treat it as already-qualified — `cq()` correctly handles the qualified form (`zugzug.dim_lead_status` → `"zugzug"."dim_lead_status"`); raw `format('%I', r.dim_table)` does not (Postgres double-quotes the whole string into one identifier). The migration in §Migration uses `cq()`-style splitting; see that section for the SQL.
- The index name uses the unqualified `dim_<id>` form — indexes are unqualified inside their schema and `dim_<id>` is already unique.

Why `position` is nullable:
- `derived` dims never write to it. Forcing a value would mean we'd backfill `0` everywhere and then garbage-collect it on toggle — a waste.
- The partial indexes keep the position-by-position lookup cheap in manual mode without bloating derived-mode tables.
- It surfaces a clear failure mode: a row with `position IS NULL` in a `manual` dim is a bug, easily asserted in tests.

Why `BIGINT` not `INT`: removes any anxiety about head-insert underflow (repeated "Insert at top" subtracts 1024 indefinitely) and tail overflow. The proactive-rebalance threshold (§Rebalance) fires far before either limit.

Why the unique index is **on `position` alone** (not `(tenant_id, position)`):
- Dim ids are *globally unique* across tenants (see `0011_mt_data_foundation.sql` "DECISION (dimension identity)"; existence check at `repo-canonical.ts:468` is unscoped). Every row in a given `dim_*` table necessarily has exactly one `tenant_id` value. There is no second tenant to seek past, and `(tenant_id, position)` reduces to `position` for uniqueness purposes within the table.
- The unique partial index `(position) WHERE position IS NOT NULL` is the backstop against the race where two simultaneous inserts compute the same midpoint. The loser's insert fails with a Postgres unique-violation; the server catches the violation, runs a rebalance (or recomputes the midpoint against the now-committed neighbour), and retries — once. See §Write paths and concurrency.

The `position` column is *not* added to `map_*` tables. Variants aren't ordered; the workbench keeps showing them by occurrence count.

### 3. No new tables

Position lives on `dim_*` because that's where canonical rows live. Splitting it into a `dim_row_order` side table would force a join on every read and double the row-level write contention. Keeping it inline matches how `label` and field columns work.

### 4. `canonical_version` is unchanged

`position` is *not* versioned the way `label` is. Reordering doesn't need optimistic concurrency:
- Two users dragging the same row at the same time → the second write wins; the loser's UI shows the new position on next refetch (see §Edge cases for the timing).
- The semantics are "what order is this list in", not "what is the truth about this record" — last-write-wins is correct here.

We considered bumping `version` on position change, but that would mean every reorder churns the audit log and version row for every record visually shifted. Not worth it.

### 5. Write paths that must be taught about position

The following codepaths currently `INSERT` into `dim_*` without a position. Each needs to be updated to set `position` when the dim is in manual mode:

| Codepath | File | Manual-mode behaviour |
|---|---|---|
| `addDimension` (create dim) | repo-canonical.ts:471 | DDL adds the column + indexes; no rows yet so no backfill needed |
| `addCanonical` (seed) | repo-canonical.ts:510 | Loops per row today. In manual mode, wraps the loop in a single `pgTx`, takes `nextPosition` once at the start, then each `INSERT` uses `nextPos + 1024 * i` (incremented locally). |
| `addCanonicalOne` (single add) | repo-canonical.ts:533 | If mode = manual, call `nextPosition(tx, …)` inside the existing pgTx; INSERT with the returned value |
| `importCanonical` (CSV) | repo-canonical.ts:571 | Refactored to wrap the per-row loop in a single `pgTx` (see Edge cases). In manual mode, `nextPos` is computed once at the start; each new row gets `nextPos + 1024 * created_index_local` (incremented per successful insert). On-conflict-skipped rows do not bump the counter. |
| `commit()` (drafts → canonical) | see §The Design "How commit() handles position" | Manual mode: one `INSERT … SELECT row_number() OVER (ORDER BY first_seen, key)` (see SQL above). Derived mode: existing `INSERT … SELECT DISTINCT … NOT EXISTS` unchanged. |
| `PUT /…/position` (drag) | new endpoint | See §API.3 |
| `POST /…/canonical` with `insertAt` | extends existing endpoint | See §API.2 |

The "next position" helper takes the lock on the actual tail row (Postgres rejects `FOR UPDATE` on aggregate queries; the spec uses a two-step pattern that takes a row lock on the current max, then computes the next position from the locked value):

```ts
async function nextPosition(tx: Tx, dimTable: string): Promise<bigint> {
  // Lock the current tail row (an aggregate-free SELECT … LIMIT 1 supports FOR
  // UPDATE; SELECT MAX(position) … FOR UPDATE does not — Postgres rejects it
  // because aggregates / DISTINCT / GROUP BY can't carry row locks).
  const tail = await tx.get<{ position: string | null }>(
    `SELECT position
       FROM ${cq(dimTable)}
       WHERE position IS NOT NULL
       ORDER BY position DESC
       LIMIT 1
       FOR UPDATE`,
  );
  const max = tail?.position == null ? 0n : BigInt(tail.position);
  return max + 1024n;
}
```

Notes:
- Two concurrent appenders both attempt to lock the same tail row; Postgres serialises them so the second one re-reads after the first commits. If the dim is empty, no row is locked — that's fine because nothing else can be appending without a prior INSERT, and the unique partial index is the final backstop.
- `position` returns as a string from postgres.js for `BIGINT` (postgres.js serialises `bigint` to string by default to avoid `Number` precision loss); we parse to `BigInt` for arithmetic and stringify on the wire (see §API.3).
- The helper does not take `tenantId` — the dim_* table only has one tenant's rows (dim ids globally unique).

### 6. `GridLayoutConfig.sort` — per-user view-sort persistence

```ts
// app/src/store.ts — extend GridLayoutConfig
export interface GridLayoutConfig {
  widths?: Record<string, number>;
  order?:  string[];
  hidden?: string[];
  sort?:   { column: string; direction: "asc" | "desc" } | null;   // NEW
}
```

- `user_grid_layout.config` is `varchar` JSON (see `0017_enable_rls.sql` baseline shape). No SQL migration is needed — the existing `setGridLayout` debouncer serialises the whole object.
- Read path: `getGridLayout(dimId)` resolves to a `GridLayoutConfig`; the grid reads `layout.sort` after mount and decides whether to render the banner (manual-mode dim + non-null sort).
- Write path: clicking a column header calls `setGridLayout(dimId, { sort: { column, direction } })`; "Restore manual order" calls `setGridLayout(dimId, { sort: null })`.
- Defaults: `undefined` and `null` both mean "no view-sort"; the grid sorts by `position ASC` (manual mode) or `variants DESC, label` (derived). The two values are interchangeable on the wire; the client normalises to `null` when clearing.

This is the only persistence change for view-sorts. No new endpoint; no new column.

### 7. Per-row write contention and the unique-index backstop

A `PUT /…/position` mutation runs inside a `SERIALIZABLE` Postgres transaction with this shape (`${qid(meta.keyCol)}` substituted in, not the literal `key`):

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;

-- 1. Re-verify both anchors still bracket the target slot
SELECT ${qid(meta.keyCol)}, position FROM ${cq(meta.dimTable)}
 WHERE ${qid(meta.keyCol)} IN ($beforeKey, $afterKey)
 FOR UPDATE;

-- 2. Compute new position from neighbours in application code
-- 3. UPDATE ${cq(meta.dimTable)} SET position = $new
--      WHERE ${qid(meta.keyCol)} = $targetKey
-- 4. COMMIT — unique-index violation triggers rebalance + retry once

COMMIT;
```

The `FOR UPDATE` plus `SERIALIZABLE` gives strong serializability between two concurrent reorders on the same anchor pair: the loser's transaction will see a serialization failure and retry, computing the new midpoint against the now-committed first reorder.

The unique partial index `(position) WHERE position IS NOT NULL` is the backstop: if anything slips through the lock, the second insert raises a unique-violation, the server catches it, runs an automatic rebalance, and retries. So position ties never persist — which is what dbt consumers ordering by `position` need.

---

## API surface

### 1. `PATCH /api/dimensions/:dimId` — NEW endpoint

The existing `POST /api/tables` orchestrator (`server/src/tables.ts`) handles dim *creation* with description/color/fields. There is no PATCH route for in-place dimension metadata edits today. This spec adds one:

```ts
// server.ts — new route in the existing /api/dimensions branch
PATCH /api/dimensions/:dimId
Body: {
  orderingMode?: "derived" | "manual";
  description?:  string | null;
  color?:        PaletteName | null;
}
Response: { ok: true; dim: DimensionMeta }
Errors:
  - 404 DIMENSION_NOT_FOUND  — id not found in the tenant's registry
  - 422 VALIDATION_FAILED     — unknown color, or orderingMode not in the enum
```

Implementation lands in a new `server/src/repo-canonical.ts:updateDimensionMeta(dimId, patch, userId, tenantId)` function. The function:

1. `pgGet` the current dim row (404 if absent).
2. Apply the patch fields via a single `UPDATE … SET … WHERE id = $1 AND tenant_id = $2` — only the keys present in the body are SET.
3. If `orderingMode` changes:
   - `derived → manual`: read every row in the dim's *current display order* (`variants DESC, label` for slug dims; `variants DESC, key` for external-id dims) and assign `position = (i + 1) * 1024` via a single `UPDATE … FROM (VALUES …)` round-trip. Append `Switched ordering mode` audit with `{from: 'derived', to: 'manual', backfilledRows: N}`.
   - `manual → derived`: `UPDATE dim_<id> SET position = NULL`. Append audit `Switched ordering mode` with `{from: 'manual', to: 'derived', nulledRows: N}`.
4. The toggle is idempotent **on the `orderingMode` field**: setting `manual` when already `manual` is a no-op — the position backfill/teardown is skipped and no audit entry for ordering is appended. Other fields in the same PATCH (e.g. color, description) proceed normally.

Route registration sits next to the existing `GET /api/dimensions/:id` handler (around `server.ts:871`):

```ts
if (seg[1] === "dimensions" && seg.length === 3 && method === "PATCH") {
  const patch = (await req.json()) as UpdateDimensionMetaInput;
  const dim = await canonical.updateDimensionMeta(seg[2], patch, me, tenantCtx.tenantId);
  return json({ ok: true, dim });
}
```

Permission gate: `curate` on the tenant (same as the existing dim-mutating routes).

### 2. `POST /api/dimensions/:dimId/canonical` — gains optional insertion semantics

```ts
POST /api/dimensions/:dimId/canonical
{
  label: string;
  key?: string;
  insertAt?: {                          // NEW; ignored when ordering_mode='derived'
    anchor: string;                     //   key of the neighbour
    direction: "above" | "below";
  };
}
```

- If `insertAt` is omitted (or mode is derived) → today's behaviour (append; `position` left null in derived; computed via `nextPosition` helper in manual).
- If `insertAt` is set and mode is manual → compute `position` as in The Design §"How Insert above/below computes a position"; attempt insert; on unique-index collision, run rebalance and retry once.
- If `insertAt.anchor` doesn't exist → 404 `INSERT_ANCHOR_NOT_FOUND`.
- The endpoint stays a single round-trip from the UI's point of view.

### 3. `PUT /api/dimensions/:dimId/canonical/:key/position` — reorder one row

```ts
PUT /api/dimensions/:dimId/canonical/:key/position
Body: {
  before?: string | null;   // key of the row that should sit ABOVE the target; null = target moves to the top
  after?:  string | null;   // key of the row that should sit BELOW the target; null = target moves to the bottom
}
Response: { ok: true; position: string }   // string, NOT number — see "JSON encoding" below
Errors:
  - 404 TARGET_NOT_FOUND        — the row being moved was deleted/retired by a concurrent merge
  - 404 INSERT_ANCHOR_NOT_FOUND — a named anchor doesn't exist
  - 409 STALE_NEIGHBOUR         — anchors are no longer consecutive (lost a race);
                                  body: { current: { before?: string; after?: string } }
```

Both `before` and `after` are accepted on a single request — the client almost always knows both neighbours from the rendered grid. The server's contract:

- Compute the new position as the midpoint of `before.position` and `after.position`. If `before` is null, use `MIN(position) - 1024`. If `after` is null, use `MAX(position) + 1024`.
- **Verify both anchors still exist and are still consecutive** in the persisted order at the moment of the write. If any row has been inserted between them since the client fetched, return `409 STALE_NEIGHBOUR`. The body carries the current positions (as strings — see encoding below) of the named anchors so the UI can re-render and retry. This catches the race "two simultaneous drags to the same slot" cleanly: only one wins; the other 409s.
- If only one of `before`/`after` is provided, the server falls back to looking up the other from the current persisted order. This is the "I dragged from outside the visible window" case; the server query is bounded.
- If the **target** row (the row being moved) has been deleted/retired by a concurrent merge → return `404 TARGET_NOT_FOUND`. UI toasts "That row was merged or deleted. Try again" and refetches; no audit entry is appended.
- If a named **anchor** has been deleted → return `409 STALE_NEIGHBOUR`. UI refetches and re-issues against the new neighbour.
- Idempotent for same-anchor calls: if the row is already in that slot (target.position is already between before and after), returns 200 with the existing position without writing.

We deliberately use neighbour-relative addressing instead of "set position to N" — the client never has to know the integer scheme. Server is the source of truth for the numeric index.

#### JSON encoding contract for `position`

`BIGINT` exceeds JavaScript's `Number.MAX_SAFE_INTEGER` (2^53) and JSON has no `bigint` type. To stay round-trip-safe:

- **Wire format**: numeric **string**, e.g. `"3072"`. The unique partial index makes ties impossible; ordering by string-of-integer works correctly when comparing same-length strings, and the client always sorts client-side by parsing to `BigInt`.
- **Client TypeScript type**: `position?: string | null` on `CanonicalRow` (see §API.5 for the list-response shape gain).
- **Client usage**: the optimistic UI doesn't *display* the integer (engineer mode is the one exception — see §UI.6). It only needs it for: (a) midpoint computation on the next drag (BigInt arithmetic), (b) sort ordering. Both work on the string form via `BigInt(str)` parse-and-compare.
- The 409 `STALE_NEIGHBOUR` body re-encodes the same way: `{ current: { before: "2048", after: "3072" } }`.

### 4. `POST /api/dimensions/:dimId/positions/rebalance` — admin escape hatch

```ts
POST /api/dimensions/:dimId/positions/rebalance
→ 200 { ok: true; rebalanced: number; rebalancedAt: string }   // ISO timestamp
→ 429 { error: "REBALANCE_RATE_LIMITED"; lastRebalancedAt: string; retryAfterSeconds: number }
```

Manual trigger for the rare case where automatic mid-insert rebalance fails. Surfaced under Settings → Tables → Advanced. Gate: tenant `curate` permission, same as schema edits. Rate-limited to **one successful rebalance per dim per 60 seconds** — the rate-limit state lives on `dimension.last_rebalanced_at` (see §Data model.1), persisted in Postgres so it works correctly across replicas:

```sql
-- Atomic check-and-set: only proceeds if the previous rebalance is >60s old
UPDATE zugzug_app.dimension
   SET last_rebalanced_at = now()
 WHERE id = $1 AND tenant_id = $2
   AND (last_rebalanced_at IS NULL OR last_rebalanced_at < now() - interval '60 seconds')
RETURNING last_rebalanced_at;
```

If `RETURNING` is empty, the rate limit is active: read `last_rebalanced_at` separately, compute `retryAfterSeconds`, return 429. If the gate passes, the rebalance runs in the same transaction and commits atomically — so a crashed rebalance leaves the gate intact for the next attempt.

### 5. List endpoint — server picks ORDER BY from dimension metadata

`GET /api/dimensions/:dimId/canonical` already exists. The ORDER BY mode is **never a request parameter** — it is a property of the dimension. The server reads `dimension.ordering_mode` from the registry row that the existing `getDimension` codepath has already loaded (the registry row is fetched at the top of every list call; the meta is locally available). It then emits one of two SQL forms in the application layer (note the `d.` qualifier on every column to avoid ambiguity with the `variants` SELECT-list alias and any user-defined field named `position`):

```ts
const orderBy = meta.orderingMode === "manual"
  ? `ORDER BY d.position ASC NULLS LAST, variants DESC, ${meta.keyKind === "external_id" ? `d.${qid(meta.keyCol)}` : "d.label"}`
  : `ORDER BY variants DESC, ${meta.keyKind === "external_id" ? `d.${qid(meta.keyCol)}` : "d.label"}`;
```

The trailing `variants DESC, label/key` is a deterministic tiebreaker for the (rare, transient) case where two rows share a position before a rebalance — but with the unique partial index in §Data model.2, ties can't persist beyond the failing transaction. The tiebreaker is belt-and-braces.

For external_id dims (which have no canonical label column, only a warehouse-resolved name) we tiebreak by the key column directly, matching the existing query in `repo-canonical.ts:267`.

#### Response shape gains `position` and `nextPosition`

The current canonical list response is `MappingDimension` (see `app/src/store.ts:823+`) — the per-row shape is `{ key, label, version, unresolved, variants, fields }`. This spec adds:

- `position?: string | null` on each row in `canonical[]` — JSON-safe stringified bigint, `null` for derived dims and unposition-ed rows.
- `nextPosition?: string | null` on the dim-level response (sibling of `rows`, `canonical`, etc.) — the value `MAX(position) + 1024` for the dim, or `null` in derived mode or when the dim is empty. Used by the engineer-mode footer (§UI.6) without a second round-trip.

The SELECT in `getDimension` adds `d.position` to the column list and the response builder threads the values through:

```ts
const canonical = canonRows.map((r) => ({
  key: String(r.key),
  // …existing fields…
  position: r.position == null ? null : String(r.position),   // bigint → string
}));
// …and on the dim envelope:
const tailRow = meta.orderingMode === "manual"
  ? await pgGet<{ p: string | null }>(`SELECT MAX(position)::text AS p FROM ${cq(meta.dimTable)}`)
  : null;
return {
  // …existing fields…
  position: undefined,                 // not on the envelope; only on rows
  nextPosition: tailRow?.p == null ? null : String(BigInt(tailRow.p) + 1024n),
};
```

The `nextPosition` query is one row; cost is negligible (it hits the partial index by sort order). In derived mode it's skipped entirely.

---

## UI surface

### 1. The grid in `derived` mode — unchanged

No drag handle column, no position column visible. The four position-related items (Insert row above, Insert row below, Move to top, Move to bottom) are **hidden** from the right-click menu (not greyed). This is honest about the affordance set instead of teasing disabled items. The bottom "+ Add record" continues to append.

### 2. The grid in `manual` mode

- A new **drag handle column** (28px wide, no label) appears as the leftmost column, anchored before the row-selector checkbox. Hover shows the grab cursor; on grab, the row lifts with a subtle shadow (matches DataGrid existing drag patterns). The drop indicator is a 3px accent line with a 10px leading dot — sized up from the column-reorder indicator to meet WCAG AA against the row-zebra alternating backgrounds. (Same color token + idiom; just larger so the drop point reads at a glance.)
- The default sort is `position ASC`. Clicking a column header to apply a view-sort triggers the **sort banner** (see §4).
- Default view (engineer mode OFF): the drag handle column is present but the `position` integer is **not** rendered anywhere in the grid. The mockup's surface 2a shows this default; surface 2b shows the engineer-mode reveal as the secondary state.

**Keyboard and accessibility (the drag handle is the only position mutator, so it has to be usable without a pointing device):**

- The drag handle is rendered as a `<button>` with `aria-label="Reorder Trial — use Cmd+Shift+Up / Cmd+Shift+Down or drag"` and a focusable tab stop within the row.
- **Cmd + Shift + ↑ / Cmd + Shift + ↓** (Mac) / **Ctrl + Shift + ↑ / Ctrl + Shift + ↓** (Windows/Linux) on a focused row reorders by one position, calling the same `PUT /…/position` endpoint with `before` / `after` derived from the adjacent rendered rows. This matches Linear's and Notion's convention — Alt+arrows collide with browser cursor-history navigation in Safari and with macOS desktop-switch shortcuts in some setups.
- **Cmd + Shift + Home / End** (Mac) / **Ctrl + Shift + Home / End** (Win) on a focused row jumps to top / bottom; the context-menu items "Move to top" and "Move to bottom" carry the same shortcut as a hint.
- Existing keyboard cursor conventions follow the patterns from `docs/superpowers/specs/2026-06-05-sources-keyboard-cursor-design.md`.
- During a pointer drag, the drag handle carries `aria-grabbed="true"`; the row gets `aria-dropeffect="move"`.
- A polite `aria-live` region in the grid footer announces "Moved Trial to position 3 of 7" on every successful reorder (keyboard or pointer).

### 3. Right-click context menu — branched by mode

The DataGrid menu already differentiates header / cell / row surfaces (`app/src/components/datagrid/DataGrid.tsx:669-...`). Cell-row menu gains a mode-aware branch:

```
Filter to "Won"
Filter to NOT "Won"
─────
Insert row above            ⌃⇧↑   <— enabled iff mode=manual ∧ curate
Insert row below            ⌃⇧↓   <— enabled iff mode=manual ∧ curate
─────
Move to top                 ⌃⇧⤒   <— iff mode=manual ∧ curate
Move to bottom              ⌃⇧⤓   <— iff mode=manual ∧ curate
─────
Delete row
```

(Shortcut hints render as `⌘⇧↑` / `⌘⇧⤒` on Mac and `Ctrl+Shift+↑` / `Ctrl+Shift+Home` on Win/Linux — the DataGrid kbd-hint renderer already platform-detects.)

In `derived` mode the four position-related items are hidden (not greyed) — the menu shrinks. This is honest about the affordance set instead of teasing disabled items.

### 4. The sort banner (manual mode + active view-sort)

A 32px tall banner pinned below the column headers when a view-sort is active in a manual-mode dim:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ⇅ Sorted by Label ↑ — manual order is hidden    [Restore]  [Dismiss]    │
└──────────────────────────────────────────────────────────────────────────┘
```

- "Restore" clears the persisted `GridLayoutConfig.sort` (`setGridLayout(dimId, { sort: null })`); the banner disappears and the grid jumps to `position ASC`.
- "Dismiss" hides the banner *for this session only* — the view-sort stays active, but the banner is suppressed until next page reload. Useful for the routine "triage by variant count for 30 seconds" workflow without nagging.

State driving the banner: `(meta.orderingMode === 'manual') && layout.sort != null && !sessionDismissedFor(dimId)`. The session-dismiss is a `Set<string>` in React state in `TablePane`, not persisted.

**Rationale for the banner asymmetry between modes:** in derived mode, the default sort is a *projection* of the data — overriding it with a view-sort is a routine browse choice, no semantic loss. In manual mode, the persisted order is the curator's contract with downstream dbt consumers — overriding it is something users should know they did, hence the banner.

**View-only users (`canView` without `curate`)** see the banner and the Restore manual order button — the button mutates only the user's own `grid_layout` row, never canonical data. Their drag handle column renders disabled with the `Read-only access` tooltip (see §Permissions).

### 5. Table settings — Ordering section

A new "Ordering" section on the per-table settings panel (the same panel that surfaces description, color, key kind):

```
─── Ordering ────────────────────────────────────────
○ Derived       Sort by variant count, then alphabetically.
                Best for reference data (countries, currencies).

● Manual        Persisted drag-orderable order.
                Best for workflow stages (priorities, tiers, statuses).
                Currently 47 of 47 rows positioned. Range: 1024 … 48128.

                          [ Rebalance positions ]   (advanced — opens confirm)
─────────────────────────────────────────────────────
```

Flipping the radio:
- `derived → manual` warns: *"This will assign positions to all 47 rows in their current display order. You'll be able to drag rows to reorder afterwards."* — one button: "Switch to manual".
- `manual → derived` warns: *"This will null the positions on all 47 rows. Switching back to manual later will assign new positions based on whatever sort is shown then (default: variant count, then alphabetical) — your current manual order cannot be recovered."* — destructive button: "Switch to derived". (Stashing the pre-toggle positions in metadata for a 24h undo grace period is recorded in §Out of scope.)

### 6. Engineer-mode reveal

With engineer mode on, the grid footer gains a `next position: 8192` indicator (read from `dim.nextPosition` on the list response — no extra round-trip) and the drag handle column header reads `position` (mono, ink-3); hovering a row's drag handle shows a tooltip `position = 4096` (from the per-row `position` field on the list response). Useful for diagnosing rebalance issues during development. Positions are **not** revealed in the "+ Add record" placeholder text or anywhere outside engineer mode — the integer scheme is an implementation detail.

The two pieces of data the engineer reveal needs (`canonical[i].position` and `nextPosition`) are both piggybacked on the existing `GET /api/dimensions/:id/canonical` response (§API.5). No separate endpoint.

### 7. Audit feed entries

Audit `action` strings use the existing sentence-case convention (matches "Added canonical", "Renamed canonical", "Imported CSV"). Structured detail goes in `metadata` jsonb:

| Action | Detail rendering | Metadata |
|---|---|---|
| `Switched ordering mode` | "Frederik switched **Lead status** from derived to manual ordering." | `{from, to, backfilledRows? \| nulledRows?}` |
| `Reordered canonical` | "Frederik moved **Trial** above **Qualified**." | `{key, before, after, rebalanced?: true}` (row keys, not positions, so the feed is human-readable) |
| `Inserted canonical at position` | "Frederik inserted **Trial** between **Contacted** and **Qualified**." | `{key, anchor, direction, rebalanced?: true}` |
| `Rebalanced positions` | "Frederik rebalanced positions in **lead_status**." | `{rebalancedRows, trigger: 'manual' \| 'threshold'}` |

The trigger enum is just two values — **`manual`** (the explicit Settings → Rebalance button) and **`threshold`** (the proactive ±2B trip). A rebalance triggered automatically by a unique-index collision *folds into the triggering reorder/insert entry* via the `rebalanced: true` flag on its metadata; it does not get its own `Rebalanced positions` row in the feed. This keeps the feed scoped to user-meaningful events.

---

## Edge cases

| Case | Behaviour |
|---|---|
| Drag a row while a teammate is editing its label | Position write succeeds; the label edit's optimistic-concurrency `version` is unrelated. Both land; the row appears in its new slot with the new label. |
| Drag a row while a teammate is dragging the same row | `SERIALIZABLE` isolation means the second tx sees a serialization failure and retries against the first's now-committed position. The retried write computes a new midpoint. Effectively: last write wins; no live broadcast. The loser's optimistic UI is reconciled by an **immediate refetch issued from the 409-response handler** in the React Query mutator — there's no waiting for the next focus / window-blur event. So the stale-UI window is bounded to one round-trip (~50–200 ms on the dev backend), not the longer query-invalidation cadence. Live realtime fan-out for canonical changes is tracked separately in E1; not in scope here. |
| Drag a row while a teammate **merges or retires** it | `PUT /position` returns `404 TARGET_NOT_FOUND`. UI toasts "That row was merged or deleted. Try again." and refetches. No audit entry is appended (no movement persisted). |
| Insert above a row that was just deleted (anchor) | 404 `INSERT_ANCHOR_NOT_FOUND`. UI toast: *"That row was just deleted. Try again."* — and the row re-renders. |
| Two simultaneous drags landing between the same pair of anchors | Both transactions `FOR UPDATE` the two anchor rows. Postgres serializes them: one commits first; the second's `before`/`after` invariant fails (the anchors are no longer consecutive — the first reorder sits between them now) and returns `409 STALE_NEIGHBOUR`. The losing client immediately refetches (via the 409 mutator hook) and re-issues. **No tied positions ever persist.** |
| Two simultaneous "insert above" requests on the same anchor | Same as above — `FOR UPDATE` on the anchor serializes them, and the unique partial index `(position) WHERE position IS NOT NULL` is the unconditional backstop if the lock somehow slips. The second insert raises a unique-violation, the server runs an automatic rebalance (or recomputes midpoint), and retries. Audit entries record both inserts in commit order. |
| Drag in a dim with an active view-sort | The drag handle is disabled. Tooltip: *"Clear sort to drag rows."* (Mutating position while viewing in label order would be a coin flip — "drag below row 3" means nothing when row 3 is row 8 in storage.) |
| Toggle to `manual` on a dim with 5k rows | Single `UPDATE … FROM (VALUES …)` writes positions 1024..5_120_000. Measured in dev: ~120 ms on Postgres 15. Foregrounded with spinner; if it takes >2s the UI shows a non-blocking toast. |
| Switch a dim to `derived` then back to `manual` | Mid-flight: positions get nulled, then re-derived from the current view (which is `variants DESC, label` because manual mode is off). The user is warned in the destructive confirm dialog (§5) that their old order cannot be recovered. |
| Insert above the first row, repeatedly (10+ times) | Each insert subtracts 1024 from `MIN(position)`. With `BIGINT` headroom (~9.2 × 10^18 in each direction), this never overflows in practice. The proactive-rebalance threshold (`MIN(position) < -2_000_000_000`) fires far before any limit. |
| Sort-by-column persisted across navigation | User-specific (already so) — does not bleed across tenants, does not write to canonical. |
| Manual-mode dim with 0 rows | Drag handle column renders empty; "+ Add record" appends with `position = 1024`. |
| Bulk CSV import into a manual-mode dim | The current `importCanonical` (`repo-canonical.ts:589-622`) opens a `pgTx` per row. For the manual-mode path we refactor it to **wrap the whole loop in a single `pgTx`** (within the 10k-row request cap; the cap stays unchanged), so the `MAX(position)` read at the start of the import is consistent with every subsequent insert. New rows get `nextPos + 1024 * local_created_index` where `local_created_index` is a TypeScript counter incremented only on successful inserts (skipped-on-conflict rows don't bump it). Existing rows on conflict have their fields updated without `position` change. Import preview shows: *"New rows will be added to the bottom of the manual order."* The derived-mode path retains the per-row `pgTx` shape since it doesn't read `MAX(position)`. |
| `commit()` flow (raw→canonical drafts) | Unchanged shape in derived mode. In manual mode, the existing `INSERT … SELECT DISTINCT … NOT EXISTS …` is replaced by a `WITH ordered AS (… GROUP BY target_key, target_label) INSERT … SELECT … row_number() OVER (ORDER BY first_seen, k) …` — see §The Design. Drafts that resolve to existing keys still skip via `NOT EXISTS`. |
| Position column visible to BI / dbt | Yes — it's a real column on `dim_*`. Document it in the dim's ARCHITECTURE.md: dbt models can `ORDER BY position NULLS LAST` to get the human-curated order for funnel reports. HTTP API consumers (`GET /api/dimensions/:id/canonical`) see the per-row `position?: string \| null` and the dim-level `nextPosition?: string \| null` (see §API.5). |
| Delete a row in manual mode | Position is freed but neighbours keep their gaps. Auto-rebalance is not run on delete (cheap; reorder gaps are fine). |
| Engineer toggles `derived` → `manual` via the admin API directly (without UI) | Same backfill path. The PATCH endpoint runs the position-assignment server-side regardless of where the request originated. |

---

## Permissions and multi-tenant

Every new endpoint is tenant-scoped through the existing `tenant-middleware.ts`. Specifically:

- `PATCH /api/dimensions/:dimId` — needs `curate` permission.
- `POST /api/dimensions/:dimId/canonical` — `curate`. Existing.
- `PUT /api/dimensions/:dimId/canonical/:key/position` — `curate`. Same gate as label rename.
- `POST /api/dimensions/:dimId/positions/rebalance` — `curate` plus a confirm dialog. Not gated to admin because dim curators already own the table.
- `canView`-only users in a **manual-mode** dim see the drag handle column (so the table layout doesn't shift between roles) but the handles are disabled with tooltip `Read-only access`. Context-menu position items (Insert above/below, Move to top/bottom) are **hidden** from the row context menu for view-only users — consistent with how "Edit description" and "Delete" already disappear. View-only users in a derived-mode dim see no drag column at all (matching everyone in derived mode).
- View-only users in either mode can still apply view-sorts, click "Restore manual order", and Dismiss the banner — all three mutate their own `grid_layout` row only, never canonical data.

The new `ordering_mode`, `last_rebalanced_at`, and `position` data lives in the per-tenant `dim_*` table and the tenant-scoped `dimension` row. No cross-tenant surface. Because dim ids are globally unique across tenants (per the 0011 baseline; the existence check at `repo-canonical.ts:468` is unscoped), every row in a given `dim_*` table necessarily has exactly one tenant_id value — the partial index doesn't need to lead with `tenant_id` to seek per-tenant, and we keep it on `position` alone for the smaller index footprint.

---

## Migration / rollout

### Day 0 — order of operations

The deploy sequence matters because `addDimension` is updated to emit the new column for any future dim:

1. **Code merge first** — the updated `addDimension` (with the new column + indexes) is part of the same PR as the migration file. Both ship together.
2. **Deploy code** — server starts; the migration has not yet run.
3. **Run migration** — Drizzle applies `0021_row_ordering.sql`. The DO block uses `IF NOT EXISTS` everywhere, so it's idempotent against any dims that were created by the freshly-deployed `addDimension` during the deploy window (those already have the column + indexes; the migration's `IF NOT EXISTS` makes the operation a no-op for them).

Equivalently: dims created during step 2 will already have the new schema (from the updated `addDimension`); dims that existed before step 1 get migrated in step 3. No timing window leaves a dim without `position`.

### Day 0 — schema

1. Drizzle migration:
   ```sql
   ALTER TABLE "zugzug_app"."dimension"
     ADD COLUMN ordering_mode varchar NOT NULL DEFAULT 'derived',
     ADD COLUMN last_rebalanced_at timestamp,
     ADD CONSTRAINT dimension_ordering_mode_chk
       CHECK (ordering_mode IN ('derived', 'manual'));
   ```
2. Same migration file: a `DO $$ … END $$` block walks the registry. `dimension.dim_table` holds a *qualified* name like `zugzug.dim_lead_status` (built in `repo-canonical.ts:455`); Postgres `format('%I', 'zugzug.dim_lead_status')` would double-quote the whole thing into a single identifier. The DO block splits the qualified name into `schema_name` + `table_name` and uses two `%I` placeholders:
   ```sql
   DO $$
   DECLARE
     r            RECORD;
     dot_pos      INT;
     schema_name  TEXT;
     table_name   TEXT;
   BEGIN
     FOR r IN SELECT id, dim_table FROM "zugzug_app"."dimension"
     LOOP
       dot_pos     := position('.' IN r.dim_table);
       schema_name := substring(r.dim_table FROM 1 FOR dot_pos - 1);
       table_name  := substring(r.dim_table FROM dot_pos + 1);

       EXECUTE format(
         'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS position BIGINT',
         schema_name, table_name
       );

       -- read path: partial index keeps derived-mode tables zero-cost
       EXECUTE format(
         'CREATE INDEX IF NOT EXISTS %I ON %I.%I (position) WHERE position IS NOT NULL',
         'dim_' || r.id || '_position_idx',
         schema_name, table_name
       );

       -- collision backstop: tied positions never persist
       EXECUTE format(
         'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (position) WHERE position IS NOT NULL',
         'dim_' || r.id || '_position_uniq',
         schema_name, table_name
       );
     END LOOP;
   END $$;
   ```
   Index names: `dim_<id>_position_idx` and `dim_<id>_position_uniq`. The DO block uses `r.id` (not `r.dim_table`) to build the index identifier, since indexes are unqualified inside their schema and `dim_<id>` is already unique.
3. **Large-dim consideration**: a single-tx `CREATE INDEX` over hundreds of dims could hold the migration connection's write lock noticeably. For tenants with dim tables exceeding ~50k rows, switch the per-dim DDL to `CREATE INDEX CONCURRENTLY` and split that portion of the migration into a separately-applied step (still idempotent via `IF NOT EXISTS`). For the seeded dims (<10k rows each), the single-tx form is fine.
4. **Idempotent retry on failure**: if the DO block fails partway (e.g. one dim's DDL errors), the migration runner can re-run the file safely — `IF NOT EXISTS` skips already-migrated dims; the failing dim's error must be fixed before retry.
5. `addDimension` (`server/src/repo-canonical.ts:445`) emits the new column + both indexes for any future dim, using the same `cq()`-style split (or the existing `cq()` helper directly, which handles `schema.table` correctly).

### Day 0 — server

6. **New code**: `updateDimensionMeta` in `repo-canonical.ts` + the `PATCH /api/dimensions/:dimId` route registration in `server.ts` (§API.1). The Day-0 checklist treats this as net-new wiring, not a teach-existing-endpoint task.
7. New endpoints from §API.2–4 (`POST /…/canonical` gains `insertAt`; `PUT /…/position`; `POST /…/positions/rebalance`).
8. List endpoint reads `dimension.ordering_mode` from the registry meta (already locally available) and emits the conditional `ORDER BY` (see §API.5); response shape gains `canonical[i].position` and dim-level `nextPosition` (string-encoded bigints).
9. All write paths from §Data model.5 (`addCanonical`, `addCanonicalOne`, `importCanonical`, `commit`) taught about position in manual mode. The `importCanonical` refactor wraps its per-row loop in a single `pgTx` for manual mode (§Edge cases). Integration tests exercise each in both modes; the manual-mode test asserts `position IS NOT NULL` and monotonicity.
10. `tenantContext.curate` gates as today.

### Day 0 — UI

11. TablePane wires `onInsertRow(key, "above" | "below")` through to the new POST body's `insertAt` field instead of focusing the bottom input.
12. Drag handle column + sort banner + "Restore" + "Dismiss" buttons + Cmd+Shift+↑/↓ + Cmd+Shift+Home/End keyboard reorders.
13. Settings panel gains the Ordering radio.
14. `GridLayoutConfig.sort` extension (TS type only; no SQL).
15. Audit-feed renderer learns the new event types and the `rebalanced: true` metadata flag.

### Day 1+ — observability

16. Track `metric: ordering_mode_changes`, `metric: position_rebalances`, and a `metric: position_extremum_threshold_reached` (when MIN/MAX crosses the ±2B threshold) in the existing telemetry stream. The threshold metric is a leading indicator for either a bug or a UX they're using harder than expected.

### Rollback

The feature flips off cleanly: setting every dim's `ordering_mode = 'derived'` restores the old `ORDER BY variants DESC, label` projection. The `position` column stays (cheap; nullable; nothing reads it once mode is derived). No data loss in derived rows.

### Default for new dims

New dims default to **`derived`**. The dim-create modal gains a one-line picker `Ordering: ● Derived ○ Manual` so a user creating a workflow-stage dim picks the right mode upfront and isn't forced through a settings panel after.

---

## Out of scope (recorded for future)

- **Realtime live broadcast of canonical-row changes.** Today's concurrency model is optimistic UI + immediate 409-handler refetch + (background) query invalidation on focus/window-blur. A `LISTEN/NOTIFY` channel (or SSE / WebSocket fan-out) that pushes canonical changes to subscribed clients filtered by `tenant_id` is the natural next step — tracked under the E1 concurrent-editing-safety initiative, independent of this spec.
- **Undo grace period on the manual → derived flip.** Stashing the pre-toggle positions in `dimension.metadata` for 24h would make the flip recoverable. Cheap to add later; not needed for the first ship.
- **Group-by / categorical sections** (Linear-style "Backlog / In Progress / Done" buckets). The natural next step but a much bigger change; the manual position is the building block.
- **Per-user manual reorder.** Rejected because dbt consumers join the canonical `position` column directly — multiple personal orders would either need a side table (more complexity) or override the canonical column for everyone (defeats the point). View-sorts remain per-user because they're a transient browse setting, not a stored ordering.
- **Drag a row from one dim into another** ("convert a row to another type"). Outside row-ordering, a different feature.
- **Reorder columns via drag** — already exists via `columnOrder` preference; this spec does not touch it.
- **A `weight` field for use in sort tiebreaks across derived dims** (a softer manual override). Considered, rejected — adds two notions of order to reason about; better to be binary about which dims use which mode.
- **Animated reorder transitions**. The drop indicator is sufficient feedback; bonus animation is a follow-up polish PR.

---

## Acceptance criteria

**Positive criteria (the feature works):**

- A user with `curate` on a `manual`-mode dim can right-click any row, pick "Insert row above" or "Insert row below", type a label in the spawned inline editor, and on Enter the new row appears in that exact position — confirmed by a `position` between the two anchors in the DB and a re-fetched grid showing the new row in the right slot.
- The same user can drag a row by its handle and drop between two rows; on commit the persisted `position` reflects the new order. (Live cross-client fan-out is out of scope; the teammate sees the change on their next refetch.)
- A user can reorder a focused row with **Cmd + Shift + ↑ / ↓** (Mac) or **Ctrl + Shift + ↑ / ↓** (Win) without using a pointing device; the screen-reader announcement reads "Moved <label> to position N of M". Cmd/Ctrl + Shift + Home/End jump to top / bottom.
- A user clicking a column header in a `manual`-mode dim sees the **sort banner**, driven by `GridLayoutConfig.sort` being non-null; clicking "Restore" clears `sort` (setGridLayout({ sort: null })) and the grid jumps to `position ASC`; clicking "Dismiss" hides the banner for the session without clearing `sort`. A user clicking a column header in a `derived`-mode dim sees no banner (it's a routine view choice).
- A user opening Table settings can flip ordering mode via `PATCH /api/dimensions/:dimId`; flipping to `manual` shows a confirm and on confirm assigns positions to every existing row in their current display order; flipping back nulls positions and shows a destructive confirm that explicitly says the manual order cannot be recovered.
- The bottom "+ Add record" appends; in `manual` mode the new row gets `position = MAX(position) + 1024`, computed by the `nextPosition` helper inside the insert transaction (which locks the current tail row via `FOR UPDATE`, not the invalid `FOR UPDATE` on an aggregate).
- A bulk CSV import into a `manual` dim appends new rows to the bottom of the manual order, preserving existing positions; positions are assigned in a single transaction wrapping the whole import loop, so `MAX(position)` is consistent with every insert.
- The `commit()` (drafts → canonical) path, when run in manual mode, assigns evenly-spaced positions to all newly-created canonical rows in `MIN(created_at), key` order via `row_number() OVER (ORDER BY first_seen, k)`, inside the same transaction as the existing `INSERT INTO map_*` and `DELETE FROM draft` steps.
- `canView`-only users in a manual-mode dim see the drag handle column with handles disabled (tooltip "Read-only access"); position context-menu items are hidden. View-only users can still click "Restore" or "Dismiss" the banner (both mutate their own preferences only).
- Audit log shows `Switched ordering mode`, `Reordered canonical`, `Inserted canonical at position`, and `Rebalanced positions` entries (sentence-case actions, structured metadata) with before/after row labels (not positions). Collision-triggered rebalances surface as a `rebalanced: true` flag on the triggering reorder/insert entry, not as a separate row.
- Engineer mode reveals `position` integers (rendered from the per-row `position` string on the list response) in the drag-handle column header and row tooltips, plus a `next position: 8192` footer indicator read from the dim envelope's `nextPosition` (no extra round-trip). Outside engineer mode, position integers are never shown in UI.
- A dim with 5,000 rows that's flipped from derived to manual completes the position backfill in under 1 second on the dev Postgres; the UI is unblocked and shows a spinner until ack.
- BI / dbt consumers and HTTP API consumers both see a `position` column / field on every `dim_*` table / row — `NULL` for derived dims, distinct integer values for manual dims (the unique partial index guarantees no ties persist) — and can `ORDER BY position NULLS LAST` reliably.

**Anti-criteria (what the test suite must enforce should never happen):**

- A derived-mode dim's `position` column remains `NULL` for every row after CRUD — `addCanonical`, `addCanonicalOne`, `importCanonical`, and `commit()` must not write `position` in derived mode.
- Clicking a column header never issues a `PUT /…/position` request — the only writers of `position` are the drag handle, Cmd+Shift+↑/↓, "Move to top / bottom", "Insert above / below", `PATCH /dimensions/:id` on mode flip, and `POST /…/positions/rebalance`.
- A `canView`-only user cannot trigger a rebalance via direct API call — the `curate` middleware rejects with 403 even if the UI affordance is hidden.
- Two rows in the same dim never share a non-null `position`. The unique partial index `(position) WHERE position IS NOT NULL` makes this a database-enforced invariant; integration tests assert it after each concurrent-insert scenario.
- The list endpoint's ORDER BY mode is not influenceable by any request parameter — passing `?orderingMode=manual` (or any other query string) on a derived dim does not return rows in `position ASC`. The mode is read from the registry only.
- The `position` field on every wire response is a **string** (or `null`); JSON.stringify never encodes it as a number, so values above 2^53 round-trip safely.
- A second rebalance call within 60 seconds of the previous successful one returns 429 — verified by an integration test that issues two back-to-back POSTs and asserts the second's response body carries `lastRebalancedAt` and `retryAfterSeconds`.
