process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.MOTHERDUCK_TOKEN = "md_test_token_xyz";
process.env.WAREHOUSE_DB = "analytics";
process.env.ATTACH_WAREHOUSE = "false";
process.env.WAREHOUSE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd=";

import { test, expect, beforeEach } from "bun:test";
import { pgAll, pgGet, pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import {
  createWarehouseConnection,
  getWarehouseConnection,
  listWarehouseDatabases,
  addWarehouseDatabase,
} from "../src/repo-warehouse.ts";

const T = `trepo_${process.pid}`;

beforeEach(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
  await provisionTenant({ id: T, label: "Repo test" });
});

test("createWarehouseConnection encrypts credentials with AAD = tenant:id", async () => {
  const conn = await createWarehouseConnection({
    tenantId: T,
    adapter: "motherduck",
    label: "Prod",
    credentials: { type: "duckdb", token: "md_x", writable: false },
    actorUserId: "u_seed",
  });
  expect(conn.id).toMatch(/^wc_[0-9a-f]{32}$/);
  const fetched = await getWarehouseConnection(T);
  expect(fetched?.id).toBe(conn.id);
  expect(fetched?.credentialsVersion).toBe(1);
});

test("getWarehouseConnection returns null when no connection exists", async () => {
  // Wipe the auto-created connection if provisionTenant created one (it shouldn't for this PR).
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [T]);
  expect(await getWarehouseConnection(T)).toBeNull();
});

test("addWarehouseDatabase + listWarehouseDatabases round-trip", async () => {
  const conn = await createWarehouseConnection({
    tenantId: T,
    adapter: "motherduck",
    label: "Prod",
    credentials: { type: "duckdb", token: "md_x", writable: false },
    actorUserId: "u_seed",
  });
  const wd = await addWarehouseDatabase({
    tenantId: T,
    connectionId: conn.id,
    databaseName: "analytics",
    label: "Sales DWH",
    actorUserId: "u_seed",
  });
  const list = await listWarehouseDatabases(T);
  expect(list.length).toBe(1);
  expect(list[0].id).toBe(wd.id);
  expect(list[0].databaseName).toBe("analytics");
  expect(list[0].sourceCount).toBe(0);
});

test("createWarehouseConnection rejects a second connection per tenant", async () => {
  await createWarehouseConnection({
    tenantId: T, adapter: "motherduck", label: "A",
    credentials: { type: "duckdb", token: "md_x", writable: false }, actorUserId: "u_seed",
  });
  await expect(
    createWarehouseConnection({
      tenantId: T, adapter: "motherduck", label: "B",
      credentials: { type: "duckdb", token: "md_y", writable: false }, actorUserId: "u_seed",
    }),
  ).rejects.toThrow(/already.*exists|one.*per.*tenant/i);
});

test("provisionTenant({ warehouse }) inserts connection + database rows", async () => {
  const t = `tprov_${process.pid}`;
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [t]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [t]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  await provisionTenant({
    id: t,
    label: "Prov",
    warehouse: {
      adapter: "motherduck",
      label: "Prov WH",
      credentials: { type: "duckdb", token: "md_x", writable: false },
      databases: [{ databaseName: "analytics" }, { databaseName: "hr" }],
      createdBy: "u_admin",
    },
  });
  const conn = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [t],
  );
  expect(conn).not.toBeNull();
  const dbs = await pgAll<{ database_name: string }>(
    `SELECT database_name FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1 ORDER BY database_name`,
    [t],
  );
  expect(dbs.map((d) => d.database_name)).toEqual(["analytics", "hr"]);
  // Cleanup so this row doesn't leak into other suites.
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [t]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [t]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
});

test("provisionTenant({ warehouse }) rolls back tenant on warehouse failure", async () => {
  const t = `tprov_${process.pid}_rb`;
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [t]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [t]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  // Duplicate databaseName under the same connection trips the
  // warehouse_database_per_conn_unique index on the second insert,
  // exercising the compensating DELETE path.
  await expect(
    provisionTenant({
      id: t,
      label: "Rollback",
      warehouse: {
        adapter: "motherduck",
        label: "WH",
        credentials: { type: "duckdb", token: "md_x", writable: false },
        databases: [{ databaseName: "analytics" }, { databaseName: "analytics" }],
        createdBy: "u_admin",
      },
    }),
  ).rejects.toThrow();
  const tenant = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."tenant" WHERE id = $1`,
    [t],
  );
  expect(tenant).toBeNull();
  // Cleanup any orphaned warehouse_database/connection rows that may have
  // survived the failure before the rollback ran.
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [t]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [t]);
});
