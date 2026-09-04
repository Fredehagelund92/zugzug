/* repo-shared.ts — cross-domain types, constants, and low-level helpers used by
 * two or more domain files (repo-scan, repo-record, repo-drafts, repo-meta).
 *
 * Nothing in here imports from any other repo-*.ts module. */

import { pgAll, pgGet } from "./pg.ts";
import { pg } from "./env.ts";
import type { ConditionalRule } from "./conditional-format-types.ts";
import type { Ref } from "./warehouse/adapter.ts";

/* ---- types (mirror app/src/data.ts so the UI consumes them unchanged) ---- */

/** Curated palette token. Mirror of app/src/lib/palette.ts so the server can
 *  validate inbound values without a shared module. */
export type PaletteName =
  | "rose"
  | "amber"
  | "mint"
  | "teal"
  | "indigo"
  | "violet"
  | "slate"
  | "coral"
  | "sky"
  | "lime";
export const PALETTE_NAMES: PaletteName[] = [
  "rose",
  "amber",
  "mint",
  "teal",
  "indigo",
  "violet",
  "slate",
  "coral",
  "sky",
  "lime",
];

export interface OptionDef {
  label: string;
  color: PaletteName | null;
}

/** Read on-disk option JSON in both shapes. Legacy `string[]` lifts to
 *  `[{ label, color: null }]`; the new `{ label, color }` shape passes through.
 *  Non-array / malformed JSON returns `undefined`. */
export function parseOptions(raw: unknown): OptionDef[] | undefined {
  let parsed: unknown = raw;
  if (typeof parsed === "string" && parsed.length > 0) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const arr = (parsed as { options?: unknown }).options;
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
  let parsed: unknown = raw;
  if (typeof parsed === "string" && parsed.length > 0) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = (parsed as { numberFormat?: unknown }).numberFormat;
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

export interface FieldValidation {
  unique?: boolean;
  min?: number | string | null; // number/date: value bound; text: length (int)
  max?: number | string | null;
}

/** A computed ("Formula") field: a read-only column whose value is the
 *  expression evaluated per row. `resultType` is the declared output shape and
 *  drives rendering + the dim_ output type. The formula stores no value. */
export interface FormulaConfig {
  expr: string;
  resultType: "text" | "number" | "boolean";
  numberFormat?: NumberFormat; // only meaningful when resultType === "number"
}

export function parseFieldConfig(
  type: string,
  raw: unknown,
): {
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedRefTableId?: string;
  displayFields?: string[];
  rules?: ConditionalRule[];
  required?: boolean;
  validation?: FieldValidation;
  formula?: FormulaConfig;
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
    referencedRefTableId?: string;
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
    const cfg = parsedJson as { targetRefTableId?: unknown; displayFields?: unknown } | null;
    const referencedRefTableId =
      typeof cfg?.targetRefTableId === "string" ? cfg.targetRefTableId : undefined;
    const displayFields = Array.isArray(cfg?.displayFields)
      ? (cfg.displayFields as unknown[]).filter((s): s is string => typeof s === "string")
      : ["label"];
    typeSpecific = { referencedRefTableId, displayFields };
  }

  // Extract rules (allowed alongside any type-specific config)
  const rules =
    parsedJson != null && Array.isArray(parsedJson.rules)
      ? (parsedJson.rules as ConditionalRule[])
      : undefined;

  // Required flag — allowed on any type (empty values block publish).
  const required = parsedJson?.required === true;

  // Validation rules — allowed on any type; per-key sanitized so a malformed
  // blob can never crash a read. An empty {} means "object present, no live rules".
  let validation: FieldValidation | undefined;
  const rawV = parsedJson?.validation;
  if (rawV != null && typeof rawV === "object" && !Array.isArray(rawV)) {
    const v = rawV as Record<string, unknown>;
    const out: FieldValidation = {};
    if (v.unique === true) out.unique = true;
    const bound = (x: unknown): number | string | null | undefined => {
      if (x === null) return null;
      if (typeof x === "number" && Number.isFinite(x)) {
        // text length bounds must be non-negative integers
        if (type === "text") return Math.max(0, Math.floor(x));
        return x;
      }
      if (typeof x === "string" && x.trim() !== "" && type === "date") return x; // ISO date bound
      return undefined;
    };
    const mn = bound(v.min);
    const mx = bound(v.max);
    if (mn !== undefined) out.min = mn;
    if (mx !== undefined) out.max = mx;
    validation = out;
  }

  // Formula config — only on computed fields; stores the expression + declared
  // output type. Values are never stored, so there is no type-specific column.
  let formula: FormulaConfig | undefined;
  if (type === "formula" && parsedJson) {
    const expr = parsedJson.expr;
    if (typeof expr === "string" && expr.trim() !== "") {
      const rt = parsedJson.resultType;
      const resultType = rt === "number" || rt === "boolean" ? rt : "text";
      const numberFormat = resultType === "number" ? parseNumberFormat(parsedJson) : undefined;
      formula = { expr, resultType, ...(numberFormat ? { numberFormat } : {}) };
    }
  }

  return {
    ...typeSpecific,
    ...(rules !== undefined ? { rules } : {}),
    ...(required ? { required: true } : {}),
    ...(validation !== undefined ? { validation } : {}),
    ...(formula !== undefined ? { formula } : {}),
  };
}

export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedRefTableId?: string; // only when type === "linked"
  displayFields?: string[]; // fields from target refTable to surface as lookup cols
  description?: string;
  rules?: ConditionalRule[];
  required?: boolean; // empty values block publish
  validation?: FieldValidation;
  formula?: FormulaConfig; // only when type === "formula" (read-only computed column)
}

export type { ConditionalRule } from "./conditional-format-types.ts";
export interface RecordValue {
  key: string;
  label: string;
  variants?: number;
  fields?: Record<string, string | null>;
  unresolved?: boolean;
  position?: string | null; // JSON-safe bigint string; null in derived mode
  /** Per-field message when a Formula column can't be computed for this record
   *  (keyed by field id). Absent when every formula computed cleanly. */
  formulaErrors?: Record<string, string>;
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
export interface RefTableMeta {
  id: string;
  refTable: string;
  dimTable: string;
  mapTable: string;
  keyCol: string;
  rows: number;
  keyKind: "slug" | "external_id";
  orderingMode: "derived" | "manual";
}
/** A registered warehouse source column for a refTable, with best-effort counts.
 *  `present` = the table is reachable in the warehouse (false when missing or the
 *  warehouse isn't attached); counts are 0 when empty/unreachable. Always returned
 *  so the UI can show the wiring even before any data lands. */
export interface SourceInfo {
  /** warehouse_database.id the column was registered against. */
  databaseId: string;
  /** Its database_name — two databases can hold the same schema.table.column. */
  databaseName: string;
  table: string;
  column: string;
  refTable: string;
  refTableId: string;
  present: boolean;
  rows: number;
  values: number;
  unmapped: number;
  scanned: boolean;
  /** Why the last scan failed, or null when it reached the warehouse. A failed
   *  scan says nothing about whether the column exists. */
  scanError: string | null;
  schedule?: string | null; // null | 'hourly' | 'daily'
  scannedAt?: string | null; // ISO timestamp of last scan
}
export interface SchemaFacet {
  schema: string;
  columns: number;
  unmapped: number;
  missing: number;
}
/** Compact per-table publish state for the refTable list (ADR-0005). The
 *  count-only sibling of PublishState — the dashboard needs the size of the
 *  delta, not the keys. changedRecords = PublishState.changedKeys.length. */
export interface PublishSummary {
  version: number; // 0 = never published
  publishedAt: string | null;
  publishedByName: string | null;
  pendingDrafts: number;
  changedRecords: number;
}
export interface MappingRefTable extends RefTableMeta {
  description: string | null;
  color: PaletteName | null;
  ownerUserId: string | null;
  ownerName: string | null;
  nextPosition: string | null;
  record: RecordValue[];
  counts: {
    newCount: number;
    mappedCount: number;
    totalDistinct: number;
    unmappedRowsTotal: number;
    mappedRowsTotal: number;
    scannedAt: string | null;
  };
  fields: FieldDef[];
  /** Per-table publish summary (ADR-0005). Present only on the ?full=true list. */
  publish?: PublishSummary;
}
export interface Draft {
  refTableId: string;
  raw: string;
  status: "mapped" | "skipped" | "rejected";
  targetLabel: string | null;
  targetKey: string | null;
  user: User;
  at: string;
  /** ISO creation timestamp. The draft key is (table, value, author), so the
   *  client needs the real ordering to reproduce the newest-wins fold publish
   *  applies — `at` is a display string ("5m ago") and can't be sorted. */
  createdAt: string;
  source: "user" | "ai";
  confidence: "high" | "medium" | "low" | null;
  reasoning: string | null;
  rejectedReason: string | null;
  rejectedBy: string | null;
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

/** The pg driver hands the `audit_log.metadata` jsonb column back as a raw
 *  string; parse it so API consumers get a real object (the history drawer reads
 *  metadata.before/after, and the activity feed expands it as key/value). */
export function parseJsonbMeta(m: unknown): Record<string, unknown> | null {
  if (m == null) return null;
  if (typeof m === "string") {
    try {
      return JSON.parse(m) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return m as Record<string, unknown>;
}
export interface FilterSetConfig {
  conjunction: "and" | "or";
  conditions: Array<{ id: string; field: string; operator: string; value: string }>;
}
export interface GridLayoutConfig {
  widths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
  sort?: { column: string; direction: "asc" | "desc" } | null;
  filterSet?: FilterSetConfig | null;
}
export interface Preferences {
  scanSchedule: "hourly" | "daily" | null;
  requireSecondPublisher: boolean;
  autoPublishEnabled: boolean;
}

/* ---- shared helpers ---- */

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** record table: display 'zugzug.dim_country' → '"zugzug"."dim_country"' (2-part Postgres). */
export const cq = (display: string) => display.split(".").map(qid).join(".");

/** Escape ILIKE wildcards so a search for "100%" or "a_b" means those
 *  characters, not "anything". Backslash is Postgres' default LIKE escape. */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

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
  /** Convenience "schema.table" — for display and audit; queries should use refOf(s) instead. */
  table: string;
  column: string;
  /** Warehouse catalog (database_name from the warehouse_database registration). */
  databaseName: string;
  /** Schema part of `table`. */
  schemaName: string;
  /** Table part of `table`. */
  tableName: string;
}

/** Adapter Ref derived from a registered source — carries the catalog so
 *  qualifyRef can never fall back to a stale env default. */
export function refOf(s: { databaseName: string; schemaName: string; tableName: string }): Ref {
  return { catalog: s.databaseName, schema: s.schemaName, table: s.tableName };
}

/** Resolve an adapter Ref for a bare 'schema.table' string by looking up the
 *  warehouse catalog from a reference_table_source row that already registered
 *  this (refTable, schema, table). Used for nameTable / topUnmapped / similar
 *  where the caller has a stored string.
 *
 *  Pass databaseId whenever the caller knows it: the same schema.table can be
 *  registered against two databases, and picking the wrong one reads the wrong
 *  warehouse. Without it the lowest database_id wins — arbitrary but stable, so
 *  the answer does not change between identical calls. */
export async function refForRegisteredTable(
  refTableId: string,
  stored: string,
  tenantId: string,
  databaseId?: string,
): Promise<Ref | null> {
  const parts = stored.split(".");
  if (parts.length !== 2) return null;
  const row = await pgGet<{ catalog: string }>(
    `SELECT wd.database_name AS "catalog"
       FROM ${pg("reference_table_source")} s
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
      WHERE s.tenant_id = $1 AND s.reference_table_id = $2
        AND s.schema_name = $3 AND s.table_name = $4${databaseId ? ` AND s.database_id = $5` : ""}
      ORDER BY s.database_id
      LIMIT 1`,
    databaseId
      ? [tenantId, refTableId, parts[0], parts[1], databaseId]
      : [tenantId, refTableId, parts[0], parts[1]],
  );
  return row ? { catalog: row.catalog, schema: parts[0], table: parts[1] } : null;
}

export interface RefTableBasics {
  dimTable: string;
  mapTable: string;
  keyCol: string;
  orderingMode: "derived" | "manual";
}

export async function sourcesOf(refTableId: string, tenantId: string): Promise<SourceDef[]> {
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
       FROM ${pg("reference_table_source")} s
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
      WHERE s.reference_table_id = $1 AND s.tenant_id = $2
      ORDER BY 1, 2, 3, 4`,
    [refTableId, tenantId],
  );
  return rows.map((r) => ({
    table: `${r.schemaName}.${r.tableName}`,
    column: r.columnName,
    databaseName: r.databaseName,
    schemaName: r.schemaName,
    tableName: r.tableName,
  }));
}

/** Keep only sources whose warehouse table actually resolves — a refTable
 *  registered against tables absent in the relevant warehouse_database still
 *  scans the rest instead of throwing. */
export async function liveSources(refTableId: string, tenantId: string): Promise<SourceDef[]> {
  const { getAdapter } = await import("./warehouse/registry.ts");
  const adapter = await getAdapter();
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
       FROM ${pg("reference_table_source")} s
       JOIN ${pg("warehouse_database")} wd ON wd.id = s.database_id
      WHERE s.tenant_id = $1 AND s.reference_table_id = $2
      ORDER BY 1, 2, 3, 4`,
    [tenantId, refTableId],
  );
  const out: SourceDef[] = [];
  for (const r of rows) {
    const ref: Ref = { catalog: r.databaseName, schema: r.schemaName, table: r.tableName };
    const displayTable = `${r.schemaName}.${r.tableName}`;
    try {
      if (await adapter.tableExists(ref)) {
        out.push({
          table: displayTable,
          column: r.columnName,
          databaseName: r.databaseName,
          schemaName: r.schemaName,
          tableName: r.tableName,
        });
      } else {
        console.warn(`scan: skipping missing source ${r.databaseName}.${displayTable}`);
      }
    } catch {
      console.warn(`scan: skipping missing source ${r.databaseName}.${displayTable}`);
    }
  }
  return out;
}

export async function refTableMeta(
  refTableId: string,
  tenantId: string,
): Promise<RefTableBasics | null> {
  return pgGet<RefTableBasics>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
            COALESCE(ordering_mode, 'derived') AS "orderingMode"
     FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
}

// re-export lower-level modules so domain files can import just from repo-shared
export { pgAll, pgGet, pgRun, pgTx } from "./pg.ts";
export { env, pg } from "./env.ts";
export { log } from "./log.ts";
