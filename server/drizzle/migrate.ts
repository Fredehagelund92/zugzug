import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { env } from "../src/env.ts";

export async function runMigrations(): Promise<void> {
  const client = postgres(env.databaseUrl, { max: 1 });
  // Legacy migration 0021 reads current_setting('zugzug.warehouse_db', true).
  // Only relevant on installs that still need the one-time backfill; on fresh
  // installs the migration's preflights skip when there are no rows to backfill.
  // We pass WAREHOUSE_DB through here for back-compat without re-introducing it
  // as a runtime config (env.warehouseDb is gone — UI registrations are source of truth).
  const legacyWarehouseDb = (process.env.WAREHOUSE_DB ?? "").trim();
  await client.unsafe(
    `SET zugzug.warehouse_db = '${legacyWarehouseDb.replace(/'/g, "''")}'`,
  );
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
