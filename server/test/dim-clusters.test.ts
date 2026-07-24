import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgRun } from "../src/pg.ts";
import {
  materializeDimScanValues,
  getDimScanValuesAll,
  getDimClusters,
} from "../src/repo-dim-scan.ts";
import { TenantRepo } from "../src/tenant-repo.ts";

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
    occurrences: occurrences.map((o) => ({
      raw: o.raw,
      table: "raw.a",
      column: "c",
      rows: o.rows,
    })),
    scannedAt: new Date(),
  });
}

beforeEach(async () => {
  await resetDb(); // drops app/record schemas and re-applies migrations
  await pgRun(
    `INSERT INTO zugzug_app.tenant (id, slug, label, created_at)
       VALUES ($1, $1, 'test dim clusters', now())
     ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
});

test("getDimScanValuesAll returns every value worst-impact first when under the cap", async () => {
  await seed(
    Array.from({ length: 30 }, (_, i) => ({
      raw: `v${String(i).padStart(2, "0")}`,
      rows: 1000 - i,
    })),
  );
  const { rows, truncated } = await getDimScanValuesAll(TENANT, DIM, { filter: "new" });
  expect(rows).toHaveLength(30);
  expect(rows[0].raw).toBe("v00"); // highest rows first
  expect(rows[29].raw).toBe("v29");
  expect(truncated).toBe(false);
});

test("getDimScanValuesAll truncates at the cap and flags it", async () => {
  await seed(
    Array.from({ length: 30 }, (_, i) => ({
      raw: `v${String(i).padStart(2, "0")}`,
      rows: 1000 - i,
    })),
  );
  const { rows, truncated } = await getDimScanValuesAll(TENANT, DIM, { filter: "new", cap: 10 });
  expect(rows).toHaveLength(10);
  expect(rows[0].raw).toBe("v00");
  expect(truncated).toBe(true);
});

test("getDimClusters groups look-alikes and reports coverage from whole-dim scalars", async () => {
  await seed([
    { raw: "USA", rows: 1000 },
    { raw: "U.S.A.", rows: 500 },
    { raw: "GB", rows: 300 },
  ]);
  // Map "GB" so it counts as resolved (coverage denominator includes it).
  await pgRun(
    `INSERT INTO zugzug_app.map_test_clusters (tenant_id, raw, cc) VALUES ($1, 'GB', 'uk')`,
    [TENANT],
  );

  const feed = await getDimClusters(TENANT, DIM, { filter: "new" });

  // filter=new returns only unmapped values → USA + U.S.A. fold into one cluster.
  expect(feed.clusters).toHaveLength(1);
  expect(feed.clusters[0].key).toBe("usa");
  expect(feed.clusters[0].members.map((m) => m.raw)).toEqual(["USA", "U.S.A."]);
  expect(feed.clusters[0].rows).toBe(1500);

  // Coverage is whole-dimension: resolved = GB's 300; at risk = 1500; pct = 17.
  expect(feed.coverage.resolvedRows).toBe(300);
  expect(feed.coverage.atRiskRows).toBe(1500);
  expect(feed.coverage.pct).toBe(17); // round(300 / 1800 * 100)
  expect(feed.truncated).toBe(false);
});

test("TenantRepo.getDimClusters scopes to its tenant and returns the feed", async () => {
  await seed([
    { raw: "USA", rows: 1000 },
    { raw: "U.S.A.", rows: 500 },
  ]);
  const repo = new TenantRepo(TENANT, "admin");
  const feed = await repo.getDimClusters(DIM, { filter: "new" });
  expect(feed.clusters).toHaveLength(1);
  expect(feed.clusters[0].key).toBe("usa");
  expect(feed.coverage.pct).toBe(0); // nothing mapped → 0% of 1500 rows resolved
});

test("empty dimension reports 100% coverage (nothing at risk) with no clusters", async () => {
  await seed([]); // dimension exists, zero scan values
  const feed = await getDimClusters(TENANT, DIM, { filter: "new" });
  expect(feed.clusters).toHaveLength(0);
  expect(feed.coverage.resolvedRows).toBe(0);
  expect(feed.coverage.atRiskRows).toBe(0);
  expect(feed.coverage.pct).toBe(100);
  expect(feed.truncated).toBe(false);
});

test("cap exactly equal to the total does not flag truncation", async () => {
  await seed(Array.from({ length: 10 }, (_, i) => ({ raw: `v${i}`, rows: 100 - i })));
  const { rows, truncated } = await getDimScanValuesAll(TENANT, DIM, { filter: "new", cap: 10 });
  expect(rows).toHaveLength(10);
  expect(truncated).toBe(false);
});
