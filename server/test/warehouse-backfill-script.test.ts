process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.MOTHERDUCK_TOKEN = "md_test_token_xyz";
process.env.WAREHOUSE_DB = "analytics";
process.env.ATTACH_WAREHOUSE = "false";
process.env.WAREHOUSE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd=";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { pgRun, pgGet, pgAll } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { decryptCredentials } from "../src/warehouse/crypto.ts";
import { runWarehouseBackfill } from "../scripts/warehouse-backfill.ts";

const TENANT = `tbackfill_${process.pid}`;

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [TENANT]);
}
beforeEach(cleanup);

async function seedPendingConnection(): Promise<{ wcId: string; tenantId: string }> {
  await provisionTenant({ id: TENANT, label: "Backfill A" });
  const wcId = `wc_${"a".repeat(32)}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_connection"
       (id, tenant_id, adapter, label, credentials_encrypted, credentials_hash, credentials_version, created_at, created_by)
     VALUES ($1, $2, 'motherduck', 'p', '__PENDING__', '__PENDING__', 1, now(), 'u_seed')`,
    [wcId, TENANT],
  );
  return { wcId, tenantId: TENANT };
}

test("populates __PENDING__ rows with encrypted env credentials", async () => {
  const { wcId, tenantId } = await seedPendingConnection();
  const { env } = await import("../src/env.ts");
  await runWarehouseBackfill();
  const row = await pgGet<{ credentials_encrypted: string; credentials_hash: string }>(
    `SELECT credentials_encrypted, credentials_hash
       FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1 AND id = $2`,
    [tenantId, wcId],
  );
  expect(row?.credentials_encrypted).not.toBe("__PENDING__");
  expect(row?.credentials_hash).not.toBe("__PENDING__");
  const aad = `${tenantId}:${wcId}`;
  const plaintext = JSON.parse(decryptCredentials(row!.credentials_encrypted, aad));
  expect(plaintext).toEqual({ type: "duckdb", token: env.motherduckToken, writable: false });
});

test("is idempotent: second run is a no-op when no __PENDING__ rows remain", async () => {
  await seedPendingConnection();
  await runWarehouseBackfill();
  await runWarehouseBackfill();
  const pending = await pgAll(
    `SELECT 1 FROM "zugzug_app"."warehouse_connection" WHERE credentials_encrypted = '__PENDING__'`,
  );
  expect(pending.length).toBe(0);
});

test("refuses to clobber a non-pending row", async () => {
  const { wcId, tenantId } = await seedPendingConnection();
  await runWarehouseBackfill();
  await pgRun(
    `UPDATE "zugzug_app"."warehouse_connection" SET credentials_encrypted = 'real-blob-x' WHERE tenant_id = $1 AND id = $2`,
    [tenantId, wcId],
  );
  await runWarehouseBackfill();
  const row = await pgGet<{ credentials_encrypted: string }>(
    `SELECT credentials_encrypted FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1 AND id = $2`,
    [tenantId, wcId],
  );
  expect(row?.credentials_encrypted).toBe("real-blob-x");
});
