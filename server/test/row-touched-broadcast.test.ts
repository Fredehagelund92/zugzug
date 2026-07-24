// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import "./setup.ts";
import { pgRun } from "../src/pg.ts";
import { presence, type RowTouchedHint } from "../src/realtime/presence-room.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as repo from "../src/repo-record.ts";

const T1 = "rt_bc_t1";
const refTableId = "rt_bc_dim";
const rowKey = "rt_row_1";
const U1 = "u_rt_actor";

async function cleanup(): Promise<void> {
  // Drop dynamic dim_/map_ tables (IF EXISTS handles missing tables).
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${refTableId}"`);
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${refTableId}"`);
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${refTableId}"`);
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${refTableId}"`);
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE reference_table_id = $1`, [
    refTableId,
  ]);
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T1]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_field" WHERE reference_table_id = $1`, [
    refTableId,
  ]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE reference_table_id = $1`, [
    refTableId,
  ]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE id = $1`, [refTableId]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T1]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T1]);
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U1]);
}

beforeAll(async () => {
  await cleanup();

  await provisionTenant({ id: T1, label: "RT Broadcast Test" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [U1, "RT Actor", "RA"],
  );

  // Use addRefTable so the dim_/map_ tables and registry entry are created by
  // the same code as production — avoids schema-name guessing in the test.
  await repo.addRefTable(refTableId, [], { keyKind: "slug", silent: true }, U1, T1);

  // Seed one record row so renameRecord has something to act on.
  await repo.addRecordOne(refTableId, "Row One", rowKey, U1, T1);
});

afterAll(cleanup);

test("a row-scoped write broadcasts exactly one row_touched to the tenant room", async () => {
  const seen: Array<{ tableId: string; hint: RowTouchedHint; tenantId: string }> = [];
  spyOn(presence, "broadcastRowTouched").mockImplementation(
    (tableId, hint, tenantId) => void seen.push({ tableId, hint, tenantId }),
  );

  // renameRecord calls appendAuditAs with tableId + rowKey — triggers the broadcast.
  await repo.renameRecord(refTableId, rowKey, "Row One Renamed", U1, 1, T1);

  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    tableId: refTableId,
    tenantId: T1,
    hint: { type: "row_touched", rowKey, userId: U1 },
  });
});

test("a presence-transport throw does not fail the write", async () => {
  spyOn(presence, "broadcastRowTouched").mockImplementation(() => {
    throw new Error("ws down");
  });

  // The rename should still resolve (write succeeds) even if broadcastRowTouched throws.
  // record_version is at 2 after the previous test's rename.
  await expect(
    repo.renameRecord(refTableId, rowKey, "Row One Again", U1, 2, T1),
  ).resolves.toBeDefined();
});
