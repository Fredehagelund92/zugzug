/* repo-scan.ts — warehouse scanning (DuckDB-backed) + the sources registry.
 *
 * Manages the dimension_source / source_stat tables in Postgres and drives
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
import { appendAuditAs } from "./repo-meta.ts";
import { saveDraft } from "./repo-drafts.ts";
import { materializeDimScanValues } from "./repo-dim-scan.ts";
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
  else if (opts.status === "missing") where.push(`st.scanned_at IS NOT NULL AND NOT st.present`);

  const rows = await pgAll<{
    dimId: string;
    dimension: string;
    table: string;
    column: string;
    present: boolean;
    rows: number;
    values: number;
    unmapped: number;
    scanned: boolean;
    scannedAt: string | null;
  }>(
    `SELECT s.dim_id AS "dimId", d.label AS dimension,
            (s.schema_name || '.' || s.table_name) AS "table",
            s.column_name AS column,
            COALESCE(st.present, false) AS present,
            COALESCE(st.rows, 0)::int AS rows,
            COALESCE(st.distinct_values, 0)::int AS values,
            COALESCE(st.unmapped, 0)::int AS unmapped,
            (st.scanned_at IS NOT NULL) AS scanned,
            st.scanned_at::text AS "scannedAt"
     FROM ${pg("dimension_source")} s
     JOIN ${pg("dimension")} d ON d.id = s.dim_id AND d.tenant_id = s.tenant_id
     LEFT JOIN ${pg("source_stat")} st
       ON st.dim_id = s.dim_id
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
    table: r.table,
    column: r.column,
    dimension: r.dimension,
    dimId: r.dimId,
    present: !!r.present,
    rows: Number(r.rows),
    values: Number(r.values),
    unmapped: Number(r.unmapped),
    scanned: !!r.scanned,
    scannedAt: r.scannedAt ?? null,
  }));
}

/** Per-schema rollup for the facet rail — turns N source columns into ~systems. */
export async function sourceFacets(tenantId: string): Promise<SchemaFacet[]> {
  const rows = await pgAll<{ schema: string; columns: number; unmapped: number; missing: number }>(
    `SELECT s.schema_name AS schema,
            count(*)::int AS columns,
            COALESCE(sum(st.unmapped), 0)::int AS unmapped,
            count(*) FILTER (WHERE st.scanned_at IS NOT NULL AND NOT st.present)::int AS missing
     FROM ${pg("dimension_source")} s
     LEFT JOIN ${pg("source_stat")} st
       ON st.dim_id      = s.dim_id
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
    dimId: string;
    databaseId: string;
    catalog: string;
    schema: string;
    table: string;
    column: string;
    mapTable: string;
  }>(
    `SELECT s.dim_id        AS "dimId",
            s.database_id   AS "databaseId",
            wd.database_name AS "catalog",
            s.schema_name   AS "schema",
            s.table_name    AS "table",
            s.column_name   AS "column",
            d.map_table     AS "mapTable"
       FROM ${pg("dimension_source")} s
       JOIN ${pg("dimension")}          d  ON d.id  = s.dim_id      AND d.tenant_id  = s.tenant_id
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
      WHERE s.tenant_id = $1`,
    [tenantId],
  );
  const adapter = await getAdapter();
  for (const r of regs) {
    await scanOneSource(r, adapter, tenantId);
  }

  const dimIds = [...new Set(regs.map((r) => r.dimId))];
  for (const dimId of dimIds) {
    await materializeOneDim(dimId, adapter, tenantId).catch((e) => {
      log({
        level: "error",
        msg: "materialize-dim",
        dimId,
        err: e instanceof Error ? e.message : String(e),
      });
    });
  }

  return regs.length;
}

/** Rescan a single dim — rescans its registered sources, then re-materializes
 *  its dim_scan_value/dim_scan_occurrence rows. Faster than scanSources when
 *  the user only wants to refresh one table. */
export async function scanOneDim(dimId: string, tenantId: string): Promise<void> {
  const regs = await pgAll<ScanReg>(
    `SELECT s.dim_id        AS "dimId",
            s.database_id   AS "databaseId",
            wd.database_name AS "catalog",
            s.schema_name   AS "schema",
            s.table_name    AS "table",
            s.column_name   AS "column",
            d.map_table     AS "mapTable"
       FROM ${pg("dimension_source")} s
       JOIN ${pg("dimension")}          d  ON d.id  = s.dim_id      AND d.tenant_id  = s.tenant_id
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
      WHERE s.tenant_id = $1 AND s.dim_id = $2`,
    [tenantId, dimId],
  );
  const adapter = await getAdapter();
  for (const r of regs) {
    await scanOneSource(r, adapter, tenantId);
  }
  await materializeOneDim(dimId, adapter, tenantId);
}

/** Run the warehouse provenance query for one dim and write the result into
 *  dim_scan_value + dim_scan_occurrence. Idempotent — replaces prior rows. */
async function materializeOneDim(
  dimId: string,
  adapter: Awaited<ReturnType<typeof getAdapter>>,
  tenantId: string,
): Promise<void> {
  const t0 = performance.now();
  const sources = await liveSources(dimId, tenantId);
  if (!sources.length) {
    await materializeDimScanValues(dimId, tenantId, {
      occurrences: [],
      scannedAt: new Date(),
    });
    log({
      level: "info",
      msg: "materialize-dim",
      dimId,
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
  await materializeDimScanValues(dimId, tenantId, { occurrences, scannedAt: new Date() });
  log({
    level: "info",
    msg: "materialize-dim",
    dimId,
    distinct: new Set(occurrences.map((o) => o.raw.toLowerCase())).size,
    occurrences: occurrences.length,
    ms: Math.round(performance.now() - t0),
  });
}

type ScanReg = {
  dimId: string;
  databaseId: string;
  catalog: string;
  schema: string;
  table: string;
  column: string;
  mapTable: string;
};

/** Scan a single registered source and upsert its row in source_stat. Shared
 *  by scanSources (bulk) and the auto-scan path in deriveCanonical (per-wire). */
async function scanOneSource(
  r: ScanReg,
  adapter: Awaited<ReturnType<typeof getAdapter>>,
  tenantId: string,
): Promise<void> {
  const SCAN_TIMEOUT_MS = 30_000;
  const ref: Ref = { catalog: r.catalog, schema: r.schema, table: r.table };
  const displayTable = `${r.schema}.${r.table}`;
  let present: boolean;
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
  }
  await pgRun(
    `INSERT INTO ${pg("source_stat")}
       (tenant_id, dim_id, database_id, schema_name, table_name, column_name,
        present, rows, distinct_values, unmapped, scanned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, current_timestamp)
     ON CONFLICT (tenant_id, dim_id, database_id, schema_name, table_name, column_name) DO UPDATE SET
       present         = EXCLUDED.present,
       rows            = EXCLUDED.rows,
       distinct_values = EXCLUDED.distinct_values,
       unmapped        = EXCLUDED.unmapped,
       scanned_at      = EXCLUDED.scanned_at`,
    [
      tenantId,
      r.dimId,
      r.databaseId,
      r.schema,
      r.table,
      r.column,
      present,
      rows,
      distinct,
      unmapped,
    ],
  );
}

/** List dimension IDs that have at least one wired source. Used by the
 *  auto-stage scheduler job to know which dimensions to process per tick. */
export async function dimensionsWithWiredSources(tenantId: string): Promise<string[]> {
  const rows = await pgAll<{ dimId: string }>(
    `SELECT DISTINCT dim_id AS "dimId" FROM ${pg("dimension_source")} WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows.map((r) => r.dimId);
}

/** Auto-stage a draft (owned by u_system) for every warehouse raw value that
 *  case-insensitively matches an existing canonical label and is not yet in
 *  the dimension's lookup table. The match is deterministic — no AI, no fuzzy
 *  — so it always lands above any reasonable publish threshold. */
export async function autoStageExactMatches(
  dimId: string,
  tenantId: string,
): Promise<{ matched: number; unmatched: number }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) return { matched: 0, unmatched: 0 };
  if (meta.keyKind === "external_id") return { matched: 0, unmatched: 0 };

  const sources = await liveSources(dimId, tenantId);
  if (!sources.length) return { matched: 0, unmatched: 0 };

  // Materialized: distinct raw values from dim_scan_value
  const rows = await pgAll<{ raw: string }>(
    `SELECT raw FROM zugzug_app.dim_scan_value
       WHERE tenant_id = $1 AND dim_id = $2`,
    [tenantId, dimId],
  );
  if (!rows.length) return { matched: 0, unmatched: 0 };
  const warehouseRaws = rows.map((r) => r.raw);

  // Postgres: canonical labels
  const canonRows = await pgAll<{ key: string; label: string }>(
    `SELECT ${qid(meta.keyCol)} AS key, label FROM ${cq(meta.dimTable)} WHERE label IS NOT NULL`,
  ).catch(() => [] as { key: string; label: string }[]);
  const labelToCanon = new Map<string, { key: string; label: string }>();
  for (const r of canonRows) labelToCanon.set(r.label.toLowerCase(), r);

  // Postgres: already-mapped raws
  const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(meta.mapTable)}`).catch(
    () => [] as { raw: string }[],
  );
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  // JS: find exact case-insensitive matches not yet mapped
  const matches: { raw: string; key: string; label: string }[] = [];
  let unmatched = 0;
  for (const raw of warehouseRaws) {
    const lower = raw.toLowerCase();
    if (mappedSet.has(lower)) continue;
    const canon = labelToCanon.get(lower);
    if (canon) matches.push({ raw, key: canon.key, label: canon.label });
    else unmatched++;
  }

  if (!matches.length) return { matched: 0, unmatched };
  for (const m of matches) {
    await saveDraft(dimId, m.raw, "mapped", m.label, m.key, "u_system", tenantId);
  }
  await appendAuditAs(
    "u_system",
    "Auto-matched",
    `${matches.length} value${matches.length === 1 ? "" : "s"} staged in ${dimId} (exact label match)`,
    { tenantId },
  );
  return { matched: matches.length, unmatched };
}

/** Register a warehouse column as a source for a dimension (idempotent).
 *
 *  Takes the convenience `"schema.table"` + column shape (used by seed and
 *  deriveCanonical). Resolves the warehouse database via
 *  resolveDefaultDatabase() — the first registered warehouse_database for
 *  the deployment. Callers that already hold a databaseId should write the
 *  INSERT directly with that ID. */
export async function addSource(
  dimId: string,
  table: string,
  column: string,
  tenantId: string,
  opts: { silent?: boolean } = {},
): Promise<void> {
  void opts;
  const parts = table.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError("VALIDATION_FAILED", `expected "schema.table", got: ${table}`, 422);
  }
  const { resolveDefaultDatabase } = await import("./repo-canonical.ts");
  const databaseId = await resolveDefaultDatabase(tenantId);
  await pgRun(
    `INSERT INTO ${pg("dimension_source")} (dim_id, tenant_id, database_id, schema_name, table_name, column_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, dim_id, database_id, schema_name, table_name, column_name) DO NOTHING`,
    [dimId, tenantId, databaseId, parts[0], parts[1], column],
  );
}

/** Top-N unmapped raw values from a specific warehouse source column, with the
 *  row count of each. Powers the per-row "what's actually broken here" reveal
 *  on the Sources page — drill into a column without leaving the list. */
export async function topUnmapped(
  dimId: string,
  table: string,
  column: string,
  limit = 5,
  tenantId: string,
): Promise<UnmappedSample[]> {
  const meta = await pgGet<{ mapTable: string }>(
    `SELECT map_table AS "mapTable" FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) return [];
  if (!env.attachWarehouse) return [];
  const ref = await refForRegisteredTable(dimId, table, tenantId);
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
                 SELECT 1 FROM ${pg("dimension_source")} ds
                 WHERE ds.tenant_id = p.tenant_id
                   AND NOT EXISTS (
                     SELECT 1 FROM ${pg("source_stat")} st
                     WHERE st.dim_id = ds.dim_id
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
              (SELECT count(*)::int FROM ${pg("dimension_source")} ds
               WHERE ds.tenant_id = $1
                 AND NOT EXISTS (
                 SELECT 1 FROM ${pg("source_stat")} st2
                 WHERE st2.dim_id = ds.dim_id
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
       FROM ${pg("dimension_source")} s
       LEFT JOIN ${pg("source_stat")} st
         ON  st.dim_id = s.dim_id
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

/* ---- canonical bootstrap from warehouse ---- */

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

/** Derive (bootstrap) or connect a source column to a dimension.
 *
 *  Mode is auto-detected from the target dim:
 *   - **seed** (dim is empty): each distinct value populates the canonical table
 *     and is auto-mapped 1:1 in the map table. Slug dims collapse US/us;
 *     external_id dims also persist the name-column binding.
 *   - **connect** (dim already has records): only register the source and refresh
 *     stats. Values land in Triage / Match Values, where exact-label hits get
 *     auto-staged and the rest are mapped by the operator. This is what you want
 *     for every source after the first — otherwise wiring source #2 would create
 *     duplicate canonical records, defeating the whole point of dedup.
 *
 *  Pass `opts.force: true` to seed even when the dim already has records — only
 *  use when bootstrapping a dim from multiple equally-trusted sources. */
export async function deriveCanonical(
  dimId: string,
  table: string,
  column: string,
  nameColumn: string | undefined,
  opts: { silent?: boolean; force?: boolean } = {},
  userId: string,
  tenantId: string,
): Promise<{ derived: number; mode: "seed" | "connect"; matched: number; unmatched: number }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) return { derived: 0, mode: "seed", matched: 0, unmatched: 0 };
  await addSource(dimId, table, column, tenantId);
  const external = meta.keyKind === "external_id";
  if (external && nameColumn) await addSource(dimId, table, nameColumn, tenantId);

  const seeded = await pgGet<{ n: number }>(`SELECT 1 AS n FROM ${cq(meta.dimTable)} LIMIT 1`);
  const mode: "seed" | "connect" = seeded && !opts.force ? "connect" : "seed";

  if (mode === "connect") {
    if (external && nameColumn) {
      // Persist the name binding even in connect mode — the new source may be the
      // first one carrying names. Won't clobber if already set.
      await pgRun(
        `UPDATE ${pg("dimension")} SET name_table = COALESCE(name_table, $1),
                                       name_id_col = COALESCE(name_id_col, $2),
                                       name_col = COALESCE(name_col, $3)
         WHERE id = $4 AND tenant_id = $5`,
        [table, column, nameColumn, dimId, tenantId],
      );
    }
    const cols = external && nameColumn ? [column, nameColumn] : [column];
    await scanWiredSources(dimId, table, cols, tenantId);
    // Inline the auto-stage so the caller gets real outcome counts immediately,
    // instead of waiting for the scheduler tick. The source is already
    // registered above; if auto-stage fails (warehouse blip, draft conflict),
    // the connect itself still succeeded — surface zero counts rather than
    // 5xx'ing the whole request. The scheduler will retry on the next tick.
    let matched = 0;
    let unmatched = 0;
    try {
      ({ matched, unmatched } = await autoStageExactMatches(dimId, tenantId));
    } catch (err) {
      log({
        level: "warn",
        msg: "derive-canonical: inline auto-stage failed",
        dimId,
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

  // Resolve the warehouse catalog from the just-registered source. Throws if
  // the source isn't registered (shouldn't happen post-addSource).
  const ref = await refForRegisteredTable(dimId, table, tenantId);
  if (!ref) {
    throw new AppError(
      "VALIDATION_FAILED",
      `could not resolve warehouse database for ${table}`,
      422,
    );
  }

  const adapter = await getAdapter();
  // Let warehouse errors propagate — callers (CatalogExplorer.wire,
  // Sources.deriveAction) need to see why a column "has no rows" rather than
  // getting a misleading 0. A genuinely empty column still returns [].
  const vals = await adapter.distinctValues(ref, column, 5000);
  if (!vals.length) {
    log({
      level: "warn",
      msg: "derive-canonical: distinctValues returned 0",
      dimId,
      table,
      column,
      hint: "column may be all NULL/empty, or warehouse not attached",
    });
    await scanWiredSources(dimId, table, [column, ...(external && nameColumn ? [nameColumn] : [])], tenantId);
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
    if (nameColumn) {
      await pgRun(
        `UPDATE ${pg("dimension")} SET name_table = $1, name_id_col = $2, name_col = $3
         WHERE id = $4 AND tenant_id = $5`,
        [table, column, nameColumn, dimId, tenantId],
      );
    }
    if (!opts.silent)
      await appendAuditAs(
        userId,
        "Derived canonical",
        `${ids.length} external-ID key${ids.length === 1 ? "" : "s"} from ${table}.${column} (names ← ${table}.${nameColumn ?? "?"})`,
        { tenantId },
      );
    await scanWiredSources(dimId, table, [column, ...(nameColumn ? [nameColumn] : [])], tenantId);
    return { derived: ids.length, mode, matched: 0, unmatched: 0 };
  }

  const dimByKey = new Map<string, string>(); // key → label (first wins)
  const mapPairs: [string, string][] = []; // raw → key
  for (const v of vals) {
    const k = slug(v) || v.toLowerCase().slice(0, 60) || "_";
    if (!dimByKey.has(k)) dimByKey.set(k, v);
    mapPairs.push([v, k]);
  }
  await bulkInsert(
    `INSERT INTO ${cq(meta.dimTable)} (${key}, label)`,
    [...dimByKey.entries()],
    `ON CONFLICT (${key}) DO NOTHING`,
  );
  await bulkInsert(
    `INSERT INTO ${cq(meta.mapTable)} (raw, ${key})`,
    mapPairs,
    `ON CONFLICT (raw) DO NOTHING`,
  );
  if (!opts.silent)
    await appendAuditAs(
      userId,
      "Derived canonical",
      `${dimByKey.size} value${dimByKey.size === 1 ? "" : "s"} from ${table}.${column} → ${meta.dimTable}`,
      { tenantId },
    );
  await scanWiredSources(dimId, table, [column], tenantId);
  return { derived: dimByKey.size, mode, matched: 0, unmatched: 0 };
}

/** Populate source_stat for the just-wired columns so the Sources ledger
 *  shows real rows/distinct/unmapped immediately, instead of requiring the
 *  operator to click "Scan all". Errors are logged but never thrown — the
 *  derive itself already succeeded. */
async function scanWiredSources(
  dimId: string,
  table: string,
  columns: string[],
  tenantId: string,
): Promise<void> {
  if (!columns.length) return;
  const parts = table.split(".");
  if (parts.length !== 2) return;
  const regs = await pgAll<ScanReg>(
    `SELECT s.dim_id         AS "dimId",
            s.database_id    AS "databaseId",
            wd.database_name AS "catalog",
            s.schema_name    AS "schema",
            s.table_name     AS "table",
            s.column_name    AS "column",
            d.map_table      AS "mapTable"
       FROM ${pg("dimension_source")} s
       JOIN ${pg("dimension")}          d  ON d.id  = s.dim_id      AND d.tenant_id  = s.tenant_id
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
      WHERE s.tenant_id   = $1
        AND s.dim_id      = $2
        AND s.schema_name = $3
        AND s.table_name  = $4
        AND s.column_name = ANY($5::text[])`,
    [tenantId, dimId, parts[0], parts[1], columns],
  );
  if (!regs.length) return;
  try {
    const adapter = await getAdapter();
    for (const r of regs) await scanOneSource(r, adapter, tenantId);
    await materializeOneDim(dimId, adapter, tenantId).catch((e) => {
      log({
        level: "error",
        msg: "materialize-dim-on-derive",
        dimId,
        err: e instanceof Error ? e.message : String(e),
      });
    });
  } catch (e) {
    log({
      level: "warn",
      msg: "auto-scan-after-derive failed",
      dimId,
      table,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
