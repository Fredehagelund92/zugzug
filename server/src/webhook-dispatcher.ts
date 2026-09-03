/* webhook-dispatcher.ts — global SchedulerJob that delivers outbound webhook payloads.

   Per-tick lifecycle:
     1. reapStuck:  in_flight rows whose last_attempt_at is >30s old → 'retry' with
                    last_error='reaped_stuck'. Belt-and-suspenders for crashed workers.
     2. claim:      FOR UPDATE SKIP LOCKED claim of up to GLOBAL_BUDGET due rows in a
                    SHORT transaction, joined to the webhook so only 'active' ones
                    are picked up — a paused or auto-disabled endpoint keeps its
                    backlog queued and receives it on resume. Flips
                    status='in_flight', attempts += 1, last_attempt_at=now() and
                    RETURNS the snapshot.
     3. round-robin slice across tenants — cap PER_TENANT_CAP per tick to keep a
        single noisy tenant from starving others.
     4. fan out via runWithConcurrency(CONCURRENCY) — each attempt decrypts the
        webhook secret (both keys while a rotation grace is open, so the payload
        carries a signature for each), POSTs with AbortSignal.timeout(10s), and
        writes its terminal state in a short autocommit-style UPDATE.
     5. retry ladder RETRY_SCHEDULE_SEC, dlq after attempt 5.
     6. when a non-test dlq is recorded → check last 50 non-test rows for that
        webhook; if all 50 are dlq → auto-disable + audit.

   No Postgres connection is held during fetch — claim closes the tx before fan-out. */

import type { SchedulerJob, JobContext, JobResult } from "./scheduler.ts";
import { pg } from "./env.ts";
import { pgRun, pgGet, pgAll, pgTx } from "./pg.ts";
import { runWithConcurrency } from "./concurrency.ts";
import { decryptWebhookSecret } from "./webhook-secrets.ts";
import { signPayloadMulti, deliveryHeaders, type Kid, type SigningKey } from "./webhook-signing.ts";
import { appendAuditAs } from "./repo-meta.ts";

const GLOBAL_BUDGET = 256;
const CONCURRENCY = 16;
const PER_TENANT_CAP = 32;
const RETRY_SCHEDULE_SEC = [0, 5, 30, 300, 3600];
const REAP_AFTER_MS = 30_000;
let HTTP_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_TRUNC = 4096;

/** Override HTTP_TIMEOUT_MS for deterministic tests. Reset to 10_000 after use. */
export function _setHttpTimeoutMsForTest(ms: number): void {
  HTTP_TIMEOUT_MS = ms;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  webhook_id: string;
  delivery_url: string;
  signing_kid: Kid;
  is_test: boolean;
  event_id: string;
  event_type: string;
  attempts: number;
  max_attempts: number;
  payload: unknown; // jsonb — comes back as string from postgres.js
}

async function reapStuck(): Promise<number> {
  // Move in_flight rows older than REAP_AFTER_MS back to 'retry' so they can be
  // re-claimed on a future tick. Pure SQL — no tx needed (single statement).
  const rows = await pgAll<{ id: string }>(
    `UPDATE ${pg("webhook_delivery")}
        SET status = 'retry',
            last_error = COALESCE(NULLIF(last_error, ''), 'reaped_stuck'),
            next_attempt_at = now()
      WHERE status = 'in_flight'
        AND last_attempt_at IS NOT NULL
        AND last_attempt_at < now() - ($1::int || ' milliseconds')::interval
     RETURNING id`,
    [REAP_AFTER_MS],
  );
  return rows.length;
}

async function claim(): Promise<ClaimedRow[]> {
  return await pgTx(async (tx) => {
    return await tx.all<ClaimedRow>(
      `WITH cte AS (
         SELECT wd.id
           FROM ${pg("webhook_delivery")} wd
           JOIN ${pg("webhook")} w
             ON w.id = wd.webhook_id AND w.tenant_id = wd.tenant_id
          WHERE wd.status IN ('pending', 'retry')
            AND (wd.next_attempt_at IS NULL OR wd.next_attempt_at <= now())
            AND w.status = 'active'
          ORDER BY COALESCE(wd.next_attempt_at, wd.created_at), wd.id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE ${pg("webhook_delivery")} wd
          SET status = 'in_flight',
              attempts = wd.attempts + 1,
              last_attempt_at = now()
         FROM cte
        WHERE wd.id = cte.id
        RETURNING wd.id, wd.tenant_id, wd.webhook_id, wd.delivery_url,
                  wd.signing_kid, wd.is_test, wd.event_id, wd.event_type,
                  wd.attempts, wd.max_attempts, wd.payload`,
      [GLOBAL_BUDGET],
    );
  });
}

function roundRobinByTenant(rows: ClaimedRow[], capPerTenant: number): ClaimedRow[] {
  const byTenant = new Map<string, ClaimedRow[]>();
  for (const r of rows) {
    let arr = byTenant.get(r.tenant_id);
    if (!arr) {
      arr = [];
      byTenant.set(r.tenant_id, arr);
    }
    if (arr.length < capPerTenant) arr.push(r);
  }
  const out: ClaimedRow[] = [];
  const queues = Array.from(byTenant.values());
  const cursors = queues.map(() => 0);
  let live = queues.length;
  while (live > 0) {
    live = 0;
    for (let i = 0; i < queues.length; i++) {
      const q = queues[i]!;
      const c = cursors[i]!;
      if (c < q.length) {
        out.push(q[c]!);
        cursors[i] = c + 1;
        if (cursors[i]! < q.length) live++;
      }
    }
  }
  return out;
}

interface WebhookSecretRow {
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_key_version: number;
  secret_ciphertext_previous: Buffer | null;
  secret_nonce_previous: Buffer | null;
  secret_previous_expires_at: Date | string | null;
}

/* Returns the keys a delivery is signed with: the one its signing_kid names
   first, plus — while the 24h rotation grace is still open — the other one.
   Dual-signing is what makes the promised overlap window real: a delivery
   enqueued before a rotation still verifies under the secret the consumer had
   at enqueue time, and one enqueued after it verifies under both. Empty means
   the named key is gone (swept previous secret) and the row must go to dlq. */
async function loadSigningKeys(
  webhookId: string,
  tenantId: string,
  kid: Kid,
): Promise<SigningKey[]> {
  const row = await pgGet<WebhookSecretRow>(
    `SELECT secret_ciphertext, secret_nonce, secret_key_version,
            secret_ciphertext_previous, secret_nonce_previous, secret_previous_expires_at
       FROM ${pg("webhook")}
      WHERE id = $1 AND tenant_id = $2`,
    [webhookId, tenantId],
  );
  if (!row) return [];
  const decrypt = (ciphertext: Buffer | null, nonce: Buffer | null): string | null => {
    if (!ciphertext || !nonce) return null;
    try {
      return decryptWebhookSecret({
        ciphertext: new Uint8Array(ciphertext),
        nonce: new Uint8Array(nonce),
        keyVersion: row.secret_key_version,
      });
    } catch {
      return null;
    }
  };
  const graceOpen =
    row.secret_previous_expires_at !== null &&
    new Date(row.secret_previous_expires_at).getTime() >= Date.now();
  const current = decrypt(row.secret_ciphertext, row.secret_nonce);
  const previous = graceOpen
    ? decrypt(row.secret_ciphertext_previous, row.secret_nonce_previous)
    : null;
  const primary = kid === "current" ? current : previous;
  if (!primary) return [];
  const secondary = kid === "current" ? previous : current;
  const keys: SigningKey[] = [{ kid, secret: primary }];
  if (secondary) keys.push({ kid: kid === "current" ? "previous" : "current", secret: secondary });
  return keys;
}

function truncBody(body: string): string {
  return body.length > RESPONSE_BODY_TRUNC ? body.slice(0, RESPONSE_BODY_TRUNC) : body;
}

async function markSuccess(
  row: ClaimedRow,
  code: number,
  body: string,
  signature: string,
): Promise<void> {
  await pgRun(
    `UPDATE ${pg("webhook_delivery")}
        SET status = 'success',
            last_response_code = $2,
            last_response_body = $3,
            last_error = NULL,
            signature = $4,
            next_attempt_at = NULL,
            completed_at = now()
      WHERE id = $1`,
    [row.id, code, truncBody(body), signature],
  );
}

async function maybeAutoDisable(tenantId: string, webhookId: string): Promise<void> {
  const rows = await pgAll<{ status: string }>(
    `SELECT status FROM ${pg("webhook_delivery")}
      WHERE tenant_id = $1 AND webhook_id = $2 AND is_test = false
      ORDER BY created_at DESC
      LIMIT 50`,
    [tenantId, webhookId],
  );
  if (rows.length < 50) return;
  if (!rows.every((r) => r.status === "dlq")) return;

  const updated = await pgGet<{ url: string }>(
    `UPDATE ${pg("webhook")}
        SET status = 'disabled',
            disabled_at = now(),
            disabled_reason = 'auto_disabled_50_consecutive_dlq'
      WHERE id = $1 AND tenant_id = $2 AND status <> 'disabled'
      RETURNING url`,
    [webhookId, tenantId],
  );
  if (!updated) return;
  await appendAuditAs("u_system", "Webhook auto-disabled", updated.url, {
    tenantId,
    metadata: { webhook_id: webhookId, reason: "50_consecutive_dlq" },
  });
}

async function markDlq(
  row: ClaimedRow,
  lastError: string,
  code: number | null,
  body: string | null,
  signature: string | null,
): Promise<void> {
  await pgRun(
    `UPDATE ${pg("webhook_delivery")}
        SET status = 'dlq',
            last_error = $2,
            last_response_code = COALESCE($3, last_response_code),
            last_response_body = COALESCE($4, last_response_body),
            signature = COALESCE($5, signature),
            next_attempt_at = NULL,
            completed_at = now()
      WHERE id = $1`,
    [row.id, lastError, code, body !== null ? truncBody(body) : null, signature],
  );
  if (!row.is_test) {
    await maybeAutoDisable(row.tenant_id, row.webhook_id).catch((e) => {
      console.error(`webhook-dispatcher: maybeAutoDisable failed for ${row.webhook_id}:`, e);
    });
  }
}

async function scheduleRetryOrDlq(
  row: ClaimedRow,
  lastError: string,
  code: number | null,
  body: string | null,
  signature: string | null,
): Promise<void> {
  if (row.attempts >= row.max_attempts) {
    await markDlq(row, lastError, code, body, signature);
    return;
  }
  // attempts already incremented in claim(); next delay = schedule[attempts]
  const delaySec =
    RETRY_SCHEDULE_SEC[Math.min(row.attempts, RETRY_SCHEDULE_SEC.length - 1)] ?? 3600;
  await pgRun(
    `UPDATE ${pg("webhook_delivery")}
        SET status = 'retry',
            last_error = $2,
            last_response_code = $3,
            last_response_body = $4,
            signature = COALESCE($5, signature),
            next_attempt_at = now() + ($6::int || ' seconds')::interval
      WHERE id = $1`,
    [row.id, lastError, code, body !== null ? truncBody(body) : null, signature, delaySec],
  );
}

async function attempt(row: ClaimedRow): Promise<void> {
  const keys = await loadSigningKeys(row.webhook_id, row.tenant_id, row.signing_kid);
  if (!keys.length) {
    await markDlq(row, "secret_unavailable", null, null, null);
    return;
  }

  const rawBody = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
  const nowSec = Math.floor(Date.now() / 1000);
  const signature = signPayloadMulti(rawBody, keys, nowSec);

  try {
    const resp = await fetch(row.delivery_url, {
      method: "POST",
      headers: deliveryHeaders({
        eventType: row.event_type,
        eventId: row.event_id,
        deliveryId: row.id,
        signature,
        isTest: row.is_test,
      }),
      body: rawBody,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const body = await resp.text().catch(() => "");
    if (resp.ok) {
      await markSuccess(row, resp.status, body, signature);
    } else {
      await scheduleRetryOrDlq(row, `http_${resp.status}`, resp.status, body, signature);
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await scheduleRetryOrDlq(row, msg, null, null, signature);
  }
}

export const webhookDispatcherJob: SchedulerJob = {
  name: "webhook-dispatcher",
  scope: "global",
  async run(_ctx: JobContext): Promise<JobResult> {
    await reapStuck().catch((e) => {
      console.error("webhook-dispatcher: reapStuck failed:", e);
      return 0;
    });
    const claimed = await claim();
    if (!claimed.length) return { rowsScanned: 0 };
    const bucket = roundRobinByTenant(claimed, PER_TENANT_CAP);
    await runWithConcurrency(bucket, CONCURRENCY, attempt);
    return { rowsScanned: claimed.length };
  },
};
