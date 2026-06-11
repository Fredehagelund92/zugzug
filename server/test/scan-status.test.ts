// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
const TEST_DB_URL = "postgres://zugzug:zugzug@localhost:55433/zugzug_test";
process.env.DATABASE_URL = TEST_DB_URL;
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { describe, test, expect, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolve } from "node:path";
import { registerFactories } from "../src/warehouse/credentials.ts";
import { createDuckDbAdapter } from "../src/warehouse/duckdb/index.ts";
import { scanStatus } from "../src/repo-scan.ts";
import { appendAuditAs } from "../src/repo-meta.ts";

// Register adapter factories once — mirrors production startup and setup.ts.
registerFactories({
  duckdb: async (creds) => createDuckDbAdapter(creds),
  snowflake: async () => {
    throw new Error("Snowflake adapter ships in Phase 2");
  },
});

/** Drop all app/canonical schemas + drizzle journal, then re-run migrations
 *  against the throwaway Postgres on port 55433. */
async function resetDb(): Promise<void> {
  const sql = postgres(TEST_DB_URL, { max: 1 });
  try {
    await sql`DROP SCHEMA IF EXISTS zugzug_app CASCADE`;
    await sql`DROP SCHEMA IF EXISTS zugzug CASCADE`;
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle/migrations") });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeEach(async () => {
  await resetDb();
});

describe("scanStatus auto-publish fields", () => {
  test("reports null when no u_system Committed audit entry exists", async () => {
    const s = await scanStatus();
    expect(s.lastAutoPublishAt).toBeNull();
    expect(s.lastAutoPublishDetail).toBeNull();
  });

  test("reports the latest u_system Committed audit entry", async () => {
    await appendAuditAs("u_system", "Committed", "2 values → zugzug.map_test · 14 rows recovered");
    const s = await scanStatus();
    expect(s.lastAutoPublishAt).not.toBeNull();
    expect(s.lastAutoPublishDetail).toContain("rows recovered");
  });

  test("returns the most recent entry when multiple u_system Committed rows exist", async () => {
    await appendAuditAs("u_system", "Committed", "1 values → zugzug.map_first · 5 rows recovered");
    await appendAuditAs("u_system", "Committed", "3 values → zugzug.map_second · 20 rows recovered");
    const s = await scanStatus();
    expect(s.lastAutoPublishDetail).toContain("map_second");
  });

  test("ignores non-Committed actions by u_system", async () => {
    await appendAuditAs("u_system", "Scanned", "some scan detail");
    const s = await scanStatus();
    expect(s.lastAutoPublishAt).toBeNull();
    expect(s.lastAutoPublishDetail).toBeNull();
  });

  test("ignores Committed actions by non-system users", async () => {
    await appendAuditAs("u_human", "Committed", "2 values → zugzug.map_test · 10 rows recovered");
    const s = await scanStatus();
    expect(s.lastAutoPublishAt).toBeNull();
    expect(s.lastAutoPublishDetail).toBeNull();
  });
});
