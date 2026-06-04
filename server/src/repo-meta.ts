/* repo-meta.ts — users, audit log, preferences, and per-user grid layout.
 *
 * All Postgres. No DuckDB / warehouse access. */

import { randomUUID } from "node:crypto";
import {
  type User,
  type AuditEntry,
  type Preferences,
  type GridLayoutConfig,
  rel,
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
export async function appendAuditAs(userId: string, action: string, detail: string): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("audit_log")} (id, created_at, user_id, action, detail)
     VALUES ($1, current_timestamp, $2, $3, $4)`,
    [randomUUID(), userId, action, detail],
  );
}

export async function listAudit(limit = 30): Promise<AuditEntry[]> {
  const rows = await pgAll<{
    id: string;
    uid: string;
    action: string;
    detail: string;
    secs: number;
  }>(
    `SELECT id, user_id AS uid, action, detail,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs
     FROM ${pg("audit_log")} ORDER BY created_at DESC
     LIMIT ${Math.max(1, Math.min(200, limit))}`,
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
    at: rel(Number(r.secs)),
  }));
}

/* --- workspace-global preferences (single row, id=1) --- */
export async function getPreferences(): Promise<Preferences> {
  const row = (
    await pgAll<{ publish_threshold: number; suggest_threshold: number }>(
      `SELECT publish_threshold, suggest_threshold FROM ${pg("preferences")} WHERE id = 1`,
    )
  )[0];
  return row
    ? {
        publishThreshold: Number(row.publish_threshold),
        suggestThreshold: Number(row.suggest_threshold),
      }
    : { publishThreshold: 95, suggestThreshold: 80 };
}

export async function setPreferences(p: Preferences): Promise<void> {
  const publish = Math.max(0, Math.min(100, Math.round(p.publishThreshold)));
  const suggest = Math.max(0, Math.min(publish, Math.round(p.suggestThreshold)));
  await pgRun(
    `UPDATE ${pg("preferences")} SET publish_threshold = $1, suggest_threshold = $2, updated_at = current_timestamp WHERE id = 1`,
    [publish, suggest],
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
