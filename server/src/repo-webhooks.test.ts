import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "./pg.ts";
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  patchWebhook,
  deleteWebhook,
  rotateSecret,
  reactivateWebhook,
  pauseWebhook,
} from "./repo-webhooks.ts";
import { _setMasterKeyForTest } from "./webhook-secrets.ts";
import { generateMasterKeyB64 } from "./crypto-secret.ts";

const T = "test_repo_wh";
const U = "u_test_wh";

beforeAll(async () => {
  _setMasterKeyForTest(Buffer.from(generateMasterKeyB64(), "base64"));
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'Sweep', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'WH', 'w@example.test', 'W', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
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

describe("createWebhook", () => {
  it("returns id + plaintext value once; persists encrypted at rest", async () => {
    const r = await createWebhook({
      tenantId: T,
      url: "https://example.test/wh",
      events: ["table.published"],
      createdBy: U,
    });
    expect(r.id.startsWith("wh_")).toBe(true);
    expect(r.value.startsWith("whsec_")).toBe(true);

    const row = await pgGet<{
      status: string;
      secret_prefix: string;
      events: string[];
      secret_ciphertext: Buffer;
    }>(
      `SELECT status, secret_prefix, events, secret_ciphertext
         FROM "zugzug_app"."webhook" WHERE id = $1`,
      [r.id],
    );
    expect(row!.status).toBe("active");
    expect(row!.secret_prefix).toBe(r.value.slice(0, 12));
    expect(row!.events).toEqual(["table.published"]);
    // ciphertext bytea persisted, non-empty, NOT equal to plaintext bytes
    expect(row!.secret_ciphertext.length).toBeGreaterThan(0);
    expect(row!.secret_ciphertext.toString("utf8")).not.toBe(r.value);
  });

  it("rejects http:// (non-localhost) when not self-hosted", async () => {
    await expect(
      createWebhook({
        tenantId: T,
        url: "http://evil.test/x",
        events: ["table.published"],
        createdBy: U,
      }),
    ).rejects.toThrow(/https/);
  });

  it("rejects malformed URLs", async () => {
    await expect(
      createWebhook({
        tenantId: T,
        url: "not a url",
        events: ["table.published"],
        createdBy: U,
      }),
    ).rejects.toThrow(/invalid_url/);
  });

  it("rejects empty events", async () => {
    await expect(
      createWebhook({
        tenantId: T,
        url: "https://x.example.test/",
        events: [],
        createdBy: U,
      }),
    ).rejects.toThrow(/events_empty/);
  });

  it("rejects unknown event types", async () => {
    await expect(
      createWebhook({
        tenantId: T,
        url: "https://x.example.test/",
        events: ["nope.bad"],
        createdBy: U,
      }),
    ).rejects.toThrow(/events_unknown/);
  });

  it("normalizes URL (lowercase host)", async () => {
    const r = await createWebhook({
      tenantId: T,
      url: "https://API.example.test/PATH/",
      events: ["table.published"],
      createdBy: U,
    });
    const row = await pgGet<{ url: string }>(
      `SELECT url FROM "zugzug_app"."webhook" WHERE id = $1`,
      [r.id],
    );
    expect(row!.url).toContain("api.example.test");
  });

  it("writes an audit row", async () => {
    const before = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."audit_log"
        WHERE tenant_id = $1 AND action = 'Created webhook'`,
      [T],
    );
    await createWebhook({
      tenantId: T,
      url: "https://audit.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    const after = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."audit_log"
        WHERE tenant_id = $1 AND action = 'Created webhook'`,
      [T],
    );
    expect(after!.n).toBe(before!.n + 1);
  });
});

describe("listWebhooks + getWebhook", () => {
  it("listWebhooks returns rows for tenant, omits ciphertext", async () => {
    const created = await createWebhook({
      tenantId: T,
      url: "https://list.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    const list = await listWebhooks(T);
    const found = list.find((w) => w.id === created.id);
    expect(found).toBeDefined();
    expect(found!.secret_prefix).toBe(created.value.slice(0, 12));
    // No ciphertext-shaped property
    expect((found as unknown as { secret_ciphertext?: unknown }).secret_ciphertext).toBeUndefined();
    expect((found as unknown as { secretCiphertext?: unknown }).secretCiphertext).toBeUndefined();
  });

  it("listWebhooks is tenant-scoped (no cross-tenant leakage)", async () => {
    const tt = "test_repo_wh_oth";
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
       VALUES ($1, $1, 'Sweep', now()) ON CONFLICT DO NOTHING`,
      [tt],
    );
    const created = await createWebhook({
      tenantId: tt,
      url: "https://other.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    const list = await listWebhooks(T);
    expect(list.find((w) => w.id === created.id)).toBeUndefined();
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [tt]);
    await pgRun(`DELETE FROM "zugzug_app"."webhook" WHERE tenant_id = $1`, [tt]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [tt]);
  });

  it("getWebhook returns null for unknown id", async () => {
    const r = await getWebhook(T, "wh_nope");
    expect(r).toBeNull();
  });

  it("getWebhook returns the summary for a real id", async () => {
    const created = await createWebhook({
      tenantId: T,
      url: "https://get.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    const got = await getWebhook(T, created.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(created.id);
    expect(got!.status).toBe("active");
    expect(got!.events).toEqual(["table.published"]);
  });
});

describe("patchWebhook", () => {
  it("updates url, events, description", async () => {
    const r = await createWebhook({
      tenantId: T,
      url: "https://patch.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    const ok = await patchWebhook(
      T,
      r.id,
      {
        url: "https://patched.example.test/x",
        events: ["table.created", "record.deleted"],
        description: "updated",
      },
      U,
    );
    expect(ok).toBe(true);

    const after = await getWebhook(T, r.id);
    expect(after!.url).toContain("patched.example.test");
    expect(after!.events.sort()).toEqual(["record.deleted", "table.created"]);
    expect(after!.description).toBe("updated");
  });

  it("rejects status='disabled' via PATCH", async () => {
    const r = await createWebhook({
      tenantId: T,
      url: "https://noeasy.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    await expect(
      patchWebhook(T, r.id, { status: "disabled" as unknown as "active" }, U),
    ).rejects.toThrow(/status_disabled_not_allowed/);
  });

  it("returns false for unknown id", async () => {
    const ok = await patchWebhook(T, "wh_missing", { description: "x" }, U);
    expect(ok).toBe(false);
  });

  it("status=paused sets paused_at", async () => {
    const r = await createWebhook({
      tenantId: T,
      url: "https://patchpause.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    await patchWebhook(T, r.id, { status: "paused" }, U);
    const row = await pgGet<{ status: string; paused_at: Date | null }>(
      `SELECT status, paused_at FROM "zugzug_app"."webhook" WHERE id = $1`,
      [r.id],
    );
    expect(row!.status).toBe("paused");
    expect(row!.paused_at).not.toBeNull();
  });
});

describe("pauseWebhook + reactivateWebhook", () => {
  it("transitions active→paused→active", async () => {
    const r = await createWebhook({
      tenantId: T,
      url: "https://pause.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    expect(await pauseWebhook(T, r.id, U)).toBe(true);
    let row = await pgGet<{ status: string; paused_at: Date | null }>(
      `SELECT status, paused_at FROM "zugzug_app"."webhook" WHERE id = $1`,
      [r.id],
    );
    expect(row!.status).toBe("paused");
    expect(row!.paused_at).not.toBeNull();

    expect(await reactivateWebhook(T, r.id, U)).toBe(true);
    row = await pgGet<{ status: string; paused_at: Date | null }>(
      `SELECT status, paused_at FROM "zugzug_app"."webhook" WHERE id = $1`,
      [r.id],
    );
    expect(row!.status).toBe("active");
    expect(row!.paused_at).toBeNull();
  });

  it("pauseWebhook returns false when not active", async () => {
    const r = await createWebhook({
      tenantId: T,
      url: "https://pause2.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    await pauseWebhook(T, r.id, U);
    // second pause is a no-op
    expect(await pauseWebhook(T, r.id, U)).toBe(false);
  });

  it("reactivateWebhook works from disabled", async () => {
    const r = await createWebhook({
      tenantId: T,
      url: "https://reactdis.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    await pgRun(
      `UPDATE "zugzug_app"."webhook"
          SET status = 'disabled', disabled_at = now(), disabled_reason = 'test'
        WHERE id = $1`,
      [r.id],
    );
    expect(await reactivateWebhook(T, r.id, U)).toBe(true);
    const row = await pgGet<{ status: string; disabled_at: Date | null }>(
      `SELECT status, disabled_at FROM "zugzug_app"."webhook" WHERE id = $1`,
      [r.id],
    );
    expect(row!.status).toBe("active");
    expect(row!.disabled_at).toBeNull();
  });
});

describe("rotateSecret", () => {
  it("moves current to previous and emits a new current", async () => {
    const created = await createWebhook({
      tenantId: T,
      url: "https://rot.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    const result = await rotateSecret({ tenantId: T, id: created.id, userId: U });
    expect(result.value.startsWith("whsec_")).toBe(true);
    expect(result.value).not.toBe(created.value);
    expect(result.previousExpiresAt).toBeTruthy();

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

  it("throws webhook_not_found for unknown id", async () => {
    await expect(rotateSecret({ tenantId: T, id: "wh_missing", userId: U })).rejects.toThrow(
      /webhook_not_found/,
    );
  });
});

describe("deleteWebhook", () => {
  it("DELETEs the row + DLQs pending deliveries", async () => {
    const r = await createWebhook({
      tenantId: T,
      url: "https://del.example.test/",
      events: ["table.published"],
      createdBy: U,
    });
    await pgRun(
      `INSERT INTO "zugzug_app"."webhook_delivery"
         (id, tenant_id, webhook_id, event_id, event_type, delivery_url,
          signing_kid, status, payload, signature, created_at)
         VALUES ($1, $2, $3, 'evt_x', 'table.published',
                 'https://del.example.test/', 'current', 'pending',
                 '{}'::jsonb, '', now())`,
      [`whd_del_${crypto.randomUUID().replace(/-/g, "")}`, T, r.id],
    );
    expect(await deleteWebhook(T, r.id, U)).toBe(true);
    const left = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."webhook" WHERE id = $1`,
      [r.id],
    );
    expect(left!.n).toBe(0);
    const dlq = await pgGet<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM "zugzug_app"."webhook_delivery"
        WHERE webhook_id = $1 LIMIT 1`,
      [r.id],
    );
    expect(dlq!.status).toBe("dlq");
    expect(dlq!.last_error).toBe("webhook_deleted");
  });

  it("returns false for unknown id", async () => {
    const ok = await deleteWebhook(T, "wh_missing_del", U);
    expect(ok).toBe(false);
  });
});
