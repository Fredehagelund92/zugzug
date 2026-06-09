import type { AdapterCapabilities, ReadOnlyWarehouseAdapter } from "../adapter.ts";
import { DuckDbBase } from "./base.ts";

/** DuckDB adapter that only reads from the warehouse. Canonical writes go
 *  to Postgres; users download Parquet snapshots when they want a file copy.
 *  This is the default when MOTHERDUCK_WRITABLE=false (or local DuckDB). */
export class DuckDbReadOnlyAdapter extends DuckDbBase implements ReadOnlyWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: false } = {
    id: "duckdb",
    writable: false,
    supportsMerge: false,
    identifierCase: "preserve",
    supportsApproximateDistinct: false,
  };
}
