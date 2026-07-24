/* repo-activity.ts — derives per-row "last edited" entries from audit_log. */

import { pgAll, pg, parseJsonbMeta, type AuditEntry } from "./repo-shared.ts";

export type AuditOp = "rename" | "create" | "archive" | "field-write" | "merge" | "commit";

export type RowActivityEntry = {
  rowKey: string;
  userId: string;
  displayName: string;
  op: AuditOp;
  at: Date;
};

const ACTION_TO_OP: Record<string, AuditOp> = {
  "Added record": "create",
  "Renamed record": "rename",
  "Merged record": "merge",
  "Retired record": "archive",
  "Set field value": "field-write",
  "Committed mapping": "commit",
};

/** Per-row activity since `since` for a given record table. Scoped to the
 *  caller's tenant; pass `tenantId === "*"` from a super-admin context to read
 *  across all tenants (cross-tenant feed). */
export async function getRowActivitySince(
  tableId: string,
  since: Date,
  tenantId: string,
): Promise<RowActivityEntry[]> {
  const isCrossTenant = tenantId === "*";
  const tenantFilter = isCrossTenant ? "" : " AND a.tenant_id = $3";
  const params: unknown[] = isCrossTenant ? [tableId, since] : [tableId, since, tenantId];

  const rows = await pgAll<{
    row_key: string;
    user_id: string;
    name: string | null;
    action: string;
    created: Date;
  }>(
    `SELECT DISTINCT ON (a.row_key)
       a.row_key, a.user_id, u.name, a.action, a.created_at AS created
     FROM ${pg("audit_log")} a
     LEFT JOIN ${pg("users")} u ON u.id = a.user_id
     WHERE a.table_id = $1
       AND a.row_key IS NOT NULL
       AND a.created_at > $2${tenantFilter}
     ORDER BY a.row_key, a.created_at DESC`,
    params,
  );

  return rows.map((r) => ({
    rowKey: r.row_key,
    userId: r.user_id,
    displayName: r.name ?? "Unknown",
    op: ACTION_TO_OP[r.action] ?? "field-write",
    at: r.created,
  }));
}

export interface RecordHistoryPage {
  entries: AuditEntry[];
  /** Keyset cursor ("<at>|<id>") to pass as `before` for the next page, or null
   *  when this page reached the end. */
  nextCursor: string | null;
}

/** Full change history for one record, newest first, keyset-paginated. Reads the
 *  `(table_id, row_key, created_at DESC)` index directly, so it stays cheap no
 *  matter how large the workspace-wide log grows. Scoped to the caller's tenant;
 *  `tenantId === "*"` (super-admin) spans every workspace. */
export async function listRecordHistory(
  tableId: string,
  rowKey: string,
  tenantId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<RecordHistoryPage> {
  const clauses = ["a.table_id = $1", "a.row_key = $2"];
  const params: unknown[] = [tableId, rowKey];
  const bind = (v: unknown): string => `$${params.push(v)}`;

  if (tenantId !== "*") clauses.push(`a.tenant_id = ${bind(tenantId)}`);

  // Keyset pagination on (created_at DESC, id DESC), matching listAudit so the
  // feed never drifts as new events land mid-scroll.
  if (opts.before) {
    const [at, id] = opts.before.split("|");
    if (at && id) {
      clauses.push(`(a.created_at, a.id) < (${bind(at)}::timestamptz, ${bind(id)})`);
    }
  }

  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

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
     WHERE ${clauses.join(" AND ")}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ${limit + 1}`,
    params,
  );

  // Over-fetch by one to learn whether another page exists without a COUNT.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.at}|${last.id}` : null;

  return {
    entries: page.map((r) => ({
      id: r.id,
      user: { id: r.uid, name: r.uname ?? "Unknown", initials: r.uinitials ?? "??" },
      action: r.action,
      detail: r.detail,
      at: r.at,
      metadata: parseJsonbMeta(r.metadata),
    })),
    nextCursor,
  };
}
