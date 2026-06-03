***REMOVED*** Google Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo `x-user-id` header hack with real Google OAuth2 login, session cookies, and an allowlist-based team access model.

**Architecture:** Two new Bun server modules (`auth.ts`, `team.ts`) handle the OAuth flow and member management. Sessions are stored server-side in Postgres (`sessions` table); only the session ID travels in an httpOnly cookie. The frontend's `BootGate` checks `/api/auth/me` before booting the app, redirecting to a new `/login` route on 401.

**Tech Stack:** `jose` (JWKS + JWT verify), Google OAuth2 endpoints, Bun.serve, Postgres via DuckDB ATTACH, React Router v6, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-06-03-google-auth-design.md`

---

***REMOVED******REMOVED*** File Map

| File | Action | Purpose |
|------|--------|---------|
| `server/package.json` | Modify | Add `jose` dependency |
| `server/src/env.ts` | Modify | Add `googleClientId`, `googleClientSecret`, `allowedDomain`, `origin` |
| `server/.env.example` | Modify | Document new env vars |
| `server/src/schema.ts` | Modify | Add `allowed_emails`, `sessions` tables; alter `users` for `email` + `google_sub` |
| `server/src/auth.ts` | Create | Google OAuth handlers, session resolution, cookie helpers |
| `server/src/team.ts` | Create | `listMembers`, `addMember`, `removeMember` |
| `server/src/server.ts` | Modify | Mount auth + team routes; replace `actor()` with session gate |
| `app/src/routes/Login.tsx` | Create | Login page with Google button + error messages |
| `app/src/main.tsx` | Modify | Add `/login` route outside `BootGate` |
| `app/src/components/BootGate.tsx` | Modify | Check `/api/auth/me`; redirect to `/login` on 401 |
| `app/src/components/AppShell.tsx` | Modify | Show real user + sign-out button; remove demo switcher |
| `app/src/store.ts` | Modify | Add `email` to `User`; remove `x-user-id` header from `api()` |
| `app/src/routes/Settings.tsx` | Modify | Add Team section (list/add/remove members) |

---

***REMOVED******REMOVED*** Task 1: Install `jose` + add auth env vars

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/env.ts`
- Modify: `server/.env.example`

- [ ] **Step 1: Install `jose`**

```bash
cd server && bun add jose
```

Expected output: `bun add jose` completes, `jose` appears in `server/package.json` dependencies.

- [ ] **Step 2: Add auth env vars to `server/src/env.ts`**

In `server/src/env.ts`, replace the export block to add the new vars. The full updated file:

```typescript
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
  /** Email domain allowed to log in (e.g. "example.com"). */
  allowedDomain: process.env.ALLOWED_DOMAIN?.trim() || "example.com",
  /** Public origin of this app — used to build the OAuth redirect_uri.
   *  In dev: http://localhost:5173 (Vite proxies /api). In prod: https://yourapp.com */
  origin: process.env.ORIGIN?.trim() || "http://localhost:5173",
};

/** Fully-qualified Postgres app-state table name, e.g. oltp.zugzug_app.draft */
export const pg = (table: string) => `${env.oltpCatalog}.${env.appSchema}.${table}`;
```

- [ ] **Step 3: Update `.env.example`**

Append to the end of `server/.env.example`:

```
***REMOVED*** Google OAuth2 — create credentials at https://console.cloud.google.com/apis/credentials
***REMOVED*** Authorized redirect URI must include: ORIGIN/api/auth/callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

***REMOVED*** Domain restriction — only @this-domain.com emails may log in.
ALLOWED_DOMAIN=example.com

***REMOVED*** Public base URL of this app. Used to build the OAuth redirect_uri.
***REMOVED*** Dev: http://localhost:5173   Prod: https://yourapp.com
ORIGIN=http://localhost:5173
```

- [ ] **Step 4: Verify typecheck passes**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/bun.lockb server/src/env.ts server/.env.example
git commit -m "feat(auth): install jose + add auth env vars"
```

---

***REMOVED******REMOVED*** Task 2: Schema migrations — `allowed_emails`, `sessions`, `users` columns

**Files:**
- Modify: `server/src/schema.ts`

- [ ] **Step 1: Add `email` and `google_sub` columns to `users`, and create `allowed_emails` + `sessions` tables**

In `server/src/schema.ts`, find the `// users + presence` block (around line 117) and replace it with:

```typescript
  // users + presence
  await run(`CREATE TABLE IF NOT EXISTS ${pg("users")} (
    id       VARCHAR PRIMARY KEY,
    name     VARCHAR NOT NULL,
    initials VARCHAR NOT NULL
  )`);
  // Idempotent: add auth columns to existing users table.
  // email and google_sub are nullable to preserve existing demo rows.
  await run(`ALTER TABLE ${pg("users")} ADD COLUMN IF NOT EXISTS email VARCHAR`);
  await run(`ALTER TABLE ${pg("users")} ADD COLUMN IF NOT EXISTS google_sub VARCHAR`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON ${pg("users")} (email) WHERE email IS NOT NULL`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON ${pg("users")} (google_sub) WHERE google_sub IS NOT NULL`);

  await run(`CREATE TABLE IF NOT EXISTS ${pg("active_sessions")} (
    user_id   VARCHAR PRIMARY KEY,
    last_seen TIMESTAMP NOT NULL
  )`);

  // allowlist: only explicitly added emails may log in. Empty = bootstrap mode.
  await run(`CREATE TABLE IF NOT EXISTS ${pg("allowed_emails")} (
    email      VARCHAR PRIMARY KEY,
    added_by   VARCHAR NOT NULL,
    added_at   TIMESTAMP NOT NULL DEFAULT current_timestamp
  )`);

  // server-side sessions — the zz_sid cookie holds only the session id.
  await run(`CREATE TABLE IF NOT EXISTS ${pg("sessions")} (
    id         VARCHAR PRIMARY KEY,
    user_id    VARCHAR NOT NULL,
    expires_at TIMESTAMP NOT NULL
  )`);
```

- [ ] **Step 2: Verify server boots with updated schema**

Restart the server and check the log:

```bash
cd server && bun run start
```

Expected: server starts, prints `· connected (MotherDuck + Postgres attached)`, no errors about missing columns.

- [ ] **Step 3: Commit**

```bash
git add server/src/schema.ts
git commit -m "feat(auth): add allowed_emails + sessions tables, add email/google_sub to users"
```

---

***REMOVED******REMOVED*** Task 3: Create `server/src/auth.ts`

**Files:**
- Create: `server/src/auth.ts`

This module owns the full OAuth flow, session reads, and all cookie logic.

- [ ] **Step 1: Create `server/src/auth.ts`**

```typescript
/* auth.ts — Google OAuth2 flow + session resolution.
   Two public route handlers (handleGoogleRedirect, handleGoogleCallback,
   handleLogout, handleMe) plus getSessionUser() used as middleware in server.ts. */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { env, pg } from "./env.ts";
import { run, all, get } from "./db.ts";

export interface SessionUser { id: string; name: string; email: string; initials: string }

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const SID = "zz_sid";
const STATE = "zz_state";
const SESSION_SECONDS = 30 * 86_400;
const isSecure = env.origin.startsWith("https://");

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

function cookie(name: string, value: string, maxAge: number): string {
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
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
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
  return get<SessionUser>(
    `SELECT id, name, email, initials FROM ${pg("users")} WHERE id = $1`,
    [session.user_id],
  );
}

// ---- route handlers --------------------------------------------------------

/** GET /api/auth/google — kick off the OAuth2 redirect. */
export async function handleGoogleRedirect(_req: Request): Promise<Response> {
  const state = crypto.randomUUID().replace(/-/g, "");
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: `${env.origin}/api/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
  });
  const headers = new Headers({
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
  });
  headers.append("Set-Cookie", cookie(STATE, state, 600));
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/callback — Google redirects here after user consent. */
export async function handleGoogleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const cookies = parseCookies(req.headers.get("cookie"));

  const clearState = clearCookie(STATE);

  if (!stateParam || stateParam !== cookies[STATE]) {
    return loginError("state", clearState);
  }
  if (!code) return loginError("no_code", clearState);

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: `${env.origin}/api/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return loginError("token", clearState);
  const { id_token } = (await tokenRes.json()) as { id_token: string };

  // Verify ID token signature + claims
  let sub: string, email: string, name: string, givenName: string | undefined, familyName: string | undefined;
  try {
    const { payload } = await jwtVerify(id_token, GOOGLE_JWKS, {
      audience: env.googleClientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
    sub = payload.sub as string;
    email = payload["email"] as string;
    name = (payload["name"] as string) ?? email;
    givenName = payload["given_name"] as string | undefined;
    familyName = payload["family_name"] as string | undefined;
  } catch {
    return loginError("token", clearState);
  }

  // Domain check
  if (email.split("@")[1] !== env.allowedDomain) return loginError("domain", clearState);

  // Allowlist check (empty table = bootstrap mode)
  const [{ n }] = await all<{ n: bigint }>(`SELECT count(*) AS n FROM ${pg("allowed_emails")}`);
  if (Number(n) === 0) {
    await run(
      `INSERT INTO ${pg("allowed_emails")} (email, added_by, added_at) VALUES ($1, 'bootstrap', current_timestamp)`,
      [email],
    );
  } else {
    const allowed = await get(`SELECT email FROM ${pg("allowed_emails")} WHERE email = $1`, [email]);
    if (!allowed) return loginError("not_allowed", clearState);
  }

  // Build initials from given/family name, fall back to splitting display name
  const initials = givenName && familyName
    ? `${givenName[0]}${familyName[0]}`.toUpperCase()
    : name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "??";

  // Upsert user
  const userId = `u_${sub}`;
  await run(
    `INSERT INTO ${pg("users")} (id, name, email, google_sub, initials)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET name = $2, email = $3, initials = $5`,
    [userId, name, email, sub, initials],
  );

  // Create session
  const sessionId = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
  await run(
    `INSERT INTO ${pg("sessions")} (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sessionId, userId, expiresAt.toISOString()],
  );

  const headers = new Headers({ Location: "/app" });
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", cookie(SID, sessionId, SESSION_SECONDS));
  return new Response(null, { status: 302, headers });
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
  if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  return new Response(JSON.stringify(user), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---- internal helpers ------------------------------------------------------

function loginError(error: string, clearStateCookie: string): Response {
  const headers = new Headers({ Location: `/login?error=${error}` });
  headers.append("Set-Cookie", clearStateCookie);
  return new Response(null, { status: 302, headers });
}
```

- [ ] **Step 2: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/auth.ts
git commit -m "feat(auth): Google OAuth2 handlers + session middleware"
```

---

***REMOVED******REMOVED*** Task 4: Wire auth into `server.ts` — session gate + route mounting

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: Add auth imports at the top of `server/src/server.ts`**

Find the existing imports block:
```typescript
import { connect } from "./db.ts";
import { env } from "./env.ts";
import * as repo from "./repo.ts";
```

Replace with:
```typescript
import { connect } from "./db.ts";
import { env } from "./env.ts";
import * as repo from "./repo.ts";
import { getSessionUser, handleGoogleRedirect, handleGoogleCallback, handleMe, handleLogout } from "./auth.ts";
```

- [ ] **Step 2: Remove the `actor` helper (line 15)**

Delete this line:
```typescript
const actor = (req: Request) => req.headers.get("x-user-id")?.trim() || "u_ada";
```

- [ ] **Step 3: Update the OPTIONS CORS response to remove `x-user-id`**

Find:
```typescript
    if (method === "OPTIONS")
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-user-id" } });
```

Replace with:
```typescript
    if (method === "OPTIONS")
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type" } });
```

- [ ] **Step 4: Mount auth routes + session gate**

Find the block after `if (seg[0] !== "api") ...`:
```typescript
    if (seg[0] !== "api") return new Response("Zug Zug API. Try /api/dimensions", { status: 404 });

    try {
      // GET /api/preferences ; PUT /api/preferences ...
```

Replace with:
```typescript
    if (seg[0] !== "api") return new Response("Zug Zug API. Try /api/dimensions", { status: 404 });

    // Auth routes — no session required
    if (seg[1] === "auth") {
      if (seg[2] === "google" && method === "GET") return handleGoogleRedirect(req);
      if (seg[2] === "callback" && method === "GET") return handleGoogleCallback(req);
      if (seg[2] === "me" && method === "GET") return handleMe(req);
      if (seg[2] === "logout" && method === "POST") return handleLogout(req);
      return json({ error: "not found" }, 404);
    }

    // Session gate — all other /api/* routes require a valid session
    const sessionUser = await getSessionUser(req);
    if (!sessionUser) return json({ error: "Unauthorized" }, 401);
    const me = sessionUser.id;

    try {
      // GET /api/preferences ; PUT /api/preferences ...
```

- [ ] **Step 5: Replace all `actor(req)` calls with `me`**

There are 7 occurrences of `actor(req)` in server.ts. Replace each:

Line ~69: `const me = actor(req);` → this line becomes redundant now, delete it and the `me` is already defined above.

Actually, find the block:
```typescript
      // GET /api/users → { currentUser, collaborators }
      if (seg[1] === "users" && seg.length === 2 && method === "GET") {
        const users = await repo.listUsers();
        const me = actor(req);
        return json({ currentUser: users.find((u) => u.id === me) ?? users[0], collaborators: users });
      }
```

Replace with:
```typescript
      // GET /api/users → { currentUser, collaborators }
      if (seg[1] === "users" && seg.length === 2 && method === "GET") {
        const users = await repo.listUsers();
        return json({ currentUser: users.find((u) => u.id === me) ?? users[0], collaborators: users });
      }
```

Then replace the remaining `actor(req)` occurrences with `me`:
- Line ~110: `await repo.appendAuditAs(actor(req), ...)` → `await repo.appendAuditAs(me, ...)`
- Line ~118: `return json(await repo.getGridLayout(actor(req), dimId))` → `return json(await repo.getGridLayout(me, dimId))`
- Line ~121: `await repo.setGridLayout(actor(req), dimId, body)` → `await repo.setGridLayout(me, dimId, body)`
- Line ~146: `await repo.saveDraft(id, b.raw, b.status, b.targetLabel ?? null, b.targetKey ?? null, actor(req))` → `...actor(req)` → `...me)`
- Line ~150: `await repo.discardDraft(id, decodeURIComponent(seg[4]!), actor(req))` → `...me)`
- Line ~226: `return json(await repo.commit(id, actor(req)))` → `return json(await repo.commit(id, me))`

- [ ] **Step 6: Move the outer `try/catch` to wrap only the route logic (not auth routes)**

The current structure has one big `try { ... } catch (e) { ... }` wrapping everything from the preferences check to the end. After inserting the session gate, the `try {` starts after the `const me = sessionUser.id;` line and the `} catch (e) { ... }` stays at the end. Verify the structure looks like:

```typescript
    // Session gate
    const sessionUser = await getSessionUser(req);
    if (!sessionUser) return json({ error: "Unauthorized" }, 401);
    const me = sessionUser.id;

    try {
      // GET /api/preferences ...
      ...
      return json({ error: `no route for ${method} ${pathname}` }, 404);
    } catch (e) {
      console.error(`✗ ${method} ${pathname}:`, e);
      return err(e);
    }
```

- [ ] **Step 7: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 8: Smoke-test the auth endpoints**

Start the server (`bun run start`), then:

```bash
***REMOVED*** Should redirect to Google (302 with Location header)
curl -v http://localhost:8787/api/auth/google 2>&1 | grep -E "Location:|< HTTP"

***REMOVED*** Should return 401 (no session cookie)
curl -s http://localhost:8787/api/auth/me | cat

***REMOVED*** Should return 401 for a protected route
curl -s http://localhost:8787/api/dimensions | cat
```

Expected outputs:
- First: `HTTP/1.1 302` + `Location: https://accounts.google.com/...`
- Second: `{"error":"Unauthorized"}`
- Third: `{"error":"Unauthorized"}`

- [ ] **Step 9: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(auth): wire session gate into server — all /api/* routes now require a session"
```

---

***REMOVED******REMOVED*** Task 5: Create `server/src/team.ts` + wire into `server.ts`

**Files:**
- Create: `server/src/team.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: Create `server/src/team.ts`**

```typescript
/* team.ts — allowed_emails management. Any logged-in user can add/remove members.
   Self-removal is blocked. Domain is validated on add. */

import { run, all, get } from "./db.ts";
import { env, pg } from "./env.ts";

export interface Member { email: string; addedBy: string; addedAt: string }

export async function listMembers(): Promise<Member[]> {
  const rows = await all<{ email: string; added_by_name: string; added_at: string }>(
    `SELECT ae.email, COALESCE(u.name, ae.added_by) AS added_by_name, ae.added_at
     FROM ${pg("allowed_emails")} ae
     LEFT JOIN ${pg("users")} u ON u.id = ae.added_by
     ORDER BY ae.added_at`,
  );
  return rows.map((r) => ({ email: r.email, addedBy: r.added_by_name, addedAt: r.added_at }));
}

export async function addMember(email: string, addedById: string): Promise<void> {
  const domain = email.split("@")[1];
  if (domain !== env.allowedDomain) throw Object.assign(new Error("wrong_domain"), { status: 400 });
  await run(
    `INSERT INTO ${pg("allowed_emails")} (email, added_by, added_at) VALUES ($1, $2, current_timestamp)`,
    [email, addedById],
  );
}

export async function removeMember(email: string, requesterId: string): Promise<void> {
  const requester = await get<{ email: string }>(`SELECT email FROM ${pg("users")} WHERE id = $1`, [requesterId]);
  if (requester?.email === email) throw Object.assign(new Error("cannot_remove_self"), { status: 400 });
  await run(`DELETE FROM ${pg("allowed_emails")} WHERE email = $1`, [email]);
}
```

- [ ] **Step 2: Import team module in `server/src/server.ts`**

Add to the imports at the top:
```typescript
import * as team from "./team.ts";
```

- [ ] **Step 3: Add team routes in `server/src/server.ts`**

Inside the `try { ... }` block (after the session gate), add the team routes before the `return json({ error: ... }, 404)` line:

```typescript
      // GET /api/team/members ; POST /api/team/members ; DELETE /api/team/members/:email
      if (seg[1] === "team" && seg[2] === "members") {
        if (seg.length === 3 && method === "GET") return json(await team.listMembers());
        if (seg.length === 3 && method === "POST") {
          const { email } = (await req.json()) as { email: string };
          try {
            await team.addMember(email, me);
            return noContent();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === "wrong_domain") return json({ error: `Only @${env.allowedDomain} emails allowed` }, 400);
            if (msg.includes("unique") || msg.includes("duplicate")) return json({ error: "already_exists" }, 409);
            throw e;
          }
        }
        if (seg.length === 4 && method === "DELETE") {
          const email = decodeURIComponent(seg[3]!);
          try {
            await team.removeMember(email, me);
            return noContent();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === "cannot_remove_self") return json({ error: "cannot_remove_self" }, 400);
            throw e;
          }
        }
      }
```

- [ ] **Step 4: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/team.ts server/src/server.ts
git commit -m "feat(auth): team member management endpoints (list/add/remove allowed_emails)"
```

---

***REMOVED******REMOVED*** Task 6: Create `app/src/routes/Login.tsx`

**Files:**
- Create: `app/src/routes/Login.tsx`

- [ ] **Step 1: Create the Login page**

```tsx
import { Mark } from "../components/Mark";

const ERROR_MESSAGES: Record<string, string> = {
  domain: "Only @example.com accounts can access this app.",
  not_allowed: "Your account hasn't been added yet. Ask a team member to add you in Settings.",
  token: "Authentication failed — please try again.",
  state: "Session expired — please try again.",
  no_code: "Login was cancelled.",
};

export function Login() {
  const error = new URLSearchParams(window.location.search).get("error");

  return (
    <div
      className="grid min-h-screen place-items-center p-8"
      style={{ background: "var(--bg)", color: "var(--ink)" }}
    >
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-8">
        <div className="flex items-center gap-2.5">
          <Mark className="h-7 w-7" />
          <span className="font-display text-lg font-extrabold tracking-tight">
            Zug Zug<span style={{ color: "var(--accent)" }}>.</span>
          </span>
        </div>

        <div>
          <h1 className="font-display text-2xl font-bold">Sign in</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
            Master data reconciliation · Zugzug.
          </p>
        </div>

        {error && (
          <p className="rounded-sm border px-3 py-2 text-[13px]"
            style={{ borderColor: "var(--warn)", color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 10%, transparent)" }}>
            {ERROR_MESSAGES[error] ?? "Something went wrong — please try again."}
          </p>
        )}

        <a
          href="/api/auth/google"
          className="flex w-full items-center justify-center gap-2.5 rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-4 py-2.5 text-[13px] font-medium transition-colors hover:bg-[var(--hover)]"
        >
          <GoogleIcon />
          Sign in with Google
        </a>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="***REMOVED***4285F4" d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 0 0 2.38-5.88c0-.57-.05-.66-.15-1.18z" />
      <path fill="***REMOVED***34A853" d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2.01c-.72.48-1.63.77-2.7.77-2.08 0-3.84-1.4-4.47-3.29H1.83v2.07A8 8 0 0 0 8.98 17z" />
      <path fill="***REMOVED***FBBC05" d="M4.51 10.53A4.8 4.8 0 0 1 4.26 9c0-.53.09-1.04.25-1.53V5.4H1.83A8 8 0 0 0 .98 9c0 1.29.31 2.51.85 3.6l2.68-2.07z" />
      <path fill="***REMOVED***EA4335" d="M8.98 3.58c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 1.83 5.4L4.51 7.47c.63-1.89 2.39-3.89 4.47-3.89z" />
    </svg>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/routes/Login.tsx
git commit -m "feat(auth): Login page with Google OAuth button"
```

---

***REMOVED******REMOVED*** Task 7: Update `BootGate` + `main.tsx`

**Files:**
- Modify: `app/src/components/BootGate.tsx`
- Modify: `app/src/main.tsx`

- [ ] **Step 1: Update `BootGate` to check `/api/auth/me` before booting**

Replace the full contents of `app/src/components/BootGate.tsx`:

```tsx
import { useEffect, useState, type ReactNode } from "react";
import { initStore } from "../store";
import { Mark } from "./Mark";
import { Button } from "./Button";

type State = { kind: "loading" } | { kind: "ready" } | { kind: "error"; detail: string };

export function BootGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const boot = () => {
    setState({ kind: "loading" });
    (async () => {
      const meRes = await fetch("/api/auth/me");
      if (meRes.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!meRes.ok) throw new Error(`API unreachable (${meRes.status})`);
      await initStore();
      setState({ kind: "ready" });
    })().catch((e: unknown) =>
      setState({ kind: "error", detail: e instanceof Error ? e.message : String(e) }),
    );
  };

  useEffect(boot, []);

  if (state.kind === "ready") return <>{children}</>;

  if (state.kind === "error") {
    return (
      <div className="zz-canvas grid min-h-screen place-items-center p-8">
        <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-8">
          <div className="flex items-center gap-2.5">
            <Mark className="h-7 w-7" />
            <span className="font-display text-lg font-extrabold tracking-tight text-ink">
              Zug Zug<span className="text-accent">.</span>
            </span>
          </div>
          <h1 className="font-display text-2xl font-bold text-ink">Can&apos;t reach the API.</h1>
          <p className="text-ink-2">The server isn&apos;t responding. Start it with:</p>
          <pre className="overflow-x-auto rounded-sm border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink-2">cd server &amp;&amp; bun run start</pre>
          <details className="text-[12px] text-ink-3">
            <summary className="cursor-pointer">Technical detail</summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono">{state.detail}</pre>
          </details>
          <div className="flex justify-end">
            <Button onClick={boot}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="zz-canvas grid min-h-screen place-items-center p-8">
      <div className="flex items-center gap-2.5">
        <Mark className="h-8 w-8 animate-pulse" />
        <span className="font-display text-lg font-extrabold tracking-tight text-ink-2">
          Loading Zug Zug<span className="text-accent">…</span>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add `/login` route to `main.tsx` (outside BootGate)**

In `app/src/main.tsx`, add the `Login` import and wrap routes so `/login` is not behind `BootGate`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./globals.css";
import { setAccent, setTheme, toggleTheme } from "./theme";
import { EngineerModeProvider } from "./lib/engineer-mode";
import { UndoStackProvider } from "./components/datagrid";
import { BootGate } from "./components/BootGate";
import { AppShell } from "./components/AppShell";
import { Login } from "./routes/Login";
import { Dashboard } from "./routes/Dashboard";
import { Mapping } from "./routes/Mapping";
import { Sources } from "./routes/Sources";
import { MasterTables } from "./routes/MasterTables";
import { Settings } from "./routes/Settings";
import { Showcase } from "./routes/Showcase";

declare global {
  interface Window {
    BrandApp: { setAccent: typeof setAccent; setTheme: typeof setTheme; toggleTheme: typeof toggleTheme };
  }
}
window.BrandApp = { setAccent, setTheme, toggleTheme };

const root = document.getElementById("root")!;

createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Public — no session required */}
        <Route path="/login" element={<Login />} />
        <Route path="/design" element={<Showcase />} />

        {/* Protected — BootGate checks /api/auth/me and redirects to /login on 401 */}
        <Route
          path="*"
          element={
            <UndoStackProvider>
              <EngineerModeProvider>
                <BootGate>
                  <Routes>
                    <Route path="/" element={<Navigate to="/app" replace />} />
                    <Route element={<AppShell />}>
                      <Route path="/app" element={<Dashboard />} />
                      <Route path="/app/mapping" element={<Mapping />} />
                      <Route path="/app/sources" element={<Sources />} />
                      <Route path="/app/tables" element={<MasterTables />} />
                      <Route path="/app/settings" element={<Settings />} />
                    </Route>
                    <Route path="*" element={<Navigate to="/app" replace />} />
                  </Routes>
                </BootGate>
              </EngineerModeProvider>
            </UndoStackProvider>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
```

- [ ] **Step 3: Typecheck the app**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/BootGate.tsx app/src/main.tsx
git commit -m "feat(auth): BootGate checks /api/auth/me; add /login route outside BootGate"
```

---

***REMOVED******REMOVED*** Task 8: Update `store.ts` — drop `x-user-id`, add `email` to `User`

**Files:**
- Modify: `app/src/store.ts`

- [ ] **Step 1: Add `email` to the `User` interface**

Find:
```typescript
export interface User { id: string; name: string; initials: string }
```

Replace with:
```typescript
export interface User { id: string; name: string; initials: string; email?: string }
```

- [ ] **Step 2: Remove `x-user-id` from the `api()` fetch helper**

Find:
```typescript
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "content-type": "application/json", "x-user-id": currentUser.id, ...opts?.headers },
  });
```

Replace with:
```typescript
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...opts?.headers },
  });
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/store.ts
git commit -m "feat(auth): drop x-user-id header from store api(); add email to User type"
```

---

***REMOVED******REMOVED*** Task 9: Update `AppShell` — real user display + sign out

**Files:**
- Modify: `app/src/components/AppShell.tsx`

- [ ] **Step 1: Replace the demo collaborator avatar cluster with real user + sign-out**

In `app/src/components/AppShell.tsx`, find the header's right-side block:

```tsx
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <div className="flex items-center -space-x-2">
              {collaborators.map((u, i) => (
                <span key={u.id} title={`${u.name}${i === 0 ? " (you)" : ""}`}
                  className={cx("grid h-8 w-8 place-items-center rounded-pill border-2 border-surface bg-surface-3 font-mono text-[10px] text-ink-2", i === 0 && "ring-1 ring-accent")}>
                  {u.initials}
                </span>
              ))}
            </div>
          </div>
```

Replace with:

```tsx
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <UserMenu />
          </div>
```

- [ ] **Step 2: Add the `UserMenu` component inside `AppShell.tsx`, before the `AppShell` export**

Add this component definition (it uses `currentUser` from the store, which is already imported):

```tsx
function UserMenu() {
  const [open, setOpen] = useState(false);

  const signOut = () => {
    fetch("/api/auth/logout", { method: "POST" })
      .then(() => { window.location.href = "/login"; })
      .catch(() => { window.location.href = "/login"; });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={currentUser.name}
        className="grid h-8 w-8 place-items-center rounded-pill border border-line-2 bg-surface-3 font-mono text-[10px] text-ink-2 ring-1 ring-accent transition-colors hover:bg-hover"
      >
        {currentUser.initials}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-20 min-w-[160px] rounded-sm border border-line bg-surface shadow-md">
            <div className="border-b border-line px-3 py-2">
              <p className="text-[13px] font-medium text-ink">{currentUser.name}</p>
              {currentUser.email && (
                <p className="text-[11px] text-ink-3">{currentUser.email}</p>
              )}
            </div>
            <button
              type="button"
              onClick={signOut}
              className="w-full px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add `useState` to imports in `AppShell.tsx`**

Find the first import line:
```typescript
import { useEffect, useState } from "react";
```

It should already have `useState`. If it currently only has `useEffect`, add `useState`:
```typescript
import { useEffect, useState } from "react";
```

Also ensure `currentUser` is imported from the store. Find:
```typescript
import { useDimensions, collaborators } from "../store";
```

Replace with:
```typescript
import { useDimensions, currentUser } from "../store";
```

- [ ] **Step 4: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/AppShell.tsx
git commit -m "feat(auth): AppShell — real user avatar with sign-out menu"
```

---

***REMOVED******REMOVED*** Task 10: Add Team section to `Settings.tsx`

**Files:**
- Modify: `app/src/routes/Settings.tsx`

- [ ] **Step 1: Add Team section to `Settings.tsx`**

At the top of `Settings.tsx`, update the React import to include `useEffect` and `useRef`:
```tsx
import { useState, useEffect, useRef } from "react";
```

Add `currentUser` to the store import:
```tsx
import { usePreferences, setPreferences, currentUser } from "../store";
```

Add the `TeamSection` component before the `Settings` export:

```tsx
interface Member { email: string; addedBy: string; addedAt: string }

function TeamSection() {
  const [members, setMembers] = useState<Member[]>([]);
  const [addEmail, setAddEmail] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    fetch("/api/team/members")
      .then((r) => r.json())
      .then((data: Member[]) => setMembers(data))
      .catch(() => {});
  };

  useEffect(load, []);

  const add = async () => {
    setAddError(null);
    if (!addEmail.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/team/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: addEmail.trim().toLowerCase() }),
      });
      if (res.status === 409) { setAddError("Already added."); return; }
      if (res.status === 400) { setAddError("Must be a @example.com email."); return; }
      if (!res.ok) { setAddError("Something went wrong."); return; }
      setAddEmail("");
      load();
    } finally {
      setAdding(false);
      inputRef.current?.focus();
    }
  };

  const remove = async (email: string) => {
    const res = await fetch(`/api/team/members/${encodeURIComponent(email)}`, { method: "DELETE" });
    if (res.ok) load();
  };

  const myEmail = currentUser.email;

  return (
    <Section title="Team" hint="Only people on this list can log in. Any team member can add or remove others.">
      <ul className="divide-y divide-line rounded-sm border border-line">
        {members.length === 0 && (
          <li className="px-4 py-3 text-[13px] text-ink-3">No members yet.</li>
        )}
        {members.map((m) => (
          <li key={m.email} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex-1 font-mono text-[12px] text-ink">{m.email}</span>
            <span className="text-[11px] text-ink-3">
              added by {m.addedBy === "bootstrap" ? "bootstrap" : m.addedBy}
            </span>
            {m.email !== myEmail && (
              <button
                type="button"
                onClick={() => remove(m.email)}
                className="text-[11px] text-ink-3 hover:text-warn"
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-1">
          <input
            ref={inputRef}
            className={input}
            placeholder="colleague@example.com"
            value={addEmail}
            onChange={(e) => { setAddEmail(e.target.value); setAddError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            disabled={adding}
          />
          {addError && <p className="font-mono text-[11px] text-warn">{addError}</p>}
        </div>
        <Button onClick={() => void add()} disabled={adding || !addEmail.trim()}>
          {adding ? "Adding…" : "Add"}
        </Button>
      </div>
    </Section>
  );
}
```

- [ ] **Step 2: Mount `TeamSection` inside the `Settings` return**

Add the Team section at the end of the settings page, after the Matching defaults section:

```tsx
      <div className="zz-rise" style={{ animationDelay: "220ms" }}>
        <TeamSection />
      </div>
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/Settings.tsx
git commit -m "feat(auth): Team section in Settings — list/add/remove allowed_emails"
```

---

***REMOVED******REMOVED*** Task 11: End-to-end verification

Before marking this complete, verify the full flow manually.

- [ ] **Step 1: Configure Google OAuth credentials**

In Google Cloud Console:
1. Create an OAuth 2.0 Client ID (Web application)
2. Add authorized redirect URI: `http://localhost:5173/api/auth/callback`
3. Copy Client ID + Secret into `server/.env`:

```
GOOGLE_CLIENT_ID=<your-client-id>
GOOGLE_CLIENT_SECRET=<your-client-secret>
ALLOWED_DOMAIN=example.com
ORIGIN=http://localhost:5173
```

- [ ] **Step 2: Start both servers**

```bash
***REMOVED*** Terminal 1
cd server && bun run start

***REMOVED*** Terminal 2
cd app && bun run dev
```

- [ ] **Step 3: Verify unauthenticated redirect**

Open `http://localhost:5173` in a browser (no prior session). Expected: redirected to `/login` page showing the "Sign in with Google" button.

- [ ] **Step 4: Verify Google login flow**

Click "Sign in with Google". Expected: redirected to Google consent screen → after consent → redirected to `/app` dashboard.

- [ ] **Step 5: Verify bootstrap allowlist**

After first login, navigate to Settings → Team section. Expected: your email appears in the list with "added by bootstrap".

- [ ] **Step 6: Verify sign out**

Click the user avatar in the top-right corner → "Sign out". Expected: session cleared, redirected to `/login`.

- [ ] **Step 7: Verify domain rejection**

Log in with a non-`@example.com` Google account. Expected: `/login?error=domain` with the domain error message.

- [ ] **Step 8: Verify access restriction**

After signing back in, go to Settings → Team → Add a second email → Sign out. Open an incognito window and try to sign in with an email *not* on the list. Expected: `/login?error=not_allowed`.

- [ ] **Step 9: Final typecheck across both packages**

```bash
cd server && bun run typecheck && cd ../app && bun run typecheck
```

Expected: no errors in either.
