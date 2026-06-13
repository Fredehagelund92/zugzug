# Linked Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `linked` field type that stores a FK reference to another dimension's canonical records, plus read-only virtual lookup columns that surface fields from the linked record directly in the table.

**Architecture:** A `linked` field is stored as VARCHAR (the target dim's keyCol value) in the dim_* table. `field_config` JSON carries `{ targetDimId, displayFields }`. `getDimension` LEFT JOINs the target dim_* table and returns lookup values as `field__df` keys inside `fields`. In the UI, one linked FieldDef expands to 1 editable FK-picker column + N read-only virtual columns (one per `displayField`).

**Tech Stack:** Bun + postgres.js backend; React 18 + Tailwind v4 frontend; `@tanstack/react-virtual` DataGrid.

---

## File Map

| File | Change |
|---|---|
| `server/src/repo-shared.ts` | Extend `FieldDef`; extend `parseFieldConfig` |
| `app/src/data.ts` | Mirror `FieldDef` extension |
| `app/src/components/datagrid/types.ts` | Add `linked` variant to `ColumnConfig` |
| `server/src/repo-canonical.ts` | `addField` linked support; `getDimension` LEFT JOINs |
| `server/src/server.ts` | Accept `referencedDimId` / `displayFields` on POST /fields |
| `app/src/store.ts` | Pass `referencedDimId` / `displayFields` through `addField` |
| `app/src/components/datagrid/cells/LinkedCell.tsx` | **New** — renderer + popover editor |
| `app/src/components/datagrid/DataGrid.tsx` | Icon, CELLS map, inline editor branch, CellRenderer |
| `app/src/components/TablePane.tsx` | Column expansion, virtual lookup cols, onSubmit, guard hooks |
| `app/src/components/AddFieldPopover.tsx` | Linked tile + dimension picker |

---

## Task 1 — Extend FieldDef types + ColumnConfig

**Files:**
- Modify: `server/src/repo-shared.ts`
- Modify: `app/src/data.ts`
- Modify: `app/src/components/datagrid/types.ts`

- [ ] **Step 1: Add `referencedDimId` and `displayFields` to server FieldDef**

In `server/src/repo-shared.ts`, replace lines 106–113:

```typescript
export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedDimId?: string;  // only when type === "linked"
  displayFields?: string[];  // fields from target dim to surface as lookup cols
}
```

- [ ] **Step 2: Extend `parseFieldConfig` to handle `"linked"` type**

In `server/src/repo-shared.ts`, inside `parseFieldConfig` (around line 89), add a case before the final `return {}`:

```typescript
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
```

- [ ] **Step 3: Mirror FieldDef in `app/src/data.ts`**

Replace lines 34–41:

```typescript
export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
  referencedDimId?: string;
  displayFields?: string[];
}
```

- [ ] **Step 4: Add `linked` variant to ColumnConfig**

In `app/src/components/datagrid/types.ts`, replace lines 9–17:

```typescript
export type ColumnConfig =
  | { type: "text" }
  | { type: "number"; numberFormat?: NumberFormat }
  | { type: "boolean" }
  | { type: "date" }
  | { type: "select"; options: OptionDef[] }
  | { type: "url" }
  | { type: "email" }
  | { type: "rating"; ratingMax: number }
  | {
      type: "linked";
      targetDimId: string;
      displayFields: string[];
      candidates: { key: string; label: string }[];
    };
```

- [ ] **Step 5: Verify typecheck passes**

```bash
cd server && bun run typecheck
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-shared.ts app/src/data.ts app/src/components/datagrid/types.ts
git commit -m "feat(types): add linked field type to FieldDef and ColumnConfig"
```

---

## Task 2 — Backend: addField for linked type

**Files:**
- Modify: `server/src/repo-canonical.ts`
- Modify: `server/src/server.ts`
- Modify: `app/src/store.ts`

- [ ] **Step 1: Add `linked` to `SQL_TYPE` map**

In `server/src/repo-canonical.ts`, replace lines 38–46:

```typescript
const SQL_TYPE: Record<string, string> = {
  text: "VARCHAR",
  number: "NUMERIC",
  boolean: "BOOLEAN",
  date: "DATE",
  url: "VARCHAR",
  email: "VARCHAR",
  rating: "INTEGER",
  linked: "VARCHAR",  // stores the FK key from the target dimension
};
```

- [ ] **Step 2: Extend `KNOWN` set in `addField`**

In `server/src/repo-canonical.ts`, find this line inside `addField` (around line 444):

```typescript
const KNOWN = new Set(["text", "number", "boolean", "date", "select", "url", "email", "rating"]);
```

Replace with:

```typescript
const KNOWN = new Set(["text", "number", "boolean", "date", "select", "url", "email", "rating", "linked"]);
```

- [ ] **Step 3: Extend `addField` signature to accept linked params**

In `server/src/repo-canonical.ts`, replace the `opts` parameter type in `addField` (around line 439):

```typescript
  opts: {
    silent?: boolean;
    numberFormat?: NumberFormat;
    ratingMax?: number;
    referencedDimId?: string;
    displayFields?: string[];
  } = {},
```

- [ ] **Step 4: Add linked validation guard inside `addField`**

Directly after `const t = KNOWN.has(type) ? type : "text";` (around line 445), add:

```typescript
  if (t === "linked") {
    if (!opts.referencedDimId) return null;
    const targetExists = await dimMeta(opts.referencedDimId);
    if (!targetExists) return null;
  }
```

- [ ] **Step 5: Add `linked` case to `optsJson` computation**

In `server/src/repo-canonical.ts`, replace the `optsJson` block (around lines 451–457):

```typescript
  const optsJson =
    t === "select"
      ? JSON.stringify(options ?? [])
      : t === "number" && opts.numberFormat != null
        ? JSON.stringify(opts.numberFormat)
        : t === "rating"
          ? JSON.stringify({ ratingMax: opts.ratingMax ?? 5 })
          : t === "linked"
            ? JSON.stringify({
                targetDimId: opts.referencedDimId,
                displayFields: opts.displayFields ?? ["label"],
              })
            : null;
```

- [ ] **Step 6: Extend the server.ts POST /fields endpoint**

In `server/src/server.ts`, replace the field destructure inside the `POST /api/dimensions/:id/fields` handler (around lines 308–317):

```typescript
      if (seg[3] === "fields" && seg.length === 4 && method === "POST") {
        const {
          label, type, options, numberFormat, ratingMax,
          referencedDimId, displayFields,
        } = (await req.json()) as {
          label: string;
          type?: string;
          options?: { label: string; color: string | null }[];
          numberFormat?: NumberFormat;
          ratingMax?: number;
          referencedDimId?: string;
          displayFields?: string[];
        };
        return json(
          await repo.addField(
            id, label, type,
            options as repo.OptionDef[] | undefined,
            { numberFormat, ratingMax, referencedDimId, displayFields },
            me,
          ),
        );
      }
```

- [ ] **Step 7: Extend `store.addField` to forward linked params**

In `app/src/store.ts`, replace the `addField` function (around lines 416–430):

```typescript
export async function addField(
  dimId: string,
  label: string,
  type = "text",
  options?: OptionDef[],
  extras?: {
    numberFormat?: NumberFormat;
    ratingMax?: number;
    referencedDimId?: string;
    displayFields?: string[];
  },
): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields`, {
    method: "POST",
    body: JSON.stringify({ label, type, options, ...extras }),
  });
  await refreshDim(dimId);
  await refreshAudit();
  emit();
}
```

- [ ] **Step 8: Verify typecheck passes**

```bash
cd server && bun run typecheck
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 9: Smoke-test the endpoint (requires server running)**

Start the server (`cd server && bun run start`). With a dimension named "country" and another named "state" already seeded:

```bash
curl -s -X POST http://localhost:8787/api/dimensions/country/fields \
  -H 'Content-Type: application/json' \
  -d '{"label":"State Link","type":"linked","referencedDimId":"state","displayFields":["label"]}'
```

Expected response: `{"field":"state_link"}`

```bash
# Verify the column exists in Postgres
psql $DATABASE_URL -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'dim_country' AND column_name = 'state_link';"
```

Expected: one row, `character varying`.

- [ ] **Step 10: Commit**

```bash
git add server/src/repo-canonical.ts server/src/server.ts app/src/store.ts
git commit -m "feat(backend): addField handles linked type — VARCHAR FK + field_config JSON"
```

---

## Task 3 — Backend: getDimension LEFT JOINs

**Files:**
- Modify: `server/src/repo-canonical.ts`

- [ ] **Step 1: Split fields into scalar and linked**

In `getDimension`, replace lines 84–87 (the `fields`/`fieldCols` block):

```typescript
  const fields = await listFields(id);
  const scalarFields = fields.filter((f) => f.type !== "linked");
  const linkedFields = fields.filter((f) => f.type === "linked");

  // Pre-fetch target dim metadata for each linked field
  const linkedMetas = new Map<string, { keyCol: string; dimTable: string }>();
  for (const lf of linkedFields) {
    if (lf.referencedDimId) {
      const tm = await dimMeta(lf.referencedDimId);
      if (tm) linkedMetas.set(lf.field, tm);
    }
  }

  const scalarCols = scalarFields.map(
    (f) => `CAST(d.${qid(f.field)} AS VARCHAR) AS ${qid(f.field)}`,
  );
  const linkedFkCols = linkedFields.map(
    (f) => `CAST(d.${qid(f.field)} AS VARCHAR) AS ${qid(f.field)}`,
  );
  const lookupCols = linkedFields.flatMap((f) => {
    const tm = linkedMetas.get(f.field);
    if (!tm) return [];
    return (f.displayFields ?? ["label"]).map(
      (df) =>
        `CAST(t_${f.field}.${qid(df)} AS VARCHAR) AS ${qid(`${f.field}__${df}`)}`,
    );
  });
  const fieldCols = [...scalarCols, ...linkedFkCols, ...lookupCols].join(", ");

  // LEFT JOIN clauses for linked fields
  const joins = linkedFields
    .map((lf) => {
      const tm = linkedMetas.get(lf.field);
      if (!tm) return "";
      return `LEFT JOIN ${cq(tm.dimTable)} t_${lf.field} ON d.${qid(lf.field)} = t_${lf.field}.${qid(tm.keyCol)}`;
    })
    .filter(Boolean)
    .join(" ");
```

- [ ] **Step 2: Inject `joins` into both SELECT queries**

Find the two `pgAll` calls inside `getDimension` (the `if (meta.keyKind === "external_id")` branch and the `else` branch). In both queries, add `${joins}` between the `FROM` clause and the `LEFT JOIN` for variant counts:

```typescript
  if (meta.keyKind === "external_id") {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, NULL AS label, true AS unresolved${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       ${joins}
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ORDER BY variants DESC, d.${k}`,
    );
  } else {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, d.label, false AS unresolved${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       ${joins}
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ORDER BY variants DESC, d.label`,
    );
  }
```

- [ ] **Step 3: Include lookup columns in canonical output**

Replace the `canonical` map (around lines 131–139):

```typescript
  const allFieldKeys = [
    ...scalarFields.map((f) => f.field),
    ...linkedFields.map((f) => f.field),
    ...linkedFields.flatMap((f) =>
      (f.displayFields ?? ["label"]).map((df) => `${f.field}__${df}`),
    ),
  ];

  const canonical = canonRows.map((r) => ({
    key: String(r.key),
    label: r.label == null ? String(r.key) : String(r.label),
    unresolved: !!r.unresolved,
    variants: Number(r.variants),
    fields: Object.fromEntries(
      allFieldKeys.map((fk) => [fk, r[fk] == null ? null : String(r[fk])]),
    ),
  }));
```

- [ ] **Step 4: Verify typecheck**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Test the JOIN returns lookup data (requires server running)**

Set a value on the linked field, then fetch the dimension:

```bash
# Assuming dim "country" has a "state_link" linked field pointing to dim "state"
# and "US" is a canonical record in dim_country
curl -s -X PUT 'http://localhost:8787/api/dimensions/country/canonical/US/field/state_link' \
  -H 'Content-Type: application/json' \
  -d '{"value":"CA"}'

# Fetch the dimension
curl -s 'http://localhost:8787/api/dimensions/country' | jq '.canonical[0].fields'
```

Expected output includes: `"state_link": "CA"` and `"state_link__label": "California"`.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-canonical.ts
git commit -m "feat(backend): getDimension LEFT JOINs linked dims and returns lookup cols"
```

---

## Task 4 — LinkedCell component

**Files:**
- Create: `app/src/components/datagrid/cells/LinkedCell.tsx`

- [ ] **Step 1: Create the file**

```typescript
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CellCtx, EditCtx } from "../types";

/* LinkedCell — FK picker cell that references another dimension's canonical records.
   Renderer resolves the stored key to a label via column.config.candidates.
   Editor is a searchable popover (no "create" — records are managed in their own table). */

function Renderer<Row>({ value, column }: CellCtx<Row>) {
  if (value == null || value === "") {
    return <span className="font-mono text-[12px] text-ink-2">—</span>;
  }
  const key = String(value);
  const candidates = column.config.type === "linked" ? column.config.candidates : [];
  const match = candidates.find((c) => c.key === key);
  return (
    <span className="truncate font-mono text-[12px] text-ink">
      {match?.label ?? key}
    </span>
  );
}

interface LinkedEditorProps<Row> extends EditCtx<Row> {
  candidates: { key: string; label: string }[];
  anchorRef: React.RefObject<HTMLDivElement | null>;
}

const POPOVER_WIDTH = 260;

function Editor<Row>({ value, commit, cancel, candidates, anchorRef }: LinkedEditorProps<Row>) {
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const pop = popRef.current;
    const anchor = anchorRef.current;
    if (!pop || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const popH = pop.offsetHeight;
      let left = a.left;
      if (left + POPOVER_WIDTH > window.innerWidth - 8)
        left = window.innerWidth - POPOVER_WIDTH - 8;
      let top = a.bottom + 2;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - 2 - popH);
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) cancel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [cancel]);

  const filtered = q.trim()
    ? candidates.filter(
        (c) =>
          c.label.toLowerCase().includes(q.toLowerCase()) ||
          c.key.toLowerCase().includes(q.toLowerCase()),
      )
    : candidates;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      setHl((h) => Math.min(h + 1, filtered.length - 1));
      e.preventDefault();
    }
    if (e.key === "ArrowUp") {
      setHl((h) => Math.max(h - 1, 0));
      e.preventDefault();
    }
    if (e.key === "Enter") {
      if (filtered[hl]) commit(filtered[hl].key);
      e.preventDefault();
    }
    if (e.key === "Escape") cancel();
    if (e.key === "Backspace" && !q && value != null) commit(null);
  };

  return createPortal(
    <div
      ref={popRef}
      className="fixed z-50 overflow-hidden rounded-sm border border-line-2 bg-surface-elevated shadow-pop"
      style={{ width: POPOVER_WIDTH }}
    >
      <div className="border-b border-line px-2 py-1.5">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setHl(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search records…"
          className="w-full bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-3"
        />
      </div>
      {value != null && value !== "" && (
        <button
          type="button"
          className="w-full px-3 py-1.5 text-left font-mono text-[11px] text-ink-3 hover:bg-hover"
          onMouseDown={(e) => {
            e.preventDefault();
            commit(null);
          }}
        >
          Clear
        </button>
      )}
      <div className="max-h-48 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-2 font-mono text-[11px] text-ink-3">No records found</div>
        )}
        {filtered.map((c, i) => (
          <button
            key={c.key}
            type="button"
            className={`w-full px-3 py-1.5 text-left transition-colors ${
              i === hl ? "bg-accent-wash" : "hover:bg-hover"
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              commit(c.key);
            }}
            onMouseEnter={() => setHl(i)}
          >
            <span className="font-mono text-[12px] text-ink">{c.label}</span>
            <span className="ml-2 font-mono text-[10px] text-ink-3">{c.key}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export const LinkedCell = { Renderer, Editor };
```

- [ ] **Step 2: Verify typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/datagrid/cells/LinkedCell.tsx
git commit -m "feat(ui): add LinkedCell renderer and searchable editor"
```

---

## Task 5 — DataGrid: register linked type

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx`

- [ ] **Step 1: Import LinkedCell**

Add after the `SelectCell` import (around line 30):

```typescript
import { LinkedCell } from "./cells/LinkedCell";
```

- [ ] **Step 2: Add `IconFieldLinked` inline constant**

After `IconFieldRating` (around line 22):

```typescript
const IconFieldLinked = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>⇢</span>
);
```

- [ ] **Step 3: Add `linked` to `FIELD_TYPE_ICONS`**

Replace the `FIELD_TYPE_ICONS` record (lines 231–240):

```typescript
const FIELD_TYPE_ICONS: Record<CellType, React.ComponentType<{ className?: string }>> = {
  text:    IconFieldText,
  number:  IconFieldNumber,
  boolean: IconFieldBoolean,
  date:    IconFieldDate,
  select:  IconFieldSelect,
  url:     IconFieldUrl,
  email:   IconFieldEmail,
  rating:  IconFieldRating,
  linked:  IconFieldLinked,
};
```

- [ ] **Step 4: Add `linked` inline editor branch in `GridRowInner`**

Find the editing branch inside the cell renderer loop (around line 172). After the `select` inline editor case and before the final `CellEditor` fallthrough:

```typescript
              ) : c.config.type === "select" ? (
                <SelectCell.Editor
                  // ... existing props unchanged ...
                />
              ) : c.config.type === "linked" ? (
                <LinkedCell.Editor
                  row={row}
                  rowKey={rk}
                  field={c.field}
                  value={value}
                  focused
                  column={c}
                  anchorRef={editingCellRef}
                  commit={(v: unknown) => {
                    onStopEdit();
                    onCommitCell(rk, c.field, v);
                  }}
                  cancel={() => onStopEdit()}
                  candidates={c.config.candidates}
                />
              ) : (
```

- [ ] **Step 5: Add `linked` to `CellRenderer`**

Replace the `CellRenderer` function (lines 1257–1261):

```typescript
function CellRenderer({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return <SelectCell.Renderer {...ctx} />;
  if (type === "linked") return <LinkedCell.Renderer {...ctx} />;
  const C = CELLS[type as Exclude<CellType, "select" | "linked">];
  return <C.Renderer {...ctx} />;
}
```

- [ ] **Step 6: Verify typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors. (TypeScript will catch if `CellType` doesn't include `"linked"` yet — it should since Task 1 added it to `ColumnConfig`.)

- [ ] **Step 7: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx
git commit -m "feat(datagrid): register linked cell type with icon and inline editor"
```

---

## Task 6 — TablePane: column expansion + virtual lookup cols

**Files:**
- Modify: `app/src/components/TablePane.tsx`

- [ ] **Step 1: Import `useDimensions` from store**

In `TablePane.tsx`, extend the store import (around line 11):

```typescript
import {
  slug,
  useSources,
  useDimensions,   // ← add
  addCanonical,
  renameCanonical,
  mergeCanonical,
  retireCanonical,
  fetchVariants,
  deriveCanonical,
  addField,
  setFieldValue,
  addColumnOption,
  renameColumn,
  changeColumnType,
  deleteColumn,
  getGridLayout,
  setGridLayout,
  type GridLayoutConfig,
} from "../store";
```

- [ ] **Step 2: Add `useDimensions()` in `RecordsBody`**

In `RecordsBody`, directly after `const sources = useSources();` (around line 166):

```typescript
  const allDims = useDimensions();
```

- [ ] **Step 3: Replace the `fields.map` with `fields.flatMap` in the `columns` useMemo**

Replace this block (around lines 261–267):

```typescript
      ...fields.map<ColumnDef<CanonicalValue>>((f) => ({
        field: f.field,
        label: f.label,
        config: fieldDefToColumnConfig(f),
        editable: true,
        render: undefined,
      })),
```

With:

```typescript
      ...fields.flatMap<ColumnDef<CanonicalValue>>((f) => {
        if (f.type === "linked") {
          const targetDim = allDims.find((d) => d.id === f.referencedDimId);
          const candidates =
            targetDim?.canonical.map((c) => ({ key: c.key, label: c.label })) ?? [];
          const fkCol: ColumnDef<CanonicalValue> = {
            field: f.field,
            label: f.label,
            config: {
              type: "linked",
              targetDimId: f.referencedDimId ?? "",
              displayFields: f.displayFields ?? ["label"],
              candidates,
            },
            editable: true,
          };
          const lookupCols: ColumnDef<CanonicalValue>[] = (f.displayFields ?? ["label"]).map(
            (df) => {
              const targetField = targetDim?.fields?.find((tf) => tf.field === df);
              return {
                field: `${f.field}__${df}`,
                label: `↳ ${targetField?.label ?? df}`,
                config: { type: "text" } as const,
                editable: false,
              };
            },
          );
          return [fkCol, ...lookupCols];
        }
        return [
          {
            field: f.field,
            label: f.label,
            config: fieldDefToColumnConfig(f),
            editable: true,
          },
        ];
      }),
```

- [ ] **Step 4: Add `allDims` to the `columns` useMemo dependency array**

Replace the closing dependency array (around line 285):

```typescript
  }, [fields, engineer, dim.keyCol, external, layout, allDims]);
```

- [ ] **Step 5: Guard virtual column fields in DataGrid callbacks**

In the `DataGrid` props (around lines 618–630), update the three column mutation callbacks to skip virtual lookup columns (identified by the `__` separator convention):

```typescript
          onRenameColumn={(field, label) => {
            if (field.includes("__")) return;  // virtual lookup col — not stored
            void renameColumn(activeId, field, label);
          }}
          onChangeColumnType={(field, newConfig, opts) => {
            if (field.includes("__")) return Promise.resolve({ ok: false });
            return changeColumnType(
              activeId,
              field,
              newConfig.type,
              newConfig.type === "select" ? newConfig.options : undefined,
              opts?.coerceInvalidToNull ?? false,
              newConfig.type === "number" ? newConfig.numberFormat : undefined,
              newConfig.type === "rating" ? newConfig.ratingMax : undefined,
            );
          }}
          onDeleteColumn={(field) => {
            if (field.includes("__")) return;  // virtual lookup col — not stored
            void deleteColumn(activeId, field);
          }}
```

- [ ] **Step 6: Verify typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "feat(table): expand linked fields into FK picker + virtual lookup columns"
```

---

## Task 7 — AddFieldPopover linked tile + TablePane.onSubmit

**Files:**
- Modify: `app/src/components/AddFieldPopover.tsx`
- Modify: `app/src/components/TablePane.tsx`

- [ ] **Step 1: Extend `AddFieldPopoverProps` with `allDims` and `currentDimId`**

In `AddFieldPopover.tsx`, replace the `AddFieldPopoverProps` interface (around lines 14–18):

```typescript
interface AddFieldPopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (input: AddFieldInput) => Promise<void>;
  /** All dimensions available to link to — pass from host so the popover stays store-free. */
  allDims?: { id: string; dimension: string }[];
  /** The current dimension's id — excluded from the link target picker. */
  currentDimId?: string;
}
```

- [ ] **Step 2: Add `linked` to `TYPE_TILES`**

Replace the `TYPE_TILES` array (around lines 28–37):

```typescript
const TYPE_TILES: TypeTile[] = [
  { type: "text",    icon: "A",  label: "Text" },
  { type: "number",  icon: "#",  label: "Number" },
  { type: "boolean", icon: "☑",  label: "Boolean" },
  { type: "date",    icon: "⊞",  label: "Date" },
  { type: "select",  icon: "◉",  label: "Select" },
  { type: "url",     icon: "↗",  label: "URL" },
  { type: "email",   icon: "@",  label: "Email" },
  { type: "rating",  icon: "★",  label: "Rating" },
  { type: "linked",  icon: "⇢",  label: "Linked" },
];
```

- [ ] **Step 3: Destructure `allDims` and `currentDimId` from props**

In the `AddFieldPopover` function signature (around line 39):

```typescript
export function AddFieldPopover({ anchorRef, onClose, onSubmit, allDims, currentDimId }: AddFieldPopoverProps) {
```

- [ ] **Step 4: Add `linkedTargetDimId` state**

After `const [ratingMaxCustom, setRatingMaxCustom] = useState("");` (around line 54):

```typescript
  const [linkedTargetDimId, setLinkedTargetDimId] = useState<string>("");
```

- [ ] **Step 5: Reset linked state in `resetForm`**

At the end of `resetForm` (around line 183), add:

```typescript
    setLinkedTargetDimId("");
```

- [ ] **Step 6: Add validation for linked type in `handleSubmit`**

At the top of `handleSubmit`, after `setError(null)` but before `setBusy(true)`:

```typescript
    if (type === "linked" && !linkedTargetDimId) {
      setError("Select a dimension to link to.");
      return;
    }
```

- [ ] **Step 7: Add `linked` case to config assignment in `handleSubmit`**

Before the closing `else` in the config assignment block (around line 219), add:

```typescript
      } else if (type === "linked") {
        config = {
          type: "linked",
          targetDimId: linkedTargetDimId,
          displayFields: ["label"],
          candidates: [],
        };
```

- [ ] **Step 8: Add linked config UI section**

After the rating config block (around line 516), add:

```tsx
        {type === "linked" && (
          <>
            <div className="border-t border-line" />
            <div className="space-y-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
                Link to dimension
              </div>
              <select
                value={linkedTargetDimId}
                onChange={(e) => setLinkedTargetDimId(e.target.value)}
                className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent"
              >
                <option value="">— pick a dimension —</option>
                {(allDims ?? [])
                  .filter((d) => d.id !== currentDimId)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.dimension}
                    </option>
                  ))}
              </select>
            </div>
          </>
        )}
```

- [ ] **Step 9: Wire `allDims` and `currentDimId` in `TablePane`**

Replace the `AddFieldPopover` usage in `RecordsBody` (around lines 648–658):

```tsx
        {addOpen && (
          <AddFieldPopover
            anchorRef={addFieldRef as React.RefObject<HTMLElement | null>}
            onClose={() => setAddOpen(false)}
            allDims={allDims.map((d) => ({ id: d.id, dimension: d.dimension }))}
            currentDimId={activeId}
            onSubmit={async ({ label, config }) => {
              if (config.type === "linked") {
                await addField(activeId, label, "linked", undefined, {
                  referencedDimId: config.targetDimId,
                  displayFields: config.displayFields,
                });
              } else if (config.type === "number") {
                await addField(activeId, label, "number", undefined, {
                  numberFormat: config.numberFormat,
                });
              } else if (config.type === "select") {
                await addField(activeId, label, "select", config.options);
              } else if (config.type === "rating") {
                await addField(activeId, label, "rating", undefined, {
                  ratingMax: config.ratingMax,
                });
              } else {
                await addField(activeId, label, config.type);
              }
            }}
          />
        )}
```

- [ ] **Step 10: Verify typecheck**

```bash
cd server && bun run typecheck
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 11: Manual smoke-test (requires both server and UI running)**

1. Start server: `cd server && bun run start`
2. Start UI: `cd app && bun run dev`
3. Open the app, navigate to a dimension that has at least one other dimension to link to
4. Click `+ Field` button
5. Select `Linked` tile — a dimension picker should appear
6. Pick the target dimension, enter a field name, click "Create field"
7. The table should show a new column with a `⇢` icon and a `↳ label` virtual lookup column next to it
8. Click a cell in the linked column — a searchable popover should open with records from the target dimension
9. Pick a record — the FK key is stored, the label resolves in the cell, and the `↳ label` virtual column shows the linked record's label

- [ ] **Step 12: Commit**

```bash
git add app/src/components/AddFieldPopover.tsx app/src/components/TablePane.tsx
git commit -m "feat(ui): linked record field creation — tile, dim picker, column expansion"
```

---

## Self-Review Checklist

After writing, I verified:

1. **Spec coverage:** FK picker ✓, virtual lookup cols ✓, server JOIN ✓, field creation UI ✓, label resolution in renderer ✓
2. **No placeholders:** all steps contain actual code
3. **Type consistency:**
   - `FieldDef.referencedDimId` used consistently in tasks 1–3 and 6
   - `ColumnConfig.linked.candidates` populated in task 6 `useMemo`, consumed in task 4 `LinkedCell`
   - `f.field + "__" + df` naming convention consistent across tasks 3 and 6
   - Virtual column guard `field.includes("__")` in task 6 step 5 matches the naming in task 6 step 3
   - `displayFields: ["label"]` is the hard-coded default in both `parseFieldConfig` (task 1) and the AddFieldPopover submit handler (task 7)
