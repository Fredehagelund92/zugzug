// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgRun } from "../src/pg.ts";
import { addWarehouseDatabase, listWarehouseDatabases } from "../src/repo-warehouse.ts";
import { getAdapter } from "../src/warehouse/registry.ts";

beforeEach(async () => {
  await resetDb();
});

/** DuckDB flags its built-in schemas as internal, so a bare in-memory catalog
 *  reports zero schemas. Create a real one so "memory" counts as 1. */
async function seedWarehouseSchema(): Promise<void> {
  const adapter = await getAdapter();
  const conn = await (
    adapter as unknown as { connect(): Promise<{ run(sql: string): Promise<unknown> }> }
  ).connect();
  await conn.run("CREATE SCHEMA IF NOT EXISTS analytics");
}

test("listWarehouseDatabases returns the stored schema count without a live warehouse query", async () => {
  await addWarehouseDatabase({ databaseName: "raw_prod", actorUserId: "u_test" });
  // With ATTACH_WAREHOUSE=false the adapter only sees the in-memory catalog,
  // so a live query could never yield 4242 — the value must come from Postgres.
  await pgRun(
    `UPDATE "zugzug_app"."warehouse_database" SET schema_count = 4242 WHERE database_name = 'raw_prod'`,
  );
  const rows = await listWarehouseDatabases();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.schemaCount).toBe(4242);
});

test("refreshSchemaCounts persists adapter counts to Postgres", async () => {
  // The in-memory DuckDB adapter reports its own catalog as "memory" —
  // register a database under that name so the refresh has a row to update.
  await seedWarehouseSchema();
  await addWarehouseDatabase({ databaseName: "memory", actorUserId: "u_test" });
  await pgRun(
    `UPDATE "zugzug_app"."warehouse_database" SET schema_count = NULL WHERE database_name = 'memory'`,
  );
  const { refreshSchemaCounts } = await import("../src/repo-warehouse.ts");
  await refreshSchemaCounts();
  const rows = await listWarehouseDatabases();
  expect(rows[0]?.schemaCount).toBe(1);
});

test("addWarehouseDatabase returns the new row with a fresh schema count", async () => {
  await seedWarehouseSchema();
  const row = await addWarehouseDatabase({ databaseName: "memory", actorUserId: "u_test" });
  expect(row.schemaCount).toBe(1);
});

test("probeRegisteredDatabases marks a reachable database as checked", async () => {
  await addWarehouseDatabase({ databaseName: "memory", actorUserId: "u_test" });
  await pgRun(
    `UPDATE "zugzug_app"."warehouse_database" SET last_probe_at = NULL, last_probe_error = NULL`,
  );
  const { probeRegisteredDatabases } = await import("../src/repo-warehouse.ts");
  await probeRegisteredDatabases();
  const rows = await listWarehouseDatabases();
  expect(rows[0]?.lastProbeAt).not.toBeNull();
  expect(rows[0]?.lastProbeError).toBeNull();
});

test("probeRegisteredDatabases records the failure reason for an unreachable database", async () => {
  await addWarehouseDatabase({ databaseName: "no_such_db", actorUserId: "u_test" });
  const { probeRegisteredDatabases } = await import("../src/repo-warehouse.ts");
  await probeRegisteredDatabases();
  const rows = await listWarehouseDatabases();
  expect(rows[0]?.lastProbeError).toBeTruthy();
  // The badge shows "unreachable · Xm ago" — the timestamp must be set on failure too.
  expect(rows[0]?.lastProbeAt).not.toBeNull();
});

test("addWarehouseDatabase probes the new database right away", async () => {
  const row = await addWarehouseDatabase({ databaseName: "memory", actorUserId: "u_test" });
  expect(row.lastProbeAt).not.toBeNull();
  expect(row.lastProbeError).toBeNull();
});
