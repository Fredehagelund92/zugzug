/* env.ts — load + validate the three-store credentials (see ARCHITECTURE.md).
   Bun auto-loads server/.env. Missing required values fail fast with a pointer
   to the example file rather than surfacing as a cryptic ATTACH error later. */

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`\n✗ Missing required env ${name}.`);
    console.error(`  Copy server/.env.example → server/.env and fill it in.\n`);
    process.exit(1);
  }
  return v;
}

export const env = {
  /** Postgres OLTP app-state (drafts / audit / users / presence). */
  databaseUrl: required("DATABASE_URL"),
  /** MotherDuck token — warehouse (read) + zugzug canonical (read/write). */
  motherduckToken: required("MOTHERDUCK_TOKEN"),
  /** MotherDuck db holding the existing warehouse source tables (read-only). */
  warehouseDb: process.env.WAREHOUSE_DB?.trim() || "analytics",
  /** Whether to ATTACH the MotherDuck warehouse (enables the discovery scan).
   *  Off by default — the canonical/draft/commit machinery is Postgres-only and
   *  works without it; flip on once the warehouse is wired. */
  attachWarehouse: process.env.ATTACH_WAREHOUSE?.trim() === "true",
  /** Postgres schema Zug Zug owns and writes the canonical dim_/map_ to.
   *  (Canonical lives in Postgres, not MotherDuck, per the read-only-MD setup.) */
  canonicalSchema: process.env.ZUGZUG_DB?.trim() || "zugzug",
  /** Catalog name the attached Postgres is mounted under inside DuckDB. */
  oltpCatalog: "oltp",
  /** Schema inside Postgres for app state (drafts / audit / users / registry). */
  appSchema: "zugzug_app",
  /** Local DuckDB engine file (":memory:" is fine — durable state is remote). */
  duckPath: process.env.DUCK_PATH?.trim() || ":memory:",
  port: Number(process.env.PORT?.trim() || 8787),
};

/** Fully-qualified Postgres app-state table name, e.g. oltp.zugzug_app.draft */
export const pg = (table: string) => `${env.oltpCatalog}.${env.appSchema}.${table}`;
