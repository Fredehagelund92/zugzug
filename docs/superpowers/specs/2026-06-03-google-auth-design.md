***REMOVED*** Google Auth — Design Spec
_Date: 2026-06-03_

***REMOVED******REMOVED*** Overview

Add real authentication to Zug Zug using Google OAuth2. Access is restricted to a configurable email domain (`ALLOWED_DOMAIN` in `.env`) and further limited to an explicit allowlist managed through the Settings UI. The first `@ALLOWED_DOMAIN` login auto-provisions (bootstrap mode); subsequent logins require the email to be pre-added by an existing user.

No roles. Binary access: you're in or you're not.

***REMOVED******REMOVED*** Stack choices

- **OAuth2 flow**: DIY — two Bun endpoints, Google's stable OAuth2 endpoints, no framework.
- **Session**: Server-side row in Postgres `sessions` table. httpOnly `Secure SameSite=Lax` cookie holds only the session ID (revocable, no self-contained token on the client).
- **ID token verification**: `jose` npm package (JWT signature + `aud` + `exp` checks).
- **No hosted auth provider.**

---

***REMOVED******REMOVED*** Data model

***REMOVED******REMOVED******REMOVED*** `users` table (alter existing)
Add two columns:
- `email VARCHAR UNIQUE NOT NULL` — Google email, used as the display identity.
- `google_sub VARCHAR UNIQUE` — stable Google subject ID from the ID token. NULL for legacy demo seed rows.

***REMOVED******REMOVED******REMOVED*** `allowed_emails` table (new)
```sql
CREATE TABLE allowed_emails (
  email      VARCHAR PRIMARY KEY,
  added_by   VARCHAR NOT NULL,  -- user_id of who added this
  added_at   TIMESTAMP NOT NULL DEFAULT current_timestamp
);
```
This is the allowlist. Empty table = bootstrap mode (first `@ALLOWED_DOMAIN` login auto-provisions and is inserted here).

***REMOVED******REMOVED******REMOVED*** `sessions` table (new)
```sql
CREATE TABLE sessions (
  id         VARCHAR PRIMARY KEY,  -- random 32-byte hex
  user_id    VARCHAR NOT NULL REFERENCES users(id),
  expires_at TIMESTAMP NOT NULL
);
```
Sessions expire after 30 days. Logout deletes the row. Session cookie name: `zz_sid`.

---

***REMOVED******REMOVED*** Auth flow

***REMOVED******REMOVED******REMOVED*** `GET /api/auth/google`
1. Generate a random `state` string (16-byte hex).
2. Store `state` in a short-lived httpOnly cookie (`zz_state`, 10 min).
3. Build the Google authorization URL:
   - `client_id` from env
   - `redirect_uri` = `ORIGIN/api/auth/callback`
   - `scope` = `openid email profile`
   - `response_type` = `code`
   - `state`
4. 302 redirect to Google.

***REMOVED******REMOVED******REMOVED*** `GET /api/auth/callback`
1. Validate `state` cookie matches query param. Clear the state cookie.
2. Exchange `code` for tokens via `https://oauth2.googleapis.com/token`.
3. Verify the ID token with `jose` (signature against Google's JWKS, `aud`, `exp`).
4. Extract `email`, `sub`, `name`, `picture` from the ID token payload.
5. **Domain check**: reject (redirect to `/login?error=domain`) if email domain ≠ `ALLOWED_DOMAIN`.
6. **Allowlist check**:
   - If `allowed_emails` is empty → bootstrap: insert email into `allowed_emails` (added_by = 'bootstrap').
   - Else if email not in `allowed_emails` → reject (redirect to `/login?error=not_allowed`).
7. Upsert into `users` (`id` = `google_sub` prefixed with `u_`, `email`, `name`, `initials` from first+last initial).
8. Insert row into `sessions` (random ID, 30-day expiry).
9. Set `zz_sid` cookie (httpOnly, Secure, SameSite=Lax, 30-day Max-Age).
10. Redirect to `/app`.

***REMOVED******REMOVED******REMOVED*** `POST /api/auth/logout`
1. Read `zz_sid` cookie, delete the `sessions` row.
2. Clear the cookie.
3. Redirect to `/login`.

***REMOVED******REMOVED******REMOVED*** Session middleware (all existing `/api/*` routes)
Replace the `x-user-id` header hack with:
1. Read `zz_sid` cookie.
2. Look up session in Postgres; reject with 401 if missing or expired.
3. Inject `user_id` into the request context (same `actor()` function shape).

***REMOVED******REMOVED******REMOVED*** `GET /api/auth/me`
Returns `{ id, name, email, initials }` for the session user, or 401 if not authenticated. Used by `BootGate` to decide whether to render the app or the login page.

---

***REMOVED******REMOVED*** Team management endpoints

***REMOVED******REMOVED******REMOVED*** `GET /api/team/members`
Returns the full `allowed_emails` list with `added_by`, `added_at`. Any logged-in user can call this.

***REMOVED******REMOVED******REMOVED*** `POST /api/team/members`
Body: `{ email: string }`. Validates domain, inserts into `allowed_emails` (added_by = session user). Returns 409 if already present.

***REMOVED******REMOVED******REMOVED*** `DELETE /api/team/members/:email`
Removes from `allowed_emails`. Does not delete the `users` row (audit trail preserved). Any logged-in user can remove any email except their own.

---

***REMOVED******REMOVED*** Frontend

***REMOVED******REMOVED******REMOVED*** New `/login` route
- Outside `AppShell`, no nav.
- Single centered card: app logo, "Sign in with Google" button (links to `/api/auth/google`).
- Shows error messages for `?error=domain` and `?error=not_allowed`.

***REMOVED******REMOVED******REMOVED*** `BootGate` update
- On mount, calls `GET /api/auth/me`.
- 401 → renders `<LoginPage />` instead of the app.
- 200 → proceeds as today (calls `initStore()`).

***REMOVED******REMOVED******REMOVED*** `AppShell` update
- Replace demo user-switcher dropdown with the real user's name + initials avatar.
- Add "Sign out" button that POSTs to `/api/auth/logout` and redirects to `/login`.

***REMOVED******REMOVED******REMOVED*** Settings page — "Team" section
- Lists all rows from `GET /api/team/members`: email, who added them, when.
- "Add member" text input + button → POST `/api/team/members`.
- Remove button per row (disabled for your own email) → DELETE `/api/team/members/:email`.

---

***REMOVED******REMOVED*** Environment variables (additions to `.env`)

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ALLOWED_DOMAIN=example.com
ORIGIN=https://your-app-domain.com   ***REMOVED*** used to build redirect_uri; http://localhost:5173 in dev
SESSION_SECRET=                       ***REMOVED*** 32+ random bytes, used to sign state cookie
```

---

***REMOVED******REMOVED*** Out of scope

- Roles / permissions (explicit non-goal).
- Email notifications when access is granted/denied.
- SSO / SAML.
- Refresh token rotation (30-day sessions; re-login on expiry is acceptable).
