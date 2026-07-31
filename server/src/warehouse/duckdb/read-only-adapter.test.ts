import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckDbReadOnlyAdapter } from "./read-only.ts";

// #217 follow-up: read-only.ts is excluded from coverage (bunfig.toml
// coveragePathIgnorePatterns), so nothing else proves the READ_ONLY adapter
// can actually read real data. Build a real DuckDB file, close the writer
// fully, then read it back through DuckDbReadOnlyAdapter.

let dir = "";
let dbPath = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "zz-duck-ro-"));
  dbPath = join(dir, "wh.duckdb");
  const inst = await DuckDBInstance.create(dbPath);
  const conn = await inst.connect();
  await conn.run("CREATE SCHEMA raw");
  await conn.run("CREATE TABLE raw.widgets AS SELECT * FROM (VALUES ('a'), ('b'), ('a')) t(name)");
  conn.disconnectSync();
  inst.closeSync();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("DuckDbReadOnlyAdapter", () => {
  it("lists tables and reads distinct values from a real read-only file", async () => {
    const adapter = new DuckDbReadOnlyAdapter({
      type: "duckdb",
      path: dbPath,
      attached: true,
      writable: false,
    });

    const databases = await adapter.listDatabases();
    const tables = await adapter.listTables({ database: databases[0]?.databaseName });
    expect(tables.some((t) => t.schema === "raw" && t.table === "widgets")).toBe(true);

    const values = await adapter.distinctValues({ schema: "raw", table: "widgets" }, "name", 10);
    expect(values.sort()).toEqual(["a", "b"]);
  });
});
