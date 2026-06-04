import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { env } from "./env.ts";

let _conn: DuckDBConnection | null = null;
let _connecting: Promise<DuckDBConnection> | null = null;

async function attachMotherDuck(conn: DuckDBConnection): Promise<void> {
  await conn.run(`INSTALL motherduck`);
  await conn.run(`LOAD motherduck`);
  process.env.motherduck_token = env.motherduckToken;
  await conn.run(`ATTACH IF NOT EXISTS 'md:'`);
}

/** Returns the one live DuckDB connection (warehouse-only — no Postgres ATTACH).
 *  Call only when a warehouse query is about to run. */
export async function connect(): Promise<DuckDBConnection> {
  if (_conn) return _conn;
  if (_connecting) return _connecting;
  _connecting = (async () => {
    const inst = await DuckDBInstance.create(env.duckPath);
    const conn = await inst.connect();
    if (env.attachWarehouse) {
      await attachMotherDuck(conn);
    } else {
      console.warn(
        "⚠ warehouse (MotherDuck) attach deferred — set ATTACH_WAREHOUSE=true to enable the scan",
      );
    }
    _conn = conn;
    return conn;
  })();
  return _connecting;
}

/* ---- query helpers (positional $1 params; Unicode/quote-safe via binding) ---- */

export async function all<T = Record<string, unknown>>(
  sql: string,
  params: DuckDBValue[] = [],
): Promise<T[]> {
  const conn = await connect();
  const reader = await conn.runAndReadAll(sql, params);
  return reader.getRowObjects() as T[];
}

export async function get<T = Record<string, unknown>>(
  sql: string,
  params: DuckDBValue[] = [],
): Promise<T | null> {
  const rows = await all<T>(sql, params);
  return rows[0] ?? null;
}

export async function run(sql: string, params: DuckDBValue[] = []): Promise<void> {
  const conn = await connect();
  await conn.run(sql, params);
}

/** Run fn inside a DuckDB transaction (rolls back on throw). Note: a transaction
 *  spanning two ATTACHed remotes is not 2-phase-committed — keep the MotherDuck
 *  writes idempotent (NOT EXISTS) so a partial failure is safe to retry. */
export async function tx<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  const conn = await connect();
  await conn.run("BEGIN");
  try {
    const out = await fn(conn);
    await conn.run("COMMIT");
    return out;
  } catch (e) {
    await conn.run("ROLLBACK").catch(() => {});
    throw e;
  }
}
