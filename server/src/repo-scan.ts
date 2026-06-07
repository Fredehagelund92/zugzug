/* repo-scan.ts — warehouse scanning (DuckDB-backed) + the sources registry.
 *
 * Manages the dimension_source / source_stat tables in Postgres and drives
 * the DuckDB queries that count distinct values in MotherDuck. */

import type { DuckDBValue } from "@duckdb/node-api";
import {
  type SourceInfo,
  type SchemaFacet,
  type CatalogTable,
  slug,
  qid,
  cq,
  whTable,
  liveSources,
  occUnion,
  all,
  get,
  pgAll,
  pgGet,
  pgRun,
  env,
  pg,
  log,
} from "./repo-shared.ts";
import { appendAuditAs, getPreferences } from "./repo-meta.ts";
import { saveDraft, commit } from "./repo-drafts.ts";

export interface UnmappedSample {
  raw: string;
  rows: number;
}

/** Registered source columns, read from the cached stats (POST /api/sources/scan
 *  refreshes them) so this is instant regardless of source count. Supports search
 *  (q), schema filter, and a status filter; ranked by unmapped (rows at risk). */
export async function listSources(
  opts: { q?: string; schema?: string; status?: string } = {},
): Promise<SourceInfo[]> {
  const params: unknown[] = [];
  const where: string[] = [];
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
     JOIN ${pg("dimension")} d ON d.id = s.dim_id
     LEFT JOIN ${pg("source_stat")} st
       ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
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
export async function sourceFacets(): Promise<SchemaFacet[]> {
  const rows = await pgAll<{ schema: string; columns: number; unmapped: number; missing: number }>(
    `SELECT split_part(s.source_table, '.', 1) AS schema,
            count(*)::int AS columns,
            COALESCE(sum(st.unmapped), 0)::int AS unmapped,
            count(*) FILTER (WHERE st.scanned_at IS NOT NULL AND NOT st.present)::int AS missing
     FROM ${pg("dimension_source")} s
     LEFT JOIN ${pg("source_stat")} st
       ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column
     GROUP BY 1 ORDER BY unmapped DESC, schema`,
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
export async function scanSources(): Promise<number> {
  const regs = await pgAll<{ dimId: string; table: string; column: string; mapTable: string }>(
    `SELECT s.dim_id AS "dimId", s.source_table AS "table", s.source_column AS column, d.map_table AS "mapTable"
     FROM ${pg("dimension_source")} s JOIN ${pg("dimension")} d ON d.id = s.dim_id`,
  );
  const SCAN_TIMEOUT_MS = 30_000;
  for (const r of regs) {
    const col = qid(r.column);
    let present: boolean,
      rows = 0,
      distinct = 0,
      unmapped = 0;
    const t0 = performance.now();
    try {
      const { agg } = await Promise.race([
        (async () => {
          const agg = await get<{ rows: bigint; d: bigint }>(
            `SELECT count(${col}) AS rows, count(DISTINCT ${col}) AS d FROM ${whTable(r.table)}
             WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0`,
          );
          return { agg };
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("scan timeout")), SCAN_TIMEOUT_MS),
        ),
      ]);
      present = true;
      rows = Number(agg?.rows ?? 0);
      distinct = Number(agg?.d ?? 0);
      if (distinct > 0) {
        // Cross-store unmapped count: was a single LEFT JOIN that hit warehouse
        // (DuckDB) + canonical map_* (Postgres). DuckDB can no longer reach
        // Postgres, so fetch each side independently and subtract in JS.
        try {
          const whRaws = await all<{ raw: string }>(
            `SELECT DISTINCT CAST(${col} AS VARCHAR) AS raw FROM ${whTable(r.table)}
             WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0`,
          );
          const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(r.mapTable)}`);
          const mappedSet = new Set(mappedRows.map((m) => m.raw.toLowerCase()));
          unmapped = whRaws.filter((w) => !mappedSet.has(w.raw.toLowerCase())).length;
        } catch {
          // Either side missing — leave unmapped at 0 instead of poisoning the
          // present / rows / distinct stats already captured above.
        }
      }
      const ms = Math.round(performance.now() - t0);
      log({
        level: ms > 5000 ? "warn" : "info",
        msg: "scan-source",
        table: r.table,
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
        table: r.table,
        column: r.column,
        ms,
        err: e instanceof Error ? e.message : String(e),
        timedOut,
      });
      present = false;
    }
    await pgRun(
      `INSERT INTO ${pg("source_stat")}
         (dim_id, source_table, source_column, present, rows, distinct_values, unmapped, scanned_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, current_timestamp)
       ON CONFLICT (dim_id, source_table, source_column) DO UPDATE SET
         present = EXCLUDED.present, rows = EXCLUDED.rows,
         distinct_values = EXCLUDED.distinct_values, unmapped = EXCLUDED.unmapped,
         scanned_at = EXCLUDED.scanned_at`,
      [r.dimId, r.table, r.column, present, rows, distinct, unmapped],
    );
  }

  // automation: for every dimension, find raw values that case-insensitively
  // match an existing canonical label (confidence=100 exact match). Stage them
  // as drafts, then auto-commit when 100 >= publishThreshold (true for the
  // default of 95 — user raises the slider to require manual review instead).
  if (env.attachWarehouse) {
    const prefs = await getPreferences();
    const dimIds = [...new Set(regs.map((r) => r.dimId))];
    for (const id of dimIds) {
      const staged = await autoStageExactMatches(id);
      if (staged > 0 && prefs.publishThreshold <= 100) {
        await commit(id, "u_system");
      }
    }
  }

  return regs.length;
}

/** Auto-stage a draft (owned by u_system) for every warehouse raw value that
 *  case-insensitively matches an existing canonical label and is not yet in
 *  the dimension's lookup table. The match is deterministic — no AI, no fuzzy
 *  — so it always lands above any reasonable publish threshold. */
export async function autoStageExactMatches(dimId: string): Promise<number> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
  if (!meta) return 0;
  if (meta.keyKind === "external_id") return 0;

  const sources = await liveSources(dimId);
  if (!sources.length) return 0;

  // Warehouse: distinct raw values
  const occRows = await all<{ raw: string }>(occUnion(sources)).catch(
    () => [] as { raw: string }[],
  );
  if (!occRows.length) return 0;
  const warehouseRaws = [...new Set(occRows.map((r) => r.raw))];

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
    await saveDraft(dimId, m.raw, "mapped", m.label, m.key, "u_system");
  }
  await appendAuditAs(
    "u_system",
    "Auto-matched",
    `${matches.length} value${matches.length === 1 ? "" : "s"} staged in ${dimId} (exact label match)`,
  );
  return matches.length;
}

/** Register a warehouse column as a source for a dimension (idempotent). */
export async function addSource(
  dimId: string,
  table: string,
  column: string,
  opts: { silent?: boolean } = {},
): Promise<void> {
  void opts;
  await pgRun(
    `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column)
     VALUES ($1, $2, $3) ON CONFLICT (dim_id, source_table, source_column) DO NOTHING`,
    [dimId, table, column],
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
): Promise<UnmappedSample[]> {
  const meta = await pgGet<{ mapTable: string }>(
    `SELECT map_table AS "mapTable" FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
  if (!meta) return [];
  if (!env.attachWarehouse) return [];
  const col = qid(column);
  const n = Math.max(1, Math.min(50, Math.round(limit)));

  // Warehouse: raw values + counts (DuckDB)
  const occRows = await all<{ raw: string; cnt: bigint }>(`
    SELECT CAST(${col} AS VARCHAR) AS raw, count(*) AS cnt
    FROM ${whTable(table)}
    WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0
    GROUP BY 1`).catch(() => [] as { raw: string; cnt: bigint }[]);

  // Postgres: already-mapped raws
  const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(meta.mapTable)}`).catch(
    () => [] as { raw: string }[],
  );
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  // JS: filter unmapped, sort by count desc, take top N
  return occRows
    .filter((r) => !mappedSet.has(r.raw.toLowerCase()))
    .sort((a, b) => (b.cnt > a.cnt ? 1 : b.cnt < a.cnt ? -1 : 0))
    .slice(0, n)
    .map((r) => ({ raw: r.raw, rows: Number(r.cnt) }));
}

/** Returns true when the workspace scan is due based on preferences.scan_schedule
 *  and the last scanned_at timestamp. The scheduler uses this as a cheap
 *  is-anything-pending check before triggering scanSources (which scans them all).
 *  Returns false (silently) if the app-state schema hasn't been provisioned yet —
 *  the scheduler tick should no-op on a fresh DB, not spam the logs. */
export async function anyScanDue(now: Date = new Date()): Promise<boolean> {
  let sched: string | null;
  let lastScan: Date | null;
  try {
    const row = await pgGet<{ scan_schedule: string | null; last_scan: string | null }>(
      `SELECT p.scan_schedule,
              (SELECT max(st.scanned_at)::text
               FROM ${pg("source_stat")} st) AS last_scan
       FROM ${pg("preferences")} p WHERE p.id = 1`,
    );
    if (!row) return false;
    sched = row.scan_schedule;
    lastScan = row.last_scan ? new Date(row.last_scan) : null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation.*zugzug_app.*does not exist/i.test(msg)) return false;
    throw e;
  }
  if (!sched) return false;
  if (!lastScan) return true; // never scanned → run immediately
  const dueMs = sched === "15m" ? 15 * 60_000 : sched === "hourly" ? 60 * 60_000 : 24 * 60 * 60_000;
  return now.getTime() - lastScan.getTime() >= dueMs;
}

export interface ScanStatusResult {
  lastScanAt: string | null;
  sourceCount: number;
  unmappedCount: number;
}

export async function scanStatus(): Promise<ScanStatusResult> {
  const row = await pgGet<{
    last_scan: string | null;
    sources: number;
    unmapped: number;
  }>(
    `SELECT max(st.scanned_at)::text                   AS last_scan,
            count(s.*)::int                            AS sources,
            COALESCE(sum(st.unmapped), 0)::int         AS unmapped
     FROM ${pg("dimension_source")} s
     LEFT JOIN ${pg("source_stat")} st
       ON  st.dim_id = s.dim_id
       AND st.source_table  = s.source_table
       AND st.source_column = s.source_column`,
  ).catch(() => null);
  return {
    lastScanAt: row?.last_scan ?? null,
    sourceCount: Number(row?.sources ?? 0),
    unmappedCount: Number(row?.unmapped ?? 0),
  };
}

/** Browse/search the warehouse catalog (the 1000+ tables) — server-side search +
 *  schema facets + pagination, metadata only (no row counts). The scale surface. */
export async function searchCatalog(
  opts: { q?: string; schema?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: CatalogTable[]; total: number; schemas: { schema: string; tables: number }[] }> {
  if (!env.attachWarehouse) return { rows: [], total: 0, schemas: [] };
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const params: DuckDBValue[] = [env.warehouseDb];
  const cat = `SELECT schema, name AS tbl, column_names AS cols FROM (SHOW ALL TABLES) WHERE database = $1 AND name NOT LIKE '\\_dlt%' ESCAPE '\\'`;
  const filters: string[] = [];
  if (opts.q) {
    params.push(`%${opts.q}%`);
    const p = `$${params.length}`;
    filters.push(
      `(schema ILIKE ${p} OR tbl ILIKE ${p} OR len(list_filter(cols, c -> c ILIKE ${p})) > 0)`,
    );
  }
  const qWhere = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const schemaParams = [...params];
  let schemaWhere = qWhere;
  if (opts.schema) {
    schemaParams.push(opts.schema);
    schemaWhere = `${qWhere ? qWhere + " AND" : "WHERE"} schema = $${schemaParams.length}`;
  }

  const rows = await all<{ schema: string; tbl: string; cols: string }>(
    `WITH cat AS (${cat}), q AS (SELECT * FROM cat ${qWhere}) SELECT schema, tbl, to_json(cols) AS cols FROM q ${opts.schema ? `WHERE schema = $${schemaParams.length}` : ""} ORDER BY schema, tbl LIMIT ${limit} OFFSET ${offset}`,
    schemaWhere === qWhere ? params : schemaParams,
  ).catch(() => []);
  const totalRow = await get<{ n: bigint }>(
    `WITH cat AS (${cat}), q AS (SELECT * FROM cat ${qWhere}) SELECT count(*) AS n FROM q ${opts.schema ? `WHERE schema = $${schemaParams.length}` : ""}`,
    opts.schema ? schemaParams : params,
  ).catch(() => null);
  const schemas = await all<{ schema: string; tables: bigint }>(
    `WITH cat AS (${cat}), q AS (SELECT * FROM cat ${qWhere}) SELECT schema, count(*) AS tables FROM q GROUP BY 1 ORDER BY tables DESC, schema LIMIT 100`,
    params,
  ).catch(() => []);
  const parseCols = (c: string): string[] => {
    try {
      return (JSON.parse(c) as unknown[]).map(String);
    } catch {
      return [];
    }
  };
  return {
    rows: rows.map((r) => ({
      schema: r.schema,
      table: `${r.schema}.${r.tbl}`,
      columns: parseCols(r.cols),
    })),
    total: Number(totalRow?.n ?? 0),
    schemas: schemas.map((s) => ({ schema: s.schema, tables: Number(s.tables) })),
  };
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
): Promise<{ derived: number }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
  if (!meta) return { derived: 0 };
  await addSource(dimId, table, column);
  const external = meta.keyKind === "external_id";
  if (external && nameColumn) await addSource(dimId, table, nameColumn);

  const col = qid(column);
  let vals: string[];
  try {
    const rows = await all<{ v: string }>(
      `SELECT DISTINCT CAST(${col} AS VARCHAR) AS v FROM ${whTable(table)}
       WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0 ORDER BY 1 LIMIT 5000`,
    );
    vals = rows.map((r) => r.v);
  } catch {
    return { derived: 0 };
  } // warehouse not attached / table missing
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
        `UPDATE ${pg("dimension")} SET name_table = $1, name_id_col = $2, name_col = $3 WHERE id = $4`,
        [table, column, nameColumn, dimId],
      );
    }
    if (!opts.silent)
      await appendAuditAs(
        userId,
        "Derived canonical",
        `${ids.length} external-ID key${ids.length === 1 ? "" : "s"} from ${table}.${column} (names ← ${table}.${nameColumn ?? "?"})`,
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
    );
  return { derived: dimByKey.size };
}
