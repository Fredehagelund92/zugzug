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
 *  old_slug pushes its expires_at forward. */
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

/** Drops any alias sitting on `slug`. Called when a workspace claims that slug
 *  (rename or provision) so a live workspace can never be shadowed by another
 *  workspace's stale redirect. */
export async function clearSlugAlias(slug: string): Promise<void> {
  await pgRun(`DELETE FROM ${pg("tenant_slug_alias")} WHERE old_slug = $1`, [slug]);
}
