/* tenant.ts — provisioning + listing for multi-tenant workspaces.
 *
 * This module is the single creation seam for tenants. The HTTP layer doesn't
 * touch the tenant table directly — it calls provisionTenant() (later via the
 * super-admin /api/admin/tenants route in PR 2). The CLI script in
 * scripts/admin.ts also calls in here for PR 1 bootstrap. */

import { pgGet, pgAll, pgRun, pgTxRaw } from "./pg.ts";
import { env } from "./env.ts";
import { AppError } from "./errors.ts";
import { addWarehouseDatabase } from "./repo-warehouse.ts";
import { recordSlugAlias, clearSlugAlias } from "./slug-alias.ts";

const TENANT_ID_RE = /^[a-z][a-z0-9_]{0,20}$/;
/** TENANT_ID_RE in the words people read in an error (CONTEXT.md §Language). */
const ID_RULE =
  "start with a letter and use only lowercase letters, numbers or underscores (21 characters max)";

/** Slugs the app's own URL space owns. `admin` is a live collision: `/app/admin/*`
 *  is the super-admin shell, and apiFetch rewrites a workspace slugged `admin` to
 *  `/api/admin/...`, so every fetch 403s for ordinary members. The rest are the
 *  other top-level names (`/login`, `/signup`, `/design` routes plus the `/api`
 *  prefix) — reserved defensively so they can never become collisions. */
// Only "admin" can actually be shadowed: workspaces live at /app/<slug>, so the
// top-level /login, /signup and /design routes can never collide with one, and
// apiFetch rewrites /app/admin/* to /api/admin/* — which 403s every request a
// member of such a workspace makes.
const RESERVED_SLUGS = new Set(["admin"]);

function assertSlugAllowed(slug: string): void {
  if (RESERVED_SLUGS.has(slug)) {
    throw new AppError("VALIDATION_FAILED", `slug '${slug}' is reserved`, 400);
  }
}

export const WORKSPACE_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#14b8a6",
  "#3b82f6",
  "#64748b",
] as const;

function assertValidColor(color: string): void {
  if (!(WORKSPACE_COLORS as readonly string[]).includes(color)) {
    throw new AppError("VALIDATION_FAILED", `invalid color '${color}'`, 400);
  }
}

export interface TenantRecord {
  id: string;
  slug: string;
  label: string;
  color: string | null;
  created_at: Date;
}

export async function provisionTenant(opts: {
  id: string;
  label: string;
  /** Optional URL slug; defaults to id (per Decision 1 in the spec, slug == id in phase 1). */
  slug?: string;
  color?: string;
  /** When set, register N deployment-global warehouse_database rows in the same
   *  logical operation as the tenant insert. Rolled back by compensating
   *  DELETEs on the tenant row if any of the warehouse writes fail. */
  warehouse?: {
    databases?: Array<{ databaseName: string; label?: string }>;
    /** user id to populate added_by on the warehouse_database row(s) */
    createdBy: string;
  };
}): Promise<TenantRecord> {
  const id = opts.id.trim();
  const slug = (opts.slug ?? id).trim();
  const label = opts.label.trim();
  const color = opts.color ?? null;

  if (!TENANT_ID_RE.test(id)) {
    throw new AppError("VALIDATION_FAILED", `workspace id '${id}' must ${ID_RULE}`, 400);
  }
  if (!TENANT_ID_RE.test(slug)) {
    throw new AppError("VALIDATION_FAILED", `workspace slug '${slug}' must ${ID_RULE}`, 400);
  }
  assertSlugAllowed(slug);
  if (!label) {
    throw new AppError("VALIDATION_FAILED", `workspace name cannot be empty`, 400);
  }

  if (color !== null) assertValidColor(color);

  // Single atomic statement — no check-then-insert race. ON CONFLICT DO
  // NOTHING (no target) absorbs any unique violation: the id PK and the
  // tenant_slug_unique index. No row back ⇒ somebody (possibly a concurrent
  // call) already owns that id or slug.
  const row = await pgGet<TenantRecord>(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, color, created_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT DO NOTHING
     RETURNING id, slug, label, color, created_at`,
    [id, slug, label, color],
  );
  if (!row) {
    throw new AppError(
      "ALREADY_EXISTS",
      `workspace '${id}' already exists (id or slug taken)`,
      409,
    );
  }

  // A live workspace outranks another workspace's stale redirect: drop any
  // alias sitting on the slug we just claimed.
  await clearSlugAlias(slug);

  // Warehouse provisioning. Compensating-DELETE on failure: the repo-warehouse
  // writers call pgRun directly (no pgContext.tx threading), so we can't share
  // one Postgres transaction with the tenant insert above. If any warehouse
  // write fails we tear down the tenant row to leave callers with a clean
  // "didn't happen" instead of a half-provisioned tenant.
  if (opts.warehouse) {
    const wh = opts.warehouse;
    try {
      for (const db of wh.databases ?? []) {
        await addWarehouseDatabase({
          databaseName: db.databaseName,
          label: db.label,
          actorUserId: wh.createdBy,
        });
      }
    } catch (err) {
      // warehouse_database is deployment-global (no tenant_id) so we can't
      // safely compensate by deleting rows here — they may belong to other
      // tenants. Best-effort: roll back only the tenant row we just created.
      try {
        await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [id]);
      } catch {
        /* ignore: best-effort compensation */
      }
      throw err;
    }
  }

  return row;
}

/** Hard-delete every row owned by `tenantId` across the scoped tables and drop
 *  the dynamic `dim_<id>` / `map_<id>` tables it owns. The tenant row itself is
 *  soft-deleted (deleted_at = now()). Refuses to act on the 'default' tenant. */
export async function teardownTenant(tenantId: string): Promise<void> {
  if (tenantId === "default") {
    throw new AppError("VALIDATION_FAILED", "cannot delete the default workspace", 400);
  }
  await pgTxRaw(async (tx) => {
    // Capture dynamic dim_/map_ table names BEFORE deleting registry rows.
    // The values were INSERTed by addRefTable() with safe construction
    // (schema-qualified, regex-validated identifiers), so splicing them
    // straight into DROP TABLE is sound.
    const refTables = await tx.all<{ dim_table: string; map_table: string }>(
      `SELECT dim_table, map_table FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
      [tenantId],
    );
    for (const d of refTables) {
      await tx.run(`DROP TABLE IF EXISTS ${d.dim_table}`);
      await tx.run(`DROP TABLE IF EXISTS ${d.map_table}`);
    }

    const scoped = [
      "draft",
      "audit_log",
      "ai_hint_cache",
      "record_version",
      "scan_run",
      "source_stat",
      "reference_table_field",
      "reference_table_source",
      "reference_table",
      "active_sessions",
      "outbound_event",
      "preferences",
      "service_account",
      "tenant_member",
      "tenant_invite",
      "webhook",
      "webhook_delivery",
    ];
    for (const tbl of scoped) {
      await tx.run(`DELETE FROM "zugzug_app"."${tbl}" WHERE tenant_id = $1`, [tenantId]);
    }

    await tx.run(`UPDATE "zugzug_app"."tenant" SET deleted_at = now() WHERE id = $1`, [tenantId]);
  });
}

export async function listTenants(): Promise<TenantRecord[]> {
  return pgAll<TenantRecord>(
    `SELECT id, slug, label, color, created_at
       FROM "zugzug_app"."tenant"
      WHERE deleted_at IS NULL
      ORDER BY id`,
  );
}

export interface TenantAdminRow extends TenantRecord {
  member_count: number;
  last_activity_at: Date | null;
}

export async function listTenantsForAdmin(): Promise<TenantAdminRow[]> {
  return pgAll<TenantAdminRow>(
    `SELECT t.id, t.slug, t.label, t.color, t.created_at,
            (SELECT count(*)::int FROM "zugzug_app"."tenant_member" tm
              WHERE tm.tenant_id = t.id) AS member_count,
            (SELECT max(created_at) FROM "zugzug_app"."audit_log" a
              WHERE a.tenant_id = t.id) AS last_activity_at
       FROM "zugzug_app"."tenant" t
      WHERE t.deleted_at IS NULL
      ORDER BY t.id`,
  );
}

export interface Membership {
  tenant: TenantRecord;
  role: "admin" | "editor" | "viewer";
}

export async function tenantBySlug(slug: string): Promise<TenantRecord | null> {
  return pgGet<TenantRecord>(
    `SELECT id, slug, label, color, created_at
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
    color: string | null;
    created_at: Date;
    role: "admin" | "editor" | "viewer";
  }>(
    `SELECT t.id AS tid, t.slug, t.label, t.color, t.created_at, tm.role
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
      color: r.color,
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
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role WHERE tenant_member.role != 'admin'`,
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What adding an email to a workspace actually did. */
export type AddMemberOutcome = { kind: "member"; userId: string } | { kind: "invite" };

/** Adds `email` to a workspace from the Members screen.
 *
 *  An address that already has an account becomes a member on the spot: an
 *  invite only turns into a membership inside login/signup (acceptInvitesFor),
 *  and GET /api/me/memberships reads tenant_member, so an already-signed-in
 *  user would otherwise never see the workspace until they signed out and back
 *  in. Addresses with no account yet still get a pending invite.
 *
 *  Rejects what the Members screen already has copy for: a malformed or
 *  out-of-domain address (400) and someone already on the team or already
 *  invited (409). */
export async function addMemberOrInvite(
  tenantId: string,
  email: string,
  role: "admin" | "editor" | "viewer",
  invitedBy: string,
): Promise<AddMemberOutcome> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    throw new AppError("VALIDATION_FAILED", `'${email}' is not an email address`, 400);
  }
  if (env.allowedDomain && normalized.split("@")[1] !== env.allowedDomain) {
    throw new AppError("VALIDATION_FAILED", `must be a @${env.allowedDomain} address`, 400);
  }

  const user = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."users" WHERE lower(email) = $1`,
    [normalized],
  );
  if (user && (await memberRole(tenantId, user.id)) !== null) {
    throw new AppError("ALREADY_EXISTS", `${normalized} is already on the team`, 409);
  }
  const pending = await pgGet<{ email: string }>(
    `SELECT email FROM "zugzug_app"."tenant_invite"
      WHERE tenant_id = $1 AND lower(email) = $2`,
    [tenantId, normalized],
  );
  if (pending) {
    throw new AppError("ALREADY_EXISTS", `${normalized} is already invited`, 409);
  }

  if (!user) {
    await createInvite(tenantId, normalized, role, invitedBy);
    return { kind: "invite" };
  }
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, user_id) DO NOTHING`,
    [tenantId, user.id, role],
  );
  return { kind: "member", userId: user.id };
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
  await pgRun(`UPDATE "zugzug_app"."tenant" SET label = $1 WHERE id = $2`, [trimmed, tenantId]);
}

/** Updates the accent color of a tenant. Must be one of WORKSPACE_COLORS. */
export async function updateTenantColor(tenantId: string, color: string): Promise<void> {
  assertValidColor(color);
  await pgRun(`UPDATE "zugzug_app"."tenant" SET color = $1 WHERE id = $2`, [color, tenantId]);
}

/** Updates the URL slug of a tenant. Refuses to change the 'default' tenant's
 *  slug. Validates charset against TENANT_ID_RE. Throws ALREADY_EXISTS if the
 *  target slug is taken by another tenant. */
export async function updateTenantSlug(currentSlug: string, newSlug: string): Promise<void> {
  const next = newSlug.trim();
  if (currentSlug === "default") {
    throw new AppError("FORBIDDEN", "cannot change slug of the default workspace", 403);
  }
  if (!TENANT_ID_RE.test(next)) {
    throw new AppError("VALIDATION_FAILED", `slug '${next}' must ${ID_RULE}`, 400);
  }
  assertSlugAllowed(next);
  if (next === currentSlug) return;
  const existing = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."tenant" WHERE slug = $1 AND deleted_at IS NULL`,
    [next],
  );
  if (existing) {
    throw new AppError("ALREADY_EXISTS", `slug '${next}' is taken`, 409);
  }
  const current = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."tenant" WHERE slug = $1 AND deleted_at IS NULL`,
    [currentSlug],
  );
  if (!current) {
    throw new AppError("NOT_FOUND", `workspace '${currentSlug}' not found`, 404);
  }
  // PR2 Task 12: persists old slug for 30-day redirect grace window.
  // Fired before the UPDATE so an UPDATE failure leaves a benign alias row
  // pointing at the unchanged slug. Idempotent on old_slug.
  await recordSlugAlias(currentSlug, current.id);
  await pgRun(`UPDATE "zugzug_app"."tenant" SET slug = $1 WHERE slug = $2`, [next, currentSlug]);
  // Claiming a slug drops any alias still redirecting away from it, so the
  // workspace that now owns it can never be shadowed by an older rename.
  await clearSlugAlias(next);
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
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1 AND user_id = $2`, [
    tenantId,
    userId,
  ]);
}
