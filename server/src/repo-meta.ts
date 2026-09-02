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
  parseJsonbMeta,
} from "./repo-shared.ts";
import { presence } from "./realtime/presence-room.ts";

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
  // Best-effort activity push. Row-scoped writes carry tableId + rowKey; hint the room
  // so peers refetch instead of polling. A presence failure must never fail the write.
  if (ctx.tableId && ctx.rowKey) {
    try {
      presence.broadcastRowTouched(
        ctx.tableId,
        { type: "row_touched", rowKey: ctx.rowKey, userId },
        ctx.tenantId ?? "default",
      );
    } catch {
      /* transport down — the 60s client safety net covers it */
    }
  }
}

/** Server-side filters for the activity feed. `before` is a keyset cursor of
 *  the form "<at>|<id>" (the `at` + `id` of the last row already seen), so the
 *  feed paginates without OFFSET drift as new events land. */
export interface AuditFilter {
  actor?: string;
  q?: string;
  before?: string;
  /** Exact action-code match (the admin feed's event-type filter). */
  action?: string;
  /** Only actions taken under super-admin privilege (admin feed). */
  elevatedOnly?: boolean;
}

export async function listAudit(
  limit = 30,
  tenantId: string = "default",
  filter: AuditFilter = {},
): Promise<AuditEntry[]> {
  // Build the WHERE incrementally so filters compose. tenantId === '*' is the
  // super-admin cross-tenant feed (no tenant clause).
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (v: unknown): string => `$${params.push(v)}`;

  if (tenantId !== "*") clauses.push(`a.tenant_id = ${bind(tenantId)}`);
  if (filter.actor) clauses.push(`a.user_id = ${bind(filter.actor)}`);
  if (filter.action) clauses.push(`a.action = ${bind(filter.action)}`);
  if (filter.elevatedOnly) clauses.push(`a.metadata->>'actor_super_admin' = 'true'`);

  const q = filter.q?.trim();
  if (q) {
    const like = bind(`%${q}%`);
    clauses.push(`(a.action ILIKE ${like} OR a.detail ILIKE ${like} OR u.name ILIKE ${like})`);
  }

  // Keyset pagination: strictly older than the cursor tuple, matching the
  // (created_at DESC, id DESC) sort. Millisecond-precision cursor may rarely
  // skip a same-ms sibling at a page boundary — acceptable for an activity log.
  if (filter.before) {
    const [at, id] = filter.before.split("|");
    if (at && id) {
      clauses.push(`(a.created_at, a.id) < (${bind(at)}::timestamptz, ${bind(id)})`);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const cappedLimit = Math.max(1, Math.min(200, limit));

  const rows = await pgAll<{
    id: string;
    uid: string;
    action: string;
    detail: string;
    at: string;
    metadata: Record<string, unknown> | null;
    uname: string | null;
    uinitials: string | null;
  }>(
    `SELECT a.id, a.user_id AS uid, a.action, a.detail, a.metadata,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
            u.name AS uname, u.initials AS uinitials
     FROM ${pg("audit_log")} a
     LEFT JOIN ${pg("users")} u ON u.id = a.user_id
     ${where}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ${cappedLimit}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    user: { id: r.uid, name: r.uname ?? "Unknown", initials: r.uinitials ?? "??" },
    action: r.action,
    detail: r.detail,
    at: r.at,
    metadata: parseJsonbMeta(r.metadata),
  }));
}

/** Distinct action codes present in the feed, for the event-type picker.
 *  Sourced from the data (not visible rows) so the picker is complete.
 *  tenantId === '*' spans every workspace (super-admin feed). */
export async function listAuditActions(tenantId: string = "default"): Promise<string[]> {
  const where = tenantId === "*" ? "" : "WHERE tenant_id = $1";
  const params = tenantId === "*" ? [] : [tenantId];
  const rows = await pgAll<{ action: string }>(
    `SELECT DISTINCT action FROM ${pg("audit_log")} ${where} ORDER BY action`,
    params,
  );
  return rows.map((r) => r.action);
}

/* --- workspace-global preferences (one row per tenant) --- */
export async function getPreferences(tenantId: string = "default"): Promise<Preferences> {
  const row = await pgGet<{
    publish_threshold: number;
    suggest_threshold: number;
    scan_schedule: string | null;
    require_second_publisher: boolean;
    auto_publish_enabled: boolean;
  }>(
    `SELECT publish_threshold, suggest_threshold, scan_schedule, require_second_publisher,
            auto_publish_enabled
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
    autoPublishEnabled: row?.auto_publish_enabled ?? false,
  };
}

export async function setPreferences(p: Preferences, tenantId: string = "default"): Promise<void> {
  const valid = p.scanSchedule === null || ["hourly", "daily"].includes(p.scanSchedule);
  if (!valid) throw new Error(`invalid scanSchedule: ${String(p.scanSchedule)}`);

  await pgRun(
    `INSERT INTO ${pg("preferences")}
       (publish_threshold, suggest_threshold, scan_schedule, updated_at, tenant_id, require_second_publisher,
        auto_publish_enabled)
     VALUES ($1, $2, $3, current_timestamp, $4, $5, $6)
     ON CONFLICT (tenant_id) DO UPDATE
       SET publish_threshold        = EXCLUDED.publish_threshold,
           suggest_threshold        = EXCLUDED.suggest_threshold,
           scan_schedule            = EXCLUDED.scan_schedule,
           updated_at               = EXCLUDED.updated_at,
           require_second_publisher = EXCLUDED.require_second_publisher,
           auto_publish_enabled     = EXCLUDED.auto_publish_enabled`,
    [
      p.publishThreshold,
      p.suggestThreshold,
      p.scanSchedule,
      tenantId,
      p.requireSecondPublisher ?? false,
      p.autoPublishEnabled ?? false,
    ],
  );
}

/* ---- per-user grid layout (column widths / order / hidden) ---- */
export async function getGridLayout(userId: string, refTableId: string): Promise<GridLayoutConfig> {
  const row = await pgGet<{ config: string | null }>(
    `SELECT config FROM ${pg("user_grid_layout")} WHERE user_id = $1 AND reference_table_id = $2`,
    [userId, refTableId],
  );
  if (!row?.config) return {};
  try {
    return JSON.parse(row.config) as GridLayoutConfig;
  } catch {
    return {};
  }
}

/** Upsert the full layout config for (user, refTable). Caller sends a *complete*
 *  config; partial merging is the client's job (it knows what changed). */
export async function setGridLayout(
  userId: string,
  refTableId: string,
  config: GridLayoutConfig,
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("user_grid_layout")} (user_id, reference_table_id, config, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, reference_table_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [userId, refTableId, JSON.stringify(config)],
  );
}
