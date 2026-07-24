/* demo-reset.ts — wipe the demo and reseed it, in place.
 *
 * Empties all app state and the published dim_/map_ tables, then reseeds the
 * fictional demo (tenant, sample warehouse, reference tables, value-mapping).
 * DB-level, so it needs no app restart and never touches the TLS cert. Reads
 * DATABASE_URL + warehouse env like the server does.
 *
 * DESTRUCTIVE — only ever run against a throwaway demo. Guarded by an env var:
 *   DEMO_RESET_CONFIRM=yes bun run src/demo-reset.ts
 *
 * Schedule daily on Fly.io as a scheduled Machine, or on a VM via
 * `docker compose exec server` on a cron. */

import { pgRun } from "./pg.ts";
import { env } from "./env.ts";
import { provisionTenant } from "./tenant.ts";
import { registerFactories } from "./warehouse/credentials.ts";
import { createDuckDbAdapter } from "./warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "./warehouse/snowflake/index.ts";
import { generateDemoWarehouse } from "./seed-warehouse.ts";
import { seedDemo } from "./seed.ts";

if (process.env.DEMO_RESET_CONFIRM !== "yes") {
  console.error("refusing: set DEMO_RESET_CONFIRM=yes to reset the demo (this wipes ALL data).");
  process.exit(1);
}

registerFactories({
  duckdb: async (creds) => createDuckDbAdapter(creds),
  snowflake: async (creds) => new SnowflakeAdapter(creds),
});

console.log("· resetting demo…");

// 1. Empty every app-state table (keeps the schema + migration history intact).
await pgRun(`DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'zugzug_app' LOOP
    EXECUTE 'TRUNCATE TABLE "zugzug_app".' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
  END LOOP;
END $$;`);

// 2. Drop the published dim_/map_ tables in the record store (seed recreates them).
await pgRun(`DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables
           WHERE schemaname = ${escLiteral(env.recordSchema)}
             AND (tablename LIKE 'dim\\_%' OR tablename LIKE 'map\\_%') LOOP
    EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(${escLiteral(env.recordSchema)}) || '.' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
END $$;`);

// 3. Reseed — mirror bootstrap: system user + demo team, then tenant + data.
await pgRun(
  `INSERT INTO "zugzug_app"."users" (id, name, initials)
   VALUES ('u_system', 'Auto-match', 'AM') ON CONFLICT (id) DO NOTHING`,
);
const DEMO_TEAM = [
  { id: "u_ada", name: "Ada Berg", initials: "AB" },
  { id: "u_li", name: "Li Bauer", initials: "LB" },
  { id: "u_cory", name: "Cory Mills", initials: "CM" },
];
for (const u of DEMO_TEAM) {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [u.id, u.name, u.initials],
  );
}
await provisionTenant({ id: "default", label: "Demo workspace" });
if (env.warehouseAdapter === "duckdb" && env.duckWarehousePath) {
  await generateDemoWarehouse(env.duckWarehousePath);
}
await seedDemo();

console.log("· demo reset + reseeded");
process.exit(0);

function escLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
