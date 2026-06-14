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
    `INSERT INTO ${pg("api_tokens")} (id, user_id, name, token_hash, token_prefix, created_at)
     VALUES ($1, $2, $3, $4, $5, current_timestamp)`,
    [id, userId, name, hash, value.slice(0, 12)],
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
 *  Fast path uses the `token_prefix` index (O(1) per request). Legacy fallback
 *  scans NULL-prefix rows (tokens issued before the prefix column existed),
 *  capped at 200 rows to bound worst-case argon2 cost, and logs a deprecation
 *  warning on every hit so admins know to rotate. */
export async function getApiTokenUser(req: Request): Promise<SessionUser | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const prefix12 = token.slice(0, 12);

  // Fast path: O(1) prefix-indexed lookup. Hits for every token issued post-migration.
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

  // Legacy slow path: capped scan of NULL-prefix rows (tokens issued before this
  // migration). Bounded at 200 rows so worst-case auth cost stays predictable.
  // Every hit logs a deprecation warning so admins notice and rotate.
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

async function loadSessionUser(userId: string): Promise<SessionUser | null> {
  return await pgGet<SessionUser>(
    `SELECT id, name, email, initials,
            is_super_admin AS "isSuperAdmin",
            NULL::varchar AS "impersonatingTenantId"
       FROM ${pg("users")} WHERE id = $1`,
    [userId],
  );
}

// env import is unused inside this module but kept for future config (e.g. token TTL)
void env;
