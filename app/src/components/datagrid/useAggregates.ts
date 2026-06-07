import { useMemo } from "react";
import type { ColumnDef } from "./types";

interface Bounds { minRow: number; maxRow: number; minCol: number; maxCol: number }

export interface Aggregates {
  count:    number;
  distinct: number | null;
  sum:      number | null;
  avg:      number | null;
  min:      number | string | null;
  max:      number | string | null;
}

const MAX_CELLS = 100_000;

export function computeAggregates<Row>(
  rows: Row[],
  cols: ColumnDef<Row>[],
  getValue: (r: Row, f: string) => unknown,
  b: Bounds,
): Aggregates {
  const cellCount = (b.maxRow - b.minRow + 1) * (b.maxCol - b.minCol + 1);
  if (cellCount > MAX_CELLS) {
    return { count: cellCount, distinct: null, sum: null, avg: null, min: null, max: null };
  }
  let count = 0;
  const seen = new Set<string>();
  let sum = 0, sumCount = 0;
  let min: number | string | null = null;
  let max: number | string | null = null;
  let anyNumeric = false;
  for (let r = b.minRow; r <= b.maxRow; r++) {
    const row = rows[r];
    if (!row) continue;
    for (let c = b.minCol; c <= b.maxCol; c++) {
      const col = cols[c];
      if (!col) continue;
      const v = getValue(row, col.field);
      if (v == null || v === "") continue;
      count++;
      seen.add(String(v));
      const isNumericCol = col.config.type === "number" || col.config.type === "rating";
      if (isNumericCol && typeof v === "number" && !isNaN(v)) {
        anyNumeric = true;
        sum += v;
        sumCount++;
        if (min == null || (typeof min === "number" && v < min)) min = v;
        if (max == null || (typeof max === "number" && v > max)) max = v;
      } else if (!anyNumeric) {
        const s = String(v);
        if (min == null || (typeof min === "string" && s < min)) min = s;
        if (max == null || (typeof max === "string" && s > max)) max = s;
      }
    }
  }
  return {
    count,
    distinct: seen.size,
    sum: anyNumeric ? sum : null,
    avg: anyNumeric && sumCount > 0 ? sum / sumCount : null,
    min,
    max,
  };
}

export function useAggregates<Row>(
  rows: Row[],
  cols: ColumnDef<Row>[],
  getValue: (r: Row, f: string) => unknown,
  bounds: Bounds | null,
): Aggregates | null {
  return useMemo(() => {
    if (!bounds) return null;
    return computeAggregates(rows, cols, getValue, bounds);
  }, [rows, cols, getValue, bounds]);
}
