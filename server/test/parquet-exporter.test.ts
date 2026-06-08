process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { withExporterConn, exportCanonicalToParquet } from "../src/warehouse/parquet-exporter.ts";
import { resetDb } from "./setup.ts";

beforeEach(async () => {
  await resetDb();
});

test("withExporterConn provides a working DuckDB connection", async () => {
  const result = await withExporterConn(async (conn) => {
    const r = await conn.runAndReadAll("SELECT 42 AS answer");
    return r.getRowObjects();
  });
  expect(result).toEqual([{ answer: 42 }]);
});

test("withExporterConn reuses the same in-process instance across calls", async () => {
  // Create a temp table in one call, read it in the next.
  await withExporterConn(async (conn) => {
    await conn.run(`CREATE OR REPLACE TABLE _shared_test (n INTEGER)`);
    await conn.run(`INSERT INTO _shared_test VALUES (1), (2), (3)`);
  });
  const rows = await withExporterConn(async (conn) => {
    const r = await conn.runAndReadAll(`SELECT count(*) AS n FROM _shared_test`);
    return r.getRowObjects();
  });
  expect(rows).toEqual([{ n: 3n }]); // DuckDB count returns bigint
  await withExporterConn(async (conn) => {
    await conn.run(`DROP TABLE _shared_test`);
  });
});

test("exportCanonicalToParquet: empty map table emits valid empty Parquet", async () => {
  const { pgRun } = await import("../src/pg.ts");
  await pgRun(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await pgRun(
    `CREATE TABLE zugzug.map_empty_test (raw VARCHAR PRIMARY KEY, country_code VARCHAR NOT NULL)`,
  );

  const buf = await exportCanonicalToParquet({
    dimId: "empty_test",
    dimTable: "zugzug.dim_empty_test",
    mapTable: "zugzug.map_empty_test",
    keyCol: "country_code",
  });

  // Parquet magic header is "PAR1" at the start AND end of the file.
  expect(buf.length).toBeGreaterThan(8);
  expect(buf.subarray(0, 4).toString()).toBe("PAR1");
  expect(buf.subarray(buf.length - 4).toString()).toBe("PAR1");
});

test("exportCanonicalToParquet: populated map table round-trips through DuckDB", async () => {
  const { pgRun } = await import("../src/pg.ts");
  await pgRun(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await pgRun(
    `CREATE TABLE zugzug.map_country (raw VARCHAR PRIMARY KEY, country_code VARCHAR NOT NULL)`,
  );
  await pgRun(`INSERT INTO zugzug.map_country (raw, country_code) VALUES
                ($1, $2), ($3, $4), ($5, $6)`,
    ["USA", "US", "U.S.", "US", "United Kingdom", "GB"]);

  const buf = await exportCanonicalToParquet({
    dimId: "country",
    dimTable: "zugzug.dim_country",
    mapTable: "zugzug.map_country",
    keyCol: "country_code",
  });

  // Write the buffer to a tmp file and read it back via DuckDB.
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const tmpPath = "/tmp/zugzug-parquet-test.parquet";
  writeFileSync(tmpPath, buf);

  try {
    const rows = await withExporterConn(async (conn) => {
      const r = await conn.runAndReadAll(`SELECT * FROM read_parquet('${tmpPath}') ORDER BY raw`);
      return r.getRowObjects();
    });
    expect(rows).toEqual([
      { raw: "U.S.", country_code: "US" },
      { raw: "USA", country_code: "US" },
      { raw: "United Kingdom", country_code: "GB" },
    ]);
  } finally {
    unlinkSync(tmpPath);
  }
});

test("exportCanonicalToParquet: respects keyCol naming (column name reflects dim key)", async () => {
  const { pgRun } = await import("../src/pg.ts");
  await pgRun(`CREATE SCHEMA IF NOT EXISTS zugzug`);
  await pgRun(
    `CREATE TABLE zugzug.map_partner (raw VARCHAR PRIMARY KEY, partner_id VARCHAR NOT NULL)`,
  );
  await pgRun(`INSERT INTO zugzug.map_partner (raw, partner_id) VALUES ($1, $2)`, ["acme", "P-001"]);

  const buf = await exportCanonicalToParquet({
    dimId: "partner",
    dimTable: "zugzug.dim_partner",
    mapTable: "zugzug.map_partner",
    keyCol: "partner_id",
  });
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const tmpPath = "/tmp/zugzug-parquet-keycol-test.parquet";
  writeFileSync(tmpPath, buf);
  try {
    const rows = await withExporterConn(async (conn) => {
      const r = await conn.runAndReadAll(`SELECT * FROM read_parquet('${tmpPath}')`);
      return r.getRowObjects();
    });
    expect(rows).toEqual([{ raw: "acme", partner_id: "P-001" }]);
  } finally {
    unlinkSync(tmpPath);
  }
});
