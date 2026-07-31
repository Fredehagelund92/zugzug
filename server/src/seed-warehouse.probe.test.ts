import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { isWarehousePopulated } from "./seed-warehouse.ts";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zz-probe-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("isWarehousePopulated", () => {
  it("is false for a file that does not exist", async () => {
    expect(await isWarehousePopulated(join(dir, "absent.duckdb"))).toBe(false);
  });

  it("is false for an empty warehouse", async () => {
    const p = join(dir, "empty.duckdb");
    const i = await DuckDBInstance.create(p);
    (await i.connect()).disconnectSync();
    expect(await isWarehousePopulated(p)).toBe(false);
  });

  it("is true once the raw schema has tables", async () => {
    const p = join(dir, "full.duckdb");
    const i = await DuckDBInstance.create(p);
    const c = await i.connect();
    await c.run("CREATE SCHEMA raw");
    await c.run("CREATE TABLE raw.orders AS SELECT 1 AS a");
    c.disconnectSync();
    expect(await isWarehousePopulated(p)).toBe(true);
  });

  it("does not create a file it was asked about", async () => {
    const p = join(dir, "untouched.duckdb");
    await isWarehousePopulated(p);
    expect(await Bun.file(p).exists()).toBe(false);
  });
});
