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
} from "./repo-shared.ts";
import { appendAuditAs, getPreferences } from "./repo-meta.ts";
import { AppError } from "./errors.ts";
import { dispatchOutbound } from "./repo-outbound-events.ts";
import { getAdapter } from "./warehouse/registry.ts";
import { isWritable } from "./warehouse/adapter.ts";

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
    source: "user" | "ai";
    confidence: "high" | "medium" | "low" | null;
    reasoning: string | null;
  }>(
    `SELECT dim_id AS "dimId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs,
            source, confidence, reasoning
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
           target_key = EXCLUDED.target_key, created_at = EXCLUDED.created_at`,
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
       status       = EXCLUDED.status,
       target_label = EXCLUDED.target_label,
       target_key   = EXCLUDED.target_key,
       created_at   = EXCLUDED.created_at,
       source       = EXCLUDED.source,
       confidence   = EXCLUDED.confidence,
       reasoning    = EXCLUDED.reasoning`,
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
}

/** Live canonical keys touched since `since` (or ever, when never published). */
async function changedKeysSince(
  dimId: string,
  tenantId: string,
  since: Date | null,
): Promise<string[]> {
  const rows = since
    ? await pgAll<{ key: string }>(
        `SELECT key FROM ${pg("canonical_version")}
         WHERE dim_id = $1 AND tenant_id = $2
           AND (updated_at > $3 OR retired_at > $3)
         ORDER BY key`,
        [dimId, tenantId, since],
      )
    : await pgAll<{ key: string }>(
        `SELECT key FROM ${pg("canonical_version")}
         WHERE dim_id = $1 AND tenant_id = $2
         ORDER BY key`,
        [dimId, tenantId],
      );
  return rows.map((r) => r.key);
}

export async function getPublishState(dimId: string, tenantId: string): Promise<PublishState> {
  const last = await pgGet<{ v: number; at: Date | null }>(
    `SELECT count(*)::int AS v, max(occurred_at) AS at
     FROM ${pg("outbound_event")}
     WHERE tenant_id = $1 AND dim_id = $2 AND type = 'dimension.committed'`,
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
       WHERE tenant_id = $1 AND dim_id = $2 AND type = 'dimension.committed'
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
    changedKeys: await changedKeysSince(dimId, tenantId, publishedAt),
  };
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

  const approved = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${DRAFT}
     WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL`,
    [dimId, tenantId],
  );
  const committed = Number(approved?.n ?? 0);

  // ADR-0002: canonical edits are instant in the working copy; publish stamps
  // them into a version too. A commit with zero drafts still proceeds when
  // canonical rows changed since the last publish — the draft-driven SQL
  // below all no-ops safely.
  const lastPublish = await pgGet<{ at: Date | null }>(
    `SELECT max(occurred_at) AS at FROM ${pg("outbound_event")}
     WHERE tenant_id = $1 AND dim_id = $2 AND type = 'dimension.committed'`,
    [tenantId, dimId],
  );
  const canonicalChanged = await changedKeysSince(dimId, tenantId, lastPublish?.at ?? null);
  if (!committed && canonicalChanged.length === 0)
    return { committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" };

  // Four-eyes governance gate: when requireSecondPublisher is enabled, the
  // committer must not have authored any of the mapped drafts being published.
  // Drafts authored by u_system (auto-staged by repo-scan.ts autoStageExactMatches)
  // are excluded — system drafts never block any human publisher.
  const prefs = await getPreferences(tenantId);
  if (prefs.requireSecondPublisher) {
    const ownDrafts = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${DRAFT}
       WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped'
         AND target_key IS NOT NULL AND user_id = $3 AND user_id <> 'u_system'`,
      [dimId, tenantId, userId],
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

  // Identify remaps (raw already mapped but to a different target_key) so we
  // can record them separately in the outbound event and audit log.
  const remappedDrafts = await pgAll<{ raw: string; from_key: string; to_key: string }>(
    `SELECT d.raw, m.${key} AS from_key, d.target_key AS to_key
     FROM ${DRAFT} d
     JOIN ${MAPT} m ON lower(m.raw) = lower(d.raw)
     WHERE d.dim_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped'
       AND d.target_key IS NOT NULL AND m.${key} <> d.target_key`,
    [dimId, tenantId],
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
           AND m.${key} <> d.target_key`,
        [dimId, tenantId],
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
             AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)
           GROUP BY target_key, target_label
         )
         INSERT INTO ${DIMT} (${key}, label, position)
         SELECT
           o.k, o.lbl,
           (SELECT m FROM max_pos) + 1024 * row_number() OVER (ORDER BY o.first_seen, o.k)
         FROM ordered o`,
        [dimId, tenantId],
      );
    } else {
      await tx.run(
        `INSERT INTO ${DIMT} (${key}, label)
         SELECT DISTINCT d.target_key, d.target_label FROM ${DRAFT} d
         WHERE d.dim_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped' AND d.target_key IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)`,
        [dimId, tenantId],
      );
    }
    await tx.run(
      `INSERT INTO ${MAPT} (raw, ${key})
       SELECT d.raw, d.target_key FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${MAPT} m WHERE lower(m.raw) = lower(d.raw))`,
      [dimId, tenantId],
    );
    await tx.run(
      `DELETE FROM ${DRAFT} WHERE dim_id = $1 AND tenant_id = $2 AND status = 'mapped'`,
      [dimId, tenantId],
    );

    // Outbound event for downstream subscribers (PR3). Uses a count-based
    // per-(tenant, dim, type) monotonic counter — simpler than extracting
    // payload->>'version' from a jsonb column and equally correct since we
    // only insert one dimension.committed event per commit() inside this tx.
    const versionRow = await tx.get<{ v: number }>(
      `SELECT count(*)::int + 1 AS v
         FROM ${pg("outbound_event")}
        WHERE tenant_id = $1 AND dim_id = $2 AND type = 'dimension.committed'`,
      [tenantId, dimId],
    );
    const v = versionRow?.v ?? 1;
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
      type: "dimension.committed",
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
        summary: { added: addedKeys.length, remapped: remappedKeys.length, updated: canonicalChanged.length, merged: 0, retired: 0 },
        ...((addedKeys.length > 200 || remappedKeys.length > 200) ? { changes_truncated: true } : {}),
      },
      idemKey: `dimension.committed:${dimId}:${v}`,
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
