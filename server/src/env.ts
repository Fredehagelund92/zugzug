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
  /** When true, the DuckDB adapter is writable (canonical → MotherDuck via MERGE).
   *  Off by default; flip to `true` only when MotherDuck token has write access. */
  motherduckWritable: process.env.MOTHERDUCK_WRITABLE?.trim() === "true",
  /** Default value of the engineer-mode toggle for users who haven't set a
   *  preference yet. OSS default: true. BC override: DEFAULT_ENGINEER_MODE=false. */
  defaultEngineerMode: process.env.DEFAULT_ENGINEER_MODE?.trim() !== "false",
  canonicalSchema: process.env.ZUGZUG_DB?.trim() || "zugzug",
  oltpCatalog: "oltp",
  appSchema: "zugzug_app",
  duckPath: process.env.DUCK_PATH?.trim() || ":memory:",
  port: Number(process.env.PORT?.trim() || 8787),

  // Auth mode resolution. If OIDC_ISSUER_URL is set, OIDC is the only auth path
  // (the Login page shows "Sign in with SSO"). Otherwise, password is the only
  // auth path (Login shows email + password fields). One-or-the-other per deployment.
  oidcIssuerUrl: process.env.OIDC_ISSUER_URL?.trim() || "",
  oidcClientId: process.env.OIDC_CLIENT_ID?.trim() || "",
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET?.trim() || "",
  oidcAllowedDomain: process.env.OIDC_ALLOWED_DOMAIN?.trim() || "",
  oidcLabel: process.env.OIDC_LABEL?.trim() || "",
  get authMode(): "password" | "oidc" {
    return this.oidcIssuerUrl ? "oidc" : "password";
  },
  /** Email domain restriction — applied in BOTH modes. Empty = unrestricted. */
  allowedDomain: process.env.ALLOWED_DOMAIN?.trim() || process.env.OIDC_ALLOWED_DOMAIN?.trim() || "",
  /** @deprecated — replaced by OIDC_CLIENT_ID. Kept as optional for transition; not read by new code. */
  googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || "",
  /** @deprecated — replaced by OIDC_CLIENT_SECRET. */
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || "",
  /** Public origin of this app — used to build the OAuth redirect_uri.
   *  In dev: http://localhost:5173 (Vite proxies /api). In prod: https://yourapp.com */
  origin: (process.env.ORIGIN?.trim() || "http://localhost:5173").replace(/\/$/, ""),
  /** Skip Google OAuth in dev — shows a one-click login button. Never use in prod. */
  devBypassAuth: process.env.DEV_BYPASS_AUTH?.trim() === "true",
  /** Optional: Anthropic API key for AI features. Soft-fail (empty string when absent). */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
};

/** Qualified Postgres app-state table name: "zugzug_app"."table" */
export const pg = (table: string) => `"${env.appSchema}"."${table}"`;
