/* repo-scan.ts — warehouse scanning (DuckDB-backed) + the sources registry.
 *
 * Manages the reference_table_source / source_stat tables in Postgres and drives
 * the DuckDB queries that count distinct values in MotherDuck. */

import {
  type SourceInfo,
  type SchemaFacet,
  type CatalogTable,
  slug,
  qid,
  cq,
  liveSources,
  pgAll,
  pgGet,
  pgRun,
  env,
  pg,
  log,
  refOf,
  refForRegisteredTable,
} from "./repo-shared.ts";
import type { Ref } from "./warehouse/adapter.ts";
import { getAdapter } from "./warehouse/registry.ts";
import { withTimeout } from "./warehouse/timeout.ts";
import { appendAuditAs } from "./repo-meta.ts";
import { materializeSourceScanValues } from "./repo-source-scan.ts";
import { clusterForSeed } from "./cluster-values.ts";
import { AppError } from "./errors.ts";

export interface UnmappedSample {
  raw: string;
  rows: number;
}

/** Registered source columns, read from the cached stats (POST /api/sources/scan
 *  refreshes them) so this is instant regardless of source count. Supports search
 *  (q), schema filter, and a status filter; ranked by unmapped (rows at risk). */
export async function listSources(opts: {
  q?: string;
  schema?: string;
  status?: string;
  tenantId: string;
}): Promise<SourceInfo[]> {
  const params: unknown[] = [opts.tenantId];
  const where: string[] = [`s.tenant_id = $1`];
  if (opts.q) {
    params.push(`%${opts.q}%`);
    const p = `$${params.length}`;
    where.push(`((s.schema_name || '.' || s.table_name) ILIKE ${p} OR s.column_name ILIKE ${p})`);
  }
  if (opts.schema) {
    params.push(opts.schema);
    where.push(`s.schema_name = $${params.length}`);
  }
  if (opts.status === "needs") where.push(`COALESCE(st.unmapped, 0) > 0`);
  else if (opts.status === "clean")
    where.push(`COALESCE(st.present, false) AND COALESCE(st.unmapped, 0) = 0`);
  // "missing" is the column-is-gone state only — a failed scan proves nothing
  // about the column, so it gets its own filter.
  else if (opts.status === "missing")
    where.push(`st.scanned_at IS NOT NULL AND NOT st.present AND st.scan_error IS NULL`);
  else if (opts.status === "failed") where.push(`st.scan_error IS NOT NULL`);

  const rows = await pgAll<{
    refTableId: string;
    refTable: string;
    databaseId: string;
    databaseName: string;
    table: string;
    column: string;
    present: boolean;
    rows: number;
    values: number;
    unmapped: number;
    scanned: boolean;
    scanError: string | null;
    scannedAt: string | null;
  }>(
    `SELECT s.reference_table_id AS "refTableId", d.label AS "refTable",
            s.database_id AS "databaseId", wd.database_name AS "databaseName",
            (s.schema_name || '.' || s.table_name) AS "table",
            s.column_name AS column,
            COALESCE(st.present, false) AS present,
            COALESCE(st.rows, 0)::int AS rows,
            COALESCE(st.distinct_values, 0)::int AS values,
            COALESCE(st.unmapped, 0)::int AS unmapped,
            (st.scanned_at IS NOT NULL) AS scanned,
            st.scan_error AS "scanError",
            st.scanned_at::text AS "scannedAt"
     FROM ${pg("reference_table_source")} s
     JOIN ${pg("reference_table")} d ON d.id = s.reference_table_id AND d.tenant_id = s.tenant_id
     JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
     LEFT JOIN ${pg("source_stat")} st
       ON st.reference_table_id = s.reference_table_id
      AND st.database_id = s.database_id
      AND st.schema_name = s.schema_name
      AND st.table_name  = s.table_name
      AND st.column_name = s.column_name
      AND st.tenant_id = s.tenant_id
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(st.unmapped, 0) DESC, s.schema_name, s.table_name, s.column_name
     LIMIT 1000`,
    params,
  );
  return rows.map((r) => ({
    databaseId: r.databaseId,
    databaseName: r.databaseName,
    table: r.table,
    column: r.column,
    refTable: r.refTable,
    refTableId: r.refTableId,
    present: !!r.present,
    rows: Number(r.rows),
    values: Number(r.values),
    unmapped: Number(r.unmapped),
    scanned: !!r.scanned,
    scanError: r.scanError ?? null,
    scannedAt: r.scannedAt ?? null,
  }));
}

/** Per-schema rollup for the facet rail — turns N source columns into ~systems. */
export async function sourceFacets(tenantId: string): Promise<SchemaFacet[]> {
  const rows = await pgAll<{ schema: string; columns: number; unmapped: number; missing: number }>(
    `SELECT s.schema_name AS schema,
            count(*)::int AS columns,
            COALESCE(sum(st.unmapped), 0)::int AS unmapped,
            count(*) FILTER (WHERE st.scanned_at IS NOT NULL AND NOT st.present
                                   AND st.scan_error IS NULL)::int AS missing
     FROM ${pg("reference_table_source")} s
     LEFT JOIN ${pg("source_stat")} st
       ON st.reference_table_id      = s.reference_table_id
      AND st.tenant_id   = s.tenant_id
      AND st.database_id = s.database_id
      AND st.schema_name = s.schema_name
      AND st.table_name  = s.table_name
      AND st.column_name = s.column_name
     WHERE s.tenant_id = $1
     GROUP BY 1 ORDER BY unmapped DESC, schema`,
    [tenantId],
  );
  return rows.map((r) => ({
    schema: r.schema,
    columns: Number(r.columns),
    unmapped: Number(r.unmapped),
    missing: Number(r.missing),
  }));
}

/** Refresh the cached stats for every registered source (the expensive scan,
 *  run explicitly). Returns how many sources were scanned. */
export async function scanSources(tenantId: string): Promise<number> {
  const regs = await pgAll<{
    refTableId: string;
    databaseId: string;
    catalog: string;
    schema: string;
    table: string;
    column: string;
    mapTable: string;
  }>(
    `SELECT s.reference_table_id        AS "refTableId",
            s.database_id   AS "databaseId",
            wd.database_name AS "catalog",
            s.schema_name   AS "schema",
            s.table_name    AS "table",
            s.column_name   AS "column",
            d.map_table     AS "mapTable"
       FROM ${pg("reference_table_source")} s
       JOIN ${pg("reference_table")}          d  ON d.id  = s.reference_table_id      AND d.tenant_id  = s.tenant_id
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
      WHERE s.tenant_id = $1`,
    [tenantId],
  );
  const adapter = await getAdapter();
  for (const r of regs) {
    await scanOneSource(r, adapter, tenantId);
  }

  const refTableIds = [...new Set(regs.map((r) => r.refTableId))];
  for (const refTableId of refTableIds) {
    await materializeOneDim(refTableId, adapter, tenantId).catch((e) => {
      log({
        level: "error",
        msg: "materialize-refTable",
        refTableId,
        err: e instanceof Error ? e.message : String(e),
      });
    });
  }

  return regs.length;
}

/** Rescan a single refTable — rescans its registered sources, then re-materializes
 *  its source_scan_value/source_scan_occurrence rows. Faster than scanSources when
 *  the user only wants to refresh one table. */
export async function scanOneDim(refTableId: string, tenantId: string): Promise<void> {
  const regs = await pgAll<ScanReg>(
    `SELECT s.reference_table_id        AS "refTableId",
            s.database_id   AS "databaseId",
            wd.database_name AS "catalog",
            s.schema_name   AS "schema",
            s.table_name    AS "table",
            s.column_name   AS "column",
            d.map_table     AS "mapTable"
       FROM ${pg("reference_table_source")} s
       JOIN ${pg("reference_table")}          d  ON d.id  = s.reference_table_id      AND d.tenant_id  = s.tenant_id
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
      WHERE s.tenant_id = $1 AND s.reference_table_id = $2`,
    [tenantId, refTableId],
  );
  const adapter = await getAdapter();
  for (const r of regs) {
    await scanOneSource(r, adapter, tenantId);
  }
  await materializeOneDim(refTableId, adapter, tenantId);
}

/** Run the warehouse provenance query for one refTable and write the result into
 *  source_scan_value + source_scan_occurrence. Idempotent — replaces prior rows. */
async function materializeOneDim(
  refTableId: string,
  adapter: Awaited<ReturnType<typeof getAdapter>>,
  tenantId: string,
): Promise<void> {
  const t0 = performance.now();
  const sources = await liveSources(refTableId, tenantId);
  if (!sources.length) {
    await materializeSourceScanValues(refTableId, tenantId, {
      occurrences: [],
      scannedAt: new Date(),
    });
    log({
      level: "info",
      msg: "materialize-refTable",
      refTableId,
      distinct: 0,
      ms: Math.round(performance.now() - t0),
    });
    return;
  }
  const refs = sources.map((s) => ({ table: refOf(s), column: s.column }));
  const occRows = await adapter.distinctValuesWithProvenance(refs);
  const occurrences = occRows
    .map((r) => {
      const src = sources[r.sourceIndex];
      if (!src) return null;
      return { raw: r.value, table: src.table, column: src.column, rows: r.count };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  await materializeSourceScanValues(refTableId, tenantId, { occurrences, scannedAt: new Date() });
  log({
    level: "info",
    msg: "materialize-refTable",
    refTableId,
    distinct: new Set(occurrences.map((o) => o.raw.toLowerCase())).size,
    occurrences: occurrences.length,
    ms: Math.round(performance.now() - t0),
  });
}

type ScanReg = {
  refTableId: string;
  databaseId: string;
  catalog: string;
  schema: string;
  table: string;
  column: string;
  mapTable: string;
};

/** Scan a single registered source and upsert its row in source_stat. Shared
 *  by scanSources (bulk) and the auto-scan path in deriveRecord (per-wire). */
async function scanOneSource(
  r: ScanReg,
  adapter: Awaited<ReturnType<typeof getAdapter>>,
  tenantId: string,
): Promise<void> {
  const SCAN_TIMEOUT_MS = 30_000;
  const ref: Ref = { catalog: r.catalog, schema: r.schema, table: r.table };
  const displayTable = `${r.schema}.${r.table}`;
  let present: boolean;
  let scanError: string | null = null;
  let rows = 0;
  let distinct = 0;
  let unmapped = 0;
  const t0 = performance.now();
  try {
    const stats = await Promise.race([
      adapter.columnStats(ref, r.column),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("scan timeout")), SCAN_TIMEOUT_MS),
      ),
    ]);
    present = true;
    rows = stats.rows;
    distinct = stats.distinct;
    if (distinct > 0) {
      try {
        const whRaws = await adapter.distinctValues(ref, r.column, 100000);
        const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(r.mapTable)}`);
        const mappedSet = new Set(mappedRows.map((m) => m.raw.toLowerCase()));
        unmapped = whRaws.filter((w) => !mappedSet.has(w.toLowerCase())).length;
      } catch {
        /* either side missing — leave at 0 */
      }
    }
    const ms = Math.round(performance.now() - t0);
    log({
      level: ms > 5000 ? "warn" : "info",
      msg: "scan-source",
      table: displayTable,
      column: r.column,
      ms,
      rows,
      distinct,
      unmapped,
    });
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const timedOut = e instanceof Error && e.message === "scan timeout";
    log({
      level: "error",
      msg: "scan-source",
      table: displayTable,
      column: r.column,
      ms,
      err: e instanceof Error ? e.message : String(e),
      timedOut,
    });
    present = false;
    // The scan never reached an answer, so "the column is missing" is not one
    // of the things we learned. Persist why — unless a cheap follow-up probe
    // shows the column really is gone, which is the one case where
    // "column not found" is the truth.
    scanError = timedOut ? "scan timed out" : e instanceof Error ? e.message : String(e);
    try {
      const cols = await withTimeout(() => adapter.listColumns(ref), 5_000, "listColumns");
      if (!cols.some((c) => c.name.toLowerCase() === r.column.toLowerCase())) scanError = null;
    } catch {
      /* the probe failed too — keep the scan error, don't invent a verdict */
    }
  }
  await pgRun(
    `INSERT INTO ${pg("source_stat")}
       (tenant_id, reference_table_id, database_id, schema_name, table_name, column_name,
        present, rows, distinct_values, unmapped, scan_error, scanned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, current_timestamp)
     ON CONFLICT (tenant_id, reference_table_id, database_id, schema_name, table_name, column_name) DO UPDATE SET
       present         = EXCLUDED.present,
       rows            = EXCLUDED.rows,
       distinct_values = EXCLUDED.distinct_values,
       unmapped        = EXCLUDED.unmapped,
       scan_error      = EXCLUDED.scan_error,
       scanned_at      = EXCLUDED.scanned_at`,
    [
      tenantId,
      r.refTableId,
      r.databaseId,
      r.schema,
      r.table,
      r.column,
      present,
      rows,
      distinct,
      unmapped,
      scanError,
    ],
  );
}

/** List refTable IDs that have at least one wired source. Used by the
 *  auto-stage scheduler job to know which refTables to process per tick. */
export async function refTablesWithWiredSources(tenantId: string): Promise<string[]> {
  const rows = await pgAll<{ refTableId: string }>(
    `SELECT DISTINCT reference_table_id AS "refTableId" FROM ${pg("reference_table_source")} WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows.map((r) => r.refTableId);
}

/** The set-based exact-match diff behind autoStageExactMatches (#154). The old
 *  pass materialized every source_scan_value raw, dim label, and map raw into
 *  the Bun process to diff as in-memory sets — a multi-GB spike that OOM'd the
 *  cron scheduler on large tables. This does the whole diff in SQL:
 *   - staged: one INSERT … SELECT stages a u_system draft for each source raw
 *     whose lower(raw) equals an existing record label and isn't already mapped.
 *     DISTINCT ON (v.raw) collapses the case where two labels collide
 *     case-insensitively (picks the smallest key deterministically); without it
 *     the ON CONFLICT would try to touch the same draft twice. The upsert clause
 *     mirrors saveDraft.
 *   - unmatched: source raws neither already mapped nor matching any label.
 *  Split out from the public entry point so it's unit-testable without a live
 *  warehouse (the liveSources gate needs one). */
export async function stageExactMatchDrafts(
  refTableId: string,
  tenantId: string,
  meta: { dimTable: string; mapTable: string; keyCol: string },
): Promise<{ matched: number; unmatched: number }> {
  const staged = await pgAll<{ raw: string }>(
    `INSERT INTO ${pg("draft")}
       (reference_table_id, raw, status, target_label, target_key, user_id, created_at, tenant_id)
     SELECT DISTINCT ON (v.raw)
            $1::varchar, v.raw, 'mapped', d.label, d.${qid(meta.keyCol)}, 'u_system', current_timestamp, $2::varchar
       FROM zugzug_app.source_scan_value v
       JOIN ${cq(meta.dimTable)} d
         ON d.label IS NOT NULL AND lower(d.label) = v.raw_lower
      WHERE v.tenant_id = $2 AND v.reference_table_id = $1
        AND NOT EXISTS (SELECT 1 FROM ${cq(meta.mapTable)} m WHERE lower(m.raw) = v.raw_lower)
      ORDER BY v.raw, d.${qid(meta.keyCol)}
     ON CONFLICT (tenant_id, reference_table_id, raw, user_id) DO UPDATE SET
        status = 'mapped',
        target_label = EXCLUDED.target_label,
        target_key = EXCLUDED.target_key,
        created_at = EXCLUDED.created_at,
        rejected_reason = NULL,
        rejected_by = NULL
     RETURNING raw`,
    [refTableId, tenantId],
  );

  const un = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM zugzug_app.source_scan_value v
      WHERE v.tenant_id = $2 AND v.reference_table_id = $1
        AND NOT EXISTS (SELECT 1 FROM ${cq(meta.mapTable)} m WHERE lower(m.raw) = v.raw_lower)
        AND NOT EXISTS (SELECT 1 FROM ${cq(meta.dimTable)} d
                         WHERE d.label IS NOT NULL AND lower(d.label) = v.raw_lower)`,
    [refTableId, tenantId],
  );

  return { matched: staged.length, unmatched: Number(un?.n ?? 0) };
}

/** Auto-stage a draft (owned by u_system) for every warehouse raw value that
 *  case-insensitively matches an existing record label and is not yet in
 *  the refTable's lookup table. The match is deterministic — no AI, no fuzzy
 *  — so it always lands above any reasonable publish threshold. */
export async function autoStageExactMatches(
  refTableId: string,
  tenantId: string,
): Promise<{ matched: number; unmatched: number }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  if (!meta) return { matched: 0, unmatched: 0 };
  if (meta.keyKind === "external_id") return { matched: 0, unmatched: 0 };

  const sources = await liveSources(refTableId, tenantId);
  if (!sources.length) return { matched: 0, unmatched: 0 };

  const { matched, unmatched } = await stageExactMatchDrafts(refTableId, tenantId, meta);

  if (matched > 0) {
    await appendAuditAs(
      "u_system",
      "Auto-matched",
      `${matched} value${matched === 1 ? "" : "s"} mapped in ${refTableId} (exact label)`,
      { tenantId },
    );
  }
  return { matched, unmatched };
}

/** Register a warehouse column as a source for a refTable (idempotent).
 *  Returns the warehouse_database.id the row was registered against.
 *
 *  Takes the convenience `"schema.table"` + column shape (used by seed and
 *  deriveRecord). The database is resolved in this order: the caller's
 *  explicit `opts.databaseId` (what the catalog UI browsed); else the database
 *  this refTable already has this table registered against — so re-wiring or
 *  re-scanning an existing source never forks a second registration under the
 *  default database; else resolveDefaultDatabase(). */
export async function addSource(
  refTableId: string,
  table: string,
  column: string,
  tenantId: string,
  opts: { silent?: boolean; databaseId?: string } = {},
): Promise<string> {
  const parts = table.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError("VALIDATION_FAILED", `expected "schema.table", got: ${table}`, 422);
  }
  const { resolveDefaultDatabase } = await import("./repo-record.ts");
  const databaseId =
    opts.databaseId ??
    (await databaseOfRegisteredTable(refTableId, parts[0], parts[1], tenantId)) ??
    (await resolveDefaultDatabase(tenantId));
  await pgRun(
    `INSERT INTO ${pg("reference_table_source")} (reference_table_id, tenant_id, database_id, schema_name, table_name, column_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, reference_table_id, database_id, schema_name, table_name, column_name) DO NOTHING`,
    [refTableId, tenantId, databaseId, parts[0], parts[1], column],
  );
  return databaseId;
}

/** The database this refTable already registered `schema.table` against, if any. */
async function databaseOfRegisteredTable(
  refTableId: string,
  schema: string,
  table: string,
  tenantId: string,
): Promise<string | null> {
  const row = await pgGet<{ databaseId: string }>(
    `SELECT database_id AS "databaseId" FROM ${pg("reference_table_source")}
      WHERE tenant_id = $1 AND reference_table_id = $2 AND schema_name = $3 AND table_name = $4
      LIMIT 1`,
    [tenantId, refTableId, schema, table],
  );
  return row?.databaseId ?? null;
}

/** database_name for a registered warehouse database id. */
async function catalogNameOf(databaseId: string): Promise<string | null> {
  const row = await pgGet<{ name: string }>(
    `SELECT database_name AS name FROM ${pg("warehouse_database")} WHERE id = $1`,
    [databaseId],
  );
  return row?.name ?? null;
}

/** Top-N unmapped raw values from a specific warehouse source column, with the
 *  row count of each. Powers the per-row "what's actually broken here" reveal
 *  on the Sources page — drill into a column without leaving the list. */
export async function topUnmapped(
  refTableId: string,
  table: string,
  column: string,
  limit = 5,
  tenantId: string,
  databaseId?: string,
): Promise<UnmappedSample[]> {
  const meta = await pgGet<{ mapTable: string }>(
    `SELECT map_table AS "mapTable" FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  if (!meta) return [];
  if (!env.attachWarehouse) return [];
  const ref = await refForRegisteredTable(refTableId, table, tenantId, databaseId);
  if (!ref) return [];
  const adapter = await getAdapter();
  const n = Math.max(1, Math.min(50, Math.round(limit)));

  const occ = await adapter
    .topValuesByFrequency(ref, column, 10000)
    .catch(() => [] as { value: string; count: number }[]);
  const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(meta.mapTable)}`).catch(
    () => [] as { raw: string }[],
  );
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  return occ
    .filter((r) => !mappedSet.has(r.value.toLowerCase()))
    .slice(0, n)
    .map((r) => ({ raw: r.value, rows: r.count }));
}

/** Returns true when the workspace scan is due based on preferences.scan_schedule
 *  and the last scanned_at timestamp. The scheduler uses this as a cheap
 *  is-anything-pending check before triggering scanSources (which scans them all).
 *  Returns false (silently) if the app-state schema hasn't been provisioned yet —
 *  the scheduler tick should no-op on a fresh DB, not spam the logs.
 *
 *  Pass `tenantId === "*"` from the super-admin scheduler to ask "is ANY tenant
 *  due?" in a single query. */
export async function anyScanDue(
  now: Date = new Date(),
  tenantId: string = "default",
): Promise<boolean> {
  if (tenantId === "*") {
    // Cross-tenant: true iff at least one tenant has a non-null scan_schedule
    // and either (a) has unscanned registered sources, or (b) the latest scan
    // for that tenant is older than the cadence window. Cheap proxy: any tenant
    // with scan_schedule set AND (no source_stat OR stale max scanned_at).
    try {
      const row = await pgGet<{ due: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM ${pg("preferences")} p
           WHERE p.scan_schedule IS NOT NULL
             AND (
               EXISTS (
                 SELECT 1 FROM ${pg("reference_table_source")} ds
                 WHERE ds.tenant_id = p.tenant_id
                   AND NOT EXISTS (
                     SELECT 1 FROM ${pg("source_stat")} st
                     WHERE st.reference_table_id = ds.reference_table_id
                       AND st.database_id = ds.database_id
                       AND st.schema_name = ds.schema_name
                       AND st.table_name  = ds.table_name
                       AND st.column_name = ds.column_name
                       AND st.tenant_id = ds.tenant_id
                   )
               )
               OR NOT EXISTS (
                 SELECT 1 FROM ${pg("source_stat")} st2
                 WHERE st2.tenant_id = p.tenant_id
               )
               OR (
                 SELECT max(st3.scanned_at)
                   FROM ${pg("source_stat")} st3
                  WHERE st3.tenant_id = p.tenant_id
               ) < (
                 $1::timestamp - (
                   CASE p.scan_schedule
                     WHEN 'hourly' THEN INTERVAL '1 hour'
                     ELSE INTERVAL '1 day'
                   END
                 )
               )
             )
         ) AS due`,
        [now],
      );
      return row?.due ?? false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/relation.*zugzug_app.*does not exist/i.test(msg)) return false;
      throw e;
    }
  }

  let sched: string | null;
  let lastScan: Date | null;
  let unscannedCount: number;
  try {
    const row = await pgGet<{
      scan_schedule: string | null;
      last_scan: string | null;
      unscanned_count: number;
    }>(
      `SELECT p.scan_schedule,
              (SELECT max(st.scanned_at)::text
               FROM ${pg("source_stat")} st
               WHERE st.tenant_id = $1) AS last_scan,
              (SELECT count(*)::int FROM ${pg("reference_table_source")} ds
               WHERE ds.tenant_id = $1
                 AND NOT EXISTS (
                 SELECT 1 FROM ${pg("source_stat")} st2
                 WHERE st2.reference_table_id = ds.reference_table_id
                   AND st2.database_id = ds.database_id
                   AND st2.schema_name = ds.schema_name
                   AND st2.table_name  = ds.table_name
                   AND st2.column_name = ds.column_name
                   AND st2.tenant_id = ds.tenant_id
               )) AS unscanned_count
       FROM ${pg("preferences")} p WHERE p.tenant_id = $1`,
      [tenantId],
    );
    if (!row) return false;
    sched = row.scan_schedule;
    lastScan = row.last_scan ? new Date(row.last_scan) : null;
    unscannedCount = row.unscanned_count;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation.*zugzug_app.*does not exist/i.test(msg)) return false;
    throw e;
  }
  if (!sched) return false;
  if (unscannedCount > 0) return true; // unscanned registered source → due immediately
  if (!lastScan) return true; // never scanned → run immediately
  const dueMs = sched === "hourly" ? 60 * 60_000 : 24 * 60 * 60_000;
  return now.getTime() - lastScan.getTime() >= dueMs;
}

export interface ScanStatusResult {
  lastScanAt: string | null;
  sourceCount: number;
  unmappedCount: number;
  lastAutoPublishAt: string | null;
  lastAutoPublishDetail: string | null;
}

export async function scanStatus(tenantId: string = "default"): Promise<ScanStatusResult> {
  const isCrossTenant = tenantId === "*";
  const tenantFilterSources = isCrossTenant ? "" : "WHERE s.tenant_id = $1";
  const tenantFilterAudit = isCrossTenant ? "" : "AND tenant_id = $1";
  const params = isCrossTenant ? [] : [tenantId];

  const [row, lastAuto] = await Promise.all([
    pgGet<{ last_scan: string | null; sources: number; unmapped: number }>(
      `SELECT max(st.scanned_at)::text                   AS last_scan,
              count(s.*)::int                            AS sources,
              COALESCE(sum(st.unmapped), 0)::int         AS unmapped
       FROM ${pg("reference_table_source")} s
       LEFT JOIN ${pg("source_stat")} st
         ON  st.reference_table_id = s.reference_table_id
         AND st.database_id = s.database_id
         AND st.schema_name = s.schema_name
         AND st.table_name  = s.table_name
         AND st.column_name = s.column_name
         AND st.tenant_id = s.tenant_id
       ${tenantFilterSources}`,
      params,
    ).catch(() => null),
    pgGet<{ at: string; detail: string }>(
      `SELECT created_at::text AS at, detail
         FROM ${pg("audit_log")}
        WHERE user_id = 'u_system' AND action = 'Committed'
        ${tenantFilterAudit}
        ORDER BY created_at DESC
        LIMIT 1`,
      params,
    ).catch(() => null),
  ]);
  return {
    lastScanAt: row?.last_scan ?? null,
    sourceCount: Number(row?.sources ?? 0),
    unmappedCount: Number(row?.unmapped ?? 0),
    lastAutoPublishAt: lastAuto?.at ?? null,
    lastAutoPublishDetail: lastAuto?.detail ?? null,
  };
}

/** Browse/search the warehouse catalog (the 1000+ tables) — server-side search +
 *  schema facets + pagination, metadata only (no row counts). The scale surface. */
export async function searchCatalog(opts: {
  q?: string;
  schema?: string;
  limit?: number;
  offset?: number;
  tenantId: string;
}): Promise<{
  rows: CatalogTable[];
  total: number;
  schemas: { schema: string; tables: number }[];
}> {
  if (!env.attachWarehouse) return { rows: [], total: 0, schemas: [] };
  const adapter = await getAdapter();
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);

  const tables = await adapter.listTables({
    schema: opts.schema,
    search: opts.q,
  });
  const schemas = Object.values(
    tables.reduce<Record<string, { schema: string; tables: number }>>((acc, t) => {
      acc[t.schema] ??= { schema: t.schema, tables: 0 };
      acc[t.schema].tables += 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b.tables - a.tables || a.schema.localeCompare(b.schema))
    .slice(0, 100);

  const rows = tables.slice(offset, offset + limit).map((t) => ({
    schema: t.schema,
    table: `${t.schema}.${t.table}`,
    columns: [...t.columns],
  }));

  return { rows, total: tables.length, schemas };
}

/* ---- record bootstrap from warehouse ---- */

/** Seed a record_version row (version 1) for each derived key so the record
 *  can be renamed/retired/merged later. Without this, rename/merge/retire 404
 *  ("record not found") because bumpVersionOrThrow finds no version row.
 *  Idempotent — existing version rows are left untouched. */
async function seedVersionRows(
  refTableId: string,
  keys: string[],
  userId: string,
  tenantId: string,
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($1, $${j + 4}, 1, now(), $2, $3)`).join(", ");
    await pgRun(
      `INSERT INTO "zugzug_app"."record_version"
            (reference_table_id, key, version, updated_at, updated_by, tenant_id)
       VALUES ${placeholders}
       ON CONFLICT (tenant_id, reference_table_id, key) DO NOTHING`,
      [refTableId, userId, tenantId, ...chunk],
    );
  }
}

/** Bulk upsert (raw, key)-style rows into a Postgres table in chunks. */
async function bulkInsert(
  prefix: string,
  rows: [string, string][],
  conflict: string,
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(", ");
    await pgRun(`${prefix} VALUES ${placeholders} ${conflict}`, chunk.flat());
  }
}

/** Bulk insert single-column rows (e.g. external-ID keys) in chunks. */
async function bulkInsert1(prefix: string, values: string[], conflict: string): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($${j + 1})`).join(", ");
    await pgRun(`${prefix} VALUES ${placeholders} ${conflict}`, chunk);
  }
}

/** Derive (bootstrap) or connect a source column to a refTable.
 *
 *  Mode is auto-detected from the target refTable:
 *   - **seed** (refTable is empty): each distinct value populates the record table
 *     and is auto-mapped 1:1 in the map table. Slug refTables collapse US/us;
 *     external_id refTables also persist the name-column binding.
 *   - **connect** (refTable already has records): only register the source and refresh
 *     stats. Values land in Triage / Match Values, where exact-label hits get
 *     auto-staged and the rest are mapped by the operator. This is what you want
 *     for every source after the first — otherwise wiring source #2 would create
 *     duplicate record records, defeating the whole point of dedup.
 *
 *  Pass `opts.force: true` to seed even when the refTable already has records — only
 *  use when bootstrapping a refTable from multiple equally-trusted sources.
 *  Pass `opts.databaseId` to wire the column in the warehouse database the
 *  caller actually browsed; without it addSource keeps an existing
 *  registration for the same table, or falls back to the default database. */
export async function deriveRecord(
  refTableId: string,
  table: string,
  column: string,
  nameColumn: string | undefined,
  opts: { silent?: boolean; force?: boolean; databaseId?: string } = {},
  userId: string,
  tenantId: string,
): Promise<{ derived: number; mode: "seed" | "connect"; matched: number; unmatched: number }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  if (!meta) return { derived: 0, mode: "seed", matched: 0, unmatched: 0 };
  const databaseId = await addSource(refTableId, table, column, tenantId, {
    databaseId: opts.databaseId,
  });
  const external = meta.keyKind === "external_id";
  if (external && nameColumn)
    await addSource(refTableId, table, nameColumn, tenantId, { databaseId });

  const seeded = await pgGet<{ n: number }>(`SELECT 1 AS n FROM ${cq(meta.dimTable)} LIMIT 1`);
  const mode: "seed" | "connect" = seeded && !opts.force ? "connect" : "seed";

  if (mode === "connect") {
    if (external && nameColumn) {
      // Persist the name binding even in connect mode — the new source may be the
      // first one carrying names. Won't clobber if already set.
      await pgRun(
        `UPDATE ${pg("reference_table")} SET name_table = COALESCE(name_table, $1),
                                       name_id_col = COALESCE(name_id_col, $2),
                                       name_col = COALESCE(name_col, $3)
         WHERE id = $4 AND tenant_id = $5`,
        [table, column, nameColumn, refTableId, tenantId],
      );
    }
    const cols = external && nameColumn ? [column, nameColumn] : [column];
    await scanWiredSources(refTableId, table, cols, tenantId, databaseId);
    // Inline the auto-stage so the caller gets real outcome counts immediately,
    // instead of waiting for the scheduler tick. The source is already
    // registered above; if auto-stage fails (warehouse blip, draft conflict),
    // the connect itself still succeeded — surface zero counts rather than
    // 5xx'ing the whole request. The scheduler will retry on the next tick.
    let matched = 0;
    let unmatched = 0;
    try {
      ({ matched, unmatched } = await autoStageExactMatches(refTableId, tenantId));
    } catch (err) {
      log({
        level: "warn",
        msg: "derive-record: inline auto-stage failed",
        refTableId,
        table,
        column,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (!opts.silent) {
      const summary =
        matched === 0 && unmatched === 0
          ? `${table}.${column} → ${meta.dimTable} — no new values`
          : `${table}.${column} → ${meta.dimTable} — ${matched} matched, ${unmatched} to review`;
      await appendAuditAs(userId, "Connected source", summary, { tenantId });
    }
    return { derived: 0, mode, matched, unmatched };
  }

  // Resolve the warehouse catalog from the database the source was just
  // registered against — not from whichever registration happens to sort first.
  const catalog = await catalogNameOf(databaseId);
  if (!catalog) {
    throw new AppError(
      "VALIDATION_FAILED",
      `could not resolve warehouse database for ${table}`,
      422,
    );
  }
  const [refSchema, refTable] = table.split(".") as [string, string];
  const ref: Ref = { catalog, schema: refSchema, table: refTable };

  const adapter = await getAdapter();
  // Let warehouse errors propagate — callers (TableDetail wiring,
  // Sources.deriveAction) need to see why a column "has no rows" rather than
  // getting a misleading 0. A genuinely empty column still returns [].
  const vals = await adapter.distinctValues(ref, column, 5000);
  if (!vals.length) {
    log({
      level: "warn",
      msg: "derive-record: distinctValues returned 0",
      refTableId,
      table,
      column,
      hint: "column may be all NULL/empty, or warehouse not attached",
    });
    await scanWiredSources(
      refTableId,
      table,
      [column, ...(external && nameColumn ? [nameColumn] : [])],
      tenantId,
      databaseId,
    );
    return { derived: 0, mode, matched: 0, unmatched: 0 };
  }

  const key = qid(meta.keyCol);

  if (external) {
    const ids = [...new Set(vals)];
    await bulkInsert1(
      `INSERT INTO ${cq(meta.dimTable)} (${key})`,
      ids,
      `ON CONFLICT (${key}) DO NOTHING`,
    );
    await bulkInsert(
      `INSERT INTO ${cq(meta.mapTable)} (raw, ${key})`,
      ids.map((v) => [v, v] as [string, string]),
      `ON CONFLICT (raw) DO NOTHING`,
    );
    await seedVersionRows(refTableId, ids, userId, tenantId);
    if (nameColumn) {
      await pgRun(
        `UPDATE ${pg("reference_table")} SET name_table = $1, name_id_col = $2, name_col = $3
         WHERE id = $4 AND tenant_id = $5`,
        [table, column, nameColumn, refTableId, tenantId],
      );
    }
    if (!opts.silent)
      await appendAuditAs(
        userId,
        "Derived record",
        `${ids.length} external-ID key${ids.length === 1 ? "" : "s"} from ${table}.${column} (names ← ${table}.${nameColumn ?? "?"})`,
        { tenantId },
      );
    await scanWiredSources(
      refTableId,
      table,
      [column, ...(nameColumn ? [nameColumn] : [])],
      tenantId,
      databaseId,
    );
    return { derived: ids.length, mode, matched: 0, unmatched: 0 };
  }

  // Cluster look-alikes exactly the way the review path does (normalizeKey folds
  // case, punctuation and diacritics), so "U.S.A." and "usa" seed as one record
  // instead of two. The stored key stays a readable slug of the cluster's rep;
  // distinct normalized keys yield distinct slugs, so records never collide.
  const refTableByKey = new Map<string, string>(); // key → label (cluster rep)
  const mapPairs: [string, string][] = []; // raw → key
  for (const c of clusterForSeed(vals)) {
    const k = slug(c.rep) || c.rep.toLowerCase().slice(0, 60) || "_";
    refTableByKey.set(k, c.rep);
    for (const raw of c.raws) mapPairs.push([raw, k]);
  }
  await bulkInsert(
    `INSERT INTO ${cq(meta.dimTable)} (${key}, label)`,
    [...refTableByKey.entries()],
    `ON CONFLICT (${key}) DO NOTHING`,
  );
  await bulkInsert(
    `INSERT INTO ${cq(meta.mapTable)} (raw, ${key})`,
    mapPairs,
    `ON CONFLICT (raw) DO NOTHING`,
  );
  await seedVersionRows(refTableId, [...refTableByKey.keys()], userId, tenantId);
  if (!opts.silent)
    await appendAuditAs(
      userId,
      "Derived record",
      `${refTableByKey.size} value${refTableByKey.size === 1 ? "" : "s"} from ${table}.${column} → ${meta.dimTable}`,
      { tenantId },
    );
  await scanWiredSources(refTableId, table, [column], tenantId, databaseId);
  return { derived: refTableByKey.size, mode, matched: 0, unmatched: 0 };
}

/** Populate source_stat for the just-wired columns so the Sources ledger
 *  shows real rows/distinct/unmapped immediately, instead of requiring the
 *  operator to click "Scan all". Errors are logged but never thrown — the
 *  derive itself already succeeded. */
async function scanWiredSources(
  refTableId: string,
  table: string,
  columns: string[],
  tenantId: string,
  databaseId: string,
): Promise<void> {
  if (!columns.length) return;
  const parts = table.split(".");
  if (parts.length !== 2) return;
  const regs = await pgAll<ScanReg>(
    `SELECT s.reference_table_id         AS "refTableId",
            s.database_id    AS "databaseId",
            wd.database_name AS "catalog",
            s.schema_name    AS "schema",
            s.table_name     AS "table",
            s.column_name    AS "column",
            d.map_table      AS "mapTable"
       FROM ${pg("reference_table_source")} s
       JOIN ${pg("reference_table")}          d  ON d.id  = s.reference_table_id      AND d.tenant_id  = s.tenant_id
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
      WHERE s.tenant_id   = $1
        AND s.reference_table_id      = $2
        AND s.schema_name = $3
        AND s.table_name  = $4
        AND s.column_name = ANY($5::text[])
        AND s.database_id = $6`,
    [tenantId, refTableId, parts[0], parts[1], columns, databaseId],
  );
  if (!regs.length) return;
  try {
    const adapter = await getAdapter();
    for (const r of regs) await scanOneSource(r, adapter, tenantId);
    await materializeOneDim(refTableId, adapter, tenantId).catch((e) => {
      log({
        level: "error",
        msg: "materialize-refTable-on-derive",
        refTableId,
        err: e instanceof Error ? e.message : String(e),
      });
    });
  } catch (e) {
    log({
      level: "warn",
      msg: "auto-scan-after-derive failed",
      refTableId,
      table,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
