/* repo-outbound.ts — Pull-API-shaped query helpers.

   These return JSON-wire shapes (snake_case, ISO timestamps, cursor strings)
   directly — the route handlers in v1-routes.ts wrap the result and add
   HTTP-level concerns (status code, content-type). Keeping the wire-shape
   computation here makes it independently testable and ensures the
   handlers stay thin. */

import { env, pg } from "./env.ts";
import { pgAll, pgGet } from "./pg.ts";
import { signCursor, verifyCursor, type CursorPayload } from "./cursor.ts";
import { cq, qid } from "./repo-shared.ts";
import { listFields } from "./repo-record.ts";

const DEFAULT_LIMIT_RECORD = 100;
const MAX_LIMIT_RECORD = 1000;
const DEFAULT_LIMIT_TOMBSTONES = 100;
const MAX_LIMIT_TOMBSTONES = 1000;

export interface RefTableForApi {
  slug: string;
  label: string;
  key_kind: string;
  record_count: number;
  last_published_at: string | null;
}

export interface SchemaForApi {
  dim_slug: string;
  label: string;
  fields: Array<{ name: string; type: string; description: string | null }>;
}

export interface RecordRow {
  key: string;
  label: string;
  fields: Record<string, unknown>;
  updated_at: string;
  version: number;
}

export interface PageMeta {
  dim_slug: string;
  page_size: number;
}

export interface RecordPageResponse {
  records: RecordRow[];
  cursor: { next: string | null };
  meta: PageMeta;
}

export interface TombstoneRecord {
  key: string;
  retired_at: string;
  retired_into: string | null;
}

export interface TombstonePageResponse {
  removed: TombstoneRecord[];
  cursor: { next: string | null };
}

export interface PageOpts {
  since?: string;
  cursor?: string;
  limit?: number;
}

function getCursorKey(): string {
  // Read process.env first so test files that set ZUGZUG_CURSOR_KEY at the
  // top still pick up the value when env.ts was imported earlier in the
  // suite (cached cursorKeyB64=null at that point).
  const key = process.env.ZUGZUG_CURSOR_KEY?.trim() || env.cursorKeyB64;
  if (!key) {
    throw new Error("ZUGZUG_CURSOR_KEY is not set — Pull API cannot sign cursors");
  }
  return key;
}

function clampLimit(n: number | undefined, def: number, max: number): number {
  if (!n || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Split a dim_table value like "zugzug.dim_country" into { schema, table }. */
function splitRefTableTable(dimTable: string): { schema: string; table: string } {
  const dot = dimTable.indexOf(".");
  if (dot < 0) return { schema: env.recordSchema, table: dimTable };
  return { schema: dimTable.slice(0, dot), table: dimTable.slice(dot + 1) };
}

/** Cache of a dim_* table's field columns (#153). discoverFieldColumns ran an
 *  information_schema query on EVERY listRecordPage / getRecordRow; the column
 *  set only changes on a schema mutation (add/remove field), which is rare
 *  relative to record reads. A short TTL bounds staleness (an added field shows
 *  up in the Pull API's `fields` within FIELD_COLS_TTL_MS) while self-healing —
 *  no cross-module invalidation to miss. Keyed by "schema.table:keyCol". */
const FIELD_COLS_TTL_MS = 30_000;
const fieldColsCache = new Map<string, { cols: string[]; at: number }>();

/** Discover non-system field columns of a dim_* table for dynamic JSON projection. */
async function discoverFieldColumns(dimTable: string, keyCol: string): Promise<string[]> {
  const { schema, table } = splitRefTableTable(dimTable);
  const cacheKey = `${schema}.${table}:${keyCol}`;
  const hit = fieldColsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FIELD_COLS_TTL_MS) return hit.cols;

  const refTableCols = await pgAll<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
        AND column_name NOT IN ('label', 'position', 'tenant_id')`,
    [schema, table],
  );
  const cols = refTableCols.map((c) => c.column_name).filter((c) => c !== keyCol);
  fieldColsCache.set(cacheKey, { cols, at: Date.now() });
  return cols;
}

function buildFieldsJsonExpr(fieldColumns: string[]): string {
  if (fieldColumns.length === 0) return `'{}'::jsonb`;
  return `jsonb_build_object(${fieldColumns
    .map((c) => `'${c.replace(/'/g, "''")}', d.${qid(c)}`)
    .join(",")})`;
}

/* ---------- list refTables ---------- */

export async function listRefTablesForApi(tenantId: string): Promise<{ tables: RefTableForApi[] }> {
  const rows = await pgAll<{
    id: string;
    label: string;
    key_kind: string | null;
    record_count: number;
    last_published_at: string | null;
  }>(
    // One GROUP BY join over record_version instead of two correlated
    // subqueries per table (#153). count()/max() ignore the NULLs a LEFT JOIN
    // produces for tables with no live records, so empty tables report 0/null.
    `SELECT d.id,
            d.label,
            COALESCE(d.key_kind, 'slug') AS key_kind,
            count(cv.key) FILTER (WHERE cv.retired_at IS NULL)::int AS record_count,
            max(cv.updated_at) FILTER (WHERE cv.retired_at IS NULL)::text AS last_published_at
       FROM ${pg("reference_table")} d
       LEFT JOIN "zugzug_app"."record_version" cv
         ON cv.reference_table_id = d.id AND cv.tenant_id = d.tenant_id
      WHERE d.tenant_id = $1
      GROUP BY d.id, d.label, d.key_kind
      ORDER BY d.label`,
    [tenantId],
  );
  return {
    tables: rows.map((r) => ({
      slug: r.id,
      label: r.label,
      key_kind: r.key_kind ?? "slug",
      record_count: r.record_count,
      last_published_at: r.last_published_at,
    })),
  };
}

/* ---------- schema ---------- */

export async function getSchemaForApi(
  tenantId: string,
  slug: string,
): Promise<SchemaForApi | null> {
  const refTable = await pgGet<{ id: string; label: string }>(
    `SELECT id, label FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [slug, tenantId],
  );
  if (!refTable) return null;
  const fields = await listFields(slug, tenantId);
  return {
    dim_slug: refTable.id,
    label: refTable.label,
    fields: fields.map((f) => ({
      name: f.field,
      type: f.type,
      description: f.description ?? null,
    })),
  };
}

/* ---------- record page ---------- */

export async function listRecordPage(
  tenantId: string,
  slug: string,
  opts: PageOpts,
): Promise<RecordPageResponse> {
  const limit = clampLimit(opts.limit, DEFAULT_LIMIT_RECORD, MAX_LIMIT_RECORD);

  let sinceTs: string | null = opts.since ?? null;
  let sinceKey: string | null = null;
  if (opts.cursor) {
    const v = verifyCursor(opts.cursor, getCursorKey(), tenantId);
    if (!v.ok) {
      throw new Error(v.reason);
    }
    sinceTs = v.payload.u;
    sinceKey = v.payload.k;
  }

  const refTable = await pgGet<{ dim_table: string; key_col: string }>(
    `SELECT dim_table, key_col FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [slug, tenantId],
  );
  if (!refTable) {
    return { records: [], cursor: { next: null }, meta: { dim_slug: slug, page_size: limit } };
  }
  const keyCol = qid(refTable.key_col);

  const fieldColumns = await discoverFieldColumns(refTable.dim_table, refTable.key_col);
  const fieldsJsonExpr = buildFieldsJsonExpr(fieldColumns);

  const params: unknown[] = [tenantId, slug];
  let where = `d.tenant_id = $1 AND cv.tenant_id = $1 AND cv.reference_table_id = $2 AND cv.retired_at IS NULL`;
  if (sinceTs) {
    params.push(sinceTs);
    where += ` AND cv.updated_at >= $${params.length}::text::timestamp`;
  }
  if (sinceTs && sinceKey) {
    params.push(sinceKey);
    where += ` AND (cv.updated_at, d.${keyCol}) > ($${params.length - 1}::text::timestamp, $${params.length})`;
  }
  params.push(limit + 1);

  const sql = `
    SELECT d.${keyCol} AS key,
           d.label,
           ${fieldsJsonExpr} AS fields,
           cv.updated_at::text AS updated_at,
           cv.version
      FROM ${cq(refTable.dim_table)} d
      JOIN "zugzug_app"."record_version" cv
        ON cv.reference_table_id = $2 AND cv.tenant_id = $1 AND cv.key = d.${keyCol}
     WHERE ${where}
     ORDER BY cv.updated_at ASC, d.${keyCol} ASC
     LIMIT $${params.length}
  `;

  const rows = await pgAll<{
    key: string;
    label: string;
    fields: Record<string, unknown> | null;
    updated_at: string;
    version: number;
  }>(sql, params);

  let next: string | null = null;
  if (rows.length > limit) {
    rows.pop();
    const tail = rows[rows.length - 1]!;
    const payload: CursorPayload = { t: tenantId, u: tail.updated_at, k: tail.key, v: 1 };
    next = signCursor(payload, getCursorKey());
  }

  return {
    records: rows.map((r) => ({
      key: r.key,
      label: r.label,
      fields: r.fields ?? {},
      updated_at: r.updated_at,
      version: r.version,
    })),
    cursor: { next },
    meta: { dim_slug: slug, page_size: limit },
  };
}

/* ---------- single record row ---------- */

export async function getRecordRow(
  tenantId: string,
  slug: string,
  key: string,
): Promise<RecordRow | null> {
  const refTable = await pgGet<{ dim_table: string; key_col: string }>(
    `SELECT dim_table, key_col FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [slug, tenantId],
  );
  if (!refTable) return null;
  const keyCol = qid(refTable.key_col);
  const fieldColumns = await discoverFieldColumns(refTable.dim_table, refTable.key_col);
  const fieldsJsonExpr = buildFieldsJsonExpr(fieldColumns);

  const row = await pgGet<{
    key: string;
    label: string;
    fields: Record<string, unknown> | null;
    updated_at: string;
    version: number;
  }>(
    `SELECT d.${keyCol} AS key,
            d.label,
            ${fieldsJsonExpr} AS fields,
            cv.updated_at::text AS updated_at,
            cv.version
       FROM ${cq(refTable.dim_table)} d
       JOIN "zugzug_app"."record_version" cv
         ON cv.reference_table_id = $1 AND cv.tenant_id = $2 AND cv.key = d.${keyCol}
      WHERE d.tenant_id = $2
        AND d.${keyCol} = $3
        AND cv.retired_at IS NULL`,
    [slug, tenantId, key],
  );
  if (!row) return null;
  return {
    key: row.key,
    label: row.label,
    fields: row.fields ?? {},
    updated_at: row.updated_at,
    version: row.version,
  };
}

/* ---------- tombstones page ---------- */

export async function listTombstonesPage(
  tenantId: string,
  slug: string,
  opts: PageOpts,
): Promise<TombstonePageResponse> {
  const limit = clampLimit(opts.limit, DEFAULT_LIMIT_TOMBSTONES, MAX_LIMIT_TOMBSTONES);

  let sinceTs: string | null = opts.since ?? null;
  let sinceKey: string | null = null;
  if (opts.cursor) {
    const v = verifyCursor(opts.cursor, getCursorKey(), tenantId);
    if (!v.ok) throw new Error(v.reason);
    sinceTs = v.payload.u;
    sinceKey = v.payload.k;
  }

  const params: unknown[] = [tenantId, slug];
  let where = `tenant_id = $1 AND reference_table_id = $2 AND retired_at IS NOT NULL`;
  if (sinceTs) {
    params.push(sinceTs);
    where += ` AND retired_at >= $${params.length}::text::timestamp`;
  }
  if (sinceTs && sinceKey) {
    params.push(sinceKey);
    where += ` AND (retired_at, key) > ($${params.length - 1}::text::timestamp, $${params.length})`;
  }
  params.push(limit + 1);

  const rows = await pgAll<{ key: string; retired_at: string; retired_into: string | null }>(
    `SELECT key, retired_at::text AS retired_at, retired_into
       FROM ${pg("record_version")}
      WHERE ${where}
      ORDER BY retired_at ASC, key ASC
      LIMIT $${params.length}`,
    params,
  );

  let next: string | null = null;
  if (rows.length > limit) {
    rows.pop();
    const tail = rows[rows.length - 1]!;
    next = signCursor({ t: tenantId, u: tail.retired_at, k: tail.key, v: 1 }, getCursorKey());
  }

  return {
    removed: rows.map((r) => ({
      key: r.key,
      retired_at: r.retired_at,
      retired_into: r.retired_into,
    })),
    cursor: { next },
  };
}

/* ---------- events ---------- */

export interface EventRecord {
  id: string;
  type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface EventPageResponse {
  events: EventRecord[];
  cursor: { next: string | null };
}

export interface EventPageOpts extends PageOpts {
  type?: string;
}

const DEFAULT_LIMIT_EVENTS = 50;
const MAX_LIMIT_EVENTS = 200;

export async function listEventsPage(
  tenantId: string,
  opts: EventPageOpts,
): Promise<EventPageResponse> {
  const limit = clampLimit(opts.limit, DEFAULT_LIMIT_EVENTS, MAX_LIMIT_EVENTS);

  let sinceTs: string | null = opts.since ?? null;
  let sinceId: string | null = null;
  if (opts.cursor) {
    const v = verifyCursor(opts.cursor, getCursorKey(), tenantId);
    if (!v.ok) throw new Error(v.reason);
    sinceTs = v.payload.u;
    sinceId = v.payload.k;
  }

  const params: unknown[] = [tenantId];
  let where = `tenant_id = $1`;
  if (opts.type) {
    params.push(opts.type);
    where += ` AND type = $${params.length}`;
  }
  if (sinceTs) {
    params.push(sinceTs);
    where += ` AND occurred_at >= $${params.length}::text::timestamp`;
  }
  if (sinceTs && sinceId) {
    params.push(sinceId);
    where += ` AND (occurred_at, id) > ($${params.length - 1}::text::timestamp, $${params.length})`;
  }
  params.push(limit + 1);

  const rows = await pgAll<{
    id: string;
    type: string;
    occurred_at: string;
    payload: Record<string, unknown> | null;
  }>(
    `SELECT id, type, occurred_at::text AS occurred_at, payload
       FROM ${pg("outbound_event")}
      WHERE ${where}
      ORDER BY occurred_at ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );

  let next: string | null = null;
  if (rows.length > limit) {
    rows.pop();
    const tail = rows[rows.length - 1]!;
    next = signCursor({ t: tenantId, u: tail.occurred_at, k: tail.id, v: 1 }, getCursorKey());
  }

  return {
    events: rows.map((r) => ({
      id: r.id,
      type: r.type,
      occurred_at: r.occurred_at,
      data: r.payload ?? {},
    })),
    cursor: { next },
  };
}
