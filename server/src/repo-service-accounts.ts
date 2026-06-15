/* repo-service-accounts.ts — workspace-scoped M2M token CRUD.

   Tokens authenticate as the workspace (not as a person) and persist when
   members leave. Stored as Bun.password.hash (argon2id); shown once at
   creation, never re-displayable. The token_prefix column enables O(1)
   prefix-indexed auth lookup (see auth-api-tokens.ts:resolveServiceAccountToken). */

import { pg } from "./env.ts";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import { appendAuditAs } from "./repo-meta.ts";

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
             current_timestamp, $6, ($7::timestamptz AT TIME ZONE 'UTC'))`,
    [
      id,
      input.tenantId,
      input.name.trim(),
      hash,
      value.slice(0, 12),
      input.createdBy,
      input.expiresAt ?? null,
    ],
  );
  await appendAuditAs(input.createdBy, "Created service account", input.name.trim(), {
    tenantId: input.tenantId,
    metadata: {
      service_account_id: id,
      scopes: ["read"],
      expires_at: input.expiresAt?.toISOString() ?? null,
    },
  });
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
export async function revokeServiceAccount(
  tenantId: string,
  id: string,
  userId: string,
): Promise<boolean> {
  const row = await pgGet<{ revoked: boolean; name: string }>(
    `UPDATE ${pg("service_account")}
        SET revoked_at = current_timestamp
      WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
      RETURNING true AS revoked, name`,
    [id, tenantId],
  );
  if (!row) return false;
  await appendAuditAs(userId, "Revoked service account", row.name, {
    tenantId,
    metadata: { service_account_id: id },
  });
  return true;
}
