process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { pgRun } from "../src/pg.ts";
import { getRowActivitySince } from "../src/repo-activity.ts";

const TA = "tact_a";
const TB = "tact_b";
const TABLE_ID = "tact_table";

async function cleanup(): Promise<void> {
  for (const t of [TA, TB]) {
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function seedAudit(tenantId: string, rowKey: string, action: string): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."audit_log"
       (id, created_at, user_id, action, detail, table_id, row_key, tenant_id)
     VALUES ($1, current_timestamp, 'u_test', $2, 'detail', $3, $4, $5)`,
    [randomUUID(), action, TABLE_ID, rowKey, tenantId],
  );
}

test("getRowActivitySince scopes by tenant_id; '*' reads cross-tenant", async () => {
  await seedAudit(TA, "row1", "Renamed canonical");
  await seedAudit(TB, "row1", "Renamed canonical");
  await seedAudit(TB, "row2", "Added canonical");

  const since = new Date(Date.now() - 60_000);

  const a = await getRowActivitySince(TABLE_ID, since, TA);
  expect(a.map((r) => r.rowKey).sort()).toEqual(["row1"]);

  const b = await getRowActivitySince(TABLE_ID, since, TB);
  expect(b.map((r) => r.rowKey).sort()).toEqual(["row1", "row2"]);

  // Super-admin: '*' returns both tenants' rows. DISTINCT ON (row_key) collapses
  // to one entry per row_key across the union; the recency tiebreak is enough
  // for our isolation assertion: both row_keys appear.
  const all = await getRowActivitySince(TABLE_ID, since, "*");
  expect(all.map((r) => r.rowKey).sort()).toEqual(["row1", "row2"]);
});
