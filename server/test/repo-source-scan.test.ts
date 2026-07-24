process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { pgRun, pgAll } from "../src/pg.ts";
import {
  materializeSourceScanValues,
  getSourceScanScalars,
  getSourceScanValuesPage,
} from "../src/repo-source-scan.ts";

const TENANT = "t_test_dim_scan";
const REF_TABLE = "d_color";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO zugzug_app.tenant (id, slug, label, created_at)
       VALUES ($1, $1, 'test refTable scan', now())
     ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM zugzug_app.source_scan_occurrence WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.source_scan_value      WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.reference_table           WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DROP TABLE IF EXISTS zugzug_app.map_test_color`);
  await pgRun(`DROP TABLE IF EXISTS zugzug_app.dim_test_color`);
  await pgRun(`DELETE FROM zugzug_app.tenant              WHERE id        = $1`, [TENANT]);
});

beforeEach(async () => {
  await pgRun(`DELETE FROM zugzug_app.source_scan_occurrence WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.source_scan_value      WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.reference_table           WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DROP TABLE IF EXISTS zugzug_app.map_test_color`);
  await pgRun(`DROP TABLE IF EXISTS zugzug_app.dim_test_color`);
});

test("materializeSourceScanValues writes one value per distinct raw with summed rows", async () => {
  await materializeSourceScanValues(REF_TABLE, TENANT, {
    occurrences: [
      { raw: "Red", table: "raw.products", column: "color", rows: 100 },
      { raw: "RED", table: "raw.orders", column: "color", rows: 50 },
      { raw: "Blue", table: "raw.products", column: "color", rows: 30 },
    ],
    scannedAt: new Date("2026-06-17T10:00:00Z"),
  });

  const values = await pgAll<{ raw: string; raw_lower: string; total_rows: number }>(
    `SELECT raw, raw_lower, total_rows::int AS total_rows FROM zugzug_app.source_scan_value
       WHERE tenant_id = $1 AND reference_table_id = $2 ORDER BY raw_lower`,
    [TENANT, REF_TABLE],
  );
  expect(values).toHaveLength(2);
  expect(values[0]).toMatchObject({ raw_lower: "blue", total_rows: 30 });
  expect(values[1]).toMatchObject({ raw_lower: "red", total_rows: 150 });
});

test("materializeSourceScanValues writes per-source occurrences", async () => {
  await materializeSourceScanValues(REF_TABLE, TENANT, {
    occurrences: [
      { raw: "Red", table: "raw.products", column: "color", rows: 100 },
      { raw: "RED", table: "raw.orders", column: "color", rows: 50 },
    ],
    scannedAt: new Date(),
  });
  const occs = await pgAll<{ table_name: string; rows: number }>(
    `SELECT table_name, rows::int AS rows FROM zugzug_app.source_scan_occurrence
       WHERE tenant_id = $1 AND reference_table_id = $2 ORDER BY table_name`,
    [TENANT, REF_TABLE],
  );
  expect(occs).toHaveLength(2);
  expect(occs[0]).toMatchObject({ table_name: "raw.orders", rows: 50 });
  expect(occs[1]).toMatchObject({ table_name: "raw.products", rows: 100 });
});

test("materializeSourceScanValues replaces prior rows for the same refTable", async () => {
  await materializeSourceScanValues(REF_TABLE, TENANT, {
    occurrences: [{ raw: "Red", table: "raw.a", column: "c", rows: 10 }],
    scannedAt: new Date(),
  });
  await materializeSourceScanValues(REF_TABLE, TENANT, {
    occurrences: [{ raw: "Green", table: "raw.a", column: "c", rows: 20 }],
    scannedAt: new Date(),
  });
  const values = await pgAll<{ raw_lower: string }>(
    `SELECT raw_lower FROM zugzug_app.source_scan_value
       WHERE tenant_id = $1 AND reference_table_id = $2`,
    [TENANT, REF_TABLE],
  );
  expect(values).toHaveLength(1);
  expect(values[0].raw_lower).toBe("green");
});

test("materializeSourceScanValues with empty occurrences clears the refTable", async () => {
  await materializeSourceScanValues(REF_TABLE, TENANT, {
    occurrences: [{ raw: "Red", table: "raw.a", column: "c", rows: 10 }],
    scannedAt: new Date(),
  });
  await materializeSourceScanValues(REF_TABLE, TENANT, { occurrences: [], scannedAt: new Date() });
  const values = await pgAll<{ raw_lower: string }>(
    `SELECT raw_lower FROM zugzug_app.source_scan_value WHERE tenant_id = $1 AND reference_table_id = $2`,
    [TENANT, REF_TABLE],
  );
  expect(values).toHaveLength(0);
});

test("materializeSourceScanValues handles >10k occurrences without exceeding bind-param limit", async () => {
  const occurrences = Array.from({ length: 12000 }, (_, i) => ({
    raw: `v${i}`,
    table: "raw.a",
    column: "c",
    rows: 1,
  }));
  await materializeSourceScanValues(REF_TABLE, TENANT, { occurrences, scannedAt: new Date() });
  const { count } = (
    await pgAll<{ count: number }>(
      `SELECT COUNT(*)::int as count FROM zugzug_app.source_scan_value WHERE tenant_id = $1 AND reference_table_id = $2`,
      [TENANT, REF_TABLE],
    )
  )[0];
  expect(count).toBe(12000);
});

test("getSourceScanScalars returns per-refTable totals joined against map_<refTable>", async () => {
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
    `INSERT INTO zugzug_app.reference_table
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, 'Color', 'zugzug_app.dim_test_color',
             'zugzug_app.map_test_color', 'color_code', current_timestamp, $2)
     ON CONFLICT DO NOTHING`,
    [REF_TABLE, TENANT],
  );

  await materializeSourceScanValues(REF_TABLE, TENANT, {
    occurrences: [
      { raw: "Red", table: "raw.a", column: "c", rows: 100 },
      { raw: "Blue", table: "raw.a", column: "c", rows: 50 },
      { raw: "Green", table: "raw.a", column: "c", rows: 30 },
    ],
    scannedAt: new Date("2026-06-17T10:00:00Z"),
  });

  const scalars = await getSourceScanScalars(TENANT);
  const row = scalars.find((r) => r.refTableId === REF_TABLE);
  expect(row).toBeDefined();
  expect(row!.totalDistinct).toBe(3);
  expect(row!.mappedCount).toBe(1);
  expect(row!.newCount).toBe(2);
  expect(row!.mappedRowsTotal).toBe(100);
  expect(row!.unmappedRowsTotal).toBe(80);
  expect(row!.scannedAt).toBeInstanceOf(Date);
});

test("getSourceScanValuesPage paginates unmapped first by total_rows desc", async () => {
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.map_test_color
               (tenant_id varchar, raw varchar, color_code varchar)`);
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.dim_test_color
               (color_code varchar PRIMARY KEY, label varchar)`);
  await pgRun(
    `INSERT INTO zugzug_app.reference_table
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, 'Color', 'zugzug_app.dim_test_color',
             'zugzug_app.map_test_color', 'color_code', current_timestamp, $2)
     ON CONFLICT DO NOTHING`,
    [REF_TABLE, TENANT],
  );

  await materializeSourceScanValues(REF_TABLE, TENANT, {
    occurrences: Array.from({ length: 30 }, (_, i) => ({
      raw: `v${String(i).padStart(2, "0")}`,
      table: "raw.a",
      column: "c",
      rows: 1000 - i,
    })),
    scannedAt: new Date(),
  });

  const page1 = await getSourceScanValuesPage(TENANT, REF_TABLE, { filter: "new", limit: 10 });
  expect(page1.items).toHaveLength(10);
  expect(page1.items[0].raw).toBe("v00");
  expect(page1.items[9].raw).toBe("v09");
  expect(page1.hasMore).toBe(true);

  const page2 = await getSourceScanValuesPage(TENANT, REF_TABLE, {
    filter: "new",
    limit: 10,
    after: page1.nextCursor,
  });
  expect(page2.items[0].raw).toBe("v10");
});

test("getSourceScanValuesPage q substring matches case-insensitively", async () => {
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.map_test_color
               (tenant_id varchar, raw varchar, color_code varchar)`);
  await pgRun(`CREATE TABLE IF NOT EXISTS zugzug_app.dim_test_color
               (color_code varchar PRIMARY KEY, label varchar)`);
  await pgRun(
    `INSERT INTO zugzug_app.reference_table
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, 'Color', 'zugzug_app.dim_test_color',
             'zugzug_app.map_test_color', 'color_code', current_timestamp, $2)
     ON CONFLICT DO NOTHING`,
    [REF_TABLE, TENANT],
  );

  await materializeSourceScanValues(REF_TABLE, TENANT, {
    occurrences: [
      { raw: "ACME Corp", table: "raw.a", column: "c", rows: 10 },
      { raw: "acme Inc", table: "raw.a", column: "c", rows: 20 },
      { raw: "Globex", table: "raw.a", column: "c", rows: 30 },
    ],
    scannedAt: new Date(),
  });

  const page = await getSourceScanValuesPage(TENANT, REF_TABLE, {
    filter: "all",
    limit: 50,
    q: "acme",
  });
  expect(page.items.map((i) => i.raw).sort()).toEqual(["ACME Corp", "acme Inc"]);
});
