/* repo-shared.ts — cross-domain types, constants, and low-level helpers used by
 * two or more domain files (repo-scan, repo-canonical, repo-drafts, repo-meta).
 *
 * Nothing in here imports from any other repo-*.ts module. */

import { pgAll, pgGet } from "./pg.ts";
import { pg } from "./env.ts";
import type { ConditionalRule } from "./conditional-format-types.ts";
import type { Ref } from "./warehouse/adapter.ts";

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
  // Support both the legacy bare-array format ("[{...}]") and the merged-object
  // format ("{\"options\":[...]}") produced by the server-side merge path.
  if (arr != null && typeof arr === "object" && !Array.isArray(arr) && "options" in arr) {
    arr = (arr as { options: unknown }).options;
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
  // Support the merged-object format ("{\"numberFormat\":{...}}") produced by
  // the server-side merge path alongside the legacy direct-object format.
  if (obj != null && typeof obj === "object" && !Array.isArray(obj) && "numberFormat" in obj) {
    obj = (obj as { numberFormat: unknown }).numberFormat;
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
): {
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedDimId?: string;
  displayFields?: string[];
  rules?: ConditionalRule[];
} {
  // Parse the raw JSON once for rules extraction (type-specific parsers re-parse as needed)
  let parsedJson: Record<string, unknown> | null = null;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      parsedJson = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  } else if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    parsedJson = raw as Record<string, unknown>;
  }

  let typeSpecific: {
    options?: OptionDef[];
    numberFormat?: NumberFormat;
    ratingMax?: number;
    referencedDimId?: string;
    displayFields?: string[];
  } = {};

  if (type === "select") {
    typeSpecific = { options: parseOptions(raw) };
  } else if (type === "number") {
    typeSpecific = { numberFormat: parseNumberFormat(raw) };
  } else if (type === "rating") {
    const max = parsedJson?.ratingMax;
    typeSpecific = { ratingMax: typeof max === "number" && max >= 1 ? max : 5 };
  } else if (type === "linked") {
    const cfg = parsedJson as { targetDimId?: unknown; displayFields?: unknown } | null;
    const referencedDimId = typeof cfg?.targetDimId === "string" ? cfg.targetDimId : undefined;
    const displayFields = Array.isArray(cfg?.displayFields)
      ? (cfg.displayFields as unknown[]).filter((s): s is string => typeof s === "string")
      : ["label"];
    typeSpecific = { referencedDimId, displayFields };
  }

  // Extract rules (allowed alongside any type-specific config)
  const rules =
    parsedJson != null && Array.isArray(parsedJson.rules)
      ? (parsedJson.rules as ConditionalRule[])
      : undefined;

  return rules !== undefined ? { ...typeSpecific, rules } : typeSpecific;
}

export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedDimId?: string; // only when type === "linked"
  displayFields?: string[]; // fields from target dim to surface as lookup cols
  description?: string;
  rules?: ConditionalRule[];
}

export type { ConditionalRule } from "./conditional-format-types.ts";
export interface CanonicalValue {
  key: string;
  label: string;
  variants?: number;
  fields?: Record<string, string | null>;
  unresolved?: boolean;
  position?: string | null;   // JSON-safe bigint string; null in derived mode
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
  orderingMode: "derived" | "manual";
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
  source: "user" | "ai";
  confidence: "high" | "medium" | "low" | null;
  reasoning: string | null;
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
  metadata: Record<string, unknown> | null;
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
  orderingMode: "derived" | "manual";
}

export async function sourcesOf(dimId: string, tenantId: string): Promise<SourceDef[]> {
  return pgAll<SourceDef>(
    `SELECT source_table AS "table", source_column AS column FROM ${pg("dimension_source")} WHERE dim_id = $1 AND tenant_id = $2 ORDER BY 1,2`,
    [dimId, tenantId],
  );
}

/** Parse a stored 'schema.table' (or 'table') string into the adapter's Ref. */
export function parseSourceTable(stored: string): Ref {
  const parts = stored.split(".");
  if (parts.length === 3) return { catalog: parts[0], schema: parts[1], table: parts[2] };
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  return { schema: "main", table: stored };
}

/** Keep only sources whose warehouse table actually resolves — a dimension
 *  registered against tables absent in this WAREHOUSE_DB (e.g. raw_dev vs
 *  raw_prod) still scans the rest instead of throwing. */
export async function liveSources(dimId: string, tenantId: string): Promise<SourceDef[]> {
  const { getAdapter } = await import("./warehouse/registry.ts");
  const adapter = await getAdapter(tenantId);
  const rows = await pgAll<{
    databaseName: string;
    schemaName: string;
    tableName: string;
    columnName: string;
  }>(
    `SELECT wd.database_name AS "databaseName",
            s.schema_name    AS "schemaName",
            s.table_name     AS "tableName",
            s.column_name    AS "columnName"
       FROM ${pg("dimension_source")} s
       JOIN ${pg("warehouse_database")} wd
         ON wd.id = s.database_id AND wd.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.dim_id = $2
      ORDER BY 1, 2, 3, 4`,
    [tenantId, dimId],
  );
  const out: SourceDef[] = [];
  for (const r of rows) {
    const ref: Ref = { catalog: r.databaseName, schema: r.schemaName, table: r.tableName };
    const displayTable = `${r.schemaName}.${r.tableName}`;
    try {
      if (await adapter.tableExists(ref)) {
        out.push({ table: displayTable, column: r.columnName });
      } else {
        console.warn(`scan: skipping missing source ${r.databaseName}.${displayTable}`);
      }
    } catch {
      console.warn(`scan: skipping missing source ${r.databaseName}.${displayTable}`);
    }
  }
  return out;
}

export async function dimMeta(dimId: string, tenantId: string): Promise<DimMeta | null> {
  return pgGet<DimMeta>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(ordering_mode, 'derived') AS "orderingMode"
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
}

// re-export lower-level modules so domain files can import just from repo-shared
export { pgAll, pgGet, pgRun, pgTx } from "./pg.ts";
export { env, pg } from "./env.ts";
export { log } from "./log.ts";
