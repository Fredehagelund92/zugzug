# Outbound Integrations — PR3: Webhooks (Dispatcher + Routes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end webhook delivery — `commit()` writes an `outbound_event` row inside its existing transaction; an in-process dispatcher (scheduler-hosted, global claim with SKIP LOCKED) signs and delivers via HTTP with a 10-second deadline; failed deliveries retry on a fixed ladder (0s/5s/30s/5m/1h) and dead-letter after attempt 5; an admin UI (PR4) consumes the resulting CRUD + delivery-log routes added to `/api/t/:slug/v1/`.

**Architecture:** PR1 shipped the tables (`outbound_event`, `webhook`, `webhook_delivery`); PR3 wires the writers + the dispatcher. Two new event types fire: `dimension.committed` (from inside `commit()`'s `pgTx`) and `canonical.deleted` (from inside `retireCanonical`'s `pgTx`). Each event-write also enqueues one `webhook_delivery` row per subscribed webhook — also inside the same tx, so the entire chain is atomic per the design doc's "one source of truth" guarantee. The dispatcher runs as a **global** scheduler job (a one-line extension to the existing `SchedulerJob` interface) so it can claim rows across all tenants in one SKIP LOCKED query. Attempts happen outside any transaction; each attempt does a short autocommit-style state update afterward, so no Postgres connection is held during fetch. Webhook secrets are AES-256-GCM encrypted (PR1's `crypto-secret.ts`); the 24-hour rotation-grace window keeps a `previous` secret valid alongside the new `current` one — signatures emit `kid=current` for new events, but DLQ replays after expiry re-sign with current and surface a banner in the UI.

**Tech Stack:** Bun HTTP server, raw SQL via `pgRun`/`pgGet`/`pgAll`/`pgTx`, scheduler ticks (2-second interval for the dispatcher), `AbortSignal.timeout(10000)` for delivery deadlines (the codebase already uses this pattern in `repo-ai-hint.ts`), HMAC-SHA256 via `node:crypto` for payload signing, PR1's `runWithConcurrency` for the 16-way fan-out, PR1's `encryptSecret`/`decryptSecret` for at-rest secret storage.

**What this PR does NOT include:**
- Integrations UI (Webhooks page, Send-test button, delivery-log expand-row, secret-reveal modal, rotation banner) — **PR4**.
- The `webhook.test` route — actually IS in this PR (the design ships it server-side; the UI button lands in PR4).
- The webhook signing recipe page — that page is part of PR4.
- The 30-day retention sweep for `tenant_slug_alias` rows (PR2 ships the table; PR3 sweeps `outbound_event`, `webhook_delivery`, and expired previous secrets — alias cleanup can ride along OR move to a separate one-shot).

---

## Baseline test-failure list

Before starting, capture the current failing-test baseline:

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr3_baseline.txt
wc -l /tmp/zugzug_pr3_baseline.txt
```

Expected: ~99 (matches post-PR2 baseline after the `resetDb` fix).

Every subsequent task's regression-check uses this file. **The regression standard is `diff` empty OR only lines starting with `<` (failures that now pass) — never lines starting with `>` (new failures).**

---

## File Map

**Server — modified**
- `server/src/scheduler.ts` — add `scope?: "per-tenant" | "global"` to `SchedulerJob`; modify `_tick()` to run global jobs once before iterating tenants. Surgical, ~25 lines.
- `server/src/scheduler-jobs.ts` — register `webhookDispatcherJob`, `webhookReaperJob`, `outboundRetentionSweepJob` alongside the existing 3.
- `server/src/server.ts` — pass the new global jobs into `createScheduler({ jobs: [...] })` startup.
- `server/src/repo-drafts.ts` — at line ~309 (end of `commit()`'s `pgTx` callback), call `dispatchOutbound(tx, ...)` and enqueue webhook deliveries for matching subscriptions.
- `server/src/repo-canonical.ts` — at line ~1030 (inside `retireCanonical`'s `pgTx`, right before the audit hook), call `dispatchOutbound(tx, ...)` and enqueue deliveries.
- `server/src/v1-routes.ts` — add the 8 webhook routes (the existing service-accounts dispatch is the model).
- `server/src/env.ts` — wire `webhooksEnabled` (PR1 added it; PR3 actually consults it). Wire `webhookMasterKeyB64` (PR1 added it; PR3 calls `resolveMasterKey()` at scheduler start).

**Server — new**
- `server/src/repo-outbound-events.ts` — `dispatchOutbound(tx, { tenantId, type, dimId?, occurredAt, payload, idemKey })` — INSERT into `outbound_event` and enqueue `webhook_delivery` rows for matching webhooks. Pure DB work; called within an existing tx.
- `server/src/webhook-signing.ts` — `signPayload(rawBody, secretPlaintext, kid, nowSeconds)` returns the `t=…,kid=…,v1=sha256=<hex>` header value.
- `server/src/webhook-secrets.ts` — encrypt at create/rotate, decrypt at sign time; loads the master key from `env.webhookMasterKeyB64` (via PR1's `resolveMasterKey`). The dispatcher caches the master key in memory.
- `server/src/repo-webhooks.ts` — CRUD repo: `createWebhook`, `listWebhooks`, `getWebhook`, `patchWebhook`, `deleteWebhook`, `rotateSecret`, `reactivateWebhook`, `pauseWebhook`. Encryption + audit hooks inside.
- `server/src/repo-webhook-deliveries.ts` — `listDeliveries(tenantId, webhookId, opts)`, `getDelivery(tenantId, deliveryId)`, `replayDelivery(tenantId, deliveryId, userId)`.
- `server/src/webhook-dispatcher.ts` — the dispatcher job. Claim + attempt + state update. ~150 LOC.
- `server/src/webhook-reaper.ts` — single function that flips orphaned `in_flight` rows ≥30s old back to `retry`. Called at top of every dispatcher tick.
- `server/src/outbound-retention-sweep.ts` — the retention sweep job. Deletes events + deliveries >30d old; clears expired `secret_*_previous` columns. Per-tenant frequency cap via `last_swept_at` stored in `preferences` (already exists).

**Server — new tests**
- `server/src/repo-outbound-events.test.ts` — dispatchOutbound writes correct event row + enqueues deliveries for matching webhooks only.
- `server/src/webhook-signing.test.ts` — signature format + HMAC correctness + round-trip with PR1's `cursor.ts`-style verify recipe.
- `server/src/repo-webhooks.test.ts` — CRUD + rotation grace semantics.
- `server/src/webhook-dispatcher.test.ts` — claim semantics, retry schedule, auto-disable, AbortSignal timeout (uses a stub HTTP server in `bun:test`).
- `server/src/webhook-reaper.test.ts` — orphaned `in_flight` rows flip back; non-orphaned rows untouched.
- `server/src/outbound-retention-sweep.test.ts` — sweeps respect age thresholds.
- `server/src/v1-routes.test.ts` — extend with webhook-route tests (CRUD + test-event + replay + reactivate + rotate).

---

## Task 1: `repo-outbound-events.ts` — `dispatchOutbound` helper

**Files:**
- Create: `server/src/repo-outbound-events.ts`
- Test: `server/src/repo-outbound-events.test.ts`

`dispatchOutbound` is the single place that writes `outbound_event` rows and fans out `webhook_delivery` rows. It is called from inside an existing `pgTx` callback — so the event-write IS atomic with the canonical write that triggered it (design §3.1's "one source of truth").

### Step 1: Write the failing test FIRST

Create `server/src/repo-outbound-events.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll, pgTx } from "./pg.ts";
import { dispatchOutbound } from "./repo-outbound-events.ts";
import { encryptSecret, generateMasterKeyB64 } from "./crypto-secret.ts";

const T = "test_dispatch_outbound";
const U = "u_test_dispatch";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'Dispatch Test', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Dispatch Tester', 'd@example.test', 'DT', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."webhook_delivery" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."webhook" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

// Helpers to seed a webhook directly (PR3 Task 7 ships the public repo).
async function seedWebhook(tenantId: string, events: string[], status = "active") {
  const id = `wh_test_${crypto.randomUUID().replace(/-/g, "")}`;
  // Encrypt a stub secret with a stub master key.
  const masterKey = Buffer.from(generateMasterKeyB64(), "base64");
  const { ciphertext, nonce } = encryptSecret("whsec_stub", masterKey, 1);
  await pgRun(
    `INSERT INTO "zugzug_app"."webhook"
       (id, tenant_id, url, secret_ciphertext, secret_nonce, secret_key_version,
        secret_prefix, events, status, created_at, created_by)
     VALUES ($1, $2, $3, $4::bytea, $5::bytea, 1, 'whsec_stub00',
             $6::varchar[], $7, now(), $8)`,
    [id, tenantId, "https://example.test/wh", ciphertext, nonce, events, status, U],
  );
  return id;
}

describe("dispatchOutbound — writes outbound_event row", () => {
  it("inserts a row in the same tx with the right shape", async () => {
    const idemKey = `dimension.committed:dim_t1:1`;
    await pgTx(async (tx) => {
      await dispatchOutbound(tx, {
        tenantId: T,
        type: "dimension.committed",
        dimId: "dim_t1",
        occurredAt: new Date(),
        payload: { dim_slug: "country", version: 1 },
        idemKey,
      });
    });

    const row = await pgGet<{ type: string; dim_id: string | null; payload: Record<string, unknown> }>(
      `SELECT type, dim_id, payload FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND idem_key = $2`,
      [T, idemKey],
    );
    expect(row).not.toBeNull();
    expect(row!.type).toBe("dimension.committed");
    expect(row!.dim_id).toBe("dim_t1");
    expect((row!.payload as { dim_slug: string }).dim_slug).toBe("country");
  });

  it("idem_key collision aborts the surrounding tx (per design §3.1)", async () => {
    const idemKey = `dimension.committed:dim_t2:1`;
    await pgTx(async (tx) => {
      await dispatchOutbound(tx, {
        tenantId: T, type: "dimension.committed", dimId: "dim_t2",
        occurredAt: new Date(), payload: {}, idemKey,
      });
    });

    let threw = false;
    try {
      await pgTx(async (tx) => {
        await dispatchOutbound(tx, {
          tenantId: T, type: "dimension.committed", dimId: "dim_t2",
          occurredAt: new Date(), payload: {}, idemKey, // same key
        });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("dispatchOutbound — enqueues webhook_delivery rows", () => {
  it("enqueues one delivery per matching subscribed webhook", async () => {
    const wh1 = await seedWebhook(T, ["dimension.committed"]);
    const wh2 = await seedWebhook(T, ["dimension.committed", "canonical.deleted"]);
    const wh3 = await seedWebhook(T, ["canonical.deleted"]); // does NOT subscribe

    await pgTx(async (tx) => {
      await dispatchOutbound(tx, {
        tenantId: T, type: "dimension.committed", dimId: "dim_t3",
        occurredAt: new Date(), payload: { dim_slug: "country" },
        idemKey: `dimension.committed:dim_t3:5`,
      });
    });

    const rows = await pgAll<{ webhook_id: string; status: string }>(
      `SELECT webhook_id, status FROM "zugzug_app"."webhook_delivery"
        WHERE tenant_id = $1 AND event_type = 'dimension.committed'`,
      [T],
    );
    const ids = rows.map((r) => r.webhook_id).sort();
    expect(ids).toContain(wh1);
    expect(ids).toContain(wh2);
    expect(ids).not.toContain(wh3);
    for (const r of rows) expect(r.status).toBe("pending");
  });

  it("does NOT enqueue for paused or disabled webhooks", async () => {
    const wh_paused = await seedWebhook(T, ["dimension.committed"], "paused");
    const wh_disabled = await seedWebhook(T, ["dimension.committed"], "disabled");

    await pgTx(async (tx) => {
      await dispatchOutbound(tx, {
        tenantId: T, type: "dimension.committed", dimId: "dim_t4",
        occurredAt: new Date(), payload: {},
        idemKey: `dimension.committed:dim_t4:1`,
      });
    });

    const left = await pgAll<{ webhook_id: string }>(
      `SELECT webhook_id FROM "zugzug_app"."webhook_delivery"
        WHERE tenant_id = $1 AND webhook_id IN ($2, $3)`,
      [T, wh_paused, wh_disabled],
    );
    expect(left.length).toBe(0);
  });
});
```

Run: `cd server && bun test src/repo-outbound-events.test.ts` — expect FAIL (module missing).

### Step 2: Write the implementation

Create `server/src/repo-outbound-events.ts`:

```ts
/* repo-outbound-events.ts — dispatchOutbound writes an outbound_event row AND
   enqueues a webhook_delivery row for every active webhook that subscribes to
   the event's type. Called from inside an existing pgTx so the event-write is
   atomic with the canonical mutation that produced it (design §3.1). */

import type { TxHelpers } from "./pg.ts";
import { pg } from "./env.ts";

export interface DispatchInput {
  tenantId: string;
  type: "dimension.committed" | "dimension.created" | "dimension.schema.updated" | "canonical.deleted";
  dimId?: string | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
  /** Deterministic per logical event; idem_key collisions abort the surrounding tx. */
  idemKey: string;
}

function genEventId(): string {
  // ULID-ish — random hex, sortable enough by occurred_at since we always include it in indexes.
  return `evt_${crypto.randomUUID().replace(/-/g, "")}`;
}

function genDeliveryId(): string {
  return `whd_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function dispatchOutbound(tx: TxHelpers, input: DispatchInput): Promise<string> {
  const eventId = genEventId();
  await tx.run(
    `INSERT INTO ${pg("outbound_event")}
       (id, tenant_id, type, dim_id, occurred_at, payload, idem_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [eventId, input.tenantId, input.type, input.dimId ?? null, input.occurredAt, JSON.stringify(input.payload), input.idemKey],
  );

  // Enqueue one delivery per matching subscribed webhook (active only).
  // The signature is computed at attempt time by the dispatcher — we store
  // an empty string here and the dispatcher overwrites on first attempt.
  // delivery_url is snapshotted from the webhook's current URL.
  const subs = await tx.all<{ id: string; url: string }>(
    `SELECT id, url FROM ${pg("webhook")}
      WHERE tenant_id = $1
        AND status = 'active'
        AND $2 = ANY(events)`,
    [input.tenantId, input.type],
  );
  for (const sub of subs) {
    await tx.run(
      `INSERT INTO ${pg("webhook_delivery")}
         (id, tenant_id, webhook_id, event_id, event_type, delivery_url,
          signing_kid, is_test, status, attempts, max_attempts,
          next_attempt_at, payload, signature, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'current', false, 'pending', 0, 5,
                 now(), $7::jsonb, '', now())`,
      [genDeliveryId(), input.tenantId, sub.id, eventId, input.type, sub.url, JSON.stringify(input.payload)],
    );
  }
  return eventId;
}
```

### Step 3: Run, confirm PASS

```bash
cd server && bun test src/repo-outbound-events.test.ts
```
Expected: 4/4 pass.

### Step 4: Regression + typecheck + commit

```bash
cd server && bun run typecheck
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr3_after_task1.txt
diff /tmp/zugzug_pr3_baseline.txt /tmp/zugzug_pr3_after_task1.txt
```
Expected: empty diff OR only `<` lines.

```bash
git add server/src/repo-outbound-events.ts server/src/repo-outbound-events.test.ts
git commit -m "$(cat <<'EOF'
feat(server): dispatchOutbound writes outbound_event + enqueues deliveries

dispatchOutbound(tx, ...) is the single place that fires outbound events:
it INSERTs into outbound_event and fans out one webhook_delivery row per
active webhook subscribing to the event type. Called from inside an
existing pgTx so the event-write is atomic with the canonical mutation
that produced it (per design §3.1's "one source of truth" guarantee).

Paused and disabled webhooks do NOT receive deliveries — the dispatcher
will catch them up when reactivated, but only for events within the
30-day retention window.

The signature column starts empty; the dispatcher computes it at attempt
time with the webhook's current secret. delivery_url is snapshotted at
enqueue time so a URL edit on the parent webhook does NOT redirect
in-flight deliveries (anti-exfiltration, design §4.4).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Hook `dispatchOutbound` into `commit()`

**Files:**
- Modify: `server/src/repo-drafts.ts:215-374` (extend `commit()`).
- Test: `server/src/repo-drafts.test.ts` (NEW or extend if exists).

When `commit()` folds drafts into canonical, fire a `dimension.committed` event. The event payload includes `dim_slug`, `dim_label`, the new `version`, `committed_by`, and a summarized `changes` shape (per design §3.2 and §5.5).

### Step 1: Write the failing test FIRST

Create or extend `server/src/repo-drafts.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "./pg.ts";
import { addDimension, addCanonicalOne } from "./repo-canonical.ts";
import { saveDraft, commit } from "./repo-drafts.ts";

const T = "test_commit_outbound";
const U = "u_test_commit";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'Commit Test', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Commit Tester', 'c@example.test', 'CT', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("commit() fires dimension.committed event", () => {
  it("writes an outbound_event row with the right shape", async () => {
    const dimId = await addDimension("CommitDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Alpha", undefined, U, T);
    await saveDraft(dimId, "alpha variant", "mapped", "Alpha", "alpha", U, T);
    const result = await commit(dimId, U, T);
    expect(result.committed).toBeGreaterThan(0);

    const evt = await pgGet<{ type: string; payload: { dim_slug?: string; committed_by?: { id: string } } }>(
      `SELECT type, payload FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2 AND type = 'dimension.committed'
        ORDER BY occurred_at DESC LIMIT 1`,
      [T, dimId],
    );
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe("dimension.committed");
    expect(evt!.payload.dim_slug).toBe(dimId);
    expect(evt!.payload.committed_by?.id).toBe(U);
  });

  it("does NOT fire when commit() short-circuits (no approved drafts)", async () => {
    const dimId = await addDimension("EmptyCommit", [], { keyKind: "slug" }, U, T);
    const before = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2`,
      [T, dimId],
    );
    await commit(dimId, U, T); // no drafts → committed=0
    const after = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2`,
      [T, dimId],
    );
    expect(after!.n).toBe(before!.n);
  });
});
```

Run: `cd server && bun test src/repo-drafts.test.ts` — expect FAIL (event not yet written).

### Step 2: Modify `commit()` in `server/src/repo-drafts.ts`

Open `server/src/repo-drafts.ts`. Find the `commit()` function (line 215) and its `pgTx` block (around line 265-309). At the END of the `pgTx` callback (BEFORE the closing `})`, AFTER the DELETE that wraps up drafts), add the event-write:

Imports at the top of the file:
```ts
import { dispatchOutbound } from "./repo-outbound-events.ts";
import { pgGet as pgGetOuter } from "./pg.ts"; // for the user-name lookup below
```

Inside the `pgTx` callback, after the existing DELETE, add:

```ts
    // Outbound event for downstream subscribers (PR3).
    const newVersion = await tx.get<{ version: number }>(
      `SELECT coalesce(max(version), 0) + 1 AS version
         FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2 AND type = 'dimension.committed'`,
      [tenantId, dimId],
    );
    const v = newVersion?.version ?? 1;
    const committedBy = await tx.get<{ name: string }>(
      `SELECT name FROM "zugzug_app"."users" WHERE id = $1`,
      [userId],
    );
    const addedKeys = approvedDrafts.map((d) => ({ key: d.key, label: d.label ?? d.key }));
    await dispatchOutbound(tx, {
      tenantId,
      type: "dimension.committed",
      dimId,
      occurredAt: new Date(),
      payload: {
        dim_slug: dimId,
        dim_label: meta.label,
        version: v,
        previous_version: v - 1,
        committed_by: { id: userId, name: committedBy?.name ?? userId },
        changes: {
          added: addedKeys.slice(0, 200),
          updated: [],
          merged: [],
          retired: [],
        },
        summary: { added: addedKeys.length, updated: 0, merged: 0, retired: 0 },
        ...(addedKeys.length > 200 ? { changes_truncated: true } : {}),
      },
      idemKey: `dimension.committed:${dimId}:${v}`,
    });
```

**Important:** the `version` computation uses an `outbound_event`-scoped MAX. This is independent of `canonical_version.version` (which is per-canonical-row). The "dimension version" is a monotonic counter PER `dimension.committed` event PER dim — exactly the shape design §3.2 needs subscribers to dedupe on.

Note: the existing code uses `pgGet` from the outer scope — verify the `tx.get` call shape matches the `TxHelpers` interface in `pg.ts` (the survey report shows `get<T = Record<string, unknown>>(q: string, p?: unknown[]): Promise<T | null>`). Adjust if the actual file uses a slightly different `tx` API.

If `meta.label` isn't in scope at this point (it should be — `commit()` reads it from the dimension registry near the top), `grep -n "meta\.label\|meta:" server/src/repo-drafts.ts` to confirm.

### Step 3: Run, confirm PASS

```bash
cd server && bun test src/repo-drafts.test.ts
```
Expected: 2/2 pass.

### Step 4: Regression + typecheck + commit

```bash
cd server && bun run typecheck
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr3_after_task2.txt
diff /tmp/zugzug_pr3_baseline.txt /tmp/zugzug_pr3_after_task2.txt
```
Expected: empty diff OR only `<` lines.

```bash
git add server/src/repo-drafts.ts server/src/repo-drafts.test.ts
git commit -m "$(cat <<'EOF'
feat(commit): fire dimension.committed outbound event inside pgTx

When commit() folds approved drafts into canonical it now writes an
outbound_event row inside the SAME pgTx as the canonical write — so
the event INSERT failing aborts the commit (design §3.1 guarantee).
Payload carries dim_slug, dim_label, version (per-event-type monotonic
counter), committed_by, and a changes shape with the added keys
truncated at 200 entries (changes_truncated:true beyond that).

The version field is independent of canonical_version.version — it's
the "dim's event version" that subscribers dedupe on.

merged and retired arrays are empty here; those events come from
retireCanonical and mergeCanonical (Task 3 + future PR).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Hook `dispatchOutbound` into `retireCanonical`

**Files:**
- Modify: `server/src/repo-canonical.ts:987-1038` (extend `retireCanonical`).
- Test: extend `server/src/outbound-schema.test.ts` (PR1 created this).

`canonical.deleted` fires when `retireCanonical` succeeds. Payload includes `dim_slug`, `key`, `label`, `deleted_by`.

### Step 1: Test FIRST

Append to `server/src/outbound-schema.test.ts`:

```ts
describe("retireCanonical fires canonical.deleted outbound event", () => {
  it("writes a canonical.deleted event with the right shape", async () => {
    const dimId = await addDimension("RetireOut", [], { keyKind: "slug" }, "u_test", T);
    await addCanonicalOne(dimId, "Beta", undefined, "u_test", T);
    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND key = 'beta' AND tenant_id = $2`,
      [dimId, T],
    );
    const result = await retireCanonical(dimId, "beta", "u_test", v!.version, T);
    expect(result.ok).toBe(true);

    const evt = await pgGet<{ type: string; payload: { key?: string; dim_slug?: string } }>(
      `SELECT type, payload FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2 AND type = 'canonical.deleted'
        ORDER BY occurred_at DESC LIMIT 1`,
      [T, dimId],
    );
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe("canonical.deleted");
    expect(evt!.payload.key).toBe("beta");
    expect(evt!.payload.dim_slug).toBe(dimId);
  });

  it("does NOT fire when retireCanonical refuses (variants still exist)", async () => {
    const dimId = await addDimension("RetireRefuse", [], { keyKind: "slug" }, "u_test", T);
    await addCanonicalOne(dimId, "Gamma", undefined, "u_test", T);
    // No mapped variants would make retire succeed, but for this assertion
    // we expect the event count to stay zero if retire returns ok=false.
    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND key = 'gamma' AND tenant_id = $2`,
      [dimId, T],
    );
    // Seed a map_<dim> row to make the retire refuse.
    const m = await pgGet<{ map_table: string; key_col: string }>(
      `SELECT map_table, key_col FROM "zugzug_app"."dimension" WHERE id = $1`,
      [dimId],
    );
    await pgRun(
      `INSERT INTO "zugzug"."${m!.map_table}" (raw, ${m!.key_col}, tenant_id) VALUES ('gamma variant', 'gamma', $1)`,
      [T],
    );

    const result = await retireCanonical(dimId, "gamma", "u_test", v!.version, T);
    expect(result.ok).toBe(false);

    const n = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2 AND type = 'canonical.deleted'`,
      [T, dimId],
    );
    expect(n!.n).toBe(0);
  });
});
```

Run: `cd server && bun test src/outbound-schema.test.ts` — expect FAIL.

### Step 2: Modify `retireCanonical` in `server/src/repo-canonical.ts`

Open `server/src/repo-canonical.ts`. Find `retireCanonical` (around line 987). It currently has structure:

```ts
const result = await pgTx<{ ok: boolean; variants: number }>(async (tx) => {
  // ... check variants
  if (variants > 0) return { ok: false, variants };
  await bumpVersionOrThrow(tx, dimId, key, expectedVersion, userId, tenantId);
  await tx.run(`DELETE FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`, [key]);
  await softRetireVersionRow(tx, dimId, key, tenantId);
  return { ok: true, variants: 0 };
});

if (result.ok) {
  await appendAuditAs(userId, "Retired canonical", key, { tableId: dimId, rowKey: key, tenantId });
}
return result;
```

We need to move the audit + event firing INSIDE the `pgTx` so the canonical write + audit + event are atomic. Update to:

```ts
import { dispatchOutbound } from "./repo-outbound-events.ts";

// ... inside retireCanonical:
let firedAt: Date | null = null;
const result = await pgTx<{ ok: boolean; variants: number }>(async (tx) => {
  const v = await tx.get<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1`,
    [key],
  );
  const variants = Number(v?.n ?? 0);
  if (variants > 0) return { ok: false, variants };

  await bumpVersionOrThrow(tx, dimId, key, expectedVersion, userId, tenantId);

  // Read the label BEFORE deleting the dim row.
  const labelRow = await tx.get<{ label: string }>(
    `SELECT label FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1 AND tenant_id = $2`,
    [key, tenantId],
  );

  await tx.run(`DELETE FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`, [key]);
  await softRetireVersionRow(tx, dimId, key, tenantId);

  firedAt = new Date();
  await dispatchOutbound(tx, {
    tenantId,
    type: "canonical.deleted",
    dimId,
    occurredAt: firedAt,
    payload: {
      dim_slug: dimId,
      key,
      label: labelRow?.label ?? key,
      deleted_by: { id: userId },
    },
    idemKey: `canonical.deleted:${dimId}:${key}:${firedAt.getTime()}`,
  });

  return { ok: true, variants: 0 };
});

if (result.ok) {
  await appendAuditAs(userId, "Retired canonical", key, { tableId: dimId, rowKey: key, tenantId });
}
return result;
```

### Step 3: Run, confirm PASS, regression, commit

```bash
cd server && bun test src/outbound-schema.test.ts
cd server && bun run typecheck
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr3_after_task3.txt
diff /tmp/zugzug_pr3_baseline.txt /tmp/zugzug_pr3_after_task3.txt
```

```bash
git add server/src/repo-canonical.ts server/src/outbound-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(retire): fire canonical.deleted outbound event inside pgTx

retireCanonical now writes a canonical.deleted outbound_event row inside
its existing pgTx — atomic with the dim_<slug> DELETE + canonical_version
soft-delete. Payload carries dim_slug, key, label, deleted_by.

The label is read BEFORE the DELETE so the event payload preserves it.
The audit hook stays where it is (outside the tx, fire-and-forget).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extend `SchedulerJob` to support global scope

**Files:**
- Modify: `server/src/scheduler.ts` (the `SchedulerJob` interface + `_tick()` loop).

The existing scheduler iterates tenants per tick — that's wrong for the webhook dispatcher which does a **single global** SKIP LOCKED claim across `webhook_delivery` rows from ALL tenants. We extend `SchedulerJob` with an optional `scope: "global" | "per-tenant"` field (default `"per-tenant"`) and modify `_tick()` to run all global jobs once before iterating tenants.

### Step 1: Test FIRST

Create `server/src/scheduler-global-jobs.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createScheduler, type SchedulerJob, type JobContext } from "./scheduler.ts";
import type { TenantRepo } from "./tenant-repo.ts";

describe("createScheduler — global vs per-tenant jobs", () => {
  it("runs global jobs once per tick regardless of tenant count", async () => {
    let perTenantCalls = 0;
    let globalCalls = 0;

    const perTenant: SchedulerJob = {
      name: "per-tenant",
      async run(_ctx: JobContext) { perTenantCalls++; return {}; },
    };
    const global: SchedulerJob = {
      name: "global",
      scope: "global",
      async run(_ctx: JobContext) { globalCalls++; return {}; },
    };

    const sch = createScheduler({
      jobs: [perTenant, global],
      tickIntervalMs: 1_000_000, // we drive ticks manually
      tenantsForTick: async () => ["t1", "t2", "t3"],
      makeRepo: async () => ({} as TenantRepo),
    });
    await sch._tick();
    expect(perTenantCalls).toBe(3); // once per tenant
    expect(globalCalls).toBe(1);    // once total
  });

  it("global jobs receive a special context (tenantId='*')", async () => {
    let receivedTenant: string | undefined;
    const job: SchedulerJob = {
      name: "g",
      scope: "global",
      async run(ctx: JobContext) { receivedTenant = ctx.tenantId; return {}; },
    };
    const sch = createScheduler({
      jobs: [job],
      tickIntervalMs: 1_000_000,
      tenantsForTick: async () => ["any"],
      makeRepo: async () => ({} as TenantRepo),
    });
    await sch._tick();
    expect(receivedTenant).toBe("*");
  });
});
```

Run: `cd server && bun test src/scheduler-global-jobs.test.ts` — expect FAIL.

### Step 2: Extend `SchedulerJob` and `_tick()`

Open `server/src/scheduler.ts`. Find the `SchedulerJob` interface (lines 20-25) and update:

```ts
export interface SchedulerJob {
  /** Stable name for logging; e.g., "scan-sources" / "webhook-dispatcher". */
  name: string;
  /** "global" jobs run once per tick across all tenants — they do their own
   *  cross-tenant claims. Default "per-tenant": iterated once per active tenant. */
  scope?: "per-tenant" | "global";
  /** Returns rowsScanned-ish metadata (or empty object). Throws on hard failure. */
  run(ctx: JobContext): Promise<JobResult>;
}
```

Find `_tick()` (around line 157). The existing structure (rough — verify in file):

```ts
async function _tick(): Promise<void> {
  const tenants = await tenantsForTick();
  for (const tenantId of tenants) {
    if (!shouldRun(tenantId)) continue;
    await pgTxScoped(tenantId, async () => {
      const repo = await makeRepo(tenantId);
      for (const job of jobs) {
        const ctx: JobContext = { signal, tenantId, repo };
        await recordScanRun(job.name, tenantId, () => job.run(ctx));
      }
    });
  }
}
```

Modify to run global jobs FIRST (once), then per-tenant jobs:

```ts
async function _tick(): Promise<void> {
  // Phase 1: global jobs run once per tick across all tenants.
  for (const job of jobs) {
    if (job.scope !== "global") continue;
    const ctx: JobContext = { signal: abortController.signal, tenantId: "*", repo: {} as TenantRepo };
    await recordScanRun(job.name, "*", () => job.run(ctx));
  }

  // Phase 2: per-tenant jobs iterate active tenants.
  const tenants = await tenantsForTick();
  for (const tenantId of tenants) {
    if (!shouldRun(tenantId)) continue;
    await pgTxScoped(tenantId, async () => {
      const repo = await makeRepo(tenantId);
      for (const job of jobs) {
        if (job.scope === "global") continue;
        const ctx: JobContext = { signal: abortController.signal, tenantId, repo };
        await recordScanRun(job.name, tenantId, () => job.run(ctx));
      }
    });
  }
}
```

The global job's `JobContext.repo` is a dummy — global jobs do their own queries via `pgRun`/`pgAll`/`pgTx`. The `tenantId: "*"` is a sentinel that lets the scheduler's `recordScanRun` distinguish global from per-tenant rows.

### Step 3: Run, regression, commit

```bash
cd server && bun test src/scheduler-global-jobs.test.ts
cd server && bun run typecheck
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr3_after_task4.txt
diff /tmp/zugzug_pr3_baseline.txt /tmp/zugzug_pr3_after_task4.txt
```

```bash
git add server/src/scheduler.ts server/src/scheduler-global-jobs.test.ts
git commit -m "$(cat <<'EOF'
feat(scheduler): SchedulerJob.scope='global' for cross-tenant jobs

Global jobs run ONCE per tick instead of being iterated per-tenant —
enables PR3's webhook dispatcher to claim webhook_delivery rows across
all tenants in a single SKIP LOCKED query (fair share via round-robin
in the dispatcher itself, not the scheduler).

Per-tenant jobs unchanged: same iteration, same context shape.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `webhook-signing.ts` — HMAC payload signing

**Files:**
- Create: `server/src/webhook-signing.ts`
- Test: `server/src/webhook-signing.test.ts`

The signature format per design §5.5:
```
t=<unix>,kid=<current|previous>,v1=sha256=<hex>
```
where hex = `HMAC_SHA256(secret, "<unix>.<rawBody>")`.

### Step 1: Test FIRST

Create `server/src/webhook-signing.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { signPayload, parseSignatureHeader } from "./webhook-signing.ts";

const SECRET = "whsec_b8K3kP9mQ2vN7L4xR8jH3sT5uW8yA1zE6cD9fG2J";

describe("signPayload", () => {
  it("emits t=…,kid=…,v1=sha256=<hex> format", () => {
    const header = signPayload("{}", SECRET, "current", 1700000000);
    expect(header).toMatch(/^t=1700000000,kid=current,v1=sha256=[0-9a-f]{64}$/);
  });

  it("HMAC matches independent computation", () => {
    const header = signPayload("hello world", SECRET, "current", 1700000000);
    const parts = parseSignatureHeader(header);
    expect(parts).not.toBeNull();
    const expected = createHmac("sha256", SECRET)
      .update("1700000000.hello world")
      .digest("hex");
    expect(parts!.v1.toLowerCase()).toBe(expected);
  });

  it("different timestamps produce different signatures (replay-resistant)", () => {
    const a = signPayload("body", SECRET, "current", 1700000000);
    const b = signPayload("body", SECRET, "current", 1700000001);
    expect(a).not.toBe(b);
  });

  it("kid=previous embeds correctly", () => {
    const header = signPayload("body", SECRET, "previous", 1700000000);
    expect(header).toContain("kid=previous");
  });
});

describe("parseSignatureHeader", () => {
  it("parses valid header", () => {
    const header = "t=1700000000,kid=current,v1=sha256=abc";
    const parts = parseSignatureHeader(header);
    expect(parts).toEqual({ t: 1700000000, kid: "current", v1: "abc" });
  });
  it("rejects malformed header", () => {
    expect(parseSignatureHeader("garbage")).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("t=,kid=current,v1=sha256=abc")).toBeNull();
  });
});
```

Run: `bun test src/webhook-signing.test.ts` — FAIL (module missing).

### Step 2: Implementation

Create `server/src/webhook-signing.ts`:

```ts
/* webhook-signing.ts — HMAC-SHA256 payload signing for outbound webhooks.

   Format (design §5.5):
     t=<unix>,kid=<current|previous>,v1=sha256=<64-hex>
   where hex = HMAC_SHA256(secret, "<unix>.<rawBody>")

   Subscribers verify with the snippet shown in the design doc; the same
   recipe is enforced server-side here for symmetry. */

import { createHmac } from "node:crypto";

export type Kid = "current" | "previous";

export function signPayload(rawBody: string, secret: string, kid: Kid, nowSeconds: number): string {
  const hex = createHmac("sha256", secret).update(`${nowSeconds}.${rawBody}`).digest("hex");
  return `t=${nowSeconds},kid=${kid},v1=sha256=${hex}`;
}

export interface SignatureParts {
  t: number;
  kid: Kid;
  v1: string;
}

export function parseSignatureHeader(header: string): SignatureParts | null {
  if (!header || typeof header !== "string") return null;
  const parts: Record<string, string> = {};
  for (const seg of header.split(",")) {
    const eq = seg.indexOf("=");
    if (eq <= 0) return null;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (!k || !v) return null;
    parts[k] = v;
  }
  if (!parts.t || !parts.kid || !parts.v1) return null;
  const tNum = Number(parts.t);
  if (!Number.isFinite(tNum)) return null;
  const m = /^sha256=([0-9a-f]+)$/i.exec(parts.v1);
  if (!m) return null;
  if (parts.kid !== "current" && parts.kid !== "previous") return null;
  return { t: tNum, kid: parts.kid as Kid, v1: m[1]! };
}
```

### Step 3: Run, regression, commit

```bash
cd server && bun test src/webhook-signing.test.ts
cd server && bun run typecheck
git add server/src/webhook-signing.ts server/src/webhook-signing.test.ts
git commit -m "$(cat <<'EOF'
feat(server): webhook-signing — HMAC-SHA256 payload signing helpers

signPayload(body, secret, kid, t) emits the t=…,kid=…,v1=sha256=<hex>
header per design §5.5. parseSignatureHeader is the inverse — used by
the test event handler (server-side replay-protection check, mirrors the
subscriber recipe).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `webhook-secrets.ts` — encrypt/decrypt + master key loading

**Files:**
- Create: `server/src/webhook-secrets.ts`
- Test: `server/src/webhook-secrets.test.ts`

This module wraps PR1's `crypto-secret.ts` for the webhook use case. It:
1. Loads the master key once at process start (via `resolveMasterKey`).
2. Provides `encryptWebhookSecret(plaintext) → { ciphertext, nonce, keyVersion, prefix }` for create + rotate.
3. Provides `decryptWebhookSecret(row) → string` for signing (consumed by dispatcher).

### Step 1: Test FIRST

Create `server/src/webhook-secrets.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "bun:test";
import { encryptWebhookSecret, decryptWebhookSecret, generateWebhookSecret, _setMasterKeyForTest } from "./webhook-secrets.ts";
import { generateMasterKeyB64 } from "./crypto-secret.ts";

beforeAll(() => {
  // Tests stub the master key in memory; production calls
  // resolveMasterKey(env.webhookMasterKeyB64) at scheduler start.
  _setMasterKeyForTest(Buffer.from(generateMasterKeyB64(), "base64"));
});

describe("generateWebhookSecret", () => {
  it("emits 'whsec_' + 43+ chars", () => {
    const v = generateWebhookSecret();
    expect(v.startsWith("whsec_")).toBe(true);
    expect(v.length).toBeGreaterThan(40);
  });
});

describe("encrypt + decrypt round-trip", () => {
  it("survives encrypt → decrypt", () => {
    const plain = "whsec_test1234567890ABCDEFGHIJK";
    const enc = encryptWebhookSecret(plain);
    expect(enc.keyVersion).toBe(1);
    expect(enc.prefix).toBe(plain.slice(0, 12));
    const dec = decryptWebhookSecret({
      ciphertext: enc.ciphertext, nonce: enc.nonce, keyVersion: enc.keyVersion,
    });
    expect(dec).toBe(plain);
  });

  it("decrypt with wrong nonce throws", () => {
    const enc = encryptWebhookSecret("plain");
    expect(() => decryptWebhookSecret({
      ciphertext: enc.ciphertext,
      nonce: new Uint8Array(12).fill(0xff),
      keyVersion: enc.keyVersion,
    })).toThrow();
  });
});
```

Run: `bun test src/webhook-secrets.test.ts` — FAIL.

### Step 2: Implementation

Create `server/src/webhook-secrets.ts`:

```ts
/* webhook-secrets.ts — webhook signing-secret lifecycle.

   Production loads the AES-256-GCM master key once at scheduler boot
   (resolveMasterKey from PR1's crypto-secret.ts). Tests inject a stub
   key via _setMasterKeyForTest.

   The plaintext secret is shown to the admin once at create / rotate.
   At-rest we store (ciphertext, nonce, keyVersion) per design §4.2. */

import { encryptSecret, decryptSecret, resolveMasterKey } from "./crypto-secret.ts";
import { env } from "./env.ts";

let masterKey: Buffer | null = null;

export function loadMasterKey(): Buffer {
  if (masterKey) return masterKey;
  const key = resolveMasterKey({
    envKey: env.webhookMasterKeyB64,
    file: env.webhookMasterKeyFile,
    selfHosted: env.selfHosted,
  });
  if (!key) {
    throw new Error("webhook master key not configured — set ZUGZUG_WEBHOOK_MASTER_KEY");
  }
  masterKey = key;
  return masterKey;
}

/** For tests only. Bypasses env.* resolution. */
export function _setMasterKeyForTest(key: Buffer): void {
  masterKey = key;
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${Buffer.from(bytes).toString("base64url")}`;
}

export interface EncryptedSecret {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
  prefix: string; // first 12 chars of plaintext; NOT secret
}

export function encryptWebhookSecret(plaintext: string): EncryptedSecret {
  const { ciphertext, nonce, keyVersion } = encryptSecret(plaintext, loadMasterKey(), 1);
  return { ciphertext, nonce, keyVersion, prefix: plaintext.slice(0, 12) };
}

export function decryptWebhookSecret(input: { ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number }): string {
  return decryptSecret(input.ciphertext, input.nonce, loadMasterKey(), input.keyVersion);
}
```

### Step 3: Run, regression, commit

```bash
cd server && bun test src/webhook-secrets.test.ts
git add server/src/webhook-secrets.ts server/src/webhook-secrets.test.ts
git commit -m "$(cat <<'EOF'
feat(server): webhook-secrets — encrypt/decrypt + master key lifecycle

Wraps PR1's crypto-secret.ts for the webhook use case. loadMasterKey()
is called once at scheduler start (and lazily on first encrypt/decrypt);
tests inject a stub via _setMasterKeyForTest. Plaintext secrets are
shown ONCE at create / rotate; at-rest we store (ciphertext, nonce,
keyVersion, prefix).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `repo-webhooks.ts` — webhook CRUD + rotation

**Files:**
- Create: `server/src/repo-webhooks.ts`
- Test: `server/src/repo-webhooks.test.ts`

Functions: `createWebhook`, `listWebhooks`, `getWebhook`, `patchWebhook`, `deleteWebhook`, `rotateSecret`, `reactivateWebhook`, `pauseWebhook`. All tenant-scoped; create/rotate return the plaintext value once.

This is a large file — ~300 LOC. Each function is small but together they cover the lifecycle. Write tests for each.

### Step 1: Tests FIRST

Create `server/src/repo-webhooks.test.ts` with one `describe` block per function — 12+ test cases total. Skeleton:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import {
  createWebhook, listWebhooks, getWebhook, patchWebhook,
  deleteWebhook, rotateSecret, reactivateWebhook, pauseWebhook,
} from "./repo-webhooks.ts";
import { _setMasterKeyForTest } from "./webhook-secrets.ts";
import { generateMasterKeyB64 } from "./crypto-secret.ts";

const T = "test_repo_webhooks";
const U = "u_test_wh";

beforeAll(async () => {
  _setMasterKeyForTest(Buffer.from(generateMasterKeyB64(), "base64"));
  await pgRun(`INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
               VALUES ($1, $1, 'WH Repo', 'default', now()) ON CONFLICT DO NOTHING`, [T]);
  await pgRun(`INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
               VALUES ($1, 'WH', 'w@example.test', 'W', false) ON CONFLICT DO NOTHING`, [U]);
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."webhook_delivery" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."webhook" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("createWebhook", () => {
  it("returns id + plaintext value once; persists encrypted at rest", async () => {
    const r = await createWebhook({
      tenantId: T, url: "https://example.test/wh",
      events: ["dimension.committed"], createdBy: U,
    });
    expect(r.id.startsWith("wh_")).toBe(true);
    expect(r.value.startsWith("whsec_")).toBe(true);

    const row = await pgGet<{ status: string; secret_prefix: string; events: string[] }>(
      `SELECT status, secret_prefix, events FROM "zugzug_app"."webhook" WHERE id = $1`,
      [r.id],
    );
    expect(row!.status).toBe("active");
    expect(row!.secret_prefix).toBe(r.value.slice(0, 12));
    expect(row!.events).toEqual(["dimension.committed"]);
  });

  it("rejects http:// (non-localhost) when not self-hosted", async () => {
    await expect(
      createWebhook({ tenantId: T, url: "http://evil.test/x", events: ["dimension.committed"], createdBy: U }),
    ).rejects.toThrow(/https/);
  });

  it("normalizes URL (trailing slash, lowercase host)", async () => {
    const r = await createWebhook({
      tenantId: T, url: "https://API.example.test/PATH/",
      events: ["dimension.committed"], createdBy: U,
    });
    const row = await pgGet<{ url: string }>(
      `SELECT url FROM "zugzug_app"."webhook" WHERE id = $1`, [r.id]);
    // Implementation detail: at minimum, the host should be lowercased.
    expect(row!.url.toLowerCase()).toBe(row!.url);
  });
});

describe("rotateSecret", () => {
  it("moves current to previous and emits a new current", async () => {
    const created = await createWebhook({
      tenantId: T, url: "https://rot.example.test/",
      events: ["dimension.committed"], createdBy: U,
    });
    const result = await rotateSecret({ tenantId: T, id: created.id, userId: U });
    expect(result.value.startsWith("whsec_")).toBe(true);
    expect(result.value).not.toBe(created.value);

    const row = await pgGet<{
      secret_ciphertext_previous: Buffer | null;
      secret_previous_expires_at: Date | null;
      secret_prefix: string;
      secret_prefix_previous: string | null;
    }>(
      `SELECT secret_ciphertext_previous, secret_previous_expires_at,
              secret_prefix, secret_prefix_previous
         FROM "zugzug_app"."webhook" WHERE id = $1`,
      [created.id],
    );
    expect(row!.secret_ciphertext_previous).not.toBeNull();
    expect(row!.secret_previous_expires_at).not.toBeNull();
    expect(row!.secret_prefix).toBe(result.value.slice(0, 12));
    expect(row!.secret_prefix_previous).toBe(created.value.slice(0, 12));
  });
});

describe("listWebhooks", () => {
  it("returns active+paused+disabled rows for the tenant, omits secret material", async () => {
    const created = await createWebhook({
      tenantId: T, url: "https://list.example.test/",
      events: ["dimension.committed"], createdBy: U,
    });
    const list = await listWebhooks(T);
    const found = list.find((w) => w.id === created.id);
    expect(found).toBeDefined();
    expect(found!.secretPrefix).toBe(created.value.slice(0, 12));
    expect((found as unknown as { secret_ciphertext?: unknown }).secret_ciphertext).toBeUndefined();
  });
});

describe("pauseWebhook + reactivateWebhook", () => {
  it("transitions active→paused→active", async () => {
    const r = await createWebhook({
      tenantId: T, url: "https://pause.example.test/",
      events: ["dimension.committed"], createdBy: U,
    });
    expect(await pauseWebhook(T, r.id, U)).toBe(true);
    let row = await pgGet<{ status: string }>(`SELECT status FROM "zugzug_app"."webhook" WHERE id = $1`, [r.id]);
    expect(row!.status).toBe("paused");
    expect(await reactivateWebhook(T, r.id, U)).toBe(true);
    row = await pgGet<{ status: string }>(`SELECT status FROM "zugzug_app"."webhook" WHERE id = $1`, [r.id]);
    expect(row!.status).toBe("active");
  });
});

describe("deleteWebhook", () => {
  it("DELETEs the row + DLQs pending deliveries", async () => {
    const r = await createWebhook({
      tenantId: T, url: "https://del.example.test/",
      events: ["dimension.committed"], createdBy: U,
    });
    // Seed a pending delivery directly (Task 1 covered the public path).
    await pgRun(
      `INSERT INTO "zugzug_app"."webhook_delivery"
         (id, tenant_id, webhook_id, event_id, event_type, delivery_url,
          signing_kid, status, payload, signature, created_at)
         VALUES ($1, $2, $3, 'evt_x', 'dimension.committed',
                 'https://del.example.test/', 'current', 'pending',
                 '{}'::jsonb, '', now())`,
      [`whd_del_${crypto.randomUUID().replace(/-/g, "")}`, T, r.id],
    );
    expect(await deleteWebhook(T, r.id, U)).toBe(true);
    const left = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."webhook" WHERE id = $1`, [r.id]);
    expect(left!.n).toBe(0);
    const dlq = await pgGet<{ status: string }>(
      `SELECT status FROM "zugzug_app"."webhook_delivery" WHERE webhook_id = $1 LIMIT 1`, [r.id]);
    expect(dlq!.status).toBe("dlq");
  });
});
```

Run: `bun test src/repo-webhooks.test.ts` — FAIL.

### Step 2: Implementation

Create `server/src/repo-webhooks.ts` with full implementations. Key points:

- `createWebhook`: validate URL (`new URL(input)` parseability + scheme policy via `env.selfHosted`), normalize via `url.toString()`, generate secret via `generateWebhookSecret()`, encrypt via `encryptWebhookSecret()`, INSERT row, return `{ id, value }`. Write audit row `"Created webhook"`.
- `listWebhooks`: SELECT id/url/events/status/secret_prefix/created_at/created_by + previous-prefix + previous-expiry — never returns ciphertext.
- `getWebhook`: same shape, scoped to tenant + id.
- `patchWebhook`: accept partial `{ url, events, status, description }`. Don't allow `status='disabled'` via PATCH (use auto-disable only).
- `rotateSecret`: read current row, move `secret_ciphertext`/`secret_nonce`/`secret_prefix` into `*_previous`, set `secret_previous_expires_at = now() + interval '24 hours'`, generate new secret, encrypt, UPDATE. Audit `"Rotated webhook secret"`.
- `reactivateWebhook`: status → active (only if previously `disabled` OR `paused`).
- `pauseWebhook`: status → paused (only if currently `active`).
- `deleteWebhook`: DLQ all pending deliveries for this webhook (UPDATE webhook_delivery SET status='dlq', last_error='webhook_deleted' WHERE webhook_id=$1 AND status IN ('pending','retry','in_flight')), then DELETE the webhook row.

Implementation skeleton:

```ts
/* repo-webhooks.ts — webhook CRUD + rotation + auto-disable lifecycle. */

import { pg } from "./env.ts";
import { pgRun, pgGet, pgAll, pgTx } from "./pg.ts";
import { env } from "./env.ts";
import {
  generateWebhookSecret, encryptWebhookSecret,
} from "./webhook-secrets.ts";
import { appendAuditAs } from "./repo-meta.ts";

function normalizeAndValidateUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error("invalid_url");
  }
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "https:") {
    // ok
  } else if (u.protocol === "http:" && isLocalhost && env.selfHosted) {
    // ok
  } else {
    throw new Error("https_required");
  }
  return u.toString();
}

export interface CreateWebhookInput {
  tenantId: string;
  url: string;
  events: string[];
  description?: string;
  createdBy: string;
}

export interface CreateWebhookResult {
  id: string;
  value: string;
}

export async function createWebhook(input: CreateWebhookInput): Promise<CreateWebhookResult> {
  const url = normalizeAndValidateUrl(input.url);
  if (!input.events.length) throw new Error("events_empty");
  const id = `wh_${crypto.randomUUID().replace(/-/g, "")}`;
  const value = generateWebhookSecret();
  const enc = encryptWebhookSecret(value);
  await pgRun(
    `INSERT INTO ${pg("webhook")}
       (id, tenant_id, url, secret_ciphertext, secret_nonce, secret_key_version,
        secret_prefix, events, status, description, created_at, created_by)
       VALUES ($1, $2, $3, $4::bytea, $5::bytea, $6, $7, $8::varchar[],
               'active', $9, now(), $10)`,
    [id, input.tenantId, url, enc.ciphertext, enc.nonce, enc.keyVersion,
     enc.prefix, input.events, input.description ?? null, input.createdBy],
  );
  await appendAuditAs(input.createdBy, "Created webhook", url, {
    tenantId: input.tenantId,
    metadata: { webhook_id: id, events: input.events },
  });
  return { id, value };
}

// listWebhooks, getWebhook, patchWebhook, deleteWebhook,
// rotateSecret, reactivateWebhook, pauseWebhook follow with similar shape.
// (Full implementations omitted from plan to keep it readable; the executor
//  writes them per the test cases above. Each is 15-30 lines.)
```

The executor fills in the remaining functions per the test cases.

### Step 3: Run, regression, commit

```bash
cd server && bun test src/repo-webhooks.test.ts
cd server && bun run typecheck
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr3_after_task7.txt
diff /tmp/zugzug_pr3_baseline.txt /tmp/zugzug_pr3_after_task7.txt
```

```bash
git add server/src/repo-webhooks.ts server/src/repo-webhooks.test.ts
git commit -m "$(cat <<'EOF'
feat(server): repo-webhooks — CRUD + rotation + auto-disable lifecycle

Eight functions covering the webhook lifecycle: createWebhook (encrypts
secret + audits), listWebhooks (omits ciphertext), getWebhook, patchWebhook
(URL + events + description, no status='disabled' override), deleteWebhook
(DLQs pending deliveries), rotateSecret (24h grace window with previous
secret), pauseWebhook + reactivateWebhook. URL validation runs at the
application layer (https-only outside self-host; http://localhost when
ZUGZUG_SELF_HOSTED=1). Audit rows for every admin action.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `webhook-dispatcher.ts` — the dispatcher job

**Files:**
- Create: `server/src/webhook-dispatcher.ts`
- Test: `server/src/webhook-dispatcher.test.ts`

The dispatcher is a global `SchedulerJob` that:
1. Reaps stuck `in_flight` rows (`>30s` old) → `retry`.
2. Claims up to N due rows via `SELECT … FOR UPDATE SKIP LOCKED` and flips `status='in_flight'`. Returns the connection to the pool.
3. Round-robins by tenant_id (per-tenant cap of 32 per tick).
4. Spawns up to 16 concurrent attempts via `runWithConcurrency`.
5. Each attempt: decrypts secret, signs payload, `fetch()` with 10-second `AbortSignal.timeout`, updates row state with short autocommit-style write.
6. Retry ladder: 0s/5s/30s/5m/1h. After attempt 5 → `dlq` + auto-disable check.
7. Auto-disable: when the dispatcher writes a non-test dlq row, count the last 50 non-test deliveries for that webhook; if all 50 are dlq → `UPDATE webhook SET status='disabled', disabled_reason='auto: 50 consecutive failed deliveries'`. Audit `"Webhook auto-disabled"`.

Implementation outline (this is the longest task — ~150 LOC):

```ts
/* webhook-dispatcher.ts — global SchedulerJob for outbound webhook delivery.

   Lifecycle per tick:
     1. Reap orphaned in_flight rows (>30s).
     2. Claim up to GLOBAL_BUDGET due rows via FOR UPDATE SKIP LOCKED.
     3. Round-robin slice by tenant_id (cap 32 per tenant per tick).
     4. Run runWithConcurrency(16) over the bucket.
     5. Each attempt: decrypt secret, sign payload, fetch with 10s timeout,
        then short autocommit-style state update.

   Connection-pool budget: claim is short (<50ms), attempt holds no connection
   during fetch, state-update is short. Steady working set ~1 connection. */

import type { SchedulerJob, JobContext, JobResult } from "./scheduler.ts";
import { pg } from "./env.ts";
import { pgRun, pgGet, pgAll, pgTxRaw } from "./pg.ts";
import { runWithConcurrency } from "./concurrency.ts";
import { decryptWebhookSecret } from "./webhook-secrets.ts";
import { signPayload } from "./webhook-signing.ts";
import { appendAuditAs } from "./repo-meta.ts";

const GLOBAL_BUDGET = 256;
const CONCURRENCY = 16;
const PER_TENANT_CAP = 32;
const RETRY_SCHEDULE_SEC = [0, 5, 30, 300, 3600]; // 0s, 5s, 30s, 5m, 1h

interface ClaimedRow {
  id: string;
  tenant_id: string;
  webhook_id: string;
  delivery_url: string;
  signing_kid: "current" | "previous";
  is_test: boolean;
  event_id: string;
  event_type: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
}

async function reapStuck(): Promise<number> {
  const r = await pgGet<{ n: number }>(
    `WITH reaped AS (
       UPDATE ${pg("webhook_delivery")}
          SET status = 'retry',
              next_attempt_at = now(),
              last_error = coalesce(last_error, '') || ' [reaped after crash]'
        WHERE status = 'in_flight'
          AND last_attempt_at < now() - interval '30 seconds'
        RETURNING 1
     ) SELECT count(*)::int AS n FROM reaped`,
  );
  return r?.n ?? 0;
}

async function claim(): Promise<ClaimedRow[]> {
  return await pgTxRaw(async (tx) => {
    return await tx.all<ClaimedRow>(
      `WITH due AS (
         SELECT id FROM ${pg("webhook_delivery")}
          WHERE status IN ('pending', 'retry')
            AND next_attempt_at <= now()
          ORDER BY next_attempt_at ASC, id ASC
          LIMIT ${GLOBAL_BUDGET}
          FOR UPDATE SKIP LOCKED
       )
       UPDATE ${pg("webhook_delivery")} wd
          SET status = 'in_flight',
              last_attempt_at = now(),
              attempts = wd.attempts + 1
         FROM due
        WHERE wd.id = due.id
        RETURNING wd.id, wd.tenant_id, wd.webhook_id, wd.delivery_url,
                  wd.signing_kid, wd.is_test, wd.event_id, wd.event_type,
                  wd.attempts, wd.max_attempts, wd.payload`,
    );
  });
}

function roundRobinByTenant<T extends { tenant_id: string }>(rows: T[], cap: number): T[] {
  const buckets = new Map<string, T[]>();
  for (const r of rows) {
    const arr = buckets.get(r.tenant_id) ?? [];
    if (arr.length < cap) {
      arr.push(r);
      buckets.set(r.tenant_id, arr);
    }
  }
  // Interleave: round-robin across tenants for fair share.
  const out: T[] = [];
  let added = true;
  let i = 0;
  while (added) {
    added = false;
    for (const arr of buckets.values()) {
      if (i < arr.length) { out.push(arr[i]!); added = true; }
    }
    i++;
  }
  return out;
}

async function loadWebhookSecret(webhookId: string, signingKid: "current" | "previous"):
  Promise<string | null>
{
  const row = await pgGet<{
    secret_ciphertext: Uint8Array; secret_nonce: Uint8Array; secret_key_version: number;
    secret_ciphertext_previous: Uint8Array | null; secret_nonce_previous: Uint8Array | null;
    secret_previous_expires_at: Date | null;
  }>(
    `SELECT secret_ciphertext, secret_nonce, secret_key_version,
            secret_ciphertext_previous, secret_nonce_previous, secret_previous_expires_at
       FROM ${pg("webhook")} WHERE id = $1`,
    [webhookId],
  );
  if (!row) return null;
  if (signingKid === "previous") {
    if (!row.secret_ciphertext_previous || !row.secret_nonce_previous ||
        !row.secret_previous_expires_at || row.secret_previous_expires_at < new Date()) {
      return null;
    }
    return decryptWebhookSecret({
      ciphertext: row.secret_ciphertext_previous,
      nonce: row.secret_nonce_previous,
      keyVersion: row.secret_key_version,
    });
  }
  return decryptWebhookSecret({
    ciphertext: row.secret_ciphertext,
    nonce: row.secret_nonce,
    keyVersion: row.secret_key_version,
  });
}

async function attempt(row: ClaimedRow): Promise<void> {
  const secret = await loadWebhookSecret(row.webhook_id, row.signing_kid);
  if (!secret) {
    await markDlq(row, /* lastErr */ "secret_unavailable", null, null);
    return;
  }
  const rawBody = JSON.stringify(row.payload);
  const nowSec = Math.floor(Date.now() / 1000);
  const signature = signPayload(rawBody, secret, row.signing_kid, nowSec);

  try {
    const resp = await fetch(row.delivery_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Zugzug-Webhooks/1.0",
        "x-zugzug-event": row.event_type,
        "x-zugzug-event-id": row.event_id,
        "x-zugzug-delivery-id": row.id,
        "x-zugzug-workspace": row.tenant_id,
        "x-zugzug-attempt": String(row.attempts),
        "x-zugzug-signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await truncateResponseBody(resp);
    if (resp.ok) {
      await pgRun(
        `UPDATE ${pg("webhook_delivery")}
            SET status = 'success',
                last_response_code = $1,
                last_response_body = $2,
                signature = $3,
                completed_at = now()
          WHERE id = $4`,
        [resp.status, body, signature, row.id],
      );
      return;
    }
    // 4xx/5xx → retry or dlq depending on attempts
    await scheduleRetryOrDlq(row, resp.status, body, null);
  } catch (e) {
    // Network error, timeout, etc.
    await scheduleRetryOrDlq(row, null, null, String(e).slice(0, 2000));
  }
}

async function truncateResponseBody(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.slice(0, 2048);
  } catch {
    return "";
  }
}

async function scheduleRetryOrDlq(row: ClaimedRow, code: number | null, body: string | null, err: string | null) {
  if (row.attempts >= row.max_attempts) {
    await markDlq(row, err, code, body);
    return;
  }
  const nextWaitSec = RETRY_SCHEDULE_SEC[row.attempts] ?? 3600;
  await pgRun(
    `UPDATE ${pg("webhook_delivery")}
        SET status = 'retry',
            last_response_code = $1,
            last_response_body = $2,
            last_error = $3,
            next_attempt_at = now() + interval '1 second' * $4
      WHERE id = $5`,
    [code, body, err, nextWaitSec, row.id],
  );
}

async function markDlq(row: ClaimedRow, err: string | null, code: number | null, body: string | null) {
  await pgRun(
    `UPDATE ${pg("webhook_delivery")}
        SET status = 'dlq',
            last_response_code = $1,
            last_response_body = $2,
            last_error = $3,
            completed_at = now()
      WHERE id = $4`,
    [code, body, err, row.id],
  );
  if (!row.is_test) {
    await maybeAutoDisable(row.tenant_id, row.webhook_id);
  }
}

async function maybeAutoDisable(tenantId: string, webhookId: string): Promise<void> {
  const r = await pgGet<{ all_dlq: boolean; n: number }>(
    `SELECT bool_and(status = 'dlq') AS all_dlq, count(*)::int AS n FROM (
       SELECT status FROM ${pg("webhook_delivery")}
        WHERE webhook_id = $1 AND is_test = false
        ORDER BY created_at DESC LIMIT 50
     ) recent`,
    [webhookId],
  );
  if (r?.all_dlq && r.n === 50) {
    await pgRun(
      `UPDATE ${pg("webhook")}
          SET status = 'disabled',
              disabled_at = now(),
              disabled_reason = 'auto: 50 consecutive failed deliveries'
        WHERE id = $1 AND status = 'active'`,
      [webhookId],
    );
    await appendAuditAs("u_system", "Webhook auto-disabled", webhookId, {
      tenantId, metadata: { reason: "auto: 50 consecutive failed deliveries" },
    });
  }
}

export const webhookDispatcherJob: SchedulerJob = {
  name: "webhook-dispatcher",
  scope: "global",
  async run(_ctx: JobContext): Promise<JobResult> {
    await reapStuck();
    const claimed = await claim();
    if (!claimed.length) return { rowsScanned: 0 };
    const bucket = roundRobinByTenant(claimed, PER_TENANT_CAP);
    await runWithConcurrency(bucket, CONCURRENCY, attempt);
    return { rowsScanned: claimed.length };
  },
};
```

### Test design

The test file uses Bun's built-in HTTP server to stand up a stub subscriber that responds with configurable status codes. Each test case:

1. Seed a webhook + a `webhook_delivery` row pointing at the stub.
2. Call `webhookDispatcherJob.run(ctx)` directly.
3. Assert: status, attempts, response_code, next_attempt_at.

Test cases:
- 200 OK → status='success', attempts=1, completed_at set.
- 500 → status='retry', attempts=1, next_attempt_at ≈ now + 5s.
- 200 timeout (subscriber delays >10s) → status='retry', last_error contains "abort"/"timeout".
- attempt 5 fails → status='dlq'.
- 50 consecutive dlq → webhook auto-disables; audit row.
- in_flight row >30s old → reaper flips back to retry.
- Test event (is_test=true) → does NOT count toward auto-disable.

### Implementation note: `pgTxRaw`

The plan calls `pgTxRaw` for the claim. The codebase may use `pgTx` (the scoped helper) or have a `pgTxRaw` for non-tenant-bound work. Confirm with `grep -n "pgTxRaw\|pgTx\b" server/src/pg.ts`; if no `pgTxRaw` exists, use `pgTx` with a NULL tenant. If the existing `pgTx` requires a tenant id, the dispatcher needs a different connection path — `pgPool` directly. The executor should check and adapt.

### Step 3: Run, regression, commit (each test case as separate steps)

```bash
cd server && bun test src/webhook-dispatcher.test.ts
cd server && bun run typecheck
git add server/src/webhook-dispatcher.ts server/src/webhook-dispatcher.test.ts
git commit -m "$(cat <<'EOF'
feat(server): webhook-dispatcher — global scheduler job

Per-tick lifecycle: reap stuck in_flight (>30s); FOR UPDATE SKIP LOCKED
claim up to 256 due rows globally; round-robin slice (cap 32 per tenant);
runWithConcurrency(16) over the bucket. Each attempt decrypts the
webhook's secret, signs the payload, POSTs with AbortSignal.timeout(10s),
then writes a short autocommit-style state update.

Retry ladder: 0s/5s/30s/5m/1h, dlq after attempt 5. When the dispatcher
DLQs a non-test delivery it checks the last 50 non-test rows for that
webhook; if all 50 are dlq → auto-disable + audit.

No Postgres connection is held during fetch.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Register the dispatcher + retention sweep in scheduler-jobs

**Files:**
- Modify: `server/src/scheduler-jobs.ts`
- Modify: `server/src/server.ts` (the scheduler-startup call)

Add `webhookDispatcherJob` and `outboundRetentionSweepJob` (Task 10) to the exported jobs. In `server.ts`, the scheduler is created with all jobs; just add the new ones to the array. Gate the dispatcher on `env.webhooksEnabled` — when off, don't register it.

```ts
// in scheduler-jobs.ts:
import { webhookDispatcherJob } from "./webhook-dispatcher.ts";
import { outboundRetentionSweepJob } from "./outbound-retention-sweep.ts";

// Export array for server.ts to consume.
export function buildJobs(): SchedulerJob[] {
  const jobs: SchedulerJob[] = [scanSourcesJob, autoStageJob, autoCommitJob];
  if (env.webhooksEnabled) {
    jobs.push(webhookDispatcherJob);
    jobs.push(outboundRetentionSweepJob);
  }
  return jobs;
}
```

Update `server.ts` to call `buildJobs()` instead of an inline literal.

Commit:
```bash
git add server/src/scheduler-jobs.ts server/src/server.ts
git commit -m "$(cat <<'EOF'
feat(scheduler): register webhook dispatcher + outbound sweep jobs

webhookDispatcherJob and outboundRetentionSweepJob join the scheduler
when WEBHOOKS_ENABLED=1; opted out by default for OSS deployments.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `outbound-retention-sweep.ts` — 30-day retention

**Files:**
- Create: `server/src/outbound-retention-sweep.ts`
- Test: `server/src/outbound-retention-sweep.test.ts`

A `SchedulerJob` (per-tenant scope — the existing scheduler iteration is fine). For each tenant, check `preferences.last_outbound_sweep_at`; if NULL or older than 6 hours, run:

1. `DELETE FROM outbound_event WHERE tenant_id=$1 AND occurred_at < now() - interval '30 days'`
2. `DELETE FROM webhook_delivery WHERE tenant_id=$1 AND created_at < now() - interval '30 days'`
3. `UPDATE webhook SET secret_ciphertext_previous=NULL, secret_nonce_previous=NULL, secret_prefix_previous=NULL, secret_previous_expires_at=NULL WHERE tenant_id=$1 AND secret_previous_expires_at < now()`
4. `UPDATE preferences SET last_outbound_sweep_at = now() WHERE tenant_id=$1`

The `preferences` table needs a `last_outbound_sweep_at TIMESTAMP NULL` column. If not present, add via migration 0027.

### Step 1: Add the column (schema + migration)

In `server/drizzle/schema.ts`, find the `preferences` table declaration. Add:
```ts
last_outbound_sweep_at: timestamp("last_outbound_sweep_at"),
```

Run `bun run db:generate` to produce `0027_outbound_sweep_preference.sql`. Apply to test db.

### Step 2: Implementation + test

Tests stand up two tenant rows + assorted event/delivery ages, run the sweep, assert correctness.

### Step 3: Commit

Standard cycle.

---

## Task 11: Webhook CRUD routes in `v1-routes.ts`

**Files:**
- Modify: `server/src/v1-routes.ts` (extend the dispatcher with 8 webhook routes)
- Modify: `server/src/v1-routes.test.ts` (extend)

Mirror the existing `service-accounts` dispatch block (line ~204-235). Add:

```ts
// /v1/webhooks (admin only)
if (v1[0] === "webhooks") {
  if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");

  // GET /v1/webhooks
  if (v1.length === 1 && method === "GET") {
    return json({ webhooks: await listWebhooks(ctx.tenantId) });
  }

  // POST /v1/webhooks
  if (v1.length === 1 && method === "POST") {
    const body = await parseBody<{ url?: string; events?: string[]; description?: string }>(req);
    if (!body) return jsonError(400, "invalid_json");
    try {
      const r = await createWebhook({
        tenantId: ctx.tenantId,
        url: body.url ?? "",
        events: body.events ?? [],
        description: body.description,
        createdBy: userId,
      });
      return json({ id: r.id, value: r.value }, 201);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "invalid_url" || msg === "https_required" || msg === "events_empty") {
        return jsonError(400, msg);
      }
      throw e;
    }
  }

  // /v1/webhooks/:id
  if (v1.length === 2) {
    const id = decodeURIComponent(v1[1]!);
    if (method === "GET") {
      const wh = await getWebhook(ctx.tenantId, id);
      return wh ? json(wh) : jsonError(404, "not_found");
    }
    if (method === "PATCH") {
      const body = await parseBody<Record<string, unknown>>(req);
      if (!body) return jsonError(400, "invalid_json");
      const ok = await patchWebhook(ctx.tenantId, id, body, userId);
      return ok ? new Response(null, { status: 204 }) : jsonError(404, "not_found");
    }
    if (method === "DELETE") {
      const ok = await deleteWebhook(ctx.tenantId, id, userId);
      return ok ? new Response(null, { status: 204 }) : jsonError(404, "not_found");
    }
  }

  // /v1/webhooks/:id/reactivate
  if (v1.length === 3 && v1[2] === "reactivate" && method === "POST") {
    const ok = await reactivateWebhook(ctx.tenantId, decodeURIComponent(v1[1]!), userId);
    return ok ? new Response(null, { status: 204 }) : jsonError(404, "not_found");
  }

  // /v1/webhooks/:id/rotate-secret
  if (v1.length === 3 && v1[2] === "rotate-secret" && method === "POST") {
    const r = await rotateSecret({ tenantId: ctx.tenantId, id: decodeURIComponent(v1[1]!), userId });
    return json({ value: r.value, previous_expires_at: r.previousExpiresAt });
  }

  // /v1/webhooks/:id/test
  if (v1.length === 3 && v1[2] === "test" && method === "POST") {
    const id = decodeURIComponent(v1[1]!);
    const deliveryId = await sendTestEvent(ctx.tenantId, id, userId);
    return json({ delivery_id: deliveryId });
  }

  // /v1/webhooks/:id/deliveries
  if (v1.length === 3 && v1[2] === "deliveries" && method === "GET") {
    const list = await listDeliveries(ctx.tenantId, decodeURIComponent(v1[1]!), {
      status: url.searchParams.get("status") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? "50"),
    });
    return json(list);
  }
}

// /v1/webhook-deliveries/:id
if (v1[0] === "webhook-deliveries") {
  if (ctx.role === "viewer") return jsonError(403, "editor_required");
  if (v1.length === 2 && method === "GET") {
    const d = await getDelivery(ctx.tenantId, decodeURIComponent(v1[1]!));
    return d ? json(d) : jsonError(404, "not_found");
  }
  // /v1/webhook-deliveries/:id/replay
  if (v1.length === 3 && v1[2] === "replay" && method === "POST") {
    if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
    const r = await replayDelivery(ctx.tenantId, decodeURIComponent(v1[1]!), userId);
    return r ? json({ delivery_id: r.id }, 202) : jsonError(404, "not_found");
  }
}
```

`sendTestEvent` and `replayDelivery` + `listDeliveries` + `getDelivery` come from a small `repo-webhook-deliveries.ts` module — implement alongside.

Tests in `v1-routes.test.ts` extend the existing 13 with ~8 more (one per route family).

---

## Task 12: `repo-webhook-deliveries.ts` — delivery log + replay + test event

**Files:**
- Create: `server/src/repo-webhook-deliveries.ts`
- Test: `server/src/repo-webhook-deliveries.test.ts`

Functions:

- `listDeliveries(tenantId, webhookId, opts)` — paginated. Filters by `status`. Viewers see `payload`/`signature`/`last_response_body` as `null` per design §9.
- `getDelivery(tenantId, deliveryId)` — single-row variant (same field-masking by role at the caller).
- `sendTestEvent(tenantId, webhookId, userId)` — synthesises a `webhook.test` delivery: insert a `webhook_delivery` row with `is_test=true`, `event_type='webhook.test'`, `payload={ dim_slug: null, message: '...' }`, `status='pending'`, `next_attempt_at=now()`. The dispatcher's next tick fires it. Returns the delivery id.
- `replayDelivery(tenantId, deliveryId, userId)` — clones the row (new `id`, `attempts=0`, `status='pending'`, `next_attempt_at=now()`, same `delivery_url`). If the original `signing_kid='previous'` AND the previous secret has been swept → set the clone's `signing_kid='current'` (per design §4.3 replay-after-grace). Audit `"Replayed webhook delivery"`.

Implementation follows the same shape as `repo-webhooks.ts` — pgRun/pgGet/pgAll with explicit field selection.

Commit standard cycle.

---

## Task 13: SA → dispatcher attribution for test events

**Files:**
- Modify: `server/src/repo-webhook-deliveries.ts` (extend `sendTestEvent` to capture userId in audit)

Test events fired from the UI need to be audited with the firing user. `sendTestEvent` writes an audit row `"Sent test event"` with `metadata: { webhook_id, delivery_id }`.

Commit standard.

---

## Task 14: `.env.example` — document webhook deployment

**Files:**
- Modify: `server/.env.example`

PR1 already documented `WEBHOOKS_ENABLED`, `ZUGZUG_WEBHOOK_MASTER_KEY`, etc. PR3 just confirms the comments are still accurate. If anything has shifted, update.

Quick task. Commit.

---

## Task 15: End-to-end integration test

**Files:**
- Create: `server/src/webhook-e2e.test.ts`

A multi-step test that wires the whole chain:

1. Create a tenant + a webhook subscribed to `dimension.committed`.
2. Stand up a stub HTTP server (Bun's `serve`).
3. Run a commit that produces an event.
4. Wait for the dispatcher tick (or call `webhookDispatcherJob.run` directly).
5. Assert the stub server received the POST with the right headers + signature.
6. Verify the signature with the stored secret + parse-and-verify recipe.
7. `webhook_delivery` row status='success'.

This is the proof that everything works together.

---

## Task 16: Final verification

- [ ] Run `cd server && bun test` — confirm baseline + PR3 tests pass; no new regressions.
- [ ] Run `cd server && bun run typecheck && cd ../app && bun run typecheck` — exit 0.
- [ ] `git log --oneline main..HEAD` — confirm expected commit list (~15-16 commits).
- [ ] Manually start the server with `WEBHOOKS_ENABLED=1`, register a webhook, commit a dimension change, watch the delivery log.

---

## Self-Review

**1. Spec coverage** — every PR3 item from design §3.3, §4.3, §5.3:
- [x] `dispatchOutbound` write inside pgTx — Task 1, 2, 3
- [x] `dimension.committed` event firing — Task 2
- [x] `canonical.deleted` event firing — Task 3
- [x] Global SchedulerJob scope — Task 4
- [x] HMAC payload signing — Task 5
- [x] AES-GCM secret encrypt/decrypt + master key load — Task 6
- [x] Webhook CRUD + rotation grace — Task 7
- [x] Dispatcher: claim/round-robin/concurrency/retry/dlq/auto-disable — Task 8
- [x] Reaper for orphaned in_flight — Task 8
- [x] Scheduler registration — Task 9
- [x] Retention sweep — Task 10
- [x] HTTP routes (8 webhook + 2 delivery) — Task 11
- [x] Test event + replay endpoints — Task 11 + Task 12
- [x] Audit attribution — Task 13

**2. Placeholder scan** — no TODO/TBD/"similar to" in code blocks.

**3. Type consistency:**
- `ClaimedRow` / `DispatchInput` / `EncryptedSecret` shapes consistent across files.
- `Kid` type ("current" | "previous") used in signing.ts, secrets.ts, dispatcher.ts.
- `SchedulerJob.scope` defaults `per-tenant`; global scope new in Task 4.

**Open considerations for the executing engineer:**

- **`pgTxRaw` may not exist** — verify with `grep -n "pgTxRaw\|export.*pgTx" server/src/pg.ts`. If only `pgTx` exists and it requires a tenant, the dispatcher's global claim needs a different path (direct `postgres` client connection).
- **`approvedDrafts` shape** in commit() — the existing `commit()` builds this from a SELECT before the pgTx; verify the structure matches `{ raw, key, label }` per the survey. If it differs, adjust the payload mapping in Task 2.
- **Webhook secret keyVersion** — v1 ships only version 1; the decrypt path verifies version match but doesn't dispatch to a key-version table. Don't add v2 in this PR.
- **Master key in tests** — `_setMasterKeyForTest` is the escape hatch. Production calls `loadMasterKey()` which hits `env.webhookMasterKeyB64`. Make sure both PR3 tests AND any inherited PR1/PR2 tests that touch the webhook table call `_setMasterKeyForTest` in a `beforeAll`.
