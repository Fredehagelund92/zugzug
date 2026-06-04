import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { env } from "../src/env.ts";

export async function runMigrations(): Promise<void> {
  const client = postgres(env.databaseUrl, { max: 1 });
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: resolve(import.meta.dir, "migrations"),
  });
  await client.end();
  console.log("· Postgres migrations applied");
}
