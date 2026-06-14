# Outbound integrations — Pull API + Webhooks

**Date:** 2026-06-14
**Scope:** Build the customer-facing outbound surface for Zugzug — a versioned, paginated **Pull JSON API** for warehouses and a **Webhook** subscriber system for app integrations — and split the Settings IA so inbound concerns (the warehouse, sources) stay in *Connections* and outbound concerns (Pull API, Webhooks, Service accounts) move to a new top-level *Integrations* page. The informational "Master records" card on `Warehouse.tsx` is deleted; its content is replaced by the Pull API page, which is the actual answer to *"where does my canonical data go?"*.

---

## 1. Background

Zugzug today exposes exactly **one** outbound seam:

```
GET /api/dimensions/:id/snapshot.parquet
```

It is a single-file Parquet download, anchored to a session cookie. Useful for ad-hoc dbt seeds; useless for incremental sync, useless for app integrations that want to react to a commit.

The `api_tokens` table exists, but tokens are **user-scoped** (`api_tokens.user_id → users.id`) — a token belongs to a person, not a workspace. When the person leaves, the token leaves with them. The schema literally has no concept of "this credential authenticates as the workspace".

The architecture doc lists Postgres `LISTEN/NOTIFY` as the foundation for realtime fan-out — never implemented. There is no event bus, no webhook table, no delivery log, no signing key.

The Settings IA redesign that shipped two days ago (`docs/superpowers/specs/2026-06-12-settings-ia-redesign.md`) deliberately did **not** add an Integrations surface — it consolidated Workspace/Account/Admin tiers but punted on "the outside world calls us, we call them". That's this spec.

Three concrete pain points:

1. **dbt/Fivetran want incremental sync.** Today's only option is `wget` the Parquet every run, dump it into a staging table, diff. That's wasteful at 100 KB and absurd at 10 MB.
2. **CRMs want pushes.** "Tell our app server when a customer record's canonical key changes" is the most-requested integration on the roadmap board. Polling for changes wastes calls and adds drift.
3. **The `Warehouse.tsx` page is misleading.** Its "Master records" card has a `Saved to MotherDuck` / `Kept in this workspace` badge that *describes where canonical lives* but offers no way to *get the data out*. Customers read it as a download button that does nothing.

---

## 2. Goals / Non-goals

### Goals

- **Stripe-quality Pull API** — versioned (`/api/t/:slug/v1/...`), paginated with HMAC-signed cursor, `?since=<ISO>` for incremental, JSON only.
- **Webhook delivery you can debug** — signed, retried with exponential backoff, dead-lettered after a fixed budget, **and** a per-delivery log with one-click replay.
- **Workspace-scoped credentials** — `service_account` is a peer of `api_tokens`, not a child of users; it persists when people leave.
- **One IA cut** — Connections is inbound (warehouse, sources), Integrations is outbound (Pull API, Webhooks, Service accounts). Two pages, two mental models, zero overlap.
- **Documentation that doesn't lie.** The Pull API page renders the same `curl` examples a real consumer would copy, against the workspace's real slug + real dimensions.

### Non-goals

- **Push-to-warehouse** (write canonical back to MotherDuck via JDBC). That's the canonical-store-modes work tracked separately (`2026-06-08-phase3-canonical-store-modes-design.md`); it's a warehouse-write path, not an integration path.
- **OAuth-style app marketplace** (consent screens, scoped permissions per third-party app). v1 is bearer tokens only.
- **GraphQL.** REST first. GraphQL is a tax we don't owe the v1 user.
- **WebSocket/SSE streaming feed** for changes. Webhook + Pull API covers >95% of use cases; a streaming subscriber API is post-v1.
- **Custom event types.** v1 emits a closed event taxonomy (§7.1). No "fire this event when X" rules engine.
- **External queue (Redis/BullMQ).** Single-instance Bun timer + Postgres state. The defense is in §3.

---

## 3. The Design

### 3.1 Two surfaces, one event bus

```
                ┌──────────────────────────────┐
                │       commit (write)         │
                │   repo-canonical.commit()    │
                └─────────────┬────────────────┘
                              │ writes
                              ▼
                   ┌─────────────────────┐
                   │  outbound_event     │   ◀── new table; one row per commit
                   │  (Postgres, JSONB)  │
                   └─────────┬───────────┘
                             │
              ┌──────────────┼───────────────┐
              │              │               │
              ▼              ▼               ▼
      ┌──────────────┐ ┌─────────────┐ ┌──────────────┐
      │  Pull API    │ │  Webhook    │ │  Audit log   │
      │ (read /v1/…) │ │  dispatcher │ │  (existing)  │
      └──────────────┘ └─────────────┘ └──────────────┘
```

The commit pipeline writes a single `outbound_event` row per atomic dimension version, **inside the same Postgres transaction as the canonical write**. If the event INSERT fails (idem_key collision, type length overflow, anything that violates a constraint), the canonical commit aborts too. We treat that case as a logic bug — every constraint that could fail is one we control — and surfacing it to the user as a failed commit beats silently dropping outbound notifications. This is the only safe model: any "best-effort" event insertion outside the tx creates a window where the canonical state has changed but no event was recorded, and subscribers debugging "where did my notification go?" have no recourse.

The Pull API filters the resulting events table by `?since=<ts>`; the webhook dispatcher walks it forward and POSTs every event to every matching subscriber.

**Why one event bus, not two.** Pull-API consumers and webhook subscribers need the **same** information ("what changed in dimension X since T?"). Forking the source of truth would mean the two surfaces drift, and customers debugging "the webhook says ten rows changed but the Pull API only returns nine" would be miserable. One table, two readers.

### 3.2 Granularity: per-commit, not per-row

A commit produces **one** event of type `dimension.committed` whose payload references the version and **summarizes** what changed (counts + the list of affected canonical keys). Subscribers who care about specific rows then call `GET /api/t/:slug/v1/dimensions/:dimSlug/canonical?since=<previous-version-ts>` to enumerate the diff.

Rejected alternatives:

- **One event per canonical row written.** A 500-row import becomes 500 webhook deliveries and 500 inbox-bound payloads. Loud, slow, expensive.
- **Per-commit event with a full diff payload inline.** The payload size becomes unbounded — a 50k-row backfill produces a 5 MB JSON blob the receiving app has to parse. Webhooks are not the wire to ship a million rows over.
- **Hybrid (per-commit event + nested rows up to N).** Looks neat, encourages subscribers to skip pagination, and then breaks the day a customer commits N+1 rows.

The shape we ship is **"webhook = notification, Pull API = data"**, which is exactly how Stripe ships invoices.

### 3.3 Delivery: scheduler hook + parallel dispatcher loop

The webhook dispatcher is registered with the scheduler so it inherits **lifecycle** (boot/drain/stop, audit on failure) but runs its own concurrency model — the scheduler's stock per-tenant sequential loop is sized for *fast Postgres-only work* (the existing `scanSources`, `autoStage`, `autoCommit` jobs all complete in <100ms per tenant), and a 10-second outbound HTTP call held inside `pgTxScoped` would drain the default `PG_POOL_MAX=5` after one slow webhook per tenant. We keep the scheduler integration for clean shutdown and observability; we do NOT pretend the stock per-tenant tick gives us fair share.

**Per-tick algorithm — claim cheap, attempt outside any tx.**

```ts
// webhookDispatcherJob.run runs once per scheduler tick (2s).
async run(ctx: JobContext): Promise<JobResult> {
  // 1. Reaper FIRST — sweeps in_flight rows orphaned by a crash. See §3.3 below.
  await reapStuckInFlight(ctx);

  // 2. Claim across ALL tenants in a SHORT-LIVED tx. The whole claim returns
  //    in <50ms because it's an indexed UPDATE..RETURNING with SKIP LOCKED;
  //    the connection goes back to the pool BEFORE any fetch() runs.
  const claimed = await pgTxRaw(async (tx) => {
    return tx.all<DueRow>(`
      WITH due AS (
        SELECT id, tenant_id, webhook_id, delivery_url, signing_kid,
               payload, signature, attempts
        FROM   webhook_delivery
        WHERE  status IN ('pending', 'retry')
          AND  next_attempt_at <= now()
        ORDER BY next_attempt_at ASC, id ASC
        LIMIT  $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE webhook_delivery wd
         SET status          = 'in_flight',
             last_attempt_at = now(),
             attempts        = wd.attempts + 1
        FROM due
       WHERE wd.id = due.id
       RETURNING wd.id, wd.tenant_id, wd.webhook_id, wd.delivery_url,
                 wd.signing_kid, wd.payload, wd.signature, wd.attempts
    `, [GLOBAL_TICK_BUDGET]);
  });

  // 3. Per-tenant fair scheduling: round-robin across tenants present in
  //    `claimed`, NOT sequential. The claim above already enforces "oldest
  //    next_attempt_at first" globally, but a workspace with 10k pending
  //    rows would still monopolise the budget without this slicing step.
  const buckets = roundRobinByTenant(claimed, { perTenantCap: 32 });

  // 4. Concurrent fan-out. attempt() does its own SMALL writes (one row per
  //    state change) so no connection is held for the duration of fetch().
  await runWithConcurrency(buckets, GLOBAL_CONCURRENCY, (row) => attempt(row));

  return { rowsScanned: claimed.length, tenantsTouched: countTenants(claimed) };
}
```

`runWithConcurrency` is a 20-line in-file helper (bounded promise pool). v1 does NOT pull in `p-map` as a dependency — that was a draft over-quote; the helper is in `server/src/concurrency.ts` and has its own unit test.

**`attempt()` runs outside any tx.** Each attempt:

1. Calls `fetch(url, { signal: AbortController.signal })` with a 10-second deadline. **No Postgres connection is held during the request.**
2. On 2xx/4xx/5xx/network error, opens a **short autocommit-style write** (one `pgRun` to update `webhook_delivery` and conditionally bump `webhook.status` via the auto-disable check). Total Postgres time per attempt: typically <5ms.

The scheduler's drain signal cancels in-flight `AbortController`s so shutdown completes within the configured drain timeout.

**Connection pool sizing — explicit and documented.** With `GLOBAL_CONCURRENCY=16` and per-attempt Postgres time ≪ fetch time, the dispatcher's working-set on Postgres is one connection on average and at most one per concurrent worker for the brief state-write window. **Recommended `PG_POOL_MAX ≥ 8`** when webhooks are enabled (default raised from 5 → 8 in `server/.env.example` for hosted SaaS deployment; documented as a runtime requirement). On self-host the default stays 5 unless `WEBHOOKS_ENABLED=1`, in which case the boot check (§4.2) prints a warning that recommends bumping.

**Per-tenant fairness.** Because the claim is global (not per-tenant) and we round-robin the resulting bucket, a workspace with 1k pending deliveries cannot starve other tenants beyond the order imposed by `next_attempt_at`. The `perTenantCap` on the round-robin step ensures a single tenant cannot consume more than 32 worker slots within one tick, regardless of how many rows it has in `claimed`.

**Worked example.** 100 active webhooks across 10 tenants; tenant A has a webhook URL with a 10s response time, plus 50 other due deliveries to fast URLs. Tick 1 claims a global budget (say 256) ordered by `next_attempt_at`. After the round-robin slice, tenant A gets at most 32 slots and the other 9 tenants share the remaining 224. The slow URL occupies one worker for 10s while tenant A's other 31 deliveries complete in <1s; in parallel, the other tenants' deliveries also complete. Tick 2 fires 2s later and is unaffected because the slow worker's tx is already closed (attempt() doesn't hold one).

> Optional future tightening: per-URL concurrency cap of 4 (even within one tenant, one dead URL can't pin 32 workers). v1 ships without this; it's an in-memory map and a one-line change in `attempt()`.

#### Crash recovery — the reaper

If the dispatcher crashes (or the process is killed) mid-attempt, the claim above already flipped a row to `status='in_flight'`. The plain dispatcher pass picks up `status IN ('pending', 'retry')` only — without a reaper, orphans stay stuck forever. `reapStuckInFlight(ctx)` runs at the top of every tick:

```sql
UPDATE webhook_delivery
   SET status          = 'retry',
       next_attempt_at = now(),
       last_error      = coalesce(last_error, '') || ' [reaped after crash]'
 WHERE status = 'in_flight'
   AND last_attempt_at < now() - interval '30 seconds';
```

`30s` is comfortably larger than the 10s attempt deadline; in practice the only rows it touches are post-crash orphans, not a worker that is still alive. The `webhook_delivery_in_flight_reaper_idx` (§4.1) serves the read in one seek per tick.

The Developer Details disclosure (§6.7) on the webhook detail page surfaces a `stuck deliveries reaped (1h)` counter so operators can spot a noisy crash loop. A deploy that crash-loops mid-tick will appear there before it appears in customer reports.

**Why in-process, not Redis/BullMQ:**

- Zugzug ships as a **single-process self-hosted binary** for OSS users. Adding Redis as a hard runtime dependency would break the install story ("clone, `bun install`, point at Postgres, run").
- The `webhook_delivery` table is the same shape BullMQ would build in Redis: `pending → in_flight → retry → dlq`. Moving to Redis later is a 200-line port, not a redesign.
- The expected scale for v1 (single-tenant self-hosters and small B2B teams) is **<10 req/s in steady state, bursts of 200 on big commits**. Postgres `SKIP LOCKED` handles that without breathing hard.
- The cost of in-process is honest: the dispatcher dies when the server dies. That's acceptable because deliveries are queued in Postgres and the reaper above recovers any in-flight rows on the next tick — when the server comes back, the scheduler resumes ticking and picks up where it left off.

**When we would move off Postgres polling:** when one workspace consistently exceeds 1k pending deliveries at p50, or when we add a second server replica. Both have observable triggers (the *Delivery log* page surfaces backlog depth) and a clean migration path (read the same `webhook_delivery` table from an external worker).

### 3.4 IA cut: Connections vs Integrations

```
/app/:slug/connections                       inbound
  ├─ Warehouse                               where we READ values FROM
  ├─ Sources                                 which warehouse tables feed each dimension
  └─ App state                               where drafts/audit/users live (informational)

/app/:slug/integrations                      outbound  (NEW)
  ├─ Pull API                                docs, base URL, copy-paste curl, schema browser
  ├─ Webhooks                                subscriber list, create/edit/test, delivery log
  └─ Service accounts                        workspace-scoped tokens (M2M auth)
```

The **personal API tokens** UI (`/app/:slug/settings/tokens`) stays where it is — it's an *account* concern. The new **service accounts** UI lives under *Integrations* because it's a *workspace* concern. Both call into the same bearer-auth code path, but they answer different questions and belong on different pages.

The "Master records" card on `Warehouse.tsx` is removed. Its replacement is the *Pull API* page, which actually shows you where canonical lives **and** how to get it.

---

## 4. Data model

All new tables tenant-scoped. All FKs include `tenant_id` in composite where the referenced table is tenant-scoped (matches existing convention: see `draft`, `canonical_version`).

### 4.1 Tables

```ts
// server/drizzle/schema.ts

export const serviceAccount = app.table(
  "service_account",
  {
    id:           varchar("id").primaryKey(),         // sa_<32 hex>
    tenant_id:    varchar("tenant_id").notNull().references(() => tenant.id),
    name:         varchar("name").notNull(),          // human label, e.g. "dbt prod"
    /* Argon2id of the full token string. Verified, never used for signing. */
    token_hash:   varchar("token_hash").notNull(),
    /* First 12 chars of plaintext token (e.g. "zzsa_b8K3kP"). NOT secret —
       used as a non-cryptographic lookup column so auth is a single-row hash
       verify instead of a full table scan. See §5.1 perf note. */
    token_prefix: varchar("token_prefix", { length: 12 }).notNull(),
    scopes:       varchar("scopes").array().notNull().default(sql`ARRAY['read']::varchar[]`),
                                                      // v1: ["read"] only; reserved: ["webhook:manage"]
    created_at:   timestamp("created_at").notNull(),
    created_by:   varchar("created_by").notNull(),    // users.id of admin who minted it
    last_used_at: timestamp("last_used_at"),
    revoked_at:   timestamp("revoked_at"),
    expires_at:   timestamp("expires_at"),            // null = never; UI offers 90d / 1y / never
  },
  (t) => [
    uniqueIndex("service_account_token_hash_unique").on(t.token_hash),
    /* Lookup index for the auth fast path (single-row plus hash verify). */
    index("service_account_tenant_prefix_idx").on(t.tenant_id, t.token_prefix),
    index("service_account_tenant_idx").on(t.tenant_id),
    check(
      "service_account_scope_chk",
      sql`${t.scopes} <@ ARRAY['read', 'webhook:manage']::varchar[]
           AND cardinality(${t.scopes}) >= 1`,
    ),
  ],
);

export const webhook = app.table(
  "webhook",
  {
    id:            varchar("id").primaryKey(),        // wh_<32 hex>
    tenant_id:     varchar("tenant_id").notNull().references(() => tenant.id),
    url:           varchar("url", { length: 2048 }).notNull(),
    /* Webhook secrets are SIGNING KEYS, not passwords. We need the plaintext on
       every delivery to compute HMAC_SHA256, so we cannot argon2-hash it. The
       secret is stored as AES-GCM ciphertext under a server-side master key
       (see "Secret storage" below). secret_prefix is plaintext for UI display. */
    secret_ciphertext: bytea("secret_ciphertext").notNull(),
    secret_nonce:      bytea("secret_nonce").notNull(),     // 12-byte AES-GCM IV
    secret_key_version: integer("secret_key_version").notNull().default(1),
                                                      // bump when master key rotates
    secret_prefix: varchar("secret_prefix", { length: 12 }).notNull(),
                                                      // "whsec_<6 chars>" for UI; not sensitive
    /* Optional grace-period dual-key support: when a user rotates the secret,
       the previous value lives here until previous_expires_at, so subscribers
       have time to roll over. Dispatcher always signs with the current secret;
       UI verification recipe shows both kid=current and kid=previous. The
       *_previous columns include their own prefix so the rotation banner can
       show operators which previous key was active without re-reading plain-
       text — helps correlate with subscribers' verification logs. */
    secret_ciphertext_previous: bytea("secret_ciphertext_previous"),
    secret_nonce_previous:      bytea("secret_nonce_previous"),
    secret_previous_expires_at: timestamp("secret_previous_expires_at"),
    secret_prefix_previous:     varchar("secret_prefix_previous", { length: 12 }),
    events:        varchar("events").array().notNull(),
                                                      // closed v1 taxonomy; see §7.1
    /* status enum, NOT a plain bool, so 'paused by user' and 'auto-disabled'
       are distinguishable in the UI and the API. */
    status:        varchar("status", { length: 16 }).notNull().default("active"),
                                                      // 'active' | 'paused' | 'disabled'
    description:   varchar("description"),
    created_at:    timestamp("created_at").notNull(),
    created_by:    varchar("created_by").notNull(),   // users.id
    paused_at:     timestamp("paused_at"),            // set when status → 'paused'
    disabled_at:   timestamp("disabled_at"),          // set when status → 'disabled'
    disabled_reason: varchar("disabled_reason"),      // e.g. "auto: 50 consecutive failures"
  },
  (t) => [
    index("webhook_tenant_idx").on(t.tenant_id),
    check(
      "webhook_status_chk",
      sql`status IN ('active', 'paused', 'disabled')`,
    ),
    /* URL scheme: must be https://. The localhost escape hatch lives in the
       application layer (handlers consult ZUGZUG_SELF_HOSTED), NOT in the DB,
       so the rule honours env state the database can't see. The CHECK below
       only catches the most basic malformed URLs; the handler enforces the
       full policy (parse, normalize, scheme decision). See §5.3 / §8. */
    check(
      "webhook_url_scheme_chk",
      sql`${t.url} ~* '^https?://'`,
    ),
    check(
      "webhook_events_nonempty_chk",
      sql`cardinality(${t.events}) > 0`,
    ),
    /* v1 closed taxonomy enforced at the DB so a buggy handler can't write
       garbage event names that subscribers will silently never receive.
       NOTE: `webhook.test` is a synthetic event fired only by Send Test (§7.1)
       — it is NOT subscribable and intentionally absent from the allowlist.
       The Create Webhook modal does not surface it as a checkbox. */
    check(
      "webhook_events_known_chk",
      sql`${t.events} <@ ARRAY[
        'dimension.committed',
        'dimension.created',
        'dimension.schema.updated',
        'canonical.deleted'
      ]::varchar[]`,
    ),
  ],
);

export const outboundEvent = app.table(
  "outbound_event",
  {
    id:           varchar("id").primaryKey(),         // evt_<26 char ULID> — sortable
    tenant_id:    varchar("tenant_id").notNull().references(() => tenant.id),
    type:         varchar("type", { length: 64 }).notNull(),
                                                      // closed taxonomy; see §7.1 / CHECK below
    dim_id:       varchar("dim_id"),                  // nullable for non-dim-scoped events (none in v1)
    occurred_at:  timestamp("occurred_at").notNull(),
    payload:      jsonb("payload").notNull(),
    /* idempotency: a deterministic key per logical event — re-emitting the same
       commit (e.g. after a crash mid-commit) produces an identical key and we
       silently no-op the insert. Format: "<type>:<dim_id>:<version>" or
       "<type>:<dim_id>:<canonical_key>:<occurred_at_ms>" for delete events. */
    idem_key:     varchar("idem_key", { length: 128 }).notNull(),
  },
  (t) => [
    uniqueIndex("outbound_event_tenant_idem_unique").on(t.tenant_id, t.idem_key),
    /* the only read pattern: "Pull API for tenant + type since cursor T".
       Composite on (tenant_id, type, occurred_at, id) gives an indexed seek and
       a stable tiebreaker. id is a ULID, so it sorts the same as occurred_at. */
    index("outbound_event_tenant_type_time_idx").on(
      t.tenant_id,
      t.type,
      t.occurred_at,
      t.id,
    ),
    /* Closed taxonomy: webhook.test is NEVER written here (synthetic, see §7.1)
       and the v1 reserved-but-unimplemented types are excluded. The CHECK keeps
       a misconfigured dispatcher from writing a row subscribers can't subscribe
       to — the failure surfaces as a tx abort instead of silent data loss. */
    check(
      "outbound_event_type_chk",
      sql`${t.type} IN (
        'dimension.committed',
        'dimension.created',
        'dimension.schema.updated',
        'canonical.deleted'
      )`,
    ),
  ],
);

export const webhookDelivery = app.table(
  "webhook_delivery",
  {
    id:                varchar("id").primaryKey(),    // whd_<26 char ULID>
    tenant_id:         varchar("tenant_id").notNull().references(() => tenant.id),
    webhook_id:        varchar("webhook_id").notNull(),
    event_id:          varchar("event_id").notNull(),
    event_type:        varchar("event_type", { length: 64 }).notNull(),
    /* Snapshot of the URL at enqueue time. A URL edit on the parent webhook
       does NOT redirect in-flight deliveries — prevents the exfiltration vector
       where an admin (or a compromised admin session) reroutes an already-signed
       payload to an attacker. See §8 (URL change). */
    delivery_url:      varchar("delivery_url", { length: 2048 }).notNull(),
    /* Which webhook secret version signed this delivery — current at the time
       the row was created. Survives secret rotation: in-flight deliveries keep
       being signed with this kid; new events use the current kid. */
    signing_kid:       varchar("signing_kid", { length: 16 }).notNull(),
                                                      // 'current' | 'previous'
    is_test:           boolean("is_test").notNull().default(false),
                                                      // true for webhook.test deliveries; surfaces a TEST badge in UI
    status:            varchar("status", { length: 16 }).notNull(),
                                                      // 'pending' | 'in_flight' | 'success' | 'retry' | 'dlq'
    attempts:          integer("attempts").notNull().default(0),
    max_attempts:      integer("max_attempts").notNull().default(5),
    next_attempt_at:   timestamp("next_attempt_at"),  // null when success or dlq
    last_attempt_at:   timestamp("last_attempt_at"),
    last_response_code: integer("last_response_code"),
    last_response_body: text("last_response_body"),    // truncated to first 2 KB
    last_error:        text("last_error"),             // network errors, timeouts
    payload:           jsonb("payload").notNull(),    // exact bytes signed + delivered
    signature:         varchar("signature", { length: 96 }).notNull(),
                                                      // "t=<unix>,v1=sha256=<hex>" — replayable verbatim
    created_at:        timestamp("created_at").notNull(),
    completed_at:      timestamp("completed_at"),
  },
  (t) => [
    /* Three indexes.
       (a) dispatcher hot path: pending|retry rows ready to fire, oldest first.
           Partial WHERE prunes status so leading-column ordering on
           next_attempt_at is sufficient. */
    index("webhook_delivery_due_idx")
      .on(t.next_attempt_at)
      .where(sql`status IN ('pending', 'retry')`),
    /* (b) delivery-log UI + the "last 50 NON-TEST deliveries" auto-disable
           counter (§5.3). Drizzle 0.45.2 does not surface PostgreSQL INCLUDE
           in pg-core's index() helper, so the Phase 1 SQL migration appends
           a raw `CREATE INDEX ... INCLUDE (status, is_test)` statement after
           the generated migration runs — both columns are kept in the index
           so the auto-disable scan never touches the heap. */
    index("webhook_delivery_webhook_time_idx").on(t.webhook_id, t.created_at.desc()),
    /* (c) reaper: rows stuck in_flight after a crash. Cheap partial index
           keyed on last_attempt_at lets `UPDATE ... WHERE status='in_flight'
           AND last_attempt_at < now() - interval '30 seconds'` find them in
           one seek. See §3.3 (crash recovery). */
    index("webhook_delivery_in_flight_reaper_idx")
      .on(t.last_attempt_at)
      .where(sql`status = 'in_flight'`),
    check(
      "webhook_delivery_status_chk",
      sql`status IN ('pending', 'in_flight', 'success', 'retry', 'dlq')`,
    ),
    check(
      "webhook_delivery_signing_kid_chk",
      sql`signing_kid IN ('current', 'previous')`,
    ),
  ],
);
```

Duplicate webhooks on the same `(tenant_id, url)` are **allowed by design** — a customer may legitimately want one subscription per event type, or one per environment downstream. The list UI surfaces a "duplicate URL" warning chip when two rows share a URL so the case is visible. No DB UNIQUE constraint.

#### `canonical_version` — extend to soft-delete

`canonical_version` today carries `{tenant_id, dim_id, key, version, updated_at, updated_by}` and the merge/retire code paths **hard-delete** the row (`DELETE FROM canonical_version` in `repo-canonical.mergeCanonical` and `retireCanonical`). The `/tombstones` endpoint cannot exist without changing both the schema and the write path, so the Phase 1 migration ships both as a single atomic change:

```ts
// server/drizzle/schema.ts — extend the existing canonicalVersion table
retired_at:   timestamp("retired_at"),                // null => active row
retired_into: varchar("retired_into"),                // survivor key when merged
```

Migration steps (Phase 1, server-only):

1. `ALTER TABLE canonical_version ADD COLUMN retired_at timestamp NULL, ADD COLUMN retired_into varchar NULL;` — both nullable; existing rows stay live.
2. Update `repo-canonical.mergeCanonical`: replace the `DELETE FROM canonical_version WHERE key = ANY($2::text[])` with `UPDATE canonical_version SET retired_at = now(), retired_into = $survivor WHERE dim_id = $1 AND key = ANY($2::text[]) AND tenant_id = $3`.
3. Update `repo-canonical.retireCanonical` / `deleteVersionRow`: replace the `DELETE` with `UPDATE canonical_version SET retired_at = now(), retired_into = NULL WHERE ...`.
4. **Every existing read path that joins `canonical_version` learns to filter `WHERE retired_at IS NULL`.** Audit grep: `listDimensionRows`, `getCanonicalVersion`, the Pull API canonical query in §4.5, the recency index, and the AI-mapping recall path. The grep is part of the migration PR checklist; missing one shows up as a soft-deleted row appearing in the UI as a ghost record.
5. Existing FK and index behaviour: there are no FKs *out of* `canonical_version` to break; the primary key `(tenant_id, dim_id, key)` is unaffected. The two existing indexes (`canonical_version_recent_idx`, `canonical_version_tenant_dim_idx`) continue to serve their existing queries — adding `retired_at IS NULL` to read predicates is index-compatible (Postgres uses leading columns and applies the residual filter post-fetch; for the recency index in particular we add a partial variant in step 6 if EXPLAIN shows it matters at scale).
6. Add a tombstone-read index: `index("canonical_version_tombstone_idx").on(t.tenant_id, t.dim_id, t.retired_at).where(sql`retired_at IS NOT NULL`)` — keeps the tombstone-paginated read O(log n) without inflating the main row table.

The `/tombstones` endpoint is the **only** tombstone surface in v1 — there is no `?include_retired=true` flag on `/canonical`, which would duplicate the read path and force every downstream library to learn two semantics. Subscribers that receive `changes_truncated=true` call `/tombstones?since=<previous-version-time>` for retired/merged keys and `/canonical?since=<previous-version-time>` for everything else.

### 4.2 Secret storage

Webhook signing secrets are encrypted with **AES-256-GCM** under a master key. The master key lives in:

- **Hosted SaaS** — `ZUGZUG_WEBHOOK_MASTER_KEY` env var pointing at a KMS-wrapped 32-byte key. Decrypted at boot, held in process memory.
- **Self-host** — `ZUGZUG_WEBHOOK_MASTER_KEY_FILE` pointing at a file on disk (operator's responsibility to chmod 600). Documented in `server/.env.example`.

If the env var is unset and webhooks are enabled, boot behaviour depends on the deployment:

- **Hosted SaaS** (`ZUGZUG_SELF_HOSTED=0`) — the server refuses to boot with a clear error (`webhook master key required; set ZUGZUG_WEBHOOK_MASTER_KEY or disable WEBHOOKS_ENABLED`). Hosted SaaS sets the key in deployment config; missing it is always operator error.
- **Self-host** (`ZUGZUG_SELF_HOSTED=1`) **and** `WEBHOOKS_ENABLED=1` **and** no key configured — auto-generate a 32-byte random key on first boot, write it to `<DATA_DIR>/webhook-master.key` with mode `0600`, log a one-time WARNING that the operator should back it up (`auto-generated webhook master key written to <path>; back this up — losing it makes existing webhook secrets unrecoverable and forces a Rotate for every subscription`). This keeps the OSS "clone, install, run" story intact for hobbyist operators while still surfacing the production-grade ask.

The boot check runs **after** `WEBHOOKS_ENABLED` is read, so an operator who flips `WEBHOOKS_ENABLED=1` without setting the key on a hosted-style deployment fails fast at restart with a specific actionable error rather than a generic startup crash. The webhook-create UI surfaces a precise message when the server is up but webhooks aren't enabled (`Webhooks aren't enabled in this deployment — set WEBHOOKS_ENABLED=1 in your environment and restart`), and a separate message when the master key is missing on a deployment that requires it (`Webhook master key is not configured. Set ZUGZUG_WEBHOOK_MASTER_KEY and restart.`).

`secret_key_version` lets us rotate the master key without re-encrypting every webhook row at once; the encrypt helper writes with the current version, the decrypt helper looks up the right key by version. Rotation is a separate documented operation; v1 ships with version 1 only.

### 4.3 Secret rotation semantics

When an admin clicks *Rotate* on a webhook:

1. Server generates a new plaintext secret, encrypts and stores it in `secret_ciphertext` (overwriting the old current).
2. The previous secret is moved into `secret_ciphertext_previous` with `secret_previous_expires_at = now() + 24h`; `secret_prefix_previous` records its display prefix.
3. The plaintext is shown once in a modal.
4. New events created from this point sign with `kid=current`. **In-flight deliveries** (rows already in `webhook_delivery` with `signing_kid='current'` before the rotation) keep their stored signature — we do NOT re-sign them, because the row's `payload` and `signature` columns are a single inviolable record of what was sent.
5. Subscribers' verification helpers accept either `kid=current` or `kid=previous` during the grace window. The X-Zugzug-Signature header includes `kid=` so the receiver knows which key to verify against.
6. The same `outboundRetentionSweepJob` (§4.4) zeroes out `secret_ciphertext_previous`, `secret_nonce_previous`, `secret_prefix_previous`, and `secret_previous_expires_at` when `secret_previous_expires_at < now()`.

The `kid` in the signature is what makes this safe: the receiver always knows which secret to check, even if they've already rolled. There is no "thundering herd" of debugging because there is no ambiguity.

**Replay of a delivery whose `signing_kid='previous'` after the grace window has expired.**

A DLQ delivery from 3 days ago carries `signing_kid='previous'`. If the admin clicks *Replay* after `secret_ciphertext_previous` has already been zeroed out by the sweep, we cannot reproduce the original signature with the original kid. v1 picks behaviour (1) of the two reasonable choices below; both are documented so the UI can communicate the path clearly:

1. **Re-sign with `kid=current`** (chosen for v1). The replayed row is a NEW `webhook_delivery` with `signing_kid='current'`, a freshly-computed `signature`, and the original `delivery_url` + `payload`. `X-Zugzug-Event-Id` stays the same as the original (subscribers still dedupe correctly), but `X-Zugzug-Signature` differs. The replay UI shows a banner on the row: *"Original kid=previous expired; replay signs with kid=current"*.
2. Refuse with `410 signing_kid_expired` and ask the admin to re-trigger the upstream event. Rejected because for typical Zugzug usage (canonical commits) the only way to re-trigger is to commit a no-op, which is operationally awkward.

The Replay button on the webhook detail page shows a tooltip when the original row's `signing_kid='previous'`: while the previous secret still exists, *"Replays using the previous-rotation secret"*; after expiry, *"Original signing key expired — replay will re-sign with current secret"*. The button stays enabled in both cases; only its semantics shift.

### 4.4 Retention sweep

Retention is **time-based only**: rows with `created_at < now() - 30d` are deleted. No per-subscription "have all subscribers been delivered to?" check — that requires a join the index can't help with and creates a footgun when a paused subscription resumes after months.

A paused-then-resumed webhook may miss events older than 30 days. This is explicitly addressed in §8:

- `webhook_delivery.event_id` is a plain `varchar` with **no foreign key** to `outbound_event`. The delivery row's `payload` column is the inviolable self-contained record of what was sent; deleting the parent `outbound_event` does not break anything in-flight. Pending deliveries for paused webhooks therefore survive an `outbound_event` sweep — they get re-fired at unpause time, as long as the delivery row itself is younger than 30 days.
- If a webhook is paused for **more than 30 days**, its older `webhook_delivery` rows are themselves swept (also by the 30-day rule). At unpause, the operator's recourse is a Pull API resync from the `?since=<pause-start-time>` timestamp — `/canonical` is never aged out (canonical data is the system of record) and `/tombstones` carries 30 days of soft-deleted rows on the same retention.

The sweep runs as a `SchedulerJob` in `server/src/scheduler-jobs.ts` (`outboundRetentionSweepJob`), registered alongside the existing scan / auto-stage / auto-commit jobs. It runs once per tenant per tick but short-circuits with a cheap `last_swept_at` check stored in `tenant_preferences` so it actually fires at most once every 6 hours per tenant, regardless of tick frequency. No parallel `setInterval` — the existing scheduler already iterates tenants, opens per-tenant transactions, handles drain-on-stop, and emits audit rows.

The same scheduler job clears expired `secret_ciphertext_previous` blobs (along with the matching `secret_nonce_previous` and `secret_prefix_previous` columns).

### 4.5 Pull API read plan — canonical + tombstones

#### `/canonical` — live rows

`GET /api/t/:slug/v1/dimensions/:dimSlug/canonical?since=<ISO>&cursor=<signed>` is the read path for incremental sync, so its SQL plan matters.

```sql
-- Pseudo-Drizzle; final SQL lives in server/src/repo-outbound.ts
SELECT
  d.key,
  d.label,
  to_jsonb(d) - 'key' - 'label' AS fields,
  cv.updated_at,
  cv.version
FROM dim_<slug>  d
JOIN canonical_version cv
  ON  cv.tenant_id = $tenant_id
  AND cv.dim_id    = $dim_id
  AND cv.key       = d.key
WHERE d.tenant_id  = $tenant_id
  AND cv.retired_at IS NULL                   -- soft-deleted rows: see §4.1 + /tombstones
  AND cv.updated_at >= $since                 -- inclusive lower bound
  AND (cv.updated_at, d.key) > ($cursor_ts, $cursor_key)
ORDER BY cv.updated_at ASC, d.key ASC
LIMIT $limit;
```

To make this index-only:

```ts
// Phase 1 migration adds, alongside outbound_event:
index("canonical_version_pull_idx")
  .on(t.tenant_id, t.dim_id, t.updated_at, t.key)
  .where(sql`retired_at IS NULL`),
```

#### `/tombstones` — retired and merged keys

```sql
SELECT cv.key, cv.retired_at, cv.retired_into
FROM canonical_version cv
WHERE cv.tenant_id   = $tenant_id
  AND cv.dim_id      = $dim_id
  AND cv.retired_at IS NOT NULL
  AND cv.retired_at >= $since
  AND (cv.retired_at, cv.key) > ($cursor_ts, $cursor_key)
ORDER BY cv.retired_at ASC, cv.key ASC
LIMIT $limit;
```

Read served by the partial `canonical_version_tombstone_idx` declared in §4.1. The endpoint returns no `fields` and joins no `dim_<slug>` — the row is gone from the live table by definition; what we keep is the soft-deleted version row.

#### Phase 1 backfill of `canonical_version.updated_at`

`canonical_version` rows have always had an `updated_at`, but historically only on rows touched **after** `repo-canonical.commit()` started writing them. Workspaces that were imported via the bootstrap path or via early-version commits may have `dim_<slug>` rows with no matching `canonical_version` row. The Phase 1 migration runs a one-shot UPSERT per tenant per dim against the real audit_log shape:

```sql
INSERT INTO canonical_version (tenant_id, dim_id, key, version, updated_at, updated_by)
SELECT $tenant_id, $dim_id, key, 0,
       coalesce(
         (SELECT max(created_at) FROM "zugzug_app".audit_log
            WHERE tenant_id = $tenant_id
              AND table_id  = $dim_id          -- audit_log.table_id is the dim_id
              AND row_key   = key              -- audit_log.row_key is the canonical key
              AND action IN ('Added canonical', 'Merged canonical',
                             'Retired canonical', 'Updated canonical')),
         now()),
       'migration:phase1'
FROM "zugzug_app".dim_<slug>
ON CONFLICT (tenant_id, dim_id, key) DO NOTHING;
```

Two notes the implementation must honour:

- `audit_log.table_id` and `audit_log.row_key` are the real column names (see `schema.ts:108-127`); there is no `entity_type` / `entity_key`. Code that names them wrong returns zero rows and silently degrades to `now()` for every backfilled row, which leaves consumers unable to do incremental sync from any pre-migration timestamp.
- The `action` filter matches the strings `repo-canonical.ts` actually writes (`Added canonical`, `Merged canonical`, `Retired canonical`, `Updated canonical`). The migration ships with a unit test that scans the repo for `appendAudit*` calls naming canonical mutations and fails if a new action string lands without being added to the filter.

This SQL is **authoritative** — `server/drizzle/migrations/<phase-1>.sql` ships this exact statement (parameterized per tenant/dim by the migration runner). Without it, day-1 `?since=2026-01-01` returns zero records (every `updated_at` falls back to `now()` ≥ migration time, but consumers are syncing past that). The backfill is the difference between "Pull API ships and works" and "Pull API ships and silently breaks downstream pipelines".

### 4.6 Cursor format

Pagination cursors are HMAC-signed so a tampering client cannot fast-forward through the dataset.

```
cursor = base64url(payload) + "." + base64url(HMAC_SHA256(serverKey, payload))

payload (JSON) = {
  "t":  tenant_id,
  "u":  last_updated_at (ISO),
  "k":  last_key,
  "v":  cursor_format_version (1)
}
```

The `serverKey` is a dedicated `ZUGZUG_CURSOR_KEY` env var (separate from the webhook master key). On signature mismatch the server returns 400 `cursor_invalid`. On tenant mismatch (different `t` than the calling token's workspace) the server returns 400 `cursor_mismatch`. Rotating `ZUGZUG_CURSOR_KEY` invalidates all in-flight cursors — equivalent to "everyone resyncs from `?since=`", which is benign for a read API.

`/events` cursors include the cursor's source event's `created_at` so the 30-day retention rule can return 410 when the cursor is older than the retained window. `/canonical` cursors are **never** 410'd — canonical data is the system of record and is never aged out; the cursor format is the same shape, but stale cursors just return whatever's still there. See §8.

---

## 5. API surface

All Pull API + Webhook routes live under `/api/t/:slug/v1/...`. Choosing the path-scoped shape (vs. flat `/api/v1/...` with tenant resolved out of the bearer) means **the existing `tenant-middleware.ts` works without changes** — the same `/api/t/:slug/...` regex that gates UI traffic gates outbound traffic. The bearer token is verified for *identity*; the workspace context comes from the URL. Service-account tokens carry their workspace at issue time and must match `:slug`, or the request 403s; personal tokens authenticate the user across any workspace they're a member of.

The `/v1/` segment is **load-bearing** — it's a public commitment that breaking changes ship under `/v2/`. Routes under `/api/t/:slug/...` without the version stay reserved for session-authenticated UI calls.

### 5.1 Auth

```
Authorization: Bearer <token>

  zzsa_<43 chars>       service-account token (workspace-scoped)
  zz_<43 chars>         personal API token (user-scoped, multi-workspace)
```

**Resolution pseudocode** (extending `getApiTokenUser` in `server/src/auth-api-tokens.ts`):

```ts
export async function getApiTokenUser(req: Request, pathname: string)
  : Promise<{ user: SessionUser; serviceAccount?: ServiceAccountCtx } | null>
{
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  const prefix12 = token.slice(0, 12);          // e.g. "zzsa_b8K3kP" or "zz_abc8…"

  if (token.startsWith("zzsa_")) {
    // Path: /api/t/:slug/v1/... — extract :slug for tenant binding check.
    const slug = matchTenantSlug(pathname);
    if (!slug) return null;                     // service tokens require /t/:slug/
    // O(1) prefix lookup + single argon2id verify — see "Performance" below.
    const candidates = await pgAll<SaRow>(
      `SELECT sa.*, t.slug
         FROM service_account sa
         JOIN tenant t ON t.id = sa.tenant_id
        WHERE sa.token_prefix = $1
          AND sa.revoked_at  IS NULL
          AND (sa.expires_at IS NULL OR sa.expires_at > now())
          AND t.slug = $2`,
      [prefix12, slug],
    );
    for (const sa of candidates) {
      if (await Bun.password.verify(token, sa.token_hash)) {
        // Synthetic SessionUser; tenantId comes from the path; resolveTenantContext
        // confirms the synthetic user is "a member" by short-circuiting on
        // serviceAccount.tenantId === tenant.id (added there).
        return {
          user: syntheticSaUser(sa),
          serviceAccount: { id: sa.id, tenantId: sa.tenant_id, scopes: sa.scopes },
        };
      }
    }
    return null;
  }

  if (token.startsWith("zz_")) {
    // Personal tokens: O(1) lookup by prefix, then verify.
    const candidates = await pgAll<TokenRow>(
      `SELECT id, user_id, token_hash FROM api_tokens
        WHERE token_prefix = $1 AND revoked_at IS NULL`,
      [prefix12],
    );
    for (const cand of candidates) {
      if (await Bun.password.verify(token, cand.token_hash)) {
        return { user: await loadUser(cand.user_id) };
      }
    }
    return null;
  }

  return null;
}
```

The existing `resolveTenantContext()` in `tenant-middleware.ts` runs for the `/api/t/:slug/v1/...` path — its `TENANT_PATH_RE` already matches `/api/t/:slug/`. We add one branch: if `opts.serviceAccount` is set, treat its `tenantId` as a membership proof (no `memberRole` lookup, since the SA *is* the workspace) **and synthesise `role = 'viewer'`** so the read-only intent of v1's only scope (`scopes: ['read']`) is honoured downstream by every existing `can()` / `RoleGate` consumer. This single line is what makes the matrix in §9 unambiguous for SA traffic — see the table in §9 that distinguishes SA-scoped-read from session-admin.

**Scope checks come BEFORE role checks for SA traffic.** Every route handler in the `/v1/` surface that mutates state (POST/PATCH/DELETE on `/webhooks*` and `/service-accounts*`) runs `requireScope(ctx, 'webhook:manage')` as its FIRST gate. A v1 SA token has `scopes: ['read']` only — the scope check returns `403 scope_insufficient` before any role check fires. Adding `webhook:manage` later is non-breaking: existing tokens stay read-only; explicitly minted tokens with that scope unlock the mutation routes. Without this ordering, an SA with admin-role-by-default semantics would silently work for state-changing routes today.

**Slug rename impact on SA tokens.** The SA's `tenant_id` does not change when an admin renames a workspace slug — the SA continues to authenticate the same tenant. But the URL it's used against (`/api/t/<old-slug>/v1/...`) 404s after the rename, breaking every downstream integration (dbt, Fivetran, CI) that hard-coded the old URL. The Settings → Slug rename flow surfaces this in two places:

1. The rename confirmation modal (already shipping for IA redesign) gains an "Integrations that will need to be updated" section that lists every active SA token and every active webhook URL pointing at the new slug, with copy-buttons for the new path. Closing the modal commits the rename; the operator has the list in hand.
2. For 30 days post-rename, the old slug remains routable as a redirect alias: requests to `/api/t/<old-slug>/v1/...` return `301 Moved Permanently` with a `Location` header pointing at the new slug. The redirect is logged in audit and counted in the *Stale slug usage* counter on the workspace's Developer Details disclosure so the operator can see which integrations haven't migrated. After 30 days the alias is dropped and old URLs 404.

**Personal `zz_` token performance.** The existing `getApiTokenUser` iterates every active `api_tokens` row and runs argon2id on each. With M2M traffic on the new surface (dbt polling every 60s, Fivetran every 5 min, CI per build) plus dozens of tenants, that scan becomes a CPU sinkhole. Phase 1 migration adds a `token_prefix varchar(12)` column to `api_tokens`. New tokens populate it; legacy rows are NULL.

The auth code path explicitly handles both:

```ts
if (token.startsWith("zz_")) {
  // Fast path: prefix-indexed lookup. Hits for every token issued post-migration.
  const fast = await pgAll<TokenRow>(
    `SELECT id, user_id, token_hash FROM api_tokens
      WHERE token_prefix = $1 AND revoked_at IS NULL`,
    [prefix12],
  );
  for (const cand of fast) {
    if (await Bun.password.verify(token, cand.token_hash)) {
      return { user: await loadUser(cand.user_id) };
    }
  }
  // Legacy slow path: capped scan of recently-used NULL-prefix rows.
  // Logs a deprecation warning every time it fires so admins rotate.
  const legacy = await pgAll<TokenRow>(
    `SELECT id, user_id, token_hash FROM api_tokens
      WHERE token_prefix IS NULL AND revoked_at IS NULL
      ORDER BY last_used_at DESC NULLS LAST
      LIMIT 200`,
  );
  for (const cand of legacy) {
    if (await Bun.password.verify(token, cand.token_hash)) {
      logDeprecated(`legacy api_token authenticated; rotate token id=${cand.id}`);
      return { user: await loadUser(cand.user_id) };
    }
  }
  return null;
}
```

The 200-row cap on the legacy scan bounds worst-case auth cost regardless of how long legacy tokens stick around. The `/v0.3` release notes (next minor) document the deprecation: legacy tokens are slow, rotate within 90 days. The deprecation log line is surfaced in the workspace's audit feed so admins notice without reading server logs.

`syntheticSaUser` returns `{ id: "sa_<id>", name: "Service account: <name>", email: null, isSuperAdmin: false, … }`. Audit rows from this user surface as `committed by Service account: Fivetran sync` in the UI.

### 5.1.1 Rate limits

The Pull API is the only entry point downstream pipelines see. A misconfigured Fivetran in 1-second loop will happily eat Postgres connections without a budget. The codebase has no rate-limiting middleware today; this spec ships the first one.

v1 ships **token-bucket per credential**, backed by an in-memory map fronting a small `auth_credential_quota` Postgres row updated atomically. *Both* SA tokens and personal tokens used on the `/v1/` surface are limited — the credential's id (SA id or api_token id) is the bucket key. The same budget applies regardless of whether a developer learns about the Pull API and (incorrectly) reaches for their existing personal token first:

| Surface | Bucket key | Default budget |
|---|---|---|
| `GET /api/t/:slug/v1/dimensions/*/canonical` | SA id or `zz_` token id | 600 req/min |
| `GET /api/t/:slug/v1/dimensions/*/tombstones` | same | 600 req/min |
| `GET /api/t/:slug/v1/events` | same | 600 req/min |
| `POST /api/t/:slug/v1/webhooks*` (control plane) | same | 60 req/min |

Personal tokens used inside the UI (sessions, not `/v1/`) are unaffected — those run on cookies, not the bearer credentials this bucket keys on. UI traffic stays untouched in v1; tightening it is a separate spec.

Exceeded budgets return `429 Too Many Requests` with `Retry-After: <seconds>` and JSON body `{ error: "rate_limited", retry_after_seconds: 30 }`. The exact bucket size is configurable via `ZUGZUG_PULL_API_RPM=600` so self-hosters can raise it; 0 disables limiting entirely.

The 429 response shape is **baked in for v1** so a future tightening (lowering the default, adding per-endpoint budgets) is non-breaking for SDK authors.

### 5.2 Pull API

```
GET /api/t/:slug/v1/dimensions
    → 200 { dimensions: [ { id, slug, label, key_kind, fields: [...], canonical_count, last_committed_at } ] }

GET /api/t/:slug/v1/dimensions/:dimSlug/schema
    → 200 { dim_slug, label, fields: [ { name, type, ... } ], updated_at }

GET /api/t/:slug/v1/dimensions/:dimSlug/canonical
        ?since=<ISO>&cursor=<signed>&limit=<1..1000>
    → 200 {
        records: [
          { key, label, fields: { iso_code: "DE", region: "EMEA", ... }, updated_at, version }
        ],
        cursor: { next: "<signed>" | null },
        meta: { dim_slug, total_in_filter: 248, page_size: 100, current_version: 47 }
      }
    /* Returns only live rows (retired_at IS NULL). Retired/merged keys are
       served exclusively by /tombstones — see §4.5. */

GET /api/t/:slug/v1/dimensions/:dimSlug/canonical/:key
    → 200 { key, label, fields, updated_at, version }
    → 404 { error: "not_found" }

GET /api/t/:slug/v1/dimensions/:dimSlug/tombstones?since=<ISO>&cursor=<signed>
    → 200 {
        tombstones: [
          { key, retired_at, retired_into?: "US" }   // retired_into present iff merged
        ],
        cursor: { next: "<signed>" | null }
      }
    /* Use case: webhook payload had changes_truncated=true; consumer enumerates
       retired/merged keys here to keep their mirror in sync. */

GET /api/t/:slug/v1/events?since=<ISO>&type=dimension.committed&cursor=<signed>&limit=<1..200>
    → 200 {
        events: [
          { id, type, occurred_at, data: { ... } }
        ],
        cursor: { next: "<signed>" | null }
      }
```

**Cursor.** HMAC-signed; format documented in §4.6. Server rejects mismatched workspace with 400 `cursor_mismatch`; signature failure with 400 `cursor_invalid`. Cursors for `/events` may also return 410 `cursor_expired` when the underlying event row is older than the 30-day retention window. Cursors for `/canonical` never return 410.

**Default `limit`.** 100 for `/canonical` and `/tombstones`, 50 for `/events`. Max 1000 / 200 respectively. Documented in response `meta.page_size`.

**`since` semantics.** `?since=2026-06-14T12:00:00Z` returns records with `updated_at >= since`. **Inclusive on the lower bound** — so a consumer that stores "last seen `updated_at`" and re-queries with that exact value never misses a row. Duplicates are possible (a record updated at exactly the boundary) and consumers dedupe by `(key, version)`.

**Index plan.** See §4.5 for the SQL plan that produces this response, the supporting `canonical_version_pull_idx`, and the Phase 1 backfill for pre-existing rows.

**ETag + If-Modified-Since.** Not in v1. The cursor format already makes incremental pulls cheap; adding ETag is post-v1 polish.

### 5.3 Webhook CRUD (UI-driven, but exposed under /v1)

```
GET    /api/t/:slug/v1/webhooks                          → list workspace's webhooks
POST   /api/t/:slug/v1/webhooks       { url, events, description? }   → 201 { webhook, secret }
                                                                        (secret shown ONCE)
GET    /api/t/:slug/v1/webhooks/:id                      → webhook detail
PATCH  /api/t/:slug/v1/webhooks/:id   { url?, events?, status?, description? }   → 204
                                                          // status ∈ {active, paused}
                                                          // (re-enable a disabled hook via /reactivate)
DELETE /api/t/:slug/v1/webhooks/:id                      → 204
POST   /api/t/:slug/v1/webhooks/:id/reactivate           → 204
                                                          // moves status from disabled→active
POST   /api/t/:slug/v1/webhooks/:id/rotate-secret        → 200 { secret, previous_expires_at }
                                                          // 24h grace; see §4.3
POST   /api/t/:slug/v1/webhooks/:id/test                 → 200 { delivery_id }
                                                          // sets is_test=true on the delivery row

GET    /api/t/:slug/v1/webhooks/:id/deliveries?status=&since=&cursor=&limit=
                                                         → paginated delivery log
GET    /api/t/:slug/v1/webhook-deliveries/:id            → single delivery (with full payload + signature)
POST   /api/t/:slug/v1/webhook-deliveries/:id/replay     → 202 { delivery_id }
                                                          // clones row, re-enqueues with attempts=0
```

**URL validation and normalization.** `POST /webhooks` and `PATCH /webhooks/:id` normalize the URL at the application layer **before** storing it. The handler runs `new URL(input)`; if that throws, return `400 invalid_url`. Then:

- `https://` — accepted (modulo parseability).
- `http://localhost`, `http://127.0.0.1`, `http://[::1]` — accepted when `ZUGZUG_SELF_HOSTED=1` env var is set. Rejected with 400 `https_required` otherwise.
- Any other `http://` — rejected with 400 `https_required`.
- Hosted SaaS sets `ZUGZUG_SELF_HOSTED=0` (the default) so every deployment that's not explicitly self-host blocks plaintext.

The accepted URL is then normalized via `url.toString()` (lowercases the host, encodes the path, leaves the query unchanged) and stored as the canonical form. The duplicate-URL detection on the list (§4.1 / §6.3) compares **normalized** strings, so `https://api.acme.com/zz` and `https://api.acme.com/zz/` both detect as duplicates, as do equivalent percent-encodings. Two URLs that differ only in query string remain distinct subscriptions (intentional — `?env=prod` is a routing hint).

The DB CHECK (`webhook_url_scheme_chk`) only catches `^https?://` malformations; the env-aware policy and the `new URL()` parseability check live in TypeScript.

**Test event semantics.** `webhook.test` is a synthetic event fired manually from the *Send a test event* button (§5.3 POST `/webhooks/:id/test`). It is **not** a subscribable event type:

- It is absent from the `webhook_events_known_chk` allowlist in §4.1 — a customer cannot subscribe to it via `POST /webhooks {events: [...]}` (validator returns `400 unknown_event_type`).
- It is never written to `outbound_event` — `outbound_event_type_chk` (§4.1) excludes it. The synthetic delivery row in `webhook_delivery` is created directly by the test handler with `is_test=true`.
- The Create Webhook modal does NOT show a `webhook.test` checkbox in its events list (§6.3).
- Test events are dispatched to the webhook URL regardless of the subscription's `events` array — that's how the *Send a test event* button can verify the endpoint even when the subscription is filtered to a single production event type.

Subscribers SHOULD branch on `type === "webhook.test"` and short-circuit any business logic — the payload's `data.dim_slug` is `null` and `data.message` is a sentinel string ("This is a test event from the Zugzug UI."). The delivery log surfaces a `TEST` badge on rows where `is_test=true` so test events don't get buried among real ones.

**Auto-disable counter.** "50 consecutive failed deliveries" is defined as:

> The last 50 **non-test** `webhook_delivery` rows for the webhook (ordered by `created_at DESC`, filtered `WHERE is_test = false`) all have `status='dlq'` and no `status='success'` appears in the window.

A retry chain that ends in DLQ counts as **one failure** (one terminal row), not five. Test deliveries do NOT contribute — without this filter, an admin sending 50 test events to a broken URL while debugging would auto-disable a webhook that has no real traffic yet, and a customer could game the threshold by spamming the Send Test button. Implementation:

```sql
SELECT bool_and(status = 'dlq') AS all_dlq, count(*) AS n
FROM (
  SELECT status FROM webhook_delivery
   WHERE webhook_id = $1 AND is_test = false
   ORDER BY created_at DESC
   LIMIT 50
) recent;
-- if all_dlq AND n = 50, UPDATE webhook SET status='disabled', disabled_at=now(),
--   disabled_reason='auto: 50 consecutive failed deliveries'.
```

The window is checked when the dispatcher transitions a non-test delivery to `dlq`. The `webhook_delivery_webhook_time_idx` (b, §4.1) covers this read with `INCLUDE (status, is_test)`; no heap fetch. The Phase 1 migration's raw `CREATE INDEX ... INCLUDE` clause names both columns.

### 5.4 Service account CRUD

```
GET    /api/t/:slug/v1/service-accounts                  → list
POST   /api/t/:slug/v1/service-accounts  { name, expires_at?: ISO|null }
                                                         → 201 { service_account, value }
                                                           (value shown ONCE)
DELETE /api/t/:slug/v1/service-accounts/:id              → 204 (sets revoked_at)
```

Admin-gated; viewers and editors get 403. UI hides the surface for non-admins.

### 5.5 Wire shapes

**Canonical record (Pull API response):**

```json
{
  "key": "DE",
  "label": "Germany",
  "fields": {
    "iso_code": "DE",
    "region": "EMEA",
    "population": 84432670,
    "continent": "Europe"
  },
  "updated_at": "2026-06-14T11:32:04.118Z",
  "version": 12
}
```

`fields` keys are the dim's `field` names (the same identifiers `GET /schema` returns); values are the **typed** JSON form (numbers as JSON numbers, dates as ISO strings, linked references as `{ "key": "EU", "label": "Europe" }`).

**Webhook payload:**

```json
{
  "id": "evt_01H8X8R6V5J5VFE5G2X8X8R6V5",
  "type": "dimension.committed",
  "api_version": "v1",
  "workspace": { "id": "acme", "slug": "acme" },
  "occurred_at": "2026-06-14T11:32:04.118Z",
  "data": {
    "dim_slug": "country",
    "dim_label": "Country",
    "version": 47,
    "previous_version": 46,
    "committed_by": { "id": "u_abc", "name": "Ada Berg" },
    "changes": {
      "added":    [{ "key": "DE", "label": "Germany" }],
      "updated":  [{ "key": "US", "label": "United States" }],
      "merged":   [{ "from": "USA", "into": "US" }],
      "retired":  []
    },
    "summary": { "added": 1, "updated": 1, "merged": 1, "retired": 0 }
  }
}
```

`workspace.id` is the `tenant.id` — a short slug-shaped identifier constrained to `^[a-z][a-z0-9_]{0,20}$` (see `tenant.ts` and `schema.ts:tenant_id_format`). It is **stable** across slug renames: when an admin renames a workspace via the slug-rename flow, the `tenant.id` does not change; only the `tenant.slug` does. Consumers join on `workspace.id`, render `workspace.slug`. For workspaces created with `id === slug` (the default — see `provisionTenant` in `tenant.ts`) the two values are identical at first; after a slug rename, only `workspace.slug` changes. The header `X-Zugzug-Workspace` carries the same `workspace.id` value (e.g. `acme`), NOT a prefixed ULID — the data model does not permit ULID-shaped tenant ids.

`data.changes` arrays cap at 200 entries per category — beyond that, the array is truncated and a `data.changes_truncated: true` flag is added. Consumers who need the **full list of additions/updates** call `/api/t/:slug/v1/dimensions/:dimSlug/canonical?since=<previous-version-time>`; for **retired and merged keys** they call `/dimensions/:dimSlug/tombstones?since=<previous-version-time>` (the canonical endpoint can't enumerate keys that no longer exist). Both endpoints are paginated.

**Headers on every webhook POST:**

```
POST <url> HTTP/1.1
Content-Type: application/json
User-Agent: Zugzug-Webhooks/1.0
X-Zugzug-Event: dimension.committed
X-Zugzug-Event-Id: evt_01H8X8R6V5J5VFE5G2X8X8R6V5
X-Zugzug-Delivery-Id: whd_01H8X8R7M2Q3K6V8X8R6V5J5V
X-Zugzug-Workspace: acme
X-Zugzug-Signature: t=1718363524,kid=current,v1=sha256=<hex>
X-Zugzug-Attempt: 1
```

**Signature.** `v1=sha256=<hex>` where hex = `HMAC_SHA256(secret, "<timestamp>.<body>")`. The `t=` field is the unix timestamp the request was signed at. The `kid=` field is `current` or `previous` — see §4.3; during a rotation grace window the receiver checks the signature against the matching secret. Subscribers reject deliveries with `|now - t| > 300s` (**absolute value**, both stale and future-skewed) to prevent replay or future-clock attacks. This is the **Stripe pattern**, deliberately, because it's the one customers' shared libraries already know how to verify.

**Verification recipe (canonical).** This snippet is the one subscribers should copy verbatim. It is shown in the Pull API page's *Webhook signing recipe* tab (§6.2) — always reachable, not just inside the one-shot secret reveal modal — and on every webhook detail page's overview tab so operators debugging a signature mismatch can compare against the source of truth.

```ts
// Node 18+; secrets is { current: string, previous?: string }.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyZugzugSignature(rawBody: string, header: string, secrets: {
  current: string; previous?: string;
}): boolean {
  // Header shape: "t=<unix>,kid=<current|previous>,v1=sha256=<hex>"
  const parts: Record<string, string> = {};
  for (const seg of header.split(",")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  if (!parts.t || !parts.kid || !parts.v1) return false;

  // Reject clocks more than 5 minutes off in EITHER direction — prevents
  // replay (stale) and future-clock attacks.
  const skew = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(skew) || skew > 300) return false;

  // v1 = "sha256=<hex>"; extract the hex prefix-checked, length-checked.
  const m = /^sha256=([0-9a-f]{64})$/.exec(parts.v1);
  if (!m) return false;
  const provided = Buffer.from(m[1], "hex");

  const secret = parts.kid === "previous" ? secrets.previous : secrets.current;
  if (!secret) return false;

  const expected = createHmac("sha256", secret)
    .update(parts.t + "." + rawBody)
    .digest();

  if (expected.length !== provided.length) return false;   // belt-and-suspenders
  return timingSafeEqual(expected, provided);
}
```

The recipe is correct on three subtleties prior drafts got wrong:

- `Math.abs` on the skew check — `now/1000 - t < 300` lets future-timestamped replays through; `|skew|` does not.
- A regex-bounded hex extraction with explicit length 64 — feeding a short or malformed `v1` value into `timingSafeEqual` throws on length mismatch; a malformed header therefore returned 500 instead of `false`.
- An explicit length compare before `timingSafeEqual` — the regex makes this redundant in normal flow but keeps the function safe for callers that swap the regex out.

The same recipe lives as a copyable code block at `/integrations/pull-api` (Webhooks tab) — operators don't need to rotate a secret to retrieve it.

**Idempotency.** `X-Zugzug-Event-Id` is **stable across retries**. A delivery for the same event posted three times carries the same `X-Zugzug-Event-Id`. Subscribers SHOULD dedupe on this key.

**Delivery semantics.** At-least-once. Subscribers must be idempotent. Documented prominently in the *Pull API* page's "Webhooks" tab.

**Retry schedule (fixed, tuned).** A bounded ladder, NOT exponential backoff:

| Attempt | Wait | Total elapsed |
|---|---|---|
| 1 | 0s (immediate) | +0s |
| 2 | 5s | +5s |
| 3 | 30s | +35s |
| 4 | 5m | +5m 35s |
| 5 | 1h | +1h 5m 35s |
| DLQ | — | terminal |

The fast first retry (5s) is deliberately aggressive — a deploy in flight at the subscriber side typically recovers in seconds, and we'd rather burn a retry quickly than make the user wait 5 minutes for a transient. The schedule is hardcoded in v1; "configurable retry policy" is post-v1.

**Auto-disable.** A webhook with 50 consecutive failed deliveries (precise definition in §5.3) moves to `status='disabled'` with `disabled_reason='auto: 50 consecutive failed deliveries'`. The detail page shows a banner. Admins must explicitly hit *Reactivate*. Prevents pinning a dispatcher worker on a permanently dead URL.

**Timeouts.** A 10-second total deadline enforced by `AbortController` on the underlying fetch. A hung TCP socket cannot pin a dispatcher worker. The same AbortController fires when the dispatcher is asked to drain on shutdown — see §3.3.

### 5.6 Sample curl

```
# List dimensions
curl -H "Authorization: Bearer zzsa_abc..." \
     https://zugzug.app/api/t/acme/v1/dimensions

# Pull canonical Country records since last sync
curl -H "Authorization: Bearer zzsa_abc..." \
     "https://zugzug.app/api/t/acme/v1/dimensions/country/canonical?since=2026-06-14T00:00:00Z&limit=500"

# Subscribe a webhook
curl -X POST -H "Authorization: Bearer zzsa_abc..." \
     -H "Content-Type: application/json" \
     -d '{"url":"https://api.acme.com/zugzug","events":["dimension.committed"]}' \
     https://zugzug.app/api/t/acme/v1/webhooks
```

---

## 6. UI surface

### 6.1 New top-level nav entry: *Integrations*

Sibling of *Connections* in `AppShell`. Icon: outbound-arrow circle. URL: `/app/:slug/integrations` (default redirects to `/pull-api`).

```
/app/:slug/integrations
  ├─ /pull-api             default
  ├─ /webhooks
  └─ /service-accounts
```

The integrations layout uses the same `SettingsShell` primitive (220px left rail + outlet) the Settings IA established, with `IntegrationsSidebar` listing three items. Same visual chrome as Settings; same role gating idioms (`RoleGate`, `ReadOnly`).

### 6.2 Page: *Pull API*

A single-screen reference page with two tabs (`Endpoints` default, `Webhooks` for signing recipe + payload shape), not a CRUD form. Sections of the *Endpoints* tab, top to bottom:

1. **Banner card.** "Your canonical records, available as a JSON API. Use this to sync into dbt, Fivetran, or any ETL pipeline." Includes a copyable base URL: `https://<host>/api/t/<slug>/v1`. An admin-only "Developer details" disclosure (see §6.7) reveals the underlying `outbound_event` table name and current pending event count.
2. **Authentication.** Short paragraph + a `curl` block. Has an "Open service accounts →" link that deep-links to the Service Accounts page.
3. **Endpoints list.** Four subsections, each a card:
   - `GET /v1/dimensions` — list this workspace's dimensions.
   - `GET /v1/dimensions/:slug/schema` — get a dimension's field schema.
   - `GET /v1/dimensions/:slug/canonical` — paginated canonical records.
   - `GET /v1/dimensions/:slug/tombstones` — paginated retired/merged keys (used when a webhook reports `changes_truncated`).

   Each card has a request signature, a brief description, and an *expandable* "Sample response" block. The slug in the example is **pre-filled with one of the workspace's actual dimensions** (e.g. `/v1/dimensions/country/canonical`) so the user can copy-paste verbatim.
4. **Dimensions table.** A list of every dimension in the workspace with: slug, label, current record count, last commit, and a "Copy curl" button that copies a pre-authenticated `curl` line (without the actual token — placeholder `zzsa_YOUR_TOKEN`).
5. **Pagination + incremental section.** Worked example with cursor + `?since`. Shows expected JSON wire shape and notes that cursors are HMAC-signed (§4.6).
6. **Rate limits panel.** States the per-credential budget (600 req/min, configurable via `ZUGZUG_PULL_API_RPM`) and the 429 response shape (§5.1.1).

The *Webhooks* tab of the same page (also linked from the sidebar as **Webhook signing recipe →**) stands as the operator's permanent reference for HMAC verification — the canonical recipe from §5.5 is shown as a copyable code block, alongside the example payload + headers and the retry-schedule table. **This is a standing reference, NOT only inside the secret-reveal modal**, so a customer debugging a signature failure six months after creating the webhook does not need to rotate a secret to recover the recipe.

### 6.3 Page: *Webhooks*

List + detail. The list is a table:

```
| URL                                  | Events                       | Status     | Last delivery       |        |
|--------------------------------------|------------------------------|------------|---------------------|--------|
| https://api.acme.com/zz              | dimension.committed (+1)     | Active     | 12s ago · 200       | View > |
| https://hooks.bigcorp.com/zugzug     | dimension.committed          | Disabled   | 3h ago · 502        | View > |
| https://staging.acme.com/zz          | dimension.committed (+1)     | Paused     | 1d ago · 204        | View > |
```

A **duplicate URL chip** ("⚠ duplicate URL — also subscribed by another webhook") renders inline on **every** row whose normalized URL (§5.3 URL validation) matches another row's URL. The relationship is **symmetric**: if rows A and B share a URL, both rows show the chip — there is no "first owner" of a duplicate URL pairing. The table footer counts rows with the chip (`N duplicate URLs`), so two rows pointing at one URL yields `2 duplicate URLs`. See §4.1.

The three statuses correspond directly to `webhook.status`:

- **Active** — `status='active'`. Receiving deliveries.
- **Paused** — `status='paused'`, manually set by an admin via PATCH. Deliveries enqueue but the dispatcher skips paused rows (and re-queues with backoff once unpaused).
- **Disabled** — `status='disabled'`, set automatically after 50 consecutive failed deliveries. Banner + *Reactivate* button.

Header has *+ New webhook*. Empty state has illustrated card + "Create your first webhook" CTA.

**Detail view** (`/integrations/webhooks/:id`) is a single column with sections:

- **Overview** — URL, events (chips), status (Active / Paused / Disabled) with PATCH controls, description, signing secret (`whsec_xx•••••` with a *Rotate* affordance). A `kid=` badge **only appears during the 24h rotation grace window** (while `secret_previous_expires_at > now()`) — in steady state every webhook signs with current and showing the badge is noise that confuses customers who haven't rotated anything. During the grace window the overview shows both prefixes (`whsec_b8K3kP•••• kid=current` / `whsec_a4F8mN•••• kid=previous`) and a countdown to expiry.
- **Send a test event** — button posts `webhook.test`; the resulting delivery row is annotated with a `TEST` badge so test events don't get buried among real ones.
- **Delivery log** — table of recent deliveries, latest first. Each row: status badge, event type, attempts (e.g. `2/5`), response code, latency, timestamp, expand-row to reveal the full payload, response body, signature (with kid), and a *Replay* button. The Replay button is enabled even for rows whose original `signing_kid='previous'`; if the previous secret has been swept (post-grace), the replay re-signs with current — a small banner on the row explains this (see §4.3 replay-after-grace).
- **Danger zone** — *Delete webhook* opens the shared `ConfirmDialog` primitive (same component used for personal-token revoke, dimension delete, member removal). The dialog requires the user to type the webhook URL exactly to enable the destructive button. Reusing the existing component keeps the typed-confirm interaction consistent across the product; no bespoke modal.

**Create webhook modal** (the mockup demonstrates this):

```
┌────────────────────────────────────────────────────────────┐
│  New webhook                                          [X]  │
├────────────────────────────────────────────────────────────┤
│  Endpoint URL                                              │
│  [ https://api.acme.com/zugzug                          ]  │
│  └ HTTPS required.                                         │
│                                                            │
│  Events to subscribe                                       │
│  [✓] dimension.committed   When canonical records change.  │
│  [ ] dimension.created     When a new dimension is set up. │
│  [ ] canonical.deleted     When a single record is retire. │
│  [ ] dimension.schema.updated                              │
│                                                            │
│  Description (optional)                                    │
│  [ Sync into Acme CRM                                  ]   │
│                                                            │
│  Signing secret will be generated and shown once.          │
│  Test events can be sent from the webhook detail page once │
│  the subscription exists.                                  │
│                                                            │
│              [ Cancel ]     [ Create webhook ]             │
└────────────────────────────────────────────────────────────┘
```

The list intentionally **excludes** `webhook.test` — it is not a subscribable event (§5.3, §7.1). The *Send a test event* button on the webhook detail page is the only path that produces `webhook.test` deliveries.

After Create, a **second** modal is presented (cannot dismiss with Esc; explicit *I have copied the secret* confirm):

```
┌────────────────────────────────────────────────────────────┐
│  Copy your signing secret                                  │
├────────────────────────────────────────────────────────────┤
│  This is the only time you'll see this value.              │
│                                                            │
│  ┌────────────────────────────────────────────────┐  📋   │
│  │ whsec_b8K3kP9mQ2vN7L4xR8jH3sT5uW8yA1zE6cD9fG2  │       │
│  └────────────────────────────────────────────────┘       │
│                                                            │
│  Add it to your verifying code as the HMAC key.            │
│                                                            │
│                      [ I've copied it ]                    │
└────────────────────────────────────────────────────────────┘
```

### 6.4 Page: *Service accounts*

Same shape as the existing `/settings/tokens` page (which stays for personal tokens), but for workspace-scoped credentials:

- List shows: name, prefix (`zzsa_b8K3kP•••`), scopes (chip), created by, last used, expires.
- *Create* opens an inline form: name, expiration (None / 90 days / 1 year), scope (read-only in v1, multi-checkbox UI in place so adding `webhook:manage` later doesn't move things around).
- On create: full token shown once in a warning-bordered card, copy button, *Done* button to dismiss.
- *Revoke* opens the same `ConfirmDialog` pattern as personal tokens.

A "Developer details" disclosure (see §6.7) reveals the `service_account.id` next to the prefix.

### 6.5 Removed surface

The "Master records" card is removed from the Workspace > Connections page. Stable selector: the `<section>` inside `ConnectionsSection` in `app/src/routes/settings/Warehouse.tsx` whose first child renders the literal heading `"Master records"`. The deletion replaces that block with nothing; its informational content moves into the *Pull API* page's "Where canonical lives" introductory card (§6.2 step 1 + §6 panel 6).

The standalone Parquet snapshot link (`<a href={`/api/dimensions/${dim.id}/snapshot.parquet`}>`) in `TablePane.tsx` and `Triage.tsx` stays — it's a *per-dimension UI affordance*, not the outbound surface. The Integrations page gets its own "Download Parquet snapshot" subsection inside the Pull API page that links to it.

> **Coordination with the Settings IA redesign (2026-06-12).** That redesign refactored `Warehouse.tsx` to host both Warehouse and App-state cards under a single `ConnectionsSection`. The Master records card landed inside the same component. This spec must land *after* the IA redesign — if the IA redesign is still in flight when this spec ships, the deletion targets a yet-to-merge section and the PR has to be rebased. The deletion uses a heading-text selector (`Master records`) instead of line numbers so a small JSX reshuffle in the IA PR doesn't break it. See §10 Coordination.

### 6.6 AppShell nav update

```
[icon] Dashboard
[icon] Triage
[icon] Sources
[icon] Tables
[icon] Connections          ← was the only outward-facing section
[icon] Integrations         ← NEW
[icon] Activity
[icon] Settings
```

`Connections` becomes inbound-only (Warehouse, Sources). `Integrations` is the outbound peer.

### 6.7 "Developer details" disclosure

Several admin-facing places in the Integrations surface need to surface low-level details (raw event-table name, dispatcher backlog count, internal IDs) without cluttering the default view. We use a consistent pattern:

- A `<details data-testid="developer-details">` element rendered at the bottom of pages where it makes sense (Pull API banner, Service-accounts list rows, webhook delivery rows).
- Only visible to **admins** (role gated; viewers and editors don't see the disclosure at all).
- Closed by default; localStorage'd to per-user "open / closed" so a developer who likes it open sees it that way.
- This replaces any reference to a global "Engineer mode" — Zugzug has no such mode; the disclosure is local to each surface that needs it.

---

## 7. Event taxonomy

### 7.1 v1 event types

Subscribable types (the only values valid in `webhook.events`):

| Type | When emitted | Payload shape |
|---|---|---|
| `dimension.committed` | Once per `repo-canonical.commit()` call that produced any change | `data: { dim_slug, dim_label, version, previous_version, committed_by, changes: { added, updated, merged, retired }, summary, changes_truncated? }` |
| `dimension.created` | Once per `addDimension()` (UI: Create dimension) | `data: { dim_slug, dim_label, fields: [{ name, type, ... }] }` |
| `dimension.schema.updated` | Once per `dimension_field` row added/removed/renamed | `data: { dim_slug, change: "field_added" \| "field_removed" \| "field_renamed", field: {...}, previous?: {...} }` |
| `canonical.deleted` | Per row deleted via the canonical delete endpoint (rare; not part of normal commit flow) | `data: { dim_slug, key, label, deleted_by }` |

Synthetic type (NOT subscribable):

| Type | How produced | Payload shape |
|---|---|---|
| `webhook.test` | Only by `POST /webhooks/:id/test` — synthesised at the test handler with `is_test=true`. NEVER written to `outbound_event`. Cannot appear in any `webhook.events` array (DB CHECK enforces). | `data: { dim_slug: null, message: "This is a test event from the Zugzug UI." }` |

A subscriber that picked `dimension.committed` receives only that type. The events array on `webhook` is a literal whitelist; nothing implied or wildcarded. `webhook.test` is dispatched directly to the webhook URL by the test handler regardless of the subscription's events array — that's what makes "Send a test event" usable as a working-endpoint diagnostic even on a subscription filtered to a single production event type.

### 7.2 Event ordering

Events for a given tenant are **partial-ordered by `occurred_at`**. We do not guarantee that delivery order matches occurrence order — a retry of a 2-minute-old event can arrive after a fresh event of the same type. Subscribers that need strict order use the Pull API.

### 7.3 Future event types (reserved, not implemented v1)

- `draft.staged` / `draft.discarded` — useful for "review board" integrations.
- `source.scan.failed` — alert hooks for on-call.
- `member.added` / `member.removed` — audit log mirror.

These are **not currently accepted at the API**. The `webhook_events_known_chk` CHECK constraint (§4.1) restricts `webhook.events` to the v1 taxonomy, and `POST /webhooks` validates the array against the same list, returning 400 `unknown_event_type` with a `valid_events` list in the response body if a client subscribes to an unknown name. The day we ship a reserved type, the migration extends the CHECK and adds it to the validator — keeping the closed taxonomy strict on both the DB and the API surface means a customer never sees a "subscribed but silent" state.

---

## 8. Edge cases

| Case | Behavior |
|---|---|
| Webhook URL returns 4xx (other than 429) | Retry per schedule. After attempts = 5, `dlq`. Logged. Banner on detail page shows the latest 4xx body for debugging. |
| Webhook URL returns 429 | Treated as retry, but `next_attempt_at` honors a `Retry-After` header if present (up to 1h). |
| Webhook URL returns 5xx or times out | Retry per schedule. |
| Subscriber sends back >2 KB of body | Truncated at 2 KB in `webhook_delivery.last_response_body`. The truncation marker surfaces in the admin-only Developer details disclosure (§6.7). |
| `outbound_event` insert during commit fails | Commit transaction aborts (the INSERT is inside the same Postgres tx as the canonical write). The user sees a failed commit. This case indicates a logic bug: the constraints that can fail (`idem_key` collision, `type` length overflow, `webhook_events_known_chk`) are all controlled by application code. We do NOT silently swallow the failure to "protect" the commit — that would create a state where canonical data has moved forward but no outbound notification was recorded, breaking §3.1's "one source of truth" guarantee. See §3.1 for the rationale. |
| Webhook deleted while deliveries are pending | Pending deliveries for that webhook are marked `status = dlq` with `last_error = "webhook_deleted"`. They show in the delivery log until retention sweep. |
| Webhook URL is `http://` (not https) | Rejected at create with 400 `https_required`. The one exception: `http://localhost`, `http://127.0.0.1`, `http://[::1]` are accepted **when the deployment sets `ZUGZUG_SELF_HOSTED=1`**. Hosted SaaS never sets this and rejects every plaintext URL on every workspace; self-host operators choose the trade-off. The check lives in application code (§5.3), not in a Postgres CHECK constraint, because the database can't read env vars. |
| Webhook URL points at private IP (10.x, 172.16/12, 192.168.x, 169.254.x) | **Allowed.** Self-hosters integrate with internal services. We do not SSRF-filter — the operator's responsibility on a self-hosted product. (Documented prominently. The hosted SaaS would filter, but that's not what v1 ships.) |
| Subscriber's TLS cert is expired/invalid | Treated as a transient error, retried, eventually DLQ'd. The error log shows the TLS reason. |
| Replay a `dlq` delivery | Clones the row, sets `attempts = 0`, `status = 'pending'`, `next_attempt_at = now()`, copies the original `delivery_url` to the new row. **Signing kid:** if the original `signing_kid='current'`, keep it; if `signing_kid='previous'` AND the previous secret still exists, keep it; if `signing_kid='previous'` AND the previous secret has been swept (post-grace), re-sign with `kid=current` and the row carries a banner explaining the change. Original DLQ row stays for audit. See §4.3. |
| Replay a `success` delivery | Same as above. The original row keeps `status = success`. Replays show as a separate delivery row in the log. |
| Pull API `?since` is older than 30d retention | **`/canonical` and `/tombstones`**: 200 with the data we still have. Canonical data is the system of record; rows are never aged. The `?since` filter just returns records updated in the window. **`/events`**: 200 too (with whatever's still in the 30-day window). Same semantics either way. There is no "data was here but is gone" error for these endpoints. |
| Pull API cursor signature invalid | 400 `cursor_invalid`. Caller resyncs from scratch. |
| Pull API cursor is from another workspace | 400 `cursor_mismatch`. Caller resyncs from scratch. |
| Pull API cursor refers to a deleted dimension | 410 `dimension_gone`. Caller resyncs from scratch. |
| Pull API cursor on `/events` is older than 30d retention | 410 `cursor_expired`. The underlying event has been swept; the cursor cannot anchor a continuation. Caller does a fresh `?since=<now-30d>` to resume. `/canonical` cursors never 410 (canonical is retained forever). |
| Service account used after `expires_at` | 401 `token_expired`. Auto-revocation happens lazily on first use after expiry (no nightly job needed). |
| Service account used after `revoked_at` | 401 `token_revoked`. |
| Service account hits rate limit (default 600 req/min) | 429 `rate_limited` with `Retry-After` header. See §5.1.1. |
| Webhook signing secret rotated | New events sign with `kid=current` using the new secret. The previous secret stays valid for a **24-hour grace window** stored in `secret_ciphertext_previous` / `secret_previous_expires_at`; subscribers verifying against the `kid=current` or `kid=previous` accept either during the window. **In-flight deliveries are NOT re-signed** — the row's `payload` and stored `signature` are the inviolable record of what was sent; the dispatcher reuses both verbatim on retry. After the grace window, a SchedulerJob zeroes out the previous secret. (See §4.3.) |
| Two webhooks subscribe to the same event | Two deliveries are created. Each retried independently. Order across subscribers not guaranteed. |
| Two webhooks share the same URL | Allowed. The list UI annotates rows with a "duplicate URL" warning chip so the case is visible (a customer may want one subscription per event subset). See §4.1. |
| Webhook URL is edited while events haven't been delivered yet | Pending deliveries continue to POST to the **original URL snapshotted into `delivery_url` at enqueue time**. Future events go to the new URL. This prevents an exfiltration vector where a URL edit reroutes a payload signed with the legitimate secret to an attacker-controlled host. To re-route in-flight events, the admin must delete the webhook (which DLQs the pending rows) and create a new one. |
| Webhook paused longer than 30 days, then resumed | Subscribers DO miss events whose `webhook_delivery` rows have been swept by the 30-day retention. `webhook_delivery.event_id` is a varchar with NO foreign key to `outbound_event` (§4.4), and `webhook_delivery.payload` is the self-contained record of what was sent — so deliveries that are still inside the 30-day window get fired at unpause. For longer pauses, the operator's recourse is a Pull API resync from `?since=<pause-start-time>` (`/canonical` is never aged; `/tombstones` carries 30 days). The webhook pause UI shows a warning chip when paused > 7 days: "Resuming after Nd will skip events older than 30d — plan a Pull API sync." |
| Workspace slug renamed | The webhook payload's `workspace.id` is unchanged (it's the stable `tenant.id`). `workspace.slug` reflects the new slug at delivery time. The path-scoped routing has a **30-day redirect alias**: requests to `/api/t/<old-slug>/v1/...` return `301 Moved Permanently` with a `Location` header pointing at the new slug, AND audit-log the redirect under a *Stale slug usage* counter so operators can identify which integrations haven't migrated. After 30 days the alias drops and old paths 404. SA tokens authenticate either path during the alias window. The Settings slug-rename modal lists every active SA token + every active webhook URL so the operator has a migration checklist before committing the rename. Subscribers should join on `workspace.id`, which is stable across rename. |
| Subscriber takes the request and accepts the body but kills the connection before responding | Treated as a 5xx network error, retried. Subscribers who do "process async after accepting" must respond 2xx **first**, then process. |
| Webhooks usage on the `default` tenant | The `default` tenant is a real tenant for self-host single-workspace operation; webhook endpoints work there normally. (Removed the earlier "404 on default" rule — it conflicted with the `http://localhost` allow logic and was never a sensible policy.) |
| Tenant deleted while events / deliveries / webhooks exist | `teardownTenant()` deletes child rows by tenant_id (existing cascade pattern). Pending deliveries vanish. |

---

## 9. Permissions and multi-tenant

Every new table has a non-null `tenant_id` with an FK to `tenant.id`. Tenant resolution uses the existing `/api/t/:slug/...` middleware (§5); every endpoint scopes by `WHERE tenant_id = $tenantId`.

The matrix distinguishes **session-authenticated users** (a UI user with a session cookie or a personal `zz_` token; carries a real role from `tenant_member`) from **service-account tokens** (synthesised role; scope-gated):

| Action | viewer | editor | admin | super-admin | SA (scope=`read`) |
|---|---|---|---|---|---|
| `integrations.pull_api.view` (the docs page) | yes | yes | yes | yes | n/a (no UI) |
| `integrations.webhooks.view` (list + detail metadata) | yes | yes | yes | yes | n/a |
| `integrations.webhooks.delivery_log_view` (list of attempts, no payload) | yes | yes | yes | yes | n/a |
| `integrations.webhooks.delivery_payload_view` (request body, signature, response body) | **no** | yes | yes | yes | n/a |
| `integrations.webhooks.edit` (create/edit/delete/rotate/test/replay/reactivate) | no | no | **yes** | yes | no |
| `integrations.service_accounts.view` | no | yes | yes | yes | n/a |
| `integrations.service_accounts.edit` (create/revoke) | no | no | **yes** | yes | no |
| Pull API `GET /v1/...` reads | n/a | n/a | n/a | n/a | **yes** |
| Pull API control plane (`POST /v1/webhooks*`, `/service-accounts*`) | n/a | n/a | n/a | n/a | **no** (needs `webhook:manage`; reserved, not in v1) |

Rules:

- **Viewer payload visibility is deliberately narrower than list visibility.** A viewer can see *that* a delivery happened (status, event type, timestamps, attempt count) but NOT the request body, signature, or response body — both can carry enriched fields and subscriber-side request IDs that leak information. Server-side: the `GET /webhooks/:id/deliveries` route returns `payload: null` and `signature: null` and `last_response_body: null` when `role = 'viewer'`. UI-side: the delivery-row expand button is hidden for viewers, with a tooltip "Editor or higher required to view payload."
- **Webhooks visible to editors** — debugging is a daily task; an editor watching a delivery fail and emailing an admin is fine. Editing requires admin (creates a credential).
- **Service accounts hidden from viewers** — credential inventory is sensitive. Editors see (read-only) so they can debug "is dbt using a current token?". Editing requires admin.
- **Replay is a mutation.** Editors see the *Replay* button disabled with tooltip `Admin only`.
- **SA tokens carry `role = 'viewer'`** (synthesised in `resolveTenantContext`; §5.1) and are scope-gated. Mutation routes call `requireScope(ctx, 'webhook:manage')` BEFORE consulting role; v1 SA tokens have only `['read']` so every mutating call returns `403 scope_insufficient`. Adding `webhook:manage` is non-breaking: existing tokens stay read-only.
- **Service-account tokens are workspace-bound at issue time.** A `zzsa_` token authenticates **only** when the URL's `:slug` resolves to the same `tenant.id` the token was issued for; a mismatch is a 403 at the auth layer, before any route handler runs. During the 30-day redirect alias window (see §8 slug rename), the old slug counts as resolving to the same tenant.
- **Personal `zz_` tokens** authenticate the user across all their workspaces. The same path-scoped `/api/t/:slug/v1/...` URL chooses the workspace — no `X-Tenant` header, no `?workspace=` query param. A user hitting `/api/t/acme/v1/...` is acting as their `acme` membership; `/api/t/bigcorp/v1/...` is their `bigcorp` membership. Personal tokens carry the user's actual role in that workspace (from `tenant_member`) and the matrix rows above apply unchanged.

`can()` extends to the new actions (including the new `delivery_payload_view`); `RoleGate` / `ReadOnly` consume them; the Integrations sidebar filters items per the matrix.

Server-side enforcement is independent and authoritative — each route handler checks scope (for SA tokens) and `tenantCtx.role` before mutating or before serialising sensitive fields.

---

## 10. Migration / rollout

Single PR; no flag. Phased internally:

### Phase 0 — Coordination with the Settings IA redesign

The Settings IA redesign (`docs/superpowers/specs/2026-06-12-settings-ia-redesign.md`) refactored `app/src/routes/settings/Warehouse.tsx` to host both the Warehouse card and the Master records card under a single `ConnectionsSection`. That redesign **must land first**. This spec's deletion targets the `<section>` whose direct child renders the literal heading text `"Master records"`, regardless of its line number. If `git status` on `Warehouse.tsx` is dirty at the time this PR opens, rebase onto the merged IA redesign before opening review.

### Phase 1 — Data model (server-only, no UI)

- Drizzle migration adds `service_account`, `webhook`, `outbound_event`, `webhook_delivery`.
- Drizzle migration extends `canonical_version` with `retired_at timestamp NULL` and `retired_into varchar NULL` (§4.1 *Extend to soft-delete*).
- Behavior change in `repo-canonical.mergeCanonical` / `retireCanonical`: replace `DELETE FROM canonical_version` with `UPDATE ... SET retired_at = now(), retired_into = ...`. Audit all read paths that join `canonical_version` and add `WHERE retired_at IS NULL` where required (PR checklist in §4.1).
- Drizzle migration adds `api_tokens.token_prefix varchar(12)` column (nullable for legacy rows; populated for all new tokens). `getApiTokenUser` runs a fast prefix-indexed lookup first, falls back to a capped 200-row scan of NULL-prefix rows ordered by `last_used_at DESC`, and emits a deprecation log on every legacy hit (§5.1).
- Drizzle migration adds partial `canonical_version_pull_idx` on `(tenant_id, dim_id, updated_at, key) WHERE retired_at IS NULL` and `canonical_version_tombstone_idx` on `(tenant_id, dim_id, retired_at) WHERE retired_at IS NOT NULL`.
- **Backfill `canonical_version.updated_at`** for every existing `dim_<slug>` row across every tenant, using the audit_log SQL in §4.5 (`table_id` and `row_key`, NOT `entity_type`/`entity_key`; filter on the four canonical actions). The migration unit test scans `repo-canonical.ts` for `appendAudit*` calls so a new action string forces an update to the filter list.
- `dispatchOutbound(eventType, data)` helper added to `repo.ts`. Commit code path calls it inside the same tx as the canonical write (§3.1).
- `tenant-middleware.ts` extended so a service-account context counts as proof of workspace membership AND synthesises `role='viewer'` (no extra `memberRole` query for SA tokens; §5.1 + §9).
- New `/api/t/:slug/v1/dimensions`, `/dimensions/:slug/schema`, `/dimensions/:slug/canonical`, `/dimensions/:slug/tombstones`, `/events`, `/webhooks*`, `/service-accounts*` endpoints. Mutation handlers gate on `requireScope('webhook:manage')` BEFORE role; v1 SA tokens return `403 scope_insufficient` for mutations.
- The `GET /webhooks/:id/deliveries` and `GET /webhook-deliveries/:id` serialise `payload`, `signature`, `last_response_body` as `null` when the caller's role is `viewer` (§9 payload visibility).
- `webhookDispatcherJob` registered in `scheduler-jobs.ts` (`tickIntervalMs: 2000`). The job's own claim runs a single short-lived tx that returns to the pool before any fetch; attempts run outside any tx with bounded concurrency (§3.3). Reuses the scheduler's in-flight guard, audit emission, and drain-on-stop machinery; does NOT use the per-tenant sequential `for-of` because long fetches would drain `PG_POOL_MAX`. Includes the in-flight reaper at the top of every tick.
- `runWithConcurrency` helper added to `server/src/concurrency.ts` (replaces the draft's `pMap` reference). No new dependency.
- `outboundRetentionSweepJob` registered alongside (runs at most every 6h per tenant; deletes events + deliveries > 30d, clears expired previous webhook secrets including `secret_prefix_previous` — §4.4).
- Token-bucket rate-limit middleware on `/api/t/:slug/v1/...` keyed by credential id (SA OR personal token; §5.1.1).
- HMAC signing of pagination cursors (§4.6).
- URL normalization (`new URL(input).toString()`) + env-aware scheme policy in webhook create/edit (§5.3).
- AES-GCM encryption helpers for webhook secrets, keyed off `ZUGZUG_WEBHOOK_MASTER_KEY`. Hosted SaaS refuses to boot if `WEBHOOKS_ENABLED=1` without the key; self-host auto-generates a key file on first boot with a one-time warning (§4.2).
- A short SQL fragment appended after the generated migration creates `webhook_delivery_webhook_time_idx INCLUDE (status, is_test)` — Drizzle 0.45.2's `index()` doesn't surface INCLUDE; the raw `CREATE INDEX ... INCLUDE (status, is_test)` lives in the same `.sql` file (§4.1).
- 30-day slug-redirect alias: `/api/t/<old-slug>/v1/...` returns `301 Location: /api/t/<new-slug>/v1/...` when an old slug points to a still-active tenant within the 30-day window; logged under the workspace's *Stale slug usage* metric (§8).
- Tests for every route + the dispatcher state machine + the in-flight reaper + the signing flow + the rotation grace window (including replay-after-grace re-sign behaviour) + the canonical-version backfill + the soft-delete read filters + the verification recipe (round-trip the published snippet).

### Phase 2 — UI (client-only)

- `app/src/routes/integrations/` directory with `IntegrationsLayout`, `PullApi.tsx`, `Webhooks.tsx`, `WebhookDetail.tsx`, `ServiceAccounts.tsx`.
- `components/integrations/IntegrationsSidebar.tsx`.
- `AppShell` nav gets the new "Integrations" entry.
- "Master records" card removed from `Warehouse.tsx` (via the heading-text selector — see Phase 0). The informational content moves into the *Pull API* page's "Where canonical lives" introductory card.
- Permission actions added to `permissions.ts`.
- Reuse the existing `ConfirmDialog` primitive for the delete-webhook typed-URL confirm — no bespoke modal (§6.3).

### Phase 3 — Documentation page

- Public docs site (`docs.zugzug.app/api`) gets the Pull API and webhook reference rendered from a generated OpenAPI spec.
- Not blocking — the in-app *Pull API* page is the authoritative reference for v1.

### Backward compatibility

- `GET /api/dimensions/:id/snapshot.parquet` stays. It's not in v1 — it's the legacy single-file path, **kept indefinitely** because the UI uses it. Documented under "Other formats" in the Pull API page.
- Existing personal tokens (`zz_`) continue to work as-is — they authenticate the user; the path's `:slug` chooses the workspace, which matches existing UI traffic shape.
- Events start being emitted **only** for commits after the migration ships. Customers who care about historical events do a full Pull API sync first, then subscribe.

### Defaults for `WEBHOOKS_ENABLED`

The dispatcher only starts when `WEBHOOKS_ENABLED=1`. The default differs by deployment:

| Deployment | Default | Reason |
|---|---|---|
| Hosted SaaS | `1` (on) | Customers expect webhooks as a baseline integration product. |
| Self-host (OSS) | `0` (off) | Operators with auditing / data-egress constraints can ship without the dispatcher running. The Webhooks UI surfaces a friendly inert state ("Webhooks aren't enabled in this deployment — set `WEBHOOKS_ENABLED=1` and restart") rather than 404'ing. |

The default is set in `server/.env.example` with a comment. The hosted SaaS sets the env var in deployment config; OSS users opt in.

When a self-host operator flips `WEBHOOKS_ENABLED=1` without setting `ZUGZUG_WEBHOOK_MASTER_KEY`, the boot routine auto-generates a 32-byte random key, writes it to `<DATA_DIR>/webhook-master.key` mode `0600`, and logs a one-time warning instructing them to back it up (§4.2). A hosted-style deployment (`ZUGZUG_SELF_HOSTED=0`) instead refuses to boot with a clear actionable error.

### Recommended Postgres pool size when webhooks are enabled

`PG_POOL_MAX` defaults to 5 (`pg.ts`). With `WEBHOOKS_ENABLED=1` and 16-way dispatcher concurrency, `server/.env.example` recommends bumping to **8**: enough headroom for the dispatcher to write per-attempt state updates concurrently with normal UI traffic. The boot routine prints a warning when `WEBHOOKS_ENABLED=1` AND `PG_POOL_MAX < 8` so operators see the recommendation before they hit pool-exhaustion symptoms.

### Failure modes during rollout

- If the dispatcher job throws inside a tick, the scheduler's per-job try/catch isolates it; the next tick still fires. A single bad row never kills the dispatcher.
- If the dispatcher crashes mid-attempt, the reaper at the top of the next tick flips orphaned `in_flight` rows back to `retry` (§3.3); deliveries don't go silently missing.
- If a customer's webhook URL is dead during initial deployment, auto-disable kicks in after 50 consecutive failures (excluding test deliveries; §5.3). The dispatcher then skips it on subsequent ticks.
- If the webhook master key is missing on boot with `WEBHOOKS_ENABLED=1` on a hosted-style deployment, the server refuses to start with a clear error — better than starting and writing unreadable secrets. On self-host the routine auto-generates the key and warns instead.

---

## 11. Out of scope (recorded for future)

- **GraphQL endpoint.** REST only in v1.
- **Streaming subscriber API (WebSocket / SSE).** Webhooks + polling cover the use cases.
- **Push-to-warehouse.** That's the canonical-store-modes work tracked elsewhere.
- **Custom event types.** Closed taxonomy in v1.
- **OAuth-style third-party app marketplace** with consent screens.
- **Scoped permissions per service account.** v1 ships `scopes: ["read"]` only; the column is `varchar[]` so adding scopes later is non-breaking.
- **Retention policies as a user-facing setting.** Hardcoded 30 days for events + DLQ; configurable later.
- **SSRF filtering of webhook URLs.** Self-hosted product = operator's responsibility.
- **Schema validation of subscriber response bodies.** We don't care what subscribers respond with as long as it's 2xx.
- **Multi-region delivery.** Single dispatcher.
- **External queue (Redis/BullMQ).** Postgres polling until the workload demands it.

---

## 12. Acceptance criteria

A workspace admin can:

- Open `/app/:slug/integrations`, see three sub-pages (Pull API, Webhooks, Service accounts), and the *Pull API* page is the default.
- Read the *Pull API* page, copy a pre-filled `curl` command with their workspace's slug and a dimension's slug, replace the `YOUR_TOKEN` placeholder, and get a valid JSON response back.
- Generate a service account via the UI, see its value exactly once, copy it, and use it as a `Bearer zzsa_...` against `/api/t/<slug>/v1/dimensions/:slug/canonical` with `?since=` for an incremental sync. A token issued for `acme` returns 403 if used against `/api/t/bigcorp/v1/...`.
- On day 1 of the migration, the same `?since=` query against a populated `dim_<slug>` returns every record (because the migration backfilled `canonical_version`).
- Create a webhook subscribing to `dimension.committed`, see the signing secret once, send a test event from the UI, see the test delivery in the log with a `TEST` badge and status 2xx and the expected payload.
- Commit a dimension change and see a delivery row appear in the webhook's delivery log within 5 seconds, with the right `X-Zugzug-Signature` (including a `kid=current` field) and payload.
- Replay a failed delivery from the log and see the replayed delivery as a new row with `attempts=1` using the same `delivery_url` and `signing_kid` as the original.
- Rotate a webhook secret and see new events signed with the new secret while pending in-flight deliveries continue with the kid they were created with; the previous secret is accepted by subscribers for 24h.
- Pause a webhook (status → paused), see it stop receiving deliveries, then reactivate (status → active) — distinct from the auto-disabled state.
- Edit a webhook's URL and see in-flight deliveries continue to POST to the snapshotted URL, while new events go to the new URL.

A workspace editor can:

- View the Pull API page, the webhook list, individual webhook delivery logs (but **not** create/edit/delete webhooks; UI shows disabled buttons with tooltip).
- View the service account list (read-only).

A workspace viewer can:

- View the Pull API page.
- See the Webhooks list (read-only) and the delivery log header rows (status, event type, timestamps, attempt count) **without payloads or signatures or response bodies** — both the API serialiser and the UI expand-row are gated; the API returns `payload: null` for viewer-role calls.
- **Not** see the Service accounts sub-page (sidebar hides it; direct URL redirects to Pull API).

A non-member of the workspace:

- Cannot hit `/api/t/<slug>/v1/...` endpoints. 403 with `workspace_not_authorized`.

A polling client hitting `/canonical` at 20 req/s:

- Gets `429 Too Many Requests` with `Retry-After: 60` once the per-credential bucket is exhausted (default 600 req/min, configurable via `ZUGZUG_PULL_API_RPM`). The bucket key is the SA id or `zz_` token id, whichever authenticated — there is no "unlimited" credential on `/v1/`.

A polling client passing a tampered cursor:

- Gets `400 cursor_invalid` if the cursor signature doesn't verify — never silently fast-forwards through the dataset.

A subscriber implementing the canonical verification recipe:

- Rejects deliveries whose `|now - t|` exceeds 300 seconds in either direction (replay or future-clock).
- Rejects malformed `v1=` headers (length-checked, regex-bounded hex) without throwing.

The system:

- Auto-disables a webhook after 50 consecutive DLQ'd **non-test** deliveries (precise definition in §5.3) and surfaces the banner.
- Retries failed deliveries on the documented schedule (0s, 5s, 30s, 5m, 1h) and DLQs after attempt 5.
- Reaps orphaned `in_flight` rows older than 30s back to `retry` on every tick, so a crash mid-attempt does not silently lose deliveries.
- Includes a stable `X-Zugzug-Event-Id` across all retries of the same event.
- Signs every webhook body with `X-Zugzug-Signature: t=<unix>,kid=<current|previous>,v1=sha256=<hex>` where hex = HMAC-SHA256 over `<unix>.<body>`.
- Truncates `webhook_delivery.last_response_body` at 2 KB.
- Sweeps `outbound_event` and `webhook_delivery` rows >30 days old via the existing scheduler, at most once per 6h per tenant, and zeroes out expired previous-secret blobs at the same time.
- Connects + responds within 10 seconds per delivery attempt (enforced by AbortController), fans out up to 16 concurrent deliveries globally per tick (per-tenant cap 32 via round-robin slicing), and never holds a Postgres connection open across a `fetch()`.
- Replaces, on the renamed slug's behalf, requests to `/api/t/<old-slug>/v1/...` with `301 Location: /api/t/<new-slug>/v1/...` for 30 days post-rename, then 404s.
- Cleans up all integration rows when a tenant is torn down.

The Warehouse page no longer shows the "Master records" card.
