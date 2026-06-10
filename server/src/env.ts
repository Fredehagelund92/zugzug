/* env.ts — load + validate the three-store credentials (see ARCHITECTURE.md).
   Bun auto-loads server/.env. Missing required values fail fast with a banner
   listing every missing var rather than dying on the first one — easier to fix
   a fresh checkout in one pass than to chase them one by one. */

interface Issue {
  name: string;
  reason: string;
}

const issues: Issue[] = [];

function readRequired(name: string, reason: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    issues.push({ name, reason });
    return "";
  }
  return v;
}

function readOptional(name: string, fallback = ""): string {
  return process.env[name]?.trim() ?? fallback;
}

const attachWarehouse = process.env.ATTACH_WAREHOUSE?.trim() === "true";

const databaseUrl = readRequired("DATABASE_URL", "required");
const motherduckToken = readRequired(
  "MOTHERDUCK_TOKEN",
  attachWarehouse ? "required (because ATTACH_WAREHOUSE=true)" : "required",
);

if (issues.length > 0) {
  const lines = [
    "================================================",
    "  Zugzug startup error: missing/invalid env vars",
    "================================================",
    ...issues.map((i) => `  - ${i.name} — ${i.reason}; not set`),
    "",
    "  See server/.env.example for the full reference.",
    "  Tip: run `bun run quickstart` to set up a local dev env interactively.",
    "================================================",
    "",
  ];
  console.error(lines.join("\n"));
  process.exit(1);
}

export const env = {
  databaseUrl,
  motherduckToken,
  warehouseDb: process.env.WAREHOUSE_DB?.trim() || "analytics",
  attachWarehouse,
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
  oidcIssuerUrl: readOptional("OIDC_ISSUER_URL"),
  oidcClientId: readOptional("OIDC_CLIENT_ID"),
  oidcClientSecret: readOptional("OIDC_CLIENT_SECRET"),
  oidcAllowedDomain: readOptional("OIDC_ALLOWED_DOMAIN"),
  oidcLabel: readOptional("OIDC_LABEL"),
  get authMode(): "password" | "oidc" {
    return this.oidcIssuerUrl ? "oidc" : "password";
  },
  /** Email domain restriction — applied in BOTH modes. Empty = unrestricted. */
  allowedDomain: readOptional("ALLOWED_DOMAIN") || readOptional("OIDC_ALLOWED_DOMAIN"),
  /** @deprecated — replaced by OIDC_CLIENT_ID. Kept as optional for transition; not read by new code. */
  googleClientId: readOptional("GOOGLE_CLIENT_ID"),
  /** @deprecated — replaced by OIDC_CLIENT_SECRET. */
  googleClientSecret: readOptional("GOOGLE_CLIENT_SECRET"),
  /** Public origin of this app — used to build the OAuth redirect_uri.
   *  In dev: http://localhost:5173 (Vite proxies /api). In prod: https://yourapp.com */
  origin: (readOptional("ORIGIN") || "http://localhost:5173").replace(/\/$/, ""),
  /** Skip Google OAuth in dev — shows a one-click login button. Never use in prod. */
  devBypassAuth: process.env.DEV_BYPASS_AUTH?.trim() === "true",
  /** Optional: Anthropic API key for AI features. Soft-fail (empty string when absent). */
  anthropicApiKey: readOptional("ANTHROPIC_API_KEY"),
};

/** Qualified Postgres app-state table name: "zugzug_app"."table" */
export const pg = (table: string) => `"${env.appSchema}"."${table}"`;
