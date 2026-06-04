/* repo.ts — the data-access layer over the bridge. Implements the shapes the UI
   already calls (ARCHITECTURE.md): scanUnmapped, save/list/discardDraft, commit
   (the cross-store fold), appendAuditAs, plus the dimension registry + users.

   The scan is REGISTRY-DRIVEN: `dimension_source` rows say which warehouse
   table.column feed a dimension, so adding a source is data, not code. */

import { randomUUID } from "node:crypto";
import type { DuckDBValue } from "@duckdb/node-api";
import { all, get, run } from "./db.ts";
import { pgAll, pgGet, pgRun, pgTx } from "./pg.ts";
import { env, pg } from "./env.ts";
import { log } from "./log.ts";

/* ---- shapes (mirror app/src/data.ts so the UI consumes them unchanged) ---- */

/** Curated palette token. Mirror of app/src/lib/palette.ts so the server can
 *  validate inbound values without a shared module. */
export type PaletteName = "rose" | "amber" | "mint" | "teal" | "indigo" | "violet" | "slate";
const PALETTE_NAMES: PaletteName[] = ["rose", "amber", "mint", "teal", "indigo", "violet", "slate"];

export interface OptionDef {
  label: string;
  color: PaletteName | null;
}

/** Read on-disk option JSON in both shapes. Legacy `string[]` lifts to
 *  `[{ label, color: null }]`; the new `{ label, color }` shape passes through.
 *  Non-array / malformed JSON returns `undefined`. */
export function parseOptions(raw: unknown): OptionDef[] | undefined {
  let arr: unknown = raw;
  if (typeof arr === "string" && arr.length > 0) {
    try {
      arr = JSON.parse(arr);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(arr)) return undefined;
  return arr.map((o) => {
    if (typeof o === "string") return { label: o, color: null };
    if (o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string") {
      const color = (o as { color?: unknown }).color;
      return {
        label: (o as { label: string }).label,
        color:
          typeof color === "string" && PALETTE_NAMES.includes(color as PaletteName)
            ? (color as PaletteName)
            : null,
      };
    }
    return { label: String(o), color: null };
  });
}

export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
}
export interface CanonicalValue {
  key: string;
  label: string;
  variants?: number;
  fields?: Record<string, string | null>;
  unresolved?: boolean;
}
export interface SourceOccurrence {
  table: string;
  column: string;
  rows: number;
}
export interface MappingValue {
  value: string;
  status: "mapped" | "new";
  current: string | null;
  suggestion: string | null;
  confidence: number;
  sources: SourceOccurrence[];
}
export interface DimensionMeta {
  id: string;
  dimension: string;
  dimTable: string;
  mapTable: string;
  keyCol: string;
  rows: number;
  keyKind: "slug" | "external_id";
}
/** A registered warehouse source column for a dimension, with best-effort counts.
 *  `present` = the table is reachable in the warehouse (false when missing or the
 *  warehouse isn't attached); counts are 0 when empty/unreachable. Always returned
 *  so the UI can show the wiring even before any data lands. */
export interface SourceInfo {
  table: string;
  column: string;
  dimension: string;
  dimId: string;
  present: boolean;
  rows: number;
  values: number;
  unmapped: number;
  scanned: boolean;
  schedule?: string | null; // null | '15m' | 'hourly' | 'daily'
  scannedAt?: string | null; // ISO timestamp of last scan
}
export interface SchemaFacet {
  schema: string;
  columns: number;
  unmapped: number;
  missing: number;
}
export interface CatalogTable {
  schema: string;
  table: string;
  columns: string[];
}
export interface MappingDimension extends DimensionMeta {
  description: string | null;
  color: PaletteName | null;
  canonical: CanonicalValue[];
  values: MappingValue[];
  fields: FieldDef[];
}
export interface Draft {
  dimId: string;
  raw: string;
  status: "mapped" | "skipped";
  targetLabel: string | null;
  targetKey: string | null;
  user: User;
  at: string;
}
export interface User {
  id: string;
  name: string;
  initials: string;
}
export interface AuditEntry {
  id: string;
  at: string;
  user: User;
  action: string;
  detail: string;
}

/* ---- helpers ---- */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;
/** 'schema.table' (or 'table') → fully-qualified warehouse identifier (MotherDuck). */
const whTable = (sourceTable: string) =>
  `${qid(env.warehouseDb)}.` + sourceTable.split(".").map(qid).join(".");
/** canonical table: display 'zugzug.dim_country' → '"zugzug"."dim_country"' (2-part Postgres). */
const cq = (display: string) => display.split(".").map(qid).join(".");
const rel = (secs: number): string => {
  if (secs < 45) return "just now";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
};

interface SourceDef {
  table: string;
  column: string;
}
const esc = (s: string) => s.replace(/'/g, "''");

async function sourcesOf(dimId: string): Promise<SourceDef[]> {
  return pgAll<SourceDef>(
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
    try {
      await run(`SELECT 1 FROM ${whTable(s.table)} LIMIT 0`);
      out.push(s);
    } catch {
      console.warn(`scan: skipping missing source ${env.warehouseDb}.${s.table}`);
    }
  }
  return out;
}

/** One UNION-ALL branch per source: distinct raw value + provenance + row count. */
function occUnion(sources: SourceDef[]): string {
  return sources
    .map((s) => {
      const col = qid(s.column);
      return `SELECT CAST(${col} AS VARCHAR) AS raw, '${esc(s.table)}' AS tbl, '${esc(s.column)}' AS col, count(*) AS rows
            FROM ${whTable(s.table)}
            WHERE ${col} IS NOT NULL AND length(trim(CAST(${col} AS VARCHAR))) > 0
            GROUP BY 1`;
    })
    .join("\nUNION ALL\n");
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
    schedule: string | null;
    scannedAt: string | null;
  }>(
    `SELECT s.dim_id AS "dimId", d.label AS dimension, s.source_table AS "table", s.source_column AS column,
            COALESCE(st.present, false) AS present,
            COALESCE(st.rows, 0)::int AS rows,
            COALESCE(st.distinct_values, 0)::int AS values,
            COALESCE(st.unmapped, 0)::int AS unmapped,
            (st.scanned_at IS NOT NULL) AS scanned,
            s.schedule AS schedule,
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
    schedule: r.schedule ?? null,
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

  // automation: for every dimension, auto-stage drafts where a freshly-scanned
  // raw value matches an existing canonical label case-insensitively. This is
  // a confidence=100 deterministic match — fuzzy/AI suggestion machinery is a
  // future fast-follow. Only runs when the warehouse is attached + the prefs
  // publish threshold allows exact matches (always true today; the threshold
  // matters when fuzzy lands).
  if (env.attachWarehouse) {
    const prefs = await getPreferences();
    if (prefs.publishThreshold <= 100) {
      const dimIds = [...new Set(regs.map((r) => r.dimId))];
      for (const id of dimIds) await autoStageExactMatches(id);
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
export interface UnmappedSample {
  raw: string;
  rows: number;
}
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

/** Set (or clear) the automatic scan cadence for a wired source. Valid values:
 *  null (no schedule), '15m', 'hourly', 'daily'. */
export async function setSourceSchedule(
  dimId: string,
  table: string,
  column: string,
  schedule: string | null,
): Promise<void> {
  const valid = schedule === null || ["15m", "hourly", "daily"].includes(schedule);
  if (!valid) throw new Error(`invalid schedule: ${schedule}`);
  await pgRun(
    `UPDATE ${pg("dimension_source")} SET schedule = $1
     WHERE dim_id = $2 AND source_table = $3 AND source_column = $4`,
    [schedule, dimId, table, column],
  );
}

/** Returns true when at least one wired source is due for its scheduled scan,
 *  given the last scanned_at on source_stat. The scheduler uses this as a cheap
 *  is-anything-pending check before triggering scanSources (which scans them all).
 *  Returns false (silently) if the app-state schema hasn't been provisioned yet —
 *  the scheduler tick should no-op on a fresh DB, not spam the logs. */
export async function anyScanDue(now: Date = new Date()): Promise<boolean> {
  let rows: { schedule: string; scanned_at: string | null }[];
  try {
    rows = await pgAll<{ schedule: string; scanned_at: string | null }>(
      `SELECT s.schedule, st.scanned_at::text AS scanned_at
       FROM ${pg("dimension_source")} s
       LEFT JOIN ${pg("source_stat")} st
         ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column
       WHERE s.schedule IS NOT NULL`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation.*zugzug_app.*does not exist/i.test(msg)) return false;
    throw e;
  }
  const dueMs = (s: string) =>
    s === "15m"
      ? 15 * 60_000
      : s === "hourly"
        ? 60 * 60_000
        : s === "daily"
          ? 24 * 60 * 60_000
          : Infinity;
  return rows.some(
    (r) => !r.scanned_at || now.getTime() - new Date(r.scanned_at).getTime() >= dueMs(r.schedule),
  );
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

/* ---- users & presence (Postgres) ---- */
export async function listUsers(): Promise<User[]> {
  return pgAll<User>(`SELECT id, name, initials FROM ${pg("users")} ORDER BY id`);
}

/* ---- dimension registry (Postgres) + canonical tables (MotherDuck) ---- */
export async function listDimensions(): Promise<DimensionMeta[]> {
  const metas = await pgAll<Omit<DimensionMeta, "rows">>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} ORDER BY label`,
  );
  const counts = await Promise.all(
    metas.map((m) =>
      pgGet<{ n: number }>(`SELECT count(*)::int AS n FROM ${cq(m.mapTable)}`).catch(() => null),
    ),
  );

  return metas.map((m, i) => ({ ...m, rows: Number(counts[i]?.n ?? 0) }));
}

export async function getDimension(id: string): Promise<MappingDimension | null> {
  const meta = await pgGet<
    Omit<DimensionMeta, "rows"> & {
      nameTable: string | null;
      nameIdCol: string | null;
      nameCol: string | null;
      description: string | null;
      color: string | null;
    }
  >(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind",
            name_table AS "nameTable", name_id_col AS "nameIdCol", name_col AS "nameCol",
            description, color
     FROM ${pg("dimension")} WHERE id = $1`,
    [id],
  );
  if (!meta) return null;

  const k = qid(meta.keyCol);
  const fields = await listFields(id);
  const fieldCols = fields
    .map((f) => `CAST(d.${qid(f.field)} AS VARCHAR) AS ${qid(f.field)}`)
    .join(", ");

  const liveName =
    meta.keyKind === "external_id" &&
    env.attachWarehouse &&
    !!meta.nameTable &&
    !!meta.nameIdCol &&
    !!meta.nameCol;

  // Fetch canonical rows from Postgres
  let canonRows: Record<string, unknown>[];
  if (meta.keyKind === "external_id") {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, NULL AS label, true AS unresolved${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ORDER BY variants DESC, d.${k}`,
    );
  } else {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, d.label, false AS unresolved${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ORDER BY variants DESC, d.label`,
    );
  }

  // For external_id dims with warehouse attached: resolve names from MotherDuck
  if (liveName) {
    const nameRows = await all<{ id: string; nm: string }>(
      `SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id,
              CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm
       FROM ${whTable(meta.nameTable!)}`,
    ).catch(() => [] as { id: string; nm: string }[]);
    const nameMap = new Map(nameRows.map((r) => [r.id, r.nm]));
    for (const r of canonRows) {
      const key = String(r.key);
      r.label = nameMap.get(key) ?? null;
      r.unresolved = !nameMap.has(key);
    }
  }

  const canonical = canonRows.map((r) => ({
    key: String(r.key),
    label: r.label == null ? String(r.key) : String(r.label),
    unresolved: !!r.unresolved,
    variants: Number(r.variants),
    fields: Object.fromEntries(
      fields.map((f) => [f.field, r[f.field] == null ? null : String(r[f.field])]),
    ),
  }));

  const rowsRow = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(meta.mapTable)}`,
  ).catch(() => null);
  const values = await scanValues(id, meta);
  const { nameTable, nameIdCol, nameCol, description, color, ...metaOut } = meta;
  const safeColor =
    typeof color === "string" && (PALETTE_NAMES as readonly string[]).includes(color)
      ? (color as PaletteName)
      : null;
  return {
    ...metaOut,
    description: description ?? null,
    color: safeColor,
    rows: Number(rowsRow?.n ?? 0),
    canonical,
    values,
    fields,
  };
}

/** Distinct warehouse values for a dimension WITH provenance, tagged mapped/new
 *  by cross-referencing the Postgres crosswalk. Two-fetch + JS pattern. */
async function scanValues(
  dimId: string,
  meta: Omit<DimensionMeta, "rows"> & {
    nameTable?: string | null;
    nameIdCol?: string | null;
    nameCol?: string | null;
  },
): Promise<MappingValue[]> {
  let sources = await liveSources(dimId);
  if (meta.keyKind === "external_id" && meta.nameTable && meta.nameCol) {
    sources = sources.filter((s) => !(s.table === meta.nameTable && s.column === meta.nameCol));
  }
  if (!sources.length) return [];

  // 1. Warehouse: distinct raw values with provenance + row counts
  const occRows = await all<{ raw: string; tbl: string; col: string; rows: bigint }>(
    occUnion(sources),
  ).catch(() => [] as { raw: string; tbl: string; col: string; rows: bigint }[]);
  if (!occRows.length) return [];

  // Collapse to one row per raw value (UNION ALL → aggregate in JS)
  const occMap = new Map<string, { tbl: string; col: string; rows: number }[]>();
  for (const r of occRows) {
    const key = r.raw.toLowerCase();
    const entry = occMap.get(key) ?? [];
    entry.push({ tbl: r.tbl, col: r.col, rows: Number(r.rows) });
    occMap.set(key, entry);
  }
  // Keep insertion order (first raw string wins as the display value)
  const raws = new Map<string, string>(); // lowercase → original case
  for (const r of occRows) {
    if (!raws.has(r.raw.toLowerCase())) raws.set(r.raw.toLowerCase(), r.raw);
  }

  // 2. Postgres: all mapped raws for this dimension
  const mappedRows = await pgAll<{ raw: string; key: string }>(
    `SELECT raw, ${qid(meta.keyCol)} AS key FROM ${cq(meta.mapTable)}`,
  ).catch(() => [] as { raw: string; key: string }[]);
  const mappedSet = new Map<string, string>(); // lowercase raw → canonical key
  for (const r of mappedRows) mappedSet.set(r.raw.toLowerCase(), r.key);

  // 3. Optionally fetch live canonical names (external_id + warehouse attached)
  const liveName =
    meta.keyKind === "external_id" &&
    env.attachWarehouse &&
    !!meta.nameTable &&
    !!meta.nameIdCol &&
    !!meta.nameCol;
  const nameMap = new Map<string, string>(); // canonical key → display name
  if (liveName) {
    const nameRows = await all<{ id: string; nm: string }>(
      `SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id,
              CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm
       FROM ${whTable(meta.nameTable!)}`,
    ).catch(() => [] as { id: string; nm: string }[]);
    for (const r of nameRows) nameMap.set(r.id, r.nm);
  }

  // 4. Postgres: all canonical labels (slug dims)
  const labelMap = new Map<string, string>(); // canonical key → label
  if (!liveName && meta.keyKind !== "external_id") {
    const dimRows = await pgAll<{ key: string; label: string }>(
      `SELECT ${qid(meta.keyCol)} AS key, label FROM ${cq(meta.dimTable)}`,
    ).catch(() => [] as { key: string; label: string }[]);
    for (const r of dimRows) labelMap.set(r.key, r.label);
  }

  // 5. Build result (unmapped first, then mapped; sorted by row count desc within each group)
  const results: MappingValue[] = [];
  for (const [lowerRaw, raw] of raws) {
    const srcs: SourceOccurrence[] = (occMap.get(lowerRaw) ?? []).map((o) => ({
      table: o.tbl,
      column: o.col,
      rows: o.rows,
    }));
    const canonKey = mappedSet.get(lowerRaw) ?? null;
    const status: "mapped" | "new" = canonKey ? "mapped" : "new";
    const current = canonKey
      ? liveName
        ? (nameMap.get(canonKey) ?? null)
        : (labelMap.get(canonKey) ?? null)
      : null;
    results.push({ value: raw, status, current, suggestion: null, confidence: 0, sources: srcs });
  }
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === "new" ? -1 : 1;
    const aRows = a.sources.reduce((s, x) => s + x.rows, 0);
    const bRows = b.sources.reduce((s, x) => s + x.rows, 0);
    return bRows - aRows;
  });
  return results.slice(0, 500);
}

/** Create a dimension: register it + provision dim_/map_ (Postgres) + register
 *  its warehouse sources. Idempotent on the id. For key_kind 'external_id' the
 *  dim_ label is nullable (names are resolved live from the warehouse, not stored). */
export async function addDimension(
  name: string,
  sources: SourceDef[] = [],
  opts: { keyKind?: "slug" | "external_id"; silent?: boolean } = {},
  userId: string,
): Promise<string> {
  const id = slug(name);
  if (!id) return id;
  const keyKind = opts.keyKind === "external_id" ? "external_id" : "slug";
  const dimTable = `${env.canonicalSchema}.dim_${id}`;
  const mapTable = `${env.canonicalSchema}.map_${id}`;
  const keyCol = `${id}_code`;
  const existing = await pgGet(`SELECT id FROM ${pg("dimension")} WHERE id = $1`, [id]);
  if (!existing) {
    const labelDdl = keyKind === "external_id" ? "label VARCHAR" : "label VARCHAR NOT NULL";
    await pgRun(
      `CREATE TABLE IF NOT EXISTS ${cq(dimTable)} (${qid(keyCol)} VARCHAR PRIMARY KEY, ${labelDdl})`,
    );
    await pgRun(
      `CREATE TABLE IF NOT EXISTS ${cq(mapTable)} (raw VARCHAR PRIMARY KEY, ${qid(keyCol)} VARCHAR NOT NULL)`,
    );
    await pgRun(
      `INSERT INTO ${pg("dimension")} (id, label, dim_table, map_table, key_col, key_kind, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, current_timestamp)`,
      [id, name.trim(), dimTable, mapTable, keyCol, keyKind],
    );
    if (!opts.silent) {
      await appendAuditAs(
        userId,
        "Created dimension",
        `${name.trim()} → dim_${id} + map_${id}${keyKind === "external_id" ? " (external-ID key)" : ""}`,
      );
    }
  }
  for (const s of sources) {
    await pgRun(
      `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column)
       VALUES ($1, $2, $3) ON CONFLICT (dim_id, source_table, source_column) DO NOTHING`,
      [id, s.table, s.column],
    );
  }
  return id;
}

/** Seed canonical values into a dimension's dim_ table (idempotent). */
export async function addCanonical(dimId: string, values: CanonicalValue[]): Promise<void> {
  const meta = await pgGet<{ dimTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
  if (!meta) return;
  for (const v of values) {
    await pgRun(
      `INSERT INTO ${cq(meta.dimTable)} (${qid(meta.keyCol)}, label) VALUES ($1, $2)
       ON CONFLICT (${qid(meta.keyCol)}) DO NOTHING`,
      [v.key, v.label],
    );
  }
}

interface DimMeta {
  dimTable: string;
  mapTable: string;
  keyCol: string;
}
async function dimMeta(dimId: string): Promise<DimMeta | null> {
  return pgGet<DimMeta>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol"
     FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
}

/** Add one canonical record (key derived from the label if not given). */
export async function addCanonicalOne(
  dimId: string,
  label: string,
  key: string | undefined,
  userId: string,
): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const k = (key && slug(key)) || slug(label);
  if (!k) return;
  await pgRun(
    `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1, $2)
     ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
    [k, label],
  );
  await appendAuditAs(userId, "Added canonical", `${label} (${k})`);
}

/** Rename a canonical's display label (the key is stable). */
export async function renameCanonical(
  dimId: string,
  key: string,
  label: string,
  userId: string,
): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  await pgRun(`UPDATE ${cq(m.dimTable)} SET label = $1 WHERE ${qid(m.keyCol)} = $2`, [label, key]);
  await appendAuditAs(userId, "Renamed canonical", `${key} → "${label}"`);
}

/** Merge loser canonicals into a survivor: re-point every crosswalk row, drop the
 *  losers' golden records, audit. The core MDM consolidation step. */
export async function mergeCanonical(
  dimId: string,
  survivor: string,
  losers: string[],
  userId: string,
): Promise<number> {
  const m = await dimMeta(dimId);
  if (!m) return 0;
  const key = qid(m.keyCol);
  const real = losers.filter((l) => l && l !== survivor);
  if (real.length === 0) return 0;

  await pgTx(async (tx) => {
    await tx.run(`UPDATE ${cq(m.mapTable)} SET ${key} = $1 WHERE ${key} = ANY($2::text[])`, [
      survivor,
      real,
    ]);
    await tx.run(`DELETE FROM ${cq(m.dimTable)} WHERE ${key} = ANY($1::text[])`, [real]);
  });

  await appendAuditAs(userId, "Merged canonical", `${real.join(", ")} → ${survivor}`);
  return real.length;
}

/** Retire a canonical — governed: refused while raw variants still map to it. */
export async function retireCanonical(
  dimId: string,
  key: string,
  userId: string,
): Promise<{ ok: boolean; variants: number }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false, variants: 0 };
  const v = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1`,
    [key],
  );
  const variants = Number(v?.n ?? 0);
  if (variants > 0) return { ok: false, variants };
  await pgRun(`DELETE FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`, [key]);
  await appendAuditAs(userId, "Retired canonical", key);
  return { ok: true, variants: 0 };
}

/* ---- enrichment fields (attribute columns on dim_) ---- */
export async function listFields(dimId: string): Promise<FieldDef[]> {
  const rows = await pgAll<{ field: string; label: string; type: string; options: string | null }>(
    `SELECT field, label, type, options FROM ${pg("dimension_field")} WHERE dim_id = $1 ORDER BY created_at`,
    [dimId],
  );
  return rows.map((r) => ({
    field: r.field,
    label: r.label,
    type: r.type,
    options: parseOptions(r.options),
  }));
}

// types must be valid in BOTH DuckDB and the attached Postgres (DDL is forwarded
// to PG): Postgres has no DOUBLE, so number → NUMERIC.
const SQL_TYPE: Record<string, string> = {
  text: "VARCHAR",
  number: "NUMERIC",
  boolean: "BOOLEAN",
  date: "DATE",
};

/** Add an attribute column to a dimension's dim_ table (ALTER TABLE). type ∈
 *  text | number | boolean | date | select. Select columns store an ordered
 *  option list in `dimension_field.options` (JSON); the dim_ column is VARCHAR
 *  (the value IS the option label). */
export async function addField(
  dimId: string,
  label: string,
  type: string = "text",
  options: OptionDef[] | undefined,
  opts: { silent?: boolean } = {},
  userId: string,
): Promise<{ field: string } | null> {
  const m = await dimMeta(dimId);
  if (!m) return null;
  const t = SQL_TYPE[type] ? type : type === "select" ? "select" : "text";
  const field = slug(label);
  if (!field || field === "label" || field === slug(m.keyCol)) return null;
  const sqlType = t === "select" ? "VARCHAR" : SQL_TYPE[t];
  await pgRun(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN IF NOT EXISTS ${qid(field)} ${sqlType}`);
  const optsJson = t === "select" ? JSON.stringify(options ?? []) : null;
  await pgRun(
    `INSERT INTO ${pg("dimension_field")} (dim_id, field, label, type, options, created_at)
     VALUES ($1, $2, $3, $4, $5, current_timestamp) ON CONFLICT (dim_id, field) DO NOTHING`,
    [dimId, field, label.trim(), t, optsJson],
  );
  if (!opts.silent) {
    await appendAuditAs(userId, "Added field", `${label.trim()} (${field}, ${t}) → ${m.dimTable}`);
  }
  return { field };
}

/** Rename a column's display label. The `field` (stable id / DB column name)
 *  stays put; only `label` changes. */
export async function renameColumn(
  dimId: string,
  field: string,
  newLabel: string,
  userId: string,
): Promise<void> {
  const label = newLabel.trim();
  if (!label) return;
  await pgRun(`UPDATE ${pg("dimension_field")} SET label = $1 WHERE dim_id = $2 AND field = $3`, [
    label,
    dimId,
    field,
  ]);
  await appendAuditAs(userId, "Renamed column", `${field} → "${label}"`);
}

/** Change a column's type. Validates that every existing cell value parses to
 *  the new type; returns { ok: false, invalidCount } when N cells would
 *  silently null. Caller decides whether to retry with coerceInvalidToNull. */
export async function changeColumnType(
  dimId: string,
  field: string,
  newType: string,
  options: OptionDef[] | undefined,
  coerceInvalidToNull: boolean = false,
  userId: string,
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false };
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f) return { ok: false };
  const col = qid(field);
  const keyc = qid(m.keyCol);

  const rows = await pgAll<{ k: string; v: string | null }>(
    `SELECT ${keyc} AS k, CAST(${col} AS VARCHAR) AS v FROM ${cq(m.dimTable)}`,
  );

  const parsed: { k: string; v: string | number | boolean | null; bad: boolean }[] = [];
  for (const r of rows) {
    if (r.v == null || r.v === "") {
      parsed.push({ k: r.k, v: null, bad: false });
      continue;
    }
    if (newType === "text") {
      parsed.push({ k: r.k, v: r.v, bad: false });
      continue;
    }
    if (newType === "select") {
      const collected: OptionDef[] =
        options ??
        [...new Set(rows.filter((x) => x.v).map((x) => x.v!))].map((label) => ({
          label,
          color: null,
        }));
      const ok = collected.some((o) => o.label === r.v);
      parsed.push({ k: r.k, v: r.v, bad: !ok });
      continue;
    }
    if (newType === "number") {
      const n = Number(r.v);
      parsed.push({ k: r.k, v: Number.isFinite(n) ? n : null, bad: !Number.isFinite(n) });
      continue;
    }
    if (newType === "boolean") {
      const b = r.v === "true" ? true : r.v === "false" ? false : null;
      parsed.push({ k: r.k, v: b, bad: b == null });
      continue;
    }
    if (newType === "date") {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(r.v);
      parsed.push({ k: r.k, v: ok ? r.v : null, bad: !ok });
      continue;
    }
    parsed.push({ k: r.k, v: r.v, bad: true });
  }

  const invalidCount = parsed.filter((p) => p.bad).length;
  if (invalidCount > 0 && !coerceInvalidToNull) return { ok: false, invalidCount };

  const newSql =
    newType === "select"
      ? "VARCHAR"
      : newType === "number"
        ? "NUMERIC"
        : newType === "boolean"
          ? "BOOLEAN"
          : newType === "date"
            ? "DATE"
            : "VARCHAR";
  const tmp = `${field}__tmp_${Date.now().toString(36)}`;
  let finalOptions: OptionDef[] | undefined;
  if (newType === "select") {
    finalOptions =
      options ??
      [...new Set(parsed.filter((p) => p.v != null).map((p) => String(p.v)))].map((label) => ({
        label,
        color: null,
      }));
  }

  await pgTx(async ({ run }) => {
    await run(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN ${qid(tmp)} ${newSql}`);
    for (const p of parsed) {
      if (p.bad && !coerceInvalidToNull) continue;
      await run(`UPDATE ${cq(m.dimTable)} SET ${qid(tmp)} = $1 WHERE ${keyc} = $2`, [p.v, p.k]);
    }
    await run(`ALTER TABLE ${cq(m.dimTable)} DROP COLUMN ${col}`);
    await run(`ALTER TABLE ${cq(m.dimTable)} RENAME COLUMN ${qid(tmp)} TO ${col}`);
    await run(
      `UPDATE ${pg("dimension_field")} SET type = $1, options = $2 WHERE dim_id = $3 AND field = $4`,
      [newType, newType === "select" ? JSON.stringify(finalOptions ?? []) : null, dimId, field],
    );
  });

  await appendAuditAs(
    userId,
    "Changed column type",
    `${field} → ${newType}${finalOptions ? ` (${finalOptions.length} options)` : ""}`,
  );
  return { ok: true, options: finalOptions };
}

/** Drop a column from the dim_ table AND its row in dimension_field, plus null
 *  the field on every row of the dim. Transactional — all-or-nothing. */
export async function deleteColumn(
  dimId: string,
  field: string,
  userId: string,
): Promise<{ ok: boolean }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false };
  const col = qid(field);
  await pgTx(async ({ run }) => {
    await run(`DELETE FROM ${pg("dimension_field")} WHERE dim_id = $1 AND field = $2`, [
      dimId,
      field,
    ]);
    await run(`ALTER TABLE ${cq(m.dimTable)} DROP COLUMN IF EXISTS ${col}`);
  });
  await appendAuditAs(userId, "Deleted column", field);
  return { ok: true };
}

/* ---- per-user grid layout (column widths / order / hidden) ---- */

export interface GridLayoutConfig {
  widths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
}

export async function getGridLayout(userId: string, dimId: string): Promise<GridLayoutConfig> {
  const row = await pgGet<{ config: string | null }>(
    `SELECT config FROM ${pg("user_grid_layout")} WHERE user_id = $1 AND dim_id = $2`,
    [userId, dimId],
  );
  if (!row?.config) return {};
  try {
    return JSON.parse(row.config) as GridLayoutConfig;
  } catch {
    return {};
  }
}

/** Upsert the full layout config for (user, dim). Caller sends a *complete*
 *  config; partial merging is the client's job (it knows what changed). */
export async function setGridLayout(
  userId: string,
  dimId: string,
  config: GridLayoutConfig,
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("user_grid_layout")} (user_id, dim_id, config, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, dim_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [userId, dimId, JSON.stringify(config)],
  );
}

/** Append a new option to a select column's options list. No-op if the option
 *  already exists (case-sensitive). Returns the resulting options list.
 *  Stored as a JSON string in a VARCHAR column — see drizzle/migrations/0000_baseline.sql for rationale. */
export async function addColumnOption(
  dimId: string,
  field: string,
  label: string,
  color: PaletteName | null = null,
  opts: { silent?: boolean } = {},
  userId: string,
): Promise<{ options: OptionDef[] } | null> {
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f || f.type !== "select") return null;
  const existing = f.options ?? [];
  if (existing.some((o) => o.label === label)) return { options: existing };
  const next: OptionDef[] = [...existing, { label, color }];
  await pgRun(`UPDATE ${pg("dimension_field")} SET options = $1 WHERE dim_id = $2 AND field = $3`, [
    JSON.stringify(next),
    dimId,
    field,
  ]);
  if (!opts.silent) {
    await appendAuditAs(
      userId,
      "Added field option",
      `${field} += "${label}"${color ? ` (${color})` : ""}`,
    );
  }
  return { options: next };
}

/** Set one enrichment field on a canonical record (only registered fields),
 *  cast to the field's declared type. */
export async function setFieldValue(
  dimId: string,
  key: string,
  field: string,
  value: string | null,
): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f) return;
  const col = qid(field);
  const keyc = qid(m.keyCol);
  const empty = value == null || value.trim() === "";
  if (f.type === "number") {
    const n = empty ? null : Number(value);
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [
      Number.isFinite(n as number) ? n : null,
      key,
    ]);
  } else if (f.type === "boolean") {
    const b = value === "true" ? true : value === "false" ? false : null;
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [b, key]);
  } else if (f.type === "date") {
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1::date WHERE ${keyc} = $2`, [
      empty ? null : value!.trim(),
      key,
    ]);
  } else {
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [
      empty ? null : value,
      key,
    ]);
  }
}

/** The raw variants that resolve to a canonical key — the lineage "receipt". */
export async function listVariants(dimId: string, key: string): Promise<string[]> {
  const m = await dimMeta(dimId);
  if (!m) return [];
  const rows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1 ORDER BY raw LIMIT 300`,
    [key],
  );
  return rows.map((r) => r.raw);
}

/* ---- drafts (Postgres) ---- */
export async function listDrafts(dimId: string): Promise<Draft[]> {
  const rows = await pgAll<{
    dimId: string;
    raw: string;
    status: "mapped" | "skipped";
    targetLabel: string | null;
    targetKey: string | null;
    uid: string;
    secs: number;
  }>(
    `SELECT dim_id AS "dimId", raw, status,
            target_label AS "targetLabel", target_key AS "targetKey",
            user_id AS uid,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs
     FROM ${pg("draft")} WHERE dim_id = $1 ORDER BY created_at DESC`,
    [dimId],
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
  }));
}

export async function saveDraft(
  dimId: string,
  raw: string,
  status: "mapped" | "skipped",
  targetLabel: string | null,
  targetKey: string | null,
  userId: string,
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("draft")} (dim_id, raw, status, target_label, target_key, user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp)
     ON CONFLICT (dim_id, raw, user_id) DO UPDATE
       SET status = EXCLUDED.status, target_label = EXCLUDED.target_label,
           target_key = EXCLUDED.target_key, created_at = EXCLUDED.created_at`,
    [dimId, raw, status, targetLabel, targetKey, userId],
  );
}

export async function discardDraft(dimId: string, raw: string, userId: string): Promise<void> {
  await pgRun(`DELETE FROM ${pg("draft")} WHERE dim_id = $1 AND raw = $2 AND user_id = $3`, [
    dimId,
    raw,
    userId,
  ]);
}

/** Approve & commit: fold the dimension's `mapped` drafts into Postgres dim_/map_
 *  in one atomic transaction, then clear them + audit. */
export async function commit(
  dimId: string,
  userId: string,
): Promise<{ committed: number; rowsRecovered: number }> {
  const meta = await pgGet<{ dimTable: string; mapTable: string; keyCol: string; label: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol", label
     FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
  if (!meta) return { committed: 0, rowsRecovered: 0 };
  const key = qid(meta.keyCol);
  const DRAFT = pg("draft");
  const DIMT = cq(meta.dimTable);
  const MAPT = cq(meta.mapTable);

  const approved = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${DRAFT}
     WHERE dim_id = $1 AND status = 'mapped' AND target_key IS NOT NULL`,
    [dimId],
  );
  const committed = Number(approved?.n ?? 0);
  if (!committed) return { committed: 0, rowsRecovered: 0 };

  const rowsRecovered = await rowsForUnmappedDrafts(dimId, meta.mapTable);

  await pgTx(async ({ run }) => {
    await run(
      `INSERT INTO ${DIMT} (${key}, label)
       SELECT DISTINCT d.target_key, d.target_label FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${DIMT} c WHERE c.${key} = d.target_key)`,
      [dimId],
    );
    await run(
      `INSERT INTO ${MAPT} (raw, ${key})
       SELECT d.raw, d.target_key FROM ${DRAFT} d
       WHERE d.dim_id = $1 AND d.status = 'mapped' AND d.target_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${MAPT} m WHERE lower(m.raw) = lower(d.raw))`,
      [dimId],
    );
    await run(`DELETE FROM ${DRAFT} WHERE dim_id = $1 AND status = 'mapped'`, [dimId]);
  });

  await appendAuditAs(
    userId,
    "Committed",
    `${committed} value${committed === 1 ? "" : "s"} → ${meta.mapTable} · ${rowsRecovered.toLocaleString()} rows recovered`,
  );
  return { committed, rowsRecovered };
}

/** Warehouse rows for raws that have a mapped draft but aren't yet in the map. */
async function rowsForUnmappedDrafts(dimId: string, mapTable: string): Promise<number> {
  const sources = await liveSources(dimId);
  if (!sources.length) return 0;

  // Warehouse: distinct raw values with total row counts
  const occRows = await all<{ raw: string; rows: bigint }>(occUnion(sources)).catch(
    () => [] as { raw: string; rows: bigint }[],
  );
  if (!occRows.length) return 0;

  // Postgres: draft raws for this dimension with status=mapped
  const draftRows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${pg("draft")} WHERE dim_id = $1 AND status = 'mapped'`,
    [dimId],
  );
  const draftSet = new Set(draftRows.map((r) => r.raw.toLowerCase()));

  // Postgres: already-mapped raws
  const mappedRows = await pgAll<{ raw: string }>(`SELECT raw FROM ${cq(mapTable)}`).catch(
    () => [] as { raw: string }[],
  );
  const mappedSet = new Set(mappedRows.map((r) => r.raw.toLowerCase()));

  // Sum rows for warehouse values that are in a draft but not yet mapped
  let total = 0;
  for (const r of occRows) {
    const lower = r.raw.toLowerCase();
    if (draftSet.has(lower) && !mappedSet.has(lower)) total += Number(r.rows);
  }
  return total;
}

/* ---- audit (Postgres, append-only) ---- */
export async function appendAuditAs(userId: string, action: string, detail: string): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("audit_log")} (id, created_at, user_id, action, detail)
     VALUES ($1, current_timestamp, $2, $3, $4)`,
    [randomUUID(), userId, action, detail],
  );
}

/* --- workspace-global preferences (single row, id=1) --- */
export interface Preferences {
  publishThreshold: number;
  suggestThreshold: number;
}

export async function getPreferences(): Promise<Preferences> {
  const row = (
    await pgAll<{ publish_threshold: number; suggest_threshold: number }>(
      `SELECT publish_threshold, suggest_threshold FROM ${pg("preferences")} WHERE id = 1`,
    )
  )[0];
  return row
    ? {
        publishThreshold: Number(row.publish_threshold),
        suggestThreshold: Number(row.suggest_threshold),
      }
    : { publishThreshold: 95, suggestThreshold: 80 };
}

export async function setPreferences(p: Preferences): Promise<void> {
  const publish = Math.max(0, Math.min(100, Math.round(p.publishThreshold)));
  const suggest = Math.max(0, Math.min(publish, Math.round(p.suggestThreshold)));
  await pgRun(
    `UPDATE ${pg("preferences")} SET publish_threshold = $1, suggest_threshold = $2, updated_at = current_timestamp WHERE id = 1`,
    [publish, suggest],
  );
}

export async function listAudit(limit = 30): Promise<AuditEntry[]> {
  const rows = await pgAll<{
    id: string;
    uid: string;
    action: string;
    detail: string;
    secs: number;
  }>(
    `SELECT id, user_id AS uid, action, detail,
            EXTRACT(EPOCH FROM (current_timestamp - created_at))::int AS secs
     FROM ${pg("audit_log")} ORDER BY created_at DESC
     LIMIT ${Math.max(1, Math.min(200, limit))}`,
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
    id: r.id,
    user: byId.get(r.uid) ?? unknownUser,
    action: r.action,
    detail: r.detail,
    at: rel(Number(r.secs)),
  }));
}
