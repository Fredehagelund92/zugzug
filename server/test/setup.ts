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

/* Migration 0021 (multi-database warehouse) has a preflight that RAISES if
   no super-admin exists in zugzug_app.users. In production a super-admin is
   created by the bootstrap script before any migration runs; in tests the
   `resetDb()` flow truncates everything and then re-applies migrations from
   scratch — leaving no admin for 0021 to find.

   We hand-walk the migration journal so we can slot a super-admin INSERT
   between migrations 0020 and 0021. The walker also SETs `zugzug.warehouse_db`
   (also required by 0021's preflight C) once per connection. */
const TEST_ADMIN_ID = "u_test_admin";

/** Drop all app/canonical schemas, then re-apply migrations in order with a
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
      const idxMatch = /^(\d+)_/.exec(file);
      const idx = idxMatch ? parseInt(idxMatch[1]!, 10) : -1;

      // Seed the super-admin RIGHT BEFORE migration 0021 runs — by then
      // 0000_baseline has already created zugzug_app.users (line 98 of that
      // file). The INSERT supplies all NOT NULL columns the schema declares.
      if (idx === 21) {
        await sql`
          INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
          VALUES (${TEST_ADMIN_ID}, 'Test Admin', 'admin@test.local', 'TA', true)
          ON CONFLICT (id) DO NOTHING
        `;
      }

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

    // Remove the seed admin once migrations are done. Tests rely on
    // count(users) === 0 to trigger the "first user becomes admin" path of
    // handleSignup; leaving the seed admin around would 403 every new signup.
    // warehouse_connection.created_by and warehouse_database.added_by are
    // plain varchar without REFERENCES, so the deletion leaves no FK dangling
    // (matches the existing convention used for canonical_version.updated_by).
    await sql`DELETE FROM "zugzug_app"."users" WHERE id = ${TEST_ADMIN_ID}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
