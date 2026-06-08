process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { DuckDbAdapter } from "../src/warehouse/duckdb/index.ts";

test("quoteIdentifier escapes embedded double quotes", () => {
  const a = new DuckDbAdapter({
    type: "duckdb",
    path: ":memory:",
    database: "analytics",
    attached: false,
  });
  expect(a.quoteIdentifier("foo")).toBe('"foo"');
  expect(a.quoteIdentifier('weird"name')).toBe('"weird""name"');
});

test("qualifyRef builds catalog.schema.table when database set", () => {
  const a = new DuckDbAdapter({
    type: "duckdb",
    path: ":memory:",
    database: "analytics",
    attached: false,
  });
  expect(a.qualifyRef({ schema: "raw", table: "partners" })).toBe(
    '"analytics"."raw"."partners"',
  );
});

test("qualifyRef builds schema.table when no database", () => {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  expect(a.qualifyRef({ schema: "main", table: "t" })).toBe('"main"."t"');
});

test("castToString wraps in CAST(... AS VARCHAR)", () => {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  expect(a.castToString('"col"')).toBe('CAST("col" AS VARCHAR)');
});

test("capabilities are read-only DuckDB defaults when not attached", () => {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  expect(a.capabilities.id).toBe("duckdb");
  expect(a.capabilities.writable).toBe(false);
  expect(a.capabilities.identifierCase).toBe("preserve");
});

test("ping returns true with in-memory connection", async () => {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  await expect(a.ping()).resolves.toBe(true);
});

// Set up a small in-memory dataset shared across query tests.
async function withFixture(): Promise<DuckDbAdapter> {
  const a = new DuckDbAdapter({ type: "duckdb", path: ":memory:", attached: false });
  // @ts-expect-error — test reaches into private connect() via a trampoline
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA raw`);
  await c.run(`CREATE TABLE raw.partners (id INTEGER, name VARCHAR, region VARCHAR)`);
  await c.run(
    `INSERT INTO raw.partners VALUES (1, 'Acme', 'US'), (2, 'Acme Inc', 'us'), (3, 'Foo', 'EU'), (4, '', NULL), (5, 'Bar', 'EU')`,
  );
  await c.run(`CREATE TABLE raw.countries (code VARCHAR, label VARCHAR)`);
  await c.run(`INSERT INTO raw.countries VALUES ('US', 'United States'), ('EU', 'European Union')`);
  return a;
}

test("tableExists returns true for existing, false for missing", async () => {
  const a = await withFixture();
  await expect(a.tableExists({ schema: "raw", table: "partners" })).resolves.toBe(true);
  await expect(a.tableExists({ schema: "raw", table: "nope" })).resolves.toBe(false);
});

test("listTables returns schema+table with columns inline", async () => {
  const a = await withFixture();
  const tables = await a.listTables({ schema: "raw" });
  const partners = tables.find((t) => t.table === "partners");
  expect(partners).toBeDefined();
  expect(partners?.schema).toBe("raw");
  expect(partners?.columns).toEqual(expect.arrayContaining(["id", "name", "region"]));
});

test("listColumns returns name + type", async () => {
  const a = await withFixture();
  const cols = await a.listColumns({ schema: "raw", table: "partners" });
  expect(cols.map((c) => c.name).sort()).toEqual(["id", "name", "region"]);
  expect(cols.find((c) => c.name === "id")?.type).toMatch(/INT/i);
});

test("distinctValues returns trimmed-non-empty distinct strings", async () => {
  const a = await withFixture();
  const vals = await a.distinctValues({ schema: "raw", table: "partners" }, "region", 100);
  // Empty/null filtered out. Case is preserved.
  expect(vals.sort()).toEqual(["EU", "US", "us"]);
});

test("topValuesByFrequency returns counts, sorted desc", async () => {
  const a = await withFixture();
  const top = await a.topValuesByFrequency({ schema: "raw", table: "partners" }, "region", 10);
  // EU appears 2× (rows 3, 5), US and us appear 1× each. Row 4 is empty → filtered.
  expect(top[0].value).toBe("EU");
  expect(top[0].count).toBe(2);
  expect(top.reduce((s, x) => s + x.count, 0)).toBe(4);
});

test("columnStats returns rows + distinct", async () => {
  const a = await withFixture();
  const s = await a.columnStats({ schema: "raw", table: "partners" }, "region");
  expect(s.rows).toBe(4); // row 4 (empty) filtered
  expect(s.distinct).toBe(3); // US, us, EU
});

test("nameResolution returns id→name Map", async () => {
  const a = await withFixture();
  const m = await a.nameResolution({ schema: "raw", table: "countries" }, "code", "label");
  expect(m.get("US")).toBe("United States");
  expect(m.get("EU")).toBe("European Union");
  expect(m.size).toBe(2);
});

test("distinctValuesWithProvenance merges multiple sources and tags sourceIndex", async () => {
  const a = await withFixture();
  const rows = await a.distinctValuesWithProvenance([
    { table: { schema: "raw", table: "partners" }, column: "region" }, // index 0
    { table: { schema: "raw", table: "countries" }, column: "code" }, // index 1
  ]);
  // Each source contributes raw value + count. EU appears 2× in partners, 1× in countries.
  const fromPartners = rows.filter((r) => r.sourceIndex === 0);
  const fromCountries = rows.filter((r) => r.sourceIndex === 1);
  expect(fromPartners.length).toBe(3); // US, us, EU
  expect(fromCountries.length).toBe(2); // US, EU
  expect(fromPartners.find((r) => r.value === "EU")?.count).toBe(2);
});
