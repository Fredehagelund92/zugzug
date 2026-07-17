process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import "./setup.ts";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgAll, pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as canonical from "../src/repo-canonical.ts";

const T = "trm_a";
const D = "trm_thing";
const DB_ID = "wdb_trm";

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE id = $1`, [DB_ID]);
}
beforeEach(cleanup);
afterAll(cleanup);

test("removeSource deletes exactly the one wired column row", async () => {
  await provisionTenant({ id: T, label: "A" });
  await canonical.addDimension(D, [], { keyKind: "slug" }, "u_test", T);

  // register a warehouse database + two wired columns
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_database" (id, database_name, added_at, added_by)
     VALUES ($1, 'analytics_trm', now(), 'u_test')`,
    [DB_ID],
  );
  const wire = (schema: string, table: string, col: string) =>
    pgRun(
      `INSERT INTO "zugzug_app"."dimension_source"
         (dim_id, tenant_id, database_id, schema_name, table_name, column_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [D, T, DB_ID, schema, table, col],
    );
  await wire("authco", "users", "plan_type");
  await wire("authco", "users", "country");

  await canonical.removeSource(
    D,
    { databaseId: DB_ID, schemaName: "authco", tableName: "users", columnName: "plan_type" },
    T,
  );

  const rows = await pgAll<{ column_name: string }>(
    `SELECT column_name FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1 AND dim_id = $2`,
    [T, D],
  );
  expect(rows.map((r) => r.column_name).sort()).toEqual(["country"]);
});
