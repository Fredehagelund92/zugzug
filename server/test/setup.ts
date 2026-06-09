import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolve } from "node:path";
import { registerFactories } from "../src/warehouse/credentials.ts";
import { createDuckDbAdapter } from "../src/warehouse/duckdb/index.ts";

// Register adapter factories once for all tests. Mirror of production
// startup in server.ts. Tests run with ATTACH_WAREHOUSE=false so the DuckDB
// adapter operates on an in-memory connection — every tableExists() call
// returns false because no warehouse tables exist in `:memory:`.
registerFactories({
  duckdb: async (creds) => createDuckDbAdapter(creds),
  snowflake: async () => {
    throw new Error("Snowflake adapter ships in Phase 2");
  },
});

export const TEST_DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";

/** Drop all app/canonical schemas + the drizzle migration journal, then re-run
 *  migrations. Each test that needs a clean slate calls this in beforeEach.
 *  Dropping the journal is the key — without it, drizzle thinks the baseline
 *  is already applied and skips it, leaving the schemas empty. */
export async function resetDb(): Promise<void> {
  const sql = postgres(TEST_DATABASE_URL, { max: 1 });
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
