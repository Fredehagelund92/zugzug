/* repo-outbound-events.ts — dispatchOutbound writes an outbound_event row AND
   enqueues a webhook_delivery row for every active webhook that subscribes to
   the event's type. Called from inside an existing pgTx so the event-write is
   atomic with the record mutation that produced it (design §3.1). */

import type { TxHelpers } from "./pg.ts";
import { pg } from "./env.ts";

export interface DispatchInput {
  tenantId: string;
  type: "table.published" | "table.created" | "table.fields.updated" | "record.deleted";
  refTableId?: string | null;
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
       (id, tenant_id, type, reference_table_id, occurred_at, payload, idem_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      eventId,
      input.tenantId,
      input.type,
      input.refTableId ?? null,
      input.occurredAt,
      // Pass the object — postgres.js serializes it once. Pre-stringifying
      // here double-encoded payload as a jsonb *string*, which broke
      // payload->… queries (delivery worked only because the dispatcher
      // tolerates both shapes). Legacy rows remain strings; readers unwrap.
      input.payload,
      input.idemKey,
    ],
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
      [
        genDeliveryId(),
        input.tenantId,
        sub.id,
        eventId,
        input.type,
        sub.url,
        JSON.stringify(input.payload),
      ],
    );
  }
  return eventId;
}
