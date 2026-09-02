import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll, pgTx } from "./pg.ts";
import { dispatchOutbound } from "./repo-outbound-events.ts";
import { encryptSecret, generateMasterKeyB64 } from "./crypto-secret.ts";

const T = "test_disp_outbound";
const U = "u_test_dispatch";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'Sweep', now()) ON CONFLICT DO NOTHING`,
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
  await pgRun(`DELETE FROM "zugzug_app"."webhook_delivery" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."webhook" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
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
    const idemKey = `table.published:dim_t1:1`;
    await pgTx(async (tx) => {
      await dispatchOutbound(tx, {
        tenantId: T,
        type: "table.published",
        refTableId: "dim_t1",
        occurredAt: new Date(),
        payload: { dim_slug: "country", version: 1 },
        idemKey,
      });
    });

    const row = await pgGet<{
      type: string;
      reference_table_id: string | null;
      payload: string | Record<string, unknown>;
    }>(
      `SELECT type, reference_table_id, payload FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND idem_key = $2`,
      [T, idemKey],
    );
    expect(row).not.toBeNull();
    expect(row!.type).toBe("table.published");
    expect(row!.reference_table_id).toBe("dim_t1");
    const payload = typeof row!.payload === "string" ? JSON.parse(row!.payload) : row!.payload;
    expect((payload as { dim_slug: string }).dim_slug).toBe("country");
  });

  it("idem_key collision aborts the surrounding tx (per design §3.1)", async () => {
    const idemKey = `table.published:dim_t2:1`;
    await pgTx(async (tx) => {
      await dispatchOutbound(tx, {
        tenantId: T,
        type: "table.published",
        refTableId: "dim_t2",
        occurredAt: new Date(),
        payload: {},
        idemKey,
      });
    });

    let threw = false;
    try {
      await pgTx(async (tx) => {
        await dispatchOutbound(tx, {
          tenantId: T,
          type: "table.published",
          refTableId: "dim_t2",
          occurredAt: new Date(),
          payload: {},
          idemKey, // same key
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
    const wh1 = await seedWebhook(T, ["table.published"]);
    const wh2 = await seedWebhook(T, ["table.published", "record.deleted"]);
    const wh3 = await seedWebhook(T, ["record.deleted"]); // does NOT subscribe

    await pgTx(async (tx) => {
      await dispatchOutbound(tx, {
        tenantId: T,
        type: "table.published",
        refTableId: "dim_t3",
        occurredAt: new Date(),
        payload: { dim_slug: "country" },
        idemKey: `table.published:dim_t3:5`,
      });
    });

    const rows = await pgAll<{ webhook_id: string; status: string }>(
      `SELECT webhook_id, status FROM "zugzug_app"."webhook_delivery"
        WHERE tenant_id = $1 AND event_type = 'table.published'`,
      [T],
    );
    const ids = rows.map((r) => r.webhook_id).sort();
    expect(ids).toContain(wh1);
    expect(ids).toContain(wh2);
    expect(ids).not.toContain(wh3);
    for (const r of rows) expect(r.status).toBe("pending");
  });

  // Pause queues, it does not drop: enqueue no longer skips paused webhooks —
  // the dispatcher's claim() is what holds the backlog back, and it is released
  // on resume. A disabled endpoint is still skipped so a dead URL cannot
  // accumulate a backlog forever.
  it("enqueues for a paused webhook but not for a disabled one", async () => {
    const wh_paused = await seedWebhook(T, ["table.published"], "paused");
    const wh_disabled = await seedWebhook(T, ["table.published"], "disabled");

    await pgTx(async (tx) => {
      await dispatchOutbound(tx, {
        tenantId: T,
        type: "table.published",
        refTableId: "dim_t4",
        occurredAt: new Date(),
        payload: {},
        idemKey: `table.published:dim_t4:1`,
      });
    });

    const left = await pgAll<{ webhook_id: string; status: string }>(
      `SELECT webhook_id, status FROM "zugzug_app"."webhook_delivery"
        WHERE tenant_id = $1 AND webhook_id IN ($2, $3)`,
      [T, wh_paused, wh_disabled],
    );
    expect(left.map((r) => r.webhook_id)).toEqual([wh_paused]);
    expect(left[0]!.status).toBe("pending");
  });
});
