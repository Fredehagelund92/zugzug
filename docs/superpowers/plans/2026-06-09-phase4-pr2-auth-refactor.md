***REMOVED*** Phase 4 PR 2 — Auth Refactor + API Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Google-OAuth-only auth with a generic `openid-client` OIDC flow OR local email/password (one-or-the-other per deployment); add API tokens for headless dbt/CI use; preserve BC's deployment via env-driven OIDC config pointing at Google.

**Architecture:** Auth mode is resolved at startup from `OIDC_ISSUER_URL` env (set → OIDC; unset → password). `auth.ts` becomes a thin coordinator that dispatches to `auth-password.ts` or `auth-oidc.ts` based on mode. API tokens are stored as argon2id hashes; bearer-token auth falls back when the cookie session isn't present. Drizzle migration adds `password_hash` + `auth_provider` to `users` and creates `api_tokens` table; existing Google-OAuth users are migrated to `auth_provider='oidc'` in-place (sessions remain valid).

**Tech Stack:** Bun + TypeScript strict, `openid-client` v6 (functional API), `Bun.password.hash`/`verify` (argon2id, no external dep), `postgres.js`, Drizzle ORM, `bun:test`, React + Vite + vitest + @testing-library/react.

**Spec reference:** `docs/superpowers/specs/2026-06-09-phase4-strip-bc-isms-design.md` (PR 2 section).

**BC migration is the highest risk:** the Drizzle migration only ADDS columns/tables — it never touches the `sessions` table — so existing BC users stay logged in across the cutover. BC's deployment migrates by setting `OIDC_ISSUER_URL=https://accounts.google.com`, `OIDC_CLIENT_ID/SECRET` (reusing existing Google credentials), and `OIDC_ALLOWED_DOMAIN=example.com`. The existing `google_sub` column is kept (renamed in spirit, not in schema — the column stores any OIDC provider's `sub` claim now).

**Verification gate (must all pass at end of phase):**

1. `cd server && bun run typecheck` — clean
2. `cd server && bun run lint` — clean
3. `cd server && bun run format:check` — clean
4. `cd server && bun run test` — all existing tests pass + new auth/token tests (target: ~110+ total)
5. `cd app && bun run typecheck` — clean
6. `cd app && bun run format:check` — clean
7. `cd app && bun run test` — all existing tests pass + new login/signup/tokens tests (target: ~125+ total)
8. `cd server && bun run db:migrate` against a fresh DB — succeeds; users + api_tokens schema correct
9. `cd server && bun run db:migrate` against a DB with existing Google-OAuth user — succeeds; user's `auth_provider` flipped to `'oidc'`; session cookie still valid
10. Password-mode boot smoke: server starts; Login renders password form; can signup as first user (admin), login as that user, generate API token, use token to fetch protected route
11. OIDC-mode boot smoke (with mocked provider): server starts with `OIDC_ISSUER_URL` set; Login renders SSO button; `/api/auth/oidc/start` redirects to mock issuer
12. `grep -rn "handleGoogleRedirect\|handleGoogleCallback" server/src/` — zero matches (Google-specific handlers removed)
13. Admin-CLI reset-password script: `bun run reset-password user@example.com newpassword123` rewrites the hash; user can log in with the new password

---

***REMOVED******REMOVED*** File structure (post-phase)

```
server/
  package.json                                  ***REMOVED*** MODIFIED — adds openid-client
server/drizzle/
  schema.ts                                     ***REMOVED*** MODIFIED — users.password_hash + auth_provider; new api_tokens table
  migrations/000N_phase4_auth.sql               ***REMOVED*** GENERATED via bun run db:generate
server/src/
  env.ts                                        ***REMOVED*** MODIFIED — adds OIDC_*, derives authMode
  auth.ts                                       ***REMOVED*** REWRITTEN — thin coordinator + getSessionUser + handleAuthConfig + handleLogout + handleMe + handleDevLogin
  auth-password.ts                              ***REMOVED*** NEW — handleSignup, handleLogin, handleChangePassword
  auth-oidc.ts                                  ***REMOVED*** NEW — discovery + handleOidcStart + handleOidcCallback (uses openid-client v6)
  auth-api-tokens.ts                            ***REMOVED*** NEW — token utils + handleListTokens/handleCreateToken/handleRevokeToken + getApiTokenUser middleware
  server.ts                                     ***REMOVED*** MODIFIED — route dispatch + bearer-token fallback in session gate
server/scripts/
  reset-password.ts                             ***REMOVED*** NEW — Bun CLI script for admin password reset
server/test/
  auth-password.test.ts                         ***REMOVED*** NEW
  auth-oidc.test.ts                             ***REMOVED*** NEW (mocks openid-client config)
  auth-api-tokens.test.ts                       ***REMOVED*** NEW
  auth-config.test.ts                           ***REMOVED*** NEW (small — tests /api/auth/config response shape per mode)
  reset-password.test.ts                        ***REMOVED*** NEW (small — verifies the CLI updates the hash)
app/src/
  store.ts                                      ***REMOVED*** MODIFIED — adds AuthConfig + useAuthConfig + API token actions; deprecates allowedDomain from WorkspaceInfo
  main.tsx                                      ***REMOVED*** MODIFIED — adds /signup route
  routes/Login.tsx                              ***REMOVED*** REWRITTEN — fetches /api/auth/config; renders password form OR SSO button
  routes/Signup.tsx                             ***REMOVED*** NEW — email + password + name form
  routes/Settings.tsx                           ***REMOVED*** MODIFIED — adds "API tokens" Section + read allowedDomain from useAuthConfig instead of useWorkspaceInfo
app/test/
  login-mode-aware.test.tsx                     ***REMOVED*** NEW — Login renders right UI per config mode
  signup.test.tsx                               ***REMOVED*** NEW — Signup form validation + submit
  api-tokens-settings.test.tsx                  ***REMOVED*** NEW — list, create-once-show, revoke flows
```

---

***REMOVED******REMOVED*** Task 1: Add `openid-client` dependency

**Files:**
- Modify: `server/package.json` (auto via `bun add`)

- [ ] **Step 1: Add the dependency**

Run from `server/`:
```bash
bun add openid-client
```

This pulls in `openid-client` v6.x (the rewritten functional API). The library is a runtime dep — used at request time for OIDC discovery and token exchange.

- [ ] **Step 2: Verify install**

```bash
bun pm ls | grep openid-client
```
Expected: a line like `openid-client@6.x.x`.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```
Expected: no errors. Nothing imports it yet.

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/bun.lock
git commit -m "chore(server): add openid-client for generic OIDC auth"
```

---

***REMOVED******REMOVED*** Task 2: Drizzle migration — `password_hash`, `auth_provider`, `api_tokens` table

**Files:**
- Modify: `server/drizzle/schema.ts`
- Generated: `server/drizzle/migrations/000N_phase4_auth.sql` (filename depends on existing migration count)

***REMOVED******REMOVED******REMOVED*** Step 1 — Read current schema

Read `/Users/fhagelund/Documents/GitHub/zugzug/server/drizzle/schema.ts` end-to-end to see the existing `users` table and the migration-naming convention.

***REMOVED******REMOVED******REMOVED*** Step 2 — Update `users` table

In `server/drizzle/schema.ts`, find the `users` table definition. Replace:

```ts
export const users = app.table(
  "users",
  {
    id:         varchar("id").primaryKey(),
    name:       varchar("name").notNull(),
    initials:   varchar("initials").notNull(),
    email:      varchar("email"),
    google_sub: varchar("google_sub"),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email).where(sql`email IS NOT NULL`),
    uniqueIndex("users_google_sub_unique").on(t.google_sub).where(sql`google_sub IS NOT NULL`),
  ],
);
```

with:

```ts
export const users = app.table(
  "users",
  {
    id:            varchar("id").primaryKey(),
    name:          varchar("name").notNull(),
    initials:      varchar("initials").notNull(),
    email:         varchar("email"),
    google_sub:    varchar("google_sub"),
    password_hash: varchar("password_hash"),
    auth_provider: varchar("auth_provider").notNull().default("password"),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email).where(sql`email IS NOT NULL`),
    uniqueIndex("users_google_sub_unique").on(t.google_sub).where(sql`google_sub IS NOT NULL`),
  ],
);
```

(The `google_sub` column is intentionally kept — Phase 4 PR 2 will use it to store ANY OIDC provider's `sub` claim, not just Google's. The column name stays for backwards-compatibility with the migration data; a future cleanup could rename it to `oidc_sub` but that's a separate scope.)

***REMOVED******REMOVED******REMOVED*** Step 3 — Add `api_tokens` table

In `server/drizzle/schema.ts`, after the `users` table definition, add:

```ts
export const apiTokens = app.table(
  "api_tokens",
  {
    id:           varchar("id").primaryKey(),
    user_id:      varchar("user_id").notNull(),
    name:         varchar("name").notNull(),
    token_hash:   varchar("token_hash").notNull(),
    created_at:   timestamp("created_at").notNull(),
    last_used_at: timestamp("last_used_at"),
    revoked_at:   timestamp("revoked_at"),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_unique").on(t.token_hash),
    index("api_tokens_user_id_idx").on(t.user_id),
  ],
);
```

***REMOVED******REMOVED******REMOVED*** Step 4 — Generate migration SQL

```bash
cd server && bun run db:generate
```

Expected: a new file in `server/drizzle/migrations/` named like `000N_<adjective>_<noun>.sql` (e.g. `0001_strange_cardiac.sql`). Inspect the generated SQL:

```bash
ls -t server/drizzle/migrations/ | head -3
cat server/drizzle/migrations/<the_new_file>.sql
```

Expected SQL: `ALTER TABLE "zugzug_app"."users" ADD COLUMN "password_hash"`, `ALTER TABLE "zugzug_app"."users" ADD COLUMN "auth_provider" varchar NOT NULL DEFAULT 'password'`, `CREATE TABLE "zugzug_app"."api_tokens" (...)`, plus the unique index and the regular index.

***REMOVED******REMOVED******REMOVED*** Step 5 — Add post-migration data backfill

The Drizzle-generated migration won't include the data-migration step (set `auth_provider='oidc'` for existing Google-OAuth users). Append it manually to the generated SQL file:

```sql
-- Backfill: existing users with a google_sub came in via Google OAuth (now OIDC).
UPDATE "zugzug_app"."users" SET "auth_provider" = 'oidc' WHERE "google_sub" IS NOT NULL;
```

This is safe to run on a fresh DB (the UPDATE just matches zero rows).

***REMOVED******REMOVED******REMOVED*** Step 6 — Run the migration against the test DB

```bash
cd server && bun run db:migrate
```
Expected: migration applies cleanly. Inspect the result:

```bash
docker compose -f server/docker-compose.test.yml exec pg psql -U zugzug -d zugzug_test -c "\d zugzug_app.users"
```

Should show `password_hash varchar` and `auth_provider varchar NOT NULL DEFAULT 'password'` plus existing columns.

```bash
docker compose -f server/docker-compose.test.yml exec pg psql -U zugzug -d zugzug_test -c "\d zugzug_app.api_tokens"
```

Should show the new table.

***REMOVED******REMOVED******REMOVED*** Step 7 — Typecheck + test

```bash
cd server && bun run typecheck && bun run test
```
Expected: clean + all existing tests pass (no test currently uses the new columns, so they're a no-op).

***REMOVED******REMOVED******REMOVED*** Step 8 — Commit

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/
git commit -m "feat(db): users.password_hash + auth_provider; new api_tokens table"
```

---

***REMOVED******REMOVED*** Task 3: env.ts — `OIDC_*` env vars + `authMode` derivation

**Files:**
- Modify: `server/src/env.ts`
- Modify: `server/.env.example`

***REMOVED******REMOVED******REMOVED*** Step 1 — Update env.ts

In `server/src/env.ts`, replace the existing `googleClientId` / `googleClientSecret` / `allowedDomain` block with a generic OIDC block. Keep the Google fields as `unused` (deprecated, read but ignored) for backward compatibility during the BC rollout — they'll be deleted in a follow-up cleanup.

Find:

```ts
// Google OAuth2
googleClientId: required("GOOGLE_CLIENT_ID"),
googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
/** Email domain allowed to log in (e.g. "example.com"). */
allowedDomain: process.env.ALLOWED_DOMAIN?.trim() || "",
```

Replace with:

```ts
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
```

Note `allowedDomain` falls back to `OIDC_ALLOWED_DOMAIN` if `ALLOWED_DOMAIN` isn't set — this lets BC migrate by just setting the OIDC vars; their existing `ALLOWED_DOMAIN=example.com` would still work if set.

Also: REMOVE the `googleClientId: required("GOOGLE_CLIENT_ID")` and `googleClientSecret: required("GOOGLE_CLIENT_SECRET")` calls — these would crash the server on startup since BC's existing `.env` has them but we don't need them anymore for the new OIDC path. Replace with optional reads (in case any code still references them during the transition):

```ts
/** @deprecated — replaced by OIDC_CLIENT_ID. Kept as optional for transition; not read by new code. */
googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || "",
/** @deprecated — replaced by OIDC_CLIENT_SECRET. */
googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || "",
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Update .env.example

In `server/.env.example`, find the Google OAuth section. Replace with:

```bash
***REMOVED*** === Authentication ===
***REMOVED***
***REMOVED*** Two modes (one-or-the-other per deployment):
***REMOVED***
***REMOVED*** 1) PASSWORD MODE (default when OIDC_ISSUER_URL is unset):
***REMOVED***    Local email + password. First user to sign up becomes the admin and
***REMOVED***    is added to the allowlist. Subsequent users must be invited by an
***REMOVED***    admin in Settings → Team.
***REMOVED***
***REMOVED*** 2) OIDC MODE (when OIDC_ISSUER_URL is set):
***REMOVED***    Single-sign-on via any OpenID Connect provider (Google Workspace,
***REMOVED***    Okta, Authentik, Keycloak, etc.). The "Sign in with SSO" button
***REMOVED***    appears on the login page.
***REMOVED***
***REMOVED*** Set the OIDC_* env vars below to enable OIDC mode. Example for Google:
***REMOVED***   OIDC_ISSUER_URL=https://accounts.google.com
***REMOVED***   OIDC_CLIENT_ID=...your.google.client.id...
***REMOVED***   OIDC_CLIENT_SECRET=...your.google.client.secret...
***REMOVED***   OIDC_ALLOWED_DOMAIN=example.com    (optional; restricts signups)
***REMOVED***   OIDC_LABEL=Google                  (optional; shown on the SSO button)

OIDC_ISSUER_URL=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_ALLOWED_DOMAIN=
OIDC_LABEL=

***REMOVED*** Legacy: ALLOWED_DOMAIN. Restricts signups in BOTH password and OIDC modes.
***REMOVED*** Falls back to OIDC_ALLOWED_DOMAIN if unset.
ALLOWED_DOMAIN=

***REMOVED*** Deprecated: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
***REMOVED*** These were used by the Google-OAuth-only path that's been replaced by
***REMOVED*** generic OIDC. If you previously used Google OAuth, migrate by setting:
***REMOVED***   OIDC_ISSUER_URL=https://accounts.google.com
***REMOVED***   OIDC_CLIENT_ID=<your existing GOOGLE_CLIENT_ID>
***REMOVED***   OIDC_CLIENT_SECRET=<your existing GOOGLE_CLIENT_SECRET>
***REMOVED*** The GOOGLE_* vars are no longer read.
```

If a Google block already exists in `.env.example` (it probably does), replace it; don't duplicate.

***REMOVED******REMOVED******REMOVED*** Step 3 — Typecheck

```bash
cd server && bun run typecheck
```
Expected: clean. Existing imports of `env.googleClientId`/`env.googleClientSecret` still work (they read empty strings now).

***REMOVED******REMOVED******REMOVED*** Step 4 — Commit

```bash
git add server/src/env.ts server/.env.example
git commit -m "feat(env): OIDC_* env vars + authMode derivation; deprecate GOOGLE_*"
```

---

***REMOVED******REMOVED*** Task 4: `GET /api/auth/config` endpoint + tests

**Files:**
- Modify: `server/src/auth.ts` (replace `handleAuthConfig`)
- Modify: `server/src/server.ts` (route already exists; just confirms it still dispatches)
- Create: `server/test/auth-config.test.ts`

The route exists (line ~121 in server.ts: `if (seg[2] === "config" && method === "GET") return handleAuthConfig();`). We're rewriting the handler.

***REMOVED******REMOVED******REMOVED*** Step 1 — Write failing tests

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/test/auth-config.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { handleAuthConfig } from "../src/auth.ts";

beforeEach(async () => {
  await resetDb();
});

test("auth config — password mode default (no OIDC_ISSUER_URL)", async () => {
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_ALLOWED_DOMAIN;
  delete process.env.OIDC_LABEL;
  delete process.env.ALLOWED_DOMAIN;

  const res = handleAuthConfig();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    mode: "password" | "oidc";
    signupOpen: boolean;
    allowedDomain: string | null;
    oidcLabel?: string;
  };
  expect(body.mode).toBe("password");
  expect(body.signupOpen).toBe(false);
  expect(body.allowedDomain).toBeNull();
  expect(body.oidcLabel).toBeUndefined();
});

test("auth config — OIDC mode when OIDC_ISSUER_URL is set", async () => {
  process.env.OIDC_ISSUER_URL = "https://accounts.google.com";
  process.env.OIDC_LABEL = "Google";
  process.env.OIDC_ALLOWED_DOMAIN = "example.com";

  // env.ts reads at module load; force a re-import for the test
  const { handleAuthConfig: freshHandler } = await import("../src/auth.ts?reload=" + Date.now());
  const res = freshHandler();
  const body = (await res.json()) as {
    mode: "password" | "oidc";
    allowedDomain: string | null;
    oidcLabel?: string;
  };
  expect(body.mode).toBe("oidc");
  expect(body.allowedDomain).toBe("example.com");
  expect(body.oidcLabel).toBe("Google");
});

test("auth config — allowedDomain comes from ALLOWED_DOMAIN if set, OIDC_ALLOWED_DOMAIN as fallback", async () => {
  process.env.ALLOWED_DOMAIN = "primary.com";
  process.env.OIDC_ALLOWED_DOMAIN = "fallback.com";
  delete process.env.OIDC_ISSUER_URL;

  const { handleAuthConfig: freshHandler } = await import("../src/auth.ts?reload=" + Date.now());
  const res = freshHandler();
  const body = (await res.json()) as { allowedDomain: string | null };
  expect(body.allowedDomain).toBe("primary.com");
});
```

**Caveat about env-var-driven tests:** Bun's test runner caches modules, so changes to `process.env` after a module imports `env.ts` won't propagate. The `import("...?reload=" + Date.now())` trick is a known workaround. If it doesn't work in this codebase, the alternative is to make `handleAuthConfig` accept a config object parameter (injectable) and let the route handler in `server.ts` read from `env` and pass it in. For PR 2 v1, do the import-cache-bust; if it's flaky, refactor to dep-injection.

***REMOVED******REMOVED******REMOVED*** Step 2 — Run, verify failure

```bash
cd server && bun run test test/auth-config.test.ts
```
Expected: tests FAIL — handler returns the old shape (empty object).

***REMOVED******REMOVED******REMOVED*** Step 3 — Rewrite `handleAuthConfig` in auth.ts

In `server/src/auth.ts`, find:

```ts
export function handleAuthConfig(): Response {
  return new Response(JSON.stringify({}), {
    headers: { "content-type": "application/json", ...cors },
  });
}
```

Replace with:

```ts
export function handleAuthConfig(): Response {
  const body: {
    mode: "password" | "oidc";
    signupOpen: boolean;
    allowedDomain: string | null;
    oidcLabel?: string;
  } = {
    mode: env.authMode,
    signupOpen: false, // Reserved for v1.1 OPEN_SIGNUP=true env flag.
    allowedDomain: env.allowedDomain || null,
  };
  if (env.authMode === "oidc" && env.oidcLabel) {
    body.oidcLabel = env.oidcLabel;
  }
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...cors },
  });
}
```

***REMOVED******REMOVED******REMOVED*** Step 4 — Run tests, verify pass

```bash
cd server && bun run test test/auth-config.test.ts
```
Expected: tests pass.

If the env-var-driven tests don't work due to module caching, refactor as noted in Step 1 — extract a `buildAuthConfig(env)` pure function and test that directly; the handler becomes `return new Response(JSON.stringify(buildAuthConfig(env)), {...})`.

***REMOVED******REMOVED******REMOVED*** Step 5 — Typecheck + lint + format

```bash
cd server && bun run typecheck && bun run lint && bun run format:check
```
Expected: clean.

***REMOVED******REMOVED******REMOVED*** Step 6 — Commit

```bash
git add server/src/auth.ts server/test/auth-config.test.ts
git commit -m "feat(auth): /api/auth/config returns mode + allowedDomain + oidcLabel"
```

---

***REMOVED******REMOVED*** Task 5: `auth-password.ts` — signup, login, change-password endpoints + tests

**Files:**
- Create: `server/src/auth-password.ts`
- Create: `server/test/auth-password.test.ts`
- Modify: `server/src/server.ts` (wire new routes — temporarily; final wiring lands in Task 9)

***REMOVED******REMOVED******REMOVED*** Step 1 — Create auth-password.ts

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/src/auth-password.ts`:

```ts
/* auth-password.ts — Local email + password auth handlers.
   Active when env.authMode === "password" (i.e. OIDC_ISSUER_URL is unset).
   Uses Bun.password.hash/verify (argon2id default). */

import { env, pg } from "./env.ts";
import { pgRun, pgAll, pgGet } from "./pg.ts";
import { issueSession } from "./auth.ts";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12;

interface SignupBody {
  email: string;
  password: string;
  name: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "??"
  );
}

/** POST /api/auth/signup — body: {email, password, name} */
export async function handleSignup(req: Request): Promise<Response> {
  let body: SignupBody;
  try {
    body = (await req.json()) as SignupBody;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim();

  if (!EMAIL_RX.test(email)) return jsonError(400, "invalid_email");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return jsonError(400, "password_too_short", { minLength: MIN_PASSWORD_LENGTH });
  }
  if (!name) return jsonError(400, "name_required");
  if (env.allowedDomain && email.split("@")[1] !== env.allowedDomain) {
    return jsonError(400, "domain_not_allowed", { allowedDomain: env.allowedDomain });
  }

  // First user becomes admin (and is added to allowlist).
  // Subsequent users must already be on the allowlist.
  const [{ n: userCount }] = await pgAll<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${pg("users")}`,
  );
  if (userCount === 0) {
    await pgRun(
      `INSERT INTO ${pg("allowed_emails")} (email, added_by, added_at)
       VALUES ($1, 'bootstrap', current_timestamp)
       ON CONFLICT (email) DO NOTHING`,
      [email],
    );
  } else {
    const allowed = await pgGet(
      `SELECT email FROM ${pg("allowed_emails")} WHERE email = $1`,
      [email],
    );
    if (!allowed) return jsonError(403, "not_allowed");
  }

  // Check email isn't already used (by either auth provider)
  const existing = await pgGet(`SELECT id FROM ${pg("users")} WHERE email = $1`, [email]);
  if (existing) return jsonError(409, "email_taken");

  const hash = await Bun.password.hash(password); // argon2id default
  const userId = `u_${crypto.randomUUID().replace(/-/g, "")}`;
  await pgRun(
    `INSERT INTO ${pg("users")} (id, name, email, initials, password_hash, auth_provider)
     VALUES ($1, $2, $3, $4, $5, 'password')`,
    [userId, name, email, initialsOf(name), hash],
  );

  const { cookie } = await issueSession(userId);
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ id: userId, name, email }), { status: 200, headers });
}

/** POST /api/auth/login — body: {email, password} */
export async function handleLogin(req: Request): Promise<Response> {
  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  // Generic error message — don't reveal whether email exists.
  const genericFail = jsonError(401, "invalid_credentials");

  if (!EMAIL_RX.test(email) || password.length === 0) return genericFail;

  const user = await pgGet<{ id: string; name: string; email: string; password_hash: string | null; auth_provider: string }>(
    `SELECT id, name, email, password_hash, auth_provider FROM ${pg("users")} WHERE email = $1`,
    [email],
  );
  if (!user || user.auth_provider !== "password" || !user.password_hash) return genericFail;

  const ok = await Bun.password.verify(password, user.password_hash);
  if (!ok) return genericFail;

  const { cookie } = await issueSession(user.id);
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ id: user.id, name: user.name, email: user.email }), {
    status: 200,
    headers,
  });
}

/** POST /api/auth/change-password — body: {currentPassword, newPassword}; authenticated. */
export async function handleChangePassword(req: Request, userId: string): Promise<Response> {
  let body: ChangePasswordBody;
  try {
    body = (await req.json()) as ChangePasswordBody;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const current = String(body.currentPassword ?? "");
  const next = String(body.newPassword ?? "");

  if (next.length < MIN_PASSWORD_LENGTH) {
    return jsonError(400, "password_too_short", { minLength: MIN_PASSWORD_LENGTH });
  }

  const user = await pgGet<{ password_hash: string | null; auth_provider: string }>(
    `SELECT password_hash, auth_provider FROM ${pg("users")} WHERE id = $1`,
    [userId],
  );
  if (!user || user.auth_provider !== "password" || !user.password_hash) {
    return jsonError(400, "not_password_user");
  }
  const ok = await Bun.password.verify(current, user.password_hash);
  if (!ok) return jsonError(401, "wrong_current_password");

  const newHash = await Bun.password.hash(next);
  await pgRun(`UPDATE ${pg("users")} SET password_hash = $1 WHERE id = $2`, [newHash, userId]);

  return new Response(null, { status: 204 });
}
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Add `issueSession` helper to auth.ts

The new password handlers (and OIDC handlers in Task 6) need to issue session cookies. Extract the existing session-creation logic from `handleGoogleCallback` into a shared helper.

In `/Users/fhagelund/Documents/GitHub/zugzug/server/src/auth.ts`, ADD (after the existing `getSessionUser` function, before any handlers):

```ts
const SESSION_SECONDS = 30 * 86_400; // 30 days (already a constant in this file)
const SID = "zz_sid"; // (already a constant)

/** Create a session row for the user and return the matching Set-Cookie header. */
export async function issueSession(userId: string): Promise<{ sessionId: string; cookie: string }> {
  const sessionId =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
  await run(
    `INSERT INTO ${pg("sessions")} (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sessionId, userId, expiresAt.toISOString()],
  );
  return { sessionId, cookie: cookie(SID, sessionId, SESSION_SECONDS) };
}
```

(The `cookie()` helper already exists at the top of auth.ts. `run` is the imported `pgRun`. `pg` is imported.)

***REMOVED******REMOVED******REMOVED*** Step 3 — Wire routes temporarily in server.ts

In `/Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts`, find the auth route block (around line 115). Add new dispatch lines BEFORE the catch-all 404 in the auth block:

```ts
if (seg[1] === "auth") {
  if (seg[2] === "google" && method === "GET") return handleGoogleRedirect(req);
  if (seg[2] === "callback" && method === "GET") return handleGoogleCallback(req);
  if (seg[2] === "me" && method === "GET") return handleMe(req);
  if (seg[2] === "logout" && method === "POST") return handleLogout(req);
  if (seg[2] === "config" && method === "GET") return handleAuthConfig();
  if (seg[2] === "signup" && method === "POST") {
    const { handleSignup } = await import("./auth-password.ts");
    return handleSignup(req);
  }
  if (seg[2] === "login" && method === "POST") {
    const { handleLogin } = await import("./auth-password.ts");
    return handleLogin(req);
  }
  // change-password is authenticated — it lives below the session gate
  if (seg[2] === "dev" && method === "GET") {
    if (!env.devBypassAuth) return json({ error: "not found" }, 404);
    return handleDevLogin();
  }
  return json({ error: "not found" }, 404);
}
```

For `change-password` (authenticated), add inside the post-session-gate block (after the session check, before the routing for `/api/preferences` etc.):

```ts
// POST /api/auth/change-password (authenticated)
if (seg[1] === "auth" && seg[2] === "change-password" && method === "POST") {
  const { handleChangePassword } = await import("./auth-password.ts");
  return handleChangePassword(req, me);
}
```

(Place it before the existing route checks; `me` is the userId set on line 137 of server.ts.)

***REMOVED******REMOVED******REMOVED*** Step 4 — Write failing tests

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/test/auth-password.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
delete process.env.OIDC_ISSUER_URL; // password mode
process.env.ALLOWED_DOMAIN = ""; // no domain restriction by default

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { handleSignup, handleLogin, handleChangePassword } from "../src/auth-password.ts";

beforeEach(async () => {
  await resetDb();
});

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/auth/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("signup — first user becomes admin", async () => {
  const res = await handleSignup(jsonReq({ email: "first@example.com", password: "longenoughpw12", name: "Ada Lovelace" }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; name: string; email: string };
  expect(body.email).toBe("first@example.com");
  expect(body.name).toBe("Ada Lovelace");
  expect(res.headers.get("set-cookie")).toContain("zz_sid=");
});

test("signup — rejects weak password", async () => {
  const res = await handleSignup(jsonReq({ email: "weak@example.com", password: "short", name: "Test" }));
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; minLength: number };
  expect(body.error).toBe("password_too_short");
  expect(body.minLength).toBe(12);
});

test("signup — second user requires allowlist", async () => {
  // First user
  await handleSignup(jsonReq({ email: "admin@example.com", password: "longenoughpw12", name: "Admin" }));
  // Second user not on allowlist
  const res = await handleSignup(jsonReq({ email: "rando@example.com", password: "longenoughpw12", name: "Rando" }));
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not_allowed");
});

test("signup — email already in use returns 409", async () => {
  await handleSignup(jsonReq({ email: "dup@example.com", password: "longenoughpw12", name: "First" }));
  const res = await handleSignup(jsonReq({ email: "dup@example.com", password: "longenoughpw13", name: "Second" }));
  expect(res.status).toBe(409);
});

test("login — valid credentials return session cookie", async () => {
  await handleSignup(jsonReq({ email: "test@example.com", password: "longenoughpw12", name: "Test" }));
  const res = await handleLogin(jsonReq({ email: "test@example.com", password: "longenoughpw12" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("zz_sid=");
});

test("login — wrong password returns generic 401", async () => {
  await handleSignup(jsonReq({ email: "test@example.com", password: "longenoughpw12", name: "Test" }));
  const res = await handleLogin(jsonReq({ email: "test@example.com", password: "wrong_password_12" }));
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("invalid_credentials");
});

test("login — unknown email returns same generic 401 (no enumeration)", async () => {
  const res = await handleLogin(jsonReq({ email: "ghost@example.com", password: "longenoughpw12" }));
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("invalid_credentials");
});

test("change-password — success path", async () => {
  // Set up a user
  const signup = await handleSignup(jsonReq({ email: "cp@example.com", password: "originalpw1234", name: "Test" }));
  const userId = ((await signup.clone().json()) as { id: string }).id;

  const res = await handleChangePassword(
    jsonReq({ currentPassword: "originalpw1234", newPassword: "newpassword1234" }),
    userId,
  );
  expect(res.status).toBe(204);

  // Login with new password works
  const login = await handleLogin(jsonReq({ email: "cp@example.com", password: "newpassword1234" }));
  expect(login.status).toBe(200);
});

test("change-password — wrong current returns 401", async () => {
  const signup = await handleSignup(jsonReq({ email: "cp@example.com", password: "originalpw1234", name: "Test" }));
  const userId = ((await signup.clone().json()) as { id: string }).id;

  const res = await handleChangePassword(
    jsonReq({ currentPassword: "wrong", newPassword: "newpassword1234" }),
    userId,
  );
  expect(res.status).toBe(401);
});

test("change-password — short new password returns 400", async () => {
  const signup = await handleSignup(jsonReq({ email: "cp@example.com", password: "originalpw1234", name: "Test" }));
  const userId = ((await signup.clone().json()) as { id: string }).id;

  const res = await handleChangePassword(
    jsonReq({ currentPassword: "originalpw1234", newPassword: "short" }),
    userId,
  );
  expect(res.status).toBe(400);
});
```

***REMOVED******REMOVED******REMOVED*** Step 5 — Run, verify pass

```bash
cd server && bun run test test/auth-password.test.ts
```
Expected: all tests pass.

***REMOVED******REMOVED******REMOVED*** Step 6 — Typecheck + lint + format + full server tests

```bash
cd server && bun run typecheck && bun run lint && bun run format:check && bun run test
```
Expected: clean + all existing tests pass + new auth-password tests pass.

***REMOVED******REMOVED******REMOVED*** Step 7 — Commit

```bash
git add server/src/auth-password.ts server/src/auth.ts server/src/server.ts server/test/auth-password.test.ts
git commit -m "feat(auth): local password signup/login/change-password endpoints"
```

---

***REMOVED******REMOVED*** Task 6: `auth-oidc.ts` — `openid-client` wrapper + start + callback + tests

**Files:**
- Create: `server/src/auth-oidc.ts`
- Create: `server/test/auth-oidc.test.ts`
- Modify: `server/src/server.ts` (wire new routes)

***REMOVED******REMOVED******REMOVED*** Step 1 — Create auth-oidc.ts

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/src/auth-oidc.ts`:

```ts
/* auth-oidc.ts — Generic OpenID Connect flow.
   Active when env.authMode === "oidc" (OIDC_ISSUER_URL is set).
   Uses openid-client v6 (functional API).

   Discovery is lazy + cached: the first OIDC request fetches the issuer's
   .well-known/openid-configuration and caches the Configuration. */

import * as client from "openid-client";
import { env, pg } from "./env.ts";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import { issueSession } from "./auth.ts";

const STATE_COOKIE = "zz_oidc_state";
const NONCE_COOKIE = "zz_oidc_nonce";
const STATE_TTL_SECONDS = 600;

// Override-able for tests: tests pass a fake Configuration via setOidcConfigFactory().
let _configFactory: () => Promise<client.Configuration> = async () => {
  return client.discovery(
    new URL(env.oidcIssuerUrl),
    env.oidcClientId,
    env.oidcClientSecret,
  );
};
let _cachedConfig: Promise<client.Configuration> | null = null;

/** Test helper — replace the Configuration factory and clear the cache. */
export function setOidcConfigFactory(f: () => Promise<client.Configuration>): void {
  _configFactory = f;
  _cachedConfig = null;
}

/** Production helper — reset the cache (used at startup or if env changes). */
export function _resetOidcConfig(): void {
  _cachedConfig = null;
}

async function getOidcConfig(): Promise<client.Configuration> {
  if (!_cachedConfig) _cachedConfig = _configFactory();
  return _cachedConfig;
}

function isSecure(): boolean {
  return env.origin.startsWith("https://");
}

function shortCookie(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure()) parts.push("Secure");
  return parts.join("; ");
}

function clearShortCookie(name: string): string {
  const base = `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
  return isSecure() ? `${base}; Secure` : base;
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function loginErrorRedirect(error: string, ...clearCookies: string[]): Response {
  const headers = new Headers({ Location: `/login?${new URLSearchParams({ error })}` });
  for (const c of clearCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "??"
  );
}

/** GET /api/auth/oidc/start — kick off the OIDC redirect. */
export async function handleOidcStart(_req: Request): Promise<Response> {
  const config = await getOidcConfig();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const redirectUri = `${env.origin}/api/auth/oidc/callback`;

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid profile email",
    state,
    nonce,
  });

  const headers = new Headers({ Location: url.toString() });
  headers.append("Set-Cookie", shortCookie(STATE_COOKIE, state, STATE_TTL_SECONDS));
  headers.append("Set-Cookie", shortCookie(NONCE_COOKIE, nonce, STATE_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/oidc/callback — provider redirects here after consent. */
export async function handleOidcCallback(req: Request): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const expectedState = cookies[STATE_COOKIE];
  const expectedNonce = cookies[NONCE_COOKIE];
  const clearState = clearShortCookie(STATE_COOKIE);
  const clearNonce = clearShortCookie(NONCE_COOKIE);

  if (!expectedState || !expectedNonce) {
    return loginErrorRedirect("state", clearState, clearNonce);
  }

  const config = await getOidcConfig();
  const callbackUrl = new URL(req.url);

  let claims: { sub: string; email?: string; name?: string; given_name?: string; family_name?: string };
  try {
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      expectedState,
      expectedNonce,
    });
    claims = tokens.claims() as typeof claims;
  } catch (e) {
    console.warn(`oidc callback error: ${e instanceof Error ? e.message : String(e)}`);
    return loginErrorRedirect("token", clearState, clearNonce);
  }

  const sub = claims.sub;
  const email = (claims.email ?? "").toLowerCase();
  const name = claims.name ?? email;

  if (!email) return loginErrorRedirect("no_email", clearState, clearNonce);

  // Domain check
  if (env.allowedDomain && email.split("@")[1] !== env.allowedDomain) {
    return loginErrorRedirect("domain", clearState, clearNonce);
  }

  // Allowlist check (with bootstrap: first OIDC user becomes admin)
  const [{ n: userCount }] = await pgAll<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${pg("users")}`,
  );
  if (userCount === 0) {
    await pgRun(
      `INSERT INTO ${pg("allowed_emails")} (email, added_by, added_at)
       VALUES ($1, 'bootstrap', current_timestamp)
       ON CONFLICT (email) DO NOTHING`,
      [email],
    );
  } else {
    const allowed = await pgGet(
      `SELECT email FROM ${pg("allowed_emails")} WHERE email = $1`,
      [email],
    );
    if (!allowed) {
      return loginErrorRedirect("not_allowed", clearState, clearNonce);
    }
  }

  const initials =
    claims.given_name && claims.family_name
      ? `${claims.given_name[0]}${claims.family_name[0]}`.toUpperCase()
      : initialsOf(name);

  const userId = `u_${sub}`;
  await pgRun(
    `INSERT INTO ${pg("users")} (id, name, email, google_sub, initials, auth_provider)
     VALUES ($1, $2, $3, $4, $5, 'oidc')
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       initials = EXCLUDED.initials,
       auth_provider = 'oidc'`,
    [userId, name, email, sub, initials],
  );

  const { cookie } = await issueSession(userId);
  const headers = new Headers({ Location: "/app" });
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", clearNonce);
  headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Wire new routes in server.ts

In `/Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts`, in the auth route block (lines ~115-127), add:

```ts
if (seg[2] === "oidc" && seg[3] === "start" && method === "GET") {
  const { handleOidcStart } = await import("./auth-oidc.ts");
  return handleOidcStart(req);
}
if (seg[2] === "oidc" && seg[3] === "callback" && method === "GET") {
  const { handleOidcCallback } = await import("./auth-oidc.ts");
  return handleOidcCallback(req);
}
```

Place these alongside the other auth routes (before the catch-all 404).

***REMOVED******REMOVED******REMOVED*** Step 3 — Write failing tests

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/test/auth-oidc.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.OIDC_ISSUER_URL = "https://example-issuer.test";
process.env.OIDC_CLIENT_ID = "test-client-id";
process.env.OIDC_CLIENT_SECRET = "test-client-secret";
process.env.OIDC_ALLOWED_DOMAIN = ""; // tests set this per case

import { test, expect, beforeEach, afterAll } from "bun:test";
import { resetDb } from "./setup.ts";
import {
  handleOidcStart,
  handleOidcCallback,
  setOidcConfigFactory,
  _resetOidcConfig,
} from "../src/auth-oidc.ts";

// Build a fake Configuration that openid-client functions accept.
// We need to inject a Configuration whose discovery metadata matches what
// buildAuthorizationUrl and authorizationCodeGrant expect.
function fakeConfig(metadata: Record<string, unknown> = {}) {
  // Minimal Configuration shape: openid-client v6 stores serverMetadata,
  // clientMetadata, and supports the functional helpers. Use a stub that
  // implements just enough.
  return {
    serverMetadata: () => ({
      issuer: "https://example-issuer.test",
      authorization_endpoint: "https://example-issuer.test/authorize",
      token_endpoint: "https://example-issuer.test/token",
      ...metadata,
    }),
    clientMetadata: () => ({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
    }),
  } as unknown as import("openid-client").Configuration;
}

let mockTokenResult: {
  claims: () => { sub: string; email?: string; name?: string };
} | null = null;
let mockShouldThrow: Error | null = null;

beforeEach(async () => {
  await resetDb();
  _resetOidcConfig();
  setOidcConfigFactory(async () => fakeConfig());
  mockTokenResult = null;
  mockShouldThrow = null;
});

// Mock the entire openid-client module's authorization-grant function.
// In Bun, we use mock.module():
import { mock } from "bun:test";
mock.module("openid-client", () => ({
  discovery: async (..._args: unknown[]) => fakeConfig(),
  randomState: () => "test-state",
  randomNonce: () => "test-nonce",
  buildAuthorizationUrl: (_config: unknown, params: Record<string, string>) => {
    const u = new URL("https://example-issuer.test/authorize");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  },
  authorizationCodeGrant: async (_config: unknown, _callbackUrl: unknown, _opts: unknown) => {
    if (mockShouldThrow) throw mockShouldThrow;
    if (!mockTokenResult) throw new Error("no mock token result configured");
    return mockTokenResult;
  },
}));

test("oidc start — redirects to issuer with state + nonce cookies", async () => {
  const res = await handleOidcStart(new Request("http://localhost/api/auth/oidc/start"));
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("https://example-issuer.test/authorize");
  const setCookies = res.headers.getSetCookie();
  expect(setCookies.some((c) => c.includes("zz_oidc_state=test-state"))).toBe(true);
  expect(setCookies.some((c) => c.includes("zz_oidc_nonce=test-nonce"))).toBe(true);
});

test("oidc callback — valid token, first user becomes admin", async () => {
  mockTokenResult = {
    claims: () => ({ sub: "user-sub-1", email: "first@example.com", name: "Ada Lovelace" }),
  };
  const req = new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
    headers: {
      cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce",
    },
  });
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/app");
  expect(res.headers.getSetCookie().some((c) => c.includes("zz_sid="))).toBe(true);
});

test("oidc callback — state mismatch redirects to login with error", async () => {
  // No state cookie present
  const req = new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state");
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("error=state");
});

test("oidc callback — token-exchange failure redirects with error=token", async () => {
  mockShouldThrow = new Error("simulated token exchange failure");
  const req = new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
    headers: {
      cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce",
    },
  });
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("error=token");
});

test("oidc callback — domain mismatch redirects with error=domain", async () => {
  process.env.OIDC_ALLOWED_DOMAIN = "example.com";
  process.env.ALLOWED_DOMAIN = "example.com";
  // Re-import env to pick up the change (env caches at module load; this is a known
  // limitation — see auth-config.test.ts for the same workaround).
  // For this test, the env value matters at handleOidcCallback's domain-check call.

  mockTokenResult = {
    claims: () => ({ sub: "user-sub-2", email: "outsider@otherdomain.com", name: "Outsider" }),
  };
  const req = new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
    headers: {
      cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce",
    },
  });
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("error=domain");

  // Cleanup for subsequent tests
  delete process.env.OIDC_ALLOWED_DOMAIN;
  delete process.env.ALLOWED_DOMAIN;
});

test("oidc callback — upserts existing user by sub", async () => {
  // First callback creates user
  mockTokenResult = {
    claims: () => ({ sub: "user-sub-3", email: "upsert@example.com", name: "Old Name" }),
  };
  await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );

  // Second callback updates name
  mockTokenResult = {
    claims: () => ({ sub: "user-sub-3", email: "upsert@example.com", name: "New Name" }),
  };
  const res = await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=def&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );
  expect(res.status).toBe(302);
  // Verify the user's name was updated
  const { pgGet } = await import("../src/pg.ts");
  const user = await pgGet<{ name: string; auth_provider: string }>(
    `SELECT name, auth_provider FROM zugzug_app.users WHERE id = 'u_user-sub-3'`,
  );
  expect(user?.name).toBe("New Name");
  expect(user?.auth_provider).toBe("oidc");
});

afterAll(() => {
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_ALLOWED_DOMAIN;
  delete process.env.ALLOWED_DOMAIN;
});
```

**Note on mocking strategy:** `bun:test`'s `mock.module()` replaces the module for all subsequent imports. The `setOidcConfigFactory` injection point is a secondary mechanism for cases where module-mock doesn't fit (e.g., a test that needs different configs across cases). If the `mock.module()` approach turns out flaky in Bun, switch entirely to dependency injection: `auth-oidc.ts` exports a factory function that takes the entire openid-client interface as a parameter, and tests pass a fake.

***REMOVED******REMOVED******REMOVED*** Step 4 — Run, verify pass

```bash
cd server && bun run test test/auth-oidc.test.ts
```
Expected: all tests pass.

***REMOVED******REMOVED******REMOVED*** Step 5 — Typecheck + lint + format + full server tests

```bash
cd server && bun run typecheck && bun run lint && bun run format:check && bun run test
```
Expected: clean + all pass.

***REMOVED******REMOVED******REMOVED*** Step 6 — Commit

```bash
git add server/src/auth-oidc.ts server/src/server.ts server/test/auth-oidc.test.ts
git commit -m "feat(auth): generic OIDC start/callback via openid-client v6"
```

---

***REMOVED******REMOVED*** Task 7: `auth-api-tokens.ts` — endpoints + middleware + tests

**Files:**
- Create: `server/src/auth-api-tokens.ts`
- Create: `server/test/auth-api-tokens.test.ts`
- Modify: `server/src/server.ts` (wire routes; bearer-token middleware integration lands in Task 8)

***REMOVED******REMOVED******REMOVED*** Step 1 — Create auth-api-tokens.ts

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/src/auth-api-tokens.ts`:

```ts
/* auth-api-tokens.ts — Personal-access-token endpoints + bearer-token auth.

   Token format: "zz_" + 32 random bytes URL-base64 (≈43 chars total).
   Stored as Bun.password.hash (argon2id). The value is shown to the user
   exactly once at creation; recovery requires revoke + reissue. */

import { env, pg } from "./env.ts";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import type { SessionUser } from "./auth.ts";

const TOKEN_PREFIX = "zz_";

function generateTokenValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // URL-safe base64 without padding
  const b64 = Buffer.from(bytes).toString("base64url");
  return `${TOKEN_PREFIX}${b64}`;
}

interface TokenRow {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

interface CreateBody {
  name: string;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GET /api/tokens — list current user's active tokens (no values). */
export async function handleListTokens(userId: string): Promise<Response> {
  const rows = await pgAll<TokenRow>(
    `SELECT id, name, created_at::text AS created_at, last_used_at::text AS last_used_at
     FROM ${pg("api_tokens")}
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return new Response(JSON.stringify({ tokens: rows }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** POST /api/tokens — body {name} → returns {id, name, value} (value shown once). */
export async function handleCreateToken(req: Request, userId: string): Promise<Response> {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const name = String(body.name ?? "").trim();
  if (!name) return jsonError(400, "name_required");
  if (name.length > 100) return jsonError(400, "name_too_long");

  const id = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
  const value = generateTokenValue();
  const hash = await Bun.password.hash(value); // argon2id default

  await pgRun(
    `INSERT INTO ${pg("api_tokens")} (id, user_id, name, token_hash, created_at)
     VALUES ($1, $2, $3, $4, current_timestamp)`,
    [id, userId, name, hash],
  );

  // Value shown only at this response; never readable again.
  return new Response(JSON.stringify({ id, name, value }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

/** DELETE /api/tokens/:id — set revoked_at. Idempotent (404 if not found OR not owned). */
export async function handleRevokeToken(tokenId: string, userId: string): Promise<Response> {
  const result = await pgRun(
    `UPDATE ${pg("api_tokens")}
     SET revoked_at = current_timestamp
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tokenId, userId],
  );
  // pgRun doesn't return rowCount in our helper, so just return 204 — the next
  // listTokens call will reflect the revocation. We don't reveal whether the
  // token actually existed.
  void result;
  return new Response(null, { status: 204 });
}

/** Bearer-token authentication: parse Authorization header, hash-compare against
 *  active (non-revoked) tokens. Returns the matching SessionUser or null.
 *
 *  Performance note: this iterates active tokens (argon2id is intentionally slow).
 *  In production with thousands of tokens this would need a faster lookup
 *  (e.g. unhashed prefix index); v1 prioritizes simplicity over scale. */
export async function getApiTokenUser(req: Request): Promise<SessionUser | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  // We must compare against every active token's hash (argon2 doesn't support
  // pre-image lookups). Acceptable for v1 — production self-hosters have
  // single-digit-to-tens of active tokens.
  const candidates = await pgAll<{ id: string; user_id: string; token_hash: string }>(
    `SELECT id, user_id, token_hash FROM ${pg("api_tokens")}
     WHERE revoked_at IS NULL`,
  );
  for (const cand of candidates) {
    if (await Bun.password.verify(token, cand.token_hash)) {
      // Fire-and-forget last_used_at update; don't block the request on it.
      void pgRun(
        `UPDATE ${pg("api_tokens")} SET last_used_at = current_timestamp WHERE id = $1`,
        [cand.id],
      ).catch(() => {});
      const user = await pgGet<SessionUser>(
        `SELECT id, name, email, initials FROM ${pg("users")} WHERE id = $1`,
        [cand.user_id],
      );
      return user;
    }
  }
  return null;
}

// env import is unused inside this module but kept for future config (e.g. token TTL)
void env;
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Wire routes in server.ts

In `/Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts`, in the post-session-gate route block (after the auth check at line ~137), add:

```ts
// API token management (authenticated; session-required not bearer-required)
if (seg[1] === "tokens") {
  if (seg.length === 2 && method === "GET") {
    const { handleListTokens } = await import("./auth-api-tokens.ts");
    return handleListTokens(me);
  }
  if (seg.length === 2 && method === "POST") {
    const { handleCreateToken } = await import("./auth-api-tokens.ts");
    return handleCreateToken(req, me);
  }
  if (seg.length === 3 && method === "DELETE") {
    const { handleRevokeToken } = await import("./auth-api-tokens.ts");
    return handleRevokeToken(seg[2], me);
  }
}
```

Place this alongside other authenticated route blocks (e.g. before `/api/preferences`).

***REMOVED******REMOVED******REMOVED*** Step 3 — Write failing tests

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/test/auth-api-tokens.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
delete process.env.OIDC_ISSUER_URL;
process.env.ALLOWED_DOMAIN = "";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import {
  handleCreateToken,
  handleListTokens,
  handleRevokeToken,
  getApiTokenUser,
} from "../src/auth-api-tokens.ts";
import { handleSignup } from "../src/auth-password.ts";
import { pgGet } from "../src/pg.ts";

beforeEach(async () => {
  await resetDb();
});

async function newUser(email = "u@example.com"): Promise<string> {
  const res = await handleSignup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "longenoughpw12", name: "Tester" }),
    }),
  );
  const body = (await res.json()) as { id: string };
  return body.id;
}

test("create token — returns value once with zz_ prefix", async () => {
  const userId = await newUser();
  const req = new Request("http://localhost/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "dbt-prod" }),
  });
  const res = await handleCreateToken(req, userId);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; name: string; value: string };
  expect(body.id).toMatch(/^tok_/);
  expect(body.name).toBe("dbt-prod");
  expect(body.value).toMatch(/^zz_/);
  expect(body.value.length).toBeGreaterThan(40);
});

test("create token — stores hash not value", async () => {
  const userId = await newUser();
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "leak-test" }),
    }),
    userId,
  );
  const body = (await res.json()) as { id: string; value: string };

  const row = await pgGet<{ token_hash: string }>(
    `SELECT token_hash FROM zugzug_app.api_tokens WHERE id = $1`,
    [body.id],
  );
  expect(row?.token_hash).toBeDefined();
  expect(row?.token_hash).not.toBe(body.value);
  expect(row?.token_hash).toMatch(/^\$argon2/); // argon2id hash format
});

test("list tokens — omits values, includes name + created", async () => {
  const userId = await newUser();
  await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alpha" }),
    }),
    userId,
  );
  await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "beta" }),
    }),
    userId,
  );
  const res = await handleListTokens(userId);
  const body = (await res.json()) as { tokens: Array<{ id: string; name: string; created_at: string }> };
  expect(body.tokens).toHaveLength(2);
  expect(body.tokens.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
  // No 'value' field on listed tokens
  expect(body.tokens.every((t) => !("value" in t))).toBe(true);
});

test("list tokens — only returns current user's tokens", async () => {
  const userA = await newUser("a@example.com");
  // Add userA to allowlist (since they're not first)
  const { pgRun } = await import("../src/pg.ts");
  await pgRun(`INSERT INTO zugzug_app.allowed_emails (email, added_by, added_at) VALUES ('b@example.com', 'bootstrap', current_timestamp) ON CONFLICT DO NOTHING`);
  const userB = await newUser("b@example.com");

  await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a-token" }),
    }),
    userA,
  );
  await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "b-token" }),
    }),
    userB,
  );

  const aTokens = (await (await handleListTokens(userA)).json()) as { tokens: Array<{ name: string }> };
  const bTokens = (await (await handleListTokens(userB)).json()) as { tokens: Array<{ name: string }> };
  expect(aTokens.tokens.map((t) => t.name)).toEqual(["a-token"]);
  expect(bTokens.tokens.map((t) => t.name)).toEqual(["b-token"]);
});

test("revoke token — token no longer appears in list", async () => {
  const userId = await newUser();
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "revoke-me" }),
    }),
    userId,
  );
  const body = (await res.json()) as { id: string };

  await handleRevokeToken(body.id, userId);

  const listed = (await (await handleListTokens(userId)).json()) as { tokens: Array<unknown> };
  expect(listed.tokens).toHaveLength(0);
});

test("bearer auth — valid token returns user", async () => {
  const userId = await newUser("bearer@example.com");
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bearer-test" }),
    }),
    userId,
  );
  const { value } = (await res.json()) as { value: string };

  const req = new Request("http://localhost/api/anywhere", {
    headers: { Authorization: `Bearer ${value}` },
  });
  const user = await getApiTokenUser(req);
  expect(user?.id).toBe(userId);
  expect(user?.email).toBe("bearer@example.com");
});

test("bearer auth — revoked token returns null", async () => {
  const userId = await newUser();
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "revoked-bearer" }),
    }),
    userId,
  );
  const { id, value } = (await res.json()) as { id: string; value: string };
  await handleRevokeToken(id, userId);

  const req = new Request("http://localhost/api/anywhere", {
    headers: { Authorization: `Bearer ${value}` },
  });
  expect(await getApiTokenUser(req)).toBeNull();
});

test("bearer auth — missing/invalid prefix returns null", async () => {
  const req1 = new Request("http://localhost/api/anywhere");
  expect(await getApiTokenUser(req1)).toBeNull();

  const req2 = new Request("http://localhost/api/anywhere", {
    headers: { Authorization: "Bearer xx_not_a_zugzug_token" },
  });
  expect(await getApiTokenUser(req2)).toBeNull();

  const req3 = new Request("http://localhost/api/anywhere", {
    headers: { Authorization: "Basic dXNlcjpwYXNz" },
  });
  expect(await getApiTokenUser(req3)).toBeNull();
});

test("bearer auth — updates last_used_at", async () => {
  const userId = await newUser();
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "last-used-test" }),
    }),
    userId,
  );
  const { id, value } = (await res.json()) as { id: string; value: string };

  const before = await pgGet<{ last_used_at: string | null }>(
    `SELECT last_used_at::text AS last_used_at FROM zugzug_app.api_tokens WHERE id = $1`,
    [id],
  );
  expect(before?.last_used_at).toBeNull();

  await getApiTokenUser(
    new Request("http://localhost/api/anywhere", { headers: { Authorization: `Bearer ${value}` } }),
  );

  // Fire-and-forget update is async; wait a tick.
  await new Promise((r) => setTimeout(r, 50));

  const after = await pgGet<{ last_used_at: string | null }>(
    `SELECT last_used_at::text AS last_used_at FROM zugzug_app.api_tokens WHERE id = $1`,
    [id],
  );
  expect(after?.last_used_at).not.toBeNull();
});
```

***REMOVED******REMOVED******REMOVED*** Step 4 — Run tests, verify pass

```bash
cd server && bun run test test/auth-api-tokens.test.ts
```
Expected: all tests pass.

***REMOVED******REMOVED******REMOVED*** Step 5 — Typecheck + lint + format + full server tests

```bash
cd server && bun run typecheck && bun run lint && bun run format:check && bun run test
```
Expected: clean + all pass.

***REMOVED******REMOVED******REMOVED*** Step 6 — Commit

```bash
git add server/src/auth-api-tokens.ts server/src/server.ts server/test/auth-api-tokens.test.ts
git commit -m "feat(auth): API tokens — argon2id-hashed bearer tokens + endpoints"
```

---

***REMOVED******REMOVED*** Task 8: Bearer-token fallback in server.ts session gate

**Files:**
- Modify: `server/src/server.ts`
- Create: `server/test/auth-bearer-integration.test.ts`

***REMOVED******REMOVED******REMOVED*** Step 1 — Update session gate

In `/Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts`, find the session gate (around line 129-137):

```ts
// Session gate — all other /api/* routes require a valid session
let sessionUser;
try {
  sessionUser = await getSessionUser(req);
} catch (e) {
  return err(e, 503);
}
if (!sessionUser) return json({ error: "Unauthorized" }, 401);
const me = sessionUser.id;
setUid(me);
```

Replace with:

```ts
// Session gate — all other /api/* routes require a valid session OR a valid
// bearer token (API token). Cookie session wins when both are present.
let sessionUser;
try {
  sessionUser = await getSessionUser(req);
  if (!sessionUser) {
    const { getApiTokenUser } = await import("./auth-api-tokens.ts");
    sessionUser = await getApiTokenUser(req);
  }
} catch (e) {
  return err(e, 503);
}
if (!sessionUser) return json({ error: "Unauthorized" }, 401);
const me = sessionUser.id;
setUid(me);
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Write integration test

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/test/auth-bearer-integration.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.DEV_BYPASS_AUTH = "true";
delete process.env.OIDC_ISSUER_URL;
process.env.ALLOWED_DOMAIN = "";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { handleSignup } from "../src/auth-password.ts";
import { handleCreateToken } from "../src/auth-api-tokens.ts";

beforeEach(async () => {
  await resetDb();
});

async function signupAndToken(): Promise<{ userId: string; token: string }> {
  const signup = await handleSignup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "bearer-int@example.com",
        password: "longenoughpw12",
        name: "Bearer User",
      }),
    }),
  );
  const { id: userId } = (await signup.json()) as { id: string };
  const tok = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "int-test" }),
    }),
    userId,
  );
  const { value } = (await tok.json()) as { value: string };
  return { userId, token: value };
}

test("integration — bearer token authenticates against /api/users", async () => {
  const { token } = await signupAndToken();

  // Hit a known authenticated route. /api/users requires session/bearer.
  // We test via the live server (assumes server is running on 8787, same pattern
  // as snapshot-endpoint.test.ts uses).
  const res = await fetch("http://localhost:8787/api/users", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
});

test("integration — bearer token rejected after revocation", async () => {
  const { userId, token } = await signupAndToken();
  // Issue revocation against the token's id
  const list = (await (await fetch("http://localhost:8787/api/tokens", {
    headers: { Authorization: `Bearer ${token}` },
  })).json()) as { tokens: Array<{ id: string }> };
  const tokenId = list.tokens[0].id;
  await fetch(`http://localhost:8787/api/tokens/${tokenId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  // Subsequent request should be unauthorized
  const res = await fetch("http://localhost:8787/api/users", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(401);
  void userId;
});
```

**Note:** these tests hit a live server on `:8787`. If your test harness doesn't run a server, you'll need to skip or adapt them. The unit tests in Task 7 cover all the business logic; these integration tests just verify the server-level wiring. If running the server in-test is fragile, mark these `test.skip` for now and verify manually in Task 15.

***REMOVED******REMOVED******REMOVED*** Step 3 — Run, verify pass (or skip if server not running)

```bash
cd server && bun run test test/auth-bearer-integration.test.ts
```
Expected: tests pass (or are skipped with a note).

***REMOVED******REMOVED******REMOVED*** Step 4 — Typecheck + lint + format + full server tests

```bash
cd server && bun run typecheck && bun run lint && bun run format:check && bun run test
```
Expected: clean.

***REMOVED******REMOVED******REMOVED*** Step 5 — Commit

```bash
git add server/src/server.ts server/test/auth-bearer-integration.test.ts
git commit -m "feat(auth): bearer-token fallback in session gate"
```

---

***REMOVED******REMOVED*** Task 9: `auth.ts` rewrite — thin coordinator (OPUS)

**Files:**
- Modify: `server/src/auth.ts` (major rewrite — remove Google OAuth handlers, keep shared helpers)
- Modify: `server/src/server.ts` (clean up route block)

***REMOVED******REMOVED******REMOVED*** Step 1 — Inventory what stays / goes / moves

Read `/Users/fhagelund/Documents/GitHub/zugzug/server/src/auth.ts` to confirm structure. Plan:

**Stays in auth.ts (shared infrastructure):**
- `SessionUser` interface
- Cookie helpers: `parseCookies`, `cookie`, `clearCookie`
- `SID` constant, `SESSION_SECONDS` constant
- `isSecure()` derivation
- `getSessionUser(req)` — used by server.ts session gate
- `issueSession(userId)` — added in Task 5; used by both password and OIDC handlers
- `handleAuthConfig()` — added in Task 4
- `handleLogout(req)` — generic; works for both modes
- `handleMe(req)` — generic; works for both modes
- `handleDevLogin()` — dev-bypass; works for both modes
- The `cors` constant (used in handleMe / handleAuthConfig response headers)

**Removes from auth.ts:**
- `GOOGLE_JWKS` constant (no more JWKS verification — openid-client handles it)
- `STATE` cookie constant (the OIDC `STATE_COOKIE` lives in auth-oidc.ts now)
- `loginError` helper (only used by Google callback; equivalent now in auth-oidc.ts)
- `handleGoogleRedirect` function
- `handleGoogleCallback` function
- `import { createRemoteJWKSet, jwtVerify } from "jose"` — no longer needed
- The `email.split("@")[1] !== env.allowedDomain` check (moves into password/oidc handlers)
- The `allowed_emails` allowlist logic (moves into password/oidc handlers)
- The user-upsert logic (moves into password/oidc handlers)
- The session-creation logic (already moved to `issueSession` in Task 5)

***REMOVED******REMOVED******REMOVED*** Step 2 — Rewrite auth.ts

REPLACE the ENTIRE contents of `/Users/fhagelund/Documents/GitHub/zugzug/server/src/auth.ts` with:

```ts
/* auth.ts — Shared auth infrastructure.

   This file holds:
     - SessionUser type
     - Cookie helpers (parse, build, clear)
     - getSessionUser middleware (used by every authenticated route)
     - issueSession helper (used by password + OIDC handlers)
     - handleAuthConfig (returns mode + allowedDomain + oidcLabel for the Login page)
     - handleLogout / handleMe — generic, mode-agnostic
     - handleDevLogin — dev-only bypass for local testing

   Mode-specific handlers live in:
     - auth-password.ts — local email + password (signup, login, change-password)
     - auth-oidc.ts     — generic OIDC via openid-client v6 (start, callback)
     - auth-api-tokens.ts — personal access tokens (list, create, revoke, bearer middleware)
*/

import { env, pg } from "./env.ts";
import { pgRun as run, pgGet as get } from "./pg.ts";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  initials: string;
}

const SID = "zz_sid";
const SESSION_SECONDS = 30 * 86_400;
const isSecure = env.origin.startsWith("https://");

const cors = {
  "access-control-allow-origin": env.origin,
  "access-control-allow-credentials": "true",
  vary: "Origin",
};

// ---- cookie helpers --------------------------------------------------------

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string): string {
  const base = `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
  return isSecure ? `${base}; Secure` : base;
}

// ---- session ---------------------------------------------------------------

/** Read the zz_sid cookie and return the associated user, or null. */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const sid = cookies[SID];
  if (!sid) return null;
  const session = await get<{ user_id: string; expires_at: string }>(
    `SELECT user_id, expires_at FROM ${pg("sessions")} WHERE id = $1`,
    [sid],
  );
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await run(`DELETE FROM ${pg("sessions")} WHERE id = $1`, [sid]);
    return null;
  }
  return get<SessionUser>(`SELECT id, name, email, initials FROM ${pg("users")} WHERE id = $1`, [
    session.user_id,
  ]);
}

/** Create a session row for the user and return the matching Set-Cookie header.
 *  Used by both password (signup, login) and OIDC (callback) handlers. */
export async function issueSession(userId: string): Promise<{ sessionId: string; cookie: string }> {
  const sessionId =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
  await run(`INSERT INTO ${pg("sessions")} (id, user_id, expires_at) VALUES ($1, $2, $3)`, [
    sessionId,
    userId,
    expiresAt.toISOString(),
  ]);
  return { sessionId, cookie: cookie(SID, sessionId, SESSION_SECONDS) };
}

// ---- generic route handlers (mode-agnostic) --------------------------------

/** GET /api/auth/config — public config for the Login page (mode, allowedDomain, oidcLabel). */
export function handleAuthConfig(): Response {
  const body: {
    mode: "password" | "oidc";
    signupOpen: boolean;
    allowedDomain: string | null;
    oidcLabel?: string;
  } = {
    mode: env.authMode,
    signupOpen: false, // Reserved for v1.1 OPEN_SIGNUP=true env flag.
    allowedDomain: env.allowedDomain || null,
  };
  if (env.authMode === "oidc" && env.oidcLabel) {
    body.oidcLabel = env.oidcLabel;
  }
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...cors },
  });
}

/** POST /api/auth/logout — delete session + clear cookie. */
export async function handleLogout(req: Request): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const sid = cookies[SID];
  if (sid) await run(`DELETE FROM ${pg("sessions")} WHERE id = $1`, [sid]);
  const headers = new Headers({ Location: "/login" });
  headers.append("Set-Cookie", clearCookie(SID));
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/me — return session user or 401. Used by BootGate. */
export async function handleMe(req: Request): Promise<Response> {
  const user = await getSessionUser(req);
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", ...cors },
    });
  return new Response(JSON.stringify(user), {
    status: 200,
    headers: { "content-type": "application/json", ...cors },
  });
}

/** GET /api/auth/dev — one-click dev login; only works when devBypassAuth is true. */
export async function handleDevLogin(): Promise<Response> {
  const userId = "u_dev";
  await run(
    `INSERT INTO ${pg("users")} (id, name, email, initials, auth_provider)
     VALUES ($1, 'Dev User', 'dev@localhost', 'DV', 'password')
     ON CONFLICT (id) DO NOTHING`,
    [userId],
  );
  const { cookie: setCookie } = await issueSession(userId);
  const headers = new Headers({ Location: "/app" });
  headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}
```

***REMOVED******REMOVED******REMOVED*** Step 3 — Clean up server.ts route block

In `/Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts`, find the imports at the top:

```ts
import {
  getSessionUser,
  handleGoogleRedirect,
  handleGoogleCallback,
  handleAuthConfig,
  handleLogout,
  handleMe,
  handleDevLogin,
} from "./auth.ts";
```

Replace with:

```ts
import {
  getSessionUser,
  handleAuthConfig,
  handleLogout,
  handleMe,
  handleDevLogin,
} from "./auth.ts";
```

(Drop `handleGoogleRedirect` and `handleGoogleCallback`.)

Then find the auth route block (around line 115) and rewrite it cleanly. REPLACE:

```ts
// Auth routes — no session required
if (seg[1] === "auth") {
  if (seg[2] === "google" && method === "GET") return handleGoogleRedirect(req);
  if (seg[2] === "callback" && method === "GET") return handleGoogleCallback(req);
  if (seg[2] === "me" && method === "GET") return handleMe(req);
  if (seg[2] === "logout" && method === "POST") return handleLogout(req);
  if (seg[2] === "config" && method === "GET") return handleAuthConfig();
  if (seg[2] === "dev" && method === "GET") {
    if (!env.devBypassAuth) return json({ error: "not found" }, 404);
    return handleDevLogin();
  }
  return json({ error: "not found" }, 404);
}
```

with the full new block including all the routes added in Tasks 5, 6, 7:

```ts
// Auth routes — no session required for signup/login/logout/config/oidc/dev
if (seg[1] === "auth") {
  if (seg[2] === "me" && method === "GET") return handleMe(req);
  if (seg[2] === "logout" && method === "POST") return handleLogout(req);
  if (seg[2] === "config" && method === "GET") return handleAuthConfig();

  // Password mode (only meaningful when env.authMode === "password")
  if (seg[2] === "signup" && method === "POST") {
    const { handleSignup } = await import("./auth-password.ts");
    return handleSignup(req);
  }
  if (seg[2] === "login" && method === "POST") {
    const { handleLogin } = await import("./auth-password.ts");
    return handleLogin(req);
  }

  // OIDC mode (only meaningful when env.authMode === "oidc")
  if (seg[2] === "oidc" && seg[3] === "start" && method === "GET") {
    const { handleOidcStart } = await import("./auth-oidc.ts");
    return handleOidcStart(req);
  }
  if (seg[2] === "oidc" && seg[3] === "callback" && method === "GET") {
    const { handleOidcCallback } = await import("./auth-oidc.ts");
    return handleOidcCallback(req);
  }

  // Dev bypass — local testing only
  if (seg[2] === "dev" && method === "GET") {
    if (!env.devBypassAuth) return json({ error: "not found" }, 404);
    return handleDevLogin();
  }

  return json({ error: "not found" }, 404);
}
```

The `change-password` route (authenticated) and `/api/tokens` routes (authenticated) stay in the post-session-gate block (added in Tasks 5 and 7 respectively).

Remove any leftover references to `handleGoogleRedirect`/`handleGoogleCallback` in this file.

***REMOVED******REMOVED******REMOVED*** Step 4 — Verify all tests still pass

```bash
cd server && bun run test
```

Expected: ALL existing tests pass. The Google-specific route lookups (`/api/auth/google`, `/api/auth/callback`) now 404, but no existing test relied on them. If any test does, it needs updating — the Google handlers are gone.

***REMOVED******REMOVED******REMOVED*** Step 5 — Typecheck + lint + format

```bash
cd server && bun run typecheck && bun run lint && bun run format:check
```
Expected: clean.

***REMOVED******REMOVED******REMOVED*** Step 6 — Grep gate — Google-specific handlers gone

```bash
grep -rn "handleGoogleRedirect\|handleGoogleCallback\|GOOGLE_JWKS\|createRemoteJWKSet" /Users/fhagelund/Documents/GitHub/zugzug/server/src/
```
Expected: zero matches.

***REMOVED******REMOVED******REMOVED*** Step 7 — Commit

```bash
git add server/src/auth.ts server/src/server.ts
git commit -m "refactor(auth): remove Google-OAuth-specific code; auth.ts is thin coordinator"
```

---

***REMOVED******REMOVED*** Task 10: Frontend — `useAuthConfig` hook + deprecate `WorkspaceInfo.allowedDomain`

**Files:**
- Modify: `app/src/store.ts`
- Modify: `server/src/server.ts` (remove `allowedDomain` from `/api/workspace/info`)
- Modify: `server/test/workspace-info.test.ts`
- Create: `app/test/auth-config.test.ts`

PR 1 temporarily exposed `allowedDomain` on `/api/workspace/info`. Now move it to its proper home — `/api/auth/config` — and remove from `WorkspaceInfo`.

***REMOVED******REMOVED******REMOVED*** Step 1 — Add `useAuthConfig` hook in store.ts

In `/Users/fhagelund/Documents/GitHub/zugzug/app/src/store.ts`, alongside `useWorkspaceInfo`, add:

```ts
export interface AuthConfig {
  mode: "password" | "oidc";
  signupOpen: boolean;
  allowedDomain: string | null;
  oidcLabel?: string;
}

let _authConfigCache: AuthConfig | null = null;
let _authConfigPromise: Promise<AuthConfig | null> | null = null;

function isAuthConfig(x: unknown): x is AuthConfig {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o.mode !== "password" && o.mode !== "oidc") return false;
  if (typeof o.signupOpen !== "boolean") return false;
  if (o.allowedDomain !== null && typeof o.allowedDomain !== "string") return false;
  if (o.oidcLabel !== undefined && typeof o.oidcLabel !== "string") return false;
  return true;
}

export function useAuthConfig(): AuthConfig | null {
  const [cfg, setCfg] = useState<AuthConfig | null>(_authConfigCache);
  useEffect(() => {
    if (_authConfigCache) return;
    if (!_authConfigPromise) {
      _authConfigPromise = (async () => {
        const r = await fetch("/api/auth/config");
        if (!r.ok) return null;
        const data: unknown = await r.json().catch(() => null);
        if (!isAuthConfig(data)) return null;
        _authConfigCache = data;
        return data;
      })();
    }
    _authConfigPromise.then((data) => setCfg(data));
  }, []);
  return cfg;
}
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Remove `allowedDomain` from `WorkspaceInfo`

In `/Users/fhagelund/Documents/GitHub/zugzug/app/src/store.ts`, find the `WorkspaceInfo` interface and the `isWorkspaceInfo` validator. Remove the `allowedDomain` field:

```ts
export interface WorkspaceInfo {
  adapter: "duckdb" | "snowflake";
  writable: boolean;
  canonicalMode: "warehouse" | "postgres-export";
  warehouseDb: string | null;
  defaultEngineerMode: boolean;
  // allowedDomain removed — moved to AuthConfig
}

function isWorkspaceInfo(x: unknown): x is WorkspaceInfo {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    (o.adapter === "duckdb" || o.adapter === "snowflake") &&
    typeof o.writable === "boolean" &&
    (o.canonicalMode === "warehouse" || o.canonicalMode === "postgres-export") &&
    (o.warehouseDb === null || typeof o.warehouseDb === "string") &&
    typeof o.defaultEngineerMode === "boolean"
  );
}
```

***REMOVED******REMOVED******REMOVED*** Step 3 — Remove `allowedDomain` from server's `/api/workspace/info`

In `/Users/fhagelund/Documents/GitHub/zugzug/server/src/server.ts`, find the `/api/workspace/info` route handler and remove the `allowedDomain` field from the JSON response.

***REMOVED******REMOVED******REMOVED*** Step 4 — Update server test

Open `/Users/fhagelund/Documents/GitHub/zugzug/server/test/workspace-info.test.ts`. Remove the assertion line that checks `body.allowedDomain`. Remove the `allowedDomain` field from the type cast on the body.

***REMOVED******REMOVED******REMOVED*** Step 5 — Update Settings.tsx to use `useAuthConfig`

In `/Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx`:

a) Replace `useWorkspaceInfo` for the allowedDomain derivation. Add the import:

```ts
import { useAuthConfig } from "../store";
```

b) Find where `wsInfo?.allowedDomain` is used in `TeamSection` (added in PR 1 Task 11). Replace `useWorkspaceInfo()` for that purpose with `useAuthConfig()`:

```ts
function TeamSection() {
  const authConfig = useAuthConfig();
  const allowedDomain = authConfig?.allowedDomain ? "@" + authConfig.allowedDomain : null;
  // ... rest unchanged
}
```

Other uses of `useWorkspaceInfo` in Settings.tsx (the Canonical destination / Master records card) stay — they don't need `allowedDomain`.

***REMOVED******REMOVED******REMOVED*** Step 6 — Update any other consumers of `wsInfo.allowedDomain`

```bash
grep -rn "allowedDomain" /Users/fhagelund/Documents/GitHub/zugzug/app/src/
```

Wherever this appears via `wsInfo` / `useWorkspaceInfo`, replace with `useAuthConfig`. The Login.tsx rewrite in Task 11 will use `useAuthConfig` directly — no migration needed there.

***REMOVED******REMOVED******REMOVED*** Step 7 — Write hook test

Create `/Users/fhagelund/Documents/GitHub/zugzug/app/test/auth-config.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

describe("useAuthConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test("returns config after fetch", async () => {
    const cfg = {
      mode: "password" as const,
      signupOpen: false,
      allowedDomain: null,
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => cfg,
    })) as unknown as typeof fetch;

    const { useAuthConfig } = await import("../src/store");
    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => {
      expect(result.current).toEqual(cfg);
    });
  });

  test("returns null on invalid shape", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ mode: "saml" }), // not a valid mode
    })) as unknown as typeof fetch;

    const { useAuthConfig } = await import("../src/store");
    const { result } = renderHook(() => useAuthConfig());
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });
});
```

***REMOVED******REMOVED******REMOVED*** Step 8 — Run tests + typecheck + format

```bash
cd app && bun run test && bun run typecheck && bun run format:check
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test && bun run typecheck && bun run format:check
```
Expected: all pass.

***REMOVED******REMOVED******REMOVED*** Step 9 — Commit

```bash
git add app/src/store.ts app/src/routes/Settings.tsx app/test/auth-config.test.ts server/src/server.ts server/test/workspace-info.test.ts
git commit -m "feat(store): useAuthConfig hook; deprecate allowedDomain from WorkspaceInfo"
```

---

***REMOVED******REMOVED*** Task 11: `Login.tsx` rewrite — mode-aware

**Files:**
- Modify: `app/src/routes/Login.tsx`
- Create: `app/test/login-mode-aware.test.tsx`

***REMOVED******REMOVED******REMOVED*** Step 1 — Write failing tests

Create `/Users/fhagelund/Documents/GitHub/zugzug/app/test/login-mode-aware.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

describe("Login — mode-aware", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("password mode — renders email/password form + signup link", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useAuthConfig: () => ({
          mode: "password",
          signupOpen: false,
          allowedDomain: null,
        }),
      };
    });
    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
      expect(screen.getByText(/no account.*sign up/i)).toBeInTheDocument();
    });
  });

  test("oidc mode — renders SSO button", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useAuthConfig: () => ({
          mode: "oidc",
          signupOpen: false,
          allowedDomain: "example.com",
          oidcLabel: "Google",
        }),
      };
    });
    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/sign in with google/i)).toBeInTheDocument();
      expect(screen.getByText(/@example\.com/i)).toBeInTheDocument();
    });
  });

  test("loading state — auth config not yet fetched", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useAuthConfig: () => null,
      };
    });
    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    // Doesn't crash; renders sign-in heading even before config loads
    await waitFor(() => {
      expect(screen.getByText(/sign in/i)).toBeInTheDocument();
    });
  });
});
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Run, verify failure

```bash
cd app && bun run test test/login-mode-aware.test.tsx
```
Expected: tests FAIL — Login.tsx still hard-codes Google.

***REMOVED******REMOVED******REMOVED*** Step 3 — Rewrite Login.tsx

REPLACE the ENTIRE contents of `/Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Login.tsx` with:

```tsx
import { useState, useEffect, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Mark } from "../components/Mark";
import { useAuthConfig } from "../store";

const ERROR_MESSAGES: Record<string, string> = {
  domain: "Your email domain is not allowed on this instance. Contact your admin.",
  not_allowed: "Your account hasn't been added yet. Ask an existing user to add you in Settings.",
  token: "Authentication failed — please try again.",
  state: "Session expired — please try again.",
  no_code: "Login was cancelled.",
  no_email: "Your provider didn't return an email — please check your account settings.",
  invalid_credentials: "Invalid email or password.",
};

export function Login() {
  const error = new URLSearchParams(window.location.search).get("error");
  const authConfig = useAuthConfig();
  const [devBypass, setDevBypass] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch("/api/auth/dev", { method: "GET", redirect: "manual" })
      .then((r) => {
        const live = r.status === 0 || (r.status >= 300 && r.status < 400);
        setDevBypass(live);
      })
      .catch(() => {});
  }, []);

  return (
    <div
      className="grid min-h-screen place-items-center p-4 sm:p-8"
      style={{ background: "var(--bg)", color: "var(--ink)" }}
    >
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-8">
        <div className="flex items-center gap-2.5">
          <Mark className="h-7 w-7" />
          <span className="font-display text-lg font-extrabold tracking-tight">
            Zug Zug<span style={{ color: "var(--accent)" }}>.</span>
          </span>
        </div>

        <div>
          <h1 className="font-display text-2xl font-bold">Sign in</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
            Master data reconciliation.
          </p>
        </div>

        {error && (
          <p
            className="rounded-sm border px-3 py-2 text-[13px]"
            style={{
              borderColor: "var(--warn)",
              color: "var(--warn)",
              background: "color-mix(in srgb, var(--warn) 10%, transparent)",
            }}
          >
            {ERROR_MESSAGES[error] ?? "Something went wrong — please try again."}
          </p>
        )}

        {authConfig?.mode === "password" && <PasswordForm allowedDomain={authConfig.allowedDomain} />}
        {authConfig?.mode === "oidc" && (
          <OidcSection
            label={authConfig.oidcLabel ?? "SSO"}
            allowedDomain={authConfig.allowedDomain}
          />
        )}

        {devBypass && (
          <a
            href="/api/auth/dev"
            className="flex w-full items-center justify-center rounded-sm border border-dashed border-[var(--line-2)] px-4 py-2 text-[12px] text-[var(--ink-3)] transition-colors hover:border-[var(--accent)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Dev mode login
          </a>
        )}
      </div>
    </div>
  );
}

function PasswordForm({ allowedDomain }: { allowedDomain: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 200) {
        window.location.href = "/app";
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setFormError(ERROR_MESSAGES[body?.error ?? "invalid_credentials"] ?? "Login failed.");
    } catch {
      setFormError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <label className="block text-[12px]" style={{ color: "var(--ink-2)" }}>
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
      </label>
      <label className="block text-[12px]" style={{ color: "var(--ink-2)" }}>
        Password
        <input
          type="password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
      </label>
      {formError && (
        <p className="text-[12px]" style={{ color: "var(--warn)" }}>
          {formError}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="flex w-full items-center justify-center rounded-sm border border-[var(--line-2)] bg-[var(--accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-[12px]" style={{ color: "var(--ink-3)" }}>
        No account?{" "}
        <Link to="/signup" className="text-[var(--accent)] hover:underline">
          Sign up →
        </Link>
      </p>
      {allowedDomain && (
        <p className="text-center text-[11px]" style={{ color: "var(--ink-3)" }}>
          Only @{allowedDomain} accounts can sign up here.
        </p>
      )}
    </form>
  );
}

function OidcSection({ label, allowedDomain }: { label: string; allowedDomain: string | null }) {
  return (
    <div className="space-y-3">
      <a
        href="/api/auth/oidc/start"
        className="flex w-full items-center justify-center gap-2.5 rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-4 py-2.5 text-[13px] font-medium transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        Sign in with {label}
      </a>
      {allowedDomain && (
        <p className="text-center text-[11px]" style={{ color: "var(--ink-3)" }}>
          Only @{allowedDomain} accounts can sign in here.
        </p>
      )}
    </div>
  );
}
```

***REMOVED******REMOVED******REMOVED*** Step 4 — Run tests + typecheck + format

```bash
cd app && bun run test test/login-mode-aware.test.tsx
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck && bun run format:check
```
Expected: tests pass; clean.

***REMOVED******REMOVED******REMOVED*** Step 5 — Commit

```bash
git add app/src/routes/Login.tsx app/test/login-mode-aware.test.tsx
git commit -m "feat(login): mode-aware UI — password form OR SSO button"
```

---

***REMOVED******REMOVED*** Task 12: `Signup.tsx` + route + tests

**Files:**
- Create: `app/src/routes/Signup.tsx`
- Modify: `app/src/main.tsx` (register the `/signup` route)
- Create: `app/test/signup.test.tsx`

***REMOVED******REMOVED******REMOVED*** Step 1 — Write failing tests

Create `/Users/fhagelund/Documents/GitHub/zugzug/app/test/signup.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

describe("Signup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("submits signup payload and redirects on success", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({ id: "u_1" }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    Object.defineProperty(window, "location", {
      value: { href: "" },
      writable: true,
    });

    const { Signup } = await import("../src/routes/Signup");
    render(
      <MemoryRouter>
        <Signup />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Test User" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "longenoughpw12" } });
    fireEvent.click(screen.getByRole("button", { name: /sign up/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/signup",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Test User",
            email: "test@example.com",
            password: "longenoughpw12",
          }),
        }),
      );
    });
  });

  test("shows error for weak password", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 400,
      json: async () => ({ error: "password_too_short", minLength: 12 }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { Signup } = await import("../src/routes/Signup");
    render(
      <MemoryRouter>
        <Signup />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /sign up/i }));

    await waitFor(() => {
      expect(screen.getByText(/at least 12/i)).toBeInTheDocument();
    });
  });

  test("shows error for not_allowed (allowlist failure)", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 403,
      json: async () => ({ error: "not_allowed" }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { Signup } = await import("../src/routes/Signup");
    render(
      <MemoryRouter>
        <Signup />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "longenoughpw12" } });
    fireEvent.click(screen.getByRole("button", { name: /sign up/i }));

    await waitFor(() => {
      expect(screen.getByText(/not been added/i)).toBeInTheDocument();
    });
  });
});
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Run, verify failure

```bash
cd app && bun run test test/signup.test.tsx
```
Expected: module not found.

***REMOVED******REMOVED******REMOVED*** Step 3 — Create Signup.tsx

Create `/Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Signup.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Mark } from "../components/Mark";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: "That doesn't look like an email address.",
  password_too_short: "Password must be at least 12 characters.",
  name_required: "Please enter your name.",
  domain_not_allowed: "Your email domain isn't allowed on this instance.",
  not_allowed:
    "Your email hasn't been added to the allowlist yet. Ask an existing user to invite you in Settings → Team.",
  email_taken: "An account with this email already exists. Try signing in instead.",
};

export function Signup() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (res.status === 200) {
        window.location.href = "/app";
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { error?: string; minLength?: number }
        | null;
      const msg = ERROR_MESSAGES[body?.error ?? ""] ?? "Sign up failed — please try again.";
      setFormError(msg);
    } catch {
      setFormError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="grid min-h-screen place-items-center p-4 sm:p-8"
      style={{ background: "var(--bg)", color: "var(--ink)" }}
    >
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-8">
        <div className="flex items-center gap-2.5">
          <Mark className="h-7 w-7" />
          <span className="font-display text-lg font-extrabold tracking-tight">
            Zug Zug<span style={{ color: "var(--accent)" }}>.</span>
          </span>
        </div>

        <div>
          <h1 className="font-display text-2xl font-bold">Sign up</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
            Create your account.
          </p>
        </div>

        <form className="space-y-3" onSubmit={onSubmit}>
          <label className="block text-[12px]" style={{ color: "var(--ink-2)" }}>
            Name
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-full rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
          <label className="block text-[12px]" style={{ color: "var(--ink-2)" }}>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
          <label className="block text-[12px]" style={{ color: "var(--ink-2)" }}>
            Password (at least 12 characters)
            <input
              type="password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
          {formError && (
            <p className="text-[12px]" style={{ color: "var(--warn)" }}>
              {formError}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center rounded-sm border border-[var(--line-2)] bg-[var(--accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Creating account…" : "Sign up"}
          </button>
          <p className="text-center text-[12px]" style={{ color: "var(--ink-3)" }}>
            Have an account?{" "}
            <Link to="/login" className="text-[var(--accent)] hover:underline">
              Sign in →
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
```

***REMOVED******REMOVED******REMOVED*** Step 4 — Register route in main.tsx

Open `/Users/fhagelund/Documents/GitHub/zugzug/app/src/main.tsx` and find where `/login` is registered. Add the corresponding `/signup` route — same level, same shape. Example pattern depends on existing router config; if using React Router's `<Route>` children, add:

```tsx
<Route path="/signup" element={<Signup />} />
```

with import:
```ts
import { Signup } from "./routes/Signup";
```

***REMOVED******REMOVED******REMOVED*** Step 5 — Run tests + typecheck + format

```bash
cd app && bun run test && bun run typecheck && bun run format:check
```
Expected: all pass.

***REMOVED******REMOVED******REMOVED*** Step 6 — Commit

```bash
git add app/src/routes/Signup.tsx app/src/main.tsx app/test/signup.test.tsx
git commit -m "feat(signup): /signup route with email + password + name form"
```

---

***REMOVED******REMOVED*** Task 13: Settings — "API tokens" Section + tests

**Files:**
- Modify: `app/src/routes/Settings.tsx`
- Modify: `app/src/store.ts` (add API token actions: `listApiTokens`, `createApiToken`, `revokeApiToken`)
- Create: `app/test/api-tokens-settings.test.tsx`

***REMOVED******REMOVED******REMOVED*** Step 1 — Add API token actions to store.ts

In `/Users/fhagelund/Documents/GitHub/zugzug/app/src/store.ts`, add:

```ts
export interface ApiToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface CreatedApiToken extends ApiToken {
  value: string; // shown once at creation
}

export async function listApiTokens(): Promise<ApiToken[]> {
  const r = await fetch("/api/tokens");
  if (!r.ok) throw new Error(`list_tokens_${r.status}`);
  const body = (await r.json()) as { tokens: ApiToken[] };
  return body.tokens;
}

export async function createApiToken(name: string): Promise<CreatedApiToken> {
  const r = await fetch("/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`create_token_${r.status}`);
  return (await r.json()) as CreatedApiToken;
}

export async function revokeApiToken(id: string): Promise<void> {
  const r = await fetch(`/api/tokens/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`revoke_token_${r.status}`);
}
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Write failing tests

Create `/Users/fhagelund/Documents/GitHub/zugzug/app/test/api-tokens-settings.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

describe("Settings — API tokens section", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("lists tokens", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        listApiTokens: vi.fn(async () => [
          { id: "tok_1", name: "dbt-prod", created_at: "2026-01-01", last_used_at: "2026-06-01" },
          { id: "tok_2", name: "local-debug", created_at: "2026-02-01", last_used_at: null },
        ]),
      };
    });
    const { ApiTokensSection } = await import("../src/routes/Settings");
    render(<ApiTokensSection />);
    await waitFor(() => {
      expect(screen.getByText("dbt-prod")).toBeInTheDocument();
      expect(screen.getByText("local-debug")).toBeInTheDocument();
    });
  });

  test("create token — shows value once with copy button", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        listApiTokens: vi.fn(async () => []),
        createApiToken: vi.fn(async (name: string) => ({
          id: "tok_new",
          name,
          created_at: "2026-06-09",
          last_used_at: null,
          value: "zz_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })),
      };
    });
    const { ApiTokensSection } = await import("../src/routes/Settings");
    render(<ApiTokensSection />);

    fireEvent.click(screen.getByRole("button", { name: /create token/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "test-token" } });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(screen.getByText(/zz_AAAAAAAA/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    });
  });

  test("revoke token — removes from list", async () => {
    const tokens = [
      { id: "tok_1", name: "to-revoke", created_at: "2026-01-01", last_used_at: null },
    ];
    const revoke = vi.fn(async () => undefined);
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        listApiTokens: vi.fn(async () => tokens),
        revokeApiToken: revoke,
      };
    });
    const { ApiTokensSection } = await import("../src/routes/Settings");
    render(<ApiTokensSection />);

    await waitFor(() => {
      expect(screen.getByText("to-revoke")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() => {
      expect(revoke).toHaveBeenCalledWith("tok_1");
    });
  });
});
```

***REMOVED******REMOVED******REMOVED*** Step 3 — Run, verify failure

```bash
cd app && bun run test test/api-tokens-settings.test.tsx
```
Expected: import fails — `ApiTokensSection` doesn't exist.

***REMOVED******REMOVED******REMOVED*** Step 4 — Add `ApiTokensSection` to Settings.tsx

In `/Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx`:

a) Add imports near the existing import block:

```ts
import { listApiTokens, createApiToken, revokeApiToken, type ApiToken, type CreatedApiToken } from "../store";
```

b) Add the component (export it for testability — Section components in Settings.tsx aren't typically exported, but for the test to import directly, export this one):

```tsx
export function ApiTokensSection() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenValue, setNewTokenValue] = useState<CreatedApiToken | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTokens(await listApiTokens());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTokenName.trim()) return;
    try {
      const created = await createApiToken(newTokenName.trim());
      setNewTokenValue(created);
      setNewTokenName("");
      setCreating(false);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create token");
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeApiToken(id);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke token");
    }
  };

  return (
    <Section
      title="API tokens"
      hint="For headless access (dbt CI, scripts, …). Each token authenticates as you."
    >
      {error && (
        <div className="rounded-sm border border-danger/40 bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      {newTokenValue && (
        <div className="rounded-sm border border-warn/40 bg-warn-soft px-4 py-3">
          <p className="font-mono text-[12px] text-warn">
            Copy this token now — you won't see it again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded-sm border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink">
              {newTokenValue.value}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(newTokenValue.value);
              }}
            >
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNewTokenValue(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {loading && <p className="font-mono text-[11px] text-ink-3">Loading tokens…</p>}

      {!loading && tokens.length === 0 && !creating && (
        <p className="text-[12.5px] text-ink-2">No API tokens yet.</p>
      )}

      {!loading && tokens.length > 0 && (
        <div className="space-y-2">
          {tokens.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-sm border border-line bg-surface-2 px-3 py-2"
            >
              <div className="font-mono text-[12px]">
                <div className="text-ink">{t.name}</div>
                <div className="text-ink-3 text-[10.5px]">
                  created {t.created_at.split("T")[0]}
                  {t.last_used_at ? ` · last used ${t.last_used_at.split("T")[0]}` : " · never used"}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void handleRevoke(t.id)}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}

      {creating ? (
        <form className="space-y-2 rounded-sm border border-line bg-surface-2 px-3 py-3" onSubmit={handleCreate}>
          <label className="block text-[12px] text-ink-2">
            Name
            <input
              type="text"
              required
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              placeholder="dbt-prod"
              className="mt-1 block w-full rounded-sm border border-line-2 bg-surface px-2 py-1.5 font-mono text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" type="submit">
              Generate
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
          + Create token
        </Button>
      )}
    </Section>
  );
}
```

c) Add the section render between the existing "Connections" and "Matching defaults" sections in the main `Settings()` component render:

```tsx
<div className="zz-rise" style={{ animationDelay: "160ms" }}>
  <ApiTokensSection />
</div>
```

(adjust the animation delay to fit the existing sequence.)

***REMOVED******REMOVED******REMOVED*** Step 5 — Run tests + typecheck + format

```bash
cd app && bun run test && bun run typecheck && bun run format:check
```
Expected: all pass.

***REMOVED******REMOVED******REMOVED*** Step 6 — Commit

```bash
git add app/src/routes/Settings.tsx app/src/store.ts app/test/api-tokens-settings.test.tsx
git commit -m "feat(settings): API tokens section — list, create, revoke"
```

---

***REMOVED******REMOVED*** Task 14: `scripts/reset-password.ts` — admin CLI

**Files:**
- Create: `server/scripts/reset-password.ts`
- Modify: `server/package.json` (add `reset-password` script)
- Create: `server/test/reset-password.test.ts`

A small CLI for admins to reset a user's password without going through the UI flow (no email-reset infrastructure in v1).

***REMOVED******REMOVED******REMOVED*** Step 1 — Create the CLI script

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/scripts/reset-password.ts`:

```ts
/* reset-password.ts — Admin CLI to rewrite a user's password hash directly.
   Use this when a user has lost their password and you don't have an email
   reset flow (it's deferred to v1.1).

   Usage:
     bun run reset-password <email> <newpassword>

   Constraints:
     - Email must already exist in the users table
     - User must have auth_provider='password' (OIDC users authenticate via SSO)
     - Password must be at least 12 characters

   Exit codes: 0=success, 1=usage error, 2=user not found, 3=oidc user, 4=password too short. */

import { pgGet, pgRun } from "../src/pg.ts";
import { pg } from "../src/env.ts";

const MIN_PASSWORD_LENGTH = 12;

async function main(args: string[]): Promise<number> {
  if (args.length !== 2) {
    console.error("usage: bun run reset-password <email> <newpassword>");
    return 1;
  }
  const [email, password] = args;

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`error: password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    return 4;
  }

  const user = await pgGet<{ id: string; auth_provider: string }>(
    `SELECT id, auth_provider FROM ${pg("users")} WHERE lower(email) = lower($1)`,
    [email],
  );
  if (!user) {
    console.error(`error: no user with email ${email}`);
    return 2;
  }
  if (user.auth_provider !== "password") {
    console.error(
      `error: user has auth_provider='${user.auth_provider}' — they sign in via SSO, not password`,
    );
    return 3;
  }

  const hash = await Bun.password.hash(password);
  await pgRun(`UPDATE ${pg("users")} SET password_hash = $1 WHERE id = $2`, [hash, user.id]);
  console.log(`✓ password reset for ${email} (user id: ${user.id})`);
  return 0;
}

const code = await main(Bun.argv.slice(2));
process.exit(code);
```

***REMOVED******REMOVED******REMOVED*** Step 2 — Add the npm script

Open `/Users/fhagelund/Documents/GitHub/zugzug/server/package.json` and add (alongside existing scripts):

```json
"reset-password": "bun run scripts/reset-password.ts"
```

***REMOVED******REMOVED******REMOVED*** Step 3 — Write a small test

Create `/Users/fhagelund/Documents/GitHub/zugzug/server/test/reset-password.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
delete process.env.OIDC_ISSUER_URL;

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { handleSignup, handleLogin } from "../src/auth-password.ts";
import { pgRun, pgGet } from "../src/pg.ts";

beforeEach(async () => {
  await resetDb();
});

test("reset-password CLI rewrites hash so new password works", async () => {
  // Set up a user
  await handleSignup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "reset@example.com",
        password: "originalpw1234",
        name: "Reset User",
      }),
    }),
  );

  // Simulate the CLI by running the same logic the script does
  const user = await pgGet<{ id: string; auth_provider: string }>(
    `SELECT id, auth_provider FROM zugzug_app.users WHERE lower(email) = lower($1)`,
    ["reset@example.com"],
  );
  expect(user?.auth_provider).toBe("password");

  const newHash = await Bun.password.hash("newpassword1234");
  await pgRun(`UPDATE zugzug_app.users SET password_hash = $1 WHERE id = $2`, [newHash, user!.id]);

  // Old password should fail, new one should work
  const oldRes = await handleLogin(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reset@example.com", password: "originalpw1234" }),
    }),
  );
  expect(oldRes.status).toBe(401);

  const newRes = await handleLogin(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reset@example.com", password: "newpassword1234" }),
    }),
  );
  expect(newRes.status).toBe(200);
});
```

(This tests the LOGIC the CLI performs, not the CLI process invocation itself. The CLI script is thin — its logic is "look up user, hash new password, UPDATE." The test verifies that flow end-to-end.)

***REMOVED******REMOVED******REMOVED*** Step 4 — Run tests + typecheck + format

```bash
cd server && bun run test && bun run typecheck && bun run format:check
```
Expected: all pass.

***REMOVED******REMOVED******REMOVED*** Step 5 — Commit

```bash
git add server/scripts/reset-password.ts server/package.json server/test/reset-password.test.ts
git commit -m "feat(scripts): admin CLI for password reset (no email flow in v1)"
```

---

***REMOVED******REMOVED*** Task 15: Verification gates

**Files:** none modified — checks only.

***REMOVED******REMOVED******REMOVED*** Step 1 — Grep: Google-specific code is gone

```bash
grep -rn "handleGoogleRedirect\|handleGoogleCallback\|GOOGLE_JWKS\|createRemoteJWKSet" /Users/fhagelund/Documents/GitHub/zugzug/server/src/ 2>&1
```
Expected: zero matches.

***REMOVED******REMOVED******REMOVED*** Step 2 — Grep: `WorkspaceInfo.allowedDomain` is gone

```bash
grep -rn "wsInfo.*allowedDomain\|WorkspaceInfo.*allowedDomain" /Users/fhagelund/Documents/GitHub/zugzug/app/src/ 2>&1
```
Expected: zero matches. All `allowedDomain` reads on the frontend should now come from `useAuthConfig()`.

***REMOVED******REMOVED******REMOVED*** Step 3 — Server typecheck + lint + format

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck && bun run lint && bun run format:check
```
Expected: clean.

***REMOVED******REMOVED******REMOVED*** Step 4 — Server tests

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test
```
Expected: ~110+ tests (previously 81; +10ish new auth-password, +5ish auth-oidc, +8ish auth-api-tokens, +2 bearer-integration, +3 auth-config, +1 reset-password).

***REMOVED******REMOVED******REMOVED*** Step 5 — App typecheck + format

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck && bun run format:check
```
Expected: clean.

***REMOVED******REMOVED******REMOVED*** Step 6 — App tests

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test
```
Expected: ~125+ tests (previously 115; +3 login-mode-aware, +3 signup, +3 api-tokens-settings, +2 auth-config).

***REMOVED******REMOVED******REMOVED*** Step 7 — Drizzle migration smoke

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run db:migrate
```
Expected: clean run (idempotent — if already applied, no-op).

Inspect the resulting users table:
```bash
docker compose -f docker-compose.test.yml exec pg psql -U zugzug -d zugzug_test -c "\d zugzug_app.users" 2>&1 | head -20
docker compose -f docker-compose.test.yml exec pg psql -U zugzug -d zugzug_test -c "\d zugzug_app.api_tokens" 2>&1 | head -15
```
Expected: `password_hash`, `auth_provider` columns on users; `api_tokens` table with all columns + unique index on token_hash.

***REMOVED******REMOVED******REMOVED*** Step 8 — Password-mode boot smoke

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && timeout 5 bun run start 2>&1 | head -10 || true
```
Expected: boots cleanly with `· connected (duckdb, read-only)`. No errors about missing OIDC config (since OIDC vars are unset).

***REMOVED******REMOVED******REMOVED*** Step 9 — OIDC-mode boot smoke (no live provider)

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && OIDC_ISSUER_URL=https://example.test OIDC_CLIENT_ID=x OIDC_CLIENT_SECRET=y timeout 5 bun run start 2>&1 | head -10 || true
```
Expected: boots cleanly. OIDC discovery is lazy (only fires on first OIDC request), so even an unreachable issuer doesn't fail startup.

***REMOVED******REMOVED******REMOVED*** Step 10 — Manual UI smoke

In one terminal:
```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run start
```

In another:
```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run dev
```

Open <http://localhost:5173/login>. Verify:

1. Password form renders (since no OIDC env vars set).
2. Sign-up link at the bottom navigates to `/signup`.
3. On `/signup`: fill in name/email/password, click "Sign up" — first user becomes admin, redirected to `/app`.
4. In Settings → API tokens: create a token; it appears with a "Copy" affordance and a warning to save it now.
5. Use the token via curl:
   ```bash
   curl -H "Authorization: Bearer zz_..." http://localhost:8787/api/users
   ```
   Should return 200 with user list.
6. Revoke the token in Settings; reissue the curl — should return 401.
7. Restart the server with `OIDC_ISSUER_URL=https://accounts.google.com OIDC_CLIENT_ID=fake OIDC_CLIENT_SECRET=fake bun run start`. Reload the login page — should show "Sign in with SSO" (or "Google" if OIDC_LABEL is set) instead of the password form.

If any step fails, surface the failure mode; don't try to "fix" it here.

***REMOVED******REMOVED******REMOVED*** Step 11 — Commit history sanity

```bash
git log --oneline main..HEAD
```
Expected ~14 commits in dependency order:
- `chore(server): add openid-client for generic OIDC auth`
- `feat(db): users.password_hash + auth_provider; new api_tokens table`
- `feat(env): OIDC_* env vars + authMode derivation; deprecate GOOGLE_*`
- `feat(auth): /api/auth/config returns mode + allowedDomain + oidcLabel`
- `feat(auth): local password signup/login/change-password endpoints`
- `feat(auth): generic OIDC start/callback via openid-client v6`
- `feat(auth): API tokens — argon2id-hashed bearer tokens + endpoints`
- `feat(auth): bearer-token fallback in session gate`
- `refactor(auth): remove Google-OAuth-specific code; auth.ts is thin coordinator`
- `feat(store): useAuthConfig hook; deprecate allowedDomain from WorkspaceInfo`
- `feat(login): mode-aware UI — password form OR SSO button`
- `feat(signup): /signup route with email + password + name form`
- `feat(settings): API tokens section — list, create, revoke`
- `feat(scripts): admin CLI for password reset (no email flow in v1)`

(Possibly + style commits if prettier flagged.)

***REMOVED******REMOVED******REMOVED*** Step 12 — BC migration recommendation note

The PR description (handled by the controller, not this subagent) should document the BC env-var migration:

```
BC migration (post-merge):
  OIDC_ISSUER_URL=https://accounts.google.com
  OIDC_CLIENT_ID=<existing GOOGLE_CLIENT_ID>
  OIDC_CLIENT_SECRET=<existing GOOGLE_CLIENT_SECRET>
  OIDC_ALLOWED_DOMAIN=example.com
  OIDC_LABEL=Google
  DEFAULT_ENGINEER_MODE=false   (from PR 1)
```

No data migration needed beyond the Drizzle migration (which Bun runs at startup via bootstrap.ts). Existing sessions remain valid; existing Google users get `auth_provider='oidc'` automatically.

---

***REMOVED******REMOVED*** Self-review summary

**Spec coverage** (PR 2 only):

| Deliverable | Tasks |
|---|---|
| Drizzle migration | Task 2 ✓ |
| Auth mode resolution + env vars | Task 3 ✓ |
| `/api/auth/config` endpoint | Task 4 ✓ |
| Password endpoints (signup, login, change-password) | Task 5 ✓ |
| OIDC endpoints (start, callback, openid-client integration) | Task 6 ✓ |
| API tokens (endpoints, middleware, bearer auth) | Tasks 7, 8 ✓ |
| `auth.ts` rewrite as thin coordinator | Task 9 ✓ |
| `useAuthConfig` hook + deprecate `WorkspaceInfo.allowedDomain` | Task 10 ✓ |
| `Login.tsx` mode-aware | Task 11 ✓ |
| `Signup.tsx` + route | Task 12 ✓ |
| Settings API tokens section | Task 13 ✓ |
| admin-CLI reset-password | Task 14 ✓ |
| BC migration documentation | Task 15 Step 12 (PR description) |

**Placeholder scan:** zero matches in the plan for TBD/TODO/fill-in/etc.

**Type consistency:**
- `SessionUser` defined in `auth.ts`, used by `auth-password.ts`, `auth-oidc.ts`, `auth-api-tokens.ts` ✓
- `issueSession` defined in `auth.ts`, used by password + oidc handlers ✓
- `WorkspaceInfo` interface has `allowedDomain` removed; `isWorkspaceInfo` validator updated; consumers (Settings) updated to use `useAuthConfig` ✓
- `AuthConfig` shape consistent between server handler (`handleAuthConfig`) and frontend (`useAuthConfig` + `isAuthConfig`) ✓
- `ApiToken` / `CreatedApiToken` shapes consistent between server endpoints and frontend store ✓

**Out of scope** (deferred to v1.1+ per spec, captured in Task 15 commentary):
- Password reset email flow (admin CLI in Task 14 covers v1)
- Token scopes (none in v1)
- `OPEN_SIGNUP=true` env flag (signupOpen always false in v1)
- SAML/LDAP/magic-link
- Per-workspace credential admin UI

**Risks worth flagging to the controller:**
- The `mock.module()` strategy in Task 6 OIDC tests is somewhat new to this codebase (prior tests used dependency injection via constructor factories — Snowflake pattern). If Bun's module-mocking proves unreliable, the OIDC tests should be refactored to take the openid-client interface via DI (mirror the SnowflakeConnection pattern from Phase 2). The plan implementer should report if they hit flaky tests.
- The Drizzle migration (Task 2) runs automatically at server startup via `bootstrap.ts`. If a BC deployment has any unusual DB state (e.g., manually-created column conflicts), the migration could fail. Worth a manual smoke against a copy of BC's database before final cutover — but that's an operational concern, not a plan concern.
- The bearer-token middleware in Task 7 iterates ALL active tokens to find a hash match (argon2id has no pre-image search). For a deployment with hundreds of tokens, this becomes slow. Documented inline as "v1 prioritizes simplicity over scale." A future optimization could add a faster lookup prefix (e.g., the first 4 chars of the token as a non-unique index).
