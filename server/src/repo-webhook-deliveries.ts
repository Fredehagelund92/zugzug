/* repo-webhook-deliveries.ts — delivery list/get/test/replay.

   Helpers that read and synthesise webhook_delivery rows. The dispatcher
   (webhook-dispatcher.ts) does the actual HTTP send — these functions
   only enqueue work for it.

   Role-masking (design §9): viewers see `payload`, `signature`, and
   `last_response_body` as null. Editors and admins see the full row.

   Replay re-sign rule (design §4.3): when cloning a row whose original
   `signing_kid='previous'`, if the webhook's previous secret has been
   swept (`secret_previous_expires_at < now()` or null), the replay
   resets to `signing_kid='current'` so the dispatcher signs with the
   live secret instead of one that no longer exists. */

import { pg } from "./env.ts";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import { appendAuditAs } from "./repo-meta.ts";

export type DeliveryStatus = "pending" | "in_flight" | "success" | "retry" | "dlq";
export type Role = "viewer" | "editor" | "admin";

export interface DeliverySummary {
  id: string;
  event_type: string;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  last_response_code: number | null;
  last_attempt_at: string | null;
  completed_at: string | null;
  signing_kid: "current" | "previous";
  is_test: boolean;
  /** Masked to null for viewers. */
  payload: unknown;
  /** Masked to null for viewers. */
  signature: string | null;
  /** Masked to null for viewers. */
  last_response_body: string | null;
}

interface DeliveryRow {
  id: string;
  event_type: string;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  last_response_code: number | null;
  last_attempt_at: string | null;
  completed_at: string | null;
  signing_kid: "current" | "previous";
  is_test: boolean;
  payload: unknown;
  signature: string;
  last_response_body: string | null;
}

const SELECT_COLS = `
  id, event_type, status, attempts, max_attempts,
  last_response_code,
  last_attempt_at::text AS last_attempt_at,
  completed_at::text AS completed_at,
  signing_kid, is_test,
  payload, signature, last_response_body
`;

function mask(row: DeliveryRow, role: Role): DeliverySummary {
  const isViewer = role === "viewer";
  return {
    id: row.id,
    event_type: row.event_type,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    last_response_code: row.last_response_code,
    last_attempt_at: row.last_attempt_at,
    completed_at: row.completed_at,
    signing_kid: row.signing_kid,
    is_test: row.is_test,
    payload: isViewer ? null : row.payload,
    signature: isViewer ? null : row.signature,
    last_response_body: isViewer ? null : row.last_response_body,
  };
}

export interface ListDeliveriesOpts {
  status?: string;
  limit?: number;
  role?: Role;
}

export async function listDeliveries(
  tenantId: string,
  webhookId: string,
  opts: ListDeliveriesOpts = {},
): Promise<{ deliveries: DeliverySummary[] }> {
  const role: Role = opts.role ?? "admin";
  const limit = Math.max(1, Math.min(200, Number.isFinite(opts.limit) ? (opts.limit as number) : 50));
  const params: unknown[] = [tenantId, webhookId];
  let statusFilter = "";
  if (opts.status) {
    params.push(opts.status);
    statusFilter = `AND status = $${params.length}`;
  }
  const rows = await pgAll<DeliveryRow>(
    `SELECT ${SELECT_COLS}
       FROM ${pg("webhook_delivery")}
      WHERE tenant_id = $1 AND webhook_id = $2 ${statusFilter}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return { deliveries: rows.map((r) => mask(r, role)) };
}

export async function getDelivery(
  tenantId: string,
  deliveryId: string,
  role: Role = "admin",
): Promise<DeliverySummary | null> {
  const row = await pgGet<DeliveryRow>(
    `SELECT ${SELECT_COLS}
       FROM ${pg("webhook_delivery")}
      WHERE id = $1 AND tenant_id = $2`,
    [deliveryId, tenantId],
  );
  return row ? mask(row, role) : null;
}

export async function sendTestEvent(
  tenantId: string,
  webhookId: string,
  userId: string,
): Promise<{ delivery_id: string } | null> {
  const wh = await pgGet<{ url: string; status: string }>(
    `SELECT url, status FROM ${pg("webhook")} WHERE id = $1 AND tenant_id = $2`,
    [webhookId, tenantId],
  );
  if (!wh) return null;

  const deliveryId = `whd_${crypto.randomUUID().replace(/-/g, "")}`;
  const eventId = `ev_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const payload = JSON.stringify({
    dim_slug: null,
    message: "This is a test event from the Zugzug UI.",
  });
  await pgRun(
    `INSERT INTO ${pg("webhook_delivery")}
       (id, tenant_id, webhook_id, event_id, event_type, delivery_url,
        signing_kid, is_test, status, attempts, max_attempts,
        next_attempt_at, payload, signature, created_at)
     VALUES ($1, $2, $3, $4, 'webhook.test', $5,
             'current', true, 'pending', 0, 5,
             now(), $6::jsonb, '', now())`,
    [deliveryId, tenantId, webhookId, eventId, wh.url, payload],
  );
  await appendAuditAs(userId, "Sent test event", wh.url, {
    tenantId,
    metadata: { webhook_id: webhookId, delivery_id: deliveryId },
  });
  return { delivery_id: deliveryId };
}

export async function replayDelivery(
  tenantId: string,
  deliveryId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const original = await pgGet<{
    webhook_id: string;
    event_id: string;
    event_type: string;
    delivery_url: string;
    signing_kid: "current" | "previous";
    is_test: boolean;
    payload: unknown;
  }>(
    `SELECT webhook_id, event_id, event_type, delivery_url,
            signing_kid, is_test, payload
       FROM ${pg("webhook_delivery")}
      WHERE id = $1 AND tenant_id = $2`,
    [deliveryId, tenantId],
  );
  if (!original) return null;

  // Re-sign rule: if original used the previous secret but it's been swept,
  // reset to 'current' so the dispatcher can sign with a live key.
  let kid: "current" | "previous" = original.signing_kid;
  if (kid === "previous") {
    // Compare DB-side to avoid host/DB TZ skew when the column is `timestamp`
    // without timezone (postgres.js parses bare timestamps as UTC).
    const wh = await pgGet<{ expired: boolean }>(
      `SELECT (secret_previous_expires_at IS NULL
              OR secret_previous_expires_at < now()) AS expired
         FROM ${pg("webhook")}
        WHERE id = $1`,
      [original.webhook_id],
    );
    if (!wh || wh.expired) {
      kid = "current";
    }
  }

  const newId = `whd_${crypto.randomUUID().replace(/-/g, "")}`;
  const payloadStr =
    typeof original.payload === "string"
      ? original.payload
      : JSON.stringify(original.payload);
  await pgRun(
    `INSERT INTO ${pg("webhook_delivery")}
       (id, tenant_id, webhook_id, event_id, event_type, delivery_url,
        signing_kid, is_test, status, attempts, max_attempts,
        next_attempt_at, payload, signature, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 0, 5,
             now(), $9::jsonb, '', now())`,
    [
      newId,
      tenantId,
      original.webhook_id,
      original.event_id,
      original.event_type,
      original.delivery_url,
      kid,
      original.is_test,
      payloadStr,
    ],
  );
  await appendAuditAs(userId, "Replayed webhook delivery", deliveryId, {
    tenantId,
    metadata: {
      original_delivery_id: deliveryId,
      replay_delivery_id: newId,
      kid_changed: kid !== original.signing_kid,
    },
  });
  return { id: newId };
}
