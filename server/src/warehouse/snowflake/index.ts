import type {
  AdapterCapabilities,
  CatalogTable,
  ColumnMeta,
  DatabaseDescriptor,
  RefTableSpec,
  ProbeResult,
  Ref,
  ValueCount,
  ValueProvenance,
  WritableWarehouseAdapter,
  ApprovedDraft,
  CommitResult,
  RecordSyncExtras,
} from "../adapter.ts";
import type { SnowflakeCreds } from "../credentials.ts";
import { createRealConnection, type SnowflakeConnection } from "./sdk-wrapper.ts";

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

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
      supportsMultipleDatabases: true,
      databaseTerm: "database",
      maxIdentifierLength: 255,
    };
  }

  // ---- helpers ----

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  qualifyRef(table: Ref): string {
    const catalog = table.catalog ?? this.creds.database;
    if (!catalog) {
      throw new Error(
        `qualifyRef: missing catalog for ${table.schema}.${table.table} — caller must pass Ref.catalog (resolved from warehouse_database).`,
      );
    }
    return `${this.quoteIdentifier(catalog)}.${this.quoteIdentifier(table.schema)}.${this.quoteIdentifier(table.table)}`;
  }

  castToString(expr: string): string {
    return `CAST(${expr} AS VARCHAR)`;
  }

  // ---- connection lifecycle (internal) ----

  protected _getConnection(): SnowflakeConnection {
    if (!this.conn) this.conn = this.connectionFactory(this.creds);
    return this.conn;
  }

  /** Parse a stored "SCHEMA.TABLE" string into a Ref. Single-token strings get
   *  the creds default schema. */
  private parseTwoPartRef(stored: string): Ref {
    const parts = stored.split(".");
    if (parts.length === 2) return { schema: parts[0], table: parts[1] };
    if (parts.length === 3) return { catalog: parts[0], schema: parts[1], table: parts[2] };
    return { schema: this.creds.schema, table: stored };
  }

  // ---- the rest of the interface — implemented in Tasks 4–9 ----

  async ping(): Promise<boolean> {
    try {
      const rows = await this._getConnection().execute({ sqlText: "SELECT 1 AS OK" });
      // LIVE-VALIDATION: Snowflake column names default to UPPERCASE on read.
      // Confirm `OK` (uppercase) is the actual key in returned row objects.
      const first = rows[0] as { OK?: number } | undefined;
      return first?.OK === 1;
    } catch {
      return false;
    }
  }

  async listDatabases(): Promise<DatabaseDescriptor[]> {
    throw new Error("Snowflake listDatabases not yet implemented");
  }

  async probeDatabase(_databaseName: string): Promise<ProbeResult> {
    return { ok: false, reason: "Snowflake probeDatabase not yet implemented" };
  }
  async schemaCounts(): Promise<Map<string, number>> {
    throw new Error("Snowflake schemaCounts not yet implemented");
  }
  async tableExists(table: Ref): Promise<boolean> {
    try {
      // LIVE-VALIDATION: Snowflake supports `SELECT ... LIMIT 0` for an existence
      // probe; confirm this doesn't trigger a warehouse-resume on a suspended
      // warehouse (it shouldn't — LIMIT 0 is a metadata-only query).
      await this._getConnection().execute({
        sqlText: `SELECT 1 FROM ${this.qualifyRef(table)} LIMIT 0`,
      });
      return true;
    } catch {
      return false;
    }
  }

  async listTables(
    opts: { schema?: string; search?: string; database?: string } = {},
  ): Promise<CatalogTable[]> {
    const dbName = opts.database ?? this.creds.database;
    if (!dbName) throw new Error("listTables: missing database (no creds.database fallback)");
    const db = this.quoteIdentifier(dbName);
    // LIVE-VALIDATION: INFORMATION_SCHEMA.TABLES view shape. Confirm TABLE_SCHEMA
    // and TABLE_NAME column names. Also confirm TABLE_TYPE values — we want
    // 'BASE TABLE' and 'VIEW' (Snowflake also has 'EXTERNAL TABLE', 'TEMPORARY').
    const tableBinds: unknown[] = [];
    let tableWhere = `TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA') AND TABLE_TYPE IN ('BASE TABLE','VIEW')`;
    if (opts.schema) {
      tableBinds.push(opts.schema);
      tableWhere += ` AND TABLE_SCHEMA = ?`;
    }
    const qualifiedDot = opts.search ? opts.search.indexOf(".") : -1;
    if (opts.search) {
      if (qualifiedDot >= 0) {
        // Qualified search "schema.table" — match parts separately.
        tableBinds.push(`%${opts.search.slice(0, qualifiedDot)}%`);
        tableBinds.push(`%${opts.search.slice(qualifiedDot + 1)}%`);
        tableWhere += ` AND TABLE_SCHEMA ILIKE ? AND TABLE_NAME ILIKE ?`;
      } else {
        tableBinds.push(`%${opts.search}%`);
        tableWhere += ` AND (TABLE_SCHEMA ILIKE ? OR TABLE_NAME ILIKE ?)`;
        // Bind the same pattern twice (Snowflake ILIKE doesn't deduplicate binds).
        tableBinds.push(`%${opts.search}%`);
      }
    }
    const tableRows = await this._getConnection().execute({
      sqlText: `SELECT TABLE_SCHEMA, TABLE_NAME
                FROM ${db}.INFORMATION_SCHEMA.TABLES
                WHERE ${tableWhere}
                ORDER BY TABLE_SCHEMA, TABLE_NAME
                LIMIT 5000`,
      binds: tableBinds,
    });

    // LIVE-VALIDATION: Snowflake INFORMATION_SCHEMA.COLUMNS is per-database. The
    // join below uses TABLE_SCHEMA + TABLE_NAME, identical to TABLES.
    const colBinds: unknown[] = [];
    let colWhere = `TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA')`;
    if (opts.schema) {
      colBinds.push(opts.schema);
      colWhere += ` AND TABLE_SCHEMA = ?`;
    }
    // Apply the same search filter to columns so a search by column name surfaces
    // the parent table (matches Phase 1 DuckDB behavior).
    if (opts.search) {
      if (qualifiedDot >= 0) {
        // Qualified search "schema.table" — restrict by schema+table, skip column match.
        colBinds.push(`%${opts.search.slice(0, qualifiedDot)}%`);
        colBinds.push(`%${opts.search.slice(qualifiedDot + 1)}%`);
        colWhere += ` AND TABLE_SCHEMA ILIKE ? AND TABLE_NAME ILIKE ?`;
      } else {
        colBinds.push(`%${opts.search}%`);
        colWhere += ` AND (TABLE_SCHEMA ILIKE ? OR TABLE_NAME ILIKE ? OR COLUMN_NAME ILIKE ?)`;
        colBinds.push(`%${opts.search}%`);
        colBinds.push(`%${opts.search}%`);
      }
    }
    const colRows = await this._getConnection().execute({
      sqlText: `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
                FROM ${db}.INFORMATION_SCHEMA.COLUMNS
                WHERE ${colWhere}
                ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
                LIMIT 100000`,
      binds: colBinds,
    });

    // Build the (schema, table) → [column...] map.
    const colsByTable = new Map<string, string[]>();
    for (const r of colRows as Array<{
      TABLE_SCHEMA: string;
      TABLE_NAME: string;
      COLUMN_NAME: string;
    }>) {
      const key = `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`;
      const arr = colsByTable.get(key) ?? [];
      arr.push(r.COLUMN_NAME);
      colsByTable.set(key, arr);
    }

    // Search-by-column surfaces tables that aren't in `tableRows` (columns were
    // matched but the parent table didn't match TABLE_SCHEMA/TABLE_NAME). Union
    // them in so the result mirrors DuckDB's behavior.
    const seen = new Set<string>();
    const result: CatalogTable[] = [];
    for (const t of tableRows as Array<{ TABLE_SCHEMA: string; TABLE_NAME: string }>) {
      const key = `${t.TABLE_SCHEMA}.${t.TABLE_NAME}`;
      seen.add(key);
      result.push({
        schema: t.TABLE_SCHEMA,
        table: t.TABLE_NAME,
        columns: colsByTable.get(key) ?? [],
      });
    }
    if (opts.search) {
      for (const [key, cols] of colsByTable) {
        if (seen.has(key)) continue;
        const [schema, table] = key.split(".");
        result.push({ schema, table, columns: cols });
      }
    }
    return result;
  }

  async listColumns(table: Ref): Promise<ColumnMeta[]> {
    const dbName = table.catalog ?? this.creds.database;
    if (!dbName) throw new Error("listColumns: missing catalog (no creds.database fallback)");
    const db = this.quoteIdentifier(dbName);
    // LIVE-VALIDATION: Snowflake exposes DATA_TYPE on INFORMATION_SCHEMA.COLUMNS;
    // confirm casing (NUMBER vs INT, VARCHAR vs TEXT) doesn't surprise consumers.
    const rows = await this._getConnection().execute({
      sqlText: `SELECT COLUMN_NAME, DATA_TYPE
                FROM ${db}.INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION`,
      binds: [table.schema, table.table],
    });
    return (rows as Array<{ COLUMN_NAME: string; DATA_TYPE: string }>).map((r) => ({
      name: r.COLUMN_NAME,
      type: r.DATA_TYPE,
    }));
  }
  async distinctValues(table: Ref, column: string, limit: number): Promise<string[]> {
    const col = this.quoteIdentifier(column);
    const n = Math.max(1, Math.min(100000, Math.round(limit)));
    // LIVE-VALIDATION: confirm Snowflake LENGTH(TRIM(CAST(...AS VARCHAR))) > 0 works.
    // Snowflake's LENGTH on a NULL returns NULL, so the IS NOT NULL guard is essential.
    const rows = await this._getConnection().execute({
      sqlText: `SELECT DISTINCT ${this.castToString(col)} AS V
              FROM ${this.qualifyRef(table)}
              WHERE ${col} IS NOT NULL AND LENGTH(TRIM(${this.castToString(col)})) > 0
              ORDER BY 1
              LIMIT ${n}`,
    });
    return (rows as Array<{ V: string }>).map((r) => r.V);
  }

  async topValuesByFrequency(table: Ref, column: string, limit: number): Promise<ValueCount[]> {
    const col = this.quoteIdentifier(column);
    const n = Math.max(1, Math.min(10000, Math.round(limit)));
    const rows = await this._getConnection().execute({
      sqlText: `SELECT ${this.castToString(col)} AS V, COUNT(*) AS N
              FROM ${this.qualifyRef(table)}
              WHERE ${col} IS NOT NULL AND LENGTH(TRIM(${this.castToString(col)})) > 0
              GROUP BY 1
              ORDER BY N DESC, V
              LIMIT ${n}`,
    });
    return (rows as Array<{ V: string; N: number }>).map((r) => ({
      value: r.V,
      count: Number(r.N),
    }));
  }

  async columnStats(
    table: Ref,
    column: string,
    opts: { approximate?: boolean } = {},
  ): Promise<{ rows: number; distinct: number }> {
    const col = this.quoteIdentifier(column);
    const distinctExpr = opts.approximate
      ? `APPROX_COUNT_DISTINCT(${col})`
      : `COUNT(DISTINCT ${col})`;
    const row = await this._getConnection().execute({
      sqlText: `SELECT COUNT(${col}) AS ROWS, ${distinctExpr} AS D
              FROM ${this.qualifyRef(table)}
              WHERE ${col} IS NOT NULL AND LENGTH(TRIM(${this.castToString(col)})) > 0`,
    });
    const first = (row as Array<{ ROWS: number; D: number }>)[0];
    return { rows: Number(first?.ROWS ?? 0), distinct: Number(first?.D ?? 0) };
  }

  async nameResolution(table: Ref, idCol: string, nameCol: string): Promise<Map<string, string>> {
    const id = this.quoteIdentifier(idCol);
    const nm = this.quoteIdentifier(nameCol);
    // Last-write-wins on duplicate ids (denormalized name tables are common — caller must accept any matching row).
    const rows = await this._getConnection().execute({
      sqlText: `SELECT ${this.castToString(id)} AS ID, ${this.castToString(nm)} AS NM
              FROM ${this.qualifyRef(table)}
              WHERE ${id} IS NOT NULL`,
    });
    const out = new Map<string, string>();
    for (const r of rows as Array<{ ID: string; NM: string }>) out.set(r.ID, r.NM);
    return out;
  }
  async distinctValuesWithProvenance(
    sources: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]> {
    if (sources.length === 0) return [];
    // LIVE-VALIDATION: confirm Snowflake supports UNION ALL across as many
    // branches as the typical workspace has sources (~5-20). Snowflake handles
    // hundreds of branches fine in practice; document if it ever becomes a perf concern.
    const branches = sources.map((s, i) => {
      const col = this.quoteIdentifier(s.column);
      return `SELECT ${this.castToString(col)} AS V, ${i} AS SRC_IDX, COUNT(*) AS N
            FROM ${this.qualifyRef(s.table)}
            WHERE ${col} IS NOT NULL AND LENGTH(TRIM(${this.castToString(col)})) > 0
            GROUP BY 1`;
    });
    const rows = await this._getConnection().execute({
      sqlText: branches.join("\nUNION ALL\n"),
    });
    return (rows as Array<{ V: string; SRC_IDX: number; N: number }>).map((r) => ({
      value: r.V,
      sourceIndex: Number(r.SRC_IDX),
      count: Number(r.N),
    }));
  }
  async ensureRecordTables(refTable: RefTableSpec): Promise<void> {
    // refTable.dimTable / refTable.mapTable are stored as "SCHEMA.TABLE" (2-part). The database
    // is the adapter's configured default. LIVE-VALIDATION: confirm Snowflake's
    // CREATE TABLE IF NOT EXISTS is idempotent and doesn't error if the table
    // already has a different shape (it silently no-ops; that's the Snowflake contract).
    const refTableRef = this.parseTwoPartRef(refTable.dimTable);
    const mapRef = this.parseTwoPartRef(refTable.mapTable);
    const key = this.quoteIdentifier(refTable.keyCol);

    await this._getConnection().execute({
      sqlText: `CREATE TABLE IF NOT EXISTS ${this.qualifyRef(refTableRef)} (
                ${key} VARCHAR PRIMARY KEY,
                LABEL VARCHAR
              )`,
    });

    await this._getConnection().execute({
      sqlText: `CREATE TABLE IF NOT EXISTS ${this.qualifyRef(mapRef)} (
                "RAW" VARCHAR PRIMARY KEY,
                ${key} VARCHAR NOT NULL
              )`,
    });
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

    // Deduplicate record rows by key (last write wins on label). extras.records
    // carry edits with no draft of their own (a rename).
    const canonByKey = new Map<string, string | null>();
    for (const d of drafts) canonByKey.set(d.key, d.label);
    for (const r of extras.records ?? []) canonByKey.set(r.key, r.label);
    const canonRows = [...canonByKey.entries()].map(([k, l]) => ({ key: k, label: l }));

    // Map rows: one per raw; extras (re-pointed by a record merge) win.
    const mapByRaw = new Map<string, string>();
    for (const d of drafts) mapByRaw.set(d.raw, d.key);
    for (const m of extras.mappings ?? []) mapByRaw.set(m.raw, m.key);
    const mapRows = [...mapByRaw.entries()].map(([raw, k]) => ({ raw, key: k }));

    let rowsWritten = 0;
    rowsWritten += await this.mergeChunked({
      targetRef: refTableRef,
      chunks: chunk(canonRows, 1000),
      sourceCols: [key, "LABEL"],
      onCol: key,
      pickBinds: (row) => [row.key, row.label],
    });
    rowsWritten += await this.mergeChunked({
      targetRef: mapRef,
      chunks: chunk(mapRows, 1000),
      sourceCols: [`"RAW"`, key],
      onCol: `"RAW"`,
      pickBinds: (row) => [row.raw, row.key],
    });
    // Retired (or merged-away) keys last, so a mapping this publish re-pointed
    // to the survivor above is not deleted along with the key it left.
    for (const c of chunk([...retiredKeys], 1000)) {
      const holes = c.map(() => "?").join(", ");
      await this._getConnection().executeAffected({
        sqlText: `DELETE FROM ${this.qualifyRef(mapRef)} WHERE ${key} IN (${holes})`,
        binds: [...c],
      });
      await this._getConnection().executeAffected({
        sqlText: `DELETE FROM ${this.qualifyRef(refTableRef)} WHERE ${key} IN (${holes})`,
        binds: [...c],
      });
    }
    return { rowsWritten };
  }

  /** Issue chunked MERGE INTO ... USING (VALUES (?, ?), ...) statements.
   *  Each chunk becomes one MERGE; returns sum of rowsAffected. */
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
      // LIVE-VALIDATION: confirm Snowflake's MERGE INTO + USING (VALUES (?,?), ...) AS S(a, b)
      // syntax accepts positional placeholders and the column-alias-on-source form. Snowflake
      // docs example: MERGE INTO t USING (SELECT 1 AS a UNION ALL SELECT 2) s ON t.a = s.a ...
      // We use the direct VALUES form here; an alternative shape is:
      //   USING (SELECT $1 AS a, $2 AS b FROM (VALUES (?,?), ...) AS V($1, $2)) S
      // If neither works, fall back to a temp-table approach: CREATE TEMPORARY TABLE +
      // INSERT batch + MERGE FROM temp + DROP temp.
      const sqlText = `MERGE INTO ${this.qualifyRef(opts.targetRef)} T
                       USING (VALUES ${placeholders}) AS S(${colA}, ${colB})
                       ON T.${opts.onCol} = S.${colA}
                       WHEN MATCHED THEN UPDATE SET ${colB} = S.${colB}
                       WHEN NOT MATCHED THEN INSERT (${colA}, ${colB}) VALUES (S.${colA}, S.${colB})`;
      // ^^ LIVE-VALIDATION: also confirm getNumUpdatedRows() returns the inserted row
      // count for an INSERT-only MERGE (it should — INSERT counts as "affected").
      const binds = c.flatMap((row) => opts.pickBinds(row));
      total += await this._getConnection().executeAffected({ sqlText, binds });
    }
    return total;
  }
}
