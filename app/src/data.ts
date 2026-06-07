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
  variants?: number;
  fields?: Record<string, string | null>;
  unresolved?: boolean;
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
  rows: number; // rows already in the map table
  canonical: CanonicalValue[];
  values: MappingValue[];
  fields?: FieldDef[]; // enrichment attribute columns
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
    canonical: [
      { key: "US", label: "United States" },
      { key: "GB", label: "United Kingdom" },
      { key: "NO", label: "Norway" },
      { key: "SE", label: "Sweden" },
      { key: "DE", label: "Germany" },
      { key: "FR", label: "France" },
      { key: "NL", label: "Netherlands" },
      { key: "BD", label: "Bangladesh" },
      { key: "GP", label: "Guadeloupe" },
    ],
    values: [
      {
        value: "United States",
        status: "mapped",
        current: "United States",
        suggestion: null,
        confidence: 0,
        sources: [
          { table: "ga4.sessions", column: "country", rows: 96400 },
          { table: "stripe.charges", column: "billing_country", rows: 32000 },
        ],
      },
      {
        value: "GB",
        status: "mapped",
        current: "United Kingdom",
        suggestion: null,
        confidence: 0,
        sources: [{ table: "ga4.sessions", column: "country", rows: 54200 }],
      },
      {
        value: "🇺🇸",
        status: "new",
        current: null,
        suggestion: "United States",
        confidence: 93,
        firstSeen: "2d ago",
        sources: [
          { table: "shopify.orders", column: "ship_country", rows: 2100 },
          { table: "stripe.charges", column: "billing_country", rows: 1020 },
        ],
      },
      {
        value: "Estados Unidos",
        status: "new",
        current: null,
        suggestion: "United States",
        confidence: 88,
        firstSeen: "2d ago",
        sources: [{ table: "salesforce.account", column: "billing_country", rows: 1840 }],
      },
      {
        value: "America",
        status: "new",
        current: null,
        suggestion: "United States",
        confidence: 72,
        firstSeen: "5d ago",
        sources: [{ table: "hubspot.contacts", column: "country", rows: 910 }],
      },
      {
        value: "Norge",
        status: "new",
        current: null,
        suggestion: "Norway",
        confidence: 84,
        firstSeen: "1d ago",
        sources: [{ table: "stripe.charges", column: "billing_country", rows: 611 }],
      },
      {
        value: "Vereinigte Staaten",
        status: "new",
        current: null,
        suggestion: "United States",
        confidence: 69,
        firstSeen: "5d ago",
        sources: [{ table: "salesforce.account", column: "billing_country", rows: 240 }],
      },
      {
        value: "বাংলাদেশ",
        status: "new",
        current: null,
        suggestion: "Bangladesh",
        confidence: 95,
        firstSeen: "3h ago",
        sources: [{ table: "shopify.orders", column: "ship_country", rows: 188 }],
      },
      {
        value: "971",
        status: "new",
        current: null,
        suggestion: "Guadeloupe",
        confidence: 40,
        firstSeen: "3h ago",
        sources: [{ table: "netsuite.customers", column: "billaddr_country", rows: 42 }],
      },
    ],
  },
  {
    id: "state",
    dimension: "US State",
    dimTable: "zugzug.dim_us_state",
    mapTable: "zugzug.map_us_state",
    keyCol: "state_code",
    rows: 76,
    canonical: [
      { key: "CA", label: "California" },
      { key: "AK", label: "Alaska" },
      { key: "AZ", label: "Arizona" },
      { key: "AR", label: "Arkansas" },
      { key: "AL", label: "Alabama" },
      { key: "NY", label: "New York" },
      { key: "BC", label: "Baja California" },
    ],
    values: [
      {
        value: "California",
        status: "mapped",
        current: "California",
        suggestion: null,
        confidence: 0,
        sources: [{ table: "salesforce.account", column: "billing_state", rows: 9800 }],
      },
      {
        value: "Baja California",
        status: "mapped",
        current: "Baja California",
        suggestion: null,
        confidence: 0,
        sources: [{ table: "shopify.orders", column: "ship_province", rows: 410 }],
      },
      {
        value: "CA",
        status: "new",
        current: null,
        suggestion: "California",
        confidence: 96,
        firstSeen: "1d ago",
        sources: [
          { table: "ga4.sessions", column: "region", rows: 5200 },
          { table: "stripe.charges", column: "card_state", rows: 2000 },
        ],
      },
      {
        value: "N.Y.",
        status: "new",
        current: null,
        suggestion: "New York",
        confidence: 88,
        firstSeen: "1d ago",
        sources: [{ table: "hubspot.contacts", column: "state", rows: 2100 }],
      },
      {
        value: "New York State",
        status: "new",
        current: null,
        suggestion: "New York",
        confidence: 90,
        firstSeen: "4d ago",
        sources: [{ table: "salesforce.account", column: "billing_state", rows: 880 }],
      },
      {
        value: "AK",
        status: "new",
        current: null,
        suggestion: "Alaska",
        confidence: 95,
        firstSeen: "4d ago",
        sources: [{ table: "ga4.sessions", column: "region", rows: 540 }],
      },
      {
        value: "Cali",
        status: "new",
        current: null,
        suggestion: "California",
        confidence: 58,
        firstSeen: "6h ago",
        sources: [{ table: "hubspot.contacts", column: "state", rows: 96 }],
      },
    ],
  },
  {
    id: "post_type",
    dimension: "Sprout post type",
    dimTable: "zugzug.dim_post_type",
    mapTable: "zugzug.map_sprout_post_type",
    keyCol: "post_type",
    rows: 44,
    canonical: [
      { key: "tweet", label: "Tweet" },
      { key: "retweet", label: "Retweet" },
      { key: "twitter_mention", label: "Twitter Mention" },
      { key: "fb_post", label: "Regular FB Post" },
      { key: "ig_media", label: "IG Media" },
      { key: "tiktok_video", label: "Tiktok Video" },
      { key: "story", label: "Story" },
    ],
    values: [
      {
        value: "TWEET",
        status: "mapped",
        current: "Tweet",
        suggestion: null,
        confidence: 0,
        sources: [{ table: "sprout.messages", column: "post_type", rows: 41200 }],
      },
      {
        value: "FACEBOOK_POST",
        status: "mapped",
        current: "Regular FB Post",
        suggestion: null,
        confidence: 0,
        sources: [{ table: "sprout.messages", column: "post_type", rows: 18800 }],
      },
      {
        value: "RETWEET",
        status: "new",
        current: null,
        suggestion: "Retweet",
        confidence: 97,
        firstSeen: "2d ago",
        sources: [{ table: "sprout.messages", column: "post_type", rows: 6400 }],
      },
      {
        value: "TIKTOK_VIDEO",
        status: "new",
        current: null,
        suggestion: "Tiktok Video",
        confidence: 92,
        firstSeen: "2d ago",
        sources: [{ table: "sprout.messages", column: "post_type", rows: 3100 }],
      },
      {
        value: "INSTAGRAM_REEL",
        status: "new",
        current: null,
        suggestion: "IG Media",
        confidence: 64,
        firstSeen: "1d ago",
        sources: [{ table: "sprout.messages", column: "post_type", rows: 1450 }],
      },
      {
        value: "FB_STORY",
        status: "new",
        current: null,
        suggestion: "Story",
        confidence: 70,
        firstSeen: "1d ago",
        sources: [{ table: "sprout.messages", column: "post_type", rows: 720 }],
      },
      {
        value: "LINKEDIN_POST",
        status: "new",
        current: null,
        suggestion: null,
        confidence: 0,
        firstSeen: "5h ago",
        sources: [{ table: "sprout.messages", column: "post_type", rows: 210 }],
      },
    ],
  },
];
