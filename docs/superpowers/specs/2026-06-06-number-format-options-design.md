---
title: Number Format Options
date: 2026-06-06
status: draft
---

***REMOVED*** Number Format Options

***REMOVED******REMOVED*** Problem

The `number` field type is a flat, unformatted generic number. `NumberCell` renders raw values — no precision control, no currency symbol, no percent suffix. Teams adding canonical fields like "contract value", "discount rate", or "partner tier" have no way to make those numbers meaningful at a glance.

***REMOVED******REMOVED*** Goal

Extend the existing `number` type with a `NumberFormat` sub-option. Display is cosmetic only — no server-side validation in this version. No schema migration required.

---

***REMOVED******REMOVED*** Data model

***REMOVED******REMOVED******REMOVED*** `NumberFormat` type

```ts
export type NumberFormat =
  | { format: "integer" }
  | { format: "decimal"; precision: 1 | 2 | 3 | 4 }
  | { format: "percent"; precision: 0 | 1 | 2 }
  | { format: "currency"; symbol: string; position: "prefix" | "suffix"; precision: 0 | 1 | 2 }
```

Lives in `app/src/components/datagrid/types.ts` alongside `CellType` and `ColumnDef`.

***REMOVED******REMOVED******REMOVED*** Format semantics

| Format | Stored value | Displayed as | Notes |
|---|---|---|---|
| `integer` | `42` | `42` | Thousands separator, no decimals |
| `decimal` | `42.5` | `42.50` (precision 2) | Thousands separator |
| `percent` | `0.42` | `42%` (precision 0) | Stored normalized (0–1). Renderer multiplies by 100. |
| `currency` | `42` | `$42.00` or `42.00 kr` | Symbol is a freeform string (max 6 chars). Position is prefix or suffix. |

**Percent is stored normalized.** `0.42` stored → `42%` displayed. This matches Airtable's convention and warehouse norms where analytic systems expect 0–1 range. The renderer multiplies by 100 for display; editors divide by 100 on commit.

**Currency symbol is freeform.** The user types `$`, `USD`, `€`, `EUR`, `kr`, `CHF`, etc. The UI offers quick-pick chips for common values (`$  €  £  ¥  kr  USD  EUR  GBP`) alongside a text input. No enum constraint.

**Negative number rendering for currency.** The minus sign always precedes the full expression: `−$100.00` (prefix) or `−100.00 kr` (suffix). Do not place the symbol between the minus and the digits.

***REMOVED******REMOVED******REMOVED*** Storage

Reuse the existing `options varchar` column on `dimension_field`. No migration needed.

- `type === "select"` → `options` is a JSON array of `OptionDef[]`
- `type === "number"` → `options` is a JSON object of `NumberFormat`, or `null`

`parseOptions` in `repo-shared.ts` already returns `undefined` for non-array JSON, so there is no collision risk. The parse-by-type discrimination is safe.

**Backwards compat.** Existing number columns with `options = null` → `numberFormat = undefined` → `NumberCell` renders raw (current behavior). No breakage.

***REMOVED******REMOVED******REMOVED*** `ColumnDef` change

```ts
export interface ColumnDef<Row> {
  // ...existing fields...
  numberFormat?: NumberFormat;  // only meaningful when type === "number"
}
```

---

***REMOVED******REMOVED*** Components

***REMOVED******REMOVED******REMOVED*** `NumberCell.tsx`

`Renderer` currently destructures `{ value }` only. It must accept the full `CellCtx<Row>` to read `ctx.column.numberFormat`.

**Formatting logic** — a `formatNumber(value: unknown, fmt: NumberFormat | undefined): string` helper:

- `undefined` → raw `String(n)` (legacy behavior, no change)
- `integer` → `toLocaleString('en-US', { maximumFractionDigits: 0 })`
- `decimal` → `toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p })`
- `percent` → `(n * 100).toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p }) + '%'`
- `currency` (prefix) → `symbol + n.toLocaleString(...)` with negative handling: if `n < 0`, `'−' + symbol + formatted_abs`
- `currency` (suffix) → `n.toLocaleString(...) + ' ' + symbol` with negative handling: if `n < 0`, `'−' + formatted_abs + ' ' + symbol`

**Editor.** Integer format ignores non-digit/minus/decimal characters on commit (soft — no hard rejection). Percent editor: displays `n * 100` for editing, divides by 100 on commit. All other formats accept any numeric input unchanged.

***REMOVED******REMOVED******REMOVED*** `AddFieldPopover.tsx`

`AddFieldInput` gains `numberFormat?: NumberFormat`.

When the `number` tile is active, a secondary config panel expands below the tile grid:

```
Format   [ Integer ]  [ Decimal ]  [ Percent ]  [ Currency ]

***REMOVED*** decimal selected:
Precision   [ 1 ]  [ 2 ]  [ 3 ]  [ 4 ]

***REMOVED*** percent selected:
Precision   [ 0 ]  [ 1 ]  [ 2 ]

***REMOVED*** currency selected:
Symbol    [ $ ] [ € ] [ £ ] [ ¥ ] [ kr ] [ USD ] [ EUR ] [ GBP ] [__freeform__]
Position  ( Prefix ●)  ( Suffix  )
Precision   [ 0 ]  [ 1 ]  [ 2 ]
```

Default when `number` is first selected: `{ format: "integer" }`. No precision or symbol shown until a format that needs them is picked.

***REMOVED******REMOVED******REMOVED*** `ColumnHeaderMenu.tsx`

"Change type" flow: when switching the column type **to** `number`, the submenu or dialog surfaces the same format config panel (defaulting to `integer`). When switching **away** from `number`, `numberFormat` is discarded and `options` is cleared.

`DataGridProps.onChangeColumnType` opts bag gains `numberFormat`:

```ts
opts?: {
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  coerceInvalidToNull?: boolean;
}
```

---

***REMOVED******REMOVED*** Server

***REMOVED******REMOVED******REMOVED*** `server/src/repo-shared.ts`

Add `numberFormat?: NumberFormat` to `FieldDef`. In `listFields` (or wherever fields are read from the DB), add a parse branch:

```ts
if (row.type === 'number' && row.options) {
  try { field.numberFormat = JSON.parse(row.options) as NumberFormat; } catch {}
}
```

***REMOVED******REMOVED******REMOVED*** `server/src/repo-canonical.ts`

**`addField`** — when `type === 'number'`, serialize `numberFormat` to JSON and write to `options`. Currently writes `null` for all non-select types.

**`changeColumnType`** — currently takes `options: OptionDef[] | undefined` as its fourth argument. Add a parallel `numberFormat?: NumberFormat` parameter. When `newType === 'number'`, serialize `numberFormat` to the `options` column. When `newType !== 'number'` and `newType !== 'select'`, write `null` to clear stale format data.

***REMOVED******REMOVED******REMOVED*** `server/src/server.ts`

Two endpoints need updating:

- `POST /api/dimensions/:id/fields` — accept `numberFormat` in request body, pass through to `addField`
- `PUT /api/dimensions/:id/fields/:field/type` — accept `numberFormat` in request body, pass through to `changeColumnType`

***REMOVED******REMOVED******REMOVED*** `server/src/tables.ts`

`ColumnDraft` gains `numberFormat?: NumberFormat`. The `addField` call at the bottom of `createTable` must forward it.

---

***REMOVED******REMOVED*** Out of scope

**Basis points (`bps`).** A real fintech ask — `50 bps` display on a stored `50`. Deferred to post-launch; add as a fifth `NumberFormat` variant when the demand is confirmed.

**Server-side validation.** Integer fields do not reject decimal input at the API level in this version. Soft input filtering in the editor is the only enforcement. Hard validation can be added later without a storage change.

**Locale-aware formatting.** All formatting uses `'en-US'` locale. Locale-aware output (`,` vs `.` as decimal separator) is deferred.

---

***REMOVED******REMOVED*** File touch list

| File | Change |
|---|---|
| `app/src/components/datagrid/types.ts` | Add `NumberFormat` type; add `numberFormat?` to `ColumnDef`; add `numberFormat?` to `DataGridProps.onChangeColumnType` opts |
| `app/src/components/datagrid/cells/NumberCell.tsx` | `Renderer` takes full `CellCtx`; add `formatNumber` helper; percent editor ÷100 on commit |
| `app/src/components/AddFieldPopover.tsx` | `AddFieldInput` gains `numberFormat`; add format config panel for number type |
| `server/src/repo-shared.ts` | Define server-side `NumberFormat` type; `FieldDef` gains `numberFormat`; parse branch in field loader |
| `server/src/repo-canonical.ts` | `addField` + `changeColumnType` accept and persist `numberFormat` |
| `server/src/server.ts` | Two endpoints accept `numberFormat` in body |
| `server/src/tables.ts` | `ColumnDraft` gains `numberFormat`; forward in `addField` call |
