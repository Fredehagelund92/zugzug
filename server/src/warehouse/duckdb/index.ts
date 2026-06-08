import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import type {
  AdapterCapabilities,
  CatalogTable,
  ColumnMeta,
  Ref,
  ReadOnlyWarehouseAdapter,
  ValueCount,
  ValueProvenance,
} from "../adapter.ts";
import type { DuckDbCreds } from "../credentials.ts";

// The DuckDB Node API decodes LIST columns into `DuckDBListValue` wrappers
// rather than plain arrays. Normalize to a string[] regardless of shape.
function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v && typeof v === "object" && "items" in v) {
    const items = (v as { items?: unknown }).items;
    if (Array.isArray(items)) return items.map(String);
  }
  return [];
}

// Phase 1 ships DuckDB as read-only. Writable mode (commit-to-warehouse) lands
// in Phase 3. Until then the adapter exposes the read-only surface only.
export class DuckDbAdapter implements ReadOnlyWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: false };

  private readonly creds: DuckDbCreds;
  private conn: DuckDBConnection | null = null;
  private connecting: Promise<DuckDBConnection> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(creds: DuckDbCreds) {
    this.creds = creds;
    this.capabilities = {
      id: "duckdb",
      writable: false,
      supportsMerge: false,
      identifierCase: "preserve",
      supportsApproximateDistinct: false,
    };
  }

  // ---- helpers ----

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  qualifyRef(table: Ref): string {
    const parts: string[] = [];
    const catalog = table.catalog ?? this.creds.database;
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
      const row = await this.get<{ ok: number }>("SELECT 1 AS ok");
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  // ---- connection lifecycle (internal) ----

  private async connect(): Promise<DuckDBConnection> {
    if (this.conn) return this.conn;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const inst = await DuckDBInstance.create(this.creds.path ?? ":memory:");
      const c = await inst.connect();
      if (this.creds.attached && this.creds.token) {
        await c.run(`INSTALL motherduck`);
        await c.run(`LOAD motherduck`);
        process.env.motherduck_token = this.creds.token;
        await c.run(`ATTACH IF NOT EXISTS 'md:'`);
      }
      this.conn = c;
      return c;
    })();
    return this.connecting;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next as Promise<T>;
  }

  private async all<T = Record<string, unknown>>(
    sql: string,
    params: DuckDBValue[] = [],
  ): Promise<T[]> {
    return this.serialized(async () => {
      const c = await this.connect();
      const r = await c.runAndReadAll(sql, params);
      return r.getRowObjects() as T[];
    });
  }

  private async get<T = Record<string, unknown>>(
    sql: string,
    params: DuckDBValue[] = [],
  ): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  // ---- the rest of the interface is implemented in Task 6 ----

  async tableExists(table: Ref): Promise<boolean> {
    try {
      await this.all(`SELECT 1 FROM ${this.qualifyRef(table)} LIMIT 0`);
      return true;
    } catch {
      return false;
    }
  }

  async listTables(opts: { schema?: string; search?: string } = {}): Promise<CatalogTable[]> {
    if (this.creds.attached && !this.creds.database) {
      // MotherDuck attached but no database picked — caller mistake.
      return [];
    }
    // SHOW ALL TABLES is DuckDB-specific. When MotherDuck is attached, scope to
    // the configured catalog; when local, scope to anything except the system db.
    const targetDb = this.creds.attached ? this.creds.database! : null;
    const params: DuckDBValue[] = [];
    let where = `name NOT LIKE '\\_dlt%' ESCAPE '\\'`;
    if (targetDb) {
      params.push(targetDb);
      where += ` AND database = $${params.length}`;
    }
    if (opts.schema) {
      params.push(opts.schema);
      where += ` AND schema = $${params.length}`;
    }
    if (opts.search) {
      params.push(`%${opts.search}%`);
      const p = `$${params.length}`;
      where += ` AND (schema ILIKE ${p} OR name ILIKE ${p} OR len(list_filter(column_names, c -> c ILIKE ${p})) > 0)`;
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

  async nameResolution(
    table: Ref,
    idCol: string,
    nameCol: string,
  ): Promise<Map<string, string>> {
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
