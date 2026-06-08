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
