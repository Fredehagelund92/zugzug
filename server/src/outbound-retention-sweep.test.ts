import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { pgRun, pgGet } from "./pg.ts";
import { outboundRetentionSweepJob } from "./outbound-retention-sweep.ts";
import type { JobContext } from "./scheduler.ts";

const TENANT_PREFIX = "test_sweep_";

async function seedTenant(t: string): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'Sweep', 'default', now()) ON CONFLICT DO NOTHING`,
    [t],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."preferences"
       (publish_threshold, suggest_threshold, updated_at, tenant_id)
     VALUES (90, 70, now(), $1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_outbound_sweep_at = NULL`,
    [t],
  );
}

async function seedEvent(tenantId: string, daysAgo: number, suffix: string): Promise<string> {
  const id = `evt_${tenantId}_${suffix}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."outbound_event"
       (id, tenant_id, type, dim_id, occurred_at, payload, idem_key)
     VALUES ($1, $2, 'dimension.committed', 'd_x',
             now() - ($3 || ' days')::interval,
             '{}'::jsonb, $4)`,
    [id, tenantId, String(daysAgo), `idem_${tenantId}_${suffix}`],
  );
  return id;
}

async function seedDelivery(tenantId: string, daysAgo: number, suffix: string): Promise<string> {
  const id = `del_${tenantId}_${suffix}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."webhook_delivery"
       (id, tenant_id, webhook_id, event_id, event_type, delivery_url,
        signing_kid, status, payload, signature, created_at)
     VALUES ($1, $2, 'wh_x', 'evt_x', 'dimension.committed', 'https://example.test/h',
             'current', 'success', '{}'::jsonb, 'sig',
             now() - ($3 || ' days')::interval)`,
    [id, tenantId, String(daysAgo)],
  );
  return id;
}

async function seedWebhookWithExpiredPrev(tenantId: string): Promise<string> {
  const id = `wh_sweep_${tenantId}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."webhook"
       (id, tenant_id, url,
        secret_ciphertext, secret_nonce, secret_key_version, secret_prefix,
        secret_ciphertext_previous, secret_nonce_previous, secret_prefix_previous,
        secret_previous_expires_at,
        events, status, description, created_at, created_by)
     VALUES ($1, $2, 'https://example.test/h',
             E'\\\\x00'::bytea, E'\\\\x00'::bytea, 1, 'whsec_curr',
             E'\\\\x01'::bytea, E'\\\\x01'::bytea, 'whsec_prev',
             now() - interval '1 hour',
             ARRAY['dimension.committed']::varchar[], 'active', NULL, now(), 'u_system')`,
    [id, tenantId],
  );
  return id;
}

function ctxFor(tenantId: string): JobContext {
  return { tenantId, signal: new AbortController().signal, repo: {} as never };
}

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ('u_system', 'System', 'sys@example.test', 'SY', false)
     ON CONFLICT DO NOTHING`,
  );
});

async function cleanup(): Promise<void> {
  await pgRun(
    `DELETE FROM "zugzug_app"."webhook_delivery" WHERE tenant_id LIKE 'test_sweep_%'`,
  ).catch(() => {});
  await pgRun(
    `DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id LIKE 'test_sweep_%'`,
  ).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."webhook" WHERE tenant_id LIKE 'test_sweep_%'`).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id LIKE 'test_sweep_%'`).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id LIKE 'test_sweep_%'`).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id LIKE 'test_sweep_%'`).catch(() => {});
}

beforeEach(cleanup);
afterAll(cleanup);

describe("outboundRetentionSweepJob", () => {
  it("deletes outbound_event rows older than 30 days, keeps fresh ones", async () => {
    const t = `${TENANT_PREFIX}evt`;
    await seedTenant(t);
    const oldId = await seedEvent(t, 31, "old");
    const freshId = await seedEvent(t, 1, "fresh");

    await outboundRetentionSweepJob.run(ctxFor(t));

    const oldRow = await pgGet(`SELECT id FROM "zugzug_app"."outbound_event" WHERE id = $1`, [
      oldId,
    ]);
    const freshRow = await pgGet(`SELECT id FROM "zugzug_app"."outbound_event" WHERE id = $1`, [
      freshId,
    ]);
    expect(oldRow).toBeNull();
    expect(freshRow).not.toBeNull();
  });

  it("deletes webhook_delivery rows older than 30 days, keeps fresh ones", async () => {
    const t = `${TENANT_PREFIX}del`;
    await seedTenant(t);
    const oldId = await seedDelivery(t, 31, "old");
    const freshId = await seedDelivery(t, 1, "fresh");

    await outboundRetentionSweepJob.run(ctxFor(t));

    const oldRow = await pgGet(`SELECT id FROM "zugzug_app"."webhook_delivery" WHERE id = $1`, [
      oldId,
    ]);
    const freshRow = await pgGet(`SELECT id FROM "zugzug_app"."webhook_delivery" WHERE id = $1`, [
      freshId,
    ]);
    expect(oldRow).toBeNull();
    expect(freshRow).not.toBeNull();
  });

  it("clears expired previous secret blobs", async () => {
    const t = `${TENANT_PREFIX}sec`;
    await seedTenant(t);
    const whId = await seedWebhookWithExpiredPrev(t);

    await outboundRetentionSweepJob.run(ctxFor(t));

    const row = await pgGet<{
      secret_ciphertext_previous: unknown;
      secret_nonce_previous: unknown;
      secret_prefix_previous: unknown;
      secret_previous_expires_at: unknown;
    }>(
      `SELECT secret_ciphertext_previous, secret_nonce_previous,
              secret_prefix_previous, secret_previous_expires_at
         FROM "zugzug_app"."webhook" WHERE id = $1`,
      [whId],
    );
    expect(row?.secret_ciphertext_previous).toBeNull();
    expect(row?.secret_nonce_previous).toBeNull();
    expect(row?.secret_prefix_previous).toBeNull();
    expect(row?.secret_previous_expires_at).toBeNull();
  });

  it("stamps preferences.last_outbound_sweep_at", async () => {
    const t = `${TENANT_PREFIX}stamp`;
    await seedTenant(t);

    const before = await pgGet<{ last_outbound_sweep_at: Date | null }>(
      `SELECT last_outbound_sweep_at FROM "zugzug_app"."preferences" WHERE tenant_id = $1`,
      [t],
    );
    expect(before?.last_outbound_sweep_at).toBeNull();

    await outboundRetentionSweepJob.run(ctxFor(t));

    const after = await pgGet<{ last_outbound_sweep_at: Date | null }>(
      `SELECT last_outbound_sweep_at FROM "zugzug_app"."preferences" WHERE tenant_id = $1`,
      [t],
    );
    expect(after?.last_outbound_sweep_at).not.toBeNull();
  });

  it("throttles within 6 hours and runs again after 7 hours", async () => {
    const t = `${TENANT_PREFIX}throttle`;
    await seedTenant(t);

    // First seed an old event and set last_sweep to 5 minutes ago -> should skip.
    const oldEvt = await seedEvent(t, 31, "throttled");
    await pgRun(
      `UPDATE "zugzug_app"."preferences"
          SET last_outbound_sweep_at = now() - interval '5 minutes'
        WHERE tenant_id = $1`,
      [t],
    );

    await outboundRetentionSweepJob.run(ctxFor(t));

    const stillThere = await pgGet(`SELECT id FROM "zugzug_app"."outbound_event" WHERE id = $1`, [
      oldEvt,
    ]);
    expect(stillThere).not.toBeNull();

    // Now set last_sweep to 7 hours ago -> should run.
    await pgRun(
      `UPDATE "zugzug_app"."preferences"
          SET last_outbound_sweep_at = now() - interval '7 hours'
        WHERE tenant_id = $1`,
      [t],
    );

    await outboundRetentionSweepJob.run(ctxFor(t));

    const goneNow = await pgGet(`SELECT id FROM "zugzug_app"."outbound_event" WHERE id = $1`, [
      oldEvt,
    ]);
    expect(goneNow).toBeNull();
  });
});
