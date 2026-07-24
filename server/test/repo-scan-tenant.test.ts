process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import "./setup.ts";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as record from "../src/repo-record.ts";
import * as scan from "../src/repo-scan.ts";

const TA = "tsc_a";
const TB = "tsc_b";
const REF_TABLE = "tsc_dim";

const WH_DB_ID = "whd_scantest";

async function cleanup(): Promise<void> {
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${REF_TABLE}"`);
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${REF_TABLE}"`);
  for (const t of [TA, TB]) {
    await pgRun(`DELETE FROM "zugzug_app"."source_stat" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."reference_table_field" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE id = $1`, [WH_DB_ID]);
}

async function seedWarehouseDb(): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_database" (id, database_name, added_at, added_by)
     VALUES ($1, 'test_db', now(), 'u_system') ON CONFLICT DO NOTHING`,
    [WH_DB_ID],
  );
}
beforeEach(cleanup);
afterAll(cleanup);

test("listSources returns only sources owned by the calling tenant", async () => {
  await seedWarehouseDb();
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });
  await record.addRefTable(REF_TABLE, [], { keyKind: "slug", silent: true }, "u_test", TA);
  await scan.addSource(REF_TABLE, "warehouse.tbl_a", "col", TA);

  const a = await scan.listSources({ tenantId: TA });
  const b = await scan.listSources({ tenantId: TB });
  expect(a.length).toBeGreaterThan(0);
  expect(a[0]?.table).toBe("warehouse.tbl_a");
  expect(b).toEqual([]);
});

test("anyScanDue('*') is true iff any tenant has a schedule with work pending", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });

  // No preferences rows for either tenant — nothing due.
  expect(await scan.anyScanDue(new Date(), "*")).toBe(false);

  // Set scan_schedule on tenant A's preferences. lastScan is null → due.
  await pgRun(
    `INSERT INTO "zugzug_app"."preferences"
       (id, scan_schedule, publish_threshold, suggest_threshold, updated_at, tenant_id)
     VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM "zugzug_app"."preferences"),
             '15m', 95, 75, current_timestamp, $1)
     ON CONFLICT (tenant_id) DO UPDATE SET scan_schedule = '15m'`,
    [TA],
  );
  expect(await scan.anyScanDue(new Date(), "*")).toBe(true);

  // Single-tenant scope: B has no schedule → false; A has schedule → true.
  expect(await scan.anyScanDue(new Date(), TB)).toBe(false);
  expect(await scan.anyScanDue(new Date(), TA)).toBe(true);
});
