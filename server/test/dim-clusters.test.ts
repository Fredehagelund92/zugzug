import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgRun } from "../src/pg.ts";
import { materializeDimScanValues, getDimScanValuesAll } from "../src/repo-dim-scan.ts";

const TENANT = "t_test_dim_clusters";
const DIM = "d_clusters";

async function seed(occurrences: { raw: string; rows: number }[]): Promise<void> {
  await pgRun(
    `CREATE TABLE IF NOT EXISTS zugzug_app.map_test_clusters
       (tenant_id varchar, raw varchar, cc varchar)`,
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS zugzug_app.dim_test_clusters
       (cc varchar PRIMARY KEY, label varchar)`,
  );
  await pgRun(
    `INSERT INTO zugzug_app.dimension
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, 'Clusters', 'zugzug_app.dim_test_clusters',
             'zugzug_app.map_test_clusters', 'cc', current_timestamp, $2)
     ON CONFLICT DO NOTHING`,
    [DIM, TENANT],
  );
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: occurrences.map((o) => ({ raw: o.raw, table: "raw.a", column: "c", rows: o.rows })),
    scannedAt: new Date(),
  });
}

beforeEach(async () => {
  await resetDb(); // drops app/canonical schemas and re-applies migrations
  await pgRun(
    `INSERT INTO zugzug_app.tenant (id, slug, label, created_at)
       VALUES ($1, $1, 'test dim clusters', now())
     ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
});

test("getDimScanValuesAll returns every value worst-impact first when under the cap", async () => {
  await seed(Array.from({ length: 30 }, (_, i) => ({ raw: `v${String(i).padStart(2, "0")}`, rows: 1000 - i })));
  const { rows, truncated } = await getDimScanValuesAll(TENANT, DIM, { filter: "new" });
  expect(rows).toHaveLength(30);
  expect(rows[0].raw).toBe("v00"); // highest rows first
  expect(rows[29].raw).toBe("v29");
  expect(truncated).toBe(false);
});

test("getDimScanValuesAll truncates at the cap and flags it", async () => {
  await seed(Array.from({ length: 30 }, (_, i) => ({ raw: `v${String(i).padStart(2, "0")}`, rows: 1000 - i })));
  const { rows, truncated } = await getDimScanValuesAll(TENANT, DIM, { filter: "new", cap: 10 });
  expect(rows).toHaveLength(10);
  expect(rows[0].raw).toBe("v00");
  expect(truncated).toBe(true);
});
