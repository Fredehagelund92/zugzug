import type {
  AdapterCapabilities,
  ApprovedDraft,
  CommitResult,
  DimensionSpec,
  Ref,
  WritableWarehouseAdapter,
} from "../adapter.ts";
import { DuckDbBase } from "./base.ts";

/** DuckDB adapter that writes canonical dim_/map_ records back to the
 *  warehouse (MotherDuck or local). Enabled when MOTHERDUCK_WRITABLE=true
 *  (or for a local DuckDB file with `writable: true`). */
export class DuckDbWritableAdapter extends DuckDbBase implements WritableWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true } = {
    id: "duckdb",
    writable: true,
    supportsMerge: true,
    identifierCase: "preserve",
    supportsApproximateDistinct: false,
  };

  async ensureCanonicalTables(dim: DimensionSpec): Promise<void> {
    const dimRef = this.parseTwoPartRef(dim.dimTable);
    const mapRef = this.parseTwoPartRef(dim.mapTable);
    const key = this.quoteIdentifier(dim.keyCol);

    // CREATE TABLE IF NOT EXISTS is idempotent; safe to call on every commit.
    await this.run(
      `CREATE TABLE IF NOT EXISTS ${this.qualifyRef(dimRef)} (
         ${key} VARCHAR PRIMARY KEY,
         label VARCHAR
       )`,
    );
    await this.run(
      `CREATE TABLE IF NOT EXISTS ${this.qualifyRef(mapRef)} (
         raw VARCHAR PRIMARY KEY,
         ${key} VARCHAR NOT NULL
       )`,
    );
  }

  // Parse a stored "schema.table" string into a Ref. Single-token strings get
  // the creds default schema. Matches SnowflakeAdapter's parseTwoPartRef.
  private parseTwoPartRef(stored: string): Ref {
    const parts = stored.split(".");
    if (parts.length === 2) return { schema: parts[0], table: parts[1] };
    if (parts.length === 3) return { catalog: parts[0], schema: parts[1], table: parts[2] };
    return { schema: this.creds.database ?? "main", table: stored };
  }

  async commitCanonical(_dim: DimensionSpec, _drafts: ApprovedDraft[]): Promise<CommitResult> {
    throw new Error("DuckDbWritableAdapter — Task 7");
  }
}
