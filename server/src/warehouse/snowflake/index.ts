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

/**
 * Phase 2 — full implementation. This stub exists so the factory registry
 * compiles and so contributors can see the interface obligations for a
 * second-adapter PR.
 */
export class SnowflakeAdapter implements WritableWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true };

  constructor(_creds: SnowflakeCreds) {
    this.capabilities = {
      id: "snowflake",
      writable: true,
      supportsMerge: true,
      identifierCase: "upper",
      supportsApproximateDistinct: true,
    };
  }

  quoteIdentifier(_name: string): string {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  qualifyRef(_t: Ref): string {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  castToString(_e: string): string {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  ping(): Promise<boolean> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  listTables(): Promise<CatalogTable[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  listColumns(_t: Ref): Promise<ColumnMeta[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  tableExists(_t: Ref): Promise<boolean> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  distinctValues(_t: Ref, _c: string, _n: number): Promise<string[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  topValuesByFrequency(_t: Ref, _c: string, _n: number): Promise<ValueCount[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  columnStats(_t: Ref, _c: string): Promise<{ rows: number; distinct: number }> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  nameResolution(_t: Ref, _i: string, _n: string): Promise<Map<string, string>> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  distinctValuesWithProvenance(
    _s: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  ensureCanonicalTables(_d: DimensionSpec): Promise<void> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
  commitCanonical(_d: DimensionSpec, _x: ApprovedDraft[]): Promise<CommitResult> {
    throw new Error("SnowflakeAdapter — Phase 2");
  }
}
