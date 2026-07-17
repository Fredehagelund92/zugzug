/* repo-rollback.ts — rollback a dimension to a previously-snapshotted version.
 *
 * Strategy:
 *  1. Fetch the target snapshot (getSnapshot).
 *  2. In a Postgres transaction: DELETE canonical dim_/map_ rows, reinsert from
 *     snapshot, and update canonical_version so changedKeysSince() sees the delta.
 *  3. Call commit(dimId, userId, tenantId, [], {kind:'rollback', restoresVersion})
 *     which writes the new version row and outbound event.  Empty draftKeys means
 *     "fold no drafts, publish record state only" — the canonical_version touch in
 *     step 2 makes changedKeysSince report changes so the early-return is bypassed.
 *  4. Handle warehouse sync manually (adapter.commitCanonical doesn't delete stale
 *     rows, so we call it with the full snapshot content after the Postgres commit). */

import { qid, cq, pgGet, pgTx, pg } from "./repo-shared.ts";
import { getSnapshot } from "./repo-versions.ts";
import { commit } from "./repo-drafts.ts";
import { AppError } from "./errors.ts";
import { getAdapter } from "./warehouse/registry.ts";
import { isWritable } from "./warehouse/adapter.ts";
import { appendAuditAs } from "./repo-meta.ts";

export async function rollbackToVersion(
  dimId: string,
  tenantId: string,
  toVersion: number,
  userId: string,
): Promise<{
  committed: number;
  rowsRecovered: number;
  warehouseSynced: "n/a" | "synced-additive" | "failed";
  restoredVersion: number;
}> {
  const snap = await getSnapshot(dimId, tenantId, toVersion);
  if (!snap) {
    throw new AppError("NO_SNAPSHOT", `no snapshot for version ${toVersion}`, 409);
  }

  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) {
    throw new AppError("NOT_FOUND", `dimension ${dimId} not found`, 404);
  }

  // Build the set of keys present in the snapshot so we can retire ghost keys.
  const snapKeySet = new Set(snap.records.map((r) => String(r[meta.keyCol] ?? "")));

  await pgTx(async (tx) => {
    // 1. Wipe current canonical rows (dim_ then map_ to avoid FK issues if any).
    await tx.run(`DELETE FROM ${cq(meta.mapTable)}`);
    await tx.run(`DELETE FROM ${cq(meta.dimTable)}`);

    // 2. Reinsert snapshot records, intersecting against live schema to handle
    //    schema drift (extra columns added after the snapshot was taken are skipped).
    const cols = await tx.all<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [meta.dimTable.split(".")[0]!, meta.dimTable.split(".")[1]!],
    );
    const colSet = new Set(cols.map((c) => c.column_name));
    for (const rec of snap.records) {
      const keys = Object.keys(rec).filter((k) => colSet.has(k));
      if (keys.length === 0) continue;
      await tx.run(
        `INSERT INTO ${cq(meta.dimTable)} (${keys.map(qid).join(", ")})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
        keys.map((k) => rec[k]),
      );
    }

    // 3. Reinsert snapshot mappings.
    for (const m of snap.mappings) {
      await tx.run(`INSERT INTO ${cq(meta.mapTable)} (raw, ${qid(meta.keyCol)}) VALUES ($1, $2)`, [
        m.raw,
        m.targetKey,
      ]);
    }

    // 4. canonical_version bookkeeping so changedKeysSince sees the restore:
    //    - Upsert rows for snapshot keys (updates updated_at = now() → seen as changed).
    //    - Soft-retire rows for keys absent from the snapshot (updates retired_at = now()).
    for (const key of snapKeySet) {
      await tx.run(
        `INSERT INTO "zugzug_app"."canonical_version"
           (dim_id, key, version, updated_at, updated_by, tenant_id)
         VALUES ($1, $2, 1, now(), $3, $4)
         ON CONFLICT (tenant_id, dim_id, key) DO UPDATE
            SET retired_at   = NULL,
                retired_into = NULL,
                version      = "canonical_version".version + 1,
                updated_at   = now(),
                updated_by   = EXCLUDED.updated_by`,
        [dimId, key, userId, tenantId],
      );
    }
    // Retire any keys that existed before but aren't in the snapshot.
    await tx.run(
      `UPDATE "zugzug_app"."canonical_version"
          SET retired_at = now(), retired_into = NULL
        WHERE dim_id = $1 AND tenant_id = $2
          AND retired_at IS NULL
          AND key <> ALL($3::text[])`,
      [dimId, tenantId, [...snapKeySet]],
    );
  });

  // 5. Call commit with empty draftKeys — the canonical_version touch above
  //    ensures changedKeysSince returns changes, bypassing the early-return.
  //    skipWarehouseSync=true prevents commit()'s warehouse block from firing
  //    (it would report "synced" on empty drafts — a false signal); rollback
  //    owns the warehouse step below.
  const res = await commit(dimId, userId, tenantId, [], {
    kind: "rollback",
    restoresVersion: toVersion,
    skipWarehouseSync: true,
  });

  // 6. Warehouse sync: commitCanonical is INSERT-only (cannot delete stale rows),
  //    so this sync is additive — rows from the reverted version may remain.
  //    We pass ALL snapshot records so the adapter MERGEs the full restored state.
  let warehouseSynced: "n/a" | "synced-additive" | "failed" = "n/a";
  const adapter = await getAdapter();
  if (isWritable(adapter)) {
    const dimSpec = {
      dimId,
      dimTable: meta.dimTable,
      mapTable: meta.mapTable,
      keyCol: meta.keyCol,
    };
    // Build ApprovedDraft-shaped objects from snapshot records + mappings so the
    // adapter can MERGE them. Each mapping carries a key and label from the record.
    const keyToLabel = new Map<string, string | null>(
      snap.records.map((r) => [
        String(r[meta.keyCol] ?? ""),
        r.label != null ? String(r.label) : null,
      ]),
    );
    const approvedDrafts = snap.mappings.map((m) => ({
      raw: m.raw,
      key: m.targetKey,
      label: keyToLabel.get(m.targetKey) ?? null,
    }));
    try {
      await adapter.ensureCanonicalTables(dimSpec);
      await adapter.commitCanonical(dimSpec, approvedDrafts);
      await appendAuditAs(
        userId,
        "Warehouse rollback sync",
        `additive — rows added by the reverted version may remain; manual resync recommended`,
        { tenantId },
      );
      warehouseSynced = "synced-additive";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendAuditAs(
        userId,
        "Warehouse sync failed (rollback)",
        `→ ${meta.mapTable}: ${msg}`,
        { tenantId },
      );
      warehouseSynced = "failed";
    }
  }

  return {
    committed: res.committed,
    rowsRecovered: res.rowsRecovered,
    warehouseSynced,
    restoredVersion: toVersion,
  };
}
