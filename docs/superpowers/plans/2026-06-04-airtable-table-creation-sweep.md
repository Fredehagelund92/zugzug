***REMOVED*** Airtable-style table creation sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a one-page `CreateTableModal` with identity (monogram tint + description), a Blank / From a source column / From IDs segment, an inline column scaffold that supports predetermined colored select options at creation time, plus a naming sweep (Dimension → Table, Master record → Record, Attribute column → Field) and a codified lowercase-mono capitalization rule.

**Architecture:** A new `POST /api/tables` endpoint orchestrates the existing `repo.ts` primitives (`addDimension`, `addField`, `addColumnOption`, `addSource`, `deriveCanonical`) inside a single Postgres transaction with one consolidated audit entry. Client state types (`MappingDimension`, `FieldDef.options`) accept a backwards-compatible `OptionDef = {label, color}` shape; legacy `string[]` option rows lift transparently on read. The `dimension` table gains nullable `description` and `color` columns via idempotent `ADD COLUMN IF NOT EXISTS`. The 7-tint curated palette lives in `tokens.css` as CSS custom properties referenced by a single `app/src/lib/palette.ts` lookup so the brand can re-skin in one file.

**Tech Stack:**
- Server: Bun + `@duckdb/node-api`, Postgres via DuckDB ATTACH, repo pattern in `server/src/repo.ts`
- Client: React 18 + Vite + Tailwind v4, single `useSyncExternalStore` store in `app/src/store.ts`
- Verification: `bun run verify-tables` end-to-end script against real Postgres (mirrors `verify-datagrid` / `verify-eid` / `verify-polish`); `bun run typecheck` in both packages
- No client-side test framework (the repo doesn't ship one); the verification layer is server-side + typecheck + manual smoke in the dev browser

---

***REMOVED******REMOVED*** Project conventions to follow

- **Commit style.** Conventional Commits: `feat(scope): …`, `refactor(scope): …`, `fix(scope): …`, `docs: …`. Recent log uses scopes like `feat(auth):`, `feat(tables):`, `feat(grid):`. Use `feat(tables):` for backend orchestration and modal work; `refactor(naming):` for the sweep.
- **Testing.** Existing pattern is `server/src/verify-*.ts` scripts: a `step(label, fn)` helper + `assert(cond, msg)` + self-cleaning at the end. New behavior gets a new `verify-tables.ts` and an extension of the `bun run` script list.
- **Idempotent DDL.** Use `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` for schema migrations, as in `server/src/schema.ts:36-39`.
- **No emojis** in code, copy, or commits unless the user explicitly asks (they haven't).
- **Engineer mode is sacred.** Every `useEngineerMode()`-gated branch must keep its raw `dim_*` / `map_*` / `keyCol` strings. The naming sweep targets only the non-engineer prose.
- **Square corners.** Outer surfaces `--r-lg` (12px), internals `--r-sm` (4px) or `--r-pill`. The 8px `--r` middle tier does not appear in this design.
- **Mono lowercase, body Sentence case.** See the capitalization rule in the spec.

---

***REMOVED******REMOVED*** File map

**New**
- `app/src/lib/palette.ts` — `PaletteName` type, `PALETTE` lookup of `{ bg, fg, glow }` per tint
- `app/src/components/CreateTableModal.tsx` — the modal
- `app/src/components/OptionBuilder.tsx` — shared inline option-row + add affordance (used by the modal and by the in-grid AddColumn widget)
- `server/src/tables.ts` — `createTable(input)` orchestrator
- `server/src/verify-tables.ts` — end-to-end verification script

**Renamed (file rename + import updates)**
- `app/src/components/DimensionPicker.tsx` → `app/src/components/TablePicker.tsx`
- `app/src/components/NoDimensionsYet.tsx` → `app/src/components/NoTablesYet.tsx`

**Modified**
- `app/src/tokens.css` — add 7 `--tint-*` CSS custom properties for both `:root` and `[data-theme="light"]`
- `app/src/data.ts` — `OptionDef`, `PaletteName`, extend `FieldDef`, extend `MappingDimension`
- `app/src/store.ts` — add `createTable()`, surface `description`/`color` on cached dims
- `app/src/components/datagrid/Chip.tsx` — accept optional `color: PaletteName | null`
- `app/src/components/datagrid/cells/SelectCell.tsx` — render chip with option color, editor shows color dot + swatch picker on `+ option`
- `app/src/components/datagrid/ColumnHeaderMenu.tsx` — option-list shows color dots; option-add lets you set a color
- `app/src/routes/MasterTables.tsx` — naming sweep, `select` added to `FIELD_TYPES`, in-grid `AddColumn` widget reuses `OptionBuilder`, opens `CreateTableModal` from the picker
- `app/src/routes/Mapping.tsx`, `Sources.tsx`, `Dashboard.tsx`, `Settings.tsx`, `BootGate.tsx` — copy sweep only
- `server/src/schema.ts` — `ALTER TABLE app.dimension ADD COLUMN IF NOT EXISTS description VARCHAR` and `… color VARCHAR`
- `server/src/repo.ts` — `getDimension` SELECTs `description`/`color`; `listFields` `parseOptions` normalizes both shapes; `addField` / `addColumnOption` accept `OptionDef[]` and `color`; mutators gain an optional `opts: { silent?: boolean }` parameter; existing callsites pass nothing (silent defaults to `false`)
- `server/src/server.ts` — new `POST /api/tables` route
- `server/package.json` — `"verify-tables": "bun run src/verify-tables.ts"` script

---

***REMOVED*** PHASE A · Foundation (schema, palette, shared types)

***REMOVED******REMOVED******REMOVED*** Task 1: Add `description` and `color` to `app.dimension`

**Files:**
- Modify: `server/src/schema.ts` (after the existing dimension ALTER block ~line 36-39)

- [ ] **Step 1: Read the existing dimension-schema block**

Open `server/src/schema.ts:23-40` so you understand the established `ADD COLUMN IF NOT EXISTS` pattern. The for-loop at line 36-38 ALTERs four columns idempotently — we're adding two more in the same shape.

- [ ] **Step 2: Add `description` and `color` to the existing ALTER loop**

In `server/src/schema.ts`, change the dimension ALTER loop (around line 36):

```ts
for (const col of [
  "key_kind VARCHAR",
  "name_table VARCHAR",
  "name_id_col VARCHAR",
  "name_col VARCHAR",
  "description VARCHAR",
  "color VARCHAR",
]) {
  await run(`ALTER TABLE ${pg("dimension")} ADD COLUMN IF NOT EXISTS ${col}`);
}
```

`color` stores the palette token name (`'rose'`), not a hex. Why: re-theming the palette stays a single-file CSS change.

- [ ] **Step 3: Run typecheck**

```bash
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Run bootstrap to apply the migration**

```bash
cd server && bun run bootstrap
```

Expected: prints "schema ok" / no errors. The new columns are added (and on re-runs they're no-ops).

- [ ] **Step 5: Commit**

```bash
git add server/src/schema.ts
git commit -m "feat(tables): add description and color columns to app.dimension"
```

---

***REMOVED******REMOVED******REMOVED*** Task 2: Curated palette CSS tokens

**Files:**
- Modify: `app/src/tokens.css`

- [ ] **Step 1: Read the existing token file**

Open `app/src/tokens.css`. Note that it's a generated file (header says `Generated by brand-guide/export_tokens.py`). We're going to append new tokens *after* the generated block in both `:root` and `[data-theme="light"]`. Brand owners can later move them upstream into the generator. Leave a comment explaining why they're appended manually.

- [ ] **Step 2: Append the 7-tint palette to `:root`**

Append immediately before the closing `}` of `:root` (around line 35):

```css
  /* Per-table palette — appended outside the generated block; see palette.ts.
     Move upstream once the brand guide adds a 'tints' export. */
  --tint-rose:   ***REMOVED***D6336C;
  --tint-amber:  ***REMOVED***F0A323;
  --tint-mint:   ***REMOVED***30A46C;
  --tint-teal:   ***REMOVED***1FA9B8;
  --tint-indigo: ***REMOVED***6E63E0;
  --tint-violet: ***REMOVED***A24EE0;
  --tint-slate:  ***REMOVED***6B7A95;
```

- [ ] **Step 3: Append the same set to `[data-theme="light"]`**

Append before the closing `}` of `[data-theme="light"]` (around line 57). Use slightly darker variants where needed for readability on light surface (these match the dark-theme values closely; the brand uses the same hue set):

```css
  --tint-rose:   ***REMOVED***D6336C;
  --tint-amber:  ***REMOVED***C68410;
  --tint-mint:   ***REMOVED***2A8C5E;
  --tint-teal:   ***REMOVED***1B8E9C;
  --tint-indigo: ***REMOVED***5A50C7;
  --tint-violet: ***REMOVED***8A3FBA;
  --tint-slate:  ***REMOVED***57637C;
```

- [ ] **Step 4: Smoke test the tokens in dev**

```bash
cd app && bun run dev
```

In the dev browser, open the devtools and inspect `:root` styles — verify the 7 `--tint-*` variables appear. Stop the dev server with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add app/src/tokens.css
git commit -m "feat(tables): add 7-tint curated palette tokens (light + dark)"
```

---

***REMOVED******REMOVED******REMOVED*** Task 3: `palette.ts` lookup

**Files:**
- Create: `app/src/lib/palette.ts`

- [ ] **Step 1: Create the palette module**

```ts
/* palette.ts — curated 7-tint palette used for per-table monograms and per-option
   chips. The hex values live in tokens.css; this file is the typed surface React
   code consumes. Adding a tint = new entry here + matching --tint-* in tokens.css. */

export type PaletteName = "rose" | "amber" | "mint" | "teal" | "indigo" | "violet" | "slate";

export const PALETTE_NAMES: PaletteName[] = ["rose", "amber", "mint", "teal", "indigo", "violet", "slate"];

interface TintEntry {
  /** CSS var reference used as the chip / monogram background. */
  bg: string;
  /** CSS color-mix expression for the chip border / monogram glow. */
  border: string;
  /** CSS color-mix expression for the wash background behind a chip. */
  wash: string;
  /** Foreground color tuned for readability on the wash background (dark theme). */
  fg: string;
}

export const PALETTE: Record<PaletteName, TintEntry> = {
  rose:   { bg: "var(--tint-rose)",   border: "color-mix(in srgb,var(--tint-rose) 35%,transparent)",   wash: "color-mix(in srgb,var(--tint-rose) 18%,transparent)",   fg: "***REMOVED***FF8FB1" },
  amber:  { bg: "var(--tint-amber)",  border: "color-mix(in srgb,var(--tint-amber) 35%,transparent)",  wash: "color-mix(in srgb,var(--tint-amber) 18%,transparent)",  fg: "***REMOVED***F7C76A" },
  mint:   { bg: "var(--tint-mint)",   border: "color-mix(in srgb,var(--tint-mint) 35%,transparent)",   wash: "color-mix(in srgb,var(--tint-mint) 18%,transparent)",   fg: "***REMOVED***7DDEAA" },
  teal:   { bg: "var(--tint-teal)",   border: "color-mix(in srgb,var(--tint-teal) 35%,transparent)",   wash: "color-mix(in srgb,var(--tint-teal) 18%,transparent)",   fg: "***REMOVED***74E0EA" },
  indigo: { bg: "var(--tint-indigo)", border: "color-mix(in srgb,var(--tint-indigo) 35%,transparent)", wash: "color-mix(in srgb,var(--tint-indigo) 18%,transparent)", fg: "***REMOVED***A89FF0" },
  violet: { bg: "var(--tint-violet)", border: "color-mix(in srgb,var(--tint-violet) 35%,transparent)", wash: "color-mix(in srgb,var(--tint-violet) 18%,transparent)", fg: "***REMOVED***C68DF0" },
  slate:  { bg: "var(--tint-slate)",  border: "color-mix(in srgb,var(--tint-slate) 35%,transparent)",  wash: "color-mix(in srgb,var(--tint-slate) 18%,transparent)",  fg: "***REMOVED***A4B0C8" },
};

/** Round-robin a tint based on a stable string (e.g. table id). Used to pick a
 *  default monogram color for a freshly-created table so the picker isn't all
 *  rose. The caller can still override via the swatch picker. */
export function defaultTintFor(seed: string): PaletteName {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE_NAMES[Math.abs(h) % PALETTE_NAMES.length];
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/palette.ts
git commit -m "feat(tables): palette.ts — typed lookup over the 7-tint CSS tokens"
```

---

***REMOVED******REMOVED******REMOVED*** Task 4: Client types — `OptionDef`, `PaletteName`, dimension extensions

**Files:**
- Modify: `app/src/data.ts`

- [ ] **Step 1: Replace the `FieldDef` and `MappingDimension` types**

In `app/src/data.ts`, replace the existing `FieldDef` definition (line 27):

```ts
import type { PaletteName } from "./lib/palette";
export type { PaletteName } from "./lib/palette";

/** A predetermined option on a single-select field, with optional color. */
export interface OptionDef { label: string; color: PaletteName | null }

/* an enrichment attribute column on a dimension (e.g. currency, locale) */
export interface FieldDef { field: string; label: string; type: string; options?: OptionDef[] }
```

And extend `MappingDimension` (line 41) to add the two new optional identity fields. After `keyKind?: …`, add:

```ts
  /** Optional human description shown under the name in TablePicker. */
  description?: string | null;
  /** Curated palette token for the monogram. null = fall back to --accent. */
  color?: PaletteName | null;
```

- [ ] **Step 2: Run typecheck — expect failures (good!)**

```bash
cd app && bun run typecheck
```

Expected: errors in any callsite that destructured `f.options` as `string[]`. Note the failing files — we'll fix them in subsequent tasks. The error stream IS the worklist for the option-shape sweep.

- [ ] **Step 3: Commit (the type change with intentional cascading failures)**

```bash
git add app/src/data.ts
git commit -m "feat(tables): OptionDef shape (label+color), PaletteName on MappingDimension"
```

> Note: the next several client-side tasks fix the callsites this type change broke. Do not push to main until typecheck is green at the end of Task 11.

---

***REMOVED*** PHASE B · Server changes

***REMOVED******REMOVED******REMOVED*** Task 5: `listFields` reads both shapes; new internal helper

**Files:**
- Modify: `server/src/repo.ts` (`listFields` at line 632, `parseOptions` helper added)

- [ ] **Step 1: Add the `OptionDef` type and `parseOptions` helper**

At the top of `repo.ts` (after the existing imports), add:

```ts
/** Curated palette token. Mirror of app/src/lib/palette.ts so the server can
 *  validate inbound values without a shared module. */
export type PaletteName = "rose" | "amber" | "mint" | "teal" | "indigo" | "violet" | "slate";
const PALETTE_NAMES: PaletteName[] = ["rose", "amber", "mint", "teal", "indigo", "violet", "slate"];

export interface OptionDef { label: string; color: PaletteName | null }

/** Read on-disk option JSON in both shapes. Legacy `string[]` lifts to
 *  `[{ label, color: null }]`; the new `{ label, color }` shape passes through.
 *  Non-array / malformed JSON returns `undefined`. */
export function parseOptions(raw: unknown): OptionDef[] | undefined {
  let arr: unknown = raw;
  if (typeof arr === "string" && arr.length > 0) {
    try { arr = JSON.parse(arr); } catch { return undefined; }
  }
  if (!Array.isArray(arr)) return undefined;
  return arr.map((o) => {
    if (typeof o === "string") return { label: o, color: null };
    if (o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string") {
      const color = (o as { color?: unknown }).color;
      return {
        label: (o as { label: string }).label,
        color: typeof color === "string" && PALETTE_NAMES.includes(color as PaletteName) ? color as PaletteName : null,
      };
    }
    return { label: String(o), color: null };
  });
}
```

- [ ] **Step 2: Update the existing `FieldDef` server-side definition**

If `FieldDef` is defined in `server/src/repo.ts` (check the file — it may be `interface FieldDef { … options?: string[] }`), replace `options?: string[]` with `options?: OptionDef[]`. If the type is imported from elsewhere, adjust there.

```ts
export interface FieldDef { field: string; label: string; type: string; options?: OptionDef[] }
```

- [ ] **Step 3: Update `listFields` to use `parseOptions`**

Replace the body of `listFields` (currently `server/src/repo.ts:632-645`) with:

```ts
export async function listFields(dimId: string): Promise<FieldDef[]> {
  const rows = await all<{ field: string; label: string; type: string; options: unknown }>(
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
```

- [ ] **Step 4: Typecheck — expect failures at callsites assuming `string[]`**

```bash
cd server && bun run typecheck
```

Expected: errors at `addField`, `addColumnOption`, `changeColumnType` callsites where `options` is typed as `string[]`. These get fixed in Task 6.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(tables): parseOptions reads both legacy string[] and new {label,color}[] shapes"
```

---

***REMOVED******REMOVED******REMOVED*** Task 6: `addField`, `addColumnOption`, `changeColumnType` accept `OptionDef[]`

**Files:**
- Modify: `server/src/repo.ts` (`addField` ~line 655, `addColumnOption` ~line 818, `changeColumnType` ~line 683)

- [ ] **Step 1: Update `addField` signature and options handling**

Replace `addField` body (around line 655) with:

```ts
export async function addField(
  dimId: string,
  label: string,
  type = "text",
  options?: OptionDef[],
  opts: { silent?: boolean } = {},
): Promise<{ field: string } | null> {
  const m = await dimMeta(dimId);
  if (!m) return null;
  const t = SQL_TYPE[type] ? type : (type === "select" ? "select" : "text");
  const field = slug(label);
  if (!field || field === "label" || field === slug(m.keyCol)) return null; // reserved
  const sqlType = t === "select" ? "VARCHAR" : SQL_TYPE[t];
  await run(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN IF NOT EXISTS ${qid(field)} ${sqlType}`);
  const optsJson = t === "select" ? JSON.stringify(options ?? []) : null;
  await run(
    `INSERT INTO ${pg("dimension_field")} (dim_id, field, label, type, options, created_at) VALUES ($1,$2,$3,$4,$5, current_timestamp)
     ON CONFLICT (dim_id, field) DO NOTHING`, [dimId, field, label.trim(), t, optsJson]);
  if (!opts.silent) {
    await appendAudit("Added field", `${label.trim()} (${field}, ${t}) → ${m.dimTable}`);
  }
  return { field };
}
```

The signature change is `options?: string[]` → `options?: OptionDef[]` plus a new `opts: { silent?: boolean }` parameter (defaults to `{}` so existing callers are unaffected).

- [ ] **Step 2: Update `addColumnOption` to accept a color**

Find `addColumnOption` (around line 818). Replace it with:

```ts
export async function addColumnOption(
  dimId: string,
  field: string,
  label: string,
  color: PaletteName | null = null,
  opts: { silent?: boolean } = {},
): Promise<{ options: OptionDef[] } | null> {
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f || f.type !== "select") return null;
  const existing = f.options ?? [];
  if (existing.some((o) => o.label === label)) return { options: existing };
  const next: OptionDef[] = [...existing, { label, color }];
  await run(
    `UPDATE ${pg("dimension_field")} SET options = $1 WHERE dim_id = $2 AND field = $3`,
    [JSON.stringify(next), dimId, field],
  );
  if (!opts.silent) {
    await appendAudit("Added field option", `${field} += "${label}"${color ? ` (${color})` : ""}`);
  }
  return { options: next };
}
```

- [ ] **Step 3: Update `changeColumnType` to accept `OptionDef[]` for select**

Find `changeColumnType` (around line 683). The signature currently declares `options?: string[]`. Change it to `options?: OptionDef[]` and update the internal `finalOptions` collection so it produces `OptionDef[]`:

```ts
export async function changeColumnType(
  dimId: string,
  field: string,
  newType: string,
  options?: OptionDef[],
  coerceInvalidToNull = false,
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
```

In the body, replace the two `options ?? […]` references inside the `newType === "select"` branches with logic that produces `OptionDef[]` from string distinct values when the caller didn't pass options:

```ts
// Around line 706, where `collected` is built for select validation:
const collected: OptionDef[] = options ?? [...new Set(rows.filter((x) => x.v).map((x) => x.v!))].map((label) => ({ label, color: null }));
const ok = collected.some((o) => o.label === r.v);

// Around line 744:
finalOptions = options ?? [...new Set(parsed.filter((p) => p.v != null).map((p) => String(p.v)))].map((label) => ({ label, color: null }));

// Around line 758 (the UPDATE):
[newType, newType === "select" ? JSON.stringify(finalOptions ?? []) : null, dimId, field],

// Around the audit at line 764:
await appendAudit("Changed column type", `${field} → ${newType}${finalOptions ? ` (${finalOptions.length} options)` : ""}`);
```

- [ ] **Step 4: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: clean. If there are remaining errors, they're in callsites of these three functions — fix the type expectation, not the body.

- [ ] **Step 5: Update the server.ts route bodies to accept the new shapes**

In `server/src/server.ts:191-201`, update the field-related routes:

```ts
// POST /api/dimensions/:id/fields {label, type?, options?}
if (seg[3] === "fields" && seg.length === 4 && method === "POST") {
  const { label, type, options } = (await req.json()) as { label: string; type?: string; options?: { label: string; color: string | null }[] };
  return json(await repo.addField(id, label, type, options as repo.OptionDef[] | undefined));
}
// POST /api/dimensions/:id/fields/:field/options {label, color?}
if (seg[3] === "fields" && seg[5] === "options" && seg.length === 6 && method === "POST") {
  const field = decodeURIComponent(seg[4]!);
  const { label, color } = (await req.json()) as { label: string; color?: string | null };
  const res = await repo.addColumnOption(id, field, label, (color ?? null) as repo.PaletteName | null);
  return res ? json(res) : json({ error: "not a select column" }, 400);
}
```

And the `PUT /api/dimensions/:id/fields/:field` body type (line 206) gains options as the new shape:

```ts
const body = (await req.json()) as {
  label?: string;
  type?: string;
  options?: { label: string; color: string | null }[];
  coerceInvalidToNull?: boolean;
};
```

The cast to `repo.OptionDef[]` happens only at the seam; downstream code uses the typed shape.

- [ ] **Step 6: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/repo.ts server/src/server.ts
git commit -m "feat(tables): addField/addColumnOption/changeColumnType accept OptionDef + silent flag"
```

---

***REMOVED******REMOVED******REMOVED*** Task 7: `silent` flag on `addDimension`, `addSource`, `deriveCanonical`

**Files:**
- Modify: `server/src/repo.ts` (`addDimension` ~line 535, `addSource` ~line 238, `deriveCanonical` ~line 340)

- [ ] **Step 1: Add `silent` to `addDimension`**

Replace `addDimension` signature and audit line:

```ts
export async function addDimension(
  name: string,
  sources: SourceDef[] = [],
  opts: { keyKind?: "slug" | "external_id"; silent?: boolean } = {},
): Promise<string> {
  // ... existing body unchanged through line 555 ...
  if (!opts.silent) {
    await appendAudit("Created dimension", `${name.trim()} → dim_${id} + map_${id}${keyKind === "external_id" ? " (external-ID key)" : ""}`);
  }
  // ... rest unchanged ...
}
```

- [ ] **Step 2: Add `silent` to `addSource`**

Find `addSource` (line 238). If it emits audit (check the body), wrap the audit call in `if (!opts.silent)`. If `addSource` doesn't emit audit, add the `opts: { silent?: boolean } = {}` parameter anyway for shape symmetry — the orchestrator will pass it through.

```ts
export async function addSource(
  dimId: string,
  table: string,
  column: string,
  opts: { silent?: boolean } = {},
): Promise<void> {
  // ... existing body ...
  // If there's an appendAudit call here, wrap in: if (!opts.silent) { … }
}
```

- [ ] **Step 3: Add `silent` to `deriveCanonical`**

Same pattern for `deriveCanonical` (line 340). Add the param, wrap the audit call.

```ts
export async function deriveCanonical(
  dimId: string,
  table: string,
  column: string,
  nameColumn?: string,
  opts: { silent?: boolean } = {},
): Promise<{ derived: number }> {
  // ... existing body ...
  // wrap the appendAudit("Imported …") at the end
}
```

- [ ] **Step 4: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: clean. (Existing callsites pass no `opts` and the parameter is defaulted, so nothing breaks.)

- [ ] **Step 5: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(tables): silent flag on addDimension/addSource/deriveCanonical for batch orchestration"
```

---

***REMOVED******REMOVED******REMOVED*** Task 8: `getDimension` returns `description` and `color`

**Files:**
- Modify: `server/src/repo.ts` (`getDimension` ~line 441)

- [ ] **Step 1: Extend the SELECT in `getDimension` to include the new columns**

Replace the metadata query in `getDimension` (line 442) with:

```ts
const meta = await get<
  Omit<DimensionMeta, "rows"> & {
    nameTable: string | null;
    nameIdCol: string | null;
    nameCol: string | null;
    description: string | null;
    color: string | null;
  }
>(
  `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol",
          COALESCE(key_kind, 'slug') AS "keyKind",
          name_table AS "nameTable", name_id_col AS "nameIdCol", name_col AS "nameCol",
          description, color
   FROM ${pg("dimension")} WHERE id = $1`, [id],
);
```

- [ ] **Step 2: Update the return shape to surface `description` and `color`**

At the end of `getDimension` (around line 480), the return currently does:

```ts
const { nameTable, nameIdCol, nameCol, ...metaOut } = meta;
return { ...metaOut, rows: Number(rowsRow?.n ?? 0), canonical, values, fields };
```

Change the destructure to also exclude raw types and add `description`/`color` to the surfaced shape:

```ts
const { nameTable, nameIdCol, nameCol, description, color, ...metaOut } = meta;
const PALETTE_NAMES = ["rose","amber","mint","teal","indigo","violet","slate"] as const;
const safeColor = typeof color === "string" && (PALETTE_NAMES as readonly string[]).includes(color)
  ? color as PaletteName
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
```

- [ ] **Step 3: Extend the `MappingDimension` server-side type**

If `MappingDimension` is declared in `server/src/repo.ts` (it likely is — check around the top imports), add the two fields:

```ts
export interface MappingDimension {
  // ... existing fields ...
  description: string | null;
  color: PaletteName | null;
}
```

- [ ] **Step 4: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat(tables): getDimension returns description and color"
```

---

***REMOVED******REMOVED******REMOVED*** Task 9: `tables.ts` orchestrator + `POST /api/tables` route

**Files:**
- Create: `server/src/tables.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: Create `server/src/tables.ts`**

```ts
/* tables.ts — POST /api/tables orchestrator. Composes the existing repo
   primitives (addDimension, addField, addColumnOption, addSource, deriveCanonical)
   inside a single Postgres transaction with one consolidated audit entry. The
   per-primitive audit emissions are suppressed via `silent: true`; the wrapper
   emits one summary entry at the end. */

import * as repo from "./repo.ts";
import type { OptionDef, PaletteName } from "./repo.ts";
import { run, get } from "./db.ts";
import { pg } from "./env.ts";
import { env } from "./env.ts";
import { slug } from "./repo.ts"; // exported util

const PALETTE_NAMES: PaletteName[] = ["rose", "amber", "mint", "teal", "indigo", "violet", "slate"];

export type CreateTableMode = "blank" | "source" | "external_id";

export interface ColumnDraft {
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select";
  options?: OptionDef[];
}

export interface CreateTableInput {
  name: string;
  description?: string | null;
  color?: PaletteName | null;
  mode: CreateTableMode;
  columns?: ColumnDraft[];                                        // mode === 'blank'
  source?: { table: string; column: string };                     // mode === 'source'
  external?: { table: string; idColumn: string; nameColumn: string }; // mode === 'external_id'
}

export type CreateTableErrorCode = "NAME_TAKEN" | "WAREHOUSE_OFFLINE" | "MISSING_PICKER" | "INVALID";

export class CreateTableError extends Error {
  code: CreateTableErrorCode;
  constructor(code: CreateTableErrorCode, message: string) { super(message); this.code = code; }
}

function validate(input: CreateTableInput): void {
  const name = (input.name ?? "").trim();
  if (!name) throw new CreateTableError("INVALID", "name is required");
  if (input.color != null && !PALETTE_NAMES.includes(input.color)) {
    throw new CreateTableError("INVALID", `unknown color: ${input.color}`);
  }
  if (input.mode === "source") {
    if (!input.source?.table || !input.source?.column) {
      throw new CreateTableError("MISSING_PICKER", "source requires table + column");
    }
  } else if (input.mode === "external_id") {
    const e = input.external;
    if (!e?.table || !e?.idColumn || !e?.nameColumn) {
      throw new CreateTableError("MISSING_PICKER", "external_id requires table + idColumn + nameColumn");
    }
    if (e.idColumn === e.nameColumn) {
      throw new CreateTableError("INVALID", "idColumn and nameColumn must differ");
    }
  } else if (input.mode === "blank") {
    for (const c of input.columns ?? []) {
      if (!c.label?.trim()) throw new CreateTableError("INVALID", "field label is required");
      if (c.type === "select" && c.options) {
        const labels = c.options.map((o) => o.label);
        if (new Set(labels).size !== labels.length) {
          throw new CreateTableError("INVALID", `duplicate option labels in field "${c.label}"`);
        }
      }
    }
  }
  if ((input.mode === "source" || input.mode === "external_id") && !env.attachWarehouse) {
    throw new CreateTableError("WAREHOUSE_OFFLINE", "warehouse is not attached");
  }
}

export async function createTable(input: CreateTableInput): Promise<{ id: string }> {
  validate(input);
  const name = input.name.trim();
  const id = slug(name);

  // Pre-flight existence check (also enforced by PK)
  const existing = await get(`SELECT id FROM ${pg("dimension")} WHERE id = $1`, [id]);
  if (existing) throw new CreateTableError("NAME_TAKEN", `a table called "${name}" already exists`);

  await run("BEGIN");
  try {
    // 1. Identity
    const keyKind = input.mode === "external_id" ? "external_id" : "slug";
    await repo.addDimension(name, [], { keyKind, silent: true });

    // 2. Identity extras (description, color)
    await run(
      `UPDATE ${pg("dimension")} SET description = $1, color = $2 WHERE id = $3`,
      [input.description?.trim() || null, input.color ?? null, id],
    );

    // 3. Source binding(s)
    if (input.mode === "source" && input.source) {
      await repo.addSource(id, input.source.table, input.source.column, { silent: true });
    }
    if (input.mode === "external_id" && input.external) {
      await repo.addSource(id, input.external.table, input.external.idColumn, { silent: true });
      // External-ID also needs the name binding; this lives on the dimension row
      await run(
        `UPDATE ${pg("dimension")} SET name_table = $1, name_id_col = $2, name_col = $3 WHERE id = $4`,
        [input.external.table, input.external.idColumn, input.external.nameColumn, id],
      );
    }

    // 4. Fields (blank mode)
    let fieldCount = 0;
    if (input.mode === "blank" && input.columns) {
      for (const c of input.columns) {
        await repo.addField(id, c.label.trim(), c.type, c.options, { silent: true });
        fieldCount++;
      }
    }

    // 5. Seeding (source / external_id modes)
    let derivedCount = 0;
    if (input.mode === "source" && input.source) {
      const r = await repo.deriveCanonical(id, input.source.table, input.source.column, undefined, { silent: true });
      derivedCount = r.derived;
    }
    if (input.mode === "external_id" && input.external) {
      const r = await repo.deriveCanonical(id, input.external.table, input.external.idColumn, input.external.nameColumn, { silent: true });
      derivedCount = r.derived;
    }

    // 6. Consolidated audit
    const detail =
      input.mode === "blank" ? `${name} · blank · ${fieldCount} field${fieldCount === 1 ? "" : "s"}`
      : input.mode === "source" ? `${name} · from ${input.source!.table}.${input.source!.column} · derived ${derivedCount}`
      : `${name} · from IDs ${input.external!.table}.${input.external!.idColumn} (names ← ${input.external!.nameColumn}) · derived ${derivedCount}`;
    await repo.appendAudit("Created table", detail);

    await run("COMMIT");
  } catch (e) {
    await run("ROLLBACK");
    throw e;
  }
  return { id };
}
```

Note: this references `slug` exported from `repo.ts`. If it's not currently exported, export it:

```ts
// in server/src/repo.ts, find the slug function and add `export`:
export const slug = (s: string): string => …
```

- [ ] **Step 2: Add the `POST /api/tables` route**

In `server/src/server.ts`, add a new route handler block alongside the existing `seg[1] === "dimensions"` block (around line 145). Place it before that block so the URL is distinct:

```ts
import * as tables from "./tables.ts";
import { CreateTableError } from "./tables.ts";

// ... inside the request handler, after auth:

if (seg[1] === "tables") {
  if (seg.length === 2 && method === "POST") {
    try {
      const input = (await req.json()) as tables.CreateTableInput;
      const result = await tables.createTable(input);
      return json(result, 201);
    } catch (e) {
      if (e instanceof CreateTableError) {
        return json({ error: e.message, code: e.code }, 400);
      }
      throw e;
    }
  }
  return json({ error: "not found" }, 404);
}
```

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Smoke run the server**

```bash
cd server && bun run start
```

Expected: server starts on port 8787 without errors. Stop with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add server/src/tables.ts server/src/server.ts server/src/repo.ts
git commit -m "feat(tables): POST /api/tables orchestrator (createTable) with consolidated audit"
```

---

***REMOVED******REMOVED******REMOVED*** Task 10: `verify-tables.ts` end-to-end script

**Files:**
- Create: `server/src/verify-tables.ts`
- Modify: `server/package.json`

- [ ] **Step 1: Create the verify script**

Mirror the pattern used in `server/src/verify-datagrid.ts` (step/assert/cleanup/scoped-prefix). Create `server/src/verify-tables.ts`:

```ts
/* verify-tables.ts — end-to-end check of POST /api/tables (createTable) against
   the REAL Postgres. Self-cleaning: drops any rows it created.

   Run: `bun run verify-tables`. */

import { createTable, CreateTableError } from "./tables.ts";
import * as repo from "./repo.ts";
import { ensureSchema } from "./schema.ts";
import { run, get } from "./db.ts";
import { pg } from "./env.ts";

const SCOPE = "tbl_verify_" + Math.random().toString(36).slice(2, 8);

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`▸ ${label} … `);
  const t = Date.now();
  try { const r = await fn(); process.stdout.write(`ok (${Date.now() - t}ms)\n`); return r; }
  catch (e) { process.stdout.write("FAIL\n"); throw e; }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assert: " + msg);
}

async function cleanup(): Promise<void> {
  try { await run(`DELETE FROM ${pg("dimension_field")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]); } catch {}
  try { await run(`DELETE FROM ${pg("dimension_source")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]); } catch {}
  try { await run(`DELETE FROM ${pg("dimension")} WHERE id LIKE $1`, [`${SCOPE}%`]); } catch {}
}

(async () => {
  await ensureSchema();
  await step("clean prior scope rows", cleanup);

  // ─── 1. Blank mode with 2 columns including a colored select ─────────────
  const blankName = `${SCOPE} risk`;
  const { id: blankId } = await step("createTable(blank, 2 columns inc. select)", () =>
    createTable({
      name: blankName,
      description: "Severity tier for incidents.",
      color: "rose",
      mode: "blank",
      columns: [
        { label: "Severity", type: "select", options: [
          { label: "high", color: "rose" },
          { label: "medium", color: "amber" },
          { label: "low", color: "mint" },
        ]},
        { label: "Owner", type: "text" },
      ],
    }),
  );
  assert(blankId.startsWith(SCOPE), `dimId should start with scope; got ${blankId}`);

  await step("blank dim has description + color", async () => {
    const row = await get<{ description: string | null; color: string | null }>(
      `SELECT description, color FROM ${pg("dimension")} WHERE id = $1`, [blankId],
    );
    assert(row?.description === "Severity tier for incidents.", `description mismatch: ${row?.description}`);
    assert(row?.color === "rose", `color mismatch: ${row?.color}`);
  });

  await step("blank dim has 2 fields with the new option shape", async () => {
    const fields = await repo.listFields(blankId);
    assert(fields.length === 2, `expected 2 fields, got ${fields.length}`);
    const sev = fields.find((f) => f.field === "severity");
    assert(sev?.type === "select", "severity is select");
    assert(sev?.options?.length === 3, `expected 3 options, got ${sev?.options?.length}`);
    assert(sev?.options?.[0].label === "high" && sev.options[0].color === "rose", "first option label+color");
  });

  await step("blank: one consolidated audit entry exists", async () => {
    const audit = await repo.listAudit(50);
    const tableAudits = audit.filter((a) => a.detail.startsWith(blankName));
    assert(tableAudits.length === 1, `expected 1 audit entry, got ${tableAudits.length}`);
    assert(tableAudits[0].action === "Created table", `action: ${tableAudits[0].action}`);
  });

  // ─── 2. Validation: name collision ───────────────────────────────────────
  await step("collision returns NAME_TAKEN", async () => {
    try {
      await createTable({ name: blankName, mode: "blank" });
      throw new Error("expected NAME_TAKEN");
    } catch (e) {
      assert(e instanceof CreateTableError && e.code === "NAME_TAKEN", `expected NAME_TAKEN, got ${(e as Error).message}`);
    }
  });

  // ─── 3. Validation: blank with empty name ────────────────────────────────
  await step("empty name returns INVALID", async () => {
    try {
      await createTable({ name: "  ", mode: "blank" });
      throw new Error("expected INVALID");
    } catch (e) {
      assert(e instanceof CreateTableError && e.code === "INVALID", `expected INVALID, got ${(e as Error).message}`);
    }
  });

  // ─── 4. Validation: source mode without source picker ────────────────────
  await step("source without picker returns MISSING_PICKER", async () => {
    try {
      await createTable({ name: `${SCOPE} no_pick`, mode: "source" });
      throw new Error("expected MISSING_PICKER");
    } catch (e) {
      assert(e instanceof CreateTableError, `expected CreateTableError, got ${(e as Error).message}`);
      // Either MISSING_PICKER (no source) or WAREHOUSE_OFFLINE — depends on env.attachWarehouse
    }
  });

  // ─── 5. Lazy option migration: legacy string[] reads as OptionDef[] ──────
  await step("legacy string[] options read as {label, color: null}", async () => {
    // Synthesize a legacy row directly via SQL (bypassing addField)
    const legacyId = `${SCOPE} legacy`;
    await repo.addDimension(`${SCOPE} legacy`, [], { silent: true });
    await run(
      `ALTER TABLE ${pg("dimension")} SET description = NULL WHERE id = $1`, // no-op safe
      [legacyId],
    );
    await repo.addField(legacyId, "Status", "select", undefined, { silent: true });
    await run(
      `UPDATE ${pg("dimension_field")} SET options = $1 WHERE dim_id = $2 AND field = 'status'`,
      [JSON.stringify(["open", "closed"]), legacyId],
    );
    const fields = await repo.listFields(legacyId);
    const status = fields.find((f) => f.field === "status");
    assert(status?.options?.length === 2, `expected 2 lifted options, got ${status?.options?.length}`);
    assert(status?.options?.[0].label === "open" && status.options[0].color === null, "first option lifted with null color");
  });

  await step("cleanup", cleanup);
  console.log("\n✓ verify-tables passed");
  process.exit(0);
})().catch((e) => {
  console.error("\nverify-tables FAILED:", e);
  void cleanup().finally(() => process.exit(1));
});
```

- [ ] **Step 2: Add the script entry to `server/package.json`**

In `server/package.json`, after the existing `verify-datagrid` line, add:

```json
"verify-tables": "bun run src/verify-tables.ts",
```

- [ ] **Step 3: Run the verification script**

```bash
cd server && bun run verify-tables
```

Expected output: lines like `▸ createTable(blank, 2 columns inc. select) … ok (12ms)` for each step, ending with `✓ verify-tables passed`.

If any step fails, fix the underlying code (not the assertion).

- [ ] **Step 4: Commit**

```bash
git add server/src/verify-tables.ts server/package.json
git commit -m "test(tables): verify-tables end-to-end script for POST /api/tables"
```

---

***REMOVED*** PHASE C · Client primitives

***REMOVED******REMOVED******REMOVED*** Task 11: `Chip` accepts color

**Files:**
- Modify: `app/src/components/datagrid/Chip.tsx`

- [ ] **Step 1: Read the current Chip implementation**

Open `app/src/components/datagrid/Chip.tsx`. Note its current props (probably `{ label: string }` only).

- [ ] **Step 2: Add a color prop**

Replace the file with:

```tsx
import type { PaletteName } from "../../lib/palette";
import { PALETTE } from "../../lib/palette";

interface ChipProps {
  label: string;
  /** Curated palette tint. `null` / undefined renders the neutral chip. */
  color?: PaletteName | null;
}

export function Chip({ label, color }: ChipProps) {
  if (!color) {
    // Neutral chip — today's appearance (surface-3 background, ink-2 text)
    return (
      <span className="inline-flex items-center rounded-pill border border-line bg-surface-3 px-2.5 py-0.5 font-mono text-[10.5px] text-ink-2">
        {label}
      </span>
    );
  }
  const tint = PALETTE[color];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 font-mono text-[10.5px]"
      style={{ background: tint.wash, color: tint.fg, borderColor: tint.border }}
    >
      <span className="h-1.5 w-1.5 rounded-pill" style={{ background: tint.bg }} />
      {label}
    </span>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: errors at callsites of `Chip` (if any) where the call relied on a different prop name. There should be zero — `label` is unchanged.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/Chip.tsx
git commit -m "feat(grid): Chip accepts optional palette color (dot + tinted wash)"
```

---

***REMOVED******REMOVED******REMOVED*** Task 12: `SelectCell` renders color; editor picks color on `+ option`

**Files:**
- Modify: `app/src/components/datagrid/cells/SelectCell.tsx`

- [ ] **Step 1: Update the renderer to read color from options**

The cell value is the option's label (string). The cell context doesn't have the column's options today — `SelectCell.Renderer` is called with `value`, but not with the column's option list. We need to look up the color from the column's `options`. Looking at `SelectCell.tsx`:

```tsx
function Renderer<Row>({ value }: CellCtx<Row>) { /* ... */ }
```

It only receives `value` (the label). To render the color we need the column's options. Update `CellCtx` to include the column def:

Look at `app/src/components/datagrid/types.ts:25-32` for `CellCtx`:

```ts
export interface CellCtx<Row> {
  row: Row;
  rowKey: string;
  field: string;
  value: unknown;
  focused: boolean;
}
```

Extend it to include `column`:

```ts
export interface CellCtx<Row> {
  row: Row;
  rowKey: string;
  field: string;
  value: unknown;
  focused: boolean;
  /** The column definition for this cell — used by SelectCell to look up option colors. */
  column: ColumnDef<Row>;
}
```

This propagates through `DataGrid.tsx` — wherever `CellCtx` is constructed (search for `{ row,` / `{ rowKey,` and the renderer-call site) add `column,`.

- [ ] **Step 2: Update `SelectCell.Renderer` to render the colored chip**

Replace `Renderer` in `SelectCell.tsx`:

```tsx
import type { CellCtx, EditCtx } from "../types";
import type { OptionDef } from "../../../data";
import type { PaletteName } from "../../../lib/palette";
import { Chip } from "../Chip";

function Renderer<Row>({ value, column }: CellCtx<Row>) {
  if (value == null || value === "") {
    return <span className="font-mono text-[12px] text-ink-3">—</span>;
  }
  const label = String(value);
  const opt = column.options?.find((o) => o.label === label);
  return <Chip label={label} color={opt?.color ?? null} />;
}
```

Note `column.options` is now `OptionDef[]`. The `Chip` import path is `../Chip` (relative).

- [ ] **Step 3: Update `ColumnDef.options` type in types.ts**

In `app/src/components/datagrid/types.ts` (line 14):

```ts
options?: OptionDef[];                 // only set when type === "select"
```

Add the import at the top:

```ts
import type { OptionDef } from "../../data";
```

- [ ] **Step 4: Update the editor to show color dots + swatch picker on `+ option`**

Replace the `Editor` function in `SelectCell.tsx`:

```tsx
import { PALETTE, PALETTE_NAMES } from "../../../lib/palette";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OptionDef } from "../../../data";

interface SelectEditorProps<Row> extends EditCtx<Row> {
  options: OptionDef[];
  /** Host hook — creates an option with optional color. Returns the new list. */
  onCreate: (label: string, color: PaletteName | null) => Promise<OptionDef[]>;
}

function Editor<Row>(props: SelectEditorProps<Row>) {
  const { value, commit, cancel, options, onCreate } = props;
  const [opts, setOpts] = useState(options);
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const [pickedColor, setPickedColor] = useState<PaletteName | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return opts;
    return opts.filter((o) => o.label.toLowerCase().includes(needle));
  }, [opts, q]);
  const exact = filtered.some((o) => o.label.toLowerCase() === q.trim().toLowerCase());
  const canCreate = q.trim().length > 0 && !exact;

  const choose = (label: string) => commit(label);
  const create = async () => {
    const label = q.trim();
    if (!label) return;
    const next = await onCreate(label, pickedColor);
    setOpts(next);
    commit(label);
  };

  return (
    <div className="absolute left-0 top-0 z-30 w-[240px] rounded-sm border border-line-2 bg-surface p-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef} value={q}
        placeholder="search or create…"
        onChange={(e) => { setQ(e.target.value); setHl(0); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(filtered.length, h + 1)); return; }
          if (e.key === "ArrowUp")   { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); return; }
          if (e.key === "Enter") {
            e.preventDefault();
            if (hl < filtered.length) choose(filtered[hl].label);
            else if (canCreate) void create();
            return;
          }
        }}
        className="mb-1 w-full rounded-sm border border-line-2 bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
      />
      <div className="max-h-48 overflow-y-auto">
        {filtered.map((o, i) => (
          <button
            key={o.label} type="button"
            onMouseEnter={() => setHl(i)}
            onMouseDown={(e) => { e.preventDefault(); choose(o.label); }}
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left ${i === hl ? "bg-accent-wash" : "hover:bg-hover"}`}
          >
            {o.color && <span className="h-2 w-2 rounded-pill" style={{ background: PALETTE[o.color].bg }} />}
            <span className="font-mono text-[11.5px] text-ink">{o.label}</span>
          </button>
        ))}
        {value != null && value !== "" && !filtered.some((o) => o.label === String(value)) && (
          <div className="px-2 py-1 font-mono text-[10.5px] text-ink-3">current: {String(value)}</div>
        )}
        {canCreate && (
          <div className="mt-1 border-t border-line pt-1">
            <div className="flex items-center gap-1 px-2 py-1">
              {PALETTE_NAMES.map((c) => (
                <button
                  key={c} type="button"
                  onMouseDown={(e) => { e.preventDefault(); setPickedColor(c); }}
                  title={c}
                  className={`h-3.5 w-3.5 rounded-sm ${pickedColor === c ? "ring-1 ring-ink" : ""}`}
                  style={{ background: PALETTE[c].bg }}
                />
              ))}
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setPickedColor(null); }}
                title="no color"
                className={`h-3.5 w-3.5 rounded-sm border border-line-2 ${pickedColor === null ? "ring-1 ring-ink" : ""}`}
              />
            </div>
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); void create(); }}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left font-mono text-[11px] text-accent hover:bg-accent-wash"
            >
              + create option “{q.trim()}”{pickedColor ? ` · ${pickedColor}` : ""}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export const SelectCell = { Renderer, Editor };
```

- [ ] **Step 5: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: errors at the host site that calls `SelectCell.Editor`'s `onCreate` (currently passes a string-only callback). Note the failing files — they get fixed in the AddColumn / MasterTables work.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/cells/SelectCell.tsx app/src/components/datagrid/types.ts
git commit -m "feat(grid): SelectCell renders option color + inline color picker on + option"
```

---

***REMOVED******REMOVED******REMOVED*** Task 13: `ColumnHeaderMenu` shows option colors + lets you pick on add

**Files:**
- Modify: `app/src/components/datagrid/ColumnHeaderMenu.tsx`

- [ ] **Step 1: Read the existing menu**

Open `app/src/components/datagrid/ColumnHeaderMenu.tsx`. It has four modes (`menu | rename | type | confirm-delete`). The `type` mode lists available types but doesn't show or edit options. The "+ option" picker lives in the cell editor, not here. That's fine for v1 — confirm there's no work in the header menu beyond the typing.

Look for where `onChangeType` is called with options (`changeColumnType` server signature accepts `OptionDef[]`). In `MasterTables.tsx:357-359`:

```tsx
onChangeColumnType={(field, newType, opts) =>
  changeColumnType(activeId, field, newType, opts?.options, opts?.coerceInvalidToNull ?? false)
}
```

`opts?.options` is currently `string[] | undefined`. After Task 6, the server side expects `OptionDef[]`. The header menu doesn't currently pass options at all (the `onChangeType: (newType: CellType) => void` signature in `ColumnHeaderMenu`'s Props takes only `newType`). So this path is fine — the cell editor handles option creation.

- [ ] **Step 2: Update the host signatures to use `OptionDef[]`**

In `app/src/components/datagrid/types.ts` (line 58), the `onChangeColumnType` callback signature already accepts `opts?: { options?: string[]; coerceInvalidToNull?: boolean }`. Change `options?: string[]` to `options?: OptionDef[]`:

```ts
onChangeColumnType?: (
  field: string,
  newType: CellType,
  opts?: { options?: OptionDef[]; coerceInvalidToNull?: boolean },
) => Promise<{ ok: boolean; invalidCount?: number }>;
```

And the `onAddColumnOption` callback (line 60) — change return / param to `OptionDef`:

```ts
onAddColumnOption?: (field: string, label: string, color?: import("../../lib/palette").PaletteName | null) => Promise<OptionDef[]>;
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: errors at `MasterTables.tsx` for the now-changed callback shapes. These get fixed in Task 19.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/types.ts app/src/components/datagrid/ColumnHeaderMenu.tsx
git commit -m "refactor(grid): grid callbacks accept OptionDef[] and option color"
```

---

***REMOVED******REMOVED******REMOVED*** Task 14: Shared `OptionBuilder` component

**Files:**
- Create: `app/src/components/OptionBuilder.tsx`

- [ ] **Step 1: Create the shared component**

This component renders an existing list of options as colored chips and an inline label-input + 7-swatch picker. It's used by `CreateTableModal` (scaffolding a select field) and by the in-grid `AddColumn` widget (creating a select field after the table exists).

```tsx
import { useState } from "react";
import { Chip } from "./datagrid/Chip";
import { PALETTE, PALETTE_NAMES } from "../lib/palette";
import type { OptionDef } from "../data";
import type { PaletteName } from "../lib/palette";

interface OptionBuilderProps {
  options: OptionDef[];
  onChange: (next: OptionDef[]) => void;
  /** Optional default color for newly created options. */
  defaultColor?: PaletteName | null;
}

/** Inline option editor: render existing options as colored chips (click to
 *  remove), plus a label-input + 7-swatch row to append a new option.
 *
 *  Used by CreateTableModal's field scaffold and by the in-grid AddColumn
 *  widget when the user picks type=select. The two callers share this shape
 *  so option ergonomics stay identical across creation and post-creation. */
export function OptionBuilder({ options, onChange, defaultColor = null }: OptionBuilderProps) {
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<PaletteName | null>(defaultColor);

  const remove = (target: string) => onChange(options.filter((o) => o.label !== target));
  const add = () => {
    const t = label.trim();
    if (!t || options.some((o) => o.label === t)) return;
    onChange([...options, { label: t, color }]);
    setLabel("");
    // color stays — usually you want a sequence (high/medium/low) with related tints
  };

  return (
    <div className="space-y-2 rounded-sm border border-line bg-bg/40 p-2">
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => remove(o.label)}
            title="click to remove"
            className="transition-opacity hover:opacity-70"
          >
            <Chip label={o.label} color={o.color} />
          </button>
        ))}
        {options.length === 0 && (
          <span className="font-mono text-[10.5px] text-ink-3">no options yet · add some below</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="option label…"
          className="flex-1 rounded-sm border border-line-2 bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />
        <div className="flex items-center gap-1">
          {PALETTE_NAMES.map((c) => (
            <button
              key={c} type="button"
              onClick={() => setColor(c)}
              title={c}
              className={`h-3.5 w-3.5 rounded-sm ${color === c ? "ring-1 ring-ink" : ""}`}
              style={{ background: PALETTE[c].bg }}
            />
          ))}
          <button
            type="button"
            onClick={() => setColor(null)}
            title="no color"
            className={`h-3.5 w-3.5 rounded-sm border border-line-2 ${color === null ? "ring-1 ring-ink" : ""}`}
          />
        </div>
        <button
          type="button"
          onClick={add}
          disabled={!label.trim()}
          className="rounded-sm border border-line-2 px-2 py-1 font-mono text-[11px] text-accent transition-colors hover:border-accent disabled:opacity-40"
        >
          add
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean (the component doesn't have any external consumer yet).

- [ ] **Step 3: Commit**

```bash
git add app/src/components/OptionBuilder.tsx
git commit -m "feat(tables): shared OptionBuilder (chip list + label + 7-swatch picker)"
```

---

***REMOVED*** PHASE D · Client store

***REMOVED******REMOVED******REMOVED*** Task 15: `createTable()` in store + extend cached dimension shape

**Files:**
- Modify: `app/src/store.ts`

- [ ] **Step 1: Add the `createTable` function**

In `app/src/store.ts`, after `addDimension` (around line 110), add:

```ts
import type { OptionDef, PaletteName } from "./data";

export type CreateTableMode = "blank" | "source" | "external_id";

export interface ColumnDraft {
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select";
  options?: OptionDef[];
}

export interface CreateTableInput {
  name: string;
  description?: string | null;
  color?: PaletteName | null;
  mode: CreateTableMode;
  columns?: ColumnDraft[];
  source?: { table: string; column: string };
  external?: { table: string; idColumn: string; nameColumn: string };
}

export interface CreateTableError {
  error: string;
  code: "NAME_TAKEN" | "WAREHOUSE_OFFLINE" | "MISSING_PICKER" | "INVALID";
}

/** Create a table via the orchestrator. Returns the new dim id on success.
 *  Throws an Error with .message set to the server's `error` string and a
 *  numeric `.code` attached for the modal to render an inline banner. */
export async function createTable(input: CreateTableInput): Promise<string> {
  const res = await fetch(`/api/tables`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as CreateTableError;
    const e = new Error(body.error ?? "create failed") as Error & { code?: string };
    e.code = body.code;
    throw e;
  }
  const { id } = (await res.json()) as { id: string };
  await refreshDims();
  await refreshSources();
  await refreshAudit();
  emit();
  return id;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/src/store.ts
git commit -m "feat(tables): store.createTable POSTs to /api/tables and refreshes caches"
```

---

***REMOVED*** PHASE E · CreateTableModal

***REMOVED******REMOVED******REMOVED*** Task 16: `CreateTableModal` shell — identity, palette, mode segment

**Files:**
- Create: `app/src/components/CreateTableModal.tsx`

- [ ] **Step 1: Create the modal shell**

This task creates the identity row, palette swatches, description, mode segment, and the close/submit footer. The swappable region (Task 17) is added in the next task — for now, a placeholder div.

```tsx
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { IconX } from "./Icons";
import { PALETTE, PALETTE_NAMES, defaultTintFor } from "../lib/palette";
import { createTable, type ColumnDraft, type CreateTableMode, type CreateTableInput } from "../store";
import type { PaletteName, OptionDef } from "../data";

interface Props {
  open: boolean;
  defaultMode?: CreateTableMode;
  onClose: () => void;
  onCreated: (id: string) => void;
}

/* CreateTableModal — Airtable-style one-page scaffold. Identity (monogram tint
   + description) lives at the top; a three-pill mode segment swaps the form
   below it (blank → column scaffold; source → 1 picker; from IDs → 2 pickers).
   Posts to /api/tables in one round-trip and consolidates the audit log entry. */

export function CreateTableModal({ open, defaultMode = "blank", onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<PaletteName>(() => defaultTintFor(String(Date.now())));
  const [mode, setMode] = useState<CreateTableMode>(defaultMode);
  const [columns, setColumns] = useState<ColumnDraft[]>([]);
  const [source, setSource] = useState<{ table: string; column: string } | null>(null);
  const [external, setExternal] = useState<{ table: string; idColumn: string; nameColumn: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // reset on open
  useEffect(() => {
    if (!open) return;
    setName(""); setDescription(""); setMode(defaultMode);
    setColor(defaultTintFor(String(Date.now())));
    setColumns([]); setSource(null); setExternal(null);
    setError(null);
  }, [open, defaultMode]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit()) void submit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, name, mode, source, external]);

  if (!open) return null;
  const monogram = (name.trim().charAt(0) || "?").toUpperCase();
  const tint = PALETTE[color];

  const canSubmit = (): boolean => {
    if (!name.trim()) return false;
    if (mode === "source") return !!(source?.table && source?.column);
    if (mode === "external_id") return !!(external?.table && external?.idColumn && external?.nameColumn);
    return true; // blank: name is enough
  };

  const submit = async (): Promise<void> => {
    if (submitting || !canSubmit()) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreateTableInput = {
        name: name.trim(),
        description: description.trim() || null,
        color,
        mode,
        ...(mode === "blank" ? { columns } : {}),
        ...(mode === "source" && source ? { source } : {}),
        ...(mode === "external_id" && external ? { external } : {}),
      };
      const id = await createTable(payload);
      onCreated(id);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/50 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-[10vh] w-[520px] max-w-full overflow-hidden rounded-lg border border-line-2 bg-surface shadow-pop"
      >
        {/* accent edge */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" />

        <div className="space-y-3 px-6 pb-5 pt-6">
          <div className="flex items-start justify-between">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">New table</div>
            <button type="button" onClick={onClose} aria-label="close" className="text-ink-3 hover:text-ink"><IconX className="h-3.5 w-3.5" /></button>
          </div>

          {/* identity */}
          <div className="flex items-center gap-3">
            <div
              className="grid h-8 w-8 shrink-0 place-items-center rounded-sm font-display text-[15px] font-bold text-white"
              style={{ background: tint.bg, boxShadow: `0 0 0 1.5px ${tint.border}` }}
            >
              {monogram}
            </div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled table"
              className="w-full border-0 border-b border-line bg-transparent py-1.5 font-display text-[18px] font-semibold text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
          </div>

          {/* palette swatch row */}
          <div className="ml-11 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">
            <span>tint</span>
            {PALETTE_NAMES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                title={c}
                className={`h-3.5 w-3.5 rounded-sm transition-transform hover:scale-110 ${color === c ? "ring-1 ring-ink" : ""}`}
                style={{ background: PALETTE[c].bg }}
              />
            ))}
          </div>

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="describe what's in this table (optional)"
            className="w-full resize-none border-0 bg-transparent py-1 font-body text-[13px] text-ink-2 outline-none placeholder:text-ink-3"
          />
        </div>

        {/* mode segment */}
        <div className="space-y-2 px-6 pb-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">Start from</div>
          <div className="flex gap-0.5 rounded-sm border border-line bg-bg p-0.5">
            {(["blank", "source", "external_id"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded-sm px-2.5 py-1.5 font-mono text-[11.5px] transition-colors ${mode === m ? "bg-accent text-accent-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {m === "blank" ? "blank" : m === "source" ? "from a source column" : "from IDs"}
              </button>
            ))}
          </div>
          <div className="font-mono text-[11px] leading-[1.5] text-ink-3">
            {mode === "blank" && "start with empty rows · design fields now or add them later"}
            {mode === "source" && "seed records from distinct values in a warehouse column"}
            {mode === "external_id" && "records keyed by a warehouse id · names resolved live"}
          </div>
        </div>

        {/* swappable region — Task 17 implements this */}
        <div className="px-6 pb-4 pt-2">
          <div className="rounded-sm border border-line bg-surface-2 p-3 font-mono text-[11px] text-ink-3">
            mode-specific form goes here (added in next task)
          </div>
        </div>

        {/* error banner */}
        {error && (
          <div className="border-t border-line bg-accent-wash px-6 py-2 font-mono text-[12px] text-accent">{error}</div>
        )}

        {/* footer */}
        <div className="flex items-center justify-end gap-2 border-t border-line bg-bg/40 px-6 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit() || submitting}>
            {submitting ? "Creating…" : "Create table"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean (the placeholder swappable region uses no types).

- [ ] **Step 3: Commit**

```bash
git add app/src/components/CreateTableModal.tsx
git commit -m "feat(tables): CreateTableModal shell — identity, palette, mode segment"
```

---

***REMOVED******REMOVED******REMOVED*** Task 17: `CreateTableModal` — the swappable region (blank columns, source, from IDs)

**Files:**
- Modify: `app/src/components/CreateTableModal.tsx`

- [ ] **Step 1: Wire imports for `OptionBuilder`, `ComboSelect`, and the source list hook**

At the top of `CreateTableModal.tsx`:

```tsx
import { ComboSelect } from "./ComboSelect";
import { OptionBuilder } from "./OptionBuilder";
import { useSources } from "../store";
```

- [ ] **Step 2: Replace the placeholder swappable region**

Replace the placeholder `<div className="rounded-sm border …">mode-specific form goes here</div>` with the three-mode swap. Use `useSources()` to populate the picker options.

```tsx
const sources = useSources();
const sourceOpts = useMemo(
  () => Array.from(new Set(sources.map((s) => `${s.table}.${s.column}`))).sort(),
  [sources],
);
const tablesOpts = useMemo(
  () => Array.from(new Set(sources.map((s) => s.table))).sort(),
  [sources],
);
// columns of a chosen warehouse table — used to populate the second picker
// in external_id mode after the user picks the table via the id-column picker
const columnsOfTable = (table: string): string[] =>
  Array.from(new Set(sources.filter((s) => s.table === table).map((s) => s.column))).sort();

// blank-mode field row helpers
const addField = (): void => setColumns((cs) => [...cs, { label: "", type: "text" }]);
const updateField = (i: number, next: Partial<ColumnDraft>): void =>
  setColumns((cs) => cs.map((c, j) => (i === j ? { ...c, ...next } : c)));
const removeField = (i: number): void => setColumns((cs) => cs.filter((_, j) => j !== i));
```

Add `useMemo` to the React import (`import { useEffect, useMemo, useState } from "react"`).

Then replace the swappable region with:

```tsx
<div className="px-6 pb-4 pt-2">
  <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
    {mode === "blank" ? "Fields" : mode === "source" ? "Source column" : "Source columns"}
  </div>

  {/* ─── blank: scaffold ────────────────────────────────────────────────── */}
  {mode === "blank" && (
    <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
      {/* locked primary row */}
      <div className="grid grid-cols-[14px_1fr_110px_18px] items-center gap-2 border-b border-dashed border-line pb-2">
        <span className="text-center font-mono text-[10px] text-ink-3">⋮⋮</span>
        <span className="font-mono text-[12px] text-ink">name</span>
        <span className="justify-self-end rounded-pill border border-accent/35 bg-accent-wash px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-accent">primary</span>
        <span />
      </div>

      {/* user fields */}
      {columns.map((c, i) => (
        <div key={i} className="space-y-1.5">
          <div className="grid grid-cols-[14px_1fr_110px_18px] items-center gap-2">
            <span className="text-center font-mono text-[10px] text-ink-3">⋮⋮</span>
            <input
              value={c.label}
              onChange={(e) => updateField(i, { label: e.target.value })}
              placeholder="field name…"
              className="border-0 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-3"
            />
            <select
              value={c.type}
              onChange={(e) => updateField(i, { type: e.target.value as ColumnDraft["type"], options: e.target.value === "select" ? (c.options ?? []) : undefined })}
              className="rounded-sm border border-line-2 bg-bg px-1.5 py-1 font-mono text-[10.5px] text-ink-2 outline-none"
            >
              <option value="text">text</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="date">date</option>
              <option value="select">select</option>
            </select>
            <button
              type="button"
              onClick={() => removeField(i)}
              aria-label="remove field"
              className="text-center font-mono text-[13px] text-ink-3 hover:text-ink"
            >
              ×
            </button>
          </div>
          {c.type === "select" && (
            <div className="ml-[22px]">
              <OptionBuilder
                options={c.options ?? []}
                onChange={(next) => updateField(i, { options: next })}
              />
            </div>
          )}
        </div>
      ))}

      <button
        type="button"
        onClick={addField}
        className="mt-1 w-full border-t border-dashed border-line pt-2 text-left font-mono text-[11px] text-accent hover:opacity-80"
      >
        + add field
      </button>
    </div>
  )}

  {/* ─── source: 1 picker ───────────────────────────────────────────────── */}
  {mode === "source" && (
    <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
      <ComboSelect
        options={sourceOpts}
        value={source ? `${source.table}.${source.column}` : null}
        placeholder="pick a warehouse column…"
        onPick={(opt) => {
          const dot = opt.lastIndexOf(".");
          if (dot > 0) setSource({ table: opt.slice(0, dot), column: opt.slice(dot + 1) });
        }}
      />
      <div className="font-mono text-[11px] text-ink-3">distinct values from the chosen column become records · already-mapped values are skipped</div>
    </div>
  )}

  {/* ─── external_id: 2 pickers ─────────────────────────────────────────── */}
  {mode === "external_id" && (
    <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">id column</div>
          <ComboSelect
            options={sourceOpts}
            value={external ? `${external.table}.${external.idColumn}` : null}
            placeholder="pick the id column…"
            onPick={(opt) => {
              const dot = opt.lastIndexOf(".");
              if (dot > 0) {
                const table = opt.slice(0, dot);
                const idColumn = opt.slice(dot + 1);
                setExternal((prev) => ({
                  table,
                  idColumn,
                  nameColumn: prev && prev.table === table ? prev.nameColumn : "",
                }));
              }
            }}
          />
        </div>
        <div>
          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">name column</div>
          <ComboSelect
            options={external?.table ? columnsOfTable(external.table).filter((c) => c !== external.idColumn) : []}
            value={external?.nameColumn || null}
            placeholder={external?.table ? "pick the name column…" : "pick an id column first"}
            onPick={(opt) => setExternal((prev) => prev ? { ...prev, nameColumn: opt } : prev)}
          />
        </div>
      </div>
      <div className="font-mono text-[11px] text-ink-3">keys come from the id column · the human name is resolved live from the name column · no slug</div>
    </div>
  )}
</div>
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Manual smoke test — open the modal in the dev UI**

The modal isn't wired into the picker yet — we'll do that in Task 19. For now, mount it temporarily in `MasterTables.tsx` to smoke-test:

In `MasterTables.tsx`, near the existing render, temporarily add:

```tsx
const [tmpOpen, setTmpOpen] = useState(false);
// ... in the JSX:
<button onClick={() => setTmpOpen(true)}>DEV — open create modal</button>
<CreateTableModal open={tmpOpen} onClose={() => setTmpOpen(false)} onCreated={(id) => setDimId(id)} />
```

```bash
cd app && bun run dev
```

In the browser: click DEV — open create modal. Verify each mode swaps the form. Try a blank-mode create with a few fields including a select with 2-3 colored options. Confirm the new table appears in the picker. **Revert** the DEV button after the smoke test passes (`git checkout app/src/routes/MasterTables.tsx`).

- [ ] **Step 5: Commit**

```bash
git add app/src/components/CreateTableModal.tsx
git commit -m "feat(tables): CreateTableModal mode regions (blank scaffold, source, from IDs)"
```

---

***REMOVED*** PHASE F · TablePicker rename + visuals

***REMOVED******REMOVED******REMOVED*** Task 18: Rename `DimensionPicker` → `TablePicker` + update imports

**Files:**
- Rename: `app/src/components/DimensionPicker.tsx` → `app/src/components/TablePicker.tsx`
- Modify: every importer

- [ ] **Step 1: Find all importers**

```bash
grep -rn "DimensionPicker" /Users/fhagelund/Documents/GitHub/zugzug/app/src
```

Expected: `MasterTables.tsx` and `Mapping.tsx` import it; the file itself defines it.

- [ ] **Step 2: Rename the file via git**

```bash
git mv app/src/components/DimensionPicker.tsx app/src/components/TablePicker.tsx
```

- [ ] **Step 3: Rename the component export and its props type**

In `app/src/components/TablePicker.tsx`, replace:
- `export function DimensionPicker` → `export function TablePicker`
- comment header `/* DimensionPicker — …` → `/* TablePicker — …`

- [ ] **Step 4: Update importers**

In `app/src/routes/MasterTables.tsx`:
- `import { DimensionPicker } from "../components/DimensionPicker";` → `import { TablePicker } from "../components/TablePicker";`
- `<DimensionPicker …>` → `<TablePicker …>`

Same in `app/src/routes/Mapping.tsx`.

- [ ] **Step 5: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/TablePicker.tsx app/src/routes/MasterTables.tsx app/src/routes/Mapping.tsx
git commit -m "refactor(naming): DimensionPicker → TablePicker (file + importers)"
```

---

***REMOVED******REMOVED******REMOVED*** Task 19: `TablePicker` visual updates (tint, description, "New table" → modal)

**Files:**
- Modify: `app/src/components/TablePicker.tsx`
- Modify: `app/src/routes/MasterTables.tsx` (to mount the modal)

- [ ] **Step 1: Update `Mono` to read from `d.color`**

In `TablePicker.tsx`, replace the `Mono` helper component (around line 19) with a version that takes a color:

```tsx
import { PALETTE } from "../lib/palette";
import type { PaletteName } from "../data";

function Mono({ label, active, color }: { label: string; active?: boolean; color?: PaletteName | null }) {
  if (color) {
    const tint = PALETTE[color];
    return (
      <div
        className="grid h-7 w-7 shrink-0 place-items-center rounded-sm font-display text-[13px] font-bold"
        style={{ background: active ? tint.bg : tint.wash, color: active ? "***REMOVED***FFFFFF" : tint.fg }}
      >
        {label.charAt(0).toUpperCase()}
      </div>
    );
  }
  // legacy / no color — rose accent like today
  return (
    <div className={`grid h-7 w-7 shrink-0 place-items-center rounded-sm font-display text-[13px] font-bold ${active ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent"}`}>
      {label.charAt(0).toUpperCase()}
    </div>
  );
}
```

Update both `<Mono …>` callsites to pass `color={active.color}` and `color={d.color}` respectively.

- [ ] **Step 2: Update the 2nd-line caption to fall through engineer → description → counts**

In the trigger row (around line 73-75) and the list-row (around line 101-105), the existing caption is:

```tsx
{engineer ? active.mapTable : `${aStats.total - aStats.fresh} mapped · ${aStats.fresh} new`}
```

Change both to:

```tsx
{engineer
  ? active.mapTable
  : active.description
    ? active.description
    : `${aStats.total - aStats.fresh} mapped · ${aStats.fresh} new`}
```

Same change for the list-row caption (uses `d` not `active`).

- [ ] **Step 3: Update copy in the dropdown**

- `placeholder="Find a dimension…"` → `placeholder="find a table…"`
- `"New dimension"` button label → `"New table"`
- `"New dimension"` header inside creating mode → `"New table"`
- The helper line that ends `Creates a new master list called "X"` (when in creating mode) — for now we no longer use the inline creation, so we'll replace the whole inline-create branch in the next step.

- [ ] **Step 4: Replace inline create with the modal**

Remove the `creating` state and the inline form (lines ~83-145 — the entire `creating ? … : …` branch). Replace the dropdown body with the picker list only, plus a footer button that calls a new `onCreate` prop:

```tsx
// new prop in props type:
onCreateRequested: () => void;

// dropdown body (no more `creating` branch):
{open && (
  <div className="absolute left-0 z-50 mt-1.5 w-[320px] overflow-hidden rounded-md border border-line-2 bg-surface shadow-pop">
    <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-ink-3">
      <IconSearch className="h-3.5 w-3.5" />
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="find a table…"
        className="w-full bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3" />
    </div>
    <ul className="max-h-72 overflow-y-auto py-1">
      {list.map((d) => {
        const s = stats(d);
        const on = d.id === activeId;
        return (
          <li key={d.id}>
            <button type="button" onClick={() => choose(d.id)} className={cx("flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors", on ? "bg-accent-wash" : "hover:bg-hover")}>
              <Mono label={d.dimension} active={on} color={d.color} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={cx("truncate font-display text-[13.5px] font-semibold", on ? "text-accent" : "text-ink")}>{d.dimension}</span>
                  {s.fresh > 0 && <span className="shrink-0 rounded-pill bg-warn-soft px-1.5 font-mono text-[10px] text-warn">{s.fresh}</span>}
                </div>
                <div className="truncate font-mono text-[10px] text-ink-3">
                  {engineer ? d.mapTable : d.description ? d.description : `${s.total - s.fresh} mapped · ${s.fresh} new`}
                </div>
              </div>
              <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">{s.total ? `${s.pct}%` : "empty"}</span>
              {on && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          </li>
        );
      })}
      {list.length === 0 && <li className="px-3 py-3 font-mono text-[12px] text-ink-3">no match</li>}
    </ul>
    <button type="button" onClick={() => { close(); onCreateRequested(); }} className="flex w-full items-center gap-2 border-t border-line px-3 py-2.5 font-mono text-[12px] text-accent transition-colors hover:bg-accent-wash">
      <IconPlus className="h-4 w-4" /> New table
    </button>
  </div>
)}
```

Also remove the now-unused state (`creating`, `name`, `externalId`, `setCreating`, `setName`, `setExternalId`, `submit`) and the `onCreate` prop from `TablePicker` props — replaced by `onCreateRequested: () => void`.

- [ ] **Step 5: Update `MasterTables.tsx` to mount the modal**

In `MasterTables.tsx`, replace the `<DimensionPicker … onCreate={async (name, keyKind) => {…}}>` call with:

```tsx
const [createOpen, setCreateOpen] = useState(false);
// ... in JSX, where TablePicker was:
<TablePicker
  dims={dims}
  activeId={activeId}
  onSelect={(id) => { setDimId(id); reset(); setDraft(""); }}
  onCreateRequested={() => setCreateOpen(true)}
/>
<CreateTableModal
  open={createOpen}
  onClose={() => setCreateOpen(false)}
  onCreated={(id) => { setDimId(id); reset(); setDraft(""); }}
/>
```

And add the imports:

```tsx
import { CreateTableModal } from "../components/CreateTableModal";
import { TablePicker } from "../components/TablePicker";
```

- [ ] **Step 6: Do the same in `Mapping.tsx`**

The Mapping route also mounts `DimensionPicker` (line ~38). It calls `addDimension` via `onCreate`. Replace with the modal pattern:

```tsx
const [createOpen, setCreateOpen] = useState(false);
// ... JSX:
<TablePicker
  dims={dims}
  activeId={seedId}
  onSelect={selectSeed}
  onCreateRequested={() => setCreateOpen(true)}
/>
<CreateTableModal
  open={createOpen}
  onClose={() => setCreateOpen(false)}
  onCreated={(id) => { selectSeed(id); }}
/>
```

Add the imports.

- [ ] **Step 7: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 8: Smoke test**

```bash
cd app && bun run dev
```

Open the picker — verify "New table" opens the modal, the monogram tint reflects existing dim colors (existing rows render rose / no caption), creating a new blank table with a name + description + colored monogram shows the new tint in the picker afterward.

- [ ] **Step 9: Commit**

```bash
git add app/src/components/TablePicker.tsx app/src/routes/MasterTables.tsx app/src/routes/Mapping.tsx
git commit -m "feat(tables): TablePicker monogram tint + description fallback; New table opens modal"
```

---

***REMOVED*** PHASE G · In-grid AddColumn upgrade

***REMOVED******REMOVED******REMOVED*** Task 20: In-grid `+ field` widget supports `select` + uses `OptionBuilder`

**Files:**
- Modify: `app/src/routes/MasterTables.tsx`

- [ ] **Step 1: Update the `FIELD_TYPES` list**

In `MasterTables.tsx:29`:

```ts
const FIELD_TYPES = ["text", "number", "boolean", "date", "select"] as const;
```

- [ ] **Step 2: Rewrite `AddColumn` to handle the `select` expansion**

Replace `AddColumn` (lines 32-49) with:

```tsx
import { OptionBuilder } from "../components/OptionBuilder";
import type { OptionDef } from "../data";

function AddColumn({ onAdd }: { onAdd: (label: string, type: string, options?: OptionDef[]) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<string>("text");
  const [options, setOptions] = useState<OptionDef[]>([]);

  const reset = (): void => { setLabel(""); setType("text"); setOptions([]); setEditing(false); };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex items-center gap-1 font-mono text-[11px] text-ink-3 transition-colors hover:text-accent"
      >
        <IconPlus className="h-3 w-3" /> field
      </button>
    );
  }

  const commit = async (): Promise<void> => {
    if (!label.trim()) return;
    await onAdd(label.trim(), type, type === "select" ? options : undefined);
    reset();
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && type !== "select") void commit();
            if (e.key === "Escape") reset();
          }}
          placeholder="field name…"
          className="w-32 rounded-sm border border-accent bg-bg px-2 py-0.5 font-mono text-[11px] text-ink outline-none"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink-2 outline-none"
        >
          {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); void commit(); }}
          className="rounded-sm border border-line-2 px-2 py-0.5 font-mono text-[11px] text-accent transition-colors hover:border-accent"
        >
          add
        </button>
        <button
          type="button"
          onClick={reset}
          className="rounded-sm border border-line-2 px-2 py-0.5 font-mono text-[11px] text-ink-3 hover:text-ink"
        >
          cancel
        </button>
      </div>
      {type === "select" && (
        <OptionBuilder options={options} onChange={setOptions} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Update the host call site**

`AddColumn` is mounted at the toolbar (around line 292). Update its `onAdd`:

```tsx
<AddColumn onAdd={(label, type, options) => addField(activeId, label, type, options)} />
```

The `addField` in the store needs to accept the options shape. Looking at the existing client `addField` signature (`store.ts:220-226`), update it to:

```ts
export async function addField(dimId: string, label: string, type = "text", options?: OptionDef[]): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields`, {
    method: "POST",
    body: JSON.stringify({ label, type, options }),
  });
  await refreshDims(); await refreshAudit(); emit();
}
```

(Already imported `OptionDef` from `./data` in Task 15.)

- [ ] **Step 4: Update `addColumnOption` in the store to accept a color**

`store.ts:230-238`:

```ts
export async function addColumnOption(dimId: string, field: string, label: string, color: PaletteName | null = null): Promise<OptionDef[]> {
  const res = await api<{ options: OptionDef[] }>(
    `/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}/options`,
    { method: "POST", body: JSON.stringify({ label, color }) },
  );
  await refreshDims();
  emit();
  return res.options;
}
```

- [ ] **Step 5: Update the `<DataGrid>` mount in MasterTables to match the new callback shape**

The `onAddColumnOption` prop (MasterTables.tsx:355) becomes:

```tsx
onAddColumnOption={(field, label, color) => addColumnOption(activeId, field, label, color ?? null)}
```

And `onChangeColumnType` (line 357):

```tsx
onChangeColumnType={(field, newType, opts) =>
  changeColumnType(activeId, field, newType, opts?.options, opts?.coerceInvalidToNull ?? false)
}
```

`changeColumnType` in the store needs its option type updated:

```ts
export async function changeColumnType(
  dimId: string, field: string, newType: string,
  options?: OptionDef[], coerceInvalidToNull = false,
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
  // ... existing body
}
```

- [ ] **Step 6: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 7: Smoke test**

```bash
cd app && bun run dev
```

In the browser: open MasterTables → click `+ field` → pick `select` → add 3 colored options via the OptionBuilder → name the field → add. Confirm the new column appears with chips of the right color.

- [ ] **Step 8: Commit**

```bash
git add app/src/routes/MasterTables.tsx app/src/store.ts
git commit -m "feat(tables): in-grid + field gains select with inline OptionBuilder"
```

---

***REMOVED*** PHASE H · Naming sweep & capitalization

***REMOVED******REMOVED******REMOVED*** Task 21: Rename `NoDimensionsYet` → `NoTablesYet`, update copy

**Files:**
- Rename: `app/src/components/NoDimensionsYet.tsx` → `app/src/components/NoTablesYet.tsx`
- Modify: every importer

- [ ] **Step 1: Find importers**

```bash
grep -rn "NoDimensionsYet" /Users/fhagelund/Documents/GitHub/zugzug/app/src
```

- [ ] **Step 2: git-mv the file**

```bash
git mv app/src/components/NoDimensionsYet.tsx app/src/components/NoTablesYet.tsx
```

- [ ] **Step 3: Rename the component + sweep copy**

In `app/src/components/NoTablesYet.tsx`:
- `export function NoDimensionsYet` → `export function NoTablesYet`
- Any string containing "dimension" / "master list" → "table" (preserve Sentence case for body / display headings, lowercase for mono).

Read the file first to see its current copy; sweep accordingly. Specifically expect to see `No dimensions yet` (Sentence case display) → `No tables yet`, and any explanatory body / display copy.

- [ ] **Step 4: Update importers**

Sed isn't reliable; do a targeted edit. Use:

```bash
grep -rln "NoDimensionsYet" /Users/fhagelund/Documents/GitHub/zugzug/app/src
```

For each file in the output, replace `NoDimensionsYet` → `NoTablesYet` and adjust the import path.

- [ ] **Step 5: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A app/src/components/NoTablesYet.tsx app/src/routes
git commit -m "refactor(naming): NoDimensionsYet → NoTablesYet + copy sweep"
```

---

***REMOVED******REMOVED******REMOVED*** Task 22: Naming + capitalization sweep across routes

**Files:**
- Modify: `app/src/routes/MasterTables.tsx`, `app/src/routes/Mapping.tsx`, `app/src/routes/Sources.tsx`, `app/src/routes/Dashboard.tsx`, `app/src/routes/Settings.tsx`, `app/src/components/BootGate.tsx`

This is a mechanical edit pass. Apply the rules from the spec's capitalization section. Engineer-mode branches are untouched. The detailed string list:

- [ ] **Step 1: `MasterTables.tsx` sweep**

Open `app/src/routes/MasterTables.tsx`. Apply:

| Old | New | Line approx |
|---|---|---|
| `<h1>…Master lists</h1>` (line 257) | `<h1>…Tables</h1>` | 257 |
| `The master records every source value resolves to…` | `Records other systems resolve to. Manual lists welcome too.` | 258 |
| `Master record` column label (line 90) | `Record` | 90 |
| `+ column` (AddColumn affordance — now in `AddColumn` from Task 20) | `+ field` | 36 (already done in Task 20) |
| `New ${dim.dimension.toLowerCase()} master record…` (line 398) | `new ${dim.dimension.toLowerCase()} record…` | 398 |
| `master record` / `master records` in toast strings (lines 224, 231, 242, 249) | `record` / `records` | various |
| `no master records yet — import from a source above, or add one below` (line 371) | `no records yet — import from a source above, or add one below` | 371 |
| `master records mapping here yet — match them on Value mapping` (line 390) | `no source values map here yet — match them on Value mapping` (already this) | 390 |
| `Add record` button label | unchanged (Sentence case CTA) | 401 |
| `Master tables (pillar 2)` comment header (line 23-26) | `Tables (pillar 2)` | 23 |
| The `Master` eyebrow on line 256 | `Tables` | 256 |

- [ ] **Step 2: `Mapping.tsx` sweep**

Open `app/src/routes/Mapping.tsx`. Search for "dimension" (case-insensitive) and "master" within user-facing strings only (not type names, not variable names). Apply mode → table renaming where it appears as user-facing copy.

- [ ] **Step 3: `Sources.tsx` sweep**

Open `app/src/routes/Sources.tsx`. Search for `dimension` in user-facing strings. Replace with `table`. Specifically the `<em>{row.dimension}</em>` references unchanged — `row.dimension` is the dim's display label. But the surrounding prose ("the dimension is…" if any) gets table-ified.

- [ ] **Step 4: `Dashboard.tsx` sweep**

Open `app/src/routes/Dashboard.tsx`. The KPI labels (e.g. `"Dimensions"`) → `"Tables"`. Any prose mentioning "dimension" → "table".

- [ ] **Step 5: `Settings.tsx` sweep**

Open `app/src/routes/Settings.tsx`. Sweep user-facing dimension/master strings.

- [ ] **Step 6: `BootGate.tsx` sweep**

Open `app/src/components/BootGate.tsx`. Sweep user-facing strings.

- [ ] **Step 7: Capitalization sweep on placeholders**

Targeted replacements per the rule (mono lowercase):

- `placeholder="ID column…"` → `placeholder="id column…"` (MasterTables.tsx:265)
- `placeholder="Name column…"` → `placeholder="name column…"` (MasterTables.tsx:266)
- `placeholder="Import from source…"` → keep Sentence case if it appears in a body context, lowercase if in mono — check inline context, the existing one is mono → lowercase: `placeholder="import from source…"` (MasterTables.tsx:261)
- `placeholder="Find a dimension…"` → `placeholder="find a table…"` (TablePicker.tsx — already done in Task 19)
- `placeholder="Merge into…"` → mono → `placeholder="merge into…"` (MasterTables.tsx:311)
- `placeholder="Add to dimension…"` (CatalogExplorer.tsx) → `placeholder="add to table…"` (mono context)
- `placeholder="e.g. Currency"` → unchanged (user-typed example, leave alone)

- [ ] **Step 8: Verify no straggler lowercase-in-mono violations**

```bash
grep -rn "placeholder=\"[A-Z]" /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes /Users/fhagelund/Documents/GitHub/zugzug/app/src/components | grep -v "font-body\|font-display"
```

Review each result — if the input wears `font-mono` (look at the `className`), the placeholder should be lowercase. If it wears `font-body` (free text where Sentence is natural — e.g. table descriptions), Sentence is fine.

- [ ] **Step 9: Final grep audit**

Confirm no user-facing "Dimension" / "Master record" / "Master list" / "Attribute column" leak outside engineer-mode branches:

```bash
grep -rn "Dimension\|Master record\|Master list\|Attribute column" /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes /Users/fhagelund/Documents/GitHub/zugzug/app/src/components | grep -v "engineer\b\|dim_\|map_\|//\|\bMappingDimension\b\|\bDimensionMeta\b"
```

Expect: zero matches (type names like `MappingDimension` are allowed because they're not user-facing copy).

- [ ] **Step 10: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 11: Smoke test in dev**

```bash
cd app && bun run dev
```

Click through MasterTables, Mapping, Sources, Dashboard, Settings — confirm copy reads natural and consistent. Open the picker — confirm "New table" + the modal flow.

- [ ] **Step 12: Commit**

```bash
git add app/src/routes app/src/components/BootGate.tsx
git commit -m "refactor(naming): user-facing Dimension → Table, Master record → Record, Attribute column → Field"
```

---

***REMOVED*** PHASE I · Wrap-up

***REMOVED******REMOVED******REMOVED*** Task 23: Full verification + final smoke

**Files:** none — verification only

- [ ] **Step 1: Server typecheck + verify**

```bash
cd server && bun run typecheck && bun run verify-tables && bun run verify-datagrid && bun run verify-polish && bun run verify-eid
```

Expected: all four verify scripts pass.

- [ ] **Step 2: Client typecheck**

```bash
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 3: End-to-end manual smoke**

Start the server and app:

```bash
***REMOVED*** Terminal 1
cd server && bun run start

***REMOVED*** Terminal 2
cd app && bun run dev
```

In the browser, walk through:

1. Open the table picker, click **New table**.
2. Mode = `blank`. Name = `Risk level`. Description = `Severity tier for incidents.` Pick a mint tint.
3. Add a field `severity` of type `select`. Add three colored options: `high` (rose), `medium` (amber), `low` (mint). Add another field `owner` of type `text`. Click Create table.
4. Confirm the new table is selected and has a mint monogram in the picker; the description shows in the picker row.
5. In the grid, add a record via the inline `Add record`. Click the `severity` cell — confirm the chip picker shows the three colored options + a `+ option` affordance with a color picker.
6. Open Mode = `from a source column` flow (requires `ATTACH_WAREHOUSE=true`). Pick a column → Create → confirm derived records appear.
7. Open Mode = `from IDs` flow. Pick id + name columns. Confirm the second picker filters out the chosen id column.
8. Cancel mid-create → confirm the modal closes and no new row appears in the picker.
9. Try creating a table with the same name twice → confirm the inline error banner: `a table called "Risk level" already exists`.

- [ ] **Step 4: Confirm legacy data still renders**

In the picker, confirm existing tables (created before this work) render with the rose monogram and the `N mapped · M new` 2nd-line caption (no description, no color). Confirm their existing select fields' chips render in the neutral surface tint.

- [ ] **Step 5: Final commit (none expected) + summary**

If the smoke uncovers anything broken, fix and re-commit with the relevant `fix(tables): …` message. Otherwise no commit. Print a summary of what shipped:

```
✓ POST /api/tables orchestrator with consolidated audit
✓ Schema additions (description, color) — idempotent
✓ Option JSON shape lift {label, color}; lazy migration on read
✓ CreateTableModal one-page scaffold (blank + source + from IDs)
✓ TablePicker monogram tint + description fallback
✓ In-grid + field gains select with inline OptionBuilder
✓ Naming sweep: Table / Record / Field
✓ Capitalization rule codified; placeholder stragglers swept
✓ verify-tables.ts end-to-end script
```

---

***REMOVED******REMOVED*** Self-review (already applied above)

The plan was checked against the spec for coverage, placeholders, and type consistency before being saved. Coverage map:

| Spec section | Tasks |
|---|---|
| Goal / modal one-page scaffold | 16, 17 |
| Identity (monogram + tint + description) | 2, 3, 4, 8, 16, 19 |
| Mode segment + swappable region | 16, 17 |
| Blank → column scaffold with locked `name` primary | 17 |
| `select` field with colored options | 4, 6, 11, 12, 14, 17, 20 |
| From source mode | 9, 17 |
| From IDs mode | 9, 17 |
| `POST /api/tables` orchestrator | 9 |
| Schema `description` + `color` | 1, 8 |
| Option JSON migration (lazy) | 5 |
| `silent` flag | 6, 7 |
| Naming sweep | 18, 21, 22 |
| Capitalization rule (codify + sweep stragglers) | 22 |
| TablePicker monogram + description | 19 |
| In-grid `+ field` gains select | 20 |
| Edge cases (collision, warehouse offline, same column) | 9 (server validation), 10 (verification) |
| Testing | 10 (server end-to-end), 19 / 20 / 22 (manual smokes), 23 (final E2E) |

No placeholders, no "TBD", no "similar to Task N" references. Type names are stable: `OptionDef` / `PaletteName` / `ColumnDraft` / `CreateTableInput` are defined once in each layer and used by their exact name throughout. `addField` always returns `{ field }`. The `silent` opts shape is the same on every mutator (`opts: { silent?: boolean } = {}`).
