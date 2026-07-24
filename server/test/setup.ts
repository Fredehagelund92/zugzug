import postgres from "postgres";
import { resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
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

/* Migration 0021 (multi-database warehouse) needs zugzug.warehouse_db set
   on the connection for preflight C. We hand-walk the migration journal so
   the SET happens once per connection before any migration runs. Preflight A
   used to require a super-admin user too; that's been relaxed to skip when
   no users exist, so this walker no longer seeds one. */

/** Drop all app/record schemas, then re-apply migrations in order with a
 *  test super-admin seeded between 0020 and 0021. Each test that needs a
 *  clean slate calls this in beforeEach. */
export async function resetDb(): Promise<void> {
  const sql = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    await sql`DROP SCHEMA IF EXISTS zugzug_app CASCADE`;
    await sql`DROP SCHEMA IF EXISTS zugzug CASCADE`;
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;

    await sql`CREATE SCHEMA drizzle`;
    await sql`CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`;

    // Migration 0021 preflight C requires this session var.
    await sql`SET zugzug.warehouse_db = 'default'`;

    const migrationsFolder = resolve(import.meta.dir, "../drizzle/migrations");
    const files = readdirSync(migrationsFolder)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const content = readFileSync(`${migrationsFolder}/${file}`, "utf8");
      // drizzle splits its multi-statement migrations on `--> statement-breakpoint`.
      const statements = content
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await sql.unsafe(stmt);
      }

      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${file.replace(/\.sql$/, "")}, ${Date.now()})
      `;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
