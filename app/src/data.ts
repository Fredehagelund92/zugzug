/* data.ts — typed mock fixtures for Zug Zug (no backend).

   The app matches messy SOURCE VALUES (found across many warehouse tables) to one
   MASTER record, and commits the result to DuckDB: a `dim_*` master table + a
   `map_*` lookup table. The hard part is the constant stream of NEW values that
   would otherwise silently resolve to NULL downstream. */

import type { PaletteName } from "./lib/palette";
export type { PaletteName } from "./lib/palette";

/* a master record: the human label + the key written to the dim/map tables, how
   many raw values resolve to it, and any enrichment attribute values */
export interface CanonicalValue {
  key: string;
  label: string;
  version: number; // server-managed; client passes it back on mutations
  variants?: number;
  fields?: Record<string, string | null>;
  unresolved?: boolean;
  position?: string | null;
}
/** A predetermined option on a single-select field, with optional color. */
export interface OptionDef {
  label: string;
  color: PaletteName | null;
}

export type NumberFormat =
  | { format: "integer" }
  | { format: "decimal"; precision: 1 | 2 | 3 | 4 }
  | { format: "percent"; precision: 0 | 1 | 2 }
  | { format: "currency"; symbol: string; position: "prefix" | "suffix"; precision: 0 | 1 | 2 }
  | { format: "compact"; precision: 0 | 1 | 2 }
  | { format: "duration"; display: "hm" | "hms" };
/* an enrichment attribute column on a dimension (e.g. currency, locale) */
export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedDimId?: string;
  displayFields?: string[];
  description?: string;
  rules?: import("./components/datagrid/types").ConditionalRule[];
  required?: boolean;
  validation?: { unique?: boolean; min?: number | string | null; max?: number | string | null };
}
/* where a raw value was seen in the warehouse (table.column + row impact) */
export interface SourceOccurrence {
  table: string;
  column: string;
  rows: number;
}

export interface MappingValue {
  value: string; // the raw source value (multilingual, codes, emoji, typos)
  status: "mapped" | "new"; // already in the map table, or freshly discovered
  current: string | null; // master label already mapped (when mapped)
  suggestion: string | null; // AI-proposed master label (for new values)
  confidence: number;
  firstSeen?: string;
  sources: SourceOccurrence[]; // every source table.column it appears in
}

export interface MappingDimension {
  id: string;
  dimension: string; // human label
  dimTable: string; // DuckDB master table, e.g. zugzug.dim_country
  mapTable: string; // DuckDB lookup table, e.g. zugzug.map_country
  keyCol: string; // master key column written to both
  keyKind?: "slug" | "external_id"; // 'external_id' → key is a warehouse ID, name resolved live
  /** Optional human description shown under the name in TablePicker. */
  description?: string | null;
  /** Curated palette token for the monogram. null = fall back to --accent. */
  color?: PaletteName | null;
  /** Workspace member accountable for this reference table. */
  ownerUserId?: string | null;
  ownerName?: string | null;
  rows: number; // rows already in the map table
  canonical: CanonicalValue[];
  counts: {
    /** distinct raw values seen in scan that aren't in the map table */
    newCount: number;
    /** distinct raw values already in the map table */
    mappedCount: number;
    /** newCount + mappedCount */
    totalDistinct: number;
    /** SUM(total_rows) for unmapped values (warehouse rows currently NULL downstream) */
    unmappedRowsTotal: number;
    /** SUM(total_rows) for mapped values */
    mappedRowsTotal: number;
    /** ISO timestamp of the most recent scan that produced these counts */
    scannedAt: string | null;
  };
  fields?: FieldDef[]; // enrichment attribute columns
  orderingMode?: "derived" | "manual";
  nextPosition?: string | null;
  /** Per-table publish summary from ?full=true (ADR-0005). */
  publish?: {
    version: number; // 0 = never published
    publishedAt: string | null;
    publishedByName: string | null;
    pendingDrafts: number;
    changedRecords: number;
  } | null;
}

const rowsOf = (s: SourceOccurrence[]) => s.reduce((n, o) => n + o.rows, 0);
export const valueRows = (v: MappingValue) => rowsOf(v.sources);

export const mappingSeeds: MappingDimension[] = [
  {
    id: "country",
    dimension: "Country",
    dimTable: "zugzug.dim_country",
    mapTable: "zugzug.map_country",
    keyCol: "country_code",
    rows: 4421,
    counts: {
      newCount: 7,
      mappedCount: 2,
      totalDistinct: 9,
      unmappedRowsTotal: 6951,
      mappedRowsTotal: 182600,
      scannedAt: null,
    },
    canonical: [
      { key: "US", label: "United States", version: 1 },
      { key: "GB", label: "United Kingdom", version: 1 },
      { key: "NO", label: "Norway", version: 1 },
      { key: "SE", label: "Sweden", version: 1 },
      { key: "DE", label: "Germany", version: 1 },
      { key: "FR", label: "France", version: 1 },
      { key: "NL", label: "Netherlands", version: 1 },
      { key: "BD", label: "Bangladesh", version: 1 },
      { key: "GP", label: "Guadeloupe", version: 1 },
    ],
  },
  {
    id: "state",
    dimension: "US State",
    dimTable: "zugzug.dim_us_state",
    mapTable: "zugzug.map_us_state",
    keyCol: "state_code",
    rows: 76,
    counts: {
      newCount: 5,
      mappedCount: 2,
      totalDistinct: 7,
      unmappedRowsTotal: 10816,
      mappedRowsTotal: 10210,
      scannedAt: null,
    },
    canonical: [
      { key: "CA", label: "California", version: 1 },
      { key: "AK", label: "Alaska", version: 1 },
      { key: "AZ", label: "Arizona", version: 1 },
      { key: "AR", label: "Arkansas", version: 1 },
      { key: "AL", label: "Alabama", version: 1 },
      { key: "NY", label: "New York", version: 1 },
      { key: "BC", label: "Baja California", version: 1 },
    ],
  },
  {
    id: "post_type",
    dimension: "Sprout post type",
    dimTable: "zugzug.dim_post_type",
    mapTable: "zugzug.map_sprout_post_type",
    keyCol: "post_type",
    rows: 44,
    counts: {
      newCount: 5,
      mappedCount: 2,
      totalDistinct: 7,
      unmappedRowsTotal: 11880,
      mappedRowsTotal: 60000,
      scannedAt: null,
    },
    canonical: [
      { key: "tweet", label: "Tweet", version: 1 },
      { key: "retweet", label: "Retweet", version: 1 },
      { key: "twitter_mention", label: "Twitter Mention", version: 1 },
      { key: "fb_post", label: "Regular FB Post", version: 1 },
      { key: "ig_media", label: "IG Media", version: 1 },
      { key: "tiktok_video", label: "Tiktok Video", version: 1 },
      { key: "story", label: "Story", version: 1 },
    ],
  },
];
