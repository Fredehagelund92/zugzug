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
  pgAll,
  pgGet,
  pgRun,
  pgTx,
  pg,
  parseFieldConfig,
} from "./repo-shared.ts";
import { appendAuditAs, getPreferences } from "./repo-meta.ts";
import { writeVersionSnapshot } from "./repo-versions.ts";
import { AppError } from "./errors.ts";
import { dispatchOutbound } from "./repo-outbound-events.ts";
import { getAdapter } from "./warehouse/registry.ts";
import { isWritable } from "./warehouse/adapter.ts";

/* ---- drafts (Postgres) ---- */
export async function listDrafts(dimId: string, tenantId: string): Promise<Draft[]> {
  const rows = await pgAll<{
    dimId: string;
    raw: string;
    status: "mapped" | "skipped" | "rejected";
    targetLabel: string | null;
    targetKey: string | null;
    uid: string;
    secs: number;
    source: "user" | "ai";
    confidence: "high" | "medium" | "low" | null;
    reasoning: string | null;
    rejectedReason: string | null;
    rejectedBy: string | null;
  }>(
    `SELECT dim_id AS "dimId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs,
            source, confidence, reasoning,
            rejected_reason AS "rejectedReason", rejected_by AS "rejectedBy"
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
    source: r.source,
    confidence: r.confidence,
    reasoning: r.reasoning,
    rejectedReason: r.rejectedReason,
    rejectedBy: r.rejectedBy,
  }));
}

export async function listAllDrafts(tenantId: string): Promise<Draft[]> {
  const rows = await pgAll<{
    dimId: string;
    raw: string;
    status: "mapped" | "skipped" | "rejected";
    targetLabel: string | null;
    targetKey: string | null;
    uid: string;
    secs: number;
    source: "user" | "ai";
    confidence: "high" | "medium" | "low" | null;
    reasoning: string | null;
    rejectedReason: string | null;
    rejectedBy: string | null;
  }>(
    `SELECT dim_id AS "dimId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs,
            source, confidence, reasoning,
            rejected_reason AS "rejectedReason", rejected_by AS "rejectedBy"
     FROM ${pg("draft")} WHERE tenant_id = $1 ORDER BY dim_id, created_at DESC`,
    [tenantId],
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
    source: r.source,
    confidence: r.confidence,
    reasoning: r.reasoning,
    rejectedReason: r.rejectedReason,
    rejectedBy: r.rejectedBy,
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
     ON CONFLICT (tenant_id, dim_id, raw, user_id) DO UPDATE
       SET status = EXCLUDED.status, target_label = EXCLUDED.target_label,
           target_key = EXCLUDED.target_key, created_at = EXCLUDED.created_at,
           rejected_reason = NULL, rejected_by = NULL`,
    [dimId, raw, status, targetLabel, targetKey, userId, tenantId],
  );
}

/** Input shape for `createDraft` — the AI-suggestion-aware draft creator.
 *  Unlike `saveDraft`, this carries provenance metadata (`source`, `confidence`,
 *  `reasoning`) so AI-generated proposals are distinguishable from user edits. */
export interface CreateDraftInput {
  dim_id: string;
  raw: string;
  target_label?: string | null;
  target_key?: string | null;
  source?: "user" | "ai";
  confidence?: "high" | "medium" | "low" | null;
  reasoning?: string | null;
  status?: "mapped" | "skipped";
}

/** Insert (or upsert) a draft row, capturing AI provenance when present.
 *  Returns the persisted row including provenance columns. */
export async function createDraft(
  input: CreateDraftInput,
  userId: string,
  tenantId: string,
): Promise<
  Draft & {
    source: "user" | "ai";
    confidence: "high" | "medium" | "low" | null;
    reasoning: string | null;
  }
> {
  const {
    dim_id,
    raw,
    target_label = null,
    target_key = null,
    source = "user",
    confidence = null,
    reasoning = null,
    status = "mapped",
  } = input;

  await pgRun(
    `INSERT INTO ${pg("draft")}
       (dim_id, raw, status, target_label, target_key, user_id, created_at, tenant_id,
        source, confidence, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, dim_id, raw, user_id) DO UPDATE SET
       status          = EXCLUDED.status,
       target_label    = EXCLUDED.target_label,
       target_key      = EXCLUDED.target_key,
       created_at      = EXCLUDED.created_at,
       source          = EXCLUDED.source,
       confidence      = EXCLUDED.confidence,
       reasoning       = EXCLUDED.reasoning,
       rejected_reason = NULL,
       rejected_by     = NULL`,
    [
      dim_id,
      raw,
      status,
      target_label,
      target_key,
      userId,
      tenantId,
      source,
      confidence,
      reasoning,
    ],
  );

  const row = await pgGet<{
    dimId: string;
    raw: string;
    status: "mapped" | "skipped";
    targetLabel: string | null;
    targetKey: string | null;
    uid: string;
    secs: number;
    source: "user" | "ai";
    confidence: "high" | "medium" | "low" | null;
    reasoning: string | null;
  }>(
    `SELECT dim_id AS "dimId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs,
            source, confidence, reasoning
       FROM ${pg("draft")}
      WHERE tenant_id = $1 AND dim_id = $2 AND raw = $3 AND user_id = $4
      LIMIT 1`,
    [tenantId, dim_id, raw, userId],
  );
  if (!row) {
    throw new Error(`createDraft: failed to read back inserted draft ${dim_id}/${raw}`);
  }

  const user = await pgGet<User>(`SELECT id, name, initials FROM ${pg("users")} WHERE id = $1`, [
    row.uid,
  ]);

  return {
    dimId: row.dimId,
    raw: row.raw,
    status: row.status,
    targetLabel: row.targetLabel,
    targetKey: row.targetKey,
    user: user ?? { id: row.uid, name: "Unknown", initials: "??" },
    at: rel(Number(row.secs)),
    source: row.source,
    confidence: row.confidence,
    reasoning: row.reasoning,
    rejectedReason: null,
    rejectedBy: null,
  };
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

export async function rejectDrafts(
  dimId: string,
  tenantId: string,
  raws: string[],
  reason: string,
  reviewerId: string,
): Promise<{ rejected: number }> {
  const trimmed = reason.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "a rejection reason is required", 400);
  if (raws.length === 0) return { rejected: 0 };
  const res = await pgAll<{ raw: string }>(
    `UPDATE ${pg("draft")}
        SET status = 'rejected', rejected_reason = $4, rejected_by = $5
      WHERE dim_id = $1 AND tenant_id = $2 AND raw = ANY($3) AND status = 'mapped'
      RETURNING raw`,
    [dimId, tenantId, raws, trimmed, reviewerId],
  );
  const n = res.length;
  await appendAuditAs(reviewerId, "Rejected drafts", `${n} in ${dimId}: ${trimmed}`, {
    tenantId,
    tableId: dimId,
  });
  return { rejected: n };
}

export interface PublishState {
  /** Latest published version; 0 = never published. */
  version: number;
  publishedAt: string | null;
  publishedByName: string | null;
  /** Staged mapping drafts awaiting publish. */
  pendingDrafts: number;
  /** Canonical keys edited, added, or retired since the last publish (ADR-0002:
   *  derived from canonical_version, not a staging queue). Keys created by
   *  draft folding don't appear here — they go out in the same publish. */
  changedKeys: string[];
  /** True when a published snapshot exists to revert the working copy to. */
  canRevert: boolean;
}

/** Latest version with a usable record snapshot (legacy double-encoded
 *  snapshots are skipped — reverting against those would drop rows). */
async function latestSnapshotVersion(dimId: string, tenantId: string): Promise<number | null> {
  const row = await pgGet<{ version: number }>(
    `SELECT version FROM ${pg("dimension_version")}
     WHERE dim_id = $1 AND tenant_id = $2 AND jsonb_typeof(snapshot->'records') = 'array'
     ORDER BY version DESC LIMIT 1`,
    [dimId, tenantId],
  );
  return row ? Number(row.version) : null;
}

/** Stable serialisation of a flat to_jsonb row for value comparison. */
function canonRow(row: unknown): string {
  const o = (typeof row === "string" ? JSON.parse(row) : row) as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
}

/** Record keys with unpublished changes. Never published → every record (the
 *  first publish ships the whole table). Otherwise: keys stamped in
 *  canonical_version since the last publish, minus records whose values are
 *  back to identical with the last snapshot — so reverting an edit clears it. */
async function changedKeysSince(
  dimId: string,
  tenantId: string,
  since: Date | null,
  meta: { dimTable: string; keyCol: string },
): Promise<string[]> {
  if (!since) {
    const rows = await pgAll<{ key: string }>(
      `SELECT ${qid(meta.keyCol)}::text AS key FROM ${cq(meta.dimTable)} ORDER BY 1`,
    );
    return rows.map((r) => r.key);
  }
  const stamped = await pgAll<{ key: string }>(
    `SELECT key FROM ${pg("canonical_version")}
     WHERE dim_id = $1 AND tenant_id = $2
       AND (updated_at > $3 OR retired_at > $3)
     ORDER BY key`,
    [dimId, tenantId, since],
  );
  if (stamped.length === 0) return [];
  const keys = stamped.map((r) => r.key);

  // Legacy double-encoded snapshots yield no rows here → every stamped key
  // counts as changed, which degrades to the pre-diff behaviour.
  const snapRows = await pgAll<{ key: string; row: unknown }>(
    `SELECT e.rec->>$4 AS key, e.rec AS row
       FROM ${pg("dimension_version")} v
       CROSS JOIN LATERAL jsonb_array_elements(v.snapshot->'records') AS e(rec)
      WHERE v.dim_id = $1 AND v.tenant_id = $2
        AND v.version = (SELECT max(version) FROM ${pg("dimension_version")}
                          WHERE dim_id = $1 AND tenant_id = $2)
        AND e.rec->>$4 = ANY($3)`,
    [dimId, tenantId, keys, meta.keyCol],
  );
  const curRows = await pgAll<{ key: string; row: unknown }>(
    `SELECT ${qid(meta.keyCol)}::text AS key, to_jsonb(t) AS row
       FROM ${cq(meta.dimTable)} t
      WHERE ${qid(meta.keyCol)}::text = ANY($1)`,
    [keys],
  );
  const snapBy = new Map(snapRows.map((r) => [r.key, canonRow(r.row)]));
  const curBy = new Map(curRows.map((r) => [r.key, canonRow(r.row)]));
  return keys.filter((k) => {
    const before = snapBy.get(k);
    const now = curBy.get(k);
    if (before === undefined && now === undefined) return false; // added then removed — nets out
    return before !== now; // added, retired, or values still differ
  });
}

export async function getPublishState(dimId: string, tenantId: string): Promise<PublishState> {
  const dimMeta = await pgGet<{ dimTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  const last = await pgGet<{ v: number; at: Date | null }>(
    `SELECT count(*)::int AS v, max(occurred_at) AS at
     FROM ${pg("outbound_event")}
     WHERE tenant_id = $1 AND dim_id = $2 AND type = 'table.published'`,
    [tenantId, dimId],
  );
  const version = Number(last?.v ?? 0);
  const publishedAt = last?.at ?? null;
  let publishedByName: string | null = null;
  if (version > 0) {
    // Legacy rows (pre double-encoding fix) hold payload as a jsonb string —
    // unwrap with #>> '{}' before descending in that case.
    const latest = await pgGet<{ by: string | null }>(
      `SELECT CASE WHEN jsonb_typeof(payload) = 'string'
                   THEN (payload #>> '{}')::jsonb->'committed_by'->>'name'
                   ELSE payload->'committed_by'->>'name' END AS by
       FROM ${pg("outbound_event")}
       WHERE tenant_id = $1 AND dim_id = $2 AND type = 'table.published'
       ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId, dimId],
    );
    publishedByName = latest?.by ?? null;
  }
  const pending = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${pg("draft")}
     WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL`,
    [dimId, tenantId],
  );
  return {
    version,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    publishedByName,
    pendingDrafts: Number(pending?.n ?? 0),
    changedKeys: dimMeta ? await changedKeysSince(dimId, tenantId, publishedAt, dimMeta) : [],
    canRevert: version > 0 && (await latestSnapshotVersion(dimId, tenantId)) !== null,
  };
}

/** Count-only publish summary for the dimension list (ADR-0005). Reuses
 *  getPublishState so "what's waiting" stays defined in exactly one place. */
export async function publishSummaryFor(
  dimId: string,
  tenantId: string,
): Promise<import("./repo-shared.ts").PublishSummary> {
  const s = await getPublishState(dimId, tenantId);
  return {
    version: s.version,
    publishedAt: s.publishedAt,
    publishedByName: s.publishedByName,
    pendingDrafts: s.pendingDrafts,
    changedRecords: s.changedKeys.length,
  };
}

/** Restore every record with unpublished changes back to the last published
 *  snapshot: edited records get their published values, records added since
 *  are removed, records removed since come back. Mapping drafts are untouched. */
export async function revertToPublished(
  dimId: string,
  userId: string,
  tenantId: string,
): Promise<{ reverted: number }> {
  const meta = await pgGet<{ dimTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) throw new AppError("NOT_FOUND", `table ${dimId} not found`, 404);
  const last = await pgGet<{ at: Date | null }>(
    `SELECT max(occurred_at) AS at FROM ${pg("outbound_event")}
     WHERE tenant_id = $1 AND dim_id = $2 AND type = 'table.published'`,
    [tenantId, dimId],
  );
  const snapVersion = await latestSnapshotVersion(dimId, tenantId);
  if (!last?.at || snapVersion === null) {
    throw new AppError("VALIDATION_FAILED", "publish a version first — nothing to revert to", 422);
  }
  const changed = await changedKeysSince(dimId, tenantId, last.at, meta);
  if (changed.length === 0) return { reverted: 0 };

  const DIMT = cq(meta.dimTable);
  const keyc = qid(meta.keyCol);
  await pgTx(async (tx) => {
    await tx.run(`DELETE FROM ${DIMT} WHERE ${keyc}::text = ANY($1)`, [changed]);
    await tx.run(
      `INSERT INTO ${DIMT}
       SELECT rec.* FROM ${pg("dimension_version")} v
       CROSS JOIN LATERAL jsonb_array_elements(v.snapshot->'records') AS e(obj)
       CROSS JOIN LATERAL jsonb_populate_record(NULL::${DIMT}, e.obj) AS rec
       WHERE v.dim_id = $1 AND v.tenant_id = $2 AND v.version = $3
         AND e.obj->>$4 = ANY($5)`,
      [dimId, tenantId, snapVersion, meta.keyCol, changed],
    );
    // Stamp the touched records so concurrent editors conflict cleanly; values
    // now equal the snapshot, so they no longer count as changed.
    await tx.run(
      `UPDATE ${pg("canonical_version")}
          SET version = version + 1, updated_at = now(), updated_by = $4
        WHERE dim_id = $1 AND tenant_id = $2 AND key = ANY($3)`,
      [dimId, tenantId, changed, userId],
    );
    // Records restored from the snapshot are live again — clear retire flags.
    await tx.run(
      `UPDATE ${pg("canonical_version")} cv
          SET retired_at = NULL, retired_into = NULL
        WHERE cv.dim_id = $1 AND cv.tenant_id = $2 AND cv.key = ANY($3)
          AND EXISTS (SELECT 1 FROM ${DIMT} d WHERE d.${keyc}::text = cv.key)`,
      [dimId, tenantId, changed],
    );
  });
  await appendAuditAs(
    userId,
    "Reverted changes",
    `${changed.length} record${changed.length === 1 ? "" : "s"} → Version ${snapVersion}`,
    { tableId: dimId, tenantId },
  );
  return { reverted: changed.length };
}

/** Approve & commit: fold the dimension's `mapped` drafts into Postgres dim_/map_
 *  in one atomic transaction, then clear them + audit. */
/** Collect all validation violations across required, unique, and range rules.
 *  Returns one entry per offending record+field pair. Rollbacks skip this gate
 *  (they restore a past version verbatim). */
async function validationViolations(
  dimId: string,
  tenantId: string,
  meta: { dimTable: string; keyCol: string },
): Promise<
  Array<{ key: string; label: string; field: string; fieldLabel: string; reason: string }>
> {
  const fieldRows = await pgAll<{
    field: string;
    label: string;
    type: string;
    field_config: string | null;
  }>(
    `SELECT field, label, type, field_config FROM ${pg("dimension_field")}
     WHERE dim_id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  const DIMT = cq(meta.dimTable);
  const keyCol = qid(meta.keyCol);
  const out: Array<{
    key: string;
    label: string;
    field: string;
    fieldLabel: string;
    reason: string;
  }> = [];

  for (const f of fieldRows) {
    const cfg = parseFieldConfig(f.type, f.field_config);
    const col = qid(f.field);

    // Required — empty value
    if (cfg.required) {
      const empties = await pgAll<{ key: string; label: string | null }>(
        `SELECT ${keyCol} AS key, label FROM ${DIMT} WHERE ${col} IS NULL OR CAST(${col} AS VARCHAR) = ''`,
      );
      for (const e of empties)
        out.push({
          key: String(e.key),
          label: e.label == null ? String(e.key) : String(e.label),
          field: f.field,
          fieldLabel: f.label,
          reason: "needs a value",
        });
    }

    // Unique — case-insensitive duplicate among non-empty values
    if (cfg.validation?.unique) {
      const dups = await pgAll<{ key: string; label: string | null }>(
        `SELECT ${keyCol} AS key, label FROM ${DIMT} t
         WHERE CAST(${col} AS VARCHAR) <> '' AND ${col} IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM ${DIMT} u
             WHERE u.${keyCol} <> t.${keyCol}
               AND LOWER(CAST(u.${col} AS VARCHAR)) = LOWER(CAST(t.${col} AS VARCHAR)))`,
      );
      for (const d of dups)
        out.push({
          key: String(d.key),
          label: d.label == null ? String(d.key) : String(d.label),
          field: f.field,
          fieldLabel: f.label,
          reason: "duplicate value",
        });
    }

    // Range — numeric/text-length bounds (dates compared lexically as ISO)
    const v = cfg.validation;
    if (v && (v.min != null || v.max != null)) {
      let cmpCol: string;
      if (f.type === "text") {
        cmpCol = `LENGTH(CAST(${col} AS VARCHAR))`;
      } else if (f.type === "date") {
        cmpCol = `CAST(${col} AS VARCHAR)`;
      } else {
        cmpCol = `CAST(${col} AS DOUBLE PRECISION)`;
      }
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (v.min != null) {
        clauses.push(`${cmpCol} < $${params.length + 1}`);
        params.push(f.type === "date" ? String(v.min) : Number(v.min));
      }
      if (v.max != null) {
        clauses.push(`${cmpCol} > $${params.length + 1}`);
        params.push(f.type === "date" ? String(v.max) : Number(v.max));
      }
      const oob = await pgAll<{ key: string; label: string | null }>(
        `SELECT ${keyCol} AS key, label FROM ${DIMT}
         WHERE ${col} IS NOT NULL AND CAST(${col} AS VARCHAR) <> '' AND (${clauses.join(" OR ")})`,
        params,
      );
      for (const o of oob)
        out.push({
          key: String(o.key),
          label: o.label == null ? String(o.key) : String(o.label),
          field: f.field,
          fieldLabel: f.label,
          reason: "out of range",
        });
    }
  }
  return out;
}

export async function commit(
  dimId: string,
  userId: string,
  tenantId: string,
  draftKeys?: string[],
  opts?: { kind?: "publish" | "rollback"; restoresVersion?: number; skipWarehouseSync?: boolean },
): Promise<{
  committed: number;
  rowsRecovered: number;
  warehouseSynced: "n/a" | "synced" | "synced-additive" | "failed";
}> {
  const meta = await pgGet<{
    dimTable: string;
    mapTable: string;
    keyCol: string;
    label: string;
    orderingMode: string;
  }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", label,
            COALESCE(ordering_mode, 'derived') AS "orderingMode"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) return { committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" };
  const key = qid(meta.keyCol);
  const DRAFT = pg("draft");
  const DIMT = cq(meta.dimTable);
  const MAPT = cq(meta.mapTable);

  // When draftKeys is provided, validate that all requested keys exist as
  // mapped drafts for this (dim, tenant) before touching anything.
  const scoped = draftKeys !== undefined;
  if (scoped && draftKeys!.length > 0) {
    const found = await pgAll<{ raw: string }>(
      `SELECT raw FROM ${DRAFT}
       WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL
         AND raw = ANY($3)`,
      [dimId, tenantId, draftKeys],
    );
    const foundSet = new Set(found.map((r) => r.raw));
    const missing = draftKeys!.filter((k) => !foundSet.has(k));
    if (missing.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        `unknown or unstaged draft keys: ${missing.join(", ")}`,
        400,
      );
    }
  }

  // Scope clause: appended to every draft-filtered statement when draftKeys is provided.
  // scoped=true + empty array → AND raw = ANY('{}') → matches nothing → zero-work fold.
  const scopeClause = scoped ? ` AND raw = ANY($3)` : "";
  const scopeClauseD = scoped ? ` AND d.raw = ANY($3)` : "";
  const baseParams = (extra: unknown[] = []) =>
    scoped ? [dimId, tenantId, draftKeys, ...extra] : [dimId, tenantId, ...extra];
  const baseParamsD = baseParams; // alias for aliased-draft statements

  const approved = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${DRAFT}
     WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL${scopeClause}`,
    baseParams(),
  );
  const committed = Number(approved?.n ?? 0);

  // ADR-0002: canonical edits are instant in the working copy; publish stamps
  // them into a version too. A commit with zero drafts still proceeds when
  // canonical rows changed since the last publish — the draft-driven SQL
  // below all no-ops safely.
  // NOTE: scoped empty-array (draftKeys=[]) is valid — it means "fold no drafts,
  // publish record-state only". The early return must not short-circuit in that
  // case when canonicalChanged.length > 0. Unscoped (undefined) keeps existing behaviour.
  const lastPublish = await pgGet<{ at: Date | null }>(
    `SELECT max(occurred_at) AS at FROM ${pg("outbound_event")}
     WHERE tenant_id = $1 AND dim_id = $2 AND type = 'table.published'`,
    [tenantId, dimId],
  );
  const canonicalChanged = await changedKeysSince(dimId, tenantId, lastPublish?.at ?? null, {
    dimTable: meta.dimTable,
    keyCol: meta.keyCol,
  });
  if (!committed && canonicalChanged.length === 0)
    return { committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" };

  // Validation gate: blocks publish on required, unique, or range violations.
  // Skipped for rollbacks (they restore verbatim).
  // Error code: REQUIRED_FIELDS_EMPTY when every violation is "needs a value"
  // (preserves existing frontend behavior); VALIDATION_FAILED otherwise.
  if (opts?.kind !== "rollback") {
    const violations = await validationViolations(dimId, tenantId, {
      dimTable: meta.dimTable,
      keyCol: meta.keyCol,
    });
    if (violations.length > 0) {
      const records = new Set(violations.map((v) => v.key)).size;
      const allRequired = violations.every((v) => v.reason === "needs a value");
      const code = allRequired ? "REQUIRED_FIELDS_EMPTY" : "VALIDATION_FAILED";
      const msg = allRequired
        ? `${records} record${records === 1 ? "" : "s"} need a required value before you can publish`
        : `${records} record${records === 1 ? "" : "s"} need a fix before you can publish`;
      throw new AppError(code, msg, 422, { violations });
    }
  }

  // Four-eyes governance gate: when requireSecondPublisher is enabled, the
  // committer must not have authored any of the mapped drafts being published.
  // Drafts authored by u_system (auto-staged by repo-scan.ts autoStageExactMatches)
  // are excluded — system drafts never block any human publisher.
  const prefs = await getPreferences(tenantId);
  if (prefs.requireSecondPublisher) {
    const ownDrafts = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${DRAFT}
       WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped'
         AND target_key IS NOT NULL AND user_id = $3 AND user_id <> 'u_system'${scoped ? ` AND raw = ANY($4)` : ""}`,
      scoped ? [dimId, tenantId, userId, draftKeys] : [dimId, tenantId, userId],
    );
    const own = Number(ownDrafts?.n ?? 0);
    if (own > 0) {
      throw new AppError(
        "SECOND_PUBLISHER_REQUIRED",
        `${own} of these drafts are yours — another editor must publish them`,
        403,
      );
    }
  }

  const rowsRecovered = await rowsForUnmappedDrafts(dimId, tenantId, meta.mapTable);

  // Capture distinct target_keys BEFORE the tx so they're available after
  // the draft rows are deleted inside the transaction.
  const committedRows = await pgAll<{ target_key: string }>(
    `SELECT DISTINCT target_key FROM ${DRAFT}
     WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL${scopeClause}`,
    baseParams(),
  );

  // Snapshot approved drafts BEFORE the tx so we can pass them to the
  // warehouse adapter after the Postgres commit succeeds.
  const approvedDrafts = await pgAll<{ raw: string; key: string; label: string | null }>(
    `SELECT raw, target_key AS key, target_label AS label FROM ${DRAFT}
     WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL${scopeClause}`,
    baseParams(),
  );

  // Identify remaps (raw already mapped but to a different target_key) so we
  // can record them separately in the outbound event and audit log.
  const remappedDrafts = await pgAll<{ raw: string; from_key: string; to_key: string }>(
    `SELECT d.raw, m.${key} AS from_key, d.target_key AS to_key
     FROM ${DRAFT} d
     JOIN ${MAPT} m ON lower(m.raw) = lower(d.raw)
     WHERE d.dim_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped'
       AND d.target_key IS NOT NULL AND m.${key} <> d.target_key${scopeClauseD}`,
    baseParamsD(),
  );

  // PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL
  // stays per-tenant-implicit (dim ids are globally unique → effectively
  // per-tenant via the dimension registry's WHERE tenant_id = $N gate above).
  await pgTx(async (tx) => {
    // Update existing map rows whose target has changed (remaps).
    if (remappedDrafts.length > 0) {
      await tx.run(
        `UPDATE ${MAPT} m
         SET ${key} = d.target_key
         FROM ${DRAFT} d
         WHERE lower(m.raw) = lower(d.raw)
           AND d.dim_id = $1 AND d.tenant_id = $2
           AND d.status = 'mapped' AND d.target_key IS NOT NULL
           AND m.${key} <> d.target_key${scopeClauseD}`,
        baseParamsD(),
      );
    }
    if (meta.orderingMode === "manual") {
      await tx.run(
        `WITH max_pos AS (
           SELECT COALESCE(MAX(position), 0)::bigint AS m FROM ${DIMT}
         ),
         ordered AS (
           SELECT
             target_key   AS k,
             target_label AS lbl,
             MIN(created_at) AS first_seen
           FROM ${DRAFT} d
           WHERE d.dim_id = $1 AND d.tenant_id = $2
             AND d.status = 'mapped' AND d.target_key IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)${scopeClauseD}
           GROUP BY target_key, target_label
         )
         INSERT INTO ${DIMT} (${key}, label, position)
         SELECT
           o.k, o.lbl,
           (SELECT m FROM max_pos) + 1024 * row_number() OVER (ORDER BY o.first_seen, o.k)
         FROM ordered o`,
        baseParamsD(),
      );
    } else {
      await tx.run(
        `INSERT INTO ${DIMT} (${key}, label)
         SELECT DISTINCT d.target_key, d.target_label FROM ${DRAFT} d
         WHERE d.dim_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped' AND d.target_key IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)${scopeClauseD}`,
        baseParamsD(),
      );
    }
    await tx.run(
      `INSERT INTO ${MAPT} (raw, ${key})
       SELECT d.raw, d.target_key FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${MAPT} m WHERE lower(m.raw) = lower(d.raw))${scopeClauseD}`,
      baseParamsD(),
    );
    // DELETE: scoped → only delete the requested draft raws; unscoped → delete all mapped.
    if (scoped) {
      await tx.run(
        `DELETE FROM ${DRAFT} WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND raw = ANY($3)`,
        [dimId, tenantId, draftKeys],
      );
    } else {
      await tx.run(
        `DELETE FROM ${DRAFT} WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped'`,
        [dimId, tenantId],
      );
    }

    // Outbound event for downstream subscribers (PR3). Uses a count-based
    // per-(tenant, dim, type) monotonic counter — simpler than extracting
    // payload->>'version' from a jsonb column and equally correct since we
    // only insert one table.published event per commit() inside this tx.
    const versionRow = await tx.get<{ v: number }>(
      `SELECT count(*)::int + 1 AS v
         FROM ${pg("outbound_event")}
        WHERE tenant_id = $1 AND dim_id = $2 AND type = 'table.published'`,
      [tenantId, dimId],
    );
    const v = versionRow?.v ?? 1;
    await writeVersionSnapshot(tx, {
      tenantId,
      dimId,
      version: v,
      kind: opts?.kind ?? "publish",
      restoresVersion: opts?.restoresVersion ?? null,
      publishedBy: userId,
      dimTable: meta.dimTable,
      mapTable: meta.mapTable,
      keyCol: meta.keyCol,
    });
    const committedBy = await tx.get<{ name: string }>(
      `SELECT name FROM ${pg("users")} WHERE id = $1`,
      [userId],
    );
    // Stamp with the DB clock: publish-state comparisons ("changed since last
    // publish") run against canonical_version.updated_at, which is DB now().
    // A host/DB clock skew would otherwise resurrect just-published changes.
    const dbNow = await tx.get<{ now: Date }>(`SELECT now() AS now`);
    const remappedRaws = new Set(remappedDrafts.map((r) => r.raw.toLowerCase()));
    const addedKeys = approvedDrafts
      .filter((d) => !remappedRaws.has(d.raw.toLowerCase()))
      .map((d) => ({ key: d.key, label: d.label ?? d.key }));
    const remappedKeys = remappedDrafts.map((r) => ({
      raw: r.raw,
      from_key: r.from_key,
      to_key: r.to_key,
    }));
    await dispatchOutbound(tx, {
      tenantId,
      type: "table.published",
      dimId,
      occurredAt: dbNow?.now ?? new Date(),
      payload: {
        dim_slug: dimId,
        dim_label: meta.label,
        version: v,
        previous_version: v - 1,
        committed_by: { id: userId, name: committedBy?.name ?? userId },
        changes: {
          added: addedKeys.slice(0, 200),
          remapped: remappedKeys.slice(0, 200),
          updated: [],
          merged: [],
          retired: [],
        },
        summary: {
          added: addedKeys.length,
          remapped: remappedKeys.length,
          updated: canonicalChanged.length,
          merged: 0,
          retired: 0,
        },
        ...(addedKeys.length > 200 || remappedKeys.length > 200 ? { changes_truncated: true } : {}),
        kind: opts?.kind ?? "publish",
        ...(opts?.restoresVersion != null ? { restores_version: opts.restoresVersion } : {}),
      },
      idemKey: `table.published:${dimId}:${v}`,
    });
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

  if (committed > 0) {
    await appendAuditAs(
      userId,
      "Committed",
      `${committed} value${committed === 1 ? "" : "s"} → ${meta.mapTable} · ${rowsRecovered.toLocaleString()} rows recovered`,
      { tenantId },
    );
  } else {
    await appendAuditAs(
      userId,
      "Published",
      `${canonicalChanged.length} record change${canonicalChanged.length === 1 ? "" : "s"} → ${meta.dimTable}`,
      { tenantId },
    );
  }

  // After Postgres commit: if the warehouse adapter is writable, attempt the
  // warehouse MERGE. Failures log + surface but don't roll back Postgres.
  // skipWarehouseSync=true (set by rollback) skips this block so rollback's
  // own warehouse block is the single source of truth.
  let warehouseSynced: "n/a" | "synced" | "synced-additive" | "failed" = "n/a";
  const adapter = await getAdapter();
  if (!opts?.skipWarehouseSync && isWritable(adapter)) {
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

/** Warehouse rows for raws that have a mapped draft but aren't yet in the map.
 *  Reads materialized dim_scan_occurrence rather than re-querying the warehouse. */
async function rowsForUnmappedDrafts(
  dimId: string,
  tenantId: string,
  mapTable: string,
): Promise<number> {
  const occRows = await pgAll<{
    raw: string;
    table_name: string;
    column_name: string;
    rows: number;
  }>(
    `SELECT v.raw, o.table_name, o.column_name, o.rows
       FROM zugzug_app.dim_scan_value v
       JOIN zugzug_app.dim_scan_occurrence o
         ON o.tenant_id = v.tenant_id AND o.dim_id = v.dim_id AND o.raw_lower = v.raw_lower
       WHERE v.tenant_id = $1 AND v.dim_id = $2`,
    [tenantId, dimId],
  );
  if (!occRows.length) return 0;

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

  // Sum rows for raws that are in a draft but not yet mapped.
  // Iterate per-occurrence to preserve the original UNION-ALL sum semantics.
  let total = 0;
  for (const o of occRows) {
    const lower = o.raw.toLowerCase();
    if (draftSet.has(lower) && !mappedSet.has(lower)) total += Number(o.rows);
  }
  return total;
}
