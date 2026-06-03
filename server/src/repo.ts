/* repo.ts — the data-access layer over the bridge. Implements the shapes the UI
   already calls (ARCHITECTURE.md): scanUnmapped, save/list/discardDraft, commit
   (the cross-store fold), appendAudit, plus the dimension registry + users.

   The scan is REGISTRY-DRIVEN: `dimension_source` rows say which warehouse
   table.column feed a dimension, so adding a source is data, not code. */

import { randomUUID } from "node:crypto";
import type { DuckDBValue } from "@duckdb/node-api";
import { all, get, run } from "./db.ts";
import { env, pg } from "./env.ts";

/* ---- shapes (mirror app/src/data.ts so the UI consumes them unchanged) ---- */
export interface FieldDef { field: string; label: string; type: string }
export interface CanonicalValue { key: string; label: string; variants?: number; fields?: Record<string, string | null>; unresolved?: boolean }
export interface SourceOccurrence { table: string; column: string; rows: number }
export interface MappingValue {
  value: string;
  status: "mapped" | "new";
  current: string | null;
  suggestion: string | null;
  confidence: number;
  sources: SourceOccurrence[];
}
export interface DimensionMeta {
  id: string; dimension: string; dimTable: string; mapTable: string; keyCol: string; rows: number;
  keyKind: "slug" | "external_id";
}
/** A registered warehouse source column for a dimension, with best-effort counts.
 *  `present` = the table is reachable in the warehouse (false when missing or the
 *  warehouse isn't attached); counts are 0 when empty/unreachable. Always returned
 *  so the UI can show the wiring even before any data lands. */
export interface SourceInfo {
  table: string; column: string; dimension: string; dimId: string;
  present: boolean; rows: number; values: number; unmapped: number; scanned: boolean;
}
export interface SchemaFacet { schema: string; columns: number; unmapped: number; missing: number }
export interface CatalogTable { schema: string; table: string; columns: string[] }
export interface MappingDimension extends DimensionMeta {
  canonical: CanonicalValue[];
  values: MappingValue[];
  fields: FieldDef[];
}
export interface Draft {
  dimId: string; raw: string; status: "mapped" | "skipped";
  targetLabel: string | null; targetKey: string | null;
  user: User; at: string;
}
export interface User { id: string; name: string; initials: string }
export interface AuditEntry { id: string; at: string; user: User; action: string; detail: string }

/* ---- helpers ---- */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;
/** 'schema.table' (or 'table') → fully-qualified warehouse identifier (MotherDuck). */
const whTable = (sourceTable: string) =>
  `${qid(env.warehouseDb)}.` + sourceTable.split(".").map(qid).join(".");
/** canonical table: display 'zugzug.dim_country' → 'oltp."zugzug"."dim_country"' (Postgres). */
const cq = (display: string) => `${env.oltpCatalog}.` + display.split(".").map(qid).join(".");
const rel = (secs: number): string => {
  if (secs < 45) return "just now";
  const m = Math.round(secs / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); return d === 1 ? "yesterday" : `${d}d ago`;
};

interface SourceDef { table: string; column: string }
const esc = (s: string) => s.replace(/'/g, "''");

async function sourcesOf(dimId: string): Promise<SourceDef[]> {
  return all<SourceDef>(
    `SELECT source_table AS "table", source_column AS column FROM ${pg("dimension_source")} WHERE dim_id = $1 ORDER BY 1,2`,
    [dimId],
  );
}

/** Keep only sources whose warehouse table actually resolves — a dimension
 *  registered against tables absent in this WAREHOUSE_DB (e.g. raw_dev vs
 *  raw_prod) still scans the rest instead of throwing. */
async function liveSources(dimId: string): Promise<SourceDef[]> {
  const out: SourceDef[] = [];
  for (const s of await sourcesOf(dimId)) {
    try { await run(`SELECT 1 FROM ${whTable(s.table)} LIMIT 0`); out.push(s); }
    catch { console.warn(`scan: skipping missing source ${env.warehouseDb}.${s.table}`); }
  }
  return out;
}

/** One UNION-ALL branch per source: distinct raw value + provenance + row count. */
function occUnion(sources: SourceDef[]): string {
  return sources.map((s) => {
    const col = qid(s.column);
    return `SELECT CAST(${col} AS VARCHAR) AS raw, '${esc(s.table)}' AS tbl, '${esc(s.column)}' AS col, count(*) AS rows
            FROM ${whTable(s.table)}
            WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0
            GROUP BY 1`;
  }).join("\nUNION ALL\n");
}

/** Registered source columns, read from the cached stats (POST /api/sources/scan
 *  refreshes them) so this is instant regardless of source count. Supports search
 *  (q), schema filter, and a status filter; ranked by unmapped (rows at risk). */
export async function listSources(opts: { q?: string; schema?: string; status?: string } = {}): Promise<SourceInfo[]> {
  const params: DuckDBValue[] = [];
  const where: string[] = [];
  if (opts.q) { params.push(`%${opts.q}%`); const p = `$${params.length}`; where.push(`(s.source_table ILIKE ${p} OR s.source_column ILIKE ${p})`); }
  if (opts.schema) { params.push(opts.schema); where.push(`split_part(s.source_table, '.', 1) = $${params.length}`); }
  if (opts.status === "needs") where.push(`COALESCE(st.unmapped, 0) > 0`);
  else if (opts.status === "clean") where.push(`COALESCE(st.present, false) AND COALESCE(st.unmapped, 0) = 0`);
  else if (opts.status === "missing") where.push(`st.scanned_at IS NOT NULL AND NOT st.present`);

  const rows = await all<{ dimId: string; dimension: string; table: string; column: string; present: boolean; rows: bigint; values: bigint; unmapped: bigint; scanned: boolean }>(
    `SELECT s.dim_id AS "dimId", d.label AS dimension, s.source_table AS "table", s.source_column AS column,
            COALESCE(st.present, false) AS present, COALESCE(st.rows, 0) AS rows,
            COALESCE(st.distinct_values, 0) AS values, COALESCE(st.unmapped, 0) AS unmapped,
            (st.scanned_at IS NOT NULL) AS scanned
     FROM ${pg("dimension_source")} s
     JOIN ${pg("dimension")} d ON d.id = s.dim_id
     LEFT JOIN ${pg("source_stat")} st ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY COALESCE(st.unmapped, 0) DESC, s.source_table, s.source_column
     LIMIT 1000`, params,
  );
  return rows.map((r) => ({ table: r.table, column: r.column, dimension: r.dimension, dimId: r.dimId, present: !!r.present, rows: Number(r.rows), values: Number(r.values), unmapped: Number(r.unmapped), scanned: !!r.scanned }));
}

/** Per-schema rollup for the facet rail — turns N source columns into ~systems. */
export async function sourceFacets(): Promise<SchemaFacet[]> {
  const rows = await all<{ schema: string; columns: bigint; unmapped: bigint; missing: bigint }>(
    `SELECT split_part(s.source_table, '.', 1) AS schema, count(*) AS columns,
            COALESCE(sum(st.unmapped), 0) AS unmapped,
            count(*) FILTER (WHERE st.scanned_at IS NOT NULL AND NOT st.present) AS missing
     FROM ${pg("dimension_source")} s
     LEFT JOIN ${pg("source_stat")} st ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column
     GROUP BY 1 ORDER BY unmapped DESC, schema`,
  );
  return rows.map((r) => ({ schema: r.schema, columns: Number(r.columns), unmapped: Number(r.unmapped), missing: Number(r.missing) }));
}

/** Refresh the cached stats for every registered source (the expensive scan,
 *  run explicitly). Returns how many sources were scanned. */
export async function scanSources(): Promise<number> {
  const regs = await all<{ dimId: string; table: string; column: string; mapTable: string }>(
    `SELECT s.dim_id AS "dimId", s.source_table AS "table", s.source_column AS column, d.map_table AS "mapTable"
     FROM ${pg("dimension_source")} s JOIN ${pg("dimension")} d ON d.id = s.dim_id`,
  );
  for (const r of regs) {
    const col = qid(r.column);
    let present = false, rows = 0, distinct = 0, unmapped = 0;
    try {
      const agg = await get<{ rows: bigint; d: bigint }>(
        `SELECT count(${col}) AS rows, count(DISTINCT ${col}) AS d FROM ${whTable(r.table)}
         WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0`);
      present = true; rows = Number(agg?.rows ?? 0); distinct = Number(agg?.d ?? 0);
      if (distinct > 0) {
        const u = await get<{ n: bigint }>(
          `SELECT count(*) AS n FROM (
             SELECT DISTINCT CAST(${col} AS VARCHAR) AS raw FROM ${whTable(r.table)}
             WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0
           ) o LEFT JOIN ${cq(r.mapTable)} m ON lower(m.raw) = lower(o.raw) WHERE m.raw IS NULL`);
        unmapped = Number(u?.n ?? 0);
      }
    } catch { present = false; }
    await run(
      `INSERT INTO ${pg("source_stat")} (dim_id, source_table, source_column, present, rows, distinct_values, unmapped, scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, current_timestamp)
       ON CONFLICT (dim_id, source_table, source_column) DO UPDATE SET
         present = excluded.present, rows = excluded.rows, distinct_values = excluded.distinct_values,
         unmapped = excluded.unmapped, scanned_at = excluded.scanned_at`,
      [r.dimId, r.table, r.column, present, rows, distinct, unmapped],
    );
  }
  return regs.length;
}

/** Register a warehouse column as a source for a dimension (idempotent). */
export async function addSource(dimId: string, table: string, column: string): Promise<void> {
  await run(
    `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column) VALUES ($1,$2,$3)
     ON CONFLICT (dim_id, source_table, source_column) DO NOTHING`, [dimId, table, column],
  );
}

/** Bulk upsert (raw, key)-style rows into a Postgres table in chunks. */
async function bulkInsert(prefix: string, rows: [string, string][], conflict: string): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(", ");
    await run(`${prefix} VALUES ${placeholders} ${conflict}`, chunk.flat() as DuckDBValue[]);
  }
}

/** Bulk insert single-column rows (e.g. external-ID keys) in chunks. */
async function bulkInsert1(prefix: string, values: string[], conflict: string): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `($${j + 1})`).join(", ");
    await run(`${prefix} VALUES ${placeholders} ${conflict}`, chunk as DuckDBValue[]);
  }
}

/** Derive (bootstrap) a dimension's canonical set from a source column's distinct
 *  values. For a 'slug' dimension each distinct value seeds a slug-keyed canonical
 *  (US/us collapse) mapped 1:1. For an 'external_id' dimension the source column IS
 *  the ID column: each distinct ID seeds a canonical keyed by the raw ID (no slug),
 *  self-mapped id→id, and the name binding (table, id_col, name_col) is persisted so
 *  the name resolves live on read. Returns how many canonical records resulted. */
export async function deriveCanonical(dimId: string, table: string, column: string, nameColumn?: string): Promise<{ derived: number }> {
  const meta = await get<{ dimTable: string; mapTable: string; keyCol: string; keyKind: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE id = $1`, [dimId]);
  if (!meta) return { derived: 0 };
  await addSource(dimId, table, column);
  const external = meta.keyKind === "external_id";
  if (external && nameColumn) await addSource(dimId, table, nameColumn);

  const col = qid(column);
  let vals: string[];
  try {
    const rows = await all<{ v: string }>(
      `SELECT DISTINCT CAST(${col} AS VARCHAR) AS v FROM ${whTable(table)}
       WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0 ORDER BY 1 LIMIT 5000`);
    vals = rows.map((r) => r.v);
  } catch { return { derived: 0 }; } // warehouse not attached / table missing
  if (!vals.length) return { derived: 0 };

  const key = qid(meta.keyCol);

  if (external) {
    const ids = [...new Set(vals)];
    await bulkInsert1(`INSERT INTO ${cq(meta.dimTable)} (${key})`, ids, `ON CONFLICT (${key}) DO NOTHING`);
    await bulkInsert(`INSERT INTO ${cq(meta.mapTable)} (raw, ${key})`, ids.map((v) => [v, v] as [string, string]), `ON CONFLICT (raw) DO NOTHING`);
    if (nameColumn) {
      await run(`UPDATE ${pg("dimension")} SET name_table = $1, name_id_col = $2, name_col = $3 WHERE id = $4`,
        [table, column, nameColumn, dimId]);
    }
    await appendAudit("Derived canonical", `${ids.length} external-ID key${ids.length === 1 ? "" : "s"} from ${table}.${column} (names ← ${table}.${nameColumn ?? "?"})`);
    return { derived: ids.length };
  }

  const dimByKey = new Map<string, string>(); // key → label (first wins)
  const mapPairs: [string, string][] = [];     // raw → key
  for (const v of vals) {
    const k = slug(v) || v.toLowerCase().slice(0, 60) || "_";
    if (!dimByKey.has(k)) dimByKey.set(k, v);
    mapPairs.push([v, k]);
  }
  await bulkInsert(`INSERT INTO ${cq(meta.dimTable)} (${key}, label)`, [...dimByKey.entries()], `ON CONFLICT (${key}) DO NOTHING`);
  await bulkInsert(`INSERT INTO ${cq(meta.mapTable)} (raw, ${key})`, mapPairs, `ON CONFLICT (raw) DO NOTHING`);
  await appendAudit("Derived canonical", `${dimByKey.size} value${dimByKey.size === 1 ? "" : "s"} from ${table}.${column} → ${meta.dimTable}`);
  return { derived: dimByKey.size };
}

/** Browse/search the warehouse catalog (the 1000+ tables) — server-side search +
 *  schema facets + pagination, metadata only (no row counts). The scale surface. */
export async function searchCatalog(opts: { q?: string; schema?: string; limit?: number; offset?: number } = {}): Promise<{ rows: CatalogTable[]; total: number; schemas: { schema: string; tables: number }[] }> {
  if (!env.attachWarehouse) return { rows: [], total: 0, schemas: [] };
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const params: DuckDBValue[] = [env.warehouseDb];
  const cat = `SELECT schema, name AS tbl, column_names AS cols FROM (SHOW ALL TABLES) WHERE database = $1 AND name NOT LIKE '\\_dlt%' ESCAPE '\\'`;
  const filters: string[] = [];
  if (opts.q) { params.push(`%${opts.q}%`); const p = `$${params.length}`; filters.push(`(schema ILIKE ${p} OR tbl ILIKE ${p} OR len(list_filter(cols, c -> c ILIKE ${p})) > 0)`); }
  const qWhere = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const schemaParams = [...params];
  let schemaWhere = qWhere;
  if (opts.schema) { schemaParams.push(opts.schema); schemaWhere = `${qWhere ? qWhere + " AND" : "WHERE"} schema = $${schemaParams.length}`; }

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
  const parseCols = (c: string): string[] => { try { return (JSON.parse(c) as unknown[]).map(String); } catch { return []; } };
  return {
    rows: rows.map((r) => ({ schema: r.schema, table: `${r.schema}.${r.tbl}`, columns: parseCols(r.cols) })),
    total: Number(totalRow?.n ?? 0),
    schemas: schemas.map((s) => ({ schema: s.schema, tables: Number(s.tables) })),
  };
}

/* ---- users & presence (Postgres) ---- */
export async function listUsers(): Promise<User[]> {
  return all<User>(`SELECT id, name, initials FROM ${pg("users")} ORDER BY id`);
}

/* ---- dimension registry (Postgres) + canonical tables (MotherDuck) ---- */
export async function listDimensions(): Promise<DimensionMeta[]> {
  const metas = await all<Omit<DimensionMeta, "rows">>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} ORDER BY label`,
  );
  const out: DimensionMeta[] = [];
  for (const m of metas) {
    const r = await get<{ n: bigint }>(`SELECT count(*) AS n FROM ${cq(m.mapTable)}`).catch(() => null);
    out.push({ ...m, rows: Number(r?.n ?? 0) });
  }
  return out;
}

export async function getDimension(id: string): Promise<MappingDimension | null> {
  const meta = await get<Omit<DimensionMeta, "rows"> & { nameTable: string | null; nameIdCol: string | null; nameCol: string | null }>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind",
            name_table AS "nameTable", name_id_col AS "nameIdCol", name_col AS "nameCol"
     FROM ${pg("dimension")} WHERE id = $1`, [id],
  );
  if (!meta) return null;
  const k = qid(meta.keyCol);
  const fields = await listFields(id);
  const fieldCols = fields.map((f) => `CAST(d.${qid(f.field)} AS VARCHAR) AS ${qid(f.field)}`).join(", ");

  // external-ID dims resolve the display name live from the warehouse (store the
  // ID, render the name). When the warehouse is detached or no binding is set,
  // every row is unresolved and the label falls back to the key.
  const liveName = meta.keyKind === "external_id" && env.attachWarehouse && !!meta.nameTable && !!meta.nameIdCol && !!meta.nameCol;
  const variantsJoin = `LEFT JOIN (SELECT ${k} AS gk, count(*) AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}`;

  const sql = liveName
    ? `SELECT d.${k} AS key, w.nm AS label, (w.id IS NULL) AS unresolved, COALESCE(v.n, 0) AS variants${fields.length ? ", " + fieldCols : ""}
       FROM ${cq(meta.dimTable)} d
       LEFT JOIN (SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id, CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm FROM ${whTable(meta.nameTable!)}) w ON w.id = d.${k}
       ${variantsJoin}
       ORDER BY variants DESC, d.${k}`
    : meta.keyKind === "external_id"
    ? `SELECT d.${k} AS key, NULL AS label, true AS unresolved, COALESCE(v.n, 0) AS variants${fields.length ? ", " + fieldCols : ""}
       FROM ${cq(meta.dimTable)} d ${variantsJoin} ORDER BY variants DESC, d.${k}`
    : `SELECT d.${k} AS key, d.label, false AS unresolved, COALESCE(v.n, 0) AS variants${fields.length ? ", " + fieldCols : ""}
       FROM ${cq(meta.dimTable)} d ${variantsJoin} ORDER BY variants DESC, d.label`;

  const canonical = await all<Record<string, unknown>>(sql).then((rows) => rows.map((r) => ({
    key: String(r.key),
    label: r.label == null ? String(r.key) : String(r.label),
    unresolved: !!r.unresolved,
    variants: Number(r.variants),
    fields: Object.fromEntries(fields.map((f) => [f.field, r[f.field] == null ? null : String(r[f.field])])),
  })));
  const rowsRow = await get<{ n: bigint }>(`SELECT count(*) AS n FROM ${cq(meta.mapTable)}`).catch(() => null);
  const values = await scanValues(id, meta);
  const { nameTable, nameIdCol, nameCol, ...metaOut } = meta;
  return { ...metaOut, rows: Number(rowsRow?.n ?? 0), canonical, values, fields };
}

/** Distinct warehouse values for a dimension WITH provenance, tagged mapped/new
 *  by LEFT JOIN to the crosswalk. This is the core scan from ARCHITECTURE.md. */
async function scanValues(
  dimId: string,
  meta: Omit<DimensionMeta, "rows"> & { nameTable?: string | null; nameIdCol?: string | null; nameCol?: string | null },
): Promise<MappingValue[]> {
  let sources = await liveSources(dimId);
  // the bound name column is wired as a source so the derive picker can see it,
  // but it is the name binding — not a value to reconcile. Exclude it from the scan.
  if (meta.keyKind === "external_id" && meta.nameTable && meta.nameCol) {
    sources = sources.filter((s) => !(s.table === meta.nameTable && s.column === meta.nameCol));
  }
  if (!sources.length) return [];
  const liveName = meta.keyKind === "external_id" && env.attachWarehouse && !!meta.nameTable && !!meta.nameIdCol && !!meta.nameCol;
  const keyc = qid(meta.keyCol);

  const currentExpr = liveName ? "any_value(w.nm)" : "any_value(c.label)";
  const nameJoin = liveName
    ? `LEFT JOIN (SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id, CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm FROM ${whTable(meta.nameTable!)}) w ON w.id = m.${keyc}`
    : `LEFT JOIN ${cq(meta.dimTable)} c ON c.${keyc} = m.${keyc}`;

  const sql = `
    WITH occ AS (${occUnion(sources)})
    SELECT o.raw AS value,
           CASE WHEN m.raw IS NOT NULL THEN 'mapped' ELSE 'new' END AS status,
           ${currentExpr} AS current,
           to_json(list({'table': o.tbl, 'column': o.col, 'rows': o.rows})) AS sources
    FROM occ o
    LEFT JOIN ${cq(meta.mapTable)} m ON lower(m.raw) = lower(o.raw)
    ${nameJoin}
    GROUP BY o.raw, (m.raw IS NOT NULL)
    ORDER BY status ASC, sum(o.rows) DESC
    LIMIT 500`;

  const rows = await all<{ value: string; status: "mapped" | "new"; current: string | null; sources: string }>(sql);
  const parseSources = (c: string): SourceOccurrence[] => {
    try { return (JSON.parse(c) as SourceOccurrence[]).map((s) => ({ table: s.table, column: s.column, rows: Number(s.rows) })); } catch { return []; }
  };
  return rows.map((r) => ({
    value: r.value,
    status: r.status,
    current: r.current ?? null,
    suggestion: null,        // AI suggestion is a fast-follow; manual reconcile for now
    confidence: 0,
    sources: parseSources(r.sources),
  }));
}

/** Create a dimension: register it + provision dim_/map_ (Postgres) + register
 *  its warehouse sources. Idempotent on the id. For key_kind 'external_id' the
 *  dim_ label is nullable (names are resolved live from the warehouse, not stored). */
export async function addDimension(
  name: string,
  sources: SourceDef[] = [],
  opts: { keyKind?: "slug" | "external_id" } = {},
): Promise<string> {
  const id = slug(name);
  if (!id) return id;
  const keyKind = opts.keyKind === "external_id" ? "external_id" : "slug";
  const dimTable = `${env.canonicalSchema}.dim_${id}`;
  const mapTable = `${env.canonicalSchema}.map_${id}`;
  const keyCol = `${id}_code`;
  const existing = await get(`SELECT id FROM ${pg("dimension")} WHERE id = $1`, [id]);
  if (!existing) {
    const labelDdl = keyKind === "external_id" ? "label VARCHAR" : "label VARCHAR NOT NULL";
    await run(`CREATE TABLE IF NOT EXISTS ${cq(dimTable)} (${qid(keyCol)} VARCHAR PRIMARY KEY, ${labelDdl})`);
    await run(`CREATE TABLE IF NOT EXISTS ${cq(mapTable)} (raw VARCHAR PRIMARY KEY, ${qid(keyCol)} VARCHAR NOT NULL)`);
    await run(
      `INSERT INTO ${pg("dimension")} (id, label, dim_table, map_table, key_col, key_kind, created_at) VALUES ($1,$2,$3,$4,$5,$6, current_timestamp)`,
      [id, name.trim(), dimTable, mapTable, keyCol, keyKind],
    );
    await appendAudit("Created dimension", `${name.trim()} → dim_${id} + map_${id}${keyKind === "external_id" ? " (external-ID key)" : ""}`);
  }
  for (const s of sources) {
    await run(
      `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column) VALUES ($1,$2,$3)
       ON CONFLICT (dim_id, source_table, source_column) DO NOTHING`,
      [id, s.table, s.column],
    );
  }
  return id;
}

/** Seed canonical values into a dimension's dim_ table (idempotent). */
export async function addCanonical(dimId: string, values: CanonicalValue[]): Promise<void> {
  const meta = await get<{ dimTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM ${pg("dimension")} WHERE id = $1`, [dimId],
  );
  if (!meta) return;
  for (const v of values) {
    await run(
      `INSERT INTO ${cq(meta.dimTable)} (${qid(meta.keyCol)}, label) VALUES ($1,$2) ON CONFLICT (${qid(meta.keyCol)}) DO NOTHING`,
      [v.key, v.label],
    );
  }
}

interface DimMeta { dimTable: string; mapTable: string; keyCol: string }
async function dimMeta(dimId: string): Promise<DimMeta | null> {
  return get<DimMeta>(`SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol" FROM ${pg("dimension")} WHERE id = $1`, [dimId]);
}

/** Add one canonical record (key derived from the label if not given). */
export async function addCanonicalOne(dimId: string, label: string, key?: string): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const k = (key && slug(key)) || slug(label);
  if (!k) return;
  await run(`INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1,$2) ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`, [k, label]);
  await appendAudit("Added canonical", `${label} (${k})`);
}

/** Rename a canonical's display label (the key is stable). */
export async function renameCanonical(dimId: string, key: string, label: string): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  await run(`UPDATE ${cq(m.dimTable)} SET label = $1 WHERE ${qid(m.keyCol)} = $2`, [label, key]);
  await appendAudit("Renamed canonical", `${key} → “${label}”`);
}

/** Merge loser canonicals into a survivor: re-point every crosswalk row, drop the
 *  losers' golden records, audit. The core MDM consolidation step. */
export async function mergeCanonical(dimId: string, survivor: string, losers: string[]): Promise<number> {
  const m = await dimMeta(dimId);
  if (!m) return 0;
  const key = qid(m.keyCol);
  const real = losers.filter((l) => l && l !== survivor);
  for (const loser of real) {
    await run(`UPDATE ${cq(m.mapTable)} SET ${key} = $1 WHERE ${key} = $2`, [survivor, loser]);
    await run(`DELETE FROM ${cq(m.dimTable)} WHERE ${key} = $1`, [loser]);
  }
  if (real.length) await appendAudit("Merged canonical", `${real.join(", ")} → ${survivor}`);
  return real.length;
}

/** Retire a canonical — governed: refused while raw variants still map to it. */
export async function retireCanonical(dimId: string, key: string): Promise<{ ok: boolean; variants: number }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false, variants: 0 };
  const v = await get<{ n: bigint }>(`SELECT count(*) AS n FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1`, [key]);
  const variants = Number(v?.n ?? 0);
  if (variants > 0) return { ok: false, variants };
  await run(`DELETE FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`, [key]);
  await appendAudit("Retired canonical", key);
  return { ok: true, variants: 0 };
}

/* ---- enrichment fields (attribute columns on dim_) ---- */
export async function listFields(dimId: string): Promise<FieldDef[]> {
  return all<FieldDef>(`SELECT field, label, type FROM ${pg("dimension_field")} WHERE dim_id = $1 ORDER BY created_at`, [dimId]);
}

// types must be valid in BOTH DuckDB and the attached Postgres (DDL is forwarded
// to PG): Postgres has no DOUBLE, so number → NUMERIC.
const SQL_TYPE: Record<string, string> = { text: "VARCHAR", number: "NUMERIC", boolean: "BOOLEAN", date: "DATE" };

/** Add an attribute column to a dimension's dim_ table (ALTER TABLE). type ∈
 *  text | number | boolean | date (defaults text). */
export async function addField(dimId: string, label: string, type = "text"): Promise<{ field: string } | null> {
  const m = await dimMeta(dimId);
  if (!m) return null;
  const t = SQL_TYPE[type] ? type : "text";
  const field = slug(label);
  if (!field || field === "label" || field === slug(m.keyCol)) return null; // reserved
  await run(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN IF NOT EXISTS ${qid(field)} ${SQL_TYPE[t]}`);
  await run(
    `INSERT INTO ${pg("dimension_field")} (dim_id, field, label, type, created_at) VALUES ($1,$2,$3,$4, current_timestamp)
     ON CONFLICT (dim_id, field) DO NOTHING`, [dimId, field, label.trim(), t]);
  await appendAudit("Added field", `${label.trim()} (${field}, ${t}) → ${m.dimTable}`);
  return { field };
}

/** Set one enrichment field on a canonical record (only registered fields),
 *  cast to the field's declared type. */
export async function setFieldValue(dimId: string, key: string, field: string, value: string | null): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f) return;
  const col = qid(field), keyc = qid(m.keyCol);
  const empty = value == null || value.trim() === "";
  if (f.type === "number") {
    const n = empty ? null : Number(value);
    await run(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [Number.isFinite(n as number) ? (n as number) : null, key]);
  } else if (f.type === "boolean") {
    const b = value === "true" ? true : value === "false" ? false : null;
    await run(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [b, key]);
  } else if (f.type === "date") {
    await run(`UPDATE ${cq(m.dimTable)} SET ${col} = CAST($1 AS DATE) WHERE ${keyc} = $2`, [empty ? null : value!.trim(), key]);
  } else {
    await run(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [empty ? null : value, key]);
  }
}

/** The raw variants that resolve to a canonical key — the lineage "receipt". */
export async function listVariants(dimId: string, key: string): Promise<string[]> {
  const m = await dimMeta(dimId);
  if (!m) return [];
  const rows = await all<{ raw: string }>(`SELECT raw FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1 ORDER BY raw LIMIT 300`, [key]);
  return rows.map((r) => r.raw);
}

/* ---- drafts (Postgres) ---- */
async function userById(id: string): Promise<User> {
  return (await get<User>(`SELECT id, name, initials FROM ${pg("users")} WHERE id = $1`, [id]))
    ?? { id, name: id, initials: id.slice(0, 2).toUpperCase() };
}

export async function listDrafts(dimId: string): Promise<Draft[]> {
  const rows = await all<{ dimId: string; raw: string; status: "mapped" | "skipped"; targetLabel: string | null; targetKey: string | null; uid: string; secs: number }>(
    `SELECT dim_id AS "dimId", raw, status, target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid, epoch(current_timestamp - created_at) AS secs
     FROM ${pg("draft")} WHERE dim_id = $1 ORDER BY created_at DESC`, [dimId],
  );
  const out: Draft[] = [];
  for (const r of rows) out.push({ dimId: r.dimId, raw: r.raw, status: r.status, targetLabel: r.targetLabel, targetKey: r.targetKey, user: await userById(r.uid), at: rel(Number(r.secs)) });
  return out;
}

export async function saveDraft(dimId: string, raw: string, status: "mapped" | "skipped", targetLabel: string | null, targetKey: string | null, userId: string): Promise<void> {
  await run(
    `INSERT INTO ${pg("draft")} (dim_id, raw, status, target_label, target_key, user_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, current_timestamp)
     ON CONFLICT (dim_id, raw, user_id) DO UPDATE SET status = excluded.status, target_label = excluded.target_label, target_key = excluded.target_key, created_at = excluded.created_at`,
    [dimId, raw, status, targetLabel, targetKey, userId],
  );
}

export async function discardDraft(dimId: string, raw: string, userId: string): Promise<void> {
  await run(`DELETE FROM ${pg("draft")} WHERE dim_id = $1 AND raw = $2 AND user_id = $3`, [dimId, raw, userId]);
}

/** Approve & commit: fold the dimension's `mapped` drafts into MotherDuck in one
 *  batch (cross-store: read Postgres drafts, write MotherDuck dim_/map_), then
 *  clear them + audit. Idempotent writes (NOT EXISTS) so a partial failure retries. */
export async function commit(dimId: string, userId: string): Promise<{ committed: number; rowsRecovered: number }> {
  const meta = await get<{ dimTable: string; mapTable: string; keyCol: string; label: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", label FROM ${pg("dimension")} WHERE id = $1`, [dimId],
  );
  if (!meta) return { committed: 0, rowsRecovered: 0 };
  const key = qid(meta.keyCol);
  const DRAFT = pg("draft");
  const DIMT = cq(meta.dimTable);
  const MAPT = cq(meta.mapTable);

  const approved = await get<{ n: bigint }>(
    `SELECT count(*) AS n FROM ${DRAFT} WHERE dim_id = $1 AND status = 'mapped' AND target_key IS NOT NULL`, [dimId],
  );
  const committed = Number(approved?.n ?? 0);
  if (!committed) return { committed: 0, rowsRecovered: 0 };

  // rows recovered = warehouse rows whose raw is about to become resolved
  const rowsRecovered = await rowsForUnmappedDrafts(dimId, meta.mapTable);

  // NOT a single transaction: DuckDB forbids writing two attached catalogs
  // (MotherDuck + Postgres) in one txn, and there's no 2PC across them anyway.
  // Each write is idempotent (NOT EXISTS) and the DELETE runs last, so a partial
  // failure leaves drafts intact and re-committing is a safe no-op.
  await run(
    `INSERT INTO ${DIMT} (${key}, label)
     SELECT DISTINCT d.target_key, d.target_label FROM ${DRAFT} d
     WHERE d.dim_id = $1 AND d.status = 'mapped' AND d.target_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)`, [dimId],
  );
  await run(
    `INSERT INTO ${MAPT} (raw, ${key})
     SELECT d.raw, d.target_key FROM ${DRAFT} d
     WHERE d.dim_id = $1 AND d.status = 'mapped' AND d.target_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ${MAPT} m WHERE lower(m.raw) = lower(d.raw))`, [dimId],
  );
  await run(`DELETE FROM ${DRAFT} WHERE dim_id = $1 AND status = 'mapped'`, [dimId]);

  await appendAuditAs(userId, "Committed", `${committed} value${committed === 1 ? "" : "s"} → ${meta.mapTable} · ${rowsRecovered.toLocaleString()} rows recovered`);
  return { committed, rowsRecovered };
}

/** Warehouse rows for raws that have a mapped draft but aren't yet in the map. */
async function rowsForUnmappedDrafts(dimId: string, mapTable: string): Promise<number> {
  const sources = await liveSources(dimId);
  if (!sources.length) return 0;
  const r = await get<{ n: bigint }>(
    `WITH occ AS (${occUnion(sources)})
     SELECT COALESCE(sum(o.rows), 0) AS n FROM occ o
     JOIN ${pg("draft")} d ON lower(d.raw) = lower(o.raw) AND d.dim_id = $1 AND d.status = 'mapped'
     WHERE NOT EXISTS (SELECT 1 FROM ${cq(mapTable)} m WHERE lower(m.raw) = lower(o.raw))`, [dimId],
  ).catch(() => null);
  return Number(r?.n ?? 0);
}

/* ---- audit (Postgres, append-only) ---- */
export async function appendAuditAs(userId: string, action: string, detail: string): Promise<void> {
  await run(
    `INSERT INTO ${pg("audit_log")} (id, created_at, user_id, action, detail) VALUES ($1, current_timestamp, $2, $3, $4)`,
    [randomUUID(), userId, action, detail],
  );
}
/** Convenience: audit as the demo's default actor (used by system actions). */
export async function appendAudit(action: string, detail: string): Promise<void> {
  await appendAuditAs("u_ada", action, detail);
}

/* --- workspace-global preferences (single row, id=1) --- */
export interface Preferences { publishThreshold: number; suggestThreshold: number }

export async function getPreferences(): Promise<Preferences> {
  const row = (await all<{ publish_threshold: number; suggest_threshold: number }>(
    `SELECT publish_threshold, suggest_threshold FROM ${pg("preferences")} WHERE id = 1`,
  ))[0];
  return row
    ? { publishThreshold: Number(row.publish_threshold), suggestThreshold: Number(row.suggest_threshold) }
    : { publishThreshold: 95, suggestThreshold: 80 };
}

export async function setPreferences(p: Preferences): Promise<void> {
  const publish = Math.max(0, Math.min(100, Math.round(p.publishThreshold)));
  const suggest = Math.max(0, Math.min(publish, Math.round(p.suggestThreshold)));
  await run(
    `UPDATE ${pg("preferences")} SET publish_threshold = $1, suggest_threshold = $2, updated_at = current_timestamp WHERE id = 1`,
    [publish, suggest],
  );
}

export async function listAudit(limit = 30): Promise<AuditEntry[]> {
  const rows = await all<{ id: string; uid: string; action: string; detail: string; secs: number }>(
    `SELECT id, user_id AS uid, action, detail, epoch(current_timestamp - created_at) AS secs
     FROM ${pg("audit_log")} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
  );
  const out: AuditEntry[] = [];
  for (const r of rows) out.push({ id: r.id, user: await userById(r.uid), action: r.action, detail: r.detail, at: rel(Number(r.secs)) });
  return out;
}
