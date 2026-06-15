process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { pgRun, pgGet } from "./pg.ts";
import { _setMasterKeyForTest } from "./webhook-secrets.ts";
import { encryptSecret, generateMasterKeyB64 } from "./crypto-secret.ts";
import { parseSignatureHeader } from "./webhook-signing.ts";
import { addDimension, addCanonicalOne } from "./repo-canonical.ts";
import { saveDraft, commit } from "./repo-drafts.ts";
import { webhookDispatcherJob } from "./webhook-dispatcher.ts";
import type { JobContext } from "./scheduler.ts";
import { registerFactories } from "./warehouse/credentials.ts";
import { createDuckDbAdapter } from "./warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "./warehouse/snowflake/index.ts";

registerFactories({
  duckdb: async (creds) => createDuckDbAdapter(creds),
  snowflake: async (creds) => new SnowflakeAdapter(creds),
});

const T = "test_wh_e2e";
const U = "u_test_e2e";

let server: ReturnType<typeof Bun.serve> | null = null;
let receivedRequests: { body: string; headers: Record<string, string> }[] = [];
let masterKeyB64: string;
let webhookSecret: string;

beforeAll(async () => {
  masterKeyB64 = generateMasterKeyB64();
  const masterKey = Buffer.from(masterKeyB64, "base64");
  _setMasterKeyForTest(masterKey);

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      receivedRequests.push({ body, headers });
      return new Response("ok", { status: 200 });
    },
  });

  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'E2E', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'E2E Tester', 'e2e@example.test', 'ET', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );

  webhookSecret = `whsec_${randomBytes(32).toString("base64url")}`;
  const enc = encryptSecret(webhookSecret, masterKey, 1);
  await pgRun(
    `INSERT INTO "zugzug_app"."webhook"
       (id, tenant_id, url, secret_ciphertext, secret_nonce, secret_key_version,
        secret_prefix, events, status, created_at, created_by)
     VALUES ('wh_e2e_test', $1, $2, $3::bytea, $4::bytea, 1, $5,
             ARRAY['dimension.committed']::varchar[], 'active', now(), $6)
     ON CONFLICT (id) DO UPDATE SET
       url = EXCLUDED.url,
       secret_ciphertext = EXCLUDED.secret_ciphertext,
       secret_nonce = EXCLUDED.secret_nonce,
       secret_prefix = EXCLUDED.secret_prefix`,
    [
      T,
      `http://localhost:${server.port}/wh`,
      Buffer.from(enc.ciphertext),
      Buffer.from(enc.nonce),
      webhookSecret.slice(0, 12),
      U,
    ],
  );
});

afterAll(async () => {
  if (server) server.stop();
  await pgRun(`DELETE FROM "zugzug_app"."webhook_delivery" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."webhook" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("Webhook E2E — commit → dispatchOutbound → dispatcher → POST → signature", () => {
  it("delivers signed payload to subscriber", async () => {
    receivedRequests = [];

    const dimId = await addDimension("E2EDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Alpha", undefined, U, T);
    await saveDraft(dimId, "alpha v", "mapped", "Alpha", "alpha", U, T);
    const result = await commit(dimId, U, T);
    expect(result.committed).toBeGreaterThan(0);

    await webhookDispatcherJob.run({ tenantId: "*" } as JobContext);

    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests.length).toBeGreaterThanOrEqual(1);
    const req = receivedRequests[0]!;

    const sigHeader = req.headers["x-zugzug-signature"];
    expect(sigHeader).toBeDefined();
    const parts = parseSignatureHeader(sigHeader!);
    expect(parts).not.toBeNull();
    const expected = createHmac("sha256", webhookSecret)
      .update(`${parts!.t}.${req.body}`)
      .digest("hex");
    expect(parts!.v1).toBe(expected);

    const deliv = await pgGet<{ status: string; last_response_code: number }>(
      `SELECT status, last_response_code FROM "zugzug_app"."webhook_delivery"
        WHERE tenant_id = $1 AND webhook_id = 'wh_e2e_test'
        ORDER BY created_at DESC LIMIT 1`,
      [T],
    );
    expect(deliv!.status).toBe("success");
    expect(deliv!.last_response_code).toBe(200);
  }, 30_000);
});
