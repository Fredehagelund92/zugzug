/* auth-api-tokens.ts — Bearer-token auth for the /v1/ Pull API.

   Only service-account tokens (zzsa_… prefix) are supported. Personal
   access tokens were removed; UI surfaces for headless access live under
   Integrations → Service accounts. */

import { pg } from "./env.ts";
import { pgRun, pgAll } from "./pg.ts";
import type { SessionUser } from "./auth.ts";

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

/** Resolves a Bearer-token request. Returns the auth context bound to a
 *  service account, or null for unknown / missing / revoked / expired
 *  credentials. */
export async function authenticateBearer(req: Request): Promise<AuthedRequest | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token.startsWith(SA_PREFIX)) return null;
  return await resolveServiceAccountToken(token);
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

/** Synthetic SessionUser representing a service-account-authenticated request.
 *  Audit rows attributed to this user surface as
 *  "committed by Service account: <name>" in the UI. */
function syntheticSaUser(saId: string, saName: string): SessionUser {
  return {
    id: saId,
    name: `Service account: ${saName}`,
    email: null,
    initials: "SA",
    isSuperAdmin: false,
    impersonatingTenantId: null,
  };
}
