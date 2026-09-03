/* repo-webhooks.ts — webhook CRUD + rotation + auto-disable lifecycle.

   Eight tenant-scoped functions covering the full webhook lifecycle.
   Secrets are encrypted at rest (AES-256-GCM via webhook-secrets.ts) and
   only ever revealed in plaintext to the admin at create + rotate time.

   URL policy lives at the application layer, not in the CHECK constraint:
   https-only outside self-host; http://localhost OK when ZUGZUG_SELF_HOSTED=1. */

import { pg, env } from "./env.ts";
import { pgRun, pgGet, pgAll, pgTx } from "./pg.ts";
import { generateWebhookSecret, encryptWebhookSecret } from "./webhook-secrets.ts";
import { appendAuditAs } from "./repo-meta.ts";

/* ---------- URL validation ---------- */

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

/* ---------- Event taxonomy ---------- */

const KNOWN_EVENTS = new Set([
  "table.published",
  "table.created",
  "table.fields.updated",
  "record.deleted",
]);

function validateEvents(events: string[]): void {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("events_empty");
  }
  for (const e of events) {
    if (!KNOWN_EVENTS.has(e)) throw new Error(`events_unknown:${e}`);
  }
}

/* ---------- Types ---------- */

export interface CreateWebhookInput {
  tenantId: string;
  url: string;
  events: string[];
  description?: string | null;
  createdBy: string;
}

export interface CreateWebhookResult {
  id: string;
  /** Plaintext secret, shown once. */
  value: string;
}

/** Wire shape. snake_case like the rest of the v1 surface (see
 *  repo-webhook-deliveries.ts:DeliverySummary) — the client type
 *  `Webhook` in app/src/lib/integrations-api.ts declares exactly these keys. */
export interface WebhookSummary {
  id: string;
  url: string;
  events: string[];
  status: "active" | "paused" | "disabled";
  description: string | null;
  secret_prefix: string;
  secret_prefix_previous: string | null;
  secret_previous_expires_at: string | null;
  created_at: string;
  created_by: string;
  paused_at: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
  /** Most recent attempted delivery — null until the dispatcher has tried once. */
  last_delivery_at: string | null;
  last_delivery_status: number | null;
  /** Deliveries waiting to be sent. Non-zero while the webhook is paused. */
  queued_count: number;
}

export interface PatchWebhookBody {
  url?: string;
  events?: string[];
  description?: string | null;
  /** PATCH may only set 'active' or 'paused'. 'disabled' is reserved for auto-disable. */
  status?: "active" | "paused";
}

export interface RotateSecretInput {
  tenantId: string;
  id: string;
  userId: string;
}

export interface RotateSecretResult {
  value: string;
  previousExpiresAt: string;
}

/* ---------- SELECT projection ---------- */

/* last_delivery_* and queued_count are read back per webhook: the list page
   shows "Last delivery" and the detail page shows how much a pause has
   queued up. Both are bounded by the admin-sized webhook count. */
const SUMMARY_SELECT = `
  SELECT w.id, w.url, w.events, w.status, w.description,
         w.secret_prefix,
         w.secret_prefix_previous,
         w.secret_previous_expires_at::text AS secret_previous_expires_at,
         w.created_at::text AS created_at,
         w.created_by,
         w.paused_at::text   AS paused_at,
         w.disabled_at::text AS disabled_at,
         w.disabled_reason,
         ld.last_attempt_at::text AS last_delivery_at,
         ld.last_response_code    AS last_delivery_status,
         (SELECT count(*)::int
            FROM ${pg("webhook_delivery")} q
           WHERE q.tenant_id = w.tenant_id AND q.webhook_id = w.id
             AND q.status IN ('pending', 'retry')) AS queued_count
    FROM ${pg("webhook")} w
    LEFT JOIN LATERAL (
      SELECT d.last_attempt_at, d.last_response_code
        FROM ${pg("webhook_delivery")} d
       WHERE d.tenant_id = w.tenant_id AND d.webhook_id = w.id
         AND d.last_attempt_at IS NOT NULL
       ORDER BY d.last_attempt_at DESC
       LIMIT 1
    ) ld ON true
`;

/* ---------- createWebhook ---------- */

export async function createWebhook(input: CreateWebhookInput): Promise<CreateWebhookResult> {
  const url = normalizeAndValidateUrl(input.url);
  validateEvents(input.events);

  const id = `wh_${crypto.randomUUID().replace(/-/g, "")}`;
  const value = generateWebhookSecret();
  const enc = encryptWebhookSecret(value);

  await pgRun(
    `INSERT INTO ${pg("webhook")}
       (id, tenant_id, url,
        secret_ciphertext, secret_nonce, secret_key_version, secret_prefix,
        events, status, description,
        created_at, created_by)
     VALUES ($1, $2, $3,
             $4::bytea, $5::bytea, $6, $7,
             $8::varchar[], 'active', $9,
             now(), $10)`,
    [
      id,
      input.tenantId,
      url,
      Buffer.from(enc.ciphertext),
      Buffer.from(enc.nonce),
      enc.keyVersion,
      enc.prefix,
      input.events,
      input.description ?? null,
      input.createdBy,
    ],
  );

  await appendAuditAs(input.createdBy, "Created webhook", url, {
    tenantId: input.tenantId,
    metadata: { webhook_id: id, events: input.events },
  });

  return { id, value };
}

/* ---------- listWebhooks ---------- */

export async function listWebhooks(tenantId: string): Promise<WebhookSummary[]> {
  return await pgAll<WebhookSummary>(
    `${SUMMARY_SELECT}
      WHERE w.tenant_id = $1
      ORDER BY w.created_at DESC`,
    [tenantId],
  );
}

/* ---------- getWebhook ---------- */

export async function getWebhook(tenantId: string, id: string): Promise<WebhookSummary | null> {
  return await pgGet<WebhookSummary>(
    `${SUMMARY_SELECT}
      WHERE w.id = $1 AND w.tenant_id = $2`,
    [id, tenantId],
  );
}

/* ---------- patchWebhook ---------- */

export async function patchWebhook(
  tenantId: string,
  id: string,
  body: PatchWebhookBody,
  userId: string,
): Promise<boolean> {
  if (body.status === ("disabled" as unknown as PatchWebhookBody["status"])) {
    throw new Error("status_disabled_not_allowed");
  }
  if (body.status !== undefined && body.status !== "active" && body.status !== "paused") {
    throw new Error("status_invalid");
  }

  let normalizedUrl: string | null = null;
  if (body.url !== undefined) {
    normalizedUrl = normalizeAndValidateUrl(body.url);
  }
  if (body.events !== undefined) {
    validateEvents(body.events);
  }

  const row = await pgGet<{ exists: boolean }>(
    `UPDATE ${pg("webhook")} SET
        url         = COALESCE($3, url),
        events      = COALESCE($4::varchar[], events),
        description = CASE WHEN $5::boolean THEN $6 ELSE description END,
        status      = COALESCE($7, status),
        paused_at   = CASE
                        WHEN $7 = 'paused' THEN now()
                        WHEN $7 = 'active' THEN NULL
                        ELSE paused_at
                      END,
        disabled_at = CASE WHEN $7 = 'active' THEN NULL ELSE disabled_at END,
        disabled_reason = CASE WHEN $7 = 'active' THEN NULL ELSE disabled_reason END
      WHERE id = $1 AND tenant_id = $2
      RETURNING true AS exists`,
    [
      id,
      tenantId,
      normalizedUrl,
      body.events ?? null,
      body.description !== undefined,
      body.description ?? null,
      body.status ?? null,
    ],
  );
  if (!row) return false;

  const changed: Record<string, unknown> = { webhook_id: id };
  if (normalizedUrl !== null) changed.url = normalizedUrl;
  if (body.events !== undefined) changed.events = body.events;
  if (body.description !== undefined) changed.description = body.description;
  if (body.status !== undefined) changed.status = body.status;

  await appendAuditAs(userId, "Updated webhook", normalizedUrl ?? id, {
    tenantId,
    metadata: changed,
  });
  return true;
}

/* ---------- deleteWebhook ---------- */

export async function deleteWebhook(
  tenantId: string,
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await pgTx(async (tx) => {
    const wh = await tx.get<{ url: string }>(
      `SELECT url FROM ${pg("webhook")} WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (!wh) return null;

    await tx.run(
      `UPDATE ${pg("webhook_delivery")}
          SET status = 'dlq',
              last_error = 'webhook_deleted',
              completed_at = now()
        WHERE webhook_id = $1
          AND tenant_id = $2
          AND status IN ('pending', 'in_flight', 'retry')`,
      [id, tenantId],
    );
    await tx.run(`DELETE FROM ${pg("webhook")} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    return wh;
  });
  if (!result) return false;

  await appendAuditAs(userId, "Deleted webhook", result.url, {
    tenantId,
    metadata: { webhook_id: id, url: result.url },
  });
  return true;
}

/* ---------- rotateSecret ---------- */

export async function rotateSecret(input: RotateSecretInput): Promise<RotateSecretResult> {
  const existing = await pgGet<{ url: string }>(
    `SELECT url FROM ${pg("webhook")} WHERE id = $1 AND tenant_id = $2`,
    [input.id, input.tenantId],
  );
  if (!existing) throw new Error("webhook_not_found");

  const value = generateWebhookSecret();
  const enc = encryptWebhookSecret(value);

  const row = await pgGet<{ secret_previous_expires_at: string }>(
    `UPDATE ${pg("webhook")} SET
        secret_ciphertext_previous = secret_ciphertext,
        secret_nonce_previous      = secret_nonce,
        secret_prefix_previous     = secret_prefix,
        secret_previous_expires_at = now() + interval '24 hours',
        secret_ciphertext  = $3::bytea,
        secret_nonce       = $4::bytea,
        secret_key_version = $5,
        secret_prefix      = $6
      WHERE id = $1 AND tenant_id = $2
      RETURNING secret_previous_expires_at::text AS secret_previous_expires_at`,
    [
      input.id,
      input.tenantId,
      Buffer.from(enc.ciphertext),
      Buffer.from(enc.nonce),
      enc.keyVersion,
      enc.prefix,
    ],
  );
  if (!row) throw new Error("webhook_not_found");

  await appendAuditAs(input.userId, "Rotated webhook secret", existing.url, {
    tenantId: input.tenantId,
    metadata: { webhook_id: input.id },
  });

  return { value, previousExpiresAt: row.secret_previous_expires_at };
}

/* ---------- pauseWebhook ---------- */

export async function pauseWebhook(tenantId: string, id: string, userId: string): Promise<boolean> {
  const row = await pgGet<{ url: string }>(
    `UPDATE ${pg("webhook")}
        SET status = 'paused',
            paused_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status = 'active'
      RETURNING url`,
    [id, tenantId],
  );
  if (!row) return false;
  await appendAuditAs(userId, "Paused webhook", row.url, {
    tenantId,
    metadata: { webhook_id: id },
  });
  return true;
}

/* ---------- reactivateWebhook ---------- */

export async function reactivateWebhook(
  tenantId: string,
  id: string,
  userId: string,
): Promise<boolean> {
  const row = await pgGet<{ url: string }>(
    `UPDATE ${pg("webhook")}
        SET status = 'active',
            paused_at = NULL,
            disabled_at = NULL,
            disabled_reason = NULL
      WHERE id = $1 AND tenant_id = $2 AND status IN ('paused', 'disabled')
      RETURNING url`,
    [id, tenantId],
  );
  if (!row) return false;
  await appendAuditAs(userId, "Reactivated webhook", row.url, {
    tenantId,
    metadata: { webhook_id: id },
  });
  return true;
}
