# Phase 4 — Strip BC-isms + MotherDuck-writable + Auth refactor (design spec)

**Date:** 2026-06-09
**Status:** approved (brainstorming complete; ready for implementation planning)
**Supersedes:** the Phase 4 section in `docs/superpowers/specs/2026-06-08-oss-pivot-design.md` (this is the implementation-grade refinement; the parent spec stands but with the multi-tenant flag deliverable removed — see Strategic decisions below).

---

## Goal

Strip Better Collective-specific assumptions from the codebase so a self-hoster with no BC context can run Zugzug end-to-end. Replace the Google-OAuth-only auth path with a single generic OIDC flow plus local email/password (one-or-the-other per deployment). Add API tokens for headless dbt/CI use. Drop the hard-coded `ReadOnlyWarehouseAdapter` constraint on DuckDB so MotherDuck users with writable tokens get warehouse-mode commits. Replace BC-specific demo seed data with generic e-commerce examples. Scrub remaining BC jargon from UI copy.

## What Phase 4 is NOT

- Per-workspace credential admin UI — deferred to v1.1; auth + warehouse creds stay env-driven.
- Token scopes (read-only, per-route) — deferred to v1.1; v1 tokens act as the user.
- Multi-tenant workspace UI gating — **dropped from Phase 4 entirely** (parent spec adjustment). The original spec assumed BC's `#59` multi-tenant work had landed and needed a gating flag. It didn't; no `tenant_id` columns exist. When a future cloud product introduces multi-tenancy, that work bundles the schema AND the gating flag together. `ZUGZUG_MULTI_TENANT` env var is not added.
- Password reset email flow — deferred to v1.1; v1 documents an admin-CLI workaround (a small `bun run reset-password <email>` script that rewrites `users.password_hash` directly).
- SAML, LDAP, magic-link auth — out of scope; OIDC + password covers the v1 audience.
- Legal sign-off + git history scrub — that's Phase 5.

---

## Strategic decisions (locked during 2026-06-09 brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| **Signup flow** | First user = admin; admin invites the rest via `allowed_emails` allowlist (reused from current Google-OAuth bootstrap) | Matches today's bootstrap pattern, scales cleanly across password + OIDC modes. |
| **Google OAuth code** | Removed entirely; generic `openid-client` OIDC flow with Google as one provider config | Single auth path is cleaner than two parallel paths. BC migrates by setting OIDC env vars pointing at Google. |
| **Auth mode** | One-or-the-other per deployment: if `OIDC_ISSUER_URL` env is set → OIDC only; else password only | Simpler UX, simpler code. Self-hosters without an OIDC provider use passwords. BC sets the env vars. |
| **`ZUGZUG_MULTI_TENANT` flag** | **Not shipped** | YAGNI — there's no multi-tenant UI to gate. Future cloud product introduces both together. |
| **API token scopes** | None — tokens authenticate as the user, full session-equivalent permissions | Simplest viable model (GitHub pre-fine-grained-PAT pattern); v1.1 can add scopes when a real use case appears. |
| **MotherDuck-writable trigger** | Env flag `MOTHERDUCK_WRITABLE=true`, defaults to false | Explicit and safe. Auto-detection via write-probe is unreliable and side-effect-y. |
| **Seed data** | Generic e-commerce: Country (ISO), Product Category, Customer Segment; source tables `raw.orders`, `raw.shipments`, `raw.customers` | Familiar across industries; demonstrates the reconciliation pattern without leaking domain assumptions. |
| **Engineer-mode default** | OSS default: **ON**. BC override: `DEFAULT_ENGINEER_MODE=false` env var | OSS users are mostly engineers (per PM critique). BC preserves their non-technical-analyst UX with one env var. |
| **Password complexity** | Minimum 12 chars; no other rules | Length is the only enforced complexity that meaningfully helps in 2026. |
| **Password reset** | No email flow in v1; admin-CLI script (`bun run reset-password <email>`) writes a new hash directly | Email infrastructure is a follow-on; CLI workaround is enough for single-team self-hosters. |

---

## Architecture

### Two-PR split (Approach B from brainstorming)

The phase ships as two PRs because auth is the highest-risk single change in the entire OSS pivot. Isolating it from cosmetic scrubs keeps the auth review focused.

**PR 1 — Cleanups + MotherDuck-writable** (~500–700 LOC, low risk):
- Engineer-mode default flip
- Seed-data scrub
- UI copy scrub
- MotherDuck-writable adapter

**PR 2 — Auth refactor + API tokens** (~1500 LOC, higher risk):
- Drizzle migration (password_hash on users + api_tokens table)
- Generic OIDC flow (openid-client) replacing Google-specific code
- Local password endpoints
- API token endpoints + Settings UI
- Login page rewrite (mode-aware)

The two PRs are independent (PR 2 doesn't depend on PR 1; could land in either order), but the recommended sequence is PR 1 first because it's faster to merge and provides immediate self-hoster value.

### Files modified / created

```
# PR 1: Cleanups + MD-writable
server/src/
  warehouse/duckdb/index.ts         # MODIFIED — splits into RO and Writable variants OR polymorphic single class
  warehouse/credentials.ts          # MODIFIED — adds writable?: boolean to DuckDbCredentials
  warehouse/registry.ts             # MODIFIED — reads MOTHERDUCK_WRITABLE env
  env.ts                            # MODIFIED — adds motherduckWritable, defaultEngineerMode flags
  seed.ts                           # REWRITTEN — generic e-commerce dimensions
app/src/
  lib/engineer-mode.tsx             # MODIFIED — default flips ON; reads server-provided default
  routes/Login.tsx                  # MODIFIED — copy scrub ("Better Collective" → generic)
  routes/Settings.tsx               # MODIFIED — copy scrub (allowed-domain placeholder text)
server/test/
  warehouse-duckdb.test.ts          # MODIFIED — adds writable-mode commit tests
  commit-warehouse-branch.test.ts   # MODIFIED — adds DuckDB-writable case alongside Snowflake mock

# PR 2: Auth + API tokens
server/drizzle/
  schema.ts                         # MODIFIED — password_hash + auth_provider on users; new api_tokens table
  migrations/000N_auth_refactor.sql # GENERATED via `bun run db:generate`
server/src/
  auth.ts                           # REWRITTEN — generic OIDC + password endpoints
  auth-oidc.ts                      # NEW — openid-client wrapper (extracted for testability)
  auth-password.ts                  # NEW — argon2 hashing + login/signup handlers
  auth-api-tokens.ts                # NEW — token issuance/verification/revocation
  server.ts                         # MODIFIED — session gate falls back to bearer-token auth
  env.ts                            # MODIFIED — adds OIDC_* env vars; deprecates GOOGLE_*
  bootstrap.ts                      # MODIFIED — first-user-as-admin bootstrap on empty users table
scripts/
  reset-password.ts                 # NEW — CLI for admin password reset (Bun script)
app/src/
  routes/Login.tsx                  # REWRITTEN — fetches /api/auth/config, renders password form OR SSO button
  routes/Settings.tsx               # MODIFIED — new "API tokens" section with create/revoke
  store.ts                          # MODIFIED — adds useAuthConfig + token-management actions
server/test/
  auth-password.test.ts             # NEW — signup, login, change-password, allowlist, password complexity
  auth-oidc.test.ts                 # NEW — OIDC callback with mocked openid-client
  auth-api-tokens.test.ts           # NEW — issuance, hash uniqueness, bearer-token auth, revocation
app/test/
  login-mode-aware.test.tsx         # NEW — Login renders right UI based on config mode
  api-tokens-settings.test.tsx      # NEW — token list, create, revoke flows
```

---

## PR 1 details

### Engineer-mode default flip

Current: `useEngineerMode()` defaults to `false`. Flip to `true` for OSS. Add `DEFAULT_ENGINEER_MODE=false` env (read on server) for BC's deployment.

Frontend reads the default from a new field on the existing `/api/workspace/info` response (no new endpoint needed):

```ts
// /api/workspace/info response — extended
{
  adapter: "duckdb" | "snowflake",
  writable: boolean,
  canonicalMode: "warehouse" | "postgres-export",
  warehouseDb: string | null,
  defaultEngineerMode: boolean,  // NEW
}
```

`useEngineerMode` checks `localStorage` first (user preference wins); if no stored preference, uses the server default. Per-user override via the existing Settings toggle.

### Seed-data scrub

New `server/src/seed.ts`:

```ts
const COUNTRY_SOURCES = [
  { table: "raw.orders", column: "shipping_country" },
  { table: "raw.shipments", column: "destination_country" },
  { table: "raw.customers", column: "billing_country" },
];

const COUNTRY_CANONICAL = [ /* ISO codes, unchanged */ ];

const PRODUCT_CATEGORY_SOURCES = [
  { table: "raw.orders", column: "product_category" },
  { table: "raw.products", column: "category" },
];
const PRODUCT_CATEGORY_CANONICAL = [
  { key: "electronics", label: "Electronics" },
  { key: "clothing", label: "Clothing" },
  { key: "home", label: "Home & Garden" },
  { key: "books", label: "Books" },
  { key: "groceries", label: "Groceries" },
];

const CUSTOMER_SEGMENT_SOURCES = [
  { table: "raw.customers", column: "segment" },
  { table: "raw.opportunities", column: "account_segment" },
];
const CUSTOMER_SEGMENT_CANONICAL = [
  { key: "b2c", label: "B2C" },
  { key: "smb", label: "SMB" },
  { key: "enterprise", label: "Enterprise" },
];
```

The seed comment ("Grounded in the real bc-dbt warehouse") is removed; replaced with "Generic e-commerce examples — replace with your own dimensions after exploring the demo."

### UI copy scrub

| File:line | Before | After |
|---|---|---|
| `server/src/env.ts:30` | `allowedDomain: ... \|\| "bettercollective.com"` | `allowedDomain: ... \|\| ""` (empty = unrestricted; comment: "set OIDC_ALLOWED_DOMAIN to restrict signups") |
| `app/src/routes/Login.tsx:5` | `domain: "Only @bettercollective.com accounts can access this app."` | Generic — derived from `/api/auth/config`'s `allowedDomain` field: `Only @${domain} accounts can access this app.` (or generic "This domain is restricted" when no domain set) |
| `app/src/routes/Login.tsx:44` | `Master data reconciliation · Better Collective.` | `Master data reconciliation.` |
| `app/src/routes/Settings.tsx:199` | `const ALLOWED_DOMAIN = "@bettercollective.com"` | derived from `/api/auth/config`; passed via context or a `useAllowedDomain()` hook |
| `app/src/routes/Settings.tsx:462` | placeholder `colleague@bettercollective.com, another@bettercollective.com…` | derived placeholder using the configured domain, or generic `colleague@example.com, another@example.com…` when unset |

### MotherDuck-writable adapter

**Credential schema update** (Zod):

```ts
export const DuckDbCredentials = z.object({
  type: z.literal("duckdb"),
  token: z.string().optional(),
  path: z.string().optional(),
  database: z.string().optional(),
  attached: z.boolean().default(false),
  writable: z.boolean().default(false),  // NEW
});
```

**Registry wiring**:

```ts
function envCredentials(): WarehouseCredentials {
  return {
    type: "duckdb",
    token: env.motherduckToken,
    path: env.duckPath,
    database: env.warehouseDb,
    attached: env.attachWarehouse,
    writable: env.motherduckWritable,  // NEW — reads MOTHERDUCK_WRITABLE env
  };
}
```

**Adapter shape**: TypeScript decision — single `DuckDbAdapter` class with conditional method presence based on `capabilities.writable`, OR split into `DuckDbReadOnlyAdapter` + `DuckDbWritableAdapter` classes returning the right `WarehouseAdapter` union member?

The discriminated-union type forces one of these:
- `WritableWarehouseAdapter` (must have `ensureCanonicalTables` + `commitCanonical`)
- `ReadOnlyWarehouseAdapter` (must not)

**Recommendation: split into two classes.** The factory returns the right one based on `creds.writable`. Avoids polymorphic methods that throw at runtime in one variant; the type system enforces correctness.

```ts
// duckdb/index.ts
export class DuckDbReadOnlyAdapter implements ReadOnlyWarehouseAdapter { /* current code */ }
export class DuckDbWritableAdapter implements WritableWarehouseAdapter {
  // inherits all read methods (factor common code into a shared base or composition)
  async ensureCanonicalTables(dim: DimensionSpec): Promise<void> {
    await this.conn.run(`CREATE TABLE IF NOT EXISTS ${dimTableRef} (...)`);
    await this.conn.run(`CREATE TABLE IF NOT EXISTS ${mapTableRef} (...)`);
  }
  async commitCanonical(dim: DimensionSpec, drafts: ApprovedDraft[]): Promise<CommitResult> {
    // DuckDB supports MERGE INTO since v0.10, same shape as SnowflakeAdapter
    // (chunked, USING (VALUES ...) AS S, WHEN NOT MATCHED THEN INSERT)
  }
}

// credentials.ts factory
export const factory = (creds: DuckDbCredentials): WarehouseAdapter =>
  creds.writable
    ? new DuckDbWritableAdapter(creds)
    : new DuckDbReadOnlyAdapter(creds);
```

Shared code (connection, all/get, helpers) extracted to a base class or composition root. The actual extraction shape (inheritance vs composition) is an implementation-plan decision.

---

## PR 2 details

### Schema migration

```sql
-- 000N_auth_refactor.sql
ALTER TABLE zugzug_app.users ADD COLUMN password_hash VARCHAR;
ALTER TABLE zugzug_app.users ADD COLUMN auth_provider VARCHAR NOT NULL DEFAULT 'password';

-- Migrate existing Google-OAuth users
UPDATE zugzug_app.users SET auth_provider = 'oidc' WHERE google_sub IS NOT NULL;

-- API tokens
CREATE TABLE zugzug_app.api_tokens (
  id           VARCHAR PRIMARY KEY,
  user_id      VARCHAR NOT NULL,
  name         VARCHAR NOT NULL,
  token_hash   VARCHAR NOT NULL UNIQUE,
  created_at   TIMESTAMP NOT NULL,
  last_used_at TIMESTAMP,
  revoked_at   TIMESTAMP
);
CREATE INDEX api_tokens_user_id_idx ON zugzug_app.api_tokens (user_id);
```

Drizzle schema additions mirror these. `google_sub` column stays (existing BC users still have it; nullable; only meaningful for OIDC-provider attribution).

### Auth mode resolution

At server startup, `env.ts` derives:

```ts
authMode: process.env.OIDC_ISSUER_URL?.trim() ? "oidc" : "password"
```

`/api/auth/config` returns:

```ts
{
  mode: "password" | "oidc",
  signupOpen: false,  // always false in v1 (invite-only); reserved for v1.1 OPEN_SIGNUP flag
  allowedDomain: env.allowedDomain || null,  // for the Login page's "@domain only" copy
  oidcLabel?: string,  // e.g. "Google" or "Okta" — derived from OIDC_LABEL env or issuer hostname
}
```

### Password mode flow

**`POST /api/auth/signup`** (password mode only):
- Body: `{ email, password, name }`
- Validate: email format, password ≥ 12 chars, name non-empty
- Check `users` table count → if 0, this user becomes the admin (added to `allowed_emails` first); else check email is in `allowed_emails`
- Hash password (argon2id, default cost), insert user with `auth_provider='password'`, create session, set cookie, redirect to `/app`

**`POST /api/auth/login`** (password mode only):
- Body: `{ email, password }`
- Look up user by email + `auth_provider='password'`
- Verify hash; if good, create session + set cookie; if bad, 401 with generic "Invalid credentials"

**`POST /api/auth/change-password`** (authenticated, password mode only):
- Body: `{ currentPassword, newPassword }`
- Verify current password; hash + update if new ≥ 12 chars

**`POST /api/auth/logout`** (unchanged) — delete session, clear cookie.

### OIDC mode flow

**Library:** `openid-client` (battle-tested, framework-agnostic).

**Startup discovery:** server fetches `<OIDC_ISSUER_URL>/.well-known/openid-configuration` on first OIDC request, caches the client.

**`GET /api/auth/oidc/start`** (OIDC mode only):
- Generate state + nonce, store in short-lived cookie
- Redirect to authorize URL with `client_id`, `redirect_uri`, `state`, `nonce`, `scope=openid profile email`

**`GET /api/auth/oidc/callback`**:
- Verify state, exchange code, validate ID token (signature + nonce + audience), extract claims (`sub`, `email`, `name`, optional `given_name`/`family_name`)
- Domain check if `OIDC_ALLOWED_DOMAIN` set
- Allowlist check (or first-user-as-admin bootstrap)
- Upsert user with `auth_provider='oidc'`, `google_sub=<sub>` (column name kept for compat; stores any OIDC provider's `sub` claim — Drizzle column comment notes this)
- Create session + set cookie + redirect

### API tokens

**Token format**: `zz_` prefix + 32 random bytes URL-base64-encoded → ~43 chars total. Prefix lets users recognize/scan repos for accidentally-committed tokens.

**Storage**: store `argon2id(token)` in `api_tokens.token_hash`. Token shown to user exactly once at creation; lost-token = revoke + reissue.

**Endpoints (authenticated session required)**:
- `GET /api/tokens` — list current user's tokens (id, name, created_at, last_used_at; never the value)
- `POST /api/tokens` — body `{ name }` → returns `{ id, name, value }` (full token, shown once)
- `DELETE /api/tokens/:id` — set `revoked_at = current_timestamp`

**Bearer-token authentication**: middleware in `server.ts` extracts `Authorization: Bearer <token>`, looks up by hash, returns the user. Sets `last_used_at = current_timestamp` async (fire-and-forget; failure doesn't block the request). If both cookie session AND bearer token present, cookie wins.

**Engineer-mode-gated**: API tokens section in Settings shows only to engineer-mode users? Or to everyone? Decision: **show to everyone** — API tokens are a legit self-service feature for analysts running their own dbt jobs.

### Login.tsx rewrite

Fetch `/api/auth/config` on mount. Render based on `mode`:

**Password mode**:
```
┌────────────────────────────────────┐
│  ⚡ Zug Zug                         │
│                                    │
│  Sign in                           │
│  Master data reconciliation.       │
│                                    │
│  Email     [_________________]     │
│  Password  [_________________]     │
│                                    │
│  [    Sign in    ]                 │
│                                    │
│  No account? Sign up →             │
└────────────────────────────────────┘
```

**OIDC mode**:
```
┌────────────────────────────────────┐
│  ⚡ Zug Zug                         │
│                                    │
│  Sign in                           │
│  Master data reconciliation.       │
│                                    │
│  [  G  Sign in with {OIDC_LABEL}  ]│
│                                    │
│  Only @{allowedDomain} accounts.   │
└────────────────────────────────────┘
```

Signup link in password mode goes to `/signup` (sister route). Sign-up shows email + password + name; first user = admin, subsequent users blocked unless on allowlist (clear error message: "Your email isn't on the allowlist. Ask an existing user to add you in Settings.").

### Settings.tsx — new "API tokens" section

Standalone Section between "Connections" and "Matching defaults". Engineer-mode default-shown for all users.

```
┌─ API tokens ────────────────────────────────────┐
│ For headless access (dbt CI, scripts, ...).     │
│                                                 │
│ ┌─ Existing tokens ─────────────────────────┐   │
│ │ name              created    last used    │   │
│ │ dbt-prod          3d ago     2h ago    [×]│   │
│ │ local-debug       1mo ago    never     [×]│   │
│ └───────────────────────────────────────────┘   │
│                                                 │
│ [ + Create token ]                              │
│                                                 │
│ Use with: Authorization: Bearer zz_...          │
└─────────────────────────────────────────────────┘
```

Create-token modal: name input → submit → modal shows the token value with a "Copy" button, and a clear warning "Save it now — you won't see it again." Closing the modal returns to the list.

---

## BC migration

After PR 2 lands, BC's deployment continues operating with one config change:

```bash
# .env additions
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_CLIENT_ID=<existing GOOGLE_CLIENT_ID value>
OIDC_CLIENT_SECRET=<existing GOOGLE_CLIENT_SECRET value>
OIDC_ALLOWED_DOMAIN=bettercollective.com
DEFAULT_ENGINEER_MODE=false
# OIDC_LABEL=Google (optional; defaults to issuer hostname)

# Deprecated (can remove after migration verified):
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...
# ALLOWED_DOMAIN=...
```

Existing sessions remain valid (sessions table not touched). BC users log in normally; the OIDC callback finds their existing `google_sub` value and upserts. The Drizzle migration runs once on first server start and sets `auth_provider='oidc'` for all existing BC users.

Zero data loss; zero forced re-login.

---

## Error handling

| Failure | Effect | User-facing surface |
|---|---|---|
| Password signup with weak password (<12 chars) | Server returns 400 with `{ error: "password_too_short", minLength: 12 }` | Login form shows inline error |
| Password login with wrong credentials | Server returns 401 with `{ error: "invalid_credentials" }` (generic — doesn't reveal whether email exists) | Login form shows "Invalid email or password." |
| Signup with email not on allowlist (after first user) | Server returns 403 with `{ error: "not_allowed" }` | Sign-up shows "Your email isn't on the allowlist. Ask an existing user to add you in Settings." |
| OIDC callback domain mismatch | Server redirects to `/login?error=domain` | Login page shows existing error message pattern |
| OIDC callback state/nonce mismatch | Server redirects to `/login?error=state` | Existing error pattern |
| OIDC issuer discovery fails at startup | Server logs error; auth mode falls back to "broken" — `/api/auth/config` returns `{ mode: "error" }` | Login page shows "Authentication system is misconfigured — contact your admin." Server continues to serve API routes (existing sessions still work). |
| API token used after revocation | 401 from session middleware | Tool retries; surfaces error to caller |
| API token bearer hits an endpoint that's session-only (e.g. logout) | 401 | Documented in Settings: "Tokens work for data routes; signup/login/logout require an interactive session." |
| MotherDuck-writable enabled but token is actually read-only | First `commitCanonical` attempt fails | Per Phase 3: audit log captures "Warehouse sync failed"; dashboard surfaces `N not yet saved to warehouse`. User flips `MOTHERDUCK_WRITABLE=false` and restarts. |

---

## Testing strategy

**Server tests** (server/test/):

- `auth-password.test.ts`: signup-as-first-user-becomes-admin, signup-with-allowlist-pass, signup-with-allowlist-fail, signup-with-short-password, login-success, login-wrong-password, login-unknown-user (returns same error as wrong-password to avoid email enumeration), change-password-success, change-password-with-wrong-current.
- `auth-oidc.test.ts`: callback-with-valid-id-token (mock `openid-client`), callback-with-wrong-state, callback-with-wrong-domain, callback-creates-new-user, callback-upserts-existing-user-by-sub, first-OIDC-user-becomes-admin.
- `auth-api-tokens.test.ts`: create-token-returns-value-once, create-token-stores-hash-not-value, list-tokens-omits-value, revoke-token, bearer-auth-with-valid-token-loads-user, bearer-auth-with-revoked-token-401, bearer-auth-updates-last-used-at, bearer-auth-precedence-cookie-wins.
- `commit-warehouse-branch.test.ts` (extended): adds DuckDB-writable case alongside the Snowflake mock — verifies `commitCanonical` actually MERGEs into the in-memory DuckDB.
- `warehouse-duckdb.test.ts` (extended): adds `ensureCanonicalTables` + `commitCanonical` tests for the writable variant.

**Frontend tests** (app/test/):

- `login-mode-aware.test.tsx`: renders password form when `mode='password'`; renders SSO button when `mode='oidc'`; shows allowedDomain hint when set; shows configured `oidcLabel`.
- `api-tokens-settings.test.tsx`: lists tokens; create-token modal shows value once; revoke removes from list; copy button works.
- `engineer-mode-default.test.tsx`: respects server's `defaultEngineerMode` when no localStorage; localStorage wins over server default.

**Manual smoke (PR 2)**:
- Fresh DB → start server → sign up → become admin → invite a second email → second user signs up → both can commit.
- Fresh DB → set OIDC env vars → start server → log in via OIDC → first user is admin → invite + 2nd OIDC user works.
- BC migration smoke: existing DB → set OIDC env vars pointing at Google → existing BC user logs in via OIDC → session resumes seamlessly.

**Manual smoke (PR 1)**:
- `MOTHERDUCK_WRITABLE=true` + real MotherDuck creds → commit → verify `commitCanonical` ran (audit log shows "Warehouse synced", dashboard shows "Saved to MotherDuck").

---

## Out of scope (deferred to v1.1+)

| Deliverable | Deferred because |
|---|---|
| Per-workspace credential admin UI | Cloud product concern; v1 stays env-driven |
| Token scopes (read-only, per-route) | YAGNI for v1; add when a real automation use case asks |
| Password reset email flow | Email infra is its own surface; admin-CLI script covers v1 self-hosters |
| Open signup mode (no allowlist) | `OPEN_SIGNUP=true` env reserved for v1.1 when there's a hosted SaaS context |
| SAML, LDAP, magic-link auth | OIDC covers the v1 audience |
| Multi-tenant workspace UI + `ZUGZUG_MULTI_TENANT` flag | Cloud product introduces both together |
| OIDC provider auto-discovery from common domains | Manual config is fine for v1; auto-discovery via `email_domain → OIDC issuer` mapping is a UX nicety |
| 2FA / TOTP | Big surface; not adoption-blocking for v1 |

---

## Migration / rollout

- **PR 1 first** (cleanups + MD-writable). Low-risk; immediately useful. Merge to main, deploy.
- **PR 2 second** (auth refactor). Higher-risk. Suggested rollout:
  - Land in a feature branch, deploy to a staging environment first.
  - BC sets `OIDC_*` env vars in staging, verifies their users can log in.
  - Once verified, merge to main and BC updates production env vars same-deploy.
  - Drizzle migration runs once on first server start; no manual SQL.
- Existing sessions remain valid across both PRs.

---

## References

- Parent spec: `docs/superpowers/specs/2026-06-08-oss-pivot-design.md` (Phase 4 section)
- Phase 3 spec: `docs/superpowers/specs/2026-06-08-phase3-canonical-store-modes-design.md`
- Current auth: `server/src/auth.ts` (Google-OAuth-only)
- Drizzle schema: `server/drizzle/schema.ts`
- `openid-client` docs: <https://github.com/panva/openid-client>
- argon2id (recommended via `argon2` npm package or Bun's built-in `Bun.password.hash`): Bun's built-in is preferred — zero dep, argon2id default
- DuckDB MERGE INTO syntax: <https://duckdb.org/docs/sql/statements/merge> (supported since 0.10.0)
