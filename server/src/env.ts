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

type WarehouseEnvOk =
  | { ok: true; adapter: "disabled" }
  | { ok: true; adapter: "motherduck"; motherduckToken: string };
type WarehouseEnvErr = { ok: false; reason: string };
export type WarehouseEnvResult = WarehouseEnvOk | WarehouseEnvErr;

export function validateWarehouseEnv(vars: Record<string, string | undefined>): WarehouseEnvResult {
  const attach = vars.ATTACH_WAREHOUSE?.trim() === "true";
  if (!attach) return { ok: true, adapter: "disabled" };

  const adapter = vars.WAREHOUSE_ADAPTER?.trim();
  if (!adapter) {
    return { ok: false, reason: "WAREHOUSE_ADAPTER required when ATTACH_WAREHOUSE=true" };
  }
  if (adapter === "snowflake") {
    return { ok: false, reason: "Snowflake adapter is a stub; not yet supported" };
  }
  if (adapter !== "motherduck") {
    return { ok: false, reason: `Unknown WAREHOUSE_ADAPTER: ${adapter}` };
  }
  const token = vars.MOTHERDUCK_TOKEN?.trim();
  if (!token) {
    return { ok: false, reason: "MOTHERDUCK_TOKEN required for motherduck adapter" };
  }
  return { ok: true, adapter: "motherduck", motherduckToken: token };
}

const attachWarehouse = process.env.ATTACH_WAREHOUSE?.trim() === "true";

const databaseUrl = readRequired("DATABASE_URL", "required");

const warehouseEnv = validateWarehouseEnv(process.env);
let motherduckToken = "";
let warehouseAdapter: "disabled" | "motherduck" = "disabled";
if (!warehouseEnv.ok) {
  issues.push({ name: "WAREHOUSE_ADAPTER / MOTHERDUCK_TOKEN", reason: warehouseEnv.reason });
} else {
  warehouseAdapter = warehouseEnv.adapter;
  if (warehouseEnv.adapter === "motherduck") {
    motherduckToken = warehouseEnv.motherduckToken;
  }
}

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
  warehouseAdapter,
  attachWarehouse,
  /** When true, the DuckDB adapter is writable (canonical → MotherDuck via MERGE).
   *  Off by default; flip to `true` only when MotherDuck token has write access. */
  motherduckWritable: process.env.MOTHERDUCK_WRITABLE?.trim() === "true",
  /** Encryption key for webhook signing secrets. AES-256-GCM master key
   *  resolved from this var, or from ZUGZUG_WEBHOOK_MASTER_KEY_FILE, or
   *  (self-host only) auto-generated at boot. 32 random bytes, base64. */
  webhookMasterKeyB64: process.env.ZUGZUG_WEBHOOK_MASTER_KEY?.trim() || null,
  webhookMasterKeyFile: process.env.ZUGZUG_WEBHOOK_MASTER_KEY_FILE?.trim() || null,
  /** HMAC key for paginated cursor signing (PR2). Separate from the webhook
   *  master key so rotating one doesn't invalidate the other. */
  cursorKeyB64: process.env.ZUGZUG_CURSOR_KEY?.trim() || null,
  /** Self-host mode — relaxes some defaults (http://localhost webhooks,
   *  auto-generated master key) that would be operator-error in hosted SaaS. */
  selfHosted: process.env.ZUGZUG_SELF_HOSTED?.trim() === "1",
  /** Webhook dispatcher on/off. Default differs by deployment — see .env.example. */
  webhooksEnabled: process.env.WEBHOOKS_ENABLED?.trim() === "1",
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
  /** Public origin of this app — used to build the OAuth redirect_uri.
   *  In dev: http://localhost:5173 (Vite proxies /api). In prod: https://yourapp.com */
  origin: (readOptional("ORIGIN") || "http://localhost:5173").replace(/\/$/, ""),
  /** Skip Google OAuth in dev — shows a one-click login button. Never use in prod. */
  devBypassAuth: process.env.DEV_BYPASS_AUTH?.trim() === "true",
  /** Optional: Anthropic API key for AI features. Soft-fail (empty string when absent). */
  anthropicApiKey: readOptional("ANTHROPIC_API_KEY"),
  /** Opt-in server error tracking. Empty = disabled (no telemetry). */
  sentryDsn: readOptional("SENTRY_DSN"),
  sentryEnvironment: readOptional("SENTRY_ENVIRONMENT"),
  /** Per-credential rate-limit budget for the /v1/ surface. Default 600
   *  req/min; set to 0 to disable. */
  pullApiRpm: process.env.ZUGZUG_PULL_API_RPM ? Number(process.env.ZUGZUG_PULL_API_RPM) : 600,
  /** Enable E2E-test-only routes (e.g. POST /api/e2e/seed-scan-values).
   *  MUST NOT be set in production. Set ZUGZUG_E2E_TEST_ROUTES=1 in the
   *  compose.e2e.yml override when running the Playwright suite. */
  e2eTestRoutes: process.env.ZUGZUG_E2E_TEST_ROUTES === "1",
};

/** Qualified Postgres app-state table name: "zugzug_app"."table" */
export const pg = (table: string) => `"${env.appSchema}"."${table}"`;
