/* bootstrap.ts — provision the stores.
   • runs Drizzle migrations to ensure the Postgres app-state schema
   • seeds system data (u_system user)
   • `--seed` also registers the demo Country/Channel refTables */

import { runMigrations } from "../drizzle/migrate.ts";
import { seedDemo } from "./seed.ts";
import { generateDemoWarehouse } from "./seed-warehouse.ts";
import { pgRun, pgGet } from "./pg.ts";
import { provisionTenant } from "./tenant.ts";
import { registerFactories } from "./warehouse/credentials.ts";
import { createDuckDbAdapter } from "./warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "./warehouse/snowflake/index.ts";
import { env } from "./env.ts";

const seed = process.argv.includes("--seed");

registerFactories({
  duckdb: async (creds) => createDuckDbAdapter(creds),
  snowflake: async (creds) => new SnowflakeAdapter(creds),
});

console.log("\nZug Zug — bootstrap\n");

await runMigrations();

// Seed system data (idempotent — safe to re-run)
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
      `INSERT INTO "zugzug_app"."active_sessions" (user_id, last_seen, tenant_id) VALUES ($1, current_timestamp, 'default') ON CONFLICT (user_id) DO NOTHING`,
      [u.id],
    );
  }
  console.log("· demo team seeded (Ada, Li, Cory)");
}

if (seed) {
  // Ensure the default tenant exists with the env-configured database registered.
  // Migration 0011 creates the tenant row in normal flows; on a fresh
  // install with reset migrations this seed step is the explicit fallback.
  const defaultExists = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."tenant" WHERE id = 'default'`,
  );
  if (!defaultExists) {
    await provisionTenant({
      id: "default",
      label: "Demo workspace",
    });
    console.log("· default tenant provisioned (register warehouse databases via the UI)");
  }

  // Bundled demo warehouse: generate the local DuckDB file the seed will scan.
  if (env.warehouseAdapter === "duckdb" && env.duckWarehousePath) {
    console.log("· generating demo warehouse…");
    await generateDemoWarehouse(env.duckWarehousePath);
  }

  // Warehouse adapter warm-up removed: the registry now lazy-loads per-tenant
  // on first request. Bootstrap doesn't need a representative tenant id.
  await seedDemo();
  console.log("· demo dataset seeded");
}

console.log("\nDone.\n");
process.exit(0);
