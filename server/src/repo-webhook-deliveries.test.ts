process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN || "test-stub";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-stub";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "./pg.ts";
import {
  listDeliveries,
  getDelivery,
  sendTestEvent,
  replayDelivery,
} from "./repo-webhook-deliveries.ts";
import { createWebhook } from "./repo-webhooks.ts";
import { _setMasterKeyForTest } from "./webhook-secrets.ts";
import { generateMasterKeyB64 } from "./crypto-secret.ts";

const T = "test_repo_whd";
const U = "u_test_whd";

let webhookId: string;

async function seedDelivery(
  tenantId: string,
  whId: string,
  opts: {
    signing_kid?: "current" | "previous";
    status?: string;
    is_test?: boolean;
    payload?: unknown;
    signature?: string;
    last_response_body?: string | null;
  } = {},
): Promise<{ id: string; delivery_url: string }> {
  const id = `whd_${crypto.randomUUID().replace(/-/g, "")}`;
  const evId = `ev_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const url = "https://example.test/wh";
  const payload = JSON.stringify(opts.payload ?? { hello: "world" });
  await pgRun(
    `INSERT INTO "zugzug_app"."webhook_delivery"
       (id, tenant_id, webhook_id, event_id, event_type, delivery_url,
        signing_kid, is_test, status, attempts, max_attempts,
        next_attempt_at, payload, signature, last_response_body, created_at)
     VALUES ($1, $2, $3, $4, 'dimension.committed', $5,
             $6, $7, $8, 0, 5,
             now(), $9::jsonb, $10, $11, now())`,
    [
      id,
      tenantId,
      whId,
      evId,
      url,
      opts.signing_kid ?? "current",
      opts.is_test ?? false,
      opts.status ?? "pending",
      payload,
      opts.signature ?? "t=1,kid=current,v1=sha256=deadbeef",
      opts.last_response_body ?? null,
    ],
  );
  return { id, delivery_url: url };
}

beforeAll(async () => {
  _setMasterKeyForTest(Buffer.from(generateMasterKeyB64(), "base64"));
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'WHD Repo', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'WHD', 'whd@example.test', 'WD', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
  const wh = await createWebhook({
    tenantId: T,
    url: "https://example.test/wh",
    events: ["dimension.committed"],
    createdBy: U,
  });
  webhookId = wh.id;
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."webhook_delivery" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."webhook" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("listDeliveries", () => {
  it("returns deliveries newest-first; admin sees payload/signature", async () => {
    await seedDelivery(T, webhookId, { status: "success" });
    const out = await listDeliveries(T, webhookId, { role: "admin" });
    expect(out.deliveries.length).toBeGreaterThan(0);
    const d = out.deliveries[0]!;
    expect(d.payload).not.toBeNull();
    expect(d.signature).not.toBeNull();
  });

  it("masks payload, signature, last_response_body for viewers", async () => {
    await seedDelivery(T, webhookId, {
      last_response_body: "server response body",
    });
    const out = await listDeliveries(T, webhookId, { role: "viewer" });
    for (const d of out.deliveries) {
      expect(d.payload).toBeNull();
      expect(d.signature).toBeNull();
      expect(d.last_response_body).toBeNull();
    }
  });

  it("filters by status", async () => {
    await seedDelivery(T, webhookId, { status: "dlq" });
    const out = await listDeliveries(T, webhookId, { status: "dlq", role: "admin" });
    expect(out.deliveries.length).toBeGreaterThan(0);
    expect(out.deliveries.every((d) => d.status === "dlq")).toBe(true);
  });
});

describe("getDelivery", () => {
  it("returns the single row for admins", async () => {
    const seed = await seedDelivery(T, webhookId);
    const out = await getDelivery(T, seed.id, "admin");
    expect(out).not.toBeNull();
    expect(out!.id).toBe(seed.id);
    expect(out!.payload).not.toBeNull();
  });

  it("returns null for unknown id", async () => {
    const out = await getDelivery(T, "whd_nope", "admin");
    expect(out).toBeNull();
  });

  it("masks fields for viewer role", async () => {
    const seed = await seedDelivery(T, webhookId, {
      last_response_body: "viewer-should-not-see",
    });
    const out = await getDelivery(T, seed.id, "viewer");
    expect(out!.payload).toBeNull();
    expect(out!.signature).toBeNull();
    expect(out!.last_response_body).toBeNull();
  });
});

describe("sendTestEvent", () => {
  it("inserts a pending is_test=true row with event_type='webhook.test'", async () => {
    const out = await sendTestEvent(T, webhookId, U);
    expect(out).not.toBeNull();
    const row = await pgGet<{
      status: string;
      is_test: boolean;
      event_type: string;
      payload: unknown;
      attempts: number;
    }>(
      `SELECT status, is_test, event_type, payload, attempts
         FROM "zugzug_app"."webhook_delivery" WHERE id = $1`,
      [out!.delivery_id],
    );
    expect(row!.status).toBe("pending");
    expect(row!.is_test).toBe(true);
    expect(row!.event_type).toBe("webhook.test");
    expect(row!.attempts).toBe(0);
    const payload =
      typeof row!.payload === "string"
        ? (JSON.parse(row!.payload) as { message: string; dim_slug: string | null })
        : (row!.payload as { message: string; dim_slug: string | null });
    expect(payload.message).toContain("test event");
    expect(payload.dim_slug).toBeNull();
  });

  it("returns null when webhook does not exist", async () => {
    const out = await sendTestEvent(T, "wh_nope", U);
    expect(out).toBeNull();
  });
});

describe("replayDelivery", () => {
  it("clones row with attempts=0, status='pending', preserves delivery_url and new id", async () => {
    const original = await seedDelivery(T, webhookId, { signing_kid: "current" });
    const replay = await replayDelivery(T, original.id, U);
    expect(replay).not.toBeNull();
    expect(replay!.id).not.toBe(original.id);
    const row = await pgGet<{
      status: string;
      attempts: number;
      signing_kid: string;
      delivery_url: string;
    }>(
      `SELECT status, attempts, signing_kid, delivery_url
         FROM "zugzug_app"."webhook_delivery" WHERE id = $1`,
      [replay!.id],
    );
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.signing_kid).toBe("current");
    expect(row!.delivery_url).toBe(original.delivery_url);
  });

  it("re-signs with kid='current' when original was 'previous' AND grace expired", async () => {
    await pgRun(
      `UPDATE "zugzug_app"."webhook"
          SET secret_previous_expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [webhookId],
    );
    const original = await seedDelivery(T, webhookId, { signing_kid: "previous" });
    const replay = await replayDelivery(T, original.id, U);
    const row = await pgGet<{ signing_kid: string }>(
      `SELECT signing_kid FROM "zugzug_app"."webhook_delivery" WHERE id = $1`,
      [replay!.id],
    );
    expect(row!.signing_kid).toBe("current");
  });

  it("preserves kid='previous' when grace is still valid", async () => {
    await pgRun(
      `UPDATE "zugzug_app"."webhook"
          SET secret_previous_expires_at = now() + interval '1 hour'
        WHERE id = $1`,
      [webhookId],
    );
    const original = await seedDelivery(T, webhookId, { signing_kid: "previous" });
    const replay = await replayDelivery(T, original.id, U);
    const row = await pgGet<{ signing_kid: string }>(
      `SELECT signing_kid FROM "zugzug_app"."webhook_delivery" WHERE id = $1`,
      [replay!.id],
    );
    expect(row!.signing_kid).toBe("previous");
  });

  it("returns null when delivery does not exist", async () => {
    const out = await replayDelivery(T, "whd_nope", U);
    expect(out).toBeNull();
  });
});
