/* repo-versions.ts — refTable version snapshots.
 *
 * writeVersionSnapshot() runs INSIDE commit()'s transaction so the snapshot
 * and the version counter are atomic. listVersions() and getSnapshot() are
 * plain read helpers used by the route and Task 5 (rollback). */

import { pg, cq, qid } from "./repo-shared.ts";
import { pgAll, pgGet } from "./pg.ts";
import type { TxHelpers } from "./pg.ts";

export interface VersionInfo {
  version: number;
  kind: "publish" | "rollback";
  restoresVersion: number | null;
  publishedBy: string;
  publishedByName: string;
  at: string;
  counts: { records: number; mappings: number };
  hasSnapshot: true;
}

export interface Snapshot {
  records: Array<Record<string, unknown>>; // full row objects incl. dynamic attribute columns
  mappings: Array<{ raw: string; targetKey: string }>;
}

/** Capture the just-published content. Runs INSIDE commit()'s transaction so the
 *  snapshot and the version counter are atomic. Dynamic attribute columns are
 *  captured via to_jsonb(t) — the snapshot is schema-agnostic. */
export async function writeVersionSnapshot(
  tx: TxHelpers,
  p: {
    tenantId: string;
    refTableId: string;
    version: number;
    kind: "publish" | "rollback";
    restoresVersion: number | null;
    publishedBy: string;
    dimTable: string;
    mapTable: string;
    keyCol: string;
  },
): Promise<void> {
  // to_jsonb(t) captures dynamic attribute columns; driver returns the parsed object directly.
  const recordRows = await tx.all<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS row FROM ${cq(p.dimTable)} t`,
  );
  const mappings = await tx.all<{ raw: string; targetKey: string }>(
    `SELECT raw, ${qid(p.keyCol)} AS "targetKey" FROM ${cq(p.mapTable)}`,
  );
  const snapshot: Snapshot = {
    records: recordRows.map((r) => r.row),
    mappings,
  };
  await tx.run(
    `INSERT INTO ${pg("reference_table_version")}
       (id, tenant_id, reference_table_id, version, kind, restores_version, snapshot, published_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      `dv_${crypto.randomUUID().replace(/-/g, "")}`,
      p.tenantId,
      p.refTableId,
      p.version,
      p.kind,
      p.restoresVersion,
      // Pass the object directly — postgres.js serializes it once.
      // Pre-stringifying double-encodes it as a jsonb *string* (same bug as
      // dispatchOutbound had; see repo-outbound-events.ts comment).
      snapshot,
      p.publishedBy,
    ],
  );
}

export async function listVersions(refTableId: string, tenantId: string): Promise<VersionInfo[]> {
  const rows = await pgAll<{
    version: number;
    kind: "publish" | "rollback";
    restoresVersion: number | null;
    publishedBy: string;
    publishedByName: string;
    at: string;
    counts: { records: number; mappings: number } | string;
    hasSnapshot: boolean;
  }>(
    `SELECT v.version, v.kind, v.restores_version AS "restoresVersion",
            v.published_by AS "publishedBy", COALESCE(u.name, v.published_by) AS "publishedByName",
            v.created_at AS at,
            json_build_object(
              'records', jsonb_array_length(v.snapshot->'records'),
              'mappings', jsonb_array_length(v.snapshot->'mappings')
            ) AS counts,
            true AS "hasSnapshot"
     FROM ${pg("reference_table_version")} v
     LEFT JOIN ${pg("users")} u ON u.id = v.published_by
     WHERE v.reference_table_id = $1 AND v.tenant_id = $2
     ORDER BY v.version DESC`,
    [refTableId, tenantId],
  );
  // counts may come back as a JSON string from some drivers — parse defensively.
  return rows.map((r) => ({
    ...r,
    counts:
      typeof r.counts === "string"
        ? (JSON.parse(r.counts) as { records: number; mappings: number })
        : r.counts,
    hasSnapshot: true as const,
  }));
}

export async function getSnapshot(
  refTableId: string,
  tenantId: string,
  version: number,
): Promise<Snapshot | null> {
  const row = await pgGet<{ snapshot: Snapshot | string }>(
    `SELECT snapshot FROM ${pg("reference_table_version")}
     WHERE reference_table_id = $1 AND tenant_id = $2 AND version = $3`,
    [refTableId, tenantId, version],
  );
  if (!row) return null;
  const snap = row.snapshot;
  return typeof snap === "string" ? (JSON.parse(snap) as Snapshot) : snap;
}
