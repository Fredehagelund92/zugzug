import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import { webhookDispatcherJob } from "./webhook-dispatcher.ts";
import { _setMasterKeyForTest } from "./webhook-secrets.ts";
import { encryptSecret, generateMasterKeyB64 } from "./crypto-secret.ts";
import type { JobContext } from "./scheduler.ts";

const U = "u_test_disp";

let server: ReturnType<typeof Bun.serve>;
let port: number;
let handler: (req: Request) => Promise<Response> | Response = () => new Response("ok");
const masterKey = Buffer.from(generateMasterKeyB64(), "base64");

beforeAll(async () => {
  _setMasterKeyForTest(masterKey);
  server = Bun.serve({
    port: 0,
    fetch: (req) => handler(req),
  });
  port = server.port!;
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'D', 'd@example.test', 'D', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ('u_system', 'System', 'sys@example.test', 'SY', false)
     ON CONFLICT DO NOTHING`,
  );
});

afterAll(async () => {
  server.stop(true);
  // Clean test tenants we created (prefix test_disp_)
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id LIKE 'test_disp_%'`).catch(
    () => {},
  );
  await pgRun(
    `DELETE FROM "zugzug_app"."webhook_delivery" WHERE tenant_id LIKE 'test_disp_%'`,
  ).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."webhook" WHERE tenant_id LIKE 'test_disp_%'`).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id LIKE 'test_disp_%'`).catch(() => {});
});

beforeEach(() => {
  handler = () => new Response("ok");
});

const ctx = {} as JobContext;

async function seedTenant(t: string): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'Sweep', now()) ON CONFLICT DO NOTHING`,
    [t],
  );
}

async function seedWebhook(
  tenantId: string,
  opts: { plaintext?: string } = {},
): Promise<{ id: string; plaintext: string }> {
  const plaintext = opts.plaintext ?? "whsec_dispatcher_test_plain_secret_x";
  const enc = encryptSecret(plaintext, masterKey, 1);
  const id = `wh_disp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."webhook"
       (id, tenant_id, url,
        secret_ciphertext, secret_nonce, secret_key_version, secret_prefix,
        events, status, description, created_at, created_by)
     VALUES ($1, $2, $3,
             $4::bytea, $5::bytea, $6, $7,
             $8::varchar[], 'active', NULL, now(), $9)`,
    [
      id,
      tenantId,
      `http://localhost:${port}/wh`,
      Buffer.from(enc.ciphertext),
      Buffer.from(enc.nonce),
      enc.keyVersion,
      plaintext.slice(0, 12),
      ["dimension.committed"],
      U,
    ],
  );
  return { id, plaintext };
}

interface DeliverySeed {
  tenantId: string;
  webhookId: string;
  status?: "pending" | "in_flight" | "retry" | "dlq" | "success";
  attempts?: number;
  isTest?: boolean;
  signingKid?: "current" | "previous";
  nextAttemptAt?: "now" | "past" | "future" | null;
  lastAttemptAt?: "now" | "past_60s" | null;
  createdAtOffsetSec?: number;
}

async function seedDelivery(s: DeliverySeed): Promise<string> {
  const id = `wd_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const status = s.status ?? "pending";
  const attempts = s.attempts ?? 0;
  const next =
    s.nextAttemptAt === "past"
      ? "now() - interval '1 second'"
      : s.nextAttemptAt === "future"
        ? "now() + interval '1 hour'"
        : s.nextAttemptAt === "now"
          ? "now()"
          : "NULL";
  const lastAttempt =
    s.lastAttemptAt === "now"
      ? "now()"
      : s.lastAttemptAt === "past_60s"
        ? "now() - interval '60 seconds'"
        : "NULL";
  const createdAt =
    s.createdAtOffsetSec !== undefined
      ? `now() - (${s.createdAtOffsetSec} || ' seconds')::interval`
      : "now()";
  await pgRun(
    `INSERT INTO "zugzug_app"."webhook_delivery"
       (id, tenant_id, webhook_id, event_id, event_type, delivery_url,
        signing_kid, is_test, status, attempts, max_attempts,
        next_attempt_at, last_attempt_at, payload, signature, created_at)
     VALUES ($1, $2, $3, $4, 'dimension.committed', $5,
             $6, $7, $8, $9, 5,
             ${next}, ${lastAttempt}, '{"hello":"world"}'::jsonb, '', ${createdAt})`,
    [
      id,
      s.tenantId,
      s.webhookId,
      `ev_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      `http://localhost:${port}/wh`,
      s.signingKid ?? "current",
      s.isTest ?? false,
      status,
      attempts,
    ],
  );
  return id;
}

async function getRow(id: string): Promise<{
  status: string;
  attempts: number;
  last_response_code: number | null;
  last_error: string | null;
  next_attempt_secs: number | null;
  signature: string;
}> {
  const row = await pgGet<{
    status: string;
    attempts: number;
    last_response_code: number | null;
    last_error: string | null;
    next_attempt_secs: number | null;
    signature: string;
  }>(
    `SELECT status, attempts, last_response_code, last_error, signature,
            CASE WHEN next_attempt_at IS NULL THEN NULL
                 ELSE EXTRACT(EPOCH FROM (next_attempt_at - now()))::int
            END AS next_attempt_secs
       FROM "zugzug_app"."webhook_delivery" WHERE id = $1`,
    [id],
  );
  if (!row) throw new Error(`row missing: ${id}`);
  return row;
}

describe("webhookDispatcherJob", () => {
  it("delivers a pending row when the endpoint returns 200", async () => {
    const T = "test_disp_ok";
    await seedTenant(T);
    const wh = await seedWebhook(T);
    let received: { headers: Headers; body: string } | null = null;
    handler = async (req) => {
      received = { headers: req.headers, body: await req.text() };
      return new Response("ok", { status: 200 });
    };
    const id = await seedDelivery({
      tenantId: T,
      webhookId: wh.id,
      nextAttemptAt: "past",
    });
    await webhookDispatcherJob.run(ctx);

    const row = await getRow(id);
    expect(row.status).toBe("success");
    expect(row.attempts).toBe(1);
    expect(row.last_response_code).toBe(200);
    expect(received).not.toBeNull();
    const r = received as unknown as { headers: Headers; body: string };
    expect(r.headers.get("x-zugzug-event")).toBe("dimension.committed");
    expect(r.body).toBe('{"hello":"world"}');
  });

  it("schedules a retry on 500 with ~5s delay", async () => {
    const T = "test_disp_500";
    await seedTenant(T);
    const wh = await seedWebhook(T);
    handler = () => new Response("boom", { status: 500 });
    const id = await seedDelivery({
      tenantId: T,
      webhookId: wh.id,
      nextAttemptAt: "past",
    });
    await webhookDispatcherJob.run(ctx);

    const row = await getRow(id);
    expect(row.status).toBe("retry");
    expect(row.attempts).toBe(1);
    expect(row.last_response_code).toBe(500);
    expect(row.last_error).toBe("http_500");
    expect(row.next_attempt_secs).toBeGreaterThanOrEqual(3);
    expect(row.next_attempt_secs).toBeLessThanOrEqual(7);
  });

  it("schedules a retry when fetch times out", async () => {
    const T = "test_disp_timeout";
    await seedTenant(T);
    const wh = await seedWebhook(T);
    handler = async () => {
      await new Promise((r) => setTimeout(r, 12_000));
      return new Response("late");
    };
    const id = await seedDelivery({
      tenantId: T,
      webhookId: wh.id,
      nextAttemptAt: "past",
    });
    await webhookDispatcherJob.run(ctx);

    const row = await getRow(id);
    expect(row.status).toBe("retry");
    expect(row.attempts).toBe(1);
    expect((row.last_error ?? "").toLowerCase()).toMatch(/abort|timeout|timed/);
  }, 15_000);

  it("moves to dlq after the 5th attempt fails", async () => {
    const T = "test_disp_dlq";
    await seedTenant(T);
    const wh = await seedWebhook(T);
    handler = () => new Response("nope", { status: 500 });
    // attempts=4 → claim increments to 5; max_attempts=5 → fails → dlq.
    const id = await seedDelivery({
      tenantId: T,
      webhookId: wh.id,
      attempts: 4,
      status: "retry",
      nextAttemptAt: "past",
    });
    await webhookDispatcherJob.run(ctx);

    const row = await getRow(id);
    expect(row.status).toBe("dlq");
    expect(row.attempts).toBe(5);
    expect(row.last_response_code).toBe(500);
  });

  it("auto-disables a webhook with 50 consecutive non-test dlq deliveries", async () => {
    const T = "test_disp_autodis";
    await seedTenant(T);
    const wh = await seedWebhook(T);
    handler = () => new Response("nope", { status: 500 });
    // Seed 49 historical dlq rows with descending created_at.
    for (let i = 0; i < 49; i++) {
      await seedDelivery({
        tenantId: T,
        webhookId: wh.id,
        status: "dlq",
        attempts: 5,
        createdAtOffsetSec: 1000 - i, // older than the pending one below
      });
    }
    // One pending that will dlq this tick.
    const id = await seedDelivery({
      tenantId: T,
      webhookId: wh.id,
      attempts: 4,
      status: "retry",
      nextAttemptAt: "past",
    });
    await webhookDispatcherJob.run(ctx);

    const row = await getRow(id);
    expect(row.status).toBe("dlq");

    const wRow = await pgGet<{ status: string; disabled_reason: string | null }>(
      `SELECT status, disabled_reason FROM "zugzug_app"."webhook" WHERE id = $1`,
      [wh.id],
    );
    expect(wRow!.status).toBe("disabled");
    expect(wRow!.disabled_reason).toBe("auto_disabled_50_consecutive_dlq");

    const audits = await pgAll<{ action: string }>(
      `SELECT action FROM "zugzug_app"."audit_log"
        WHERE tenant_id = $1 AND action = 'Webhook auto-disabled'`,
      [T],
    );
    expect(audits.length).toBe(1);
  });

  it("does NOT count test deliveries toward auto-disable", async () => {
    const T = "test_disp_skiptest";
    await seedTenant(T);
    const wh = await seedWebhook(T);
    handler = () => new Response("nope", { status: 500 });
    // 49 historical non-test dlq.
    for (let i = 0; i < 49; i++) {
      await seedDelivery({
        tenantId: T,
        webhookId: wh.id,
        status: "dlq",
        attempts: 5,
        createdAtOffsetSec: 1000 - i,
      });
    }
    // The pending one is a TEST delivery → should not push count to 50 of non-test.
    const id = await seedDelivery({
      tenantId: T,
      webhookId: wh.id,
      attempts: 4,
      status: "retry",
      isTest: true,
      nextAttemptAt: "past",
    });
    await webhookDispatcherJob.run(ctx);

    const row = await getRow(id);
    expect(row.status).toBe("dlq");

    const wRow = await pgGet<{ status: string }>(
      `SELECT status FROM "zugzug_app"."webhook" WHERE id = $1`,
      [wh.id],
    );
    // Only 49 non-test dlq → no auto-disable.
    expect(wRow!.status).toBe("active");
  });

  it("reaps stuck in_flight rows older than 30s", async () => {
    const T = "test_disp_reap";
    await seedTenant(T);
    const wh = await seedWebhook(T);
    handler = () => new Response("ok");
    const id = await seedDelivery({
      tenantId: T,
      webhookId: wh.id,
      status: "in_flight",
      attempts: 1,
      lastAttemptAt: "past_60s",
      nextAttemptAt: null,
    });
    await webhookDispatcherJob.run(ctx);

    // After reap, the row should be retry then claimed and delivered (200) → success.
    const row = await getRow(id);
    expect(["success", "retry"]).toContain(row.status);
    // Most importantly: the row is NOT stuck in_flight anymore.
    expect(row.status).not.toBe("in_flight");
  });
});
