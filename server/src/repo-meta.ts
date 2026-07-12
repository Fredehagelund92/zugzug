/* repo-meta.ts — users, audit log, preferences, and per-user grid layout.
 *
 * All Postgres. No DuckDB / warehouse access. */

import { randomUUID } from "node:crypto";
import {
  type User,
  type AuditEntry,
  type Preferences,
  type GridLayoutConfig,
  pgAll,
  pgGet,
  pgRun,
  pg,
} from "./repo-shared.ts";

/* ---- users & presence (Postgres) ---- */
export async function listUsers(): Promise<User[]> {
  return pgAll<User>(`SELECT id, name, initials FROM ${pg("users")} ORDER BY id`);
}

/* ---- audit (Postgres, append-only) ---- */
export async function appendAuditAs(
  userId: string,
  action: string,
  detail: string,
  ctx: {
    tableId?: string;
    rowKey?: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("audit_log")} (id, created_at, user_id, action, detail, table_id, row_key, tenant_id, metadata)
     VALUES ($1, current_timestamp, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      userId,
      action,
      detail,
      ctx.tableId ?? null,
      ctx.rowKey ?? null,
      ctx.tenantId ?? "default",
      ctx.metadata ? JSON.stringify(ctx.metadata) : null,
    ],
  );
}

export async function listAudit(limit = 30, tenantId: string = "default"): Promise<AuditEntry[]> {
  // tenantId === '*' is the super-admin cross-tenant feed.
  const where = tenantId === "*" ? "" : "WHERE tenant_id = $1";
  const params = tenantId === "*" ? [] : [tenantId];
  const cappedLimit = Math.max(1, Math.min(200, limit));
  const rows = await pgAll<{
    id: string;
    uid: string;
    action: string;
    detail: string;
    at: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, user_id AS uid, action, detail, metadata,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
     FROM ${pg("audit_log")} ${where}
     ORDER BY created_at DESC
     LIMIT ${cappedLimit}`,
    params,
  );
  if (rows.length === 0) return [];

  const uids = Array.from(new Set(rows.map((r) => r.uid)));
  const users = await pgAll<User>(
    `SELECT id, name, initials FROM ${pg("users")} WHERE id = ANY($1::text[])`,
    [uids],
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  const unknownUser: User = { id: "unknown", name: "Unknown", initials: "??" };

  return rows.map((r) => ({
    id: r.id,
    user: byId.get(r.uid) ?? unknownUser,
    action: r.action,
    detail: r.detail,
    at: r.at,
    metadata: r.metadata,
  }));
}

/* --- workspace-global preferences (one row per tenant) --- */
export async function getPreferences(tenantId: string = "default"): Promise<Preferences> {
  const row = await pgGet<{
    publish_threshold: number;
    suggest_threshold: number;
    scan_schedule: string | null;
    require_second_publisher: boolean;
  }>(
    `SELECT publish_threshold, suggest_threshold, scan_schedule, require_second_publisher
     FROM ${pg("preferences")}
     WHERE tenant_id = $1
     ORDER BY id LIMIT 1`,
    [tenantId],
  );
  const validSchedule = ["hourly", "daily"] as const;
  const sched = row?.scan_schedule ?? null;
  return {
    publishThreshold: row?.publish_threshold ?? 95,
    suggestThreshold: row?.suggest_threshold ?? 80,
    scanSchedule: validSchedule.includes(sched as (typeof validSchedule)[number])
      ? (sched as Preferences["scanSchedule"])
      : null,
    requireSecondPublisher: row?.require_second_publisher ?? false,
  };
}

export async function setPreferences(p: Preferences, tenantId: string = "default"): Promise<void> {
  const valid = p.scanSchedule === null || ["hourly", "daily"].includes(p.scanSchedule);
  if (!valid) throw new Error(`invalid scanSchedule: ${String(p.scanSchedule)}`);

  await pgRun(
    `INSERT INTO ${pg("preferences")}
       (publish_threshold, suggest_threshold, scan_schedule, updated_at, tenant_id, require_second_publisher)
     VALUES ($1, $2, $3, current_timestamp, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE
       SET publish_threshold        = EXCLUDED.publish_threshold,
           suggest_threshold        = EXCLUDED.suggest_threshold,
           scan_schedule            = EXCLUDED.scan_schedule,
           updated_at               = EXCLUDED.updated_at,
           require_second_publisher = EXCLUDED.require_second_publisher`,
    [p.publishThreshold, p.suggestThreshold, p.scanSchedule, tenantId, p.requireSecondPublisher ?? false],
  );
}

/* ---- per-user grid layout (column widths / order / hidden) ---- */
export async function getGridLayout(userId: string, dimId: string): Promise<GridLayoutConfig> {
  const row = await pgGet<{ config: string | null }>(
    `SELECT config FROM ${pg("user_grid_layout")} WHERE user_id = $1 AND dim_id = $2`,
    [userId, dimId],
  );
  if (!row?.config) return {};
  try {
    return JSON.parse(row.config) as GridLayoutConfig;
  } catch {
    return {};
  }
}

/** Upsert the full layout config for (user, dim). Caller sends a *complete*
 *  config; partial merging is the client's job (it knows what changed). */
export async function setGridLayout(
  userId: string,
  dimId: string,
  config: GridLayoutConfig,
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("user_grid_layout")} (user_id, dim_id, config, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, dim_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [userId, dimId, JSON.stringify(config)],
  );
}
