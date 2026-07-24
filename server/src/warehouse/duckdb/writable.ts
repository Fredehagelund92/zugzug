import type {
  AdapterCapabilities,
  ApprovedDraft,
  CommitResult,
  RefTableSpec,
  Ref,
  WritableWarehouseAdapter,
} from "../adapter.ts";
import { DuckDbBase } from "./base.ts";

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** DuckDB adapter that writes record dim_/map_ records back to the
 *  warehouse (MotherDuck or local). Enabled when MOTHERDUCK_WRITABLE=true
 *  (or for a local DuckDB file with `writable: true`). */
export class DuckDbWritableAdapter extends DuckDbBase implements WritableWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true } = {
    id: "duckdb",
    writable: true,
    supportsMerge: true,
    identifierCase: "preserve",
    supportsApproximateDistinct: false,
    supportsMultipleDatabases: true,
    databaseTerm: "catalog",
    maxIdentifierLength: 255,
  };

  async ensureRecordTables(refTable: RefTableSpec): Promise<void> {
    const refTableRef = this.parseTwoPartRef(refTable.dimTable);
    const mapRef = this.parseTwoPartRef(refTable.mapTable);
    const key = this.quoteIdentifier(refTable.keyCol);

    // CREATE TABLE IF NOT EXISTS is idempotent; safe to call on every commit.
    await this.run(
      `CREATE TABLE IF NOT EXISTS ${this.qualifyRef(refTableRef)} (
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

  async commitRecord(refTable: RefTableSpec, drafts: ApprovedDraft[]): Promise<CommitResult> {
    if (drafts.length === 0) return { rowsWritten: 0 };
    const refTableRef = this.parseTwoPartRef(refTable.dimTable);
    const mapRef = this.parseTwoPartRef(refTable.mapTable);
    const key = this.quoteIdentifier(refTable.keyCol);

    // Deduplicate record rows by key (last-write-wins on label, matches
    // SnowflakeAdapter behavior).
    const canonByKey = new Map<string, string | null>();
    for (const d of drafts) canonByKey.set(d.key, d.label);
    const canonRows = [...canonByKey.entries()].map(([k, l]) => ({ key: k, label: l }));
    const mapRows = drafts.map((d) => ({ raw: d.raw, key: d.key }));

    let rowsWritten = 0;
    rowsWritten += await this.mergeChunked({
      targetRef: refTableRef,
      chunks: chunk(canonRows, 1000),
      sourceCols: [key, "label"],
      onCol: key,
      pickBinds: (row) => [row.key, row.label],
    });
    rowsWritten += await this.mergeChunked({
      targetRef: mapRef,
      chunks: chunk(mapRows, 1000),
      sourceCols: [`"raw"`, key],
      onCol: `"raw"`,
      pickBinds: (row) => [row.raw, row.key],
    });
    return { rowsWritten };
  }

  // Issue chunked MERGE INTO ... USING (VALUES (?, ?), ...) statements.
  // Each chunk becomes one MERGE; returns sum of inserted-row counts.
  // DuckDB has supported MERGE INTO since v0.10; syntax mirrors Snowflake's
  // USING (VALUES …) AS S(a, b) form.
  private async mergeChunked<T>(opts: {
    targetRef: Ref;
    chunks: T[][];
    sourceCols: [string, string];
    onCol: string;
    pickBinds: (row: T) => [unknown, unknown];
  }): Promise<number> {
    let total = 0;
    for (const c of opts.chunks) {
      if (c.length === 0) continue;
      const placeholders = c.map(() => "(?, ?)").join(", ");
      const [colA, colB] = opts.sourceCols;
      const sqlText = `MERGE INTO ${this.qualifyRef(opts.targetRef)} T
                       USING (VALUES ${placeholders}) AS S(${colA}, ${colB})
                       ON T.${opts.onCol} = S.${colA}
                       WHEN NOT MATCHED THEN INSERT (${colA}, ${colB}) VALUES (S.${colA}, S.${colB})`;
      const binds = c.flatMap((row) => opts.pickBinds(row));
      await this.run(sqlText, binds as never);
      total += c.length; // For MERGE INTO INSERT-only, all input rows are "potentially affected";
      // DuckDB doesn't expose getNumUpdatedRows() cleanly via @duckdb/node-api,
      // so we count input-chunk size. Idempotent re-runs report the same total
      // even though zero rows were inserted — acceptable for the audit log
      // ("Warehouse synced N values" — N is intent, not realized inserts).
    }
    return total;
  }
}
