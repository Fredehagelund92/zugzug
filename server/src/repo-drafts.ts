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
  parseSourceTable,
  pgAll,
  pgGet,
  pgRun,
  pgTx,
  pg,
} from "./repo-shared.ts";
import { appendAuditAs } from "./repo-meta.ts";
import { getAdapter } from "./warehouse/registry.ts";
import { isWritable } from "./warehouse/adapter.ts";
import type { ValueProvenance } from "./warehouse/adapter.ts";

/* ---- drafts (Postgres) ---- */
export async function listDrafts(dimId: string, tenantId: string): Promise<Draft[]> {
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
     FROM ${pg("draft")} WHERE dim_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [dimId, tenantId],
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
  tenantId: string,
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("draft")} (dim_id, raw, status, target_label, target_key, user_id, created_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp, $7)
     ON CONFLICT (dim_id, raw, user_id) DO UPDATE
       SET status = EXCLUDED.status, target_label = EXCLUDED.target_label,
           target_key = EXCLUDED.target_key, created_at = EXCLUDED.created_at,
           tenant_id = EXCLUDED.tenant_id`,
    [dimId, raw, status, targetLabel, targetKey, userId, tenantId],
  );
}

export async function discardDraft(
  dimId: string,
  raw: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  await pgRun(
    `DELETE FROM ${pg("draft")} WHERE dim_id = $1 AND raw = $2 AND user_id = $3 AND tenant_id = $4`,
    [dimId, raw, userId, tenantId],
  );
  await appendAuditAs(userId, "discard_draft", `${dimId}: ${raw}`, { tenantId });
}

/** Approve & commit: fold the dimension's `mapped` drafts into Postgres dim_/map_
 *  in one atomic transaction, then clear them + audit. */
export async function commit(
  dimId: string,
  userId: string,
  tenantId: string,
): Promise<{
  committed: number;
  rowsRecovered: number;
  warehouseSynced: "n/a" | "synced" | "failed";
}> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; label: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", label
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) return { committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" };
  const key = qid(meta.keyCol);
  const DRAFT = pg("draft");
  const DIMT = cq(meta.dimTable);
  const MAPT = cq(meta.mapTable);

  const approved = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${DRAFT}
     WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL`,
    [dimId, tenantId],
  );
  const committed = Number(approved?.n ?? 0);
  if (!committed) return { committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" };

  const rowsRecovered = await rowsForUnmappedDrafts(dimId, tenantId, meta.mapTable);

  // Capture distinct target_keys BEFORE the tx so they're available after
  // the draft rows are deleted inside the transaction.
  const committedRows = await pgAll<{ target_key: string }>(
    `SELECT DISTINCT target_key FROM ${DRAFT}
     WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL`,
    [dimId, tenantId],
  );

  // Snapshot approved drafts BEFORE the tx so we can pass them to the
  // warehouse adapter after the Postgres commit succeeds.
  const approvedDrafts = await pgAll<{ raw: string; key: string; label: string | null }>(
    `SELECT raw, target_key AS key, target_label AS label FROM ${DRAFT}
     WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL`,
    [dimId, tenantId],
  );

  // PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL
  // stays per-tenant-implicit (dim ids are globally unique → effectively
  // per-tenant via the dimension registry's WHERE tenant_id = $N gate above).
  await pgTx(async ({ run }) => {
    await run(
      `INSERT INTO ${DIMT} (${key}, label)
       SELECT DISTINCT d.target_key, d.target_label FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)`,
      [dimId, tenantId],
    );
    await run(
      `INSERT INTO ${MAPT} (raw, ${key})
       SELECT d.raw, d.target_key FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${MAPT} m WHERE lower(m.raw) = lower(d.raw))`,
      [dimId, tenantId],
    );
    await run(`DELETE FROM ${DRAFT} WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped'`, [
      dimId,
      tenantId,
    ]);
  });

  // Per-row audit: one entry per distinct target_key so each canonical row
  // gets a "Mia · 3m ago" badge in the activity feed.
  for (const row of committedRows) {
    await appendAuditAs(userId, "Committed mapping", `→ ${row.target_key}`, {
      tableId: dimId,
      rowKey: row.target_key,
      tenantId,
    });
  }

  await appendAuditAs(
    userId,
    "Committed",
    `${committed} value${committed === 1 ? "" : "s"} → ${meta.mapTable} · ${rowsRecovered.toLocaleString()} rows recovered`,
    { tenantId },
  );

  // After Postgres commit: if the warehouse adapter is writable, attempt the
  // warehouse MERGE. Failures log + surface but don't roll back Postgres.
  let warehouseSynced: "n/a" | "synced" | "failed" = "n/a";
  const adapter = await getAdapter();
  if (isWritable(adapter)) {
    const dimSpec = {
      dimId,
      dimTable: meta.dimTable,
      mapTable: meta.mapTable,
      keyCol: meta.keyCol,
    };
    try {
      await adapter.ensureCanonicalTables(dimSpec);
      await adapter.commitCanonical(dimSpec, approvedDrafts);
      await appendAuditAs(userId, "Warehouse synced", `${committed} → ${meta.mapTable}`, {
        tenantId,
      });
      warehouseSynced = "synced";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendAuditAs(
        userId,
        "Warehouse sync failed",
        `${committed} → ${meta.mapTable}: ${msg}`,
        { tenantId },
      );
      warehouseSynced = "failed";
    }
  }

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
    ).catch(() => {
      /* table may not exist in older deploys */
    });
  }

  return { committed, rowsRecovered, warehouseSynced };
}

/** Warehouse rows for raws that have a mapped draft but aren't yet in the map. */
async function rowsForUnmappedDrafts(
  dimId: string,
  tenantId: string,
  mapTable: string,
): Promise<number> {
  const sources = await liveSources(dimId, tenantId);
  if (!sources.length) return 0;

  // Warehouse: distinct raw values with per-source row counts.
  // Multiple sources may emit the same raw — we sum counts when summing total rows below
  // (matches the original UNION-ALL pattern's semantics: count each source-occurrence once).
  const adapter = await getAdapter();
  const refs = sources.map((s) => ({ table: parseSourceTable(s.table), column: s.column }));
  const provenance = await adapter
    .distinctValuesWithProvenance(refs)
    .catch(() => [] as ValueProvenance[]);
  if (!provenance.length) return 0;

  // Postgres: draft raws for this dimension with status=mapped
  const draftRows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${pg("draft")} WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped'`,
    [dimId, tenantId],
  );
  const draftSet = new Set(draftRows.map((r) => r.raw.toLowerCase()));

  // Postgres: already-mapped raws
  const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(mapTable)}`).catch(
    () => [] as { raw: string }[],
  );
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  // Sum rows for warehouse values that are in a draft but not yet mapped.
  // Iterate per-occurrence (not per-distinct-raw) to preserve the original UNION-ALL sum.
  let total = 0;
  for (const p of provenance) {
    const lower = p.value.toLowerCase();
    if (draftSet.has(lower) && !mappedSet.has(lower)) total += p.count;
  }
  return total;
}
