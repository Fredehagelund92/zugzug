process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { pgRun, pgAll } from "../src/pg.ts";
import {
  materializeDimScanValues,
  getDimScanScalars,
  getDimScanValuesPage,
} from "../src/repo-dim-scan.ts";

const TENANT = "t_test_dim_scan";
const DIM = "d_color";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO zugzug_app.tenant (id, slug, label, created_at)
       VALUES ($1, $1, 'test dim scan', now())
     ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM zugzug_app.dim_scan_occurrence WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.dim_scan_value      WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.dimension           WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DROP TABLE IF EXISTS zugzug_app.map_test_color`);
  await pgRun(`DROP TABLE IF EXISTS zugzug_app.dim_test_color`);
  await pgRun(`DELETE FROM zugzug_app.tenant              WHERE id        = $1`, [TENANT]);
});

beforeEach(async () => {
  await pgRun(`DELETE FROM zugzug_app.dim_scan_occurrence WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.dim_scan_value      WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.dimension           WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DROP TABLE IF EXISTS zugzug_app.map_test_color`);
  await pgRun(`DROP TABLE IF EXISTS zugzug_app.dim_test_color`);
});

test("materializeDimScanValues writes one value per distinct raw with summed rows", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [
      { raw: "Red",   table: "raw.products", column: "color", rows: 100 },
      { raw: "RED",   table: "raw.orders",   column: "color", rows:  50 },
      { raw: "Blue",  table: "raw.products", column: "color", rows:  30 },
    ],
    scannedAt: new Date("2026-06-17T10:00:00Z"),
  });

  const values = await pgAll<{ raw: string; raw_lower: string; total_rows: number }>(
    `SELECT raw, raw_lower, total_rows::int AS total_rows FROM zugzug_app.dim_scan_value
       WHERE tenant_id = $1 AND dim_id = $2 ORDER BY raw_lower`,
    [TENANT, DIM],
  );
  expect(values).toHaveLength(2);
  expect(values[0]).toMatchObject({ raw_lower: "blue", total_rows: 30 });
  expect(values[1]).toMatchObject({ raw_lower: "red",  total_rows: 150 });
});

test("materializeDimScanValues writes per-source occurrences", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [
      { raw: "Red", table: "raw.products", column: "color", rows: 100 },
      { raw: "RED", table: "raw.orders",   column: "color", rows:  50 },
    ],
    scannedAt: new Date(),
  });
  const occs = await pgAll<{ table_name: string; rows: number }>(
    `SELECT table_name, rows::int AS rows FROM zugzug_app.dim_scan_occurrence
       WHERE tenant_id = $1 AND dim_id = $2 ORDER BY table_name`,
    [TENANT, DIM],
  );
  expect(occs).toHaveLength(2);
  expect(occs[0]).toMatchObject({ table_name: "raw.orders",   rows: 50 });
  expect(occs[1]).toMatchObject({ table_name: "raw.products", rows: 100 });
});

test("materializeDimScanValues replaces prior rows for the same dim", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [{ raw: "Red", table: "raw.a", column: "c", rows: 10 }],
    scannedAt: new Date(),
  });
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [{ raw: "Green", table: "raw.a", column: "c", rows: 20 }],
    scannedAt: new Date(),
  });
  const values = await pgAll<{ raw_lower: string }>(
    `SELECT raw_lower FROM zugzug_app.dim_scan_value
       WHERE tenant_id = $1 AND dim_id = $2`,
    [TENANT, DIM],
  );
  expect(values).toHaveLength(1);
  expect(values[0].raw_lower).toBe("green");
});

test("materializeDimScanValues with empty occurrences clears the dim", async () => {
  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [{ raw: "Red", table: "raw.a", column: "c", rows: 10 }],
    scannedAt: new Date(),
  });
  await materializeDimScanValues(DIM, TENANT, { occurrences: [], scannedAt: new Date() });
  const values = await pgAll<{ raw_lower: string }>(
    `SELECT raw_lower FROM zugzug_app.dim_scan_value WHERE tenant_id = $1 AND dim_id = $2`,
    [TENANT, DIM],
  );
  expect(values).toHaveLength(0);
});

test("materializeDimScanValues handles >10k occurrences without exceeding bind-param limit", async () => {
  const occurrences = Array.from({ length: 12000 }, (_, i) => ({
    raw: `v${i}`,
    table: "raw.a",
    column: "c",
    rows: 1,
  }));
  await materializeDimScanValues(DIM, TENANT, { occurrences, scannedAt: new Date() });
  const { count } = (
    await pgAll<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM zugzug_app.dim_scan_value WHERE tenant_id = $1 AND dim_id = $2`,
      [TENANT, DIM],
    )
  )[0];
  expect(count).toBe(12000);
});

test("getDimScanScalars returns per-dim totals joined against map_<dim>", async () => {
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.map_test_color
               (tenant_id varchar, raw varchar, color_code varchar)`);
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.dim_test_color
               (color_code varchar PRIMARY KEY, label varchar)`);
  await pgRun(
    `INSERT INTO zugzug_app.map_test_color (tenant_id, raw, color_code)
     VALUES ($1, 'Red', 'RED') ON CONFLICT DO NOTHING`,
    [TENANT],
  );
  await pgRun(
    `INSERT INTO zugzug_app.dimension
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, 'Color', 'zugzug_app.dim_test_color',
             'zugzug_app.map_test_color', 'color_code', current_timestamp, $2)
     ON CONFLICT DO NOTHING`,
    [DIM, TENANT],
  );

  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [
      { raw: "Red",   table: "raw.a", column: "c", rows: 100 },
      { raw: "Blue",  table: "raw.a", column: "c", rows:  50 },
      { raw: "Green", table: "raw.a", column: "c", rows:  30 },
    ],
    scannedAt: new Date("2026-06-17T10:00:00Z"),
  });

  const scalars = await getDimScanScalars(TENANT);
  const row = scalars.find((r) => r.dimId === DIM);
  expect(row).toBeDefined();
  expect(row!.totalDistinct).toBe(3);
  expect(row!.mappedCount).toBe(1);
  expect(row!.newCount).toBe(2);
  expect(row!.mappedRowsTotal).toBe(100);
  expect(row!.unmappedRowsTotal).toBe(80);
  expect(row!.scannedAt).toBeInstanceOf(Date);
});

test("getDimScanValuesPage paginates unmapped first by total_rows desc", async () => {
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.map_test_color
               (tenant_id varchar, raw varchar, color_code varchar)`);
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.dim_test_color
               (color_code varchar PRIMARY KEY, label varchar)`);
  await pgRun(
    `INSERT INTO zugzug_app.dimension
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, 'Color', 'zugzug_app.dim_test_color',
             'zugzug_app.map_test_color', 'color_code', current_timestamp, $2)
     ON CONFLICT DO NOTHING`,
    [DIM, TENANT],
  );

  await materializeDimScanValues(DIM, TENANT, {
    occurrences: Array.from({ length: 30 }, (_, i) => ({
      raw: `v${String(i).padStart(2, "0")}`,
      table: "raw.a",
      column: "c",
      rows: 1000 - i,
    })),
    scannedAt: new Date(),
  });

  const page1 = await getDimScanValuesPage(TENANT, DIM, { filter: "new", limit: 10 });
  expect(page1.items).toHaveLength(10);
  expect(page1.items[0].raw).toBe("v00");
  expect(page1.items[9].raw).toBe("v09");
  expect(page1.hasMore).toBe(true);

  const page2 = await getDimScanValuesPage(TENANT, DIM, {
    filter: "new",
    limit: 10,
    after: page1.nextCursor,
  });
  expect(page2.items[0].raw).toBe("v10");
});

test("getDimScanValuesPage q substring matches case-insensitively", async () => {
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.map_test_color
               (tenant_id varchar, raw varchar, color_code varchar)`);
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.dim_test_color
               (color_code varchar PRIMARY KEY, label varchar)`);
  await pgRun(
    `INSERT INTO zugzug_app.dimension
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, 'Color', 'zugzug_app.dim_test_color',
             'zugzug_app.map_test_color', 'color_code', current_timestamp, $2)
     ON CONFLICT DO NOTHING`,
    [DIM, TENANT],
  );

  await materializeDimScanValues(DIM, TENANT, {
    occurrences: [
      { raw: "ACME Corp",  table: "raw.a", column: "c", rows: 10 },
      { raw: "acme Inc",   table: "raw.a", column: "c", rows: 20 },
      { raw: "Globex",     table: "raw.a", column: "c", rows: 30 },
    ],
    scannedAt: new Date(),
  });

  const page = await getDimScanValuesPage(TENANT, DIM, { filter: "all", limit: 50, q: "acme" });
  expect(page.items.map((i) => i.raw).sort()).toEqual(["ACME Corp", "acme Inc"]);
});
