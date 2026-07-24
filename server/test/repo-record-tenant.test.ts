process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import "./setup.ts"; // registers warehouse factories
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as record from "../src/repo-record.ts";

const TA = "tcan_a";
const TB = "tcan_b";
const REF_TABLE = "tcan_country";

async function cleanup(): Promise<void> {
  // Drop the dynamic dim_/map_ tables left over from prior runs (must run before
  // we wipe the refTable registry rows, since those rows tell us the schema).
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${REF_TABLE}"`);
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${REF_TABLE}"`);
  for (const t of [TA, TB]) {
    await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."reference_table_field" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

test("listRefTables is tenant-scoped", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });
  await record.addRefTable(REF_TABLE, [], { keyKind: "slug", silent: true }, "u_test", TA);

  const a = await record.listRefTables(TA);
  const b = await record.listRefTables(TB);
  expect(a.map((d) => d.id)).toContain(REF_TABLE);
  expect(b.map((d) => d.id)).not.toContain(REF_TABLE);
});

test("addRecordOne in tenant A is not visible from tenant B's getRefTable", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });
  await record.addRefTable(REF_TABLE, [], { keyKind: "slug", silent: true }, "u_test", TA);
  await record.addRecordOne(REF_TABLE, "France", "fr", "u_test", TA);

  const refTableA = await record.getRefTable(REF_TABLE, TA);
  const refTableB = await record.getRefTable(REF_TABLE, TB);
  expect(refTableA?.record.map((c) => c.key)).toContain("fr");
  expect(refTableB).toBeNull();
});
