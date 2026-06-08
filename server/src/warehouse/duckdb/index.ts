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

  listTables(): Promise<CatalogTable[]> {
    throw new Error("Task 6 — not implemented");
  }
  listColumns(_table: Ref): Promise<ColumnMeta[]> {
    throw new Error("Task 6 — not implemented");
  }
  tableExists(_table: Ref): Promise<boolean> {
    throw new Error("Task 6 — not implemented");
  }
  distinctValues(_table: Ref, _column: string, _limit: number): Promise<string[]> {
    throw new Error("Task 6 — not implemented");
  }
  topValuesByFrequency(_table: Ref, _column: string, _limit: number): Promise<ValueCount[]> {
    throw new Error("Task 6 — not implemented");
  }
  columnStats(
    _table: Ref,
    _column: string,
    _opts?: { approximate?: boolean },
  ): Promise<{ rows: number; distinct: number }> {
    throw new Error("Task 6 — not implemented");
  }
  nameResolution(_table: Ref, _idCol: string, _nameCol: string): Promise<Map<string, string>> {
    throw new Error("Task 6 — not implemented");
  }
  distinctValuesWithProvenance(
    _sources: ReadonlyArray<{ table: Ref; column: string }>,
  ): Promise<ValueProvenance[]> {
    throw new Error("Task 6 — not implemented");
  }
}
