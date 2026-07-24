import { test, expect, describe } from "vitest";
import { computeAggregates } from "../src/components/datagrid/useAggregates";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  n: number | null;
  tag: string;
}
const rows: Row[] = [
  { id: "1", n: 10, tag: "a" },
  { id: "2", n: 20, tag: "a" },
  { id: "3", n: null, tag: "b" },
  { id: "4", n: 30, tag: "" },
];
const cols: ColumnDef<Row>[] = [
  { field: "n", label: "N", config: { type: "number" } },
  { field: "tag", label: "Tag", config: { type: "text" } },
];

const getValue = (r: Row, f: string) => (r as any)[f];

describe("computeAggregates", () => {
  test("Count counts non-empty cells across range", () => {
    const agg = computeAggregates(rows, cols, getValue, {
      minRow: 0,
      maxRow: 3,
      minCol: 0,
      maxCol: 1,
    });
    expect(agg.count).toBe(6);
  });
  test("Distinct counts unique String(value) of non-null/non-empty", () => {
    const agg = computeAggregates(rows, cols, getValue, {
      minRow: 0,
      maxRow: 3,
      minCol: 0,
      maxCol: 1,
    });
    expect(agg.distinct).toBe(5);
  });
  test("Sum + Avg over numeric columns only", () => {
    const agg = computeAggregates(rows, cols, getValue, {
      minRow: 0,
      maxRow: 3,
      minCol: 0,
      maxCol: 1,
    });
    expect(agg.sum).toBe(60);
    expect(agg.avg).toBeCloseTo(20);
  });
  test("sums numeric-typed fields even when values are numeric strings", () => {
    const stringRows = [
      { id: "1", n: "100" },
      { id: "2", n: "100" },
      { id: "3", n: "100" },
    ];
    const stringCols = [{ field: "n", label: "N", config: { type: "number" } }];
    const agg = computeAggregates(stringRows as any, stringCols as any, (r, f) => (r as any)[f], {
      minRow: 0,
      maxRow: 2,
      minCol: 0,
      maxCol: 0,
    });
    expect(agg.sum).toBe(300);
    expect(agg.avg).toBe(100);
  });
  test("non-numeric string in a numeric field is excluded — no NaN poisoning", () => {
    const mixedRows = [
      { id: "1", n: "100" },
      { id: "2", n: "abc" },
      { id: "3", n: "200" },
    ];
    const mixedCols = [{ field: "n", label: "N", config: { type: "number" } }];
    const agg = computeAggregates(mixedRows as any, mixedCols as any, (r, f) => (r as any)[f], {
      minRow: 0,
      maxRow: 2,
      minCol: 0,
      maxCol: 0,
    });
    expect(agg.sum).toBe(300);
    expect(agg.avg).toBe(150);
  });
});
