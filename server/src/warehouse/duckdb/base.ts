import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import type {
  AdapterCapabilities,
  CatalogTable,
  ColumnMeta,
  DatabaseDescriptor,
  ProbeResult,
  Ref,
  ValueCount,
  ValueProvenance,
} from "../adapter.ts";
import type { DuckDbCreds } from "../credentials.ts";
import { withTimeout } from "../timeout.ts";

// The DuckDB Node API decodes LIST columns into `DuckDBListValue` wrappers
// rather than plain arrays. Normalize to a string[] regardless of shape.
export function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v && typeof v === "object" && "items" in v) {
    const items = (v as { items?: unknown }).items;
    if (Array.isArray(items)) return items.map(String);
  }
  return [];
}

/** Shared connection + helpers for both DuckDb adapter variants (read-only
 *  and writable). Owns the in-process DuckDB connection lifecycle and the
 *  serialized query queue. Subclasses implement the read methods (and, for
 *  the writable variant, the write methods). */
export abstract class DuckDbBase {
  abstract readonly capabilities: AdapterCapabilities;

  protected readonly creds: DuckDbCreds;
  protected conn: DuckDBConnection | null = null;
  protected connecting: Promise<DuckDBConnection> | null = null;
  protected queue: Promise<unknown> = Promise.resolve();

  constructor(creds: DuckDbCreds) {
    this.creds = creds;
  }

  // ---- helpers (used by both subclasses) ----

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  qualifyRef(table: Ref): string {
    const catalog = table.catalog ?? this.creds.database;
    // When no catalog is available (e.g. in-memory DuckDB without a database prop),
    // produce a 2-part schema.table ref — valid for local/in-memory connections.
    const parts: string[] = [];
    if (catalog) parts.push(this.quoteIdentifier(catalog));
    parts.push(this.quoteIdentifier(table.schema));
    parts.push(this.quoteIdentifier(table.table));
    return parts.join(".");
  }

  castToString(expr: string): string {
    return `CAST(${expr} AS VARCHAR)`;
  }

  async ping(): Promise<boolean> {
    try {
      await withTimeout(
        async () => {
          const conn = await this.connect();
          await conn.runAndReadAll(`SELECT 1`);
        },
        5_000,
        "ping",
      );
      return true;
    } catch {
      return false;
    }
  }

  async listDatabases(): Promise<DatabaseDescriptor[]> {
    return withTimeout(
      async () => {
        const conn = await this.connect();
        const result = await conn.runAndReadAll(`SHOW DATABASES`);
        const rows = result.getRows();
        return rows.map((r) => ({ databaseName: String(r[0]) }));
      },
      10_000,
      "listDatabases",
    );
  }

  async schemaCounts(): Promise<Map<string, number>> {
    return withTimeout(
      async () => {
        const conn = await this.connect();
        // duckdb_schemas() is global across attached catalogs and exposes the
        // `internal` flag so we drop information_schema / pg_catalog / etc.
        const result = await conn.runAndReadAll(
          `SELECT database_name, count(*)::BIGINT AS n
             FROM duckdb_schemas()
            WHERE NOT internal
            GROUP BY database_name`,
        );
        const out = new Map<string, number>();
        for (const r of result.getRows()) {
          out.set(String(r[0]), Number(r[1]));
        }
        return out;
      },
      10_000,
      "schemaCounts",
    );
  }

  async probeDatabase(databaseName: string): Promise<ProbeResult> {
    try {
      await withTimeout(
        async () => {
          const conn = await this.connect();
          const quoted = this.quoteIdentifier(databaseName);
          await conn.runAndReadAll(`SELECT 1 FROM ${quoted}.information_schema.schemata LIMIT 1`);
        },
        5_000,
        "probeDatabase",
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- connection lifecycle ----

  protected async connect(): Promise<DuckDBConnection> {
    if (this.conn) return this.conn;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      // When attaching MotherDuck, open the instance directly against `md:` (with the
      // token in env) so every MD database appears as a first-class catalog in
      // SHOW DATABASES — mirrors `duckdb.connect("md:?motherduck_token=...")`.
      // A `:memory:` instance with `ATTACH 'md:'` only surfaces `md_information_schema`.
      const useMd = this.creds.attached && this.creds.token;
      // Token via connection string (mirrors `duckdb.connect("md:?motherduck_token=...")`);
      // env var alone is unreliable during DuckDBInstance.create — extension load order
      // can race the env read and fall through to SSO browser auth.
      if (useMd) process.env.motherduck_token = this.creds.token;
      const path = useMd
        ? `md:?motherduck_token=${encodeURIComponent(this.creds.token!)}`
        : (this.creds.path ?? ":memory:");
      const inst = await DuckDBInstance.create(path);
      const c = await inst.connect();
      this.conn = c;
      return c;
    })();
    return this.connecting;
  }

  protected serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next as Promise<T>;
  }

  protected async all<T = Record<string, unknown>>(
    sql: string,
    params: DuckDBValue[] = [],
  ): Promise<T[]> {
    return this.serialized(async () => {
      const c = await this.connect();
      const r = await c.runAndReadAll(sql, params);
      return r.getRowObjects() as T[];
    });
  }

  protected async get<T = Record<string, unknown>>(
    sql: string,
    params: DuckDBValue[] = [],
  ): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  protected async run(sql: string, params: DuckDBValue[] = []): Promise<void> {
    return this.serialized(async () => {
      const c = await this.connect();
      await c.run(sql, params);
    });
  }

  // ---- read methods (shared between both subclasses) ----

  async tableExists(table: Ref): Promise<boolean> {
    try {
      await this.all(`SELECT 1 FROM ${this.qualifyRef(table)} LIMIT 0`);
      return true;
    } catch {
      return false;
    }
  }

  async listTables(
    opts: { schema?: string; search?: string; database?: string } = {},
  ): Promise<CatalogTable[]> {
    const targetDb = opts.database ?? this.creds.database;
    if (!targetDb) {
      throw new Error("listTables requires opts.database (no creds.database fallback)");
    }
    return withTimeout(
      async () => {
        const params: DuckDBValue[] = [];
        let where = `name NOT LIKE '\\_dlt%' ESCAPE '\\'`;
        params.push(targetDb);
        where += ` AND database = $${params.length}`;
        if (opts.schema) {
          params.push(opts.schema);
          where += ` AND schema = $${params.length}`;
        }
        if (opts.search) {
          const dot = opts.search.indexOf(".");
          if (dot >= 0) {
            // Qualified search "schema.table" — match parts against schema/name.
            params.push(`%${opts.search.slice(0, dot)}%`);
            const ps = `$${params.length}`;
            params.push(`%${opts.search.slice(dot + 1)}%`);
            const pt = `$${params.length}`;
            where += ` AND schema ILIKE ${ps} AND name ILIKE ${pt}`;
          } else {
            params.push(`%${opts.search}%`);
            const p = `$${params.length}`;
            where += ` AND (schema ILIKE ${p} OR name ILIKE ${p} OR len(list_filter(column_names, c -> c ILIKE ${p})) > 0)`;
          }
        }
        const rows = await this.all<{ schema: string; name: string; column_names: unknown }>(
          `SELECT schema, name, column_names FROM (SHOW ALL TABLES) WHERE ${where} ORDER BY schema, name LIMIT 5000`,
          params,
        );
        return rows.map((r) => ({
          schema: r.schema,
          table: r.name,
          columns: toStringList(r.column_names),
        }));
      },
      10_000,
      "listTables",
    );
  }

  async listColumns(table: Ref): Promise<ColumnMeta[]> {
    const sql = `DESCRIBE ${this.qualifyRef(table)}`;
    const rows = await this.all<{ column_name: string; column_type: string }>(sql);
    return rows.map((r) => ({ name: r.column_name, type: r.column_type }));
  }

  async distinctValues(table: Ref, column: string, limit: number): Promise<string[]> {
    const col = this.quoteIdentifier(column);
    const n = Math.max(1, Math.min(100000, Math.round(limit)));
    const rows = await this.all<{ v: string }>(
      `SELECT DISTINCT ${this.castToString(col)} AS v
         FROM ${this.qualifyRef(table)}
         WHERE ${col} IS NOT NULL AND length(trim(${this.castToString(col)})) > 0
         ORDER BY 1
         LIMIT ${n}`,
    );
    return rows.map((r) => r.v);
  }

  async topValuesByFrequency(table: Ref, column: string, limit: number): Promise<ValueCount[]> {
    const col = this.quoteIdentifier(column);
    const n = Math.max(1, Math.min(10000, Math.round(limit)));
    const rows = await this.all<{ v: string; n: bigint }>(
      `SELECT ${this.castToString(col)} AS v, count(*) AS n
         FROM ${this.qualifyRef(table)}
         WHERE ${col} IS NOT NULL AND length(trim(${this.castToString(col)})) > 0
         GROUP BY 1
         ORDER BY n DESC, v
         LIMIT ${n}`,
    );
    return rows.map((r) => ({ value: r.v, count: Number(r.n) }));
  }

  async columnStats(
    table: Ref,
    column: string,
    _opts?: { approximate?: boolean },
  ): Promise<{ rows: number; distinct: number }> {
    const col = this.quoteIdentifier(column);
    const row = await this.get<{ rows: bigint; d: bigint }>(
      `SELECT count(${col}) AS rows, count(DISTINCT ${col}) AS d
         FROM ${this.qualifyRef(table)}
         WHERE ${col} IS NOT NULL AND length(trim(${this.castToString(col)})) > 0`,
    );
    return { rows: Number(row?.rows ?? 0), distinct: Number(row?.d ?? 0) };
  }

  async nameResolution(table: Ref, idCol: string, nameCol: string): Promise<Map<string, string>> {
    const id = this.quoteIdentifier(idCol);
    const nm = this.quoteIdentifier(nameCol);
    // Last-write-wins on duplicate ids (denormalized name tables are common — caller must accept any matching row).
    const rows = await this.all<{ id: string; nm: string }>(
      `SELECT ${this.castToString(id)} AS id, ${this.castToString(nm)} AS nm
         FROM ${this.qualifyRef(table)}
         WHERE ${id} IS NOT NULL`,
    );
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.id, r.nm);
    return out;
  }

  async distinctValuesWithProvenance(
    sources: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]> {
    if (sources.length === 0) return [];
    const branches = sources.map((s, i) => {
      const col = this.quoteIdentifier(s.column);
      return `SELECT ${this.castToString(col)} AS v, ${i} AS src_idx, count(*) AS n
                FROM ${this.qualifyRef(s.table)}
                WHERE ${col} IS NOT NULL AND length(trim(${this.castToString(col)})) > 0
                GROUP BY 1`;
    });
    const sql = branches.join("\nUNION ALL\n");
    const rows = await this.all<{ v: string; src_idx: number; n: bigint }>(sql);
    return rows.map((r) => ({
      value: r.v,
      sourceIndex: Number(r.src_idx),
      count: Number(r.n),
    }));
  }
}
