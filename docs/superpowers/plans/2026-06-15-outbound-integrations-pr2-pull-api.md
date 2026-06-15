# Outbound Integrations — PR2: Pull API + Service Accounts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working, versioned, paginated JSON Pull API (`/api/t/:slug/v1/...`) plus workspace-scoped service-account credentials (`zzsa_...` tokens) — enough that a dbt/Fivetran consumer can incrementally sync canonical data from a workspace today, without webhooks.

**Architecture:** Auth extension comes first — `getApiTokenUser` learns to authenticate `zzsa_` tokens (workspace-bound, no membership join needed), and `resolveTenantContext` synthesises `role='viewer'` for service-account requests. Then service-account CRUD endpoints (admin-only mutations, viewer-readable list). Then a dedicated `repo-outbound.ts` module that exposes query helpers shaped for the JSON wire format (snake_case, includes `version` + `updated_at`, joins `canonical_version` with the `retired_at IS NULL` filter that PR1 added). Then 6 read endpoints layered on those helpers. Finally cross-cutting concerns: token-bucket rate limiter (per-credential), 30-day slug-redirect alias for renamed workspaces, and the HMAC-cursor wiring (helpers shipped in PR1).

**Tech Stack:** Bun HTTP server, raw SQL via `pgRun`/`pgGet`/`pgAll` (no ORM at the application layer — see PR1 PR description), nested string-matching route dispatch in `server.ts` (the codebase's established pattern), `bun:test`. Cursor format defined by `server/src/cursor.ts` (shipped in PR1). Argon2id token hashing via `Bun.password`.

**What this PR does NOT include:**
- Webhook dispatcher, retention sweep, reaper, `dispatchOutbound()` hook in `commit()` — **PR3**.
- Integrations UI (sidebar, Pull API page, Webhooks page, Service Accounts page, AppShell nav entry, Master records card removal) — **PR4**.
- The `webhook:manage` scope (reserved in the `service_account.scopes` CHECK; we ship only `read` in v1) — its first user is PR3, so PR3 enables it.
- The webhook signing recipe page — that page is part of PR4's UI.

---

## File Map

**Server — modified**
- `server/src/auth-api-tokens.ts` — extend `getApiTokenUser`'s return shape so service-account callers get a `serviceAccount` context object; add the `zzsa_` token resolution branch with the same prefix-indexed fast path used for `zz_` tokens. Add `handleListServiceAccounts`, `handleCreateServiceAccount`, `handleRevokeServiceAccount` for the new CRUD endpoints. (File grows, but stays domain-focused: "tokens that authenticate against api_tokens or service_account".)
- `server/src/auth.ts` — add an optional `Scope` type + `requireScope` helper (sibling of `requireAdmin`). Add `actorType` to the gate-context narrative used in audits.
- `server/src/tenant-middleware.ts` — `resolveTenantContext` learns to short-circuit when an SA context is present (no `memberRole` join needed; the SA's `tenant_id` IS the membership proof) and synthesises `role='viewer'`. Also adds a one-line "slug-redirect alias" check (delegates to a helper in `server/src/slug-alias.ts`).
- `server/src/server.ts` — register the new `/api/t/:slug/v1/...` route family. The Pull API dispatch lives in its own `handleV1Route()` function called from the top-level dispatcher so the existing server.ts route table isn't further bloated; this also gives the rate-limit middleware one clear chokepoint.
- `server/src/repo-canonical.ts` — no changes (`listDimensions`, `listFields`, `getDimension` already work). PR2 reads through dedicated helpers in `repo-outbound.ts` instead.

**Server — new**
- `server/src/repo-service-accounts.ts` — `createServiceAccount`, `listServiceAccounts`, `revokeServiceAccount`. Encrypts nothing (SA tokens are argon2-hashed like personal tokens; the AES-GCM master key is for webhook secrets only — PR3).
- `server/src/repo-outbound.ts` — Pull-API-shaped read helpers: `listDimensionsForApi(tenantId)`, `getSchemaForApi(tenantId, slug)`, `listCanonicalPage(tenantId, slug, opts)`, `getCanonicalRow(tenantId, slug, key)`, `listTombstonesPage(tenantId, slug, opts)`, `listEventsPage(tenantId, opts)`. Each returns the exact JSON shape the wire spec promises.
- `server/src/rate-limit.ts` — in-memory token-bucket keyed by credential id (SA id OR `api_tokens.id`), backed by a `auth_credential_quota` Postgres row for crash recovery.
- `server/src/slug-alias.ts` — 30-day stale-slug redirect; `lookupAliasedSlug(slug)` returns the current slug if the requested one is a recent rename source, or `null`.
- `server/src/v1-routes.ts` — `handleV1Route(req, ctx, seg, ...)` route dispatcher for everything under `/api/t/:slug/v1/...`. Keeps the route family isolated from the bulk of `server.ts`.

**Server — new tests**
- `server/src/auth-api-tokens-sa.test.ts` — `zzsa_` resolution, slug binding, expired/revoked handling.
- `server/src/repo-service-accounts.test.ts` — create/list/revoke + token-once semantics.
- `server/src/repo-outbound.test.ts` — Pull-API query helpers (wire shape, cursor pagination, soft-delete filter).
- `server/src/rate-limit.test.ts` — bucket refill, 429 response, ZUGZUG_PULL_API_RPM=0 disables.
- `server/src/slug-alias.test.ts` — 30-day window, post-window 404.
- `server/src/v1-routes.test.ts` — end-to-end route smoke tests (auth + tenant binding + cursor round-trip).

**Schema / DB**
- `server/drizzle/schema.ts` — add 2 new tables: `tenant_slug_alias` (for the 30-day redirect — `{old_slug pk, tenant_id, expires_at}`) and `auth_credential_quota` (for crash-recoverable rate-limit counts — `{credential_id pk, window_started_at, count}`).
- `server/drizzle/migrations/0026_<adjective_noun>.sql` — generated by `db:generate`.

---

## Baseline test failure list

Before starting, capture the current failing-test baseline so each task can verify no regressions:

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_baseline.txt
wc -l /tmp/zugzug_pr2_baseline.txt
```

Expected count: 157 (matches the post-PR1 baseline). Every subsequent task's regression-check uses this file.

---

## Task 1: Schema — `tenant_slug_alias` + `auth_credential_quota` tables

**Files:**
- Modify: `server/drizzle/schema.ts` (append at end, alongside PR1's outbound tables).

These are the two new tables PR2 needs. Both are tenant-adjacent: `tenant_slug_alias` enables the slug-rename grace window; `auth_credential_quota` is the rate-limiter's persistent backing.

- [ ] **Step 1: Append the table declarations**

Open `server/drizzle/schema.ts`. After the last `app.table(...)` declaration (which is `webhookDelivery` from PR1), append:

```ts
/* ---------- Outbound integrations PR2 ---------- */

export const tenantSlugAlias = app.table(
  "tenant_slug_alias",
  {
    /* Old slug becomes the lookup key — its primary use is "given a stale URL,
       which tenant should we redirect to?". The slug is globally unique so a
       single-column PK is enough; no tenant_id PK component needed. */
    old_slug:   varchar("old_slug").primaryKey(),
    tenant_id:  varchar("tenant_id").notNull().references(() => tenant.id),
    created_at: timestamp("created_at").notNull(),
    /* 30-day window from rename time. After expiry the alias is dropped (by
       the same outboundRetentionSweepJob that PR3 will introduce; until then,
       expired rows just stay around and are filtered out at read time). */
    expires_at: timestamp("expires_at").notNull(),
  },
  (t) => [
    index("tenant_slug_alias_tenant_idx").on(t.tenant_id),
    index("tenant_slug_alias_expires_idx").on(t.expires_at),
  ],
);

export const authCredentialQuota = app.table(
  "auth_credential_quota",
  {
    /* credential_id is either a service_account.id (sa_…) or an api_tokens.id
       (tok_…). No FK — credential rows can be revoked but their quota row
       should outlive that for end-of-minute accounting. We rely on the
       cleanup pass in outboundRetentionSweepJob (PR3) for housekeeping. */
    credential_id:      varchar("credential_id").primaryKey(),
    /* Start of the current rate-limit window (1-minute fixed-window in v1).
       Each request rolls this forward when the wall clock has crossed a
       minute boundary. */
    window_started_at:  timestamp("window_started_at").notNull(),
    count:              integer("count").notNull().default(0),
  },
  (t) => [
    index("auth_credential_quota_window_idx").on(t.window_started_at),
  ],
);
```

- [ ] **Step 2: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: exit 0. If `bytea`/other Drizzle helpers spring a surprise, check the imports — `varchar/timestamp/integer/index` are already imported.

- [ ] **Step 3: Commit**

```bash
git add server/drizzle/schema.ts
git commit -m "$(cat <<'EOF'
feat(schema): tenant_slug_alias + auth_credential_quota for PR2

tenant_slug_alias backs the 30-day stale-slug redirect window after a
workspace slug rename. auth_credential_quota is the crash-recoverable
backing for the per-credential token-bucket rate limiter; key is the
SA id or api_tokens.id, no FK so revoked credentials can keep their
end-of-minute accounting until the next sweep.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Generate + apply the migration

**Files:**
- Create (via codegen): `server/drizzle/migrations/0026_<adjective_noun>.sql`.

- [ ] **Step 1: Generate**

```bash
cd server && bun run db:generate
```
Expected: one new `0026_*.sql` file plus updated `meta/` snapshot. If codegen errors, STOP and report — the schema should be clean.

- [ ] **Step 2: Inspect the generated file**

Read the new file and confirm:
- `CREATE TABLE "zugzug_app"."tenant_slug_alias" (...)` with `old_slug` PK, `tenant_id` FK, `created_at`, `expires_at`, plus the two indexes.
- `CREATE TABLE "zugzug_app"."auth_credential_quota" (...)` with `credential_id` PK, `window_started_at`, `count` (default 0), and the window index.

- [ ] **Step 3: Apply against the test database**

```bash
cd server && DATABASE_URL=postgres://zugzug:zugzug@localhost:55432/zugzug_test bun run db:migrate
```
Expected: clean apply.

- [ ] **Step 4: Verify in psql**

```bash
PGPASSWORD=zugzug psql -h localhost -p 55432 -U zugzug -d zugzug_test \
  -c "\d zugzug_app.tenant_slug_alias" \
  -c "\d zugzug_app.auth_credential_quota"
```
Expected: both tables present with the expected columns.

- [ ] **Step 5: Regression check**

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_after_task2.txt
diff /tmp/zugzug_pr2_baseline.txt /tmp/zugzug_pr2_after_task2.txt
```
Expected: empty diff.

- [ ] **Step 6: Commit**

```bash
git add server/drizzle/migrations/ server/drizzle/meta/
git commit -m "$(cat <<'EOF'
feat(db): migration for PR2 tenant_slug_alias + auth_credential_quota

Drizzle-generated. No hand-edits required — both tables are plain DDL.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Auth extension — `getApiTokenUser` returns auth context with optional service-account

**Files:**
- Test: `server/src/auth-api-tokens-sa.test.ts` (new).
- Modify: `server/src/auth-api-tokens.ts`.
- Modify: `server/src/server.ts` (5 call sites — `getApiTokenUser(req)` consumers).

The current `getApiTokenUser` returns `SessionUser | null`. PR2 needs to surface service-account context too. The cleanest shape:

```ts
export interface AuthedRequest {
  user: SessionUser;                        // always present
  serviceAccount?: ServiceAccountCtx;       // set only for zzsa_ tokens
}
export interface ServiceAccountCtx {
  id: string;
  tenantId: string;
  scopes: string[];
}
```

We rename the function to `authenticateBearer(req)` for clarity (the old name didn't suggest the new SA-aware semantics) and keep a thin re-export named `getApiTokenUser` that returns just `SessionUser | null` so the migration is incremental.

Actually — let's be cleaner: rename the function AND its callers in one pass. There are only 5 call sites in `server.ts`, and grep confirms no other file uses it.

### Step 1: Write the failing test FIRST

Create `server/src/auth-api-tokens-sa.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun } from "./pg.ts";
import { authenticateBearer } from "./auth-api-tokens.ts";
import { createServiceAccount } from "./repo-service-accounts.ts"; // created in Task 5

const T = "test_auth_sa";
const U = "u_test_sa";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'Auth SA Test', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'SA Tester', 'sa@example.test', 'ST', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("authenticateBearer — service account tokens", () => {
  it("zzsa_ token returns a synthetic user + serviceAccount context", async () => {
    const { value } = await createServiceAccount({ tenantId: T, name: "Fivetran", createdBy: U });
    expect(value.startsWith("zzsa_")).toBe(true);

    const req = new Request("http://test/api/anything", {
      headers: { authorization: `Bearer ${value}` },
    });
    const authed = await authenticateBearer(req);
    expect(authed).not.toBeNull();
    expect(authed!.user.id.startsWith("sa_")).toBe(true);
    expect(authed!.user.email).toBeNull();
    expect(authed!.serviceAccount).toBeDefined();
    expect(authed!.serviceAccount!.tenantId).toBe(T);
    expect(authed!.serviceAccount!.scopes).toEqual(["read"]);
  });

  it("zz_ personal token still authenticates and serviceAccount is undefined", async () => {
    // Insert a personal token directly (testing handleCreateToken happens elsewhere).
    const value = `zz_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const hash = await Bun.password.hash(value);
    const id = `tok_sa_${crypto.randomUUID().replace(/-/g, "")}`;
    await pgRun(
      `INSERT INTO "zugzug_app"."api_tokens"
         (id, user_id, name, token_hash, token_prefix, created_at)
       VALUES ($1, $2, 'personal', $3, $4, now())`,
      [id, U, hash, value.slice(0, 12)],
    );

    const req = new Request("http://test/", {
      headers: { authorization: `Bearer ${value}` },
    });
    const authed = await authenticateBearer(req);
    expect(authed).not.toBeNull();
    expect(authed!.user.id).toBe(U);
    expect(authed!.serviceAccount).toBeUndefined();

    await pgRun(`DELETE FROM "zugzug_app"."api_tokens" WHERE id = $1`, [id]);
  });

  it("revoked zzsa_ token returns null", async () => {
    const { value, id: saId } = await createServiceAccount({ tenantId: T, name: "Revoked", createdBy: U });
    await pgRun(
      `UPDATE "zugzug_app"."service_account" SET revoked_at = now() WHERE id = $1`,
      [saId],
    );
    const req = new Request("http://test/", { headers: { authorization: `Bearer ${value}` } });
    expect(await authenticateBearer(req)).toBeNull();
  });

  it("expired zzsa_ token returns null (lazy auto-revoke)", async () => {
    const { value, id: saId } = await createServiceAccount({
      tenantId: T,
      name: "Expired",
      createdBy: U,
      expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
    });
    void saId;
    const req = new Request("http://test/", { headers: { authorization: `Bearer ${value}` } });
    expect(await authenticateBearer(req)).toBeNull();
  });
});
```

Note: this test depends on `createServiceAccount` from Task 5. The TDD cycle is: this test fails (module/function missing) → Task 5 creates the module → this test passes.

### Step 2: Run, confirm FAIL

```bash
cd server && bun test src/auth-api-tokens-sa.test.ts
```
Expected: FAIL — `repo-service-accounts.ts` doesn't exist, and `authenticateBearer` doesn't exist yet either.

### Step 3: Rewrite `auth-api-tokens.ts`

Open `server/src/auth-api-tokens.ts`. Add at the top of the file (after the existing imports):

```ts
const SA_PREFIX = "zzsa_";

export interface ServiceAccountCtx {
  id: string;
  tenantId: string;
  scopes: string[];
}

export interface AuthedRequest {
  user: SessionUser;
  serviceAccount?: ServiceAccountCtx;
}
```

Replace the entire `getApiTokenUser` function with this two-prefix dispatcher. Keep `getApiTokenUser` as a thin compatibility shim so existing callers (the 5 sites in `server.ts`) keep working until Task 4 updates them:

```ts
/** Resolves a Bearer-token request. Returns full auth context including
 *  service-account binding when applicable. Returns null for unknown /
 *  missing / revoked / expired credentials. */
export async function authenticateBearer(req: Request): Promise<AuthedRequest | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();

  if (token.startsWith(SA_PREFIX)) {
    return await resolveServiceAccountToken(token);
  }
  if (token.startsWith(TOKEN_PREFIX)) {
    const user = await resolvePersonalToken(token);
    return user ? { user } : null;
  }
  return null;
}

/** Compatibility shim. Returns just SessionUser, dropping serviceAccount context.
 *  Kept so existing call sites in server.ts that don't need SA awareness still
 *  work. New code should call authenticateBearer() directly. */
export async function getApiTokenUser(req: Request): Promise<SessionUser | null> {
  const a = await authenticateBearer(req);
  return a?.user ?? null;
}

async function resolveServiceAccountToken(token: string): Promise<AuthedRequest | null> {
  const prefix12 = token.slice(0, 12);
  const candidates = await pgAll<{
    id: string;
    tenant_id: string;
    token_hash: string;
    scopes: string[];
    name: string;
  }>(
    `SELECT id, tenant_id, token_hash, scopes, name
       FROM ${pg("service_account")}
      WHERE token_prefix = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [prefix12],
  );
  for (const cand of candidates) {
    if (await Bun.password.verify(token, cand.token_hash)) {
      void pgRun(
        `UPDATE ${pg("service_account")} SET last_used_at = current_timestamp WHERE id = $1`,
        [cand.id],
      ).catch(() => {});
      return {
        user: syntheticSaUser(cand.id, cand.name),
        serviceAccount: {
          id: cand.id,
          tenantId: cand.tenant_id,
          scopes: cand.scopes,
        },
      };
    }
  }
  return null;
}

async function resolvePersonalToken(token: string): Promise<SessionUser | null> {
  const prefix12 = token.slice(0, 12);

  // Fast path.
  const fast = await pgAll<{ id: string; user_id: string; token_hash: string }>(
    `SELECT id, user_id, token_hash FROM ${pg("api_tokens")}
      WHERE token_prefix = $1 AND revoked_at IS NULL`,
    [prefix12],
  );
  for (const cand of fast) {
    if (await Bun.password.verify(token, cand.token_hash)) {
      void pgRun(`UPDATE ${pg("api_tokens")} SET last_used_at = current_timestamp WHERE id = $1`, [
        cand.id,
      ]).catch(() => {});
      return await loadSessionUser(cand.user_id);
    }
  }

  // Legacy fallback (kept from PR1).
  const legacy = await pgAll<{ id: string; user_id: string; token_hash: string }>(
    `SELECT id, user_id, token_hash FROM ${pg("api_tokens")}
      WHERE token_prefix IS NULL AND revoked_at IS NULL
      ORDER BY last_used_at DESC NULLS LAST
      LIMIT 200`,
  );
  for (const cand of legacy) {
    if (await Bun.password.verify(token, cand.token_hash)) {
      console.warn(`[deprecation] legacy api_token authenticated; rotate token id=${cand.id}`);
      void pgRun(`UPDATE ${pg("api_tokens")} SET last_used_at = current_timestamp WHERE id = $1`, [
        cand.id,
      ]).catch(() => {});
      return await loadSessionUser(cand.user_id);
    }
  }
  return null;
}

/** Synthetic SessionUser representing a service-account-authenticated request.
 *  Audit rows attributed to this user surface as
 *  "committed by Service account: <name>" in the UI. */
function syntheticSaUser(saId: string, saName: string): SessionUser {
  return {
    id: saId,
    name: `Service account: ${saName}`,
    email: null as unknown as string, // SessionUser declares string; SA rows have no email
    initials: "SA",
    isSuperAdmin: false,
    impersonatingTenantId: null,
  };
}
```

Note about the `email` field: `SessionUser` declares `email: string`. Service accounts genuinely have no email. The cleanest fix is to widen `SessionUser.email` to `string | null` — do that here AND fix the one place that destructures email assuming string (likely `auth.ts` or a /me endpoint).

### Step 4: Widen `SessionUser.email` to `string | null`

In `server/src/auth.ts`, find the `SessionUser` interface and change:

```ts
  email: string;
```
to:
```ts
  email: string | null;   // null for service-account synthetic users
```

Then run `cd server && bun run typecheck` and fix any callers that did unguarded `.toLowerCase()` etc. on `user.email`. There are probably 1-3 such sites; add a `if (user.email)` guard or `user.email ?? ""` as appropriate. Do NOT silently drop email-dependent functionality for real users — guard, don't ignore.

### Step 5: Run, the SA test still fails (Task 5 not done)

```bash
cd server && bun test src/auth-api-tokens-sa.test.ts
```
Expected: still failing because `createServiceAccount` doesn't exist. The compatibility-shim work + `authenticateBearer` shape work is verified by typecheck + the existing PR1 personal-token test still passing.

### Step 6: Run PR1's `auth-api-tokens.test.ts` to confirm personal tokens still work

```bash
cd server && bun test src/auth-api-tokens.test.ts
```
Expected: all 3 PR1 tests pass.

### Step 7: Regression check (full suite)

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_after_task3.txt
diff /tmp/zugzug_pr2_baseline.txt /tmp/zugzug_pr2_after_task3.txt
```
Expected: empty diff (the SA test failures are NEW tests that don't exist in baseline — they shouldn't appear in the post-task list either because the file we created above won't run successfully until Task 5). If the new test file's failures show up in the diff, that's expected — note it and proceed.

Actually a cleaner approach: skip the SA test file in this task's regression check. Run:
```bash
cd server && bun test --exclude='src/auth-api-tokens-sa.test.ts' 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_after_task3.txt
```
If `--exclude` isn't supported by bun test's CLI, just `grep -v auth-api-tokens-sa` after.

### Step 8: Commit

```bash
git add server/src/auth-api-tokens.ts server/src/auth-api-tokens-sa.test.ts server/src/auth.ts
git commit -m "$(cat <<'EOF'
feat(auth): authenticateBearer surfaces service-account context for zzsa_

authenticateBearer is the new bearer-auth entry point: returns
{ user, serviceAccount? }, with serviceAccount populated only when the
token starts with zzsa_. getApiTokenUser kept as a SessionUser-only shim
so existing callers don't churn. SessionUser.email widened to string|null
because SA synthetic users genuinely have no email.

The SA branch uses the same prefix-indexed fast path as personal tokens —
single-row lookup keyed on token_prefix + revoked_at IS NULL, then
argon2 verify. Revoked OR expired SA tokens lazily fail auth on first
use (no nightly job needed).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Migrate the 5 server.ts callers from `getApiTokenUser` to `authenticateBearer`

**Files:**
- Modify: `server/src/server.ts` (5 call sites identified by `grep -n "getApiTokenUser" server/src/server.ts`).

The compatibility shim from Task 3 keeps existing call sites working, but they only get `SessionUser`. PR2 needs the SA context downstream — specifically, `resolveTenantContext` (Task 7) consumes it, and the route handlers (Tasks 10+) consume it for scope checks. We update every call site to `authenticateBearer` and thread the result through.

Note: this task is risky — touching 5 sites in server.ts could ripple. Take it slowly and verify each site individually.

### Step 1: Find every call site

```bash
grep -n "getApiTokenUser" server/src/server.ts
```
Expected: 5 lines (per the Explore report: lines ~155, 215, 487, 491, 495, 1760, 1792, 1793 — note the report listed more, indicating some sites have multiple references).

### Step 2: Inspect the code around each call site

For each line, read 15 lines of context. Each call site falls into one of two shapes:

- **Shape A (cookie-or-bearer auth flow):** `if (!sessionUser) sessionUser = await getApiTokenUser(req)`. Here we want to replace with `authenticateBearer` AND keep the resulting `serviceAccount` context accessible to the route. Add a sibling variable `let saCtx: ServiceAccountCtx | null = null;` and populate it from the result.

- **Shape B (handler dispatch):** The dynamic import `const { handleListTokens } = await import("./auth-api-tokens.ts")`. These don't need changing — they're invoking the personal-token CRUD endpoints which don't touch SA context.

### Step 3: Update Shape A sites

For the FIRST call site (around line 211–217), the current code is roughly:

```ts
try {
  sessionUser = await getSessionUser(req);
  if (!sessionUser) {
    const { getApiTokenUser } = await import("./auth-api-tokens.ts");
    sessionUser = await getApiTokenUser(req);
  }
} catch (e) { ... }
```

Replace with:

```ts
let saCtx: import("./auth-api-tokens.ts").ServiceAccountCtx | null = null;
try {
  sessionUser = await getSessionUser(req);
  if (!sessionUser) {
    const { authenticateBearer } = await import("./auth-api-tokens.ts");
    const authed = await authenticateBearer(req);
    if (authed) {
      sessionUser = authed.user;
      saCtx = authed.serviceAccount ?? null;
    }
  }
} catch (e) { ... }
```

Then where `resolveTenantContext(...)` is called (around line 540), pass the new context:

```ts
tenantCtx = await resolveTenantContext({
  pathname: pathnameForCtx,
  user: sessionUser,
  isSuperAdmin: sessionUser.isSuperAdmin,
  impersonatingTenantId: sessionUser.impersonatingTenantId,
  serviceAccount: saCtx ?? undefined,    // NEW — Task 7 consumes this
});
```

Task 7 will extend `ResolveOpts` and `resolveTenantContext` to honour the new arg. For now, just pass it.

### Step 4: Update the second Shape A site (around line 1760-1793)

The second call site has a similar shape (cookie-or-bearer for a specific route family). Apply the same `let saCtx` + `authenticateBearer` pattern. If `resolveTenantContext` isn't called from that code path, the `saCtx` just stays unused — that's fine; we'll consume it in the v1 dispatch later.

### Step 5: Typecheck

```bash
cd server && bun run typecheck
```
Expected: exit 0. The new `serviceAccount?: ...` field on `ResolveOpts` doesn't exist yet (Task 7) — TS will complain. To unblock: add `serviceAccount?: import("./auth-api-tokens.ts").ServiceAccountCtx` to `ResolveOpts` in `tenant-middleware.ts` (this is a one-line preview of Task 7's full change; we widen the type now to keep the diff small later).

### Step 6: Full test suite (regression)

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u | grep -v auth-api-tokens-sa > /tmp/zugzug_pr2_after_task4.txt
diff /tmp/zugzug_pr2_baseline.txt /tmp/zugzug_pr2_after_task4.txt
```
Expected: empty diff.

### Step 7: Commit

```bash
git add server/src/server.ts server/src/tenant-middleware.ts
git commit -m "$(cat <<'EOF'
refactor(server): route bearer-auth through authenticateBearer

Each cookie-or-bearer call site now captures the optional serviceAccount
context from authenticateBearer and forwards it into resolveTenantContext.
The middleware doesn't yet honour the new arg — Task 7 wires it. Type
widened in ResolveOpts as a preview so this change typechecks.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Service-account repo (`createServiceAccount`, `listServiceAccounts`, `revokeServiceAccount`)

**Files:**
- Create: `server/src/repo-service-accounts.ts`.
- Test: `server/src/repo-service-accounts.test.ts`.

This unblocks the failing `auth-api-tokens-sa.test.ts` tests (Task 3) and shapes the data layer for the CRUD endpoints (Task 8).

### Step 1: Write failing tests FIRST

Create `server/src/repo-service-accounts.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import {
  createServiceAccount,
  listServiceAccounts,
  revokeServiceAccount,
} from "./repo-service-accounts.ts";

const T = "test_sa_repo";
const U = "u_test_sa_repo";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'SA Repo Test', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'SA Repo Tester', 'sar@example.test', 'SR', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("createServiceAccount", () => {
  it("returns a zzsa_ token value and persists the row with correct fields", async () => {
    const r = await createServiceAccount({
      tenantId: T,
      name: "dbt prod",
      createdBy: U,
    });
    expect(r.id.startsWith("sa_")).toBe(true);
    expect(r.value.startsWith("zzsa_")).toBe(true);
    expect(r.value.length).toBeGreaterThan(40);

    const row = await pgGet<{
      tenant_id: string;
      name: string;
      token_prefix: string;
      scopes: string[];
      revoked_at: Date | null;
      expires_at: Date | null;
    }>(
      `SELECT tenant_id, name, token_prefix, scopes, revoked_at, expires_at
         FROM "zugzug_app"."service_account" WHERE id = $1`,
      [r.id],
    );
    expect(row).not.toBeNull();
    expect(row!.tenant_id).toBe(T);
    expect(row!.name).toBe("dbt prod");
    expect(row!.token_prefix).toBe(r.value.slice(0, 12));
    expect(row!.scopes).toEqual(["read"]);
    expect(row!.revoked_at).toBeNull();
    expect(row!.expires_at).toBeNull();
  });

  it("expiresAt is persisted when provided", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    const r = await createServiceAccount({
      tenantId: T,
      name: "1-year",
      createdBy: U,
      expiresAt: future,
    });
    const row = await pgGet<{ expires_at: Date | null }>(
      `SELECT expires_at FROM "zugzug_app"."service_account" WHERE id = $1`,
      [r.id],
    );
    expect(row!.expires_at).not.toBeNull();
    expect(Math.abs(row!.expires_at!.getTime() - future.getTime())).toBeLessThan(1000);
  });
});

describe("listServiceAccounts", () => {
  it("returns one row per non-revoked SA in tenant, with sa_id + prefix + scopes + created_by", async () => {
    const a = await createServiceAccount({ tenantId: T, name: "list_a", createdBy: U });
    const b = await createServiceAccount({ tenantId: T, name: "list_b", createdBy: U });
    const list = await listServiceAccounts(T);
    const ids = list.map((sa) => sa.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    const aRow = list.find((sa) => sa.id === a.id)!;
    expect(aRow.tokenPrefix).toBe(a.value.slice(0, 12));
    expect(aRow.scopes).toEqual(["read"]);
    expect(aRow.createdBy).toBe(U);
    expect(aRow.revokedAt).toBeNull();
  });

  it("does NOT return revoked rows", async () => {
    const r = await createServiceAccount({ tenantId: T, name: "to_revoke", createdBy: U });
    await revokeServiceAccount(T, r.id);
    const list = await listServiceAccounts(T);
    expect(list.find((sa) => sa.id === r.id)).toBeUndefined();
  });

  it("is scoped to the tenant — does not leak across tenants", async () => {
    const tt = "test_sa_repo_other";
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
       VALUES ($1, $1, 'Other', 'default', now()) ON CONFLICT DO NOTHING`,
      [tt],
    );
    const r = await createServiceAccount({ tenantId: tt, name: "other_tenant", createdBy: U });
    const list = await listServiceAccounts(T);
    expect(list.find((sa) => sa.id === r.id)).toBeUndefined();
    await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [tt]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [tt]);
  });
});

describe("revokeServiceAccount", () => {
  it("sets revoked_at on the matching row, returns true", async () => {
    const r = await createServiceAccount({ tenantId: T, name: "revoke_target", createdBy: U });
    const ok = await revokeServiceAccount(T, r.id);
    expect(ok).toBe(true);
    const row = await pgGet<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM "zugzug_app"."service_account" WHERE id = $1`,
      [r.id],
    );
    expect(row!.revoked_at).not.toBeNull();
  });

  it("returns false when the id doesn't belong to the tenant", async () => {
    const r = await createServiceAccount({ tenantId: T, name: "for_other_tenant", createdBy: U });
    const ok = await revokeServiceAccount("other_tenant", r.id);
    expect(ok).toBe(false);
    const row = await pgGet<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM "zugzug_app"."service_account" WHERE id = $1`,
      [r.id],
    );
    expect(row!.revoked_at).toBeNull();
  });
});
```

Run: `cd server && bun test src/repo-service-accounts.test.ts` — expect FAIL (module missing).

### Step 2: Write the implementation

Create `server/src/repo-service-accounts.ts`:

```ts
/* repo-service-accounts.ts — workspace-scoped M2M token CRUD.

   Tokens authenticate as the workspace (not as a person) and persist when
   members leave. Stored as Bun.password.hash (argon2id); shown once at
   creation, never re-displayable. The token_prefix column enables O(1)
   prefix-indexed auth lookup (see auth-api-tokens.ts:resolveServiceAccountToken). */

import { pg } from "./env.ts";
import { pgRun, pgGet, pgAll } from "./pg.ts";

const SA_PREFIX = "zzsa_";

export interface CreateInput {
  tenantId: string;
  name: string;
  createdBy: string;
  /** null/undefined => never. */
  expiresAt?: Date | null;
}

export interface CreateResult {
  id: string;
  value: string; // shown once; recovery requires revoke + reissue
}

export interface ServiceAccountSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

function generateTokenValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = Buffer.from(bytes).toString("base64url");
  return `${SA_PREFIX}${b64}`;
}

export async function createServiceAccount(input: CreateInput): Promise<CreateResult> {
  if (!input.name.trim()) throw new Error("service account name required");
  if (input.name.length > 100) throw new Error("service account name too long");

  const id = `sa_${crypto.randomUUID().replace(/-/g, "")}`;
  const value = generateTokenValue();
  const hash = await Bun.password.hash(value);
  await pgRun(
    `INSERT INTO ${pg("service_account")}
       (id, tenant_id, name, token_hash, token_prefix, scopes,
        created_at, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, ARRAY['read']::varchar[],
             current_timestamp, $6, $7)`,
    [id, input.tenantId, input.name.trim(), hash, value.slice(0, 12), input.createdBy, input.expiresAt ?? null],
  );
  return { id, value };
}

export async function listServiceAccounts(tenantId: string): Promise<ServiceAccountSummary[]> {
  const rows = await pgAll<{
    id: string;
    name: string;
    token_prefix: string;
    scopes: string[];
    created_at: string;
    created_by: string;
    last_used_at: string | null;
    expires_at: string | null;
    revoked_at: string | null;
  }>(
    `SELECT id, name, token_prefix, scopes,
            created_at::text AS created_at,
            created_by,
            last_used_at::text AS last_used_at,
            expires_at::text AS expires_at,
            revoked_at::text AS revoked_at
       FROM ${pg("service_account")}
      WHERE tenant_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokenPrefix: r.token_prefix,
    scopes: r.scopes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

/** Returns true if the row matched the tenant AND was newly revoked. */
export async function revokeServiceAccount(tenantId: string, id: string): Promise<boolean> {
  const row = await pgGet<{ revoked: boolean }>(
    `UPDATE ${pg("service_account")}
        SET revoked_at = current_timestamp
      WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
      RETURNING true AS revoked`,
    [id, tenantId],
  );
  return !!row;
}
```

### Step 3: Run, confirm PASS

```bash
cd server && bun test src/repo-service-accounts.test.ts
```
Expected: all tests pass (7 tests, ~12 expects).

### Step 4: The Task 3 SA tests should now pass too

```bash
cd server && bun test src/auth-api-tokens-sa.test.ts
```
Expected: all 4 tests pass.

### Step 5: Regression check (full suite)

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_after_task5.txt
diff /tmp/zugzug_pr2_baseline.txt /tmp/zugzug_pr2_after_task5.txt
```
Expected: empty diff.

### Step 6: Commit

```bash
git add server/src/repo-service-accounts.ts server/src/repo-service-accounts.test.ts
git commit -m "$(cat <<'EOF'
feat(server): service-account CRUD repo

createServiceAccount mints zzsa_ + 43-char random tokens, argon2-hashed
with the same Bun.password.hash() recipe personal tokens use. Token value
shown once; recovery requires revoke + reissue. listServiceAccounts
filters out revoked rows and scopes to tenant. revokeServiceAccount is
idempotent and tenant-bound.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `Scope` type + `requireScope` helper in auth.ts

**Files:**
- Modify: `server/src/auth.ts` — add `Scope` type + `requireScope` helper alongside the existing `requireAdmin`.

PR2's mutation routes on `/v1/webhooks*` and `/v1/service-accounts*` need to gate on scope before role. v1 SA tokens have `scopes: ['read']`; mutation routes call `requireScope(ctx, 'webhook:manage')` (reserved for PR3) — so every SA mutation returns 403 `scope_insufficient`. Service-account-creation endpoints in PR2 are admin-only (no SA can do it; only users), but we add the helper now so PR3's webhook routes can compose it.

- [ ] **Step 1: Add the type + helper**

Open `server/src/auth.ts`. After the existing `requireAdmin` helper, add:

```ts
export type Scope = "read" | "webhook:manage";

export interface ScopedRequest {
  serviceAccount?: { scopes: string[] };
}

/** Pre-role gate for SA requests. If the caller is NOT a service account
 *  (i.e. cookie or personal-token authenticated), the scope check is a
 *  no-op — the existing role gates take over. SA tokens must carry the
 *  scope explicitly OR the route returns 403 scope_insufficient. */
export function requireScope(
  req: ScopedRequest,
  required: Scope,
): { ok: true } | { ok: false; status: 403; error: "scope_insufficient" } {
  if (!req.serviceAccount) return { ok: true };
  if (req.serviceAccount.scopes.includes(required)) return { ok: true };
  return { ok: false, status: 403, error: "scope_insufficient" };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd server && bun run typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/auth.ts
git commit -m "$(cat <<'EOF'
feat(auth): Scope type + requireScope helper

requireScope is the pre-role gate for mutation routes under /v1/. For
cookie / personal-token requests it's a no-op (role gates still apply);
for SA requests it returns 403 scope_insufficient when the SA token
doesn't carry the required scope. v1 ships only "read"; "webhook:manage"
is reserved for PR3.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `resolveTenantContext` honours the service-account context

**Files:**
- Modify: `server/src/tenant-middleware.ts`.

When the request authenticated via a `zzsa_` token, the SA's `tenant_id` is the membership proof — no need to query `memberRole`. Also, the URL's `:slug` MUST resolve to a tenant whose `id` matches the SA's `tenantId` (otherwise 403 — the SA is bound to a workspace at issue time).

### Step 1: Write the failing test FIRST

Append to `server/src/auth-api-tokens-sa.test.ts` (the file from Task 3):

```ts
import { resolveTenantContext } from "./tenant-middleware.ts";

describe("resolveTenantContext — service account context", () => {
  it("synthesises role='viewer' when the SA's tenant matches the URL slug", async () => {
    const { value } = await createServiceAccount({ tenantId: T, name: "Resolver", createdBy: U });
    const req = new Request(`http://test/api/t/${T}/v1/dimensions`, {
      headers: { authorization: `Bearer ${value}` },
    });
    const authed = await authenticateBearer(req);
    expect(authed!.serviceAccount).toBeDefined();

    const ctx = await resolveTenantContext({
      pathname: `/api/t/${T}/v1/dimensions`,
      user: authed!.user,
      isSuperAdmin: false,
      serviceAccount: authed!.serviceAccount,
    });
    expect(ctx.tenantId).toBe(T);
    expect(ctx.role).toBe("viewer");
    expect(ctx.isSuperAdmin).toBe(false);
  });

  it("rejects with TENANT_MISMATCH when the SA's tenant does NOT match the URL slug", async () => {
    const tt = "test_sa_mismatch";
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
       VALUES ($1, $1, 'Mismatch', 'default', now()) ON CONFLICT DO NOTHING`,
      [tt],
    );
    const { value } = await createServiceAccount({ tenantId: tt, name: "Wrong", createdBy: U });
    const req = new Request(`http://test/api/t/${T}/v1/dimensions`, {
      headers: { authorization: `Bearer ${value}` },
    });
    const authed = await authenticateBearer(req);

    await expect(
      resolveTenantContext({
        pathname: `/api/t/${T}/v1/dimensions`,
        user: authed!.user,
        isSuperAdmin: false,
        serviceAccount: authed!.serviceAccount,
      }),
    ).rejects.toThrow(/tenant/i);

    await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [tt]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [tt]);
  });
});
```

### Step 2: Extend `ResolveOpts` and `resolveTenantContext`

In `server/src/tenant-middleware.ts`:

1. Add the SA field to `ResolveOpts` (if Task 4 didn't already add it as a preview):

```ts
import type { ServiceAccountCtx } from "./auth-api-tokens.ts";

export interface ResolveOpts {
  pathname: string;
  user: SessionUser;
  isSuperAdmin?: boolean;
  impersonatingTenantId?: string | null;
  serviceAccount?: ServiceAccountCtx;
}
```

2. At the top of `resolveTenantContext` (after `const m = TENANT_PATH_RE.exec(opts.pathname); if (!m) throw ...; const slug = m[1];`), add the SA short-circuit:

```ts
if (opts.serviceAccount) {
  const tenant = await tenantBySlug(slug);
  if (!tenant) throw new AppError("TENANT_NOT_FOUND", `No tenant for slug ${slug}`, 404);
  if (tenant.id !== opts.serviceAccount.tenantId) {
    throw new AppError(
      "TENANT_MISMATCH",
      "Service-account token is bound to a different workspace",
      403,
    );
  }
  return { tenantId: tenant.id, role: "viewer", isSuperAdmin: false };
}
```

This goes BEFORE the existing user-membership lookup so the SA branch never hits `memberRole`. The existing branch handles cookie + personal-token requests unchanged.

`AppError` is already imported in tenant-middleware (check; if not, import it from `./errors.ts` or wherever the codebase puts it — `grep -n "AppError" server/src/tenant-middleware.ts` to confirm).

### Step 3: Run, confirm PASS

```bash
cd server && bun test src/auth-api-tokens-sa.test.ts
```
Expected: all tests pass (6 tests after Task 3 + Task 7 additions).

### Step 4: Regression check

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_after_task7.txt
diff /tmp/zugzug_pr2_baseline.txt /tmp/zugzug_pr2_after_task7.txt
```
Expected: empty diff.

### Step 5: Commit

```bash
git add server/src/tenant-middleware.ts server/src/auth-api-tokens-sa.test.ts
git commit -m "$(cat <<'EOF'
feat(tenant-middleware): SA branch synthesises role='viewer'

resolveTenantContext short-circuits when serviceAccount is set: confirms
the URL slug resolves to the SA's bound tenant (403 TENANT_MISMATCH
otherwise) and returns role='viewer' without consulting memberRole. v1
SA tokens are read-only by design (scope='read'); mutation routes layer
requireScope(ctx, 'webhook:manage') on top, which v1 SAs never satisfy.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `repo-outbound.ts` — Pull-API-shaped query helpers

**Files:**
- Create: `server/src/repo-outbound.ts`.
- Test: `server/src/repo-outbound.test.ts`.

The Pull API returns wire-shaped JSON that differs from the UI's internal `MappingDimension`/`CanonicalValue` types. Rather than reshape at the handler level (where errors propagate to consumers and are hard to test), we define a dedicated repo module with one function per endpoint.

### Step 1: Write failing tests FIRST

Create `server/src/repo-outbound.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import { addDimension, addCanonical, mergeCanonical, retireCanonical } from "./repo-canonical.ts";
import {
  listDimensionsForApi,
  getSchemaForApi,
  listCanonicalPage,
  getCanonicalRow,
  listTombstonesPage,
} from "./repo-outbound.ts";

const T = "test_repo_outbound";
const U = "u_test_outbound";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'Outbound Repo', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Outbound Test', 'orb@example.test', 'OT', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("listDimensionsForApi", () => {
  it("returns one entry per dim with slug, label, key_kind, canonical_count, last_committed_at", async () => {
    const dim = await addDimension("OutCountry", [], { keyKind: "slug" }, U, T);
    await addCanonical(dim.id, [{ key: "DE", label: "Germany" }], T);

    const out = await listDimensionsForApi(T);
    const country = out.dimensions.find((d) => d.slug === dim.id);
    expect(country).toBeDefined();
    expect(country!.label).toBe("OutCountry");
    expect(country!.key_kind).toBe("slug");
    expect(country!.canonical_count).toBeGreaterThanOrEqual(1);
    expect(typeof country!.last_committed_at).toBe("string"); // ISO
  });
});

describe("getSchemaForApi", () => {
  it("returns dim_slug + fields", async () => {
    const dim = await addDimension("OutSchema", [], { keyKind: "slug" }, U, T);
    const out = await getSchemaForApi(T, dim.id);
    expect(out).not.toBeNull();
    expect(out!.dim_slug).toBe(dim.id);
    expect(out!.label).toBe("OutSchema");
    expect(Array.isArray(out!.fields)).toBe(true);
  });

  it("returns null when the dim doesn't exist OR belongs to another tenant", async () => {
    expect(await getSchemaForApi(T, "no_such_dim")).toBeNull();
  });
});

describe("listCanonicalPage", () => {
  it("returns records in updated_at, key order; respects limit; emits a cursor on truncation", async () => {
    const dim = await addDimension("OutPage", [], { keyKind: "slug" }, U, T);
    await addCanonical(
      dim.id,
      Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, label: `Label ${i}` })),
      T,
    );

    const page1 = await listCanonicalPage(T, dim.id, { limit: 3 });
    expect(page1.records.length).toBe(3);
    expect(page1.cursor.next).not.toBeNull();
    expect(page1.meta.dim_slug).toBe(dim.id);
    expect(page1.meta.page_size).toBe(3);

    const page2 = await listCanonicalPage(T, dim.id, { limit: 3, cursor: page1.cursor.next! });
    expect(page2.records.length).toBe(2);
    expect(page2.cursor.next).toBeNull();

    // No overlap between pages.
    const allKeys = [...page1.records, ...page2.records].map((r) => r.key);
    expect(new Set(allKeys).size).toBe(5);
  });

  it("?since= filters by canonical_version.updated_at (inclusive)", async () => {
    const dim = await addDimension("OutSince", [], { keyKind: "slug" }, U, T);
    await addCanonical(dim.id, [{ key: "OLD", label: "Old" }], T);

    // Capture the boundary.
    const boundary = await pgGet<{ ts: string }>(
      `SELECT (now() + interval '100 milliseconds')::text AS ts`,
    );
    await new Promise((r) => setTimeout(r, 250));

    await addCanonical(dim.id, [{ key: "NEW", label: "New" }], T);

    const res = await listCanonicalPage(T, dim.id, { since: boundary!.ts, limit: 100 });
    const keys = res.records.map((r) => r.key);
    expect(keys).toContain("NEW");
    expect(keys).not.toContain("OLD");
  });

  it("excludes soft-deleted rows", async () => {
    const dim = await addDimension("OutSoftDel", [], { keyKind: "slug" }, U, T);
    await addCanonical(dim.id, [
      { key: "A", label: "Alpha" },
      { key: "B", label: "Beta" },
    ], T);
    const versions = await pgAll<{ key: string; version: number }>(
      `SELECT key, version FROM "zugzug_app"."canonical_version"
       WHERE dim_id = $1 AND tenant_id = $2`,
      [dim.id, T],
    );
    const v = Object.fromEntries(versions.map((r) => [r.key, r.version]));
    await mergeCanonical(dim.id, "A", ["B"], U, v, T);

    const res = await listCanonicalPage(T, dim.id, { limit: 100 });
    expect(res.records.map((r) => r.key)).toEqual(["A"]);
  });

  it("returns 0 rows for a dim that belongs to a different tenant", async () => {
    const dim = await addDimension("OutTenantScope", [], { keyKind: "slug" }, U, T);
    await addCanonical(dim.id, [{ key: "X", label: "X" }], T);
    const res = await listCanonicalPage("other_tenant_id", dim.id, { limit: 100 });
    expect(res.records).toEqual([]);
  });
});

describe("getCanonicalRow", () => {
  it("returns the row for a live key", async () => {
    const dim = await addDimension("OutOne", [], { keyKind: "slug" }, U, T);
    await addCanonical(dim.id, [{ key: "ONE", label: "One" }], T);
    const row = await getCanonicalRow(T, dim.id, "ONE");
    expect(row).not.toBeNull();
    expect(row!.key).toBe("ONE");
    expect(row!.label).toBe("One");
  });

  it("returns null for a retired key", async () => {
    const dim = await addDimension("OutRetired", [], { keyKind: "slug" }, U, T);
    await addCanonical(dim.id, [{ key: "GONE", label: "Gone" }], T);
    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version"
       WHERE dim_id = $1 AND key = 'GONE' AND tenant_id = $2`,
      [dim.id, T],
    );
    await retireCanonical(dim.id, "GONE", U, v!.version, T);
    expect(await getCanonicalRow(T, dim.id, "GONE")).toBeNull();
  });
});

describe("listTombstonesPage", () => {
  it("returns retired keys with retired_at + retired_into", async () => {
    const dim = await addDimension("OutTombs", [], { keyKind: "slug" }, U, T);
    await addCanonical(dim.id, [
      { key: "SURV", label: "Survivor" },
      { key: "MERGED", label: "Merged" },
      { key: "RETIRED", label: "Retired" },
    ], T);
    const versions = await pgAll<{ key: string; version: number }>(
      `SELECT key, version FROM "zugzug_app"."canonical_version"
       WHERE dim_id = $1 AND tenant_id = $2`,
      [dim.id, T],
    );
    const v = Object.fromEntries(versions.map((r) => [r.key, r.version]));
    await mergeCanonical(dim.id, "SURV", ["MERGED"], U, v, T);
    await retireCanonical(dim.id, "RETIRED", U, v.RETIRED, T);

    const res = await listTombstonesPage(T, dim.id, { limit: 100 });
    const byKey = Object.fromEntries(res.tombstones.map((t) => [t.key, t]));
    expect(byKey.MERGED).toBeDefined();
    expect(byKey.MERGED.retired_into).toBe("SURV");
    expect(byKey.RETIRED).toBeDefined();
    expect(byKey.RETIRED.retired_into).toBeNull();
  });
});
```

Run: `cd server && bun test src/repo-outbound.test.ts` — expect FAIL (module missing).

### Step 2: Write the implementation

Create `server/src/repo-outbound.ts`:

```ts
/* repo-outbound.ts — Pull-API-shaped query helpers.

   These return JSON-wire shapes (snake_case, ISO timestamps, cursor strings)
   directly — the route handlers in v1-routes.ts wrap the result and add
   HTTP-level concerns (status code, content-type). Keeping the wire-shape
   computation here makes it independently testable and ensures the
   handlers stay thin. */

import { pg } from "./env.ts";
import { pgAll, pgGet } from "./pg.ts";
import { signCursor, verifyCursor, type CursorPayload } from "./cursor.ts";
import { env } from "./env.ts";
import { cq, qid } from "./repo-shared.ts";
import { listFields } from "./repo-canonical.ts";

const DEFAULT_LIMIT_CANONICAL = 100;
const MAX_LIMIT_CANONICAL = 1000;
const DEFAULT_LIMIT_TOMBSTONES = 100;
const MAX_LIMIT_TOMBSTONES = 1000;

export interface DimensionForApi {
  slug: string;
  label: string;
  key_kind: string;
  canonical_count: number;
  last_committed_at: string | null;
}

export interface SchemaForApi {
  dim_slug: string;
  label: string;
  fields: Array<{ name: string; type: string; description: string | null }>;
}

export interface CanonicalRecord {
  key: string;
  label: string;
  fields: Record<string, unknown>;
  updated_at: string;
  version: number;
}

export interface PageMeta {
  dim_slug: string;
  page_size: number;
}

export interface CanonicalPageResponse {
  records: CanonicalRecord[];
  cursor: { next: string | null };
  meta: PageMeta;
}

export interface TombstoneRecord {
  key: string;
  retired_at: string;
  retired_into: string | null;
}

export interface TombstonePageResponse {
  tombstones: TombstoneRecord[];
  cursor: { next: string | null };
}

export interface PageOpts {
  since?: string;       // ISO 8601 — inclusive lower bound on updated_at / retired_at
  cursor?: string;      // signed continuation token
  limit?: number;
}

function getCursorKey(): string {
  if (!env.cursorKeyB64) {
    throw new Error("ZUGZUG_CURSOR_KEY is not set — Pull API cannot sign cursors");
  }
  return env.cursorKeyB64;
}

function clampLimit(n: number | undefined, def: number, max: number): number {
  if (!n || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/* ---------- list dimensions ---------- */

export async function listDimensionsForApi(tenantId: string): Promise<{ dimensions: DimensionForApi[] }> {
  const rows = await pgAll<{
    id: string;
    label: string;
    key_kind: string | null;
    canonical_count: number;
    last_committed_at: string | null;
  }>(
    `SELECT d.id,
            d.label,
            COALESCE(d.key_kind, 'slug') AS key_kind,
            COALESCE((SELECT count(*) FROM "zugzug_app"."canonical_version" cv
                       WHERE cv.dim_id = d.id AND cv.tenant_id = d.tenant_id
                         AND cv.retired_at IS NULL), 0)::int AS canonical_count,
            (SELECT max(cv.updated_at)::text FROM "zugzug_app"."canonical_version" cv
              WHERE cv.dim_id = d.id AND cv.tenant_id = d.tenant_id
                AND cv.retired_at IS NULL) AS last_committed_at
       FROM ${pg("dimension")} d
      WHERE d.tenant_id = $1
      ORDER BY d.label`,
    [tenantId],
  );
  return {
    dimensions: rows.map((r) => ({
      slug: r.id,
      label: r.label,
      key_kind: r.key_kind ?? "slug",
      canonical_count: r.canonical_count,
      last_committed_at: r.last_committed_at,
    })),
  };
}

/* ---------- schema ---------- */

export async function getSchemaForApi(tenantId: string, slug: string): Promise<SchemaForApi | null> {
  const dim = await pgGet<{ id: string; label: string }>(
    `SELECT id, label FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [slug, tenantId],
  );
  if (!dim) return null;
  const fields = await listFields(slug, tenantId);
  return {
    dim_slug: dim.id,
    label: dim.label,
    fields: fields.map((f) => ({
      name: f.field,
      type: f.type,
      description: f.description ?? null,
    })),
  };
}

/* ---------- canonical page ---------- */

export async function listCanonicalPage(
  tenantId: string,
  slug: string,
  opts: PageOpts,
): Promise<CanonicalPageResponse> {
  const limit = clampLimit(opts.limit, DEFAULT_LIMIT_CANONICAL, MAX_LIMIT_CANONICAL);

  // Resolve cursor → (sinceTs, sinceKey).
  let sinceTs: string | null = opts.since ?? null;
  let sinceKey: string | null = null;
  if (opts.cursor) {
    const v = verifyCursor(opts.cursor, getCursorKey(), tenantId);
    if (!v.ok) {
      throw new Error(v.reason); // route handler maps to 400
    }
    sinceTs = v.payload.u;
    sinceKey = v.payload.k;
  }

  const dim = await pgGet<{ dim_table: string; key_col: string }>(
    `SELECT dim_table, key_col FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [slug, tenantId],
  );
  if (!dim) {
    return { records: [], cursor: { next: null }, meta: { dim_slug: slug, page_size: limit } };
  }
  const keyCol = qid(dim.key_col);

  // Field columns to project — we serve {key, label, fields: {...}} so collect
  // every dim_<slug> column EXCEPT key+label+position+tenant_id.
  const dimCols = await pgAll<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'zugzug_app' AND table_name = $1
        AND column_name NOT IN ('label', 'position', 'tenant_id')`,
    [dim.dim_table.replace(/^.*\./, "")],
  );
  const fieldColumns = dimCols
    .map((c) => c.column_name)
    .filter((c) => c !== dim.key_col);

  // Build the dynamic field selection. Stay defensive — qid() each name.
  const fieldsJsonExpr = fieldColumns.length
    ? `jsonb_build_object(${fieldColumns
        .map((c) => `'${c.replace(/'/g, "''")}', d.${qid(c)}`)
        .join(",")})`
    : `'{}'::jsonb`;

  // The query selects from dim_<slug> JOIN canonical_version, ordered by
  // (cv.updated_at, d.key) so the cursor's (ts, key) tuple uniquely positions.
  const params: unknown[] = [tenantId, slug];
  let where = `d.tenant_id = $1 AND cv.tenant_id = $1 AND cv.dim_id = $2 AND cv.retired_at IS NULL`;
  if (sinceTs) {
    params.push(sinceTs);
    where += ` AND cv.updated_at >= $${params.length}`;
  }
  if (sinceTs && sinceKey) {
    params.push(sinceKey);
    where += ` AND (cv.updated_at, d.${keyCol}) > ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1); // +1 to detect "has next page"

  const sql = `
    SELECT d.${keyCol} AS key,
           d.label,
           ${fieldsJsonExpr} AS fields,
           cv.updated_at::text AS updated_at,
           cv.version
      FROM ${cq(dim.dim_table)} d
      JOIN "zugzug_app"."canonical_version" cv
        ON cv.dim_id = $2 AND cv.tenant_id = $1 AND cv.key = d.${keyCol}
     WHERE ${where}
     ORDER BY cv.updated_at ASC, d.${keyCol} ASC
     LIMIT $${params.length}
  `;

  const rows = await pgAll<{
    key: string;
    label: string;
    fields: Record<string, unknown>;
    updated_at: string;
    version: number;
  }>(sql, params);

  let next: string | null = null;
  if (rows.length > limit) {
    rows.pop(); // discard the look-ahead row
    const tail = rows[rows.length - 1]!;
    const payload: CursorPayload = { t: tenantId, u: tail.updated_at, k: tail.key, v: 1 };
    next = signCursor(payload, getCursorKey());
  }

  return {
    records: rows.map((r) => ({
      key: r.key,
      label: r.label,
      fields: r.fields ?? {},
      updated_at: r.updated_at,
      version: r.version,
    })),
    cursor: { next },
    meta: { dim_slug: slug, page_size: limit },
  };
}

/* ---------- single canonical row ---------- */

export async function getCanonicalRow(
  tenantId: string,
  slug: string,
  key: string,
): Promise<CanonicalRecord | null> {
  const dim = await pgGet<{ dim_table: string; key_col: string }>(
    `SELECT dim_table, key_col FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [slug, tenantId],
  );
  if (!dim) return null;
  const keyCol = qid(dim.key_col);
  const dimCols = await pgAll<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'zugzug_app' AND table_name = $1
        AND column_name NOT IN ('label', 'position', 'tenant_id')`,
    [dim.dim_table.replace(/^.*\./, "")],
  );
  const fieldColumns = dimCols.map((c) => c.column_name).filter((c) => c !== dim.key_col);
  const fieldsJsonExpr = fieldColumns.length
    ? `jsonb_build_object(${fieldColumns
        .map((c) => `'${c.replace(/'/g, "''")}', d.${qid(c)}`)
        .join(",")})`
    : `'{}'::jsonb`;

  const row = await pgGet<{
    key: string;
    label: string;
    fields: Record<string, unknown>;
    updated_at: string;
    version: number;
  }>(
    `SELECT d.${keyCol} AS key,
            d.label,
            ${fieldsJsonExpr} AS fields,
            cv.updated_at::text AS updated_at,
            cv.version
       FROM ${cq(dim.dim_table)} d
       JOIN "zugzug_app"."canonical_version" cv
         ON cv.dim_id = $1 AND cv.tenant_id = $2 AND cv.key = d.${keyCol}
      WHERE d.tenant_id = $2
        AND d.${keyCol} = $3
        AND cv.retired_at IS NULL`,
    [slug, tenantId, key],
  );
  if (!row) return null;
  return {
    key: row.key,
    label: row.label,
    fields: row.fields ?? {},
    updated_at: row.updated_at,
    version: row.version,
  };
}

/* ---------- tombstones page ---------- */

export async function listTombstonesPage(
  tenantId: string,
  slug: string,
  opts: PageOpts,
): Promise<TombstonePageResponse> {
  const limit = clampLimit(opts.limit, DEFAULT_LIMIT_TOMBSTONES, MAX_LIMIT_TOMBSTONES);

  let sinceTs: string | null = opts.since ?? null;
  let sinceKey: string | null = null;
  if (opts.cursor) {
    const v = verifyCursor(opts.cursor, getCursorKey(), tenantId);
    if (!v.ok) throw new Error(v.reason);
    sinceTs = v.payload.u;
    sinceKey = v.payload.k;
  }

  const params: unknown[] = [tenantId, slug];
  let where = `tenant_id = $1 AND dim_id = $2 AND retired_at IS NOT NULL`;
  if (sinceTs) {
    params.push(sinceTs);
    where += ` AND retired_at >= $${params.length}`;
  }
  if (sinceTs && sinceKey) {
    params.push(sinceKey);
    where += ` AND (retired_at, key) > ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);

  const rows = await pgAll<{ key: string; retired_at: string; retired_into: string | null }>(
    `SELECT key, retired_at::text, retired_into
       FROM ${pg("canonical_version")}
      WHERE ${where}
      ORDER BY retired_at ASC, key ASC
      LIMIT $${params.length}`,
    params,
  );

  let next: string | null = null;
  if (rows.length > limit) {
    rows.pop();
    const tail = rows[rows.length - 1]!;
    next = signCursor({ t: tenantId, u: tail.retired_at, k: tail.key, v: 1 }, getCursorKey());
  }

  return {
    tombstones: rows.map((r) => ({
      key: r.key,
      retired_at: r.retired_at,
      retired_into: r.retired_into,
    })),
    cursor: { next },
  };
}

/* ---------- events ---------- */

export interface EventRecord {
  id: string;
  type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface EventPageResponse {
  events: EventRecord[];
  cursor: { next: string | null };
}

export interface EventPageOpts extends PageOpts {
  type?: string; // dimension.committed | …
}

const DEFAULT_LIMIT_EVENTS = 50;
const MAX_LIMIT_EVENTS = 200;

export async function listEventsPage(
  tenantId: string,
  opts: EventPageOpts,
): Promise<EventPageResponse> {
  const limit = clampLimit(opts.limit, DEFAULT_LIMIT_EVENTS, MAX_LIMIT_EVENTS);

  let sinceTs: string | null = opts.since ?? null;
  let sinceId: string | null = null;
  if (opts.cursor) {
    const v = verifyCursor(opts.cursor, getCursorKey(), tenantId);
    if (!v.ok) throw new Error(v.reason);
    sinceTs = v.payload.u;
    sinceId = v.payload.k;
  }

  const params: unknown[] = [tenantId];
  let where = `tenant_id = $1`;
  if (opts.type) {
    params.push(opts.type);
    where += ` AND type = $${params.length}`;
  }
  if (sinceTs) {
    params.push(sinceTs);
    where += ` AND occurred_at >= $${params.length}`;
  }
  if (sinceTs && sinceId) {
    params.push(sinceId);
    where += ` AND (occurred_at, id) > ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);

  const rows = await pgAll<{ id: string; type: string; occurred_at: string; payload: Record<string, unknown> }>(
    `SELECT id, type, occurred_at::text, payload
       FROM ${pg("outbound_event")}
      WHERE ${where}
      ORDER BY occurred_at ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );

  let next: string | null = null;
  if (rows.length > limit) {
    rows.pop();
    const tail = rows[rows.length - 1]!;
    next = signCursor({ t: tenantId, u: tail.occurred_at, k: tail.id, v: 1 }, getCursorKey());
  }

  return {
    events: rows.map((r) => ({
      id: r.id,
      type: r.type,
      occurred_at: r.occurred_at,
      data: r.payload,
    })),
    cursor: { next },
  };
}
```

Notes on the implementation:

- The `fieldsJsonExpr` dynamic-column projection reads `information_schema.columns` to discover the dim_<slug> table's columns. This is one extra query per page but keeps the helper from drifting when fields are added/removed. If perf matters later, this can be cached.
- `cq` and `qid` are imported from `repo-shared.ts` — they're the codebase's existing quoting helpers (verify with `grep -n "export.*qid\|export.*cq" server/src/repo-shared.ts`).
- The cursor's `(ts, key)` tuple comparison handles the "two records updated in the same millisecond" edge case cleanly.
- The `since` lower bound is INCLUSIVE per design §5.2; without a cursor, the first page starts with everything `updated_at >= since`. With a cursor, the strict tuple compare handles duplicates.

### Step 3: Set ZUGZUG_CURSOR_KEY for tests

The repo helpers call `getCursorKey()`. Tests need it set. Add to `server/package.json`'s `test` script env block (which currently has DATABASE_URL/ATTACH_WAREHOUSE/MOTHERDUCK_TOKEN/GOOGLE_*) the line:

`ZUGZUG_CURSOR_KEY=` followed by a base64-encoded 32 bytes — generate once and hardcode:

```bash
python3 -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"
```

(Or any equivalent — Bun's `Bun.crypto` if Python isn't around.) Put the value in the test script verbatim.

### Step 4: Run, confirm PASS

```bash
cd server && bun test src/repo-outbound.test.ts
```
Expected: all tests pass.

### Step 5: Regression check

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_after_task8.txt
diff /tmp/zugzug_pr2_baseline.txt /tmp/zugzug_pr2_after_task8.txt
```
Expected: empty diff.

### Step 6: Commit

```bash
git add server/src/repo-outbound.ts server/src/repo-outbound.test.ts server/package.json
git commit -m "$(cat <<'EOF'
feat(server): repo-outbound — Pull API-shaped query helpers

Dedicated module for the Pull API's wire-shape concerns:
listDimensionsForApi (snake_case + canonical_count + last_committed_at),
getSchemaForApi (fields with type + description), listCanonicalPage
(cursor + ?since + soft-delete filter + dynamic field projection from
information_schema), getCanonicalRow (single-row variant), listTombstonesPage
(retired rows), listEventsPage (outbound_event read for replay).

All cursors are HMAC-signed (PR1's cursor.ts) and tenant-bound (cursor
from one workspace returns cursor_mismatch in another).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Rate-limit middleware (`server/src/rate-limit.ts`)

**Files:**
- Create: `server/src/rate-limit.ts`.
- Test: `server/src/rate-limit.test.ts`.

Token-bucket per credential id (SA id OR `api_tokens.id`). v1 ships a fixed-window-per-minute counter (simpler than rolling) backed by `auth_credential_quota`. Configurable budget via `ZUGZUG_PULL_API_RPM` (default 600 for reads, 60 for control plane; we expose two thresholds and the caller picks).

The implementation strategy: an UPSERT-style query that atomically increments the count and returns the new value, plus a window-rollover detection (if the persisted `window_started_at` is more than 60s old, reset). Atomic per-credential.

### Step 1: Write the failing test FIRST

Create `server/src/rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { pgRun } from "./pg.ts";
import { checkRateLimit } from "./rate-limit.ts";

const CRED = "sa_test_rate_limit";

beforeAll(async () => {
  await pgRun(
    `DELETE FROM "zugzug_app"."auth_credential_quota" WHERE credential_id = $1`,
    [CRED],
  ).catch(() => {});
});

beforeEach(async () => {
  await pgRun(
    `DELETE FROM "zugzug_app"."auth_credential_quota" WHERE credential_id = $1`,
    [CRED],
  );
});

afterAll(async () => {
  await pgRun(
    `DELETE FROM "zugzug_app"."auth_credential_quota" WHERE credential_id = $1`,
    [CRED],
  );
});

describe("checkRateLimit — fixed-window counter", () => {
  it("first request within budget returns ok", async () => {
    const r = await checkRateLimit(CRED, 5);
    expect(r.ok).toBe(true);
  });

  it("budget-th request still ok, budget+1 returns 429 with retryAfter", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(CRED, 5);
      expect(r.ok).toBe(true);
    }
    const r6 = await checkRateLimit(CRED, 5);
    expect(r6.ok).toBe(false);
    if (!r6.ok) {
      expect(r6.retryAfterSeconds).toBeGreaterThan(0);
      expect(r6.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("budget of 0 disables the limiter", async () => {
    for (let i = 0; i < 100; i++) {
      const r = await checkRateLimit(CRED, 0);
      expect(r.ok).toBe(true);
    }
  });

  it("window rolls over when persisted window_started_at is >60s old", async () => {
    await checkRateLimit(CRED, 1); // count=1, fills the budget
    expect((await checkRateLimit(CRED, 1)).ok).toBe(false);
    // Rewind the window to 65s ago.
    await pgRun(
      `UPDATE "zugzug_app"."auth_credential_quota"
          SET window_started_at = now() - interval '65 seconds'
        WHERE credential_id = $1`,
      [CRED],
    );
    const r = await checkRateLimit(CRED, 1);
    expect(r.ok).toBe(true); // window rolled, count reset
  });
});
```

Run: `bun test src/rate-limit.test.ts` — FAIL (module missing).

### Step 2: Write the implementation

Create `server/src/rate-limit.ts`:

```ts
/* rate-limit.ts — per-credential fixed-window rate limiter.

   Budget is the maximum number of requests allowed per 1-minute window.
   Budget 0 disables the limiter entirely (caller passes 0 when
   ZUGZUG_PULL_API_RPM=0). The counter is persisted in
   auth_credential_quota so a server restart mid-minute doesn't reset
   it. Per-credential UPSERT is atomic — concurrent requests from the
   same credential race-safely. */

import { pg } from "./env.ts";
import { pgGet } from "./pg.ts";

const WINDOW_SECONDS = 60;

export type RateLimitResult =
  | { ok: true; count: number; budget: number }
  | { ok: false; retryAfterSeconds: number; budget: number };

/** Atomically increment the count for `credentialId` within the current
 *  1-minute window. If the persisted window is older than WINDOW_SECONDS
 *  the row is rolled (window_started_at = now(), count = 1). When the
 *  budget is 0, this is a no-op that always returns ok. */
export async function checkRateLimit(
  credentialId: string,
  budget: number,
): Promise<RateLimitResult> {
  if (budget <= 0) return { ok: true, count: 0, budget: 0 };

  // UPSERT that rolls the window if needed. The CTE pattern: try INSERT;
  // on conflict, either roll-and-set-to-1 or increment.
  const row = await pgGet<{ count: number; window_age_seconds: number }>(
    `INSERT INTO ${pg("auth_credential_quota")}
       (credential_id, window_started_at, count)
       VALUES ($1, now(), 1)
       ON CONFLICT (credential_id) DO UPDATE
         SET window_started_at = CASE
               WHEN ${pg("auth_credential_quota")}.window_started_at < now() - interval '${WINDOW_SECONDS} seconds'
               THEN now()
               ELSE ${pg("auth_credential_quota")}.window_started_at
             END,
             count = CASE
               WHEN ${pg("auth_credential_quota")}.window_started_at < now() - interval '${WINDOW_SECONDS} seconds'
               THEN 1
               ELSE ${pg("auth_credential_quota")}.count + 1
             END
       RETURNING count, extract(epoch FROM (now() - window_started_at))::int AS window_age_seconds`,
    [credentialId],
  );

  if (!row) {
    // Shouldn't happen; INSERT … ON CONFLICT … RETURNING always returns.
    return { ok: true, count: 0, budget };
  }

  if (row.count <= budget) {
    return { ok: true, count: row.count, budget };
  }
  const retryAfter = Math.max(1, WINDOW_SECONDS - row.window_age_seconds);
  return { ok: false, retryAfterSeconds: retryAfter, budget };
}
```

Note: the SQL uses `${pg("auth_credential_quota")}` substitution. Postgres requires the same expression on both sides; the helper substitutes `"zugzug_app"."auth_credential_quota"` twice. This is fine.

### Step 3: Run, confirm PASS

```bash
cd server && bun test src/rate-limit.test.ts
```
Expected: all tests pass.

### Step 4: Regression + commit

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_after_task9.txt
diff /tmp/zugzug_pr2_baseline.txt /tmp/zugzug_pr2_after_task9.txt
```
Expected: empty diff.

```bash
git add server/src/rate-limit.ts server/src/rate-limit.test.ts
git commit -m "$(cat <<'EOF'
feat(server): per-credential fixed-window rate limiter

checkRateLimit(credId, budget) atomically upserts into auth_credential_quota,
rolls the 1-minute window when stale, returns {ok, retryAfterSeconds}.
Budget 0 disables (operator can set ZUGZUG_PULL_API_RPM=0). Persisted
counter survives server restarts; per-credential UPSERT is race-safe
under concurrent requests from the same token.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Slug-redirect alias (`server/src/slug-alias.ts`)

**Files:**
- Create: `server/src/slug-alias.ts`.
- Test: `server/src/slug-alias.test.ts`.

When a workspace slug is renamed, the old slug's URL stops working — every integration (dbt URL, Fivetran connector, CI job) breaks. The design (§8) calls for a 30-day grace window: requests to `/api/t/<old-slug>/v1/...` return `301 Moved Permanently` with a `Location` header pointing at the new slug.

This task ships the **lookup helper** only; the actual `301` happens in Task 11's `v1-routes.ts` dispatcher. The hook into the slug-rename flow (writing to `tenant_slug_alias`) is a separate task (Task 12).

### Step 1: Test FIRST

Create `server/src/slug-alias.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun } from "./pg.ts";
import { lookupAliasedSlug, recordSlugAlias } from "./slug-alias.ts";

const T = "test_slug_alias_tenant";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, 'slug_after', 'Aliased', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."tenant_slug_alias" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("recordSlugAlias + lookupAliasedSlug", () => {
  it("records an alias with 30-day expiry by default", async () => {
    await recordSlugAlias("old_slug_a", T);
    const found = await lookupAliasedSlug("old_slug_a");
    expect(found).not.toBeNull();
    expect(found!.currentSlug).toBe("slug_after");
    expect(found!.tenantId).toBe(T);
  });

  it("returns null for unknown old slugs", async () => {
    expect(await lookupAliasedSlug("never_was_a_slug")).toBeNull();
  });

  it("returns null when the alias is expired", async () => {
    await recordSlugAlias("old_slug_b", T);
    await pgRun(
      `UPDATE "zugzug_app"."tenant_slug_alias"
          SET expires_at = now() - interval '1 hour'
        WHERE old_slug = $1`,
      ["old_slug_b"],
    );
    expect(await lookupAliasedSlug("old_slug_b")).toBeNull();
  });

  it("upsert: recording the same old_slug twice updates expires_at, doesn't error", async () => {
    await recordSlugAlias("old_slug_c", T);
    await recordSlugAlias("old_slug_c", T);
    const found = await lookupAliasedSlug("old_slug_c");
    expect(found).not.toBeNull();
  });
});
```

Run: `bun test src/slug-alias.test.ts` — expect FAIL (module missing).

### Step 2: Implementation

Create `server/src/slug-alias.ts`:

```ts
/* slug-alias.ts — 30-day stale-slug redirect for renamed workspaces.

   When an admin renames a tenant's slug, the rename flow calls
   recordSlugAlias(oldSlug, tenantId) BEFORE updating the tenant.slug
   value. For 30 days afterward, requests to /api/t/<old-slug>/v1/...
   resolve via lookupAliasedSlug and the v1 dispatcher returns 301 with
   the new slug in Location.

   Aliases are time-bounded (default 30 days) so stale URLs eventually
   404; the outboundRetentionSweepJob in PR3 will physically drop
   expired rows. Until then, lookupAliasedSlug filters expired rows. */

import { pg } from "./env.ts";
import { pgRun, pgGet } from "./pg.ts";

const ALIAS_DAYS = 30;

export interface AliasedSlug {
  currentSlug: string;
  tenantId: string;
}

/** Persists oldSlug → tenantId mapping. Idempotent: re-recording the same
 *  old_slug pushes its expires_at forward (matches admin intent "extend the
 *  grace window if I rename again"). */
export async function recordSlugAlias(oldSlug: string, tenantId: string): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("tenant_slug_alias")}
       (old_slug, tenant_id, created_at, expires_at)
       VALUES ($1, $2, now(), now() + interval '${ALIAS_DAYS} days')
     ON CONFLICT (old_slug) DO UPDATE
       SET tenant_id  = EXCLUDED.tenant_id,
           expires_at = EXCLUDED.expires_at`,
    [oldSlug, tenantId],
  );
}

export async function lookupAliasedSlug(oldSlug: string): Promise<AliasedSlug | null> {
  const row = await pgGet<{ tenant_id: string; current_slug: string }>(
    `SELECT a.tenant_id, t.slug AS current_slug
       FROM ${pg("tenant_slug_alias")} a
       JOIN ${pg("tenant")} t ON t.id = a.tenant_id AND t.deleted_at IS NULL
      WHERE a.old_slug = $1
        AND a.expires_at > now()`,
    [oldSlug],
  );
  if (!row) return null;
  return { currentSlug: row.current_slug, tenantId: row.tenant_id };
}
```

### Step 3: Run, confirm PASS

```bash
cd server && bun test src/slug-alias.test.ts
```
Expected: all tests pass.

### Step 4: Regression + commit

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_after_task10.txt
diff /tmp/zugzug_pr2_baseline.txt /tmp/zugzug_pr2_after_task10.txt
```
Expected: empty diff.

```bash
git add server/src/slug-alias.ts server/src/slug-alias.test.ts
git commit -m "$(cat <<'EOF'
feat(server): 30-day stale-slug redirect helpers

recordSlugAlias persists old_slug → tenant_id with a 30-day expiry;
lookupAliasedSlug returns the current slug for routing. Upsert so
re-renaming extends the grace window. v1-routes.ts will consume this
to emit 301 Moved Permanently.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `v1-routes.ts` — dispatch + 6 Pull API endpoints + 3 service-account endpoints

**Files:**
- Create: `server/src/v1-routes.ts`.
- Test: `server/src/v1-routes.test.ts`.
- Modify: `server/src/server.ts` — insert dispatch hook BEFORE the existing top-level routes.

This is the largest single task. Strategy: write each endpoint with one descriptive test (full round-trip from `new Request(...)` through the handler), then implement the handler. Group tests by route family for legibility.

### Step 1: Test scaffolding

Create `server/src/v1-routes.test.ts`. Set up a tenant + SA + admin user once, then exercise each route:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "./pg.ts";
import { handleV1Route } from "./v1-routes.ts";
import { addDimension, addCanonical } from "./repo-canonical.ts";
import { createServiceAccount } from "./repo-service-accounts.ts";

const T = "test_v1_routes";
const SLUG = "v1routes";
const ADMIN = "u_v1_admin";

let dim: Awaited<ReturnType<typeof addDimension>>;
let saToken: string;

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $2, 'V1 Routes', 'default', now()) ON CONFLICT DO NOTHING`,
    [T, SLUG],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'V1 Admin', 'v1@example.test', 'V1', false)
     ON CONFLICT DO NOTHING`,
    [ADMIN],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, 'admin', now()) ON CONFLICT DO NOTHING`,
    [T, ADMIN],
  );

  dim = await addDimension("V1Country", [], { keyKind: "slug" }, ADMIN, T);
  await addCanonical(dim.id, [
    { key: "DE", label: "Germany" },
    { key: "US", label: "United States" },
  ], T);

  const created = await createServiceAccount({ tenantId: T, name: "v1-test", createdBy: ADMIN });
  saToken = created.value;
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [ADMIN]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

function authedReq(path: string, init: RequestInit = {}): Request {
  return new Request(`http://test${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${saToken}`,
    },
  });
}

describe("GET /api/t/:slug/v1/dimensions", () => {
  it("returns the workspace's dimensions in API wire shape", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions`));
    expect(res!.status).toBe(200);
    const body = await res!.json() as { dimensions: Array<{ slug: string; label: string; canonical_count: number }> };
    expect(body.dimensions.find((d) => d.slug === dim.id)?.label).toBe("V1Country");
  });
});

describe("GET /api/t/:slug/v1/dimensions/:slug/canonical", () => {
  it("returns 200 with paginated records", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions/${dim.id}/canonical?limit=1`));
    expect(res!.status).toBe(200);
    const body = await res!.json() as { records: unknown[]; cursor: { next: string | null }; meta: { dim_slug: string } };
    expect(body.records.length).toBe(1);
    expect(body.cursor.next).not.toBeNull();
    expect(body.meta.dim_slug).toBe(dim.id);
  });

  it("cursor round-trip returns the next page without duplicates", async () => {
    const r1 = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions/${dim.id}/canonical?limit=1`));
    const b1 = await r1!.json() as { records: { key: string }[]; cursor: { next: string } };
    const r2 = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions/${dim.id}/canonical?limit=1&cursor=${encodeURIComponent(b1.cursor.next)}`));
    const b2 = await r2!.json() as { records: { key: string }[]; cursor: { next: string | null } };
    expect(b2.records.length).toBe(1);
    expect(b2.records[0]!.key).not.toBe(b1.records[0]!.key);
  });

  it("returns 400 cursor_invalid for a tampered cursor", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions/${dim.id}/canonical?cursor=garbage.xx`));
    expect(res!.status).toBe(400);
    const body = await res!.json() as { error: string };
    expect(body.error).toBe("cursor_invalid");
  });
});

describe("GET /api/t/:slug/v1/dimensions/:slug/canonical/:key", () => {
  it("returns the row", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions/${dim.id}/canonical/DE`));
    expect(res!.status).toBe(200);
    const body = await res!.json() as { key: string; label: string };
    expect(body.key).toBe("DE");
    expect(body.label).toBe("Germany");
  });

  it("returns 404 for an unknown key", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions/${dim.id}/canonical/NOPE`));
    expect(res!.status).toBe(404);
  });
});

describe("GET /api/t/:slug/v1/dimensions/:slug/schema", () => {
  it("returns dim_slug + fields", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions/${dim.id}/schema`));
    expect(res!.status).toBe(200);
    const body = await res!.json() as { dim_slug: string; label: string; fields: unknown[] };
    expect(body.dim_slug).toBe(dim.id);
  });
});

describe("GET /api/t/:slug/v1/dimensions/:slug/tombstones", () => {
  it("returns 200 with an array (possibly empty)", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions/${dim.id}/tombstones`));
    expect(res!.status).toBe(200);
    const body = await res!.json() as { tombstones: unknown[] };
    expect(Array.isArray(body.tombstones)).toBe(true);
  });
});

describe("GET /api/t/:slug/v1/events", () => {
  it("returns 200 with empty events (PR3 writes them)", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/events`));
    expect(res!.status).toBe(200);
    const body = await res!.json() as { events: unknown[] };
    expect(body.events).toEqual([]);
  });
});

describe("GET /api/t/:slug/v1/service-accounts (admin only)", () => {
  it("SA-authenticated request returns 403 (admin only)", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/service-accounts`));
    expect(res!.status).toBe(403);
  });
});

describe("auth rejection — missing bearer", () => {
  it("returns 401", async () => {
    const res = await handleV1Route(new Request(`http://test/api/t/${SLUG}/v1/dimensions`));
    expect(res!.status).toBe(401);
  });
});

describe("tenant mismatch — SA from a different workspace", () => {
  it("returns 403 with TENANT_MISMATCH", async () => {
    const OT = "test_v1_other";
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
       VALUES ($1, $1, 'Other', 'default', now()) ON CONFLICT DO NOTHING`,
      [OT],
    );
    const { value } = await createServiceAccount({ tenantId: OT, name: "other-tenant-sa", createdBy: ADMIN });
    const req = new Request(`http://test/api/t/${SLUG}/v1/dimensions`, {
      headers: { authorization: `Bearer ${value}` },
    });
    const res = await handleV1Route(req);
    expect(res!.status).toBe(403);

    await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [OT]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [OT]);
  });
});

describe("slug-redirect alias", () => {
  it("returns 301 with Location for an aliased old slug", async () => {
    const { recordSlugAlias } = await import("./slug-alias.ts");
    await recordSlugAlias("v1routes_old", T);
    const req = new Request(`http://test/api/t/v1routes_old/v1/dimensions`, {
      headers: { authorization: `Bearer ${saToken}` },
    });
    const res = await handleV1Route(req);
    expect(res!.status).toBe(301);
    expect(res!.headers.get("location")).toBe(`/api/t/${SLUG}/v1/dimensions`);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_slug_alias" WHERE old_slug = $1`, ["v1routes_old"]);
  });
});
```

Run: `bun test src/v1-routes.test.ts` — expect FAIL (module missing).

### Step 2: Write the dispatcher

Create `server/src/v1-routes.ts`:

```ts
/* v1-routes.ts — dispatch for /api/t/:slug/v1/... 

   Composes:
     - authenticateBearer (auth-api-tokens.ts) — bearer-only on /v1/.
     - lookupAliasedSlug (slug-alias.ts) — 301 to current slug if applicable.
     - resolveTenantContext (tenant-middleware.ts) — SA-aware tenant binding.
     - checkRateLimit (rate-limit.ts) — per-credential budget.
     - repo-outbound.ts query helpers — wire-shape data fetches.
     - repo-service-accounts.ts CRUD helpers — admin-only mutations.

   Returns Response | null. Null means "not a /v1/ route — let the caller
   keep dispatching". */

import { authenticateBearer, type ServiceAccountCtx } from "./auth-api-tokens.ts";
import { lookupAliasedSlug } from "./slug-alias.ts";
import { resolveTenantContext } from "./tenant-middleware.ts";
import { checkRateLimit } from "./rate-limit.ts";
import { env } from "./env.ts";
import {
  listDimensionsForApi,
  getSchemaForApi,
  listCanonicalPage,
  getCanonicalRow,
  listTombstonesPage,
  listEventsPage,
} from "./repo-outbound.ts";
import {
  createServiceAccount,
  listServiceAccounts,
  revokeServiceAccount,
} from "./repo-service-accounts.ts";

const V1_PREFIX = /^\/api\/t\/([^/]+)\/v1(?:\/.*)?$/;

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function jsonError(status: number, error: string, retryAfter?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
  return new Response(JSON.stringify({ error, ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}) }), {
    status,
    headers,
  });
}

/** Returns Response if this is a /v1/ route (handled or rejected),
 *  null if the request is not under /api/t/:slug/v1/. */
export async function handleV1Route(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const m = V1_PREFIX.exec(url.pathname);
  if (!m) return null;
  const slugInPath = m[1]!;

  // Alias redirect — BEFORE auth so we don't burn quota on stale URLs.
  // Only redirect if NO live tenant exists for slugInPath today (otherwise
  // a slug pair that collides with a still-active tenant short-circuits;
  // unlikely in practice but safe to filter).
  const alias = await lookupAliasedSlug(slugInPath);
  if (alias && alias.currentSlug !== slugInPath) {
    const newPath = url.pathname.replace(`/api/t/${slugInPath}/`, `/api/t/${alias.currentSlug}/`);
    return new Response(null, {
      status: 301,
      headers: { location: newPath + url.search },
    });
  }

  // Auth.
  const authed = await authenticateBearer(req);
  if (!authed) return jsonError(401, "unauthorized");

  // Rate limit (per credential id). Credential id = SA id if present,
  // else api_tokens-derived user id surrogate. For simplicity we use
  // `sa:<saId>` for SA and `usr:<userId>` for personal.
  const credentialId = authed.serviceAccount
    ? `sa:${authed.serviceAccount.id}`
    : `usr:${authed.user.id}`;
  const budget = env.pullApiRpm ?? 600;
  const rate = await checkRateLimit(credentialId, budget);
  if (!rate.ok) return jsonError(429, "rate_limited", rate.retryAfterSeconds);

  // Tenant context (resolves SA tenant binding + role).
  let tenantCtx;
  try {
    tenantCtx = await resolveTenantContext({
      pathname: url.pathname,
      user: authed.user,
      isSuperAdmin: authed.user.isSuperAdmin,
      serviceAccount: authed.serviceAccount,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "TENANT_NOT_FOUND") return jsonError(404, "tenant_not_found");
    if (code === "TENANT_MISMATCH") return jsonError(403, "tenant_mismatch");
    return jsonError(500, "internal_error");
  }

  // Dispatch on path segments AFTER /v1/.
  const seg = url.pathname.split("/").filter(Boolean); // ["api","t",slug,"v1",...]
  const v1 = seg.slice(4); // segments after "v1"
  return await dispatch(req, url, v1, tenantCtx, authed.serviceAccount);
}

async function dispatch(
  req: Request,
  url: URL,
  v1: string[],
  ctx: { tenantId: string; role: "admin" | "editor" | "viewer"; isSuperAdmin: boolean },
  sa: ServiceAccountCtx | undefined,
): Promise<Response> {
  void sa;
  const method = req.method;

  // /v1/dimensions
  if (v1[0] === "dimensions" && v1.length === 1 && method === "GET") {
    return json(await listDimensionsForApi(ctx.tenantId));
  }

  // /v1/dimensions/:slug/schema
  if (v1[0] === "dimensions" && v1[2] === "schema" && v1.length === 3 && method === "GET") {
    const dimSlug = decodeURIComponent(v1[1]!);
    const out = await getSchemaForApi(ctx.tenantId, dimSlug);
    if (!out) return jsonError(404, "dimension_not_found");
    return json(out);
  }

  // /v1/dimensions/:slug/canonical
  if (v1[0] === "dimensions" && v1[2] === "canonical" && v1.length === 3 && method === "GET") {
    const dimSlug = decodeURIComponent(v1[1]!);
    const since = url.searchParams.get("since") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "");
    try {
      const out = await listCanonicalPage(ctx.tenantId, dimSlug, {
        since,
        cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return json(out);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "cursor_invalid" || msg === "cursor_mismatch") return jsonError(400, msg);
      throw e;
    }
  }

  // /v1/dimensions/:slug/canonical/:key
  if (v1[0] === "dimensions" && v1[2] === "canonical" && v1.length === 4 && method === "GET") {
    const dimSlug = decodeURIComponent(v1[1]!);
    const key = decodeURIComponent(v1[3]!);
    const out = await getCanonicalRow(ctx.tenantId, dimSlug, key);
    if (!out) return jsonError(404, "not_found");
    return json(out);
  }

  // /v1/dimensions/:slug/tombstones
  if (v1[0] === "dimensions" && v1[2] === "tombstones" && v1.length === 3 && method === "GET") {
    const dimSlug = decodeURIComponent(v1[1]!);
    const since = url.searchParams.get("since") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "");
    try {
      const out = await listTombstonesPage(ctx.tenantId, dimSlug, {
        since,
        cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return json(out);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "cursor_invalid" || msg === "cursor_mismatch") return jsonError(400, msg);
      throw e;
    }
  }

  // /v1/events
  if (v1[0] === "events" && v1.length === 1 && method === "GET") {
    const type = url.searchParams.get("type") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "");
    try {
      const out = await listEventsPage(ctx.tenantId, {
        type,
        since,
        cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return json(out);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "cursor_invalid" || msg === "cursor_mismatch") return jsonError(400, msg);
      throw e;
    }
  }

  // /v1/service-accounts (admin only)
  if (v1[0] === "service-accounts") {
    if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
    if (v1.length === 1 && method === "GET") {
      const list = await listServiceAccounts(ctx.tenantId);
      return json({ service_accounts: list });
    }
    if (v1.length === 1 && method === "POST") {
      let body: { name?: string; expires_at?: string | null };
      try {
        body = (await req.json()) as { name?: string; expires_at?: string | null };
      } catch {
        return jsonError(400, "invalid_json");
      }
      const name = (body.name ?? "").trim();
      if (!name) return jsonError(400, "name_required");
      const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
      const created = await createServiceAccount({
        tenantId: ctx.tenantId,
        name,
        createdBy: ctx.isSuperAdmin && sa ? "u_system" : "u_unknown", // see note below
        expiresAt,
      });
      // value shown once.
      return json({ id: created.id, name, value: created.value, scopes: ["read"] }, 201);
    }
    if (v1.length === 2 && method === "DELETE") {
      const ok = await revokeServiceAccount(ctx.tenantId, decodeURIComponent(v1[1]!));
      if (!ok) return jsonError(404, "not_found");
      return new Response(null, { status: 204 });
    }
  }

  return jsonError(404, "route_not_found");
}
```

Note on `createdBy`: the route handler doesn't have a direct user-id passed in for cookie/personal-token authenticated requests. In a real handler, we'd thread the `authed.user.id` through `dispatch`. Adjust the function signature: change `dispatch(req, url, v1, ctx, sa, userId: string)` and have `handleV1Route` pass `authed.user.id` as that argument. Use that as `createdBy`.

### Step 3: Wire `env.pullApiRpm`

Add to `server/src/env.ts` after the existing entries:

```ts
  /** Per-credential rate-limit budget for the /v1/ surface. Default 600
   *  req/min; set to 0 to disable. */
  pullApiRpm: process.env.ZUGZUG_PULL_API_RPM
    ? Number(process.env.ZUGZUG_PULL_API_RPM)
    : 600,
```

### Step 4: Wire into `server.ts`

Open `server/src/server.ts`. Find the top of the `fetch` handler (around line 100-110, after `pathname` is computed). Insert BEFORE the existing route dispatch:

```ts
// PR2: /api/t/:slug/v1/... dispatch
const { handleV1Route } = await import("./v1-routes.ts");
const v1Response = await handleV1Route(req);
if (v1Response) return v1Response;
```

The dynamic import matches the pattern used elsewhere in `server.ts` (e.g. `const { getApiTokenUser } = await import(...)`).

### Step 5: Run, iterate

```bash
cd server && bun test src/v1-routes.test.ts
```
Iterate on whichever assertions fail. Common gotchas:
- The `createServiceAccount` synthetic-user `createdBy` needs `ADMIN` to satisfy any FK constraints.
- The slug-redirect alias test seeds `recordSlugAlias` THEN issues the request — make sure `recordSlugAlias` was awaited.
- The cursor-round-trip test needs `ZUGZUG_CURSOR_KEY` set (done in Task 8).
- The SA-from-another-tenant test needs the other tenant's tenant row to actually exist before the SA is created.

### Step 6: Regression check

```bash
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr2_after_task11.txt
diff /tmp/zugzug_pr2_baseline.txt /tmp/zugzug_pr2_after_task11.txt
```
Expected: empty diff.

### Step 7: Commit

```bash
git add server/src/v1-routes.ts server/src/v1-routes.test.ts server/src/server.ts server/src/env.ts
git commit -m "$(cat <<'EOF'
feat(server): /api/t/:slug/v1 Pull API dispatch + service-account CRUD

handleV1Route composes auth + alias redirect + rate limit + tenant
binding + repo-outbound query helpers + repo-service-accounts CRUD.
Routes:
  GET    /v1/dimensions
  GET    /v1/dimensions/:slug/schema
  GET    /v1/dimensions/:slug/canonical            (paginated)
  GET    /v1/dimensions/:slug/canonical/:key
  GET    /v1/dimensions/:slug/tombstones           (paginated)
  GET    /v1/events                                (paginated)
  GET    /v1/service-accounts                      (admin only)
  POST   /v1/service-accounts                      (admin only, value shown once)
  DELETE /v1/service-accounts/:id                  (admin only)

server.ts dispatches /v1/ via handleV1Route before its existing routes.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Hook `recordSlugAlias` into the slug-rename flow

**Files:**
- Modify: the existing tenant-slug-rename handler in `server/src/server.ts` (find with `grep -n "rename\|slug" server/src/server.ts | head -20`).

The redirect alias is useless if nothing writes to `tenant_slug_alias`. Whenever an admin renames a workspace slug, the new tenant.slug must be persisted AND the old slug recorded.

### Step 1: Find the rename flow

```bash
grep -n "UPDATE.*tenant.*SET.*slug\|/tenant/.*slug\|renameSlug\|updateSlug" server/src/server.ts server/src/tenant.ts server/src/repo-meta.ts
```

The rename probably lives in `tenant.ts` or as an inline PATCH in `server.ts`. Read the existing handler.

### Step 2: Hook in

Just before the `UPDATE tenant SET slug = ...` (or equivalent), call `recordSlugAlias(oldSlug, tenantId)`. Wrap in the same transaction if there is one (use `pgTx` if the rename already uses it; if not, fire the alias write first so a UPDATE failure leaves us with an alias pointing at a slug that didn't change — benign, the alias rolls over harmlessly).

Append a test asserting that after a slug rename:
- The new slug works.
- Requests to the OLD slug get 301 with Location pointing at the new slug.

If the slug-rename test file doesn't exist, this is a small addendum to `v1-routes.test.ts`.

### Step 3: Run, regression, commit

Standard cycle — `bun test`, diff against baseline, commit.

```bash
git add server/src/server.ts server/src/tenant.ts server/src/v1-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(tenant): slug rename writes tenant_slug_alias

Whenever an admin renames a workspace slug, the old slug is recorded
in tenant_slug_alias with a 30-day expiry. Requests under
/api/t/<old-slug>/v1/... return 301 with Location pointing at the new
slug for that window.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: SA-attributed audit rows

**Files:**
- Modify: any code path that calls `appendAuditAs` from within a service-account-authenticated request. For PR2 this is just `createServiceAccount` (Task 5 creates a SA via the API; future PR3 mutations follow the same pattern).

When a service account performs an action (read-only in v1, mutation in PR3+), the audit row should record `actor_type: "service_account"` + the SA name so the UI can render "committed by Service account: Fivetran sync" per the design.

This is a small task — touches the audit metadata payload.

- [ ] **Step 1: Identify the audit hook for SA creation**

Currently `createServiceAccount` in `repo-service-accounts.ts` doesn't write an audit row. It should — admin actions on credentials are auditable.

Add to `createServiceAccount` after the INSERT:

```ts
import { appendAuditAs } from "./repo-meta.ts";

// ... inside createServiceAccount, after the pgRun INSERT:
await appendAuditAs(
  input.createdBy,
  "Created service account",
  input.name,
  {
    tenantId: input.tenantId,
    metadata: {
      service_account_id: id,
      scopes: ["read"],
      expires_at: input.expiresAt?.toISOString() ?? null,
    },
  },
);
```

Similarly add to `revokeServiceAccount` (which doesn't currently know the userId; widen its signature to `revokeServiceAccount(tenantId, id, userId)` and thread through from the route handler).

- [ ] **Step 2: Update tests + commit**

Update the relevant tests to provide `userId` and assert audit rows land. Commit.

```bash
git add server/src/repo-service-accounts.ts server/src/repo-service-accounts.test.ts server/src/v1-routes.ts
git commit -m "$(cat <<'EOF'
feat(audit): SA creation + revocation emit audit rows

createServiceAccount and revokeServiceAccount now write audit_log entries
attributed to the admin user. Per-row metadata carries service_account_id
+ scopes + expires_at so the audit dashboard can render the full context.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: `.env.example` updates

**Files:**
- Modify: `server/.env.example` — document `ZUGZUG_PULL_API_RPM`.

PR1 already added `ZUGZUG_CURSOR_KEY` and the webhook-master-key block. PR2 adds the rate-limit budget.

Append to `server/.env.example` (after the PR1 outbound block):

```bash
# Per-credential rate-limit budget for the /v1/ Pull API surface, in
# requests per minute. Default: 600. Set to 0 to disable (e.g. for
# load testing or trusted intranet deployments).
# ZUGZUG_PULL_API_RPM=600
```

Commit:

```bash
git add server/.env.example
git commit -m "$(cat <<'EOF'
docs: document ZUGZUG_PULL_API_RPM in .env.example

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: End-to-end smoke test against the running server

**Files:**
- (No code changes — this is a manual verification step.)

Start the server locally and exercise the Pull API end-to-end. This catches bugs that unit tests miss (route registration, env var loading, real Postgres responses).

- [ ] **Step 1: Boot the server**

```bash
cd server && WEBHOOKS_ENABLED=0 ZUGZUG_PULL_API_RPM=600 bun run start &
SERVER_PID=$!
sleep 2
```

- [ ] **Step 2: Create a SA via the API (uses cookie auth, log in as admin first)**

(Skip if not feasible — the local dev story may need a logged-in browser; the alternative is to create the SA via `bun run` script invoking `createServiceAccount` directly.)

```bash
# Direct DB approach if cookie-auth is annoying locally:
bun -e '
import { createServiceAccount } from "./src/repo-service-accounts.ts";
const out = await createServiceAccount({ tenantId: "default", name: "smoke", createdBy: "u_test" });
console.log("token:", out.value);
'
```

- [ ] **Step 3: Curl the Pull API**

```bash
TOKEN="zzsa_..." # value from above
curl -i -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/t/default/v1/dimensions
curl -i -H "Authorization: Bearer $TOKEN" "http://localhost:8787/api/t/default/v1/dimensions/country/canonical?limit=2"
```

Expected: 200s with JSON; the second curl should return at most 2 records and a non-null `cursor.next` if more exist.

- [ ] **Step 4: Test cursor round-trip**

```bash
NEXT=$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8787/api/t/default/v1/dimensions/country/canonical?limit=1" | jq -r '.cursor.next')
curl -i -H "Authorization: Bearer $TOKEN" "http://localhost:8787/api/t/default/v1/dimensions/country/canonical?limit=1&cursor=$(printf %s "$NEXT" | jq -sRr @uri)"
```

Expected: a different record than page 1.

- [ ] **Step 5: Tear down**

```bash
kill $SERVER_PID
```

If everything works, this PR is ready. If not, the failure mode and stack trace from the server log informs the fix.

---

## Task 16: Final verification — full suite + typecheck

- [ ] Run `cd server && bun test` — confirm 158 baseline failures plus PR2's added pass-only tests; no new failures.
- [ ] Run `cd server && bun run typecheck && cd ../app && bun run typecheck` — exit 0 both.
- [ ] Run `git log --oneline main..HEAD` — confirm the expected commit list (~15 commits for PR2).

---

## Self-Review Checklist (run before handoff)

**1. Spec coverage** — every PR2 item from design §5 + §10 Phase 1 is covered:
- [x] `/v1/dimensions` list — Task 8 (repo) + Task 11 (route)
- [x] `/v1/dimensions/:slug/schema` — Task 8 + Task 11
- [x] `/v1/dimensions/:slug/canonical` paginated + ?since + cursor — Task 8 + Task 11
- [x] `/v1/dimensions/:slug/canonical/:key` — Task 8 + Task 11
- [x] `/v1/dimensions/:slug/tombstones` — Task 8 + Task 11
- [x] `/v1/events` — Task 8 + Task 11 (returns empty until PR3 writes)
- [x] `GET /v1/service-accounts` — Task 5 + Task 11
- [x] `POST /v1/service-accounts` (value shown once) — Task 5 + Task 11
- [x] `DELETE /v1/service-accounts/:id` — Task 5 + Task 11
- [x] `zzsa_` token auth — Task 3
- [x] Tenant binding (SA slug mismatch → 403) — Task 7 + Task 11
- [x] `resolveTenantContext` SA branch — Task 7
- [x] Token-bucket rate limit + 429 with Retry-After — Task 9 + Task 11
- [x] HMAC-signed pagination cursor + tampered cursor 400 — Task 8 + Task 11
- [x] 30-day slug-redirect alias (301 + Location) — Task 10 + Task 11 + Task 12
- [x] `requireScope` helper (used by PR3) — Task 6
- [x] SA-attributed audit rows — Task 13

**Deferred (called out at top of plan, not gaps):**
- Webhook dispatcher / reaper / retention sweep / `dispatchOutbound()` — PR3
- Integrations UI — PR4
- `webhook:manage` scope writes / route consumers — PR3

**2. Placeholder scan** — no TODO/TBD/"similar to" in any code block.

**3. Type consistency:**
- `ServiceAccountCtx` shape (`{ id, tenantId, scopes }`) is consistent across `auth-api-tokens.ts`, `tenant-middleware.ts`, `v1-routes.ts`.
- `CursorPayload` (`{ t, u, k, v }`) from PR1's `cursor.ts` is reused unchanged.
- `PageOpts` / `EventPageOpts` are consistent in `repo-outbound.ts` and consumed correctly in `v1-routes.ts`.

**Open considerations for the executing engineer:**

- **Test database state** — PR1's executor noted the test db isn't reliably pre-migrated. Before starting Task 2, run `cd server && DATABASE_URL=postgres://zugzug:zugzug@localhost:55432/zugzug_test bun run db:migrate` and verify the 0024+0025 migrations applied; then 0026 will follow.
- **`createdBy` plumbing** in Task 11 — the dispatch function needs the real userId for SA-create. Don't hardcode `"u_unknown"`; thread `authed.user.id` from `handleV1Route` into `dispatch` and use that.
- **The dynamic `fieldsJsonExpr`** in repo-outbound (Task 8) — this is the most likely place for SQL injection if a dim_<slug>'s columns ever contained user input. They don't today (column names are derived from slugified field names), but verify by reading how `dimension_field.field` is sanitized at write time.
