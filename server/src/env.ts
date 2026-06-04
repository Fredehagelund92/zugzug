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
  databaseUrl: required("DATABASE_URL"),
  motherduckToken: required("MOTHERDUCK_TOKEN"),
  warehouseDb: process.env.WAREHOUSE_DB?.trim() || "analytics",
  attachWarehouse: process.env.ATTACH_WAREHOUSE?.trim() === "true",
  canonicalSchema: process.env.ZUGZUG_DB?.trim() || "zugzug",
  oltpCatalog: "oltp",
  appSchema: "zugzug_app",
  duckPath: process.env.DUCK_PATH?.trim() || ":memory:",
  port: Number(process.env.PORT?.trim() || 8787),

  // Google OAuth2
  googleClientId: required("GOOGLE_CLIENT_ID"),
  googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
  /** Email domain allowed to log in (e.g. "bettercollective.com"). */
  allowedDomain: process.env.ALLOWED_DOMAIN?.trim() || "bettercollective.com",
  /** Public origin of this app — used to build the OAuth redirect_uri.
   *  In dev: http://localhost:5173 (Vite proxies /api). In prod: https://yourapp.com */
  origin: (process.env.ORIGIN?.trim() || "http://localhost:5173").replace(/\/$/, ""),
  /** Skip Google OAuth in dev — shows a one-click login button. Never use in prod. */
  devBypassAuth: process.env.DEV_BYPASS_AUTH?.trim() === "true",
};

/** Fully-qualified Postgres app-state table name, e.g. oltp.zugzug_app.draft */
export const pg = (table: string) => `${env.oltpCatalog}.${env.appSchema}.${table}`;
