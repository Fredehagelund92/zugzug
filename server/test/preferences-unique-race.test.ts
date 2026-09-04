process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { getPreferences, setPreferences } from "../src/repo-meta.ts";

const T = "tpref_race";
async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
}
beforeEach(cleanup);
afterAll(cleanup);

test("concurrent setPreferences for the same tenant does not 23505", async () => {
  await provisionTenant({ id: T, label: "race" });

  const writes = Array.from({ length: 10 }, (_, i) =>
    setPreferences({ scanSchedule: i % 2 === 0 ? "hourly" : "daily" }, T),
  );
  const settled = await Promise.allSettled(writes);
  const rejected = settled.filter((s) => s.status === "rejected");
  expect(rejected).toEqual([]);

  const final = await getPreferences(T);
  expect(["hourly", "daily"]).toContain(final.scanSchedule);
});
