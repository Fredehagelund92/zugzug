import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { env } from "../src/env.ts";

export async function runMigrations(): Promise<void> {
  const client = postgres(env.databaseUrl, { max: 1 });
  // Set the warehouse_db session var so the warehouse-multi-db migration's
  // preflight can read current_setting('zugzug.warehouse_db', true) without
  // depending on out-of-band psql -v flags.
  await client.unsafe(`SET zugzug.warehouse_db = '${env.warehouseDb.replace(/'/g, "''")}'`);
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: resolve(import.meta.dir, "migrations"),
  });
  await client.end();
  console.log("· Postgres migrations applied");
}

// Allow direct execution: `bun run drizzle/migrate.ts`
if (import.meta.main) {
  await runMigrations();
}
