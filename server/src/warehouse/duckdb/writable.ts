import type {
  AdapterCapabilities,
  ApprovedDraft,
  CommitResult,
  RecordSyncExtras,
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

    // The dim_/map_ schema mirrors Postgres' record schema and does not exist
    // on a fresh warehouse — CREATE TABLE alone fails there.
    await this.run(`CREATE SCHEMA IF NOT EXISTS ${this.qualifySchema(refTableRef)}`);
    if (mapRef.schema !== refTableRef.schema) {
      await this.run(`CREATE SCHEMA IF NOT EXISTS ${this.qualifySchema(mapRef)}`);
    }
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
  // `recordDatabase` supplies the catalog a MotherDuck connection has no
  // current one for; local/in-memory connections leave it undefined and stay
  // two-part.
  private parseTwoPartRef(stored: string): Ref {
    const parts = stored.split(".");
    if (parts.length === 2)
      return { catalog: this.creds.recordDatabase, schema: parts[0], table: parts[1] };
    if (parts.length === 3) return { catalog: parts[0], schema: parts[1], table: parts[2] };
    return {
      catalog: this.creds.recordDatabase,
      schema: this.creds.database ?? "main",
      table: stored,
    };
  }

  /** Catalog-qualified schema name, for CREATE SCHEMA. */
  private qualifySchema(ref: Ref): string {
    const catalog = ref.catalog ?? this.creds.database;
    const schema = this.quoteIdentifier(ref.schema);
    return catalog ? `${this.quoteIdentifier(catalog)}.${schema}` : schema;
  }

  async commitRecord(
    refTable: RefTableSpec,
    drafts: ApprovedDraft[],
    extras: RecordSyncExtras = {},
  ): Promise<CommitResult> {
    const retiredKeys = extras.retiredKeys ?? [];
    if (
      drafts.length === 0 &&
      !extras.records?.length &&
      !extras.mappings?.length &&
      !retiredKeys.length
    )
      return { rowsWritten: 0 };
    const refTableRef = this.parseTwoPartRef(refTable.dimTable);
    const mapRef = this.parseTwoPartRef(refTable.mapTable);
    const key = this.quoteIdentifier(refTable.keyCol);

    // Deduplicate record rows by key (last-write-wins on label, matches
    // SnowflakeAdapter behavior). extras.records carry edits with no draft of
    // their own (a rename) and win over a draft's stale label.
    const canonByKey = new Map<string, string | null>();
    for (const d of drafts) canonByKey.set(d.key, d.label);
    for (const r of extras.records ?? []) canonByKey.set(r.key, r.label);
    const canonRows = [...canonByKey.entries()].map(([k, l]) => ({ key: k, label: l }));
    // Same for map rows: one per raw, extras (re-pointed by a record merge) last.
    const mapByRaw = new Map<string, string>();
    for (const d of drafts) mapByRaw.set(d.raw, d.key);
    for (const m of extras.mappings ?? []) mapByRaw.set(m.raw, m.key);
    const mapRows = [...mapByRaw.entries()].map(([raw, k]) => ({ raw, key: k }));

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
    // Retired (or merged-away) keys last, so a mapping this publish re-pointed
    // to the survivor above is not deleted along with the key it left.
    for (const c of chunk([...retiredKeys], 1000)) {
      const holes = c.map(() => "?").join(", ");
      await this.run(
        `DELETE FROM ${this.qualifyRef(mapRef)} WHERE ${key} IN (${holes})`,
        c as never,
      );
      await this.run(
        `DELETE FROM ${this.qualifyRef(refTableRef)} WHERE ${key} IN (${holes})`,
        c as never,
      );
    }
    return { rowsWritten };
  }

  // Issue chunked MERGE INTO ... USING (VALUES (?, ?), ...) statements.
  // Each chunk becomes one MERGE; returns sum of affected-row counts.
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
      // WHEN MATCHED THEN UPDATE is what makes this a merge rather than an
      // append: a re-mapped source value repoints its existing map row and a
      // renamed record overwrites its label, instead of leaving the published
      // table stale forever.
      const sqlText = `MERGE INTO ${this.qualifyRef(opts.targetRef)} T
                       USING (VALUES ${placeholders}) AS S(${colA}, ${colB})
                       ON T.${opts.onCol} = S.${colA}
                       WHEN MATCHED THEN UPDATE SET ${colB} = S.${colB}
                       WHEN NOT MATCHED THEN INSERT (${colA}, ${colB}) VALUES (S.${colA}, S.${colB})`;
      const binds = c.flatMap((row) => opts.pickBinds(row));
      await this.run(sqlText, binds as never);
      total += c.length; // DuckDB doesn't expose getNumUpdatedRows() cleanly via
      // @duckdb/node-api, so we count input-chunk size. Idempotent re-runs report
      // the same total even though nothing changed — acceptable for the audit log
      // ("Warehouse synced N values" — N is intent, not realized writes).
    }
    return total;
  }
}
