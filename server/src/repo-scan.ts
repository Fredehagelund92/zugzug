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
  parseSourceTable,
} from "./repo-shared.ts";
import type { Ref } from "./warehouse/adapter.ts";
import { getAdapter } from "./warehouse/registry.ts";
import { appendAuditAs } from "./repo-meta.ts";
import { saveDraft } from "./repo-drafts.ts";

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
    where.push(`(s.source_table ILIKE ${p} OR s.source_column ILIKE ${p})`);
  }
  if (opts.schema) {
    params.push(opts.schema);
    where.push(`split_part(s.source_table, '.', 1) = $${params.length}`);
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
    `SELECT s.dim_id AS "dimId", d.label AS dimension, s.source_table AS "table", s.source_column AS column,
            COALESCE(st.present, false) AS present,
            COALESCE(st.rows, 0)::int AS rows,
            COALESCE(st.distinct_values, 0)::int AS values,
            COALESCE(st.unmapped, 0)::int AS unmapped,
            (st.scanned_at IS NOT NULL) AS scanned,
            st.scanned_at::text AS "scannedAt"
     FROM ${pg("dimension_source")} s
     JOIN ${pg("dimension")} d ON d.id = s.dim_id AND d.tenant_id = s.tenant_id
     LEFT JOIN ${pg("source_stat")} st
       ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column
       AND st.tenant_id = s.tenant_id
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(st.unmapped, 0) DESC, s.source_table, s.source_column
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
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id AND wd.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1`,
    [tenantId],
  );
  const SCAN_TIMEOUT_MS = 30_000;
  const adapter = await getAdapter();
  for (const r of regs) {
    const ref: Ref = { catalog: r.catalog, schema: r.schema, table: r.table };
    const displayTable = `${r.schema}.${r.table}`;
    let present: boolean,
      rows = 0,
      distinct = 0,
      unmapped = 0;
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

  return regs.length;
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
export async function autoStageExactMatches(dimId: string, tenantId: string): Promise<number> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) return 0;
  if (meta.keyKind === "external_id") return 0;

  const sources = await liveSources(dimId, tenantId);
  if (!sources.length) return 0;

  // Warehouse: distinct raw values
  const adapter = await getAdapter();
  const refs = sources.map((s) => ({ table: parseSourceTable(s.table), column: s.column }));
  const occRows = await adapter
    .distinctValuesWithProvenance(refs)
    .catch(() => [] as { value: string }[]);
  if (!occRows.length) return 0;
  const warehouseRaws = [...new Set(occRows.map((r) => r.value))];

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
  for (const raw of warehouseRaws) {
    const lower = raw.toLowerCase();
    if (mappedSet.has(lower)) continue;
    const canon = labelToCanon.get(lower);
    if (canon) matches.push({ raw, key: canon.key, label: canon.label });
  }

  if (!matches.length) return 0;
  for (const m of matches) {
    await saveDraft(dimId, m.raw, "mapped", m.label, m.key, "u_system", tenantId);
  }
  await appendAuditAs(
    "u_system",
    "Auto-matched",
    `${matches.length} value${matches.length === 1 ? "" : "s"} staged in ${dimId} (exact label match)`,
    { tenantId },
  );
  return matches.length;
}

/** Register a warehouse column as a source for a dimension (idempotent).
 *
 *  Takes the legacy `"schema.table"` + column shape and routes through
 *  normalizeSource() so the row lands in the new
 *  (database_id, schema, table, column) columns. Callers that already have
 *  a database_id should write the INSERT directly. */
export async function addSource(
  dimId: string,
  table: string,
  column: string,
  tenantId: string,
  opts: { silent?: boolean } = {},
): Promise<void> {
  void opts;
  const { normalizeSource } = await import("./repo-canonical.ts");
  const normalized = await normalizeSource(tenantId, { table, column });
  if ("error" in normalized) {
    throw new Error(`${normalized.kind}: ${normalized.error}`);
  }
  await pgRun(
    `INSERT INTO ${pg("dimension_source")} (dim_id, tenant_id, database_id, schema_name, table_name, column_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, dim_id, database_id, schema_name, table_name, column_name) DO NOTHING`,
    [
      dimId,
      tenantId,
      normalized.databaseId,
      normalized.schemaName,
      normalized.tableName,
      normalized.columnName,
    ],
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
  const adapter = await getAdapter();
  const ref = parseSourceTable(table);
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
                       AND st.source_table = ds.source_table
                       AND st.source_column = ds.source_column
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
                     WHEN '15m'    THEN INTERVAL '15 minutes'
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
                   AND st2.source_table = ds.source_table
                   AND st2.source_column = ds.source_column
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
  const dueMs = sched === "15m" ? 15 * 60_000 : sched === "hourly" ? 60 * 60_000 : 24 * 60 * 60_000;
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
         AND st.source_table  = s.source_table
         AND st.source_column = s.source_column
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

/** Derive (bootstrap) a dimension's canonical set from a source column's distinct
 *  values. For a 'slug' dimension each distinct value seeds a slug-keyed canonical
 *  (US/us collapse) mapped 1:1. For an 'external_id' dimension the source column IS
 *  the ID column: each distinct ID seeds a canonical keyed by the raw ID (no slug),
 *  self-mapped id→id, and the name binding (table, id_col, name_col) is persisted so
 *  the name resolves live on read. Returns how many canonical records resulted. */
export async function deriveCanonical(
  dimId: string,
  table: string,
  column: string,
  nameColumn: string | undefined,
  opts: { silent?: boolean } = {},
  userId: string,
  tenantId: string,
): Promise<{ derived: number }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) return { derived: 0 };
  await addSource(dimId, table, column, tenantId);
  const external = meta.keyKind === "external_id";
  if (external && nameColumn) await addSource(dimId, table, nameColumn, tenantId);

  const adapter = await getAdapter();
  const vals = await adapter
    .distinctValues(parseSourceTable(table), column, 5000)
    .catch(() => [] as string[]);
  if (!vals.length) return { derived: 0 };

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
    return { derived: ids.length };
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
  return { derived: dimByKey.size };
}
