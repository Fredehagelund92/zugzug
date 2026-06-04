import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolve } from "node:path";

export const TEST_DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";

/** Drop all app/canonical schemas, then re-run migrations. Each test that needs
 *  a clean slate calls this in beforeEach. */
export async function resetDb(): Promise<void> {
  const sql = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    await sql`DROP SCHEMA IF EXISTS zugzug_app CASCADE`;
    await sql`DROP SCHEMA IF EXISTS zugzug CASCADE`;
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle/migrations") });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
