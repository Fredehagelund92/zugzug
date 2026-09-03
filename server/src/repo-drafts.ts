/* repo-drafts.ts — drafts + the commit fold.
 *
 * Drafts are Postgres-only staging rows; commit() folds them into the
 * record dim_/map_ tables atomically. The rowsForUnmappedDrafts helper
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
import { isWritable, type RecordSyncExtras } from "./warehouse/adapter.ts";

/* ---- drafts (Postgres) ---- */
export async function listDrafts(refTableId: string, tenantId: string): Promise<Draft[]> {
  const rows = await pgAll<{
    refTableId: string;
    raw: string;
    status: "mapped" | "skipped" | "rejected";
    targetLabel: string | null;
    targetKey: string | null;
    uid: string;
    secs: number;
    createdAt: Date;
    source: "user" | "ai";
    confidence: "high" | "medium" | "low" | null;
    reasoning: string | null;
    rejectedReason: string | null;
    rejectedBy: string | null;
  }>(
    `SELECT reference_table_id AS "refTableId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs,
            created_at AS "createdAt",
            source, confidence, reasoning,
            rejected_reason AS "rejectedReason", rejected_by AS "rejectedBy"
     FROM ${pg("draft")} WHERE reference_table_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [refTableId, tenantId],
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
    refTableId: r.refTableId,
    raw: r.raw,
    status: r.status,
    targetLabel: r.targetLabel,
    targetKey: r.targetKey,
    user: byId.get(r.uid) ?? unknownUser,
    at: rel(Number(r.secs)),
    createdAt: new Date(r.createdAt).toISOString(),
    source: r.source,
    confidence: r.confidence,
    reasoning: r.reasoning,
    rejectedReason: r.rejectedReason,
    rejectedBy: r.rejectedBy,
  }));
}

/** Default/max page sizes for the workspace-wide drafts read (#151). Keeps a
 *  single request from materializing an unbounded backlog in the Bun process. */
const DEFAULT_LIMIT_ALL_DRAFTS = 1000;
const MAX_LIMIT_ALL_DRAFTS = 2000;

/** Opaque keyset cursor for listAllDraftsPage. The keyset is the draft's
 *  primary-key tail (reference_table_id, raw, user_id) — unique per tenant and
 *  already index-backed by the composite PK. Tenant is enforced from the
 *  authenticated request, never from the cursor, so a plain base64 encoding is
 *  safe (a tampered cursor can only reposition within the caller's own tenant). */
interface DraftCursor {
  r: string; // reference_table_id
  w: string; // raw
  u: string; // user_id
}
function encodeDraftCursor(c: DraftCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}
function decodeDraftCursor(s: string): DraftCursor {
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as DraftCursor;
    if (typeof o.r === "string" && typeof o.w === "string" && typeof o.u === "string") return o;
  } catch {
    /* fall through */
  }
  throw new AppError("VALIDATION_FAILED", "invalid drafts cursor", 400);
}

/** One keyset-paginated page of every draft in the workspace. Ordered by the
 *  PK tail (reference_table_id, raw, user_id) so the cursor is stable and the
 *  scan rides the composite primary key. The Review inbox pages through with
 *  the returned nextCursor until it is null. */
export async function listAllDraftsPage(
  tenantId: string,
  opts?: { cursor?: string | null; limit?: number },
): Promise<{ drafts: Draft[]; nextCursor: string | null }> {
  const limit =
    !opts?.limit || opts.limit <= 0
      ? DEFAULT_LIMIT_ALL_DRAFTS
      : Math.min(Math.floor(opts.limit), MAX_LIMIT_ALL_DRAFTS);
  const after = opts?.cursor ? decodeDraftCursor(opts.cursor) : null;

  const params: unknown[] = [tenantId];
  let keyset = "";
  if (after) {
    params.push(after.r, after.w, after.u);
    keyset = ` AND (reference_table_id, raw, user_id) > ($2, $3, $4)`;
  }
  params.push(limit + 1); // fetch one extra to know whether another page exists

  const rows = await pgAll<{
    refTableId: string;
    raw: string;
    status: "mapped" | "skipped" | "rejected";
    targetLabel: string | null;
    targetKey: string | null;
    uid: string;
    secs: number;
    createdAt: Date;
    source: "user" | "ai";
    confidence: "high" | "medium" | "low" | null;
    reasoning: string | null;
    rejectedReason: string | null;
    rejectedBy: string | null;
  }>(
    `SELECT reference_table_id AS "refTableId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs,
            created_at AS "createdAt",
            source, confidence, reasoning,
            rejected_reason AS "rejectedReason", rejected_by AS "rejectedBy"
     FROM ${pg("draft")} WHERE tenant_id = $1${keyset}
     ORDER BY reference_table_id, raw, user_id
     LIMIT $${params.length}`,
    params,
  );

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.pop(); // drop the sentinel extra row
    const tail = rows[rows.length - 1]!;
    nextCursor = encodeDraftCursor({ r: tail.refTableId, w: tail.raw, u: tail.uid });
  }
  if (rows.length === 0) return { drafts: [], nextCursor };

  const uids = Array.from(new Set(rows.map((r) => r.uid)));
  const users = await pgAll<User>(
    `SELECT id, name, initials FROM ${pg("users")} WHERE id = ANY($1::text[])`,
    [uids],
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  const unknownUser: User = { id: "unknown", name: "Unknown", initials: "??" };

  const drafts = rows.map((r) => ({
    refTableId: r.refTableId,
    raw: r.raw,
    status: r.status,
    targetLabel: r.targetLabel,
    targetKey: r.targetKey,
    user: byId.get(r.uid) ?? unknownUser,
    at: rel(Number(r.secs)),
    createdAt: new Date(r.createdAt).toISOString(),
    source: r.source,
    confidence: r.confidence,
    reasoning: r.reasoning,
    rejectedReason: r.rejectedReason,
    rejectedBy: r.rejectedBy,
  }));
  return { drafts, nextCursor };
}

export async function saveDraft(
  refTableId: string,
  raw: string,
  status: "mapped" | "skipped",
  targetLabel: string | null,
  targetKey: string | null,
  userId: string,
  tenantId: string,
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("draft")} (reference_table_id, raw, status, target_label, target_key, user_id, created_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp, $7)
     ON CONFLICT (tenant_id, reference_table_id, raw, user_id) DO UPDATE
       SET status = EXCLUDED.status, target_label = EXCLUDED.target_label,
           target_key = EXCLUDED.target_key, created_at = EXCLUDED.created_at,
           rejected_reason = NULL, rejected_by = NULL`,
    [refTableId, raw, status, targetLabel, targetKey, userId, tenantId],
  );
}

/** Input shape for `createDraft` — the AI-suggestion-aware draft creator.
 *  Unlike `saveDraft`, this carries provenance metadata (`source`, `confidence`,
 *  `reasoning`) so AI-generated proposals are distinguishable from user edits. */
export interface CreateDraftInput {
  reference_table_id: string;
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
    reference_table_id,
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
       (reference_table_id, raw, status, target_label, target_key, user_id, created_at, tenant_id,
        source, confidence, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, reference_table_id, raw, user_id) DO UPDATE SET
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
      reference_table_id,
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
    refTableId: string;
    raw: string;
    status: "mapped" | "skipped";
    targetLabel: string | null;
    targetKey: string | null;
    uid: string;
    secs: number;
    createdAt: Date;
    source: "user" | "ai";
    confidence: "high" | "medium" | "low" | null;
    reasoning: string | null;
  }>(
    `SELECT reference_table_id AS "refTableId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs,
            created_at AS "createdAt",
            source, confidence, reasoning
       FROM ${pg("draft")}
      WHERE tenant_id = $1 AND reference_table_id = $2 AND raw = $3 AND user_id = $4
      LIMIT 1`,
    [tenantId, reference_table_id, raw, userId],
  );
  if (!row) {
    throw new Error(`createDraft: failed to read back inserted draft ${reference_table_id}/${raw}`);
  }

  const user = await pgGet<User>(`SELECT id, name, initials FROM ${pg("users")} WHERE id = $1`, [
    row.uid,
  ]);

  return {
    refTableId: row.refTableId,
    raw: row.raw,
    status: row.status,
    targetLabel: row.targetLabel,
    targetKey: row.targetKey,
    user: user ?? { id: row.uid, name: "Unknown", initials: "??" },
    at: rel(Number(row.secs)),
    createdAt: new Date(row.createdAt).toISOString(),
    source: row.source,
    confidence: row.confidence,
    reasoning: row.reasoning,
    rejectedReason: null,
    rejectedBy: null,
  };
}

/** A draft picked out of the queue. A bare string means "this source value,
 *  whichever draft is newest" — the fold publish already applies. An object
 *  narrows to one author's draft, which is what the Approve inbox needs: it
 *  lists a row per author, so acting on Mia's row must not touch Bob's. */
export type DraftSelector = string | { raw: string; userId?: string | null };

interface NormalizedSelector {
  raw: string;
  userId: string | null;
}
function normalizeSelectors(keys: DraftSelector[]): NormalizedSelector[] {
  return keys.map((k) =>
    typeof k === "string" ? { raw: k, userId: null } : { raw: k.raw, userId: k.userId ?? null },
  );
}
/** SQL predicate matching the selected (raw, author) pairs. A null author in
 *  the pair list matches every author of that raw. `$${r}`/`$${u}` are the raws
 *  and authors arrays; `p` prefixes the draft table alias when there is one. */
function selectorPredicate(r: number, u: number, p = ""): string {
  return `EXISTS (SELECT 1 FROM unnest($${r}::text[], $${u}::text[]) AS sel(sr, su)
                   WHERE sel.sr = ${p}raw AND (sel.su IS NULL OR sel.su = ${p}user_id))`;
}

/** Delete the caller's own draft for a value. Returns how many rows went, so
 *  the caller can say "nothing was removed" instead of silently no-opping on
 *  another editor's draft (the PK is per-author). */
export async function discardDraft(
  refTableId: string,
  raw: string,
  userId: string,
  tenantId: string,
): Promise<{ discarded: number }> {
  const gone = await pgAll<{ raw: string }>(
    `DELETE FROM ${pg("draft")} WHERE reference_table_id = $1 AND raw = $2 AND user_id = $3 AND tenant_id = $4
     RETURNING raw`,
    [refTableId, raw, userId, tenantId],
  );
  if (gone.length === 0) return { discarded: 0 };
  await appendAuditAs(userId, "discard_draft", `${refTableId}: ${raw}`, { tenantId });
  return { discarded: gone.length };
}

export async function rejectDrafts(
  refTableId: string,
  tenantId: string,
  keys: DraftSelector[],
  reason: string,
  reviewerId: string,
): Promise<{ rejected: number }> {
  const trimmed = reason.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "a rejection reason is required", 400);
  if (keys.length === 0) return { rejected: 0 };
  const sel = normalizeSelectors(keys);
  const res = await pgAll<{ raw: string }>(
    `UPDATE ${pg("draft")}
        SET status = 'rejected', rejected_reason = $5, rejected_by = $6
      WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped'
        AND ${selectorPredicate(3, 4)}
      RETURNING raw`,
    [refTableId, tenantId, sel.map((k) => k.raw), sel.map((k) => k.userId), trimmed, reviewerId],
  );
  const n = res.length;
  await appendAuditAs(reviewerId, "Rejected drafts", `${n} in ${refTableId}: ${trimmed}`, {
    tenantId,
    tableId: refTableId,
  });
  return { rejected: n };
}

export interface PublishState {
  /** Latest published version; 0 = never published. */
  version: number;
  publishedAt: string | null;
  publishedByName: string | null;
  /** Source values with a mapping draft awaiting publish (one per value, even
   *  when several editors drafted the same value). */
  pendingDrafts: number;
  /** Record keys edited, added, or retired since the last publish (ADR-0002:
   *  derived from record_version, not a staging queue). Keys created by
   *  draft folding don't appear here — they go out in the same publish. */
  changedKeys: string[];
  /** True when a published snapshot exists to revert the working copy to. */
  canRevert: boolean;
}

/** Latest version with a usable record snapshot (legacy double-encoded
 *  snapshots are skipped — reverting against those would drop rows). */
async function latestSnapshotVersion(refTableId: string, tenantId: string): Promise<number | null> {
  const row = await pgGet<{ version: number }>(
    `SELECT version FROM ${pg("reference_table_version")}
     WHERE reference_table_id = $1 AND tenant_id = $2 AND jsonb_typeof(snapshot->'records') = 'array'
     ORDER BY version DESC LIMIT 1`,
    [refTableId, tenantId],
  );
  return row ? Number(row.version) : null;
}

function asRow(row: unknown): Record<string, unknown> {
  return (typeof row === "string" ? JSON.parse(row) : row) as Record<string, unknown>;
}

/** Stable serialisation of a flat to_jsonb row for value comparison, restricted
 *  to `cols` — the physical dim_ columns. Snapshot rows also carry evaluated
 *  formula values (writeVersionSnapshot injects them so the Pull API sees what
 *  the grid shows), and formula fields have no dim_ column. Comparing the raw
 *  key sets would make every stamped record in a table with a formula column
 *  differ from its snapshot forever, so the change count could never return to
 *  zero and reverting an edit would never clear it. */
function canonRow(row: unknown, cols: string[]): string {
  const o = asRow(row);
  return JSON.stringify(cols.map((k) => [k, o[k] ?? null]));
}

/** Record keys with unpublished changes. Never published → every record (the
 *  first publish ships the whole table). Otherwise: keys stamped in
 *  record_version since the last publish, minus records whose values are
 *  back to identical with the last snapshot — so reverting an edit clears it. */
/** Row executor: pgAll by default, or a tx.all so callers can read inside an
 *  open transaction (pgTx does not auto-route pg.* through its connection). */
type RowExec = <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;

async function changedKeysSince(
  refTableId: string,
  tenantId: string,
  since: Date | null,
  meta: { dimTable: string; keyCol: string },
  exec: RowExec = pgAll,
): Promise<string[]> {
  if (!since) {
    const rows = await exec<{ key: string }>(
      `SELECT ${qid(meta.keyCol)}::text AS key FROM ${cq(meta.dimTable)} ORDER BY 1`,
    );
    return rows.map((r) => r.key);
  }
  const stamped = await exec<{ key: string }>(
    `SELECT key FROM ${pg("record_version")}
     WHERE reference_table_id = $1 AND tenant_id = $2
       AND (updated_at > $3 OR retired_at > $3)
     ORDER BY key`,
    [refTableId, tenantId, since],
  );
  if (stamped.length === 0) return [];
  const keys = stamped.map((r) => r.key);

  // Legacy double-encoded snapshots yield no rows here → every stamped key
  // counts as changed, which degrades to the pre-diff behaviour.
  const snapRows = await exec<{ key: string; row: unknown }>(
    `SELECT e.rec->>$4 AS key, e.rec AS row
       FROM ${pg("reference_table_version")} v
       CROSS JOIN LATERAL jsonb_array_elements(v.snapshot->'records') AS e(rec)
      WHERE v.reference_table_id = $1 AND v.tenant_id = $2
        AND v.version = (SELECT max(version) FROM ${pg("reference_table_version")}
                          WHERE reference_table_id = $1 AND tenant_id = $2)
        AND e.rec->>$4 = ANY($3)`,
    [refTableId, tenantId, keys, meta.keyCol],
  );
  const curRows = await exec<{ key: string; row: unknown }>(
    `SELECT ${qid(meta.keyCol)}::text AS key, to_jsonb(t) AS row
       FROM ${cq(meta.dimTable)} t
      WHERE ${qid(meta.keyCol)}::text = ANY($1)`,
    [keys],
  );
  // to_jsonb(t) yields the same key set for every live row, so one row defines
  // the physical column list both sides are compared over.
  const cols = curRows.length > 0 ? Object.keys(asRow(curRows[0].row)).sort() : [];
  const snapBy = new Map(snapRows.map((r) => [r.key, canonRow(r.row, cols)]));
  const curBy = new Map(curRows.map((r) => [r.key, canonRow(r.row, cols)]));
  return keys.filter((k) => {
    const before = snapBy.get(k);
    const now = curBy.get(k);
    if (before === undefined && now === undefined) return false; // added then removed — nets out
    return before !== now; // added, retired, or values still differ
  });
}

export async function getPublishState(refTableId: string, tenantId: string): Promise<PublishState> {
  const refTableMeta = await pgGet<{ dimTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol"
     FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  const last = await pgGet<{ v: number; at: Date | null }>(
    `SELECT count(*)::int AS v, max(occurred_at) AS at
     FROM ${pg("outbound_event")}
     WHERE tenant_id = $1 AND reference_table_id = $2 AND type = 'table.published'`,
    [tenantId, refTableId],
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
       WHERE tenant_id = $1 AND reference_table_id = $2 AND type = 'table.published'
       ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId, refTableId],
    );
    publishedByName = latest?.by ?? null;
  }
  // Distinct source values, not draft rows: the draft PK is per author, and the
  // fold collapses every author's draft for a value into one mapping. Counting
  // rows made "Publish 3 changes" preview only 2 mappings (#G1).
  const pending = await pgGet<{ n: number }>(
    `SELECT count(DISTINCT raw)::int AS n FROM ${pg("draft")}
     WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL`,
    [refTableId, tenantId],
  );
  return {
    version,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    publishedByName,
    pendingDrafts: Number(pending?.n ?? 0),
    changedKeys: refTableMeta
      ? await changedKeysSince(refTableId, tenantId, publishedAt, refTableMeta)
      : [],
    canRevert: version > 0 && (await latestSnapshotVersion(refTableId, tenantId)) !== null,
  };
}

/** Count-only publish summary for the refTable list (ADR-0005). Reuses
 *  getPublishState so "what's waiting" stays defined in exactly one place. */
export async function publishSummaryFor(
  refTableId: string,
  tenantId: string,
): Promise<import("./repo-shared.ts").PublishSummary> {
  const s = await getPublishState(refTableId, tenantId);
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
  refTableId: string,
  userId: string,
  tenantId: string,
): Promise<{ reverted: number }> {
  const meta = await pgGet<{ dimTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol"
     FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  if (!meta) throw new AppError("NOT_FOUND", `table ${refTableId} not found`, 404);
  const last = await pgGet<{ at: Date | null }>(
    `SELECT max(occurred_at) AS at FROM ${pg("outbound_event")}
     WHERE tenant_id = $1 AND reference_table_id = $2 AND type = 'table.published'`,
    [tenantId, refTableId],
  );
  const snapVersion = await latestSnapshotVersion(refTableId, tenantId);
  if (!last?.at || snapVersion === null) {
    throw new AppError("VALIDATION_FAILED", "publish a version first — nothing to revert to", 422);
  }
  const changed = await changedKeysSince(refTableId, tenantId, last.at, meta);
  if (changed.length === 0) return { reverted: 0 };

  const DIMT = cq(meta.dimTable);
  const keyc = qid(meta.keyCol);
  await pgTx(async (tx) => {
    await tx.run(`DELETE FROM ${DIMT} WHERE ${keyc}::text = ANY($1)`, [changed]);
    await tx.run(
      `INSERT INTO ${DIMT}
       SELECT rec.* FROM ${pg("reference_table_version")} v
       CROSS JOIN LATERAL jsonb_array_elements(v.snapshot->'records') AS e(obj)
       CROSS JOIN LATERAL jsonb_populate_record(NULL::${DIMT}, e.obj) AS rec
       WHERE v.reference_table_id = $1 AND v.tenant_id = $2 AND v.version = $3
         AND e.obj->>$4 = ANY($5)`,
      [refTableId, tenantId, snapVersion, meta.keyCol, changed],
    );
    // Stamp the touched records so concurrent editors conflict cleanly; values
    // now equal the snapshot, so they no longer count as changed.
    await tx.run(
      `UPDATE ${pg("record_version")}
          SET version = version + 1, updated_at = now(), updated_by = $4
        WHERE reference_table_id = $1 AND tenant_id = $2 AND key = ANY($3)`,
      [refTableId, tenantId, changed, userId],
    );
    // Records restored from the snapshot are live again — clear retire flags.
    await tx.run(
      `UPDATE ${pg("record_version")} cv
          SET retired_at = NULL, retired_into = NULL
        WHERE cv.reference_table_id = $1 AND cv.tenant_id = $2 AND cv.key = ANY($3)
          AND EXISTS (SELECT 1 FROM ${DIMT} d WHERE d.${keyc}::text = cv.key)`,
      [refTableId, tenantId, changed],
    );
  });
  await appendAuditAs(
    userId,
    "Reverted changes",
    `${changed.length} record${changed.length === 1 ? "" : "s"} → Version ${snapVersion}`,
    { tableId: refTableId, tenantId },
  );
  return { reverted: changed.length };
}

/** Approve & commit: fold the refTable's `mapped` drafts into Postgres dim_/map_
 *  in one atomic transaction, then clear them + audit. */
/** Collect all validation violations across required, unique, and range rules.
 *  Returns one entry per offending record+field pair. Rollbacks skip this gate
 *  (they restore a past version verbatim). */
async function validationViolations(
  refTableId: string,
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
    `SELECT field, label, type, field_config FROM ${pg("reference_table_field")}
     WHERE reference_table_id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
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
  refTableId: string,
  userId: string,
  tenantId: string,
  draftKeys?: DraftSelector[],
  opts?: {
    kind?: "publish" | "rollback";
    restoresVersion?: number;
    skipWarehouseSync?: boolean;
    onlyAuthor?: string;
  },
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
     FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  if (!meta) return { committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" };
  const key = qid(meta.keyCol);
  const DRAFT = pg("draft");
  const DIMT = cq(meta.dimTable);
  const MAPT = cq(meta.mapTable);

  // When draftKeys is provided, validate that all requested keys exist as
  // mapped drafts for this (refTable, tenant) before touching anything.
  const scoped = draftKeys !== undefined;
  const sel = scoped ? normalizeSelectors(draftKeys!) : [];
  const selRaws = sel.map((k) => k.raw);
  const selAuthors = sel.map((k) => k.userId);
  // Author scope: when set, only drafts authored by this user are folded. Used
  // by the auto-publish job so it can never publish a teammate's draft.
  const onlyAuthor = opts?.onlyAuthor;
  if (scoped && sel.length > 0) {
    const found = await pgAll<{ raw: string; user_id: string }>(
      `SELECT raw, user_id FROM ${DRAFT}
       WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL
         AND ${selectorPredicate(3, 4)}${onlyAuthor ? ` AND user_id = $5` : ""}`,
      onlyAuthor
        ? [refTableId, tenantId, selRaws, selAuthors, onlyAuthor]
        : [refTableId, tenantId, selRaws, selAuthors],
    );
    const missing = sel.filter(
      (k) => !found.some((f) => f.raw === k.raw && (k.userId === null || f.user_id === k.userId)),
    );
    if (missing.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        `these drafts are no longer waiting to publish: ${missing.map((m) => m.raw).join(", ")}`,
        400,
      );
    }
  }

  // Scope clause: appended to every draft-filtered statement when draftKeys is provided.
  // scoped=true + empty array → the pair list is empty → matches nothing → zero-work fold.
  const scopeClause = scoped ? ` AND ${selectorPredicate(3, 4)}` : "";
  const scopeClauseD = scoped ? ` AND ${selectorPredicate(3, 4, "d.")}` : "";
  // Author clause: appended after the scope clause, so its parameter follows
  // the selector arrays when scoped ($5) and tenant_id when not ($3).
  const authorParam = scoped ? "$5" : "$3";
  const authorClause = onlyAuthor ? ` AND user_id = ${authorParam}` : "";
  const authorClauseD = onlyAuthor ? ` AND d.user_id = ${authorParam}` : "";
  const baseParams = (extra: unknown[] = []) => [
    refTableId,
    tenantId,
    ...(scoped ? [selRaws, selAuthors] : []),
    ...(onlyAuthor ? [onlyAuthor] : []),
    ...extra,
  ];
  const baseParamsD = baseParams; // alias for aliased-draft statements

  const approved = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${DRAFT}
     WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL${scopeClause}${authorClause}`,
    baseParams(),
  );
  const committed = Number(approved?.n ?? 0);

  // ADR-0002: record edits are instant in the working copy; publish stamps
  // them into a version too. A commit with zero drafts still proceeds when
  // record rows changed since the last publish — the draft-driven SQL
  // below all no-ops safely.
  // NOTE: scoped empty-array (draftKeys=[]) is valid — it means "fold no drafts,
  // publish record-state only". The early return must not short-circuit in that
  // case when recordChanged.length > 0. Unscoped (undefined) keeps existing behaviour.
  const lastPublish = await pgGet<{ at: Date | null }>(
    `SELECT max(occurred_at) AS at FROM ${pg("outbound_event")}
     WHERE tenant_id = $1 AND reference_table_id = $2 AND type = 'table.published'`,
    [tenantId, refTableId],
  );
  const recordChanged = await changedKeysSince(refTableId, tenantId, lastPublish?.at ?? null, {
    dimTable: meta.dimTable,
    keyCol: meta.keyCol,
  });
  if (!committed && recordChanged.length === 0)
    return { committed: 0, rowsRecovered: 0, warehouseSynced: "n/a" };

  // Validation gate: blocks publish on required, unique, or range violations.
  // Skipped for rollbacks (they restore verbatim).
  // Error code: REQUIRED_FIELDS_EMPTY when every violation is "needs a value"
  // (preserves existing frontend behavior); VALIDATION_FAILED otherwise.
  if (opts?.kind !== "rollback") {
    const violations = await validationViolations(refTableId, tenantId, {
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
       WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped'
         AND target_key IS NOT NULL AND user_id = $3 AND user_id <> 'u_system'${
           scoped ? ` AND ${selectorPredicate(4, 5)}` : ""
         }${onlyAuthor ? ` AND user_id = $${scoped ? 6 : 4}` : ""}`,
      [
        refTableId,
        tenantId,
        userId,
        ...(scoped ? [selRaws, selAuthors] : []),
        ...(onlyAuthor ? [onlyAuthor] : []),
      ],
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

  const rowsRecovered = await rowsForUnmappedDrafts(refTableId, tenantId, meta.mapTable);

  // Event/audit inputs are captured INSIDE the tx below (not here) so they
  // agree with the version snapshot written in the same transaction (#152): a
  // concurrent record edit landing between a pre-tx read and the snapshot would
  // otherwise be counted in one but not the other. Declared out here so the
  // post-commit warehouse sync and audit loop can still read them.
  let committedRows: { target_key: string }[] = [];
  let approvedDrafts: { raw: string; key: string; label: string | null }[] = [];
  let recordChangedForEvent: string[] = [];

  // PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL
  // stays per-tenant-implicit (refTable ids are globally unique → effectively
  // per-tenant via the refTable registry's WHERE tenant_id = $N gate above).
  await pgTx(async (tx) => {
    // Serialize version assignment per (tenant, reference table). The next
    // version is derived from count(*) of prior table.published events below;
    // under READ COMMITTED two concurrent publishers would both read the same
    // count and compute the same version, and the loser rolls back on the
    // reference_table_version unique index (#150). A transaction-scoped
    // advisory lock makes the second publisher wait for the first to commit,
    // so it sees the new event row and picks the next version. Released
    // automatically at tx end.
    await tx.run(`SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))`, [tenantId, refTableId]);

    // Capture every event/audit input inside the tx, before any mutation, so
    // they are mutually consistent and consistent with the version snapshot
    // written below (#152). changedKeysSince routes through tx.all so it reads
    // this transaction's snapshot, not a separate pooled connection.
    recordChangedForEvent = await changedKeysSince(
      refTableId,
      tenantId,
      lastPublish?.at ?? null,
      { dimTable: meta.dimTable, keyCol: meta.keyCol },
      tx.all,
    );
    // Distinct target_keys — read before the draft rows are deleted below.
    committedRows = await tx.all<{ target_key: string }>(
      `SELECT DISTINCT target_key FROM ${DRAFT}
       WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL${scopeClause}${authorClause}`,
      baseParams(),
    );
    // Approved drafts — passed to the warehouse adapter after the tx commits.
    // DISTINCT ON (lower(raw)) collapses the same raw drafted by multiple
    // editors (draft PK is per-user) to one row — latest draft wins — so the
    // warehouse map MERGE agrees with the single-row-per-raw Postgres fold below.
    approvedDrafts = await tx.all<{ raw: string; key: string; label: string | null }>(
      `SELECT DISTINCT ON (lower(raw)) raw, target_key AS key, target_label AS label FROM ${DRAFT}
       WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped' AND target_key IS NOT NULL${scopeClause}${authorClause}
       ORDER BY lower(raw), created_at DESC, user_id`,
      baseParams(),
    );
    // Remaps (raw already mapped but to a different target_key) — recorded
    // separately in the outbound event and audit log.
    const remappedDrafts = await tx.all<{ raw: string; from_key: string; to_key: string }>(
      `SELECT d.raw, m.${key} AS from_key, d.target_key AS to_key
       FROM ${DRAFT} d
       JOIN ${MAPT} m ON lower(m.raw) = lower(d.raw)
       WHERE d.reference_table_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped'
         AND d.target_key IS NOT NULL AND m.${key} <> d.target_key${scopeClauseD}${authorClauseD}`,
      baseParamsD(),
    );

    // Update existing map rows whose target has changed (remaps).
    if (remappedDrafts.length > 0) {
      await tx.run(
        `UPDATE ${MAPT} m
         SET ${key} = d.target_key
         FROM ${DRAFT} d
         WHERE lower(m.raw) = lower(d.raw)
           AND d.reference_table_id = $1 AND d.tenant_id = $2
           AND d.status = 'mapped' AND d.target_key IS NOT NULL
           AND m.${key} <> d.target_key${scopeClauseD}${authorClauseD}`,
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
           WHERE d.reference_table_id = $1 AND d.tenant_id = $2
             AND d.status = 'mapped' AND d.target_key IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)${scopeClauseD}${authorClauseD}
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
         WHERE d.reference_table_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped' AND d.target_key IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)${scopeClauseD}${authorClauseD}`,
        baseParamsD(),
      );
    }
    // DISTINCT ON (lower(d.raw)) collapses the same raw drafted by multiple
    // editors (draft PK is per-user) to a single map row — latest draft wins —
    // so two editors mapping the same value can't violate the raw PK on the
    // map table. The NOT EXISTS still guards against raws already committed.
    await tx.run(
      `INSERT INTO ${MAPT} (raw, ${key})
       SELECT DISTINCT ON (lower(d.raw)) d.raw, d.target_key FROM ${DRAFT} d
       WHERE d.reference_table_id = $1 AND d.tenant_id = $2 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${MAPT} m WHERE lower(m.raw) = lower(d.raw))${scopeClauseD}${authorClauseD}
       ORDER BY lower(d.raw), d.created_at DESC, d.user_id`,
      baseParamsD(),
    );
    // DELETE: scoped → only the requested draft raws; author-scoped → only that
    // author's drafts; otherwise every mapped draft for the table.
    await tx.run(
      `DELETE FROM ${DRAFT} WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped'${scopeClause}${authorClause}`,
      baseParams(),
    );

    // Outbound event for downstream subscribers (PR3). Uses a count-based
    // per-(tenant, refTable, type) monotonic counter — simpler than extracting
    // payload->>'version' from a jsonb column and equally correct since we
    // only insert one table.published event per commit() inside this tx.
    const versionRow = await tx.get<{ v: number }>(
      `SELECT count(*)::int + 1 AS v
         FROM ${pg("outbound_event")}
        WHERE tenant_id = $1 AND reference_table_id = $2 AND type = 'table.published'`,
      [tenantId, refTableId],
    );
    const v = versionRow?.v ?? 1;
    await writeVersionSnapshot(tx, {
      tenantId,
      refTableId,
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
    // publish") run against record_version.updated_at, which is DB now().
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
      refTableId,
      occurredAt: dbNow?.now ?? new Date(),
      payload: {
        table_slug: refTableId,
        table_label: meta.label,
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
          updated: recordChangedForEvent.length,
          merged: 0,
          retired: 0,
        },
        ...(addedKeys.length > 200 || remappedKeys.length > 200 ? { changes_truncated: true } : {}),
        kind: opts?.kind ?? "publish",
        ...(opts?.restoresVersion != null ? { restores_version: opts.restoresVersion } : {}),
      },
      idemKey: `table.published:${refTableId}:${v}`,
    });
  });

  // Per-row audit: one entry per distinct target_key so each record row
  // gets a "Mia · 3m ago" badge in the activity feed.
  for (const row of committedRows) {
    await appendAuditAs(userId, "Committed mapping", `→ ${row.target_key}`, {
      tableId: refTableId,
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
      `${recordChangedForEvent.length} record change${recordChangedForEvent.length === 1 ? "" : "s"} → ${meta.dimTable}`,
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
    const refTableSpec = {
      refTableId,
      dimTable: meta.dimTable,
      mapTable: meta.mapTable,
      keyCol: meta.keyCol,
    };
    const extras = await warehouseExtras(refTableId, tenantId, meta, recordChangedForEvent);
    try {
      await adapter.ensureRecordTables(refTableSpec);
      await adapter.commitRecord(refTableSpec, approvedDrafts, extras);
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
  // record label (e.g. after a record record was deleted).
  const currentLabels = await pgAll<{ label: string }>(
    `SELECT label FROM ${cq(meta.dimTable)} WHERE label IS NOT NULL`,
  ).catch(() => [] as { label: string }[]);
  if (currentLabels.length > 0) {
    const labelArr = currentLabels.map((r) => r.label);
    await pgRun(
      `DELETE FROM ${pg("ai_hint_cache")}
       WHERE reference_table_id = $1 AND suggestion IS NOT NULL AND NOT (suggestion = ANY($2::text[]))`,
      [refTableId, labelArr],
    ).catch(() => {
      /* table may not exist in older deploys */
    });
  }

  return { committed, rowsRecovered, warehouseSynced };
}

/** The published state a draft payload can't express, read back from Postgres
 *  (the master copy) after the fold: records renamed without a draft of their
 *  own, records this publish retired or merged away, and the map rows a merge
 *  re-pointed to the survivor. Without these the warehouse MERGE is
 *  append-only and its dim_/map_ tables drift from the published version. */
async function warehouseExtras(
  refTableId: string,
  tenantId: string,
  meta: { dimTable: string; mapTable: string; keyCol: string },
  changedKeys: string[],
): Promise<RecordSyncExtras> {
  if (changedKeys.length === 0) return {};
  const key = qid(meta.keyCol);
  const live = await pgAll<{ key: string; label: string | null }>(
    `SELECT ${key}::text AS key, label FROM ${cq(meta.dimTable)} WHERE ${key}::text = ANY($1::text[])`,
    [changedKeys],
  );
  const liveKeys = new Set(live.map((r) => r.key));
  const retiredKeys = changedKeys.filter((k) => !liveKeys.has(k));
  if (retiredKeys.length === 0) return { records: live };
  // A merged-away key hands its variants to a survivor. Those map rows moved
  // without a draft, so the warehouse has to learn their new target before the
  // retired key is deleted — otherwise the delete takes the mappings with it.
  const mappings = await pgAll<{ raw: string; key: string }>(
    `SELECT m.raw, m.${key}::text AS key FROM ${cq(meta.mapTable)} m
      WHERE m.${key}::text IN (
        SELECT retired_into FROM ${pg("record_version")}
         WHERE reference_table_id = $1 AND tenant_id = $2
           AND key = ANY($3::text[]) AND retired_into IS NOT NULL)`,
    [refTableId, tenantId, retiredKeys],
  );
  return { records: live, mappings, retiredKeys };
}

/** Warehouse rows for raws that have a mapped draft but aren't yet in the map.
 *  Reads materialized source_scan_occurrence rather than re-querying the warehouse. */
async function rowsForUnmappedDrafts(
  refTableId: string,
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
       FROM zugzug_app.source_scan_value v
       JOIN zugzug_app.source_scan_occurrence o
         ON o.tenant_id = v.tenant_id AND o.reference_table_id = v.reference_table_id AND o.raw_lower = v.raw_lower
       WHERE v.tenant_id = $1 AND v.reference_table_id = $2`,
    [tenantId, refTableId],
  );
  if (!occRows.length) return 0;

  // Postgres: draft raws for this refTable with status=mapped
  const draftRows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${pg("draft")} WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped'`,
    [refTableId, tenantId],
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
