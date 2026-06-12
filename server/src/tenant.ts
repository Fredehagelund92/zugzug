/* tenant.ts — provisioning + listing for multi-tenant workspaces.
 *
 * This module is the single creation seam for tenants. The HTTP layer doesn't
 * touch the tenant table directly — it calls provisionTenant() (later via the
 * super-admin /api/admin/tenants route in PR 2). The CLI script in
 * scripts/admin.ts also calls in here for PR 1 bootstrap. */

import { pgGet, pgAll, pgRun, pgTxRaw } from "./pg.ts";
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

  // Single atomic statement — no check-then-insert race. ON CONFLICT DO
  // NOTHING (no target) absorbs any unique violation: the id PK and the
  // tenant_slug_unique index. No row back ⇒ somebody (possibly a concurrent
  // call) already owns that id or slug.
  const row = await pgGet<TenantRecord>(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT DO NOTHING
     RETURNING id, slug, label, warehouse_id, created_at`,
    [id, slug, label, warehouseId],
  );
  if (!row) {
    throw new AppError("ALREADY_EXISTS", `tenant '${id}' already exists (id or slug taken)`, 409);
  }
  return row;
}

/** Hard-delete every row owned by `tenantId` across the scoped tables and drop
 *  the dynamic `dim_<id>` / `map_<id>` tables it owns. The tenant row itself is
 *  soft-deleted (deleted_at = now()). Refuses to act on the 'default' tenant. */
export async function teardownTenant(tenantId: string): Promise<void> {
  if (tenantId === "default") {
    throw new AppError("VALIDATION_FAILED", "cannot teardown the default tenant", 400);
  }
  await pgTxRaw(async (tx) => {
    // Capture dynamic dim_/map_ table names BEFORE deleting registry rows.
    // The values were INSERTed by addDimension() with safe construction
    // (schema-qualified, regex-validated identifiers), so splicing them
    // straight into DROP TABLE is sound.
    const dims = await tx.all<{ dim_table: string; map_table: string }>(
      `SELECT dim_table, map_table FROM "zugzug_app"."dimension" WHERE tenant_id = $1`,
      [tenantId],
    );
    for (const d of dims) {
      await tx.run(`DROP TABLE IF EXISTS ${d.dim_table}`);
      await tx.run(`DROP TABLE IF EXISTS ${d.map_table}`);
    }

    const scoped = [
      "draft",
      "audit_log",
      "ai_hint_cache",
      "canonical_version",
      "scan_run",
      "source_stat",
      "dimension_field",
      "dimension_source",
      "dimension",
      "active_sessions",
      "preferences",
      "tenant_member",
      "tenant_invite",
    ];
    for (const tbl of scoped) {
      await tx.run(`DELETE FROM "zugzug_app"."${tbl}" WHERE tenant_id = $1`, [tenantId]);
    }

    await tx.run(`UPDATE "zugzug_app"."tenant" SET deleted_at = now() WHERE id = $1`, [tenantId]);
  });
}

export async function listTenants(): Promise<TenantRecord[]> {
  return pgAll<TenantRecord>(
    `SELECT id, slug, label, warehouse_id, created_at
       FROM "zugzug_app"."tenant"
      WHERE deleted_at IS NULL
      ORDER BY id`,
  );
}

export interface Membership {
  tenant: TenantRecord;
  role: "admin" | "editor" | "viewer";
}

export async function tenantBySlug(slug: string): Promise<TenantRecord | null> {
  return pgGet<TenantRecord>(
    `SELECT id, slug, label, warehouse_id, created_at
       FROM "zugzug_app"."tenant"
      WHERE slug = $1 AND deleted_at IS NULL`,
    [slug],
  );
}

export async function listMembershipsForUser(userId: string): Promise<Membership[]> {
  const rows = await pgAll<{
    tid: string;
    slug: string;
    label: string;
    warehouse_id: string;
    created_at: Date;
    role: "admin" | "editor" | "viewer";
  }>(
    `SELECT t.id AS tid, t.slug, t.label, t.warehouse_id, t.created_at, tm.role
       FROM "zugzug_app"."tenant_member" tm
       JOIN "zugzug_app"."tenant" t ON t.id = tm.tenant_id
      WHERE tm.user_id = $1 AND t.deleted_at IS NULL
      ORDER BY t.label`,
    [userId],
  );
  return rows.map((r) => ({
    tenant: {
      id: r.tid,
      slug: r.slug,
      label: r.label,
      warehouse_id: r.warehouse_id,
      created_at: r.created_at,
    },
    role: r.role,
  }));
}

export async function memberRole(
  tenantId: string,
  userId: string,
): Promise<"admin" | "editor" | "viewer" | null> {
  const row = await pgGet<{ role: "admin" | "editor" | "viewer" }>(
    `SELECT role FROM "zugzug_app"."tenant_member"
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return row?.role ?? null;
}

export interface AcceptedInvite {
  tenant_id: string;
  role: "admin" | "editor" | "viewer";
}

/** Atomically convert every pending tenant_invite for `email` into a tenant_member
 *  row for `userId`. Returns the accepted invites. Idempotent: if a membership
 *  already exists (e.g. invite was already accepted in a concurrent login), the
 *  invite is still removed and no error is raised. */
export async function acceptInvitesFor(userId: string, email: string): Promise<AcceptedInvite[]> {
  const normalized = email.trim().toLowerCase();
  return pgTxRaw(async (tx) => {
    const invites = await tx.all<{ tenant_id: string; role: "admin" | "editor" | "viewer" }>(
      `SELECT tenant_id, role
         FROM "zugzug_app"."tenant_invite"
        WHERE lower(email) = $1
        FOR UPDATE`,
      [normalized],
    );
    if (invites.length === 0) return [];

    await tx.run(
      `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
       SELECT tenant_id, $1, role, now()
         FROM "zugzug_app"."tenant_invite"
        WHERE lower(email) = $2
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [userId, normalized],
    );
    await tx.run(`DELETE FROM "zugzug_app"."tenant_invite" WHERE lower(email) = $1`, [normalized]);
    return invites;
  });
}

export interface InviteRecord {
  email: string;
  role: "admin" | "editor" | "viewer";
  invited_at: Date;
}

export async function listInvitesForTenant(tenantId: string): Promise<InviteRecord[]> {
  return pgAll<InviteRecord>(
    `SELECT email, role, invited_at
       FROM "zugzug_app"."tenant_invite"
      WHERE tenant_id = $1
      ORDER BY invited_at DESC`,
    [tenantId],
  );
}

export async function createInvite(
  tenantId: string,
  email: string,
  role: "admin" | "editor" | "viewer",
  invitedBy: string,
): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_invite" (tenant_id, email, role, invited_by, invited_at)
     VALUES ($1, lower($2), $3, $4, now())
     ON CONFLICT (tenant_id, email) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by`,
    [tenantId, email, role, invitedBy],
  );
}

export async function revokeInvite(tenantId: string, email: string): Promise<void> {
  await pgRun(
    `DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1 AND lower(email) = lower($2)`,
    [tenantId, email],
  );
}

export interface MemberRecord {
  user_id: string;
  email: string;
  name: string | null;
  role: "admin" | "editor" | "viewer";
  joined_at: Date;
}

export async function listMembersForTenant(tenantId: string): Promise<MemberRecord[]> {
  return pgAll<MemberRecord>(
    `SELECT u.id AS user_id, u.email, u.name, tm.role, tm.created_at AS joined_at
       FROM "zugzug_app"."tenant_member" tm
       JOIN "zugzug_app"."users" u ON u.id = tm.user_id
      WHERE tm.tenant_id = $1
      ORDER BY u.email`,
    [tenantId],
  );
}

export async function setMemberRole(
  tenantId: string,
  userId: string,
  role: "admin" | "editor" | "viewer",
): Promise<void> {
  await pgRun(
    `UPDATE "zugzug_app"."tenant_member" SET role = $3
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId, role],
  );
}

export async function countAdmins(tenantId: string): Promise<number> {
  const row = await pgGet<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM "zugzug_app"."tenant_member"
      WHERE tenant_id = $1 AND role = 'admin'`,
    [tenantId],
  );
  return row?.n ?? 0;
}

export async function removeMember(tenantId: string, userId: string): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1 AND user_id = $2`, [
    tenantId,
    userId,
  ]);
}

/** Updates the display label of a tenant. Slug is immutable. */
export async function updateTenantLabel(tenantId: string, label: string): Promise<void> {
  const trimmed = label.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "label cannot be empty", 400);
  await pgRun(
    `UPDATE "zugzug_app"."tenant" SET label = $1 WHERE id = $2`,
    [trimmed, tenantId],
  );
}

/**
 * Removes a user's own membership from a tenant.
 * Enforces last-admin guard: throws AppError("LAST_ADMIN", ..., 409) when removing
 * the user would leave the tenant with zero admins.
 */
export async function leaveTenant(tenantId: string, userId: string): Promise<void> {
  const members = await listMembersForTenant(tenantId);
  const leaving = members.find((m) => m.user_id === userId);
  if (leaving?.role === "admin") {
    const adminCount = members.filter((m) => m.role === "admin").length;
    if (adminCount <= 1) {
      throw new AppError("LAST_ADMIN", "cannot leave — you are the last admin", 409);
    }
  }
  await pgRun(
    `DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
}
