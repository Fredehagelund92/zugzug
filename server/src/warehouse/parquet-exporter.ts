import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { readFileSync, unlinkSync } from "node:fs";
import { pgAll } from "../pg.ts";
import { cq } from "../repo-shared.ts";
import type { DimensionSpec } from "./adapter.ts";

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
export async function withExporterConn<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
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

/** Export the dimension's MAP table as Parquet bytes.
 *
 *  v1 scope: map rows only (raw + keyCol). The DIM table (record records +
 *  enrichment fields) is not included; it has a divergent column shape that
 *  doesn't union cleanly with map rows. dbt's primary use case is a LEFT JOIN
 *  on the map for warehouse cleanup, which this serves directly.
 */
export async function exportRecordToParquet(dim: DimensionSpec): Promise<Buffer> {
  // 1. Read all map rows from Postgres.
  const rows = await pgAll<{ raw: string; key: string }>(
    `SELECT raw, "${dim.keyCol}" AS key FROM ${cq(dim.mapTable)} ORDER BY raw`,
  );

  // 2-5. Use the lazy in-process DuckDB; create a temp table; bulk-load via Appender;
  //      COPY to a tmp Parquet file; read into Buffer; clean up.
  const tableName = `_export_${dim.dimId}_${Date.now()}`;
  const tmpPath = `/tmp/zugzug-snapshot-${dim.dimId}-${Date.now()}.parquet`;

  return withExporterConn(async (conn) => {
    try {
      await conn.run(`CREATE OR REPLACE TABLE ${tableName} (raw VARCHAR, "${dim.keyCol}" VARCHAR)`);
      const appender = await conn.createAppender(tableName);
      for (const r of rows) {
        appender.appendVarchar(r.raw);
        appender.appendVarchar(r.key);
        appender.endRow();
      }
      appender.flushSync();
      appender.closeSync();

      await conn.run(`COPY ${tableName} TO '${tmpPath}' (FORMAT PARQUET)`);
      const buf = readFileSync(tmpPath);
      return buf;
    } finally {
      // Best-effort cleanup; failures here shouldn't mask an export error.
      try {
        unlinkSync(tmpPath);
      } catch {
        /* file may not exist if COPY failed */
      }
      try {
        await conn.run(`DROP TABLE IF EXISTS ${tableName}`);
      } catch {
        /* connection may be in a bad state if the export threw */
      }
    }
  });
}
