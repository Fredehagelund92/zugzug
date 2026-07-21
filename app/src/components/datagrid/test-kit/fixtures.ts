import type { ColumnDef } from "../types";

export type Row = { id: string; name: string; count: number; active: boolean; region: string };

export const rowKeyFn = (r: Row): string => r.id;

export function makeColumns(): ColumnDef<Row>[] {
  return [
    { field: "name", label: "Name", config: { type: "text" }, editable: true },
    { field: "count", label: "Count", config: { type: "number" }, editable: true },
    { field: "active", label: "Active", config: { type: "boolean" }, editable: true },
    {
      field: "region",
      label: "Region",
      config: {
        type: "select",
        options: [
          { label: "EMEA", color: null },
          { label: "AMER", color: null },
        ],
      },
      editable: true,
    },
  ];
}

export function makeRows(n = 5): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    name: `Name ${i}`,
    count: i,
    active: i % 2 === 0,
    region: i % 2 === 0 ? "AMER" : "EMEA",
  }));
}
