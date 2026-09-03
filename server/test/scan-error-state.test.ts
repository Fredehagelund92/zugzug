// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import "./setup.ts";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgAll, pgRun } from "../src/pg.ts";
import { makeUser, makeWorkspace } from "./factories/index.ts";
import { addRefTable, deleteRefTable } from "../src/repo-record.ts";
import { listSources, scanSources } from "../src/repo-scan.ts";
import { registerFactories } from "../src/warehouse/credentials.ts";
import { _resetAdapterCache } from "../src/warehouse/registry.ts";
import { createDuckDbAdapter } from "../src/warehouse/duckdb/index.ts";
import type { WarehouseAdapter } from "../src/warehouse/adapter.ts";

/* A scan that never reached the warehouse (timeout, blip, auth) used to be
   stored exactly like a column that doesn't exist — present=false — and the
   Sources page called it "⚠ column not found". */

const T = "tscanerr";
const U = "u_scanerr";
const DB = "wdb_scanerr";

/** An adapter whose column scan always fails, but whose catalog still answers. */
function failingAdapter(opts: { columns: string[] }): WarehouseAdapter {
  return {
    capabilities: { id: "duckdb", writable: false },
    ping: async () => true,
    tableExists: async () => true,
    listColumns: async () => opts.columns.map((name) => ({ name, type: "VARCHAR" })),
    columnStats: async () => {
      throw new Error("scan timeout");
    },
    distinctValues: async () => [],
    distinctValuesWithProvenance: async () => [],
  } as unknown as WarehouseAdapter;
}

function useAdapter(adapter: WarehouseAdapter): void {
  _resetAdapterCache();
  registerFactories({
    duckdb: async () => adapter,
    snowflake: async () => {
      throw new Error("not in tests");
    },
  });
}

async function cleanup(): Promise<void> {
  const refTables = await pgAll<{ id: string }>(
    `SELECT id FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
    [T],
  ).catch(() => [] as { id: string }[]);
  for (const d of refTables) await deleteRefTable(d.id, "test-teardown", T).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."source_stat" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE id = $1`, [DB]);
}

async function wire(): Promise<string> {
  const refTableId = await addRefTable("Region", [], { keyKind: "slug" }, U, T);
  await pgRun(
    `INSERT INTO "zugzug_app"."reference_table_source"
       (reference_table_id, tenant_id, database_id, schema_name, table_name, column_name)
     VALUES ($1, $2, $3, 'sales', 'orders', 'region')`,
    [refTableId, T, DB],
  );
  return refTableId;
}

beforeEach(async () => {
  await cleanup();
  await makeUser(U);
  await makeWorkspace(T);
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_database" (id, database_name, added_at, added_by)
     VALUES ($1, 'analytics', now(), $2)`,
    [DB, U],
  );
});

afterAll(async () => {
  await cleanup();
  // Restore the real adapter factories for the rest of the suite.
  _resetAdapterCache();
  registerFactories({
    duckdb: async (creds) => createDuckDbAdapter(creds),
    snowflake: async () => {
      throw new Error("Snowflake adapter ships in Phase 2");
    },
  });
});

test("a timed-out scan is an error state, not 'column not found'", async () => {
  await wire();
  useAdapter(failingAdapter({ columns: ["region"] }));
  await scanSources(T);

  const [row] = await listSources({ tenantId: T });
  expect(row?.scanError).toBe("scan timed out");
  // The column is still there — the scan just never got an answer about it.
  expect(await listSources({ tenantId: T, status: "missing" })).toEqual([]);
  expect((await listSources({ tenantId: T, status: "failed" })).length).toBe(1);
});

test("a column the catalog really doesn't have stays 'column not found'", async () => {
  await wire();
  useAdapter(failingAdapter({ columns: ["country"] }));
  await scanSources(T);

  const [row] = await listSources({ tenantId: T });
  expect(row?.scanError).toBeNull();
  expect(row?.present).toBe(false);
  expect((await listSources({ tenantId: T, status: "missing" })).length).toBe(1);
});
