/* repo-activity.ts — derives per-row "last edited" entries from audit_log. */

import { pgAll, pg } from "./repo-shared.ts";

export type AuditOp = "rename" | "create" | "archive" | "field-write" | "merge" | "commit";

export type RowActivityEntry = {
  rowKey: string;
  userId: string;
  displayName: string;
  op: AuditOp;
  at: Date;
};

const ACTION_TO_OP: Record<string, AuditOp> = {
  "Added canonical": "create",
  "Renamed canonical": "rename",
  "Merged canonical": "merge",
  "Retired canonical": "archive",
  "Set field value": "field-write",
  "Committed mapping": "commit",
};

export async function getRowActivitySince(
  tableId: string,
  since: Date,
): Promise<RowActivityEntry[]> {
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
       AND a.created_at > $2
     ORDER BY a.row_key, a.created_at DESC`,
    [tableId, since],
  );

  return rows.map((r) => ({
    rowKey: r.row_key,
    userId: r.user_id,
    displayName: r.name ?? "Unknown",
    op: ACTION_TO_OP[r.action] ?? "field-write",
    at: r.created,
  }));
}
