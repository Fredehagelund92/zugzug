import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

let dir = "";
let dbPath = "";
let holderScript = "";

/** Opens the db in the given mode, prints READY, then waits to be killed. */
const HOLDER = `
import { DuckDBInstance } from "@duckdb/node-api";
const ro = process.argv[3] === "ro";
const i = await DuckDBInstance.create(process.argv[2], ro ? { access_mode: "READ_ONLY" } : {});
await i.connect();
console.log("READY");
await new Promise((r) => setTimeout(r, 30000));
`;

async function withHolder<T>(mode: "ro" | "rw", fn: () => Promise<T>): Promise<T> {
  const proc = Bun.spawn(["bun", "run", holderScript, dbPath, mode], { stdout: "pipe" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("READY")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder exited before READY: ${seen}`);
    seen += decoder.decode(value);
  }
  try {
    return await fn();
  } finally {
    proc.kill();
    await proc.exited;
  }
}

async function tryOpen(mode: "ro" | "rw"): Promise<"ok" | "locked"> {
  try {
    const i = await DuckDBInstance.create(
      dbPath,
      mode === "ro" ? { access_mode: "READ_ONLY" } : {},
    );
    const c = await i.connect();
    await c.runAndReadAll("SELECT 1");
    c.disconnectSync();
    return "ok";
  } catch (e) {
    if (e instanceof Error && e.message.includes("Conflicting lock")) return "locked";
    throw e;
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "zz-duck-"));
  dbPath = join(dir, "wh.duckdb");
  holderScript = join(dir, "holder.ts");
  writeFileSync(holderScript, HOLDER);
  const i = await DuckDBInstance.create(dbPath);
  const c = await i.connect();
  await c.run("CREATE SCHEMA IF NOT EXISTS raw");
  await c.run("CREATE TABLE raw.t AS SELECT 1 AS a");
  c.disconnectSync();
  i.closeSync();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("DuckDB file locking", () => {
  it("allows a second READ_ONLY handle alongside a READ_ONLY holder", async () => {
    expect(await withHolder("ro", () => tryOpen("ro"))).toBe("ok");
  });

  it("still excludes a read-write opener while a READ_ONLY handle is held", async () => {
    expect(await withHolder("ro", () => tryOpen("rw"))).toBe("locked");
  });

  it("excludes everything while a read-write handle is held", async () => {
    expect(await withHolder("rw", () => tryOpen("ro"))).toBe("locked");
    expect(await withHolder("rw", () => tryOpen("rw"))).toBe("locked");
  });

  // Safety after an unclean shutdown: DuckDB cannot *replay* a WAL in read-only
  // mode, but it does reconstruct committed state in memory. If this ever stops
  // holding, a server killed mid-write would fail to reattach on restart.
  it("reads committed rows through a hot WAL", async () => {
    const p = join(dir, "hot.duckdb");
    const proc = Bun.spawn([
      "bun",
      "-e",
      `import { DuckDBInstance } from "@duckdb/node-api";
       const i = await DuckDBInstance.create(${JSON.stringify(p)});
       const c = await i.connect();
       await c.run("CREATE SCHEMA raw");
       await c.run("CREATE TABLE raw.t AS SELECT range AS a FROM range(50000)");
       process.kill(process.pid, "SIGKILL");`,
    ]);
    await proc.exited;
    const i = await DuckDBInstance.create(p, { access_mode: "READ_ONLY" });
    const c = await i.connect();
    const r = await c.runAndReadAll("SELECT count(*) FROM raw.t");
    expect(Number(r.getRows()[0][0])).toBe(50000);
    c.disconnectSync();
  });
});
