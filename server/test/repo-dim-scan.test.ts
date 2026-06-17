process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { pgRun, pgAll } from "../src/pg.ts";
import { materializeDimScanValues } from "../src/repo-dim-scan.ts";

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
  await pgRun(`DELETE FROM zugzug_app.tenant              WHERE id        = $1`, [TENANT]);
});

beforeEach(async () => {
  await pgRun(`DELETE FROM zugzug_app.dim_scan_occurrence WHERE tenant_id = $1`, [TENANT]);
  await pgRun(`DELETE FROM zugzug_app.dim_scan_value      WHERE tenant_id = $1`, [TENANT]);
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
