import type {
  AdapterCapabilities,
  CatalogTable,
  ColumnMeta,
  DimensionSpec,
  Ref,
  ValueCount,
  ValueProvenance,
  WritableWarehouseAdapter,
  ApprovedDraft,
  CommitResult,
} from "../adapter.ts";
import type { SnowflakeCreds } from "../credentials.ts";
import { createRealConnection, type SnowflakeConnection } from "./sdk-wrapper.ts";

/**
 * SnowflakeAdapter — writable warehouse adapter using snowflake-sdk.
 *
 * Connection is constructor-injected so tests can pass a mock. Production
 * code calls `new SnowflakeAdapter(creds)` and gets the real connection
 * via `createRealConnection` (the default factory).
 *
 * Identifier case-folding (the #1 footgun): Snowflake stores UNQUOTED
 * identifiers as UPPERCASE. Quoting (`"foo"`) preserves case verbatim. The
 * adapter always quotes, which means a column the user named `foo` lower-case
 * via `CREATE TABLE t ("foo" VARCHAR)` is referred to as `"foo"`, while a
 * column named `foo` unquoted (becomes `FOO`) is `"FOO"`. The Ref/column
 * inputs to this adapter must already be in the correct case — the Sources
 * registration UI (Phase 4) is responsible for that.
 */
export class SnowflakeAdapter implements WritableWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true };

  private readonly creds: SnowflakeCreds;
  private conn: SnowflakeConnection | null = null;
  private readonly connectionFactory: (creds: SnowflakeCreds) => SnowflakeConnection;

  constructor(
    creds: SnowflakeCreds,
    connectionFactory: (creds: SnowflakeCreds) => SnowflakeConnection = createRealConnection,
  ) {
    this.creds = creds;
    this.connectionFactory = connectionFactory;
    this.capabilities = {
      id: "snowflake",
      writable: true,
      supportsMerge: true,
      identifierCase: "upper",
      supportsApproximateDistinct: true,
    };
  }

  // ---- helpers ----

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  qualifyRef(table: Ref): string {
    const catalog = table.catalog ?? this.creds.database;
    return `${this.quoteIdentifier(catalog)}.${this.quoteIdentifier(table.schema)}.${this.quoteIdentifier(table.table)}`;
  }

  castToString(expr: string): string {
    return `CAST(${expr} AS VARCHAR)`;
  }

  // ---- connection lifecycle (internal) ----

  // Used by Tasks 4–9 once query methods are implemented.
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  protected _getConnection(): SnowflakeConnection {
    if (!this.conn) this.conn = this.connectionFactory(this.creds);
    return this.conn;
  }

  // ---- the rest of the interface — implemented in Tasks 4–9 ----

  ping(): Promise<boolean> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 4");
  }
  listTables(_opts?: { schema?: string; search?: string }): Promise<CatalogTable[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 5");
  }
  listColumns(_table: Ref): Promise<ColumnMeta[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 5");
  }
  tableExists(_table: Ref): Promise<boolean> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 5");
  }
  distinctValues(_table: Ref, _column: string, _limit: number): Promise<string[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 6");
  }
  topValuesByFrequency(_table: Ref, _column: string, _limit: number): Promise<ValueCount[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 6");
  }
  columnStats(
    _table: Ref,
    _column: string,
    _opts?: { approximate?: boolean },
  ): Promise<{ rows: number; distinct: number }> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 6");
  }
  nameResolution(_table: Ref, _idCol: string, _nameCol: string): Promise<Map<string, string>> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 6");
  }
  distinctValuesWithProvenance(
    _sources: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 7");
  }
  ensureCanonicalTables(_dim: DimensionSpec): Promise<void> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 8");
  }
  commitCanonical(_dim: DimensionSpec, _drafts: ApprovedDraft[]): Promise<CommitResult> {
    throw new Error("SnowflakeAdapter — Phase 2 Task 9");
  }
}
