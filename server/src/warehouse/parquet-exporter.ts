import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

// Lazy-init in-process DuckDB instance used purely as a Parquet writer.
// Reused across calls so we don't pay the instance-startup cost per export.
// Completely independent of the workspace's configured WarehouseAdapter —
// DuckDB here is a serialization utility, not a warehouse.
let _instance: Promise<DuckDBInstance> | null = null;

async function getInstance(): Promise<DuckDBInstance> {
  if (!_instance) _instance = DuckDBInstance.create(":memory:");
  return _instance;
}

/** Acquire a DuckDB connection scoped to a single export operation.
 *  Connections are cheap; the underlying instance is shared. */
export async function withExporterConn<T>(
  fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const inst = await getInstance();
  const conn = await inst.connect();
  return fn(conn);
}

/** Test helper — drops the cached instance so the next call re-inits.
 *  Tests should NOT call this in beforeEach (instance reuse IS the point);
 *  reserved for explicit test isolation needs. */
export function _resetExporterInstance(): void {
  _instance = null;
}
