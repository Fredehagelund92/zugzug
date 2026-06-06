/* repo-drafts.ts — drafts + the commit fold.
 *
 * Drafts are Postgres-only staging rows; commit() folds them into the
 * canonical dim_/map_ tables atomically. The rowsForUnmappedDrafts helper
 * is a cross-store read (warehouse occurrences + Postgres drafts) used only
 * inside commit(). */

import {
  type Draft,
  type User,
  rel,
  qid,
  cq,
  liveSources,
  occUnion,
  all,
  pgAll,
  pgGet,
  pgRun,
  pgTx,
  pg,
} from "./repo-shared.ts";
import { appendAuditAs } from "./repo-meta.ts";

/* ---- drafts (Postgres) ---- */
export async function listDrafts(dimId: string): Promise<Draft[]> {
  const rows = await pgAll<{
    dimId: string;
    raw: string;
    status: "mapped" | "skipped";
    targetLabel: string | null;
    targetKey: string | null;
    uid: string;
    secs: number;
  }>(
    `SELECT dim_id AS "dimId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs
     FROM ${pg("draft")} WHERE dim_id = $1 ORDER BY created_at DESC`,
    [dimId],
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
    dimId: r.dimId,
    raw: r.raw,
    status: r.status,
    targetLabel: r.targetLabel,
    targetKey: r.targetKey,
    user: byId.get(r.uid) ?? unknownUser,
    at: rel(Number(r.secs)),
  }));
}

export async function saveDraft(
  dimId: string,
  raw: string,
  status: "mapped" | "skipped",
  targetLabel: string | null,
  targetKey: string | null,
  userId: string,
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("draft")} (dim_id, raw, status, target_label, target_key, user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp)
     ON CONFLICT (dim_id, raw, user_id) DO UPDATE
       SET status = EXCLUDED.status, target_label = EXCLUDED.target_label,
           target_key = EXCLUDED.target_key, created_at = EXCLUDED.created_at`,
    [dimId, raw, status, targetLabel, targetKey, userId],
  );
}

export async function discardDraft(dimId: string, raw: string, userId: string): Promise<void> {
  await pgRun(`DELETE FROM ${pg("draft")} WHERE dim_id = $1 AND raw = $2 AND user_id = $3`, [
    dimId,
    raw,
    userId,
  ]);
}

/** Approve & commit: fold the dimension's `mapped` drafts into Postgres dim_/map_
 *  in one atomic transaction, then clear them + audit. */
export async function commit(
  dimId: string,
  userId: string,
): Promise<{ committed: number; rowsRecovered: number }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; label: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", label
     FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
  if (!meta) return { committed: 0, rowsRecovered: 0 };
  const key = qid(meta.keyCol);
  const DRAFT = pg("draft");
  const DIMT = cq(meta.dimTable);
  const MAPT = cq(meta.mapTable);

  const approved = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${DRAFT}
     WHERE dim_id = $1 AND status = 'mapped' AND target_key IS NOT NULL`,
    [dimId],
  );
  const committed = Number(approved?.n ?? 0);
  if (!committed) return { committed: 0, rowsRecovered: 0 };

  const rowsRecovered = await rowsForUnmappedDrafts(dimId, meta.mapTable);

  await pgTx(async ({ run }) => {
    await run(
      `INSERT INTO ${DIMT} (${key}, label)
       SELECT DISTINCT d.target_key, d.target_label FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)`,
      [dimId],
    );
    await run(
      `INSERT INTO ${MAPT} (raw, ${key})
       SELECT d.raw, d.target_key FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${MAPT} m WHERE lower(m.raw) = lower(d.raw))`,
      [dimId],
    );
    await run(`DELETE FROM ${DRAFT} WHERE dim_id = $1 AND status = 'mapped'`, [dimId]);
  });

  await appendAuditAs(
    userId,
    "Committed",
    `${committed} value${committed === 1 ? "" : "s"} → ${meta.mapTable} · ${rowsRecovered.toLocaleString()} rows recovered`,
  );

  // Prune ai_hint_cache entries whose suggestion no longer matches a valid
  // canonical label (e.g. after a canonical record was deleted).
  const currentLabels = await pgAll<{ label: string }>(
    `SELECT label FROM ${cq(meta.dimTable)} WHERE label IS NOT NULL`,
  ).catch(() => [] as { label: string }[]);
  if (currentLabels.length > 0) {
    const labelArr = currentLabels.map((r) => r.label);
    await pgRun(
      `DELETE FROM ${pg("ai_hint_cache")}
       WHERE dim_id = $1 AND suggestion IS NOT NULL AND NOT (suggestion = ANY($2::text[]))`,
      [dimId, labelArr],
    ).catch(() => { /* table may not exist in older deploys */ });
  }

  return { committed, rowsRecovered };
}

/** Warehouse rows for raws that have a mapped draft but aren't yet in the map. */
async function rowsForUnmappedDrafts(dimId: string, mapTable: string): Promise<number> {
  const sources = await liveSources(dimId);
  if (!sources.length) return 0;

  // Warehouse: distinct raw values with total row counts
  const occRows = await all<{ raw: string; rows: bigint }>(occUnion(sources)).catch(
    () => [] as { raw: string; rows: bigint }[],
  );
  if (!occRows.length) return 0;

  // Postgres: draft raws for this dimension with status=mapped
  const draftRows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${pg("draft")} WHERE dim_id = $1 AND status = 'mapped'`,
    [dimId],
  );
  const draftSet = new Set(draftRows.map((r) => r.raw.toLowerCase()));

  // Postgres: already-mapped raws
  const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(mapTable)}`).catch(
    () => [] as { raw: string }[],
  );
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  // Sum rows for warehouse values that are in a draft but not yet mapped
  let total = 0;
  for (const r of occRows) {
    const lower = r.raw.toLowerCase();
    if (draftSet.has(lower) && !mappedSet.has(lower)) total += Number(r.rows);
  }
  return total;
}
