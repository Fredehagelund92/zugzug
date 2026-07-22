// Harness-only stand-in for ../store. Provides just enough sample data for the
// previewed component to render richly, without Postgres + the Bun backend.
// Add exports here for any other store hook/function your component imports.
export type CreateTableMode = "blank" | "source" | "external_id" | "file";
export type CreateTableInput = Record<string, unknown>;

interface SourceInfo {
  table: string;
  column: string;
  dimension: string;
  dimId: string;
  present: boolean;
  rows: number;
  values: number;
  unmapped: number;
  scanned: boolean;
  scannedAt?: string | null;
}

const s = (table: string, column: string, rows: number, values: number): SourceInfo => ({
  table,
  column,
  dimension: column,
  dimId: `${table}.${column}`,
  present: true,
  rows,
  values,
  unmapped: 0,
  scanned: true,
  scannedAt: "2026-01-01T00:00:00Z",
});

const SAMPLE: SourceInfo[] = [
  s("orders", "customer_id", 1204, 1204), // perfect key (distinct === rows)
  s("orders", "name", 1204, 1180),
  s("orders", "region", 1204, 9),
  s("orders", "email", 1204, 1190),
  s("customers", "id", 842, 842),
  s("customers", "display_name", 842, 831),
];

export function useSources(): SourceInfo[] {
  return SAMPLE;
}

export async function createTable(_input: CreateTableInput): Promise<string> {
  return "mock-table-id";
}
