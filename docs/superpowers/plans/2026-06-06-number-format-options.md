# Number Format Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `number` field type with display-only format sub-options (integer, decimal, percent, currency) stored as JSON in the existing `options varchar` column — no schema migration.

**Architecture:** `NumberFormat` is a discriminated union defined client-side in `app/src/data.ts` (alongside `OptionDef`) and server-side in `server/src/repo-shared.ts`. The existing `options varchar` column stores either a `OptionDef[]` (select) or a `NumberFormat` object (number), discriminated by `type`. Formatting is purely display-side in `NumberCell`; percent values are stored normalized (0.42 → displays 42%).

**Tech Stack:** React 18 + TypeScript + Vitest (app); Bun + TypeScript + bun:test + Postgres (server)

**Spec:** `docs/superpowers/specs/2026-06-06-number-format-options-design.md`

---

## File map

| File | Change |
|---|---|
| `app/src/data.ts` | Add `NumberFormat` type; add `numberFormat?` to `FieldDef` |
| `app/src/components/datagrid/types.ts` | Import + re-export `NumberFormat`; add `numberFormat?` to `ColumnDef`; add `numberFormat?` to `DataGridProps.onChangeColumnType` opts; update `ColumnHeaderMenu.onChangeType` signature |
| `app/src/components/datagrid/cells/NumberCell.tsx` | Export `formatNumber` helper; `Renderer` accepts full `CellCtx`; `Editor` divides percent by 100 on commit |
| `app/src/components/datagrid/ColumnHeaderMenu.tsx` | Add `number-format` sub-mode; `onChangeType` passes `NumberFormat` |
| `app/src/components/datagrid/DataGrid.tsx` | Forward `numberFormat` from `onChangeType` callback into `onChangeColumnType` |
| `app/src/components/AddFieldPopover.tsx` | Add format config panel for number type; `AddFieldInput` gains `numberFormat` |
| `app/src/components/TablePane.tsx` | Pass `numberFormat` from `FieldDef` → `ColumnDef` in the fields mapping |
| `app/test/number-format.test.ts` | Unit tests for `formatNumber` |
| `server/src/repo-shared.ts` | Add server-side `NumberFormat` type + `parseNumberFormat`; add `numberFormat?` to `FieldDef` |
| `server/src/repo-canonical.ts` | `listFields` parse branch for number; `addField` opts gain `numberFormat`; `changeColumnType` gains `numberFormat` param |
| `server/src/server.ts` | POST fields + PUT field endpoints accept `numberFormat` in body |
| `server/src/tables.ts` | `ColumnDraft` gains `numberFormat`; forward in `addField` call |
| `server/test/number-format.test.ts` | Integration tests for addField + listFields round-trip |

---

## Task 1: `NumberFormat` type — client side

**Files:**
- Modify: `app/src/data.ts`
- Modify: `app/src/components/datagrid/types.ts`

- [ ] **Step 1: Add `NumberFormat` to `app/src/data.ts`**

Insert after the `OptionDef` interface (around line 24):

```ts
export type NumberFormat =
  | { format: "integer" }
  | { format: "decimal"; precision: 1 | 2 | 3 | 4 }
  | { format: "percent"; precision: 0 | 1 | 2 }
  | { format: "currency"; symbol: string; position: "prefix" | "suffix"; precision: 0 | 1 | 2 }
```

Also update `FieldDef` (around line 26) to add `numberFormat?`:

```ts
export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
}
```

- [ ] **Step 2: Import `NumberFormat` in `app/src/components/datagrid/types.ts` and update `ColumnDef` + `DataGridProps`**

Change the import at line 3 from:
```ts
import type { OptionDef } from "../../data";
```
to:
```ts
import type { OptionDef, NumberFormat } from "../../data";
export type { NumberFormat };
```

Add `numberFormat?` to `ColumnDef` (after `options?`, around line 21):
```ts
  options?: OptionDef[];     // only set when type === "select"
  numberFormat?: NumberFormat; // only set when type === "number"
```

Update `DataGridProps.onChangeColumnType` opts (around line 89):
```ts
  onChangeColumnType?: (
    field: string,
    newType: CellType,
    opts?: { options?: OptionDef[]; numberFormat?: NumberFormat; coerceInvalidToNull?: boolean },
  ) => Promise<{ ok: boolean; invalidCount?: number }>;
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/data.ts app/src/components/datagrid/types.ts
git commit -m "feat(number-format): define NumberFormat type client-side"
```

---

## Task 2: `formatNumber` helper + `NumberCell` update

**Files:**
- Modify: `app/src/components/datagrid/cells/NumberCell.tsx`
- Create: `app/test/number-format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/test/number-format.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { formatNumber } from "../src/components/datagrid/cells/NumberCell";

describe("formatNumber", () => {
  test("undefined format returns raw string", () => {
    expect(formatNumber(42, undefined)).toBe("42");
  });

  test("null/non-finite value returns em dash regardless of format", () => {
    expect(formatNumber(null, undefined)).toBe("—");
    expect(formatNumber(null, { format: "integer" })).toBe("—");
    expect(formatNumber("abc", { format: "decimal", precision: 2 })).toBe("—");
  });

  test("integer format: thousands separator, no decimals", () => {
    expect(formatNumber(42, { format: "integer" })).toBe("42");
    expect(formatNumber(1234567, { format: "integer" })).toBe("1,234,567");
    expect(formatNumber(-42, { format: "integer" })).toBe("-42");
  });

  test("decimal format: fixed precision with thousands separator", () => {
    expect(formatNumber(42, { format: "decimal", precision: 2 })).toBe("42.00");
    expect(formatNumber(1234.5, { format: "decimal", precision: 1 })).toBe("1,234.5");
    expect(formatNumber(3.14159, { format: "decimal", precision: 3 })).toBe("3.142");
  });

  test("percent format: normalized storage (0.42 → 42%)", () => {
    expect(formatNumber(0.42, { format: "percent", precision: 0 })).toBe("42%");
    expect(formatNumber(0.425, { format: "percent", precision: 1 })).toBe("42.5%");
    expect(formatNumber(1, { format: "percent", precision: 0 })).toBe("100%");
  });

  test("currency prefix: symbol before digits", () => {
    expect(
      formatNumber(42, { format: "currency", symbol: "$", position: "prefix", precision: 2 }),
    ).toBe("$42.00");
    expect(
      formatNumber(1234.5, { format: "currency", symbol: "USD ", position: "prefix", precision: 2 }),
    ).toBe("USD 1,234.50");
  });

  test("currency suffix: digit then space then symbol", () => {
    expect(
      formatNumber(42, { format: "currency", symbol: "kr", position: "suffix", precision: 2 }),
    ).toBe("42.00 kr");
  });

  test("currency: negative numbers — minus sign always leftmost", () => {
    expect(
      formatNumber(-42, { format: "currency", symbol: "$", position: "prefix", precision: 2 }),
    ).toBe("-$42.00");
    expect(
      formatNumber(-42, { format: "currency", symbol: "kr", position: "suffix", precision: 2 }),
    ).toBe("-42.00 kr");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test -- number-format
```

Expected: FAIL — `formatNumber` is not exported.

- [ ] **Step 3: Implement `formatNumber` and update `NumberCell`**

Replace `app/src/components/datagrid/cells/NumberCell.tsx` entirely:

```tsx
import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";
import type { NumberFormat } from "../../../data";

const inputBase =
  "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 text-right font-mono text-[12px] text-ink outline-none tabular-nums";

export function formatNumber(value: unknown, fmt: NumberFormat | undefined): string {
  const n = value == null || value === "" ? null : Number(value);
  if (n == null || !Number.isFinite(n)) return "—";
  if (fmt == null) return String(n);

  switch (fmt.format) {
    case "integer":
      return n.toLocaleString("en-US", { maximumFractionDigits: 0 });

    case "decimal":
      return n.toLocaleString("en-US", {
        minimumFractionDigits: fmt.precision,
        maximumFractionDigits: fmt.precision,
      });

    case "percent": {
      const pct = n * 100;
      return (
        pct.toLocaleString("en-US", {
          minimumFractionDigits: fmt.precision,
          maximumFractionDigits: fmt.precision,
        }) + "%"
      );
    }

    case "currency": {
      const abs = Math.abs(n);
      const formatted = abs.toLocaleString("en-US", {
        minimumFractionDigits: fmt.precision,
        maximumFractionDigits: fmt.precision,
      });
      const sign = n < 0 ? "-" : "";
      if (fmt.position === "prefix") return `${sign}${fmt.symbol}${formatted}`;
      return `${sign}${formatted} ${fmt.symbol}`;
    }
  }
}

function Renderer<Row>(ctx: CellCtx<Row>) {
  const { value, column } = ctx;
  const fmt = column.numberFormat;
  const n = value == null || value === "" ? null : Number(value);
  if (n == null || !Number.isFinite(n)) {
    return <span className="font-mono text-[12px] text-ink-3">—</span>;
  }
  return (
    <span className="text-right tabular-nums font-mono text-[12px] text-ink">
      {formatNumber(value, fmt)}
    </span>
  );
}

function Editor<Row>({ value, initial, commit, cancel, column }: EditCtx<Row>) {
  const fmt = column.numberFormat;
  const isPercent = fmt?.format === "percent";

  // For percent fields, display the value * 100 for editing (e.g. 0.42 → "42")
  const displayValue =
    isPercent && value != null && value !== "" && Number.isFinite(Number(value))
      ? String(Number(value) * 100)
      : value == null
        ? ""
        : String(value);

  const seeded = initial != null;
  const usable = seeded && /^[0-9.-]$/.test(initial);
  const [v, setV] = useState(usable ? initial : displayValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    if (usable) {
      const el = ref.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    } else {
      ref.current?.select();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const commitNow = () => {
    const t = v.trim();
    if (t === "") {
      commit(null);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) {
      commit(null);
      return;
    }
    // Percent editor works in display space (0–100); store normalized (0–1)
    commit(isPercent ? n / 100 : n);
  };

  return (
    <input
      ref={ref}
      value={v}
      inputMode="decimal"
      onChange={(e) => setV(e.target.value)}
      onBlur={commitNow}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") commitNow();
      }}
      className={inputBase}
    />
  );
}

export const NumberCell = { Renderer, Editor };
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test -- number-format
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Run full test suite + typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run test && bun run typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/datagrid/cells/NumberCell.tsx app/test/number-format.test.ts
git commit -m "feat(number-format): formatNumber helper and NumberCell display/edit"
```

---

## Task 3: `ColumnHeaderMenu` number-format sub-panel

**Files:**
- Modify: `app/src/components/datagrid/ColumnHeaderMenu.tsx`
- Modify: `app/src/components/datagrid/DataGrid.tsx`

- [ ] **Step 1: Update `ColumnHeaderMenu` props and add number-format mode**

In `ColumnHeaderMenu.tsx`:

1. Add import at the top:
```ts
import type { CellType, ColumnDef, NumberFormat } from "./types";
```

2. Change `onChangeType` signature in the `Props` interface (around line 25):
```ts
  onChangeType: (newType: CellType, numberFormat?: NumberFormat) => void;
```

3. Add `"number-format"` to the mode union (around line 48):
```ts
  const [mode, setMode] = useState<"menu" | "rename" | "type" | "number-format" | "filter" | "confirm-delete">("menu");
```

4. Add state for the number format sub-selection (after the `mode` useState):
```ts
  const [numFmt, setNumFmt] = useState<"integer" | "decimal" | "percent" | "currency">("integer");
  const [numPrecision, setNumPrecision] = useState<number>(2);
  const [currSymbol, setCurrSymbol] = useState("$");
  const [currPosition, setCurrPosition] = useState<"prefix" | "suffix">("prefix");
```

5. Find where `"number"` type is clicked in the type-picker mode (around line 232 where `onChangeType(t)` is called). Replace:
```ts
if (t !== column.type) onChangeType(t)
```
with:
```ts
if (t !== column.type) {
  if (t === "number") {
    setMode("number-format");
  } else {
    onChangeType(t);
  }
}
```

6. Add the `"number-format"` mode render block. Find the section that renders mode === "type" and add a sibling block after it:

```tsx
{mode === "number-format" && (
  <div className="p-2 space-y-2">
    {/* Back button */}
    <button
      type="button"
      onClick={() => setMode("type")}
      className="flex items-center gap-1 font-mono text-[11px] text-ink-3 hover:text-ink"
    >
      <IconChevronLeft className="h-3 w-3" />
      Back
    </button>

    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3 px-1">
      Number format
    </div>

    {/* Format tiles */}
    {(["integer", "decimal", "percent", "currency"] as const).map((f) => (
      <button
        key={f}
        type="button"
        onClick={() => setNumFmt(f)}
        className={cx(
          "w-full flex items-center gap-2 rounded-sm border px-2 py-1.5 text-left text-[11px] font-mono transition-colors",
          numFmt === f
            ? "border-accent bg-accent-wash text-ink"
            : "border-line hover:border-line-2 hover:bg-hover text-ink",
        )}
      >
        {{ integer: "#", decimal: "#.0", percent: "%", currency: "$" }[f]}
        <span className="ml-1 capitalize">{f}</span>
      </button>
    ))}

    {/* Precision (decimal / percent / currency) */}
    {(numFmt === "decimal" || numFmt === "percent" || numFmt === "currency") && (
      <div className="flex items-center gap-1.5 px-1">
        <span className="font-mono text-[10px] text-ink-3 w-14">Precision</span>
        {(numFmt === "decimal" ? [1, 2, 3, 4] : [0, 1, 2]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setNumPrecision(p)}
            className={cx(
              "h-6 w-6 rounded-sm border font-mono text-[11px] transition-colors",
              numPrecision === p
                ? "border-accent bg-accent-wash text-ink"
                : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
            )}
          >
            {p}
          </button>
        ))}
      </div>
    )}

    {/* Symbol + position (currency only) */}
    {numFmt === "currency" && (
      <div className="space-y-1.5 px-1">
        <div className="flex flex-wrap gap-1">
          {["$", "€", "£", "¥", "kr", "USD", "EUR", "GBP"].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setCurrSymbol(s)}
              className={cx(
                "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                currSymbol === s
                  ? "border-accent bg-accent-wash text-ink"
                  : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
              )}
            >
              {s}
            </button>
          ))}
          <input
            value={currSymbol}
            onChange={(e) => setCurrSymbol(e.target.value.slice(0, 6))}
            placeholder="…"
            className="w-12 rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink outline-none focus:border-accent"
          />
        </div>
        <div className="flex gap-1">
          {(["prefix", "suffix"] as const).map((pos) => (
            <button
              key={pos}
              type="button"
              onClick={() => setCurrPosition(pos)}
              className={cx(
                "flex-1 rounded-sm border px-2 py-1 font-mono text-[10px] capitalize transition-colors",
                currPosition === pos
                  ? "border-accent bg-accent-wash text-ink"
                  : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
              )}
            >
              {pos}
            </button>
          ))}
        </div>
      </div>
    )}

    {/* Confirm button */}
    <button
      type="button"
      onClick={() => {
        let fmt: NumberFormat;
        if (numFmt === "integer") {
          fmt = { format: "integer" };
        } else if (numFmt === "decimal") {
          fmt = { format: "decimal", precision: numPrecision as 1 | 2 | 3 | 4 };
        } else if (numFmt === "percent") {
          fmt = { format: "percent", precision: numPrecision as 0 | 1 | 2 };
        } else {
          fmt = {
            format: "currency",
            symbol: currSymbol || "$",
            position: currPosition,
            precision: numPrecision as 0 | 1 | 2,
          };
        }
        onChangeType("number", fmt);
        onClose();
      }}
      className="w-full rounded-sm border border-accent bg-accent px-3 py-1.5 font-mono text-[11px] text-accent-ink hover:opacity-90"
    >
      Apply
    </button>
  </div>
)}
```

- [ ] **Step 2: Forward `numberFormat` in `DataGrid.tsx`**

In `DataGrid.tsx`, find the `onChangeType` inline callback (around line 1074). Replace:

```ts
onChangeType={async (newType) => {
  if (!props.onChangeColumnType) return;
  const res = await props.onChangeColumnType(c.field, newType);
  if (!res.ok && res.invalidCount) {
    if (
      confirm(
        `${res.invalidCount} value(s) won't parse as ${newType}. Coerce to empty?`,
      )
    ) {
      await props.onChangeColumnType(c.field, newType, {
        coerceInvalidToNull: true,
      });
    }
  }
}}
```

with:

```ts
onChangeType={async (newType, numberFormat) => {
  if (!props.onChangeColumnType) return;
  const res = await props.onChangeColumnType(c.field, newType, { numberFormat });
  if (!res.ok && res.invalidCount) {
    if (
      confirm(
        `${res.invalidCount} value(s) won't parse as ${newType}. Coerce to empty?`,
      )
    ) {
      await props.onChangeColumnType(c.field, newType, {
        numberFormat,
        coerceInvalidToNull: true,
      });
    }
  }
}}
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/datagrid/ColumnHeaderMenu.tsx app/src/components/datagrid/DataGrid.tsx
git commit -m "feat(number-format): ColumnHeaderMenu number-format sub-panel"
```

---

## Task 4: `AddFieldPopover` format panel

**Files:**
- Modify: `app/src/components/AddFieldPopover.tsx`

- [ ] **Step 1: Update `AddFieldInput` and add number format state**

1. Add `NumberFormat` import at top:
```ts
import type { NumberFormat } from "../data";
```

2. Update `AddFieldInput` interface (around line 8):
```ts
export interface AddFieldInput {
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select";
  options?: OptionDef[];
  numberFormat?: NumberFormat;
}
```

3. Inside `AddFieldPopover`, add format state after the existing `useState` declarations:
```ts
const [numFmt, setNumFmt] = useState<"integer" | "decimal" | "percent" | "currency">("integer");
const [numPrecision, setNumPrecision] = useState<number>(2);
const [currSymbol, setCurrSymbol] = useState("$");
const [currPosition, setCurrPosition] = useState<"prefix" | "suffix">("prefix");
```

4. Also reset these in `resetForm`:
```ts
const resetForm = () => {
  setLabel("");
  setType("text");
  setOptions([]);
  setNumFmt("integer");
  setNumPrecision(2);
  setCurrSymbol("$");
  setCurrPosition("prefix");
  setError(null);
  nameInputRef.current?.focus();
};
```

- [ ] **Step 2: Build `numberFormat` from state in `handleSubmit`**

In `handleSubmit`, before the `onSubmit` call, build the `NumberFormat` object:

```ts
const handleSubmit = async () => {
  const trimmed = label.trim();
  if (!trimmed || busy) return;
  setError(null);
  setBusy(true);
  try {
    let numberFormat: NumberFormat | undefined;
    if (type === "number") {
      if (numFmt === "integer") {
        numberFormat = { format: "integer" };
      } else if (numFmt === "decimal") {
        numberFormat = { format: "decimal", precision: numPrecision as 1 | 2 | 3 | 4 };
      } else if (numFmt === "percent") {
        numberFormat = { format: "percent", precision: numPrecision as 0 | 1 | 2 };
      } else {
        numberFormat = {
          format: "currency",
          symbol: currSymbol || "$",
          position: currPosition,
          precision: numPrecision as 0 | 1 | 2,
        };
      }
    }
    await onSubmit({
      label: trimmed,
      type,
      options: type === "select" ? options : undefined,
      numberFormat,
    });
    if (createAnother) {
      resetForm();
    } else {
      onClose();
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : "Something went wrong.");
  } finally {
    setBusy(false);
  }
};
```

- [ ] **Step 3: Add the format config panel in the JSX**

In the JSX, find the `{type === "select" && ...}` block. Add a sibling block for `number` after it:

```tsx
{/* Number format config */}
{type === "number" && (
  <>
    <div className="border-t border-line" />
    <div className="space-y-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
        Format
      </div>

      {/* Format tiles */}
      <div className="grid grid-cols-2 gap-1.5">
        {(
          [
            { f: "integer", icon: "#", label: "Integer" },
            { f: "decimal", icon: "#.0", label: "Decimal" },
            { f: "percent", icon: "%", label: "Percent" },
            { f: "currency", icon: "$", label: "Currency" },
          ] as const
        ).map(({ f, icon, label: fLabel }) => (
          <button
            key={f}
            type="button"
            onClick={() => {
              setNumFmt(f);
              // Reset precision to sensible defaults per format
              setNumPrecision(f === "percent" ? 0 : 2);
            }}
            className={cx(
              "flex items-center gap-2 rounded-sm border p-2 text-left transition-colors",
              numFmt === f
                ? "border-accent bg-accent-wash"
                : "border-line hover:border-line-2 hover:bg-hover",
            )}
          >
            <span
              className={cx(
                "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm font-mono text-[10px]",
                numFmt === f ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2",
              )}
              aria-hidden
            >
              {icon}
            </span>
            <span className="font-mono text-[11px] text-ink">{fLabel}</span>
          </button>
        ))}
      </div>

      {/* Precision (decimal / percent / currency) */}
      {(numFmt === "decimal" || numFmt === "percent" || numFmt === "currency") && (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-ink-3 w-16 shrink-0">Precision</span>
          <div className="flex gap-1">
            {(numFmt === "decimal" ? [1, 2, 3, 4] : [0, 1, 2]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setNumPrecision(p)}
                className={cx(
                  "h-6 w-6 rounded-sm border font-mono text-[11px] transition-colors",
                  numPrecision === p
                    ? "border-accent bg-accent-wash text-ink"
                    : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Symbol + position (currency) */}
      {numFmt === "currency" && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {["$", "€", "£", "¥", "kr", "USD", "EUR", "GBP"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setCurrSymbol(s)}
                className={cx(
                  "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                  currSymbol === s
                    ? "border-accent bg-accent-wash text-ink"
                    : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                )}
              >
                {s}
              </button>
            ))}
            <input
              value={currSymbol}
              onChange={(e) => setCurrSymbol(e.target.value.slice(0, 6))}
              placeholder="…"
              className="w-12 rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink outline-none focus:border-accent"
            />
          </div>
          <div className="flex gap-1.5">
            {(["prefix", "suffix"] as const).map((pos) => (
              <button
                key={pos}
                type="button"
                onClick={() => setCurrPosition(pos)}
                className={cx(
                  "flex-1 rounded-sm border px-2 py-1.5 font-mono text-[10px] capitalize transition-colors",
                  currPosition === pos
                    ? "border-accent bg-accent-wash text-ink"
                    : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                )}
              >
                {pos === "prefix" ? "$ 42.00" : "42.00 $"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  </>
)}
```

- [ ] **Step 4: Typecheck + full test suite**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck && bun run test
```

Expected: no errors, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/AddFieldPopover.tsx
git commit -m "feat(number-format): AddFieldPopover number format config panel"
```

---

## Task 5: `TablePane` field→column mapping

**Files:**
- Modify: `app/src/components/TablePane.tsx`

- [ ] **Step 1: Pass `numberFormat` through in the fields map**

Find the fields mapping (around line 269):

```ts
...fields.map<ColumnDef<CanonicalValue>>((f) => ({
  field: f.field,
  label: f.label,
  type: f.type as ColumnDef<CanonicalValue>["type"],
  options: f.options,
  editable: true,
  render: undefined,
})),
```

Add `numberFormat`:

```ts
...fields.map<ColumnDef<CanonicalValue>>((f) => ({
  field: f.field,
  label: f.label,
  type: f.type as ColumnDef<CanonicalValue>["type"],
  options: f.options,
  numberFormat: f.numberFormat,
  editable: true,
  render: undefined,
})),
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "feat(number-format): propagate numberFormat from FieldDef to ColumnDef"
```

---

## Task 6: Server — `NumberFormat` type + `FieldDef` + `listFields` parse branch

**Files:**
- Modify: `server/src/repo-shared.ts`
- Modify: `server/src/repo-canonical.ts`
- Create: `server/test/number-format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/number-format.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  await resetDb();
});

test("addField persists integer numberFormat and listFields returns it", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brand", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Rank", "number", undefined, { numberFormat: { format: "integer" } }, userId);
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.label === "Rank");
  expect(f).toBeDefined();
  expect(f?.numberFormat).toEqual({ format: "integer" });
  expect(f?.options).toBeUndefined();
});

test("addField persists currency numberFormat and listFields returns it", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Product", [], { keyKind: "slug" }, userId);
  await repo.addField(
    dimId,
    "Price",
    "number",
    undefined,
    { numberFormat: { format: "currency", symbol: "$", position: "prefix", precision: 2 } },
    userId,
  );
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.label === "Price");
  expect(f?.numberFormat).toEqual({
    format: "currency",
    symbol: "$",
    position: "prefix",
    precision: 2,
  });
});

test("addField with no numberFormat leaves options null and numberFormat undefined", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Channel", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Count", "number", undefined, {}, userId);
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.label === "Count");
  expect(f?.numberFormat).toBeUndefined();
  expect(f?.options).toBeUndefined();
});

test("changeColumnType to number with currency format persists it", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Region", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Score", "text", undefined, {}, userId);
  await repo.changeColumnType(
    dimId,
    "score",
    "number",
    undefined,
    false,
    userId,
    { format: "currency", symbol: "€", position: "prefix", precision: 2 },
  );
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.field === "score");
  expect(f?.numberFormat).toEqual({ format: "currency", symbol: "€", position: "prefix", precision: 2 });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test:db:up && bun run test -- number-format
```

Expected: FAIL — `repo.listFields` is not exported / `numberFormat` property missing.

- [ ] **Step 3: Add `NumberFormat` + `parseNumberFormat` to `repo-shared.ts`**

In `server/src/repo-shared.ts`, after the `parseOptions` function (after line 57), add:

```ts
export type NumberFormat =
  | { format: "integer" }
  | { format: "decimal"; precision: 1 | 2 | 3 | 4 }
  | { format: "percent"; precision: 0 | 1 | 2 }
  | { format: "currency"; symbol: string; position: "prefix" | "suffix"; precision: 0 | 1 | 2 }

const VALID_FORMATS = ["integer", "decimal", "percent", "currency"];

export function parseNumberFormat(raw: unknown): NumberFormat | undefined {
  let obj: unknown = raw;
  if (typeof obj === "string" && obj.length > 0) {
    try {
      obj = JSON.parse(obj);
    } catch {
      return undefined;
    }
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
```

Update `FieldDef` (around line 59) to add `numberFormat?`:

```ts
export interface FieldDef {
  field: string;
  label: string;
  type: string;
  options?: OptionDef[];
  numberFormat?: NumberFormat;
}
```

- [ ] **Step 4: Add parse branch in `listFields` in `repo-canonical.ts`**

Find `listFields` (around line 409) and update the map:

```ts
export async function listFields(dimId: string): Promise<FieldDef[]> {
  const rows = await pgAll<{ field: string; label: string; type: string; options: string | null }>(
    `SELECT field, label, type, options FROM ${pg("dimension_field")} WHERE dim_id = $1 ORDER BY created_at`,
    [dimId],
  );
  return rows.map((r) => ({
    field: r.field,
    label: r.label,
    type: r.type,
    options: r.type === "select" ? parseOptions(r.options) : undefined,
    numberFormat: r.type === "number" ? parseNumberFormat(r.options) : undefined,
  }));
}
```

Also add `parseNumberFormat` to the import from `repo-shared.ts` at the top of `repo-canonical.ts`:

```ts
import {
  parseOptions,
  parseNumberFormat,
  type FieldDef,
  // ... other existing imports
} from "./repo-shared.ts";
```

- [ ] **Step 5: Export `listFields` from `repo-canonical.ts`**

Confirm `listFields` is already exported (it has `export async function listFields`). If it's not, add `export`.

- [ ] **Step 6: Run the failing tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test -- number-format
```

Expected: the first 3 tests (addField) still fail because `addField` doesn't persist `numberFormat` yet. The `listFields` parse branch is now there but nothing writes it. Proceed to Task 7.

- [ ] **Step 7: Typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/repo-shared.ts server/src/repo-canonical.ts server/test/number-format.test.ts
git commit -m "feat(number-format): server NumberFormat type, FieldDef, listFields parse branch"
```

---

## Task 7: Server — `addField` + `changeColumnType` persist `numberFormat`

**Files:**
- Modify: `server/src/repo-canonical.ts`

- [ ] **Step 1: Update `addField` to persist `numberFormat`**

Find `addField` (around line 426). Change the `opts` parameter type and the `optsJson` line:

Change signature:
```ts
export async function addField(
  dimId: string,
  label: string,
  type: string = "text",
  options: OptionDef[] | undefined,
  opts: { silent?: boolean; numberFormat?: NumberFormat } = {},
  userId: string,
): Promise<{ field: string } | null> {
```

Change the `optsJson` line (around line 441):
```ts
const optsJson =
  t === "select"
    ? JSON.stringify(options ?? [])
    : t === "number" && opts.numberFormat != null
      ? JSON.stringify(opts.numberFormat)
      : null;
```

Add `NumberFormat` to the import from `repo-shared.ts` at the top if not already there:
```ts
import {
  parseOptions,
  parseNumberFormat,
  type FieldDef,
  type NumberFormat,
  // ... other existing imports
} from "./repo-shared.ts";
```

- [ ] **Step 2: Update `changeColumnType` to persist `numberFormat`**

Find `changeColumnType` (around line 474). Add `numberFormat` as a new last parameter:

```ts
export async function changeColumnType(
  dimId: string,
  field: string,
  newType: string,
  options: OptionDef[] | undefined,
  coerceInvalidToNull: boolean = false,
  userId: string,
  numberFormat?: NumberFormat,
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
```

Find the line in the transaction that writes `options` to `dimension_field` (around line 565):
```ts
`UPDATE ${pg("dimension_field")} SET type = $1, options = $2 WHERE dim_id = $3 AND field = $4`,
[newType, newType === "select" ? JSON.stringify(finalOptions ?? []) : null, dimId, field],
```

Replace with:
```ts
`UPDATE ${pg("dimension_field")} SET type = $1, options = $2 WHERE dim_id = $3 AND field = $4`,
[
  newType,
  newType === "select"
    ? JSON.stringify(finalOptions ?? [])
    : newType === "number" && numberFormat != null
      ? JSON.stringify(numberFormat)
      : null,
  dimId,
  field,
],
```

- [ ] **Step 3: Run server tests**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test -- number-format
```

Expected: all 4 tests PASS.

- [ ] **Step 4: Run full server test suite + typecheck**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run test && bun run typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-canonical.ts
git commit -m "feat(number-format): addField and changeColumnType persist numberFormat"
```

---

## Task 8: Server endpoints + `tables.ts`

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/tables.ts`

- [ ] **Step 1: Update POST `/api/dimensions/:id/fields` to accept `numberFormat`**

In `server/src/server.ts`, find the POST fields handler (around line 306). Add `NumberFormat` import at the top of the file if not already imported:

```ts
import type { NumberFormat } from "./repo-shared.ts";
```

Update the destructure and the `addField` call:

```ts
if (seg[3] === "fields" && seg.length === 4 && method === "POST") {
  const { label, type, options, numberFormat } = (await req.json()) as {
    label: string;
    type?: string;
    options?: { label: string; color: string | null }[];
    numberFormat?: NumberFormat;
  };
  return json(
    await repo.addField(
      id,
      label,
      type,
      options as repo.OptionDef[] | undefined,
      { numberFormat },
      me,
    ),
  );
}
```

- [ ] **Step 2: Update PUT `/api/dimensions/:id/fields/:field` to accept `numberFormat`**

Find the PUT handler (around line 333). Update the body type and the `changeColumnType` call:

```ts
if (method === "PUT") {
  const body = (await req.json()) as {
    label?: string;
    type?: string;
    options?: { label: string; color: string | null }[];
    numberFormat?: NumberFormat;
    coerceInvalidToNull?: boolean;
  };
  if (body.label != null) {
    await repo.renameColumn(id, field, body.label, me);
  }
  if (body.type != null) {
    const res = await repo.changeColumnType(
      id,
      field,
      body.type,
      body.options as repo.OptionDef[] | undefined,
      body.coerceInvalidToNull ?? false,
      me,
      body.numberFormat,
    );
    return json(res);
  }
  return noContent();
}
```

- [ ] **Step 3: Update `tables.ts`**

In `server/src/tables.ts`:

1. Add `NumberFormat` import at the top:
```ts
import type { OptionDef, PaletteName, NumberFormat } from "./repo-shared.ts";
```

2. Update `ColumnDraft`:
```ts
export interface ColumnDraft {
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select";
  options?: OptionDef[];
  numberFormat?: NumberFormat;
}
```

3. Update the `addField` call (around line 126):
```ts
await repo.addField(id, c.label.trim(), c.type, c.options, { silent: true, numberFormat: c.numberFormat }, userId);
```

- [ ] **Step 4: Typecheck + full server test suite**

```bash
cd /Users/fhagelund/Documents/GitHub/zugzug/server && bun run typecheck && bun run test
```

Expected: no type errors, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/src/tables.ts
git commit -m "feat(number-format): server endpoints and tables.ts accept numberFormat"
```

---

## Self-review checklist

- [ ] Spec section "Data model" → covered in Tasks 1 + 6
- [ ] Spec section "`NumberCell`" → covered in Task 2
- [ ] Spec section "`AddFieldPopover`" → covered in Task 4
- [ ] Spec section "`ColumnHeaderMenu`" → covered in Task 3
- [ ] Spec section "Server `repo-shared`" → covered in Task 6
- [ ] Spec section "Server `repo-canonical`" → covered in Tasks 6 + 7
- [ ] Spec section "Server `server.ts`" → covered in Task 8
- [ ] Spec section "Server `tables.ts`" → covered in Task 8
- [ ] Spec section "`TablePane` field→column mapping" → covered in Task 5
- [ ] Backwards compat (null `options` → `numberFormat` undefined) → `parseNumberFormat` returns `undefined` for null ✓
- [ ] Percent normalized storage (store 0.42, display 42%) → Task 2 Editor divides by 100, Renderer multiplies ✓
- [ ] Negative currency rendering (`-$42.00` not `$-42.00`) → `formatNumber` currency case ✓
