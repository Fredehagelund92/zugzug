/* bootstrap.ts — provision the stores.
   • runs Drizzle migrations to ensure the Postgres app-state schema
   • seeds system data (default preferences + u_system user)
   • `--seed` also registers the demo Country/Channel dimensions */

import { runMigrations } from "../drizzle/migrate.ts";
import { seedDemo } from "./seed.ts";
import { pgRun, pgGet } from "./pg.ts";
import { registerFactories } from "./warehouse/credentials.ts";
import { DuckDbAdapter } from "./warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "./warehouse/snowflake/index.ts";
import { getAdapter } from "./warehouse/registry.ts";

const seed = process.argv.includes("--seed");

registerFactories({
  duckdb: async (creds) => new DuckDbAdapter(creds),
  snowflake: async (creds) => new SnowflakeAdapter(creds),
});

console.log("\nZug Zug — bootstrap\n");

await runMigrations();

// Seed system data (idempotent — safe to re-run)
await pgRun(
  `INSERT INTO "zugzug_app"."preferences" (id, publish_threshold, suggest_threshold, updated_at)
   VALUES (1, 95, 80, current_timestamp)
   ON CONFLICT (id) DO NOTHING`,
);
await pgRun(
  `INSERT INTO "zugzug_app"."users" (id, name, initials)
   VALUES ('u_system', 'Auto-match', 'AM')
   ON CONFLICT (id) DO NOTHING`,
);

// Seed demo team if users table is empty (first bootstrap only)
const { n } = (await pgGet<{ n: number }>(
  `SELECT count(*)::int AS n FROM "zugzug_app"."users"`,
)) ?? { n: 0 };
if (n <= 1) {
  const DEFAULT_USERS = [
    { id: "u_ada", name: "Ada Berg", initials: "AB" },
    { id: "u_li", name: "Li Bauer", initials: "LB" },
    { id: "u_cory", name: "Cory Mills", initials: "CM" },
  ];
  for (const u of DEFAULT_USERS) {
    await pgRun(
      `INSERT INTO "zugzug_app"."users" (id, name, initials) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name, u.initials],
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."active_sessions" (user_id, last_seen) VALUES ($1, current_timestamp) ON CONFLICT (user_id) DO NOTHING`,
      [u.id],
    );
  }
  console.log("· demo team seeded (Ada, Li, Cory)");
}

if (seed) {
  await getAdapter(); // warm the connection
  await seedDemo();
  console.log("· demo dimensions seeded (Country, Channel)");
}

console.log("\nDone.\n");
process.exit(0);
