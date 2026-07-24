process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import "./setup.ts"; // registers warehouse factories
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as canonical from "../src/repo-canonical.ts";

const TA = "tcan_a";
const TB = "tcan_b";
const DIM = "tcan_country";

async function cleanup(): Promise<void> {
  // Drop the dynamic dim_/map_ tables left over from prior runs (must run before
  // we wipe the dimension registry rows, since those rows tell us the schema).
  await pgRun(`DROP TABLE IF EXISTS "zugzug_canonical"."dim_${DIM}"`);
  await pgRun(`DROP TABLE IF EXISTS "zugzug_canonical"."map_${DIM}"`);
  for (const t of [TA, TB]) {
    await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."dimension_field" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

test("listDimensions is tenant-scoped", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });
  await canonical.addDimension(DIM, [], { keyKind: "slug", silent: true }, "u_test", TA);

  const a = await canonical.listDimensions(TA);
  const b = await canonical.listDimensions(TB);
  expect(a.map((d) => d.id)).toContain(DIM);
  expect(b.map((d) => d.id)).not.toContain(DIM);
});

test("addCanonicalOne in tenant A is not visible from tenant B's getDimension", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });
  await canonical.addDimension(DIM, [], { keyKind: "slug", silent: true }, "u_test", TA);
  await canonical.addCanonicalOne(DIM, "France", "fr", "u_test", TA);

  const dimA = await canonical.getDimension(DIM, TA);
  const dimB = await canonical.getDimension(DIM, TB);
  expect(dimA?.canonical.map((c) => c.key)).toContain("fr");
  expect(dimB).toBeNull();
});
