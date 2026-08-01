import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { isWarehousePopulated } from "./seed-warehouse.ts";

let dir = "";
let holderScript = "";

/** Opens the db READ_ONLY, prints READY, then waits to be killed. Mirrors the
 *  holder in warehouse/duckdb/concurrency.test.ts. */
const HOLDER = `
import { DuckDBInstance } from "@duckdb/node-api";
const i = await DuckDBInstance.create(process.argv[2], { access_mode: "READ_ONLY" });
await i.connect();
console.log("READY");
await new Promise((r) => setTimeout(r, 30000));
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zz-probe-"));
  holderScript = join(dir, "holder.ts");
  writeFileSync(holderScript, HOLDER);
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

  it("the missing-file guard returns before ever touching DuckDB", async () => {
    const p = join(dir, "untouched.duckdb");
    await isWarehousePopulated(p);
    expect(await Bun.file(p).exists()).toBe(false);
  });

  it("still reads true while a second process holds the file READ_ONLY", async () => {
    const p = join(dir, "held.duckdb");
    const i = await DuckDBInstance.create(p);
    const c = await i.connect();
    await c.run("CREATE SCHEMA raw");
    await c.run("CREATE TABLE raw.orders AS SELECT 1 AS a");
    c.disconnectSync();
    i.closeSync();

    const proc = Bun.spawn(["bun", "run", holderScript, p], { stdout: "pipe" });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    try {
      while (!seen.includes("READY")) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`holder exited before READY: ${seen}`);
        seen += decoder.decode(value);
      }
      // If isWarehousePopulated ever drops { access_mode: "READ_ONLY" }, this
      // open collides with the holder's lock, the error is swallowed by the
      // probe's catch, and the assertion below fails.
      expect(await isWarehousePopulated(p)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
