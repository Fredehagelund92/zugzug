# Airtable-style table creation: one-page scaffold modal, identity, naming sweep

**Date:** 2026-06-04
**Status:** Design — pending implementation plan
**Scope:** `app/src/components/DimensionPicker.tsx` (renamed), new `app/src/components/CreateTableModal.tsx`, `app/src/routes/MasterTables.tsx` and the rest of the user-facing UI (copy sweep), plus a new server endpoint `POST /tables` and small additions to `app.dimension` and `app.dimension_field.options`.

## Goal

Make creating a table feel like Airtable: in one modal you set identity (name, description, monogram tint), choose a starting mode (blank / from a source column / from IDs), and — for blank tables — scaffold your fields up front, including `select` fields with predetermined, colored options. The result is a path where someone can declare "Risk level: high / medium / low" without leaving the modal and without round-tripping through the column-header-menu "change type to select" detour that exists today.

Beyond the modal itself, the round codifies the implicit Airtable framing the app has been growing into: the user-facing noun becomes **Table** (not Dimension) / **Record** (not Master record) / **Field** (not Attribute column), tables get a curated monogram tint that flows through the picker, and the implicit lowercase-mono-CLI capitalization rule the app already uses ~80% of the time is spelled out and the placeholder stragglers are swept to comply.

Engineer mode keeps `dim_*` / `map_*` / `keyCol` raw — those are real SQL identifiers and not user-facing.

## Non-goals (deferred)

- **Multi-select**, **linked-record**, **formula / lookup / rollup** field types. The `select` color-per-option work in this round is the stepping stone but multi-select is a separate spec.
- **Saved views, filters, sort presets.** `app.user_grid_layout` continues to hold per-user widths/order/hidden only.
- **CSV / spreadsheet paste import.** A future "Start from CSV" mode would slot into the segment without breaking this design.
- **Emoji icons for tables.** The curated palette decision rules out per-table emoji for now; monogram + color is the identity layer.
- **Per-table audit / activity views.** Audit stays global on the Dashboard.
- **Table description as a queryable / searchable field.** It's a plain caption.

## Architecture

### Files touched

**New**
- `app/src/components/CreateTableModal.tsx` — the one-page scaffold modal.
- `app/src/lib/palette.ts` — single source of truth for the 7-tint curated palette (`rose | amber | mint | teal | indigo | violet | slate`).
- `server/src/tables.ts` — server-side orchestrator for `POST /tables`; calls existing `repo.ts` primitives inside a single Postgres transaction.

**Renamed (file rename + import updates)**
- `app/src/components/DimensionPicker.tsx` → `app/src/components/TablePicker.tsx` (plus all importers).
- `app/src/components/NoDimensionsYet.tsx` → `app/src/components/NoTablesYet.tsx`.

**Modified**
- `app/src/store.ts` — adds `createTable(input)`, extends `MappingDimension` with `description` and `color`, `FieldDef.options` shape change to `OptionDef[]`.
- `app/src/data.ts` — type updates (`FieldDef`, new `OptionDef`, new `PaletteName`).
- `app/src/components/datagrid/cells/SelectCell.tsx` — chip renders with option color; editor shows color dot per option and a swatch picker on `+ option`.
- `app/src/components/datagrid/Chip.tsx` — accepts an optional `color: PaletteName | null` prop.
- `app/src/components/datagrid/ColumnHeaderMenu.tsx` — option list inside "change type → select" displays color dots; option add lets you set a color.
- `app/src/routes/MasterTables.tsx` — naming sweep ("master records" → "records", `Master lists` H1 → `Tables`, `+ column` → `+ field`); the in-grid `AddColumn` widget gains `select` in `FIELD_TYPES` and the inline `OptionBuilder` for options.
- `app/src/routes/Mapping.tsx`, `Sources.tsx`, `Dashboard.tsx`, `Settings.tsx` — copy-only sweep.
- `server/src/server.ts` — new `POST /tables` route delegating to `server/src/tables.ts`.
- `server/src/repo.ts` — `getDimension` SELECTs `description`, `color`; `addField` / `addColumnOption` accept `OptionDef[]` and write the new shape; `parseOptions` accepts both legacy `string[]` and new `OptionDef[]` JSON; existing mutators gain an optional `silent: boolean` flag so `POST /tables` can emit one consolidated audit entry instead of one per primitive.
- `server/src/schema.ts` — adds idempotent `ALTER TABLE dimension ADD COLUMN IF NOT EXISTS description VARCHAR` and `… color VARCHAR`.
- `app/src/tokens.css` (or a sibling `app/src/palette.css` imported once) — `--tint-rose | --tint-amber | --tint-mint | --tint-teal | --tint-indigo | --tint-violet | --tint-slate` CSS custom properties so the palette is themable in one file.

### Component contract — `CreateTableModal`

```ts
interface CreateTableModalProps {
  open: boolean;
  defaultMode?: 'blank' | 'source' | 'external_id';
  defaultColor?: PaletteName;            // e.g. round-robin from existing tables to avoid clumping
  onClose: () => void;
  onCreated: (id: string) => void;       // parent then setDimId(id) + close
}
```

Internal state holds identity (`name`, `description`, `color`), `mode`, and the mode-specific form (`columns: ColumnDraft[]` for blank, `source: {table,column} | null` for source, `external: {table, idColumn, nameColumn} | null` for external_id). Submit calls `store.createTable(...)` then `onCreated(id)`.

### Component contract — `TablePicker` (renamed from `DimensionPicker`)

Behavior unchanged for selection; visual updates only:
- Monogram background reads `d.color` and looks up `PALETTE[d.color].bg`; falls back to `--accent` when `null` (existing rows).
- 2nd-line caption falls through: engineer-mode shows `d.mapTable` raw (today's behavior, unchanged); otherwise shows `d.description` if set; otherwise falls back to the existing `${mapped} mapped · ${fresh} new` counts. The trailing right-aligned `%` / `empty` chip stays as-is (`DimensionPicker.tsx:107`).
- Trigger and dropdown copy updated to the Airtable vocabulary (`Find a table…`, `New table`).
- The "New table" footer button opens `CreateTableModal` instead of inline-creating with name only.

## Data flow

```
[CreateTableModal]
     │ submit
     ▼
store.createTable(input) ──► POST /api/tables
                                  │
                                  ▼
                          server/src/tables.ts :: createTable
                          (single PG transaction)
                                  │
                                  ├─ addDimension(name, keyKind, silent=true)
                                  ├─ UPDATE dimension SET description, color
                                  ├─ if source/external: addSource(...)
                                  ├─ if blank: addField(...) for each column   (silent=true)
                                  ├─ if select column: writes OptionDef[] JSON
                                  ├─ if source/external: deriveCanonical(...)  (silent=true)
                                  └─ appendAudit('table_created', detail)
                                  │
                                  ▼
                                201 { id }
                                  │
                                  ▼
                       refresh dims/sources/audit, emit
                                  │
                                  ▼
                       parent calls setDimId(id) + close modal
```

The `silent: true` flag is plumbed only as far as needed to suppress per-primitive audit emission. It defaults to `false` so existing callers (the in-grid `+ field` widget, the inline rename/delete) are unaffected.

## API contract

### `POST /api/tables`

**Request**
```ts
type CreateTableInput = {
  name: string;                          // required; slugged to dimension.id
  description?: string | null;
  color?: PaletteName | null;
  mode: 'blank' | 'source' | 'external_id';

  // mode === 'blank'
  columns?: Array<{
    label: string;
    type: 'text' | 'number' | 'boolean' | 'date' | 'select';
    options?: Array<{ label: string; color: PaletteName | null }>;  // required when type === 'select'
  }>;

  // mode === 'source'
  source?: { table: string; column: string };

  // mode === 'external_id'
  external?: { table: string; idColumn: string; nameColumn: string };
};

type PaletteName = 'rose' | 'amber' | 'mint' | 'teal' | 'indigo' | 'violet' | 'slate';
```

**Response — 201**
```json
{ "id": "risk_level" }
```

**Response — 400**
```ts
type CreateTableError = {
  error: string;
  code: 'NAME_TAKEN' | 'WAREHOUSE_OFFLINE' | 'MISSING_PICKER' | 'INVALID';
};
```

### Validation (server-side, mirrored client-side for UX)

- `name`: required; ≥ 1 non-whitespace char; slug uniqueness vs `dimension.id` → 400 `NAME_TAKEN`.
- `mode === 'blank'`: `columns` may be empty (the implicit `name` primary is enough).
- `mode === 'source'`: `source.table` + `source.column` required → 400 `MISSING_PICKER`.
- `mode === 'external_id'`: `external.table` + `external.idColumn` + `external.nameColumn` all required and `idColumn !== nameColumn`.
- `column.type === 'select'`: option labels unique within the column; options optional (an empty select is allowed and added later).
- Warehouse-dependent modes (`source`, `external_id`) require `ATTACH_WAREHOUSE=true` → 400 `WAREHOUSE_OFFLINE`.

## Data shape

### `dimension` (Postgres)

```sql
ALTER TABLE app.dimension ADD COLUMN IF NOT EXISTS description VARCHAR;
ALTER TABLE app.dimension ADD COLUMN IF NOT EXISTS color       VARCHAR;
-- `color` stores the palette token ('rose'), NOT a hex.
-- Why: re-theming the palette stays a single-file CSS change.
```

`description` and `color` are nullable. Existing rows read as `null` / `null` and render with the rose accent and no caption — same look as today.

### `dimension_field.options`

The column stays `VARCHAR`. The on-disk JSON shape moves from `["high","medium","low"]` to `[{"label":"high","color":"rose"},{"label":"medium","color":"amber"},{"label":"low","color":"mint"}]`.

No DDL change. Read path normalizes both shapes:

```ts
function parseOptions(raw: string | null): OptionDef[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return parsed.map(o => typeof o === 'string' ? { label: o, color: null } : o);
}
```

Writes always emit the object shape going forward. Legacy options upgrade lazily on the next edit. No backfill migration is run. The `VARCHAR` (not `JSON`) choice is preserved for the same reason already documented in `schema.ts:64-80` (the DuckDB Postgres extension drops the `::json` cast on UPDATE rewrites).

### Client types

```ts
// app/src/data.ts
export type PaletteName = 'rose' | 'amber' | 'mint' | 'teal' | 'indigo' | 'violet' | 'slate';
export interface OptionDef { label: string; color: PaletteName | null }
export interface FieldDef {
  field: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'select';
  options?: OptionDef[];
}
export interface MappingDimension {
  // ... existing fields
  description: string | null;
  color: PaletteName | null;
}
```

### Palette tokens

`app/src/lib/palette.ts` exports:

```ts
export const PALETTE: Record<PaletteName, { bg: string; fg: string; glow: string }> = {
  rose:   { bg: 'var(--tint-rose)',   fg: '#FF8FB1', glow: 'color-mix(in srgb,var(--tint-rose) 22%,transparent)' },
  amber:  { bg: 'var(--tint-amber)',  fg: '#F7C76A', glow: 'color-mix(in srgb,var(--tint-amber) 22%,transparent)' },
  // ... etc
};
```

`tokens.css` (or a sibling palette CSS) adds the `--tint-*` definitions. Both light and dark themes share the hue set; foreground colors are tuned for readability on each theme's surface.

## Modal UX detail

### Layout (single column, 520 px wide)

```
┌────────────────────────────────────────────────────┐  ← outer 12px corners
│  NEW TABLE                                         │  ← mono eyebrow
│                                                    │
│  [R]   Risk level                                  │  ← identity row
│  TINT  ● ● ● ● ● ● ●                                │  ← inline swatches
│                                                    │
│  Severity tier for incidents.                      │  ← description
│                                                    │
│  START FROM                                        │
│  [ blank | from a source column | from IDs ]       │  ← mono lowercase segment
│  start with empty rows · design fields…            │  ← mono helper, dot-sep
│                                                    │
│  FIELDS                                            │
│  ╔════ swappable region (4px corners) ═══════════╗ │
│  ║  ⋮⋮  name        text · PRIMARY             × ║ │  ← locked row, primary tag
│  ║  ⋮⋮  severity    [ select ▾ ]                × ║ │
│  ║       ● high  ● medium  ● low  + option       ║ │  ← colored chip options
│  ║  ⋮⋮  owner       [ text   ▾ ]                × ║ │
│  ║  + add field                                   ║ │
│  ╚════════════════════════════════════════════════╝ │
│                                                    │
│              [ Cancel ]  [ Create table ]          │
└────────────────────────────────────────────────────┘
```

### Identity

- Monogram is the existing 32×32 `Mono` component (`DimensionPicker.tsx:19` today) but recolored from `color` instead of always rose. Border radius `--r-sm` (4px), matching today.
- Inline `TINT` swatch row sits below the identity (not as a popover). Seven 14×14 squares; click toggles selection (single-select).
- Name input uses `font-display` 18px; description is `font-body` 13px textarea, 1–2 lines, optional.

### Mode segment

Three pills, all mono lowercase: `blank` / `from a source column` / `from IDs`. The active pill fills with `--accent`. Mode changes preserve identity, reset the swappable region. A short mono helper line appears under the segment (dot-separated, lowercase):

- `blank`: `start with empty rows · design fields now or add them later`
- `from a source column`: `seed records from distinct values in a warehouse column`
- `from IDs`: `records keyed by a warehouse id · names resolved live`

### Swappable region

**Blank** — the column scaffold. The first row is **locked**: `name` field, type `text`, with a `PRIMARY` tag (mono uppercase tracked) on the right. The user can't reorder, retype, or delete it. Subsequent rows have a grip handle (`⋮⋮`), an inline label input (mono), a type dropdown, and a `×` delete. When `type = select`, the row expands to show a chip row beneath it: existing options as colored chips, plus a `+ option` affordance. Clicking `+ option` opens an inline mini-popover with a label input + 7-swatch color picker; Enter creates the option. Clicking an existing chip lets you edit its label and color or remove it. A `+ add field` row at the bottom appends a new row in focus state.

**From a source column** — a single `ComboSelect` reading from the existing `sources` registry. Placeholder: `pick a warehouse column…`. Helper preview below: `distinct values from the chosen column become records · already-mapped values are skipped`. (Once a column is picked, the helper could be enriched with the `source_stat.distinct_values` count, but the v1 just shows the helper sentence.)

**From IDs** — two `ComboSelect`s side by side (`id column`, `name column`), each with `pick the … column…` placeholders. Helper: `keys come from the id column · the human name is resolved live from the name column · no slug`.

### Submit behavior

`Create table` is enabled when name is non-empty and mode-specific required fields are set:
- `blank` → name (only)
- `from a source column` → name + source column
- `from IDs` → name + id column + name column

On submit, the modal POSTs and waits. Errors render in an inline banner above the footer buttons, styled like the `notice` row on MasterTables (`border-line bg-accent-wash text-accent`). On success, the modal closes; the parent (`MasterTables` or `TablePicker`) calls `setDimId(id)` and the new table becomes active.

### Keyboard

- `Esc` closes (with a confirm if any field has unsaved content).
- `⌘/Ctrl + Enter` submits if `Create table` is enabled.
- `Tab` order: name → description → mode segment → first field row → next field row → ... → `+ add field` → footer buttons.

## Naming sweep & capitalization rule

### Vocabulary swap (user-facing only)

| Old | New |
|---|---|
| Dimension | Table |
| Master record | Record |
| Master list / Master lists | Table / Tables |
| Attribute column | Field |
| `+ column` affordance | `+ field` |
| `Find a dimension…` placeholder | `find a table…` |
| `New dimension` CTA | `New table` |
| `New <X> master record…` placeholder | `new <x> record…` |

Engineer-mode strings (`dim_<slug>`, `map_<slug>`, `keyCol`) are NOT swept. The `engineer && (…)` branches in `MasterTables`, `DimensionPicker`, `Sources`, `Settings` keep raw SQL identifiers.

### Capitalization rule (codified)

The app already follows this rule ~80% of the time. The sweep codifies it and brings placeholder stragglers into line.

| Surface | Rule | Examples |
|---|---|---|
| `font-mono` chrome labels & action verbs | lowercase | `+ field`, `add`, `clear`, `loading…`, `blank`, `from a source column` |
| `font-mono` empty-state / helper hints | lowercase prose, dot-separated | `no records yet · import from a source above, or add one below` |
| `font-mono` eyebrows with `tracking-[0.22em]` | UPPERCASE | `STANDING · TODAY`, `NEW TABLE` |
| `font-body` / `font-display` CTAs and H1s | Sentence case | `Add record`, `Browse warehouse`, `Cancel`, `Create table`, `Tables` |
| Data values & field-type tokens | lowercase (matches DB convention) | `text`, `select`, `severity`, `high` |
| User-typed values (table names, record labels) | as typed | `Risk level`, `United States` |

Placeholder stragglers swept: `ID column…` → `id column…`, `Name column…` → `name column…`, `Find a dimension…` → `find a table…`. CTA buttons stay Sentence case.

## Edge cases & error handling

- **Slug collision.** New table name slugs to an existing `dimension.id`. Server returns `NAME_TAKEN`; modal shows inline banner `A table called "X" already exists.` and keeps the modal open.
- **Warehouse offline + mode requires it.** Modal banner: `Warehouse isn't attached — enable ATTACH_WAREHOUSE or pick blank.` The mode pills remain interactive so the user can switch to `blank`.
- **External-ID mode, same column picked for id and name.** Client-side disable the second picker until the first is set, then filter the chosen column from the second picker's options. Server-side hard-validate as a backstop.
- **Select field with no options yet.** Allowed. Chips render nothing under the row; the field exists and options can be added later in the grid via the column-header menu or the in-grid `+ field` widget on subsequent edits.
- **Legacy dimensions in the picker.** Render with rose accent + no caption (no migration, fully backwards-compatible).
- **Concurrent creation.** Two users creating the same-named table at the same time both get past client-side validation; the second commit fails atomically with `NAME_TAKEN` thanks to the `PRIMARY KEY` on `dimension.id`.

## Testing

### Server

- `server/src/tables.test.ts` (new):
  - `POST /tables` with `mode='blank'` + 3 columns (one `select` with 3 options) → row in `dimension` with `description`/`color`, 3 rows in `dimension_field`, the select option JSON is in `{label,color}` shape, one audit entry.
  - `POST /tables` with `mode='source'` + a wired column → `dimension_source` row, `dim_*` populated via `deriveCanonical`, one audit entry.
  - `POST /tables` with `mode='external_id'` → `keyKind='external_id'`, name binding stored.
  - Validation: empty name → 400 `INVALID`; slug collision → 400 `NAME_TAKEN`; warehouse off + `mode='source'` → 400 `WAREHOUSE_OFFLINE`; same column twice in `external_id` → 400 `INVALID`.
  - Atomicity: simulate `deriveCanonical` failure mid-transaction → no orphan dimension row.

- `server/src/repo.test.ts` (extending):
  - `addField` with `options: [{label, color}]` writes the object shape JSON.
  - Reading a dimension whose options are legacy `["high","low"]` returns `[{label:"high",color:null},…]`.

### Client

- `app/src/components/__tests__/CreateTableModal.test.tsx` (new):
  - Each mode renders the correct swappable region.
  - Submit button is disabled until mode-specific required fields are set; enabled when valid.
  - Color-swatch click updates the monogram tint.
  - Mode swap preserves name, description, color.
  - Inline `OptionBuilder` adds a chip with the picked color; chip click edits both label and color.

- Extending DataGrid tests:
  - `+ field` widget in MasterTables shows `select` in the type list.
  - Chip renders with `option.color` tint when set; falls back to neutral when `null`.

### Smoke / regression

- Grep `app/src/routes/**` and `app/src/components/**` for `Dimension`, `dimension` (case-insensitive, user-facing strings only), `Master record`, `Master list`, `Attribute column` — expect zero matches outside `engineer && …` branches and engineer-mode pivots.
- Existing dimensions (created before this round) load and render correctly: monogram rose, no description caption, options render as neutral chips.

## Risks

- **Option JSON migration is lazy.** Production rows with `string[]` options stay valid forever; they upgrade only when re-edited. The lift happens in `parseOptions`. Risk: if a code path bypasses `parseOptions` and reads `dimension_field.options` directly, it'd see two shapes. Mitigation: all reads go through the repo's `getDimension`; grep audit confirms.
- **Naming sweep ripple.** The `DimensionPicker` → `TablePicker` rename touches 3–4 importers (MasterTables, Mapping, plus their tests). Mitigation: single PR, atomic file rename + imports, plus a grep audit for `DimensionPicker` and `NoDimensionsYet` strings post-sweep.
- **Engineer-mode regression.** A sweep that strips `dim_*`/`map_*` from engineer-mode branches would break the feature. Mitigation: every `useEngineerMode()`-gated branch is left as-is; the grep audit explicitly excludes `engineer &&` conditional bodies.
- **External-ID modal usability.** Asking for two pickers in one screen is denser than the existing two-step approach on the hero of MasterTables. Mitigation: the `From IDs` helper text spells out the contract; the second picker filters out the first picker's choice.
- **`silent: true` flag on inner mutators is one-shot scope.** Adding a parameter to every audit-emitting primitive is a small refactor; if it grows into pattern (more orchestrators wanting consolidated audit), we'd extract an explicit "transaction context" instead. v1 keeps it as a parameter.

## Out of scope but worth flagging for future specs

- **Multi-select fields**: a clean follow-on once option-with-color shipping is in production.
- **Linked-record fields**: cross-table references (e.g. `City.country → Country`). The right Airtable-next step but a meaningful schema and grid lift.
- **CSV / paste import**: would slot into the mode segment as a 4th option without breaking this design.
- **Saved views**: filters, sorts, hidden-column presets per user per table.
- **Per-table audit view**: a section on the table page showing just that table's audit history.
- **Emoji / icon per table**: rejected for v1 due to brand fit; can be revisited later.
