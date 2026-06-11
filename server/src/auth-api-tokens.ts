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

/** DELETE /api/tokens/:id — set revoked_at. Returns 204 unconditionally (don't
 *  reveal whether the token existed or belonged to the caller). */
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
      void pgRun(`UPDATE ${pg("api_tokens")} SET last_used_at = current_timestamp WHERE id = $1`, [
        cand.id,
      ]).catch(() => {});
      const user = await pgGet<SessionUser>(
        `SELECT id, name, email, initials, role,
                is_super_admin AS "isSuperAdmin",
                NULL::varchar AS "impersonatingTenantId"
           FROM ${pg("users")} WHERE id = $1`,
        [cand.user_id],
      );
      return user;
    }
  }
  return null;
}

// env import is unused inside this module but kept for future config (e.g. token TTL)
void env;
