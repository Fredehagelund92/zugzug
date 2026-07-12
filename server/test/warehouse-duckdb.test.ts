process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect } from "bun:test";
import { DuckDbReadOnlyAdapter } from "../src/warehouse/duckdb/index.ts";

test("quoteIdentifier escapes embedded double quotes", () => {
  const a = new DuckDbReadOnlyAdapter({
    type: "duckdb",
    path: ":memory:",
    database: "analytics",
    attached: false,
  });
  expect(a.quoteIdentifier("foo")).toBe('"foo"');
  expect(a.quoteIdentifier('weird"name')).toBe('"weird""name"');
});

test("qualifyRef builds catalog.schema.table when database set", () => {
  const a = new DuckDbReadOnlyAdapter({
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
  const a = new DuckDbReadOnlyAdapter({ type: "duckdb", path: ":memory:", attached: false });
  expect(a.qualifyRef({ schema: "main", table: "t" })).toBe('"main"."t"');
});

test("qualifyRef throws for MotherDuck creds with no catalog", () => {
  const a = new DuckDbReadOnlyAdapter({
    type: "duckdb",
    token: "md-token",
    attached: true,
  });
  expect(() => a.qualifyRef({ schema: "raw", table: "partners" })).toThrow(/missing catalog/);
});

test("castToString wraps in CAST(... AS VARCHAR)", () => {
  const a = new DuckDbReadOnlyAdapter({ type: "duckdb", path: ":memory:", attached: false });
  expect(a.castToString('"col"')).toBe('CAST("col" AS VARCHAR)');
});

test("capabilities are read-only DuckDB defaults when not attached", () => {
  const a = new DuckDbReadOnlyAdapter({ type: "duckdb", path: ":memory:", attached: false });
  expect(a.capabilities.id).toBe("duckdb");
  expect(a.capabilities.writable).toBe(false);
  expect(a.capabilities.identifierCase).toBe("preserve");
});

test("ping returns true with in-memory connection", async () => {
  const a = new DuckDbReadOnlyAdapter({ type: "duckdb", path: ":memory:", attached: false });
  await expect(a.ping()).resolves.toBe(true);
});

// Set up a small in-memory dataset shared across query tests.
async function withFixture(): Promise<DuckDbReadOnlyAdapter> {
  const a = new DuckDbReadOnlyAdapter({ type: "duckdb", path: ":memory:", attached: false });
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
  const tables = await a.listTables({ schema: "raw", database: "memory" });
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

test("nameResolution: duplicate ids — last-write-wins, but caller gets a value", async () => {
  const a = new DuckDbReadOnlyAdapter({ type: "duckdb", path: ":memory:", attached: false });
  // @ts-expect-error — private connect()
  const c = await a["connect"]();
  await c.run(`CREATE TABLE dupes (code VARCHAR, label VARCHAR)`);
  await c.run(`INSERT INTO dupes VALUES ('US', 'United States'), ('US', 'USA')`);
  const m = await a.nameResolution({ schema: "main", table: "dupes" }, "code", "label");
  expect(m.size).toBe(1);
  const v = m.get("US");
  expect(["United States", "USA"]).toContain(v);
});

test("nameResolution: null ids are filtered, not present as a null Map key", async () => {
  const a = new DuckDbReadOnlyAdapter({ type: "duckdb", path: ":memory:", attached: false });
  // @ts-expect-error — private connect()
  const c = await a["connect"]();
  await c.run(`CREATE TABLE has_nulls (code VARCHAR, label VARCHAR)`);
  await c.run(`INSERT INTO has_nulls VALUES ('A', 'alpha'), (NULL, 'orphan'), ('B', 'beta')`);
  const m = await a.nameResolution({ schema: "main", table: "has_nulls" }, "code", "label");
  expect(m.size).toBe(2);
  expect(m.get("A")).toBe("alpha");
  expect(m.get("B")).toBe("beta");
  // @ts-expect-error — null is not assignable to string but we want to verify it's not present
  expect(m.has(null)).toBe(false);
});

test("listTables: search filters across schema, table name, and column names", async () => {
  const a = await withFixture();

  // Search by schema name (matches everything in `raw`)
  const bySchema = await a.listTables({ search: "raw", database: "memory" });
  expect(bySchema.length).toBeGreaterThanOrEqual(2); // partners + countries

  // Search by table name fragment
  const byTable = await a.listTables({ search: "partner", database: "memory" });
  expect(byTable.some((t) => t.table === "partners")).toBe(true);
  expect(byTable.some((t) => t.table === "countries")).toBe(false);

  // Search by column name (only `partners` has a `region` column)
  const byColumn = await a.listTables({ search: "region", database: "memory" });
  expect(byColumn.some((t) => t.table === "partners")).toBe(true);
  expect(byColumn.some((t) => t.table === "countries")).toBe(false);

  // Qualified "schema.table" search matches schema and table parts together
  const qualified = await a.listTables({ search: "raw.partner", database: "memory" });
  expect(qualified.some((t) => t.schema === "raw" && t.table === "partners")).toBe(true);
  expect(qualified.some((t) => t.table === "countries")).toBe(false);
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

import { DuckDbWritableAdapter } from "../src/warehouse/duckdb/index.ts";

test("DuckDbWritableAdapter: ensureCanonicalTables creates dim_ and map_ idempotently", async () => {
  const a = new DuckDbWritableAdapter({ type: "duckdb", path: ":memory:", attached: false, writable: true });
  // Need a schema to host the tables (default catalog is "memory" for :memory: db)
  // @ts-expect-error — private connect()
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);

  await a.ensureCanonicalTables({
    dimId: "country",
    dimTable: "zugzug.dim_country",
    mapTable: "zugzug.map_country",
    keyCol: "country_code",
  });

  // Tables exist; calling again is a no-op (no error).
  await a.ensureCanonicalTables({
    dimId: "country",
    dimTable: "zugzug.dim_country",
    mapTable: "zugzug.map_country",
    keyCol: "country_code",
  });

  // Insert sample row to confirm the schema accepted the CREATEs
  await c.run(`INSERT INTO zugzug.dim_country ("country_code", label) VALUES ('US', 'United States')`);
  await c.run(`INSERT INTO zugzug.map_country (raw, "country_code") VALUES ('USA', 'US')`);

  const dimRows = await c.runAndReadAll(`SELECT * FROM zugzug.dim_country`);
  expect(dimRows.getRowObjects()).toEqual([{ country_code: "US", label: "United States" }]);
  const mapRows = await c.runAndReadAll(`SELECT * FROM zugzug.map_country`);
  expect(mapRows.getRowObjects()).toEqual([{ raw: "USA", country_code: "US" }]);
});

test("DuckDbWritableAdapter: commitCanonical empty drafts returns rowsWritten=0 with no SQL", async () => {
  const a = new DuckDbWritableAdapter({ type: "duckdb", path: ":memory:", attached: false, writable: true });
  // @ts-expect-error
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await a.ensureCanonicalTables({
    dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code",
  });

  const result = await a.commitCanonical(
    { dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code" },
    [],
  );
  expect(result.rowsWritten).toBe(0);

  const rows = await c.runAndReadAll(`SELECT count(*) AS n FROM zugzug.dim_country`);
  expect(rows.getRowObjects()).toEqual([{ n: 0n }]);
});

test("DuckDbWritableAdapter: commitCanonical writes dim + map rows via MERGE", async () => {
  const a = new DuckDbWritableAdapter({ type: "duckdb", path: ":memory:", attached: false, writable: true });
  // @ts-expect-error
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await a.ensureCanonicalTables({
    dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code",
  });

  await a.commitCanonical(
    { dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code" },
    [
      { raw: "USA", key: "US", label: "United States" },
      { raw: "U.S.", key: "US", label: "United States" },
      { raw: "United Kingdom", key: "GB", label: "United Kingdom" },
    ],
  );

  // dim_country: deduped by key (2 unique keys: US, GB)
  const dimRows = await c.runAndReadAll(`SELECT * FROM zugzug.dim_country ORDER BY "country_code"`);
  expect(dimRows.getRowObjects()).toEqual([
    { country_code: "GB", label: "United Kingdom" },
    { country_code: "US", label: "United States" },
  ]);

  // map_country: one row per draft (3 rows)
  const mapRows = await c.runAndReadAll(`SELECT * FROM zugzug.map_country ORDER BY raw`);
  expect(mapRows.getRowObjects()).toEqual([
    { raw: "U.S.", country_code: "US" },
    { raw: "USA", country_code: "US" },
    { raw: "United Kingdom", country_code: "GB" },
  ]);
});

test("DuckDbWritableAdapter: commitCanonical is idempotent on repeat", async () => {
  const a = new DuckDbWritableAdapter({ type: "duckdb", path: ":memory:", attached: false, writable: true });
  // @ts-expect-error
  const c = await a["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await a.ensureCanonicalTables({
    dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code",
  });

  const drafts = [{ raw: "USA", key: "US", label: "United States" }];
  await a.commitCanonical(
    { dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code" },
    drafts,
  );
  // Calling again with the same drafts is a no-op (MERGE only inserts on no match).
  await a.commitCanonical(
    { dimId: "country", dimTable: "zugzug.dim_country", mapTable: "zugzug.map_country", keyCol: "country_code" },
    drafts,
  );

  const dimRows = await c.runAndReadAll(`SELECT count(*) AS n FROM zugzug.dim_country`);
  expect(dimRows.getRowObjects()).toEqual([{ n: 1n }]);
  const mapRows = await c.runAndReadAll(`SELECT count(*) AS n FROM zugzug.map_country`);
  expect(mapRows.getRowObjects()).toEqual([{ n: 1n }]);
});
