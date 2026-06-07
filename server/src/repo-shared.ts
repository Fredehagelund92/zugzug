/* repo-shared.ts — cross-domain types, constants, and low-level helpers used by
 * two or more domain files (repo-scan, repo-canonical, repo-drafts, repo-meta).
 *
 * Nothing in here imports from any other repo-*.ts module. */

import { run } from "./db.ts";
import { pgAll, pgGet } from "./pg.ts";
import { env, pg } from "./env.ts";

/* ---- types (mirror app/src/data.ts so the UI consumes them unchanged) ---- */

/** Curated palette token. Mirror of app/src/lib/palette.ts so the server can
 *  validate inbound values without a shared module. */
export type PaletteName = "rose" | "amber" | "mint" | "teal" | "indigo" | "violet" | "slate";
export const PALETTE_NAMES: PaletteName[] = [
  "rose",
  "amber",
  "mint",
  "teal",
  "indigo",
  "violet",
  "slate",
];

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

export type NumberFormat =
  | { format: "integer" }
  | { format: "decimal"; precision: 1 | 2 | 3 | 4 }
  | { format: "percent"; precision: 0 | 1 | 2 }
  | { format: "currency"; symbol: string; position: "prefix" | "suffix"; precision: 0 | 1 | 2 }
  | { format: "compact"; precision: 0 | 1 | 2 }
  | { format: "duration"; display: "hm" | "hms" };

const VALID_FORMATS = ["integer", "decimal", "percent", "currency", "compact", "duration"];

export function parseNumberFormat(raw: unknown): NumberFormat | undefined {
  let obj: unknown = raw;
  if (typeof obj === "string" && obj.length > 0) {
    try {
      obj = JSON.parse(obj);
    } catch {
      return undefined;
    }
  }
  if (
    obj == null ||
    typeof obj !== "object" ||
    Array.isArray(obj) ||
    !VALID_FORMATS.includes((obj as { format?: unknown }).format as string)
  ) {
    return undefined;
  }
  return obj as NumberFormat;
}

export function parseFieldConfig(
  type: string,
  raw: unknown,
): { options?: OptionDef[]; numberFormat?: NumberFormat; ratingMax?: number; referencedDimId?: string; displayFields?: string[] } {
  if (type === "select") return { options: parseOptions(raw) };
  if (type === "number") return { numberFormat: parseNumberFormat(raw) };
  if (type === "rating") {
    let obj: unknown = raw;
    if (typeof obj === "string" && obj.length > 0) {
      try { obj = JSON.parse(obj); } catch { return { ratingMax: 5 }; }
    }
    const max = (obj as { ratingMax?: unknown } | null)?.ratingMax;
    return { ratingMax: typeof max === "number" && max >= 1 ? max : 5 };
  }
  if (type === "linked") {
    let obj: unknown = raw;
    if (typeof obj === "string" && obj.length > 0) {
      try { obj = JSON.parse(obj); } catch { return {}; }
    }
    const cfg = obj as { targetDimId?: unknown; displayFields?: unknown } | null;
    const referencedDimId =
      typeof cfg?.targetDimId === "string" ? cfg.targetDimId : undefined;
    const displayFields = Array.isArray(cfg?.displayFields)
      ? (cfg.displayFields as unknown[]).filter((s): s is string => typeof s === "string")
      : ["label"];
    return { referencedDimId, displayFields };
  }
  return {};
}

export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedDimId?: string;  // only when type === "linked"
  displayFields?: string[];  // fields from target dim to surface as lookup cols
  description?: string;
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
export interface GridLayoutConfig {
  widths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
}
export interface Preferences {
  publishThreshold: number;
  suggestThreshold: number;
  scanSchedule: "15m" | "hourly" | "daily" | null;
}

/* ---- shared helpers ---- */

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** 'schema.table' (or 'table') → fully-qualified warehouse identifier (MotherDuck). */
export const whTable = (sourceTable: string) =>
  `${qid(env.warehouseDb)}.` + sourceTable.split(".").map(qid).join(".");

/** canonical table: display 'zugzug.dim_country' → '"zugzug"."dim_country"' (2-part Postgres). */
export const cq = (display: string) => display.split(".").map(qid).join(".");

export const rel = (secs: number): string => {
  if (secs < 45) return "just now";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
};

export interface SourceDef {
  table: string;
  column: string;
}

export interface DimMeta {
  dimTable: string;
  mapTable: string;
  keyCol: string;
}

export async function sourcesOf(dimId: string): Promise<SourceDef[]> {
  return pgAll<SourceDef>(
    `SELECT source_table AS "table", source_column AS column FROM ${pg("dimension_source")} WHERE dim_id = $1 ORDER BY 1,2`,
    [dimId],
  );
}

/** Keep only sources whose warehouse table actually resolves — a dimension
 *  registered against tables absent in this WAREHOUSE_DB (e.g. raw_dev vs
 *  raw_prod) still scans the rest instead of throwing. */
export async function liveSources(dimId: string): Promise<SourceDef[]> {
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

const esc = (s: string) => s.replace(/'/g, "''");

/** One UNION-ALL branch per source: distinct raw value + provenance + row count. */
export function occUnion(sources: SourceDef[]): string {
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

export async function dimMeta(dimId: string): Promise<DimMeta | null> {
  return pgGet<DimMeta>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol"
     FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
}

// re-export lower-level modules so domain files can import just from repo-shared
export { all, get, run } from "./db.ts";
export { pgAll, pgGet, pgRun, pgTx } from "./pg.ts";
export { env, pg } from "./env.ts";
export { log } from "./log.ts";
