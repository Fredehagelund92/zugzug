import type {
  AdapterCapabilities,
  ApprovedDraft,
  CommitResult,
  DimensionSpec,
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

  async ensureCanonicalTables(_dim: DimensionSpec): Promise<void> {
    throw new Error("DuckDbWritableAdapter — Task 6");
  }

  async commitCanonical(_dim: DimensionSpec, _drafts: ApprovedDraft[]): Promise<CommitResult> {
    throw new Error("DuckDbWritableAdapter — Task 7");
  }
}
