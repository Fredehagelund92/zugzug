***REMOVED*** Cosmetic Column Types — Design Spec

**Date:** 2026-06-06
**Scope:** New display-oriented column types and number formats for the enrichment attribute data grid.

---

***REMOVED******REMOVED*** Overview

The data grid currently supports five column types (`text | number | boolean | date | select`) and four number display formats (`integer | decimal | percent | currency`). This spec adds two new number formats and three new column types that cover the most common gaps in enrichment attribute data, and refactors `ColumnDef` onto a discriminated union so per-type config is type-safe at compile time.

---

***REMOVED******REMOVED*** 1. Data Model

***REMOVED******REMOVED******REMOVED*** 1.1 `NumberFormat` — two new variants

```ts
| { format: "compact";  precision: 0 | 1 | 2 }
| { format: "duration"; display: "hm" | "hms" }
```

`compact` abbreviates large magnitudes: `45000 → 45K`, `1200000 → 1.2M`, `1400000000 → 1.4B`. `precision` controls significant digits after the abbreviation (`0 → 1M`, `1 → 1.2M`, `2 → 1.23M`). For values under 1 000 the number displays as-is with no suffix.

`duration` stores raw seconds as a `NUMERIC` value and formats on read. `"hm"` → `1h 23m` (drops seconds; shows `< 1m` below 60 s). `"hms"` → `1:23:45` (zero-padded, always shows seconds). Sub-second precision is explicitly out of scope.

***REMOVED******REMOVED******REMOVED*** 1.2 `CellType` — three new members

```ts
type CellType = "text" | "number" | "boolean" | "date" | "select"
              | "url" | "email" | "rating"
```

***REMOVED******REMOVED******REMOVED*** 1.3 `ColumnConfig` — new discriminated union

`ColumnDef` currently carries `type`, `options?`, and `numberFormat?` as flat optionals with no compile-time relationship between them. This is replaced by a `config: ColumnConfig` field:

```ts
export type ColumnConfig =
  | { type: "text" }
  | { type: "number";  numberFormat?: NumberFormat }
  | { type: "boolean" }
  | { type: "date" }
  | { type: "select";  options: OptionDef[] }
  | { type: "url" }
  | { type: "email" }
  | { type: "rating";  ratingMax: number };   // required; default 5 at creation
```

`CellType` is derived: `type CellType = ColumnConfig["type"]`.

***REMOVED******REMOVED******REMOVED*** 1.4 `ColumnDef` — updated shape

```ts
export interface ColumnDef<Row> {
  field:       string;
  label:       string;
  config:      ColumnConfig;          // replaces type / options / numberFormat
  width?:      number;
  hidden?:     boolean;
  sortable?:   boolean;
  editable?:   boolean;
  pinnedLeft?: boolean;
  align?:      "left" | "right";
  render?:     (row: Row, ctx: CellCtx<Row>) => ReactNode;
  edit?:       (row: Row, ctx: EditCtx<Row>) => ReactNode;
}
```

Every `switch` on column type becomes `switch (col.config.type)` with a `default: col.config satisfies never` arm. The project's `strict` + `noFallthroughCasesInSwitch` tsconfig flags make this exhaustion check compile-time enforced.

***REMOVED******REMOVED******REMOVED*** 1.5 Server schema — `field_config` rename

`dimension_field.options VARCHAR` is renamed to `field_config VARCHAR` via a Drizzle migration (`bun run db:generate` after updating `schema.ts`). The column stores:

| type    | stored value |
|---------|-------------|
| select  | `[{ label, color }]` (array JSON; legacy `string[]` is lifted on read) |
| number  | `{ format: … }` (NumberFormat JSON) |
| rating  | `{ ratingMax: 5 }` |
| all others | `null` |

`parseOptions` and `parseNumberFormat` are replaced by a single `parseFieldConfig(type, raw)` dispatcher. The `select` branch must preserve the legacy `string[]` → `OptionDef[]` lifting path that `parseOptions` currently handles.

**Raw SQL strings** that hard-code `"options"` must be updated manually after the schema rename (Drizzle does not rewrite raw query strings):
- `listFields` — SELECT clause (line 412)
- `addField` — INSERT (lines 444–454)
- `changeColumnType` — UPDATE inside transaction (lines 573–585)
- `addColumnOption` — UPDATE (line 633)

> Verify the generated Drizzle migration emits `ALTER TABLE ... RENAME COLUMN options TO field_config` and not a DROP + ADD. If the snapshot is stale it may choose the destructive path.

---

***REMOVED******REMOVED*** 2. Rendering

| Type / Format | Renderer | Notes |
|---|---|---|
| `compact` | Right-aligned monospace `45K`, `1.2M` | Uses `Intl.NumberFormat` with `notation: "compact"`. Falls back to raw number for values < 1 000. |
| `duration` | Left-aligned monospace `1h 23m` / `1:23:45` | Left-aligned — duration reads as a label, not a magnitude. `null` → `—`. |
| `url` | Link icon + truncated href, `target="_blank" rel="noopener"` | `null` or empty → `—`. Truncation is CSS `text-overflow: ellipsis`. |
| `email` | `@` icon + truncated address, `href="mailto:{value}"` | `null` or empty → `—`. |
| `rating` | Star glyphs inline (★ filled, ☆ empty) up to `ratingMax` | `null` → `—` em-dash, **not** empty stars. Empty stars read as "zero rating"; `—` communicates "no value". |

**URL/email Enter-key behaviour:** when a URL or email cell is focused via keyboard, pressing Enter enters edit mode (consistent with all other types). The anchor is only activated by pointer click, not by keyboard focus or Enter. This prevents accidental link navigation while grid-navigating.

---

***REMOVED******REMOVED*** 3. Editing

| Type / Format | Editor | Notes |
|---|---|---|
| `compact` | Same numeric input as other number formats | No change to editor logic. |
| `duration` | `HH:MM:SS` text input | Parses `H:MM:SS` or `HH:MM:SS` to seconds on commit. Placeholder: `0:00:00`. Invalid strings commit as `null`. |
| `url` | Plain single-line text input | Same as text cell editor. |
| `email` | Plain single-line text input | `type="email"` for mobile keyboards; no validation on commit. |
| `rating` | Star click or digit key | Enter / double-click enters edit mode. In edit mode: clicking a star commits that value and exits; pressing a digit 1–N commits and exits; Delete / Backspace clears to null and exits; Escape exits without committing. Non-digit printable-character type-to-edit is ignored (same guard as NumberCell). |

---

***REMOVED******REMOVED*** 4. Config UI

***REMOVED******REMOVED******REMOVED*** 4.1 AddFieldPopover

New type tiles: `url` (icon `↗`), `email` (icon `@`), `rating` (icon `★`). The existing 2-column tile grid grows from 5+1 (with the disabled "Linked record" soon tile) to 8+1, still `grid-cols-2`.

`url` and `email` have no sub-config — selecting them enables the Create button immediately.

`rating` shows a `ratingMax` picker after the tile is selected:
- Preset buttons: `3`, `5`, `10`
- Custom text input for other values (integer, 1–20)
- Default selection: `5`

Number format sub-panel gains two new tiles: `compact` (icon `1.2M`, smaller font than the badge) and `duration` (icon `⏱`).

`compact` shows a precision picker: `0`, `1`, `2`.

`duration` shows a display-mode toggle: `h m` vs `h:mm:ss`.

***REMOVED******REMOVED******REMOVED*** 4.2 ColumnHeaderMenu

The `TYPES` array gains `"url"`, `"email"`, `"rating"`. The type list grows to 8 items; at ~32 px per item this is ~256 px of list in a 192 px-wide panel — the type sub-panel should become scrollable (`max-h-[240px] overflow-y-auto`) rather than fixed height.

Selecting `url` or `email` from the type list calls `onChangeType` immediately (no sub-panel).

Selecting `rating` opens a `ratingMax` sub-panel (same back-button navigation as `number-format`) with the same preset + custom-input controls as the popover.

The number-format sub-panel adds `compact` and `duration` tiles, each with their respective sub-controls (precision picker, display-mode toggle).

---

***REMOVED******REMOVED*** 5. Type Coercion

`changeColumnType` in `repo-canonical.ts` is refactored from 7 positional parameters to an options object:

```ts
changeColumnType(dimId: string, field: string, opts: {
  newType:            string;
  options?:           OptionDef[];
  numberFormat?:      NumberFormat;
  ratingMax?:         number;
  coerceInvalidToNull: boolean;
  userId:             string;
})
```

The server.ts call site and any other callers update accordingly.

`addField` also gains a `ratingMax?` branch so rating fields created fresh persist their config.

***REMOVED******REMOVED******REMOVED*** 5.1 Coercion matrix

**`url` and `email`** are stored as `VARCHAR`, identical to `text`. All conversions to/from them are lossless VARCHAR relabels. The coercion loop is skipped entirely — only `UPDATE dimension_field SET type=$1, field_config=null` is issued. No `invalidCount`, no ALTER TABLE tmp-column dance.

> Clearing `field_config` to `null` is always safe: url/email carry no config, and any previous config (number format JSON or select options JSON) is irrelevant after the type change.

**`rating`** — SQL type `INTEGER`. `ratingMax` must be supplied by the caller and written to `field_config` at the end of the transaction.

| From | Coercion rule |
|---|---|
| `text` / `url` / `email` | Parse as integer. Bad if not parseable. |
| `number` | Round to nearest integer. If out of range [1, ratingMax] → counts as `bad` and surfaces in `invalidCount`. |
| `boolean` | `true → 1`, `false → 0`. 0 is out of range for a 1-based rating → `bad`. Effectively all `false` values will be bad unless coerceInvalidToNull is confirmed. |
| `select` | Parse as integer. Bad if not parseable (note: labels like "Low"/"High" will all be bad — `invalidCount` may be 100%). |
| `date` | Always bad. |

| From `rating` | Coercion rule |
|---|---|
| → `text` / `url` / `email` | Stringify integer. Always valid. |
| → `number` | INTEGER → NUMERIC. Always valid, lossless. |
| → `boolean` | Bad (no meaningful mapping from 1–N to true/false). |
| → `date` | Bad. |
| → `select` | Stringify to `"1"`, `"2"`, etc. Valid if those labels exist in options; bad otherwise. |

**Number format changes** (`compact`, `duration`) are display-only. The SQL column type stays `NUMERIC`. Only `field_config` in `dimension_field` is updated — no row data migration, no `invalidCount` check. Same behaviour as switching `integer → decimal` today.

---

***REMOVED******REMOVED*** 6. Migration Scope

| Area | Change |
|---|---|
| `app/src/data.ts` | Extend `NumberFormat` union. |
| `app/src/components/datagrid/types.ts` | Replace `type/options/numberFormat` with `config: ColumnConfig`. Derive `CellType`. |
| `app/src/components/datagrid/DataGrid.tsx` | `col.type` → `col.config.type` throughout. Add `url`, `email`, `rating` to `FIELD_TYPE_ICONS` and `CELLS`. Add `satisfies never` arms to all switches. |
| `app/src/components/datagrid/ColumnHeaderMenu.tsx` | `column.numberFormat` → narrowed via `column.config`. Add new types to list. Add `ratingMax` sub-panel. Scrollable type list. |
| `app/src/components/datagrid/cells/NumberCell.tsx` | `column.numberFormat` → narrowed via `column.config`. Add `compact` and `duration` cases to `formatNumber`. Duration editor. |
| `app/src/components/datagrid/cells/` | New: `UrlCell.tsx`, `EmailCell.tsx`, `RatingCell.tsx`. |
| `app/src/components/AddFieldPopover.tsx` | New type tiles, `ratingMax` picker, compact/duration config. |
| `app/src/components/TablePane.tsx` | `ColumnDef` construction sites — `col.type/options/numberFormat` → `col.config`. Introduce typed `fieldDefToColumnConfig(f: FieldDef): ColumnConfig` helper (replaces widening cast). |
| `server/drizzle/schema.ts` | Rename `options` → `field_config`. |
| `server/src/repo-shared.ts` | Update `FieldDef` type (`field_config` column, `ratingMax?`). |
| `server/src/repo-canonical.ts` | Update all raw SQL strings. Replace `parseOptions`/`parseNumberFormat` with `parseFieldConfig`. Refactor `changeColumnType` to options-object signature. Add `ratingMax` branch to `addField`. Add url/email skip-ALTER path. Add rating coercion rules. |
| `server/src/server.ts` | Update PUT body type; pass `ratingMax` through to `changeColumnType`. |
