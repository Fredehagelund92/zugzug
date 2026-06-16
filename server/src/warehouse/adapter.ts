// Adapter contract for warehouse access. DuckDB and Snowflake both implement this.
// No SQL escape hatch on purpose — every query shape the app needs is a first-class method.

export interface Ref {
  readonly catalog?: string; // Snowflake/BigQuery 3-part; omit for DuckDB/PG
  readonly schema: string;
  readonly table: string;
}

export interface AdapterIds {
  duckdb: true;
  snowflake: true;
}
export type AdapterId = keyof AdapterIds;

export interface AdapterCapabilities {
  readonly id: AdapterId;
  readonly writable: boolean;
  readonly supportsMerge: boolean;
  readonly identifierCase: "preserve" | "upper" | "lower";
  readonly supportsApproximateDistinct: boolean;
  readonly supportsMultipleDatabases: boolean;
  readonly databaseTerm: "catalog" | "database" | "dataset" | "schema";
  readonly maxIdentifierLength: number;
}

export interface CatalogTable {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
}

export interface ColumnMeta {
  readonly name: string;
  readonly type: string;
}

export interface ValueCount {
  readonly value: string;
  readonly count: number;
}

export interface DatabaseDescriptor {
  databaseName: string;
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };

export interface ValueProvenance {
  readonly value: string;
  // Opaque index back into the `sources` array the caller passed in.
  // Avoids leaking SQL-qualified ref strings into application code.
  readonly sourceIndex: number;
  readonly count: number;
}

export interface DimensionSpec {
  readonly dimId: string;
  readonly dimTable: string;
  readonly mapTable: string;
  readonly keyCol: string;
}

export interface ApprovedDraft {
  readonly raw: string;
  readonly key: string;
  readonly label: string | null;
}

export interface CommitResult {
  readonly rowsWritten: number;
}

interface BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities;

  ping(): Promise<boolean>;
  listDatabases(): Promise<DatabaseDescriptor[]>;
  probeDatabase(databaseName: string): Promise<ProbeResult>;
  /** Per-database user-schema counts. Excludes system schemas (information_schema, pg_*, etc.). */
  schemaCounts(): Promise<Map<string, number>>;

  // Catalog
  listTables(opts?: {
    schema?: string;
    search?: string;
    database?: string;
  }): Promise<CatalogTable[]>;
  listColumns(table: Ref): Promise<ColumnMeta[]>;
  tableExists(table: Ref): Promise<boolean>;

  // Value scans
  distinctValues(table: Ref, column: string, limit: number): Promise<string[]>;
  topValuesByFrequency(table: Ref, column: string, limit: number): Promise<ValueCount[]>;
  columnStats(
    table: Ref,
    column: string,
    opts?: { approximate?: boolean },
  ): Promise<{ rows: number; distinct: number }>;
  nameResolution(table: Ref, idCol: string, nameCol: string): Promise<Map<string, string>>;

  // Multi-source scan — replaces the old occUnion() builder
  distinctValuesWithProvenance(
    sources: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]>;

  // SQL fragment builders (per-adapter; no shared qid())
  quoteIdentifier(name: string): string;
  qualifyRef(table: Ref): string;
  castToString(expr: string): string;
}

export interface WritableWarehouseAdapter extends BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true };
  ensureCanonicalTables(dim: DimensionSpec): Promise<void>;
  commitCanonical(dim: DimensionSpec, drafts: ApprovedDraft[]): Promise<CommitResult>;
}

export interface ReadOnlyWarehouseAdapter extends BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: false };
}

export type WarehouseAdapter = WritableWarehouseAdapter | ReadOnlyWarehouseAdapter;

export const isWritable = (a: WarehouseAdapter): a is WritableWarehouseAdapter =>
  a.capabilities.writable === true;
