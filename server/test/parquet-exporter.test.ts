process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { withExporterConn } from "../src/warehouse/parquet-exporter.ts";

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
