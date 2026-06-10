/* tenant.ts — provisioning + listing for multi-tenant workspaces.
 *
 * This module is the single creation seam for tenants. The HTTP layer doesn't
 * touch the tenant table directly — it calls provisionTenant() (later via the
 * super-admin /api/admin/tenants route in PR 2). The CLI script in
 * scripts/admin.ts also calls in here for PR 1 bootstrap. */

import { pgRun, pgGet, pgAll } from "./pg.ts";
import { AppError } from "./errors.ts";

const TENANT_ID_RE = /^[a-z][a-z0-9_]{0,20}$/;

export interface TenantRecord {
  id: string;
  slug: string;
  label: string;
  warehouse_id: string;
  created_at: Date;
}

export async function provisionTenant(opts: {
  id: string;
  label: string;
  /** Optional URL slug; defaults to id (per Decision 1 in the spec, slug == id in phase 1). */
  slug?: string;
  /** Optional warehouse id; defaults to 'default' (shared warehouse for phase 1). */
  warehouseId?: string;
}): Promise<TenantRecord> {
  const id = opts.id.trim();
  const slug = (opts.slug ?? id).trim();
  const label = opts.label.trim();
  const warehouseId = (opts.warehouseId ?? "default").trim();

  if (!TENANT_ID_RE.test(id)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `tenant id '${id}' must match ${TENANT_ID_RE.source}`,
      400,
    );
  }
  if (!TENANT_ID_RE.test(slug)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `tenant slug '${slug}' must match ${TENANT_ID_RE.source}`,
      400,
    );
  }
  if (!label) {
    throw new AppError("VALIDATION_FAILED", `tenant label cannot be empty`, 400);
  }

  const existing = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."tenant" WHERE id = $1`,
    [id],
  );
  if (existing) {
    throw new AppError("ALREADY_EXISTS", `tenant '${id}' already exists`, 409);
  }

  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $2, $3, $4, now())`,
    [id, slug, label, warehouseId],
  );

  const row = await pgGet<TenantRecord>(
    `SELECT id, slug, label, warehouse_id, created_at
       FROM "zugzug_app"."tenant" WHERE id = $1`,
    [id],
  );
  if (!row) {
    throw new AppError("INTERNAL", `tenant '${id}' disappeared after insert`, 500);
  }
  return row;
}

export async function listTenants(): Promise<TenantRecord[]> {
  return pgAll<TenantRecord>(
    `SELECT id, slug, label, warehouse_id, created_at
       FROM "zugzug_app"."tenant"
      WHERE deleted_at IS NULL
      ORDER BY id`,
  );
}
