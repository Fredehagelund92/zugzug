# Cosmetic Column Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `url`, `email`, `rating` column types and `compact`, `duration` number formats to the enrichment attribute data grid, backed by a `ColumnConfig` discriminated union refactor and a server-side `field_config` schema rename.

**Architecture:** Server migration first (schema rename → type changes → logic), then client type foundation (ColumnConfig), then consumer migration (DataGrid, NumberCell, ColumnHeaderMenu, TablePane), then new cell components, then config UI. Each phase compiles cleanly before the next begins.

**Tech Stack:** Bun, postgres.js, Drizzle ORM (server); React 18, Vite, TypeScript strict, Tailwind v4 (client); Vitest (client tests); bun:test (server tests).

---

## File Map

**Server — modify:**
- `server/drizzle/schema.ts` — rename `options` → `field_config`
- `server/src/repo-shared.ts` — extend `NumberFormat`, add `parseFieldConfig`, update `FieldDef`
- `server/src/repo-canonical.ts` — refactor `changeColumnType` signature, new coercion rules, update `addField`/`listFields`/`addColumnOption`
- `server/src/server.ts` — add `ratingMax` to PUT body type
- `server/test/number-format.test.ts` — update for new signature, add rating/url/email tests

**Client — modify:**
- `app/src/data.ts` — extend `NumberFormat`
- `app/src/components/datagrid/types.ts` — add `ColumnConfig`, update `ColumnDef`, derive `CellType`
- `app/src/components/datagrid/DataGrid.tsx` — `col.type` → `col.config.type`, add new entries to `FIELD_TYPE_ICONS` and `CELLS`, add `satisfies never` guards, fix `coerceForColumn`
- `app/src/components/datagrid/cells/NumberCell.tsx` — `column.numberFormat` → narrowed via config, add `compact`/`duration` format cases + duration editor
- `app/src/components/datagrid/ColumnHeaderMenu.tsx` — `column.numberFormat` → narrowed via config, add url/email/rating to type list, add `ratingMax` sub-panel, add compact/duration tiles
- `app/src/components/AddFieldPopover.tsx` — new tiles, `ratingMax` picker, compact/duration config
- `app/src/components/TablePane.tsx` — add `fieldDefToColumnConfig` helper, migrate `ColumnDef` construction
- `app/src/store.ts` — add `ratingMax?` to `changeColumnType` wrapper
- `app/test/number-format.test.ts` — add compact/duration tests

**Client — create:**
- `app/src/components/datagrid/cells/UrlCell.tsx`
- `app/src/components/datagrid/cells/EmailCell.tsx`
- `app/src/components/datagrid/cells/RatingCell.tsx`

---

## Task 1: Rename dimension_field.options → field_config

**Files:**
- Modify: `server/drizzle/schema.ts:50`
- Modify: `server/drizzle/migrate.ts` (verify snapshot path)

- [ ] **Step 1: Update schema.ts**

In `server/drizzle/schema.ts`, change line 50:
```ts
// before
options:    varchar("options"),
// after
field_config: varchar("field_config"),
```

- [ ] **Step 2: Generate migration**

```bash
cd server && bun run db:generate
```

Expected: a new file appears in `server/drizzle/migrations/` (e.g. `0013_....sql`).

- [ ] **Step 3: Verify the generated SQL**

Open the new migration file. It MUST contain:
```sql
ALTER TABLE "zugzug"."dimension_field" RENAME COLUMN "options" TO "field_config";
```

If it instead shows `DROP COLUMN` + `ADD COLUMN`, the Drizzle snapshot is stale. In that case:
1. `bun run db:push` to sync the snapshot
2. Re-run `bun run db:generate`

Do NOT proceed with a DROP+ADD migration — it destroys existing data.

- [ ] **Step 4: Run migration against dev DB**

```bash
cd server && bun run db:migrate
```

Expected: migration applies cleanly, no errors.

- [ ] **Step 5: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/
git commit -m "chore(schema): rename dimension_field.options → field_config"
```

---

## Task 2: Extend NumberFormat + parseFieldConfig + FieldDef (repo-shared.ts)

**Files:**
- Modify: `server/src/repo-shared.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/test/number-format.test.ts`:
```ts
test("parseFieldConfig returns ratingMax for rating type", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Stars", [], { keyKind: "slug" }, userId);
  // We'll call addField with rating in Task 4; for now test parseFieldConfig directly
  // by importing it
  const { parseFieldConfig } = await import("../src/repo-shared.ts");
  expect(parseFieldConfig("rating", '{"ratingMax":5}')).toEqual({ ratingMax: 5 });
  expect(parseFieldConfig("rating", null)).toEqual({ ratingMax: 5 }); // default
  expect(parseFieldConfig("number", '{"format":"integer"}')).toEqual({
    numberFormat: { format: "integer" },
  });
  expect(parseFieldConfig("select", '[{"label":"A","color":null}]')).toEqual({
    options: [{ label: "A", color: null }],
  });
  expect(parseFieldConfig("text", null)).toEqual({});
});
```

- [ ] **Step 2: Run test to see it fail**

```bash
cd server && bun test test/number-format.test.ts 2>&1 | tail -20
```

Expected: fails — `parseFieldConfig` not exported.

- [ ] **Step 3: Extend NumberFormat union**

In `server/src/repo-shared.ts`, replace the `NumberFormat` type:
```ts
export type NumberFormat =
  | { format: "integer" }
  | { format: "decimal"; precision: 1 | 2 | 3 | 4 }
  | { format: "percent"; precision: 0 | 1 | 2 }
  | { format: "currency"; symbol: string; position: "prefix" | "suffix"; precision: 0 | 1 | 2 }
  | { format: "compact"; precision: 0 | 1 | 2 }
  | { format: "duration"; display: "hm" | "hms" };
```

Update the `VALID_FORMATS` constant:
```ts
const VALID_FORMATS = ["integer", "decimal", "percent", "currency", "compact", "duration"];
```

- [ ] **Step 4: Add parseFieldConfig**

Add after `parseNumberFormat` in `server/src/repo-shared.ts`:
```ts
export function parseFieldConfig(
  type: string,
  raw: unknown,
): { options?: OptionDef[]; numberFormat?: NumberFormat; ratingMax?: number } {
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
  return {};
}
```

- [ ] **Step 5: Update FieldDef**

```ts
export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
}
```

- [ ] **Step 6: Run tests**

```bash
cd server && bun test test/number-format.test.ts 2>&1 | tail -20
```

Expected: the new test passes. Existing tests should still pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/repo-shared.ts server/test/number-format.test.ts
git commit -m "feat(server): extend NumberFormat, add parseFieldConfig, update FieldDef"
```

---

## Task 3: Refactor changeColumnType to options-object + add new coercion rules

**Files:**
- Modify: `server/src/repo-canonical.ts`
- Modify: `server/src/server.ts`
- Modify: `server/test/number-format.test.ts`

- [ ] **Step 1: Write failing tests for new coercion rules**

Add to `server/test/number-format.test.ts`:
```ts
test("changeColumnType to rating persists ratingMax and coerces integer values", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Products", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Score", "number", undefined, {}, userId);
  // Add a canonical row with score = 3
  await repo.addCanonicalOne(dimId, "Widget", undefined, userId);
  const canonical = (await repo.getDimension(dimId))!.canonical;
  const key = canonical[0].key;
  const { pgRun } = await import("../src/pg.ts");
  const { pg } = await import("../src/env.ts");
  await pgRun(`UPDATE zugzug.dim_products SET score = 3 WHERE product = $1`, [key]);

  const res = await repo.changeColumnType(dimId, "score", {
    newType: "rating",
    ratingMax: 5,
    coerceInvalidToNull: false,
    userId,
  });
  expect(res.ok).toBe(true);
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.field === "score");
  expect(f?.type).toBe("rating");
  expect(f?.ratingMax).toBe(5);
});

test("changeColumnType to url is a lossless relabel", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brands", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Site", "text", undefined, {}, userId);
  const res = await repo.changeColumnType(dimId, "site", {
    newType: "url",
    coerceInvalidToNull: false,
    userId,
  });
  expect(res.ok).toBe(true);
  const fields = await repo.listFields(dimId);
  expect(fields.find((x) => x.field === "site")?.type).toBe("url");
});
```

- [ ] **Step 2: Run to see them fail**

```bash
cd server && bun test test/number-format.test.ts 2>&1 | tail -20
```

Expected: fails — `changeColumnType` still takes positional args.

- [ ] **Step 3: Refactor changeColumnType signature in repo-canonical.ts**

Replace the function signature (lines 482–490) and update the call body. The new signature:
```ts
export async function changeColumnType(
  dimId: string,
  field: string,
  opts: {
    newType: string;
    options?: OptionDef[];
    numberFormat?: NumberFormat;
    ratingMax?: number;
    coerceInvalidToNull: boolean;
    userId: string;
  },
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
```

Inside the function, replace all references to the old positional params:
- `newType` → `opts.newType`
- `options` → `opts.options`
- `coerceInvalidToNull` → `opts.coerceInvalidToNull`
- `userId` → `opts.userId`
- `numberFormat` → `opts.numberFormat`

- [ ] **Step 4: Add url/email fast-path before the coercion loop**

Insert this block after the early `if (!f) return { ok: false }` guard, before the `rows` fetch:
```ts
// url and email are VARCHAR relabels — no data migration needed
if (opts.newType === "url" || opts.newType === "email") {
  await pgTx(async ({ run }) => {
    await run(
      `UPDATE ${pg("dimension_field")} SET type = $1, field_config = null WHERE dim_id = $2 AND field = $3`,
      [opts.newType, dimId, field],
    );
  });
  await appendAuditAs(opts.userId, "Changed column type", `${field} → ${opts.newType}`);
  return { ok: true };
}
```

- [ ] **Step 5: Add rating coercion branch to the parse loop**

Add before the final fallthrough `parsed.push({ k: r.k, v: r.v, bad: true })`:
```ts
if (opts.newType === "rating") {
  const max = opts.ratingMax ?? 5;
  if (r.v === "true") {
    // boolean true → 1
    parsed.push({ k: r.k, v: 1, bad: false });
    continue;
  }
  if (r.v === "false") {
    // boolean false → 0, out of range → bad
    parsed.push({ k: r.k, v: null, bad: true });
    continue;
  }
  const n = Number(r.v);
  if (!Number.isFinite(n)) {
    parsed.push({ k: r.k, v: null, bad: true });
    continue;
  }
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > max) {
    parsed.push({ k: r.k, v: null, bad: true });
    continue;
  }
  parsed.push({ k: r.k, v: rounded, bad: false });
  continue;
}
```

- [ ] **Step 6: Add rating to SQL_TYPE map and newSql resolution**

In the `SQL_TYPE` constant at the top of `repo-canonical.ts`, add:
```ts
const SQL_TYPE: Record<string, string> = {
  text: "VARCHAR",
  number: "NUMERIC",
  boolean: "BOOLEAN",
  date: "DATE",
  url: "VARCHAR",
  email: "VARCHAR",
  rating: "INTEGER",
};
```

In the `newSql` resolution after the validation loop, update the chain to include rating:
```ts
const newSql = SQL_TYPE[opts.newType] ?? "VARCHAR";
```

- [ ] **Step 7: Write rating config to field_config in the transaction**

Update the `UPDATE dimension_field` inside `pgTx` (currently lines 573–585):
```ts
await run(
  `UPDATE ${pg("dimension_field")} SET type = $1, field_config = $2 WHERE dim_id = $3 AND field = $4`,
  [
    opts.newType,
    opts.newType === "select"
      ? JSON.stringify(finalOptions ?? [])
      : opts.newType === "number" && opts.numberFormat != null
        ? JSON.stringify(opts.numberFormat)
        : opts.newType === "rating"
          ? JSON.stringify({ ratingMax: opts.ratingMax ?? 5 })
          : null,
    dimId,
    field,
  ],
);
```

- [ ] **Step 8: Update server.ts to use new signature**

In `server/src/server.ts` around line 347, update the call and add `ratingMax` to the body type:
```ts
const body = (await req.json()) as {
  label?: string;
  type?: string;
  options?: { label: string; color: string | null }[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  coerceInvalidToNull?: boolean;
};
// ...
if (body.type != null) {
  const res = await repo.changeColumnType(id, field, {
    newType: body.type,
    options: body.options as repo.OptionDef[] | undefined,
    numberFormat: body.numberFormat,
    ratingMax: body.ratingMax,
    coerceInvalidToNull: body.coerceInvalidToNull ?? false,
    userId: me,
  });
  return json(res);
}
```

- [ ] **Step 9: Update existing server tests for new signature**

In `server/test/number-format.test.ts`, update the existing `changeColumnType` call at line 62:
```ts
await repo.changeColumnType(dimId, "score", {
  newType: "number",
  numberFormat: { format: "currency", symbol: "€", position: "prefix", precision: 2 },
  coerceInvalidToNull: false,
  userId,
});
```

- [ ] **Step 10: Run all server tests**

```bash
cd server && bun test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add server/src/repo-canonical.ts server/src/server.ts server/test/number-format.test.ts
git commit -m "feat(server): refactor changeColumnType to options-object, add rating/url/email coercion"
```

---

## Task 4: Update addField and listFields for new types

**Files:**
- Modify: `server/src/repo-canonical.ts`

- [ ] **Step 1: Write a failing test**

Add to `server/test/number-format.test.ts`:
```ts
test("addField with type=rating persists ratingMax via listFields", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Reviews", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Stars", "rating", undefined, { ratingMax: 5 }, userId);
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.label === "Stars");
  expect(f?.type).toBe("rating");
  expect(f?.ratingMax).toBe(5);
  expect(f?.options).toBeUndefined();
  expect(f?.numberFormat).toBeUndefined();
});

test("addField with type=url and listFields returns it", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Links", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Website", "url", undefined, {}, userId);
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.label === "Website");
  expect(f?.type).toBe("url");
  expect(f?.ratingMax).toBeUndefined();
});
```

- [ ] **Step 2: Run to see them fail**

```bash
cd server && bun test test/number-format.test.ts 2>&1 | tail -20
```

Expected: fails — addField doesn't handle `rating` type.

- [ ] **Step 3: Update SQL_TYPE and addField**

`url` and `email` already fall through to `VARCHAR` via the fallback in `addField`. Add `rating` to the SQL_TYPE handling explicitly. In `addField`, update the `t` normalization and `optsJson`:

```ts
export async function addField(
  dimId: string,
  label: string,
  type: string = "text",
  options: OptionDef[] | undefined,
  opts: { silent?: boolean; numberFormat?: NumberFormat; ratingMax?: number } = {},
  userId: string,
): Promise<{ field: string } | null> {
  const m = await dimMeta(dimId);
  if (!m) return null;
  const KNOWN = new Set(["text","number","boolean","date","select","url","email","rating"]);
  const t = KNOWN.has(type) ? type : "text";
  const field = slug(label);
  if (!field || field === "label" || field === slug(m.keyCol)) return null;
  const sqlType = SQL_TYPE[t] ?? "VARCHAR";
  await pgRun(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN IF NOT EXISTS ${qid(field)} ${sqlType}`);
  const optsJson =
    t === "select"
      ? JSON.stringify(options ?? [])
      : t === "number" && opts.numberFormat != null
        ? JSON.stringify(opts.numberFormat)
        : t === "rating"
          ? JSON.stringify({ ratingMax: opts.ratingMax ?? 5 })
          : null;
  await pgRun(
    `INSERT INTO ${pg("dimension_field")} (dim_id, field, label, type, field_config, created_at)
     VALUES ($1, $2, $3, $4, $5, current_timestamp) ON CONFLICT (dim_id, field) DO NOTHING`,
    [dimId, field, label.trim(), t, optsJson],
  );
  if (!opts.silent) {
    await appendAuditAs(userId, "Added field", `${label.trim()} (${field}, ${t}) → ${m.dimTable}`);
  }
  return { field };
}
```

- [ ] **Step 4: Update listFields to use field_config and parseFieldConfig**

Replace `listFields` (lines 411–423):
```ts
export async function listFields(dimId: string): Promise<FieldDef[]> {
  const rows = await pgAll<{ field: string; label: string; type: string; field_config: string | null }>(
    `SELECT field, label, type, field_config FROM ${pg("dimension_field")} WHERE dim_id = $1 ORDER BY created_at`,
    [dimId],
  );
  return rows.map((r) => ({
    field: r.field,
    label: r.label,
    type: r.type,
    ...parseFieldConfig(r.type, r.field_config),
  }));
}
```

- [ ] **Step 5: Update addColumnOption**

In `addColumnOption`, update the raw SQL column name from `options` to `field_config` (line 633):
```ts
await pgRun(
  `UPDATE ${pg("dimension_field")} SET field_config = $1 WHERE dim_id = $2 AND field = $3`,
  [JSON.stringify(updated), dimId, field],
);
```

Also update its SELECT that reads the existing options (find the SELECT in `addColumnOption` and update the column name there too).

- [ ] **Step 6: Run all server tests**

```bash
cd server && bun test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/repo-canonical.ts server/test/number-format.test.ts
git commit -m "feat(server): addField/listFields support rating, url, email types"
```

---

## Task 5: Update client store.ts to pass ratingMax

**Files:**
- Modify: `app/src/store.ts`

- [ ] **Step 1: Add ratingMax to changeColumnType wrapper**

In `app/src/store.ts`, update `changeColumnType`:
```ts
export async function changeColumnType(
  dimId: string,
  field: string,
  newType: string,
  options?: OptionDef[],
  coerceInvalidToNull = false,
  numberFormat?: NumberFormat,
  ratingMax?: number,
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
  const res = await api<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }>(
    `/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`,
    {
      method: "PUT",
      body: JSON.stringify({ type: newType, options, coerceInvalidToNull, numberFormat, ratingMax }),
    },
  );
  if (res.ok) {
    await refreshDim(dimId);
    emit();
  }
  return res;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -20
```

Expected: no errors in store.ts.

- [ ] **Step 3: Commit**

```bash
git add app/src/store.ts
git commit -m "feat(store): pass ratingMax through changeColumnType API wrapper"
```

---

## Task 6: ColumnConfig discriminated union (client types)

**Files:**
- Modify: `app/src/data.ts`
- Modify: `app/src/components/datagrid/types.ts`

- [ ] **Step 1: Extend NumberFormat in data.ts**

In `app/src/data.ts`, replace `NumberFormat`:
```ts
export type NumberFormat =
  | { format: "integer" }
  | { format: "decimal"; precision: 1 | 2 | 3 | 4 }
  | { format: "percent"; precision: 0 | 1 | 2 }
  | { format: "currency"; symbol: string; position: "prefix" | "suffix"; precision: 0 | 1 | 2 }
  | { format: "compact"; precision: 0 | 1 | 2 }
  | { format: "duration"; display: "hm" | "hms" };
```

- [ ] **Step 2: Add ColumnConfig + update ColumnDef in types.ts**

In `app/src/components/datagrid/types.ts`, replace the file header section (keep imports, replace CellType and ColumnDef):
```ts
export type ColumnConfig =
  | { type: "text" }
  | { type: "number"; numberFormat?: NumberFormat }
  | { type: "boolean" }
  | { type: "date" }
  | { type: "select"; options: OptionDef[] }
  | { type: "url" }
  | { type: "email" }
  | { type: "rating"; ratingMax: number };

export type CellType = ColumnConfig["type"];

export interface ColumnDef<Row> {
  field: string;
  label: string;
  config: ColumnConfig;
  width?: number;
  hidden?: boolean;
  sortable?: boolean;
  editable?: boolean;
  pinnedLeft?: boolean;
  align?: "left" | "right";
  render?: (row: Row, ctx: CellCtx<Row>) => ReactNode;
  edit?: (row: Row, ctx: EditCtx<Row>) => ReactNode;
}
```

Remove the old `export type CellType = "text" | ...` line and the old `ColumnDef` interface. Keep `NumberFormat` re-export, `OptionDef`, `CellCtx`, `EditCtx`, `Cursor`, filter types, and `DataGridProps` — but update `DataGridProps.onChangeColumnType` opts signature:
```ts
onChangeColumnType?: (
  field: string,
  newConfig: ColumnConfig,
  opts?: { coerceInvalidToNull?: boolean },
) => Promise<{ ok: boolean; invalidCount?: number }>;
```

- [ ] **Step 3: Run typecheck to see what's broken**

```bash
cd app && bun run typecheck 2>&1 | grep "error TS" | head -40
```

Expected: errors in DataGrid.tsx, NumberCell.tsx, ColumnHeaderMenu.tsx, TablePane.tsx. That's normal — Tasks 7-10 fix them.

- [ ] **Step 4: Commit the type foundation (compile-broken state is OK here)**

```bash
git add app/src/data.ts app/src/components/datagrid/types.ts
git commit -m "feat(types): add ColumnConfig discriminated union, extend NumberFormat"
```

---

## Task 7: Migrate DataGrid.tsx to col.config

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx`

- [ ] **Step 1: Add icon imports for new types**

Find the icon imports block in DataGrid.tsx. Add (or use existing if present):
```ts
import {
  IconFieldText, IconFieldNumber, IconFieldBoolean, IconFieldDate, IconFieldSelect,
  IconLink, IconAt, IconStar,   // add these — check Icons.tsx for exact names
} from "../Icons";
```

If `IconLink`, `IconAt`, `IconStar` don't exist in Icons.tsx, use text fallback components inline:
```ts
const IconFieldUrl = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>↗</span>
);
const IconFieldEmail = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>@</span>
);
const IconFieldRating = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>★</span>
);
```

- [ ] **Step 2: Update FIELD_TYPE_ICONS**

```ts
const FIELD_TYPE_ICONS: Record<CellType, React.ComponentType<{ className?: string }>> = {
  text:    IconFieldText,
  number:  IconFieldNumber,
  boolean: IconFieldBoolean,
  date:    IconFieldDate,
  select:  IconFieldSelect,
  url:     IconFieldUrl,
  email:   IconFieldEmail,
  rating:  IconFieldRating,
};
```

- [ ] **Step 3: Update CELLS**

```ts
const CELLS: Record<Exclude<CellType, "select">, { Renderer: any; Editor: any }> = {
  text:    TextCell,
  number:  NumberCell,
  boolean: BooleanCell,
  date:    DateCell,
  url:     UrlCell,    // created in Task 11
  email:   EmailCell,  // created in Task 11
  rating:  RatingCell, // created in Task 12
};
```

For now, use `TextCell` as a placeholder for the three new types until they're built:
```ts
  url:    TextCell,
  email:  TextCell,
  rating: TextCell,
```

- [ ] **Step 4: Update all col.type references**

Find every `col.type` reference in DataGrid.tsx. Key spots:
1. `FIELD_TYPE_ICONS[c.type]` → `FIELD_TYPE_ICONS[c.config.type]`
2. `coerceForColumn` function — update the switch:
```ts
const coerceForColumn = useCallback(
  (rawVal: string, col: (typeof orderedVisible)[number]): unknown => {
    switch (col.config.type) {
      case "number": {
        const n = Number(rawVal);
        return isNaN(n) ? null : n;
      }
      case "boolean": return rawVal.toLowerCase() === "true";
      case "select": {
        const match = col.config.options.find((o) => o.label === rawVal);
        if (!match) return undefined;
        return rawVal;
      }
      case "rating": {
        const n = parseInt(rawVal, 10);
        return isNaN(n) ? null : n;
      }
      default: return rawVal;
    }
  },
  [],
);
```

3. Any other `col.type` or `col.options` or `col.numberFormat` reference — replace with `col.config.type`, `col.config.options` (narrowed), `col.config.numberFormat` (narrowed).

4. Add `satisfies never` in any switch:
```ts
default: col.config satisfies never; return rawVal;
```

5. Update `onChangeColumnType` call site. Find the handler in DataGrid.tsx that calls `onChangeColumnType` (around line 1077, inside the `ColumnHeaderMenu onChangeType` callback). It currently looks like:
```ts
onChangeType={async (newType, numberFormat) => {
  const res = await onChangeColumnType?.(field, newType, { numberFormat });
  if (!res?.ok && res?.invalidCount) {
    if (confirm(`${res.invalidCount} value(s) won't parse as ${newType}. Coerce to empty?`)) {
      await onChangeColumnType?.(field, newType, { numberFormat, coerceInvalidToNull: true });
    }
  }
}}
```
Update to the new `ColumnConfig` shape:
```ts
onChangeType={async (newConfig) => {
  const res = await onChangeColumnType?.(field, newConfig);
  if (!res?.ok && res?.invalidCount) {
    if (confirm(`${res.invalidCount} value(s) won't parse as ${newConfig.type}. Coerce to empty?`)) {
      await onChangeColumnType?.(field, newConfig, { coerceInvalidToNull: true });
    }
  }
}}
```

- [ ] **Step 5: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: errors now only in NumberCell.tsx, ColumnHeaderMenu.tsx, TablePane.tsx.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx
git commit -m "feat(datagrid): migrate to col.config, add url/email/rating placeholders"
```

---

## Task 8: Migrate NumberCell.tsx + add compact/duration formats

**Files:**
- Modify: `app/src/components/datagrid/cells/NumberCell.tsx`
- Modify: `app/test/number-format.test.ts`

- [ ] **Step 1: Write failing tests for compact and duration**

Add to `app/test/number-format.test.ts`:
```ts
describe("compact format", () => {
  test("precision 0: abbreviates to nearest unit", () => {
    expect(formatNumber(45000, { format: "compact", precision: 0 })).toBe("45K");
    expect(formatNumber(1200000, { format: "compact", precision: 0 })).toBe("1M");
    expect(formatNumber(999, { format: "compact", precision: 0 })).toBe("999");
  });
  test("precision 1: one decimal after abbreviation", () => {
    expect(formatNumber(1200000, { format: "compact", precision: 1 })).toBe("1.2M");
  });
  test("negative values", () => {
    expect(formatNumber(-45000, { format: "compact", precision: 0 })).toBe("-45K");
  });
});

describe("duration format", () => {
  test("hm: shows hours and minutes, drops seconds", () => {
    expect(formatNumber(3600 + 23 * 60, { format: "duration", display: "hm" })).toBe("1h 23m");
    expect(formatNumber(45 * 60, { format: "duration", display: "hm" })).toBe("45m");
    expect(formatNumber(30, { format: "duration", display: "hm" })).toBe("< 1m");
  });
  test("hms: zero-padded H:MM:SS", () => {
    expect(formatNumber(3600 + 23 * 60 + 45, { format: "duration", display: "hms" })).toBe("1:23:45");
    expect(formatNumber(90, { format: "duration", display: "hms" })).toBe("0:01:30");
  });
  test("null returns em dash", () => {
    expect(formatNumber(null, { format: "duration", display: "hm" })).toBe("—");
  });
});
```

- [ ] **Step 2: Run to see them fail**

```bash
cd app && bun run test test/number-format.test.ts 2>&1 | tail -20
```

Expected: compact/duration cases fail.

- [ ] **Step 3: Add compact and duration to formatNumber**

In `app/src/components/datagrid/cells/NumberCell.tsx`, add to the `formatNumber` switch:
```ts
case "compact": {
  // Intl compact notation — values < 1000 display as-is
  return n.toLocaleString("en-US", {
    notation: "compact",
    minimumFractionDigits: fmt.precision,
    maximumFractionDigits: fmt.precision,
  } as Intl.NumberFormatOptions);
}

case "duration": {
  const secs = Math.round(Math.abs(n));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (fmt.display === "hm") {
    if (secs < 60) return "< 1m";
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  // hms: H:MM:SS
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Migrate column.numberFormat access to col.config**

In `NumberCell.tsx`, the `Renderer` and `Editor` access `column.numberFormat`. Update both:
```ts
// Helper to extract NumberFormat from ColumnDef
function getNumberFormat<Row>(column: ColumnDef<Row>): NumberFormat | undefined {
  return column.config.type === "number" ? column.config.numberFormat : undefined;
}
```

Replace `column.numberFormat` with `getNumberFormat(column)` in both `Renderer` and `Editor`.

- [ ] **Step 5: Add duration Editor**

The duration editor accepts HH:MM:SS input. Add helper functions and a new Editor branch:
```ts
function secondsToHms(n: number): string {
  const secs = Math.round(Math.abs(n));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function hmsToSeconds(v: string): number | null {
  const match = v.trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);
  const s = parseInt(match[3]!, 10);
  if (m >= 60 || s >= 60) return null;
  return h * 3600 + m * 60 + s;
}
```

In the `Editor` component, when `fmt?.format === "duration"`, replace the display value and commit logic:
```ts
const isDuration = fmt?.format === "duration";
const displayValue = isDuration && value != null && Number.isFinite(Number(value))
  ? secondsToHms(Number(value))
  : value == null ? "" : String(value);

// In commitNow:
const commitNow = () => {
  const t = v.trim();
  if (t === "") { commit(null); return; }
  if (isDuration) {
    const secs = hmsToSeconds(t);
    commit(secs); // null if invalid → stored as null
    return;
  }
  // existing number logic...
};
```

Placeholder for the input: when `isDuration`, show `placeholder="0:00:00"`.

- [ ] **Step 6: Run tests**

```bash
cd app && bun run test test/number-format.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 7: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: NumberCell errors gone. Remaining errors only in ColumnHeaderMenu.tsx, TablePane.tsx.

- [ ] **Step 8: Commit**

```bash
git add app/src/components/datagrid/cells/NumberCell.tsx app/test/number-format.test.ts
git commit -m "feat(number-cell): compact/duration formats, duration HH:MM:SS editor, migrate to col.config"
```

---

## Task 9: Migrate ColumnHeaderMenu.tsx

**Files:**
- Modify: `app/src/components/datagrid/ColumnHeaderMenu.tsx`

- [ ] **Step 1: Update Props type**

`ColumnHeaderMenu` receives `column: ColumnDef<Row>` and calls `onChangeType(newType, numberFormat?)`. Update to:
```ts
interface Props<Row> {
  column: ColumnDef<Row>;
  // ...
  onChangeType: (newConfig: ColumnConfig) => void;
  // ...
}
```

- [ ] **Step 2: Update local state seeding**

Currently seeds `numFmt` from `column.numberFormat`. Update:
```ts
const existingFmt = column.config.type === "number" ? column.config.numberFormat : undefined;
const [numFmt, setNumFmt] = useState<"integer" | "decimal" | "percent" | "currency" | "compact" | "duration">(
  existingFmt?.format ?? "integer",
);
const [numPrecision, setNumPrecision] = useState<number>(
  existingFmt && "precision" in existingFmt ? existingFmt.precision : 0,
);
const [durationDisplay, setDurationDisplay] = useState<"hm" | "hms">(
  existingFmt?.format === "duration" ? existingFmt.display : "hm",
);
const [currSymbol, setCurrSymbol] = useState(
  existingFmt?.format === "currency" ? existingFmt.symbol : "$",
);
const [currPosition, setCurrPosition] = useState<"prefix" | "suffix">(
  existingFmt?.format === "currency" ? existingFmt.position : "prefix",
);
const [ratingMax, setRatingMax] = useState<number>(
  column.config.type === "rating" ? column.config.ratingMax : 5,
);
const [ratingMaxCustom, setRatingMaxCustom] = useState("");
```

- [ ] **Step 3: Update TYPES array and mode state**

```ts
const TYPES: CellType[] = ["text", "number", "boolean", "date", "select", "url", "email", "rating"];

// Add "rating-max" to the mode union:
const [mode, setMode] = useState<"menu" | "rename" | "type" | "number-format" | "rating-max" | "filter" | "confirm-delete">("menu");
```

- [ ] **Step 4: Update type selection onClick**

In the type list rendering, update the click handler:
```ts
onClick={() => {
  if (t === "number") {
    setMode("number-format");
  } else if (t === "rating") {
    setMode("rating-max");
  } else if (t !== column.config.type) {
    onChangeType({ type: t } as ColumnConfig);
    onClose();
  } else {
    onClose();
  }
}}
```

Mark the current type using `column.config.type === t` for the active style.

- [ ] **Step 5: Make type list scrollable**

Wrap the TYPES map in:
```tsx
<div className="max-h-[240px] overflow-y-auto">
  {TYPES.map(...)}
</div>
```

- [ ] **Step 6: Add compact and duration tiles to number-format sub-panel**

In the `mode === "number-format"` section, extend the format tiles array:
```ts
(["integer", "decimal", "percent", "currency", "compact", "duration"] as const).map(...)
```

Icons for the new tiles: `compact` → `"1.2M"` (use `text-[9px]` to fit), `duration` → `"⏱"`.

After the existing precision/currency controls, add:
```tsx
{/* Duration display-mode toggle */}
{numFmt === "duration" && (
  <div className="flex items-center gap-2">
    <span className="font-mono text-[10px] text-ink-3 w-16 shrink-0">Display</span>
    <div className="flex gap-1">
      {(["hm", "hms"] as const).map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => setDurationDisplay(d)}
          className={cx(
            "rounded-sm border px-2 py-0.5 font-mono text-[10px] transition-colors",
            durationDisplay === d
              ? "border-accent bg-accent-wash text-ink"
              : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
          )}
        >
          {d === "hm" ? "h m" : "h:mm:ss"}
        </button>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 7: Update number-format Apply to emit ColumnConfig**

In the Apply button onClick, build a full `ColumnConfig` and call `onChangeType`:
```ts
onClick={() => {
  let fmt: NumberFormat;
  if (numFmt === "integer") fmt = { format: "integer" };
  else if (numFmt === "decimal") fmt = { format: "decimal", precision: numPrecision as 1|2|3|4 };
  else if (numFmt === "percent") fmt = { format: "percent", precision: numPrecision as 0|1|2 };
  else if (numFmt === "compact") fmt = { format: "compact", precision: numPrecision as 0|1|2 };
  else if (numFmt === "duration") fmt = { format: "duration", display: durationDisplay };
  else fmt = { format: "currency", symbol: currSymbol || "$", position: currPosition, precision: numPrecision as 0|1|2 };
  onChangeType({ type: "number", numberFormat: fmt });
  onClose();
}}
```

- [ ] **Step 8: Add rating-max sub-panel**

Add a new mode block after the number-format block:
```tsx
{mode === "rating-max" && (
  <div className="p-2 space-y-2">
    <button type="button" onClick={() => setMode("type")} className="flex items-center gap-1 font-mono text-[11px] text-ink-3 hover:text-ink">
      <IconChevronLeft className="h-3 w-3" /> Back
    </button>
    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3 px-1">Max stars</div>
    <div className="flex gap-1 px-1">
      {[3, 5, 10].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => { setRatingMax(n); setRatingMaxCustom(""); }}
          className={cx(
            "h-7 w-8 rounded-sm border font-mono text-[11px] transition-colors",
            ratingMax === n && !ratingMaxCustom
              ? "border-accent bg-accent-wash text-ink"
              : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
          )}
        >{n}</button>
      ))}
      <input
        value={ratingMaxCustom}
        onChange={(e) => {
          setRatingMaxCustom(e.target.value);
          const n = parseInt(e.target.value, 10);
          if (n >= 1 && n <= 20) setRatingMax(n);
        }}
        placeholder="…"
        className="w-10 rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink outline-none focus:border-accent"
      />
    </div>
    <button
      type="button"
      onClick={() => { onChangeType({ type: "rating", ratingMax }); onClose(); }}
      className="w-full rounded-sm border border-accent bg-accent px-3 py-1.5 font-mono text-[11px] text-accent-ink hover:opacity-90"
    >Apply</button>
  </div>
)}
```

- [ ] **Step 9: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: ColumnHeaderMenu errors gone. Remaining errors only in TablePane.tsx.

- [ ] **Step 10: Commit**

```bash
git add app/src/components/datagrid/ColumnHeaderMenu.tsx
git commit -m "feat(column-header-menu): add url/email/rating types, compact/duration format, ratingMax panel"
```

---

## Task 10: Migrate TablePane.tsx (fieldDefToColumnConfig helper)

**Files:**
- Modify: `app/src/components/TablePane.tsx`

- [ ] **Step 1: Add fieldDefToColumnConfig helper**

Add near the top of the component file, after imports:
```ts
import type { ColumnConfig } from "./datagrid/types";
import type { FieldDef } from "../data";

function fieldDefToColumnConfig(f: FieldDef): ColumnConfig {
  switch (f.type) {
    case "number":  return { type: "number", numberFormat: f.numberFormat };
    case "boolean": return { type: "boolean" };
    case "date":    return { type: "date" };
    case "select":  return { type: "select", options: f.options ?? [] };
    case "url":     return { type: "url" };
    case "email":   return { type: "email" };
    case "rating":  return { type: "rating", ratingMax: f.ratingMax ?? 5 };
    default:        return { type: "text" };
  }
}
```

- [ ] **Step 2: Update ColumnDef construction in fields.map**

Replace lines 269–277:
```ts
...fields.map<ColumnDef<CanonicalValue>>((f) => ({
  field:    f.field,
  label:    f.label,
  config:   fieldDefToColumnConfig(f),
  editable: true,
  render:   undefined,
})),
```

- [ ] **Step 3: Update the pinned key column**

The `key` column currently uses `type: "text"`. Update to `config: { type: "text" }`:
```ts
{
  field: dim.keyCol,
  label: external ? "ID" : "Key",
  config: { type: "text" },
  pinnedLeft: true,
  editable: false,
  render: ...
}
```

- [ ] **Step 4: Update onChangeColumnType callback in TablePane**

TablePane passes `onChangeColumnType` to DataGrid. With the new signature `(field, newConfig, opts?)`, update the callback to extract type/numberFormat/ratingMax from `newConfig`:
```ts
onChangeColumnType={async (field, newConfig, opts) => {
  const newType = newConfig.type;
  const numberFormat = newConfig.type === "number" ? newConfig.numberFormat : undefined;
  const ratingMax = newConfig.type === "rating" ? newConfig.ratingMax : undefined;
  const selectOptions = newConfig.type === "select" ? newConfig.options : undefined;
  return changeColumnType(
    dim.id,
    field,
    newType,
    selectOptions,
    opts?.coerceInvalidToNull ?? false,
    numberFormat,
    ratingMax,
  );
}}
```

- [ ] **Step 5: Typecheck — should now be clean**

```bash
cd app && bun run typecheck 2>&1 | grep "error TS"
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "feat(table-pane): fieldDefToColumnConfig helper, migrate ColumnDef construction to col.config"
```

---

## Task 11: UrlCell and EmailCell

**Files:**
- Create: `app/src/components/datagrid/cells/UrlCell.tsx`
- Create: `app/src/components/datagrid/cells/EmailCell.tsx`

- [ ] **Step 1: Create UrlCell.tsx**

```tsx
import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase =
  "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const href = typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  if (!href) return <span className="font-mono text-[12px] text-ink-3">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="flex min-w-0 items-center gap-1 font-mono text-[12px] text-accent hover:underline"
    >
      <span className="shrink-0 text-[10px] text-ink-3">↗</span>
      <span className="truncate">{href}</span>
    </a>
  );
}

function Editor<Row>({ value, initial, commit, cancel }: EditCtx<Row>) {
  const seeded = initial != null;
  const [v, setV] = useState(seeded ? initial : value == null ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (seeded) {
      const el = ref.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    } else {
      ref.current?.select();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const commitNow = () => commit(v.trim() === "" ? null : v.trim());
  return (
    <input
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commitNow}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
        if (e.key === "Enter" || e.key === "Tab") commitNow();
      }}
      className={inputBase}
    />
  );
}

export const UrlCell = { Renderer, Editor };
```

- [ ] **Step 2: Create EmailCell.tsx**

```tsx
import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";

const inputBase =
  "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none";

function Renderer<Row>({ value }: CellCtx<Row>) {
  const email = typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  if (!email) return <span className="font-mono text-[12px] text-ink-3">—</span>;
  return (
    <a
      href={`mailto:${email}`}
      onClick={(e) => e.stopPropagation()}
      className="flex min-w-0 items-center gap-1 font-mono text-[12px] text-accent hover:underline"
    >
      <span className="shrink-0 font-mono text-[11px] text-ink-3">@</span>
      <span className="truncate">{email}</span>
    </a>
  );
}

function Editor<Row>({ value, initial, commit, cancel }: EditCtx<Row>) {
  const seeded = initial != null;
  const [v, setV] = useState(seeded ? initial : value == null ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (seeded) {
      const el = ref.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    } else {
      ref.current?.select();
    }
  }, []); // eslint-disable-line react-helpers/exhaustive-deps
  const commitNow = () => commit(v.trim() === "" ? null : v.trim());
  return (
    <input
      ref={ref}
      type="email"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commitNow}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
        if (e.key === "Enter" || e.key === "Tab") commitNow();
      }}
      className={inputBase}
    />
  );
}

export const EmailCell = { Renderer, Editor };
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | grep "error TS"
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/cells/UrlCell.tsx app/src/components/datagrid/cells/EmailCell.tsx
git commit -m "feat(cells): UrlCell and EmailCell"
```

---

## Task 12: RatingCell

**Files:**
- Create: `app/src/components/datagrid/cells/RatingCell.tsx`

- [ ] **Step 1: Create RatingCell.tsx**

```tsx
import { useEffect, useRef } from "react";
import type { CellCtx, EditCtx } from "../types";

function Stars({
  value,
  max,
  interactive,
  onPick,
}: {
  value: number | null;
  max: number;
  interactive: boolean;
  onPick?: (n: number) => void;
}) {
  return (
    <span className="flex items-center gap-0.5">
      {Array.from({ length: max }, (_, i) => {
        const filled = value != null && i < value;
        return (
          <span
            key={i}
            aria-label={`${i + 1} star${i === 0 ? "" : "s"}`}
            role={interactive ? "button" : undefined}
            onClick={interactive && onPick ? () => onPick(i + 1) : undefined}
            className={
              interactive
                ? "cursor-pointer text-[13px] leading-none text-amber-400 hover:scale-110 transition-transform"
                : "text-[13px] leading-none text-amber-400"
            }
          >
            {filled ? "★" : "☆"}
          </span>
        );
      })}
    </span>
  );
}

function Renderer<Row>({ value, column }: CellCtx<Row>) {
  const max = column.config.type === "rating" ? column.config.ratingMax : 5;
  const n = value == null || value === "" ? null : Number(value);
  if (n == null || !Number.isFinite(n)) {
    return <span className="font-mono text-[12px] text-ink-3">—</span>;
  }
  return <Stars value={Math.round(n)} max={max} interactive={false} />;
}

function Editor<Row>({ value, commit, cancel, column }: EditCtx<Row>) {
  const max = column.config.type === "rating" ? column.config.ratingMax : 5;
  const n = value == null || value === "" ? null : Number(value);
  const current = n != null && Number.isFinite(n) ? Math.round(n) : null;

  const ref = useRef<HTMLSpanElement>(null);

  // Guard: non-digit type-to-edit cancels immediately; digit type-to-edit commits directly.
  useEffect(() => {
    if (initial != null) {
      if (!/^[1-9]$/.test(initial) || parseInt(initial, 10) > max) {
        cancel();
        return;
      }
      commit(parseInt(initial, 10));
      return;
    }
    ref.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span
      ref={ref}
      tabIndex={0}
      className="flex items-center gap-0.5 outline-none"
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
        if (e.key === "Delete" || e.key === "Backspace") { commit(null); return; }
        const digit = parseInt(e.key, 10);
        if (!isNaN(digit) && digit >= 1 && digit <= max) { commit(digit); return; }
      }}
    >
      <Stars
        value={current}
        max={max}
        interactive={true}
        onPick={(n) => commit(n)}
      />
    </span>
  );
}

export const RatingCell = { Renderer, Editor };
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | grep "error TS"
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/cells/RatingCell.tsx
git commit -m "feat(cells): RatingCell with star renderer and keyboard/click editor"
```

---

## Task 13: Register UrlCell, EmailCell, RatingCell in DataGrid

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx`

- [ ] **Step 1: Import new cells**

Add to DataGrid.tsx imports:
```ts
import { UrlCell } from "./cells/UrlCell";
import { EmailCell } from "./cells/EmailCell";
import { RatingCell } from "./cells/RatingCell";
```

- [ ] **Step 2: Replace TextCell placeholders in CELLS**

```ts
const CELLS: Record<Exclude<CellType, "select">, { Renderer: any; Editor: any }> = {
  text:    TextCell,
  number:  NumberCell,
  boolean: BooleanCell,
  date:    DateCell,
  url:     UrlCell,
  email:   EmailCell,
  rating:  RatingCell,
};
```

- [ ] **Step 3: Run client tests**

```bash
cd app && bun run test 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 4: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | grep "error TS"
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx
git commit -m "feat(datagrid): register UrlCell, EmailCell, RatingCell"
```

---

## Task 14: AddFieldPopover — new tiles + ratingMax + compact/duration config

**Files:**
- Modify: `app/src/components/AddFieldPopover.tsx`

- [ ] **Step 1: Add new type tiles**

In `AddFieldPopover.tsx`, extend `TYPE_TILES`:
```ts
const TYPE_TILES: TypeTile[] = [
  { type: "text",    icon: "A",  label: "Text" },
  { type: "number",  icon: "#",  label: "Number" },
  { type: "boolean", icon: "☑",  label: "Boolean" },
  { type: "date",    icon: "⊞",  label: "Date" },
  { type: "select",  icon: "◉",  label: "Select" },
  { type: "url",     icon: "↗",  label: "URL" },
  { type: "email",   icon: "@",  label: "Email" },
  { type: "rating",  icon: "★",  label: "Rating" },
];
```

Update the `FieldType` to use `CellType` (import from datagrid/types):
```ts
import type { CellType } from "./datagrid/types";
type FieldType = CellType;
```

Update `AddFieldInput.type` to use `CellType`.

- [ ] **Step 2: Add ratingMax + durationDisplay state**

```ts
const [ratingMax, setRatingMax] = useState<number>(5);
const [ratingMaxCustom, setRatingMaxCustom] = useState("");
const [durationDisplay, setDurationDisplay] = useState<"hm" | "hms">("hm");
```

- [ ] **Step 3: Add compact/duration format tiles to number-format section**

In the format tiles array, extend to 6:
```ts
[
  { f: "integer",  icon: "#",    label: "Integer" },
  { f: "decimal",  icon: "#.0",  label: "Decimal" },
  { f: "percent",  icon: "%",    label: "Percent" },
  { f: "currency", icon: "$",    label: "Currency" },
  { f: "compact",  icon: "1.2M", label: "Compact" },
  { f: "duration", icon: "⏱",   label: "Duration" },
] as const
```

The `numFmt` state type widens to include `"compact" | "duration"`.

After the existing precision controls, add duration display-mode toggle (same as ColumnHeaderMenu Task 9, Step 6).

For compact, show precision picker `[0, 1, 2]` (same as percent/currency range) when `numFmt === "compact"`.

- [ ] **Step 4: Add ratingMax picker section**

After the format tiles (same pattern as the number format section):
```tsx
{type === "rating" && (
  <>
    <div className="border-t border-line" />
    <div className="space-y-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
        Max stars
      </div>
      <div className="flex items-center gap-1.5">
        {[3, 5, 10].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => { setRatingMax(n); setRatingMaxCustom(""); }}
            className={cx(
              "h-7 w-8 rounded-sm border font-mono text-[11px] transition-colors",
              ratingMax === n && !ratingMaxCustom
                ? "border-accent bg-accent-wash text-ink"
                : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
            )}
          >{n}</button>
        ))}
        <input
          value={ratingMaxCustom}
          onChange={(e) => {
            setRatingMaxCustom(e.target.value);
            const n = parseInt(e.target.value, 10);
            if (n >= 1 && n <= 20) setRatingMax(n);
          }}
          placeholder="…"
          className="w-12 rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink outline-none focus:border-accent"
        />
      </div>
    </div>
  </>
)}
```

- [ ] **Step 5: Update handleSubmit to build ColumnConfig**

Update `AddFieldInput` interface and `handleSubmit` to pass `config: ColumnConfig` instead of loose fields:
```ts
export interface AddFieldInput {
  label: string;
  config: ColumnConfig;
}
```

In `handleSubmit`, build the config:
```ts
let config: ColumnConfig;
if (type === "number") {
  let numberFormat: NumberFormat | undefined;
  if (numFmt === "integer") numberFormat = { format: "integer" };
  else if (numFmt === "decimal") numberFormat = { format: "decimal", precision: numPrecision as 1|2|3|4 };
  else if (numFmt === "percent") numberFormat = { format: "percent", precision: numPrecision as 0|1|2 };
  else if (numFmt === "compact") numberFormat = { format: "compact", precision: numPrecision as 0|1|2 };
  else if (numFmt === "duration") numberFormat = { format: "duration", display: durationDisplay };
  else numberFormat = { format: "currency", symbol: currSymbol || "$", position: currPosition, precision: numPrecision as 0|1|2 };
  config = { type: "number", numberFormat };
} else if (type === "select") {
  config = { type: "select", options };
} else if (type === "rating") {
  config = { type: "rating", ratingMax };
} else {
  config = { type } as ColumnConfig;
}
await onSubmit({ label: trimmed, config });
```

- [ ] **Step 6: Update TablePane's onAddField to unpack config**

In TablePane.tsx, the `onAddField` handler receives `AddFieldInput` and calls `addField(dimId, label, type, options, { numberFormat }, userId)`. Update to unpack from `config`:
```ts
const handleAddField = async (input: AddFieldInput) => {
  const { label, config } = input;
  const options = config.type === "select" ? config.options : undefined;
  const numberFormat = config.type === "number" ? config.numberFormat : undefined;
  const ratingMax = config.type === "rating" ? config.ratingMax : undefined;
  await addField(dim.id, label, config.type, options, { numberFormat, ratingMax });
};
```

- [ ] **Step 7: Typecheck + run tests**

```bash
cd app && bun run typecheck 2>&1 | grep "error TS"
cd app && bun run test 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add app/src/components/AddFieldPopover.tsx app/src/components/TablePane.tsx
git commit -m "feat(add-field-popover): url/email/rating tiles, ratingMax picker, compact/duration config"
```

---

## Task 15: Server integration verification

**Files:**
- Modify: `server/src/verify-datagrid.ts`

- [ ] **Step 1: Add rating field verification steps**

Add at the end of the verify script (before cleanup):
```ts
const ratingFieldId = await step("addField(rating)", async () => {
  const result = await repo.addField(dimId, "Quality", "rating", undefined, { ratingMax: 5 }, "u_verify");
  assert(result != null, "addField(rating) returned null");
  return result.field;
});

await step("listFields returns ratingMax", async () => {
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.field === ratingFieldId);
  assert(f != null, "rating field not found");
  assert(f.type === "rating", `expected type=rating, got ${f.type}`);
  assert(f.ratingMax === 5, `expected ratingMax=5, got ${f.ratingMax}`);
});

await step("changeColumnType text → url (lossless relabel)", async () => {
  const textField = await repo.addField(dimId, "Website", "text", undefined, {}, "u_verify");
  assert(textField != null, "addField(text) returned null");
  const res = await repo.changeColumnType(dimId, textField.field, {
    newType: "url",
    coerceInvalidToNull: false,
    userId: "u_verify",
  });
  assert(res.ok, "changeColumnType to url failed");
  const fields = await repo.listFields(dimId);
  assert(fields.find((x) => x.field === textField.field)?.type === "url", "type should be url");
});
```

- [ ] **Step 2: Run verify script**

```bash
cd server && bun run verify-datagrid 2>&1
```

Expected: all steps print `ok`.

- [ ] **Step 3: Commit**

```bash
git add server/src/verify-datagrid.ts
git commit -m "test(verify): add rating, url, email field type verification steps"
```
